// ui/screens/socialScreen.test.ts — ctl-8d (CTL8D.1-.3): the Social frame's pure adapter.
//
// Node env, no DOM. `socialScreen` is driven only through `viewModel(ctx)`, `init(vm, remembered)`,
// `onButton(vm, state, btn)`, `observe(vm, state, now)` and `paint(view, vm, state)`. Every press
// and every observe is handed a FRESH view model built from a mutable fake world (its rows copied
// at every read), as the host's `#step` and `observe` do, so an adapter that compares rows by
// identity, or whose settle rebuilds an unchanged phase, is caught. The context's fake store has
// the two reads the view model makes (`allTradeOffers`, `allChallenges`); `ctx.socialTab` is the tab
// the open path asked for (null: a plain open).
//
// Where the cursor and the sheet are is read off `state.nav` / `state.phase` (the plan's
// `SocialScreenState`), matched as a subset (the state may carry fields the contract does not
// name). What the frame shows is read off the calls one `paint` makes on a recording
// `SocialFrameView`: `show(panel)`, then `trades.paintSocial(chrome, p)`, then
// `challenges.paintCursor(row)`.
//
// The fixture world (the viewer 'aa…', Bob 'bb…', Carol 'cc…'):
//   trade 11        between Bob and the viewer, in one of the four role x status cells
//   challenge 21    Bob -> the viewer, Pending: incoming, a waiting request
//   challenge 22    the viewer -> Carol, Pending: outgoing
//   Row keys `trade-11`, `challenge-21`, `challenge-22`; ids distinct per row kind.
//
// The contract (plan "Functional core / imperative shell"):
//   init     tab = requested ?? the oldest waiting request's tab ?? the remembered tab ?? players;
//            the cursor on the opened tab's waiting row when it has one; always the list phase.
//   list     LB/RB switch tabs and Up/Down move (a fresh press wraps, a repeat clamps); A on a row
//            opens its sheet on the FIRST legal action; B pops; Start pops to the base; Select
//            toggles help; a repeat never acts.
//   sheet    Up/Down over the legal actions (fresh wraps, repeat clamps); B back to the list; A on
//            Accept or Cancel issues the command; A on Decline or a trade's Confirm asks Yes/No on No.
//   prompt   a fresh Up/Down flips Yes/No; A on Yes issues the command; A on No, or B, closes it.
//   settle   the SAME state when nothing changed; a sheet whose row is gone or whose legal actions
//            changed closes to the list; a press whose phase the settle just changed only paints.
//   paint    follows the state (never `vm.requested`): show the tab's panel first, then the strip
//            and the sheet through `trades.paintSocial`, then the challenge cursor.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type {
  StoreBattleChallenge,
  StoreCharacter,
  StorePlayer,
  StoreProfile,
  StoreTradeOffer,
} from '../../net/store';
import type { SocialRankingsPaint } from '../leaderboardView';
import type { NavInput } from '../nav';
import { type SocialAction, type SocialVm, socialPeopleKey } from '../socialModel';
import type { SocialPaint } from '../tradeView';
import { type SocialScreenState, socialScreen } from './socialScreen';
import type {
  ButtonStep,
  ScreenContext,
  ScreenResult,
  SocialFrameView,
  SocialPanelId,
  SocialTab,
} from './types';

const ME = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const CAROL = 'cc'.repeat(32);

/** The row keys: trade 11, the incoming challenge 21, the outgoing challenge 22. */
const TRADE = 'trade-11';
const INCOMING = 'challenge-21';
const OUTGOING = 'challenge-22';

/** The four cells of the trade table: the viewer's role and the offer's status. */
type TradeCell = 'waiting' | 'sent' | 'toConfirm' | 'accepted';
const TRADE_CELLS: readonly TradeCell[] = ['waiting', 'sent', 'toConfirm', 'accepted'];
/** Each cell's legal actions, in sheet order. */
const CELL_ACTIONS: Readonly<Record<TradeCell, readonly SocialAction[]>> = {
  // The counterparty of a Pending offer: a request to answer.
  waiting: ['accept', 'decline'],
  // The initiator of a Pending offer.
  sent: ['cancel'],
  // The initiator of an offer the counterparty accepted: the final Confirm is the viewer's.
  toConfirm: ['confirm', 'cancel'],
  // The counterparty of an offer it accepted.
  accepted: ['cancel'],
};

/** Trade `tradeId` (11) between Bob and the viewer, in `cell`. */
function trade(cell: TradeCell, createdAtMs = 1_000n, tradeId = 11n): StoreTradeOffer {
  const viewerStarted = cell === 'sent' || cell === 'toConfirm';
  return {
    tradeId,
    initiator: viewerStarted ? ME : BOB,
    counterparty: viewerStarted ? BOB : ME,
    initiatorMonsterIds: [],
    initiatorItems: [],
    initiatorCurrency: 0n,
    counterpartyMonsterIds: [],
    counterpartyItems: [],
    counterpartyCurrency: 0n,
    initiatorCards: [],
    counterpartyCards: [],
    status: cell === 'waiting' || cell === 'sent' ? 'Pending' : 'ConfirmedByCounterparty',
    createdAtMs,
  };
}

/** Bob challenges the viewer (21): a waiting request. */
function incoming(createdAtMs = 2_000n): StoreBattleChallenge {
  return {
    challengeId: 21n,
    challenger: BOB,
    target: ME,
    challengerPartyIds: [],
    status: 'Pending',
    createdAtMs,
  };
}

/** The viewer challenges Carol (22). */
function outgoing(createdAtMs = 500n): StoreBattleChallenge {
  return {
    challengeId: 22n,
    challenger: ME,
    target: CAROL,
    challengerPartyIds: [],
    status: 'Pending',
    createdAtMs,
  };
}

/** What the fake store holds and the tab the open path bound; a case edits it as a batch would.
 *  ctl-8g (named intentional change): the world also holds the players, their characters and the
 *  ranked profiles the Players and Rankings tabs list; every ctl-8d world leaves them empty. */
interface World {
  tab: SocialTab | null;
  offers: readonly StoreTradeOffer[];
  challenges: readonly StoreBattleChallenge[];
  players: readonly StorePlayer[];
  characters: readonly StoreCharacter[];
  profiles: readonly StoreProfile[];
}

const world = (over: Partial<World> = {}): World => ({
  tab: null,
  offers: [],
  challenges: [],
  players: [],
  characters: [],
  profiles: [],
  ...over,
});

function ctxOf(w: World): ScreenContext {
  // ctl-8g (named intentional change): the three reads the Players and Rankings rows make.
  // `characters()` answers a FRESH one-shot iterator of `{ row }` entries (the store's shape), the
  // others fresh copies, as every read in this file does.
  const store = {
    allTradeOffers: () => w.offers.map((o) => ({ ...o })),
    allChallenges: () => w.challenges.map((c) => ({ ...c })),
    allPlayers: () => w.players.map((p) => ({ ...p })),
    characters: () => w.characters.map((c) => ({ row: { ...c } })).values(),
    allProfiles: () => w.profiles.map((p) => ({ ...p })),
  };
  return {
    store,
    identity: ME,
    bindings: DEFAULT_BINDINGS,
    now: () => 0,
    shopId: null,
    healLocationId: null,
    socialTab: w.tab,
    reduceMotion: false,
  } as unknown as ScreenContext;
}

/** A FRESH view model from the world, as the host builds one for every step, observe and seat. */
const vmOf = (w: World): SocialVm => socialScreen.viewModel(ctxOf(w));

/** The frame opened (seated) over `w`, handed `remembered` as the host's memory would. */
const open = (w: World, remembered?: SocialScreenState): SocialScreenState =>
  socialScreen.init(vmOf(w), remembered);

type Input = VButton | NavInput;
const rep = (button: VButton): NavInput => ({ button, repeat: true });
const asInput = (input: Input): NavInput =>
  typeof input === 'string' ? { button: input, repeat: false } : input;
const label = (input: Input): string =>
  typeof input === 'string' ? input : `${input.button}${input.repeat ? ' (repeat)' : ''}`;

/** One press, on a fresh view model of the world as it is now. */
const press = (w: World, state: SocialScreenState, input: Input): ButtonStep<SocialScreenState> =>
  socialScreen.onButton(vmOf(w), state, asInput(input));

/** Feed `inputs` in order, each answered 'consumed' (no command), and return the last state. */
function swallowed(
  w: World,
  state: SocialScreenState,
  inputs: readonly Input[],
): SocialScreenState {
  let s = state;
  for (const input of inputs) {
    const step = press(w, s, input);
    expect(step.result, `${label(input)} is swallowed`).toBe('consumed');
    s = step.state;
  }
  return s;
}

/** One store batch, observed on a fresh view model of the world as it is now. */
function observe(w: World, state: SocialScreenState): SocialScreenState {
  if (socialScreen.observe === undefined) throw new Error('socialScreen must define observe');
  return socialScreen.observe(vmOf(w), state, 0);
}

/** `{ tab, item }` of the nav state: where the cursor is. */
const cursorOf = (s: SocialScreenState): { tab: string | null; item: string | null } => ({
  tab: s.nav.tab,
  item: s.nav.item,
});

const LIST = { kind: 'list' } as const;
/** A sheet phase on `row`, its cursor on `action`, with or without the Yes/No prompt. */
const sheet = (
  row: string,
  actions: readonly SocialAction[],
  action: SocialAction,
  confirm: { readonly yes: boolean } | null = null,
) => ({ kind: 'sheet' as const, row, actions, action, confirm });

const POP: ScreenResult = { kind: 'pop' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };
const respond = (accepted: boolean): ScreenResult => ({
  kind: 'respondTrade',
  tradeId: 11n,
  accepted,
});

/** The panel each tab shows, spelled here. INTENTIONAL CHANGE (ctl-8g): the Players tab is painted
 *  over the leaderboard root now (the seam map: `view.rankings` paints Players and Rankings);
 *  contextStack's `socialPanel` still answers the trade root for it, so the screen picks the panel
 *  itself. Was: players 'tradeView'. */
const PANEL: Readonly<Record<SocialTab, SocialPanelId>> = {
  players: 'leaderboardView',
  trades: 'tradeView',
  challenges: 'pvpView',
  rankings: 'leaderboardView',
};

type CursorRow = 'incoming' | 'outgoing' | null;
type ShowCall = { readonly call: 'show'; readonly panel: SocialPanelId };
type SocialCall = {
  readonly call: 'paintSocial';
  readonly chrome: unknown;
  readonly paint: SocialPaint;
};
type CursorCall = { readonly call: 'paintCursor'; readonly row: CursorRow };
type FrameCall = ShowCall | SocialCall | CursorCall;

/** The frame's chrome: a sentinel (node env), only ever handed on. */
const CHROME = { part: 'the Social chrome' } as unknown as HTMLElement;

/** One paint into a recording SocialFrameView whose `parts` exist (main() builds them late). */
function paintCalls(
  vm: SocialVm,
  state: SocialScreenState,
  parts: { readonly trades: boolean; readonly challenges: boolean } = {
    trades: true,
    challenges: true,
  },
): FrameCall[] {
  const calls: FrameCall[] = [];
  const view = {
    chrome: CHROME,
    trades: parts.trades
      ? {
          paintSocial: (chrome: unknown, paint: SocialPaint) => {
            calls.push({ call: 'paintSocial', chrome, paint });
          },
        }
      : undefined,
    challenges: parts.challenges
      ? {
          paintCursor: (row: CursorRow) => {
            calls.push({ call: 'paintCursor', row });
          },
        }
      : undefined,
    // INTENTIONAL CHANGE (ctl-8g): the Players and Rankings tabs call `rankings.paintSocial` after
    // the two calls recorded here. It is a no-op in this helper, so every ctl-8d sequence
    // assertion keeps reading the same three calls; the new call is pinned, in order and with its
    // payload, by `paintLog` and the CTL8G cases below. Was: `rankings: {}` (any call threw).
    rankings: { paintSocial: () => undefined },
    show: (panel: SocialPanelId) => {
      calls.push({ call: 'show', panel });
    },
  } as unknown as SocialFrameView;
  if (socialScreen.paint === undefined) throw new Error('socialScreen must define paint');
  socialScreen.paint(view, vm, state);
  return calls;
}

interface Painted {
  readonly panel: SocialPanelId;
  readonly paint: SocialPaint;
  readonly cursor: CursorRow;
}

