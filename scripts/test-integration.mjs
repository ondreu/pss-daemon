/**
 * Integration runner: the real `SyncEngine` + real `SyncState` on temp dirs
 * against the fault-injecting fake Drive (`tests/sync.integration.ts`).
 *
 * Same shape as `scripts/test.mjs` (esbuild bundle, then `node --test`), but
 * compiling exactly one entry file so the fault/chaos evidence stays out of
 * the fast unit loop. The file under test imports `../../src` directly, the
 * way the daemon does.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';

const outDir = mkdtempSync(path.join(tmpdir(), 'pss-daemon-integration-'));

try {
    await esbuild.build({
        entryPoints: [path.join('tests', 'sync.integration.ts')],
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

    const compiled = path.join(outDir, 'sync.integration.cjs');
    const result = spawnSync(process.execPath, ['--test', compiled], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
} finally {
    rmSync(outDir, { recursive: true, force: true });
}
