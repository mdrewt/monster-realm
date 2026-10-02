// ui/screens/mainMenuScreen.test.ts — ctl-5 (CTL5.1 to CTL5.5): the PURE main-menu reducer.
//
// Node env, no DOM, no mocks: `openMainMenu(memory)`, `mainMenuStep(state, input)`,
// `mainMenuPick(state, key)` and `menuViewModel(state)` are driven with plain values and the
// outcome is read from the returned `{ state, effect }`. The nav kit (`ui/nav.ts`) is the real one:
// these cases prove the SCREEN's rules on top of it (A opens a child and leaves the menu in
// place, B pops a group or closes at the root, Y describes, memory recalls the last entry).
//
// The contract the shell relies on:
//   levels         'root' | 'social' | 'profile' | 'options'; the root cursor is on the group's
//                  entry after B from that group.
//   effects        none | { open, target } | close. A on a leaf leaves the STATE where it is
//                  (the menu stays open beneath the child).
//   memory         updated on every step, immutable (a step never mutates the map it was given).
import { afterEach, describe, expect, it } from 'vitest';
import type { VButton } from '../../input/buttons';
import { CATALOG_FR } from '../i18n/catalog.fr';
import { setLocale, t } from '../i18n/resolver';
import type { MenuTarget } from '../menuModel';
import { EMPTY_NAV_MEMORY, type NavItem, type NavLayout, type NavMemory, recallNav } from '../nav';
import {
  type MainMenuState,
  type MenuEffect,
  mainMenuPick,
  mainMenuStep,
  menuViewModel,
  openMainMenu,
} from './mainMenuScreen';

const ROOT_KEYS = ['monsters', 'bag', 'journal', 'social', 'profile', 'options', 'close'];
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  social: ['trades', 'challenges', 'rankings'],
  profile: ['name', 'account', 'privacy'],
  options: ['help'],
};

const NONE: MenuEffect = { kind: 'none' };
const CLOSE: MenuEffect = { kind: 'close' };
const open = (target: MenuTarget): MenuEffect => ({ kind: 'open', target });

const press = (s: MainMenuState, button: VButton, repeat = false) =>
  mainMenuStep(s, { button, repeat });

const itemsOf = (layout: NavLayout): readonly NavItem[] =>
  layout.kind === 'tabs' ? [] : layout.items;

/** Move the cursor to `key` with fresh Down presses (wrapping), asserting every step is inert. */
function toKey(from: MainMenuState, key: string): MainMenuState {
  let s = from;
  for (let i = 0; i < 12 && s.nav.item !== key; i += 1) {
    const step = press(s, 'Down');
    expect(step.effect, `moving toward ${key}`).toEqual(NONE);
    s = step.state;
  }
  expect(s.nav.item, `cursor reached ${key}`).toBe(key);
  return s;
}

const fresh = (): MainMenuState => openMainMenu(EMPTY_NAV_MEMORY);

/** Root, cursor on `group`, then A: the sub-list level. */
function intoGroup(group: string, from: MainMenuState = fresh()): MainMenuState {
  const step = press(toKey(from, group), 'A');
  expect(step.effect, `A on the ${group} entry enters it`).toEqual(NONE);
  expect(step.state.level, `level after A on ${group}`).toBe(group);
  return step.state;
}

afterEach(() => {
  setLocale('en');
});

