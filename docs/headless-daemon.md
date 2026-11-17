# Headless sync daemon

Status: design. Target: run the plugin's sync engine on a Linux NAS
(Synology/UGREEN, Docker) against the same vault the Obsidian plugin syncs,
so the vault stays live after Obsidian Sync is dropped. The engine is reused
as-is; everything around it is a thin adapter.

Non-goals are at the bottom. Line references are against this repo.

## 0. Decisions up front

| # | Question | Decision |
|---|----------|----------|
| 1 | Engine reuse | Unchanged. `SyncEngine` plus a headless `App` shim; no fork (section 1). |
| 2 | Package layout | New npm workspace `headless/` with its own esbuild node build importing `../src`; plugin build untouched (section 2). |
| 3 | Auth | Device/web flow (`ProtonSession.beginWebSignIn`), session in a `SecretSlot` encrypted with a key from the environment, file `0600` (section 3). |
| 4 | State | Per-device files in the daemon data dir, same `StateFile` v1 format as the plugin; GUI state is imported once by copy, never shared live (section 4). |
| 5 | Unattended policy | Default `merge` (line-level, keep-both only for truly overlapping edits); `manual` is refused. Mass delete is held and never auto-approved (section 5). |
| 6 | New dependencies | None. Only Node 24 builtins plus the existing `drive-sdk`/`crypto` (section 2). |

## 1. Running the engine unchanged

`SyncEngine`'s constructor (`src/sync/engine.ts:310`) takes
`(app, state, settings, logger, hooks, scope, environment)` where `app` is
the whole Obsidian `App` type. The engine itself only touches a small corner
of it, all through `VaultIO` (`src/sync/vault.ts:203`):

- `app.vault.adapter` (`vault.ts:224`) — every read, write, listing and stat.
- `app.vault.getAbstractFileByPath` (`vault.ts:242`) — null means "not indexed".
- Indexed-file writes: `app.vault.copy` (`vault.ts:411`),
  `app.vault.rename` (`vault.ts:693`), `app.vault.createBinary` (`vault.ts:749`),
  `app.fileManager.trashFile` (`vault.ts:843`).

The headless `App` shim (`headless/src/headlessApp.ts`) implements exactly
this: a `NodeVaultAdapter` over the vault directory using `node:fs`
(`stat`, `readBinary`/`writeBinary`, `mkdir`, `remove`, `rename`, `list`,
`getFullPath`), `getAbstractFileByPath` returning a fake for any path without
a dot-segment (mirroring Obsidian's indexing rule, as `tests/support/fakes.ts`
does), and `copy`/`rename`/`createBinary`/`trashFile` mapped onto adapter
calls. `tests/support/diskAdapter.ts` already proves the adapter half works;
the shim adds the four vault methods and the lookup on top.

What breaks outside Obsidian, and the replacement for each:

| Obsidian API | Where | Headless replacement |
|---|---|---|
| `requestUrl` (CORS escape hatch) | `src/proton/obsidianFetch.ts:24`, wired in `session.ts:162` | Plain `fetch` (undici). No CORS exists server-side. `ApiClient` already takes `fetch` as a parameter, so this is a one-line swap. |
| `window.require('fs'/'crypto')` fast paths | `vault.ts:129-145` | `import('node:fs')` / `node:crypto` directly. The code already falls back to the adapter when the require fails; headless takes the direct path. |
| `Platform.isWin/isMobile/...` | `vault.ts:32,234,269,586`, `main.ts:317-322` | Constants from `process.platform`: `windows = process.platform === 'win32'`, `isMobile = false`. Passed via `EngineEnvironment` (`src/sync/engine/types.ts:174`), which already abstracts all of these; use `DESKTOP` (`types.ts:195`) with `isMetered: () => false`. |
| Bare `window.setTimeout/clearTimeout` | `engine.ts:695`, `engine/pollScheduler.ts:66`, `devices.ts:546`, `state.ts:569`, `persistentCache.ts:124` | `globalThis.window ??= globalThis` shim at entry, the same trick `scripts/test.mjs` already uses to run these modules under Node. `clock.ts:15` already handles a missing `window`. |
| `Notice`, modals, status bar | `main.ts` UI layer | `EngineHooks.onChange/onConflict` (`types.ts:217`) write to the log and the health file instead. No UI code is imported. |
| `app.secretStorage`, Electron `safeStorage` | `main.ts:240-257`, `secretStore.ts:299` | File slot encrypted with Node `scrypt` + AES-256-GCM (section 3). |
| `IndexedDbCacheStore` | `session.ts:389-407` | New `FileCacheStore` implementing the existing `CacheStore` interface; `openEntitiesCache` already falls back to `MemoryCache` when no store is available, so this only adds persistence. |
| Vault events (`vault.on('create'/'modify'/...)`) | `main.ts:1326-1344` | An `fs.watch`-based watcher mapping onto `engine.onVaultChange/onVaultRename/onVaultFolderDelete`, with a periodic full rescan as backstop. `engine.startupSync` (`engine.ts:1066`) and `sweepDownloads` (`vault.ts:246`) already cover missed events at boot. |

