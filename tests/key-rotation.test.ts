/**
 * Key-rotation refusal regression tests (P1-4).
 *
 * A wrong or rotated `PSS_KEY_FILE` used to read as "signed out", and the
 * next `login` silently overwrote the old envelope. The contract now:
 *
 * - an unreadable `session.bin` reports a key mismatch (exit 7, naming the
 *   key file — never Proton) instead of "signed out";
 * - `login` refuses to overwrite it without `--rotate-key` (or `--force`).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ProtonDriveClient } from '@protontech/drive-sdk';
import type { App } from 'obsidian';

import { parseDaemonConfig, resolveDaemonPaths } from '../src/config';
import { runDaemon, runLogin, type AuthLike, type DaemonDeps, type DaemonIO, type EngineLike, type StateLike } from '../src/daemon';
import { FileSlot } from '../src/fileSlot';
import type { HeadlessVault } from '../src/ports';
import type { SyncSummary } from '../../src/sync/engine';
import { ExitCode, type DaemonConfig, type DaemonPaths } from '../src/types';

const WRONG_KEY = Buffer.alloc(32, 9);
WRONG_KEY[31] = 0x20;
const RIGHT_KEY = Buffer.alloc(32, 3);
RIGHT_KEY[31] = 0x20;

type TempEnv = { root: string; vault: string; data: string; keyFile: string; cleanup: () => void };

function tempEnv(): TempEnv {
    const root = mkdtempSync(path.join(tmpdir(), 'pss-keyrot-'));
    const vault = path.join(root, 'vault');
    mkdirSync(vault, { recursive: true });
    const data = path.join(root, 'data');
    const keyFile = path.join(root, 'key');
    writeFileSync(keyFile, WRONG_KEY);
    return { root, vault, data, keyFile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A session envelope sealed with the *right* key; the env points at the wrong one. */
async function sealWithRightKey(dataDir: string): Promise<void> {
    await new FileSlot(path.join(dataDir, 'session.bin'), new Uint8Array(RIGHT_KEY)).write('{"session":"real"}');
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

function signedOutAuth(): AuthLike {
    const session: AuthLike['session'] = {
        accountEmail: null,
        getClient: () => ({}) as unknown as ProtonDriveClient,
        clearCache: async (): Promise<void> => undefined,
        validateCache: async (): Promise<void> => undefined,
        flushCache: async (): Promise<void> => undefined,
        setSessionEndedHandler: (): void => undefined,
    };
    return {
        session,
        // What the real `Credentials.load` does with an unreadable slot:
        // swallows it into "nothing stored".
        restore: async (): Promise<boolean> => false,
        login: async (): Promise<void> => undefined,
        signOut: async (): Promise<void> => undefined,
    };
}

function depsFor(auth: AuthLike): DaemonDeps {
    const vault: HeadlessVault = { app: {} as unknown as App, close: async (): Promise<void> => undefined };
    const engine: EngineLike = {
        async start(): Promise<void> {},
        async stop(): Promise<void> {},
        async syncNow(): Promise<void> {},
        getSummary: (): SyncSummary => ({
            status: 'idle', lastSyncedAt: 1, lastError: null, conflicts: 0, pending: 0,
            progressFraction: 1, progress: { done: 1, total: 1 }, transfer: null,
        }),
        pendingMassDelete: () => undefined,
        async approveMassDelete(): Promise<void> {},
        async denyMassDelete(): Promise<void> {},
        async plan(): Promise<never> {
            throw new Error('must not plan past a key mismatch');
        },
        watchDevices: (): void => undefined,
        updateSettings: (): void => undefined,
        onVaultChange: (): void => undefined,
        onVaultRename: (): void => undefined,
        onVaultFolderDelete: (): void => undefined,
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
    return {
        createVault: async () => vault,
        createAuth: async () => auth,
        bootstrap: async () => ({ state, engine }),
        openDeviceList: async () => 'ok',
        lockProbe: { isAlive: () => false, readBootId: () => 'boot-test' },
    };
}

function fakeEmitter(): { once(event: string, listener: () => void): unknown } {
    return { once: (): void => undefined };
}

test('once with a key that cannot open session.bin exits 7 naming the key file', async () => {
    const env = tempEnv();
    try {
        await sealWithRightKey(env.data);
        const before = readFileSync(path.join(env.data, 'session.bin'));
        const { io, stdout, stderr } = testIO({ PSS_KEY_FILE: env.keyFile });
        const { config, paths } = baseConfig(env);
        const code = await runDaemon({ config, paths, mode: 'once', deps: depsFor(signedOutAuth()), io, env: { PSS_KEY_FILE: env.keyFile }, emitter: fakeEmitter() });
        assert.equal(code, ExitCode.ConfigInvalid);
        const logged = stdout.join('\n') + stderr.join('\n');
        assert.match(logged, /key/i, 'the failure points at the key, not at Proton');
        assert.ok(logged.includes(env.keyFile), 'the message names the key file path');
        assert.doesNotMatch(logged, /signed out|No saved session/i, 'never misreported as signed out');
        assert.deepEqual(readFileSync(path.join(env.data, 'session.bin')), before, 'the old envelope is left alone');
    } finally {
        env.cleanup();
    }
});

test('a missing session.bin still reads as signed out, not as a key mismatch', async () => {
    const env = tempEnv();
    try {
        const { io } = testIO({ PSS_KEY_FILE: env.keyFile });
        const { config, paths } = baseConfig(env);
        const code = await runDaemon({ config, paths, mode: 'once', deps: depsFor(signedOutAuth()), io, env: { PSS_KEY_FILE: env.keyFile }, emitter: fakeEmitter() });
        assert.equal(code, ExitCode.SignedOut);
    } finally {
        env.cleanup();
    }
});

test('login refuses to overwrite an unreadable session.bin without --rotate-key', async () => {
    const env = tempEnv();
    try {
        await sealWithRightKey(env.data);
        const before = readFileSync(path.join(env.data, 'session.bin'));
        let loginCalls = 0;
        const auth = signedOutAuth();
        auth.login = async (): Promise<void> => {
            loginCalls += 1;
        };
        const { io, stdout, stderr } = testIO({ PSS_KEY_FILE: env.keyFile });
        const { config, paths } = baseConfig(env);
        const code = await runLogin({ config, paths, configFile: paths.configFile, deps: depsFor(auth), io, env: { PSS_KEY_FILE: env.keyFile } });
        assert.equal(code, ExitCode.ConfigInvalid);
        assert.equal(loginCalls, 0, 'the web flow must not start when the old envelope is unreadable');
        assert.ok((stdout.join('\n') + stderr.join('\n')).includes(env.keyFile));
        assert.deepEqual(readFileSync(path.join(env.data, 'session.bin')), before, 'refusal overwrites nothing');
    } finally {
        env.cleanup();
    }
});

test('login --rotate-key proceeds past an unreadable session.bin', async () => {
    const env = tempEnv();
    try {
        await sealWithRightKey(env.data);
        let loginCalls = 0;
        const auth = signedOutAuth();
        auth.login = async (): Promise<void> => {
            loginCalls += 1;
        };
        const { io } = testIO({ PSS_KEY_FILE: env.keyFile });
        const { config, paths } = baseConfig(env);
        const code = await runLogin({
            config, paths, configFile: paths.configFile, rotateKey: true, deps: depsFor(auth), io, env: { PSS_KEY_FILE: env.keyFile },
        });
        assert.equal(code, ExitCode.Ok);
        assert.equal(loginCalls, 1, 'the explicit flag re-arms the web flow');
    } finally {
        env.cleanup();
    }
});
