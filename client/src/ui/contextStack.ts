// The UI context stack (design §4): a pure, base-first stack of frames over a `world` or
// `battle` base. Pure — no DOM, SDK, module state or clock. It sits BEHIND the legacy
// show/hide paths: main.ts mirrors the visible overlays into it (`mirrorEdges`), reconciles
// server truth into it on every batch (`reconcile`, whose `close` commands run the views' own
// hide paths), and gates movement and the KeyT interact guard on it (`movementEnabled`). Over a
// battle it also holds the battle rules (ctl-6c): which frames may stay open over it, what Start and
// A do there (`battleButton`), and which screen commands it refuses (`battleRefused`).
import type { NavInput } from './nav';
import type { OverlayId } from './overlayRegistry';
import type {
  Command as ScreenCommand,
  ScreenResult,
  SocialPanelId,
  SocialTab,
} from './screens/types';

/** The Social frame (design §5 row 4; CTL8S.3): ONE frame whose panels are the trade, pvp and
 *  leaderboard overlays, one shown at a time. The first frame id that is not an overlay id. */
export const SOCIAL_FRAME = 'social';

/** The legacy overlays are the frame ids until the screens replace them; Social is its own. */
export type FrameId = OverlayId | typeof SOCIAL_FRAME;

/** The Social frame's panels, in overlay order. */
export const SOCIAL_PANELS: readonly SocialPanelId[] = ['tradeView', 'pvpView', 'leaderboardView'];

/** The panel a requested tab opens on. Players has no root of its own until ctl-8g, and a plain
 *  open (null) asks for no tab: both open on the trade root, and the frame's adapter picks. */
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

/** The stack is the battle base alone: no menu, dialogue or other frame above it. */
export function isBareBattle(stack: Stack): boolean {
  return stack.length === 1 && stack[0].kind === 'battle';
}

/** How long a terminal outcome is up before A continues it: an A mashed through the battle's last
 *  turn must not skip the result. B and Start continue at once. */
export const OUTCOME_CONTINUE_GRACE_MS = 400;

/** The battle's own button rules, asked before the top frame's adapter; `undefined` leaves the
 *  button to it. Start at the bare battle base opens the main menu over the battle (CTL6C.1). A on
 *  a terminal outcome continues it once it has been up `OUTCOME_CONTINUE_GRACE_MS` (`outcomeAgeMs`,
 *  undefined while none is shown) by popping only the outcome frame, as B does, so a conversation
 *  suspended beneath it survives (CTL6C.2). A held key acts once. */
export function battleButton(
  stack: Stack,
  btn: NavInput,
  outcomeAgeMs?: number,
): ScreenResult | undefined {
  const top = stack[stack.length - 1];
  if (btn.button === 'Start' && isBareBattle(stack)) {
    return btn.repeat ? 'consumed' : { kind: 'openMenu' };
  }
  if (
    btn.button === 'A' &&
    stack[0].kind === 'world' &&
    top.kind === 'screen' &&
    top.id === 'battleView'
  ) {
    if (btn.repeat || outcomeAgeMs === undefined || outcomeAgeMs < OUTCOME_CONTINUE_GRACE_MS) {
      return 'consumed';
    }
    return { kind: 'pop' };
  }
  return undefined;
}

/** Which screen commands a battle base allows (CTL6C.3): the stack moves, the battle's own actions
 *  and ending a conversation. `pickShop` ends one only to open a shop, so it is refused. Total over
 *  the `Command` kinds, so a new arm (talk, bag use) fails client-typecheck until it is classified
 *  here. Reducer guards stay the authority. */
export const COMMAND_BATTLE_POLICY: Readonly<Record<ScreenCommand['kind'], 'safe' | 'refuse'>> = {
  pop: 'safe',
  popToBase: 'safe',
  openMenu: 'safe',
  toggleHelp: 'safe',
  care: 'refuse',
  train: 'refuse',
  evolve: 'refuse',
  setNickname: 'refuse',
  setPartySlot: 'refuse',
  healParty: 'refuse',
  buy: 'refuse',
  sell: 'refuse',
  respondTrade: 'refuse',
  confirmTrade: 'refuse',
  cancelTrade: 'refuse',
  proposeTrade: 'refuse',
  challenge: 'refuse',
  acceptChallenge: 'refuse',
  declineChallenge: 'refuse',
  cancelChallenge: 'refuse',
  setProfileName: 'refuse',
  attack: 'safe',
  flee: 'safe',
  swap: 'safe',
  recruit: 'safe',
  useItem: 'safe',
  pvpAttack: 'safe',
  pvpSwap: 'safe',
  advanceDialogue: 'refuse',
  dismissDialogue: 'safe',
  pickShop: 'refuse',
  claimSignIn: 'refuse',
  claimJoin: 'refuse',
  claimDecline: 'refuse',
  deleteAccount: 'refuse',
  cancelAccountDeletion: 'refuse',
  requestDataExport: 'refuse',
};

/** Whether a battle base allows `command`: the one read of the policy table. */
export function battleSafeCommand(command: ScreenCommand): boolean {
  return COMMAND_BATTLE_POLICY[command.kind] === 'safe';
}

/** Whether `command` must be refused now: the stack holds a battle base and the command is not
 *  battle-safe. */
export function battleRefused(stack: Stack, command: ScreenCommand): boolean {
  return stack[0].kind === 'battle' && !battleSafeCommand(command);
}