If the engine cannot be reused as-is, the fallback is a one-line change, not
a fork: narrow the constructor parameter from `App` to the five vault methods
above. Everything else stays.

## 2. Package layout

Second esbuild entry in the same package is rejected: the plugin build targets
`platform: 'browser'` with `obsidian` external (`esbuild.config.mjs`), and a
node entry sharing that config would entangle the two outputs. Forking
`src/sync` into the daemon is rejected harder: every conflict fix would need
applying twice.

So: an npm workspace `headless/` with its own `package.json` and
`headless/esbuild.config.mjs` (`platform: 'node'`, `target: 'node24'`,
`format: 'cjs'`, `obsidian` aliased to a local stub like
`tests/stubs/obsidian.ts`). It imports the engine by relative path
(`../../src/sync/engine.ts`), sharing `src` source without moving it. The
plugin build, manifest and release flow do not change.

```sh
npm --workspace headless run build   # -> headless/dist/pss-daemon
./headless/dist/pss-daemon --help
```

No new runtime dependencies. Each candidate was rejected in favour of
builtins: `chokidar` (watcher; `fs.watch` per directory plus rescan suffices
for one vault), `keytar`/`libsecret` (secret storage; no keyring on a NAS,
use env-keyed file encryption), `commander`/`pino` (CLI/logging; ~100 lines of
parsing and JSONL is enough and keeps the audit surface small).

## 3. Auth

Reuse `ProtonSession` (`src/proton/session.ts:73`) and `Credentials`
(`src/proton/credentials.ts:35`) unchanged. Headless differs only in the
`fetch` passed to `ApiClient` (section 1) and the `SecretSlot`
(`src/proton/secretStore.ts:9`) backing the credentials.

First run: `pss-daemon login` calls `session.init()` then
`beginWebSignIn` (`session.ts:234`), which returns a `SignInHandle`
(`session.ts:55`) with the `account.proton.me` approval URL. The daemon prints
the URL to stdout and waits on `completion`, which polls until the user
approves in a browser — password, 2FA and security keys keep working because
the daemon never sees them. On approval, `finishSignInSetup`
(`session.ts:423`) builds the client. Unattended start afterwards restores
from disk with no prompts.

Secret material on disk (all under the daemon data dir, default
`/data/pss-daemon/`; nothing secret ever lands in the vault):

| File | Contents | Protection |
|---|---|---|
| `session.bin` | `StoredSession` v1 JSON (`credentials.ts:8`): uid, access token, refresh token, user key password, account email, cache key | AES-256-GCM, key from `PSS_KEY_FILE` via scrypt; file `0600`, write-temp-rename like `SafeStorageFileSlot.write` (`secretStore.ts:218`). PIN is not supported headless; `PinProtectedSlot` is bypassed, not reimplemented. |
| Drive metadata cache | Encrypted node cache via `FileCacheStore`, key = session `cacheKey` (`credentials.ts:97`) | Same envelope as the session; validated against `state.cursorsFingerprint()` (`state.ts:129`) exactly as `main.ts:788` does. |

Token refresh rides on `ApiClient.authenticatedRequest` through `HTTPClient`
(`src/proton/httpClient.ts:23`): a 401 refreshes like any other request. When
Proton ends the session (refresh token dead), `sessionEnded`
(`session.ts:323`) fires the handler that stops the engine; the daemon logs,
writes `status: signed-out` to the health file, and exits 4 so the supervisor
does not hot-loop a login that needs a human.