/** The three calls one paint makes, in order, read off a fresh view model of the world. */
function paintOf(w: World, state: SocialScreenState): Painted {
  const calls = paintCalls(vmOf(w), state);
  expect(
    calls.map((c) => c.call),
    'show first, then paintSocial, then paintCursor, once each',
  ).toEqual(['show', 'paintSocial', 'paintCursor']);
  const [shown, social, cursor] = calls as [ShowCall, SocialCall, CursorCall];
  expect(social.chrome, 'paintSocial paints into the frame`s chrome').toBe(CHROME);
  return { panel: shown.panel, paint: social.paint, cursor: cursor.row };
}

/** The paint of the list phase on `tab`. */
const listPaint = (tab: SocialTab, tradeCursor = false): SocialPaint => ({
  tab,
  tradeCursor,
  sheet: null,
  confirm: null,
});

describe('socialScreen — opening (ctl-8d, CTL8D.1)', () => {
  it('CTL8D-1-INIT-WAITING-TAB: with no requested tab the frame opens in the list on the oldest waiting request`s tab with the cursor on it: a trade offered to the viewer opens Trades on it, a challenge to the viewer opens Challenges on the incoming row (not the outgoing one), both open the older one`s tab, and this beats a remembered tab and a remembered cursor', () => {
    // WRONG IMPL KILLED: an init that ignores waiting requests (opens on Players or the
    // remembered tab); one that treats any listed row as waiting (an older trade the viewer sent,
    // an older outgoing challenge); one that picks the newest request; one that switches to the
    // request's tab but leaves the cursor on the remembered row (the outgoing one) instead of the
    // request; and an init that opens a sheet.
    const remembered = {
      rankings: open(world({ tab: 'rankings' })),
      trades: open(world({ tab: 'trades', offers: [trade('sent')] })),
      outgoing: swallowed(
        world({ tab: 'challenges', challenges: [incoming(), outgoing()] }),
        open(world({ tab: 'challenges', challenges: [incoming(), outgoing()] })),
        ['Down'],
      ),
    };
    expect(cursorOf(remembered.rankings), 'fixture').toEqual({ tab: 'rankings', item: null });
    expect(cursorOf(remembered.trades), 'fixture').toEqual({ tab: 'trades', item: TRADE });
    expect(cursorOf(remembered.outgoing), 'fixture').toEqual({ tab: 'challenges', item: OUTGOING });

    // Only a trade waits; an outgoing challenge is listed too.
    const tradeWaits = world({ offers: [trade('waiting')], challenges: [outgoing()] });
    // Only a challenge waits; an older trade the viewer sent and an older outgoing one are listed.
    const challengeWaits = world({
      offers: [trade('sent', 100n)],
      challenges: [outgoing(100n), incoming(2_000n)],
    });
    // Both wait, the trade older; both wait, the challenge older.
    const tradeOlder = world({
      offers: [trade('waiting', 1_000n)],
      challenges: [incoming(2_000n), outgoing()],
    });
    const challengeOlder = world({
      offers: [trade('waiting', 3_000n)],
      challenges: [incoming(2_000n), outgoing()],
    });
    const CASES: ReadonlyArray<readonly [string, World, string, string]> = [
      ['only a trade waits', tradeWaits, 'trades', TRADE],
      ['only a challenge waits', challengeWaits, 'challenges', INCOMING],
      ['both wait, the trade older', tradeOlder, 'trades', TRADE],
      ['both wait, the challenge older', challengeOlder, 'challenges', INCOMING],
    ];
    let checked = 0;
    for (const [name, w, tab, item] of CASES) {
      const rememberedStates: ReadonlyArray<readonly [string, SocialScreenState | undefined]> = [
        ['nothing remembered', undefined],
        ['remembered on Rankings', remembered.rankings],
        ['remembered on Trades', remembered.trades],
        ['remembered on the outgoing row', remembered.outgoing],
      ];
      for (const [memory, rem] of rememberedStates) {
        const s = open(w, rem);
        expect(cursorOf(s), `${name}, ${memory}: the request's tab, on the request`).toEqual({
          tab,
          item,
        });
        expect(s.phase, `${name}, ${memory}: the list`).toMatchObject(LIST);
        checked += 1;
      }
    }
    expect(checked, 'ANTI-VACUITY: four worlds x four memories').toBe(16);
  });

  it('CTL8D-1-INIT-REMEMBERED-TAB: with no requested tab and nothing waiting the frame reopens on the remembered tab (Rankings, Trades, Challenges on the outgoing row), else Players; a remembered sheet or prompt reopens in the list; a remembered cursor row that is gone is re-seated on a listed row, never left dangling', () => {
    // WRONG IMPL KILLED: an adapter that does not opt in to memory, or whose init ignores the
    // remembered state (every reopen on Players); one that opens on the first tab with rows; an
    // init that carries a remembered sheet or Yes/No prompt into the next open (a stale prompt
    // over a request that may be gone); a remembered cursor key kept although its row is gone (A
    // would act on nothing); and a remembered state that loses its tab when its row is gone.
    expect(socialScreen.remember, 'the frame opts in to memory').toBe(true);
    // Nothing waits: a trade the viewer sent and its own outgoing challenge.
    const quiet = world({ offers: [trade('sent')], challenges: [outgoing()] });
    const fresh = open(quiet);
    expect(cursorOf(fresh), 'nothing remembered: Players').toEqual({ tab: 'players', item: null });
    expect(fresh.phase).toMatchObject(LIST);

    const onRankings = swallowed(quiet, fresh, ['LB']);
    expect(cursorOf(onRankings), 'fixture: LB wraps to Rankings').toEqual({
      tab: 'rankings',
      item: null,
    });
    expect(cursorOf(open(quiet, onRankings)), 'remembered on Rankings').toEqual({
      tab: 'rankings',
      item: null,
    });
    const onTrades = swallowed(quiet, fresh, ['RB']);
    expect(cursorOf(onTrades), 'fixture').toEqual({ tab: 'trades', item: TRADE });
    expect(cursorOf(open(quiet, onTrades)), 'remembered on Trades').toEqual({
      tab: 'trades',
      item: TRADE,
    });
    expect(cursorOf(open(quiet, fresh)), 'remembered on Players').toEqual({
      tab: 'players',
      item: null,
    });
    // A cursor left on the outgoing row while a request was listed above it.
    const busy = world({ challenges: [incoming(), outgoing()] });
    const onOutgoing = swallowed(busy, open(busy), ['Down']);
    expect(cursorOf(onOutgoing), 'fixture').toEqual({ tab: 'challenges', item: OUTGOING });
    const back = open(quiet, onOutgoing);
    expect(cursorOf(back), 'remembered on Challenges, on the outgoing row').toEqual({
      tab: 'challenges',
      item: OUTGOING,
    });
    expect(back.phase).toMatchObject(LIST);

    // A remembered sheet, and a remembered prompt, reopen in the list.
    const offered = world({ offers: [trade('waiting')] });
    const inSheet = swallowed(offered, open(offered), ['A']);
    const prompted = swallowed(offered, inSheet, ['Down', 'A']);
    expect(prompted.phase, 'fixture: the Decline prompt').toMatchObject(
      sheet(TRADE, ['accept', 'decline'], 'decline', { yes: false }),
    );
    // The viewer accepted elsewhere: nothing waits, so the remembered tab decides.
    const accepted = world({ offers: [trade('accepted')] });
    for (const [what, rem] of [
      ['a sheet', inSheet],
      ['a prompt', prompted],
    ] as const) {
      const reopened = open(accepted, rem);
      expect(cursorOf(reopened), `remembered ${what}: its tab and row`).toEqual({
        tab: 'trades',
        item: TRADE,
      });
      expect(reopened.phase, `remembered ${what}: the list`).toMatchObject(LIST);
      expect(open(offered, rem).phase, `remembered ${what}, the world unchanged`).toMatchObject(
        LIST,
      );
    }

    // The remembered cursor row is gone: re-seated on a listed row (or none on an empty tab).
    const onRequest = open(busy);
    expect(cursorOf(onRequest), 'fixture: on the request').toEqual({
      tab: 'challenges',
      item: INCOMING,
    });
    const answered = world({ challenges: [outgoing()] });
    expect(cursorOf(open(answered, onRequest)), 'the request was answered').toEqual({
      tab: 'challenges',
      item: OUTGOING,
    });
    const replaced = world({ offers: [trade('sent', 1_000n, 12n)] });
    expect(cursorOf(open(replaced, onTrades)), 'trade 11 replaced by trade 12').toEqual({
      tab: 'trades',
      item: 'trade-12',
    });
    expect(cursorOf(open(world(), onTrades)), 'the trade is gone: no row').toEqual({
      tab: 'trades',
      item: null,
    });
  });

  it('CTL8D-1-TABS-LBRB: in the list RB walks Players, Trades, Challenges, Rankings and a fresh RB wraps to Players; LB walks back and wraps; a repeat clamps at both ends; Trades and Challenges each keep their cursor across a round trip; Left and Right move nothing; each step paints the state`s tab, never the requested one', () => {
    // WRONG IMPL KILLED: tabs in another order; a fresh LB/RB that clamps, or a repeat that wraps
    // (a held PageDown would cycle the tabs); a tab switch that resets the other tab's cursor or
    // carries the row index across; Left/Right read as tab keys; an adapter without its nav mark;
    // a settle that forces the tab back to the requested one at every step; and a paint that
    // reads `vm.requested` (here Players) instead of the state's tab.
    expect(socialScreen.nav, 'the frame takes the D-pad').toBe(true);
    const w = world({
      tab: 'players',
      offers: [trade('waiting')],
      challenges: [incoming(), outgoing()],
    });
    const opened = open(w);
    expect(cursorOf(opened), 'fixture: the requested Players').toEqual({
      tab: 'players',
      item: null,
    });

    for (const [button, walk] of [
      ['RB', ['trades', 'challenges', 'rankings', 'players']],
      ['LB', ['rankings', 'challenges', 'trades', 'players']],
    ] as const) {
      let s = opened;
      for (const want of walk) {
        const step = press(w, s, button);
        expect(step.result, `${button} to ${want}`).toBe('consumed');
        s = step.state;
        expect(s.nav.tab, `${button} to ${want}`).toBe(want);
        expect(s.phase, `${button} to ${want}: the list`).toMatchObject(LIST);
        const painted = paintOf(w, s);
        expect(painted.panel, `${button} to ${want}: its panel`).toBe(PANEL[want]);
        expect(painted.paint.tab, `${button} to ${want}: the state's tab is painted`).toBe(want);
      }
    }

    // A repeat clamps at both ends and moves in between.
    const onRankings = swallowed(w, opened, ['LB']);
    expect(swallowed(w, opened, [rep('LB')]).nav.tab, 'a held LB on Players stays').toBe('players');
    expect(swallowed(w, onRankings, [rep('RB')]).nav.tab, 'a held RB on Rankings stays').toBe(
      'rankings',
    );
    expect(swallowed(w, opened, [rep('RB')]).nav.tab, 'a held RB moves on').toBe('trades');
    expect(swallowed(w, onRankings, [rep('LB')]).nav.tab, 'a held LB moves back').toBe(
      'challenges',
    );

    // Each tab keeps its own cursor: Down on Challenges, leave either way, come back.
    const onChallenges = swallowed(w, opened, ['RB', 'RB']);
    expect(cursorOf(onChallenges), 'fixture: the first row').toEqual({
      tab: 'challenges',
      item: INCOMING,
    });
    const onOutgoing = swallowed(w, onChallenges, ['Down']);
    expect(cursorOf(onOutgoing), 'Down').toEqual({ tab: 'challenges', item: OUTGOING });
    expect(cursorOf(swallowed(w, onOutgoing, ['RB', 'LB'])), 'Rankings and back').toEqual({
      tab: 'challenges',
      item: OUTGOING,
    });
    const viaTrades = swallowed(w, onOutgoing, ['LB']);
    expect(cursorOf(viaTrades), 'Trades keeps its row').toEqual({ tab: 'trades', item: TRADE });
    expect(cursorOf(swallowed(w, viaTrades, ['RB'])), 'Trades and back').toEqual({
      tab: 'challenges',
      item: OUTGOING,
    });
    expect(cursorOf(swallowed(w, viaTrades, ['LB', 'LB', 'LB', 'LB'])), 'a full lap').toEqual({
      tab: 'trades',
      item: TRADE,
    });
    // Up/Down in the list: a fresh press wraps, a repeat clamps.
    expect(cursorOf(swallowed(w, onOutgoing, ['Down'])).item, 'a fresh Down wraps').toBe(INCOMING);
    expect(cursorOf(swallowed(w, onOutgoing, [rep('Down')])).item, 'a held Down stays').toBe(
      OUTGOING,
    );
    expect(cursorOf(swallowed(w, onChallenges, ['Up'])).item, 'a fresh Up wraps').toBe(OUTGOING);
    expect(cursorOf(swallowed(w, onChallenges, [rep('Up')])).item, 'a held Up stays').toBe(
      INCOMING,
    );
    // Left and Right are not tab keys.
    for (const input of ['Left', 'Right', rep('Left'), rep('Right')] as const) {
      const step = press(w, onOutgoing, input);
      expect(step.result, label(input)).toBe('consumed');
      expect(cursorOf(step.state), `${label(input)} moves nothing`).toEqual({
        tab: 'challenges',
        item: OUTGOING,
      });
    }
  });
});

