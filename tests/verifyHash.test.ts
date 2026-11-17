/**
 * `verify` must compare the same tree the engine syncs. Before this, a vault
 * that was perfectly in sync still reported every `.git` object as
 * "untracked", so the cutover gate could never pass; after an over-eager fix it
 * reported synced plugin files as "missing". Both directions are pinned here
 * through the real filter the daemon builds.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { PathFilter } from '../../src/sync/paths';
import { hashVaultFiles } from '../src/daemon';

function tree(files: string[]): { root: string; cleanup: () => void } {
    const root = mkdtempSync(path.join(tmpdir(), 'pss-verify-'));
    for (const rel of files) {
        const full = path.join(root, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, rel);
    }
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const files = ['.git/objects/ab/cdef', '.obsidian/app.json', '.obsidian/plugins/x/main.js', 'note.md', 'sub/note.md'];

test('a private folder keeps plugin code, but never .git', async () => {
    const t = tree(files);
    try {
        const filter = new PathFilter([], true, '.obsidian', null, false, false);
        const found = await hashVaultFiles(t.root, (p) => filter.isExcluded(p));
        assert.deepEqual([...found.keys()].sort(), [
            '.obsidian/app.json',
            '.obsidian/plugins/x/main.js',
            'note.md',
            'sub/note.md',
        ]);
    } finally {
        t.cleanup();
    }
});

test('a shared folder excludes plugin code and community-plugins.json', async () => {
    const t = tree(files);
    try {
        const filter = new PathFilter([], true, '.obsidian', null, true, false);
        const found = await hashVaultFiles(t.root, (p) => filter.isExcluded(p));
        assert.deepEqual([...found.keys()].sort(), ['.obsidian/app.json', 'note.md', 'sub/note.md']);
    } finally {
        t.cleanup();
    }
});
