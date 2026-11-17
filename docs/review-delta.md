# Delta review: do the safety + ops fixes close the holes?

Method: `npm --workspace headless test` 137/137 green; 11 scratch defeat
probes (bundled from `headless/src`, run, not committed) 10/11 stable pass
with 1 flaky fail that is itself a finding; shell drills of
`docker-entrypoint.sh` and `backup-daemon-state.sh`; line-level code reads.
Branch `review/headless-delta`, fixes `05360d1,63c080d,91a90e9,af074af,c15df8f`.

## Correctness review — P0/P1

| Item | Verdict | Evidence |
|---|---|---|
| P0-1 two live locks refused | PASS | probe: 2nd `acquire` (dead-pid view, same boot) → `LockHeldError`, 1st file intact (`lock.ts:183-186`) |
| P0-1 stale holder taken over + reason | PASS | probe: 1h-old heartbeat + dead pid → takeover, reason matches `/heartbeat\|not running/` (`lock.ts:249-258`) |
| P0-1 matching boot + fresh heartbeat refuses (exit 5) | PASS | probe: fresh payload, `isAlive:false` → `LockHeldError`, no unlink (`lock.ts:250-254`); maps to exit 5 (`daemon.ts:526-530`) |
| P0-1 heartbeat doesn't corrupt payload | PARTIAL → NEW P1-A | rewrite is `truncate(0)`+`write` (`lock.ts:213-217`); probe caught torn reads 2/4 runs (`Unexpected end of JSON input`). Torn → `inspect` reads "unreadable, take over" (`lock.ts:235-237`) → two holders; ousted holder's `release()` then unlinks the *new* holder's file |
| P0-1 unlink→create race | PASS | loser gets `EEXIST` → re-inspect finds winner's fresh file → `LockHeldError` (`lock.ts:193-204`) |
| P0-2 `chmod 000` never reads as gone | PASS | probe: `stat`/`list` into 000-dir throw `EACCES`, never `null`/`false` (`nodeAdapter.ts:176-218`) |
| P0-2 gate aborts before engine work, all modes | PASS | `assertVaultSyncable` (`daemon.ts:332-383`) runs in `bootDaemon` shared by once/watch/approve/deny; suite: exit 2, `startCalls()===0` (`daemon.test.ts:814-887`). Note: gate runs after read-only `engine.plan`; `verify` is exempt (read-only hash, no writes) |
| P0-2 symlinked dir/file | PASS | probe: linked dir omitted from `list`, `stat`/`read`/`write` throw `SymlinkRefusedError`, link survives write attempt, outside bytes never returned (`nodeAdapter.ts:130-161,276-317`) |
| #3 `verify` divergence / signed-out / foreign | PASS | suite `daemon.test.ts:908-966` + probe: foreign-account file → non-zero + "different account" (`daemon.ts:1562-1567`); signed-out → 4, never "nothing to check" (`daemon.ts:1554-1561`) |
| #4 wedged engine goes stale | PASS | suite: heartbeat withheld without progress, `stalled` logged, `updatedAt` frozen (`daemon.ts:1026-1055`, `daemon.test.ts:968-1035`) |
| #5 cache marker / `memory` / nodeScope | PASS | marker wired at boot (`daemon.ts:674`), scope ported (`daemon.ts:714-720`), `memory` → `cacheStore:null`, no file (probe + `auth.ts:263`, suite `daemon.test.ts:1074-1132`) |
| #6 SIGTERM mid-`once` | PASS | exit 2, never 0 (`daemon.ts:922-938`, suite `daemon.test.ts:1037-1072`) |
| #7 dir fsync both adapters | PASS | probe: `writeBinary` fires `onDirSync`; `DataDirAdapter.write/rename` + `nodeAdapter` rename/trash all `fsyncDir` (`daemon.ts:213-225`, `nodeAdapter.ts:86-94,309-312`, suite `daemon.test.ts:1133-1148`) |
| P2-8 `ConfigError` → 7 | PASS | probe: bad `--config` → 7 via `runCommand` (`commands.ts:130-133`); lock-creation failure → `ConfigError` (`daemon.ts:531-536`) |
| P2-9 `--pairing` to approve/deny + stale warning | PASS | suite `daemon.test.ts:1149-1181` (`daemon.ts:731,752-760`) |
| P2-10 watcher prunes excluded/symlink trees | PASS | suite `watcher.test.ts`; exclusions wired from `headlessApp.ts:155-157` |
| P2-12 exit 6 no-restart | PASS (mechanics) | entrypoint maps 4/5/6 → logged exit 0 (drilled 0-7); `restart:on-failure:5`. Caveat below |
| P2-13 symlinks | PASS | see P0-2 row + watcher skip-once warning |
| P2-14 shared data dir | PASS (doc) | `compose.yml:50-51` forbids sharing; temp names still pid-only (`health.ts:110`) — same-host only, documented |

