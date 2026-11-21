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
import { generateSigningKey, loadSigningKeys, type SigningJwk } from './keys.ts';

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
