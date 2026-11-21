import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  ConfigError,
  HOSTED_DEV_ISSUER,
  LOCAL_DEV_DATA_DIR,
  LOCAL_DEV_ISSUER,
  loadConfig,
} from './config.ts';

type Env = Record<string, string | undefined>;

// <account-service>/.data, derived from where config.ts lives (this test sits beside it in src/).
const EXPECTED_LOCAL_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.data');

const PROD_DATA_DIR = resolve('/var/lib/x');
const HOSTED_DATA_DIR = resolve('/srv/account-data');
const PROD_ISSUER = 'https://accounts.example.com';

const PRODUCTION: Env = {
  MR_ACCOUNT_PROFILE: 'production',
  MR_ACCOUNT_ISSUER: PROD_ISSUER,
  MR_ACCOUNT_DATA_DIR: PROD_DATA_DIR,
};
const LOCAL: Env = { MR_ACCOUNT_PROFILE: 'local-dev' };
const HOSTED: Env = { MR_ACCOUNT_PROFILE: 'hosted-dev', MR_ACCOUNT_DATA_DIR: HOSTED_DATA_DIR };

// Arabic-Indic digits four, four, five, five.
const ARABIC_INDIC_4455 = String.fromCharCode(0x0664, 0x0664, 0x0665, 0x0665);

function refusalOf(env: Env): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('loadConfig accepted an env it must refuse');
}

function expectRefused(env: Env, setting: string): ConfigError {
  const error = refusalOf(env);
  expect(error).toBeInstanceOf(Error);
  expect(error.setting).toBe(setting);
  expect(error.message).toContain(setting);
  return error;
}

function expectNoLeak(error: ConfigError, secret: string): void {
  expect(error.message).not.toContain(secret);
  expect(String(error)).not.toContain(secret);
  expect(error.stack ?? '').not.toContain(secret);
}

describe('each profile loads from its smallest valid env', () => {
  test('local-dev loads from the profile name alone with the local issuer and defaults', () => {
    expect(loadConfig({ MR_ACCOUNT_PROFILE: 'local-dev' })).toEqual({
      profile: 'local-dev',
      issuer: 'http://localhost:4455',
      listen: { host: '127.0.0.1', port: 4455 },
      dataDir: LOCAL_DEV_DATA_DIR,
      databasePath: join(LOCAL_DEV_DATA_DIR, 'account.sqlite'),
      keys: { kind: 'file', path: join(LOCAL_DEV_DATA_DIR, 'keys.json'), generateIfMissing: true },
      signIn: 'dev-password',
    });
  });

  test('the local data directory is the absolute account-service/.data beside the module', () => {
    expect(isAbsolute(LOCAL_DEV_DATA_DIR)).toBe(true);
    expect(LOCAL_DEV_DATA_DIR.endsWith(`${sep}account-service${sep}.data`)).toBe(true);
    expect(LOCAL_DEV_DATA_DIR).toBe(EXPECTED_LOCAL_DATA_DIR);
  });

  test('the dev issuers are the documented origins', () => {
    expect(LOCAL_DEV_ISSUER).toBe('http://localhost:4455');
    expect(HOSTED_DEV_ISSUER).toBe('https://auth.monster-realm.spookyowltech.com');
  });

  test('hosted-dev loads with the hosted issuer and a key file it never generates', () => {
    expect(loadConfig(HOSTED)).toEqual({
      profile: 'hosted-dev',
      issuer: HOSTED_DEV_ISSUER,
      listen: { host: '127.0.0.1', port: 4455 },
      dataDir: HOSTED_DATA_DIR,
      databasePath: join(HOSTED_DATA_DIR, 'account.sqlite'),
      keys: { kind: 'file', path: join(HOSTED_DATA_DIR, 'keys.json'), generateIfMissing: false },
      signIn: 'dev-password',
    });
  });

  test('production loads with its own issuer, steam sign-in and an external signer', () => {
    expect(loadConfig(PRODUCTION)).toEqual({
      profile: 'production',
      issuer: PROD_ISSUER,
      listen: { host: '127.0.0.1', port: 4455 },
      dataDir: PROD_DATA_DIR,
      databasePath: join(PROD_DATA_DIR, 'account.sqlite'),
      keys: { kind: 'external' },
      signIn: 'steam',
    });
  });

  test('an explicit sign-in method matching the profile loads', () => {
    expect(loadConfig({ ...LOCAL, MR_ACCOUNT_SIGN_IN: 'dev-password' }).signIn).toBe(
      'dev-password',
    );
    expect(loadConfig({ ...HOSTED, MR_ACCOUNT_SIGN_IN: 'dev-password' }).signIn).toBe(
      'dev-password',
    );
    expect(loadConfig({ ...PRODUCTION, MR_ACCOUNT_SIGN_IN: 'steam' }).signIn).toBe('steam');
  });

  test('a set data directory and key file are taken exactly as written in a dev profile', () => {
    const dataDir = resolve('/srv/other-data');
    const keyFile = resolve('/srv/keys/signing.json');
    const local = loadConfig({
      ...LOCAL,
      MR_ACCOUNT_DATA_DIR: dataDir,
      MR_ACCOUNT_KEY_FILE: keyFile,
    });
    expect(local.dataDir).toBe(dataDir);
    expect(local.databasePath).toBe(join(dataDir, 'account.sqlite'));
    expect(local.keys).toEqual({ kind: 'file', path: keyFile, generateIfMissing: true });
    const hosted = loadConfig({ ...HOSTED, MR_ACCOUNT_KEY_FILE: keyFile });
    expect(hosted.keys).toEqual({ kind: 'file', path: keyFile, generateIfMissing: false });
  });

  test('an unset value (undefined or empty) behaves as if the setting were absent', () => {
    const config = loadConfig({
      ...LOCAL,
      MR_ACCOUNT_ISSUER: '',
      MR_ACCOUNT_SIGN_IN: undefined,
      MR_ACCOUNT_PORT: '',
      MR_ACCOUNT_HOST: '',
      MR_ACCOUNT_DATA_DIR: undefined,
      MR_ACCOUNT_KEY_FILE: '',
      MR_STEAM_PUBLISHER_KEY: '',
    });
    expect(config).toEqual(loadConfig(LOCAL));
  });
});

