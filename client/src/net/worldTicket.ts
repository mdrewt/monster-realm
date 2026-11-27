// net/worldTicket.ts — how the client gets a single-player world or a friends server the
// one-use ticket that world checks an account with, and what it does with the world's answer.
//
// Everything this module reaches (the network, the address bar) is INJECTED, so every branch
// runs in node with no DOM. It never holds a connection: `connection.ts` wires `firstContact`
// to the `check_account` procedure, and `main.ts` builds the source.

import type { OidcClient } from './oidc';
import type { TargetKind } from './shellDocument';

/** What a ticket source answers. No variant carries a login token or a response body. */
export type TicketOutcome =
  | { readonly kind: 'ticket'; readonly ticket: string }
  /** The source holds no session: the player must sign in before a ticket can be had. */
  | { readonly kind: 'sign-in-needed' }
  /** The account service could not be reached, or gave no ticket. */
  | { readonly kind: 'unreachable' };

/** Where a ticket comes from. Both methods are total: neither rejects. */
export interface TicketSource {
  /** A one-use ticket for the world named `world`. */
  ticket(world: string): Promise<TicketOutcome>;
  /** Start the player's sign-in. True once the page is leaving for it. */
  signIn(): Promise<boolean>;
}

/** The target a world name is computed from: the resolved shell document's fields. */
export interface WorldTarget {
  readonly kind: TargetKind;
  readonly uri: string;
  readonly db: string;
  readonly fingerprint: string | undefined;
}

const TLS_SCHEME = 'wss:';
const PLAIN_SCHEME = 'ws:';
const DEFAULT_TLS_PORT = '443';
// A dotted IPv4 address as the URL parser writes one.
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '[::1]' || (IPV4.test(host) && host.startsWith('127.'));

/**
 * The name of the server as a page in a browser authenticated it, which is what a ticket is
 * asked for; `undefined` when nothing authenticated it, and then the client asks for no ticket.
 *
 * - `local`: `spki:<fingerprint>/<db>`, when the host is loopback and the document carries the
 *   fingerprint: whoever started the world on this machine wrote it there.
 * - `private`, over TLS only: the address the browser's certificate check vouched for,
 *   `ip:<address>:<port>/<db>` for an address literal and `dns:<host>:<port>/<db>` otherwise, the
 *   host as the URL parser spells it with one trailing dot removed, the port always written. A
 *   fingerprint counts for nothing here: a browser enforces no pin.
 * - `official`, `test`: none.
 *
 * A world accepts a ticket only for a name it lists, so a name the client did not authenticate
 * would let one host pass a player's ticket on to another world.
 */
export function worldNameFor(target: WorldTarget): string | undefined {
  const { kind, db, fingerprint } = target;
  if (kind !== 'local' && kind !== 'private') return undefined;
  let url: URL;
  try {
    url = new URL(target.uri);
  } catch {
    return undefined;
  }
  const address = url.hostname.startsWith('[') || IPV4.test(url.hostname);
  const host = address ? url.hostname : url.hostname.replace(/\.$/, '');
  const tls = url.protocol === TLS_SCHEME;
  if (kind === 'local') {
    const named = fingerprint !== undefined && isLoopback(host);
    return named && (tls || url.protocol === PLAIN_SCHEME)
      ? `spki:${fingerprint}/${db}`
      : undefined;
  }
  if (!tls) return undefined;
  const port = url.port === '' ? DEFAULT_TLS_PORT : url.port;
  return `${address ? 'ip' : 'dns'}:${host}:${port}/${db}`;
}

/** The host a ticket source reaches: `fetch` for the ticket route, `location` for the sign-in,
 *  and `setTimeout` for the time it gives the account service to answer. */
export interface TicketHost {
  readonly fetch?: unknown;
  readonly location?: unknown;
  readonly setTimeout?: unknown;
}

export interface IdTokenTicketSourceOptions {
  /** The account service's issuer: the OIDC client's issuer, and where the ticket route is. */
  readonly issuer: string;
  readonly oidc: Pick<OidcClient, 'beginSignIn' | 'renewOrExchange'>;
}

const TICKET_ROUTE = '/ticket';
/** A ticket is 32 random bytes as unpadded base64url. */
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const STATUS_UNAUTHORIZED = 401;
/** How long a ticket may take, sign-in renewal included, before the service counts as out of
 *  reach. A request that never answers would otherwise leave the player with no gate at all. */
const TICKET_DEADLINE_MS = 15_000;

