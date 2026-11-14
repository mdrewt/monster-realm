// ui/screens/tradeSessionScreen.test.ts — ts-3 (ts-3.2, ts-3.3, ts-3.4, ts-3.6): the trade session
// editor's pure screen adapter.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-trade-sessions.spec.md §ts-3 and
//   memory/projects/monster-realm-ts-3-plan.md §Contracts › `ui/screens/tradeSessionScreen.ts`.
//
// RED REASON: client/src/ui/screens/tradeSessionScreen.ts and ui/tradeSessionModel.ts do not exist
//   yet (module-not-found).
//
// Node env, no DOM. The adapter is driven through `init(vm, remembered)`, `onButton(vm, state,
// btn)`, `observe(vm, state, now)` and `paint(view, vm, state)` into a recording fake view. Every
// view model is built by the REAL `buildTradeSessionVm` over a fixture input, so the adapter is
// proved against the model it ships with. `viewModel(ctx)`'s wiring (party size, the cap, the
// battle set) is proved by the boot suites (main.*.test.ts, batch T2); the last describe here
// drives it once over a store double to prove it reads no legacy trade offer (ts-4.4).
//
// Fixture: ME opened session 7 with Bob at revision 2^53 + 1; ME's side starts EMPTY, Bob's holds
// monster 91. ME's party (PARTY_SIZE 3, by slot): 11 free, 12 fainted, 13 free; inventory item 4
// ×3; a large balance so the held-coins acceleration has room. Cap: 2 monsters per side.
// The rows of the empty draft: monster-11, monster-12 (fainted), monster-13, item-4, coins, apply
// (nothing to send), confirm, cancel.
import { describe, expect, it } from 'vitest';
import type { VButton } from '../../input/buttons';
import type { StoreMonsterPub, StoreTradeSession, StoreTradeSessionOffer } from '../../net/store';
import type { NavInput } from '../nav';
import {
  buildTradeSessionVm,
  editorRows,
  type TradeOfferDraft,
  type TradeSessionInput,
  type TradeSessionScreenVm,
} from '../tradeSessionModel';
import type { TradeSessionPaint, TradeSessionView } from '../tradeSessionView';
import { coinStep, type TradeSessionScreenState, tradeSessionScreen } from './tradeSessionScreen';
import type { ButtonStep, ScreenContext } from './types';

const ME = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const R0 = 9_007_199_254_740_993n;
const SID = 7n;
const BALANCE = 1_000_000n;

const EMPTY: StoreTradeSessionOffer = { monsterIds: [], items: [], currency: 0n, cards: [] };
const BOB_SIDE: StoreTradeSessionOffer = {
  monsterIds: [91n],
  items: [],
  currency: 0n,
  cards: [{ monsterId: 91n, speciesId: 1, nickname: 'Zed', level: 4, currentHp: 9, statHp: 9 }],
};

function sess(over: Partial<StoreTradeSession> = {}): StoreTradeSession {
  return {
    sessionId: SID,
    opener: ME,
    partner: BOB,
    openerOffer: EMPTY,
    partnerOffer: BOB_SIDE,
    openerConfirmed: false,
    partnerConfirmed: false,
    revision: R0,
    createdAtMs: 1_000n,
    ...over,
  };
}

/** ME's side of the row as the server holds it. */
const mySide = (
  monsterIds: bigint[],
  items: { itemId: number; qty: number }[] = [],
  currency = 0n,
) => ({ monsterIds, items, currency, cards: [] }) as StoreTradeSessionOffer;

function mon(monsterId: bigint, partySlot: number, nickname: string, currentHp = 20) {
  return {
    monsterId,
    ownerIdentity: ME,
    speciesId: 1,
    nickname,
    level: 5,
    currentHp,
    statHp: 20,
    partySlot,
  } as unknown as StoreMonsterPub;
}

function input(sessions: readonly StoreTradeSession[], over: Partial<TradeSessionInput> = {}) {
  const i: TradeSessionInput = {
    sessions,
    identity: ME,
    sessionId: SID,
    players: [{ identity: BOB, entityId: 2n, name: 'Bob', online: true }],
    ownMonsters: [mon(13n, 2, 'Cyd'), mon(11n, 0, 'Ash'), mon(12n, 1, 'Bry', 0)],
    speciesMap: new Map([[1, { name: 'Sprout' }]]),
    itemDefs: new Map(),
    inventory: [{ invId: 1n, ownerIdentity: ME, itemId: 4, count: 3 }],
    balance: BALANCE,
    battleMonsterIds: new Set(),
    partySize: 3,
    maxMonstersPerSide: 2,
    ...over,
  };
  return i;
}

/** A FRESH view model of `row` (built again on every call, as the host does per step). */
const vmOf = (
  row: StoreTradeSession = sess(),
  over: Partial<TradeSessionInput> = {},
): TradeSessionScreenVm => buildTradeSessionVm(input([row], over));

const GONE: TradeSessionScreenVm = { kind: 'gone' };

const open = (vm: TradeSessionScreenVm, remembered?: TradeSessionScreenState) =>
  tradeSessionScreen.init(vm, remembered);

