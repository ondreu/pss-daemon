/**
 * A fault-injecting skin over the in-memory `FakeDrive`.
 *
 * The real `SyncEngine` is driven against this instead of the network: every
 * method of the `ProtonDriveClient` surface the engine touches (through
 * `DriveIO`) is delegated to the fake, but first recorded in a full call log
 * and passed through a scriptable fault program. The faults model what the
 * test plan's failure catalogue needs without a Proton account:
 *
 * - partial listings that omit a node, then reveal it on a later pass (#B),
 * - 429s with SDK-shaped `RateLimitedError`s and 5xx windows as `ServerError`
 *   with a `statusCode`, plus connection drops and 401s,
 * - throttled transfers paced by a virtual clock (no wall-clock sleeps: the
 *   clock advances by bytes moved, so assertions never wait on time),
 * - an upload abort mid-stream and hold gates that pause an upload between
 *   "bytes read" and "revision commits" (or a download before bytes land),
 *   which is where a simulated SIGKILL drops the engine.
 *
 * What this cannot prove is stated plainly where it matters: the SDK's own
 * retry of 429/5xx (with `Retry-After`) and the session refresh on 401 live
 * below this seam, in `HTTPClient`/`ApiClient` and the real `ProtonSession`.
 * Here a 401 is what the engine sees after the SDK gave up: an item failure
 * that must retry, never a delete. The full refresh-then-revoke path (#16)
 * needs a real account and is marked E2E, not faked.
 */
import {
    ConnectionError,
    RateLimitedError,
    ServerError,
    type ProtonDriveClient,
} from '@protontech/drive-sdk';

import { FakeDrive } from '../../engine/tests/support/fakes';
import { requestStats } from '../../engine/src/util/requestStats';

/** One observed call into the fake client. `failed` names the error when a fault fired. */
export type CallRecord = {
    seq: number;
    /** Virtual-clock ms when the call arrived. */
    t: number;
    method: string;
    detail: string;
    failed?: string;
};

/** A clock the test advances; transfers and fault windows read this, never the wall clock. */
export class ManualClock {
    private t = 1_000_000;
    now(): number {
        return this.t;
    }
    advance(ms: number): void {
        this.t += ms;
    }
}

/** A manually released gate: `untilReleased` parks a transfer where a kill would land. */
export function deferred(): { untilReleased: Promise<void>; release: () => void } {
    let release!: () => void;
    const untilReleased = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { untilReleased, release };
}

/** SDK-shaped errors, the same classes the real client raises after its own retries. */
export function rateLimitedError(): RateLimitedError {
    return new RateLimitedError('Too many requests (fault injection)');
}

export function serverError(statusCode: number, message: string): ServerError {
    const error = new ServerError(message);
    (error as { statusCode?: number }).statusCode = statusCode;
    return error;
}

export function connectionError(): ConnectionError {
    return new ConnectionError('Network down (fault injection)');
}

export function unauthorizedError(): ServerError {
    return serverError(401, 'Unauthorized (fault injection)');
}

export function abortedUploadError(): Error {
    return new Error('Upload aborted mid-stream (fault injection)');
}

type ErrorFactory = () => Error;

type WrappedClient = Record<string, (...args: never[]) => any>;

/**
 * The fault program and telemetry around one `FakeDrive`. Owns no threads and
 * holds no timers: everything is driven by the test calling the engine.
 */
export class FaultDrive {
    readonly inner = new FakeDrive();
    readonly clock = new ManualClock();
    readonly calls: CallRecord[] = [];

    /** Child uids hidden from their parent's listing, with remaining listing calls each. */
    private readonly listingOmits = new Map<string, Map<string, number>>();
    /** One-shot scripted failures: the next N calls of a method throw. */
    private readonly scripted = new Map<string, { remaining: number; make: ErrorFactory }[]>();
    /** Recurring failures: every Nth call of a method throws. */
    private readonly periodic = new Map<string, { n: number; seen: number; make: ErrorFactory }>();
    /** Total blackout: every call of these methods throws until cleared. */
    private readonly blackout = new Map<string, ErrorFactory>();

