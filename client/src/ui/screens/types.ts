// ui/screens/types.ts — the shapes a screen adapter shares with the shell (design §4, §12). The
// router hands each virtual-button edge to the TOP frame's adapter, which answers with its next
// state and a `Command` (or `consumed` / `unhandled`); the shell keeps that state per frame
// (`ScreenHost`, screens/index.ts) and main.ts runs every command through ONE exhaustive `dispatch`.
import type { Bindings } from '../../input/bindings';
import type { AuthoritativeStore } from '../../net/store';
import type { LeaderboardView } from '../leaderboardView';
import type { NavInput } from '../nav';
import type { PvpView } from '../pvpView';
import type { TradeProposeArgs } from '../tradeProposeModel';
import type { TradeView } from '../tradeView';

/** The result of one screen step: the next state and the effect the shell applies. */
export interface ScreenStep<S, E> {
  readonly state: S;
  readonly effect: E;
}

/** Every action a screen issues: the stack moves, then one arm per action a screen takes (each
 *  carrying what `dispatch` needs to run it). A new arm without a `dispatch` case fails
 *  client-typecheck. */
export type Command =
  // The stack. `pop` closes the top frame, `popToBase` every frame above the base.
  | { readonly kind: 'pop' }
  | { readonly kind: 'popToBase' }
  | { readonly kind: 'openMenu' }
  | { readonly kind: 'toggleHelp' }
  // Monsters.
  | { readonly kind: 'care'; readonly monsterId: bigint }
  | { readonly kind: 'train'; readonly monsterId: bigint; readonly foodItemId: number }
  | { readonly kind: 'evolve'; readonly monsterId: bigint; readonly toSpecies: number }
  | { readonly kind: 'setNickname'; readonly monsterId: bigint; readonly nickname: string }
  | { readonly kind: 'setPartySlot'; readonly monsterId: bigint; readonly slot: number }
  // `locationId`: the heal location a bound heal frame names. Absent (the Box button, until
  // ctl-10a), `dispatch` takes the first loaded one.
  | { readonly kind: 'healParty'; readonly locationId?: number }
  // Shop. `qty` is the reducer's u32: an integer from 1 to 4294967295. `dispatch` sends nothing
  // for any other value (it never clamps).
  | {
      readonly kind: 'buy';
      readonly shopId: number;
      readonly itemId: number;
      readonly qty: number;
    }
  | { readonly kind: 'sell'; readonly itemId: number; readonly qty: number }
  // Trades and challenges.
  | { readonly kind: 'respondTrade'; readonly tradeId: bigint; readonly accepted: boolean }
  | { readonly kind: 'confirmTrade'; readonly tradeId: bigint }
  | { readonly kind: 'cancelTrade'; readonly tradeId: bigint }
  | { readonly kind: 'proposeTrade'; readonly args: TradeProposeArgs }
  | { readonly kind: 'challenge'; readonly targetIdentity: string }
  | { readonly kind: 'acceptChallenge'; readonly challengeId: bigint }
  | { readonly kind: 'declineChallenge'; readonly challengeId: bigint }
  | { readonly kind: 'cancelChallenge'; readonly challengeId: bigint }
  // Profile.
  | { readonly kind: 'setProfileName'; readonly name: string }
  // Battle.
  | { readonly kind: 'attack'; readonly battleId: bigint; readonly skillId: number }
  | { readonly kind: 'flee'; readonly battleId: bigint }
  | { readonly kind: 'swap'; readonly battleId: bigint; readonly teamIndex: number }
  | {
      readonly kind: 'recruit';
      readonly battleId: bigint;
      readonly baitItemId: number | undefined;
    }
  | { readonly kind: 'useItem'; readonly battleId: bigint; readonly itemId: number }
  | { readonly kind: 'pvpAttack'; readonly battleId: bigint; readonly skillId: number }
  | { readonly kind: 'pvpSwap'; readonly battleId: bigint; readonly teamIndex: number }
  // Dialogue. `pickShop` is the greet-then-shop choice: it ends the conversation, and the shop
  // opens on the first batch with no conversation.
  | { readonly kind: 'advanceDialogue'; readonly choiceIdx: number }
  | { readonly kind: 'dismissDialogue' }
  | { readonly kind: 'pickShop'; readonly shopId: number }
  // Account claim and privacy.
  | { readonly kind: 'claimSignIn' }
  | { readonly kind: 'claimJoin' }
  | { readonly kind: 'claimDecline' }
  | { readonly kind: 'deleteAccount' }
  | { readonly kind: 'cancelAccountDeletion' }
  | { readonly kind: 'requestDataExport' };

/** What an adapter answers for one button: a command, `consumed` (swallowed, nothing to do) or
 *  `unhandled` (not the screen's: the page or the legacy ladder keeps the key). */
