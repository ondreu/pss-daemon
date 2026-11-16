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
 * Two properties matter more than coverage:
 *
 * - Writes are atomic. `writeBinary` lands in a temporary file in the same
 *   directory and is renamed over the target only after the bytes are flushed
 *   (`fsync`), so a crash or a `kill -9` leaves either the old content or the
 *   new content at the target path, never a mix. A rename that cannot happen
 *   on some platform is the one case `VaultIO` already handles by falling
 *   back to an in-place write; the temp file is removed either way.
 * - No path escapes the vault. Every method goes through `checked()`, which
 *   applies the engine's own `staysInVault` rule a second time — the engine
 *   checks too, but this is the last line before the disk.
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
 * Faults a test may inject. The daemon never sets these; they exist so the
 * atomic-write guarantee can be proven without racing a real crash — for
 * example, by refusing the rename and asserting the old content survived.
 */
export type NodeAdapterFaults = {
    /**
     * Return true to make the atomic rename for `targetRel` throw instead of
     * happening, after the temporary file is fully written and flushed. The
     * temporary file is removed and the target is left untouched.
     */
    failRename?: (targetRel: string) => boolean;
};

let tempCounter = 0;

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
            await fs.stat(this.full(checked));
            return true;
        } catch {
            return false;
        }
    }

    async stat(rel: string): Promise<Stat | null> {
        const checked = this.checked(rel);
        let st;
        try {
            st = await fs.stat(checked === '' ? this.root : this.full(checked));
        } catch {
            return null;
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
        const entries = await fs.readdir(checked === '' ? this.root : this.full(checked), {
            withFileTypes: true,
        });
        const prefix = checked === '' ? '' : `${checked}/`;
        return {
            files: entries.filter((entry) => entry.isFile()).map((entry) => prefix + entry.name),
            folders: entries.filter((entry) => entry.isDirectory()).map((entry) => prefix + entry.name),
        };
    }

    async read(rel: string): Promise<string> {
        return await fs.readFile(this.full(this.checked(rel)), 'utf8');
    }

    async readBinary(rel: string): Promise<ArrayBuffer> {
        // One buffer for the file, sliced off the pool's backing store so no
        // caller can scribble on a neighbour. The engine only reads whole
        // files below its large-file threshold; above it, it streams.
        const data = await fs.readFile(this.full(this.checked(rel)));
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }

    async write(rel: string, data: string, options?: DataWriteOptions): Promise<void> {
        await this.writeBinary(rel, new TextEncoder().encode(data).buffer as ArrayBuffer, options);
    }

    /**
     * Write bytes atomically: fully written and flushed to a temporary file
     * beside the target, then renamed over it. Until the rename, the target
     * holds its old content; after it, the new content. No partial file is
     * ever visible at the target path.
     *
     * The temporary name carries the `.proton-sync.tmp` suffix with a leading
     * dot, matching the pattern the engine already sweeps (`VaultIO` removes
     * `.name.proton-sync.tmp` debris), so a crash between the write and the
     * rename leaves litter the next pass cleans up — and never an upload,
     * because the engine excludes `*.tmp`.
     */
    async writeBinary(rel: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
        const checked = this.checked(rel);
        const target = this.full(checked);
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
        } catch (error) {
            await fs.unlink(temp).catch(() => undefined);
            throw error;
        }
    }

    async append(rel: string, data: string, options?: DataWriteOptions): Promise<void> {
        const target = this.full(this.checked(rel));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, data, 'utf8');
        if (options?.mtime !== undefined) {
            await fs.utimes(target, new Date(), new Date(options.mtime));
        }
    }

    async appendBinary(rel: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
        const target = this.full(this.checked(rel));
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
        await fs.mkdir(this.full(this.checked(rel)), { recursive: true });
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
     * overwriting — trash that eats trash is not trash.
     */
    async trashLocal(rel: string): Promise<void> {
        const checked = this.checked(rel);
        const source = this.full(checked);
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
    }

    async rmdir(rel: string, recursive: boolean): Promise<void> {
        const target = this.full(this.checked(rel));
        if (recursive) {
            await fs.rm(target, { recursive: true });
        } else {
            await fs.rmdir(target);
        }
    }

    async remove(rel: string): Promise<void> {
        const checked = this.checked(rel);
        const target = this.full(checked);
        let st;
        try {
            st = await fs.stat(target);
        } catch {
            throw new Error(`ENOENT: no such file or folder: ${JSON.stringify(checked)}`);
        }
        if (st.isDirectory()) {
            await fs.rm(target, { recursive: true });
        } else {
            await fs.unlink(target);
        }
    }

    async rename(oldRel: string, newRel: string): Promise<void> {
        const from = this.full(this.checked(oldRel));
        const to = this.full(this.checked(newRel));
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
    }

    /**
     * Copy bytes without reading them into memory. Overwrites like the
     * filesystem does; the Vault-level `copy` — the one the engine calls for
     * indexed files — refuses an existing destination first, matching
     * Obsidian, which fails the copy instead.
     */
    async copy(oldRel: string, newRel: string): Promise<void> {
        const from = this.full(this.checked(oldRel));
        const to = this.full(this.checked(newRel));
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
    }
}