describe('production refuses every dev-only setting and names it', () => {
  test('the control env loads', () => {
    expect(loadConfig(PRODUCTION).issuer).toBe(PROD_ISSUER);
  });

  test.each([
    ['dev-password sign-in', 'dev-password'],
    ['a wrong-case steam sign-in', 'Steam'],
    ['a sign-in with a trailing space', 'steam '],
    ['an unknown sign-in method', 'password'],
  ])('production refuses %s as MR_ACCOUNT_SIGN_IN', (_name, value) => {
    expectRefused({ ...PRODUCTION, MR_ACCOUNT_SIGN_IN: value }, 'MR_ACCOUNT_SIGN_IN');
  });

  test('production refuses any key file, because it signs only with an external signer', () => {
    expectRefused(
      { ...PRODUCTION, MR_ACCOUNT_KEY_FILE: join(PROD_DATA_DIR, 'keys.json') },
      'MR_ACCOUNT_KEY_FILE',
    );
  });

  test.each([
    ['an http issuer', 'http://accounts.example.com'],
    ['the local dev issuer', LOCAL_DEV_ISSUER],
    ['the hosted dev issuer', HOSTED_DEV_ISSUER],
    ['https localhost', 'https://localhost'],
    ['https localhost with the dev port', 'https://localhost:4455'],
    ['an IPv4 literal', 'https://127.0.0.1'],
    ['an IPv6 literal', 'https://[::1]'],
    ['the hosted dev host on another port', 'https://auth.monster-realm.spookyowltech.com:8443'],
    ['a host under the hosted dev host', 'https://x.auth.monster-realm.spookyowltech.com'],
    [
      'a host under the hosted dev host with a port',
      'https://x.auth.monster-realm.spookyowltech.com:8443',
    ],
    ['a trailing dot', 'https://accounts.example.com.'],
    ['a trailing slash', 'https://accounts.example.com/'],
    ['a path', 'https://accounts.example.com/path'],
    ['a query', 'https://accounts.example.com?x=1'],
    ['a fragment', 'https://accounts.example.com#f'],
    ['an upper-case scheme', 'HTTPS://accounts.example.com'],
    ['an upper-case host', 'https://Accounts.example.com'],
    ['the default port written out', 'https://accounts.example.com:443'],
    ['userinfo', 'https://user:pw@accounts.example.com'],
    ['an underscore in a label', 'https://a_b.example.com'],
    ['a .localhost host', 'https://app.localhost'],
    ['a single-label host', 'https://accounts'],
    ['an empty label', 'https://accounts..example.com'],
    ['a label starting with a hyphen', 'https://-a.example.com'],
    ['a label ending with a hyphen', 'https://a-.example.com'],
    ['an all-digit last label', 'https://accounts.example.123'],
    ['a leading space', ` ${PROD_ISSUER}`],
    ['a trailing space', `${PROD_ISSUER} `],
    ['something that is not a URL', 'not a url'],
    ['an unset issuer', undefined],
    ['an empty issuer', ''],
  ])('production refuses %s as MR_ACCOUNT_ISSUER', (_name, value) => {
    expectRefused({ ...PRODUCTION, MR_ACCOUNT_ISSUER: value }, 'MR_ACCOUNT_ISSUER');
  });

  test.each([
    'https://accounts.example.com:8443',
    'https://a-b.example.com',
    'https://notauth.monster-realm.spookyowltech.com',
    'https://monster-realm.spookyowltech.com',
    'https://localhost.example.com',
  ])('production loads the bare https origin %s exactly as written', (issuer) => {
    expect(loadConfig({ ...PRODUCTION, MR_ACCOUNT_ISSUER: issuer }).issuer).toBe(issuer);
  });

  test('production does not read Steam settings in this slice', () => {
    const config = loadConfig({
      ...PRODUCTION,
      MR_STEAM_PUBLISHER_KEY: 'INTERNAL_SECRET_production_publisher',
      MR_STEAM_APP_ID: '480',
    });
    expect(config.profile).toBe('production');
  });

  test.each([
    ['production', PRODUCTION],
    ['hosted-dev', { MR_ACCOUNT_PROFILE: 'hosted-dev' }],
  ])('%s refuses a missing data directory', (_name, base) => {
    expectRefused({ ...base, MR_ACCOUNT_DATA_DIR: undefined }, 'MR_ACCOUNT_DATA_DIR');
  });
});

