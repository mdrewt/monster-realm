// ui/screens/mainMenuScreen.test.ts — ctl-5 (CTL5.1 to CTL5.5): the PURE main-menu reducer.
//
// Node env, no DOM, no mocks: `openMainMenu(memory)`, `mainMenuStep(state, input)`,
// `mainMenuPick(state, key)` and `menuViewModel(state)` are driven with plain values and the
// outcome is read from the returned `{ state, effect }`. The nav kit (`ui/nav.ts`) is the real one:
// these cases prove the SCREEN's rules on top of it (A opens a child and leaves the menu in
// place, B closes, Y describes, memory recalls the last entry).
//
// The contract the shell relies on:
//   one list       uif-15c (UIF15C.1): the menu is ONE flat list of eight rows under one frame id
//                  ('menu'); there is no level, no sub-list and no breadcrumb (Social, Profile, and
//                  now How to Play and Controls are root leaves). `MainMenuState` has no `level`.
//   effects        none | { open, target } | close. A on a leaf leaves the STATE where it is
//                  (the menu stays open beneath the child).
//   memory         updated on every step, immutable (a step never mutates the map it was given).
//   close rule     UIF15C.3: a menu left with the cursor on Close reopens on the FIRST entry.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stripComments } from '../../../test-util/stripComments';
import type { VButton } from '../../input/buttons';
import { CATALOG_FR } from '../i18n/catalog.fr';
import { setLocale, t } from '../i18n/resolver';
import type { MenuTarget } from '../menuModel';
import {
  EMPTY_NAV_MEMORY,
  type NavItem,
  type NavLayout,
  type NavMemory,
  recallNav,
  rememberNav,
} from '../nav';
import {
  type MainMenuState,
  type MenuEffect,
  mainMenuPick,
  mainMenuStep,
  menuViewModel,
  openMainMenu,
} from './mainMenuScreen';

// uif-15c (UIF15C.1, named intentional change): Options is replaced by two root rows, help then
// controls. Was: [..., 'profile', 'options', 'close'] with options: ['help', 'controls'].
// uif-15b (UIF15B.1, named intentional change): Social is a root leaf, not a group, so the
// 'menuSocial' sub-list level is gone. Was: social: ['trades', 'challenges', 'rankings'].
// uif-16b (UIF16B.1, named intentional change): Profile is a root leaf that opens the one Profile
// frame, so the 'menuProfile' sub-list level is gone. Was: profile: ['name', 'account', 'privacy'].
const ROOT_KEYS = ['monsters', 'bag', 'journal', 'social', 'profile', 'help', 'controls', 'close'];
const OTHER_KEYS = ROOT_KEYS.filter((k) => k !== 'close');

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

/** A hand-built session memory whose 'menu' cursor was left on `key`. */
const memoryOn = (key: string): NavMemory =>
  rememberNav(EMPTY_NAV_MEMORY, 'menu', { tab: null, item: key, perTab: {} });

afterEach(() => {
  setLocale('en');
});

describe('mainMenu — open and wrap', () => {
  it('CTL5-1-WRAP: the menu opens on Monsters as a wrapping list: fresh Up from the first lands on Close, fresh Down from Close on Monsters, a full cycle visits every entry', () => {
    // uif-15c (named intentional change): eight entries; the Options sub-list wrap case is gone
    // with the sub-list.
    // WRONG IMPL KILLED: a clamp instead of a wrap (a fresh press at an end must wrap, the repeat
    // path is the clamp: CTL5-5-REPEAT-CLAMPS), a wrap that skips Close or stops short of the
    // last row, a cursor that does not start on the first entry, and entries in another order.
    const start = fresh();
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
    expect(seen, 'eight Downs visit every entry in order and return').toEqual([
      ...ROOT_KEYS,
      'monsters',
    ]);
    s = start;
    const back: Array<string | null> = [];
    for (let i = 0; i < ROOT_KEYS.length; i += 1) {
      s = press(s, 'Up').state;
      back.push(s.nav.item);
    }
    expect(back, 'eight Ups visit every entry in reverse').toEqual([
      'close',
      'controls',
      'help',
      'profile',
      'social',
      'journal',
      'bag',
      'monsters',
    ]);
  });

  it('CTL5-5-REPEAT-CLAMPS: a repeat-flagged D-pad edge clamps at the ends of the list while a fresh edge wraps; a repeat A does nothing', () => {
    // uif-15c (named intentional change): the sub-list clamp case is gone with the sub-list.
    // WRONG IMPL KILLED: a screen that drops the `repeat` flag on the way to the kit (a held key
    // would spin around the list), one that clamps every edge (fresh wrap lost), and a repeat A that
    // activates (an OS-repeat Enter must not open twice).
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

    const onJournal = toKey(fresh(), 'journal');
    const repeatA = press(onJournal, 'A', true);
    expect(repeatA.effect, 'a repeat A is not an activation').toEqual(NONE);
    expect(repeatA.state.nav.item).toBe('journal');
    const repeatOnClose = press(atLast, 'A', true);
    expect(repeatOnClose.effect, 'and a repeat A on Close does not close').toEqual(NONE);
    const repeatOnControls = press(toKey(fresh(), 'controls'), 'A', true);
    expect(repeatOnControls.effect, 'nor does a repeat A on Controls open').toEqual(NONE);
  });
});