    /** Throughput cap for uploads and downloads; exceeded bytes advance the virtual clock. */
    throttleBytesPerSec = Number.POSITIVE_INFINITY;
    /** Throw this many bytes into a single upload stream, once, then disarm. */
    abortUploadAfterBytes: number | null = null;
    /** Park an upload after its bytes are read but before the revision commits. */
    holdUploadCommit: (() => Promise<void>) | null = null;
    /** Park a download after its first chunk, before bytes reach the vault. */
    holdDownloadStart: (() => Promise<void>) | null = null;
    /** Observed per transfer chunk: `{ direction: 'up' | 'down', bytes }` cumulative in the stream. */
    onTransferChunk: ((info: { direction: 'up' | 'down'; bytes: number }) => void) | null = null;

    bytesUploaded = 0;
    bytesDownloaded = 0;
    completedUploads = 0;
    completedDownloads = 0;
    /** Bytes read from a source but not yet committed/written; the kill window. */
    inFlightBytes = 0;
    peakInFlightBytes = 0;

    /** Fail the next `count` calls of `method` with errors from `make`. */
    failNext(method: string, count: number, make: ErrorFactory): void {
        const queue = this.scripted.get(method) ?? [];
        queue.push({ remaining: count, make });
        this.scripted.set(method, queue);
    }

    /** Fail every `n`th call of `method` (1-based) with errors from `make`. */
    failEvery(method: string, n: number, make: ErrorFactory): void {
        this.periodic.set(method, { n, seen: 0, make });
    }

    /** Fail every call of `method` until `clearBlackout` (or `clearFaults`). */
    blackoutMethod(method: string, make: ErrorFactory): void {
        this.blackout.set(method, make);
    }

    clearBlackout(method: string): void {
        this.blackout.delete(method);
    }

    /** Hide `childUid` from `parentUid`'s listings for the next `listings` listing calls. */
    omitFromListing(parentUid: string, childUid: string, listings = 1): void {
        let children = this.listingOmits.get(parentUid);
        if (!children) {
            children = new Map();
            this.listingOmits.set(parentUid, children);
        }
        children.set(childUid, (children.get(childUid) ?? 0) + listings);
    }

    /** Drop every programmed fault, keeping the call log and counters. */
    clearFaults(): void {
        this.scripted.clear();
        this.periodic.clear();
        this.blackout.clear();
        this.listingOmits.clear();
        this.abortUploadAfterBytes = null;
        this.holdUploadCommit = null;
        this.holdDownloadStart = null;
    }

    clearLog(): void {
        this.calls.length = 0;
    }

    /** Mirror a 429 into the shared request stats, so `TransferPace` reacts as in production. */
    recordRateLimited(): void {
        requestStats.record(429);
    }

    callsOf(method: string): CallRecord[] {
        return this.calls.filter((call) => call.method === method);
    }

    countOf(method: string): number {
        return this.callsOf(method).length;
    }

    failedCallsOf(method: string): CallRecord[] {
        return this.callsOf(method).filter((call) => call.failed !== undefined);
    }

    /** Delete-shaped calls: what must stay at zero while reads are failing. */
    deleteCalls(): CallRecord[] {
        return this.calls.filter(
            (call) => call.method === 'trashNodes' || call.method === 'restoreNodes',
        );
    }

