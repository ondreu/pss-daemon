/**
 * CLI parsing and the exit-code table. Parsing never touches IO; commands
 * are exercised through `runCommand` with captured output only for `status`
 * (the one command that needs no vault, no network, no session).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseArgs, USAGE } from '../src/cli';
import { runCommand } from '../src/commands';
import { ExitCode } from '../src/types';

test('every command parses, with its flags', () => {
    assert.equal(parseArgs(['once']).command, 'once');
    assert.equal(parseArgs(['watch']).command, 'watch');
    assert.equal(parseArgs(['status']).command, 'status');
    assert.equal(parseArgs(['login']).command, 'login');
    assert.equal(parseArgs(['verify']).command, 'verify');
    assert.equal(parseArgs(['approve-mass-delete']).command, 'approve-mass-delete');
    assert.equal(parseArgs(['deny-mass-delete']).command, 'deny-mass-delete');
    assert.equal(parseArgs(['sign-out']).command, 'sign-out');
    const full = parseArgs(['--config', '/x.json', 'once', '--dry-run', '--json']);
    assert.equal(full.config, '/x.json');
    assert.equal(full.dryRun, true);
    assert.equal(full.json, true);
    assert.equal(parseArgs(['--config=/x.json', 'status']).config, '/x.json');
    assert.equal(parseArgs(['login', '--import-state', '/s.json', '--pairing=merge']).importState, '/s.json');
    assert.equal(parseArgs(['once', '--show-names']).showNames, true);
    assert.equal(parseArgs(['watch', '--show-names']).showNames, true);
    assert.equal(parseArgs(['login', '--rotate-key']).rotateKey, true);
    assert.equal(parseArgs(['login', '--force']).rotateKey, true);
});

test('bad input explains itself without throwing', () => {
    for (const argv of [
        ['nope'],
        ['once', 'watch'],
        ['once', '--bogus'],
        ['--config'],
        ['--pairing'],
        ['once', '--pairing', 'merge-theirs'],
        ['watch', '--dry-run'],
        ['once', '--import-state', '/s.json'],
        ['once', '--rotate-key'],
        [],
    ]) {
        const parsed = parseArgs(argv);
        assert.ok(parsed.error !== undefined, `expected an error for ${JSON.stringify(argv)}`);
    }
    assert.equal(parseArgs(['--help']).help, true);
    assert.ok(USAGE.includes('approve-mass-delete'));
});

test('exit codes are the contract: distinct and stable', () => {
    assert.deepEqual(
        { ...ExitCode },
        {
            Ok: 0,
            Usage: 1,
            ItemFailures: 2,
            MassDeleteHeld: 3,
            SignedOut: 4,
            AlreadyRunning: 5,
            StateLost: 6,
            ConfigInvalid: 7,
        },
    );
});

test('usage errors exit 1 and name the problem', async () => {
    const errors: string[] = [];
    const code = await runCommand(parseArgs(['nope']), { io: { stdout: () => undefined, stderr: (line) => errors.push(line), env: {} } });
    assert.equal(code, ExitCode.Usage);
    assert.match(errors.join('\n'), /Unknown command/);
});

test('an invalid config exits 7 without touching anything else', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pss-cli-'));
    try {
        const bad = path.join(root, 'daemon.json');
        writeFileSync(bad, JSON.stringify({ vaultPath: root, conflictPolicy: 'manual' }));
        const errors: string[] = [];
        const code = await runCommand(parseArgs(['--config', bad, 'once']), {
            io: { stdout: () => undefined, stderr: (line) => errors.push(line), env: {} },
        });
        assert.equal(code, ExitCode.ConfigInvalid);
        assert.match(errors.join('\n'), /manual/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('status reports missing health as unhealthy (exit 1)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pss-cli-'));
    try {
        const file = path.join(root, 'daemon.json');
        writeFileSync(file, JSON.stringify({ vaultPath: root, dataDir: path.join(root, 'data') }));
        const errors: string[] = [];
        const code = await runCommand(parseArgs(['--config', file, 'status']), {
            io: { stdout: (line) => errors.push(line), stderr: () => undefined, env: {} },
        });
        assert.equal(code, ExitCode.Usage);
        assert.match(errors.join('\n'), /no status yet/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
