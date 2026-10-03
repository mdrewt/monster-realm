// ui/screens/journalScreen.test.ts — ctl-8f (CTL8F.3): the Journal frame's pure adapter.
//
// Node env, no DOM. `journalScreen` is driven only through `viewModel(ctx)`, `init(vm)`,
// `onButton(vm, state, btn)`, `observe(vm, state, now)` and `paint(view, vm, state)` into a
// recording fake view. The cursor is read off the one paint a `paint` hands the view
// (`{ questId, detail }`: the cursor quest's id, and the id whose detail is open); the nav keys are
// internal (an encoded form of the quest id) and are never asserted. `state.detail` is the quest id
// whose detail is open, or null; the state is otherwise never deep-compared.
//
// The contract (plan + dispositions):
//   list    opens on the first quest. Up / Down move the cursor (wrap on a fresh press, clamp on a
//           repeat); A or Y (not a repeat) open the detail of the cursor quest; B pops; Start pops to
//           the base; Select toggles help; every other button is `unhandled`.
//   detail  A or B return to the list on that quest; Start pops to the base; Select toggles help;
//           every other button is swallowed.
//   observe the first observe after init answers a NEW state; afterwards the SAME object when nothing
//           changed; a vanished cursor quest is re-seated, a detail whose quest vanished closes.
//   A quest id may hold spaces or be empty (the nav kit rejects such keys): nothing throws.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type { StorePlayerQuest } from '../../net/store';
import type { NavInput } from '../nav';
import { buildQuestLogViewModel, type QuestLogViewModel } from '../questLogModel';
import type { QuestLogView } from '../questLogView';
import { type JournalState, journalScreen } from './journalScreen';
import type { ButtonStep, ScreenContext, ScreenResult } from './types';

const ME = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

function quest(pqId: bigint, questId: string, stepIndex: number, owner = ME): StorePlayerQuest {
  return { pqId, ownerIdentity: owner, questId, stepIndex };
}

/** Store order is the list order. A foreign player's quest must never show. */
const QUESTS: readonly StorePlayerQuest[] = [
  quest(1n, 'quest_001', 0),
  quest(9n, 'foreign_quest', 4, OTHER),
  quest(2n, 'quest_002', 3),
  quest(3n, 'quest_003', 1),
];

function ctxOf(quests: readonly StorePlayerQuest[]): ScreenContext {
  const store = {
    ownQuests: (identity: string) => quests.filter((q) => q.ownerIdentity === identity),
  };
  return {
    store,
    identity: ME,
    bindings: DEFAULT_BINDINGS,
    now: () => 0,
    shopId: null,
    healLocationId: null,
    reduceMotion: false,
  } as unknown as ScreenContext;
}

const vmOf = (quests: readonly StorePlayerQuest[] = QUESTS): QuestLogViewModel =>
  journalScreen.viewModel(ctxOf(quests));

type Input = VButton | NavInput;
const rep = (button: VButton): NavInput => ({ button, repeat: true });
const asInput = (input: Input): NavInput =>
  typeof input === 'string' ? { button: input, repeat: false } : input;
const label = (input: Input): string =>
  typeof input === 'string' ? input : `${input.button}${input.repeat ? ' (repeat)' : ''}`;

const press = (
  vm: QuestLogViewModel,
  state: JournalState,
  input: Input,
): ButtonStep<JournalState> => journalScreen.onButton(vm, state, asInput(input));

function swallowed(
  vm: QuestLogViewModel,
  state: JournalState,
  inputs: readonly Input[],
): JournalState {
  let s = state;
  for (const input of inputs) {
    const step = press(vm, s, input);
    expect(step.result, `${label(input)} is swallowed`).toBe('consumed');
    s = step.state;
  }
  return s;
}

function observe(vm: QuestLogViewModel, state: JournalState): JournalState {
  if (journalScreen.observe === undefined) throw new Error('journalScreen must define observe');
  return journalScreen.observe(vm, state, 0);
}

type JournalPaintLike = Parameters<QuestLogView['paint']>[0];

