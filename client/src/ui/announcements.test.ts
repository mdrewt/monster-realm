// ui/announcements.test.ts — m23-s1 RED gating tests for the pure announcementsFor(prev,next) reducer.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.4, §6 A11Y-8;
//   memory/projects/monster-realm-m23-s1-plan.md (finding F5, adjudication A4);
//   ADR-0205 D5 (the id-derived copy-key seam);
//   memory/projects/gates/m23-s1.gates.md X4/X5/X6.
//
// RED REASON: `client/src/ui/announcements.ts` DOES NOT EXIST YET. Every test below fails with
// "Failed to resolve import './announcements'" (module-not-found) until the implementer lands it.
//
// *** NO `@vitest-environment` LINE ABOVE — THIS IS DELIBERATE AND IS ITSELF PART OF THE GATE. ***
// This file runs under vitest's default NODE environment (client/vite.config.ts sets no test-wide
// `environment`, so the default applies here since no per-file override is present). Under node,
// any reference to `document`/`window` from inside announcements.ts throws a ReferenceError at the
// point of use — a MECHANICAL purity oracle, not a review opinion. S1-ANN-PURE-NO-DOM below proves
// the module was actually imported and exercised under that environment (not merely that the file
// has no `@vitest-environment` comment), by asserting `typeof document === 'undefined'` AND that a
// real announcementsFor() call still computes the correct value in that environment.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/plan only.
//
// WRONG-IMPL-KILLED index:
//   - the empty reducer `return []` (passes A11Y-8 perfectly) -> S1-ANN-MESSAGE-CHANGE /
//     S1-ANN-OVERLAY-OPENED-DERIVED (paired positive assertions in this same file/gate)
//   - the reference-equality reducer `prev === next ? [] : ...`  -> A11Y-8-DISTINCT-BUT-EQUAL-OBJECTS
//   - hardcoded/literal copy instead of the id-derived catalog value -> S1-ANN-OVERLAY-OPENED-DERIVED
//   - DOM leakage inside the "pure" module -> caught mechanically by the node environment (S1-ANN-PURE-NO-DOM)

import { describe, expect, it } from 'vitest';
import { a11yCopy } from './a11yCopy';
import type { A11ySnapshot } from './announcements';
import { announcementsFor } from './announcements';
import { OVERLAY_IDS } from './overlayRegistry';

// ---------------------------------------------------------------------------
// Identical/equal-state silence (A11Y-8)
// ---------------------------------------------------------------------------

