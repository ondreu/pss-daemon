/* eslint-disable obsidianmd/no-nodejs-modules, obsidianmd/no-global-this, obsidianmd/prefer-window-timers, obsidianmd/hardcoded-config-path -- Node-only daemon code: it never runs inside Obsidian and is not part of main.js. */
/**
 * Entry point for the headless daemon.
 *
 * Thin by design: parse, dispatch, exit with the command's code. The
 * engine's settings module stays reachable through `--probe`, the cheapest
 * smoke test that the shared `src` is bundled.
 */
// First, before anything that can reach SDK code: the SDK bundles no
// polyfills, and its base64/hex helpers throw a bare TypeError when missing.
// The plugin does the same in src/main.ts.
import '../../src/polyfills';

import { DEFAULT_SETTINGS } from '../../src/settings';
import { parseArgs, USAGE } from './cli';
import { runCommand } from './commands';

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
    const parsed = parseArgs(argv);
    if (parsed.version === true) {
        process.stdout.write(`${__DAEMON_VERSION__}\n`);
        return 0;
    }
    if (parsed.probe === true) {
        process.stdout.write(JSON.stringify({ massDeleteThreshold: DEFAULT_SETTINGS.massDeleteThreshold }) + '\n');
        return 0;
    }
    if (parsed.help === true || parsed.command === undefined) {
        const code = parsed.error !== undefined ? 1 : 0;
        (code === 0 ? process.stdout : process.stderr).write(USAGE);
        if (parsed.error !== undefined) {
            process.stderr.write(`pss-daemon: ${parsed.error}\n`);
        }
        return code;
    }
    if (parsed.error !== undefined) {
        process.stderr.write(USAGE);
        process.stderr.write(`pss-daemon: ${parsed.error}\n`);
        return 1;
    }
    return runCommand(parsed, { env });
}

/**
 * Exit only once stdout has drained.
 *
 * `process.exit()` drops whatever is still buffered in a pipe, and `verify
 * --json` on a real vault is far larger than one pipe buffer: the report was
 * cut at 64 KiB and could not be parsed. Awaiting the flush costs one turn and
 * makes machine-readable output whole.
 */
function exitAfterFlush(code: number): void {
    process.stdout.write('', () => process.exit(code));
}

main(process.argv.slice(2), process.env).then(
    (code) => exitAfterFlush(code),
    (error: unknown) => {
        process.stderr.write(`pss-daemon: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
        process.stderr.write('', () => process.exit(1));
    },
);
