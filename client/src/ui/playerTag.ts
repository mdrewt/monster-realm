// ui/playerTag.ts — a player's tag: the one way a surface shows the minted number that tells two
// same-named players apart. Pure apart from the i18n resolver: no DOM, SDK or clock.
import type { StorePlayer } from '../net/store';
import { tf } from './i18n/resolver';
import { playerName } from './tradeSessionModel';

/** The fewest digits a tag shows; a larger number shows every digit it has. */
const TAG_MIN_DIGITS = 4;

/** The tag for a minted number (`#0042`), or null when the row carries none: 0, or any value that
 *  is not a positive whole number. */
export function formatTag(discriminator: number): string | null {
  if (!Number.isSafeInteger(discriminator) || discriminator <= 0) return null;
  return tf('identity.tag', { digits: String(discriminator).padStart(TAG_MIN_DIGITS, '0') });
}

/** A player's display name with their tag (`Drew #0042`); the display name alone when the player
 *  has no tag or the store does not hold them. */
export function taggedName(players: readonly StorePlayer[], identity: string): string {
  const name = playerName(players, identity);
  const tag = formatTag(players.find((p) => p.identity === identity)?.discriminator ?? 0);
  return tag === null ? name : tf('identity.taggedName', { name, tag });
}
