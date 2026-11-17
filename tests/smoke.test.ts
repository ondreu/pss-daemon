/**
 * Scaffold tests: they pin that the daemon can reach the engine's modules and
 * run on Node with the shared stub, not that any daemon behaviour works yet.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SETTINGS, MIN_POLL_SECONDS } from '../engine/src/settings';
import { ExitCode } from '../src/types';

test('the engine settings are reachable from the daemon bundle', () => {
    assert.equal(DEFAULT_SETTINGS.massDeleteThreshold, 25);
    assert.equal(MIN_POLL_SECONDS, 30);
});

test('exit codes are distinct and stable', () => {
    const values = Object.values(ExitCode);
    assert.equal(new Set(values).size, values.length);
    assert.equal(ExitCode.AlreadyRunning, 5);
    assert.equal(ExitCode.StateLost, 6);
});
