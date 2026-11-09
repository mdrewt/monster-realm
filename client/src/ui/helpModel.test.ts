// ui/helpModel.test.ts — uif-14 (UIF14.1, UIF14.2, UIF14.4): the Help view model, Introduction +
// Encyclopedia.
//
// Node env, no DOM. `buildHelpViewModel()` takes NO arguments now: nothing in Help is generated from
// the hint bar or the binding table (the hint bar already shows the keys, and the All controls tab is
// gone). Every string is a catalog message, so this file reads the copy THROUGH the catalogs
// (CATALOG_EN / CATALOG_FR) rather than hard-coding prose; only the two tab titles are pinned by
// their literal text.
//
// THE CONTRACT (plan monster-realm-uif-14-plan.md):
//   HELP_TABS    = ['intro', 'encyclopedia']
//   ENTRY_KEYS   = party, storage, recruit, bait, evolution, essence, affinity, status, ap,
//                  initiative, queue, idle, stance, guard, deploy, ranked   (this order)
//   HelpViewModel = {
//     tabs:    [{ tab, title }]                       (HELP_TABS order)
//     intro:   { paragraphs: string[] }               (exactly two)
//     entries: [{ key, term, definition, related }]   (ENTRY_KEYS order; related: EntryKey[])
//   }
//   catalog ids: help.tab.intro, help.tab.encyclopedia, help.intro.p1, help.intro.p2,
//   help.entry.<key>.term, help.entry.<key>.def, help.detail.related ({terms}).
//   RETIRED ids (absent from both catalogs): help.tab.{screen,controls,goals},
//   help.goal.{recruit,battle,trade}, help.note.keysVsButtons.
//
// INTENTIONAL CHANGE (uif-14): the ctl-14 pins (This screen rows mirroring hint chips, the 24 All
// controls rows, the three goals, the keys-vs-buttons note) are RETIRED with the tabs they pinned; the
// generated-controls assertions went with `controlsRows` / `slots` leaving this module.
import { afterEach, describe, expect, it } from 'vitest';
import * as helpModule from './helpModel';
import { buildHelpViewModel, ENTRY_KEYS, HELP_TABS, type HelpViewModel } from './helpModel';
import { CATALOG_EN } from './i18n/catalog.en';
import { CATALOG_FR } from './i18n/catalog.fr';
import { setLocale } from './i18n/resolver';

/** U+00E9 (e acute), built by code point so the French title holds no pasted glyph. */
const E_ACUTE = String.fromCharCode(0x00e9);

const EXPECTED_ENTRY_KEYS = [
  'party',
  'storage',
  'recruit',
  'bait',
  'evolution',
  'essence',
  'affinity',
  'status',
  'ap',
  'initiative',
  'queue',
  'idle',
  'stance',
  'guard',
  'deploy',
  'ranked',
] as const;

const RETIRED_IDS = [
  'help.tab.screen',
  'help.tab.controls',
  'help.tab.goals',
  'help.goal.recruit',
  'help.goal.battle',
  'help.goal.trade',
  'help.note.keysVsButtons',
] as const;

afterEach(() => {
  setLocale('en');
});

/** A plain catalog message, read raw from a locale's catalog (never through the resolver under test). */
function raw(catalog: object, id: string): string {
  const value = (catalog as Record<string, unknown>)[id];
  if (typeof value !== 'string') throw new Error(`catalog id ${id} must be a plain string`);
  return value;
}

const entryOf = (vm: HelpViewModel, key: string): HelpViewModel['entries'][number] => {
  const found = vm.entries.find((e) => e.key === key);
  if (found === undefined) throw new Error(`the view model has no entry ${key}`);
  return found;
};

