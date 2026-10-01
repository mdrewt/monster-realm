/**
 * router.test.ts: ownership + the input router (ctl-1, CTL1.1 / CTL1.2 / CTL1.4 / CTL1.5).
 *
 * Pure, node env. `ownership(target, event)` decides who owns a native key (the focused
 * field/button, or the router); `InputRouter` turns `{button, down}` edges into movement
 * effects with a per-button refcount, so two physical holders of one direction release it
 * only when the last lets go. Targets are plain objects read structurally (tagName,
 * isContentEditable), so no DOM is involved.
 *
 * RED REASON: client/src/input/router.ts (and keyboardSource.ts, buttons.ts) do not exist.
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

  it('is a pure function of its inputs: repeated calls and call order never change the answer', () => {
    const targets = [...ROUTER_TARGETS, ...FIELD_TARGETS, ...NATIVE_ACTIVATORS].map((t) => t[1]);
    fc.assert(
      fc.property(
        fc.constantFrom(...targets),
        fc.constantFrom(...ALL_CODES),
        fc.boolean(),
        (target, code, composing) => {
          const first = ownership(target, { code, isComposing: composing });
          const second = ownership(target, { code, isComposing: composing });
          expect(second).toBe(first);
          if (composing) expect(first).toBe('target');
        },
      ),
    );
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
