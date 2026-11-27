import type { Profile } from '../config.ts';

/** A SteamID64 as Steam writes it: 17 decimal digits. Made only by `parseSteamId`. */
export type SteamId = string & { readonly __brand: 'SteamId' };

const STEAM_ID = /^[0-9]{17}$/;
const SUBJECT_PREFIX = 'steam:';

/** The value as a SteamId when it is a string of exactly 17 ASCII digits; otherwise undefined. */
export function parseSteamId(value: unknown): SteamId | undefined {
  return typeof value === 'string' && STEAM_ID.test(value) ? (value as SteamId) : undefined;
}

/** `steam:<steamid64>`, the subject of a Steam player. */
export function steamSubject(steamId: SteamId): string {
  return `${SUBJECT_PREFIX}${steamId}`;
}

/** The SteamID of exactly `steam:<17 digits>`; undefined for anything else. */
export function steamIdOfSubject(sub: string): SteamId | undefined {
  if (typeof sub !== 'string' || !sub.startsWith(SUBJECT_PREFIX)) return undefined;
  return parseSteamId(sub.slice(SUBJECT_PREFIX.length));
}

/** The four members of Steam's ownership answer the rule reads. */
export interface AppOwnership {
  readonly ownsapp: boolean;
  readonly permanent: boolean;
  readonly sitelicense: boolean;
  /** The SteamID64 of the licence's holder: the player's own unless the game is borrowed. */
  readonly ownersteamid: string;
}

/**
 * Whether a player owns the game: true only for an owned, permanent, non-site licence whose
 * holder is `steamId`. A Family Sharing borrower, a free weekend and a PC café do not count.
 *
 * A member that is not the boolean it should be never counts in the player's favour, and a
 * `steamId` that is not a SteamID is never entitled.
 */
export function entitled(ownership: AppOwnership, steamId: SteamId): boolean {
  return (
    parseSteamId(steamId) !== undefined &&
    ownership.ownsapp === true &&
    ownership.permanent === true &&
    ownership.sitelicense === false &&
    ownership.ownersteamid === steamId
  );
}

/** Steam's ownership answer for one player, or the failure to get one. */
export type OwnershipCheck =
  | { readonly kind: 'answered'; readonly ownership: AppOwnership }
  | { readonly kind: 'failed'; readonly error: Error };

/**
 * Whether a Steam player is entitled, and when not, why. `unavailable` is Steam failing to
 * answer: the player is not entitled now, and nothing was learnt about what they own.
 */
export type SteamEntitlement =
  | { readonly entitled: true }
  | { readonly entitled: false; readonly reason: 'denied' | 'not-owned' }
  | { readonly entitled: false; readonly reason: 'unavailable'; readonly error: Error };

/**
 * How a profile decides a Steam player's entitlement. Our own deny-list is read first on every
 * profile, and a denied player is asked about nowhere else. After it, a dev profile reads only
 * the admin flag: under Valve's development app Steam cannot say who owns the game, so it is
 * never asked. `production` asks Steam and applies `entitled`, and never reads a flag.
 *
 * The decision rejects when one of the three functions does: a failure of our own never comes
 * back as an answer.
 */
export function steamEntitlementSource(options: {
  readonly profile: Profile;
  readonly denied: (steamId: SteamId) => Promise<boolean>;
  readonly devFlag: (steamId: SteamId) => Promise<boolean>;
  readonly checkAppOwnership: (steamId: SteamId) => Promise<OwnershipCheck>;
}): (steamId: SteamId) => Promise<SteamEntitlement> {
  const { denied } = options;
  const decide = profileDecision(options);
  return async (steamId) => {
    if ((await denied(steamId)) !== false) return { entitled: false, reason: 'denied' };
    return decide(steamId);
  };
}

function profileDecision(options: {
  readonly profile: Profile;
  readonly devFlag: (steamId: SteamId) => Promise<boolean>;
  readonly checkAppOwnership: (steamId: SteamId) => Promise<OwnershipCheck>;
}): (steamId: SteamId) => Promise<SteamEntitlement> {
  const { profile, devFlag, checkAppOwnership } = options;
  switch (profile) {
    case 'local-dev':
    case 'hosted-dev':
      return async (steamId) =>
        (await devFlag(steamId)) === true
          ? { entitled: true }
          : { entitled: false, reason: 'not-owned' };
    case 'production':
      return async (steamId) => {
        const answer = await checkAppOwnership(steamId);
        if (answer.kind === 'failed') {
          return { entitled: false, reason: 'unavailable', error: answer.error };
        }
        return entitled(answer.ownership, steamId)
          ? { entitled: true }
          : { entitled: false, reason: 'not-owned' };
      };
    default:
      // A profile the types do not name must never be decided by the dev flag.
      throw new TypeError('the profile is none of local-dev, hosted-dev and production');
  }
}
