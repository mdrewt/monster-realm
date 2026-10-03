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

/** A player who can be challenged (online, not self, not in a Pending challenge). */
export interface PvpChallengeablePlayer {
  readonly identity: string;
  readonly name: string;
}

export interface PvpChallengeViewModel {
  /** The oldest Pending challenge targeting this player, or null. */
  readonly incoming: PvpIncomingChallenge | null;
  /** This player's most-recent Pending outgoing challenge, or null. */
  readonly outgoing: PvpOutgoingChallenge | null;
  /** Online players this player can challenge (excludes self + challenge participants). */
  readonly challengeablePlayers: readonly PvpChallengeablePlayer[];
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
