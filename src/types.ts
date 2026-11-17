/* eslint-disable obsidianmd/no-nodejs-modules, obsidianmd/no-global-this, obsidianmd/prefer-window-timers, obsidianmd/hardcoded-config-path -- Node-only daemon code: it never runs inside Obsidian and is not part of main.js. */
/**
 * The shapes every headless module shares. Kept deliberately small: the
 * engine already owns the sync types (`../src/sync/types.ts`), so only what is
 * new in the daemon belongs here.
 */

/** How the daemon resolves a conflict when nobody is there to decide. */
export type DaemonConflictPolicy = 'keep-both' | 'merge' | 'prefer-local' | 'prefer-remote';

/**
 * `daemon.json`. Validated at startup; unknown keys are rejected so a typo in
 * a compose file cannot silently fall back to a default that changes data.
 */
export type DaemonConfig = {
    /** Absolute path of the vault directory to keep in sync. */
    vaultPath: string;
    /** Obsidian config directory inside the vault. Default `.obsidian`. */
    configDir: string;
    /** Where session, state, cache and logs live. Never inside the vault. */
    dataDir: string;
    /** Drive folder uid to pair with, once known. */
    remoteFolderUid: string | null;
    conflictPolicy: DaemonConflictPolicy;
    /** Above this many deletions in one pass, hold the pass. 0 disables. */
    massDeleteThreshold: number;
    /** Seconds between Drive polls. Floored at MIN_POLL_SECONDS. */
    remotePollSeconds: number;
    transferConcurrency: number;
    /** Only needed when both sides already hold files. */
    pairing: 'adopt-drive' | 'adopt-vault' | 'merge' | null;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    /**
     * `file` keeps the encrypted Drive node cache between starts; `memory`
     * trades a slower start for less on disk.
     */
    metadataCache: 'file' | 'memory';
    /**
     * Opt-in plaintext note names in logs and `status.json`. Default false:
     * structured note paths redact to a stable digest instead.
     */
    logShowsNames: boolean;
};

export type DaemonPaths = {
    configFile: string;
    sessionFile: string;
    stateFile: string;
    cacheFile: string;
    logFile: string;
    healthFile: string;
    lockFile: string;
};

/**
 * Exit codes are part of the contract with the supervisor; compose health
 * checks and the rollback runbook read them.
 */
export const ExitCode = {
    Ok: 0,
    Usage: 1,
    ItemFailures: 2,
    MassDeleteHeld: 3,
    SignedOut: 4,
    AlreadyRunning: 5,
    StateLost: 6,
    ConfigInvalid: 7,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
