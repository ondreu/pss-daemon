/**
 * Entry point placeholder for the headless daemon.
 *
 * The scaffold exists so the build, the bundling rules and the test runner can
 * be proven before the real modules land: the interesting work (adapter, auth,
 * lifecycle, CLI) is implemented in `headless/src` by the streams that own
 * those files. Until then this command only reports what it was built with,
 * which is also the cheapest smoke test of the shared-`src` import.
 */
import { DEFAULT_SETTINGS } from '../../src/settings';

const USAGE = `pss-daemon — headless Proton Drive sync for an Obsidian vault

Not implemented yet. Build scaffold only.

Commands planned: login, status, once, watch, verify,
approve-mass-delete, deny-mass-delete, sign-out.
`;

function main(argv: string[]): number {
    if (argv.includes('--version') || argv.includes('-v')) {
        process.stdout.write(`${require('../package.json').version}\n`);
        return 0;
    }
    if (argv.includes('--probe')) {
        // Proves the engine's settings module is bundled and reachable.
        process.stdout.write(
            JSON.stringify({ massDeleteThreshold: DEFAULT_SETTINGS.massDeleteThreshold }) + '\n',
        );
        return 0;
    }
    process.stdout.write(USAGE);
    return 0;
}

process.exit(main(process.argv.slice(2)));
