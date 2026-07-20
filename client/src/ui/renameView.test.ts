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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenameView } from './renameView';

// ---------------------------------------------------------------------------
// DOM mount helper — installs the index.html shell for renameView (ADR-0133 D2).
// Each test gets a fresh DOM via beforeEach to prevent cross-test contamination.
// ---------------------------------------------------------------------------

function mountRenameOverlay(): {
  overlay: HTMLElement;
  currentEl: HTMLElement;
  input: HTMLInputElement;
  submitBtn: HTMLButtonElement;
  feedbackEl: HTMLElement;
} {
  const existing = document.getElementById('rename-overlay');
  if (existing) existing.remove();

  // Matches the exact shell specified in docs/specs/pt-c1b-plan.md §index.html shell
  document.body.innerHTML = `
    <div id="rename-overlay" style="display:none">
      <div id="rename-current" data-testid="rename-current"></div>
      <input id="rename-input" data-testid="rename-input" type="text" maxlength="24" />
      <button id="rename-submit" data-testid="rename-submit">Rename</button>
      <div id="rename-feedback" data-testid="rename-feedback"></div>
    </div>
  `;

  const overlay = document.getElementById('rename-overlay') as HTMLElement;
  const currentEl = document.getElementById('rename-current') as HTMLElement;
  const input = document.getElementById('rename-input') as HTMLInputElement;
  const submitBtn = document.getElementById('rename-submit') as HTMLButtonElement;
  const feedbackEl = document.getElementById('rename-feedback') as HTMLElement;
  return { overlay, currentEl, input, submitBtn, feedbackEl };
}

function teardown(): void {
  document.body.innerHTML = '';
}

// Minimal ViewModel shape that RenameView.render() accepts.
// Mirrors buildRenameViewModel's return type (ADR-0133 D2).
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
    // PTC1B-5: WHILE the input is focused, typing a hotkey letter (KeyL) does NOT toggle
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
    // PTC1B-5: typing a movement key (KeyW = forward) inside the input must NOT move the
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
// Enter key: calls onSubmit with trimmed value (PTC1B-2)
// Escape key: hides overlay, does NOT call onSubmit (PTC1B-6)
// ---------------------------------------------------------------------------

describe('RenameView keyboard: Enter submits; Escape hides without submitting (PTC1B-2/6)', () => {
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

  it('BITES: Escape on input hides the overlay AND does NOT call onSubmit (PTC1B-6)', async () => {
    // WRONG IMPL KILLED: an impl where Escape calls onSubmit (cancels but submits),
    // or where Escape does not hide the overlay.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new RenameView({ onSubmit });
    view.show();
    expect(view.visible).toBe(true);

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = 'SomeName';

    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    await flushPromises();

    expect(view.visible).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PTC1B-7: empty/whitespace submit-click → onSubmit NOT called
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
//   button via .finally() (ADR-0133 D2, shopView #pending pattern precedent).
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

  it('BITES: hide() clears #rename-feedback textContent — kills impl that leaves stale feedback on re-open', () => {
    // RT-RN-02: feedback from a prior rename attempt (success/error) must not linger.
    // WRONG IMPL KILLED: an impl where hide() does not touch the feedback element.
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();

    const feedbackEl = document.getElementById('rename-feedback') as HTMLElement;
    feedbackEl.textContent = 'Rename failed: invalid name';

    view.hide();

    expect(feedbackEl.textContent).toBe('');
  });
});

// ---------------------------------------------------------------------------
// showFeedback(): writes feedback text via textContent
// ---------------------------------------------------------------------------

describe('RenameView showFeedback(): writes textContent to #rename-feedback', () => {
  beforeEach(() => {
    mountRenameOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('BITES: showFeedback("Name updated") sets #rename-feedback textContent — kills no-op impl', () => {
    // Proves the method exists and writes to the feedback element.
    // WRONG IMPL KILLED: an impl where showFeedback() is a no-op or writes to wrong element.
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    view.showFeedback('Name updated');
    const feedbackEl = document.getElementById('rename-feedback') as HTMLElement;
    expect(feedbackEl.textContent).toBe('Name updated');
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
// the e2e-caught button-never-enables bug). All strengthening; no prior test touched.
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
    // a link drop (ADR-0085), so .finally() may never run → #pending stuck true forever.
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
    // Tab-focus or a mouse click leaves the button focused; a KeyW keydown then bubbles
    // to the window keydown handler. The button's own keydown listener must stopPropagation.
    const view = new RenameView({ onSubmit: async () => {} });
    view.show();
    const btn = document.getElementById('rename-submit') as HTMLButtonElement;
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    btn.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    expect(
      spy,
      'a keydown on the focused submit button must not bubble to window',
    ).not.toHaveBeenCalled();
    window.removeEventListener('keydown', spy);
  });
});
