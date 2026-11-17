/**
 * `once` heartbeat regression tests (P1-6).
 *
 * A legitimate long first sync used to exceed the 90 s health window: `once`
 * never wrote `syncing`, so the supervisor read it as unhealthy mid-pass and
 * restarted it into a loop. The contract now mirrors watch's progress rule:
 *
 * - `once` writes `syncing` before the pass starts;
 * - the status keeps refreshing while the pass makes progress;
 * - a wedged pass (no progress) is left to go stale, never faked healthy.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ProtonDriveClient } from '@protontech/drive-sdk';
import type { App } from 'obsidian';

import { parseDaemonConfig, resolveDaemonPaths } from '../src/config';
import { isHealthFresh, type HealthFile } from '../src/health';
import { runDaemon, type AuthLike, type DaemonDeps, type DaemonIO, type EngineLike, type StateLike } from '../src/daemon';
import type { HeadlessVault } from '../src/ports';
import type { SyncPlan, SyncSummary } from '../../src/sync/engine';
import { ExitCode, type DaemonConfig, type DaemonPaths } from '../src/types';

type TempEnv = { root: string; vault: string; data: string; env: { PSS_KEY_FILE: string }; cleanup: () => void };

function tempEnv(): TempEnv {
    const root = mkdtempSync(path.join(tmpdir(), 'pss-oncebeat-'));
    const vault = path.join(root, 'vault');
    mkdirSync(vault, { recursive: true });
    const data = path.join(root, 'data');
    const keyFile = path.join(root, 'key');
    const key = Buffer.alloc(32, 7);
    key[31] = 0x20;
    writeFileSync(keyFile, key);
    return { root, vault, data, env: { PSS_KEY_FILE: keyFile }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function testIO(env: NodeJS.ProcessEnv): { io: DaemonIO; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), env }, stdout, stderr };
}

function baseConfig(env: TempEnv): { config: DaemonConfig; paths: DaemonPaths } {
    const { config } = parseDaemonConfig({ vaultPath: env.vault, dataDir: env.data, remoteFolderUid: 'root-1' });
    return { config, paths: resolveDaemonPaths(config, path.join(env.data, 'daemon.json')) };
}

function fakeEmitter(): { once(event: string, listener: () => void): unknown } {
    return { once: (): void => undefined };
}

function baseParts(): { auth: AuthLike; state: StateLike; vault: HeadlessVault } {
    const auth: AuthLike = {
        session: {
            accountEmail: 'daemon@example.com',
            getClient: () => ({}) as unknown as ProtonDriveClient,
            clearCache: async (): Promise<void> => undefined,
            validateCache: async (): Promise<void> => undefined,
            flushCache: async (): Promise<void> => undefined,
            setSessionEndedHandler: (): void => undefined,
        },
        restore: async (): Promise<boolean> => true,
        login: async (): Promise<void> => undefined,
        signOut: async (): Promise<void> => undefined,
    };
    const state: StateLike = {
        async load(): Promise<void> {},
        wasLost: () => false,
        paths: () => ['note.md'],
        cursorsFingerprint: () => 'fp',
        entries: () => [],
        async flush(): Promise<void> {},
        close: (): void => undefined,
    };
    const vault: HeadlessVault = { app: {} as unknown as App, close: async (): Promise<void> => undefined };
    return { auth, state, vault };
}

function blockableEngine(getSummary: () => SyncSummary, onStart: () => void, gate: Promise<void>): EngineLike {
    return {
        async start(): Promise<void> {
            onStart();
            await gate;
        },
        async stop(): Promise<void> {},
        async syncNow(): Promise<void> {},
        getSummary,
        pendingMassDelete: () => undefined,
        async approveMassDelete(): Promise<void> {},
        async denyMassDelete(): Promise<void> {},
        async plan(): Promise<SyncPlan> {
            return { localFiles: 0, localNotes: 0, remoteFiles: 0, uploads: [], downloads: [], conflicts: [], removals: [], settings: [], held: [], unchanged: 0 };
        },
        watchDevices: (): void => undefined,
        updateSettings: (): void => undefined,
        onVaultChange: (): void => undefined,
        onVaultRename: (): void => undefined,
        onVaultFolderDelete: (): void => undefined,
    };
}

function readHealth(healthFile: string): HealthFile {
    return JSON.parse(readFileSync(healthFile, 'utf8')) as HealthFile;
}

test('a progressing once pass keeps status.json fresh until it finishes', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started = false;
        // Every heartbeat tick observes a new summary: progress, so the beat
        // is earned and the file keeps refreshing. After `freeze` (the engine
        // stopping) the summary stays put, like the real engine's.
        let n = 0;
        let live = true;
        let current: SyncSummary = {
            status: 'syncing', lastSyncedAt: 1, lastError: null, conflicts: 0, pending: 0,
            progressFraction: 0.5, progress: { done: 0, total: 10 }, transfer: null,
        };
        const summary = (): SyncSummary => {
            if (live) {
                n += 1;
                current = { ...current, pending: n, progress: { done: n, total: 10 } };
            }
            return current;
        };
        const freeze = (): void => {
            live = false;
        };
        const parts = baseParts();
        const deps: DaemonDeps = {
            createVault: async () => parts.vault,
            createAuth: async () => parts.auth,
            bootstrap: async () => ({ state: parts.state, engine: blockableEngine(summary, () => { started = true; }, gate) }),
            openDeviceList: async () => 'ok',
            lockProbe: { isAlive: () => false, readBootId: () => 'boot-test' },
        };
        const run = runDaemon({ config, paths, mode: 'once', heartbeatMs: 10, deps, io, env: env.env, emitter: fakeEmitter() });
        while (!started) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // The pass is blocked inside engine.start: the only freshness proof
        // can come from the once heartbeat.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const mid = readHealth(paths.healthFile);
        assert.equal(mid.state, 'syncing', 'a live once pass reports syncing, not starting');
        assert.ok(isHealthFresh(mid), 'status stays fresh while the pass progresses');
        const midStamp = mid.updatedAt;
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.notEqual(readHealth(paths.healthFile).updatedAt, midStamp, 'progress keeps refreshing updatedAt');
        // A stopped engine's summary freezes: nothing after the release may
        // publish `syncing` over the terminal write.
        freeze();
        release();
        assert.equal(await run, ExitCode.Ok);
        assert.equal(readHealth(paths.healthFile).state, 'idle', 'a finished pass settles back to idle');
    } finally {
        env.cleanup();
    }
});

test('a wedged once pass writes syncing once, then lets health go stale', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started = false;
        // Frozen summary: no progress, so no further writes after the first.
        const frozen: SyncSummary = {
            status: 'syncing', lastSyncedAt: 1, lastError: null, conflicts: 0, pending: 3,
            progressFraction: 0.5, progress: { done: 1, total: 10 }, transfer: null,
        };
        const parts = baseParts();
        const deps: DaemonDeps = {
            createVault: async () => parts.vault,
            createAuth: async () => parts.auth,
            bootstrap: async () => ({ state: parts.state, engine: blockableEngine(() => frozen, () => { started = true; }, gate) }),
            openDeviceList: async () => 'ok',
            lockProbe: { isAlive: () => false, readBootId: () => 'boot-test' },
        };
        const run = runDaemon({ config, paths, mode: 'once', heartbeatMs: 20, deps, io, env: env.env, emitter: fakeEmitter() });
        while (!started) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        const mid = readHealth(paths.healthFile);
        assert.equal(mid.state, 'syncing', 'even a wedged pass announced itself as syncing at start');
        const stamp = mid.updatedAt;
        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.equal(readHealth(paths.healthFile).updatedAt, stamp, 'no progress means no refresh: the wedge reads as stale, not healthy');
        release();
        assert.equal(await run, ExitCode.Ok);
    } finally {
        env.cleanup();
    }
});
