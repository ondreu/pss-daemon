import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

import { NodeType, type ProtonDriveClient } from '@protontech/drive-sdk';

import type { ProtonSession } from '../../src/proton/session';
import { Logger } from '../../src/util/logger';

const SILENT = new Logger('error');
const dir = () => mkdtemp(join(tmpdir(), 'pss-auth-'));
const uid = (name: string) => `${name}-${'x'.repeat(24)}`;

let authModule: typeof import('../src/auth');

before(async () => {
    // The plugin build defines this through esbuild; like the engine suite's
    // security tests, set it before the session module loads.
    (globalThis as { __PLUGIN_VERSION__?: string }).__PLUGIN_VERSION__ = '0.0.0-test';
    authModule = await import('../src/auth');
});

/** A session the tests drive by hand; no network behind any method. */
function fakeSession() {
    const state = {
        initCalls: 0,
        signedIn: false,
        beginCalls: 0,
        signedOut: false,
        endedHandler: null as ((() => void) | null),
        url: 'https://account.proton.me/approve#test',
        client: null as unknown,
    };
    const session = {
        async init(): Promise<void> {
            state.initCalls++;
        },
        isSignedIn(): boolean {
            return state.signedIn;
        },
        async beginWebSignIn(): Promise<{ url: string; completion: Promise<string> }> {
            state.beginCalls++;
            return {
                url: state.url,
                completion: (async () => {
                    state.signedIn = true;
                    return 'user@example.com';
                })(),
            };
        },
        getClient(): ProtonDriveClient {
            if (!state.signedIn || state.client === null) {
                throw new Error('Not signed in to Proton Drive');
            }
            return state.client as ProtonDriveClient;
        },
        async signOut(): Promise<{ revoked: boolean }> {
            state.signedIn = false;
            state.signedOut = true;
            return { revoked: true };
        },
        setSessionEndedHandler(handler: (() => void) | null): void {
            state.endedHandler = handler;
        },
        setNodeSource(): void {},
    };
    return { session: session as unknown as ProtonSession, state };
}

const authWith = (
    session: ProtonSession,
    extra: { setMarkerSource?: (source: () => string) => void } = {},
) => new authModule.HeadlessProtonAuth({ session, cacheStore: null, logger: SILENT, ...extra });

type FakeNode = {
    uid: string;
    name: string;
    type: NodeType;
    parentUid: string | null;
    trashed?: boolean;
    undecryptable?: boolean;
};

class FakeDrive {
    private readonly nodes = new Map<string, FakeNode>();
    readonly created: { parentUid: string; name: string }[] = [];

    constructor(readonly rootUid: string) {
        this.nodes.set(rootUid, { uid: rootUid, name: 'My files', type: NodeType.Folder, parentUid: null });
    }

    add(node: FakeNode): void {
        this.nodes.set(node.uid, node);
    }

    private toEntity(n: FakeNode) {
        return {
            uid: n.uid,
            type: n.type,
            name: n.undecryptable
                ? { ok: false as const, error: new Error('no key') }
                : { ok: true as const, value: n.name },
            ...(n.trashed === true ? { trashTime: new Date() } : {}),
        };
    }

    async getMyFilesRootFolder() {
        return this.toEntity(this.nodes.get(this.rootUid)!);
    }

    async *iterateFolderChildrenNodeUids(parentUid: string): AsyncGenerator<string> {
        for (const node of this.nodes.values()) {
            if (node.parentUid === parentUid) {
                yield node.uid;
            }
        }
    }

    async *iterateNodes(uids: string[]): AsyncGenerator<unknown> {
        for (const u of uids) {
            const node = this.nodes.get(u);
            yield node ? this.toEntity(node) : { missingUid: u };
        }
    }

    async getNodeHierarchy(nodeUid: string) {
        const chain: FakeNode[] = [];
        let current = this.nodes.get(nodeUid);
        while (current) {
            chain.unshift(current);
            current = current.parentUid !== null ? this.nodes.get(current.parentUid) : undefined;
        }
        return chain.map((n) => this.toEntity(n));
    }

