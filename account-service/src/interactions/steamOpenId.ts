import { createHash } from 'node:crypto';
import type { Adapter } from 'oidc-provider';
import {
  parseSteamId,
  type SteamEntitlement,
  type SteamId,
  steamIdOfSubject,
  steamSubject,
} from '../steam/ownership.ts';
import { isTimeout, readCapped, STEAM_API_TIMEOUT_MS, type SteamFailure } from '../steam/webApi.ts';
import type { Account, SteamSignInOutcome, SteamStep } from './router.ts';

/** Where Steam signs a player in for another site, and where it says whether a reply is its own. */
export const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
/** How far a reply's nonce time may be from this service's clock, and how long a nonce is remembered. */
export const STEAM_NONCE_WINDOW_SECONDS = 300;

const OPENID_NS = 'http://specs.openid.net/auth/2.0';
/** Asks Steam to name the player: the service knows no SteamID before the reply. */
const IDENTIFIER_SELECT = `${OPENID_NS}/identifier_select`;
const OPENID_PREFIX = 'openid.';
const CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/([0-9]{17})$/;
/** A UTC time to the second, then up to 235 visible ASCII characters: 255 in all, as OpenID bounds it. */
const NONCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z[\x21-\x7e]{0,235}$/;
/** `YYYY-MM-DDTHH:MM:SSZ`. */
const NONCE_STAMP_LENGTH = 20;
/** What a reply's `openid.signed` must list: every field this step reads, so Steam vouches for each. */
const SIGNED_FIELDS = [
  'op_endpoint',
  'claimed_id',
  'identity',
  'return_to',
  'response_nonce',
  'assoc_handle',
] as const;
const NONCE_MODEL = 'SteamNonce';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why Steam gave no answer to a check of a reply. */
type CheckFailure = Exclude<SteamFailure, 'unconfigured'>;

/** What a reply that passed every check of its own holds. */
interface ReadReply {
  readonly steamId: SteamId;
  readonly nonce: string;
  /** The seconds from now until the window stops admitting the nonce. */
  readonly admittedSeconds: number;
  /** The body of the question to Steam: is this reply yours? */
  readonly question: URLSearchParams;
}

/**
 * The Steam step of the browser sign-in: Steam's OpenID 2.0 sign-in, checked by Steam and by us,
 * and then the profile's entitlement source. OpenID names no app; whether the player owns the
 * game is `entitlement`'s to say.
 *
 * `complete` takes the query Steam sent the browser back with and what the router expects of it
 * (its own callback address and the sign-in's state). The checks run in this order, and the first
 * that fails ends it:
 *
 * 1. No `openid.` parameter is given twice, the namespace is OpenID 2.0, the mode is `id_res`.
 * 2. The one `state` is the sign-in's.
 * 3. `op_endpoint` is exactly the endpoint this step sends players to.
 * 4. `return_to` is exactly the callback address this sign-in was sent out with.
 * 5. `claimed_id` is `https://steamcommunity.com/openid/id/<17 digits>`, and `identity` equals it.
 * 6. `signed` lists every field read here, each of its names once and each a parameter of the
 *    reply; there is a signature.
 * 7. `response_nonce` is a UTC second and a suffix, the second within the window of our clock.
 * 8. Steam is asked whether the reply is its own (`check_authentication`), at the configured
 *    endpoint and never at one the reply names: the namespace, the signature, the signed list and
 *    each field it lists, one value per name. One request with a timeout over the whole exchange,
 *    never retried, no redirect followed, a capped read.
 * 9. The nonce has not been seen within its window. It is recorded once Steam has vouched for the
 *    reply, so nothing a caller makes up is stored and an outage of Steam's spends no reply. The
 *    record outlives the window by the longest Steam may take to answer.
 * 10. The entitlement source decides about the SteamID the claimed id names.
 *
 * A reply that fails a check of 1 to 7 sends nothing to Steam. Every failed check, Steam's "no"
 * and a nonce seen before are one outcome, `refused`: it does not say which. Steam giving no
 * answer, to the check or to the entitlement source, is `unavailable`. One line is logged for
 * each exchange with Steam that failed, naming the reason; no line and no error holds anything of
 * the reply or of Steam's answer.
 *
 * The store has no insert-if-absent, and awaits sit between its read and its write, so the step
 * holds the nonces it is recording: of several completions of one reply at once, one passes. That
 * holds for one instance of the service on its store.
 *
 * `account` answers for `steam:<steamid64>` alone, from the entitlement source at every call.
 * Steam giving no answer there rejects: read as "not entitled" it would revoke a chain for an
 * outage. A Steam player has no password with this service, so the account carries no
 * `passwordChangedAt`.
 */
