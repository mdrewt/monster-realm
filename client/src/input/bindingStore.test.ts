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
 *
 * The same record holds the pad table under its `pad` key (`{buttons, accels}` of pad indices).
 * `parsePadBindings` is total over that value in the same way: every protected button keeps exactly
 * one bindable index, no index is bound twice across buttons and menu accelerators, no list is
 * longer than one, and a stored F8 / F9 entry is never read (the pad has no debug accelerators).
 * `saveBindings` takes both tables, so every save writes the whole record.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  type ControlsRow,
  captureKey,
  capturePad,
  clearAccel,
  type PadRow,
  padRow,
  type Slot,
} from '../ui/controlsModel';
import {
  browserStorage,
  CONTROLS_STORAGE_KEY,
  loadBindings,
  loadPadBindings,
  parseBindings,
  parsePadBindings,
  type StorageLike,
  saveBindings,
} from './bindingStore';
import { type Bindings, DEFAULT_BINDINGS, isBindableCode, PROTECTED_BUTTONS } from './bindings';
import { ACCELS, VBUTTONS, type VButton } from './buttons';
import {
  isBindablePadIndex,
  PAD_DEFAULT_BINDINGS,
  type PadBindings,
  type PadIndex,
} from './padBindings';
import type { MenuAccel } from './router';

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

