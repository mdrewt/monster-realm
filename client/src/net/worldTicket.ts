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

export function worldNameFor(_target: WorldTarget): string | undefined {
  return undefined;
}

/** The host a ticket source reaches: `fetch` for the ticket route, `location` for the sign-in. */
export interface TicketHost {
  readonly fetch?: unknown;
  readonly location?: unknown;
}

export interface IdTokenTicketSourceOptions {
  /** The account service's issuer: the OIDC client's issuer, and where the ticket route is. */
  readonly issuer: string;
  readonly oidc: Pick<OidcClient, 'beginSignIn' | 'renewOrExchange'>;
}

export function createIdTokenTicketSource(
  _host: TicketHost | undefined,
  _options: IdTokenTicketSourceOptions,
): TicketSource {
  return {
    ticket: () => Promise.resolve({ kind: 'unreachable' }),
    signIn: () => Promise.resolve(false),
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

export function firstContact(_deps: FirstContactDeps): Promise<FirstContactOutcome> {
  return Promise.resolve({ kind: 'refused', reason: '' });
}

export type WorldEntry =
  | { readonly kind: 'join' }
  | { readonly kind: 'first-contact' }
  | { readonly kind: 'moved'; readonly movedAtMs: number };

export function worldEntryFor(_rows: {
  readonly known: boolean;
  readonly movedAtMs: number | undefined;
}): WorldEntry {
  return { kind: 'join' };
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

export function worldGateStep(state: WorldGateState, _event: WorldGateEvent): WorldGateState {
  return state;
}
