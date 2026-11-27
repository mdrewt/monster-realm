import { type Config, ConfigError, MAX_STEAM_APP_ID, STEAM_DEV_APP_ID } from '../config.ts';
import { type AppOwnership, type OwnershipCheck, parseSteamId, type SteamId } from './ownership.ts';

/** Steam's public Web API host: what an ordinary Web API key may call. */
export const STEAM_PUBLIC_API = 'https://api.steampowered.com';
/** Steam's partner host: what a publisher key calls, from a secure server. */
export const STEAM_PARTNER_API = 'https://partner.steam-api.com';
export const STEAM_API_TIMEOUT_MS = 5_000;
/** The largest ticket `GetAuthTicketForWebApi` hands out. */
export const MAX_TICKET_BYTES = 2_560;
/** Steam's answers are a few hundred bytes; nothing longer is read. */
export const MAX_STEAM_ANSWER_BYTES = 65_536;

/**
 * Why Steam gave no answer: it took too long, could not be reached, answered with a status that
 * is not 200, or answered with a body this module cannot read. `unconfigured` is the one failure
 * that sends nothing: this profile holds no key for the call, or may not make it.
 */
export type SteamFailure = 'timeout' | 'unreachable' | 'status' | 'malformed' | 'unconfigured';

const MESSAGES: Readonly<Record<SteamFailure, string>> = {
  timeout: 'Steam did not answer in time',
  unreachable: 'Steam could not be reached',
  status: 'Steam answered with an error status',
  malformed: 'Steam answered with a body that could not be read',
  unconfigured: 'this profile cannot make that call to Steam',
};

/**
 * A failure to get an answer from Steam. It holds nothing Steam sent but the status number: the
 * message is fixed by the reason, and there is no cause.
 */
export class SteamApiError extends Error {
  readonly reason: SteamFailure;
  /** The HTTP status, when `reason` is `status`. */
  readonly status?: number;

  constructor(reason: SteamFailure, status?: number) {
    super(MESSAGES[reason]);
    this.name = 'SteamApiError';
    this.reason = reason;
    this.status = status;
  }
}

export type TicketCheck =
  | { readonly kind: 'authenticated'; readonly steamId: SteamId }
  /** Steam answered that this ticket does not authenticate, or the ticket is not hex. */
  | { readonly kind: 'rejected' }
  | { readonly kind: 'failed'; readonly error: SteamApiError };

export interface SteamWebApi {
  /**
   * Asks Steam whose ticket this is. `identity` is the string the ticket was made for; Steam
   * authenticates a ticket made for any identity when none is sent, so one is always sent.
   */
  authenticateTicket(ticket: string, identity: string): Promise<TicketCheck>;
  /** Asks Steam what licence a player holds for the app. Only `production` can ask. */
  checkAppOwnership(steamId: SteamId): Promise<OwnershipCheck>;
}

type Call = 'AuthenticateUserTicket' | 'CheckAppOwnership';
type Failed = Extract<TicketCheck, { readonly kind: 'failed' }>;

const PATHS: Readonly<Record<Call, string>> = {
  AuthenticateUserTicket: '/ISteamUserAuth/AuthenticateUserTicket/v1/',
  CheckAppOwnership: '/ISteamUser/CheckAppOwnership/v4/',
};
const KEY_HEADER = 'x-webapi-key';
const KEY = /^[\x21-\x7e]{1,256}$/;
const IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;
const TICKET = new RegExp(`^(?:[0-9a-fA-F]{2}){1,${MAX_TICKET_BYTES}}$`);
const DIGITS = /^[0-9]{1,20}$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The client of Steam's Web API for one profile, and the only reader of a Steam key: the
 * publisher key on `production`, which calls the partner host, and the optional ordinary key on
 * a dev profile, which calls the public host as the profile's app.
 *
 * The key travels in a request header and nowhere else, so no request target holds it. Each call
 * is one request with a timeout over the whole exchange, never retried. A refusal would not
 * change, and the partner host rate-limits an address that keeps sending refused requests; a
 * failure of Steam's is the player's to retry by signing in again, so an outage costs this
 * address one request per attempt and no more. A redirect is not followed, because a followed
 * request would carry the key to another host.
 *
 * A call resolves for everything Steam does. What Steam sent is parsed into the result types and
 * otherwise dropped: no error and no log line holds a body, a status text or a header. One line
 * is logged for each exchange that failed, naming the call, the reason and the status number; a
 * success and a refused ticket log nothing, so a caller cannot write lines at will.
 */
