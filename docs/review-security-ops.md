# Security + operations review: headless daemon (`review/headless-security`)

Scope: `headless/src/{fileSlot,fileCacheStore,auth,lock,health,config,daemon}.ts`,
`src/proton/{secretStore,credentials,session,persistentCache}.ts`,
`src/sync/{vault,paths}.ts`, `src/util/logger.ts`,
`docs/headless-daemon.md` §§3/7/9, test plan #3–7/#16–18 + gates 6–9.
Headless tests: 108/108 pass (after `npm install`; before that the runner
failed — `esbuild` was missing, see P1-10).

No P0 confirmed. Nothing observed sends tokens to logs/status/errors, and no
remote input reaches a shell. The items below are ordered by bite.

## P1 — will bite

**P1-1 Vault-side lock file syncs to Drive.** `vaultLockFile`
(`config.ts:244`) puts `daemon.lock` at `<vault>/.proton-sync/daemon.lock`,
but nothing excludes `.proton-sync/` from sync: `ALWAYS_EXCLUDED`
(`settings.ts:125`) has no entry for it, the daemon passes `pluginDir: null`
(`daemon.ts:201`) so no plugin-dir exclusion applies, and `verify` even
assumes the opposite by skipping `.proton-sync` (`daemon.ts:1201`) while the
engine does not. The lock (`{pid, bootId, vaultPath}`, `lock.ts:22`) is
uploaded to Proton and fanned out to every device on the folder, and each
pass re-uploads it. Fix: add `.proton-sync/**` to `ALWAYS_EXCLUDED`
(or move the vault lock out of the vault) and add a fake-Drive test
asserting zero transfers for it.

**P1-2 `--json` / JSONL logs never redact note names.** `jsonLog`
(`daemon.ts:137`) stringifies `extra` (`paths`, `pending`, conflict
`path`/`copyPath`, `daemon.ts:495-521,759,903`) without `redactNames`, and
the daemon has no `logShowsNames` equivalent — redaction is promised by the
design doc (§6) but only the plugin's `Logger` implements it. Docker logs on
the NAS keep these lines indefinitely. `status.json` is the same leak at
rest: `massDeleteHeld` paths + `lastSummary` in plaintext. Fix: pass all
`jsonLog` text/extra through `redactNames`/`redactArgument`, add an explicit
`--show-names` opt-in, and write `status.json` `0600`.

**P1-3 Uneven file modes leak the state to other local users.**
`session.bin`/`drive-cache.bin` are correctly `0600`/`0700` with healing
(`fileSlot.ts:195-229`, `fileCacheStore.ts:155-172`), but `sync-state.json`
(`DataDirAdapter.write`, `daemon.ts:166-172`), `status.json`
(`health.ts:107-112`), `device-id` (`daemon.ts:259-273`) and the lock
parent dirs (`lock.ts:103`) are created with no mode — `0644`/`0755` under a
default umask. State and status hold note names, hashes and error strings.
Fix: one helper for `0700` dirs / `0600` files used by all writers (or
`process.umask(0o027)` at entry) plus a test asserting modes.

**P1-4 A rotated/wrong `PSS_KEY_FILE` reads as "signed out", and the next
`login` silently destroys the old envelope.** `Credentials.load`
(`credentials.ts:118-132`) swallows `UnreadableSlotError` into signed-out,
so `restore()` returns false with only a warning; `runLogin` then proceeds
and overwrites `session.bin` with the new key. A key rotation (or a mount
that served the wrong secret) becomes unrecoverable without ever saying so.
Fix: surface unreadable-slot distinctly (`status: key-mismatch`, non-zero
exit pointing at the key, not at Proton) and refuse to overwrite an
unreadable `session.bin` without an explicit `--force`/`--rotate-key`.