## 4. State identity

The plugin keeps `sync-state.json` (`STATE_FILE`, `main.ts:70`) at
`<pluginDir>/sync-state.json` (`main.ts:290-292`) — inside the vault's
`.obsidian` folder — plus `conflict-history.json` and the session beside it.
`SyncState.load(accountEmail, remoteFolderUid)` (`state.ts:151`) binds a file
to one account (via `accountTag`, `state.ts:19`) and one Drive folder; a file
from another account or folder is ignored, and unreadable copies set
`wasLost()` (`state.ts:147`). Writes are crash-safe (`.tmp` + `.bak`,
`state.ts:75-88`).

The daemon must not share that file live with the GUI plugin or another
daemon: the state is a per-device merge base, and two writers corrupt the
"what did we last agree on" records (`SyncRecord.base`, `types.ts:19`). So:

- Daemon data dir holds its own `sync-state.json` in the identical `StateFile`
  v1 format, keyed to the daemon's own `clientUid` (a UUID in
  `daemon.json`, replacing `installationId`/`localStorage`, `main.ts:1698`).
- Moving a vault from GUI to daemon: `pss-daemon login --import-state
  <vault>/.obsidian/plugins/<id>/sync-state.json` copies the file once. Same
  account + same folder means `load` accepts it; from then on the two evolve
  independently. Moving back is the reverse copy while the daemon is stopped.
- Two machines over one Drive folder: distinct `clientUid`s, distinct state
  files, distinct cache scopes. The shared device list in
  `.proton-drive-sync/` (`DEVICES_FOLDER`, `settings.ts:116`, via
  `DeviceRegistry`, `devices.ts:177`) is the rendezvous — the daemon registers
  as `platform: 'linux-headless'` — not a lock.
- Same-machine double start is prevented by TWO `O_EXCL` locks held for the
  process lifetime (`headless/src/lock.ts` — this corrects the earlier
  single-flock description): `<dataDir>/daemon.lock` and
`<vault>/.proton-sync/daemon.lock`. Two containers can bind-mount different
data dirs over the same vault, and only the vault-side file collides then.
A second start for the same vault path exits 5 naming the lock holder's PID.
Takeover of a stale lock is always logged with the reason (dead pid *and* a
heartbeat older than 30 s, or boot id from before this boot). Pid-namespace
caveat: liveness is `kill(pid, 0)` plus the Linux boot id, so across
containers a live-but-foreign holder reads as ESRCH on the same boot id —
that reads as HELD (fail closed), and so does any unreadable-but-recent lock
file. Heartbeats publish via temp-file plus `rename` (never
truncate-in-place), so concurrent starters see whole files only, and
`release()` only unlinks a file it still owns. See SECURITY.md.

## 5. Unattended policy

Conflict resolution without a human: the daemon accepts every
`ConflictPolicy` (`types.ts:113`) except `manual`, which records a conflict
and waits for a user who will never come — config validation rejects it at
startup and suggests `merge`. Default is `merge` (the plugin default too,
`settings.ts:187`); it falls back to `keep-both` on unmergeable files by
construction. Every outcome is already reported through
`onConflict`/`ConflictEvent` (`types.ts:209`), which the daemon logs as JSON
with both paths.

Mass-delete guard: a threshold breach produces `PendingMassDelete`
(`types.ts:49`) instead of deletions. The daemon never auto-approves: it logs
the held paths (capped at 50, as the panel does), writes them to the health
file, and — in `once` mode — exits 3; in `watch` mode it keeps syncing
everything else and re-reports each pass. Recovery is explicit:
`pss-daemon approve-mass-delete` (re-decides every path first, like
`engine.approveMassDelete`, `engine.ts:386`) or `deny-mass-delete`
(re-downloads, like `denyMassDelete`, `engine.ts:410`).

First sync of a non-empty vault against a non-empty folder: the daemon runs
`planFirstSync` (`engine/planning.ts:28`) as a dry run and refuses to sync
until told which side wins: `--pairing=adopt-drive | adopt-vault | merge`.
`adopt-*` mirrors the "Drive settings win / vault wins" choice the plugin
makes for config (`types.ts:151`); `merge` pairs by content (the `adopt`
action, `types.ts:104`). With an empty state on either side this flag is
required; with an established state it is ignored.

