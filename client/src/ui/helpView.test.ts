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

// ---------------------------------------------------------------------------
// ctl-14 ADDITION (CTL14.1) — Help is GENERATED and TABBED. INTENTIONAL CHANGE: the PTC2B render
// pins that read the retired `{ controls: [{key, action}], goals: string[] }` shape are REPLACED by
// the tab-shaped ones below (the two-list <li> counts, the "key — action" text, the goals list), with
// the show / hide / a11y / XSS / rebuild-authoritative teeth KEPT (re-pointed at the new shape).
//
// CONTRACT (helpView.ts; the specialist builds exactly this):
//   render(vm: HelpViewModel)  fills THREE panels with textContent ONLY, one <li> per row:
//                              This screen -> `#help-screen` (created by the view at runtime inside
//                              #help-overlay; NEW id, parallel to the two that stay), All controls
//                              -> `#help-controls`, Goals -> `#help-goals`. Each render rebuilds
//                              authoritatively. A row's <li> text holds its keys (each key text) and
//                              its action; a row with NO keys is exactly its action (no separator).
//                              The vm's tab titles are kept for the strip, the note for the controls tab.
//   paint({ layout: NavLayout, nav: NavState })   (the SAME shape helpScreen paints: layout + nav)
//                              renders a `role="tablist"` strip (navRender.renderTabs, frame id
//                              `help`, so tab ids are navTabId('help', tab)) with one `role="tab"`
//                              per layout tab labelled by the vm title, the active one
//                              aria-selected="true"; shows ONLY the active tab's panel (the others
//                              carry the `hidden` attribute) and the note on the controls tab only.
//   show() / hide() / toggle() / visible / ctor throws on a missing #help-overlay: unchanged.
// "Visible text" below = the overlay's text with every `hidden` subtree skipped, so the note may live
// anywhere (inside the controls panel or a sibling the view hides) without this suite caring.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { HELP_TABS, type HelpViewModel } from './helpModel';
import { HelpView } from './helpView';
import { type NavState, navFocus, navInit } from './nav';
import { navTabId } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import { HELP_LAYOUT } from './screens/helpScreen';

// The m23-s3 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works.
vi.mock('./overlayA11y', { spy: true });

/** One REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0),
 *  and fake timers are banned for this defer (plan anti-pattern #10). */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// NEW file-level isolation hooks. They run BEFORE the describe-level `mountHelpOverlay`
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

// ---------------------------------------------------------------------------
// DOM mount helper — installs the index.html shell for helpView.
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

  // m23-s3 FIXTURE FIDELITY: `role`/`aria-modal` have shipped as STATIC
  // LITERALS on this shell since m23-s2, and #help-title carries the tabindex="-1" anchor. They
  // are copied here NOT to be asserted on their own — that is vacuous, a view calling nothing
  // passes — but so that "all three attributes ABSENT after close" is a real tooth: only
  // closeOverlayA11y can remove them. The tabindex buys ZERO test
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

// A representative VM for render() tests: the three tabs of the ctl-14 view model. The strings are
// FIXTURE text (the view paints what the vm carries; the catalog wiring is helpModel's and the fr
// case's, in helpView.i18n.test.ts).
const SAMPLE_VM: HelpViewModel = {
  tabs: [
    {
      tab: 'screen',
      title: 'Fixture tab one',
      rows: [
        { keys: ['Esc'], action: 'Open the fixture menu' },
        { keys: ['R'], action: 'Open the fixture help' },
      ],
    },
    {
      tab: 'controls',
      title: 'Fixture tab two',
      rows: [
        { keys: ['W', 'Arrow Up'], action: 'Move the fixture up' },
        { keys: ['F9'], action: 'Download bug bundle' },
        { keys: [], action: 'A row with no key' },
      ],
    },
    {
      tab: 'goals',
      title: 'Fixture tab three',
      rows: [
        { keys: [], action: 'Recruit a monster' },
        { keys: [], action: 'Win a battle' },
        { keys: [], action: 'Trade with another tester' },
      ],
    },
  ],
  note: 'Fixture note: key names are your keyboard, button names are the screen.',
};

const SCREEN_PANEL = '#help-screen';
const CONTROLS_PANEL = '#help-controls';
const GOALS_PANEL = '#help-goals';

/** The nav state of Help on `tab`, from the real layout (never hand-built). */
const stateOn = (tab: string): NavState => navFocus(HELP_LAYOUT, navInit(HELP_LAYOUT), { tab });

const panel = (selector: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`#help-overlay ${selector}`);
  if (el === null) throw new Error(`no ${selector} in #help-overlay`);
  return el;
};
const rowsOf = (selector: string): HTMLElement[] =>
  Array.from(panel(selector).querySelectorAll<HTMLElement>('li'));

