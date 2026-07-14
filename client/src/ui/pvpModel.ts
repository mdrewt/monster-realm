// ui/pvpModel.ts — pure view-model for the PvP challenge overlay (m16b, ADR-0110).
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

/** A player who can be challenged (online, not self, not in a Pending challenge). */
export interface PvpChallengeablePlayer {
  readonly identity: string;
  readonly name: string;
}

export interface PvpChallengeViewModel {
  /** The first Pending challenge targeting this player, or null. */
  readonly incoming: PvpIncomingChallenge | null;
  /** This player's most-recent outgoing challenge (any status), or null. */
  readonly outgoing: PvpOutgoingChallenge | null;
  /** Online players this player can challenge (excludes self + challenge participants). */
  readonly challengeablePlayers: readonly PvpChallengeablePlayer[];
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

  // Find first Pending challenge targeting this player (incoming)
  let incoming: PvpIncomingChallenge | null = null;
  for (const c of challenges) {
    if (c.target === identity && c.status === 'Pending') {
      incoming = {
        challengeId: c.challengeId,
        challengerId: c.challenger,
        challengerName: nameMap.get(c.challenger) ?? c.challenger.slice(0, 8),
      };
      break;
    }
  }

  // Find this player's most-recent PENDING outgoing challenge.
  // "Most recent" = highest challengeId (server auto-inc, monotonic).
  // Declined/Cancelled/Accepted are terminal; the server GCs them, but we filter
  // client-side too — a non-Pending outgoing must not trigger pvpView auto-show
  // (pvpView.refresh treats vm.outgoing !== null as hasActive).
  let outgoing: PvpOutgoingChallenge | null = null;
  for (const c of challenges) {
    if (c.challenger === identity && c.status === 'Pending') {
      if (outgoing === null || c.challengeId > outgoing.challengeId) {
        outgoing = {
          challengeId: c.challengeId,
          targetId: c.target,
          targetName: nameMap.get(c.target) ?? c.target.slice(0, 8),
          status: c.status,
        };
      }
    }
  }

  // Collect identities involved in any Pending challenge (both sides)
  const busyIdentities = new Set<string>();
  busyIdentities.add(identity); // exclude self
  for (const c of challenges) {
    if (c.status === 'Pending') {
      busyIdentities.add(c.challenger);
      busyIdentities.add(c.target);
    }
  }

  // Challengeable players: online (all players in the store are loaded on join),
  // not self, not already in a Pending challenge.
  const challengeablePlayers: PvpChallengeablePlayer[] = [];
  for (const p of players) {
    if (!busyIdentities.has(p.identity) && p.online) {
      challengeablePlayers.push({ identity: p.identity, name: p.name });
    }
  }

  return { incoming, outgoing, challengeablePlayers };
}
