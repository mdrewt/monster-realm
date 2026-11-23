// ui/renameModel.ts — pure view model for the profile-rename overlay.
//
// No DOM, no SDK, no side-effects (the tag goes through the i18n resolver, as `formatTag` does).
// Never throws on any input: it is built from keydown and input handlers and from a store batch
// listener (main.ts), where a throw would starve sibling batch listeners (store.ts one-way flow).
//
// D2: the ONLY client-side name logic is `trim` + non-empty. This model
// deliberately does NOT re-implement the server `validate_name` ruleset (NFC / length /
// charset). The server is the validation SSOT (reject-not-clamp); a rejected name
// returns through the awaited reducer promise. Re-implementing those rules would create
// a SECOND SSOT that silently diverges when the server constant changes — the exact
// anti-pattern renameModel.test.ts locks out by omitting length/charset assertions.
import { formatTag } from './playerTag';

/** The rename overlay's render state — display label, the player's own tag, the trimmed draft
 *  to submit, and whether submission is currently allowed. */
export interface RenameViewModel {
  readonly displayCurrentName: string;
  /** The player's tag as `formatTag` gives it (`#0042`); null when the row carries none. */
  readonly displayTag: string | null;
  readonly trimmedDraft: string;
  readonly canSubmit: boolean;
}

/**
 * Build the rename view model.
 * - `trimmedDraft`  = `draft.trim()` (strips ALL leading/trailing whitespace, incl. tabs).
 * - `canSubmit`     = the trimmed draft is non-empty (trim-THEN-check, not raw-then-trim).
 * - `displayCurrentName` = the current name, or `'(unnamed)'` when it is the EMPTY string
 *   (D6: `store.player(identity)?.name` is `''` for a never-named player). Only the exact
 *   empty string triggers the fallback — a whitespace-only stored name passes through
 *   verbatim (the server is the SSOT on what a valid stored name is).
 * - `displayTag`    = `formatTag(discriminator)`: null for 0 (no tag) or any value that is not a
 *   positive whole number. A rename keeps the minted discriminator, so it keeps the tag.
 */
export function buildRenameViewModel(
  currentName: string,
  discriminator: number,
  draft: string,
): RenameViewModel {
  const trimmedDraft = draft.trim();
  return {
    displayCurrentName: currentName !== '' ? currentName : '(unnamed)',
    displayTag: formatTag(discriminator),
    trimmedDraft,
    canSubmit: trimmedDraft !== '',
  };
}
