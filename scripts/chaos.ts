/**
 * Chaos/soak runner for the headless daemon's evidence layer.
 *
 * Two writers, one world: W1 mutates the local temp vault through the
 * filesystem, W2 mutates the fake Drive directly, and the real `SyncEngine`
 * (the same class the daemon constructs, over a real `SyncState` on a temp
 * dir) syncs between them on a fixed cadence. The checker runs only at
 * quiescence — mid-flight comparisons measure scheduling, not correctness.
 *
 * Every text mutation appends `tok-<run>-<seq>` on its own line; the ledger
 * (`ledger.jsonl`) maps each token to the paths carrying it, and the verifier
 * reports token coverage, byte-complete conflict copies, pending/retry
 * counts, and tree equality modulo exclusions. Exit non-zero on any P0
 * (lost token, incomplete copy, tree mismatch).
 *
 * Faults ride on `FaultDrive`: throttled transfers (virtual clock, no
 * wall-clock sleeps), periodic 429s/5xx, and simulated SIGKILLs at peak
 * bytes-in-flight via abandon-and-rebuild over the same directories.
 *
 * Usage: `npm --workspace headless run chaos -- --minutes 5 --seed 7`
 *   --minutes N   how long the writers run (default 5)
 *   --seed N      fixed seed for the weighted op choice (default 1)
 *   --kills N     simulated kills at peak in-flight (default: 1, 3 when minutes >= 30)
 *   --out DIR     ledger + samples destination (default: a temp dir, printed at the end)
 *
 * What this is not: the SDK's own retry of 429/5xx, real crash durability
 * (fdatasync/rename), real Proton behavior and real inotify all stay out of
 * reach of a fake. Those are the real-Drive canary (plan §2C), marked E2E.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { sha1Hex } from '../tests/support/treeGen';
import { rateLimitedError, serverError } from '../tests/support/faultDrive';
import { createWorld } from '../tests/support/harness';

// ---------------------------------------------------------------------------
// seeded PRNG + args
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

function args(): { minutes: number; seed: number; kills: number | null; out: string | null } {
    const raw = process.argv.slice(2);
    const get = (name: string): string | null => {
        const index = raw.indexOf(name);
        return index === -1 ? null : (raw[index + 1] ?? null);
    };
    const minutes = Number(get('--minutes') ?? 5);
    const seed = Number(get('--seed') ?? 1);
    const killsRaw = get('--kills');
    return {
        minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 5,
        seed: Number.isFinite(seed) ? seed : 1,
        kills: killsRaw === null ? null : Number(killsRaw),
        out: get('--out'),
    };
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

type OpKind =
    | 'write-new'
    | 'append'
    | 'rename'
    | 'move'
    | 'copy'
    | 'delete-file'
    | 'delete-folder'
    | 'contested-setup'
    | 'folder-delete-vs-edit'
    | 'collide'
    | 'truncate'
    | 'touch';

type LedgerOp = {
    seq: number;
    op: OpKind;
    token: string | null;
    /** More tokens this op created (the remote side of a collide). */
    extraTokens?: string[];
    paths: string[];
    /** A delete whose subtree the other side also touched this window: tokens must survive. */
    contested: boolean;
};

type Version = { sha: string; tokens: string[]; path: string };

const TOKEN = (run: string, seq: number) => `tok-${run}-${seq}`;

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

const EXCLUDED = 'chaos-excluded';

