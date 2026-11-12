// net/worldScope.test.ts — the scoped `character` subscription as pure state.
//
// What is pinned here: the exact query text (the host shares a query by its text), the literal
// validation, the wanted-zone set, each rule of the sync step, and four invariants over random
// sequences of wants, applied / rejected events and time.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  APPLY_TIMEOUT_MS,
  describeScope,
  INITIAL_SCOPE,
  LINGER_MS,
  OPTIONAL_RETRY_MS,
  onScopeEvent,
  ownCharacterQuery,
  ownKey,
  PREFETCH_TILES,
  RETRY_BACKOFF_MS,
  type ScopeEffect,
  type ScopeInput,
  type ScopeState,
  syncScope,
  wantedZones,
  zoneKey,
  zoneQuery,
} from './worldScope';

const E = 7n;
const OWN = ownKey(E);
const Z0 = zoneKey(0);
const Z1 = zoneKey(1);
const Z2 = zoneKey(2);

const input = (now: number, ownZone: number | undefined, extra: number[] = []): ScopeInput => ({
  wantEntity: E,
  ownZone,
  wantZones: new Set(extra),
  now,
});

/** Run a script of syncs and events, returning the final state and every effect in order. */
type Step =
  | { readonly sync: ScopeInput }
  | { readonly applied: string; readonly now: number }
  | { readonly rejected: string; readonly now: number };
function run(steps: readonly Step[], from: ScopeState = INITIAL_SCOPE) {
  let state = from;
  const effects: ScopeEffect[] = [];
  for (const step of steps) {
    if ('sync' in step) {
      const out = syncScope(state, step.sync);
      state = out.state;
      effects.push(...out.effects);
    } else if ('applied' in step) {
      state = onScopeEvent(state, { kind: 'applied', key: step.applied, now: step.now });
    } else {
      state = onScopeEvent(state, { kind: 'rejected', key: step.rejected, now: step.now });
    }
  }
  return { state, effects };
}

/** Own row and zone 0 both applied at t = 0. */
function settledInZone0(): ScopeState {
  return run([
    { sync: input(0, 0) },
    { applied: OWN, now: 0 },
    { applied: Z0, now: 0 },
    { sync: input(0, 0) },
  ]).state;
}

describe('worldScope queries: one canonical text per set', () => {
  it('pins the own-row query text exactly', () => {
    expect(ownCharacterQuery(42n)).toBe('SELECT * FROM character WHERE entity_id = 42');
    expect(ownCharacterQuery(0n)).toBe('SELECT * FROM character WHERE entity_id = 0');
  });

  it('pins the zone query text exactly', () => {
    expect(zoneQuery(0)).toBe('SELECT * FROM character WHERE zone_id = 0');
    expect(zoneQuery(17)).toBe('SELECT * FROM character WHERE zone_id = 17');
  });

  it('writes a u64 above 2^53 and the u64 maximum as exact decimals', () => {
    expect(ownCharacterQuery(9007199254740993n)).toBe(
      'SELECT * FROM character WHERE entity_id = 9007199254740993',
    );
    expect(ownCharacterQuery(18446744073709551615n)).toBe(
      'SELECT * FROM character WHERE entity_id = 18446744073709551615',
    );
  });

  it('writes the u32 maximum as a plain decimal, never an exponent', () => {
    expect(zoneQuery(4294967295)).toBe('SELECT * FROM character WHERE zone_id = 4294967295');
  });

  it('every valid literal gives single spaces, decimal digits and no semicolon', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), fc.nat(0xffff_ffff), (e, z) => {
        expect(ownCharacterQuery(e)).toMatch(/^SELECT \* FROM character WHERE entity_id = \d+$/);
        expect(zoneQuery(z)).toMatch(/^SELECT \* FROM character WHERE zone_id = \d+$/);
      }),
    );
  });

  it('rejects an entity id outside u64', () => {
    expect(() => ownCharacterQuery(-1n)).toThrow(RangeError);
    expect(() => ownCharacterQuery(18446744073709551616n)).toThrow(RangeError);
  });

  it('rejects an entity id that is not a bigint', () => {
    for (const bad of [1, 1.5, Number.NaN, '1', undefined, null]) {
      expect(() => ownCharacterQuery(bad as unknown as bigint)).toThrow(RangeError);
    }
  });

  it('rejects a zone id that is negative, fractional, NaN, infinite or outside u32', () => {
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 4294967296, 1e21]) {
      expect(() => zoneQuery(bad)).toThrow(RangeError);
    }
  });

  it('rejects a zone id that is not a number', () => {
    for (const bad of ['1', '0 OR 1 = 1', 1n, undefined, null]) {
      expect(() => zoneQuery(bad as unknown as number)).toThrow(RangeError);
    }
  });
});