function paintOf(vm: QuestLogViewModel, state: JournalState): JournalPaintLike {
  const out: JournalPaintLike[] = [];
  const view = {
    paint: (p: JournalPaintLike) => {
      out.push(p);
    },
  } as unknown as QuestLogView;
  if (journalScreen.paint === undefined) throw new Error('journalScreen must define paint');
  journalScreen.paint(view, vm, state);
  expect(out, 'exactly one paint').toHaveLength(1);
  return out[0] as JournalPaintLike;
}

const cursorOf = (vm: QuestLogViewModel, state: JournalState): string | null =>
  paintOf(vm, state).questId;
const fresh = (vm: QuestLogViewModel): JournalState => journalScreen.init(vm);

const POP: ScreenResult = { kind: 'pop' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };

/** Quest ids a nav key cannot hold as they are: spaces, the empty string, look-alikes of the
 *  usual escapes, a tab and a newline. */
const AWKWARD = ['a b', 'a_b', '', 'a%20b', 'tab\tstop', 'new\nline', 'trailing '] as const;
const awkwardQuests = (): StorePlayerQuest[] => AWKWARD.map((id, i) => quest(BigInt(i + 1), id, i));

describe('journalScreen — the list (ctl-8f, CTL8F.3)', () => {
  it('CTL8F-3-LIST: the view model is the player`s own quests; init opens on the first quest; Up and Down move the cursor (wrap fresh, clamp on a repeat); every other button but B, Start and Select is the page`s; an empty journal and awkward quest ids (spaces, empty, tab, newline) never throw and every one is reachable', () => {
    // WRONG IMPL KILLED: a view model that lists another identity's quest (the foreign row); an
    // init that opens on no row or the last row; a walk that does not wrap (the last quest is a dead
    // end) or wraps on a held repeat; an Up / Down answered `unhandled` (the world would walk under
    // the open journal); a Left / Right / LB / RB / X swallowed (they are not this screen's); a key
    // built from the raw quest id (the nav kit throws on a space, an empty string and a tab, so the
    // adapter would throw while building the view model's layout), a key that collapses two ids
    // (`a b` and `a_b`, or `a b` and `a%20b`, would be a duplicate key), and an empty list that
    // throws.
    expect(journalScreen.nav, 'the frame takes the D-pad').toBe(true);
    const vm = vmOf();
    expect(vm, 'the player`s own quests').toEqual(
      buildQuestLogViewModel(QUESTS.filter((q) => q.ownerIdentity === ME)),
    );
    expect(vm.active.map((e) => e.questId)).toEqual(['quest_001', 'quest_002', 'quest_003']);

    const opened = fresh(vm);
    expect(opened.detail, 'no detail on open').toBeNull();
    expect(paintOf(vm, opened), 'the opening paint').toEqual({
      questId: 'quest_001',
      detail: null,
    });

    const walked: Array<string | null> = [cursorOf(vm, opened)];
    let s = opened;
    for (let i = 0; i < 3; i++) {
      s = swallowed(vm, s, ['Down']);
      walked.push(cursorOf(vm, s));
    }
    expect(walked, 'Down walks the three quests and wraps').toEqual([
      'quest_001',
      'quest_002',
      'quest_003',
      'quest_001',
    ]);
    expect(cursorOf(vm, swallowed(vm, opened, ['Up'])), 'a fresh Up wraps').toBe('quest_003');
    expect(cursorOf(vm, swallowed(vm, opened, [rep('Up')])), 'a repeat Up stays').toBe('quest_001');
    expect(
      cursorOf(vm, swallowed(vm, opened, ['Up', rep('Down')])),
      'a repeat Down at the end stays',
    ).toBe('quest_003');
    expect(cursorOf(vm, swallowed(vm, opened, [rep('Down')])), 'a repeat Down moves on').toBe(
      'quest_002',
    );

    // The buttons that are not the screen's, fresh and repeated.
    for (const button of ['Left', 'Right', 'LB', 'RB', 'X'] as const) {
      for (const input of [button, rep(button)]) {
        const step = press(vm, opened, input);
        expect(step.result, `list ${label(input)}`).toBe('unhandled');
        expect(cursorOf(vm, step.state), `list ${label(input)} moves nothing`).toBe('quest_001');
      }
    }
    expect(press(vm, opened, 'B').result).toEqual(POP);
    expect(press(vm, opened, 'Start').result).toEqual(POP_TO_BASE);
    expect(press(vm, opened, 'Select').result).toEqual(TOGGLE_HELP);

    // An empty journal.
    const empty = vmOf([]);
    expect(empty.active).toEqual([]);
    const none = fresh(empty);
    expect(paintOf(empty, none), 'no cursor, no detail').toEqual({ questId: null, detail: null });
    for (const button of ['Up', 'Down', 'A', 'Y'] as const) {
      const step = press(empty, none, button);
      expect(typeof step.result, `${button} on an empty journal answers no command`).toBe('string');
      expect(step.state.detail, `${button}: no detail`).toBeNull();
    }
    expect(press(empty, none, 'B').result).toEqual(POP);

    // Awkward ids: nothing throws, every id is reachable once, in store order, and the walk wraps.
    const awkward = vmOf(awkwardQuests());
    expect(awkward.active.map((e) => e.questId)).toEqual([...AWKWARD]);
    let a = fresh(awkward);
    const reached: Array<string | null> = [cursorOf(awkward, a)];
    for (let i = 1; i < AWKWARD.length; i++) {
      a = swallowed(awkward, a, ['Down']);
      reached.push(cursorOf(awkward, a));
    }
    expect(reached, 'each distinct id is a distinct stop').toEqual([...AWKWARD]);
    expect(cursorOf(awkward, swallowed(awkward, a, ['Down'])), 'and it wraps').toBe(AWKWARD[0]);
  });
});

