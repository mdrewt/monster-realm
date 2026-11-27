import { isIP } from 'node:net';
import { dirname, join, parse, resolve } from 'node:path';

export type Profile = 'local-dev' | 'hosted-dev' | 'production';
export type SignInMethod = 'dev-password' | 'steam';
export type KeySource =
  | { readonly kind: 'file'; readonly path: string; readonly generateIfMissing: boolean }
  | { readonly kind: 'external' };

/** The Steam app a profile checks players against. */
export interface SteamConfig {
  readonly appId: number;
}

/** Where a profile's handle key file is, and whether the profile makes it when it is absent. */
export interface HandleKeySource {
  readonly path: string;
  readonly generateIfMissing: boolean;
}

/** An address (`prefix` 32 or 128) or a CIDR block. */
export interface AddressBlock {
  readonly address: string;
  readonly prefix: number;
  readonly family: 'ipv4' | 'ipv6';
}

export interface Config {
  readonly profile: Profile;
  readonly issuer: string;
  readonly listen: { readonly host: string; readonly port: number };
  readonly dataDir: string;
  readonly databasePath: string;
  readonly keys: KeySource;
  readonly signIn: SignInMethod;
  /**
   * Present when `MR_STEAM_APP_ID` is set: Steam is configured, and this is the app a Steam
   * sign-in checks a player against. A dev profile keeps its own `signIn` beside it. No Steam key
   * is held here: `steam/webApi.ts` reads it.
   */
  readonly steam?: SteamConfig;
  readonly handleKeys: HandleKeySource;
  /**
   * The reverse proxies in front of the service: a request from one of them has the source
   * address that proxy wrote, and any other request has its socket's.
   */
  readonly trustedProxies: readonly AddressBlock[];
}

export const LOCAL_DEV_ISSUER = 'http://localhost:4455';
export const HOSTED_DEV_ISSUER = 'https://auth.monster-realm.spookyowltech.com';
/** Where the local-dev profile keeps its database and keys: `account-service/.data`, ignored by git. */
export const LOCAL_DEV_DATA_DIR = resolve(import.meta.dirname, '..', '.data');
/**
 * Valve's development app (Spacewar), the only app a dev profile checks Steam as. Every Steam
 * account can run it, so it proves a sign-in and never ownership of the game.
 */
export const STEAM_DEV_APP_ID = 480;
/** The handle key file's name where a dev profile keeps it by default: beside its login key file. */
export const HANDLE_KEY_FILE_NAME = 'handle-keys.json';
/** A Steam app id is an unsigned 32-bit number. */
export const MAX_STEAM_APP_ID = 0xffff_ffff;

/**
 * A setting the service refuses to start with. `setting` is the env name at fault. The message
 * names it and the rule it broke, and never repeats the setting's value: a value may be a secret.
 */
export class ConfigError extends Error {
  readonly setting: string;

  constructor(setting: string, problem: string) {
    super(`${setting}: ${problem}`);
    this.name = 'ConfigError';
    this.setting = setting;
  }
}

const PROFILES: readonly Profile[] = ['local-dev', 'hosted-dev', 'production'];
const SETTINGS: ReadonlySet<string> = new Set([
  'MR_ACCOUNT_PROFILE',
  'MR_ACCOUNT_ISSUER',
  'MR_ACCOUNT_SIGN_IN',
  'MR_ACCOUNT_DATA_DIR',
  'MR_ACCOUNT_KEY_FILE',
  'MR_ACCOUNT_HANDLE_KEY_FILE',
  'MR_ACCOUNT_TRUSTED_PROXY',
  'MR_ACCOUNT_HOST',
  'MR_ACCOUNT_PORT',
  'MR_STEAM_APP_ID',
  'MR_STEAM_WEB_API_KEY',
  'MR_STEAM_PUBLISHER_KEY',
]);
const SETTING_PREFIXES = ['MR_ACCOUNT_', 'MR_STEAM_'];
const APP_ID = /^[1-9]\d{0,9}$/;
const DEV_HOSTNAMES = [LOCAL_DEV_ISSUER, HOSTED_DEV_ISSUER].map(
  (issuer) => new URL(issuer).hostname,
);
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PORT = /^(0|[1-9]\d{0,4})$/;
const HANDLE_KEY_FILE_SETTING = 'MR_ACCOUNT_HANDLE_KEY_FILE';
const TRUSTED_PROXY_SETTING = 'MR_ACCOUNT_TRUSTED_PROXY';
const MAX_TRUSTED_PROXIES = 16;
const PREFIX_LENGTH = /^(0|[1-9]\d{0,2})$/;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4455;

