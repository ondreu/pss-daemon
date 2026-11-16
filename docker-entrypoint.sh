#!/bin/sh
# pss-daemon container entrypoint: run the daemon, then translate exits that
# need a human into a clean stop so the supervisor does NOT hot-loop them.
#
# Daemon exit contract (headless/src/types.ts):
#   0 ok · 1 usage · 2 item failures · 3 mass-delete held · 4 signed out ·
#   5 already running · 6 state lost · 7 config invalid
#
# compose.yml restarts `on-failure:5`. Without this wrapper that policy
# would restart exit 4 (revoked session — needs a browser re-login) and
# exit 6 (torn state — needs a restore from backup) forever, and would
# also spin on exit 5 (a second container racing the same vault). Those
# three mean "stop and page a human", so they become exit 0 AFTER logging
# loudly; the reason stays visible in `docker compose logs` and in
# status.json (`signed-out` / `error`), while `docker inspect` shows a
# clean stop instead of a crash loop.
#
# Everything else passes through untouched: transient failures (1, 2, 7)
# restart up to the compose bound, then the container stays stopped and a
# human runs `docker compose up pss-daemon` after reading the logs.
set -u

exec_cmd="${1:-watch}"

# `status` (the compose healthcheck) must report, never remap: it already
# uses exit 1 for missing/stale, which is exactly what the healthcheck
# contract needs.
if [ "$exec_cmd" = "status" ]; then
    exec /usr/local/bin/pss-daemon "$@"
fi

/usr/local/bin/pss-daemon "$@"
code=$?

case "$code" in
    4)
        echo "pss-daemon-entrypoint: HOLDING — exit 4 (signed out / session revoked). This needs a human: run \`pss-daemon login\` in a one-off container with the key file, then restart. NOT restarting automatically." >&2
        exit 0
        ;;
    5)
        echo "pss-daemon-entrypoint: HOLDING — exit 5 (already running: another daemon holds the data-dir or vault lock). Check for a second container over the same vault, then start this one. NOT restarting automatically." >&2
        exit 0
        ;;
    6)
        echo "pss-daemon-entrypoint: HOLDING — exit 6 (sync state lost). This needs a human: restore the data dir from backup (see docs/headless-daemon.md §9), then restart. NOT restarting automatically." >&2
        exit 0
        ;;
    *)
        exit "$code"
        ;;
esac