describe('journalScreen — the detail (ctl-8f, CTL8F.3)', () => {
  it('CTL8F-3-A-DETAIL: A on a quest opens ITS detail (the cursor quest, whichever it is, an empty id and one with spaces included) with no command; the paint names the cursor and the detail; a repeat A and A on an empty journal open nothing', () => {
    // WRONG IMPL KILLED: an A that opens nothing, a detail for the FIRST quest instead of the
    // cursor's, one that stores the nav key instead of the quest id (a space or percent sign in the
    // id would show), a truthiness test on the id (an empty id is a quest: `detail` would stay
    // null), a command issued for the detail, a held A (a held Enter) that opens it, and a paint
    // that does not carry the open detail.
    const vm = vmOf();
    const opened = fresh(vm);

    const first = press(vm, opened, 'A');
    expect(first.result, 'no command: the detail is the screen`s').toBe('consumed');
    expect(first.state.detail).toBe('quest_001');

    const down = swallowed(vm, opened, ['Down']);
    const second = press(vm, down, 'A');
    expect(second.result).toBe('consumed');
    expect(second.state.detail, 'the CURSOR quest').toBe('quest_002');
    expect(paintOf(vm, second.state), 'the paint carries the cursor and the open detail').toEqual({
      questId: 'quest_002',
      detail: 'quest_002',
    });

    const held = press(vm, down, rep('A'));
    expect(typeof held.result, 'a repeat A answers no command').toBe('string');
    expect(held.state.detail, 'and opens nothing').toBeNull();
    expect(paintOf(vm, held.state)).toEqual({ questId: 'quest_002', detail: null });

    const empty = vmOf([]);
    expect(press(empty, fresh(empty), 'A').state.detail, 'nothing to open').toBeNull();

    // Every awkward id opens exactly its own detail.
    const awkward = vmOf(awkwardQuests());
    let s = fresh(awkward);
    for (const [i, id] of AWKWARD.entries()) {
      if (i > 0) s = swallowed(awkward, s, ['Down']);
      const step = press(awkward, s, 'A');
      expect(step.state.detail, `the detail of ${JSON.stringify(id)}`).toBe(id);
      expect(paintOf(awkward, step.state)).toEqual({ questId: id, detail: id });
    }
  });

  it('CTL8F-3-Y-DETAIL: Y opens the detail exactly as A does (fresh press only), and inside the detail Y is swallowed and changes nothing', () => {
    // WRONG IMPL KILLED: a Y that is `unhandled` in the list (the design makes Y the "details"
    // button), one that opens the FIRST quest's detail, a held Y that opens it, a Y inside the
    // detail that closes it or moves the cursor, and a Y that is not swallowed there.
    const vm = vmOf();
    const down = swallowed(vm, fresh(vm), ['Down', 'Down']);
    expect(cursorOf(vm, down)).toBe('quest_003');

    const y = press(vm, down, 'Y');
    expect(y.result, 'swallowed, no command').toBe('consumed');
    expect(y.state.detail).toBe('quest_003');
    expect(paintOf(vm, y.state)).toEqual({ questId: 'quest_003', detail: 'quest_003' });

    const a = press(vm, down, 'A');
    expect(paintOf(vm, a.state), 'the same detail as A').toEqual(paintOf(vm, y.state));

    const held = press(vm, down, rep('Y'));
    expect(typeof held.result).toBe('string');
    expect(held.state.detail, 'a repeat Y opens nothing').toBeNull();

    const inside = press(vm, y.state, 'Y');
    expect(inside.result, 'Y inside the detail is swallowed').toBe('consumed');
    expect(inside.state.detail, 'and leaves the detail open').toBe('quest_003');
    expect(cursorOf(vm, inside.state)).toBe('quest_003');

    const empty = vmOf([]);
    expect(press(empty, fresh(empty), 'Y').state.detail).toBeNull();
  });

  it('CTL8F-3-B-BACK: A or B inside the detail close it back to the list with the cursor still on that quest (swallowed); B in the list pops; Start pops to the base and Select toggles help from the list and the detail; every other button inside the detail is swallowed and moves nothing', () => {
    // WRONG IMPL KILLED: a B in the detail that pops the whole frame (the journal would close
    // from a detail), a return to the first quest, an A in the detail that opens another detail
    // or stays, a Start swallowed inside the detail (no way out), a Select that is lost, and an
    // Up / Down / Left / Right / X / LB / RB inside the detail that moves the cursor under it or
    // escapes as `unhandled` (the world would walk).
    const vm = vmOf();
    const detail = press(vm, swallowed(vm, fresh(vm), ['Down']), 'A').state;
    expect(detail.detail, 'precondition: the detail of quest_002').toBe('quest_002');

    for (const button of ['B', 'A'] as const) {
      const back = press(vm, detail, button);
      expect(back.result, `${button} in the detail is swallowed`).toBe('consumed');
      expect(back.state.detail, `${button}: the detail is closed`).toBeNull();
      expect(paintOf(vm, back.state), `${button}: the cursor is on that quest`).toEqual({
        questId: 'quest_002',
        detail: null,
      });
      expect(press(vm, back.state, 'B').result, 'and B in the list then pops').toEqual(POP);
    }

    for (const state of [fresh(vm), detail]) {
      const where = state.detail === null ? 'list' : 'detail';
      expect(press(vm, state, 'Start').result, `Start in the ${where}`).toEqual(POP_TO_BASE);
      expect(press(vm, state, 'Select').result, `Select in the ${where}`).toEqual(TOGGLE_HELP);
    }

    for (const button of ['Up', 'Down', 'Left', 'Right', 'X', 'Y', 'LB', 'RB'] as const) {
      for (const input of [button, rep(button)]) {
        const step = press(vm, detail, input);
        expect(step.result, `detail ${label(input)}`).toBe('consumed');
        expect(step.state.detail, `detail ${label(input)}: still open`).toBe('quest_002');
        expect(cursorOf(vm, step.state), `detail ${label(input)}: the cursor stays`).toBe(
          'quest_002',
        );
      }
    }
  });
});