describe('wantedZones', () => {
  const warp = (x: number, y: number, to_zone: number) => ({ from: { x, y }, to_zone });
  const at = (tileX: number, tileY: number, zoneId = 0) => ({ zoneId, tileX, tileY });

  it('is empty without an own row, whatever the warps', () => {
    expect([...wantedZones(undefined, [warp(0, 0, 1)], PREFETCH_TILES)]).toEqual([]);
  });

  it('is the own zone alone when no warp is near', () => {
    expect([...wantedZones(at(10, 10, 3), [warp(1, 5, 1)], PREFETCH_TILES)]).toEqual([3]);
    expect([...wantedZones(at(10, 10, 3), [], PREFETCH_TILES)]).toEqual([3]);
  });

  it('adds a warp destination at distance exactly k and not at k + 1', () => {
    expect([...wantedZones(at(5, 5), [warp(1, 5, 1)], 4)]).toEqual([0, 1]);
    expect([...wantedZones(at(6, 5), [warp(1, 5, 1)], 4)]).toEqual([0]);
  });

  it('measures Manhattan distance, not Chebyshev', () => {
    // (3,3) from (1,5): |2| + |2| = 4 is in; (4,3) is |3| + |2| = 5, out, though Chebyshev 3.
    expect([...wantedZones(at(3, 3), [warp(1, 5, 1)], 4)]).toEqual([0, 1]);
    expect([...wantedZones(at(4, 3), [warp(1, 5, 1)], 4)]).toEqual([0]);
  });

  it('adds the destination of each near warp and of no far one', () => {
    const warps = [warp(1, 5, 1), warp(2, 5, 2), warp(30, 30, 9)];
    expect([...wantedZones(at(1, 4), warps, 4)].sort()).toEqual([0, 1, 2]);
  });

  it('names a destination once when two warps lead to it, and standing on the warp counts', () => {
    expect([...wantedZones(at(1, 5), [warp(1, 5, 1), warp(1, 6, 1)], 4)]).toEqual([0, 1]);
  });

  it('with k = 0 only the warp tile itself is near', () => {
    expect([...wantedZones(at(1, 5), [warp(1, 5, 1)], 0)]).toEqual([0, 1]);
    expect([...wantedZones(at(1, 4), [warp(1, 5, 1)], 0)]).toEqual([0]);
  });
});

describe('syncScope: subscribing', () => {
  it('with no own player row it subscribes nothing', () => {
    const out = syncScope(INITIAL_SCOPE, {
      wantEntity: undefined,
      ownZone: undefined,
      wantZones: new Set(),
      now: 0,
    });
    expect(out.effects).toEqual([]);
    expect(out.state.entries.size).toBe(0);
  });

  it('with the entity known and no own character row it subscribes the own row only', () => {
    const out = syncScope(INITIAL_SCOPE, input(0, undefined));
    expect(out.effects).toEqual([{ kind: 'subscribe', key: OWN, query: ownCharacterQuery(E) }]);
    expect(describeScope(out.state)).toEqual({ own: 'pending', zones: [], settled: false });
  });

  it('the own zone is wanted even when wantZones does not list it', () => {
    const out = syncScope(INITIAL_SCOPE, input(0, 1));
    expect(out.effects).toEqual([
      { kind: 'subscribe', key: OWN, query: ownCharacterQuery(E) },
      { kind: 'subscribe', key: Z1, query: zoneQuery(1) },
    ]);
  });

  it('a second sync with nothing changed has no effects and subscribes nothing twice', () => {
    const first = syncScope(INITIAL_SCOPE, input(0, 0, [1]));
    expect(first.effects.map((e) => e.kind)).toEqual(['subscribe', 'subscribe', 'subscribe']);
    const second = syncScope(first.state, input(100, 0, [1]));
    expect(second.effects).toEqual([]);
  });

  it('an invalid zone id throws out of the sync rather than reaching a query', () => {
    expect(() => syncScope(INITIAL_SCOPE, input(0, -1))).toThrow(RangeError);
    expect(() => syncScope(INITIAL_SCOPE, input(0, 0, [1.5]))).toThrow(RangeError);
  });
});

