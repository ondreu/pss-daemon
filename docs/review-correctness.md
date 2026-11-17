# Correctness review: headless daemon (adversarial)

Scope: `headless/src/*.ts` + diff vs `feat/headless-scaffold`, against
`src/sync` + `src/proton` as shared code. Method: read all of it, ran
`npm --workspace headless test` (108 green), `check-types` + `lint` clean,
and executed two runtime probes against the real classes (lock + adapter/
`VaultIO`; state-load semantics). P0 = data loss / silent corruption.
P1 = wrong behaviour needing manual repair. P2 = robustness/supervision.

## P0

### 1. Vault lock does not exclude a second container — pid liveness is namespace-local
`headless/src/lock.ts:52-66,137-164`. Liveness is `process.kill(pid, 0)` and
same-boot comparison. Two containers over one vault (the exact case the
vault-side lock in `daemon.lock` was added for, `lock.ts:12-16`) have
different pid namespaces: container B answers ESRCH for A's live pid, reads
the same `boot_id`, concludes "stale", unlinks A's file and holds its own.
Probe with the real `DaemonLock`: second `acquire` with an `isAlive`
that cannot see the holder succeeds while the first holder is alive —
two writers, interleaved temp files and state flushes, corrupt merge base.
There is also no heartbeat, so a crashed holder's lock is indistinguishable
from a live-but-foreign one; fail-closed is impossible.
Repro (deterministic, no namespaces needed): acquire with
`isAlive: pid => pid === process.pid`, then acquire the same path with
`isAlive: () => false`, same `bootId` — both hold (verified at runtime).
Why tests miss it: `daemon.test.ts:271,385` injects
`isAlive: () => false` + fixed boot id, so every test takes over
stale locks by construction; no test holds two live lock objects.
Fix: heartbeat the lock file (e.g. rewrite mtime every 10 s, take over only
when the file is older than N×interval *and* the pid check fails), fsync the
payload after `writeFile`, and document `--pid=host` or a fencing token
until then. At minimum, refuse takeover when `bootId` matches but the pid
is unverifiable — starting twice must stay the safe direction.

### 2. `EACCES`/`EPERM` reads as "file gone" → single files deleted from Drive
`src/sync/vault.ts:333-360` (`list` warns and `continue`s per directory),
`headless/src/nodeAdapter.ts:90-101,103-117` (`exists`/`stat` swallow *all*
errors to `false`/`null`). A `chmod 000` subdirectory (or an ACL/ownership
slip from the NAS) silently drops its whole subtree from the local view;
`reconcile.ts:58-60` then returns `delete-remote` for every tracked file
whose remote side is unchanged. Under `massDeleteThreshold` this deletes
with no hold, no conflict, no alert beyond a debug line.
Repro (verified at runtime, uid 1000): vault with `sub/secret.md`, `chmod
000 sub` → `VaultIO.list` returns `["top.md"]`, `stat` → `null`,
`exists` → `false`, zero errors thrown. Follow with `once` and the remote
copy is trashed.
Why tests miss it: fakes never throw from `list`/`stat`; the daemon suite
boots a fake engine, so no pass ever runs over a real adapter.
Fix (no `src` change): in `NodeVaultAdapter`, rethrow non-`ENOENT` errors
from `stat`/`exists`/`list` (or add a daemon pre-pass readability walk:
`readdir`+`stat` every tracked path, refuse the pass on anything but
`ENOENT`). Shared-code alternative: classify `EACCES`/`EROFS` in
`VaultIO` as hold, never delete — but that touches `src`.

## P1

### 3. `verify` never verifies an established state — always "nothing to check", exit 0
`headless/src/daemon.ts:1258-1263`: the default `loadState` calls
`real.load(null, remoteFolderUid)`. But `state.ts:19-31,194` binds the file
to `accountTag(email)`; `accountTag(null)` is `null`, never equal to a stored
tag, so the file is ignored as "another account" with `wasLost() === false`
and zero paths → `daemon.ts:1276-1279` prints "No sync state yet" and exits 0.
Verified at runtime: a v1 file with records loads to `paths() === []` via
`load(null, …)`. Cutover gate 7 (`verify` clean) cannot fail.
Why tests miss it: `daemon.test.ts:636-640` injects `loadState`; the real
default loader is never exercised against a signed-in-shaped file.
Fix: `restore()` first, then `load(session.accountEmail ?? null, …)`; if not
signed in, say so instead of reporting clean.

