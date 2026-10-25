// The UI context stack (design §4): a pure, base-first stack of frames over a `world` or
// `battle` base. Pure — no DOM, SDK, module state or clock. It sits BEHIND the legacy
// show/hide paths: main.ts mirrors the visible overlays into it (`mirrorEdges`), reconciles
// server truth into it on every batch (`reconcile`, whose `close` commands run the views' own
// hide paths), closes what a reconnect drops (`reconnectSweep`), and gates movement and
// accelerators on it (`movementEnabled`, `acceleratorsDenied`).
// Which frames may stay open over a battle is SCREEN_POLICY here (ctl-6c); the battle base's own
// button and command rules (`battleButton`, `battleRefused`) live in ui/battlePolicy.ts.
import type { OverlayId } from './overlayRegistry';
import type { SocialPanelId, SocialTab } from './screens/types';

/** The Social frame (design §5 row 4; CTL8S.3): ONE frame whose panels are the trade, pvp and
 *  leaderboard overlays, one shown at a time. The first frame id that is not an overlay id. */
export const SOCIAL_FRAME = 'social';

/** The legacy overlays are the frame ids until the screens replace them; Social is its own. */
export type FrameId = OverlayId | typeof SOCIAL_FRAME;

/** The Social frame's panels, in overlay order. */
export const SOCIAL_PANELS: readonly SocialPanelId[] = ['tradeView', 'pvpView', 'leaderboardView'];

/** The panel a requested tab opens on. Players has no root of its own, and a plain open (null)
 *  asks for no tab: both open on the trade root, and the frame's adapter picks. */
export function socialPanel(tab: SocialTab | null): SocialPanelId {
  switch (tab) {
    case 'challenges':
      return 'pvpView';
    case 'rankings':
      return 'leaderboardView';
    case 'trades':
    case 'players':
    case null:
      return 'tradeView';
  }
}

/** The frame an overlay shows as: the Social frame for its three panels, else its own. */
const frameOf = (id: OverlayId): FrameId =>
  (SOCIAL_PANELS as readonly OverlayId[]).includes(id) ? SOCIAL_FRAME : id;

export type BaseFrame =
  | { readonly kind: 'world' }
  | { readonly kind: 'battle'; readonly battleId: string };
// `nav` joins screen/prompt with the nav core (ctl-4/ctl-5).
export type UpperFrame =
  /** `overBattle`: the battle this screen was opened over (absent when opened at the world). */
  | { readonly kind: 'screen'; readonly id: FrameId; readonly overBattle?: string }
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

/** Total over every frame id, so an omitted id fails client-typecheck. `reconcile` reads all three:
 *  `battleSafe` marks a screen that may stay open when the player opens it over a battle (its
 *  screen issues no command the battle refuses); the main menu disables at least the entries that
 *  are not (`battleReason` in screens/mainMenuScreen.ts). */
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
  // Not battle-safe: the menu disables Controls over a battle, and a battle that starts closes it
  // (which also ends a capture: the view's hide path).
  controlsView: PLAYER_DROP,
  // `reconcile` reads this row for all three panels (they are never frames of their own), while
  // the main menu's battle rule still reads the panel rows. They agree only because Rankings stays
  // disabled over a battle (`HIDDEN_UNDER_BATTLE`, screens/mainMenuScreen.ts): whoever enables it
  // there must make this row agree.
  social: PLAYER_DROP,
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
 *  the base's own presentation, never a frame; over the world it is the terminal outcome. A push
 *  over a battle base is stamped with that battle only when `prevBase` (the base before this sync)
 *  was already it: an overlay first mirrored in the sync that brings the battle was opened at the
 *  world, and must drop like any other (CTL3.2). The Social panels mirror as the ONE Social frame
 *  (CTL8S.3), so a change of the shown panel raises no edge. */
