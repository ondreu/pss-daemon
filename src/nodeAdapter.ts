/**
 * A `DataAdapter` over a vault directory on the local disk, for the daemon.
 *
 * The engine reaches every vault byte through `VaultIO`, which only ever
 * touches `app.vault.adapter` — so this class is the whole of the engine's
 * filesystem. It implements the full `DataAdapter` surface (so `implements`
 * fails the build if Obsidian's interface grows a method the engine might
 * call), but the paths the engine actually exercises are `stat`, `exists`,
 * `read`/`readBinary`, `writeBinary`, `mkdir`, `remove`, `rename`, `list`,
 * `copy`, `trashSystem`/`trashLocal` and `getFullPath`.
 *
 * Three properties matter more than coverage:
 *
 * - Writes are atomic. `writeBinary` lands in a temporary file in the same
 *   directory and is renamed over the target only after the bytes are flushed
 *   (`fsync`), and the directory entry itself is flushed (`fsync` on the
 *   directory fd) after the rename, so a crash between `rename` and
 *   directory durability cannot lose a file the state later calls synced.
 * - No path escapes the vault. Every method goes through `checked()`, which
 *   applies the engine's own `staysInVault` rule a second time — the engine
 *   checks too, but this is the last line before the disk.
 * - No symlink is ever followed. Every stat is an `lstat`: a symlink reads
 *   as "refuse", never as its target. Listings skip links (outside bytes
 *   must not enter the sync as vault files), reads of a link throw, and a
 *   write over a link throws instead of replacing it — a download must never
 *   silently destroy a user's link. See {@link SymlinkRefusedError}.
 *
 * Permission errors are never mistaken for absence: `stat`/`exists` swallow
 * only `ENOENT`. An `EACCES`/`EPERM` propagates, and the daemon's pre-pass
 * readability walk (see `daemon.ts`) refuses the pass before the engine can
 * read an unreadable subtree as "everything deleted".
 *
 * Reads hold one buffer for the file being read and no more; large files are
 * the engine's decision (it streams over `LARGE_FILE_BYTES` only where the
 * platform gives it a direct handle), not the adapter's.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DataAdapter, DataWriteOptions, ListedFiles, Stat } from 'obsidian';

import { staysInVault } from '../../src/sync/paths';

/**
 * Thrown when a vault path resolves to a symlink. The daemon never follows
 * links in either direction: reading one would upload outside bytes under a
 * vault name, and writing over one would destroy the user's link.
 */
export class SymlinkRefusedError extends Error {
    constructor(readonly rel: string) {
        super(`Refusing to follow symlink at ${JSON.stringify(rel)}: symlinks are never synced`);
        this.name = 'SymlinkRefusedError';
    }
}

/**
 * Faults and probes a test may inject. The daemon never sets `failRename`
 * (it exists so the atomic-write guarantee can be proven without racing a
 * real crash); `onDirSync` observes directory durability the same way, so a
 * test can prove the rename-plus-dir-fsync path ran without pulling the
 * power cord.
 */
export type NodeAdapterFaults = {
    /**
     * Return true to make the atomic rename for `targetRel` throw instead of
     * happening, after the temporary file is fully written and flushed. The
     * temporary file is removed and the target is left untouched.
     */
    failRename?: (targetRel: string) => boolean;
    /** Called after the directory entry is flushed following a rename. */
    onDirSync?: (dirAbs: string) => void;
};

let tempCounter = 0;