describe('mainMenu — open and wrap', () => {
  it('CTL5-1-WRAP: the menu opens on Monsters as a wrapping list: fresh Up from the first lands on Close, fresh Down from Close on Monsters, a full cycle visits every entry, sub-lists wrap too', () => {
    // WRONG IMPL KILLED: a clamp instead of a wrap (a fresh press at an end must wrap, the repeat
    // path is the clamp: CTL5-5-REPEAT-CLAMPS), a wrap that skips Close or stops short of the
    // last row, a cursor that does not start on the first entry, entries in another order, and a
    // sub-list that clamps or throws on a one-entry list.
    const start = fresh();
    expect(start.level).toBe('root');
    expect(start.nav.item, 'a fresh menu starts on the first entry').toBe('monsters');
    expect(itemsOf(menuViewModel(start).layout).map((i) => i.key)).toEqual(ROOT_KEYS);

    const up = press(start, 'Up');
    expect(up.effect).toEqual(NONE);
    expect(up.state.nav.item, 'Up from the first entry wraps to the last').toBe('close');
    const down = press(up.state, 'Down');
    expect(down.effect).toEqual(NONE);
    expect(down.state.nav.item, 'Down from the last entry wraps to the first').toBe('monsters');

    let s = start;
    const seen: Array<string | null> = [s.nav.item];
    for (let i = 0; i < ROOT_KEYS.length; i += 1) {
      s = press(s, 'Down').state;
      seen.push(s.nav.item);
    }
    expect(seen, 'seven Downs visit every entry in order and return').toEqual([
      ...ROOT_KEYS,
      'monsters',
    ]);
    s = start;
    const back: Array<string | null> = [];
    for (let i = 0; i < ROOT_KEYS.length; i += 1) {
      s = press(s, 'Up').state;
      back.push(s.nav.item);
    }
    expect(back, 'seven Ups visit every entry in reverse').toEqual([
      'close',
      'options',
      'profile',
      'social',
      'journal',
      'bag',
      'monsters',
    ]);

    const social = intoGroup('social');
    expect(press(social, 'Up').state.nav.item, 'a sub-list wraps upward').toBe('rankings');
    expect(press(press(social, 'Up').state, 'Down').state.nav.item).toBe('trades');
    const options = intoGroup('options');
    expect(options.nav.item).toBe('help');
    expect(press(options, 'Down').state.nav.item, 'a one-entry list stays put').toBe('help');
    expect(press(options, 'Up').state.nav.item).toBe('help');
  });

  it('CTL5-5-REPEAT-CLAMPS: a repeat-flagged D-pad edge clamps at the ends of the root and of a sub-list while a fresh edge wraps; a repeat A does nothing', () => {
    // WRONG IMPL KILLED: a screen that drops the `repeat` flag on the way to the kit (a held key
    // would spin around the list), one that clamps every edge (fresh wrap lost), one that clamps
    // only at the root, and a repeat A that activates (an OS-repeat Enter must not open twice).
    const atFirst = fresh();
    const atLast = toKey(fresh(), 'close');

    const clampDown = press(atLast, 'Down', true);
    expect(clampDown.effect).toEqual(NONE);
    expect(clampDown.state.nav.item, 'repeat Down at the last entry stays').toBe('close');
    expect(press(atLast, 'Down', false).state.nav.item, 'contrast: a fresh Down wraps').toBe(
      'monsters',
    );
    const clampUp = press(atFirst, 'Up', true);
    expect(clampUp.effect).toEqual(NONE);
    expect(clampUp.state.nav.item, 'repeat Up at the first entry stays').toBe('monsters');
    expect(press(atFirst, 'Up', false).state.nav.item, 'contrast: a fresh Up wraps').toBe('close');

    // A repeat in the middle still moves one entry (clamping is only at the ends).
    expect(press(atFirst, 'Down', true).state.nav.item).toBe('bag');

    const social = intoGroup('social');
    expect(press(social, 'Up', true).state.nav.item, 'repeat Up at the first child').toBe('trades');
    const lastChild = toKey(social, 'rankings');
    expect(press(lastChild, 'Down', true).state.nav.item, 'repeat Down at the last child').toBe(
      'rankings',
    );
    expect(press(lastChild, 'Down', false).state.nav.item, 'contrast: fresh wraps').toBe('trades');

    const onJournal = toKey(fresh(), 'journal');
    const repeatA = press(onJournal, 'A', true);
    expect(repeatA.effect, 'a repeat A is not an activation').toEqual(NONE);
    expect(repeatA.state.nav.item).toBe('journal');
    const repeatOnClose = press(atLast, 'A', true);
    expect(repeatOnClose.effect, 'and a repeat A on Close does not close').toEqual(NONE);
  });
});

