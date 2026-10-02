// ui/screens/healScreen.test.ts — ctl-8a (CTL8A.3, defect B13): the heal frame's pure adapter.
//
// Node env, no DOM. `healScreen` is driven only through `viewModel(ctx)`, `init(vm)`,
// `onButton(vm, state, btn)`, `observe(vm, state, now)` and `paint(view, vm, state)` into a
// recording fake view. The context's fake store has the two reads the view model makes
// (`healLocations`, `itemDefs`); `ctx.healLocationId` is the binding the last healer interaction
// made (null after a reconnect; 0 is a location id). T opens the frame with no store batch, so a
// case's first adapter call after `init` is often a button.
//
// The contract (plan §2):
//   view model  the bound location's row, else null (unbound, or an id no loaded row has).
//   layout      Yes (enabled only with a location), then No; the cursor opens on Yes.
//   A           on Yes with a location: healParty { locationId } and the cursor moves to No; on a
//               disabled Yes: nothing; on No: pop. B pops. A reads the LIVE view model.
//   D-pad       a fresh Up/Down moves (wrapping); a repeat, Left and Right are swallowed.
//   observe     the SAME state unless the painted cost line changed.
//   paint       `{ active, cost }`; a null cost means Heal is disabled.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type { StoreHealLocationRow, StoreItemRow } from '../../net/store';
import {
  buildHealViewModelForLocation,
  formatHealCostLine,
  type HealLocationViewModel,
} from '../healModel';
import type { HealPaint, HealView } from '../healView';
import { type HealScreenState, type HealScreenVm, healScreen } from './healScreen';
import type { ButtonStep, ScreenContext, ScreenResult } from './types';

const HERB: StoreItemRow = {
  id: 5,
  name: 'Herb',
  description: 'A bitter leaf.',
  recruitBonus: 0,
  trainStat: null,
  trainAmount: 0,
  sellPrice: 4n,
  cureStatus: null,
};

/** Three healers: 7 costs 2 Herb + 25 gold, 0 is free (and a falsy id), 9 costs 40 gold. */
const LOC_7: StoreHealLocationRow = {
  locationId: 7,
  zoneId: 1,
  tileX: 3,
  tileY: 4,
  costItemId: 5,
  costQty: 2,
  cooldownMs: 0,
  costCurrency: 25n,
};
const LOC_0: StoreHealLocationRow = {
  locationId: 0,
  zoneId: 2,
  tileX: 1,
  tileY: 1,
  costQty: 0,
  cooldownMs: 0,
  costCurrency: 0n,
};
const LOC_9: StoreHealLocationRow = {
  locationId: 9,
  zoneId: 3,
  tileX: 8,
  tileY: 2,
  costQty: 0,
  cooldownMs: 0,
  costCurrency: 40n,
};

interface HealWorld {
  locations: StoreHealLocationRow[];
  defs: StoreItemRow[];
  bound: number | null;
}

const defsOf = (defs: readonly StoreItemRow[]): ReadonlyMap<number, StoreItemRow> =>
  new Map(defs.map((d) => [d.id, d]));

function ctxOf(w: HealWorld): ScreenContext {
  const store = {
    healLocations: () => [...w.locations],
    itemDefs: () => defsOf(w.defs),
  };
  return {
    store,
    identity: 'ab'.repeat(32),
    bindings: DEFAULT_BINDINGS,
    now: () => 0,
    shopId: null,
    healLocationId: w.bound,
    reduceMotion: false,
  } as unknown as ScreenContext;
}

const vmOf = (w: HealWorld): HealScreenVm => healScreen.viewModel(ctxOf(w));

const press = (
  vm: HealScreenVm,
  state: HealScreenState,
  button: VButton,
  repeat = false,
): ButtonStep<HealScreenState> => healScreen.onButton(vm, state, { button, repeat });

function observe(vm: HealScreenVm, state: HealScreenState): HealScreenState {
  if (healScreen.observe === undefined) throw new Error('healScreen must define observe');
  return healScreen.observe(vm, state, 0);
}

/** The one paint `paint(view, vm, state)` hands the view. */
function paintOf(vm: HealScreenVm, state: HealScreenState): HealPaint {
  const out: HealPaint[] = [];
  const view = {
    paint: (p: HealPaint) => {
      out.push(p);
    },
  } as unknown as HealView;
  if (healScreen.paint === undefined) throw new Error('healScreen must define paint');
  healScreen.paint(view, vm, state);
  expect(out, 'exactly one paint').toHaveLength(1);
  return out[0] as HealPaint;
}

