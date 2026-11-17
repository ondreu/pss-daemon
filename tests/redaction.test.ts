/**
 * Log/status redaction regression tests (P1-2).
 *
 * Note names used to land verbatim in the JSONL log and in `status.json`.
 * The contract now: structured note paths are redacted by default (a stable
 * short digest, so logs stay correlatable without naming anything), counters
 * stay untouched, and `--show-names` (`logShowsNames` in daemon.json) opts
 * back into plaintext.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ProtonDriveClient } from '@protontech/drive-sdk';
import type { App } from 'obsidian';

import { parseDaemonConfig, resolveDaemonPaths } from '../src/config';
import { runDaemon, runVerify, type AuthLike, type DaemonDeps, type DaemonIO, type EngineLike, type StateLike } from '../src/daemon';
import type { HeadlessVault } from '../src/ports';
import type { SyncPlan, SyncSummary } from '../engine/src/sync/engine';
import type { SyncRecord } from '../engine/src/sync/types';
import { ExitCode, type DaemonConfig, type DaemonPaths } from '../src/types';

const SECRET = 'TopSecret-Note-XYZ-7';

type TempEnv = { root: string; vault: string; data: string; env: { PSS_KEY_FILE: string }; cleanup: () => void };

function tempEnv(): TempEnv {
    const root = mkdtempSync(path.join(tmpdir(), 'pss-redact-'));
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

function baseConfig(env: TempEnv, overrides: Record<string, unknown> = {}): { config: DaemonConfig; paths: DaemonPaths } {
    const { config } = parseDaemonConfig({ vaultPath: env.vault, dataDir: env.data, remoteFolderUid: 'root-1', ...overrides });
    return { config, paths: resolveDaemonPaths(config, path.join(env.data, 'daemon.json')) };
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

function fakeEngine(summary: SyncSummary): EngineLike {
    return {
        async start(): Promise<void> {},
        async stop(): Promise<void> {},
        async syncNow(): Promise<void> {},
        getSummary: (): SyncSummary => summary,
        pendingMassDelete: () => summary.pendingMassDelete,
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

function fakeState(recordPaths: string[] = [`${SECRET}.md`]): StateLike {
    return {
        async load(): Promise<void> {},
        wasLost: () => false,
        paths: () => recordPaths,
        cursorsFingerprint: () => 'fp',
        entries: () => [],
        async flush(): Promise<void> {},
        close: (): void => undefined,
    };
}

function fakeAuth(): AuthLike {
    const session: AuthLike['session'] = {
        accountEmail: 'daemon@example.com',
        getClient: () => ({}) as unknown as ProtonDriveClient,
        clearCache: async (): Promise<void> => undefined,
        validateCache: async (): Promise<void> => undefined,
        flushCache: async (): Promise<void> => undefined,
        setSessionEndedHandler: (): void => undefined,
    };
    return {
        session,
        restore: async (): Promise<boolean> => true,
        login: async (): Promise<void> => undefined,
        signOut: async (): Promise<void> => undefined,
    };
}

function depsFor(engine: EngineLike, state: StateLike): DaemonDeps {
    const vault: HeadlessVault = { app: {} as unknown as App, close: async (): Promise<void> => undefined };
    return {
        createVault: async () => vault,
        createAuth: async () => fakeAuth(),
        bootstrap: async () => ({ state, engine }),
        openDeviceList: async () => 'ok',
        lockProbe: { isAlive: () => false, readBootId: () => 'boot-test' },
    };
}

function fakeEmitter(): { once(event: string, listener: () => void): unknown; removeListener?: (event: string, listener: () => void) => unknown } {
    return { once: (): void => undefined };
}

test('a default once run writes no plaintext note name to the log or status.json', async () => {
    const env = tempEnv();
    try {
        const { io, stdout } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const summary = baseSummary({
            pendingMassDelete: { count: 2, paths: [`${SECRET}.md`, 'other.md'] },
            transfer: { path: `${SECRET}.md`, direction: 'upload', bytes: 1, total: 2 },
        });
        const code = await runDaemon({ config, paths, mode: 'once', deps: depsFor(fakeEngine(summary), fakeState()), io, env: env.env, emitter: fakeEmitter() });
        assert.equal(code, ExitCode.MassDeleteHeld);
        const logged = stdout.join('\n');
        assert.doesNotMatch(logged, new RegExp(SECRET), 'no plaintext note name in the JSONL log');
        // Counters stay useful: the hold count is not redacted away.
        assert.match(logged, /Held 2 deletions/);
        const statusText = readFileSync(paths.healthFile, 'utf8');
        assert.doesNotMatch(statusText, new RegExp(SECRET), 'no plaintext note name in status.json');
        const status = JSON.parse(statusText) as { massDeleteHeld: string[] };
        assert.equal(status.massDeleteHeld.length, 2, 'held-path count untouched');
        for (const entry of status.massDeleteHeld) {
            assert.match(entry, /^<redacted:[0-9a-f]{8}>$/, 'held paths redact to a stable short digest');
        }
        // Stable: the same note always redacts to the same token.
        const again = JSON.parse(statusText) as { massDeleteHeld: string[] };
        assert.deepEqual(again.massDeleteHeld, status.massDeleteHeld);
    } finally {
        env.cleanup();
    }
});

test('show-names opts back into plaintext in the log and status.json', async () => {
    const env = tempEnv();
    try {
        const { io, stdout } = testIO(env.env);
        const { config, paths } = baseConfig(env);
        const summary = baseSummary({ pendingMassDelete: { count: 1, paths: [`${SECRET}.md`] } });
        const code = await runDaemon({
            config,
            paths,
            mode: 'once',
            showNames: true,
            deps: depsFor(fakeEngine(summary), fakeState()),
            io,
            env: env.env,
            emitter: fakeEmitter(),
        });
        assert.equal(code, ExitCode.MassDeleteHeld);
        assert.match(stdout.join('\n'), new RegExp(SECRET), 'opt-in log names the note');
        assert.match(readFileSync(paths.healthFile, 'utf8'), new RegExp(SECRET), 'opt-in status.json names the note');
    } finally {
        env.cleanup();
    }
});

test('logShowsNames in daemon.json is the same opt-in without the flag', async () => {
    const env = tempEnv();
    try {
        const { io, stdout } = testIO(env.env);
        const { config, paths } = baseConfig(env, { logShowsNames: true });
        const summary = baseSummary({ pendingMassDelete: { count: 1, paths: [`${SECRET}.md`] } });
        const code = await runDaemon({ config, paths, mode: 'once', deps: depsFor(fakeEngine(summary), fakeState()), io, env: env.env, emitter: fakeEmitter() });
        assert.equal(code, ExitCode.MassDeleteHeld);
        assert.match(stdout.join('\n'), new RegExp(SECRET));
        assert.match(readFileSync(paths.healthFile, 'utf8'), new RegExp(SECRET));
    } finally {
        env.cleanup();
    }
});

test('verify --json redacts report paths by default and names them with show-names', async () => {
    const secretFile = `${SECRET}.md`;
    for (const showNames of [false, true] as const) {
        const env = tempEnv();
        try {
            // The vault does NOT hold the file, but the state records it:
            // the report diverges via `missingLocal` without needing Drive.
            const { io, stdout } = testIO(env.env);
            const { config, paths } = baseConfig(env);
            const entries: SyncRecord[] = [
                {
                    path: secretFile,
                    type: 'file',
                    nodeUid: 'uid-1',
                    base: { hash: 'abc123', size: 6, localMtime: 1, remoteRevisionUid: 'rev-1' },
                },
            ];
            const state: StateLike = { ...fakeState([secretFile]), entries: () => entries };
            const deps: DaemonDeps = {
                loadState: async () => state,
                lockProbe: { isAlive: () => false, readBootId: () => 'boot-test' },
            };
            const code = await runVerify({ config, paths, json: true, showNames, deps, io, env: env.env });
            assert.equal(code, ExitCode.ItemFailures);
            if (showNames) {
                assert.match(stdout.join('\n'), new RegExp(SECRET));
            } else {
                assert.doesNotMatch(stdout.join('\n'), new RegExp(SECRET), 'verify --json must not name the note by default');
            }
        } finally {
            env.cleanup();
        }
    }
});