export function mirrorEdges(
  stack: Stack,
  visible: readonly OverlayId[],
  prevBase: BaseFrame = stack[0],
): readonly Edge[] {
  const [base, ...upper] = stack;
  const overBattle =
    base.kind === 'battle' && prevBase.kind === 'battle' && prevBase.battleId === base.battleId
      ? base.battleId
      : undefined;
  const frames = [...new Set(visible.map(frameOf))];
  const shown = base.kind === 'battle' ? frames.filter((id) => id !== 'battleView') : frames;
  const onStack = upper.map(idOf);
  const pops: Edge[] = onStack
    .filter((id) => !shown.includes(id))
    .map((id) => ({ kind: 'pop', id }));
  const pushes: Edge[] = shown
    .filter((id) => !onStack.includes(id))
    .map((id) => ({
      kind: 'push',
      frame: overBattle === undefined ? { kind: 'screen', id } : { kind: 'screen', id, overBattle },
    }));
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
 *  outcome over the world) pops every `drop` frame but a battleSafe one the player opened over that
 *  very battle (CTL6C.1); a frame opened over a battle that is no longer the base pops even with no
 *  outcome shown; a conversation pops every player frame; a
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
    const overBattle = f.kind === 'screen' ? f.overBattle : undefined;
    const overThisBattle = base.kind === 'battle' && overBattle === base.battleId;
    const dropped =
      (overBattle !== undefined && !overThisBattle) ||
      (battleUp &&
        id !== 'battleView' &&
        policy.onBattle === 'drop' &&
        !(overThisBattle && policy.battleSafe)) ||
      (view.conversation && policy.owner === 'player');
    if (dropped) commands.push({ kind: 'close', id });
    return !dropped;
  });
  return { stack: [base, ...kept], commands };
}

/** Whether a reconnect closes the frame (so-1): the frames whose views read store state the reset
 *  invalidated or hold a lock a dropped link never settles. Total over every frame id, so an omitted
 *  id fails client-typecheck. The three Social panels are never frames of their own; their rows
 *  agree with `social`. Help, the box, the quest log, heal, claim, privacy and controls opened at
 *  the world survive a drop, as they always have; the dialogue is the server's to end. */
export const RECONNECT_CLOSES: Readonly<Record<FrameId, boolean>> = {
  battleView: true,
  boxView: false,
  raisingView: true,
  evolutionView: true,
  dialogueView: false,
  questLogView: false,
  healView: false,
  shopView: true,
  tradeView: true,
  pvpView: true,
  leaderboardView: true,
  renameView: true,
  tradeProposeView: true,
  helpView: false,
  menuView: true,
  claimView: false,
  privacyView: false,
  controlsView: false,
  social: true,
};

/** The reconnect's close (so-1): drops every upper frame that `RECONNECT_CLOSES` closes or that was
 *  opened over a battle (a re-delivered row of that battle would keep it stamped and show the battle
 *  above it), with one `close` per dropped frame, top first. Never the dialogue. The base is left
 *  as it is (the next sync derives it). Idempotent. */
export function reconnectSweep(stack: Stack): { stack: Stack; commands: readonly Command[] } {
  const [base, ...upper] = stack;
  const commands: Command[] = [];
  const kept: UpperFrame[] = [];
  for (const f of [...upper].reverse()) {
    const id = idOf(f);
    const stamped = f.kind === 'screen' && f.overBattle !== undefined;
    if (id === 'dialogueView' || !(RECONNECT_CLOSES[id] || stamped)) kept.unshift(f);
    else commands.push({ kind: 'close', id });
  }
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

/** Whether accelerators are refused (CTL11A.2): the top frame is a text entry, a prompt, or a
 *  server-owned screen (a dialogue, a battle). A bare base takes them; the session gate is the
 *  shell's to check. */
export function acceleratorsDenied(stack: Stack): boolean {
  const top = stack[stack.length - 1];
  switch (top.kind) {
    case 'world':
    case 'battle':
      return false;
    case 'textEntry':
    case 'prompt':
      return true;
    case 'screen':
      return SCREEN_POLICY[top.id].owner === 'server';
  }
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
