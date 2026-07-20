// ui/renameModel.test.ts — RED gating tests for pt-c1b §PTC1B-7 / §PTC1B-1 / D2 / D6.
//
// Slice: pt-c1b · Source-of-truth spec: docs/specs/pt-c1b-plan.md + docs/adr/0133-rename-ui.md
//
// RED REASON: renameModel.ts does not exist yet.
// Every test below will fail with:
//   "Failed to resolve import './renameModel'" (module-not-found)
//
// WRONG-IMPL-KILLED list (one per criterion):
//   - "no trim before non-empty check" → whitespace-only draft → canSubmit:false ★ catches it
//   - "trim not reflected in trimmedDraft"  → trimmedDraft:'' for '   ' catches it
//   - "''  passes as truthy display name"  → ''→'(unnamed)' test catches it
//   - "non-empty currentName shows '(unnamed)'" → passthrough test catches it
//   - "canSubmit:false for a valid non-empty draft" → happy-path test catches it
//   - "trimmedDraft is raw (not trimmed)"  → ('Old','  New  ')→'New' test catches it
//
// DESIGN GUARD (NOT A BUG):
//   This file deliberately contains NO test asserting that a 25-char name or an
//   emoji/non-alphanumeric name is rejected. The server's validate_name is the
//   validation SSOT (ADR-0133 D2). A model that re-implements those rules is the
//   anti-pattern — it creates a second SSOT that diverges when the server constant
//   changes. The absence of those tests is intentional and load-bearing.
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.
// Corrections must be traced to the spec and must not weaken the bite.

import { describe, expect, it } from 'vitest';
import { buildRenameViewModel } from './renameModel';

// ---------------------------------------------------------------------------
// PTC1B-1 / D2: happy path — trim reflected in both trimmedDraft and canSubmit
// ---------------------------------------------------------------------------

describe('buildRenameViewModel happy path (PTC1B-7 / D2)', () => {
  it('BITES: (Old,  New  ) → { displayCurrentName:Old, trimmedDraft:New, canSubmit:true } — kills no-trim impl', () => {
    // WRONG IMPL KILLED: an impl that does not trim draft before comparing → trimmedDraft
    // is '  New  ' and canSubmit may still be true (non-empty) but trimmedDraft is wrong.
    // Also kills an impl that never sets canSubmit:true.
    const vm = buildRenameViewModel('Old', '  New  ');
    expect(vm.displayCurrentName).toBe('Old');
    expect(vm.trimmedDraft).toBe('New');
    expect(vm.canSubmit).toBe(true);
  });

  it('BITES: exact-match (no surrounding spaces) → trimmedDraft matches input, canSubmit:true', () => {
    // Smoke: a draft with no leading/trailing whitespace must still produce canSubmit:true.
    // WRONG IMPL KILLED: a trim() that corrupts mid-word spaces (trim() does not do this,
    // but this pins the boundary).
    const vm = buildRenameViewModel('Hero', 'NewHero');
    expect(vm.trimmedDraft).toBe('NewHero');
    expect(vm.canSubmit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PTC1B-7 teeth: whitespace-only and empty draft → canSubmit:false + trimmedDraft:''
// (D2: "Trim + non-empty ONLY" — the only client-side name logic)
// ---------------------------------------------------------------------------

describe('buildRenameViewModel PTC1B-7: whitespace-only / empty draft → canSubmit:false', () => {
  it('★ BITES: whitespace-only draft "   " → canSubmit:false AND trimmedDraft:"" — kills impl that checks non-empty BEFORE trim', () => {
    // WRONG IMPL KILLED: `canSubmit = draft !== ''` (checks raw draft before trim):
    //   '   ' is non-empty → canSubmit:true. This assertion catches that exact bug.
    // ALSO KILLS: an impl that sets trimmedDraft to '   ' instead of ''.
    // PTC1B-7: the submit button is disabled for a draft that is empty after trim.
    const vm = buildRenameViewModel('Alice', '   ');
    expect(vm.canSubmit).toBe(false);
    expect(vm.trimmedDraft).toBe('');
  });

  it('★ BITES: empty string draft "" → canSubmit:false AND trimmedDraft:"" — kills impl that special-cases non-whitespace empty only', () => {
    // WRONG IMPL KILLED: an impl that only guards '' but not '  ' (whitespace).
    // Paired with the whitespace-only test above, together they require TRIM-THEN-CHECK.
    const vm = buildRenameViewModel('Alice', '');
    expect(vm.canSubmit).toBe(false);
    expect(vm.trimmedDraft).toBe('');
  });

  it('BITES: tab-only draft "\\t\\t" → canSubmit:false AND trimmedDraft:"" — kills impl that only trims spaces', () => {
    // String.prototype.trim() strips all whitespace including tabs.
    // WRONG IMPL KILLED: an impl using replace(/^ +| +$/, '') that only strips spaces.
    const vm = buildRenameViewModel('Alice', '\t\t');
    expect(vm.canSubmit).toBe(false);
    expect(vm.trimmedDraft).toBe('');
  });
});

// ---------------------------------------------------------------------------
// D6: currentName === '' → displayCurrentName = '(unnamed)'; non-empty passes through
// ---------------------------------------------------------------------------

describe('buildRenameViewModel D6: empty currentName → displayCurrentName "(unnamed)"', () => {
  it('BITES: currentName:"" → displayCurrentName:"(unnamed)" — kills impl that passes "" through as display name', () => {
    // D6: store.player(identity)?.name can be '' for a never-named player.
    // The overlay must show '(unnamed)' as a placeholder, not a blank label.
    // WRONG IMPL KILLED: `displayCurrentName: currentName` (passes '' through).
    const vm = buildRenameViewModel('', 'SomeDraft');
    expect(vm.displayCurrentName).toBe('(unnamed)');
    // canSubmit is true — the empty currentName does not block submission
    expect(vm.canSubmit).toBe(true);
    expect(vm.trimmedDraft).toBe('SomeDraft');
  });

  it('BITES: non-empty currentName passes through unchanged — kills impl that always shows "(unnamed)"', () => {
    // WRONG IMPL KILLED: an impl that always substitutes '(unnamed)' regardless of currentName.
    const vm = buildRenameViewModel('Mira', 'NewName');
    expect(vm.displayCurrentName).toBe('Mira');
  });

  it('BITES: whitespace currentName is NOT "(unnamed)" — only empty string triggers the fallback (D6)', () => {
    // D6 specifies ''→'(unnamed)'; a name that is literally '   ' (unlikely but possible
    // from server) must not collapse to '(unnamed)' — the server is the SSOT on what is
    // a valid name.
    // WRONG IMPL KILLED: an impl that calls trim() on currentName to decide the fallback,
    // turning a whitespace-only but non-empty stored name into '(unnamed)'.
    const vm = buildRenameViewModel('   ', 'NewName');
    expect(vm.displayCurrentName).toBe('   ');
  });
});

// ---------------------------------------------------------------------------
// Shape guard: the returned object has exactly the three expected fields
// ---------------------------------------------------------------------------

describe('buildRenameViewModel return shape', () => {
  it('BITES: returned object has displayCurrentName, trimmedDraft, canSubmit — kills wrong-shape impl', () => {
    // WRONG IMPL KILLED: an impl returning { label, draft, enabled } or missing a field.
    const vm = buildRenameViewModel('A', 'B');
    expect(vm).toHaveProperty('displayCurrentName');
    expect(vm).toHaveProperty('trimmedDraft');
    expect(vm).toHaveProperty('canSubmit');
  });
});
