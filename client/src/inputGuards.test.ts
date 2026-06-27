// inputGuards.test.ts — unit tests for the KeyB battle-guard predicate (M8.5f criterion D).
//
// SOURCE OF TRUTH: docs/m8.5f-plan.md §D
//
// The fix: extract a one-line pure predicate
//   export function shouldToggleBox(battleVisible: boolean): boolean { return !battleVisible; }
// into client/src/inputGuards.ts, and guard the KeyB branch in main.ts with it.
//
// RED reason: the module `./inputGuards` does not exist yet — every import here
// fails at resolution time (RED-by-absence). Once the implementer adds
// inputGuards.ts with the exported function, these tests go GREEN.
//
// Wrong impl killed:
//   shouldToggleBox(true) === false — kills an impl that always returns true
//   shouldToggleBox(false) === true — kills an impl that always returns false

import { describe, expect, it } from 'vitest';
import { shouldToggleBox } from './inputGuards';

describe('shouldToggleBox: KeyB battle-guard predicate (M8.5f criterion D)', () => {
  it('BITES: shouldToggleBox(true) === false (box must NOT toggle while battle is visible)', () => {
    // Kills: any impl that returns true when battleVisible=true (i.e. allows KeyB
    // to open the box over an active battle — the NET-1 guard regression).
    expect(shouldToggleBox(true)).toBe(false);
  });

  it('BITES: shouldToggleBox(false) === true (box SHOULD toggle when no battle is visible)', () => {
    // Kills: any impl that returns false when battleVisible=false (i.e. blocks KeyB
    // even outside of battle — would break normal box toggling).
    expect(shouldToggleBox(false)).toBe(true);
  });
});
