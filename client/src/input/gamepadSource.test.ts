/**
 * gamepadSource.test.ts: the gamepad input source (stateful shell over an injected `getPads`).
 *
 * Pure, node env: the pads are plain objects the test builds, there is no `navigator` and no
 * clock. The source turns the pads' pressed buttons and left stick into source-agnostic
 * `{button, down}` edges plus menu accelerators. The router counts one holder per down edge
 * and one per up edge, so the tests model it as a per-button counter that must never go
 * negative and must end at zero once everything is released.
 */
import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { type ButtonEdge, VBUTTONS, type VButton } from './buttons';
import { GamepadSource, type GamepadSourceOptions, type PadLike } from './gamepadSource';
import { PAD_DEFAULT_BINDINGS, type PadBindings } from './padBindings';
import type { MenuAccel } from './router';

const BUTTON_COUNT = 40;

interface PadSpec {
  readonly index?: number;
  readonly id?: string;
  readonly connected?: boolean;
  readonly mapping?: string;
  readonly pressed?: readonly number[];
  readonly axes?: readonly number[];
}

/** A fresh pad object with `pressed` indices down and the given axes (default centred). */
function makePad(spec: PadSpec = {}): PadLike {
  const pressed = new Set(spec.pressed ?? []);
  return {
    index: spec.index ?? 0,
    id: spec.id ?? 'pad-a',
    connected: spec.connected ?? true,
    mapping: spec.mapping ?? 'standard',
    buttons: Array.from({ length: BUTTON_COUNT }, (_, i) => ({ pressed: pressed.has(i) })),
    axes: spec.axes ?? [0, 0, 0, 0],
  };
}

const stickPad = (x: number, y: number, spec: PadSpec = {}): PadLike =>
  makePad({ ...spec, axes: [x, y, 0, 0] });

/** A source plus the pads its `getPads` currently returns. */
function rig(bindings?: PadBindings, options?: GamepadSourceOptions) {
  let pads: readonly (PadLike | null)[] = [];
  const source = new GamepadSource(() => pads, bindings, options);
  return {
    source,
    poll(next: readonly (PadLike | null)[]) {
      pads = next;
      return source.poll();
    },
  };
}

const down = (button: VButton): ButtonEdge => ({ button, down: true });
const up = (button: VButton): ButtonEdge => ({ button, down: false });

/** Order-free view of a poll's edges, for the places no order is promised. */
const keys = (edges: readonly ButtonEdge[]): string[] =>
  edges.map((e) => `${e.button}:${e.down ? 'down' : 'up'}`).sort();

/** The router as the tests see it: one holder per down edge, one per up edge. */
type Counter = Map<VButton, number>;

function apply(counter: Counter, edges: readonly ButtonEdge[]): void {
  for (const e of edges) {
    const next = (counter.get(e.button) ?? 0) + (e.down ? 1 : -1);
    expect(next).toBeGreaterThanOrEqual(0);
    counter.set(e.button, next);
  }
}

function expectAllZero(counter: Counter): void {
  for (const b of VBUTTONS) {
    expect(counter.get(b) ?? 0).toBe(0);
  }
}

const NONE = { edges: [], accels: [] };

describe('GamepadSource: bound buttons', () => {
  it('one down edge when a bound button goes down, one up edge when it comes back [gp-1.5]', () => {
    const r = rig();
    expect(r.poll([makePad()])).toEqual(NONE);
    expect(r.poll([makePad({ pressed: [0] })])).toEqual({ edges: [down('A')], accels: [] });
    expect(r.poll([makePad()])).toEqual({ edges: [up('A')], accels: [] });
    expect(r.poll([makePad()])).toEqual(NONE);
  });

  it('every default-bound index emits its own virtual button down then up [gp-1.5]', () => {
    for (const b of VBUTTONS) {
      for (const i of PAD_DEFAULT_BINDINGS.buttons[b]) {
        const r = rig();
        expect(r.poll([makePad({ pressed: [i] })]).edges).toEqual([down(b)]);
        expect(r.poll([makePad()]).edges).toEqual([up(b)]);
      }
    }
  });

  it('the same pad object mutated in place still gives one down and one up [gp-1.5]', () => {
    const buttons: { pressed: boolean }[] = Array.from({ length: BUTTON_COUNT }, () => ({
      pressed: false,
    }));
    const pads = [{ ...makePad(), buttons }];
    const r = rig();
    expect(r.poll(pads)).toEqual(NONE);
    buttons[1] = { pressed: true };
    expect(r.poll(pads)).toEqual({ edges: [down('B')], accels: [] });
    buttons[1] = { pressed: false };
    expect(r.poll(pads)).toEqual({ edges: [up('B')], accels: [] });
  });

  it('the same button object mutated in place still gives one down and one up [gp-1.5]', () => {
    const button = { pressed: false };
    const buttons: { pressed: boolean }[] = [{ pressed: false }, { pressed: false }, button];
    const pads = [{ ...makePad(), buttons }];
    const r = rig();
    expect(r.poll(pads)).toEqual(NONE);
    button.pressed = true;
    expect(r.poll(pads)).toEqual({ edges: [down('X')], accels: [] });
    button.pressed = false;
    expect(r.poll(pads)).toEqual({ edges: [up('X')], accels: [] });
  });

  it('a pressed button stays quiet for as long as it is held [gp-1.6]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [3] })]).edges).toEqual([down('Y')]);
    for (let n = 0; n < 5; n++) {
      expect(r.poll([makePad({ pressed: [3] })])).toEqual(NONE);
    }
    expect(r.poll([makePad()]).edges).toEqual([up('Y')]);
  });

  it('a second button pressed while the first is held emits only its own edge [gp-1.6]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [0] })]).edges).toEqual([down('A')]);
    expect(r.poll([makePad({ pressed: [0, 1] })]).edges).toEqual([down('B')]);
    expect(r.poll([makePad({ pressed: [0, 1] })])).toEqual(NONE);
    expect(r.poll([makePad({ pressed: [1] })]).edges).toEqual([up('A')]);
  });

  it('several buttons pressed in one poll come out in ascending index order [gp-1.5]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [5, 0, 12] })]).edges).toEqual([
      down('A'),
      down('RB'),
      down('Up'),
    ]);
  });
});