### 4. Watch-mode heartbeat rewrites freshness unconditionally — wedged engine looks healthy
`daemon.ts:819-835`: every 30 s the heartbeat writes `updatedAt: now`
regardless of engine progress. A wedged pass (never resolving, no summary
change) keeps passing the compose `status` freshness check (`health.ts:48-54`,
90 s window) forever. Test plan §3/§4.8 explicitly demand stall detection.
Why tests miss it: heartbeat is injected (`heartbeatMs`) but tests assert it
*writes*, not that it *withholds* on no progress.
Fix: only bump `updatedAt` when `getSummary()` advanced (progress/lastSyncedAt/
pending changed) since the last beat; otherwise let it go stale, or emit a
distinct `stalled` state after 2× poll interval with no pass start.

### 5. Drive metadata cache is defeated three ways — every start does a full refetch
(a) Nothing calls `setCacheMarker` (`auth.ts:194` defines it; no caller in
`headless/`), so the persisted marker is always `''`, while
`validateCache(state.cursorsFingerprint())` (`daemon.ts:551`) passes `'[]'`+
→ `persistentCache.ts:110-116` clears the cache on every boot.
(b) `metadataCache: 'memory'` (`config.ts:144-148`) is parsed and then
ignored — `createProtonAuth` always builds a `FileCacheStore`.
(c) `rememberCacheParents`/`setNodeSource` (`main.ts:805,830,848`) have no
daemon equivalent, so scope filtering runs against an empty set.
Net: slower starts, extra Drive listing load on every restart (rate-limit
surface), and a config knob that does nothing — the exact "silently ignored"
class `config.ts` claims to reject.
Why tests miss it: cache assertions stop at the `clear`/`validate` call
counts on a fake session (`daemon.test.ts`); marker plumbing is unasserted.
Fix: call `setCacheMarker(() => state.cursorsFingerprint())` once the state
exists (as the `auth.ts:190-196` comment already prescribes), honour
`metadataCache`, port `rememberCacheParents`.