    /** The wrapped client the engine runs against. */
    client(): ProtonDriveClient {
        // The base client's methods close over the fake; destructuring keeps
        // them bound, so plain delegation is faithful.
        const base = this.inner.client() as unknown as WrappedClient;
        const self = this;

        const note = (method: string, detail: string): CallRecord => {
            const record: CallRecord = { seq: self.calls.length, t: self.clock.now(), method, detail };
            self.calls.push(record);
            return record;
        };

        const nextFailure = (method: string): Error | null => {
            const blocked = self.blackout.get(method);
            if (blocked) {
                return blocked();
            }
            const every = self.periodic.get(method);
            if (every) {
                every.seen += 1;
                if (every.seen % every.n === 0) {
                    return every.make();
                }
            }
            const queue = self.scripted.get(method);
            const head = queue?.[0];
            if (head && head.remaining > 0) {
                head.remaining -= 1;
                if (head.remaining === 0) {
                    queue!.shift();
                }
                return head.make();
            }
            return null;
        };

        const short = (value: unknown): string => {
            if (typeof value === 'string') {
                return value.length > 60 ? `${value.slice(0, 57)}...` : value;
            }
            if (typeof value === 'number' || typeof value === 'boolean') {
                return String(value);
            }
            if (Array.isArray(value)) {
                return `[${value.length} items]`;
            }
            return typeof value;
        };

        const wrap = (method: string, invoke: (...args: never[]) => unknown) => {
            return (...args: never[]): unknown => {
                const record = note(method, args.map(short).join(', '));
                const failure = nextFailure(method);
                if (failure) {
                    record.failed = failure.name;
                    throw failure;
                }
                return invoke(...args);
            };
        };

        // Async generators must throw asynchronously, as the SDK does: return
        // a generator that fails on first pull rather than throwing at call time.
        const wrapGen = <T>(method: string, invoke: (...args: never[]) => AsyncGenerator<T, void, void>) => {
            return (...args: never[]): AsyncGenerator<T, void, void> => {
                const record = note(method, args.map(short).join(', '));
                const failure = nextFailure(method);
                const hidden = self.takeListingOmits(method, args);
                async function* gen(): AsyncGenerator<T, void, void> {
                    if (failure) {
                        record.failed = failure.name;
                        throw failure;
                    }
                    yield* invoke(...args);
                }
                // Listing omits filter here, where the parent uid is known.
                if (method === 'iterateFolderChildrenNodeUids' && hidden !== null) {
                    const inner = gen();
                    const omit: Set<string> = hidden;
                    async function* filtered(): AsyncGenerator<T, void, void> {
                        for await (const uid of inner as unknown as AsyncGenerator<string, void, void>) {
                            if (!omit.has(uid)) {
                                yield uid as unknown as T;
                            }
                        }
                    }
                    return filtered();
                }
                return gen();
            };
        };

        return {
            getMyFilesRootFolder: wrap('getMyFilesRootFolder', () => base['getMyFilesRootFolder']()),
            getNode: wrap('getNode', (uid: never) => base['getNode'](uid)),
            iterateNodes: wrapGen('iterateNodes', (uids: never) => base['iterateNodes'](uids)),
            getNodeHierarchy: wrap('getNodeHierarchy', (uid: never) => base['getNodeHierarchy'](uid)),
            iterateFolderChildrenNodeUids: wrapGen(
                'iterateFolderChildrenNodeUids',
                (uid: never, filter: never) => base['iterateFolderChildrenNodeUids'](uid, filter),
            ),
            createFolder: wrap('createFolder', (parent: never, name: never) => base['createFolder'](parent, name)),
            getFileUploader: wrap('getFileUploader', (parent: never, name: never, metadata: never) =>
                self.wrapUploader(() => base['getFileUploader'](parent, name, metadata)),
            ),
            getFileRevisionUploader: wrap('getFileRevisionUploader', (nodeUid: never, metadata: never) =>
                self.wrapUploader(() => base['getFileRevisionUploader'](nodeUid, metadata)),
            ),
            getFileDownloader: wrap('getFileDownloader', (uid: never, signal: never) =>
                self.wrapDownloader(() => base['getFileDownloader'](uid, signal)),
            ),
            getFileRevisionDownloader: wrap('getFileRevisionDownloader', (revisionUid: never, signal: never) =>
                self.wrapDownloader(() => base['getFileRevisionDownloader'](revisionUid, signal)),
            ),
            iterateRevisions: wrapGen('iterateRevisions', (uid: never) => base['iterateRevisions'](uid)),
            iterateTrashedNodeUids: wrapGen('iterateTrashedNodeUids', () => base['iterateTrashedNodeUids']()),
            restoreNodes: wrapGen('restoreNodes', (uids: never) => base['restoreNodes'](uids)),
            getSharingInfo: wrap('getSharingInfo', (uid: never) => base['getSharingInfo'](uid)),
            shareNode: wrap('shareNode', (uid: never, settings: never) => base['shareNode'](uid, settings)),
            unshareNode: wrap('unshareNode', (uid: never, settings: never) => base['unshareNode'](uid, settings)),
            trashNodes: wrapGen('trashNodes', (uids: never) => base['trashNodes'](uids)),
            renameNode: wrap('renameNode', (uid: never, name: never) => base['renameNode'](uid, name)),
            moveNodes: wrapGen('moveNodes', (uids: never, parent: never) => base['moveNodes'](uids, parent)),
            iterateEvents: wrapGen('iterateEvents', (scope: never, cursor: never, signal: never) =>
                base['iterateEvents'](scope, cursor, signal),
            ),
        } as unknown as ProtonDriveClient;
    }

