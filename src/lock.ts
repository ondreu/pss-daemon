/**
 * Single-instance lock.
 *
 * Node has no `flock(2)`, so the lock is an `O_EXCL` file holding
 * `{pid, bootId, startedAt, vaultPath}`. A lock whose owner is gone (dead
 * pid, or a boot id from before this boot — pid reuse across reboots) is
 * stale and taken over, loudly: the reason is always reported, never acted
 * on silently. The file descriptor stays open for the process lifetime; a
 * crash closes it without deleting the file, which is exactly what the next
 * start's stale detection is for.
 *
 * Two files are held, not one: `<dataDir>/daemon.lock` and
 * `<vault>/.proton-sync/daemon.lock`. Two containers can bind-mount
 * different data dirs over the same vault, and only the vault-side file
 * collides then. This is the correction to the design doc, which named only
 * the data-dir file.
 */
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type LockInfo = {
    pid: number;
    /** Linux boot id; null where it cannot be read (non-Linux, containers without /proc). */
    bootId: string | null;
    startedAt: string;
    vaultPath: string;
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

export class DaemonLock {
    private released = false;

    private constructor(
        readonly lockPath: string,
        readonly info: LockInfo,
        private readonly handle: Awaited<ReturnType<typeof open>>,
    ) {}

    /**
     * Create and hold the lock. Throws {@link LockHeldError} when a live
     * owner holds it; takes over a stale one and reports why via
     * `onTakeover` (defaults to stderr, never silent).
     */
    static async acquire(
        lockPath: string,
        info: LockInfo,
        probe: LockProbe = defaultProbe(),
        onTakeover: (message: string) => void = (message) => process.stderr.write(message + '\n'),
    ): Promise<DaemonLock> {
        await mkdir(path.dirname(lockPath), { recursive: true });
        const payload = JSON.stringify(info);
        try {
            const handle = await open(lockPath, 'wx', 0o600);
            await handle.writeFile(payload, 'utf8');
            return new DaemonLock(lockPath, info, handle);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
        const verdict = await DaemonLock.inspect(lockPath, probe);
        if (verdict.held) {
            throw new LockHeldError(lockPath, verdict.holder);
        }
        onTakeover(describeStale(lockPath, verdict.reason));
        try {
            await unlink(lockPath);
        } catch {
            // Lost a race with another starter; re-read below decides.
        }
        try {
            const handle = await open(lockPath, 'wx', 0o600);
            await handle.writeFile(payload, 'utf8');
            return new DaemonLock(lockPath, info, handle);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
            const again = await DaemonLock.inspect(lockPath, probe);
            throw new LockHeldError(lockPath, again.held ? again.holder : null);
        }
    }

    private static async inspect(lockPath: string, probe: LockProbe): Promise<{ held: true; holder: LockInfo | null } | { held: false; reason: string }> {
        let text: string;
        try {
            text = await readFile(lockPath, 'utf8');
        } catch {
            return { held: false, reason: 'the lock file vanished mid-acquire' };
        }
        let holder: LockInfo | null = null;
        try {
            const parsed = JSON.parse(text) as Partial<LockInfo>;
            if (typeof parsed.pid === 'number' && typeof parsed.vaultPath === 'string') {
                holder = parsed as LockInfo;
            }
        } catch {
            holder = null;
        }
        if (holder === null) {
            return { held: false, reason: 'the lock file is unreadable' };
        }
        const bootId = probe.readBootId();
        if (typeof holder.bootId === 'string' && holder.bootId !== '' && bootId !== null && holder.bootId !== bootId) {
            return { held: false, reason: `its owner (pid ${holder.pid}) started on a previous boot` };
        }
        if (probe.isAlive(holder.pid)) {
            return { held: true, holder };
        }
        return { held: false, reason: `its owner (pid ${holder.pid}) is not running` };
    }

    /** Close and remove the lock file. Missing file is fine (taken over). */
    async release(): Promise<void> {
        if (this.released) {
            return;
        }
        this.released = true;
        await this.handle.close().catch(() => undefined);
        await unlink(this.lockPath).catch(() => undefined);
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
}): Promise<DaemonLock[]> {
    const probe = options.probe ?? defaultProbe();
    const info = thisLockInfo(options.vaultPath, probe);
    const dataLock = await DaemonLock.acquire(options.dataDirLockPath, info, probe, options.onTakeover);
    try {
        const vaultLock = await DaemonLock.acquire(options.vaultLockPath, info, probe, options.onTakeover);
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
