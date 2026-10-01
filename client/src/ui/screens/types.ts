// ui/screens/types.ts — the shapes a screen adapter shares with the shell (design §4, §12). The
// router hands each virtual-button edge to the TOP frame's adapter, which answers with a `Command`
// (or `consumed` / `unhandled`); main.ts runs every command through ONE exhaustive `dispatch`.
import type { Bindings } from '../../input/bindings';
import type { AuthoritativeStore } from '../../net/store';
import type { NavInput, NavState } from '../nav';
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
  | { readonly kind: 'healParty' }
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

/** What an adapter may read to build its view model. Read-only: commands are the only way out. */
export interface ScreenContext {
  readonly store: Readonly<AuthoritativeStore>;
  readonly identity: string;
  readonly bindings: Bindings;
  readonly now: () => number;
}

/** One screen's input seam. Method syntax on purpose, so a `ScreenAdapter<SomeVm>` fits the
 *  `ScreenAdapter<unknown>` table. */
export interface ScreenAdapter<VM> {
  viewModel(ctx: ScreenContext): VM;
  onButton(vm: VM, nav: NavState | undefined, btn: NavInput): ScreenResult;
}