describe('socialScreen — the sheet and its prompt (ctl-8d, CTL8D.2)', () => {
  it('CTL8D-2-SHEET-TRADE: A on the trade row opens a sheet of exactly its legal actions, the cursor on the first, for each of the four role x status cells; Up and Down move over them (a fresh press wraps, a held one clamps on the last); B returns to the list on the row; A with no row, or on Players or Rankings, is swallowed and stays in the list', () => {
    // WRONG IMPL KILLED: a sheet that offers every action (or the legacy table's `reject`), one on
    // another cell's actions, one whose cursor opens on the last action (or on none), a held Down
    // that wraps from the last action back to the first (a held key would slide from Decline onto
    // Accept), a fresh press that clamps, a B that pops the frame from the sheet or loses the
    // cursor's row, and an A on an empty tab or a tab with no rows that opens a sheet on nothing.
    for (const cell of TRADE_CELLS) {
      const actions = CELL_ACTIONS[cell];
      const first = actions[0] as SocialAction;
      const last = actions[actions.length - 1] as SocialAction;
      const w = world({ tab: 'trades', offers: [trade(cell)] });
      const opened = open(w);
      expect(cursorOf(opened), `${cell}: fixture`).toEqual({ tab: 'trades', item: TRADE });
      const a = press(w, opened, 'A');
      expect(a.result, `${cell}: A opens the sheet and sends nothing`).toBe('consumed');
      expect(a.state.phase, `${cell}: the sheet, on the first action`).toMatchObject(
        sheet(TRADE, actions, first),
      );
      const second = actions[1 % actions.length] as SocialAction;
      expect(swallowed(w, a.state, ['Down']).phase, `${cell}: Down`).toMatchObject(
        sheet(TRADE, actions, second),
      );
      expect(swallowed(w, a.state, ['Up']).phase, `${cell}: a fresh Up wraps`).toMatchObject(
        sheet(TRADE, actions, last),
      );
      expect(swallowed(w, a.state, [rep('Up')]).phase, `${cell}: a held Up stays`).toMatchObject(
        sheet(TRADE, actions, first),
      );
      const onLast = swallowed(w, a.state, actions.length > 1 ? ['Down'] : []);
      expect(onLast.phase, `${cell}: fixture: on the last action`).toMatchObject(
        sheet(TRADE, actions, last),
      );
      expect(swallowed(w, onLast, ['Down']).phase, `${cell}: a fresh Down wraps`).toMatchObject(
        sheet(TRADE, actions, first),
      );
      expect(
        swallowed(w, onLast, [rep('Down')]).phase,
        `${cell}: a held Down on the last stays`,
      ).toMatchObject(sheet(TRADE, actions, last));
      const b = press(w, onLast, 'B');
      expect(b.result, `${cell}: B in the sheet`).toBe('consumed');
      expect(b.state.phase, `${cell}: B returns to the list`).toMatchObject(LIST);
      expect(cursorOf(b.state), `${cell}: on the row`).toEqual({ tab: 'trades', item: TRADE });
    }

    // A with no row under the cursor: an empty Trades tab, and the tabs that list nothing yet.
    const empty = world({ tab: 'trades' });
    const none = press(empty, open(empty), 'A');
    expect(none.result, 'A on an empty Trades').toBe('consumed');
    expect(none.state.phase).toMatchObject(LIST);
    for (const tab of ['players', 'rankings'] as const) {
      const w = world({ tab, offers: [trade('waiting')], challenges: [incoming()] });
      const step = press(w, open(w), 'A');
      expect(step.result, `A on ${tab}`).toBe('consumed');
      expect(step.state.phase, `A on ${tab}: no sheet`).toMatchObject(LIST);
      expect(step.state.nav.tab, `A on ${tab}: the tab stays`).toBe(tab);
    }

    // With the sheet open, or its prompt: LB, RB, Left and Right are swallowed and move nothing.
    // WRONG IMPL KILLED: LB / RB switching tabs under an open sheet or prompt (the frame would
    // paint a stale trade sheet over the Challenges or Rankings panel, and A would act on a row
    // the player no longer sees), and Left / Right moving the sheet's cursor or flipping Yes/No.
    const busy = world({
      tab: 'trades',
      offers: [trade('waiting')],
      challenges: [incoming(), outgoing()],
    });
    const busySheet = swallowed(busy, open(busy), ['A']);
    const busyPrompt = swallowed(busy, open(busy), ['A', 'Down', 'A']);
    expect(busyPrompt.phase, 'fixture: the Decline prompt').toMatchObject(
      sheet(TRADE, ['accept', 'decline'], 'decline', { yes: false }),
    );
    for (const [where, before] of [
      ['the sheet', busySheet],
      ['the prompt', busyPrompt],
    ] as const) {
      for (const button of ['LB', 'RB', 'Left', 'Right'] as const) {
        const step = press(busy, before, button);
        expect(step.result, `${button} in ${where}`).toBe('consumed');
        expect(cursorOf(step.state), `${button} in ${where}: the tab and row stay`).toEqual({
          tab: 'trades',
          item: TRADE,
        });
        expect(step.state.phase, `${button} in ${where}: the phase stays`).toEqual(before.phase);
      }
    }
  });

  it('CTL8D-2-SHEET-CHALLENGE: A on the incoming row opens a sheet of Accept and Decline, on the outgoing row one of Cancel alone (also when it is the only row), the cursor on the first; Up and Down move over them (a fresh press wraps, a held one clamps); B returns to the list on that row; A on an empty Challenges tab is swallowed', () => {
    // WRONG IMPL KILLED: a challenge sheet with every action, Accept / Decline offered on the
    // viewer's own challenge (a kind read from the row's position: the outgoing row alone is the
    // first row), Cancel offered on a request, a sheet keyed on the wrong row, a held Down that
    // wraps from Decline to Accept, a B that leaves the row, and A on an empty tab that opens a
    // sheet on nothing.
    const w = world({ tab: 'challenges', challenges: [incoming(), outgoing()] });
    const opened = open(w);
    expect(cursorOf(opened), 'fixture: on the request').toEqual({
      tab: 'challenges',
      item: INCOMING,
    });
    const REQUEST: readonly SocialAction[] = ['accept', 'decline'];
    const a = press(w, opened, 'A');
    expect(a.result, 'A opens the request`s sheet').toBe('consumed');
    expect(a.state.phase).toMatchObject(sheet(INCOMING, REQUEST, 'accept'));
    const onDecline = swallowed(w, a.state, ['Down']);
    expect(onDecline.phase, 'Down').toMatchObject(sheet(INCOMING, REQUEST, 'decline'));
    expect(swallowed(w, onDecline, ['Down']).phase, 'a fresh Down wraps').toMatchObject(
      sheet(INCOMING, REQUEST, 'accept'),
    );
    expect(swallowed(w, onDecline, [rep('Down')]).phase, 'a held Down stays').toMatchObject(
      sheet(INCOMING, REQUEST, 'decline'),
    );
    expect(swallowed(w, a.state, ['Up']).phase, 'a fresh Up wraps').toMatchObject(
      sheet(INCOMING, REQUEST, 'decline'),
    );
    expect(swallowed(w, a.state, [rep('Up')]).phase, 'a held Up stays').toMatchObject(
      sheet(INCOMING, REQUEST, 'accept'),
    );
    const backFromRequest = press(w, onDecline, 'B');
    expect(backFromRequest.result).toBe('consumed');
    expect(backFromRequest.state.phase).toMatchObject(LIST);
    expect(cursorOf(backFromRequest.state)).toEqual({ tab: 'challenges', item: INCOMING });

    // The outgoing row: Cancel alone.
    const onOutgoing = swallowed(w, opened, ['Down']);
    const ao = press(w, onOutgoing, 'A');
    expect(ao.result, 'A opens the outgoing row`s sheet').toBe('consumed');
    expect(ao.state.phase).toMatchObject(sheet(OUTGOING, ['cancel'], 'cancel'));
    for (const input of ['Down', 'Up', rep('Down'), rep('Up')] as const) {
      expect(swallowed(w, ao.state, [input]).phase, `${label(input)}: one action`).toMatchObject(
        sheet(OUTGOING, ['cancel'], 'cancel'),
      );
    }
    const backFromOutgoing = press(w, ao.state, 'B');
    expect(backFromOutgoing.state.phase).toMatchObject(LIST);
    expect(cursorOf(backFromOutgoing.state)).toEqual({ tab: 'challenges', item: OUTGOING });

    // The outgoing row as the only row is still the outgoing row.
    const alone = world({ tab: 'challenges', challenges: [outgoing()] });
    const aloneOpened = open(alone);
    expect(cursorOf(aloneOpened), 'fixture').toEqual({ tab: 'challenges', item: OUTGOING });
    expect(press(alone, aloneOpened, 'A').state.phase, 'the outgoing row alone').toMatchObject(
      sheet(OUTGOING, ['cancel'], 'cancel'),
    );

    // No row.
    const empty = world({ tab: 'challenges' });
    const none = press(empty, open(empty), 'A');
    expect(none.result, 'A on an empty Challenges').toBe('consumed');
    expect(none.state.phase).toMatchObject(LIST);
  });

  it('CTL8D-2-CONFIRM-DEFAULT-NO: A on a trade`s Decline, on a trade`s final Confirm and on a challenge`s Decline sends nothing and asks Yes/No on No; A on No sends nothing and closes the prompt with the sheet still on that action; a fresh Up or Down flips the answer and a held one never does; B closes the prompt and keeps the sheet; Accept and Cancel ask nothing', () => {
    // WRONG IMPL KILLED (CTL8D.2 "Decline and the final trade Confirm default to No"): a prompt
    // that opens on Yes (one more Enter would decline or complete the trade); a Decline or a
    // Confirm with no prompt at all (the command on the first A); a challenge Decline that skips
    // the prompt; an A on No that sends the command anyway or closes the whole sheet; a held arrow
    // that flips the answer (a held key would land on Yes); a B that sends, pops the frame or
    // closes the sheet with the prompt; and a prompt on Accept or Cancel (they act at once).
    const CASES: ReadonlyArray<{
      readonly name: string;
      readonly w: World;
      readonly row: string;
      readonly actions: readonly SocialAction[];
      readonly action: SocialAction;
      readonly reach: readonly Input[];
    }> = [
      {
        name: 'trade Decline',
        w: world({ tab: 'trades', offers: [trade('waiting')] }),
        row: TRADE,
        actions: ['accept', 'decline'],
        action: 'decline',
        reach: ['A', 'Down'],
      },
      {
        name: 'trade Confirm',
        w: world({ tab: 'trades', offers: [trade('toConfirm')] }),
        row: TRADE,
        actions: ['confirm', 'cancel'],
        action: 'confirm',
        reach: ['A'],
      },
      {
        name: 'challenge Decline',
        w: world({ tab: 'challenges', challenges: [incoming(), outgoing()] }),
        row: INCOMING,
        actions: ['accept', 'decline'],
        action: 'decline',
        reach: ['A', 'Down'],
      },
    ];
    for (const c of CASES) {
      const on = (confirm: { readonly yes: boolean } | null) =>
        sheet(c.row, c.actions, c.action, confirm);
      const onAction = swallowed(c.w, open(c.w), c.reach);
      expect(onAction.phase, `${c.name}: fixture`).toMatchObject(on(null));

      const asked = press(c.w, onAction, 'A');
      expect(asked.result, `${c.name}: A sends nothing`).toBe('consumed');
      expect(asked.state.phase, `${c.name}: the prompt opens on No`).toMatchObject(
        on({ yes: false }),
      );

      const no = press(c.w, asked.state, 'A');
      expect(no.result, `${c.name}: A on No sends nothing`).toBe('consumed');
      expect(no.state.phase, `${c.name}: A on No closes the prompt, the sheet stays`).toMatchObject(
        on(null),
      );

      for (const flip of ['Down', 'Up'] as const) {
        const yes = press(c.w, asked.state, flip);
        expect(yes.result, `${c.name}: ${flip}`).toBe('consumed');
        expect(yes.state.phase, `${c.name}: a fresh ${flip} flips to Yes`).toMatchObject(
          on({ yes: true }),
        );
        expect(
          swallowed(c.w, yes.state, [flip]).phase,
          `${c.name}: and another flips back to No`,
        ).toMatchObject(on({ yes: false }));
        expect(
          swallowed(c.w, asked.state, [rep(flip)]).phase,
          `${c.name}: a held ${flip} stays on No`,
        ).toMatchObject(on({ yes: false }));
        expect(
          swallowed(c.w, yes.state, [rep(flip)]).phase,
          `${c.name}: a held ${flip} stays on Yes`,
        ).toMatchObject(on({ yes: true }));
      }

      for (const [from, s] of [
        ['No', asked.state],
        ['Yes', swallowed(c.w, asked.state, ['Down'])],
      ] as const) {
        const b = press(c.w, s, 'B');
        expect(b.result, `${c.name}: B on ${from} sends nothing`).toBe('consumed');
        expect(b.state.phase, `${c.name}: B on ${from} closes the prompt only`).toMatchObject(
          on(null),
        );
      }
    }

    // Accept and Cancel act at once: a command, back on the list, no prompt.
    const duel = world({ tab: 'challenges', challenges: [incoming(), outgoing()] });
    const NO_PROMPT: ReadonlyArray<readonly [string, World, readonly Input[]]> = [
      ['trade Accept', world({ tab: 'trades', offers: [trade('waiting')] }), ['A']],
      ['trade Cancel (sent)', world({ tab: 'trades', offers: [trade('sent')] }), ['A']],
      [
        'trade Cancel (to confirm)',
        world({ tab: 'trades', offers: [trade('toConfirm')] }),
        ['A', 'Down'],
      ],
      ['trade Cancel (accepted)', world({ tab: 'trades', offers: [trade('accepted')] }), ['A']],
      ['challenge Accept', duel, ['A']],
      ['challenge Cancel', duel, ['Down', 'A']],
    ];
    for (const [name, w, reach] of NO_PROMPT) {
      const step = press(w, swallowed(w, open(w), reach), 'A');
      expect(typeof step.result, `${name}: A issues a command`).toBe('object');
      expect(step.state.phase, `${name}: no prompt, back on the list`).toMatchObject(LIST);
    }
  });

  it('CTL8D-2-COMMANDS: the seven commands carry their exact ids (trade Accept / Decline / Confirm / Cancel on trade 11, challenge Accept / Decline on 21, Cancel on 22) and each returns to the list; A, A on a waiting request accepts it; B in the list pops, Start pops to the base in the list, the sheet and the prompt, and Select toggles help', () => {
    // WRONG IMPL KILLED: respondTrade with the wrong `accepted` (Decline sent as an accept, or
    // Accept as a decline); confirmTrade / cancelTrade swapped; a trade command carrying a
    // challenge id or the other way round (the ids are distinct per row kind); acceptChallenge on
    // the outgoing row or cancelChallenge on the request; a command that leaves the sheet open; a
    // request that takes more than U, Enter, Enter to accept (design section 5); and a Start that
    // a sheet or a prompt swallows (the e2e closeAll presses Start).
    const tradeIn = (cell: TradeCell): World => world({ tab: 'trades', offers: [trade(cell)] });
    const duel = world({ tab: 'challenges', challenges: [incoming(), outgoing()] });
    const CASES: ReadonlyArray<readonly [string, World, readonly Input[], ScreenResult]> = [
      ['trade Accept', tradeIn('waiting'), ['A', 'A'], respond(true)],
      ['trade Decline, Yes', tradeIn('waiting'), ['A', 'Down', 'A', 'Down', 'A'], respond(false)],
      [
        'trade Confirm, Yes',
        tradeIn('toConfirm'),
        ['A', 'A', 'Up', 'A'],
        { kind: 'confirmTrade', tradeId: 11n },
      ],
      ['trade Cancel (sent)', tradeIn('sent'), ['A', 'A'], { kind: 'cancelTrade', tradeId: 11n }],
      [
        'trade Cancel (to confirm)',
        tradeIn('toConfirm'),
        ['A', 'Down', 'A'],
        { kind: 'cancelTrade', tradeId: 11n },
      ],
      [
        'trade Cancel (accepted)',
        tradeIn('accepted'),
        ['A', 'A'],
        { kind: 'cancelTrade', tradeId: 11n },
      ],
      ['challenge Accept', duel, ['A', 'A'], { kind: 'acceptChallenge', challengeId: 21n }],
      [
        'challenge Decline, Yes',
        duel,
        ['A', 'Down', 'A', 'Down', 'A'],
        { kind: 'declineChallenge', challengeId: 21n },
      ],
      ['challenge Cancel', duel, ['Down', 'A', 'A'], { kind: 'cancelChallenge', challengeId: 22n }],
      [
        'challenge Cancel, the outgoing row alone',
        world({ tab: 'challenges', challenges: [outgoing()] }),
        ['A', 'A'],
        { kind: 'cancelChallenge', challengeId: 22n },
      ],
    ];
    for (const [name, w, inputs, command] of CASES) {
      const before = swallowed(w, open(w), inputs.slice(0, -1));
      const step = press(w, before, inputs[inputs.length - 1] as Input);
      expect(step.result, name).toEqual(command);
      expect(step.state.phase, `${name}: back on the list`).toMatchObject(LIST);
    }

    // A plain open lands on the request, so A, A answers it (design section 5: U, Enter, Enter).
    const offered = world({ offers: [trade('waiting')], challenges: [outgoing()] });
    const plain = open(offered);
    expect(cursorOf(plain), 'fixture: a plain open on the offer').toEqual({
      tab: 'trades',
      item: TRADE,
    });
    expect(press(offered, swallowed(offered, plain, ['A']), 'A').result, 'A, A').toEqual(
      respond(true),
    );
    const challenged = world({ tab: 'challenges', challenges: [outgoing(), incoming()] });
    expect(
      press(challenged, swallowed(challenged, open(challenged), ['A']), 'A').result,
      'P (or the auto-show), A, A',
    ).toEqual({ kind: 'acceptChallenge', challengeId: 21n });

    // The stack moves.
    const w = tradeIn('waiting');
    const list = open(w);
    const inSheet = swallowed(w, list, ['A']);
    const inPrompt = swallowed(w, list, ['A', 'Down', 'A']);
    expect(inPrompt.phase, 'fixture: a prompt').toMatchObject(
      sheet(TRADE, ['accept', 'decline'], 'decline', { yes: false }),
    );
    expect(press(w, list, 'B').result, 'B in the list pops the frame').toEqual(POP);
    for (const [where, s] of [
      ['list', list],
      ['sheet', inSheet],
      ['prompt', inPrompt],
    ] as const) {
      expect(press(w, s, 'Start').result, `Start in the ${where}`).toEqual(POP_TO_BASE);
      expect(press(w, s, 'Select').result, `Select in the ${where}`).toEqual(TOGGLE_HELP);
    }
  });

  it('CTL8D-2-REPEAT-NEVER-ACTS: a repeat-flagged A opens no sheet from the list, sends nothing on Accept or Cancel, opens no prompt on Decline and sends nothing on Yes; a repeat-flagged B, Start or Select is swallowed in the list, the sheet and the prompt', () => {
    // WRONG IMPL KILLED: an A whose auto-repeat acts (a held Enter would open the sheet and send
    // Accept, or confirm a Yes, with one key press); a held B that pops the frame, or a held Start
    // or Select that pops to the base or toggles help over and over.
    const w = world({ tab: 'trades', offers: [trade('waiting')] });
    const list = open(w);
    const heldInList = press(w, list, rep('A'));
    expect(heldInList.result, 'a held A in the list').toBe('consumed');
    expect(heldInList.state.phase, 'opens no sheet').toMatchObject(LIST);

    const sent = world({ tab: 'trades', offers: [trade('sent')] });
    const duel = world({ tab: 'challenges', challenges: [incoming(), outgoing()] });
    const ACTING: ReadonlyArray<
      readonly [string, World, readonly Input[], ReturnType<typeof sheet>]
    > = [
      ['trade Accept', w, ['A'], sheet(TRADE, ['accept', 'decline'], 'accept')],
      ['trade Cancel', sent, ['A'], sheet(TRADE, ['cancel'], 'cancel')],
      ['challenge Accept', duel, ['A'], sheet(INCOMING, ['accept', 'decline'], 'accept')],
      ['challenge Cancel', duel, ['Down', 'A'], sheet(OUTGOING, ['cancel'], 'cancel')],
      ['trade Decline', w, ['A', 'Down'], sheet(TRADE, ['accept', 'decline'], 'decline')],
    ];
    for (const [name, rows, reach, phase] of ACTING) {
      const on = swallowed(rows, open(rows), reach);
      expect(on.phase, `${name}: fixture`).toMatchObject(phase);
      const held = press(rows, on, rep('A'));
      expect(held.result, `${name}: a held A sends nothing`).toBe('consumed');
      expect(held.state.phase, `${name}: the sheet stays as it was`).toMatchObject(phase);
    }

    const onYes = swallowed(w, list, ['A', 'Down', 'A', 'Down']);
    const yes = sheet(TRADE, ['accept', 'decline'], 'decline', { yes: true });
    expect(onYes.phase, 'fixture: the prompt on Yes').toMatchObject(yes);
    const heldOnYes = press(w, onYes, rep('A'));
    expect(heldOnYes.result, 'a held A on Yes sends nothing').toBe('consumed');
    expect(heldOnYes.state.phase, 'the prompt stays on Yes').toMatchObject(yes);
    expect(press(w, heldOnYes.state, 'A').result, 'ANTI-VACUITY: a fresh A there declines').toEqual(
      respond(false),
    );

    const inSheet = swallowed(w, list, ['A']);
    for (const [where, s] of [
      ['list', list],
      ['sheet', inSheet],
      ['prompt', onYes],
    ] as const) {
      for (const button of ['B', 'Start', 'Select'] as const) {
        expect(press(w, s, rep(button)).result, `a held ${button} in the ${where}`).toBe(
          'consumed',
        );
      }
    }

    // A held B closes nothing: the sheet, and the prompt over it, stay exactly as they were.
    // WRONG IMPL KILLED: a held B that closes the prompt or the sheet (one held Backspace would
    // close the prompt, then the sheet, on its auto-repeat).
    for (const [where, s] of [
      ['sheet', inSheet],
      ['prompt', onYes],
    ] as const) {
      const held = press(w, s, rep('B'));
      expect(held.state.phase, `a held B in the ${where}: the phase stays`).toEqual(s.phase);
      expect(cursorOf(held.state), `a held B in the ${where}: the cursor stays`).toEqual(
        cursorOf(s),
      );
    }
  });

  it('CTL8D-2-SETTLE: observe answers the SAME state when nothing changed (in the list, a sheet and a prompt, and when only rows of others changed), and A still acts after it; a sheet whose row is gone or replaced closes to the list with the cursor re-seated; a sheet whose legal actions changed closes to the list, prompt or not; an A pressed as such a change lands sends nothing', () => {
    // WRONG IMPL KILLED: an observe that answers a new object every batch (a repaint at batch
    // rate); a settle that rebuilds an equal phase from a fresh view model (A then never acts: the
    // phase looks changed on every press); rows compared by identity rather than by value; a
    // sheet left open over a row that is gone, or re-pointed at the replacing row (A would act on
    // another trade than the one the player chose); a sheet re-pointed at the same index or the
    // same action when the legal actions change (the counterparty's Decline becoming the
    // immediate Cancel under the cursor; the initiator's Cancel becoming a Confirm); a prompt left
    // open over actions that changed; and an A in the same step as such a change that acts.
    const w = world({
      tab: 'trades',
      offers: [trade('waiting')],
      challenges: [incoming(), outgoing()],
    });
    const list = open(w);
    const inSheet = swallowed(w, list, ['A']);
    const onYes = swallowed(w, list, ['A', 'Down', 'A', 'Down']);
    const onOutgoing = swallowed(w, list, ['RB', 'Down']);
    expect(cursorOf(onOutgoing), 'fixture').toEqual({ tab: 'challenges', item: OUTGOING });
    const outSheet = swallowed(w, onOutgoing, ['A']);
    // Only rows of others change: another pair's trade and a third party's challenge arrive.
    const othersMoved: World = {
      ...w,
      offers: [...w.offers, { ...trade('waiting', 50n, 5n), initiator: BOB, counterparty: CAROL }],
      challenges: [{ ...incoming(50n), challengeId: 3n, target: CAROL }, ...w.challenges],
    };
    for (const [where, s] of [
      ['the list', list],
      ['a sheet', inSheet],
      ['a prompt on Yes', onYes],
      ['the challenges list', onOutgoing],
      ['the outgoing sheet', outSheet],
    ] as const) {
      expect(observe(w, s), `${where}: nothing changed, the same state`).toBe(s);
      expect(observe(othersMoved, s), `${where}: only others' rows changed`).toBe(s);
    }

    // After an unchanged batch, A still acts on a fresh, equal view model.
    expect(press(w, observe(w, inSheet), 'A').result, 'A on Accept after a batch').toEqual(
      respond(true),
    );
    expect(press(w, observe(w, onYes), 'A').result, 'A on Yes after a batch').toEqual(
      respond(false),
    );
    expect(
      press(w, observe(w, outSheet), 'A').result,
      'A on the outgoing Cancel after a batch',
    ).toEqual({ kind: 'cancelChallenge', challengeId: 22n });

    // The sheet's row is gone: the list, the cursor re-seated on a listed row.
    const noOutgoing: World = { ...w, challenges: [incoming()] };
    const closed = observe(noOutgoing, outSheet);
    expect(closed.phase, 'the outgoing challenge is gone: the list').toMatchObject(LIST);
    expect(cursorOf(closed), 'the cursor re-seated').toEqual({ tab: 'challenges', item: INCOMING });
    // The sheet's row is replaced by another id: the list, on the new row; an A in that same step
    // sends nothing (neither for trade 11 nor for trade 12).
    const replaced: World = { ...w, offers: [trade('waiting', 1_000n, 12n)] };
    const reseated = observe(replaced, inSheet);
    expect(reseated.phase, 'trade 11 replaced by trade 12: the list').toMatchObject(LIST);
    expect(cursorOf(reseated), 'on the new row').toEqual({ tab: 'trades', item: 'trade-12' });
    const pressedAsReplaced = press(replaced, inSheet, 'A');
    expect(pressedAsReplaced.result, 'an A as the row is replaced').toBe('consumed');
    expect(pressedAsReplaced.state.phase).toMatchObject(LIST);
    const pressedAsGone = press(noOutgoing, outSheet, 'A');
    expect(pressedAsGone.result, 'an A as the row goes').toBe('consumed');
    expect(pressedAsGone.state.phase).toMatchObject(LIST);

    // The legal actions change under an open sheet: the initiator's Cancel alone becomes Confirm,
    // Cancel (the counterparty accepted).
    const sent = world({ tab: 'trades', offers: [trade('sent')] });
    const onCancel = swallowed(sent, open(sent), ['A']);
    expect(onCancel.phase, 'fixture').toMatchObject(sheet(TRADE, ['cancel'], 'cancel'));
    const confirmable = world({ tab: 'trades', offers: [trade('toConfirm')] });
    // The counterparty's Accept, Decline becomes Cancel alone (it accepted elsewhere), with the
    // cursor on Decline, and with the prompt open on No and on Yes.
    const offered = world({ tab: 'trades', offers: [trade('waiting')] });
    const accepted = world({ tab: 'trades', offers: [trade('accepted')] });
    const onDecline = swallowed(offered, open(offered), ['A', 'Down']);
    const askedNo = swallowed(offered, onDecline, ['A']);
    const askedYes = swallowed(offered, askedNo, ['Down']);
    expect(askedYes.phase, 'fixture').toMatchObject(
      sheet(TRADE, ['accept', 'decline'], 'decline', { yes: true }),
    );
    let changes = 0;
    for (const [where, before, after] of [
      ['Cancel, now Confirm, Cancel', onCancel, confirmable],
      ['Decline, now Cancel', onDecline, accepted],
      ['the Decline prompt on No, now Cancel', askedNo, accepted],
      ['the Decline prompt on Yes, now Cancel', askedYes, accepted],
    ] as const) {
      const settled = observe(after, before);
      expect(settled.phase, `${where}: observe closes the sheet`).toMatchObject(LIST);
      expect(cursorOf(settled), `${where}: on the row`).toEqual({ tab: 'trades', item: TRADE });
      const pressed = press(after, before, 'A');
      expect(pressed.result, `${where}: an A in the same step sends nothing`).toBe('consumed');
      expect(pressed.state.phase, `${where}: and lands on the list`).toMatchObject(LIST);
      changes += 1;
    }
    expect(changes, 'ANTI-VACUITY: four changes driven').toBe(4);

    // An offer in a status this client does not know (version skew: the row converter passes it
    // through raw): the view model still builds (the host builds it uncaught on every button), the
    // frame opens on Trades with no row, A has nothing to act on and B still closes the frame; a
    // sheet open on the offer when its status turns unknown closes to the list.
    // WRONG IMPL KILLED: a view model that throws on the unknown status (B and Start could no
    // longer close the frame), a trade row with an empty sheet, and a sheet left open on it.
    const skewed = world({
      tab: 'trades',
      offers: [{ ...trade('waiting'), status: 'Weird' as StoreTradeOffer['status'] }],
    });
    expect(() => vmOf(skewed), 'an unknown status: the view model builds').not.toThrow();
    const skewedOpen = open(skewed);
    expect(cursorOf(skewedOpen), 'Trades, with no row').toEqual({ tab: 'trades', item: null });
    const skewedA = press(skewed, skewedOpen, 'A');
    expect(skewedA.result, 'A has nothing to act on').toBe('consumed');
    expect(skewedA.state.phase, 'and opens no sheet').toMatchObject(LIST);
    expect(press(skewed, skewedOpen, 'B').result, 'B still closes the frame').toEqual(POP);
    const turnedSkewed = observe(skewed, swallowed(offered, open(offered), ['A']));
    expect(
      turnedSkewed.phase,
      'a sheet on the offer closes when its status turns unknown',
    ).toMatchObject(LIST);
    expect(cursorOf(turnedSkewed), 'on no row').toEqual({ tab: 'trades', item: null });
  });
});