## Security review — P1

| Item | Verdict | Evidence |
|---|---|---|
| P1-1 vault lock not synced | PASS | `.proton-sync/` in `ALWAYS_EXCLUDED` (`settings.ts:127`); watcher excludes it; suite asserts zero transfers (`daemon.test.ts:1182-1189`) |
| P1-2 log/status redaction | FAIL (code unchanged) | zero `redact` hits in `headless/src`; note names stay in JSONL + `status.json`. Mitigated only by docs + log rotation (`compose.yml:70-74`); `SECURITY.md:86-93` is honest about it |
| P1-3 owner-only modes | PARTIAL | session/cache healed 0600/0700 (`fileSlot.ts:195-229`, `fileCacheStore.ts:155-172`); but `sync-state.json`, `status.json`, `device-id`, lock parent dirs use bare `mkdir`/`writeFile`, no `umask` anywhere → 644/755 under default umask |
| P1-4 unreadable-slot overwrite | OPEN | `runLogin`: `restore()===false` → straight to web login → save overwrites (`daemon.ts:1232-1257`); no `--force`/`--rotate-key` flag exists (`cli.ts`); **no test covers it**. `SECURITY.md:74-76` claims refusal without an explicit flag — that flag does not exist |
| P1-5 supervisor hot-loop | PASS (mechanics) | mapping drilled; `on-failure:5`. Residual: exit 0 hides the event from restart-count monitoring — operator must watch `status.json` state / `HOLDING` log line |
| P1-6 healthcheck vs first sync | PARTIAL | `once` never writes `syncing` (`'syncing'` only at `daemon.ts:982`, watch); sole cover is `start_period: 15m`. A >15 min first sync still reads unhealthy → kill → restart loop (exit 2 → `on-failure` restarts) |
| P1-7 symlinks | PASS | see correctness row |
| P1-8 artifacts consistent | PASS | `dist/pss-daemon.cjs` = esbuild outfile; `USER 65532:65532`; `PSS_CONFIG`/`PSS_KEY_FILE` match `config.ts`; `/vault`+`/data` mounts, `read_only`, `status` healthcheck, rotation all present |
| P1-9 backup excludes + mid-pass refusal | PARTIAL | excludes verified in archive listing; `syncing` → exit 2. But NEW P1-B: `once` leaves state `starting`, script greps only `syncing` → drill backed up mid-pass with exit 0. Stale-`syncing`-blocks-forever needs `--allow-active` (documented) |
| P1-10 pins + CI | PARTIAL | SDK exact `0.23.0` in both manifests; `esbuild ^0.28.2`, `obsidian ^1.14.4` still ranged. CI parses; `headless` job runs types + daemon tests + bundle + plugin suite + backup drill + `docker build`; weekly `sdk-drift` exists |
| P1-11 `SECURITY.md` matches code | PARTIAL | key custody, rotation limits, non-protections all accurate; but stale "Until the heartbeat lands" (`SECURITY.md:117`, it landed) and the P1-4 refusal overclaim above |

## New findings (from the fixes)

- **NEW P1-A heartbeat torn-read race** (`lock.ts:213-217` + `235-237`): non-atomic
  rewrite lets a concurrent starter read a torn file → "unreadable, take over" a
  live lock → two writers; victim's `release()` deletes the successor's file.
  Fix: temp-file + `rename` + reopen, not truncate-in-place.
- **NEW P1-B backup blind to `once`** (script `STATUS_FILE` grep + `daemon.ts:904-967`
  never writing `syncing`): either write `syncing` before `engine.start` in `once`,
  or refuse on `updatedAt` freshness instead of state name.
- **P1-4 still open + doc overclaim**: implement the refused-overwrite flag or fix
  `SECURITY.md:74-76`; add the rotated-key `login` test.
- Residual (accepted, note only): gate→`engine.start` TOCTOU on permission flips;
  one-time torn payload at initial create (pre-existing, commented).

## Top 3 things a human must still verify on the real NAS

1. **Held-stop alerting + exit-6 drill**: 4/5/6 now exit 0 — `docker inspect` looks
   clean. Page on `status.json` `signed-out`/`error` or the `HOLDING` log line, and
   rehearse the §9 restore on scratch (restarting never fixes state-lost).
2. **First-sync wall clock + file modes**: time the real first sync against
   `start_period: 15m`; run `find /data/pss-daemon -perm /077` after first start
   (P1-3 gap is live until modes are enforced).
3. **Backup restore proof + key rotation**: timed restore drill per §9; decide the
   rotation procedure now — swapping `PSS_KEY_FILE` today silently strands/replaces
   `session.bin` (P1-4 open).
