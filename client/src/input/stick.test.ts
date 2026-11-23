/**
 * stick.test.ts: the left stick as a four-way D-pad direction (pure, node env).
 *
 * `stickToDpad(x, y, prev)` turns one stick reading plus the direction held so far into the
 * next direction. `y < 0` is Up (the W3C axis convention). The hysteresis band is
 * [STICK_EXIT, STICK_ENTER): a held direction survives inside it, a fresh one needs ENTER.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type DpadDir, STICK_ENTER, STICK_EXIT, stickToDpad } from './stick';

const DIRS: readonly DpadDir[] = ['Up', 'Down', 'Left', 'Right'];

/** A stick reading that points `dir` with own-axis magnitude `own` and a signed cross axis. */
function reading(dir: DpadDir, own: number, other: number): { x: number; y: number } {
  switch (dir) {
    case 'Up':
      return { x: other, y: -own };
    case 'Down':
      return { x: other, y: own };
    case 'Left':
      return { x: -own, y: other };
    case 'Right':
      return { x: own, y: other };
  }
}

const finiteOrZero = (v: number): number => (Number.isFinite(v) ? v : 0);

/** The fresh-direction rule from the contract, transcribed for prev = null. */
function freshRule(x: number, y: number): DpadDir | null {
  const nx = finiteOrZero(x);
  const ny = finiteOrZero(y);
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  if (Math.max(ax, ay) < STICK_ENTER) return null;
  if (ax >= ay) return nx > 0 ? 'Right' : 'Left';
  return ny > 0 ? 'Down' : 'Up';
}

const dirArb: fc.Arbitrary<DpadDir> = fc.constantFrom<DpadDir>(...DIRS);

describe('stick thresholds', () => {
  it('enters at 0.5 and exits at 0.35', () => {
    expect(STICK_ENTER).toBe(0.5);
    expect(STICK_EXIT).toBe(0.35);
  });
});

describe('stickToDpad: below the enter threshold', () => {
  it('a centred stick with no prev gives null [gp-1.1]', () => {
    expect(stickToDpad(0, 0, null)).toBeNull();
  });

  it('every reading whose larger magnitude is just under ENTER gives null [gp-1.1]', () => {
    const under = STICK_ENTER - 1e-9;
    expect(stickToDpad(under, 0, null)).toBeNull();
    expect(stickToDpad(-under, 0, null)).toBeNull();
    expect(stickToDpad(0, under, null)).toBeNull();
    expect(stickToDpad(0, -under, null)).toBeNull();
    expect(stickToDpad(under, -under, null)).toBeNull();
  });

  it('a mid-band reading (0.4) never enters a direction from rest [gp-1.1]', () => {
    for (const [x, y] of [
      [0.4, 0],
      [-0.4, 0],
      [0, 0.4],
      [0, -0.4],
    ] as const) {
      expect(stickToDpad(x, y, null)).toBeNull();
    }
  });

  it('non-finite axes read as 0, so they never enter a direction [gp-1.1]', () => {
    expect(stickToDpad(Number.NaN, Number.NaN, null)).toBeNull();
    expect(stickToDpad(Number.POSITIVE_INFINITY, 0, null)).toBeNull();
    expect(stickToDpad(0, Number.NEGATIVE_INFINITY, null)).toBeNull();
    expect(stickToDpad(Number.NaN, 0.2, null)).toBeNull();
  });
});

describe('stickToDpad: entering a direction', () => {
  it('a full push on each axis gives that axis sign direction, y < 0 being Up [gp-1.2]', () => {
    expect(stickToDpad(1, 0, null)).toBe('Right');
    expect(stickToDpad(-1, 0, null)).toBe('Left');
    expect(stickToDpad(0, 1, null)).toBe('Down');
    expect(stickToDpad(0, -1, null)).toBe('Up');
  });

  it('a magnitude of exactly ENTER enters [gp-1.2]', () => {
    expect(stickToDpad(STICK_ENTER, 0, null)).toBe('Right');
    expect(stickToDpad(-STICK_ENTER, 0, null)).toBe('Left');
    expect(stickToDpad(0, STICK_ENTER, null)).toBe('Down');
    expect(stickToDpad(0, -STICK_ENTER, null)).toBe('Up');
  });

  it('the larger axis wins on a diagonal [gp-1.2]', () => {
    expect(stickToDpad(0.9, -0.6, null)).toBe('Right');
    expect(stickToDpad(0.6, -0.9, null)).toBe('Up');
    expect(stickToDpad(-0.6, 0.9, null)).toBe('Down');
    expect(stickToDpad(-0.9, 0.6, null)).toBe('Left');
  });

  it('an exact tie goes to the horizontal axis [gp-1.2]', () => {
    expect(stickToDpad(0.7, 0.7, null)).toBe('Right');
    expect(stickToDpad(-0.7, 0.7, null)).toBe('Left');
    expect(stickToDpad(0.7, -0.7, null)).toBe('Right');
    expect(stickToDpad(-0.7, -0.7, null)).toBe('Left');
    expect(stickToDpad(STICK_ENTER, STICK_ENTER, null)).toBe('Right');
  });

  it('a prev whose axis fell under EXIT gives way to a stronger other axis [gp-1.2]', () => {
    expect(stickToDpad(0.8, -0.2, 'Up')).toBe('Right');
    expect(stickToDpad(-0.2, 0.9, 'Left')).toBe('Down');
  });

  it('matches the contract rule for arbitrary finite readings with no prev [gp-1.2]', () => {
    const axis = fc.double({ min: -1, max: 1, noNaN: true });
    fc.assert(
      fc.property(axis, axis, (x, y) => {
        expect(stickToDpad(x, y, null)).toBe(freshRule(x, y));
      }),
    );
  });
});

