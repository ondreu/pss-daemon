/* eslint-disable obsidianmd/no-nodejs-modules, obsidianmd/no-global-this, obsidianmd/prefer-window-timers, obsidianmd/hardcoded-config-path -- Node-only daemon code: it never runs inside Obsidian and is not part of main.js. */
/**
 * Loading and validation for `daemon.json`.
 *
 * The file is the only source of non-secret configuration: a typo in a
 * compose file must fail loudly at startup, never silently change what the
 * daemon syncs. Unknown keys are rejected for the same reason. Secrets never
 * appear here — the only environment inputs are `PSS_CONFIG` (which file to
 * read) and `PSS_KEY_FILE` (key material for the session file at rest).
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_SETTINGS, MIN_POLL_SECONDS } from '../engine/src/settings';
import { ExitCode, type DaemonConfig, type DaemonPaths } from './types';
import { ensurePrivateDir } from './secureFs';

export const DEFAULT_DATA_DIR = '/data/pss-daemon';
export const DEFAULT_CONFIG_PATH = path.join(DEFAULT_DATA_DIR, 'daemon.json');

/** Thrown for anything wrong with the config file; the CLI maps it to exit 7. */
export class ConfigError extends Error {
    readonly exitCode = ExitCode.ConfigInvalid;
}

const KNOWN_KEYS = new Set([
    'vaultPath',
    'configDir',
    'dataDir',
    'remoteFolderUid',
    'conflictPolicy',
    'massDeleteThreshold',
    'remotePollSeconds',
    'fullSyncOnStartup',
    'transferConcurrency',
    'pairing',
    'logLevel',
    'metadataCache',
    'logShowsNames',
]);

const CONFLICT_POLICIES: DaemonConfig['conflictPolicy'][] = ['keep-both', 'merge', 'prefer-local', 'prefer-remote'];
const PAIRINGS: NonNullable<DaemonConfig['pairing']>[] = ['adopt-drive', 'adopt-vault', 'merge'];
const LOG_LEVELS: DaemonConfig['logLevel'][] = ['debug', 'info', 'warn', 'error'];

