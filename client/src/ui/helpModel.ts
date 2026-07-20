// ui/helpModel.ts — pure view model for the in-client help overlay (pt-c2b, ADR-0135).
//
// No DOM, no SDK, no side-effects, no args. Never throws. The content is a typed
// SSOT `const` (dialogueContent / renameModel precedent) — NOT a RON data file
// (YAGNI: this is client chrome, not game content). The VM is DISPLAY-ONLY: it
// exposes ONLY { controls, goals } — no callback / submit / reducer field.
//
// The controls list documents every load-bearing key so a tester reading the
// overlay discovers the full keymap: the `?` help key itself, Escape (close),
// movement (WASD / arrows), Space (jump), F9 (bug bundle), and the 12 overlay
// hotkeys B I E Q H G U P L N O T. buildHelpViewModel() returns a fresh copy so a
// caller mutating the result cannot poison a later call (purity / totality).

/** One documented control: a key (or key group) and the action it performs. */
export interface HelpViewModel {
  readonly controls: readonly { readonly key: string; readonly action: string }[];
  readonly goals: readonly string[];
}

// The typed SSOT const. `?` = Help, Escape = close overlays, WASD/Arrows = move,
// Space = jump, F9 = bug bundle, plus the 12 overlay hotkeys + a Talk (T) row.
const CONTROLS: readonly { readonly key: string; readonly action: string }[] = [
  { key: '?', action: 'Toggle this help overlay' },
  { key: 'WASD / Arrows', action: 'Move around the world' },
  { key: 'Space', action: 'Jump' },
  { key: 'Escape', action: 'Close the open overlay' },
  { key: 'T', action: 'Talk to a nearby NPC' },
  { key: 'B', action: 'Open the monster Box' },
  { key: 'I', action: 'Open Inventory / raise a monster' },
  { key: 'E', action: 'Open Evolution / fuse monsters' },
  { key: 'Q', action: 'Open the Quest log' },
  { key: 'H', action: 'Heal your party' },
  { key: 'G', action: 'Open the shop' },
  { key: 'U', action: 'View an incoming trade' },
  { key: 'P', action: 'Challenge a nearby player to a PvP battle' },
  { key: 'L', action: 'Open the ranked Leaderboard' },
  { key: 'N', action: 'Rename your profile' },
  { key: 'O', action: 'Offer a trade (propose) to a nearby player' },
  { key: 'F9', action: 'Download a bug-report bundle' },
] as const;

// A few session goals — what to try in a first playtest sitting.
const GOALS: readonly string[] = [
  'Recruit a wild monster',
  'Win your first battle',
  'Try trading with another tester',
] as const;

/**
 * Build the help view model. Pure and total: no args, no DOM/SDK, never throws.
 * Returns a FRESH copy of the SSOT const each call (controls entries copied too),
 * so a caller mutating the returned arrays cannot affect a subsequent call.
 */
export function buildHelpViewModel(): HelpViewModel {
  return {
    controls: CONTROLS.map((c) => ({ key: c.key, action: c.action })),
    goals: [...GOALS],
  };
}