describe('buildHelpViewModel (uif-14)', () => {
  it('UIF14.1 the tabs are exactly Introduction and Encyclopedia, in that order, with their catalog titles in en and fr, and the roster is two long', () => {
    // WRONG IMPL KILLED: a third tab left behind (All controls, or Goals kept beside the new ones);
    // the tabs in the other order; a tab key that is not the layout's key; a title hard-coded in
    // English (the fr read below would still say Encyclopedia); a title resolved once at module
    // load (the locale switch below); two tabs sharing one title; the retired `screen` / `controls`
    // / `goals` keys surviving in the roster.
    expect([...HELP_TABS], 'the tab roster').toEqual(['intro', 'encyclopedia']);
    const en = buildHelpViewModel();
    expect(
      en.tabs.map((x) => x.tab),
      'the tabs, in order',
    ).toEqual(['intro', 'encyclopedia']);
    expect(
      en.tabs.map((x) => x.title),
      'en titles',
    ).toEqual(['Introduction', 'Encyclopedia']);
    expect(en.tabs.map((x) => x.title)).toEqual([
      raw(CATALOG_EN, 'help.tab.intro'),
      raw(CATALOG_EN, 'help.tab.encyclopedia'),
    ]);
    for (const tab of en.tabs) {
      expect(Object.keys(tab).sort(), `${tab.tab}: a tab is { tab, title } and no rows`).toEqual([
        'tab',
        'title',
      ]);
    }

    setLocale('fr');
    const fr = buildHelpViewModel();
    expect(
      fr.tabs.map((x) => x.title),
      'fr titles',
    ).toEqual(['Introduction', `Encyclop${E_ACUTE}die`]);
    expect(fr.tabs.map((x) => x.title)).toEqual([
      raw(CATALOG_FR, 'help.tab.intro'),
      raw(CATALOG_FR, 'help.tab.encyclopedia'),
    ]);
    expect(fr.tabs[1]?.title, 'the fr Encyclopedia title is a translation').not.toBe(
      en.tabs[1]?.title,
    );
    expect(new Set(fr.tabs.map((x) => x.title)).size, 'two different titles').toBe(2);
  });

  it('UIF14.1 the retired Help ids (help.tab.{screen,controls,goals}, help.goal.*, help.note.keysVsButtons) exist in neither catalog, and the module exports no CONTROLS or GOALS list', () => {
    // WRONG IMPL KILLED: a retired id left behind as a dead key (catalogParity DEAD-KEY) or still
    // read by the model; the old hand lists exported beside the new model (two sources of truth).
    for (const id of RETIRED_IDS) {
      expect(Object.hasOwn(CATALOG_EN, id), `en still has ${id}`).toBe(false);
      expect(Object.hasOwn(CATALOG_FR, id), `fr still has ${id}`).toBe(false);
    }
    expect(Object.keys(helpModule)).not.toContain('CONTROLS');
    expect(Object.keys(helpModule)).not.toContain('GOALS');
    expect(Object.keys(helpModule), 'the new API is exported').toEqual(
      expect.arrayContaining(['buildHelpViewModel', 'HELP_TABS', 'ENTRY_KEYS']),
    );
  });

  it('UIF14.2P the Introduction is exactly two non-empty paragraphs read from help.intro.p1 and help.intro.p2 in en and fr, the fr ones translations', () => {
    // WRONG IMPL KILLED: one paragraph, or three; paragraphs in the wrong order; an empty paragraph
    // (the p1 id read twice); an fr paragraph left as the English copy; a paragraph hard-coded.
    const en = buildHelpViewModel();
    expect(en.intro.paragraphs, 'the two catalog paragraphs, in order').toEqual([
      raw(CATALOG_EN, 'help.intro.p1'),
      raw(CATALOG_EN, 'help.intro.p2'),
    ]);
    expect(Object.keys(en.intro), 'the intro is { paragraphs }').toEqual(['paragraphs']);
    for (const [i, p] of en.intro.paragraphs.entries()) {
      expect(p.trim().length, `en paragraph ${i + 1} is real text`).toBeGreaterThan(0);
    }
    expect(en.intro.paragraphs[0], 'the two paragraphs differ').not.toBe(en.intro.paragraphs[1]);

    setLocale('fr');
    const fr = buildHelpViewModel();
    expect(fr.intro.paragraphs).toEqual([
      raw(CATALOG_FR, 'help.intro.p1'),
      raw(CATALOG_FR, 'help.intro.p2'),
    ]);
    for (const [i, p] of fr.intro.paragraphs.entries()) {
      expect(p.trim().length, `fr paragraph ${i + 1} is real text`).toBeGreaterThan(0);
      expect(p, `fr paragraph ${i + 1} is not the English copy`).not.toBe(en.intro.paragraphs[i]);
    }
  });

  it('UIF14.4 ENTRY_KEYS is the sixteen mechanics in the pinned order, and the model lists exactly those entries in that order, each one { key, term, definition, related }', () => {
    // WRONG IMPL KILLED: a mechanic dropped from the list the spec names (party and Storage, recruit
    // and bait, evolution and essence, affinity, status, tactical AP, initiative, queue, idle
    // clock, stances, Guard, deploy, ranked); entries re-sorted alphabetically or filtered; an extra
    // entry; an entry with a missing field or an extra one.
    expect([...ENTRY_KEYS], 'the roster, exact order').toEqual([...EXPECTED_ENTRY_KEYS]);
    expect(new Set(ENTRY_KEYS).size, 'no duplicate key').toBe(16);
    const vm = buildHelpViewModel();
    expect(
      vm.entries.map((e) => e.key),
      'one entry per key, in order',
    ).toEqual([...EXPECTED_ENTRY_KEYS]);
    for (const entry of vm.entries) {
      expect(Object.keys(entry).sort(), `${entry.key}: the entry shape`).toEqual([
        'definition',
        'key',
        'related',
        'term',
      ]);
    }
    expect(Object.keys(vm).sort(), 'the model is the tabs, the intro and the entries').toEqual([
      'entries',
      'intro',
      'tabs',
    ]);
  });

  it('UIF14.4 every entry reads its term and definition from help.entry.<key>.term / .def in en and fr: non-empty, the fr definition a translation, terms unique within a locale', () => {
    // WRONG IMPL KILLED: a term and a definition swapped, or one id read for two entries (two
    // entries with the same text); an entry whose fr copy is the English copy (a French player reads
    // English); a term resolved once at import; an empty definition; two entries sharing one term
    // (the list would show two identical rows).
    const en = buildHelpViewModel();
    const enTerms: string[] = [];
    for (const key of EXPECTED_ENTRY_KEYS) {
      const entry = entryOf(en, key);
      expect(entry.term, `en ${key}: term`).toBe(raw(CATALOG_EN, `help.entry.${key}.term`));
      expect(entry.definition, `en ${key}: definition`).toBe(
        raw(CATALOG_EN, `help.entry.${key}.def`),
      );
      expect(entry.term.trim().length, `en ${key}: a real term`).toBeGreaterThan(0);
      expect(entry.definition.trim().length, `en ${key}: a real definition`).toBeGreaterThan(0);
      expect(entry.term, `en ${key}: the term is not its definition`).not.toBe(entry.definition);
      enTerms.push(entry.term);
    }
    expect(new Set(enTerms).size, 'en: sixteen different terms').toBe(16);

    setLocale('fr');
    const fr = buildHelpViewModel();
    const frTerms: string[] = [];
    for (const key of EXPECTED_ENTRY_KEYS) {
      const entry = entryOf(fr, key);
      expect(entry.term, `fr ${key}: term`).toBe(raw(CATALOG_FR, `help.entry.${key}.term`));
      expect(entry.definition, `fr ${key}: definition`).toBe(
        raw(CATALOG_FR, `help.entry.${key}.def`),
      );
      expect(entry.term.trim().length, `fr ${key}: a real term`).toBeGreaterThan(0);
      expect(entry.definition.trim().length, `fr ${key}: a real definition`).toBeGreaterThan(0);
      expect(entry.definition, `fr ${key}: not the English definition`).not.toBe(
        entryOf(en, key).definition,
      );
      frTerms.push(entry.term);
    }
    expect(new Set(frTerms).size, 'fr: sixteen different terms').toBe(16);
  });

  it('UIF14.4 `related` is a static graph over valid keys: at least one per entry, never the entry itself, no duplicates, only ENTRY_KEYS members, the same in en and fr', () => {
    // WRONG IMPL KILLED: a related list naming a key that is not an entry (the detail would show a
    // blank term); an entry listing itself; a duplicate (the same term twice in the detail prose);
    // an entry with no related mechanic (the spec's "definition and related mechanics"); a related
    // list that follows the locale (it is structure, not copy).
    const en = buildHelpViewModel();
    setLocale('fr');
    const fr = buildHelpViewModel();
    const valid = new Set<string>(ENTRY_KEYS);
    for (const entry of en.entries) {
      expect(entry.related.length, `${entry.key}: at least one related mechanic`).toBeGreaterThan(
        0,
      );
      expect(entry.related, `${entry.key}: never itself`).not.toContain(entry.key);
      expect(new Set(entry.related).size, `${entry.key}: no duplicate`).toBe(entry.related.length);
      for (const r of entry.related) {
        expect(valid.has(r), `${entry.key}: related ${r} is a real entry`).toBe(true);
      }
      expect(entryOf(fr, entry.key).related, `${entry.key}: the same graph in fr`).toEqual(
        entry.related,
      );
    }
  });

  it('PURE: a fresh object per call (two calls equal but sharing nothing, tampering with one never shows in the next), the call takes no argument, and no field anywhere is a function', () => {
    // WRONG IMPL KILLED: a shared module-level model a caller can poison; content depending on call
    // order; a model that smuggles a callback into a display-only overlay; a builder that still
    // demands the retired (chips, bindings) arguments.
    expect(buildHelpViewModel.length, 'no parameters').toBe(0);
    const a = buildHelpViewModel();
    const b = buildHelpViewModel();
    expect(a, 'same content').toEqual(b);
    expect(a, 'never the same object').not.toBe(b);
    expect(a.entries, 'nor the same entry list').not.toBe(b.entries);
    expect(a.intro.paragraphs, 'nor the same paragraphs').not.toBe(b.intro.paragraphs);
    expect(a.entries[0]?.related, 'nor the same related list').not.toBe(b.entries[0]?.related);
    try {
      (a.entries as unknown[]).length = 0;
      (a.intro.paragraphs as string[]).push('HACK');
      (b.entries[0]?.related as string[]).push('HACK');
    } catch {
      /* a frozen result: the tampering is impossible */
    }
    const c = buildHelpViewModel();
    expect(c.entries.length, 'a later call does not see the tampering').toBe(16);
    expect(c.intro.paragraphs.length).toBe(2);
    expect(c.entries[0]?.related).not.toContain('HACK');

    const seen: unknown[] = [c, c.tabs, c.intro, c.entries];
    for (const e of c.entries) seen.push(e, e.term, e.definition, e.related);
    for (const value of seen) expect(typeof value).not.toBe('function');
    expect(seen.length, 'ANTI-VACUITY: the walk reached the entries').toBeGreaterThan(60);
  });
});
