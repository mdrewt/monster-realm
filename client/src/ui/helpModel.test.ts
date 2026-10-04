// ui/helpModel.test.ts — RED gating tests for the pt-c2b help overlay VM.
//
// WRONG-IMPL-KILLED list (one per assertion cluster):
//   - "returns empty controls/goals"                → non-empty assertions catch it
//   - "an entry has an empty key or action"         → per-entry non-empty-string checks catch it
//   - "SSOT omits a load-bearing key (e.g. F9/?/Escape)" → the key-coverage loop catches it
//   - "the VM is impure / mutable / call-dependent" → deep-equal-across-calls catches it
//   - "the VM smuggles a callback/submit field"     → the display-only structural scan catches it

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
    // goals list is a required half of the help content.
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
  // The keymap that the help overlay documents: the
  // `?` help key itself, Escape (close), movement (WASD / arrows), Space (jump), the 9
  // overlay hotkeys B I E Q U P L N O (G and H deleted in uxd2; ctl-10a retired the interact key
  // T — interaction is Enter / A on what you face, pinned by the ctl-10a key-set test below),
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

  it('BITES: each overlay hotkey B I E Q U P L N O is documented in the SSOT', () => {
    // WRONG IMPL KILLED: an SSOT that documents only some of the overlay hotkeys —
    // a tester would not discover, e.g., the Trade-propose (O) or Leaderboard (L) overlay.
    // Substring match against the per-entry key blob (case-insensitive). Each letter must
    // appear SOMEWHERE in some control's key text.
    //
    // INTENTIONAL CHANGE (ctl-10a, CTL10A.3): `t` is dropped from this list (10 -> 9). T no longer
    // does anything (world interaction is A / Enter on what you face), so its row is deleted; the
    // exact-key absence of T and the presence of Enter and F are pinned by the ctl-10a key-set test.
    // (Kept as a substring scan, `t` would also pass vacuously on the new "Enter" row.)
    //
    // the list shrank 12 → 10. `g` and `h` were removed because the global KeyG (shop) and
    // KeyH (heal) handlers are DELETED in uxd2 — shop is reached by interacting with a
    // shopkeeper and heal by standing on a heal tile, both via the single interact key T.
    // Documenting a key that no longer does anything is worse than not documenting it.
    // This assertion alone is WEAK (a substring scan would still credit a stray "g"/"h"
    // inside another key's text), so the deletion itself is pinned by the exact-key
    // assertion in the sibling test below — that is the tooth, this is coverage.
    const blob = keyBlob();
    // INTENTIONAL CHANGE (ctl-10b, CTL10B.2): `o` is dropped from this list (9 -> 8). O no longer
    // starts a trade, so its row is deleted; its absence is pinned by CTL10B-2-HELP-NO-O below.
    const hotkeys = ['b', 'i', 'e', 'q', 'u', 'p', 'l', 'n'];
    for (const k of hotkeys) {
      expect(
        blob.includes(k),
        `controls SSOT must document the overlay hotkey "${k.toUpperCase()}"`,
      ).toBe(true);
    }
  });

  it('★ M21b-2 BITES: the CONTROLS SSOT documents the account/claim key `C` with its EXACT action string', () => {
    // ADR-0182 (D16/D17, spec AUTH-48/52/54-56/59-60). The account/claim overlay ships with a
    // direct KeyC hotkey AND a System > "Account & Sign-in" menu leaf, and AC-18 makes this
    // SSOT the source of the glyph that leaf displays.
    //
    // ★ THE EXACT ACTION STRING IS A CONTRACT, not a suggestion. Three gates read it and two
    // of them compare it with EXACT equality:
    //   • menuModel's MM-KEYGLYPH-FROM-HELP-SSOT reads the KEY token ('C');
    //   • playtestControlsDoc.test.ts A2 requires docs/PLAYTEST.md §3's `C` row action to
    //     EXACTLY EQUAL this string (not `.includes` — the red-team PoC'd that a containment
    //     oracle passes a doc row that re-teaches a dead key), and A1/A3 require the row to
    //     EXIST and the row COUNT to match. So this string is what must be pasted, verbatim,
    //     into the doc table's `| \`C\` | … |` row.
    //   • A4's whole-document single-char-code-span scan then accepts `` `C` `` in prose,
    //     which it currently would NOT (it whitelists live CONTROLS keys only).
    //
    // WRONG IMPL KILLED (1): shipping the KeyC handler and the menu leaf with no CONTROLS row
    //   — the one load-bearing key the help overlay never mentions (the exact defect the 'M'
    //   row was added for in uxd3), and MM-KEYGLYPH-FROM-HELP-SSOT reds.
    // WRONG IMPL KILLED (2): a row keyed 'c' (lower case) or ' C ' — the menu displays the
    //   glyph verbatim and the doc gate compares verbatim. Trim + exact case, as the uxd2
    //   sibling test below already established for G/H/T.
    // WRONG IMPL KILLED (3): a DIFFERENT action string in helpModel vs docs/PLAYTEST.md —
    //   caught by A2, but reported there as a doc failure. Pinning the exact string HERE is
    //   what makes the SSOT side the one that has to be right first.
    const vm = buildHelpViewModel();
    const exactKeys = vm.controls.map((c) => c.key.trim().toUpperCase());
    expect(exactKeys, 'the account/claim hotkey C must be documented (ADR-0182)').toContain('C');

    const row = vm.controls.find((c) => c.key === 'C');
    expect(
      row,
      'the C row must be keyed with the exact glyph `C` (no padding, upper case)',
    ).toBeDefined();
    expect(
      row?.action,
      'the `C` row action must be EXACTLY `Open account & sign-in` — docs/PLAYTEST.md §3 must ' +
        'carry the identical string (playtestControlsDoc.test.ts A2 compares with exact ' +
        'equality). If this reds, change the CODE or the DOC to agree; do not relax this ' +
        'assertion, because the doc gate has no other anchor for the row it is checking',
    ).toBe('Open account & sign-in');

    // Exactly one C row: a duplicate would pass A1's set-equality (sets dedupe) while making
    // the doc's row-count gate A3 unsatisfiable.
    expect(
      vm.controls.filter((c) => c.key.trim().toUpperCase() === 'C').length,
      'the CONTROLS SSOT must contain EXACTLY ONE `C` row',
    ).toBe(1);
  });

  it('★ uxd2 BITES: NO controls row has key "G" or "H"', () => {
    // uxd2 / AC-10′.
    //
    // WRONG IMPL KILLED (1): an impl that deletes the KeyG/KeyH HANDLERS in main.ts but
    //   leaves the help rows — the overlay would teach a playtester two keys that silently
    //   do nothing, which is the single worst outcome for an onboarding surface.
    // INTENTIONAL CHANGE (ctl-10a, CTL10A.3): this test also asserted "the interact key T must
    //   still be documented". ctl-10a retires T (T does nothing; A / Enter acts on what you face),
    //   so that assertion is REVERSED and moved to the ctl-10a key-set test below, which pins T's
    //   absence and the Enter / F rows that replace it.
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
  });

  it('CTL10A-3-HELP-NO-T: the CONTROLS key set drops T and gains Enter (interact with what you face) and F (every action for what you face), one row each; no row is keyed T', () => {
    // ctl-10a, CTL10A.3 / spec Tasks: "`CONTROLS` drops the T row and gains A interaction;
    // `helpModel.test.ts`'s pinned key set drops T (named)". This is that pinned key set; the
    // NAMED intentional change is T's removal (it was documented since uxd2) plus the two new rows.
    // WRONG IMPL KILLED: help that still teaches T (a key that now does nothing, the worst outcome
    // for an onboarding surface); a T row merely reworded ("T / Enter"); an interaction that is
    // never documented (no Enter row) or whose Y sheet is undiscoverable (no F row); a duplicated
    // row; and an Enter / F row keyed with padding or another case (the help shows keys verbatim).
    const vm = buildHelpViewModel();
    const rawKeys = vm.controls.map((c) => c.key);
    expect(
      rawKeys.some((k) => k.trim().toUpperCase() === 'T'),
      'no controls row may be keyed T (T is retired in ctl-10a)',
    ).toBe(false);
    expect(
      rawKeys.filter((k) => k === 'Enter'),
      'exactly one row keyed `Enter`',
    ).toHaveLength(1);
    expect(
      rawKeys.filter((k) => k === 'F'),
      'exactly one row keyed `F`',
    ).toHaveLength(1);
    // NAMED INTENTIONAL CHANGE (ctl-10b, CTL10B.2): the pinned key set drops 'O' (the trade
    // propose key is retired; trades and challenges start face to face through Enter).
    expect([...rawKeys].sort(), 'the full documented key set after ctl-10b').toEqual(
      [
        '?',
        'M',
        'WASD / Arrows',
        'Space',
        'Escape',
        'Enter',
        'F',
        'B',
        'I',
        'E',
        'Q',
        'U',
        'P',
        'L',
        'N',
        'C',
        'F9',
      ].sort(),
    );
    for (const key of ['Enter', 'F']) {
      const row = vm.controls.find((c) => c.key === key);
      expect(row?.action.trim().length, `the ${key} row says what it does`).toBeGreaterThan(0);
    }
  });
});

