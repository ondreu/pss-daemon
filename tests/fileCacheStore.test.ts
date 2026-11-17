import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
    cacheKeyBytes,
    EncryptedEntitiesCache,
    newCacheKey,
    type StoredEntry,
} from '../engine/src/proton/persistentCache';
import { Logger } from '../engine/src/util/logger';
import { FileCacheStore, MAX_CACHE_ENTRIES } from '../src/fileCacheStore';

const SILENT = new Logger('error');
const dir = () => mkdtemp(join(tmpdir(), 'pss-cache-'));
const cacheFile = (d: string) => join(d, 'drive-cache.bin');

const entry = (key: string): StoredEntry => ({ key, iv: 'aXY=', data: 'ZGF0YQ==', tags: [] });

describe('FileCacheStore', () => {
    it('round-trips entries and the marker', async () => {
        const file = cacheFile(await dir());
        const store = new FileCacheStore(file, SILENT);
        await store.write([entry('a'), entry('b')], [], 'cursor-1');
        assert.deepEqual(await store.load(), { entries: [entry('a'), entry('b')], marker: 'cursor-1' });

        // A new instance over the same file sees the same contents.
        assert.deepEqual(await new FileCacheStore(file, SILENT).load(), {
            entries: [entry('a'), entry('b')],
            marker: 'cursor-1',
        });
    });

    it('applies removals and marker updates', async () => {
        const file = cacheFile(await dir());
        const store = new FileCacheStore(file, SILENT);
        await store.write([entry('a'), entry('b')], [], 'cursor-1');
        await store.write([], ['a'], 'cursor-2');
        assert.deepEqual(await store.load(), { entries: [entry('b')], marker: 'cursor-2' });
    });

    it('an empty cache loads as empty', async () => {
        const file = cacheFile(await dir());
        assert.deepEqual(await new FileCacheStore(file, SILENT).load(), { entries: [], marker: null });
    });

    it('tolerates corruption: starts empty instead of throwing', async () => {
        const file = cacheFile(await dir());
        await writeFile(file, '{"version": 1, torn');
        const store = new FileCacheStore(file, SILENT);
        assert.deepEqual(await store.load(), { entries: [], marker: null });
        // And the next write heals the file.
        await store.write([entry('a')], [], 'cursor-1');
        assert.deepEqual(await new FileCacheStore(file, SILENT).load(), {
            entries: [entry('a')],
            marker: 'cursor-1',
        });
    });

    it('tolerates a foreign version the same way', async () => {
        const file = cacheFile(await dir());
        await writeFile(file, JSON.stringify({ version: 2, marker: null, entries: [] }));
        assert.deepEqual(await new FileCacheStore(file, SILENT).load(), { entries: [], marker: null });
    });

    it('bounds the file: drops the least recently written above the cap', async () => {
        const file = cacheFile(await dir());
        const store = new FileCacheStore(file, SILENT);
        const first = Array.from({ length: MAX_CACHE_ENTRIES }, (_, i) => entry(`first-${i}`));
        await store.write(first, [], 'cursor-1');
        // Touch one old entry so it survives, then overflow the file.
        await store.write([entry('first-0')], [], 'cursor-2');
        const extra = Array.from({ length: 10 }, (_, i) => entry(`second-${i}`));
        await store.write(extra, [], 'cursor-3');

        const loaded = await store.load();
        assert.equal(loaded.entries.length, MAX_CACHE_ENTRIES);
        assert.equal(loaded.marker, 'cursor-3');
        const keys = new Set(loaded.entries.map((e) => e.key));
        assert.ok(keys.has('first-0'), 'a rewritten entry counts as recent');
        for (const e of extra) {
            assert.ok(keys.has(e.key));
        }
        assert.ok(!keys.has('first-1'), 'the oldest untouched entry goes first');
    });

    it('clear empties the file', async () => {
        const file = cacheFile(await dir());
        const store = new FileCacheStore(file, SILENT);
        await store.write([entry('a')], [], 'cursor-1');
        await store.clear();
        assert.deepEqual(await store.load(), { entries: [], marker: null });
    });

    it('closes the file and its directory to other users', async function (this: TestContext) {
        if (process.platform !== 'linux' && process.platform !== 'darwin') {
            this.skip('POSIX modes only');
            return;
        }
        const d = await dir();
        const file = join(d, 'nested', 'drive-cache.bin');
        const store = new FileCacheStore(file, SILENT);
        await store.write([entry('a')], [], 'cursor-1');
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        assert.equal((await stat(join(d, 'nested'))).mode & 0o777, 0o700);
    });

    it('persists an EncryptedEntitiesCache between opens, ciphertext only', async () => {
        const file = cacheFile(await dir());
        const rawKey = cacheKeyBytes(newCacheKey());
        const first = await EncryptedEntitiesCache.open(new FileCacheStore(file, SILENT), rawKey, () => 'cursor-1', SILENT);
        await first.setEntity('node-a', '{"name":"Secret plans.md"}', ['nodeParentUid:root']);
        await first.flush();

        const reopened = await EncryptedEntitiesCache.open(
            new FileCacheStore(file, SILENT),
            rawKey,
            () => 'cursor-1',
            SILENT,
        );
        await reopened.validate('cursor-1');
        assert.equal(await reopened.getEntity('node-a'), '{"name":"Secret plans.md"}');

        const raw = await new FileCacheStore(file, SILENT).load();
        assert.ok(raw.entries.length > 0);
        assert.ok(!raw.entries.some((e) => e.data.includes('Secret')));
    });
});
