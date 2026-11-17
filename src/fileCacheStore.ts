/* eslint-disable obsidianmd/no-nodejs-modules, obsidianmd/no-global-this, obsidianmd/prefer-window-timers, obsidianmd/hardcoded-config-path -- Node-only daemon code: it never runs inside Obsidian and is not part of main.js. */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import type { CacheStore, StoredEntry } from '../engine/src/proton/persistentCache';
import type { Logger } from '../engine/src/util/logger';

/** Version of the file below; anything else is corruption. */
const CACHE_VERSION = 1;

/**
 * How many entries the file may hold.
 *
 * The cache mirrors what the sync already knows: every node the vault syncs
 * plus the folders above it. A few thousand entries cover the reference vault
 * (~1800 files) with headroom, while bounding a runaway listing — a folder
 * browsed once must not grow this file without limit. Above the cap the
 * least recently written entries go; they are re-fetched from Drive on demand,
 * so dropping them costs requests, never correctness.
 */
export const MAX_CACHE_ENTRIES = 5_000;

type CacheFile = {
    version: number;
    marker: string | null;
    entries: StoredEntry[];
};

function isStoredEntry(value: unknown): value is StoredEntry {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return (
        typeof entry['key'] === 'string' &&
        typeof entry['iv'] === 'string' &&
        typeof entry['data'] === 'string' &&
        Array.isArray(entry['tags']) &&
        (entry['tags'] as unknown[]).every((tag) => typeof tag === 'string')
    );
}

function parseCacheFile(encoded: string): CacheFile | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(encoded) as unknown;
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return null;
    }
    const file = parsed as Record<string, unknown>;
    if (file['version'] !== CACHE_VERSION) {
        return null;
    }
    if (file['marker'] !== null && typeof file['marker'] !== 'string') {
        return null;
    }
    if (!Array.isArray(file['entries']) || !(file['entries'] as unknown[]).every(isStoredEntry)) {
        return null;
    }
    return { version: CACHE_VERSION, marker: file['marker'], entries: file['entries'] as StoredEntry[] };
}

/**
 * The `CacheStore` for the daemon: one versioned JSON file in the data dir.
 *
 * Interchangeable with the in-memory store `EncryptedEntitiesCache` is
 * opened over in tests: `load` returns `{ entries, marker }`, `write`
 * applies entry deltas plus a marker, `clear` empties both. Only ciphertext
 * ever reaches the file — encryption stays in `EncryptedEntitiesCache`, which
 * owns the session key; this class only persists its `StoredEntry` records.
 *
 * Writes are atomic (beside the file, then renamed over it), and a corrupt
 * file starts empty with one warning rather than failing the start: the
 * cache is a pure performance copy of what Drive already holds, so throwing
 * it away costs requests, never data. Single writer, like the IndexedDB
 * store: `EncryptedEntitiesCache` serialises its flushes.
 */
export class FileCacheStore implements CacheStore {
    /** The file's contents as last read or written; insertion order is write recency. */
    private readonly entries = new Map<string, StoredEntry>();
    private marker: string | null = null;
    private loaded = false;

    constructor(
        private readonly path: string,
        private readonly logger: Logger,
    ) {}

    async load(): Promise<{ entries: StoredEntry[]; marker: string | null }> {
        await this.ensureLoaded();
        return { entries: [...this.entries.values()], marker: this.marker };
    }

    async write(entries: StoredEntry[], removed: string[], marker: string): Promise<void> {
        await this.ensureLoaded();
        // Delete-then-set refreshes recency, so the eviction below drops the
        // entries untouched for longest rather than the ones first seen.
        for (const entry of entries) {
            this.entries.delete(entry.key);
            this.entries.set(entry.key, entry);
        }
        for (const key of removed) {
            this.entries.delete(key);
        }
        while (this.entries.size > MAX_CACHE_ENTRIES) {
            const oldest = this.entries.keys().next();
            if (oldest.done === true) {
                break;
            }
            this.entries.delete(oldest.value);
        }
        this.marker = marker;
        await this.persist();
    }

    async clear(): Promise<void> {
        await this.ensureLoaded();
        this.entries.clear();
        this.marker = null;
        await this.persist();
    }

    /** Read the file once; a missing or corrupt file is an empty cache. */
    private async ensureLoaded(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        let encoded: string;
        try {
            encoded = await fs.readFile(this.path, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.warn('Could not read the saved Drive cache; starting without it', error);
            }
            return;
        }
        const parsed = parseCacheFile(encoded);
        if (parsed === null) {
            // One warning, then empty: a torn write or a foreign version is
            // re-fetched from Drive, not retried, and the next write replaces
            // the file.
            this.logger.warn('The saved Drive cache is unreadable; starting without it');
            return;
        }
        for (const entry of parsed.entries.slice(0, MAX_CACHE_ENTRIES)) {
            this.entries.set(entry.key, entry);
        }
        this.marker = parsed.marker;
    }

    private async persist(): Promise<void> {
        await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        // A directory an older version left readable by everyone.
        await chmodQuietly(dirname(this.path), 0o700);
        const file: CacheFile = { version: CACHE_VERSION, marker: this.marker, entries: [...this.entries.values()] };
        const tempPath = `${this.path}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(file), { mode: 0o600 });
        try {
            await fs.rename(tempPath, this.path);
        } catch (error) {
            try {
                await fs.unlink(tempPath);
            } catch {
                // A leftover temp file is overwritten by the next write.
            }
            throw error;
        }
        // Heal a file an older version left readable by everyone.
        await chmodQuietly(this.path, 0o600);
    }
}

/** Best effort: a filesystem without modes, or a path out of reach. */
async function chmodQuietly(path: string, mode: number): Promise<void> {
    try {
        await fs.chmod(path, mode);
    } catch {
        // The permission check reports what it sees; see the tests.
    }
}
