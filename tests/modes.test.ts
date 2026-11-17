/**
 * Owner-only mode regression tests (P1-3).
 *
 * State, status, device ids and lock files carry note names, hashes and
 * error strings: they must be owner-only (0600 files in 0700 dirs) whatever
 * the process umask is. Linux-only: modes are asserted with `fs.stat`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import { DataDirAdapter, readClientUid } from '../src/daemon';
import { writeHealthFile, emptyHealth } from '../src/health';
import { acquireDaemonLocks, releaseLocks } from '../src/lock';

function modeOf(target: string): number {
    return statSync(target).mode & 0o777;
}

test('daemon-owned files are 0600 in 0700 dirs under a permissive umask', async (t) => {
    if (process.platform !== 'linux') {
        t.skip('file modes are only asserted on Linux');
        return;
    }
    const previous = process.umask(0o022);
    const root = mkdtempSync(path.join(tmpdir(), 'pss-modes-'));
    try {
        const dataDir = path.join(root, 'data');
        const adapter = new DataDirAdapter();
        await adapter.write(path.join(dataDir, 'sync-state.json'), '{"version":1}');
        assert.equal(modeOf(dataDir), 0o700, 'data dir');
        assert.equal(modeOf(path.join(dataDir, 'sync-state.json')), 0o600, 'sync-state.json');

        await writeHealthFile(path.join(dataDir, 'status.json'), emptyHealth('idle'));
        assert.equal(modeOf(path.join(dataDir, 'status.json')), 0o600, 'status.json');

        await readClientUid(dataDir);
        assert.equal(modeOf(path.join(dataDir, 'device-id')), 0o600, 'device-id');

        const locks = await acquireDaemonLocks({
            dataDirLockPath: path.join(dataDir, 'daemon.lock'),
            vaultLockPath: path.join(dataDir, 'sub', 'daemon.lock'),
            vaultPath: path.join(root, 'vault'),
        });
        try {
            assert.equal(modeOf(path.dirname(path.join(dataDir, 'daemon.lock'))), 0o700, 'lock dir');
            assert.equal(modeOf(path.join(dataDir, 'daemon.lock')), 0o600, 'lock file');
            assert.equal(modeOf(path.join(dataDir, 'sub', 'daemon.lock')), 0o600, 'vault-side lock file');
        } finally {
            await releaseLocks(locks);
        }
    } finally {
        process.umask(previous);
        rmSync(root, { recursive: true, force: true });
    }
});
