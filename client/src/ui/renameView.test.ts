// @vitest-environment happy-dom
// ui/renameView.test.ts — RED gating tests for pt-c1b (ADR-0132 rename overlay).
//
// Slice: pt-c1b · Source-of-truth spec: specs/monster-realm-v2/M-playtest-c-ux-completion.spec.md
//
// RED REASON: renameView.ts does not exist yet.
// Every import below will fail until the implementer creates the module.
//
// WRONG-IMPL-KILLED list (one invariant per test group):
//   RT-RN-01  keyup guard            → keyup has no overlay guard; held-key bleeds after rename
//   RT-RN-02  movement suppression   → rename visible but unfocused → movement fires
//   RT-RN-03  pending lock reset     → rejection leaves button dead forever (ADR-0085 C6 precedent)
//   RT-RN-04  double-submit race     → rapid Enter+click submits twice
//   RT-RN-05  opening 'N' typed      → show()+auto-focus causes 'n' typed in field
//   RT-RN-06  canSubmit / whitespace → whitespace-only name must not submit
//   RT-RN-07  XSS guard              → name rendered via innerHTML not textContent
//   RT-RN-08  reducer arg key        → call uses wrong arg shape (no `name` key)
//   RT-RN-09  RL-15 evasion          → leaderboard files must not reference setProfileName
//   RT-RN-10  e2e SQL scope          → SELECT name FROM player without identity filter

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RenameView } from './renameView';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// DOM mount helpers
// ---------------------------------------------------------------------------

