# Headless daemon test plan

Scope: a headless Node daemon running the existing `SyncEngine`
(`src/sync/engine.ts`) against a local vault dir on a Linux NAS (Docker,
volume-mounted, ~318 dirs / 1800 files / 134 MB, 320 notes), replacing
the Obsidian Sync headless client. Engine, `SyncState`
(`src/sync/state.ts`), `VaultIO` (`src/sync/vault.ts`), `DriveIO`
(`src/sync/drive.ts`) and `reconcile` (`src/sync/reconcile.ts`) are
taken as-is; the daemon adds process lifetime, file watching,
scheduling, locking, logging, config. This plan covers only what makes
that daemon trustworthy — not the architecture (separate doc), not
engine logic the unit suite already proves (rename-as-rename, three-way
rules, merge boundaries, `MAX_MERGE_BYTES` 4 MiB, `LARGE_FILE_BYTES`
32 MiB, mass-delete hold, 401 refresh-once, pass serialization, state
generation counters).

Conventions: "state file" = `SyncState` file with `.tmp`/`.bak` siblings
(write to `.tmp`, current becomes `.bak`, rename into place; load order
file → `.tmp` → `.bak`). "Quiescence" = daemon idle, retry map empty, no
mass-delete hold, event cursors current. Severity is **data-loss** (wrong
bytes win silently, or bytes vanish) or **annoyance** (stall, dupe,
noise, fixed by retry/restart).

## 1. Failure-mode catalogue

Format: trigger / expected / reproduce → assert / severity / owner.
Owner layers: Daemon (new shell), Engine, VaultIO, DriveIO, SyncState,
Settings.

**Process and storage crashes**

1. SIGKILL mid-write. `kill -9` during a note write: previous version
intact, `.<name>.proton-sync.tmp` ignored on restart, upload retried.
Reproduce: loop-sync a 20 MB file, `kill -9` at peak write, restart →
assert target hash equals pre- or post-write version never a mix, log
shows retry not conflict. Data-loss if violated. Owner: VaultIO + Daemon.
2. SIGKILL mid-upload. `kill -9` with bytes half-sent: remote keeps old
revision (Proton revisions commit atomically), next pass re-uploads.
Reproduce: fake Drive throttled to 50 KiB/s, kill during 30 MB upload,
restart → assert remote hash == local hash, exactly one new remote
revision. Data-loss. Owner: DriveIO + Daemon.
3. Power loss / torn state. All three copies (file, `.tmp`, `.bak`) torn:
`SyncState.wasLost` must gate startup — refuse to sync and alert, never
start "fresh" (fresh state turns every diff into a conflict and
resurrects old deletions). Reproduce: random bytes in all three copies,
start → assert non-zero exit or `state-lost` alert, zero Drive writes
(count fake API calls). Data-loss. Owner: Daemon gates on `wasLost`.
4. Torn state, one copy survives. Corrupt file + `.tmp`, valid `.bak` (all
combos): loads `.bak`, logs which copy won, worst case redundant uploads.
Assert startup log names winner, post-quiescence trees clean. Annoyance.
Owner: SyncState + Daemon log line.
5. Disk full mid-pass. Vault volume fills during downloads/flush: pass
aborts, flush retried (rotation never presents a half-file as current),
daemon backs off and alerts instead of hot-looping. Reproduce: 50 MB
tmpfs, sync 134 MB vault → assert state file still parses, next pass
after resize completes with no disk-caused conflicts. Data-loss if torn
state treated as current. Owner: Daemon pre-check + backoff.
6. Read-only mount. Vault bind-mounted `:ro`: probe-write a dotfile at
startup; if unwritable, refuse passes — remote changes wait, nothing
uploaded as "delete". Reproduce: `remount,ro`, touch remote file, one
pass → assert zero local changes, zero remote deletes, alert logged.
Data-loss if read failure ever reads as "file gone". Owner: Daemon probe
+ VaultIO classifies EROFS/EACCES as hold, never delete.
7. Two daemons, one vault. Double-started container: the second instance
fails on the dual `O_EXCL` locks (`<dataDir>/daemon.lock` AND
`<vault>/.proton-sync/daemon.lock` — two containers can mount different data
dirs over one vault, so the vault-side file is the one that collides), exits
5 (`already-running`, held to a clean stop, never restarted), and never runs
a pass. Reproduce: stagger two starts 1 s → assert one holder, loser logs
`already-running`, exits 5, zero state/Drive touches. Data-loss (two
writers interleave temp files and flushes). Owner: Daemon — engine
assumes a single writer. Pid-namespace caveat: across containers a
live-but-foreign holder must read as HELD, never stale (see design doc §4).
8. Daemon + GUI plugin, same note. Laptop Obsidian and NAS daemon edit one
path in one poll window: ordinary three-way conflict, loser kept via
`conflictCopyPath`, never overwritten. Reproduce: append A locally, B
via fake Drive, one pass → assert both byte-versions present (one live,
one complete copy). Data-loss if last-writer-wins silently. Owner:
Engine — daemon adds no "prefer local" shortcut.