export type ScreenResult = Command | 'consumed' | 'unhandled';

/** A tab of the Social frame (design §5 row 4). */
export type SocialTab = 'players' | 'trades' | 'challenges' | 'rankings';

/** The overlays the Social frame shows as its panels, one at a time (ui/contextStack.ts). */
export type SocialPanelId = 'tradeView' | 'pvpView' | 'leaderboardView';

/** The view the shell lends the Social frame's adapter (CTL8S.3): its three panel views
 *  (undefined until main() builds them) and the frame's own parts. */
export interface SocialFrameView {
  readonly trades: TradeView | undefined;
  readonly challenges: PvpView | undefined;
  readonly rankings: LeaderboardView | undefined;
  /** The frame's shared chrome: one element, hosted by whichever panel is shown. */
  readonly chrome: HTMLElement;
  /** Show `panel` alone, with the chrome in it. The frame stays the one Social frame: no stack
   *  edge, so the adapter's state survives. Nothing happens for the panel already shown, or while
   *  another frame covers the Social frame. */
  show(panel: SocialPanelId): void;
}

/** What an adapter may read to build its view model. Adapters only read it (the store type is
 *  not deep-readonly): a command is their only way to change anything. Every value is read live at
 *  each access. */
export interface ScreenContext {
  readonly store: Readonly<AuthoritativeStore>;
  readonly identity: string;
  readonly bindings: Bindings;
  readonly now: () => number;
  /** The shop the last greet-then-shop open bound, else null. It keeps its value after the shop
   *  closes (every open rebinds it) and reads null after a reconnect. 0 is a shop id. */
  readonly shopId: number | null;
  /** The heal location the last interaction with a healer bound, else null. It keeps its value
   *  after the heal frame closes and reads null after a reconnect, which can leave that frame
   *  open with no location. 0 is a location id. */
  readonly healLocationId: number | null;
  /** The Social tab the last open path asked for, else null (a plain open). It is bound before
   *  the frame shows, keeps its value after the frame closes and reads null after a reconnect. */
  readonly socialTab: SocialTab | null;
  /** The player the trade wizard was opened for (the face-to-face Trade, ctl-10b), as a hex
   *  identity; absent or null when no target was supplied. Bound before the wizard shows. */
  readonly proposeTarget?: string | null;
  /** The OS reduced-motion preference. */
  readonly reduceMotion: boolean;
}

/** What one button did to a screen: its next state and the result the shell applies. */
export interface ButtonStep<S> {
  readonly state: S;
  readonly result: ScreenResult;
}

/** One screen's input seam: a view model `VM` built from the context, a state `S` the shell keeps
 *  for the frame while it is open (and hands back at the next open, for an adapter that opts in
 *  through `remember`), and the view `V` it paints. Method syntax on purpose, so a
 *  `ScreenAdapter<SomeVm, SomeState, SomeView>` fits the `ScreenAdapter<unknown, unknown>` table. */
export interface ScreenAdapter<VM, S, V = unknown> {
  /** Nav-capable: while this frame is the top one the router hands it the D-pad, with auto-repeat. */
  readonly nav?: true;
  /** Keep this frame's state across its closes (CTL8S.1): `init` is handed the last state the
   *  shell kept for the frame, until a reconnect. Without it every open starts over. */
  readonly remember?: true;
  viewModel(ctx: ScreenContext): VM;
  /** The state a frame starts from, asked at its first step or observe after each time it opens,
   *  or at the open itself when the open path seats it (the Social frame's does). `remembered` is
   *  the last state the shell kept for the frame before this open, for an adapter that opted in
   *  through `remember`; else undefined. */
  init(vm: VM, remembered?: S): S;
  /** One button. The next state is kept and painted before the result's command runs, and that
   *  command may be refused, so a state must not assume it took effect. `btn.repeat` marks a
   *  synthesized auto-repeat: move on it, never act. */
  onButton(vm: VM, state: S, btn: NavInput): ButtonStep<S>;
  /** A store batch was applied while the frame is open, top frame or not; `now` is the shell's
   *  clock. Return the state to keep: the SAME object when nothing changed (no paint), or a new
   *  one, which is painted once. Never change a state in place: the shell compares by identity.
   *  The batch's own view renders have already run, so a view that redraws on a batch must keep
   *  what it was last painted. If `paint` throws, the frame keeps its previous state. */
  observe?(vm: VM, state: S, now: number): S;
  /** Paint the frame's view after a step, or after an observe that changed the state. The shell
   *  lends the view instance registered for the frame's id (nothing checks it against `V`); import
   *  its class as a type only, so the adapter stays free of the DOM. */
  paint?(view: V, vm: VM, state: S): void;
}
