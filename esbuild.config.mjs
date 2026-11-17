/**
 * The daemon is a Node program, but it shares every sync decision with the
 * plugin: it imports `../src/sync` and `../src/proton` directly instead of
 * carrying a copy. That is the whole point of the package — a conflict fix
 * must never need applying twice.
 *
 * Two settings are inherited from `scripts/test.mjs` rather than from the
 * plugin build, because the daemon runs outside Obsidian the same way the
 * tests do:
 *
 * - `conditions: ['browser']`, because `@protontech/crypto` imports
 *   `openpgp/lightweight`, whose package exports only resolve under that
 *   condition. The tests need it for the same reason.
 * - The `window` banner, because the engine schedules through
 *   `window.setTimeout` for popout-window compatibility in Obsidian. Node has
 *   no `window`; a minimal one forwards to the globals at call time.
 *
 * The `obsidian` module only exists inside the app, so it is aliased to the
 * tests' stub. Anything the stub does not implement must be replaced behind an
 * adapter in `headless/src`, not emulated here.
 */
import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const production = process.argv[2] === 'production';
const { version } = JSON.parse(readFileSync('./package.json', 'utf8'));
// The session identifies itself to Proton with the plugin's version, so read it
// from the manifest the release workflow stamps rather than from this package.
const { version: pluginVersion } = JSON.parse(readFileSync('engine/manifest.json', 'utf8'));

const banner = [
    '#!/usr/bin/env node',
    `/*! pss-daemon ${version} — GPL-3.0-or-later — built on proton-sdk-sync */`,
    // See the comment above: the engine expects a browser-ish global.
    'globalThis.window ??= { setTimeout: (...a) => setTimeout(...a),' +
        ' clearTimeout: (t) => clearTimeout(t), crypto: globalThis.crypto };',
    // `VaultIO` reaches for `window.require('fs')` to stream files above
    // LARGE_FILE_BYTES instead of reading them whole. In Obsidian that is
    // Electron's require; here it is Node's own, so the streaming path stays
    // available and a 300 MB attachment cannot be pulled into memory at once.
    'globalThis.window.require ??= (id) => require(id);',
].join('\n');

await esbuild.build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/pss-daemon.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    conditions: ['browser'],
    define: { __PLUGIN_VERSION__: JSON.stringify(pluginVersion), __DAEMON_VERSION__: JSON.stringify(version) },
    alias: { obsidian: path.resolve('engine/tests/stubs/obsidian.ts') },
    external: builtinModules,
    sourcemap: production ? false : 'inline',
    minify: production,
    banner: { js: banner },
    logLevel: 'info',
    metafile: true,
});