describe('journalScreen — observe (ctl-8f, CTL8F.3)', () => {
  const without = (id: string): StorePlayerQuest[] => QUESTS.filter((q) => q.questId !== id);

  it('CTL8F-3-OBSERVE: the first observe after init answers a NEW state, an equal batch the SAME object; a vanished cursor quest is re-seated to the nearest one; a detail whose quest vanished closes while one whose quest survived stays open; awkward ids never throw', () => {
    // WRONG IMPL KILLED: an init whose first observe is "nothing changed" (the host would not paint
    // the opening cursor on the first batch); an observe that answers a new state on every batch
    // (a repaint per batch); a cursor left on a vanished quest (A would open a detail for nothing);
    // a re-seat to the first quest instead of the nearest; a detail kept open for a quest that is
    // gone (the view hides it, the adapter would still believe it open); a detail closed by an
    // unrelated quest vanishing; and an observe that throws on an awkward id.
    const vm = vmOf();
    const initial = fresh(vm);
    const first = observe(vm, initial);
    expect(first, 'the first observe after init answers a new state').not.toBe(initial);
    expect(paintOf(vm, first)).toEqual({ questId: 'quest_001', detail: null });
    expect(observe(vmOf(), first), 'an equal batch (a fresh view model): the same object').toBe(
      first,
    );
    expect(observe(vm, first)).toBe(first);

    // Re-seating: [001, 002, 003]. The cursor on 002 vanishes -> 003 (the nearest index).
    const onSecond = swallowed(vm, fresh(vm), ['Down']);
    const afterSecond = observe(vmOf(without('quest_002')), onSecond);
    expect(afterSecond, 'a re-seat is a change').not.toBe(onSecond);
    expect(cursorOf(vmOf(without('quest_002')), afterSecond)).toBe('quest_003');
    // The cursor on the LAST quest vanishes -> the new last, 002.
    const onLast = swallowed(vm, fresh(vm), ['Up']);
    expect(cursorOf(vmOf(without('quest_003')), observe(vmOf(without('quest_003')), onLast))).toBe(
      'quest_002',
    );
    // The cursor on the first vanishes -> the quest that took its index.
    expect(
      cursorOf(vmOf(without('quest_001')), observe(vmOf(without('quest_001')), fresh(vm))),
    ).toBe('quest_002');
    // Another quest vanishing leaves the cursor on its quest.
    expect(
      cursorOf(vmOf(without('quest_003')), observe(vmOf(without('quest_003')), onSecond)),
    ).toBe('quest_002');
    expect(
      cursorOf(vmOf(without('quest_001')), observe(vmOf(without('quest_001')), onSecond)),
      'a quest above the cursor vanishing keeps the cursor on its quest',
    ).toBe('quest_002');
    // A quest added keeps the cursor.
    const grown = [...QUESTS, quest(4n, 'quest_004', 0)];
    expect(cursorOf(vmOf(grown), observe(vmOf(grown), onSecond))).toBe('quest_002');

    // The last quest vanishing empties the journal: no cursor.
    const lone = vmOf([quest(1n, 'only', 0)]);
    const loneState = fresh(lone);
    const emptied = observe(vmOf([]), loneState);
    expect(paintOf(vmOf([]), emptied)).toEqual({ questId: null, detail: null });

    // A detail: closes when its quest vanishes, stays when another one does.
    const detail = press(vm, onSecond, 'A').state;
    expect(detail.detail).toBe('quest_002');
    const closed = observe(vmOf(without('quest_002')), detail);
    expect(closed.detail, 'the detail of a vanished quest closes').toBeNull();
    expect(paintOf(vmOf(without('quest_002')), closed)).toEqual({
      questId: 'quest_003',
      detail: null,
    });
    const kept = observe(vmOf(without('quest_001')), detail);
    expect(kept.detail, 'an unrelated quest vanishing leaves the detail open').toBe('quest_002');
    expect(paintOf(vmOf(without('quest_001')), kept)).toEqual({
      questId: 'quest_002',
      detail: 'quest_002',
    });

    // Awkward ids: observe and the re-seat do not throw, and the detail of one follows it.
    const awkward = vmOf(awkwardQuests());
    const onEmpty = swallowed(awkward, fresh(awkward), ['Down', 'Down']);
    expect(cursorOf(awkward, onEmpty), 'precondition: on the empty id').toBe('');
    const openEmpty = press(awkward, onEmpty, 'A').state;
    expect(openEmpty.detail, 'precondition: the detail of the empty id is open').toBe('');
    const minusFirst = vmOf(awkwardQuests().filter((q) => q.questId !== 'a b'));
    expect(() => observe(minusFirst, openEmpty), 'a re-seat over awkward ids').not.toThrow();
    expect(observe(minusFirst, openEmpty).detail, 'the empty id`s detail survives').toBe('');
    const minusEmpty = vmOf(awkwardQuests().filter((q) => q.questId !== ''));
    expect(
      observe(minusEmpty, openEmpty).detail,
      'and closes when it is the one that vanished',
    ).toBeNull();
  });
});
