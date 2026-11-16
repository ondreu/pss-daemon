import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptNode } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import { UnreadableSlotError, type SecretSlot } from '../../src/proton/secretStore';

/** scrypt as a promise, typed where `promisify` is not. */
function scryptAsync(
    key: Buffer,
    salt: Buffer,
    length: number,
    options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scryptNode(key, salt, length, options, (error, derived) => {
            if (error) {
                reject(error);
            } else {
                resolve(derived);
            }
        });
    });
}

/**
 * Version of the envelope written below. A file with another version is
 * refused rather than read as empty: see {@link SecretSlot.read}.
 */
const ENVELOPE_VERSION = 1;

/** Binds the ciphertext to this file, so it cannot be passed off as anything else. */
const ASSOCIATED_DATA = 'pss-daemon/file-slot-v1';

/**
 * scrypt work factors. The key file already holds 256 bits of entropy, so
 * this is not what stands between a copied envelope and the session — the
 * key file itself is. The factors stay modest so an unattended boot does not
 * burn seconds deriving a key it already holds.
 */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** Above OpenSSL's 32 MiB default ceiling for 128·N·r bytes, which N=32768, r=8 exactly fills. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const DERIVED_KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

type Envelope = {
    version: number;
    kdf: 'scrypt';
    n: number;
    r: number;
    p: number;
    salt: string;
    iv: string;
    data: string;
    tag: string;
};

function isEnvelope(value: unknown): value is Envelope {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const envelope = value as Record<string, unknown>;
    return (
        typeof envelope['version'] === 'number' &&
        envelope['kdf'] === 'scrypt' &&
        typeof envelope['n'] === 'number' &&
        typeof envelope['r'] === 'number' &&
        typeof envelope['p'] === 'number' &&
        typeof envelope['salt'] === 'string' &&
        typeof envelope['iv'] === 'string' &&
        typeof envelope['data'] === 'string' &&
        typeof envelope['tag'] === 'string'
    );
}

/** The factors a file may ask scrypt for, before deriving anything from them. */
function saneFactors(n: number, r: number, p: number): boolean {
    return Number.isInteger(n) && n >= 1024 && n <= 1_048_576 && (n & (n - 1)) === 0 &&
        Number.isInteger(r) && r >= 1 && r <= 32 &&
        Number.isInteger(p) && p >= 1 && p <= 16;
}

/**
 * A secret in a file encrypted with a key from the environment.
 *
 * The daemon reads 32 bytes of key material from the file `PSS_KEY_FILE`
 * points at (a Docker secret, typically) and never writes key material
 * anywhere: what lands on disk is a JSON envelope with the scrypt parameters,
 * the salt and iv, and AES-256-GCM ciphertext. Each write picks a fresh salt
 * and iv, so two writes of the same session look nothing alike.
 *
 * Writes are atomic — beside the file, then renamed over it — so a crash or
 * a full disk leaves the previous envelope in place rather than a torn one.
 * Reads refuse anything they cannot open: see {@link SecretSlot.read}.
 */
export class FileSlot implements SecretSlot {
    private readonly key: Buffer;

    /**
     * @param path Where the envelope lives.
     * @param key 32 bytes of key material, read from `PSS_KEY_FILE` by the
     * caller. Copied in; the caller keeps owning its own bytes.
     */
    constructor(
        private readonly path: string,
        key: Uint8Array,
    ) {
        if (key.byteLength !== 32) {
            throw new Error(`The session key must be 32 bytes, got ${key.byteLength}`);
        }
        this.key = Buffer.from(key);
    }