describe('GamepadSource: the left stick', () => {
  it('a push from centre emits that direction down, y < 0 being Up [gp-1.7]', () => {
    const cases: readonly (readonly [number, number, VButton])[] = [
      [1, 0, 'Right'],
      [-1, 0, 'Left'],
      [0, 1, 'Down'],
      [0, -1, 'Up'],
    ];
    for (const [x, y, dir] of cases) {
      const r = rig();
      expect(r.poll([stickPad(0, 0)])).toEqual(NONE);
      expect(r.poll([stickPad(x, y)])).toEqual({ edges: [down(dir)], accels: [] });
    }
  });

  it('a held direction emits nothing more, even while it wobbles in the band [gp-1.7]', () => {
    const r = rig();
    expect(r.poll([stickPad(1, 0)]).edges).toEqual([down('Right')]);
    expect(r.poll([stickPad(1, 0)])).toEqual(NONE);
    expect(r.poll([stickPad(0.4, 0.3)])).toEqual(NONE);
    expect(r.poll([stickPad(0.9, -0.2)])).toEqual(NONE);
  });

  it('one direction to another emits the old up before the new down [gp-1.7]', () => {
    const r = rig();
    expect(r.poll([stickPad(1, 0)]).edges).toEqual([down('Right')]);
    expect(r.poll([stickPad(0, -1)]).edges).toEqual([up('Right'), down('Up')]);
    expect(r.poll([stickPad(-1, 0)]).edges).toEqual([up('Up'), down('Left')]);
  });

  it('back to centre emits the last direction up [gp-1.7]', () => {
    const r = rig();
    expect(r.poll([stickPad(0, 1)]).edges).toEqual([down('Down')]);
    expect(r.poll([stickPad(0, 0)])).toEqual({ edges: [up('Down')], accels: [] });
    expect(r.poll([stickPad(0, 0)])).toEqual(NONE);
  });

  it('a stick that falls just under EXIT releases, one just over holds [gp-1.7]', () => {
    const r = rig();
    expect(r.poll([stickPad(1, 0)]).edges).toEqual([down('Right')]);
    expect(r.poll([stickPad(0.36, 0)])).toEqual(NONE);
    expect(r.poll([stickPad(0.34, 0)]).edges).toEqual([up('Right')]);
  });

  it('any sequence of stick readings that ends at centre leaves nothing held [gp-1.7]', () => {
    const odd = fc.constantFrom(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2,
      -2,
      1e9,
      -1e9,
      0.35,
      0.5,
      -0.5,
      1,
      -1,
      0,
    );
    const axis = fc.oneof(fc.double({ min: -1, max: 1, noNaN: true }), odd);
    const readings = fc.array(fc.tuple(axis, axis), { maxLength: 60 });
    fc.assert(
      fc.property(readings, (seq) => {
        const r = rig();
        const counter: Counter = new Map();
        for (const [x, y] of [...seq, [0, 0] as const]) {
          apply(counter, r.poll([stickPad(x, y)]).edges);
        }
        expectAllZero(counter);
      }),
    );
  });
});

describe('GamepadSource: the stick and the D-pad button are separate holders', () => {
  it('releasing the D-pad button first emits one Up up, releasing the stick the second [gp-1.8]', () => {
    const r = rig();
    const first = r.poll([stickPad(0, -1, { pressed: [12] })]);
    expect(keys(first.edges)).toEqual(['Up:down', 'Up:down']);
    expect(r.poll([stickPad(0, -1)]).edges).toEqual([up('Up')]);
    expect(r.poll([stickPad(0, 0)]).edges).toEqual([up('Up')]);
  });

  it('releasing the stick first emits one Up up, releasing the D-pad button the second [gp-1.8]', () => {
    const r = rig();
    const first = r.poll([stickPad(0, -1, { pressed: [12] })]);
    expect(keys(first.edges)).toEqual(['Up:down', 'Up:down']);
    expect(r.poll([stickPad(0, 0, { pressed: [12] })]).edges).toEqual([up('Up')]);
    expect(r.poll([stickPad(0, 0)]).edges).toEqual([up('Up')]);
  });

  it('each release leaves the router count at the number of holders still down [gp-1.8]', () => {
    const r = rig();
    const counter: Counter = new Map();
    apply(counter, r.poll([stickPad(1, 0, { pressed: [15] })]).edges);
    expect(counter.get('Right')).toBe(2);
    apply(counter, r.poll([stickPad(1, 0)]).edges);
    expect(counter.get('Right')).toBe(1);
    apply(counter, r.poll([stickPad(0, 0)]).edges);
    expect(counter.get('Right')).toBe(0);
  });
});