describe('mainMenu — A, B and the sub-lists', () => {
  it("CTL5-2-A-OPENS-CHILD: A on a leaf emits open with that entry's overlay and leaves the menu in place beneath it; A on Close closes; every target is distinct", () => {
    // WRONG IMPL KILLED: an A that closes the menu before opening (the old activateMenuLeaf: B
    // could never come back), an `open` carrying the wrong overlay (a neighbouring entry's), a
    // leaf whose A also moves the cursor or the level (the menu would not be "where it was" on
    // return), and an A on Close that opens something.
    const rootLeaves: ReadonlyArray<readonly [string, MenuTarget]> = [
      ['monsters', 'boxView'],
      ['bag', 'raisingView'],
      ['journal', 'questLogView'],
    ];
    const targets: MenuTarget[] = [];
    for (const [key, target] of rootLeaves) {
      const on = toKey(fresh(), key);
      const step = press(on, 'A');
      expect(step.effect, `A on ${key}`).toEqual(open(target));
      expect(step.state.level, `${key}: the menu stays on the root`).toBe('root');
      expect(step.state.nav.item, `${key}: the cursor stays on the entry`).toBe(key);
      expect(step.state.feedback, `${key}: nothing else changed`).toEqual(on.feedback);
      targets.push(target);
    }

    const groupLeaves: ReadonlyArray<readonly [string, string, MenuTarget]> = [
      ['social', 'trades', 'tradeView'],
      ['social', 'challenges', 'pvpView'],
      ['social', 'rankings', 'leaderboardView'],
      ['profile', 'name', 'renameView'],
      ['profile', 'account', 'claimView'],
      ['profile', 'privacy', 'privacyView'],
      ['options', 'help', 'helpView'],
    ];
    for (const [group, key, target] of groupLeaves) {
      const inside = toKey(intoGroup(group), key);
      const step = press(inside, 'A');
      expect(step.effect, `A on ${group}/${key}`).toEqual(open(target));
      expect(step.state.level, `${group}/${key}: the sub-list stays open beneath`).toBe(group);
      expect(step.state.nav.item).toBe(key);
      targets.push(target);
    }
    expect(new Set(targets).size, 'ten distinct overlays, one per leaf').toBe(10);

    const close = press(toKey(fresh(), 'close'), 'A');
    expect(close.effect, 'A on Close closes the menu').toEqual(CLOSE);
  });

  it('CTL5-2-GROUP-PUSH-B-RETURNS: A on Social, Profile or Options enters its sub-list on the first child with a Menu breadcrumb; B returns to the root with the cursor on that group entry and the sub-list cursor is remembered', () => {
    // WRONG IMPL KILLED: A on a group that emits `open` or `close`, a sub-list that starts on
    // the wrong child, a B that closes the menu from a sub-list (two presses to leave one),
    // a B that returns to the first root entry instead of the group, a sub-list cursor that is
    // forgotten on re-entry, and a breadcrumb that is not Menu then the group.
    for (const [group, kids] of Object.entries(GROUPS)) {
      const inside = intoGroup(group);
      expect(inside.nav.item, `${group}: first child`).toBe(kids[0]);
      const vm = menuViewModel(inside);
      expect(vm.crumbs, `${group}: breadcrumb`).toEqual(['Menu']);
      expect(itemsOf(vm.layout).map((i) => i.key)).toEqual(kids);

      const last = toKey(inside, kids[kids.length - 1] as string);
      const back = press(last, 'B');
      expect(back.effect, `B in ${group} returns, it does not close`).toEqual(NONE);
      expect(back.state.level).toBe('root');
      expect(back.state.nav.item, `B lands on the ${group} entry`).toBe(group);
      expect(menuViewModel(back.state).crumbs).toEqual([]);

      // Re-entering recalls the last child the cursor stood on.
      const again = press(back.state, 'A');
      expect(again.state.level).toBe(group);
      expect(again.state.nav.item, `${group}: cursor recalled on re-entry`).toBe(
        kids[kids.length - 1],
      );
    }
  });

  it('CTL5-2-B-AT-ROOT-CLOSES: B at the root closes the menu wherever the cursor is, including after backing out of a sub-list', () => {
    // WRONG IMPL KILLED: a B at the root that does nothing (the menu could only close through
    // Close or Escape), one that closes only from the first entry, and a B that closes from a
    // sub-list instead of popping it first.
    for (const key of ROOT_KEYS) {
      const step = press(toKey(fresh(), key), 'B');
      expect(step.effect, `B at root on ${key}`).toEqual(CLOSE);
    }
    const inGroup = intoGroup('profile');
    const popped = press(inGroup, 'B');
    expect(popped.effect).toEqual(NONE);
    expect(press(popped.state, 'B').effect, 'the second B, now at the root, closes').toEqual(CLOSE);
  });

  it('CTL5-2-RIGHT-NO-ACTIVATE: Left and Right (fresh or repeat) never activate an entry, enter a group, close or move the cursor, at the root or in a sub-list', () => {
    // WRONG IMPL KILLED: the old menuKeyInput that mapped ArrowRight/KeyD to "enter" (B18): Right
    // on a group would open its sub-list, Right on a leaf would open the child, Right on Close
    // would close; and a Left that backs out of a sub-list.
    for (const key of ROOT_KEYS) {
      const on = toKey(fresh(), key);
      for (const button of ['Right', 'Left'] as const) {
        for (const repeat of [false, true]) {
          const step = press(on, button, repeat);
          expect(step.effect, `${button}${repeat ? ' (repeat)' : ''} on ${key}`).toEqual(NONE);
          expect(step.state.level, `${button} on ${key} keeps the level`).toBe('root');
          expect(step.state.nav.item, `${button} on ${key} keeps the cursor`).toBe(key);
        }
      }
    }
    const inside = toKey(intoGroup('social'), 'challenges');
    for (const button of ['Right', 'Left'] as const) {
      const step = press(inside, button);
      expect(step.effect).toEqual(NONE);
      expect(step.state.level, 'a sub-list is not left by Left').toBe('social');
      expect(step.state.nav.item).toBe('challenges');
    }
  });
});

