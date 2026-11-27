import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type Config,
  ConfigError,
  HOSTED_DEV_ISSUER,
  LOCAL_DEV_DATA_DIR,
  LOCAL_DEV_ISSUER,
  loadConfig,
  STEAM_DEV_APP_ID,
} from './config.ts';
import { HANDLE_KEY_FILE_NAME } from './keys.ts';
import { type RunningServer, startServer } from './server.ts';

type Env = Record<string, string | undefined>;

// <account-service>/.data, derived from where config.ts lives (this test sits beside it in src/).
const EXPECTED_LOCAL_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.data');

const PROD_DATA_DIR = resolve('/var/lib/x');
const HOSTED_DATA_DIR = resolve('/srv/account-data');
const PROD_ISSUER = 'https://accounts.example.com';
const PROD_HANDLE_KEY_FILE = resolve('/etc/account-service/handle-keys.json');

const PRODUCTION: Env = {
  MR_ACCOUNT_PROFILE: 'production',
  MR_ACCOUNT_ISSUER: PROD_ISSUER,
  MR_ACCOUNT_DATA_DIR: PROD_DATA_DIR,
  MR_ACCOUNT_HANDLE_KEY_FILE: PROD_HANDLE_KEY_FILE,
};
const LOCAL: Env = { MR_ACCOUNT_PROFILE: 'local-dev' };
const HOSTED: Env = { MR_ACCOUNT_PROFILE: 'hosted-dev', MR_ACCOUNT_DATA_DIR: HOSTED_DATA_DIR };

// Arabic-Indic digits four, four, five, five.
const ARABIC_INDIC_4455 = String.fromCharCode(0x0664, 0x0664, 0x0665, 0x0665);
// Arabic-Indic digits four, eight, zero.
const ARABIC_INDIC_480 = String.fromCharCode(0x0664, 0x0668, 0x0660);
// LATIN SMALL LETTER LONG S, which upper-cases to S.
const LONG_S = String.fromCharCode(0x017f);
const NUL = String.fromCharCode(0);
const WEB_KEY_SETTING = 'MR_STEAM_WEB_API_KEY';
const PUBLISHER_KEY_SETTING = 'MR_STEAM_PUBLISHER_KEY';

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
      handleKeys: { path: join(LOCAL_DEV_DATA_DIR, HANDLE_KEY_FILE_NAME), generateIfMissing: true },
      trustedProxies: [],
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
      handleKeys: { path: join(HOSTED_DATA_DIR, HANDLE_KEY_FILE_NAME), generateIfMissing: false },
      trustedProxies: [],
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
      handleKeys: { path: PROD_HANDLE_KEY_FILE, generateIfMissing: false },
      trustedProxies: [],
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

  test('production refuses a Steam web key, whatever else is set, never showing its value acs-8.5', () => {
    const webKey = 'INTERNAL_SECRET_production_web_key';
    const publisherKey = 'INTERNAL_SECRET_production_publisher';
    expectNoLeak(
      expectRefused({ ...PRODUCTION, [WEB_KEY_SETTING]: webKey }, 'MR_STEAM_WEB_API_KEY'),
      webKey,
    );
    const error = expectRefused(
      {
        ...PRODUCTION,
        MR_STEAM_APP_ID: '1234567',
        [PUBLISHER_KEY_SETTING]: publisherKey,
        [WEB_KEY_SETTING]: webKey,
      },
      'MR_STEAM_WEB_API_KEY',
    );
    expectNoLeak(error, webKey);
    expectNoLeak(error, publisherKey);
  });

  test.each([
    ['0', '0'],
    ['the development app 480', '480'],
    ['a leading zero', '0480'],
    ['a leading zero on 1', '01'],
    ['a leading space', ' 1234567'],
    ['a trailing space', '1234567 '],
    ['a plus sign', '+1234567'],
    ['a minus sign', '-1234567'],
    ['a decimal point', '1234567.0'],
    ['an exponent', '1e3'],
    ['hex', '0x10'],
    ['one over the largest app id', '4294967296'],
    ['a long number', '12345678901234567890'],
    ['Arabic-Indic digits', ARABIC_INDIC_4455],
    ['a word', 'spacewar'],
  ])('production refuses %s as MR_STEAM_APP_ID acs-8.5', (_name, value) => {
    expectRefused({ ...PRODUCTION, MR_STEAM_APP_ID: value }, 'MR_STEAM_APP_ID');
  });

  test('a refused production app id is not in the refusal acs-8.5', () => {
    expectNoLeak(
      expectRefused({ ...PRODUCTION, MR_STEAM_APP_ID: '01234567' }, 'MR_STEAM_APP_ID'),
      '1234567',
    );
  });

  test('production refusing the development app 480 does not show 480 acs-8.5', () => {
    expectNoLeak(
      expectRefused({ ...PRODUCTION, MR_STEAM_APP_ID: '480' }, 'MR_STEAM_APP_ID'),
      '480',
    );
  });

  test('production checks the web key before the app id acs-8.5', () => {
    expectRefused(
      { ...PRODUCTION, MR_STEAM_APP_ID: '0', [WEB_KEY_SETTING]: 'x' },
      'MR_STEAM_WEB_API_KEY',
    );
  });

  test('production checks its Steam settings after the key file and before the data directory acs-8.5', () => {
    expectRefused(
      {
        ...PRODUCTION,
        MR_ACCOUNT_KEY_FILE: join(PROD_DATA_DIR, 'keys.json'),
        MR_STEAM_APP_ID: '0',
      },
      'MR_ACCOUNT_KEY_FILE',
    );
    expectRefused(
      { ...PRODUCTION, MR_ACCOUNT_DATA_DIR: undefined, MR_STEAM_APP_ID: '0' },
      'MR_STEAM_APP_ID',
    );
    expectRefused(
      { ...PRODUCTION, MR_ACCOUNT_DATA_DIR: undefined, [WEB_KEY_SETTING]: 'x' },
      'MR_STEAM_WEB_API_KEY',
    );
  });

  test.each([
    ['1', 1],
    ['1234567', 1234567],
    ['4294967295', 4294967295],
  ])('production loads MR_STEAM_APP_ID %s as its Steam app, with or without a publisher key acs-8.5', (value, appId) => {
    const publisherKey = 'INTERNAL_SECRET_production_publisher';
    const expected = { ...loadConfig(PRODUCTION), steam: { appId } };
    expect(loadConfig({ ...PRODUCTION, MR_STEAM_APP_ID: value })).toEqual(expected);
    const withKey = loadConfig({
      ...PRODUCTION,
      MR_STEAM_APP_ID: value,
      [PUBLISHER_KEY_SETTING]: publisherKey,
    });
    expect(withKey).toEqual(expected);
    expect(JSON.stringify(withKey)).not.toContain(publisherKey);
  });

  test('production without MR_STEAM_APP_ID loads with no steam member, with or without a publisher key acs-8.5', () => {
    const publisherKey = 'INTERNAL_SECRET_production_publisher';
    const bare = loadConfig(PRODUCTION);
    expect('steam' in bare).toBe(false);
    const withKey = loadConfig({ ...PRODUCTION, [PUBLISHER_KEY_SETTING]: publisherKey });
    expect('steam' in withKey).toBe(false);
    expect(withKey).toEqual(bare);
    expect(JSON.stringify(withKey)).not.toContain(publisherKey);
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
        ' MR_STEAM_PUBLISHER_KEY',
        'MR_STEAM_PUBLISHER_KEY ',
      ].map((name) => [profile, base, name] as const),
    ),
  )('%s refuses a Steam key setting %s, named as written', (_p, base, name) => {
    expectRefused({ ...base, [name]: '/run/secrets/steam' }, name);
  });
});

