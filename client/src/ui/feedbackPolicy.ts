// ui/feedbackPolicy.ts — which channel carries each message the game shows (uif-4, UIF4.1; the
// channel table of the M-ui-foundation wireframes, wf-1). Four channels: the hint line (a frame's
// feedback strip, or the world line when no frame is open), the toast (one timed region, outcomes),
// the modal (a confirm sheet, decisions) and the blocking text box (NPC dialogue).
//
// Pure data and pure functions: no DOM, no i18n. `MessageKind` is the authority; the table is
// checked against it with `satisfies`, so a kind with no row fails typecheck.
//
// A toast is never the sole carrier of something the player must act on: an action-required row
// on the toast names the persistent on-screen state that also carries it (`alsoCarriedBy`, UIF4.6).

export type Channel = 'hint' | 'toast' | 'modal' | 'blocking';

export type MessageKind =
  // Hint line
  | 'y-description'
  | 'disabled-reason-menu'
  | 'disabled-reason-row'
  | 'capture-prompt'
  | 'controls-refused'
  | 'claim-veto'
  | 'walkup-chip'
  | 'walkup-choose'
  | 'trade-request'
  | 'challenge-request'
  | 'deletion-countdown'
  | 'privacy-notice'
  | 'world-disconnect'
  | 'connect-failure'
  | 'content-stale'
  | 'download-blocked'
  // Toast
  | 'care-success'
  | 'care-rejected'
  | 'monsters-move-ok'
  | 'feed-ok'
  | 'feed-rejected'
  | 'bag-feed-blocked'
  | 'party-full'
  | 'party-move-rejected'
  | 'nickname-rejected'
  | 'evolve-rejected'
  | 'heal-rejected'
  | 'shop-buy-ok'
  | 'shop-sell-ok'
  | 'shop-rejected'
  | 'trade-cancelled'
  | 'trade-rejected'
  | 'rename-saved'
  | 'rename-rejected'
  | 'controls-saved'
  | 'controls-cancelled'
  | 'controls-save-failed'
  | 'pvp-rejected'
  | 'link-down-send'
  | 'link-down-view'
  | 'zone-cue'
  | 'dialogue-ended'
  | 'quest-complete'
  | 'world-send-rejected'
  | 'battle-refused'
  | 'queue-too-late'
  | 'battle-command-rejected'
  // Modal
  | 'evolution-reveal'
  | 'evolve-confirm'
  | 'decline-confirm'
  | 'trade-final-confirm'
  | 'trade-send-confirm'
  | 'challenge-confirm'
  | 'buy-sell-confirm'
  | 'heal-confirm'
  | 'controls-reset-confirm'
  | 'deletion-phase-confirm'
  // Blocking text box
  | 'npc-dialogue';

export interface PolicyRow {
  readonly channel: Channel;
  /** The player must act on it (the table's "Player must act" column). */
  readonly actionRequired: boolean;
  /** For an action-required row, the on-screen state that also carries it; else null. */
  readonly alsoCarriedBy: string | null;
}

/** A row the player need not act on. The channel stays a literal type, so `SinkKind` can be
 *  derived from the table. */
const row = <C extends Channel>(channel: C) =>
  ({ channel, actionRequired: false, alsoCarriedBy: null }) as const;
/** A row the player must act on, naming the on-screen state that also carries it. */
const acts = <C extends Channel>(channel: C, carrier: string) =>
  ({ channel, actionRequired: true, alsoCarriedBy: carrier }) as const;

