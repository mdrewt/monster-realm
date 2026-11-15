// ui/leaderboardModel.ts — pure view model for the ranked leaderboard overlay.
//
// No DOM, no SDK; the only state is the one-entry memo below, and the models it hands out are
// frozen, so no caller can change one another caller holds. Never throws on any input — a throw
// here would starve sibling store batch-listeners (store.ts one-way flow).
//
// The profile table is PUBLIC (world-readable leaderboard — RL-13) and this model
// is a pure subscription view with NO write path (RL-15).
// Comparator: a strict TOTAL order so ANY input order yields identical
// output — rating desc, then RAW name asc via code-unit ternary compare (never
// localeCompare/Intl: locale collation is platform-dependent and non-deterministic),
// then identity hex asc (the PK makes the order total). The '#<hex8>' fallback for
// empty names is display-only; the tie-break always uses the raw name.
//
// The board holds the top LEADERBOARD_TOP_K rows of that order, each with its 1-based rank, plus
// the caller's own row ranked RANK_BELOW_TOP_K when the caller ranks below them. A call that
// passes the store's `profilesVersion()` is memoised on (profilesVersion, identity) in ONE entry
// shared by every caller (the overlay and the Social Rankings tab read the same object), so a
// batch that writes no profile returns the previous model without sorting.
import type { StoreProfile } from '../net/store';

/** How many of the top-ranked profiles the board lists. */
export const LEADERBOARD_TOP_K = 100;
/** The rank shown on the caller's own row when the caller ranks below the top K. */
export const RANK_BELOW_TOP_K = '100+';

/** One leaderboard row, ready to render (all numbers — no bigints in profile rows). */
export interface LeaderboardRowViewModel {
  readonly identityHex: string;
  readonly displayName: string;
  readonly rating: number;
  readonly wins: number;
  readonly losses: number;
  readonly isOwn: boolean;
  /** The 1-based position, or RANK_BELOW_TOP_K on the caller's own row below the top K. Every row
   *  `buildLeaderboardViewModel` builds carries one; a row without it renders no rank. */
  readonly rank?: number | typeof RANK_BELOW_TOP_K;
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
  // PK, but Array.sort requires compare(a, a) >= 0 and the ordering is documented as total.
  return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
}

function toRow(
  p: StoreProfile,
  identity: string,
  rank: number | typeof RANK_BELOW_TOP_K,
): LeaderboardRowViewModel {
  return Object.freeze({
    identityHex: p.identity,
    // Display fallback only — the comparator above uses the RAW name.
    displayName: p.name !== '' ? p.name : `#${p.identity.slice(0, 8)}`,
    rating: p.rating,
    wins: p.wins,
    losses: p.losses,
    isOwn: p.identity === identity,
    rank,
  });
}

function build(profiles: readonly StoreProfile[], identity: string): LeaderboardViewModel {
  const sorted = [...profiles].sort(compareProfiles);
  const rows = sorted.slice(0, LEADERBOARD_TOP_K).map((p, i) => toRow(p, identity, i + 1));
  const own = sorted.slice(LEADERBOARD_TOP_K).find((p) => p.identity === identity);
  if (own !== undefined) rows.push(toRow(own, identity, RANK_BELOW_TOP_K));
  return Object.freeze({ rows: Object.freeze(rows), isEmpty: rows.length === 0 });
}

/** The last model built with a profiles version, and the pair it was built for. */
let memo: {
  readonly profilesVersion: number;
  readonly identity: string;
  readonly vm: LeaderboardViewModel;
} | null = null;

/**
 * Build the leaderboard view model from profile rows. Sorts a COPY — the input
 * may be a frozen/store-owned array and is never mutated in place.
 * `identity === ''` (pre-onReady) matches no row: identities are non-empty hex.
 * With `profilesVersion` (the store's `profilesVersion()` for these rows), a call for the same
 * (profilesVersion, identity) pair as the last versioned call returns that call's object without
 * reading `profiles`; a call without it always builds and leaves the memo alone.
 */
export function buildLeaderboardViewModel(
  profiles: readonly StoreProfile[],
  identity: string,
  profilesVersion?: number,
): LeaderboardViewModel {
  if (profilesVersion === undefined) return build(profiles, identity);
  if (memo?.profilesVersion === profilesVersion && memo.identity === identity) return memo.vm;
  const vm = build(profiles, identity);
  memo = { profilesVersion, identity, vm };
  return vm;
}
