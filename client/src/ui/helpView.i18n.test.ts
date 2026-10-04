// @vitest-environment happy-dom
// ui/helpView.i18n.test.ts — Help and the catalog: m24-s5 HV-01/02/03 (the title) plus ctl-14
// (CTL14.1) CTL14-1-FR (every other string).
//
// SOURCE OF TRUTH: memory/projects/monster-realm-m24-s5-plan.md (helpView.ts constructor resolves
// #help-title into a readonly #titleEl and throws if missing; show() writes chrome.help.title after
// the wasVisible read), plan-revisions.md D4 (unconditional per-open-door resolve),
// docs/adr/0261-i18n-migration-batch-c.md; memory/projects/monster-realm-ctl-14-plan.md.
//
// LEGACY BEHAVIOUR REPLACED (anti-vacuity, CTL14-1-FR): only the overlay HEADING went through the
// catalog. The control and goal copy was hard-coded English in helpModel.ts ("Toggle this help
// overlay", "Open the Quest log", "Recruit a wild monster"...), rendered raw, so under `fr` Help
// still showed English CONTROLS rows. The view model is now generated from the catalog (the model's
// own cases are helpModel.test.ts); this file proves the RENDERED overlay under `fr`.
//
// INTENTIONAL CHANGE (ctl-14), the three m24s5 cases kept and re-pointed at the tab-shaped model:
//   - HV-01 / HV-02: the fixture is `{ tabs, note }` (was `{ controls, goals }`); the row text is
//     keys + action rather than "key — action"; the sentinel allow-list also admits a `help.` id
//     (the model's catalog ids are resolved BEFORE the view, but a view that labels its strip through
//     the catalog must not be failed for it). Everything else (the title resolved on EVERY show,
//     fixture copy never handed to a resolver, no raw English title outside a sentinel) is as it was.
//   - HV-03: the sink-count FLOOR is 1 (was 4): the retired view had four hand-written sinks (the
//     title, a control line, a goal line, ...) and the new one funnels every row through one
//     generic builder, so a floor of four pins an implementation shape, not the scanner's liveness.
//     The `failing: []`, unterminated and masking teeth are unchanged.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the
// plan/plan-revisions/ADR-0261 only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../test-util/stripComments';
import { DEFAULT_BINDINGS } from '../input/bindings';
import { resetLearnedKeys } from '../input/glyphs';
import { WORLD_STACK } from './contextStack';
import { type ControlsRow, controlsRows, rowLabel } from './controlsModel';
import { buildHelpViewModel, HELP_TABS, type HelpViewModel } from './helpModel';
import { HelpView } from './helpView';
import { hintBar } from './hintBarModel';
import { CATALOG_EN } from './i18n/catalog.en';
import { CATALOG_FR } from './i18n/catalog.fr';
import { scanSource } from './i18n/hardcodedStrings';
import { t as i18nT, setLocale } from './i18n/resolver';
import { navFocus, navInit } from './nav';
import { closeOverlayA11y } from './overlayA11y';
import { OVERLAY_IDS } from './overlayRegistry';
import { HELP_LAYOUT } from './screens/helpScreen';

// The m24s5 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the DOM byte-identity assertions below still work.
vi.mock('./i18n/resolver', { spy: true });

/** One REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0). */
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
  setLocale('en');
  resetLearnedKeys();
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
});

// Mirrors the NEW index.html (D7): #help-title ships EMPTY, painted by show() instead of the
// literal 'Controls &amp; Goals' text.
function mount(): { overlay: HTMLElement; controlsEl: HTMLElement; goalsEl: HTMLElement } {
  document.body.innerHTML = `
    <div id="help-overlay" role="dialog" aria-modal="true" style="display:none">
      <div id="help-title" tabindex="-1"></div>
      <ul id="help-controls"></ul>
      <ul id="help-goals"></ul>
    </div>
  `;
  return {
    overlay: document.getElementById('help-overlay') as HTMLElement,
    controlsEl: document.getElementById('help-controls') as HTMLElement,
    goalsEl: document.getElementById('help-goals') as HTMLElement,
  };
}

