// ui/noticeModel.ts — the world's notices and the request action sheet (ctl-13, CTL13.2, CTL13.3).
// Pure: no DOM, SDK, resolver, clock or module state. Notices are exactly two kinds: a pending
// incoming request (a trade session opened with the viewer, a challenge aimed at them) and the
// pending error. The hint bar shows Y and B for them, Y opens a request's Accept / Decline / View
// sheet and B at the world dismisses the top notice. Nothing here opens a frame or moves focus.
//
// A trade request is an incoming session the viewer has not acted in and whose editor this client
// has not opened. Accept opens that editor, Decline cancels the session. Several waiting trade
// requests show as ONE banner line (`count`), which B dismisses whole (`dismissKeys`).
import type { StoreBattleChallenge, StorePlayer, StoreTradeSession } from '../net/store';
import { CLOSE_KEY } from './actionSheetModel';
import { list, type NavInput, type NavLayout, type NavState, navInit, navStep } from './nav';
import { incomingChallenge } from './pvpModel';
import type { Command } from './screens/types';
import { incomingUntouched, ownSessions, playerName } from './tradeSessionModel';

export type RequestKind = 'trade' | 'challenge';

export interface RequestNotice {
  readonly kind: 'request';
  /** `session-<sessionId>` or `challenge-<challengeId>`: the Social frame's row key. */
  readonly key: string;
  readonly request: RequestKind;
  /** The sessionId or the challengeId. */
  readonly id: bigint;
  /** The sender's player name, `#<hex8>` when it is empty or the player is unknown. */
  readonly fromName: string;
  readonly createdAtMs: bigint;
  /** On the banner's notice when it stands for several waiting trade requests: how many (2 or
   *  more), and every key it stands for. Absent for a single request. */
  readonly count?: number;
  readonly keys?: readonly string[];
}

export interface ErrorNotice {
  readonly kind: 'error';
  readonly key: 'error';
}

export type Notice = RequestNotice | ErrorNotice;

export interface NoticeInput {
  readonly sessions: readonly StoreTradeSession[];
  /** The sessions this client has opened its editor on: they are no longer requests. */
  readonly opened: ReadonlySet<bigint>;
  readonly challenges: readonly StoreBattleChallenge[];
  readonly players: readonly StorePlayer[];
  readonly identity: string;
  /** Whether the error toast shows. */
  readonly errorPending: boolean;
  /** The request keys the player dismissed with B. */
  readonly dismissed: ReadonlySet<string>;
}

const ERROR_NOTICE: ErrorNotice = { kind: 'error', key: 'error' };

/** The requests waiting on the viewer, oldest first (a tie: the smaller key, so challenge before
 *  session). Dismissal does not hide a request here: Y still answers one the banner no longer shows. */
export function pendingRequests(i: NoticeInput): readonly RequestNotice[] {
  const out: RequestNotice[] = [];
  for (const session of ownSessions(i.sessions, i.identity)) {
    if (!incomingUntouched(session, i.identity) || i.opened.has(session.sessionId)) continue;
    out.push({
      kind: 'request',
      key: `session-${session.sessionId}`,
      request: 'trade',
      id: session.sessionId,
      fromName: playerName(i.players, session.opener),
      createdAtMs: session.createdAtMs,
    });
  }
  const challenge = incomingChallenge(i.challenges, i.identity);
  if (challenge !== undefined) {
    out.push({
      kind: 'request',
      key: `challenge-${challenge.challengeId}`,
      request: 'challenge',
      id: challenge.challengeId,
      fromName: playerName(i.players, challenge.challenger),
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

/** The notices, top first: the error when it shows, then the oldest undismissed request. When that
 *  request is a trade and more undismissed trade requests wait, it stands for all of them. */
export function buildNotices(i: NoticeInput): readonly Notice[] {
  const shown = pendingRequests(i).filter((n) => !i.dismissed.has(n.key));
  const out: Notice[] = i.errorPending ? [ERROR_NOTICE] : [];
  const request = shown[0];
  if (request === undefined) return out;
  const trades = request.request === 'trade' ? shown.filter((n) => n.request === 'trade') : [];
  out.push(
    trades.length >= 2
      ? { ...request, count: trades.length, keys: trades.map((n) => n.key) }
      : request,
  );
  return out;
}

/** The request keys B on `notice` dismisses: every key a collapsed line stands for, else its own. */
export const dismissKeys = (notice: Notice): readonly string[] =>
  notice.kind === 'request' && notice.keys !== undefined ? notice.keys : [notice.key];

export type RequestAction = 'accept' | 'decline' | 'view';

/** The sheet's rows, Accept first: Y then Enter accepts. Close last (uif-12, UIF12.2): A there is
 *  B's step, for the pointer player who has no B. */
export const requestSheetLayout: NavLayout = list([
  { key: 'accept', enabled: true },
  { key: 'decline', enabled: true },
  { key: 'view', enabled: true },
  { key: CLOSE_KEY, enabled: true },
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
 *  run. A on the Close row, B and Start close without looking at `live`; a held one does nothing. */
export function requestSheetStep(
  s: RequestSheet,
  btn: NavInput,
  live: readonly RequestNotice[],
): { readonly state: RequestSheet | null; readonly run?: RequestAction } {
  if (btn.button === 'B' || btn.button === 'Start')
    return btn.repeat ? { state: s } : { state: null };
  const { state: nav, outcome } = navStep(requestSheetLayout, s.nav, btn);
  if (outcome.kind !== 'activate') return { state: nav === s.nav ? s : { ...s, nav } };
  if (outcome.key === CLOSE_KEY) return { state: null };
  if (!live.some((n) => n.key === s.notice.key)) return { state: null };
  return { state: null, run: outcome.key as RequestAction };
}

/** The command that answers `n`. A trade session has no accept step of its own: Accept opens its
 *  editor (where the viewer makes their offer) and Decline cancels the session. */
export function requestCommand(n: RequestNotice, action: 'accept' | 'decline'): Command {
  const accepted = action === 'accept';
  if (n.request === 'trade') {
    return accepted
      ? { kind: 'openTradeEditor', sessionId: n.id }
      : { kind: 'cancelTradeSession', sessionId: n.id };
  }
  return accepted
    ? { kind: 'acceptChallenge', challengeId: n.id }
    : { kind: 'declineChallenge', challengeId: n.id };
}
