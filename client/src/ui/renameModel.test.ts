// ui/renameModel.test.ts — RED gating tests for pt-c1b §PTC1B-7 / §PTC1B-1 / D2 / D6.
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
//   validation SSOT. A model that re-implements those rules is the
//   anti-pattern — it creates a second SSOT that diverges when the server constant
//   changes. The absence of those tests is intentional and load-bearing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatTag } from './playerTag';
import { buildRenameViewModel } from './renameModel';

// Spied, not replaced: every call is recorded AND reaches the real formatter, so the tag cases read
// real catalog text, and one case swaps in a sentinel for a single call.
vi.mock('./playerTag', { spy: true });

afterEach(() => {
  vi.mocked(formatTag).mockClear();
});

// ---------------------------------------------------------------------------
// PTC1B-1 / D2: happy path — trim reflected in both trimmedDraft and canSubmit
// ---------------------------------------------------------------------------

describe('buildRenameViewModel happy path (PTC1B-7 / D2)', () => {
  it('BITES: (Old,  New  ) → { displayCurrentName:Old, trimmedDraft:New, canSubmit:true } — kills no-trim impl', () => {
    // WRONG IMPL KILLED: an impl that does not trim draft before comparing → trimmedDraft
    // is '  New  ' and canSubmit may still be true (non-empty) but trimmedDraft is wrong.
    // Also kills an impl that never sets canSubmit:true.
    const vm = buildRenameViewModel('Old', 0, '  New  ');
    expect(vm.displayCurrentName).toBe('Old');
    expect(vm.trimmedDraft).toBe('New');
    expect(vm.canSubmit).toBe(true);
  });

  it('BITES: exact-match (no surrounding spaces) → trimmedDraft matches input, canSubmit:true', () => {
    // Smoke: a draft with no leading/trailing whitespace must still produce canSubmit:true.
    // WRONG IMPL KILLED: a trim() that corrupts mid-word spaces (trim() does not do this,
    // but this pins the boundary).
    const vm = buildRenameViewModel('Hero', 0, 'NewHero');
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
    const vm = buildRenameViewModel('Alice', 0, '   ');
    expect(vm.canSubmit).toBe(false);
    expect(vm.trimmedDraft).toBe('');
  });

  it('★ BITES: empty string draft "" → canSubmit:false AND trimmedDraft:"" — kills impl that special-cases non-whitespace empty only', () => {
    // WRONG IMPL KILLED: an impl that only guards '' but not '  ' (whitespace).
    // Paired with the whitespace-only test above, together they require TRIM-THEN-CHECK.
    const vm = buildRenameViewModel('Alice', 0, '');
    expect(vm.canSubmit).toBe(false);
    expect(vm.trimmedDraft).toBe('');
  });

  it('BITES: tab-only draft "\\t\\t" → canSubmit:false AND trimmedDraft:"" — kills impl that only trims spaces', () => {
    // String.prototype.trim() strips all whitespace including tabs.
    // WRONG IMPL KILLED: an impl using replace(/^ +| +$/, '') that only strips spaces.
    const vm = buildRenameViewModel('Alice', 0, '\t\t');
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
    const vm = buildRenameViewModel('', 0, 'SomeDraft');
    expect(vm.displayCurrentName).toBe('(unnamed)');
    // canSubmit is true — the empty currentName does not block submission
    expect(vm.canSubmit).toBe(true);
    expect(vm.trimmedDraft).toBe('SomeDraft');
  });

  it('BITES: non-empty currentName passes through unchanged — kills impl that always shows "(unnamed)"', () => {
    // WRONG IMPL KILLED: an impl that always substitutes '(unnamed)' regardless of currentName.
    const vm = buildRenameViewModel('Mira', 0, 'NewName');
    expect(vm.displayCurrentName).toBe('Mira');
  });

  it('BITES: whitespace currentName is NOT "(unnamed)" — only empty string triggers the fallback (D6)', () => {
    // D6 specifies ''→'(unnamed)'; a name that is literally '   ' (unlikely but possible
    // from server) must not collapse to '(unnamed)' — the server is the SSOT on what is
    // a valid name.
    // WRONG IMPL KILLED: an impl that calls trim() on currentName to decide the fallback,
    // turning a whitespace-only but non-empty stored name into '(unnamed)'.
    const vm = buildRenameViewModel('   ', 0, 'NewName');
    expect(vm.displayCurrentName).toBe('   ');
  });
});

