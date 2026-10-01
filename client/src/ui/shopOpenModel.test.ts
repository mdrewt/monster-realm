/**
 * shopOpenModel.test.ts: the pure deferred-shop-open core (ctl-3, CTL3.5 and CTL3.6).
 *
 * The greet-then-shop flow ends a conversation (`dismissDialogue`) and only THEN opens the shop,
 * on the batch that carries the conversation row's disappearance. Two intents race on that one
 * round trip: Escape (cancel the pending open) and a shop click (open this shop). The model is the
 * one place that decides, from `{ dismissPending, pendingShopId }` and one event:
 *   - dismissRequested (Escape in dialogue): cancels any pending open; sends a dismiss unless one
 *     is already in flight;
 *   - shopPicked (a [data-shop-id] click): records the shop (last intent wins); sends a dismiss
 *     unless one is in flight;
 *   - dismissRejected(path): the reducer rejected: the flight is over; the shop path also drops
 *     its own pending open, the escape path leaves the pending open alone;
 *   - dismissNotSent(path): no reducer promise came back (frozen link, no live handle): the
 *     flight never started, the pending open is kept;
 *   - batch(conversationPresent): the conversation is gone: the flight is over and a pending open
 *     is consumed exactly once; a batch that still carries the conversation changes nothing;
 *   - reconnect: both cleared (a store reset invalidates the ids).
 *
 * Pure, node env, no clock. Every row asserts the exact next state and the exact effect.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type DismissPath,
  SHOP_OPEN_INITIAL,
  type ShopOpenEvent,
  type ShopOpenState,
  shopOpenStep,
} from './shopOpenModel';

const st = (dismissPending: boolean, pendingShopId: number | null): ShopOpenState => ({
  dismissPending,
  pendingShopId,
});
const A = st(false, null); // idle
const B = st(true, null); // a dismiss is in flight, no shop pending
const C = st(false, 7); // a shop is pending, nothing in flight
const D = st(true, 7); // a dismiss is in flight and a shop is pending

const sendDismiss = (path: DismissPath) => ({ kind: 'sendDismiss', path }) as const;
const openShop = (shopId: number) => ({ kind: 'openShop', shopId }) as const;

/** Fold events through the step, collecting every effect in order. */
function run(
  from: ShopOpenState,
  events: readonly ShopOpenEvent[],
): { readonly state: ShopOpenState; readonly effects: readonly unknown[] } {
  let state = from;
  const effects: unknown[] = [];
  for (const event of events) {
    const step = shopOpenStep(state, event);
    state = step.state;
    if (step.effect !== undefined) effects.push(step.effect);
  }
  return { state, effects };
}

