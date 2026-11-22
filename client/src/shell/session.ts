// shell/session — the link to the server: the store, the identity, the connection handle,
// hydration, the guarded send and the session-event latches. Every other module reads the store
// through its own methods and the bindings here through their imports. Only this module assigns
// the bindings it declares: another module changes one by calling a function here. `main.ts`
// mounts the connection it opens (`adoptConnection`), reports the connection's lifecycle
// (`adoptIdentity`, `markReady`, `noteHydrated`, `clearHydration`, `armEmitReseed`), resets the
// latches with the prediction state (`resetEmitLatches`) and registers the two latch steps
// (`stepBattleEmit`, `stepRankedEmit`) as batch listeners. Module scope constructs the store and
// the ready promise: it registers no listener, writes nothing to the document and resolves no
// catalog string.

import type { connect } from '../net/connection';
import { AuthoritativeStore } from '../net/store';
import {
  armReseed,
  BATTLE_EMIT_INITIAL,
  type BattleEmitState,
  battleEmitStep,
  rankedStep,
  resetBattleEmit,
} from '../ui/battleEmitModel';
import type { OutcomeLine } from '../ui/boxView';
import type { SinkKind } from '../ui/feedbackPolicy';
import { tf } from '../ui/i18n/resolver';
import { reduceErrorMessage } from '../ui/statusModel';
import { STEP_MS } from './config';
import { eventRing, reportError } from './feedback';

// stepMs injected so the store can do burst detection + jitter EWMA.
export const store = new AuthoritativeStore(STEP_MS);

// The identity of the current connection, '' until the first join. A rebuild can mint a new one.
export let identity = '';
/** Take the identity the connection reports, on the first join and on every reconnect. */
export function adoptIdentity(id: string): void {
  identity = id;
}

// The connection handle, `undefined` until `main()` mounts the one it opened.
export let conn: ReturnType<typeof connect> | undefined;
/** Mount the connection `main()` opened. */
export function adoptConnection(link: ReturnType<typeof connect>): void {
  conn = link;
}

// Cleared on every reconnect (`clearHydration`) and set once the store holds the applied snapshot
// (`noteHydrated`): a pending battle reseed resolves only on a flush after it, so a partial
// hydration cannot burn it.
export let hydratedSinceReconnect = false;
/** The store holds this connection's applied snapshot. */
export function noteHydrated(): void {
  hydratedSinceReconnect = true;
}
/** A reconnect: the next snapshot is still to arrive. */
export function clearHydration(): void {
  hydratedSinceReconnect = false;
}

// `ready` resolves on the first join and stays resolved for the life of the page.
export let resolveReady: () => void = () => {};
export const ready = new Promise<void>((r) => {
  resolveReady = r;
});
/** The first join completed: resolve `ready`. */
export function markReady(): void {
  resolveReady();
}

// True while the session terminal (expired / unreachable) owns the
// screen. sessionView is registry-EXTERNAL, so the overlay probes cannot see it — this predicate
// is the ONE SSOT the keydown handler AND the frame loop both consult, checked first on every
// input path. `hidden` is the ordinary case and must NOT block.
export function sessionGateBlocks(): boolean {
  const s = conn?.sessionState();
  return s !== undefined && s !== 'hidden';
}

// A missing live handle is a NON-DELIVERY. sendGuarded cannot see it — `undefined?.catch()`
// is silent — so inFlight would stick forever and every later click would be a silent no-op.
export function privacyLinkLive(): boolean {
  return conn?.live() !== undefined && !conn.linkFrozen();
}

/**
 * Non-movement reducer send guard. While the link is frozen it
 * SHORT-CIRCUITS with "disconnected — try again" and NEVER calls the reducer: a call
 * against a dead conn is silently queued on the dead instance and its promise never
 * settles (no-settle-on-drop) — the dead-button black hole. Otherwise it attaches
 * the rejection route: reduceErrorMessage passes SenderError reasons through and
 * never leaks InternalError detail. Documented exceptions: enqueueMove
 * (movement — silent prediction repair in sendIntent, M2 §3), the join (conn.join() — its
 * failures surface from connection.ts), and the overlay-feedback actions (care, shop buy/sell,
 * rename — routed through performCare).
 * ALWAYS resolves (frozen, dead handle, reported rejection) — views holding an
 * in-flight lock `return` it so the lock lives exactly until the call settles.
 * `onRejected` threads a settled rejection out to the caller (a rejected challenge
 * answer releases its answeredRequests key); the frozen and dead-handle arms never
 * call it — no reducer ran, nothing settled. `line` is the sending frame's outcome line, where
 * both failure arms report instead of the policy channel while it still paints.
 */