function fail(message: string): never {
    throw new ConfigError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate raw JSON into a {@link DaemonConfig}. Pure: no
 * filesystem access, so unit tests can pin every default and rejection.
 * Filesystem checks (vault exists, data dir creatable) are {@link ensureDaemonDirs}.
 */
export function parseDaemonConfig(raw: unknown): { config: DaemonConfig; warnings: string[] } {
    if (!isRecord(raw)) {
        fail('The daemon config must be a JSON object.');
    }
    for (const key of Object.keys(raw)) {
        if (!KNOWN_KEYS.has(key)) {
            fail(`Unknown daemon config key "${key}"; refusing to guess what it meant.`);
        }
    }
    const warnings: string[] = [];

    const vaultRaw = raw['vaultPath'];
    if (typeof vaultRaw !== 'string' || vaultRaw.trim() === '') {
        fail('"vaultPath" is required: the absolute path of the vault directory to keep in sync.');
    }
    const vaultPath = path.resolve(vaultRaw);

    const configDirRaw = raw['configDir'];
    const configDir = configDirRaw === undefined ? '.obsidian' : configDirRaw;
    if (typeof configDir !== 'string' || configDir.trim() === '' || configDir.includes('/') || configDir.includes('\\') || configDir === '.' || configDir === '..') {
        fail('"configDir" must be a plain directory name inside the vault (default ".obsidian").');
    }

    const dataDirRaw = raw['dataDir'];
    const dataDir = path.resolve(typeof dataDirRaw === 'string' && dataDirRaw.trim() !== '' ? dataDirRaw : DEFAULT_DATA_DIR);
    // The state file is this device's merge base; living inside the vault
    // would sync it to other devices and corrupt the "what we last agreed
    // on" records. Refuse the layout instead of running with it.
    if (vaultPath === dataDir) {
        fail(`"dataDir" (${dataDir}) must not be the vault itself.`);
    }
    const dataRelVault = path.relative(vaultPath, dataDir);
    if (dataRelVault !== '' && !dataRelVault.startsWith('..') && !path.isAbsolute(dataRelVault)) {
        fail(`"dataDir" (${dataDir}) must never be inside the vault (${vaultPath}).`);
    }

    const remoteRaw = raw['remoteFolderUid'];
    if (remoteRaw !== undefined && remoteRaw !== null && (typeof remoteRaw !== 'string' || remoteRaw.trim() === '')) {
        fail('"remoteFolderUid" must be a Drive folder uid or null.');
    }
    const remoteFolderUid = typeof remoteRaw === 'string' ? remoteRaw : null;

    const policyRaw = raw['conflictPolicy'];
    const conflictPolicy = policyRaw === undefined ? 'merge' : policyRaw;
    if (conflictPolicy === 'manual') {
        fail('Conflict policy "manual" waits for a user who will never come; use "keep-both", "merge", "prefer-local" or "prefer-remote".');
    }
    if (!CONFLICT_POLICIES.includes(conflictPolicy as DaemonConfig['conflictPolicy'])) {
        fail(`"conflictPolicy" must be one of ${CONFLICT_POLICIES.map((policy) => `"${policy}"`).join(', ')}.`);
    }

    const thresholdRaw = raw['massDeleteThreshold'];
    const massDeleteThreshold = thresholdRaw === undefined ? DEFAULT_SETTINGS.massDeleteThreshold : thresholdRaw;
    if (typeof massDeleteThreshold !== 'number' || !Number.isInteger(massDeleteThreshold) || massDeleteThreshold < 0) {
        fail('"massDeleteThreshold" must be an integer of 0 or more (0 disables the guard).');
    }

    const pollRaw = raw['remotePollSeconds'];
    const pollGiven: unknown = pollRaw === undefined ? 60 : pollRaw;
    if (typeof pollGiven !== 'number' || !Number.isFinite(pollGiven) || pollGiven <= 0) {
        fail('"remotePollSeconds" must be a positive number of seconds.');
    }
    let remotePollSeconds: number = pollGiven;
    // Proton's own SDK polls at MIN_POLL_SECONDS; faster invites rate
    // limiting. Clamp, don't reject: a compose file written against an older
    // default keeps working, just slower.
    if (remotePollSeconds < MIN_POLL_SECONDS) {
        warnings.push(`"remotePollSeconds" ${remotePollSeconds} is below the floor of ${MIN_POLL_SECONDS}s; raised to the floor.`);
        remotePollSeconds = MIN_POLL_SECONDS;
    }

    const concurrencyRaw = raw['transferConcurrency'];
    const transferConcurrency = concurrencyRaw === undefined ? 3 : concurrencyRaw;
    if (typeof transferConcurrency !== 'number' || !Number.isInteger(transferConcurrency) || transferConcurrency < 1) {
        fail('"transferConcurrency" must be an integer of 1 or more.');
    }

    const pairingRaw = raw['pairing'];
    if (pairingRaw !== undefined && pairingRaw !== null && !PAIRINGS.includes(pairingRaw as NonNullable<DaemonConfig['pairing']>)) {
        fail(`"pairing" must be one of ${PAIRINGS.map((mode) => `"${mode}"`).join(', ')} or null.`);
    }
    const pairing = (pairingRaw ?? null) as DaemonConfig['pairing'];

    const logLevelRaw = raw['logLevel'];
    const logLevel = logLevelRaw === undefined ? 'info' : logLevelRaw;
    if (!LOG_LEVELS.includes(logLevel as DaemonConfig['logLevel'])) {
        fail(`"logLevel" must be one of ${LOG_LEVELS.map((level) => `"${level}"`).join(', ')}.`);
    }

    const cacheRaw = raw['metadataCache'];
    // Memory by default: a persisted node cache is only as fresh as the last
// event feed the process consumed, and `once` compares the tree without
    // draining events first — a stale cache there silently overwrites a remote
    // edit. The cost is a full metadata fetch per start, which is the right
    // trade for a vault that must not lose notes.
    const metadataCache = cacheRaw === undefined ? 'memory' : cacheRaw;
    if (metadataCache !== 'file' && metadataCache !== 'memory') {
        fail('"metadataCache" must be "file" or "memory".');
    }

    // A full tree walk on start: the daemon starts rarely, and a saved event
    // cursor can be past a change that never applied (a config file edited on
    // another device is the one that hurts). Default true.
    const fullSyncRaw = raw['fullSyncOnStartup'];
    const fullSyncOnStartup = fullSyncRaw === undefined ? true : fullSyncRaw;
    if (typeof fullSyncOnStartup !== 'boolean') {
        fail('"fullSyncOnStartup" must be true or false.');
    }

    // Opt-in plaintext note names in logs and status.json. Default redacts.
    const namesRaw = raw['logShowsNames'];
    const logShowsNames = namesRaw === undefined ? false : namesRaw;
    if (typeof logShowsNames !== 'boolean') {
        fail('"logShowsNames" must be true or false.');
    }

    return {
        config: {
            vaultPath,
            configDir,
            dataDir,
            remoteFolderUid,
            conflictPolicy: conflictPolicy as DaemonConfig['conflictPolicy'],
            massDeleteThreshold,
            remotePollSeconds,
            fullSyncOnStartup,
            transferConcurrency,
            pairing,
            logLevel: logLevel as DaemonConfig['logLevel'],
            metadataCache,
            logShowsNames,
        },
        warnings,
    };
}

/**
 * Which config file to read: `--config`, then `PSS_CONFIG`, then the
 * conventional path. The variable names a file; it never carries values, so
 * a secret cannot arrive through it.
 */
export function resolveConfigPath(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
    const fromEnv = env['PSS_CONFIG'];
    return explicit ?? (typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : DEFAULT_CONFIG_PATH);
}

export type LoadedConfig = {
    config: DaemonConfig;
    paths: DaemonPaths;
    warnings: string[];
    configFile: string;
};

/** Read, parse and validate the config file. Throws {@link ConfigError}. */
export async function loadDaemonConfig(options: { configPath?: string; env?: NodeJS.ProcessEnv } = {}): Promise<LoadedConfig> {
    const configFile = resolveConfigPath(options.configPath, options.env ?? process.env);
    let text: string;
    try {
        text = await readFile(configFile, 'utf8');
    } catch {
        fail(`Could not read the daemon config at ${configFile}. Set PSS_CONFIG or pass --config; it must name a daemon.json file.`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text!);
    } catch (error) {
        fail(`The daemon config at ${configFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { config, warnings } = parseDaemonConfig(raw);
    return { config, paths: resolveDaemonPaths(config, configFile), warnings, configFile };
}

/**
 * Filesystem half of validation: the vault must already exist (the daemon
 * never creates a vault — that would sync an empty directory over real
 * files), and the data dir must be creatable.
 */
export async function ensureDaemonDirs(config: DaemonConfig): Promise<void> {
    let vaultStat: Awaited<ReturnType<typeof stat>>;
    try {
        vaultStat = await stat(config.vaultPath);
    } catch {
        fail(`The vault at ${config.vaultPath} does not exist; the daemon never creates one.`);
    }
    if (!vaultStat.isDirectory()) {
        fail(`The vault at ${config.vaultPath} is not a directory.`);
    }
    try {
        await ensurePrivateDir(config.dataDir);
    } catch (error) {
        fail(`Could not create the data dir at ${config.dataDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** Every file the daemon owns, derived from the config. Nothing secret lands in the vault. */
export function resolveDaemonPaths(config: DaemonConfig, configFile: string): DaemonPaths {
    return {
        configFile,
        sessionFile: path.join(config.dataDir, 'session.bin'),
        stateFile: path.join(config.dataDir, 'sync-state.json'),
        cacheFile: path.join(config.dataDir, 'drive-cache.bin'),
        logFile: path.join(config.dataDir, 'daemon.log'),
        healthFile: path.join(config.dataDir, 'status.json'),
        lockFile: path.join(config.dataDir, 'daemon.lock'),
    };
}

/**
 * The vault-side lock, next to (not in) the synced tree: it is excluded from
 * sync by name, and it collides with a second container even when that
 * container mounts a different data dir.
 */
export function vaultLockFile(config: Pick<DaemonConfig, 'vaultPath'>): string {
    return path.join(config.vaultPath, '.proton-sync', 'daemon.lock');
}

/**
 * Key material for the session file at rest. The only secret the daemon
 * takes, and only from a file named by `PSS_KEY_FILE` — never from the
 * config file, never from a bare variable that could leak into logs.
 */
export async function loadKeyMaterial(env: NodeJS.ProcessEnv = process.env): Promise<Uint8Array> {
    const keyFile = env['PSS_KEY_FILE'];
    if (typeof keyFile !== 'string' || keyFile.trim() === '') {
        fail('PSS_KEY_FILE is not set: it must name a file holding 32 bytes of key material for the session file.');
    }
    let bytes: Buffer;
    try {
        bytes = await readFile(keyFile);
    } catch {
        fail(`Could not read the key file at ${keyFile}.`);
    }
    // Tolerate one trailing newline (e.g. `echo` without -n); anything else
    // must be exactly 32 bytes, not "close enough".
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === 0x0a) {
        end -= 1;
    }
    if (end > 0 && bytes[end - 1] === 0x0d) {
        end -= 1;
    }
    const key = bytes.subarray(0, end);
    if (key.length !== 32) {
        fail(`The key file at ${keyFile} holds ${key.length} bytes; 32 are required.`);
    }
    return new Uint8Array(key);
}