describe('dev profiles refuse production settings and name them', () => {
  const devProfiles: ReadonlyArray<readonly [string, Env, string]> = [
    ['local-dev', LOCAL, LOCAL_DEV_ISSUER],
    ['hosted-dev', HOSTED, HOSTED_DEV_ISSUER],
  ];

  test.each(
    devProfiles,
  )('%s control env loads, and a Steam app id alone still loads', (_p, base) => {
    expect(() => loadConfig(base)).not.toThrow();
    expect(() => loadConfig({ ...base, MR_STEAM_APP_ID: '480' })).not.toThrow();
  });

  test.each(devProfiles)('%s refuses a production-looking MR_ACCOUNT_ISSUER', (_p, base) => {
    expectRefused({ ...base, MR_ACCOUNT_ISSUER: PROD_ISSUER }, 'MR_ACCOUNT_ISSUER');
  });

  test.each(
    devProfiles,
  )('%s refuses MR_ACCOUNT_ISSUER even set to its own issuer', (_p, base, own) => {
    expectRefused({ ...base, MR_ACCOUNT_ISSUER: own }, 'MR_ACCOUNT_ISSUER');
  });

  test.each(devProfiles)('%s refuses steam sign-in', (_p, base) => {
    expectRefused({ ...base, MR_ACCOUNT_SIGN_IN: 'steam' }, 'MR_ACCOUNT_SIGN_IN');
  });

  test.each(
    devProfiles,
  )('%s refuses a sign-in method that is not exactly dev-password', (_p, base) => {
    expectRefused({ ...base, MR_ACCOUNT_SIGN_IN: 'Dev-Password' }, 'MR_ACCOUNT_SIGN_IN');
    expectRefused({ ...base, MR_ACCOUNT_SIGN_IN: 'dev-password ' }, 'MR_ACCOUNT_SIGN_IN');
  });

  test.each(
    devProfiles.flatMap(([profile, base]) =>
      [
        'MR_STEAM_PUBLISHER_KEY',
        'MR_STEAM_PUBLISHER_KEY_FILE',
        'MR_STEAM_WEB_API_KEY',
        'mr_steam_publisher_key',
      ].map((name) => [profile, base, name] as const),
    ),
  )('%s refuses a Steam key setting %s, named as written', (_p, base, name) => {
    expectRefused({ ...base, [name]: '/run/secrets/steam' }, name);
  });
});

