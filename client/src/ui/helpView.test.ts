// @vitest-environment happy-dom
// ui/helpView.test.ts — the Help overlay DOM shell: Introduction | Encyclopedia on the kit (uif-14).
//
// History: pt-c2b (PTC2B-1/2/3/10: visibility, XSS firewall, rebuild-authoritative), m23-s3 (overlay a11y
// wiring on the show/hide edge) and ctl-14 (a generated, tabbed Help) are all kept where they still
// apply. INTENTIONAL CHANGE (uif-14): the ctl-14 pins that read the `{ tabs: [{ rows }], note }` model
// (the three row panels `#help-screen` / `#help-controls` / `#help-goals`, the keys-vs-buttons note,
// the `<li>` rows with `<kbd>` keys) and the qf-11 pins on the old strip placement and the runtime
// `#help-screen` list are RETIRED with the tabs and panels they pinned; the show / hide / toggle, m23-s3
// a11y, XSS and rebuild-authoritative teeth are re-pointed at the new shape.
//
// CONTRACT (helpView.ts; the specialist builds exactly this; the plan is
// memory/projects/monster-realm-uif-14-plan.md):
//   new HelpView()                       zero args keeps working (overlayA11yWiring.test.ts does it);
//   new HelpView({ announce })           `announce(text)` is optional; THROWS when #help-overlay is missing
//   render(vm: HelpViewModel)            fills `#help-intro` (static div) with one <p> per paragraph and
//                                        keeps the tab titles, the entries (term / definition / related)
//                                        for `paint`; textContent ONLY; a re-render rebuilds authoritatively.
//   paint({ layout, nav, detail })       the kit TabBar (strip `#help-tabs`, role=tablist, inside a
//                                        `.mr-tabbar` root placed after #help-title) with one role=tab per
//                                        tab labelled by the vm title, the selected one `is-selected` and
//                                        aria-selected; `#help-encyclopedia` (static ul.mr-nav-list) is a
//                                        renderNav list of the entry terms (`[data-nav-key]` rows, the
//                                        cursor row `.is-active`); only the active tab's panel is visible
//                                        (the other carries `hidden`). With `detail` set, ONE
//                                        `[data-context-sheet]` inside #help-overlay renders the DETAIL
//                                        variant: heading = the term, prose = the definition plus the
//                                        related entries' terms, exactly one row (kit.sheet.back); the
//                                        list stays rendered behind it. Closing hides and empties it.
//                                        Focus moves into the sheet on open, back into the overlay on close.
//   announce (UIF14.6)                   once with the new tab's title on a tab change, once with the
//                                        entry's term on a detail open; never on the first paint after
//                                        show(), an identical repaint, a cursor move or a detail close.
//   show() / hide() / toggle() / visible / ctor throws on a missing #help-overlay: unchanged.
//   The shell (client/index.html): #help-overlay > #help-title, #help-intro, #help-encyclopedia.
//   `#help-controls`, `#help-goals`, `#help-screen`, `#help-note` do NOT exist.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec only.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { ENTRY_KEYS, type EntryKey, HELP_TABS, type HelpViewModel } from './helpModel';
import { HelpView } from './helpView';
import { CATALOG_EN } from './i18n/catalog.en';
import { type NavState, navFocus, navInit } from './nav';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import { DETAIL_LAYOUT, HELP_LAYOUT } from './screens/helpScreen';

// The m23-s3 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works.
vi.mock('./overlayA11y', { spy: true });

/** One REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0),
 *  and fake timers are banned for this defer (m23-s3 plan anti-pattern #10). */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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
// DOM mount helper — installs the (uif-14) index.html shell for helpView.
// ---------------------------------------------------------------------------

function mountHelpOverlay(): { overlay: HTMLElement } {
  const existing = document.getElementById('help-overlay');
  if (existing) existing.remove();
  // FIXTURE FIDELITY (m23-s3): `role` / `aria-modal` ship as static literals on this shell and
  // #help-title carries the tabindex="-1" anchor; they are copied so "ABSENT after close" is a real
  // tooth (only closeOverlayA11y removes them). The two panels are the shell's static nodes (uif-14).
  document.body.innerHTML = `
    <div id="help-overlay" role="dialog" aria-modal="true" style="display:none">
      <div id="help-title" tabindex="-1">Help</div>
      <div id="help-intro"></div>
      <ul id="help-encyclopedia" class="mr-nav-list"></ul>
    </div>
  `;
  return { overlay: document.getElementById('help-overlay') as HTMLElement };
}

function teardown(): void {
  document.body.innerHTML = '';
}

/** FIXTURE view model: the strings are fixture text (the view paints what the vm carries; the catalog
 *  wiring is helpModel's and helpView.i18n.test.ts's). Entry `i` relates to the next two entries. */
