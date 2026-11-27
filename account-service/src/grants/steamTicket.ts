import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type Provider from 'oidc-provider';
import { errors } from 'oidc-provider';
import { accountClaims, ID_TOKEN_TTL_SECONDS } from '../claims.ts';
import { addressLimitKey, createRateLimiter, type RateLimiter } from '../rateLimit.ts';
import { type SteamEntitlement, type SteamId, steamSubject } from '../steam/ownership.ts';
import type { TicketCheck } from '../steam/webApi.ts';
import { errorClass } from '../worldTicket.ts';

/** The grant type a desktop client names at the token endpoint. */
export const STEAM_TICKET_GRANT = 'urn:monster-realm:steam-ticket';

/** The form parameter that carries the ticket, as hex. */
const TICKET_PARAMETER = 'steam_ticket';
/** The identity a ticket is made for (`GetAuthTicketForWebApi`) and checked with. */
const TICKET_IDENTITY = 'monster-realm-account';
/** A SteamID is decided at most this often within any `STEAM_ID_WINDOW_SECONDS`. */
const STEAM_ID_LIMIT = 30;
const STEAM_ID_WINDOW_SECONDS = 3600;
/** A source address exchanges at most this often within any `ADDRESS_WINDOW_SECONDS`. */
const ADDRESS_LIMIT = 60;
const ADDRESS_WINDOW_SECONDS = 60;
/**
 * How many keys each window holds at once. Past it a new key is refused until an old one's hits
 * die, so each bound is far above what honest players reach: a source address is anyone's to
 * choose, and a SteamID's key needs a ticket Steam authenticated.
 */
const MAX_LIMIT_KEYS = 1_000_000;
/** How many tickets are remembered with their SteamID; the oldest is forgotten first. */
const MAX_REMEMBERED_TICKETS = 100_000;

const REFUSED = 'the Steam ticket was not accepted';
const RATE_LIMITED = 'too many sign-ins; try again later';
const UNAVAILABLE = 'Steam could not be asked; try again later';

/** How one exchange ends. */
export type TicketExchange =
  /** The ticket's player owns the game; `sub` is `steam:<steamid64>`. */
  | { readonly kind: 'entitled'; readonly sub: string }
  /** Steam did not authenticate the ticket, or its player is not entitled. */
  | { readonly kind: 'refused' }
  /** A window is full; `retryAfter` is whole seconds, at least 1. */
  | { readonly kind: 'rate-limited'; readonly retryAfter: number }
  /** Steam gave no answer. Nothing was learnt about the ticket or its player. */
  | { readonly kind: 'unavailable' };

export interface SteamTicketExchangeOptions {
  /** Asks Steam whose ticket this is (`SteamWebApi['authenticateTicket']`). */
  readonly authenticateTicket: (ticket: string, identity: string) => Promise<TicketCheck>;
  /** The profile's entitlement source (`steamEntitlementSource`). */
  readonly entitlement: (steamId: SteamId) => Promise<SteamEntitlement>;
  /** Whole epoch seconds; default the system clock. The only clock the exchange reads. */
  readonly now?: () => number;
}

/**
 * Builds the decision of one ticket exchange, from `address`, the request's source address in its
 * canonical spelling. The steps run in this order, and the first that answers ends the exchange:
 *
 * 1. The address window. Every exchange counts against its source address, whatever its end.
 * 2. A ticket Steam has authenticated before is remembered with its SteamID. While that SteamID's
 *    window is full, the ticket is refused here and Steam is not asked.
 * 3. Steam is asked whose ticket it is. A ticket it does not authenticate (not valid, or made for
 *    another identity or app) is refused.
 * 4. The SteamID's window, about the SteamID Steam returned: nothing a caller sends names the
 *    player, so nobody can spend another player's window. Over it, the entitlement source is not
 *    asked.
 * 5. The entitlement source decides.
 *
 * Only Steam says whose ticket a ticket is, so a ticket seen for the first time costs one call to
 * Steam even when its player is over the window; step 2 saves that call for a ticket presented
 * again. What is remembered only ever refuses: a remembered ticket whose player has room is sent
 * to Steam like any other, since a ticket can stop authenticating.
 *
 * A SteamID's window counts the exchanges that were decided, entitled or refused. One that Steam
 * failed to answer, or that the entitlement source threw on, is given back: an outage must not
 * lock a player out once it ends. What is given back is the SteamID's newest hit, which keeps the
 * count right; among exchanges in flight together, the hit left may be seconds older than the
 * one decided. An address's hits are never given back, so the address window bounds every call
 * to Steam a caller can cause.
 */