describe('socialScreen — the requested tab and the panels (ctl-8d, CTL8D.3)', () => {
  it('CTL8D-3-REQUESTED-TAB-WINS: a requested tab (U, P, L, the menu leaves, the auto-show) wins over the waiting request`s tab and the remembered tab, each of the four with three distinct tabs in play; on a requested tab that holds a waiting row the cursor sits on it, even when another tab`s request is older', () => {
    // WRONG IMPL KILLED: an init that ignores `requested` (L would open on the waiting trade or
    // the remembered tab, not the leaderboard); one that ranks the remembered tab or the waiting
    // request above it; one that puts the cursor on the waiting row only when the oldest request
    // is on the opened tab (P with an older trade pending would leave the cursor off the
    // challenge); and one that keeps the remembered cursor over the request.
    const onTab = (tab: SocialTab): SocialScreenState => {
      const s = open(world({ tab }));
      expect(s.nav.tab, `fixture: a state left on ${tab}`).toBe(tab);
      return s;
    };
    const tradeWaits = { offers: [trade('waiting')], challenges: [outgoing()] };
    const challengeWaits = { offers: [trade('sent')], challenges: [incoming(), outgoing()] };
    // [requested, the rows, the waiting request's tab, the remembered tab]: three distinct tabs.
    const CASES: ReadonlyArray<
      readonly [SocialTab, Pick<World, 'offers' | 'challenges'>, SocialTab, SocialTab]
    > = [
      ['rankings', tradeWaits, 'trades', 'challenges'],
      ['players', tradeWaits, 'trades', 'challenges'],
      ['trades', challengeWaits, 'challenges', 'rankings'],
      ['challenges', tradeWaits, 'trades', 'rankings'],
    ];
    for (const [requested, rows, waitingTab, rememberedTab] of CASES) {
      const remembered = onTab(rememberedTab);
      // Control: unrequested, the same rows and memory open on the waiting request's tab.
      expect(
        open(world({ ...rows, tab: null }), remembered).nav.tab,
        `${requested}: control: a plain open takes the waiting request's tab`,
      ).toBe(waitingTab);
      const w = world({ ...rows, tab: requested });
      const s = open(w, remembered);
      expect(s.nav.tab, `requested ${requested} wins`).toBe(requested);
      expect(s.phase, `requested ${requested}: the list`).toMatchObject(LIST);
      expect(paintOf(w, s).panel, `requested ${requested}: its panel`).toBe(PANEL[requested]);
    }

    // On a requested tab holding a waiting row the cursor sits on it: Challenges, with an older
    // trade waiting and the remembered cursor on the outgoing row.
    const duel = world({ tab: 'challenges', challenges: [incoming(), outgoing()] });
    const leftOnOutgoing = swallowed(duel, open(duel), ['Down']);
    expect(cursorOf(leftOnOutgoing), 'fixture').toEqual({ tab: 'challenges', item: OUTGOING });
    const autoShow = world({
      tab: 'challenges',
      offers: [trade('waiting', 1_000n)],
      challenges: [outgoing(), incoming(2_000n)],
    });
    expect(cursorOf(open(autoShow, leftOnOutgoing)), 'P on a pending challenge').toEqual({
      tab: 'challenges',
      item: INCOMING,
    });
    // Trades, with an older challenge waiting.
    const tradeAsked = world({
      tab: 'trades',
      offers: [trade('waiting', 5_000n)],
      challenges: [incoming(1_000n)],
    });
    expect(cursorOf(open(tradeAsked, leftOnOutgoing)), 'U on a pending offer').toEqual({
      tab: 'trades',
      item: TRADE,
    });
  });

  it('CTL8D-3-PAINT-PANEL: paint shows the state`s tab panel first (Trades the trade root, Challenges the pvp root, Players and Rankings the leaderboard root; ctl-8g moved Players off the trade root), then paints the strip into the chrome through trades.paintSocial (the trade cursor only on a listed trade on Trades, the sheet and its prompt question while open), then the challenge cursor (incoming / outgoing on Challenges, null elsewhere); it follows the state, not the requested tab; views not built yet are skipped without a throw', () => {
    // WRONG IMPL KILLED: a paint that shows the requested tab's panel (or never calls show, so U,
    // P and L keep the panel the legacy key chose); one that paints the strip before `show` (a
    // later throw would leave the wrong panel up); a strip painted only on Trades (the chrome
    // follows the shown panel); a trade cursor mark on another tab or with no trade; a sheet
    // painted with the wrong actions or active row, dropped under its prompt, or left on the list;
    // the wrong prompt question (a trade Decline asking about a challenge, Confirm asking about a
    // decline); a challenge cursor on Trades or on the wrong row; a paint into a view that does
    // not exist yet (a TypeError before main() built the panels). INTENTIONAL CHANGE (ctl-8g): the
    // ctl-8d pin "no call on the Rankings view" is replaced by CTL8G-1-PAINT / CTL8G-2-PAINT, which
    // pin the call on Players and Rankings and its absence on Trades and Challenges.
    const full = (tab: SocialTab | null): World =>
      world({ tab, offers: [trade('waiting')], challenges: [incoming(), outgoing()] });

    const LISTS: ReadonlyArray<readonly [SocialTab, SocialPaint, CursorRow]> = [
      ['players', listPaint('players'), null],
      ['trades', listPaint('trades', true), null],
      ['challenges', listPaint('challenges'), 'incoming'],
      ['rankings', listPaint('rankings'), null],
    ];
    for (const [tab, paint, cursor] of LISTS) {
      const w = full(tab);
      const s = open(w);
      expect(s.nav.tab, `${tab}: fixture`).toBe(tab);
      const calls = paintCalls(vmOf(w), s);
      expect(calls, `${tab}: the panel, then the strip, then the challenge cursor`).toEqual([
        { call: 'show', panel: PANEL[tab] },
        { call: 'paintSocial', chrome: CHROME, paint },
        { call: 'paintCursor', row: cursor },
      ]);
      expect((calls[1] as SocialCall).chrome, `${tab}: the very chrome`).toBe(CHROME);
    }

    // The outgoing row under the cursor; a Trades tab with no trade holds no trade cursor.
    const duel = full('challenges');
    expect(paintOf(duel, swallowed(duel, open(duel), ['Down'])).cursor, 'outgoing').toBe(
      'outgoing',
    );
    const bare = world({ tab: 'trades', challenges: [incoming()] });
    const barePaint = paintOf(bare, open(bare));
    expect(barePaint.paint, 'no trade listed: no trade cursor').toEqual(listPaint('trades', false));
    expect(barePaint.cursor).toBeNull();

    // The paint follows the state: requested Players, LB to Rankings.
    const asked = full('players');
    const moved = paintOf(asked, swallowed(asked, open(asked), ['LB']));
    expect(moved.panel, 'the state`s panel, not the requested one').toBe('leaderboardView');
    expect(moved.paint, 'the state`s tab').toEqual(listPaint('rankings'));
    expect(moved.cursor).toBeNull();

    // The trade sheet and its Decline prompt.
    const trades = full('trades');
    const OFFER: readonly SocialAction[] = ['accept', 'decline'];
    const tSheet = swallowed(trades, open(trades), ['A']);
    let p = paintOf(trades, tSheet);
    expect(p.panel).toBe('tradeView');
    expect(p.paint.tab).toBe('trades');
    expect(p.paint.sheet, 'the sheet, on Accept').toEqual({ actions: OFFER, active: 'accept' });
    expect(p.paint.confirm, 'no prompt').toBeNull();
    expect(p.cursor, 'no challenge cursor on Trades').toBeNull();
    const tDecline = swallowed(trades, tSheet, ['Down']);
    expect(paintOf(trades, tDecline).paint.sheet).toEqual({ actions: OFFER, active: 'decline' });
    const tAsked = swallowed(trades, tDecline, ['A']);
    p = paintOf(trades, tAsked);
    expect(p.paint.sheet, 'the sheet stays painted under its prompt').toEqual({
      actions: OFFER,
      active: 'decline',
    });
    expect(p.paint.confirm, 'the Decline prompt on No').toEqual({
      question: 'declineTrade',
      yes: false,
    });
    expect(paintOf(trades, swallowed(trades, tAsked, ['Down'])).paint.confirm, 'on Yes').toEqual({
      question: 'declineTrade',
      yes: true,
    });
    expect(
      paintOf(trades, swallowed(trades, tAsked, ['B', 'B'])).paint,
      'back on the list: no sheet, no prompt',
    ).toEqual(listPaint('trades', true));

    // The final trade Confirm.
    const confirmable = world({ tab: 'trades', offers: [trade('toConfirm')] });
    p = paintOf(confirmable, swallowed(confirmable, open(confirmable), ['A', 'A']));
    expect(p.paint.sheet).toEqual({ actions: ['confirm', 'cancel'], active: 'confirm' });
    expect(p.paint.confirm, 'the Confirm prompt on No').toEqual({
      question: 'confirmTrade',
      yes: false,
    });

    // The challenge sheet, its Decline prompt, and the outgoing row's sheet.
    p = paintOf(duel, swallowed(duel, open(duel), ['A', 'Down', 'A']));
    expect(p.panel).toBe('pvpView');
    expect(p.paint.tab).toBe('challenges');
    expect(p.paint.sheet).toEqual({ actions: OFFER, active: 'decline' });
    expect(p.paint.confirm, 'the challenge Decline prompt on No').toEqual({
      question: 'declineChallenge',
      yes: false,
    });
    p = paintOf(duel, swallowed(duel, open(duel), ['Down', 'A']));
    expect(p.paint.sheet).toEqual({ actions: ['cancel'], active: 'cancel' });
    expect(p.paint.confirm).toBeNull();

    // Views main() has not built yet: skipped, never a throw, and the panel is still shown.
    let missing = 0;
    for (const parts of [
      { trades: false, challenges: false },
      { trades: false, challenges: true },
      { trades: true, challenges: false },
    ]) {
      for (const tab of ['players', 'trades', 'challenges', 'rankings'] as const) {
        const w = full(tab);
        const s = open(w);
        let calls: FrameCall[] = [];
        expect(
          () => {
            calls = paintCalls(vmOf(w), s, parts);
          },
          `${tab} ${JSON.stringify(parts)}: no throw`,
        ).not.toThrow();
        expect(calls[0], `${tab} ${JSON.stringify(parts)}: the panel first`).toEqual({
          call: 'show',
          panel: PANEL[tab],
        });
        expect(
          calls.map((c) => c.call),
          `${tab} ${JSON.stringify(parts)}: only the views that exist`,
        ).toEqual([
          'show',
          ...(parts.trades ? ['paintSocial'] : []),
          ...(parts.challenges ? ['paintCursor'] : []),
        ]);
        missing += 1;
      }
    }
    expect(missing, 'ANTI-VACUITY: three view sets x four tabs').toBe(12);
  });
});

