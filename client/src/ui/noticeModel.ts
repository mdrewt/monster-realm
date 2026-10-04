// ui/noticeModel.ts — the world's notices and the request action sheet (ctl-13, CTL13.2, CTL13.3).
// Pure: no DOM, SDK, resolver, clock or module state. Notices are exactly two kinds: a pending
// incoming request (a trade offered to the viewer, a challenge aimed at them) and the pending error.
// The hint bar shows Y and B for them, Y opens a request's Accept / Decline / View sheet and B at
// the world dismisses the top notice. Nothing here opens a frame or moves focus.
import type { StoreBattleChallenge, StorePlayer, StoreTradeOffer } from '../net/store';
import { list, type NavInput, type NavLayout, type NavState, navInit, navStep } from './nav';
import { incomingChallenge } from './pvpModel';
import type { Command } from './screens/types';

export type RequestKind = 'trade' | 'challenge';

export interface RequestNotice {
  readonly kind: 'request';
  /** `trade-<tradeId>` or `challenge-<challengeId>`: the Social frame's row key. */
  readonly key: string;
  readonly request: RequestKind;
  readonly id: bigint;
  /** The sender's player name, `#<hex8>` when it is empty or the player is unknown. */
  readonly fromName: string;
  readonly createdAtMs: bigint;
}

export interface ErrorNotice {
  readonly kind: 'error';
  readonly key: 'error';
}

export type Notice = RequestNotice | ErrorNotice;

export interface NoticeInput {
  readonly offers: readonly StoreTradeOffer[];
  readonly challenges: readonly StoreBattleChallenge[];
  readonly players: readonly StorePlayer[];
  readonly identity: string;
  /** Whether the error toast shows. */
  readonly errorPending: boolean;
  /** The request keys the player dismissed with B. */
  readonly dismissed: ReadonlySet<string>;
}

const ERROR_NOTICE: ErrorNotice = { kind: 'error', key: 'error' };

function nameOf(players: readonly StorePlayer[], identity: string): string {
  const name = players.find((p) => p.identity === identity)?.name ?? '';
  return name !== '' ? name : `#${identity.slice(0, 8)}`;
}

/** The oldest offer waiting on the viewer's answer. Not `shownTradeOffer`: its oldest-involving
 *  pick would hide an incoming offer behind the viewer's own outgoing one. */
function waitingOffer(offers: readonly StoreTradeOffer[], identity: string) {
  let oldest: StoreTradeOffer | undefined;
  for (const o of offers) {
    if (o.counterparty !== identity || o.status !== 'Pending') continue;
    if (
      oldest === undefined ||
      o.createdAtMs < oldest.createdAtMs ||
      (o.createdAtMs === oldest.createdAtMs && o.tradeId < oldest.tradeId)
    )
      oldest = o;
  }
  return oldest;
}

/** The requests waiting on the viewer, oldest first (a tie: the smaller key, so challenge before
 *  trade). Dismissal does not hide a request here: Y still answers one the banner no longer shows. */
export function pendingRequests(i: NoticeInput): readonly RequestNotice[] {
  const out: RequestNotice[] = [];
  const offer = waitingOffer(i.offers, i.identity);
  if (offer !== undefined) {
    out.push({
      kind: 'request',
      key: `trade-${offer.tradeId}`,
      request: 'trade',
      id: offer.tradeId,
      fromName: nameOf(i.players, offer.initiator),
      createdAtMs: offer.createdAtMs,
    });
  }
  const challenge = incomingChallenge(i.challenges, i.identity);
  if (challenge !== undefined) {
    out.push({
      kind: 'request',
      key: `challenge-${challenge.challengeId}`,
      request: 'challenge',
      id: challenge.challengeId,
      fromName: nameOf(i.players, challenge.challenger),
      createdAtMs: challenge.createdAtMs,
    });
  }
  return out.sort((a, b) =>
    a.createdAtMs !== b.createdAtMs
      ? a.createdAtMs < b.createdAtMs
        ? -1
        : 1
      : a.key < b.key
        ? -1
        : a.key > b.key
          ? 1
          : 0,
  );
}

/** The notices, top first: the error when it shows, then the oldest undismissed request. */
export function buildNotices(i: NoticeInput): readonly Notice[] {
  const request = pendingRequests(i).find((n) => !i.dismissed.has(n.key));
  const out: Notice[] = i.errorPending ? [ERROR_NOTICE] : [];
  if (request !== undefined) out.push(request);
  return out;
}

export type RequestAction = 'accept' | 'decline' | 'view';

/** The sheet's rows, Accept first: Y then Enter accepts. */
export const requestSheetLayout: NavLayout = list([
  { key: 'accept', enabled: true },
  { key: 'decline', enabled: true },
  { key: 'view', enabled: true },
]);

export interface RequestSheet {
  readonly notice: RequestNotice;
  readonly nav: NavState;
}

export const openRequestSheet = (notice: RequestNotice): RequestSheet => ({
  notice,
  nav: navInit(requestSheetLayout),
});

/** One button on an open request sheet. A runs the row under the cursor and closes, but only while
 *  the sheet's request is still among `live`: a withdrawn or replaced request closes it with nothing
 *  run. B and Start close; a held one does nothing. */
export function requestSheetStep(
  s: RequestSheet,
  btn: NavInput,
  live: readonly RequestNotice[],
): { readonly state: RequestSheet | null; readonly run?: RequestAction } {
  if (btn.button === 'B' || btn.button === 'Start')
    return btn.repeat ? { state: s } : { state: null };
  const { state: nav, outcome } = navStep(requestSheetLayout, s.nav, btn);
  if (outcome.kind !== 'activate') return { state: nav === s.nav ? s : { ...s, nav } };
  if (!live.some((n) => n.key === s.notice.key)) return { state: null };
  return { state: null, run: outcome.key as RequestAction };
}

/** The command that answers `n`. */
export function requestCommand(n: RequestNotice, action: 'accept' | 'decline'): Command {
  const accepted = action === 'accept';
  if (n.request === 'trade') return { kind: 'respondTrade', tradeId: n.id, accepted };
  return accepted
    ? { kind: 'acceptChallenge', challengeId: n.id }
    : { kind: 'declineChallenge', challengeId: n.id };
}