type Input = VButton | NavInput;
const rep = (button: VButton): NavInput => ({ button, repeat: true });
const asInput = (i: Input): NavInput => (typeof i === 'string' ? { button: i, repeat: false } : i);
const label = (i: Input): string =>
  typeof i === 'string' ? i : `${i.button}${i.repeat ? ' (repeat)' : ''}`;

const press = (
  vm: TradeSessionScreenVm,
  state: TradeSessionScreenState,
  i: Input,
): ButtonStep<TradeSessionScreenState> => tradeSessionScreen.onButton(vm, state, asInput(i));

/** Feed `inputs`, each answered 'consumed', and return the last state. */
function walk(
  vm: TradeSessionScreenVm,
  state: TradeSessionScreenState,
  inputs: readonly Input[],
): TradeSessionScreenState {
  let s = state;
  for (const i of inputs) {
    const step = press(vm, s, i);
    expect(step.result, `${label(i)} is consumed`).toBe('consumed');
    s = step.state;
  }
  return s;
}

function observe(vm: TradeSessionScreenVm, state: TradeSessionScreenState) {
  if (tradeSessionScreen.observe === undefined) throw new Error('the editor must observe');
  return tradeSessionScreen.observe(vm, state, 0);
}

function paintOf(vm: TradeSessionScreenVm, state: TradeSessionScreenState): TradeSessionPaint {
  const out: TradeSessionPaint[] = [];
  const view = {
    paint: (p: TradeSessionPaint) => {
      out.push(p);
    },
  } as unknown as TradeSessionView;
  if (tradeSessionScreen.paint === undefined) throw new Error('the editor must paint');
  tradeSessionScreen.paint(view, vm, state);
  expect(out, 'exactly one paint').toHaveLength(1);
  return out[0] as TradeSessionPaint;
}

/** The rows' keys for `vm` and `draft` (the model's own, never spelled twice). */
function rowKeys(vm: TradeSessionScreenVm, draft: TradeOfferDraft): string[] {
  if (vm.kind !== 'session') throw new Error('a session vm');
  return editorRows(vm, draft).map((r) => r.key);
}

/** Move the cursor to `key` with fresh Downs (fails when it is not reachable). */
function cursorTo(
  vm: TradeSessionScreenVm,
  state: TradeSessionScreenState,
  key: string,
): TradeSessionScreenState {
  let s = state;
  for (let i = 0; i < 32 && s.nav.item !== key; i++) s = walk(vm, s, ['Down']);
  expect(s.nav.item, `the cursor reaches ${key}`).toBe(key);
  return s;
}

const INITIAL_KEYS = [
  'monster-11',
  'monster-12',
  'monster-13',
  'item-4',
  'coins',
  'apply',
  'confirm',
  'cancel',
];

describe('tradeSessionScreen — opening and the list (ts-3.4)', () => {
  it('ts-3.4 init opens fresh on the first row with seed = draft = the stored side, the vm`s revision, no notice, no prompt; every row is reached with Down and with Up, a fresh press wraps and a held one clamps; the adapter takes the D-pad and opts in to memory', () => {
    // WRONG IMPL KILLED: no nav / remember marks (the router would not hand it the D-pad; an
    // unsent draft would be lost on close); a cursor on no row or on the last; a seed or draft
    // that is not the stored side (an Update would resend a stale draft); a revision that is a
    // constant or 0; a disabled row the cursor skips (its reason would never be read out); a fresh
    // press at an end that clamps, or a held one that wraps (a held key would cycle the list).
    expect(tradeSessionScreen.nav).toBe(true);
    expect(tradeSessionScreen.remember).toBe(true);
    const vm = vmOf();
    expect(vm.kind, 'fixture').toBe('session');
    const s = open(vm);
    expect(s).toMatchObject({
      sessionId: SID,
      revision: R0,
      notice: 0,
      prompt: null,
      streak: 0,
      mineConfirmed: false,
    });
    expect(s.draft).toEqual({ monsterIds: [], items: [], currency: 0n });
    expect(s.seed).toEqual(s.draft);
    expect(s.nav.item, 'the first row').toBe('monster-11');
    expect(rowKeys(vm, s.draft), 'fixture: the rows').toEqual(INITIAL_KEYS);

    let down = s;
    const seenDown: string[] = [];
    for (let i = 0; i < INITIAL_KEYS.length; i++) {
      seenDown.push(down.nav.item ?? '');
      down = walk(vm, down, ['Down']);
    }
    expect(seenDown, 'Down visits every row in order').toEqual(INITIAL_KEYS);
    expect(down.nav.item, 'a fresh Down on the last row wraps').toBe('monster-11');

    let up = s;
    const seenUp: string[] = [];
    for (let i = 0; i < INITIAL_KEYS.length; i++) {
      up = walk(vm, up, ['Up']);
      seenUp.push(up.nav.item ?? '');
    }
    expect(seenUp, 'Up visits every row backwards, wrapping first').toEqual([
      ...[...INITIAL_KEYS].reverse(),
    ]);

    expect(walk(vm, s, [rep('Up')]).nav.item, 'a held Up on the first row stays').toBe(
      'monster-11',
    );
    const last = walk(vm, s, ['Up']);
    expect(walk(vm, last, [rep('Down')]).nav.item, 'a held Down on the last stays').toBe('cancel');
    expect(walk(vm, s, [rep('Down')]).nav.item, 'a held Down moves on').toBe('monster-12');
  });

  it('ts-3.4 B pops from the list, Start pops to the base, Select toggles help, a held one of them is swallowed; Left / Right on a monster, apply, confirm or cancel row move and change nothing', () => {
    // WRONG IMPL KILLED: a B that is swallowed (no way out but Start); a held B / Start / Select
    // that acts (a held key would close the editor and the frame under it); a Left / Right that
    // toggles a monster or edits the coins from another row.
    const vm = vmOf();
    const s = open(vm);
    expect(press(vm, s, 'B').result).toEqual({ kind: 'pop' });
    expect(press(vm, s, 'Start').result).toEqual({ kind: 'popToBase' });
    expect(press(vm, s, 'Select').result).toEqual({ kind: 'toggleHelp' });
    for (const b of ['B', 'Start', 'Select'] as const) {
      expect(press(vm, s, rep(b)).result, `a held ${b}`).toBe('consumed');
    }
    for (const key of ['monster-11', 'monster-12', 'apply', 'confirm', 'cancel']) {
      const on = cursorTo(vm, s, key);
      for (const i of ['Left', 'Right', rep('Left'), rep('Right')] as const) {
        const step = press(vm, on, i);
        expect(step.result, `${label(i)} on ${key}`).toBe('consumed');
        expect(step.state.draft, `${label(i)} on ${key}: the draft is unchanged`).toEqual(on.draft);
        expect(step.state.nav.item, `${label(i)} on ${key}: the cursor stays`).toBe(key);
      }
    }
  });
});