describe('mainMenu — memory and Y', () => {
  it('CTL5-3-RECALL-LAST-USED: reopening with the returned memory puts the cursor on the last entry used, at the root, and a step never mutates the memory it was given', () => {
    // WRONG IMPL KILLED: an `openMainMenu` that always starts on the first entry (CTL5.3 would
    // not hold), memory written only on close or only on A, a recall keyed to the group level
    // (reopening mid-sub-list must land on the root), a memory map mutated in place (the shared
    // EMPTY_NAV_MEMORY would leak a cursor into every later session), and a recall that returns a
    // stale cursor after later moves.
    const before = EMPTY_NAV_MEMORY.size;
    const onJournal = toKey(fresh(), 'journal');
    const reopened = openMainMenu(onJournal.memory);
    expect(reopened.level).toBe('root');
    expect(reopened.nav.item, 'the last entry used').toBe('journal');
    expect(EMPTY_NAV_MEMORY.size, 'the shared empty memory is never written').toBe(before);
    expect(openMainMenu(EMPTY_NAV_MEMORY).nav.item, 'a fresh session starts on the first').toBe(
      'monsters',
    );

    // Later moves replace the recalled entry.
    const moved = press(reopened, 'Down').state;
    expect(moved.nav.item).toBe('social');
    expect(openMainMenu(moved.memory).nav.item, 'the most recent cursor wins').toBe('social');

    // Closed from inside a sub-list: reopening lands on the ROOT, on the group's entry.
    const inProfile = toKey(intoGroup('profile'), 'privacy');
    const reopenedFromGroup = openMainMenu(inProfile.memory);
    expect(reopenedFromGroup.level).toBe('root');
    expect(reopenedFromGroup.nav.item).toBe('profile');
    // ... and the sub-list remembers its own cursor for the next entry.
    expect(press(reopenedFromGroup, 'A').state.nav.item).toBe('privacy');

    // The memory is keyed by the frame the view model names, not by an unrelated key.
    const vm = menuViewModel(onJournal);
    expect(recallNav(onJournal.memory as NavMemory, vm.frameId)?.item).toBe('journal');

    // Stepping does not mutate the memory object that came in.
    const snapshot = new Map(onJournal.memory);
    press(onJournal, 'Down');
    press(onJournal, 'Up');
    expect(new Map(onJournal.memory), 'the input memory is untouched').toEqual(snapshot);
  });

  it('CTL5-4-Y-DESCRIBES: Y shows the entry description on the feedback line without moving or opening, any move clears it, and the text is resolved in the current locale', () => {
    // WRONG IMPL KILLED: a Y that opens or closes, one that shows the TITLE or another entry's
    // description, a feedback line that survives a cursor move (stale text under a new entry),
    // description text frozen in en under fr, no description for sub-list children, and a Y that
    // moves the cursor.
    const onJournal = toKey(fresh(), 'journal');
    expect(onJournal.feedback, 'control: nothing is shown before Y').toEqual({ kind: 'none' });
    const y = press(onJournal, 'Y');
    expect(y.effect).toEqual(NONE);
    expect(y.state.nav.item, 'Y does not move').toBe('journal');
    expect(y.state.level).toBe('root');
    expect(y.state.feedback).toEqual({
      kind: 'info',
      text: 'Review your quests and their progress.',
    });
    expect(menuViewModel(y.state).feedback, 'the view model carries it').toEqual(y.state.feedback);

    // A different entry replaces the text; Close has a description too.
    const onClose = press(toKey(y.state, 'close'), 'Y');
    expect(onClose.effect).toEqual(NONE);
    expect(onClose.state.feedback).toEqual({
      kind: 'info',
      text: 'Close the menu and return to the world.',
    });

    // A move clears the line.
    const cleared = press(y.state, 'Down');
    expect(cleared.state.nav.item).toBe('social');
    expect(cleared.state.feedback, 'a move clears the feedback').toEqual({ kind: 'none' });

    // Sub-list children describe themselves.
    const rankings = press(toKey(intoGroup('social'), 'rankings'), 'Y');
    expect(rankings.state.feedback).toEqual({
      kind: 'info',
      text: 'See the ranked leaderboard.',
    });
    expect(rankings.state.level).toBe('social');

    // Resolved at press time: under fr the French description appears.
    setLocale('fr');
    const french = press(onJournal, 'Y');
    expect(french.state.feedback.kind).toBe('info');
    const frText = (CATALOG_FR as unknown as Record<string, string>)['menu.journal.desc'];
    expect(frText, 'fixture: the French description differs from the English one').not.toBe(
      'Review your quests and their progress.',
    );
    expect(french.state.feedback).toEqual({ kind: 'info', text: frText });
  });
});

