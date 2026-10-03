// ui/screens/tradeProposeScreen.test.ts: ctl-8e (CTL8E.1, defect B5): the trade-propose wizard's
// pure adapter.
//
// Node env, no DOM. `tradeProposeScreen` is driven only through `viewModel(ctx)`, `init(vm)`,
// `onButton(vm, state, btn)` and `paint(view, vm, state)` into a recording fake view. The context's
// fake store has the three reads the view model makes (`allPlayers`, `ownMonsters`, `speciesMap`).
//
// The contract (the slice plan's REVISED shape):
//   view model  { lists: buildProposeLists(live store reads), targetSupplied: false } (ctl-10b is
//               what will supply a target; until then the wizard asks for one first).
//   state       { steps, step, offer (the cursor monster id as a decimal string, or null), yes,
//               toggle, commit }. `toggle` and `commit` are ONE-SHOT TOKENS: a NEW object each
//               time, compared by identity by the view, which applies them to the on-screen draft.
//               The adapter never holds the draft and never answers a proposeTrade command: the
//               view sends the DOM draft when it sees a new commit token.
//   steps       Target (only with no target supplied), Offer, Coins, Ask, Review.
//   buttons     Start -> popToBase, Select -> toggleHelp, B -> the previous step (pop at the first),
//               LB / RB -> previous / next step clamped at the ends. A repeat moves a cursor but
//               never acts, and LB / RB, B and the Yes / No flip act on a fresh press only.
//               Target: A -> Offer. Offer: Up / Down move the cursor by monster id, A -> a NEW
//               toggle token for the cursor monster. Coins and Ask (typing rows, CTL6B.5): A -> the
//               next step, the D-pad is swallowed. Review: Up / Down / Left / Right flip Yes / No,
//               A on Yes -> a NEW commit token and the cursor to No, A on No -> the previous step.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type { StoreMonsterPub, StorePlayer } from '../../net/store';
import { buildProposeLists, type ProposeStep, proposeSteps } from '../tradeProposeModel';
import type { TradeProposePaint, TradeProposeView } from '../tradeProposeView';
import {
  type TradeProposeScreenState,
  type TradeProposeScreenVm,
  tradeProposeScreen,
} from './tradeProposeScreen';
import type { ButtonStep, ScreenContext, ScreenResult } from './types';

const ME = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const THIRD = 'ef'.repeat(32);

function player(identity: string, name: string): StorePlayer {
  return { identity, name, entityId: 1n, online: true, lastInputSeq: 0n };
}

function monster(monsterId: bigint, nickname: string): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: ME,
    speciesId: 1,
    nickname,
    level: 5,
    partySlot: 255,
  } as unknown as StoreMonsterPub;
}

interface World {
  players: StorePlayer[];
  monsters: StoreMonsterPub[];
}

/** Three own monsters (ids ascending: 11, 22, 33) and two other players. */
function world(): World {
  return {
    players: [player(ME, 'Me'), player(OTHER, 'Zed'), player(THIRD, 'Amy')],
    monsters: [monster(33n, 'Cee'), monster(11n, 'Aye'), monster(22n, 'Bee')],
  };
}

function ctxOf(w: World): ScreenContext {
  const store = {
    allPlayers: () => [...w.players],
    ownMonsters: (identity: string) => (identity === ME ? [...w.monsters] : []),
    speciesMap: () => new Map(),
  };
  return {
    store,
    identity: ME,
    bindings: DEFAULT_BINDINGS,
    now: () => 0,
    shopId: null,
    healLocationId: null,
    socialTab: null,
    reduceMotion: false,
  } as unknown as ScreenContext;
}

const vmOf = (w: World): TradeProposeScreenVm => tradeProposeScreen.viewModel(ctxOf(w));
/** The same view model with a target supplied (what ctl-10b will do). */
const suppliedOf = (vm: TradeProposeScreenVm): TradeProposeScreenVm => ({
  ...vm,
  targetSupplied: true,
});
const openOf = (vm: TradeProposeScreenVm): TradeProposeScreenState => tradeProposeScreen.init(vm);
/** A state on `step`, built from `init` so only the step differs. */
const stateAt = (vm: TradeProposeScreenVm, step: ProposeStep): TradeProposeScreenState => ({
  ...openOf(vm),
  step,
});