**Watcher, clock, filesystem lies**

9. Watcher overflow / missed events. Bulk untar overflows inotify, or
Docker drops volume events: daemon never trusts watcher alone — full
walk every N min (default ≤ 15) catches misses. Reproduce: suppress
watcher delivery, add 200 files, wait one interval → assert all uploaded
within interval + one pass. Data-loss-adjacent (stall reads as loss).
Owner: Daemon scheduler.
10. Clock skew. NAS clock days off or NTP step mid-pass: mtime is a hint,
bytes/hash decide (existing engine rule — verify, don't relax; daemon
host must run NTP). Reproduce: skew mtimes ±30 days, identical bytes →
assert zero transfers (`transfer_bytes_total` flat). Annoyance, escalates
to data-loss if skew ever picks a winner. Owner: Engine + deployment doc.
11. mtime-preserving tools. `cp -a` / `rsync -a` / `git checkout` restore:
identical bytes ⇒ no-op pass, no conflicts, no re-uploads. Reproduce:
`cp -a` vault aside, same state, one pass → assert 0 transfers.
Annoyance. Owner: Engine hash-gated writes.
12. Rename/move churn. Folder of 200 notes renamed twice mid-pass: followed
as renames (node-uid tracking), not 200 delete+create pairs.
Reproduce: script two rapid `mv`s mid-pass → assert trees match,
`uploaded_bytes_total` ≪ 200 × size. Annoyance. Owner: Engine + daemon
watcher debounce (keep `uploadDebounceMs` 2000 ms semantics).
13. Delete-vs-edit race. Path deleted locally while its remote edit is in
flight: edited side wins or a conflict copy is kept; delete never eats
new bytes. Reproduce: delete local file 50 ms into a slow remote
download of its edited version → assert edited bytes at original path or
a copy; token coverage holds (§3). Data-loss. Owner: Engine reconcile —
daemon serializes "apply remote" vs "scan local" per pass.
14. Folder deleted one side, file inside edited on the other. `rm -rf
local/folder` vs remote paragraph in `folder/note.md`: edited file
survives (resurrected or copy), logged `folder-delete-vs-edit`, delete
does not cascade. Reproduce both directions → assert new bytes present
locally + exactly one notice. Data-loss. Owner: Engine — riskiest
untested corner; gate 4 requires it.
15. Truncated by an editor. Note collapses to 0 bytes (crash-save,
`> file`): treated as an edit, but previous version hits version history
(`MAX_NOTE_VERSIONS` 50 semantics) *before* upload; `truncated_to_empty`
counter alerts. Reproduce: `: > note.md` on 5 KB note → assert prior
bytes in history, remote emptied only after history write. Data-loss if
history skipped. Owner: Daemon ordering + Engine versions.

**Network, auth, Proton-side**