export function sendGuarded(
  where: SendWhere,
  call: () => Promise<void> | undefined,
  onRejected?: () => void,
  line?: OutcomeLine,
): Promise<void> {
  if (conn === undefined || conn.linkFrozen()) {
    reportError('link-down-send', tf('chrome.status.disconnected', { where }), line);
    return Promise.resolve();
  }
  const p = call();
  if (p === undefined) return Promise.resolve();
  return p.catch((err: unknown) => {
    reportError(SEND_REJECT_KIND[where], reduceErrorMessage(err, where), line);
    onRejected?.();
  });
}

/** Every `sendGuarded` site, and the message kind its rejection is (the channel table). */
const SEND_REJECT_KIND = {
  talk: 'world-send-rejected',
  dismiss: 'world-send-rejected',
  advance: 'world-send-rejected',
  ackEvolutionNotices: 'world-send-rejected',
  train: 'feed-rejected',
  evolve: 'evolve-rejected',
  nickname: 'nickname-rejected',
  party: 'party-move-rejected',
  heal: 'heal-rejected',
  'pvp-challenge': 'pvp-rejected',
  'pvp-accept': 'pvp-rejected',
  'pvp-decline': 'pvp-rejected',
  'pvp-cancel': 'pvp-rejected',
  'submit-queue': 'pvp-rejected',
  'cancel-queue': 'battle-command-rejected',
  forfeit: 'battle-command-rejected',
  'deploy-units': 'battle-command-rejected',
  'trade-open': 'trade-rejected',
  'trade-offer': 'trade-rejected',
  'trade-confirm': 'trade-rejected',
  'trade-cancel': 'trade-rejected',
} as const satisfies Record<string, SinkKind>;
export type SendWhere = keyof typeof SEND_REJECT_KIND;

/**
 * The live reducer handle for a performCare `call` thunk, or `undefined` when the link is
 * frozen/disconnected — a call against a dead conn is silently queued and never settles, so
 * performCare must see `undefined` and show the disconnected line instead of hanging.
 */
export function liveReducers() {
  return conn === undefined || conn.linkFrozen() ? undefined : conn.live()?.reducers;
}

// event-emit latches (rules: ui/battleEmitModel.ts). `battleEmit` is the battleStart/battleEnd
// latch, `lastOwnRating` baselines the ranked-delta detector. Both re-baseline on a reconnect
// and on a zone switch (`resetEmitLatches`) — the RINGS do NOT reset.
export let battleEmit: BattleEmitState = BATTLE_EMIT_INITIAL;
export let lastOwnRating: number | null = null;
/** A reconnect arms the battle reseed: a battle that survives the drop is re-baselined on the
 *  first hydrated batch instead of emitting battleStart again. */
export function armEmitReseed(): void {
  battleEmit = armReseed(battleEmit);
}
/** Re-baseline both latches. No battle is carried across the reset, and the rating baseline is
 *  re-seeded from the first fresh batch. */
export function resetEmitLatches(): void {
  battleEmit = resetBattleEmit(battleEmit);
  lastOwnRating = null;
}

/** The batch listener that steps the battleStart / battleEnd latch. Unconditional: no view's
 *  visibility gates it. */
export function stepBattleEmit(): void {
  if (identity === '') return;
  try {
    const next = battleEmitStep(battleEmit, {
      hydrated: hydratedSinceReconnect,
      latest: store.latestPlayerBattle(identity),
    });
    battleEmit = next.state;
    if (next.emit) eventRing.push(next.emit);
  } catch (err) {
    console.error('[obs] battle', err);
  }
}

/** The batch listener that steps the rankedMatch latch. Its own listener, apart from the
 *  visibility-gated leaderboard refresh. */
export function stepRankedEmit(): void {
  if (identity === '') return;
  try {
    const prof = store.profile(identity);
    if (!prof) return;
    const next = rankedStep({
      lastRating: lastOwnRating,
      rating: prof.rating,
      latest: store.latestPlayerBattle(identity),
    });
    lastOwnRating = next.lastRating;
    if (next.emit) eventRing.push(next.emit);
  } catch (err) {
    console.error('[obs] ranked', err);
  }
}
