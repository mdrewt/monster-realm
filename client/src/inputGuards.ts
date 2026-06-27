// inputGuards.ts — tiny pure input predicates for the integrated loop (M8.5f).
//
// Extracted so the KeyB battle-guard is unit-testable (main.ts is e2e-only).

/** KeyB may toggle the box only when no battle overlay is visible (ADR-0014/0052). */
export function shouldToggleBox(battleVisible: boolean): boolean {
  return !battleVisible;
}