/** What one request to the ticket route gave: a ticket, a token it does not take, or nothing. */
type Posted = { readonly ticket: string } | 'token-refused' | 'none';

/**
 * The source of a page that signs in to the account service itself. It holds the ID token in
 * memory only, sends it to the issuer's ticket route and nowhere else, and writes nothing to
 * storage: a reload asks the OIDC client again.
 */
export function createIdTokenTicketSource(
  host: TicketHost | undefined,
  options: IdTokenTicketSourceOptions,
): TicketSource {
  const { issuer, oidc } = options;
  const url = (issuer.endsWith('/') ? issuer.slice(0, -1) : issuer) + TICKET_ROUTE;
  let idToken: string | undefined;
  let signingIn = false;

  async function post(token: string, world: string): Promise<Posted> {
    const fetchFn = host?.fetch;
    if (typeof fetchFn !== 'function') return 'none';
    const res = (await fetchFn(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ world }),
    })) as { readonly ok?: unknown; readonly status?: unknown; readonly json?: unknown };
    if (res.status === STATUS_UNAUTHORIZED) return 'token-refused';
    if (res.ok !== true || typeof res.json !== 'function') return 'none';
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'none';
    const ticket = Object.hasOwn(body, 'ticket') ? (body as { ticket: unknown }).ticket : undefined;
    return typeof ticket === 'string' && TICKET.test(ticket) ? { ticket } : 'none';
  }

  async function ask(world: string): Promise<TicketOutcome> {
    try {
      // Two rounds at most: a held token the route refuses is renewed once.
      for (let round = 0; round < 2; round += 1) {
        if (idToken === undefined) {
          const renewed = await oidc.renewOrExchange();
          if (renewed.kind === 'transient-error') return { kind: 'unreachable' };
          if (renewed.kind !== 'ok') return { kind: 'sign-in-needed' };
          idToken = renewed.token;
        }
        const posted = await post(idToken, world);
        if (posted === 'none') return { kind: 'unreachable' };
        if (posted !== 'token-refused') return { kind: 'ticket', ticket: posted.ticket };
        idToken = undefined;
      }
      return { kind: 'sign-in-needed' };
    } catch {
      return { kind: 'unreachable' };
    }
  }

  return {
    ticket(world) {
      const asked = ask(world);
      const setTimer = host?.setTimeout;
      if (typeof setTimer !== 'function') return asked;
      // A ticket that arrives after the deadline is never presented, and lapses unspent.
      const late = new Promise<TicketOutcome>((resolve) => {
        setTimer(() => resolve({ kind: 'unreachable' }), TICKET_DEADLINE_MS);
      });
      return Promise.race([asked, late]);
    },

    async signIn() {
      if (signingIn) return false;
      signingIn = true;
      try {
        const begun = await oidc.beginSignIn();
        if (begun.kind !== 'ready') return false;
        const location = host?.location as { assign?: unknown } | null | undefined;
        if (typeof location?.assign !== 'function') return false;
        // Called on `location`: the browser's `assign` refuses any other receiver.
        (location as { assign(address: string): void }).assign(begun.authorizationUrl);
        return true;
      } catch {
        return false;
      } finally {
        signingIn = false;
      }
    },
  };
}

export type FirstContactOutcome =
  | { readonly kind: 'entitled' }
  | { readonly kind: 'not-entitled' }
  /** The world's build checks no account: the join is the module's to answer. */
  | { readonly kind: 'no-check' }
  | { readonly kind: 'sign-in-needed' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'refused'; readonly reason: string }
  /** The connection the contact ran on is no longer the live one. */
  | { readonly kind: 'superseded' };

export interface FirstContactDeps {
  readonly tickets: TicketSource;
  readonly world: string;
  /** Calls the world's `check_account` procedure with the ticket and resolves its answer. */
  readonly check: (ticket: string) => Promise<unknown>;
  /** Whether the connection this contact runs on is still the live one. */
  readonly live: () => boolean;
}

/** `check_account`'s refusal when the world's request to the account service got no answer
 *  (`REJECT_CHECK_UNANSWERED`, server-module/src/account_checks.rs). Matched exactly. */
const ERR_CHECK_UNANSWERED = 'the account service gave no answer';
/** Its refusal on a build that names no account service (`REJECT_BUILD_CHECKS_NOTHING`). */
const ERR_BUILD_CHECKS_NOTHING = 'this server checks no account';
/** A refusal the player is shown: the world's host chooses the text, so it is short and plain. */
const SHOWN_REASON = /^[\x20-\x7e]{1,160}$/;

