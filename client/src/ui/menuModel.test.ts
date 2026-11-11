// ui/menuModel.test.ts — ctl-5 (CTL5.1): the main-menu ENTRY TABLE (`MENU_ENTRIES`).
//
// The old two-level `MENU_TREE` / `menuStep` / `menuKeyInput` / `buildMenuViewModel` core is gone
// (nav is the ctl-4 kit; the screen reducer is `screens/mainMenuScreen.ts`), so this file is
// rewritten for the new table. What a consumer may rely on is pinned here:
//
//   MENU_ENTRIES: readonly Row[]        the ROOT list, in display order
//   Row = { key, title(): string, description(): string }
//
// `title` / `description` are THUNKS that resolve through the catalog at CALL time (never at
// import), so the same table renders in en and fr. The leaf rows carry the overlay they open
// (proved through the screen reducer in `screens/mainMenuScreen.test.ts`, where A on each leaf
// emits its `open` target). uif-15c: no row has children, the table has no group at all.
//
// RETIRED TEST IDS (this file) -> reason -> survivor:
//   MM-TREE-SHAPE, MM-NAV-*, MM-ESCAPE-TOP-CLOSES, MM-LEFT-AT-TOP-IS-NOOP, MM-CLICK-*,
//   MM-STEP-TOTAL*, MM-LEAF-*, MM-ACTIVATE-RESETS-STATE, MM-VM-*, MM-DISABLED-LEAF-ALWAYS-RENDERED,
//   MM-AVAILABILITY-SEMANTICS, MM-KEYINPUT-*, MM-INITIAL-IS-CATEGORIES
//     -> the 5-category / 12-leaf tree, `menuStep`, `menuKeyInput`, `MenuAvailability` and
//        `buildMenuViewModel` are deleted (CTL5.2: the menu has no key-owner, no disabled
//        entries, no ArrowRight-enters). Survivors: CTL5-1-ENTRIES (the new table) here, and the
//        reducer cases (wrap, A, B, Y, repeat clamp) in screens/mainMenuScreen.test.ts.
//   MM-KEYGLYPH-FROM-HELP-SSOT
//     -> none needed (milestone survivor table): leaves stop carrying key glyphs, so the
//        invariant "every glyph is documented in helpModel" is vacuous; the Controls row
//        (controlsView.test.ts) lists the accelerators.
//   ctl-12b "the Options group holds How to play then Controls ..." (uif-15c, UIF15C.1)
//     -> the Options group is gone; survivor: UIF15C.1 help and controls are root open leaves.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stripComments } from '../../test-util/stripComments';
import { CATALOG_EN } from './i18n/catalog.en';
import { CATALOG_FR } from './i18n/catalog.fr';
import { setLocale, t } from './i18n/resolver';
import * as menuModel from './menuModel';
import { MENU_ENTRIES, withRequestBadge } from './menuModel';
import { OVERLAY_IDS } from './overlayRegistry';

interface Row {
  readonly key: string;
  readonly title: () => string;
  readonly description: () => string;
  readonly children?: readonly Row[];
}

const ROOT: readonly Row[] = MENU_ENTRIES;

// uif-15c (UIF15C.1, named intentional change): the Options group is replaced by two root leaves,
// How to Play (help) then Controls, in that order. Was:
// ['monsters', 'bag', 'journal', 'social', 'profile', 'options', 'close'] with
// options: ['help', 'controls'].
// uif-15b (UIF15B.1, named intentional change): Social is a root LEAF that opens the Social frame,
// so it is no longer a group. Was: social: ['trades', 'challenges', 'rankings'].
// uif-16b (UIF16B.1, named intentional change): Profile is a root LEAF that opens the one Profile
// frame, so it is no longer a group. Was: profile: ['name', 'account', 'privacy'].
const ROOT_KEYS = ['monsters', 'bag', 'journal', 'social', 'profile', 'help', 'controls', 'close'];

