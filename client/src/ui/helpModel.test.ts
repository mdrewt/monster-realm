// ui/helpModel.test.ts — RED gating tests for the pt-c2b help overlay VM (PTC2B-10/11).
//
// Slice: pt-c2b · SSOT spec: docs/specs/pt-c2b-plan.md + docs/adr/0135-pt-c2b-help-overlay.md
//
// RED REASON: helpModel.ts does not exist yet.
// Every test below fails with "Failed to resolve import './helpModel'" (module-not-found)
// until the implementer ships client/src/ui/helpModel.ts exporting buildHelpViewModel().
//
// CONTRACT (the specialist matches this EXACTLY):
//   export interface HelpViewModel {
//     readonly controls: readonly { readonly key: string; readonly action: string }[];
//     readonly goals: readonly string[];
//   }
//   export function buildHelpViewModel(): HelpViewModel   // pure, total, no args, no DOM/SDK.
//   The controls list is a typed SSOT const.
//
// WRONG-IMPL-KILLED list (one per assertion cluster):
//   - "returns empty controls/goals"                → non-empty assertions (PTC2B-10) catch it
//   - "an entry has an empty key or action"         → per-entry non-empty-string checks catch it
//   - "SSOT omits a load-bearing key (e.g. F9/?/Escape)" → the key-coverage loop catches it
//   - "the VM is impure / mutable / call-dependent" → deep-equal-across-calls catches it
//   - "the VM smuggles a callback/submit field"     → the display-only structural scan (PTC2B-11) catches it
//
// Do NOT edit tests to match a buggy impl — correct from the spec only; any correction
// must strengthen or preserve the bite (log a one-line spec rationale).

import { describe, expect, it } from 'vitest';
import { buildHelpViewModel } from './helpModel';