/**
 * Reads the service's settings from an env record and returns the profile's configuration, or
 * throws a `ConfigError`. A value that is `undefined` or empty is unset; a set value is taken as
 * written. Only the record's own entries are read.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const set = new Map<string, string>();
  for (const name of Object.keys(env)) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') set.set(name, value);
  }

  // A misspelt or wrong-case setting is refused: it must never fall back to a default, and a
  // Steam key under another spelling must never be taken for "no key was given".
  for (const name of set.keys()) {
    const folded = name.trim().toUpperCase();
    if (SETTING_PREFIXES.some((prefix) => folded.startsWith(prefix)) && !SETTINGS.has(name)) {
      throw new ConfigError(name, 'is not a setting of the account service');
    }
  }

  const profile = set.get('MR_ACCOUNT_PROFILE');
  if (!isProfile(profile)) {
    throw new ConfigError('MR_ACCOUNT_PROFILE', `must be one of ${PROFILES.join(', ')}`);
  }

  const listen = { host: listenHost(set), port: listenPort(set) };

  if (profile === 'production') {
    if (set.has('MR_ACCOUNT_KEY_FILE')) {
      throw new ConfigError(
        'MR_ACCOUNT_KEY_FILE',
        'a key file is a dev setting; the production profile signs through an external signer',
      );
    }
    const steam = productionSteam(set);
    const dataDir = requiredDataDir(set, profile);
    const issuer = productionIssuer(set);
    const signIn = signInMethod(set, profile, 'steam');
    // The profile has no key file to keep one beside, and none is ever made for it.
    const databasePath = join(dataDir, 'account.sqlite');
    const handleKeyFile = handleKeyFileSetting(set, [databasePath]);
    if (handleKeyFile === undefined) {
      throw new ConfigError(
        HANDLE_KEY_FILE_SETTING,
        'the production profile needs its handle key file',
      );
    }
    return {
      profile,
      issuer,
      listen,
      dataDir,
      databasePath,
      keys: { kind: 'external' },
      signIn,
      ...steam,
      handleKeys: { path: handleKeyFile, generateIfMissing: false },
      trustedProxies: trustedProxies(set),
    };
  }

  const steam = devSteam(set, profile);
  if (set.has('MR_ACCOUNT_ISSUER')) {
    throw new ConfigError(
      'MR_ACCOUNT_ISSUER',
      `the issuer of ${profile} is fixed and takes no setting`,
    );
  }
  const dataDir =
    profile === 'local-dev' && !set.has('MR_ACCOUNT_DATA_DIR')
      ? LOCAL_DEV_DATA_DIR
      : requiredDataDir(set, profile);
  const keyFile = pathSetting(set, 'MR_ACCOUNT_KEY_FILE') ?? join(dataDir, 'keys.json');
  const databasePath = join(dataDir, 'account.sqlite');
  return {
    profile,
    issuer: profile === 'local-dev' ? LOCAL_DEV_ISSUER : HOSTED_DEV_ISSUER,
    listen,
    dataDir,
    databasePath,
    keys: { kind: 'file', path: keyFile, generateIfMissing: profile === 'local-dev' },
    signIn: signInMethod(set, profile, 'dev-password'),
    ...steam,
    handleKeys: {
      path:
        handleKeyFileSetting(set, [keyFile, databasePath]) ??
        join(dirname(keyFile), HANDLE_KEY_FILE_NAME),
      generateIfMissing: profile === 'local-dev',
    },
    trustedProxies: trustedProxies(set),
  };
}

/**
 * The handle key file a profile is given, or undefined when it is given none. `others` are the
 * files the service keeps at paths of their own: a handle key file at one of them would be read
 * as that file, or written over it.
 */