describe('mainMenu — pick, view model and inert buttons', () => {
  it('a pick moves the cursor to the key and then behaves as A: a leaf opens, a group enters, Close closes', () => {
    // WRONG IMPL KILLED: a pick that opens without moving the cursor (the menu would return to
    // the wrong entry), a pick that needs the cursor to be there already, and a pick that is not
    // the same code path as A (different effect for the same entry).
    const leaf = mainMenuPick(fresh(), 'journal');
    expect(leaf.effect).toEqual(open('questLogView'));
    expect(leaf.state.nav.item, 'the cursor follows the click').toBe('journal');
    expect(leaf.state.level).toBe('root');

    const group = mainMenuPick(fresh(), 'social');
    expect(group.effect).toEqual(NONE);
    expect(group.state.level).toBe('social');
    expect(group.state.nav.item).toBe('trades');

    expect(mainMenuPick(fresh(), 'close').effect).toEqual(CLOSE);

    const viaPick = mainMenuPick(group.state, 'rankings');
    const viaKeys = press(toKey(group.state, 'rankings'), 'A');
    expect(viaPick.effect).toEqual(viaKeys.effect);
    expect(viaPick.effect).toEqual(open('leaderboardView'));
    expect(viaPick.state.nav).toEqual(viaKeys.state.nav);
    expect(viaPick.state.level).toBe(viaKeys.state.level);
  });

  it('a pick of a key that is not in the current level is a no-op and never falls through to the cursor entry', () => {
    // WRONG IMPL KILLED (plan A5): `navFocus` ignores an unknown key and the A rule then fires on
    // whatever the cursor already stands on (a stale or forged data-nav-key would open the
    // Journal), a prototype-name key that matches an inherited property, and a root key picked
    // while a sub-list is showing.
    const onJournal = toKey(fresh(), 'journal');
    for (const key of ['nope', '', 'toString', '__proto__', 'constructor', 'trades', 'Journal']) {
      const step = mainMenuPick(onJournal, key);
      expect(step.effect, `pick '${key}' at the root`).toEqual(NONE);
      expect(step.state.level).toBe('root');
      expect(step.state.nav.item, `pick '${key}' keeps the cursor`).toBe('journal');
    }

    const inside = toKey(intoGroup('social'), 'challenges');
    for (const key of ['journal', 'monsters', 'close', 'help']) {
      const step = mainMenuPick(inside, key);
      expect(step.effect, `pick '${key}' inside Social`).toEqual(NONE);
      expect(step.state.level, 'the sub-list is still showing').toBe('social');
      expect(step.state.nav.item, 'and the cursor did not move').toBe('challenges');
    }
  });

  it('menuViewModel names the frame, title, breadcrumb, layout and English labels for the root and each sub-list, and resolves labels at call time', () => {
    // WRONG IMPL KILLED: a frame id shared by every level (the kit's ids would collide and the
    // nav memory would mix levels), a title/breadcrumb that does not follow the level, labels
    // that are catalog ids instead of text, labels frozen in en, a layout with disabled entries,
    // and a feedback or cursor that is not the state's own.
    const root = menuViewModel(fresh());
    expect(root.frameId).toBe('menu');
    expect(root.title).toBe('Menu');
    expect(root.crumbs).toEqual([]);
    expect(itemsOf(root.layout).every((i) => i.enabled)).toBe(true);
    expect(root.labels).toEqual({
      monsters: 'Monsters',
      bag: 'Bag',
      journal: 'Journal',
      social: 'Social',
      profile: 'Profile',
      options: 'Options',
      close: 'Close',
    });
    expect(root.nav).toEqual(fresh().nav);
    expect(root.feedback).toEqual({ kind: 'none' });

    const frames = new Set<string>([root.frameId]);
    const expected: Record<string, { title: string; labels: Record<string, string> }> = {
      social: {
        title: 'Social',
        labels: { trades: 'Trades', challenges: 'Challenges', rankings: 'Rankings' },
      },
      profile: {
        title: 'Profile',
        labels: { name: 'Name', account: 'Account', privacy: 'Privacy' },
      },
      options: { title: 'Options', labels: { help: 'How to play' } },
    };
    for (const [group, want] of Object.entries(expected)) {
      const vm = menuViewModel(intoGroup(group));
      expect(vm.title, `${group} title`).toBe(want.title);
      expect(vm.crumbs, `${group} breadcrumb`).toEqual(['Menu']);
      expect(vm.labels, `${group} labels`).toEqual(want.labels);
      expect(vm.frameId, 'a sub-list has its own frame id').not.toBe('menu');
      frames.add(vm.frameId);
    }
    expect(frames.size, 'four distinct frame ids').toBe(4);

    setLocale('fr');
    expect(menuViewModel(fresh()).labels.monsters, 'labels follow the locale').toBe('Monstres');
    expect(menuViewModel(fresh()).labels.close).toBe('Fermer');
  });

  it('buttons the menu does not use (X, LB, RB, Start, Select) do nothing: no effect, no move, no level change', () => {
    // WRONG IMPL KILLED: a catch-all arm that treats any non-D-pad button as A or as B.
    const on = toKey(fresh(), 'bag');
    for (const button of ['X', 'LB', 'RB', 'Start', 'Select'] as const) {
      const step = press(on, button);
      expect(step.effect, button).toEqual(NONE);
      expect(step.state.level, button).toBe('root');
      expect(step.state.nav.item, button).toBe('bag');
    }
  });
});

// ==========================================================================================
// ctl-6c: the menu over a battle (CTL6C.3): only Options (How to play) and Close stay enabled
// ==========================================================================================
//
// `openMainMenu(memory, battle = false)` carries `battle` in the state. Over a battle the layout
// marks `enabled:false` (with a `reason`) every `open` entry whose target screen is not battleSafe,
// plus the Journal and Rankings entries, and a `group` whose children are all disabled; nothing
// else. A (and a pick) on a disabled row does nothing and shows that row's reason on the feedback
// line; a disabled group is not entered. World mode is unchanged.
//
// INTENTIONAL CHANGE (ctl-6c, supervisor decision option-a: Journal/Rankings stay disabled over a
// battle until ctl-7a anchors their shells). The quest log and the leaderboard are battleSafe in
// SCREEN_POLICY, but their legacy shells are in-flow and paint UNDER the battle overlay, so the menu
// disables them over a battle; with Rankings gone every Social child is disabled, so the Social group
// is disabled too. Before the decision Journal, Social and Rankings were enabled here.
//
// The expected sets are HARD-CODED literals (the spec's table and the decision), not derived from
// SCREEN_POLICY.

type Level = 'root' | 'social' | 'profile' | 'options';
const IN_BATTLE = 'inBattle';
const BAG_REASON = 'battleBag';
type ReasonKind = typeof IN_BATTLE | typeof BAG_REASON;
/** Disabled rows per level over a battle, with the reason each shows. HARD-CODED. A disabled
 *  group (Social, Profile) shows the in-battle reason too. */
