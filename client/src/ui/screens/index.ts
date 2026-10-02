// ui/screens/index.ts — the adapter table and the top-frame dispatch (design §4, §12; CTL6B.1).
// The router hands a button to `screenButton`, which asks ONLY the top frame: the base's own rule
// (`baseButton`), the typing rule over a text-entry frame, or that screen's adapter fed its own
// view model. Pure: the shell binds the stack and the context and runs the returned command.
import type { BaseFrame, FrameId, Stack } from '../contextStack';
import type { NavInput } from '../nav';
import { legacyAdapter } from './legacyAdapter';
import type { ScreenAdapter, ScreenContext, ScreenResult } from './types';

/** Total over every frame id, so a new overlay without an adapter fails client-typecheck. Every
 *  entry is the legacy adapter until its ctl-8 screen slice swaps it. */
export const SCREEN_ADAPTERS: Readonly<Record<FrameId, ScreenAdapter<unknown>>> = {
  battleView: legacyAdapter,
  boxView: legacyAdapter,
  raisingView: legacyAdapter,
  evolutionView: legacyAdapter,
  dialogueView: legacyAdapter,
  questLogView: legacyAdapter,
  healView: legacyAdapter,
  shopView: legacyAdapter,
  tradeView: legacyAdapter,
  pvpView: legacyAdapter,
  leaderboardView: legacyAdapter,
  renameView: legacyAdapter,
  tradeProposeView: legacyAdapter,
  helpView: legacyAdapter,
  menuView: legacyAdapter,
  claimView: legacyAdapter,
  privacyView: legacyAdapter,
};

/** A button with nothing above the base. Start opens the menu at the world and does nothing on a
 *  battle (B17: an ongoing battle is never hidden; ctl-6c gives it the menu). B is swallowed: its
 *  world meaning (dismiss the top notice) has no notice to act on yet. */
export function baseButton(base: BaseFrame, btn: NavInput): ScreenResult {
  switch (btn.button) {
    case 'Start':
      return base.kind === 'world' ? { kind: 'openMenu' } : 'consumed';
    case 'Select':
      return { kind: 'toggleHelp' };
    case 'B':
      return 'consumed';
    default:
      return 'unhandled';
  }
}

/** Route one button to the top frame. A text-entry frame owns every key but Start, which stops
 *  typing (pops that frame; the owner stays), and A, which commits through the owner's adapter. */
export function screenButton(
  stack: Stack,
  btn: NavInput,
  ctx: ScreenContext,
  adapters: Readonly<Record<FrameId, ScreenAdapter<unknown>>> = SCREEN_ADAPTERS,
): ScreenResult {
  const top = stack[stack.length - 1];
  const ask = (id: FrameId): ScreenResult => {
    const adapter = adapters[id];
    return adapter.onButton(adapter.viewModel(ctx), undefined, btn);
  };
  switch (top.kind) {
    case 'world':
    case 'battle':
      return baseButton(top, btn);
    case 'textEntry':
      if (btn.button === 'Start') return { kind: 'pop' };
      return btn.button === 'A' ? ask(top.owner) : 'unhandled';
    case 'screen':
    case 'prompt':
      return ask(top.id);
  }
}
