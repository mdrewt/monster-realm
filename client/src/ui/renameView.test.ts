// @vitest-environment happy-dom
// ui/renameView.test.ts — RED gating tests for pt-c1b DOM shell (PTC1B-2/5/6/7/8 + RT-RN-02/03/07/08).
//
// Slice: pt-c1b · Source-of-truth spec: docs/specs/pt-c1b-plan.md + docs/adr/0133-rename-ui.md
//
// RED REASON: renameView.ts does not exist yet.
// Every test below will fail with:
//   "Failed to resolve import './renameView'" (module-not-found)
//
// WRONG-IMPL-KILLED list (one per criterion):
//   - "ctor silently accepts missing DOM"         → throw-on-missing-overlay test catches it
//   - "ctor silently accepts missing child"       → throw-on-missing-child tests catch it
//   - "render never updates disabled state"       → render-disabled tests catch it
//   - "render uses innerHTML (XSS)"               → RT-RN-07 source-scan catches it
//   - "input keydown doesn't stopPropagation"    → stopPropagation spy tests (PTC1B-5) catch it
//   - "Enter calls onSubmit with raw value"       → Enter-submit test catches it
//   - "Escape calls onSubmit"                     → Escape-no-call test catches it
//   - "empty/whitespace submit calls onSubmit"   → PTC1B-7 submit-click tests catch it
//   - "double-click calls onSubmit twice"        → PTC1B-2 pending lock test catches it
//   - "reject leaves button disabled forever"    → RT-RN-03 finally test catches it
//   - "hide doesn't clear input/feedback"        → RT-RN-02 hide-reset tests catch it
//   - "binding exports wrong key"                 → RT-RN-08 shape scan catches it
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.
// Corrections must be traced to the spec and must not weaken the bite.
//
// ---------------------------------------------------------------------------
// m23-s3 ADDITION (2026-08-24) — overlay a11y wiring. (The PROVISIONAL ten-file `.focus(` scan
// that shipped alongside it was retired in rb-16 / ADR-0217; `evals/overlay-a11y-manifest.eval.mjs`
// [A11Y-15] owns that ban now, over all eighteen views.)
// ADDITIVE ONLY: nothing above was weakened or deleted; the mount helper gained the
// `role`/`aria-modal` attributes client/index.html:57 has always shipped, and a file-level a11y
// sweep was added.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/15/16);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1/F2/F7/F8, §1 D1/D2/D7/D8, §2 T5, §4,
//   §7 A1/A3/A5/A6/A7/A8/A13; memory/projects/gates/m23-s3.gates.md X1/X2/X3/X5/X6/X8;
//
// RED REASON (m23-s3), TWO DISTINCT ONES:
//   (a) `client/src/ui/renameView.ts` DOES NOT CALL openOverlayA11y/closeOverlayA11y at all today
//       (ui/renameView.ts:99-103). Every S3-* wiring test below therefore fails now.
//   (b) `ui/renameView.ts:102` STILL OWNED a view-local `setTimeout(() => this.#input.focus(), 0)`,
//       which S3 DELETED. That deletion has long since shipped: no view-local deferred focus
//       remains here, and the ban is now enforced by `evals/overlay-a11y-manifest.eval.mjs`
//       [A11Y-15] over all EIGHTEEN `client/src/ui/*View.ts` files (readdir-derived roster, so a
//       new view is scanned the day it lands; eight focus spellings, not just the literal
//       `.focus(`). NOTE this is exactly why S3-renameView-DEFER-FOCUS also
//       asserts the open helper was CALLED: this view already defers its own focus, so the two
//       focus polarities ALONE would pass on the unwired code and prove nothing (measured shape).
// Every PTC1B / RT-RN test above still passes.
//
// TWO ORACLES, BOTH REQUIRED (plan A3, measured by red-team):
//   * VALUE oracle  — `aria-label === t(OVERLAY_A11Y['renameView'].labelKey)`. `role`/`aria-modal`
//     are ALREADY static literals on the shell in client/index.html:57 (m23-s2), so asserting them
//     ALONE is VACUOUS: a view that calls nothing passes. They are asserted only alongside
//     aria-label, and their ABSENCE after close is the anti-vacuity partner (attack V1).
//   * MECHANISM oracle — `vi.mock('./overlayA11y', { spy: true })` records the calls AND calls
//     through to the real implementation, so a cheat that hand-writes the three attributes with the
//     correct copied literal (no trap, no return-focus record, no timer) still reds.
//
// WHY THE m23-s3 BLOCK IS DECLARED FIRST IN THIS FILE: several describes below call
// `vi.restoreAllMocks()` in their afterEach. Declaration order is execution order in vitest, so the
// S3 block runs before any of them and its module-level auto-spy cannot be torn down underneath it.
//
// TEST-ISOLATION DEVICE (plan A8 / V7, copied from ui/overlayA11y.test.ts:97-105): overlayA11y.ts
// holds ONE module-private Map and exports no reset hook, so the file-level beforeEach/afterEach
// call the PRODUCTION closeOverlayA11y(id, null) for every OverlayId and flush ONE REAL MACROTASK
// — legal because close-without-open is a documented no-op (ui/overlayA11y.ts:41-45). It also
// cancels the deferred-focus timer that every `view.show()` in this file schedules (today the
// view's own; after S3, the helper's — plan residual A12), so no stray timer can fire inside a
// later test. `vi.clearAllMocks()` runs LAST so the sweep never pollutes a count.
//
// m23-s3 WRONG-IMPL-KILLED index:
//   - never opens / attribute-only cheat                 -> S3-renameView-OPEN-ARIA + -HELPER-CALLED
//   - copy-pasted WRONG OverlayId                        -> S3-renameView-OPEN-ARIA (label) + -HELPER-CALLED (id arg)
//   - view keeps its OWN setTimeout focus (the deletion not done)
//                                                        -> evals/overlay-a11y-manifest.eval.mjs [A11Y-15]
//                                                           + -DEFER-FOCUS (call assertion)
//   - synchronous focus (no defer)                       -> S3-renameView-DEFER-FOCUS (negative polarity)
//   - focuses nothing / a wrapper, not the anchor         -> S3-renameView-DEFER-FOCUS (identity)
//   - close never strips ARIA / never restores focus      -> S3-renameView-CLOSE-RESTORE
//   - UNGUARDED show() / `this.visible` read AFTER the write -> S3-renameView-REPEAT-NO-REOPEN
//   - `fallbackFocus` passed as undefined/an element       -> S3-renameView-HELPER-CALLED (literal null)
//   - GUARDED close in hide() (plan anti-pattern #3 — kills S1's A13 self-heal)
//                                                        -> S3-renameView-CLOSE-UNGUARDED
//   - a `.focus(` hidden behind a quote-bearing regex literal (measured stripper hole)
//                                                        -> evals/overlay-a11y-manifest.eval.mjs [A11Y-15]
//                                                           (real-file divergence tooth: comment-stripped
//                                                           vs comment+string-stripped must agree on all 18)
//
// ---------------------------------------------------------------------------
// uif-16b (UIF16B.1-UIF16B.4): the rename view is Profile's Name SECTION, not an overlay. It opens
// no a11y of its own (the one dialog, trap and deferred `#rename-input` anchor are ProfileView's,
// gated in ui/profileView.test.ts UIF16B.3), carries no frame classes, leads with an
// `h2#rename-title.mr-section-header` instead of a frame title bar, and is walked by the frame
// (its `applyRowOp` retires: the walk, the clamp, the token-once memo and "A on the field presses
// nothing" are gated at frame level in ui/profileView.test.ts UIF16B.2). Its own Escape no longer
// hides it (a section never hides alone; main.ts's typing rule owns Escape). The m23-s3 a11y
// block above is therefore REPLACED by UIF16B.3's section-level "opens nothing" test below; the
// index above stays as the record of what the frame-level suite now kills.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Bindings, DEFAULT_BINDINGS } from '../input/bindings';
import { CATALOG_EN } from './i18n/catalog.en';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_IDS } from './overlayRegistry';
import { RenameView } from './renameView';
import { type RowOp, type RowSection, walkSection } from './screens/profileScreen';

// The m23-s3 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works.
vi.mock('./overlayA11y', { spy: true });

// ---------------------------------------------------------------------------
// DOM mount helper — installs the index.html shell for renameView.
// Each test gets a fresh DOM via beforeEach to prevent cross-test contamination.
// ---------------------------------------------------------------------------

