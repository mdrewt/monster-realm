/**
 * screens/index.test.ts: the adapter table and the top-frame router (ctl-6b, CTL6B.1 / CTL6B.2 /
 * CTL6B.5 / CTL6B.6).
 *
 * Pure, node env. `SCREEN_ADAPTERS` is a total `Record<FrameId, ScreenAdapter>` (every entry the
 * legacy adapter until its ctl-8 slice swaps it); `baseButton(base, btn)` is what Start / Select / B
 * do with no frame above the base; `screenButton(stack, btn, ctx, adapters)` routes a button to
 * the TOP frame only: the base to `baseButton`, a text-entry frame to the typing rules, a
 * screen / prompt frame to its own adapter fed its OWN view model.
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
import { baseButton, SCREEN_ADAPTERS, screenButton } from './index';
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

type Adapters = Readonly<Record<FrameId, ScreenAdapter<unknown>>>;

interface Call {
  readonly id: FrameId;
  readonly vm: unknown;
  readonly nav: unknown;
  readonly btn: NavInput;
}
interface Recorder {
  readonly calls: Call[];
  readonly vmCalls: FrameId[];
}

/** One stub adapter per frame id: its view model names the id, its onButton records and answers
 *  from `answer`. */
function stubAdapters(
  rec: Recorder,
  answer: (id: FrameId, btn: NavInput) => ScreenResult,
): Adapters {
  const out = {} as Record<FrameId, ScreenAdapter<unknown>>;
  for (const id of OVERLAY_IDS) {
    out[id] = {
      viewModel(ctx) {
        rec.vmCalls.push(id);
        return { vmOf: id, ctx };
      },
      onButton(vm, navState, btn) {
        rec.calls.push({ id, vm, nav: navState, btn });
        return answer(id, btn);
      },
    };
  }
  return out;
}
const newRecorder = (): Recorder => ({ calls: [], vmCalls: [] });

/** Adapters that fail the run if anything consults them: a base frame must never reach one. */
function throwingAdapters(): Adapters {
  const out = {} as Record<FrameId, ScreenAdapter<unknown>>;
  for (const id of OVERLAY_IDS) {
    out[id] = {
      viewModel() {
        throw new Error(`the viewModel of ${id} must not be consulted here`);
      },
      onButton() {
        throw new Error(`the adapter of ${id} must not be consulted here`);
      },
    };
  }
  return out;
}

const POP: ScreenResult = { kind: 'pop' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const OPEN_MENU: ScreenResult = { kind: 'openMenu' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };

describe('SCREEN_ADAPTERS (ctl-6b)', () => {
  it('CTL6B-1-ADAPTERS-TOTAL: every overlay id has an adapter, every one is the legacy adapter, and the default table answers a legacy screen', () => {
    // WRONG IMPL KILLED: a table that omits an overlay (that frame would have no way to answer
    // B or Start), carries a stray id, holds a bespoke adapter before its ctl-8 slice lands, and a
    // screenButton whose default adapter table is not SCREEN_ADAPTERS.
    expect([...Object.keys(SCREEN_ADAPTERS)].sort()).toEqual([...OVERLAY_IDS].sort());
    for (const id of OVERLAY_IDS) {
      expect(SCREEN_ADAPTERS[id], `${id} is the legacy adapter`).toBe(legacyAdapter);
      expect(typeof SCREEN_ADAPTERS[id].viewModel, `${id}.viewModel`).toBe('function');
      expect(typeof SCREEN_ADAPTERS[id].onButton, `${id}.onButton`).toBe('function');
    }

    // The default adapter table, read through screenButton with no `adapters` argument.
    for (const id of OVERLAY_IDS) {
      const over = stackOf(WORLD, screen(id));
      expect(screenButton(over, nav('B'), CTX), `${id} B`).toEqual({ kind: 'pop' });
      expect(screenButton(over, nav('Start'), CTX), `${id} Start`).toEqual({ kind: 'popToBase' });
      expect(screenButton(over, nav('Select'), CTX), `${id} Select`).toEqual({
        kind: 'toggleHelp',
      });
      expect(screenButton(over, nav('A'), CTX), `${id} A (native Enter)`).toBe('unhandled');
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
            const result = screenButton(stack, btn, CTX, adapters);
            expect(result, `${label}: the adapter's answer is returned as is`).toEqual(
              answers[button],
            );
            expect(rec.calls.length, `${label}: exactly one adapter call`).toBe(1);
            const call = rec.calls[0] as Call;
            expect(call.id, `${label}: the top frame's adapter`).toBe(id);
            expect(call.btn, `${label}: the button`).toEqual({ button, repeat: false });
            expect(call.nav, `${label}: no nav state in legacy mode`).toBeUndefined();
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
    screenButton(stackOf(WORLD, screen('boxView')), nav('B', true), CTX, adapters);
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
      expect(
        screenButton(WORLD_STACK, nav(button), CTX, throwingAdapters()),
        `screenButton ${button}`,
      ).toEqual(WORLD_TABLE[button]);
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
        screenButton(stackOf(battle('7')), nav(button), CTX, throwingAdapters()),
        `screenButton ${button}`,
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
      const adapters = stubAdapters(rec, () => 'consumed');
      const stack = stackOf(WORLD, screen(owner), textEntry(owner));
      expect(screenButton(stack, nav('Start'), CTX, adapters), `${owner}: Start`).toEqual(POP);
      // The pure rule the shell applies leaves the owner frame standing.
      expect(popTop(stack), `${owner}: the owner frame stays`).toEqual(
        stackOf(WORLD, screen(owner)),
      );
      for (const button of VBUTTONS) {
        if (button === 'Start' || button === 'A') continue;
        expect(
          screenButton(stack, nav(button), CTX, adapters),
          `${owner}: ${button} is the field's`,
        ).toBe('unhandled');
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
      const result = screenButton(stack, nav('A'), CTX, adapters);
      expect(result, `${owner}: the owner's command`).toEqual(command);
      expect(rec.calls.length, `${owner}: exactly one adapter call`).toBe(1);
      const call = rec.calls[0] as Call;
      expect(call.id, `${owner}: the owner's adapter`).toBe(owner);
      expect(call.btn, `${owner}: A`).toEqual({ button: 'A', repeat: false });
      expect(call.nav).toBeUndefined();
      expect(call.vm, `${owner}: its own view model`).toEqual({ vmOf: owner, ctx: CTX });
      expect(rec.vmCalls, `${owner}: only the owner's view model`).toEqual([owner]);
    }

    // Control: a screen frame (no text entry) on top routes A to its own adapter all the same.
    const rec = newRecorder();
    const adapters = stubAdapters(rec, () => ({ kind: 'claimJoin' }));
    expect(screenButton(stackOf(WORLD, screen('claimView')), nav('A'), CTX, adapters)).toEqual({
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
    const ctx: RouteContext = {
      worldActive: false,
      screen: (btn) => screenButton(stack, btn, CTX, adapters),
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
