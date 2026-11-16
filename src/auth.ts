import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { DataAdapter } from 'obsidian';

import { NodeType, NodeWithSameNameExistsValidationError } from '@protontech/drive-sdk';

import { Credentials } from '../../src/proton/credentials';
import { ProtonSession } from '../../src/proton/session';
import { DriveIO } from '../../src/sync/drive';
import { isSafeName } from '../../src/sync/paths';
import type { Logger } from '../../src/util/logger';
import { FileCacheStore } from './fileCacheStore';
import { FileSlot } from './fileSlot';
import type { CreateProtonAuth, ProtonAuth } from './ports';

/** Session envelope in the data dir; see the daemon design doc, section 3. */
export const SESSION_FILE_NAME = 'session.bin';

/** Encrypted Drive metadata cache in the data dir. */
export const CACHE_FILE_NAME = 'drive-cache.bin';

/** File a 0.1.0 install may have left behind; headless never writes one. */
const LEGACY_SESSION_FILE_NAME = 'session.json';

/**
 * What a bare spec is read as a uid by. Node uids are long base64url; a
 * short name is a folder directly below /my-files. A folder that happens to
 * be named like a uid misroutes to a uid lookup, which then fails closed —
 * see {@link HeadlessProtonAuth.resolveFolder}.
 */
const UID_SHAPE = /^[A-Za-z0-9_\-=~]{16,}$/;

export type ResolveFolderOptions = {
    /**
     * Create missing folders along the path. Off by default: resolving must
     * never invent a uid — a missing folder is an error, not an empty one.
     */
    create?: boolean;
};

export type HeadlessProtonAuthDeps = {
    session: ProtonSession;
    cacheStore: FileCacheStore | null;
    logger: Logger;
    /**
     * Wires {@link HeadlessProtonAuth.setCacheMarker} to the marker closure
     * the session was built with. Absent when the session is a test fake
     * that has no marker closure.
     */
    setMarkerSource?: (source: () => string) => void;
};

/**
 * Everything that touches Proton, behind the {@link ProtonAuth} seam.
 *
 * The session and the cache key live in a {@link FileSlot} encrypted with
 * the key from `PSS_KEY_FILE`; there is no PIN headless (nothing could type
 * it), and the slot is passed to `Credentials` directly instead of being
 * wrapped the way the plugin wraps it. Extra methods beyond the port —
 * `resolveFolder` creation, `onSessionEnded`, `setCacheMarker` — are how the
 * daemon core uses what the frozen port does not name.
 */
export class HeadlessProtonAuth implements ProtonAuth {
    readonly session: ProtonSession;
    readonly cacheStore: FileCacheStore | null;
    private readonly logger: Logger;
    private readonly setMarkerSource?: (source: () => string) => void;

    constructor(deps: HeadlessProtonAuthDeps) {
        this.session = deps.session;
        this.cacheStore = deps.cacheStore;
        this.logger = deps.logger;
        this.setMarkerSource = deps.setMarkerSource;
    }

    /**
     * The unattended path: load the stored session and build the client.
     *
     * Returns false when nothing usable is stored — no file, an unreadable
     * one (logged, left alone), or a stored session that no longer parses.
     * A stored session whose token has since died still builds a client here:
     * only Proton can say the token is dead, on the first request that
     * carries it, and an offline boot must not read as signed out. That
     * verdict arrives through the session-ended handler instead, exactly as
     * the plugin learns it. Makes no network call when nothing is stored.
     */
    async restore(): Promise<boolean> {
        try {
            await this.session.init();
        } catch (error) {
            this.logger.warn('Could not restore the Proton session; starting signed out', error);
            return false;
        }
        return this.session.isSignedIn();
    }

    /**
     * The interactive path: the device/web flow. Hands the approval URL to
     * `onUrl` before waiting, so the caller can print it while the user
     * approves in a browser. Already signed in means there is no URL to
     * hand over, and this returns at once.
     */
    async login(onUrl: (url: string) => void, signal?: AbortSignal): Promise<void> {
        await this.session.init();
        if (this.session.isSignedIn()) {
            return;
        }
        const handle = await this.session.beginWebSignIn(signal);
        onUrl(handle.url);
        await handle.completion;
        if (!this.session.isSignedIn()) {
            // Approved, but the client could not be built before the network
            // dropped: the session is saved, so read it back and finish now
            // rather than leaving the login half done.
            await this.session.init();
        }
        if (!this.session.isSignedIn()) {
            throw new Error('Signed in, but the Drive client could not be built; try logging in again');
        }
    }