16. Token expiry → revocation. Expiry: silent refresh, pass continues
(existing 401-refresh-once). Revocation (password change): stop
scheduling, hold state, page for re-auth; never wipe session/PIN on
ambiguous 4xx (preserve the vendored narrowing: only 429 retried
blindly; 400/401/403 count only with matching body). Reproduce: fake
401-once, then 401 invalid-grant → assert zero user-visible errors first,
`auth_revoked` alert + zero Drive writes after verdict second. Annoyance
→ data-loss if wipe strands conflict state. Owner: Daemon watchdog.
17. 429 / 5xx. Burst 429s with `Retry-After`, then 500 streak: honor
`Retry-After`, back off (`TransferPace`), retry on the 30 s-doubling ≤1 h
schedule; 5xx never means "remote gone". Reproduce: 429 every third call
+ 10 min of 500s → assert convergence, `rate_limited_total` counted,
zero `delete` calls in fake log during the 500 window. Data-loss if
failed reads become deletes. Owner: Engine retry map + daemon pacing
(keep `transferConcurrency` 3; raising it re-runs gate 6).
18. SDK drift (0.23 pre-release). Exact pins (`"0.23.0"`, no `^`) in both
`package.json` files with the lockfile; the weekly `sdk-drift` CI job
installs `@protontech/drive-sdk@latest` over the pins (`--no-save`) and runs
the headless plus plugin suites, failing loudly on drift. Reproduce:
`npm install @protontech/drive-sdk@latest` in CI → assert green matrix or
filed incompatibility. Annoyance now, data-loss later. Owner: Daemon CI.

**Names, config, host quirks**

19. Unicode/NFD + case-only renames on Linux. macOS writes NFD `café.md`,
renames `Note.md`→`note.md`; ext4 treats twins as distinct: apply
`vaultSpelling` (NFC) on every daemon path; case-only rename followed as
rename; NFD/NFC twins never collapse. Reproduce: NFD+NFC twins + case
rename → assert both twins byte-identical remotely, one node uid across
rename. Data-loss on twin collapse. Owner: Engine paths/caseClashes;
daemon image sets `LANG=C.UTF-8`.
20. `.obsidian` churn + plugin-code exclusion. Obsidian rewrites
`app.json`/workspace each launch; plugin's own code must never sync. With
`syncObsidianConfig: true` (default) config syncs but churn doesn't spin
passes (debounce + quiet period); plugin dir + `*.proton-sync.tmp` always
excluded, not user-editable. Reproduce: touch 50 `.obsidian/*` files,
two passes → assert second is no-op, plugin path absent remotely.
Annoyance → data-loss if plugin code clobbers newer remote copy. Owner:
Daemon hard-coded defaults + Engine `PathFilter`.
21. Vault path with spaces/non-ASCII (`/data/My Vault – poznámky`): no
join/glob/lockfile/log bug; globs match as on ASCII. Reproduce: full
fake suite with such `VAULT_DIR` as a CI leg → assert green, valid
conflict-copy names. Annoyance. Owner: Daemon quoting/encoding.
22. SMB/NFS with lying mtimes. 2 s granularity + mtime caching: detect
fstype at startup (`stat -f`, warn on smb/nfs/fuse), lengthen quiet
period, re-compare by hash inside the granularity window, never skip a
changed file. Reproduce: FUSE harness stubbing 2 s mtimes, edits 500 ms
apart → assert both propagate. Data-loss on missed edit. Owner: Daemon —
ext4 local disk is the supported target; network mounts best-effort.
23. Exclusion glob over an existing remote dir. Adding `drafts/**` while
remote `drafts/` has files: excluded paths invisible both directions —
no downloads, no uploads, remote never deleted; un-excluding converges
exactly. Reproduce: add glob, pass, remove, pass → assert zero
`drafts/` transfers while excluded + untouched remote, exact convergence
after. Data-loss if exclusion reads as deletion. Owner: Engine
`PathFilter` both directions + daemon rejects escaping globs (`../*`).
24. Large attachments + caps. 300 MB video vs `LARGE_FILE_BYTES` 32 MiB:
skipped both directions with visible `skipped_large` status (never
silent), rest syncs, no OOM (streamed, never double-buffered whole
file). Reproduce: 300 MB file, pass under
`node --max-old-space-size=512` → assert skip recorded, RSS under cap,
referencing note synced. Annoyance (OOM loop = data-loss-adjacent).
Owner: Engine caps + daemon container limits.