Exclusions are the plugin's, unchanged:

| Source | Rule (`src/settings.ts`) |
|---|---|
| `ALWAYS_EXCLUDED` (`:125`) | `.trash/`, `.git/`, `*.tmp`, OS droppings — never sync. |
| `configExclusions` (`:150`) | `workspace.json`, `workspace*`, `cache`, and the whole `<pluginDir>/` (state, session) — never sync even with config sync on. |
| `codeExclusions` (`:169`) | `<configDir>/plugins/**`, `community-plugins.json` — never synced to a shared vault, so a collaborator cannot ship code to every machine. `keepSelfEnabled` (`engine.ts:1693`) keeps the local install entry intact. |
| `.proton-sync/` (daemon lock dir) | `daemon.lock` lives at `<vault>/.proton-sync/daemon.lock` and must never sync: add `.proton-sync/**` to `ALWAYS_EXCLUDED` (security review P1-1) and assert zero transfers for it — otherwise the lock is uploaded to Proton, fanned out to every device on the folder, and re-uploaded each pass. |

## 6. CLI surface and config

```
pss-daemon login [--import-state PATH] [--pairing MODE]  # web-flow sign-in
pss-daemon status [--json]                               # health + last summary
pss-daemon once [--dry-run]                              # one full sync, then exit
pss-daemon watch                                         # poll + fs.watch loop
pss-daemon verify                                        # checksum both sides vs state
pss-daemon approve-mass-delete | deny-mass-delete
pss-daemon sign-out
```

`daemon.json` (defaults shown), validated at startup:

```ts
type DaemonConfig = {
    vaultPath: string;            // e.g. "/vault"
    configDir: string;            // default ".obsidian"
    dataDir: string;              // default "/data/pss-daemon"
    remoteFolderUid: string | null;
    conflictPolicy: ConflictPolicy; // default "merge"; "manual" rejected
    massDeleteThreshold: number;  // default 25, from DEFAULT_SETTINGS
    remotePollSeconds: number;    // default 60; floor MIN_POLL_SECONDS (settings.ts:216)
    transferConcurrency: number;  // default 3
    pairing?: 'adopt-drive' | 'adopt-vault' | 'merge';
    logLevel: 'debug' | 'info' | 'warn' | 'error'; // default "info"
    metadataCache: 'file' | 'memory'; // default "memory" — see the note below
};
```

`metadataCache: 'memory'` (default) keeps the Drive node cache in memory only,
so every start reads the tree fresh. A persisted cache is only as fresh as the
last event feed the process consumed, and `once` compares the tree without
draining events first — a stale cache there silently overwrote a remote edit in
the first real-Drive test. `'file'` is opt-in for a long-running `watch` whose
event loop is known to stay live. The encrypted Drive node cache can live in
`drive-cache.bin` between starts, keyed by the session's per-device cache key
and validated against `state.cursorsFingerprint()` exactly as the plugin does
— a marker mismatch clears the cache and refetches, it never serves stale
bytes. `'memory'` skips persistence for less encrypted-at-rest surface at the
cost of a full listing on every boot. The marker plumbing is wired
(`setCacheMarker` once state exists) and `rememberCacheParents` is ported,
so a warm start validates the saved cache instead of refetching.

Exit codes: `0` clean (for `once`: in sync — a SIGTERM-interrupted `once`
exits 2, never 0); `1` config/usage error; `2`
sync finished with item failures (paths listed in `status.json`); `3`
mass-delete held; `4` signed out / session revoked (supervisor must NOT
restart — needs a browser re-login); `5` already running
(lock held, no restart); `6` sync state lost — `wasLost()` gate, zero Drive
writes, engine never starts (no restart: needs a restore from backup, §9);
`7` config invalid (including boot-time `ConfigError`: unreadable key file,
missing vault, read-only mount; and a session.bin the key cannot open —
key mismatch, naming `PSS_KEY_FILE`, never "signed out"). `login` without
`--rotate-key` refuses the same mismatch instead of overwriting it.
Logging is JSONL to stdout (`{ts, level, module, msg, ...}` via
the existing `Logger`, `src/util/logger.ts`). Structured note paths —
conflict/copy paths, mass-delete held paths, plan and verify report paths —
redact by default to a stable short digest (`headless/src/redaction.ts`),
with an explicit `--show-names` opt-in (`logShowsNames` in daemon.json);
counters stay exact. Free-text error strings may still embed a path, so keep
`max-size`/`max-file` rotation and do not forward to third-party aggregation.
`status.json` in the data dir carries
`SyncSummary` (`types.ts:56`) plus `updatedAt` for the watchdog; it is
`0600` in a `0700` dir (security review P1-3). SIGTERM/SIGINT
calls `engine.stop()` (`engine.ts:684` — drains the queue, flushes state);
`watch` then exits 0, while a `once` interrupted mid-pass exits 2 (an
interrupted pass is not "in sync"); a second signal within 30 s forces
exit 1.

