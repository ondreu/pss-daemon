/* eslint-disable obsidianmd/no-nodejs-modules, obsidianmd/no-global-this, obsidianmd/prefer-window-timers, obsidianmd/hardcoded-config-path -- Node-only daemon code: it never runs inside Obsidian and is not part of main.js. */
/**
 * Note-name redaction for logs and the health file (P1-2).
 *
 * Structured note paths are redacted by default: each path maps to a stable
 * short digest (`<redacted:a1b2c3d4>`), so logs stay correlatable across
 * lines without naming anything. Counters (counts, pending, conflicts) are
 * never touched. `--show-names` (`logShowsNames` in daemon.json) opts back
 * into plaintext.
 *
 * Free-text error strings are deliberately out of scope: an OS or Drive SDK
 * error may embed a path no pattern can reliably find. Operators treat logs
 * accordingly; see SECURITY.md.
 */
import { createHash } from 'node:crypto';

import type { SyncPlan, SyncSummary } from '../engine/src/sync/engine';

/** One path's stable pseudonym. `redactName(x) === redactName(x)`, always. */
export function redactName(value: string): string {
    return `<redacted:${createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 8)}>`;
}

/** Redact a path list in place-shape; a passthrough copy when opted in. */
export function redactPathList(paths: readonly string[], showNames: boolean): string[] {
    return showNames ? [...paths] : paths.map((entry) => redactName(entry));
}

/** Redact the path-carrying fields of a sync summary; counters untouched. */
export function redactSummary(summary: SyncSummary, showNames: boolean): SyncSummary {
    if (showNames) {
        return summary;
    }
    return {
        ...summary,
        transfer: summary.transfer === null ? null : { ...summary.transfer, path: redactName(summary.transfer.path) },
        pendingMassDelete:
            summary.pendingMassDelete === undefined
                ? undefined
                : { count: summary.pendingMassDelete.count, paths: summary.pendingMassDelete.paths.map((entry) => redactName(entry)) },
    };
}

/** Redact a first-sync plan's path arrays; counts untouched. */
export function redactPlan(plan: SyncPlan, showNames: boolean): SyncPlan {
    if (showNames) {
        return plan;
    }
    return {
        ...plan,
        uploads: plan.uploads.map((entry) => redactName(entry)),
        downloads: plan.downloads.map((entry) => redactName(entry)),
        conflicts: plan.conflicts.map((entry) => redactName(entry)),
        removals: plan.removals.map((entry) => redactName(entry)),
        settings: plan.settings.map((entry) => redactName(entry)),
        held: plan.held.map((entry) => redactName(entry)),
    };
}