    /**
     * Resolve a Drive folder from a uid or a `/`-separated path below
     * `/my-files`. A single segment shaped like a node uid is read as a uid
     * and verified to be a live folder; anything with a `/` is a path, with
     * leading and trailing slashes ignored. `.` and `..` are refused — a
     * spec must stay below `/my-files` however it is written.
     *
     * Missing folders are created only with `{ create: true }`, one level at
     * a time through the folder just resolved; otherwise a missing folder is
     * an error. A uid is never invented: what comes back was read from Drive.
     */
    async resolveFolder(spec: string, options: ResolveFolderOptions = {}): Promise<{ uid: string; path: string }> {
        const client = this.session.getClient();
        const drive = new DriveIO(client, this.logger);
        const root = await client.getMyFilesRootFolder();
        const trimmed = spec.replace(/^\/+|\/+$/g, '');
        if (trimmed === '') {
            return { uid: root.uid, path: '' };
        }
        const segments = trimmed.split('/');
        if (segments.length === 1 && UID_SHAPE.test(segments[0])) {
            return this.resolveUid(drive, root.uid, segments[0]);
        }
        for (const segment of segments) {
            if (segment === '' || segment === '.' || segment === '..') {
                throw new Error(`Refusing to resolve ${JSON.stringify(spec)}: paths stay below /my-files`);
            }
        }
        let currentUid = root.uid;
        for (const segment of segments) {
            const found = await this.findChildFolder(drive, currentUid, segment);
            if (found !== null) {
                currentUid = found;
                continue;
            }
            if (options.create !== true) {
                throw new Error(
                    `Drive folder ${JSON.stringify(segments.join('/'))} does not exist below /my-files`,
                );
            }
            if (!isSafeName(segment)) {
                throw new Error(`Refusing to create ${JSON.stringify(segment)}: not a name the vault can sync`);
            }
            currentUid = await this.createChildFolder(drive, currentUid, segment);
        }
        return { uid: currentUid, path: segments.join('/') };
    }

    /**
     * End the session with Proton, then forget it here. Revoked first, while
     * the tokens to ask with are still at hand; the local copy is deleted
     * whatever Proton answers, so an offline daemon still signs out.
     */
    async signOut(): Promise<void> {
        await this.session.signOut();
    }

    /**
     * Tell the caller when Proton ends the session mid-run (the refresh token
     * is dead). The daemon stops the engine with it and exits 4 — retrying
     * with a client that can no longer authenticate is the loop this exists
     * to prevent.
     */
    onSessionEnded(handler: (() => void) | null): void {
        this.session.setSessionEndedHandler(handler);
    }

    /**
     * Point the saved cache's event marker at the sync state's cursor source.
     * For stream C: call once the state exists, mirroring how the plugin
     * passes `cursorsFingerprint` at construction.
     */
    setCacheMarker(source: () => string): void {
        this.setMarkerSource?.(source);
    }

    /** A uid verified to be a live folder below the sync root. */
    private async resolveUid(
        drive: DriveIO,
        rootUid: string,
        uid: string,
    ): Promise<{ uid: string; path: string }> {
        const location = await drive.locate(uid, rootUid);
        if (location.kind === 'at') {
            if (location.node.type !== NodeType.Folder) {
                throw new Error('The resolved node is not a folder');
            }
            return { uid, path: location.path };
        }
        if (location.kind === 'outside') {
            throw new Error('The folder is not below /my-files');
        }
        if (location.kind === 'unknown') {
            throw new Error('The folder’s name could not be decrypted');
        }
        throw new Error('The folder does not exist or is trashed');
    }

    private async findChildFolder(drive: DriveIO, parentUid: string, name: string): Promise<string | null> {
        for await (const { node, name: childName } of drive.iterateChildren(parentUid)) {
            if (childName === name && node.type === NodeType.Folder) {
                return node.uid;
            }
        }
        return null;
    }

    /** Create one folder, adopting a racing create rather than failing on it. */
    private async createChildFolder(drive: DriveIO, parentUid: string, name: string): Promise<string> {
        try {
            return await drive.createFolder(parentUid, name);
        } catch (error) {
            if (error instanceof NodeWithSameNameExistsValidationError && error.existingNodeUid !== undefined) {
                return error.existingNodeUid;
            }
            const raced = await this.findChildFolder(drive, parentUid, name);
            if (raced !== null) {
                return raced;
            }
            throw error;
        }
    }
}

export const createProtonAuth: CreateProtonAuth = async (options) => {
    if (!isAbsolute(options.dataDir)) {
        throw new Error(`The daemon data dir must be an absolute path, got ${JSON.stringify(options.dataDir)}`);
    }
    if (options.key.byteLength !== 32) {
        throw new Error(
            `The session key must be 32 bytes (PSS_KEY_FILE), got ${options.key.byteLength}. ` +
                'Nothing was read or written.',
        );
    }
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    const logger = options.logger.getLogger('auth');
    const slot = new FileSlot(join(options.dataDir, SESSION_FILE_NAME), options.key);
    // `memory` keeps the encrypted node cache in the process only: the
    // session falls back to an in-memory cache when no store is supplied
    // (IndexedDB, the plugin's store, does not exist server-side), so no
    // cache file is ever written. `file` persists it like the plugin does.
    const cacheStore = options.metadataCache === 'memory' ? null : new FileCacheStore(join(options.dataDir, CACHE_FILE_NAME), logger);
    const credentials = new Credentials(
        slot,
        {
            // Headless has no 0.1.0 file to migrate: nothing stored, nothing removed.
            adapter: { exists: async () => false } as unknown as DataAdapter,
            path: join(options.dataDir, LEGACY_SESSION_FILE_NAME),
            decrypt: () => null,
        },
        logger,
    );
    let markerSource: () => string = () => '';
    const session = new ProtonSession(credentials, options.clientUid, logger, () => markerSource(), {
        cacheStore,
        // No CORS server-side: plain fetch, not Obsidian's requestUrl.
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
    });
    return new HeadlessProtonAuth({
        session,
        cacheStore,
        logger,
        setMarkerSource: (source) => {
            markerSource = source;
        },
    });
};