describe('tradeSessionScreen — editing by D-pad and A (ts-3.4)', () => {
  it('ts-3.4 A toggles a monster on and off; A on a blocked monster and a held A anywhere do nothing', () => {
    // WRONG IMPL KILLED: an A that sends a command on a monster row (each toggle would hit the
    // server); a toggle that ignores the block (a fainted monster offered); a held A that toggles
    // (a held Enter would flip it at repeat rate); a held A on apply / confirm / cancel that acts.
    const vm = vmOf();
    const s = open(vm);
    const on = press(vm, s, 'A');
    expect(on.result).toBe('consumed');
    expect(on.state.draft.monsterIds).toEqual([11n]);
    const off = press(vm, on.state, 'A');
    expect(off.state.draft.monsterIds).toEqual([]);
    const onBry = cursorTo(vm, s, 'monster-12');
    expect(press(vm, onBry, 'A').state.draft.monsterIds, 'fainted: swallowed').toEqual([]);
    expect(press(vm, onBry, 'A').result).toBe('consumed');

    // A held A never acts, on any row, with an edited draft so apply is enabled.
    const dirty = on.state;
    for (const key of rowKeys(vm, dirty.draft)) {
      const at = cursorTo(vm, dirty, key);
      const held = press(vm, at, rep('A'));
      expect(held.result, `a held A on ${key}`).toBe('consumed');
      expect(held.state.draft, `a held A on ${key}: the draft`).toEqual(at.draft);
      expect(held.state.prompt, `a held A on ${key}: no prompt`).toBeNull();
    }
  });

  it('ts-3.4 on an item row Left / Right step the quantity by one (held repeats too) and A adds one, clamped to what is held', () => {
    // WRONG IMPL KILLED: Right that does nothing on a held repeat (a held key could not count up);
    // A that toggles the line instead of adding one; a quantity past the 3 held.
    const vm = vmOf();
    const s = cursorTo(vm, open(vm), 'item-4');
    const qty = (st: TradeSessionScreenState) =>
      st.draft.items.find((l) => l.itemId === 4)?.qty ?? 0;
    const one = walk(vm, s, ['Right']);
    expect(qty(one)).toBe(1);
    const two = walk(vm, one, [rep('Right')]);
    expect(qty(two), 'a held Right steps too').toBe(2);
    expect(qty(walk(vm, two, ['Left'])), 'Left takes one').toBe(1);
    expect(qty(walk(vm, two, [rep('Left'), rep('Left')])), 'to zero: the line is dropped').toBe(0);
    expect(walk(vm, two, [rep('Left'), rep('Left')]).draft.items).toEqual([]);
    const viaA = press(vm, two, 'A');
    expect(viaA.result).toBe('consumed');
    expect(qty(viaA.state), 'A adds one').toBe(3);
    expect(qty(walk(vm, viaA.state, ['Right', 'A'])), 'clamped at the 3 held').toBe(3);
  });

  it('ts-3.4 coinStep is 1 below a streak of 8, 10 below 16, 100 below 24 and 1000 beyond', () => {
    // WRONG IMPL KILLED: off-by-one thresholds (`<=`); a number instead of a bigint; no top tier.
    const cases: ReadonlyArray<readonly [number, bigint]> = [
      [0, 1n],
      [7, 1n],
      [8, 10n],
      [15, 10n],
      [16, 100n],
      [23, 100n],
      [24, 1000n],
      [99, 1000n],
    ];
    for (const [streak, step] of cases) expect(coinStep(streak), `streak ${streak}`).toBe(step);
  });

  it('ts-3.4 on the coins row Left / Right step by coinStep(streak): a fresh press steps 1 and zeroes the streak, each held repeat adds one to it and accelerates through 10, 100 and 1000, and a fresh press starts over; A adds one coin', () => {
    // WRONG IMPL KILLED: a constant step (reaching a large amount would take thousands of
    // presses); a streak never reset by a fresh press (the next tap would jump 1000); a streak
    // counted on fresh presses; a decrease that ignores the streak; A that does nothing.
    const vm = vmOf();
    const s = cursorTo(vm, open(vm), 'coins');
    let st = walk(vm, s, ['Right']);
    expect(st.draft.currency, 'a fresh Right: one coin').toBe(1n);
    expect(st.streak, 'a fresh press: streak 0').toBe(0);
    const deltas: bigint[] = [];
    for (let k = 1; k <= 30; k++) {
      const next = walk(vm, st, [rep('Right')]);
      const delta = next.draft.currency - st.draft.currency;
      expect(next.streak, `held repeat ${k}: the streak counts it`).toBe(k);
      expect(
        [coinStep(st.streak), coinStep(next.streak)],
        `held repeat ${k}: the step is coinStep of the streak`,
      ).toContain(delta);
      deltas.push(delta);
      st = next;
    }
    for (const tier of [1n, 10n, 100n, 1000n]) {
      expect(deltas, `the held run reaches a step of ${tier}`).toContain(tier);
    }
    expect(
      deltas.every((d, i) => i === 0 || d >= (deltas[i - 1] as bigint)),
      'the steps never shrink during one held run',
    ).toBe(true);
    const fresh = walk(vm, st, ['Right']);
    expect(fresh.draft.currency - st.draft.currency, 'a fresh press starts over').toBe(1n);
    expect(fresh.streak).toBe(0);
    const freshLeft = walk(vm, st, ['Left']);
    expect(freshLeft.draft.currency - st.draft.currency, 'a fresh Left takes one').toBe(-1n);
    const heldLeft = walk(vm, walk(vm, st, ['Left']), Array(10).fill(rep('Left')));
    expect(
      walk(vm, st, ['Left']).draft.currency - heldLeft.draft.currency,
      'a held Left accelerates too',
    ).toBeGreaterThan(10n);
    expect(press(vm, s, 'A').state.draft.currency, 'A adds one coin').toBe(1n);
  });

  it('ts-3.4 Update offer sends the draft as setTradeOffer (ids ascending, items by id, the coins); with nothing to send A on it is swallowed', () => {
    // WRONG IMPL KILLED: an Update that sends the stored side (the seed) instead of the draft; the
    // session id dropped or another session's; the coins as a Number; an empty Update sent when
    // nothing changed.
    const vm = vmOf();
    const s = open(vm);
    const nothing = cursorTo(vm, s, 'apply');
    const idle = press(vm, nothing, 'A');
    expect(idle.result, 'nothing to send: swallowed').toBe('consumed');
    let d = walk(vm, s, ['Down', 'Down', 'A']); // monster-13 on
    d = walk(vm, cursorTo(vm, d, 'monster-11'), ['A']); // monster-11 on
    d = walk(vm, cursorTo(vm, d, 'item-4'), ['Right', 'Right']);
    d = walk(vm, cursorTo(vm, d, 'coins'), ['Right', 'A']);
    const step = press(vm, cursorTo(vm, d, 'apply'), 'A');
    expect(step.result).toEqual({
      kind: 'setTradeOffer',
      sessionId: SID,
      monsterIds: [11n, 13n],
      items: [{ itemId: 4, qty: 2 }],
      currency: 2n,
    });
  });

  it('ts-3.4 Confirm and Cancel ask Yes / No on No: A on No closes, B closes the prompt only, a fresh Up or Down flips and a held one does not, Left / Right and a held A are swallowed, Up then A on Yes sends confirmTradeSession with the revision or cancelTradeSession', () => {
    // WRONG IMPL KILLED: a prompt that opens on Yes (one more A would complete a trade); a Confirm
    // with no prompt; an A on No that sends; a B that pops the editor from the prompt; a held
    // arrow that flips; the confirm command without the revision or with the wrong session.
    const vm = vmOf();
    const s = open(vm);
    for (const [key, action, command] of [
      ['confirm', 'confirm', { kind: 'confirmTradeSession', sessionId: SID, revision: R0 }],
      ['cancel', 'cancel', { kind: 'cancelTradeSession', sessionId: SID }],
    ] as const) {
      const at = cursorTo(vm, s, key);
      const asked = press(vm, at, 'A');
      expect(asked.result, `${key}: A only asks`).toBe('consumed');
      expect(asked.state.prompt, `${key}: the prompt on No`).toEqual({ action, yes: false });
      const no = press(vm, asked.state, 'A');
      expect(no.result, `${key}: A on No sends nothing`).toBe('consumed');
      expect(no.state.prompt).toBeNull();
      const b = press(vm, asked.state, 'B');
      expect(b.result, `${key}: B closes the prompt, never pops`).toBe('consumed');
      expect(b.state.prompt).toBeNull();
      for (const flip of ['Up', 'Down'] as const) {
        expect(walk(vm, asked.state, [flip]).prompt, `${key}: ${flip} flips`).toEqual({
          action,
          yes: true,
        });
        expect(walk(vm, asked.state, [rep(flip)]).prompt, `${key}: a held ${flip}`).toEqual({
          action,
          yes: false,
        });
      }
      const yes = walk(vm, asked.state, ['Up']);
      for (const i of ['Left', 'Right', rep('A')] as const) {
        const step = press(vm, yes, i);
        expect(step.result, `${key}: ${label(i)} on Yes`).toBe('consumed');
        expect(step.state.prompt, `${key}: ${label(i)} keeps the prompt`).toEqual({
          action,
          yes: true,
        });
      }
      const sent = press(vm, yes, 'A');
      expect(sent.result, `${key}: A on Yes`).toEqual(command);
      expect(sent.state.prompt, `${key}: the prompt closes`).toBeNull();
    }
  });

  it('ts-3.4 no state has an empty row list: no monsters, no items and no coins still leave a cursor; a confirmed side leaves Cancel', () => {
    // WRONG IMPL KILLED: a null cursor on a bare editor (A and the paint would act on nothing).
    const bare = vmOf(sess(), { ownMonsters: [], inventory: [], balance: 0n });
    const s = open(bare);
    expect(s.nav.item, 'the first of coins, apply, confirm, cancel').toBe('coins');
    expect(paintOf(bare, s).rows.length).toBeGreaterThan(0);
    const locked = vmOf(sess({ openerConfirmed: true }), {
      ownMonsters: [],
      inventory: [],
      balance: 0n,
    });
    expect(open(locked).nav.item).toBe('cancel');
  });
});