describe('announcementsFor — identical and structurally-equal states emit nothing (A11Y-8)', () => {
  it('A11Y-8-IDENTICAL-STATES-EMIT-NOTHING BITES: the SAME state object compared against itself emits zero messages', () => {
    const state: A11ySnapshot = { topOverlay: 'boxView', message: 'Party & Box ready' };
    expect(announcementsFor(state, state)).toEqual([]);
  });

  it('A11Y-8-DISTINCT-BUT-EQUAL-OBJECTS BITES: two SEPARATE object literals that are structurally equal, with BOTH fields non-trivial, emit zero messages', () => {
    // WRONG IMPL KILLED: `prev === next ? [] : ...` (reference-equality only). `prev` and `next`
    // here are two DIFFERENT object literals — never reference-equal — so a reducer that only
    // short-circuits on `===` falls through to its general path and (unless it ALSO deep-compares
    // field-by-field) would wrongly emit messages for a state that never actually changed. Both
    // fields are non-trivial (a real overlay id AND a non-empty message) so an all-null/all-empty
    // fixture cannot pass this vacuously.
    const prev: A11ySnapshot = { topOverlay: 'boxView', message: 'Party & Box ready' };
    const next: A11ySnapshot = { topOverlay: 'boxView', message: 'Party & Box ready' };
    expect(prev, 'sanity: these must be two distinct object identities').not.toBe(next);
    expect(announcementsFor(prev, next)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Message + overlay transition rules (S1-ANN)
// ---------------------------------------------------------------------------

describe('announcementsFor — message and overlay transition rules (S1-ANN, spec §2.4)', () => {
  it('S1-ANN-MESSAGE-CHANGE BITES: a message field that changes from empty to non-empty is emitted verbatim', () => {
    // WRONG IMPL KILLED: `return []` — the empty reducer passes every A11Y-8 negative test
    // perfectly. This positive assertion, run in the SAME file/gate, is what kills it.
    const prev: A11ySnapshot = { topOverlay: null, message: '' };
    const next: A11ySnapshot = { topOverlay: null, message: 'Press T to talk' };
    expect(announcementsFor(prev, next)).toEqual(['Press T to talk']);
  });

  it('untagged: a message that does not change between prev and next is not re-emitted', () => {
    const prev: A11ySnapshot = { topOverlay: null, message: 'Press T to talk' };
    const next: A11ySnapshot = { topOverlay: null, message: 'Press T to talk' };
    expect(announcementsFor(prev, next)).toEqual([]);
  });

  it('S1-ANN-OVERLAY-OPENED-DERIVED BITES: topOverlay transitioning to each of the 16 ids emits the id-DERIVED catalog title, never a literal', () => {
    // WRONG IMPL KILLED: a hardcoded copy string (e.g. always 'Battle', or a switch statement
    // with a typo'd branch) would only coincidentally match ONE of the sixteen ids. Compared
    // against the DERIVED value (`a11yCopy['a11y.overlay.' + id + '.title']`, ADR-0205 D5)
    // rather than a literal, and NOT via `t(OVERLAY_A11Y[id].labelKey)` — computing it the same
    // way the implementation itself would could hide a labelKey/catalog mismatch that a
    // differently-derived expectation would still catch.
    expect(OVERLAY_IDS.length, 'ANTI-VACUITY: the manifest must hold 16 overlays').toBe(16);

    let checked = 0;
    for (const id of OVERLAY_IDS) {
      const prev: A11ySnapshot = { topOverlay: null, message: '' };
      const next: A11ySnapshot = { topOverlay: id, message: '' };
      const expected = (a11yCopy as Record<string, string>)[`a11y.overlay.${id}.title`];
      expect(typeof expected, `a11yCopy must have a derived entry for ${id}`).toBe('string');
      expect(announcementsFor(prev, next), `topOverlay -> ${id}`).toEqual([expected]);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: every one of the 16 ids must have been exercised').toBe(16);
  });

  it('S1-ANN-OVERLAY-TO-NULL-SILENT BITES: topOverlay transitioning to null emits nothing — the declared a11y.world.region copy gap', () => {
    // a11y.world.region does not exist yet (a11yCopy.ts is outside this slice's touches, and
    // t() throws on a miss) — this rule is a DECLARED SPEC GAP for a later slice, not something
    // S1 may fake with a literal (that would break §2.8 / A11Y-3/4's derived-copy discipline).
    const prev: A11ySnapshot = { topOverlay: 'boxView', message: '' };
    const next: A11ySnapshot = { topOverlay: null, message: '' };
    expect(announcementsFor(prev, next)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Module purity, proven by the NODE test environment (S1-ANN-PURE)
// ---------------------------------------------------------------------------

describe('announcementsFor — module purity, mechanically proven by the NODE environment (S1-ANN-PURE)', () => {
  it('S1-ANN-PURE-NO-DOM BITES: this file runs with no document/window in scope, and announcementsFor still computes the correct (overlay-then-message) result', () => {
    // The oracle: if announcements.ts referenced `document`/`window` anywhere, importing it (let
    // alone calling it) under this NODE environment would throw. `typeof` is safe on an
    // undeclared identifier (it does not itself throw), so this positively demonstrates the
    // ambient absence AND, via the real announcementsFor() call below, that the module still
    // works correctly in that environment (not vacuous).
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');

    const prev: A11ySnapshot = { topOverlay: null, message: '' };
    const next: A11ySnapshot = { topOverlay: 'boxView', message: 'Party & Box ready' };
    const expectedTitle = (a11yCopy as Record<string, string>)['a11y.overlay.boxView.title'];
    // Rule order per the module header: overlay first, then message (spec §2.4).
    expect(announcementsFor(prev, next)).toEqual([expectedTitle, 'Party & Box ready']);
  });
});
