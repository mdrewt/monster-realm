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
 *
 * Adapters are injected as recording stubs, so every routing claim is read off which stub was
 * called, with what, and what came back. The base cases inject adapters that THROW, so "the base
 * never consults an adapter" is a fact the run proves rather than an assumption.
 */
import { describe, expect, it } from 'vitest';
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
import { baseButton, SCREEN_ADAPTERS, ScreenHost } from './index';
import { legacyAdapter } from './legacyAdapter';
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

describe('SCREEN_ADAPTERS (ctl-6b)', () => {
  it('CTL6B-1-ADAPTERS-TOTAL: every overlay id has an adapter, every one is the legacy adapter, and the default table answers a legacy screen', () => {
    // WRONG IMPL KILLED: a table that omits an overlay (that frame would have no way to answer
    // B or Start), carries a stray id, holds a bespoke adapter before its ctl-8 slice lands, and a
    // host over SCREEN_ADAPTERS that does not answer a legacy screen as the legacy adapter does.
    expect([...Object.keys(SCREEN_ADAPTERS)].sort()).toEqual([...OVERLAY_IDS].sort());
    for (const id of OVERLAY_IDS) {
      expect(SCREEN_ADAPTERS[id], `${id} is the legacy adapter`).toBe(legacyAdapter);
      expect(typeof SCREEN_ADAPTERS[id].viewModel, `${id}.viewModel`).toBe('function');
      expect(typeof SCREEN_ADAPTERS[id].onButton, `${id}.onButton`).toBe('function');
    }

    // The default adapter table, read through a host built over SCREEN_ADAPTERS.
    const host = new ScreenHost(SCREEN_ADAPTERS, noViews, unexpectedPaintError);
    for (const id of OVERLAY_IDS) {
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

    // The shipped table is all legacy: no frame takes the D-pad until its ctl-8 screen lands.
    const shipped = hostOf(SCREEN_ADAPTERS);
    for (const id of OVERLAY_IDS) {
      expect(shipped.takesNav(stackOf(WORLD, screen(id))), `${id} screen (shipped)`).toBe(false);
      expect(shipped.takesNav(stackOf(WORLD, prompt(id))), `${id} prompt (shipped)`).toBe(false);
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
