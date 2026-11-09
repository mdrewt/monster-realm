// @vitest-environment happy-dom
// ui/helpView.i18n.test.ts — Help and the catalog: m24-s5 HV-01/02 (the title) plus uif-14
// (UIF14.4) UIF14-FR (every other string, rendered, under fr).
//
// SOURCE OF TRUTH: memory/projects/monster-realm-m24-s5-plan.md (helpView.ts resolves #help-title into
// a readonly #titleEl and throws if missing; show() writes chrome.help.title after the wasVisible
// read), plan-revisions.md D4 (unconditional per-open-door resolve), docs/adr/0261-i18n-migration-
// batch-c.md; memory/projects/monster-realm-uif-14-plan.md.
//
// INTENTIONAL CHANGE (uif-14): the ctl-14 fr pin (CTL14-1-FR: the This-screen verbs, every All-controls
// action, the note and the goals) is RETIRED with the tabs it covered and replaced by UIF14-FR below,
// which proves the rendered Introduction, Encyclopedia list and detail sheet under `fr`. The two
// m24s5 cases are kept and re-pointed at the new view model: the fixture is `{ tabs, intro, entries }`
// (was `{ tabs, note }`) and the sentinel allow-list also admits the `kit.` ids the sheet's Back row
// resolves (the model's own catalog ids are resolved BEFORE the view).
//
// Do NOT edit these tests to match a buggy implementation — correct them from the
// plan/plan-revisions/ADR-0261 only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHelpViewModel, ENTRY_KEYS, type HelpViewModel } from './helpModel';
import { HelpView } from './helpView';
import { CATALOG_EN } from './i18n/catalog.en';
import { CATALOG_FR } from './i18n/catalog.fr';
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
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
});

// Mirrors the NEW index.html: #help-title ships EMPTY, painted by show(); the two panels are static.
function mount(): HTMLElement {
  document.body.innerHTML = `
    <div id="help-overlay" role="dialog" aria-modal="true" style="display:none">
      <div id="help-title" tabindex="-1"></div>
      <div id="help-intro"></div>
      <ul id="help-encyclopedia" class="mr-nav-list"></ul>
    </div>
  `;
  return document.getElementById('help-overlay') as HTMLElement;
}

const paintOf = (tab: string, detail: (typeof ENTRY_KEYS)[number] | null = null) => ({
  layout: HELP_LAYOUT,
  nav: navFocus(HELP_LAYOUT, navInit(HELP_LAYOUT), { tab }),
  detail,
});

/** A model of fixture copy that avoids "Controls" / "Goals". */
const FIXTURE_VM: HelpViewModel = {
  tabs: [
    { tab: 'intro', title: 'Fixture one' },
    { tab: 'encyclopedia', title: 'Fixture two' },
  ],
  intro: {
    paragraphs: ['Fixture opening line.', 'Fixture closing line.'],
    report: 'Fixture report row',
  },
  entries: ENTRY_KEYS.map((key, i) => ({
    key,
    term: `Fixture term ${key}`,
    definition: `Fixture definition ${key}.`,
    related: [ENTRY_KEYS[(i + 1) % ENTRY_KEYS.length] as (typeof ENTRY_KEYS)[number]],
  })),
};

// ---------------------------------------------------------------------------
// m24s5 SplitSentinels / WalkSubtree / AssertNoRosterWord trio.
// ---------------------------------------------------------------------------

const M24S5_HV_PLAIN_KEYS = new Set(['chrome.help.title']);
/** A catalog id of the Help (`help.*`) or of the kit the sheet's rows resolve (`kit.*`). */
const isHelpCatalogId = (content: string): boolean => /^(help|kit)\.[A-Za-z.]+$/.test(content);

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