/** What `check_account` answered, `{ ok }` or `{ err }` as the SDK decodes a result. */
function outcomeOfCheck(answer: unknown): FirstContactOutcome {
  if (typeof answer !== 'object' || answer === null) return { kind: 'refused', reason: '' };
  if (Object.hasOwn(answer, 'ok')) {
    const { ok } = answer as { ok: unknown };
    if (ok === true) return { kind: 'entitled' };
    if (ok === false) return { kind: 'not-entitled' };
    return { kind: 'refused', reason: '' };
  }
  const err = Object.hasOwn(answer, 'err') ? (answer as { err: unknown }).err : undefined;
  if (typeof err !== 'string') return { kind: 'refused', reason: '' };
  if (err === ERR_CHECK_UNANSWERED) return { kind: 'unreachable' };
  if (err === ERR_BUILD_CHECKS_NOTHING) return { kind: 'no-check' };
  return { kind: 'refused', reason: SHOWN_REASON.test(err) ? err : '' };
}

/**
 * A world's first contact with this identity: get a ticket, hand it to the world's
 * `check_account`, and say what the world answered. Total. `live` is asked after each wait: once
 * the connection is no longer the live one the ticket is not presented and an answer is dropped.
 * The ticket lives in this call only.
 */
export async function firstContact(deps: FirstContactDeps): Promise<FirstContactOutcome> {
  let asked: TicketOutcome;
  try {
    asked = await deps.tickets.ticket(deps.world);
  } catch {
    return { kind: 'unreachable' };
  }
  if (asked.kind !== 'ticket') return { kind: asked.kind };
  if (!deps.live()) return { kind: 'superseded' };
  let outcome: FirstContactOutcome;
  try {
    outcome = outcomeOfCheck(await deps.check(asked.ticket));
  } catch {
    outcome = { kind: 'refused', reason: '' };
  }
  return deps.live() ? outcome : { kind: 'superseded' };
}

export type WorldEntry =
  | { readonly kind: 'join' }
  | { readonly kind: 'first-contact' }
  | { readonly kind: 'moved'; readonly movedAtMs: number };

/**
 * What a connection does at a world's door, from its own two rows there: a move record means the
 * character plays under another identity, so nothing is sent; a world that knows the identity is
 * joined, and it answers; one that does not is asked to check the account first.
 */
export function worldEntryFor(rows: {
  readonly known: boolean;
  readonly movedAtMs: number | undefined;
}): WorldEntry {
  if (rows.movedAtMs !== undefined) return { kind: 'moved', movedAtMs: rows.movedAtMs };
  return rows.known ? { kind: 'join' } : { kind: 'first-contact' };
}

/** What raises, changes or lowers the gate a world puts in front of play. */
export type WorldGateEvent =
  | { readonly kind: 'entitled' }
  | { readonly kind: 'not-entitled' }
  | { readonly kind: 'sign-in-needed' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'moved'; readonly movedAtMs: number }
  /** The own player row arrived. */
  | { readonly kind: 'joined' };

export type WorldGateState =
  | { readonly phase: 'hidden' }
  | { readonly phase: 'sign-in' }
  | { readonly phase: 'unreachable' }
  | { readonly phase: 'not-owned' }
  | { readonly phase: 'refused'; readonly reason: string }
  | { readonly phase: 'moved'; readonly movedAtMs: number };

export const WORLD_GATE_INITIAL: WorldGateState = { phase: 'hidden' };

/**
 * Pure reducer of the gate. The last report wins. An account the world accepted lowers the gate
 * from every phase. The own player row lowers it too, except while the character plays on
 * another client: that row can still be in the store when the move is reported.
 */
export function worldGateStep(state: WorldGateState, event: WorldGateEvent): WorldGateState {
  switch (event.kind) {
    case 'entitled':
      return WORLD_GATE_INITIAL;
    case 'joined':
      return state.phase === 'moved' ? state : WORLD_GATE_INITIAL;
    case 'sign-in-needed':
      return { phase: 'sign-in' };
    case 'unreachable':
      return { phase: 'unreachable' };
    case 'not-entitled':
      return { phase: 'not-owned' };
    case 'refused':
      return { phase: 'refused', reason: event.reason };
    case 'moved':
      return { phase: 'moved', movedAtMs: event.movedAtMs };
  }
}
