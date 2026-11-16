/**
 * The headless `App`: Obsidian's indexing rule, the four Vault methods the
 * engine calls for indexed files, the trash, and — through a real `VaultIO` —
 * proof that the engine's read/write/copy/rename/trash paths work against
 * this shim without touching engine code.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { TFile, TFolder } from 'obsidian';

import { Logger } from '../../src/util/logger';
import { VaultIO } from '../../src/sync/vault';
import { createHeadlessVault } from '../src/headlessApp';
import type { VaultEvents } from '../src/ports';

function tempRoot(): string {
    return mkdtempSync(path.join(tmpdir(), 'pss-app-'));
}

function nullEvents(): VaultEvents & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        onChange: (p: string) => void calls.push(`change:${p}`),
        onRename: (o: string, n: string, dir: boolean) => void calls.push(`rename:${o}->${n}:${dir}`),
        onFolderDelete: (p: string) => void calls.push(`folder-delete:${p}`),
    };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string): ArrayBuffer => encoder.encode(text).buffer as ArrayBuffer;

test('configDir passes through; close settles', async () => {
    const root = tempRoot();
    const events = nullEvents();
    try {
        const vault = await createHeadlessVault({
            vaultPath: root,
            configDir: '.obsidian',
            logger: new Logger(),
            events,
        });
        assert.equal(vault.app.vault.configDir, '.obsidian');
        assert.ok(vault.app.vault.adapter !== undefined);
        await vault.close();
        await vault.close();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('getAbstractFileByPath mirrors the indexing rule', async () => {
    const root = tempRoot();
    const events = nullEvents();
    try {
        const vault = await createHeadlessVault({
            vaultPath: root,
            configDir: '.obsidian',
            logger: new Logger(),
            events,
        });
        try {
            const adapter = vault.app.vault.adapter;
            await adapter.writeBinary('note.md', bytes('n'));
            await adapter.writeBinary('.obsidian/app.json', bytes('{}'));
            await adapter.writeBinary('sub/.hidden.md', bytes('h'));
            await adapter.mkdir('folder');

            const lookup = vault.app.vault.getAbstractFileByPath!.bind(vault.app.vault);
            assert.ok(lookup('note.md') instanceof TFile, 'indexed file is a TFile');
            assert.equal(lookup('note.md')?.path, 'note.md');
            assert.ok(lookup('folder') instanceof TFolder, 'indexed folder is a TFolder');
            assert.equal(lookup('missing.md'), null, 'missing path is null');
            assert.equal(lookup('.obsidian/app.json'), null, 'config dir is not indexed');
            assert.equal(lookup('sub/.hidden.md'), null, 'dot-named file is not indexed');
            assert.equal(lookup('.trash/note.md'), null, 'trash is not indexed');
        } finally {
            await vault.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('copy, rename, createBinary and trashFile behave', async () => {
    const root = tempRoot();
    const events = nullEvents();
    try {
        const vault = await createHeadlessVault({
            vaultPath: root,
            configDir: '.obsidian',
            logger: new Logger(),
            events,
        });
        try {
            const { app } = vault;
            const adapter = app.vault.adapter;
            const lookup = app.vault.getAbstractFileByPath!.bind(app.vault);

            const created = await app.vault.createBinary!('a.md', bytes('a'));
            assert.equal(created.path, 'a.md');
            await assert.rejects(app.vault.createBinary!('a.md', bytes('again')), 'create over existing fails');

            const file = lookup('a.md')!;
            await app.vault.copy!(file, 'b.md');
            assert.equal(await adapter.read('b.md'), 'a');
            await assert.rejects(app.vault.copy!(file, 'b.md'), 'copy over existing fails');

            await app.vault.rename!(file, 'moved/a.md');
            assert.equal(await adapter.exists('a.md'), false);
            assert.equal(await adapter.read('moved/a.md'), 'a');

            await app.fileManager.trashFile!(lookup('moved/a.md')!);
            assert.equal(await adapter.exists('moved/a.md'), false);
            assert.equal(await adapter.read('.trash/moved/a.md'), 'a');
            assert.equal(lookup('moved/a.md'), null);
        } finally {
            await vault.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('the engine VaultIO works against the shim: write, state, copy, rename, trash', async () => {
    const root = tempRoot();
    const events = nullEvents();
    try {
        const logger = new Logger();
        const vault = await createHeadlessVault({ vaultPath: root, configDir: '.obsidian', logger, events });
        try {
            // `downloadsDir` null, as the daemon has no plugin folder: temps
            // sit beside their target, exactly the path that must be atomic.
            const io = new VaultIO(vault.app, logger.getLogger('vault'), null);

            const written = await io.writeBinary('notes/n.md', bytes('version one'));
            assert.equal(written.size, 'version one'.length);

            const state = await io.getState('notes/n.md');
            assert.ok(state !== undefined, 'written file has local state');
            assert.equal(state.size, 'version one'.length);

            // Indexed copy and rename go through `app.vault`, not the
            // adapter: the lookup must hand back real TFiles for that.
            await io.copy('notes/n.md', 'notes/copy.md');
            assert.equal(await io.exists('notes/copy.md'), true);
            await io.rename('notes/copy.md', 'notes/renamed.md');
            assert.equal(await io.exists('notes/copy.md'), false);
            assert.equal(await io.exists('notes/renamed.md'), true);

            // Hidden paths go through the adapter even for indexed-looking
            // calls; dot-rule lookups return null so this must not throw.
            await io.writeBinary('.obsidian/app.json', bytes('{}'));
            assert.equal(await io.exists('.obsidian/app.json'), true);

            // Trash of an indexed file lands recoverable, not vaporised.
            await io.trash('notes/renamed.md');
            assert.equal(await io.exists('notes/renamed.md'), false);
            assert.equal(await io.exists('.trash/notes/renamed.md'), true);

            const listing = await io.list(() => true);
            assert.ok(listing.files.includes('notes/n.md'), `listing: ${listing.files}`);
        } finally {
            await vault.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
