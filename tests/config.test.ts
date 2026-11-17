/**
 * Config defaults, rejections and path validation. Pure checks go through
 * `parseDaemonConfig` (no filesystem); the key file and full load go
 * through temp files. No network, no vault contents needed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
    DEFAULT_DATA_DIR,
    loadDaemonConfig,
    loadKeyMaterial,
    parseDaemonConfig,
    resolveConfigPath,
    resolveDaemonPaths,
    vaultLockFile,
} from '../src/config';
import { DEFAULT_SETTINGS, MIN_POLL_SECONDS } from '../../src/settings';

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { vaultPath: '/vault', ...overrides };
}

test('defaults match the arch doc', () => {
    const { config, warnings } = parseDaemonConfig(minimal());
    assert.equal(warnings.length, 0);
    assert.equal(config.vaultPath, path.resolve('/vault'));
    assert.equal(config.configDir, '.obsidian');
    assert.equal(config.dataDir, DEFAULT_DATA_DIR);
    assert.equal(config.remoteFolderUid, null);
    assert.equal(config.conflictPolicy, 'merge');
    assert.equal(config.massDeleteThreshold, DEFAULT_SETTINGS.massDeleteThreshold);
    assert.equal(config.remotePollSeconds, 60);
    assert.equal(config.transferConcurrency, 3);
    assert.equal(config.pairing, null);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.metadataCache, 'memory');
});

test('massDeleteThreshold default follows DEFAULT_SETTINGS', () => {
    assert.equal(DEFAULT_SETTINGS.massDeleteThreshold, 25);
    const { config } = parseDaemonConfig(minimal());
    assert.equal(config.massDeleteThreshold, 25);
});

test('vaultPath is required and resolved', () => {
    assert.throws(() => parseDaemonConfig({}), /vaultPath/);
    assert.throws(() => parseDaemonConfig(minimal({ vaultPath: '' })), /vaultPath/);
    assert.throws(() => parseDaemonConfig(minimal({ vaultPath: 42 })), /vaultPath/);
    const { config } = parseDaemonConfig(minimal({ vaultPath: 'relative/vault' }));
    assert.equal(config.vaultPath, path.resolve('relative/vault'));
});

test('unknown keys are rejected', () => {
    assert.throws(() => parseDaemonConfig(minimal({ tranferConcurrency: 5 })), /tranferConcurrency/);
    assert.throws(() => parseDaemonConfig(minimal({ secret: 'x' })), /secret/);
});

test('manual and unknown conflict policies are rejected', () => {
    assert.throws(() => parseDaemonConfig(minimal({ conflictPolicy: 'manual' })), /manual/);
    assert.throws(() => parseDaemonConfig(minimal({ conflictPolicy: 'prefer-newest' })), /conflictPolicy/);
    assert.throws(() => parseDaemonConfig(minimal({ conflictPolicy: 'whatever' })), /conflictPolicy/);
    for (const policy of ['keep-both', 'merge', 'prefer-local', 'prefer-remote']) {
        const { config } = parseDaemonConfig(minimal({ conflictPolicy: policy }));
        assert.equal(config.conflictPolicy, policy);
    }
});

test('poll interval floors at MIN_POLL_SECONDS', () => {
    assert.equal(MIN_POLL_SECONDS, 30);
    const low = parseDaemonConfig(minimal({ remotePollSeconds: 20 }));
    assert.equal(low.config.remotePollSeconds, 30);
    assert.equal(low.warnings.length, 1);
    const ok = parseDaemonConfig(minimal({ remotePollSeconds: 120 }));
    assert.equal(ok.config.remotePollSeconds, 120);
    assert.throws(() => parseDaemonConfig(minimal({ remotePollSeconds: 0 })), /remotePollSeconds/);
    assert.throws(() => parseDaemonConfig(minimal({ remotePollSeconds: -5 })), /remotePollSeconds/);
    assert.throws(() => parseDaemonConfig(minimal({ remotePollSeconds: 'fast' })), /remotePollSeconds/);
});

test('thresholds and concurrency are validated', () => {
    assert.throws(() => parseDaemonConfig(minimal({ massDeleteThreshold: -1 })), /massDeleteThreshold/);
    assert.throws(() => parseDaemonConfig(minimal({ massDeleteThreshold: 2.5 })), /massDeleteThreshold/);
    const zero = parseDaemonConfig(minimal({ massDeleteThreshold: 0 }));
    assert.equal(zero.config.massDeleteThreshold, 0);
    assert.throws(() => parseDaemonConfig(minimal({ transferConcurrency: 0 })), /transferConcurrency/);
    assert.throws(() => parseDaemonConfig(minimal({ transferConcurrency: 1.5 })), /transferConcurrency/);
});

test('dataDir must never be the vault or inside it', () => {
    assert.throws(() => parseDaemonConfig(minimal({ vaultPath: '/vault', dataDir: '/vault' })), /must not be the vault/);
    assert.throws(() => parseDaemonConfig(minimal({ vaultPath: '/vault', dataDir: '/vault/data' })), /never be inside/);
    assert.throws(() => parseDaemonConfig(minimal({ vaultPath: '/vault/', dataDir: '/vault/sub/deep' })), /never be inside/);
    // The reverse — the vault living under the data dir — is odd but not corrupting.
    const { config } = parseDaemonConfig(minimal({ vaultPath: '/data/vault', dataDir: '/data' }));
    assert.equal(config.dataDir, path.resolve('/data'));
});

test('pairing, log level, cache and configDir are validated', () => {
    assert.throws(() => parseDaemonConfig(minimal({ pairing: 'merge-theirs' })), /pairing/);
    assert.throws(() => parseDaemonConfig(minimal({ logLevel: 'verbose' })), /logLevel/);
    assert.throws(() => parseDaemonConfig(minimal({ metadataCache: 'redis' })), /metadataCache/);
    assert.throws(() => parseDaemonConfig(minimal({ configDir: 'a/b' })), /configDir/);
    assert.throws(() => parseDaemonConfig(minimal({ configDir: '..' })), /configDir/);
    const { config } = parseDaemonConfig(minimal({ pairing: 'merge', configDir: 'my-config', metadataCache: 'memory' }));
    assert.equal(config.pairing, 'merge');
    assert.equal(config.configDir, 'my-config');
    assert.equal(config.metadataCache, 'memory');
});

test('logShowsNames defaults to redaction and only accepts a boolean', () => {
    assert.equal(parseDaemonConfig(minimal()).config.logShowsNames, false);
    assert.equal(parseDaemonConfig(minimal({ logShowsNames: true })).config.logShowsNames, true);
    assert.throws(() => parseDaemonConfig(minimal({ logShowsNames: 'yes' })), /logShowsNames/);
});

test('resolveConfigPath prefers --config, then PSS_CONFIG, then the default', () => {
    assert.equal(resolveConfigPath('/x.json', { PSS_CONFIG: '/y.json' }), '/x.json');
    assert.equal(resolveConfigPath(undefined, { PSS_CONFIG: '/y.json' }), '/y.json');
    assert.equal(resolveConfigPath(undefined, {}), path.join(DEFAULT_DATA_DIR, 'daemon.json'));
});

test('daemon paths live in the data dir; the vault lock lives in the vault', () => {
    const { config } = parseDaemonConfig(minimal({ vaultPath: '/vault', dataDir: '/data/pss' }));
    const paths = resolveDaemonPaths(config, '/data/pss/daemon.json');
    assert.equal(paths.configFile, '/data/pss/daemon.json');
    assert.equal(paths.stateFile, '/data/pss/sync-state.json');
    assert.equal(paths.sessionFile, '/data/pss/session.bin');
    assert.equal(paths.healthFile, '/data/pss/status.json');
    assert.equal(paths.lockFile, '/data/pss/daemon.lock');
    assert.ok(paths.cacheFile.startsWith('/data/pss/'));
    assert.ok(paths.logFile.startsWith('/data/pss/'));
    assert.equal(vaultLockFile(config), '/vault/.proton-sync/daemon.lock');
});

test('loadDaemonConfig reads a file end to end', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pss-config-'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'pss-config-data-'));
    try {
        const file = path.join(dir, 'daemon.json');
        writeFileSync(file, JSON.stringify({ vaultPath: dir, dataDir, remotePollSeconds: 20 }));
        const loaded = await loadDaemonConfig({ configPath: file, env: {} });
        assert.equal(loaded.config.vaultPath, dir);
        assert.equal(loaded.config.remotePollSeconds, MIN_POLL_SECONDS);
        assert.equal(loaded.warnings.length, 1);
        assert.equal(loaded.configFile, file);
        await assert.rejects(loadDaemonConfig({ configPath: path.join(dir, 'missing.json'), env: {} }), /Could not read/);
        writeFileSync(file, '{ not json');
        await assert.rejects(loadDaemonConfig({ configPath: file, env: {} }), /not valid JSON/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(dataDir, { recursive: true, force: true });
    }
});

test('loadKeyMaterial takes 32 bytes from PSS_KEY_FILE only', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pss-key-'));
    try {
        const keyFile = path.join(dir, 'key');
        // Pin the last byte: loadKeyMaterial tolerates one trailing newline,
        // so a random key ending in 0x0a/0x0d would read back a byte short.
        const pinned = randomBytes(32);
        if (pinned[31] === 0x0a || pinned[31] === 0x0d) {
            pinned[31] = 0x20;
        }
        writeFileSync(keyFile, pinned);
        const key = await loadKeyMaterial({ PSS_KEY_FILE: keyFile });
        assert.equal(key.length, 32);
        // One trailing newline is tolerated (echo without -n).
        const withNewline = randomBytes(32);
        if (withNewline[31] === 0x0a || withNewline[31] === 0x0d) {
            withNewline[31] = 0x20;
        }
        writeFileSync(keyFile, Buffer.concat([withNewline, Buffer.from('\n')]));
        assert.equal((await loadKeyMaterial({ PSS_KEY_FILE: keyFile })).length, 32);
        // Pinned, not random: a random 10-byte buffer ends in 0x0a about once
        // in 256 runs, and the trailing-newline tolerance would then report 9
        // bytes and fail the assertion below at random.
        writeFileSync(keyFile, Buffer.from('0123456789'));
        await assert.rejects(loadKeyMaterial({ PSS_KEY_FILE: keyFile }), /10 bytes/);
        await assert.rejects(loadKeyMaterial({}), /PSS_KEY_FILE is not set/);
        await assert.rejects(loadKeyMaterial({ PSS_KEY_FILE: path.join(dir, 'nope') }), /Could not read/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