    private takeListingOmits(method: string, args: never[]): Set<string> | null {
        if (method !== 'iterateFolderChildrenNodeUids') {
            return null;
        }
        const parentUid = args[0] as unknown as string;
        const hidden = this.listingOmits.get(parentUid);
        if (!hidden || hidden.size === 0) {
            return null;
        }
        const snapshot = new Set<string>();
        for (const [uid, remaining] of hidden) {
            if (remaining > 0) {
                snapshot.add(uid);
                hidden.set(uid, remaining - 1);
            }
        }
        return snapshot.size > 0 ? snapshot : null;
    }

    private async pace(direction: 'up' | 'down', bytes: number): Promise<void> {
        // Slice work into chunks so a racing mutation can land mid-transfer
        // and the kill window (bytes read, not yet committed) is observable.
        const chunkSize = 64 * 1024;
        let offset = 0;
        while (offset < bytes) {
            const slice = Math.min(chunkSize, bytes - offset);
            this.inFlightBytes += slice;
            this.peakInFlightBytes = Math.max(this.peakInFlightBytes, this.inFlightBytes);
            this.clock.advance(this.throttleBytesPerSec === Number.POSITIVE_INFINITY ? 0 : (slice / this.throttleBytesPerSec) * 1000);
            this.onTransferChunk?.({ direction, bytes: offset + slice });
            // A microtask yield per chunk: no wall-clock wait, but the test's
            // interleaved mutation (via a hook above) runs before the commit.
            await Promise.resolve();
            this.inFlightBytes -= slice;
            offset += slice;
        }
    }

