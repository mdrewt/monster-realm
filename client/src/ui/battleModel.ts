// ui/battleModel.ts — the pure battle-frame decisions the client still makes (bt-17 slimmed it).
//
// No DOM, no SDK, no side effects. The 1v1 view-model (`buildBattleViewModel`, cards, skills,
// bench, bag, the PvP secret pick, the VM-compare guard, the command cursor) left with the 1v1
// renderer in bt-17 (BT17.1); what stays is used by the tactical frame: `isPvpBattle` (the PvP-vs-wild
// classifier, re-exported by eventRing.ts), `decideBattleOverlay` (the outcome-frame lifecycle
// `reconcileStack` and `refreshBattle` share), `buildBaitItems` (the tactical VM's baits) and
// `CursorDir` (the battle adapter's D-pad token, also `tactics/boardModel.ts`'s `Dir`).
import type { StoreBattle, StoreInventory, StoreItemRow } from '../net/store';

/**
 * Canonical PvP-vs-wild classifier (SSOT — was duplicated in eventRing.ts
 * and inline here). True iff a battle is player-vs-player: the opponent must have
 * an owned party (`opponentMonsterIds.length > 0`) AND a distinct identity. The
 * party guard is REQUIRED: a wild battle carries the all-zero WILD_IDENTITY
 * (which is `!==` the player identity) but has no owned opponent monsters — so
 * identity-inequality alone mislabels every wild encounter as PvP. A practice
 * battle has `playerIdentity === opponentIdentity` (RT-M16-02). The
 * parameter is STRUCTURALLY typed (not `StoreBattle`) so eventRing.ts can
 * re-export it without coupling to net/store.
 */
export function isPvpBattle(battle: {
  readonly opponentMonsterIds: readonly unknown[];
  readonly opponentIdentity: string;
  readonly playerIdentity: string;
}): boolean {
  return battle.opponentMonsterIds.length > 0 && battle.opponentIdentity !== battle.playerIdentity;
}

/**
 * A bait item the player may apply to a recruit attempt. `recruitBonus > 0`
 * (the data-classify rule) is the ONLY criterion for inclusion — never a hardcoded item id;
 * `buildBaitItems` does not filter, the tactical VM (`main.ts` `buildTacticsVM`) does. Consumed unchanged
 * as the Recruit sub-list's option (no separate VM type).
 */
export interface BaitItem {
  readonly itemId: number;
  readonly name: string;
  readonly recruitBonus: number;
  readonly count: number;
}

/** The bait list from the player's own inventory × the item defs: one row per stack whose def
 *  exists (a missing def drops that stack), unfiltered — the tactical VM classifies by
 *  `recruitBonus > 0`. */
export function buildBaitItems(
  inventory: readonly StoreInventory[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): BaitItem[] {
  return inventory.flatMap((inv) => {
    const def = itemDefs.get(inv.itemId);
    if (!def) return [];
    return [
      { itemId: inv.itemId, name: def.name, recruitBonus: def.recruitBonus, count: inv.count },
    ];
  });
}

// ---------------------------------------------------------------------------
// M8.7e — battle-overlay decision (pure reducer for the outcome-frame lifecycle)
// ---------------------------------------------------------------------------

export type BattleOverlayAction =
  | { readonly kind: 'show'; readonly battle: StoreBattle }
  | { readonly kind: 'hide' };
export interface OverlayState {
  readonly dismissedBattleId: bigint | null;
  readonly synced: boolean;
}
export interface OverlayResult {
  readonly action: BattleOverlayAction;
  readonly dismissedBattleId: bigint | null;
  readonly synced: boolean;
}

/**
 * Pure overlay decision (no DOM, store, or timers): a (state, input) → (action,
 * nextState) reducer that decides whether the battle overlay shows a battle
 * (Ongoing auto-shows; a resolved battle shows its outcome frame) or hides — and
 * tracks the dismiss/first-sight lifecycle so a resolved outcome renders once but
 * never re-pops, and a battle already terminal at first sight (historical/stale on
 * login) is pre-dismissed rather than popped. (EARS §3.)
 */
export function decideBattleOverlay(
  latest: StoreBattle | undefined,
  state: OverlayState,
): OverlayResult {
  // 1. No battle for this player → hide, state untouched.
  if (latest === undefined) {
    return {
      action: { kind: 'hide' },
      dismissedBattleId: state.dismissedBattleId,
      synced: state.synced,
    };
  }
  // 2. First battle observed this session (synced becomes true).
  if (!state.synced) {
    // A row already terminal at first sight is historical → pre-dismiss, don't pop.
    if (latest.outcome !== 'Ongoing') {
      return { action: { kind: 'hide' }, dismissedBattleId: latest.battleId, synced: true };
    }
    return {
      action: { kind: 'show', battle: latest },
      dismissedBattleId: state.dismissedBattleId,
      synced: true,
    };
  }
  // 3. Steady state: a dismissed (or pre-dismissed) battle stays hidden; anything
  //    else shows (Ongoing auto-shows; a mid-session terminal shows its outcome).
  if (state.dismissedBattleId === latest.battleId) {
    return { action: { kind: 'hide' }, dismissedBattleId: state.dismissedBattleId, synced: true };
  }
  return {
    action: { kind: 'show', battle: latest },
    dismissedBattleId: state.dismissedBattleId,
    synced: true,
  };
}

export type CursorDir = 'Up' | 'Down' | 'Left' | 'Right';