// ==========================================================================================
// ctl-8g (CTL8G.1, CTL8G.2): the Players and Rankings tabs.
//
// The Players tab lists the other online players (name, a Nearby badge within 12 Manhattan tiles
// in the same zone); A on a row is the walk-up phase (`{ kind: 'walkUp', row }`: "Walk up to {name}
// and press A", no remote action exists); B leaves it, a move leaves it. The Rankings tab is a
// read-only nav list: A there never opens a sheet or sends a command. Both tabs paint over the
// leaderboard root through `view.rankings.paintSocial(p)` (after show, the strip and the challenge
// cursor), and ONLY these two tabs call it. The ZONE NAME clause of CTL8G.1 is DEFERRED (no client
// source of zone names): nothing here asserts one.
//
// The state is `{ nav, phase, people }`: `people` is `socialPeopleKey(vm)`, so observe answers a NEW
// state when a player joins, leaves, renames or crosses the 12-tile line (the host repaints on a
// new state object) and the SAME state when nothing the Players tab shows changed.
//
// Fixture: the viewer ME 'aa…' (entity 1) at (50, 50); Bob (2) five tiles away: nearby; Carol (3)
// forty away; Dan (4) has no character. Players rows in name order: Bob, Carol, Dan. Rankings
// (RANKED): Bob 1200, Carol 1000, Me 900.
// ==========================================================================================