function handleKeyFileSetting(
  set: ReadonlyMap<string, string>,
  others: readonly string[],
): string | undefined {
  const path = pathSetting(set, HANDLE_KEY_FILE_SETTING);
  if (path !== undefined && others.includes(path)) {
    throw new ConfigError(
      HANDLE_KEY_FILE_SETTING,
      'must be a file of its own, not the key file or the database',
    );
  }
  return path;
}

/**
 * The addresses and CIDR blocks of `MR_ACCOUNT_TRUSTED_PROXY`: a comma-separated list with no
 * space, each entry an IPv4 or IPv6 address, alone or followed by `/` and a prefix length.
 */
function trustedProxies(set: ReadonlyMap<string, string>): AddressBlock[] {
  const value = set.get(TRUSTED_PROXY_SETTING);
  if (value === undefined) return [];
  const entries = value.split(',');
  if (entries.length > MAX_TRUSTED_PROXIES) {
    throw new ConfigError(
      TRUSTED_PROXY_SETTING,
      `lists at most ${MAX_TRUSTED_PROXIES} addresses or blocks`,
    );
  }
  return entries.map((entry) => {
    const slash = entry.indexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    // An address with a zone names an interface of this machine, never a proxy.
    const version = address.includes('%') ? 0 : isIP(address);
    const bits = version === 4 ? 32 : 128;
    const length = slash === -1 ? String(bits) : entry.slice(slash + 1);
    const prefix = PREFIX_LENGTH.test(length) ? Number(length) : Number.NaN;
    if (version === 0 || !(prefix <= bits)) {
      throw new ConfigError(
        TRUSTED_PROXY_SETTING,
        'must be a comma-separated list of IP addresses and CIDR blocks, with no space',
      );
    }
    // A request from an IPv4 address is matched as IPv4 however its socket spells it, so an
    // IPv4-mapped block would match nothing and its proxy would pass for a caller.
    if (version === 6 && new URL(`http://[${address}]/`).hostname.startsWith('[::ffff:')) {
      throw new ConfigError(
        TRUSTED_PROXY_SETTING,
        'an IPv4 proxy is written as an IPv4 address or block, not as an IPv4-mapped IPv6 one',
      );
    }
    return { address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' };
  });
}

/**
 * A dev profile's Steam settings: App ID 480 alone, with an ordinary Web API key or none. The
 * publisher key opens every partner API of the game's own app, so a dev profile refuses it under
 * its own name, as it refuses any other app id: a dev deployment can never act for the game.
 */
function devSteam(
  set: ReadonlyMap<string, string>,
  profile: Profile,
): { readonly steam?: SteamConfig } {
  if (set.has('MR_STEAM_PUBLISHER_KEY')) {
    throw new ConfigError(
      'MR_STEAM_PUBLISHER_KEY',
      `the publisher key is a production setting; ${profile} takes none`,
    );
  }
  const appId = set.get('MR_STEAM_APP_ID');
  if (appId !== undefined && appId !== String(STEAM_DEV_APP_ID)) {
    throw new ConfigError(
      'MR_STEAM_APP_ID',
      `${profile} checks Steam only as Valve's development app, its id written with no other character`,
    );
  }
  if (appId === undefined) {
    if (set.has('MR_STEAM_WEB_API_KEY')) {
      throw new ConfigError(
        'MR_STEAM_WEB_API_KEY',
        `a Web API key is used only with MR_STEAM_APP_ID=${STEAM_DEV_APP_ID}`,
      );
    }
    return {};
  }
  return { steam: { appId: STEAM_DEV_APP_ID } };
}

/**
 * The production profile's Steam settings: the game's own app id, checked with the publisher key
 * (`MR_STEAM_PUBLISHER_KEY`, which only `steam/webApi.ts` reads). Never 480: nobody owns the
 * game by owning Valve's development app.
 */
function productionSteam(set: ReadonlyMap<string, string>): { readonly steam?: SteamConfig } {
  if (set.has('MR_STEAM_WEB_API_KEY')) {
    throw new ConfigError(
      'MR_STEAM_WEB_API_KEY',
      'the production profile checks Steam with its publisher key, MR_STEAM_PUBLISHER_KEY',
    );
  }
  const value = set.get('MR_STEAM_APP_ID');
  if (value === undefined) return {};
  const appId = APP_ID.test(value) ? Number(value) : Number.NaN;
  if (!(appId <= MAX_STEAM_APP_ID)) {
    throw new ConfigError(
      'MR_STEAM_APP_ID',
      `must be a Steam app id: a decimal number from 1 to ${MAX_STEAM_APP_ID}`,
    );
  }
  if (appId === STEAM_DEV_APP_ID) {
    throw new ConfigError(
      'MR_STEAM_APP_ID',
      "Valve's development app is never the game; the production profile takes the game's own app id",
    );
  }
  return { steam: { appId } };
}

function isProfile(value: string | undefined): value is Profile {
  return PROFILES.some((profile) => profile === value);
}

function signInMethod<M extends SignInMethod>(
  set: ReadonlyMap<string, string>,
  profile: Profile,
  only: M,
): M {
  const value = set.get('MR_ACCOUNT_SIGN_IN');
  if (value !== undefined && value !== only) {
    throw new ConfigError('MR_ACCOUNT_SIGN_IN', `${profile} signs players in with ${only} only`);
  }
  return only;
}

function requiredDataDir(set: ReadonlyMap<string, string>, profile: Profile): string {
  const dataDir = pathSetting(set, 'MR_ACCOUNT_DATA_DIR');
  if (dataDir === undefined) {
    throw new ConfigError(
      'MR_ACCOUNT_DATA_DIR',
      `${profile} needs the directory that holds its database`,
    );
  }
  return dataDir;
}

function pathSetting(set: ReadonlyMap<string, string>, name: string): string | undefined {
  const value = set.get(name);
  if (value === undefined) return undefined;
  if (resolve(value) !== value || value.includes('\0')) {
    throw new ConfigError(name, 'must be an absolute path with no ".", ".." or doubled separator');
  }
  if (parse(value).root === value) {
    throw new ConfigError(name, 'must not be the filesystem root');
  }
  return value;
}

function listenHost(set: ReadonlyMap<string, string>): string {
  const value = set.get('MR_ACCOUNT_HOST');
  if (value === undefined) return DEFAULT_HOST;
  if (isIP(value) === 0 && value !== 'localhost') {
    throw new ConfigError('MR_ACCOUNT_HOST', 'must be an IP address or localhost');
  }
  return value;
}

function listenPort(set: ReadonlyMap<string, string>): number {
  const value = set.get('MR_ACCOUNT_PORT');
  if (value === undefined) return DEFAULT_PORT;
  const port = PORT.test(value) ? Number(value) : Number.NaN;
  if (!(port <= 65535)) {
    throw new ConfigError('MR_ACCOUNT_PORT', 'must be a decimal port number from 0 to 65535');
  }
  return port;
}

/**
 * The production issuer is a bare `https:` origin in the form a token carries it, on a host that
 * is a DNS name and neither local nor a dev issuer's.
 */
function productionIssuer(set: ReadonlyMap<string, string>): string {
  const name = 'MR_ACCOUNT_ISSUER';
  const value = set.get(name);
  if (value === undefined) {
    throw new ConfigError(name, 'the production profile needs its issuer');
  }
  if (!URL.canParse(value)) {
    throw new ConfigError(name, 'must be an https origin, such as https://accounts.example.com');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new ConfigError(name, 'the production issuer must be https');
  }
  if (url.origin !== value) {
    throw new ConfigError(
      name,
      'must be a bare origin as a token carries it: lower case, no user, path, query, fragment, default port or trailing slash',
    );
  }
  const labels = url.hostname.split('.');
  const last = labels[labels.length - 1] ?? '';
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label)) || /^\d+$/.test(last)) {
    throw new ConfigError(
      name,
      'the host must be a DNS name of two or more labels, not an address',
    );
  }
  if (DEV_HOSTNAMES.some((dev) => url.hostname === dev || url.hostname.endsWith(`.${dev}`))) {
    throw new ConfigError(name, 'the production issuer must not be on a dev issuer or local host');
  }
  return value;
}