describe('tradeSessionScreen — the confirmed side (ts-3.2)', () => {
  it('ts-3.2 WHILE the viewer`s side is confirmed the editor offers only Cancel: the cursor sits on it, Up / Down / Left / Right edit nothing, A asks to cancel; a confirm landing while the cursor is on a monster re-seats it on Cancel', () => {
    // WRONG IMPL KILLED: an editor that still toggles or steps after confirming (an edit the
    // server would apply, un-confirming the viewer: E4); a Confirm offered again; a cursor left on
    // a row that is gone.
    const vm = vmOf(sess({ openerConfirmed: true }));
    const s = open(vm);
    expect(paintOf(vm, s).rows.map((r) => r.key)).toEqual(['cancel']);
    expect(s.nav.item).toBe('cancel');
    for (const i of ['Up', 'Down', 'Left', 'Right', rep('Right')] as const) {
      const step = press(vm, s, i);
      expect(step.result, label(i)).toBe('consumed');
      expect(step.state.draft, `${label(i)}: no edit`).toEqual(s.draft);
      expect(step.state.nav.item, `${label(i)}: still Cancel`).toBe('cancel');
    }
    expect(press(vm, s, 'A').state.prompt).toEqual({ action: 'cancel', yes: false });

    const editing = open(vmOf());
    expect(editing.nav.item, 'fixture: on monster-11').toBe('monster-11');
    const settled = observe(vm, editing);
    expect(settled.nav.item, 'the confirm re-seats the cursor on Cancel').toBe('cancel');
    expect(paintOf(vm, settled).rows.map((r) => r.key)).toEqual(['cancel']);
  });
});

