/**
 * The world an integration test runs in: a real `SyncEngine` plus a real
 * `SyncState` on temp dirs, a real headless vault over the vault dir, and the
 * fault-injecting fake Drive as the remote.
 *
 * Nothing here reimplements sync logic. The engine is constructed the same
 * way the daemon builds it (`daemon.ts` `defaultBootstrap`): headless `App`
 * shim, `DESKTOP` environment, plugin defaults narrowed for unattended use.
 * Renames are found by the engine's own full-sync detection rather than by
 * fed watcher events, so every pass is a deliberate `syncNow`, fully
 * deterministic.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import type { DataAdapter } from 'obsidian';
import type { ProtonDriveClient } from '@protontech/drive-sdk';

import { DEFAULT_SETTINGS, type PluginSettings } from '../../../src/settings';
import { SyncEngine, type ConflictEvent, type SyncSummary } from '../../../src/sync/engine';
import { DESKTOP } from '../../../src/sync/engine/types';
import { SyncState } from '../../../src/sync/state';
import { Logger } from '../../../src/util/logger';
import { SYNC_ROOT } from '../../../tests/support/fakes';
import { createHeadlessVault } from '../../src/headlessApp';
import type { HeadlessVault, VaultEvents } from '../../src/ports';
import { FaultDrive } from './faultDrive';

export const SILENT = new Logger('error');

/** `SyncState` needs five file ops over absolute paths; the state lives beside the vault, never in it. */
function stateAdapter(dir: string): DataAdapter {
    const full = (filePath: string) => path.join(dir, ...filePath.split('/'));
    return {
        async exists(filePath: string) {
            try {
                await fs.stat(full(filePath));
                return true;
            } catch {
                return false;
            }
        },
        async read(filePath: string) {
            return fs.readFile(full(filePath), 'utf8');
        },
        async write(filePath: string, text: string) {
            await fs.mkdir(path.dirname(full(filePath)), { recursive: true });
            await fs.writeFile(full(filePath), text, 'utf8');
        },
        async remove(filePath: string) {
            await fs.unlink(full(filePath));
        },
        async rename(oldPath: string, newPath: string) {
            await fs.rename(full(oldPath), full(newPath));
        },
    } as unknown as DataAdapter;
}

function nullEvents(): VaultEvents {
    return {
        onChange: () => undefined,
        onRename: () => undefined,
        onFolderDelete: () => undefined,
    };
}

export type World = {
    vaultDir: string;
    stateDir: string;
    fault: FaultDrive;
    vault: HeadlessVault;
    state: SyncState;
    engine: SyncEngine;
    settings: PluginSettings;
    conflicts: ConflictEvent[];
    summaries: SyncSummary[];
    /** Killed engines whose timers were cancelled but which were never stopped; they hold no handles. */
    abandoned: SyncEngine[];
    /** One full pass, then drain every queued follow-up. */
    sync: () => Promise<void>;
    /** Rebuild state + engine over the same dirs after a simulated kill. */
    rebuildAfterKill: () => Promise<void>;
    close: () => Promise<void>;
};