describe('syncScope: settled', () => {
  it('fires true once the own row and the own zone are both applied, and only once', () => {
    const { state, effects } = run([
      { sync: input(0, 0) },
      { applied: OWN, now: 1 },
      { sync: input(1, 0) },
      { applied: Z0, now: 2 },
      { sync: input(2, 0) },
      { sync: input(3, 0) },
    ]);
    expect(effects.filter((e) => e.kind === 'settled')).toEqual([
      { kind: 'settled', settled: true },
    ]);
    expect(describeScope(state)).toEqual({
      own: 'active',
      zones: [{ zoneId: 0, state: 'active' }],
      settled: true,
    });
  });

  it('is not settled by the own zone alone, nor by the own row alone', () => {
    const zoneOnly = run([{ sync: input(0, 0) }, { applied: Z0, now: 1 }, { sync: input(1, 0) }]);
    expect(zoneOnly.state.settled).toBe(false);
    const ownOnly = run([{ sync: input(0, 0) }, { applied: OWN, now: 1 }, { sync: input(1, 0) }]);
    expect(ownOnly.state.settled).toBe(false);
  });

  it('a warp to a zone with no applied set fires false, then true when it applies', () => {
    const { effects } = run(
      [{ sync: input(10, 1) }, { applied: Z1, now: 11 }, { sync: input(11, 1) }],
      settledInZone0(),
    );
    expect(effects).toEqual([
      { kind: 'subscribe', key: Z1, query: zoneQuery(1) },
      { kind: 'settled', settled: false },
      { kind: 'settled', settled: true },
    ]);
  });

  it('a warp to a zone whose set is already applied stays settled', () => {
    const held = run(
      [{ sync: input(1, 0, [1]) }, { applied: Z1, now: 2 }, { sync: input(2, 0, [1]) }],
      settledInZone0(),
    ).state;
    const warped = syncScope(held, input(3, 1, [0]));
    expect(warped.effects).toEqual([]);
    expect(warped.state.settled).toBe(true);
  });

  it('losing the own character row fires false', () => {
    const out = syncScope(settledInZone0(), input(5, undefined));
    expect(out.effects).toEqual([{ kind: 'settled', settled: false }]);
  });
});

