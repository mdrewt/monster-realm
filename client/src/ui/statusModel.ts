// ui/statusModel.ts — pure status-message view model.
//
// Reduces SDK reducer-promise rejections and subscription-error payloads to the
// user-visible status-line strings. LAYERING NOTE: this is a pure MODEL (no DOM,
// no SDK import, no timers) — net/connection.ts may import it without creating a
// net→view dependency; the DOM write (textContent) lives in main.ts's reportError.

/** The three routing buckets a rejection can land in (internal — unexported). */
type ErrorKind = 'sender' | 'internal' | 'unknown';

/**
 * Classify via `err.name` EQUALITY, not `instanceof`: the SDK's
 * SenderError/InternalError classes may be duplicated across bundle chunks or
 * realms, where `instanceof` silently fails; the `name` string survives both.
 * No dynamic RegExp anywhere (project ban).
 */
function classifyReducerError(err: unknown): ErrorKind {
  if (typeof err === 'object' && err !== null) {
    const name = (err as { name?: unknown }).name;
    if (name === 'SenderError') return 'sender';
    if (name === 'InternalError') return 'internal';
  }
  return 'unknown';
}

/**
 * Reduce a reducer-promise rejection to the status-line text. TOTAL and NEVER
 * empty (the status line must never be visible-with-empty-text).
 *
 * - SenderError (a reducer `Err(...)` — the server's user-addressed reason) passes
 *   its message through: `"${where}: ${message}"`, or `"${where}: rejected"` when
 *   the message is empty/missing.
 * - InternalError → `"${where}: server error"` — the detail is NEVER included
 *   (no-leak: internal messages can carry stack/state a user must not see).
 * - Anything else → `"${where}: unexpected error"` — no String(err) coercion
 *   (no "[object Object]", no raw-string leakage).
 */
export function reduceErrorMessage(err: unknown, where: string): string {
  // try/catch (review RT-05): `.name`/`.message` may be hostile accessors (a
  // throwing getter, a Proxy trap). This function runs inside promise `.catch`
  // handlers — a throw here would escape as an unhandled rejection and the user
  // would see NO feedback at all. Total means total: a probe throw → generic.
  try {
    switch (classifyReducerError(err)) {
      case 'sender': {
        const message = (err as { message?: unknown }).message;
        if (typeof message === 'string' && message !== '') return `${where}: ${message}`;
        return `${where}: rejected`;
      }
      case 'internal':
        return `${where}: server error`;
      case 'unknown':
        return `${where}: unexpected error`;
    }
  } catch {
    return `${where}: unexpected error`;
  }
}

/**
 * Extract the user-visible message from a subscription onError context.
 * TOTAL: the SDK's ErrorContextInterface carries `ctx.event` (an Error), but
 * the shape is fallback-guarded so a payload surprise degrades to the generic
 * 'subscription error' rather than throwing inside the onError callback. Only a
 * non-empty string `event.message` passes through.
 */
export function subscriptionErrorMessage(ctx: unknown): string {
  // Same RT-05 totality guard as reduceErrorMessage: `.event`/`.message` may be
  // hostile accessors, and this runs inside the SDK's onError callback.
  try {
    if (typeof ctx === 'object' && ctx !== null) {
      const event = (ctx as { event?: unknown }).event;
      if (typeof event === 'object' && event !== null) {
        const message = (event as { message?: unknown }).message;
        if (typeof message === 'string' && message !== '') return message;
      }
    }
    return 'subscription error';
  } catch {
    return 'subscription error';
  }
}

// --- qf-6: the advance refusals that end a conversation ----------------------------------

/** Why a conversation ended on a refused `advance_dialogue` (npc.rs): the parties are too far
 *  apart, in different zones, or the NPC is gone. */
export type ConversationEndReason = 'walkedAway' | 'leftZone' | 'npcGone';

/**
 * The reason a refused advance ended the conversation, or `undefined` when the rejection is any
 * other kind. A SenderError (name EQUALITY, like `classifyReducerError`) whose message EXACTLY
 * equals one of the four npc.rs `advance_dialogue` refusal strings maps; everything else — another
 * error class carrying the same words, a near-miss spelling, the formatted `advance: …` line, a
 * non-object — does not, so main.ts never ends a conversation the server kept. TOTAL (RT-05: a
 * hostile accessor yields `undefined`, never a throw inside the rejection handler).
 */