/** A tab-shaped model of fixture copy that avoids "Controls" / "Goals". */
const FIXTURE_VM: HelpViewModel = {
  tabs: [
    {
      tab: 'screen',
      title: 'Fixture one',
      rows: [{ keys: ['Esc'], action: 'Open the fixture menu' }],
    },
    { tab: 'controls', title: 'Fixture two', rows: [{ keys: ['Z'], action: 'Zoom the camera' }] },
    {
      tab: 'goals',
      title: 'Fixture three',
      rows: [{ keys: [], action: 'Finish the tutorial trail' }],
    },
  ],
  note: 'Fixture note about keys',
};

// ---------------------------------------------------------------------------
// m24s5 SplitSentinels / WalkSubtree / AssertNoRosterWord trio.
// ---------------------------------------------------------------------------

const M24S5_HV_PLAIN_KEYS = new Set(['chrome.help.title']);
/** ctl-14: a catalog id of the generated Help (`help.tab.*`, `help.goal.*`, `help.note.*`). */
const isHelpCatalogId = (content: string): boolean => /^help\.[A-Za-z.]+$/.test(content);

function m24s5HvSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
  let out = '';
  const unexpectedSpans: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('«', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = text.indexOf('»', open + 1);
    if (close === -1) {
      out += text.slice(open);
      break;
    }
    const span = text.slice(open, close + 1);
    const content = text.slice(open + 1, close);
    if (M24S5_HV_PLAIN_KEYS.has(content) || isHelpCatalogId(content)) {
      // Elide — a real, correctly-formed sentinel.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

function m24s5HvWalkSubtree(root: HTMLElement): string[] {
  const texts: string[] = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop() as Element;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) texts.push(node.textContent ?? '');
    }
    for (const child of Array.from(el.children)) stack.push(child);
  }
  return texts;
}

const M24S5_HV_ROSTER = ['Controls & Goals'];

