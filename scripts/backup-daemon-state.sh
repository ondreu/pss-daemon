#!/usr/bin/env bash
# backup-daemon-state.sh — nightly backup of the vault plus the daemon data
# dir (the sync merge base), WITHOUT ever backing up secrets.
#
# What is archived:   $PSS_VAULT (default /vault) and
#                     $PSS_DATA_DIR (default /data/pss-daemon).
# What is EXCLUDED:   session.bin (encrypted session — custody rule in
#                     SECURITY.md: it never leaves the NAS), drive-cache.bin
#                     (rebuildable encrypted cache), *.lock files and
#                     *.tmp debris (meaningless across a restore).
#
# Safety rule: refuses while a pass may be in flight. `status.json` carries
# `{state, updatedAt}`; `starting` (boot, `once` before `engine.start`,
# `watch` before its first beat) and `syncing` (a pass is running) both mean
# "do not tar now": a tar mid-pass can mix a half-written vault tree with a
# half-flushed state file. A missing `status.json` (the daemon never
# reported) or one with no readable state refuses too — idleness must be
# proven, not assumed. Pass --allow-active to override (e.g. the daemon wedged
# mid-pass and you want a copy before killing it). A stale `starting` after a
# crash also blocks — same flag overrides, after you have read the logs.
#
# Usage:
#   PSS_VAULT=/vault PSS_DATA_DIR=/data/pss-daemon \
#   PSS_BACKUP_DIR=/backups/pss-daemon PSS_BACKUP_KEEP=7 \
#   scripts/backup-daemon-state.sh [--allow-active]
#
# Cron (on the NAS, daily 03:00 — idle time, daemon still running):
#   0 3 * * * PSS_BACKUP_DIR=/volume1/backups/pss-daemon \
#     /volume1/docker/pss-daemon/scripts/backup-daemon-state.sh
#
# Exit codes: 0 backup written and verified · 1 usage/config error ·
#             2 refused (pass in flight) · 3 tar/verify/rotate failure.
set -euo pipefail

ALLOW_ACTIVE=0
for arg in "$@"; do
    case "$arg" in
        --allow-active) ALLOW_ACTIVE=1 ;;
        -h|--help)
            sed -n '2,/^#$/p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "backup-daemon-state.sh: unknown argument '$arg' (only --allow-active)." >&2
            exit 1
            ;;
    esac
done

VAULT="${PSS_VAULT:-/vault}"
DATA_DIR="${PSS_DATA_DIR:-/data/pss-daemon}"
OUT_DIR="${PSS_BACKUP_DIR:-/backups/pss-daemon}"
KEEP="${PSS_BACKUP_KEEP:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${OUT_DIR}/pss-backup-${STAMP}.tar.gz"

case "$KEEP" in
    ''|*[!0-9]*|0)
        echo "backup-daemon-state.sh: PSS_BACKUP_KEEP must be a positive integer, got '$KEEP'." >&2
        exit 1
        ;;
esac

for dir in "$VAULT" "$DATA_DIR"; do
    if [ ! -d "$dir" ]; then
        echo "backup-daemon-state.sh: not a directory: $dir" >&2
        exit 1
    fi
done
mkdir -p "$OUT_DIR"

# --- refuse mid-pass -------------------------------------------------------
# status.json carries {"state": ...}. sed-only on purpose: no jq/python on a
# minimal NAS image. Anything that cannot prove idleness refuses: a pass in
# flight (starting/syncing), a missing file, or a state that cannot be read.
STATUS_FILE="${DATA_DIR}/status.json"
ACTIVE_STATE=""
if [ -f "$STATUS_FILE" ]; then
    ACTIVE_STATE="$(sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\([a-z-]*\)".*/\1/p' "$STATUS_FILE" 2>/dev/null)"
fi
REASON=""
if [ ! -f "$STATUS_FILE" ]; then
    REASON="no status.json yet (the daemon never reported; idleness is unprovable)"
elif [ -z "$ACTIVE_STATE" ]; then
    REASON="status.json carries no readable state (corrupt or foreign; idleness is unprovable)"
else
    case "$ACTIVE_STATE" in
        starting|syncing)
            REASON="status.json reports a pass in flight (state \"$ACTIVE_STATE\")"
            ;;
    esac
fi
if [ -n "$REASON" ]; then
    if [ "$ALLOW_ACTIVE" -ne 1 ]; then
        echo "backup-daemon-state.sh: REFUSING — $REASON." >&2
        echo "  Wait for idle, or re-run with --allow-active if you mean it (a torn pair self-heals via .bak, but a mixed vault/state pair is exactly what this guard avoids)." >&2
        exit 2
    fi
    echo "backup-daemon-state.sh: WARNING — proceeding despite \"$REASON\" (--allow-active)." >&2
fi

# --- archive ---------------------------------------------------------------
# -P would store absolute names; instead archive the two dirs by basename
# from their parents so a restore lands on predictable relative paths.
VAULT_PARENT="$(dirname "$VAULT")"
VAULT_BASE="$(basename "$VAULT")"
DATA_PARENT="$(dirname "$DATA_DIR")"
DATA_BASE="$(basename "$DATA_DIR")"

if ! tar -czf "$ARCHIVE" \
    --exclude='session.bin' \
    --exclude='drive-cache.bin' \
    --exclude='*.lock' \
    --exclude='*.tmp' \
    -C "$VAULT_PARENT" "$VAULT_BASE" \
    -C "$DATA_PARENT" "$DATA_BASE"; then
    echo "backup-daemon-state.sh: tar failed; removing partial archive." >&2
    rm -f "$ARCHIVE"
    exit 3
fi

# --- verify ----------------------------------------------------------------
# 1. The archive lists cleanly. 2. No secret file got in despite excludes.
if ! tar -tzf "$ARCHIVE" >/dev/null; then
    echo "backup-daemon-state.sh: archive failed verification (tar -t); removing." >&2
    rm -f "$ARCHIVE"
    exit 3
fi
if tar -tzf "$ARCHIVE" | grep -E '(^|/)session\.bin$|(^|/)drive-cache\.bin$' >/dev/null; then
    echo "backup-daemon-state.sh: SECRET LEAK — archive contains session.bin or drive-cache.bin; removing." >&2
    rm -f "$ARCHIVE"
    exit 3
fi

# --- rotate ----------------------------------------------------------------
# Keep the newest $KEEP archives, delete the rest (oldest first).
mapfile -t OLD < <(ls -t "${OUT_DIR}"/pss-backup-*.tar.gz 2>/dev/null || true)
if [ "${#OLD[@]}" -gt "$KEEP" ]; then
    for stale in "${OLD[@]:$KEEP}"; do
        echo "backup-daemon-state.sh: rotating out $stale"
        rm -f "$stale"
    done
fi

echo "backup-daemon-state.sh: wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))."
echo "  To prove it restores: stop the daemon, extract to scratch, diff -r against live, then follow docs/headless-daemon.md §9."
