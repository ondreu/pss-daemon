# pss-daemon

Headless [Proton Drive](https://proton.me/drive) sync for an Obsidian vault, for
a Linux server with no Obsidian and no desktop session. It is the engine of
[Proton-SDK-Sync](https://github.com/ondreu/proton-sdk-sync), not a copy of it:
the plugin repository is a submodule at `engine/`, and a conflict fix lands once
for both.

It is not a wrapper around the Proton CLI. The CLI has no sync, no watch, no
mount and a non-recursive listing; a daemon built on it cannot keep a tree in
step. This runs the plugin's `SyncEngine`, state and `VaultIO`/`DriveIO`
unchanged and supplies the process, filesystem, auth-at-rest and watcher around
them.

## What it does

- Two-way sync between a folder in Proton Drive and a directory on the server,
  with the plugin's three-way conflict detection and its exclusions.
- `watch` keeps it in step; `once` is a single pass for cron or a first sync.
- Large deletion batches are **held** for an explicit `approve-mass-delete`
  (exit 3); nothing is approved automatically.
- Logs and `status.json` redact note names by default (`--show-names` opts in);
  `status.json` is 0600, the data dir 0700.
- One process per vault: a lock in the data dir and in the vault. A stale
  holder is detected by heartbeat age, not by pid alone.
- The session is stored encrypted (scrypt + AES-256-GCM) with a key read from
  `PSS_KEY_FILE`; the password never touches the server, sign-in is a device
  flow. A key that does not decrypt the session refuses to start (exit 7)
  instead of looking "signed out".
- Exit codes are part of the contract: 0 OK, 1 usage/no status, 2 safety
  refusal, 3 mass delete held, 4 signed out, 5 already running, 6 state lost,
  7 config error.

## Build

The engine is a git submodule:

```sh
git clone --recurse-submodules https://github.com/ondreu/pss-daemon.git
cd pss-daemon
npm install
npm run build            # -> dist/pss-daemon.cjs
```

Node 24 is what CI uses; the bundle is CJS with a shebang and runs on 22+.

## Configure and sign in

```sh
head -c 32 /dev/urandom > pss_key.bin && chmod 600 pss_key.bin
cat > daemon.json <<'JSON'
{ "vaultPath": "/srv/vault", "remoteFolderUid": "<Drive folder uid>",
  "conflictPolicy": "merge" }
JSON

export PSS_CONFIG=$PWD/daemon.json PSS_KEY_FILE=$PWD/pss_key.bin
node dist/pss-daemon.cjs login          # prints a Proton approval URL
node dist/pss-daemon.cjs resolve-folder /my-files/09-Vault/vault --create
node dist/pss-daemon.cjs once           # first pass; --pairing when both sides hold files
node dist/pss-daemon.cjs verify         # tree + hashes, no writes
node dist/pss-daemon.cjs watch          # the service
```

`resolve-folder --create` matters: a folder created by the Proton CLI has an id
this SDK rejects (`LinkIDs[0] is not a valid ID`).

A first sync where **both** sides already hold files is the one destructive
case: pair them explicitly with `once --pairing=<digest>` (the pass prints the
digest), or start with an empty folder on one side.

## Docker

`Dockerfile` expects the bundle built on the host (no build tools in the final
image, non-root, read-only rootfs) and `compose.yml` wires the key as a Docker
secret, a healthcheck on `status`, bounded restarts (exits 4/5/6 are mapped to a
clean stop — they need a human, restarting would hot-loop), log rotation and
memory/CPU limits.

```sh
npm run build
docker compose up -d --build
docker compose exec pss-daemon pss-daemon login
```

The daemon must own both the vault and the data directory (uid/gid 65532 in the
image); a root-owned bind mount makes it fail closed on the lock.

## Tests

```sh
npm test                     # 164 unit tests
npm run test:integration     # 20 fake-Drive scenarios
npm run chaos -- --minutes 10 --seed 11   # concurrent writers, token coverage
npm run check-types
```

`test:integration` and `chaos` are the ones that matter before trusting a
change: they run two writers against a fake Drive with kills, renames,
case/NFD twins, 429s and folder contests, and fail on a token that no clean
policy explains.

## Docs

- [docs/headless-daemon.md](docs/headless-daemon.md) — design and decisions.
- [docs/headless-daemon-pilot.md](docs/headless-daemon-pilot.md) — cutover runbook.
- [docs/headless-daemon-test-plan.md](docs/headless-daemon-test-plan.md) — fault catalogue and gates.
- [docs/review-correctness.md](docs/review-correctness.md),
  [docs/review-security-ops.md](docs/review-security-ops.md),
  [docs/review-final.md](docs/review-final.md) — independent reviews.

GPL-3.0-or-later. The engine is © Marcos and the Proton-SDK-Sync
contributors; see the plugin repository for attribution.
