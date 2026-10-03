// ui/screens/socialScreen.ts — the Social frame as a pure screen over the nav kit (design §5 row 4,
// CTL8D.1-.3, CTL8G.1-.2). No DOM, SDK, module state or clock; `tradeView.ts`, `pvpView.ts` and
// `leaderboardView.ts` paint what `paint` hands them.
//
// Tabs Players | Trades | Challenges | Rankings, switched by LB/RB, each keeping its own cursor.
// The frame opens on the tab its open path asked for (`ctx.socialTab`: U, P, L, the menu leaves,
// the challenge auto-show), else on the oldest waiting request's tab, else on the tab it was left
// on (the host remembers the state), else on Players; the cursor goes to the opened tab's waiting
// request. A on a trade or challenge row opens a sheet of its legal actions, the cursor on the
// first (Accept, for a request): Accept and Cancel send at once, Decline and a trade's final
// Confirm ask Yes / No on No. B backs out one level and pops the frame from the list.
//
// Players and Rankings (CTL8G.1-.2) are painted over the leaderboard root (`leaderboardView.ts`).
// A on a player shows "Walk up to {name} and press A" (the `walkUp` phase; no remote action
// exists) until B or a move; Rankings is read-only, so A there does nothing.
//
// Every step first settles the state against the rows a batch may have moved: a gone cursor is
// re-seated, and a sheet whose row is gone or whose legal actions changed closes (it is never
// re-pointed: the cursor must not land on an action that would now send without its prompt); a
// walk-up whose player left closes, and a change in what the Players tab shows yields a new state
// so the host repaints it (`people`). An A press whose phase the settle just changed only paints
// (the shop's rule; in the shipped loop `observe` settles each batch first, so this is the belt to
// that brace).
//
// A sent command has no in-flight lock here (the views' locks guard their own buttons): the
// reducers are the authority and refuse a duplicate.
import { socialPanel } from '../contextStack';
import { list, type NavState, navFocus, navInit, navReconcile, navStep } from '../nav';
import {
  buildSocialVm,
  oldestWaiting,
  SOCIAL_TABS,
  type SocialAction,
  type SocialRow,
  type SocialVm,
  socialLayout,
  socialPeopleKey,
  socialRows,
} from '../socialModel';
import type { SocialPaint, SocialQuestion } from '../tradeView';
import type {
  ButtonStep,
  Command,
  ScreenAdapter,
  ScreenResult,
  SocialFrameView,
  SocialTab,
} from './types';

export type SocialPhase =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'sheet';
      /** The row's key. */
      readonly row: string;
      /** The row's legal actions as painted: a batch that changes them closes the sheet. */
      readonly actions: readonly SocialAction[];
      readonly action: SocialAction;
      /** The Yes / No prompt over `action`, its cursor on Yes or No; null: no prompt. */
      readonly confirm: { readonly yes: boolean } | null;
    }
  /** "Walk up to {name} and press A" over the Players row `row` (its key). */
  | { readonly kind: 'walkUp'; readonly row: string };

export interface SocialScreenState {
  /** The tab and the cursor row of each tab. */
  readonly nav: NavState;
  readonly phase: SocialPhase;
  /** What the Players tab showed when this state was made (`socialPeopleKey`): a batch that
   *  changes it yields a new state, so the host repaints the rows. */
  readonly people: string;
}

const LIST: SocialPhase = { kind: 'list' };

const tabOf = (nav: NavState): SocialTab => SOCIAL_TABS.find((tab) => tab === nav.tab) ?? 'players';

const rowAt = (vm: SocialVm, tab: SocialTab, key: string | null): SocialRow | undefined =>
  key === null ? undefined : socialRows(vm, tab).find((row) => row.key === key);

const sameActions = (a: readonly SocialAction[], b: readonly SocialAction[]): boolean =>
  a.length === b.length && a.every((action, i) => action === b[i]);

/** The question `action` asks before it is sent, else null (it sends at once). */
function questionOf(row: SocialRow, action: SocialAction): SocialQuestion | null {
  if (action === 'decline') return row.kind === 'trade' ? 'declineTrade' : 'declineChallenge';
  return action === 'confirm' && row.kind === 'trade' ? 'confirmTrade' : null;
}

