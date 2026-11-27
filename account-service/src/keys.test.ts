import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  sign,
  verify,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { type Config, ConfigError, type Profile } from './config.ts';
import {
  ATTESTATION_KEY_FILE_NAME,
  type AttestationJwk,
  createHandleKeys,
  generateAttestationKey,
  generateHandleKey,
  generateSigningKey,
  HANDLE_KEY_FILE_NAME,
  type HandleJwk,
  loadAttestationKeys,
  loadSigningKeys,
  publicAttestationKey,
  publishedAttestationKeys,
  readHandleKeys,
  type SigningJwk,
  type SigningKeys,
} from './keys.ts';

const POSIX = process.platform !== 'win32';
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const BELL = String.fromCharCode(0x07);

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acs1-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function thumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');
}

function asJwk(value: object): JsonWebKey {
  return { ...value };
}

function fileSource(
  profile: Profile,
  path: string,
  generateIfMissing: boolean,
): Pick<Config, 'profile' | 'keys'> {
  return { profile, keys: { kind: 'file', path, generateIfMissing } };
}

function writeKeyFile(path: string, content: string, mode = 0o600): void {
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function without(value: object, member: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== member));
}

function refusalOf(load: () => unknown): ConfigError {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('loadSigningKeys accepted a key source it must refuse');
}

