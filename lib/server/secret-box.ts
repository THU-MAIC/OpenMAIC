/**
 * Encryption at rest for secrets the web settings store (RFC #1701).
 *
 * Workspace provider keys are sealed with AES-256-GCM under the instance
 * secret, `OPENMAIC_SECRET_KEY`. When it is unset, a random secret is created
 * on first use in the data directory (`data/instance-secret.key`, the Docker
 * volume) and read from there afterwards. A deployment that runs more than one
 * instance must set the variable, since each instance would otherwise create
 * its own.
 *
 * Every sealed value records which secret sealed it (`kid`, a digest prefix,
 * never the secret). Opening a value under a different secret raises
 * {@link SecretKeyMismatchError} rather than an opaque authentication failure,
 * so a lost or rotated secret shows up as "enter this key again".
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '@/lib/logger';

const log = createLogger('SecretBox');

export const INSTANCE_SECRET_FILE = 'instance-secret.key';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  v: 1;
  /** Which instance secret sealed this value (hex digest prefix). */
  kid: string;
  iv: string;
  tag: string;
  ct: string;
}

export class SecretKeyMismatchError extends Error {
  constructor() {
    super('sealed with a different instance secret; the value has to be entered again');
    this.name = 'SecretKeyMismatchError';
  }
}

export class SecretCorruptError extends Error {
  constructor() {
    super('sealed value is damaged and cannot be opened');
    this.name = 'SecretCorruptError';
  }
}

interface InstanceKey {
  key: Buffer;
  kid: string;
}

function deriveKey(secret: string): InstanceKey {
  // Any string works as the secret; hashing gives the 32 bytes AES-256 needs.
  const key = createHash('sha256').update(`openmaic.instance-secret:${secret}`, 'utf8').digest();
  const kid = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return { key, kid };
}

/** A generated secret is 32 random bytes in base64; anything else is refused. */
function checkedSecret(contents: string, file: string): string {
  const secret = contents.trim();
  if (Buffer.from(secret, 'base64').length !== 32 || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) {
    throw new Error(
      `${file} is not a complete instance secret. Restore it from a backup, or set OPENMAIC_SECRET_KEY; keys saved under a lost secret have to be entered again.`,
    );
  }
  return secret;
}

function readOrCreateSecretFile(dataDir: string): string {
  const file = path.join(dataDir, INSTANCE_SECRET_FILE);
  try {
    return checkedSecret(fs.readFileSync(file, 'utf8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('base64');
  // Written and flushed under a private name, then published with an
  // exclusive link: the file is never visible half written, and of two
  // processes starting together exactly one publishes, the other reads it.
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      // writeFileSync on a descriptor writes until everything is written.
      fs.writeFileSync(fd, `${secret}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // What gets published is what was read back, never only what was meant.
    if (checkedSecret(fs.readFileSync(temporary, 'utf8'), temporary) !== secret) {
      throw new Error(`${temporary} does not hold the secret that was written`);
    }
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return checkedSecret(fs.readFileSync(file, 'utf8'), file);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  log.warn(
    `OPENMAIC_SECRET_KEY is not set; created ${file}. Keep it with the database: stored keys cannot be read without it. Set OPENMAIC_SECRET_KEY when running more than one instance.`,
  );
  return secret;
}

let cached: { source: string; key: InstanceKey } | undefined;

/**
 * The instance key: `OPENMAIC_SECRET_KEY`, or the secret file in `dataDir`
 * (created when missing).
 */
export function instanceKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dataDir: string = path.join(process.cwd(), 'data'),
): InstanceKey {
  const configured = env.OPENMAIC_SECRET_KEY?.trim();
  const source = configured ? `env:${configured}` : `file:${dataDir}`;
  if (cached?.source === source) return cached.key;
  const key = deriveKey(configured || readOrCreateSecretFile(dataDir));
  cached = { source, key };
  return key;
}

export function resetInstanceKeyForTests(): void {
  cached = undefined;
}

/**
 * Seal `plaintext`. `context` is bound to the ciphertext (additional
 * authenticated data): a value sealed for one context does not open under
 * another.
 */
export function sealSecret(plaintext: string, context: string, key = instanceKey()): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    kid: key.kid,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function isSealedSecret(value: unknown): value is SealedSecret {
  if (!value || typeof value !== 'object') return false;
  const box = value as Record<string, unknown>;
  return (
    box.v === 1 &&
    typeof box.kid === 'string' &&
    typeof box.iv === 'string' &&
    typeof box.tag === 'string' &&
    typeof box.ct === 'string'
  );
}

export function openSecret(sealed: SealedSecret, context: string, key = instanceKey()): string {
  if (sealed.kid !== key.kid) throw new SecretKeyMismatchError();
  const iv = Buffer.from(sealed.iv, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  // A shortened tag would weaken the authentication; only the full one is accepted.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretCorruptError();
  try {
    const decipher = createDecipheriv(ALGORITHM, key.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretCorruptError();
  }
}