describe('mainMenu — A, B and the one list', () => {
  it("CTL5-2-A-OPENS-CHILD: A on a leaf emits open with that entry's overlay and leaves the menu in place beneath it; A on Close closes; every target is distinct", () => {
    // uif-15c (named intentional change, UIF15C.1): help and controls are root leaves (helpView,
    // controlsView), pressed from the root; there is no sub-list to enter. Was: pressed inside the
    // Options group, with `state.level === 'options'` afterwards.
    // WRONG IMPL KILLED: an A that closes the menu before opening (the old activateMenuLeaf: B
    // could never come back), an `open` carrying the wrong overlay (a neighbouring entry's, or
    // help <-> controls swapped), a leaf whose A also moves the cursor (the menu would not be
    // "where it was" on return), and an A on Close that opens something.
    const rootLeaves: ReadonlyArray<readonly [string, MenuTarget]> = [
      ['monsters', 'boxView'],
      ['bag', 'raisingView'],
      ['journal', 'questLogView'],
      // uif-15b (UIF15B.1, named intentional change): Social is a root leaf for the Social frame.
      ['social', 'social'],
      // uif-16b (UIF16B.1, named intentional change): Profile is a root leaf for the Profile frame.
      ['profile', 'profileView'],
      ['help', 'helpView'],
      // ctl-12b (named intentional change): the Controls leaf opens the Controls frame.
      ['controls', 'controlsView'],
    ];
    const targets: MenuTarget[] = [];
    for (const [key, target] of rootLeaves) {
      const on = toKey(fresh(), key);
      const step = press(on, 'A');
      expect(step.effect, `A on ${key}`).toEqual(open(target));
      expect(step.state.nav.item, `${key}: the cursor stays on the entry`).toBe(key);
      expect(step.state.feedback, `${key}: nothing else changed`).toEqual(on.feedback);
      targets.push(target);
    }
    // uif-15c: 7 root leaves, none in a sub-list. Was: 5 root leaves + 2 sub-list leaves = 7.
    expect(new Set(targets).size, 'seven distinct targets, one per leaf').toBe(7);
    expect(targets, 'ANTI-VACUITY: every leaf was pressed').toHaveLength(7);

    const close = press(toKey(fresh(), 'close'), 'A');
    expect(close.effect, 'A on Close closes the menu').toEqual(CLOSE);
  });

  it('UIF15C.1 CTL5-2-B-AT-ROOT-CLOSES: B (fresh) at EVERY cursor closes the menu and leaves the state exactly as it was; a repeat B does nothing', () => {
    // LEGACY BEHAVIOUR REPLACED: CTL5-2-GROUP-PUSH-B-RETURNS (A on Options entered a sub-list on the
    // first child under a Menu breadcrumb; B popped it back to the group entry, a second B closed).
    // WRONG IMPL KILLED: a B that does nothing at some cursor (the menu could only close through
    // Close or Escape); one that closes only from the first entry; a B that mutates the state (the
    // cursor jumps, the feedback clears, the memory changes) on its way out; a repeat B that
    // closes (an OS-repeat Backspace would close a menu the next open then eats); a B that
    // "returns to the root" with a state change (leftover group-pop code).
    for (const key of ROOT_KEYS) {
      const on = toKey(fresh(), key);
      const step = press(on, 'B');
      expect(step.effect, `B on ${key}`).toEqual(CLOSE);
      expect(step.state, `B on ${key} leaves the state untouched`).toBe(on);
      const repeat = press(on, 'B', true);
      expect(repeat.effect, `a repeat B on ${key} does nothing`).toEqual(NONE);
      expect(repeat.state, `a repeat B on ${key} leaves the state untouched`).toBe(on);
    }
    // Over a battle too, and with a feedback line showing.
    const reasoned = press(toKey(openMainMenu(EMPTY_NAV_MEMORY, true), 'controls'), 'A').state;
    expect(reasoned.feedback.kind, 'fixture: a reason is showing').toBe('info');
    const out = press(reasoned, 'B');
    expect(out.effect).toEqual(CLOSE);
    expect(out.state).toBe(reasoned);
  });

  it('CTL5-2-RIGHT-NO-ACTIVATE: Left and Right (fresh or repeat) never activate an entry, close or move the cursor', () => {
    // uif-15c (named intentional change): the sub-list half is gone with the sub-list.
    // WRONG IMPL KILLED: the old menuKeyInput that mapped ArrowRight/KeyD to "enter" (B18): Right
    // on a leaf would open the child, Right on Close would close.
    for (const key of ROOT_KEYS) {
      const on = toKey(fresh(), key);
      for (const button of ['Right', 'Left'] as const) {
        for (const repeat of [false, true]) {
          const step = press(on, button, repeat);
          expect(step.effect, `${button}${repeat ? ' (repeat)' : ''} on ${key}`).toEqual(NONE);
          expect(step.state.nav.item, `${button} on ${key} keeps the cursor`).toBe(key);
        }
      }
    }
  });
});