## 7. Deployment

The committed artifacts are the contract — `Dockerfile`, `compose.yml`,
`headless/docker-entrypoint.sh` and `scripts/backup-daemon-state.sh`
(security review P1-8: until these exist, user ids, memory limits and the
healthcheck are unverified claims). `headless/tests/deploy.test.ts` lints
their key properties on every CI run.

```dockerfile
FROM node:24-slim
COPY --chmod=755 headless/dist/pss-daemon.cjs /usr/local/bin/pss-daemon
COPY --chmod=755 headless/docker-entrypoint.sh /usr/local/bin/pss-daemon-entrypoint
USER 65532:65532
ENTRYPOINT ["pss-daemon-entrypoint"]
CMD ["watch"]
```

Build context is the repo root (`docker build -t pss-daemon .` after
`npm --workspace headless run build`). The final image has no build tools —
it copies the prebuilt bundle; the root filesystem can be mounted read-only
(`read_only: true` + a 64 MB `/tmp` tmpfs in compose.yml). First start as
uid 65532 against root-owned Synology mounts fails closed (lock creation
throws before any pass); fix once over SSH as admin —
`chown -R 65532:65532` on both the vault and the data-dir hosts — or
override `user:` so one uid owns both mounts.

```yaml
services:
  pss-daemon:
    build: .
    user: "65532:65532"
    command: ["watch"]
    volumes:
      - /volume1/vault:/vault:rw
      - pss-data:/data:rw
    environment:
      PSS_CONFIG: /data/pss-daemon/daemon.json
      PSS_KEY_FILE: /run/secrets/pss_key   # value never in env, only the path
    secrets: [pss_key]
    mem_limit: 768m
    cpus: 1.0
    logging: {driver: json-file, options: {max-size: "10m", max-file: "5"}}
    restart: "on-failure:5"   # bounded; exits 4/5/6 are held to a clean stop
    healthcheck:
      test: ["CMD", "pss-daemon", "status"]  # freshness, not just liveness
      interval: 60s
      start_period: 15m  # grace for the reference first sync; once heartbeats while it progresses
```

Restart policy (correctness review P2-12, security review P1-5): `restart`
is `on-failure` with an explicit bound — never `unless-stopped`/`always`,
which would hot-loop exits 4 (revoked session, needs a human re-login) and
6 (torn state, needs a restore) and even 0. The entrypoint wrapper maps
4/5/6 to a logged clean stop; everything else restarts up to 5 times, then
the container stays stopped and a human runs `docker compose up -d`
after reading the logs. A systemd unit is the same shape
(`ExecStart=... watch`, `EnvironmentFile`, `Restart=on-failure`, no restart
on exits 4/5/6).
Volume layout: vault mounted at the configured `vaultPath`; the data dir
persists `daemon.json`, `session.bin`, `sync-state.json`, `status.json` and
the cache, and must be host-local — never share one data dir between hosts
(temp names are pid-plus-random, `device-id` is last-writer-wins). Resource limits:
1 CPU / 768 MB is ample — transfers are block-chunked and the full sync is
stat-bound; raise `transferConcurrency` only if Proton rate-limits stay
quiet. Verification: `pss-daemon verify` re-hashes both
sides against state records (`ContentStamp`, `types.ts:2`) and reports
divergence; a byte-level check is `find /vault -type f | sort | xargs sha1sum`
compared before cutover and after. The nightly tar backup coexists by reading
only: it must include the vault AND the data dir (`sync-state.json` is the
merge base — losing it forces a re-baseline that resurrects deletes) but
exclude `session.bin` and `drive-cache.bin` (never back up secrets), and it
must refuse while `status.json` says a pass is in flight — see
`scripts/backup-daemon-state.sh` and the §9 runbook. Torn
copies self-heal via `.bak` (`state.ts:75-81`).

