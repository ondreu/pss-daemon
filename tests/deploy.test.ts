/**
 * Deployment artifact lint: Dockerfile, compose.yml and the backup script.
 *
 * Static file-content checks only — this test deliberately imports no
 * product code, so it stays valid no matter what the engine stream changes
 * in headless/src. Run with the rest of the daemon suite:
 * `npm --workspace headless test`.
 *
 * The repo root is found by walking up from the working directory (the
 * bundled tests execute with cwd = headless/), overridable via
 * PSS_REPO_ROOT.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function repoRoot(): string {
    const candidates = [
        process.env['PSS_REPO_ROOT'],
        process.cwd(),
        path.resolve(process.cwd(), '..'),
        path.resolve(process.cwd(), '..', '..'),
    ].filter((candidate): candidate is string => typeof candidate === 'string');
    for (const candidate of candidates) {
        if (existsSync(path.join(candidate, 'compose.yml')) && existsSync(path.join(candidate, 'Dockerfile'))) {
            return candidate;
        }
    }
    throw new Error(`Could not locate the repo root (need compose.yml + Dockerfile); tried ${candidates.join(', ')}. Set PSS_REPO_ROOT.`);
}

function readRepo(relative: string): string {
    return readFileSync(path.join(repoRoot(), relative), 'utf8');
}

describe('deployment artifacts', () => {
    it('Dockerfile runs the prebuilt bundle as non-root with no build tools', () => {
        const dockerfile = readRepo('Dockerfile');
        assert.match(dockerfile, /FROM node:24-slim/, 'pins node:24-slim');
        assert.match(dockerfile, /USER 65532:65532/, 'drops to uid/gid 65532');
        assert.match(
            dockerfile,
            /COPY --chmod=755 headless\/dist\/pss-daemon\.cjs \/usr\/local\/bin\/pss-daemon/,
            'ships the prebuilt bundle from headless/dist, not a build',
        );
        assert.match(dockerfile, /ENTRYPOINT \["pss-daemon-entrypoint"\]/, 'wraps exits that need a human');
        for (const forbidden of ['npm install', 'npm ci', 'apt-get', 'apk add']) {
            assert.doesNotMatch(dockerfile, new RegExp(forbidden.replace(/ /g, ' ')), `final image must not run: ${forbidden}`);
        }
    });

    it('compose.yml cannot hot-loop exits 4/5/6 and bounds the rest', () => {
        const compose = readRepo('compose.yml');
        assert.match(compose, /restart:\s*"on-failure:\d+"/, 'bounded on-failure restart, never unless-stopped/always');
        assert.doesNotMatch(compose, /restart:\s*(unless-stopped|always)/, 'must not restart held exits unconditionally');
        assert.match(compose, /test:\s*\["CMD",\s*"pss-daemon",\s*"status"\]/, 'healthcheck probes freshness via status');
        assert.match(compose, /start_period:\s*\d+m/, 'start_period covers the 134 MB first sync');
        assert.match(compose, /max-size:\s*"\d+m"/, 'log rotation max-size set');
        assert.match(compose, /max-file:\s*"\d+"/, 'log rotation max-file set');
        assert.match(compose, /mem_limit:\s*\d+m/, 'memory limit set');
        assert.match(compose, /cpus:\s*[\d.]+/, 'cpu limit set');
        assert.match(compose, /PSS_KEY_FILE:\s*\/run\/secrets\/pss_key/, 'key arrives via Docker secret, never env value');
        assert.match(compose, /^\s*-\s*pss_key$/m, 'secret wired into the service');
        assert.match(compose, /user:\s*"65532:65532"/, 'runs as non-root');
        assert.match(compose, /read_only:\s*true/, 'read-only rootfs declared');
    });

    it('entrypoint wrapper holds 4/5/6 and passes everything else through', () => {
        const entry = readRepo('headless/docker-entrypoint.sh');
        for (const code of ['4)', '5)', '6)']) {
            assert.ok(entry.includes(code), `wrapper handles exit ${code}`);
        }
        assert.match(entry, /exec \/usr\/local\/bin\/pss-daemon "\$@"/, 'status path execs through untouched');
    });

    it('backup script never archives secrets and refuses mid-pass', () => {
        const backup = readRepo('scripts/backup-daemon-state.sh');
        assert.match(backup, /--exclude='session\.bin'/, 'excludes the encrypted session');
        assert.match(backup, /--exclude='drive-cache\.bin'/, 'excludes the drive cache');
        assert.match(backup, /"\$STATUS_FILE"/, 'consults status.json before archiving');
        assert.match(backup, /--allow-active/, 'mid-pass override is explicit');
        assert.match(backup, /tar -tzf "\$ARCHIVE"/, 'verifies the archive with tar -t');
        assert.match(backup, /PSS_BACKUP_KEEP/, 'rotates to N copies');
    });
});