const DAN = 'dd'.repeat(32);
const EVE = 'ee'.repeat(32);
const ME_EID = 1n;

const person = (identity: string, name: string, entityId: bigint, online = true): StorePlayer => ({
  identity,
  name,
  entityId,
  online,
  lastInputSeq: 0n,
});

const at = (entityId: bigint, tileX: number, tileY: number, zoneId = 0): StoreCharacter => ({
  entityId,
  zoneId,
  tileX,
  tileY,
  facing: 'South',
  action: 'Idle',
  moveStartedAtMs: 0n,
  moveQueue: [],
});

const profile = (identity: string, name: string, rating: number): StoreProfile => ({
  identity,
  name,
  rating,
  wins: 0,
  losses: 0,
});

const ME_P = person(ME, 'Me', ME_EID);
const BOB_P = person(BOB, 'Bob', 2n);
const CAROL_P = person(CAROL, 'Carol', 3n);
const DAN_P = person(DAN, 'Dan', 4n);
const CHARS: readonly StoreCharacter[] = [at(ME_EID, 50, 50), at(2n, 50, 55), at(3n, 50, 90)];
const RANKED: readonly StoreProfile[] = [
  profile(CAROL, 'Carol', 1000),
  profile(BOB, 'Bob', 1200),
  profile(ME, 'Me', 900),
];
/** The ranked keys in leaderboard order, spelled here. */
const RANK_ORDER = [BOB, CAROL, ME] as const;

/** A world with the players of the fixture, on `tab`. */
const crowd = (tab: SocialTab | null, over: Partial<World> = {}): World =>
  world({ tab, players: [ME_P, BOB_P, CAROL_P, DAN_P], characters: CHARS, ...over });
/** A world with the ranked profiles of the fixture, on `tab`. */
const ranked = (tab: SocialTab | null, over: Partial<World> = {}): World =>
  world({ tab, profiles: RANKED, ...over });

const walkUp = (row: string) => ({ kind: 'walkUp' as const, row });

type RankingsCall = { readonly call: 'rankings'; readonly paint: SocialRankingsPaint };
type LoggedCall = FrameCall | RankingsCall;

/** One paint into a recording view that logs EVERY call in order, the Rankings view's too
 *  (`parts.rankings: false` leaves `view.rankings` undefined, as before main() builds it). */
function paintLog(
  vm: SocialVm,
  state: SocialScreenState,
  parts: { readonly rankings: boolean } = { rankings: true },
): LoggedCall[] {
  const calls: LoggedCall[] = [];
  const view = {
    chrome: CHROME,
    trades: {
      paintSocial: (chrome: unknown, paint: SocialPaint) => {
        calls.push({ call: 'paintSocial', chrome, paint });
      },
    },
    challenges: {
      paintCursor: (row: CursorRow) => {
        calls.push({ call: 'paintCursor', row });
      },
    },
    rankings: parts.rankings
      ? {
          paintSocial: (paint: SocialRankingsPaint) => {
            calls.push({ call: 'rankings', paint });
          },
        }
      : undefined,
    show: (panel: SocialPanelId) => {
      calls.push({ call: 'show', panel });
    },
  } as unknown as SocialFrameView;
  if (socialScreen.paint === undefined) throw new Error('socialScreen must define paint');
  socialScreen.paint(view, vm, state);
  return calls;
}

/** The Rankings view's one paint of `state` over `w`, after asserting the whole call order. */
function rankingsPaintOf(w: World, state: SocialScreenState): SocialRankingsPaint {
  const log = paintLog(vmOf(w), state);
  expect(
    log.map((c) => c.call),
    'show first, then the strip, the challenge cursor and the Rankings view, once each',
  ).toEqual(['show', 'paintSocial', 'paintCursor', 'rankings']);
  expect(log[0], 'the leaderboard root is the panel').toEqual({
    call: 'show',
    panel: 'leaderboardView',
  });
  return (log[3] as RankingsCall).paint;
}

const A_INPUTS: readonly Input[] = ['A', rep('A')];

