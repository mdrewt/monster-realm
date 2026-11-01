// ui/battlePolicy.ts — the battle base's own rules (ctl-6c), moved VERBATIM out of
// contextStack.ts (C2a — a pure move, zero semantic change): which buttons the battle answers
// before the top frame's adapter (`battleButton`, with the outcome-continue grace), which
// screen commands a battle base refuses (`COMMAND_BATTLE_POLICY`, `battleSafeCommand`,
// `battleRefused`), the bare-battle probe (`isBareBattle`) and the continued-outcome latch
// (`continuedBattleId`). Pure — no DOM, SDK, module state or clock. The stack itself, its
// transitions and SCREEN_POLICY stay in contextStack.ts.

import type { TacticalPhaseName } from '../net/rowConvert';
import type { Stack } from './contextStack';
import type { NavInput } from './nav';
import type { Command as ScreenCommand, ScreenResult } from './screens/types';

/** The battle a continued outcome dismisses (pgcc-d D3): the latest battle when it has ended,
 *  else the current dismissed id unchanged, so continuing never latches an Ongoing battle. */
export function continuedBattleId(
  latest: { readonly battleId: bigint; readonly outcome: string } | undefined,
  current: bigint | null,
): bigint | null {
  return latest !== undefined && latest.outcome !== 'Ongoing' ? latest.battleId : current;
}

/** The stack is the battle base alone: no menu, dialogue or other frame above it. */
export function isBareBattle(stack: Stack): boolean {
  return stack.length === 1 && stack[0].kind === 'battle';
}

/** How long a terminal outcome is up before A continues it: an A mashed through the battle's last
 *  turn must not skip the result. B and Start continue at once. */
export const OUTCOME_CONTINUE_GRACE_MS = 400;

/** The battle's own button rules, asked before the top frame's adapter; `undefined` leaves the
 *  button to it. Start at the bare battle base opens the main menu over the battle (CTL6C.1) —
 *  unless `tactical` (the tactical shell owns the frame, bt-11), when the adapter keeps it. A on
 *  a terminal outcome continues it once it has been up `OUTCOME_CONTINUE_GRACE_MS` (`outcomeAgeMs`,
 *  undefined while none is shown) by popping only the outcome frame, as B does, so a conversation
 *  suspended beneath it survives (CTL6C.2). A held key acts once. */
export function battleButton(
  stack: Stack,
  btn: NavInput,
  outcomeAgeMs?: number,
  tactical = false,
): ScreenResult | undefined {
  const top = stack[stack.length - 1];
  if (btn.button === 'Start' && isBareBattle(stack)) {
    // bt-11 (BT11.6): when the tactical shell owns the frame, Start is the battle adapter's (End
    // Turn / Guard on a live turn, Submit for a pre-queue); a held Start still acts once.
    if (btn.repeat) return 'consumed';
    return tactical ? undefined : { kind: 'openMenu' };
  }
  if (
    btn.button === 'A' &&
    stack[0].kind === 'world' &&
    top.kind === 'screen' &&
    top.id === 'battleView'
  ) {
    if (btn.repeat || outcomeAgeMs === undefined || outcomeAgeMs < OUTCOME_CONTINUE_GRACE_MS) {
      return 'consumed';
    }
    return { kind: 'pop' };
  }
  return undefined;
}

/** Which screen commands a battle base allows (CTL6C.3): the stack moves, the battle's own actions
 *  and ending a conversation. `pickShop` ends one only to open a shop, so it is refused. Total over
 *  the `Command` kinds, so a new arm (talk, bag use) fails client-typecheck until it is classified
 *  here. Reducer guards stay the authority. */