const ALL_ROWS: readonly ControlsRow[] = [
  ...VBUTTONS.map((id): ControlsRow => ({ kind: 'button', id })),
  ...ACCELS.map((id): ControlsRow => ({ kind: 'accel', id })),
];

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
  it('CTL12-4-SAVE-SHAPE: saves {v:1, buttons, accels, pad} under mr.controls and reports true', () => {
    // WRONG IMPL KILLED: a different storage key, a missing or string version, a flat or wrapped
    // table (the table not under `buttons` / `accels`), extra keys, a save that reports false on
    // success, and one that writes more than once.
    // INTENTIONAL CHANGE (pad remap, plan "Intentional changes to existing tests"): `saveBindings`
    // takes the pad table as a required third argument and the record holds it under `pad`, so the
    // pinned record and its key set include `pad` (the default pad table here).
    expect(CONTROLS_STORAGE_KEY).toBe('mr.controls');
    const store = memoryStorage();
    const custom: Bindings = {
      buttons: { ...DEFAULT_BINDINGS.buttons, A: ['KeyK'], Y: [] },
      accels: { ...DEFAULT_BINDINGS.accels, I: [], J: ['KeyJ', 'KeyX'] },
    };
    expect(saveBindings(store, custom, PAD_DEFAULT_BINDINGS)).toBe(true);
    expect(store.sets, 'exactly one write').toHaveLength(1);
    const [key, value] = store.sets[0];
    expect(key).toBe('mr.controls');
    const parsed: unknown = JSON.parse(value);
    expect(parsed).toEqual({
      v: 1,
      buttons: custom.buttons,
      accels: custom.accels,
      pad: { buttons: PAD_DEFAULT_BINDINGS.buttons, accels: PAD_DEFAULT_BINDINGS.accels },
    });
    expect(Object.keys(parsed as object).sort()).toEqual(['accels', 'buttons', 'pad', 'v']);

    const defaults = memoryStorage();
    expect(saveBindings(defaults, DEFAULT_BINDINGS, PAD_DEFAULT_BINDINGS)).toBe(true);
    expect(JSON.parse(defaults.sets[0][1])).toEqual({
      v: 1,
      buttons: DEFAULT_BINDINGS.buttons,
      accels: DEFAULT_BINDINGS.accels,
      pad: { buttons: PAD_DEFAULT_BINDINGS.buttons, accels: PAD_DEFAULT_BINDINGS.accels },
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
    // INTENTIONAL CHANGE (pad remap): each save passes the pad table (the required third argument);
    // the keyboard round trip it pins is unchanged.
    for (const b of hand) {
      const store = memoryStorage();
      expect(saveBindings(store, b, PAD_DEFAULT_BINDINGS)).toBe(true);
      expect(loadBindings(store)).toEqual(b);
    }
    fc.assert(
      fc.property(opsArb, (ops) => {
        for (const b of reachable(ops)) {
          const store = memoryStorage();
          expect(saveBindings(store, b, PAD_DEFAULT_BINDINGS)).toBe(true);
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
    // INTENTIONAL CHANGE (pad remap): each save passes the pad table (the required third argument).
    expect(saveBindings(quota, DEFAULT_BINDINGS, PAD_DEFAULT_BINDINGS)).toBe(false);
    expect(saveBindings(null, DEFAULT_BINDINGS, PAD_DEFAULT_BINDINGS)).toBe(false);

    // A valid saved table is not the defaults: the loader reads under the right key.
    const custom: Bindings = {
      buttons: { ...DEFAULT_BINDINGS.buttons, A: ['KeyK'] },
      accels: DEFAULT_BINDINGS.accels,
    };
    const live = memoryStorage();
    saveBindings(live, custom, PAD_DEFAULT_BINDINGS);
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

    // Every reachable table survives parse(JSON.parse(JSON.stringify({ v: 1, buttons, accels }))),
    // the stored shape.
    fc.assert(
      fc.property(opsArb, (ops) => {
        for (const b of reachable(ops)) {
          const viaJson = parseBindings(
            JSON.parse(JSON.stringify({ v: 1, buttons: b.buttons, accels: b.accels })),
          );
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

  it('stored entries are claimed before defaults fill invalid or missing ones: a default never steals a code a stored entry holds', () => {
    // WRONG IMPL KILLED: a single in-order walk where Up's invalid entry is defaulted to
    // [KeyW, ArrowUp] first and Select's stored KeyW is then dropped (the player's stored choice
    // loses to a default), a result that resets the whole table instead, and a default that keeps
    // the code the stored entry took (KeyW twice).
    const b = parseBindings({ v: 1, buttons: { Up: 5, Select: ['KeyW'] }, accels: {} });
    expect(b.buttons.Select).toEqual(['KeyW']);
    expect(b.buttons.Up, 'Up is its default minus the stored claim').toEqual(['ArrowUp']);
    expect(b).toEqual({
      buttons: { ...DEFAULT_BINDINGS.buttons, Up: ['ArrowUp'], Select: ['KeyW'] },
      accels: DEFAULT_BINDINGS.accels,
    });
    expectSane(b);

    // The unchanged rule: A stores KeyF, Y (missing) loses its default KeyF and is empty.
    const c = parseBindings({ v: 1, buttons: { A: ['KeyF'] } });
    expect(c.buttons.A).toEqual(['KeyF']);
    expect(c.buttons.Y).toEqual([]);
    expect(c.accels).toEqual(DEFAULT_BINDINGS.accels);
    expectSane(c);
  });

  it('browserStorage returns window.localStorage, or null when reading it throws', () => {
    // WRONG IMPL KILLED: a bare `window.localStorage` return (the SecurityError of a
    // storage-denied browser escapes at boot and the page never starts), and a null that is
    // returned even when storage is readable.
    const live = memoryStorage();
    vi.stubGlobal('window', { localStorage: live });
    try {
      expect(browserStorage()).toBe(live);
    } finally {
      vi.unstubAllGlobals();
    }
    const denied = {};
    Object.defineProperty(denied, 'localStorage', {
      get: () => {
        throw new Error('SecurityError');
      },
    });
    vi.stubGlobal('window', denied);
    try {
      expect(() => browserStorage()).not.toThrow();
      expect(browserStorage()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
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

// =============================================================================================
// The pad table in the same record: parsePadBindings, loadPadBindings and the three-argument save
// =============================================================================================

/** The menu accelerators a pad table names, in the default table's key order (no F8, no F9). */
const MENU_ACCEL_IDS: readonly MenuAccel[] = Object.keys(
  PAD_DEFAULT_BINDINGS.accels,
) as MenuAccel[];

/** The default pad table with some lists replaced, as plain data for a `toEqual`. */
function padTable(
  buttons: Partial<Record<VButton, readonly PadIndex[]>> = {},
  accels: Partial<Record<MenuAccel, readonly PadIndex[]>> = {},
): PadBindings {
  return {
    buttons: { ...PAD_DEFAULT_BINDINGS.buttons, ...buttons },
    accels: { ...PAD_DEFAULT_BINDINGS.accels, ...accels },
  };
}

/** Every index a pad table binds, buttons then accelerators. */
function allPadIndices(p: PadBindings): PadIndex[] {
  const out: PadIndex[] = [];
  for (const b of VBUTTONS) out.push(...p.buttons[b]);
  for (const a of MENU_ACCEL_IDS) out.push(...p.accels[a]);
  return out;
}

/** The invariants every pad table a boot may use satisfies. */
function expectSanePad(p: PadBindings): void {
  expect(Object.keys(p.buttons).sort(), 'exactly the twelve buttons').toEqual([...VBUTTONS].sort());
  expect(Object.keys(p.accels).sort(), 'exactly the ten menu accelerators').toEqual(
    [...MENU_ACCEL_IDS].sort(),
  );
  for (const b of VBUTTONS) {
    expect(Array.isArray(p.buttons[b]), `button ${b} is a list`).toBe(true);
    expect(p.buttons[b].length, `button ${b} has at most one pad index`).toBeLessThanOrEqual(1);
  }
  for (const a of MENU_ACCEL_IDS) {
    expect(Array.isArray(p.accels[a]), `accelerator ${a} is a list`).toBe(true);
    expect(p.accels[a].length, `accelerator ${a} has at most one pad index`).toBeLessThanOrEqual(1);
  }
  for (const b of PROTECTED_BUTTONS) {
    expect(p.buttons[b], `protected button ${b} keeps exactly one pad index`).toHaveLength(1);
  }
  const all = allPadIndices(p);
  expect(new Set(all).size, 'no pad index is bound twice across buttons and accelerators').toBe(
    all.length,
  );
  for (const i of all) expect(isBindablePadIndex(i), `bound index ${String(i)}`).toBe(true);
}

/** Every Controls row that has a Pad cell (the F8 and F9 rows have none). Built per call, inside
 *  the cases, so the keyboard cases above load whatever the model exports. */
const padRows = (): PadRow[] =>
  ALL_ROWS.flatMap((row) => {
    const p = padRow(row);
    return p === undefined ? [] : [p];
  });

/** Indices a pad capture can receive: every standard button, Guide (16), 17, the last bindable
 *  index (31) and three unbindable ones. */
const PAD_INDEX_POOL: readonly number[] = [
  ...Array.from({ length: 18 }, (_, i) => i),
  31,
  32,
  -1,
  1.5,
];

type PadOp = { readonly kind: 'pad'; readonly row: number; readonly index: number };

const padOpArb = (): fc.Arbitrary<PadOp> =>
  fc.record({
    kind: fc.constant('pad' as const),
    row: fc.nat(padRows().length - 1),
    index: fc.constantFrom(...PAD_INDEX_POOL),
  });

function applyPadOp(p: PadBindings, op: PadOp): PadBindings {
  const outcome = capturePad(p, { row: padRows()[op.row], slot: 'pad' }, op.index);
  return outcome.kind === 'bound' || outcome.kind === 'swapped' ? outcome.bindings : p;
}

/** A stored `mr.controls` record as a one-key storage. */
const recordStorage = (record: unknown) => memoryStorage({ 'mr.controls': JSON.stringify(record) });

/** A storage whose read throws, as a browser that denies storage does. */
const throwingRead: StorageLike = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => undefined,
};

/** A storage whose write throws, as a full quota does. */
const refusingWrite: StorageLike = {
  getItem: () => null,
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('bindingStore: the pad table under mr.controls.pad', () => {
  it('a missing or non-object pad value (undefined, null, a list, a number, a string, a boolean) parses to PAD_DEFAULT_BINDINGS itself [gp-5.1]', () => {
    // WRONG IMPL KILLED: a parse that throws on a primitive or null (the boot dies on a hand-edited
    // record), one that reads a list as a table (`[[0]]` index access), one that answers
    // an EMPTY table for a missing value (the pad would press nothing), and one that answers a fresh
    // copy (the contract names the very default object).
    const values: ReadonlyArray<readonly [string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['an empty list', []],
      ['a list of lists', [[0], [1]]],
      ['zero', 0],
      ['a number', 7],
      ['NaN', Number.NaN],
      ['an empty string', ''],
      ['a string', 'pad'],
      ['true', true],
      ['false', false],
      ['a bigint', 42n],
    ];
    for (const [what, raw] of values) {
      expect(parsePadBindings(raw), what).toBe(PAD_DEFAULT_BINDINGS);
    }
    // An object with no entries is a table whose every entry is missing: the defaults, by value.
    expect(parsePadBindings({}), 'an empty object').toEqual(PAD_DEFAULT_BINDINGS);
    expect(parsePadBindings({ buttons: null, accels: [] }), 'null and list sides').toEqual(
      PAD_DEFAULT_BINDINGS,
    );
  });

  it('loadPadBindings reads the pad value of the mr.controls record: a record with no pad key, or a pad value that is not an object, gives the pad defaults, and loadBindings still reads that record`s keyboard table [gp-5.1]', () => {
    // WRONG IMPL KILLED: a pad loader that reads the whole record as the pad table (the keyboard
    // `buttons` would be read as pad lists), one that resets the keyboard table when the pad value is
    // bad (a record from a client older than the pad remap loses its keyboard remap), one that reads
    // another key, and a keyboard loader that starts rejecting a record because it holds `pad`.
    const keys = { v: 1, buttons: { A: ['KeyK'] }, accels: {} };
    const noPad = recordStorage(keys);
    expect(loadPadBindings(noPad), 'no pad key').toEqual(PAD_DEFAULT_BINDINGS);
    expect(loadBindings(noPad).buttons.A, 'no pad key: the keyboard remap is kept').toEqual([
      'KeyK',
    ]);
    for (const pad of ['x', 7, [3], null, true]) {
      const store = recordStorage({ ...keys, pad });
      expect(loadPadBindings(store), `pad = ${JSON.stringify(pad)}`).toEqual(PAD_DEFAULT_BINDINGS);
      expect(loadBindings(store).buttons.A, `pad = ${JSON.stringify(pad)}: keyboard kept`).toEqual([
        'KeyK',
      ]);
    }
    // ANTI-VACUITY: a valid pad value in the same record is read, and the keyboard table with it.
    const withPad = recordStorage({ ...keys, pad: { buttons: { A: [3], Y: [0] }, accels: {} } });
    expect(loadPadBindings(withPad), 'control: a valid pad value is read').toEqual(
      padTable({ A: [3], Y: [0] }),
    );
    expect(loadBindings(withPad).buttons.A, 'control: and the keyboard table beside it').toEqual([
      'KeyK',
    ]);
  });

  it('loadPadBindings gives the pad defaults, and never throws, for a null storage, a throwing read, unparsable JSON, an empty string, nothing saved, the record under another key, a record that is not an object, or a record whose own v is not the number 1 [gp-5.1]', () => {
    // WRONG IMPL KILLED: a read whose SecurityError or SyntaxError escapes (the page never boots),
    // a loader that ignores the version (a v:2 file from a newer client is half-read), one that
    // coerces '1' or true, one that reads an inherited `v`, and one that reads another key.
    const pad = { buttons: { A: [3], Y: [0] }, accels: {} };
    expect(loadPadBindings(recordStorage({ v: 1, pad })), 'control: v:1 is read').toEqual(
      padTable({ A: [3], Y: [0] }),
    );
    expect(loadPadBindings(null), 'a null storage').toEqual(PAD_DEFAULT_BINDINGS);
    expect(() => loadPadBindings(throwingRead), 'a throwing read does not throw').not.toThrow();
    expect(loadPadBindings(throwingRead), 'a throwing read').toEqual(PAD_DEFAULT_BINDINGS);
    for (const text of ['{not json', '', 'null', '[]', '5', '"pad"', 'true']) {
      expect(
        loadPadBindings(memoryStorage({ 'mr.controls': text })),
        `stored ${JSON.stringify(text)}`,
      ).toEqual(PAD_DEFAULT_BINDINGS);
    }
    expect(loadPadBindings(memoryStorage()), 'nothing saved').toEqual(PAD_DEFAULT_BINDINGS);
    expect(
      loadPadBindings(memoryStorage({ other: JSON.stringify({ v: 1, pad }) })),
      'another key',
    ).toEqual(PAD_DEFAULT_BINDINGS);
    for (const v of [2, 0, '1', true, null, 1.5]) {
      expect(loadPadBindings(recordStorage({ v, pad })), `v = ${JSON.stringify(v)}`).toEqual(
        PAD_DEFAULT_BINDINGS,
      );
    }
    expect(loadPadBindings(recordStorage({ pad })), 'v missing').toEqual(PAD_DEFAULT_BINDINGS);
  });

  it('one invalid stored pad entry (not a list, an array-like object, two indices, the reserved 16, a negative, fractional, past-31, infinite or NaN index, a numeric string, a nested list) falls back to its own default while every valid entry is kept [gp-5.2]', () => {
    // WRONG IMPL KILLED: one bad entry resetting the whole table (LB's [10] and J's [11] would be
    // lost), a bad entry kept as is (Guide or a fractional index bound), a two-index list
    // truncated to its first (X would take Y's 3 and Y would lose it), a numeric string coerced,
    // an index range check off by one (32 kept, or 31 refused), and the accelerator side not read.
    const bad: ReadonlyArray<readonly [string, unknown]> = [
      ['a number, not a list', 2],
      ['a string, not a list', '2'],
      ['null', null],
      ['an array-like object', { 0: 2, length: 1 }],
      ['two indices', [3, 4]],
      ['the reserved Guide button 16', [16]],
      ['a negative index', [-1]],
      ['a fractional index', [1.5]],
      ['index 32, past the last', [32]],
      ['Infinity', [Number.POSITIVE_INFINITY]],
      ['NaN', [Number.NaN]],
      ['a numeric string', ['0']],
      ['a nested list', [[2]]],
      ['a boolean', [true]],
    ];
    for (const [what, entry] of bad) {
      const onButton = parsePadBindings({ buttons: { LB: [10], X: entry }, accels: { J: [11] } });
      expect(onButton, `button X = ${what}`).toEqual(padTable({ LB: [10], X: [2] }, { J: [11] }));
      expectSanePad(onButton);
      const onAccel = parsePadBindings({ buttons: { LB: [10] }, accels: { I: entry, J: [11] } });
      expect(onAccel, `accelerator I = ${what}`).toEqual(
        padTable({ LB: [10] }, { I: [7], J: [11] }),
      );
      expectSanePad(onAccel);
    }
    // The boundary: 31 is the last bindable index, and an empty list is a valid non-protected entry.
    expect(parsePadBindings({ buttons: { X: [31] } }), 'X = [31]').toEqual(padTable({ X: [31] }));
    expect(parsePadBindings({ buttons: { X: [] } }), 'X = []').toEqual(padTable({ X: [] }));
    expect(parsePadBindings({ accels: { I: [] } }), 'a cleared accelerator stays cleared').toEqual(
      padTable({}, { I: [] }),
    );
    // A protected button may not be stored empty: that entry alone takes its default.
    expect(parsePadBindings({ buttons: { Up: [], LB: [10] } }), 'Up = []').toEqual(
      padTable({ LB: [10] }),
    );
  });

  it('an invalid or missing pad entry falls back to its default MINUS every index a valid stored entry claims, whether that entry comes before or after it, on buttons and accelerators alike [gp-5.2]', () => {
    // WRONG IMPL KILLED: a single in-order walk where X's invalid entry is defaulted to [2] before
    // LB's stored [2] is read (LB would then be refused as a duplicate and the player's stored
    // choice lost to a default), a default that keeps an index a stored entry holds (2 bound
    // twice), a fallback to [] instead of the default (the Bag would lose RT for nothing), and a
    // claim that ignores the other namespace.
    expect(parsePadBindings({ buttons: { X: 'bad', LB: [2] } }), 'X after LB claims 2').toEqual(
      padTable({ X: [], LB: [2] }),
    );
    expect(
      parsePadBindings({ buttons: { Y: [16] }, accels: { I: [3] } }),
      'Y`s default 3 claimed by the Bag accelerator',
    ).toEqual(padTable({ Y: [] }, { I: [3] }));
    expect(
      parsePadBindings({ buttons: { Select: [6] }, accels: { V: [1.5] } }),
      'Party`s default 6 claimed by a button',
    ).toEqual(padTable({ Select: [6] }, { V: [] }));
    expect(
      parsePadBindings({ accels: { I: null, C: [7] } }),
      'the Bag`s default 7 claimed by a later accelerator',
    ).toEqual(padTable({}, { I: [], C: [7] }));
    // A MISSING entry is defaulted the same way: Y is not stored and its 3 is A's now.
    expect(parsePadBindings({ buttons: { A: [3] } }), 'Y missing, its 3 taken by A').toEqual(
      padTable({ A: [3], Y: [] }),
    );
    // ANTI-VACUITY: an unclaimed default comes back whole.
    expect(parsePadBindings({ buttons: { X: 'bad' } }), 'X alone').toEqual(PAD_DEFAULT_BINDINGS);
  });

  it('a stored index an earlier valid entry already claims makes the later entry invalid, so it takes its default minus the claims: button and button, button and accelerator, accelerator and accelerator [gp-5.2]', () => {
    // WRONG IMPL KILLED: duplicates kept (one pad button pressing two things), the keyboard
    // parser's rule copied (the later entry keeps its other indices, so here it ends EMPTY instead of
    // on its default), the walk following the stored object's key order instead of the table's
    // (each object below lists the later row first), and accelerators read before buttons.
    expect(
      parsePadBindings({ buttons: { RB: [10], LB: [10] } }),
      'LB precedes RB: RB is defaulted',
    ).toEqual(padTable({ LB: [10], RB: [5] }));
    expect(
      parsePadBindings({ accels: { I: [11] }, buttons: { X: [11] } }),
      'buttons precede accelerators: the Bag is defaulted',
    ).toEqual(padTable({ X: [11] }, { I: [7] }));
    expect(
      parsePadBindings({ accels: { V: [11], I: [11] } }),
      'the Bag precedes Party: Party is defaulted',
    ).toEqual(padTable({}, { I: [11], V: [6] }));
    // The duplicate's default is itself claimed: it ends empty.
    expect(
      parsePadBindings({ buttons: { RB: [10], LB: [10], X: [5] } }),
      'RB`s default 5 is X`s stored index',
    ).toEqual(padTable({ X: [5], LB: [10], RB: [] }));
  });

  it('the pad value is read only as {buttons, accels}: a flat {A:[3]} is not read, a stored F8 or F9 entry and an unknown key are ignored and claim nothing, prototype-named and inherited entries are not entries, and nothing pollutes Object.prototype [gp-5.2]', () => {
    // WRONG IMPL KILLED: a parse that also accepts a flat `{A: [3]}` (two shapes for one record),
    // one that walks every accelerator in ACCELS (a stored F8 = [4] would claim LB's default and LB
    // would end empty; the table would grow F8 / F9 keys), one that walks the stored object's own
    // keys (an unknown "Turbo" claims 10 first), one that reads an inherited entry, and one that
    // writes through `__proto__`.
    expect(parsePadBindings({ A: [3], Y: [0], LB: [10] }), 'a flat value').toEqual(
      PAD_DEFAULT_BINDINGS,
    );
    const debug = parsePadBindings({ buttons: {}, accels: { F8: [4], F9: [10] } });
    expect(debug, 'F8 and F9 claim nothing').toEqual(PAD_DEFAULT_BINDINGS);
    expect(Object.hasOwn(debug.accels, 'F8'), 'no F8 entry').toBe(false);
    expect(Object.hasOwn(debug.accels, 'F9'), 'no F9 entry').toBe(false);
    expect(
      parsePadBindings({ buttons: { Turbo: [10], LB: [10] }, accels: { Q: [11], J: [11] } }),
      'unknown keys are not entries',
    ).toEqual(padTable({ LB: [10] }, { J: [11] }));

    const text =
      '{"buttons":{"__proto__":{"A":[3],"polluted":true},"constructor":[10],"toString":[11]},' +
      '"accels":{"__proto__":[10],"hasOwnProperty":[11],"valueOf":[12]}}';
    expect(parsePadBindings(JSON.parse(text)), 'prototype-named keys').toEqual(
      PAD_DEFAULT_BINDINGS,
    );
    expect(
      ({} as Record<string, unknown>).polluted,
      'Object.prototype stays clean',
    ).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);

    expect(
      parsePadBindings({ buttons: Object.create({ A: [3], Y: [0] }) }),
      'inherited entries',
    ).toEqual(PAD_DEFAULT_BINDINGS);
    expect(
      parsePadBindings(Object.create({ buttons: { A: [3], Y: [0] } })),
      'an inherited buttons side',
    ).toEqual(PAD_DEFAULT_BINDINGS);
    // ANTI-VACUITY: the same entries as own properties are read.
    expect(parsePadBindings({ buttons: { A: [3], Y: [0] } }), 'control: own entries').toEqual(
      padTable({ A: [3], Y: [0] }),
    );
  });

  it('a parsed pad table is deep-frozen and owns fresh lists: a later change to the stored arrays changes nothing [gp-5.2]', () => {
    // WRONG IMPL KILLED: a table that hands back the parsed JSON arrays (a caller that edits the
    // record it read would rebind the live pad), and a table any caller can mutate in place.
    const stored = [10];
    const raw = { buttons: { LB: stored }, accels: { J: [11] } };
    const p = parsePadBindings(raw);
    expect(p.buttons.LB).toEqual([10]);
    expect(p.buttons.LB, 'a fresh list, not the stored array').not.toBe(stored);
    stored.push(4);
    raw.accels.J = [2];
    expect(p.buttons.LB, 'the stored array changed after the parse').toEqual([10]);
    expect(p.accels.J).toEqual([11]);
    for (const [what, value] of [
      ['the table', p],
      ['its buttons', p.buttons],
      ['its accelerators', p.accels],
      ['a stored list', p.buttons.LB],
      ['a defaulted list', p.buttons.A],
      ['an accelerator list', p.accels.J],
    ] as const) {
      expect(Object.isFrozen(value), `${what} is frozen`).toBe(true);
    }
  });

  it('when parsing would leave a protected pad button (Up, Down, Left, Right, A, B, Start) with no index, the whole table is PAD_DEFAULT_BINDINGS, the valid custom entries included [gp-5.3]', () => {
    // WRONG IMPL KILLED: a table with a dead D-pad, A, B or Start on the pad (a pad-only player
    // could not move, confirm, back out or open the menu that fixes it), a partial repair that keeps
    // the other custom entries (LB's [10] below), and a repair that only checks invalid entries (in
    // the first case a VALID stored entry is what took A's index).
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['X stores A`s default 0', { buttons: { X: [0], LB: [10] } }],
      ['A is invalid and Y stores its default', { buttons: { A: [16], Y: [0], LB: [10] } }],
      ['the Bag stores B`s default 1', { buttons: { LB: [10] }, accels: { I: [1] } }],
      ['Up stores Down`s default 13', { buttons: { Up: [13], LB: [10] } }],
      ['Start stored empty, Select holds 9', { buttons: { Start: [], Select: [9], LB: [10] } }],
      // Right repeats Left's 14 (invalid), and its own default 15 is LB's stored index.
      ['Right duplicates Left, LB holds 15', { buttons: { Left: [14], Right: [14], LB: [15] } }],
    ];
    for (const [what, raw] of cases) {
      expect(parsePadBindings(raw), what).toEqual(PAD_DEFAULT_BINDINGS);
    }
    // ANTI-VACUITY: LB's entry alone is kept (the reset comes from the protected rule).
    expect(parsePadBindings({ buttons: { LB: [10] } }), 'control').toEqual(padTable({ LB: [10] }));
    // A protected row may give its index away when it is stored with another one.
    expect(
      parsePadBindings({ buttons: { A: [3], Y: [0], LB: [10] } }),
      'control: A and Y traded',
    ).toEqual(padTable({ A: [3], Y: [0], LB: [10] }));
  });

  it('parsePadBindings is total: any value, any JSON and any structured pad value parse, without throwing, to a table whose protected buttons each keep one bindable index, with no index twice and no list over one; loadPadBindings over any stored string likewise [gp-5.1] [gp-5.2] [gp-5.3]', () => {
    // WRONG IMPL KILLED: a parse that throws on null sides, primitives or odd arrays, one that
    // trusts a list's length or its elements, one that lets the reserved 16 or a fractional index
    // through, one that binds an index twice across buttons and accelerators, one that leaves a
    // protected button empty, and one that grows F8 / F9 or unknown keys. The structured arbitrary
    // reaches the per-entry rules, which an arbitrary value almost never does.
    const sane = (raw: unknown): void => {
      expectSanePad(parsePadBindings(raw));
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
    const element = fc.constantFrom<unknown>(
      ...PAD_INDEX_POOL,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '0',
      null,
      true,
    );
    const entryArb = fc.oneof(
      fc.array(fc.integer({ min: 0, max: 17 }), { maxLength: 1 }),
      fc.array(element, { maxLength: 3 }),
      fc.constant(null),
      fc.string(),
      fc.integer(),
    );
    const sideArb = (keys: readonly string[]): fc.Arbitrary<unknown> =>
      fc.oneof(
        fc.dictionary(fc.constantFrom(...keys), entryArb),
        fc.constant(null),
        fc.constant([]),
      );
    const rawArb = fc.oneof(
      fc.record({
        buttons: sideArb([...VBUTTONS, 'Turbo']),
        accels: sideArb([...MENU_ACCEL_IDS, 'F8', 'F9', 'Q']),
      }),
      fc.dictionary(fc.constantFrom(...VBUTTONS), entryArb),
    );
    fc.assert(
      fc.property(rawArb, (raw) => {
        sane(raw);
      }),
    );
    fc.assert(
      fc.property(fc.string(), (text) => {
        expectSanePad(loadPadBindings(memoryStorage({ 'mr.controls': text })));
      }),
    );
    fc.assert(
      fc.property(rawArb, (pad) => {
        expectSanePad(loadPadBindings(recordStorage({ v: 1, buttons: {}, accels: {}, pad })));
      }),
    );
  });

  it('saveBindings(storage, keys, pad) writes {v:1, buttons, accels, pad:{buttons, accels}} under mr.controls in one write and reports true; the pad holds exactly the ten menu accelerators; a refused write or a null storage reports false [gp-5.4]', () => {
    // WRONG IMPL KILLED: a save that drops the pad table (a reload loses every pad remap), one that
    // writes the DEFAULT pad table instead of the one it is given, a flat or wrapped pad shape (the
    // loader reads `pad.buttons` / `pad.accels` only), a pad written under another key, two writes
    // (one per table), and a refused write that throws or reports true.
    const keys: Bindings = {
      buttons: { ...DEFAULT_BINDINGS.buttons, A: ['KeyK', 'NumpadEnter'] },
      accels: { ...DEFAULT_BINDINGS.accels, I: [] },
    };
    const pad = padTable({ A: [3], Y: [0], X: [] }, { I: [], J: [11] });
    const store = memoryStorage();
    expect(saveBindings(store, keys, pad), 'the save reports success').toBe(true);
    expect(store.sets, 'exactly one write').toHaveLength(1);
    const [key, value] = store.sets[0];
    expect(key).toBe('mr.controls');
    const parsed = JSON.parse(value) as Record<string, unknown>;
    expect(parsed).toEqual({
      v: 1,
      buttons: keys.buttons,
      accels: keys.accels,
      pad: { buttons: pad.buttons, accels: pad.accels },
    });
    expect(Object.keys(parsed).sort(), 'the record`s keys').toEqual([
      'accels',
      'buttons',
      'pad',
      'v',
    ]);
    const savedPad = parsed.pad as { buttons: object; accels: object };
    expect(Object.keys(savedPad).sort(), 'the pad`s keys').toEqual(['accels', 'buttons']);
    expect(Object.keys(savedPad.accels).sort(), 'the ten menu accelerators').toEqual(
      [...MENU_ACCEL_IDS].sort(),
    );
    expect(saveBindings(refusingWrite, keys, pad), 'a refused write').toBe(false);
    expect(saveBindings(null, keys, pad), 'a null storage').toBe(false);
  });

  it('a pad remap saved and then a keyboard remap saved (each save carrying the live other table), or the keyboard remap first, loads both remaps from the one record [gp-5.4]', () => {
    // WRONG IMPL KILLED: a load that reads the pad from somewhere the save does not write (the pad
    // remap is lost on reload), a keyboard loader that rejects a record holding `pad`, and a save
    // whose record cannot carry both halves at once.
    const padRemap = padTable({ A: [3], Y: [0] });
    const keyRemap: Bindings = {
      buttons: { ...DEFAULT_BINDINGS.buttons, A: ['KeyK', 'NumpadEnter'] },
      accels: DEFAULT_BINDINGS.accels,
    };
    // Pad first: the keyboard save carries the pad table the first save wrote.
    const padFirst = memoryStorage();
    expect(saveBindings(padFirst, DEFAULT_BINDINGS, padRemap)).toBe(true);
    expect(loadPadBindings(padFirst), 'after the pad save').toEqual(padRemap);
    expect(saveBindings(padFirst, keyRemap, padRemap)).toBe(true);
    expect(loadBindings(padFirst), 'pad first: the keyboard remap').toEqual(keyRemap);
    expect(loadPadBindings(padFirst), 'pad first: the pad remap').toEqual(padRemap);
    // Keys first: the pad save carries the keyboard table.
    const keysFirst = memoryStorage();
    expect(saveBindings(keysFirst, keyRemap, PAD_DEFAULT_BINDINGS)).toBe(true);
    expect(loadPadBindings(keysFirst), 'after the keyboard save').toEqual(PAD_DEFAULT_BINDINGS);
    expect(saveBindings(keysFirst, keyRemap, padRemap)).toBe(true);
    expect(loadBindings(keysFirst), 'keys first: the keyboard remap').toEqual(keyRemap);
    expect(loadPadBindings(keysFirst), 'keys first: the pad remap').toEqual(padRemap);
  });

  it('every pad table a sequence of pad captures reaches survives save then load, and any interleaving of key and pad captures, each saved with the live other table, loads both final tables [gp-5.4]', () => {
    // WRONG IMPL KILLED: a save / parse pair that is not an inverse on the pad tables a player can
    // build (a swap that empties a non-protected row re-defaulted on reload, an emptied accelerator
    // filled again, an index above 15 such as LS 10 refused), a capture that mutates its frozen
    // input (it throws here), and a save of one table that clobbers the other.
    fc.assert(
      fc.property(fc.array(padOpArb(), { maxLength: 40 }), (ops) => {
        let p: PadBindings = PAD_DEFAULT_BINDINGS;
        for (const op of ops) {
          p = deepFreeze(applyPadOp(p, op));
          const store = memoryStorage();
          expect(saveBindings(store, DEFAULT_BINDINGS, p)).toBe(true);
          expect(loadPadBindings(store)).toEqual(p);
          expect(loadBindings(store)).toEqual(DEFAULT_BINDINGS);
        }
      }),
    );
    const mixedOpArb: fc.Arbitrary<Op | PadOp> = fc.oneof(opArb, padOpArb());
    const mixedArb = fc.array(mixedOpArb, { maxLength: 40 });
    fc.assert(
      fc.property(mixedArb, (ops) => {
        const store = memoryStorage();
        let keys: Bindings = DEFAULT_BINDINGS;
        let pad: PadBindings = PAD_DEFAULT_BINDINGS;
        for (const op of ops) {
          if (op.kind === 'pad') pad = deepFreeze(applyPadOp(pad, op));
          else keys = deepFreeze(applyOp(keys, op));
          expect(saveBindings(store, keys, pad)).toBe(true);
        }
        expect(loadBindings(store)).toEqual(keys);
        expect(loadPadBindings(store)).toEqual(pad);
      }),
    );
  });
});