    private async consumeUpload(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
        const chunks: Uint8Array[] = [];
        const reader = stream.getReader();
        try {
            for (;;) {
                const read = await reader.read();
                if (read.done) {
                    break;
                }
                chunks.push(read.value);
            }
        } finally {
            reader.releaseLock();
        }
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.byteLength;
        }
        // Replay through the pacer so throttling, aborts and the commit hold
        // see the same bytes the SDK would have carried.
        let paced = 0;
        const limit = this.abortUploadAfterBytes;
        const chunkSize = 64 * 1024;
        while (paced < data.byteLength) {
            const slice = Math.min(chunkSize, data.byteLength - paced);
            await this.pace('up', slice);
            paced += slice;
            this.onTransferChunk?.({ direction: 'up', bytes: paced });
            if (limit !== null && paced >= limit) {
                this.abortUploadAfterBytes = null;
                throw abortedUploadError();
            }
        }
        return data;
    }

    private wrapUploader(open: () => Promise<{ uploadFromStream: unknown }>): Promise<unknown> {
        const self = this;
        return (async () => {
            const uploader = (await open()) as {
                uploadFromStream: (
                    stream: ReadableStream<Uint8Array>,
                    thumbnails: unknown,
                    onProgress?: (bytes: number) => void,
                ) => Promise<{ completion: () => Promise<{ nodeUid: string; nodeRevisionUid: string }> }>;
            };
            return {
                uploadFromStream: async (
                    stream: ReadableStream<Uint8Array>,
                    thumbnails: unknown,
                    onProgress?: (bytes: number) => void,
                ) => {
                    const record: CallRecord = {
                        seq: self.calls.length,
                        t: self.clock.now(),
                        method: 'uploadFromStream',
                        detail: '',
                    };
                    self.calls.push(record);
                    try {
                        const data = await self.consumeUpload(stream);
                        if (self.holdUploadCommit) {
                            await self.holdUploadCommit();
                        }
                        const replay = new ReadableStream<Uint8Array>({
                            start(controller) {
                                controller.enqueue(data);
                                controller.close();
                            },
                        });
                        const result = await uploader.uploadFromStream(replay, thumbnails, onProgress);
                        const completion = await result.completion();
                        self.completedUploads += 1;
                        self.bytesUploaded += data.byteLength;
                        record.detail = `${data.byteLength} bytes`;
                        return { completion: async () => completion };
                    } catch (error) {
                        record.failed = error instanceof Error ? error.name : String(error);
                        throw error;
                    }
                },
            };
        })();
    }

    private wrapDownloader(open: () => Promise<{ downloadToStream: unknown }>): Promise<unknown> {
        const self = this;
        return (async () => {
            const downloader = (await open()) as {
                downloadToStream: (
                    sink: WritableStream<Uint8Array>,
                    onProgress?: (bytes: number) => void,
                ) => { completion: () => Promise<void>; isDownloadCompleteWithSignatureIssues: () => boolean };
            };
            return {
                downloadToStream: (sink: WritableStream<Uint8Array>, onProgress?: (bytes: number) => void) => {
                    const record: CallRecord = {
                        seq: self.calls.length,
                        t: self.clock.now(),
                        method: 'downloadToStream',
                        detail: '',
                    };
                    self.calls.push(record);
                    let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
                    let received = 0;
                    let held = false;
                    let failed: unknown = null;
                    const metered = new WritableStream<Uint8Array>({
                        async write(chunk) {
                            received += chunk.byteLength;
                            await self.pace('down', chunk.byteLength);
                            self.onTransferChunk?.({ direction: 'down', bytes: received });
                            if (!held && self.holdDownloadStart) {
                                held = true;
                                await self.holdDownloadStart();
                            }
                            writer ??= sink.getWriter();
                            await writer.write(chunk);
                        },
                        async close() {
                            try {
                                await writer?.close();
                            } finally {
                                writer?.releaseLock();
                                writer = null;
                            }
                        },
                        async abort(reason) {
                            try {
                                await writer?.abort(reason);
                            } finally {
                                writer?.releaseLock();
                                writer = null;
                            }
                        },
                    });
                    let inner: { completion: () => Promise<void>; isDownloadCompleteWithSignatureIssues: () => boolean };
                    try {
                        inner = downloader.downloadToStream(metered, onProgress);
                    } catch (error) {
                        record.failed = error instanceof Error ? error.name : String(error);
                        throw error;
                    }
                    return {
                        completion: async () => {
                            try {
                                await inner.completion();
                                self.completedDownloads += 1;
                                self.bytesDownloaded += received;
                                record.detail = `${received} bytes`;
                            } catch (error) {
                                failed = error;
                                record.failed = error instanceof Error ? error.name : String(error);
                                throw error;
                            } finally {
                                void failed;
                            }
                        },
                        isDownloadCompleteWithSignatureIssues: () => inner.isDownloadCompleteWithSignatureIssues(),
                    };
                },
            };
        })();
    }
}