describe('tradeSessionScreen — the revision and the notice (ts-3.3)', () => {
  it('ts-3.3 a revision change while open raises the notice (counting each raise), closes an open prompt and paints the row`s marks; the confirm then sends the NEW revision the editor shows, and a sent confirm clears the notice', () => {
    // WRONG IMPL KILLED: a confirm that carries the revision remembered at open (R0) or R0 + 1 ahead
    // of the row, or a constant; a revision change that leaves a prompt open (the player would
    // confirm terms they have not seen); a notice that only flags (no count: the view could not
    // announce the second change); marks painted from memory (the server cleared both).
    const vm0 = vmOf(sess({ partnerConfirmed: true }));
    const s0 = open(vm0);
    const asked = walk(vm0, cursorTo(vm0, s0, 'confirm'), ['A', 'Up']);
    expect(asked.prompt, 'fixture: the prompt on Yes').toEqual({ action: 'confirm', yes: true });

    // Bob edits: the server bumps the revision and clears both marks.
    const R1 = R0 + 1n;
    const vm1 = vmOf(sess({ revision: R1, partnerOffer: { ...BOB_SIDE, currency: 5n } }));
    const changed = observe(vm1, asked);
    expect(changed, 'a new state').not.toBe(asked);
    expect(changed.notice, 'the first raise').toBe(1);
    expect(changed.prompt, 'the prompt closes').toBeNull();
    expect(changed.revision).toBe(R1);
    const painted = paintOf(vm1, changed);
    expect(painted.notice).toBe(1);
    expect(painted.prompt).toBeNull();
    expect(painted.vm.kind === 'session' && painted.vm.revision).toBe(R1);
    expect(
      painted.vm.kind === 'session' && [painted.vm.mine.confirmed, painted.vm.theirs.confirmed],
      'the row`s marks: both cleared',
    ).toEqual([false, false]);
    expect(observe(vm1, changed), 'then stable').toBe(changed);

    const R2 = R1 + 1n;
    const vm2 = vmOf(sess({ revision: R2, partnerOffer: { ...BOB_SIDE, currency: 6n } }));
    const again = observe(vm2, changed);
    expect(again.notice, 'a second raise counts').toBe(2);

    const confirmAt = walk(vm2, cursorTo(vm2, again, 'confirm'), ['A', 'Up']);
    const sent = press(vm2, confirmAt, 'A');
    expect(sent.result, 'the revision the editor displays').toEqual({
      kind: 'confirmTradeSession',
      sessionId: SID,
      revision: R2,
    });
    expect(sent.state.notice, 'a sent confirm clears the notice').toBe(0);
  });

  it('ts-3.3 an A, Left or Right aimed at a state the settle just changed sends and edits nothing: the prompt on Yes when the revision moves, an item row, a monster row', () => {
    // WRONG IMPL KILLED: an A that confirms through a prompt the settle has just closed (the
    // revision sent would be one the player never saw); a step or a toggle applied to a screen
    // the player has not seen yet.
    const vm0 = vmOf();
    const s0 = open(vm0);
    const vm1 = vmOf(sess({ revision: R0 + 1n, partnerOffer: { ...BOB_SIDE, currency: 1n } }));
    const onYes = walk(vm0, cursorTo(vm0, s0, 'confirm'), ['A', 'Up']);
    const pressed = press(vm1, onYes, 'A');
    expect(pressed.result, 'nothing is sent').toBe('consumed');
    expect(pressed.state.prompt).toBeNull();
    expect(pressed.state.notice).toBe(1);
    const onItem = cursorTo(vm0, s0, 'item-4');
    for (const i of ['Right', 'Left', 'A'] as const) {
      const step = press(vm1, onItem, i);
      expect(step.result, `${i} on the item row`).toBe('consumed');
      expect(step.state.draft, `${i}: no edit`).toEqual(onItem.draft);
    }
    const toggled = press(vm1, s0, 'A');
    expect(toggled.state.draft.monsterIds, 'no toggle on an unseen screen').toEqual([]);
    expect(toggled.result).toBe('consumed');
  });

  it('ts-3.3 E4 clearing the viewer`s own mark at the SAME revision raises the notice; a partner`s confirm at the same revision raises none but still yields a NEW state; an unchanged batch yields the SAME state', () => {
    // WRONG IMPL KILLED: a notice keyed on the revision alone (E4 flips one flag at the same
    // revision: the player would not learn their confirm was dropped); a repaint keyed on the
    // revision alone (the partner's mark would never show); an observe that answers a new object
    // for an unchanged batch (a repaint per batch).
    const confirmed = vmOf(sess({ openerConfirmed: true }));
    const s = open(confirmed);
    expect(s.mineConfirmed, 'fixture').toBe(true);
    expect(observe(vmOf(sess({ openerConfirmed: true })), s), 'unchanged: the same state').toBe(s);
    const cleared = observe(vmOf(sess()), s);
    expect(cleared.notice, 'E4: the own mark cleared at the same revision').toBe(1);
    expect(cleared.revision).toBe(R0);
    expect(cleared.mineConfirmed).toBe(false);

    const plain = open(vmOf());
    const partner = observe(vmOf(sess({ partnerConfirmed: true })), plain);
    expect(partner, 'a NEW state, so the mark repaints').not.toBe(plain);
    expect(partner.notice, 'no notice for the partner`s confirm').toBe(0);
    expect(observe(vmOf(sess({ partnerConfirmed: true })), partner), 'then stable').toBe(partner);
  });

  it('ts-3.3 an own-edit echo does not overwrite newer local edits (the seed moves, the dirty draft stays) and a clean draft follows the server', () => {
    // WRONG IMPL KILLED: the draft reset to the server's side on every change (an edit made while
    // an Update is in flight is lost when the echo lands); a seed that never moves (the apply row
    // would stay enabled against a stale seed, and a clean draft would never follow a server
    // change of the own side).
    const vm0 = vmOf();
    let s = walk(vm0, open(vm0), ['A']); // monster-11 on
    const sent = press(vm0, cursorTo(vm0, s, 'apply'), 'A');
    expect(sent.result).toMatchObject({ kind: 'setTradeOffer', monsterIds: [11n] });
    s = walk(vm0, cursorTo(vm0, sent.state, 'monster-13'), ['A']); // monster-13 on, unsent
    expect(s.draft.monsterIds, 'fixture: a newer local edit').toEqual([11n, 13n]);

    const echo = vmOf(sess({ revision: R0 + 1n, openerOffer: mySide([11n]) }));
    const after = observe(echo, s);
    expect(after.seed.monsterIds, 'the seed moves to the server`s side').toEqual([11n]);
    expect(after.draft.monsterIds, 'the dirty draft is kept').toEqual([11n, 13n]);

    // A clean draft follows a server change of the own side.
    const clean = open(vm0);
    const moved = observe(vmOf(sess({ revision: R0 + 1n, openerOffer: mySide([13n]) })), clean);
    expect(moved.draft.monsterIds, 'clean: the draft follows').toEqual([13n]);
    expect(moved.seed.monsterIds).toEqual([13n]);
  });
});

