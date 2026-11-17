/**
 * Backup-script refusal drills (P1-B).
 *
 * `once` never wrote `syncing` and the script grepped only for it, so a
 * mid-pass backup proceeded with exit 0. The script now refuses while
 * `status.json` reports `starting`/`syncing` — or is missing, when idleness
 * cannot be proven — unless `--allow-active` is passed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';

function repoRoot(): string {
    for (const candidate of [process.env['PSS_REPO_ROOT'], process.cwd(), path.resolve(process.cwd(), '..')].filter(
        (c): c is string => typeof c === 'string',
    )) {
        if (existsSync(path.join(candidate, 'scripts', 'backup-daemon-state.sh'))) {
            return candidate;
        }
    }
    throw new Error('could not locate scripts/backup-daemon-state.sh');
}

const SCRIPT = path.join(repoRoot(), 'scripts', 'backup-daemon-state.sh');

function scratch(state: { state: string } | null): { vault: string; data: string; out: string; cleanup: () => void } {
    const root = mkdtempSync(path.join(tmpdir(), 'pss-backup-'));
    const vault = path.join(root, 'vault');
    const data = path.join(root, 'data');
    const out = path.join(root, 'backups');
    mkdirSync(vault, { recursive: true });
    mkdirSync(data, { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(vault, 'note.md'), 'hello\n');
    writeFileSync(path.join(data, 'session.bin'), 'encrypted-bytes');
    if (state !== null) {
        writeFileSync(path.join(data, 'status.json'), JSON.stringify({ updatedAt: new Date().toISOString(), ...state }));
    }
    return { vault, data, out, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runBackup(s: { vault: string; data: string; out: string }, extraArgs: string[] = []): { code: number; output: string } {
    try {
        const output = execFileSync('bash', [SCRIPT, ...extraArgs], {
            encoding: 'utf8',
            env: { ...process.env, PSS_VAULT: s.vault, PSS_DATA_DIR: s.data, PSS_BACKUP_DIR: s.out, PSS_BACKUP_KEEP: '3' },
        });
        return { code: 0, output };
    } catch (error) {
        const status = (error as { status?: number }).status ?? 99;
        const stdout = (error as { stdout?: string }).stdout ?? '';
        const stderr = (error as { stderr?: string }).stderr ?? '';
        return { code: status, output: `${stdout}${stderr}` };
    }
}

describe('backup-daemon-state.sh refuses active passes', () => {
    it('refuses while status.json reports syncing (watch mid-pass)', () => {
        const s = scratch({ state: 'syncing' });
        try {
            const refused = runBackup(s);
            assert.equal(refused.code, 2, `syncing must refuse, got: ${refused.output}`);
            assert.match(refused.output, /REFUSING/);
            const allowed = runBackup(s, ['--allow-active']);
            assert.equal(allowed.code, 0, `--allow-active proceeds: ${allowed.output}`);
        } finally {
            s.cleanup();
        }
    });

    it('refuses while status.json reports starting (once mid-pass)', () => {
        const s = scratch({ state: 'starting' });
        try {
            const refused = runBackup(s);
            assert.equal(refused.code, 2, `starting must refuse, got: ${refused.output}`);
            assert.match(refused.output, /REFUSING/);
        } finally {
            s.cleanup();
        }
    });

    it('refuses when status.json is missing (idleness unprovable)', () => {
        const s = scratch(null);
        try {
            const refused = runBackup(s);
            assert.equal(refused.code, 2, `missing status must refuse, got: ${refused.output}`);
        } finally {
            s.cleanup();
        }
    });

    it('backs up an idle daemon and keeps secrets out of the archive', () => {
        const s = scratch({ state: 'idle' });
        try {
            const result = runBackup(s);
            assert.equal(result.code, 0, `idle must back up: ${result.output}`);
            const archives = readdirSync(s.out).filter((name) => name.endsWith('.tar.gz'));
            assert.equal(archives.length, 1);
            const listing = execFileSync('tar', ['-tzf', path.join(s.out, archives[0])], { encoding: 'utf8' });
            assert.doesNotMatch(listing, /session\.bin/);
            assert.match(listing, /note\.md/);
            assert.match(listing, /status\.json/);
        } finally {
            s.cleanup();
        }
    });
});
