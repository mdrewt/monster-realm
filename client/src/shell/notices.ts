// shell/notices — the trade and challenge requests waiting on this client: the request keys the
// player dismissed, those already announced and those answered, the sessions whose editor this
// client opened, the notice input built from them and the store, the requests still waiting on an
// answer and the line a request reads. Only this module changes the four sets: every other module
// calls its owner functions, and reads the announced and answered keys through read-only views.
// Module scope builds the four empty sets and nothing else: it registers nothing, writes nothing to
// the document and resolves no string.
import { tf } from '../ui/i18n/resolver';
import { type NoticeInput, pendingRequests, type RequestNotice } from '../ui/noticeModel';
import { identity, store } from './session';
import { errorOverlayView, evolutionNoticeBanner } from './views';

/** The sessions this client has opened its editor on: an incoming one stops being a request. */
const openedTradeSessions = new Set<bigint>();

/** The request keys the player dismissed with B, and those already announced. A new session
 *  forgets both: a request still waiting after a reconnect shows and is announced again. */
const dismissedRequests = new Set<string>();
const announced = new Set<string>();
export const announcedRequests: ReadonlySet<string> = announced;
/** The requests this client has answered (from the world sheet or Social): out of `pending` and
 *  the banner until the server row changes, so a second Y then Enter never answers twice. */
const answered = new Set<string>();
export const answeredRequests: ReadonlySet<string> = answered;

/** This client answers the request `key`: it stays out of the pending requests and the banner
 *  until the server row changes or `releaseAnswered` runs. */
export function markAnswered(key: string): void {
  answered.add(key);
}

/** C5: a REJECTED answer changed no server row — the request is still Pending, so the optimistic
 *  `answeredRequests` key is released and the banner, badges and Y answer it again. Handed to the
 *  answer arms' helper (`sendGuarded`'s third argument), which is the only place the rejection is
 *  observable: it reports it and resolves. */
export const releaseAnswered = (key: string) => (): void => {
  answered.delete(key);
};

/** The player dismissed the request `key` with B. */
export function dismissRequest(key: string): void {
  dismissedRequests.add(key);
}

/** The request `key` counts as announced: its arrival is not announced again. */
export function markAnnounced(key: string): void {
  announced.add(key);
}

/** A new session: the dismissed, announced and answered keys are forgotten. */
export function forgetRequests(): void {
  dismissedRequests.clear();
  announced.clear();
  answered.clear();
}

/** The editor opened on session `sessionId`: it stops being a request on this client. */
export function markSessionOpened(sessionId: bigint): void {
  openedTradeSessions.add(sessionId);
}

/** The trade-session state is reset: no session counts as opened. */
export function forgetOpenedSessions(): void {
  openedTradeSessions.clear();
}

/** Session `sessionId` left the player's sessions: it leaves the opened sessions, and its request
 *  key leaves the dismissed, announced and answered keys. */
export function forgetClosedSession(sessionId: bigint): void {
  const key = `session-${sessionId}`;
  openedTradeSessions.delete(sessionId);
  dismissedRequests.delete(key);
  announced.delete(key);
  answered.delete(key);
}

export function noticeInput(): NoticeInput {
  return {
    sessions: store.allTradeSessions(),
    opened: openedTradeSessions,
    challenges: store.allChallenges(),
    players: store.allPlayers(),
    identity,
    errorPending: errorOverlayView?.visible ?? false,
    evolutionPending: evolutionNoticeBanner?.visible ?? false,
    dismissed:
      answeredRequests.size === 0
        ? dismissedRequests
        : new Set([...dismissedRequests, ...answeredRequests]),
  };
}

/** The requests still waiting on an answer from this client. */
export function livePending(): readonly RequestNotice[] {
  return pendingRequests(noticeInput()).filter((n) => !answeredRequests.has(n.key));
}

/** The banner's and the announcement's line for a request; it names no key (a remap keeps it true).
 *  A notice standing for several trade requests reads their count. */
export const requestLine = (n: RequestNotice): string =>
  n.request !== 'trade'
    ? tf('notice.request.challenge', { name: n.fromName })
    : n.count !== undefined
      ? tf('notice.request.trades', { count: n.count })
      : tf('notice.request.trade', { name: n.fromName });