function mountRenameOverlay(): {
  overlay: HTMLDivElement;
  input: HTMLInputElement;
  submitBtn: HTMLButtonElement;
  feedback: HTMLElement;
} {
  const existing = document.getElementById('rename-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'rename-overlay';
  overlay.style.display = 'none';

  const input = document.createElement('input');
  input.id = 'rename-input';
  input.maxLength = 24;
  overlay.appendChild(input);

  const submitBtn = document.createElement('button');
  submitBtn.id = 'rename-submit';
  overlay.appendChild(submitBtn);

  const feedback = document.createElement('div');
  feedback.id = 'rename-feedback';
  overlay.appendChild(feedback);

  document.body.appendChild(overlay);
  return { overlay, input, submitBtn, feedback };
}

function teardown(): void {
  const el = document.getElementById('rename-overlay');
  if (el) el.remove();
}

// ---------------------------------------------------------------------------
// RT-RN-08 · reducer arg key
//
// The generated binding (set_profile_name_reducer.ts) exports `{ name: __t.string() }`.
// The call must be `reducers.setProfileName({ name })` — NOT `{ playerName }`,
// NOT `{ value }`, NOT a bare string.
// This test does NOT import module_bindings (that would be the RL-15 violation itself);
// it reads the generated binding source and asserts the exported key is literally `name`.
// ---------------------------------------------------------------------------

describe('RT-RN-08: reducer arg key is `name` (not a renamed alias)', () => {
  it('set_profile_name_reducer.ts exports a single string field named `name`', () => {
    const bindingPath = path.resolve(__dirname, '../module_bindings/set_profile_name_reducer.ts');
    const src = readFileSync(bindingPath, 'utf8');
    // The generated BSATN binding shape is `{ name: __t.string() }`.
    // A wrong impl might import it as `{ playerName }` or call with a different key.
    // Proof-of-teeth: if the binding is changed to e.g. `{ value: __t.string() }`, this fails.
    expect(src).toMatch(/name\s*:\s*__t\.string\(\)/);
    // Also assert there is NOT a second string field — the reducer has exactly one arg.
    const stringFields = src.match(/__t\.string\(\)/g) ?? [];
    expect(stringFields.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RT-RN-09 · RL-15: leaderboard files must not call setProfileName
//
// The rename overlay writes `player.name` via `set_profile_name`. The leaderboard
// is a pure-read view (ADR-0120, RL-15). The write path must NOT appear in
// leaderboardView.ts or leaderboardModel.ts — even through a helper indirection.
// ---------------------------------------------------------------------------

describe('RT-RN-09: leaderboard files are write-free (RL-15)', () => {
  const leaderboardFiles = ['leaderboardView.ts', 'leaderboardModel.ts'];

  for (const filename of leaderboardFiles) {
    it(`${filename} does not reference setProfileName or reducers.`, () => {
      const src = readFileSync(path.resolve(__dirname, filename), 'utf8');
      // Strip block comments to avoid false-negative from a comment-only reference.
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
      expect(stripped).not.toMatch(/setProfileName/);
      // Reducers call: `reducers.` — the leaderboard must make no write calls at all.
      expect(stripped).not.toMatch(/reducers\./);
    });
  }
});

// ---------------------------------------------------------------------------
// RT-RN-10 · e2e SQL must scope to identity
//
// The plan asserts `SELECT name FROM player` — but the player table has rows
// for ALL connected players. Without a WHERE clause scoped to the test identity,
// an unrelated player whose name already matches the target gives a false pass.
//
// This test reads any e2e rename spec file and requires a WHERE or identity filter
// in the SQL helper — analogous to parseProfileRows identity-set filter in ranked-forfeit.
// ---------------------------------------------------------------------------

describe('RT-RN-10: e2e SQL query must filter by identity', () => {
  it('rename e2e spec scopes the SQL SELECT to the test identity (not entire table)', () => {
    // The e2e file must not contain an unscoped `SELECT name FROM player` without
    // either a WHERE clause or a parse helper that filters by identity.
    // We look for any e2e file that references the rename flow.
    const e2eDir = path.resolve(__dirname, '../../../e2e');
    let renameSpecSrc = '';
    try {
      // Try known candidate names. The implementer MUST create one of these.
      for (const candidate of ['rename.spec.ts', 'profile-rename.spec.ts', 'pt-c1b.spec.ts']) {
        try {
          renameSpecSrc = readFileSync(path.resolve(e2eDir, candidate), 'utf8');
          break;
        } catch {
          // not found, try next
        }
      }
    } catch {
      // no e2e dir at all
    }

    if (renameSpecSrc === '') {
      // No e2e spec exists yet — this test is a RED forcing function.
      // Fail with a clear message so the implementer knows what to create.
      expect.fail(
        'RT-RN-10: no rename e2e spec found. Create client/e2e/rename.spec.ts with an ' +
          'identity-scoped SQL assertion (filter by __game().identity, not the whole player table).',
      );
    }

    // Strip comments before checking.
    const stripped = renameSpecSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

    // An unscoped query is: `SELECT name FROM player` with no WHERE and no
    // identity-filter in the parse helper. Require at least one of:
    //   - a WHERE clause in the SQL string, or
    //   - a reference to the identity (identity variable) near the SELECT.
    const hasScopedQuery =
      /SELECT\s+.*FROM\s+player\s+WHERE/i.test(stripped) ||
      // The ranked-forfeit pattern: query all rows, then filter by identity set in JS.
      (/SELECT\s+identity.*FROM\s+player/i.test(stripped) && /identit/i.test(stripped));

    expect(hasScopedQuery).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The tests below require renameView.ts to exist.
// They are RED until the implementer creates the module.
// ---------------------------------------------------------------------------

describe('RT-RN-03: pending lock resets on reducer rejection (ADR-0085 C6)', () => {
  let view: RenameView;
  let submitCalls: Array<{ name: string }>;
  let rejectFn!: (err: Error) => void;

  beforeEach(() => {
    mountRenameOverlay();
    submitCalls = [];
    view = new RenameView({
      onSubmit: (name: string) => {
        submitCalls.push({ name });
        // Return a promise that we can reject externally to simulate reducer rejection.
        return new Promise<void>((_, reject) => {
          rejectFn = reject;
        });
      },
    });
  });

  afterEach(teardown);

  it('submit button is re-enabled after a reducer rejection (dead-button-forever caught)', async () => {
    view.show();
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const submitBtn = document.getElementById('rename-submit') as HTMLButtonElement;

    input.value = 'ValidName';

    // First submit — sets pending lock.
    submitBtn.click();
    expect(submitCalls.length).toBe(1);

    // Simulate reducer rejection.
    rejectFn(new Error('set_profile_name: name contains invalid characters'));
    // Drain microtasks.
    await Promise.resolve();

    // The lock MUST be reset so the user can retry.
    // A broken impl leaves submitBtn.disabled = true forever (ADR-0085 C6 precedent:
    // dismissPending must reset on rejection, same as dismissDialogue).
    expect(submitBtn.disabled).toBe(false);

    // A second submit must go through.
    submitBtn.click();
    expect(submitCalls.length).toBe(2);
  });
});

describe('RT-RN-04: double-submit prevention', () => {
  let view: RenameView;
  let submitCalls: number;
  let resolveFn!: () => void;

  beforeEach(() => {
    mountRenameOverlay();
    submitCalls = 0;
    view = new RenameView({
      onSubmit: (_name: string) => {
        submitCalls++;
        return new Promise<void>((resolve) => {
          resolveFn = resolve;
        });
      },
    });
  });

  afterEach(teardown);

  it('rapid button click + Enter while in flight submits exactly once', async () => {
    view.show();
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const submitBtn = document.getElementById('rename-submit') as HTMLButtonElement;

    input.value = 'NewName';

    // Rapid double-submit.
    submitBtn.click();
    submitBtn.click();
    // Also fire Enter as the input's keydown handler would.
    input.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }),
    );
    await Promise.resolve();

    // Only ONE call should have gone out — the pending lock guards the rest.
    expect(submitCalls).toBe(1);
    resolveFn();
  });
});

describe('RT-RN-06: canSubmit — whitespace-only name must not submit', () => {
  let view: RenameView;
  let submitCalls: number;

  beforeEach(() => {
    mountRenameOverlay();
    submitCalls = 0;
    view = new RenameView({
      onSubmit: async (_name: string) => {
        submitCalls++;
      },
    });
  });

  afterEach(teardown);

  it('submitting "   " (whitespace only) does not call onSubmit', async () => {
    view.show();
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const submitBtn = document.getElementById('rename-submit') as HTMLButtonElement;

    input.value = '   ';
    submitBtn.click();
    await Promise.resolve();

    // Server would reject (trim → empty → "name must not be empty"), but the
    // client-side canSubmit guard should block the call entirely (trim check).
    expect(submitCalls).toBe(0);
  });

  it('submitting a 25-char name does not call onSubmit (client maxlength guard)', async () => {
    view.show();
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const submitBtn = document.getElementById('rename-submit') as HTMLButtonElement;

    // Note: input.maxLength=24 prevents DOM typing of 25 chars, but programmatic
    // assignment bypasses it. The view's canSubmit must also check length.
    input.value = 'A'.repeat(25);
    submitBtn.click();
    await Promise.resolve();

    expect(submitCalls).toBe(0);
  });
});

describe('RT-RN-07: XSS — name rendered via textContent not innerHTML', () => {
  it('renameView.ts source does not use innerHTML with name data', () => {
    const src = readFileSync(path.resolve(__dirname, 'renameView.ts'), 'utf8');
    // Strip block comments.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    // Allow innerHTML='' (container clear) but reject innerHTML=<expr with name>.
    // Pattern: innerHTML used in a right-hand assignment that is NOT an empty string literal.
    const innerHtmlAssignments = stripped.match(/\.innerHTML\s*=\s*(?!['"`]['"`])/g) ?? [];
    // Any non-empty innerHTML assignment is suspect — renameView should only use textContent.
    expect(innerHtmlAssignments.length).toBe(0);
  });
});

describe('RT-RN-02: movement suppression — rename overlay visible blocks movement', () => {
  // This test documents the invariant that the keydown movement-suppression block
  // in main.ts (lines 818-831 as of pt-c1b branch) MUST include renameView?.visible.
  // It reads main.ts source after the slice is implemented and asserts the presence
  // of `renameView` in the suppression block.
  //
  // RED reason: main.ts does not yet have renameView — this fails pre-impl.

  it('main.ts movement suppression block references renameView', () => {
    const mainSrc = readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8');

    // Locate the movement-suppression block: the comment and the condition that
    // precedes the KEY_DIR lookup. The exact text from main.ts:818 is:
    // "Suppress movement input while an overlay is open."
    const suppressIdx = mainSrc.indexOf('Suppress movement input while an overlay is open');
    expect(suppressIdx).toBeGreaterThan(0);

    // Extract the next ~400 chars (the if-condition body).
    const suppressBlock = mainSrc.slice(suppressIdx, suppressIdx + 400);

    // renameView must appear in this block.
    expect(suppressBlock).toMatch(/renameView/);
  });

  it('main.ts reconcile overlay-guard references renameView (second movement path)', () => {
    // The reconcile listener at ~line 389 re-issues held direction.
    // It has its own overlay guard that must also include renameView.
    const mainSrc = readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8');

    const reconIdx = mainSrc.indexOf('Honor reconcile');
    expect(reconIdx).toBeGreaterThan(0);

    const reconBlock = mainSrc.slice(reconIdx, reconIdx + 600);
    expect(reconBlock).toMatch(/renameView/);
  });

  it('main.ts frame-loop overlay guard references renameView (third movement path)', () => {
    // The rAF frame loop at ~line 1762 also guards held-key re-issue.
    const mainSrc = readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8');

    const frameIdx = mainSrc.indexOf('Re-issue the held dir so a held key keeps walking');
    expect(frameIdx).toBeGreaterThan(0);

    const frameBlock = mainSrc.slice(frameIdx, frameIdx + 500);
    expect(frameBlock).toMatch(/renameView/);
  });
});

describe('RT-RN-01: keyup listener has no overlay guard — held-key bleeds after rename', () => {
  // This is the CRITICAL structural finding.
  //
  // The window `keyup` handler at main.ts:847 is:
  //   window.addEventListener('keyup', (e) => {
  //     const dir = KEY_DIR[e.code];
  //     if (dir !== undefined) held.release(dir);
  //   });
  //
  // There is NO overlay guard. This means:
  //   1. User holds 'S' (South) → keydown fires → held.press('South') BUT
  //      if renameView.visible is true the movement block fires ONLY IF renameView
  //      is missing from line 818. With renameView in the block: movement is
  //      suppressed. But keydown still registered the key as held IF it passed
  //      the overlay check... actually if the block is correctly patched the
  //      keydown for movement never calls held.press. HOWEVER:
  //
  //   2. Scenario 2 (Escape scenario): user holds 'S' BEFORE opening rename.
  //      'S' is in held stack. Rename opens. Escape closes rename. Now renameView
  //      is no longer visible. On the NEXT keyup for 'S', held.release('South')
  //      fires. But the key was still physically held. The NEXT keydown for 'S'
  //      will fire on the input (since input's stopPropagation prevents window
  //      from seeing it). If focus leaves the input (click elsewhere), window
  //      keydown fires for 'S' → held.press('South') IF renameView is gone.
  //
  //   3. WORSE Scenario — focus loss: rename overlay visible, user Tabs out of
  //      the input. Focus is now on document.body. Window keydown fires. The
  //      overlay guard (IF renameView is in it) suppresses movement. But keyup
  //      unconditionally calls held.release. So the held stack is corrupted.
  //
  // The gating invariant: the keyup listener MUST guard on renameView?.visible.
  // If it does not, pressing then releasing a direction key while rename is open
  // will corrupt the held stack.

  it('main.ts keyup listener guards held.release on renameView (RT-RN-01 keyup gate)', () => {
    const mainSrc = readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8');

    // Find the keyup listener body.
    const keyupIdx = mainSrc.indexOf('Release a held movement key');
    expect(keyupIdx).toBeGreaterThan(0);

    // Extract until the closing });
    const keyupSlice = mainSrc.slice(keyupIdx, keyupIdx + 300);

    // The fix: either (a) keyup guards on renameView?.visible, or
    // (b) keyup calls held.clear() when rename is visible, or
    // (c) rename hide() calls held.clear() before hide.
    // Any of these is acceptable. Assert renameView appears here OR the
    // view's hide() calls held.clear().
    const hasKeyupGuard = /renameView/.test(keyupSlice);

    if (!hasKeyupGuard) {
      // Alternative fix: renameView.hide() clears held keys.
      // Check that the RenameView source calls held.clear or has a clear callback.
      let renameViewSrc = '';
      try {
        renameViewSrc = readFileSync(path.resolve(__dirname, 'renameView.ts'), 'utf8');
      } catch {
        // file doesn't exist yet — test stays RED (correct)
      }
      const viewClearsHeld = /heldClear|held\.clear|onHide.*clear|clearHeld/.test(renameViewSrc);
      expect(hasKeyupGuard || viewClearsHeld).toBe(true);
    }
  });
});

describe('RT-RN-05: opening KeyN must not type "n" into the field', () => {
  // The plan says show() auto-focuses the input. The KeyN keydown event fires
  // BEFORE focus moves (focus is synchronous but the keydown handler processes
  // the key first). If the overlay calls input.focus() synchronously, the field
  // is focused at keydown time and the 'n' would be typed... unless the field
  // listener calls e.stopPropagation() on keydown (which the plan mandates).
  //
  // But there is a subtlety: the window keydown handler fires, then calls
  // renameView.show() which calls input.focus(). The KeyN event already propagated
  // past the input. So 'n' cannot type via bubbling. HOWEVER: if main.ts does NOT
  // call e.preventDefault() after opening rename, the browser may commit the 'n'
  // into the newly focused element on the UP event (browser-dependent).
  //
  // Gating test: KeyN branch in main.ts calls e.preventDefault().

  it('main.ts KeyN branch calls e.preventDefault()', () => {
    const mainSrc = readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8');

    // Find the KeyN handler.
    const keyNIdx = mainSrc.indexOf('KeyN');
    expect(keyNIdx).toBeGreaterThan(0);

    // Extract the KeyN block (up to the next `return;`).
    const keyNBlock = mainSrc.slice(keyNIdx, keyNIdx + 500);
    expect(keyNBlock).toMatch(/e\.preventDefault\(\)/);
  });
});
