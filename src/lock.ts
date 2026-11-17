/* eslint-disable obsidianmd/no-nodejs-modules, obsidianmd/no-global-this, obsidianmd/prefer-window-timers, obsidianmd/hardcoded-config-path -- Node-only daemon code: it never runs inside Obsidian and is not part of main.js. */
/**
 * Single-instance lock.
 *
 * Node has no `flock(2)`, so the lock is an `O_EXCL` file holding
 * `{pid, bootId, startedAt, vaultPath, heartbeatAt}`. A lock whose owner is
 * gone (dead pid *and* a stale heartbeat, or a boot id from before this
 * boot — pid reuse across reboots) is stale and taken over, loudly: the
 * reason is always reported, never acted on silently.
 *
 * Why the heartbeat: pid liveness is namespace-local. Two containers over
 * one vault (the exact case the vault-side lock in `daemon.lock` exists
 * for) have different pid namespaces: container B answers ESRCH for A's
 * live pid and reads the same `boot_id`, so pid-plus-boot alone concludes
 * "stale", unlinks A's file and holds its own — two writers. A live holder
 * rewrites its file every {@link LOCK_HEARTBEAT_MS}, so a fresh heartbeat
 * with a matching boot id means "alive somewhere I cannot signal", and
 * takeover is refused (fail closed) however dead the pid looks from here.
 * Only a dead pid *with* a heartbeat older than {@link LOCK_STALE_MS} is
 * taken over. The file descriptor stays open for the process lifetime; a
 * crash closes it without deleting the file, which is exactly what the next
 * start's stale detection is for.
 *
 * Two files are held, not one: `<dataDir>/daemon.lock` and
 * `<vault>/.proton-sync/daemon.lock`. Two containers can bind-mount
 * different data dirs over the same vault, and only the vault-side file
 * collides then. This is the correction to the design doc, which named only
 * the data-dir file.
 */
import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ensurePrivateDir, privateTempPath } from './secureFs';

export type LockInfo = {
    pid: number;
    /** Linux boot id; null where it cannot be read (non-Linux, containers without /proc). */
    bootId: string | null;
    startedAt: string;
    vaultPath: string;
    /**
     * Last heartbeat write, ISO. Written on acquire and refreshed while the
     * holder lives; absent on locks written before heartbeats existed, which
     * then fall back to the file mtime (every heartbeat rewrites the file).
     */
    heartbeatAt?: string;
};

export type LockProbe = {
    isAlive(pid: number): boolean;
    readBootId(): string | null;
};

/** Thrown when a live owner holds the lock; the CLI maps it to exit 5. */
export class LockHeldError extends Error {
    constructor(
        readonly lockPath: string,
        readonly holder: LockInfo | null,
    ) {
        super(
            holder === null
                ? `Another instance holds ${lockPath}.`
                : `Another instance (pid ${holder.pid}) holds ${lockPath} for vault ${holder.vaultPath}.`,
        );
        this.name = 'LockHeldError';
    }
}

/** How often a held lock rewrites its file while alive. */
export const LOCK_HEARTBEAT_MS = 10_000;
/**
 * A lock with no heartbeat this old reads as abandoned — once the pid check
 * also fails. Three missed beats, so one slow tick cannot hand a live lock
 * to someone else.
 */
export const LOCK_STALE_MS = 30_000;

export function defaultProbe(): LockProbe {
    return {
        isAlive(pid: number): boolean {
            if (!Number.isInteger(pid) || pid <= 0) {
                return false;
            }
            try {
                process.kill(pid, 0);
                return true;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                // No such process: free. No permission to signal it: it
                // exists, so the lock is held. Anything else: assume held —
                // refusing to start is safe, starting twice is not.
                return code !== 'ESRCH';
            }
        },
        readBootId(): string | null {
            // Synchronous read keeps acquisition simple; the file is tiny and local.
            try {
                const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
                return id === '' ? null : id;
            } catch {
                return null;
            }
        },
    };
}

function describeStale(existing: string, reason: string): string {
    return `Taking over a stale lock (${reason}): ${existing}`;
}

type Verdict = { held: true; holder: LockInfo | null } | { held: false; reason: string };

/** Best-effort removal of our own debris; the name was never published. */
async function removeQuietly(target: string): Promise<void> {
    try {
        await unlink(target);
    } catch {
        // Already gone (or never created): nothing published, nothing to do.
    }
}

/**
 * Publish a payload with no torn window: write and flush a temp file, then
 * `link` it into place. `link` either creates the name or fails `EEXIST` —
 * unlike create-then-fill, a concurrent reader never observes a half file.
 */
async function createExclusive(lockPath: string, payload: string): Promise<void> {
    const tmp = privateTempPath(lockPath);
    const handle = await open(tmp, 'wx', 0o600);
    try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await link(tmp, lockPath);
    } catch (error) {
        await removeQuietly(tmp);
        throw error;
    }
    await removeQuietly(tmp);
}