export function createSteamTicketExchange(
  options: SteamTicketExchangeOptions,
): (ticket: string, address: string) => Promise<TicketExchange> {
  const { authenticateTicket, entitlement, now } = options;
  const addressLimit = createRateLimiter({
    limit: ADDRESS_LIMIT,
    windowSeconds: ADDRESS_WINDOW_SECONDS,
    now,
    maxKeys: MAX_LIMIT_KEYS,
  });
  const steamIdLimit = createRateLimiter({
    limit: STEAM_ID_LIMIT,
    windowSeconds: STEAM_ID_WINDOW_SECONDS,
    now,
    maxKeys: MAX_LIMIT_KEYS,
  });
  // A ticket's player never changes, so an entry is never wrong; the bound is for memory alone.
  const steamIdOfTicket = new Map<string, SteamId>();

  const remember = (key: string, steamId: SteamId): void => {
    if (steamIdOfTicket.has(key)) return;
    if (steamIdOfTicket.size >= MAX_REMEMBERED_TICKETS) {
      const oldest = steamIdOfTicket.keys().next();
      if (oldest.done !== true) steamIdOfTicket.delete(oldest.value);
    }
    steamIdOfTicket.set(key, steamId);
  };

  return async (ticket, address) => {
    const source = addressLimitKey(address);
    if (!addressLimit.take(source)) return limited(addressLimit, source);

    const key = ticketKey(ticket);
    const remembered = steamIdOfTicket.get(key);
    // A read, never a hit: only an exchange Steam authenticated counts against a SteamID.
    if (remembered !== undefined && steamIdLimit.retryAfter(remembered) > 0) {
      return limited(steamIdLimit, remembered);
    }

    const check = await authenticateTicket(ticket, TICKET_IDENTITY);
    if (check.kind === 'rejected') return { kind: 'refused' };
    // Only an authenticated ticket names a player: anything else is Steam not answering.
    if (check.kind !== 'authenticated') return { kind: 'unavailable' };
    const { steamId } = check;

    remember(key, steamId);
    if (!steamIdLimit.take(steamId)) return limited(steamIdLimit, steamId);
    let decision: SteamEntitlement;
    try {
      decision = await entitlement(steamId);
    } catch (error) {
      steamIdLimit.giveBack(steamId);
      throw error;
    }
    if (decision.entitled === true) return { kind: 'entitled', sub: steamSubject(steamId) };
    if (decision.reason === 'unavailable') {
      steamIdLimit.giveBack(steamId);
      return { kind: 'unavailable' };
    }
    return { kind: 'refused' };
  };
}

/** A key refused for want of room has no hit to wait out, so the wait is a second at least. */
function limited(limiter: RateLimiter, key: string): TicketExchange {
  return { kind: 'rate-limited', retryAfter: Math.max(1, limiter.retryAfter(key)) };
}

/**
 * What a ticket is remembered under: the SHA-256 of its hex in lower case, so the other letter
 * case is the same ticket and no ticket text is held.
 */
function ticketKey(ticket: string): string {
  return createHash('sha256').update(ticket.toLowerCase()).digest('base64url');
}

export interface SteamTicketGrantOptions extends SteamTicketExchangeOptions {
  /** A request's source address, or undefined when it cannot be known (`createSourceAddress`). */
  readonly sourceAddress: (req: IncomingMessage) => string | undefined;
  /** Receives one line per ID token issued and one per failure of the service. */
  readonly log: (line: string) => void;
}

export interface SteamTicketGrant {
  /**
   * Reads and keeps a request's source address. The provider's handler calls it for every request
   * before it removes the forwarding headers: after that the source can no longer be read.
   */
  noteSource(req: IncomingMessage): void;
  /** Registers the grant at the provider's token endpoint. */
  register(provider: Provider): void;
}