const press = (
  vm: TradeProposeScreenVm,
  state: TradeProposeScreenState,
  button: VButton,
  repeat = false,
): ButtonStep<TradeProposeScreenState> =>
  tradeProposeScreen.onButton(vm, state, { button, repeat });

const FULL: readonly ProposeStep[] = ['target', 'offer', 'coins', 'ask', 'review'];
const DPAD: readonly VButton[] = ['Up', 'Down', 'Left', 'Right'];
const POP: ScreenResult = { kind: 'pop' };

/** The one paint `paint(view, vm, state)` hands the view. */
function paintOf(vm: TradeProposeScreenVm, state: TradeProposeScreenState): TradeProposePaint {
  const out: TradeProposePaint[] = [];
  const view = {
    paint: (p: TradeProposePaint) => {
      out.push(p);
    },
  } as unknown as TradeProposeView;
  if (tradeProposeScreen.paint === undefined) throw new Error('tradeProposeScreen must paint');
  tradeProposeScreen.paint(view, vm, state);
  expect(out, 'exactly one paint').toHaveLength(1);
  return out[0] as TradeProposePaint;
}

describe('tradeProposeScreen: the steps and the opening state (ctl-8e, CTL8E.1)', () => {
  it('CTL8E-1-MODEL-STEPS: the view model is the live buildProposeLists of the store reads with no target supplied, and init opens on Target with all five steps, the cursor on the first offerable monster, Yes selected and no token', () => {
    // WRONG IMPL KILLED: a view model that reports a supplied target before ctl-10b exists (the
    // player could never pick a counterparty); lists cached at module scope (a second open would
    // show the first open's players and monsters); a cursor that is null, an index, a number or
    // not the FIRST monster by id (buildProposeLists sorts ascending: 11, not the store's 33); a
    // review that opens on No; and a wizard that opens holding a stale toggle or commit token
    // (the view would flip a box or send on the very first paint).
    const w = world();
    const vm = vmOf(w);
    expect(vm.targetSupplied, 'no target is supplied until ctl-10b').toBe(false);
    expect(vm.lists, 'the live lists, built the same way main.ts builds them').toEqual(
      buildProposeLists(w.players, w.monsters, new Map(), ME),
    );
    // Sorted by identity ('cd...' before 'ef...'), self excluded: Zed then Amy.
    expect(vm.lists.targets.map((t) => t.label)).toEqual(['Zed', 'Amy']);
    expect(vm.lists.offerableMonsters.map((m) => m.monsterId)).toEqual([11n, 22n, 33n]);

    const state = openOf(vm);
    expect(state.steps).toEqual(FULL);
    expect(state.step).toBe('target');
    expect(state.offer, 'the cursor is the first monster id, a decimal string').toBe('11');
    expect(state.yes, 'Review confirms with Yes as the default').toBe(true);
    expect(state.toggle).toBeNull();
    expect(state.commit).toBeNull();

    // Live: a changed store shows in the next view model (no cache), and an empty list has no cursor.
    w.monsters = [monster(7n, 'Solo')];
    w.players = [player(ME, 'Me')];
    const later = vmOf(w);
    expect(later.lists.offerableMonsters.map((m) => m.monsterId)).toEqual([7n]);
    expect(later.lists.targets).toEqual([]);
    expect(openOf(later).offer).toBe('7');
    w.monsters = [];
    expect(openOf(vmOf(w)).offer, 'nothing to offer: no cursor').toBeNull();
  });

  it('CTL8E-1-TARGET-PICK: with a target supplied the wizard opens on Offer with only four steps and B there closes it; with none supplied A on Target moves to Offer, and the D-pad on Target (the select owns it natively) is swallowed without moving anything', () => {
    // WRONG IMPL KILLED: a Target step that always appears (ctl-10b's supplied target would be
    // asked for twice); a wizard that opens on Target regardless of the flag; an A on Target that
    // stays put (the legacy Enter-on-select would do nothing, the player stuck on the first step);
    // an A on Target that jumps past Offer; a D-pad press on Target that moves the offer cursor
    // or the step; a held A that acts again (a repeat must never act); and an A that mints a
    // toggle or commit token.
    const w = world();
    const vm = vmOf(w);

    const supplied = suppliedOf(vm);
    const opened = openOf(supplied);
    expect(opened.steps).toEqual(['offer', 'coins', 'ask', 'review']);
    expect(opened.step, 'the first step is Offer').toBe('offer');
    expect(press(supplied, opened, 'B').result, 'B at the first step closes the wizard').toEqual(
      POP,
    );
    expect(press(supplied, opened, 'LB').result).toBe('consumed');
    expect(press(supplied, opened, 'LB').state.step, 'LB clamps at the first step').toBe('offer');

    const target = stateAt(vm, 'target');
    const a = press(vm, target, 'A');
    expect(a.result).toBe('consumed');
    expect(a.state.step, 'A on Target picks and moves on').toBe('offer');
    expect(a.state.toggle).toBeNull();
    expect(a.state.commit).toBeNull();
    expect(a.state.offer, 'the cursor is untouched').toBe(target.offer);

    const held = press(vm, target, 'A', true);
    expect(held.result).toBe('consumed');
    expect(held.state.step, 'a repeat never acts').toBe('target');

    for (const button of DPAD) {
      for (const repeat of [false, true]) {
        const step = press(vm, target, button, repeat);
        expect(step.result, `${button} repeat=${String(repeat)}`).toBe('consumed');
        expect(step.state.step, `${button}: the step`).toBe('target');
        expect(step.state.offer, `${button}: the offer cursor`).toBe(target.offer);
        expect(step.state.toggle).toBeNull();
        expect(step.state.commit).toBeNull();
      }
    }
  });
});

