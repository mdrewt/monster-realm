// ui/leaderboardModel.ts — pure view model for the ranked leaderboard overlay (m17b, ADR-0120).
//
// No DOM, no SDK, no side-effects. Never throws on any input — a throw
// here would starve sibling store batch-listeners (store.ts one-way flow).
//
// The profile table is PUBLIC (world-readable leaderboard — RL-13) and this model
// is a pure subscription view with NO write path (RL-15, ADR-0014).
// Comparator (ADR-0120): a strict TOTAL order so ANY input order yields identical
// output — rating desc, then RAW name asc via code-unit ternary compare (never
// localeCompare/Intl: locale collation is platform-dependent and non-deterministic),
// then identity hex asc (the PK makes the order total). The '#<hex8>' fallback for
// empty names is display-only; the tie-break always uses the raw name.
import type { StoreProfile } from '../net/store';

/** One leaderboard row, ready to render (all numbers — no bigints in profile rows). */
export interface LeaderboardRowViewModel {
  readonly identityHex: string;
  readonly displayName: string;
  readonly rating: number;
  readonly wins: number;
  readonly losses: number;
  readonly isOwn: boolean;
}

export interface LeaderboardViewModel {
  readonly rows: readonly LeaderboardRowViewModel[];
  readonly isEmpty: boolean;
}

/** rating desc → raw name asc (code-unit) → identity hex asc. Total order. */
function compareProfiles(a: StoreProfile, b: StoreProfile): number {
  if (a.rating !== b.rating) return b.rating - a.rating;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  // Equal identities return 0 (comparator contract): unreachable with the server
  // PK, but Array.sort requires compare(a, a) >= 0 and the ADR claims total order.
  return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
}

/**
 * Build the leaderboard view model from profile rows. Sorts a COPY — the input
 * may be a frozen/store-owned array and is never mutated in place.
 * `identity === ''` (pre-onReady) matches no row: identities are non-empty hex.
 */
export function buildLeaderboardViewModel(
  profiles: readonly StoreProfile[],
  identity: string,
): LeaderboardViewModel {
  const sorted = [...profiles].sort(compareProfiles);
  const rows = sorted.map(
    (p): LeaderboardRowViewModel => ({
      identityHex: p.identity,
      // Display fallback only — the comparator above uses the RAW name.
      displayName: p.name !== '' ? p.name : `#${p.identity.slice(0, 8)}`,
      rating: p.rating,
      wins: p.wins,
      losses: p.losses,
      isOwn: p.identity === identity,
    }),
  );
  return { rows, isEmpty: rows.length === 0 };
}