/** The command `action` sends for `row`; null for an action that kind of row never offers. */
function commandOf(row: SocialRow, action: SocialAction): Command | null {
  const { id } = row;
  if (row.kind === 'trade') {
    switch (action) {
      case 'accept':
        return { kind: 'respondTrade', tradeId: id, accepted: true };
      case 'decline':
        return { kind: 'respondTrade', tradeId: id, accepted: false };
      case 'confirm':
        return { kind: 'confirmTrade', tradeId: id };
      case 'cancel':
        return { kind: 'cancelTrade', tradeId: id };
    }
  }
  if (row.kind === 'incoming') {
    if (action === 'accept') return { kind: 'acceptChallenge', challengeId: id };
    return action === 'decline' ? { kind: 'declineChallenge', challengeId: id } : null;
  }
  return action === 'cancel' ? { kind: 'cancelChallenge', challengeId: id } : null;
}

/** The prompt `phase` paints: its question and the Yes / No cursor. */
function promptOf(vm: SocialVm, tab: SocialTab, phase: SocialPhase): SocialPaint['confirm'] {
  if (phase.kind !== 'sheet' || phase.confirm === null) return null;
  const row = rowAt(vm, tab, phase.row);
  const question = row === undefined ? null : questionOf(row, phase.action);
  return question === null ? null : { question, yes: phase.confirm.yes };
}

const playerAt = (vm: SocialVm, key: string | null) =>
  vm.players.find((player) => player.key === key);

/** `state` settled against the view model's rows: the SAME object when nothing changed. */
function settle(vm: SocialVm, state: SocialScreenState): SocialScreenState {
  const layout = socialLayout(vm);
  const nav = navReconcile(layout, layout, state.nav);
  let phase = state.phase;
  if (phase.kind === 'sheet') {
    const row = rowAt(vm, tabOf(nav), phase.row);
    if (row === undefined || !sameActions(row.actions, phase.actions)) phase = LIST;
  } else if (phase.kind === 'walkUp' && playerAt(vm, phase.row) === undefined) {
    phase = LIST;
  }
  const people = socialPeopleKey(vm);
  return nav === state.nav && phase === state.phase && people === state.people
    ? state
    : { nav, phase, people };
}

