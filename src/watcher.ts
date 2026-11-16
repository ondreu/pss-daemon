/**
 * The daemon's replacement for Obsidian's vault events.
 *
 * The plugin learns about local edits from `vault.on('create' | 'modify' |
 * 'delete' | 'rename')` (wired in `main.ts:1326-1344`); outside Obsidian there
 * is no such feed, so this module builds one from the filesystem. It maps onto
 * the three engine entry points the plugin uses:
 *
 * - file created, modified or deleted → `events.onChange(path)`, exactly as
 *   `main.ts` maps both `create`/`modify` and a file `delete` onto
 *   `engine.onVaultChange`;
 * - folder deleted → `events.onFolderDelete(path)`, plus one `onChange` for
 *   every file known to have been inside it (Obsidian fires a `delete` per
 *   child, and the engine expects the files to arrive as their own deletions);
 * - rename → `events.onRename(oldPath, newPath, isFolder)`, with the folder
 *   itself followed by every file inside it, the way Obsidian reports a
 *   folder move.
 *
 * Two sources feed those callbacks. `fs.watch`, one watcher per directory
 * (portable — recursive watching is not offered on every platform Node runs
 * on), is the primary one; a full rescan on an interval (default 15 minutes,
 * the backstop for overflowed or dropped events from failure #9) is the other.
 * Anything the watcher cannot pair — a vanished path whose inode never
 * reappears — degrades to delete-plus-create and is logged, never silently
 * dropped: a missed event reads as a stall, and stalls are what the rescan
 * exists to bound.
 *
 * Rename pairing works by inode (`dev:ino`), because `fs.watch` only ever
 * names the new path: a path that vanishes while its inode reappears
 * elsewhere within a short window is a rename, not a delete plus a create.
 * The window is short on purpose — a real rename's two halves arrive
 * together — and anything still unpaired when it lapses is reported as a
 * deletion so the engine can scan it as one.
 *
 * Deliberately not filtered here: the engine already drops whatever its
 * `PathFilter` excludes (`onVaultChange` checks `isExcludedWithAncestors`
 * first), and duplicating that list would let the two drift apart. The only
 * exception is the daemon's own atomic-write debris (`*.proton-sync.tmp`),
 * which every save briefly creates beside its target; reporting those would
 * wake the engine twice per write for paths it ignores anyway.
 */