describe('mainMenu — memory and Y', () => {
  it('CTL5-3-RECALL-LAST-USED: reopening with the returned memory puts the cursor on the last entry used, and a step never mutates the memory it was given', () => {
    // uif-15c (named intentional change): the "closed from inside a sub-list" half is gone with the
    // sub-list; the reopened cursor is the last root entry.
    // WRONG IMPL KILLED: an `openMainMenu` that always starts on the first entry (CTL5.3 would
    // not hold), memory written only on close or only on A, a memory map mutated in place (the
    // shared EMPTY_NAV_MEMORY would leak a cursor into every later session), and a recall that
    // returns a stale cursor after later moves.
    const before = EMPTY_NAV_MEMORY.size;
    const onJournal = toKey(fresh(), 'journal');
    const reopened = openMainMenu(onJournal.memory);
    expect(reopened.nav.item, 'the last entry used').toBe('journal');
    expect(EMPTY_NAV_MEMORY.size, 'the shared empty memory is never written').toBe(before);
    expect(openMainMenu(EMPTY_NAV_MEMORY).nav.item, 'a fresh session starts on the first').toBe(
      'monsters',
    );

    // Later moves replace the recalled entry.
    const moved = press(reopened, 'Down').state;
    expect(moved.nav.item).toBe('social');
    expect(openMainMenu(moved.memory).nav.item, 'the most recent cursor wins').toBe('social');

    // The newly rooted rows are remembered like any other.
    const onControls = toKey(fresh(), 'controls');
    expect(openMainMenu(onControls.memory).nav.item).toBe('controls');

    // The memory is keyed by the frame the view model names, not by an unrelated key.
    const vm = menuViewModel(onJournal);
    expect(vm.frameId).toBe('menu');
    expect(recallNav(onJournal.memory as NavMemory, vm.frameId)?.item).toBe('journal');

    // Stepping does not mutate the memory object that came in.
    const snapshot = new Map(onJournal.memory);
    press(onJournal, 'Down');
    press(onJournal, 'Up');
    expect(new Map(onJournal.memory), 'the input memory is untouched').toEqual(snapshot);
  });

  it('UIF15C.3 the Close rule: a menu left with the cursor on Close reopens on the FIRST entry, however it was left there (A, pointer pick, Up-wrap then B, Up-wrap then reopen), in the world and over a battle', () => {
    // WRONG IMPL KILLED: no rule at all (the menu reopens ON Close, one Start press from closing
    // itself again; every entry is then reached from the wrong end); a rule that fires only after
    // A on Close (the pointer pick, and the Up-wrap-then-B and Up-wrap-then-reopen routes, all
    // leave the cursor on Close and skip the A path); a rule keyed to the WORLD only (over a battle
    // Monsters is disabled and the reopen must still land on items[0], exactly what a fresh open
    // does); a rule that opens on the first ENABLED entry over a battle (Help) instead of the
    // first entry; a rule implemented in the shell (the pure openMainMenu below is called
    // directly, so a main.ts-only rule is invisible here and reds).
    for (const battle of [false, true]) {
      const where = battle ? 'battle' : 'world';
      const first = openMainMenu(EMPTY_NAV_MEMORY, battle);
      expect(first.nav.item, `${where}: a fresh open lands on the first entry`).toBe('monsters');

      const routes: ReadonlyArray<readonly [string, NavMemory]> = [
        [
          'A on Close',
          (() => {
            const step = press(toKey(openMainMenu(EMPTY_NAV_MEMORY, battle), 'close'), 'A');
            expect(step.effect, `${where}: fixture: A on Close closes`).toEqual(CLOSE);
            return step.state.memory;
          })(),
        ],
        [
          'a pointer pick of Close',
          (() => {
            const step = mainMenuPick(openMainMenu(EMPTY_NAV_MEMORY, battle), 'close');
            expect(step.effect, `${where}: fixture: a pick of Close closes`).toEqual(CLOSE);
            return step.state.memory;
          })(),
        ],
        [
          'Up-wrap to Close then B',
          (() => {
            const wrapped = press(openMainMenu(EMPTY_NAV_MEMORY, battle), 'Up').state;
            expect(wrapped.nav.item, `${where}: fixture: Up wraps to Close`).toBe('close');
            const step = press(wrapped, 'B');
            expect(step.effect).toEqual(CLOSE);
            return step.state.memory;
          })(),
        ],
        [
          'Up-wrap to Close then reopen',
          press(openMainMenu(EMPTY_NAV_MEMORY, battle), 'Up').state.memory,
        ],
        ['a hand-built memory on close', memoryOn('close')],
      ];
      for (const [route, memory] of routes) {
        expect(
          recallNav(memory, 'menu')?.item,
          `${where}/${route}: fixture: the remembered cursor is close`,
        ).toBe('close');
        const reopened = openMainMenu(memory, battle);
        expect(reopened.nav.item, `${where}/${route}: reopens on the first entry`).toBe('monsters');
        expect(reopened.nav, `${where}/${route}: exactly what a fresh open lands on`).toEqual(
          first.nav,
        );
        expect(reopened.feedback, `${where}/${route}: no feedback`).toEqual({ kind: 'none' });
        expect(reopened.battle, `${where}/${route}: the battle flag is the caller's`).toBe(battle);
        // The rule is idempotent: reopening the reopened menu's memory stays on the first entry.
        expect(openMainMenu(reopened.memory, battle).nav.item).toBe('monsters');
      }
    }
  });

  it('UIF15C.3 every OTHER remembered cursor reopens on exactly that entry, in the world and over a battle, whether the memory was built by walking or by hand', () => {
    // WRONG IMPL KILLED: a rule that always opens on the first entry (the recall of CTL5.3 lost); a
    // rule that special-cases the wrong key (a remembered `controls`, the last row before Close,
    // or `help`, reopening on Monsters or on Close); a rule that fires only in the world (or only
    // over a battle, where the remembered key may be a disabled row such as `controls`).
    expect(OTHER_KEYS, 'ANTI-VACUITY: all seven non-Close keys').toHaveLength(7);
    for (const battle of [false, true]) {
      for (const key of OTHER_KEYS) {
        const walked = toKey(openMainMenu(EMPTY_NAV_MEMORY, battle), key).memory;
        const byHand = memoryOn(key);
        for (const [how, memory] of [
          ['walked', walked],
          ['by hand', byHand],
        ] as const) {
          const reopened = openMainMenu(memory, battle);
          expect(
            reopened.nav.item,
            `${battle ? 'battle' : 'world'}/${how}: ${key} reopens on ${key}`,
          ).toBe(key);
        }
      }
    }
  });

  it('CTL5-4-Y-DESCRIBES: Y shows the entry description on the feedback line without moving or opening, any move clears it, and the text is resolved in the current locale', () => {
    // WRONG IMPL KILLED: a Y that opens or closes, one that shows the TITLE or another entry's
    // description, a feedback line that survives a cursor move (stale text under a new entry),
    // description text frozen in en under fr, and a Y that moves the cursor.
    const onJournal = toKey(fresh(), 'journal');
    expect(onJournal.feedback, 'control: nothing is shown before Y').toEqual({ kind: 'none' });
    const y = press(onJournal, 'Y');
    expect(y.effect).toEqual(NONE);
    expect(y.state.nav.item, 'Y does not move').toBe('journal');
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

    // uif-15c (named intentional change): Controls and How to Play describe themselves from the
    // root. Was: Options > Controls inside the sub-list.
    const controls = press(toKey(fresh(), 'controls'), 'Y');
    expect(controls.state.feedback).toEqual({
      kind: 'info',
      text: 'Choose which key presses each button.',
    });
    expect(controls.effect, 'Y opens nothing').toEqual(NONE);
    const help = press(toKey(fresh(), 'help'), 'Y');
    expect(help.state.feedback).toEqual({
      kind: 'info',
      text: 'Controls and goals of the game.',
    });

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
  it('UIF15C.1 the menu state has no level: not on a fresh open, a step, a pick, a Y, a battle open or a reopen', () => {
    // WRONG IMPL KILLED: a vestigial `level: 'root'` kept on the state "for later" (the field the
    // old group machinery read; every group case would still compile against it) on ANY path that
    // builds a state: open, a D-pad step, a pick, Y, the battle open, the reopen.
    const states: ReadonlyArray<readonly [string, MainMenuState]> = [
      ['fresh open', fresh()],
      ['battle open', openMainMenu(EMPTY_NAV_MEMORY, true)],
      ['after Down', press(fresh(), 'Down').state],
      ['after Y', press(fresh(), 'Y').state],
      ['after A on a leaf', press(fresh(), 'A').state],
      ['after a pick of a leaf', mainMenuPick(fresh(), 'controls').state],
      ['after a pick of an unknown key', mainMenuPick(fresh(), 'options').state],
      ['after a disabled A', press(openMainMenu(EMPTY_NAV_MEMORY, true), 'A').state],
      ['after B', press(fresh(), 'B').state],
      ['a reopen', openMainMenu(toKey(fresh(), 'bag').memory)],
      ['a Close-rule reopen', openMainMenu(memoryOn('close'))],
    ];
    for (const [how, state] of states) {
      expect('level' in state, `${how}: no level field`).toBe(false);
      expect(Object.keys(state).sort(), `${how}: exactly the four fields`).toEqual([
        'battle',
        'feedback',
        'memory',
        'nav',
      ]);
    }
  });

  it('UIF15B.1 A on the root Social row opens the Social frame and leaves the cursor on Social; no frame id for a Social sub-list exists', () => {
    // WRONG IMPL KILLED: Social still a group (A would change the state's shape); an open effect aimed
    // at a legacy overlay (tradeView); an A that also moves the cursor (B from the Social frame
    // would not return to the same menu); a menu whose view model ever names a 'menuSocial' frame;
    // a root cursor memory that loses Social.
    const on = toKey(fresh(), 'social');
    const step = press(on, 'A');
    expect(step.effect, 'A on Social opens the Social frame').toEqual(open('social'));
    expect(step.state.nav.item, 'the cursor stays on Social').toBe('social');
    expect(step.state.feedback, 'nothing else changed').toEqual(on.feedback);
    expect(menuViewModel(step.state).frameId, 'the root frame id, never menuSocial').toBe('menu');
    expect(openMainMenu(step.state.memory).nav.item, 'a reopen lands on Social').toBe('social');
  });

  it('UIF16B.1 A on the root Profile row opens the one Profile frame and leaves the cursor on Profile; no frame id for a Profile sub-list exists', () => {
    // WRONG IMPL KILLED: Profile still a group (the Name / Account / Privacy sub-list UIF16B.1
    // retires); an open aimed at one section's old overlay (renameView, claimView); an A that also
    // moves the cursor (B from Profile would not return to the same menu); a view model that ever
    // names a 'menuProfile' frame; a root cursor memory that loses Profile.
    const on = toKey(fresh(), 'profile');
    const step = press(on, 'A');
    expect(step.effect, 'A on Profile opens the Profile frame').toEqual(open('profileView'));
    expect(step.state.nav.item, 'the cursor stays on Profile').toBe('profile');
    expect(step.state.feedback, 'nothing else changed').toEqual(on.feedback);
    expect(menuViewModel(step.state).frameId, 'the root frame id, never menuProfile').toBe('menu');
    expect(openMainMenu(step.state.memory).nav.item, 'a reopen lands on Profile').toBe('profile');
    const picked = mainMenuPick(fresh(), 'profile');
    expect(picked.effect, 'a pick is the same leaf').toEqual(open('profileView'));
  });

  it('a pick moves the cursor to the key and then behaves as A: a leaf opens, Close closes', () => {
    // uif-15c (named intentional change): the "a group enters" half is gone; a pick of help or
    // controls opens helpView / controlsView straight from the root. Was: mainMenuPick(fresh(),
    // 'options') entered the sub-list, then a second pick of 'controls' opened it.
    // WRONG IMPL KILLED: a pick that opens without moving the cursor (the menu would return to
    // the wrong entry), a pick that needs the cursor to be there already, and a pick that is not
    // the same code path as A (different effect for the same entry).
    const leaf = mainMenuPick(fresh(), 'journal');
    expect(leaf.effect).toEqual(open('questLogView'));
    expect(leaf.state.nav.item, 'the cursor follows the click').toBe('journal');

    expect(mainMenuPick(fresh(), 'social').effect).toEqual(open('social'));
    expect(mainMenuPick(fresh(), 'profile').effect).toEqual(open('profileView'));
    expect(mainMenuPick(fresh(), 'close').effect).toEqual(CLOSE);

    for (const [key, target] of [
      ['help', 'helpView'],
      ['controls', 'controlsView'],
    ] as const) {
      const viaPick = mainMenuPick(fresh(), key);
      const viaKeys = press(toKey(fresh(), key), 'A');
      expect(viaPick.effect, `a pick of ${key}`).toEqual(open(target));
      expect(viaPick.effect).toEqual(viaKeys.effect);
      expect(viaPick.state.nav, 'same cursor either way').toEqual(viaKeys.state.nav);
      expect(viaPick.state.nav.item).toBe(key);
    }
  });

  it('a pick of a key that is not on the list is a no-op and never falls through to the cursor entry', () => {
    // uif-15c (named intentional change): 'options' joins the foreign keys (it is no longer a key),
    // and the "root key picked while a sub-list is showing" half is gone with the sub-list.
    // WRONG IMPL KILLED (plan A5): `navFocus` ignores an unknown key and the A rule then fires on
    // whatever the cursor already stands on (a stale or forged data-nav-key would open the
    // Journal), a prototype-name key that matches an inherited property, and the retired Options
    // key still resolving to something.
    const onJournal = toKey(fresh(), 'journal');
    for (const key of [
      'nope',
      '',
      'toString',
      '__proto__',
      'constructor',
      'trades',
      'Journal',
      'options',
      'name',
    ]) {
      const step = mainMenuPick(onJournal, key);
      expect(step.effect, `pick '${key}' at the root`).toEqual(NONE);
      expect(step.state.nav.item, `pick '${key}' keeps the cursor`).toBe('journal');
    }
  });

  it('UIF15C.1 menuViewModel names ONE frame, titled Menu with no breadcrumb, listing the eight rows with their English labels, and resolves labels at call time', () => {
    // LEGACY BEHAVIOUR REPLACED: the per-level frame ids / titles / breadcrumbs (the Options level
    // was 'menuOptions', titled Options, crumbs ['Menu']).
    // WRONG IMPL KILLED: a frame id other than 'menu' on any state (a 'menuOptions' left behind, or
    // the nav ids `menuOptions-root-*` for the help / controls rows); a title that is not the menu
    // title; a non-empty breadcrumb; labels that are catalog ids instead of text, labels frozen in
    // en, a layout with disabled entries at the world, and a feedback or cursor that is not the
    // state's own.
    const root = menuViewModel(fresh());
    expect(root.frameId).toBe('menu');
    expect(root.title).toBe(t('menu.title'));
    expect(root.title).toBe('Menu');
    expect(root.crumbs).toEqual([]);
    expect(itemsOf(root.layout).every((i) => i.enabled)).toBe(true);
    expect(root.labels).toEqual({
      monsters: 'Monsters',
      bag: 'Inventory',
      journal: 'Journal',
      social: 'Social',
      profile: 'Profile',
      help: 'How to Play',
      controls: 'Controls',
      close: 'Close',
    });
    expect(Object.keys(root.labels), 'labels in display order').toEqual(ROOT_KEYS);
    expect(root.nav).toEqual(fresh().nav);
    expect(root.feedback).toEqual({ kind: 'none' });

    // The same single frame on every state that can occur: a step, a pick, a battle open, a Y.
    for (const state of [
      press(fresh(), 'Down').state,
      mainMenuPick(fresh(), 'controls').state,
      openMainMenu(EMPTY_NAV_MEMORY, true),
      press(toKey(fresh(), 'help'), 'Y').state,
      press(openMainMenu(EMPTY_NAV_MEMORY, true), 'A').state,
    ]) {
      const vm = menuViewModel(state);
      expect(vm.frameId).toBe('menu');
      expect(vm.title).toBe('Menu');
      expect(vm.crumbs).toEqual([]);
      expect(itemsOf(vm.layout).map((i) => i.key)).toEqual(ROOT_KEYS);
    }

    setLocale('fr');
    expect(menuViewModel(fresh()).labels.monsters, 'labels follow the locale').toBe('Monstres');
    expect(menuViewModel(fresh()).labels.close).toBe('Fermer');
    expect(menuViewModel(fresh()).labels.help).toBe('Comment jouer');
    expect(menuViewModel(fresh()).labels.controls).toBe('Commandes');
  });

  it('buttons the menu does not use (X, LB, RB, Start, Select) do nothing: no effect, no move', () => {
    // WRONG IMPL KILLED: a catch-all arm that treats any non-D-pad button as A or as B.
    const on = toKey(fresh(), 'bag');
    for (const button of ['X', 'LB', 'RB', 'Start', 'Select'] as const) {
      const step = press(on, button);
      expect(step.effect, button).toEqual(NONE);
      expect(step.state.nav.item, button).toBe('bag');
    }
  });
});

describe('mainMenu — source (UIF15C.1)', () => {
  it('UIF15C.1 mainMenuScreen.ts (comments stripped) holds no group, menuOptions, MenuLevel or FRAME_IDS machinery', () => {
    // WRONG IMPL KILLED: the level / group machinery deleted from the types but kept as dead code
    // (a `case 'group'` arm, a FRAME_IDS table with one entry, a MenuLevel alias, an 'menuOptions'
    // frame id); the stripped-source scan ignores comments so a narrating comment does not red it.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'mainMenuScreen.ts'),
      'utf8',
    );
    const code = stripComments(src);
    expect(code.length, 'ANTI-VACUITY: the stripped source is real').toBeGreaterThan(500);
    expect(code).toContain('openMainMenu');
    expect(code).not.toMatch(/group/i);
    expect(code).not.toContain('menuOptions');
    expect(code).not.toContain('MenuLevel');
    expect(code).not.toContain('FRAME_IDS');
  });

  it('UIF15C.1 main.ts (comments stripped) reads no level off the menu state and names no menuOptions frame or MenuLevel', () => {
    // WRONG IMPL KILLED: the shell still comparing `step.state.level !== menuState.level` to reset
    // the repeat on a level change (a dead read of a field the state no longer has: it compiles to
    // `undefined !== undefined` and silently never fires); a leftover 'menuOptions' frame id or
    // MenuLevel import in the shell. The scan ignores comments so a narrating comment is fine.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'main.ts'),
      'utf8',
    );
    const code = stripComments(src);
    expect(code.length, 'ANTI-VACUITY: the stripped shell source is real').toBeGreaterThan(5000);
    expect(code, 'ANTI-VACUITY: the shell holds the menu state').toContain('menuState');
    expect(code).not.toContain('menuState.level');
    expect(code).not.toContain('step.state.level');
    expect(code).not.toContain('MenuLevel');
    expect(code).not.toContain('menuOptions');
  });
});