function signVerifies(privateJwk: object, publicJwk: object, data: Buffer): boolean {
  const signature = sign('sha256', data, {
    key: createPrivateKey({ key: asJwk(privateJwk), format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return verify(
    'sha256',
    data,
    { key: createPublicKey({ key: asJwk(publicJwk), format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    signature,
  );
}

describe('generateSigningKey', () => {
  test('returns a P-256 ES256 signing JWK whose kid is its RFC 7638 thumbprint', () => {
    const key = generateSigningKey();
    expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'd', 'kid', 'kty', 'use', 'x', 'y']);
    expect(key.kty).toBe('EC');
    expect(key.crv).toBe('P-256');
    expect(key.alg).toBe('ES256');
    expect(key.use).toBe('sig');
    expect(key.x).toMatch(B64URL_32);
    expect(key.y).toMatch(B64URL_32);
    expect(key.d).toMatch(B64URL_32);
    expect(key.kid).toBe(thumbprint(key));
  });

  test('two calls give two different keys', () => {
    const first = generateSigningKey();
    const second = generateSigningKey();
    expect(second.d).not.toBe(first.d);
    expect(second.x).not.toBe(first.x);
    expect(second.kid).not.toBe(first.kid);
  });

  test('a signature made with it verifies under its public members alone', () => {
    const key = generateSigningKey();
    const data = Buffer.from('discovery document bytes');
    const publicOnly = { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
    expect(signVerifies(key, publicOnly, data)).toBe(true);
    const other = generateSigningKey();
    expect(signVerifies(key, { kty: 'EC', crv: 'P-256', x: other.x, y: other.y }, data)).toBe(
      false,
    );
  });
});

describe('loading a key file that does not exist yet', () => {
  test('generateIfMissing creates the parent, writes one key, and returns it', () => {
    const parent = join(dir, 'nested', 'deeper');
    const path = join(parent, 'keys.json');
    const loaded = loadSigningKeys(fileSource('local-dev', path, true));
    expect(loaded.keys).toHaveLength(1);
    const [key] = loaded.keys;
    expect(key!.kty).toBe('EC');
    expect(key!.crv).toBe('P-256');
    expect(key!.kid).toBe(thumbprint(key!));
    expect(existsSync(path)).toBe(true);
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed).toEqual({ profile: 'local-dev', keys: [key] });
    if (POSIX) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(parent).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
    }
  });

  test('a generated file is marked with the profile it was made for', () => {
    const path = join(dir, 'keys.json');
    loadSigningKeys(fileSource('hosted-dev', path, true));
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { profile: unknown };
    expect(parsed.profile).toBe('hosted-dev');
  });

  test('a second load returns the same key and leaves the file bytes unchanged', () => {
    const path = join(dir, 'keys.json');
    const first = loadSigningKeys(fileSource('local-dev', path, true));
    const bytes = readFileSync(path);
    const second = loadSigningKeys(fileSource('local-dev', path, true));
    expect(second.keys).toHaveLength(1);
    expect(second.keys[0]!.kid).toBe(first.keys[0]!.kid);
    expect(second.keys[0]!.x).toBe(first.keys[0]!.x);
    expect(second.keys[0]!.y).toBe(first.keys[0]!.y);
    expect(second.keys[0]!.d).toBe(first.keys[0]!.d);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  const parents: ReadonlyArray<readonly [string, (root: string) => string]> = [
    ['a parent that already existed', (root) => root],
    ['a parent the load created', (root) => join(root, 'made', 'here')],
  ];

  test.each(
    parents,
  )('generating into %s leaves the key file as the only entry beside it, after each load', (_name, parentOf) => {
    const parent = parentOf(dir);
    const path = join(parent, 'keys.json');
    loadSigningKeys(fileSource('local-dev', path, true));
    expect(readdirSync(parent)).toEqual(['keys.json']);
    loadSigningKeys(fileSource('local-dev', path, true));
    expect(readdirSync(parent)).toEqual(['keys.json']);
  });

  test('without generateIfMissing an absent file is a key-file refusal and nothing is written', () => {
    const path = join(dir, 'missing', 'keys.json');
    const error = refusalOf(() => loadSigningKeys(fileSource('hosted-dev', path, false)));
    expect(error.setting).toBe('MR_ACCOUNT_KEY_FILE');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(dir, 'missing'))).toBe(false);
  });
});

describe('loading a key file that exists', () => {
  test('a file with two valid keys loads both in file order', () => {
    const a = generateSigningKey();
    const b = generateSigningKey();
    const path = join(dir, 'keys.json');
    writeKeyFile(path, JSON.stringify({ profile: 'local-dev', keys: [b, a] }));
    const loaded = loadSigningKeys(fileSource('local-dev', path, false));
    expect(loaded.keys).toEqual([b, a]);
  });

  test('an existing valid file is loaded, not replaced, even with generateIfMissing', () => {
    const a = generateSigningKey();
    const path = join(dir, 'keys.json');
    writeKeyFile(path, JSON.stringify({ profile: 'local-dev', keys: [a] }));
    const bytes = readFileSync(path);
    expect(loadSigningKeys(fileSource('local-dev', path, true)).keys).toEqual([a]);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  test('a key without alg and use and with any well-formed kid loads as an ES256 signing key', () => {
    const a = generateSigningKey();
    const kid = 'k'.repeat(64);
    const path = join(dir, 'keys.json');
    const stored = { kty: a.kty, crv: a.crv, x: a.x, y: a.y, d: a.d, kid };
    writeKeyFile(path, JSON.stringify({ profile: 'local-dev', keys: [stored] }));
    const [key] = loadSigningKeys(fileSource('local-dev', path, false)).keys;
    expect(key).toEqual({ ...stored, alg: 'ES256', use: 'sig' });
  });

  test('a profile mismatch is refused both ways', () => {
    const a = generateSigningKey();
    const path = join(dir, 'keys.json');
    writeKeyFile(path, JSON.stringify({ profile: 'local-dev', keys: [a] }));
    expect(refusalOf(() => loadSigningKeys(fileSource('hosted-dev', path, false))).setting).toBe(
      'MR_ACCOUNT_KEY_FILE',
    );
    expect(loadSigningKeys(fileSource('local-dev', path, false)).keys).toEqual([a]);
    writeKeyFile(path, JSON.stringify({ profile: 'hosted-dev', keys: [a] }));
    expect(refusalOf(() => loadSigningKeys(fileSource('local-dev', path, false))).setting).toBe(
      'MR_ACCOUNT_KEY_FILE',
    );
    expect(loadSigningKeys(fileSource('hosted-dev', path, false)).keys).toEqual([a]);
  });

  test('a refused file is never replaced, even with generateIfMissing', () => {
    const a = generateSigningKey();
    const path = join(dir, 'keys.json');
    writeKeyFile(path, JSON.stringify({ profile: 'local-dev', keys: [{ ...a, use: 'enc' }] }));
    const bytes = readFileSync(path);
    expect(refusalOf(() => loadSigningKeys(fileSource('local-dev', path, true))).setting).toBe(
      'MR_ACCOUNT_KEY_FILE',
    );
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });
});

describe('file permissions', () => {
  test('hosted-dev refuses a group- or world-readable key file and loads it at 0600', () => {
    if (!POSIX) return;
    const a = generateSigningKey();
    const path = join(dir, 'keys.json');
    writeKeyFile(path, JSON.stringify({ profile: 'hosted-dev', keys: [a] }), 0o600);
    expect(loadSigningKeys(fileSource('hosted-dev', path, false)).keys).toEqual([a]);
    for (const mode of [0o644, 0o640, 0o604, 0o610]) {
      chmodSync(path, mode);
      const error = refusalOf(() => loadSigningKeys(fileSource('hosted-dev', path, false)));
      expect(error.setting).toBe('MR_ACCOUNT_KEY_FILE');
      expect(error.message).not.toContain(a.d);
    }
    chmodSync(path, 0o600);
    expect(loadSigningKeys(fileSource('hosted-dev', path, false)).keys).toEqual([a]);
  });

  test('local-dev loads a 0644 key file', () => {
    const a = generateSigningKey();
    const path = join(dir, 'keys.json');
    writeKeyFile(path, JSON.stringify({ profile: 'local-dev', keys: [a] }), 0o644);
    expect(loadSigningKeys(fileSource('local-dev', path, false)).keys).toEqual([a]);
  });
});

describe('an external key source', () => {
  test('is refused as a profile setting, since this build holds no external signer', () => {
    const error = refusalOf(() =>
      loadSigningKeys({ profile: 'production', keys: { kind: 'external' } }),
    );
    expect(error.setting).toBe('MR_ACCOUNT_PROFILE');
    expect(error.message).toContain('MR_ACCOUNT_PROFILE');
  });
});

interface Fixtures {
  readonly a: SigningJwk;
  readonly b: SigningJwk;
  readonly rsa: JsonWebKey;
  readonly p384: JsonWebKey;
  readonly ed25519: JsonWebKey;
  readonly secp256k1: JsonWebKey;
}

describe('every malformed key file is a key-file refusal that leaks no key material', () => {
  let fx: Fixtures;

  beforeAll(() => {
    fx = {
      a: generateSigningKey(),
      b: generateSigningKey(),
      rsa: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' }),
      p384: generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ format: 'jwk' }),
      ed25519: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
      secp256k1: generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey.export({
        format: 'jwk',
      }),
    };
  });

  function secrets(): string[] {
    const all = [fx.a.d, fx.a.x, fx.a.y, fx.b.d, fx.b.x, fx.b.y];
    const extras = [
      fx.rsa.d,
      fx.rsa.p,
      fx.p384.d,
      fx.p384.x,
      fx.ed25519.d,
      fx.ed25519.x,
      fx.secp256k1.d,
      fx.secp256k1.x,
      fx.secp256k1.y,
    ];
    for (const extra of extras) {
      if (typeof extra === 'string') all.push(extra);
    }
    return all;
  }

  function expectCleanRefusal(error: ConfigError): void {
    expect(error.setting).toBe('MR_ACCOUNT_KEY_FILE');
    expect(error.message).toContain('MR_ACCOUNT_KEY_FILE');
    for (const secret of secrets()) {
      expect(error.message).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
    }
  }

  const file = (keys: unknown, profile: unknown = 'local-dev'): string =>
    JSON.stringify({ profile, keys });

  test('the valid control file loads', () => {
    const path = join(dir, 'keys.json');
    writeKeyFile(path, file([fx.a]));
    expect(loadSigningKeys(fileSource('local-dev', path, false)).keys).toEqual([fx.a]);
  });

  const cases: ReadonlyArray<readonly [string, (f: Fixtures) => string]> = [
    ['a file that is not JSON', (f) => file([f.a]).slice(0, -1)],
    ['a JSON array', (f) => JSON.stringify([f.a])],
    ['JSON null', () => 'null'],
    ['a file marked for another profile', (f) => file([f.a], 'hosted-dev')],
    ['a file marked production', (f) => file([f.a], 'production')],
    ['a numeric profile', (f) => file([f.a], 1)],
    ['a file without a profile', (f) => JSON.stringify({ keys: [f.a] })],
    [
      'an extra top-level member',
      (f) => JSON.stringify({ profile: 'local-dev', keys: [f.a], comment: 'x' }),
    ],
    ['an empty key list', () => file([])],
    ['keys that are not an array', (f) => file(f.a)],
    ['a key that is null', (f) => file([f.a, null])],
    ['a key with an extra member', (f) => file([{ ...f.a, key_ops: ['sign'] }])],
    ['an RSA private key', (f) => file([{ ...f.rsa, kid: 'rsa' }])],
    ['kty RSA on EC members', (f) => file([{ ...f.a, kty: 'RSA' }])],
    ['a P-384 key', (f) => file([{ ...f.p384, kid: 'p384' }])],
    ['crv P-384 on P-256 members', (f) => file([{ ...f.a, crv: 'P-384' }])],
    ['an Ed25519 key', (f) => file([{ ...f.ed25519, kid: 'ed' }])],
    ['a secp256k1 key', (f) => file([{ ...f.secp256k1, kid: 'k1' }])],
    [
      'secp256k1 members under crv P-256',
      (f) =>
        file([
          {
            kty: 'EC',
            crv: 'P-256',
            x: f.secp256k1.x,
            y: f.secp256k1.y,
            d: f.secp256k1.d,
            kid: 'k1',
          },
        ]),
    ],
    ['alg ES384', (f) => file([{ ...f.a, alg: 'ES384' }])],
    ['use enc', (f) => file([{ ...f.a, use: 'enc' }])],
    ['a public-only key', (f) => file([without(f.a, 'd')])],
    ['a key without a kid', (f) => file([without(f.a, 'kid')])],
    ['a key without x', (f) => file([without(f.a, 'x')])],
    ['d taken from a different key', (f) => file([{ ...f.a, d: f.b.d }])],
    ['x with a trailing =', (f) => file([{ ...f.a, x: `${f.a.x}=` }])],
    ['x with a trailing newline', (f) => file([{ ...f.a, x: `${f.a.x}\n` }])],
    ['x one character short', (f) => file([{ ...f.a, x: f.a.x.slice(1) }])],
    ['an empty kid', (f) => file([{ ...f.a, kid: '' }])],
    ['a kid containing a slash', (f) => file([{ ...f.a, kid: 'a/b' }])],
    ['a kid containing a control character', (f) => file([{ ...f.a, kid: `a${BELL}b` }])],
    ['a kid of 65 characters', (f) => file([{ ...f.a, kid: 'k'.repeat(65) }])],
    ['a numeric kid', (f) => file([{ ...f.a, kid: 1 }])],
    ['two keys sharing one kid', (f) => file([f.a, { ...f.b, kid: f.a.kid }])],
    ['a valid key followed by an invalid one', (f) => file([f.a, { ...f.b, use: 'enc' }])],
  ];

  test.each(cases)('%s is refused', (_name, build) => {
    const path = join(dir, 'keys.json');
    writeKeyFile(path, build(fx));
    const bytes = readFileSync(path);
    const error = refusalOf(() => loadSigningKeys(fileSource('local-dev', path, false)));
    expect(error.setting).toBe('MR_ACCOUNT_KEY_FILE');
    expect(error.message).toContain('MR_ACCOUNT_KEY_FILE');
    for (const secret of secrets()) {
      expect(error.message).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
    }
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  const MAX_KEY_FILE_BYTES = 65_536;

  function padded(content: string, total: number): string {
    return content + ' '.repeat(total - Buffer.byteLength(content));
  }

  test('a valid key file padded to exactly the size limit loads', () => {
    const path = join(dir, 'keys.json');
    writeKeyFile(path, padded(file([fx.a]), MAX_KEY_FILE_BYTES));
    expect(statSync(path).size).toBe(MAX_KEY_FILE_BYTES);
    expect(loadSigningKeys(fileSource('local-dev', path, false)).keys).toEqual([fx.a]);
  });

  test('a valid key file one byte over the size limit is refused and left unchanged', () => {
    const path = join(dir, 'keys.json');
    writeKeyFile(path, padded(file([fx.a]), MAX_KEY_FILE_BYTES + 1));
    expect(statSync(path).size).toBe(MAX_KEY_FILE_BYTES + 1);
    const bytes = readFileSync(path);
    for (const generateIfMissing of [false, true]) {
      expectCleanRefusal(
        refusalOf(() => loadSigningKeys(fileSource('local-dev', path, generateIfMissing))),
      );
    }
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  test.each([
    'local-dev',
    'hosted-dev',
  ] as const)('a directory at the key path is refused by %s and left in place', (profile) => {
    const path = join(dir, 'keys.json');
    mkdirSync(path, { mode: 0o700 });
    for (const generateIfMissing of [false, true]) {
      expectCleanRefusal(
        refusalOf(() => loadSigningKeys(fileSource(profile, path, generateIfMissing))),
      );
      expect(statSync(path).isDirectory()).toBe(true);
      expect(readdirSync(path)).toEqual([]);
    }
  });

  // A loader that blocks reading a FIFO freezes the thread, so the runner's timeout could never
  // fire. A delayed writer feeds such a loader a valid key file: blocking then turns into an
  // accepted load, which fails the test, instead of a hang. A prompt refusal kills the writer.
  function delayedWriter(source: string, fifo: string): ChildProcess {
    return spawn('sh', ['-c', 'sleep 2; cat "$1" > "$2"', 'sh', source, fifo], {
      stdio: 'ignore',
    });
  }

  test.each([
    'local-dev',
    'hosted-dev',
  ] as const)('a FIFO at the key path is refused promptly by %s', (profile) => {
    if (!POSIX) return;
    const path = join(dir, 'keys.json');
    const source = join(dir, 'valid.json');
    writeKeyFile(source, file([fx.a], profile));
    execFileSync('mkfifo', [path]);
    chmodSync(path, 0o600);
    expect(statSync(path).isFIFO()).toBe(true);
    for (const generateIfMissing of [false, true]) {
      const writer = delayedWriter(source, path);
      try {
        expectCleanRefusal(
          refusalOf(() => loadSigningKeys(fileSource(profile, path, generateIfMissing))),
        );
      } finally {
        writer.kill('SIGKILL');
      }
      expect(statSync(path).isFIFO()).toBe(true);
    }
  });
});

// ---- the attestation keys ----

const ATTESTATION_MEMBERS = ['alg', 'crv', 'd', 'kid', 'kty', 'use', 'x'];
const PUBLIC_ATTESTATION_MEMBERS = ['alg', 'crv', 'kid', 'kty', 'use', 'x'];
// An Ed25519 private key as PKCS#8 DER: this prefix, then its 32 private bytes.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PACKAGE_ROOT = join(import.meta.dirname, '..');

function okpThumbprint(x: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x }))
    .digest('base64url');
}

/** The `x` of the Ed25519 key whose private bytes are `d`, computed by Node from `d` alone. */
function publicXOfD(d: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(d, 'base64url')]),
    format: 'der',
    type: 'pkcs8',
  });
  return String(createPublicKey(privateKey).export({ format: 'jwk' }).x);
}

function edSignatureVerifies(privateJwk: object, publicJwk: object, data: Buffer): boolean {
  const signature = sign(null, data, createPrivateKey({ key: asJwk(privateJwk), format: 'jwk' }));
  return verify(null, data, createPublicKey({ key: asJwk(publicJwk), format: 'jwk' }), signature);
}

function stripped(key: AttestationJwk): Record<string, unknown> {
  return { kty: key.kty, crv: key.crv, x: key.x, d: key.d, kid: key.kid };
}

describe('attestation keys', () => {
  let adir = '';

  beforeEach(() => {
    adir = mkdtempSync(join(tmpdir(), 'acs3-'));
  });

  afterEach(() => {
    rmSync(adir, { recursive: true, force: true });
  });

  const anyLogin = (): SigningKeys => ({ keys: [generateSigningKey()] });

  function localKey(): AttestationJwk {
    const path = join(adir, 'local-dev', 'keys.json');
    const [key] = loadAttestationKeys(fileSource('local-dev', path, true), anyLogin()).keys;
    return key!;
  }

  /** A hosted-dev login key file in `adir`, and the path of the attestation key file beside it. */
  function hosted(login: SigningJwk = generateSigningKey()): {
    readonly config: Pick<Config, 'profile' | 'keys'>;
    readonly login: SigningKeys;
    readonly path: string;
  } {
    const loginPath = join(adir, 'keys.json');
    writeKeyFile(loginPath, JSON.stringify({ profile: 'hosted-dev', keys: [login] }));
    return {
      config: fileSource('hosted-dev', loginPath, false),
      login: { keys: [login] },
      path: join(adir, ATTESTATION_KEY_FILE_NAME),
    };
  }

  const attestationFile = (keys: unknown, profile: unknown = 'hosted-dev'): string =>
    JSON.stringify({ profile, keys });

  describe('generateAttestationKey', () => {
    test('returns an Ed25519 signing JWK whose kid is its RFC 7638 thumbprint acs-3.1', () => {
      const key = generateAttestationKey();
      expect(Object.keys(key).sort()).toEqual(ATTESTATION_MEMBERS);
      expect(key.kty).toBe('OKP');
      expect(key.crv).toBe('Ed25519');
      expect(key.alg).toBe('Ed25519');
      expect(key.use).toBe('sig');
      expect(key.x).toMatch(B64URL_32);
      expect(key.d).toMatch(B64URL_32);
      expect(key.kid).toBe(okpThumbprint(key.x));
    });

    test('two calls give two different keys acs-3.1', () => {
      const first = generateAttestationKey();
      const second = generateAttestationKey();
      expect(second.d).not.toBe(first.d);
      expect(second.x).not.toBe(first.x);
      expect(second.kid).not.toBe(first.kid);
    });

    test('Node loads it as an Ed25519 private key whose public half is x acs-3.1', () => {
      const key = generateAttestationKey();
      const privateKey = createPrivateKey({ key: asJwk(stripped(key)), format: 'jwk' });
      expect(privateKey.asymmetricKeyType).toBe('ed25519');
      expect(createPublicKey(privateKey).export({ format: 'jwk' }).x).toBe(key.x);
      expect(publicXOfD(key.d)).toBe(key.x);
      const data = Buffer.from('an attestation signing input');
      expect(edSignatureVerifies(key, { kty: 'OKP', crv: 'Ed25519', x: key.x }, data)).toBe(true);
    });
  });

  describe('publicAttestationKey', () => {
    test('keeps exactly kty, crv, alg, use, kid and x, and no d acs-3.1', () => {
      const key = generateAttestationKey();
      const half = publicAttestationKey(key);
      expect(Object.keys(half).sort()).toEqual(PUBLIC_ATTESTATION_MEMBERS);
      expect(Object.hasOwn(half, 'd')).toBe(false);
      expect(half).toEqual({
        kty: 'OKP',
        crv: 'Ed25519',
        alg: 'Ed25519',
        use: 'sig',
        kid: key.kid,
        x: key.x,
      });
      expect(JSON.stringify(half)).not.toContain(key.d);
    });
  });

  describe('the local-dev attestation key', () => {
    test('is one key, the same on every call and whatever the key path, and nothing is written acs-3.1', () => {
      const login = anyLogin();
      const paths = [
        join(adir, 'keys.json'),
        join(adir, 'elsewhere', 'keys.json'),
        join(adir, 'missing', 'deeper', 'keys.json'),
      ];
      mkdirSync(join(adir, 'elsewhere'));
      const loaded = [
        ...paths.map((path) => loadAttestationKeys(fileSource('local-dev', path, true), login)),
        loadAttestationKeys(fileSource('local-dev', paths[0]!, false), anyLogin()),
      ];
      for (const keys of loaded) {
        expect(keys.keys).toHaveLength(1);
        expect(keys).toEqual(loaded[0]);
      }
      const [key] = loaded[0]!.keys;
      expect(Object.keys(key!).sort()).toEqual(ATTESTATION_MEMBERS);
      expect(key!.kty).toBe('OKP');
      expect(key!.crv).toBe('Ed25519');
      expect(publicXOfD(key!.d)).toBe(key!.x);
      expect(readdirSync(adir).sort()).toEqual(['elsewhere']);
      expect(readdirSync(join(adir, 'elsewhere'))).toEqual([]);
    });

    test('its public half is the published local-dev entry, and its signature verifies under that entry acs-3.1', () => {
      const key = localKey();
      const published = publishedAttestationKeys()['local-dev'];
      expect(published).toHaveLength(1);
      expect(published[0]).toEqual(publicAttestationKey(key));
      expect(published[0]!.x).toBe(key.x);
      expect(published[0]!.kid).toBe(key.kid);
      const data = Buffer.from('a binding of a local world');
      expect(edSignatureVerifies(key, published[0]!, data)).toBe(true);
      const other = generateAttestationKey();
      expect(edSignatureVerifies(other, published[0]!, data)).toBe(false);
    });
  });

  describe('publishedAttestationKeys', () => {
    test('lists the three profiles, every entry a public key of exactly six members acs-3.1', () => {
      const published = publishedAttestationKeys();
      expect(Object.keys(published).sort()).toEqual(['hosted-dev', 'local-dev', 'production']);
      for (const [profile, entries] of Object.entries(published)) {
        for (const entry of entries) {
          expect(Object.keys(entry).sort(), profile).toEqual(PUBLIC_ATTESTATION_MEMBERS);
          expect(Object.hasOwn(entry, 'd'), profile).toBe(false);
          expect(entry.kty, profile).toBe('OKP');
          expect(entry.crv, profile).toBe('Ed25519');
        }
      }
    });

    test('no hosted-dev or production entry shares an x or a kid with a local-dev entry acs-3.1', () => {
      const published = publishedAttestationKeys();
      const local = published['local-dev'];
      expect(local.length).toBeGreaterThan(0);
      for (const profile of ['hosted-dev', 'production'] as const) {
        for (const entry of published[profile]) {
          for (const dev of local) {
            expect(entry.x, profile).not.toBe(dev.x);
            expect(entry.kid, profile).not.toBe(dev.kid);
          }
        }
      }
    });

    test('the generated attestation-public-keys.json is what the function returns acs-3.1', () => {
      const text = readFileSync(join(PACKAGE_ROOT, 'attestation-public-keys.json'), 'utf8');
      expect(JSON.parse(text)).toEqual(publishedAttestationKeys());
    });
  });

  describe('a hosted-dev attestation key file', () => {
    test('sits beside the login key file, and its keys load in file order with alg and use filled in acs-3.1', () => {
      expect(ATTESTATION_KEY_FILE_NAME).toBe('attestation-keys.json');
      const a = generateAttestationKey();
      const b = generateAttestationKey();
      const setup = hosted();
      writeKeyFile(setup.path, attestationFile([stripped(b), stripped(a)]));
      const bytes = readFileSync(setup.path);
      const loaded = loadAttestationKeys(setup.config, setup.login);
      expect(loaded.keys).toEqual([b, a]);
      expect(readFileSync(setup.path).equals(bytes)).toBe(true);
      expect(readdirSync(adir).sort()).toEqual([ATTESTATION_KEY_FILE_NAME, 'keys.json'].sort());
    });

    test('a file of one key with alg and use written loads that key acs-3.1', () => {
      const a = generateAttestationKey();
      const setup = hosted();
      writeKeyFile(setup.path, attestationFile([a]));
      expect(loadAttestationKeys(setup.config, setup.login).keys).toEqual([a]);
    });

    test('is read from the directory of the login key file wherever that is acs-3.1', () => {
      const a = generateAttestationKey();
      const confDir = join(adir, 'conf');
      mkdirSync(confDir, { mode: 0o700 });
      const loginKey = generateSigningKey();
      const loginPath = join(confDir, 'login.json');
      writeKeyFile(loginPath, JSON.stringify({ profile: 'hosted-dev', keys: [loginKey] }));
      // A file in the parent directory is not the one beside the login key file.
      writeKeyFile(
        join(adir, ATTESTATION_KEY_FILE_NAME),
        attestationFile([generateAttestationKey()]),
      );
      writeKeyFile(join(confDir, ATTESTATION_KEY_FILE_NAME), attestationFile([a]));
      const config = fileSource('hosted-dev', loginPath, false);
      expect(loadAttestationKeys(config, { keys: [loginKey] }).keys).toEqual([a]);
    });

    test('a valid file padded to exactly 65,536 bytes loads acs-3.1', () => {
      const a = generateAttestationKey();
      const setup = hosted();
      const content = attestationFile([a]);
      writeKeyFile(setup.path, content + ' '.repeat(65_536 - Buffer.byteLength(content)));
      expect(statSync(setup.path).size).toBe(65_536);
      expect(loadAttestationKeys(setup.config, setup.login).keys).toEqual([a]);
    });

    test('production holds no attestation key: a profile refusal acs-3.1', () => {
      const error = refusalOf(() =>
        loadAttestationKeys({ profile: 'production', keys: { kind: 'external' } }, anyLogin()),
      );
      expect(error.setting).toBe('MR_ACCOUNT_PROFILE');
    });
  });

  interface AttestationFixtures {
    readonly a: AttestationJwk;
    readonly b: AttestationJwk;
    readonly login: SigningJwk;
    readonly otherP256: SigningJwk;
    readonly ed448: JsonWebKey;
    readonly x25519: JsonWebKey;
    readonly local: () => AttestationJwk;
  }

  describe('every refused hosted-dev attestation key file names that file and leaks no key material', () => {
    let fx: AttestationFixtures;

    beforeEach(() => {
      let local: AttestationJwk | undefined;
      fx = {
        a: generateAttestationKey(),
        b: generateAttestationKey(),
        login: generateSigningKey(),
        otherP256: generateSigningKey(),
        ed448: generateKeyPairSync('ed448').privateKey.export({ format: 'jwk' }),
        x25519: generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }),
        local: () => {
          local ??= localKey();
          return local;
        },
      };
    });

    function secrets(f: AttestationFixtures, usedLocal: boolean): string[] {
      const all = [f.a.d, f.b.d, f.login.d, f.otherP256.d];
      for (const extra of [f.ed448.d, f.x25519.d]) {
        if (typeof extra === 'string') all.push(extra);
      }
      if (usedLocal) all.push(f.local().d);
      return all;
    }

    /** Loads the file at `setup.path` and checks the refusal, the message and that nothing moved. */
    function expectRefused(setup: ReturnType<typeof hosted>, usedLocal = false): void {
      const before = readdirSync(adir).sort();
      // Only a regular file has bytes to compare; a directory is checked by its own test.
      const bytes =
        existsSync(setup.path) && statSync(setup.path).isFile()
          ? readFileSync(setup.path)
          : undefined;
      const error = refusalOf(() => loadAttestationKeys(setup.config, setup.login));
      expect(error.setting).toBe('MR_ACCOUNT_KEY_FILE');
      expect(error.message).toContain(ATTESTATION_KEY_FILE_NAME);
      for (const secret of secrets(fx, usedLocal)) {
        expect(error.message).not.toContain(secret);
        expect(String(error)).not.toContain(secret);
      }
      expect(readdirSync(adir).sort()).toEqual(before);
      if (bytes !== undefined) expect(readFileSync(setup.path).equals(bytes)).toBe(true);
    }

    test('the valid control file loads', () => {
      const setup = hosted(fx.login);
      writeKeyFile(setup.path, attestationFile([fx.a]));
      expect(loadAttestationKeys(setup.config, setup.login).keys).toEqual([fx.a]);
    });

    const cases: ReadonlyArray<readonly [string, (f: AttestationFixtures) => string, boolean?]> = [
      ['a file that is not JSON', (f) => attestationFile([f.a]).slice(0, -1)],
      ['a JSON array', (f) => JSON.stringify([f.a])],
      ['JSON null', () => 'null'],
      [
        'an extra top-level member',
        (f) => JSON.stringify({ profile: 'hosted-dev', keys: [f.a], comment: 'x' }),
      ],
      ['a file without a profile', (f) => JSON.stringify({ keys: [f.a] })],
      ['a file marked local-dev', (f) => attestationFile([f.a], 'local-dev')],
      ['a file marked production', (f) => attestationFile([f.a], 'production')],
      ['an empty key list', () => attestationFile([])],
      ['keys that are not an array', (f) => attestationFile(f.a)],
      ['an entry that is null', (f) => attestationFile([f.a, null])],
      ['an entry with an extra member', (f) => attestationFile([{ ...f.a, key_ops: ['sign'] }])],
      ['an entry with a y member', (f) => attestationFile([{ ...f.a, y: f.login.y }])],
      ['the P-256 login key itself', (f) => attestationFile([f.login])],
      ['another P-256 key', (f) => attestationFile([f.otherP256])],
      ['kty EC on Ed25519 members', (f) => attestationFile([{ ...f.a, kty: 'EC' }])],
      ['crv X25519 on Ed25519 members', (f) => attestationFile([{ ...f.a, crv: 'X25519' }])],
      ['crv Ed448 on Ed25519 members', (f) => attestationFile([{ ...f.a, crv: 'Ed448' }])],
      ['an Ed448 key', (f) => attestationFile([{ ...f.ed448, kid: 'ed448' }])],
      ['an X25519 key', (f) => attestationFile([{ ...f.x25519, kid: 'x25519' }])],
      ['alg EdDSA', (f) => attestationFile([{ ...f.a, alg: 'EdDSA' }])],
      ['alg ES256', (f) => attestationFile([{ ...f.a, alg: 'ES256' }])],
      ['use enc', (f) => attestationFile([{ ...f.a, use: 'enc' }])],
      ['a public-only entry', (f) => attestationFile([without(f.a, 'd')])],
      ['an entry without x', (f) => attestationFile([without(f.a, 'x')])],
      ['an entry without a kid', (f) => attestationFile([without(f.a, 'kid')])],
      ['an empty kid', (f) => attestationFile([{ ...f.a, kid: '' }])],
      ['a kid containing a slash', (f) => attestationFile([{ ...f.a, kid: 'a/b' }])],
      [
        'a kid containing a control character',
        (f) => attestationFile([{ ...f.a, kid: `a${BELL}b` }]),
      ],
      ['a kid of 65 characters', (f) => attestationFile([{ ...f.a, kid: 'k'.repeat(65) }])],
      ['a numeric kid', (f) => attestationFile([{ ...f.a, kid: 1 }])],
      ['x one character short', (f) => attestationFile([{ ...f.a, x: f.a.x.slice(1) }])],
      ['x with a trailing =', (f) => attestationFile([{ ...f.a, x: `${f.a.x}=` }])],
      ['d one character long', (f) => attestationFile([{ ...f.a, d: `${f.a.d}A` }])],
      ['d with a trailing newline', (f) => attestationFile([{ ...f.a, d: `${f.a.d}\n` }])],
      ['d taken from another key', (f) => attestationFile([{ ...f.a, d: f.b.d }])],
      ['two entries sharing a kid', (f) => attestationFile([f.a, { ...f.b, kid: f.a.kid }])],
      [
        'an entry whose kid a login key carries',
        (f) => attestationFile([{ ...f.a, kid: f.login.kid }]),
      ],
      [
        'a kid shared with a login key after a good entry',
        (f) => attestationFile([f.b, { ...f.a, kid: f.login.kid }]),
      ],
      ['the fixed local-dev key copied whole', (f) => attestationFile([f.local()]), true],
      [
        'the fixed local-dev key under another kid',
        (f) => attestationFile([{ ...f.local(), kid: 'copied-local-dev' }]),
        true,
      ],
      [
        "the fixed local-dev kid on another key's material",
        (f) => attestationFile([{ ...f.a, kid: f.local().kid }]),
        true,
      ],
      [
        'the fixed local-dev key after a good entry',
        (f) => attestationFile([f.a, f.local()]),
        true,
      ],
      [
        'a valid entry followed by a refused one',
        (f) => attestationFile([f.a, { ...f.b, use: 'enc' }]),
      ],
    ];

    const caseRows = cases.map(([name, build, usedLocal]) => ({
      name,
      build,
      usedLocal: usedLocal === true,
    }));

    test.each(caseRows)('$name is refused acs-3.4', ({ build, usedLocal }) => {
      const content = build(fx);
      const setup = hosted(fx.login);
      writeKeyFile(setup.path, content);
      expectRefused(setup, usedLocal);
    });

    test('an absent attestation key file is refused and nothing is written acs-3.4', () => {
      const setup = hosted(fx.login);
      expectRefused(setup);
      expect(existsSync(setup.path)).toBe(false);
    });

    test('a directory at the attestation key path is refused and left in place acs-3.4', () => {
      const setup = hosted(fx.login);
      mkdirSync(setup.path, { mode: 0o700 });
      expectRefused(setup);
      expect(statSync(setup.path).isDirectory()).toBe(true);
      expect(readdirSync(setup.path)).toEqual([]);
    });

    test('a valid file one byte over 65,536 bytes is refused acs-3.4', () => {
      const setup = hosted(fx.login);
      const content = attestationFile([fx.a]);
      writeKeyFile(setup.path, content + ' '.repeat(65_537 - Buffer.byteLength(content)));
      expect(statSync(setup.path).size).toBe(65_537);
      expectRefused(setup);
    });

    test('a file that grants its group or others any access is refused, and loads at 0600 acs-3.4', () => {
      if (!POSIX) return;
      const setup = hosted(fx.login);
      writeKeyFile(setup.path, attestationFile([fx.a]), 0o600);
      expect(loadAttestationKeys(setup.config, setup.login).keys).toEqual([fx.a]);
      for (const mode of [0o644, 0o640, 0o604, 0o610, 0o601, 0o660]) {
        chmodSync(setup.path, mode);
        expectRefused(setup);
      }
      chmodSync(setup.path, 0o600);
      expect(loadAttestationKeys(setup.config, setup.login).keys).toEqual([fx.a]);
    });
  });

  describe('a login key file holding an attestation key', () => {
    test.each([
      'local-dev',
      'hosted-dev',
    ] as const)('is refused by loadSigningKeys under %s acs-3.4', (profile) => {
      const key = generateAttestationKey();
      const path = join(adir, 'keys.json');
      writeKeyFile(path, JSON.stringify({ profile, keys: [key] }));
      const bytes = readFileSync(path);
      const error = refusalOf(() => loadSigningKeys(fileSource(profile, path, true)));
      expect(error.setting).toBe('MR_ACCOUNT_KEY_FILE');
      expect(error.message).not.toContain(key.d);
      expect(readFileSync(path).equals(bytes)).toBe(true);
    });

    test('the attestation key file named as the login key file is refused acs-3.4', () => {
      const setup = hosted();
      writeKeyFile(setup.path, attestationFile([generateAttestationKey()]));
      const error = refusalOf(() => loadSigningKeys(fileSource('hosted-dev', setup.path, false)));
      expect(error.setting).toBe('MR_ACCOUNT_KEY_FILE');
    });
  });
});