describe('buildHelpViewModel(): content shape — non-empty controls + goals (PTC2B-10)', () => {
  it('BITES: controls is a non-empty array — kills an empty-SSOT impl', () => {
    // WRONG IMPL KILLED: a stub that returns { controls: [], goals: [...] } — the overlay
    // would show no controls, defeating its only purpose.
    const vm = buildHelpViewModel();
    expect(Array.isArray(vm.controls)).toBe(true);
    expect(vm.controls.length).toBeGreaterThan(0);
  });

  it('BITES: goals is a non-empty array — kills an empty-goals impl', () => {
    // WRONG IMPL KILLED: a stub that returns { controls: [...], goals: [] } — the session
    // goals list is a required half of the help content (PTC2B-10).
    const vm = buildHelpViewModel();
    expect(Array.isArray(vm.goals)).toBe(true);
    expect(vm.goals.length).toBeGreaterThan(0);
  });

  it('BITES: every control entry has a non-empty key AND non-empty action string — kills blank-cell impl', () => {
    // WRONG IMPL KILLED: an entry like { key: 'W', action: '' } or { key: '', action: 'Move' }
    // — a blank cell renders an empty <li>, which is useless onboarding content.
    const vm = buildHelpViewModel();
    for (const entry of vm.controls) {
      expect(typeof entry.key).toBe('string');
      expect(typeof entry.action).toBe('string');
      expect(entry.key.trim().length).toBeGreaterThan(0);
      expect(entry.action.trim().length).toBeGreaterThan(0);
    }
  });

  it('BITES: every goal is a non-empty string — kills blank-goal impl', () => {
    // WRONG IMPL KILLED: a goals array containing '' or whitespace — a blank <li>.
    const vm = buildHelpViewModel();
    for (const goal of vm.goals) {
      expect(typeof goal).toBe('string');
      expect(goal.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('buildHelpViewModel(): the SSOT covers the load-bearing keys (PTC2B-10)', () => {
  // The keymap that the help overlay documents (ADR-0135, amended by ADR-0161 D5): the
  // `?` help key itself, Escape (close), movement (WASD / arrows), Space (jump), the 10
  // overlay hotkeys B I E Q U P L N O T (G and H deleted in uxd2 — the shop is reached
  // through a shopkeeper and the heal through a heal tile, both via the interact key T),
  // and F9 (bug bundle). Each must be mentioned by SOME
  // control entry's `key`. We match case-insensitively / by substring so we pin the
  // COVERAGE of the SSOT without over-pinning the exact glyph wording (e.g. "WASD"
  // vs "W A S D" vs "Arrows/WASD" all satisfy the movement requirement).
  //
  // WRONG IMPL KILLED: an SSOT that forgets to document F9 (the bug-bundle ritual the
  // PLAYTEST.md runbook references) or Escape (how to close overlays) — a tester reading
  // the help overlay would be blind to those affordances.

  function keyBlob(): string {
    const vm = buildHelpViewModel();
    // Join every control's key text into one lowercase blob for substring coverage checks.
    return vm.controls.map((c) => c.key.toLowerCase()).join(' | ');
  }

  it('BITES: the `?` help key is documented in the controls SSOT', () => {
    // '?' is the help affordance itself (self-documenting per ADR-0135).
    const blob = keyBlob();
    expect(blob.includes('?'), 'controls SSOT must document the `?` help key').toBe(true);
  });

  it('BITES: Escape is documented (how to close overlays)', () => {
    const blob = keyBlob();
    expect(blob.includes('esc'), 'controls SSOT must document Escape (esc)').toBe(true);
  });

  it('BITES: movement (WASD or arrow keys) is documented', () => {
    const blob = keyBlob();
    // Accept any of the common movement documentations: "WASD", the arrow word, or the
    // four physical letters. This pins movement-coverage without over-pinning wording.
    const hasMovement =
      blob.includes('wasd') ||
      blob.includes('arrow') ||
      (blob.includes('w') && blob.includes('a') && blob.includes('s') && blob.includes('d'));
    expect(hasMovement, 'controls SSOT must document movement (WASD / arrows)').toBe(true);
  });

  it('BITES: Space (jump) is documented', () => {
    const blob = keyBlob();
    expect(blob.includes('space'), 'controls SSOT must document the Space key (jump)').toBe(true);
  });

  it('BITES: F9 (bug bundle) is documented — the runbook ritual references it', () => {
    const blob = keyBlob();
    expect(blob.includes('f9'), 'controls SSOT must document F9 (bug bundle)').toBe(true);
  });

  it('BITES: each overlay hotkey B I E Q U P L N O T is documented in the SSOT', () => {
    // WRONG IMPL KILLED: an SSOT that documents only some of the overlay hotkeys —
    // a tester would not discover, e.g., the Trade-propose (O) or Leaderboard (L) overlay.
    // Substring match against the per-entry key blob (case-insensitive). Each letter must
    // appear SOMEWHERE in some control's key text.
    //
    // uxd2 EDIT (ADR-0161 D5, plan AC-10′ — the ONLY edit to this file): the list shrank
    // 12 → 10. `g` and `h` were removed because the global KeyG (shop) and KeyH (heal)
    // handlers are DELETED in uxd2 — shop is reached by interacting with a shopkeeper and
    // heal by standing on a heal tile, both via the single interact key T. Documenting a
    // key that no longer does anything is worse than not documenting it.
    // This assertion alone is WEAK (a substring scan would still credit a stray "g"/"h"
    // inside another key's text), so the deletion itself is pinned by the exact-key
    // assertion in the sibling test below — that is the tooth, this is coverage.
    const blob = keyBlob();
    const hotkeys = ['b', 'i', 'e', 'q', 'u', 'p', 'l', 'n', 'o', 't'];
    for (const k of hotkeys) {
      expect(
        blob.includes(k),
        `controls SSOT must document the overlay hotkey "${k.toUpperCase()}"`,
      ).toBe(true);
    }
  });

  it('★ uxd2 BITES: NO controls row has key "G" or "H"; the "T" row still exists', () => {
    // uxd2 / AC-10′ (ADR-0161 D5). RED TODAY: helpModel.ts:32-33 still ship
    // `{ key: 'H', action: 'Heal your party' }` and `{ key: 'G', action: 'Open the shop' }`.
    //
    // WRONG IMPL KILLED (1): an impl that deletes the KeyG/KeyH HANDLERS in main.ts but
    //   leaves the help rows — the overlay would teach a playtester two keys that silently
    //   do nothing, which is the single worst outcome for an onboarding surface.
    // WRONG IMPL KILLED (2): an impl that deletes the T row while reworking its wording —
    //   the one key the whole slice is about would vanish from the help overlay.
    // EXACT-KEY (trim + uppercase), NOT substring: a substring test cannot distinguish a
    // deleted row from the "h" inside another key's text, which is precisely how the
    // sibling coverage test above could go vacuously green.
    const vm = buildHelpViewModel();
    const exactKeys = vm.controls.map((c) => c.key.trim().toUpperCase());
    expect(exactKeys, 'the global shop hotkey G is removed in uxd2 (ADR-0161 D5)').not.toContain(
      'G',
    );
    expect(exactKeys, 'the global heal hotkey H is removed in uxd2 (ADR-0161 D5)').not.toContain(
      'H',
    );
    expect(exactKeys, 'the interact key T must still be documented').toContain('T');
  });
});

describe('buildHelpViewModel(): purity / totality — same content across calls (PTC2B-11)', () => {
  it('BITES: two calls return deeply-equal content — kills a mutable / call-dependent impl', () => {
    // PTC2B-11: display-only means the VM is a pure projection of a static const. Two calls
    // must produce structurally identical content (no clock/RNG/store dependence).
    // WRONG IMPL KILLED: an impl that mutates a shared array (so a second call differs) or
    // derives content from a non-deterministic source.
    const a = buildHelpViewModel();
    const b = buildHelpViewModel();
    expect(a).toEqual(b);
  });

  it('BITES: the returned VM cannot be reordered by a prior mutation — content is stable', () => {
    // Belt-and-suspenders on purity: capture the first call, ATTEMPT to mutate its arrays
    // (a frozen const throws / a non-frozen copy is harmless), then re-call and compare to a
    // fresh snapshot. The second call must not observe the first caller's tampering.
    const first = buildHelpViewModel();
    try {
      // If the impl returns the SSOT const directly and froze it, this throws (caught).
      // If it returns a fresh copy, this mutates the copy only — the next call is unaffected.
      (first.controls as { key: string; action: string }[]).push({ key: 'HACK', action: 'HACK' });
    } catch {
      /* frozen SSOT — expected; nothing to clean up */
    }
    const fresh = buildHelpViewModel();
    expect(fresh.controls.some((c) => c.key === 'HACK')).toBe(false);
  });
});

describe('buildHelpViewModel(): display-only structural guard — no callbacks/submit (PTC2B-11)', () => {
  it('BITES: the VM exposes ONLY { controls, goals } — kills an impl that smuggles a callback/submit field', () => {
    // PTC2B-11: the help overlay is display-only (no text input, no submit, no reducer). The
    // VM must carry no function-valued or action-shaped field. This asserts the VM's own keys
    // are exactly the two data arrays — a smuggled `onSubmit` / `submit` / `reducer` field is
    // an immediate structural failure (proves the VM is not a covert action surface).
    // WRONG IMPL KILLED: an impl that adds `onSubmit`/`onClick`/`send` to the VM (turning a
    // display-only overlay into an action one) — the ADR-0135 display-only invariant is violated.
    const vm = buildHelpViewModel();
    const keys = Object.keys(vm).sort();
    expect(keys).toEqual(['controls', 'goals']);

    // No value in the VM (top level, entries, or goals) may be a function.
    const values: unknown[] = [vm.controls, vm.goals, ...vm.controls, ...vm.goals];
    for (const v of values) {
      expect(typeof v).not.toBe('function');
    }
    // Each control entry, too, must carry ONLY { key, action } — no smuggled callback.
    for (const entry of vm.controls) {
      expect(Object.keys(entry).sort()).toEqual(['action', 'key']);
    }
  });
});