function m24s5HvAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = m24s5HvSplitSentinels(texts.join('\n'));
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel`,
  ).toEqual([]);
  for (const word of M24S5_HV_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s5 (ADR-0261): helpView.ts routes chrome.help.title through t() in show()', () => {
  it('m24s5 HV-01: chrome.help.title resolves in show(), an unconditional repeat show() re-requests it, and row copy stays raw and is never passed to a resolver', () => {
    const { overlay } = mount();
    const view = new HelpView();
    const titleEl = overlay.querySelector('#help-title') as HTMLElement;

    expect(titleEl.textContent, '#help-title ships empty pre-show (D7)').toBe('');
    expect(i18nT).not.toHaveBeenCalledWith('chrome.help.title');

    view.show();
    expect(i18nT).toHaveBeenCalledWith('chrome.help.title');
    expect(titleEl.textContent).toBe('Controls & Goals');

    // RT2: a repeat show() on an already-open overlay re-resolves the title.
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(
      i18nT,
      'm24s5 HV-01 RT2: repeat show() must re-resolve chrome.help.title (kills a ' +
        '!wasVisible-gated write)',
    ).toHaveBeenCalledWith('chrome.help.title');

    // Fixture row copy deliberately avoids "Controls"/"Goals".
    view.render(FIXTURE_VM);
    view.paint({ layout: HELP_LAYOUT, nav: navInit(HELP_LAYOUT) });
    for (const copy of [
      'Open the fixture menu',
      'Zoom the camera',
      'Finish the tutorial trail',
      'Fixture note about keys',
      'Fixture two',
    ]) {
      expect(
        i18nT,
        `row copy must never be passed to a resolver: ${copy}`,
      ).not.toHaveBeenCalledWith(copy);
    }
    const controlLi = (overlay.querySelector('#help-controls') as HTMLElement).querySelector('li');
    expect(controlLi?.textContent, 'the controls row is the raw fixture copy').toContain(
      'Zoom the camera',
    );
    const goalLi = (overlay.querySelector('#help-goals') as HTMLElement).querySelector('li');
    expect(goalLi?.textContent, 'a keyless goal row is exactly its copy').toBe(
      'Finish the tutorial trail',
    );
  });

  it('m24s5 HV-02: under «key» sentinel chrome.help.title shows resolver output, and never the raw English title outside a sentinel', () => {
    const { overlay } = mount();
    // Constructed BEFORE the sentinel mockImplementation.
    const view = new HelpView();

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);

      view.show();
      view.render(FIXTURE_VM);
      view.paint({ layout: HELP_LAYOUT, nav: navInit(HELP_LAYOUT) });

      const texts = m24s5HvWalkSubtree(overlay);
      m24s5HvAssertNoRosterWord(texts, 'after show+render+paint');
      const joined = texts.join('\n');
      expect(joined).toContain('«chrome.help.title»');
      expect(joined, 'row copy stays raw').toContain('Zoom the camera');
      expect(joined, 'goal copy stays raw').toContain('Finish the tutorial trail');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s5 (ADR-0261): helpView.ts scan — zero failing sinks', () => {
  it('m24s5 HV-03: scanSource(stripComments(helpView.ts)) has zero failing sinks, a >=1 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpView.ts'),
      'utf8',
    );
    const result = scanSource(stripComments(src));

    expect(
      result.failing.map((s) => `${s.kind}@L${s.line}: ${s.failingSegments.join(' | ')}`),
      'every sink must route through t()/tf() — any surviving English segment is listed above',
    ).toEqual([]);
    expect(
      result.sinks.length,
      'SINK_FLOOR idiom: a floor, never an exact count',
    ).toBeGreaterThanOrEqual(1);
    expect(
      result.unterminated,
      'the literal mask must not end inside an unterminated literal',
    ).toBe(false);
    expect(result.maskedSinkTokens, 'no parity-flip mask desync').toBe(0);
    for (const sink of result.sinks) {
      expect(sink.truncated, `${sink.kind}@L${sink.line} must not be truncated`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// ctl-14 (CTL14.1): the rendered Help under `fr`.
// ---------------------------------------------------------------------------

const asText = (message: unknown): string => {
  if (typeof message !== 'string') throw new Error('expected a plain catalog message');
  return message;
};

describe('Help under fr (ctl-14, CTL14.1)', () => {
  it('CTL14-1-FR: under fr the rendered Help shows the fr catalog for the tab labels, every This-screen verb, every All-controls action, the note and the goals, and none of the English strings it showed before (the old CONTROLS rows included)', () => {
    // LEGACY REPLACED (the Red): the CONTROLS / GOALS rows were hard-coded English literals, so a
    // French player read "Toggle this help overlay" and "Recruit a wild monster".
    // WRONG IMPL KILLED: a model that keeps the English hand list beside the generated one (the old
    // strings would still be in the DOM: the explicit roster below); a tab label, goal or note that
    // is a literal (it stays English under fr); labels / actions resolved ONCE at module load or
    // at boot (an en capture would survive setLocale('fr') here, which is exactly the order below:
    // the English labels are read first, then the locale is switched); a view that renders only
    // some tabs; a row action that is the fr catalog value for the WRONG id; and an fr catalog
    // entry copy-pasted from the English one.
    const rows: ControlsRow[] = [...controlsRows('buttons'), ...controlsRows('shortcuts')];

    // English first (the capture a boot-time implementation would be stuck with).
    const enActions = rows.map((row) => rowLabel(row));
    const enTitles = [
      CATALOG_EN['help.tab.screen'],
      CATALOG_EN['help.tab.controls'],
      CATALOG_EN['help.tab.goals'],
    ].map(asText);
    const enGoals = [
      CATALOG_EN['help.goal.recruit'],
      CATALOG_EN['help.goal.battle'],
      CATALOG_EN['help.goal.trade'],
    ].map(asText);
    const enNote = asText(CATALOG_EN['help.note.keysVsButtons']);

    setLocale('fr');
    const frTitles = [
      CATALOG_FR['help.tab.screen'],
      CATALOG_FR['help.tab.controls'],
      CATALOG_FR['help.tab.goals'],
    ].map(asText);
    const frGoals = [
      CATALOG_FR['help.goal.recruit'],
      CATALOG_FR['help.goal.battle'],
      CATALOG_FR['help.goal.trade'],
    ].map(asText);
    const frNote = asText(CATALOG_FR['help.note.keysVsButtons']);
    const frActions = rows.map((row) => rowLabel(row));

    // The fixtures are meaningful: the fr entries really are not the English ones.
    expect(frTitles, 'fr titles are not the English ones').not.toEqual(enTitles);
    for (const [i, title] of frTitles.entries()) {
      expect(title, `fr title ${i} differs from en`).not.toBe(enTitles[i]);
    }
    for (const [i, goal] of frGoals.entries()) {
      expect(goal, `fr goal ${i} differs from en`).not.toBe(enGoals[i]);
    }
    expect(frNote, 'fr note differs from en').not.toBe(enNote);
    expect(
      frActions.filter((a, i) => a !== enActions[i]).length,
      'ANTI-VACUITY: most control labels differ between en and fr',
    ).toBeGreaterThan(rows.length / 2);

    // The world context's chips, as the shell builds them under fr.
    const chips = hintBar(WORLD_STACK, DEFAULT_BINDINGS, []);
    expect(chips.length, 'ANTI-VACUITY: the world has chips').toBeGreaterThanOrEqual(2);
    const frVerbs = chips.map((c) => c.verb);

    const { overlay, controlsEl, goalsEl } = mount();
    const view = new HelpView();
    view.render(buildHelpViewModel(chips, DEFAULT_BINDINGS));
    view.show();

    const strip = (): string[] =>
      Array.from(overlay.querySelectorAll('[role="tablist"] [role="tab"]')).map(
        (el) => el.textContent ?? '',
      );
    const hidden = (el: Element): boolean => el.closest('[hidden]') !== null;
    const textOf = (el: Element): string => el.textContent ?? '';

    for (const tab of HELP_TABS) {
      view.paint({
        layout: HELP_LAYOUT,
        nav: navFocus(HELP_LAYOUT, navInit(HELP_LAYOUT), { tab }),
      });
      expect(strip(), `${tab}: the tab labels are the fr catalog`).toEqual(frTitles);
    }

    // The three panels hold fr copy (checked by content, whichever tab is showing).
    const screenPanel = overlay.querySelector('#help-screen') as HTMLElement;
    expect(screenPanel, 'the This-screen panel exists').not.toBeNull();
    const screenRows = Array.from(screenPanel.querySelectorAll('li')).map(textOf);
    expect(screenRows.length, 'one row per chip').toBe(chips.length);
    for (const [i, verb] of frVerbs.entries()) {
      expect(screenRows[i], `This screen row ${i} carries the fr verb`).toContain(verb);
    }
    const controlRows = Array.from(controlsEl.querySelectorAll('li')).map(textOf);
    expect(controlRows.length, 'every button and shortcut has a row').toBe(rows.length);
    for (const [i, action] of frActions.entries()) {
      expect(controlRows[i], `All controls row ${i} carries the fr label`).toContain(action);
    }
    const goalRows = Array.from(goalsEl.querySelectorAll('li')).map(textOf);
    expect(goalRows, 'Goals are exactly the fr goals, nothing else on the row').toEqual(frGoals);

    // The note shows on All controls, in fr.
    view.paint({
      layout: HELP_LAYOUT,
      nav: navFocus(HELP_LAYOUT, navInit(HELP_LAYOUT), { tab: 'controls' }),
    });
    const visibleNotes = Array.from(overlay.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && textOf(el).includes(frNote) && !hidden(el),
    );
    expect(visibleNotes.length, 'the fr note is on screen on All controls').toBeGreaterThanOrEqual(
      1,
    );

    // NO English: the whole overlay, every panel, hidden or not.
    const everything = textOf(overlay);
    const OLD_ENGLISH = [
      'Toggle this help overlay',
      'Open the main menu',
      'Move around the world',
      'Close the open overlay',
      'Interact with what you face',
      'Show every action for what you face',
      'Open the monster Box',
      'Open the Quest log',
      'Answer a PvP challenge',
      'Open the ranked Leaderboard',
      'Rename your profile',
      'Open account & sign-in',
      'Download a bug-report bundle',
      'Recruit a wild monster',
      'Win your first battle',
      'Try trading with another tester',
      'Controls & Goals',
    ];
    for (const english of OLD_ENGLISH) {
      expect(everything.includes(english), `no old English row: ${english}`).toBe(false);
    }
    // And none of the CURRENT English catalog strings that fr translates.
    for (const [i, en] of enActions.entries()) {
      // A short English word ("Up", "Bag") can sit inside an fr word by chance: only the labels
      // long enough to be unambiguous are searched for.
      if (en === frActions[i] || en.length < 6) continue;
      expect(
        controlRows.some((row) => row.includes(en)),
        `the English label "${en}" does not survive in fr`,
      ).toBe(false);
    }
    for (const en of [...enTitles, ...enGoals, enNote]) {
      expect(everything.includes(en), `the English "${en}" does not survive in fr`).toBe(false);
    }
  });
});