/** Every row with the catalog id its title must resolve through. */
const EXPECTED_IDS: ReadonlyArray<{ readonly path: string; readonly title: string }> =
  ROOT_KEYS.map((key) => ({ path: key, title: `menu.${key}.title` }));

/** The rows in the same order as EXPECTED_IDS. */
function flatRows(): Array<{ readonly path: string; readonly row: Row }> {
  return ROOT.map((row) => ({ path: row.key, row }));
}

const EN = CATALOG_EN as unknown as Record<string, string>;
const FR = CATALOG_FR as unknown as Record<string, string>;
const descId = (titleId: string): string => `${titleId.slice(0, -'title'.length)}desc`;

afterEach(() => {
  setLocale('en');
});

describe('MENU_ENTRIES', () => {
  it('UIF15C.1 CTL5-1-ENTRIES: the root is Monsters, Bag, Journal, Social, Profile, How to Play, Controls, Close with no group and no children; every title and description is the English catalog text', () => {
    // WRONG IMPL KILLED: the seven-row root with an Options group; a root in a different order
    // (How to Play after Controls, Close not last); a row that carries children, or a kind:'group'
    // entry kept "for later"; a title/description swap or a row wired to another row's catalog id
    // (the literals below are per row, so a mis-map reds); and any entry that is missing a title
    // or a description.
    expect(
      ROOT.map((r) => r.key),
      'the root list, in order',
    ).toEqual(ROOT_KEYS);
    expect(new Set(ROOT.map((r) => r.key)).size, 'root keys are unique').toBe(ROOT_KEYS.length);
    expect(ROOT.length, 'ANTI-VACUITY: eight root rows').toBe(8);

    for (const row of ROOT) {
      expect(row.children, `${row.key} has no children`).toBeUndefined();
      expect((row as unknown as { kind?: string }).kind, `${row.key} is not a group`).not.toBe(
        'group',
      );
    }
    expect(
      ROOT.filter((r) => (r as unknown as { kind?: string }).kind === 'group'),
      'no group remains',
    ).toEqual([]);

    const TITLES: Readonly<Record<string, string>> = {
      monsters: 'Monsters',
      bag: 'Inventory',
      journal: 'Journal',
      social: 'Social',
      profile: 'Profile',
      help: 'How to Play',
      controls: 'Controls',
      close: 'Close',
    };
    const DESCRIPTIONS: Readonly<Record<string, string>> = {
      monsters: 'See your party and stored monsters.',
      bag: 'Use items and care for your monsters.',
      journal: 'Review your quests and their progress.',
      social: 'Trades, challenges and rankings with other players.',
      profile: 'Your name, account and privacy settings.',
      help: 'Controls and goals of the game.',
      controls: 'Choose which key presses each button.',
      close: 'Close the menu and return to the world.',
    };
    const rows = flatRows();
    expect(rows.length, 'ANTI-VACUITY: 8 root rows, no sub-list rows').toBe(8);
    for (const { path: p, row } of rows) {
      expect(row.title(), `${p} title`).toBe(TITLES[p]);
      expect(row.description(), `${p} description`).toBe(DESCRIPTIONS[p]);
    }
  });

  it('UIF15C.1 menuModel exports no group machinery: no menuGroup function, no kind:"group" entry, and the source (comments stripped) names no group, MenuGroup or options', () => {
    // WRONG IMPL KILLED: a deleted-in-name-only group (menuGroup still exported and returning
    // undefined; the MenuGroup / MenuGroupKey types kept "for later"); the retired menu.options.*
    // catalog ids still read by a thunk; a dead 'options' key left in the table.
    expect('menuGroup' in menuModel, 'menuGroup is not exported').toBe(false);
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'menuModel.ts'),
      'utf8',
    );
    const code = stripComments(src);
    expect(code.length, 'ANTI-VACUITY: the stripped source is real').toBeGreaterThan(500);
    expect(code).toContain('MENU_ENTRIES');
    expect(code).not.toMatch(/group/i);
    expect(code).not.toContain('MenuGroup');
    expect(code).not.toMatch(/options/i);
  });

  it('UIF15A.1 the root entries read Monsters, Inventory, Journal, Social, Profile, How to Play, Controls, Close in en and Monstres, Inventaire, Journal, Social, Profil, Comment jouer, Commandes, Fermer in fr, in that order, and the keys are unchanged', () => {
    // uif-15c (named intentional change, UIF15C.1): Options is replaced by How to Play + Controls
    // (fr: Comment jouer + Commandes). Was: [..., 'Profile', 'Options', 'Close'] / [..., 'Profil',
    // 'Options', 'Fermer'].
    // WRONG IMPL KILLED: a root still labelled Bag / Sac; a relabel that renames the nav key
    // (`bag` stays); a locale frozen at import; a French list that kept an English word.
    setLocale('en');
    expect(
      ROOT.map((r) => r.title()),
      'en root titles',
    ).toEqual([
      'Monsters',
      'Inventory',
      'Journal',
      'Social',
      'Profile',
      'How to Play',
      'Controls',
      'Close',
    ]);
    setLocale('fr');
    expect(
      ROOT.map((r) => r.title()),
      'fr root titles',
    ).toEqual([
      'Monstres',
      'Inventaire',
      'Journal',
      'Social',
      'Profil',
      'Comment jouer',
      'Commandes',
      'Fermer',
    ]);
    expect(
      ROOT.map((r) => r.key),
      'keys keep their ids',
    ).toEqual(ROOT_KEYS);
  });

  it('CTL5-1-CATALOG-EN-FR: every title and description resolves through the catalog id for its own row in en and in fr, at call time', () => {
    // uif-15c (named intentional change, UIF15C.1): the help / controls rows resolve through
    // menu.help.* / menu.controls.* (EXPECTED_IDS is built from the row keys). Was: menu.options.*.
    // WRONG IMPL KILLED: a table that resolves `t()` once at import (every row frozen in en, so
    // `fr` renders English, today's defect); a title thunk wired to another row's id; a row whose
    // description is missing in one locale; and titles that never change between locales.
    const rows = flatRows();
    expect(rows.length, 'ANTI-VACUITY').toBe(EXPECTED_IDS.length);
    const idsByPath = new Map(EXPECTED_IDS.map((e) => [e.path, e.title]));

    const read = (): string[] => rows.flatMap(({ row }) => [row.title(), row.description()]);
    const expectedFor = (catalog: Record<string, string>): string[] =>
      rows.flatMap(({ path: p }) => {
        const titleId = idsByPath.get(p) as string;
        return [catalog[titleId] as string, catalog[descId(titleId)] as string];
      });

    setLocale('en');
    const en = read();
    expect(en, 'en: each row reads its own catalog ids').toEqual(expectedFor(EN));

    setLocale('fr');
    const fr = read();
    expect(fr, 'fr: each row reads its own catalog ids').toEqual(expectedFor(FR));
    // The French titles really are French (not the English bytes) for the rows whose catalog
    // values differ, and the table is not frozen to the first locale it was read in.
    const frTitle = (p: string): string =>
      (rows.find((r) => r.path === p) as { row: Row }).row.title();
    expect(frTitle('monsters')).toBe('Monstres');
    expect(frTitle('bag')).toBe('Inventaire');
    expect(frTitle('close')).toBe('Fermer');
    // uif-15c (named intentional change): the key is 'controls' now. Was: 'options/controls'.
    expect(frTitle('controls'), 'ctl-12b: the Controls row in French').toBe('Commandes');
    expect(frTitle('help'), 'uif-15c: the How to Play row in French').toBe('Comment jouer');
    expect(fr, 'fr differs from en').not.toEqual(en);

    setLocale('en');
    expect(read(), 'back to en: nothing was memoized in fr').toEqual(en);
  });

  it('CTL10B-2-MENU-NO-INITIATE: no leaf of the menu table opens the trade session editor (tradeSessionView, a real frame id), every leaf opens exactly one of the seven viewers, and the Social row describes answering only (it no longer says "Challenge a player")', () => {
    // WRONG IMPL KILLED: a menu leaf (Social, Trades, Challenges or any other) whose target is
    // tradeSessionView (a menu way to start a trade, r2-025; ts-3.1: a session is opened face to
    // face only); a leaf that opens some other initiating surface (the target set is closed, so a
    // new one reds); a Social description that still advertises starting a challenge; and a walk
    // that misses the help / controls leaves (ANTI-VACUITY below counts them).
    // ts-3 (named intentional change, the Strangler rename): was `tradeProposeView`, the wizard.
    // ANTI-VACUITY: the id the leaves are compared against is a real frame id (a stale id could
    // never be a leaf target, so the negative below would pass for nothing).
    expect((OVERLAY_IDS as readonly string[]).includes('tradeSessionView')).toBe(true);
    const leaves: Array<{ readonly path: string; readonly target: unknown }> = [];
    for (const root of ROOT) {
      if ((root as unknown as { kind?: string }).kind === 'open') {
        leaves.push({ path: root.key, target: (root as unknown as { target?: unknown }).target });
      }
    }
    // uif-15c (named intentional change, UIF15C.1): the two Options sub-list leaves (helpView,
    // controlsView) are root leaves now. Was: 2 sub-list leaves + 5 root leaves = 7. Still 7.
    // uif-16b (named intentional change, UIF16B.1): 9 -> 7. uif-15b: 11 -> 9.
    expect(leaves.length, 'ANTI-VACUITY: 7 root leaves').toBe(7);
    for (const { path: p, target } of leaves) {
      expect(target, `${p} opens something`).toBeTypeOf('string');
      expect(target, `${p} must not open the trade session editor`).not.toBe('tradeSessionView');
    }
    expect(
      leaves.map((l) => l.target).sort(),
      'the closed set of viewers a menu leaf opens',
    ).toEqual(
      // uif-16b (named intentional change): claimView, privacyView, renameView -> profileView.
      [
        'boxView',
        'controlsView',
        'helpView',
        'profileView',
        'questLogView',
        'raisingView',
        'social',
      ].sort(),
    );

    // The Social row's own description (the Challenges leaf's text retired with it, uif-15b) never
    // advertises starting a challenge.
    setLocale('en');
    const social = flatRows().find((r) => r.path === 'social');
    expect(social, 'the Social row exists').toBeDefined();
    const desc = (social as { row: Row }).row.description();
    expect(desc).toBe('Trades, challenges and rankings with other players.');
    expect(desc.includes('Challenge a player'), 'no longer advertises starting one').toBe(false);
  });

  it('UIF15B.1 the root Social row is an open leaf for the social frame with no children, and the three retired Social sub-list leaves are not in the table', () => {
    // WRONG IMPL KILLED: Social still a group (A would enter a sub-list, the old two-step path); a
    // leaf that opens a legacy overlay (tradeView) instead of the Social frame; a leaf that keeps
    // a vestigial children array; the Trades / Challenges / Rankings rows kept somewhere in the
    // table (a second route that the roster pin no longer carries ids for).
    const social = MENU_ENTRIES.find((e) => e.key === 'social') as unknown as {
      kind?: string;
      target?: string;
      children?: unknown;
    };
    expect(social, 'the Social row').toBeDefined();
    // C26/C27 (red-team): title and description are the Social row's own catalog text, not swapped
    // with each other or with a neighbour's, in both locales.
    const row = MENU_ENTRIES.find((e) => e.key === 'social') as Row;
    setLocale('en');
    expect(row.title(), 'en title').toBe(EN['menu.social.title']);
    expect(row.description(), 'en description').toBe(EN['menu.social.desc']);
    expect(row.title()).not.toBe(row.description());
    setLocale('fr');
    expect(row.title(), 'fr title').toBe(FR['menu.social.title']);
    expect(row.description(), 'fr description').toBe(FR['menu.social.desc']);
    setLocale('en');
    expect(social.kind, 'an open leaf, not a group').toBe('open');
    expect(social.target, 'it opens the Social frame').toBe('social');
    expect(social.children, 'a leaf has no children').toBeUndefined();
    // uif-15c (named intentional change, UIF15C.1): no group remains at all. Was: ['options'].
    expect(
      MENU_ENTRIES.filter((e) => (e as unknown as { kind?: string }).kind === 'group').map(
        (e) => e.key,
      ),
      'no group remains',
    ).toEqual([]);
    const allKeys = MENU_ENTRIES.map((e) => e.key);
    for (const retired of ['trades', 'challenges', 'rankings']) {
      expect(allKeys, `${retired} is not a menu row any more`).not.toContain(retired);
    }
  });

  it('UIF16B.1 the root Profile row is an open leaf for the one profileView frame with no children; the Name, Account and Privacy sub-list rows are not in the table', () => {
    // WRONG IMPL KILLED: Profile still a group (A would enter the Name / Account / Privacy
    // sub-list, the path UIF16B.1 retires); a leaf that opens one section's old overlay (renameView,
    // claimView) instead of the combined frame; a leaf that keeps a vestigial children array; a
    // sub-list row kept somewhere in the table; and a title or description swapped with a
    // neighbour's, in either locale.
    const profile = MENU_ENTRIES.find((e) => e.key === 'profile') as unknown as {
      kind?: string;
      target?: string;
      children?: unknown;
    };
    expect(profile, 'the Profile row').toBeDefined();
    expect(profile.kind, 'an open leaf, not a group').toBe('open');
    expect(profile.target, 'it opens the one Profile frame').toBe('profileView');
    expect(profile.children, 'a leaf has no children').toBeUndefined();
    // uif-15c (named intentional change, UIF15C.1): help and controls join the root open leaves.
    // Was: ['monsters', 'bag', 'journal', 'social', 'profile'].
    expect(
      MENU_ENTRIES.filter((e) => e.kind === 'open').map((e) => e.key),
      'the root open leaves, in order',
    ).toEqual(['monsters', 'bag', 'journal', 'social', 'profile', 'help', 'controls']);
    const row = MENU_ENTRIES.find((e) => e.key === 'profile') as Row;
    setLocale('en');
    expect(row.title()).toBe(EN['menu.profile.title']);
    expect(row.description()).toBe(EN['menu.profile.desc']);
    setLocale('fr');
    expect(row.title()).toBe(FR['menu.profile.title']);
    expect(row.description()).toBe(FR['menu.profile.desc']);
    setLocale('en');
    const allKeys = MENU_ENTRIES.map((e) => e.key);
    for (const retired of ['name', 'account', 'privacy']) {
      expect(allKeys, `${retired} is not a menu row any more`).not.toContain(retired);
    }
  });

  it('UIF15C.1 help is a root open leaf for helpView and controls a root open leaf for controlsView, How to Play first; neither is a group or nested, and they resolve through menu.help.* / menu.controls.* in en and fr', () => {
    // LEGACY BEHAVIOUR REPLACED: ctl-12b's "the Options group holds How to play then Controls"; A on
    // Options entered a sub-list and two presses reached either screen.
    // WRONG IMPL KILLED: help / controls still reachable only inside a group (an Options entry kept);
    // Controls placed before How to Play; a leaf opening the other's frame (help <-> controls
    // swapped); a leaf that is itself a group or carries children; a thunk still reading the
    // retired menu.options.help.* / menu.options.controls.* ids (the resolved text would match but
    // the id would not: the fr / en comparison below is against the NEW ids).
    const help = MENU_ENTRIES.find((e) => e.key === 'help') as unknown as {
      kind?: string;
      target?: string;
      children?: unknown;
    } & Row;
    const controls = MENU_ENTRIES.find((e) => e.key === 'controls') as unknown as {
      kind?: string;
      target?: string;
      children?: unknown;
    } & Row;
    expect(help, 'a root help row').toBeDefined();
    expect(controls, 'a root controls row').toBeDefined();
    expect(help.kind).toBe('open');
    expect(help.target).toBe('helpView');
    expect(help.children).toBeUndefined();
    expect(controls.kind).toBe('open');
    expect(controls.target).toBe('controlsView');
    expect(controls.children).toBeUndefined();
    const keys = MENU_ENTRIES.map((e) => e.key);
    expect(keys.indexOf('help'), 'How to Play first').toBe(keys.indexOf('controls') - 1);
    expect(keys.indexOf('controls'), 'Controls just before Close').toBe(keys.length - 2);
    expect(keys, 'no options entry').not.toContain('options');

    setLocale('en');
    expect(help.title()).toBe(EN['menu.help.title']);
    expect(help.description()).toBe(EN['menu.help.desc']);
    expect(controls.title()).toBe(EN['menu.controls.title']);
    expect(controls.description()).toBe(EN['menu.controls.desc']);
    expect(help.title(), 'fixture: the id exists').toBe('How to Play');
    setLocale('fr');
    expect(help.title()).toBe(FR['menu.help.title']);
    expect(help.description()).toBe(FR['menu.help.desc']);
    expect(controls.title()).toBe(FR['menu.controls.title']);
    expect(controls.description()).toBe(FR['menu.controls.desc']);
    expect(help.title(), 'fixture: the id exists').toBe('Comment jouer');
    setLocale('en');
  });
});

