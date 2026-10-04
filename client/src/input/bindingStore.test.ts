/**
 * bindingStore.test.ts: the persisted binding table (ctl-12, CTL12.4).
 *
 * `parseBindings` is TOTAL: whatever a tab's storage holds (a corrupt string, a hostile object, a
 * table from a future version) it returns a table that is safe to boot with: every protected
 * button has a code, no code is bound twice across buttons and accelerators, no code is unbindable
 * and no list is longer than two. `loadBindings` / `saveBindings` add the storage seam (injected,
 * so no test touches a real `localStorage`), and neither may throw.
 *
 * The tables a player can actually produce are the ones `captureKey` / `clearAccel` reach from the
 * defaults, so the round-trip properties are driven by sequences of those two operations.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type ControlsRow,
  captureKey,
  clearAccel,
  controlsRows,
  type Slot,
} from '../ui/controlsModel';
import {
  CONTROLS_STORAGE_KEY,
  loadBindings,
  parseBindings,
  type StorageLike,
  saveBindings,
} from './bindingStore';
import { type Bindings, DEFAULT_BINDINGS, isBindableCode, PROTECTED_BUTTONS } from './bindings';
import { ACCELS, VBUTTONS } from './buttons';

// --- fixtures --------------------------------------------------------------------------------

/** An in-memory storage that records every write. */
function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  readonly data: Map<string, string>;
  readonly sets: Array<readonly [string, string]>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  const sets: Array<readonly [string, string]> = [];
  return {
    data,
    sets,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      sets.push([key, value]);
      data.set(key, value);
    },
  };
}

/** The table's lists as one flat array, buttons then accelerators. */
function allCodes(b: Bindings): string[] {
  const out: string[] = [];
  for (const v of VBUTTONS) out.push(...b.buttons[v]);
  for (const a of ACCELS) out.push(...b.accels[a]);
  return out;
}

/** The invariants every table a boot may use satisfies. */
function expectSane(b: Bindings): void {
  for (const v of VBUTTONS) {
    expect(b.buttons[v].length, `button ${v} has at most two codes`).toBeLessThanOrEqual(2);
    expect(new Set(b.buttons[v]).size, `button ${v} lists distinct codes`).toBe(
      b.buttons[v].length,
    );
  }
  for (const a of ACCELS) {
    expect(b.accels[a].length, `accelerator ${a} has at most two codes`).toBeLessThanOrEqual(2);
    expect(new Set(b.accels[a]).size, `accelerator ${a} lists distinct codes`).toBe(
      b.accels[a].length,
    );
  }
  for (const p of PROTECTED_BUTTONS) {
    expect(b.buttons[p].length, `protected button ${p} keeps a code`).toBeGreaterThanOrEqual(1);
  }
  const codes = allCodes(b);
  expect(new Set(codes).size, 'no code is bound twice across buttons and accelerators').toBe(
    codes.length,
  );
  for (const c of codes) expect(isBindableCode(c), `bound code ${JSON.stringify(c)}`).toBe(true);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The raw default table as plain JSON-able data (a fresh copy each call). */
const defaultsRaw = (): { buttons: Record<string, string[]>; accels: Record<string, string[]> } =>
  JSON.parse(
    JSON.stringify({ buttons: DEFAULT_BINDINGS.buttons, accels: DEFAULT_BINDINGS.accels }),
  );

// --- tables reachable by capture / clear -------------------------------------------------------

const ALL_ROWS: readonly ControlsRow[] = [...controlsRows('buttons'), ...controlsRows('shortcuts')];

const DEFAULT_CODES = allCodes(DEFAULT_BINDINGS);
/** Defaults, a few fresh keys, reserved keys and unbindable junk, so a sequence hits every rule. */
const CODE_POOL: readonly string[] = [
  ...DEFAULT_CODES,
  'Tab',
  'F5',
  'F11',
  'F12',
  'ShiftLeft',
  'ControlRight',
  'KeyK',
  'KeyZ',
  'Digit0',
  'F1',
  'CapsLock',
  'Numpad5',
  '',
  'Unidentified',
];

type Op =
  | {
      readonly kind: 'capture';
      readonly row: number;
      readonly slot: Slot;
      readonly code: string;
      readonly shift: boolean;
    }
  | { readonly kind: 'clear'; readonly accel: (typeof ACCELS)[number] };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('capture' as const),
    row: fc.nat(ALL_ROWS.length - 1),
    slot: fc.constantFrom<Slot>(0, 1),
    code: fc.constantFrom(...CODE_POOL),
    shift: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('clear' as const), accel: fc.constantFrom(...ACCELS) }),
);

