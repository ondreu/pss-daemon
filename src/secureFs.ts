/**
 * Owner-only filesystem helpers for daemon-owned files.
 *
 * State, status, device ids and lock files carry note names, hashes and
 * error strings, so they are closed to other local users: `0700` dirs,
 * `0600` files, whatever the process umask is. Modes are passed at creation
 * *and* healed afterwards: creation-time modes do not touch pre-existing
 * paths, and an older version (or a bare `mkdir`) may have left them open.
 *
 * Vault contents never go through here — notes keep the user's own modes.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { fsyncDir } from './nodeAdapter';

/** Create (or close) a daemon-owned directory: `0700`, healed. */
export async function ensurePrivateDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Heals dirs an older version left open; best effort, like the slot.
    await chmod(dir, 0o700).catch(() => undefined);
}

/**
 * A temp name beside `file` that no concurrent writer in this process shares.
 * Sharing one temp name lets a concurrent rename pull the file out from
 * under a writer mid-publish (ENOENT where a durable write was expected).
 */
export function privateTempPath(file: string): string {
    return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/**
 * Atomic, durable, owner-only file write: temp file beside the target
 * (`0600`), flushed, renamed over the target, target healed to `0600`, and
 * the directory flushed so a crash cannot lose a file this call returned on.
 */
export async function writePrivateFile(file: string, text: string): Promise<void> {
    await ensurePrivateDir(path.dirname(file));
    await writeFileAtomic(file, text);
    await chmod(file, 0o600).catch(() => undefined);
    await fsyncDir(path.dirname(file));
}

/** Temp-plus-rename publish used by {@link writePrivateFile}. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
    // Unique per call: concurrent publishers must never share a temp name.
    const tmp = privateTempPath(file);
    try {
        const handle = await open(tmp, 'wx', 0o600);
        try {
            await handle.writeFile(text, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(tmp, file);
    } catch (error) {
        await unlink(tmp).catch(() => undefined);
        throw error;
    }
}
