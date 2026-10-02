// The UI context stack (design §4): a pure, base-first stack of frames over a `world` or
// `battle` base. Pure — no DOM, SDK, module state or clock. It sits BEHIND the legacy
// show/hide paths: main.ts mirrors the visible overlays into it (`mirrorEdges`), reconciles
// server truth into it on every batch (`reconcile`, whose `close` commands run the views' own
// hide paths), and gates movement and the KeyT interact guard on it (`movementEnabled`).
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
export type Command =
  | { readonly kind: 'clearHeld' }
  /** Close a frame's legacy overlay through its own hide path. Never a dialogue: the client
   *  does not close a server conversation. */
  | { readonly kind: 'close'; readonly id: Exclude<FrameId, 'dialogueView'> };

export interface ScreenPolicy {
  readonly owner: 'player' | 'server';
  readonly onBattle: 'drop' | 'suspend';
  readonly battleSafe: boolean;
}

const PLAYER_DROP: ScreenPolicy = { owner: 'player', onBattle: 'drop', battleSafe: false };
const PLAYER_DROP_SAFE: ScreenPolicy = { owner: 'player', onBattle: 'drop', battleSafe: true };

/** Total over every frame id, so an omitted id fails client-typecheck. `reconcile` reads
 *  `owner` and `onBattle`; `battleSafe` stays provisional until ctl-6c consumes it. */
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

/** The server truth the stack reconciles to on every batch. */
export interface ServerView {
  /** The player's Ongoing battle, if any (either role). */
  readonly ongoingBattleId: string | undefined;
  /** A terminal outcome is (about to be) shown over the world and not yet continued. */
  readonly outcomeShown: boolean;
  /** The player has a server conversation row. */
  readonly conversation: boolean;
}

/** Server truth into the stack (CTL3.1): the base follows the battle; a battle (or its terminal
 *  outcome over the world) pops every `drop` frame; a conversation pops every player frame; a
 *  conversation that ends pops its frame silently, even suspended under a battle. It only pops:
 *  frames are pushed by the paths that show them (`mirrorEdges`), so it never strands a frame
 *  whose view is not shown. Each popped frame but dialogue gets a `close`, which runs that
 *  overlay's own hide path (CTL3.3); the client never closes a dialogue. Idempotent. */
export function reconcile(
  stack: Stack,
  view: ServerView,
): { stack: Stack; commands: readonly Command[] } {
  const based = contextStep(stack, {
    kind: 'base',
    base:
      view.ongoingBattleId === undefined
        ? { kind: 'world' }
        : { kind: 'battle', battleId: view.ongoingBattleId },
  });
  const [base, ...upper] = based.stack;
  const battleUp =
    base.kind === 'battle' || view.outcomeShown || upper.some((f) => idOf(f) === 'battleView');
  const commands: Command[] = [...based.commands];
  const kept = upper.filter((f) => {
    const id = idOf(f);
    if (id === 'dialogueView') return view.conversation;
    const policy = SCREEN_POLICY[id];
    const dropped =
      (battleUp && id !== 'battleView' && policy.onBattle === 'drop') ||
      (view.conversation && policy.owner === 'player');
    if (dropped) commands.push({ kind: 'close', id });
    return !dropped;
  });
  return { stack: [base, ...kept], commands };
}

/** Whether a player-opened frame (the deferred shop open) must not open now: a battle or its
 *  outcome is up, or another frame than a closing dialogue holds the screen. */
export function blocksPlayerOpen(stack: Stack): boolean {
  const [base, ...upper] = stack;
  return base.kind === 'battle' || upper.some((f) => idOf(f) !== 'dialogueView');
}

/** The one movement gate: only a bare world stack with the session gate clear walks. */
export function movementEnabled(stack: Stack, sessionGate: boolean): boolean {
  return !sessionGate && stack.length === 1 && stack[0].kind === 'world';
}

/** The stack with its top upper frame dropped, by position (B: back one frame). A bare base is
 *  returned as is. */
export function popTop(stack: Stack): Stack {
  if (stack.length === 1) return stack;
  const [base, ...upper] = stack;
  return [base, ...upper.slice(0, -1)];
}

/** The base alone (Start above a base). A bare base is returned as is. */
export function popToBase(stack: Stack): Stack {
  return stack.length === 1 ? stack : [stack[0]];
}

const frameKey = (f: UpperFrame): string => `${f.kind}:${idOf(f)}`;

/** The upper frames `prev` has and `next` lacks, top first (the order the retired Escape ladder
 *  closed them in), compared by kind and id, never by object identity. */
export function stackDiff(prev: Stack, next: Stack): { closed: readonly UpperFrame[] } {
  const [, ...nextUpper] = next;
  const kept = new Set(nextUpper.map(frameKey));
  const [, ...prevUpper] = prev;
  return { closed: prevUpper.filter((f) => !kept.has(frameKey(f))).reverse() };
}

/** The battle a continued outcome dismisses (pgcc-d D3): the latest battle when it has ended,
 *  else the current dismissed id unchanged, so continuing never latches an Ongoing battle. */
export function continuedBattleId(
  latest: { readonly battleId: bigint; readonly outcome: string } | undefined,
  current: bigint | null,
): bigint | null {
  return latest !== undefined && latest.outcome !== 'Ongoing' ? latest.battleId : current;
}
