/**
 * router.test.ts: ownership + the input router (ctl-1, CTL1.1 / CTL1.2 / CTL1.4 / CTL1.5).
 *
 * Pure, node env. `ownership(target, event)` decides who owns a native key (the focused
 * field/button, or the router); `InputRouter` turns `{button, down}` edges into movement
 * effects with a per-button refcount, so two physical holders of one direction release it
 * only when the last lets go. Targets are plain objects read structurally (tagName,
 * isContentEditable), so no DOM is involved.
 *
 * The contract: every D-pad press is counted and consumed (starting the direction only at
 * the world), only the last release of a direction ends it, X jumps once per press at the
 * world, every other button is left alone, and any source's edges route identically.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WasmDirection } from '../convert/convert';
import { type ButtonEdge, VBUTTONS, type VButton } from './buttons';
import { KeyboardSource } from './keyboardSource';
import {
  InputRouter,
  ownership,
  type RouteContext,
  type RouterEffect,
  routerConsumes,
} from './router';

const WORLD: RouteContext = { worldActive: true };
const GATED: RouteContext = { worldActive: false };

const edge = (button: VButton, isDown: boolean): ButtonEdge => ({ button, down: isDown });
const DIRS: ReadonlyArray<readonly [VButton, WasmDirection]> = [
  ['Up', 'North'],
  ['Down', 'South'],
  ['Left', 'West'],
  ['Right', 'East'],
];
const dirDown = (dir: WasmDirection): RouterEffect => ({ kind: 'dirDown', dir });
const dirUp = (dir: WasmDirection): RouterEffect => ({ kind: 'dirUp', dir });

const ALL_CODES = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'Backspace',
  'Escape',
  'Enter',
  'NumpadEnter',
  'KeyP',
  'KeyZ',
  'Tab',
  'F9',
];

/** Targets nobody but the router cares about. */
const ROUTER_TARGETS: ReadonlyArray<readonly [string, unknown]> = [
  ['window-like', { addEventListener: () => undefined, document: {} }],
  ['empty object', {}],
  ['null', null],
  ['undefined', undefined],
  ['body', { tagName: 'BODY' }],
  ['canvas', { tagName: 'CANVAS' }],
  ['div', { tagName: 'DIV', isContentEditable: false }],
  ['number', 7],
];

const FIELD_TARGETS: ReadonlyArray<readonly [string, unknown]> = [
  ['input', { tagName: 'INPUT' }],
  ['textarea', { tagName: 'TEXTAREA' }],
  ['select', { tagName: 'SELECT' }],
  ['contentEditable', { tagName: 'DIV', isContentEditable: true }],
];

const NATIVE_ACTIVATORS: ReadonlyArray<readonly [string, unknown]> = [
  ['button', { tagName: 'BUTTON' }],
  ['anchor', { tagName: 'A' }],
];

describe('ownership(target, event)', () => {
  it('CTL1-4-OWNERSHIP: the router owns the world, a field owns every key but Escape/Enter, a native button owns Space/Enter, a composition owns everything', () => {
    // WRONG IMPL KILLED: Space exempted everywhere (a focused button never activates, or
    // the world never jumps), a field that lets W through (typing "w" walks the character),
    // a field that swallows Escape/Enter (typing mode can never end), a button that owns
    // arrows (the page-scroll fix is lost), and an IME that is ignored (composition is
    // eaten by hotkeys).
    for (const [label, target] of ROUTER_TARGETS) {
      for (const code of ALL_CODES) {
        expect(ownership(target, { code }), `${label} / ${code}`).toBe('router');
      }
    }

    for (const [label, target] of FIELD_TARGETS) {
      for (const code of ['KeyW', 'Space', 'ArrowUp', 'Backspace', 'KeyP', 'KeyA', 'ArrowLeft']) {
        expect(ownership(target, { code }), `${label} / ${code}`).toBe('target');
      }
      for (const code of ['Escape', 'Enter', 'NumpadEnter']) {
        expect(ownership(target, { code }), `${label} / ${code}`).toBe('router');
      }
    }

    for (const [label, target] of NATIVE_ACTIVATORS) {
      for (const code of ['Space', 'Enter', 'NumpadEnter']) {
        expect(ownership(target, { code }), `${label} / ${code}`).toBe('target');
      }
      for (const code of ['KeyW', 'ArrowUp', 'Backspace', 'Escape', 'KeyP', 'ArrowDown']) {
        expect(ownership(target, { code }), `${label} / ${code}`).toBe('router');
      }
    }

    // An IME composition owns every key, Escape and Enter included, on every target kind.
    const everyTarget = [...ROUTER_TARGETS, ...FIELD_TARGETS, ...NATIVE_ACTIVATORS];
    for (const [label, target] of everyTarget) {
      for (const code of ALL_CODES) {
        expect(ownership(target, { code, isComposing: true }), `${label} / ${code} composing`).toBe(
          'target',
        );
        expect(ownership(target, { code, keyCode: 229 }), `${label} / ${code} keyCode 229`).toBe(
          'target',
        );
      }
    }
    // The negations: a falsy flag and an ordinary keyCode do not claim the key.
    for (const code of ALL_CODES) {
      expect(ownership({}, { code, isComposing: false, keyCode: 87 }), code).toBe('router');
    }
  });
});