describe('tradeSessionScreen — gone and a state per session (ts-3.6)', () => {
  it('ts-3.6 on a gone vm every fresh button answers pop and observe keeps the state; a session that leaves keeps the state too', () => {
    // WRONG IMPL KILLED: a gone editor that swallows B (stuck open over a closed trade); a throw
    // on a gone vm; an observe that rebuilds the state when the row leaves (the main shell closes
    // the frame through the stack: the adapter must not repaint an empty draft over it).
    const gone = open(GONE);
    expect(gone.sessionId).toBeNull();
    expect(gone.draft).toEqual({ monsterIds: [], items: [], currency: 0n });
    const buttons: readonly VButton[] = [
      'Up',
      'Down',
      'Left',
      'Right',
      'A',
      'B',
      'X',
      'Y',
      'LB',
      'RB',
      'Start',
      'Select',
    ];
    for (const b of buttons) expect(press(GONE, gone, b).result, b).toEqual({ kind: 'pop' });
    expect(observe(GONE, gone)).toBe(gone);
    const live = walk(vmOf(), open(vmOf()), ['A']);
    expect(observe(GONE, live), 'the row left: the same state').toBe(live);
    expect(press(GONE, live, 'A').result).toEqual({ kind: 'pop' });
  });

  it('ts-3.6 a state never crosses sessions: a vm for another session starts a fresh draft with no prompt and no notice; init keeps a remembered unsent draft of the SAME session (prompt closed) and drops one of another session', () => {
    // WRONG IMPL KILLED: a draft carried into another session (monsters chosen for Bob offered to
    // Carol); a prompt or a notice carried across; an unsent draft lost on a close and reopen; a
    // remembered prompt reopened.
    const vm = vmOf();
    const prompted = walk(vm, cursorTo(vm, walk(vm, open(vm), ['A']), 'cancel'), ['A']);
    expect(prompted.draft.monsterIds, 'fixture').toEqual([11n]);
    expect(prompted.prompt, 'fixture').toEqual({ action: 'cancel', yes: false });

    const other = buildTradeSessionVm(
      input([sess(), sess({ sessionId: 8n, revision: 3n })], { sessionId: 8n }),
    );
    expect(other.kind === 'session' && other.sessionId, 'fixture').toBe(8n);
    const crossed = observe(other, prompted);
    expect(crossed.sessionId).toBe(8n);
    expect(crossed.draft).toEqual({ monsterIds: [], items: [], currency: 0n });
    expect(crossed.prompt).toBeNull();
    expect(crossed.notice).toBe(0);
    expect(crossed.revision).toBe(3n);

    const reopened = open(vmOf(), prompted);
    expect(reopened.draft.monsterIds, 'the same session: the unsent draft survives').toEqual([11n]);
    expect(reopened.prompt, 'a remembered prompt is closed').toBeNull();
    expect(reopened.streak).toBe(0);
    const elsewhere = open(other, prompted);
    expect(elsewhere.sessionId).toBe(8n);
    expect(elsewhere.draft.monsterIds, 'another session: a fresh draft').toEqual([]);
  });

  it('ts-3.2 (contract C) a DRAFT-only item line whose stack vanishes is dropped on observe (a new state), while a STORED line whose stack vanishes stays at the draft`s quantity with its row', () => {
    // RED REASON: today settle keeps the draft as it was, so the unsent line for an item the viewer
    // no longer holds (and never stored) stays in the draft: Update offer would send a line the
    // server refuses, and with no row left the player cannot remove it.
    // WRONG IMPL KILLED: no drop at all; a drop of EVERY line with no stack (the stored item 4,
    // still on the table, would vanish from the draft: an Update would silently withdraw it); a
    // drop that also resets the dirty quantity of a kept line (3 back to the stored 2).
    const stored = sess({ openerOffer: mySide([], [{ itemId: 4, qty: 2 }]) });
    const held = [
      { invId: 1n, ownerIdentity: ME, itemId: 4, count: 3 },
      { invId: 2n, ownerIdentity: ME, itemId: 6, count: 2 },
    ];
    const vm0 = vmOf(stored, { inventory: held });
    let s = open(vm0);
    expect(s.draft.items, 'fixture: the stored line').toEqual([{ itemId: 4, qty: 2 }]);
    s = walk(vm0, cursorTo(vm0, s, 'item-4'), ['Right']); // 4: 2 -> 3, unsent
    s = walk(vm0, cursorTo(vm0, s, 'item-6'), ['Right']); // 6: a new draft-only line
    expect(s.draft.items, 'fixture: the dirty draft').toEqual([
      { itemId: 4, qty: 3 },
      { itemId: 6, qty: 1 },
    ]);

    const vm1 = vmOf(stored, { inventory: [] }); // both stacks are gone
    const after = observe(vm1, s);
    expect(after, 'a new state').not.toBe(s);
    expect(
      after.draft.items,
      'the draft-only line is dropped, the stored one stays as edited',
    ).toEqual([{ itemId: 4, qty: 3 }]);
    expect(after.seed.items, 'the seed is the stored side').toEqual([{ itemId: 4, qty: 2 }]);
    const keys = paintOf(vm1, after).rows.map((r) => r.key);
    expect(keys, 'the stored line keeps its row').toContain('item-4');
    expect(keys, 'the vanished item has none').not.toContain('item-6');
    expect(observe(vm1, after), 'then stable').toBe(after);
  });

  it('ts-3.2 paint hands the view the vm, the model`s rows for the DRAFT, the draft, the cursor key, the notice and the prompt', () => {
    // WRONG IMPL KILLED: rows built from the stored side (an edit would not show until the server
    // echoed it); a cursor index instead of a key; the prompt or the notice dropped.
    const vm = vmOf();
    const s = walk(vm, cursorTo(vm, walk(vm, open(vm), ['A']), 'cancel'), ['A']);
    const p = paintOf(vm, s);
    expect(p.vm).toBe(vm);
    expect(p.draft).toEqual(s.draft);
    expect(p.rows).toEqual(vm.kind === 'session' ? editorRows(vm, s.draft) : []);
    expect(p.rows.find((r) => r.key === 'apply')?.enabled, 'the rows follow the draft').toBe(true);
    expect(p.cursor).toBe('cancel');
    expect(p.notice).toBe(0);
    expect(p.prompt).toEqual({ action: 'cancel', yes: false });
  });
});