export const FEEDBACK_POLICY = {
  'y-description': row('hint'),
  'disabled-reason-menu': row('hint'),
  'disabled-reason-row': row('hint'),
  'capture-prompt': acts('hint', 'the capture prompt itself'),
  'controls-refused': acts('hint', 'the capture prompt still waits'),
  'claim-veto': acts('hint', 'the pending claim rows'),
  'walkup-chip': row('hint'),
  'walkup-choose': row('hint'),
  'trade-request': acts('hint', 'the notice banner and the Start-chip badge'),
  'challenge-request': acts('hint', 'the notice banner and the Start-chip badge'),
  'deletion-countdown': row('hint'),
  'privacy-notice': row('hint'),
  'world-disconnect': row('hint'),
  'connect-failure': row('hint'),
  'content-stale': acts('hint', 'the world hint line until reload'),
  'download-blocked': acts('hint', 'the world hint line until overwritten'),
  'care-success': row('toast'),
  'care-rejected': row('toast'),
  'monsters-move-ok': row('toast'),
  'feed-ok': row('toast'),
  'feed-rejected': row('toast'),
  'bag-feed-blocked': row('toast'),
  'party-full': acts('toast', 'the six filled Party slots and the Move row'),
  'party-move-rejected': row('toast'),
  'nickname-rejected': row('toast'),
  'evolve-rejected': row('toast'),
  'heal-rejected': row('toast'),
  'shop-buy-ok': row('toast'),
  'shop-sell-ok': row('toast'),
  'shop-rejected': row('toast'),
  'trade-cancelled': row('toast'),
  'trade-rejected': row('toast'),
  'rename-saved': row('toast'),
  'rename-rejected': row('toast'),
  'controls-saved': row('toast'),
  'controls-cancelled': row('toast'),
  'controls-save-failed': row('toast'),
  'pvp-rejected': row('toast'),
  'link-down-send': acts('toast', 'the world-disconnect hint line'),
  'link-down-view': acts('toast', 'the world-disconnect hint line'),
  'zone-cue': row('toast'),
  'dialogue-ended': row('toast'),
  'quest-complete': row('toast'),
  'world-send-rejected': row('toast'),
  'battle-refused': row('toast'),
  'queue-too-late': row('toast'),
  'battle-command-rejected': acts('toast', 'the command menu, re-armed for the same turn'),
  'evolution-reveal': acts('modal', 'the banner until acknowledged'),
  'evolve-confirm': acts('modal', 'the confirm sheet'),
  'decline-confirm': acts('modal', 'the confirm sheet'),
  'trade-final-confirm': acts('modal', 'the confirm sheet'),
  'trade-send-confirm': acts('modal', 'the confirm sheet'),
  'challenge-confirm': acts('modal', 'the confirm sheet'),
  'buy-sell-confirm': acts('modal', 'the confirm sheet'),
  'heal-confirm': acts('modal', 'the confirm sheet'),
  'controls-reset-confirm': acts('modal', 'the confirm sheet'),
  'deletion-phase-confirm': acts('modal', 'the confirm sheet'),
  'npc-dialogue': acts('blocking', 'the dialogue box'),
} as const satisfies Record<MessageKind, PolicyRow>;

export const MESSAGE_KINDS = Object.keys(FEEDBACK_POLICY) as readonly MessageKind[];

export function channelOf(kind: MessageKind): Channel {
  return FEEDBACK_POLICY[kind].channel;
}

/** The kinds a sink in main.ts may route (the hint line or the toast); a decision or a dialogue
 *  is never routed as a message. */
export type SinkKind = {
  [K in MessageKind]: (typeof FEEDBACK_POLICY)[K]['channel'] extends 'hint' | 'toast' ? K : never;
}[MessageKind];

/** A frame has one hint line, so hint kinds resolve by precedence (WF1-A9): an action-required
 *  hint (3), then a persistent state (2), then a disabled reason (1), then a Y-description or any
 *  other hint (0). A kind on another channel never paints on a strip (-1). */
export function hintRank(kind: MessageKind): number {
  const r = FEEDBACK_POLICY[kind];
  if (r.channel !== 'hint') return -1;
  if (r.actionRequired) return 3;
  if (kind === 'world-disconnect' || kind === 'connect-failure') return 2;
  if (kind === 'disabled-reason-menu' || kind === 'disabled-reason-row') return 1;
  return 0;
}

/** Whether `next` replaces `current` on a hint line: a higher or equal rank does (the newer of two
 *  equals wins), a lower one does not. */
export function outranks(next: MessageKind, current: MessageKind): boolean {
  return hintRank(next) >= hintRank(current);
}
