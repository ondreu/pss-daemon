/**
 * The watcher: `fs.watch` events become engine callbacks, renames pair by
 * inode, and the rescan catches whatever the events miss. Real-filesystem
 * tests prove the kernel path; injected-factory tests prove the rescan and
 * the pairing-failure path deterministically, without racing inotify.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { VaultEvents } from '../src/ports';
import { startWatcher, type WatcherFactory } from '../src/watcher';

function tempRoot(): string {
    return mkdtempSync(path.join(tmpdir(), 'pss-watcher-'));
}

type Captured = {
    changes: string[];
    renames: Array<[string, string, boolean]>;
    folderDeletes: string[];
};

function capture(): Captured & VaultEvents {
    const changes: string[] = [];
    const renames: Array<[string, string, boolean]> = [];
    const folderDeletes: string[] = [];
    return {
        changes,
        renames,
        folderDeletes,
        onChange: (p: string) => void changes.push(p),
        onRename: (o: string, n: string, dir: boolean) => void renames.push([o, n, dir]),
        onFolderDelete: (p: string) => void folderDeletes.push(p),
    };
}

type Logged = {
    logger: { debug: () => void; info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: () => void };
    infos: unknown[][];
    warns: unknown[][];
};

function logCapture(): Logged {
    const infos: unknown[][] = [];
    const warns: unknown[][] = [];
    return {
        infos,
        warns,
        logger: {
            debug: () => undefined,
            info: (...args: unknown[]) => void infos.push(args),
            warn: (...args: unknown[]) => void warns.push(args),
            error: () => undefined,
        },
    };
}

async function waitFor(condition: () => boolean, what: string, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > ms) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/** A watcher factory that never delivers, until the test drives it by hand. */
function manualFactory(): {
    factory: WatcherFactory;
    listeners: Map<string, (eventType: 'rename' | 'change', filename: string | null) => void>;
} {
    const listeners = new Map<string, (eventType: 'rename' | 'change', filename: string | null) => void>();
    return {
        listeners,
        factory: (dirAbs, listener) => {
            listeners.set(dirAbs, listener);
            return {
                close: () => void listeners.delete(dirAbs),
            };
        },
    };
}