export const socialScreen: ScreenAdapter<SocialVm, SocialScreenState, SocialFrameView> = {
  nav: true,
  remember: true,

  viewModel: (ctx) =>
    buildSocialVm(
      ctx.socialTab,
      ctx.store.allTradeOffers(),
      ctx.store.allChallenges(),
      ctx.identity,
      {
        players: ctx.store.allPlayers(),
        characters: Array.from(ctx.store.characters(), (character) => character.row),
        profiles: ctx.store.allProfiles(),
      },
    ),

  /** The requested tab, else the oldest waiting request's, else the remembered one, else Players;
   *  the cursor on the opened tab's waiting request. Always the list: a remembered sheet is not
   *  carried into the next open. */
  init(vm, remembered): SocialScreenState {
    const layout = socialLayout(vm);
    let nav = navInit(layout, remembered?.nav);
    const tab = vm.requested ?? oldestWaiting(vm)?.tab;
    if (tab !== undefined) nav = navFocus(layout, nav, { tab });
    const request = socialRows(vm, tabOf(nav)).find((row) => row.waiting);
    if (request !== undefined) nav = navFocus(layout, nav, { item: request.key });
    return { nav, phase: LIST, people: socialPeopleKey(vm) };
  },

  onButton(vm, kept, btn): ButtonStep<SocialScreenState> {
    const state = settle(vm, kept);
    const done = (
      result: ScreenResult,
      next: SocialScreenState = state,
    ): ButtonStep<SocialScreenState> => ({ state: next, result });
    const to = (phase: SocialPhase): ButtonStep<SocialScreenState> =>
      done('consumed', { ...state, phase });
    switch (btn.button) {
      case 'Start':
        return done(btn.repeat ? 'consumed' : { kind: 'popToBase' });
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      default:
        break;
    }
    // The A was aimed at what was on screen, which the settle just changed: it only paints.
    if (btn.button === 'A' && state.phase !== kept.phase) return done('consumed');
    const { phase } = state;
    const tab = tabOf(state.nav);

    if (phase.kind === 'walkUp') {
      switch (btn.button) {
        case 'Up':
        case 'Down':
        case 'LB':
        case 'RB': {
          // A move ends the walk-up, wherever the cursor lands.
          const nav = navStep(socialLayout(vm), state.nav, btn).state;
          return done('consumed', { ...state, nav, phase: LIST });
        }
        case 'B':
          return btn.repeat ? done('consumed') : to(LIST);
        default:
          return done('consumed');
      }
    }

    if (phase.kind === 'list') {
      switch (btn.button) {
        case 'Up':
        case 'Down':
        case 'LB':
        case 'RB': {
          const nav = navStep(socialLayout(vm), state.nav, btn).state;
          return done('consumed', nav === state.nav ? state : { ...state, nav });
        }
        case 'Left':
        case 'Right':
          return done('consumed');
        case 'A': {
          if (tab === 'players') {
            const player = playerAt(vm, state.nav.item);
            if (btn.repeat || player === undefined) return done('consumed');
            return to({ kind: 'walkUp', row: player.key });
          }
          // Rankings (read-only) and an empty tab have no row to act on: rowAt finds none.
          const row = rowAt(vm, tab, state.nav.item);
          const first = row?.actions[0];
          if (btn.repeat || row === undefined || first === undefined) return done('consumed');
          return to({
            kind: 'sheet',
            row: row.key,
            actions: row.actions,
            action: first,
            confirm: null,
          });
        }
        case 'B':
          return done(btn.repeat ? 'consumed' : { kind: 'pop' });
        default:
          return done('unhandled');
      }
    }

    // The settle closed the sheet if its row went away, so the row is there; the guard keeps the
    // function total.
    const row = rowAt(vm, tab, phase.row);
    if (row === undefined) return to(LIST);
    const send = (): ButtonStep<SocialScreenState> =>
      done(commandOf(row, phase.action) ?? 'consumed', { ...state, phase: LIST });

    if (phase.confirm !== null) {
      switch (btn.button) {
        case 'Up':
        case 'Down':
          // Two answers that wrap: a fresh press flips; a held arrow never flips the answer.
          if (btn.repeat) return done('consumed');
          return to({ ...phase, confirm: { yes: !phase.confirm.yes } });
        case 'A':
          if (btn.repeat) return done('consumed');
          return phase.confirm.yes ? send() : to({ ...phase, confirm: null });
        case 'B':
          return btn.repeat ? done('consumed') : to({ ...phase, confirm: null });
        default:
          return done('consumed');
      }
    }
    switch (btn.button) {
      case 'Up':
      case 'Down': {
        // A fresh press wraps and a held one clamps: it never slides from Decline onto Accept.
        const actions = list(phase.actions.map((key) => ({ key, enabled: true })));
        const moved = navStep(actions, { tab: null, item: phase.action, perTab: {} }, btn).state;
        const action = phase.actions.find((a) => a === moved.item);
        if (action === undefined || action === phase.action) return done('consumed');
        return to({ ...phase, action });
      }
      case 'A':
        if (btn.repeat) return done('consumed');
        return questionOf(row, phase.action) === null
          ? send()
          : to({ ...phase, confirm: { yes: false } });
      case 'B':
        return btn.repeat ? done('consumed') : to(LIST);
      default:
        return done('consumed');
    }
  },

  observe: (vm, state) => settle(vm, state),

  paint(view, vm, state): void {
    const tab = tabOf(state.nav);
    // The panel first: a paint that throws below still leaves the right one up. Players moves off
    // the trade root's placeholder onto the leaderboard root, beside Rankings.
    view.show(tab === 'players' ? 'leaderboardView' : socialPanel(tab));
    const cursor = rowAt(vm, tab, state.nav.item);
    const { phase } = state;
    view.trades?.paintSocial(view.chrome, {
      tab,
      tradeCursor: cursor?.kind === 'trade',
      // The sheet stays painted under its prompt.
      sheet: phase.kind === 'sheet' ? { actions: phase.actions, active: phase.action } : null,
      confirm: promptOf(vm, tab, phase),
    });
    view.challenges?.paintCursor(
      cursor === undefined || cursor.kind === 'trade' ? null : cursor.kind,
    );
    if (tab === 'players' || tab === 'rankings') {
      view.rankings?.paintSocial({
        tab,
        players: vm.players,
        cursor: state.nav.item,
        walkUp: phase.kind === 'walkUp' ? (playerAt(vm, phase.row)?.name ?? null) : null,
      });
    }
  },
};