/**
 * Replace a live payload readers may hold open: temp file plus `rename`,
 * never truncate-in-place. Rename is atomic: readers see the old file or
 * the new file, both complete. The temp file is `0600` in the same `0700`
 * directory, so the published file keeps owner-only modes.
 */
async function replaceAtomically(lockPath: string, payload: string): Promise<void> {
    const tmp = privateTempPath(lockPath);
    const handle = await open(tmp, 'wx', 0o600);
    try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    await rename(tmp, lockPath);
}

async function heartbeatAgeMs(lockPath: string, holder: LockInfo, now: number): Promise<number> {
    const ages: number[] = [];
    if (typeof holder.heartbeatAt === 'string') {
        const written = Date.parse(holder.heartbeatAt);
        if (Number.isFinite(written)) {
            ages.push(now - written);
        }
    }
    // Every heartbeat rewrites the file, so the mtime backs the payload for
    // locks written before `heartbeatAt` existed — and corroborates it after.
    try {
        ages.push(now - (await stat(lockPath)).mtimeMs);
    } catch {
        // The file vanished mid-inspect; the caller re-reads below.
    }
    return ages.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...ages);
}

export type AcquireOptions = {
    /**
     * Heartbeat period in milliseconds; shortened in tests. Zero disables the
     * heartbeat (tests that assert staleness without waiting for a tick).
     */
    heartbeatMs?: number;
    /** Clock, injected in tests so staleness needs no sleeping. */
    now?: () => number;
};

export class DaemonLock {
    private released = false;
    private heartbeat: ReturnType<typeof setInterval> | null = null;

    private constructor(
        readonly lockPath: string,
        readonly info: LockInfo,
    ) {}

