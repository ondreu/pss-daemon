# pss-daemon — headless Proton Drive sync for an Obsidian vault.
#
# Build context is the REPO ROOT (compose.yml `build: .`):
#
#   npm run build                        # -> dist/pss-daemon.cjs
#   docker build -t pss-daemon .
#
# The final image contains no build tools: it copies the prebuilt bundle
# (plus a small entrypoint wrapper) into node:24-slim and runs as
# uid/gid 65532:65532. Only /vault and /data are ever written, so the
# container can run with a read-only rootfs (see compose.yml).
#
# Synology bind-mount ownership (DSM creates shares as admin/root):
#   The daemon runs as 65532:65532 and creates session/state/cache files
#   mode 0600 inside dirs mode 0700. A root-owned host dir makes that fail
#   and the daemon refuses to start (fails closed — the lock file cannot be
#   created). Fix once over SSH as admin BEFORE first start:
#
#   chown -R 65532:65532 /volume1/docker/pss-daemon /volume1/vault
#   chmod 700 /volume1/docker/pss-daemon
#
#   If chown is not possible, override the runtime user instead
#   (compose.yml `user:`), keeping vault and data dir owned by that uid.
#   Whatever uid runs the daemon must own BOTH mounts; the two must never
#   be owned by different writers.

FROM node:24-slim

ENV LANG=C.UTF-8 \
    NODE_ENV=production

# The bundle is a self-contained CJS file with a node shebang (see
# esbuild.config.mjs banner); --chmod makes it directly executable.
COPY --chmod=755 dist/pss-daemon.cjs /usr/local/bin/pss-daemon
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/pss-daemon-entrypoint

USER 65532:65532

ENTRYPOINT ["pss-daemon-entrypoint"]
CMD ["watch"]