describe('tradeProposeScreen: paging and stepping back (ctl-8e, CTL8E.1)', () => {
  it('CTL8E-1-PAGE-LBRB: RB moves to the next step and LB to the previous, clamped at both ends (no wrap, no close), on a fresh press only, with the offer cursor and tokens kept; with a supplied target LB clamps at Offer', () => {
    // WRONG IMPL KILLED: an RB that wraps from Review to Target (the player pages past the end
    // and lands on a draft step); an LB at the first step that pops the wizard (that is B's job);
    // an LB / RB that is swallowed or unhandled at an end (the page would scroll on PageDown); a
    // repeat that pages (a held PageDown would run the wizard to Review); a paging that resets
    // the cursor; and a clamp that returns a different step.
    const vm = vmOf(world());
    for (let i = 0; i < FULL.length; i += 1) {
      const here = FULL[i] as ProposeStep;
      const forward = press(vm, stateAt(vm, here), 'RB');
      expect(forward.result, `RB from ${here}`).toBe('consumed');
      expect(forward.state.step, `RB from ${here}`).toBe(FULL[Math.min(i + 1, FULL.length - 1)]);
      const back = press(vm, stateAt(vm, here), 'LB');
      expect(back.result, `LB from ${here}`).toBe('consumed');
      expect(back.state.step, `LB from ${here}`).toBe(FULL[Math.max(i - 1, 0)]);
      for (const button of ['LB', 'RB'] as const) {
        const held = press(vm, stateAt(vm, here), button, true);
        expect(held.result, `${button} repeat from ${here}`).toBe('consumed');
        expect(held.state.step, `${button} repeat from ${here}: no paging`).toBe(here);
      }
    }

    // The cursor and the one-shot tokens ride along.
    const moved = press(vm, { ...stateAt(vm, 'offer'), offer: '33' }, 'RB').state;
    expect(moved.step).toBe('coins');
    expect(moved.offer, 'paging keeps the offer cursor').toBe('33');
    expect(press(vm, moved, 'LB').state.offer).toBe('33');

    // A supplied target: Offer is the first step, so LB there is an end, not a pop.
    const supplied = suppliedOf(vm);
    const edge = press(supplied, openOf(supplied), 'LB');
    expect(edge.result).toBe('consumed');
    expect(edge.state.step).toBe('offer');
    expect(press(supplied, stateAt(supplied, 'review'), 'RB').state.step).toBe('review');
    expect(proposeSteps(true), 'fixture: the supplied list has four steps').toHaveLength(4);
  });

  it('CTL8E-1-B-BACK: B steps back one step at a time from Review down to Target, closes the wizard at the first step (Target, or Offer when a target is supplied), and does nothing on a repeat', () => {
    // WRONG IMPL KILLED: a B that closes the wizard from any step (one mis-press loses the draft);
    // a B that jumps to the first step; a B at the first step that is swallowed (no way out); a
    // B that pops while a step is in between; a held B that runs back and out (repeat must not
    // act); and a B that clears the cursor.
    const vm = vmOf(world());
    for (let i = 1; i < FULL.length; i += 1) {
      const here = FULL[i] as ProposeStep;
      const step = press(vm, stateAt(vm, here), 'B');
      expect(step.result, `B from ${here}`).toBe('consumed');
      expect(step.state.step, `B from ${here}`).toBe(FULL[i - 1]);
    }
    expect(press(vm, stateAt(vm, 'target'), 'B').result, 'B at Target').toEqual(POP);

    const supplied = suppliedOf(vm);
    expect(press(supplied, stateAt(supplied, 'coins'), 'B').state.step).toBe('offer');
    expect(
      press(supplied, stateAt(supplied, 'offer'), 'B').result,
      'B at Offer, target supplied',
    ).toEqual(POP);

    for (const here of FULL) {
      const held = press(vm, stateAt(vm, here), 'B', true);
      expect(held.result, `B repeat at ${here}`).toBe('consumed');
      expect(held.state.step, `B repeat at ${here}`).toBe(here);
    }

    const keeps = press(vm, { ...stateAt(vm, 'coins'), offer: '22' }, 'B').state;
    expect(keeps.step).toBe('offer');
    expect(keeps.offer, 'the cursor survives B').toBe('22');
  });

  it('CTL8E-1-START-ABANDONS: Start abandons the draft from every step by popping to the base, Select toggles help, a repeat of either is swallowed, and X and Y are left unhandled', () => {
    // WRONG IMPL KILLED: a Start that pops one frame (an Escape on Review would only step back, and
    // a nested frame would stay); a Start that is unhandled (the legacy ladder would hide the
    // overlay, bypassing the frame stack); a Select that is lost; a repeat that acts (a held key
    // would toggle help on and off); an X or Y that is swallowed (Jump and the legacy Y keep their
    // owner); and a Start that changes the state it leaves behind.
    const vm = vmOf(world());
    for (const here of FULL) {
      const state = stateAt(vm, here);
      expect(press(vm, state, 'Start').result, `Start at ${here}`).toEqual({ kind: 'popToBase' });
      expect(press(vm, state, 'Select').result, `Select at ${here}`).toEqual({
        kind: 'toggleHelp',
      });
      for (const button of ['Start', 'Select'] as const) {
        const held = press(vm, state, button, true);
        expect(held.result, `${button} repeat at ${here}`).toBe('consumed');
        expect(held.state, `${button} repeat at ${here}: the same state`).toEqual(state);
      }
      for (const button of ['X', 'Y'] as const) {
        expect(press(vm, state, button).result, `${button} at ${here}`).toBe('unhandled');
      }
    }
    expect(press(vm, stateAt(vm, 'review'), 'Start').state, 'Start leaves the state alone').toEqual(
      stateAt(vm, 'review'),
    );
  });
});

