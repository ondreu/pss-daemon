/**
 * `resolve-folder` exists because a uid copied from another Proton client can
 * be rejected by this SDK with an "invalid LinkID" API error that looks like a
 * broken account. The command asks the SDK itself, so its output is always a
 * uid the SDK produced. These tests pin the command wiring, not Drive.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ProtonSession } from '../engine/src/proton/session';
import { parseArgs } from '../src/cli';
import { runResolveFolder, type DaemonIO } from '../src/daemon';
import type { CreateProtonAuth } from '../src/ports';
import { ExitCode, type DaemonConfig, type DaemonPaths } from '../src/types';

function tempEnv(): { dir: string; keyFile: string; cleanup: () => void } {
    const dir = mkdtempSync(path.join(tmpdir(), 'pss-resolve-'));
    const keyFile = path.join(dir, 'key.bin');
    writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    return { dir, keyFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function configFor(dir: string): DaemonConfig {
    return {
        vaultPath: path.join(dir, 'vault'),
        configDir: '.obsidian',
        dataDir: path.join(dir, 'data'),
        remoteFolderUid: null,
        conflictPolicy: 'keep-both',
        massDeleteThreshold: 25,
        remotePollSeconds: 60,
        fullSyncOnStartup: true,
        transferConcurrency: 3,
        pairing: null,
        logLevel: 'info',
        metadataCache: 'file',
        logShowsNames: false,
    };
}

function pathsFor(dir: string): DaemonPaths {
    const data = path.join(dir, 'data');
    return {
        configFile: path.join(data, 'daemon.json'),
        sessionFile: path.join(data, 'session.bin'),
        stateFile: path.join(data, 'sync-state.json'),
        cacheFile: path.join(data, 'drive-cache.bin'),
        logFile: path.join(data, 'daemon.log'),
        healthFile: path.join(data, 'status.json'),
        lockFile: path.join(data, 'daemon.lock'),
    };
}

function io(): DaemonIO & { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
        out,
        err,
        env: {},
        stdout: (line: string) => out.push(line),
        stderr: (line: string) => err.push(line),
    };
}

function fakeAuth(resolved: boolean): CreateProtonAuth {
    return async () =>
        ({
            session: {} as ProtonSession,
            cacheStore: null,
            restore: async () => resolved,
            login: async () => undefined,
            resolveFolder: async (spec: string) => ({ uid: 'uid-from-sdk', path: spec }),
            signOut: async () => undefined,
        }) as never;
}

test('parse: resolve-folder takes exactly one path', () => {
    const ok = parseArgs(['resolve-folder', '08-Test/pss-canary']);
    assert.equal(ok.command, 'resolve-folder');
    assert.equal(ok.target, '08-Test/pss-canary');
    assert.equal(ok.error, undefined);

    assert.match(parseArgs(['resolve-folder']).error ?? '', /needs a path/);
    assert.match(parseArgs(['once', 'extra']).error ?? '', /takes no argument/);
});

test('resolve-folder prints the uid the SDK produced', async () => {
    const env = tempEnv();
    try {
        const out = io();
        const code = await runResolveFolder({
            config: configFor(env.dir),
            paths: pathsFor(env.dir),
            target: '08-Test/pss-canary',
            json: true,
            io: out,
            env: { PSS_KEY_FILE: env.keyFile },
            deps: { createAuth: fakeAuth(true) },
        });
        assert.equal(code, ExitCode.Ok);
        assert.deepEqual(JSON.parse(out.out[0]), { uid: 'uid-from-sdk', path: '08-Test/pss-canary' });
    } finally {
        env.cleanup();
    }
});

test('resolve-folder refuses when the session is not signed in', async () => {
    const env = tempEnv();
    try {
        const out = io();
        const code = await runResolveFolder({
            config: configFor(env.dir),
            paths: pathsFor(env.dir),
            target: '08-Test/pss-canary',
            io: out,
            env: { PSS_KEY_FILE: env.keyFile },
            deps: { createAuth: fakeAuth(false) },
        });
        assert.equal(code, ExitCode.SignedOut);
        assert.match(out.err.join('\n'), /not signed in/);
    } finally {
        env.cleanup();
    }
});