**P1-5 Supervisor restarts defeat exits 4/6.** Compose says
`restart: unless-stopped` (doc §7) while systemd is told not to restart on
exit 4 — and `unless-stopped` also restarts exit 6 (state lost) and even
exit 0. A revoked session (needs a human) hot-loops; a lost state
re-enters the gate every restart. Fix: `restart: on-failure` with explicit
no-restart on 4/6 (or a wrapper mapping 4/6 to a held-stopped state), and
page on 4/6 instead of restarting.

**P1-6 Healthcheck fails during a legitimate long first sync.** `status`
exits 1 when `status.json` is missing/stale (`commands.ts:33-65`), and
`once` mode writes `starting` once with no heartbeat (`daemon.ts:723-777`;
heartbeat exists only in `watch`). The 134 MB reference vault's first pass
exceeds `HEALTH_MAX_AGE_MS` (90 s, `health.ts:33`), so the container reads
unhealthy mid-sync and a strict supervisor kills it into a restart loop.
Fix: heartbeat in `once` mode too (or a `syncing` write before `start`),
separate liveness from readiness in the healthcheck, and a documented
`start_period` covering the reference vault.

**P1-7 Symlinks are followed out of the vault.** Adapter (`nodeAdapter.ts`)
and watcher (`watcher.ts:446-483`, `fs.stat`) follow links: an outside
directory linked into the vault is walked and its contents uploaded under
vault names, and `writeBinary`'s rename-over replaces a user symlink with a
real file. (`remove`/`rm` only unlink the link itself — verified, not host
deletion.) `staysInVault` is string-based and cannot see this. Fix: `lstat`
everywhere, skip/refuse symlinks (log once), test with a linked outside dir.

**P1-8 Deployment artifacts don't exist yet.** No `Dockerfile`/`compose.yml`
in the tree, so `USER 65532:65532`, `mem_limit`, and `healthcheck` are
unverified claims. Untested consequences: Synology root-owned mounts make
`0600`/`0700` creation and `chmodQuietly` fail (silent heal hides it);
JSONL-to-stdout with no `logging: {max-size,max-file}` grows the NAS log
disk without bound; read-only-rootfs feasibility unknown. Fix: commit the
artifacts, set log rotation, and test as uid 65532 against root-owned
mounts. Until then §7 is a sketch, not a runbook.

**P1-9 Backup story omits the state, rollback is unrehearsed.** §7's tar
covers the vault but `sync-state.json` (the merge base — losing it forces a
re-baseline that resurrects deletes) has no backup rule, while `session.bin`
must be *excluded* with no `--exclude` pattern given. A tar mid-pass is torn
across files (per-file atomicity only; `.bak` heals the state, not a mixed
vault/state pair). Gate 9's timed rollback drill has no log. Fix: nightly
`tar --exclude=session.bin --exclude=drive-cache.bin` of vault + dataDir
at `status.json:idle`, plus the dated drill output.

**P1-10 Supply chain + CI gaps for the pre-release SDK.** `package.json`
declares `^0.23.0`/`^2.2.0` (only the lockfile pins `0.23.0`); a fresh
resolve drifts within `0.23.x`. CI (`.github/workflows/ci.yml`) runs the
plugin suite only — the 108 headless tests run nowhere — and test-plan #18's
weekly latest-SDK build does not exist. Fix: exact pins (or documented
`npm ci` enforcement), a headless CI leg, and the weekly drift job.

**P1-11 `SECURITY.md` stops at the plugin.** No headless section for:
`PSS_KEY_FILE` custody/rotation, data-dir modes, `status.json`/Docker-log
name leakage (P1-2/3), `session.bin` backup exclusion (P1-9), and the
explicit non-protections — NAS admin/root, same-uid processes (full session
read, lock removal; unavoidable in one container), the Hermes co-writer of
the vault, and Proton-account compromise. Fix: extend `SECURITY.md`; the
threat-model paragraph ("two local files", doc §10) should name these.

## P2 — harden

