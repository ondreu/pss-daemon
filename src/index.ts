/**
 * Entry point for the headless daemon.
 *
 * Thin by design: parse, dispatch, exit with the command's code. The
 * engine's settings module stays reachable through `--probe`, the cheapest
 * smoke test that the shared `src` is bundled.
 */
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

main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error: unknown) => {
        process.stderr.write(`pss-daemon: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    },
);