describe('syncScope: linger and unsubscribe', () => {
  it('an unwanted applied zone is unsubscribed at LINGER_MS, not before, and only once', () => {
    const warped = run(
      [{ sync: input(100, 1) }, { applied: Z1, now: 101 }, { sync: input(101, 1) }],
      settledInZone0(),
    ).state;
    const early = syncScope(warped, input(100 + LINGER_MS - 1, 1));
    expect(early.effects).toEqual([]);
    const due = syncScope(early.state, input(100 + LINGER_MS, 1));
    expect(due.effects).toEqual([{ kind: 'unsubscribe', key: Z0 }]);
    expect(describeScope(due.state).zones).toEqual([{ zoneId: 1, state: 'active' }]);
    const after = syncScope(due.state, input(100 + LINGER_MS * 3, 1));
    expect(after.effects).toEqual([]);
  });

  it('the old zone is kept past LINGER_MS while the own zone is still pending', () => {
    const warped = syncScope(settledInZone0(), input(100, 1)).state;
    // Past the linger the own zone has also been pending past the timeout, and that step is a
    // drop with no unsubscribe; one tick before the timeout nothing happens at all.
    const late = syncScope(warped, input(100 + LINGER_MS + 1, 1));
    expect(late.effects.some((e) => e.kind === 'unsubscribe')).toBe(false);
    const justBefore = syncScope(warped, input(100 + APPLY_TIMEOUT_MS - 1, 1));
    expect(justBefore.effects).toEqual([]);
  });

  it('with the own zone applied late, the old zone goes on the next sync after its linger', () => {
    const warped = syncScope(settledInZone0(), input(100, 1)).state;
    const waiting = syncScope(warped, input(100 + APPLY_TIMEOUT_MS - 1, 1)).state;
    const { effects } = run(
      [{ applied: Z1, now: 100 + APPLY_TIMEOUT_MS - 1 }, { sync: input(100 + LINGER_MS, 1) }],
      waiting,
    );
    expect(effects).toEqual([
      { kind: 'unsubscribe', key: Z0 },
      { kind: 'settled', settled: true },
    ]);
  });

  it('a zone wanted again before its linger ends is kept, and its linger starts afresh later', () => {
    const base = run(
      [{ sync: input(0, 0, [1]) }, { applied: Z1, now: 0 }, { sync: input(0, 0, [1]) }],
      settledInZone0(),
    ).state;
    const { state, effects } = run(
      [
        { sync: input(1000, 0) }, // zone 1 unwanted from 1000
        { sync: input(4000, 0, [1]) }, // wanted again: the stamp clears
        { sync: input(4500, 0) }, // unwanted from 4500
        { sync: input(1000 + LINGER_MS, 0) }, // the first stamp would have expired here
        { sync: input(4500 + LINGER_MS - 1, 0) },
      ],
      base,
    );
    expect(effects).toEqual([]);
    expect(syncScope(state, input(4500 + LINGER_MS, 0)).effects).toEqual([
      { kind: 'unsubscribe', key: Z1 },
    ]);
  });

  it('a pending unwanted set is never unsubscribed; once applied it goes after its linger', () => {
    const pending = run([{ sync: input(0, 0, [1]) }, { sync: input(10, 0) }], settledInZone0());
    expect(pending.effects).toEqual([{ kind: 'subscribe', key: Z1, query: zoneQuery(1) }]);
    const muchLater = syncScope(pending.state, input(10 + LINGER_MS * 4, 0));
    expect(muchLater.effects).toEqual([]);
    const applied = run(
      [{ applied: Z1, now: 10 + LINGER_MS * 4 }, { sync: input(10 + LINGER_MS * 4, 0) }],
      muchLater.state,
    );
    expect(applied.effects).toEqual([{ kind: 'unsubscribe', key: Z1 }]);
  });

  it('with no own zone, held zones linger and are then dropped', () => {
    const gone = syncScope(settledInZone0(), input(50, undefined));
    expect(gone.effects).toEqual([{ kind: 'settled', settled: false }]);
    expect(syncScope(gone.state, input(50 + LINGER_MS - 1, undefined)).effects).toEqual([]);
    expect(syncScope(gone.state, input(50 + LINGER_MS, undefined)).effects).toEqual([
      { kind: 'unsubscribe', key: Z0 },
    ]);
  });

  it('subscribes are listed before unsubscribes in one step', () => {
    const base = run(
      [{ sync: input(0, 0, [1]) }, { applied: Z1, now: 0 }, { sync: input(0, 0) }],
      settledInZone0(),
    ).state;
    const out = syncScope(base, input(LINGER_MS, 0, [2]));
    expect(out.effects).toEqual([
      { kind: 'subscribe', key: Z2, query: zoneQuery(2) },
      { kind: 'unsubscribe', key: Z1 },
    ]);
  });

  it('A to B to C: each zone left is dropped once, in turn, and C is never dropped', () => {
    const { effects, state } = run(
      [
        { sync: input(100, 1) },
        { applied: Z1, now: 110 },
        { sync: input(200, 2) }, // on to C before A's linger ends
        { applied: Z2, now: 210 },
        { sync: input(210, 2) },
        { sync: input(100 + LINGER_MS, 2) },
        { sync: input(200 + LINGER_MS, 2) },
        { sync: input(200 + LINGER_MS * 2, 2) },
      ],
      settledInZone0(),
    );
    expect(effects.filter((e) => e.kind === 'unsubscribe')).toEqual([
      { kind: 'unsubscribe', key: Z0 },
      { kind: 'unsubscribe', key: Z1 },
    ]);
    expect(describeScope(state)).toEqual({
      own: 'active',
      zones: [{ zoneId: 2, state: 'active' }],
      settled: true,
    });
  });
});

describe('scope events', () => {
  it('an event for a key with no set changes nothing', () => {
    const state = settledInZone0();
    expect(onScopeEvent(state, { kind: 'applied', key: Z2, now: 1 })).toBe(state);
    expect(onScopeEvent(state, { kind: 'rejected', key: Z2, now: 1 })).toBe(state);
  });

  it('a rejection removes the set and counts it', () => {
    const subscribed = syncScope(INITIAL_SCOPE, input(0, 0)).state;
    const out = onScopeEvent(subscribed, { kind: 'rejected', key: Z0, now: 5 });
    expect(out.entries.has(Z0)).toBe(false);
    expect(out.retry.get(Z0)).toEqual({ attempts: 1, rejectedAt: 5 });
  });
});

