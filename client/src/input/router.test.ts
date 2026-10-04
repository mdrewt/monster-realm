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
import type { BaseFrame, FrameId, Stack, UpperFrame } from '../ui/contextStack';
import { MENU_ENTRIES, type MenuEntry } from '../ui/menuModel';
import type { NavInput } from '../ui/nav';
import { OVERLAY_IDS } from '../ui/overlayRegistry';
import type { ScreenResult } from '../ui/screens/types';
import { accelForCode, DEFAULT_BINDINGS } from './bindings';
import { ACCELS, type ButtonEdge, VBUTTONS, type VButton } from './buttons';
import { KeyboardSource } from './keyboardSource';
import {
  ACCEL_PATHS,
  type AccelDecision,
  accelDecision,
  InputRouter,
  type MenuAccel,
  outsideGameScreen,
  ownership,
  type RouteContext,
  type RouterEffect,
  routerConsumes,
  typingKey,
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
/** The effect a screen's command becomes (ctl-6b: the ctl-5 `pop` router effect is gone). */
const commandEffect = (command: ScreenResult): RouterEffect =>
  ({ kind: 'command', command }) as RouterEffect;

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

  // ctl-6b CTL6B.1 / CTL6B.3: the `pop` router effect is gone. B over a covered nav frame is no
  // longer special-cased: it reaches the top frame's screen adapter (ctx.screen), whose legacy
  // answer is the pop COMMAND, and a router with no screen leaves it unconsumed.
  it('CTL5-2-ROUTER-B-POPS-COVERED: B down under a covered nav frame reaches ctx.screen and yields its pop command as a consumed command effect (no `pop` router effect); with no screen it is unconsumed; A and Y stay with the screen; a B the target owns routes nothing', () => {
    // WRONG IMPL KILLED: a covered B that never asks the screen (B could never leave a child),
    // one that still emits the retired `pop` effect, one that pops on the up edge as well (two pops
    // per press), a command emitted from an uncovered frame (B at the menu root must navigate),
    // a covered A/Y that is consumed when the screen says `unhandled` (the legacy child's native
    // Enter would die), a covered D-pad press that navigates the hidden menu or asks the screen,
    // a covered B with no screen that still pops, and a Backspace typed into a text field that
    // pops the screen it is typed in.
    const POP_COMMAND: ScreenResult = { kind: 'pop' };
    const seen: NavInput[] = [];
    const coveredWith = (now: number, answer: ScreenResult): RouteContext => ({
      ...navCtx(now, true),
      screen: (btn) => {
        seen.push(btn);
        return answer;
      },
    });

    const r = new InputRouter();
    expect(r.route(edge('B', true), coveredWith(1000, POP_COMMAND))).toEqual({
      consumed: true,
      effects: [commandEffect(POP_COMMAND)],
    });
    expect(seen, 'the screen was asked exactly once, with a fresh B').toEqual([
      { button: 'B', repeat: false },
    ]);
    expect(
      r.route(edge('B', false), coveredWith(1050, POP_COMMAND)).effects,
      'the release pops nothing',
    ).toEqual([]);
    expect(seen.length, 'and does not ask the screen').toBe(1);
    expect(
      r.route(edge('B', true), coveredWith(1100, POP_COMMAND)).effects,
      'every press is one pop',
    ).toEqual([commandEffect(POP_COMMAND)]);
    expect(seen.length).toBe(2);

    // Contrast: the very same press with no screen to ask is unconsumed (the old pop effect is gone).
    expect(
      new InputRouter().route(edge('B', true), navCtx(1000, true)),
      'covered, no screen: nothing pops',
    ).toEqual({ consumed: false, effects: [] });

    // A and Y are the screen's too: `unhandled` leaves them to the native control, with the screen
    // actually consulted (so "unconsumed" is the screen's answer, not a router that never asked).
    for (const button of ['A', 'Y'] as const) {
      const before = seen.length;
      expect(
        new InputRouter().route(edge(button, true), coveredWith(1000, 'unhandled')),
        button,
      ).toEqual({ consumed: false, effects: [] });
      expect(seen.length, `${button}: the screen was asked`).toBe(before + 1);
    }

    const covered = new InputRouter();
    const askedBefore = seen.length;
    const dpad = covered.route(edge('Down', true), coveredWith(1000, POP_COMMAND));
    expect(dpad.consumed, 'the D-pad is still swallowed (no page scroll)').toBe(true);
    expect(
      dpad.effects.some((e) => e.kind === 'nav' || e.kind === 'command'),
      'a covered D-pad press drives nothing in the hidden menu',
    ).toBe(false);
    expect(seen.length, 'and never asks the screen').toBe(askedBefore);

    expect(
      new InputRouter().route(edge('B', true), navCtx(1000, false)).effects,
      'uncovered, B is a nav input, not a command',
    ).toEqual([navEffect('B', false)]);
    expect(
      new InputRouter().route(edge('B', true), GATED).effects,
      'with no nav frame and no screen there is nothing to pop',
    ).toEqual([]);

    // Ownership: Backspace typed into a field yields no edge, so the router never sees a B.
    const typed = new KeyboardSource().keydown({ code: 'Backspace', target: { tagName: 'INPUT' } });
    expect(typed, 'the field owns Backspace').toEqual([]);
    const typedRouter = new InputRouter();
    expect(
      typed.flatMap((e) => typedRouter.route(e, coveredWith(1000, POP_COMMAND)).effects),
    ).toEqual([]);
    // Control: the same key at the page pops.
    const atPage = new KeyboardSource().keydown({ code: 'Backspace', target: { tagName: 'DIV' } });
    const pageRouter = new InputRouter();
    expect(
      atPage.flatMap((e) => pageRouter.route(e, coveredWith(1000, POP_COMMAND)).effects),
    ).toEqual([commandEffect(POP_COMMAND)]);
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

// ==========================================================================================
// ctl-6b: the screen seam (CTL6B.1), Start / B / Select reach the top frame's adapter, LB/RB from
// the bumper keys (CTL6B.6; Q and E join PageUp and PageDown in ctl-11a) and typing mode (CTL6B.5)
// ==========================================================================================
//
// `ctx.screen(btn)` is the top frame's adapter, bound by the shell. After the D-pad, X and the
// uncovered-nav A/B/Y paths, a DOWN edge of A/B/Y/LB/RB/Start/Select asks it: `unhandled` is NOT
// consumed (the key falls to the ladder or to the focused native control), `consumed` is swallowed,
// a Command is consumed and becomes a `{kind:'command', command}` effect. Up edges of those
// buttons are not consumed, and a router with no `screen` leaves them all unconsumed.

const SCREEN_BUTTONS: readonly VButton[] = ['A', 'B', 'Y', 'LB', 'RB', 'Start', 'Select'];
const NAV_OWNED: ReadonlySet<VButton> = new Set<VButton>(['A', 'B', 'Y']);

const SCREEN_CONTEXTS: ReadonlyArray<{
  readonly name: string;
  readonly navFrameUncovered: boolean;
  readonly make: (screen: RouteContext['screen']) => RouteContext;
}> = [
  { name: 'world', navFrameUncovered: false, make: (screen) => ({ worldActive: true, screen }) },
  {
    name: 'a frame is open (no nav)',
    navFrameUncovered: false,
    make: (screen) => ({ worldActive: false, screen }),
  },
  {
    name: 'a covered nav frame',
    navFrameUncovered: false,
    make: (screen) => ({ ...navCtx(1000, true), screen }),
  },
  {
    name: 'an uncovered nav frame',
    navFrameUncovered: true,
    make: (screen) => ({ ...navCtx(1000, false), screen }),
  },
];

const SCREEN_ANSWERS: ReadonlyArray<{
  readonly name: string;
  readonly answer: ScreenResult;
  readonly expected: { readonly consumed: boolean; readonly effects: readonly RouterEffect[] };
}> = [
  { name: 'unhandled', answer: 'unhandled', expected: { consumed: false, effects: [] } },
  { name: 'consumed', answer: 'consumed', expected: { consumed: true, effects: [] } },
  {
    name: 'popToBase',
    answer: { kind: 'popToBase' },
    expected: { consumed: true, effects: [commandEffect({ kind: 'popToBase' })] },
  },
  {
    name: 'openMenu',
    answer: { kind: 'openMenu' },
    expected: { consumed: true, effects: [commandEffect({ kind: 'openMenu' })] },
  },
  {
    name: 'setProfileName',
    answer: { kind: 'setProfileName', name: 'Zed' },
    expected: { consumed: true, effects: [commandEffect({ kind: 'setProfileName', name: 'Zed' })] },
  },
];

describe('InputRouter screen seam (ctl-6b)', () => {
  it('CTL6B-1-ROUTER-SCREEN-RESULT: a DOWN edge of A/B/Y/LB/RB/Start/Select asks ctx.screen: unhandled is not consumed, consumed is swallowed, a Command becomes a consumed command effect; up edges are not consumed; nav owns A/B/Y at an uncovered nav frame', () => {
    // WRONG IMPL KILLED: a router that never asks the screen (Start / B / Select would have no
    // owner), one that treats `unhandled` as consumed (a focused native button would lose its
    // Enter, Backspace would be eaten at the page), one that treats `consumed` as unconsumed (the
    // key would also reach the ladder), one that drops or rewrites the Command, one that asks on
    // the up edge (two commands per press) or consumes the up edge, one that asks the screen for
    // the keys the uncovered nav frame owns (a menu A would both activate and be routed twice),
    // and one that sends a repeat flag.
    let rows = 0;
    for (const ctx of SCREEN_CONTEXTS) {
      for (const button of SCREEN_BUTTONS) {
        for (const a of SCREEN_ANSWERS) {
          const label = `${ctx.name} / ${button} / ${a.name}`;
          const navOwned = ctx.navFrameUncovered && NAV_OWNED.has(button);
          const seen: NavInput[] = [];
          const screen = (btn: NavInput): ScreenResult => {
            seen.push(btn);
            return a.answer;
          };
          const router = new InputRouter();

          const down = router.route(edge(button, true), ctx.make(screen));
          if (navOwned) {
            expect(down, `${label}: nav owns the press`).toEqual({
              consumed: true,
              effects: [navEffect(button, false)],
            });
            expect(seen, `${label}: the screen is not asked`).toEqual([]);
          } else {
            expect(down, `${label}: down`).toEqual(a.expected);
            expect(seen, `${label}: asked once with a fresh press`).toEqual([
              { button, repeat: false },
            ]);
          }

          const up = router.route(edge(button, false), ctx.make(screen));
          expect(up, `${label}: up`).toEqual(
            navOwned ? { consumed: true, effects: [] } : { consumed: false, effects: [] },
          );
          expect(seen.length, `${label}: the release asks nobody`).toBe(navOwned ? 0 : 1);
          rows += 1;
        }
      }
    }
    expect(rows, 'ANTI-VACUITY: every context x button x answer was driven').toBe(
      SCREEN_CONTEXTS.length * SCREEN_BUTTONS.length * SCREEN_ANSWERS.length,
    );

    // With no screen bound, every one of those buttons is unconsumed (the nav-owned ones aside).
    for (const ctx of SCREEN_CONTEXTS) {
      for (const button of SCREEN_BUTTONS) {
        const navOwned = ctx.navFrameUncovered && NAV_OWNED.has(button);
        const down = new InputRouter().route(edge(button, true), ctx.make(undefined));
        expect(down, `no screen / ${ctx.name} / ${button}`).toEqual(
          navOwned
            ? { consumed: true, effects: [navEffect(button, false)] }
            : { consumed: false, effects: [] },
        );
      }
    }

    // The D-pad and X never ask the screen: the world's walk and jump stay the router's.
    for (const ctx of SCREEN_CONTEXTS) {
      for (const button of ['Up', 'Down', 'Left', 'Right', 'X'] as const) {
        let asked = 0;
        const screen = (): ScreenResult => {
          asked += 1;
          return { kind: 'popToBase' };
        };
        const withScreen = new InputRouter();
        const without = new InputRouter();
        for (const isDown of [true, false]) {
          expect(
            withScreen.route(edge(button, isDown), ctx.make(screen)),
            `${ctx.name} / ${button} ${isDown ? 'down' : 'up'} is the same with a screen bound`,
          ).toEqual(without.route(edge(button, isDown), ctx.make(undefined)));
        }
        expect(asked, `${ctx.name} / ${button}: the screen is never asked`).toBe(0);
      }
    }
  });
});

// ctl-11a (named intentional deletion): the `routedBindings (ctl-6b, CTL6B.6)` describe is deleted
// with `routedBindings` itself (Q and E are LB and RB through DEFAULT_BINDINGS now, so no copy
// drops them; the frozen, unedited default table is bindings.test.ts's). What still held, the
// source's press and release edges for the bumper keys, is kept below against DEFAULT_BINDINGS.
describe('LB and RB through the default bindings (ctl-6b, CTL6B.6; ctl-11a, CTL11A.3)', () => {
  it('CTL6B-6-DEFAULT-BUMPERS: a keyboard source on the default bindings maps Q and PageUp to LB and E and PageDown to RB, each press a down edge and each release an up edge of the same button, and Start and the D-pad still resolve beside them', () => {
    // WRONG IMPL KILLED: a table that drops Q / E from the bumpers (the tabbed screens would never
    // be reached from them) or PageUp / PageDown too, a release that is lost for a bumper key (the
    // router's held count would leak: a stuck LB / RB), a release mapped to the other bumper, one
    // key mapped to two buttons (an alias that also resolves as Start or a D-pad direction), and
    // a bumper binding that damages another button's keys.
    const source = new KeyboardSource(DEFAULT_BINDINGS);
    const bumpers: ReadonlyArray<readonly [string, VButton]> = [
      ['KeyQ', 'LB'],
      ['PageUp', 'LB'],
      ['KeyE', 'RB'],
      ['PageDown', 'RB'],
    ];
    for (const [code, button] of bumpers) {
      expect(source.keydown({ code }), `${code} down is ${button}`).toEqual([
        { button, down: true },
      ]);
      expect(source.keyup({ code }), `${code} up is ${button}`).toEqual([{ button, down: false }]);
    }
    // And the other buttons still resolve through the same source.
    expect(source.keydown({ code: 'Escape' })).toEqual([{ button: 'Start', down: true }]);
    expect(source.keydown({ code: 'KeyW' })).toEqual([{ button: 'Up', down: true }]);
  });
});

describe('typingKey (ctl-6b, CTL6B.5)', () => {
  it('CTL6B-5-TYPING-KEY: Escape on a text field (text-like INPUT, TEXTAREA, contentEditable) stops typing; every other key, every non-text target and any composition does not', () => {
    // WRONG IMPL KILLED: a field that never stops typing (the second Escape could never act as
    // Start), one that stops on every key (typing "a" would blur the field), a SELECT or a checkbox
    // treated as a text field (Escape on them would be swallowed instead of acting as Start), a
    // number input (the trade currency box) not treated as text, a missing `type` not treated as
    // text, a composing Escape that blurs the field (it cancels the IME composition instead), and
    // a plain page, canvas or button that "stops typing".
    const textLike: ReadonlyArray<readonly [string, unknown]> = [
      ['input text', { tagName: 'INPUT', type: 'text' }],
      ['input search', { tagName: 'INPUT', type: 'search' }],
      ['input email', { tagName: 'INPUT', type: 'email' }],
      ['input password', { tagName: 'INPUT', type: 'password' }],
      ['input tel', { tagName: 'INPUT', type: 'tel' }],
      ['input url', { tagName: 'INPUT', type: 'url' }],
      ['input number', { tagName: 'INPUT', type: 'number' }],
      ['input without a type', { tagName: 'INPUT' }],
      ['input with an empty type', { tagName: 'INPUT', type: '' }],
      ['textarea', { tagName: 'TEXTAREA' }],
      ['contentEditable', { tagName: 'DIV', isContentEditable: true }],
      ['lower-case tag name', { tagName: 'input', type: 'text' }],
    ];
    const notText: ReadonlyArray<readonly [string, unknown]> = [
      ['input checkbox', { tagName: 'INPUT', type: 'checkbox' }],
      ['input radio', { tagName: 'INPUT', type: 'radio' }],
      ['input range', { tagName: 'INPUT', type: 'range' }],
      ['input button', { tagName: 'INPUT', type: 'button' }],
      ['input submit', { tagName: 'INPUT', type: 'submit' }],
      ['select', { tagName: 'SELECT' }],
      ['button', { tagName: 'BUTTON' }],
      ['anchor', { tagName: 'A' }],
      ['div', { tagName: 'DIV', isContentEditable: false }],
      ['body', { tagName: 'BODY' }],
      ['canvas', { tagName: 'CANVAS' }],
      ['window-like', { addEventListener: () => undefined, document: {} }],
      ['empty object', {}],
      ['null', null],
      ['undefined', undefined],
      ['number', 7],
    ];

    for (const [label, target] of textLike) {
      expect(typingKey(target, { code: 'Escape' }), `${label} / Escape`).toBe('stopTyping');
      expect(
        typingKey(target, { code: 'Escape', isComposing: false, keyCode: 27 }),
        `${label} / Escape, not composing`,
      ).toBe('stopTyping');
      // ctl-12b (named intentional change, plan §4 "typing mode is literal"): Enter and NumpadEnter
      // on a field now answer 'commit' (the ctl-12b commit case below pins them), so they leave this
      // "every other key" list. Was: both expected undefined here. Every key still listed keeps its
      // expectation, and Escape still stops typing.
      for (const code of ['KeyA', 'Backspace', 'Space', 'Tab', 'ArrowLeft']) {
        expect(typingKey(target, { code }), `${label} / ${code}`).toBeUndefined();
      }
      expect(
        typingKey(target, { code: 'Escape', isComposing: true }),
        `${label} / composing Escape is the browser's`,
      ).toBeUndefined();
      expect(
        typingKey(target, { code: 'Escape', keyCode: 229 }),
        `${label} / keyCode 229 Escape is the browser's`,
      ).toBeUndefined();
    }
    for (const [label, target] of notText) {
      expect(typingKey(target, { code: 'Escape' }), `${label} / Escape is Start`).toBeUndefined();
      expect(typingKey(target, { code: 'KeyA' }), `${label} / KeyA`).toBeUndefined();
    }
    expect(textLike.length + notText.length, 'ANTI-VACUITY: both polarities are driven').toBe(28);
  });
});

describe('typingKey commit (ctl-12b, plan §4: typing mode is literal)', () => {
  it('Enter and NumpadEnter on a focused field (an INPUT of any type, a TEXTAREA, a SELECT, a contentEditable) answer commit; a composing Enter, a non-field target and every other key do not; Escape still stops typing on text fields only', () => {
    // WRONG IMPL KILLED: an Enter in a field read through the binding table (after A := K the
    // player could no longer commit a nickname with Enter, and the field's own K would be pressed
    // as A); a commit on text fields only (a checkbox or a SELECT, which own Enter natively, would
    // let it fall to the table: Enter bound to Start would close the frame); a composing Enter that
    // commits (it confirms the IME candidate instead); a commit on a button, a link, the canvas or
    // the page (Enter there is the router's A); a commit on any key but the two Enters; and an
    // Escape that now commits, or that stops typing on a SELECT.
    const fields: ReadonlyArray<readonly [string, unknown]> = [
      ['input text', { tagName: 'INPUT', type: 'text' }],
      ['input without a type', { tagName: 'INPUT' }],
      ['input number', { tagName: 'INPUT', type: 'number' }],
      ['input password', { tagName: 'INPUT', type: 'password' }],
      ['input checkbox', { tagName: 'INPUT', type: 'checkbox' }],
      ['input radio', { tagName: 'INPUT', type: 'radio' }],
      ['input range', { tagName: 'INPUT', type: 'range' }],
      ['textarea', { tagName: 'TEXTAREA' }],
      ['select', { tagName: 'SELECT' }],
      ['contentEditable', { tagName: 'DIV', isContentEditable: true }],
      ['lower-case tag name', { tagName: 'input', type: 'text' }],
    ];
    const notFields: ReadonlyArray<readonly [string, unknown]> = [
      ['button', { tagName: 'BUTTON' }],
      ['anchor', { tagName: 'A' }],
      ['div', { tagName: 'DIV', isContentEditable: false }],
      ['body', { tagName: 'BODY' }],
      ['canvas', { tagName: 'CANVAS' }],
      ['window-like', { addEventListener: () => undefined, document: {} }],
      ['empty object', {}],
      ['null', null],
      ['undefined', undefined],
      ['number', 7],
    ];
    const ENTERS = ['Enter', 'NumpadEnter'] as const;
    let commits = 0;
    for (const [label, target] of fields) {
      for (const code of ENTERS) {
        expect(typingKey(target, { code }), `${label} / ${code}`).toBe('commit');
        expect(
          typingKey(target, { code, isComposing: false, keyCode: 13 }),
          `${label} / ${code}, not composing`,
        ).toBe('commit');
        expect(
          typingKey(target, { code, isComposing: true }),
          `${label} / a composing ${code} is the IME's`,
        ).toBeUndefined();
        expect(
          typingKey(target, { code, keyCode: 229 }),
          `${label} / keyCode 229 ${code} is the IME's`,
        ).toBeUndefined();
        commits += 1;
      }
      for (const code of ['KeyA', 'KeyK', 'Space', 'Backspace', 'Tab', 'ArrowUp']) {
        expect(typingKey(target, { code }), `${label} / ${code} is the field's`).toBeUndefined();
      }
      expect(typingKey(target, { code: 'Escape' }), `${label} / Escape never commits`).not.toBe(
        'commit',
      );
    }
    expect(commits, 'ANTI-VACUITY: every field x both Enters').toBe(fields.length * 2);
    for (const [label, target] of notFields) {
      for (const code of ENTERS) {
        expect(typingKey(target, { code }), `${label} / ${code} is the router's A`).toBeUndefined();
      }
    }
    // Escape keeps its own rule: it stops typing on a text field, and is Start on a control.
    expect(typingKey({ tagName: 'INPUT', type: 'text' }, { code: 'Escape' })).toBe('stopTyping');
    expect(typingKey({ tagName: 'TEXTAREA' }, { code: 'Escape' })).toBe('stopTyping');
    expect(typingKey({ tagName: 'SELECT' }, { code: 'Escape' })).toBeUndefined();
    expect(typingKey({ tagName: 'INPUT', type: 'checkbox' }, { code: 'Escape' })).toBeUndefined();
  });
});

// ==========================================================================================
// ctl-7c: a nav-capable screen frame takes the D-pad (CTL7C.1)
// ==========================================================================================
//
// `ctx.nav.screen` marks the uncovered nav frame as a nav-capable SCREEN rather than the
// hand-hosted main menu: its D-pad down edges, and the repeats `tick` synthesizes for them, are
// handed to `ctx.screen` instead of becoming `nav` effects. A Command answer is a `command`
// effect; `consumed` and `unhandled` are both swallowed (an arrow never scrolls the page under a
// frame). A, B, Y and the other routed buttons stay on the ordinary screen path, so `unhandled`
// still leaves them unconsumed. Without `screen` nothing changes. As in the ctl-5 block, every
// press is at a NON-ZERO `now`.

/** An uncovered nav-capable screen frame, with the top frame's adapter bound when given. */
const screenNavCtx = (
  now: number,
  screen?: RouteContext['screen'],
  worldActive = false,
): RouteContext => ({ worldActive, nav: { covered: false, now, screen: true }, screen });

/** A screen that records every input it is asked, answering from `answer`. */
function askingScreen(answer: (btn: NavInput) => ScreenResult): {
  readonly seen: NavInput[];
  readonly screen: (btn: NavInput) => ScreenResult;
} {
  const seen: NavInput[] = [];
  return {
    seen,
    screen: (btn) => {
      seen.push(btn);
      return answer(btn);
    },
  };
}

const SWALLOWED_EDGE = { consumed: true, effects: [] } as const;

describe('InputRouter under a nav-capable screen (ctl-7c)', () => {
  it('CTL7C-1-SCREEN-NAV-DPAD: under a nav-capable screen a D-pad press asks ctx.screen once, fresh: a Command becomes a consumed command effect, consumed and unhandled are swallowed, and it never walks or emits a menu nav effect; the release asks nothing; A, B, Y and the other routed buttons stay on the screen path', () => {
    // WRONG IMPL KILLED: a D-pad that still goes to the world under a nav screen (a dirDown: the
    // character would step behind the frame), one that is still a menu `nav` effect (the hidden
    // menu's cursor would move instead of the screen's), one that never asks the screen (a
    // dialogue, shop or heal frame gets no Up/Down), one that asks with `repeat: true` or twice,
    // a Command dropped or rewritten, an `unhandled` D-pad left unconsumed (the page scrolls under
    // the frame), one that asks the screen on the UP edge too (two moves per press) or loses the
    // release (the held count would leak), A / B / Y captured as nav effects under a screen (an
    // adapter's `unhandled` would no longer leave Enter to a focused native button), and a
    // missing ctx.screen that leaves the arrow to the page.
    const MOVE_COMMAND: ScreenResult = { kind: 'advanceDialogue', choiceIdx: 3 };
    const answers: ReadonlyArray<{
      readonly name: string;
      readonly answer: ScreenResult;
      readonly expected: { readonly consumed: boolean; readonly effects: readonly RouterEffect[] };
    }> = [
      {
        name: 'a Command',
        answer: MOVE_COMMAND,
        expected: { consumed: true, effects: [commandEffect(MOVE_COMMAND)] },
      },
      { name: 'consumed', answer: 'consumed', expected: SWALLOWED_EDGE },
      { name: 'unhandled', answer: 'unhandled', expected: SWALLOWED_EDGE },
    ];
    let rows = 0;
    for (const [button, dir] of DIRS) {
      for (const a of answers) {
        // worldActive true too: the screen outranks the world, as the menu's nav does.
        for (const worldActive of [false, true]) {
          const label = `${button} / ${a.name} / worldActive ${worldActive}`;
          const { seen, screen } = askingScreen(() => a.answer);
          const r = new InputRouter();
          expect(
            r.route(edge(button, true), screenNavCtx(1000, screen, worldActive)),
            label,
          ).toEqual(a.expected);
          expect(seen, `${label}: asked once, with a fresh press`).toEqual([
            { button, repeat: false },
          ]);
          expect(
            r.route(edge(button, false), screenNavCtx(1100, screen, worldActive)),
            `${label}: the release is counted and reported as before`,
          ).toEqual({ consumed: true, effects: [dirUp(dir)] });
          expect(seen.length, `${label}: the release asks nobody`).toBe(1);
          rows += 1;
        }
      }
    }
    expect(rows, 'ANTI-VACUITY: every direction x answer x world flag was driven').toBe(
      DIRS.length * answers.length * 2,
    );

    // No adapter bound: the arrow is still the router's (swallowed), never the page's.
    for (const [button] of DIRS) {
      expect(
        new InputRouter().route(edge(button, true), screenNavCtx(1000)),
        `${button} with no screen bound`,
      ).toEqual(SWALLOWED_EDGE);
    }

    // A, B, Y and the other routed buttons: the ordinary screen path, unhandled stays unconsumed.
    for (const button of SCREEN_BUTTONS) {
      for (const a of SCREEN_ANSWERS) {
        const label = `${button} / ${a.name}`;
        const { seen, screen } = askingScreen(() => a.answer);
        const r = new InputRouter();
        expect(r.route(edge(button, true), screenNavCtx(1000, screen)), label).toEqual(a.expected);
        expect(seen, `${label}: the screen is asked once, fresh`).toEqual([
          { button, repeat: false },
        ]);
        expect(r.route(edge(button, false), screenNavCtx(1100, screen)), `${label}: up`).toEqual({
          consumed: false,
          effects: [],
        });
        expect(seen.length, `${label}: the release asks nobody`).toBe(1);
      }
      expect(
        new InputRouter().route(edge(button, true), screenNavCtx(1000)),
        `${button} with no screen bound is not a nav effect`,
      ).toEqual({ consumed: false, effects: [] });
    }
  });

  it('CTL7C-1-SCREEN-REPEAT: a D-pad button held under a nav-capable screen repeats into ctx.screen 350 ms after the press and then every 100 ms, flagged repeat; a Command answer is a command effect and a consumed or unhandled one does not stop the schedule; the latest press repeats and its release hands back; a stalled clock asks once; nothing repeats once the frame is covered or gone', () => {
    // WRONG IMPL KILLED: a tick that still emits a menu `nav` effect under a screen (the hidden
    // menu scrolls), one that never asks the screen (a held arrow moves a dialogue cursor once),
    // a repeat not flagged `repeat: true` (a wrapping list would wrap instead of clamping), a
    // schedule that a `consumed` or `unhandled` answer stops, one anchored at 0 instead of the
    // press time, a burst after a stalled frame, two asks for one due time, the older of two held
    // buttons repeating, a release that does not hand the repeat back to the newest held button,
    // and a repeat that still reaches the screen once a legacy frame covers it or it is gone.
    for (const [button] of DIRS) {
      for (const answer of ['consumed', 'unhandled'] as const) {
        const label = `${button} / ${answer}`;
        const { seen, screen } = askingScreen(() => answer);
        const r = new InputRouter();
        r.route(edge(button, true), screenNavCtx(1000, screen));
        const at = (t: number): readonly RouterEffect[] => r.tick(screenNavCtx(t, screen));
        expect(at(1000), `${label}: nothing at the press`).toEqual([]);
        expect(at(1349), `${label}: 349 ms`).toEqual([]);
        expect(seen, `${label}: only the press so far`).toEqual([{ button, repeat: false }]);
        expect(at(1350), `${label}: the repeat is swallowed, never a nav effect`).toEqual([]);
        expect(seen, `${label}: 350 ms: the screen is asked for a repeat`).toEqual([
          { button, repeat: false },
          { button, repeat: true },
        ]);
        expect(at(1350), `${label}: one ask per due time`).toEqual([]);
        expect(seen.length).toBe(2);
        at(1449);
        expect(seen.length, `${label}: 449 ms`).toBe(2);
        at(1450);
        expect(seen.length, `${label}: 450 ms: the schedule survived the ${answer} answer`).toBe(3);
        expect(seen.at(-1)).toEqual({ button, repeat: true });
        at(1550);
        expect(seen.length, `${label}: 550 ms`).toBe(4);
      }
    }

    // A Command answer to a repeat becomes a command effect, every period.
    const SCROLL: ScreenResult = { kind: 'advanceDialogue', choiceIdx: 2 };
    const cmd = askingScreen((btn) => (btn.repeat ? SCROLL : 'consumed'));
    const withCmd = new InputRouter();
    expect(withCmd.route(edge('Down', true), screenNavCtx(1000, cmd.screen)).effects).toEqual([]);
    expect(withCmd.tick(screenNavCtx(1350, cmd.screen))).toEqual([commandEffect(SCROLL)]);
    expect(withCmd.tick(screenNavCtx(1449, cmd.screen))).toEqual([]);
    expect(withCmd.tick(screenNavCtx(1450, cmd.screen))).toEqual([commandEffect(SCROLL)]);

    // Anchored at the press time, fractional included.
    const late = askingScreen(() => 'consumed');
    const lateRouter = new InputRouter();
    lateRouter.route(edge('Up', true), screenNavCtx(98765.5, late.screen));
    lateRouter.tick(screenNavCtx(98765.5 + 349, late.screen));
    expect(late.seen.length, 'not before press + 350').toBe(1);
    lateRouter.tick(screenNavCtx(98765.5 + 350, late.screen));
    expect(late.seen).toEqual([
      { button: 'Up', repeat: false },
      { button: 'Up', repeat: true },
    ]);

    // A stalled frame asks once; the next ask is due 100 ms after the stalled tick.
    const stall = askingScreen(() => 'consumed');
    const stallRouter = new InputRouter();
    stallRouter.route(edge('Down', true), screenNavCtx(1000, stall.screen));
    stallRouter.tick(screenNavCtx(2000, stall.screen));
    expect(stall.seen.length, 'one ask, not nine').toBe(2);
    stallRouter.tick(screenNavCtx(2000, stall.screen));
    stallRouter.tick(screenNavCtx(2099, stall.screen));
    expect(stall.seen.length).toBe(2);
    stallRouter.tick(screenNavCtx(2100, stall.screen));
    expect(stall.seen.length).toBe(3);

    // The latest press repeats; its release hands the repeat back to the newest still-held button,
    // re-armed at the release time + 350 ms.
    const two = askingScreen(() => 'consumed');
    const twoRouter = new InputRouter();
    const repeats = (): NavInput[] => two.seen.filter((b) => b.repeat);
    twoRouter.route(edge('Down', true), screenNavCtx(1000, two.screen));
    twoRouter.route(edge('Up', true), screenNavCtx(1200, two.screen));
    twoRouter.tick(screenNavCtx(1350, two.screen));
    twoRouter.tick(screenNavCtx(1549, two.screen));
    expect(repeats(), 'the older button no longer repeats').toEqual([]);
    twoRouter.tick(screenNavCtx(1550, two.screen));
    expect(repeats()).toEqual([{ button: 'Up', repeat: true }]);
    expect(
      twoRouter.route(edge('Up', false), screenNavCtx(1600, two.screen)),
      'the release is reported and asks nothing',
    ).toEqual({ consumed: true, effects: [dirUp('North')] });
    twoRouter.tick(screenNavCtx(1949, two.screen));
    expect(repeats().length, 'not due until release + 350').toBe(1);
    twoRouter.tick(screenNavCtx(1950, two.screen));
    expect(repeats().at(-1), 'handed back to Down').toEqual({ button: 'Down', repeat: true });
    twoRouter.tick(screenNavCtx(2050, two.screen));
    expect(repeats().length).toBe(3);
    twoRouter.route(edge('Down', false), screenNavCtx(2100, two.screen));
    twoRouter.tick(screenNavCtx(2500, two.screen));
    twoRouter.tick(screenNavCtx(9000, two.screen));
    expect(repeats().length, 'nothing held, nothing repeats').toBe(3);

    // Covered by a legacy frame, or gone: the armed repeat reaches nobody.
    const gone = askingScreen(() => ({ kind: 'popToBase' }));
    const goneRouter = new InputRouter();
    goneRouter.route(edge('Down', true), screenNavCtx(1000, gone.screen));
    const coveredScreen: RouteContext = {
      worldActive: false,
      nav: { covered: true, now: 1350, screen: true },
      screen: gone.screen,
    };
    expect(goneRouter.tick(coveredScreen), 'covered').toEqual([]);
    expect(goneRouter.tick({ worldActive: false, screen: gone.screen }), 'no nav frame').toEqual(
      [],
    );
    expect(goneRouter.tick({ ...navCtx(5000, true), screen: gone.screen })).toEqual([]);
    expect(gone.seen, 'only the press reached the screen').toEqual([
      { button: 'Down', repeat: false },
    ]);
  });

  it('CTL7C-1-RESET-NO-HANDBACK: a key held since before resetRepeat is never handed the repeat when a newer key is released, under the main menu and under a nav screen; a key pressed after the reset still is; the held key`s release is still reported', () => {
    // WRONG IMPL KILLED: a resetRepeat that clears the armed repeat but keeps the held-press
    // order (hold Down at the world, a frame opens, tap Up in it: 350 ms after the tap Down
    // repeats into the new frame with no key pressed in it, on the menu path and on a screen's),
    // one that forgets the holder counts too (Down's release would report nothing and the held
    // direction would leak), and one that disables the hand-back altogether after a reset (a
    // button pressed after the reset must still get it back).
    // Control: without the reset the same taps DO hand the repeat back (CTL5-5-REPEAT-RESET), so
    // the silence below is the reset's doing.
    const control = new InputRouter();
    control.route(edge('Down', true), navCtx(1000));
    control.route(edge('Up', true), navCtx(1100));
    control.route(edge('Up', false), navCtx(1200));
    expect(control.tick(navCtx(1550)), 'control: no reset, Down is handed back').toEqual([
      navEffect('Down', true),
    ]);

    // The menu flavour.
    const menu = new InputRouter();
    menu.route(edge('Down', true), navCtx(1000));
    menu.resetRepeat();
    expect(menu.route(edge('Up', true), navCtx(1100)).effects).toEqual([navEffect('Up', false)]);
    expect(menu.route(edge('Up', false), navCtx(1200)).effects).toEqual([dirUp('North')]);
    for (const t of [1450, 1549, 1550, 1650, 2000, 5000]) {
      expect(
        menu.tick(navCtx(t)),
        `menu: Down held since before the reset is silent at ${t}`,
      ).toEqual([]);
    }
    expect(menu.route(edge('Down', false), navCtx(5100)), 'its release is still reported').toEqual({
      consumed: true,
      effects: [dirUp('South')],
    });

    // The screen flavour.
    const scr = askingScreen(() => 'consumed');
    const onScreen = new InputRouter();
    onScreen.route(edge('Down', true), screenNavCtx(1000, scr.screen));
    onScreen.resetRepeat();
    onScreen.route(edge('Up', true), screenNavCtx(1100, scr.screen));
    onScreen.route(edge('Up', false), screenNavCtx(1200, scr.screen));
    for (const t of [1450, 1549, 1550, 1650, 2000, 5000]) {
      onScreen.tick(screenNavCtx(t, scr.screen));
    }
    expect(scr.seen, 'screen: only the two presses, no repeat').toEqual([
      { button: 'Down', repeat: false },
      { button: 'Up', repeat: false },
    ]);
    expect(onScreen.route(edge('Down', false), screenNavCtx(5100, scr.screen))).toEqual({
      consumed: true,
      effects: [dirUp('South')],
    });

    // A button pressed AFTER the reset is in the order again: releasing a newer one hands back to
    // it, never to the button held from before.
    const after = new InputRouter();
    after.route(edge('Down', true), navCtx(1000));
    after.resetRepeat();
    after.route(edge('Left', true), navCtx(1100));
    after.route(edge('Up', true), navCtx(1200));
    after.route(edge('Up', false), navCtx(1300));
    expect(after.tick(navCtx(1649))).toEqual([]);
    expect(after.tick(navCtx(1650)), 'Left (pressed after the reset) gets it back').toEqual([
      navEffect('Left', true),
    ]);
    after.route(edge('Left', false), navCtx(1700));
    for (const t of [2050, 2150, 5000]) {
      expect(after.tick(navCtx(t)), `and then not Down (t=${t})`).toEqual([]);
    }
  });

  it('CTL7C-1-LEGACY-UNCHANGED: without nav.screen a D-pad edge never asks ctx.screen: it walks at the world, is swallowed under an open frame, is a menu nav effect (and repeats as one) under the main menu, also with screen: false, and a covered frame flagged screen is swallowed like any covered one', () => {
    // WRONG IMPL KILLED: a router that hands the D-pad to ctx.screen whenever a screen is bound (the
    // world would stop walking and every legacy frame would get arrows it never asked for), one
    // keyed on the PRESENCE of `screen` instead of its value (`screen: false` is the menu), and one
    // that ignores `covered` for a frame flagged screen (a nav screen under a legacy child would
    // scroll behind it).
    const contexts: ReadonlyArray<{
      readonly name: string;
      readonly make: (screen: RouteContext['screen']) => RouteContext;
      readonly down: (button: VButton, dir: WasmDirection) => readonly RouterEffect[];
    }> = [
      {
        name: 'the world',
        make: (screen) => ({ worldActive: true, screen }),
        down: (_b, dir) => [dirDown(dir)],
      },
      {
        name: 'an open frame (no nav)',
        make: (screen) => ({ worldActive: false, screen }),
        down: () => [],
      },
      {
        name: 'the main menu',
        make: (screen) => ({ ...navCtx(1000), screen }),
        down: (button) => [navEffect(button, false)],
      },
      {
        name: 'the main menu, screen: false',
        make: (screen) => ({
          worldActive: false,
          nav: { covered: false, now: 1000, screen: false },
          screen,
        }),
        down: (button) => [navEffect(button, false)],
      },
      {
        name: 'a covered nav frame flagged screen',
        make: (screen) => ({
          worldActive: false,
          nav: { covered: true, now: 1000, screen: true },
          screen,
        }),
        down: () => [],
      },
    ];
    for (const ctx of contexts) {
      for (const [button, dir] of DIRS) {
        const label = `${ctx.name} / ${button}`;
        const { seen, screen } = askingScreen(() => ({ kind: 'popToBase' }));
        const r = new InputRouter();
        expect(r.route(edge(button, true), ctx.make(screen)), `${label}: down`).toEqual({
          consumed: true,
          effects: ctx.down(button, dir),
        });
        expect(r.route(edge(button, false), ctx.make(screen)), `${label}: up`).toEqual({
          consumed: true,
          effects: [dirUp(dir)],
        });
        expect(seen, `${label}: the screen is never asked`).toEqual([]);
      }
    }

    // The menu's repeat is still a nav effect and asks nobody, with screen absent or false.
    for (const flag of [undefined, false] as const) {
      const { seen, screen } = askingScreen(() => ({ kind: 'popToBase' }));
      const ctxAt = (now: number): RouteContext => ({
        worldActive: false,
        nav: flag === undefined ? { covered: false, now } : { covered: false, now, screen: flag },
        screen,
      });
      const r = new InputRouter();
      r.route(edge('Down', true), ctxAt(1000));
      expect(r.tick(ctxAt(1350)), `screen ${String(flag)}: the menu repeat`).toEqual([
        navEffect('Down', true),
      ]);
      expect(seen, `screen ${String(flag)}: asks nobody`).toEqual([]);
    }

    // A covered frame flagged screen arms nothing and repeats nothing.
    const covered = askingScreen(() => ({ kind: 'popToBase' }));
    const coveredAt = (now: number): RouteContext => ({
      worldActive: false,
      nav: { covered: true, now, screen: true },
      screen: covered.screen,
    });
    const coveredRouter = new InputRouter();
    coveredRouter.route(edge('Down', true), coveredAt(1000));
    expect(coveredRouter.tick(coveredAt(1350))).toEqual([]);
    expect(coveredRouter.tick(screenNavCtx(1450, covered.screen)), 'uncovered later').toEqual([]);
    expect(covered.seen, 'nothing reached the screen').toEqual([]);

    // Control: the very same press under an UNCOVERED frame flagged screen is asked, so every
    // silence above is the flag's doing, not a router that never hands the D-pad to a screen.
    const flagged = askingScreen(() => ({ kind: 'popToBase' }));
    const flaggedRouter = new InputRouter();
    flaggedRouter.route(edge('Down', true), screenNavCtx(1000, flagged.screen));
    expect(flagged.seen, 'control: screen: true hands the press to the screen').toEqual([
      { button: 'Down', repeat: false },
    ]);
  });
});

// ==========================================================================================
// ctl-11a: accelerators move to the router (CTL11A.1, CTL11A.2, CTL11A.3)
// ==========================================================================================
//
// `ACCEL_PATHS` is the canonical menu path of each of the nine menu accelerators (F8 and F9 stay
// the shell's own): the main-menu entry keys, root first, the frame the leaf opens, and (Monsters
// only) the tab. `accelDecision(accel, stack)` is the pure verdict on one accelerator press:
// `denied` while the top frame is server-owned, a textEntry or a prompt (`acceleratorsDenied`),
// `start` while the accelerator's own screen is the top frame, else `open` with that path.
//
// Every expected path, frame id and verdict below is a HARD-CODED literal, never read back from
// the module under test.

type PathRow = {
  readonly menu: readonly string[];
  readonly frame: FrameId;
  readonly tab?: 'party' | 'storage';
};
const EXPECTED_PATHS: Readonly<Record<MenuAccel, PathRow>> = {
  B: { menu: ['monsters'], frame: 'boxView', tab: 'storage' },
  I: { menu: ['bag'], frame: 'raisingView' },
  V: { menu: ['monsters'], frame: 'boxView', tab: 'party' },
  J: { menu: ['journal'], frame: 'questLogView' },
  U: { menu: ['social', 'trades'], frame: 'social' },
  P: { menu: ['social', 'challenges'], frame: 'social' },
  L: { menu: ['social', 'rankings'], frame: 'social' },
  N: { menu: ['profile', 'name'], frame: 'renameView' },
  C: { menu: ['profile', 'account'], frame: 'claimView' },
};
const MENU_ACCELS: readonly MenuAccel[] = ACCELS.filter(
  (a): a is MenuAccel => a !== 'F8' && a !== 'F9',
);

const WORLD_BASE: BaseFrame = { kind: 'world' };
const battleBase = (battleId: string): BaseFrame => ({ kind: 'battle', battleId });
const screenFrame = (id: FrameId): UpperFrame => ({ kind: 'screen', id });
/** A screen frame opened over battle `battleId` (CTL6C.1's stamp). */
const stampedFrame = (id: FrameId, battleId: string): UpperFrame =>
  ({ kind: 'screen', id, overBattle: battleId }) as UpperFrame;
const promptFrame = (id: FrameId): UpperFrame => ({ kind: 'prompt', id });
const textEntryFrame = (owner: FrameId): UpperFrame => ({ kind: 'textEntry', owner });
/** A frozen stack, so an implementation that writes into its input throws. */
const frozenStack = (base: BaseFrame, ...upper: UpperFrame[]): Stack => {
  for (const f of [base, ...upper]) Object.freeze(f);
  return Object.freeze([base, ...upper]) as unknown as Stack;
};

/** The seventeen player-owned frame ids (spelled out, never read from SCREEN_POLICY): every frame id
 *  but the two server-owned ones. ctl-12b (named intentional change): `controlsView` (Options ›
 *  Controls) joins, a player screen an accelerator replaces like any other. Was: sixteen. */
const PLAYER_FRAMES: readonly FrameId[] = [
  'boxView',
  'raisingView',
  'evolutionView',
  'questLogView',
  'healView',
  'shopView',
  'tradeView',
  'pvpView',
  'leaderboardView',
  'renameView',
  'tradeProposeView',
  'helpView',
  'menuView',
  'claimView',
  'privacyView',
  'controlsView',
  'social',
];

const openOf = (accel: MenuAccel): AccelDecision => ({
  kind: 'open',
  path: EXPECTED_PATHS[accel],
});

/** The menu entry a path's keys name, root first; undefined when a key is not on its level. */
function leafOf(menu: readonly string[]): MenuEntry | undefined {
  let rows: readonly MenuEntry[] = MENU_ENTRIES;
  let entry: MenuEntry | undefined;
  for (const [i, key] of menu.entries()) {
    entry = rows.find((r) => r.key === key);
    if (entry === undefined) return undefined;
    if (i < menu.length - 1) {
      if (entry.kind !== 'group') return undefined;
      rows = entry.children;
    }
  }
  return entry;
}

describe('accelerator paths and decisions (ctl-11a)', () => {
  it('CTL11A-1-PATHS: ACCEL_PATHS is exactly the nine canonical paths (B and V share the Monsters frame and differ in the tab), its keys are every accelerator but F8 and F9, and each path walks the real menu table to a leaf that opens that frame', () => {
    // WRONG IMPL KILLED: a swapped tab (B on Party, V on Storage), a swapped pair of keys
    // (J -> Bag), a path through a group that does not exist (the picks would be no-ops: the menu
    // opens and nothing shows), a leaf key that is not a leaf of that group (`name` under Social),
    // a frame that is not the one the leaf opens (the own-screen Start test would never fire), a
    // missing row (N or C), a stray F8 or F9 row (the shell's own keys would open menus), and a
    // `tab` on a screen that has none.
    expect(ACCEL_PATHS).toEqual(EXPECTED_PATHS);
    expect(Object.keys(ACCEL_PATHS).sort(), 'every accelerator but F8 and F9').toEqual(
      ACCELS.filter((a) => a !== 'F8' && a !== 'F9').sort(),
    );
    expect(Object.keys(ACCEL_PATHS), 'ANTI-VACUITY: nine paths').toHaveLength(9);
    expect(Object.keys(ACCEL_PATHS), 'F8 and F9 are the shell`s own').not.toContain('F8');
    expect(Object.keys(ACCEL_PATHS)).not.toContain('F9');
    for (const accel of MENU_ACCELS) {
      expect(ACCEL_PATHS[accel].tab, `${accel}: only B and V carry a tab`).toBe(
        EXPECTED_PATHS[accel].tab,
      );
    }

    // Each path resolves through the menu model to an `open` leaf whose frame it names.
    const PANEL_TARGETS = ['tradeView', 'pvpView', 'leaderboardView'];
    for (const accel of MENU_ACCELS) {
      const path = ACCEL_PATHS[accel];
      const leaf = leafOf(path.menu);
      expect(leaf?.kind, `${accel}: ${path.menu.join(' > ')} ends on an open leaf`).toBe('open');
      if (leaf?.kind !== 'open') continue;
      const frame = PANEL_TARGETS.includes(leaf.target) ? 'social' : leaf.target;
      expect(path.frame, `${accel}: the leaf's overlay is the path's frame`).toBe(frame);
    }
  });

  it('CTL11A-1-DECIDE: an accelerator opens its path at the world, over a battle base, over any other player screen and over the menu, and acts as Start (never a re-open) when its own screen is the top frame, including V with the Monsters frame up and P with Social up', () => {
    // WRONG IMPL KILLED: an `open` that is always the answer (pressing J in the Journal would
    // rebuild it instead of closing it: the operator's "accelerator acts as Start"), a `start`
    // that fires when the own frame is merely somewhere in the stack (J over [Journal, Help] would
    // pop to the world instead of replacing Help), a `start` keyed to the key instead of the frame
    // (V with the box up would re-open Party instead of closing it), a start keyed to the whole
    // path (B and V share a frame; U, P and L share one), an `open` that refuses over another
    // player screen (the one-key replace), a decision that depends on the base (battle or world),
    // a path object that is not the table's row, and one that mutates its input stack.
    let rows = 0;
    for (const accel of MENU_ACCELS) {
      const own = EXPECTED_PATHS[accel].frame;
      const open = openOf(accel);
      const label = (s: string): string => `${accel}: ${s}`;

      expect(accelDecision(accel, frozenStack(WORLD_BASE)), label('at the world')).toEqual(open);
      expect(accelDecision(accel, frozenStack(battleBase('7'))), label('at a battle base')).toEqual(
        open,
      );
      expect(
        accelDecision(accel, frozenStack(WORLD_BASE, screenFrame('menuView'))),
        label('over the menu'),
      ).toEqual(open);
      expect(
        accelDecision(accel, frozenStack(battleBase('7'), stampedFrame('menuView', '7'))),
        label('over the menu over a battle'),
      ).toEqual(open);
      // (The menu itself is driven above; it cannot sit beneath itself.)
      for (const other of PLAYER_FRAMES.filter((f) => f !== own && f !== 'menuView')) {
        expect(
          accelDecision(accel, frozenStack(WORLD_BASE, screenFrame(other))),
          label(`over ${other}`),
        ).toEqual(open);
        expect(
          accelDecision(
            accel,
            frozenStack(WORLD_BASE, screenFrame('menuView'), screenFrame(other)),
          ),
          label(`over the menu then ${other}`),
        ).toEqual(open);
        expect(
          accelDecision(
            accel,
            frozenStack(battleBase('7'), stampedFrame('menuView', '7'), stampedFrame(other, '7')),
          ),
          label(`over a battle, the menu and ${other}`),
        ).toEqual(open);
        rows += 3;
      }
      // The own screen buried under another frame is not the top: still an open.
      expect(
        accelDecision(accel, frozenStack(WORLD_BASE, screenFrame(own), screenFrame('helpView'))),
        label('own frame under Help'),
      ).toEqual(open);
      expect(
        accelDecision(
          accel,
          frozenStack(
            WORLD_BASE,
            screenFrame('menuView'),
            screenFrame(own),
            screenFrame('helpView'),
          ),
        ),
        label('own frame under Help, over the menu'),
      ).toEqual(open);

      // Its own screen on top: Start, whatever lies beneath.
      const start: AccelDecision = { kind: 'start' };
      expect(accelDecision(accel, frozenStack(WORLD_BASE, screenFrame(own))), label('own')).toEqual(
        start,
      );
      expect(
        accelDecision(accel, frozenStack(WORLD_BASE, screenFrame('menuView'), screenFrame(own))),
        label('own over the menu'),
      ).toEqual(start);
      expect(
        accelDecision(
          accel,
          frozenStack(battleBase('7'), stampedFrame('menuView', '7'), stampedFrame(own, '7')),
        ),
        label('own over the menu over a battle'),
      ).toEqual(start);
      expect(
        accelDecision(accel, frozenStack(WORLD_BASE, screenFrame('helpView'), screenFrame(own))),
        label('own over Help'),
      ).toEqual(start);
      rows += 8;

      // Every other accelerator that shares the frame is Start too (V with the box, P with Social).
      for (const mate of MENU_ACCELS.filter(
        (m) => m !== accel && EXPECTED_PATHS[m].frame === own,
      )) {
        expect(
          accelDecision(mate, frozenStack(WORLD_BASE, screenFrame(own))),
          `${mate} with ${accel}'s frame on top`,
        ).toEqual({ kind: 'start' });
        rows += 1;
      }
    }
    expect(rows, 'ANTI-VACUITY: the whole matrix was driven').toBeGreaterThan(300);
  });

  it('CTL11A-2-DECIDE-DENIED: every accelerator is denied while the top frame is a dialogue screen, a battle outcome screen, a text entry or a prompt (at the world and over a battle, with a menu beneath, and even when the frame is the accelerator`s own), and only the TOP frame decides', () => {
    // WRONG IMPL KILLED: a denial that checks the dialogue only (a text entry would take the J that
    // was typed into the Name field), one that forgets the prompt (Y/N confirms would be replaced
    // by a letter), a text entry owned by the accelerator's own frame reading as `start` (N typed
    // in the rename field would close the screen the player is typing in), a prompt of the own
    // frame reading as `start`, a denial that scans the whole stack (a suspended dialogue under a
    // menu over a battle would lock every accelerator for good: the top there is the menu), one
    // that looks at the base instead of the top, and `denied` returned for the plain world (the
    // control rows).
    const tops: ReadonlyArray<readonly [string, UpperFrame]> = [
      ['a dialogue screen', screenFrame('dialogueView')],
      ['a battle outcome screen', screenFrame('battleView')],
      ['a rename text entry', textEntryFrame('renameView')],
      ['a text entry owned by the Monsters frame', textEntryFrame('boxView')],
      ['a pvp prompt', promptFrame('pvpView')],
      ['a Social prompt', promptFrame('social')],
    ];
    const denied: AccelDecision = { kind: 'denied' };
    let rows = 0;
    for (const accel of MENU_ACCELS) {
      const own = EXPECTED_PATHS[accel].frame;
      const withOwn: ReadonlyArray<readonly [string, UpperFrame]> = [
        ...tops,
        [`a text entry owned by ${own}`, textEntryFrame(own)],
        [`a prompt of ${own}`, promptFrame(own)],
      ];
      for (const [name, top] of withOwn) {
        const stacks: ReadonlyArray<readonly [string, Stack]> = [
          ['at the world', frozenStack(WORLD_BASE, top)],
          ['over the menu', frozenStack(WORLD_BASE, screenFrame('menuView'), top)],
          ['over its own screen', frozenStack(WORLD_BASE, screenFrame(own), top)],
          ['over a battle base', frozenStack(battleBase('7'), top)],
          [
            'over a battle and a stamped menu',
            frozenStack(battleBase('7'), stampedFrame('menuView', '7'), top),
          ],
        ];
        for (const [where, stack] of stacks) {
          expect(accelDecision(accel, stack), `${accel} / ${name} ${where}`).toEqual(denied);
          rows += 1;
        }
      }

      // Only the top frame decides: a player frame above a server frame, a text entry or a prompt
      // lets the accelerator through.
      for (const [name, below] of tops) {
        expect(
          accelDecision(accel, frozenStack(battleBase('7'), below, stampedFrame('menuView', '7'))),
          `${accel}: the menu above ${name} is the top`,
        ).toEqual(openOf(accel));
        rows += 1;
      }
      // Control: the plain world and a bare battle are never denied.
      expect(accelDecision(accel, frozenStack(WORLD_BASE))).toEqual(openOf(accel));
      expect(accelDecision(accel, frozenStack(battleBase('7')))).toEqual(openOf(accel));
    }
    expect(rows, 'ANTI-VACUITY: the whole matrix was driven').toBeGreaterThan(300);
    expect(
      PLAYER_FRAMES.length + 2,
      'ANTI-VACUITY: the player roster plus the two server frames is every frame id',
    ).toBe(OVERLAY_IDS.length + 1);
  });

  it('CTL11A-3-ROUTER-WORLD: Q, E, PageUp and PageDown are LB and RB through the default bindings and no accelerator, and an LB or RB press at the world leaves an `unhandled` adapter unconsumed with no effect, passes an adapter`s command through, and does nothing on release or with no adapter', () => {
    // WRONG IMPL KILLED: a router that consumes LB/RB at the world (the browser's PageUp/PageDown
    // scroll would be eaten for nothing, and Q/E would swallow typing), one that turns a world LB
    // or RB into a walk, a jump or a menu effect, an LB/RB that is dropped when an adapter DOES
    // answer (a tabbed screen's switch would never arrive), a release that asks the adapter again
    // (two tab switches per press), a press that asks it with a repeat flag, and a Q/E still bound
    // as an accelerator (one key, two owners: the migration rule's collision).
    const pairs: ReadonlyArray<readonly [string, VButton]> = [
      ['KeyQ', 'LB'],
      ['PageUp', 'LB'],
      ['KeyE', 'RB'],
      ['PageDown', 'RB'],
    ];
    const CMD: ScreenResult = { kind: 'popToBase' };
    for (const [code, button] of pairs) {
      expect(accelForCode(DEFAULT_BINDINGS, code), `${code} is no accelerator`).toBe(undefined);
      const edges = new KeyboardSource(DEFAULT_BINDINGS).keydown({ code });
      expect(edges, `${code} is ${button} through the default bindings`).toEqual([
        { button, down: true },
      ]);

      // An adapter that does not take it: not consumed, no effect, asked once, fresh.
      const seen: NavInput[] = [];
      const ctx: RouteContext = {
        worldActive: true,
        screen: (btn) => {
          seen.push(btn);
          return 'unhandled';
        },
      };
      const router = new InputRouter();
      expect(router.route(edge(button, true), ctx), `${code}: world, unhandled`).toEqual({
        consumed: false,
        effects: [],
      });
      expect(seen, `${code}: asked once, fresh`).toEqual([{ button, repeat: false }]);
      expect(router.route(edge(button, false), ctx), `${code}: the release`).toEqual({
        consumed: false,
        effects: [],
      });
      expect(seen.length, `${code}: the release asks nobody`).toBe(1);

      // No adapter at all: nothing.
      expect(new InputRouter().route(edge(button, true), WORLD), `${code}: no adapter`).toEqual({
        consumed: false,
        effects: [],
      });

      // An adapter that answers with a command: it comes through, consumed.
      expect(
        new InputRouter().route(edge(button, true), { worldActive: true, screen: () => CMD }),
        `${code}: a command passes through`,
      ).toEqual({ consumed: true, effects: [commandEffect(CMD)] });
    }
  });
});

// ==========================================================================================
// ctl-11b: focus outside #game-screen belongs to the browser (CTL11B.1)
// ==========================================================================================
//
// `outsideGameScreen(target, screen)` is true exactly when the target is an element (a string
// `tagName`) that is not BODY or HTML, a game screen exists, and the screen does not contain it.
// `ownership(target, event, screen = null)` asks it FIRST: an element outside the screen owns EVERY
// key (so the router touches no key and the page keeps Escape, Enter, F9, the D-pad and the
// accelerators). `worldHasFocus` (the legacy focus ladder this replaces; main.ts) is deleted with
// this slice, and the named survivors of its S5T-GATE cases are these four cases plus the booted
// CTL11B-1-BOOT-* cases in main.a11yFocus.test.ts.
//
// Targets are structural fakes and the screen a structural `contains` over a fixed set of nodes,
// so no DOM is involved. Every expected verdict is a hard-coded literal.

/** A structural element: only what `outsideGameScreen` and `ownership` read. */
const fakeEl = (tagName: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tagName,
  ...extra,
});

/** A game screen that contains exactly `inside`, as `Node.contains` answers (by identity). */
const screenHolding = (...inside: unknown[]): { contains(node: unknown): boolean } => ({
  contains: (node: unknown): boolean => inside.includes(node),
});

/** Keys of every kind: Start, A, the D-pad (letter and arrow), B, the F-keys, an accelerator, the
 *  jump, a stray letter and Tab. None may be routed from outside the screen. */
const EVERY_KIND_OF_KEY = [
  'Escape',
  'Enter',
  'NumpadEnter',
  'KeyB',
  'KeyW',
  'ArrowUp',
  'ArrowDown',
  'Backspace',
  'F9',
  'F8',
  'Space',
  'KeyM',
  'KeyZ',
  'Tab',
];

describe('ownership outside #game-screen (ctl-11b, CTL11B.1)', () => {
  it('CTL11B-1-OWN-OUTSIDE: an element outside the game screen (a button, div, canvas, link, text field, select or contentEditable) owns every key, Escape, Enter, B, F9 and the D-pad included, and outsideGameScreen reads true for it; the same keys on it are the router`s once the screen holds it', () => {
    // WRONG IMPL KILLED: an outside rule that is missing (the old ownership answers `router` for a
    // div or canvas and for Escape or Enter on a field, so the game takes keys from a page control
    // that is not part of it), one that covers only the form controls (a div or canvas outside the
    // screen would still be routed), one that covers only some keys (Escape, F9 or the D-pad
    // forgotten: the page's own Escape would open the menu), one decided AFTER the field and button
    // rules (Escape on an outside text input stays `router`), one that ignores the screen argument
    // (the control rows: the very same element INSIDE the screen is not outside), and an
    // `outsideGameScreen` that is true for everything (the inside control).
    const outsiders: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['button', fakeEl('BUTTON')],
      ['div', fakeEl('DIV')],
      ['canvas', fakeEl('CANVAS')],
      ['anchor', fakeEl('A')],
      ['text input', fakeEl('INPUT', { type: 'text' })],
      ['textarea', fakeEl('TEXTAREA')],
      ['select', fakeEl('SELECT')],
      ['contentEditable div', fakeEl('DIV', { isContentEditable: true })],
    ];
    let rows = 0;
    for (const [label, target] of outsiders) {
      const screen = screenHolding(); // holds nothing: every target is outside it
      expect(outsideGameScreen(target, screen), `${label}: outside the screen`).toBe(true);
      for (const code of EVERY_KIND_OF_KEY) {
        expect(ownership(target, { code }, screen), `${label} / ${code}`).toBe('target');
        rows += 1;
      }
      // A composition is the target's too (it was before; it must stay so).
      expect(ownership(target, { code: 'KeyW', isComposing: true }, screen), `${label} IME`).toBe(
        'target',
      );
    }
    expect(rows, 'ANTI-VACUITY: every element kind x every key was driven').toBe(
      outsiders.length * EVERY_KIND_OF_KEY.length,
    );

    // Control: with the screen holding the element, the outside rule no longer applies, and a
    // canvas or div is the router's again (so the `target` rows above are the rule's doing).
    for (const [label, target] of outsiders.filter(
      ([name]) => name === 'canvas' || name === 'div',
    )) {
      const screen = screenHolding(target);
      expect(outsideGameScreen(target, screen), `${label}: inside the screen`).toBe(false);
      for (const code of ['Escape', 'Enter', 'KeyB', 'KeyW', 'ArrowUp', 'Backspace', 'F9']) {
        expect(ownership(target, { code }, screen), `${label} inside / ${code}`).toBe('router');
      }
    }
    // The screen argument is what decides: the same canvas with NO screen argument is the router's.
    expect(ownership(fakeEl('CANVAS'), { code: 'Escape' }), 'a canvas, no screen given').toBe(
      'router',
    );
  });

  it('CTL11B-1-OWN-BODY: <body> and <html> are not outside the game screen even though the screen does not contain them, and neither is a target that is no element (the window, null, undefined, a bare object, a number): outsideGameScreen reads false and the keys are the router`s', () => {
    // WRONG IMPL KILLED: an outside rule written as `!screen.contains(target)` alone (focus on the
    // page, the state after a close and the one every key starts from, would be the browser's:
    // every key dead at the world), one that exempts <body> but not <html>, one that treats the
    // window or a null target as an element outside the screen (a keydown dispatched at `window`
    // would then never be routed), and one that exempts the body only when the key is a letter.
    const notOutside: ReadonlyArray<readonly [string, unknown]> = [
      ['body', fakeEl('BODY')],
      ['html', fakeEl('HTML')],
      ['window-like', { addEventListener: () => undefined, document: {} }],
      ['bare object', {}],
      ['null', null],
      ['undefined', undefined],
      ['number', 7],
      ['string', 'BUTTON'],
    ];
    const screen = screenHolding(); // holds none of them
    for (const [label, target] of notOutside) {
      expect(outsideGameScreen(target, screen), `${label}: not outside`).toBe(false);
      for (const code of [
        'KeyW',
        'Escape',
        'Enter',
        'KeyB',
        'ArrowUp',
        'Backspace',
        'F9',
        'KeyZ',
      ]) {
        expect(ownership(target, { code }, screen), `${label} / ${code}`).toBe('router');
      }
    }
    // Control: an element IS outside the very same screen, so the verdicts above are not a screen
    // that never says outside.
    expect(outsideGameScreen(fakeEl('BUTTON'), screen), 'control: a button is outside').toBe(true);
  });

  it('CTL11B-1-OWN-INSIDE: an element inside the game screen keeps the existing rules: a canvas or div is the router`s for W and Escape, a focused button owns Space and Enter but not Escape or W, a text field owns every key but Escape and Enter, a composition owns everything, and outsideGameScreen reads false for each', () => {
    // WRONG IMPL KILLED: an outside rule that also steals keys INSIDE the screen (the canvas could
    // not walk), one that swallows the existing button rule (a focused chip would lose its Space and
    // Enter activation, or would own Escape and block Start), one that swallows the field rule (a
    // typed letter would walk or open an accelerator, Escape in the field could never stop typing),
    // and one that lets the screen argument override the IME rule.
    const canvas = fakeEl('CANVAS');
    const div = fakeEl('DIV');
    const button = fakeEl('BUTTON');
    const anchor = fakeEl('A');
    const field = fakeEl('INPUT', { type: 'text' });
    const editable = fakeEl('DIV', { isContentEditable: true });
    const screen = screenHolding(canvas, div, button, anchor, field, editable);
    for (const [label, target] of [
      ['canvas', canvas],
      ['div', div],
      ['button', button],
      ['anchor', anchor],
      ['text input', field],
      ['contentEditable', editable],
    ] as const) {
      expect(outsideGameScreen(target, screen), `${label}: inside the screen`).toBe(false);
    }

    for (const code of ['KeyW', 'Escape', 'Enter', 'KeyB', 'ArrowUp', 'Backspace', 'Space', 'F9']) {
      expect(ownership(canvas, { code }, screen), `canvas / ${code}`).toBe('router');
      expect(ownership(div, { code }, screen), `div / ${code}`).toBe('router');
    }
    for (const [label, target] of [
      ['button', button],
      ['anchor', anchor],
    ] as const) {
      for (const code of ['Space', 'Enter', 'NumpadEnter']) {
        expect(ownership(target, { code }, screen), `${label} / ${code}`).toBe('target');
      }
      for (const code of ['Escape', 'KeyW', 'KeyB', 'ArrowUp', 'Backspace', 'F9']) {
        expect(ownership(target, { code }, screen), `${label} / ${code}`).toBe('router');
      }
    }
    for (const [label, target] of [
      ['text input', field],
      ['contentEditable', editable],
    ] as const) {
      for (const code of ['KeyB', 'KeyW', 'Space', 'ArrowUp', 'Backspace', 'KeyM', 'F9']) {
        expect(ownership(target, { code }, screen), `${label} / ${code}`).toBe('target');
      }
      for (const code of ['Escape', 'Enter', 'NumpadEnter']) {
        expect(ownership(target, { code }, screen), `${label} / ${code}`).toBe('router');
      }
    }
    expect(ownership(canvas, { code: 'KeyW', isComposing: true }, screen), 'IME').toBe('target');
    expect(ownership(canvas, { code: 'Escape', keyCode: 229 }, screen), 'IME 229').toBe('target');

    // The screen element itself: Node.contains(self) is true, so it is never outside.
    const root = fakeEl('DIV');
    expect(outsideGameScreen(root, screenHolding(root)), 'the screen itself').toBe(false);
  });

  it('CTL11B-1-OWN-NO-SCREEN: with no game screen (a shell-less boot) nothing is outside: outsideGameScreen reads false for every element kind, and ownership is exactly the two-argument verdict, a div, canvas or button keeping its router verdict for W, Escape and F9', () => {
    // WRONG IMPL KILLED: a null screen read as "everything is outside" (a shell-less boot, the
    // unit harnesses and any page without #game-screen would route no key at all), one that throws
    // on null (`screen.contains` with no guard), a default parameter that is not `null` (the
    // two-argument call would then differ from the explicit null), and an outside rule that
    // consults the target but not the screen.
    const kinds: ReadonlyArray<readonly [string, unknown]> = [
      ...ROUTER_TARGETS,
      ...FIELD_TARGETS,
      ...NATIVE_ACTIVATORS,
      ['anchor', fakeEl('A')],
    ];
    let rows = 0;
    for (const [label, target] of kinds) {
      expect(outsideGameScreen(target, null), `${label}: no screen, not outside`).toBe(false);
      for (const code of ALL_CODES) {
        const two = ownership(target, { code });
        expect(ownership(target, { code }, null), `${label} / ${code}`).toBe(two);
        expect(ownership(target, { code }, undefined), `${label} / ${code} (undefined)`).toBe(two);
        rows += 1;
      }
    }
    expect(rows, 'ANTI-VACUITY: every target kind x every code was compared').toBe(
      kinds.length * ALL_CODES.length,
    );
    // The two-argument verdicts themselves, pinned as literals (equality alone would hold for a
    // rule that returned `target` for both spellings).
    for (const tag of ['DIV', 'CANVAS', 'BUTTON']) {
      for (const code of ['KeyW', 'Escape', 'F9', 'Backspace']) {
        expect(ownership(fakeEl(tag), { code }, null), `${tag} / ${code}`).toBe('router');
      }
    }
    expect(ownership(fakeEl('BUTTON'), { code: 'Space' }, null), 'button / Space').toBe('target');
    expect(ownership(fakeEl('INPUT'), { code: 'KeyB' }, null), 'input / KeyB').toBe('target');
  });
});