## 8. Phased implementation plan

| Phase | Workstream | Owns (new files) | Shared (read-only) | Size |
|---|---|---|---|---|
| A | Headless `App` shim + node `DataAdapter` | `headless/src/headlessApp.ts`, `headless/src/nodeAdapter.ts` | `src/sync/vault.ts` | 2–3 days |
| B | Auth at rest: env-keyed `SecretSlot`, `FileCacheStore`, `login` command | `headless/src/fileSlot.ts`, `headless/src/fileCacheStore.ts` | `src/proton/{session,credentials,secretStore,persistentCache}.ts` | 3–4 days |
| C | Daemon core: config, CLI, lifecycle, watcher, health file, signals | `headless/src/{config,cli,daemon,watcher,health}.ts` | `SyncEngine` API, `EngineHooks` | 1 week |
| D | `verify`, `dry-run`, `approve/deny-mass-delete`, Docker + docs | `headless/Dockerfile`, `compose.yml`, this doc's follow-ups | engine read APIs only | 2–3 days |

Single shared-code rule: `src/` has exactly one owner per stream while that
stream runs — A owns nothing in `src` (adapter-only; if the `App`-narrowing
fallback is needed, A owns that one signature), B owns the two new classes
only (no `src` edits expected), C owns nothing in `src`. Streams run A then
B/C in parallel after A's shim compiles against `tsc --noEmit`; D last. The
integration pass after B+C: `login → once → watch` against a scratch Drive
folder, plus `npm test` (586 tests) green to prove `src` untouched.

## 9. Migration and rollback

Pilot on a copy: duplicate the vault to `/vault-pilot`, point a pilot
`daemon.json` at it with a scratch Drive folder, run `once`, then `verify`,
then `watch` for a week while Obsidian Sync still serves the real vault. Diff
pilot against source nightly (`verify` + `sha1sum`) to catch watcher gaps.

Cutover: stop writes to the old path (pause Obsidian Sync headless,
`ob sync --continuous` down), final `once` on the real vault with
`--pairing=merge` and an empty state, `verify`, then `watch` under the
supervisor. Rollback within the pilot window: stop the daemon, re-enable the
official headless client; Drive keeps every version (revisions), and the
daemon never deletes without an explicit approval, so the worst case is
re-uploads. Keep the last Obsidian Sync snapshot until `verify` is clean for
seven days.

### Restore and rollback runbook (test-plan gate 9)

Backups: `scripts/backup-daemon-state.sh` runs nightly (03:00) and archives
the vault plus the data dir while excluding `session.bin`, `drive-cache.bin`,
locks and tmp debris; it refuses while `status.json` reports `starting` or
`syncing`, or is missing/unreadable (idleness must be proven, not assumed),
unless `--allow-active`, verifies with `tar -t`, asserts no secret file is
inside, and keeps the newest `PSS_BACKUP_KEEP` (default 7) archives. Both
`once` and `watch` announce `syncing` before `engine.start`, so a mid-pass
backup is refused in either mode.

Restore (vault corruption, bad sync, or exit 6 state-lost):

1. `docker compose stop pss-daemon` (locks released; nothing may write).
2. Pick the newest pre-incident archive; prove it first:
   `tar -tzf <archive> | grep -E 'session\.bin|drive-cache\.bin'` must print
   nothing, then extract to scratch and `diff -r` against live to see exactly
   what the restore will change.
3. Restore over the live paths (vault + data dir), then
   `chown -R 65532:65532` both mounts and `chmod 700` the data dir.
4. `docker compose up -d pss-daemon`; prove service is back:
   `docker compose ps` healthy, `pss-daemon status` exit 0 with a fresh
   `updatedAt`, then `pss-daemon verify` clean and a `sha1sum` walk matching
   the restored tree. A first-sync `--pairing` flag in `daemon.json` left
   over from provisioning must NOT auto-resolve the gate after a data-dir
   loss — confirm the pairing decision is fresh before any `once`.