describe('stickToDpad: hysteresis', () => {
  it('a held direction survives down to exactly EXIT on its own axis [gp-1.3]', () => {
    expect(stickToDpad(STICK_EXIT, 0, 'Right')).toBe('Right');
    expect(stickToDpad(-STICK_EXIT, 0, 'Left')).toBe('Left');
    expect(stickToDpad(0, STICK_EXIT, 'Down')).toBe('Down');
    expect(stickToDpad(0, -STICK_EXIT, 'Up')).toBe('Up');
  });

  it('a held direction survives a diagonal where the other axis is not larger [gp-1.3]', () => {
    expect(stickToDpad(0.7, -0.7, 'Up')).toBe('Up');
    expect(stickToDpad(0.7, -0.7, 'Right')).toBe('Right');
    expect(stickToDpad(0.5, -0.45, 'Right')).toBe('Right');
    expect(stickToDpad(-0.6, 0.6, 'Down')).toBe('Down');
  });

  it('a non-finite other axis reads 0 and does not break the hold [gp-1.3]', () => {
    expect(stickToDpad(Number.NaN, -0.8, 'Up')).toBe('Up');
    expect(stickToDpad(0.8, Number.POSITIVE_INFINITY, 'Right')).toBe('Right');
  });

  it('keeps prev for arbitrary readings with the own axis at or above EXIT [gp-1.3]', () => {
    fc.assert(
      fc.property(
        dirArb,
        fc.double({ min: STICK_EXIT, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.boolean(),
        (dir, own, frac, negative) => {
          const other = frac * own * (negative ? -1 : 1);
          const r = reading(dir, own, other);
          expect(stickToDpad(r.x, r.y, dir)).toBe(dir);
        },
      ),
    );
  });

  it('a held stick that wobbles inside [EXIT, 1] never changes direction [gp-1.3]', () => {
    const wobble = fc.tuple(
      fc.double({ min: STICK_EXIT, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.boolean(),
    );
    fc.assert(
      fc.property(dirArb, fc.array(wobble, { minLength: 1, maxLength: 40 }), (dir, wobbles) => {
        const start = reading(dir, 1, 0);
        let state = stickToDpad(start.x, start.y, null);
        expect(state).toBe(dir);
        for (const [own, frac, negative] of wobbles) {
          const r = reading(dir, own, frac * own * (negative ? -1 : 1));
          state = stickToDpad(r.x, r.y, state);
          expect(state).toBe(dir);
        }
      }),
    );
  });
});

describe('stickToDpad: a larger other axis breaks the hold', () => {
  it('a stronger cross axis above ENTER takes over from a held direction [gp-1.3]', () => {
    expect(stickToDpad(0.4, 0.9, 'Right')).toBe('Down');
    expect(stickToDpad(-0.6, -0.4, 'Up')).toBe('Left');
    expect(stickToDpad(0.4, 0.9, 'Left')).toBe('Down');
    expect(stickToDpad(0.9, 0.4, 'Down')).toBe('Right');
  });

  it('a larger cross axis below ENTER gives null, not the held direction [gp-1.3]', () => {
    expect(stickToDpad(0.4, 0.45, 'Right')).toBeNull();
    expect(stickToDpad(-0.4, -0.45, 'Left')).toBeNull();
    expect(stickToDpad(0.45, 0.4, 'Down')).toBeNull();
    expect(stickToDpad(0.45, -0.4, 'Up')).toBeNull();
  });

  it('a negative cross axis that is larger also breaks the hold [gp-1.3]', () => {
    expect(stickToDpad(-0.6, -0.4, 'Up')).toBe('Left');
    expect(stickToDpad(0.4, -0.9, 'Right')).toBe('Up');
  });

  it('never returns prev when the other axis exceeds the own signed axis [gp-1.3]', () => {
    const axis = fc.double({ min: -1, max: 1, noNaN: true });
    fc.assert(
      fc.property(dirArb, axis, axis, (dir, own, other) => {
        fc.pre(Math.abs(other) > own);
        const r = reading(dir, own, other);
        expect(stickToDpad(r.x, r.y, dir)).not.toBe(dir);
      }),
    );
  });
});

describe('stickToDpad: releasing', () => {
  it('both axes under EXIT release every held direction [gp-1.4]', () => {
    const under = STICK_EXIT - 1e-9;
    for (const dir of DIRS) {
      expect(stickToDpad(0, 0, dir)).toBeNull();
      expect(stickToDpad(under, under, dir)).toBeNull();
      expect(stickToDpad(-under, under, dir)).toBeNull();
      expect(stickToDpad(under, -under, dir)).toBeNull();
      expect(stickToDpad(-under, -under, dir)).toBeNull();
    }
  });

  it('a non-finite axis with the other under EXIT releases [gp-1.4]', () => {
    expect(stickToDpad(Number.NaN, 0.1, 'Right')).toBeNull();
    expect(stickToDpad(0.1, Number.NaN, 'Up')).toBeNull();
    expect(stickToDpad(Number.POSITIVE_INFINITY, 0.2, 'Left')).toBeNull();
    expect(stickToDpad(0.2, Number.NEGATIVE_INFINITY, 'Down')).toBeNull();
    expect(stickToDpad(Number.NaN, Number.NaN, 'Up')).toBeNull();
  });

  it('a flipped sign on the held axis does not hold prev [gp-1.4]', () => {
    expect(stickToDpad(-0.8, 0, 'Right')).toBe('Left');
    expect(stickToDpad(0, 0.8, 'Up')).toBe('Down');
  });
});
