// stick.ts — reads an analog stick as a D-pad direction, with a deadzone and hysteresis, so a
// pad's left stick drives the same four virtual buttons the D-pad does. Pure: the caller keeps
// the previous direction and passes it back in.

/** The magnitude an axis needs to start a direction. */
export const STICK_ENTER = 0.5;
/** The least own-axis magnitude that keeps a held direction (below `STICK_ENTER`, so a stick
 *  resting near the deadzone edge does not flicker). */
export const STICK_EXIT = 0.35;

export type DpadDir = 'Up' | 'Down' | 'Left' | 'Right';

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

/** `dir`'s own axis, signed so that pushing towards `dir` is positive, and the other axis. */
function ownAxis(dir: DpadDir, x: number, y: number): { own: number; other: number } {
  switch (dir) {
    case 'Right':
      return { own: x, other: y };
    case 'Left':
      return { own: -x, other: y };
    case 'Down':
      return { own: y, other: x };
    case 'Up':
      return { own: -y, other: x };
  }
}

/** The D-pad direction the stick at (`x`, `y`) holds, given the direction it held last read
 *  (`prev`). The W3C axis convention: `x > 0` is Right, `y < 0` is Up. A non-finite axis reads 0.
 *  `prev` holds while its own axis, in its own sign, is at least `STICK_EXIT` and the other axis's
 *  magnitude is not larger; otherwise the larger-magnitude axis gives the direction when it is at
 *  least `STICK_ENTER` (an exact tie goes to the horizontal axis); otherwise null. */
export function stickToDpad(x: number, y: number, prev: DpadDir | null): DpadDir | null {
  const fx = finite(x);
  const fy = finite(y);
  if (prev !== null) {
    const { own, other } = ownAxis(prev, fx, fy);
    if (own >= STICK_EXIT && Math.abs(other) <= own) return prev;
  }
  const ax = Math.abs(fx);
  const ay = Math.abs(fy);
  if (ax >= ay) {
    if (ax < STICK_ENTER) return null;
    return fx > 0 ? 'Right' : 'Left';
  }
  if (ay < STICK_ENTER) return null;
  return fy > 0 ? 'Down' : 'Up';
}
