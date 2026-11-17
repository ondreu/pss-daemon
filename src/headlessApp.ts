/* eslint-disable obsidianmd/no-nodejs-modules, obsidianmd/no-global-this, obsidianmd/prefer-window-timers, obsidianmd/hardcoded-config-path -- Node-only daemon code: it never runs inside Obsidian and is not part of main.js. */
/**
 * The `App` the engine thinks it is running inside, built on a directory.
 *
 * `SyncEngine` takes the whole Obsidian `App` but only ever reaches the
 * vault through `VaultIO`, which touches exactly five things (`docs` section
 * 1, against `src/sync/vault.ts`):
 *
 * - `app.vault.adapter` — every read, write, listing and stat;
 * - `app.vault.getAbstractFileByPath` — null means "not indexed";
 * - `app.vault.copy` (`vault.ts:411`), `app.vault.rename` (`vault.ts:693`)
 *   and `app.vault.createBinary` (`vault.ts:749`) for files Obsidian
 *   indexes, so its cache stays in step;
 * - `app.fileManager.trashFile` (`vault.ts:843`) for deletions the user
 *   chose to be recoverable.
 *
 * This module implements exactly that surface over a `NodeVaultAdapter`, and
 * nothing else: anything the engine does not call is not emulated. The
 * result is cast to `App` at the boundary, because the real `App` carries
 * the entire Obsidian UI with it.
 *
 * Indexing mirrors Obsidian's rule, as `tests/support/fakes.ts` does: any
 * path with a dot-segment (`.obsidian`, `.trash`, `.foo/bar`) is not indexed
 * and lookups return null for it. Unlike the in-memory fake, the index here
 * is the disk itself — `getAbstractFileByPath` stats the path, so an edit
 * made by any program (not just through this object) is visible. That
 * synchronous stat is also what `VaultIO`'s echo accounting reads when it
 * judges whether an event is its own write.
 */
import { lstatSync } from 'node:fs';
import { promises as fs } from 'node:fs';

import { TFile, TFolder, type App, type TAbstractFile } from 'obsidian';

import { NodeVaultAdapter, SymlinkRefusedError } from './nodeAdapter';
import type { CreateHeadlessVault, HeadlessVault } from './ports';
import { startWatcher, watcherExcludedDirs } from './watcher';

/** Whether Obsidian would index this path: no dot-segments. */
function isIndexedPath(path: string): boolean {
    return !path.split('/').some((segment) => segment.startsWith('.'));
}

function fileOf(adapter: NodeVaultAdapter, path: string): TFile {
    // lstat: a symlink is never presented as an indexed file. The adapter
    // refuses links outright, so a link here fails the pass closed instead
    // of uploading the link target's bytes.
    const st = lstatSync(adapter.getFullPath(path));
    if (st.isSymbolicLink()) {
        throw new SymlinkRefusedError(path);
    }
    return Object.assign(new TFile(), {
        path,
        stat: {
            ctime: Math.round(st.ctimeMs),
            mtime: Math.round(st.mtimeMs),
            size: st.size,
        },
    });
}

export const createHeadlessVault: CreateHeadlessVault = async (options): Promise<HeadlessVault> => {
    const { vaultPath, configDir, logger, events, rescanSeconds } = options;

    // A daemon pointed at an empty directory is legitimate (first sync
    // against a populated Drive folder adopts from it); a path that is a
    // file, or cannot be created, is a configuration error, not a vault.
    await fs.mkdir(vaultPath, { recursive: true });
    const rootStat = await fs.stat(vaultPath);
    if (!rootStat.isDirectory()) {
        throw new Error(`Vault path ${JSON.stringify(vaultPath)} is not a directory`);
    }

    const adapter = new NodeVaultAdapter(vaultPath);

    const getAbstractFileByPath = (path: string): TAbstractFile | null => {
        if (!isIndexedPath(path)) {
            return null;
        }
        let st;
        try {
            st = lstatSync(adapter.getFullPath(path));
        } catch {
            return null;
        }
        // A symlink is not an indexed file: the adapter refuses links, and
        // presenting one as a TFile would let the engine read its target.
        if (st.isSymbolicLink()) {
            return null;
        }
        if (st.isFile()) {
            return fileOf(adapter, path);
        }
        if (st.isDirectory()) {
            return Object.assign(new TFolder(), { path });
        }
        return null;
    };

    const vault = {
        adapter,
        configDir,
        getAbstractFileByPath,
        // Copy through the adapter, but refuse an existing destination first,
        // matching Obsidian: `Vault.copy` fails where the adapter overwrites.
        // The engine ensures the parent exists before it calls.
        copy: async (file: TAbstractFile, newPath: string): Promise<TAbstractFile> => {
            if (await adapter.exists(newPath)) {
                throw new Error(`"${newPath}" already exists.`);
            }
            await adapter.copy(file.path, newPath);
            return getAbstractFileByPath(newPath) ?? Object.assign(new TFile(), { path: newPath });
        },
        // `Vault.rename`, unlike the file manager's rename, leaves links
        // alone — the device that renamed already rewrote them, and those
        // edits arrive through the sync. Same contract as Obsidian here.
        rename: async (file: TAbstractFile, newPath: string): Promise<void> => {
            await adapter.rename(file.path, newPath);
        },
        // The engine only calls this for paths it just verified are absent;
        // the existence check makes the race loud instead of a silent
        // overwrite, the way Obsidian's own create does.
        createBinary: async (
            path: string,
            data: ArrayBuffer,
            writeOptions?: { ctime?: number; mtime?: number },
        ): Promise<TFile> => {
            if (await adapter.exists(path)) {
                throw new Error('File already exists.');
            }
            await adapter.writeBinary(path, data, writeOptions);
            return fileOf(adapter, path);
        },
    };

    const fileManager = {
        // No system trash on a headless NAS; `trashLocal` keeps the bytes
        // under `.trash/`, recoverable, which is the same promise the user's
        // "Deleted files" setting makes in Obsidian. Mirrors `VaultIO`'s own
        // fallback order for paths Obsidian does not index.
        trashFile: async (file: TAbstractFile): Promise<void> => {
            if (await adapter.trashSystem(file.path)) {
                return;
            }
            await adapter.trashLocal(file.path);
        },
    };

    const app = { vault, fileManager } as unknown as App;

    const watcher = await startWatcher({
        root: vaultPath,
        events,
        logger,
        rescanSeconds,
        // The engine excludes these too (PathFilter over ALWAYS_EXCLUDED
        // plus the config dir); the watcher must not even walk them.
        excludedDirs: watcherExcludedDirs(configDir),
    });

    return {
        app,
        close: async (): Promise<void> => {
            await watcher.close();
        },
    };
};