describe('a refusal never carries a secret value', () => {
  test('the Steam publisher key value is not in the refusal', () => {
    const secret = 'INTERNAL_SECRET_publisher_key';
    const error = expectRefused(
      { ...LOCAL, MR_STEAM_PUBLISHER_KEY: secret },
      'MR_STEAM_PUBLISHER_KEY',
    );
    expectNoLeak(error, secret);
  });

  test('the Steam publisher key file value is not in the refusal', () => {
    const secret = 'INTERNAL_SECRET_publisher_key_file';
    const error = expectRefused(
      { ...HOSTED, MR_STEAM_PUBLISHER_KEY_FILE: secret },
      'MR_STEAM_PUBLISHER_KEY_FILE',
    );
    expectNoLeak(error, secret);
  });

  test('the password in a userinfo issuer is not in the refusal', () => {
    const secret = 'INTERNAL_SECRET_issuer_password';
    const error = expectRefused(
      { ...PRODUCTION, MR_ACCOUNT_ISSUER: `https://user:${secret}@accounts.example.com` },
      'MR_ACCOUNT_ISSUER',
    );
    expectNoLeak(error, secret);
  });

  test('a refused issuer path is not in the refusal', () => {
    const secret = 'INTERNAL_SECRET_issuer_path';
    const error = expectRefused(
      { ...PRODUCTION, MR_ACCOUNT_ISSUER: `https://accounts.example.com/${secret}` },
      'MR_ACCOUNT_ISSUER',
    );
    expectNoLeak(error, secret);
  });

  test('the value of an unknown setting is not in the refusal', () => {
    const secret = 'INTERNAL_SECRET_unknown_setting';
    const error = expectRefused({ ...LOCAL, MR_ACCOUNT_TOKEN: secret }, 'MR_ACCOUNT_TOKEN');
    expectNoLeak(error, secret);
  });
});

describe('unknown and wrong-case settings never fall back to a default', () => {
  test.each([
    ['a misspelt name', 'MR_ACCOUNT_SIGNIN', 'dev-password'],
    ['a lower-case name', 'mr_account_issuer', PROD_ISSUER],
    ['a name with a leading space', ' MR_ACCOUNT_PORT', '4455'],
    ['a name with a trailing space', 'MR_ACCOUNT_PORT ', '4455'],
    ['a mixed-case name', 'Mr_Account_Host', '127.0.0.1'],
    ['the bare prefix', 'MR_ACCOUNT_', 'x'],
  ])('%s is refused with the name as written', (_kind, name, value) => {
    expectRefused({ ...LOCAL, [name]: value }, name);
  });

  test.each([
    'MR_ACCOUNT_SIGNIN',
    'mr_account_issuer',
    ' MR_ACCOUNT_PORT',
  ])('an empty or undefined value for %s is ignored', (name) => {
    expect(loadConfig({ ...LOCAL, [name]: '' })).toEqual(loadConfig(LOCAL));
    expect(loadConfig({ ...LOCAL, [name]: undefined })).toEqual(loadConfig(LOCAL));
  });
});

describe('MR_ACCOUNT_PORT', () => {
  test.each([
    ['0', 0],
    ['1', 1],
    ['4455', 4455],
    ['65535', 65535],
  ])('the port %s loads as the number %i', (value, port) => {
    expect(loadConfig({ ...LOCAL, MR_ACCOUNT_PORT: value }).listen.port).toBe(port);
  });

  test('an empty port is the default 4455', () => {
    expect(loadConfig({ ...LOCAL, MR_ACCOUNT_PORT: '' }).listen.port).toBe(4455);
  });

  test.each([
    '65536',
    '99999',
    '0x1167',
    '1e3',
    '-0',
    '-1',
    ' 4455',
    '4455 ',
    '04455',
    '00',
    '+1',
    '4455.0',
    'http',
    ARABIC_INDIC_4455,
  ])('the port %j is refused', (value) => {
    expectRefused({ ...LOCAL, MR_ACCOUNT_PORT: value }, 'MR_ACCOUNT_PORT');
  });
});

describe('MR_ACCOUNT_HOST', () => {
  test.each([
    '127.0.0.1',
    '::1',
    '0.0.0.0',
    'localhost',
  ])('the host %s loads as written', (host) => {
    expect(loadConfig({ ...LOCAL, MR_ACCOUNT_HOST: host }).listen.host).toBe(host);
  });

  test.each([
    'example.com',
    '[::1]',
    ' 127.0.0.1',
    '127.0.0.1 ',
    'LOCALHOST',
    '256.0.0.1',
  ])('the host %j is refused', (host) => {
    expectRefused({ ...LOCAL, MR_ACCOUNT_HOST: host }, 'MR_ACCOUNT_HOST');
  });

  test('production applies the same host rule', () => {
    expect(loadConfig({ ...PRODUCTION, MR_ACCOUNT_HOST: '0.0.0.0' }).listen.host).toBe('0.0.0.0');
    expectRefused({ ...PRODUCTION, MR_ACCOUNT_HOST: 'example.com' }, 'MR_ACCOUNT_HOST');
  });
});

