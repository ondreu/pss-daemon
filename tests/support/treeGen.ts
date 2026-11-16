/**
 * One fixture tree shared by the integration suite and the chaos runner.
 *
 * The generator writes to a real directory (the engine hashes and stats real
 * files here, so an in-memory tree would prove less), covering the shapes the
 * failure catalogue cares about: NFD/NFC twins that must never collapse, a
 * case-only rename target, empty and 0-byte files, names with spaces and
 * non-ASCII, a sparse file above the 32 MiB large-file line, an excludable
 * subtree, and `.obsidian` churn files. Binary fixtures stay sparse: a 40 MB
 * "video" occupies two written extents, not 40 MB of CI disk.
 *
 * Chaos mutations reuse the token helpers: every mutation appends its token
 * on its own line, and the ledger maps each token to the paths carrying it.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { LARGE_FILE_BYTES } from '../../../src/sync/vault';

export const CASE_RENAME_FILE = 'cases/Note.md';
export const NFC_TWIN = 'unicode/caf\u00e9.md';
export const NFD_TWIN = 'unicode/cafe\u0301.md';
export const LARGE_FILE = 'media/big.bin';

export function sha1Hex(data: Uint8Array): string {
    return createHash('sha1').update(data).digest('hex');
}

export async function writeText(root: string, rel: string, text: string): Promise<void> {
    const full = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, text, 'utf8');
}

export async function readText(root: string, rel: string): Promise<string> {
    return fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
}

export async function writeBytes(root: string, rel: string, data: Uint8Array): Promise<void> {
    const full = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
}

export async function appendToken(root: string, rel: string, token: string): Promise<void> {
    const full = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.appendFile(full, `${token}\n`, 'utf8');
}

/** Every regular file under `root`, as vault-relative paths. */
export async function walkFiles(root: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                await walk(path.join(dir, entry.name), rel);
            } else if (entry.isFile()) {
                found.push(rel);
            }
        }
    };
    await walk(root, '');
    return found.sort();
}

export async function hashTree(root: string, skip?: (rel: string) => boolean): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    for (const rel of await walkFiles(root)) {
        if (skip?.(rel)) {
            continue;
        }
        hashes.set(rel, sha1Hex(new Uint8Array(await fs.readFile(path.join(root, ...rel.split('/'))))));
    }
    return hashes;
}

/**
 * Write the base fixture tree. `largeBytes` defaults to a sparse file just
 * above the product's large-file line; pass 0 to skip it.
 */
export async function buildBaseTree(
    root: string,
    options: { largeBytes?: number } = {},
): Promise<{ largeBytes: number }> {
    const largeBytes = options.largeBytes ?? LARGE_FILE_BYTES + 8 * 1024 * 1024;

    await writeText(root, 'notes/alpha.md', '# Alpha\n\nfirst note\n');
    await writeText(root, 'notes/beta.md', '# Beta\n\nsecond note\n');
    await writeText(root, 'notes/deep/nested/gamma.md', '# Gamma\n\nnested note\n');

    // Unicode twins: NFC `caf\u00e9.md` and NFD `cafe\u0301.md` are distinct
    // byte sequences on Linux and must never collapse into one file. Both
    // carry identical bytes; what differs is only the name's spelling.
    await writeText(root, NFC_TWIN, '# Caf\u00e9\n\nsame bytes, either spelling\n');
    await writeText(root, NFD_TWIN, '# Caf\u00e9\n\nsame bytes, either spelling\n');

    // Case pair: distinct on ext4; the rename test folds one of them.
    await writeText(root, CASE_RENAME_FILE, '# Note\n\ncase rename target\n');
    await writeText(root, 'cases/note.md', '# note\n\ndistinct lowercase file\n');

    await writeText(root, 'empty.md', '');
    await writeText(root, 'zero/blob.bin', '');

    // Spaces and non-ASCII in directory and file names.
    await writeText(root, 'My Vault \u2013 pozn\u00e1mky/den\u00edk 2026.md', '# Den\u00edk\n\nmezery a diakritika\n');

    // Excludable subtree, populated on both sides by the exclusion test.
    await writeText(root, 'drafts/secret.md', '# Draft\n\nnot yet excluded\n');

    // Config churn: what Obsidian rewrites on every launch.
    await writeText(root, '.obsidian/app.json', '{}\n');
    await writeText(root, '.obsidian/workspace.json', '{"main":{}}\n');
    await writeText(root, '.obsidian/hotkeys.json', '[]\n');

    if (largeBytes > 0) {
        await writeSparse(root, LARGE_FILE, largeBytes, 'LARGE-HEAD', 'LARGE-TAIL');
    }
    return { largeBytes };
}

/** A sparse file: only head and tail markers touch the disk. */
export async function writeSparse(root: string, rel: string, size: number, head: string, tail: string): Promise<void> {
    const full = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    const handle = await fs.open(full, 'w');
    try {
        await handle.truncate(size);
        await handle.write(head, 0, 'utf8');
        const tailBytes = Buffer.from(tail, 'utf8');
        await handle.write(tailBytes, 0, tailBytes.byteLength, Math.max(0, size - tailBytes.byteLength));
    } finally {
        await handle.close();
    }
}

export async function touchChurn(root: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        await writeText(root, `.obsidian/churn-${i}.json`, `{"tick":${i}}\n`);
    }
}