export function conversationEndReason(err: unknown): ConversationEndReason | undefined {
  try {
    if (classifyReducerError(err) !== 'sender') return undefined;
    const message = (err as { message?: unknown }).message;
    switch (message) {
      case 'walked too far away':
        return 'walkedAway';
      case 'no longer in same zone':
        return 'leftZone';
      case 'npc not found':
      case 'npc character not found':
        return 'npcGone';
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

// --- qf-6: the quest-completion acknowledgement --------------------------------------------

/** What one applied batch says about my quests, my wallet and my conversation. */
export interface QuestAckSnapshot {
  readonly identity: string;
  /** My player_quest rows keyed by pqId: a step advance keeps its pqId, a completion removes it. */
  readonly quests: readonly { readonly pqId: bigint; readonly questId: string }[];
  /** My my_wallet balance; an ABSENT wallet is 0n — `grant_currency` inserts the row lazily, so a
   *  first reward creates it, and the server reads no row as a zero balance. */
  readonly balance: bigint;
  /** My player_conversation row is present in this batch. */
  readonly conversationOpen: boolean;
}

/** The snapshot of one applied batch, or `undefined` when the store is not `ready` (not yet
 *  hydrated after a connect, no identity) or the wallet row carries a non-bigint balance. */
export function questAckSnapshot(i: {
  readonly ready: boolean;
  readonly identity: string;
  readonly quests: readonly { readonly pqId: bigint; readonly questId: string }[];
  readonly wallet: { readonly balance: unknown } | undefined;
  readonly conversationOpen: boolean;
}): QuestAckSnapshot | undefined {
  if (!i.ready) return undefined;
  let balance = 0n;
  if (i.wallet !== undefined) {
    if (typeof i.wallet.balance !== 'bigint') return undefined;
    balance = i.wallet.balance;
  }
  return {
    identity: i.identity,
    quests: i.quests.map((q) => ({ pqId: q.pqId, questId: q.questId })),
    balance,
    conversationOpen: i.conversationOpen,
  };
}

/** A completed quest: `name` is the completed quest ids (sorted, ', '-joined — the Journal shows
 *  the id verbatim too); `reward` the gold gained across the batch, or null when none did. */
export interface QuestAck {
  readonly name: string;
  readonly reward: bigint | null;
}

/**
 * The acknowledgement one batch earns, or `undefined`. A completion is "a row of `prev` is missing
 * from `now` while my conversation row is present in `now`": `talk` is the only reducer that
 * completes a quest, and it upserts the conversation row in the same transaction, while the
 * account-deletion cascade removes the quest and conversation rows together (no completion). The
 * reward is the balance gain, which that transaction's only currency write produced.
 */
export function questCompletionAck(
  prev: QuestAckSnapshot | undefined,
  now: QuestAckSnapshot | undefined,
): QuestAck | undefined {
  if (prev === undefined || now === undefined) return undefined;
  if (prev.identity !== now.identity || !now.conversationOpen) return undefined;
  const present = new Set(now.quests.map((q) => q.pqId));
  const left = prev.quests.filter((q) => !present.has(q.pqId)).map((q) => q.questId);
  if (left.length === 0) return undefined;
  const delta = now.balance - prev.balance;
  return { name: left.sort().join(', '), reward: delta > 0n ? delta : null };
}

// --- qf-6: status notices the live region's coalescer cannot swallow -------------------------

/** A status-line notice waiting to be spoken, and what was last spoken. */
export interface StatusNoticeState {
  readonly queued: { readonly text: string; readonly queuedAtMs: number } | null;
  readonly spoken: { readonly text: string; readonly atMs: number } | null;
  readonly lastTransitionAtMs: number | null;
}

export const STATUS_NOTICE_INITIAL: StatusNoticeState = {
  queued: null,
  spoken: null,
  lastTransitionAtMs: null,
};

export type StatusNoticeEvent =
  | { readonly kind: 'queue'; readonly text: string; readonly nowMs: number }
  | { readonly kind: 'frame'; readonly nowMs: number; readonly transitionAnnounced: boolean };

/**
 * One step of the notice queue. The live region keeps only the NEWEST message announced inside a
 * `windowMs` window (A11Y-9), and an overlay's open or close label lands within a frame or a round
 * trip of a status notice — announced at once, one of the two is lost. So a notice is spoken only
 * on a frame that announced no transition, a full window after it was queued AND after the last
 * transition; and a transition that lands inside the window after a notice was spoken (the
 * coalescer dropped the notice) re-queues it, unless a newer notice is already waiting. Pure and
 * total; the clock is an argument.
 */
export function statusNoticeStep(
  state: StatusNoticeState,
  event: StatusNoticeEvent,
  windowMs: number,
): { readonly state: StatusNoticeState; readonly speak: string | null } {
  switch (event.kind) {
    case 'queue':
      return {
        state: { ...state, queued: { text: event.text, queuedAtMs: event.nowMs } },
        speak: null,
      };
    case 'frame': {
      const { nowMs } = event;
      if (event.transitionAnnounced) {
        const clobbered =
          state.queued === null && state.spoken !== null && nowMs - state.spoken.atMs < windowMs;
        return {
          state: {
            ...state,
            lastTransitionAtMs: nowMs,
            queued:
              clobbered && state.spoken !== null
                ? { text: state.spoken.text, queuedAtMs: nowMs }
                : state.queued,
          },
          speak: null,
        };
      }
      if (state.queued === null || nowMs - state.queued.queuedAtMs < windowMs) {
        return { state, speak: null };
      }
      if (state.lastTransitionAtMs !== null && nowMs - state.lastTransitionAtMs < windowMs) {
        return { state, speak: null };
      }
      const { text } = state.queued;
      return { state: { ...state, queued: null, spoken: { text, atMs: nowMs } }, speak: text };
    }
    default:
      return event satisfies never;
  }
}