// ==========================================================================================
// ctl-6c: the menu over a battle (CTL6C.3): only How to Play and Close stay enabled
// ==========================================================================================
//
// `openMainMenu(memory, battle = false)` carries `battle` in the state. Over a battle the layout
// marks `enabled:false` (with a `reason`) every `open` entry whose target screen is not battleSafe,
// plus the Journal entry; nothing else. A (and a pick) on a disabled row does nothing and shows
// that row's reason on the feedback line. World mode is unchanged.
//
// INTENTIONAL CHANGE (ctl-6c, supervisor decision option-a: Journal stays disabled over a battle
// until ctl-7a anchors its shell). The quest log is battleSafe in SCREEN_POLICY, but its legacy
// shell is in-flow and paints UNDER the battle overlay, so the menu disables it over a battle.
//
// The expected sets are HARD-CODED literals (the spec's table and the decision), not derived from
// SCREEN_POLICY.

const IN_BATTLE = 'inBattle';
const BAG_REASON = 'battleBag';
type ReasonKind = typeof IN_BATTLE | typeof BAG_REASON;
// uif-15c (named intentional change, UIF15C.1): one flat list, so one disabled set. Controls is
// not battle-safe, so it is disabled over a battle with the in-battle reason exactly as before,
// but at the root now; How to Play stays enabled and opens the help frame. Was: root: [monsters,
// bag, journal, social, profile] with the Options group enabled and options: [controls].
const DISABLED_OVER_BATTLE: ReadonlyArray<readonly [string, ReasonKind]> = [
  ['monsters', IN_BATTLE],
  ['bag', BAG_REASON],
  ['journal', IN_BATTLE],
  ['social', IN_BATTLE],
  ['profile', IN_BATTLE],
  ['controls', IN_BATTLE],
];