describe('GamepadSource: pads without the standard mapping', () => {
  it('axes 0 and 1 resting at -1 emit no edge [gp-1.9]', () => {
    const r = rig();
    for (let n = 0; n < 3; n++) {
      expect(r.poll([stickPad(-1, -1, { mapping: '' })])).toEqual(NONE);
    }
    expect(r.poll([stickPad(1, 1, { mapping: 'xr-standard' })])).toEqual(NONE);
  });

  it('its buttons still read, only the stick is ignored [gp-1.9]', () => {
    const r = rig();
    expect(r.poll([stickPad(-1, -1, { mapping: '', pressed: [0] })]).edges).toEqual([down('A')]);
    expect(r.poll([stickPad(-1, -1, { mapping: '' })]).edges).toEqual([up('A')]);
  });

  it('a pad whose mapping stops being standard releases its held direction [gp-1.9]', () => {
    const r = rig();
    expect(r.poll([stickPad(1, 0)]).edges).toEqual([down('Right')]);
    expect(r.poll([stickPad(1, 0, { mapping: '' })]).edges).toEqual([up('Right')]);
    expect(r.poll([stickPad(1, 0, { mapping: '' })])).toEqual(NONE);
  });
});

describe('GamepadSource: a pad that goes away', () => {
  it('disappearing from getPads releases every held button and the stick [gp-1.10]', () => {
    const r = rig();
    const first = r.poll([stickPad(1, 0, { pressed: [0, 13] })]);
    expect(keys(first.edges)).toEqual(['A:down', 'Down:down', 'Right:down']);
    const gone = r.poll([]);
    expect(keys(gone.edges)).toEqual(['A:up', 'Down:up', 'Right:up']);
    expect(gone.accels).toEqual([]);
    expect(r.poll([])).toEqual(NONE);
  });

  it('a null slot reads as a pad that disappeared [gp-1.10]', () => {
    const r = rig();
    r.poll([null, makePad({ index: 1, pressed: [2] })]);
    expect(r.poll([null, null]).edges).toEqual([up('X')]);
  });

  it('reporting connected: false releases everything the pad held [gp-1.10]', () => {
    const r = rig();
    const first = r.poll([stickPad(0, -1, { pressed: [1, 4] })]);
    expect(keys(first.edges)).toEqual(['B:down', 'LB:down', 'Up:down']);
    const off = r.poll([stickPad(0, -1, { pressed: [1, 4], connected: false })]);
    expect(keys(off.edges)).toEqual(['B:up', 'LB:up', 'Up:up']);
    expect(r.poll([stickPad(0, -1, { pressed: [1, 4], connected: false })])).toEqual(NONE);
  });

  it('a pad with another id in the same slot is a disconnect plus a connect [gp-1.10]', () => {
    const r = rig();
    r.poll([stickPad(1, 0, { id: 'first', pressed: [0] })]);
    const swapped = r.poll([makePad({ id: 'second' })]);
    expect(keys(swapped.edges)).toEqual(['A:up', 'Right:up']);
    expect(r.poll([makePad({ id: 'second' })])).toEqual(NONE);
  });

  it('the pad that replaces it starts fresh, its held buttons are new presses [gp-1.10]', () => {
    const r = rig();
    r.poll([makePad({ id: 'first', pressed: [0] })]);
    const swapped = r.poll([makePad({ id: 'second', pressed: [0] })]);
    expect(swapped.edges).toEqual([up('A'), down('A')]);
    expect(r.poll([makePad({ id: 'second' })]).edges).toEqual([up('A')]);
  });

  it('a pad that comes back while a button is still down presses it anew [gp-1.10]', () => {
    const r = rig();
    r.poll([makePad({ pressed: [0] })]);
    expect(r.poll([]).edges).toEqual([up('A')]);
    expect(r.poll([makePad({ pressed: [0] })]).edges).toEqual([down('A')]);
  });

  it('the vanished pad ups come before another pad downs in the same poll [gp-1.10]', () => {
    const r = rig();
    r.poll([makePad({ index: 0, pressed: [0] })]);
    const next = r.poll([null, makePad({ index: 1, id: 'pad-b', pressed: [1] })]);
    expect(next.edges).toEqual([up('A'), down('B')]);
  });

  it('a pad whose buttons list is missing releases what it held without throwing [gp-1.10]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [12] })]).edges).toEqual([down('Up')]);
    const broken = { ...makePad(), buttons: undefined as unknown as PadLike['buttons'] };
    expect(r.poll([broken]).edges).toEqual([up('Up')]);
    expect(r.poll([broken])).toEqual(NONE);
    expect(r.poll([makePad()])).toEqual(NONE);
  });

  it('a pad that held nothing emits nothing when it goes away [gp-1.10]', () => {
    const r = rig();
    r.poll([makePad()]);
    expect(r.poll([])).toEqual(NONE);
  });
});