- `DataDirAdapter.write` (`daemon.ts:166`) skips the `fsync`-before-rename
  the vault adapter does (`nodeAdapter.ts:177`); a power loss there leans
  entirely on `.bak`. Add `handle.sync()` for symmetry.
- `verify` (`daemon.ts:1208`) hashes whole files with one `readFile`; stream
  the hash — a 300 MB skipped-large file still gets fully buffered.
- Key material lives in a `Buffer` for the process lifetime, never zeroed;
  `loadKeyMaterial` tolerates one trailing newline (fine) but logs the byte
  count on mismatch (length oracle — negligible, keep paths out of errors).
- `saneFactors` (`fileSlot.ts:80`) admits `N=1M,r=32`, whose memory exceeds
  `SCRYPT_MAXMEM` — a hand-edited envelope turns into signed-out. Harmless
  (writer already owns the box) but clamp to what 64 MiB actually fits.
- Lock takeover is unlink-then-create (`lock.ts:119-127`): two starters race
  through the window; the loser re-inspects, so the outcome is safe but the
  "reason" line can misattribute. Document, or `rename`-based handoff.
- `logFile` (`config.ts:233`) is in `DaemonPaths` and never written — wire it
  or delete it before a backup script trusts it.
- `runLogin --pairing` rewrites `daemon.json` non-atomically
  (`daemon.ts:1040-1044`); reuse tmp+rename.

## Verified sound

- **KDF recording/validation:** scrypt `n/r/p` are stored in the envelope and
  range-checked before use (`fileSlot.ts:147`); unknown versions refuse
  (`144`), never read as empty. Downgrade-by-edit yields
  `UnreadableSlotError`, not plaintext.
- **Fresh salt+iv per write** (`randomBytes`, `fileSlot.ts:197-198`); GCM with
  purpose-bound AAD (`ASSOCIATED_DATA`) and 16-byte tag length check
  (`154`). Two writes of one session look nothing alike.
- **No empty-read of a damaged session:** `ENOENT→null`, anything else
  throws; `Credentials.load` never promotes damage to "no session".
  (The swallow-into-signed-out is P1-4's UX, not a crypto hole.)
- **Token lifecycle:** refresh pair stays inside the encrypted envelope;
  `signOut` revokes server-side first (`revoke.ts`), then wipes locally even
  offline; `sessionEnded` stops the engine and exits 4 — no retry loop.
- **Cache encryption:** per-session 32-byte `cacheKey` inside the session
  envelope (`credentials.ts:97-106`); entries AES-256-GCM with key-bound AAD
  (`persistentCache.ts:228-237`); `nodeScope` keeps out-of-subtree entries
  out of the file (`357-379`); fresh state clears, mismatched marker drops.
  On-disk cache leaks entry counts/sizes only.
- **Traversal:** `staysInVault` on every adapter and `VaultIO.checked`
  path; `isSafeName` drops Drive names with `/`, `\`, `..`
  (`drive.ts:690`); uid-shaped specs verify-then-use, `..` refused
  (`auth.ts:145-147`). Remote names cannot escape — modulo symlinks (P1-7).
- **Single-writer:** dual `<dataDir>` + `<vault>/.proton-sync` locks
  (the doc's single-lock description is outdated); stale takeover needs
  dead-pid *or* boot-id mismatch and always logs why (`lock.ts:79-81`);
  failed start releases the first lock (`200-207`).
- **State gates:** `wasLost` → exit 6 before any Drive write (`daemon.ts:
  533-545`); empty state clears the cache, non-empty validates the marker
  (`546-552`); two non-empty sides require `--pairing` (`583-610`).
- **Mass delete:** never auto-approved in either mode; `once` exits 3,
  `watch` keeps syncing the rest and re-reports; approve/deny re-decide per
  path (`daemon.ts:865-871`).
- No tokens, key bytes, or key-file contents in any error string, log line,
  or `status.json` field observed; `PSS_KEY_FILE` arrives by path, never by
  value (`config.ts:253-277`).
