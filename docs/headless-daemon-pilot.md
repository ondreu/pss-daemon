# Pilot and cutover: headless daemon on the real vault

Status: runbook, not yet executed. Nothing here touches the live vault until
step 6, and every step before it is reversible by stopping the daemon.

The canary Drive folder already exists: `/my-files/08-Test/pss-canary-2026-11-17`.
The vault copy for the pilot is `/volume1/obsidian-pilot/vault` (a copy of
`/volume1/docker/obsidian/vault`, taken while the official headless client is
paused for the copy only).

## 0. Preconditions

| Thing | Where | Check |
|---|---|---|
| Bundle | `headless/dist/pss-daemon.cjs` | `npm --workspace headless run build` |
| Key file | `/opt/data/secrets/pss-key.bin` (32 random bytes, 0600) | `wc -c` = 32 |
| Config | `/volume1/docker/pss-daemon/daemon.json` | see below |
| Canary uid | `pss-daemon resolve-folder 08-Test/pss-canary-2026-11-17 --create --json` | the daemon's own resolver; a uid copied from the Proton CLI is **not** usable by this SDK (it fails with `LinkIDs[0] is not a valid ID`) |
| No second writer | `docker ps` on the NAS | `obsidian-sync` still running for the real vault, nothing else mounts the pilot copy |

`daemon.json` for the pilot:

```json
{
  "vaultPath": "/volume1/obsidian-pilot/vault",
  "dataDir": "/volume1/docker/pss-daemon-pilot",
  "remoteFolderUid": "<canary uid>",
  "conflictPolicy": "merge",
  "remotePollSeconds": 60,
  "logLevel": "info"
}
```

## 1. Sign in once (needs a human with a browser)

```sh
PSS_CONFIG=/volume1/docker/pss-daemon-pilot/daemon.json \
PSS_KEY_FILE=/opt/data/secrets/pss-key.bin \
  pss-daemon login
```

The command prints a `account.proton.me` approval URL and waits. Open it on
any device, approve, and the daemon stores the encrypted session
(`session.bin`, 0600) in the data dir. Password and 2FA never touch the NAS.
The window is short: if it expires, run `login` again for a fresh URL.

## 2. First sync on the copy (no pairing flag: remote is empty)

```sh
PSS_CONFIG=... PSS_KEY_FILE=... pss-daemon once
echo $?   # 0 = in sync, 2 = item failures, 3 = mass-delete held
```

## 3. Prove it, do not eyeball it

1. `pss-daemon verify` → reports no divergence, exit 0.
2. Manifest comparison, both directions:

   ```sh
   (cd /volume1/obsidian-pilot/vault && find . -type f -not -path './.git/*' -print0 \
     | sort -z | xargs -0 sha1sum) > /tmp/pilot-local.sha1
   ```

   Download the canary tree with the Proton CLI into a scratch dir and run the
   same manifest there; `diff` must be empty except the engine's exclusions
   (`.git/`, `.trash/`, the plugin's own folder, `*.tmp`).
3. A second `once` must be a no-op: zero uploads/downloads in the log, exit 0.
4. Edit one note locally and one on Drive; a third `once` must produce one
   conflict copy, both versions complete, no overwrite.
5. `rm` one note locally; `once` must either hold (mass-delete threshold) or,
   for a single file, delete it remotely — with the path redacted in the log
   unless `--show-names` was passed.

## 4. Pilot soak (2–3 weeks, real use)

Run `watch` under the supervisor against the pilot copy while the real vault
stays on Obsidian Sync. Twice a day check:

- `pss-daemon status --json` → `state: idle`, `pendingConflicts` stable,
  `massDeleteHeld` empty, `updatedAt` fresh.
- The log for `stalled`, `key-mismatch`, `signed-out`, `state-lost` — any of
  these stops the pilot, they are not warnings.
- Nightly: `scripts/backup-daemon-state.sh` (excludes secrets) and the
  `verify` output kept as evidence.

Gate to continue: a full week with zero unexplained conflict copies, zero
`retry` left at idle, and `verify` clean every day.

## 5. Cutover (only after the pilot gate)

1. Pause the official client: `docker stop obsidian-sync` (the real vault stops
   updating; the plugin on PC/phone keeps working through Proton only if you
   already switched those devices — otherwise pause them too).
2. Point `daemon.json.vaultPath` at the real vault; keep `remoteFolderUid` =
   the folder the devices use (not the canary).
3. `pss-daemon once --pairing=merge` — the first pass pairs by content, since
   both sides are non-empty. Watch the log; exit 3 means the mass-delete guard
   held, resolve it explicitly with `approve-mass-delete` only after diffing.
4. `pss-daemon verify`, then the manifest comparison from step 3.
5. Start `watch` under the supervisor; keep `obsidian-sync` stopped (never both).
6. Keep the last Obsidian Sync snapshot and the state backup for seven days.

## 6. Rollback (rehearse before cutover)

1. `pss-daemon sign-out` is NOT needed; just stop the daemon.
2. `docker start obsidian-sync` — the official client resumes from its own
   state; it will see whatever the daemon wrote as remote changes.
3. If the state was lost (`state-lost`, exit 6): restore
   `<dataDir>/sync-state.json` from the nightly backup BEFORE starting the
   daemon again; without it the first pass re-baselines and can resurrect
   deletions on every device.
4. Timed drill: from a clean shell, restore state + start `watch` + `verify`
   in under 30 minutes; log the time.

## What this runbook does not cover

- Mobile and desktop Obsidian still need the plugin (or Obsidian Sync) —
  the daemon only replaces the server-side headless client.
- Proton SDK is pre-release; a version bump is a re-test, not a rebuild
  (`npm --workspace headless test` + `test:integration` + canary `once`).
- The daemon cannot repair a wrongly approved mass delete; only Drive's
  version history can.
