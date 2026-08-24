// @vitest-environment happy-dom
// ui/helpView.test.ts — RED gating tests for the pt-c2b help overlay DOM shell
// (PTC2B-1/2/3/10 + the XSS firewall + rebuild-authoritative invariants).
//
// Slice: pt-c2b · SSOT spec: docs/specs/pt-c2b-plan.md + docs/adr/0135-pt-c2b-help-overlay.md
//
// RED REASON: helpView.ts does not exist yet.
// Every test below fails with "Failed to resolve import './helpView'" (module-not-found)
// until the implementer ships client/src/ui/helpView.ts exporting class HelpView.
//
// CONTRACT (the specialist matches this EXACTLY):
//   class HelpView {
//     constructor();                 // zero-arg; THROWS loud if #help-overlay is missing
//     get visible(): boolean;        // style.display !== 'none'
//     show(): void;                  // display flips visible
//     hide(): void;                  // display flips hidden
//     toggle(): void;                // flip visibility
//     render(vm: HelpViewModel): void; // paints textContent-only <li>s, rebuild-authoritative
//   }
//
// index.html DOM shell the implementer will add (fixtured here):
//   <div id="help-overlay" style="display:none">
//     <ul id="help-controls"></ul>
//     <ul id="help-goals"></ul>
//   </div>
//   (an optional #help-title may exist; this suite does NOT require it.)
//   visible === (overlay.style.display !== 'none').
//
// WRONG-IMPL-KILLED list (one per criterion):
//   - "ctor silently accepts missing overlay"      → throw-on-missing-overlay test catches it
//   - "show()/hide()/toggle() are no-ops"          → visibility flip tests catch it
//   - "render ignores controls/goals"              → per-<li> paint tests catch it
//   - "render uses innerHTML (XSS)"                → XSS tooth (literal textContent + no <script>) catches it
//   - "render appends without clearing (stale <li>s)" → rebuild-authoritative count test catches it
//
// Do NOT edit tests to match a buggy impl — correct from the spec only; a correction must
// strengthen or preserve the bite (log a one-line spec rationale).
//
// ---------------------------------------------------------------------------
// m23-s3 ADDITION (2026-08-24) — overlay a11y wiring. ADDITIVE ONLY: nothing above was weakened
// or deleted; the mount helper gained the `role`/`aria-modal`/`tabindex` attributes
// client/index.html:88-94 has always shipped, and a file-level a11y sweep was added.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/16);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1/F2/F7, §1 D1/D2/D7/D8, §4, §7 A1/A3/A6/A7/A8;
//   memory/projects/gates/m23-s3.gates.md X1/X2/X3/X6/X8; ADR-0205 D1-D4, A3.
//
// RED REASON (m23-s3): `client/src/ui/helpView.ts` DOES NOT CALL openOverlayA11y/closeOverlayA11y
// at all today — show() is a single `style.display = ''` (ui/helpView.ts:40-42). Every S3-* test
// below therefore fails now; every PTC2B test above still passes. NOTE this view is NOT
// coverage-excluded (vite.config.ts), so the two new branches must be executed by tests —
// S3-helpView-HELPER-CALLED runs both.
//
// TWO ORACLES, BOTH REQUIRED (plan A3, measured by red-team):
//   * VALUE oracle  — `aria-label === t(OVERLAY_A11Y['helpView'].labelKey)`. `role`/`aria-modal`
//     are ALREADY static literals on the shell in client/index.html:90-91 (m23-s2), so asserting
//     them ALONE is VACUOUS: a view that calls nothing passes. They are asserted only alongside
//     aria-label, and their ABSENCE after close is the anti-vacuity partner (attack V1).
//   * MECHANISM oracle — `vi.mock('./overlayA11y', { spy: true })` records the calls AND calls
//     through to the real implementation, so a cheat that hand-writes the three attributes with the
//     correct copied literal (no trap, no return-focus record, no timer) still reds.
//
// TEST-ISOLATION DEVICE (plan A8 / V7, copied from ui/overlayA11y.test.ts:97-105): overlayA11y.ts
// holds ONE module-private Map and exports no reset hook, so the file-level beforeEach/afterEach
// call the PRODUCTION closeOverlayA11y(id, null) for every OverlayId and flush ONE REAL MACROTASK
// — legal because close-without-open is a documented no-op (ui/overlayA11y.ts:41-45). It also
// cancels the deferred-focus timer every pre-existing `view.show()` above will schedule once the
// wiring lands (plan residual A12). `vi.clearAllMocks()` runs LAST so the sweep never pollutes a
// count.
//
// m23-s3 WRONG-IMPL-KILLED index:
//   - never opens / attribute-only cheat                 -> S3-helpView-OPEN-ARIA + -HELPER-CALLED
//   - copy-pasted WRONG OverlayId                        -> S3-helpView-OPEN-ARIA (label) + -HELPER-CALLED (id arg)
//   - synchronous focus (no defer)                       -> S3-helpView-DEFER-FOCUS (negative polarity)
//   - focuses nothing / a wrapper, not the anchor         -> S3-helpView-DEFER-FOCUS (identity)
//   - close never strips ARIA / never restores focus      -> S3-helpView-CLOSE-RESTORE
//   - UNGUARDED show() / `this.visible` read AFTER the write -> S3-helpView-REPEAT-NO-REOPEN
//   - `fallbackFocus` passed as undefined/an element       -> S3-helpView-HELPER-CALLED (literal null)
//   - GUARDED close in hide() (plan anti-pattern #3 — kills S1's A13 self-heal)
//                                                        -> S3-helpView-CLOSE-UNGUARDED

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { HelpView } from './helpView';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';