export function createSteamWebApi(options: {
  readonly config: Pick<Config, 'profile' | 'steam'>;
  /** The key is read from here, by this function and nothing else. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  /** Replaces the profile's Steam origin: a bare `https:` origin, or `http:` on this machine. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}): SteamWebApi {
  const { config, env, log } = options;
  const production = isProduction(config.profile);
  if (config.steam === undefined) {
    throw new ConfigError('MR_STEAM_APP_ID', 'Steam is not configured: the app id is not set');
  }
  const keySetting = production ? 'MR_STEAM_PUBLISHER_KEY' : 'MR_STEAM_WEB_API_KEY';
  const key = ownSetting(env, keySetting);
  if (key === undefined && production) {
    throw new ConfigError(keySetting, 'the production profile needs its publisher key');
  }
  if (key !== undefined && !KEY.test(key)) {
    throw new ConfigError(
      keySetting,
      'must be the key alone: 1 to 256 visible ASCII characters, with no space or line break',
    );
  }
  const origin =
    options.baseUrl === undefined
      ? production
        ? STEAM_PARTNER_API
        : STEAM_PUBLIC_API
      : checkedOrigin(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? STEAM_API_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  // The key's only reader holds the pairing itself: the ordinary key goes out only as Valve's
  // development app, and the publisher key never as it.
  const { appId } = config.steam;
  if (
    !Number.isInteger(appId) ||
    appId < 1 ||
    appId > MAX_STEAM_APP_ID ||
    (appId === STEAM_DEV_APP_ID) === production
  ) {
    throw new ConfigError('MR_STEAM_APP_ID', 'is not an app this profile checks Steam as');
  }
  const appid = String(appId);

  const failed = (call: Call, error: SteamApiError): Failed => {
    try {
      const status = error.status === undefined ? '' : ` status=${error.status}`;
      const written: unknown = log(
        `account-service: steam ${call} failed reason=${error.reason}${status}`,
      );
      // A log that answers with a promise is watched too: its rejection must not go unhandled.
      if (written instanceof Promise) written.catch(() => undefined);
    } catch {
      // a log that cannot be written changes nothing about the answer
    }
    return { kind: 'failed', error };
  };
  const unconfigured = (): Failed => ({ kind: 'failed', error: new SteamApiError('unconfigured') });

  /** One GET with the key in its header: the answer's JSON value, or why there is none. */
  const ask = async (
    call: Call,
    sentKey: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<{ readonly value: unknown } | SteamApiError> => {
    // Every value is of a closed alphabet, and is still written through URLSearchParams.
    const url = `${origin}${PATHS[call]}?${new URLSearchParams(parameters)}`;
    let text: string | undefined;
    // Only the exchange itself is inside: whatever it throws is Steam failing to answer.
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { [KEY_HEADER]: sentKey, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return new SteamApiError('status', response.status);
      }
      text = await readCapped(response);
    } catch (error) {
      return new SteamApiError(isTimeout(error) ? 'timeout' : 'unreachable');
    }
    if (text === undefined) return new SteamApiError('malformed');
    try {
      return { value: JSON.parse(text) };
    } catch {
      return new SteamApiError('malformed');
    }
  };

  return {
    async authenticateTicket(ticket, identity) {
      if (typeof identity !== 'string' || !IDENTITY.test(identity)) {
        throw new TypeError(
          'an identity is 1 to 128 letters, digits, dots, underscores, colons and hyphens',
        );
      }
      if (typeof ticket !== 'string' || !TICKET.test(ticket)) return { kind: 'rejected' };
      if (key === undefined) return unconfigured();
      const answer = await ask('AuthenticateUserTicket', key, { appid, ticket, identity });
      if (answer instanceof SteamApiError) return failed('AuthenticateUserTicket', answer);
      return (
        ticketCheck(answer.value) ??
        failed('AuthenticateUserTicket', new SteamApiError('malformed'))
      );
    },
    async checkAppOwnership(steamId) {
      if (parseSteamId(steamId) === undefined) throw new TypeError('a SteamID is 17 digits');
      // Only the publisher key of the app itself may ask this.
      if (!production || key === undefined) return unconfigured();
      const answer = await ask('CheckAppOwnership', key, { appid, steamid: steamId });
      if (answer instanceof SteamApiError) return failed('CheckAppOwnership', answer);
      const ownership = ownershipOf(answer.value);
      return ownership === undefined
        ? failed('CheckAppOwnership', new SteamApiError('malformed'))
        : { kind: 'answered', ownership };
    },
  };
}

function isProduction(profile: Config['profile']): boolean {
  switch (profile) {
    case 'production':
      return true;
    case 'local-dev':
    case 'hosted-dev':
      return false;
    default:
      throw new TypeError('the profile is none of local-dev, hosted-dev and production');
  }
}

/** A setting's value when the record itself holds one; empty is unset, as `loadConfig` reads it. */
function ownSetting(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = Object.hasOwn(env, name) ? env[name] : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The key goes wherever this names, so it is https, or plain http on this machine alone. */
function checkedOrigin(baseUrl: string): string {
  const url = typeof baseUrl === 'string' && URL.canParse(baseUrl) ? new URL(baseUrl) : undefined;
  if (url === undefined || url.origin !== baseUrl) {
    throw new TypeError('baseUrl must be a bare origin, such as https://partner.steam-api.com');
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw new TypeError('baseUrl must be https, or http on localhost, 127.0.0.1 or [::1]');
  }
  return baseUrl;
}

/** Whether a failed exchange ran out of its `AbortSignal.timeout`. */
export function isTimeout(error: unknown): boolean {
  return (error as { readonly name?: unknown } | null)?.name === 'TimeoutError';
}

/**
 * The body as text, or undefined when it is longer than the cap or not UTF-8. It counts the
 * bytes as they are decoded and stops reading at the cap, whatever length the answer declared.
 */
export async function readCapped(response: Response): Promise<string | undefined> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_STEAM_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A member the object itself holds; never one its prototype supplies. */
function own(value: unknown, name: string): unknown {
  return isRecord(value) && Object.hasOwn(value, name) ? value[name] : undefined;
}

/**
 * Steam's answer to AuthenticateUserTicket, or undefined for a body of neither shape. An `error`
 * member is Steam saying the ticket does not authenticate (not valid, made for another identity
 * or another app); it wins over anything beside it, and nothing of it is kept.
 */
function ticketCheck(body: unknown): TicketCheck | undefined {
  const response = own(body, 'response');
  if (!isRecord(response)) return undefined;
  if (Object.hasOwn(response, 'error')) return { kind: 'rejected' };
  const params = own(response, 'params');
  if (own(params, 'result') !== 'OK') return undefined;
  const steamId = parseSteamId(own(params, 'steamid'));
  return steamId === undefined ? undefined : { kind: 'authenticated', steamId };
}

/**
 * Steam's answer to CheckAppOwnership as the four members the ownership rule reads, or undefined
 * for a body that does not say. The two answers are read unevenly on purpose: "does not own it"
 * needs only `ownsapp: false`, and is reported as one fixed value, so a real "no" is never taken
 * for a failure; "owns it" needs every member, each of its type. An answer whose `result` is
 * anything but `OK` says neither.
 */
function ownershipOf(body: unknown): AppOwnership | undefined {
  const answer = own(body, 'appownership');
  if (!isRecord(answer)) return undefined;
  if (Object.hasOwn(answer, 'result') && answer.result !== 'OK') return undefined;
  const ownsapp = own(answer, 'ownsapp');
  if (ownsapp === false) {
    return { ownsapp: false, permanent: false, sitelicense: false, ownersteamid: '0' };
  }
  const permanent = own(answer, 'permanent');
  const sitelicense = own(answer, 'sitelicense');
  const ownersteamid = own(answer, 'ownersteamid');
  if (
    ownsapp !== true ||
    typeof permanent !== 'boolean' ||
    typeof sitelicense !== 'boolean' ||
    typeof ownersteamid !== 'string' ||
    !DIGITS.test(ownersteamid)
  ) {
    return undefined;
  }
  return { ownsapp, permanent, sitelicense, ownersteamid };
}
