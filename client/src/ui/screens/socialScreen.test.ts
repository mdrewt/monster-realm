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
import type { StoreBattleChallenge, StoreTradeOffer } from '../../net/store';
import type { NavInput } from '../nav';
import type { SocialAction, SocialVm } from '../socialModel';
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

/** What the fake store holds and the tab the open path bound; a case edits it as a batch would. */
interface World {
  tab: SocialTab | null;
  offers: readonly StoreTradeOffer[];
  challenges: readonly StoreBattleChallenge[];
}

const world = (over: Partial<World> = {}): World => ({
  tab: null,
  offers: [],
  challenges: [],
  ...over,
});

function ctxOf(w: World): ScreenContext {
  const store = {
    allTradeOffers: () => w.offers.map((o) => ({ ...o })),
    allChallenges: () => w.challenges.map((c) => ({ ...c })),
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

/** The panel each tab shows (contextStack's `socialPanel`), spelled here. */
const PANEL: Readonly<Record<SocialTab, SocialPanelId>> = {
  players: 'tradeView',
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
    // ctl-8g paints Rankings; this slice calls nothing on it (any call throws a TypeError here).
    rankings: {},
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

  it('CTL8D-3-PAINT-PANEL: paint shows the state`s tab panel first (Players and Trades the trade root, Challenges the pvp root, Rankings the leaderboard root), then paints the strip into the chrome through trades.paintSocial (the trade cursor only on a listed trade on Trades, the sheet and its prompt question while open), then the challenge cursor (incoming / outgoing on Challenges, null elsewhere); it follows the state, not the requested tab; views not built yet are skipped without a throw', () => {
    // WRONG IMPL KILLED: a paint that shows the requested tab's panel (or never calls show, so U,
    // P and L keep the panel the legacy key chose); one that paints the strip before `show` (a
    // later throw would leave the wrong panel up); a strip painted only on Trades (the chrome
    // follows the shown panel); a trade cursor mark on another tab or with no trade; a sheet
    // painted with the wrong actions or active row, dropped under its prompt, or left on the list;
    // the wrong prompt question (a trade Decline asking about a challenge, Confirm asking about a
    // decline); a challenge cursor on Trades or on the wrong row; a paint into a view that does
    // not exist yet (a TypeError before main() built the panels); and a call on the Rankings view
    // (ctl-8g's).
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