    /**
     * Create and hold the lock. Throws {@link LockHeldError} when a live
     * owner holds it; takes over a stale one and reports why via
     * `onTakeover` (defaults to stderr, never silent).
     *
     * Takeover needs *either* a boot id from before this boot (the pid
     * cannot be the pre-reboot owner, however alive it looks now) *or* a pid
     * that fails the liveness check *and* a heartbeat older than
     * {@link LOCK_STALE_MS}. A matching boot id with a fresh heartbeat
     * means the owner lives in a pid namespace this process cannot signal
     * into: takeover is refused, fail closed.
     */
    static async acquire(
        lockPath: string,
        info: LockInfo,
        probe: LockProbe = defaultProbe(),
        onTakeover: (message: string) => void = (message) => process.stderr.write(message + '\n'),
        options: AcquireOptions = {},
    ): Promise<DaemonLock> {
        await ensurePrivateDir(path.dirname(lockPath));
        const payload = JSON.stringify({ ...info, heartbeatAt: new Date().toISOString() });
        try {
            await createExclusive(lockPath, payload);
            return new DaemonLock(lockPath, info).startHeartbeat(options);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
        const verdict = await DaemonLock.inspect(lockPath, probe, options.now?.() ?? Date.now());
        if (verdict.held) {
            throw new LockHeldError(lockPath, verdict.holder);
        }
        onTakeover(describeStale(lockPath, verdict.reason));
        try {
            await DaemonLock.unlink(lockPath);
        } catch {
            // Lost a race with another starter; re-read below decides.
        }
        try {
            await createExclusive(lockPath, payload);
            return new DaemonLock(lockPath, info).startHeartbeat(options);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
            const again = await DaemonLock.inspect(lockPath, probe, options.now?.() ?? Date.now());
            throw new LockHeldError(lockPath, again.held ? again.holder : null);
        }
    }

    private static async unlink(lockPath: string): Promise<void> {
        const { unlink } = await import('node:fs/promises');
        await unlink(lockPath);
    }

    /** Replace the payload atomically; see {@link replaceAtomically}. */
    private static async rewrite(lockPath: string, payload: string): Promise<void> {
        await replaceAtomically(lockPath, payload);
    }

    /**
     * Read the payload, retrying a few times. Heartbeats publish atomically
     * now, but a reader can still land on any transient state — and a torn
     * file must never read as a free lock on a single glance.
     */
    private static async readHolder(lockPath: string): Promise<{ status: 'missing' } | { status: 'torn' } | { status: 'ok'; holder: LockInfo }> {
        for (let attempt = 0; ; attempt += 1) {
            let text: string;
            try {
                text = await readFile(lockPath, 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return { status: 'missing' };
                }
                throw error;
            }
            try {
                const parsed = JSON.parse(text) as Partial<LockInfo>;
                if (typeof parsed.pid === 'number' && typeof parsed.vaultPath === 'string') {
                    return { status: 'ok', holder: parsed as LockInfo };
                }
            } catch {
                // Torn mid-rewrite (or garbage): retry below, then judge.
            }
            if (attempt >= 5) {
                return { status: 'torn' };
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    private static async inspect(lockPath: string, probe: LockProbe, now: number): Promise<Verdict> {
        const read = await DaemonLock.readHolder(lockPath);
        if (read.status === 'missing') {
            return { held: false, reason: 'the lock file vanished mid-acquire' };
        }
        if (read.status === 'torn') {
            // An unreadable file that was touched recently belongs to someone
            // alive enough to write: treating it as stale would hand a live
            // lock to a second holder. Fail closed — only an unreadable file
            // older than the stale window may be taken over.
            let ageMs = Number.POSITIVE_INFINITY;
            try {
                ageMs = now - (await stat(lockPath)).mtimeMs;
            } catch {
                return { held: false, reason: 'the lock file vanished mid-acquire' };
            }
            if (ageMs <= LOCK_STALE_MS) {
                return { held: true, holder: null };
            }
            const age = Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s old` : 'missing';
            return { held: false, reason: `its lock file is unreadable and ${age}` };
        }
        const holder = read.holder;
        const bootId = probe.readBootId();
        if (typeof holder.bootId === 'string' && holder.bootId !== '' && bootId !== null && holder.bootId !== bootId) {
            return { held: false, reason: `its owner (pid ${holder.pid}) started on a previous boot` };
        }
        if (probe.isAlive(holder.pid)) {
            return { held: true, holder };
        }
        // The pid looks dead from here — which is also exactly what a live
        // owner in another pid namespace looks like. The heartbeat decides:
        // a fresh one with a matching boot id is a holder we cannot see, and
        // starting twice is the unsafe direction, so refuse.
        const ageMs = await heartbeatAgeMs(lockPath, holder, now);
        if (ageMs <= LOCK_STALE_MS) {
            return {
                held: true,
                holder,
            };
        }
        const age = Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s old` : 'missing';
        return { held: false, reason: `its owner (pid ${holder.pid}) is not running and its heartbeat is ${age}` };
    }

    /**
     * Rewrite the payload on an interval so a live holder's file never reads
     * as stale. Best effort: a holder that can no longer write its lock is
     * indistinguishable from a dead one, and should read that way.
     *
     * The rewrite publishes through a temp file plus `rename`, never
     * truncate-in-place: a concurrent starter sees the old file or the new
     * file, both complete — never a torn half-write it would mistake for a
     * free lock.
     */
    private startHeartbeat(options: AcquireOptions): this {
        const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
        if (heartbeatMs <= 0) {
            return this;
        }
        this.heartbeat = setInterval(() => {
            void (async () => {
                if (this.released) {
                    return;
                }
                try {
                    await DaemonLock.rewrite(this.lockPath, JSON.stringify({ ...this.info, heartbeatAt: new Date().toISOString() }));
                } catch {
                    // The next starter's staleness check is the backstop.
                }
            })();
        }, heartbeatMs);
        this.heartbeat.unref?.();
        return this;
    }

    /**
     * Close and remove the lock file — but only when it is still ours. A
     * successor may hold the name after a takeover this process never
     * noticed; unconditionally unlinking would delete the live lock out from
     * under it. Missing, torn or foreign files are left alone.
     */
    async release(): Promise<void> {
        if (this.released) {
            return;
        }
        this.released = true;
        if (this.heartbeat !== null) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
        try {
            const parsed = JSON.parse(await readFile(this.lockPath, 'utf8')) as Partial<LockInfo>;
            if (parsed.pid === this.info.pid && parsed.startedAt === this.info.startedAt && parsed.vaultPath === this.info.vaultPath) {
                await DaemonLock.unlink(this.lockPath).catch(() => undefined);
            }
        } catch {
            // Not ours to remove.
        }
    }
}

/** Build the lock payload for this process. */
export function thisLockInfo(vaultPath: string, probe: LockProbe = defaultProbe()): LockInfo {
    return {
        pid: process.pid,
        bootId: probe.readBootId(),
        startedAt: new Date().toISOString(),
        vaultPath,
    };
}

/**
 * Hold both lock files. When the second cannot be held, the first is
 * released before throwing, so a failed start never leaves a lock behind.
 */
export async function acquireDaemonLocks(options: {
    dataDirLockPath: string;
    vaultLockPath: string;
    vaultPath: string;
    probe?: LockProbe;
    onTakeover?: (message: string) => void;
    heartbeatMs?: number;
}): Promise<DaemonLock[]> {
    const probe = options.probe ?? defaultProbe();
    const info = thisLockInfo(options.vaultPath, probe);
    const acquireOptions: AcquireOptions = options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {};
    const dataLock = await DaemonLock.acquire(options.dataDirLockPath, info, probe, options.onTakeover, acquireOptions);
    try {
        const vaultLock = await DaemonLock.acquire(options.vaultLockPath, info, probe, options.onTakeover, acquireOptions);
        return [dataLock, vaultLock];
    } catch (error) {
        await dataLock.release();
        throw error;
    }
}

/** Release every lock, even if one release fails. */
export async function releaseLocks(locks: DaemonLock[]): Promise<void> {
    await Promise.all(locks.map((lock) => lock.release()));
}