describe('socialScreen — Players: the walk-up phase and the change signal (ctl-8g, CTL8G.1)', () => {
  it('CTL8G-1-WALKUP: A on a Players row enters the walk-up phase on that row and sends nothing (a held A does not); in it B returns to the list without popping the frame, a held B does nothing, A (fresh or held) stays, Up / Down / LB / RB move exactly as in the list AND return to the list, Left / Right move nothing, Start and Select act as everywhere; with no players listed A opens nothing; a walk-up whose player leaves, goes offline or is replaced closes to the list, and an A pressed as that happens only paints', () => {
    // WRONG IMPL KILLED: an A that opens a trade sheet or sends a command on a player (no remote
    // action exists); a held A that enters (a held Enter would walk up on its auto-repeat); a walk-up
    // keyed on the wrong row (the first row, not the cursor's); a B that pops the frame from the
    // walk-up (it only closes the line) or one whose held repeat pops; a held B that closes it;
    // an A in the walk-up that toggles it off or sends; an arrow that moves but leaves the walk-up
    // up (the line would name a player the cursor left), or one that returns to the list without
    // moving; LB / RB that switch tabs and keep the walk-up (a stale line on the next visit); a
    // Start or Select that the walk-up swallows (the e2e closeAll presses Start); an A on an empty
    // Players tab that enters a walk-up on nothing; a walk-up left over a player who left, went
    // offline or was replaced; and an A in the same step as that change that walks up to the
    // re-seated row (the shop's rule: it only paints).
    const w = crowd('players');
    const opened = open(w);
    expect(cursorOf(opened), 'fixture: the first row').toEqual({ tab: 'players', item: BOB });
    expect(opened.phase, 'fixture: the list').toMatchObject(LIST);

    // A on each row walks up to THAT row; the cursor stays.
    for (const [reach, row] of [
      [[], BOB],
      [['Down'], CAROL],
      [['Down', 'Down'], DAN],
    ] as const) {
      const on = swallowed(w, opened, reach);
      expect(cursorOf(on), `fixture: the cursor on ${row}`).toEqual({ tab: 'players', item: row });
      const a = press(w, on, 'A');
      expect(a.result, `A on ${row} sends nothing`).toBe('consumed');
      expect(a.state.phase, `A on ${row}: the walk-up on that row`).toMatchObject(walkUp(row));
      expect(cursorOf(a.state), `A on ${row}: the cursor stays`).toEqual(cursorOf(on));
      const held = press(w, on, rep('A'));
      expect(held.result, `a held A on ${row}`).toBe('consumed');
      expect(held.state.phase, `a held A on ${row}: no walk-up`).toMatchObject(LIST);
      expect(cursorOf(held.state), `a held A on ${row}: the cursor stays`).toEqual(cursorOf(on));
    }

    // The walk-up on Carol, the middle row.
    const onCarol = swallowed(w, opened, ['Down']);
    const up = press(w, onCarol, 'A').state;
    expect(up.phase, 'fixture: the walk-up on Carol').toMatchObject(walkUp(CAROL));

    // B: a fresh B closes the line only; a held B does nothing at all.
    const b = press(w, up, 'B');
    expect(b.result, 'B in the walk-up is swallowed, the frame stays').toBe('consumed');
    expect(b.state.phase, 'B returns to the list').toMatchObject(LIST);
    expect(cursorOf(b.state), 'B keeps the cursor').toEqual({ tab: 'players', item: CAROL });
    const heldB = press(w, up, rep('B'));
    expect(heldB.result, 'a held B is swallowed').toBe('consumed');
    expect(heldB.state.phase, 'a held B leaves the walk-up up').toMatchObject(walkUp(CAROL));
    expect(cursorOf(heldB.state)).toEqual({ tab: 'players', item: CAROL });

    // A in the walk-up: swallowed, the walk-up stays, nothing sent.
    for (const input of A_INPUTS) {
      const step = press(w, up, input);
      expect(step.result, `${label(input)} in the walk-up`).toBe('consumed');
      expect(step.state.phase, `${label(input)}: the walk-up stays`).toMatchObject(walkUp(CAROL));
    }
    // Left and Right: swallowed, the cursor stays.
    for (const input of ['Left', 'Right', rep('Left'), rep('Right')] as const) {
      const step = press(w, up, input);
      expect(step.result, `${label(input)} in the walk-up`).toBe('consumed');
      expect(cursorOf(step.state), `${label(input)} moves nothing`).toEqual({
        tab: 'players',
        item: CAROL,
      });
    }

    // The arrows and the tab buttons: the list's own move, then the list.
    const MOVES: ReadonlyArray<readonly [Input, string, string]> = [
      ['Down', 'players', DAN],
      ['Up', 'players', BOB],
      [rep('Down'), 'players', DAN],
      [rep('Up'), 'players', BOB],
      ['RB', 'trades', ''],
      ['LB', 'rankings', ''],
    ];
    for (const [input, tab, item] of MOVES) {
      const inList = press(w, onCarol, input);
      const inWalkUp = press(w, up, input);
      expect(inWalkUp.result, `${label(input)} in the walk-up`).toBe('consumed');
      expect(inWalkUp.state.nav, `${label(input)}: the very move the list makes`).toEqual(
        inList.state.nav,
      );
      expect(inWalkUp.state.nav.tab, `${label(input)}: the tab`).toBe(tab);
      if (item !== '') {
        expect(inWalkUp.state.nav.item, `${label(input)}: the row`).toBe(item);
      }
      expect(inWalkUp.state.phase, `${label(input)}: back to the list`).toMatchObject(LIST);
    }

    // Start and Select, as in every phase; a held one is swallowed.
    expect(press(w, up, 'Start').result, 'Start in the walk-up').toEqual(POP_TO_BASE);
    expect(press(w, up, 'Select').result, 'Select in the walk-up').toEqual(TOGGLE_HELP);
    for (const button of ['Start', 'Select'] as const) {
      expect(press(w, up, rep(button)).result, `a held ${button}`).toBe('consumed');
    }
    // And B in the list still pops (the frame closes from the list, not from the walk-up).
    expect(press(w, opened, 'B').result, 'B in the list pops the frame').toEqual(POP);

    // No players listed (only the viewer, and an offline one): A opens nothing.
    const lonely = crowd('players', { players: [ME_P, person(BOB, 'Bob', 2n, false)] });
    const lonelyOpen = open(lonely);
    expect(cursorOf(lonelyOpen), 'fixture: no row').toEqual({ tab: 'players', item: null });
    for (const input of A_INPUTS) {
      const step = press(lonely, lonelyOpen, input);
      expect(step.result, `${label(input)} with nobody listed`).toBe('consumed');
      expect(step.state.phase, `${label(input)}: no walk-up on nothing`).toMatchObject(LIST);
    }

    // The walk-up's player leaves, goes offline: the list, the cursor re-seated on a listed row.
    const without = (players: readonly StorePlayer[]): World => crowd('players', { players });
    const gone: ReadonlyArray<readonly [string, World]> = [
      ['Carol leaves', without([ME_P, BOB_P, DAN_P])],
      ['Carol goes offline', without([ME_P, BOB_P, person(CAROL, 'Carol', 3n, false), DAN_P])],
    ];
    for (const [what, after] of gone) {
      const settled = observe(after, up);
      expect(settled.phase, `${what}: observe closes the walk-up`).toMatchObject(LIST);
      expect(
        [BOB, DAN],
        `${what}: the cursor is re-seated on a row that is still listed`,
      ).toContain(settled.nav.item);
      const pressed = press(after, up, 'A');
      expect(pressed.result, `${what}: an A as it happens sends nothing`).toBe('consumed');
      expect(pressed.state.phase, `${what}: and walks up to nothing`).toMatchObject(LIST);
    }
    // The walk-up survives what does not concern its row: another player arrives, or its player
    // is renamed.
    const arrived = without([ME_P, BOB_P, CAROL_P, DAN_P, person(EVE, 'Eve', 5n)]);
    const renamed = without([ME_P, BOB_P, person(CAROL, 'Carolyn', 3n), DAN_P]);
    for (const [what, after] of [
      ['Eve arrives', arrived],
      ['Carol is renamed', renamed],
    ] as const) {
      expect(observe(after, up).phase, `${what}: the walk-up stays on Carol`).toMatchObject(
        walkUp(CAROL),
      );
    }
  });

  it('CTL8G-1-OBSERVE: init records the players` signature (`socialPeopleKey`) in state.people; observe answers the SAME state when nothing the Players tab shows changed (a rebuilt equal vm, a third party`s trade or challenge, an offline player who is not listed, a player`s input counter ticking, a listed player moving without crossing the 12-tile line, a re-rated leaderboard) and a NEW state, with the new signature and a listed cursor, when a player joins, leaves, goes offline, is renamed, or crosses the line either way, or gains a character; the new state is then stable', () => {
    // WRONG IMPL KILLED: an observe that answers a new object at every batch (a repaint per batch,
    // and the host's same-object pin); one that answers the SAME object when a player joins, leaves,
    // is renamed or crosses the 12-tile line while the cursor row survives (the Players list the
    // player sees would be stale: nothing repaints until a button press); a signature that reads
    // the raw player rows (lastInputSeq ticks every move: a repaint storm) or the raw characters
    // (every step of a far player repaints); an init that leaves `people` unset (the first observe
    // would always look changed); a signature taken from the rows but never stored back, so the
    // new state is "changed" again at the next batch; and a cursor left on a row that went away.
    const base = crowd('players');
    const s = open(base);
    expect(typeof s.people, 'init records the signature').toBe('string');
    expect(s.people, 'it is the signature of the very rows listed').toBe(
      socialPeopleKey(vmOf(base)),
    );
    expect(observe(base, s), 'a rebuilt equal view model: the same state').toBe(s);

    const swap = (over: Partial<World>): World => ({ ...base, ...over });
    const tweak = (id: string, edit: Partial<StorePlayer>): readonly StorePlayer[] =>
      base.players.map((p) => (p.identity === id ? { ...p, ...edit } : p));

    // Nothing the tab shows changed: the same state, each case a fresh view model.
    const othersMoved = swap({
      offers: [{ ...trade('waiting', 50n, 5n), initiator: BOB, counterparty: CAROL }],
      challenges: [{ ...incoming(50n), challengeId: 3n, target: CAROL }],
    });
    const SAME: ReadonlyArray<readonly [string, World]> = [
      ['a third party`s trade and challenge', othersMoved],
      [
        'an offline player who is not listed',
        swap({ players: [...base.players, person(EVE, 'Eve', 5n, false)] }),
      ],
      [
        'a player`s input counter ticking',
        swap({ players: base.players.map((p) => ({ ...p, lastInputSeq: p.lastInputSeq + 7n })) }),
      ],
      [
        'Carol takes a step, still far',
        swap({ characters: [at(ME_EID, 50, 50), at(2n, 50, 55), at(3n, 50, 91)] }),
      ],
      [
        'Bob takes a step, still within range',
        swap({ characters: [at(ME_EID, 50, 50), at(2n, 51, 55), at(3n, 50, 90)] }),
      ],
      [
        'the viewer takes a step, nobody crosses the line',
        swap({ characters: [at(ME_EID, 51, 50), at(2n, 50, 55), at(3n, 50, 90)] }),
      ],
    ];
    for (const [what, after] of SAME) {
      expect(observe(after, s), `${what}: the SAME state`).toBe(s);
    }
    expect(SAME.length, 'ANTI-VACUITY: six unrelated changes').toBe(6);

    // Something the tab shows changed: a NEW state with the new signature, then stable.
    const CHANGES: ReadonlyArray<readonly [string, World]> = [
      ['Eve joins', swap({ players: [...base.players, person(EVE, 'Eve', 5n)] })],
      ['Dan leaves', swap({ players: base.players.filter((p) => p.identity !== DAN) })],
      ['Dan goes offline', swap({ players: tweak(DAN, { online: false }) })],
      ['Dan is renamed', swap({ players: tweak(DAN, { name: 'Danny' }) })],
      [
        'Carol walks within 12 tiles',
        swap({ characters: [at(ME_EID, 50, 50), at(2n, 50, 55), at(3n, 50, 62)] }),
      ],
      [
        'Bob walks off, the cursor`s row stays listed',
        swap({ characters: [at(ME_EID, 50, 50), at(2n, 50, 63), at(3n, 50, 90)] }),
      ],
      ['Dan gains a character within range', swap({ characters: [...CHARS, at(4n, 51, 50)] })],
      [
        'the viewer`s character goes: nobody is nearby',
        swap({ characters: [at(2n, 50, 55), at(3n, 50, 90)] }),
      ],
    ];
    const seen = new Set<string>([s.people]);
    for (const [what, after] of CHANGES) {
      const next = observe(after, s);
      expect(next, `${what}: a NEW state`).not.toBe(s);
      expect(next.people, `${what}: the new signature`).toBe(socialPeopleKey(vmOf(after)));
      expect(next.people, `${what}: it differs from the old one`).not.toBe(s.people);
      expect(next.nav.tab, `${what}: the tab stays`).toBe('players');
      expect(
        vmOf(after).players.map((r) => r.key),
        `${what}: the cursor is on a listed row`,
      ).toContain(next.nav.item);
      expect(observe(after, next), `${what}: and then stable`).toBe(next);
      seen.add(next.people);
    }
    // Equal rows, equal signature: Dan going offline lists what Dan leaving does, and the viewer's
    // character going lists what Bob walking off does (all three players then far or unplaced).
    expect(seen.size, 'ANTI-VACUITY: the base and six different row lists, eight changes').toBe(7);
    expect(CHANGES.length, 'ANTI-VACUITY: eight changes driven').toBe(8);

    // On the Rankings tab a re-rated board with the same ranked players and the cursor row still
    // there is no change; a cursor row that left the board is re-seated (a new state).
    const board = open(ranked('rankings'));
    expect(cursorOf(board), 'fixture: the cursor on the first ranked row').toEqual({
      tab: 'rankings',
      item: BOB,
    });
    const rerated = ranked('rankings', {
      profiles: [profile(CAROL, 'Carol', 1500), profile(BOB, 'Bob', 1200), profile(ME, 'Me', 900)],
    });
    expect(observe(rerated, board), 'a re-ranked board, the cursor row still there').toBe(board);
    const bobGone = ranked('rankings', { profiles: RANKED.filter((p) => p.identity !== BOB) });
    const reseated = observe(bobGone, board);
    expect(reseated, 'the cursor`s ranked row is gone: a new state').not.toBe(board);
    expect([CAROL, ME], 'the cursor is re-seated on a ranked row').toContain(reseated.nav.item);
  });
});