const battleMenu = (): MainMenuState => openMainMenu(EMPTY_NAV_MEMORY, true);
const reasonText = (kind: ReasonKind): string =>
  kind === BAG_REASON ? t('menu.disabled.battleBag') : t('menu.disabled.inBattle');

describe('mainMenu over a battle (ctl-6c)', () => {
  it('CTL6C-3-MENU-DISABLED-OVER-BATTLE: over a battle only How to Play and Close stay enabled: Monsters, Bag, Journal, Social, Profile and Controls are disabled with their reasons; A or a pick on a disabled row does nothing and shows its reason; the world menu is unchanged; en and fr', () => {
    // uif-15c (named intentional change, UIF15C.1): the Options group and its sub-list rows are
    // gone; help and controls are root rows. Was: Options (enabled group) > help enabled, controls
    // disabled.
    // WRONG IMPL KILLED: a battle layout keyed to `!battleSafe` alone (the pre-decision rule:
    // Journal stays enabled, so the quest log opens over a battle that paints over its in-flow
    // shell); a menu that ignores the battle flag (every row enabled); a menu that disables
    // everything (How to Play or Close disabled: the player could neither read help nor leave the
    // menu by its Close row); a layout built once and reused (the flag changes, the rows do not); a
    // reason missing, the same for every row (Bag has its own), or frozen in en under fr; an A on a
    // disabled row that still emits `open` (the box or the quest log would show over the battle)
    // or that does nothing silently (CTL6C.3 wants the catalogued reason shown); a pick that
    // bypasses the check; a feedback line that survives a cursor move; a repeat A that shows it; an
    // enabled row (Close, How to Play) whose effect changed; and a WORLD menu that now disables
    // Journal (the decision holds over a battle only).
    const flags = (s: MainMenuState) =>
      itemsOf(menuViewModel(s).layout).map((i) => [i.key, i.enabled] as const);

    // --- the layout --------------------------------------------------------------------------
    const items = itemsOf(menuViewModel(battleMenu()).layout);
    expect(
      items.map((i) => i.key),
      'same rows as the world menu',
    ).toEqual(ROOT_KEYS);
    for (const item of items) {
      const row = DISABLED_OVER_BATTLE.find(([key]) => key === item.key);
      if (row === undefined) {
        expect(item.enabled, `${item.key} stays enabled`).toBe(true);
        expect(item.reason, `${item.key}: an enabled row has no reason`).toBeUndefined();
      } else {
        expect(item.enabled, `${item.key} is disabled over a battle`).toBe(false);
        expect(typeof item.reason, `${item.key} has a reason`).toBe('string');
        expect((item.reason as string).length, `${item.key}: a non-empty reason`).toBeGreaterThan(
          0,
        );
        expect(item.reason, `${item.key} reason`).toBe(reasonText(row[1]));
      }
    }
    expect(
      items.filter((i) => !i.enabled).map((i) => i.key),
      'exactly the literal disabled set',
    ).toEqual(DISABLED_OVER_BATTLE.map(([key]) => key));
    // The list, spelled out once: only How to Play and Close are enabled.
    expect(flags(battleMenu())).toEqual([
      ['monsters', false],
      ['bag', false],
      ['journal', false],
      ['social', false],
      ['profile', false],
      ['help', true],
      ['controls', false],
      ['close', true],
    ]);
    // The flag survives a reopen with the same memory.
    expect(battleMenu().battle, 'the state carries the flag').toBe(true);
    expect(openMainMenu(battleMenu().memory, true).battle).toBe(true);
    expect(openMainMenu(battleMenu().memory).battle, 'the default is the world menu').toBe(false);
    expect(openMainMenu(battleMenu().memory, false).battle).toBe(false);
    expect(
      flags(openMainMenu(battleMenu().memory, false)).every(([, enabled]) => enabled),
      'a reopen at the world (same memory) enables everything again',
    ).toBe(true);

    // --- the world menu is unchanged ---------------------------------------------------------
    expect(
      itemsOf(menuViewModel(fresh()).layout).every((i) => i.enabled && i.reason === undefined),
      'every world row is enabled with no reason',
    ).toBe(true);
    expect(fresh().battle, 'a world state is not a battle state').toBe(false);
    // Concretely, the rows the decision disables over a battle still work at the world.
    expect(press(toKey(fresh(), 'journal'), 'A').effect, 'world: Journal opens').toEqual(
      open('questLogView'),
    );
    expect(mainMenuPick(fresh(), 'journal').effect).toEqual(open('questLogView'));
    expect(press(toKey(fresh(), 'social'), 'A').effect, 'world: Social opens').toEqual(
      open('social'),
    );
    expect(mainMenuPick(fresh(), 'social').effect).toEqual(open('social'));
    expect(press(toKey(fresh(), 'profile'), 'A').effect, 'world: Profile opens').toEqual(
      open('profileView'),
    );
    expect(press(toKey(fresh(), 'controls'), 'A').effect, 'world: Controls opens').toEqual(
      open('controlsView'),
    );

    // --- A and a pick on a disabled row ------------------------------------------------------
    for (const [key, kind] of DISABLED_OVER_BATTLE) {
      const state = toKey(battleMenu(), key);
      const want = { kind: 'info', text: reasonText(kind) };
      const a = press(state, 'A');
      expect(a.effect, `A on disabled ${key} does nothing`).toEqual(NONE);
      expect(a.state.feedback, `A on disabled ${key} shows its reason`).toEqual(want);
      expect(a.state.nav.item, `${key}: the cursor stays`).toBe(key);
      expect(a.state.battle, `${key}: still a battle menu`).toBe(true);
      expect(menuViewModel(a.state).feedback, 'the view model carries it').toEqual(want);

      const picked = mainMenuPick(battleMenu(), key);
      expect(picked.effect, `a pick of disabled ${key} does nothing`).toEqual(NONE);
      expect(picked.state.feedback, `a pick of disabled ${key} shows the reason`).toEqual(want);
      expect(picked.state.nav.item, `a pick moves the cursor to ${key}`).toBe(key);

      // A repeat A shows nothing; a move clears the line.
      const repeat = press(state, 'A', true);
      expect(repeat.effect).toEqual(NONE);
      expect(repeat.state.feedback, 'a repeat A is not an activation').toEqual({ kind: 'none' });
      const moved = press(a.state, 'Down');
      expect(moved.state.feedback, 'a cursor move clears the reason').toEqual({ kind: 'none' });
    }
    // Concretely, in order: Monsters, Bag, Journal, Social.
    const monsters = press(battleMenu(), 'A');
    expect(monsters.effect).toEqual(NONE);
    expect(monsters.state.feedback).toEqual({ kind: 'info', text: 'Not during a battle' });
    const bag = press(toKey(battleMenu(), 'bag'), 'A');
    expect(bag.effect).toEqual(NONE);
    expect(bag.state.feedback).toEqual({
      kind: 'info',
      text: 'Use items from the battle Items command',
    });
    // INTENTIONAL CHANGE (ctl-6c, supervisor decision option-a): A and a pick on Journal opened the
    // quest log over the battle.
    const journal = press(toKey(battleMenu(), 'journal'), 'A');
    expect(journal.effect, 'Journal opens nothing over a battle').toEqual(NONE);
    expect(journal.state.feedback).toEqual({ kind: 'info', text: 'Not during a battle' });
    expect(mainMenuPick(battleMenu(), 'journal').effect, 'nor does a pick').toEqual(NONE);
    const social = press(toKey(battleMenu(), 'social'), 'A');
    expect(social.effect).toEqual(NONE);
    expect(social.state.nav.item).toBe('social');
    expect(social.state.feedback).toEqual({ kind: 'info', text: 'Not during a battle' });
    expect(mainMenuPick(battleMenu(), 'social').effect, 'nor does a pick').toEqual(NONE);

    // --- the enabled rows behave exactly as in the world --------------------------------------
    expect(press(toKey(battleMenu(), 'close'), 'A').effect).toEqual(CLOSE);
    expect(mainMenuPick(battleMenu(), 'close').effect).toEqual(CLOSE);
    const help = press(toKey(battleMenu(), 'help'), 'A');
    expect(help.effect, 'How to Play opens help over the battle').toEqual(open('helpView'));
    expect(help.state.feedback, 'with no reason shown').toEqual({ kind: 'none' });
    expect(help.state.nav.item).toBe('help');
    expect(mainMenuPick(battleMenu(), 'help').effect).toEqual(open('helpView'));

    // --- locales: the reasons are resolved at press / view time -----------------------------
    expect(t('menu.disabled.inBattle'), 'the en reason').toBe('Not during a battle');
    expect(t('menu.disabled.battleBag'), 'the en Inventory reason').toBe(
      'Use items from the battle Items command',
    );
    setLocale('fr');
    const frId = (CATALOG_FR as unknown as Record<string, string>)['menu.disabled.inBattle'];
    const frBag = (CATALOG_FR as unknown as Record<string, string>)['menu.disabled.battleBag'];
    expect(frId, 'fixture: fr has its own reason').toBeTypeOf('string');
    expect(frId).not.toBe('Not during a battle');
    expect(frBag).not.toBe('Use items from the battle Items command');
    expect(t('menu.disabled.inBattle')).toBe(frId);
    const frRoot = itemsOf(menuViewModel(battleMenu()).layout);
    expect(frRoot.find((i) => i.key === 'monsters')?.reason, 'view model reasons are fr').toBe(
      frId,
    );
    expect(frRoot.find((i) => i.key === 'bag')?.reason).toBe(frBag);
    expect(frRoot.find((i) => i.key === 'journal')?.reason, 'Journal reason in fr').toBe(frId);
    expect(frRoot.find((i) => i.key === 'social')?.reason, 'Social reason in fr').toBe(frId);
    expect(frRoot.find((i) => i.key === 'controls')?.reason, 'Controls reason in fr').toBe(frId);
    const frA = press(battleMenu(), 'A');
    expect(frA.state.feedback, 'A shows the fr reason').toEqual({ kind: 'info', text: frId });
    const frPick = mainMenuPick(battleMenu(), 'bag');
    expect(frPick.state.feedback, 'a pick shows the fr Bag reason').toEqual({
      kind: 'info',
      text: frBag,
    });
  });

  it('UIF15C.1 over a battle How to Play is enabled and A or a pick opens helpView with no reason, while Controls is disabled with the in-battle reason and A or a pick open nothing and show it, in en and fr', () => {
    // WRONG IMPL KILLED: a Controls row that ignores the battle flag (A emits open controlsView
    // over a battle, where the remap screen is not battle-safe); a How to Play row that is
    // disabled with the Controls row (the player cannot read the help mid-fight, the one thing the
    // old Options group kept enabled); a Controls reason other than t('menu.disabled.inBattle') (the
    // Bag's own, or none); a pick that bypasses the check; a reason frozen in en under fr; the two
    // rows' enabled flags swapped.
    for (const locale of ['en', 'fr'] as const) {
      setLocale(locale);
      const reason = t('menu.disabled.inBattle');
      const rows = itemsOf(menuViewModel(battleMenu()).layout);
      const helpRow = rows.find((i) => i.key === 'help');
      const controlsRow = rows.find((i) => i.key === 'controls');
      expect(helpRow?.enabled, `${locale}: help is enabled over a battle`).toBe(true);
      expect(helpRow?.reason, `${locale}: no reason on help`).toBeUndefined();
      expect(controlsRow?.enabled, `${locale}: controls is disabled over a battle`).toBe(false);
      expect(controlsRow?.reason, `${locale}: the in-battle reason`).toBe(reason);

      const helpA = press(toKey(battleMenu(), 'help'), 'A');
      expect(helpA.effect, `${locale}: A on help opens helpView`).toEqual(open('helpView'));
      expect(helpA.state.feedback).toEqual({ kind: 'none' });
      expect(mainMenuPick(battleMenu(), 'help').effect).toEqual(open('helpView'));

      const a = press(toKey(battleMenu(), 'controls'), 'A');
      expect(a.effect, `${locale}: A on controls opens nothing`).toEqual(NONE);
      expect(a.state.feedback).toEqual({ kind: 'info', text: reason });
      expect(a.state.nav.item).toBe('controls');
      const picked = mainMenuPick(battleMenu(), 'controls');
      expect(picked.effect, `${locale}: a pick opens nothing`).toEqual(NONE);
      expect(picked.state.feedback).toEqual({ kind: 'info', text: reason });
    }
  });

  it('UIF15B.1 over a battle the Social row is disabled with the in-battle reason, A and a pick open nothing and show it, in en and fr', () => {
    // WRONG IMPL KILLED: a Social leaf that ignores the battle flag (A emits open social over a
    // battle, the Social frame's trade/challenge answers would be reachable mid-fight); a reason
    // other than t('menu.disabled.inBattle') (the Bag's own reason, or none); a pick that bypasses
    // the check; a reason frozen in en under fr.
    for (const locale of ['en', 'fr'] as const) {
      setLocale(locale);
      const reason = t('menu.disabled.inBattle');
      const row = itemsOf(menuViewModel(battleMenu()).layout).find((i) => i.key === 'social');
      expect(row?.enabled, `${locale}: Social is disabled over a battle`).toBe(false);
      expect(row?.reason, `${locale}: the in-battle reason`).toBe(reason);
      const a = press(toKey(battleMenu(), 'social'), 'A');
      expect(a.effect, `${locale}: A opens nothing`).toEqual(NONE);
      expect(a.state.feedback).toEqual({ kind: 'info', text: reason });
      const picked = mainMenuPick(battleMenu(), 'social');
      expect(picked.effect, `${locale}: a pick opens nothing`).toEqual(NONE);
      expect(picked.state.feedback).toEqual({ kind: 'info', text: reason });
    }
  });

  it('UIF16B.1 over a battle the Profile row is disabled with the in-battle reason; A and a pick open nothing and show it, in en and fr', () => {
    // WRONG IMPL KILLED: a Profile leaf that ignores the battle flag (A emits open profileView over
    // a battle: the claim and privacy actions it hosts are refused there); a reason other than
    // t('menu.disabled.inBattle') (the Bag's own, or none); a pick that bypasses the check; a
    // reason frozen in en under fr.
    for (const locale of ['en', 'fr'] as const) {
      setLocale(locale);
      const reason = t('menu.disabled.inBattle');
      const row = itemsOf(menuViewModel(battleMenu()).layout).find((i) => i.key === 'profile');
      expect(row?.enabled, `${locale}: Profile is disabled over a battle`).toBe(false);
      expect(row?.reason, `${locale}: the in-battle reason`).toBe(reason);
      const a = press(toKey(battleMenu(), 'profile'), 'A');
      expect(a.effect, `${locale}: A opens nothing`).toEqual(NONE);
      expect(a.state.feedback).toEqual({ kind: 'info', text: reason });
      expect(a.state.nav.item).toBe('profile');
      const picked = mainMenuPick(battleMenu(), 'profile');
      expect(picked.effect, `${locale}: a pick opens nothing`).toEqual(NONE);
      expect(picked.state.feedback).toEqual({ kind: 'info', text: reason });
    }
  });

  it('UIF15A.3 over a battle the Inventory row is disabled with a reason that points at the battle Items command, in en and fr, and names no Bag or Sac', () => {
    // WRONG IMPL KILLED: a reason still saying "Bag command" / "Sac"; a reason that names a
    // command the battle does not have (it must contain the resolved `tactics.menu.item`); a
    // reason frozen in en under fr; the wrong exact wording.
    const reasonOf = (): string => {
      const row = itemsOf(menuViewModel(battleMenu()).layout).find((i) => i.key === 'bag');
      expect(row?.enabled, 'the Inventory row is disabled over a battle').toBe(false);
      return row?.reason as string;
    };

    setLocale('en');
    const en = reasonOf();
    expect(en).toBe('Use items from the battle Items command');
    expect(en).toContain(t('tactics.menu.item'));
    expect(t('tactics.menu.item')).toBe('Items');
    expect(en).not.toMatch(/\bBag\b/);

    setLocale('fr');
    const fr = reasonOf();
    expect(fr).toBe('Utilisez les objets avec la commande Objets du combat');
    expect(fr).toContain(t('tactics.menu.item'));
    expect(t('tactics.menu.item')).toBe('Objets');
    expect(fr).not.toMatch(/\bSac\b/);
  });
});