async function main(): Promise<void> {
    const { minutes, seed, kills: killsArg, out } = args();
    const run = `s${seed}`;
    const random = mulberry32(seed);
    const killsRemaining = { count: killsArg ?? (minutes >= 30 ? 3 : 1) };

    const world = await createWorld({
        settings: {
            massDeleteThreshold: 0,
            excludePatterns: [`${EXCLUDED}/**`],
        },
    });
    // Scratch the virtual clock cost of transfers so kill windows exist
    // without spending wall time: bytes advance the clock, never a sleep.
    world.fault.throttleBytesPerSec = 256 * 1024;

    const outDir = out ?? (await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'pss-chaos-')));
    await fs.mkdir(outDir, { recursive: true });
    const ledgerPath = path.join(outDir, 'ledger.jsonl');
    const samplesPath = path.join(outDir, 'samples.jsonl');
    const appendLine = async (file: string, record: unknown) => {
        await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    };

    const ops: LedgerOp[] = [];
    const versions: Version[] = [];
    const versionShas = new Set<string>();
    const pathTokens = new Map<string, string[]>();
    const contestedDirs = new Set<string>();
    const dirtySinceSync = new Set<string>();
    /** Old path -> new path; tokens travel with the content, not the name. */
    const renames = new Map<string, string>();
    const canon = (rel: string): string => {
        let current = rel;
        while (renames.has(current)) {
            current = renames.get(current)!;
        }
        return current;
    };
    let seq = 0;

    const full = (rel: string) => path.join(world.vaultDir, ...rel.split('/'));
    const textOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
    const tokensIn = (text: string): string[] =>
        text.split('\n').filter((line) => line.startsWith(`tok-${run}-`));

    const recordVersion = async (rel: string, local: boolean) => {
        let bytes: Uint8Array | null;
        if (local) {
            try {
                bytes = new Uint8Array(await fs.readFile(full(rel)));
            } catch {
                return;
            }
        } else {
            bytes = world.fault.inner.at(rel)?.revision?.data ?? null;
        }
        if (!bytes) {
            return;
        }
        const text = textOf(bytes);
        const sha = sha1Hex(bytes);
        versionShas.add(sha);
        versions.push({ sha, tokens: tokensIn(text), path: rel });
    };

    const noteTokens = (rel: string, token: string | null) => {
        if (!token) {
            return;
        }
        pathTokens.set(rel, [...(pathTokens.get(rel) ?? []), token]);
    };

    const logOp = async (op: Omit<LedgerOp, 'seq'>) => {
        const entry = { ...op, seq };
        seq += 1;
        ops.push(entry);
        await appendLine(ledgerPath, entry);
    };

    const markDirty = (rel: string) => {
        dirtySinceSync.add(rel);
    };

    // -- local helpers -------------------------------------------------------
    const localFiles = async (): Promise<string[]> => {
        const found: string[] = [];
        const walk = async (dir: string, prefix: string): Promise<void> => {
            for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
                if (entry.isDirectory()) {
                    await walk(path.join(dir, entry.name), rel);
                } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
                    found.push(rel);
                }
            }
        };
        await walk(world.vaultDir, '');
        return found.sort();
    };
    const pick = <T>(items: T[]): T | null => (items.length === 0 ? null : items[Math.floor(random() * items.length)]);

    const localWrite = async (rel: string, text: string) => {
        await fs.mkdir(path.dirname(full(rel)), { recursive: true });
        await fs.writeFile(full(rel), text, 'utf8');
        markDirty(rel);
    };

    // -- ops -----------------------------------------------------------------
    let fileCounter = 0;
    const freshPath = () => `notes/chaos-${seq}-${fileCounter++}.md`;
    const seedContent = (token: string) => `# Chaos note\n\nseed body ${token}\n${token}\n`;

    async function opWriteNew(): Promise<void> {
        const token = TOKEN(run, seq);
        const rel = random() < 0.06 ? `${EXCLUDED}/note-${seq}.md` : freshPath();
        await localWrite(rel, seedContent(token));
        if (random() < 0.5) {
            world.fault.inner.put(rel, seedContent(token));
        }
        noteTokens(rel, token);
        await recordVersion(rel, true);
        await logOp({ op: 'write-new', token, paths: [rel], contested: false });
    }

    async function opAppend(): Promise<void> {
        const files = (await localFiles()).filter((rel) => rel.endsWith('.md') && !rel.startsWith(EXCLUDED));
        const rel = pick(files);
        if (!rel) {
            return opWriteNew();
        }
        const token = TOKEN(run, seq);
        await fs.appendFile(full(rel), `append ${token}\n${token}\n`, 'utf8');
        markDirty(rel);
        noteTokens(rel, token);
        await recordVersion(rel, true);
        await logOp({ op: 'append', token, paths: [rel], contested: false });
    }

    async function opRenameOrMove(): Promise<void> {
        const files = (await localFiles()).filter((rel) => rel.endsWith('.md') && !rel.startsWith(EXCLUDED));
        const rel = pick(files);
        if (!rel) {
            return opWriteNew();
        }
        const dir = random() < 0.4 ? `moved/a${Math.floor(random() * 3)}` : rel.split('/').slice(0, -1).join('/');
        const next = `${dir === '' ? 'notes' : dir}/renamed-${seq}.md`;
        await fs.mkdir(path.dirname(full(next)), { recursive: true });
        await fs.rename(full(rel), full(next));
        markDirty(rel);
        markDirty(next);
        // One-sided local rename: the remote node stays behind, and the
        // engine follows it by content on the next pass.
        const history = pathTokens.get(rel) ?? [];
        pathTokens.delete(rel);
        pathTokens.set(next, history);
        renames.set(rel, next);
        await logOp({ op: dir === rel.split('/').slice(0, -1).join('/') ? 'rename' : 'move', token: null, paths: [rel, next], contested: false });
    }

    async function opCopy(): Promise<void> {
        const files = (await localFiles()).filter((rel) => rel.endsWith('.md') && !rel.startsWith(EXCLUDED));
        const rel = pick(files);
        if (!rel) {
            return opWriteNew();
        }
        const token = TOKEN(run, seq);
        const next = `notes/copy-${seq}.md`;
        const body = await fs.readFile(full(rel), 'utf8');
        await localWrite(next, `${body}copied ${token}\n${token}\n`);
        noteTokens(next, token);
        await recordVersion(next, true);
        await logOp({ op: 'copy', token, paths: [next], contested: false });
    }

    async function opDeleteFile(): Promise<void> {
        const files = (await localFiles()).filter((rel) => rel.endsWith('.md') && !rel.startsWith(EXCLUDED));
        const rel = pick(files);
        if (!rel) {
            return opWriteNew();
        }
        const contested = dirtySinceSync.has(rel);
        if (random() < 0.5) {
            await fs.unlink(full(rel));
        } else {
            world.fault.inner.trash(rel);
        }
        markDirty(rel);
        await logOp({ op: 'delete-file', token: null, paths: [rel], contested });
    }

    async function opDeleteFolder(): Promise<void> {
        const dirs = [...contestedDirs].filter((dir) => dir !== '');
        const dir = pick(dirs) ?? `moved/a${Math.floor(random() * 3)}`;
        const contested = [...dirtySinceSync].some((rel) => rel === dir || rel.startsWith(`${dir}/`));
        if (random() < 0.5) {
            await fs.rm(full(dir), { recursive: true, force: true });
        } else {
            world.fault.inner.trash(dir);
        }
        markDirty(dir);
        contestedDirs.delete(dir);
        await logOp({ op: 'delete-folder', token: null, paths: [dir], contested });
    }

    async function opContestedSetup(): Promise<void> {
        const dir = `contested-${seq}`;
        contestedDirs.add(dir);
        const token = TOKEN(run, seq);
        await localWrite(`${dir}/note.md`, `# Contested\n\n${token}\n`);
        await localWrite(`${dir}/other.md`, `# Other\n\n${token}\n`);
        noteTokens(`${dir}/note.md`, token);
        noteTokens(`${dir}/other.md`, token);
        await recordVersion(`${dir}/note.md`, true);
        await logOp({ op: 'contested-setup', token, paths: [dir], contested: false });
    }

    async function opFolderDeleteVsEdit(): Promise<void> {
        if (contestedDirs.size === 0) {
            return opContestedSetup();
        }
        const dir = pick([...contestedDirs])!;
        contestedDirs.delete(dir);
        const token = TOKEN(run, seq);
        if (random() < 0.5) {
            await fs.rm(full(dir), { recursive: true, force: true });
            world.fault.inner.put(`${dir}/note.md`, `# Contested\n\nremote edit ${token}\n${token}\n`);
        } else {
            world.fault.inner.trash(dir);
            await localWrite(`${dir}/note.md`, `# Contested\n\nlocal edit ${token}\n${token}\n`);
        }
        noteTokens(`${dir}/note.md`, token);
        markDirty(`${dir}/note.md`);
        await logOp({ op: 'folder-delete-vs-edit', token, paths: [dir], contested: true });
    }

    async function opCollide(): Promise<void> {
        const files = (await localFiles()).filter((rel) => rel.endsWith('.md') && !rel.startsWith(EXCLUDED));
        const rel = pick(files) ?? freshPath();
        const localToken = TOKEN(run, seq);
        const remoteToken = `${TOKEN(run, seq)}-remote`;
        try {
            const body = await fs.readFile(full(rel), 'utf8');
            await fs.writeFile(full(rel), `${body}local ${localToken}\n${localToken}\n`, 'utf8');
        } catch {
            await localWrite(rel, `fresh ${localToken}\n${localToken}\n`);
        }
        const remoteBody = world.fault.inner.text(rel) ?? `fresh ${remoteToken}\n`;
        world.fault.inner.put(rel, `${remoteBody}remote ${remoteToken}\n${remoteToken}\n`);
        markDirty(rel);
        noteTokens(rel, localToken);
        noteTokens(rel, remoteToken);
        await recordVersion(rel, true);
        await recordVersion(rel, false);
        await logOp({ op: 'collide', token: localToken, extraTokens: [remoteToken], paths: [rel], contested: true });
    }

    async function opTruncate(): Promise<void> {
        const files = (await localFiles()).filter((rel) => rel.endsWith('.md') && !rel.startsWith(EXCLUDED));
        const rel = pick(files);
        if (!rel) {
            return opWriteNew();
        }
        await fs.truncate(full(rel), 0);
        markDirty(rel);
        await logOp({ op: 'truncate', token: null, paths: [rel], contested: dirtySinceSync.has(rel) });
    }

    async function opTouch(): Promise<void> {
        const files = await localFiles();
        const rel = pick(files);
        if (!rel) {
            return opWriteNew();
        }
        const now = new Date();
        await fs.utimes(full(rel), now, now);
        await logOp({ op: 'touch', token: null, paths: [rel], contested: false });
    }

    const table: { weight: number; run: () => Promise<void> }[] = [
        { weight: 20, run: opWriteNew },
        { weight: 20, run: opAppend },
        { weight: 10, run: opRenameOrMove },
        { weight: 8, run: opRenameOrMove },
        { weight: 5, run: opCopy },
        { weight: 7, run: opDeleteFile },
        { weight: 3, run: opDeleteFolder },
        { weight: 5, run: opContestedSetup },
        { weight: 5, run: opFolderDeleteVsEdit },
        { weight: 12, run: opCollide },
        { weight: 3, run: opTruncate },
        { weight: 2, run: opTouch },
    ];
    const totalWeight = table.reduce((sum, entry) => sum + entry.weight, 0);

    const choose = (): (() => Promise<void>) => {
        let roll = random() * totalWeight;
        for (const entry of table) {
            roll -= entry.weight;
            if (roll < 0) {
                return entry.run;
            }
        }
        return opAppend;
    };

    // -- seed ------------------------------------------------------------------
    for (let i = 0; i < 30; i++) {
        await opWriteNew();
    }
    await world.sync();
    dirtySinceSync.clear();

    // Background fault weather: occasional 429s and a mid-run 5xx streak, as
    // SDK-shaped errors the engine must ride out without deleting.
    world.fault.failEvery('iterateNodes', 29, () => {
        world.fault.recordRateLimited();
        return rateLimitedError();
    });

    // -- run -------------------------------------------------------------------
    const deadline = Date.now() + minutes * 60_000;
    const passDurations: number[] = [];
    let passes = 0;
    let opsDone = 0;
    let kills = 0;
    let lastSample = 0;
    const startedAt = Date.now();

    const sample = async (force: boolean): Promise<void> => {
        const now = Date.now();
        if (!force && now - lastSample < 60_000) {
            return;
        }
        lastSample = now;
        const memory = process.memoryUsage();
        const sorted = [...passDurations].sort((a, b) => a - b);
        const quantile = (q: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
        await appendLine(samplesPath, {
            t: new Date(now).toISOString(),
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            passMsP50: quantile(0.5),
            passMsP99: quantile(0.99),
            passes,
            ops: opsDone,
            retryDepth: world.state.retryEntries().length,
            pending: world.engine.pendingChanges().length,
            localFiles: (await localFiles()).length,
            remoteFiles: world.fault.inner.filePaths().length,
            uploads: world.fault.completedUploads,
            downloads: world.fault.completedDownloads,
            kills,
        });
    };

    const syncAndMaybeKill = async (): Promise<void> => {
        const begin = Date.now();
        // A kill lands inside a pass, not between them: every few syncs, park
        // a transfer at its commit point, drop the engine the way a SIGKILL
        // would, and rebuild. The parked commit is released afterwards, which
        // models "bytes reached the server, the ack never came back".
        const killThisPass = killsRemaining.count > 0 && passes > 5 && passes % 7 === 3;
        let releaseKill: (() => void) | null = null;
        let enteredKill: Promise<void> | null = null;
        if (killThisPass) {
            let enteredResolve!: () => void;
            enteredKill = new Promise<void>((resolve) => (enteredResolve = resolve));
            const hold = new Promise<void>((resolve) => {
                releaseKill = resolve;
            });
            let held = false;
            world.fault.holdUploadCommit = async () => {
                if (!held) {
                    held = true;
                    enteredResolve();
                    await hold;
                }
            };
            world.fault.holdDownloadStart = async () => {
                if (!held) {
                    held = true;
                    enteredResolve();
                    await hold;
                }
            };
        }
        if (enteredKill) {
            const pass = world.sync();
            void pass.catch(() => undefined);
            const raced = await Promise.race([
                enteredKill.then(() => true),
                // Transfers are near-certain (ten mutating ops per sync), so a
                // pass with nothing to park is the rare case: skip the kill.
                new Promise<boolean>((resolve) => setTimeout(resolve, 15_000)),
            ]);
            world.fault.holdUploadCommit = null;
            world.fault.holdDownloadStart = null;
            if (raced) {
                killsRemaining.count -= 1;
                kills += 1;
                await appendLine(ledgerPath, { seq, op: 'kill', peakInFlight: world.fault.peakInFlightBytes });
                seq += 1;
                await world.rebuildAfterKill();
            }
            releaseKill?.();
            await pass.catch(() => undefined);
            // The dead pass may still flush its stale state after the release;
            // the next passes reconverge, which is exactly what is verified.
            await world.sync();
            passes += 2;
        } else {
            await world.sync();
            passes += 1;
        }
        passDurations.push(Date.now() - begin);
        dirtySinceSync.clear();
        await sample(false);
    };

    let streakArmed = false;
    while (Date.now() < deadline - 30_000) {
        if (!streakArmed && Date.now() - startedAt > ((deadline - startedAt) * 2) / 3) {
            streakArmed = true;
            world.fault.failNext('iterateNodes', 25, () => serverError(500, 'Internal error (fault injection)'));
            world.fault.failNext('getNode', 25, () => serverError(500, 'Internal error (fault injection)'));
        }
        await choose()();
        opsDone += 1;
        if (opsDone % 10 === 0) {
            await syncAndMaybeKill();
        }
    }
    await sample(true);

    // -- quiesce -----------------------------------------------------------------
    world.fault.clearFaults();
    dirtySinceSync.clear();
    let lastTransfers = world.fault.completedUploads + world.fault.completedDownloads;
    for (let i = 0; i < 12; i++) {
        const begin = Date.now();
        await world.sync();
        passDurations.push(Date.now() - begin);
        passes += 1;
        const transfers = world.fault.completedUploads + world.fault.completedDownloads;
        const still = transfers === lastTransfers;
        lastTransfers = transfers;
        if (still && world.state.retryEntries().length === 0 && world.engine.pendingChanges().length === 0) {
            // One more pass to prove stillness, not just a lucky gap.
            await world.sync();
            passes += 1;
            lastTransfers = world.fault.completedUploads + world.fault.completedDownloads;
            if (world.state.retryEntries().length === 0 && world.engine.pendingChanges().length === 0) {
                break;
            }
        }
    }
    await sample(true);

    // -- verify ------------------------------------------------------------------
    const failures: string[] = [];
    const isExcluded = (rel: string) => rel === EXCLUDED || rel.startsWith(`${EXCLUDED}/`);
    const isCopy = (rel: string) => rel.includes('(conflict ');

    // Token coverage: every non-deleted token found locally, remotely, or in
    // a complete copy — unless the ledger shows a clean one-sided delete, a
    // later in-policy sequential edit, or an excluded path.
    const blobs: { rel: string; text: string; sha: string; remote: boolean }[] = [];
    for (const rel of await localFiles()) {
        if (isExcluded(rel)) {
            continue;
        }
        const bytes = new Uint8Array(await fs.readFile(full(rel)));
        blobs.push({ rel, text: textOf(bytes), sha: sha1Hex(bytes), remote: false });
    }
    for (const rel of world.fault.inner.filePaths()) {
        const node = world.fault.inner.at(rel);
        if (node?.revision) {
            blobs.push({ rel, text: textOf(node.revision.data), sha: sha1Hex(node.revision.data), remote: true });
        }
    }
    const foundTokens = new Set<string>();
    for (const blob of blobs) {
        for (const token of tokensIn(blob.text)) {
            foundTokens.add(token);
        }
    }
    const opByToken = new Map<string, LedgerOp>();
    const coverTokens: { token: string; op: LedgerOp }[] = [];
    for (const op of ops) {
        if (op.op === 'kill') {
            continue;
        }
        if (op.token) {
            opByToken.set(op.token, op);
            coverTokens.push({ token: op.token, op });
        }
        for (const extra of op.extraTokens ?? []) {
            opByToken.set(extra, op);
            coverTokens.push({ token: extra, op });
        }
    }
    let tokensCreated = 0;
    let tokensCovered = 0;
    let tokensExcused = 0;
    const lost: string[] = [];
    for (const { token, op } of coverTokens) {
        tokensCreated += 1;
        if (foundTokens.has(token)) {
            tokensCovered += 1;
            continue;
        }
        const canonPaths = op.paths.map(canon);
        const history = pathTokens.get(canon(op.paths[0])) ?? [];
        const later = history.slice(history.indexOf(token) + 1);
        const superseded = later.some((laterToken) => foundTokens.has(laterToken));
        const deletedAfter = ops.some(
            (other) =>
                other.seq > op.seq &&
                (other.op === 'delete-file' || other.op === 'delete-folder') &&
                other.paths.map(canon).some((p) => canonPaths.some((mine) => mine === p || mine.startsWith(`${p}/`))) &&
                !other.contested,
        );
        if (isExcluded(op.paths[0]) || ((superseded || deletedAfter) && !op.contested && op.op !== 'collide')) {
            tokensExcused += 1;
            continue;
        }
        lost.push(token);
    }
    if (lost.length > 0) {
        failures.push(`P0 lost tokens (${lost.length}): ${lost.slice(0, 10).join(', ')}`);
    }

    // Copies complete: every conflict copy's bytes must equal a recorded
    // version — a partial copy is data loss wearing a conflict's clothes.
    const copies = blobs.filter((blob) => isCopy(blob.rel));
    const incomplete = copies.filter((copy) => !versionShas.has(copy.sha));
    if (incomplete.length > 0) {
        failures.push(`P0 incomplete copies (${incomplete.length}): ${incomplete.slice(0, 5).map((copy) => copy.rel).join(', ')}`);
    }

    // Pending/retries drained at quiescence.
    const pending = world.engine.pendingChanges();
    const retries = world.state.retryEntries();
    if (pending.length > 0) {
        failures.push(`pending changes at quiescence (${pending.length}): ${pending.slice(0, 5).map((change) => `${change.path}:${change.reason}`).join(', ')}`);
    }
    if (retries.length > 0) {
        failures.push(`retries queued at quiescence (${retries.length})`);
    }

    // Tree equality modulo exclusions: live paths match by hash on both sides.
    const localLive = new Map<string, string>();
    for (const blob of blobs) {
        if (!blob.remote && !isCopy(blob.rel)) {
            localLive.set(blob.rel, blob.sha);
        }
    }
    const remoteLive = new Map<string, string>();
    for (const blob of blobs) {
        if (blob.remote && !isCopy(blob.rel)) {
            remoteLive.set(blob.rel, blob.sha);
        }
    }
    const missingRemote = [...localLive.keys()].filter((rel) => !remoteLive.has(rel));
    const missingLocal = [...remoteLive.keys()].filter((rel) => !localLive.has(rel));
    const diverged = [...localLive.keys()].filter((rel) => remoteLive.has(rel) && remoteLive.get(rel) !== localLive.get(rel));
    if (missingRemote.length > 0 || missingLocal.length > 0 || diverged.length > 0) {
        failures.push(
            `P0 tree mismatch: ${missingRemote.length} missing remotely, ${missingLocal.length} missing locally, ${diverged.length} diverged` +
                [...missingRemote.slice(0, 3), ...missingLocal.slice(0, 3), ...diverged.slice(0, 3)].join(', '),
        );
    }
    // Copies converge too: the same copy set on both sides.
    const localCopies = new Set(blobs.filter((blob) => !blob.remote && isCopy(blob.rel)).map((blob) => `${blob.rel}:${blob.sha}`));
    const remoteCopies = new Set(blobs.filter((blob) => blob.remote && isCopy(blob.rel)).map((blob) => `${blob.rel}:${blob.sha}`));
    const copyDiff = [...localCopies, ...remoteCopies].filter((key) => !(localCopies.has(key) && remoteCopies.has(key)));
    if (copyDiff.length > 0) {
        failures.push(`P0 conflict-copy asymmetry (${copyDiff.length}): ${copyDiff.slice(0, 5).join(', ')}`);
    }

    const wallMs = Date.now() - startedAt;
    const summary = {
        run,
        seed,
        wallSeconds: Math.round(wallMs / 1000),
        ops: opsDone,
        passes,
        kills,
        tokensCreated,
        tokensCovered,
        tokensExcused,
        tokensLost: lost.length,
        conflicts: world.conflicts.length,
        copies: copies.length,
        uploads: world.fault.completedUploads,
        downloads: world.fault.completedDownloads,
        failures,
        outDir,
    };
    await appendLine(samplesPath, { summary: true, ...summary });
    console.log(JSON.stringify(summary, null, 2));

    const deletes = world.fault.deleteCalls().length;
    console.log(`delete-shaped remote calls: ${deletes} (all policy deletes by construction)`);

    await world.close();
    if (failures.length > 0) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 2;
});