export function steamOpenIdStep(options: {
  /** The service's own origin: the realm Steam shows the player. */
  readonly realm: string;
  /** The account store: a seen nonce is a record of it. */
  readonly adapter: (model: string) => Adapter;
  /** The profile's entitlement source (`steamEntitlementSource`). */
  readonly entitlement: (steamId: SteamId) => Promise<SteamEntitlement>;
  /** Receives one line per exchange with Steam that failed. */
  readonly log: (line: string) => void;
  /**
   * Replaces Steam's OpenID address, for a test's Steam fake: a URL in its canonical form with no
   * user, query or fragment, `https:`, or `http:` on localhost, 127.0.0.1 or [::1].
   */
  readonly endpoint?: string;
  /** Whole epoch seconds; default the system clock. */
  readonly now?: () => number;
  /** For the one request to Steam, over the whole exchange. */
  readonly timeoutMs?: number;
}): SteamStep {
  const { realm, entitlement, log } = options;
  const endpoint =
    options.endpoint === undefined ? STEAM_OPENID_ENDPOINT : checkedEndpoint(options.endpoint);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const timeoutMs = options.timeoutMs ?? STEAM_API_TIMEOUT_MS;
  // A replay the window admits in its last second is looked up only once Steam has answered, up
  // to the timeout later, so a nonce's record lives that much past the window.
  const answerSeconds = Math.ceil(timeoutMs / 1000);
  const nonces = options.adapter(NONCE_MODEL);
  const recording = new Set<string>();

  const failed = (reason: CheckFailure, status?: number): void => {
    try {
      const written: unknown = log(
        `account-service: steam openid check failed reason=${reason}${status === undefined ? '' : ` status=${status}`}`,
      );
      // A log that answers with a promise is watched too: its rejection must not go unhandled.
      if (written instanceof Promise) written.catch(() => undefined);
    } catch {
      // a log that cannot be written changes nothing about the answer
    }
  };

  /** Steam's word on a reply: its own (`true`), not its own (`false`), or no answer. */
  const vouchedFor = async (question: URLSearchParams): Promise<boolean | undefined> => {
    let text: string | undefined;
    // Only the exchange itself is inside: whatever it throws is Steam failing to answer.
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': FORM_TYPE, accept: 'text/plain' },
        body: question.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        failed('status', response.status);
        return undefined;
      }
      text = await readCapped(response);
    } catch (error) {
      failed(isTimeout(error) ? 'timeout' : 'unreachable');
      return undefined;
    }
    const verdict = text === undefined ? undefined : verdictOf(text);
    if (verdict === undefined) failed('malformed');
    return verdict;
  };

  /** Records a nonce, and says whether this is the first time it is seen within its window. */
  const firstSeen = async (nonce: string, rememberSeconds: number): Promise<boolean> => {
    const id = createHash('sha256').update(nonce).digest('base64url');
    if (recording.has(id)) return false;
    recording.add(id);
    try {
      if ((await nonces.find(id)) !== undefined) return false;
      await nonces.upsert(id, {}, rememberSeconds);
      return true;
    } finally {
      recording.delete(id);
    }
  };

  return {
    kind: 'steam',
    loginUrl(returnTo) {
      return `${endpoint}?${new URLSearchParams({
        'openid.ns': OPENID_NS,
        'openid.mode': 'checkid_setup',
        'openid.return_to': returnTo,
        'openid.realm': realm,
        'openid.identity': IDENTIFIER_SELECT,
        'openid.claimed_id': IDENTIFIER_SELECT,
      })}`;
    },
    async complete(reply, expected): Promise<SteamSignInOutcome> {
      const read = readReply(reply, expected, endpoint, now());
      if (read === undefined) return { kind: 'refused' };
      const vouched = await vouchedFor(read.question);
      if (vouched === undefined) return { kind: 'unavailable' };
      if (!vouched || !(await firstSeen(read.nonce, read.admittedSeconds + answerSeconds))) {
        return { kind: 'refused' };
      }
      const decision = await entitlement(read.steamId);
      if (decision.entitled === true) {
        return { kind: 'signed-in', sub: steamSubject(read.steamId) };
      }
      return { kind: decision.reason === 'unavailable' ? 'unavailable' : 'not-owned' };
    },
    async account(sub): Promise<Account | undefined> {
      const steamId = steamIdOfSubject(sub);
      if (steamId === undefined) return undefined;
      const decision = await entitlement(steamId);
      if (decision.entitled === true) return { sub, entitled: true };
      if (decision.reason === 'unavailable') throw decision.error;
      return { sub, entitled: false };
    },
  };
}