describe('syncScope: a rejected set the client needs', () => {
  /** Reject `key` `times` times in a row, each retry issued the instant its backoff ends. */
  function rejectInARow(key: string, times: number) {
    let state = syncScope(INITIAL_SCOPE, input(0, 0)).state;
    let now = 0;
    const effects: ScopeEffect[] = [];
    for (let i = 0; i < times; i += 1) {
      state = onScopeEvent(state, { kind: 'rejected', key, now });
      now += RETRY_BACKOFF_MS[i] ?? 0;
      const out = syncScope(state, input(now, 0));
      state = out.state;
      effects.push(...out.effects);
    }
    return { state, effects, now };
  }

  it('is not retried before its backoff and is retried at it', () => {
    const subscribed = syncScope(INITIAL_SCOPE, input(0, 0)).state;
    const rejected = onScopeEvent(subscribed, { kind: 'rejected', key: Z0, now: 10 });
    expect(syncScope(rejected, input(10 + RETRY_BACKOFF_MS[0] - 1, 0)).effects).toEqual([]);
    expect(syncScope(rejected, input(10 + RETRY_BACKOFF_MS[0], 0)).effects).toEqual([
      { kind: 'subscribe', key: Z0, query: zoneQuery(0) },
    ]);
  });

  it('uses each backoff in turn', () => {
    let state = syncScope(INITIAL_SCOPE, input(0, 0)).state;
    let now = 0;
    for (const wait of RETRY_BACKOFF_MS) {
      state = onScopeEvent(state, { kind: 'rejected', key: OWN, now });
      expect(syncScope(state, input(now + wait - 1, 0)).effects).toEqual([]);
      now += wait;
      const retried = syncScope(state, input(now, 0));
      expect(retried.effects).toEqual([
        { kind: 'subscribe', key: OWN, query: ownCharacterQuery(E) },
      ]);
      state = retried.state;
    }
  });

  it.each([
    ['the own zone', Z0],
    ['the own row', OWN],
  ])('%s rejected once more than there are retries drops the connection', (_label, key) => {
    const retries = RETRY_BACKOFF_MS.length;
    const before = rejectInARow(key, retries);
    expect(before.effects.filter((e) => e.kind === 'drop')).toEqual([]);
    expect(before.effects.filter((e) => e.kind === 'subscribe')).toHaveLength(retries);
    const last = onScopeEvent(before.state, { kind: 'rejected', key, now: before.now });
    const out = syncScope(last, input(before.now, 0));
    expect(out.effects).toEqual([{ kind: 'drop', reason: 'rejected', key }]);
    expect(out.state).toBe(INITIAL_SCOPE);
  });

  it('an applied set clears the count, so later rejections start the ladder again', () => {
    const before = rejectInARow(Z0, RETRY_BACKOFF_MS.length);
    const { state } = run(
      [
        { applied: Z0, now: before.now },
        { sync: input(before.now, 0) },
        { rejected: Z0, now: before.now + 1 },
      ],
      before.state,
    );
    expect(state.retry.get(Z0)).toEqual({ attempts: 1, rejectedAt: before.now + 1 });
    const out = syncScope(state, input(before.now + 1 + RETRY_BACKOFF_MS[0], 0));
    expect(out.effects.map((e) => e.kind)).toEqual(['subscribe']);
  });

  it('a drop while settled fires settled false first', () => {
    let state = settledInZone0();
    let now = 0;
    for (let i = 0; i <= RETRY_BACKOFF_MS.length; i += 1) {
      state = onScopeEvent(state, { kind: 'rejected', key: OWN, now });
      now += RETRY_BACKOFF_MS[i] ?? 0;
      const out = syncScope(state, input(now, 0));
      if (i === RETRY_BACKOFF_MS.length) {
        expect(out.effects).toEqual([{ kind: 'drop', reason: 'rejected', key: OWN }]);
      } else if (i === 0) {
        expect(out.effects).toContainEqual({ kind: 'settled', settled: false });
      }
      state = out.state;
    }
  });
});

