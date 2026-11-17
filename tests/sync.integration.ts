/**
 * Integration evidence for the headless daemon: the real `SyncEngine` plus
 * the real `SyncState` on temp dirs, against the fault-injecting fake Drive.
 *
 * Each case maps to a failure in `docs/headless-daemon-test-plan.md` (§1)
 * and asserts only on effects — file bytes, content hashes, the fake's call
 * log, pending/retry state — never on log strings. The kill cases drop the
 * engine mid-`await` and rebuild over the same directories, which is what a
 * SIGKILL looks like from inside the process: timers cancelled, nothing
 * flushed, the parked promise never resumed.
 *
 * Run: `npm --workspace headless run test:integration`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { requestStats } from '../../src/util/requestStats';
import { LARGE_FILE_BYTES } from '../../src/sync/vault';
import {
    CASE_RENAME_FILE,
    LARGE_FILE,
    NFC_TWIN,
    NFD_TWIN,
    appendToken,
    buildBaseTree,
    hashTree,
    readText,
    sha1Hex,
    touchChurn,
    walkFiles,
    writeBytes,
    writeText,
} from './support/treeGen';
import { deferred, rateLimitedError, serverError, unauthorizedError } from './support/faultDrive';
import {
    conflictCopies,
    createWorld,
    localBytes,
    localText,
    remoteBytes,
    remoteRevisionBytes,
    remoteRevisionUids,
    remoteText,
    type World,
} from './support/harness';

const full = (world: World, rel: string) => path.join(world.vaultDir, ...rel.split('/'));

function mb(bytes: number): Buffer {
    // Deterministic pseudo-random bytes: incompressible enough that hashing
    // costs what real attachments cost, reproducible across runs.
    const out = Buffer.alloc(bytes);
    let state = 0x12345678;
    for (let i = 0; i < bytes; i++) {
        state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
        out[i] = state & 0xff;
    }
    return out;
}

describe('kill durability (#1 SIGKILL mid-write, #2 SIGKILL mid-upload)', () => {
    it('#1: a write killed mid-flight leaves the old or the new version, never a mix', async () => {
        const world = await createWorld();
        try {
            await writeText(world.vaultDir, 'notes/seed.md', 'seed\n');
            await world.sync();

            // A new remote file starts a download into a path that does not
            // exist locally: the write goes through createBinary into
            // adapter.writeBinary, held open here, then the engine is dropped
            // exactly as a SIGKILL would drop it. The parked write is never
            // released: the process is gone.
            const rel = 'notes/big-new.md';
            const v2 = 'v2-line\n'.repeat(700_000);
            world.fault.inner.put(rel, v2);
            const gate = deferred();
            let enteredResolve!: () => void;
            const entered = new Promise<void>((resolve) => (enteredResolve = resolve));
            const adapter = world.vault.app.vault.adapter;
            const originalWrite = adapter.writeBinary.bind(adapter);
            adapter.writeBinary = (async (p: string, data: ArrayBuffer, options?: { mtime?: number }) => {
                if (p === rel) {
                    enteredResolve();
                    await gate.untilReleased;
                }
                return originalWrite(p, data, options);
            }) as typeof adapter.writeBinary;

            const pass = world.sync();
            void pass.catch(() => undefined);
            await entered;
            await world.rebuildAfterKill();
            adapter.writeBinary = originalWrite;
            await world.sync();
            await world.sync();

            // The killed write never landed, so the new engine downloads the
            // remote version whole: old or new, never a mix.
            assert.equal(await localText(world, rel), v2, 'local converged to the complete new version');
            assert.equal(remoteRevisionUids(world, rel).length, 1, 'one revision, no duplicate from the kill');
            const leftovers = (await walkFiles(world.vaultDir)).filter((file) => file.includes('.proton-sync.tmp'));
            assert.deepEqual(leftovers, [], 'no write debris left behind');

            // A genuinely torn file — first half of the new bytes on disk —
            // syncs exactly what survived: the engine hashes what is there.
            await writeText(world.vaultDir, rel, v2.slice(0, Math.floor(v2.length / 2)));
            await world.sync();
            assert.equal(remoteText(world, rel), await localText(world, rel), 'torn bytes sync exactly once');
            assert.equal(remoteRevisionUids(world, rel).length, 2, 'one revision for the torn write');
        } finally {
            await world.close();
        }
    });

    it('#2: a kill between bytes-sent and commit re-uploads once, with no torn revision', async () => {
        const world = await createWorld();
        try {
            const rel = 'notes/upload.bin';
            const v1 = mb(4 * 1024 * 1024);
            await writeBytes(world.vaultDir, rel, v1);
            await world.sync();
            assert.equal(remoteRevisionUids(world, rel).length, 1, 'one revision after the first upload');
            const uploadsBefore = world.fault.completedUploads;

            const v2 = mb(4 * 1024 * 1024).fill(0xcd, 0, 1024);
            await writeBytes(world.vaultDir, rel, v2);
            let enteredResolve!: () => void;
            const entered = new Promise<void>((resolve) => (enteredResolve = resolve));
            const hold = deferred();
            world.fault.holdUploadCommit = async () => {
                enteredResolve();
                await hold.untilReleased;
            };
            const pass = world.sync();
            void pass.catch(() => undefined);
            await entered;
            // Dead before the commit: the revision never lands, and the parked
            // upload is never resumed — the process is gone.
            await world.rebuildAfterKill();
            world.fault.holdUploadCommit = null;
            await world.sync();

            assert.equal(remoteRevisionUids(world, rel).length, 2, 'exactly one new revision after the kill');
            assert.ok(Buffer.from(remoteBytes(world, rel)!).equals(v2), 'remote holds the complete new bytes');
            assert.ok((await localBytes(world, rel))!.equals(v2), 'local holds the complete new bytes');
            assert.equal(world.fault.completedUploads, uploadsBefore + 1, 'the new engine re-uploaded exactly once');
        } finally {
            await world.close();
        }
    });
});

describe('conflicts and races (#8, #13, #14, #15)', () => {
    it('#8: daemon-vs-GUI edit keeps both complete versions, one live and one copy', async () => {
        const world = await createWorld();
        try {
            const rel = 'notes/shared.md';
            const base = 'line1\nline2\n';
            await writeText(world.vaultDir, rel, base);
            await world.sync();

            await writeText(world.vaultDir, rel, 'line1\nLOCAL\n');
            world.fault.inner.put(rel, 'line1\nREMOTE\n');
            await world.sync();

            const copies = await conflictCopies(world.vaultDir);
            assert.equal(copies.length, 1, `exactly one conflict copy, found ${JSON.stringify(copies)}`);
            const live = await localText(world, rel);
            const copy = await readText(world.vaultDir, copies[0]);
            assert.deepEqual(
                new Set([live, copy]),
                new Set(['line1\nLOCAL\n', 'line1\nREMOTE\n']),
                'both byte-versions present and complete',
            );
            assert.equal(world.conflicts.filter((event) => event.path === rel).length, 1, 'one conflict event');
        } finally {
            await world.close();
        }
    });

    it('#13: delete-vs-edit race keeps the edited bytes at the path or in a copy', async () => {
        const world = await createWorld();
        try {
            const rel = 'notes/raced.md';
            await writeText(world.vaultDir, rel, 'base\n'.repeat(200));
            await world.sync();

            const edited = 'edited\n'.repeat(200);
            world.fault.inner.put(rel, edited);
            // Hold the download after its first chunk; the local delete lands
            // while the edited bytes are still in flight.
            const hold = deferred();
            let enteredResolve!: () => void;
            const entered = new Promise<void>((resolve) => (enteredResolve = resolve));
            let held = false;
            world.fault.holdDownloadStart = async () => {
                if (!held) {
                    held = true;
                    enteredResolve();
                    await hold.untilReleased;
                }
            };
            const pass = world.sync();
            await entered;
            await fs.unlink(full(world, rel));
            hold.release();
            await pass;
            world.fault.holdDownloadStart = null;
            await world.sync();

            const live = await localText(world, rel);
            const copies = await conflictCopies(world.vaultDir);
            const copyTexts = await Promise.all(copies.map((copy) => readText(world.vaultDir, copy)));
            const survived = live === edited || copyTexts.includes(edited);
            assert.ok(survived, 'edited bytes survive at the path or in a complete copy');
            assert.equal(
                world.fault.deleteCalls().length,
                0,
                'the race deleted nothing remotely',
            );
        } finally {
            await world.close();
        }
    });

    for (const depth of [1, 3]) {
        const folderAt = (root: string) => (depth === 1 ? root : `${root}/a/b/c`);
        it(`#14: folder-delete-vs-edit both directions at depth ${depth}`, async () => {
            const world = await createWorld();
            try {
                // Direction A: local folder delete vs remote file edit.
                const dirA = folderAt('folderA');
                await writeText(world.vaultDir, `${dirA}/note.md`, 'base A\n');
                await writeText(world.vaultDir, `${dirA}/sibling.md`, 'sibling A\n');
                // Direction B: remote folder trash vs local file edit.
                const dirB = folderAt('folderB');
                await writeText(world.vaultDir, `${dirB}/note.md`, 'base B\n');
                await writeText(world.vaultDir, `${dirB}/sibling.md`, 'sibling B\n');
                await world.sync();

                await fs.rm(path.join(world.vaultDir, ...dirA.split('/')), { recursive: true, force: true });
                world.fault.inner.put(`${dirA}/note.md`, 'edited A\n');
                world.fault.inner.trash(dirB);
                await writeText(world.vaultDir, `${dirB}/note.md`, 'edited B\n');
                await world.sync();

                // Direction A: the edited file survives, locally or in a copy.
                const liveA = await localText(world, `${dirA}/note.md`);
                const copiesA = (await conflictCopies(world.vaultDir)).filter((copy) => copy.startsWith(`${dirA}/`));
                const copyTextsA = await Promise.all(copiesA.map((copy) => readText(world.vaultDir, copy)));
                assert.ok(
                    liveA === 'edited A\n' || copyTextsA.includes('edited A\n'),
                    'direction A: edited bytes survive the folder delete',
                );
                assert.equal(remoteText(world, `${dirA}/note.md`), 'edited A\n', 'direction A: remote keeps the edit');
                // Direction B: the local edit survives, and the remote converges to it.
                assert.equal(await localText(world, `${dirB}/note.md`), 'edited B\n', 'direction B: local edit survives');
                assert.equal(remoteText(world, `${dirB}/note.md`), 'edited B\n', 'direction B: remote converges to the edit');
                const conflictsHere = world.conflicts.filter(
                    (event) => event.path === `${dirA}/note.md` || event.path === `${dirB}/note.md`,
                );
                assert.ok(conflictsHere.length <= 2, `at most one notice per path, saw ${conflictsHere.length}`);
            } finally {
                await world.close();
            }
        });
    }

    it('#15: truncation to empty keeps the prior version in history before emptying the remote', async () => {
        const world = await createWorld();
        try {
            const rel = 'notes/truncate.md';
            const prior = 'keep me\n'.repeat(700);
            await writeText(world.vaultDir, rel, prior);
            await world.sync();
            const before = remoteRevisionUids(world, rel);
            assert.equal(before.length, 1);

            await fs.truncate(full(world, rel), 0);
            await world.sync();

            const after = remoteRevisionUids(world, rel);
            assert.equal(after.length, 2, 'the empty edit uploaded as a new revision, history intact');
            assert.equal(remoteText(world, rel), '', 'remote is now empty');
            const kept = await remoteRevisionBytes(world, rel, before[0]);
            assert.equal(kept?.toString('utf8'), prior, 'the prior bytes are still in revision history');
            assert.equal(await localText(world, rel), '', 'local stays truncated, not reverted');
        } finally {
            await world.close();
        }
    });
});

describe('steady-state correctness (#11, #12, #19, #20)', () => {
    it('#11: mtime-preserving restore is a no-op with zero transfers', async () => {
        const world = await createWorld();
        try {
            await buildBaseTree(world.vaultDir, { largeBytes: 0 });
            // Two passes to quiescence first: the first pass uploads the
            // NFD/NFC twins as-is, the second settles their spellings. Only
            // then is the tree still enough to measure a no-op.
            await world.sync();
            await world.sync();
            world.fault.clearLog();
            const uploadsBefore = world.fault.completedUploads;
            const downloadsBefore = world.fault.completedDownloads;

            // What `cp -a` / `rsync -a` / `git checkout` do: identical bytes, preserved mtimes.
            for (const rel of await walkFiles(world.vaultDir)) {
                const p = full(world, rel);
                const stat = await fs.stat(p);
                const bytes = await fs.readFile(p);
                await fs.writeFile(p, bytes);
                await fs.utimes(p, stat.atime, stat.mtime);
            }
            await world.sync();

            assert.equal(world.fault.completedUploads, uploadsBefore, 'no uploads on identical bytes');
            assert.equal(world.fault.completedDownloads, downloadsBefore, 'no downloads on identical bytes');
            assert.deepEqual(
                world.fault.calls.filter((call) => call.method === 'uploadFromStream' || call.method === 'downloadToStream'),
                [],
                'no transfer calls at all',
            );
        } finally {
            await world.close();
        }
    });

    it('#12: a twice-renamed folder follows as renames, not delete+create pairs', async () => {
        const world = await createWorld();
        try {
            for (let i = 0; i < 40; i++) {
                await writeText(world.vaultDir, `move/note-${i}.md`, `# Note ${i}\n\nbody ${i}\n`);
            }
            await world.sync();
            const uploadsBefore = world.fault.completedUploads;

            await fs.rename(full(world, 'move'), full(world, 'moved'));
            await world.sync();
            await fs.rename(full(world, 'moved'), full(world, 'final'));
            await world.sync();

            assert.equal(world.fault.completedUploads, uploadsBefore, 'renames move no content');
            const local = await hashTree(world.vaultDir);
            const remote = new Map<string, string>();
            for (const rel of world.fault.inner.filePaths()) {
                const node = world.fault.inner.at(rel);
                if (node?.revision) {
                    remote.set(rel, sha1Hex(node.revision.data));
                }
            }
            const localNotes = [...local.entries()].filter(([rel]) => rel.startsWith('final/'));
            assert.equal(localNotes.length, 40, 'all notes under the final name');
            for (const [rel, hash] of localNotes) {
                assert.equal(remote.get(rel), hash, `${rel} matches remotely`);
            }
            assert.deepEqual(await conflictCopies(world.vaultDir), [], 'no conflict copies from renames');
        } finally {
            await world.close();
        }
    });

    it('#19: NFD/NFC twins never collapse and a case-only rename keeps one node', async () => {
        const world = await createWorld();
        try {
        await buildBaseTree(world.vaultDir, { largeBytes: 0 });
        await world.sync();
        // The second pass settles spellings: the NFD name is renamed on
        // Drive to the vault spelling, disambiguated because the NFC twin
        // owns it. Both byte-versions must survive, not collapse.
        await world.sync();
        await world.sync();
        await world.sync();

            const twinBytes = '# Caf\u00e9\n\nsame bytes, either spelling\n';
            const remoteUnicode = world.fault.inner.filePaths().filter((rel) => rel.startsWith('unicode/'));
            assert.equal(remoteUnicode.length, 2, `two remote twins, saw ${JSON.stringify(remoteUnicode)}`);
            assert.ok(remoteUnicode.includes(NFC_TWIN), 'the NFC spelling keeps its name');
            for (const rel of remoteUnicode) {
                assert.equal(remoteText(world, rel), twinBytes, `${rel} carries the complete twin bytes`);
            }
            const localUnicode = (await walkFiles(world.vaultDir)).filter((rel) => rel.startsWith('unicode/'));
            assert.equal(localUnicode.length, 2, `two local twins, saw ${JSON.stringify(localUnicode)}`);
            for (const rel of localUnicode) {
                assert.equal(await localText(world, rel), twinBytes, `${rel} carries the complete twin bytes`);
            }
            const spellingConflicts = world.conflicts.filter((event) => event.reason === 'name-spelling');
            assert.equal(spellingConflicts.length, 1, 'one spelling notice, not silent and not looping');

            const uidBefore = world.state.get(CASE_RENAME_FILE)?.nodeUid;
            assert.ok(uidBefore, 'rename target has a record');
            await fs.rename(full(world, CASE_RENAME_FILE), full(world, 'cases/NOTE.md'));
            await world.sync();

            assert.equal(world.state.get('cases/NOTE.md')?.nodeUid, uidBefore, 'one node uid across the case-only rename');
            assert.equal(remoteText(world, 'cases/NOTE.md'), '# Note\n\ncase rename target\n', 'bytes follow the rename');
            assert.equal(remoteText(world, 'cases/note.md'), '# note\n\ndistinct lowercase file\n', 'the distinct lowercase file is untouched');
            assert.deepEqual(await conflictCopies(world.vaultDir), [], 'no copies from the rename');
        } finally {
            await world.close();
        }
    });

    it('#20: .obsidian churn settles to a no-op second pass', async () => {
        const world = await createWorld();
        try {
            // Small tree on purpose: this measures pass quietness, and the
            // unicode twins settle with their own writes on the second pass.
            await writeText(world.vaultDir, 'notes/a.md', '# A\n');
            await writeText(world.vaultDir, '.obsidian/app.json', '{}\n');
            await world.sync();

            await touchChurn(world.vaultDir, 50);
            await world.sync();

            world.fault.clearLog();
            const uploadsBefore = world.fault.completedUploads;
            const downloadsBefore = world.fault.completedDownloads;
            await world.sync();
            assert.equal(world.fault.completedUploads, uploadsBefore, 'second pass uploads nothing');
            assert.equal(world.fault.completedDownloads, downloadsBefore, 'second pass downloads nothing');
        } finally {
            await world.close();
        }
    });

    it('#20: plugin code never syncs into a shared folder', async () => {
        const world = await createWorld();
        try {
            // Code exclusions guard folders other accounts can write to; make
            // the fake read as someone else's Drive from the first pass.
            world.fault.inner.myFilesScope = 'other-scope';
            await buildBaseTree(world.vaultDir, { largeBytes: 0 });
            await writeText(world.vaultDir, '.obsidian/plugins/proton-drive-sync/main.js', 'code\n');
            await world.sync();

            assert.ok(
                !world.fault.inner.filePaths().some((rel) => rel.startsWith('.obsidian/plugins/')),
                'plugin code absent remotely',
            );
            assert.equal(remoteText(world, 'notes/alpha.md'), '# Alpha\n\nfirst note\n', 'the rest still syncs');
        } finally {
            await world.close();
        }
    });
});

describe('fault windows and guards (#17, #23, #24, mass-delete hold)', () => {
    it('#17: 429s and a 5xx streak converge with zero deletes', async () => {
        const world = await createWorld();
        requestStats.reset();
        try {
            await buildBaseTree(world.vaultDir, { largeBytes: 0 });
            await world.sync();
            await world.sync();
            const deletesBefore = world.fault.deleteCalls().length;

            // Phase A: burst 429s on per-path lookups. The pass completes with
            // retried paths; failed reads must never read as "remote gone".
            // `iterateNodes` is the per-path lookup the pass actually makes
            // (DriveIO.lookupNodes batches through it); `getNodeHierarchy`
            // only resolves the root, so a fault on it never fires mid-pass.
            world.fault.failEvery('iterateNodes', 3, () => {
                world.fault.recordRateLimited();
                return rateLimitedError();
            });
            await writeText(world.vaultDir, 'notes/during-outage.md', 'written during the outage\n');
            world.fault.inner.put('notes/remote-during-outage.md', 'remote side during the outage\n');
            try {
                await world.sync();
            } catch {
                // Contained per-path failures resolve the pass; a wholesale
                // failure rejects it. Either way nothing may be deleted.
            }
            assert.ok(world.fault.failedCallsOf('iterateNodes').length > 0, 'the 429s actually fired');
            assert.equal(world.fault.deleteCalls().length, deletesBefore, 'zero deletes during the 429 window');
            assert.notEqual(requestStats.lastRateLimited(), null, 'the 429s reached the shared rate stats');
            world.fault.clearFaults();

            // Phase B: a 500 streak on listings fails the pass outright.
            world.fault.failNext('iterateFolderChildrenNodeUids', 4, () => serverError(500, 'Internal error (fault injection)'));
            try {
                await world.sync();
            } catch {
                // A pass that cannot list is a failed pass, not a wrong one:
                // it retries instead of deleting.
            }
            assert.ok(world.fault.failedCallsOf('iterateFolderChildrenNodeUids').length > 0, 'the 500s actually fired');
            assert.equal(world.fault.deleteCalls().length, deletesBefore, 'zero deletes during the 500 window');

            world.fault.clearFaults();
            await world.sync();
            await world.sync();
            assert.equal(await localText(world, 'notes/during-outage.md'), 'written during the outage\n');
            assert.equal(await localText(world, 'notes/remote-during-outage.md'), 'remote side during the outage\n');
            assert.equal(world.fault.deleteCalls().length, deletesBefore, 'still zero deletes after convergence');
            assert.deepEqual(world.state.retryEntries(), [], 'no retries left at quiescence');
        } finally {
            await world.close();
        }
    });

    it('#16-engine-seam: 401-once retries without deleting; persistent 401 holds without writes', async () => {
        const world = await createWorld();
        try {
            await writeText(world.vaultDir, 'notes/auth.md', 'base\n');
            await world.sync();
            const deletesBefore = world.fault.deleteCalls().length;
            const uploadsBefore = world.fault.completedUploads;

            // A single 401 is transient: the pass retries the path and converges.
            world.fault.failNext('getNode', 1, () => unauthorizedError());
            world.fault.failNext('iterateNodes', 2, () => unauthorizedError());
            await writeText(world.vaultDir, 'notes/auth.md', 'base\nlocal edit\n');
            try {
                await world.sync();
            } catch {
                // A pass that cannot verify the remote retries; it never deletes.
            }
            await world.sync();
            assert.equal(world.fault.deleteCalls().length, deletesBefore, 'a transient 401 deletes nothing');

            // A 401 that never clears (revoked session past the refresh below
            // this seam) holds every write: the engine queues retries while
            // the daemon watchdog — covered by E2E, not this fake — pages.
            world.fault.blackoutMethod('getNode', () => unauthorizedError());
            world.fault.blackoutMethod('iterateNodes', () => unauthorizedError());
            world.fault.blackoutMethod('iterateFolderChildrenNodeUids', () => unauthorizedError());
            world.fault.blackoutMethod('getFileUploader', () => unauthorizedError());
            world.fault.blackoutMethod('getFileRevisionUploader', () => unauthorizedError());
            await writeText(world.vaultDir, 'notes/auth.md', 'base\nlocal edit\nanother\n');
            try {
                await world.sync();
            } catch {
                // Expected: the remote is unreadable.
            }
            assert.equal(world.fault.completedUploads, uploadsBefore, 'no uploads committed while unauthorized');
            assert.equal(world.fault.deleteCalls().length, deletesBefore, 'no deletes while unauthorized');
        } finally {
            await world.close();
        }
    });

    it('#23: an exclusion glob added over an existing remote dir hides both directions', async () => {
        const world = await createWorld();
        try {
            // Small tree on purpose: the unicode twins settle with their own
            // writes on the second pass, which would pollute the zero-writes
            // assertion below.
            await writeText(world.vaultDir, 'notes/keep.md', '# Keep\n');
            await writeText(world.vaultDir, 'drafts/secret.md', '# Draft\n\nnot yet excluded\n');
            await world.sync();
            assert.equal(remoteText(world, 'drafts/secret.md'), '# Draft\n\nnot yet excluded\n');

            world.engine.updateSettings({ ...world.settings, excludePatterns: ['drafts/**'] });
            await writeText(world.vaultDir, 'drafts/secret.md', '# Draft\n\nlocal edit while excluded\n');
            world.fault.inner.put('drafts/secret.md', '# Draft\n\nremote edit while excluded\n');
            world.fault.clearLog();
            await world.sync();

            const writes = world.fault.calls.filter((call) =>
                ['createFolder', 'uploadFromStream', 'downloadToStream', 'trashNodes', 'renameNode', 'moveNodes'].includes(call.method),
            );
            assert.deepEqual(
                writes,
                [],
                'excluded changes cause no reads-turned-writes in either direction',
            );
            assert.equal(await localText(world, 'drafts/secret.md'), '# Draft\n\nlocal edit while excluded\n', 'local edit untouched');
            assert.equal(remoteText(world, 'drafts/secret.md'), '# Draft\n\nremote edit while excluded\n', 'remote edit untouched');

            world.engine.updateSettings({ ...world.settings, excludePatterns: [] });
            await world.sync();
            const live = await localText(world, 'drafts/secret.md');
            const copies = (await conflictCopies(world.vaultDir)).filter((copy) => copy.startsWith('drafts/'));
            const copyTexts = await Promise.all(copies.map((copy) => readText(world.vaultDir, copy)));
            assert.deepEqual(
                new Set([live, ...copyTexts].filter((text) => text?.startsWith('# Draft'))),
                new Set(['# Draft\n\nlocal edit while excluded\n', '# Draft\n\nremote edit while excluded\n']),
                'un-excluding converges both edits exactly',
            );
        } finally {
            await world.close();
        }
    });

    it('#24: a file above the cap is skipped with a recorded too-large status', async () => {
        const world = await createWorld({ settings: { maxFileSizeMb: 1 } });
        try {
            const { largeBytes } = await buildBaseTree(world.vaultDir);
            assert.ok(largeBytes > LARGE_FILE_BYTES, 'fixture is above the large-file line');
            await world.sync();

            const pending = world.engine.pendingChanges().filter((change) => change.path === LARGE_FILE);
            assert.equal(pending.length, 1, 'the large file has a pending entry');
            assert.equal(pending[0].reason, 'too-large', 'recorded as too-large, never silent');
            assert.ok(
                !world.fault.inner.filePaths().includes(LARGE_FILE),
                'the large file never reached the remote',
            );
            assert.equal(
                world.fault.calls.filter(
                    (call) =>
                        (call.method === 'uploadFromStream' || call.method === 'downloadToStream') &&
                        call.detail.includes(String(largeBytes)),
                ).length,
                0,
                'no transfer carried the large bytes',
            );
            assert.equal(await localText(world, 'notes/alpha.md'), '# Alpha\n\nfirst note\n', 'the rest still syncs');
            assert.equal(remoteText(world, 'notes/alpha.md'), '# Alpha\n\nfirst note\n');
        } finally {
            await world.close();
        }
    });

    it('mass-delete hold: losing 30 files holds with zero remote deletes, then deny restores', async () => {
        const world = await createWorld();
        try {
            for (let i = 0; i < 30; i++) {
                await writeText(world.vaultDir, `bulk/file-${i}.md`, `# File ${i}\n`);
            }
            await world.sync();
            const deletesBefore = world.fault.deleteCalls().length;

            for (let i = 0; i < 30; i++) {
                await fs.unlink(full(world, `bulk/file-${i}.md`));
            }
            await world.sync();

            const held = world.engine.pendingMassDelete();
            assert.ok(held !== undefined && held.count === 30, `mass delete held with all 30 paths, saw ${JSON.stringify(held)}`);
            assert.equal(world.fault.deleteCalls().length, deletesBefore, 'zero remote deletes while held');

            await world.engine.denyMassDelete();
            await world.sync();
            for (let i = 0; i < 30; i++) {
                assert.equal(await localText(world, `bulk/file-${i}.md`), `# File ${i}\n`, `file-${i} brought back`);
            }
        } finally {
            await world.close();
        }
    });
});

describe('tree generator contract', () => {
    it('the fixture tree carries every shape the catalogue needs', async () => {
        const world = await createWorld();
        try {
            const { largeBytes } = await buildBaseTree(world.vaultDir);
            const files = await walkFiles(world.vaultDir);
            assert.ok(files.includes(NFC_TWIN) && files.includes(NFD_TWIN), 'NFD/NFC twins are two files on disk');
            assert.ok(files.includes(CASE_RENAME_FILE), 'case rename target present');
            assert.ok(files.includes('empty.md') && files.includes('zero/blob.bin'), 'empty files present');
            assert.ok(files.some((rel) => rel.includes(' ') || /[^\x00-\x7F]/.test(rel)), 'spaces and non-ASCII names present');
            assert.ok(files.includes(LARGE_FILE), 'large file present');
            assert.ok(largeBytes > LARGE_FILE_BYTES, 'large file above the cap');
            assert.ok(files.includes('drafts/secret.md'), 'excludable path present');
            assert.ok(files.some((rel) => rel.startsWith('.obsidian/')), '.obsidian churn files present');
            const stat = await fs.stat(full(world, LARGE_FILE));
            assert.equal(stat.size, largeBytes, 'sparse file reports its full size');
        } finally {
            await world.close();
        }
    });

    it('tokens ride on their own lines for the chaos ledger', async () => {
        const world = await createWorld();
        try {
            await writeText(world.vaultDir, 'notes/tok.md', 'body\n');
            await appendToken(world.vaultDir, 'notes/tok.md', 'tok-run-7');
            const lines = (await localText(world, 'notes/tok.md'))!.split('\n');
            assert.ok(lines.includes('tok-run-7'), 'token on its own line');
        } finally {
            await world.close();
        }
    });
});
