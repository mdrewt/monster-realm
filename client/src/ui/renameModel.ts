// ui/renameModel.ts — pure view model for the profile-rename overlay (pt-c1b, ADR-0133).
//
// No DOM, no SDK, no side-effects. Never throws on any input — a throw here would
// starve sibling store batch-listeners (store.ts one-way flow) and this VM is built
// from a keydown handler, not a store batch.
//
// D2 (ADR-0133): the ONLY client-side name logic is `trim` + non-empty. This model
// deliberately does NOT re-implement the server `validate_name` ruleset (NFC / length /
// charset). The server is the validation SSOT (reject-not-clamp); a rejected name
// returns through the awaited reducer promise. Re-implementing those rules would create
// a SECOND SSOT that silently diverges when the server constant changes — the exact
// anti-pattern renameModel.test.ts locks out by omitting length/charset assertions.

/** The rename overlay's render state — display label, the trimmed draft to submit,
 *  and whether submission is currently allowed. */
export interface RenameViewModel {
  readonly displayCurrentName: string;
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
 */
export function buildRenameViewModel(currentName: string, draft: string): RenameViewModel {
  const trimmedDraft = draft.trim();
  return {
    displayCurrentName: currentName !== '' ? currentName : '(unnamed)',
    trimmedDraft,
    canSubmit: trimmedDraft !== '',
  };
}