const M24S5_HV_ROSTER = ['How to Play'];

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
  it('m24s5 HV-01: chrome.help.title resolves in show(), an unconditional repeat show() re-requests it, and the vm copy stays raw and is never passed to a resolver', () => {
    const overlay = mount();
    const view = new HelpView();
    const titleEl = overlay.querySelector('#help-title') as HTMLElement;

    expect(titleEl.textContent, '#help-title ships empty pre-show (D7)').toBe('');
    expect(i18nT).not.toHaveBeenCalledWith('chrome.help.title');

    view.show();
    expect(i18nT).toHaveBeenCalledWith('chrome.help.title');
    expect(titleEl.textContent).toBe('How to Play');

    // RT2: a repeat show() on an already-open overlay re-resolves the title.
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(
      i18nT,
      'm24s5 HV-01 RT2: repeat show() must re-resolve chrome.help.title (kills a ' +
        '!wasVisible-gated write)',
    ).toHaveBeenCalledWith('chrome.help.title');

    // Fixture copy deliberately avoids "Controls"/"Goals".
    view.render(FIXTURE_VM);
    view.paint(paintOf('intro'));
    view.paint(paintOf('encyclopedia'));
    view.paint(paintOf('encyclopedia', 'party'));
    for (const copy of [
      'Fixture opening line.',
      'Fixture closing line.',
      'Fixture two',
      'Fixture term party',
      'Fixture definition party.',
    ]) {
      expect(i18nT, `vm copy must never be passed to a resolver: ${copy}`).not.toHaveBeenCalledWith(
        copy,
      );
    }
    const paragraphs = Array.from(overlay.querySelectorAll('#help-intro p')).map(
      (p) => p.textContent,
    );
    expect(paragraphs, 'the paragraphs are the raw fixture copy').toEqual([
      'Fixture opening line.',
      'Fixture closing line.',
    ]);
    const firstRow = overlay.querySelector('#help-encyclopedia [data-nav-key]');
    expect(firstRow?.textContent, 'a list row is the raw term').toBe('Fixture term party');
  });

  it('m24s5 HV-02: under «key» sentinel chrome.help.title shows resolver output, and never the raw English title outside a sentinel', () => {
    const overlay = mount();
    // Constructed BEFORE the sentinel mockImplementation.
    const view = new HelpView();

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);

      view.show();
      view.render(FIXTURE_VM);
      view.paint(paintOf('intro'));
      view.paint(paintOf('encyclopedia'));
      view.paint(paintOf('encyclopedia', 'party'));

      const texts = m24s5HvWalkSubtree(overlay);
      m24s5HvAssertNoRosterWord(texts, 'after show+render+paint');
      const joined = texts.join('\n');
      expect(joined).toContain('«chrome.help.title»');
      expect(joined, 'paragraph copy stays raw').toContain('Fixture opening line.');
      expect(joined, 'term copy stays raw').toContain('Fixture term party');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('How to Play');
  });

  it('UIF15A.2 the help frame title reads How to Play in en and Comment jouer in fr, re-resolved on a repeat show(), and the overlay accessible label reads How to Play (the a11y catalog is en-only)', () => {
    // WRONG IMPL KILLED: a title left on "Controls & Goals" in either locale; an fr title that is the
    // English bytes; a title frozen at the first show(); an accessible label left on the old name.
    const overlay = mount();
    const view = new HelpView();
    const titleEl = overlay.querySelector('#help-title') as HTMLElement;

    setLocale('en');
    view.show();
    expect(titleEl.textContent, 'en title').toBe('How to Play');
    expect(overlay.getAttribute('aria-label'), 'the accessible label (en-only catalog)').toBe(
      'How to Play',
    );

    setLocale('fr');
    view.show();
    expect(titleEl.textContent, 'fr title').toBe('Comment jouer');
    expect(CATALOG_FR['chrome.help.title'], 'the fr catalog value').toBe('Comment jouer');
    expect(CATALOG_EN['chrome.help.title'], 'the en catalog value').toBe('How to Play');
  });
});

// ---------------------------------------------------------------------------
// uif-14 (UIF14.4): the rendered Help under `fr`.
// ---------------------------------------------------------------------------

const asText = (message: unknown): string => {
  if (typeof message !== 'string') throw new Error('expected a plain catalog message');
  return message;
};

/** The two fixed halves of a locale's `help.detail.related` template (the text around {terms}). */
function relatedFrame(catalog: object): { before: string; after: string } {
  const fn = (catalog as Record<string, unknown>)['help.detail.related'];
  if (typeof fn !== 'function') throw new Error('help.detail.related must be a template closure');
  const probe = 'ZZPROBEZZ';
  const text = (fn as (p: { terms: string }) => string)({ terms: probe });
  const at = text.indexOf(probe);
  expect(at, 'the template carries {terms} verbatim').toBeGreaterThanOrEqual(0);
  return { before: text.slice(0, at).trim(), after: text.slice(at + probe.length).trim() };
}

