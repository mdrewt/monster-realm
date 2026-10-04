// ui/menuModel.test.ts — ctl-5 (CTL5.1): the main-menu ENTRY TABLE (`MENU_ENTRIES`).
//
// The old two-level `MENU_TREE` / `menuStep` / `menuKeyInput` / `buildMenuViewModel` core is gone
// (nav is the ctl-4 kit; the screen reducer is `screens/mainMenuScreen.ts`), so this file is
// rewritten for the new table. What a consumer may rely on is pinned here:
//
//   MENU_ENTRIES: readonly Row[]        the ROOT list, in display order
//   Row = { key, title(): string, description(): string, children?: readonly Row[] }
//
// `title` / `description` are THUNKS that resolve through the catalog at CALL time (never at
// import), so the same table renders in en and fr. A row with `children` is a group (a sub-list
// one level deep); the leaf rows carry the overlay they open (proved through the screen reducer
// in `screens/mainMenuScreen.test.ts`, where A on each leaf emits its `open` target).
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
//        invariant "every glyph is documented in helpModel" is vacuous; ctl-14's generated-help
//        tests list the accelerators.
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_EN } from './i18n/catalog.en';
import { CATALOG_FR } from './i18n/catalog.fr';
import { setLocale, t } from './i18n/resolver';
import { MENU_ENTRIES, withRequestBadge } from './menuModel';

interface Row {
  readonly key: string;
  readonly title: () => string;
  readonly description: () => string;
  readonly children?: readonly Row[];
}

const ROOT: readonly Row[] = MENU_ENTRIES;

const ROOT_KEYS = ['monsters', 'bag', 'journal', 'social', 'profile', 'options', 'close'];
// ctl-12b (named intentional change): Options gains its Controls leaf, SECOND, after How to play.
// The order is load-bearing: e2e/battle-dpad.spec.ts and encounter-battle.spec.ts press A on
// Options and expect the cursor on How to play. Was: options: ['help'].
const GROUP_CHILD_KEYS: Readonly<Record<string, readonly string[]>> = {
  social: ['trades', 'challenges', 'rankings'],
  profile: ['name', 'account', 'privacy'],
  options: ['help', 'controls'],
};

/** Every row (root, then each group's children) with the catalog ids it must resolve through. */
const EXPECTED_IDS: ReadonlyArray<{ readonly path: string; readonly title: string }> = [
  ...ROOT_KEYS.map((key) => ({ path: key, title: `menu.${key}.title` })),
  ...Object.entries(GROUP_CHILD_KEYS).flatMap(([group, kids]) =>
    kids.map((kid) => ({ path: `${group}/${kid}`, title: `menu.${group}.${kid}.title` })),
  ),
];

/** The rows in the same order as EXPECTED_IDS. */
function flatRows(): Array<{ readonly path: string; readonly row: Row }> {
  const out: Array<{ readonly path: string; readonly row: Row }> = ROOT.map((row) => ({
    path: row.key,
    row,
  }));
  for (const group of ROOT) {
    for (const child of group.children ?? []) {
      out.push({ path: `${group.key}/${child.key}`, row: child });
    }
  }
  return out;
}

const EN = CATALOG_EN as unknown as Record<string, string>;
const FR = CATALOG_FR as unknown as Record<string, string>;
const descId = (titleId: string): string => `${titleId.slice(0, -'title'.length)}desc`;

afterEach(() => {
  setLocale('en');
});

