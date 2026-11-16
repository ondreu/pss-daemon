/**
 * The adapter half of the vault layer: whatever `VaultIO` asks of
 * `app.vault.adapter` must work against a real directory, atomically where it
 * counts, and refuse to leave the vault wherever it is asked.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { NodeVaultAdapter } from '../src/nodeAdapter';

function tempRoot(): string {
    return mkdtempSync(path.join(tmpdir(), 'pss-adapter-'));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string): ArrayBuffer => encoder.encode(text).buffer;
const text = (data: ArrayBuffer): string => decoder.decode(data);

test('roundtrip: write, read, stat, list', async () => {
    const root = tempRoot();
    try {
        const adapter = new NodeVaultAdapter(root);
        await adapter.writeBinary('notes/a.md', bytes('hello'));
        assert.equal(text(await adapter.readBinary('notes/a.md')), 'hello');
        assert.equal(await adapter.read('notes/a.md'), 'hello');
        assert.equal(await adapter.exists('notes/a.md'), true);
        assert.equal(await adapter.exists('notes/missing.md'), false);

        const stat = await adapter.stat('notes/a.md');
        assert.equal(stat?.type, 'file');
        assert.equal(stat?.size, 5);

        const top = await adapter.list('');
        assert.deepEqual(top.files, []);
        assert.deepEqual(top.folders, ['notes']);
        const sub = await adapter.list('notes');
        assert.deepEqual(sub.files, ['notes/a.md']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('writeBinary is atomic: a refused rename leaves the old content', async () => {
    const root = tempRoot();
    try {
        const plain = new NodeVaultAdapter(root);
        await plain.writeBinary('note.md', bytes('old content'));

        let refused = 0;
        const faulty = new NodeVaultAdapter(root, {
            failRename: (target) => {
                assert.equal(target, 'note.md');
                refused++;
                return true;
            },
        });
        await assert.rejects(faulty.writeBinary('note.md', bytes('new content')));
        assert.equal(refused, 1);

        // The target still holds exactly the old bytes, and no temporary
        // file — partial or otherwise — was left beside it.
        assert.equal(await plain.read('note.md'), 'old content');
        const listing = await plain.list('');
        assert.ok(
            listing.files.every((file) => !file.endsWith('.proton-sync.tmp')),
            `debris left behind: ${listing.files}`,
        );

        // Without the fault the same write lands.
        const healed = new NodeVaultAdapter(root);
        await healed.writeBinary('note.md', bytes('new content'));
        assert.equal(await healed.read('note.md'), 'new content');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('paths outside the vault are refused, on every method', async () => {
    const root = tempRoot();
    try {
        const adapter = new NodeVaultAdapter(root);
        const escapes = ['../escape.md', 'a/../../escape.md', '..', '/absolute.md', 'a/..'];
        for (const rel of escapes) {
            await assert.rejects(adapter.writeBinary(rel, bytes('x')), `writeBinary ${rel}`);
            await assert.rejects(adapter.read(rel), `read ${rel}`);
            await assert.rejects(adapter.readBinary(rel), `readBinary ${rel}`);
            await assert.rejects(adapter.stat(rel), `stat ${rel}`);
            await assert.rejects(adapter.exists(rel), `exists ${rel}`);
            await assert.rejects(adapter.list(rel), `list ${rel}`);
            await assert.rejects(adapter.mkdir(rel), `mkdir ${rel}`);
            await assert.rejects(adapter.remove(rel), `remove ${rel}`);
            await assert.rejects(adapter.rename(rel, 'elsewhere.md'), `rename from ${rel}`);
            await assert.rejects(adapter.rename('note.md', rel), `rename to ${rel}`);
            await assert.rejects(adapter.copy('note.md', rel), `copy to ${rel}`);
        }
        // Nothing escaped onto the disk next to the vault either.
        assert.equal(await adapter.exists('escape.md'), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('rename, copy, remove and mkdir behave', async () => {
    const root = tempRoot();
    try {
        const adapter = new NodeVaultAdapter(root);
        await adapter.writeBinary('a.md', bytes('a'));
        await adapter.mkdir('empty/nested');

        await adapter.copy('a.md', 'b.md');
        assert.equal(await adapter.read('b.md'), 'a');
        // Copy overwrites at the adapter level; the refusal of an existing
        // destination lives one layer up, in the Vault `copy`.
        await adapter.copy('a.md', 'b.md');

        await adapter.rename('b.md', 'sub/c.md');
        assert.equal(await adapter.exists('b.md'), false);
        assert.equal(await adapter.read('sub/c.md'), 'a');

        await adapter.remove('sub/c.md');
        assert.equal(await adapter.exists('sub/c.md'), false);
        await assert.rejects(adapter.remove('sub/c.md'));

        await adapter.remove('empty');
        assert.equal(await adapter.exists('empty'), false);

        const stat = await adapter.stat('missing.md');
        assert.equal(stat, null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('trashLocal keeps bytes under .trash; trashSystem declines', async () => {
    const root = tempRoot();
    try {
        const adapter = new NodeVaultAdapter(root);
        assert.equal(await adapter.trashSystem('a.md'), false);

        await adapter.writeBinary('a.md', bytes('precious'));
        await adapter.trashLocal('a.md');
        assert.equal(await adapter.exists('a.md'), false);
        assert.equal(await adapter.read('.trash/a.md'), 'precious');

        // A second trash of the same name does not eat the first.
        await adapter.writeBinary('a.md', bytes('newer'));
        await adapter.trashLocal('a.md');
        assert.equal(await adapter.read('.trash/a.md'), 'precious');
        assert.equal(await adapter.read('.trash/a.md.1'), 'newer');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('write options: mtime is honoured; getFullPath stays inside the root', async () => {
    const root = tempRoot();
    try {
        const adapter = new NodeVaultAdapter(root);
        const mtime = Date.now() - 86_400_000;
        await adapter.writeBinary('old.md', bytes('x'), { mtime });
        const stat = await adapter.stat('old.md');
        assert.ok(stat !== null && Math.abs(stat.mtime - mtime) < 2000, `mtime ${stat?.mtime} vs ${mtime}`);

        const full = adapter.getFullPath('sub/note.md');
        assert.equal(full, path.join(root, 'sub', 'note.md'));
        assert.throws(() => adapter.getFullPath('../out.md'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('text write, append and process roundtrip', async () => {
    const root = tempRoot();
    try {
        const adapter = new NodeVaultAdapter(root);
        await adapter.write('n.md', 'one');
        await adapter.append('n.md', ' two');
        assert.equal(await adapter.read('n.md'), 'one two');
        const next = await adapter.process('n.md', (data) => data.toUpperCase());
        assert.equal(next, 'ONE TWO');
        assert.equal(await adapter.read('n.md'), 'ONE TWO');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
