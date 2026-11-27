import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
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
import { dirname, join } from 'node:path';
import { type Config, ConfigError, type Profile } from './config.ts';

export { HANDLE_KEY_FILE_NAME } from './config.ts';

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

/** A private Ed25519 attestation key, as a JWK. */
export interface AttestationJwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly alg: 'Ed25519';
  readonly use: 'sig';
  readonly kid: string;
  readonly x: string;
  readonly d: string;
}

/** The public half of an attestation key: every member but `d`. */
export type PublicAttestationJwk = Omit<AttestationJwk, 'd'>;

/** The attestation keys: the first signs. */
export interface AttestationKeys {
  readonly keys: readonly AttestationJwk[];
}

/** A handle key: 64 random bytes, as a JWK. Only this service ever holds one. */
export interface HandleJwk {
  readonly kty: 'oct';
  readonly kid: string;
  readonly k: string;
}

/** The handle keys: the first seals; every one opens. */
export interface HandleKeys {
  readonly keys: readonly HandleJwk[];
}

/** The attestation key file's name; it sits in the directory of the login key file. */
export const ATTESTATION_KEY_FILE_NAME = 'attestation-keys.json';

/** A key file as a refusal names it: the setting at fault, and what the message calls the file. */
interface KeyFile {
  readonly setting: string;
  readonly name: string;
}
const LOGIN_KEY_FILE: KeyFile = { setting: 'MR_ACCOUNT_KEY_FILE', name: 'the key file' };
const ATTESTATION_KEY_FILE: KeyFile = {
  setting: 'MR_ACCOUNT_KEY_FILE',
  name: `the attestation key file (${ATTESTATION_KEY_FILE_NAME})`,
};
const HANDLE_KEY_FILE: KeyFile = {
  setting: 'MR_ACCOUNT_HANDLE_KEY_FILE',
  name: 'the handle key file',
};
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
// A P-256 coordinate or scalar, or an Ed25519 key half: 32 bytes as unpadded base64url.
const KEY_MEMBER_32 = /^[A-Za-z0-9_-]{43}$/;
const ATTESTATION_KEY_MEMBERS: ReadonlySet<string> = new Set([
  'kty',
  'crv',
  'x',
  'd',
  'kid',
  'alg',
  'use',
]);
// An Ed25519 private key is 32 bytes; as PKCS#8 DER it is this prefix and then those bytes.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const HANDLE_KEY_MEMBERS: ReadonlySet<string> = new Set(['kty', 'kid', 'k']);
const HANDLE_KEY_BYTES = 64;
// 64 bytes as unpadded base64url.
const HANDLE_KEY = /^[A-Za-z0-9_-]{86}$/;
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

/** The Ed25519 key whose private bytes are `privateBytes`; Node derives `x` from them. */
function attestationKeyOf(privateBytes: Buffer, kid?: string): AttestationJwk {
  const { x, d } = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, privateBytes]),
    format: 'der',
    type: 'pkcs8',
  }).export({ format: 'jwk' });
  if (x === undefined || d === undefined) {
    throw new Error('the Ed25519 key has no x or d');
  }
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'Ed25519',
    use: 'sig',
    kid: kid ?? ed25519Thumbprint(x),
    x,
    d,
  };
}

/** The RFC 7638 thumbprint (SHA-256, base64url) of an Ed25519 public key. */
function ed25519Thumbprint(x: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x }))
    .digest('base64url');
}

/** A fresh Ed25519 key whose `kid` is the RFC 7638 thumbprint of its public half. */
export function generateAttestationKey(): AttestationJwk {
  return attestationKeyOf(randomBytes(32));
}

/** `key` without its private half. */
export function publicAttestationKey(key: AttestationJwk): PublicAttestationJwk {
  const { kty, crv, alg, use, kid, x } = key;
  return { kty, crv, alg, use, kid, x };
}

/**
 * The `local-dev` attestation key: the same on every machine, because a build of the game module
 * holds the attestation keys it accepts as data and cannot fetch them, so a key made per machine
 * could be accepted by no build. Its private bytes are the SHA-256 of a label in this public
 * repository: anyone can sign with it. A build that accepts it checks nothing about who signed,
 * and no other profile signs with it or publishes it.
 */
