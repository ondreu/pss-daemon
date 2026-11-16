/**
 * Daemon lifecycle: everything around the engine that makes it a process.
 *
 * The wiring order mirrors `src/main.ts` (`connect` into `startEngine`):
 * session restore -> state.load -> wasLost gate -> cache clear/validate ->
 * device list -> first-sync pairing gate -> engine.start. Anything that
 * deviates from that order is a bug, because the order is what keeps a torn
 * state from ever reading as "fresh" and a fresh state from ever trusting a
 * stale Drive cache.
 *
 * Tests inject fakes through {@link DaemonDeps}; production defaults are the
 * real factories: `createHeadlessVault` from `./headlessApp` and
 * `createProtonAuth` from `./auth`. They are statically imported so a rename
 * breaks the build instead of showing up as a runtime "seam" error.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProtonDriveClient } from '@protontech/drive-sdk';
import type { DataAdapter } from 'obsidian';

import { DEFAULT_SETTINGS, type PluginSettings } from '../../src/settings';
import { DeviceRegistry } from '../../src/sync/devices';
import { DriveIO, sharedWithOthers } from '../../src/sync/drive';
import { SyncEngine, type EngineHooks, type SyncPlan, type SyncSummary } from '../../src/sync/engine';
import { DESKTOP } from '../../src/sync/engine/types';
import { SyncState } from '../../src/sync/state';
import type { SyncRecord } from '../../src/sync/types';
import { Logger } from '../../src/util/logger';
import { createProtonAuth } from './auth';
import { ensureDaemonDirs, loadKeyMaterial, vaultLockFile } from './config';
import { createHeadlessVault } from './headlessApp';
import { acquireDaemonLocks, LockHeldError, releaseLocks, type DaemonLock, type LockProbe } from './lock';
import { emptyHealth, writeHealthFile, type DaemonState, type HealthFile } from './health';
import type { CreateHeadlessVault, CreateProtonAuth, HeadlessVault } from './ports';
import { ExitCode, type DaemonConfig, type DaemonPaths } from './types';

// ---------------------------------------------------------------------------
// narrow interfaces: what the lifecycle needs, so fakes can stand in
// ---------------------------------------------------------------------------

/** The slice of `ProtonSession` the daemon touches. `ProtonAuth` satisfies this as-is. */
export type SessionLike = {
    accountEmail: string | null | undefined;
    getClient(): ProtonDriveClient;
    clearCache(): Promise<void>;
    validateCache(fingerprint: string): Promise<void>;
    flushCache(): Promise<void>;
    setSessionEndedHandler(handler: (() => void) | null): void;
};

/** The slice of `ProtonAuth` the daemon touches. */
export type AuthLike = {
    session: SessionLike;
    restore(): Promise<boolean>;
    login(onUrl: (url: string) => void, signal?: AbortSignal): Promise<void>;
    signOut(): Promise<void>;
};

/** The slice of `SyncState` the daemon touches. */
export type StateLike = {
    load(accountEmail: string | null, remoteFolderUid: string | null): Promise<void>;
    wasLost(): boolean;
    paths(): string[];
    cursorsFingerprint(): string;
    entries(): SyncRecord[];
    flush(): Promise<void>;
    close(): void;
};

/** The slice of `SyncEngine` the daemon touches. */
export type EngineLike = {
    start(client: ProtonDriveClient, rootUid: string): Promise<void>;
    stop(): Promise<void>;
    syncNow(): Promise<void>;
    getSummary(): SyncSummary;
    pendingMassDelete(): { count: number; paths: string[] } | undefined;
    approveMassDelete(): Promise<void>;
    denyMassDelete(): Promise<void>;
    plan(client: ProtonDriveClient, rootUid: string): Promise<SyncPlan>;
    watchDevices(registry: DeviceRegistry | null): void;
    updateSettings(settings: PluginSettings): void;
    onVaultChange(path: string): void;
    onVaultRename(oldPath: string, newPath: string, isFolder: boolean): void;
    onVaultFolderDelete(path: string): void;
};

export type BootstrapContext = {
    vault: HeadlessVault;
    auth: AuthLike;
    config: DaemonConfig;
    settings: PluginSettings;
    logger: Logger;
    hooks: EngineHooks;
};

export type BootstrapEngines = (context: BootstrapContext) => Promise<{ state: StateLike; engine: EngineLike }>;

/** `'ok'` continues; `'removed'` means another device removed this one — sign out. */
export type OpenDeviceList = (options: {
    client: ProtonDriveClient;
    rootUid: string;
    clientUid: string;
    engine: EngineLike;
    logger: Logger;
}) => Promise<'ok' | 'removed'>;

export type DaemonDeps = {
    createVault?: CreateHeadlessVault;
    createAuth?: (options: Parameters<CreateProtonAuth>[0]) => Promise<AuthLike>;
    bootstrap?: BootstrapEngines;
    openDeviceList?: OpenDeviceList;
    /** Probe for lock liveness; injected in tests so pids stay fake. */
    lockProbe?: LockProbe;
    /** State loader for `verify`; defaults to a read-only real `SyncState`. */
    loadState?: (options: { dataDir: string; stateFile: string; logger: Logger }) => Promise<StateLike>;
    /** Remote listing for `verify`; defaults to a live Drive listing. */
    listRemote?: (client: ProtonDriveClient, rootUid: string, logger: Logger) => Promise<Map<string, { hash?: string; size?: number }>>;
};

export type DaemonIO = {
    stdout(line: string): void;
    stderr(line: string): void;
    env: NodeJS.ProcessEnv;
};

export function defaultIO(env: NodeJS.ProcessEnv = process.env): DaemonIO {
    return {
        stdout: (line) => process.stdout.write(line + '\n'),
        stderr: (line) => process.stderr.write(line + '\n'),
        env,
    };
}

/** One JSON line on stdout; the daemon's log format per the arch doc. */
export function jsonLog(io: DaemonIO, level: string, module: string, message: string, extra?: Record<string, unknown>): void {
    io.stdout(JSON.stringify({ ts: new Date().toISOString(), level, module, msg: message, ...extra }));
}

// ---------------------------------------------------------------------------
// small pieces
// ---------------------------------------------------------------------------