describe('GamepadSource: releaseAll and rebind latch what is held', () => {
  it('releaseAll emits nothing, and a held button stays silent until pressed again [gp-1.11]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [0] })]).edges).toEqual([down('A')]);
    r.source.releaseAll();
    expect(r.poll([makePad({ pressed: [0] })])).toEqual(NONE);
    expect(r.poll([makePad()])).toEqual(NONE);
    expect(r.poll([makePad({ pressed: [0] })]).edges).toEqual([down('A')]);
    expect(r.poll([makePad()]).edges).toEqual([up('A')]);
  });

  it('releaseAll leaves a held stick silent until it centres and pushes again [gp-1.11]', () => {
    const r = rig();
    expect(r.poll([stickPad(1, 0)]).edges).toEqual([down('Right')]);
    r.source.releaseAll();
    expect(r.poll([stickPad(1, 0)])).toEqual(NONE);
    expect(r.poll([stickPad(0, 0)])).toEqual(NONE);
    expect(r.poll([stickPad(1, 0)]).edges).toEqual([down('Right')]);
    expect(r.poll([stickPad(0, 0)]).edges).toEqual([up('Right')]);
  });

  it('a latched stick stays silent across a direction change until it centres [gp-1.11]', () => {
    const r = rig();
    expect(r.poll([stickPad(1, 0)]).edges).toEqual([down('Right')]);
    r.source.releaseAll();
    expect(r.poll([stickPad(0, -1)])).toEqual(NONE);
    expect(r.poll([stickPad(1, 0)])).toEqual(NONE);
    expect(r.poll([stickPad(0, 0)])).toEqual(NONE);
    expect(r.poll([stickPad(0, 1)]).edges).toEqual([down('Down')]);
    expect(r.poll([stickPad(0, 0)]).edges).toEqual([up('Down')]);
  });

  it('releaseAll with several buttons and the stick held silences them all [gp-1.11]', () => {
    const r = rig();
    r.poll([stickPad(0, 1, { pressed: [0, 1, 12] })]);
    r.source.releaseAll();
    expect(r.poll([stickPad(0, 1, { pressed: [0, 1, 12] })])).toEqual(NONE);
    expect(r.poll([stickPad(0, 0, { pressed: [1] })])).toEqual(NONE);
    expect(r.poll([stickPad(0, 0)])).toEqual(NONE);
  });

  it('releaseAll on a source that holds nothing changes nothing [gp-1.11]', () => {
    const r = rig();
    r.source.releaseAll();
    expect(r.poll([makePad({ pressed: [0] })]).edges).toEqual([down('A')]);
  });

  it('rebind emits nothing, and a held button stays silent until pressed again [gp-1.11]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [0] })]).edges).toEqual([down('A')]);
    r.source.rebind(PAD_DEFAULT_BINDINGS);
    expect(r.poll([makePad({ pressed: [0] })])).toEqual(NONE);
    expect(r.poll([makePad()])).toEqual(NONE);
    expect(r.poll([makePad({ pressed: [0] })]).edges).toEqual([down('A')]);
  });

  it('rebind leaves a held stick silent until it centres and pushes again [gp-1.11]', () => {
    const r = rig();
    expect(r.poll([stickPad(0, -1)]).edges).toEqual([down('Up')]);
    r.source.rebind(PAD_DEFAULT_BINDINGS);
    expect(r.poll([stickPad(0, -1)])).toEqual(NONE);
    expect(r.poll([stickPad(0, 0)])).toEqual(NONE);
    expect(r.poll([stickPad(0, -1)]).edges).toEqual([down('Up')]);
  });

  it('rebind to a table that no longer binds the held index still emits nothing [gp-1.11]', () => {
    const r = rig();
    r.poll([makePad({ pressed: [0] })]);
    r.source.rebind({
      buttons: { ...PAD_DEFAULT_BINDINGS.buttons, A: [20] },
      accels: PAD_DEFAULT_BINDINGS.accels,
    });
    expect(r.poll([makePad({ pressed: [0] })])).toEqual(NONE);
    expect(r.poll([makePad()])).toEqual(NONE);
  });

  it('rebind switches the table that later presses resolve through', () => {
    const r = rig();
    r.source.rebind({
      buttons: { ...PAD_DEFAULT_BINDINGS.buttons, A: [20] },
      accels: PAD_DEFAULT_BINDINGS.accels,
    });
    expect(r.poll([makePad({ pressed: [20] })]).edges).toEqual([down('A')]);
    expect(r.poll([makePad({ pressed: [20, 0] })])).toEqual(NONE);
  });

  it('a table passed to the constructor is the one in force', () => {
    const r = rig({
      buttons: { ...PAD_DEFAULT_BINDINGS.buttons, B: [21] },
      accels: PAD_DEFAULT_BINDINGS.accels,
    });
    expect(r.poll([makePad({ pressed: [21] })]).edges).toEqual([down('B')]);
    expect(r.poll([makePad({ pressed: [21, 1] })])).toEqual(NONE);
  });
});