/** The text a user can read: the overlay's text with every `hidden` subtree skipped. */
function visibleText(root: Element): string {
  if (root.hasAttribute('hidden')) return '';
  const parts: string[] = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) parts.push(node.textContent ?? '');
    else if (node.nodeType === 1) parts.push(visibleText(node as Element));
  }
  return parts.join('\n');
}

/** The tab strip's tabs in DOM order: { key, label, selected }. */
function tabsNow(): Array<{ key: string | undefined; label: string; selected: string | null }> {
  return Array.from(
    document.querySelectorAll<HTMLElement>('#help-overlay [role="tablist"] [role="tab"]'),
  ).map((el) => ({
    key: el.dataset.navTab,
    label: el.textContent ?? '',
    selected: el.getAttribute('aria-selected'),
  }));
}

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
    // Pressing `?` while help is open closes it. The view's toggle() must flip both ways.
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

describe('HelpView render(): paints each tab`s rows as textContent <li>s into its own panel (PTC2B-10, ctl-14)', () => {
  beforeEach(() => {
    mountHelpOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('BITES: render() paints exactly one <li> per row into each of the three panels — kills no-render / wrong-panel / wrong-count impl', () => {
    // INTENTIONAL CHANGE (ctl-14): was one <li> per control into #help-controls and one per goal
    // into #help-goals. WRONG IMPL KILLED: an impl that ignores a tab, paints a tab's rows into
    // another tab's panel (Goals under All controls), or paints a different count; and one that
    // forgets the runtime This-screen panel (#help-screen).
    const view = new HelpView();
    view.render(SAMPLE_VM);
    expect(rowsOf(SCREEN_PANEL), 'This screen').toHaveLength(2);
    expect(rowsOf(CONTROLS_PANEL), 'All controls').toHaveLength(3);
    expect(rowsOf(GOALS_PANEL), 'Goals').toHaveLength(3);
    expect(
      new Set([panel(SCREEN_PANEL), panel(CONTROLS_PANEL), panel(GOALS_PANEL)]).size,
      'three different panels',
    ).toBe(3);
    expect(panel(CONTROLS_PANEL), 'the shell`s own list element is the All controls panel').toBe(
      document.getElementById('help-controls'),
    );
    expect(panel(GOALS_PANEL)).toBe(document.getElementById('help-goals'));
  });

  it('BITES: each row <li> holds BOTH its keys and its action, in row order; a row with no key is exactly its action — kills half-painted / separator-prefixed impl', () => {
    // WRONG IMPL KILLED: an impl that renders only the keys (a key with no meaning) or only the
    // action (a meaning with no key); a two-key row that drops its alt; rows re-ordered; and a
    // keyless row (a goal, an unbound shortcut) painted with a stray " — " or empty key box in
    // front of the action.
    const view = new HelpView();
    view.render(SAMPLE_VM);
    for (const [selector, tabIndex] of [
      [SCREEN_PANEL, 0],
      [CONTROLS_PANEL, 1],
      [GOALS_PANEL, 2],
    ] as const) {
      const rows = SAMPLE_VM.tabs[tabIndex].rows;
      const lis = rowsOf(selector);
      expect(lis.length, `${selector}: one <li> per row`).toBe(rows.length);
      for (const [i, row] of rows.entries()) {
        const text = lis[i].textContent ?? '';
        expect(text.includes(row.action), `${selector} row ${i}: the action`).toBe(true);
        for (const key of row.keys) {
          expect(text.includes(key), `${selector} row ${i}: the key ${key}`).toBe(true);
        }
        if (row.keys.length === 0) {
          expect(text.trim(), `${selector} row ${i}: no key, exactly the action`).toBe(row.action);
        }
      }
    }
    // The two keys of one row are both there, the primary first.
    const move = rowsOf(CONTROLS_PANEL)[0].textContent ?? '';
    expect(move.indexOf('W'), 'the primary key reads before the alt').toBeLessThan(
      move.indexOf('Arrow Up'),
    );
  });
});

// ---------------------------------------------------------------------------
// ctl-14 (CTL14.1): the tab strip and the one visible panel.
// ---------------------------------------------------------------------------

describe('HelpView paint(): the tab strip and the active panel (ctl-14, CTL14.1)', () => {
  beforeEach(() => {
    mountHelpOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('CTL14-1-VIEW-TABS: paint() draws a tablist of three tabs labelled by the model titles with the active one selected, shows only the active tab`s panel (and the note only on All controls), switches both with the nav state, and rows reach the DOM as text, never markup', () => {
    // WRONG IMPL KILLED: no tab strip, or one that is not role="tablist" / role="tab"; labels
    // that are literals instead of the vm's titles; no active mark (colour alone is not enough:
    // aria-selected is checked) or two active tabs; all three panels visible at once (Help would be
    // one long page, and the tabs decorative); the panel NOT following the active tab (LB / RB
    // would move the strip and show the old content); a tab strip rebuilt with duplicates on every
    // paint (a held RB would grow it); a note that shows on every tab or on none; stale tab ids (a
    // screen reader's aria-labelledby would dangle); and a row painted through innerHTML (an
    // `<img onerror>` action would become a node).
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.show();

    const titles = SAMPLE_VM.tabs.map((x) => x.title);
    const visiblePanels = (): string[] =>
      [
        ['screen', SCREEN_PANEL],
        ['controls', CONTROLS_PANEL],
        ['goals', GOALS_PANEL],
      ]
        .filter(([, selector]) => !panel(selector).hidden)
        .map(([name]) => name);

    // Paint the opening state: This screen.
    view.paint({ layout: HELP_LAYOUT, nav: stateOn('screen') });
    expect(document.querySelectorAll('#help-overlay [role="tablist"]').length, 'one tablist').toBe(
      1,
    );
    expect(tabsNow(), 'three tabs, labelled by the vm, This screen selected').toEqual([
      { key: 'screen', label: titles[0], selected: 'true' },
      { key: 'controls', label: titles[1], selected: 'false' },
      { key: 'goals', label: titles[2], selected: 'false' },
    ]);
    expect(
      [...HELP_TABS].map((tab) => document.getElementById(navTabId('help', tab)) !== null),
      'the tab ids are the nav kit`s, frame `help`',
    ).toEqual([true, true, true]);
    expect(visiblePanels(), 'only This screen is shown').toEqual(['screen']);
    expect(panel(SCREEN_PANEL).hidden, 'the shown panel is not hidden').toBe(false);
    const overlay = document.getElementById('help-overlay') as HTMLElement;
    let visible = visibleText(overlay);
    expect(visible, 'This screen: its rows are readable').toContain('Open the fixture menu');
    expect(visible, 'This screen: not the controls').not.toContain('Download bug bundle');
    expect(visible, 'This screen: not the goals').not.toContain('Recruit a monster');
    expect(visible, 'This screen: no keys-vs-buttons note').not.toContain(SAMPLE_VM.note);

    // RB: All controls. The strip, the panel and the note all follow.
    view.paint({ layout: HELP_LAYOUT, nav: stateOn('controls') });
    expect(
      tabsNow().map((x) => x.selected),
      'only All controls is selected',
    ).toEqual(['false', 'true', 'false']);
    expect(visiblePanels(), 'only All controls is shown').toEqual(['controls']);
    visible = visibleText(overlay);
    expect(visible, 'All controls: its rows').toContain('Download bug bundle');
    expect(visible, 'All controls: the note shows here').toContain(SAMPLE_VM.note);
    expect(visible, 'All controls: not This screen`s rows').not.toContain('Open the fixture menu');
    expect(visible, 'All controls: not the goals').not.toContain('Recruit a monster');

    // RB again: Goals.
    view.paint({ layout: HELP_LAYOUT, nav: stateOn('goals') });
    expect(tabsNow().map((x) => x.selected)).toEqual(['false', 'false', 'true']);
    expect(visiblePanels(), 'only Goals is shown').toEqual(['goals']);
    visible = visibleText(overlay);
    expect(visible, 'Goals: its rows').toContain('Win a battle');
    expect(visible, 'Goals: no note').not.toContain(SAMPLE_VM.note);
    expect(visible, 'Goals: not the controls').not.toContain('Download bug bundle');

    // Back to This screen, painted twice: nothing duplicates, nothing is rebuilt wrongly.
    view.paint({ layout: HELP_LAYOUT, nav: stateOn('screen') });
    view.paint({ layout: HELP_LAYOUT, nav: stateOn('screen') });
    expect(tabsNow(), 'a repeat paint leaves exactly three tabs').toHaveLength(3);
    expect(visiblePanels()).toEqual(['screen']);
    expect(rowsOf(SCREEN_PANEL), 'painting never touches the rows').toHaveLength(2);

    // Rows are TEXT: an action holding markup renders as the literal string and creates no node.
    const MARKUP = '<img src=x onerror=alert(1)>';
    view.render({
      ...SAMPLE_VM,
      tabs: SAMPLE_VM.tabs.map((x) =>
        x.tab === 'screen' ? { ...x, rows: [{ keys: ['Esc'], action: MARKUP }] } : x,
      ),
    });
    view.paint({ layout: HELP_LAYOUT, nav: stateOn('screen') });
    expect(overlay.querySelector('img'), 'no <img> node was created from a row').toBeNull();
    expect(rowsOf(SCREEN_PANEL)[0].textContent, 'the markup reads as text').toContain(MARKUP);
  });
});

// ---------------------------------------------------------------------------
// ★★ XSS firewall: a <script>-looking VM string must render
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
    // INTENTIONAL CHANGE (ctl-14): the payloads now ride the tab-shaped model: a control ACTION, a
    // GOAL row, a KEY, a tab TITLE and the NOTE (every string the view paints), on all three tabs.
    const XSS = '<script>alert(1)</script>';
    const IMG = '<img src=x onerror=alert(2)>';
    const vm: HelpViewModel = {
      tabs: [
        { tab: 'screen', title: IMG, rows: [{ keys: [XSS], action: 'Screen row' }] },
        { tab: 'controls', title: 'C', rows: [{ keys: ['X'], action: XSS }] },
        { tab: 'goals', title: 'G', rows: [{ keys: [], action: IMG }] },
      ],
      note: XSS,
    };
    const view = new HelpView();
    view.render(vm);
    for (const tab of HELP_TABS) view.paint({ layout: HELP_LAYOUT, nav: stateOn(tab) });

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
    const li = rowsOf(CONTROLS_PANEL)[0];
    // False positive: this asserts the <script> payload survives as LITERAL text (proof textContent
    // escaped it), not a sink. `li` is a jsdom element; `.includes()` is a string read, not HTML injection.
    expect(
      // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
      li.textContent?.includes(XSS),
      'the <script> string must appear as LITERAL textContent, not be parsed',
    ).toBe(true);
    // 3) The <img onerror> payload (a goal row and a tab title) also renders as literal text.
    expect(
      overlay.querySelector('img'),
      'render() must not inject an <img> element from a goal row or a tab title',
    ).toBeNull();
    expect(rowsOf(GOALS_PANEL)[0].textContent, 'the goal reads as text').toContain(IMG);
    expect(
      rowsOf(SCREEN_PANEL)[0].textContent,
      'a KEY is text too (it is the glyph a remap learned from a real keypress)',
    ).toContain(XSS);
    expect(tabsNow()[0].label, 'a tab title is text').toBe(IMG);
    // The note, on its own tab, as literal text.
    view.paint({ layout: HELP_LAYOUT, nav: stateOn('controls') });
    expect(visibleText(overlay), 'the note reads as text on All controls').toContain(XSS);
  });
});

