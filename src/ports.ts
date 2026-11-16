/**
 * The seams between the daemon's three workstreams. Frozen for the scaffold:
 * a stream that cannot meet one of these signatures reports it instead of
 * inventing a parallel type, because the integration pass is written against
 * exactly these names.
 *
 * Nothing here re-implements the engine. `SyncEngine` keeps taking the Obsidian
 * `App` it always took; {@link HeadlessVault} is how a directory on disk
 * becomes one.
 */
import type { App } from 'obsidian';

import type { CacheStore } from '../../src/proton/persistentCache';
import type { ProtonSession } from '../../src/proton/session';
import type { Logger } from '../../src/util/logger';

/** The vault events the plugin subscribes to on `app.vault`, narrowed to the three the engine consumes. */
export type VaultEvents = {
    onChange(path: string): void;
    onRename(oldPath: string, newPath: string, isFolder: boolean): void;
    onFolderDelete(path: string): void;
};

/**
 * A vault directory presented as the `App` the engine expects, plus the
 * watcher that feeds {@link VaultEvents} from the filesystem.
 *
 * `close()` must stop the watcher and settle any debounced callback still in
 * flight; the engine's own `stop()` does not know about it.
 */
export type HeadlessVault = {
    app: App;
    close(): Promise<void>;
};

export type CreateHeadlessVault = (options: {
    /** Absolute path of the vault directory. */
    vaultPath: string;
    /** Config directory name inside the vault, e.g. `.obsidian`. */
    configDir: string;
    logger: Logger;
    events: VaultEvents;
    /** How often a full rescan runs as a backstop to missed watcher events, in seconds. */
    rescanSeconds?: number;
}) => Promise<HeadlessVault>;

/**
 * Everything that touches Proton: the session, its encrypted slot at rest, the
 * metadata cache and the first-run sign-in.
 *
 * `restore()` is the unattended path: it loads the saved session and reports
 * whether it could sign in without a human. `login()` is the interactive one
 * and must hand the approval URL to `onUrl` before waiting.
 */
export type ProtonAuth = {
    session: ProtonSession;
    cacheStore: CacheStore | null;
    /** True when a stored session was loaded and the client built. */
    restore(): Promise<boolean>;
    /** Device/web sign-in; resolves once the client exists. */
    login(onUrl: (url: string) => void, signal?: AbortSignal): Promise<void>;
    /** Resolve a Drive folder given a uid or a `/`-separated path below the root. */
    resolveFolder(spec: string): Promise<{ uid: string; path: string }>;
    signOut(): Promise<void>;
};

export type CreateProtonAuth = (options: {
    dataDir: string;
    /** Key material for the session file; 32 bytes. */
    key: Uint8Array;
    clientUid: string;
    logger: Logger;
    /** Injected for tests; defaults to global fetch. */
    fetchImpl?: typeof fetch;
    /** The folder the engine will sync; needed to scope the metadata cache. */
    remoteFolderUid?: string | null;
    /**
     * `file` (default) keeps the encrypted Drive node cache between starts;
     * `memory` trades a slower start for nothing on disk. Mirrors
     * `DaemonConfig['metadataCache']`.
     */
    metadataCache?: 'file' | 'memory';
}) => Promise<ProtonAuth>;