// The m23-s3 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works.
vi.mock('./overlayA11y', { spy: true });

/** m23-s3: one REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0),
 *  and fake timers are banned for this defer (plan anti-pattern #10). */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// m23-s3: NEW file-level isolation hooks. They run BEFORE the describe-level `mountHelpOverlay`
// hooks below, so every test still gets the DOM it always got.
beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
});

// Minimal ViewModel shape that HelpView.render() accepts. Mirrors helpModel's
// buildHelpViewModel() return type (readonly is dropped here for test-fixture ease).
interface HelpViewModel {
  controls: { key: string; action: string }[];
  goals: string[];
}

// ---------------------------------------------------------------------------
// DOM mount helper — installs the index.html shell for helpView (ADR-0135).
// Each test gets a fresh DOM via beforeEach to prevent cross-test contamination.
// Mirrors renameView.test.ts's mountRenameOverlay() precedent.
// ---------------------------------------------------------------------------

function mountHelpOverlay(): {
  overlay: HTMLElement;
  controlsEl: HTMLElement;
  goalsEl: HTMLElement;
} {
  const existing = document.getElementById('help-overlay');
  if (existing) existing.remove();

  // m23-s3 FIXTURE FIDELITY (index.html:88-94): `role`/`aria-modal` have shipped as STATIC
  // LITERALS on this shell since m23-s2, and #help-title carries the tabindex="-1" anchor. They
  // are copied here NOT to be asserted on their own — that is vacuous, a view calling nothing
  // passes — but so that "all three attributes ABSENT after close" is a real tooth: only
  // closeOverlayA11y can remove them (ui/overlayA11y.ts:142-144). The tabindex buys ZERO test
  // power (plan A7: happy-dom focuses a bare <div> with no tabindex at all).
  document.body.innerHTML = `
    <div id="help-overlay" role="dialog" aria-modal="true" style="display:none">
      <div id="help-title" tabindex="-1">Help</div>
      <ul id="help-controls"></ul>
      <ul id="help-goals"></ul>
    </div>
  `;

  const overlay = document.getElementById('help-overlay') as HTMLElement;
  const controlsEl = document.getElementById('help-controls') as HTMLElement;
  const goalsEl = document.getElementById('help-goals') as HTMLElement;
  return { overlay, controlsEl, goalsEl };
}

function teardown(): void {
  document.body.innerHTML = '';
}