const term = (key: string): string => `Term ${key}`;
const definition = (key: string): string => `Definition of ${key}.`;
const SAMPLE_VM: HelpViewModel = {
  tabs: [
    { tab: 'intro', title: 'Fixture intro' },
    { tab: 'encyclopedia', title: 'Fixture encyclopedia' },
  ],
  // uif-14b: `report` is the Report a problem row's label (fixture text).
  intro: {
    paragraphs: ['Fixture paragraph one.', 'Fixture paragraph two.'],
    report: 'Fixture report',
  },
  entries: ENTRY_KEYS.map((key, i) => ({
    key,
    term: term(key),
    definition: definition(key),
    related: [
      ENTRY_KEYS[(i + 1) % ENTRY_KEYS.length],
      ENTRY_KEYS[(i + 2) % ENTRY_KEYS.length],
    ] as EntryKey[],
  })),
};

/** The nav state of Help on `tab` (and `item`), from the real layout (never hand-built). */
const stateOn = (tab: string, item?: string): NavState =>
  navFocus(HELP_LAYOUT, navInit(HELP_LAYOUT), item === undefined ? { tab } : { tab, item });

const paintOf = (tab: string, item?: string, detail: EntryKey | null = null) => ({
  layout: HELP_LAYOUT,
  nav: stateOn(tab, item),
  detail,
});

const overlayEl = (): HTMLElement => document.getElementById('help-overlay') as HTMLElement;
const introEl = (): HTMLElement => document.getElementById('help-intro') as HTMLElement;
const encEl = (): HTMLElement => document.getElementById('help-encyclopedia') as HTMLElement;

/** Out of sight by `hidden` or `display:none`, on the node or an ancestor. A missing node is hidden. */
function isHidden(start: Element | null): boolean {
  for (let node: Element | null = start; node instanceof HTMLElement; node = node.parentElement) {
    if (node.hidden || node.style.display === 'none') return true;
  }
  return !(start instanceof HTMLElement);
}

/** The tab strip's tabs in DOM order. */
function tabsNow(): Array<{
  key: string | undefined;
  label: string;
  selected: string | null;
  isSelected: boolean;
  isActive: boolean;
}> {
  return Array.from(
    document.querySelectorAll<HTMLElement>('#help-overlay [role="tablist"] [role="tab"]'),
  ).map((el) => ({
    key: el.dataset.navTab,
    label: el.textContent ?? '',
    selected: el.getAttribute('aria-selected'),
    isSelected: el.classList.contains('is-selected'),
    isActive: el.classList.contains('is-active'),
  }));
}

const rowEls = (): HTMLElement[] =>
  Array.from(encEl().querySelectorAll<HTMLElement>('[data-nav-key]'));
const activeRow = (): string | null =>
  encEl().querySelector('.is-active')?.getAttribute('data-nav-key') ?? null;

const allSheets = (): HTMLElement[] =>
  Array.from(overlayEl().querySelectorAll<HTMLElement>('[data-context-sheet]'));
function theSheet(): HTMLElement {
  const sheets = allSheets();
  expect(sheets, 'exactly one context sheet lives in the overlay').toHaveLength(1);
  return sheets[0] as HTMLElement;
}
const sheetPart = (cls: string): HTMLElement => {
  const el = theSheet().querySelector<HTMLElement>(`.${cls}`);
  if (el === null) throw new Error(`the sheet has no .${cls}`);
  return el;
};
const sheetRows = (): HTMLElement[] =>
  Array.from(theSheet().querySelectorAll<HTMLElement>('[data-nav-key]'));

/** The catalog's Back row word, read raw from the English catalog. */
const BACK = (CATALOG_EN as Record<string, unknown>)['kit.sheet.back'] as string;

// ---------------------------------------------------------------------------
// Constructor and visibility (PTC2B-1/2/3).
// ---------------------------------------------------------------------------

describe('HelpView constructor: fail-loud, zero-arg compatible, builds its kit parts once', () => {
  afterEach(() => {
    teardown();
  });

  it('BITES: ctor throws when #help-overlay is absent — kills no-guard impl', () => {
    // WRONG IMPL KILLED: an impl that silently stores null from getElementById — every
    // show / hide / render would then silently do nothing.
    expect(() => new HelpView()).toThrow();
  });

  it('BITES: `new HelpView()` with no arguments constructs over the shell, and `new HelpView({ announce })` does too; the kit parts are built once, a second construction over the same shell duplicates nothing', () => {
    // WRONG IMPL KILLED: a required handler argument (the overlayA11yWiring rig constructs it with
    // none and would throw); a constructor that builds a second tab bar or a second sheet per
    // construction (the strip id would be duplicated and one of them dead).
    mountHelpOverlay();
    expect(() => new HelpView()).not.toThrow();
    expect(() => new HelpView({ announce: () => {} })).not.toThrow();
    expect(document.querySelectorAll('#help-tabs'), 'one strip').toHaveLength(1);
    expect(document.querySelectorAll('#help-overlay .mr-tabbar'), 'one tab bar').toHaveLength(1);
    expect(allSheets().length, 'at most one sheet').toBeLessThanOrEqual(1);
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.paint(paintOf('encyclopedia', undefined, 'party'));
    expect(allSheets(), 'one sheet after painting a detail').toHaveLength(1);
  });
});