describe('routerConsumes(button)', () => {
  it('is true for the D-pad and X, false for every other virtual button', () => {
    const consumed = new Set<VButton>(['Up', 'Down', 'Left', 'Right', 'X']);
    for (const b of VBUTTONS) {
      expect(routerConsumes(b), b).toBe(consumed.has(b));
    }
  });
});

describe('InputRouter', () => {
  it('CTL1-1-ROUTER-DPAD: a D-pad down is consumed and starts its direction at the world; gated, it is consumed and starts nothing', () => {
    // WRONG IMPL KILLED: a direction mapped to the wrong compass point, a gated press that
    // still steps (movement under an overlay), a gated press that is left unconsumed (the
    // page scrolls under the overlay), and a gated press that is not counted (its keyup
    // would then underflow instead of releasing).
    for (const [button, dir] of DIRS) {
      const r = new InputRouter();
      expect(r.route(edge(button, true), WORLD), `${button} down`).toEqual({
        consumed: true,
        effects: [dirDown(dir)],
      });
      expect(r.route(edge(button, false), WORLD), `${button} up`).toEqual({
        consumed: true,
        effects: [dirUp(dir)],
      });

      const gated = new InputRouter();
      expect(gated.route(edge(button, true), GATED), `${button} down, gated`).toEqual({
        consumed: true,
        effects: [],
      });
      // The press was counted, so releasing it releases the direction (the shell's held
      // set may hold it from before the gate closed).
      expect(
        gated.route(edge(button, false), WORLD).effects,
        `${button} up after gated down`,
      ).toEqual([dirUp(dir)]);
    }

    // An up edge is routed whatever the gate says: a release is never lost to an overlay.
    const r = new InputRouter();
    r.route(edge('Left', true), WORLD);
    expect(r.route(edge('Left', false), GATED).effects).toEqual([dirUp('West')]);

    // Directions are independent of one another.
    const multi = new InputRouter();
    multi.route(edge('Up', true), WORLD);
    expect(multi.route(edge('Left', true), WORLD).effects).toEqual([dirDown('West')]);
    expect(multi.route(edge('Left', false), WORLD).effects).toEqual([dirUp('West')]);
    expect(multi.route(edge('Up', false), WORLD).effects).toEqual([dirUp('North')]);
  });

  it('CTL1-1-ROUTER-JUMP: X down at the world is exactly one jump; X up releases nothing; a gated X jumps nothing', () => {
    // WRONG IMPL KILLED: a jump on the up edge too (two jumps per press), a jump while an
    // overlay is open, and X leaving the router unconsumed (Space scrolls the page).
    const r = new InputRouter();
    expect(r.route(edge('X', true), WORLD)).toEqual({
      consumed: true,
      effects: [{ kind: 'jump' }],
    });
    expect(r.route(edge('X', false), WORLD).effects).toEqual([]);
    expect(r.route(edge('X', false), GATED).effects).toEqual([]);

    const gated = new InputRouter();
    const down = gated.route(edge('X', true), GATED);
    expect(down.effects).toEqual([]);
    expect(down.consumed).toBe(true);
    expect(gated.route(edge('X', false), GATED).effects).toEqual([]);

    // Each press jumps once, so a second press jumps again.
    const again = new InputRouter();
    again.route(edge('X', true), WORLD);
    again.route(edge('X', false), WORLD);
    expect(again.route(edge('X', true), WORLD).effects).toEqual([{ kind: 'jump' }]);
  });

  it('leaves every other button unconsumed with no effect, down or up, gated or not', () => {
    const consumed = new Set<VButton>(['Up', 'Down', 'Left', 'Right', 'X']);
    for (const b of VBUTTONS) {
      if (consumed.has(b)) continue;
      const r = new InputRouter();
      for (const ctx of [WORLD, GATED]) {
        for (const isDown of [true, false]) {
          expect(r.route(edge(b, isDown), ctx), `${b} ${isDown ? 'down' : 'up'}`).toEqual({
            consumed: false,
            effects: [],
          });
        }
      }
    }
  });

  it('CTL1-2-ROUTER-REFCOUNT: two holders of a direction release it exactly once, when the last one lets go, over any interleaving', () => {
    // WRONG IMPL KILLED: a router that releases on the first up (the W/ArrowUp defect), one
    // that releases on every up, one that never releases, one whose count underflows (an
    // up with no holder poisons the next press), and one that tracks holders as a boolean.
    const step = fc.record({ source: fc.integer({ min: 0, max: 1 }), world: fc.boolean() });
    fc.assert(
      fc.property(
        fc.array(step, { minLength: 1, maxLength: 60 }),
        fc.constantFrom(...DIRS),
        (steps, [button, dir]) => {
          const router = new InputRouter();
          const holding = [false, false];
          let downs = 0;
          let ups = 0;
          for (const s of steps) {
            const before = holding[0] || holding[1];
            const isDown = !holding[s.source];
            holding[s.source] = isDown;
            const after = holding[0] || holding[1];
            const ctx = { worldActive: s.world };
            const res = router.route(edge(button, isDown), ctx);
            expect(res.consumed).toBe(true);
            if (isDown) {
              // never a release on a press; the world may start the direction, a gate may not.
              expect(res.effects.every((e) => e.kind === 'dirDown')).toBe(true);
              expect(res.effects.length).toBeLessThanOrEqual(1);
              if (!s.world) expect(res.effects).toEqual([]);
              if (s.world && !before) expect(res.effects).toEqual([dirDown(dir)]);
              for (const e of res.effects) if (e.kind === 'dirDown') expect(e.dir).toBe(dir);
              downs += 1;
            } else if (after) {
              // another holder remains: the direction stays held.
              expect(res.effects, 'first release while the other key is down').toEqual([]);
            } else {
              expect(res.effects, 'last release').toEqual([dirUp(dir)]);
              ups += 1;
            }
          }
          // Drain whoever still holds: each drained holder ends the sequence with one release
          // in total, so releases never exceed the 0 -> held transitions.
          for (const source of [0, 1]) {
            if (!holding[source]) continue;
            holding[source] = false;
            const res = router.route(edge(button, false), WORLD);
            if (!(holding[0] || holding[1])) {
              expect(res.effects).toEqual([dirUp(dir)]);
              ups += 1;
            } else {
              expect(res.effects).toEqual([]);
            }
          }
          expect(ups).toBeGreaterThan(0);
          expect(downs).toBeGreaterThan(0);
          // Fully released: a further up is inert.
          expect(router.route(edge(button, false), WORLD).effects).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('keeps the direction held across a two-key overlap, the exact W + ArrowUp scenario', () => {
    const r = new InputRouter();
    expect(r.route(edge('Up', true), WORLD).effects).toEqual([dirDown('North')]); // W
    r.route(edge('Up', true), WORLD); // ArrowUp
    expect(r.route(edge('Up', false), WORLD).effects, 'ArrowUp released').toEqual([]);
    expect(r.route(edge('Up', false), WORLD).effects, 'W released').toEqual([dirUp('North')]);
  });

  it('a D-pad press at the world while the direction is already counted still starts it', () => {
    // WRONG IMPL KILLED: a router that emits dirDown only on the 0 to 1 transition. The
    // shell clears its held set when an overlay opens while the physical key stays down, so
    // the next key of that direction must be able to start the walk again.
    const r = new InputRouter();
    expect(r.route(edge('Up', true), WORLD).effects).toEqual([dirDown('North')]);
    expect(r.route(edge('Up', true), WORLD).effects).toEqual([dirDown('North')]);
    expect(r.route(edge('Up', true), WORLD).effects).toEqual([dirDown('North')]);
    // Three holders: two releases keep it, the third ends it.
    expect(r.route(edge('Up', false), WORLD).effects).toEqual([]);
    expect(r.route(edge('Up', false), WORLD).effects).toEqual([]);
    expect(r.route(edge('Up', false), WORLD).effects).toEqual([dirUp('North')]);
  });

  it('an up with no holder emits nothing, never underflows, and a later press still starts the direction', () => {
    const r = new InputRouter();
    expect(r.route(edge('Right', false), WORLD)).toEqual({ consumed: true, effects: [] });
    expect(r.route(edge('Right', false), WORLD).effects).toEqual([]);
    expect(r.route(edge('Right', true), WORLD).effects).toEqual([dirDown('East')]);
    // One real holder, after two stray ups: a single up must release it (a negative count
    // would need two).
    expect(r.route(edge('Right', false), WORLD).effects).toEqual([dirUp('East')]);
  });

  it('releaseAll emits one release per held direction, resets the counts, and is idempotent', () => {
    const r = new InputRouter();
    expect(r.releaseAll(), 'nothing held').toEqual([]);

    r.route(edge('Up', true), WORLD);
    r.route(edge('Up', true), WORLD); // two holders of North
    r.route(edge('Left', true), GATED); // a gated press is held too
    r.route(edge('Down', true), WORLD);
    r.route(edge('Down', false), WORLD); // Down already released: not reported
    const released = r.releaseAll();
    const sorted = (xs: readonly RouterEffect[]) =>
      [...xs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(sorted(released)).toEqual(sorted([dirUp('North'), dirUp('West')]));

    // Counts were reset: a late physical up is inert, and a new press starts from zero.
    expect(r.route(edge('Up', false), WORLD).effects).toEqual([]);
    expect(r.route(edge('Up', false), WORLD).effects).toEqual([]);
    expect(r.route(edge('Up', true), WORLD).effects).toEqual([dirDown('North')]);
    expect(r.route(edge('Up', false), WORLD).effects, 'a single up releases after a reset').toEqual(
      [dirUp('North')],
    );
    expect(r.releaseAll()).toEqual([]);
  });

  it('CTL1-5-FAKE-SOURCE: a non-keyboard source emitting Down press/release routes to the same outcome as KeyS, and shares the refcount', () => {
    // WRONG IMPL KILLED: a router that reads keyboard fields (code, key) instead of the
    // virtual button, one with a keyboard-only fast path, and a per-source refcount (a pad
    // Down and a key S would then each release the direction on their own).
    const fakePad = (): readonly ButtonEdge[] => [
      { button: 'Down', down: true },
      { button: 'Down', down: false },
    ];
    const drive = (edges: readonly ButtonEdge[]) => {
      const router = new InputRouter();
      return edges.map((e) => router.route(e, WORLD));
    };

    const keyboard = new KeyboardSource();
    const viaKeyboard = drive([
      ...keyboard.keydown({ code: 'KeyS' }),
      ...keyboard.keyup({ code: 'KeyS' }),
    ]);
    const viaPad = drive(fakePad());
    expect(viaPad).toEqual(viaKeyboard);
    expect(viaPad).toEqual([
      { consumed: true, effects: [dirDown('South')] },
      { consumed: true, effects: [dirUp('South')] },
    ]);

    // X from a pad is the same jump as Space from the keyboard.
    const padJump = new InputRouter().route({ button: 'X', down: true }, WORLD);
    const keyJump = new InputRouter().route(
      new KeyboardSource().keydown({ code: 'Space' })[0],
      WORLD,
    );
    expect(padJump).toEqual(keyJump);
    expect(padJump.effects).toEqual([{ kind: 'jump' }]);

    // One router, two kinds of source: the direction is released by the LAST holder.
    const shared = new InputRouter();
    const kb = new KeyboardSource();
    for (const e of kb.keydown({ code: 'KeyS' })) shared.route(e, WORLD);
    expect(shared.route({ button: 'Down', down: true }, WORLD).consumed).toBe(true); // pad press
    expect(
      shared.route({ button: 'Down', down: false }, WORLD).effects,
      'pad released first',
    ).toEqual([]);
    const lastRelease = kb.keyup({ code: 'KeyS' }).map((e) => shared.route(e, WORLD));
    expect(lastRelease).toEqual([{ consumed: true, effects: [dirUp('South')] }]);
  });
});

// ==========================================================================================
// ctl-5: the router drives a nav frame (the main menu): fresh nav edges, B pops a covered
// frame, and `tick(ctx)` synthesizes D-pad repeat edges on the injected clock.
//
// `ctx.nav` is present while a nav frame is on the stack; `covered` means a legacy frame sits
// above it. Times are plain numbers (no clock is read), and every case presses at a NON-ZERO
// `now` so a repeat schedule that forgets the press time (`nextAt = 350`) cannot pass.
// ==========================================================================================

/** A menu is up (worldActive false); `covered` = a legacy frame sits above it. */
const navCtx = (now: number, covered = false): RouteContext => ({
  worldActive: false,
  nav: { covered, now },
});
const navEffect = (button: VButton, repeat: boolean): RouterEffect => ({
  kind: 'nav',
  input: { button, repeat },
});
const POP: RouterEffect = { kind: 'pop' };

describe('InputRouter under a nav frame (ctl-5)', () => {
  it('CTL5-2-ROUTER-NAV-BUTTONS: with an uncovered nav frame the D-pad, A, B and Y presses are consumed as fresh nav inputs and their releases carry no nav effect; Start and Select stay with the ladder; no nav ctx leaves A, B and Y alone', () => {
    // WRONG IMPL KILLED: a router that never emits nav (the menu has no driver), one that tags a
    // press as a repeat, one that emits a nav effect on the up edge too (a press moves twice), A,
    // B or Y left unconsumed under the menu (they fall through to the ladder), Start or Select
    // swallowed (the Escape ladder dies), a D-pad press that still walks, a D-pad release that is
    // lost (the held count would leak), and A, B or Y consumed with no nav frame (they would
    // stop reaching the legacy overlays).
    for (const button of ['Up', 'Down', 'Left', 'Right', 'A', 'B', 'Y'] as const) {
      const r = new InputRouter();
      expect(r.route(edge(button, true), navCtx(1000)), `${button} down`).toEqual({
        consumed: true,
        effects: [navEffect(button, false)],
      });
    }

    for (const button of ['A', 'B', 'Y'] as const) {
      const r = new InputRouter();
      r.route(edge(button, true), navCtx(1000));
      expect(r.route(edge(button, false), navCtx(1100)), `${button} up`).toEqual({
        consumed: true,
        effects: [],
      });
    }

    // D-pad: the release is counted exactly as before (the shell's held set must be able to
    // release), and it is never a nav effect.
    const dpad = new InputRouter();
    dpad.route(edge('Down', true), navCtx(1000));
    dpad.route(edge('Down', true), navCtx(1005)); // a second key of the same button
    const first = dpad.route(edge('Down', false), navCtx(1100));
    expect(first.consumed).toBe(true);
    expect(first.effects, 'one holder remains').toEqual([]);
    expect(dpad.route(edge('Down', false), navCtx(1110))).toEqual({
      consumed: true,
      effects: [dirUp('South')],
    });

    for (const button of ['Start', 'Select', 'LB', 'RB'] as const) {
      const r = new InputRouter();
      for (const isDown of [true, false]) {
        expect(r.route(edge(button, isDown), navCtx(1000)), `${button}`).toEqual({
          consumed: false,
          effects: [],
        });
      }
    }

    // X is the world's: under a menu it is swallowed and jumps nothing.
    expect(new InputRouter().route(edge('X', true), navCtx(1000))).toEqual({
      consumed: true,
      effects: [],
    });

    // Contrast: with no nav ctx A, B and Y are exactly today's unconsumed buttons.
    for (const button of ['A', 'B', 'Y'] as const) {
      expect(new InputRouter().route(edge(button, true), GATED), `${button} without nav`).toEqual({
        consumed: false,
        effects: [],
      });
      expect(new InputRouter().route(edge(button, true), WORLD), `${button} at world`).toEqual({
        consumed: false,
        effects: [],
      });
    }
  });

  it('CTL5-2-ROUTER-B-POPS-COVERED: B down under a covered nav frame is one consumed pop; A and Y stay unconsumed; a B the target owns (a text field) routes nothing and so never pops', () => {
    // WRONG IMPL KILLED: a covered B that does nothing (B could never leave a child), one that
    // pops on the up edge as well (two pops per press), a pop emitted from an uncovered frame
    // (B at the menu root must navigate, not pop), a covered A/Y that is consumed (the legacy
    // child's native Enter would die), a covered D-pad press that navigates the hidden menu, and
    // a Backspace typed into a text field that pops the screen it is typed in.
    const r = new InputRouter();
    expect(r.route(edge('B', true), navCtx(1000, true))).toEqual({
      consumed: true,
      effects: [POP],
    });
    expect(
      r.route(edge('B', false), navCtx(1050, true)).effects,
      'the release pops nothing',
    ).toEqual([]);
    expect(r.route(edge('B', true), navCtx(1100, true)).effects, 'every press is one pop').toEqual([
      POP,
    ]);

    for (const button of ['A', 'Y'] as const) {
      expect(new InputRouter().route(edge(button, true), navCtx(1000, true)), button).toEqual({
        consumed: false,
        effects: [],
      });
    }

    const covered = new InputRouter();
    const dpad = covered.route(edge('Down', true), navCtx(1000, true));
    expect(dpad.consumed, 'the D-pad is still swallowed (no page scroll)').toBe(true);
    expect(
      dpad.effects.some((e) => e.kind === 'nav' || e.kind === 'pop'),
      'a covered D-pad press drives nothing in the hidden menu',
    ).toBe(false);

    expect(
      new InputRouter().route(edge('B', true), navCtx(1000, false)).effects,
      'uncovered, B is a nav input, not a pop',
    ).toEqual([navEffect('B', false)]);
    expect(
      new InputRouter().route(edge('B', true), GATED).effects,
      'with no nav frame there is nothing to pop',
    ).toEqual([]);

    // Ownership: Backspace typed into a field yields no edge, so the router never sees a B.
    const typed = new KeyboardSource().keydown({ code: 'Backspace', target: { tagName: 'INPUT' } });
    expect(typed, 'the field owns Backspace').toEqual([]);
    const typedRouter = new InputRouter();
    expect(typed.flatMap((e) => typedRouter.route(e, navCtx(1000, true)).effects)).toEqual([]);
    // Control: the same key at the page pops.
    const atPage = new KeyboardSource().keydown({ code: 'Backspace', target: { tagName: 'DIV' } });
    const pageRouter = new InputRouter();
    expect(atPage.flatMap((e) => pageRouter.route(e, navCtx(1000, true)).effects)).toEqual([POP]);
  });

  it('CTL5-5-REPEAT-350-100: a held D-pad button yields one repeat edge 350 ms after the press, then one every 100 ms, at any press time; a stalled clock yields one edge, never a burst', () => {
    // WRONG IMPL KILLED: a schedule anchored at 0 instead of the press time, a first repeat at
    // 349 or 351, an interval of 99 or 101, drift (`nextAt = now + 100` on a coarse tick makes the
    // 17th repeat late), a burst that replays every missed interval after a stalled frame, two
    // edges for one due time, a repeat flagged `repeat: false` (the list would wrap instead of
    // clamping), and the wrong button on the repeat.
    for (const [button] of DIRS) {
      const r = new InputRouter();
      expect(r.route(edge(button, true), navCtx(1000)).effects).toEqual([navEffect(button, false)]);
      expect(r.tick(navCtx(1000)), 'nothing at the press').toEqual([]);
      expect(r.tick(navCtx(1349)), `${button} 349 ms`).toEqual([]);
      expect(r.tick(navCtx(1350)), `${button} 350 ms`).toEqual([navEffect(button, true)]);
      expect(r.tick(navCtx(1350)), 'one edge per due time').toEqual([]);
      expect(r.tick(navCtx(1449)), `${button} 449 ms`).toEqual([]);
      expect(r.tick(navCtx(1450)), `${button} 450 ms`).toEqual([navEffect(button, true)]);
      expect(r.tick(navCtx(1549))).toEqual([]);
      expect(r.tick(navCtx(1550))).toEqual([navEffect(button, true)]);
    }

    // The schedule is anchored at the press time, whatever it is (fractional included).
    const late = new InputRouter();
    late.route(edge('Up', true), navCtx(98765.5));
    expect(late.tick(navCtx(98765.5 + 349))).toEqual([]);
    expect(late.tick(navCtx(98765.5 + 350))).toEqual([navEffect('Up', true)]);

    // No drift on a coarse tick: 17 repeats in the two seconds after a press at 5000, ticking
    // every 7 ms (due 5350, 5450, ..., 6950).
    const coarse = new InputRouter();
    coarse.route(edge('Down', true), navCtx(5000));
    let repeats = 0;
    for (let t = 5000; t <= 7000; t += 7) {
      repeats += coarse.tick(navCtx(t)).length;
    }
    expect(repeats, 'the schedule is exact: 350 then every 100').toBe(17);

    // A stalled frame (1000 ms after the press) yields exactly one edge; the next is due 100 ms
    // after the stalled tick.
    const stall = new InputRouter();
    stall.route(edge('Down', true), navCtx(1000));
    expect(stall.tick(navCtx(2000)), 'one edge, not nine').toEqual([navEffect('Down', true)]);
    expect(stall.tick(navCtx(2000))).toEqual([]);
    expect(stall.tick(navCtx(2099))).toEqual([]);
    expect(stall.tick(navCtx(2100))).toEqual([navEffect('Down', true)]);
  });

  it('CTL5-5-REPEAT-RESET: releasing the armed button, a reset, a release-all or a newer press changes what repeats; a reset key that is still held stays silent', () => {
    // WRONG IMPL KILLED: a repeat that outlives its key (a stuck cursor), a resetRepeat that
    // leaves the key armed (a held key repeats into the NEW frame after a push or pop), one that
    // re-arms itself on the next tick, a reset that also forgets the holder count (the later
    // release would then emit nothing), a release-all that leaves a repeat armed, a newer press
    // that does not take over the repeat, a release of an UNarmed button that disarms the armed
    // one, and a release of one of two holders that disarms early.
    const released = new InputRouter();
    released.route(edge('Down', true), navCtx(1000));
    released.route(edge('Down', false), navCtx(1100));
    expect(released.tick(navCtx(1350)), 'released before the first repeat').toEqual([]);
    expect(released.tick(navCtx(5000))).toEqual([]);

    const reset = new InputRouter();
    reset.route(edge('Down', true), navCtx(1000));
    expect(reset.tick(navCtx(1350))).toEqual([navEffect('Down', true)]);
    reset.resetRepeat();
    for (let t = 1351; t <= 2350; t += 50) {
      expect(reset.tick(navCtx(t)), `silent after a reset (t=${t})`).toEqual([]);
    }
    // The hold was not forgotten: its release is still reported, and a fresh press repeats again.
    expect(reset.route(edge('Down', false), navCtx(2400)).effects).toEqual([dirUp('South')]);
    reset.route(edge('Down', true), navCtx(3000));
    expect(reset.tick(navCtx(3349))).toEqual([]);
    expect(reset.tick(navCtx(3350))).toEqual([navEffect('Down', true)]);

    const all = new InputRouter();
    all.route(edge('Up', true), navCtx(1000));
    all.releaseAll();
    expect(all.tick(navCtx(1350)), 'releaseAll disarms').toEqual([]);
    expect(all.tick(navCtx(9000))).toEqual([]);

    // A newer D-pad press takes over: only the newer button repeats, from ITS press time.
    const takeover = new InputRouter();
    takeover.route(edge('Down', true), navCtx(1000));
    takeover.route(edge('Up', true), navCtx(1200));
    expect(takeover.tick(navCtx(1350)), 'the older button no longer repeats').toEqual([]);
    expect(takeover.tick(navCtx(1549))).toEqual([]);
    expect(takeover.tick(navCtx(1550))).toEqual([navEffect('Up', true)]);
    // Releasing the repeating (newest) button hands the repeat to the most recently pressed button
    // that is STILL held (here Down), re-armed at the RELEASE time + 350 ms, then every 100. (The
    // bug this fixes: hold Down, tap Up, keep holding Down -> Down never repeated again.)
    // WRONG IMPL KILLED: a release that just disarms, a hand-over anchored at the old press time
    // (Down's 1000 -> due 1350) or at the repeating button's schedule, an immediate first repeat,
    // and a hand-over to the oldest rather than the newest held button.
    takeover.route(edge('Up', false), navCtx(1600));
    expect(takeover.tick(navCtx(1700)), 'not due until release + 350').toEqual([]);
    expect(takeover.tick(navCtx(1949))).toEqual([]);
    expect(takeover.tick(navCtx(1950))).toEqual([navEffect('Down', true)]);
    expect(takeover.tick(navCtx(1950)), 'one edge per due time').toEqual([]);
    expect(takeover.tick(navCtx(2049))).toEqual([]);
    expect(takeover.tick(navCtx(2050))).toEqual([navEffect('Down', true)]);
    // With no button left held, nothing repeats.
    takeover.route(edge('Down', false), navCtx(2100));
    expect(takeover.tick(navCtx(2500))).toEqual([]);
    expect(takeover.tick(navCtx(9000))).toEqual([]);

    // Three held: the hand-over goes to the most recent still-held button, not the oldest.
    const three = new InputRouter();
    three.route(edge('Down', true), navCtx(1000));
    three.route(edge('Left', true), navCtx(1100));
    three.route(edge('Up', true), navCtx(1200));
    three.route(edge('Up', false), navCtx(1300));
    expect(three.tick(navCtx(1649))).toEqual([]);
    expect(three.tick(navCtx(1650)), 'Left (newer than Down) repeats').toEqual([
      navEffect('Left', true),
    ]);

    // A release under a covered nav frame, or with no nav ctx, disarms: no re-arm.
    for (const [label, releaseCtx] of [
      ['covered', navCtx(1600, true)],
      ['no nav ctx', WORLD],
    ] as const) {
      const r = new InputRouter();
      r.route(edge('Down', true), navCtx(1000));
      r.route(edge('Up', true), navCtx(1200));
      r.route(edge('Up', false), releaseCtx);
      expect(r.tick(navCtx(1950)), `${label}: Down is not re-armed`).toEqual([]);
      expect(r.tick(navCtx(5000))).toEqual([]);
    }

    // Releasing a button that is NOT the armed one leaves the repeat running.
    const other = new InputRouter();
    other.route(edge('Down', true), navCtx(1000));
    other.route(edge('Up', true), navCtx(1100));
    other.route(edge('Down', false), navCtx(1200));
    expect(other.tick(navCtx(1449))).toEqual([]);
    expect(other.tick(navCtx(1450))).toEqual([navEffect('Up', true)]);

    // Two holders of the armed button: one release keeps it armed, the last disarms it.
    const two = new InputRouter();
    two.route(edge('Left', true), navCtx(1000));
    two.route(edge('Left', true), navCtx(1010));
    two.route(edge('Left', false), navCtx(1100));
    expect(two.tick(navCtx(1360)), 'still held by the other key').toEqual([
      navEffect('Left', true),
    ]);
    two.route(edge('Left', false), navCtx(1370));
    expect(two.tick(navCtx(1500))).toEqual([]);
  });

  it('CTL5-5-NO-REPEAT-WORLD-OR-COVERED: nothing repeats at the world, with no nav ctx, under a covered frame, or for A, B and Y', () => {
    // WRONG IMPL KILLED: a tick that repeats the world's walk (the frame loop already re-issues
    // held directions, so this would double-step), one that ignores `covered` (the hidden menu
    // would scroll under a child), one that repeats without a nav ctx at all, one that arms on a
    // press made while covered, and one that arms on A, B or Y (an Enter held on the menu would
    // open the child over and over).
    const world = new InputRouter();
    expect(world.route(edge('Down', true), WORLD).effects).toEqual([dirDown('South')]);
    expect(world.tick(WORLD), 'world, no nav ctx').toEqual([]);
    expect(world.tick({ worldActive: true }), 'repeatedly').toEqual([]);

    const armed = new InputRouter();
    armed.route(edge('Down', true), navCtx(1000));
    expect(armed.tick({ worldActive: false }), 'armed, but the nav frame is gone').toEqual([]);
    expect(armed.tick(navCtx(2000, true)), 'armed, but a legacy frame now covers it').toEqual([]);
    expect(armed.tick(navCtx(9000, true))).toEqual([]);

    const pressedCovered = new InputRouter();
    pressedCovered.route(edge('Down', true), navCtx(1000, true));
    expect(pressedCovered.tick(navCtx(1350, true))).toEqual([]);
    expect(pressedCovered.tick(navCtx(5000, true))).toEqual([]);

    for (const button of ['A', 'B', 'Y'] as const) {
      const r = new InputRouter();
      r.route(edge(button, true), navCtx(1000));
      expect(r.tick(navCtx(1350)), `${button} does not repeat`).toEqual([]);
      expect(r.tick(navCtx(5000))).toEqual([]);
    }
    const noPress = new InputRouter();
    expect(noPress.tick(navCtx(5000)), 'nothing pressed, nothing repeats').toEqual([]);
  });
});