describe('a set data directory or key file must be an absolute, normalised, non-root path', () => {
  const base = resolve('/srv/a');
  const badPaths: ReadonlyArray<readonly [string, string]> = [
    ['a relative path', join('relative', 'dir')],
    ['a dot-relative path', `.${sep}dir`],
    ['a path with ..', `${base}${sep}..${sep}b`],
    ['a path with .', `${base}${sep}.${sep}b`],
    ['a trailing separator', `${base}${sep}`],
    ['a doubled separator', `${base}${sep}${sep}b`],
    ['the filesystem root', resolve('/')],
  ];

  test.each(badPaths)('MR_ACCOUNT_DATA_DIR refuses %s', (_kind, value) => {
    expectRefused({ ...LOCAL, MR_ACCOUNT_DATA_DIR: value }, 'MR_ACCOUNT_DATA_DIR');
    expectRefused({ ...HOSTED, MR_ACCOUNT_DATA_DIR: value }, 'MR_ACCOUNT_DATA_DIR');
    expectRefused({ ...PRODUCTION, MR_ACCOUNT_DATA_DIR: value }, 'MR_ACCOUNT_DATA_DIR');
  });

  test.each(badPaths)('MR_ACCOUNT_KEY_FILE refuses %s', (_kind, value) => {
    expectRefused({ ...LOCAL, MR_ACCOUNT_KEY_FILE: value }, 'MR_ACCOUNT_KEY_FILE');
    expectRefused({ ...HOSTED, MR_ACCOUNT_KEY_FILE: value }, 'MR_ACCOUNT_KEY_FILE');
  });

  test('the same paths written normalised load', () => {
    expect(loadConfig({ ...LOCAL, MR_ACCOUNT_DATA_DIR: join(base, 'b') }).dataDir).toBe(
      join(base, 'b'),
    );
    expect(loadConfig({ ...HOSTED, MR_ACCOUNT_KEY_FILE: join(base, 'keys.json') }).keys).toEqual({
      kind: 'file',
      path: join(base, 'keys.json'),
      generateIfMissing: false,
    });
  });
});

describe('MR_ACCOUNT_PROFILE', () => {
  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['capitalised', 'Production'],
    ['with a leading space', ' production'],
    ['with a trailing space', 'local-dev '],
    ['abbreviated', 'prod'],
    ['upper-case', 'LOCAL-DEV'],
    ['unknown', 'staging'],
  ])('a %s profile is refused', (_kind, value) => {
    expectRefused({ ...PRODUCTION, MR_ACCOUNT_PROFILE: value }, 'MR_ACCOUNT_PROFILE');
  });

  test('an empty env is refused for the missing profile', () => {
    expectRefused({}, 'MR_ACCOUNT_PROFILE');
  });

  test('a polluted prototype does not supply the profile', () => {
    Object.defineProperty(Object.prototype, 'MR_ACCOUNT_PROFILE', {
      value: 'local-dev',
      configurable: true,
      enumerable: true,
      writable: true,
    });
    let error: unknown;
    try {
      loadConfig({});
    } catch (caught) {
      error = caught;
    } finally {
      Reflect.deleteProperty(Object.prototype, 'MR_ACCOUNT_PROFILE');
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe('MR_ACCOUNT_PROFILE');
  });

  test('a polluted prototype neither supplies nor faults any other setting', () => {
    const polluted = ['MR_ACCOUNT_SIGN_IN', 'MR_ACCOUNT_SIGNIN', 'MR_ACCOUNT_KEY_FILE'];
    for (const name of polluted) {
      Object.defineProperty(Object.prototype, name, {
        value: name === 'MR_ACCOUNT_SIGN_IN' ? 'dev-password' : '/x',
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    let loaded: ReturnType<typeof loadConfig> | undefined;
    let error: unknown;
    try {
      loaded = loadConfig({ ...PRODUCTION });
    } catch (caught) {
      error = caught;
    } finally {
      for (const name of polluted) Reflect.deleteProperty(Object.prototype, name);
    }
    expect(error).toBeUndefined();
    expect(loaded?.signIn).toBe('steam');
    expect(loaded?.keys).toEqual({ kind: 'external' });
  });

  test('a null-prototype env loads', () => {
    const env: Env = Object.assign(Object.create(null) as Env, LOCAL);
    expect(loadConfig(env).profile).toBe('local-dev');
  });
});

describe('ConfigError', () => {
  test('carries the setting at fault and names it in its message', () => {
    const error = new ConfigError('MR_ACCOUNT_PORT', 'out of range');
    expect(error).toBeInstanceOf(Error);
    expect(error.setting).toBe('MR_ACCOUNT_PORT');
    expect(error.message).toContain('MR_ACCOUNT_PORT');
  });
});
