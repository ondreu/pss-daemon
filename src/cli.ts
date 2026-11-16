/**
 * Argument parsing for `pss-daemon`. No dependency beyond builtins on
 * purpose: ~100 lines of parsing keep the audit surface small (arch doc
 * section 2), and usage errors are the caller's problem to report, not the
 * parser's — `parseArgs` never touches stdout.
 */
export type CommandName = 'login' | 'status' | 'once' | 'watch' | 'verify' | 'approve-mass-delete' | 'deny-mass-delete' | 'sign-out';

export const COMMANDS: CommandName[] = ['login', 'status', 'once', 'watch', 'verify', 'approve-mass-delete', 'deny-mass-delete', 'sign-out'];

const PAIRINGS = ['adopt-drive', 'adopt-vault', 'merge'];

export type ParsedArgs = {
    command?: CommandName;
    /** `--config PATH`: which daemon.json to read (else PSS_CONFIG, else the default path). */
    config?: string;
    /** `--json`: machine-readable output where the command supports it. */
    json?: boolean;
    /** `--dry-run`: plan only, no writes. */
    dryRun?: boolean;
    /** `--pairing MODE`: first-sync winner for this run (persisted by login). */
    pairing?: string;
    /** `--import-state PATH`: one-time copy of a GUI state file (login only). */
    importState?: string;
    help?: boolean;
    version?: boolean;
    probe?: boolean;
    /** Set when the arguments are unusable; the caller prints usage and exits 1. */
    error?: string;
};

export const USAGE = `pss-daemon — headless Proton Drive sync for an Obsidian vault

Usage:
  pss-daemon [--config PATH] <command> [flags]

Commands:
  login [--import-state PATH] [--pairing MODE]  web-flow sign-in; prints the approval URL
  status [--json]                               health + last summary (exit 1 when missing or stale)
  once [--dry-run]                              one full sync, then exit
  watch                                         poll + rescan loop until SIGTERM/SIGINT
  verify [--json]                               re-hash both sides against the state; read-only
  approve-mass-delete                           carry out the deletions a pass held back
  deny-mass-delete                              bring the held files back from Drive instead
  sign-out                                      clear the stored session

Flags:
  --config PATH        daemon.json to read (default: PSS_CONFIG or /data/pss-daemon/daemon.json)
  --json               machine-readable output (status, verify, dry-run)
  --dry-run            plan the first sync without touching either side (once only)
  --pairing MODE       adopt-drive | adopt-vault | merge (first sync of two non-empty sides)
  --import-state PATH  copy a GUI sync-state.json once (login only)

Exit codes: 0 clean · 1 usage · 2 item failures · 3 mass-delete held ·
            4 signed out · 5 already running · 6 state lost · 7 config invalid

A minimal daemon.json:
  { "vaultPath": "/vault", "remoteFolderUid": "<Drive folder uid>" }
`;

/** Parse argv (without the node/script prefix). Never throws, never prints. */
export function parseArgs(argv: string[]): ParsedArgs {
    const parsed: ParsedArgs = {};
    const positional: string[] = [];
    let i = 0;
    const fail = (error: string): ParsedArgs => ({ ...parsed, error });

    while (i < argv.length) {
        const arg = argv[i]!;
        if (arg === '--') {
            positional.push(...argv.slice(i + 1));
            break;
        }
        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else if (arg === '--version' || arg === '-v') {
            parsed.version = true;
        } else if (arg === '--probe') {
            parsed.probe = true;
        } else if (arg === '--json') {
            parsed.json = true;
        } else if (arg === '--dry-run') {
            parsed.dryRun = true;
        } else if (arg === '--config') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('-')) {
                return fail('--config needs a path.');
            }
            parsed.config = value;
            i += 1;
        } else if (arg.startsWith('--config=')) {
            parsed.config = arg.slice('--config='.length) || undefined;
            if (parsed.config === undefined) {
                return fail('--config needs a path.');
            }
        } else if (arg === '--pairing') {
            const value = argv[i + 1];
            if (value === undefined) {
                return fail('--pairing needs a mode: adopt-drive, adopt-vault or merge.');
            }
            parsed.pairing = value;
            i += 1;
        } else if (arg.startsWith('--pairing=')) {
            parsed.pairing = arg.slice('--pairing='.length);
        } else if (arg === '--import-state') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('-')) {
                return fail('--import-state needs a path.');
            }
            parsed.importState = value;
            i += 1;
        } else if (arg.startsWith('--import-state=')) {
            parsed.importState = arg.slice('--import-state='.length);
            if (parsed.importState === '') {
                return fail('--import-state needs a path.');
            }
        } else if (arg.startsWith('-')) {
            return fail(`Unknown flag "${arg}".`);
        } else {
            positional.push(arg);
        }
        i += 1;
    }

    if (positional.length > 1) {
        return fail(`Too many commands: "${positional.join(' ')}".`);
    }
    if (positional.length === 1) {
        const command = positional[0]!;
        if (!(COMMANDS as string[]).includes(command)) {
            return fail(`Unknown command "${command}".`);
        }
        parsed.command = command as CommandName;
    }
    if (parsed.pairing !== undefined && !PAIRINGS.includes(parsed.pairing)) {
        return fail(`--pairing must be one of ${PAIRINGS.map((mode) => `"${mode}"`).join(', ')}.`);
    }
    if (parsed.dryRun === true && parsed.command !== undefined && parsed.command !== 'once') {
        return fail('--dry-run only applies to `once`.');
    }
    if (parsed.importState !== undefined && parsed.command !== undefined && parsed.command !== 'login') {
        return fail('--import-state only applies to `login`.');
    }
    if (parsed.command === undefined && parsed.help !== true && parsed.version !== true && parsed.probe !== true) {
        return fail('No command given.');
    }
    return parsed;
}
