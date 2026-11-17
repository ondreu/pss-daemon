/**
 * Torn-heartbeat regression tests (P1-A).
 *
 * The heartbeat rewrite used to be `truncate(0)` + `write`: a concurrent
 * reader could observe the file mid-rewrite and get torn JSON. Worse,
 * `inspect` treated an unreadable payload as stale and took it over — two
 * holders — and the ousted holder's `release()` then deleted the successor's
 * file. These tests pin the fixed contract:
 *
 * - heartbeats never expose a torn payload to concurrent readers;
 * - an unreadable-but-recent lock reads as held (fail closed), never stale;
 * - an unreadable-and-old lock may still be taken over;
 * - `release()` never deletes a lock file it no longer owns.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DaemonLock, LockHeldError, type LockProbe } from '../src/lock';

function dir(): string {
    return mkdtempSync(path.join(tmpdir(), 'pss-lock-torn-'));
}

function probe(overrides: Partial<LockProbe> = {}): LockProbe {
    return {
        isAlive: () => false,
        readBootId: () => 'boot-test',
        ...overrides,
    };
}

function info(pid: number, startedAt: string): { pid: number; bootId: string; startedAt: string; vaultPath: string } {
    return { pid, bootId: 'boot-test', startedAt, vaultPath: '/vault' };
}

test('heartbeat rewrites never expose a torn payload to concurrent readers', async () => {
    const root = dir();
    try {
        const lockPath = path.join(root, 'daemon.lock');
        const holder = await DaemonLock.acquire(lockPath, info(111, new Date().toISOString()), probe(), undefined, { heartbeatMs: 5 });
        try {
            // Four async readers hammering the file: every `await` yields to
            // the event loop, so heartbeats land mid-loop. On the old
            // truncate-then-write code some read always lands between the two
            // syscalls and sees torn JSON.
            const { readFile } = await import('node:fs/promises');
            const deadline = Date.now() + 500;
            let torn = 0;
            let reads = 0;
            const reader = async (): Promise<void> => {
                while (Date.now() < deadline) {
                    reads += 1;
                    let text: string;
                    try {
                        text = await readFile(lockPath, 'utf8');
                    } catch {
                        continue;
                    }
                    try {
                        const parsed = JSON.parse(text) as { pid?: unknown };
                        assert.equal(parsed.pid, 111);
                    } catch {
                        torn += 1;
                    }
                }
            };
            await Promise.all([reader(), reader(), reader(), reader()]);
            assert.ok(reads > 100, `expected a real read loop, got ${reads} reads`);
            assert.equal(torn, 0, `saw ${torn} torn reads out of ${reads}`);
        } finally {
            await holder.release();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a half-written payload with a fresh mtime is held, never taken over', async () => {
    const root = dir();
    try {
        const lockPath = path.join(root, 'daemon.lock');
        const full = JSON.stringify({ ...info(999001, 'old'), heartbeatAt: new Date().toISOString() });
        // The first half of a JSON object: exactly what a reader sees when it
        // lands between truncate and write on the old code path.
        writeFileSync(lockPath, full.slice(0, Math.floor(full.length / 2)));
        await assert.rejects(
            DaemonLock.acquire(lockPath, info(222, new Date().toISOString()), probe()),
            LockHeldError,
            'a torn-but-recent lock must read as held (fail closed)',
        );
        // The victim file is untouched: no takeover happened.
        assert.equal(readFileSync(lockPath, 'utf8'), full.slice(0, Math.floor(full.length / 2)));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a torn payload older than the stale window is still taken over', async () => {
    const root = dir();
    try {
        const lockPath = path.join(root, 'daemon.lock');
        const full = JSON.stringify({ ...info(999001, 'old'), heartbeatAt: new Date(Date.now() - 600_000).toISOString() });
        writeFileSync(lockPath, full.slice(0, Math.floor(full.length / 2)));
        const old = new Date(Date.now() - 600_000);
        utimesSync(lockPath, old, old);
        const reasons: string[] = [];
        const lock = await DaemonLock.acquire(lockPath, info(222, new Date().toISOString()), probe(), (message) => reasons.push(message));
        assert.match(reasons[0], /unreadable/);
        await lock.release();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("an ousted holder's release never deletes the successor's lock", async () => {
    const root = dir();
    try {
        const lockPath = path.join(root, 'daemon.lock');
        const victim = await DaemonLock.acquire(lockPath, info(111, 'victim-start'), probe(), undefined, { heartbeatMs: 0 });
        // Simulate a takeover the victim never noticed: the file now belongs
        // to someone else entirely.
        writeFileSync(lockPath, JSON.stringify({ ...info(222, 'successor-start'), heartbeatAt: new Date().toISOString() }));
        await victim.release();
        assert.equal(
            (JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }).pid,
            222,
            'release() must only unlink a lock file it still owns',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