Rollback (abandon the daemon, keep the data): stop the daemon, re-enable the
official Obsidian Sync headless client on the same vault; Drive keeps every
revision, and the daemon never deleted without an explicit approval, so the
worst case is re-uploads.

Timed drill (rehearse before cutover, log the output as gate-9 evidence):
seed a bad sync on the pilot vault (e.g. delete 30 tracked files remotely so
the hold fires, then approve — a deliberate wrong decision), run steps 1–4
above against the pilot from the last nightly archive, and confirm `verify`
clean plus `status` fresh. Budget: ≤30 min from this runbook alone, no
outside help; record the wall-clock time, the archive name, the pre/post
`sha1sum` walks, and the `verify` output in the drill log.

## 10. Open questions (status after both reviews)

1. Does Proton tolerate a long-lived third-party session polling every
   60 s (default; floor `MIN_POLL_SECONDS` = 30) from a datacenter-adjacent
   IP? Default raised 30 → 60; watch 429s in the soak before lowering.
2. Answered: `metadataCache: 'file' | 'memory'` (default `memory`) — encrypted
   node cache persisted between starts vs slower starts with less
   encrypted-at-rest surface. Must be honoured, not advisory (§6).
3. Answered in SECURITY.md (headless section): key file as a Docker secret,
   mode `0600`, backed up off the NAS separately; rotation is sign-out +
   fresh login, never silent overwrite.

## 11. Known limitations (from both adversarial reviews)

Engine-stream fixes land in `headless/src` / `src`; ops/doc-stream fixes are
this document's artifacts. Closed by the fixes the delta review probed
(locks, `EACCES` fail-closed, pairing gate, stall-gated heartbeats in both
modes, SIGTERM-`once` exit 2, dir fsync, exit-7 mapping, pairing
pass-through and warnings, excluded-tree pruning) are constraints no longer:
they are the behaviour, pinned by tests. What is still true:

- Symlinked paths are refused or skipped, not followed: the adapter and the
  pre-pass walk `lstat` and refuse tracked links (`SymlinkRefusedError`),
  and the watcher skips excluded/symlink trees. Rule stands: no symlinks in
  the synced tree.
- `verify` hashes whole files with one `readFile` — a 300 MB skipped-large
  file is fully buffered; stream the hash.
- Key material lives in a `Buffer` for the process lifetime, never zeroed.
- `runLogin --pairing` rewrites `daemon.json` non-atomically (use
  tmp+rename); `logFile` is in `DaemonPaths` but never written (wire it or
  delete it before any backup script trusts it).
- A stale `starting`/`syncing` in `status.json` (crash mid-boot or mid-pass)
  blocks every backup until `--allow-active` — fail closed by design, but an
  operator must clear it after reading the logs.
- A rotated `PSS_KEY_FILE` never reads as "signed out": `once`/`watch` exit
  7 and `login` refuses without `--rotate-key`. Deciding the rotation
  procedure (and rehearsing the §9 restore drill) is still a human job —
  see the delta review's top-3 NAS checklist.
- `rename` pairing can misfire on inode reuse inside the 1000 ms window, and
  rescan pairing is first-wins — self-heals via content hash, but spurious
  Drive node moves are possible.

- Exit 6 (`StateLost`) and the data dir are host-local: never share one data
  dir between machines, and never restart on 6 without a human + backup.

Refuse to ship without: `verify` clean on the 134 MB reference vault;
kill -9 mid-sync followed by a clean start with no `wasLost()` surprise;
mass-delete hold exercised (unmounted-folder simulation) with exit 3 and no
Drive deletions; session revocation producing exit 4, not a retry loop; and
`npm test` green, proving the engine is still shared, not forked.

## What this does not do

- No GUI, no conflict UI, no settings sync UI: policy is config, conflicts are
  log entries.
- No `manual` conflict policy, no PIN, no mobile behaviour (`isMobile` is
  always false, size limits apply uniformly).
- No multi-vault or multi-account in one process: one daemon, one vault, one
  Drive folder.
- No server, no inbound ports, no sharing links: the attack surface is
  outbound HTTPS to Proton plus two local files.
- No backup itself: it keeps the live tree synced; the nightly tar stays.