test('emits create, modify and delete for real files', async () => {
    const root = tempRoot();
    const events = capture();
    const logs = logCapture();
    try {
        const handle = await startWatcher({
            root,
            events,
            logger: logs.logger,
            debounceMs: 40,
            renamePairMs: 60,
            rescanSeconds: 0,
        });
        try {
            await fs.writeFile(path.join(root, 'a.md'), 'one');
            await waitFor(() => events.changes.includes('a.md'), 'create of a.md');
            events.changes.length = 0;

            await fs.appendFile(path.join(root, 'a.md'), ' two');
            await waitFor(() => events.changes.includes('a.md'), 'modify of a.md');
            events.changes.length = 0;

            await fs.unlink(path.join(root, 'a.md'));
            await waitFor(() => events.changes.includes('a.md'), 'delete of a.md');
        } finally {
            await handle.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('pairs a same-inode rename instead of delete plus create', async () => {
    const root = tempRoot();
    const events = capture();
    const logs = logCapture();
    try {
        const handle = await startWatcher({
            root,
            events,
            logger: logs.logger,
            debounceMs: 40,
            renamePairMs: 200,
            rescanSeconds: 0,
        });
        try {
            await fs.writeFile(path.join(root, 'a.md'), 'one');
            await waitFor(() => events.changes.includes('a.md'), 'create of a.md');
            events.changes.length = 0;

            await fs.rename(path.join(root, 'a.md'), path.join(root, 'b.md'));
            await waitFor(() => events.renames.length > 0, 'rename of a.md');
            assert.deepEqual(events.renames, [['a.md', 'b.md', false]]);
            assert.ok(!events.changes.includes('b.md'), `no separate create for b.md: ${events.changes}`);
        } finally {
            await handle.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('reports a deleted folder with its files as their own deletions', async () => {
    const root = tempRoot();
    const events = capture();
    const logs = logCapture();
    try {
        const handle = await startWatcher({
            root,
            events,
            logger: logs.logger,
            debounceMs: 40,
            renamePairMs: 60,
            rescanSeconds: 0,
        });
        try {
            await fs.mkdir(path.join(root, 'sub'));
            await fs.writeFile(path.join(root, 'sub', 'n.md'), 'note');
            await waitFor(() => events.changes.includes('sub/n.md'), 'create of sub/n.md');
            events.changes.length = 0;

            await fs.rm(path.join(root, 'sub'), { recursive: true });
            await waitFor(() => events.folderDeletes.includes('sub'), 'folder delete of sub');
            assert.ok(events.changes.includes('sub/n.md'), `child reported too: ${events.changes}`);
        } finally {
            await handle.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('the rescan catches a file created while events are suppressed', async () => {
    const root = tempRoot();
    const events = capture();
    const logs = logCapture();
    const manual = manualFactory();
    try {
        // The factory never fires: from the watcher's side this is identical
        // to the kernel dropping every event.
        const handle = await startWatcher({
            root,
            events,
            logger: logs.logger,
            debounceMs: 30,
            renamePairMs: 30,
            rescanSeconds: 0,
            createWatcher: manual.factory,
        });
        try {
            assert.ok(manual.listeners.has(root), 'root is watched');
            await fs.writeFile(path.join(root, 'late.md'), 'missed');
            await handle.rescan();
            assert.ok(events.changes.includes('late.md'), `rescan reported late.md: ${events.changes}`);

            await fs.unlink(path.join(root, 'late.md'));
            await handle.rescan();
            assert.ok(events.changes.filter((p) => p === 'late.md').length >= 2, 'rescan reported the delete too');
        } finally {
            await handle.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('an unpaired vanish degrades to delete plus create, and says so', async () => {
    const root = tempRoot();
    const events = capture();
    const logs = logCapture();
    const manual = manualFactory();
    try {
        await fs.writeFile(path.join(root, 'gone.md'), 'here');
        const handle = await startWatcher({
            root,
            events,
            logger: logs.logger,
            debounceMs: 30,
            renamePairMs: 50,
            rescanSeconds: 0,
            createWatcher: manual.factory,
        });
        try {
            const fire = manual.listeners.get(root)!;

            // The file is really deleted, but no new inode appears: after the
            // pairing window this must surface as a delete, not vanish.
            await fs.unlink(path.join(root, 'gone.md'));
            fire('rename', 'gone.md');
            await waitFor(() => events.changes.includes('gone.md'), 'delete of gone.md');
            assert.ok(
                logs.infos.some((args) => String(args[0]).includes('gone.md')),
                `pairing failure logged: ${JSON.stringify(logs.infos)}`,
            );

            // And an unrelated create is just a create, not half a rename.
            await fs.writeFile(path.join(root, 'fresh.md'), 'new');
            fire('rename', 'fresh.md');
            await waitFor(() => events.changes.includes('fresh.md'), 'create of fresh.md');
            assert.deepEqual(events.renames, [], 'no rename paired across unrelated paths');
        } finally {
            await handle.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('close flushes the debounced changes; write debris is never reported', async () => {
    const root = tempRoot();
    const events = capture();
    const logs = logCapture();
    const manual = manualFactory();
    try {
        const handle = await startWatcher({
            root,
            events,
            logger: logs.logger,
            debounceMs: 60_000,
            renamePairMs: 30,
            rescanSeconds: 0,
            createWatcher: manual.factory,
        });
        const fire = manual.listeners.get(root)!;

        await fs.writeFile(path.join(root, 'pending.md'), 'p');
        fire('rename', 'pending.md');
        // Debris from an atomic write: tracked, but the engine must not wake.
        await fs.writeFile(path.join(root, '.pending.md.1.2.proton-sync.tmp'), 'p');
        fire('rename', '.pending.md.1.2.proton-sync.tmp');

        await handle.close();
        assert.ok(events.changes.includes('pending.md'), `flushed on close: ${events.changes}`);
        assert.ok(
            !events.changes.some((p) => p.endsWith('.proton-sync.tmp')),
            `debris never reported: ${events.changes}`,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