## 2. Test pyramid

**A — unit: `npm test`** (`node scripts/test.mjs`, 586 green). Reconcile
tables (all delete/edit combos incl. #14), `PathFilter` globs (#23),
state load order + `wasLost` (#3–4), retry math (30 s ×2, 1 h cap),
NFC/case in `paths.ts`. Proves pure logic. Cannot prove timing, crashes,
real SDK, real fs. Daemon adds unit tests for lock/config/signals with
injected handles — no real signals here. Green on every commit.

**B — integration vs fake Drive (harness to build on
`tests/support/fakes.ts`).** In-memory Drive with injectable faults:
scripted per-call responses (partial listings that omit-then-reveal,
429 + `Retry-After`, random 5xx, torn reads, throttled transfers,
401-then-refresh and 401-invalid-grant) plus a full call log supporting
*negative* assertions ("zero deletes during the 500 window"). Runs real
`SyncEngine` + real `SyncState` on temp dirs; owns #1–2 (kill simulated
by dropping the engine mid-`await` and rebuilding over the same dir),
#8, #11–15, #17, #19–20, #23–24, and all of §3. Proves logic under
faults. Cannot prove real crash durability (fdatasync/rename), real
Proton behavior, real inotify. Command: `npm --workspace headless test` —
`npm test` + it both green pre-merge.

**C — real-Drive E2E in a canary folder** (e.g. Drive
`/sync-daemon-canary`, test account only, never the real vault):
generated tree (500 files, NFD names, case twins, 30 MB file), both
delete-vs-edit directions vs real revisions, burst-induced 429, forced
token expiry, one `kill -9` at peak transfer with byte-count compare.
Proves SDK shapes match assumptions, revisions atomic, auth works.
Cannot prove scale (≪1800 files), races (too flaky for gates), anything
destructive — harness aborts unless remote target stays under the canary
prefix. Command: `npm run test:e2e` (opt-in via `PROTON_TEST_*` env,
nightly, not per-commit). Red nightly blocks cutover (gate 7) but not
unrelated merges.

Fixtures: one tree generator shared by B and C — NFD names, case twins,
empty + 0-byte-edge files, a 40 MB over-cap file, `.obsidian/` churn
files; binary fixtures carry sidecar `.tok` ledgers. Fake is seedable
with a virtual clock (no wall-clock sleeps in assertions).

## 3. Chaos and soak protocol

Two writers, one world: W1 mutates the local temp vault directly, W2
mutates the fake Drive directly, the daemon syncs between them; the
checker runs only at quiescence. Weights per 100 ops (8 h default, 72 h
for gate 1): write-new 20, append 20, rename 10, cross-folder move 8,
copy 5, delete-file 7, delete-folder 3, folder-delete-vs-edit setup 5,
collide (same path both sides ≤2 s) 12, truncate-to-empty 3, touch-only 2.

Tokens: every mutation embeds `tok-<run>-<seq>` on its own line in each
touched text file; ledger maps token → paths → live/deleted-by-policy.
Rename/move carries tokens (assert by content scan, not path); a split
into conflict copies must leave the token complete in ≥1 copy, and every
copy claiming it must be byte-complete for that version.

Compare only at quiescence: writers stopped, daemon idle, retry map
empty, no mass-delete hold. Mid-flight comparisons measure scheduling,
not correctness — void. Pass criteria (all): 100% token coverage for
non-deleted tokens (found locally, remotely, or in a complete copy);
all copies byte-complete; retry map empty, no hold, no `skipped_large`
beyond known fixtures; recursive hash walk identical modulo excluded
paths.

Overwritten-by-policy vs lost: missing token = lost unless the ledger
shows a clean one-sided delete (correct propagation) or a later
in-policy sequential edit removed its line (correct last-writer-wins).
Only collide and folder-delete-vs-edit ops may produce copies, and their
tokens must each appear in ≥1 complete copy. Anything else missing is P0
data-loss.

Instrumentation every 60 s: RSS, fd count, pass duration p50/p99,
transfers/pass, retry depth, event-cursor lag (fake seq vs daemon
cursor), state size + revision counter. Fail on RSS/fd/pass-duration
drift over 24 h at flat workload, or no pass started within 2× poll
interval while writers active (`last_pass_start_unixtime` heartbeat).
Kill-mid-upload: at peak-transfer window (top-decile bytes in flight per
fake byte counters) `kill -9`, restart, require convergence with zero
token loss and no kill-duplicated copies — ≥3 kills/soak, ≥1 during a
state flush (fs hooks on `.tmp` rename detect it).

## 4. Acceptance gates before cutover

1. 72-hour soak on a copy of the real vault: 100% token coverage, trees
identical modulo exclusions, no RSS/fd drift. Evidence: ledger report +
metrics CSV + tree hashes. Copy only; scrub tokens before any real sync.
2. `kill -9` at peak transfer ×3: convergence at quiescence, no torn
remotes, no duplicated copies. Evidence: byte-counter logs bracketing
each kill + comparison report.
3. Restore/re-baseline both directions: wipe local copy + state → sync
from Drive byte-identical (minus excluded); wipe remote canary → push
from local identical. Evidence: hash walks before/after.
4. Failure #14 green both directions × nesting (top-level + 3-deep).
Evidence: dedicated test output, not chaos luck.
5. Mass-delete guard live-fire: `rm -rf` 30 files → hold listing them in
`pendingMassDelete`, zero remote deletes until approval, convergence
after. Evidence: fake call log showing the hold.
6. Rate-limit survival: sustained 429s + 10-min 500 streak → convergence,
zero deletes in the 500 window, `transferConcurrency` still 3. Evidence:
call-log audit.
7. Real-Drive canary green 7 consecutive nights incl. one kill -9 + one
forced refresh per run. Evidence: nightly CI links.
8. No silent stalls: wedge a pass in staging, observe the heartbeat /
cursor-lag page. Evidence: alert log line, not a description.
9. Rollback rehearsed: seeded-bad-sync drill to restored vault + paused
daemon in ≤30 min from the runbook alone (`docs/headless-daemon.md` §9;
nightly archives from `scripts/backup-daemon-state.sh`). Evidence: timed
drill log.

## 5. Anti-patterns and false alarms

- A conflict copy is the system working (#8, #13 resolve to copies by
design); only missing/torn copies are defects.
- Remote deletions right after first sync usually mean the mass-delete
hold caught a stale baseline — check `pendingMassDelete` first, never
approve from an incident without a tree diff.
- Post-restore upload spikes are fine iff bytes changed; identical trees
with shifted mtimes must yield zero transfers (#11) — a spike on
identical trees is the real signal.
- `.obsidian/workspace.json` changing every pass is Obsidian churn, not
looping; the loop signal is the same path transferred on consecutive
quiet passes.
- Invalid mid-flight: tree diffs, token coverage, cursor lag, "missing
file" — all void before quiescence. RSS during a 30 MB transfer says
nothing about leaks; only the 24 h flat-workload trend counts.
Transfers during the 500 window measure backoff, not throughput.

## 6. What I would refuse to ship without

1. The vault `flock` (#7) — Docker makes double-starts easy and two
writers corrupt everything silently.
2. `wasLost` gating startup (#3) — silent re-baseline resurrects deletes
on every device.
3. Failure #14 green both directions — the one untested corner with whole-
folder blast radius.
4. The 72-hour real-copy soak at 100% token coverage (gate 1).
5. The peak-transfer `kill -9` with byte-counter proof (gate 2).
6. The rehearsed rollback drill (gate 9) — the only gate covering what all
other gates missed.