    /**
     * The stored session, `null` when there is none.
     *
     * @throws {@link UnreadableSlotError} when the file exists and cannot be
     * opened — a foreign version, torn JSON, a wrong key, or tampered bytes.
     * Returning `null` for that would let the next write replace a session
     * this key merely cannot open yet.
     */
    async read(): Promise<string | null> {
        let encoded: string;
        try {
            encoded = await fs.readFile(this.path, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return null;
            }
            throw new UnreadableSlotError(this.path, { cause: error });
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(encoded) as unknown;
        } catch (error) {
            throw new UnreadableSlotError(this.path, { cause: error });
        }
        if (!isEnvelope(parsed)) {
            throw new UnreadableSlotError(this.path);
        }
        if (parsed.version !== ENVELOPE_VERSION) {
            throw new UnreadableSlotError(this.path);
        }
        if (!saneFactors(parsed.n, parsed.r, parsed.p)) {
            throw new UnreadableSlotError(this.path);
        }
        try {
            const salt = Buffer.from(parsed.salt, 'base64');
            const iv = Buffer.from(parsed.iv, 'base64');
            const tag = Buffer.from(parsed.tag, 'base64');
            if (salt.byteLength !== SALT_BYTES || iv.byteLength !== IV_BYTES || tag.byteLength !== 16) {
                throw new Error('The session envelope has malformed fields');
            }
            const derived = await scryptAsync(this.key, salt, DERIVED_KEY_BYTES, {
                N: parsed.n,
                r: parsed.r,
                p: parsed.p,
                maxmem: SCRYPT_MAXMEM,
            });
            const decipher = createDecipheriv('aes-256-gcm', derived, iv);
            decipher.setAAD(Buffer.from(ASSOCIATED_DATA, 'utf8'));
            decipher.setAuthTag(tag);
            return decipher.update(parsed.data, 'base64', 'utf8') + decipher.final('utf8');
        } catch (error) {
            if (error instanceof UnreadableSlotError) {
                throw error;
            }
            // A wrong key and tampered bytes both land here: GCM opens neither.
            throw new UnreadableSlotError(this.path, { cause: error });
        }
    }

    /**
     * Store the session, whole or not at all; `null` deletes the file.
     *
     * The write lands beside the file and is renamed over it, so the old
     * envelope stays readable until the new one is complete. Both the
     * directory and the file are closed to other users.
     */
    async write(value: string | null): Promise<void> {
        if (value === null) {
            await this.removeQuietly(this.tempPath);
            try {
                await fs.unlink(this.path);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
            return;
        }
        await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await chmodQuietly(dirname(this.path), 0o700);
        const salt = randomBytes(SALT_BYTES);
        const iv = randomBytes(IV_BYTES);
        const derived = await scryptAsync(this.key, salt, DERIVED_KEY_BYTES, {
            N: SCRYPT_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
            maxmem: SCRYPT_MAXMEM,
        });
        const cipher = createCipheriv('aes-256-gcm', derived, iv);
        cipher.setAAD(Buffer.from(ASSOCIATED_DATA, 'utf8'));
        const data = cipher.update(value, 'utf8', 'base64') + cipher.final('base64');
        const envelope: Envelope = {
            version: ENVELOPE_VERSION,
            kdf: 'scrypt',
            n: SCRYPT_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
            salt: salt.toString('base64'),
            iv: iv.toString('base64'),
            data,
            tag: cipher.getAuthTag().toString('base64'),
        };
        const tempPath = this.tempPath;
        await fs.writeFile(tempPath, JSON.stringify(envelope), { mode: 0o600 });
        await chmodQuietly(tempPath, 0o600);
        try {
            await fs.rename(tempPath, this.path);
        } catch (error) {
            await this.removeQuietly(tempPath);
            throw error;
        }
        // Heal a file an older version left readable by everyone.
        await chmodQuietly(this.path, 0o600);
    }

    /** Always encrypted: what is on disk is ciphertext under a 256-bit key. */
    isEncrypted(): boolean {
        return true;
    }

    /** Where a write lands before it is renamed over {@link path}. */
    private get tempPath(): string {
        return `${this.path}.tmp`;
    }

    private async removeQuietly(path: string): Promise<void> {
        try {
            await fs.unlink(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }
}

/** Best effort: a filesystem without modes, or a path out of reach. */
async function chmodQuietly(path: string, mode: number): Promise<void> {
    try {
        await fs.chmod(path, mode);
    } catch {
        // The permission check reports what it sees; see the tests.
    }
}
