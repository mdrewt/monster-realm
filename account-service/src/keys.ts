import { createHash, createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { type Config, ConfigError, type Profile } from './config.ts';

/** A private ES256 signing key, in the JWK form the provider takes. */
export interface SigningJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly alg: 'ES256';
  readonly use: 'sig';
  readonly kid: string;
  readonly x: string;
  readonly y: string;
  readonly d: string;
}

/** The issuer's signing keys: the first signs, and the public half of every one is published. */
export interface SigningKeys {
  readonly keys: readonly SigningJwk[];
}

const KEY_FILE_SETTING = 'MR_ACCOUNT_KEY_FILE';
const KEY_MEMBERS: ReadonlySet<string> = new Set([
  'kty',
  'crv',
  'x',
  'y',
  'd',
  'kid',
  'alg',
  'use',
]);
// A P-256 coordinate or scalar: 32 bytes as unpadded base64url.
const P256_MEMBER = /^[A-Za-z0-9_-]{43}$/;
const KID = /^[A-Za-z0-9_-]{1,64}$/;
// A key is under 300 bytes of JSON; the cap keeps a wrong path from being read without end.
const MAX_KEY_FILE_BYTES = 65_536;

/** A fresh P-256 key whose `kid` is the RFC 7638 thumbprint (SHA-256, base64url) of its public half. */
export function generateSigningKey(): SigningJwk {
  const { x, y, d } = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
    format: 'jwk',
  });
  if (x === undefined || y === undefined || d === undefined) {
    throw new Error('the generated P-256 key has no x, y or d');
  }
  const kid = createHash('sha256')
    .update(JSON.stringify({ crv: 'P-256', kty: 'EC', x, y }))
    .digest('base64url');
  return { kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid, x, y, d };
}

/**
 * Loads the profile's signing keys from its key file, generating the file first when the source
 * allows it and the file is absent. Every refusal is a `ConfigError`; none carries key material.
 */
export function loadSigningKeys(config: Pick<Config, 'profile' | 'keys'>): SigningKeys {
  const source = config.keys;
  if (source.kind === 'external') {
    throw new ConfigError(
      'MR_ACCOUNT_PROFILE',
      `${config.profile} signs through an external signer, and this build holds none`,
    );
  }
  let text = readKeyFile(source.path, config.profile);
  if (text === undefined) {
    if (!source.generateIfMissing) {
      throw refusal(
        `${config.profile} needs its key file, and there is none at the configured path`,
      );
    }
    createKeyFile(source.path, config.profile);
    text = readKeyFile(source.path, config.profile);
    if (text === undefined) throw refusal('the generated key file is gone');
  }
  return parseKeyFile(text, config.profile);
}

function refusal(problem: string): ConfigError {
  return new ConfigError(KEY_FILE_SETTING, problem);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** The file's text, or `undefined` when there is no file. */
function readKeyFile(path: string, profile: Profile): string | undefined {
  let fd: number;
  try {
    // Non-blocking, so a path that names a pipe is refused below and never waited on.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw refusal('the key file cannot be opened');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_KEY_FILE_BYTES) {
      throw refusal(`the key file must be a regular file of at most ${MAX_KEY_FILE_BYTES} bytes`);
    }
    // A deployed key signs tokens other machines trust: only its owner may read it. Windows
    // reports no such bits.
    if (profile !== 'local-dev' && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw refusal('the key file must be readable by its owner only (mode 0600)');
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw refusal('the key file cannot be read');
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes a key file holding one new key. The file appears complete or not at all, and a file
 * already at the path is left as it is: the content is written and flushed beside it, then linked
 * into place. The copy beside it, which holds the private key, is removed on every path.
 */
function createKeyFile(path: string, profile: Profile): void {
  const content = `${JSON.stringify({ profile, keys: [generateSigningKey()] }, null, 2)}\n`;
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, content, { mode: 0o600, flag: 'wx', flush: true });
    linkSync(temp, path);
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw refusal('the key file cannot be created');
  } finally {
    rmSync(temp, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseKeyFile(text: string, profile: Profile): SigningKeys {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw refusal('the key file is not JSON');
  }
  if (!isRecord(file) || Object.keys(file).sort().join() !== 'keys,profile') {
    throw refusal('the key file must be an object with exactly "profile" and "keys"');
  }
  if (file.profile !== profile) {
    throw refusal(`the key file is not marked for ${profile}`);
  }
  if (!Array.isArray(file.keys) || file.keys.length === 0) {
    throw refusal('the key file must hold at least one key');
  }
  const keys = file.keys.map((entry: unknown, index) => parseKey(entry, `key ${index + 1}`));
  if (new Set(keys.map((key) => key.kid)).size !== keys.length) {
    throw refusal('two keys in the key file share a kid');
  }
  return { keys };
}

function parseKey(entry: unknown, which: string): SigningJwk {
  if (!isRecord(entry) || !Object.keys(entry).every((member) => KEY_MEMBERS.has(member))) {
    throw refusal(`${which} must be an object with only kty, crv, x, y, d, kid, alg and use`);
  }
  const { kty, crv, x, y, d, kid, alg, use } = entry;
  if (kty !== 'EC' || crv !== 'P-256') throw refusal(`${which} is not a P-256 EC key`);
  if (alg !== undefined && alg !== 'ES256') throw refusal(`${which} is not an ES256 key`);
  if (use !== undefined && use !== 'sig') throw refusal(`${which} is not a signing key`);
  if (typeof kid !== 'string' || !KID.test(kid)) {
    throw refusal(`the kid of ${which} must be 1 to 64 characters of A-Z, a-z, 0-9, - and _`);
  }
  if (!isP256Member(x) || !isP256Member(y) || !isP256Member(d)) {
    throw refusal(`x, y and d of ${which} must each be 32 bytes of unpadded base64url`);
  }
  try {
    // Node refuses a key whose d is not the private half of x and y.
    createPrivateKey({ key: { kty, crv, x, y, d }, format: 'jwk' });
  } catch {
    throw refusal(`${which} is not a valid private key`);
  }
  return { kty, crv, alg: 'ES256', use: 'sig', kid, x, y, d };
}

function isP256Member(value: unknown): value is string {
  return typeof value === 'string' && P256_MEMBER.test(value);
}