/** A check of the reply sends the reply wherever this names, so it is one exact, plain address. */
function checkedEndpoint(endpoint: string): string {
  const url =
    typeof endpoint === 'string' && URL.canParse(endpoint) ? new URL(endpoint) : undefined;
  if (
    url === undefined ||
    url.href !== endpoint ||
    url.username !== '' ||
    url.password !== '' ||
    endpoint.includes('?') ||
    endpoint.includes('#')
  ) {
    throw new TypeError(
      'endpoint must be a URL in its canonical form, with no user, query or fragment',
    );
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw new TypeError('endpoint must be https, or http on localhost, 127.0.0.1 or [::1]');
  }
  return endpoint;
}

/**
 * Checks 1 to 7: what the reply itself must hold. Undefined for a reply that fails one; nothing
 * has been sent or stored by then.
 */
function readReply(
  reply: URLSearchParams,
  expected: { readonly returnTo: string; readonly state: string },
  endpoint: string,
  now: number,
): ReadReply | undefined {
  const fields = new Map<string, string>();
  for (const [name, value] of reply) {
    if (!name.startsWith(OPENID_PREFIX)) continue;
    const field = name.slice(OPENID_PREFIX.length);
    // Steam would be asked about one of two values and this step would read the other.
    if (fields.has(field)) return undefined;
    fields.set(field, value);
  }
  if (fields.get('ns') !== OPENID_NS || fields.get('mode') !== 'id_res') return undefined;

  const states = reply.getAll('state');
  if (states.length !== 1 || states[0] !== expected.state) return undefined;
  if (fields.get('op_endpoint') !== endpoint) return undefined;
  if (fields.get('return_to') !== expected.returnTo) return undefined;

  const claimedId = fields.get('claimed_id');
  const steamId = parseSteamId(CLAIMED_ID.exec(claimedId ?? '')?.[1]);
  if (steamId === undefined || fields.get('identity') !== claimedId) return undefined;

  const signed = fields.get('signed');
  const sig = fields.get('sig');
  if (signed === undefined || sig === undefined || sig === '') return undefined;
  const listed = signed.split(',');
  if (
    new Set(listed).size !== listed.length ||
    !SIGNED_FIELDS.every((field) => listed.includes(field)) ||
    !listed.every((field) => field !== '' && fields.has(field))
  ) {
    return undefined;
  }

  const nonce = fields.get('response_nonce') ?? '';
  const time = nonceTime(nonce);
  if (time === undefined || Math.abs(now - time) > STEAM_NONCE_WINDOW_SECONDS) return undefined;

  // One value per name: Steam's own list names `signed` itself, and a list that named the
  // namespace, the signature or the mode must not send a second copy of one.
  const question = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.signed': signed,
    'openid.sig': sig,
  });
  for (const field of listed) question.set(`${OPENID_PREFIX}${field}`, fields.get(field) ?? '');
  question.set('openid.mode', 'check_authentication');

  return {
    steamId,
    nonce,
    // The window admits the nonce through the second `time + window`, and the store finds a
    // record while its expiry is later than the clock: hence the one second more.
    admittedSeconds: time + STEAM_NONCE_WINDOW_SECONDS + 1 - now,
    question,
  };
}

/** The epoch second a nonce is stamped with, or undefined for a nonce that is not one. */
function nonceTime(nonce: string): number | undefined {
  if (!NONCE.test(nonce)) return undefined;
  const stamp = nonce.slice(0, NONCE_STAMP_LENGTH);
  const at = Date.parse(stamp);
  // The parser carries some impossible times over (February 30th, hour 24): a stamp that does
  // not read back as it is written is not a time.
  if (Number.isNaN(at) || new Date(at).toISOString() !== `${stamp.slice(0, -1)}.000Z`) {
    return undefined;
  }
  return at / 1000;
}

/**
 * Steam's verdict in an answer written in OpenID's key-value form: every line `key:value` ended
 * by a line feed, no key twice. The answer counts only with the OpenID 2.0 namespace and an
 * `is_valid` of exactly `true` or `false`; other keys are passed over. Undefined for anything
 * else.
 */
function verdictOf(text: string): boolean | undefined {
  if (!text.endsWith('\n')) return undefined;
  const pairs = new Map<string, string>();
  for (const line of text.slice(0, -1).split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) return undefined;
    const key = line.slice(0, colon);
    if (pairs.has(key)) return undefined;
    pairs.set(key, line.slice(colon + 1));
  }
  if (pairs.get('ns') !== OPENID_NS) return undefined;
  const valid = pairs.get('is_valid');
  return valid === 'true' ? true : valid === 'false' ? false : undefined;
}
