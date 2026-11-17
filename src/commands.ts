/**
 * One function per CLI command. Each takes already-parsed args plus
 * injectable IO/deps, loads the config, and returns an exit code — never
 * throws past the point where a code exists for the failure.
 */
import { ConfigError, DEFAULT_DATA_DIR, loadDaemonConfig, resolveConfigPath } from './config';
import { isHealthFresh, readHealthFile } from './health';
import { runDaemon, runLogin, runMassDecision, runSignOut, runVerify, defaultIO, type DaemonDeps, type DaemonIO } from './daemon';
import type { ParsedArgs } from './cli';
import { ExitCode } from './types';

export type CommandDeps = {
    deps?: DaemonDeps;
    io?: DaemonIO;
    env?: NodeJS.ProcessEnv;
};

function ioFor(options: CommandDeps): DaemonIO {
    return options.io ?? defaultIO(options.env);
}

function configError(message: string, io: DaemonIO): ExitCode {
    io.stderr(`pss-daemon: ${message}`);
    return ExitCode.ConfigInvalid;
}

/**
 * `status` reads the health file the daemon keeps. Missing or stale reads
 * as unhealthy (exit 1) — that is the compose healthcheck contract: it
 * must fail when the daemon died without removing its process, which a
 * liveness-only check would miss.
 */
export async function runStatus(options: { json?: boolean; configPath?: string } & CommandDeps): Promise<ExitCode> {
    const io = ioFor(options);
    const env = options.env ?? io.env;
    let healthFile = `${DEFAULT_DATA_DIR}/status.json`;
    try {
        const loaded = await loadDaemonConfig({ configPath: options.configPath, env });
        healthFile = loaded.paths.healthFile;
        for (const warning of loaded.warnings) {
            io.stderr(`pss-daemon: warning: ${warning}`);
        }
    } catch {
        // No usable config: fall back to the default health path, so
        // `status` still answers inside a container whose config mount broke.
    }
    let health: Awaited<ReturnType<typeof readHealthFile>>;
    try {
        health = await readHealthFile(healthFile);
    } catch {
        io.stderr(`pss-daemon: the health file at ${healthFile} is corrupt.`);
        return ExitCode.Usage;
    }
    if (health === null) {
        io.stdout(`pss-daemon: no status yet at ${healthFile}; the daemon never reported.`);
        return ExitCode.Usage;
    }
    if (!isHealthFresh(health)) {
        if (options.json === true) {
            io.stdout(JSON.stringify(health));
        } else {
            io.stdout(`state: ${health.state} (stale: last update ${health.updatedAt})`);
        }
        return ExitCode.Usage;
    }
    if (options.json === true) {
        io.stdout(JSON.stringify(health));
    } else {
        const summary = health.lastSummary;
        io.stdout(`state: ${health.state}`);
        io.stdout(`updated: ${health.updatedAt}`);
        if (summary !== null) {
            io.stdout(`sync: ${summary.status}, last synced at ${summary.lastSyncedAt === null ? 'never' : new Date(summary.lastSyncedAt).toISOString()}, pending ${summary.pending}, conflicts ${summary.conflicts}`);
        }
        if (health.massDeleteHeld.length > 0) {
            io.stdout(`mass-delete held: ${health.massDeleteHeld.length} paths`);
        }
        if (health.error !== null) {
            io.stdout(`error: ${health.error}`);
        }
    }
    return ExitCode.Ok;
}

export async function runCommand(parsed: ParsedArgs, options: CommandDeps = {}): Promise<ExitCode> {
    const io = ioFor(options);
    const env = options.env ?? io.env;
    if (parsed.error !== undefined) {
        io.stderr(`pss-daemon: ${parsed.error}`);
        return ExitCode.Usage;
    }
    const command = parsed.command;
    if (command === undefined) {
        // --help / --version / --probe are handled by the entry point.
        return ExitCode.Ok;
    }
    if (command === 'status') {
        return runStatus({ json: parsed.json, configPath: parsed.config, deps: options.deps, io, env });
    }
    let loaded: Awaited<ReturnType<typeof loadDaemonConfig>>;
    try {
        loaded = await loadDaemonConfig({ configPath: parsed.config, env });
    } catch (error) {
        return configError(error instanceof Error ? error.message : String(error), io);
    }
    for (const warning of loaded.warnings) {
        io.stderr(`pss-daemon: warning: ${warning}`);
    }
    const base = { config: loaded.config, paths: loaded.paths, deps: options.deps, io, env };
    try {
        switch (command) {
            case 'login':
                return await runLogin({ ...base, configFile: resolveConfigPath(parsed.config, env), importState: parsed.importState, pairing: parsed.pairing ?? null, rotateKey: parsed.rotateKey ?? false, showNames: parsed.showNames });
            case 'once':
                return await runDaemon({ ...base, mode: 'once', pairing: parsed.pairing ?? null, dryRun: parsed.dryRun, json: parsed.json, showNames: parsed.showNames });
            case 'watch':
                return await runDaemon({ ...base, mode: 'watch', pairing: parsed.pairing ?? null, showNames: parsed.showNames });
            case 'verify':
                return await runVerify({ ...base, json: parsed.json, showNames: parsed.showNames });
            case 'approve-mass-delete':
                return await runMassDecision({ ...base, approve: true, pairing: parsed.pairing ?? null, showNames: parsed.showNames });
            case 'deny-mass-delete':
                return await runMassDecision({ ...base, approve: false, pairing: parsed.pairing ?? null, showNames: parsed.showNames });
            case 'sign-out':
                return await runSignOut(base);
        }
    } catch (error) {
        // Everything with its own code already returned; this is unexpected —
        // except configuration failures, which carry exit 7 for the runbook.
        if (error instanceof ConfigError) {
            io.stderr(`pss-daemon: ${error instanceof Error ? error.message : String(error)}`);
            return ExitCode.ConfigInvalid;
        }
        io.stderr(`pss-daemon: internal error: ${error instanceof Error ? error.message : String(error)}`);
        return ExitCode.Usage;
    }
}