// ---------------------------------------------------------------------------
// Shape guard: the returned object has exactly the three expected fields
// ---------------------------------------------------------------------------

describe('buildRenameViewModel displayTag', () => {
  it('a minted discriminator gives the tag formatTag gives for it [lpw-40.1]', () => {
    // WRONG IMPL KILLED: a model that never computes a tag (displayTag stays null/undefined); an
    // unpadded `#${d}` (42 -> '#42'); a pad to another width.
    expect(buildRenameViewModel('Aria', 42, '').displayTag).toBe('#0042');
    expect(buildRenameViewModel('Aria', 7, '').displayTag).toBe('#0007');
    expect(buildRenameViewModel('Aria', 12345, '').displayTag).toBe('#12345');
    for (const d of [1, 42, 999, 10000, 123456]) {
      expect(buildRenameViewModel('Aria', d, '').displayTag, `discriminator ${d}`).toBe(
        formatTag(d),
      );
    }
  });

  it('the tag is formatTag output passed through as is, called with the discriminator [lpw-40.1]', () => {
    // WRONG IMPL KILLED: a copied `#` + padStart(4, '0') in the model (the sentinel never shows and
    // formatTag is never called); a tag built from another field (the draft or the name).
    vi.mocked(formatTag).mockClear();
    vi.mocked(formatTag).mockReturnValueOnce('TAG-SENTINEL');
    const vm = buildRenameViewModel('Aria', 42, 'Draft');
    expect(vm.displayTag).toBe('TAG-SENTINEL');
    expect(vi.mocked(formatTag)).toHaveBeenCalledWith(42);
  });

  it('a tag leaves the name, the trimmed draft and canSubmit as they are [lpw-40.1]', () => {
    // WRONG IMPL KILLED: a model that folds the tag into displayCurrentName ('Aria #0042'), which
    // would double the tag the view paints beside the name.
    const vm = buildRenameViewModel('Aria', 42, '  New  ');
    expect(vm.displayCurrentName).toBe('Aria');
    expect(vm.trimmedDraft).toBe('New');
    expect(vm.canSubmit).toBe(true);
  });

  it('discriminator 0, NaN, a negative and a fraction give no tag and never throw [lpw-40.2]', () => {
    // WRONG IMPL KILLED: a `d !== 0` guard ('#00-1', '#NaN', '#01.5'); a tag for 0 ('#0000'); a
    // throw on a bad value (the Profile frame would blank).
    for (const bad of [0, Number.NaN, -1, 1.5]) {
      let displayTag: string | null | undefined;
      expect(() => {
        displayTag = buildRenameViewModel('Aria', bad, '').displayTag;
      }, `discriminator ${bad} does not throw`).not.toThrow();
      expect(displayTag, `discriminator ${bad}`).toBeNull();
    }
  });

  it('with no tag the name fields are unchanged, an empty name still reads (unnamed) [lpw-40.2]', () => {
    // WRONG IMPL KILLED: a model that blanks or placeholders the name when there is no tag.
    const vm = buildRenameViewModel('Aria', 0, ' x ');
    expect(vm.displayCurrentName).toBe('Aria');
    expect(vm.trimmedDraft).toBe('x');
    expect(vm.canSubmit).toBe(true);
    expect(buildRenameViewModel('', 0, '').displayCurrentName).toBe('(unnamed)');
    expect(buildRenameViewModel('', 0, '').displayTag).toBeNull();
  });
});

describe('buildRenameViewModel return shape', () => {
  it('BITES: returned object has displayCurrentName, trimmedDraft, canSubmit — kills wrong-shape impl', () => {
    // WRONG IMPL KILLED: an impl returning { label, draft, enabled } or missing a field.
    const vm = buildRenameViewModel('A', 0, 'B');
    expect(vm).toHaveProperty('displayCurrentName');
    expect(vm).toHaveProperty('trimmedDraft');
    expect(vm).toHaveProperty('canSubmit');
  });
});
