import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { UnreadableSlotError } from '../../src/proton/secretStore';
import { FileSlot } from '../src/fileSlot';

const key = () => randomBytes(32);
const dir = () => mkdtemp(join(tmpdir(), 'pss-slot-'));
const slotFile = (d: string) => join(d, 'session.bin');

describe('FileSlot', () => {
    it('round-trips a session', async () => {
        const d = await dir();
        const slot = new FileSlot(slotFile(d), key());
        assert.equal(await slot.read(), null);
        await slot.write('{"uid":"abc"}');
        assert.equal(await slot.read(), '{"uid":"abc"}');
    });

    it('reports itself as encrypted', async () => {
        const d = await dir();
        assert.equal(new FileSlot(slotFile(d), key()).isEncrypted(), true);
    });

    it('keeps nothing readable on disk', async () => {
        const d = await dir();
        const file = slotFile(d);
        await new FileSlot(file, key()).write('super-secret-session');
        const encoded = await readFile(file, 'utf8');
        assert.ok(!encoded.includes('super-secret-session'));
        assert.equal(JSON.parse(encoded).version, 1);
    });

    it('refuses a wrong key instead of reading as empty', async () => {
        const d = await dir();
        const file = slotFile(d);
        await new FileSlot(file, key()).write('session');
        await assert.rejects(new FileSlot(file, key()).read(), UnreadableSlotError);
    });

    it('refuses tampered ciphertext (GCM)', async () => {
        const d = await dir();
        const file = slotFile(d);
        const slot = new FileSlot(file, key());
        await slot.write('session');
        const envelope = JSON.parse(await readFile(file, 'utf8')) as { data: string };
        const data = envelope.data;
        envelope.data = (data[0] === 'A' ? 'B' : 'A') + data.slice(1);
        await writeFile(file, JSON.stringify(envelope));
        await assert.rejects(slot.read(), UnreadableSlotError);
    });

    it('refuses a foreign version instead of reading as empty', async () => {
        const d = await dir();
        const file = slotFile(d);
        await new FileSlot(file, key()).write('session');
        const envelope = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        envelope['version'] = 2;
        await writeFile(file, JSON.stringify(envelope));
        await assert.rejects(new FileSlot(file, key()).read(), UnreadableSlotError);
    });

    it('refuses torn JSON instead of reading as empty', async () => {
        const d = await dir();
        const file = slotFile(d);
        await writeFile(file, '{"version": 1,');
        await assert.rejects(new FileSlot(file, key()).read(), UnreadableSlotError);
    });

    it('clearing deletes the file', async () => {
        const d = await dir();
        const file = slotFile(d);
        const slot = new FileSlot(file, key());
        await slot.write('session');
        await slot.write(null);
        assert.equal(await slot.read(), null);
        await assert.rejects(stat(file), /ENOENT/);
        // Clearing nothing is not an error.
        await slot.write(null);
    });

    it('a missing file reads as null, not unreadable', async () => {
        const d = await dir();
        assert.equal(await new FileSlot(slotFile(d), key()).read(), null);
    });

    it('rejects a key that is not 32 bytes', () => {
        assert.throws(() => new FileSlot('/none', randomBytes(16)), /32 bytes/);
    });

    it('closes the file and its directory to other users', async function (this: TestContext) {
        if (process.platform !== 'linux' && process.platform !== 'darwin') {
            this.skip('POSIX modes only');
            return;
        }
        const d = await dir();
        const file = join(d, 'nested', 'session.bin');
        await new FileSlot(file, key()).write('session');
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        assert.equal((await stat(join(d, 'nested'))).mode & 0o777, 0o700);
    });
});