describe('socialScreen — Rankings: a read-only list (ctl-8g, CTL8G.2)', () => {
  it('CTL8G-2-READONLY: on a ranked row a fresh or a held A is swallowed and changes nothing (no sheet, no walk-up, no command, the very same state), on every ranked row including the viewer`s own and with a waiting trade and challenge in the store; an empty board swallows A too; Up / Down move over the ranked keys in leaderboard order (a fresh press wraps, a held one clamps) and B still pops the frame', () => {
    // WRONG IMPL KILLED: an A on a ranked row that opens an action sheet (the trade or challenge
    // sheet of a row that does not exist: Rankings is a view, nothing to act on), enters the
    // walk-up (that is Players'), or sends a challenge or any command; a state rebuilt on A (a
    // repaint per press); an A that acts only on the first row, only on a row that is not the
    // viewer's, or only while no request waits; an empty board that throws or opens a sheet on
    // nothing; a cursor that skips the viewer's row or walks in input order (Carol first); a held
    // arrow that wraps; and a B that stops popping.
    const busy = ranked('rankings', {
      offers: [trade('waiting')],
      challenges: [incoming(), outgoing()],
    });
    const opened = open(busy);
    expect(cursorOf(opened), 'fixture: the first ranked row, not the request`s tab').toEqual({
      tab: 'rankings',
      item: RANK_ORDER[0],
    });

    let s = opened;
    let checked = 0;
    for (const key of RANK_ORDER) {
      expect(s.nav.item, `fixture: the cursor on ${key}`).toBe(key);
      for (const input of A_INPUTS) {
        const step = press(busy, s, input);
        expect(step.result, `${label(input)} on ${key} is swallowed, never a command`).toBe(
          'consumed',
        );
        expect(step.state, `${label(input)} on ${key}: nothing changed`).toEqual(s);
        expect(step.state.phase, `${label(input)} on ${key}: no sheet, no walk-up`).toMatchObject(
          LIST,
        );
        checked += 1;
      }
      s = swallowed(busy, s, ['Down']);
    }
    expect(s.nav.item, 'a fresh Down from the last ranked row wraps to the first').toBe(
      RANK_ORDER[0],
    );
    expect(checked, 'ANTI-VACUITY: two inputs on three rows').toBe(6);

    // The cursor follows leaderboard order, wraps on a fresh press and clamps on a held one.
    expect(cursorOf(swallowed(busy, opened, ['Up'])).item, 'a fresh Up wraps to the last').toBe(
      RANK_ORDER[2],
    );
    expect(cursorOf(swallowed(busy, opened, [rep('Up')])).item, 'a held Up stays').toBe(
      RANK_ORDER[0],
    );
    const last = swallowed(busy, opened, ['Up']);
    expect(cursorOf(swallowed(busy, last, [rep('Down')])).item, 'a held Down stays').toBe(
      RANK_ORDER[2],
    );
    expect(cursorOf(swallowed(busy, opened, [rep('Down')])).item, 'a held Down moves on').toBe(
      RANK_ORDER[1],
    );
    expect(press(busy, opened, 'B').result, 'B pops the frame').toEqual(POP);

    // An empty board: A is swallowed, nothing opens.
    const empty = ranked('rankings', { profiles: [] });
    const emptyOpen = open(empty);
    expect(cursorOf(emptyOpen), 'fixture: no ranked row').toEqual({ tab: 'rankings', item: null });
    for (const input of A_INPUTS) {
      const step = press(empty, emptyOpen, input);
      expect(step.result, `${label(input)} on an empty board`).toBe('consumed');
      expect(step.state.phase).toMatchObject(LIST);
    }
  });
});

describe('socialScreen — paint over the leaderboard root (ctl-8g)', () => {
  it('CTL8G-1-PAINT: the Players tab shows the leaderboard root FIRST, then paints the strip and the challenge cursor, then hands view.rankings the players (name, nearby), the cursor row`s key and the walk-up row`s player name (null in the list); the walk-up is cleared by a move; an empty name is walked up to as its #hex8 fallback; a missing Rankings view is skipped without a throw', () => {
    // WRONG IMPL KILLED: a Players tab still shown over the trade root (the placeholder); a show
    // that comes after the paints (a throw in them would leave the wrong panel up); no call on the
    // Rankings view, or one before the strip; a payload with the wrong tab, the players of
    // another tab, a cursor that is the tab's or a stale one, a walk-up that is the row KEY, the
    // raw (empty) player name, or never cleared after LB / RB; an `rankings.paintSocial` TypeError
    // when the view is not built yet; and a change to the strip or the challenge cursor on Players.
    const w = crowd('players');
    const s = open(w);
    const log = paintLog(vmOf(w), s);
    expect(
      log.map((c) => c.call),
      'show, the strip, the challenge cursor, then the Rankings view',
    ).toEqual(['show', 'paintSocial', 'paintCursor', 'rankings']);
    expect(log[0], 'the leaderboard root, first').toEqual({
      call: 'show',
      panel: 'leaderboardView',
    });
    expect((log[1] as SocialCall).chrome, 'the very chrome').toBe(CHROME);
    expect((log[1] as SocialCall).paint, 'the strip on the Players tab').toEqual(
      listPaint('players'),
    );
    expect((log[2] as CursorCall).row, 'no challenge cursor on Players').toBeNull();
    const first = (log[3] as RankingsCall).paint;
    expect(first.tab).toBe('players');
    expect(first.players, 'the listed players, in name order').toMatchObject([
      { key: BOB, name: 'Bob', nearby: true },
      { key: CAROL, name: 'Carol', nearby: false },
      { key: DAN, name: 'Dan', nearby: false },
    ]);
    expect(first.players, 'the very rows of the view model').toEqual(vmOf(w).players);
    expect(first.cursor, 'the cursor row`s key').toBe(BOB);
    expect(first.walkUp, 'the list: no walk-up').toBeNull();

    // The cursor follows the state.
    const onCarol = swallowed(w, s, ['Down']);
    expect(rankingsPaintOf(w, onCarol).cursor, 'Down').toBe(CAROL);
    expect(rankingsPaintOf(w, swallowed(w, onCarol, ['Down'])).cursor, 'Down again').toBe(DAN);

    // The walk-up carries the player's name; a move or B clears it.
    const walking = press(w, onCarol, 'A').state;
    const walkPaint = rankingsPaintOf(w, walking);
    expect(walkPaint.walkUp, 'the walk-up row`s player name').toBe('Carol');
    expect(walkPaint.cursor, 'the cursor stays on the row').toBe(CAROL);
    expect(walkPaint.tab).toBe('players');
    expect(
      rankingsPaintOf(w, swallowed(w, walking, ['B'])).walkUp,
      'B clears the walk-up line',
    ).toBeNull();
    expect(
      rankingsPaintOf(w, swallowed(w, walking, ['Down'])).walkUp,
      'a move clears the walk-up line',
    ).toBeNull();
    // LB / RB: the walk-up is gone on the next visit of Players, whichever way the tabs went.
    const wrapped = swallowed(w, walking, ['LB']);
    expect(wrapped.nav.tab, 'fixture: LB from Players wraps to Rankings').toBe('rankings');
    const backOnPlayers = swallowed(w, wrapped, ['RB']);
    expect(backOnPlayers.nav.tab, 'fixture: RB wraps back to Players').toBe('players');
    expect(rankingsPaintOf(w, backOnPlayers).walkUp, 'the next visit: no walk-up').toBeNull();

    // An empty name walks up as its #hex8 fallback (the row's display name, never '').
    const anonymous = crowd('players', {
      players: [ME_P, BOB_P, CAROL_P, person(DAN, '', 4n)],
    });
    const anonOpen = open(anonymous);
    expect(anonOpen.nav.item, 'fixture: the empty name sorts first').toBe(DAN);
    const anonWalk = rankingsPaintOf(anonymous, press(anonymous, anonOpen, 'A').state);
    expect(anonWalk.walkUp, 'the fallback name').toBe(`#${DAN.slice(0, 8)}`);
    expect(anonWalk.players[0], 'the row shows the fallback too').toMatchObject({
      key: DAN,
      name: `#${DAN.slice(0, 8)}`,
    });

    // The Rankings view not built yet: skipped, the panel still first.
    const missing = paintLog(vmOf(w), s, { rankings: false });
    expect(
      missing.map((c) => c.call),
      'no Rankings view: show, the strip, the challenge cursor',
    ).toEqual(['show', 'paintSocial', 'paintCursor']);
    expect(missing[0]).toEqual({ call: 'show', panel: 'leaderboardView' });
  });

  it('CTL8G-2-PAINT: the Rankings tab shows the leaderboard root first and hands view.rankings the Rankings tab, the cursor row`s ranked key (null on an empty board), no walk-up and the players; the Rankings view is called on Players and Rankings and on no other tab (Trades and Challenges never), with the panel each tab shows', () => {
    // WRONG IMPL KILLED: a Rankings paint with the Players tab's payload (tab 'players'), a null or
    // first-row cursor when the cursor moved, or a walk-up string; a call on Trades or Challenges
    // (the leaderboard view would be painted over the trade or pvp root's content); a Rankings
    // call that precedes `show`; and the panel chosen from the requested tab instead of the state.
    const w = ranked('rankings', { players: [ME_P, BOB_P, CAROL_P], characters: CHARS });
    const s = open(w);
    const first = rankingsPaintOf(w, s);
    expect(first.tab).toBe('rankings');
    expect(first.cursor, 'the first ranked row').toBe(RANK_ORDER[0]);
    expect(first.walkUp, 'no walk-up on Rankings').toBeNull();
    expect(first.players, 'the players ride along').toMatchObject([
      { key: BOB, name: 'Bob', nearby: true },
      { key: CAROL, name: 'Carol', nearby: false },
    ]);
    const second = swallowed(w, s, ['Down']);
    expect(rankingsPaintOf(w, second).cursor, 'Down').toBe(RANK_ORDER[1]);
    expect(rankingsPaintOf(w, swallowed(w, second, ['Down'])).cursor, 'Down again').toBe(
      RANK_ORDER[2],
    );
    expect(
      rankingsPaintOf(w, swallowed(w, s, ['A'])).walkUp,
      'A on Rankings: still none',
    ).toBeNull();

    const empty = ranked('rankings', { profiles: [] });
    expect(rankingsPaintOf(empty, open(empty)).cursor, 'an empty board: no cursor').toBeNull();

    // Which tabs call the Rankings view: Players and Rankings only, each time the state is there.
    const full = (tab: SocialTab): World =>
      crowd(tab, {
        profiles: RANKED,
        offers: [trade('waiting')],
        challenges: [incoming(), outgoing()],
      });
    const WANT: ReadonlyArray<readonly [SocialTab, SocialPanelId, number]> = [
      ['players', 'leaderboardView', 1],
      ['trades', 'tradeView', 0],
      ['challenges', 'pvpView', 0],
      ['rankings', 'leaderboardView', 1],
    ];
    let checked = 0;
    for (const [tab, panel, calls] of WANT) {
      const fw = full(tab);
      const log = paintLog(vmOf(fw), open(fw));
      expect(log[0], `${tab}: the panel first`).toEqual({ call: 'show', panel });
      expect(
        log.filter((c) => c.call === 'rankings').length,
        `${tab}: calls on the Rankings view`,
      ).toBe(calls);
      if (calls === 1) {
        expect(log.at(-1)?.call, `${tab}: the Rankings view is painted last`).toBe('rankings');
      }
      checked += 1;
    }
    // A sheet or prompt open on Trades or Challenges does not call it either.
    const tradeSheet = full('trades');
    const inSheet = swallowed(tradeSheet, open(tradeSheet), ['A']);
    expect(
      paintLog(vmOf(tradeSheet), inSheet).filter((c) => c.call === 'rankings'),
      'a trade sheet: no Rankings call',
    ).toEqual([]);
    const duel = full('challenges');
    const inPrompt = swallowed(duel, open(duel), ['A', 'Down', 'A']);
    expect(
      paintLog(vmOf(duel), inPrompt).filter((c) => c.call === 'rankings'),
      'a challenge prompt: no Rankings call',
    ).toEqual([]);
    expect(checked, 'ANTI-VACUITY: four tabs').toBe(4);
  });
});