describe('shopOpenModel: the pure deferred-shop-open core (ctl-3)', () => {
  it('CTL3-5-STEP-TABLE: every event over every representative state yields the exact next state and at most one exact effect', () => {
    // WRONG IMPL KILLED: a dismissRequested that keeps the pending shop (Escape would still open
    // the shop), a shopPicked that does not record its id or that ignores the one in flight, a
    // send while a dismiss is in flight, a rejection that clears the wrong half of the state per
    // path, a notSent that drops the pending open, a batch that still carries the conversation
    // consuming the open, a batch that leaves dismissPending set, shop id 0 treated as "none"
    // (a truthiness test), a reconnect that clears only one field, and a step that mutates its input.
    interface Row {
      readonly name: string;
      readonly from: ShopOpenState;
      readonly event: ShopOpenEvent;
      readonly to: ShopOpenState;
      readonly effect: unknown;
    }
    const rows: readonly Row[] = [
      // dismissRequested
      {
        name: 'Escape, idle',
        from: A,
        event: { kind: 'dismissRequested' },
        to: B,
        effect: sendDismiss('escape'),
      },
      {
        name: 'Escape, in flight',
        from: B,
        event: { kind: 'dismissRequested' },
        to: B,
        effect: undefined,
      },
      {
        name: 'Escape, shop pending: cancels it and sends',
        from: C,
        event: { kind: 'dismissRequested' },
        to: B,
        effect: sendDismiss('escape'),
      },
      {
        name: 'Escape, in flight + shop pending: cancels it, sends nothing',
        from: D,
        event: { kind: 'dismissRequested' },
        to: B,
        effect: undefined,
      },
      // shopPicked
      {
        name: 'shop click, idle',
        from: A,
        event: { kind: 'shopPicked', shopId: 9 },
        to: st(true, 9),
        effect: sendDismiss('shop'),
      },
      {
        name: 'shop click, in flight: records, sends nothing',
        from: B,
        event: { kind: 'shopPicked', shopId: 9 },
        to: st(true, 9),
        effect: undefined,
      },
      {
        name: 'shop click, another shop pending: last intent wins',
        from: C,
        event: { kind: 'shopPicked', shopId: 9 },
        to: st(true, 9),
        effect: sendDismiss('shop'),
      },
      {
        name: 'shop click, in flight + shop pending: last intent wins, no send',
        from: D,
        event: { kind: 'shopPicked', shopId: 9 },
        to: st(true, 9),
        effect: undefined,
      },
      {
        name: 'shop id 0 is a real shop',
        from: A,
        event: { kind: 'shopPicked', shopId: 0 },
        to: st(true, 0),
        effect: sendDismiss('shop'),
      },
      // dismissRejected, escape path: the pending open is left alone
      {
        name: 'escape rejected, idle',
        from: A,
        event: { kind: 'dismissRejected', path: 'escape' },
        to: A,
        effect: undefined,
      },
      {
        name: 'escape rejected, in flight',
        from: B,
        event: { kind: 'dismissRejected', path: 'escape' },
        to: A,
        effect: undefined,
      },
      {
        name: 'escape rejected, shop pending survives',
        from: C,
        event: { kind: 'dismissRejected', path: 'escape' },
        to: C,
        effect: undefined,
      },
      {
        name: 'escape rejected, in flight + shop pending: the flight ends, the shop survives',
        from: D,
        event: { kind: 'dismissRejected', path: 'escape' },
        to: C,
        effect: undefined,
      },
      // dismissRejected, shop path: the pending open is dropped
      {
        name: 'shop rejected, idle',
        from: A,
        event: { kind: 'dismissRejected', path: 'shop' },
        to: A,
        effect: undefined,
      },
      {
        name: 'shop rejected, in flight',
        from: B,
        event: { kind: 'dismissRejected', path: 'shop' },
        to: A,
        effect: undefined,
      },
      {
        name: 'shop rejected, shop pending is dropped',
        from: C,
        event: { kind: 'dismissRejected', path: 'shop' },
        to: A,
        effect: undefined,
      },
      {
        name: 'shop rejected, in flight + shop pending: both end',
        from: D,
        event: { kind: 'dismissRejected', path: 'shop' },
        to: A,
        effect: undefined,
      },
      // dismissNotSent: the flight never started, the pending open is kept (either path)
      {
        name: 'escape not sent, idle',
        from: A,
        event: { kind: 'dismissNotSent', path: 'escape' },
        to: A,
        effect: undefined,
      },
      {
        name: 'escape not sent, in flight',
        from: B,
        event: { kind: 'dismissNotSent', path: 'escape' },
        to: A,
        effect: undefined,
      },
      {
        name: 'escape not sent, shop pending kept',
        from: C,
        event: { kind: 'dismissNotSent', path: 'escape' },
        to: C,
        effect: undefined,
      },
      {
        name: 'escape not sent, in flight + shop pending: flight ends, shop kept',
        from: D,
        event: { kind: 'dismissNotSent', path: 'escape' },
        to: C,
        effect: undefined,
      },
      {
        name: 'shop not sent, idle',
        from: A,
        event: { kind: 'dismissNotSent', path: 'shop' },
        to: A,
        effect: undefined,
      },
      {
        name: 'shop not sent, in flight',
        from: B,
        event: { kind: 'dismissNotSent', path: 'shop' },
        to: A,
        effect: undefined,
      },
      {
        name: 'shop not sent, shop pending kept',
        from: C,
        event: { kind: 'dismissNotSent', path: 'shop' },
        to: C,
        effect: undefined,
      },
      {
        name: 'shop not sent, in flight + shop pending: flight ends, shop kept',
        from: D,
        event: { kind: 'dismissNotSent', path: 'shop' },
        to: C,
        effect: undefined,
      },
      // batch, conversation gone: the flight ends and a pending open is consumed
      {
        name: 'batch, no conversation, idle',
        from: A,
        event: { kind: 'batch', conversationPresent: false },
        to: A,
        effect: undefined,
      },
      {
        name: 'batch, no conversation, in flight',
        from: B,
        event: { kind: 'batch', conversationPresent: false },
        to: A,
        effect: undefined,
      },
      {
        name: 'batch, no conversation, shop pending: opens it',
        from: C,
        event: { kind: 'batch', conversationPresent: false },
        to: A,
        effect: openShop(7),
      },
      {
        name: 'batch, no conversation, in flight + shop pending: opens it',
        from: D,
        event: { kind: 'batch', conversationPresent: false },
        to: A,
        effect: openShop(7),
      },
      {
        name: 'batch, no conversation, shop id 0 opens',
        from: st(true, 0),
        event: { kind: 'batch', conversationPresent: false },
        to: A,
        effect: openShop(0),
      },
      // batch, conversation still present: nothing changes
      {
        name: 'batch, conversation present, idle',
        from: A,
        event: { kind: 'batch', conversationPresent: true },
        to: A,
        effect: undefined,
      },
      {
        name: 'batch, conversation present, in flight',
        from: B,
        event: { kind: 'batch', conversationPresent: true },
        to: B,
        effect: undefined,
      },
      {
        name: 'batch, conversation present, shop pending',
        from: C,
        event: { kind: 'batch', conversationPresent: true },
        to: C,
        effect: undefined,
      },
      {
        name: 'batch, conversation present, in flight + shop pending',
        from: D,
        event: { kind: 'batch', conversationPresent: true },
        to: D,
        effect: undefined,
      },
      // reconnect: both cleared
      { name: 'reconnect, idle', from: A, event: { kind: 'reconnect' }, to: A, effect: undefined },
      {
        name: 'reconnect, in flight',
        from: B,
        event: { kind: 'reconnect' },
        to: A,
        effect: undefined,
      },
      {
        name: 'reconnect, shop pending',
        from: C,
        event: { kind: 'reconnect' },
        to: A,
        effect: undefined,
      },
      {
        name: 'reconnect, in flight + shop pending',
        from: D,
        event: { kind: 'reconnect' },
        to: A,
        effect: undefined,
      },
    ];
    expect(rows.length, 'ANTI-VACUITY: every event kind is covered').toBeGreaterThanOrEqual(38);

    for (const row of rows) {
      const frozen = Object.freeze({ ...row.from });
      const before = JSON.stringify(frozen);
      const result = shopOpenStep(frozen, row.event);
      expect(result.state, `${row.name}: state`).toEqual(row.to);
      expect(result.effect, `${row.name}: effect`).toEqual(row.effect);
      expect(JSON.stringify(frozen), `${row.name}: the input state is untouched`).toBe(before);
    }
    expect(SHOP_OPEN_INITIAL, 'the initial state is idle').toEqual(A);
  });

  it('CTL3-5-NO-DOUBLE-SEND: a dismiss is never sent while one is in flight, and every send marks the flight', () => {
    // WRONG IMPL KILLED: a second dismissDialogue call from an Escape press (or a shop click, or
    // one of each) while the first is unsettled; a send that does not set the in-flight flag (the
    // next press would send again); an openShop that leaves the flight or the pending open set
    // (a second batch would open it twice).
    // Table rows first: the three double-press shapes send exactly once.
    expect(run(A, [{ kind: 'dismissRequested' }, { kind: 'dismissRequested' }])).toEqual({
      state: B,
      effects: [sendDismiss('escape')],
    });
    expect(
      run(A, [
        { kind: 'shopPicked', shopId: 3 },
        { kind: 'shopPicked', shopId: 3 },
      ]),
    ).toEqual({
      state: st(true, 3),
      effects: [sendDismiss('shop')],
    });
    expect(run(A, [{ kind: 'dismissRequested' }, { kind: 'shopPicked', shopId: 3 }])).toEqual({
      state: st(true, 3),
      effects: [sendDismiss('escape')],
    });
    expect(run(A, [{ kind: 'shopPicked', shopId: 3 }, { kind: 'dismissRequested' }])).toEqual({
      state: B,
      effects: [sendDismiss('shop')],
    });

    const eventArb: fc.Arbitrary<ShopOpenEvent> = fc.oneof(
      fc.constant<ShopOpenEvent>({ kind: 'dismissRequested' }),
      fc.constantFrom(0, 3, 7).map((shopId): ShopOpenEvent => ({ kind: 'shopPicked', shopId })),
      fc
        .constantFrom<DismissPath>('escape', 'shop')
        .map((path): ShopOpenEvent => ({ kind: 'dismissRejected', path })),
      fc
        .constantFrom<DismissPath>('escape', 'shop')
        .map((path): ShopOpenEvent => ({ kind: 'dismissNotSent', path })),
      fc
        .boolean()
        .map((conversationPresent): ShopOpenEvent => ({ kind: 'batch', conversationPresent })),
      fc.constant<ShopOpenEvent>({ kind: 'reconnect' }),
    );
    let sends = 0;
    let blocked = 0;
    let opens = 0;
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), (events) => {
        let state: ShopOpenState = SHOP_OPEN_INITIAL;
        for (const event of events) {
          const before = state;
          const step = shopOpenStep(before, event);
          if (step.effect?.kind === 'sendDismiss') {
            expect(before.dismissPending, 'a send only when nothing is in flight').toBe(false);
            expect(step.state.dismissPending, 'a send marks the flight').toBe(true);
            sends += 1;
          }
          if (
            before.dismissPending &&
            (event.kind === 'dismissRequested' || event.kind === 'shopPicked')
          ) {
            expect(
              step.effect,
              'a press while a dismiss is in flight sends nothing',
            ).toBeUndefined();
            blocked += 1;
          }
          if (step.effect?.kind === 'openShop') {
            expect(event.kind, 'a shop opens only on a batch').toBe('batch');
            expect(step.effect.shopId, 'it opens the pending shop').toBe(before.pendingShopId);
            expect(step.state, 'consumed: the flight and the pending open are both over').toEqual(
              A,
            );
            opens += 1;
          }
          state = step.state;
        }
      }),
      { numRuns: 300 },
    );
    expect(sends, 'ANTI-VACUITY: many sends were generated').toBeGreaterThan(100);
    expect(
      blocked,
      'ANTI-VACUITY: many presses landed while a dismiss was in flight',
    ).toBeGreaterThan(50);
    expect(opens, 'ANTI-VACUITY: some pending shops were consumed').toBeGreaterThan(10);
  });

  it('CTL3-5-PER-PATH-ROLLBACK: a rejected Escape dismiss leaves a later shop click pending, a rejected shop dismiss drops it', () => {
    // WRONG IMPL KILLED: a rejection that nulls the pending shop on EVERY path (the Escape send
    // rejects after the player clicked a shop: the click's intent, which has no send of its own,
    // would be silently lost and the shop never opens), and one that never nulls it on the shop
    // path (a rejected shop send would leave a stale open to fire on the next conversation end).
    const escapeThenShop = run(A, [
      { kind: 'dismissRequested' },
      { kind: 'shopPicked', shopId: 7 },
    ]);
    expect(escapeThenShop, 'the click rides the Escape send: no second send').toEqual({
      state: st(true, 7),
      effects: [sendDismiss('escape')],
    });
    const afterEscapeRejected = shopOpenStep(escapeThenShop.state, {
      kind: 'dismissRejected',
      path: 'escape',
    });
    expect(afterEscapeRejected.state, 'the Escape rejection keeps the click pending').toEqual(C);
    expect(afterEscapeRejected.effect).toBeUndefined();
    // And the open still happens once the conversation really ends.
    expect(
      shopOpenStep(afterEscapeRejected.state, { kind: 'batch', conversationPresent: false }),
    ).toEqual({ state: A, effect: openShop(7) });

    const shopSend = run(A, [{ kind: 'shopPicked', shopId: 7 }]);
    expect(shopSend).toEqual({ state: st(true, 7), effects: [sendDismiss('shop')] });
    const afterShopRejected = shopOpenStep(shopSend.state, {
      kind: 'dismissRejected',
      path: 'shop',
    });
    expect(afterShopRejected.state, 'the shop rejection drops its own pending open').toEqual(A);
    expect(
      shopOpenStep(afterShopRejected.state, { kind: 'batch', conversationPresent: false }),
      'so no open fires when the conversation later ends',
    ).toEqual({ state: A });
  });

  it('CTL3-5-CONSUME-AND-DROP: the pending open is consumed exactly once on the batch that ends the conversation, and an Escape after the click cancels it', () => {
    // WRONG IMPL KILLED: an openShop that is not consumed (every later batch with no conversation
    // would reopen the shop the player just closed), a consume that fires while the conversation
    // is still present, and an Escape that does not cancel the pending open (last intent wins).
    expect(run(C, [{ kind: 'batch', conversationPresent: true }])).toEqual({
      state: C,
      effects: [],
    });
    const consumed = run(C, [
      { kind: 'batch', conversationPresent: true },
      { kind: 'batch', conversationPresent: false },
      { kind: 'batch', conversationPresent: false },
      { kind: 'batch', conversationPresent: true },
      { kind: 'batch', conversationPresent: false },
    ]);
    expect(consumed.effects, 'exactly one openShop, from the first no-conversation batch').toEqual([
      openShop(7),
    ]);
    expect(consumed.state).toEqual(A);

    const cancelled = run(A, [
      { kind: 'shopPicked', shopId: 7 },
      { kind: 'dismissRequested' },
      { kind: 'batch', conversationPresent: false },
    ]);
    expect(
      cancelled.effects,
      "click then Escape: one send (the click's), and no shop open",
    ).toEqual([sendDismiss('shop')]);
    expect(cancelled.state).toEqual(A);

    const reclicked = run(A, [
      { kind: 'dismissRequested' },
      { kind: 'shopPicked', shopId: 7 },
      { kind: 'batch', conversationPresent: false },
    ]);
    expect(reclicked.effects, 'Escape then click: the click wins and opens').toEqual([
      sendDismiss('escape'),
      openShop(7),
    ]);
  });

  it('CTL3-5-RECONNECT: a reconnect clears the flight and the pending open, so nothing opens and the next dismiss sends again', () => {
    // WRONG IMPL KILLED: a reconnect that clears only dismissPending (a stale shop would open in
    // the new session against ids the store reset invalidated), one that clears only the shop (the
    // dismiss button stays dead forever: the flight's reducer promise never settles after a drop),
    // and one that emits an effect.
    const reset = shopOpenStep(D, { kind: 'reconnect' });
    expect(reset).toEqual({ state: A });
    expect(reset.effect).toBeUndefined();

    const afterwards = run(D, [
      { kind: 'reconnect' },
      { kind: 'batch', conversationPresent: false },
      { kind: 'dismissRequested' },
    ]);
    expect(afterwards.effects, 'no stale open, and Escape sends again').toEqual([
      sendDismiss('escape'),
    ]);
    expect(afterwards.state).toEqual(B);
  });

  it('CTL3-6-NOT-SENT: a dismiss that never reached a reducer leaves nothing in flight, keeps a pending open, and the next press sends again', () => {
    // WRONG IMPL KILLED: a notSent that leaves dismissPending set (Escape becomes a dead button
    // after one press on a dead handle: the defect), one that nulls the pending open (the click's
    // intent is lost although the conversation is still there to retry), and a model that cannot
    // send a second time.
    const first = run(A, [{ kind: 'dismissRequested' }]);
    expect(first).toEqual({ state: B, effects: [sendDismiss('escape')] });
    const notSent = shopOpenStep(first.state, { kind: 'dismissNotSent', path: 'escape' });
    expect(notSent.state.dismissPending, 'nothing is in flight').toBe(false);
    expect(notSent.state).toEqual(A);
    expect(notSent.effect).toBeUndefined();
    const again = shopOpenStep(notSent.state, { kind: 'dismissRequested' });
    expect(again.effect, 'a following Escape sends again').toEqual(sendDismiss('escape'));

    const shopFirst = run(A, [{ kind: 'shopPicked', shopId: 7 }]);
    expect(shopFirst).toEqual({ state: st(true, 7), effects: [sendDismiss('shop')] });
    const shopNotSent = shopOpenStep(shopFirst.state, { kind: 'dismissNotSent', path: 'shop' });
    expect(shopNotSent.state, 'not in flight, the picked shop is kept').toEqual(C);
    expect(shopNotSent.effect).toBeUndefined();
    const reclick = shopOpenStep(shopNotSent.state, { kind: 'shopPicked', shopId: 7 });
    expect(reclick, 'clicking the shop again sends again').toEqual({
      state: st(true, 7),
      effect: sendDismiss('shop'),
    });
  });
});
