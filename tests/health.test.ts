/**
 * Health file round trip, atomicity and freshness.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { emptyHealth, HealthCorruptError, isHealthFresh, readHealthFile, writeHealthFile, HEALTH_MAX_AGE_MS } from '../src/health';

function dir(): string {
    return mkdtempSync(path.join(tmpdir(), 'pss-health-'));
}

test('round trip preserves every field', async () => {
    const root = dir();
    try {
        const file = path.join(root, 'sub', 'status.json');
        const health = {
            ...emptyHealth('syncing'),
            lastSummary: {
                status: 'syncing' as const,
                lastSyncedAt: 123,
                lastError: null,
                conflicts: 2,
                pending: 3,
                progressFraction: 0.5,
                progress: { done: 1, total: 2 },
                transfer: null,
            },
            pendingConflicts: 2,
            massDeleteHeld: ['a.md', 'b.md'],
            error: null,
            lastPassAt: new Date().toISOString(),
        };
        await writeHealthFile(file, health);
        const back = await readHealthFile(file);
        assert.deepEqual(back, health);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('writes are atomic: no temp residue, missing reads as null', async () => {
    const root = dir();
    try {
        const file = path.join(root, 'status.json');
        assert.equal(await readHealthFile(file), null);
        await writeHealthFile(file, emptyHealth('idle'));
        assert.equal(
            readdirSync(root).filter((name) => name.endsWith('.tmp')).length,
            0,
        );
        await writeHealthFile(file, emptyHealth('idle'));
        assert.equal((await readHealthFile(file))?.state, 'idle');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('corrupt files raise instead of guessing', async () => {
    const root = dir();
    try {
        const { writeFileSync } = await import('node:fs');
        const bad = path.join(root, 'bad.json');
        writeFileSync(bad, '{oops');
        await assert.rejects(readHealthFile(bad), HealthCorruptError);
        const shaped = path.join(root, 'shaped.json');
        writeFileSync(shaped, JSON.stringify({ nope: true }));
        await assert.rejects(readHealthFile(shaped), HealthCorruptError);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('freshness uses the default window and tolerates a little clock skew', () => {
    const now = Date.now();
    assert.equal(isHealthFresh({ updatedAt: new Date(now).toISOString() }, HEALTH_MAX_AGE_MS, now), true);
    assert.equal(isHealthFresh({ updatedAt: new Date(now - HEALTH_MAX_AGE_MS - 1000).toISOString() }, HEALTH_MAX_AGE_MS, now), false);
    assert.equal(isHealthFresh({ updatedAt: new Date(now - 1000).toISOString() }, 500, now), false);
    assert.equal(isHealthFresh({ updatedAt: 'not-a-date' }, HEALTH_MAX_AGE_MS, now), false);
    // The writer's clock a couple of seconds ahead still reads as fresh.
    assert.equal(isHealthFresh({ updatedAt: new Date(now + 2000).toISOString() }, HEALTH_MAX_AGE_MS, now), true);
});

test('a held mass delete survives a round trip', async () => {
    const root = dir();
    try {
        const file = path.join(root, 'status.json');
        await writeHealthFile(file, { ...emptyHealth('mass-delete-held'), massDeleteHeld: ['gone/a.md'] });
        const back = await readHealthFile(file);
        assert.deepEqual(back?.massDeleteHeld, ['gone/a.md']);
        assert.equal(back?.state, 'mass-delete-held');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