/**
 * Builds the grant `urn:monster-realm:steam-ticket`: a desktop client posts `steam_ticket`, the
 * hex ticket its Steam client made for the identity `monster-realm-account`, with its client id,
 * and gets `{ id_token, expires_in }` for the ticket's player when that player is entitled. No
 * refresh token and no access token: a desktop client exchanges a fresh ticket for its next token.
 *
 * Every refusal the ticket or its player causes is one `invalid_grant` with one description, so
 * an answer never says whether Steam rejected the ticket or the player does not own the game. A
 * full window is `429` with `retry-after`, and Steam failing to answer is `503`: neither says
 * anything about the ticket. A request whose source address is unknown is refused before
 * anything is asked, since it could not be counted.
 *
 * One line is logged per ID token issued, with the player's subject and the time, before the
 * token is sent: a token that cannot be logged is not handed out. A failure of the service logs
 * one line with the error's class. A refusal logs nothing, so no caller can write lines at will,
 * and no line holds a ticket, an address or an error's message.
 */
export function createSteamTicketGrant(options: SteamTicketGrantOptions): SteamTicketGrant {
  const { log } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const exchange = createSteamTicketExchange({ ...options, now });
  const sources = new WeakMap<IncomingMessage, string>();

  return {
    noteSource(req) {
      const address = options.sourceAddress(req);
      if (address !== undefined) sources.set(req, address);
    },
    register(provider) {
      provider.registerGrantType(
        STEAM_TICKET_GRANT,
        async (ctx) => {
          const ticket: unknown = ctx.oidc.params[TICKET_PARAMETER];
          // The provider reads an empty parameter as an absent one.
          if (typeof ticket !== 'string') {
            throw new errors.InvalidRequest(`missing required parameter '${TICKET_PARAMETER}'`);
          }
          // Never the provider's own idea of the caller: behind a proxy that is the proxy.
          const address = sources.get(ctx.req);
          if (address === undefined) {
            throw new errors.InvalidRequest('the source address of the request is unknown');
          }

          const at = new Date(now() * 1000).toISOString();
          let outcome: TicketExchange;
          let idToken = '';
          try {
            outcome = await exchange(ticket, address);
            if (outcome.kind === 'entitled') {
              const claims = accountClaims({ sub: outcome.sub, entitled: true });
              // The provider keeps the claims its configuration names for the scope.
              const token = Object.assign(new provider.IdToken({ ...claims }, { ctx }), {
                scope: 'openid',
              });
              idToken = await token.issue({ use: 'idtoken' });
              write(log, `account-service: steam-ticket sub=${outcome.sub} at=${at}`);
            }
          } catch (error) {
            try {
              write(
                log,
                `account-service: steam-ticket failed at=${at} error=${errorClass(error)}`,
              );
            } catch {
              // the answer is a 500 either way
            }
            // The provider answers an error it does not know with a fixed 500.
            throw new Error('the Steam ticket exchange failed');
          }

          switch (outcome.kind) {
            case 'entitled':
              ctx.body = { id_token: idToken, expires_in: ID_TOKEN_TTL_SECONDS };
              return;
            case 'refused':
              throw refusal(new errors.InvalidGrant(), REFUSED);
            case 'rate-limited':
              ctx.set('retry-after', String(outcome.retryAfter));
              throw refusal(new errors.OIDCProviderError(429, 'rate_limited'), RATE_LIMITED);
            case 'unavailable':
              throw refusal(
                new errors.OIDCProviderError(503, 'temporarily_unavailable'),
                UNAVAILABLE,
              );
          }
        },
        [TICKET_PARAMETER],
      );
    },
  };
}

/** An error the provider answers with its own status and code, and this fixed description. */
function refusal(error: errors.OIDCProviderError, description: string): errors.OIDCProviderError {
  error.error_description = description;
  error.expose = true;
  return error;
}

/** Writes a line. A log that answers with a promise is watched: its rejection is not unhandled. */
function write(log: (line: string) => void, line: string): void {
  const written: unknown = log(line);
  if (written instanceof Promise) written.catch(() => undefined);
}