import { promises as fs, lstatSync, watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';

import { ALWAYS_EXCLUDED } from '../../src/settings';
import type { Logger } from '../../src/util/logger';
import type { VaultEvents } from './ports';

type Log = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

/** One live `fs.watch`, closed when its directory goes away. */
export type DirWatcher = {
    close(): void;
};

/**
 * How a directory gets watched. The default is `fs.watch`; tests inject a
 * fake that never fires, which is exactly "events suppressed", so the rescan
 * backstop can be proven without racing the kernel.
 */
export type WatcherFactory = (
    dirAbs: string,
    listener: (eventType: 'rename' | 'change', filename: string | null) => void,
    onError: (error: Error) => void,
) => DirWatcher;

export type WatcherOptions = {
    /** Absolute path of the vault directory. */
    root: string;
    events: VaultEvents;
    logger: Log;
    /**
     * Vault-relative directories the watcher never walks or watches
     * (`.git`, `.trash`, the config dir, the daemon's own `.proton-sync`):
     * churn there never reaches the engine, and one inotify-exhausted
     * directory no longer degrades the whole tree to warn-only. Defaults to
     * {@link watcherExcludedDirs} of `'.obsidian'`; pass an explicit list
     * when the vault's config dir differs.
     */
    excludedDirs?: string[];
    /**
     * How long to collect changes before reporting them, in milliseconds.
     * Mirrors the plugin's `uploadDebounceMs` semantics: a burst of saves
     * becomes one scan, not one per keystroke. Default 2000.
     */
    debounceMs?: number;
    /**
     * How often a full rescan runs as a backstop to missed watcher events, in
     * seconds. Default 900 (15 minutes, per the design doc). Zero disables
     * the periodic rescan; `rescan()` stays available.
     */
    rescanSeconds?: number;
    /**
     * How long a vanished path waits for its inode to reappear elsewhere
     * before it is reported as a deletion, in milliseconds. Default 1000.
     */
    renamePairMs?: number;
    /** Injected for tests; defaults to `fs.watch`. */
    createWatcher?: WatcherFactory;
};

export type WatcherHandle = {
    /** Stop watching, flush any debounced changes, and settle. */
    close(): Promise<void>;
    /** Walk the whole vault now and report whatever the events missed. */
    rescan(): Promise<void>;
};

type KnownFile = {
    /** `dev:ino`, the identity a rename carries across paths. */
    key: string;
    isDir: boolean;
    mtimeMs: number;
    size: number;
};

type PendingGone = {
    key: string;
    isDir: boolean;
    timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_RESCAN_SECONDS = 900;
const DEFAULT_RENAME_PAIR_MS = 1000;

/** Basenames the watcher tracks but never reports: atomic-write debris. */
function isWriteDebris(basename: string): boolean {
    return basename.endsWith('.proton-sync.tmp');
}

/**
 * Vault-relative directories the watcher prunes from every walk and watch:
 * the engine's {@link ALWAYS_EXCLUDED} directory entries (`.git`, `.trash`),
 * the daemon's own `.proton-sync` lock dir, and the Obsidian config dir
 * (default `.obsidian`), whose churn the engine excludes as well.
 */
export function watcherExcludedDirs(configDir = '.obsidian'): string[] {
    const dirs = new Set<string>(['.proton-sync', configDir]);
    for (const pattern of ALWAYS_EXCLUDED) {
        const dir = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern.endsWith('/') ? pattern.slice(0, -1) : null;
        if (dir !== null && dir !== '' && !dir.includes('*')) {
            dirs.add(dir);
        }
    }
    return [...dirs];
}

function defaultFactory(
    dirAbs: string,
    listener: (eventType: 'rename' | 'change', filename: string | null) => void,
    onError: (error: Error) => void,
): DirWatcher {
    const watcher: FSWatcher = fsWatch(dirAbs, (eventType, filename) => {
        listener(eventType, (filename) ?? null);
    });
    watcher.on('error', onError);
    return watcher;
}

export async function startWatcher(options: WatcherOptions): Promise<WatcherHandle> {
    const { root, events, logger } = options;
    const excludedDirs = options.excludedDirs ?? watcherExcludedDirs();
    const isExcludedRel = (rel: string): boolean =>
        rel !== '' && excludedDirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const rescanSeconds = options.rescanSeconds ?? DEFAULT_RESCAN_SECONDS;
    const renamePairMs = options.renamePairMs ?? DEFAULT_RENAME_PAIR_MS;
    const createWatcher = options.createWatcher ?? defaultFactory;

    // Vault-relative path ('a/b') → what the last walk or event saw there.
    const known = new Map<string, KnownFile>();
    const watchers = new Map<string, DirWatcher>();
    // Changed files waiting out the debounce window.
    const dirty = new Set<string>();
    // Vanished paths waiting to see if their inode reappears as a rename.
    const pendingGone = new Map<string, PendingGone>();
    // Symlink paths already warned about; the walk logs each link once.
    const symlinkWarned = new Set<string>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let rescanTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const absOf = (rel: string): string => path.join(root, ...rel.split('/'));
    const relOf = (abs: string): string => path.relative(root, abs).split(path.sep).join('/');

    function reportChange(rel: string): void {
        if (isWriteDebris(path.basename(rel))) {
            return;
        }
        try {
            events.onChange(rel);
        } catch (error) {
            logger.warn(`Watcher callback for "${rel}" threw`, error);
        }
    }

    function scheduleFlush(): void {
        if (closed || debounceTimer !== null) {
            return;
        }
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            const paths = [...dirty];
            dirty.clear();
            for (const rel of paths) {
                reportChange(rel);
            }
        }, debounceMs);
        debounceTimer.unref?.();
    }

    function noteChanged(rel: string): void {
        dirty.add(rel);
        scheduleFlush();
    }

    async function statRel(rel: string): Promise<KnownFile | null> {
        let st;
        try {
            // lstat: a symlink is never followed. One reads as vanished here,
            // which reports a delete — and the adapter refuses the link
            // outright, so the pass fails closed instead of syncing the
            // link's target. See the adapter's SymlinkRefusedError.
            st = await fs.lstat(absOf(rel));
        } catch {
            return null;
        }
        if (st.isSymbolicLink()) {
            return null;
        }
        return {
            key: `${st.dev}:${st.ino}`,
            isDir: st.isDirectory(),
            mtimeMs: st.mtimeMs,
            size: st.size,
        };
    }

    function unwatchDir(abs: string): void {
        watchers.get(abs)?.close();
        watchers.delete(abs);
    }

    function onWatcherError(error: Error): void {
        if (closed) {
            return;
        }
        // An overflowed or failed watcher has an unknown gap behind it; the
        // rescan closes it now instead of at the next interval.
        logger.warn('Filesystem watcher reported an error; running a rescan to close the gap', error);
        void rescan();
    }

    // One listener per watched directory: `fs.watch` reports the basename
    // within the watched directory, not the full path, so the directory must
    // come from the closure. The `void` calls below are deliberate — an event
    // being stat-ed must not hold up the events queuing behind it.
    function listenFor(dirAbs: string): (eventType: 'rename' | 'change', filename: string | null) => void {
        return (eventType, filename) => {
            if (closed) {
                return;
            }
            if (filename === null) {
                logger.warn('Filesystem watcher lost an event name; running a rescan to close the gap');
                void rescan();
                return;
            }
            void handleInDir(dirAbs, eventType, filename);
        };
    }

    function watchDirAt(dirAbs: string): void {
        if (closed || watchers.has(dirAbs)) {
            return;
        }
        // Excluded trees are never watched: their churn is the engine's to
        // ignore, and watching them only spends inotify instances on it.
        if (relOf(dirAbs) !== '' && isExcludedRel(relOf(dirAbs))) {
            return;
        }
        try {
            watchers.set(dirAbs, createWatcher(dirAbs, listenFor(dirAbs), onWatcherError));
        } catch (error) {
            logger.warn(`Could not watch "${relOf(dirAbs)}"; the rescan backstop covers it`, error);
        }
    }

    async function handleInDir(dirAbs: string, eventType: 'rename' | 'change', filename: string): Promise<void> {
        const rel = relOf(path.join(dirAbs, filename));
        if (isExcludedRel(rel)) {
            return;
        }
        if (eventType === 'change') {
            const info = await statRel(rel);
            if (info === null) {
                // Deleted between the modify and this read: handle as gone.
                handleVanished(rel);
                return;
            }
            if (info.isDir) {
                return;
            }
            known.set(rel, info);
            noteChanged(rel);
            return;
        }
        const info = await statRel(rel);
        if (info === null) {
            handleVanished(rel);
            return;
        }
        if (info.isDir) {
            await handleDirAppeared(rel, info);
            return;
        }
        handleFileAppeared(rel, info);
    }

    /** A file exists where events say something happened: a create, or half of a rename. */
    function handleFileAppeared(rel: string, info: KnownFile): void {
        const source = findRenameSource(info.key, rel);
        if (source !== null) {
            finishRename(source, rel, false);
            return;
        }
        known.set(rel, info);
        noteChanged(rel);
    }

    /** A directory exists where events say something happened: created, or renamed. */
    async function handleDirAppeared(rel: string, info: KnownFile): Promise<void> {
        const source = findRenameSource(info.key, rel);
        if (source !== null) {
            finishRename(source, rel, true);
            return;
        }
        known.set(rel, info);
        watchDirAt(absOf(rel));
        // Files already inside a new directory predate its watcher, so no
        // event will ever arrive for them; the subtree walk reports them.
        for (const [child, childInfo] of await walkAbs(absOf(rel))) {
            if (!known.has(child) && !childInfo.isDir) {
                known.set(child, childInfo);
                noteChanged(child);
            } else if (!known.has(child)) {
                known.set(child, childInfo);
                watchDirAt(absOf(child));
            }
        }
    }

    /**
     * The other half of a rename, if there is one: first a path that vanished
     * within the pairing window, then a path the last walk knew under this
     * inode but the disk no longer holds. A matching inode at a path that
     * still exists is a copy or a hard link, not a rename.
     */
    function findRenameSource(key: string, newRel: string): string | null {
        for (const [rel, pending] of pendingGone) {
            if (pending.key === key) {
                return rel;
            }
        }
        for (const [rel, info] of known) {
            if (rel !== newRel && info.key === key) {
                try {
                    lstatSync(absOf(rel));
                    return null;
                } catch {
                    return rel;
                }
            }
        }
        return null;
    }

    /** Pair the two halves: update the index, move any dir watcher, and report. */
    function finishRename(oldRel: string, newRel: string, isDir: boolean): void {
        const pending = pendingGone.get(oldRel);
        if (pending !== undefined) {
            clearTimeout(pending.timer);
            pendingGone.delete(oldRel);
        }
        if (isDir) {
            const oldPrefix = `${oldRel}/`;
            const movedWatchers: Array<[string, DirWatcher]> = [];
            for (const [abs, watcher] of watchers) {
                const rel = relOf(abs);
                if (rel === oldRel || rel.startsWith(oldPrefix)) {
                    movedWatchers.push([abs, watcher]);
                }
            }
            for (const [abs, watcher] of movedWatchers) {
                watchers.delete(abs);
                watchers.set(absOf(newRel + relOf(abs).slice(oldRel.length)), watcher);
            }
            const movedKnown: Array<[string, KnownFile]> = [];
            for (const [rel, info] of known) {
                if (rel === oldRel || rel.startsWith(oldPrefix)) {
                    movedKnown.push([rel, info]);
                }
            }
            for (const [rel, info] of movedKnown) {
                known.delete(rel);
                known.set(newRel + rel.slice(oldRel.length), info);
            }
            try {
                events.onRename(oldRel, newRel, true);
            } catch (error) {
                logger.warn(`Watcher callback for rename "${oldRel}" -> "${newRel}" threw`, error);
            }
            // Obsidian reports every item inside a renamed folder as its own
            // rename; the engine applies them together.
            for (const [rel] of movedKnown) {
                if (rel === oldRel) {
                    continue;
                }
                const childNew = newRel + rel.slice(oldRel.length);
                const childInfo = known.get(childNew);
                if (childInfo !== undefined && !childInfo.isDir) {
                    try {
                        events.onRename(rel, childNew, false);
                    } catch (error) {
                        logger.warn(`Watcher callback for rename "${rel}" -> "${childNew}" threw`, error);
                    }
                }
            }
            return;
        }
        known.delete(oldRel);
        void statRel(newRel).then((info) => {
            if (info !== null && !closed) {
                known.set(newRel, info);
            }
        });
        try {
            events.onRename(oldRel, newRel, false);
        } catch (error) {
            logger.warn(`Watcher callback for rename "${oldRel}" -> "${newRel}" threw`, error);
        }
    }

    /** A path the events say is gone: maybe half of a rename, maybe a delete. */
    function handleVanished(rel: string): void {
        const info = known.get(rel);
        if (info === undefined || pendingGone.has(rel)) {
            return;
        }
        if (info.isDir) {
            unwatchDir(absOf(rel));
        }
        pendingGone.set(rel, {
            key: info.key,
            isDir: info.isDir,
            timer: setTimeout(() => {
                pendingGone.delete(rel);
                if (closed) {
                    return;
                }
                if (info.isDir) {
                    // Obsidian's folder delete arrives with a delete per
                    // child; recreate that shape so the engine sees the files
                    // as their own deletions, then the folder.
                    const prefix = `${rel}/`;
                    for (const [child] of known) {
                        if (child.startsWith(prefix) && !known.get(child)?.isDir) {
                            known.delete(child);
                            reportChange(child);
                        }
                    }
                    for (const [child] of [...known]) {
                        if (child === rel || child.startsWith(prefix)) {
                            known.delete(child);
                        }
                    }
                    try {
                        events.onFolderDelete(rel);
                    } catch (error) {
                        logger.warn(`Watcher callback for folder delete "${rel}" threw`, error);
                    }
                    return;
                }
                known.delete(rel);
                logger.info(`Path "${rel}" vanished without its inode reappearing; reporting as a delete`);
                reportChange(rel);
            }, renamePairMs),
        });
    }

    /** Walk one directory tree, returning vault-relative paths. Never throws. */
    async function walkAbs(dirAbs: string): Promise<Map<string, KnownFile>> {
        const found = new Map<string, KnownFile>();
        const seenDirs = new Set<string>();
        const queue: string[] = [dirAbs];
        while (queue.length > 0) {
            const current = queue.pop()!;
            let entries;
            try {
                entries = await fs.readdir(current, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                const abs = path.join(current, entry.name);
                const rel = relOf(abs);
                // Excluded trees are pruned, not walked: their churn never
                // reaches the engine, so indexing them only costs scans.
                if (isExcludedRel(rel)) {
                    continue;
                }
                // A symlinked entry is never followed — not descended into,
                // not indexed. Outside bytes must not enter the sync as vault
                // paths; the adapter refuses links outright if the engine
                // ever asks after one directly.
                if (entry.isSymbolicLink()) {
                    if (!symlinkWarned.has(rel)) {
                        symlinkWarned.add(rel);
                        logger.warn(`Skipping symlink at "${rel}"; symlinks are never synced`);
                    }
                    continue;
                }
                let st;
                try {
                    // lstat, so a link swapped in between readdir and stat
                    // still reads as a link rather than its target.
                    st = await fs.lstat(abs);
                } catch {
                    continue;
                }
                if (st.isSymbolicLink()) {
                    if (!symlinkWarned.has(rel)) {
                        symlinkWarned.add(rel);
                        logger.warn(`Skipping symlink at "${rel}"; symlinks are never synced`);
                    }
                    continue;
                }
                const info: KnownFile = {
                    key: `${st.dev}:${st.ino}`,
                    isDir: st.isDirectory(),
                    mtimeMs: st.mtimeMs,
                    size: st.size,
                };
                found.set(rel, info);
                // Only real directories are descended into; symlinks never
                // reach here, so no link can loop the walk onto an ancestor.
                if (info.isDir && !seenDirs.has(info.key)) {
                    seenDirs.add(info.key);
                    queue.push(abs);
                }
            }
        }
        return found;
    }

    /** The rescan: diff a fresh walk against the index and report the gap. */
    async function rescan(): Promise<void> {
        if (closed) {
            return;
        }
        const seen = await walkAbs(root);
        if (closed) {
            return;
        }
        // Pair renames first, while both halves are in view: a missing path
        // whose inode is present elsewhere moved; the rest was deleted.
        const byKey = new Map<string, string>();
        for (const [rel, info] of seen) {
            if (!byKey.has(info.key)) {
                byKey.set(info.key, rel);
            }
        }
        for (const [rel, info] of [...known]) {
            if (seen.has(rel) || pendingGone.has(rel)) {
                continue;
            }
            const target = byKey.get(info.key);
            if (target !== undefined && target !== rel && !known.has(target)) {
                known.delete(rel);
                finishRenameSync(rel, target, info.isDir, seen);
            }
        }
        for (const [rel, info] of seen) {
            if (pendingGone.has(rel)) {
                // Vanished mid-window, then came back: a delete that undid
                // itself reads as a change, not as silence.
                const pending = pendingGone.get(rel)!;
                clearTimeout(pending.timer);
                pendingGone.delete(rel);
                known.set(rel, info);
                noteChanged(rel);
                continue;
            }
            if (!known.has(rel)) {
                known.set(rel, info);
                if (info.isDir) {
                    watchDirAt(absOf(rel));
                } else {
                    reportChange(rel);
                }
            }
        }
        for (const [rel, info] of [...known]) {
            if (seen.has(rel) || pendingGone.has(rel)) {
                continue;
            }
            if (info.isDir) {
                unwatchDir(absOf(rel));
                const prefix = `${rel}/`;
                for (const [child, childInfo] of [...known]) {
                    if ((child === rel || child.startsWith(prefix)) && !seen.has(child)) {
                        known.delete(child);
                        if (!childInfo.isDir && child !== rel) {
                            reportChange(child);
                        }
                    }
                }
                known.delete(rel);
                try {
                    events.onFolderDelete(rel);
                } catch (error) {
                    logger.warn(`Watcher callback for folder delete "${rel}" threw`, error);
                }
            } else {
                known.delete(rel);
                reportChange(rel);
            }
        }
        for (const [rel, info] of seen) {
            if (info.isDir) {
                watchDirAt(absOf(rel));
            }
        }
    }

    /** The rescan's synchronous pairing: both halves are already in view. */
    function finishRenameSync(oldRel: string, newRel: string, isDir: boolean, seen: Map<string, KnownFile>): void {
        const pending = pendingGone.get(oldRel);
        if (pending !== undefined) {
            clearTimeout(pending.timer);
            pendingGone.delete(oldRel);
        }
        if (isDir) {
            const oldPrefix = `${oldRel}/`;
            for (const [abs, watcher] of [...watchers]) {
                const rel = relOf(abs);
                if (rel === oldRel || rel.startsWith(oldPrefix)) {
                    watchers.delete(abs);
                    watchers.set(absOf(newRel + rel.slice(oldRel.length)), watcher);
                }
            }
        }
        for (const [rel, info] of [...known]) {
            if (rel === oldRel || rel.startsWith(`${oldRel}/`)) {
                known.delete(rel);
                known.set(newRel + rel.slice(oldRel.length), info);
            }
        }
        for (const [rel] of seen) {
            if (rel === newRel || rel.startsWith(`${newRel}/`)) {
                if (!known.has(rel)) {
                    known.set(rel, seen.get(rel)!);
                }
            }
        }
        try {
            events.onRename(oldRel, newRel, isDir);
        } catch (error) {
            logger.warn(`Watcher callback for rename "${oldRel}" -> "${newRel}" threw`, error);
        }
        if (isDir) {
            for (const [rel] of [...known]) {
                if (rel !== newRel && rel.startsWith(`${newRel}/`)) {
                    const childInfo = known.get(rel)!;
                    if (!childInfo.isDir) {
                        const childOld = oldRel + rel.slice(newRel.length);
                        try {
                            events.onRename(childOld, rel, false);
                        } catch (error) {
                            logger.warn(`Watcher callback for rename "${childOld}" -> "${rel}" threw`, error);
                        }
                    }
                }
            }
        }
    }

    // Baseline: walk first, watch every directory found, then walk once more
    // so anything created between the two is reported rather than absorbed.
    const baseline = await walkAbs(root);
    for (const [rel, info] of baseline) {
        known.set(rel, info);
    }
    watchDirAt(root);
    for (const [rel, info] of baseline) {
        if (info.isDir) {
            watchDirAt(absOf(rel));
        }
    }
    const second = await walkAbs(root);
    for (const [rel, info] of second) {
        if (!known.has(rel)) {
            known.set(rel, info);
            if (info.isDir) {
                watchDirAt(absOf(rel));
            } else if (!closed) {
                noteChanged(rel);
            }
        }
    }

    if (rescanSeconds > 0) {
        const tick = (): void => {
            if (closed) {
                return;
            }
            void rescan().finally(() => {
                if (!closed) {
                    rescanTimer = setTimeout(tick, rescanSeconds * 1000);
                    rescanTimer.unref?.();
                }
            });
        };
        rescanTimer = setTimeout(tick, rescanSeconds * 1000);
        rescanTimer.unref?.();
    }

    return {
        async close(): Promise<void> {
            closed = true;
            if (rescanTimer !== null) {
                clearTimeout(rescanTimer);
                rescanTimer = null;
            }
            if (debounceTimer !== null) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            for (const [, pending] of pendingGone) {
                clearTimeout(pending.timer);
            }
            pendingGone.clear();
            for (const [, watcher] of watchers) {
                try {
                    watcher.close();
                } catch {
                    // Already gone; closing is best-effort by definition.
                }
            }
            watchers.clear();
            // Settle the debounced callback still in flight: whatever was
            // reported as changed before the stop is still the engine's to
            // scan. Dropped pairing windows are logged above when created,
            // and the engine's own startup scan covers anything newer.
            const paths = [...dirty];
            dirty.clear();
            for (const rel of paths) {
                reportChange(rel);
            }
        },
        rescan,
    };
}