describe('Help under fr (uif-14, UIF14.4)', () => {
  it('UIF14B.1 under fr the rendered Report a problem row reads the fr catalog word, built after a construction under en, and the English label is not in the overlay', () => {
    // WRONG IMPL KILLED: a row label hard-coded or resolved at construction (stays English under fr);
    // an fr catalog entry copy-pasted from English.
    const overlay = mount();
    const view = new HelpView();
    setLocale('fr');
    view.render(buildHelpViewModel());
    view.show();
    view.paint(paintOf('intro'));
    const frLabel = asText(CATALOG_FR['help.intro.report' as never]);
    const enLabel = asText(CATALOG_EN['help.intro.report' as never]);
    expect(frLabel).not.toBe(enLabel);
    expect(
      Array.from(overlay.querySelectorAll('#help-intro [data-nav-key="report"]')).map(
        (r) => r.textContent,
      ),
    ).toEqual([frLabel]);
    expect(overlay.textContent ?? '').not.toContain(enLabel);
  });

  it('UIF14.4 UIF14-FR: under fr the rendered Help shows the fr catalog for the tab labels, both Introduction paragraphs, every Encyclopedia row, and an opened entry`s heading, definition, related terms, related-line frame and Back row, and none of the English strings', () => {
    // LEGACY REPLACED: the This-screen / All-controls / Goals copy of CTL14-1-FR.
    // WRONG IMPL KILLED: a view that keeps English literals for the sheet`s Back row or the "Related"
    // line (they stay English under fr); a Back row or frame resolved ONCE at construction (the view
    // below is built under en, then the locale is switched); a model that keeps English copy beside
    // the catalog; a view that renders only some tabs; an fr catalog entry copy-pasted from English.
    const enBack = asText(CATALOG_EN['kit.sheet.back']);
    const enFrame = relatedFrame(CATALOG_EN);

    // Constructed under English (the capture a boot-time implementation would be stuck with).
    const overlay = mount();
    const view = new HelpView();

    setLocale('fr');
    const frVm = buildHelpViewModel();
    const frBack = asText(CATALOG_FR['kit.sheet.back']);
    const frFrame = relatedFrame(CATALOG_FR);
    expect(frBack, 'fixture: the fr Back is not the English one').not.toBe(enBack);

    view.render(frVm);
    view.show();
    view.paint(paintOf('intro'));

    const strip = (): string[] =>
      Array.from(overlay.querySelectorAll('[role="tablist"] [role="tab"]')).map(
        (el) => el.textContent ?? '',
      );
    expect(strip(), 'the tab labels are the fr catalog').toEqual([
      asText(CATALOG_FR['help.tab.intro']),
      asText(CATALOG_FR['help.tab.encyclopedia']),
    ]);
    expect(
      Array.from(overlay.querySelectorAll('#help-intro p')).map((p) => p.textContent),
      'both paragraphs are the fr copy',
    ).toEqual([asText(CATALOG_FR['help.intro.p1']), asText(CATALOG_FR['help.intro.p2'])]);

    view.paint(paintOf('encyclopedia'));
    const rows = Array.from(overlay.querySelectorAll('#help-encyclopedia [data-nav-key]'));
    expect(
      rows.map((r) => r.textContent),
      'every Encyclopedia row is the fr term',
    ).toEqual(ENTRY_KEYS.map((k) => asText(CATALOG_FR[`help.entry.${k}.term` as never])));

    // An opened entry: heading, definition, related terms, the frame of the related line, Back.
    view.paint(paintOf('encyclopedia', 'evolution'));
    const entry = frVm.entries.find((e) => e.key === 'evolution');
    expect(entry, 'fixture: evolution exists').toBeDefined();
    const sheet = overlay.querySelector('[data-context-sheet]') as HTMLElement;
    expect(sheet.querySelector('.mr-sheet-title')?.textContent, 'fr heading').toBe(
      asText(CATALOG_FR['help.entry.evolution.term']),
    );
    const prose = sheet.querySelector('.mr-sheet-prose')?.textContent ?? '';
    expect(prose, 'the fr definition').toContain(asText(CATALOG_FR['help.entry.evolution.def']));
    for (const r of entry?.related ?? []) {
      expect(prose, `the fr term of the related entry ${r}`).toContain(
        asText(CATALOG_FR[`help.entry.${r}.term` as never]),
      );
    }
    for (const part of [frFrame.before, frFrame.after]) {
      if (part !== '') expect(prose, `the fr related-line frame "${part}"`).toContain(part);
    }
    for (const part of [enFrame.before, enFrame.after]) {
      if (part !== '' && !frFrame.before.includes(part) && !frFrame.after.includes(part)) {
        expect(prose, `not the English related-line frame "${part}"`).not.toContain(part);
      }
    }
    expect(
      Array.from(sheet.querySelectorAll('[data-nav-key]')).map((r) => r.textContent),
      'the Back row is the fr catalog word',
    ).toEqual([frBack]);

    // NO English: the whole overlay, every panel, hidden or not, holds no English entry copy.
    const everything = overlay.textContent ?? '';
    for (const key of ENTRY_KEYS) {
      const enDef = asText(CATALOG_EN[`help.entry.${key}.def` as never]);
      const frDef = asText(CATALOG_FR[`help.entry.${key}.def` as never]);
      if (enDef !== frDef) {
        expect(everything.includes(enDef), `no English definition of ${key}`).toBe(false);
      }
    }
    for (const p of ['help.intro.p1', 'help.intro.p2'] as const) {
      expect(
        everything.includes(asText(CATALOG_EN[p])),
        `the English ${p} does not survive in fr`,
      ).toBe(false);
    }
  });
});