function mountRenameOverlay(): {
  overlay: HTMLElement;
  currentEl: HTMLElement;
  input: HTMLInputElement;
  submitBtn: HTMLButtonElement;
} {
  const existing = document.getElementById('rename-overlay');
  if (existing) existing.remove();

  // m23-s3 FIXTURE FIDELITY: `role`/`aria-modal` have shipped as STATIC LITERALS
  // on this shell since m23-s2. They are copied here NOT to be asserted on their own — that is
  // vacuous, a view calling nothing passes — but so that "all three attributes ABSENT after close"
  // is a real tooth: only closeOverlayA11y can remove them. No
  // `tabindex` is added: this overlay's OVERLAY_A11Y anchor is #rename-input, natively focusable,
  // exactly as index.html:59 has it.
  // uif-16b (named fixture change): the new index.html ships #rename-overlay as Profile's Name
  // section: class `mr-button-rows`, NO role / aria-modal (the one dialog is #profile-overlay).
  // Was: `role="dialog" aria-modal="true"` and no class.
  document.body.innerHTML = `
    <div id="rename-overlay" class="mr-button-rows" style="display:none">
      <div id="rename-current" data-testid="rename-current"></div>
      <input id="rename-input" data-testid="rename-input" type="text" maxlength="24" />
      <button id="rename-submit" data-testid="rename-submit">Rename</button>
    </div>
  `;
  // INTENTIONAL CHANGE (uif-4b, UIF4B.5): `#rename-feedback` is retired (the rename outcome goes
  // through the one seam, to the toast), so the fixture no longer mounts it. Was: a
  // `div#rename-feedback[data-testid=rename-feedback]` after the submit button, which the
  // constructor looked up or threw on.

  const overlay = document.getElementById('rename-overlay') as HTMLElement;
  const currentEl = document.getElementById('rename-current') as HTMLElement;
  const input = document.getElementById('rename-input') as HTMLInputElement;
  const submitBtn = document.getElementById('rename-submit') as HTMLButtonElement;
  return { overlay, currentEl, input, submitBtn };
}

function teardown(): void {
  document.body.innerHTML = '';
}

/** uif-16b: the section's own `applyRowOp` retires (ProfileView walks the one column). This is the
 *  frame's one-token rule over THIS section alone (`walkSection` over its RowSection; a pressed row
 *  is clicked only when it is a button, so A on the field presses nothing), so the section's rows
 *  and default row stay pinned here. The token-once identity memo is the frame's now
 *  (ui/profileView.test.ts UIF16B.2). */
function walk(section: RowSection, op: RowOp): void {
  const press = walkSection(section, document.activeElement, op);
  if (press instanceof HTMLButtonElement) press.click();
}

// Minimal ViewModel shape that RenameView.render() accepts.
// Mirrors buildRenameViewModel's return type.
interface RenameViewModel {
  displayCurrentName: string;
  trimmedDraft: string;
  canSubmit: boolean;
}

// ---------------------------------------------------------------------------
// flushPromises: drain the microtask queue (for .finally()-driven state reset).
// Three rounds cover: initiation → then/catch → finally.
// ---------------------------------------------------------------------------
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Overlay a11y wiring.
// Declared FIRST on purpose (see the file header): later describes call vi.restoreAllMocks().
// ---------------------------------------------------------------------------

/** One REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0),
 *  and fake timers are banned for this defer (plan anti-pattern #10). */
async function s3FlushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// NEW file-level isolation hooks. They run BEFORE the describe-level `mountRenameOverlay`
// hooks below, so every test still gets the DOM it always got.
beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s3FlushMacrotask();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s3FlushMacrotask();
});

// uif-16b: the six m23-s3 tests that stood here (OPEN-ARIA, DEFER-FOCUS, CLOSE-RESTORE,
// REPEAT-NO-REOPEN, HELPER-CALLED, CLOSE-UNGUARDED) pinned this view's OWN overlay a11y, which
// retires: the section opens nothing. Their frame-level equivalents are ui/profileView.test.ts
// UIF16B.3 (one dialog labelled from a11yCopy via the helper, the deferred #rename-input anchor in
// both polarities, close strips and restores focus, a repeat show() neither re-opens nor moves
// focus, the unguarded close) and S10-WIRE-*:profileView in ui/overlayA11yWiring.test.ts. What is
// left to assert HERE is the section half: it calls neither helper and carries no dialog ARIA.