const DISABLED_OVER_BATTLE: Readonly<Record<Level, ReadonlyArray<readonly [string, ReasonKind]>>> =
  {
    root: [
      ['monsters', IN_BATTLE],
      ['bag', BAG_REASON],
      ['journal', IN_BATTLE],
      ['social', IN_BATTLE],
      ['profile', IN_BATTLE],
    ],
    social: [
      ['trades', IN_BATTLE],
      ['challenges', IN_BATTLE],
      ['rankings', IN_BATTLE],
    ],
    profile: [
      ['name', IN_BATTLE],
      ['account', IN_BATTLE],
      ['privacy', IN_BATTLE],
    ],
    options: [],
  };
const LEVEL_KEYS: Readonly<Record<Level, readonly string[]>> = {
  root: ROOT_KEYS,
  social: GROUPS.social as readonly string[],
  profile: GROUPS.profile as readonly string[],
  options: GROUPS.options as readonly string[],
};

const battleMenu = (): MainMenuState => openMainMenu(EMPTY_NAV_MEMORY, true);
/** The state on `level` over a battle. The disabled Social and Profile groups cannot be ENTERED
 *  over a battle, so their sub-lists are built directly (on their first child): the layout still
 *  has to say what their rows are. Options is entered for real, so a menu that disabled it fails
 *  here. */
function battleLevel(level: Level): MainMenuState {
  if (level === 'root') return battleMenu();
  if (level === 'options') return intoGroup('options', battleMenu());
  return {
    ...battleMenu(),
    level,
    nav: { tab: null, item: LEVEL_KEYS[level][0] as string, perTab: {} },
  };
}
const reasonText = (kind: ReasonKind): string =>
  kind === BAG_REASON ? t('menu.disabled.battleBag') : t('menu.disabled.inBattle');