const LOCAL_DEV_ATTESTATION_KEY = attestationKeyOf(
  createHash('sha256').update('monster-realm local-dev attestation key 1').digest(),
);

/**
 * The public attestation keys a build of the game module may accept, per profile:
 * `attestation-public-keys.json` beside this package's manifest is this value as JSON. A
 * `hosted-dev` or `production` key is listed here, and the file regenerated, before any build can
 * accept what it signs.
 */
export function publishedAttestationKeys(): Readonly<
  Record<Profile, readonly PublicAttestationJwk[]>
> {
  return {
    'local-dev': [publicAttestationKey(LOCAL_DEV_ATTESTATION_KEY)],
    'hosted-dev': [],
    production: [],
  };
}

/**
 * The profile's attestation keys: the fixed key for `local-dev`, and otherwise the keys of the
 * attestation key file beside the login key file, which must exist. `login` is the profile's
 * login keys. Every refusal is a `ConfigError`; none carries key material.
 */
export function loadAttestationKeys(
  config: Pick<Config, 'profile' | 'keys'>,
  login: SigningKeys,
): AttestationKeys {
  const source = config.keys;
  if (source.kind === 'external') {
    throw new ConfigError(
      'MR_ACCOUNT_PROFILE',
      `${config.profile} signs through an external signer, and this build holds none`,
    );
  }
  if (config.profile === 'local-dev') return { keys: [LOCAL_DEV_ATTESTATION_KEY] };

  const path = join(dirname(source.path), ATTESTATION_KEY_FILE_NAME);
  const file = ATTESTATION_KEY_FILE;
  const text = readKeyFile(path, config.profile, file);
  if (text === undefined) {
    throw refusal(
      file,
      `${config.profile} needs ${file.name} beside its key file, and there is none`,
    );
  }
  const keys = parseKeyFile(text, config.profile, file, (entry, which) =>
    parseAttestationKey(entry, `${which} of ${file.name}`),
  );
  for (const key of keys) {
    // The two key sets are disjoint by name as well as by key type.
    if (login.keys.some((loginKey) => loginKey.kid === key.kid)) {
      throw refusal(file, `a key of ${file.name} has the kid of a login key`);
    }
    if (key.x === LOCAL_DEV_ATTESTATION_KEY.x || key.kid === LOCAL_DEV_ATTESTATION_KEY.kid) {
      throw refusal(
        file,
        `${file.name} holds the local-dev attestation key, which anyone can sign with`,
      );
    }
  }
  return { keys };
}

/** A fresh handle key under a short random `kid`: every handle it seals starts with that `kid`. */
export function generateHandleKey(): HandleJwk {
  return {
    kty: 'oct',
    kid: randomBytes(6).toString('base64url'),
    k: randomBytes(HANDLE_KEY_BYTES).toString('base64url'),
  };
}

type HandleKeyConfig = Pick<Config, 'profile' | 'keys' | 'handleKeys'>;

/**
 * The keys of the profile's handle key file, or undefined when there is no file. Writes nothing.
 * A profile with no key file of its own is refused for a missing file here: nothing it loads
 * after this is a file. Every refusal is a `ConfigError`; none carries key material.
 */
export function readHandleKeys(config: HandleKeyConfig): HandleKeys | undefined {
  const file = HANDLE_KEY_FILE;
  const text = readKeyFile(config.handleKeys.path, config.profile, file);
  if (text === undefined) {
    if (config.keys.kind === 'external') throw missingHandleKeyFile(config.profile);
    return undefined;
  }
  const keys = parseKeyFile(text, config.profile, file, parseHandleKey);
  if (new Set(keys.map((key) => key.k)).size !== keys.length) {
    throw refusal(file, `two keys in ${file.name} are the same key`);
  }
  return { keys };
}

/**
 * The profile's handle keys: those of its file, which is made first, holding one new key, when it
 * is absent and the profile makes its own. Any other profile is refused for an absent file and
 * never given a new one: a handle sealed under another key is another handle, so a world would
 * take every account it knows for one it has never seen.
 */