describe('syncScope: a rejected set the client can do without', () => {
  it('is tried again after OPTIONAL_RETRY_MS while still wanted, and never drops', () => {
    let state = run([{ sync: input(0, 0, [1]) }], settledInZone0()).state;
    let now = 0;
    for (let i = 0; i < RETRY_BACKOFF_MS.length + 3; i += 1) {
      state = onScopeEvent(state, { kind: 'rejected', key: Z1, now });
      expect(syncScope(state, input(now + OPTIONAL_RETRY_MS - 1, 0, [1])).effects).toEqual([]);
      now += OPTIONAL_RETRY_MS;
      const out = syncScope(state, input(now, 0, [1]));
      expect(out.effects).toEqual([{ kind: 'subscribe', key: Z1, query: zoneQuery(1) }]);
      state = out.state;
    }
    expect(state.settled).toBe(true);
  });

  it('is forgotten once it is no longer wanted', () => {
    const rejected = run(
      [{ sync: input(0, 0, [1]) }, { rejected: Z1, now: 1 }, { sync: input(2, 0) }],
      settledInZone0(),
    );
    expect(rejected.state.retry.size).toBe(0);
    expect(rejected.state.entries.has(Z1)).toBe(false);
    expect(syncScope(rejected.state, input(1 + OPTIONAL_RETRY_MS, 0)).effects).toEqual([]);
  });
});

describe('syncScope: a set the client needs that never applies', () => {
  it('the own zone pending for APPLY_TIMEOUT_MS drops; one tick earlier it does not', () => {
    const warped = syncScope(settledInZone0(), input(100, 1)).state;
    expect(syncScope(warped, input(100 + APPLY_TIMEOUT_MS - 1, 1)).effects).toEqual([]);
    const out = syncScope(warped, input(100 + APPLY_TIMEOUT_MS, 1));
    expect(out.effects).toEqual([{ kind: 'drop', reason: 'timeout', key: Z1 }]);
    expect(out.state).toBe(INITIAL_SCOPE);
  });

  it('the own row pending for APPLY_TIMEOUT_MS drops', () => {
    const subscribed = syncScope(INITIAL_SCOPE, input(0, undefined)).state;
    expect(syncScope(subscribed, input(APPLY_TIMEOUT_MS, undefined)).effects).toEqual([
      { kind: 'drop', reason: 'timeout', key: OWN },
    ]);
  });

  it('a pending zone that is not the own zone never drops', () => {
    const held = syncScope(settledInZone0(), input(0, 0, [1])).state;
    expect(syncScope(held, input(APPLY_TIMEOUT_MS * 10, 0, [1])).effects).toEqual([]);
  });
});

describe('describeScope', () => {
  it('lists zones in ascending id order with their phase', () => {
    const state = run([
      { sync: input(0, 2, [10, 1]) },
      { applied: zoneKey(10), now: 0 },
      { applied: OWN, now: 0 },
    ]).state;
    expect(describeScope(state)).toEqual({
      own: 'active',
      zones: [
        { zoneId: 1, state: 'pending' },
        { zoneId: 2, state: 'pending' },
        { zoneId: 10, state: 'active' },
      ],
      settled: false,
    });
  });

  it('is empty for the initial state', () => {
    expect(describeScope(INITIAL_SCOPE)).toEqual({ own: null, zones: [], settled: false });
  });
});

// ---------------------------------------------------------------------------
// Invariants over random sequences. The model plays the connection shell: it tracks each handle
// the effects open and close, and answers pending handles with applied / rejected events.
// ---------------------------------------------------------------------------

type Action =
  | { readonly t: 'sync'; readonly ownZone: number | undefined; readonly extra: number[] }
  | { readonly t: 'answer'; readonly pick: number; readonly ok: boolean }
  | { readonly t: 'wait'; readonly ms: number };

const zoneArb = fc.integer({ min: 0, max: 3 });
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('sync' as const),
      ownZone: fc.option(zoneArb, { nil: undefined, freq: 8 }),
      extra: fc.uniqueArray(zoneArb, { maxLength: 2 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('answer' as const),
      pick: fc.nat(8),
      ok: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('wait' as const),
      ms: fc.integer({ min: 0, max: LINGER_MS + 500 }),
    }),
  },
);