describe('MENU_ENTRIES', () => {
  it('CTL5-1-ENTRIES: the root is Monsters, Bag, Journal, Social, Profile, Options, Close; Social, Profile and Options hold one sub-list level; every title and description is the English catalog text', () => {
    // WRONG IMPL KILLED: the old five-category tree; a root in a different order (design §5);
    // a leaf that carries children, or a third level (depth is structural: sub-lists are leaves
    // only); a group with the wrong members; a title/description swap or a row wired to another
    // row's catalog id (the literals below are per row, so a mis-map reds); and any entry that
    // is missing a title or a description.
    expect(
      ROOT.map((r) => r.key),
      'the root list, in design §5 order',
    ).toEqual(ROOT_KEYS);
    expect(new Set(ROOT.map((r) => r.key)).size, 'root keys are unique').toBe(ROOT_KEYS.length);

    for (const row of ROOT) {
      const kids = row.children ?? [];
      const expected = GROUP_CHILD_KEYS[row.key] ?? [];
      expect(
        kids.map((c) => c.key),
        `children of ${row.key}`,
      ).toEqual(expected);
      for (const kid of kids) {
        expect(
          (kid.children ?? []).length,
          `${row.key}/${kid.key} is a leaf (two levels only)`,
        ).toBe(0);
      }
    }
    expect(ROOT.filter((r) => (r.children ?? []).length > 0).map((r) => r.key)).toEqual([
      'social',
      'profile',
      'options',
    ]);

    const TITLES: Readonly<Record<string, string>> = {
      monsters: 'Monsters',
      bag: 'Bag',
      journal: 'Journal',
      social: 'Social',
      profile: 'Profile',
      options: 'Options',
      close: 'Close',
      'social/trades': 'Trades',
      'social/challenges': 'Challenges',
      'social/rankings': 'Rankings',
      'profile/name': 'Name',
      'profile/account': 'Account',
      'profile/privacy': 'Privacy',
      'options/help': 'How to play',
      'options/controls': 'Controls',
    };
    const DESCRIPTIONS: Readonly<Record<string, string>> = {
      monsters: 'See your party and stored monsters.',
      bag: 'Use items and care for your monsters.',
      journal: 'Review your quests and their progress.',
      social: 'Trades, challenges and rankings with other players.',
      profile: 'Your name, account and privacy settings.',
      options: 'Help on how to play the game.',
      close: 'Close the menu and return to the world.',
      'social/trades': 'See and answer the trade offered to you.',
      // NAMED INTENTIONAL CHANGE (ctl-10b, CTL10B.2): was 'Challenge a player or answer a
      // challenge.' — no menu row starts a challenge any more; it only answers them.
      'social/challenges': 'See and answer challenges.',
      'social/rankings': 'See the ranked leaderboard.',
      'profile/name': 'Change the name other players see.',
      'profile/account': 'Sign in or keep this guest progress.',
      'profile/privacy': 'Export or delete your data.',
      'options/help': 'Controls and goals of the game.',
      'options/controls': 'Choose which key presses each button.',
    };
    const rows = flatRows();
    // ctl-12b (named intentional change): + the Controls leaf. Was: 7 + 7 = 14.
    expect(rows.length, 'ANTI-VACUITY: 7 root rows + 8 sub-list rows').toBe(15);
    for (const { path, row } of rows) {
      expect(row.title(), `${path} title`).toBe(TITLES[path]);
      expect(row.description(), `${path} description`).toBe(DESCRIPTIONS[path]);
    }
  });

  it('CTL5-1-CATALOG-EN-FR: every title and description resolves through the catalog id for its own row in en and in fr, at call time', () => {
    // WRONG IMPL KILLED: a table that resolves `t()` once at import (every row frozen in en, so
    // `fr` renders English, today's defect); a title thunk wired to another row's id; a row whose
    // description is missing in one locale; and titles that never change between locales.
    const rows = flatRows();
    expect(rows.length, 'ANTI-VACUITY').toBe(EXPECTED_IDS.length);
    const idsByPath = new Map(EXPECTED_IDS.map((e) => [e.path, e.title]));

    const read = (): string[] => rows.flatMap(({ row }) => [row.title(), row.description()]);
    const expectedFor = (catalog: Record<string, string>): string[] =>
      rows.flatMap(({ path }) => {
        const titleId = idsByPath.get(path) as string;
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
    const frTitle = (path: string): string =>
      (rows.find((r) => r.path === path) as { row: Row }).row.title();
    expect(frTitle('monsters')).toBe('Monstres');
    expect(frTitle('bag')).toBe('Sac');
    expect(frTitle('close')).toBe('Fermer');
    expect(frTitle('options/controls'), 'ctl-12b: the Controls leaf in French').toBe('Commandes');
    expect(fr, 'fr differs from en').not.toEqual(en);

    setLocale('en');
    expect(read(), 'back to en: nothing was memoized in fr').toEqual(en);
  });

  it('CTL10B-2-MENU-NO-INITIATE: no leaf of the menu table opens the trade wizard, every leaf opens exactly one of the eleven viewers, and the Challenges leaf describes answering only (it no longer says "Challenge a player")', () => {
    // WRONG IMPL KILLED: a menu leaf (Social, Trades, Challenges or any other) whose target is
    // tradeProposeView (a menu way to start a trade, r2-025); a leaf that opens some other
    // initiating surface (the target set is closed, so a new one reds); a Challenges description
    // that still advertises starting a challenge; and a walk that only reads the root (the
    // leaves live inside the groups: ANTI-VACUITY below counts them).
    const leaves: Array<{ readonly path: string; readonly target: unknown }> = [];
    for (const group of ROOT) {
      for (const leaf of group.children ?? []) {
        leaves.push({
          path: `${group.key}/${leaf.key}`,
          target: (leaf as unknown as { target?: unknown }).target,
        });
      }
    }
    for (const root of ROOT) {
      if ((root as unknown as { kind?: string }).kind === 'open') {
        leaves.push({ path: root.key, target: (root as unknown as { target?: unknown }).target });
      }
    }
    // ctl-12b (named intentional change): + the Controls leaf, which opens controlsView. Was: 7 + 3
    // = 10 leaves over ten viewers.
    expect(leaves.length, 'ANTI-VACUITY: 8 sub-list leaves + 3 root leaves').toBe(11);
    for (const { path, target } of leaves) {
      expect(target, `${path} opens something`).toBeTypeOf('string');
      expect(target, `${path} must not open the trade wizard`).not.toBe('tradeProposeView');
    }
    expect(
      leaves.map((l) => l.target).sort(),
      'the closed set of viewers a menu leaf opens',
    ).toEqual(
      [
        'boxView',
        'claimView',
        'controlsView',
        'helpView',
        'leaderboardView',
        'privacyView',
        'pvpView',
        'questLogView',
        'raisingView',
        'renameView',
        'tradeView',
      ].sort(),
    );

    setLocale('en');
    const challenges = flatRows().find((r) => r.path === 'social/challenges');
    expect(challenges, 'the Challenges leaf exists').toBeDefined();
    const desc = (challenges as { row: Row }).row.description();
    expect(desc).toBe('See and answer challenges.');
    expect(desc.includes('Challenge a player'), 'no longer advertises starting one').toBe(false);
  });

  it('ctl-12b: the Options group holds How to play then Controls, and the Controls leaf opens the controlsView frame', () => {
    // LEGACY BEHAVIOUR REPLACED: Options held How to play alone; no menu path reached a Controls
    // screen.
    // WRONG IMPL KILLED: a Controls leaf missing (no way to the remap screen by the menu), placed
    // FIRST (two e2e specs press A on Options and expect How to play under the cursor), placed in
    // another group, or opening another overlay (help); and a leaf that is itself a group.
    const options = ROOT.find((r) => r.key === 'options');
    expect(options, 'the Options group').toBeDefined();
    const kids = (options?.children ?? []) as ReadonlyArray<
      Row & { kind?: string; target?: string }
    >;
    expect(
      kids.map((k) => k.key),
      'How to play first, Controls second',
    ).toEqual(['help', 'controls']);
    const controls = kids[1];
    expect(controls?.kind, 'an open leaf').toBe('open');
    expect(controls?.target, 'it opens the Controls frame').toBe('controlsView');
    expect(kids[0]?.target, 'How to play still opens help').toBe('helpView');
    for (const group of ROOT.filter((r) => r.key !== 'options')) {
      expect(
        (group.children ?? []).map((k) => k.key),
        `${group.key} holds no Controls leaf`,
      ).not.toContain('controls');
    }
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
    // Social entry (a sub-list level); and a locale frozen at import.
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