const heal = (locationId: number): ScreenResult => ({ kind: 'healParty', locationId });
const POP: ScreenResult = { kind: 'pop' };

describe('healScreen — B13: Heal on the bound location (ctl-8a, CTL8A.3)', () => {
  it('CTL8A-3-B13-BOUND-HEAL: B13 — bound to location 7 the frame opens on Yes with THAT location`s cost, and A issues healParty { locationId: 7 }; bound to location 0 the same A issues healParty { locationId: 0 }', () => {
    // WRONG IMPL KILLED (B13): the pre-ctl-8a heal frame with no action at all; a heal sent for
    // the first loaded location (`locations[0]`, the Box button's rule: location 9 here) or with
    // no id (dispatch would then take the first one); a bound id read by truthiness, so location 0
    // reads as unbound (A does nothing) or falls back to the first; a frame that opens on No (Yes
    // is the default); a cost line for another location; and an adapter without its nav mark.
    expect(healScreen.nav, 'the frame takes the D-pad').toBe(true);
    for (const bound of [7, 0] as const) {
      const w: HealWorld = { locations: [LOC_9, LOC_7, LOC_0], defs: [HERB], bound };
      const vm = vmOf(w);
      const row = buildHealViewModelForLocation(bound, w.locations, defsOf(w.defs)).locations[0];
      expect(row, `fixture: location ${bound} is loaded`).toBeDefined();
      expect(vm.location, `${bound}: the bound location's row`).toEqual(row);
      expect(vm.location?.locationId, `${bound}: not the first loaded one`).toBe(bound);
      const cost = formatHealCostLine(row as HealLocationViewModel);
      expect(cost, `fixture: location ${bound}'s cost line`).toBe(
        bound === 7 ? '2x Herb + 25 gold' : 'Free',
      );
      const opened = healScreen.init(vm);
      expect(paintOf(vm, opened), `${bound}: Yes first, with its cost`).toEqual({
        active: 'yes',
        cost,
      });
      expect(press(vm, opened, 'A').result, `${bound}: A on Yes heals there`).toEqual(heal(bound));
    }
  });

  it('CTL8A-3-UNBOUND-DISABLED: with no bound location, or a bound id no loaded location has, the cost is null (Heal disabled) and A on Yes issues nothing; the cursor can still reach No, and A there closes the frame', () => {
    // WRONG IMPL KILLED: an unbound heal that falls back to the first loaded location (B13's root
    // cause), a healParty without a locationId (dispatch would heal at locations[0]), a heal for
    // the unknown id, a disabled Yes that closes the frame (CTL8A.3 says it is disabled with a
    // reason, not that it leaves), and a disabled Yes that traps the cursor.
    for (const bound of [null, 42] as const) {
      const w: HealWorld = { locations: [LOC_9, LOC_7], defs: [HERB], bound };
      const vm = vmOf(w);
      expect(vm.location, `${String(bound)}: no location`).toBeNull();
      const opened = healScreen.init(vm);
      expect(paintOf(vm, opened), `${String(bound)}: Yes first, disabled`).toEqual({
        active: 'yes',
        cost: null,
      });
      const a = press(vm, opened, 'A');
      expect(a.result, `${String(bound)}: A on a disabled Yes`).toBe('consumed');
      expect(paintOf(vm, a.state).active, `${String(bound)}: the cursor stays`).toBe('yes');
      const onNo = press(vm, opened, 'Down');
      expect(onNo.result).toBe('consumed');
      expect(paintOf(vm, onNo.state).active).toBe('no');
      expect(press(vm, onNo.state, 'A').result, `${String(bound)}: A on No closes`).toEqual(POP);
    }
  });

  it('CTL8A-3-NO-AND-B-CLOSE: A on No pops the frame and B pops it from Yes or No; a fresh Up or Down moves between Yes and No, wrapping; a repeat, Left and Right move nothing; Start and Select keep their meaning', () => {
    // WRONG IMPL KILLED: a No that heals; a No or a B that is swallowed (no way out of the frame);
    // a B that heals; a cursor that clamps on a fresh press (Up from Yes must reach No); a repeat
    // that flips the answer (a held arrow); and Left/Right read as Yes/No.
    const vm = vmOf({ locations: [LOC_7], defs: [HERB], bound: 7 });
    const opened = healScreen.init(vm);
    expect(press(vm, opened, 'B').result, 'B on Yes').toEqual(POP);
    const down = press(vm, opened, 'Down');
    expect(down.result).toBe('consumed');
    expect(paintOf(vm, down.state).active, 'Down from Yes').toBe('no');
    expect(press(vm, down.state, 'B').result, 'B on No').toEqual(POP);
    expect(press(vm, down.state, 'A').result, 'A on No').toEqual(POP);
    expect(paintOf(vm, press(vm, down.state, 'Down').state).active, 'Down from No wraps').toBe(
      'yes',
    );
    expect(paintOf(vm, press(vm, opened, 'Up').state).active, 'Up from Yes wraps').toBe('no');
    for (const button of ['Up', 'Down'] as const) {
      const step = press(vm, opened, button, true);
      expect(step.result, `${button} (repeat)`).toBe('consumed');
      expect(paintOf(vm, step.state).active, `${button} (repeat) moves nothing`).toBe('yes');
    }
    for (const button of ['Left', 'Right'] as const) {
      const step = press(vm, opened, button);
      expect(step.result, button).toBe('consumed');
      expect(paintOf(vm, step.state).active, `${button} moves nothing`).toBe('yes');
    }
    expect(press(vm, opened, 'Start').result).toEqual({ kind: 'popToBase' });
    expect(press(vm, opened, 'Select').result).toEqual({ kind: 'toggleHelp' });
  });

  it('CTL8A-3-AFTER-YES-CURSOR-NO: after Yes heals, the frame stays open with the cursor on No, so a second A closes it and never heals twice', () => {
    // WRONG IMPL KILLED: a Yes that leaves the cursor on Yes (a double-tap of A pays for two
    // heals), a Yes that answers pop instead of the heal (the heal is never sent), and a second A
    // that heals again.
    const vm = vmOf({ locations: [LOC_9, LOC_7], defs: [HERB], bound: 7 });
    const healed = press(vm, healScreen.init(vm), 'A');
    expect(healed.result).toEqual(heal(7));
    expect(paintOf(vm, healed.state), 'the cursor is on No, the cost unchanged').toEqual({
      active: 'no',
      cost: '2x Herb + 25 gold',
    });
    expect(press(vm, healed.state, 'A').result, 'the second A closes the frame').toEqual(POP);
  });

  it('CTL8A-3-OBSERVE-COST: observe answers the SAME state while the cost line is unchanged and a new state carrying the new cost when it changes (an item name that loads late, a reconnect that clears the binding), the cursor kept; A reads the live view model, never the painted cost', () => {
    // WRONG IMPL KILLED: an observe that answers a new object every batch (the frame repaints at
    // batch rate); one that never updates the cost (the question keeps "2x Unknown item" after the
    // name loads, or offers a cost after a reconnect cleared the binding); one that resets the
    // cursor when the cost changes; and an A that heals from the state's remembered cost while
    // the live view model has no location, or refuses while it has one.
    const w: HealWorld = { locations: [LOC_7], defs: [], bound: 7 };
    const early = vmOf(w);
    const opened = healScreen.init(early);
    expect(paintOf(early, opened).cost, 'fixture: the item name has not loaded').toBe(
      '2x Unknown item + 25 gold',
    );
    expect(observe(vmOf(w), opened), 'nothing changed: the same object').toBe(opened);
    const onNo = press(early, opened, 'Down').state;

    w.defs = [HERB];
    const named = vmOf(w);
    const renamed = observe(named, onNo);
    expect(renamed, 'the cost line changed: a new state').not.toBe(onNo);
    expect(paintOf(named, renamed), 'the new cost, the cursor kept').toEqual({
      active: 'no',
      cost: '2x Herb + 25 gold',
    });
    expect(observe(vmOf(w), renamed), 'unchanged since: the same object').toBe(renamed);

    w.bound = null;
    const unbound = vmOf(w);
    const cleared = observe(unbound, renamed);
    expect(cleared, 'a reconnect cleared the binding: a new state').not.toBe(renamed);
    expect(paintOf(unbound, cleared)).toEqual({ active: 'no', cost: null });

    // A reads the live view model, whatever cost the state painted.
    const boundVm = vmOf({ locations: [LOC_7], defs: [HERB], bound: 7 });
    const unboundVm = vmOf({ locations: [LOC_7], defs: [HERB], bound: null });
    expect(
      press(unboundVm, healScreen.init(boundVm), 'A').result,
      'painted with a cost, live with none: nothing',
    ).toBe('consumed');
    expect(
      press(boundVm, healScreen.init(unboundVm), 'A').result,
      'painted disabled, live bound: the heal',
    ).toEqual(heal(7));
  });
});