// ---------------------------------------------------------------------------
// ★ Rebuild-authoritative: render() twice with different VMs — no stale
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
    // PROOF-OF-TEETH: INTENTIONAL CHANGE (ctl-14): the first render has 2 / 3 / 3 rows on its three
    // tabs; the second has 1 / 1 / 1. A correct rebuild leaves exactly one <li> in each panel; an
    // append impl leaves 3 / 4 / 4. The strip follows the new titles and never doubles.
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.paint({ layout: HELP_LAYOUT, nav: stateOn('screen') });

    const smaller: HelpViewModel = {
      tabs: [
        { tab: 'screen', title: 'Second one', rows: [{ keys: ['Z'], action: 'Only screen row' }] },
        { tab: 'controls', title: 'Second two', rows: [{ keys: ['Y'], action: 'Only control' }] },
        { tab: 'goals', title: 'Second three', rows: [{ keys: [], action: 'Only goal' }] },
      ],
      note: 'Second note',
    };
    view.render(smaller);
    view.paint({ layout: HELP_LAYOUT, nav: stateOn('screen') });

    expect(rowsOf(SCREEN_PANEL), 'This screen: one row').toHaveLength(1);
    expect(rowsOf(CONTROLS_PANEL), 'All controls: one row').toHaveLength(1);
    expect(rowsOf(GOALS_PANEL), 'Goals: one row').toHaveLength(1);

    // And no text from the first render survives, in any panel.
    const all = (document.getElementById('help-overlay') as HTMLElement).textContent ?? '';
    for (const stale of [
      'Open the fixture menu',
      'Download bug bundle',
      'Recruit a monster',
      'Fixture tab one',
      SAMPLE_VM.note,
    ]) {
      expect(all.includes(stale), `no stale text: ${stale}`).toBe(false);
    }
    expect(
      tabsNow().map((x) => x.label),
      'the strip reads the second model`s titles, three tabs',
    ).toEqual(['Second one', 'Second two', 'Second three']);
    view.paint({ layout: HELP_LAYOUT, nav: stateOn('controls') });
    expect(
      visibleText(document.getElementById('help-overlay') as HTMLElement),
      'the second note shows on All controls',
    ).toContain('Second note');
  });
});

// ---------------------------------------------------------------------------
// Overlay a11y wiring on the show()/hide() edge (ADDITIVE; see the file header)
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
    // A re-open clears and re-schedules the deferred-focus timer.
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
    // timer and a stale return target PERMANENT. This view is in BATTLE_FORCE_HIDE,
    // so main.ts's force-hide path drives its close: exactly the
    // desync D2 cites. Unguarded, hide() HEALS it, and a close with no record is a documented pure
    // no-op, so nothing is risked.
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
