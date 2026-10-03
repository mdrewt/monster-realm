/**
 * screens/index.test.ts: the adapter table and the screen host (ctl-6b, CTL6B.1 / CTL6B.2 /
 * CTL6B.5 / CTL6B.6; ctl-7c, CTL7C.1 / CTL7C.2).
 *
 * Pure, node env. `SCREEN_ADAPTERS` is a total `Record<FrameId, ScreenAdapter>` (every entry the
 * legacy adapter until its ctl-8 slice swaps it); `baseButton(base, btn)` is what Start / Select / B
 * do with no frame above the base; `new ScreenHost(adapters, viewOf, onPaintError)` routes a button
 * to the TOP frame only (`host.button(stack, btn, ctx)`): the base to `baseButton`, a text-entry
 * frame to the typing rules, a screen / prompt frame to its own adapter fed its OWN view model.
 * ctl-7c: the host also keeps one adapter state per frame id (from `init(vm)` until the frame is
 * opened again), paints each step into the view the shell lends for that id, and says whether the
 * top frame's adapter takes the D-pad (`host.takesNav(stack)`).
 * ctl-7d (CTL7D.6): after each store batch the shell calls `host.observe(stack, ctx)`, which runs
 * the optional `adapter.observe(vm, state, now)` of every screen / prompt frame on the stack,
 * keeps what it returns and paints a frame whose state changed.
 * ctl-8a (CTL8A.4): the shipped table's dialogue, shop and heal frames hold their own
 * nav-capable screens (`dialogueScreen`, `shopScreen`, `healScreen`); the other 14 stay legacy.
 * ctl-8b (CTL8B.4): the box frame (the Monsters frame) holds `monstersScreen`, nav-capable too; the
 * other 13 stay legacy. Named intentional changes in this file: the CONVERTED roster (so
 * CTL6B-1-ADAPTERS-TOTAL, CTL7C-1-NAV-CAPABLE and CTL7D-6-OBSERVE-SKIPS read 13 legacy ids), the
 * CTL7D-6-OBSERVE-SKIPS and CTL8A-4-ADAPTERS-SWAPPED probes that used `boxView` as "a legacy
 * frame" (now `questLogView`), and the new CTL8B-4-* cases at the end.
 *
 * Adapters are injected as recording stubs, so every routing claim is read off which stub was
 * called, with what, and what came back. The base cases inject adapters that THROW, so "the base
 * never consults an adapter" is a fact the run proves rather than an assumption.
 */
import { describe, expect, it, vi } from 'vitest';
import { party_slot_none } from '../../../../client-wasm/pkg/client_wasm.js';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import { VBUTTONS, type VButton } from '../../input/buttons';
import { KeyboardSource } from '../../input/keyboardSource';
import { InputRouter, type RouteContext, routedBindings } from '../../input/router';
import {
  type BaseFrame,
  type FrameId,
  popTop,
  type Stack,
  type UpperFrame,
  WORLD_STACK,
} from '../contextStack';
import type { NavInput } from '../nav';
import { OVERLAY_IDS } from '../overlayRegistry';
import { DIALOGUE_REVEAL_MS, dialogueScreen } from './dialogueScreen';
import { healScreen } from './healScreen';
import { baseButton, SCREEN_ADAPTERS, ScreenHost } from './index';
import { legacyAdapter } from './legacyAdapter';
import { monstersScreen } from './monstersScreen';
import { shopScreen } from './shopScreen';
import type { ScreenAdapter, ScreenContext, ScreenResult } from './types';

const CTX = {
  store: {},
  identity: 'ab'.repeat(32),
  bindings: DEFAULT_BINDINGS,
  now: () => 0,
} as unknown as ScreenContext;

const WORLD: BaseFrame = { kind: 'world' };
const battle = (battleId: string): BaseFrame => ({ kind: 'battle', battleId });
const screen = (id: FrameId): UpperFrame => ({ kind: 'screen', id });
const prompt = (id: FrameId): UpperFrame => ({ kind: 'prompt', id });
const textEntry = (owner: FrameId): UpperFrame => ({ kind: 'textEntry', owner });
const stackOf = (base: BaseFrame, ...upper: UpperFrame[]): Stack => [base, ...upper];
const nav = (button: VButton, repeat = false): NavInput => ({ button, repeat });

/** The buttons the router hands to a frame's adapter (a DOWN edge of any of these). */
const ROUTED: readonly VButton[] = ['A', 'B', 'Y', 'LB', 'RB', 'Start', 'Select'];

type Adapters = Readonly<Record<FrameId, ScreenAdapter<unknown, unknown>>>;

interface Call {
  readonly id: FrameId;
  readonly vm: unknown;
  readonly state: unknown;
  readonly btn: NavInput;
}
interface Recorder {
  readonly calls: Call[];
  readonly vmCalls: FrameId[];
}

/** One stub adapter per frame id: its view model names the id, its init state names the id, its
 *  onButton records, hands the state back unchanged and answers from `answer`. */
function stubAdapters(
  rec: Recorder,
  answer: (id: FrameId, btn: NavInput) => ScreenResult,
): Adapters {
  const out = {} as Record<FrameId, ScreenAdapter<unknown, unknown>>;
  for (const id of OVERLAY_IDS) {
    out[id] = {
      viewModel(ctx) {
        rec.vmCalls.push(id);
        return { vmOf: id, ctx };
      },
      init() {
        return { initOf: id };
      },
      onButton(vm, state, btn) {
        rec.calls.push({ id, vm, state, btn });
        return { state, result: answer(id, btn) };
      },
    };
  }
  return out;
}
const newRecorder = (): Recorder => ({ calls: [], vmCalls: [] });

/** Adapters that fail the run if anything consults them: a base frame must never reach one. */
function throwingAdapters(): Adapters {
  const out = {} as Record<FrameId, ScreenAdapter<unknown, unknown>>;
  for (const id of OVERLAY_IDS) {
    out[id] = {
      viewModel() {
        throw new Error(`the viewModel of ${id} must not be consulted here`);
      },
      init() {
        throw new Error(`the init of ${id} must not be consulted here`);
      },
      onButton() {
        throw new Error(`the adapter of ${id} must not be consulted here`);
      },
      paint() {
        throw new Error(`the paint of ${id} must not be consulted here`);
      },
    };
  }
  return out;
}

/** The shell's view table before main() has built any view. */
const noViews = (): undefined => undefined;
/** A view table that fails the run if a view is asked for. */
const throwingViews = (id: FrameId): never => {
  throw new Error(`the view of ${id} must not be lent here`);
};
/** A paint failure the case does not expect: it fails the run instead of being swallowed. */
const unexpectedPaintError = (err: unknown): void => {
  throw new Error(`unexpected paint error: ${String(err)}`);
};
/** A host over `adapters` with no views lent (no paint can happen). */
const hostOf = (adapters: Adapters): ScreenHost =>
  new ScreenHost(adapters, noViews, unexpectedPaintError);
/** A host whose adapters, views and paint-error sink all fail the run if consulted. */
const throwingHost = (): ScreenHost =>
  new ScreenHost(throwingAdapters(), throwingViews, unexpectedPaintError);