describe('RenameView (uif-16b): a section opens no a11y of its own', () => {
  it('UIF16B.3 show(), a repeat show() and hide() never call openOverlayA11y or closeOverlayA11y, and the section root never carries role, aria-modal or aria-label', async () => {
    // WRONG IMPL KILLED: a section that still opens its own dialog (two traps cannot coexist: the
    // frame's would be suspended under the section's, and Tab would be caught in the Name section
    // alone); a section that writes the dialog attributes by hand; a hide() that still closes
    // `renameView` (an id that no longer exists in the registry).
    const { overlay } = mountRenameOverlay();
    const view = new RenameView({ onSubmit: async () => {} });
    expect(view.visible, 'precondition: the section starts hidden').toBe(false);
    view.show();
    view.show();
    await s3FlushMacrotask();
    expect(view.visible, 'ANTI-VACUITY: the section was shown').toBe(true);
    for (const attr of ['role', 'aria-modal', 'aria-label']) {
      expect(overlay.hasAttribute(attr), `shown: no ${attr}`).toBe(false);
    }
    view.hide();
    expect(view.visible).toBe(false);
    expect(vi.mocked(openOverlayA11y), 'the section opens nothing').not.toHaveBeenCalled();
    expect(vi.mocked(closeOverlayA11y), 'nor closes anything').not.toHaveBeenCalled();
    expect(overlay.classList.contains('mr-frame'), 'no frame class').toBe(false);
    expect(overlay.classList.contains('mr-shell'), 'no shell class').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constructor: throw on missing required DOM nodes
// ---------------------------------------------------------------------------

describe('RenameView constructor: throws when required DOM nodes are missing', () => {
  afterEach(() => {
    teardown();
  });

  it('BITES: ctor throws when #rename-overlay is absent — kills no-guard impl', () => {
    // WRONG IMPL KILLED: an impl that silently stores null from getElementById without
    // guarding — the view would silently do nothing on render/show/hide.
    // DOM is empty (teardown ran); no overlay exists.
    expect(() => new RenameView({ onSubmit: async () => {} })).toThrow();
  });

  it('BITES: ctor throws when #rename-current child is missing — kills partial-DOM impl', () => {
    // Mount overlay WITHOUT the #rename-current child to exercise the second throw path.
    // WRONG IMPL KILLED: an impl that only checks for #rename-overlay, not the children.
    const overlay = document.createElement('div');
    overlay.id = 'rename-overlay';
    overlay.style.display = 'none';
    // Add input, submit, feedback but NOT #rename-current
    overlay.innerHTML = `
      <input id="rename-input" />
      <button id="rename-submit">Rename</button>
      <div id="rename-feedback"></div>
    `;
    document.body.appendChild(overlay);
    expect(() => new RenameView({ onSubmit: async () => {} })).toThrow();
  });

  it('BITES: ctor throws when #rename-input child is missing — kills partial-DOM impl', () => {
    // WRONG IMPL KILLED: an impl that guards current/submit/feedback but not the input.
    const overlay = document.createElement('div');
    overlay.id = 'rename-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div id="rename-current"></div>
      <button id="rename-submit">Rename</button>
      <div id="rename-feedback"></div>
    `;
    document.body.appendChild(overlay);
    expect(() => new RenameView({ onSubmit: async () => {} })).toThrow();
  });

  it('BITES: ctor throws when #rename-submit child is missing — kills partial-DOM impl', () => {
    // WRONG IMPL KILLED: an impl that guards other children but not the submit button.
    const overlay = document.createElement('div');
    overlay.id = 'rename-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div id="rename-current"></div>
      <input id="rename-input" />
      <div id="rename-feedback"></div>
    `;
    document.body.appendChild(overlay);
    expect(() => new RenameView({ onSubmit: async () => {} })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Visibility: visible / show / hide
// ---------------------------------------------------------------------------

describe('RenameView visibility: show / hide / visible', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('BITES: visible is false initially (display:none in index.html) — kills visible=true-at-construction impl', () => {
    // WRONG IMPL KILLED: an impl that calls show() in the constructor or always returns true.
    const view = new RenameView({ onSubmit: async () => {} });
    expect(view.visible).toBe(false);
  });

  it('BITES: show() makes visible=true — kills no-op show impl', () => {
    // WRONG IMPL KILLED: an impl where show() does nothing.
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    expect(view.visible).toBe(true);
  });

  it('BITES: hide() makes visible=false — kills no-op hide impl', () => {
    // WRONG IMPL KILLED: an impl where hide() does nothing.
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    view.hide();
    expect(view.visible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// render(): disabled state + textContent (PTC1B-7 + ADR-0133 D2 textContent-only)
// ---------------------------------------------------------------------------

describe('RenameView render(): disabled/enabled state and textContent', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('BITES: render({canSubmit:false}) sets #rename-submit.disabled=true — kills always-enabled impl', () => {
    // WRONG IMPL KILLED: an impl that never sets the disabled attribute.
    const view = new RenameView({ onSubmit: async () => {} });
    const vm: RenameViewModel = { displayCurrentName: 'X', trimmedDraft: '', canSubmit: false };
    view.render(vm);
    const btn = document.getElementById('rename-submit') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('BITES: render({canSubmit:true}) sets #rename-submit.disabled=false — kills always-disabled impl', () => {
    // WRONG IMPL KILLED: an impl that always leaves disabled=true.
    const view = new RenameView({ onSubmit: async () => {} });
    const vm: RenameViewModel = { displayCurrentName: 'X', trimmedDraft: 'Valid', canSubmit: true };
    view.render(vm);
    const btn = document.getElementById('rename-submit') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('BITES: render() sets #rename-current textContent to displayCurrentName — kills no-render impl', () => {
    // WRONG IMPL KILLED: an impl that ignores displayCurrentName or writes it to the wrong element.
    const view = new RenameView({ onSubmit: async () => {} });
    const vm: RenameViewModel = {
      displayCurrentName: 'Aria',
      trimmedDraft: 'New',
      canSubmit: true,
    };
    view.render(vm);
    const currentEl = document.getElementById('rename-current')!;
    expect(currentEl.textContent).toBe('Aria');
  });

  it('BITES: render() with displayCurrentName:"(unnamed)" sets textContent literally — kills impl that strips parens', () => {
    // D6: the model produces "(unnamed)" for an empty currentName; the view renders it verbatim.
    const view = new RenameView({ onSubmit: async () => {} });
    const vm: RenameViewModel = {
      displayCurrentName: '(unnamed)',
      trimmedDraft: '',
      canSubmit: false,
    };
    view.render(vm);
    const currentEl = document.getElementById('rename-current')!;
    expect(currentEl.textContent).toBe('(unnamed)');
  });
});

// ---------------------------------------------------------------------------
// ★★ PTC1B-5: stopPropagation teeth — typing a hotkey inside the input does NOT
//    reach the window keydown listener (the view's own listener stopPropagation'd it).
//    This bites a view that forgets e.stopPropagation() on the input's keydown.
// ---------------------------------------------------------------------------

describe('★★ RenameView PTC1B-5: input keydown stopPropagation prevents hotkey bleeding', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });

  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('★★ BITES: KeyL typed on input does NOT reach window keydown listener — kills missing-stopPropagation impl', () => {
    // WHILE the input is focused, typing a hotkey letter (KeyL) does NOT toggle
    // the leaderboard overlay. The view's own listener must call e.stopPropagation().
    // PROOF-OF-TEETH: a window keydown spy is NOT called when KeyL bubbles from the input.
    // A view that forgets stopPropagation lets the event bubble → the spy fires → test fails.
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();

    const spy = vi.fn();
    window.addEventListener('keydown', spy);

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', bubbles: true }));

    // The spy must NOT have been called — stopPropagation blocked bubbling.
    expect(spy).not.toHaveBeenCalled();

    window.removeEventListener('keydown', spy);
  });

  it('★★ BITES: KeyW typed on input does NOT reach window keydown listener — kills missing-stopPropagation impl (movement bleed)', () => {
    // Typing a movement key (KeyW = forward) inside the input must NOT move the
    // character. The stopPropagation test with KeyW covers the movement-bleed path
    // (the global movement handler fires on WASD).
    // WRONG IMPL KILLED: a view without stopPropagation allows the "W" keydown to reach the
    // global movement handler → character moves while the player is typing their name.
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();

    const spy = vi.fn();
    window.addEventListener('keydown', spy);

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));

    expect(spy).not.toHaveBeenCalled();

    window.removeEventListener('keydown', spy);
  });
});

// ---------------------------------------------------------------------------
// Enter key: calls onSubmit with trimmed value
// Escape key: does NOT call onSubmit and (uif-16b) no longer hides the section
// ---------------------------------------------------------------------------

describe('RenameView keyboard: Enter submits; Escape neither submits nor hides (PTC1B-2/6, uif-16b)', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });

  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('BITES: Enter on input with non-empty value calls onSubmit exactly once with trimmed value', async () => {
    // WRONG IMPL KILLED: an impl where Enter does nothing, or calls onSubmit with raw (untrimmed) value.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new RenameView({ onSubmit });
    view.show();

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = '  Hero  ';

    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
    await flushPromises();

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith('Hero');
  });

  it('BITES: NumpadEnter on input submits exactly like Enter (one onSubmit with the trimmed value) and still stops propagation', async () => {
    // WRONG IMPL KILLED: an input listener that matches `Enter` only (the keypad Enter, which the
    // shell's typing mode commits with like Enter, would do nothing in the Name field), and one
    // that submits on it but lets it bubble to the window keydown listener.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new RenameView({ onSubmit });
    view.show();

    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = '  Hero  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'NumpadEnter', bubbles: true }));
    await flushPromises();
    window.removeEventListener('keydown', spy);

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith('Hero');
    expect(spy, 'the keypad Enter is stopped at the input').not.toHaveBeenCalled();
  });

  it('BITES: Enter on input with empty value does NOT call onSubmit — PTC1B-7 gate on Enter path', async () => {
    // WRONG IMPL KILLED: an impl that calls onSubmit on Enter regardless of value.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new RenameView({ onSubmit });
    view.show();

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = '';

    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
    await flushPromises();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('UIF16B.4 Escape in the field does NOT hide the section root, does NOT call onSubmit, keeps the draft, and still stops at the input', async () => {
    // INTENTIONAL CHANGE (uif-16b): was "Escape on input hides the overlay AND does NOT call
    // onSubmit (PTC1B-6)". A section never hides alone (the Name section hidden inside an open
    // Profile frame would leave Account and Privacy floating under a title with no field);
    // main.ts's typing rule owns Escape and closes the whole frame (main.* boot suites).
    // WRONG IMPL KILLED: the old local Escape -> this.hide() kept; an Escape that submits; an
    // Escape that clears the draft; an Escape that bubbles to the window listener (the router
    // would then act on it twice).
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new RenameView({ onSubmit });
    view.show();
    expect(view.visible).toBe(true);

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = 'SomeName';
    const overlay = document.getElementById('rename-overlay') as HTMLElement;
    const shownDisplay = overlay.style.display;
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    window.removeEventListener('keydown', spy);
    await flushPromises();

    expect(view.visible, 'the section is still shown').toBe(true);
    expect(overlay.style.display, 'its display is untouched').toBe(shownDisplay);
    expect(overlay.style.display).not.toBe('none');
    expect(input.value, 'the draft survives').toBe('SomeName');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(spy, 'Escape is still stopped at the field').not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// empty/whitespace submit-click → onSubmit NOT called
// ---------------------------------------------------------------------------

describe('RenameView PTC1B-7: empty/whitespace submit does not call onSubmit', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });

  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('BITES: click submit with empty input → onSubmit NOT called — kills impl that submits empty names', () => {
    // WRONG IMPL KILLED: an impl that calls onSubmit regardless of the input value.
    // Server would reject but PTC1B-7 wants the client to suppress the call for UX.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new RenameView({ onSubmit });
    view.show();

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = '';

    const submitBtn = document.getElementById('rename-submit') as HTMLButtonElement;
    submitBtn.click();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('BITES: click submit with whitespace-only input → onSubmit NOT called — kills impl missing trim check', () => {
    // WRONG IMPL KILLED: an impl that checks `input.value !== ''` without trimming —
    // '   ' passes the raw check and calls onSubmit with a whitespace-only or trimmed-empty name.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new RenameView({ onSubmit });
    view.show();

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = '   ';

    const submitBtn = document.getElementById('rename-submit') as HTMLButtonElement;
    submitBtn.click();

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ★ PTC1B-2: double-submit lock — the #pending lock prevents onSubmit being
//   called twice before the first promise resolves.
// ---------------------------------------------------------------------------

describe('★ RenameView PTC1B-2: double-submit calls onSubmit exactly ONCE (#pending lock)', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });

  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('★ BITES: two rapid submit clicks before first promise resolves → onSubmit called exactly once', async () => {
    // WRONG IMPL KILLED: an impl without #pending lock — the second click fires another
    // reducer call before the first settles.
    // Uses a never-immediately-resolving promise to simulate in-flight state.
    let resolveFlight: (() => void) | undefined;
    const flightPromise = new Promise<void>((res) => {
      resolveFlight = res;
    });
    const onSubmit = vi.fn().mockReturnValue(flightPromise);

    const view = new RenameView({ onSubmit });
    view.show();

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = 'ValidName';

    const submitBtn = document.getElementById('rename-submit') as HTMLButtonElement;
    // First click → initiates the in-flight promise (onSubmit called once)
    submitBtn.click();
    // Second click immediately while still in-flight → must be a no-op (#pending lock)
    submitBtn.click();
    // Also try Enter as a third submit vector
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));

    await flushPromises();

    // onSubmit must have been called exactly once despite three submit attempts.
    expect(onSubmit).toHaveBeenCalledOnce();

    // Unblock the flight so the lock releases (cleanup).
    resolveFlight?.();
    await flushPromises();
  });
});

// ---------------------------------------------------------------------------
// ★ RT-RN-03: dead-button-forever — a rejecting onSubmit must re-enable the
//   button via .finally() (shopView #pending pattern precedent).
// ---------------------------------------------------------------------------

describe('★ RT-RN-03: rejecting onSubmit re-enables the submit button (.finally() lock reset)', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });

  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('★ BITES: button is re-enabled after onSubmit rejects — kills impl with no .finally()', async () => {
    // WRONG IMPL KILLED: an impl that uses `.then(reset)` only (not `.finally(reset)`).
    // When onSubmit rejects, the `.then` branch is not reached and the button stays
    // permanently disabled (the "dead-button-forever" antipattern, ADR-0085 C6 precedent).
    // PROOF-OF-TEETH: submit → reject → drain microtasks → assert button is enabled again.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSubmit = vi.fn().mockRejectedValue(new Error('server rejected'));

    const view = new RenameView({ onSubmit });
    view.show();

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = 'ValidName';

    const submitBtn = document.getElementById('rename-submit') as HTMLButtonElement;
    submitBtn.click();

    // Drain multiple microtask ticks so the rejection + .finally() all settle.
    await flushPromises();

    // The button must be enabled again — the .finally() reset the #pending lock.
    expect(submitBtn.disabled).toBe(false);

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// RT-RN-02 / M-2: hide() resets input value to '' and clears feedback
// ---------------------------------------------------------------------------

describe('RenameView RT-RN-02 / M-2: hide() resets input value and feedback', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('BITES: hide() clears #rename-input value to "" — kills impl that leaves stale draft on re-open', () => {
    // RT-RN-02: a stale draft persists when the overlay is re-opened if hide() does not reset it.
    // WRONG IMPL KILLED: an impl where hide() only changes display:none without resetting value.
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = 'StaleValue';

    view.hide();

    // After hide(), the input value must be cleared so the next open starts fresh.
    expect(input.value).toBe('');
  });

  it('UIF4B.5 hide() neither needs nor creates a #rename-feedback line (the view owns no message text), and the draft still clears', () => {
    // INTENTIONAL CHANGE (uif-4b, UIF4B.5): the view's feedback line is retired, so hide() no
    // longer clears one. Was: "hide() clears #rename-feedback textContent" (RT-RN-02), with a
    // `div#rename-feedback` in the fixture. The stale-message risk it guarded is now structural: the
    // outcome is a timed toast, never a node of this overlay (UIF4B.3 pins it end to end).
    // WRONG IMPL KILLED: a hide() that still looks the line up (a TypeError on null), or creates it.
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = 'StaleValue';
    expect(() => view.hide()).not.toThrow();
    expect(input.value, 'the draft is still reset').toBe('');
    expect(document.getElementById('rename-feedback'), 'no retired line appears').toBeNull();
  });
});

// ---------------------------------------------------------------------------
// showFeedback(): writes feedback text via textContent
// ---------------------------------------------------------------------------

describe('RenameView has no showFeedback (uif-4b)', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('UIF4B.5 the view has no showFeedback method (the rename outcome is the seam`s, not the view`s)', () => {
    // INTENTIONAL CHANGE (uif-4b, UIF4B.5): was "showFeedback('Name updated') sets #rename-feedback
    // textContent". The method and its node are retired: every rename message goes through the one
    // seam (a toast), so the view cannot pick a channel.
    // WRONG IMPL KILLED: a surviving showFeedback (a second, view-owned channel).
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    expect('showFeedback' in view, 'no showFeedback on the view').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ★ RT-RN-07: source-scan tooth — renameView.ts must not use innerHTML with data
//   (player-controlled name must NEVER be passed to innerHTML — XSS firewall).
//   ADR-0133 D2: "textContent only".
// ---------------------------------------------------------------------------

describe('★ RT-RN-07: renameView.ts source scan — no .innerHTML assignment', () => {
  it('★ BITES: renameView.ts source must not contain ".innerHTML =" — kills innerHTML-with-data impl', () => {
    // WRONG IMPL KILLED: an impl that sets element.innerHTML = vm.displayCurrentName (or any
    // player-supplied string). Player names are player-controlled; innerHTML = name is XSS.
    // ADR-0133 D2: the view uses textContent only (as leaderboardView does).
    // Uses .includes() — no new RegExp() (ReDoS/detect-non-literal lint ban).
    // NOTE: asserting absence of `.innerHTML =` entirely is correct — the view has no
    // static HTML templates it needs to inject (render/feedback are all textContent).
    // Rationale: any `.innerHTML =` in a view that handles player-controlled name strings
    // is an XSS sink. The spec says textContent only; there is no legitimate reason
    // for innerHTML in this shell.
    const viewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'renameView.ts');
    let src: string;
    try {
      src = readFileSync(viewPath, 'utf8');
    } catch (err) {
      // File must exist post-impl; throw so the test is RED (not vacuously-green)
      // until the implementer ships renameView.ts (m16.5a vacuous-revival-gate precedent).
      throw new Error(
        'renameView.ts could not be read — post-impl the file must exist: ' + String(err),
      );
    }
    expect(
      src.includes('.innerHTML ='),
      'renameView.ts must not contain ".innerHTML =" — player-controlled names must only be written via textContent (RT-RN-07, ADR-0133 D2)',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RT-RN-08: binding arg-shape — set_profile_name_reducer.ts declares exactly
//   one field: `name: __t.string()`. Guards the call site's `{ name }` key.
// ---------------------------------------------------------------------------

describe('RT-RN-08: set_profile_name_reducer.ts declares exactly one field "name: __t.string()"', () => {
  it('BITES: binding file contains "name: __t.string()" as the sole field — kills wrong-key impl', () => {
    // RT-RN-08: the reducer call site in main.ts will use `conn.reducers.setProfileName({ name })`.
    // If the binding exports a different key (e.g. `playerName`, `username`), the call is
    // silently type-wrong and the server rejects it. This scan pins the exact field shape.
    // WRONG IMPL KILLED: a regen'd binding with `playerName: __t.string()` or multiple fields.
    // Uses .includes() — no new RegExp().
    const bindingPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../module_bindings/set_profile_name_reducer.ts',
    );
    let src: string;
    try {
      src = readFileSync(bindingPath, 'utf8');
    } catch (err) {
      throw new Error(
        'set_profile_name_reducer.ts could not be read — the file must exist: ' + String(err),
      );
    }
    // The binding must declare `name: __t.string()` (the reducer's only parameter).
    expect(
      src.includes('name: __t.string()'),
      'set_profile_name_reducer.ts must contain "name: __t.string()" (RT-RN-08: guards the { name } call-site key)',
    ).toBe(true);
    // Negative: no second field like `playerName` or `displayName`.
    const badFields = ['playerName:', 'username:', 'displayName:', 'newName:'];
    for (const bad of badFields) {
      expect(
        src.includes(bad),
        `set_profile_name_reducer.ts must NOT contain "${bad}" — the only field is "name" (RT-RN-08)`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Review-hardening regression tests (impl review — reviewer B-1 / red-team F1 +
// the e2e-caught button-never-enables bug).
// ---------------------------------------------------------------------------
describe('RenameView review-hardening: live submit-enable, hide() lock reset, button stopPropagation', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('★ BITES: typing a non-empty name enables the submit button; clearing it disables — kills the "no input listener → button stuck disabled" bug the e2e caught', () => {
    // WRONG IMPL KILLED: a view whose button-disabled state is only set by render()
    // on open (empty draft → disabled) and never re-evaluated as the user types. Real
    // browsers do not fire click on a disabled button, so the rename would be unusable.
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const btn = document.getElementById('rename-submit') as HTMLButtonElement;

    input.value = 'ValidName';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.disabled, 'button must be ENABLED when the input has a non-empty name').toBe(false);

    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.disabled, 'button must be DISABLED when the input is whitespace-only').toBe(true);

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.disabled, 'button must be DISABLED when the input is empty').toBe(true);
  });

  it('★ BITES: hide() while a submit is in-flight resets the #pending lock — a later submit fires again (reviewer B-1: dead-button after reconnect force-hide)', async () => {
    // WRONG IMPL KILLED: a hide() that does not reset #pending. onReconnect / battle
    // auto-show force-hide this overlay; the SDK never settles the in-flight promise on
    // a link drop, so .finally() may never run → #pending stuck true forever.
    let resolveFirst: (() => void) | undefined;
    const onSubmit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveFirst = res; // never resolved during this test → keeps #pending true
        }),
    );
    const view = new RenameView({ onSubmit });
    view.show();
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const btn = document.getElementById('rename-submit') as HTMLButtonElement;

    input.value = 'FirstName';
    btn.click();
    expect(onSubmit).toHaveBeenCalledTimes(1); // #pending now true, promise never settles

    // Force-hide while in-flight (the reconnect / battle-auto-show path).
    view.hide();

    // Reopen and submit a new name: if hide() reset #pending, this fires; otherwise it is
    // swallowed by the stuck lock and onSubmit stays at 1 call.
    view.show();
    input.value = 'SecondName';
    btn.click();
    expect(
      onSubmit,
      'hide() must reset #pending so a post-hide submit can fire',
    ).toHaveBeenCalledTimes(2);

    resolveFirst?.(); // clean up the dangling promise
    await flushPromises();
  });

  it('★ BITES: a hotkey keydown on the submit BUTTON does not reach the window listener — button stopPropagation (red-team Finding 1)', () => {
    // WRONG IMPL KILLED: stopPropagation attached only to the input, not the button.
    // Tab-focus or a mouse click leaves the button focused; a KeyN keydown then bubbles
    // to the window keydown handler. The button's own keydown listener must stopPropagation.
    //
    // INTENTIONAL CHANGE (ctl-8h, CTL8H.2 / B5): this case probed KeyW. KeyW is a D-pad key
    // (DEFAULT_BINDINGS Up), and the submit button now lets the D-pad and B codes bubble to the
    // router (CTL8H-2-B5-SUBMIT-PROPAGATES below), so the hotkey probed here is KeyN, an
    // accelerator that stays shielded. Was: KeyW. The bite is unchanged: every non-D-pad key is
    // still stopped at the button.
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    const btn = document.getElementById('rename-submit') as HTMLButtonElement;
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    btn.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', bubbles: true }));
    expect(
      spy,
      'a keydown on the focused submit button must not bubble to window',
    ).not.toHaveBeenCalled();
    window.removeEventListener('keydown', spy);
  });
});

// ---------------------------------------------------------------------------
// ctl-8h (CTL8H.2): the rename frame's rows and the submit button's key shield.
//
// The rows are the view's REAL controls: [#rename-input, #rename-submit], the shown and enabled
// ones in DOM order. The cursor IS document.activeElement. nameScreen (ui/screens/profileScreen.ts)
// hands one-shot row tokens to the walk (uif-16b: ProfileView's, here the `walk` helper above,
// which is the frame's rule over this section alone):
//   move     focus the next/previous row from the focused one, clamped (no wrap); with no row
//            focused, focus the default row (#rename-input);
//   activate on a focused button click it once; on the focused input keep focus there (typing);
//            with NO row focused focus the default row and fire NOTHING.
// The token-once identity memo is the frame's since uif-16b (ui/profileView.test.ts UIF16B.2).
// ---------------------------------------------------------------------------

describe('RenameView ctl-8h: the section rows and the submit key shield', () => {
  const ENABLED: RenameViewModel = {
    displayCurrentName: 'X',
    trimmedDraft: 'Bob',
    canSubmit: true,
  };
  const DISABLED: RenameViewModel = { displayCurrentName: 'X', trimmedDraft: '', canSubmit: false };
  const move = (delta: -1 | 1): RowOp => ({ kind: 'move', delta });
  const activate = (): RowOp => ({ kind: 'activate' });
  const focusedId = (): string => (document.activeElement as HTMLElement | null)?.id ?? '';
  const blurAll = (): void => (document.activeElement as HTMLElement | null)?.blur();

  beforeEach(() => {
    mountRenameOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('CTL8H-2-VIEW-ROWS: move walks [#rename-input, #rename-submit] with the focus as the cursor, clamped, a disabled submit is skipped, with no row focused move seats the default row (the input), activate clicks the focused submit once with the trimmed draft, keeps focus on the input, and with no row focused seats the input and submits nothing', async () => {
    // WRONG IMPL KILLED: a move that wraps (the clamp pins the ends); a move from "nothing
    // focused" that goes to the SECOND row (+1 from index -1 is the first row, but the default row
    // is named, and -1 must also land on the input); a disabled submit among the rows (focus() on
    // it is a no-op, the cursor would be stuck); an activate on the input that submits (typing
    // would send the draft on A); an activate on the submit that sends the raw draft or twice; an
    // activate with no focused row that fires the default (an armed reopen must never confirm);
    // a move/activate that ignores which control holds focus (an internal cursor); and an op
    // applied again because it is compared by shape and not by identity.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new RenameView({ onSubmit });
    view.show();
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const submit = document.getElementById('rename-submit') as HTMLButtonElement;
    input.value = '  Bob  ';
    view.render(ENABLED);

    // --- no row focused: the default row, for either direction -----------------------------
    blurAll();
    expect(focusedId(), 'precondition: no row has focus').toBe('');
    walk(view, move(1));
    expect(focusedId(), 'move +1 with nothing focused: the default row').toBe('rename-input');
    blurAll();
    walk(view, move(-1));
    expect(focusedId(), 'move -1 with nothing focused: the default row').toBe('rename-input');

    // --- from the focused row, clamped -------------------------------------------------------
    walk(view, move(1));
    expect(focusedId(), 'down from the input: the save button').toBe('rename-submit');
    walk(view, move(1));
    expect(focusedId(), 'no wrap past the last row').toBe('rename-submit');
    walk(view, move(-1));
    expect(focusedId(), 'up from the save button: the input').toBe('rename-input');
    walk(view, move(-1));
    expect(focusedId(), 'no wrap past the first row').toBe('rename-input');

    // --- a disabled submit is not a row ---------------------------------------------------------
    view.render(DISABLED);
    expect(submit.disabled, 'precondition: an empty draft disables submit').toBe(true);
    input.focus();
    walk(view, move(1));
    expect(focusedId(), 'move skips the disabled save button: the input is the only row').toBe(
      'rename-input',
    );
    expect(document.activeElement, 'and focus is not on the disabled button').not.toBe(submit);
    view.render(ENABLED);

    // --- activate on the save button: one submit with the trimmed draft ------------------------
    submit.focus();
    walk(view, activate());
    expect(onSubmit, 'A on the save button submits once').toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('Bob');
    await flushPromises();

    // --- activate on the input: typing, not submitting ---------------------------------------
    onSubmit.mockClear();
    input.focus();
    walk(view, activate());
    expect(focusedId(), 'A on the field keeps focus in it').toBe('rename-input');
    expect(onSubmit, 'and never submits the draft').not.toHaveBeenCalled();

    // --- activate with no row focused: seat the default, fire nothing ----------------------------
    blurAll();
    walk(view, activate());
    expect(focusedId(), 'A with no row focused seats the default row').toBe('rename-input');
    expect(onSubmit, 'and submits nothing, though the draft is valid').not.toHaveBeenCalled();

    // uif-16b: the identity-memo segment that stood here (the same op object applied once) moved
    // with `applyRowOp` to the frame: ui/profileView.test.ts UIF16B.2 "a token is applied once".
  });

  it('CTL8H-2-B5-SUBMIT-PROPAGATES: a keydown on #rename-submit with a D-pad or Backspace code reaches the window listener, any other key (hotkeys, Enter, Space) is still stopped, and the disabled state of the button is unchanged', () => {
    // WRONG IMPL KILLED: the old unconditional stopPropagation (the router never sees the D-pad
    // or B on the save button: the player is stuck on it, B5); a shield removed altogether (a
    // hotkey letter pressed on the button would open an overlay or walk the character); an allow
    // list that is one code short (WASD or Backspace missing); one that also lets Enter or Space
    // through (the button's own click would double); and a submit made non-disabled to dodge the
    // shield (CTL6B.5's pinned focus-on-page for an empty draft).
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    const btn = document.getElementById('rename-submit') as HTMLButtonElement;
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    try {
      const PROPAGATING = [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'KeyW',
        'KeyA',
        'KeyS',
        'KeyD',
        'Backspace',
      ];
      for (const code of PROPAGATING) {
        spy.mockClear();
        btn.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
        expect(spy, `${code} must bubble to the window router`).toHaveBeenCalledTimes(1);
      }
      const STOPPED = [
        'KeyN',
        'KeyM',
        'KeyB',
        'KeyI',
        'KeyR',
        'KeyQ',
        'KeyP',
        'Slash',
        'Enter',
        'Space',
      ];
      for (const code of STOPPED) {
        spy.mockClear();
        btn.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
        expect(spy, `${code} must stay stopped at the button`).not.toHaveBeenCalled();
      }
    } finally {
      window.removeEventListener('keydown', spy);
    }
    view.render(DISABLED);
    expect(btn.disabled, 'an empty draft still DISABLES the save button').toBe(true);
    view.render(ENABLED);
    expect(btn.disabled, 'a draft still enables it').toBe(false);
  });

  it('CTL8H-RT-RENAME-DISABLED-SAVE-NOT-A-ROW: with an empty draft (Save disabled) and focus on the field, a move and an A neither focus the disabled Save nor leave the field; once the draft enables Save, a move does focus it', () => {
    // WRONG IMPL KILLED: rows that always include the Save button. happy-dom may refuse
    // focus() on a disabled button, which hides the bug from an activeElement check, so the
    // button's own focus() is spied: a disabled Save must never be asked to take focus.
    const view = new RenameView({ onSubmit: vi.fn() });
    view.show();
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const submit = document.getElementById('rename-submit') as HTMLButtonElement;
    view.render(DISABLED);
    expect(submit.disabled, 'precondition: an empty draft disables Save').toBe(true);
    input.focus();
    expect(focusedId(), 'precondition: focus is on the field').toBe('rename-input');

    const submitFocus = vi.spyOn(submit, 'focus');
    try {
      walk(view, move(1));
      expect(
        submitFocus,
        'a move never asks the disabled Save to take focus',
      ).not.toHaveBeenCalled();
      expect(focusedId(), 'and focus stays on the field').toBe('rename-input');
      walk(view, activate());
      expect(submitFocus, 'nor does an A').not.toHaveBeenCalled();
      expect(focusedId(), 'and focus stays on the field').toBe('rename-input');

      // ANTI-VACUITY: the same spy sees the focus once Save is a row.
      view.render(ENABLED);
      expect(submit.disabled, 'precondition: a draft enables Save').toBe(false);
      input.focus();
      walk(view, move(1));
      expect(submitFocus, 'an enabled Save is focused by a move').toHaveBeenCalledTimes(1);
      expect(focusedId()).toBe('rename-submit');
    } finally {
      submitFocus.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// ctl-12b (plan §5): the submit button's routed set comes from the LIVE binding table.
//
// `RenameCallbacks.bindings?: () => Bindings` (absent = DEFAULT_BINDINGS). Per keydown, the focused
// submit button lets through exactly the codes the live table binds to Up, Down, Left, Right and B;
// every other key is stopped as before.
//
// LEGACY BEHAVIOUR REPLACED: the routed set was built once from DEFAULT_BINDINGS, so after a remap
// the player's new Back key was stopped on the Save button (stuck there) while the old Backspace
// still left it.
// ---------------------------------------------------------------------------

describe('RenameView ctl-12b: the submit key shield follows the live table', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });
  afterEach(() => {
    teardown();
  });

  /** The defaults with B := KeyX and Up := KeyT (both free keys), Start := KeyZ. */
  const REMAPPED = {
    buttons: {
      ...DEFAULT_BINDINGS.buttons,
      B: ['KeyX'],
      Up: ['KeyT', 'ArrowUp'],
      Start: ['KeyZ'],
    },
    accels: DEFAULT_BINDINGS.accels,
  } as unknown as Bindings;

  /** Dispatch a keydown of `code` on the submit button; true when it reached the window. */
  function reachesWindow(btn: HTMLButtonElement, code: string): boolean {
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    try {
      btn.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
    } finally {
      window.removeEventListener('keydown', spy);
    }
    return spy.mock.calls.length === 1;
  }

  it('with a remapped table the NEW D-pad and B codes leave the submit button and the OLD ones are stopped, read per keydown from bindings(); with no bindings callback the default codes still leave it', () => {
    // WRONG IMPL KILLED: a routed set still built once from DEFAULT_BINDINGS (after B := KeyX the
    // player's Back key is stopped on Save and they are stuck there, while the retired Backspace
    // still pops); a set read once at construction (a remap made while the rename frame exists
    // would never reach it); a set that also lets Start, A or a shortcut through (KeyZ as Start,
    // Enter and KeyN must stay stopped: a letter on the button would open an overlay); and a view
    // that breaks the default path when no callback is given.
    let table: Bindings = REMAPPED;
    const view = new RenameView({ onSubmit: async () => {}, bindings: () => table });
    view.show();
    const btn = document.getElementById('rename-submit') as HTMLButtonElement;

    for (const code of ['KeyX', 'KeyT', 'ArrowUp', 'KeyS', 'ArrowDown', 'KeyA', 'KeyD']) {
      expect(reachesWindow(btn, code), `${code} (bound to the D-pad or B) leaves the button`).toBe(
        true,
      );
    }
    for (const code of ['Backspace', 'KeyW', 'KeyZ', 'Enter', 'Space', 'KeyN', 'KeyQ', 'Escape']) {
      expect(reachesWindow(btn, code), `${code} is stopped at the button`).toBe(false);
    }

    // The table is read per keydown: switch it back to the defaults on the same view.
    table = DEFAULT_BINDINGS;
    expect(reachesWindow(btn, 'Backspace'), 'B is Backspace again').toBe(true);
    expect(reachesWindow(btn, 'KeyW'), 'Up is KeyW again').toBe(true);
    expect(reachesWindow(btn, 'KeyX'), 'KeyX is no longer B').toBe(false);
    expect(reachesWindow(btn, 'KeyT'), 'KeyT is no longer Up').toBe(false);

    // Regression guard: with no bindings callback the defaults route as they always did.
    teardown();
    mountRenameOverlay();
    const plain = new RenameView({ onSubmit: async () => {} });
    plain.show();
    const plainBtn = document.getElementById('rename-submit') as HTMLButtonElement;
    for (const code of ['Backspace', 'KeyW', 'ArrowLeft', 'KeyD']) {
      expect(reachesWindow(plainBtn, code), `default ${code} leaves the button`).toBe(true);
    }
    for (const code of ['KeyX', 'KeyT', 'KeyN']) {
      expect(reachesWindow(plainBtn, code), `default: ${code} is stopped`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// qf-13 (QF13.1): the Name frame shows a visible title.
//
// EARS: THE Name frame SHALL render a visible frame title. The title is frame chrome (ui/frame.ts
// createFrame's convention): a `div.mr-frame-titlebar` as the overlay's FIRST element child, holding
// a `div.mr-frame-title#rename-title` whose text is t('menu.profile.name.title'), resolved in show()
// on every show (the i18n half is in renameView.i18n.test.ts). #rename-overlay is a static shell in
// client/index.html, so the view builds the bar in its constructor, over whatever shell it finds.
// The title is chrome, not a row: it is not focusable, carries no role, and applyRowOp never
// reaches it.
//
// INTENTIONAL CHANGE (uif-16b, UIF16B.1): the Name frame is now Profile's Name SECTION, so its
// title is a SECTION HEADER: an `h2#rename-title.mr-section-header` as the section root's FIRST
// element child (no `div.mr-frame-titlebar`: one title bar per dialog, ProfileView's), same key,
// same every-show() write. The two tests below are rewritten to that contract; the styles.css
// `.mr-frame-title` block pin stays as it was (the frame title still exists, on #profile-title).
// ---------------------------------------------------------------------------

const QF13_STYLES_CSS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
  'utf8',
);

/** The English catalogue value of the Name frame's title (a plain string entry). */
function qf13EnglishNameTitle(): string {
  const entry = CATALOG_EN['menu.profile.name.title'];
  if (typeof entry !== 'string') throw new Error('menu.profile.name.title must be a plain message');
  return entry;
}

/** A computed style that PAINTS: nothing here makes the element invisible by a route other than
 *  display / visibility (opacity, a zero font size, a transparent colour, taking it out of flow,
 *  a clip, a zero box, an off-screen text indent or a collapsing transform). Called on the bar AND
 *  the title; a property happy-dom does not compute reads '' and passes, so each check is a
 *  denylist of the exact cheat value. */
function qf13ExpectPainted(style: CSSStyleDeclaration, label: string): void {
  expect(['', '1'], `${label}: opacity`).toContain(style.getPropertyValue('opacity'));
  expect(['0', '0px', '0em', '0rem', '0%'], `${label}: font-size`).not.toContain(style.fontSize);
  expect(['transparent', 'rgba(0, 0, 0, 0)'], `${label}: colour`).not.toContain(style.color);
  expect(['absolute', 'fixed'], `${label}: out of flow`).not.toContain(style.position);
  expect(['', 'none'], `${label}: float`).toContain(style.getPropertyValue('float'));
  expect(['', 'none'], `${label}: clip-path`).toContain(style.getPropertyValue('clip-path'));
  expect(['', 'none'], `${label}: transform`).toContain(style.getPropertyValue('transform'));
  expect(style.getPropertyValue('text-indent').startsWith('-'), `${label}: text-indent`).toBe(
    false,
  );
  for (const prop of ['height', 'max-height', 'width', 'max-width', 'line-height']) {
    expect(
      ['0', '0px', '0em', '0rem', '0%'],
      `${label}: ${prop} is not collapsed to zero`,
    ).not.toContain(style.getPropertyValue(prop));
  }
  expect(style.visibility, `${label}: visibility`).not.toBe('hidden');
  expect(style.display, `${label}: display`).not.toBe('none');
}

describe('qf-13 (QF13.1): the Name frame title', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });
  afterEach(() => {
    teardown();
  });

  // uif-1 (named intentional change, UIF1.4): the title block was "font-weight only"; the type
  // scale rewrites it. The new contract is EXACTLY font-size, font-weight and line-height, each
  // pinned to its exact token value, so `.mr-frame-title { font-size: 0 }` (a literal that would
  // hide the chrome) still reds: the old pin killed it by prop roster alone, this kills it by value.
  it('styles.css: the only rules whose selector mentions mr-frame-title are exactly one .mr-frame-titlebar block and one .mr-frame-title block, and the title block declares exactly font-size, font-weight and line-height, each set to its type-scale token', () => {
    // WRONG IMPL KILLED: a class-keyed hide of the chrome added to the sheet (for example
    // `.mr-button-rows > .mr-frame-titlebar { opacity: 0 }` or `.mr-frame-title { font-size: 0 }`
    // appended as a second block, in a @media block, or in a compound selector): the computed
    // probes read one DOM, this reads the whole sheet. Compared by selector EQUALITY, not by
    // substring; comments are stripped first so a decoy in a comment neither hides nor plants one.
    // uif-1 adds: the one title block with a literal (`font-size: 0`, `20px`) or a wrong token.
    const stripped = QF13_STYLES_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks: Array<{
      selectors: string[];
      props: string[];
      decls: Array<[string, string]>;
    }> = [];
    for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const head = (m[1] ?? '').split(';').pop() ?? '';
      const decls: Array<[string, string]> = (m[2] ?? '')
        .split(';')
        .filter((d) => d.includes(':'))
        .map((d): [string, string] => [
          d.slice(0, d.indexOf(':')).trim().toLowerCase(),
          d
            .slice(d.indexOf(':') + 1)
            .trim()
            .replace(/\s+/g, ' '),
        ])
        .filter(([p]) => p !== '');
      blocks.push({
        selectors: head.split(',').map((s) => s.trim()),
        props: decls.map(([p]) => p),
        decls,
      });
    }
    expect(
      blocks.some((b) => b.selectors.includes('.sr-only')),
      'ANTI-VACUITY: the scan sees the existing .sr-only rule',
    ).toBe(true);
    const mentioning = blocks.filter((b) => b.selectors.some((s) => s.includes('mr-frame-title')));
    expect(
      mentioning.map((b) => b.selectors.join(', ')).sort(),
      'every selector list that names the chrome, with multiplicity',
    ).toEqual(['.mr-frame-title', '.mr-frame-titlebar']);
    const title = mentioning.find((b) => b.selectors.join(', ') === '.mr-frame-title');
    expect(
      title?.props,
      'ANTI-VACUITY: the title block was found and declares something',
    ).not.toEqual([]);
    expect(
      [...(title?.decls ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      'the title rule declares exactly font-size, font-weight and line-height, each its token',
    ).toEqual([
      ['font-size', 'var(--mr-font-title)'],
      ['font-weight', 'var(--mr-font-title-weight)'],
      ['line-height', 'var(--mr-font-title-line)'],
    ]);
  });

  it('UIF16B.1 after show() the section leads with exactly one h2.mr-section-header#rename-title as its FIRST element child, reading the catalogue Name title, on screen all the way up, not focusable, no role, not duplicated by a second view, not a row, no frame title bar anywhere, and rewritten by every show()', () => {
    // INTENTIONAL CHANGE (uif-16b): was [QF13-1-NAME-TITLE], "a div.mr-frame-titlebar holding
    // exactly one div.mr-frame-title#rename-title". The section header replaces the frame chrome.
    // WRONG IMPL KILLED: the old title bar kept (a frame title bar per section: three title bars in
    // one dialog); a header appended AFTER the form controls; a div or a frame-title class instead
    // of h2.mr-section-header; a wrong id; hard-coded English instead of the catalogue value; a
    // header created display:none or under a hidden ancestor; a tabindex or role on it; a
    // constructor that prepends a fresh header each time (two views over one DOM); a header in the
    // rows (the cursor would land on it); and a header written once in the constructor.
    const overlay = document.getElementById('rename-overlay') as HTMLElement;
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();

    expect(overlay.querySelector('.mr-frame-titlebar'), 'no frame title bar in the section').toBe(
      null,
    );
    expect(overlay.querySelector('.mr-frame-title'), 'no frame title in the section').toBe(null);
    const titles = overlay.querySelectorAll('#rename-title');
    expect(titles.length, 'exactly one #rename-title in the section').toBe(1);
    expect(document.querySelectorAll('[id="rename-title"]').length, 'and in the document').toBe(1);
    const title = titles[0] as HTMLElement;
    const bar = title;
    expect(overlay.firstElementChild, 'the header leads the section').toBe(title);
    expect(title.tagName, 'the header is an h2').toBe('H2');
    expect([...title.classList], 'the header carries exactly the section-header class').toEqual([
      'mr-section-header',
    ]);
    const expected = qf13EnglishNameTitle();
    expect(expected.length, 'ANTI-VACUITY: the catalogue has a Name title to show').toBeGreaterThan(
      0,
    );
    expect(title.textContent, 'the title text is the catalogue value').toBe(expected);

    // On screen: nothing on the chain from the title to the overlay is hidden.
    for (let node: HTMLElement | null = title; node !== null; node = node.parentElement) {
      const label = node === title ? '#rename-title' : node.id || node.tagName;
      expect(node.style.display, `${label}: not display:none`).not.toBe('none');
      expect(node.hidden, `${label}: not [hidden]`).toBe(false);
      expect(node.hasAttribute('hidden'), `${label}: no hidden attribute`).toBe(false);
      if (node === overlay) break;
    }
    expect(view.visible, 'ANTI-VACUITY: the overlay is shown').toBe(true);

    // Chrome, not a control.
    expect(title.hasAttribute('tabindex'), 'the title is not focusable').toBe(false);
    expect(title.hasAttribute('role'), 'the title carries no role').toBe(false);
    expect(bar?.hasAttribute('tabindex'), 'the titlebar is not focusable').toBe(false);
    // Visible to assistive tech too: neither node is aria-hidden or inert.
    for (const [label, node] of [
      ['titlebar', bar],
      ['title', title],
    ] as const) {
      expect(node?.getAttribute('aria-hidden'), `${label}: no aria-hidden`).toBeNull();
      expect(node?.hasAttribute('inert'), `${label}: not inert`).toBe(false);
    }

    // A second view over the same DOM neither duplicates nor replaces the header.
    const second = new RenameView({ onSubmit: async () => {} });
    second.show();
    expect(overlay.querySelectorAll('.mr-section-header').length, 'still one header').toBe(1);
    expect(overlay.firstElementChild, 'the same header still leads the section').toBe(bar);
    expect(document.getElementById('rename-title'), 'and the same title node').toBe(title);

    // The rows are still exactly [input, submit]: the title is not a row.
    expect(view.sectionRows().includes(title), 'the header is not a row').toBe(false);
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const submit = document.getElementById('rename-submit') as HTMLButtonElement;
    const focusedId = (): string => (document.activeElement as HTMLElement | null)?.id ?? '';
    view.render({ displayCurrentName: 'X', trimmedDraft: 'Bob', canSubmit: true });
    input.value = 'Bob';
    input.focus();
    walk(view, { kind: 'move', delta: -1 });
    expect(focusedId(), 'up from the field clamps on the field, never the title').toBe(
      'rename-input',
    );
    walk(view, { kind: 'move', delta: 1 });
    expect(focusedId(), 'down from the field: Save').toBe('rename-submit');
    walk(view, { kind: 'move', delta: 1 });
    expect(focusedId(), 'down from Save clamps on Save').toBe('rename-submit');
    walk(view, { kind: 'move', delta: -1 });
    expect(focusedId(), 'up from Save: the field').toBe('rename-input');
    (document.activeElement as HTMLElement | null)?.blur();
    walk(view, { kind: 'move', delta: 1 });
    expect(focusedId(), 'with nothing focused a move seats the default row, the field').toBe(
      'rename-input',
    );
    expect(document.activeElement, 'and never the title').not.toBe(title);
    expect(submit.disabled, 'ANTI-VACUITY: Save was a row').toBe(false);

    // Every show() writes the label: a stale text is repaired, and hide() then show() still paints.
    title.textContent = 'stale';
    view.show();
    expect(title.textContent, 'a repeat show() on an open overlay rewrites the title').toBe(
      expected,
    );
    view.hide();
    expect(overlay.firstElementChild, 'hide() keeps the header in place').toBe(bar);
    view.show();
    expect(title.textContent, 'hide() then show(): the title reads the catalogue value').toBe(
      expected,
    );
    expect(overlay.style.display, 'and the overlay is shown again').not.toBe('none');
  });

  describe('with the real styles.css', () => {
    let sheet: HTMLStyleElement | null = null;
    beforeEach(() => {
      sheet = document.createElement('style');
      sheet.textContent = QF13_STYLES_CSS;
      document.head.appendChild(sheet);
    });
    afterEach(() => {
      sheet?.remove();
      sheet = null;
    });

    it('UIF16B.1 the shown section header paints from the stylesheet and not from inline style, and the section computes no frame box of its own', () => {
      // INTENTIONAL CHANGE (uif-16b): was [QF13-1-NAME-TITLE-COMPUTED] (the titlebar a flex row
      // with a bottom border, the title bold). The header is the type scale's section level; the
      // section is a plain block in the frame's column (no `.mr-frame` border, no `.mr-shell`
      // absolute box inside the dialog's own box).
      // WRONG IMPL KILLED: a header hidden by the sheet; an inline style standing in for the class;
      // a section still classed `mr-frame` / `mr-shell` (it computes a bordered, absolutely placed
      // box inside the frame). happy-dom caches computed style per element: each is read once.
      const overlay = document.getElementById('rename-overlay') as HTMLElement;
      const view = new RenameView({ onSubmit: async () => {} });
      view.show();
      const title = document.getElementById('rename-title') as HTMLElement | null;
      expect(title, 'the header exists').not.toBeNull();
      if (title === null) return;
      expect(title.style.cssText, 'the header carries no inline style').toBe('');
      const titleStyle = getComputedStyle(title);
      expect(titleStyle.display, 'the header is displayed').not.toBe('none');
      expect(titleStyle.visibility, 'the header is visible').not.toBe('hidden');
      qf13ExpectPainted(titleStyle, 'header');
      const sectionStyle = getComputedStyle(overlay);
      expect(sectionStyle.position, 'the section is not an absolute shell').not.toBe('absolute');
      expect(sectionStyle.flexDirection, 'the section is not a frame flex column').not.toBe(
        'column',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// uif-16a (UIF16A.1, UIF16A.2): the rename view as a RowSection, walked through the interface.
// ---------------------------------------------------------------------------

describe('RenameView uif-16a: the shared section interface', () => {
  const ENABLED16: RenameViewModel = {
    displayCurrentName: 'X',
    trimmedDraft: 'Bob',
    canSubmit: true,
  };
  const EMPTY16: RenameViewModel = { displayCurrentName: 'X', trimmedDraft: '', canSubmit: false };
  const move16 = (delta: -1 | 1): RowOp => ({ kind: 'move', delta });
  const activate16 = (): RowOp => ({ kind: 'activate' });
  const focusedId16 = (): string => (document.activeElement as HTMLElement | null)?.id ?? '';
  const blur16 = (): void => (document.activeElement as HTMLElement | null)?.blur();
  const ids16 = (els: readonly HTMLElement[]): string[] => els.map((e) => e.id);
  const override16 = (view: RenameView, patch: Partial<RowSection>): void => {
    Object.assign(view as unknown as object, patch);
  };

  beforeEach(() => {
    mountRenameOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('UIF16A.1 sectionRoot is the identical #rename-overlay element and the view is assignable to RowSection', () => {
    const view = new RenameView({ onSubmit: async () => {} });
    const section: RowSection = view;
    expect(section.sectionRoot).toBe(document.getElementById('rename-overlay'));
  });

  it('UIF16A.1 sectionRows is [input] for an empty draft and [input, submit] once the draft is submittable, in DOM order', () => {
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    view.render(EMPTY16);
    expect(ids16(view.sectionRows())).toEqual(['rename-input']);
    view.render(ENABLED16);
    expect(ids16(view.sectionRows())).toEqual(['rename-input', 'rename-submit']);
    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ids16(view.sectionRows()), 'typing blanks the draft: Save leaves the rows').toEqual([
      'rename-input',
    ]);
  });

  it('UIF16A.1 defaultRow is the field whether or not Save is a row', () => {
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    view.render(EMPTY16);
    expect(view.defaultRow()).toBe(document.getElementById('rename-input'));
    view.render(ENABLED16);
    expect(view.defaultRow()).toBe(document.getElementById('rename-input'));
  });

  // uif-16b (named change): the four UIF16A.2 tests below drove `view.applyRowOp`, which retires;
  // they now drive the `walk` helper (walkSection over this RowSection, the frame's rule), so they
  // still pin that the walk reads THIS section's interface. The frame-level walk is gated in
  // ui/profileView.test.ts UIF16B.2.
  it('UIF16A.2 the section walk seats defaultRow() when no row is focused: an overridden default wins over the field', () => {
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    view.render(ENABLED16);
    const submit = document.getElementById('rename-submit') as HTMLElement;
    override16(view, { defaultRow: () => submit });
    blur16();
    walk(view, move16(1));
    expect(focusedId16(), 'the override, not a private #input fallback').toBe('rename-submit');
  });

  it('UIF16A.2 the section walk follows the rows sectionRows() returns: an overridden list is clamped against and decides what A presses', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new RenameView({ onSubmit });
    view.show();
    view.render(ENABLED16);
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const submit = document.getElementById('rename-submit') as HTMLElement;
    input.value = 'Bob';

    // The real rows are [input, submit]; the override is the input alone.
    override16(view, { sectionRows: () => [input] });
    submit.focus();
    walk(view, move16(1));
    expect(focusedId16(), 'submit is not an overridden row: the default (field) is seated').toBe(
      'rename-input',
    );
    submit.focus();
    walk(view, activate16());
    await flushPromises();
    expect(
      onSubmit,
      'A on a control the interface does not list presses nothing',
    ).not.toHaveBeenCalled();

    // A reordered override: the clamp follows the overridden order.
    override16(view, { sectionRows: () => [submit, input] });
    submit.focus();
    walk(view, move16(1));
    expect(focusedId16(), 'down from the first overridden row is the field').toBe('rename-input');
    walk(view, move16(1));
    expect(focusedId16(), 'clamped at the last overridden row, no wrap').toBe('rename-input');
  });

  it('UIF16A.2 A on the field never clicks the field: not with an empty draft, not with a submittable one', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new RenameView({ onSubmit });
    view.show();
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    try {
      view.render(EMPTY16);
      input.focus();
      expect(focusedId16(), 'precondition: focus is on the field').toBe('rename-input');
      walk(view, activate16());
      expect(clickSpy, 'empty draft: the field is never clicked').not.toHaveBeenCalled();
      expect(focusedId16(), 'empty draft: focus stays on the field').toBe('rename-input');
      expect(onSubmit, 'empty draft: nothing submitted').not.toHaveBeenCalled();

      input.value = 'Bob';
      view.render(ENABLED16);
      input.focus();
      walk(view, activate16());
      await flushPromises();
      expect(clickSpy, 'submittable draft: the field is never clicked').not.toHaveBeenCalled();
      expect(focusedId16(), 'submittable draft: focus stays on the field').toBe('rename-input');
      expect(onSubmit, 'submittable draft: nothing submitted').not.toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('UIF16A.2 through the real interface: A on the field presses nothing, A on Save submits the trimmed draft once, and a blank draft on an enabled Save submits nothing', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new RenameView({ onSubmit });
    view.show();
    const input = document.getElementById('rename-input') as HTMLInputElement;
    const submit = document.getElementById('rename-submit') as HTMLElement;
    input.value = '  Bob  ';
    view.render(ENABLED16);

    input.focus();
    walk(view, activate16());
    expect(focusedId16(), 'A on the field keeps focus on it').toBe('rename-input');
    expect(onSubmit, 'and presses nothing').not.toHaveBeenCalled();

    submit.focus();
    walk(view, activate16());
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('Bob');

    onSubmit.mockClear();
    input.value = '   ';
    view.render(ENABLED16); // Save stays an enabled row, so the press reaches #submit's own gate
    submit.focus();
    walk(view, activate16());
    await flushPromises();
    expect(onSubmit, 'an empty-after-trim draft never submits').not.toHaveBeenCalled();
  });

  it('UIF16B.4 the Name section is never armed, whatever its draft or pending state', () => {
    // WRONG IMPL KILLED: a missing `armed` (undefined reads as falsy in a frame `some`, but a
    // truthy placeholder would make ProfileView.defaultRow() treat the field as an armed No); an
    // `armed` that follows the in-flight submit lock.
    const view = new RenameView({ onSubmit: () => new Promise<void>(() => {}) });
    view.show();
    expect(view.armed, 'fresh').toBe(false);
    view.render(ENABLED16);
    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = 'Bob';
    (document.getElementById('rename-submit') as HTMLButtonElement).click();
    expect(view.armed, 'with a submit in flight').toBe(false);
    view.render(EMPTY16);
    expect(view.armed, 'empty draft').toBe(false);
  });

  it('UIF16B.2 the section no longer walks itself: it has no applyRowOp (the frame applies the token once, over the whole column)', () => {
    // WRONG IMPL KILLED: a section that keeps its own `applyRowOp` + `#lastOp` (two identity memos
    // over one token: the frame and a section could each apply it, or a section-scoped walk could
    // still be wired and clamp at the section's edge).
    const view = new RenameView({ onSubmit: async () => {} });
    expect('applyRowOp' in view, 'no section-level applyRowOp').toBe(false);
  });
});
