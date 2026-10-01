// The UI context stack (design §4): a pure, base-first stack of frames over a `world` or
// `battle` base. Pure — no DOM, SDK, module state or clock. In ctl-2 it lands BEHIND the
// legacy show/hide paths: main.ts mirrors the visible overlays into it (`mirrorEdges`) and
// gates movement and the KeyT interact guard on it (`movementEnabled`); no other key reads it.
import type { OverlayId } from './overlayRegistry';

/** The legacy overlays are the frame ids until the screens replace them. */
export type FrameId = OverlayId;

export type BaseFrame =
  | { readonly kind: 'world' }
  | { readonly kind: 'battle'; readonly battleId: string };
// `nav` joins screen/prompt with the nav core (ctl-4/ctl-5).
export type UpperFrame =
  | { readonly kind: 'screen'; readonly id: FrameId }
  | { readonly kind: 'prompt'; readonly id: FrameId }
  | { readonly kind: 'textEntry'; readonly owner: FrameId };
export type Frame = BaseFrame | UpperFrame;
/** Base-first: index 0 is the one base, every frame above it is an upper frame. */
export type Stack = readonly [BaseFrame, ...UpperFrame[]];

export const WORLD_STACK: Stack = [{ kind: 'world' }];

export type Edge =
  | { readonly kind: 'base'; readonly base: BaseFrame }
  | { readonly kind: 'push'; readonly frame: UpperFrame }
  | { readonly kind: 'pop'; readonly id: FrameId };
export type Command = { readonly kind: 'clearHeld' };

export interface ScreenPolicy {
  readonly owner: 'player' | 'server';
  readonly onBattle: 'drop' | 'suspend';
  readonly battleSafe: boolean;
}

const PLAYER_DROP: ScreenPolicy = { owner: 'player', onBattle: 'drop', battleSafe: false };
const PLAYER_DROP_SAFE: ScreenPolicy = { owner: 'player', onBattle: 'drop', battleSafe: true };

/** Total over every frame id, so an omitted id fails client-typecheck. No production code
 *  reads it yet: the values are provisional until ctl-3 (reconcile) and ctl-6c (the
 *  battle-safe policy) consume them; the tests pin totality and the dialogue row only. */
export const SCREEN_POLICY: Readonly<Record<FrameId, ScreenPolicy>> = {
  battleView: { owner: 'server', onBattle: 'drop', battleSafe: true },
  boxView: PLAYER_DROP,
  raisingView: PLAYER_DROP,
  evolutionView: PLAYER_DROP,
  dialogueView: { owner: 'server', onBattle: 'suspend', battleSafe: false },
  questLogView: PLAYER_DROP_SAFE,
  healView: PLAYER_DROP,
  shopView: PLAYER_DROP,
  tradeView: PLAYER_DROP,
  pvpView: PLAYER_DROP,
  leaderboardView: PLAYER_DROP_SAFE,
  renameView: PLAYER_DROP,
  tradeProposeView: PLAYER_DROP,
  helpView: PLAYER_DROP_SAFE,
  menuView: PLAYER_DROP_SAFE,
  claimView: PLAYER_DROP,
  privacyView: PLAYER_DROP,
};

const NO_COMMANDS: readonly Command[] = [];
const CLEAR_HELD: readonly Command[] = [{ kind: 'clearHeld' }];

const idOf = (f: UpperFrame): FrameId => (f.kind === 'textEntry' ? f.owner : f.id);

/** The one transition. A push of a new frame clears held movement (B14: every non-base push),
 *  and so does a base change of kind (a hold must not survive into or out of a battle). */
export function contextStep(
  stack: Stack,
  edge: Edge,
): { stack: Stack; commands: readonly Command[] } {
  const [base, ...upper] = stack;
  switch (edge.kind) {
    case 'base':
      return {
        stack: [edge.base, ...upper],
        commands: edge.base.kind === base.kind ? NO_COMMANDS : CLEAR_HELD,
      };
    case 'push':
      if (upper.some((f) => idOf(f) === idOf(edge.frame))) return { stack, commands: NO_COMMANDS };
      return { stack: [base, ...upper, edge.frame], commands: CLEAR_HELD };
    case 'pop':
      if (!upper.some((f) => idOf(f) === edge.id)) return { stack, commands: NO_COMMANDS };
      return { stack: [base, ...upper.filter((f) => idOf(f) !== edge.id)], commands: NO_COMMANDS };
  }
}

/** The base for the player's ongoing battle row: `battle` while it is Ongoing, else `world`. */
export function baseFor(
  battle: { readonly battleId: string; readonly outcome: string } | undefined,
): BaseFrame {
  return battle?.outcome === 'Ongoing'
    ? { kind: 'battle', battleId: battle.battleId }
    : { kind: 'world' };
}

/** The edges that bring the stack's upper frames in line with the visible legacy overlays:
 *  pops first (stack order), then pushes (visible order). Over a battle base `battleView` is
 *  the base's own presentation, never a frame; over the world it is the terminal outcome. */
export function mirrorEdges(stack: Stack, visible: readonly FrameId[]): readonly Edge[] {
  const [base, ...upper] = stack;
  const shown = base.kind === 'battle' ? visible.filter((id) => id !== 'battleView') : visible;
  const onStack = upper.map(idOf);
  const pops: Edge[] = onStack
    .filter((id) => !shown.includes(id))
    .map((id) => ({ kind: 'pop', id }));
  const pushes: Edge[] = shown
    .filter((id) => !onStack.includes(id))
    .map((id) => ({ kind: 'push', frame: { kind: 'screen', id } }));
  return [...pops, ...pushes];
}

/** The one movement gate: only a bare world stack with the session gate clear walks. */
export function movementEnabled(stack: Stack, sessionGate: boolean): boolean {
  return !sessionGate && stack.length === 1 && stack[0].kind === 'world';
}