// A representative VM for render() tests.
const SAMPLE_VM: HelpViewModel = {
  controls: [
    { key: '?', action: 'Toggle this help' },
    { key: 'WASD / Arrows', action: 'Move' },
    { key: 'Escape', action: 'Close overlay' },
    { key: 'F9', action: 'Download bug bundle' },
  ],
  goals: ['Recruit a monster', 'Win a battle', 'Trade with another tester'],
};

// ---------------------------------------------------------------------------
// Constructor: throws loud when the required overlay root is missing.
// ---------------------------------------------------------------------------

describe('HelpView constructor: throws when #help-overlay is missing (fail-loud contract)', () => {
  afterEach(() => {
    teardown();
  });

  it('BITES: ctor throws when #help-overlay is absent — kills no-guard impl', () => {
    // WRONG IMPL KILLED: an impl that silently stores null from getElementById without
    // guarding — every show/hide/render would then silently do nothing.
    // DOM is empty (teardown ran); no overlay exists.
    expect(() => new HelpView()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Visibility: visible / show / hide / toggle (PTC2B-1 open, PTC2B-2 toggle-close).
// ---------------------------------------------------------------------------

describe('HelpView visibility: show / hide / toggle / visible (PTC2B-1/2)', () => {
  beforeEach(() => {
    mountHelpOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('BITES: visible is false initially (display:none in index.html) — kills visible-at-construction impl', () => {
    // WRONG IMPL KILLED: an impl that calls show() in the constructor or always returns true.
    const view = new HelpView();
    expect(view.visible).toBe(false);
  });

  it('BITES: show() makes visible=true AND display !== "none" — kills no-op show impl (PTC2B-1)', () => {
    // WRONG IMPL KILLED: an impl where show() does nothing.
    const view = new HelpView();
    view.show();
    expect(view.visible).toBe(true);
    const overlay = document.getElementById('help-overlay') as HTMLElement;
    expect(overlay.style.display).not.toBe('none');
  });

  it('BITES: hide() makes visible=false AND display === "none" — kills no-op hide impl (PTC2B-3)', () => {
    // WRONG IMPL KILLED: an impl where hide() does nothing.
    const view = new HelpView();
    view.show();
    view.hide();
    expect(view.visible).toBe(false);
    const overlay = document.getElementById('help-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('none');
  });

  it('BITES: toggle() from hidden shows; toggle() again hides — kills toggle=always-show impl (PTC2B-2)', () => {
    // PTC2B-2: pressing `?` while help is open closes it. The view's toggle() must flip both ways.
    // WRONG IMPL KILLED: a toggle() that only ever shows (never hides) — the overlay would be
    // un-closeable via the `?` key.
    const view = new HelpView();
    expect(view.visible).toBe(false);
    view.toggle();
    expect(view.visible).toBe(true);
    view.toggle();
    expect(view.visible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// render(): paints one <li> per control + one <li> per goal, textContent-only.
// ---------------------------------------------------------------------------

describe('HelpView render(): paints controls + goals as textContent <li>s (PTC2B-10)', () => {
  beforeEach(() => {
    mountHelpOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('BITES: render() paints exactly one <li> per control into #help-controls — kills no-render / wrong-count impl', () => {
    // WRONG IMPL KILLED: an impl that ignores controls, paints them into the wrong element,
    // or paints a different count.
    const view = new HelpView();
    view.render(SAMPLE_VM);
    const controlsEl = document.getElementById('help-controls') as HTMLElement;
    const lis = controlsEl.querySelectorAll('li');
    expect(lis.length).toBe(SAMPLE_VM.controls.length);
  });

  it('BITES: render() paints exactly one <li> per goal into #help-goals — kills no-render / wrong-count impl', () => {
    const view = new HelpView();
    view.render(SAMPLE_VM);
    const goalsEl = document.getElementById('help-goals') as HTMLElement;
    const lis = goalsEl.querySelectorAll('li');
    expect(lis.length).toBe(SAMPLE_VM.goals.length);
  });

  it('BITES: each control <li> textContent contains BOTH the key and the action — kills half-painted impl', () => {
    // WRONG IMPL KILLED: an impl that renders only the key (or only the action) — the tester
    // would see a key with no meaning, or a meaning with no key.
    const view = new HelpView();
    view.render(SAMPLE_VM);
    const controlsEl = document.getElementById('help-controls') as HTMLElement;
    const lis = Array.from(controlsEl.querySelectorAll('li'));
    for (let i = 0; i < SAMPLE_VM.controls.length; i++) {
      const text = lis[i].textContent ?? '';
      expect(text.includes(SAMPLE_VM.controls[i].key)).toBe(true);
      expect(text.includes(SAMPLE_VM.controls[i].action)).toBe(true);
    }
  });

  it('BITES: each goal <li> textContent equals the goal string — kills no-goal-text impl', () => {
    const view = new HelpView();
    view.render(SAMPLE_VM);
    const goalsEl = document.getElementById('help-goals') as HTMLElement;
    const lis = Array.from(goalsEl.querySelectorAll('li'));
    for (let i = 0; i < SAMPLE_VM.goals.length; i++) {
      expect((lis[i].textContent ?? '').includes(SAMPLE_VM.goals[i])).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ★★ XSS firewall (PTC2B-10 / ADR-0135): a <script>-looking VM string must render
//    as LITERAL textContent — never parsed into a DOM node. Bites an innerHTML impl.
// ---------------------------------------------------------------------------

describe('★★ HelpView render(): XSS firewall — textContent only, never innerHTML injection (PTC2B-10)', () => {
  beforeEach(() => {
    mountHelpOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('★★ BITES: a control action containing "<script>" renders as LITERAL text; no <script> node is created — kills innerHTML impl', () => {
    // WRONG IMPL KILLED: an impl that does `li.innerHTML = entry.action` (or template-string
    // interpolation into innerHTML). Although the help content is a static const today, the
    // ADR-0135 XSS-firewall discipline (textContent only) must be structurally enforced so a
    // future edit that sources content from anywhere untrusted cannot introduce an injection.
    //
    // PROOF-OF-TEETH: an innerHTML impl PARSES the <script> string into a real <script>
    // element (querySelector('script') !== null) and the literal text is NOT present verbatim.
    // A textContent impl escapes the angle brackets → the literal string appears and NO script
    // node exists.
    const XSS = '<script>alert(1)</script>';
    const vm: HelpViewModel = {
      controls: [{ key: 'X', action: XSS }],
      goals: ['<img src=x onerror=alert(2)>'],
    };
    const view = new HelpView();
    view.render(vm);

    const overlay = document.getElementById('help-overlay') as HTMLElement;
    // 1) No <script> element anywhere in the overlay subtree (an innerHTML impl would create one).
    // False positive: this is the ASSERTION that render() never creates a <script> node (the XSS
    // firewall's proof-of-teeth), not a sink. `overlay` is a jsdom element, never externally controlled.
    expect(
      // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
      overlay.querySelector('script'),
      'render() must not inject a <script> element — use textContent, never innerHTML',
    ).toBeNull();
    // 2) The literal XSS string appears verbatim as text (textContent escapes the angle brackets).
    const controlsEl = document.getElementById('help-controls') as HTMLElement;
    const li = controlsEl.querySelector('li') as HTMLElement;
    // False positive: this asserts the <script> payload survives as LITERAL text (proof textContent
    // escaped it), not a sink. `li` is a jsdom element; `.includes()` is a string read, not HTML injection.
    expect(
      // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
      li.textContent?.includes(XSS),
      'the <script> string must appear as LITERAL textContent, not be parsed',
    ).toBe(true);
    // 3) The goal <img onerror> payload also renders as literal text (no <img> node injected).
    const goalsEl = document.getElementById('help-goals') as HTMLElement;
    expect(
      goalsEl.querySelector('img'),
      'render() must not inject an <img> element from a goal string',
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ★ Rebuild-authoritative (PTC2B-10): render() twice with different VMs — no stale
//   <li> from the first render survives; the count matches the SECOND VM exactly.
// ---------------------------------------------------------------------------

describe('★ HelpView render(): rebuild-authoritative — a second render replaces, never appends (PTC2B-10)', () => {
  beforeEach(() => {
    mountHelpOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('★ BITES: rendering a smaller VM after a larger one clears the stale <li>s — kills append-not-replace impl', () => {
    // WRONG IMPL KILLED: an impl that does controlsEl.appendChild(li) without first clearing
    // (no replaceChildren / no textContent reset). After a second render with FEWER entries the
    // stale first-render <li>s survive → the count would be first+second, not second.
    // PROOF-OF-TEETH: first render has 4 controls / 3 goals; the second has 1 / 1. A correct
    // rebuild leaves exactly 1 control <li> and 1 goal <li>; an append impl leaves 5 and 4.
    const view = new HelpView();
    view.render(SAMPLE_VM); // 4 controls, 3 goals

    const smaller: HelpViewModel = {
      controls: [{ key: 'Z', action: 'Only entry' }],
      goals: ['Only goal'],
    };
    view.render(smaller);

    const controlsEl = document.getElementById('help-controls') as HTMLElement;
    const goalsEl = document.getElementById('help-goals') as HTMLElement;
    expect(controlsEl.querySelectorAll('li').length).toBe(smaller.controls.length);
    expect(goalsEl.querySelectorAll('li').length).toBe(smaller.goals.length);

    // And no text from the first render survives (e.g. the '?' control is gone).
    expect(controlsEl.textContent?.includes('Toggle this help')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// m23-s3 — overlay a11y wiring on the show()/hide() edge (ADDITIVE; see the file header)
// ---------------------------------------------------------------------------

const S3_ID: OverlayId = 'helpView';
const S3_META = OVERLAY_A11Y[S3_ID];

/** A focusable OUTSIDE the overlay: the "pre-overlay" element a close must restore focus to. */
function s3OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root — render() only rebuilds
 *  #help-controls / #help-goals, so if this loses focus something RE-OPENED the overlay. */
function s3InsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

describe('HelpView — overlay a11y wiring on the show/hide edge (m23-s3)', () => {
  it('S3-helpView-OPEN-ARIA BITES: the first show() from a display:none shell labels the root from OVERLAY_A11Y/t()', () => {
    const { overlay } = mountHelpOverlay();
    const view = new HelpView();

    // VACUITY ATTACK V4, closed here: without `display:none` the FIRST show() is a NO-EDGE and
    // every open assertion below is silently vacuous. This also pins WIK-3 — an impl that reads
    // `this.visible` AFTER writing `style.display` sees a constant `true` and never opens.
    expect(view.visible, 'V4: the shell must start hidden, so the first show() IS an edge').toBe(
      false,
    );

    view.show();

    // Every expectation is DERIVED from the table at assert time — never a literal (V5).
    expect(overlay.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S3_META.role);
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(
      overlay.getAttribute('aria-label'),
      'THE tooth: role/aria-modal are static literals in index.html:90-91 and pass a view that ' +
        'calls nothing; aria-label is absent from every shell, so only a real open can produce it ' +
        '— and because all 16 catalog values are distinct, this also kills the wrong-OverlayId impl',
    ).toBe(t(S3_META.labelKey));
  });

  it('S3-helpView-DEFER-FOCUS BITES: both polarities — NOT focused synchronously, focused after ONE real macrotask, and the defer is owned by openOverlayA11y', async () => {
    const { overlay } = mountHelpOverlay();
    const target = overlay.querySelector<HTMLElement>(S3_META.initialFocusSelector);
    expect(target, `the fixture must contain ${S3_META.initialFocusSelector}`).not.toBeNull();
    const view = new HelpView();

    view.show();

    expect(document.activeElement, 'the initial focus must NOT have landed synchronously').not.toBe(
      target,
    );
    expect(
      vi.mocked(openOverlayA11y),
      'the deferred focus must be scheduled by openOverlayA11y, not by the view (A11Y-15)',
    ).toHaveBeenCalledTimes(1);

    await flushMacrotask();

    // IDENTITY, never `root.contains(activeElement)` — that passes on any decorative wrapper.
    expect(document.activeElement).toBe(target);
  });

  it('S3-helpView-CLOSE-RESTORE BITES: hide() strips role, aria-modal AND aria-label from the root and hands focus back to the pre-overlay element', async () => {
    const { overlay } = mountHelpOverlay();
    const outside = s3OutsideSentinel();
    outside.focus();
    expect(document.activeElement, 'precondition: focus starts OUTSIDE the overlay').toBe(outside);

    const view = new HelpView();
    view.show();
    await flushMacrotask();
    expect(
      document.activeElement,
      'precondition: the open moved focus INTO the overlay, so the restore below is a real move',
    ).not.toBe(outside);

    view.hide();

    // VACUITY ATTACK V1: the two static literals can only be ABSENT if closeOverlayA11y really ran.
    expect(
      overlay.getAttribute('role'),
      'a display:none node must not keep claiming to be a dialog',
    ).toBeNull();
    expect(overlay.getAttribute('aria-modal')).toBeNull();
    expect(overlay.getAttribute('aria-label')).toBeNull();

    expect(document.activeElement, 'focus must return to the pre-overlay element').toBe(outside);
  });

  it('S3-helpView-REPEAT-NO-REOPEN BITES: show() on an ALREADY-visible overlay neither re-opens nor yanks focus back', async () => {
    // A re-open clears and re-schedules the deferred-focus timer (ui/overlayA11y.ts:100-113).
    // INVISIBLE to every attribute assertion, so it is proven twice: by a call COUNT and by the
    // sentinel still holding focus.
    const { overlay } = mountHelpOverlay();
    const view = new HelpView();

    view.show();
    await flushMacrotask();

    const inside = s3InsideSentinel(overlay);
    inside.focus();
    expect(document.activeElement, 'precondition: focus is parked INSIDE the overlay').toBe(inside);

    view.show();
    await flushMacrotask();

    expect(document.activeElement, 'a repeat show() must NOT re-run the deferred focus').toBe(
      inside,
    );
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S3-helpView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    // THE MECHANISM ORACLE (plan A3): a view that hand-writes the three attributes with the correct
    // copied literal passes every VALUE assertion here while shipping NO trap, NO return-focus
    // record and NO timer. The literal `null` pins ADR-0205 A3 / plan D8. This test also executes
    // BOTH new branches, which matters because this file is in the coverage denominator (R5).
    const { overlay } = mountHelpOverlay();
    const view = new HelpView();

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S3_ID, overlay);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S3_ID, null);
  });

  it('S3-helpView-CLOSE-UNGUARDED BITES: hide() calls the close UNCONDITIONALLY — on a never-opened view, and again on every repeat', () => {
    // Plan D2's deliberate asymmetry, and plan ANTI-PATTERN #3. Measured by red-team: wrapping
    // hide()'s close in `if (wasVisible)` ships with every other gate green. A guarded hide() reads
    // `visible === false` and SKIPS the close whenever a record ever desynchronised from the DOM
    // (S1's named A13 leak, ui/overlayA11y.ts:55-59) — making a live capture listener, a pending
    // timer and a stale return target PERMANENT. This view is in BATTLE_FORCE_HIDE
    // (ui/overlayRegistry.ts:274-283), so main.ts's force-hide path drives its close: exactly the
    // desync D2 cites. Unguarded, hide() HEALS it, and a close with no record is a documented pure
    // no-op (ui/overlayA11y.ts:136-137), so nothing is risked.
    mountHelpOverlay();
    const view = new HelpView();
    expect(view.visible, 'precondition: never opened').toBe(false);

    expect(() => view.hide()).not.toThrow();
    expect(
      vi.mocked(closeOverlayA11y),
      'hide() on a never-opened view MUST still call the close — a guarded hide calls it zero times',
    ).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S3_ID, null);

    view.hide();
    expect(
      vi.mocked(closeOverlayA11y),
      'unguarded means unguarded: every hide() calls the close',
    ).toHaveBeenCalledTimes(2);

    // And the same holds after a real open/close cycle: the second hide() still calls it.
    vi.clearAllMocks();
    view.show();
    view.hide();
    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });
});