describe('tradeSessionScreen — viewModel(ctx) over the store (ts-4.4)', () => {
  it('ts-4.4 the session editor`s view model reads no legacy offer: it builds over a store that throws on ownTradeOffer / allTradeOffers, and a free party monster in no session and no battle is not blocked as inAnotherTrade', () => {
    // WRONG IMPL KILLED: a viewModel that still reads a legacy offer from the store (the Proxy
    // throws on either name, so the build itself fails); one that still marks a monster
    // `inAnotherTrade` from a legacy offer source (monster 11 is in no session and no battle, so
    // any block on it is fabricated). The fainted and in-battle controls keep the case
    // non-vacuous: the store reads that remain (the roster, the ongoing battle) still mark.
    const LEGACY = new Set(['ownTradeOffer', 'allTradeOffers']);
    const read: string[] = [];
    const base: Record<string, unknown> = {
      allTradeSessions: () => [sess()],
      ongoingBattle: () => ({ partyMonsterIds: [13n], opponentMonsterIds: [] }),
      allPlayers: () => [{ identity: BOB, entityId: 2n, name: 'Bob', online: true }],
      ownMonsters: () => [mon(13n, 2, 'Cyd'), mon(11n, 0, 'Ash'), mon(12n, 1, 'Bry', 0)],
      speciesMap: () => new Map([[1, { name: 'Sprout' }]]),
      itemDefs: () => new Map(),
      ownInventory: () => [],
      ownWallet: () => ({ ownerIdentity: ME, balance: BALANCE }),
    };
    const store = new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') {
          read.push(prop);
          if (LEGACY.has(prop)) throw new Error(`the editor read the legacy offer: ${prop}`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const ctx = { store, identity: ME, tradeSessionId: SID } as unknown as ScreenContext;

    const vm = tradeSessionScreen.viewModel(ctx);
    expect(
      read.filter((name) => LEGACY.has(name)),
      'no legacy-offer read',
    ).toEqual([]);
    expect(read, 'ANTI-VACUITY: the build read the session rows').toContain('allTradeSessions');
    if (vm.kind !== 'session') throw new Error(`a session vm, got ${vm.kind}`);
    expect(vm.sessionId).toBe(SID);
    expect(vm.partnerName).toBe('Bob');
    expect(vm.balance).toBe(BALANCE);
    expect(
      vm.monsters.map((m) => [m.monsterId, m.blocked]),
      'by slot: 11 free, 12 fainted, 13 in the ongoing battle',
    ).toEqual([
      [11n, null],
      [12n, 'fainted'],
      [13n, 'inBattle'],
    ]);
    expect(
      vm.monsters.some((m) => m.blocked === 'inAnotherTrade'),
      'no monster is in another trade',
    ).toBe(false);
  });
});
