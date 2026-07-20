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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HelpView } from './helpView';

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

  document.body.innerHTML = `
    <div id="help-overlay" style="display:none">
      <div id="help-title">Help</div>
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