// ctl-13 (CTL13.2): the Social row of the main menu carries a real-text badge while a request
// waits (REV 2 item 2: `${label} (${t('chrome.badge.request')})`, never an icon alone).
describe('withRequestBadge (ctl-13, CTL13.2)', () => {
  it('CTL13-2-MENU-BADGE: while a request waits the Social label gains " (<badge>)" in the active locale and nothing else changes; with nothing waiting, or with no Social label, the very same object comes back; the input is never mutated', () => {
    // WRONG IMPL KILLED: a badge on the wrong row (Monsters, the group's children) or on every
    // row; a badge with no text (an icon or a bare dot a screen reader cannot read); one that
    // mutates the labels it was given (the menu's own table would keep the badge after the request
    // is gone); a badge painted when nothing waits; a fresh object when nothing changes (the
    // menu's re-render memo would see a change every frame); a throw when the labels have no
    // Social entry; and a locale frozen at import.
    const labels = {
      monsters: 'Monsters',
      social: 'Social',
      profile: 'Profile',
      close: 'Close',
    } as const;
    const badge = t('chrome.badge.request' as never);
    expect(badge, 'fixture: the badge text is real').not.toBe('');

    setLocale('en');
    const badged = withRequestBadge(labels, true);
    expect(badged, 'only Social changes').toEqual({
      monsters: 'Monsters',
      social: `Social (${badge})`,
      profile: 'Profile',
      close: 'Close',
    });
    expect(badged.social).toBe('Social (New)');
    expect(labels.social, 'the input labels are not mutated').toBe('Social');
    expect(badged, 'a new object when it changes').not.toBe(labels);

    expect(withRequestBadge(labels, false), 'nothing waits: the same object').toBe(labels);
    const subList = { trades: 'Trades', challenges: 'Challenges' };
    expect(withRequestBadge(subList, true), 'no Social label: the same object').toBe(subList);
    expect(withRequestBadge(subList, false)).toBe(subList);
    const empty = {};
    expect(withRequestBadge(empty, true)).toBe(empty);

    // The badge is the active locale's, read per call.
    setLocale('fr');
    const frBadge = t('chrome.badge.request' as never);
    expect(frBadge, 'fixture: the French badge differs').not.toBe(badge);
    expect(withRequestBadge({ social: 'Social' }, true).social).toBe(`Social (${frBadge})`);
    setLocale('en');
    expect(withRequestBadge({ social: 'Social' }, true).social).toBe(`Social (${badge})`);
  });
});