describe('worldScope invariants (property)', () => {
  it('never unsubscribes a pending or ended handle, never the own zone, never an old zone before the own zone is applied', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 60 }), (actions) => {
        let state = INITIAL_SCOPE;
        let now = 0;
        // key -> the phase the SHELL knows for the handle the effects opened.
        const handles = new Map<string, 'pending' | 'active'>();
        let ownZone: number | undefined;
        let lastInput: ScopeInput | undefined;

        const apply = (effects: readonly ScopeEffect[]): boolean => {
          for (const effect of effects) {
            if (effect.kind === 'subscribe') {
              // One live handle per key: a second subscribe would leak the first.
              expect(handles.has(effect.key)).toBe(false);
              handles.set(effect.key, 'pending');
            } else if (effect.kind === 'unsubscribe') {
              expect(handles.get(effect.key)).toBe('active');
              if (ownZone !== undefined) {
                expect(effect.key).not.toBe(zoneKey(ownZone));
                expect(handles.get(zoneKey(ownZone))).toBe('active');
              }
              handles.delete(effect.key);
            } else if (effect.kind === 'drop') {
              return true;
            }
          }
          return false;
        };

        for (const action of actions) {
          if (action.t === 'wait') {
            now += action.ms;
            continue;
          }
          if (action.t === 'sync') {
            ownZone = action.ownZone;
            lastInput = { wantEntity: E, ownZone, wantZones: new Set(action.extra), now };
          } else {
            const pending = [...handles].filter(([, phase]) => phase === 'pending');
            if (pending.length === 0) continue;
            const key = pending[action.pick % pending.length][0];
            if (action.ok) handles.set(key, 'active');
            else handles.delete(key);
            state = onScopeEvent(state, { kind: action.ok ? 'applied' : 'rejected', key, now });
          }
          if (lastInput === undefined) continue;
          const out = syncScope(state, { ...lastInput, now });
          state = out.state;
          if (apply(out.effects)) {
            // A drop hands back the empty state; the shell discards its handles unsubscribed.
            expect(state).toBe(INITIAL_SCOPE);
            return;
          }
          // The state and the shell agree on every handle.
          expect(new Map([...state.entries].map(([k, e]) => [k, e.phase]))).toEqual(handles);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('once every pending set has applied and the linger has passed, the held sets are exactly the wanted ones', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { maxLength: 40 }),
        fc.option(zoneArb, { nil: undefined, freq: 8 }),
        fc.uniqueArray(zoneArb, { maxLength: 2 }),
        (actions, finalZone, finalExtra) => {
          let state = INITIAL_SCOPE;
          let now = 0;
          let lastInput: ScopeInput | undefined;
          const pendingKeys = (): string[] =>
            [...state.entries].filter(([, e]) => e.phase === 'pending').map(([k]) => k);
          for (const action of actions) {
            if (action.t === 'wait') {
              // Every set is answered before time passes, so no run ends on the apply timeout.
              for (const key of pendingKeys()) {
                state = onScopeEvent(state, { kind: 'applied', key, now });
              }
              now += action.ms;
            } else if (action.t === 'sync') {
              lastInput = {
                wantEntity: E,
                ownZone: action.ownZone,
                wantZones: new Set(action.extra),
                now,
              };
            } else {
              // Applied only: this property is about quiescence, not the failure ladder.
              const pending = pendingKeys();
              if (pending.length > 0) {
                const key = pending[action.pick % pending.length];
                state = onScopeEvent(state, { kind: 'applied', key, now });
              }
            }
            if (lastInput !== undefined) {
              const out = syncScope(state, { ...lastInput, now });
              expect(out.effects.some((e) => e.kind === 'drop')).toBe(false);
              state = out.state;
            }
          }
          // Quiesce: fix the wants, apply everything pending, let the linger pass.
          const final = { wantEntity: E, ownZone: finalZone, wantZones: new Set(finalExtra) };
          state = syncScope(state, { ...final, now }).state;
          for (const key of pendingKeys()) {
            state = onScopeEvent(state, { kind: 'applied', key, now });
          }
          state = syncScope(state, { ...final, now }).state;
          state = syncScope(state, { ...final, now: now + LINGER_MS }).state;

          const wanted = new Set<string>([OWN, ...finalExtra.map(zoneKey)]);
          if (finalZone !== undefined) wanted.add(zoneKey(finalZone));
          expect(new Set(state.entries.keys())).toEqual(wanted);
          for (const entry of state.entries.values()) expect(entry.phase).toBe('active');
          expect(state.settled).toBe(finalZone !== undefined);
          // Nothing further to do.
          expect(syncScope(state, { ...final, now: now + LINGER_MS * 2 }).effects).toEqual([]);
        },
      ),
      { numRuns: 500 },
    );
  });
});