describe('HelpView visibility: show / hide / toggle / visible (PTC2B-1/2)', () => {
  beforeEach(() => {
    mountHelpOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('BITES: visible is false initially (display:none in index.html) — kills visible-at-construction impl', () => {
    const view = new HelpView();
    expect(view.visible).toBe(false);
  });

  it('BITES: show() makes visible=true AND display !== "none" — kills no-op show impl (PTC2B-1)', () => {
    const view = new HelpView();
    view.show();
    expect(view.visible).toBe(true);
    expect(overlayEl().style.display).not.toBe('none');
  });

  it('BITES: hide() makes visible=false AND display === "none" — kills no-op hide impl (PTC2B-3)', () => {
    const view = new HelpView();
    view.show();
    view.hide();
    expect(view.visible).toBe(false);
    expect(overlayEl().style.display).toBe('none');
  });

  it('BITES: toggle() from hidden shows; toggle() again hides — kills toggle=always-show impl (PTC2B-2)', () => {
    const view = new HelpView();
    expect(view.visible).toBe(false);
    view.toggle();
    expect(view.visible).toBe(true);
    view.toggle();
    expect(view.visible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UIF14.1: the TabBar, two tabs, the retired panels gone.
// ---------------------------------------------------------------------------

describe('HelpView: the tab bar and the two panels (uif-14, UIF14.1)', () => {
  beforeEach(() => {
    mountHelpOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('UIF14.1 paint() draws the kit tab bar: strip #help-tabs (role=tablist) inside a .mr-tabbar root after #help-title, exactly two role=tab labelled by the vm titles, the selected one is-selected and aria-selected (never is-active), and it follows the nav state', () => {
    // WRONG IMPL KILLED: no tab strip, or a hand-rolled one outside the kit (no .mr-tabbar root: the
    // chips and the selected style are missing); a third tab (All controls kept); labels that are
    // literals instead of the vm's titles; the selected tab marked with the row cursor's `is-active`
    // (feedback 060, 169: tab and row can both be true on one screen); no aria-selected; two tabs
    // selected; the strip not following LB / RB; a strip rebuilt with duplicates on every paint; the
    // strip placed before the title.
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.show();
    view.paint(paintOf('intro'));

    const strip = document.getElementById('help-tabs') as HTMLElement;
    expect(strip, 'the strip exists').not.toBeNull();
    expect(strip.getAttribute('role'), 'a tablist').toBe('tablist');
    const root = strip.closest('.mr-tabbar') as HTMLElement | null;
    expect(root, 'the strip sits inside the kit TabBar root').not.toBeNull();
    expect(overlayEl().contains(root), 'the tab bar is inside the overlay').toBe(true);
    expect(root?.hidden, 'the tab bar is shown').toBe(false);
    const title = document.getElementById('help-title') as HTMLElement;
    expect(
      title.compareDocumentPosition(root as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the tab bar comes after #help-title',
    ).toBeTruthy();
    expect(document.querySelectorAll('#help-overlay [role="tablist"]'), 'one tablist').toHaveLength(
      1,
    );

    expect(tabsNow(), 'two tabs, Introduction selected').toEqual([
      { key: 'intro', label: 'Fixture intro', selected: 'true', isSelected: true, isActive: false },
      {
        key: 'encyclopedia',
        label: 'Fixture encyclopedia',
        selected: 'false',
        isSelected: false,
        isActive: false,
      },
    ]);
    view.paint(paintOf('encyclopedia'));
    expect(
      tabsNow().map((x) => [x.selected, x.isSelected]),
      'RB: the Encyclopedia is the selected one',
    ).toEqual([
      ['false', false],
      ['true', true],
    ]);
    view.paint(paintOf('encyclopedia'));
    view.paint(paintOf('intro'));
    view.paint(paintOf('intro'));
    expect(tabsNow(), 'repeat paints leave exactly two tabs').toHaveLength(2);
    expect([...HELP_TABS], 'fixture: the roster is two long').toHaveLength(2);
  });

  it('UIF14.1 the retired panels do not exist: no #help-controls, #help-goals, #help-screen or #help-note, before or after render and paint; only the active tab`s panel (#help-intro or #help-encyclopedia) is visible', () => {
    // WRONG IMPL KILLED: the All controls tab kept under its old id (110: "the All controls tab
    // gone"); the runtime #help-screen list still built; the keys-vs-buttons note still painted; both
    // panels visible at once (Help would be one long page and the tabs decorative); a panel that does
    // not follow the tab.
    const view = new HelpView();
    const gone = ['help-controls', 'help-goals', 'help-screen', 'help-note'];
    for (const id of gone) expect(document.getElementById(id), `${id} (constructed)`).toBeNull();
    view.render(SAMPLE_VM);
    view.show();
    view.paint(paintOf('intro'));
    for (const id of gone) expect(document.getElementById(id), `${id} (painted)`).toBeNull();

    expect(isHidden(introEl()), 'Introduction: its panel shows').toBe(false);
    expect(isHidden(encEl()), 'Introduction: the Encyclopedia is hidden').toBe(true);
    view.paint(paintOf('encyclopedia'));
    expect(isHidden(introEl()), 'Encyclopedia: Introduction is hidden').toBe(true);
    expect(isHidden(encEl()), 'Encyclopedia: its panel shows').toBe(false);
    view.paint(paintOf('intro'));
    expect(isHidden(introEl()), 'back on Introduction').toBe(false);
    expect(isHidden(encEl())).toBe(true);
    for (const id of gone)
      expect(document.getElementById(id), `${id} (after a tab round trip)`).toBeNull();
  });

  it('UIF14.2P #help-intro holds exactly the two paragraphs as <p> elements, in order, as text; a second render with one paragraph leaves exactly one (rebuild-authoritative)', () => {
    // WRONG IMPL KILLED: paragraphs joined into one node, or an extra empty <p>; paragraphs in
    // another order; a re-render that appends (stale paragraphs survive); a paragraph painted
    // through innerHTML.
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.paint(paintOf('intro'));
    const ps = Array.from(introEl().querySelectorAll('p'));
    expect(
      ps.map((p) => p.textContent),
      'the two paragraphs, in order',
    ).toEqual(['Fixture paragraph one.', 'Fixture paragraph two.']);
    // INTENTIONAL CHANGE (uif-14b): was `children.length === 2` ("only the paragraphs"); the Report a
    // problem list is now the third (last) child.
    expect(introEl().children.length, 'the paragraphs and the Report a problem list').toBe(3);

    view.render({ ...SAMPLE_VM, intro: { ...SAMPLE_VM.intro, paragraphs: ['Only one now.'] } });
    view.paint(paintOf('intro'));
    expect(
      Array.from(introEl().querySelectorAll('p')).map((p) => p.textContent),
      'the second render replaced, never appended',
    ).toEqual(['Only one now.']);
    expect(introEl().textContent, 'no stale text').not.toContain('Fixture paragraph');
    expect(introEl().children.length, 'one paragraph and the list').toBe(2);
  });

  it('UIF14B.1 #help-intro ends with ul#help-intro-rows.mr-nav-list as its LAST child, after the paragraphs, holding one [data-nav-key="report"] row reading the vm label, .is-active on the Introduction tab; a re-render keeps it last with one row', () => {
    // WRONG IMPL KILLED: the row placed before the paragraphs; no row; a row that is not a kit nav
    // item (no data-nav-key: the pointer cannot seek it); no cursor mark (the D-pad's only target is
    // invisible); a hard-coded label instead of the vm's; a re-render that appends a second list or
    // leaves the list before a new paragraph; a plain <button> or <a> instead of a kit list.
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.show();
    view.paint(paintOf('intro'));
    const kids = Array.from(introEl().children);
    const last = kids[kids.length - 1] as HTMLElement;
    expect(last.tagName).toBe('UL');
    expect(last.id).toBe('help-intro-rows');
    expect(last.classList.contains('mr-nav-list')).toBe(true);
    expect(
      kids.slice(0, -1).map((k) => k.tagName),
      'the paragraphs come first',
    ).toEqual(['P', 'P']);
    const rows = Array.from(last.querySelectorAll<HTMLElement>('[data-nav-key]'));
    expect(rows.map((r) => r.dataset.navKey)).toEqual(['report']);
    expect(rows[0]?.textContent).toBe('Fixture report');
    expect(rows[0]?.classList.contains('is-active'), 'the cursor is on the row').toBe(true);

    view.render({ ...SAMPLE_VM, intro: { ...SAMPLE_VM.intro, report: 'Second report' } });
    view.paint(paintOf('intro'));
    expect(
      document.querySelectorAll('#help-intro-rows'),
      'one list after a re-render',
    ).toHaveLength(1);
    const again = Array.from(introEl().children);
    expect((again[again.length - 1] as HTMLElement).id).toBe('help-intro-rows');
    expect(
      Array.from(introEl().querySelectorAll('[data-nav-key]')).map((r) => r.textContent),
      'the label is replaced, not appended',
    ).toEqual(['Second report']);
  });

  it('UIF14B.1 the row stays painted and active when the Encyclopedia shows (list kept), and a second HelpView over the same shell leaves exactly one #help-intro-rows', () => {
    // WRONG IMPL KILLED: a constructor that appends a fresh list per construction (duplicate ids);
    // a list that vanishes when the tab changes (the A target would be gone on return).
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.paint(paintOf('encyclopedia'));
    view.paint(paintOf('intro'));
    expect(introEl().querySelectorAll('[data-nav-key="report"]')).toHaveLength(1);
    new HelpView().render(SAMPLE_VM);
    expect(document.querySelectorAll('#help-intro-rows')).toHaveLength(1);
  });

  it('UIF14B.1 XSS: a report label holding "<img src=x onerror=...>" reads as literal text and creates no node', () => {
    // WRONG IMPL KILLED: an innerHTML sink on the row label.
    const IMG = '<img src=x onerror=alert(3)>';
    const view = new HelpView();
    view.render({ ...SAMPLE_VM, intro: { ...SAMPLE_VM.intro, report: IMG } });
    view.paint(paintOf('intro'));
    expect(overlayEl().querySelector('img')).toBeNull();
    expect(introEl().querySelector('[data-nav-key="report"]')?.textContent).toBe(IMG);
  });
});

// ---------------------------------------------------------------------------
// UIF14.4: the Encyclopedia list.
// ---------------------------------------------------------------------------

describe('HelpView: the Encyclopedia list (uif-14, UIF14.4)', () => {
  beforeEach(() => {
    mountHelpOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('UIF14.4 #help-encyclopedia is the static ul.mr-nav-list holding sixteen [data-nav-key] rows whose text is each entry`s term in ENTRY_KEYS order, the cursor row .is-active (and only it), following the nav state', () => {
    // WRONG IMPL KILLED: a list replaced by a new element (the shell's static ul unused); fewer or
    // more than sixteen rows; rows labelled by key or definition instead of term; rows re-ordered; no
    // cursor mark, or the mark on two rows; a cursor that does not follow the nav state; a class
    // lost on paint (list-style markers show); an inline style written on the list.
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.show();
    view.paint(paintOf('encyclopedia'));

    const list = encEl();
    expect(list.tagName, 'the shell`s ul').toBe('UL');
    expect(list.classList.contains('mr-nav-list'), 'keeps mr-nav-list').toBe(true);
    expect(list.hasAttribute('style'), 'no inline style written on the list').toBe(false);
    expect(
      rowEls().map((r) => r.dataset.navKey),
      'sixteen rows, the entry keys in order',
    ).toEqual([...ENTRY_KEYS]);
    expect(
      rowEls().map((r) => r.textContent),
      'each row reads its term',
    ).toEqual(ENTRY_KEYS.map(term));
    expect(activeRow(), 'the cursor opens on the first entry').toBe('party');
    expect(list.querySelectorAll('.is-active'), 'exactly one active row').toHaveLength(1);

    view.paint(paintOf('encyclopedia', 'bait'));
    expect(activeRow(), 'the cursor follows the nav state').toBe('bait');
    expect(list.querySelectorAll('.is-active'), 'still exactly one').toHaveLength(1);
    expect(
      rowEls()
        .find((r) => r.dataset.navKey === 'bait')
        ?.getAttribute('aria-selected'),
      'and it is aria-selected',
    ).toBe('true');
    expect(rowEls(), 'a repaint rebuilt nothing').toHaveLength(16);
  });

  it('UIF14.4 a second render with new terms replaces every row`s text (no stale term survives), still sixteen rows', () => {
    // WRONG IMPL KILLED: a row text written once (a locale switch or re-open would show the old
    // terms); an append-not-replace render (32 rows).
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.paint(paintOf('encyclopedia'));
    view.render({
      ...SAMPLE_VM,
      entries: SAMPLE_VM.entries.map((e) => ({ ...e, term: `Second ${e.key}` })),
    });
    view.paint(paintOf('encyclopedia'));
    expect(rowEls(), 'sixteen rows').toHaveLength(16);
    expect(rowEls().map((r) => r.textContent)).toEqual(ENTRY_KEYS.map((k) => `Second ${k}`));
    expect(encEl().textContent, 'no first-render term left').not.toContain('Term ');
    expect(
      tabsNow().map((x) => x.label),
      'and the tab titles stay the vm`s',
    ).toEqual(['Fixture intro', 'Fixture encyclopedia']);
  });

  it('UIF14.4 XSS: a term, a definition, a paragraph and a tab title holding "<img src=x onerror=...>" or "<script>" read as literal text and create no node', () => {
    // WRONG IMPL KILLED: any innerHTML sink (row, heading, prose, paragraph, tab label); the proof is
    // the absence of an element and the verbatim string.
    const IMG = '<img src=x onerror=alert(2)>';
    const SCRIPT = '<script>alert(1)</script>';
    const vm: HelpViewModel = {
      tabs: [
        { tab: 'intro', title: IMG },
        { tab: 'encyclopedia', title: 'E' },
      ],
      intro: { paragraphs: [SCRIPT, IMG], report: 'R' },
      entries: SAMPLE_VM.entries.map((e) =>
        e.key === 'party' ? { ...e, term: IMG, definition: SCRIPT } : e,
      ),
    };
    const view = new HelpView();
    view.render(vm);
    view.show();
    view.paint(paintOf('intro'));
    view.paint(paintOf('encyclopedia'));
    view.paint(paintOf('encyclopedia', undefined, 'party'));
    const overlay = overlayEl();
    expect(overlay.querySelector('img'), 'no <img> node').toBeNull();
    // False positive: this asserts the XSS firewall (no <script> element was created), not a sink.
    expect(
      // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
      overlay.querySelector('script'),
      'no <script> node',
    ).toBeNull();
    expect(rowEls()[0]?.textContent, 'the term reads as text in its row').toBe(IMG);
    expect(sheetPart('mr-sheet-title').textContent, 'and as the sheet heading').toBe(IMG);
    expect(sheetPart('mr-sheet-prose').textContent, 'the definition reads as text').toContain(
      SCRIPT,
    );
    expect(tabsNow()[0]?.label, 'a tab title is text').toBe(IMG);
    expect(
      Array.from(introEl().querySelectorAll('p')).map((p) => p.textContent),
      'paragraphs are text',
    ).toEqual([SCRIPT, IMG]);
  });
});

// ---------------------------------------------------------------------------
// UIF14.5: the detail sheet.
// ---------------------------------------------------------------------------

describe('HelpView: the entry detail sheet (uif-14, UIF14.5)', () => {
  beforeEach(() => {
    mountHelpOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('UIF14.5 a detail paint shows ONE [data-context-sheet] in the overlay, variant detail: heading = the term, prose holds the definition and every related entry`s term, exactly one row reading the catalog Back; the Encyclopedia list stays rendered behind it with the cursor row still active', () => {
    // WRONG IMPL KILLED: no sheet, or a second sheet per open; the list variant (heading but no
    // prose); a heading that is the key or the definition; prose with the definition only (the
    // "related mechanics" half of 14.5 missing) or with related KEYS instead of terms; the wrong
    // entry's text (the first entry's, not the opened one's); no Back row, two rows or a hard-coded
    // "Back" (the catalog id carries it); the list hidden or emptied under the modal (the spec says
    // "above the list in the same frame"); the cursor mark dropped while the detail is up.
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.show();
    view.paint(paintOf('encyclopedia', 'bait'));
    expect(allSheets().length === 0 || isHidden(theSheet()), 'no sheet shown before an open').toBe(
      true,
    );

    view.paint(paintOf('encyclopedia', 'bait', 'bait'));
    const sheet = theSheet();
    expect(isHidden(sheet), 'the sheet is shown').toBe(false);
    expect(overlayEl().contains(sheet), 'inside #help-overlay').toBe(true);
    expect(sheet.dataset.sheetVariant, 'the detail variant').toBe('detail');
    expect(sheetPart('mr-sheet-title').textContent, 'heading = the term').toBe(term('bait'));
    const prose = sheetPart('mr-sheet-prose').textContent ?? '';
    expect(prose, 'prose holds the definition').toContain(definition('bait'));
    const bait = SAMPLE_VM.entries.find((e) => e.key === 'bait');
    expect(bait?.related.length, 'fixture: bait has related entries').toBeGreaterThan(0);
    for (const r of bait?.related ?? []) {
      expect(prose, `prose names the related entry ${r} by its term`).toContain(term(r));
    }
    expect(prose, 'and not an unrelated entry`s term').not.toContain(term('party'));
    expect(
      sheetRows().map((r) => r.textContent),
      'exactly one row, the catalog Back',
    ).toEqual([BACK]);
    expect(sheetRows()[0]?.dataset.navKey, 'its key is the DETAIL_LAYOUT item').toBe('back');
    expect(DETAIL_LAYOUT.kind === 'list' ? DETAIL_LAYOUT.items.length : 0, 'fixture').toBe(1);

    expect(isHidden(encEl()), 'the list is not hidden behind the sheet').toBe(false);
    expect(rowEls(), 'and still holds its sixteen rows').toHaveLength(16);
    expect(activeRow(), 'with the cursor row still active').toBe('bait');
    expect(sheet.contains(encEl()), 'the list is not inside the sheet').toBe(false);

    // A different entry replaces the content, never stacks a second sheet.
    view.paint(paintOf('encyclopedia', 'ranked', 'ranked'));
    expect(theSheet(), 'still the one sheet').toBe(sheet);
    expect(sheetPart('mr-sheet-title').textContent).toBe(term('ranked'));
    expect(sheetPart('mr-sheet-prose').textContent).toContain(definition('ranked'));
    expect(sheetPart('mr-sheet-prose').textContent, 'no text of the previous entry').not.toContain(
      definition('bait'),
    );
  });

  it('UIF14.5 closing the detail hides the sheet and empties it (no heading, prose or rows left in the document) and leaves the list and its cursor as they were; reopening works again', () => {
    // WRONG IMPL KILLED: a close that only hides (the named term stays in the document for a screen
    // reader); a close that rebuilds or hides the list; a close that resets the cursor to the first
    // entry (feedback 114: "B closes it back to the same entry"); a sheet that cannot reopen.
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.show();
    view.paint(paintOf('encyclopedia', 'essence', 'essence'));
    const sheet = theSheet();
    expect(isHidden(sheet)).toBe(false);

    view.paint(paintOf('encyclopedia', 'essence'));
    expect(isHidden(sheet), 'the sheet is hidden').toBe(true);
    expect(sheetPart('mr-sheet-title').textContent, 'heading emptied').toBe('');
    expect(sheetPart('mr-sheet-prose').textContent, 'prose emptied').toBe('');
    expect(sheetRows(), 'rows emptied').toHaveLength(0);
    expect(sheet.textContent, 'nothing the sheet named stays in the document').toBe('');
    expect(isHidden(encEl()), 'the list is shown').toBe(false);
    expect(activeRow(), 'the same entry is active').toBe('essence');
    expect(rowEls()).toHaveLength(16);

    view.paint(paintOf('encyclopedia', 'essence', 'essence'));
    expect(isHidden(theSheet()), 'reopened').toBe(false);
    expect(sheetPart('mr-sheet-title').textContent).toBe(term('essence'));
  });

  it('UIF14.5 focus: with focus in the frame, opening a detail moves it into the sheet; closing it returns focus into the overlay and not inside the hidden sheet', async () => {
    // WRONG IMPL KILLED: focus left on the list behind a modal (a screen reader keeps reading the
    // list while a dialog is up); focus left on a sheet row that was just emptied and hidden
    // (focus drops to <body>, outside the dialog's trap); a focus move on a repaint that did not
    // change the phase (a held key would yank focus every frame).
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.show();
    view.paint(paintOf('encyclopedia'));
    await flushMacrotask();
    expect(
      overlayEl().contains(document.activeElement),
      'precondition: focus is in the frame',
    ).toBe(true);

    view.paint(paintOf('encyclopedia', undefined, 'party'));
    expect(
      theSheet().contains(document.activeElement),
      'after the open, focus is inside the sheet',
    ).toBe(true);

    // A repaint of the same phase leaves focus where it is.
    const focused = document.activeElement;
    view.paint(paintOf('encyclopedia', undefined, 'party'));
    expect(document.activeElement, 'an identical repaint does not move focus').toBe(focused);

    view.paint(paintOf('encyclopedia'));
    expect(
      overlayEl().contains(document.activeElement),
      'after the close, focus is inside the overlay',
    ).toBe(true);
    expect(theSheet().contains(document.activeElement), 'and not inside the hidden sheet').toBe(
      false,
    );
    expect(document.activeElement, 'not dropped to <body>').not.toBe(document.body);
  });
});

// ---------------------------------------------------------------------------
// UIF14.6: announcements.
// ---------------------------------------------------------------------------

describe('HelpView: announcements through the live region handler (uif-14, UIF14.6)', () => {
  beforeEach(() => {
    mountHelpOverlay();
  });
  afterEach(() => {
    teardown();
  });

  it('UIF14.6 announce is called once with the new tab`s title on a tab change and once with the entry`s term on a detail open, and never on the first paint after show(), an identical repaint, a cursor move, a detail close, or the first paint of a reopen', () => {
    // WRONG IMPL KILLED: announcing on every paint (a held D-pad would spam the live region); no
    // announcement on a tab change (R-ctl-14-HELPA11Y stays open); announcing the key or the
    // definition instead of the term; announcing the opening tab on show (the dialog name already
    // says it); announcing a detail close; a tab remembered ACROSS opens (the first paint after a
    // reopen would then announce a "change"); a cursor move that announces.
    const announce = vi.fn();
    const view = new HelpView({ announce });
    view.render(SAMPLE_VM);
    view.show();

    view.paint(paintOf('intro'));
    expect(announce, 'the first paint after show() says nothing').not.toHaveBeenCalled();
    view.paint(paintOf('intro'));
    expect(announce, 'an identical repaint says nothing').not.toHaveBeenCalled();

    view.paint(paintOf('encyclopedia'));
    expect(announce.mock.calls, 'RB: exactly one call, the tab title').toEqual([
      ['Fixture encyclopedia'],
    ]);
    view.paint(paintOf('encyclopedia'));
    view.paint(paintOf('encyclopedia', 'storage'));
    view.paint(paintOf('encyclopedia', 'bait'));
    expect(announce.mock.calls, 'a repaint and cursor moves say nothing').toHaveLength(1);

    view.paint(paintOf('encyclopedia', 'bait', 'bait'));
    expect(announce.mock.calls, 'A: exactly one more call, the entry`s term').toEqual([
      ['Fixture encyclopedia'],
      [term('bait')],
    ]);
    view.paint(paintOf('encyclopedia', 'bait', 'bait'));
    expect(announce.mock.calls, 'an identical detail repaint says nothing').toHaveLength(2);

    view.paint(paintOf('encyclopedia', 'bait'));
    expect(announce.mock.calls, 'closing the detail says nothing').toHaveLength(2);

    view.paint(paintOf('intro'));
    expect(announce.mock.calls.at(-1), 'LB: the Introduction title').toEqual(['Fixture intro']);
    expect(announce.mock.calls, 'three announcements in all').toHaveLength(3);

    // A reopen: the first paint says nothing even though the tab differs from the last one seen.
    view.hide();
    view.show();
    view.paint(paintOf('encyclopedia'));
    expect(announce.mock.calls, 'the first paint after a reopen says nothing').toHaveLength(3);
    view.paint(paintOf('intro'));
    expect(announce.mock.calls.at(-1), 'but the next change does').toEqual(['Fixture intro']);
    expect(announce.mock.calls, 'four announcements in all').toHaveLength(4);
  });

  it('UIF14.6 opening a second, different detail announces the second term once; the announced strings are the vm`s own text, not catalog ids', () => {
    // WRONG IMPL KILLED: an edge detector that compares only "was a detail open" (the second open
    // would stay silent); announcing a catalog id; a double announcement per open.
    const announce = vi.fn();
    const view = new HelpView({ announce });
    view.render(SAMPLE_VM);
    view.show();
    view.paint(paintOf('encyclopedia'));
    announce.mockClear();
    view.paint(paintOf('encyclopedia', 'party', 'party'));
    view.paint(paintOf('encyclopedia', 'party'));
    view.paint(paintOf('encyclopedia', 'ranked', 'ranked'));
    expect(announce.mock.calls).toEqual([[term('party')], [term('ranked')]]);
  });

  it('a view built without handlers paints tab changes and details without throwing', () => {
    // WRONG IMPL KILLED: an unconditional `this.#handlers.announce(...)` (the zero-arg construction
    // the overlayA11yWiring rig does would crash on the first RB).
    const view = new HelpView();
    view.render(SAMPLE_VM);
    view.show();
    expect(() => {
      view.paint(paintOf('intro'));
      view.paint(paintOf('encyclopedia'));
      view.paint(paintOf('encyclopedia', 'party', 'party'));
      view.paint(paintOf('encyclopedia', 'party'));
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Overlay a11y wiring on the show()/hide() edge (m23-s3, ADDITIVE; kept)
// ---------------------------------------------------------------------------

const S3_ID: OverlayId = 'helpView';
const S3_META = OVERLAY_A11Y[S3_ID];

function s3OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

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
    expect(view.visible, 'V4: the shell must start hidden, so the first show() IS an edge').toBe(
      false,
    );
    view.show();
    expect(overlay.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S3_META.role);
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(
      overlay.getAttribute('aria-label'),
      'THE tooth: aria-label is absent from every shell, so only a real open can produce it',
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
    expect(document.activeElement, 'precondition: the open moved focus INTO the overlay').not.toBe(
      outside,
    );
    view.hide();
    expect(
      overlay.getAttribute('role'),
      'a display:none node must not claim to be a dialog',
    ).toBeNull();
    expect(overlay.getAttribute('aria-modal')).toBeNull();
    expect(overlay.getAttribute('aria-label')).toBeNull();
    expect(document.activeElement, 'focus must return to the pre-overlay element').toBe(outside);
  });

  it('S3-helpView-REPEAT-NO-REOPEN BITES: show() on an ALREADY-visible overlay neither re-opens nor yanks focus back', async () => {
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
    vi.clearAllMocks();
    view.show();
    view.hide();
    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// qf-4 / R-qf-4-HELPSCREENUL, re-pointed (uif-14): the static Encyclopedia list keeps its marker-free
// class through every paint. INTENTIONAL CHANGE: the qf-11 pins on the runtime `#help-screen` list and
// on the strip being a direct child of the frame root are RETIRED (that list is gone; the strip now
// lives in the kit's TabBar root, whose layout is uif-3's).
// ---------------------------------------------------------------------------

const QF11_STYLES_CSS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
  'utf8',
);

describe('HelpView: the Encyclopedia list has no list markers (qf-4, re-pointed by uif-14)', () => {
  let sheet: HTMLStyleElement | null = null;
  beforeEach(() => {
    mountHelpOverlay();
    sheet = document.createElement('style');
    sheet.textContent = QF11_STYLES_CSS;
    document.head.appendChild(sheet);
  });
  afterEach(() => {
    sheet?.remove();
    sheet = null;
    teardown();
  });

  it('#help-encyclopedia keeps mr-nav-list, no inline style and a computed list-style none through construction, render, every paint, a detail open and close, a hide / show and a second construction', () => {
    // WRONG IMPL KILLED: a paint that rewrites the list's className (the UA draws a disc per row, and
    // the inverted active colour hides the one on the selected row); a marker removed by an inline
    // style; a class lost by replacing the element; a class with no rule behind it.
    const view = new HelpView();
    const list = encEl();
    const swept = (when: string): void => {
      expect(encEl(), `${when}: still the same list`).toBe(list);
      expect(list.classList.contains('mr-nav-list'), `${when}: carries mr-nav-list`).toBe(true);
      expect(list.hasAttribute('style'), `${when}: no inline style`).toBe(false);
      const probe = list.cloneNode(false) as HTMLElement;
      (list.parentElement ?? document.body).appendChild(probe);
      const listStyle = getComputedStyle(probe).listStyle;
      probe.remove();
      expect(listStyle, `${when}: computes list-style none`).toBe('none');
    };
    swept('constructed');
    view.render(SAMPLE_VM);
    swept('rendered');
    view.paint(paintOf('intro'));
    swept('painted on Introduction');
    view.show();
    view.paint(paintOf('encyclopedia'));
    swept('painted on the Encyclopedia');
    view.paint(paintOf('encyclopedia', undefined, 'party'));
    swept('with a detail open');
    view.paint(paintOf('encyclopedia'));
    swept('after the detail closed');
    view.hide();
    view.show();
    swept('after hide and show');
    new HelpView();
    swept('after a second construction over the same shell');
  });
});
