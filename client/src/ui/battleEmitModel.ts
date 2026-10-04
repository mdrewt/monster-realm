// The battleStart / battleEnd and rankedMatch event-emit latches (pgcc-c). Pure — no DOM, SDK,
// module state or clock. main.ts feeds each step the store's latest battle (and own rating) on
// every batch and pushes the one emit it returns onto the event ring.

import { isPvpBattle } from './battleModel';
import {
  makeBattleEnd,
  makeBattleStart,
  makeRankedMatch,
  type PlaytestEventPayload,
} from './eventRing';

/** The fields of a store battle row the latches read (StoreBattle satisfies it structurally). */
export interface BattleSummary {
  readonly battleId: bigint;
  /** The SERVER-side tag ('Ongoing', 'SideAWins', …). */
  readonly outcome: string;
  readonly turnNumber: number;
  readonly opponentMonsterIds: readonly unknown[];
  readonly opponentIdentity: string;
  readonly playerIdentity: string;
}

export interface BattleEmitState {
  /** The battle the latch saw START: battleEnd fires only for it (a battle first seen already
   *  terminal emits nothing). */
  readonly activeBattleId: bigint | null;
  /** Armed on reconnect: a still-Ongoing battle that survived the drop must not re-emit
   *  battleStart. Resolved only by a flush after hydration-complete, so a partial hydration
   *  cannot burn it. */
  readonly reseedPending: boolean;
  /** The drop-time battle: only ITS re-sighting is silent. */
  readonly reseedPrevBattleId: bigint | null;
}

export const BATTLE_EMIT_INITIAL: BattleEmitState = {
  activeBattleId: null,
  reseedPending: false,
  reseedPrevBattleId: null,
};

export interface BattleEmitResult {
  readonly state: BattleEmitState;
  readonly emit?: PlaytestEventPayload;
}

/** One batch. `hydrated` (the store holds the applied snapshot since the last reconnect) is read
 *  only while a reseed is pending; post-hydration an undefined `latest` is definitive (no battle
 *  rows) and resolves it. */
export function battleEmitStep(
  state: BattleEmitState,
  input: { readonly hydrated: boolean; readonly latest: BattleSummary | undefined },
): BattleEmitResult {
  const { latest } = input;
  let next = state;
  if (next.reseedPending) {
    if (!input.hydrated) return { state };
    const survivedId = next.reseedPrevBattleId;
    next = { ...next, reseedPending: false, reseedPrevBattleId: null };
    if (latest?.outcome === 'Ongoing' && latest.battleId === survivedId) {
      return { state: { ...next, activeBattleId: latest.battleId } };
    }
  }
  if (!latest) return { state: next };
  if (latest.outcome === 'Ongoing' && latest.battleId !== next.activeBattleId) {
    // isPvpBattle, not identity inequality: a wild battle carries the all-zero WILD_IDENTITY
    // (!== the player) but no owned opponent party.
    return {
      state: { ...next, activeBattleId: latest.battleId },
      emit: makeBattleStart(latest.battleId.toString(), isPvpBattle(latest)),
    };
  }
  if (latest.outcome !== 'Ongoing' && latest.battleId === next.activeBattleId) {
    // The outcome is the SERVER tag (SideA is always the challenger) and is deliberately NOT
    // perspective-mapped, so a PvP accepter's ring records SideAWins for their own loss: two
    // players' event rings and bug bundles must agree on who won.
    return {
      state: { ...next, activeBattleId: null },
      emit: makeBattleEnd(latest.battleId.toString(), latest.outcome, latest.turnNumber),
    };
  }
  return { state: next };
}

/** Reconnect: capture the drop-time battle only when no reseed is pending (a second drop keeps
 *  the FIRST capture), and always re-arm so the latch waits for THIS connection's hydration. */
export function armReseed(state: BattleEmitState): BattleEmitState {
  return {
    ...state,
    reseedPending: true,
    reseedPrevBattleId: state.reseedPending ? state.reseedPrevBattleId : state.activeBattleId,
  };
}

/** Reconnect or zone switch (resetPredictionState): the old battle is gone, so the latch
 *  re-baselines from the next batch. Never arms a reseed. */
export function resetBattleEmit(state: BattleEmitState): BattleEmitState {
  return { ...state, activeBattleId: null };
}

export interface RankedResult {
  readonly lastRating: number;
  readonly emit?: PlaytestEventPayload;
}

/** One batch with an own profile row: baseline on first sight (`lastRating === null`), then a
 *  rankedMatch carrying the signed delta on each change. */
export function rankedStep(input: {
  readonly lastRating: number | null;
  readonly rating: number;
  readonly latest: BattleSummary | undefined;
}): RankedResult {
  const { lastRating, rating, latest } = input;
  if (lastRating === null || rating === lastRating) return { lastRating: rating };
  // The latest battle may be a wild encounter: attach its id ONLY when it is PvP, else '' (a
  // wrong battleId corrupts the H3 correlation; the delta is the load-bearing signal).
  const battleId = latest && isPvpBattle(latest) ? latest.battleId.toString() : '';
  return { lastRating: rating, emit: makeRankedMatch(battleId, rating - lastRating) };
}
