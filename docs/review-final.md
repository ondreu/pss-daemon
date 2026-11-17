# Final review: last fix round + gate stability

Method: 30 sequential full-suite runs (159 tests) + 5 parallel
`build`+`test` runs; 90 full runs total incl. follow-ups; probes bundled
from `headless/src` into `/opt/data/cache/scratch` (run, not committed);
line-level reads. Branch `review/headless-final`.

## Gate stability — FAIL (one known flake, test-side)

`loadKeyMaterial takes 32 bytes from PSS_KEY_FILE only`
(`headless/tests/config.test.ts:180`) failed 2 of 30 sequential runs
(runs 6, 19; 0/60 config-only follow-ups; 2/150 overall ≈ 1.3%).
Mechanism, not timing: the test writes `randomBytes(10)` and asserts the
error matches `/10 bytes/`, but `loadKeyMaterial` (`config.ts:274-283`)
tolerates one trailing newline, so a random last byte of `0x0a`/`0x0d`
(p = 2/256 ≈ 0.8%/run, ~1 in 128) reads back 9 bytes and the assertion
fails ("holds 9 bytes" vs `/10 bytes/`, runs 6/19 logs). The two earlier
writes in the same test pin the last byte (lines 166-169, 175-177); line
180 does not. Fix belongs in the test (pin the byte or match
`/holds \d+ bytes/`), never in the product — the tolerance is intended
(`echo` without `-n`). Until pinned, the gate fails ~1 in 128 runs.
No other test flaked in 90 full runs; parallel build+test was 5/5 green.

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Flakiness hunt | FAIL (above) | 2/30 fails, same test+assertion; product exonerated |
| 2 | Atomic lock defeat | PASS | probe: 4 readers × 200 cycles over live heartbeats → 0 torn of 800 reads, heartbeat mtime advanced; fresh half-written payload → `LockHeldError` (exit 5 path), file untouched; old unreadable → taken over as "unreadable and 40s old"; loser `release()` leaves winner's file (`lock.ts:127-143,297-313,374-391`) |
| 3 | Redaction | PASS | default `once` test greps real JSONL + real `status.json`: no plaintext, counters exact, digests stable `<redacted:…>` (`redaction.test.ts:131-159`); `--show-names`/`logShowsNames` restore plaintext (161-198); probe: counters/bytes untouched, opt-in passthrough; `status.json` 0600 (modes probe); single choke point `bootDaemon.writeHealth` (`daemon.ts:533-536`); audit of all 20 `jsonLog` sites: every path-carrying field goes through `redactName/redactPathList/redactPlan/Summary`. Out of scope by design: free-text OS/SDK error strings (SECURITY.md says so) |
| 4 | Key rotation | PASS | wrong key → exit 7 naming `PSS_KEY_FILE`, never "signed out"; `session.bin` byte-identical after refusal; `login` refuses (web flow never starts) without `--rotate-key`, proceeds with it (`key-rotation.test.ts:123-194`, all green in every run; real `FileSlot` crypto in the loop); `verify` same exit-7 contract (`daemon.ts:1714-1720`); SECURITY.md § key custody matches line for line |
| 5 | Modes | PASS | probe, umask 022 *and* 000: data dir 700; `sync-state.json`, `status.json`, `device-id`, both lock files 600; both lock dirs 700; recursive scan: zero group/other bits (`secureFs.ts:19-23,39-44`; `health.ts:109-125`) |
| 6 | `once` heartbeat | PASS* | progressing `once` writes `syncing` then keeps `status.json` fresh until `idle`; wedged `once` writes once then freezes (`once-heartbeat.test.ts:111-210`); health/heartbeat race test 50/50 green (unique tmp per write, `health.ts:113`). *Nuance: a wedged `once` goes stale silently mid-pass — no stall warning (that warn exists only in `watch`, `daemon.ts:1195`); the stale file + `status` exit 1 *is* the signal the healthcheck reads |
| 7 | Engine spelling fix | PASS | engine suite 590/590. `holdSpellingApart` (`vault.ts:373`) is an exact-string parent-listing lookup: on a normalising vault the old-spelling string is never in the listing, so the pre-fix branch runs byte-for-byte identically (same Drive calls, same state ops; only added read-only `list`). The new branch is reachable only when the listing holds the exact old name — i.e. the file genuinely exists under it — where following the rename locally is strictly more correct than re-upload-forever; taken-destination guard (`caseClashes.ts:331`) keeps the old keep-both path on conflict |
| 8 | Ops consistency | PASS | exit codes `types.ts:58-67` = entrypoint map = compose comments (4/5/6 held, 1/2/7 bounded-restart; `watch` never exits 3 — mass-hold stays in-loop at `daemon.ts:1162+`); `PSS_KEY_FILE=/run/secrets/pss_key` wired; prebuilt bundle in image contains `--rotate-key` (4 hits in `dist/pss-daemon.cjs`); healthcheck `status` exits 1 on missing/stale with passthrough; backup refuses `starting`/`syncing`/missing/unreadable (all 8 `DaemonState` strings match its sed class; `unknown` is never written to the file); CI runs type-check + 159 headless tests + 590 plugin tests + backup drill + `docker build` (`.github/workflows/ci.yml`) |

## Residual risks a human must accept before cutover

1. **Pin the flaky test** (`config.test.ts:180`): one-line, test-only. Until then CI red ~1/128 is expected noise, not product signal.
2. **Free-text leaks**: an OS/Drive error embedding a vault path still lands in JSONL/Docker logs in the clear (documented non-protection; keep `max-size/max-file` rotation and no third-party log forwarding).
3. **Same-uid readers**: any process as the daemon uid can read `session.bin` and remove the lock — unavoidable, documented in SECURITY.md.
4. **`dist/` is built, not committed**: the image only carries `--rotate-key` if `npm --workspace headless run build` precedes `docker build` (CI does; local operators must follow the Dockerfile header).