describe('GamepadSource: capture', () => {
  it('a pressed index is captured once and later polls stay silent for it [gp-1.11]', () => {
    const state = { pads: [makePad()] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    expect(source.poll()).toEqual(NONE);
    state.pads = [makePad({ pressed: [2] })];
    expect(source.capture()).toBe(2);
    expect(source.capture()).toBeUndefined();
    expect(source.poll()).toEqual(NONE);
    state.pads = [makePad()];
    expect(source.poll()).toEqual(NONE);
    state.pads = [makePad({ pressed: [2] })];
    expect(source.poll().edges).toEqual([down('X')]);
  });

  it('a captured accelerator index reports no accelerator afterwards [gp-1.11]', () => {
    const state = { pads: [makePad()] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    source.poll();
    state.pads = [makePad({ pressed: [6] })];
    expect(source.capture()).toBe(6);
    expect(source.poll()).toEqual(NONE);
  });

  it('answers refused for the reserved index and for one out of range [gp-1.11]', () => {
    for (const i of [16, 32, 35]) {
      const state = { pads: [makePad()] as readonly (PadLike | null)[] };
      const source = new GamepadSource(() => state.pads);
      source.poll();
      state.pads = [makePad({ pressed: [i] })];
      expect(source.capture()).toBe('refused');
      expect(source.capture()).toBeUndefined();
      expect(source.poll()).toEqual(NONE);
    }
  });

  it('answers the lowest bindable index when several are newly pressed [gp-1.11]', () => {
    const state = { pads: [makePad()] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    source.poll();
    state.pads = [makePad({ pressed: [9, 16, 4, 11] })];
    expect(source.capture()).toBe(4);
  });

  it('answers the lowest bindable index across two pads [gp-1.11]', () => {
    const state = { pads: [makePad()] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    source.poll();
    state.pads = [
      makePad({ index: 0, id: 'a', pressed: [7] }),
      makePad({ index: 1, id: 'b', pressed: [3] }),
    ];
    expect(source.capture()).toBe(3);
  });

  it('prefers a bindable index over a refused one pressed in the same poll [gp-1.11]', () => {
    const state = { pads: [makePad()] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    source.poll();
    state.pads = [makePad({ pressed: [16, 10] })];
    expect(source.capture()).toBe(10);
  });

  it('answers undefined when nothing is newly pressed [gp-1.11]', () => {
    const state = { pads: [makePad()] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    expect(source.capture()).toBeUndefined();
    state.pads = [stickPad(1, 0)];
    expect(source.capture()).toBeUndefined();
  });

  it('a button released during capture still owes its up edge to the next poll [gp-1.11]', () => {
    const state = { pads: [makePad({ pressed: [0] })] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    expect(source.poll().edges).toEqual([down('A')]);
    state.pads = [makePad()];
    expect(source.capture()).toBeUndefined();
    expect(source.poll()).toEqual({ edges: [up('A')], accels: [] });
    expect(source.poll()).toEqual(NONE);
  });

  it('a held button is not newly pressed, so capture does not return it [gp-1.11]', () => {
    const state = { pads: [makePad({ pressed: [0] })] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    source.poll();
    expect(source.capture()).toBeUndefined();
    state.pads = [makePad()];
    expect(source.poll().edges).toEqual([up('A')]);
  });

  it('queued ups come before the edges of the poll that emits them [gp-1.11]', () => {
    const state = { pads: [makePad({ pressed: [0] })] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    source.poll();
    state.pads = [makePad()];
    source.capture();
    state.pads = [makePad({ pressed: [1] })];
    expect(source.poll().edges).toEqual([up('A'), down('B')]);
  });

  it('a stick released during capture still owes its up edge to the next poll [gp-1.11]', () => {
    const state = { pads: [stickPad(1, 0)] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    expect(source.poll().edges).toEqual([down('Right')]);
    state.pads = [stickPad(0, 0)];
    expect(source.capture()).toBeUndefined();
    expect(source.poll().edges).toEqual([up('Right')]);
    expect(source.poll()).toEqual(NONE);
  });

  it('a pad that vanishes during capture still owes its ups to the next poll [gp-1.11]', () => {
    const state = { pads: [stickPad(1, 0, { pressed: [0] })] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    source.poll();
    state.pads = [];
    expect(source.capture()).toBeUndefined();
    expect(keys(source.poll().edges)).toEqual(['A:up', 'Right:up']);
    expect(source.poll()).toEqual(NONE);
  });

  it('releaseAll drops the ups a capture queued, so the next poll is silent [gp-1.11]', () => {
    const state = { pads: [makePad({ pressed: [12] })] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    expect(source.poll().edges).toEqual([down('Up')]);
    state.pads = [makePad()];
    expect(source.capture()).toBeUndefined();
    source.releaseAll();
    expect(source.poll()).toEqual(NONE);
    expect(source.poll()).toEqual(NONE);
  });

  it('rebind drops the ups a capture queued, so the next poll is silent [gp-1.11]', () => {
    const state = { pads: [makePad({ pressed: [12] })] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    expect(source.poll().edges).toEqual([down('Up')]);
    state.pads = [makePad()];
    expect(source.capture()).toBeUndefined();
    source.rebind(PAD_DEFAULT_BINDINGS);
    expect(source.poll()).toEqual(NONE);
    expect(source.poll()).toEqual(NONE);
  });

  it('a direction first reached during capture is latched until centre [gp-1.11]', () => {
    const state = { pads: [stickPad(0, 0)] as readonly (PadLike | null)[] };
    const source = new GamepadSource(() => state.pads);
    source.poll();
    state.pads = [stickPad(1, 0)];
    expect(source.capture()).toBeUndefined();
    expect(source.poll()).toEqual(NONE);
    state.pads = [stickPad(0, 1)];
    expect(source.poll()).toEqual(NONE);
    state.pads = [stickPad(0, 0)];
    expect(source.poll()).toEqual(NONE);
    state.pads = [stickPad(1, 0)];
    expect(source.poll().edges).toEqual([down('Right')]);
  });
});

describe('GamepadSource: accelerators', () => {
  it('a button bound to an accelerator reports it once and emits no button edge [gp-1.12]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [6] })])).toEqual({ edges: [], accels: ['V'] });
    expect(r.poll([makePad({ pressed: [6] })])).toEqual(NONE);
    expect(r.poll([makePad()])).toEqual(NONE);
    expect(r.poll([makePad({ pressed: [6] })])).toEqual({ edges: [], accels: ['V'] });
  });

  it('the second default accelerator is I on index 7 [gp-1.12]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [7] })])).toEqual({ edges: [], accels: ['I'] });
  });

  it('an accelerator and a button pressed together each report on their own channel [gp-1.12]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [0, 6] })])).toEqual({
      edges: [down('A')],
      accels: ['V'],
    });
  });

  it('two accelerators pressed in one poll are both reported [gp-1.12]', () => {
    const r = rig();
    const got = r.poll([makePad({ pressed: [6, 7] })]);
    expect([...got.accels].sort()).toEqual(['I', 'V']);
    expect(got.edges).toEqual([]);
  });

  it('an index bound to both an accelerator and a button gives only the accelerator [gp-1.12]', () => {
    const accel: MenuAccel = 'N';
    const r = rig({
      buttons: { ...PAD_DEFAULT_BINDINGS.buttons, A: [25] },
      accels: { ...PAD_DEFAULT_BINDINGS.accels, [accel]: [25] },
    });
    expect(r.poll([makePad({ pressed: [25] })])).toEqual({ edges: [], accels: ['N'] });
    expect(r.poll([makePad()])).toEqual(NONE);
  });

  it('a rebound accelerator index reports the accelerator, the old one goes quiet [gp-1.12]', () => {
    const r = rig();
    r.source.rebind({
      buttons: PAD_DEFAULT_BINDINGS.buttons,
      accels: { ...PAD_DEFAULT_BINDINGS.accels, V: [], P: [6] },
    });
    expect(r.poll([makePad({ pressed: [6] })])).toEqual({ edges: [], accels: ['P'] });
  });
});

describe('GamepadSource: unbound and reserved indices', () => {
  it('a pressed unbound index emits nothing, down or up [gp-1.13]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [10] })])).toEqual(NONE);
    expect(r.poll([makePad({ pressed: [10, 11, 17] })])).toEqual(NONE);
    expect(r.poll([makePad()])).toEqual(NONE);
  });

  it('the reserved index 16 emits nothing, down or up [gp-1.13]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [16] })])).toEqual(NONE);
    expect(r.poll([makePad({ pressed: [16] })])).toEqual(NONE);
    expect(r.poll([makePad()])).toEqual(NONE);
  });

  it('a hand-built table that binds 16 to a button still emits nothing for it [gp-1.13]', () => {
    const r = rig({
      buttons: { ...PAD_DEFAULT_BINDINGS.buttons, Y: [16] },
      accels: PAD_DEFAULT_BINDINGS.accels,
    });
    expect(r.poll([makePad({ pressed: [16] })])).toEqual(NONE);
    expect(r.poll([makePad()])).toEqual(NONE);
  });

  it('a hand-built table that binds 16 to an accelerator reports nothing [gp-1.13]', () => {
    const r = rig({
      buttons: PAD_DEFAULT_BINDINGS.buttons,
      accels: { ...PAD_DEFAULT_BINDINGS.accels, J: [16] },
    });
    expect(r.poll([makePad({ pressed: [16] })])).toEqual(NONE);
  });

  it('a bound button next to an unbound one still emits its own edge [gp-1.13]', () => {
    const r = rig();
    expect(r.poll([makePad({ pressed: [10, 0, 16] })]).edges).toEqual([down('A')]);
    expect(r.poll([makePad({ pressed: [10, 16] })]).edges).toEqual([up('A')]);
  });
});

describe('GamepadSource: two pads', () => {
  it('both holding the same button gives one down and one up edge per pad [gp-1.14]', () => {
    const r = rig();
    const a = (pressed: readonly number[]) => makePad({ index: 0, id: 'a', pressed });
    const b = (pressed: readonly number[]) => makePad({ index: 1, id: 'b', pressed });
    expect(r.poll([a([0]), b([])]).edges).toEqual([down('A')]);
    expect(r.poll([a([0]), b([0])]).edges).toEqual([down('A')]);
    expect(r.poll([a([]), b([0])]).edges).toEqual([up('A')]);
    expect(r.poll([a([]), b([])]).edges).toEqual([up('A')]);
  });

  it('both pressing the same button in one poll gives two downs [gp-1.14]', () => {
    const r = rig();
    const first = r.poll([
      makePad({ index: 0, id: 'a', pressed: [0] }),
      makePad({ index: 1, id: 'b', pressed: [0] }),
    ]);
    expect(first.edges).toEqual([down('A'), down('A')]);
    const both = r.poll([makePad({ index: 0, id: 'a' }), makePad({ index: 1, id: 'b' })]);
    expect(both.edges).toEqual([up('A'), up('A')]);
  });

  it('two sticks pushed the same way give a down each and an up each [gp-1.14]', () => {
    const r = rig();
    const counter: Counter = new Map();
    apply(
      counter,
      r.poll([stickPad(1, 0, { index: 0, id: 'a' }), stickPad(1, 0, { index: 1, id: 'b' })]).edges,
    );
    expect(counter.get('Right')).toBe(2);
    apply(
      counter,
      r.poll([stickPad(1, 0, { index: 0, id: 'a' }), stickPad(0, 0, { index: 1, id: 'b' })]).edges,
    );
    expect(counter.get('Right')).toBe(1);
    apply(
      counter,
      r.poll([stickPad(0, 0, { index: 0, id: 'a' }), stickPad(0, 0, { index: 1, id: 'b' })]).edges,
    );
    expect(counter.get('Right')).toBe(0);
  });

  it('one pad disconnecting leaves the other pad hold in force [gp-1.14]', () => {
    const r = rig();
    const counter: Counter = new Map();
    apply(
      counter,
      r.poll([
        makePad({ index: 0, id: 'a', pressed: [0] }),
        makePad({ index: 1, id: 'b', pressed: [0] }),
      ]).edges,
    );
    apply(counter, r.poll([null, makePad({ index: 1, id: 'b', pressed: [0] })]).edges);
    expect(counter.get('A')).toBe(1);
    apply(counter, r.poll([null, makePad({ index: 1, id: 'b' })]).edges);
    expect(counter.get('A')).toBe(0);
  });

  it('balanced edges: any history of pads, buttons and sticks ends at zero [gp-1.14]', () => {
    interface Slot {
      present: boolean;
      connected: boolean;
      gen: number;
      pressed: Set<number>;
      x: number;
      y: number;
    }
    type Step =
      | { readonly kind: 'press' | 'release'; readonly slot: number; readonly idx: number }
      | { readonly kind: 'stick'; readonly slot: number; readonly x: number; readonly y: number }
      | { readonly kind: 'drop' | 'disconnect' | 'restore' | 'swap'; readonly slot: number }
      | { readonly kind: 'releaseAll' };

    const slotArb = fc.integer({ min: 0, max: 2 });
    const idxArb = fc.integer({ min: 0, max: 17 });
    const axisArb = fc.oneof(
      fc.double({ min: -1, max: 1, noNaN: true }),
      fc.constantFrom(
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        2,
        -2,
        0,
        1,
        -1,
      ),
    );
    const stepArb: fc.Arbitrary<Step> = fc.oneof(
      fc.tuple(slotArb, idxArb).map(([slot, idx]): Step => ({ kind: 'press', slot, idx })),
      fc.tuple(slotArb, idxArb).map(([slot, idx]): Step => ({ kind: 'release', slot, idx })),
      fc
        .tuple(slotArb, axisArb, axisArb)
        .map(([slot, x, y]): Step => ({ kind: 'stick', slot, x, y })),
      slotArb.map((slot): Step => ({ kind: 'drop', slot })),
      slotArb.map((slot): Step => ({ kind: 'disconnect', slot })),
      slotArb.map((slot): Step => ({ kind: 'restore', slot })),
      slotArb.map((slot): Step => ({ kind: 'swap', slot })),
      fc.constant<Step>({ kind: 'releaseAll' }),
    );

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.tuple(stepArb, fc.boolean()), { maxLength: 80 }),
        (n, steps) => {
          const slots: Slot[] = Array.from({ length: n }, () => ({
            present: true,
            connected: true,
            gen: 0,
            pressed: new Set<number>(),
            x: 0,
            y: 0,
          }));
          let pads: readonly (PadLike | null)[] = [];
          const source = new GamepadSource(() => pads);
          const counter: Counter = new Map();
          const snapshot = (): (PadLike | null)[] =>
            slots.map((s, index) =>
              s.present
                ? makePad({
                    index,
                    id: `pad-${index}-${s.gen}`,
                    connected: s.connected,
                    pressed: [...s.pressed],
                    axes: [s.x, s.y, 0, 0],
                  })
                : null,
            );
          const pollInto = (): void => {
            pads = snapshot();
            apply(counter, source.poll().edges);
          };

          pollInto();
          // A step flagged `viaCapture` shows the new pad state to capture() instead of poll():
          // capture emits nothing itself, and the ups it owes come out of the next poll.
          for (const [step, viaCapture] of steps) {
            if (step.kind === 'releaseAll') {
              source.releaseAll();
              counter.clear();
            } else {
              const s = slots[step.slot % n];
              if (s === undefined) throw new Error('slot out of range');
              if (step.kind === 'press') s.pressed.add(step.idx);
              else if (step.kind === 'release') s.pressed.delete(step.idx);
              else if (step.kind === 'stick') {
                s.x = step.x;
                s.y = step.y;
              } else if (step.kind === 'drop') s.present = false;
              else if (step.kind === 'disconnect') s.connected = false;
              else if (step.kind === 'restore') {
                s.present = true;
                s.connected = true;
              } else s.gen += 1;
            }
            if (viaCapture && step.kind !== 'releaseAll') {
              pads = snapshot();
              source.capture();
            } else {
              pollInto();
            }
          }

          for (const s of slots) {
            s.present = true;
            s.connected = true;
            s.pressed.clear();
            s.x = 0;
            s.y = 0;
          }
          pollInto();
          expectAllZero(counter);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('GamepadSource: getPads that throws', () => {
  it('returns no edges every poll and calls onError exactly once [gp-1.15]', () => {
    const failure = new Error('the pad API threw');
    const onError = vi.fn();
    const source = new GamepadSource(
      () => {
        throw failure;
      },
      undefined,
      { onError },
    );
    for (let n = 0; n < 4; n++) {
      expect(source.poll()).toEqual(NONE);
    }
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('a getPads result that is not a list reads as no pads and is reported once [gp-1.15]', () => {
    const onError = vi.fn();
    const source = new GamepadSource(
      () => undefined as unknown as readonly (PadLike | null)[],
      undefined,
      { onError },
    );
    for (let n = 0; n < 4; n++) {
      expect(source.poll()).toEqual(NONE);
    }
    expect(source.capture()).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('an array-like getPads result is read as its entries', () => {
    const list = { length: 1, 0: makePad({ pressed: [0] }) } as unknown as readonly PadLike[];
    const source = new GamepadSource(() => list);
    expect(source.poll().edges).toEqual([down('A')]);
  });

  it('with no onError option the poll still returns nothing and does not throw [gp-1.15]', () => {
    const source = new GamepadSource(() => {
      throw new Error('the pad API threw');
    });
    expect(source.poll()).toEqual(NONE);
    expect(source.poll()).toEqual(NONE);
  });

  it('an onError that itself throws never makes poll throw [gp-1.15]', () => {
    const onError = vi.fn(() => {
      throw new Error('the reporter threw');
    });
    const source = new GamepadSource(
      () => {
        throw new Error('the pad API threw');
      },
      undefined,
      { onError },
    );
    expect(source.poll()).toEqual(NONE);
    expect(source.poll()).toEqual(NONE);
    expect(source.poll()).toEqual(NONE);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a throw after good polls reads as no pads, releasing what was held [gp-1.15]', () => {
    const onError = vi.fn();
    let failing = false;
    let pads: readonly (PadLike | null)[] = [stickPad(1, 0, { pressed: [0] })];
    const source = new GamepadSource(
      () => {
        if (failing) throw new Error('the pad API threw');
        return pads;
      },
      undefined,
      { onError },
    );
    expect(keys(source.poll().edges)).toEqual(['A:down', 'Right:down']);
    failing = true;
    expect(keys(source.poll().edges)).toEqual(['A:up', 'Right:up']);
    expect(source.poll()).toEqual(NONE);
    expect(onError).toHaveBeenCalledTimes(1);
    failing = false;
    pads = [makePad({ pressed: [1] })];
    expect(source.poll().edges).toEqual([down('B')]);
  });

  it('a failure reported once is not reported again by a later failure [gp-1.15]', () => {
    const onError = vi.fn();
    let failing = true;
    const source = new GamepadSource(
      () => {
        if (failing) throw new Error('the pad API threw');
        return [makePad()];
      },
      undefined,
      { onError },
    );
    source.poll();
    failing = false;
    source.poll();
    failing = true;
    source.poll();
    source.poll();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('GamepadSource: pads with fewer buttons or axes than expected', () => {
  it('a pad with no buttons and no axes reads as idle and does not throw', () => {
    const bare: PadLike = {
      index: 0,
      id: 'bare',
      connected: true,
      mapping: 'standard',
      buttons: [],
      axes: [],
    };
    const r = rig();
    expect(r.poll([bare])).toEqual(NONE);
    expect(r.poll([bare])).toEqual(NONE);
  });

  it('a missing y axis reads as 0, so the x axis alone still steers', () => {
    const oneAxis: PadLike = { ...makePad(), axes: [1] };
    const r = rig();
    expect(r.poll([oneAxis]).edges).toEqual([down('Right')]);
    expect(r.poll([{ ...makePad(), axes: [] }]).edges).toEqual([up('Right')]);
  });

  it('a missing x axis reads as 0, so the y axis alone still steers', () => {
    const r = rig();
    const yOnly: PadLike = { ...makePad(), axes: [undefined as unknown as number, -1] };
    expect(r.poll([yOnly]).edges).toEqual([down('Up')]);
  });

  it('a pad with fewer buttons than the bound indices emits for the ones it has', () => {
    const small: PadLike = { ...makePad(), buttons: [{ pressed: true }, { pressed: false }] };
    const r = rig();
    expect(r.poll([small]).edges).toEqual([down('A')]);
    expect(r.poll([{ ...small, buttons: [{ pressed: false }] }]).edges).toEqual([up('A')]);
  });

  it('a sparse buttons array reads its holes as not pressed', () => {
    const sparse: { pressed: boolean }[] = [];
    sparse[3] = { pressed: true };
    const r = rig();
    expect(r.poll([{ ...makePad(), buttons: sparse }]).edges).toEqual([down('Y')]);
  });

  it('a null button entry reads as not pressed', () => {
    const withNull = [{ pressed: true }, null, { pressed: true }] as unknown as readonly {
      pressed: boolean;
    }[];
    const r = rig();
    expect(r.poll([{ ...makePad(), buttons: withNull }]).edges).toEqual([down('A'), down('X')]);
    expect(r.poll([{ ...makePad(), buttons: [] }]).edges).toEqual([up('A'), up('X')]);
  });
});
