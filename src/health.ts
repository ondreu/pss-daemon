/**
 * The health file: `status.json` in the data dir.
 *
 * Written atomically (temp file + rename, same directory) so a reader never
 * sees a torn write; read back by `status` and by the compose healthcheck,
 * which cares about freshness, not just process liveness.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SyncSummary } from '../../src/sync/engine';
import type { PendingMassDelete } from '../../src/sync/engine/types';

/** What the daemon is doing, as far as a supervisor is concerned. */
export type DaemonState = 'starting' | 'idle' | 'syncing' | 'error' | 'signed-out' | 'mass-delete-held' | 'stopped' | 'unknown';

export type HealthFile = {
    /** ISO timestamp of the last write; what freshness is measured against. */
    updatedAt: string;
    state: DaemonState;
    /** The engine's last summary, when there is one. */
    lastSummary: SyncSummary | null;
    /** Unresolved conflicts, from the summary. */
    pendingConflicts: number;
    /** Paths a pass held back instead of deleting; empty when none are held. */
    massDeleteHeld: string[];
    /** Last fatal error, if the daemon stopped on one. */
    error: string | null;
    /** ISO timestamp of the last finished pass; null before the first. */
    lastPassAt: string | null;
};

/** A heartbeat is written every 30 s, so two missed beats read as stale. */
export const HEALTH_MAX_AGE_MS = 90_000;

export function emptyHealth(state: DaemonState = 'starting'): HealthFile {
    return {
        updatedAt: new Date().toISOString(),
        state,
        lastSummary: null,
        pendingConflicts: 0,
        massDeleteHeld: [],
        error: null,
        lastPassAt: null,
    };
}

/** True when the file was written within `maxAgeMs`. Unparseable timestamps read as stale, not fresh. */
export function isHealthFresh(health: Pick<HealthFile, 'updatedAt'>, maxAgeMs: number = HEALTH_MAX_AGE_MS, now: number = Date.now()): boolean {
    const written = Date.parse(health.updatedAt);
    if (!Number.isFinite(written)) {
        return false;
    }
    return now - written <= maxAgeMs && now - written >= -5_000;
}

/** Thrown when the file exists but cannot be parsed; `status` reports it instead of guessing. */
export class HealthCorruptError extends Error {
    constructor(readonly healthPath: string) {
        super(`The health file at ${healthPath} is corrupt.`);
        this.name = 'HealthCorruptError';
    }
}

function normalizeHealth(raw: unknown, healthPath: string): HealthFile {
    if (typeof raw !== 'object' || raw === null) {
        throw new HealthCorruptError(healthPath);
    }
    const record = raw as Record<string, unknown>;
    if (typeof record['updatedAt'] !== 'string' || typeof record['state'] !== 'string') {
        throw new HealthCorruptError(healthPath);
    }
    const held = record['massDeleteHeld'];
    const summary = record['lastSummary'] as SyncSummary | null;
    const pending = summary && typeof summary === 'object' && 'pendingMassDelete' in summary ? (summary.pendingMassDelete as PendingMassDelete | undefined) : undefined;
    return {
        updatedAt: record['updatedAt'],
        state: record['state'] as DaemonState,
        lastSummary: (summary ?? null) as SyncSummary | null,
        pendingConflicts: typeof record['pendingConflicts'] === 'number' ? record['pendingConflicts'] : 0,
        massDeleteHeld: Array.isArray(held) ? held.filter((entry): entry is string => typeof entry === 'string') : (pending?.paths ?? []),
        error: typeof record['error'] === 'string' ? record['error'] : null,
        lastPassAt: typeof record['lastPassAt'] === 'string' ? record['lastPassAt'] : null,
    };
}

/** Null when the daemon never wrote one; throws {@link HealthCorruptError} when the file is torn. */
export async function readHealthFile(healthPath: string): Promise<HealthFile | null> {
    let text: string;
    try {
        text = await readFile(healthPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    try {
        return normalizeHealth(JSON.parse(text), healthPath);
    } catch (error) {
        if (error instanceof HealthCorruptError) {
            throw error;
        }
        throw new HealthCorruptError(healthPath);
    }
}

/** Atomic: write beside the target, then rename over it. */
export async function writeHealthFile(healthPath: string, health: HealthFile): Promise<void> {
    await mkdir(path.dirname(healthPath), { recursive: true });
    const tmp = `${healthPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(health), 'utf8');
    await rename(tmp, healthPath);
}