export const COMMAND_BATTLE_POLICY: Readonly<Record<ScreenCommand['kind'], 'safe' | 'refuse'>> = {
  pop: 'safe',
  popToBase: 'safe',
  openMenu: 'safe',
  toggleHelp: 'safe',
  care: 'refuse',
  train: 'refuse',
  evolve: 'refuse',
  setNickname: 'refuse',
  setPartySlot: 'refuse',
  healParty: 'refuse',
  buy: 'refuse',
  sell: 'refuse',
  respondTrade: 'refuse',
  confirmTrade: 'refuse',
  cancelTrade: 'refuse',
  proposeTrade: 'refuse',
  challenge: 'refuse',
  acceptChallenge: 'refuse',
  declineChallenge: 'refuse',
  cancelChallenge: 'refuse',
  setProfileName: 'refuse',
  attack: 'safe',
  flee: 'safe',
  swap: 'safe',
  recruit: 'safe',
  useItem: 'safe',
  pvpAttack: 'safe',
  pvpSwap: 'safe',
  submitQueue: 'safe',
  cancelQueue: 'safe',
  deployUnits: 'safe',
  advanceDialogue: 'refuse',
  dismissDialogue: 'safe',
  pickShop: 'refuse',
  claimSignIn: 'refuse',
  claimJoin: 'refuse',
  claimDecline: 'refuse',
  deleteAccount: 'refuse',
  cancelAccountDeletion: 'refuse',
  requestDataExport: 'refuse',
};

/** Whether a battle base allows `command`: the one read of the policy table. */
export function battleSafeCommand(command: ScreenCommand): boolean {
  return COMMAND_BATTLE_POLICY[command.kind] === 'safe';
}

/** Whether `command` must be refused now: the stack holds a battle base and the command is not
 *  battle-safe. */
export function battleRefused(stack: Stack, command: ScreenCommand): boolean {
  return stack[0].kind === 'battle' && !battleSafeCommand(command);
}

// --- bt-12: which view owns the `battleView` frame, and the results countdown ------------------

/** The view that owns the battle frame for a tactical phase: no tactical row → the 1v1 view;
 *  Deploying → the deploy panel; Active → the tactical shell (the continuation; A keeps the 1v1 view
 *  there); Finished → the results panel. Total over the phase names; an unknown phase still shows a
 *  battle (B17). */
export type BattleRenderer = 'legacy' | 'deploy' | 'tactical' | 'results';
export function battleRenderer(phase: TacticalPhaseName | undefined): BattleRenderer {
  switch (phase) {
    case undefined:
      return 'legacy';
    case 'Deploying':
      return 'deploy';
    case 'Active':
      return 'tactical';
    case 'Finished':
      return 'results';
    default:
      phase satisfies never;
      return 'legacy';
  }
}

/** What the battle views share: the 1v1 view, the deploy panel and the results panel. */
export interface BattleViewLike {
  readonly visible: boolean;
  hide(): void;
}
/** Hide every VISIBLE view other than `keep` and return the ones hidden, in order. A HIDDEN view's
 *  `hide()` must never run here: the three roots share the `battleView` overlay a11y record (keyed by
 *  id), so it would tear down the shown root's dialog role and focus trap. */
export function hideOtherBattleViews(
  views: readonly (BattleViewLike | undefined)[],
  keep: BattleViewLike | undefined,
): BattleViewLike[] {
  const hidden: BattleViewLike[] = [];
  for (const view of views) {
    if (view === undefined || view === keep || !view.visible) continue;
    view.hide();
    hidden.push(view);
  }
  return hidden;
}

/** The outcome frame has been the top frame for `capMs` (the presentation results cap) and the
 *  results panel is what it shows: continue it. `outcomeShownAtMs` is null whenever the outcome is
 *  not on top, so a frame over it pauses the countdown and it restarts when the outcome resurfaces. */
export function shouldAutoContinue(
  outcomeShownAtMs: number | null,
  nowMs: number,
  resultsShown: boolean,
  capMs: number,
): boolean {
  return outcomeShownAtMs !== null && resultsShown && nowMs - outcomeShownAtMs >= capMs;
}

/** The bigint-safe structural compare the deploy and results panels skip a no-op paint with (a
 *  `JSON.stringify` would throw on a bigint): plain data only — primitives, arrays and plain objects. */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => structurallyEqual(x, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const rb = b as Record<string, unknown>;
  return ka.every(
    (k) => Object.hasOwn(rb, k) && structurallyEqual((a as Record<string, unknown>)[k], rb[k]),
  );
}