export async function createWorld(options: { settings?: Partial<PluginSettings> } = {}): Promise<World> {
    const root = mkdtempSync(path.join(tmpdir(), 'pss-int-'));
    const vaultDir = path.join(root, 'vault');
    const stateDir = path.join(root, 'state');
    await fs.mkdir(vaultDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });

    const fault = new FaultDrive();
    const vault = await createHeadlessVault({ vaultPath: vaultDir, configDir: '.obsidian', logger: SILENT, events: nullEvents() });

    const settings: PluginSettings = {
        ...DEFAULT_SETTINGS,
        uploadDebounceMs: 0,
        // Polls never fire mid-test; passes are explicit.
        remotePollSeconds: 3600,
        deviceName: 'harness',
        remoteFolderUid: SYNC_ROOT,
        syncOnStartup: false,
        logShowsNames: false,
        ...options.settings,
    };

    const conflicts: ConflictEvent[] = [];
    const summaries: SyncSummary[] = [];
    const world = {} as World;
    const abandoned: SyncEngine[] = [];

    const buildEngine = async (): Promise<{ state: SyncState; engine: SyncEngine }> => {
        const state = new SyncState(stateAdapter(stateDir), 'sync-state.json', SILENT.getLogger('state'));
        await state.load('me@proton.me', SYNC_ROOT);
        const engine = new SyncEngine(
            vault.app,
            state,
            settings,
            SILENT.getLogger('sync'),
            {
                onChange: (summary) => summaries.push(summary),
                onConflict: (event) => conflicts.push(event),
            },
            { configDir: '.obsidian', pluginDir: null },
            DESKTOP,
        );
        await engine.start(fault.client() as unknown as ProtonDriveClient, SYNC_ROOT);
        return { state, engine };
    };

    const first = await buildEngine();

    const drain = async (): Promise<void> => {
        // `syncNow` resolves with its own pass; the loop below only covers
        // follow-ups the pass queued (debounced batches, folder retries).
        // `setImmediate` yields, never sleeps: nothing here waits on time.
        const engine = world.engine as unknown as { queue: Promise<void> };
        for (let i = 0; i < 200; i++) {
            const before = engine.queue;
            await before.catch(() => undefined);
            await new Promise<void>((resolve) => setImmediate(resolve));
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (engine.queue === before) {
                return;
            }
        }
        throw new Error('Engine queue did not settle');
    };

    Object.assign(world, {
        vaultDir,
        stateDir,
        fault,
        vault,
        abandoned,
        settings,
        conflicts,
        summaries,
        state: first.state,
        engine: first.engine,
        sync: async () => {
            await world.engine.syncNow();
            await drain();
        },
        rebuildAfterKill: async () => {
            // A kill -9 runs no cleanup: cancel this engine's timers (the dead
            // process has none) and drop it without `stop`, which would wait
            // on the pass that died mid-await. Unflushed state is lost, as on
            // a real kill; the new instance loads from disk.
            const dead = world.engine as unknown as {
                polls: { cancel: () => void };
                batcher: { cancel: () => void };
            };
            dead.polls.cancel();
            dead.batcher.cancel();
            abandoned.push(world.engine);
            const next = await buildEngine();
            world.state = next.state;
            world.engine = next.engine;
        },
        close: async () => {
            await world.engine.stop();
            await vault.close();
            rmSync(root, { recursive: true, force: true });
        },
    });
    return world;
}

/** Bytes of a local file, or null when absent. */
export async function localBytes(world: World, rel: string): Promise<Buffer | null> {
    try {
        return await fs.readFile(path.join(world.vaultDir, ...rel.split('/')));
    } catch {
        return null;
    }
}

export async function localText(world: World, rel: string): Promise<string | null> {
    const bytes = await localBytes(world, rel);
    return bytes === null ? null : bytes.toString('utf8');
}

export function remoteBytes(world: World, rel: string): Uint8Array | null {
    const node = world.fault.inner.at(rel);
    return node?.revision ? node.revision.data : null;
}

export function remoteText(world: World, rel: string): string | null {
    const bytes = remoteBytes(world, rel);
    return bytes === null ? null : Buffer.from(bytes).toString('utf8');
}

/** Every local path whose name carries a conflict copy. */
export async function conflictCopies(root: string): Promise<string[]> {
    const { walkFiles } = await import('./treeGen');
    return (await walkFiles(root)).filter((rel) => rel.includes('(conflict '));
}

/** Revision uids the fake Drive holds for a remote path, oldest first. */
export function remoteRevisionUids(world: World, rel: string): string[] {
    const node = world.fault.inner.at(rel);
    return node ? node.history.map((revision) => revision.uid) : [];
}

export async function remoteRevisionBytes(world: World, rel: string, revisionUid: string): Promise<Buffer | null> {
    const node = world.fault.inner.at(rel);
    const revision = node?.history.find((candidate) => candidate.uid === revisionUid);
    return revision ? Buffer.from(revision.data) : null;
}