/** True only for "no such file": every other errno propagates, never reads as absence. */
function isNotFound(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Flush a directory entry so a just-renamed file survives a crash. Without
 * this, the rename can reach the disk while the directory entry does not,
 * and a file the state calls synced is gone after a power loss.
 */
export async function fsyncDir(dirAbs: string, onDirSync?: (dirAbs: string) => void): Promise<void> {
    const dir = await fs.open(dirAbs, 'r');
    try {
        await dir.sync();
    } finally {
        await dir.close();
    }
    onDirSync?.(dirAbs);
}

export class NodeVaultAdapter implements DataAdapter {
    constructor(
        private readonly root: string,
        private readonly faults: NodeAdapterFaults = {},
    ) {}

    /**
     * The vault-relative path this adapter was given, verified to stay inside
     * the vault. The engine normalises paths before they arrive; anything
     * that would resolve outside the root (absolute paths, `..` climbs,
     * drive-letter tricks on Windows) is refused here, whatever the caller.
     */
    private checked(rel: string): string {
        if (!staysInVault(rel, process.platform === 'win32')) {
            throw new Error(`Refusing ${JSON.stringify(rel)}: it would lead outside the vault`);
        }
        return rel;
    }

    /** Absolute path of a checked vault-relative path. */
    private full(rel: string): string {
        // Splitting on '/' keeps a vault path vault-shaped even on Windows,
        // where `path.join(root, rel)` would treat backslashes as separators.
        return path.join(this.root, ...rel.split('/'));
    }

    /**
     * Absolute path of a checked vault-relative path, refusing if the path
     * or any ancestor below the root is a symlink. Every filesystem touch
     * goes through here (directly or via `lstatChecked`), so a link can
     * neither be read as its target nor smuggled past as a parent: writing
     * into `link/note.md` would otherwise `mkdir -p` through the link and
     * land outside the vault.
     */
    private async resolveChecked(checked: string): Promise<string> {
        if (checked !== '') {
            const segments = checked.split('/');
            let prefix = '';
            for (const segment of segments) {
                prefix = prefix === '' ? segment : `${prefix}/${segment}`;
                let st;
                try {
                    st = await fs.lstat(this.full(prefix));
                } catch (error) {
                    if (isNotFound(error)) {
                        // Nothing below a missing path can be a link.
                        break;
                    }
                    throw error;
                }
                if (st.isSymbolicLink()) {
                    throw new SymlinkRefusedError(prefix);
                }
            }
        }
        return this.full(checked);
    }

    /** `lstat`, so a symlink never reads as its target. Throws on links. */
    private async lstatChecked(checked: string): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
        const st = await fs.lstat(await this.resolveChecked(checked));
        if (st.isSymbolicLink()) {
            throw new SymlinkRefusedError(checked);
        }
        return st;
    }

    /**
     * Absolute path on disk, when the caller asks. `VaultIO` uses this for
     * its streaming and `statSync` fast paths wherever the platform offers
     * them; without it everything still works through the adapter methods.
     */
    getFullPath(rel: string): string {
        return this.full(this.checked(rel));
    }

    getName(): string {
        return path.basename(this.root);
    }

    async exists(rel: string): Promise<boolean> {
        const checked = this.checked(rel);
        if (checked === '') {
            return true;
        }
        try {
            await this.lstatChecked(checked);
            return true;
        } catch (error) {
            if (error instanceof SymlinkRefusedError) {
                throw error;
            }
            // Only "no such file" reads as absent. Anything else —
            // EACCES, EPERM, ENOTDIR — propagates, so an unreadable path
            // never reads as a deleted one.
            if (isNotFound(error)) {
                return false;
            }
            throw error;
        }
    }

    async stat(rel: string): Promise<Stat | null> {
        const checked = this.checked(rel);
        let st;
        try {
            st = await fs.lstat(checked === '' ? this.root : await this.resolveChecked(checked));
        } catch (error) {
            if (isNotFound(error)) {
                return null;
            }
            throw error;
        }
        if (st.isSymbolicLink()) {
            throw new SymlinkRefusedError(checked);
        }
        return {
            type: st.isFile() ? 'file' : 'folder',
            ctime: Math.round(st.ctimeMs),
            mtime: Math.round(st.mtimeMs),
            size: st.size,
        };
    }

    async list(rel: string): Promise<ListedFiles> {
        const checked = this.checked(rel);
        if (checked !== '') {
            // Refuse a linked directory (and a linked ancestor) before
            // readdir can follow it: its outside files must never enumerate
            // as vault paths.
            await this.lstatChecked(checked);
        }
        const entries = await fs.readdir(checked === '' ? this.root : this.full(checked), {
            withFileTypes: true,
        });
        const prefix = checked === '' ? '' : `${checked}/`;
        // Symlinks are skipped, never followed: a linked directory's outside
        // files must not enter the sync as vault paths, and a linked file's
        // target bytes must never be uploaded (reads refuse links outright,
        // so a link that survived listing would fail the pass loudly anyway).
        const visible = entries.filter((entry) => !entry.isSymbolicLink());
        return {
            files: visible.filter((entry) => entry.isFile()).map((entry) => prefix + entry.name),
            folders: visible.filter((entry) => entry.isDirectory()).map((entry) => prefix + entry.name),
        };
    }

    async read(rel: string): Promise<string> {
        const checked = this.checked(rel);
        await this.lstatChecked(checked);
        return await fs.readFile(await this.resolveChecked(checked), 'utf8');
    }

    async readBinary(rel: string): Promise<ArrayBuffer> {
        const checked = this.checked(rel);
        // One buffer for the file, sliced off the pool's backing store so no
        // caller can scribble on a neighbour. The engine only reads whole
        // files below its large-file threshold; above it, it streams.
        await this.lstatChecked(checked);
        const data = await fs.readFile(await this.resolveChecked(checked));
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }

    async write(rel: string, data: string, options?: DataWriteOptions): Promise<void> {
        await this.writeBinary(rel, new TextEncoder().encode(data).buffer, options);
    }

    /**
     * Write bytes atomically: fully written and flushed to a temporary file
     * beside the target, then renamed over it, then the directory entry
     * flushed. Until the rename, the target holds its old content; after the
     * rename *and* the directory sync, the new content is durable. No partial
     * file is ever visible at the target path.
     *
     * The temporary name carries the `.proton-sync.tmp` suffix with a leading
     * dot, matching the pattern the engine already sweeps (`VaultIO` removes
     * `.name.proton-sync.tmp` debris), so a crash between the write and the
     * rename leaves litter the next pass cleans up — and never an upload,
     * because the engine excludes `*.tmp`.
     */
    async writeBinary(rel: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
        const checked = this.checked(rel);
        // Throws when the target or any ancestor is a link: a download must
        // not silently replace a user's link, and mkdir -p through a linked
        // parent would land outside the vault.
        const target = await this.resolveChecked(checked);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temp = path.join(
            path.dirname(target),
            `.${path.basename(target)}.${process.pid}.${tempCounter++}.proton-sync.tmp`,
        );
        const handle = await fs.open(temp, 'w');
        try {
            const bytes = new Uint8Array(data);
            let offset = 0;
            while (offset < bytes.byteLength) {
                const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
                offset += bytesWritten;
            }
            // Flushed before the rename, or the rename is worth nothing: the
            // directory entry could reach the disk with unwritten bytes behind
            // it.
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            if (options?.mtime !== undefined) {
                await fs.utimes(temp, new Date(), new Date(options.mtime));
            }
            if (this.faults.failRename?.(checked)) {
                throw new Error(`Injected fault: refusing to rename into ${JSON.stringify(checked)}`);
            }
            await fs.rename(temp, target);
            // Flushed after the rename, or a crash can lose a file the state
            // already calls synced. Same-directory only: cheap, one syscall.
            await fsyncDir(path.dirname(target), this.faults.onDirSync);
        } catch (error) {
            await fs.unlink(temp).catch(() => undefined);
            throw error;
        }
    }

    async append(rel: string, data: string, options?: DataWriteOptions): Promise<void> {
        const target = await this.resolveChecked(this.checked(rel));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, data, 'utf8');
        if (options?.mtime !== undefined) {
            await fs.utimes(target, new Date(), new Date(options.mtime));
        }
    }

    async appendBinary(rel: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
        const target = await this.resolveChecked(this.checked(rel));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, new Uint8Array(data));
        if (options?.mtime !== undefined) {
            await fs.utimes(target, new Date(), new Date(options.mtime));
        }
    }

    async process(rel: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string> {
        const next = fn(await this.read(rel));
        await this.write(rel, next, options);
        return next;
    }

    getResourcePath(rel: string): string {
        return `file://${this.full(this.checked(rel))}`;
    }

    async mkdir(rel: string): Promise<void> {
        await fs.mkdir(await this.resolveChecked(this.checked(rel)), { recursive: true });
    }

    /**
     * No system trash exists on a headless NAS, and there is no keyring-safe
     * way to reach a desktop's without a new dependency — which the daemon
     * refuses. Always false, so callers fall back to `trashLocal`, which
     * keeps the bytes recoverable under `.trash/`.
     */
    async trashSystem(_rel: string): Promise<boolean> {
        this.checked(_rel);
        return false;
    }

    /**
     * Move the path into `.trash/` at the vault root, preserving its shape
     * below it. A name already taken there gets a numeric suffix rather than
     * overwriting — trash that eats trash is not trash. Moving the link
     * itself is safe (no bytes cross the vault boundary); the daemon is a
     * single writer, so check-then-rename is enough.
     */
    async trashLocal(rel: string): Promise<void> {
        const checked = this.checked(rel);
        // A link source is refused rather than moved: the engine never asks
        // for one (reads refuse links first), so this is always a surprise.
        const source = await this.resolveChecked(checked);
        // A name already taken in the trash gets a numeric suffix rather than
        // overwriting — trash that eats trash is not trash. The daemon is a
        // single writer, so check-then-rename is enough; nothing else creates
        // these names concurrently.
        let destRel = `.trash/${checked}`;
        await fs.mkdir(path.dirname(this.full(destRel)), { recursive: true });
        for (let attempt = 1; await this.exists(destRel); attempt++) {
            destRel = `.trash/${checked}.${attempt}`;
        }
        await fs.rename(source, this.full(destRel));
        await fsyncDir(path.dirname(this.full(destRel)), this.faults.onDirSync);
    }

    async rmdir(rel: string, recursive: boolean): Promise<void> {
        // resolveChecked already refused links (final or ancestor): only a
        // real directory reaches the removal below, never a link target.
        const target = await this.resolveChecked(this.checked(rel));
        if (recursive) {
            await fs.rm(target, { recursive: true });
        } else {
            await fs.rmdir(target);
        }
    }

    async remove(rel: string): Promise<void> {
        const checked = this.checked(rel);
        let target: string;
        let st;
        try {
            // resolveChecked refuses links; the lstat below only tells files
            // from directories. Missing reads as the adapter's ENOENT either
            // way, never as silent success.
            target = await this.resolveChecked(checked);
            st = await fs.lstat(target);
        } catch (error) {
            if (isNotFound(error)) {
                throw new Error(`ENOENT: no such file or folder: ${JSON.stringify(checked)}`);
            }
            throw error;
        }
        if (st.isDirectory()) {
            await fs.rm(target, { recursive: true });
        } else {
            await fs.unlink(target);
        }
    }

    async rename(oldRel: string, newRel: string): Promise<void> {
        const checkedFrom = this.checked(oldRel);
        const checkedTo = this.checked(newRel);
        // Neither side may be (or sit below) a link: the source move stays
        // inside the vault, and the destination is never a link silently
        // replaced.
        const from = await this.resolveChecked(checkedFrom);
        const to = await this.resolveChecked(checkedTo);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
        await fsyncDir(path.dirname(to), this.faults.onDirSync);
    }

    /**
     * Copy bytes without reading them into memory. Overwrites like the
     * filesystem does; the Vault-level `copy` — the one the engine calls for
     * indexed files — refuses an existing destination first, matching
     * Obsidian, which fails the copy instead. A symlink source is refused:
     * copying would upload the link target's bytes as a vault file.
     */
    async copy(oldRel: string, newRel: string): Promise<void> {
        const checkedFrom = this.checked(oldRel);
        const checkedTo = this.checked(newRel);
        await this.lstatChecked(checkedFrom);
        // A linked destination is refused, never replaced.
        const to = await this.resolveChecked(checkedTo);
        const from = await this.resolveChecked(checkedFrom);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
    }
}