describe('mainMenu over a battle (ctl-6c)', () => {
  it('CTL6C-3-MENU-DISABLED-OVER-BATTLE: over a battle only Options (How to play) and Close stay enabled: Monsters, Bag, Journal, the Social group (Trades, Challenges, Rankings) and the Profile group are disabled with their reasons; A or a pick on a disabled row or group does nothing, enters nothing and shows its reason; the world menu is unchanged; en and fr', () => {
    // WRONG IMPL KILLED: a battle layout keyed to `!battleSafe` alone (the pre-decision rule:
    // Journal, Social and Rankings stay enabled, so the quest log and the leaderboard open over a
    // battle that paints over their in-flow shells: red at the root literal and the Social level);
    // a menu that ignores the battle flag (every row enabled); a menu that disables everything
    // (Options, How to play or Close disabled: the player could neither read help nor leave the
    // menu by its Close row); a layout built once and reused (the flag changes, the rows do not); a
    // flag that is lost on entering a sub-list (Options is entered for real here); a group disabled
    // only when SOME child is (Options' one child is enabled: it must stay enabled); a group left
    // enabled when ALL children are (Social, Profile: A would enter a sub-list of dead rows); a
    // reason missing, the same for every row (Bag has its own), a group reason other than the
    // in-battle one, or a reason frozen in en under fr; an A on a disabled row that still emits
    // `open` (the box or the quest log would show over the battle) or that does nothing silently
    // (CTL6C.3 wants the catalogued reason shown); a pick that bypasses the check; a feedback line
    // that survives a cursor move; a repeat A that shows it; an enabled row (Close, How to play)
    // whose effect changed; and a WORLD menu that now disables Journal, Social or Rankings (the
    // decision holds over a battle only).
    const KEYS_ROOT_FLAGS = (s: MainMenuState) =>
      itemsOf(menuViewModel(s).layout).map((i) => [i.key, i.enabled] as const);

    // --- the layouts ------------------------------------------------------------------------
    for (const level of ['root', 'social', 'profile', 'options'] as const) {
      const vm = menuViewModel(battleLevel(level));
      const items = itemsOf(vm.layout);
      expect(
        items.map((i) => i.key),
        `${level}: same rows as the world menu`,
      ).toEqual([...LEVEL_KEYS[level]]);
      const disabled = DISABLED_OVER_BATTLE[level];
      for (const item of items) {
        const row = disabled.find(([key]) => key === item.key);
        if (row === undefined) {
          expect(item.enabled, `${level}/${item.key} stays enabled`).toBe(true);
          expect(item.reason, `${level}/${item.key}: an enabled row has no reason`).toBeUndefined();
        } else {
          expect(item.enabled, `${level}/${item.key} is disabled over a battle`).toBe(false);
          expect(typeof item.reason, `${level}/${item.key} has a reason`).toBe('string');
          expect(
            (item.reason as string).length,
            `${level}/${item.key}: a non-empty reason`,
          ).toBeGreaterThan(0);
          // Groups included: a disabled group carries the in-battle reason exactly.
          expect(item.reason, `${level}/${item.key} reason`).toBe(reasonText(row[1]));
        }
      }
      expect(
        items.filter((i) => !i.enabled).map((i) => i.key),
        `${level}: exactly the literal disabled set`,
      ).toEqual(disabled.map(([key]) => key));
    }
    // INTENTIONAL CHANGE (ctl-6c, supervisor decision option-a: Journal/Rankings stay disabled over a
    // battle until ctl-7a anchors their shells): Journal and Social were `true` here.
    // The root, spelled out once: only Options and Close are enabled.
    expect(KEYS_ROOT_FLAGS(battleMenu())).toEqual([
      ['monsters', false],
      ['bag', false],
      ['journal', false],
      ['social', false],
      ['profile', false],
      ['options', true],
      ['close', true],
    ]);
    expect(
      itemsOf(menuViewModel(battleLevel('options')).layout).map((i) => [i.key, i.enabled]),
      'the Options sub-list: How to play stays enabled',
    ).toEqual([['help', true]]);
    // The flag survives entering a sub-list and a reopen with the same memory.
    expect(battleMenu().battle, 'the state carries the flag').toBe(true);
    // INTENTIONAL CHANGE (ctl-6c, supervisor decision option-a: Journal/Rankings stay disabled over a
    // battle until ctl-7a anchors their shells): the entered sub-list was Social, which can no longer
    // be entered over a battle; Options is the one group that can.
    expect(intoGroup('options', battleMenu()).battle, 'a sub-list keeps it').toBe(true);
    expect(openMainMenu(battleMenu().memory, true).battle).toBe(true);
    expect(openMainMenu(battleMenu().memory).battle, 'the default is the world menu').toBe(false);
    expect(openMainMenu(battleMenu().memory, false).battle).toBe(false);
    expect(
      KEYS_ROOT_FLAGS(openMainMenu(battleMenu().memory, false)).every(([, enabled]) => enabled),
      'a reopen at the world (same memory) enables everything again',
    ).toBe(true);

    // --- the world menu is unchanged ---------------------------------------------------------
    for (const level of ['root', 'social', 'profile', 'options'] as const) {
      const world =
        level === 'root' ? fresh() : level === 'profile' ? intoGroup('profile') : intoGroup(level);
      expect(
        itemsOf(menuViewModel(world).layout).every((i) => i.enabled && i.reason === undefined),
        `${level}: every world row is enabled with no reason`,
      ).toBe(true);
    }
    expect(fresh().battle, 'a world state is not a battle state').toBe(false);
    // Concretely, the rows the decision disables over a battle still work at the world.
    expect(press(toKey(fresh(), 'journal'), 'A').effect, 'world: Journal opens').toEqual(
      open('questLogView'),
    );
    expect(mainMenuPick(fresh(), 'journal').effect).toEqual(open('questLogView'));
    expect(press(toKey(fresh(), 'social'), 'A').state.level, 'world: Social enters').toBe('social');
    expect(
      press(toKey(intoGroup('social'), 'rankings'), 'A').effect,
      'world: Rankings opens',
    ).toEqual(open('leaderboardView'));
    expect(mainMenuPick(intoGroup('social'), 'rankings').effect).toEqual(open('leaderboardView'));

    // --- A and a pick on a disabled row ------------------------------------------------------
    for (const level of ['root', 'social', 'profile', 'options'] as const) {
      for (const [key, kind] of DISABLED_OVER_BATTLE[level]) {
        const at = (from: MainMenuState): MainMenuState => toKey(from, key);
        const state = at(battleLevel(level));
        const want = { kind: 'info', text: reasonText(kind) };
        const a = press(state, 'A');
        expect(a.effect, `A on disabled ${level}/${key} does nothing`).toEqual(NONE);
        expect(a.state.feedback, `A on disabled ${level}/${key} shows its reason`).toEqual(want);
        expect(a.state.level, `A on disabled ${level}/${key} does not change level`).toBe(level);
        expect(a.state.nav.item, `${level}/${key}: the cursor stays`).toBe(key);
        expect(a.state.battle, `${level}/${key}: still a battle menu`).toBe(true);
        expect(menuViewModel(a.state).feedback, 'the view model carries it').toEqual(want);

        const picked = mainMenuPick(battleLevel(level), key);
        expect(picked.effect, `a pick of disabled ${level}/${key} does nothing`).toEqual(NONE);
        expect(
          picked.state.feedback,
          `a pick of disabled ${level}/${key} shows the reason`,
        ).toEqual(want);
        expect(picked.state.level, `a pick of ${level}/${key} does not enter or leave`).toBe(level);
        expect(picked.state.nav.item, `a pick moves the cursor to ${level}/${key}`).toBe(key);

        // A repeat A shows nothing; a move clears the line.
        const repeat = press(state, 'A', true);
        expect(repeat.effect).toEqual(NONE);
        expect(repeat.state.feedback, 'a repeat A is not an activation').toEqual({ kind: 'none' });
        const moved = press(a.state, 'Down');
        expect(moved.state.feedback, 'a cursor move clears the reason').toEqual({ kind: 'none' });
      }
    }
    // Concretely, in order: Monsters, Bag, Journal, the Social group, the Profile group.
    const monsters = press(battleMenu(), 'A');
    expect(monsters.effect).toEqual(NONE);
    expect(monsters.state.feedback).toEqual({ kind: 'info', text: 'Not during a battle' });
    const bag = press(toKey(battleMenu(), 'bag'), 'A');
    expect(bag.effect).toEqual(NONE);
    expect(bag.state.feedback).toEqual({
      kind: 'info',
      text: 'Use items from the battle Bag command',
    });
    // INTENTIONAL CHANGE (ctl-6c, supervisor decision option-a: Journal/Rankings stay disabled over a
    // battle until ctl-7a anchors their shells): A and a pick on Journal opened the quest log over
    // the battle, A on Social entered it, and A or a pick on Rankings opened the leaderboard.
    const journal = press(toKey(battleMenu(), 'journal'), 'A');
    expect(journal.effect, 'Journal opens nothing over a battle').toEqual(NONE);
    expect(journal.state.feedback).toEqual({ kind: 'info', text: 'Not during a battle' });
    expect(mainMenuPick(battleMenu(), 'journal').effect, 'nor does a pick').toEqual(NONE);
    const social = press(toKey(battleMenu(), 'social'), 'A');
    expect(social.effect).toEqual(NONE);
    expect(social.state.level, 'the disabled Social group is not entered').toBe('root');
    expect(social.state.nav.item).toBe('social');
    expect(social.state.feedback).toEqual({ kind: 'info', text: 'Not during a battle' });
    expect(mainMenuPick(battleMenu(), 'social').state.level, 'nor by a pick').toBe('root');
    expect(press(toKey(battleLevel('social'), 'rankings'), 'A').effect).toEqual(NONE);
    expect(mainMenuPick(battleLevel('social'), 'rankings').effect).toEqual(NONE);
    expect(press(toKey(battleMenu(), 'profile'), 'A').state.level, 'Profile stays shut').toBe(
      'root',
    );

    // --- the enabled rows behave exactly as in the world --------------------------------------
    expect(press(toKey(battleMenu(), 'close'), 'A').effect).toEqual(CLOSE);
    expect(mainMenuPick(battleMenu(), 'close').effect).toEqual(CLOSE);
    const options = press(toKey(battleMenu(), 'options'), 'A');
    expect(options.effect).toEqual(NONE);
    expect(options.state.level, 'Options enters').toBe('options');
    expect(options.state.nav.item, 'on How to play').toBe('help');
    expect(options.state.feedback, 'with no reason shown').toEqual({ kind: 'none' });
    expect(options.state.battle).toBe(true);
    const help = press(options.state, 'A');
    expect(help.effect, 'How to play opens help over the battle').toEqual(open('helpView'));
    expect(help.state.feedback).toEqual({ kind: 'none' });
    expect(mainMenuPick(battleLevel('options'), 'help').effect).toEqual(open('helpView'));
    expect(mainMenuPick(battleMenu(), 'options').state.level, 'a pick enters Options').toBe(
      'options',
    );
    // B from a battle sub-list returns to the root with the group's entry under the cursor.
    // INTENTIONAL CHANGE (ctl-6c, supervisor decision option-a: Journal/Rankings stay disabled over a
    // battle until ctl-7a anchors their shells): the sub-list was Social, which can no longer be
    // entered over a battle; Options is.
    const back = press(options.state, 'B');
    expect(back.state.level).toBe('root');
    expect(back.state.nav.item).toBe('options');
    expect(back.state.battle, 'the flag survives B').toBe(true);

    // --- locales: the reasons are resolved at press / view time -----------------------------
    expect(t('menu.disabled.inBattle'), 'the en reason').toBe('Not during a battle');
    expect(t('menu.disabled.battleBag'), 'the en Bag reason').toBe(
      'Use items from the battle Bag command',
    );
    setLocale('fr');
    const frId = (CATALOG_FR as unknown as Record<string, string>)['menu.disabled.inBattle'];
    const frBag = (CATALOG_FR as unknown as Record<string, string>)['menu.disabled.battleBag'];
    expect(frId, 'fixture: fr has its own reason').toBeTypeOf('string');
    expect(frId).not.toBe('Not during a battle');
    expect(frBag).not.toBe('Use items from the battle Bag command');
    expect(t('menu.disabled.inBattle')).toBe(frId);
    const frRoot = itemsOf(menuViewModel(battleMenu()).layout);
    expect(frRoot.find((i) => i.key === 'monsters')?.reason, 'view model reasons are fr').toBe(
      frId,
    );
    expect(frRoot.find((i) => i.key === 'bag')?.reason).toBe(frBag);
    expect(frRoot.find((i) => i.key === 'journal')?.reason, 'Journal reason in fr').toBe(frId);
    expect(frRoot.find((i) => i.key === 'social')?.reason, 'Social group reason in fr').toBe(frId);
    const frA = press(battleMenu(), 'A');
    expect(frA.state.feedback, 'A shows the fr reason').toEqual({ kind: 'info', text: frId });
    const frPick = mainMenuPick(battleMenu(), 'bag');
    expect(frPick.state.feedback, 'a pick shows the fr Bag reason').toEqual({
      kind: 'info',
      text: frBag,
    });
  });
});
