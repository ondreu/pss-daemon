/**
 * Single-instance lock: acquire, contend, stale takeover, release.
 * Liveness and boot id are injected so no real pid is ever signalled.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { acquireDaemonLocks, DaemonLock, LockHeldError, releaseLocks, thisLockInfo, type LockProbe } from '../src/lock';

function dir(): string {
    return mkdtempSync(path.join(tmpdir(), 'pss-lock-'));
}

function probe(overrides: Partial<LockProbe> = {}): LockProbe {
    return {
        isAlive: () => false,
        readBootId: () => 'boot-test',
        ...overrides,
    };
}

test('acquire, contend and release', async () => {
    const root = dir();
    try {
        const lockPath = path.join(root, 'daemon.lock');
        const lock = await DaemonLock.acquire(lockPath, { pid: 111, bootId: 'boot-test', startedAt: new Date().toISOString(), vaultPath: '/vault' }, probe());
        const stored = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; vaultPath: string };
        assert.equal(stored.pid, 111);
        assert.equal(stored.vaultPath, '/vault');
        await assert.rejects(
            DaemonLock.acquire(lockPath, { pid: 222, bootId: 'boot-test', startedAt: new Date().toISOString(), vaultPath: '/vault' }, probe({ isAlive: () => true })),
            (error: unknown) => error instanceof LockHeldError && /pid 111/.test(error.message),
        );
        await lock.release();
        assert.equal(existsSync(lockPath), false);
        // Releasing twice is fine.
        await lock.release();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a dead owner is taken over loudly, never silently', async () => {
    const root = dir();
    try {
        const lockPath = path.join(root, 'daemon.lock');
        writeFileSync(lockPath, JSON.stringify({ pid: 999001, bootId: 'boot-test', startedAt: 'old', vaultPath: '/vault' }));
        const reasons: string[] = [];
        const lock = await DaemonLock.acquire(
            lockPath,
            { pid: 222, bootId: 'boot-test', startedAt: new Date().toISOString(), vaultPath: '/vault' },
            probe({ isAlive: (pid) => pid !== 999001 }),
            (message) => reasons.push(message),
        );
        assert.equal(reasons.length, 1);
        assert.match(reasons[0]!, /999001/);
        assert.equal((JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }).pid, 222);
        await lock.release();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('an unreadable lock file is taken over, not trusted', async () => {
    const root = dir();
    try {
        const lockPath = path.join(root, 'daemon.lock');
        writeFileSync(lockPath, 'not-json{{{');
        const reasons: string[] = [];
        const lock = await DaemonLock.acquire(
            lockPath,
            { pid: 222, bootId: 'boot-test', startedAt: new Date().toISOString(), vaultPath: '/vault' },
            probe(),
            (message) => reasons.push(message),
        );
        assert.match(reasons[0]!, /unreadable/);
        await lock.release();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a boot id change takes over even when the pid is alive', async () => {
    const root = dir();
    try {
        const lockPath = path.join(root, 'daemon.lock');
        writeFileSync(lockPath, JSON.stringify({ pid: 4242, bootId: 'boot-old', startedAt: 'old', vaultPath: '/vault' }));
        const reasons: string[] = [];
        // pid 4242 is "alive" now, but it cannot be the owner from the previous boot.
        const lock = await DaemonLock.acquire(
            lockPath,
            { pid: 4242, bootId: 'boot-new', startedAt: new Date().toISOString(), vaultPath: '/vault' },
            probe({ isAlive: () => true, readBootId: () => 'boot-new' }),
            (message) => reasons.push(message),
        );
        assert.match(reasons[0]!, /previous boot/);
        await lock.release();
        // Same boot, live pid: held.
        writeFileSync(lockPath, JSON.stringify({ pid: 4242, bootId: 'boot-new', startedAt: 'old', vaultPath: '/vault' }));
        await assert.rejects(
            DaemonLock.acquire(lockPath, { pid: 1, bootId: 'boot-new', startedAt: new Date().toISOString(), vaultPath: '/vault' }, probe({ isAlive: () => true, readBootId: () => 'boot-new' })),
            LockHeldError,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('acquireDaemonLocks holds both files and releases the first when the second is held', async () => {
    const root = dir();
    try {
        const dataLock = path.join(root, 'data', 'daemon.lock');
        const vaultLock = path.join(root, 'vault', '.proton-sync', 'daemon.lock');
        const locks = await acquireDaemonLocks({ dataDirLockPath: dataLock, vaultLockPath: vaultLock, vaultPath: '/vault', probe: probe() });
        assert.equal(locks.length, 2);
        assert.equal(existsSync(dataLock), true);
        assert.equal(existsSync(vaultLock), true);
        await assert.rejects(acquireDaemonLocks({ dataDirLockPath: dataLock, vaultLockPath: vaultLock, vaultPath: '/vault', probe: probe({ isAlive: () => true }) }), LockHeldError);
        await releaseLocks(locks);
        assert.equal(existsSync(dataLock), false);
        assert.equal(existsSync(vaultLock), false);

        // Second file held by someone live: the first must not be left behind.
        const holder = await DaemonLock.acquire(vaultLock, { pid: 777, bootId: 'boot-test', startedAt: 'x', vaultPath: '/vault' }, probe());
        try {
            await assert.rejects(
                acquireDaemonLocks({ dataDirLockPath: dataLock, vaultLockPath: vaultLock, vaultPath: '/vault', probe: probe({ isAlive: () => true }) }),
                LockHeldError,
            );
            assert.equal(existsSync(dataLock), false);
        } finally {
            await holder.release();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('thisLockInfo carries pid, boot id and vault', () => {
    const info = thisLockInfo('/vault', probe({ readBootId: () => 'boot-9' }));
    assert.equal(info.pid, process.pid);
    assert.equal(info.bootId, 'boot-9');
    assert.equal(info.vaultPath, '/vault');
    assert.ok(Date.parse(info.startedAt) > 0);
});