export function createHandleKeys(config: HandleKeyConfig): HandleKeys {
  const held = readHandleKeys(config);
  if (held !== undefined) return held;
  if (!config.handleKeys.generateIfMissing) throw missingHandleKeyFile(config.profile);
  createKeyFile(config.handleKeys.path, config.profile, generateHandleKey(), HANDLE_KEY_FILE);
  const made = readHandleKeys(config);
  if (made === undefined) throw refusal(HANDLE_KEY_FILE, 'the generated handle key file is gone');
  return made;
}

function missingHandleKeyFile(profile: Profile): ConfigError {
  return refusal(
    HANDLE_KEY_FILE,
    `${profile} needs its handle key file, and there is none at the configured path`,
  );
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
  const file = LOGIN_KEY_FILE;
  let text = readKeyFile(source.path, config.profile, file);
  if (text === undefined) {
    if (!source.generateIfMissing) {
      throw refusal(
        file,
        `${config.profile} needs its key file, and there is none at the configured path`,
      );
    }
    createKeyFile(source.path, config.profile, generateSigningKey(), file);
    text = readKeyFile(source.path, config.profile, file);
    if (text === undefined) throw refusal(file, 'the generated key file is gone');
  }
  return { keys: parseKeyFile(text, config.profile, file, parseKey) };
}