### 6. `once` interrupted by SIGTERM exits 0 — "in sync" is then a lie
`daemon.ts:739-745`: the `interrupted` branch returns `ExitCode.Ok` after
`engine.stop()`. The contract (`types.ts` + arch doc §6: `0` = "for `once`:
in sync") is violated; a cron/`--pairing` wrapper cannot distinguish
"synced" from "asked to stop mid-pass".
Why tests miss it: signal tests use a fake emitter and assert shutdown
happens, not the code returned for an incomplete pass.
Fix: return a distinct non-zero code (or reuse `ItemFailures`) when
`interrupted`, keeping 0 for a completed pass.

### 7. No directory fsync — crash window can lose a file the state calls synced
`nodeAdapter.ts:159-194` fsyncs the temp *file* but never the directory;
`daemon.ts:152-183` (`DataDirAdapter`) never fsyncs at all. A crash between
`rename` and directory durability can lose a just-downloaded file while the
flushed state records it as present; the next pass sees local-missing →
`delete-remote` (finding 2's consequence, no permission error needed).
Why tests miss it: `failRename` fault covers the rename, not durability;
no kill-during-rename test exists.
Fix: `fsync` the directory fd after `rename` in both adapters (cheap,
same-directory only). State side is then covered by the existing `wasLost`
gate; the vault side currently is not.

## P2 (robustness / supervision)

- **8. Boot-time `ConfigError` exits 1, not 7.** `loadKeyMaterial`,
`ensureDaemonDirs`, vault-lock `EROFS` throw inside `bootDaemon`
(`daemon.ts:397,438,406-422`); the `catch` at `632-638` rethrows and
`commands.ts:127-131` maps everything to `Usage`. A missing `PSS_KEY_FILE`
or a read-only vault reports "internal error". Fails closed (verified:
vault lock cannot be written → throw before any pass), but the runbook
cannot key off it. Fix: map `ConfigError` to `ExitCode.ConfigInvalid` in
`runCommand`/`runDaemon`; name read-only mounts in the message.
- **9. `--pairing` silently ignored by approve/deny; stale pairing auto-applies.**
`commands.ts:120-123` drops `parsed.pairing` for mass decisions; worse, a
`pairing: adopt-vault` left in `daemon.json` from provisioning auto-resolves
the first-sync gate after a data-dir loss (`daemon.ts:583-610`) with no
fresh human decision. Safe direction today (empty state cannot produce
removals), but the stale decision should expire: warn when the gate is
satisfied by a non-fresh config value, and pass `--pairing` through to
`runMassDecision`.
- **10. Watcher watches excluded trees.** `watcher.ts:446-483,235-244` walks
and `fs.watch`es *every* directory including `.git/`, `.trash/`,
`.obsidian/` churn. Fine at 318 dirs; wasteful and one inotify-exhausted
directory degrades to warn-only. Fix: prune `ALWAYS_EXCLUDED` + the
config/plugin dirs from `walkAbs`/`watchDirAt`.
- **11. Rename pairing can misfire on inode reuse; rescan pairing is first-wins.**
`watcher.ts:313-330`: a path vanishing while an unrelated new file reuses its
`dev:ino` within 1000 ms is reported as a rename. Self-heals (content hash
decides the sync), but the Drive node moves spuriously. Tests use real inodes
with no reuse pressure. Fix: confirm size/mtime hint before pairing, or
accept and document.
- **12. Exit 6 (`StateLost`) restart-loops.** The compose shape restarts on
failure with no restart only on 4 (`docs/headless-daemon.md:254`). A torn
state is not fixed by restarting; each attempt only rewrites the error.
Fix: no-restart on 6 like 4, and page — it needs a human with backups.
- **13. Symlinks are followed everywhere.** No `lstat`/`readlink` in
`headless/src`, `vault.ts`, or `engine.ts` (grep: zero hits). A symlinked
dir is recursed by the rescan (`watcher.ts:476-480`, loop guard only stops
cycles, not escape) and its outside files reported as vault paths; a file
symlink's *target bytes* are read and uploaded under the link path, while
`writeBinary`'s rename *replaces* the link. Repro: `ln -s /etc/hostname
vault/link.md` → outside bytes enter the sync; a download over it destroys
the link. Fix: `lstat` in `walkAbs`/`statRel`/`NodeVaultAdapter.stat` and
refuse-or-skip symlinks (document which).
- **14. Shared data dir across hosts is unprotected.** `readClientUid`
(`daemon.ts:259-273`) last-writer-wins `device-id`; `DataDirAdapter` temp
names are pid-only (`${pid}.tmp`), colliding across machines; NFS `O_EXCL`
is advisory. Unsupported layout, but nothing says so. Fix: document that the
data dir must be host-local (like the lock assumes), or key temp names with
hostname+pid.

## Verified clear (checked, not vulnerable)

- `wasLost` gate refuses with exit 6 and zero Drive writes; cache untouched,
engine never started (`daemon.ts:529-545`). Torn-`.bak` recovery order is
`SyncState`'s tested file→tmp→bak chain.
- Approve/deny reboot and reproduce the hold from the same state, then the
engine re-decides every path (`engine.ts:386-410`); there is no stale list
to approve (`daemon.ts:889-908`). Restart/SIGTERM cannot bypass a hold —
`stop()` clears only the in-memory decision (`engine.ts:684-713`).
- Same-host double start is refused via both locks; the EEXIST→re-inspect
path closes the simultaneous-start race in one namespace (`lock.ts:119-134`).
- Read-only vault at startup fails closed (lock create throws before any
pass); `dataDir`-inside-vault refused (`config.ts:83-89`); `importState`
refuses overwrite and mismatched files are ignored by `load`
(`daemon.ts:935-962`).
- No pass without a session: restore-false/throw → exit 4 before the engine
exists (`daemon.ts:462-480`); `rootUid === null` → `ConfigInvalid` before
`engine.start` (`554-564`); removal from the device list signs out + exit 4
(`568-576`).
- Session end mid-pass stops the engine and exits 4 exactly once — no retry
loop (`session.ts:342-348`, `daemon.ts:482-485,717-721,822-824`); 401-refresh
vs revoked stays the engine's tested behaviour.
- `window` shim exists in the production bundle banner
(`headless/esbuild.config.mjs`) and the test banner — the `window.setTimeout`
call sites are safe where shipped.
- Writes are temp-plus-rename with debris in the engine-excluded
`*.tmp` shape (`nodeAdapter.ts:159-194`); `manual` policy rejected at config
(`config.ts:99-101`); lexical escape checks run on every adapter method
(`nodeAdapter.ts:63-84`); corrupt cache fails open to refetch, never to
wrong bytes (`fileCacheStore.ts:140-152`).

## Test gaps that hide the above

`daemon.test.ts` boots fake vault/auth/state/engine behind `DaemonDeps`,
so no test runs a real pass over a real adapter: permission faults,
marker plumbing, and the real `loadState` default are all unexercised.
`lock.test.ts` never holds two live locks; the probe is always
`isAlive: () => false`. `watcher.test.ts` covers pairing and backstop but
not excluded-dir pruning, inode reuse, or symlinked dirs. `verify` has no
test against a signed-in-shaped state file. Recommended additions before
ship: EACCES-fault adapter test (assert zero `delete` calls), verify
round-trip test with a tagged state, heartbeat-with-wedged-engine test,
and a two-live-lock test.