describe('a refusal never carries a secret value', () => {
  test('the Steam publisher key value is not in the refusal', () => {
    const marker = 'INTERNAL_SECRET_publisher_key';
    const error = expectRefused(
      { ...LOCAL, MR_STEAM_PUBLISHER_KEY: marker },
      'MR_STEAM_PUBLISHER_KEY',
    );
    expectNoLeak(error, marker);
  });

  test('the Steam publisher key file value is not in the refusal', () => {
    const marker = 'INTERNAL_SECRET_publisher_key_file';
    const error = expectRefused(
      { ...HOSTED, MR_STEAM_PUBLISHER_KEY_FILE: marker },
      'MR_STEAM_PUBLISHER_KEY_FILE',
    );
    expectNoLeak(error, marker);
  });

  test('the password in a userinfo issuer is not in the refusal', () => {
    const marker = 'INTERNAL_SECRET_issuer_password';
    const error = expectRefused(
      { ...PRODUCTION, MR_ACCOUNT_ISSUER: `https://user:${marker}@accounts.example.com` },
      'MR_ACCOUNT_ISSUER',
    );
    expectNoLeak(error, marker);
  });

  test('a refused issuer path is not in the refusal', () => {
    const marker = 'INTERNAL_SECRET_issuer_path';
    const error = expectRefused(
      { ...PRODUCTION, MR_ACCOUNT_ISSUER: `https://accounts.example.com/${marker}` },
      'MR_ACCOUNT_ISSUER',
    );
    expectNoLeak(error, marker);
  });

  test('the value of an unknown setting is not in the refusal', () => {
    const marker = 'INTERNAL_SECRET_unknown_setting';
    const error = expectRefused({ ...LOCAL, MR_ACCOUNT_TOKEN: marker }, 'MR_ACCOUNT_TOKEN');
    expectNoLeak(error, marker);
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
    ['an absolute path with a NUL character inside it', `${join(base, 'a')}${NUL}b`],
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

describe('the Steam settings', () => {
  const devProfiles: ReadonlyArray<readonly [string, Env]> = [
    ['local-dev', LOCAL],
    ['hosted-dev', HOSTED],
  ];
  const everyProfile: ReadonlyArray<readonly [string, Env]> = [
    ...devProfiles,
    ['production', PRODUCTION],
  ];
  const DEV_WEB_KEY = 'INTERNAL_SECRET_dev_web_key';
  const DEV_PUBLISHER_KEY = 'INTERNAL_SECRET_dev_publisher_key';

  test('the dev app id is Valve development app 480 acs-8.5', () => {
    expect(STEAM_DEV_APP_ID).toBe(480);
  });

  const unknownNames = [
    'mr_steam_publisher_key',
    'mr_steam_web_api_key',
    'Mr_Steam_App_Id',
    ' MR_STEAM_APP_ID',
    'MR_STEAM_APP_ID ',
    'MR_STEAM_PUBLISHER_KEY_FILE',
    'MR_STEAM_APPID',
    'MR_STEAM_KEY',
    'MR_STEAM_',
    `MR_${LONG_S}TEAM_APP_ID`,
  ];

  test.each(
    everyProfile.flatMap(([profile, base]) =>
      unknownNames.map((name) => [profile, JSON.stringify(name), base, name] as const),
    ),
  )('%s refuses the setting %s, named as written, even holding a value its real name takes acs-8.5', (_p, _shown, base, name) => {
    expectRefused({ ...base, [name]: '480' }, name);
  });

  test('the value of an unknown Steam setting is not in the refusal acs-8.5', () => {
    const marker = 'INTERNAL_SECRET_unknown_steam_setting';
    expectNoLeak(expectRefused({ ...LOCAL, MR_STEAM_APIKEY: marker }, 'MR_STEAM_APIKEY'), marker);
  });

  test('an unknown Steam name is refused before the profile is read acs-8.5', () => {
    expectRefused({ MR_STEAM_APPID: '480' }, 'MR_STEAM_APPID');
    expectRefused({ MR_ACCOUNT_PROFILE: 'staging', MR_STEAM_APPID: '480' }, 'MR_STEAM_APPID');
  });

  test('an unknown Steam name beside an unknown account name: one of the two is named acs-8.5', () => {
    const error = refusalOf({ ...LOCAL, MR_ACCOUNT_BOGUS: 'x', MR_STEAM_APPID: '480' });
    expect(['MR_ACCOUNT_BOGUS', 'MR_STEAM_APPID']).toContain(error.setting);
    expect(error.message).toContain(error.setting);
  });

  test.each(
    devProfiles,
  )('%s refuses a publisher key whatever else is set, never showing a key acs-8.5', (_p, base) => {
    const envs: Env[] = [
      { ...base, [PUBLISHER_KEY_SETTING]: DEV_PUBLISHER_KEY },
      { ...base, MR_STEAM_APP_ID: '480', [PUBLISHER_KEY_SETTING]: DEV_PUBLISHER_KEY },
      {
        ...base,
        MR_STEAM_APP_ID: '480',
        [WEB_KEY_SETTING]: DEV_WEB_KEY,
        [PUBLISHER_KEY_SETTING]: DEV_PUBLISHER_KEY,
      },
      { ...base, MR_STEAM_APP_ID: '481', [PUBLISHER_KEY_SETTING]: DEV_PUBLISHER_KEY },
      { ...base, [WEB_KEY_SETTING]: DEV_WEB_KEY, [PUBLISHER_KEY_SETTING]: DEV_PUBLISHER_KEY },
    ];
    for (const env of envs) {
      const error = expectRefused(env, 'MR_STEAM_PUBLISHER_KEY');
      expectNoLeak(error, DEV_PUBLISHER_KEY);
      expectNoLeak(error, DEV_WEB_KEY);
    }
  });

  const devAppIds = [
    '0480',
    ' 480',
    '480 ',
    '481',
    '479',
    '4800',
    '48',
    '4.8e2',
    '0x1e0',
    '+480',
    '-480',
    '480.0',
    '0',
    '1234567',
    ARABIC_INDIC_480,
  ];

  test.each(
    devProfiles.flatMap(([profile, base]) =>
      devAppIds.map((value) => [profile, JSON.stringify(value), base, value] as const),
    ),
  )('%s refuses MR_STEAM_APP_ID %s, which is not exactly 480 acs-8.5', (_p, _shown, base, value) => {
    expectRefused({ ...base, MR_STEAM_APP_ID: value }, 'MR_STEAM_APP_ID');
  });

  test.each(devProfiles)('%s does not show a refused app id near 480 acs-8.5', (_p, base) => {
    for (const value of [' 480', '481', '0480']) {
      expectNoLeak(expectRefused({ ...base, MR_STEAM_APP_ID: value }, 'MR_STEAM_APP_ID'), value);
    }
  });

  test.each(
    devProfiles,
  )('%s does not show a refused app id, and checks it before the web key acs-8.5', (_p, base) => {
    expectNoLeak(
      expectRefused({ ...base, MR_STEAM_APP_ID: '1234567' }, 'MR_STEAM_APP_ID'),
      '1234567',
    );
    const error = expectRefused(
      { ...base, MR_STEAM_APP_ID: '1234567', [WEB_KEY_SETTING]: DEV_WEB_KEY },
      'MR_STEAM_APP_ID',
    );
    expectNoLeak(error, DEV_WEB_KEY);
    expectNoLeak(error, '1234567');
  });

  test.each(
    devProfiles,
  )('%s refuses a web key without the app id, never showing it acs-8.5', (_p, base) => {
    for (const env of [
      { ...base, [WEB_KEY_SETTING]: DEV_WEB_KEY },
      { ...base, MR_STEAM_APP_ID: '', [WEB_KEY_SETTING]: DEV_WEB_KEY },
      { ...base, MR_STEAM_APP_ID: undefined, [WEB_KEY_SETTING]: DEV_WEB_KEY },
    ]) {
      expectNoLeak(expectRefused(env, 'MR_STEAM_WEB_API_KEY'), DEV_WEB_KEY);
    }
  });

  test.each(
    devProfiles,
  )('%s checks its Steam settings before MR_ACCOUNT_ISSUER acs-8.5', (_p, base) => {
    const withIssuer = { ...base, MR_ACCOUNT_ISSUER: PROD_ISSUER };
    expectRefused(
      { ...withIssuer, [PUBLISHER_KEY_SETTING]: DEV_PUBLISHER_KEY },
      'MR_STEAM_PUBLISHER_KEY',
    );
    expectRefused({ ...withIssuer, MR_STEAM_APP_ID: '481' }, 'MR_STEAM_APP_ID');
    expectRefused({ ...withIssuer, [WEB_KEY_SETTING]: DEV_WEB_KEY }, 'MR_STEAM_WEB_API_KEY');
  });

  test.each(
    devProfiles,
  )('%s with MR_STEAM_APP_ID 480 loads Steam beside the password form, with or without a web key acs-8.5', (_p, base) => {
    const expected = { ...loadConfig(base), steam: { appId: 480 } };
    const without = loadConfig({ ...base, MR_STEAM_APP_ID: '480' });
    expect(without).toEqual(expected);
    expect(without.signIn).toBe('dev-password');
    expect(without.steam).toEqual({ appId: STEAM_DEV_APP_ID });
    const withKey = loadConfig({ ...base, MR_STEAM_APP_ID: '480', [WEB_KEY_SETTING]: DEV_WEB_KEY });
    expect(withKey).toEqual(expected);
    expect(withKey.signIn).toBe('dev-password');
    expect(JSON.stringify(withKey)).not.toContain(DEV_WEB_KEY);
  });

  test.each(everyProfile)('%s with no Steam setting has no steam member acs-8.5', (_p, base) => {
    expect('steam' in loadConfig(base)).toBe(false);
  });

  test.each(
    everyProfile,
  )('%s takes empty and undefined Steam settings as unset acs-8.5', (_p, base) => {
    for (const env of [
      { ...base, MR_STEAM_APP_ID: '', [WEB_KEY_SETTING]: undefined, [PUBLISHER_KEY_SETTING]: '' },
      {
        ...base,
        MR_STEAM_APP_ID: undefined,
        [WEB_KEY_SETTING]: '',
        [PUBLISHER_KEY_SETTING]: undefined,
      },
    ]) {
      const config = loadConfig(env);
      expect(config).toEqual(loadConfig(base));
      expect('steam' in config).toBe(false);
    }
  });

  test('a polluted prototype supplies no Steam setting and faults none acs-8.5', () => {
    const polluted: Record<string, string> = {
      MR_STEAM_APP_ID: '480',
      [WEB_KEY_SETTING]: 'x',
      [PUBLISHER_KEY_SETTING]: 'x',
      MR_STEAM_APPID: '480',
    };
    for (const [name, value] of Object.entries(polluted)) {
      Object.defineProperty(Object.prototype, name, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    let local: Config | undefined;
    let production: Config | undefined;
    let error: unknown;
    let webKeyAlone: unknown;
    try {
      local = loadConfig({ ...LOCAL });
      production = loadConfig({ ...PRODUCTION });
      webKeyAlone = refusalOf({ ...LOCAL, [WEB_KEY_SETTING]: 'k' });
    } catch (caught) {
      error = caught;
    } finally {
      for (const name of Object.keys(polluted)) Reflect.deleteProperty(Object.prototype, name);
    }
    expect(error).toBeUndefined();
    expect(local).toEqual(loadConfig(LOCAL));
    expect('steam' in local!).toBe(false);
    expect(production).toEqual(loadConfig(PRODUCTION));
    expect('steam' in production!).toBe(false);
    expect((webKeyAlone as ConfigError).setting).toBe('MR_STEAM_WEB_API_KEY');
  });

  describe('startServer with Steam configured', () => {
    let root = '';
    const servers: RunningServer[] = [];

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'acs8-'));
    });

    afterEach(async () => {
      for (const server of servers.splice(0)) await server.close();
      rmSync(root, { recursive: true, force: true });
    });

    function discoveryStatus(port: number): Promise<number> {
      return new Promise((resolveStatus, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/.well-known/openid-configuration',
            headers: { host: 'localhost:4455' },
            agent: false,
          },
          (res) => {
            res.resume();
            res.on('end', () => {
              resolveStatus(res.statusCode ?? 0);
            });
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end();
      });
    }

    test.each([
      ['with a web key', true],
      ['without a web key', false],
    ])('local-dev with MR_STEAM_APP_ID 480 starts %s, reports steam, keeps the password sign-in and serves discovery acs-8.5', async (_name, withKey) => {
      const lines: string[] = [];
      const env: Env = {
        MR_ACCOUNT_PROFILE: 'local-dev',
        MR_ACCOUNT_DATA_DIR: join(root, 'data'),
        MR_ACCOUNT_PORT: '0',
        MR_STEAM_APP_ID: '480',
        ...(withKey ? { [WEB_KEY_SETTING]: DEV_WEB_KEY } : {}),
      };
      const server = await startServer(env, (line) => {
        lines.push(line);
      });
      servers.push(server);
      expect(server.config.steam).toEqual({ appId: 480 });
      expect(server.config.signIn).toBe('dev-password');
      expect(await discoveryStatus(Number(new URL(server.url).port))).toBe(200);
      for (const line of lines) expect(line).not.toContain(DEV_WEB_KEY);
    });

    test('local-dev with MR_STEAM_APP_ID 481 does not start, names the setting and leaves the data directory absent acs-8.5', async () => {
      const dataDir = join(root, 'data');
      let error: unknown;
      try {
        servers.push(
          await startServer(
            {
              MR_ACCOUNT_PROFILE: 'local-dev',
              MR_ACCOUNT_DATA_DIR: dataDir,
              MR_ACCOUNT_PORT: '0',
              MR_STEAM_APP_ID: '481',
            },
            () => undefined,
          ),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).setting).toBe('MR_STEAM_APP_ID');
      expect((error as ConfigError).message).toContain('MR_STEAM_APP_ID');
      expect(existsSync(dataDir)).toBe(false);
    });
  });
});

const HANDLE_SETTING = 'MR_ACCOUNT_HANDLE_KEY_FILE';
const PROXY_SETTING = 'MR_ACCOUNT_TRUSTED_PROXY';
const EVERY_PROFILE: ReadonlyArray<readonly [string, Env]> = [
  ['local-dev', LOCAL],
  ['hosted-dev', HOSTED],
  ['production', PRODUCTION],
];

describe('MR_ACCOUNT_HANDLE_KEY_FILE', () => {
  const base = resolve('/srv/handles');
  const badPaths: ReadonlyArray<readonly [string, string]> = [
    ['a relative path', join('relative', 'handle-keys.json')],
    ['a dot-relative path', `.${sep}handle-keys.json`],
    ['a path with ..', `${base}${sep}..${sep}handle-keys.json`],
    ['a path with .', `${base}${sep}.${sep}handle-keys.json`],
    ['a trailing separator', `${base}${sep}`],
    ['a doubled separator', `${base}${sep}${sep}handle-keys.json`],
    ['the filesystem root', resolve('/')],
    ['an absolute path with a NUL character inside it', `${join(base, 'a')}${NUL}b`],
  ];

  test('local-dev keeps its handle key file beside its login key file, and makes it when missing', () => {
    const config = loadConfig(LOCAL);
    expect(config.keys).toEqual({
      kind: 'file',
      path: join(LOCAL_DEV_DATA_DIR, 'keys.json'),
      generateIfMissing: true,
    });
    expect(config.handleKeys).toEqual({
      path: join(LOCAL_DEV_DATA_DIR, HANDLE_KEY_FILE_NAME),
      generateIfMissing: true,
    });
  });

  test.each([
    ['local-dev', LOCAL, true],
    ['hosted-dev', HOSTED, false],
  ] as const)('%s with its login key file elsewhere keeps the handle key file beside that file', (_p, env, generateIfMissing) => {
    const keyFile = resolve('/srv/keys/signing.json');
    const config = loadConfig({
      ...env,
      MR_ACCOUNT_DATA_DIR: resolve('/srv/data'),
      MR_ACCOUNT_KEY_FILE: keyFile,
    });
    expect(config.handleKeys).toEqual({
      path: join(dirname(keyFile), HANDLE_KEY_FILE_NAME),
      generateIfMissing,
    });
  });

  test('hosted-dev unset keeps the file beside its key file and never makes it', () => {
    expect(loadConfig(HOSTED).handleKeys).toEqual({
      path: join(HOSTED_DATA_DIR, HANDLE_KEY_FILE_NAME),
      generateIfMissing: false,
    });
  });

  test.each([
    ['local-dev', LOCAL, true],
    ['hosted-dev', HOSTED, false],
    ['production', PRODUCTION, false],
  ] as const)('%s takes a set handle key file exactly as written', (_p, env, generateIfMissing) => {
    const path = resolve('/srv/elsewhere/handles.json');
    expect(loadConfig({ ...env, MR_ACCOUNT_HANDLE_KEY_FILE: path }).handleKeys).toEqual({
      path,
      generateIfMissing,
    });
  });

  test.each([
    ['unset', undefined],
    ['empty', ''],
  ])('production with the handle key file %s does not start, naming that setting acs-14.9', (_name, value) => {
    expectRefused({ ...PRODUCTION, MR_ACCOUNT_HANDLE_KEY_FILE: value }, HANDLE_SETTING);
  });

  test('production with no handle key setting at all is refused for that setting acs-14.9', () => {
    const env: Env = {
      MR_ACCOUNT_PROFILE: 'production',
      MR_ACCOUNT_ISSUER: PROD_ISSUER,
      MR_ACCOUNT_DATA_DIR: PROD_DATA_DIR,
    };
    expectRefused(env, HANDLE_SETTING);
    expectRefused({ ...env, MR_STEAM_APP_ID: '1234567' }, HANDLE_SETTING);
    expectRefused({ ...env, MR_ACCOUNT_SIGN_IN: 'steam' }, HANDLE_SETTING);
  });

  test('production checks the handle key file after the issuer and every earlier setting acs-14.9', () => {
    const withoutHandle: Env = { ...PRODUCTION, MR_ACCOUNT_HANDLE_KEY_FILE: undefined };
    expectRefused({ ...withoutHandle, MR_ACCOUNT_ISSUER: undefined }, 'MR_ACCOUNT_ISSUER');
    expectRefused(
      { ...withoutHandle, MR_ACCOUNT_ISSUER: 'http://accounts.example.com' },
      'MR_ACCOUNT_ISSUER',
    );
    expectRefused(
      { ...withoutHandle, MR_ACCOUNT_KEY_FILE: join(PROD_DATA_DIR, 'keys.json') },
      'MR_ACCOUNT_KEY_FILE',
    );
    expectRefused({ ...withoutHandle, MR_STEAM_APP_ID: '0' }, 'MR_STEAM_APP_ID');
    expectRefused({ ...withoutHandle, [WEB_KEY_SETTING]: 'x' }, 'MR_STEAM_WEB_API_KEY');
    expectRefused({ ...withoutHandle, MR_ACCOUNT_DATA_DIR: undefined }, 'MR_ACCOUNT_DATA_DIR');
    expectRefused(
      { ...withoutHandle, MR_ACCOUNT_DATA_DIR: join('relative', 'dir') },
      'MR_ACCOUNT_DATA_DIR',
    );
  });

  test.each(
    badPaths,
  )('production refuses %s as the handle key file, naming the setting acs-14.9', (_kind, value) => {
    expectRefused({ ...PRODUCTION, MR_ACCOUNT_HANDLE_KEY_FILE: value }, HANDLE_SETTING);
  });

  test.each(badPaths)('the dev profiles refuse %s as the handle key file', (_kind, value) => {
    expectRefused({ ...LOCAL, MR_ACCOUNT_HANDLE_KEY_FILE: value }, HANDLE_SETTING);
    expectRefused({ ...HOSTED, MR_ACCOUNT_HANDLE_KEY_FILE: value }, HANDLE_SETTING);
  });

  test('a refused handle key file is never repeated in the refusal acs-14.9', () => {
    const marker = 'INTERNAL_MARKER_handle_path';
    const values = [
      join('relative', marker),
      `${base}${sep}..${sep}${marker}`,
      `${base}${sep}${sep}${marker}`,
      `${base}${sep}${marker}${sep}`,
    ];
    for (const value of values) {
      for (const env of [PRODUCTION, LOCAL, HOSTED]) {
        expectNoLeak(
          expectRefused({ ...env, MR_ACCOUNT_HANDLE_KEY_FILE: value }, HANDLE_SETTING),
          marker,
        );
      }
    }
  });

  test('an empty handle key file is unset on the dev profiles', () => {
    expect(loadConfig({ ...LOCAL, MR_ACCOUNT_HANDLE_KEY_FILE: '' })).toEqual(loadConfig(LOCAL));
    expect(loadConfig({ ...HOSTED, MR_ACCOUNT_HANDLE_KEY_FILE: '' })).toEqual(loadConfig(HOSTED));
  });

  test.each([
    'MR_ACCOUNT_HANDLE_KEYFILE',
    'MR_ACCOUNT_HANDLE_KEYS_FILE',
    'mr_account_handle_key_file',
    'MR_ACCOUNT_HANDLE_KEY_FILE ',
    'MR_ACCOUNT_TRUSTED_PROXIES',
    'MR_ACCOUNT_TRUSTEDPROXY',
    'mr_account_trusted_proxy',
  ])('a misspelling %j is refused under its own name', (name) => {
    for (const [, env] of EVERY_PROFILE) {
      expectRefused({ ...env, [name]: PROD_HANDLE_KEY_FILE }, name);
    }
  });
});

describe('MR_ACCOUNT_TRUSTED_PROXY', () => {
  const TAB = String.fromCharCode(9);
  // Arabic-Indic digit four.
  const ARABIC_INDIC_4 = String.fromCharCode(0x0664);

  test.each(EVERY_PROFILE)('%s unset or empty trusts no proxy', (_p, env) => {
    expect(loadConfig(env).trustedProxies).toEqual([]);
    expect(loadConfig({ ...env, MR_ACCOUNT_TRUSTED_PROXY: '' }).trustedProxies).toEqual([]);
    expect(loadConfig({ ...env, MR_ACCOUNT_TRUSTED_PROXY: '' })).toEqual(loadConfig(env));
  });

  test.each(EVERY_PROFILE)('%s loads a list of blocks and addresses in order', (_p, env) => {
    const config = loadConfig({
      ...env,
      MR_ACCOUNT_TRUSTED_PROXY: '10.0.0.0/8,192.0.2.7,fc00::/7',
    });
    expect(config.trustedProxies).toEqual([
      { address: '10.0.0.0', prefix: 8, family: 'ipv4' },
      { address: '192.0.2.7', prefix: 32, family: 'ipv4' },
      { address: 'fc00::', prefix: 7, family: 'ipv6' },
    ]);
  });

  test.each([
    ['an IPv6 address', '2001:db8::1', [{ address: '2001:db8::1', prefix: 128, family: 'ipv6' }]],
    ['every IPv4 address', '0.0.0.0/0', [{ address: '0.0.0.0', prefix: 0, family: 'ipv4' }]],
    ['every IPv6 address', '::/0', [{ address: '::', prefix: 0, family: 'ipv6' }]],
    ['an IPv4 /32', '192.0.2.0/32', [{ address: '192.0.2.0', prefix: 32, family: 'ipv4' }]],
    ['an IPv6 /128', 'fc00::/128', [{ address: 'fc00::', prefix: 128, family: 'ipv6' }]],
    [
      'the private ranges',
      '172.16.0.0/12,192.168.0.0/16',
      [
        { address: '172.16.0.0', prefix: 12, family: 'ipv4' },
        { address: '192.168.0.0', prefix: 16, family: 'ipv4' },
      ],
    ],
  ] as const)('%s loads', (_name, value, expected) => {
    expect(loadConfig({ ...LOCAL, MR_ACCOUNT_TRUSTED_PROXY: value }).trustedProxies).toEqual(
      expected,
    );
  });

  test('sixteen entries load, and a seventeenth is refused', () => {
    const entries = Array.from({ length: 17 }, (_, i) => `192.0.2.${i}`);
    const sixteen = loadConfig({
      ...LOCAL,
      MR_ACCOUNT_TRUSTED_PROXY: entries.slice(0, 16).join(','),
    });
    expect(sixteen.trustedProxies).toHaveLength(16);
    expect(sixteen.trustedProxies[15]).toEqual({
      address: '192.0.2.15',
      prefix: 32,
      family: 'ipv4',
    });
    expectRefused({ ...LOCAL, MR_ACCOUNT_TRUSTED_PROXY: entries.join(',') }, PROXY_SETTING);
  });

  const refused: ReadonlyArray<readonly [string, string]> = [
    ['a space alone', ' '],
    ['a leading space', ' 10.0.0.0/8'],
    ['a trailing space', '10.0.0.0/8 '],
    ['a space after a comma', '10.0.0.0/8, 192.0.2.7'],
    ['a tab', `10.0.0.0/8${TAB}`],
    ['an empty last entry', '10.0.0.0/8,'],
    ['an empty first entry', ',10.0.0.0/8'],
    ['an empty middle entry', '10.0.0.0/8,,192.0.2.7'],
    ['a semicolon separator', '10.0.0.0/8;192.0.2.7'],
    ['a host name', 'proxy.internal'],
    ['localhost', 'localhost'],
    ['a zone id', 'fe80::1%eth0'],
    ['a zone id on a block', 'fe80::%1/64'],
    ['a bracketed IPv6 address', '[2001:db8::1]'],
    ['an address with a port', '192.0.2.7:443'],
    ['an IPv4 address out of range', '256.0.0.1'],
    ['an IPv4 address of three parts', '10.0.0'],
    ['an IPv4 prefix of 33', '10.0.0.0/33'],
    ['an IPv6 prefix of 129', '2001:db8::/129'],
    ['a prefix with a leading zero', '10.0.0.0/08'],
    ['a prefix of two zeros', '10.0.0.0/00'],
    ['an empty prefix', '10.0.0.0/'],
    ['a prefix alone', '/8'],
    ['a negative prefix', '10.0.0.0/-1'],
    ['a prefix with a plus sign', '10.0.0.0/+8'],
    ['a hex prefix', '10.0.0.0/0x8'],
    ['an exponent prefix', '10.0.0.0/1e1'],
    ['a fractional prefix', '10.0.0.0/8.0'],
    ['two prefixes', '10.0.0.0/8/8'],
    ['a netmask in place of a prefix', '10.0.0.0/255.0.0.0'],
    ['a prefix in Arabic-Indic digits', `10.0.0.0/${ARABIC_INDIC_4}`],
    ['a good entry then a bad one', '10.0.0.0/8,proxy.internal'],
  ];

  test.each(
    EVERY_PROFILE.flatMap(([profile, env]) =>
      refused.map(([name, value]) => [profile, name, env, value] as const),
    ),
  )('%s refuses %s', (_p, _name, env, value) => {
    expectRefused({ ...env, MR_ACCOUNT_TRUSTED_PROXY: value }, PROXY_SETTING);
  });

  test('a refused list is never repeated in the refusal', () => {
    const marker = 'INTERNALMARKERproxyhost';
    for (const value of [`${marker}.example`, `10.0.0.0/8,${marker}`, `203.0.113.77/33`]) {
      for (const [, env] of EVERY_PROFILE) {
        const error = expectRefused({ ...env, MR_ACCOUNT_TRUSTED_PROXY: value }, PROXY_SETTING);
        expectNoLeak(error, marker);
        expectNoLeak(error, '203.0.113.77');
        expectNoLeak(error, value);
      }
    }
  });
});

describe('the handle key file is never another file of the service', () => {
  const MARKED_DIR = resolve('/srv/INTERNALMARKERdatadir');

  test.each([
    ['local-dev', LOCAL, LOCAL_DEV_DATA_DIR],
    ['hosted-dev', HOSTED, HOSTED_DATA_DIR],
  ] as const)('%s refuses the default login key file as the handle key file', (_p, env, dataDir) => {
    expectRefused(
      { ...env, MR_ACCOUNT_HANDLE_KEY_FILE: join(dataDir, 'keys.json') },
      HANDLE_SETTING,
    );
  });

  test.each([
    ['local-dev', LOCAL],
    ['hosted-dev', HOSTED],
  ] as const)('%s refuses a set login key file as the handle key file', (_p, env) => {
    const keyFile = resolve('/srv/keys/signing.json');
    expectRefused(
      { ...env, MR_ACCOUNT_KEY_FILE: keyFile, MR_ACCOUNT_HANDLE_KEY_FILE: keyFile },
      HANDLE_SETTING,
    );
  });

  test.each([
    ['local-dev', LOCAL, LOCAL_DEV_DATA_DIR],
    ['hosted-dev', HOSTED, HOSTED_DATA_DIR],
  ] as const)('%s refuses the database file as the handle key file', (_p, env, dataDir) => {
    expectRefused(
      { ...env, MR_ACCOUNT_HANDLE_KEY_FILE: join(dataDir, 'account.sqlite') },
      HANDLE_SETTING,
    );
  });

  test('production refuses its database file as the handle key file acs-14.9', () => {
    expectRefused(
      { ...PRODUCTION, MR_ACCOUNT_HANDLE_KEY_FILE: join(PROD_DATA_DIR, 'account.sqlite') },
      HANDLE_SETTING,
    );
  });

  test('production, which holds no login key file, takes keys.json in its data directory as the handle key file acs-14.9', () => {
    const path = join(PROD_DATA_DIR, 'keys.json');
    expect(loadConfig({ ...PRODUCTION, MR_ACCOUNT_HANDLE_KEY_FILE: path }).handleKeys).toEqual({
      path,
      generateIfMissing: false,
    });
  });

  test('a handle key file refused as another file of the service is never repeated', () => {
    const rows: Env[] = [
      {
        ...LOCAL,
        MR_ACCOUNT_DATA_DIR: MARKED_DIR,
        MR_ACCOUNT_HANDLE_KEY_FILE: join(MARKED_DIR, 'keys.json'),
      },
      {
        ...LOCAL,
        MR_ACCOUNT_DATA_DIR: MARKED_DIR,
        MR_ACCOUNT_HANDLE_KEY_FILE: join(MARKED_DIR, 'account.sqlite'),
      },
      {
        ...HOSTED,
        MR_ACCOUNT_DATA_DIR: MARKED_DIR,
        MR_ACCOUNT_HANDLE_KEY_FILE: join(MARKED_DIR, 'keys.json'),
      },
      {
        ...PRODUCTION,
        MR_ACCOUNT_DATA_DIR: MARKED_DIR,
        MR_ACCOUNT_HANDLE_KEY_FILE: join(MARKED_DIR, 'account.sqlite'),
      },
    ];
    for (const env of rows) {
      expectNoLeak(expectRefused(env, HANDLE_SETTING), 'INTERNALMARKERdatadir');
    }
  });

  test.each([
    ['local-dev', LOCAL],
    ['hosted-dev', HOSTED],
  ] as const)('%s takes a handle key file beside the login key file and the database', (_p, env) => {
    const dataDir = resolve('/srv/data');
    const path = join(dataDir, HANDLE_KEY_FILE_NAME);
    expect(
      loadConfig({ ...env, MR_ACCOUNT_DATA_DIR: dataDir, MR_ACCOUNT_HANDLE_KEY_FILE: path })
        .handleKeys.path,
    ).toBe(path);
  });
});

describe('MR_ACCOUNT_TRUSTED_PROXY refuses an IPv4-mapped IPv6 entry', () => {
  const MAPPED: ReadonlyArray<readonly [string, string]> = [
    ['a mapped address', '::ffff:192.0.2.7'],
    ['a mapped block', '::ffff:10.0.0.0/104'],
    ['a mapped address in hex and upper case', '::FFFF:a00:1'],
    ['a mapped address written in full', '0:0:0:0:0:ffff:c000:207'],
    ['the whole mapped block', '::ffff:0:0/96'],
    ['a good entry then a mapped one', '10.0.0.0/8,::ffff:192.0.2.7'],
  ];

  test.each(
    EVERY_PROFILE.flatMap(([profile, env]) =>
      MAPPED.map(([name, value]) => [profile, name, env, value] as const),
    ),
  )('%s refuses %s', (_p, _name, env, value) => {
    expectRefused({ ...env, MR_ACCOUNT_TRUSTED_PROXY: value }, PROXY_SETTING);
  });

  test('a refused mapped entry is never repeated in the refusal', () => {
    for (const [, env] of EVERY_PROFILE) {
      const error = expectRefused(
        { ...env, MR_ACCOUNT_TRUSTED_PROXY: '::ffff:203.0.113.77' },
        PROXY_SETTING,
      );
      expectNoLeak(error, '203.0.113.77');
    }
  });
});