/**
 * The adapter `SyncState` needs for the daemon's own files. The vault's
 * adapter is rooted at the vault and cannot address the data dir (which
 * must never be inside the vault), so the state gets five file ops over
 * absolute paths instead. Writes go through temp-plus-rename, mirroring
 * what `SyncState` itself does one layer up.
 */
class DataDirAdapter {
    async exists(filePath: string): Promise<boolean> {
        try {
            await stat(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async read(filePath: string): Promise<string> {
        return readFile(filePath, 'utf8');
    }

    async write(filePath: string, text: string): Promise<void> {
        await mkdir(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.tmp`;
        await writeFile(tmp, text, 'utf8');
        const { rename } = await import('node:fs/promises');
        await rename(tmp, filePath);
    }

    async remove(filePath: string): Promise<void> {
        const { unlink } = await import('node:fs/promises');
        await unlink(filePath);
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        const { rename } = await import('node:fs/promises');
        await rename(oldPath, newPath);
    }
}

async function defaultBootstrap(context: BootstrapContext): Promise<{ state: StateLike; engine: EngineLike }> {
    const adapter = new DataDirAdapter();
    const state = new SyncState(
        adapter as unknown as DataAdapter,
        path.join(context.config.dataDir, 'sync-state.json'),
        context.logger.getLogger('state'),
        () => {
            void context.auth.session.flushCache();
        },
    );
    const engine = new SyncEngine(
        context.vault.app,
        state,
        context.settings,
        context.logger.getLogger('sync'),
        context.hooks,
        { configDir: context.config.configDir, pluginDir: null },
        { ...DESKTOP, isHidden: () => false },
    );
    return { state, engine };
}

async function defaultOpenDeviceList(options: {
    client: ProtonDriveClient;
    rootUid: string;
    clientUid: string;
    engine: EngineLike;
    logger: Logger;
}): Promise<'ok' | 'removed'> {
    // Mirror main.ts: when the folder is shared (or sharing cannot be
    // checked), the list stays off and the sync goes on. The list is a
    // rendezvous, never a gate — except for removal, which signs out.
    let shared: boolean;
    try {
        shared = await sharedWithOthers(options.client, options.rootUid);
    } catch (error) {
        options.logger.warn('Could not check whether the folder is shared; the device list stays off for now', error);
        shared = true;
    }
    let registry: DeviceRegistry | null = null;
    if (!shared) {
        registry = new DeviceRegistry(new DriveIO(options.client, options.logger), options.rootUid, options.logger, null);
        try {
            await registry.prepare();
        } catch (error) {
            options.logger.warn('Could not read the device list ahead of time; syncing without it', error);
            registry = null;
        }
    }
    options.engine.watchDevices(registry);
    if (registry === null) {
        return 'ok';
    }
    let request: Awaited<ReturnType<DeviceRegistry['request']>>;
    try {
        request = await registry.request(options.clientUid);
    } catch (error) {
        options.logger.warn('Could not check the device list for requests; syncing as usual', error);
        return 'ok';
    }
    if (request === null) {
        return 'ok';
    }
    if (request.state === 'removed') {
        return 'removed';
    }
    // Pause requests from other devices are logged, not applied: headless
    // has no UI to resume from, and a remotely paused daemon that nobody
    // can unpause is a trap. Local config owns pausing (always off here).
    options.logger.info(`The device list asks for state "${request.state}"; ignoring it, this daemon does not pause remotely`);
    return 'ok';
}

/** This device's id for the device list, persisted in the data dir (the frozen config carries none). */
export async function readClientUid(dataDir: string): Promise<string> {
    const file = path.join(dataDir, 'device-id');
    try {
        const existing = (await readFile(file, 'utf8')).trim();
        if (existing !== '') {
            return existing;
        }
    } catch {
        // First start: create it below.
    }
    const created = randomUUID();
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, created + '\n', 'utf8');
    return created;
}

/** Daemon `PluginSettings`: the plugin's defaults, narrowed to unattended operation. */
export function toPluginSettings(config: DaemonConfig, options: { autoSync: boolean; conflictPolicy?: PluginSettings['conflictPolicy'] } = { autoSync: true }): PluginSettings {
    return {
        ...DEFAULT_SETTINGS,
        remoteFolderUid: config.remoteFolderUid,
        remoteFolderPath: null,
        remoteFolderSharedBy: null,
        conflictPolicy: options.conflictPolicy ?? config.conflictPolicy,
        massDeleteThreshold: config.massDeleteThreshold,
        remotePollSeconds: config.remotePollSeconds,
        transferConcurrency: config.transferConcurrency,
        paused: false,
        autoSync: options.autoSync,
        syncOnStartup: true,
        logLevel: config.logLevel,
        deviceName: 'pss-daemon',
    };
}

function mapEngineStatus(status: SyncSummary['status']): DaemonState {
    switch (status) {
        case 'idle':
        case 'paused':
            return 'idle';
        case 'syncing':
            return 'syncing';
        case 'error':
        case 'folder-missing':
        case 'locked':
            return 'error';
        case 'signed-out':
            return 'signed-out';
        default:
            return 'starting';
    }
}

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

export type SignalEmitter = {
    once(event: string, listener: () => void): unknown;
    removeListener?(event: string, listener: () => void): unknown;
};

/**
 * First SIGTERM/SIGINT starts the graceful drain; a second one forces
 * exit 1, since a wedged drain must not hold the supervisor forever.
 * Returns a function that unregisters the handlers.
 */
export function installShutdownHandlers(options: {
    emitter?: SignalEmitter;
    exit?: (code: number) => void;
    onFirst: () => void;
}): () => void {
    const emitter = options.emitter ?? (process);
    const exit = options.exit ?? ((code: number) => process.exit(code));
    let first = false;
    const handler = (): void => {
        if (!first) {
            first = true;
            options.onFirst();
            return;
        }
        exit(1);
    };
    emitter.once('SIGTERM', handler);
    emitter.once('SIGINT', handler);
    return () => {
        emitter.removeListener?.('SIGTERM', handler);
        emitter.removeListener?.('SIGINT', handler);
    };
}

// ---------------------------------------------------------------------------
// boot: the shared spine of once / watch / approve / deny
// ---------------------------------------------------------------------------

export type BootRequest = {
    config: DaemonConfig;
    paths: DaemonPaths;
    /** `once` runs one pass; `watch` stays up. Both need the same spine. */
    autoSync: boolean;
    pairing?: string | null;
    /** Read-only preview: the pairing gate is skipped, nothing is written. */
    dryRun?: boolean;
    deps?: DaemonDeps;
    io?: DaemonIO;
    env?: NodeJS.ProcessEnv;
    emitter?: SignalEmitter;
    /** Real exit only from the signal fast path; injected in tests. */
    exit?: (code: number) => void;
};

export type Boot = {
    io: DaemonIO;
    logger: Logger;
    config: DaemonConfig;
    paths: DaemonPaths;
    locks: DaemonLock[];
    vault: HeadlessVault;
    auth: AuthLike;
    state: StateLike;
    engine: EngineLike;
    client: ProtonDriveClient;
    rootUid: string;
    clientUid: string;
    sessionEnded: () => boolean;
    uninstallSignals: () => void;
    writeHealth: (health: Partial<HealthFile> & { state: DaemonState }) => Promise<HealthFile>;
    plan: SyncPlan | null;
};

async function bootDaemon(request: BootRequest): Promise<{ boot: Boot } | { exitCode: ExitCode }> {
    const io = request.io ?? defaultIO(request.env);
    const env = request.env ?? request.io?.env ?? process.env;
    const deps = request.deps ?? {};
    const logger = new Logger(request.config.logLevel, 'pss-daemon');
    const config = request.config;
    const paths = request.paths;

    await ensureDaemonDirs(config);
    let lastHealth: HealthFile = { ...emptyHealth('starting'), updatedAt: new Date().toISOString() };
    const writeHealth = async (update: Partial<HealthFile> & { state: DaemonState }): Promise<HealthFile> => {
        lastHealth = { ...lastHealth, ...update, updatedAt: new Date().toISOString() };
        await writeHealthFile(paths.healthFile, lastHealth);
        return lastHealth;
    };
    await writeHealth({ state: 'starting' });

    let locks: DaemonLock[];
    try {
        locks = await acquireDaemonLocks({
            dataDirLockPath: paths.lockFile,
            vaultLockPath: vaultLockFile(config),
            vaultPath: config.vaultPath,
            probe: deps.lockProbe,
            onTakeover: (message) => jsonLog(io, 'warn', 'lock', message),
        });
    } catch (error) {
        if (error instanceof LockHeldError) {
            jsonLog(io, 'error', 'lock', error.message, { lockPath: error.lockPath });
            await writeHealth({ state: 'error', error: error.message });
            return { exitCode: ExitCode.AlreadyRunning };
        }
        throw error;
    }

    const cleanup = async (): Promise<void> => {
        uninstallSignals();
        await releaseLocks(locks).catch(() => undefined);
    };
    // Installed before anything that can hang, so even a wedged start
    // still answers the second signal with exit 1.
    let stopEngine: () => void = () => undefined;
    const uninstallSignals = installShutdownHandlers({
        emitter: request.emitter,
        exit: request.exit,
        onFirst: () => stopEngine(),
    });

    try {
        const key = await loadKeyMaterial(env);
        const clientUid = await readClientUid(config.dataDir);

        let engineRef: EngineLike | null = null;
        let sessionEnded = false;
        stopEngine = () => {
            void engineRef?.stop().catch(() => undefined);
        };

        const createVault = deps.createVault ?? createHeadlessVault;
        const vault = await createVault({
            vaultPath: config.vaultPath,
            configDir: config.configDir,
            logger,
            events: {
                onChange: (changedPath) => engineRef?.onVaultChange(changedPath),
                onRename: (oldPath, newPath, isFolder) => engineRef?.onVaultRename(oldPath, newPath, isFolder),
                onFolderDelete: (deletedPath) => engineRef?.onVaultFolderDelete(deletedPath),
            },
            ...(request.autoSync ? { rescanSeconds: 900 } : {}),
        });

        const createAuth = deps.createAuth ?? createProtonAuth;
        const auth = await createAuth({ dataDir: config.dataDir, key, clientUid, logger, remoteFolderUid: config.remoteFolderUid });
        let restored: boolean;
        try {
            restored = await auth.restore();
        } catch (error) {
            jsonLog(io, 'error', 'auth', 'Could not restore the saved session; signing in again is needed', {
                error: error instanceof Error ? error.message : String(error),
            });
            await writeHealth({ state: 'signed-out', error: 'Could not restore the saved session.' });
            await vault.close().catch(() => undefined);
            await cleanup();
            return { exitCode: ExitCode.SignedOut };
        }
        if (!restored) {
            jsonLog(io, 'error', 'auth', 'No saved session. Run `pss-daemon login` on a machine with a browser, then start the daemon.');
            await writeHealth({ state: 'signed-out', error: 'Not signed in.' });
            await vault.close().catch(() => undefined);
            await cleanup();
            return { exitCode: ExitCode.SignedOut };
        }

        auth.session.setSessionEndedHandler(() => {
            sessionEnded = true;
            stopEngine();
        });

        const settings = toPluginSettings(config, { autoSync: request.autoSync });
        const heldNoted = { current: false };
        const hooks: EngineHooks = {
            onChange: (summary) => {
                const held = summary.pendingMassDelete;
                const stateName: DaemonState = held !== undefined ? 'mass-delete-held' : mapEngineStatus(summary.status);
                if (held !== undefined && !heldNoted.current) {
                    heldNoted.current = true;
                    jsonLog(io, 'warn', 'sync', `Holding ${held.count} deletions for an explicit decision; nothing was deleted`, {
                        paths: held.paths,
                    });
                } else if (held === undefined) {
                    heldNoted.current = false;
                }
                jsonLog(io, summary.status === 'error' ? 'warn' : 'info', 'sync', `status: ${summary.status}`, {
                    lastSyncedAt: summary.lastSyncedAt,
                    pending: summary.pending,
                    conflicts: summary.conflicts,
                });
                void writeHealth({
                    state: stateName,
                    lastSummary: summary,
                    pendingConflicts: summary.conflicts,
                    massDeleteHeld: held?.paths ?? [],
                    ...(summary.status === 'idle' ? { lastPassAt: new Date().toISOString() } : {}),
                }).catch(() => undefined);
            },
            onConflict: (event) => {
                jsonLog(io, 'warn', 'conflict', `Conflict on ${event.path}: ${event.outcome}`, {
                    path: event.path,
                    reason: event.reason,
                    outcome: event.outcome,
                    ...(event.copyPath !== undefined ? { copyPath: event.copyPath } : {}),
                });
                void writeHealth({ state: lastHealth.state, pendingConflicts: lastHealth.pendingConflicts + 1 }).catch(() => undefined);
            },
        };

        const bootstrap = deps.bootstrap ?? defaultBootstrap;
        const { state, engine } = await bootstrap({ vault, auth, config, settings, logger, hooks });
        engineRef = engine;

        // The state binds to one account and one folder; a file from
        // another account or folder is ignored, and unreadable copies set
        // wasLost. Either way the gate below decides, never the sync.
        await state.load(auth.session.accountEmail ?? null, config.remoteFolderUid);
        if (state.wasLost()) {
            // Refuse, with zero Drive writes: a lost merge base turns every
            // difference into a conflict and resurrects old deletions. The
            // engine never started, the cache was never touched, and no
            // listing ran — there is nothing to undo.
            const message = 'The sync state could not be read from any copy; refusing to sync rather than re-baselining silently.';
            jsonLog(io, 'error', 'state', message);
            await writeHealth({ state: 'error', error: message });
            state.close();
            await vault.close().catch(() => undefined);
            await cleanup();
            return { exitCode: ExitCode.StateLost };
        }
        if (state.paths().length === 0) {
            // Mirrors main.ts exactly: a sync starting from nothing must
            // not trust anything cached about how Drive used to look.
            await auth.session.clearCache();
        } else {
            await auth.session.validateCache(state.cursorsFingerprint());
        }

        const client = auth.session.getClient();
        const rootUid = config.remoteFolderUid;
        if (rootUid === null) {
            const message = 'No Drive folder is configured (remoteFolderUid is null). Set it in daemon.json, then run `once`.';
            jsonLog(io, 'error', 'config', message);
            await writeHealth({ state: 'error', error: message });
            state.close();
            await vault.close().catch(() => undefined);
            await cleanup();
            return { exitCode: ExitCode.ConfigInvalid };
        }

        const openDeviceList = deps.openDeviceList ?? defaultOpenDeviceList;
        const verdict = await openDeviceList({ client, rootUid, clientUid, engine, logger });
        if (verdict === 'removed') {
            jsonLog(io, 'error', 'devices', 'This device was removed from the device list by another device; signing out.');
            await auth.signOut().catch(() => undefined);
            await writeHealth({ state: 'signed-out', error: 'Removed by another device.' });
            state.close();
            await vault.close().catch(() => undefined);
            await cleanup();
            return { exitCode: ExitCode.SignedOut };
        }

        // First sync of two non-empty sides: refuse until told which side
        // wins, exactly like the plugin's first-sync modal. With an
        // established state this is skipped, and a dry run never writes so
        // it never needs the gate either.
        let plan: SyncPlan | null = null;
        if (state.paths().length === 0 && request.dryRun !== true) {
            plan = await engine.plan(client, rootUid);
            const changes = plan.uploads.length + plan.downloads.length + plan.conflicts.length + plan.removals.length;
            if (plan.localNotes > 0 && plan.remoteFiles > 0 && changes > 0) {
                const effective = request.pairing ?? config.pairing;
                if (effective === null) {
                    const message = `First sync: the vault holds ${plan.localNotes} notes and the Drive folder holds ${plan.remoteFiles} files. Refusing to guess — rerun with --pairing=adopt-drive, --pairing=adopt-vault or --pairing=merge.`;
                    jsonLog(io, 'error', 'pairing', message, {
                        uploads: plan.uploads.length,
                        downloads: plan.downloads.length,
                        conflicts: plan.conflicts.length,
                    });
                    await writeHealth({ state: 'error', error: message });
                    state.close();
                    await vault.close().catch(() => undefined);
                    await cleanup();
                    return { exitCode: ExitCode.Usage };
                }
                // adopt-vault / adopt-vault resolve first-sync collisions
                // towards the named side; merge keeps the configured policy
                // (default keep-both). Same bytes adopt either way.
                const override = effective === 'adopt-drive' ? 'prefer-remote' : effective === 'adopt-vault' ? 'prefer-local' : undefined;
                if (override !== undefined) {
                    engine.updateSettings({ ...settings, conflictPolicy: override });
                }
                jsonLog(io, 'warn', 'pairing', `First sync with pairing=${effective}`, { policy: override ?? settings.conflictPolicy });
            }
        }

        return {
            boot: {
                io,
                logger,
                config,
                paths,
                locks,
                vault,
                auth,
                state,
                engine,
                client,
                rootUid,
                clientUid,
                sessionEnded: () => sessionEnded,
                uninstallSignals,
                writeHealth,
                plan,
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        jsonLog(io, 'error', 'daemon', `Startup failed: ${message}`);
        await writeHealth({ state: 'error', error: message }).catch(() => undefined);
        await cleanup();
        throw error;
    }
}

async function shutdownBoot(boot: Boot): Promise<void> {
    boot.uninstallSignals();
    boot.state.close();
    await boot.vault.close().catch(() => undefined);
    await releaseLocks(boot.locks).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// once / watch
// ---------------------------------------------------------------------------

export type RunDaemonOptions = {
    config: DaemonConfig;
    paths: DaemonPaths;
    mode: 'once' | 'watch';
    pairing?: string | null;
    dryRun?: boolean;
    json?: boolean;
    deps?: DaemonDeps;
    io?: DaemonIO;
    env?: NodeJS.ProcessEnv;
    emitter?: SignalEmitter;
    exit?: (code: number) => void;
    /** Heartbeat period in watch mode; shortened in tests. */
    heartbeatMs?: number;
};

function summarizeExit(summary: SyncSummary): ExitCode {
    if (summary.pendingMassDelete !== undefined) {
        return ExitCode.MassDeleteHeld;
    }
    if (summary.lastError !== null) {
        return ExitCode.ItemFailures;
    }
    return ExitCode.Ok;
}

/**
 * Run one pass (`once`) or stay up (`watch`). Never auto-approves a mass
 * delete: `once` reports it as exit 3, `watch` keeps syncing everything
 * else and re-reports every pass.
 */
export async function runDaemon(options: RunDaemonOptions): Promise<ExitCode> {
    const booted = await bootDaemon({ ...options, autoSync: options.mode === 'watch' });
    if ('exitCode' in booted) {
        return booted.exitCode;
    }
    const { boot } = booted;
    const { io } = boot;

    try {
        if (options.dryRun) {
            const plan = boot.plan ?? (await boot.engine.plan(boot.client, boot.rootUid));
            const changes = plan.uploads.length + plan.downloads.length + plan.conflicts.length + plan.removals.length;
            const report = {
                localFiles: plan.localFiles,
                localNotes: plan.localNotes,
                remoteFiles: plan.remoteFiles,
                uploads: options.json ? plan.uploads : plan.uploads.slice(0, 50),
                downloads: options.json ? plan.downloads : plan.downloads.slice(0, 50),
                conflicts: options.json ? plan.conflicts : plan.conflicts.slice(0, 50),
                removals: options.json ? plan.removals : plan.removals.slice(0, 50),
                held: plan.held,
                unchanged: plan.unchanged,
            };
            if (options.json === true) {
                io.stdout(JSON.stringify(report));
            } else {
                jsonLog(io, 'info', 'dry-run', `Would sync ${changes} paths (${plan.uploads.length} uploads, ${plan.downloads.length} downloads, ${plan.conflicts.length} conflicts, ${plan.removals.length} removals).`, report);
            }
            const wouldHold = boot.config.massDeleteThreshold > 0 && plan.removals.length >= boot.config.massDeleteThreshold;
            await boot.writeHealth({ state: 'idle', error: null });
            await shutdownBoot(boot);
            return wouldHold ? ExitCode.MassDeleteHeld : ExitCode.Ok;
        }

        if (boot.sessionEnded()) {
            await boot.writeHealth({ state: 'signed-out', error: 'The Proton session ended.' });
            await shutdownBoot(boot);
            return ExitCode.SignedOut;
        }

        if (options.mode === 'once') {
            // A signal mid-pass drains the engine and lands here as an
            // interruption, not a failure: the supervisor asked us to stop,
            // and stop() already flushed the state.
            let interrupted = false;
            boot.uninstallSignals();
            const uninstallOnce = installShutdownHandlers({
                emitter: options.emitter,
                exit: options.exit,
                onFirst: () => {
                    interrupted = true;
                    void boot.engine.stop().catch(() => undefined);
                },
            });
            try {
                await boot.engine.start(boot.client, boot.rootUid);
            } catch (error) {
                uninstallOnce();
                if (interrupted || boot.sessionEnded()) {
                    await boot.writeHealth({ state: boot.sessionEnded() ? 'signed-out' : 'stopped', error: null }).catch(() => undefined);
                    await shutdownBoot(boot);
                    return boot.sessionEnded() ? ExitCode.SignedOut : ExitCode.Ok;
                }
                throw error;
            }
            uninstallOnce();
            if (boot.sessionEnded()) {
                jsonLog(io, 'error', 'auth', 'The Proton session ended during the pass; not retrying without a human.');
                await boot.writeHealth({ state: 'signed-out', error: 'The Proton session ended.' });
                await boot.engine.stop().catch(() => undefined);
                await shutdownBoot(boot);
                return ExitCode.SignedOut;
            }
            const summary = boot.engine.getSummary();
            const code = summarizeExit(summary);
            if (code === ExitCode.MassDeleteHeld) {
                jsonLog(io, 'warn', 'sync', `Held ${summary.pendingMassDelete?.count} deletions; approve explicitly with approve-mass-delete.`, {
                    paths: summary.pendingMassDelete?.paths,
                });
            } else if (code === ExitCode.ItemFailures) {
                jsonLog(io, 'warn', 'sync', `Pass finished with item failures: ${summary.lastError}`, { pending: summary.pending });
            } else {
                jsonLog(io, 'info', 'sync', 'Pass finished in sync.');
            }
            await boot.writeHealth({
                state: code === ExitCode.MassDeleteHeld ? 'mass-delete-held' : code === ExitCode.Ok ? 'idle' : 'error',
                lastSummary: summary,
                pendingConflicts: summary.conflicts,
                massDeleteHeld: summary.pendingMassDelete?.paths ?? [],
                lastPassAt: new Date().toISOString(),
                error: summary.lastError,
            });
            await boot.engine.stop().catch(() => undefined);
            await shutdownBoot(boot);
            return code;
        }

        // watch: the engine's own scheduler polls Drive; this loop is only
        // the heartbeat (liveness proof) plus shutdown. Mass-delete holds
        // are reported by the onChange hook; the engine keeps syncing the
        // rest, and every pass re-reports until a human decides.
        if (boot.sessionEnded()) {
            await boot.writeHealth({ state: 'signed-out', error: 'The Proton session ended.' });
            await shutdownBoot(boot);
            return ExitCode.SignedOut;
        }
        await boot.engine.start(boot.client, boot.rootUid);
        const watching = boot.engine.getSummary();
        await boot.writeHealth({
            state: 'syncing',
            lastSummary: watching,
            pendingConflicts: watching.conflicts,
            massDeleteHeld: watching.pendingMassDelete?.paths ?? [],
            error: null,
        });
        jsonLog(io, 'info', 'daemon', 'Watching for changes. Send SIGTERM/SIGINT to stop gracefully.');

        // Re-arm shutdown: the boot handler only drains the engine, but
        // watch must also leave the wait below. The second signal still
        // forces exit 1 through the same helper.
        boot.uninstallSignals();
        let resolveDone: (code: ExitCode) => void = () => undefined;
        const done = new Promise<ExitCode>((resolve) => {
            resolveDone = resolve;
        });
        const uninstallWatch = installShutdownHandlers({
            emitter: options.emitter,
            exit: options.exit,
            onFirst: () => {
                void boot.engine
                    .stop()
                    .catch(() => undefined)
                    .then(() => resolveDone(ExitCode.Ok));
            },
        });

        const heartbeatMs = options.heartbeatMs ?? 30_000;
        const heartbeat = setInterval(() => {
            void (async () => {
                if (boot.sessionEnded()) {
                    resolveDone(ExitCode.SignedOut);
                    return;
                }
                const current = boot.engine.getSummary();
                await boot.writeHealth({
                    state: current.pendingMassDelete !== undefined ? 'mass-delete-held' : mapEngineStatus(current.status),
                    lastSummary: current,
                    pendingConflicts: current.conflicts,
                    massDeleteHeld: current.pendingMassDelete?.paths ?? [],
                    error: current.lastError,
                }).catch(() => undefined);
            })();
        }, heartbeatMs);

        const code = await done;
        clearInterval(heartbeat);
        uninstallWatch();
        const final = boot.engine.getSummary();
        const exitCode: ExitCode = code === ExitCode.SignedOut || boot.sessionEnded() ? ExitCode.SignedOut : code;
        await boot.writeHealth({
            state: exitCode === ExitCode.SignedOut ? 'signed-out' : 'stopped',
            lastSummary: final,
            pendingConflicts: final.conflicts,
            massDeleteHeld: final.pendingMassDelete?.paths ?? [],
            error: exitCode === ExitCode.SignedOut ? 'The Proton session ended.' : null,
        }).catch(() => undefined);
        await shutdownBoot(boot);
        return exitCode;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        jsonLog(boot.io, 'error', 'daemon', `Pass failed: ${message}`);
        await boot.writeHealth({ state: 'error', error: message }).catch(() => undefined);
        await boot.engine.stop().catch(() => undefined);
        await shutdownBoot(boot);
        return ExitCode.ItemFailures;
    }
}

// ---------------------------------------------------------------------------
// approve / deny a held mass delete
// ---------------------------------------------------------------------------

/**
 * Decide a held mass delete. The hold lives in the running engine's memory,
 * so this boots and starts a fresh engine: the startup pass deterministically
 * reproduces the same hold from the same state, and the engine's own
 * approve/deny then re-decides every path first — a file that came back in
 * the meantime is uploaded, not deleted (approve), or downloaded again (deny).
 */
export async function runMassDecision(options: {
    config: DaemonConfig;
    paths: DaemonPaths;
    approve: boolean;
    deps?: DaemonDeps;
    io?: DaemonIO;
    env?: NodeJS.ProcessEnv;
    emitter?: SignalEmitter;
    exit?: (code: number) => void;
}): Promise<ExitCode> {
    const booted = await bootDaemon({ ...options, autoSync: false });
    if ('exitCode' in booted) {
        return booted.exitCode;
    }
    const { boot } = booted;
    const { io } = boot;
    try {
        await boot.engine.start(boot.client, boot.rootUid);
        if (boot.sessionEnded()) {
            await boot.engine.stop().catch(() => undefined);
            await shutdownBoot(boot);
            return ExitCode.SignedOut;
        }
        const held = boot.engine.pendingMassDelete();
        if (held === undefined) {
            jsonLog(io, 'info', 'sync', 'No deletions are held; nothing to decide.');
            await boot.writeHealth({ state: 'idle', massDeleteHeld: [], error: null });
            await boot.engine.stop().catch(() => undefined);
            await shutdownBoot(boot);
            return ExitCode.Ok;
        }
        jsonLog(io, 'warn', 'sync', `${options.approve ? 'Approving' : 'Denying'} ${held.count} held deletions.`, { paths: held.paths });
        if (options.approve) {
            await boot.engine.approveMassDelete();
        } else {
            await boot.engine.denyMassDelete();
        }
        const summary = boot.engine.getSummary();
        const code = summary.pendingMassDelete !== undefined ? ExitCode.MassDeleteHeld : summary.lastError !== null ? ExitCode.ItemFailures : ExitCode.Ok;
        await boot.writeHealth({
            state: code === ExitCode.Ok ? 'idle' : code === ExitCode.MassDeleteHeld ? 'mass-delete-held' : 'error',
            lastSummary: summary,
            pendingConflicts: summary.conflicts,
            massDeleteHeld: summary.pendingMassDelete?.paths ?? [],
            error: summary.lastError,
        });
        await boot.engine.stop().catch(() => undefined);
        await shutdownBoot(boot);
        return code;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        jsonLog(boot.io, 'error', 'daemon', `Decision failed: ${message}`);
        await boot.engine.stop().catch(() => undefined);
        await shutdownBoot(boot);
        return ExitCode.ItemFailures;
    }
}

// ---------------------------------------------------------------------------
// login / sign-out
// ---------------------------------------------------------------------------

/** Copy a GUI state file once; from then on the two evolve independently. Never overwrites. */
export async function importStateFile(source: string, destStateFile: string): Promise<void> {
    let text: string;
    try {
        text = await readFile(source, 'utf8');
    } catch {
        throw new Error(`Could not read the state file at ${source}.`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`The state file at ${source} is not valid JSON.`);
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== 1 || typeof (parsed as { records?: unknown }).records !== 'object') {
        throw new Error(`The state file at ${source} is not a v1 sync state.`);
    }
    try {
        await stat(destStateFile);
        throw new Error(`Refusing to overwrite ${destStateFile}; delete it while the daemon is stopped if re-baselining is really what you want.`);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('Refusing to overwrite')) {
            throw error;
        }
        // Missing: the expected case, copy below.
    }
    await mkdir(path.dirname(destStateFile), { recursive: true });
    await writeFile(destStateFile, text, 'utf8');
}

export async function runLogin(options: {
    config: DaemonConfig;
    paths: DaemonPaths;
    configFile: string;
    importState?: string;
    pairing?: string | null;
    deps?: DaemonDeps;
    io?: DaemonIO;
    env?: NodeJS.ProcessEnv;
    emitter?: SignalEmitter;
}): Promise<ExitCode> {
    const io = options.io ?? defaultIO(options.env);
    const env = options.env ?? io.env;
    const deps = options.deps ?? {};
    await ensureDaemonDirs(options.config);

    let locks: DaemonLock[];
    try {
        locks = await acquireDaemonLocks({
            dataDirLockPath: options.paths.lockFile,
            vaultLockPath: vaultLockFile(options.config),
            vaultPath: options.config.vaultPath,
            probe: deps.lockProbe,
            onTakeover: (message) => jsonLog(io, 'warn', 'lock', message),
        });
    } catch (error) {
        if (error instanceof LockHeldError) {
            jsonLog(io, 'error', 'lock', error.message);
            return ExitCode.AlreadyRunning;
        }
        throw error;
    }

    try {
        if (options.importState !== undefined) {
            await importStateFile(options.importState, options.paths.stateFile);
            jsonLog(io, 'info', 'login', `Imported GUI state from ${options.importState}. From now on the two evolve independently.`);
        }
        const key = await loadKeyMaterial(env);
        const clientUid = await readClientUid(options.config.dataDir);
        const logger = new Logger(options.config.logLevel, 'pss-daemon');
        const createAuth = deps.createAuth ?? createProtonAuth;
        const auth = await createAuth({ dataDir: options.config.dataDir, key, clientUid, logger, remoteFolderUid: options.config.remoteFolderUid });

        let restored = false;
        try {
            restored = await auth.restore();
        } catch {
            restored = false;
        }
        if (restored) {
            jsonLog(io, 'info', 'login', `Already signed in${auth.session.accountEmail !== null && auth.session.accountEmail !== undefined ? ` as ${auth.session.accountEmail}` : ''}. Nothing to do.`);
            await releaseLocks(locks);
            return ExitCode.Ok;
        }

        const abort = new AbortController();
        const uninstall = installShutdownHandlers({
            emitter: options.emitter,
            exit: (code) => process.exit(code),
            onFirst: () => abort.abort(),
        });
        try {
            jsonLog(io, 'info', 'login', 'Approve the sign-in in your browser. Waiting…');
            await auth.login(
                (url) => {
                    io.stdout(`Open this URL to approve the sign-in:\n${url}`);
                },
                abort.signal,
            );
        } finally {
            uninstall();
        }
        jsonLog(io, 'info', 'login', 'Signed in. The session is stored encrypted in the data dir.');

        if (options.pairing !== undefined && options.pairing !== null) {
            const raw = JSON.parse(await readFile(options.configFile, 'utf8')) as Record<string, unknown>;
            raw['pairing'] = options.pairing;
            const { parseDaemonConfig } = await import('./config');
            parseDaemonConfig(raw);
            await writeFile(options.configFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');
            jsonLog(io, 'info', 'login', `Saved pairing=${options.pairing} to ${options.configFile}.`);
        }
        jsonLog(io, 'info', 'login', 'Next: run `pss-daemon once` to preview the first sync, then `watch` to stay up.');
        await releaseLocks(locks);
        return ExitCode.Ok;
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            jsonLog(io, 'error', 'login', 'Sign-in aborted.');
            await releaseLocks(locks);
            return ExitCode.Usage;
        }
        await releaseLocks(locks);
        throw error;
    }
}

export async function runSignOut(options: {
    config: DaemonConfig;
    paths: DaemonPaths;
    deps?: DaemonDeps;
    io?: DaemonIO;
    env?: NodeJS.ProcessEnv;
}): Promise<ExitCode> {
    const io = options.io ?? defaultIO(options.env);
    const env = options.env ?? io.env;
    const deps = options.deps ?? {};
    await ensureDaemonDirs(options.config);

    // Refuse to sign out under a running daemon: it holds the session open
    // and would keep syncing (or exit 4 mid-pass) while the files change.
    try {
        const locks = await acquireDaemonLocks({
            dataDirLockPath: options.paths.lockFile,
            vaultLockPath: vaultLockFile(options.config),
            vaultPath: options.config.vaultPath,
            probe: deps.lockProbe,
            onTakeover: (message) => jsonLog(io, 'warn', 'lock', message),
        });
        try {
            const key = await loadKeyMaterial(env);
            const clientUid = await readClientUid(options.config.dataDir);
            const logger = new Logger(options.config.logLevel, 'pss-daemon');
            const createAuth = deps.createAuth ?? createProtonAuth;
            const auth = await createAuth({ dataDir: options.config.dataDir, key, clientUid, logger, remoteFolderUid: options.config.remoteFolderUid });
            await auth.signOut();
            jsonLog(io, 'info', 'auth', 'Signed out; the stored session is cleared.');
        } finally {
            await releaseLocks(locks);
        }
        return ExitCode.Ok;
    } catch (error) {
        if (error instanceof LockHeldError) {
            jsonLog(io, 'error', 'lock', `The daemon is running; stop it before signing out. ${error.message}`);
            return ExitCode.AlreadyRunning;
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export type VerifyReport = {
    checked: number;
    matched: number;
    missingLocal: string[];
    hashMismatch: string[];
    untrackedLocal: string[];
    remoteMissing: string[];
    remoteMismatch: string[];
    /** On Drive but in no record: new from another device, not divergence. */
    untrackedRemote: string[];
    remoteUnverifiable: number;
    remoteSkipped: boolean;
};

/**
 * Compare local files and (optionally) remote files against state records.
 * Pure: the caller gathers the three maps, this only diffs them. Caps are
 * applied by the caller when printing, not here.
 */
export function diffRecords(
    local: Map<string, { hash: string; size: number }>,
    records: Map<string, { hash?: string; size?: number; type: 'file' | 'folder' }>,
    remote?: Map<string, { hash?: string; size?: number }>,
): VerifyReport {
    const report: VerifyReport = {
        checked: 0,
        matched: 0,
        missingLocal: [],
        hashMismatch: [],
        untrackedLocal: [],
        remoteMissing: [],
        remoteMismatch: [],
        untrackedRemote: [],
        remoteUnverifiable: 0,
        remoteSkipped: remote === undefined,
    };
    for (const [recordPath, record] of records) {
        if (record.type !== 'file' || record.hash === undefined) {
            continue;
        }
        report.checked += 1;
        const found = local.get(recordPath);
        if (found === undefined) {
            report.missingLocal.push(recordPath);
            continue;
        }
        if (found.hash !== record.hash) {
            report.hashMismatch.push(recordPath);
            continue;
        }
        report.matched += 1;
        if (remote !== undefined) {
            const remoteState = remote.get(recordPath);
            if (remoteState === undefined) {
                report.remoteMissing.push(recordPath);
            } else if (remoteState.hash !== undefined && remoteState.hash !== record.hash) {
                report.remoteMismatch.push(recordPath);
            } else if (remoteState.hash === undefined) {
                // No content digest recorded (uploaded by a client that did
                // not write one): size is the only cheap signal. Absent
                // size too, the path cannot be verified from metadata.
                if (remoteState.size !== undefined && record.size !== undefined && remoteState.size !== record.size) {
                    report.remoteMismatch.push(recordPath);
                } else if (remoteState.size === undefined || record.size === undefined) {
                    report.remoteUnverifiable += 1;
                } else {
                    report.matched += 0;
                }
            }
        }
    }
    for (const localPath of local.keys()) {
        if (!records.has(localPath)) {
            report.untrackedLocal.push(localPath);
        }
    }
    if (remote !== undefined) {
        for (const remotePath of remote.keys()) {
            if (!records.has(remotePath)) {
                report.untrackedRemote.push(remotePath);
            }
        }
    }
    return report;
}

async function hashVaultFiles(vaultPath: string): Promise<Map<string, { hash: string; size: number }>> {
    const found = new Map<string, { hash: string; size: number }>();
    const walk = async (dir: string, prefix: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const vaultRelative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            // The daemon's own lock lives in the vault but never syncs.
            if (vaultRelative === '.proton-sync' || vaultRelative.startsWith('.proton-sync/')) {
                continue;
            }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full, vaultRelative);
            } else if (entry.isFile()) {
                const data = await readFile(full);
                found.set(vaultRelative, { hash: createHash('sha1').update(data).digest('hex'), size: data.length });
            }
        }
    };
    await walk(vaultPath, '');
    return found;
}

async function defaultListRemote(client: ProtonDriveClient, rootUid: string, logger: Logger): Promise<Map<string, { hash?: string; size?: number }>> {
    const tree = await new DriveIO(client, logger).listTree(rootUid, () => true);
    const remote = new Map<string, { hash?: string; size?: number }>();
    for (const [remotePath, remoteState] of tree.files) {
        remote.set(remotePath, { ...(remoteState.hash !== undefined ? { hash: remoteState.hash } : {}), ...(remoteState.size !== undefined ? { size: remoteState.size } : {}) });
    }
    return remote;
}

/**
 * Re-hash both sides against state records and report divergence. Read-only:
 * the state is loaded and closed without a flush, and nothing is written
 * anywhere. Run at quiescence — mid-pass diffs measure scheduling, not
 * correctness.
 */
export async function runVerify(options: {
    config: DaemonConfig;
    paths: DaemonPaths;
    json?: boolean;
    deps?: DaemonDeps;
    io?: DaemonIO;
    env?: NodeJS.ProcessEnv;
}): Promise<ExitCode> {
    const io = options.io ?? defaultIO(options.env);
    const env = options.env ?? io.env;
    const deps = options.deps ?? {};
    const logger = new Logger(options.config.logLevel, 'pss-daemon');
    let vaultStat: Awaited<ReturnType<typeof stat>>;
    try {
        vaultStat = await stat(options.config.vaultPath);
    } catch {
        jsonLog(io, 'error', 'verify', `The vault at ${options.config.vaultPath} does not exist.`);
        return ExitCode.ConfigInvalid;
    }
    if (!vaultStat.isDirectory()) {
        jsonLog(io, 'error', 'verify', `The vault at ${options.config.vaultPath} is not a directory.`);
        return ExitCode.ConfigInvalid;
    }

    // Read-only load: entries are inspected, nothing is mutated, and close()
    // lands before any flush could be scheduled.
    const loadState = deps.loadState ?? (async (loadOptions: { dataDir: string; stateFile: string; logger: Logger }): Promise<StateLike> => {
        const adapter = new DataDirAdapter();
        const real = new SyncState(adapter as unknown as DataAdapter, loadOptions.stateFile, loadOptions.logger, () => undefined);
        await real.load(null, options.config.remoteFolderUid);
        return real;
    });
    let records: Map<string, { hash?: string; size?: number; type: 'file' | 'folder' }>;
    const loadedState = await loadState({ dataDir: options.config.dataDir, stateFile: options.paths.stateFile, logger });
    try {
        if (loadedState.wasLost()) {
            jsonLog(io, 'error', 'verify', 'The sync state could not be read from any copy.');
            return ExitCode.StateLost;
        }
        records = new Map(loadedState.entries().map((entry) => [entry.path, { hash: entry.base?.hash, size: entry.base?.size, type: entry.type }]));
    } finally {
        loadedState.close();
    }

    if (records.size === 0) {
        jsonLog(io, 'info', 'verify', 'No sync state yet; nothing to verify against. Run `once` first.');
        return ExitCode.Ok;
    }

    const local = await hashVaultFiles(options.config.vaultPath);
    let remote: Map<string, { hash?: string; size?: number }> | undefined;
    if (options.config.remoteFolderUid !== null) {
        try {
            const key = await loadKeyMaterial(env);
            const clientUid = await readClientUid(options.config.dataDir);
            const createAuth = deps.createAuth ?? createProtonAuth;
            const auth = await createAuth({ dataDir: options.config.dataDir, key, clientUid, logger, remoteFolderUid: options.config.remoteFolderUid });
            if (await auth.restore()) {
                const listRemote = deps.listRemote ?? defaultListRemote;
                remote = await listRemote(auth.session.getClient(), options.config.remoteFolderUid, logger);
            } else {
                jsonLog(io, 'warn', 'verify', 'Not signed in; verifying the local side against the state only.');
            }
        } catch (error) {
            jsonLog(io, 'warn', 'verify', `Remote check skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const report = diffRecords(local, records, remote);
    const diverged = report.missingLocal.length + report.hashMismatch.length + report.remoteMissing.length + report.remoteMismatch.length;
    const CAP = 50;
    const cap = (paths: string[]): string[] => (options.json === true ? paths : paths.slice(0, CAP));
    const output = {
        checked: report.checked,
        matched: report.matched,
        missingLocal: cap(report.missingLocal),
        hashMismatch: cap(report.hashMismatch),
        untrackedLocal: cap(report.untrackedLocal),
        remoteMissing: cap(report.remoteMissing),
        remoteMismatch: cap(report.remoteMismatch),
        untrackedRemote: cap(report.untrackedRemote),
        remoteUnverifiable: report.remoteUnverifiable,
        remoteSkipped: report.remoteSkipped,
    };
    if (options.json === true) {
        io.stdout(JSON.stringify(output));
    } else if (diverged === 0) {
        jsonLog(io, 'info', 'verify', `Clean: ${report.matched}/${report.checked} records match${remote === undefined ? ' (remote skipped)' : ''}${report.remoteUnverifiable > 0 ? `, ${report.remoteUnverifiable} remote paths unverifiable from metadata` : ''}.`);
    } else {
        jsonLog(io, 'error', 'verify', `Diverged: ${diverged} paths differ from the state.`, output);
    }
    return diverged === 0 ? ExitCode.Ok : ExitCode.ItemFailures;
}