function applyOp(b: Bindings, op: Op): Bindings {
  if (op.kind === 'clear') return clearAccel(b, op.accel);
  const outcome = captureKey(
    b,
    { row: ALL_ROWS[op.row], slot: op.slot },
    { code: op.code, key: 'x', shiftKey: op.shift },
  );
  return outcome.kind === 'bound' || outcome.kind === 'swapped' ? outcome.bindings : b;
}

/** Every table along the way, the defaults first; each is frozen before the next step so an
 *  operation that mutates its input throws. */
function reachable(ops: readonly Op[]): Bindings[] {
  const tables: Bindings[] = [DEFAULT_BINDINGS];
  let b: Bindings = DEFAULT_BINDINGS;
  for (const op of ops) {
    b = deepFreeze(applyOp(b, op));
    tables.push(b);
  }
  return tables;
}

const opsArb = fc.array(opArb, { maxLength: 40 });

// --- tests -------------------------------------------------------------------------------------

describe('bindingStore (ctl-12)', () => {
  it('CTL12-4-SAVE-SHAPE: saves {v:1, buttons, accels} under mr.controls and reports true', () => {
    // WRONG IMPL KILLED: a different storage key, a missing or string version, a flat or wrapped
    // table (the table not under `buttons` / `accels`), extra keys, a save that reports false on
    // success, and one that writes more than once.
    expect(CONTROLS_STORAGE_KEY).toBe('mr.controls');
    const store = memoryStorage();
    const custom: Bindings = {
      buttons: { ...DEFAULT_BINDINGS.buttons, A: ['KeyK'], Y: [] },
      accels: { ...DEFAULT_BINDINGS.accels, I: [], J: ['KeyJ', 'KeyX'] },
    };
    expect(saveBindings(store, custom)).toBe(true);
    expect(store.sets, 'exactly one write').toHaveLength(1);
    const [key, value] = store.sets[0];
    expect(key).toBe('mr.controls');
    const parsed: unknown = JSON.parse(value);
    expect(parsed).toEqual({ v: 1, buttons: custom.buttons, accels: custom.accels });
    expect(Object.keys(parsed as object).sort()).toEqual(['accels', 'buttons', 'v']);

    const defaults = memoryStorage();
    expect(saveBindings(defaults, DEFAULT_BINDINGS)).toBe(true);
    expect(JSON.parse(defaults.sets[0][1])).toEqual({
      v: 1,
      buttons: DEFAULT_BINDINGS.buttons,
      accels: DEFAULT_BINDINGS.accels,
    });
  });

  it('CTL12-4-ROUND-TRIP: load after save returns the saved table, for hand-built tables and for every table a capture / clear sequence reaches', () => {
    // WRONG IMPL KILLED: a save that drops a cleared accelerator (its default comes back), one that
    // drops an empty non-protected button, a parse that re-defaults a valid two-code list, one that
    // re-orders primary and alt, and a load that reads another key.
    const hand: Bindings[] = [
      DEFAULT_BINDINGS,
      {
        buttons: { ...DEFAULT_BINDINGS.buttons, A: ['KeyK'], Y: [] },
        accels: { ...DEFAULT_BINDINGS.accels, I: [], J: ['KeyJ', 'KeyX'] },
      },
      {
        buttons: { ...DEFAULT_BINDINGS.buttons, Up: ['ArrowUp', 'KeyW'], Select: ['Slash'] },
        accels: { ...DEFAULT_BINDINGS.accels, F9: [], F8: ['F1'] },
      },
    ];
    for (const b of hand) {
      const store = memoryStorage();
      expect(saveBindings(store, b)).toBe(true);
      expect(loadBindings(store)).toEqual(b);
    }
    fc.assert(
      fc.property(opsArb, (ops) => {
        for (const b of reachable(ops)) {
          const store = memoryStorage();
          expect(saveBindings(store, b)).toBe(true);
          expect(loadBindings(store)).toEqual(b);
        }
      }),
    );
  });

  it('CTL12-4-STORAGE-THROWS: a throwing getItem, bad JSON, a missing key and a null storage all load the defaults; a throwing setItem or a null storage saves false', () => {
    // WRONG IMPL KILLED: a load that lets getItem's SecurityError escape (the boot dies in a
    // private-mode browser), one that lets JSON.parse's SyntaxError escape (a corrupt string bricks
    // the game on every boot), a quota error escaping a save, and null storage treated as an
    // object.
    const throwingGet: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
    };
    expect(loadBindings(throwingGet)).toEqual(DEFAULT_BINDINGS);
    expect(loadBindings(memoryStorage({ 'mr.controls': '{not json' }))).toEqual(DEFAULT_BINDINGS);
    expect(loadBindings(memoryStorage({ 'mr.controls': '' }))).toEqual(DEFAULT_BINDINGS);
    expect(loadBindings(memoryStorage())).toEqual(DEFAULT_BINDINGS);
    expect(loadBindings(null)).toEqual(DEFAULT_BINDINGS);

    const quota: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(saveBindings(quota, DEFAULT_BINDINGS)).toBe(false);
    expect(saveBindings(null, DEFAULT_BINDINGS)).toBe(false);

    // A valid saved table is not the defaults: the loader reads under the right key.
    const custom: Bindings = {
      buttons: { ...DEFAULT_BINDINGS.buttons, A: ['KeyK'] },
      accels: DEFAULT_BINDINGS.accels,
    };
    const live = memoryStorage();
    saveBindings(live, custom);
    expect(loadBindings(live).buttons.A).toEqual(['KeyK']);
    const elsewhere = memoryStorage({ other: live.data.get('mr.controls') ?? '' });
    expect(loadBindings(elsewhere)).toEqual(DEFAULT_BINDINGS);
  });

  it('CTL12-4-PARSE-TOTAL: parseBindings never throws and always yields a sane table, for arbitrary values, arbitrary JSON and hostile v:1 tables', () => {
    // WRONG IMPL KILLED: a parse that throws on null / arrays / primitives, one that trusts a
    // list's length or its strings, one that leaves a protected button empty, one that allows a
    // code twice across buttons and accelerators, and one that lets a reserved or unbindable code
    // through. The structured arbitrary reaches the per-entry rules, which an arbitrary value
    // almost never does.
    const sane = (raw: unknown): void => {
      const b = parseBindings(raw);
      expectSane(b);
    };
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        sane(raw);
      }),
    );
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        sane(raw);
      }),
    );

    const entryArb = fc.oneof(
      fc.array(fc.constantFrom(...CODE_POOL), { maxLength: 4 }),
      fc.array(fc.oneof(fc.constantFrom(...CODE_POOL), fc.string(), fc.constant(null)), {
        maxLength: 3,
      }),
      fc.constant(null),
      fc.string(),
    );
    const sideArb = (keys: readonly string[]): fc.Arbitrary<unknown> =>
      fc.oneof(fc.dictionary(fc.constantFrom(...keys), entryArb), fc.constant(null));
    const rawArb = fc.record({
      v: fc.constantFrom(1, 1, 1, 2),
      buttons: sideArb(VBUTTONS),
      accels: sideArb(ACCELS),
    });
    fc.assert(
      fc.property(rawArb, (raw) => {
        sane(raw);
      }),
    );
  });

  it('CTL12-4-PARSE-PER-ENTRY: a valid entry is kept, an invalid or missing one falls back to that entry default, a cleared accelerator stays cleared, and a protected button cannot be empty', () => {
    // WRONG IMPL KILLED: one bad entry resetting the whole table (the valid A below would be
    // lost), a bad entry kept as is, a cleared accelerator re-defaulted, an empty protected
    // button kept, a three-code list truncated instead of rejected, a duplicate-in-list kept, and
    // a reserved code kept.
    const raw = {
      v: 1,
      buttons: {
        A: ['KeyK'], // valid: kept
        X: 'nonsense', // not a list: X default
        Up: [], // protected may not be empty: Up default
        Y: ['KeyG', 'KeyH', 'KeyT'], // three codes: Y default
        B: ['Tab'], // reserved: B default
        Start: ['KeyM', 'KeyM'], // duplicate in the list: Start default
        Select: [], // not protected: an empty list is valid and kept
        // Down, Left, Right, LB, RB missing: their defaults
      },
      accels: {
        I: [], // cleared: stays cleared
        J: ['KeyJ', 'KeyJ'], // duplicate: J default
        U: ['KeyU', 'KeyY', 'KeyO'], // three: U default
        L: ['Tab'], // reserved: L default
        N: ['KeyN', 'KeyX'], // two valid: kept
        // B, V, P, C, F9, F8 missing: their defaults
      },
    };
    const b = parseBindings(raw);
    expect(b.buttons.A).toEqual(['KeyK']);
    expect(b.buttons.X).toEqual(DEFAULT_BINDINGS.buttons.X);
    expect(b.buttons.Up).toEqual(DEFAULT_BINDINGS.buttons.Up);
    expect(b.buttons.Y).toEqual(DEFAULT_BINDINGS.buttons.Y);
    expect(b.buttons.B).toEqual(DEFAULT_BINDINGS.buttons.B);
    expect(b.buttons.Start).toEqual(DEFAULT_BINDINGS.buttons.Start);
    expect(b.buttons.Select).toEqual([]);
    expect(b.buttons.Down).toEqual(DEFAULT_BINDINGS.buttons.Down);
    expect(b.buttons.LB).toEqual(DEFAULT_BINDINGS.buttons.LB);
    expect(b.accels.I).toEqual([]);
    expect(b.accels.J).toEqual(DEFAULT_BINDINGS.accels.J);
    expect(b.accels.U).toEqual(DEFAULT_BINDINGS.accels.U);
    expect(b.accels.L).toEqual(DEFAULT_BINDINGS.accels.L);
    expect(b.accels.N).toEqual(['KeyN', 'KeyX']);
    expect(b.accels.B).toEqual(DEFAULT_BINDINGS.accels.B);
    expect(b.accels.F9).toEqual(DEFAULT_BINDINGS.accels.F9);
    expectSane(b);
  });

  it('CTL12-4-UNKNOWN-V: a table whose own v is not the number 1 loads as the defaults; the same table with v:1 is honoured', () => {
    // WRONG IMPL KILLED: a loader that ignores the version (a v:2 file written by a newer client
    // is half-read), one that coerces '1' or true, one that reads an inherited `v`, and a parse
    // that treats a missing v as 1. The v:1 control proves the table itself is valid.
    const table = { buttons: { A: ['KeyK'] }, accels: {} };
    const control = parseBindings({ v: 1, ...table });
    expect(control.buttons.A, 'control: the same table with v:1 is honoured').toEqual(['KeyK']);
    for (const v of [2, 0, -1, '1', true, null, [1], { v: 1 }, Number.NaN, 1.5]) {
      expect(parseBindings({ v, ...table }), `v = ${JSON.stringify(v)}`).toEqual(DEFAULT_BINDINGS);
    }
    expect(parseBindings(table), 'v missing').toEqual(DEFAULT_BINDINGS);
    const inherited = Object.assign(Object.create({ v: 1 }), table);
    expect(parseBindings(inherited), 'v only on the prototype').toEqual(DEFAULT_BINDINGS);
    for (const raw of [null, undefined, 0, 'x', true, [], [1, 2], 42n]) {
      expect(parseBindings(raw), `raw = ${String(raw)}`).toEqual(DEFAULT_BINDINGS);
    }
  });

  it('CTL12-4-PARSE-HOSTILE: nested nulls, wrong shapes, prototype keys, reserved and unbindable codes fall back as specified and never pollute Object.prototype; every reachable table survives a JSON round trip', () => {
    // WRONG IMPL KILLED: a parse that throws on a null side, one that treats `accels: []` as an
    // object, one that reads an inherited entry, one that writes through `__proto__` (polluting
    // every object in the page), one that accepts `__proto__` / Tab / Unidentified as a code, one
    // that keeps a duplicate pair, and a save/parse pair that is not an inverse on the tables a
    // player can build.
    const wrapA = (a: unknown): unknown => ({ v: 1, buttons: { A: a }, accels: {} });
    expect(parseBindings({ v: 1, buttons: null, accels: [] })).toEqual(DEFAULT_BINDINGS);
    expect(parseBindings({ v: 1, buttons: [], accels: null })).toEqual(DEFAULT_BINDINGS);
    expect(parseBindings({ v: 1 })).toEqual(DEFAULT_BINDINGS);
    for (const a of [
      null,
      [null],
      'Enter',
      ['KeyK', 'KeyK'],
      ['__proto__'],
      ['Tab'],
      ['Unidentified'],
      [''],
      [{}],
      [['KeyK']],
      { 0: 'KeyK', length: 1 },
    ]) {
      expect(parseBindings(wrapA(a)), `A = ${JSON.stringify(a)}`).toEqual(DEFAULT_BINDINGS);
    }

    // An own "__proto__" key (JSON.parse makes it an own data property).
    const text =
      '{"v":1,"buttons":{"__proto__":{"A":["KeyQ"],"polluted":true},"constructor":["KeyK"]},' +
      '"accels":{"__proto__":["KeyZ"],"toString":["KeyY"]}}';
    const fromText = parseBindings(JSON.parse(text));
    expect(fromText, 'prototype-named keys are not entries').toEqual(DEFAULT_BINDINGS);
    expect(
      ({} as Record<string, unknown>).polluted,
      'Object.prototype stays clean',
    ).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);

    // An inherited entry is not an entry.
    const inheritedSide = Object.create({ A: ['KeyQ'] });
    expect(parseBindings({ v: 1, buttons: inheritedSide, accels: {} })).toEqual(DEFAULT_BINDINGS);

    // Every reachable table survives parse(JSON.parse(JSON.stringify(b))).
    fc.assert(
      fc.property(opsArb, (ops) => {
        for (const b of reachable(ops)) {
          const viaJson = parseBindings(JSON.parse(JSON.stringify(b)));
          expect(viaJson).toEqual(b);
          expectSane(viaJson);
        }
      }),
    );
  });

  // --- untagged extras --------------------------------------------------------------------

  it('a code claimed by an earlier entry is dropped from the later one, which keeps its remaining codes (possibly none) and is not re-defaulted', () => {
    // WRONG IMPL KILLED: duplicates left in (one key fires two buttons), the later entry reset to
    // its default (which is the code just dropped), and the earlier entry losing the code instead.
    const b = parseBindings({ v: 1, buttons: { A: ['KeyF'] }, accels: {} });
    expect(b.buttons.A).toEqual(['KeyF']);
    expect(b.buttons.Y, 'Y default KeyF is taken by A').toEqual([]);
    expectSane(b);

    // A button beats an accelerator: buttons are walked first.
    const c = parseBindings({ v: 1, buttons: { X: ['KeyI'] }, accels: { I: ['KeyI', 'KeyO'] } });
    expect(c.buttons.X).toEqual(['KeyI']);
    expect(c.accels.I).toEqual(['KeyO']);
    expectSane(c);
  });

  it('a protected button left with no code by duplicate dropping resets the whole table to the defaults', () => {
    // WRONG IMPL KILLED: a table with a dead D-pad or Start (the player cannot move or open the
    // menu), and a partial repair that keeps the other custom entries.
    const raw = {
      v: 1,
      buttons: { Up: ['KeyK'], Down: ['KeyK'], X: ['KeyG'] },
      accels: {},
    };
    expect(parseBindings(raw)).toEqual(DEFAULT_BINDINGS);
  });

  it('a stored table with unbindable codes (empty, Unidentified, over 32 characters, spaces) is rejected entry by entry', () => {
    // WRONG IMPL KILLED: a length check on the list but not on each string, and a code with a
    // space or bidi override kept (it would paint a misleading keycap).
    const RLO = String.fromCharCode(0x202e);
    const long = 'A'.repeat(33);
    for (const code of ['', 'Unidentified', long, 'Key K', `Key${RLO}K`, 'KeyK\n']) {
      const b = parseBindings({ v: 1, buttons: { X: [code] }, accels: {} });
      expect(b.buttons.X, `X = ${JSON.stringify(code)}`).toEqual(DEFAULT_BINDINGS.buttons.X);
    }
    const ok = parseBindings({ v: 1, buttons: { X: ['A'.repeat(32)] }, accels: {} });
    expect(ok.buttons.X, 'a 32-character code is the longest allowed').toEqual(['A'.repeat(32)]);
  });

  it('a fully-defaulted table equals the DEFAULT_BINDINGS shape for an empty v:1 object', () => {
    // WRONG IMPL KILLED: a parse that returns an empty table for missing sides.
    expect(parseBindings({ v: 1, buttons: {}, accels: {} })).toEqual(DEFAULT_BINDINGS);
    const raw = { v: 1, ...defaultsRaw() };
    expect(parseBindings(raw)).toEqual(DEFAULT_BINDINGS);
  });
});
