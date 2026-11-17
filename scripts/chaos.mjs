/**
 * Chaos launcher: bundles `scripts/chaos.ts` (plus the test support and `src`
 * it imports) with esbuild, then runs it with the CLI args passed through.
 *
 * Same banner/alias setup as the test runners: the engine schedules through
 * `window.setTimeout`, and `obsidian` resolves to the tests' stub.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';

const outDir = mkdtempSync(path.join(tmpdir(), 'pss-daemon-chaos-'));

try {
    await esbuild.build({
        entryPoints: [path.join('scripts', 'chaos.ts')],
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
        alias: { obsidian: path.resolve('engine/tests/stubs/obsidian.ts') },
        banner: {
            js:
                'globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), ' +
                'clearTimeout: (t) => clearTimeout(t), crypto: globalThis.crypto };',
        },
    });

    const compiled = path.join(outDir, 'chaos.cjs');
    const result = spawnSync(process.execPath, [compiled, ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
} finally {
    rmSync(outDir, { recursive: true, force: true });
}
