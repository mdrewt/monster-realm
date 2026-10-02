// ui/screens/types.ts — the shapes a screen adapter shares with the shell (design §4, §12). The
// router hands each virtual-button edge to the TOP frame's adapter, which answers with its next
// state and a `Command` (or `consumed` / `unhandled`); the shell keeps that state per frame
// (`ScreenHost`, screens/index.ts) and main.ts runs every command through ONE exhaustive `dispatch`.
import type { Bindings } from '../../input/bindings';
import type { AuthoritativeStore } from '../../net/store';
import type { NavInput } from '../nav';
import type { TradeProposeArgs } from '../tradeProposeModel';

/** The result of one screen step: the next state and the effect the shell applies. */
export interface ScreenStep<S, E> {
  readonly state: S;
  readonly effect: E;
}

/** Every action a screen issues: the stack moves, then one arm per reducer action a screen sends
 *  today (each carrying that view callback's arguments). A new arm without a `dispatch` case fails
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
  // Shop.
  | { readonly kind: 'buy'; readonly shopId: number; readonly itemId: number }
  | { readonly kind: 'sell'; readonly itemId: number }
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
  // Dialogue.
  | { readonly kind: 'advanceDialogue'; readonly choiceIdx: number }
  | { readonly kind: 'dismissDialogue' }
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

/** What an adapter may read to build its view model. Adapters only read it (the store type is
 *  not deep-readonly): a command is their only way to change anything. */
export interface ScreenContext {
  readonly store: Readonly<AuthoritativeStore>;
  readonly identity: string;
  readonly bindings: Bindings;
  readonly now: () => number;
}

/** What one button did to a screen: its next state and the result the shell applies. */
export interface ButtonStep<S> {
  readonly state: S;
  readonly result: ScreenResult;
}

/** One screen's input seam: a view model `VM` built from the context, a state `S` the shell keeps
 *  for the frame while it is open, and the view `V` it paints. Method syntax on purpose, so a
 *  `ScreenAdapter<SomeVm, SomeState, SomeView>` fits the `ScreenAdapter<unknown, unknown>` table. */
export interface ScreenAdapter<VM, S, V = unknown> {
  /** Nav-capable: while this frame is the top one the router hands it the D-pad, with auto-repeat. */
  readonly nav?: true;
  viewModel(ctx: ScreenContext): VM;
  /** The state a frame starts from each time it opens. */
  init(vm: VM): S;
  /** One button. The next state is kept and painted before the result's command runs, and that
   *  command may be refused, so a state must not assume it took effect. `btn.repeat` marks a
   *  synthesized auto-repeat: move on it, never act. */
  onButton(vm: VM, state: S, btn: NavInput): ButtonStep<S>;
  /** Paint the frame's view after a step. The shell lends the view instance registered for the
   *  frame's id (nothing checks it against `V`); import its class as a type only, so the adapter
   *  stays free of the DOM. */
  paint?(view: V, vm: VM, state: S): void;
}