// ---- the handle keys ----

const HANDLE_SETTING = 'MR_ACCOUNT_HANDLE_KEY_FILE';
const HANDLE_KEY_MEMBERS = ['k', 'kid', 'kty'];
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/;
const KID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PROFILES: readonly Profile[] = ['local-dev', 'hosted-dev', 'production'];

type HandleSource = Pick<Config, 'profile' | 'keys' | 'handleKeys'>;

describe('handle keys', () => {
  let hdir = '';

  beforeEach(() => {
    hdir = mkdtempSync(join(tmpdir(), 'acs14-'));
  });

  afterEach(() => {
    rmSync(hdir, { recursive: true, force: true });
  });

  /** A profile's handle key source: the handle key file at `path`, the login key file in `hdir`. */
  function handleSource(profile: Profile, path: string, generateIfMissing = false): HandleSource {
    return {
      profile,
      keys:
        profile === 'production'
          ? { kind: 'external' }
          : {
              kind: 'file',
              path: join(hdir, 'keys.json'),
              generateIfMissing: profile === 'local-dev',
            },
      handleKeys: { path, generateIfMissing },
    };
  }

  const handleFile = (keys: unknown, profile: unknown = 'local-dev'): string =>
    JSON.stringify({ profile, keys });

  function handleRefusalOf(load: () => unknown): ConfigError {
    try {
      load();
    } catch (error) {
      if (error instanceof ConfigError) return error;
      throw error;
    }
    throw new Error('the handle key file was accepted where it must be refused');
  }

  /** Pieces of a key's `k` that a refusal must not hold: its start, its middle and its end. */
  function partsOfK(k: string): string[] {
    return [k, k.slice(0, 12), k.slice(37, 49), k.slice(-12)];
  }

  function expectCleanHandleRefusal(error: ConfigError, keys: readonly HandleJwk[]): void {
    expect(error.setting).toBe(HANDLE_SETTING);
    expect(error.message).toContain(HANDLE_SETTING);
    for (const key of keys) {
      for (const part of partsOfK(key.k)) {
        expect(error.message).not.toContain(part);
        expect(String(error)).not.toContain(part);
      }
    }
  }

  /** A fresh key whose `k` satisfies `wanted`. */
  function keyWhere(wanted: (k: string) => boolean): HandleJwk {
    for (let i = 0; i < 500; i += 1) {
      const key = generateHandleKey();
      if (wanted(key.k)) return key;
    }
    throw new Error('no generated handle key had the wanted k');
  }

  /** A hand-made key of `bytes` random-looking bytes under `kid`. */
  function keyOfBytes(bytes: Buffer, kid: string): Record<string, unknown> {
    return { kty: 'oct', kid, k: bytes.toString('base64url') };
  }

  describe('generateHandleKey', () => {
    test('returns an oct JWK of 64 bytes in canonical unpadded base64url and a well-formed kid', () => {
      const key = generateHandleKey();
      expect(Object.keys(key).sort()).toEqual(HANDLE_KEY_MEMBERS);
      expect(key.kty).toBe('oct');
      expect(key.k).toMatch(B64URL_64);
      const bytes = Buffer.from(key.k, 'base64url');
      expect(bytes.length).toBe(64);
      expect(bytes.toString('base64url')).toBe(key.k);
      expect(key.kid).toMatch(KID);
    });

    test('two calls give two different keys under two different kids', () => {
      const first = generateHandleKey();
      const second = generateHandleKey();
      expect(second.k).not.toBe(first.k);
      expect(second.kid).not.toBe(first.kid);
    });
  });

  describe('readHandleKeys', () => {
    test.each([
      'local-dev',
      'hosted-dev',
    ] as const)('an absent file under %s is undefined and nothing is written', (profile) => {
      const path = join(hdir, 'nested', HANDLE_KEY_FILE_NAME);
      for (const generateIfMissing of [false, true]) {
        expect(readHandleKeys(handleSource(profile, path, generateIfMissing))).toBeUndefined();
        expect(readdirSync(hdir)).toEqual([]);
      }
    });

    test('an absent file under production, which holds no key file of its own, is refused and nothing is written', () => {
      const path = join(hdir, 'nested', HANDLE_KEY_FILE_NAME);
      const error = handleRefusalOf(() => readHandleKeys(handleSource('production', path)));
      expect(error.setting).toBe(HANDLE_SETTING);
      expect(readdirSync(hdir)).toEqual([]);
    });

    test.each(
      PROFILES,
    )('a valid file marked %s loads under that profile and is left unchanged acs-14.6', (profile) => {
      const a = generateHandleKey();
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      writeKeyFile(path, handleFile([a], profile));
      const bytes = readFileSync(path);
      expect(readHandleKeys(handleSource(profile, path))).toEqual({ keys: [a] });
      expect(readFileSync(path).equals(bytes)).toBe(true);
      expect(readdirSync(hdir)).toEqual([HANDLE_KEY_FILE_NAME]);
    });

    test.each(
      PROFILES,
    )('a file of two keys under %s loads both in file order, so a retired key stays acs-14.6', (profile) => {
      const current = generateHandleKey();
      const retired = generateHandleKey();
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      writeKeyFile(path, handleFile([current, retired], profile));
      expect(readHandleKeys(handleSource(profile, path))).toEqual({ keys: [current, retired] });
      writeKeyFile(path, handleFile([retired, current], profile));
      expect(readHandleKeys(handleSource(profile, path))).toEqual({ keys: [retired, current] });
    });

    test('the file is read where handleKeys.path says, not beside the login key file acs-14.6', () => {
      const wanted = generateHandleKey();
      const elsewhere = join(hdir, 'elsewhere');
      mkdirSync(elsewhere, { mode: 0o700 });
      writeKeyFile(
        join(hdir, HANDLE_KEY_FILE_NAME),
        handleFile([generateHandleKey()], 'hosted-dev'),
      );
      const path = join(elsewhere, 'named.json');
      writeKeyFile(path, handleFile([wanted], 'hosted-dev'));
      expect(readHandleKeys(handleSource('hosted-dev', path))).toEqual({ keys: [wanted] });
    });

    test('a file marked for another profile is refused under every profile', () => {
      const a = generateHandleKey();
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      for (const marked of PROFILES) {
        writeKeyFile(path, handleFile([a], marked));
        for (const profile of PROFILES) {
          if (profile === marked) continue;
          const error = handleRefusalOf(() => readHandleKeys(handleSource(profile, path)));
          expectCleanHandleRefusal(error, [a]);
        }
        expect(readHandleKeys(handleSource(marked, path))).toEqual({ keys: [a] });
      }
    });

    test.each([
      'hosted-dev',
      'production',
    ] as const)('%s refuses a file its group or others may access, and loads it at 0600', (profile) => {
      if (!POSIX) return;
      const a = generateHandleKey();
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      writeKeyFile(path, handleFile([a], profile), 0o600);
      expect(readHandleKeys(handleSource(profile, path))).toEqual({ keys: [a] });
      for (const mode of [0o644, 0o640, 0o604, 0o610, 0o601, 0o660]) {
        chmodSync(path, mode);
        expectCleanHandleRefusal(
          handleRefusalOf(() => readHandleKeys(handleSource(profile, path))),
          [a],
        );
      }
      chmodSync(path, 0o600);
      expect(readHandleKeys(handleSource(profile, path))).toEqual({ keys: [a] });
    });

    test('local-dev loads a 0644 handle key file', () => {
      const a = generateHandleKey();
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      writeKeyFile(path, handleFile([a]), 0o644);
      expect(readHandleKeys(handleSource('local-dev', path))).toEqual({ keys: [a] });
    });

    test('a valid file padded to exactly 65,536 bytes loads, and one byte more is refused', () => {
      const a = generateHandleKey();
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      const content = handleFile([a]);
      writeKeyFile(path, content + ' '.repeat(65_536 - Buffer.byteLength(content)));
      expect(statSync(path).size).toBe(65_536);
      expect(readHandleKeys(handleSource('local-dev', path))).toEqual({ keys: [a] });
      writeKeyFile(path, content + ' '.repeat(65_537 - Buffer.byteLength(content)));
      expect(statSync(path).size).toBe(65_537);
      const bytes = readFileSync(path);
      expectCleanHandleRefusal(
        handleRefusalOf(() => readHandleKeys(handleSource('local-dev', path))),
        [a],
      );
      expect(readFileSync(path).equals(bytes)).toBe(true);
    });

    test.each(
      PROFILES,
    )('a directory at the handle key path is refused by %s and left in place', (profile) => {
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      mkdirSync(path, { mode: 0o700 });
      expectCleanHandleRefusal(
        handleRefusalOf(() => readHandleKeys(handleSource(profile, path))),
        [],
      );
      expect(statSync(path).isDirectory()).toBe(true);
      expect(readdirSync(path)).toEqual([]);
    });
  });

  interface HandleFixtures {
    readonly a: HandleJwk;
    readonly b: HandleJwk;
    /** A key whose `k` holds a `-` or a `_`. */
    readonly dashed: HandleJwk;
  }

  describe('every malformed handle key file is refused, names the setting and leaks no key', () => {
    let fx: HandleFixtures;

    beforeEach(() => {
      fx = {
        a: generateHandleKey(),
        b: generateHandleKey(),
        dashed: keyWhere((k) => k.includes('-') || k.includes('_')),
      };
    });

    const kOf = (key: HandleJwk): Buffer => Buffer.from(key.k, 'base64url');

    /** `k` spelt with other unused bits in its last character: the same 64 bytes. */
    function otherUnusedBits(k: string): string {
      const last = BASE64URL_ALPHABET.indexOf(k[k.length - 1]!);
      return `${k.slice(0, -1)}${BASE64URL_ALPHABET[last ^ 1]!}`;
    }

    test('the valid control file loads', () => {
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      writeKeyFile(path, handleFile([fx.a, fx.b]));
      expect(readHandleKeys(handleSource('local-dev', path))).toEqual({ keys: [fx.a, fx.b] });
    });

    test('the fixtures of the spelling cases spell the same bytes another way', () => {
      const standard = fx.dashed.k.replaceAll('-', '+').replaceAll('_', '/');
      expect(standard).not.toBe(fx.dashed.k);
      expect(Buffer.from(standard, 'base64').equals(kOf(fx.dashed))).toBe(true);
      const other = otherUnusedBits(fx.a.k);
      expect(other).not.toBe(fx.a.k);
      expect(Buffer.from(other, 'base64url').equals(kOf(fx.a))).toBe(true);
    });

    const cases: ReadonlyArray<readonly [string, (f: HandleFixtures) => string]> = [
      ['a file that is not JSON', (f) => handleFile([f.a]).slice(0, -1)],
      ['a JSON array', (f) => JSON.stringify([f.a])],
      ['JSON null', () => 'null'],
      [
        'an extra top-level member',
        (f) => JSON.stringify({ profile: 'local-dev', keys: [f.a], comment: 'x' }),
      ],
      ['a file without a profile', (f) => JSON.stringify({ keys: [f.a] })],
      ['a file without keys', () => JSON.stringify({ profile: 'local-dev' })],
      ['a file marked hosted-dev', (f) => handleFile([f.a], 'hosted-dev')],
      ['a file marked production', (f) => handleFile([f.a], 'production')],
      ['a numeric profile', (f) => handleFile([f.a], 1)],
      ['an empty key list', () => handleFile([])],
      ['keys that are not an array', (f) => handleFile(f.a)],
      ['a key that is null', (f) => handleFile([f.a, null])],
      ['a key that is a string', (f) => handleFile([f.a.k])],
      ['a key with an alg member', (f) => handleFile([{ ...f.a, alg: 'A256SIV' }])],
      ['a key with a use member', (f) => handleFile([{ ...f.a, use: 'enc' }])],
      ['kty OCT', (f) => handleFile([{ ...f.a, kty: 'OCT' }])],
      ['kty EC', (f) => handleFile([{ ...f.a, kty: 'EC' }])],
      ['a key without kty', (f) => handleFile([without(f.a, 'kty')])],
      ['a key without a kid', (f) => handleFile([without(f.a, 'kid')])],
      ['an empty kid', (f) => handleFile([{ ...f.a, kid: '' }])],
      ['a kid of 65 characters', (f) => handleFile([{ ...f.a, kid: 'k'.repeat(65) }])],
      ['a kid containing a slash', (f) => handleFile([{ ...f.a, kid: 'a/b' }])],
      ['a kid containing a dot', (f) => handleFile([{ ...f.a, kid: 'a.b' }])],
      ['a kid containing a control character', (f) => handleFile([{ ...f.a, kid: `a${BELL}b` }])],
      ['a numeric kid', (f) => handleFile([{ ...f.a, kid: 1 }])],
      ['a key without k', (f) => handleFile([without(f.a, 'k')])],
      ['a numeric k', (f) => handleFile([{ ...f.a, k: 64 }])],
      ['a k of 63 bytes', (f) => handleFile([keyOfBytes(kOf(f.a).subarray(0, 63), f.a.kid)])],
      [
        'a k of 65 bytes',
        (f) =>
          handleFile([keyOfBytes(Buffer.concat([kOf(f.a), kOf(f.b).subarray(0, 1)]), f.a.kid)]),
      ],
      ['a k of 32 bytes', (f) => handleFile([keyOfBytes(kOf(f.a).subarray(0, 32), f.a.kid)])],
      ['a k with base64 padding', (f) => handleFile([{ ...f.a, k: `${f.a.k}==` }])],
      ['a k with a trailing newline', (f) => handleFile([{ ...f.a, k: `${f.a.k}\n` }])],
      [
        'a k in the standard base64 alphabet',
        (f) =>
          handleFile([{ ...f.dashed, k: f.dashed.k.replaceAll('-', '+').replaceAll('_', '/') }]),
      ],
      [
        'a k whose last character carries other unused bits',
        (f) => handleFile([{ ...f.a, k: otherUnusedBits(f.a.k) }]),
      ],
      ['two keys sharing one kid', (f) => handleFile([f.a, { ...f.b, kid: f.a.kid }])],
      [
        'two keys sharing one k',
        (f) => handleFile([f.a, { ...f.a, kid: `${f.a.kid}x`.slice(-64) }]),
      ],
      ['a valid key followed by an invalid one', (f) => handleFile([f.a, { ...f.b, kty: 'EC' }])],
    ];

    test.each(
      cases,
    )('%s is refused by readHandleKeys, and the file is left as it is', (_name, build) => {
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      writeKeyFile(path, build(fx));
      const bytes = readFileSync(path);
      const error = handleRefusalOf(() => readHandleKeys(handleSource('local-dev', path, true)));
      expectCleanHandleRefusal(error, [fx.a, fx.b, fx.dashed]);
      expect(readFileSync(path).equals(bytes)).toBe(true);
      expect(readdirSync(hdir)).toEqual([HANDLE_KEY_FILE_NAME]);
    });

    test.each(
      cases,
    )('%s is refused by createHandleKeys on local-dev, and never replaced', (_name, build) => {
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      writeKeyFile(path, build(fx));
      const bytes = readFileSync(path);
      const error = handleRefusalOf(() => createHandleKeys(handleSource('local-dev', path, true)));
      expectCleanHandleRefusal(error, [fx.a, fx.b, fx.dashed]);
      expect(readFileSync(path).equals(bytes)).toBe(true);
      expect(readdirSync(hdir)).toEqual([HANDLE_KEY_FILE_NAME]);
    });
  });

  describe('createHandleKeys', () => {
    test('local-dev makes the absent file owner-only with one new key, in directories it makes owner-only acs-14.6', () => {
      const parent = join(hdir, 'made', 'here');
      const path = join(parent, HANDLE_KEY_FILE_NAME);
      const created = createHandleKeys(handleSource('local-dev', path, true));
      expect(created.keys).toHaveLength(1);
      const [key] = created.keys;
      expect(Object.keys(key!).sort()).toEqual(HANDLE_KEY_MEMBERS);
      expect(key!.kty).toBe('oct');
      expect(key!.k).toMatch(B64URL_64);
      expect(key!.kid).toMatch(KID);
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      expect(parsed).toEqual({ profile: 'local-dev', keys: [key] });
      if (POSIX) {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(parent).mode & 0o777).toBe(0o700);
        expect(statSync(join(hdir, 'made')).mode & 0o777).toBe(0o700);
      }
    });

    test('what it made is what readHandleKeys reads, on every later read acs-14.6', () => {
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      const created = createHandleKeys(handleSource('local-dev', path, true));
      expect(readHandleKeys(handleSource('local-dev', path, true))).toEqual(created);
      expect(readHandleKeys(handleSource('local-dev', path, false))).toEqual(created);
    });

    test('a second call returns the same keys and leaves the file bytes unchanged acs-14.6', () => {
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      const first = createHandleKeys(handleSource('local-dev', path, true));
      const bytes = readFileSync(path);
      expect(createHandleKeys(handleSource('local-dev', path, true))).toEqual(first);
      expect(readFileSync(path).equals(bytes)).toBe(true);
    });

    test('an existing valid file of two keys is returned as it is, never replaced acs-14.6', () => {
      const current = generateHandleKey();
      const retired = generateHandleKey();
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      writeKeyFile(path, handleFile([current, retired]));
      const bytes = readFileSync(path);
      expect(createHandleKeys(handleSource('local-dev', path, true))).toEqual({
        keys: [current, retired],
      });
      expect(readFileSync(path).equals(bytes)).toBe(true);
    });

    test('two fresh files hold two different keys', () => {
      const one = createHandleKeys(handleSource('local-dev', join(hdir, 'one', 'h.json'), true));
      const two = createHandleKeys(handleSource('local-dev', join(hdir, 'two', 'h.json'), true));
      expect(two.keys[0]!.k).not.toBe(one.keys[0]!.k);
    });

    const parents: ReadonlyArray<readonly [string, (root: string) => string]> = [
      ['a parent that already existed', (root) => root],
      ['a parent the call made', (root) => join(root, 'made', 'here')],
    ];

    test.each(
      parents,
    )('making the file in %s leaves it the only entry beside it', (_name, parentOf) => {
      const parent = parentOf(hdir);
      const path = join(parent, HANDLE_KEY_FILE_NAME);
      createHandleKeys(handleSource('local-dev', path, true));
      expect(readdirSync(parent)).toEqual([HANDLE_KEY_FILE_NAME]);
      createHandleKeys(handleSource('local-dev', path, true));
      expect(readdirSync(parent)).toEqual([HANDLE_KEY_FILE_NAME]);
    });

    test.each([
      ['hosted-dev', 'hosted-dev', false],
      ['production', 'production', false],
      ['local-dev without generateIfMissing', 'local-dev', false],
    ] as const)('%s refuses to make the file and writes nothing', (_name, profile, generateIfMissing) => {
      const path = join(hdir, 'missing', HANDLE_KEY_FILE_NAME);
      const error = handleRefusalOf(() =>
        createHandleKeys(handleSource(profile, path, generateIfMissing)),
      );
      expect(error.setting).toBe(HANDLE_SETTING);
      expect(error.message).toContain(HANDLE_SETTING);
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(hdir)).toEqual([]);
    });

    test('a directory at the path is refused and left in place', () => {
      const path = join(hdir, HANDLE_KEY_FILE_NAME);
      mkdirSync(path, { mode: 0o700 });
      const error = handleRefusalOf(() => createHandleKeys(handleSource('local-dev', path, true)));
      expect(error.setting).toBe(HANDLE_SETTING);
      expect(statSync(path).isDirectory()).toBe(true);
      expect(readdirSync(path)).toEqual([]);
    });
  });
});