    async createFolder(parentUid: string, name: string) {
        const createdUid = `created-${'x'.repeat(20)}-${this.created.length}-${name}`;
        this.created.push({ parentUid, name });
        this.add({ uid: createdUid, name, type: NodeType.Folder, parentUid });
        return this.toEntity(this.nodes.get(createdUid)!);
    }
}

function driveWithSession(backupsUid: string, vaultUid: string) {
    const { session, state } = fakeSession();
    const drive = new FakeDrive(uid('root'));
    drive.add({ uid: backupsUid, name: 'Backups', type: NodeType.Folder, parentUid: drive.rootUid });
    drive.add({ uid: vaultUid, name: 'vault', type: NodeType.Folder, parentUid: backupsUid });
    state.signedIn = true;
    state.client = drive;
    return { auth: authWith(session), session, state, drive };
}

describe('createProtonAuth', () => {
    it('restore with no stored session returns false and makes no network call', async () => {
        const dataDir = await dir();
        const auth = await authModule.createProtonAuth({
            dataDir,
            key: randomBytes(32),
            clientUid: 'test-client',
            logger: SILENT,
            fetchImpl: (async () => {
                throw new Error('network call in restore');
            }) as typeof fetch,
        });
        assert.equal(await auth.restore(), false);
    });

    it('refuses a relative data dir and a short key before touching anything', async () => {
        await assert.rejects(
            authModule.createProtonAuth({ dataDir: 'relative', key: randomBytes(32), clientUid: 'c', logger: SILENT }),
            /absolute/,
        );
        await assert.rejects(
            authModule.createProtonAuth({ dataDir: await dir(), key: randomBytes(16), clientUid: 'c', logger: SILENT }),
            /32 bytes/,
        );
    });
});

describe('login', () => {
    it('hands the approval URL to onUrl before waiting for completion', async () => {
        const { session, state } = fakeSession();
        let release!: (email: string) => void;
        const completion = new Promise<string>((resolve) => {
            release = resolve;
        });
        (session as unknown as { beginWebSignIn(): Promise<{ url: string; completion: Promise<string> }> }).beginWebSignIn =
            async () => {
                state.beginCalls++;
                return {
                    url: state.url,
                    completion: completion.then((email) => {
                        state.signedIn = true;
                        return email;
                    }),
                };
            };
        const auth = authWith(session);
        const seen: string[] = [];
        const pending = auth.login((url) => {
            seen.push(url);
        });
        // The URL is out while the approval is still pending.
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(seen, [state.url]);
        release('user@example.com');
        await pending;
        assert.equal(state.beginCalls, 1);
    });

    it('already signed in means no URL and no new flow', async () => {
        const { session, state } = fakeSession();
        state.signedIn = true;
        const auth = authWith(session);
        let called = 0;
        await auth.login(() => {
            called++;
        });
        assert.equal(state.beginCalls, 0);
        assert.equal(called, 0);
        assert.equal(state.initCalls, 1);
    });

    it('a completed approval without a client throws instead of half-logging-in', async () => {
        const { session } = fakeSession();
        (session as unknown as { beginWebSignIn(): Promise<{ url: string; completion: Promise<string> }> }).beginWebSignIn =
            async () => ({ url: 'https://account.proton.me/approve#x', completion: Promise.resolve('') });
        const auth = authWith(session);
        await assert.rejects(auth.login(() => {}), /could not be built/);
    });
});