describe('buildHelpViewModel(): face-to-face trading, no O (ctl-10b, CTL10B.2)', () => {
  it('CTL10B-2-HELP-NO-O: no controls row is keyed O, no action text says "nearby" (B15), the Enter row names trade and challenge, and the P row is about answering a challenge', () => {
    // WRONG IMPL KILLED: help that still teaches O (a key that now does nothing: the worst outcome
    // for an onboarding surface); a row keyed "O / Enter" (a reworded O); any action that still
    // says "nearby" (B15: the interaction is with what you FACE, not a radius); an Enter row that
    // does not mention trade and challenge (the only way to start either is undiscoverable); and a
    // P row that still says it challenges a player (P answers a challenge now).
    const vm = buildHelpViewModel();
    expect(vm.controls.length, 'ANTI-VACUITY: the SSOT is not empty').toBeGreaterThan(10);
    for (const c of vm.controls) {
      expect(
        c.key
          .trim()
          .toUpperCase()
          .split(/[\s/]+/),
        `row "${c.key}" is not an O row`,
      ).not.toContain('O');
      expect(/nearby/i.test(c.action), `"${c.action}" must not say "nearby"`).toBe(false);
      expect(/nearby/i.test(c.key)).toBe(false);
    }
    expect(vm.controls.some((c) => c.key.trim().toUpperCase() === 'O')).toBe(false);

    const enter = vm.controls.find((c) => c.key === 'Enter');
    expect(enter, 'the Enter row exists').toBeDefined();
    expect(/trade/i.test(enter?.action ?? ''), 'Enter mentions trade').toBe(true);
    expect(/challenge/i.test(enter?.action ?? ''), 'Enter mentions challenge').toBe(true);

    const p = vm.controls.find((c) => c.key === 'P');
    expect(p, 'the P row exists').toBeDefined();
    expect(/answer/i.test(p?.action ?? ''), 'P is about answering a challenge').toBe(true);
    expect(/nearby/i.test(p?.action ?? '')).toBe(false);
  });
});

describe('buildHelpViewModel(): purity / totality — same content across calls (PTC2B-11)', () => {
  it('BITES: two calls return deeply-equal content — kills a mutable / call-dependent impl', () => {
    // display-only means the VM is a pure projection of a static const. Two calls
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
    // The help overlay is display-only (no text input, no submit, no reducer). The
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