describe('tradeProposeScreen: Offer, the typing rows and Review (ctl-8e, CTL8E.1)', () => {
  it('CTL8E-1-OFFER-TOGGLE: on Offer a fresh or repeated Down / Up moves the cursor over the monsters by id, A mints a NEW toggle token for the cursor monster and stays on Offer, a repeat of A and an empty list mint none, and Left / Right are swallowed', () => {
    // WRONG IMPL KILLED: a toggle that is applied to the adapter's own copy of the draft (the
    // adapter never owns it); a token REUSED between presses or compared by monster id (the view
    // dedups tokens by identity: pressing A twice on one monster must flip it twice); a token for
    // the wrong monster (the first, the store-order one, an index); an A that leaves Offer; a held
    // A that toggles on every repeat; an A on an empty list that mints a token for a monster that
    // does not exist; a Down that does not move the cursor on a repeat (a held arrow must scroll
    // the list); and a Left / Right that moves it.
    const vm = vmOf(world());
    const offer = stateAt(vm, 'offer');
    expect(offer.offer).toBe('11');

    const down = press(vm, offer, 'Down');
    expect(down.result).toBe('consumed');
    expect(down.state.offer, 'Down: the second monster by id, not the store order').toBe('22');
    const downAgain = press(vm, down.state, 'Down', true);
    expect(downAgain.result).toBe('consumed');
    expect(downAgain.state.offer, 'a repeat moves the cursor too').toBe('33');
    expect(press(vm, downAgain.state, 'Up').state.offer, 'Up goes back').toBe('22');
    for (const button of ['Up', 'Down'] as const) {
      expect(press(vm, down.state, button).state.step, `${button} stays on Offer`).toBe('offer');
    }

    const first = press(vm, down.state, 'A');
    expect(first.result).toBe('consumed');
    expect(first.state.step, 'A toggles in place').toBe('offer');
    expect(first.state.offer, 'and keeps the cursor').toBe('22');
    expect(first.state.toggle, 'the token names the cursor monster as a bigint').toEqual({
      monsterId: 22n,
    });
    expect(first.state.commit, 'a toggle never commits').toBeNull();

    const second = press(vm, first.state, 'A');
    expect(second.state.toggle, 'the same monster again').toEqual({ monsterId: 22n });
    expect(second.state.toggle, 'but a NEW token: the view dedups by identity').not.toBe(
      first.state.toggle,
    );

    const held = press(vm, first.state, 'A', true);
    expect(held.result).toBe('consumed');
    expect(held.state.toggle, 'a repeat of A mints nothing: the very same token').toBe(
      first.state.toggle,
    );

    for (const button of ['Left', 'Right'] as const) {
      const sideways = press(vm, down.state, button);
      expect(sideways.result, button).toBe('consumed');
      expect(sideways.state.offer, `${button} moves no cursor`).toBe('22');
      expect(sideways.state.toggle).toBeNull();
    }

    // No monsters: nothing to toggle.
    const empty: World = { players: world().players, monsters: [] };
    const emptyVm = vmOf(empty);
    const emptyOffer = stateAt(emptyVm, 'offer');
    const none = press(emptyVm, emptyOffer, 'A');
    expect(none.result, 'A with nothing to offer').toBe('consumed');
    expect(none.state.toggle, 'mints no token').toBeNull();
    expect(none.state.step).toBe('offer');
    expect(press(emptyVm, emptyOffer, 'Down').state.offer).toBeNull();
  });

  it('CTL8E-1-OFFER-TOGGLE: the cursor is a monster id, not an index: it stays on its monster when the live list grows, and it is never a monster that has left the list', () => {
    // WRONG IMPL KILLED: an index cursor (a monster traded away or a new one received shifts the
    // list: A would toggle a different monster than the one the player marked); a cursor that
    // keeps a stale id (A would toggle a monster that is no longer offerable, which the server
    // would reject as not owned); and a re-seat that throws on a missing id.
    const w = world();
    const vm = vmOf(w);
    const marked = press(vm, stateAt(vm, 'offer'), 'Down').state;
    expect(marked.offer).toBe('22');

    // A new, lower monster arrives: 22 moves from index 1 to index 2.
    w.monsters = [...w.monsters, monster(5n, 'Newt')];
    const grown = vmOf(w);
    expect(grown.lists.offerableMonsters.map((m) => m.monsterId)).toEqual([5n, 11n, 22n, 33n]);
    const toggled = press(grown, marked, 'A');
    expect(toggled.state.toggle, 'A still toggles the monster the cursor marks').toEqual({
      monsterId: 22n,
    });
    expect(press(grown, marked, 'Down').state.offer, 'Down moves on from ITS monster').toBe('33');
    expect(press(grown, marked, 'Up').state.offer, 'Up too').toBe('11');

    // The marked monster leaves: the cursor must land on a monster that is still offered.
    w.monsters = w.monsters.filter((m) => m.monsterId !== 22n);
    const shrunk = vmOf(w);
    const live = shrunk.lists.offerableMonsters.map((m) => m.monsterId.toString());
    expect(live).toEqual(['5', '11', '33']);
    for (const button of ['Down', 'Up'] as const) {
      const step = press(shrunk, marked, button);
      expect(step.result, button).toBe('consumed');
      expect(live, `${button}: the re-seated cursor is still offered`).toContain(step.state.offer);
    }
    const stale = press(shrunk, marked, 'A');
    expect(stale.result).toBe('consumed');
    if (stale.state.toggle !== null) {
      expect(
        shrunk.lists.offerableMonsters.map((m) => m.monsterId),
        'a toggle never names a monster that left the list',
      ).toContain(stale.state.toggle.monsterId);
    }
  });

  it('CTL8E-1-TYPING-ROWS: Coins and Ask are typing rows: A (Enter, released by the field) moves to the next step, the D-pad is swallowed whether fresh or repeated and moves neither the step nor the offer cursor, and neither step ever answers a command', () => {
    // WRONG IMPL KILLED: an A on Coins that stays put (Enter in the field would do nothing now that
    // the field no longer submits); an A on Ask that goes straight to a send (Review is skipped
    // and the draft is sent unseen); a D-pad press that moves the Offer cursor while the player
    // is typing a coin amount; a D-pad press that leaves the step; a held A that pages twice; and
    // an A that mints a commit or toggle token.
    const vm = vmOf(world());
    const cursor = { ...stateAt(vm, 'coins'), offer: '22' };
    const toAsk = press(vm, cursor, 'A');
    expect(toAsk.result).toBe('consumed');
    expect(toAsk.state.step, 'A on Coins').toBe('ask');
    expect(toAsk.state.commit).toBeNull();
    expect(toAsk.state.toggle).toBeNull();
    const toReview = press(vm, { ...stateAt(vm, 'ask'), offer: '22' }, 'A');
    expect(toReview.result, 'A on Ask only steps: nothing is sent yet').toBe('consumed');
    expect(toReview.state.step, 'A on Ask').toBe('review');
    expect(toReview.state.commit).toBeNull();

    for (const here of ['coins', 'ask'] as const) {
      const state = { ...stateAt(vm, here), offer: '22' };
      const held = press(vm, state, 'A', true);
      expect(held.result, `A repeat on ${here}`).toBe('consumed');
      expect(held.state.step, `A repeat on ${here}`).toBe(here);
      for (const button of DPAD) {
        for (const repeat of [false, true]) {
          const step = press(vm, state, button, repeat);
          expect(step.result, `${here} ${button} repeat=${String(repeat)}`).toBe('consumed');
          expect(step.state.step, `${here} ${button}: the step`).toBe(here);
          expect(step.state.offer, `${here} ${button}: the offer cursor`).toBe('22');
        }
      }
    }
  });

  it('CTL8E-1-REVIEW-YES-DEFAULT: Review opens on Yes and every arrival at it does; Up, Down, Left and Right flip Yes / No on a fresh press only; A on Yes mints a NEW commit token and moves the cursor to No so a second A cannot send twice; A on No steps back; no step ever answers a proposeTrade command', () => {
    // WRONG IMPL KILLED: a Review that opens on No (the spec: Yes is the default); one that
    // remembers No from an earlier visit (the player re-enters Review and a bare Enter backs out);
    // a flip on a repeat (a held arrow would end on a random answer); an A on Yes that leaves the
    // cursor on Yes (a double-tap of A sends two offers); a commit token that is reused or
    // compared by value (the view dedups by identity: a second Yes must be able to send again); an
    // A on No that commits; a held A that commits; and an adapter that answers proposeTrade
    // itself (it cannot see the on-screen draft: the VIEW sends it).
    const vm = vmOf(world());
    const results: ScreenResult[] = [];
    const walk = (s: ButtonStep<TradeProposeScreenState>): ButtonStep<TradeProposeScreenState> => {
      results.push(s.result);
      return s;
    };

    // Reaching Review by A from Ask, by RB from Ask, and the first open of the wizard on Review.
    const viaA = walk(press(vm, stateAt(vm, 'ask'), 'A')).state;
    const viaRb = walk(press(vm, stateAt(vm, 'ask'), 'RB')).state;
    for (const [label, state] of [
      ['A', viaA],
      ['RB', viaRb],
    ] as const) {
      expect(state.step, `${label}: reached Review`).toBe('review');
      expect(state.yes, `${label}: Review opens on Yes`).toBe(true);
    }

    // The D-pad flips, wrapping between the two answers; a repeat flips nothing.
    for (const button of DPAD) {
      const flipped = walk(press(vm, viaA, button));
      expect(flipped.state.yes, `${button} from Yes`).toBe(false);
      expect(walk(press(vm, flipped.state, button)).state.yes, `${button} from No`).toBe(true);
      const held = walk(press(vm, viaA, button, true));
      expect(held.result, `${button} repeat`).toBe('consumed');
      expect(held.state.yes, `${button} repeat flips nothing`).toBe(true);
      expect(held.state.step).toBe('review');
    }

    // A on Yes: a new commit token and the cursor on No.
    const yes = walk(press(vm, viaA, 'A'));
    expect(yes.result, 'A on Yes').toBe('consumed');
    expect(yes.state.commit, 'a commit token').toEqual({ kind: 'commit' });
    expect(yes.state.yes, 'the cursor moves to No').toBe(false);
    expect(yes.state.step, 'and the wizard stays on Review').toBe('review');
    expect(yes.state.toggle, 'a commit touches no checkbox').toBeNull();

    // A held A on Yes commits nothing.
    const held = walk(press(vm, viaA, 'A', true));
    expect(held.result).toBe('consumed');
    expect(held.state.commit, 'a repeat never commits').toBeNull();
    expect(held.state.yes).toBe(true);

    // A second A now lands on No: it steps back and mints no new token.
    const second = walk(press(vm, yes.state, 'A'));
    expect(second.result).toBe('consumed');
    expect(second.state.step, 'A on No steps back').toBe('ask');
    expect(second.state.commit, 'and sends nothing more: the very same earlier token').toBe(
      yes.state.commit,
    );

    // Coming back to Review after answering (or leaving it on No) lands on Yes again: the spec's
    // default holds on every arrival, not just the first.
    const leftOnNo = yes.state;
    expect(leftOnNo.yes, 'fixture: the cursor was left on No').toBe(false);
    for (const [label, leave] of [
      ['A on No', second.state],
      ['B', press(vm, leftOnNo, 'B').state],
      ['LB', press(vm, leftOnNo, 'LB').state],
    ] as const) {
      expect(leave.step, `${label}: left Review`).toBe('ask');
      for (const arrive of ['A', 'RB'] as const) {
        const reentered = walk(press(vm, leave, arrive)).state;
        expect(reentered.step, `${label} then ${arrive}: back on Review`).toBe('review');
        expect(reentered.yes, `${label} then ${arrive}: Yes is the default again`).toBe(true);
      }
    }

    // Flipping back to Yes and confirming again is a NEW token, so the view can tell the two apart.
    const back = walk(press(vm, yes.state, 'Up')).state;
    expect(back.yes).toBe(true);
    const again = walk(press(vm, back, 'A'));
    expect(again.state.commit).toEqual({ kind: 'commit' });
    expect(again.state.commit, 'a second confirm is a different token object').not.toBe(
      yes.state.commit,
    );

    // The adapter never answers a proposeTrade command, whatever it was asked.
    for (const result of results) {
      const kind = typeof result === 'object' ? result.kind : result;
      expect(kind, 'the VIEW sends the on-screen draft, never the adapter').not.toBe(
        'proposeTrade',
      );
    }
    expect(results.length, 'ANTI-VACUITY: the walk recorded every press').toBeGreaterThan(10);
  });

  it('CTL8E-1-VIEW-PAINT: paint hands the view exactly { steps, step, lists, offerCursor, yes, toggle, commit } from the state and the live view model, passing the lists and the one-shot tokens by identity', () => {
    // WRONG IMPL KILLED: a paint that copies a token (the view dedups by identity, so a copy
    // would flip a box on every repaint or never again); a paint that rebuilds the lists (the
    // view would be handed a different object than the step decided on); a renamed or missing
    // field (offerCursor sent as `offer`, yes inverted); a paint that sends nothing, or twice;
    // and a paint that hands over the steps of the wrong flag.
    const vm = vmOf(world());
    const marked = press(vm, stateAt(vm, 'offer'), 'Down').state;
    const toggled = press(vm, marked, 'A').state;
    const painted = paintOf(vm, toggled);
    expect(painted).toEqual({
      steps: FULL,
      step: 'offer',
      lists: vm.lists,
      offerCursor: '22',
      yes: true,
      toggle: { monsterId: 22n },
      commit: null,
    });
    expect(painted.lists, 'the very lists object of the view model').toBe(vm.lists);
    expect(painted.toggle, 'the very token object of the state').toBe(toggled.toggle);

    const confirmed = press(vm, stateAt(vm, 'review'), 'A').state;
    const review = paintOf(vm, confirmed);
    expect(review.step).toBe('review');
    expect(review.yes, 'the cursor moved to No after Yes').toBe(false);
    expect(review.commit, 'the very commit token of the state').toBe(confirmed.commit);
    expect(review.commit).toEqual({ kind: 'commit' });

    const supplied = suppliedOf(vm);
    expect(paintOf(supplied, openOf(supplied)).steps, 'a supplied target: four steps').toEqual([
      'offer',
      'coins',
      'ask',
      'review',
    ]);
  });
});