describe('resolveFolder', () => {
    it('walks a path below /my-files', async () => {
        const backups = uid('backups');
        const vault = uid('vault');
        const { auth, drive } = driveWithSession(backups, vault);
        assert.deepEqual(await auth.resolveFolder('Backups/vault'), { uid: vault, path: 'Backups/vault' });
        assert.deepEqual(await auth.resolveFolder('/Backups/vault/'), { uid: vault, path: 'Backups/vault' });
        assert.deepEqual(await auth.resolveFolder(''), { uid: drive.rootUid, path: '' });
    });

    it('resolves a short name directly below the root', async () => {
        const backups = uid('backups');
        const { auth } = driveWithSession(backups, uid('vault'));
        assert.deepEqual(await auth.resolveFolder('Backups'), { uid: backups, path: 'Backups' });
    });

    it('resolves a uid after verifying it is a live folder below the root', async () => {
        const backups = uid('backups');
        const vault = uid('vault');
        const { auth } = driveWithSession(backups, vault);
        assert.deepEqual(await auth.resolveFolder(vault), { uid: vault, path: 'Backups/vault' });
    });

    it('refuses .., empty segments, and missing folders it may not create', async () => {
        const { auth } = driveWithSession(uid('backups'), uid('vault'));
        await assert.rejects(auth.resolveFolder('../Backups'), /below \/my-files/);
        await assert.rejects(auth.resolveFolder('Backups/../../x'), /below \/my-files/);
        await assert.rejects(auth.resolveFolder('Backups//vault'), /below \/my-files/);
        await assert.rejects(auth.resolveFolder('Backups/missing'), /does not exist/);
        await assert.rejects(auth.resolveFolder(uid('nope')), /does not exist|trashed/);
    });

    it('creates missing folders only when told to, never inventing a uid', async () => {
        const backups = uid('backups');
        const { auth, drive } = driveWithSession(backups, uid('vault'));
        const resolved = await auth.resolveFolder('Backups/new/deep', { create: true });
        assert.equal(resolved.path, 'Backups/new/deep');
        assert.deepEqual(
            drive.created.map((c) => c.name),
            ['new', 'deep'],
        );
        // What came back was read from Drive, not made up.
        assert.deepEqual(await auth.resolveFolder(resolved.uid), resolved);
    });

    it('refuses to create a name the vault could not sync', async () => {
        const { auth } = driveWithSession(uid('backups'), uid('vault'));
        await assert.rejects(auth.resolveFolder('Backups/..', { create: true }), /below \/my-files/);
        await assert.rejects(auth.resolveFolder('Backups/.', { create: true }), /below \/my-files/);
    });

    it('a uid of a file, a trashed folder, or one outside /my-files throws', async () => {
        const backups = uid('backups');
        const { session, state, drive } = driveWithSession(backups, uid('vault'));
        const file = uid('file');
        drive.add({ uid: file, name: 'note.md', type: NodeType.File, parentUid: backups });
        const trashed = uid('trashed');
        drive.add({ uid: trashed, name: 'old', type: NodeType.Folder, parentUid: drive.rootUid, trashed: true });
        const elsewhere = uid('elsewhere');
        const outside = uid('outside');
        drive.add({ uid: elsewhere, name: 'Shared', type: NodeType.Folder, parentUid: null });
        drive.add({ uid: outside, name: 'vault', type: NodeType.Folder, parentUid: elsewhere });
        const undecryptable = uid('undecryptable');
        drive.add({ uid: undecryptable, name: '???', type: NodeType.Folder, parentUid: drive.rootUid, undecryptable: true });
        state.signedIn = true;
        state.client = drive;
        const auth = authWith(session);
        await assert.rejects(auth.resolveFolder(file), /not a folder/);
        await assert.rejects(auth.resolveFolder(trashed), /does not exist or is trashed/);
        await assert.rejects(auth.resolveFolder(outside), /not below/);
        await assert.rejects(auth.resolveFolder(undecryptable), /decrypted/);
    });
});

describe('signOut and session-ended', () => {
    it('signOut delegates to the session, which revokes and clears the slot', async () => {
        const { session, state } = fakeSession();
        state.signedIn = true;
        await authWith(session).signOut();
        assert.equal(state.signedOut, true);
        assert.equal(state.signedIn, false);
    });

    it('surfaces the session-ended handler so the daemon can exit 4', async () => {
        const { session, state } = fakeSession();
        const auth = authWith(session);
        let notified = 0;
        auth.onSessionEnded(() => {
            notified++;
        });
        state.endedHandler?.();
        assert.equal(notified, 1);
        auth.onSessionEnded(null);
        assert.equal(state.endedHandler, null);
    });

    it('setCacheMarker reaches the session marker source', async () => {
        const { session } = fakeSession();
        let source: (() => string) | null = null;
        const auth = authWith(session, {
            setMarkerSource: (next) => {
                source = next;
            },
        });
        const marker = () => 'cursor-9';
        auth.setCacheMarker(marker);
        assert.equal(source, marker);
    });
});
