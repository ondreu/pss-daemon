/**
 * Daemon decision table with injected fakes: no network, no real vault
 * contents beyond temp dirs, no signals on the real process. Each row pins
 * the exit code and the work that must (or must not) have happened.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ProtonDriveClient } from '@protontech/drive-sdk';
import type { App } from 'obsidian';

import { parseDaemonConfig, resolveDaemonPaths } from '../src/config';
import { readHealthFile } from '../src/health';
import {
    diffRecords,
    importStateFile,
    installShutdownHandlers,
    runDaemon,
    runLogin,
    runMassDecision,
    runVerify,
    type AuthLike,
    type DaemonDeps,
    type DaemonIO,
    type EngineLike,
    type SignalEmitter,
    type StateLike,
} from '../src/daemon';
import type { HeadlessVault } from '../src/ports';
import type { SyncPlan, SyncSummary } from '../../src/sync/engine';
import type { SyncRecord } from '../../src/sync/types';
import { ExitCode, type DaemonConfig, type DaemonPaths } from '../src/types';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type TempEnv = {
    root: string;
    vault: string;
    data: string;
    keyFile: string;
    env: { PSS_KEY_FILE: string };
    cleanup: () => void;
};

function tempEnv(): TempEnv {
    const root = mkdtempSync(path.join(tmpdir(), 'pss-daemon-'));
    const vault = path.join(root, 'vault');
    mkdirSync(vault, { recursive: true });
    const data = path.join(root, 'data');
    const keyFile = path.join(root, 'key');
    writeFileSync(keyFile, randomBytes(32));
    return { root, vault, data, keyFile, env: { PSS_KEY_FILE: keyFile }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function testIO(env: NodeJS.ProcessEnv): { io: DaemonIO; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), env }, stdout, stderr };
}

function baseConfig(env: TempEnv, overrides: Record<string, unknown> = {}): { config: DaemonConfig; paths: DaemonPaths } {
    const { config } = parseDaemonConfig({ vaultPath: env.vault, dataDir: env.data, remoteFolderUid: 'root-1', ...overrides });
    return { config, paths: resolveDaemonPaths(config, path.join(env.data, 'daemon.json')) };
}

function fakeEmitter(): SignalEmitter & { emit(event: string): void } {
    const handlers = new Map<string, Array<() => void>>();
    return {
        once(event: string, listener: () => void): void {
            const list = handlers.get(event) ?? [];
            list.push(listener);
            handlers.set(event, list);
        },
        removeListener(event: string, listener: () => void): void {
            handlers.set(event, (handlers.get(event) ?? []).filter((candidate) => candidate !== listener));
        },
        emit(event: string): void {
            for (const listener of [...(handlers.get(event) ?? [])]) {
                listener();
            }
        },
    };
}

function emptyPlan(): SyncPlan {
    return { localFiles: 0, localNotes: 0, remoteFiles: 0, uploads: [], downloads: [], conflicts: [], removals: [], settings: [], held: [], unchanged: 0 };
}

function bothSidesPlan(): SyncPlan {
    return { localFiles: 3, localNotes: 3, remoteFiles: 5, uploads: ['a.md'], downloads: ['b.md'], conflicts: [], removals: [], settings: [], held: [], unchanged: 0 };
}

function baseSummary(overrides: Partial<SyncSummary> = {}): SyncSummary {
    return {
        status: 'idle',
        lastSyncedAt: 1,
        lastError: null,
        conflicts: 0,
        pending: 0,
        progressFraction: 1,
        progress: { done: 1, total: 1 },
        transfer: null,
        ...overrides,
    };
}

function fakeStateFns(options: { lost?: boolean; paths?: string[]; entries?: SyncRecord[] } = {}): {
    state: StateLike;
    loadCalls: Array<{ email: string | null; folder: string | null }>;
    closed: () => boolean;
} {
    const loadCalls: Array<{ email: string | null; folder: string | null }> = [];
    let closed = false;
    const state: StateLike = {
        async load(accountEmail, remoteFolderUid): Promise<void> {
            loadCalls.push({ email: accountEmail, folder: remoteFolderUid });
        },
        wasLost: () => options.lost ?? false,
        paths: () => options.paths ?? ['note.md'],
        cursorsFingerprint: () => 'fp',
        entries: () => options.entries ?? [],
        async flush(): Promise<void> {},
        close: (): void => {
            closed = true;
        },
    };
    return { state, loadCalls, closed: () => closed };
}

function fakeEngineFns(options: {
    summary?: Partial<SyncSummary>;
    held?: { count: number; paths: string[] };
    plan?: SyncPlan;
    onStart?: () => void;
} = {}): {
    engine: EngineLike;
    startCalls: () => number;
    stopCalls: () => number;
    approveCalls: () => number;
    denyCalls: () => number;
    planCalls: () => number;
    lastSettings: () => { conflictPolicy: string } | undefined;
} {
    let startCalls = 0;
    let stopCalls = 0;
    let approveCalls = 0;
    let denyCalls = 0;
    let planCalls = 0;
    let holdCleared = false;
    let lastSettings: { conflictPolicy: string } | undefined;
    const summary = baseSummary(options.summary);
    const heldNow = (): { count: number; paths: string[] } | undefined => (options.held !== undefined && !holdCleared ? options.held : undefined);
    const engine: EngineLike = {
        async start(): Promise<void> {
            startCalls += 1;
            options.onStart?.();
        },
        async stop(): Promise<void> {
            stopCalls += 1;
        },
        async syncNow(): Promise<void> {},
        getSummary: (): SyncSummary => {
            const held = heldNow();
            return held !== undefined ? { ...summary, pendingMassDelete: held } : { ...summary };
        },
        pendingMassDelete: () => heldNow(),
        async approveMassDelete(): Promise<void> {
            approveCalls += 1;
            // The real engine clears the hold as it carries the decision out.
            holdCleared = true;
        },
        async denyMassDelete(): Promise<void> {
            denyCalls += 1;
            holdCleared = true;
        },
        async plan(): Promise<SyncPlan> {
            planCalls += 1;
            return options.plan ?? emptyPlan();
        },
        watchDevices: (): void => undefined,
        updateSettings: (settings): void => {
            lastSettings = { conflictPolicy: settings.conflictPolicy };
        },
        onVaultChange: (): void => undefined,
        onVaultRename: (): void => undefined,
        onVaultFolderDelete: (): void => undefined,
    };
    return {
        engine,
        startCalls: () => startCalls,
        stopCalls: () => stopCalls,
        approveCalls: () => approveCalls,
        denyCalls: () => denyCalls,
        planCalls: () => planCalls,
        lastSettings: () => lastSettings,
    };
}

function fakeAuthFns(options: { restored?: boolean; email?: string | null; throwOnRestore?: boolean } = {}): {
    auth: AuthLike;
    clearCacheCalls: () => number;
    validateCalls: () => string[];
    sessionEndedHandler: () => ((() => void) | null);
    signedOut: () => boolean;
} {
    let clearCacheCalls = 0;
    const validateCalls: string[] = [];
    let handler: (() => void) | null = null;
    let signedOut = false;
    const session: AuthLike['session'] = {
        accountEmail: options.email ?? 'nun@example.com',
        getClient: () => ({}) as unknown as ProtonDriveClient,
        clearCache: async (): Promise<void> => {
            clearCacheCalls += 1;
        },
        validateCache: async (fingerprint: string): Promise<void> => {
            validateCalls.push(fingerprint);
        },
        flushCache: async (): Promise<void> => undefined,
        setSessionEndedHandler: (next): void => {
            handler = next;
        },
    };
    const auth: AuthLike = {
        session,
        restore: async (): Promise<boolean> => {
            if (options.throwOnRestore === true) {
                throw new Error('vault offline');
            }
            return options.restored ?? true;
        },
        login: async (): Promise<void> => {
            throw new Error('no browser in tests');
        },
        signOut: async (): Promise<void> => {
            signedOut = true;
        },
    };
    return { auth, clearCacheCalls: () => clearCacheCalls, validateCalls: () => validateCalls, sessionEndedHandler: () => handler, signedOut: () => signedOut };
}

function fakeVaultFns(): { vault: HeadlessVault; closed: () => boolean } {
    let closed = false;
    return {
        vault: {
            app: {} as unknown as App,
            close: async (): Promise<void> => {
                closed = true;
            },
        },
        closed: () => closed,
    };
}

function depsFor(parts: { state?: StateLike; engine?: EngineLike; auth?: AuthLike; vault?: HeadlessVault; deviceList?: 'ok' | 'removed' }): DaemonDeps {
    const state = parts.state ?? fakeStateFns().state;
    const engine = parts.engine ?? fakeEngineFns().engine;
    const auth = parts.auth ?? fakeAuthFns().auth;
    const vault = parts.vault ?? fakeVaultFns().vault;
    return {
        createVault: async () => vault,
        createAuth: async () => auth,
        bootstrap: async () => ({ state, engine }),
        openDeviceList: async () => parts.deviceList ?? 'ok',
        lockProbe: { isAlive: () => false, readBootId: () => 'boot-test' },
    };
}

// ---------------------------------------------------------------------------
// decision table
// ---------------------------------------------------------------------------

test('clean once exits 0 and releases both locks', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const engine = fakeEngineFns();
        const deps = depsFor({ engine: engine.engine });
        const code = await runDaemon({ config, paths, mode: 'once', deps, io, env: env.env, emitter: fakeEmitter() });
        assert.equal(code, ExitCode.Ok);
        assert.equal(engine.startCalls(), 1);
        assert.equal(engine.stopCalls(), 1);
        const health = await readHealthFile(paths.healthFile);
        assert.equal(health?.state, 'idle');
        assert.equal(existsSync(paths.lockFile), false);
        assert.equal(existsSync(path.join(env.vault, '.proton-sync', 'daemon.lock')), false);
    } finally {
        env.cleanup();
    }
});

test('established state validates the cache; fresh state clears it', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const auth = fakeAuthFns();
        const { config, paths } = baseConfig(env);
        const deps = depsFor({ auth: auth.auth, state: fakeStateFns({ paths: ['a.md'] }).state });
        assert.equal(await runDaemon({ config, paths, mode: 'once', deps, io, env: env.env, emitter: fakeEmitter() }), ExitCode.Ok);
        assert.equal(auth.clearCacheCalls(), 0);
        assert.deepEqual(auth.validateCalls(), ['fp']);

        const auth2 = fakeAuthFns();
        const deps2 = depsFor({ auth: auth2.auth, state: fakeStateFns({ paths: [] }).state });
        assert.equal(await runDaemon({ config, paths, mode: 'once', deps: deps2, io, env: env.env, emitter: fakeEmitter() }), ExitCode.Ok);
        assert.equal(auth2.clearCacheCalls(), 1);
        assert.deepEqual(auth2.validateCalls(), []);
    } finally {
        env.cleanup();
    }
});

test('wasLost exits 6 with zero engine work', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const state = fakeStateFns({ lost: true, paths: [] });
        const auth = fakeAuthFns();
        const engine = fakeEngineFns();
        const deps = depsFor({ state: state.state, auth: auth.auth, engine: engine.engine });
        const code = await runDaemon({ config, paths, mode: 'once', deps, io, env: env.env, emitter: fakeEmitter() });
        assert.equal(code, ExitCode.StateLost);
        assert.equal(engine.startCalls(), 0);
        assert.equal(engine.planCalls(), 0);
        assert.equal(auth.clearCacheCalls(), 0);
        assert.equal(auth.validateCalls().length, 0);
        assert.equal((await readHealthFile(paths.healthFile))?.state, 'error');
    } finally {
        env.cleanup();
    }
});

test('signed out exits 4 before the engine starts', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const auth = fakeAuthFns({ restored: false });
        const engine = fakeEngineFns();
        const deps = depsFor({ auth: auth.auth, engine: engine.engine });
        assert.equal(await runDaemon({ config, paths, mode: 'once', deps, io, env: env.env, emitter: fakeEmitter() }), ExitCode.SignedOut);
        assert.equal(engine.startCalls(), 0);
        assert.equal((await readHealthFile(paths.healthFile))?.state, 'signed-out');
    } finally {
        env.cleanup();
    }
});

test('a session that ends mid-pass exits 4', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const auth = fakeAuthFns();
        const engine = fakeEngineFns({
            onStart: () => {
                auth.sessionEndedHandler()?.();
            },
        });
        const deps = depsFor({ auth: auth.auth, engine: engine.engine });
        assert.equal(await runDaemon({ config, paths, mode: 'once', deps, io, env: env.env, emitter: fakeEmitter() }), ExitCode.SignedOut);
    } finally {
        env.cleanup();
    }
});

test('a held lock exits 5 and never starts the engine', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const liveProbe = { isAlive: () => true, readBootId: () => 'boot-test' };
        const { DaemonLock } = await import('../src/lock');
        const holder = await DaemonLock.acquire(paths.lockFile, { pid: 4242, bootId: 'boot-test', startedAt: new Date().toISOString(), vaultPath: config.vaultPath }, liveProbe);
        try {
            const engine = fakeEngineFns();
            const deps: DaemonDeps = { ...depsFor({ engine: engine.engine }), lockProbe: liveProbe };
            assert.equal(await runDaemon({ config, paths, mode: 'once', deps, io, env: env.env, emitter: fakeEmitter() }), ExitCode.AlreadyRunning);
            assert.equal(engine.startCalls(), 0);
        } finally {
            await holder.release();
        }
    } finally {
        env.cleanup();
    }
});

test('a held mass delete exits 3 with the paths in the health file', async () => {
    const env = tempEnv();
    try {
        const { io, stdout } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const engine = fakeEngineFns({ held: { count: 2, paths: ['gone/a.md', 'gone/b.md'] } });
        const deps = depsFor({ engine: engine.engine });
        assert.equal(await runDaemon({ config, paths, mode: 'once', deps, io, env: env.env, emitter: fakeEmitter() }), ExitCode.MassDeleteHeld);
        assert.deepEqual((await readHealthFile(paths.healthFile))?.massDeleteHeld, ['gone/a.md', 'gone/b.md']);
        assert.match(stdout.join('\n'), /Held 2 deletions/);
    } finally {
        env.cleanup();
    }
});

test('item failures exit 2', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const engine = fakeEngineFns({ summary: { lastError: 'boom' } });
        const deps = depsFor({ engine: engine.engine });
        assert.equal(await runDaemon({ config, paths, mode: 'once', deps, io, env: env.env, emitter: fakeEmitter() }), ExitCode.ItemFailures);
    } finally {
        env.cleanup();
    }
});

test('removed by another device signs out and exits 4', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const auth = fakeAuthFns();
        const engine = fakeEngineFns();
        const deps = depsFor({ auth: auth.auth, engine: engine.engine, deviceList: 'removed' });
        assert.equal(await runDaemon({ config, paths, mode: 'once', deps, io, env: env.env, emitter: fakeEmitter() }), ExitCode.SignedOut);
        assert.equal(auth.signedOut(), true);
        assert.equal(engine.startCalls(), 0);
    } finally {
        env.cleanup();
    }
});

test('missing remote folder exits 7', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env, { remoteFolderUid: null });
        const deps = depsFor({});
        assert.equal(await runDaemon({ config, paths, mode: 'once', deps, io, env: env.env, emitter: fakeEmitter() }), ExitCode.ConfigInvalid);
    } finally {
        env.cleanup();
    }
});

test('first sync of two non-empty sides needs pairing, then honours it', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const fresh = (): StateLike => fakeStateFns({ paths: [] }).state;

        // No pairing anywhere: refuse with usage, before the engine starts.
        const refusing = fakeEngineFns({ plan: bothSidesPlan() });
        assert.equal(
            await runDaemon({ config, paths, mode: 'once', deps: depsFor({ state: fresh(), engine: refusing.engine }), io, env: env.env, emitter: fakeEmitter() }),
            ExitCode.Usage,
        );
        assert.equal(refusing.startCalls(), 0);

        // merge: proceed with the configured policy (no override applied).
        const merging = fakeEngineFns({ plan: bothSidesPlan() });
        assert.equal(
            await runDaemon({ config, paths, mode: 'once', pairing: 'merge', deps: depsFor({ state: fresh(), engine: merging.engine }), io, env: env.env, emitter: fakeEmitter() }),
            ExitCode.Ok,
        );
        assert.equal(merging.startCalls(), 1);
        assert.equal(merging.lastSettings(), undefined);

        // adopt-drive: resolve first-sync collisions towards Drive.
        const adopting = fakeEngineFns({ plan: bothSidesPlan() });
        assert.equal(
            await runDaemon({ config, paths, mode: 'once', pairing: 'adopt-drive', deps: depsFor({ state: fresh(), engine: adopting.engine }), io, env: env.env, emitter: fakeEmitter() }),
            ExitCode.Ok,
        );
        assert.equal(adopting.lastSettings()?.conflictPolicy, 'prefer-remote');

        // Pairing in the config file works without the flag.
        const fromConfig = baseConfig(env, { pairing: 'adopt-vault' });
        const adoptingVault = fakeEngineFns({ plan: bothSidesPlan() });
        assert.equal(
            await runDaemon({ config: fromConfig.config, paths: fromConfig.paths, mode: 'once', deps: depsFor({ state: fresh(), engine: adoptingVault.engine }), io, env: env.env, emitter: fakeEmitter() }),
            ExitCode.Ok,
        );
        assert.equal(adoptingVault.lastSettings()?.conflictPolicy, 'prefer-local');
    } finally {
        env.cleanup();
    }
});

test('an established state skips the pairing gate and the plan', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const engine = fakeEngineFns({ plan: bothSidesPlan() });
        const deps = depsFor({ state: fakeStateFns({ paths: ['old.md'] }).state, engine: engine.engine });
        assert.equal(await runDaemon({ config, paths, mode: 'once', deps, io, env: env.env, emitter: fakeEmitter() }), ExitCode.Ok);
        assert.equal(engine.planCalls(), 0);
    } finally {
        env.cleanup();
    }
});

test('dry-run plans without writing or gating', async () => {
    const env = tempEnv();
    try {
        const { io, stdout } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const engine = fakeEngineFns({ plan: bothSidesPlan() });
        const deps = depsFor({ state: fakeStateFns({ paths: [] }).state, engine: engine.engine });
        assert.equal(await runDaemon({ config, paths, mode: 'once', dryRun: true, deps, io, env: env.env, emitter: fakeEmitter() }), ExitCode.Ok);
        assert.equal(engine.planCalls(), 1);
        assert.equal(engine.startCalls(), 0);
        assert.match(stdout.join('\n'), /dry-run/);
    } finally {
        env.cleanup();
    }
});

test('watch runs until a signal, then drains and exits 0', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const engine = fakeEngineFns();
        const emitter = fakeEmitter();
        const promise = runDaemon({ config, paths, mode: 'watch', deps: depsFor({ engine: engine.engine }), io, env: env.env, emitter, heartbeatMs: 10 });
        const deadline = Date.now() + 5000;
        while (engine.startCalls() === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(engine.startCalls(), 1);
        // The signal may land before watch re-arms its own handlers (the
        // boot handler only drains); repeat until the run settles.
        const nudger = setInterval(() => emitter.emit('SIGTERM'), 5);
        try {
            assert.equal(await promise, ExitCode.Ok);
        } finally {
            clearInterval(nudger);
        }
        assert.equal(engine.stopCalls() >= 1, true);
        assert.equal((await readHealthFile(paths.healthFile))?.state, 'stopped');
        assert.equal(existsSync(paths.lockFile), false);
    } finally {
        env.cleanup();
    }
});

test('watch exits 4 when the session ends', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const auth = fakeAuthFns();
        const engine = fakeEngineFns();
        const emitter = fakeEmitter();
        const promise = runDaemon({ config, paths, mode: 'watch', deps: depsFor({ auth: auth.auth, engine: engine.engine }), io, env: env.env, emitter, heartbeatMs: 10 });
        const deadline = Date.now() + 5000;
        while (engine.startCalls() === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        auth.sessionEndedHandler()?.();
        assert.equal(await promise, ExitCode.SignedOut);
    } finally {
        env.cleanup();
    }
});

test('shutdown handlers: first signal drains, second forces exit 1', async () => {
    const emitter = fakeEmitter();
    let drains = 0;
    let exited: number | null = null;
    const uninstall = installShutdownHandlers({ emitter, exit: (code) => (exited = code), onFirst: () => (drains += 1) });
    emitter.emit('SIGTERM');
    emitter.emit('SIGINT');
    assert.equal(drains, 1);
    assert.equal(exited, 1);
    uninstall();
    emitter.emit('SIGTERM');
    assert.equal(drains, 1);
});

test('approve and deny re-decide through the engine', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const held = { count: 2, paths: ['gone/a.md'] };

        const approver = fakeEngineFns({ held });
        assert.equal(
            await runMassDecision({ config, paths, approve: true, deps: depsFor({ engine: approver.engine }), io, env: env.env, emitter: fakeEmitter() }),
            ExitCode.Ok,
        );
        assert.equal(approver.approveCalls(), 1);

        const denier = fakeEngineFns({ held });
        assert.equal(
            await runMassDecision({ config, paths, approve: false, deps: depsFor({ engine: denier.engine }), io, env: env.env, emitter: fakeEmitter() }),
            ExitCode.Ok,
        );
        assert.equal(denier.denyCalls(), 1);

        const nothing = fakeEngineFns();
        assert.equal(
            await runMassDecision({ config, paths, approve: true, deps: depsFor({ engine: nothing.engine }), io, env: env.env, emitter: fakeEmitter() }),
            ExitCode.Ok,
        );
        assert.equal(nothing.approveCalls(), 0);
    } finally {
        env.cleanup();
    }
});

test('verify compares hashes and reports divergence without mutating', async () => {
    const env = tempEnv();
    try {
        const note = path.join(env.vault, 'note.md');
        writeFileSync(note, 'hello');
        const sha = (text: string): string => createHash('sha1').update(text).digest('hex');
        const entries: SyncRecord[] = [
            { path: 'note.md', nodeUid: 'n1', type: 'file', base: { hash: sha('hello'), size: 5, localMtime: 0, remoteRevisionUid: 'r1' } },
            { path: 'missing.md', nodeUid: 'n2', type: 'file', base: { hash: sha('x'), size: 1, localMtime: 0, remoteRevisionUid: 'r2' } },
        ];
        const loadState = async (): Promise<StateLike> => fakeStateFns({ entries }).state;
        const { config } = baseConfig(env, { remoteFolderUid: null });
        const { paths } = baseConfig(env, { remoteFolderUid: null });
        const { io } = testIO(env.env);
        assert.equal(await runVerify({ config, paths, deps: { loadState, lockProbe: { isAlive: () => false, readBootId: () => 'b' } }, io, env: env.env }), ExitCode.ItemFailures);
        // Only the missing file diverges; note.md matches.
        writeFileSync(note, 'changed!');
        const second = testIO(env.env);
        assert.equal(await runVerify({ config, paths, deps: { loadState, lockProbe: { isAlive: () => false, readBootId: () => 'b' } }, io: second.io, env: env.env }), ExitCode.ItemFailures);
        assert.match(second.stdout.join('\n') + second.stderr.join('\n'), /hashMismatch|Diverged/);
    } finally {
        env.cleanup();
    }
});

test('verify clean when everything matches and remote is skipped', async () => {
    const env = tempEnv();
    try {
        writeFileSync(path.join(env.vault, 'note.md'), 'hello');
        const sha = createHash('sha1').update('hello').digest('hex');
        const entries: SyncRecord[] = [{ path: 'note.md', nodeUid: 'n1', type: 'file', base: { hash: sha, size: 5, localMtime: 0, remoteRevisionUid: 'r1' } }];
        const loadState = async (): Promise<StateLike> => fakeStateFns({ entries }).state;
        const { config, paths } = baseConfig(env, { remoteFolderUid: null });
        const { io, stdout } = testIO(env.env);
        assert.equal(await runVerify({ config, paths, deps: { loadState }, io, env: env.env }), ExitCode.Ok);
        assert.match(stdout.join('\n'), /Clean/);
    } finally {
        env.cleanup();
    }
});

test('verify flags remote divergence through the injected lister', async () => {
    const env = tempEnv();
    try {
        writeFileSync(path.join(env.vault, 'note.md'), 'hello');
        const sha = createHash('sha1').update('hello').digest('hex');
        const entries: SyncRecord[] = [{ path: 'note.md', nodeUid: 'n1', type: 'file', base: { hash: sha, size: 5, localMtime: 0, remoteRevisionUid: 'r1' } }];
        const { config, paths } = baseConfig(env);
        const { io } = testIO(env.env);
        const deps: DaemonDeps = {
            loadState: async () => fakeStateFns({ entries }).state,
            createAuth: async () => fakeAuthFns({ restored: true }).auth,
            listRemote: async () => new Map(),
            lockProbe: { isAlive: () => false, readBootId: () => 'b' },
        };
        assert.equal(await runVerify({ config, paths, deps, io, env: env.env }), ExitCode.ItemFailures);
    } finally {
        env.cleanup();
    }
});

test('diffRecords categorises local and remote divergence', () => {
    const sha = (text: string): string => createHash('sha1').update(text).digest('hex');
    const report = diffRecords(
        new Map([
            ['same.md', { hash: sha('a'), size: 1 }],
            ['edited.md', { hash: sha('b2'), size: 2 }],
            ['extra.md', { hash: sha('c'), size: 1 }],
            ['local-only.md', { hash: sha('e'), size: 1 }],
            ['sizedrec.md', { hash: sha('s'), size: 1 }],
        ]),
        new Map([
            ['same.md', { hash: sha('a'), size: 1, type: 'file' }],
            ['edited.md', { hash: sha('b'), size: 1, type: 'file' }],
            ['gone.md', { hash: sha('d'), size: 1, type: 'file' }],
            ['local-only.md', { hash: sha('e'), size: 1, type: 'file' }],
            ['sizedrec.md', { hash: sha('s'), size: 1, type: 'file' }],
            ['folder', { type: 'folder' }],
        ]),
        new Map([
            ['same.md', { hash: sha('a'), size: 1 }],
            ['edited.md', { hash: sha('b'), size: 1 }],
            ['sized.md', { size: 9 }],
            ['sizedrec.md', { size: 9 }],
        ]),
    );
    assert.deepEqual(report.missingLocal, ['gone.md']);
    assert.deepEqual(report.hashMismatch, ['edited.md']);
    assert.deepEqual(report.untrackedLocal, ['extra.md']);
    // 'gone.md' is missing on both sides — consistent, not a remote loss.
    // 'local-only.md' is on disk and in the state but absent remotely.
    assert.deepEqual(report.remoteMissing, ['local-only.md']);
    // No content digest, but the size disagrees with the record.
    assert.deepEqual(report.remoteMismatch, ['sizedrec.md']);
    // On Drive in no record: new from elsewhere, reported but not divergence.
    assert.deepEqual(report.untrackedRemote, ['sized.md']);
    assert.equal(report.remoteSkipped, false);
    assert.equal(diffRecords(new Map(), new Map()).remoteSkipped, true);
});

test('importStateFile validates before copying', async () => {
    const env = tempEnv();
    try {
        const dest = path.join(env.data, 'sync-state.json');
        const good = path.join(env.root, 'good.json');
        writeFileSync(good, JSON.stringify({ version: 1, records: {}, other: 1 }));
        await importStateFile(good, dest);
        assert.equal(existsSync(dest), true);
        await assert.rejects(importStateFile(good, dest), /Refusing to overwrite/);
        const bad = path.join(env.root, 'bad.json');
        writeFileSync(bad, '{nope');
        await assert.rejects(importStateFile(bad, path.join(env.data, 'x.json')), /not valid JSON/);
        writeFileSync(bad, JSON.stringify({ version: 2, records: {} }));
        await assert.rejects(importStateFile(bad, path.join(env.data, 'x.json')), /not a v1 sync state/);
        await assert.rejects(importStateFile(path.join(env.root, 'missing.json'), path.join(env.data, 'x.json')), /Could not read/);
    } finally {
        env.cleanup();
    }
});

test('login that finds a session reports and exits 0', async () => {
    const env = tempEnv();
    try {
        const { io, stdout } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const auth = fakeAuthFns({ restored: true, email: 'nun@example.com' });
        const code = await runLogin({
            config,
            paths,
            configFile: path.join(env.data, 'daemon.json'),
            deps: { createAuth: async () => auth.auth, lockProbe: { isAlive: () => false, readBootId: () => 'b' } },
            io,
            env: env.env,
            emitter: fakeEmitter(),
        });
        assert.equal(code, ExitCode.Ok);
        assert.match(stdout.join('\n'), /Already signed in/);
        assert.equal(existsSync(paths.lockFile), false);
    } finally {
        env.cleanup();
    }
});

test('login persists pairing into the config file', async () => {
    const env = tempEnv();
    try {
        const configFile = path.join(env.data, 'daemon.json');
        mkdirSync(env.data, { recursive: true });
        writeFileSync(configFile, JSON.stringify({ vaultPath: env.vault, dataDir: env.data, remoteFolderUid: 'root-1' }));
        const { config, paths } = baseConfig(env);
        const auth = fakeAuthFns({ restored: false });
        const fakeLoginAuth: AuthLike = {
            ...auth.auth,
            login: async (onUrl): Promise<void> => {
                onUrl('https://account.proton.me/approve');
            },
        };
        const { io, stdout } = testIO(env.env);
        const code = await runLogin({
            config,
            paths,
            configFile,
            pairing: 'merge',
            deps: { createAuth: async () => fakeLoginAuth, lockProbe: { isAlive: () => false, readBootId: () => 'b' } },
            io,
            env: env.env,
            emitter: fakeEmitter(),
        });
        assert.equal(code, ExitCode.Ok);
        assert.match(stdout.join('\n'), /account\.proton\.me\/approve/);
        const saved = JSON.parse((await import('node:fs')).readFileSync(configFile, 'utf8')) as { pairing: string };
        assert.equal(saved.pairing, 'merge');
    } finally {
        env.cleanup();
    }
});