function refusal(file: KeyFile, problem: string): ConfigError {
  return new ConfigError(file.setting, problem);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** The file's text, or `undefined` when there is no file. */
function readKeyFile(path: string, profile: Profile, file: KeyFile): string | undefined {
  let fd: number;
  try {
    // Non-blocking, so a path that names a pipe is refused below and never waited on.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw refusal(file, `${file.name} cannot be opened`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_KEY_FILE_BYTES) {
      throw refusal(
        file,
        `${file.name} must be a regular file of at most ${MAX_KEY_FILE_BYTES} bytes`,
      );
    }
    // A deployed key signs tokens other machines trust: only its owner may read it. Windows
    // reports no such bits.
    if (profile !== 'local-dev' && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw refusal(file, `${file.name} must be readable by its owner only (mode 0600)`);
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw refusal(file, `${file.name} cannot be read`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes a key file holding the one key `key`. The file appears complete or not at all, and a
 * file already at the path is left as it is: the content is written and flushed beside it, then
 * linked into place. The copy beside it, which holds the key, is removed on every path.
 */
function createKeyFile(path: string, profile: Profile, key: object, file: KeyFile): void {
  const content = `${JSON.stringify({ profile, keys: [key] }, null, 2)}\n`;
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, content, { mode: 0o600, flag: 'wx', flush: true });
    linkSync(temp, path);
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw refusal(file, `${file.name} cannot be created`);
  } finally {
    rmSync(temp, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The keys of a key file's text, each read by `parseEntry`, which is given how to name the entry. */
function parseKeyFile<K extends { readonly kid: string }>(
  text: string,
  profile: Profile,
  file: KeyFile,
  parseEntry: (entry: unknown, which: string) => K,
): K[] {
  let content: unknown;
  try {
    content = JSON.parse(text);
  } catch {
    throw refusal(file, `${file.name} is not JSON`);
  }
  if (!isRecord(content) || Object.keys(content).sort().join() !== 'keys,profile') {
    throw refusal(file, `${file.name} must be an object with exactly "profile" and "keys"`);
  }
  if (content.profile !== profile) {
    throw refusal(file, `${file.name} is not marked for ${profile}`);
  }
  if (!Array.isArray(content.keys) || content.keys.length === 0) {
    throw refusal(file, `${file.name} must hold at least one key`);
  }
  const keys = content.keys.map((entry: unknown, index) => parseEntry(entry, `key ${index + 1}`));
  if (new Set(keys.map((key) => key.kid)).size !== keys.length) {
    throw refusal(file, `two keys in ${file.name} share a kid`);
  }
  return keys;
}

function parseKey(entry: unknown, which: string): SigningJwk {
  if (!isRecord(entry) || !Object.keys(entry).every((member) => KEY_MEMBERS.has(member))) {
    throw refusal(
      LOGIN_KEY_FILE,
      `${which} must be an object with only kty, crv, x, y, d, kid, alg and use`,
    );
  }
  const { kty, crv, x, y, d, kid, alg, use } = entry;
  if (kty !== 'EC' || crv !== 'P-256')
    throw refusal(LOGIN_KEY_FILE, `${which} is not a P-256 EC key`);
  if (alg !== undefined && alg !== 'ES256')
    throw refusal(LOGIN_KEY_FILE, `${which} is not an ES256 key`);
  if (use !== undefined && use !== 'sig')
    throw refusal(LOGIN_KEY_FILE, `${which} is not a signing key`);
  if (typeof kid !== 'string' || !KID.test(kid)) {
    throw refusal(
      LOGIN_KEY_FILE,
      `the kid of ${which} must be 1 to 64 characters of A-Z, a-z, 0-9, - and _`,
    );
  }
  if (!isKeyMember(x) || !isKeyMember(y) || !isKeyMember(d)) {
    throw refusal(
      LOGIN_KEY_FILE,
      `x, y and d of ${which} must each be 32 bytes of unpadded base64url`,
    );
  }
  try {
    // Node refuses a key whose d is not the private half of x and y.
    createPrivateKey({ key: { kty, crv, x, y, d }, format: 'jwk' });
  } catch {
    throw refusal(LOGIN_KEY_FILE, `${which} is not a valid private key`);
  }
  return { kty, crv, alg: 'ES256', use: 'sig', kid, x, y, d };
}

function parseAttestationKey(entry: unknown, which: string): AttestationJwk {
  if (
    !isRecord(entry) ||
    !Object.keys(entry).every((member) => ATTESTATION_KEY_MEMBERS.has(member))
  ) {
    throw refusal(
      LOGIN_KEY_FILE,
      `${which} must be an object with only kty, crv, x, d, kid, alg and use`,
    );
  }
  const { kty, crv, x, d, kid, alg, use } = entry;
  if (kty !== 'OKP' || crv !== 'Ed25519' || (alg !== undefined && alg !== 'Ed25519')) {
    throw refusal(LOGIN_KEY_FILE, `${which} is not an Ed25519 key`);
  }
  if (use !== undefined && use !== 'sig')
    throw refusal(LOGIN_KEY_FILE, `${which} is not a signing key`);
  if (typeof kid !== 'string' || !KID.test(kid)) {
    throw refusal(
      LOGIN_KEY_FILE,
      `the kid of ${which} must be 1 to 64 characters of A-Z, a-z, 0-9, - and _`,
    );
  }
  if (!isKeyMember(x) || !isKeyMember(d)) {
    throw refusal(
      LOGIN_KEY_FILE,
      `x and d of ${which} must each be 32 bytes of unpadded base64url`,
    );
  }
  // The public half is derived from d here, whatever this Node makes of a JWK whose halves differ.
  const key = attestationKeyOf(Buffer.from(d, 'base64url'), kid);
  if (key.x !== x) throw refusal(LOGIN_KEY_FILE, `x of ${which} is not the public half of its d`);
  return key;
}

function parseHandleKey(entry: unknown, which: string): HandleJwk {
  const file = HANDLE_KEY_FILE;
  if (!isRecord(entry) || !Object.keys(entry).every((member) => HANDLE_KEY_MEMBERS.has(member))) {
    throw refusal(file, `${which} must be an object with only kty, kid and k`);
  }
  const { kty, kid, k } = entry;
  if (kty !== 'oct') throw refusal(file, `${which} is not a symmetric (oct) key`);
  if (typeof kid !== 'string' || !KID.test(kid)) {
    throw refusal(file, `the kid of ${which} must be 1 to 64 characters of A-Z, a-z, 0-9, - and _`);
  }
  if (
    typeof k !== 'string' ||
    !HANDLE_KEY.test(k) ||
    Buffer.from(k, 'base64url').toString('base64url') !== k
  ) {
    throw refusal(file, `k of ${which} must be ${HANDLE_KEY_BYTES} bytes of unpadded base64url`);
  }
  return { kty, kid, k };
}

function isKeyMember(value: unknown): value is string {
  return typeof value === 'string' && KEY_MEMBER_32.test(value);
}
