/**
 * Same shape as the plugin's `scripts/test.mjs`: Node cannot strip TypeScript
 * on the versions this repo targets, so the daemon's tests are bundled with
 * esbuild and handed to `node --test`.
 *
 * Kept separate from the plugin runner on purpose: these tests exercise the
 * daemon's own shell (config, lock, adapter, auth slot) and may import
 * `node:fs`, which the plugin's browser build must never do.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';

const outDir = mkdtempSync(path.join(tmpdir(), 'pss-daemon-tests-'));

try {
    const entryPoints = readdirSync('tests')
        .filter((file) => file.endsWith('.test.ts'))
        .map((file) => path.join('tests', file));

    if (entryPoints.length === 0) {
        console.error('No test files found.');
        process.exit(1);
    }

    await esbuild.build({
        entryPoints,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node24',
        conditions: ['browser'],
        define: { __PLUGIN_VERSION__: JSON.stringify('0.0.0-test'), __DAEMON_VERSION__: JSON.stringify('0.0.0-test') },
        outdir: outDir,
        outExtension: { '.js': '.cjs' },
        sourcemap: 'inline',
        logLevel: 'warning',
        alias: { obsidian: path.resolve('../tests/stubs/obsidian.ts') },
        banner: {
            js:
                'globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), ' +
                'clearTimeout: (t) => clearTimeout(t), crypto: globalThis.crypto };',
        },
    });

    const compiled = readdirSync(outDir)
        .filter((file) => file.endsWith('.test.cjs'))
        .map((file) => path.join(outDir, file));
    const result = spawnSync(process.execPath, ['--test', ...compiled], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
} finally {
    rmSync(outDir, { recursive: true, force: true });
}
