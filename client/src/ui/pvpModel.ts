// ui/pvpModel.ts — pure view-model for the PvP challenge overlay.
//
// No DOM, no SDK, no side effects. Takes store data and returns view-models.
// PvpView renders these; the batch listener in main.ts refreshes on each batch.
import type { StoreBattleChallenge, StorePlayer } from '../net/store';

/** A PvP challenge incoming to this player. */
export interface PvpIncomingChallenge {
  readonly challengeId: bigint;
  readonly challengerId: string;
  readonly challengerName: string;
}

/** A PvP challenge sent by this player. */
export interface PvpOutgoingChallenge {
  readonly challengeId: bigint;
  readonly targetId: string;
  readonly targetName: string;
  /** 'Pending' | 'Accepted' | 'Declined' | 'Cancelled' */
  readonly status: string;
}

export interface PvpChallengeViewModel {
  /** The oldest Pending challenge targeting this player, or null. */
  readonly incoming: PvpIncomingChallenge | null;
  /** This player's most-recent Pending outgoing challenge, or null. */
  readonly outgoing: PvpOutgoingChallenge | null;
}

/** The request the Challenges panel shows: the OLDEST Pending challenge targeting `identity` (the
 *  lowest challengeId; the server's auto-inc is monotonic). The Social frame's Challenges rows
 *  select through this and `outgoingChallenge` too, so a row is always the block the panel shows. */
export function incomingChallenge(
  challenges: readonly StoreBattleChallenge[],
  identity: string,
): StoreBattleChallenge | undefined {
  let oldest: StoreBattleChallenge | undefined;
  for (const c of challenges) {
    if (c.target !== identity || c.status !== 'Pending') continue;
    if (oldest === undefined || c.challengeId < oldest.challengeId) oldest = c;
  }
  return oldest;
}

/** `identity`'s most recent Pending outgoing challenge (the highest challengeId). */
export function outgoingChallenge(
  challenges: readonly StoreBattleChallenge[],
  identity: string,
): StoreBattleChallenge | undefined {
  let newest: StoreBattleChallenge | undefined;
  for (const c of challenges) {
    if (c.challenger !== identity || c.status !== 'Pending') continue;
    if (newest === undefined || c.challengeId > newest.challengeId) newest = c;
  }
  return newest;
}

/**
 * Build the PvP challenge overlay VM.
 *
 * @param challenges - All battle_challenge rows from the store (public table)
 * @param identity   - Own identity hex string
 * @param players    - All player rows (for name resolution)
 */
export function buildPvpChallengeViewModel(
  challenges: readonly StoreBattleChallenge[],
  identity: string,
  players: readonly StorePlayer[],
): PvpChallengeViewModel {
  // Build name lookup map (identity hex → name)
  const nameMap = new Map<string, string>();
  for (const p of players) {
    nameMap.set(p.identity, p.name);
  }

  const request = incomingChallenge(challenges, identity);
  const incoming: PvpIncomingChallenge | null =
    request === undefined
      ? null
      : {
          challengeId: request.challengeId,
          challengerId: request.challenger,
          challengerName: nameMap.get(request.challenger) ?? request.challenger.slice(0, 8),
        };

  // Declined/Cancelled/Accepted are terminal; the server GCs them, but the selector filters
  // client-side too — a non-Pending outgoing must not read as an active challenge
  // (pvpView.refresh treats vm.outgoing !== null as hasActive).
  const sent = outgoingChallenge(challenges, identity);
  const outgoing: PvpOutgoingChallenge | null =
    sent === undefined
      ? null
      : {
          challengeId: sent.challengeId,
          targetId: sent.target,
          targetName: nameMap.get(sent.target) ?? sent.target.slice(0, 8),
          status: sent.status,
        };

  return { incoming, outgoing };
}

// --- bt-15 (BT15.1): the party-size pick -----------------------------------------------------------

/** Mirror of server-module/src/pvp.rs `PVP_FORMAT_MAX` (R-bt-14-FORMATRULE stays open — a DISCLOSED
 *  deviation from "rules out" until `pvp_deploy_count` / `challenge_format` / `PVP_FORMAT_MAX` move to
 *  game-core behind a client-wasm export, a follow-up outside bt-15 increment A's touches; the server
 *  validates every challenge). The server derives `battle_challenge.format = min(len, PVP_FORMAT_MAX)`
 *  from the committed list's LENGTH, so the pick is the length of the list `challengePvp` sends. */
export const PVP_FORMAT_MAX = 3;

/** What the pick reads of an own monster row. */
export interface PartyPickRow {
  readonly monsterId: bigint;
  readonly partySlot: number;
  readonly currentHp: number;
}

/** The monsters a challenge may commit, in ASCENDING party-slot order (never the store's order):
 *  party-slotted (`partySlot !== partySlotNone`), conscious (`currentHp > 0`) and not in `excluded`
 *  (the player's open trade, either side of it — `challenge_pvp` refuses a traded monster).
 *  NARROWER than the server's acceptance set on purpose (a DISCLOSED client rule, not a mirror):
 *  `challenge_pvp` has no HP check, but a fainted monster committed to the list would raise the
 *  format above what the side can field (`pvp_deploy_count` = min(format, conscious)), so it is
 *  never offered; the server validates whatever is sent. */
export function consciousPartyIds(
  monsters: readonly PartyPickRow[],
  excluded: ReadonlySet<bigint>,
  partySlotNone: number,
): bigint[] {
  return monsters
    .filter((m) => m.partySlot !== partySlotNone && m.currentHp > 0 && !excluded.has(m.monsterId))
    .sort((a, b) => a.partySlot - b.partySlot)
    .map((m) => m.monsterId);
}

/** The sizes the Challenge confirm offers, LARGEST FIRST (the first row is the default — "ranked is
 *  3"): `[min(PVP_FORMAT_MAX, eligible), …, 1]`; empty when nothing is eligible. */
export function challengeSizes(eligible: number): number[] {
  const top = Math.min(PVP_FORMAT_MAX, Math.floor(eligible));
  const out: number[] = [];
  for (let n = top; n >= 1; n -= 1) out.push(n);
  return out;
}