const POP: ScreenResult = { kind: 'pop' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const OPEN_MENU: ScreenResult = { kind: 'openMenu' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };

/** The frames the ctl-8 slices have converted, each to its own nav-capable screen adapter
 *  (ctl-8a: dialogue, shop, heal; ctl-8b: the box frame, which is the Monsters frame). */
const CONVERTED: ReadonlyMap<FrameId, unknown> = new Map<FrameId, unknown>([
  ['dialogueView', dialogueScreen],
  ['shopView', shopScreen],
  ['healView', healScreen],
  ['boxView', monstersScreen],
]);
/** Every overlay id still on the legacy adapter. */
const LEGACY_IDS: readonly FrameId[] = OVERLAY_IDS.filter((id) => !CONVERTED.has(id));

describe('SCREEN_ADAPTERS (ctl-6b)', () => {
  it('CTL6B-1-ADAPTERS-TOTAL: every overlay id has an adapter, the dialogue, shop and heal frames hold their own ctl-8a screens, the box frame its ctl-8b Monsters screen and every other one the legacy adapter, and the default table answers a legacy screen', () => {
    // WRONG IMPL KILLED: a table that omits an overlay (that frame would have no way to answer
    // B or Start), carries a stray id, holds a bespoke adapter before its ctl-8 slice lands, and a
    // host over SCREEN_ADAPTERS that does not answer a legacy screen as the legacy adapter does.
    // INTENTIONAL CHANGE (ctl-8a, CTL8A.4): dialogueView, shopView and healView now hold
    // dialogueScreen, shopScreen and healScreen (by identity). Was: every id `toBe(legacyAdapter)`,
    // and the host loop below drove all 17 ids. The other 14 are still the legacy adapter and the
    // loop still drives each of them exactly as before.
    // INTENTIONAL CHANGE (ctl-8b, CTL8B.4): boxView now holds monstersScreen (by identity), so the
    // legacy roster is 13 ids. Was: 14.
    expect([...Object.keys(SCREEN_ADAPTERS)].sort()).toEqual([...OVERLAY_IDS].sort());
    expect(LEGACY_IDS, 'ANTI-VACUITY: 13 legacy ids').toHaveLength(13);
    expect(LEGACY_IDS.includes('boxView'), 'boxView is no longer legacy').toBe(false);
    expect(LEGACY_IDS.length + CONVERTED.size, 'ANTI-VACUITY: every id is one or the other').toBe(
      OVERLAY_IDS.length,
    );
    for (const id of OVERLAY_IDS) {
      const own = CONVERTED.get(id);
      if (own === undefined) {
        expect(SCREEN_ADAPTERS[id], `${id} is the legacy adapter`).toBe(legacyAdapter);
      } else {
        expect(SCREEN_ADAPTERS[id], `${id} is its own ctl-8a screen`).toBe(own);
      }
      expect(typeof SCREEN_ADAPTERS[id].viewModel, `${id}.viewModel`).toBe('function');
      expect(typeof SCREEN_ADAPTERS[id].onButton, `${id}.onButton`).toBe('function');
    }

    // The default adapter table, read through a host built over SCREEN_ADAPTERS.
    const host = new ScreenHost(SCREEN_ADAPTERS, noViews, unexpectedPaintError);
    for (const id of LEGACY_IDS) {
      const over = stackOf(WORLD, screen(id));
      expect(host.button(over, nav('B'), CTX), `${id} B`).toEqual({ kind: 'pop' });
      expect(host.button(over, nav('Start'), CTX), `${id} Start`).toEqual({ kind: 'popToBase' });
      expect(host.button(over, nav('Select'), CTX), `${id} Select`).toEqual({
        kind: 'toggleHelp',
      });
      expect(host.button(over, nav('A'), CTX), `${id} A (native Enter)`).toBe('unhandled');
    }
  });

  it('CTL6B-1-TOP-FRAME-ROUTES: only the TOP frame`s adapter is consulted, with its own view model and the button, over either base and for screen and prompt frames', () => {
    // WRONG IMPL KILLED: a router that asks the bottom frame (B would act on the menu under a
    // child), one that asks every frame, one that builds its view model from another frame's id,
    // one that drops or rewrites the button, one that swallows or rewrites the adapter's answer,
    // and one that forgets the context (screens read the store through it).
    const answers: Record<string, ScreenResult> = {
      A: 'unhandled',
      B: POP,
      Y: { kind: 'dismissDialogue' },
      LB: 'consumed',
      RB: { kind: 'toggleHelp' },
      Start: POP_TO_BASE,
      Select: { kind: 'toggleHelp' },
    };
    let checked = 0;
    for (const id of OVERLAY_IDS) {
      const lower = OVERLAY_IDS.filter((o) => o !== id).slice(0, 2);
      for (const base of [WORLD, battle('7')]) {
        for (const kind of ['screen', 'prompt'] as const) {
          const top = kind === 'screen' ? screen(id) : prompt(id);
          const stack = stackOf(base, ...lower.map(screen), top);
          for (const button of ROUTED) {
            const rec = newRecorder();
            const adapters = stubAdapters(rec, (_id, btn) => answers[btn.button] ?? 'unhandled');
            const btn = nav(button);
            const label = `${id} (${kind}) over ${base.kind} / ${button}`;
            const result = hostOf(adapters).button(stack, btn, CTX);
            expect(result, `${label}: the adapter's answer is returned as is`).toEqual(
              answers[button],
            );
            expect(rec.calls.length, `${label}: exactly one adapter call`).toBe(1);
            const call = rec.calls[0] as Call;
            expect(call.id, `${label}: the top frame's adapter`).toBe(id);
            expect(call.btn, `${label}: the button`).toEqual({ button, repeat: false });
            // ctl-7c (call shape): a frame's first step runs on the state its OWN init returned.
            expect(call.state, `${label}: the state its own init returned`).toEqual({ initOf: id });
            expect(call.vm, `${label}: its own view model, built from the context`).toEqual({
              vmOf: id,
              ctx: CTX,
            });
            expect((call.vm as { ctx: unknown }).ctx, `${label}: the same context object`).toBe(
              CTX,
            );
            expect(rec.vmCalls, `${label}: only the top frame's view model is built`).toEqual([id]);
            checked += 1;
          }
        }
      }
    }
    expect(checked, 'ANTI-VACUITY: every id x base x kind x button was driven').toBe(
      OVERLAY_IDS.length * 2 * 2 * ROUTED.length,
    );

    // A repeat-flagged button reaches the adapter flagged (the adapter decides what a repeat means).
    const rec = newRecorder();
    const adapters = stubAdapters(rec, () => 'consumed');
    hostOf(adapters).button(stackOf(WORLD, screen('boxView')), nav('B', true), CTX);
    expect((rec.calls[0] as Call).btn).toEqual({ button: 'B', repeat: true });
  });
});

describe('base frames (ctl-6b, CTL6B.2)', () => {
  const WORLD_TABLE: Record<VButton, ScreenResult> = {
    Up: 'unhandled',
    Down: 'unhandled',
    Left: 'unhandled',
    Right: 'unhandled',
    A: 'unhandled',
    B: 'consumed',
    X: 'unhandled',
    Y: 'unhandled',
    LB: 'unhandled',
    RB: 'unhandled',
    Start: OPEN_MENU,
    Select: TOGGLE_HELP,
  };
  const BATTLE_TABLE: Record<VButton, ScreenResult> = {
    ...WORLD_TABLE,
    // B17: Start on an ongoing battle does nothing in this slice (ctl-6c gives it the menu).
    Start: 'consumed',
  };

  it('CTL6B-2-WORLD-START-OPENS-MENU: at the world base Start opens the menu, Select toggles help, B is swallowed and everything else is the page`s', () => {
    // WRONG IMPL KILLED: a Start that pops (there is nothing to pop at a base), one that does not
    // open the menu, a Select that is not help, a B that falls through to the page (Backspace
    // navigates the browser back), a D-pad / A / X that is swallowed (the world's own walk and
    // jump must stay the router's), and a base that consults an adapter.
    expect([...Object.keys(WORLD_TABLE)].sort(), 'the table covers every button').toEqual(
      [...VBUTTONS].sort(),
    );
    for (const button of VBUTTONS) {
      expect(baseButton(WORLD, nav(button)), `baseButton ${button}`).toEqual(WORLD_TABLE[button]);
      expect(throwingHost().button(WORLD_STACK, nav(button), CTX), `host.button ${button}`).toEqual(
        WORLD_TABLE[button],
      );
    }
  });

  it('CTL6B-2-BATTLE-START-INERT: at a battle base Start is swallowed and opens nothing, while Select still toggles help and B is swallowed', () => {
    // WRONG IMPL KILLED (B17): a Start at a battle base that opens the menu (ctl-6c's job), pops,
    // or falls through to the ladder (which would hide the battle); a battle base that treats B as
    // the page's; a Select that is lost; and a battle base that consults an adapter.
    for (const button of VBUTTONS) {
      expect(baseButton(battle('7'), nav(button)), `baseButton ${button}`).toEqual(
        BATTLE_TABLE[button],
      );
      expect(
        throwingHost().button(stackOf(battle('7')), nav(button), CTX),
        `host.button ${button}`,
      ).toEqual(BATTLE_TABLE[button]);
    }
    expect(baseButton(battle('7'), nav('Start'))).not.toEqual(OPEN_MENU);
    expect(baseButton(battle('7'), nav('Start'))).not.toEqual(POP_TO_BASE);
    // The world and the battle differ in exactly one cell: Start.
    const differing = VBUTTONS.filter(
      (b) =>
        JSON.stringify(baseButton(WORLD, nav(b))) !==
        JSON.stringify(baseButton(battle('7'), nav(b))),
    );
    expect(differing).toEqual(['Start']);
  });
});

describe('typing mode (ctl-6b, CTL6B.5)', () => {
  const OWNER_COMMANDS: Record<string, ScreenResult> = {
    renameView: { kind: 'setProfileName', name: 'Zed' },
    tradeProposeView: { kind: 'proposeTrade', args: { marker: 'offer' } as never },
  };

  it('CTL6B-5-TEXTENTRY-ESCAPE-STOPS: over a text-entry frame Start stops typing by popping that frame only, and every other button belongs to the field', () => {
    // WRONG IMPL KILLED: a Start that pops to the base (the second Escape would be needed to act as
    // Start, and the first would close the owner too: the criterion says the owner stays), one that
    // is routed to the owner's adapter (the owner would have to know about typing), a B / D-pad /
    // Select / X that is handled (a Backspace typed in the field would pop the screen it is typed
    // in), and one that consults any adapter while the field owns the key.
    let owners = 0;
    for (const owner of OVERLAY_IDS) {
      const rec = newRecorder();
      const host = hostOf(stubAdapters(rec, () => 'consumed'));
      const stack = stackOf(WORLD, screen(owner), textEntry(owner));
      expect(host.button(stack, nav('Start'), CTX), `${owner}: Start`).toEqual(POP);
      // The pure rule the shell applies leaves the owner frame standing.
      expect(popTop(stack), `${owner}: the owner frame stays`).toEqual(
        stackOf(WORLD, screen(owner)),
      );
      for (const button of VBUTTONS) {
        if (button === 'Start' || button === 'A') continue;
        expect(host.button(stack, nav(button), CTX), `${owner}: ${button} is the field's`).toBe(
          'unhandled',
        );
      }
      expect(rec.calls, `${owner}: no adapter was consulted for typing`).toEqual([]);
      owners += 1;
    }
    expect(owners, 'ANTI-VACUITY: every overlay id was a text-entry owner').toBe(
      OVERLAY_IDS.length,
    );
  });

  it('CTL6B-5-TEXTENTRY-ENTER-COMMITS: over a text-entry frame A commits through the OWNER`s adapter and returns the owner`s command', () => {
    // WRONG IMPL KILLED: an A that is `unhandled` for a text-entry frame (the owner's Command is
    // the only commit path once a screen drops its own Enter listener), one that routes to the
    // frame below instead of the owner, one that builds the owner's view model from the wrong id,
    // one that swallows the owner's answer, and one that calls the owner twice.
    for (const [owner, command] of Object.entries(OWNER_COMMANDS)) {
      const rec = newRecorder();
      const adapters = stubAdapters(rec, (id) => (id === owner ? command : 'consumed'));
      // A different frame sits under the text entry, so "the frame below" is distinguishable.
      const stack = stackOf(WORLD, screen('menuView'), textEntry(owner as FrameId));
      const result = hostOf(adapters).button(stack, nav('A'), CTX);
      expect(result, `${owner}: the owner's command`).toEqual(command);
      expect(rec.calls.length, `${owner}: exactly one adapter call`).toBe(1);
      const call = rec.calls[0] as Call;
      expect(call.id, `${owner}: the owner's adapter`).toBe(owner);
      expect(call.btn, `${owner}: A`).toEqual({ button: 'A', repeat: false });
      // ctl-7c (call shape): the owner's step runs on the state the OWNER's init returned.
      expect(call.state).toEqual({ initOf: owner });
      expect(call.vm, `${owner}: its own view model`).toEqual({ vmOf: owner, ctx: CTX });
      expect(rec.vmCalls, `${owner}: only the owner's view model`).toEqual([owner]);
    }

    // Control: a screen frame (no text entry) on top routes A to its own adapter all the same.
    const rec = newRecorder();
    const adapters = stubAdapters(rec, () => ({ kind: 'claimJoin' }));
    expect(hostOf(adapters).button(stackOf(WORLD, screen('claimView')), nav('A'), CTX)).toEqual({
      kind: 'claimJoin',
    });
  });
});

describe('LB/RB only from PageUp/PageDown (ctl-6b, CTL6B.6)', () => {
  it('CTL6B-6-RB-REACHES-ADAPTER: PageDown on a tabbed screen reaches its adapter as RB through the routed bindings, PageUp as LB, and Q / E reach it as nothing', () => {
    // WRONG IMPL KILLED: a keyboard source built on the full binding table (Q / E would reach the
    // adapter as LB / RB while the ladder still owns them: one key, two owners), a router that
    // never consults the top frame's adapter for RB, an adapter that receives the wrong button, a
    // Command that is not turned into a router effect, and an up edge that calls the adapter again.
    const rec = newRecorder();
    const adapters = stubAdapters(rec, (_id, btn) =>
      btn.button === 'RB' ? TOGGLE_HELP : btn.button === 'LB' ? POP : 'unhandled',
    );
    const stack = stackOf(WORLD, screen('boxView'));
    const host = hostOf(adapters);
    const ctx: RouteContext = {
      worldActive: false,
      screen: (btn) => host.button(stack, btn, CTX),
    };
    const source = new KeyboardSource(routedBindings(DEFAULT_BINDINGS));
    const router = new InputRouter();

    const pageDown = source.keydown({ code: 'PageDown' });
    expect(pageDown, 'PageDown is RB').toEqual([{ button: 'RB', down: true }]);
    expect(router.route(pageDown[0] as { button: VButton; down: boolean }, ctx)).toEqual({
      consumed: true,
      effects: [{ kind: 'command', command: { kind: 'toggleHelp' } }],
    });
    expect(rec.calls.length, 'the adapter was asked once').toBe(1);
    expect((rec.calls[0] as Call).id).toBe('boxView');
    expect((rec.calls[0] as Call).btn).toEqual({ button: 'RB', repeat: false });

    const pageUp = source.keydown({ code: 'PageUp' });
    expect(pageUp, 'PageUp is LB').toEqual([{ button: 'LB', down: true }]);
    expect(router.route(pageUp[0] as { button: VButton; down: boolean }, ctx)).toEqual({
      consumed: true,
      effects: [{ kind: 'command', command: { kind: 'pop' } }],
    });
    expect((rec.calls[1] as Call).btn).toEqual({ button: 'LB', repeat: false });

    // The releases reach no adapter and consume nothing.
    for (const up of [...source.keyup({ code: 'PageDown' }), ...source.keyup({ code: 'PageUp' })]) {
      expect(router.route(up, ctx), `${up.button} up`).toEqual({ consumed: false, effects: [] });
    }
    expect(rec.calls.length, 'the up edges asked nobody').toBe(2);

    // Q and E are the ladder's until ctl-11a: no edge, so the adapter is never asked.
    for (const code of ['KeyQ', 'KeyE']) {
      expect(source.keydown({ code }), `${code} produces no edge`).toEqual([]);
      expect(source.keyup({ code }), `${code} release produces no edge`).toEqual([]);
    }
    expect(rec.calls.length, 'Q and E reached no adapter').toBe(2);
  });
});

// ==========================================================================================
// ctl-7c: nav-capable frames (CTL7C.1) and shell-hosted adapter state (CTL7C.2)
// ==========================================================================================
//
// `host.takesNav(stack)` is true when the TOP frame is a screen or prompt frame whose adapter is
// marked `nav`: the shell then hands that frame the D-pad (router.test.ts proves the delivery).
// `host.button` keeps one state per frame id: a step starts from the stored state, else from
// `adapter.init(vm)`, and stores the state the adapter returns. `host.opened(frame)` forgets a
// screen or prompt frame's state (a text entry types over its owner and forgets nothing). After
// each step the host paints once, into the view the shell lends for that id, with the view model
// the step saw and the state it produced. The stubs build a NEW view model object per call and a
// NEW state object per step, so "the same object" is an identity the run can check.

interface Counted {
  readonly of: FrameId;
  readonly n: number;
}
interface Stepped {
  readonly id: FrameId;
  readonly vm: unknown;
  readonly state: unknown;
  readonly next: Counted;
  readonly btn: NavInput;
}
interface Painted {
  readonly id: FrameId;
  readonly view: unknown;
  readonly vm: unknown;
  readonly state: unknown;
}
interface Log {
  readonly vms: unknown[];
  readonly inits: Array<{ readonly id: FrameId; readonly vm: unknown; readonly state: Counted }>;
  readonly steps: Stepped[];
  readonly paints: Painted[];
}
const newLog = (): Log => ({ vms: [], inits: [], steps: [], paints: [] });

const PAINT_FAILURE = new Error('the view could not paint');

interface CountingOpts {
  readonly nav?: boolean;
  /** `record` paints into the log; `throw` records the call, then throws PAINT_FAILURE. */
  readonly paint?: 'record' | 'throw';
  /** Each step hands back the very state it was given (an unchanged state). */
  readonly keepState?: boolean;
}

/** A stateful stub for `id`. Its state counts its own steps (`n`); each step answers a command
 *  carrying the new count, so a returned result shows which state the step ran on. */
function counting(id: FrameId, log: Log, opts: CountingOpts = {}): ScreenAdapter<unknown, unknown> {
  const paint = (view: unknown, vm: unknown, state: unknown): void => {
    log.paints.push({ id, view, vm, state });
    if (opts.paint === 'throw') throw PAINT_FAILURE;
  };
  return {
    ...(opts.nav === true ? { nav: true as const } : {}),
    viewModel() {
      const vm = { vmOf: id, seq: log.vms.length };
      log.vms.push(vm);
      return vm;
    },
    init(vm) {
      const state: Counted = { of: id, n: 0 };
      log.inits.push({ id, vm, state });
      return state;
    },
    onButton(vm, state, btn) {
      const prev = state as Partial<Counted> | undefined;
      // A state that is not this frame's own counter (a wrong host) still yields a value to check.
      const n = prev?.of === id && typeof prev.n === 'number' ? prev.n : -100;
      const next: Counted = opts.keepState === true ? (state as Counted) : { of: id, n: n + 1 };
      log.steps.push({ id, vm, state, next, btn });
      return { state: next, result: { kind: 'advanceDialogue', choiceIdx: next.n } };
    },
    ...(opts.paint === undefined ? {} : { paint }),
  };
}

/** `own` over a table whose every other adapter fails the run if consulted. */
const tableWith = (own: Partial<Record<FrameId, ScreenAdapter<unknown, unknown>>>): Adapters => ({
  ...throwingAdapters(),
  ...own,
});

/** A nav-capable adapter whose every method fails the run: only its `nav` mark may be read. */
const navOnly = (): ScreenAdapter<unknown, unknown> => ({
  nav: true,
  viewModel() {
    throw new Error('takesNav must not build a view model');
  },
  init() {
    throw new Error('takesNav must not init a state');
  },
  onButton() {
    throw new Error('takesNav must not step the adapter');
  },
  paint() {
    throw new Error('takesNav must not paint');
  },
});

const lastStep = (log: Log): Stepped => log.steps[log.steps.length - 1] as Stepped;
const choice = (n: number): ScreenResult => ({ kind: 'advanceDialogue', choiceIdx: n });

describe('ScreenHost (ctl-7c)', () => {
  it('CTL7C-1-NAV-CAPABLE: takesNav is true exactly when the top frame is a screen or prompt frame whose adapter is marked nav, wherever it sits, and deciding runs no adapter code', () => {
    // WRONG IMPL KILLED: a host that says yes for any screen on top (every legacy frame would get
    // arrows it never asked for and lose the world/swallow behaviour), one that reads the BOTTOM
    // frame or any frame on the stack (a nav frame covered by a legacy child would still take the
    // D-pad under it), one that resolves a text-entry top to its nav owner (arrows typed in a
    // field would move the owner's cursor), one that answers yes at a bare base, and one that
    // builds a view model or steps the adapter to decide (it runs on every key and every frame).
    const host = hostOf(tableWith({ questLogView: navOnly(), dialogueView: navOnly() }));
    const yes: ReadonlyArray<readonly [string, Stack]> = [
      ['a nav screen over the world', stackOf(WORLD, screen('questLogView'))],
      ['a nav prompt over the world', stackOf(WORLD, prompt('questLogView'))],
      [
        'a nav screen over the covered main menu',
        stackOf(WORLD, screen('menuView'), screen('questLogView')),
      ],
      ['a nav screen over a battle base', stackOf(battle('7'), screen('dialogueView'))],
      [
        'a nav prompt over a legacy frame',
        stackOf(WORLD, screen('boxView'), prompt('dialogueView')),
      ],
    ];
    const no: ReadonlyArray<readonly [string, Stack]> = [
      ['the bare world', WORLD_STACK],
      ['a bare battle base', stackOf(battle('7'))],
      ['a legacy screen on top', stackOf(WORLD, screen('boxView'))],
      ['a legacy prompt on top', stackOf(WORLD, prompt('pvpView'))],
      [
        'a nav frame covered by a legacy one',
        stackOf(WORLD, screen('questLogView'), screen('boxView')),
      ],
      [
        'a text entry over its nav owner',
        stackOf(WORLD, screen('questLogView'), textEntry('questLogView')),
      ],
      [
        'a text entry naming a nav owner over a legacy frame',
        stackOf(WORLD, screen('boxView'), textEntry('dialogueView')),
      ],
    ];
    for (const [label, stack] of yes) expect(host.takesNav(stack), label).toBe(true);
    for (const [label, stack] of no) expect(host.takesNav(stack), label).toBe(false);
    expect(yes.length + no.length, 'ANTI-VACUITY: both polarities are driven').toBe(12);

    // INTENTIONAL CHANGE (ctl-8a, CTL8A.4): the shipped table's dialogue, shop and heal frames are
    // nav-capable. Was: every id `false` ("the shipped table is all legacy"). Every other frame is
    // still legacy and takes no D-pad until its own ctl-8 screen lands.
    // INTENTIONAL CHANGE (ctl-8b, CTL8B.4): boxView joins them (CONVERTED holds it), so it takes the
    // D-pad too; the 13 legacy ids still do not.
    const shipped = hostOf(SCREEN_ADAPTERS);
    for (const id of OVERLAY_IDS) {
      const navCapable = CONVERTED.has(id);
      expect(shipped.takesNav(stackOf(WORLD, screen(id))), `${id} screen (shipped)`).toBe(
        navCapable,
      );
      expect(shipped.takesNav(stackOf(WORLD, prompt(id))), `${id} prompt (shipped)`).toBe(
        navCapable,
      );
    }
  });

  it('CTL7C-2-STATE-THREADS: a frame starts from its own init once and every step receives the state the previous step of THAT frame returned, frames interleaved stay isolated, a text entry threads its owner`s state, and the view model is built fresh once per step', () => {
    // WRONG IMPL KILLED: ONE shared state for every frame (the quest log would start from the box's
    // state, and the box resume from the quest log's), a state re-initialised on every step (a
    // cursor that can never move twice), a state never stored for a frame that was never opened
    // (init on every step), init fed a different view model than the step, the state keyed by
    // stack position or base instead of frame id (the same frame over the battle, or under
    // another frame, would restart), a text entry that steps the frame below or its own id
    // instead of the owner, a typing key that steps anything, a host that returns a stale result,
    // and a view model cached across steps or built twice per step.
    const log = newLog();
    const host = hostOf(
      tableWith({
        boxView: counting('boxView', log),
        questLogView: counting('questLogView', log),
        renameView: counting('renameView', log),
      }),
    );
    const box = stackOf(WORLD, screen('boxView'));
    const quest = stackOf(WORLD, screen('questLogView'));

    // A frame never opened, stepped twice: init runs once and the second step resumes the first.
    expect(host.button(box, nav('A'), CTX), 'step 1 ran on n = 0').toEqual(choice(1));
    expect(host.button(box, nav('Down'), CTX), 'step 2 ran on n = 1').toEqual(choice(2));
    expect(
      log.inits.map((i) => i.id),
      'init ran once, for the box',
    ).toEqual(['boxView']);
    const [s1, s2] = log.steps as [Stepped, Stepped];
    expect(s1.state, 'the first step starts from the init state').toBe(log.inits[0]?.state);
    expect(log.inits[0]?.vm, 'init is fed the view model of that same step').toBe(s1.vm);
    expect(s2.state, 'the second step receives the state the first returned').toBe(s1.next);
    expect(s2.btn).toEqual({ button: 'Down', repeat: false });

    // Interleaved box, quest log, box, quest log: each frame keeps its own state.
    expect(host.button(quest, nav('B'), CTX), 'the quest log starts at n = 0').toEqual(choice(1));
    const q1 = lastStep(log);
    expect(q1.id).toBe('questLogView');
    expect(q1.state, 'the quest log starts from ITS init, not the box state').toBe(
      log.inits[1]?.state,
    );
    expect(host.button(box, nav('A'), CTX), 'the box resumes at n = 2').toEqual(choice(3));
    expect(lastStep(log).state, 'from its own last state').toBe(s2.next);
    expect(host.button(quest, nav('A'), CTX), 'the quest log resumes at n = 1').toEqual(choice(2));
    expect(lastStep(log).state).toBe(q1.next);
    expect(
      log.inits.map((i) => i.id),
      'no frame was re-initialised',
    ).toEqual(['boxView', 'questLogView']);

    // Keyed by frame id: the same box threads under another frame's absence or presence, over a
    // battle base, and as a prompt.
    const boxSteps = (): Stepped[] => log.steps.filter((s) => s.id === 'boxView');
    let lastBox = boxSteps().at(-1) as Stepped;
    for (const stack of [
      stackOf(WORLD, screen('questLogView'), screen('boxView')),
      stackOf(battle('7'), screen('boxView')),
      stackOf(WORLD, prompt('boxView')),
    ]) {
      host.button(stack, nav('A'), CTX);
      const step = lastStep(log);
      expect(step.id, `${JSON.stringify(stack)}: the box is stepped`).toBe('boxView');
      expect(step.state, `${JSON.stringify(stack)}: from the box's last state`).toBe(lastBox.next);
      lastBox = step;
    }
    expect(boxSteps().length, 'the box was stepped six times').toBe(6);
    expect(lastBox.next.n, 'and counted all six').toBe(6);

    // A text entry: A threads the OWNER's state; a typing key steps nothing.
    const typing = stackOf(WORLD, screen('questLogView'), screen('boxView'), textEntry('boxView'));
    const before = log.steps.length;
    expect(host.button(typing, nav('B'), CTX), 'B belongs to the field').toBe('unhandled');
    expect(log.steps.length, 'a typing key steps nothing').toBe(before);
    expect(host.button(typing, nav('A'), CTX), 'A commits through the owner at n = 6').toEqual(
      choice(7),
    );
    expect(lastStep(log).id).toBe('boxView');
    expect(lastStep(log).state, 'the owner resumes from its last state').toBe(lastBox.next);

    // An owner never stepped before: its first A inits it once, the second resumes it.
    const renameTyping = stackOf(WORLD, screen('renameView'), textEntry('renameView'));
    host.button(renameTyping, nav('A'), CTX);
    const r1 = lastStep(log);
    host.button(renameTyping, nav('A'), CTX);
    expect(log.inits.filter((i) => i.id === 'renameView').length, 'the owner inits once').toBe(1);
    expect(r1.state).toBe(log.inits.find((i) => i.id === 'renameView')?.state);
    expect(lastStep(log).state).toBe(r1.next);

    // One fresh view model per step: the object onButton saw is the one built for that step.
    expect(log.vms.length, 'one view model per step, never two').toBe(log.steps.length);
    for (const [i, step] of log.steps.entries()) {
      expect(step.vm, `step ${i}: the view model built for it`).toBe(log.vms[i]);
    }
    expect(new Set(log.steps.map((s) => s.vm)).size, 'never a cached view model').toBe(
      log.steps.length,
    );
  });

  it('CTL7C-2-RESET-ON-OPEN: opened(frame) makes that frame`s next step start again from init, for that frame only; a prompt resets the same way; a text entry`s open leaves its owner; and opening runs no adapter code', () => {
    // WRONG IMPL KILLED: a host that never resets (a dialogue reopened on its last node, a shop on
    // its last confirm), one whose opened(x) resets every frame (the menu under a child would lose
    // its cursor when the child opens), one that resets only screen frames and not prompts, one
    // where a text entry's open resets the owner it types over (the draft's screen state is lost
    // the moment typing starts), and an EAGER open that runs init, builds a view model or steps the
    // adapter while the stack is synced (it would read the store mid-batch).
    const log = newLog();
    const host = hostOf(
      tableWith({
        boxView: counting('boxView', log),
        questLogView: counting('questLogView', log),
        pvpView: counting('pvpView', log),
        helpView: counting('helpView', log),
      }),
    );
    const box = stackOf(WORLD, screen('boxView'));
    const quest = stackOf(WORLD, screen('questLogView'));
    host.button(box, nav('A'), CTX);
    host.button(box, nav('A'), CTX);
    host.button(quest, nav('A'), CTX);
    const questBefore = lastStep(log);
    const counts = (): readonly number[] => [log.vms.length, log.inits.length, log.steps.length];
    const quiet = counts();

    host.opened(screen('boxView'));
    expect(counts(), 'opening ran no adapter code (init waits for the next step)').toEqual(quiet);
    expect(host.button(box, nav('A'), CTX), 'the box starts again at n = 0').toEqual(choice(1));
    const reopened = lastStep(log);
    expect(
      log.inits.map((i) => i.id),
      'the box was re-initialised once',
    ).toEqual(['boxView', 'questLogView', 'boxView']);
    expect(reopened.state, 'from the NEW init state').toBe(log.inits[2]?.state);
    expect(host.button(quest, nav('A'), CTX), 'the quest log kept its state').toEqual(choice(2));
    expect(lastStep(log).state).toBe(questBefore.next);

    // opened(quest log) resets the quest log and leaves the box alone.
    host.opened(screen('questLogView'));
    expect(host.button(box, nav('A'), CTX), 'the box resumes at n = 1').toEqual(choice(2));
    expect(lastStep(log).state).toBe(reopened.next);
    expect(host.button(quest, nav('A'), CTX), 'the quest log starts again').toEqual(choice(1));
    expect(lastStep(log).state).toBe(log.inits.at(-1)?.state);
    expect(log.inits.at(-1)?.id).toBe('questLogView');

    // A prompt frame resets the same way.
    const pvp = stackOf(WORLD, prompt('pvpView'));
    host.button(pvp, nav('A'), CTX);
    expect(host.button(pvp, nav('A'), CTX), 'the prompt threads').toEqual(choice(2));
    host.opened(prompt('pvpView'));
    expect(host.button(pvp, nav('A'), CTX), 'and is reset by its open').toEqual(choice(1));

    // A text entry opening over the box types over it: the box keeps its state.
    host.button(box, nav('A'), CTX);
    const boxLast = lastStep(log);
    const initsBefore = log.inits.length;
    host.opened(textEntry('boxView'));
    host.button(stackOf(WORLD, screen('boxView'), textEntry('boxView')), nav('A'), CTX);
    expect(lastStep(log).id).toBe('boxView');
    expect(lastStep(log).state, 'the owner resumes from its own state').toBe(boxLast.next);
    expect(log.inits.length, 'nothing was re-initialised').toBe(initsBefore);

    // Opening a frame never stepped is harmless: its first step inits it once.
    host.opened(screen('helpView'));
    host.button(stackOf(WORLD, screen('helpView')), nav('A'), CTX);
    host.button(stackOf(WORLD, screen('helpView')), nav('A'), CTX);
    expect(log.inits.filter((i) => i.id === 'helpView').length).toBe(1);

    // Opening runs no adapter code at all: a host over adapters that throw survives every open.
    const throwing = throwingHost();
    for (const id of OVERLAY_IDS) {
      expect(() => {
        throwing.opened(screen(id));
        throwing.opened(prompt(id));
        throwing.opened(textEntry(id));
      }, `${id}: opened touches no adapter`).not.toThrow();
    }
  });

  it('CTL7C-2-ONE-PAINT: each step paints exactly once, into THAT frame`s lent view, with the view model the step saw and the state it produced, even an unchanged one; nothing paints with no view lent, at a base, on open, for a typing key or for an adapter without paint; a throwing paint is reported and changes nothing else', () => {
    // WRONG IMPL KILLED: painting the PREVIOUS state (the view would lag one press behind), a
    // cached or re-built view model (paint would draw a different model than the step decided
    // on), the wrong id's view (the frame below, or the base), two paints per step, a paint
    // skipped when the state did not change (a cursor that hits a wall would never redraw a
    // refused move), a paint with no view lent (it would draw into `undefined` before main()
    // built the views), a paint at the base or at open, a call to a missing `paint` (it throws
    // into the paint-error sink), and a throwing paint that escapes (a broken view would make B
    // and Start unable to close its frame), loses the result, or loses the state.
    const log = newLog();
    const VIEWS: Partial<Record<FrameId, object>> = {
      boxView: { view: 'box' },
      questLogView: { view: 'quest' },
      renameView: { view: 'rename' },
      leaderboardView: { view: 'leaderboard' },
      helpView: { view: 'help' },
      tradeView: { view: 'trade' },
    };
    const paintErrors: unknown[] = [];
    const host = new ScreenHost(
      tableWith({
        boxView: counting('boxView', log, { paint: 'record' }),
        questLogView: counting('questLogView', log, { paint: 'record' }),
        renameView: counting('renameView', log, { paint: 'record' }),
        leaderboardView: counting('leaderboardView', log, { paint: 'record', keepState: true }),
        helpView: counting('helpView', log),
        tradeView: counting('tradeView', log, { paint: 'throw' }),
        pvpView: counting('pvpView', log, { paint: 'record' }),
      }),
      (id) => VIEWS[id],
      (err) => {
        paintErrors.push(err);
      },
    );
    const box = stackOf(WORLD, screen('boxView'));

    // Three steps, three paints: this frame's view, the step's own view model, the NEXT state.
    for (const button of ['A', 'Down', 'Down'] as const) host.button(box, nav(button), CTX);
    expect(log.paints.length, 'one paint per step').toBe(3);
    for (const [i, p] of log.paints.entries()) {
      const step = log.steps[i] as Stepped;
      expect(p.id, `paint ${i}: by the box's adapter`).toBe('boxView');
      expect(p.view, `paint ${i}: into the box's own view`).toBe(VIEWS.boxView);
      expect(p.vm, `paint ${i}: the very view model the step saw`).toBe(step.vm);
      expect(p.state, `paint ${i}: the state the step produced`).toBe(step.next);
      expect(p.state, `paint ${i}: not the state it started from`).not.toBe(step.state);
    }

    // The TOP frame's view, never the one under it; a text entry paints its owner's view.
    host.button(stackOf(WORLD, screen('boxView'), screen('questLogView')), nav('A'), CTX);
    expect(log.paints.at(-1)?.view, 'the quest log on top paints the quest log view').toBe(
      VIEWS.questLogView,
    );
    expect(log.paints.at(-1)?.state).toBe(lastStep(log).next);
    const typing = stackOf(WORLD, screen('boxView'), screen('renameView'), textEntry('renameView'));
    host.button(typing, nav('A'), CTX);
    expect(log.paints.at(-1)?.view, 'A over a text entry paints the owner`s view').toBe(
      VIEWS.renameView,
    );
    expect(log.paints.length).toBe(5);
    host.button(typing, nav('B'), CTX);
    expect(log.paints.length, 'a typing key steps nothing and paints nothing').toBe(5);

    // An unchanged state is still painted, once per step.
    const board = stackOf(WORLD, screen('leaderboardView'));
    host.button(board, nav('A'), CTX);
    host.button(board, nav('A'), CTX);
    expect(log.paints.length).toBe(7);
    const boardInit = log.inits.find((i) => i.id === 'leaderboardView')?.state;
    expect(log.paints.at(-2)?.state, 'unchanged state, painted').toBe(boardInit);
    expect(log.paints.at(-1)?.state, 'and painted again').toBe(boardInit);
    expect(log.paints.at(-1)?.view).toBe(VIEWS.leaderboardView);

    // No view lent (the shell has none for this id): no paint, but the step still counts.
    const pvp = stackOf(WORLD, screen('pvpView'));
    expect(host.button(pvp, nav('A'), CTX)).toEqual(choice(1));
    expect(host.button(pvp, nav('A'), CTX), 'the state was stored without a paint').toEqual(
      choice(2),
    );
    expect(log.paints.length, 'nothing painted with no view lent').toBe(7);

    // An adapter without paint: nothing painted, nothing reported.
    host.button(stackOf(WORLD, screen('helpView')), nav('A'), CTX);
    expect(log.paints.length).toBe(7);
    expect(paintErrors, 'a missing paint is not called (it would throw)').toEqual([]);

    // The base consults no adapter, and an open paints nothing.
    expect(host.button(WORLD_STACK, nav('Start'), CTX)).toEqual(OPEN_MENU);
    host.opened(screen('boxView'));
    host.opened(screen('questLogView'));
    expect(log.paints.length, 'no paint at the base or on open').toBe(7);

    // A throwing paint: reported once, the result still returned, the state still stored.
    const trade = stackOf(WORLD, screen('tradeView'));
    expect(host.button(trade, nav('A'), CTX), 'the result survives the paint failure').toEqual(
      choice(1),
    );
    expect(paintErrors.length, 'reported once').toBe(1);
    expect(paintErrors[0], 'the very error the view threw').toBe(PAINT_FAILURE);
    expect(log.paints.at(-1)?.id, 'paint was attempted once').toBe('tradeView');
    expect(log.paints.length).toBe(8);
    expect(host.button(trade, nav('A'), CTX), 'the failed step`s state was kept').toEqual(
      choice(2),
    );
    expect(paintErrors.length).toBe(2);
    expect(log.paints.length, 'still one paint per step').toBe(9);
  });
});

// ==========================================================================================
// ctl-7c round 2: what every step stores (red-team survivors S1, X6, X7, X8, X9)
// ==========================================================================================
//
// A step's state is whatever the adapter returned, whatever that value is and whatever the step
// was: `undefined` and `null` are states (a screen with nothing selected), a repeat-flagged input
// is a step like a press, and a step answered `unhandled` still moved the screen's state. Only
// `opened()` starts a frame over.

describe('ScreenHost: every step stores and paints (ctl-7c)', () => {
  it('CTL7C-2-NULLISH-STATE: a state the adapter returns as undefined or null is a real state: the next step receives it, it is painted, and init does not run again; only opened() starts the frame over', () => {
    // WRONG IMPL KILLED (S1): a host that treats a nullish stored state as "no state yet"
    // (`stored ?? adapter.init(vm)`, or `=== undefined` as the absent marker): a screen whose
    // state legitimately becomes empty (a closed sub-modal, nothing selected) would be thrown back
    // to its opening state on the very next press, and init would run again mid-frame. Also a
    // host that paints the previous state instead of the empty one, and an opened() that no
    // longer resets a frame whose stored state is nullish.
    for (const nullish of [undefined, null] as const) {
      const label = String(nullish);
      const INIT = { cursor: 5 };
      let inits = 0;
      const seen: unknown[] = [];
      const painted: unknown[] = [];
      const adapter: ScreenAdapter<unknown, unknown> = {
        nav: true,
        viewModel: () => ({}),
        init: () => {
          inits += 1;
          return INIT;
        },
        onButton: (_vm, state, btn) => {
          seen.push(state);
          // A empties the state; every other button keeps the state it was given.
          return { state: btn.button === 'A' ? nullish : state, result: 'consumed' };
        },
        paint: (_view, _vm, state) => {
          painted.push(state);
        },
      };
      const VIEW = { view: 'quest' };
      const host = new ScreenHost(
        tableWith({ questLogView: adapter }),
        (id) => (id === 'questLogView' ? VIEW : undefined),
        unexpectedPaintError,
      );
      const quest = stackOf(WORLD, screen('questLogView'));

      host.button(quest, nav('A'), CTX);
      host.button(quest, nav('Down'), CTX);
      host.button(quest, nav('Down', true), CTX);
      expect(inits, `${label}: init ran once, for the first step only`).toBe(1);
      expect(seen[0], `${label}: the first step starts from init`).toBe(INIT);
      expect(seen[1], `${label}: the next step receives the ${label} state`).toBe(nullish);
      expect(seen[2], `${label}: and so does the one after`).toBe(nullish);
      expect(painted.length, `${label}: one paint per step`).toBe(3);
      for (const [i, state] of painted.entries()) {
        expect(state, `${label}: paint ${i} draws the ${label} state`).toBe(nullish);
      }

      // Only an open starts the frame over.
      host.opened(screen('questLogView'));
      host.button(quest, nav('Down'), CTX);
      expect(inits, `${label}: the reopened frame inits again`).toBe(2);
      expect(seen[3], `${label}: from init`).toBe(INIT);
    }
  });

  it('CTL7C-2-EVERY-STEP-STORES: a repeat-flagged input and a step answered unhandled each store the state they return and paint it once, exactly like a fresh press', () => {
    // WRONG IMPL KILLED (X8, X9): a host that stores or paints only for a fresh press
    // (`if (!btn.repeat)`): a held arrow would move a list cursor once and every synthesized
    // repeat would restart from the press's state, or move it without redrawing. WRONG IMPL
    // KILLED (X6, X7): a host that stores or paints only when the adapter's result is not
    // `unhandled`: a screen that moved its own cursor but left the key to the page would lose the
    // move on the next press, or show a stale view.
    const log = newLog();
    const base = counting('questLogView', log, { paint: 'record' });
    const adapter: ScreenAdapter<unknown, unknown> = {
      ...base,
      onButton(vm, state, btn) {
        const step = base.onButton(vm, state, btn);
        // Y moves the screen's state but leaves the key itself to the page.
        return btn.button === 'Y' ? { state: step.state, result: 'unhandled' } : step;
      },
    };
    const VIEW = { view: 'quest' };
    const host = new ScreenHost(
      tableWith({ questLogView: adapter }),
      (id) => (id === 'questLogView' ? VIEW : undefined),
      unexpectedPaintError,
    );
    const quest = stackOf(WORLD, screen('questLogView'));
    const inputs: NavInput[] = [
      nav('A'),
      nav('Down', true),
      nav('Y'),
      nav('Down', true),
      nav('Y', true),
      nav('A'),
    ];
    const results = inputs.map((btn) => host.button(quest, btn, CTX));

    expect(results, 'each step ran on the state the one before it returned').toEqual([
      choice(1),
      choice(2),
      'unhandled',
      choice(4),
      'unhandled',
      choice(6),
    ]);
    expect(log.inits.length, 'init ran once').toBe(1);
    expect(log.steps.length).toBe(inputs.length);
    for (const [i, step] of log.steps.entries()) {
      expect(step.btn, `step ${i}: the input as given`).toEqual(inputs[i]);
      const expectedFrom = i === 0 ? log.inits[0]?.state : log.steps[i - 1]?.next;
      expect(step.state, `step ${i}: resumes the state the previous step returned`).toBe(
        expectedFrom,
      );
    }
    expect(log.paints.length, 'one paint per step, repeats and unhandled ones included').toBe(
      inputs.length,
    );
    for (const [i, p] of log.paints.entries()) {
      expect(p.view, `paint ${i}: into the lent view`).toBe(VIEW);
      expect(p.state, `paint ${i}: the state step ${i} produced`).toBe(log.steps[i]?.next);
    }
  });
});

// ==========================================================================================
// ctl-7d: batch observation (CTL7D.6)
// ==========================================================================================
//
// `host.observe(stack, ctx)` runs after every store batch (main.ts, right after syncStack). It
// walks the stack bottom up and, for every screen or prompt frame whose adapter defines
// `observe`, builds that adapter's view model, takes the frame's kept state (or `init(vm)` when
// none is kept) and keeps what `observe(vm, state, ctx.now())` returns. A DIFFERENT object is
// painted once into the frame's lent view; the SAME object is not painted. A throw from
// viewModel, init, observe or paint goes to the paint-error sink and leaves that frame's kept
// state exactly as it was, and the walk goes on. Base frames, text-entry frames and adapters
// without `observe` run nothing.
//
// The stub states are `Counted`: init answers n = 0, observe a NEW object at n + 100 (or, in
// `keep` mode, the very object it was handed) and a button a NEW object at n + 1, so the object
// identity and the count both say which call produced the state a later call received. The
// clock answers a new value at every read, so `now` names the pass that read it.

type Fault = 'viewModel' | 'init' | 'observe' | 'paint';

/** What each method throws while it is the fault: two non-Error values and two Errors. */
const THROWN: Readonly<Record<Fault, unknown>> = {
  viewModel: 'the view model could not be built',
  init: { reason: 'init failed' },
  observe: new Error('observe failed'),
  paint: PAINT_FAILURE,
};

interface Observed {
  readonly id: FrameId;
  readonly vm: unknown;
  readonly state: unknown;
  readonly now: unknown;
  readonly next: unknown;
}
interface ObsStep {
  readonly id: FrameId;
  readonly vm: unknown;
  readonly state: unknown;
  readonly next: Counted;
}
interface ObsLog {
  /** `method:id` for every adapter call, in call order, a call that throws included. */
  readonly order: string[];
  readonly vms: Array<{ readonly id: FrameId; readonly ctx: unknown; readonly vm: object }>;
  readonly inits: Array<{ readonly id: FrameId; readonly vm: unknown; readonly state: Counted }>;
  readonly observes: Observed[];
  readonly steps: ObsStep[];
  readonly paints: Painted[];
}
const newObsLog = (): ObsLog => ({
  order: [],
  vms: [],
  inits: [],
  observes: [],
  steps: [],
  paints: [],
});

interface ObservingOpts {
  /** `advance` (the default): observe answers a NEW state; `keep`: the very state it was
   *  handed. Read at every call, so a case can flip it between passes. */
  readonly mode?: { value: 'advance' | 'keep' };
  /** While `at` names a method, that method throws `THROWN[at]`. Read at every call. */
  readonly fault?: { at: Fault | undefined };
  /** `record` (the default) paints into the log; `absent` has no `paint` key; `undefined` has an
   *  own `paint` key whose value is undefined. */
  readonly paint?: 'record' | 'absent' | 'undefined';
}

/** A recording stub for `id` that defines `observe`. */
function observing(
  id: FrameId,
  log: ObsLog,
  opts: ObservingOpts = {},
): ScreenAdapter<unknown, unknown> {
  const fail = (at: Fault): void => {
    if (opts.fault?.at === at) throw THROWN[at];
  };
  /** The count a state carries, or -1000 for a state that is not this frame's own counter. */
  const countOf = (state: unknown): number => {
    const prev = state as Partial<Counted> | null | undefined;
    return prev?.of === id && typeof prev.n === 'number' ? prev.n : -1000;
  };
  const adapter: ScreenAdapter<unknown, unknown> = {
    viewModel(ctx) {
      log.order.push(`viewModel:${id}`);
      fail('viewModel');
      const vm = { vmOf: id, seq: log.vms.length };
      log.vms.push({ id, ctx, vm });
      return vm;
    },
    init(vm) {
      log.order.push(`init:${id}`);
      fail('init');
      const state: Counted = { of: id, n: 0 };
      log.inits.push({ id, vm, state });
      return state;
    },
    observe(vm, state, now) {
      log.order.push(`observe:${id}`);
      fail('observe');
      const next = opts.mode?.value === 'keep' ? state : { of: id, n: countOf(state) + 100 };
      log.observes.push({ id, vm, state, now, next });
      return next;
    },
    onButton(vm, state) {
      log.order.push(`onButton:${id}`);
      const next: Counted = { of: id, n: countOf(state) + 1 };
      log.steps.push({ id, vm, state, next });
      return { state: next, result: choice(next.n) };
    },
  };
  if (opts.paint === 'absent') return adapter;
  if (opts.paint === 'undefined') return { ...adapter, paint: undefined };
  return {
    ...adapter,
    paint(view, vm, state) {
      log.order.push(`paint:${id}`);
      log.paints.push({ id, view, vm, state });
      fail('paint');
    },
  };
}

interface Clock {
  readonly ctx: ScreenContext;
  /** Every value `ctx.now()` has returned, in order. */
  readonly returned: number[];
}
/** A context whose clock answers a new value at every read: never 0, never the wall clock. */
function clockCtx(): Clock {
  const returned: number[] = [];
  const ctx = {
    store: {},
    identity: 'cd'.repeat(32),
    bindings: DEFAULT_BINDINGS,
    now: () => {
      const value = 4_000.5 + returned.length * 250;
      returned.push(value);
      return value;
    },
  } as unknown as ScreenContext;
  return { ctx, returned };
}

/** What one `host.observe` call read off the clock and added to the log. */
interface PassRecord {
  readonly nows: readonly number[];
  readonly order: readonly string[];
  readonly vms: ObsLog['vms'];
  readonly inits: ObsLog['inits'];
  readonly observes: readonly Observed[];
  readonly paints: readonly Painted[];
}
function observePass(host: ScreenHost, stack: Stack, clock: Clock, log: ObsLog): PassRecord {
  const at = {
    nows: clock.returned.length,
    order: log.order.length,
    vms: log.vms.length,
    inits: log.inits.length,
    observes: log.observes.length,
    paints: log.paints.length,
  };
  host.observe(stack, clock.ctx);
  return {
    nows: clock.returned.slice(at.nows),
    order: log.order.slice(at.order),
    vms: log.vms.slice(at.vms),
    inits: log.inits.slice(at.inits),
    observes: log.observes.slice(at.observes),
    paints: log.paints.slice(at.paints),
  };
}

/** The one row for `id`: the case fails unless there is exactly one. */
function onlyFor<T extends { readonly id: FrameId }>(
  rows: readonly T[],
  id: FrameId,
  label: string,
): T {
  const mine = rows.filter((row) => row.id === id);
  expect(mine.length, `${label}: exactly one for ${id}`).toBe(1);
  return mine[0] as T;
}

/** `now` is a number that `ctx.now()` returned during this very pass. */
function expectPassClock(now: unknown, nows: readonly number[], label: string): void {
  expect(typeof now, `${label}: now is the clock's value, not the clock`).toBe('number');
  expect(
    nows.includes(now as number),
    `${label}: now ${String(now)} was read from ctx.now() in this pass (${nows.join(', ')})`,
  ).toBe(true);
}

const lastObsStep = (log: ObsLog): ObsStep => log.steps[log.steps.length - 1] as ObsStep;

describe('ScreenHost.observe (ctl-7d)', () => {
  it('CTL7D-6-OBSERVE-THREADS: observe() calls the observe of every screen and prompt frame once per pass, bottom up in stack order, covered frames included, each with a view model its own adapter built that pass, its own kept state and that pass`s clock value; what observe returns is what that frame`s next observe and next button receive, a button`s state is what its next observe receives, frames stay isolated and the base runs nothing', () => {
    // WRONG IMPL KILLED: a host that observes only the TOP frame (a dialogue covered by the menu
    // would never learn that its node was replaced); one that walks top-down, or in the adapter
    // table's order instead of the stack's (the stack below is box, pvp, quest; the table says
    // box, quest, pvp); one that observes a frame twice per pass, or a frame that is not on the
    // stack; init on every pass (a reveal would restart at every batch); a state observe returned
    // that is not kept (the next observe or button starts from init or from the state before); an
    // observe that ignores a button's state; one state shared across frames, or keyed by stack
    // position; a view model cached across passes, borrowed from another frame or built without
    // the context; the clock FUNCTION, the wall clock, 0 or a value read in an earlier pass handed
    // over as `now`; and a battle base consulted as battleView's frame.
    const log = newObsLog();
    const errors: unknown[] = [];
    const host = new ScreenHost(
      tableWith({
        battleView: observing('battleView', log),
        boxView: observing('boxView', log),
        pvpView: observing('pvpView', log),
        questLogView: observing('questLogView', log),
      }),
      noViews,
      (err) => {
        errors.push(err);
      },
    );
    const clock = clockCtx();
    const stack = stackOf(
      battle('7'),
      screen('boxView'),
      prompt('pvpView'),
      screen('questLogView'),
    );
    const IDS = ['boxView', 'pvpView', 'questLogView'] as const;

    // Pass 1: nothing is kept yet, so every frame starts from its own init.
    const p1 = observePass(host, stack, clock, log);
    expect(
      p1.observes.map((o) => o.id),
      'pass 1: each frame once, bottom up',
    ).toEqual([...IDS]);
    for (const id of IDS) {
      const built = onlyFor(p1.vms, id, 'pass 1 view model');
      const init = onlyFor(p1.inits, id, 'pass 1 init');
      const seen = onlyFor(p1.observes, id, 'pass 1 observe');
      expect(built.ctx, `${id}: its view model is built from the context`).toBe(clock.ctx);
      expect(init.vm, `${id}: init is fed that pass's view model`).toBe(built.vm);
      expect(seen.vm, `${id}: observe gets that very view model`).toBe(built.vm);
      expect(seen.state, `${id}: and the state its own init returned`).toBe(init.state);
      expectPassClock(seen.now, p1.nows, `${id} pass 1`);
    }

    // Pass 2: each frame resumes from what its own pass-1 observe returned, with a fresh vm.
    const p2 = observePass(host, stack, clock, log);
    expect(
      p2.observes.map((o) => o.id),
      'pass 2: each frame once, bottom up',
    ).toEqual([...IDS]);
    expect(p2.inits, 'pass 2: no frame starts over').toEqual([]);
    for (const id of IDS) {
      const seen = onlyFor(p2.observes, id, 'pass 2 observe');
      expect(seen.state, `${id}: pass 2 receives what its pass-1 observe returned`).toBe(
        onlyFor(p1.observes, id, 'pass 1 observe').next,
      );
      expect(seen.vm, `${id}: a view model built in pass 2`).toBe(
        onlyFor(p2.vms, id, 'pass 2 view model').vm,
      );
      expect(seen.vm, `${id}: never the pass-1 view model`).not.toBe(
        onlyFor(p1.vms, id, 'pass 1 view model').vm,
      );
      expectPassClock(seen.now, p2.nows, `${id} pass 2`);
    }
    expect(
      p2.observes.map((o) => (o.next as Counted).n),
      'pass 2: two observes counted on every frame',
    ).toEqual([200, 200, 200]);

    // A button on the top frame, then one on the box: each steps from its frame's observed state.
    const p2Next = (id: FrameId): unknown => onlyFor(p2.observes, id, 'pass 2 observe').next;
    expect(host.button(stack, nav('A'), clock.ctx), 'the quest log steps from n = 200').toEqual(
      choice(201),
    );
    const questStep = lastObsStep(log);
    expect(questStep.id).toBe('questLogView');
    expect(questStep.state, 'the button receives what the last observe returned').toBe(
      p2Next('questLogView'),
    );
    expect(
      host.button(stackOf(WORLD, screen('boxView')), nav('A'), clock.ctx),
      'the box steps from n = 200',
    ).toEqual(choice(201));
    const boxStep = lastObsStep(log);
    expect(boxStep.id).toBe('boxView');
    expect(boxStep.state).toBe(p2Next('boxView'));
    expect(log.inits.length, 'no button started a frame over').toBe(3);

    // Pass 3: a button's state is what the next observe receives; the unstepped pvp resumes its own.
    const p3 = observePass(host, stack, clock, log);
    expect(
      onlyFor(p3.observes, 'questLogView', 'pass 3 observe').state,
      'the quest log resumes from its button`s state',
    ).toBe(questStep.next);
    expect(onlyFor(p3.observes, 'boxView', 'pass 3 observe').state, 'the box too').toBe(
      boxStep.next,
    );
    expect(
      onlyFor(p3.observes, 'pvpView', 'pass 3 observe').state,
      'pvp was not stepped: its own pass-2 state',
    ).toBe(p2Next('pvpView'));
    expect(p3.observes.map((o) => [o.id, (o.next as Counted).n])).toEqual([
      ['boxView', 301],
      ['pvpView', 300],
      ['questLogView', 301],
    ]);
    for (const o of p3.observes) expectPassClock(o.now, p3.nows, `${o.id} pass 3`);

    // The same frames in the opposite stack order are observed in THAT order; a frame off the
    // stack (pvp) is not observed, and its kept state is untouched.
    const p4 = observePass(
      host,
      stackOf(WORLD, screen('questLogView'), screen('boxView')),
      clock,
      log,
    );
    expect(
      p4.observes.map((o) => o.id),
      'stack order, not table order',
    ).toEqual(['questLogView', 'boxView']);
    const p5 = observePass(host, stack, clock, log);
    expect(
      onlyFor(p5.observes, 'pvpView', 'pass 5 observe').state,
      'pvp, off the stack for a pass, resumes its pass-3 state',
    ).toBe(onlyFor(p3.observes, 'pvpView', 'pass 3 observe').next);

    // Isolation: every observe and every step only ever received its own frame's state.
    for (const o of log.observes) {
      expect((o.state as Counted).of, `${o.id}: observed its own state`).toBe(o.id);
    }
    for (const s of log.steps) {
      expect((s.state as Counted).of, `${s.id}: stepped its own state`).toBe(s.id);
    }
    // The battle base is not a frame: battleView's adapter never ran.
    expect(
      log.order.filter((call) => call.endsWith(':battleView')),
      'the base ran nothing',
    ).toEqual([]);
    expect(errors, 'nothing was reported').toEqual([]);
  });

  it('CTL7D-6-OBSERVE-INIT: a frame with no kept state is observed from init(vm), init fed that pass`s view model; the state observe returns is kept even when it is the init object itself, so the next button does not init again; opened() makes the next observe start over; and undefined, null, 0, the empty string and false are kept states, never "no state"', () => {
    // WRONG IMPL KILLED: a host that keeps observe's answer only when it CHANGED (a first observe
    // that answers its init object leaves nothing kept, so the next button runs init again and a
    // reveal restarts); `states.get(id) ?? adapter.init(vm)` (an undefined or null state looks
    // absent), `states.get(id) || adapter.init(vm)` (0, '' and false look absent too) and
    // `=== undefined` as the absent marker, each of which re-inits a frame mid-life on its next
    // observe or button; a falsy state that is never stored; init fed a different view model than
    // observe; an observe that ignores opened() (a reopened dialogue would resume the last
    // conversation's reveal); and an opened() that cannot clear a falsy state.
    const log = newObsLog();
    const errors: unknown[] = [];
    const record = (err: unknown): void => {
      errors.push(err);
    };
    const host = new ScreenHost(
      tableWith({ questLogView: observing('questLogView', log, { mode: { value: 'keep' } }) }),
      noViews,
      record,
    );
    const clock = clockCtx();
    const quest = stackOf(WORLD, screen('questLogView'));

    const p1 = observePass(host, quest, clock, log);
    const init1 = onlyFor(p1.inits, 'questLogView', 'pass 1 init');
    expect(init1.vm, 'init is fed the view model of that pass').toBe(
      onlyFor(p1.vms, 'questLogView', 'pass 1 view model').vm,
    );
    const o1 = onlyFor(p1.observes, 'questLogView', 'pass 1 observe');
    expect(o1.state, 'the first observe starts from init').toBe(init1.state);
    expect(o1.vm, 'with the same view model init saw').toBe(init1.vm);
    expect(o1.next, 'fixture: observe answered the very init object').toBe(init1.state);

    // That unchanged init object was kept: the next button steps from it and runs no init.
    expect(host.button(quest, nav('A'), clock.ctx), 'the button steps from n = 0').toEqual(
      choice(1),
    );
    expect(log.inits.length, 'init ran once').toBe(1);
    expect(lastObsStep(log).state, 'the button received the init object').toBe(init1.state);
    // And the next observe receives the button's state, still with no init.
    const p2 = observePass(host, quest, clock, log);
    expect(p2.inits, 'pass 2: no init').toEqual([]);
    expect(onlyFor(p2.observes, 'questLogView', 'pass 2 observe').state).toBe(
      lastObsStep(log).next,
    );

    // opened(): the next observe starts over from a NEW init, fed that pass's view model ...
    host.opened(screen('questLogView'));
    const p3 = observePass(host, quest, clock, log);
    const init2 = onlyFor(p3.inits, 'questLogView', 'pass 3 init');
    expect(init2.state, 'a new init state').not.toBe(init1.state);
    expect(init2.vm).toBe(onlyFor(p3.vms, 'questLogView', 'pass 3 view model').vm);
    expect(onlyFor(p3.observes, 'questLogView', 'pass 3 observe').state).toBe(init2.state);
    // ... and keeps it: the next observe and the next button receive it, with no third init.
    const p4 = observePass(host, quest, clock, log);
    expect(onlyFor(p4.observes, 'questLogView', 'pass 4 observe').state).toBe(init2.state);
    expect(host.button(quest, nav('A'), clock.ctx), 'the button steps from the new n = 0').toEqual(
      choice(1),
    );
    expect(lastObsStep(log).state).toBe(init2.state);
    expect(log.inits.length, 'init ran once per open').toBe(2);

    // Falsy and nullish states are real states, whether init or observe produced them.
    const FALSY: ReadonlyArray<readonly [string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['0', 0],
      ["''", ''],
      ['false', false],
    ];
    let cases = 0;
    for (const [label, falsy] of FALSY) {
      for (const from of ['init', 'observe'] as const) {
        const tag = `${label} (answered by ${from})`;
        const OBJ = { initOf: 'questLogView' };
        let inits = 0;
        const observed: unknown[] = [];
        const stepped: unknown[] = [];
        const adapter: ScreenAdapter<unknown, unknown> = {
          viewModel: () => ({}),
          init: () => {
            inits += 1;
            return from === 'init' ? falsy : OBJ;
          },
          // from 'init': observe keeps what it is handed. From 'observe': its first answer is
          // the falsy state, and every later one keeps what it is handed.
          observe: (_vm, state) => {
            observed.push(state);
            return from === 'observe' && observed.length === 1 ? falsy : state;
          },
          onButton: (_vm, state) => {
            stepped.push(state);
            return { state, result: 'consumed' };
          },
        };
        const falsyHost = new ScreenHost(tableWith({ questLogView: adapter }), noViews, record);
        falsyHost.observe(quest, clock.ctx);
        falsyHost.observe(quest, clock.ctx);
        falsyHost.button(quest, nav('A'), clock.ctx);
        falsyHost.observe(quest, clock.ctx);
        expect(inits, `${tag}: init ran once`).toBe(1);
        expect(observed[0], `${tag}: the first observe starts from init`).toBe(
          from === 'init' ? falsy : OBJ,
        );
        expect(observed[1], `${tag}: the second observe receives the ${label} state`).toBe(falsy);
        expect(stepped.length, `${tag}: one button step`).toBe(1);
        expect(stepped[0], `${tag}: the button receives the ${label} state`).toBe(falsy);
        expect(observed[2], `${tag}: and so does the observe after it`).toBe(falsy);
        // Only opened() starts the frame over, whatever falsy state it holds.
        falsyHost.opened(screen('questLogView'));
        falsyHost.observe(quest, clock.ctx);
        expect(inits, `${tag}: the reopened frame inits again`).toBe(2);
        expect(observed.length, `${tag}: four observes`).toBe(4);
        expect(observed[3], `${tag}: from init`).toBe(from === 'init' ? falsy : OBJ);
        cases += 1;
      }
    }
    expect(cases, 'ANTI-VACUITY: five falsy states x two producers').toBe(10);
    expect(errors, 'nothing was reported').toEqual([]);
  });

  it('CTL7D-6-OBSERVE-PAINT: when observe answers a different object the frame is painted exactly once, into its own lent view, with that pass`s view model and the new state; the same object (the init object included) paints nothing; no view lent, no paint key and an own undefined paint paint nothing, report nothing and still keep the state; two frames in one pass paint independently', () => {
    // WRONG IMPL KILLED: a host that paints every observed frame on every batch (a 60 Hz-ish batch
    // stream would repaint every open frame: the box answers its state unchanged in pass 2); one
    // that paints a first observe that answers its init object (the quest log); one that paints
    // the kept (previous) state, or with a re-built view model; one that paints into the top
    // frame's view, or paints only the top frame; a paint with no view lent (it would draw into
    // `undefined` before main() built the views); a call to a missing paint, or to an own
    // `paint: undefined` (a TypeError into the error sink); a state dropped because nothing was
    // painted (pvp, help and trade); one frame's paint suppressed because another frame
    // painted in the same pass (box and leaderboard); and a loose `!=` compare (null to undefined,
    // undefined to null, 0 to false and '' to 0 are changes it would never paint).
    const log = newObsLog();
    const errors: unknown[] = [];
    const boxMode: { value: 'advance' | 'keep' } = { value: 'advance' };
    // pvpView has no view lent.
    const VIEWS: Partial<Record<FrameId, object>> = {
      boxView: { view: 'box' },
      questLogView: { view: 'quest' },
      helpView: { view: 'help' },
      tradeView: { view: 'trade' },
      leaderboardView: { view: 'leaderboard' },
    };
    const host = new ScreenHost(
      tableWith({
        boxView: observing('boxView', log, { mode: boxMode }),
        questLogView: observing('questLogView', log, { mode: { value: 'keep' } }),
        pvpView: observing('pvpView', log),
        helpView: observing('helpView', log, { paint: 'absent' }),
        tradeView: observing('tradeView', log, { paint: 'undefined' }),
        leaderboardView: observing('leaderboardView', log),
      }),
      (id) => VIEWS[id],
      (err) => {
        errors.push(err);
      },
    );
    const clock = clockCtx();
    const stack = stackOf(
      WORLD,
      screen('boxView'),
      screen('questLogView'),
      prompt('pvpView'),
      screen('helpView'),
      screen('tradeView'),
      screen('leaderboardView'),
    );
    const PAINTERS = ['boxView', 'leaderboardView'] as const;

    // Pass 1: every frame answers a new object except the quest log (its init object).
    const p1 = observePass(host, stack, clock, log);
    expect(
      p1.observes.map((o) => o.id),
      'ANTI-VACUITY: all six frames were observed',
    ).toEqual(['boxView', 'questLogView', 'pvpView', 'helpView', 'tradeView', 'leaderboardView']);
    expect(
      p1.paints.map((p) => p.id),
      'pass 1: the two changed frames with a view and a paint, once each, bottom up',
    ).toEqual([...PAINTERS]);
    for (const id of PAINTERS) {
      const painted = onlyFor(p1.paints, id, 'pass 1 paint');
      const seen = onlyFor(p1.observes, id, 'pass 1 observe');
      expect(painted.view, `${id}: into its own lent view`).toBe(VIEWS[id]);
      expect(painted.vm, `${id}: with the view model of that pass`).toBe(
        onlyFor(p1.vms, id, 'pass 1 view model').vm,
      );
      expect(painted.state, `${id}: with the state observe returned`).toBe(seen.next);
      expect(painted.state, `${id}: not the state it was handed`).not.toBe(seen.state);
    }
    expect(
      onlyFor(p1.observes, 'questLogView', 'pass 1 observe').next,
      'fixture: the quest log answered its init object',
    ).toBe(onlyFor(p1.inits, 'questLogView', 'pass 1 init').state);
    expect(errors, 'a missing or undefined paint is not called and reports nothing').toEqual([]);

    // Pass 2: the box answers the same object (no paint); the leaderboard changes again.
    boxMode.value = 'keep';
    const p2 = observePass(host, stack, clock, log);
    expect(
      p2.paints.map((p) => p.id),
      'pass 2: only the frame whose state changed again',
    ).toEqual(['leaderboardView']);
    const board2 = onlyFor(p2.paints, 'leaderboardView', 'pass 2 paint');
    expect(board2.vm).toBe(onlyFor(p2.vms, 'leaderboardView', 'pass 2 view model').vm);
    expect(board2.state).toBe(onlyFor(p2.observes, 'leaderboardView', 'pass 2 observe').next);
    expect(board2.view).toBe(VIEWS.leaderboardView);
    expect(
      onlyFor(p2.observes, 'boxView', 'pass 2 observe').next,
      'fixture: the box answered the object it was handed',
    ).toBe(onlyFor(p1.observes, 'boxView', 'pass 1 observe').next);
    for (const id of ['pvpView', 'helpView', 'tradeView'] as const) {
      expect(
        onlyFor(p2.observes, id, 'pass 2 observe').state,
        `${id}: its unpainted pass-1 state was still kept`,
      ).toBe(onlyFor(p1.observes, id, 'pass 1 observe').next);
    }

    // Pass 3: the box changes again and paints again, with pass 3's view model and state.
    boxMode.value = 'advance';
    const p3 = observePass(host, stack, clock, log);
    expect(
      p3.paints.map((p) => p.id),
      'pass 3',
    ).toEqual([...PAINTERS]);
    const box3 = onlyFor(p3.paints, 'boxView', 'pass 3 paint');
    expect(box3.view).toBe(VIEWS.boxView);
    expect(box3.vm).toBe(onlyFor(p3.vms, 'boxView', 'pass 3 view model').vm);
    expect(box3.state).toBe(onlyFor(p3.observes, 'boxView', 'pass 3 observe').next);

    // pvp was never painted (no view) yet every observed state was kept: its button steps from n = 300.
    expect(
      host.button(stackOf(WORLD, prompt('pvpView')), nav('A'), clock.ctx),
      'the unpainted pvp state threads into a button',
    ).toEqual(choice(301));
    expect(log.paints.length, 'five paints in all: 2 + 1 + 2').toBe(5);
    expect(
      log.paints.filter((p) => p.id === 'questLogView'),
      'the quest log, never changed, never painted',
    ).toEqual([]);

    // Loosely equal is not the same: a state that is `==` but not `===` the kept one is a change,
    // painted once with the new state, which is what the next observe receives.
    const LOOSE: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ['null to undefined', null, undefined],
      ['undefined to null', undefined, null],
      ['0 to false', 0, false],
      ["'' to 0", '', 0],
    ];
    let loose = 0;
    for (const [label, from, to] of LOOSE) {
      const seen: unknown[] = [];
      const painted: Array<{ readonly view: unknown; readonly state: unknown }> = [];
      const VIEW = { view: 'quest' };
      const adapter: ScreenAdapter<unknown, unknown> = {
        viewModel: () => ({}),
        init: () => from,
        // The first observe answers `to`; every later one keeps what it is handed.
        observe: (_vm, state) => {
          seen.push(state);
          return seen.length === 1 ? to : state;
        },
        onButton: (_vm, state) => ({ state, result: 'consumed' }),
        paint: (view, _vm, state) => {
          painted.push({ view, state });
        },
      };
      const looseHost = new ScreenHost(
        tableWith({ questLogView: adapter }),
        (id) => (id === 'questLogView' ? VIEW : undefined),
        (err) => {
          errors.push(err);
        },
      );
      const quest = stackOf(WORLD, screen('questLogView'));
      looseHost.observe(quest, clock.ctx);
      expect(seen[0], `${label}: fixture: the first observe is handed the init state`).toBe(from);
      expect(painted.length, `${label}: a loosely equal but different state paints once`).toBe(1);
      expect(painted[0]?.state, `${label}: with the new state`).toBe(to);
      expect(painted[0]?.view, `${label}: into the lent view`).toBe(VIEW);
      looseHost.observe(quest, clock.ctx);
      expect(seen.length, `${label}: two observes`).toBe(2);
      expect(seen[1], `${label}: the next observe receives the new state`).toBe(to);
      expect(painted.length, `${label}: unchanged since, it paints nothing more`).toBe(1);
      loose += 1;
    }
    expect(loose, 'ANTI-VACUITY: four loosely equal pairs').toBe(4);
    expect(errors, 'nothing was reported').toEqual([]);
  });

  it('CTL7D-6-OBSERVE-THROWS: a throw from viewModel, init, observe or paint is handed to onPaintError exactly once with the thrown value, observe() itself does not throw, the remaining frames are still observed and painted, and THAT frame keeps its previous state (or starts from init again when it had none), wherever it sits on the stack; a paint that throws does not keep the state observe returned', () => {
    // WRONG IMPL KILLED: an observe() with no try (one broken adapter would throw out of the
    // store's batch listener and starve every listener and frame after it); one try around the
    // whole walk (the frames above the throwing one would go unobserved); the state stored
    // before the paint (a paint that threw would keep a state the view never showed, so the next
    // observe would answer "unchanged" and never repaint it); init's state stored before observe
    // runs (a frame whose observe threw would resume from that half-done pass instead of starting
    // over); a viewModel or init throw swallowed and observe run anyway; an error wrapped,
    // stringified, reported twice, or not at all; and a throw rethrown after it was reported.
    const FAULTS = ['viewModel', 'init', 'observe', 'paint'] as const;
    const IDS = ['boxView', 'pvpView', 'questLogView'] as const;
    const WHERE: Readonly<Record<(typeof IDS)[number], string>> = {
      boxView: 'bottom',
      pvpView: 'middle',
      questLogView: 'top',
    };
    const VIEWS: Partial<Record<FrameId, object>> = {
      boxView: { view: 'box' },
      pvpView: { view: 'pvp' },
      questLogView: { view: 'quest' },
    };
    const stack = stackOf(WORLD, screen('boxView'), prompt('pvpView'), screen('questLogView'));
    let checked = 0;
    for (const at of FAULTS) {
      for (const faulty of IDS) {
        for (const prior of [true, false]) {
          for (const then of ['observe', 'button'] as const) {
            // init is never asked while a state is kept (OBSERVE-INIT), so it cannot throw then.
            if (at === 'init' && prior) continue;
            const label = `${at} throws in ${faulty} (${WHERE[faulty]}), ${
              prior ? 'with' : 'without'
            } a prior state, then ${then}`;
            const log = newObsLog();
            const fault: { at: Fault | undefined } = { at: undefined };
            const own: Partial<Record<FrameId, ScreenAdapter<unknown, unknown>>> = {};
            for (const id of IDS) own[id] = observing(id, log, id === faulty ? { fault } : {});
            const errors: unknown[] = [];
            const host = new ScreenHost(
              tableWith(own),
              (id) => VIEWS[id],
              (err) => {
                errors.push(err);
              },
            );
            const clock = clockCtx();

            let priorState: unknown;
            if (prior) {
              const p0 = observePass(host, stack, clock, log);
              priorState = onlyFor(p0.observes, faulty, `${label}: the clean pass`).next;
            }
            expect(errors, `${label}: the clean pass reported nothing`).toEqual([]);

            fault.at = at;
            let p1!: PassRecord;
            expect(() => {
              p1 = observePass(host, stack, clock, log);
            }, `${label}: observe() itself does not throw`).not.toThrow();
            fault.at = undefined;
            expect(errors.length, `${label}: reported exactly once`).toBe(1);
            expect(errors[0], `${label}: the very value thrown`).toBe(THROWN[at]);
            const others = IDS.filter((id) => id !== faulty);
            expect(
              p1.observes.filter((o) => o.id !== faulty).map((o) => o.id),
              `${label}: the remaining frames are still observed, in stack order`,
            ).toEqual(others);
            expect(
              p1.paints.filter((p) => p.id !== faulty).map((p) => p.id),
              `${label}: and still painted`,
            ).toEqual(others);
            const calls = (method: string): number =>
              p1.order.filter((call) => call === `${method}:${faulty}`).length;
            expect(
              calls('observe'),
              `${label}: observe ran only past a good view model and init`,
            ).toBe(at === 'viewModel' || at === 'init' ? 0 : 1);
            expect(calls('paint'), `${label}: paint ran only past a good observe`).toBe(
              at === 'paint' ? 1 : 0,
            );
            // The state a throwing paint was given is the one that must NOT be kept.
            const dropped =
              at === 'paint'
                ? onlyFor(p1.observes, faulty, `${label}: the faulted pass`).next
                : undefined;

            if (then === 'observe') {
              const p2 = observePass(host, stack, clock, log);
              const seen = onlyFor(p2.observes, faulty, `${label}: the next pass`);
              if (prior) {
                expect(
                  seen.state,
                  `${label}: the next observe receives the state from before the throw`,
                ).toBe(priorState);
                expect(p2.inits, `${label}: and nothing starts over`).toEqual([]);
              } else {
                const fresh = onlyFor(p2.inits, faulty, `${label}: the next pass inits again`);
                expect(
                  seen.state,
                  `${label}: with no state before the throw it starts from init`,
                ).toBe(fresh.state);
              }
              if (dropped !== undefined) {
                expect(
                  seen.state,
                  `${label}: never the state the throwing paint was given`,
                ).not.toBe(dropped);
              }
              for (const id of others) {
                expect(
                  onlyFor(p2.observes, id, `${label}: the next pass`).state,
                  `${label}: ${id} kept what the faulted pass gave it`,
                ).toBe(onlyFor(p1.observes, id, `${label}: the faulted pass`).next);
              }
            } else {
              const initsBefore = log.inits.length;
              host.button(stackOf(WORLD, screen(faulty)), nav('A'), clock.ctx);
              const step = lastObsStep(log);
              expect(step.id, `${label}: the button steps the faulty frame`).toBe(faulty);
              const fresh = log.inits.slice(initsBefore);
              if (prior) {
                expect(
                  step.state,
                  `${label}: the next button receives the state from before the throw`,
                ).toBe(priorState);
                expect(fresh, `${label}: and runs no init`).toEqual([]);
              } else {
                expect(
                  fresh.map((i) => i.id),
                  `${label}: with no state before the throw the button starts from init`,
                ).toEqual([faulty]);
                expect(step.state).toBe(fresh[0]?.state);
              }
              if (dropped !== undefined) {
                expect(
                  step.state,
                  `${label}: never the state the throwing paint was given`,
                ).not.toBe(dropped);
              }
            }
            expect(errors.length, `${label}: nothing more is reported once the fault clears`).toBe(
              1,
            );
            checked += 1;
          }
        }
      }
    }
    expect(
      checked,
      'ANTI-VACUITY: 4 faults x 3 positions x 2 priors x 2 follow-ups, less init with a prior',
    ).toBe(42);
  });

  it('CTL7D-6-OBSERVE-SKIPS: adapters without observe (the legacy adapter, a stand-in without the key, one with an own observe: undefined) run no viewModel, init, onButton or paint and keep their state; a text-entry frame and a bare base are skipped; and the shipped all-legacy table, observed over every overlay id, reports nothing', () => {
    // WRONG IMPL KILLED: an observe() that builds every frame's view model (or inits it) and only
    // then checks for `observe` (every legacy adapter would see new calls on every store batch;
    // the throwing stand-ins below would report); a `'observe' in adapter` check (an own key
    // holding undefined would be called: a TypeError into the sink); a skip that clears or
    // replaces the kept state of the frames it skips; a text entry resolved to its owner (an
    // owner observed twice, or a frame that is not open observed through someone else's field);
    // a base treated as a frame; and a shipped table that reports an error on every batch.
    const stepLog = newLog();
    const obsLog = newObsLog();
    const errors: unknown[] = [];
    const record = (err: unknown): void => {
      errors.push(err);
    };
    const VIEWS: Partial<Record<FrameId, object>> = {
      boxView: { view: 'box' },
      helpView: { view: 'help' },
      questLogView: { view: 'quest' },
    };
    const host = new ScreenHost(
      tableWith({
        // ctl-7c's stateful stub: no observe key.
        boxView: counting('boxView', stepLog, { paint: 'record' }),
        helpView: { ...counting('helpView', stepLog, { paint: 'record' }), observe: undefined },
        menuView: { ...throwingAdapters().menuView, observe: undefined },
        questLogView: observing('questLogView', obsLog),
      }),
      (id) => VIEWS[id],
      record,
    );
    const clock = clockCtx();
    host.button(stackOf(WORLD, screen('boxView')), nav('A'), clock.ctx);
    host.button(stackOf(WORLD, screen('helpView')), nav('A'), clock.ctx);
    const [boxFirst, helpFirst] = stepLog.steps as [Stepped, Stepped];
    const counts = (): readonly number[] => [
      stepLog.vms.length,
      stepLog.inits.length,
      stepLog.steps.length,
      stepLog.paints.length,
    ];
    const quiet = counts();

    // raisingView is a throwing stand-in with no observe key; menuView one with observe: undefined.
    const mixed = stackOf(
      WORLD,
      screen('boxView'),
      screen('menuView'),
      screen('helpView'),
      prompt('raisingView'),
      screen('questLogView'),
    );
    host.observe(mixed, clock.ctx);
    host.observe(mixed, clock.ctx);
    expect(counts(), 'no viewModel, init, onButton or paint for a frame without observe').toEqual(
      quiet,
    );
    expect(errors, 'nothing reported: the throwing stand-ins were never called').toEqual([]);
    expect(
      obsLog.observes.map((o) => o.id),
      'ANTI-VACUITY: the passes ran: the one observing frame, once per pass',
    ).toEqual(['questLogView', 'questLogView']);
    expect(
      host.button(stackOf(WORLD, screen('boxView')), nav('A'), clock.ctx),
      'the box resumes its own state (n = 1)',
    ).toEqual(choice(2));
    expect(lastStep(stepLog).state).toBe(boxFirst.next);
    expect(
      host.button(stackOf(WORLD, screen('helpView')), nav('A'), clock.ctx),
      'help (own observe: undefined) resumes its own state (n = 1)',
    ).toEqual(choice(2));
    expect(lastStep(stepLog).state).toBe(helpFirst.next);

    // A text-entry frame is not a frame to observe: its owner is observed through its own frame.
    const typingLog = newObsLog();
    const typingHost = new ScreenHost(
      tableWith({
        boxView: observing('boxView', typingLog),
        renameView: observing('renameView', typingLog),
      }),
      noViews,
      record,
    );
    typingHost.observe(stackOf(WORLD, screen('boxView'), textEntry('renameView')), clock.ctx);
    expect(
      typingLog.order.filter((call) => call.endsWith(':renameView')),
      'an owner that is not open is not observed through a text entry',
    ).toEqual([]);
    expect(typingLog.observes.map((o) => o.id)).toEqual(['boxView']);
    typingHost.observe(stackOf(WORLD, screen('renameView'), textEntry('renameView')), clock.ctx);
    expect(
      typingLog.observes.map((o) => o.id),
      'the owner is observed once, through its own frame',
    ).toEqual(['boxView', 'renameView']);

    // A stack of only a base runs nothing (battleView's adapter would observe if it were asked).
    const baseLog = newObsLog();
    const baseHost = new ScreenHost(
      tableWith({ battleView: observing('battleView', baseLog) }),
      noViews,
      record,
    );
    baseHost.observe(WORLD_STACK, clock.ctx);
    baseHost.observe(stackOf(battle('7')), clock.ctx);
    expect(baseLog.order, 'a bare base runs no adapter code').toEqual([]);
    expect(errors, 'nothing reported').toEqual([]);

    // The shipped table: every entry is the legacy adapter, which defines no observe.
    const spies = [
      vi.spyOn(legacyAdapter, 'viewModel'),
      vi.spyOn(legacyAdapter, 'init'),
      vi.spyOn(legacyAdapter, 'onButton'),
    ];
    try {
      const shippedErrors: unknown[] = [];
      const shipped = new ScreenHost(SCREEN_ADAPTERS, noViews, (err) => {
        shippedErrors.push(err);
      });
      // INTENTIONAL CHANGE (ctl-8a): was every overlay id; ctl-8a: the 14 legacy ids — the three
      // converted adapters observe and read a real store (CTL8A-4-HOST-FLOW covers them).
      shipped.observe(stackOf(WORLD, ...LEGACY_IDS.map((id) => screen(id))), clock.ctx);
      shipped.observe(stackOf(battle('7'), ...LEGACY_IDS.map((id) => prompt(id))), clock.ctx);
      expect(shippedErrors, 'the shipped table reports nothing').toEqual([]);
      for (const spy of spies) {
        expect(spy, 'the legacy adapter ran no code on observe').not.toHaveBeenCalled();
      }
      // ANTI-VACUITY: the spies do watch the path a legacy frame's code runs on.
      // INTENTIONAL CHANGE (ctl-8b): the probe frame is questLogView (still legacy); boxView holds
      // monstersScreen now and its button would build a Monsters view model from this storeless
      // context instead of reaching the legacy adapter. Was: boxView.
      shipped.button(stackOf(WORLD, screen('questLogView')), nav('B'), clock.ctx);
      for (const spy of spies) {
        expect(spy, 'a button does reach the legacy adapter').toHaveBeenCalledTimes(1);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// ==========================================================================================
// ctl-8a: the converted dialogue, shop and heal frames over the SHIPPED table (CTL8A.4)
// ==========================================================================================
//
// T opens these frames through main.ts's legacy paths; what changes is the adapter that answers
// them once open. A ScreenHost over the shipped SCREEN_ADAPTERS, a fake store carrying what the
// three view models read, and one recording view per frame: the D-pad and A reach each frame's own
// adapter, yield its command, and every step paints that frame's lent view exactly once. The
// dialogue and the shop open inside a store batch (main.ts then runs host.observe); the heal frame
// opens from a keydown with no batch, so its first adapter call is a button.

const FLOW_ME = 'ef'.repeat(32);

interface FlowClock {
  t: number;
}

/** A context whose store holds: a conversation with the keeper of shop 4 (Leave + Shop), heal
 *  locations 9 and 7 (7 bound, costing 25 gold), and shop 3 stocking Bait then item 8. */
function flowCtx(clock: FlowClock): ScreenContext {
  const keeper = {
    entityId: 21n,
    npcId: 'keeper',
    zoneId: 1,
    homeX: 2,
    homeY: 2,
    wanderRadius: 0,
    dialogueTreeId: 'shopkeeper_greeting',
    interaction: { kind: 'shop', shopId: 4 },
  };
  const bait = {
    id: 7,
    name: 'Bait',
    description: 'Lures a wild monster closer.',
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 15n,
    cureStatus: null,
  };
  const heal = (locationId: number, costCurrency: bigint) => ({
    locationId,
    zoneId: 1,
    tileX: locationId,
    tileY: 1,
    costQty: 0,
    cooldownMs: 0,
    costCurrency,
  });
  const store = {
    ownConversation: (owner: string) =>
      owner === FLOW_ME
        ? { ownerIdentity: FLOW_ME, npcEntityId: 21n, currentNodeId: 'greeting' }
        : undefined,
    allNpcs: () => [keeper],
    ongoingBattle: () => undefined,
    healLocations: () => [heal(9, 40n), heal(7, 25n)],
    itemDefs: () => new Map([[7, bait]]),
    allShops: () => [{ shopId: 3, name: 'Tideglass' }],
    allShopItems: () => [
      { shopItemId: 31n, shopId: 3, itemId: 7, buyPrice: 20n },
      { shopItemId: 32n, shopId: 3, itemId: 8, buyPrice: 5n },
    ],
    ownInventory: () => [],
    ownWallet: (identity: string) =>
      identity === FLOW_ME ? { ownerIdentity: FLOW_ME, balance: 100n } : undefined,
  };
  return {
    store,
    identity: FLOW_ME,
    bindings: DEFAULT_BINDINGS,
    now: () => clock.t,
    shopId: 3,
    healLocationId: 7,
    reduceMotion: false,
  } as unknown as ScreenContext;
}

interface RecordingView {
  readonly painted: unknown[];
  paint(p: unknown): void;
}
function recordingView(): RecordingView {
  const painted: unknown[] = [];
  return {
    painted,
    paint(p) {
      painted.push(p);
    },
  };
}

describe('the converted frames over the shipped table (ctl-8a, CTL8A.4)', () => {
  it('CTL8A-4-ADAPTERS-SWAPPED: the shipped table holds dialogueScreen, shopScreen and healScreen for the dialogue, shop and heal frames, each nav-capable, so each takes the D-pad on top of the world or a battle; a legacy frame above one takes it back', () => {
    // WRONG IMPL KILLED: a converted adapter written but never wired into SCREEN_ADAPTERS (T would
    // still open the legacy frame: no cursor, no quantity row, no heal action); a swap into the
    // wrong slot (the shop's adapter on the dialogue frame); an adapter without its nav mark (the
    // router would keep the D-pad for walking under the open frame); and a converted frame that
    // keeps the D-pad under a legacy child.
    expect(SCREEN_ADAPTERS.dialogueView, 'the dialogue frame').toBe(dialogueScreen);
    expect(SCREEN_ADAPTERS.shopView, 'the shop frame').toBe(shopScreen);
    expect(SCREEN_ADAPTERS.healView, 'the heal frame').toBe(healScreen);
    expect(dialogueScreen.nav).toBe(true);
    expect(shopScreen.nav).toBe(true);
    expect(healScreen.nav).toBe(true);
    const host = hostOf(SCREEN_ADAPTERS);
    for (const id of ['dialogueView', 'shopView', 'healView'] as const) {
      expect(host.takesNav(stackOf(WORLD, screen(id))), `${id} over the world`).toBe(true);
      expect(host.takesNav(stackOf(battle('7'), screen(id))), `${id} over a battle`).toBe(true);
      // INTENTIONAL CHANGE (ctl-8b): the covering legacy frame is questLogView; boxView is
      // nav-capable now, so a box frame over a converted one WOULD take the D-pad. Was: boxView.
      expect(
        host.takesNav(stackOf(WORLD, screen(id), screen('questLogView'))),
        `${id} under a legacy frame`,
      ).toBe(false);
    }
  });

  it('CTL8A-4-HOST-FLOW: over the shipped table, D-pad and A on the dialogue frame advance the conversation, on the heal frame heal at the bound location, and on the shop frame A, A, A on the first Buy row buys one; each step paints that frame`s lent view exactly once and no other', () => {
    // WRONG IMPL KILLED: a host still answering these frames through the legacy adapter (A would
    // be unhandled and nothing would be sent); an adapter whose view model cannot be built from
    // the real ScreenContext fields (shopId, healLocationId, now); a heal that ignores the bound
    // location; a shop flow that skips the quantity row or the confirm (a single A would buy); a
    // D-pad that never reaches the frame; and a paint missed, doubled, or sent to another frame's
    // view.
    const clock: FlowClock = { t: 1_000 };
    const ctx = flowCtx(clock);
    const views = {
      dialogueView: recordingView(),
      shopView: recordingView(),
      healView: recordingView(),
    };
    const lent = (id: FrameId): unknown =>
      id === 'dialogueView' || id === 'shopView' || id === 'healView' ? views[id] : undefined;
    const host = new ScreenHost(SCREEN_ADAPTERS, lent, unexpectedPaintError);
    const counts = (): readonly number[] => [
      views.dialogueView.painted.length,
      views.shopView.painted.length,
      views.healView.painted.length,
    ];

    // The dialogue opens in a batch: the observe that follows paints its first item and reveal.
    const talk = stackOf(WORLD, screen('dialogueView'));
    expect(host.takesNav(talk)).toBe(true);
    host.opened(screen('dialogueView'));
    host.observe(talk, ctx);
    expect(counts(), 'the open`s observe paints the dialogue once').toEqual([1, 0, 0]);
    expect(views.dialogueView.painted[0]).toEqual({ active: 0, revealStart: 1_000 });
    clock.t = 1_000 + DIALOGUE_REVEAL_MS;
    expect(host.button(talk, nav('Down'), ctx)).toBe('consumed');
    expect(views.dialogueView.painted.at(-1)).toEqual({ active: 'shop', revealStart: 1_000 });
    expect(host.button(talk, nav('Down'), ctx)).toBe('consumed');
    expect(views.dialogueView.painted.at(-1)).toEqual({ active: 0, revealStart: 1_000 });
    expect(host.button(talk, nav('A'), ctx)).toEqual({ kind: 'advanceDialogue', choiceIdx: 0 });
    expect(counts(), 'one paint per step').toEqual([4, 0, 0]);
    host.observe(talk, ctx);
    expect(counts(), 'a batch that changed nothing paints nothing').toEqual([4, 0, 0]);

    // The heal frame opens from T with no batch: its first adapter call is a button.
    const healing = stackOf(WORLD, screen('healView'));
    expect(host.takesNav(healing)).toBe(true);
    host.opened(screen('healView'));
    expect(host.button(healing, nav('Down'), ctx)).toBe('consumed');
    expect(views.healView.painted.at(-1)).toEqual({ active: 'no', cost: '25 gold' });
    expect(host.button(healing, nav('Up'), ctx)).toBe('consumed');
    expect(views.healView.painted.at(-1)).toEqual({ active: 'yes', cost: '25 gold' });
    expect(host.button(healing, nav('A'), ctx)).toEqual({ kind: 'healParty', locationId: 7 });
    expect(counts()).toEqual([4, 0, 3]);

    // The shop opens in a batch; nothing changed since init, so that observe paints nothing.
    const shopping = stackOf(WORLD, screen('shopView'));
    expect(host.takesNav(shopping)).toBe(true);
    host.opened(screen('shopView'));
    host.observe(shopping, ctx);
    expect(counts()).toEqual([4, 0, 3]);
    expect(host.button(shopping, nav('Down'), ctx)).toBe('consumed');
    expect(host.button(shopping, nav('Up'), ctx)).toBe('consumed');
    const [down, up] = views.shopView.painted as [{ activeKey: unknown }, { activeKey: unknown }];
    expect(down.activeKey, 'Down moved the cursor').not.toEqual(up.activeKey);
    expect(host.button(shopping, nav('A'), ctx)).toBe('consumed');
    expect(views.shopView.painted.at(-1)).toMatchObject({
      tab: 'buy',
      prompt: { kind: 'qty', tab: 'buy', name: 'Bait', qty: 1 },
    });
    expect(host.button(shopping, nav('A'), ctx)).toBe('consumed');
    expect(views.shopView.painted.at(-1)).toMatchObject({
      prompt: { kind: 'confirm', tab: 'buy', name: 'Bait', qty: 1, gold: 20n, yes: true },
    });
    expect(host.button(shopping, nav('A'), ctx)).toEqual({
      kind: 'buy',
      shopId: 3,
      itemId: 7,
      qty: 1,
    });
    expect(views.shopView.painted.at(-1)).toMatchObject({ prompt: null });
    expect(counts(), 'five shop steps, five shop paints').toEqual([4, 5, 3]);
  });
});

// ==========================================================================================
// ctl-8b: the Monsters frame over the SHIPPED table (CTL8B.4)
// ==========================================================================================
//
// KeyB and the menu's Monsters leaf both open the box frame through `boxView.show()`; swapping its
// `SCREEN_ADAPTERS` entry gives it the D-pad, A, B, LB / RB (PageUp / PageDown) and Start / Select.
// A ScreenHost over the shipped table, a fake store holding one party monster and two stored ones,
// and a recording view: the frame opens on Storage, the keys reach `monstersScreen`, Move yields its
// command, and every step paints the lent view once.

const MONSTERS_ME = 'ef'.repeat(32);

function monstersFlowCtx(): ScreenContext {
  const row = (monsterId: bigint, partySlot: number) => ({
    monsterId,
    ownerIdentity: MONSTERS_ME,
    speciesId: 1,
    nickname: '',
    level: 5,
    xp: 0,
    currentHp: 30,
    statHp: 40,
    statAttack: 10,
    statDefense: 10,
    statSpeed: 10,
    statSpAttack: 10,
    statSpDefense: 10,
    partySlot,
    tier: 0,
    essence: {},
    trustTier: 'Neutral',
    qualityTimeTier: 0,
    nutritionPct: 0,
  });
  const monsters = [row(11n, 0), row(21n, party_slot_none()), row(22n, party_slot_none())];
  const store = {
    ownMonsters: (identity: string) => (identity === MONSTERS_ME ? monsters : []),
    speciesMap: () =>
      new Map([
        [
          1,
          {
            id: 1,
            name: 'Sproutle',
            baseHp: 45,
            baseAttack: 49,
            baseDefense: 49,
            baseSpeed: 45,
            baseSpAttack: 65,
            baseSpDefense: 65,
            affinity: 'Plant',
            learnableSkillIds: [],
          },
        ],
      ]),
    evolutionPaths: () => [].values(),
    // ctl-8c (named intentional change): the Monsters view model also reads the player's inventory
    // and the item definitions (the Feed… list); this player holds nothing.
    ownInventory: () => [],
    itemDefs: () => new Map(),
  };
  return {
    store,
    identity: MONSTERS_ME,
    bindings: DEFAULT_BINDINGS,
    now: () => 0,
    shopId: null,
    healLocationId: null,
    reduceMotion: false,
  } as unknown as ScreenContext;
}

describe('the Monsters frame over the shipped table (ctl-8b, CTL8B.4)', () => {
  it('CTL8B-4-ADAPTER-SWAPPED: the shipped table holds monstersScreen for the box frame, nav-capable, so the box frame takes the D-pad on top of the world or a battle, as a screen or a prompt; a legacy frame above it, or a text entry over it, takes the D-pad back', () => {
    // WRONG IMPL KILLED: a screen written but never wired into SCREEN_ADAPTERS (KeyB would still
    // open the legacy box: no tabs, no sheet, and Rename through window.prompt); a swap into the
    // wrong slot (the Monsters screen on the raising frame); an adapter without its nav mark (the
    // router would keep the D-pad for walking under the open box); and a box that keeps the D-pad
    // under a legacy child or while its typing row owns the keys.
    expect(SCREEN_ADAPTERS.boxView, 'the box frame').toBe(monstersScreen);
    expect(monstersScreen.nav, 'nav-capable').toBe(true);
    for (const id of OVERLAY_IDS) {
      if (id === 'boxView') continue;
      expect(SCREEN_ADAPTERS[id], `${id} is not the Monsters screen`).not.toBe(monstersScreen);
    }
    const host = hostOf(SCREEN_ADAPTERS);
    expect(host.takesNav(stackOf(WORLD, screen('boxView'))), 'over the world').toBe(true);
    expect(host.takesNav(stackOf(battle('7'), screen('boxView'))), 'over a battle').toBe(true);
    expect(host.takesNav(stackOf(WORLD, prompt('boxView'))), 'as a prompt').toBe(true);
    expect(
      host.takesNav(stackOf(WORLD, screen('boxView'), screen('questLogView'))),
      'under a legacy frame',
    ).toBe(false);
    expect(
      host.takesNav(stackOf(WORLD, screen('boxView'), textEntry('boxView'))),
      'a text entry over it',
    ).toBe(false);
  });

  it('CTL8B-4-HOST-FLOW: over the shipped table the box frame opens on Storage; PageDown (RB) and PageUp (LB) switch the tab, Right moves the cursor, A opens the sheet, Up (the sheet wraps from Summary to Move) and A on Move yields setPartySlot -1 for the stored monster; every step paints the lent view once, a batch that changed nothing paints nothing, and a reopened frame starts over on Storage', () => {
    // WRONG IMPL KILLED: a host still answering the box through the legacy adapter (A would be
    // `unhandled`, PageDown would scroll the page and nothing would be sent); an adapter that
    // cannot build its view model from the real ScreenContext (identity, store reads); a tab key
    // that never reaches the frame; a Move that sends the wrong monster or the party sentinel for
    // a stored one; a paint missed, doubled, or sent to another frame's view; an observe that
    // repaints an unchanged store; and a frame that remembers the last visit's cursor (a reopen
    // must start on Storage's first monster).
    const ctx = monstersFlowCtx();
    const view = recordingView();
    const lent = (id: FrameId): unknown => (id === 'boxView' ? view : undefined);
    const host = new ScreenHost(SCREEN_ADAPTERS, lent, unexpectedPaintError);
    const stack = stackOf(WORLD, screen('boxView'));
    const last = (): Record<string, unknown> =>
      view.painted[view.painted.length - 1] as Record<string, unknown>;

    // The routed keyboard: PageDown is RB, PageUp is LB (until ctl-11a); the D-pad is nav()'s.
    const source = new KeyboardSource(routedBindings(DEFAULT_BINDINGS));
    const key = (code: string): NavInput => {
      const edges = source.keydown({ code });
      source.keyup({ code });
      expect(edges, `${code} is one routed edge`).toHaveLength(1);
      return nav((edges[0] as { button: VButton }).button);
    };

    host.opened(screen('boxView'));
    expect(host.takesNav(stack)).toBe(true);
    host.observe(stack, ctx);
    expect(
      view.painted,
      'the open`s observe paints nothing: the view draws its own opening',
    ).toEqual([]);

    expect(host.button(stack, key('PageDown'), ctx), 'RB is swallowed').toBe('consumed');
    expect(last(), 'RB: the Party tab, its first monster').toMatchObject({
      tab: 'party',
      activeKey: '11',
    });
    expect(host.button(stack, key('PageUp'), ctx), 'LB is swallowed').toBe('consumed');
    expect(last(), 'LB: back on Storage, its first monster').toMatchObject({
      tab: 'storage',
      activeKey: '21',
    });
    expect(host.button(stack, nav('Right'), ctx)).toBe('consumed');
    expect(last()).toMatchObject({ tab: 'storage', activeKey: '22' });
    expect(host.button(stack, nav('A'), ctx)).toBe('consumed');
    expect(last(), 'the sheet for the cursor monster').toMatchObject({
      tab: 'storage',
      activeKey: '22',
      sheet: { action: 'summary', card: { monsterId: 22n } },
    });
    // ctl-8c (named intentional change): the sheet is Summary, Care, Feed…, Evolve…, Nickname,
    // Move, so one Up (wrapping from Summary) reaches Move where two Downs did.
    expect(host.button(stack, nav('Up'), ctx)).toBe('consumed');
    expect(last()).toMatchObject({ sheet: { action: 'move', card: { monsterId: 22n } } });
    expect(host.button(stack, nav('A'), ctx), 'Move on a stored monster: next free slot').toEqual({
      kind: 'setPartySlot',
      monsterId: 22n,
      slot: -1,
    });
    expect(last(), 'back on the list, on the same monster').toMatchObject({
      tab: 'storage',
      activeKey: '22',
      sheet: null,
    });
    expect(view.painted.length, 'six steps, six paints').toBe(6);

    // A batch that changed nothing paints nothing.
    host.observe(stack, ctx);
    expect(view.painted.length).toBe(6);

    // B at the list pops the frame.
    expect(host.button(stack, nav('B'), ctx)).toEqual({ kind: 'pop' });
    expect(view.painted.length, 'B pops: the step still paints once').toBe(7);

    // Reopened: the cursor of the last visit is forgotten, the frame starts on Storage's first monster.
    host.opened(screen('boxView'));
    expect(host.button(stack, nav('A'), ctx)).toBe('consumed');
    expect(last(), 'the sheet of the FIRST stored monster').toMatchObject({
      tab: 'storage',
      activeKey: '21',
      sheet: { card: { monsterId: 21n } },
    });
  });
});
