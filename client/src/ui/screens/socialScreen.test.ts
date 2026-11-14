// ui/screens/socialScreen.test.ts — ctl-8d (CTL8D.1-.3), ctl-8g, ts-3, ts-4: the Social frame's
// pure adapter.
//
// Node env, no DOM. `socialScreen` is driven only through `viewModel(ctx)`, `init(vm, remembered)`,
// `onButton(vm, state, btn)`, `observe(vm, state, now)` and `paint(view, vm, state)`. Every press
// and every observe is handed a FRESH view model built from a mutable fake world (its rows copied
// at every read), as the host's `#step` and `observe` do, so an adapter that compares rows by
// identity, or whose settle rebuilds an unchanged phase, is caught. The context's fake store has
// exactly the reads the view model makes (`allChallenges`, `allPlayers`, `characters`,
// `allProfiles`, `allTradeSessions`); `ctx.socialTab` is the tab the open path asked for (null: a
// plain open).
//
// Where the cursor and the sheet are is read off `state.nav` / `state.phase` (the plan's
// `SocialScreenState`), matched as a subset (the state may carry fields the contract does not
// name). What the frame shows is read off the calls one `paint` makes on a recording
// `SocialFrameView`: `show(panel)`, then `challenges.paintCursor(row)`, then
// `trades.paintSocial(chrome, p)`.
// ts-6b-10 (named intentional change): paintCursor now precedes paintSocial (the kit sheet places
// itself against the marked row). Was: show, paintSocial, paintCursor.
//
// The fixture world (the viewer 'aa…', Bob 'bb…', Carol 'cc…'):
//   session 11      between Bob and the viewer: `waiting` (Bob opened it, untouched: a waiting
//                   request) or `opened` (the viewer opened it)
//   challenge 21    Bob -> the viewer, Pending: incoming, a waiting request
//   challenge 22    the viewer -> Carol, Pending: outgoing
//   Row keys `session-11`, `challenge-21`, `challenge-22`; ids distinct per row kind.
//
// The contract (plan "Functional core / imperative shell", ts-4 plan "Resume 2"):
//   init     tab = requested ?? the oldest waiting request's tab ?? the remembered tab ?? players;
//            the cursor on the opened tab's waiting row when it has one; always the list phase.
//   list     LB/RB switch tabs and Up/Down move (a fresh press wraps, a repeat clamps); A on a
//            challenge row opens its sheet on the FIRST legal action; A on a session row answers
//            openTradeEditor at once; B pops; Start pops to the base; Select toggles help; a repeat
//            never acts.
//   sheet    Up/Down over the legal actions (fresh wraps, repeat clamps); B back to the list; A on
//            Accept or Cancel issues the command; A on Decline asks Yes/No on No.
//   prompt   a fresh Up/Down flips Yes/No; A on Yes issues the command; A on No, or B, closes it.
//   settle   the SAME state when nothing changed; a sheet whose row is gone or whose legal actions
//            changed closes to the list; a press whose phase the settle just changed only paints.
//   paint    follows the state (never `vm.requested`): show the tab's panel first, then the
//            challenge cursor, then the strip and the sheet through `trades.paintSocial`.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type {
  StoreBattleChallenge,
  StoreCharacter,
  StorePlayer,
  StoreProfile,
  StoreTradeSession,
} from '../../net/store';
import type { SocialRankingsPaint } from '../leaderboardView';
import type { NavInput } from '../nav';
import { type SocialAction, type SocialVm, socialPeopleKey } from '../socialModel';
import type { SocialPaint, SocialSessionRow } from '../tradeView';
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

/** The row keys: session 11, the incoming challenge 21, the outgoing challenge 22. */
const SESSION = 'session-11';
const INCOMING = 'challenge-21';
const OUTGOING = 'challenge-22';

const NO_SIDE = { monsterIds: [], items: [], currency: 0n, cards: [] } as const;

function tradeSession(
  sessionId: bigint,
  opener: string,
  partner: string,
  over: Partial<StoreTradeSession> = {},
): StoreTradeSession {
  return {
    sessionId,
    opener,
    partner,
    openerOffer: NO_SIDE,
    partnerOffer: NO_SIDE,
    openerConfirmed: false,
    partnerConfirmed: false,
    revision: 1n,
    createdAtMs: 1_000n,
    ...over,
  };
}

/** Who opened session 11: Bob (`waiting`: untouched, a request to the viewer) or the viewer. */
type SessionCell = 'waiting' | 'opened';

/** Session `sessionId` (11) between Bob and the viewer, in `cell`. */
function session(cell: SessionCell, createdAtMs = 1_000n, sessionId = 11n): StoreTradeSession {
  return cell === 'waiting'
    ? tradeSession(sessionId, BOB, ME, { createdAtMs })
    : tradeSession(sessionId, ME, BOB, { createdAtMs });
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
  challenges: readonly StoreBattleChallenge[];
  players: readonly StorePlayer[];
  characters: readonly StoreCharacter[];
  profiles: readonly StoreProfile[];
  /** The trade sessions `allTradeSessions()` answers. */
  sessions: readonly StoreTradeSession[];
}

const world = (over: Partial<World> = {}): World => ({
  tab: null,
  challenges: [],
  players: [],
  characters: [],
  profiles: [],
  sessions: [],
  ...over,
});

function ctxOf(w: World): ScreenContext {
  // `characters()` answers a FRESH one-shot iterator of `{ row }` entries (the store's shape), the
  // others fresh copies, as every read in this file does. The store has no other member: a view
  // model that reads anything else throws a TypeError here.
  const store = {
    allChallenges: () => w.challenges.map((c) => ({ ...c })),
    allPlayers: () => w.players.map((p) => ({ ...p })),
    characters: () => w.characters.map((c) => ({ row: { ...c } })).values(),
    allProfiles: () => w.profiles.map((p) => ({ ...p })),
    allTradeSessions: () => w.sessions.map((s) => ({ ...s })),
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
  action: SocialAction | 'back',
  confirm: { readonly yes: boolean } | null = null,
) => ({ kind: 'sheet' as const, row, actions, action, confirm });

const POP: ScreenResult = { kind: 'pop' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };
const EDIT_11: ScreenResult = { kind: 'openTradeEditor', sessionId: 11n };
const ACCEPT_21: ScreenResult = { kind: 'acceptChallenge', challengeId: 21n };
const DECLINE_21: ScreenResult = { kind: 'declineChallenge', challengeId: 21n };
const CANCEL_22: ScreenResult = { kind: 'cancelChallenge', challengeId: 22n };
const REQUEST: readonly SocialAction[] = ['accept', 'decline'];

/** The panel each tab shows, spelled here: Players and Rankings over the leaderboard root. */
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
    // The Players and Rankings tabs call `rankings.paintSocial` after the two calls recorded here.
    // It is a no-op in this helper; `paintLog` and the CTL8G cases below pin it.
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
    'show first, then paintCursor, then paintSocial, once each',
  ).toEqual(['show', 'paintCursor', 'paintSocial']);
  const [shown, cursor, social] = calls as [ShowCall, CursorCall, SocialCall];
  expect(social.chrome, 'paintSocial paints into the frame`s chrome').toBe(CHROME);
  return { panel: shown.panel, paint: social.paint, cursor: cursor.row };
}

/** The paint of the list phase on `tab`: exactly the five keys of `SocialPaint`. */
const listPaint = (
  tab: SocialTab,
  sessions: readonly SocialSessionRow[] = [],
  sessionCursor: string | null = null,
): SocialPaint => ({
  tab,
  sessions,
  sessionCursor,
  sheet: null,
  confirm: null,
});

/** Session 11 as the Trades tab paints it, Bob unknown to the store (the `#hex8` fallback). */
const SESSION_ROW_11: SocialSessionRow = {
  key: SESSION,
  partnerName: `#${BOB.slice(0, 8)}`,
  mineConfirmed: false,
  theirsConfirmed: false,
};

describe('socialScreen — opening (ctl-8d, CTL8D.1)', () => {
  it('CTL8D-1-INIT-WAITING-TAB: with no requested tab the frame opens in the list on the oldest waiting request`s tab with the cursor on it: a session Bob opened with the viewer opens Trades on it, a challenge to the viewer opens Challenges on the incoming row (not the outgoing one), both open the older one`s tab, and this beats a remembered tab and a remembered cursor', () => {
    // WRONG IMPL KILLED: an init that ignores waiting requests (opens on Players or the
    // remembered tab); one that treats any listed row as waiting (an older session the viewer
    // opened, an older outgoing challenge); one that picks the newest request; one that switches
    // to the request's tab but leaves the cursor on the remembered row (the outgoing one) instead
    // of the request; and an init that opens a sheet.
    const remembered = {
      rankings: open(world({ tab: 'rankings' })),
      trades: open(world({ tab: 'trades', sessions: [session('opened')] })),
      outgoing: swallowed(
        world({ tab: 'challenges', challenges: [incoming(), outgoing()] }),
        open(world({ tab: 'challenges', challenges: [incoming(), outgoing()] })),
        ['Down'],
      ),
    };
    expect(cursorOf(remembered.rankings), 'fixture').toEqual({ tab: 'rankings', item: null });
    expect(cursorOf(remembered.trades), 'fixture').toEqual({ tab: 'trades', item: SESSION });
    expect(cursorOf(remembered.outgoing), 'fixture').toEqual({ tab: 'challenges', item: OUTGOING });

    // Only a session waits; an outgoing challenge is listed too.
    const sessionWaits = world({ sessions: [session('waiting')], challenges: [outgoing()] });
    // Only a challenge waits; an older session the viewer opened and an older outgoing one are
    // listed.
    const challengeWaits = world({
      sessions: [session('opened', 100n)],
      challenges: [outgoing(100n), incoming(2_000n)],
    });
    // Both wait, the session older; both wait, the challenge older.
    const sessionOlder = world({
      sessions: [session('waiting', 1_000n)],
      challenges: [incoming(2_000n), outgoing()],
    });
    const challengeOlder = world({
      sessions: [session('waiting', 3_000n)],
      challenges: [incoming(2_000n), outgoing()],
    });
    const CASES: ReadonlyArray<readonly [string, World, string, string]> = [
      ['only a session waits', sessionWaits, 'trades', SESSION],
      ['only a challenge waits', challengeWaits, 'challenges', INCOMING],
      ['both wait, the session older', sessionOlder, 'trades', SESSION],
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
    // Nothing waits: a session the viewer opened and its own outgoing challenge.
    const quiet = world({ sessions: [session('opened')], challenges: [outgoing()] });
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
    expect(cursorOf(onTrades), 'fixture').toEqual({ tab: 'trades', item: SESSION });
    expect(cursorOf(open(quiet, onTrades)), 'remembered on Trades').toEqual({
      tab: 'trades',
      item: SESSION,
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

    // A remembered sheet (the outgoing row's Cancel), and a remembered prompt (the request's
    // Decline), reopen in the list.
    const outSheet = swallowed(busy, onOutgoing, ['A']);
    expect(outSheet.phase, 'fixture: the Cancel sheet').toMatchObject(
      sheet(OUTGOING, ['cancel'], 'cancel'),
    );
    const prompted = swallowed(busy, open(busy), ['A', 'Down', 'A']);
    expect(prompted.phase, 'fixture: the Decline prompt').toMatchObject(
      sheet(INCOMING, REQUEST, 'decline', { yes: false }),
    );
    // The request was answered elsewhere: nothing waits, so the remembered tab decides.
    const answered = world({ challenges: [outgoing()] });
    for (const [what, rem] of [
      ['a sheet', outSheet],
      ['a prompt', prompted],
    ] as const) {
      const reopened = open(answered, rem);
      expect(cursorOf(reopened), `remembered ${what}: its tab, on a listed row`).toEqual({
        tab: 'challenges',
        item: OUTGOING,
      });
      expect(reopened.phase, `remembered ${what}: the list`).toMatchObject(LIST);
      expect(open(busy, rem).phase, `remembered ${what}, the world unchanged`).toMatchObject(LIST);
    }

    // The remembered cursor row is gone: re-seated on a listed row (or none on an empty tab).
    const onRequest = open(busy);
    expect(cursorOf(onRequest), 'fixture: on the request').toEqual({
      tab: 'challenges',
      item: INCOMING,
    });
    expect(cursorOf(open(answered, onRequest)), 'the request was answered').toEqual({
      tab: 'challenges',
      item: OUTGOING,
    });
    const replaced = world({ sessions: [session('opened', 1_000n, 12n)] });
    expect(cursorOf(open(replaced, onTrades)), 'session 11 replaced by session 12').toEqual({
      tab: 'trades',
      item: 'session-12',
    });
    expect(cursorOf(open(world(), onTrades)), 'the session is gone: no row').toEqual({
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
      sessions: [session('waiting')],
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
    expect(cursorOf(viaTrades), 'Trades keeps its row').toEqual({ tab: 'trades', item: SESSION });
    expect(cursorOf(swallowed(w, viaTrades, ['RB'])), 'Trades and back').toEqual({
      tab: 'challenges',
      item: OUTGOING,
    });
    expect(cursorOf(swallowed(w, viaTrades, ['LB', 'LB', 'LB', 'LB'])), 'a full lap').toEqual({
      tab: 'trades',
      item: SESSION,
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
  it('CTL8D-2-SHEET-GUARDS: A with no row under the cursor, or on Players or Rankings, is swallowed and stays in the list; with a challenge sheet or its prompt open LB, RB, Left and Right are swallowed and move nothing', () => {
    // WRONG IMPL KILLED: an A on an empty tab or a tab with no rows that opens a sheet on
    // nothing; LB / RB switching tabs under an open sheet or prompt (the frame would paint a stale
    // sheet over the Trades or Rankings panel, and A would act on a row the player no longer
    // sees), and Left / Right moving the sheet's cursor or flipping Yes/No.
    const empty = world({ tab: 'trades' });
    const none = press(empty, open(empty), 'A');
    expect(none.result, 'A on an empty Trades').toBe('consumed');
    expect(none.state.phase).toMatchObject(LIST);
    for (const tab of ['players', 'rankings'] as const) {
      const w = world({ tab, sessions: [session('waiting')], challenges: [incoming()] });
      const step = press(w, open(w), 'A');
      expect(step.result, `A on ${tab}`).toBe('consumed');
      expect(step.state.phase, `A on ${tab}: no sheet`).toMatchObject(LIST);
      expect(step.state.nav.tab, `A on ${tab}: the tab stays`).toBe(tab);
    }

    const busy = world({
      tab: 'challenges',
      sessions: [session('waiting')],
      challenges: [incoming(), outgoing()],
    });
    const busySheet = swallowed(busy, open(busy), ['A']);
    const busyPrompt = swallowed(busy, open(busy), ['A', 'Down', 'A']);
    expect(busyPrompt.phase, 'fixture: the Decline prompt').toMatchObject(
      sheet(INCOMING, REQUEST, 'decline', { yes: false }),
    );
    for (const [where, before] of [
      ['the sheet', busySheet],
      ['the prompt', busyPrompt],
    ] as const) {
      for (const button of ['LB', 'RB', 'Left', 'Right'] as const) {
        const step = press(busy, before, button);
        expect(step.result, `${button} in ${where}`).toBe('consumed');
        expect(cursorOf(step.state), `${button} in ${where}: the tab and row stay`).toEqual({
          tab: 'challenges',
          item: INCOMING,
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
    const a = press(w, opened, 'A');
    expect(a.result, 'A opens the request`s sheet').toBe('consumed');
    expect(a.state.phase).toMatchObject(sheet(INCOMING, REQUEST, 'accept'));
    // ts-6b-10 (named intentional change): the sheet's rows end with Back, so the walk is
    // accept, decline, back and the wrap and the clamp happen at Back. Was: a fresh Down on
    // Decline wrapped to Accept, a held Down on Decline stayed, a fresh Up on Accept wrapped to
    // Decline.
    const onDecline = swallowed(w, a.state, ['Down']);
    expect(onDecline.phase, 'Down').toMatchObject(sheet(INCOMING, REQUEST, 'decline'));
    const onBack = swallowed(w, onDecline, ['Down']);
    expect(onBack.phase, 'Down from Decline reaches Back').toMatchObject(
      sheet(INCOMING, REQUEST, 'back'),
    );
    expect(swallowed(w, onBack, ['Down']).phase, 'a fresh Down wraps from Back').toMatchObject(
      sheet(INCOMING, REQUEST, 'accept'),
    );
    expect(swallowed(w, onBack, [rep('Down')]).phase, 'a held Down stays on Back').toMatchObject(
      sheet(INCOMING, REQUEST, 'back'),
    );
    expect(swallowed(w, onDecline, [rep('Down')]).phase, 'a held Down reaches Back').toMatchObject(
      sheet(INCOMING, REQUEST, 'back'),
    );
    expect(swallowed(w, a.state, ['Up']).phase, 'a fresh Up wraps to Back').toMatchObject(
      sheet(INCOMING, REQUEST, 'back'),
    );
    expect(swallowed(w, onBack, ['Up']).phase, 'Up from Back').toMatchObject(
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
    // ts-6b-10 (named intentional change): Cancel is followed by the Back row. Was: Down / Up
    // (fresh or held) all stayed on Cancel, "one action".
    const cancelOnBack = swallowed(w, ao.state, ['Down']);
    expect(cancelOnBack.phase, 'Down reaches Back').toMatchObject(
      sheet(OUTGOING, ['cancel'], 'back'),
    );
    expect(swallowed(w, ao.state, ['Up']).phase, 'a fresh Up wraps to Back').toMatchObject(
      sheet(OUTGOING, ['cancel'], 'back'),
    );
    expect(swallowed(w, ao.state, [rep('Down')]).phase, 'a held Down reaches Back').toMatchObject(
      sheet(OUTGOING, ['cancel'], 'back'),
    );
    expect(swallowed(w, ao.state, [rep('Up')]).phase, 'a held Up stays on Cancel').toMatchObject(
      sheet(OUTGOING, ['cancel'], 'cancel'),
    );
    expect(swallowed(w, cancelOnBack, ['Up']).phase, 'Up from Back').toMatchObject(
      sheet(OUTGOING, ['cancel'], 'cancel'),
    );
    expect(swallowed(w, cancelOnBack, ['Down']).phase, 'a fresh Down wraps').toMatchObject(
      sheet(OUTGOING, ['cancel'], 'cancel'),
    );
    expect(swallowed(w, cancelOnBack, [rep('Down')]).phase, 'a held Down stays').toMatchObject(
      sheet(OUTGOING, ['cancel'], 'back'),
    );
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

  it('CTL8D-2-CONFIRM-DEFAULT-NO: A on a challenge`s Decline (reached by Down or by a wrapping Up, with or without the outgoing row listed) sends nothing and asks Yes/No on No; A on No sends nothing and closes the prompt with the sheet still on that action; a fresh Up or Down flips the answer and a held one never does; B closes the prompt and keeps the sheet; Accept, Cancel and a session row ask nothing', () => {
    // WRONG IMPL KILLED (CTL8D.2 "Decline defaults to No"): a prompt that opens on Yes (one more
    // Enter would decline); a Decline with no prompt at all (the command on the first A); an A on
    // No that sends the command anyway or closes the whole sheet; a held arrow that flips the
    // answer (a held key would land on Yes); a B that sends, pops the frame or closes the sheet
    // with the prompt; and a prompt on Accept, Cancel or a session row (they act at once).
    const CASES: ReadonlyArray<{
      readonly name: string;
      readonly w: World;
      readonly reach: readonly Input[];
    }> = [
      {
        name: 'challenge Decline by Down',
        w: world({ tab: 'challenges', challenges: [incoming(), outgoing()] }),
        reach: ['A', 'Down'],
      },
      {
        // ts-6b-10 (named intentional change): a wrapping Up from Accept now lands on Back, so
        // Decline is one more Up. Was: reach ['A', 'Up'] (the wrap landed on Decline).
        name: 'challenge Decline by a wrapping Up through Back, the request alone',
        w: world({ tab: 'challenges', sessions: [session('opened')], challenges: [incoming()] }),
        reach: ['A', 'Up', 'Up'],
      },
    ];
    for (const c of CASES) {
      const on = (confirm: { readonly yes: boolean } | null) =>
        sheet(INCOMING, REQUEST, 'decline', confirm);
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

    // Accept, Cancel and a session row act at once: a command, back on the list, no prompt.
    const duel = world({ tab: 'challenges', challenges: [incoming(), outgoing()] });
    const NO_PROMPT: ReadonlyArray<readonly [string, World, readonly Input[], ScreenResult]> = [
      ['challenge Accept', duel, ['A'], ACCEPT_21],
      ['challenge Cancel', duel, ['Down', 'A'], CANCEL_22],
      [
        'challenge Cancel, the outgoing row alone',
        world({ tab: 'challenges', challenges: [outgoing()] }),
        ['A'],
        CANCEL_22,
      ],
      [
        'a waiting session row',
        world({ tab: 'trades', sessions: [session('waiting')] }),
        [],
        EDIT_11,
      ],
      [
        'an opened session row',
        world({ tab: 'trades', sessions: [session('opened')] }),
        [],
        EDIT_11,
      ],
    ];
    for (const [name, w, reach, command] of NO_PROMPT) {
      const step = press(w, swallowed(w, open(w), reach), 'A');
      expect(step.result, `${name}: A issues the command`).toEqual(command);
      expect(step.state.phase, `${name}: no prompt, back on the list`).toMatchObject(LIST);
    }
  });

  it('the Social row sheet ends with a Back row whose A closes the sheet and sends nothing', () => {
    // WRONG IMPL KILLED: today's sheet with no Back row (Down from Decline wraps to Accept, Up from
    // Accept to Decline); a Back that is painted but not reachable by Up / Down; a `sheet.actions`
    // that carries 'back' (the view appends the row; screens/index.test.ts pins the legal-only
    // shape); an A on Back that sends the neighbour's command (Decline, Cancel) or opens the
    // Decline prompt; an A on Back that leaves the sheet open or moves the cursor off the row; a
    // held A on Back that closes it; a settle that sees the Back row as a changed action list
    // (observe must answer the SAME state); a Decline that stopped asking Yes / No on No.
    const w = world({ tab: 'challenges', challenges: [incoming(), outgoing()] });
    const onAccept = swallowed(w, open(w), ['A']);
    expect(onAccept.phase, 'fixture: the sheet on Accept').toMatchObject(
      sheet(INCOMING, REQUEST, 'accept'),
    );

    // Up from Accept (fresh wrap) and Down, Down both reach Back; the legal actions stay as they were.
    const byUp = swallowed(w, onAccept, ['Up']);
    const byDown = swallowed(w, onAccept, ['Down', 'Down']);
    for (const [how, s] of [
      ['Up', byUp],
      ['Down, Down', byDown],
    ] as const) {
      expect(s.phase, `${how} reaches Back`).toMatchObject(sheet(INCOMING, REQUEST, 'back'));
      if (s.phase.kind !== 'sheet') throw new Error('fixture: a sheet phase');
      expect(s.phase.actions, `${how}: the phase keeps the legal actions only`).toEqual(REQUEST);
      expect(observe(w, s), `${how}: observe on Back answers the same state`).toBe(s);
    }

    // The paint hands the legal actions only, with Back active; the view appends the row.
    const painted = paintOf(w, byDown);
    expect(painted.paint.sheet, 'paint on Back').toEqual({ actions: REQUEST, active: 'back' });
    expect(painted.paint.confirm, 'no prompt on Back').toBeNull();
    expect(painted.cursor, 'the challenge cursor is still the incoming row').toBe('incoming');

    // A on Back: nothing sent, the list, the cursor on that row.
    const closed = press(w, byDown, 'A');
    expect(closed.result, 'A on Back sends nothing').toBe('consumed');
    expect(closed.state.phase, 'A on Back closes the sheet').toMatchObject(LIST);
    expect(cursorOf(closed.state), 'back on the list, on that row').toEqual({
      tab: 'challenges',
      item: INCOMING,
    });
    expect(
      swallowed(w, closed.state, ['A']).phase,
      'the sheet opens again on the first action',
    ).toMatchObject(sheet(INCOMING, REQUEST, 'accept'));

    // A held A on Back does nothing: the sheet stays on Back.
    const held = press(w, byDown, rep('A'));
    expect(held.result, 'a held A on Back').toBe('consumed');
    expect(held.state.phase, 'a held A leaves the sheet on Back').toMatchObject(
      sheet(INCOMING, REQUEST, 'back'),
    );

    // The outgoing row's sheet (Cancel, Back): A on Back is not the Cancel command.
    const onCancel = swallowed(w, open(w), ['Down', 'A']);
    const cancelBack = swallowed(w, onCancel, ['Down']);
    expect(cancelBack.phase, 'fixture: Back under Cancel').toMatchObject(
      sheet(OUTGOING, ['cancel'], 'back'),
    );
    const closedCancel = press(w, cancelBack, 'A');
    expect(closedCancel.result, 'A on the outgoing Back sends nothing').toBe('consumed');
    expect(closedCancel.state.phase).toMatchObject(LIST);
    expect(cursorOf(closedCancel.state)).toEqual({ tab: 'challenges', item: OUTGOING });
    expect(press(w, onCancel, 'A').result, 'ANTI-VACUITY: A on Cancel still cancels').toEqual(
      CANCEL_22,
    );

    // Decline still asks Yes / No on No (Back follows it, it does not replace it).
    const asked = swallowed(w, onAccept, ['Down', 'A']);
    expect(asked.phase, 'Decline asks').toMatchObject(
      sheet(INCOMING, REQUEST, 'decline', { yes: false }),
    );
    expect(press(w, swallowed(w, asked, ['Down']), 'A').result, 'Yes declines').toEqual(DECLINE_21);
  });

  it('CTL8D-2-COMMANDS: the commands carry their exact ids (the session row`s openTradeEditor on 11, challenge Accept / Decline on 21, Cancel on 22) and each returns to the list; A, A on a waiting challenge accepts it and A on a waiting session opens its editor; B in the list pops, Start pops to the base in the list, the sheet and the prompt, and Select toggles help', () => {
    // WRONG IMPL KILLED: a command carrying the wrong id (the ids are distinct per row kind: a
    // session id sent as a challenge id shows); acceptChallenge on the outgoing row or
    // cancelChallenge on the request; Decline sent as an accept; a command that leaves the sheet
    // open; a request that takes more than U, Enter, Enter to accept (design section 5); and a
    // Start that a sheet or a prompt swallows (the e2e closeAll presses Start).
    const duel = world({ tab: 'challenges', challenges: [incoming(), outgoing()] });
    const CASES: ReadonlyArray<readonly [string, World, readonly Input[], ScreenResult]> = [
      [
        'the session row',
        world({ tab: 'trades', sessions: [session('opened', 1_000n, 11n)] }),
        ['A'],
        EDIT_11,
      ],
      ['challenge Accept', duel, ['A', 'A'], ACCEPT_21],
      ['challenge Decline, Yes', duel, ['A', 'Down', 'A', 'Down', 'A'], DECLINE_21],
      ['challenge Cancel', duel, ['Down', 'A', 'A'], CANCEL_22],
      [
        'challenge Cancel, the outgoing row alone',
        world({ tab: 'challenges', challenges: [outgoing()] }),
        ['A', 'A'],
        CANCEL_22,
      ],
    ];
    for (const [name, w, inputs, command] of CASES) {
      const before = swallowed(w, open(w), inputs.slice(0, -1));
      const step = press(w, before, inputs[inputs.length - 1] as Input);
      expect(step.result, name).toEqual(command);
      expect(step.state.phase, `${name}: back on the list`).toMatchObject(LIST);
    }

    // A plain open lands on the request: A opens a waiting session's editor, and A, A answers a
    // waiting challenge (design section 5: U, Enter, Enter).
    const offered = world({ sessions: [session('waiting')], challenges: [outgoing()] });
    const plain = open(offered);
    expect(cursorOf(plain), 'fixture: a plain open on the session').toEqual({
      tab: 'trades',
      item: SESSION,
    });
    expect(press(offered, plain, 'A').result, 'A').toEqual(EDIT_11);
    const challenged = world({ tab: 'challenges', challenges: [outgoing(), incoming()] });
    expect(
      press(challenged, swallowed(challenged, open(challenged), ['A']), 'A').result,
      'P (or the auto-show), A, A',
    ).toEqual(ACCEPT_21);

    // The stack moves.
    const w = duel;
    const list = open(w);
    const inSheet = swallowed(w, list, ['A']);
    const inPrompt = swallowed(w, list, ['A', 'Down', 'A']);
    expect(inPrompt.phase, 'fixture: a prompt').toMatchObject(
      sheet(INCOMING, REQUEST, 'decline', { yes: false }),
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

  it('CTL8D-2-REPEAT-NEVER-ACTS: a repeat-flagged A opens no sheet from the list and no editor from a session row, sends nothing on Accept or Cancel, opens no prompt on Decline and sends nothing on Yes; a repeat-flagged B, Start or Select is swallowed in the list, the sheet and the prompt', () => {
    // WRONG IMPL KILLED: an A whose auto-repeat acts (a held Enter would open the sheet and send
    // Accept, reopen the editor at repeat rate, or confirm a Yes, with one key press); a held B
    // that pops the frame, or a held Start or Select that pops to the base or toggles help over
    // and over.
    const w = world({ tab: 'challenges', challenges: [incoming(), outgoing()] });
    const list = open(w);
    const heldInList = press(w, list, rep('A'));
    expect(heldInList.result, 'a held A in the list').toBe('consumed');
    expect(heldInList.state.phase, 'opens no sheet').toMatchObject(LIST);
    const onSession = world({ tab: 'trades', sessions: [session('waiting')] });
    const heldOnSession = press(onSession, open(onSession), rep('A'));
    expect(heldOnSession.result, 'a held A on a session row opens no editor').toBe('consumed');
    expect(heldOnSession.state.phase).toMatchObject(LIST);

    const ACTING: ReadonlyArray<readonly [string, readonly Input[], ReturnType<typeof sheet>]> = [
      ['challenge Accept', ['A'], sheet(INCOMING, REQUEST, 'accept')],
      ['challenge Cancel', ['Down', 'A'], sheet(OUTGOING, ['cancel'], 'cancel')],
      ['challenge Decline', ['A', 'Down'], sheet(INCOMING, REQUEST, 'decline')],
    ];
    for (const [name, reach, phase] of ACTING) {
      const on = swallowed(w, open(w), reach);
      expect(on.phase, `${name}: fixture`).toMatchObject(phase);
      const held = press(w, on, rep('A'));
      expect(held.result, `${name}: a held A sends nothing`).toBe('consumed');
      expect(held.state.phase, `${name}: the sheet stays as it was`).toMatchObject(phase);
    }

    const onYes = swallowed(w, list, ['A', 'Down', 'A', 'Down']);
    const yes = sheet(INCOMING, REQUEST, 'decline', { yes: true });
    expect(onYes.phase, 'fixture: the prompt on Yes').toMatchObject(yes);
    const heldOnYes = press(w, onYes, rep('A'));
    expect(heldOnYes.result, 'a held A on Yes sends nothing').toBe('consumed');
    expect(heldOnYes.state.phase, 'the prompt stays on Yes').toMatchObject(yes);
    expect(press(w, heldOnYes.state, 'A').result, 'ANTI-VACUITY: a fresh A there declines').toEqual(
      DECLINE_21,
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
    // another challenge than the one the player chose); a sheet re-pointed at the same index or
    // the same action when the legal actions change (a Decline becoming the immediate Cancel under
    // the cursor); a prompt left open over actions that changed; and an A in the same step as such
    // a change that acts.
    const w = world({
      tab: 'challenges',
      sessions: [session('waiting')],
      challenges: [incoming(), outgoing()],
    });
    const list = open(w);
    expect(cursorOf(list), 'fixture: the requested Challenges, on the request').toEqual({
      tab: 'challenges',
      item: INCOMING,
    });
    const inSheet = swallowed(w, list, ['A']);
    const onYes = swallowed(w, list, ['A', 'Down', 'A', 'Down']);
    const onOutgoing = swallowed(w, list, ['Down']);
    expect(cursorOf(onOutgoing), 'fixture').toEqual({ tab: 'challenges', item: OUTGOING });
    const outSheet = swallowed(w, onOutgoing, ['A']);
    const onTrades = swallowed(w, list, ['LB']);
    expect(cursorOf(onTrades), 'fixture').toEqual({ tab: 'trades', item: SESSION });
    // Only rows of others change: another pair's session and a third party's challenge arrive.
    const othersMoved: World = {
      ...w,
      sessions: [...w.sessions, tradeSession(5n, BOB, CAROL, { createdAtMs: 50n })],
      challenges: [{ ...incoming(50n), challengeId: 3n, target: CAROL }, ...w.challenges],
    };
    for (const [where, s] of [
      ['the list', list],
      ['a sheet', inSheet],
      ['a prompt on Yes', onYes],
      ['the outgoing row', onOutgoing],
      ['the outgoing sheet', outSheet],
      ['the session row', onTrades],
    ] as const) {
      expect(observe(w, s), `${where}: nothing changed, the same state`).toBe(s);
      expect(observe(othersMoved, s), `${where}: only others' rows changed`).toBe(s);
    }

    // After an unchanged batch, A still acts on a fresh, equal view model.
    expect(press(w, observe(w, inSheet), 'A').result, 'A on Accept after a batch').toEqual(
      ACCEPT_21,
    );
    expect(press(w, observe(w, onYes), 'A').result, 'A on Yes after a batch').toEqual(DECLINE_21);
    expect(
      press(w, observe(w, outSheet), 'A').result,
      'A on the outgoing Cancel after a batch',
    ).toEqual(CANCEL_22);
    expect(press(w, observe(w, onTrades), 'A').result, 'A on the session after a batch').toEqual(
      EDIT_11,
    );

    // The sheet's row is gone: the list, the cursor re-seated on a listed row.
    const noOutgoing: World = { ...w, challenges: [incoming()] };
    const closed = observe(noOutgoing, outSheet);
    expect(closed.phase, 'the outgoing challenge is gone: the list').toMatchObject(LIST);
    expect(cursorOf(closed), 'the cursor re-seated').toEqual({ tab: 'challenges', item: INCOMING });
    // The sheet's row is replaced by another id: the list, on the new row; an A in that same step
    // sends nothing (neither for challenge 21 nor for challenge 23).
    const replaced: World = {
      ...w,
      challenges: [{ ...incoming(), challengeId: 23n }, outgoing()],
    };
    const reseated = observe(replaced, inSheet);
    expect(reseated.phase, 'challenge 21 replaced by challenge 23: the list').toMatchObject(LIST);
    expect(cursorOf(reseated), 'on a listed row').not.toEqual({
      tab: 'challenges',
      item: INCOMING,
    });
    expect(['challenge-23', OUTGOING], 'the cursor re-seated on a listed row').toContain(
      reseated.nav.item,
    );
    const pressedAsReplaced = press(replaced, inSheet, 'A');
    expect(pressedAsReplaced.result, 'an A as the row is replaced').toBe('consumed');
    expect(pressedAsReplaced.state.phase).toMatchObject(LIST);
    const pressedAsGone = press(noOutgoing, outSheet, 'A');
    expect(pressedAsGone.result, 'an A as the row goes').toBe('consumed');
    expect(pressedAsGone.state.phase).toMatchObject(LIST);

    // The legal actions change under an open sheet, the row key the same: challenge 22 alone, the
    // viewer's (Cancel), read as Carol's to the viewer (Accept, Decline); and challenge 21, Bob's
    // to the viewer (the cursor on Decline, with the prompt open on No and on Yes), read as the
    // viewer's to Bob (Cancel alone).
    const sent = world({ tab: 'challenges', challenges: [outgoing()] });
    const onCancel = swallowed(sent, open(sent), ['A']);
    expect(onCancel.phase, 'fixture').toMatchObject(sheet(OUTGOING, ['cancel'], 'cancel'));
    const turnedIn = world({
      tab: 'challenges',
      challenges: [{ ...outgoing(), challenger: CAROL, target: ME }],
    });
    const asked = world({ tab: 'challenges', challenges: [incoming()] });
    const turnedOut = world({
      tab: 'challenges',
      challenges: [{ ...incoming(), challenger: ME, target: BOB }],
    });
    const onDecline = swallowed(asked, open(asked), ['A', 'Down']);
    const askedNo = swallowed(asked, onDecline, ['A']);
    const askedYes = swallowed(asked, askedNo, ['Down']);
    expect(askedYes.phase, 'fixture').toMatchObject(
      sheet(INCOMING, REQUEST, 'decline', { yes: true }),
    );
    let changes = 0;
    for (const [where, before, after, row] of [
      ['Cancel, now Accept, Decline', onCancel, turnedIn, OUTGOING],
      ['Decline, now Cancel', onDecline, turnedOut, INCOMING],
      ['the Decline prompt on No, now Cancel', askedNo, turnedOut, INCOMING],
      ['the Decline prompt on Yes, now Cancel', askedYes, turnedOut, INCOMING],
    ] as const) {
      const settled = observe(after, before);
      expect(settled.phase, `${where}: observe closes the sheet`).toMatchObject(LIST);
      expect(cursorOf(settled), `${where}: on the row`).toEqual({ tab: 'challenges', item: row });
      const pressed = press(after, before, 'A');
      expect(pressed.result, `${where}: an A in the same step sends nothing`).toBe('consumed');
      expect(pressed.state.phase, `${where}: and lands on the list`).toMatchObject(LIST);
      changes += 1;
    }
    expect(changes, 'ANTI-VACUITY: four changes driven').toBe(4);
  });
});

describe('socialScreen — the requested tab and the panels (ctl-8d, CTL8D.3)', () => {
  it('CTL8D-3-REQUESTED-TAB-WINS: a requested tab (U, P, L, the menu leaves, the auto-show) wins over the waiting request`s tab and the remembered tab, each of the four with three distinct tabs in play; on a requested tab that holds a waiting row the cursor sits on it, even when another tab`s request is older', () => {
    // WRONG IMPL KILLED: an init that ignores `requested` (L would open on the waiting session or
    // the remembered tab, not the leaderboard); one that ranks the remembered tab or the waiting
    // request above it; one that puts the cursor on the waiting row only when the oldest request
    // is on the opened tab (P with an older session waiting would leave the cursor off the
    // challenge); and one that keeps the remembered cursor over the request.
    const onTab = (tab: SocialTab): SocialScreenState => {
      const s = open(world({ tab }));
      expect(s.nav.tab, `fixture: a state left on ${tab}`).toBe(tab);
      return s;
    };
    const sessionWaits = { sessions: [session('waiting')], challenges: [outgoing()] };
    const challengeWaits = { sessions: [session('opened')], challenges: [incoming(), outgoing()] };
    // [requested, the rows, the waiting request's tab, the remembered tab]: three distinct tabs.
    const CASES: ReadonlyArray<
      readonly [SocialTab, Pick<World, 'sessions' | 'challenges'>, SocialTab, SocialTab]
    > = [
      ['rankings', sessionWaits, 'trades', 'challenges'],
      ['players', sessionWaits, 'trades', 'challenges'],
      ['trades', challengeWaits, 'challenges', 'rankings'],
      ['challenges', sessionWaits, 'trades', 'rankings'],
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
    // session waiting and the remembered cursor on the outgoing row.
    const duel = world({ tab: 'challenges', challenges: [incoming(), outgoing()] });
    const leftOnOutgoing = swallowed(duel, open(duel), ['Down']);
    expect(cursorOf(leftOnOutgoing), 'fixture').toEqual({ tab: 'challenges', item: OUTGOING });
    const autoShow = world({
      tab: 'challenges',
      sessions: [session('waiting', 1_000n)],
      challenges: [outgoing(), incoming(2_000n)],
    });
    expect(cursorOf(open(autoShow, leftOnOutgoing)), 'P on a pending challenge').toEqual({
      tab: 'challenges',
      item: INCOMING,
    });
    // Trades, with an older challenge waiting.
    const sessionAsked = world({
      tab: 'trades',
      sessions: [session('waiting', 5_000n)],
      challenges: [incoming(1_000n)],
    });
    expect(cursorOf(open(sessionAsked, leftOnOutgoing)), 'U on a waiting session').toEqual({
      tab: 'trades',
      item: SESSION,
    });
  });

  it('CTL8D-3-PAINT-PANEL: paint shows the state`s tab panel first (Trades the trade root, Challenges the pvp root, Players and Rankings the leaderboard root), then paints the strip into the chrome through trades.paintSocial (the session rows on every tab, the session cursor only on a session row on Trades, the challenge sheet and its prompt question while open), then the challenge cursor (incoming / outgoing on Challenges, null elsewhere); it follows the state, not the requested tab; views not built yet are skipped without a throw', () => {
    // WRONG IMPL KILLED: a paint that shows the requested tab's panel (or never calls show, so U,
    // P and L keep the panel the legacy key chose); one that paints the strip before `show` (a
    // later throw would leave the wrong panel up); a strip painted only on Trades (the chrome
    // follows the shown panel); a session cursor on another tab or with no session; a sheet
    // painted with the wrong actions or active row, dropped under its prompt, or left on the list;
    // the wrong prompt question; a challenge cursor on Trades or on the wrong row; a paint into a
    // view that does not exist yet (a TypeError before main() built the panels).
    const full = (tab: SocialTab | null): World =>
      world({ tab, sessions: [session('waiting')], challenges: [incoming(), outgoing()] });
    const ROWS = [SESSION_ROW_11];

    const LISTS: ReadonlyArray<readonly [SocialTab, SocialPaint, CursorRow]> = [
      ['players', listPaint('players', ROWS), null],
      ['trades', listPaint('trades', ROWS, SESSION), null],
      ['challenges', listPaint('challenges', ROWS), 'incoming'],
      ['rankings', listPaint('rankings', ROWS), null],
    ];
    for (const [tab, paint, cursor] of LISTS) {
      const w = full(tab);
      const s = open(w);
      expect(s.nav.tab, `${tab}: fixture`).toBe(tab);
      const calls = paintCalls(vmOf(w), s);
      expect(calls, `${tab}: the panel, then the challenge cursor, then the strip`).toEqual([
        { call: 'show', panel: PANEL[tab] },
        { call: 'paintCursor', row: cursor },
        { call: 'paintSocial', chrome: CHROME, paint },
      ]);
      expect((calls[2] as SocialCall).chrome, `${tab}: the very chrome`).toBe(CHROME);
    }

    // The outgoing row under the cursor; a Trades tab with no session holds no session cursor.
    const duel = full('challenges');
    expect(paintOf(duel, swallowed(duel, open(duel), ['Down'])).cursor, 'outgoing').toBe(
      'outgoing',
    );
    const bare = world({ tab: 'trades', challenges: [incoming()] });
    const barePaint = paintOf(bare, open(bare));
    expect(barePaint.paint, 'no session listed: no session cursor').toEqual(listPaint('trades'));
    expect(barePaint.cursor).toBeNull();

    // The paint follows the state: requested Players, LB to Rankings.
    const asked = full('players');
    const moved = paintOf(asked, swallowed(asked, open(asked), ['LB']));
    expect(moved.panel, 'the state`s panel, not the requested one').toBe('leaderboardView');
    expect(moved.paint, 'the state`s tab').toEqual(listPaint('rankings', ROWS));
    expect(moved.cursor).toBeNull();

    // The challenge sheet, its Decline prompt (No, then Yes), back to the list, and the outgoing
    // row's sheet.
    const dSheet = swallowed(duel, open(duel), ['A']);
    let p = paintOf(duel, dSheet);
    expect(p.panel).toBe('pvpView');
    expect(p.paint.tab).toBe('challenges');
    expect(p.paint.sheet, 'the sheet, on Accept').toEqual({ actions: REQUEST, active: 'accept' });
    expect(p.paint.confirm, 'no prompt').toBeNull();
    expect(p.paint.sessionCursor, 'no session cursor on Challenges').toBeNull();
    const dAsked = swallowed(duel, dSheet, ['Down', 'A']);
    p = paintOf(duel, dAsked);
    expect(p.paint.sheet, 'the sheet stays painted under its prompt').toEqual({
      actions: REQUEST,
      active: 'decline',
    });
    expect(p.paint.confirm, 'the challenge Decline prompt on No').toEqual({
      question: 'declineChallenge',
      yes: false,
    });
    expect(paintOf(duel, swallowed(duel, dAsked, ['Down'])).paint.confirm, 'on Yes').toEqual({
      question: 'declineChallenge',
      yes: true,
    });
    expect(
      paintOf(duel, swallowed(duel, dAsked, ['B', 'B'])).paint,
      'back on the list: no sheet, no prompt',
    ).toEqual(listPaint('challenges', ROWS));
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
          ...(parts.challenges ? ['paintCursor'] : []),
          ...(parts.trades ? ['paintSocial'] : []),
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
  ackedSeq: 0n,
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
    // ts-6b-10 (named intentional change): the cursor paint precedes the strip. Was: show,
    // paintSocial, paintCursor, rankings.
    'show first, then the challenge cursor, the strip and the Rankings view, once each',
  ).toEqual(['show', 'paintCursor', 'paintSocial', 'rankings']);
  expect(log[0], 'the leaderboard root is the panel').toEqual({
    call: 'show',
    panel: 'leaderboardView',
  });
  return (log[3] as RankingsCall).paint;
}

const A_INPUTS: readonly Input[] = ['A', rep('A')];

describe('socialScreen — Players: the walk-up phase and the change signal (ctl-8g, CTL8G.1)', () => {
  it('CTL8G-1-WALKUP: A on a Players row enters the walk-up phase on that row and sends nothing (a held A does not); in it B returns to the list without popping the frame, a held B does nothing, A (fresh or held) stays, Up / Down / LB / RB move exactly as in the list AND return to the list, Left / Right move nothing, Start and Select act as everywhere; with no players listed A opens nothing; a walk-up whose player leaves, goes offline or is replaced closes to the list, and an A pressed as that happens only paints', () => {
    // WRONG IMPL KILLED: an A that opens a sheet or sends a command on a player (no remote
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

  it('CTL8G-1-OBSERVE: init records the players` signature (`socialPeopleKey`) in state.people; observe answers the SAME state when nothing the Players tab shows changed (a rebuilt equal vm, a third party`s session or challenge, an offline player who is not listed, the player rows rebuilt equal, a listed player moving without crossing the 12-tile line, a re-rated leaderboard) and a NEW state, with the new signature and a listed cursor, when a player joins, leaves, goes offline, is renamed, or crosses the line either way, or gains a character; the new state is then stable', () => {
    // WRONG IMPL KILLED: an observe that answers a new object at every batch (a repaint per batch,
    // and the host's same-object pin); one that answers the SAME object when a player joins, leaves,
    // is renamed or crosses the 12-tile line while the cursor row survives (the Players list the
    // player sees would be stale: nothing repaints until a button press); a signature that reads
    // the player row objects (every batch that rebuilds an equal row repaints) or the raw characters
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
      sessions: [tradeSession(5n, BOB, CAROL, { createdAtMs: 50n })],
      challenges: [{ ...incoming(50n), challengeId: 3n, target: CAROL }],
    });
    const SAME: ReadonlyArray<readonly [string, World]> = [
      ['a third party`s session and challenge', othersMoved],
      [
        'an offline player who is not listed',
        swap({ players: [...base.players, person(EVE, 'Eve', 5n, false)] }),
      ],
      [
        'the player rows rebuilt, equal field by field',
        swap({ players: base.players.map((p) => ({ ...p })) }),
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
  it('CTL8G-2-READONLY: on a ranked row a fresh or a held A is swallowed and changes nothing (no sheet, no walk-up, no command, the very same state), on every ranked row including the viewer`s own and with a waiting session and challenge in the store; an empty board swallows A too; Up / Down move over the ranked keys in leaderboard order (a fresh press wraps, a held one clamps) and B still pops the frame', () => {
    // WRONG IMPL KILLED: an A on a ranked row that opens an action sheet (the challenge sheet of
    // a row that does not exist: Rankings is a view, nothing to act on), opens a session's editor,
    // enters the walk-up (that is Players'), or sends a challenge or any command; a state rebuilt
    // on A (a repaint per press); an A that acts only on the first row, only on a row that is not
    // the viewer's, or only while no request waits; an empty board that throws or opens a sheet on
    // nothing; a cursor that skips the viewer's row or walks in input order (Carol first); a held
    // arrow that wraps; and a B that stops popping.
    const busy = ranked('rankings', {
      sessions: [session('waiting')],
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
      'show, the challenge cursor, the strip, then the Rankings view',
      // ts-6b-10 (named intentional change): the cursor paint precedes the strip; Players shows
      // the leaderboard root through socialPanel itself. Was: show, paintSocial, paintCursor,
      // rankings (with a players override in the screen).
    ).toEqual(['show', 'paintCursor', 'paintSocial', 'rankings']);
    expect(log[0], 'the leaderboard root, first').toEqual({
      call: 'show',
      panel: 'leaderboardView',
    });
    expect((log[2] as SocialCall).chrome, 'the very chrome').toBe(CHROME);
    expect((log[2] as SocialCall).paint, 'the strip on the Players tab').toEqual(
      listPaint('players'),
    );
    expect((log[1] as CursorCall).row, 'no challenge cursor on Players').toBeNull();
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
      'no Rankings view: show, the challenge cursor, the strip',
    ).toEqual(['show', 'paintCursor', 'paintSocial']);
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
        sessions: [session('waiting')],
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
    // A challenge sheet or prompt open on Challenges does not call it either.
    const duel = full('challenges');
    const inSheet = swallowed(duel, open(duel), ['A']);
    expect(
      paintLog(vmOf(duel), inSheet).filter((c) => c.call === 'rankings'),
      'a challenge sheet: no Rankings call',
    ).toEqual([]);
    const inPrompt = swallowed(duel, open(duel), ['A', 'Down', 'A']);
    expect(
      paintLog(vmOf(duel), inPrompt).filter((c) => c.call === 'rankings'),
      'a challenge prompt: no Rankings call',
    ).toEqual([]);
    expect(checked, 'ANTI-VACUITY: four tabs').toBe(4);
  });
});

// ==========================================================================================
// ts-3 (ts-3.4, ts-3.5): the session rows on the Trades tab.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-trade-sessions.spec.md §ts-3: A (fresh) on a `session`
//   row answers `{ kind: 'openTradeEditor', sessionId }` at once (no sheet, no prompt);
//   `SocialScreenState.sessions` is `socialSessionsKey(vm)`, settled like `people`; paint passes
//   `sessions` (the rows' paint data) and `sessionCursor` (the session row key under the cursor,
//   else null).
//
// Fixture: Bob opened session 101 with the viewer (untouched: a waiting request, created 500);
//   the viewer opened 102 with Carol and confirmed it (created 4_000).
// ==========================================================================================

const S101 = tradeSession(101n, BOB, ME, { createdAtMs: 500n });
const S102 = tradeSession(102n, ME, CAROL, { openerConfirmed: true, createdAtMs: 4_000n });
const sessionWorld = (over: Partial<World> = {}): World =>
  world({
    tab: 'trades',
    sessions: [S102, S101],
    players: [ME_P, BOB_P, CAROL_P],
    ...over,
  });

describe('socialScreen — the session rows (ts-3)', () => {
  it('ts-3.4 the Trades tab walks the session rows with Up / Down (a fresh press wraps, a held one clamps); a fresh A on a session row answers openTradeEditor for THAT session at once, with no sheet and no prompt; a held A does nothing; B still pops', () => {
    // WRONG IMPL KILLED: a session row that opens an action sheet (actions are empty: the sheet
    // would be empty or the A swallowed, and the editor unreachable from Social); the editor
    // opened on the first session whatever the cursor (a key/id mix-up); a held A that opens it
    // (a held Enter would reopen it at repeat rate); a sheet left open after the command.
    const w = sessionWorld();
    const opened = open(w);
    expect(cursorOf(opened), 'fixture: the requested Trades, on the waiting session').toEqual({
      tab: 'trades',
      item: 'session-101',
    });
    expect(swallowed(w, opened, ['Down']).nav.item).toBe('session-102');
    expect(swallowed(w, opened, ['Down', 'Down']).nav.item, 'a fresh Down wraps').toBe(
      'session-101',
    );
    expect(swallowed(w, opened, ['Up']).nav.item, 'a fresh Up wraps').toBe('session-102');
    expect(swallowed(w, opened, [rep('Up')]).nav.item, 'a held Up stays').toBe('session-101');

    for (const [reach, id] of [
      [[], 101n],
      [['Down'], 102n],
    ] as const) {
      const on = swallowed(w, opened, reach);
      const a = press(w, on, 'A');
      expect(a.result, `A on session ${id}`).toEqual({ kind: 'openTradeEditor', sessionId: id });
      expect(a.state.phase, `A on session ${id}: no sheet`).toMatchObject(LIST);
      const held = press(w, on, rep('A'));
      expect(held.result, `a held A on session ${id}`).toBe('consumed');
      expect(held.state.phase).toMatchObject(LIST);
    }
    expect(press(w, opened, 'B').result).toEqual(POP);
  });

  it('ts-3.5 a plain open lands on the oldest waiting session`s row; observe answers the SAME state when no painted session fact changed and a NEW one (state.sessions = the new key) when a session arrives, leaves or a mark flips', () => {
    // WRONG IMPL KILLED: an init that ignores waiting sessions (the banner's "View" would open
    // Social elsewhere); a state with no `sessions` signature (a partner's confirm never repaints
    // the row: nothing would change the state); an observe that answers a new object per batch.
    const w = sessionWorld({ tab: null });
    const s = open(w);
    expect(cursorOf(s)).toEqual({ tab: 'trades', item: 'session-101' });
    expect(typeof s.sessions).toBe('string');
    expect(observe(w, s), 'nothing changed').toBe(s);
    expect(
      observe(sessionWorld({ tab: null, sessions: [{ ...S102, revision: 7n }, S101] }), s),
      'a revision bump paints nothing new',
    ).toBe(s);
    for (const [what, after] of [
      [
        'a session arrives',
        sessionWorld({ tab: null, sessions: [S102, S101, tradeSession(103n, CAROL, ME)] }),
      ],
      ['a session leaves', sessionWorld({ tab: null, sessions: [S101] })],
      [
        'a mark flips',
        sessionWorld({ tab: null, sessions: [{ ...S102, partnerConfirmed: true }, S101] }),
      ],
    ] as const) {
      const next = observe(after, s);
      expect(next, `${what}: a new state`).not.toBe(s);
      expect(next.sessions, `${what}: the new signature`).not.toBe(s.sessions);
      expect(observe(after, next), `${what}: then stable`).toBe(next);
    }
  });

  it('ts-3.5 paint passes the session rows` paint data and the session cursor; on a session row the challenge cursor is null; off the Trades tab the session cursor is null', () => {
    // WRONG IMPL KILLED: the session rows never painted; the marks from the wrong seat; the
    // session cursor stuck on the first row; a session row handed to the challenge root as its
    // cursor kind; a session cursor kept on another tab.
    const w = sessionWorld();
    const s = open(w);
    const p = paintOf(w, s);
    expect(p.panel).toBe('tradeView');
    expect(p.paint.sessions).toEqual([
      { key: 'session-101', partnerName: 'Bob', mineConfirmed: false, theirsConfirmed: false },
      { key: 'session-102', partnerName: 'Carol', mineConfirmed: true, theirsConfirmed: false },
    ]);
    expect(p.paint.sessionCursor).toBe('session-101');
    expect(p.cursor, 'no challenge cursor on a session row').toBeNull();
    const onSecond = paintOf(w, swallowed(w, s, ['Down']));
    expect(onSecond.paint.sessionCursor).toBe('session-102');
    const elsewhere = paintOf(w, swallowed(w, s, ['RB']));
    expect(elsewhere.paint.tab).toBe('challenges');
    expect(elsewhere.paint.sessionCursor).toBeNull();
  });
});

// ==========================================================================================
// ts-4 (ts-4.6): Social › Trades lists only session rows; no trade-offer command exists.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-trade-sessions.spec.md §ts-4 (ts-4.6) and the ts-4 plan
//   "Resume 2": `commandOf` has no trade branch; the only question is `declineChallenge`; `paint`
//   hands the view `{ tab, sessions, sessionCursor, sheet, confirm }`; A on a session row answers
//   `{ kind: 'openTradeEditor', sessionId }`.
//
// The mixed world: Bob opened 31 with the viewer (untouched: waiting); the viewer opened 32 with
//   Carol and confirmed its side; Carol and Bob share 33 (foreign); Bob challenges the viewer (21)
//   and the viewer challenges Carol (22). Every state reachable from every open (a plain one and
//   each requested tab) by up to EXPLORE_DEPTH presses of every button, fresh and held, is
//   visited: every command, every painted prompt and every paint's shape is collected.
// ==========================================================================================

const MIXED: World = world({
  sessions: [
    tradeSession(33n, CAROL, BOB),
    tradeSession(32n, ME, CAROL, { openerConfirmed: true, createdAtMs: 9_000n }),
    tradeSession(31n, BOB, ME, { createdAtMs: 8_000n }),
  ],
  challenges: [outgoing(), incoming()],
  players: [ME_P, BOB_P, CAROL_P],
  characters: CHARS,
});

const BUTTONS: readonly VButton[] = [
  'Up',
  'Down',
  'Left',
  'Right',
  'A',
  'B',
  'LB',
  'RB',
  'Start',
  'Select',
];
const EXPLORE_DEPTH = 7;

interface Exploration {
  /** Every command a press answered, as `kind:id` (frame results as their kind). */
  readonly commands: ReadonlySet<string>;
  /** Every prompt question a reachable state paints. */
  readonly questions: ReadonlySet<string>;
  /** Every distinct key set a reachable state's SocialPaint carries. */
  readonly paintKeys: ReadonlySet<string>;
  /** Every action a painted sheet offers. */
  readonly sheetActions: ReadonlySet<string>;
  readonly states: number;
}

/** The result as `kind:id`, the id being whichever of sessionId / challengeId / tradeId it has. */
function commandKey(result: ScreenResult): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const r = result as unknown as Record<string, unknown>;
  const id = r.sessionId ?? r.challengeId ?? r.tradeId;
  return id === undefined ? String(r.kind) : `${String(r.kind)}:${String(id)}`;
}

function explore(w: World): Exploration {
  const commands = new Set<string>();
  const questions = new Set<string>();
  const paintKeys = new Set<string>();
  const sheetActions = new Set<string>();
  const seen = new Set<string>();
  const inputs: Input[] = [...BUTTONS, ...BUTTONS.map(rep)];
  let frontier: SocialScreenState[] = [null, 'players', 'trades', 'challenges', 'rankings'].map(
    (tab) => open({ ...w, tab: tab as SocialTab | null }),
  );
  for (let depth = 0; depth <= EXPLORE_DEPTH && frontier.length > 0; depth++) {
    const next: SocialScreenState[] = [];
    for (const s of frontier) {
      const id = JSON.stringify(s);
      if (seen.has(id)) continue;
      seen.add(id);
      const paint = paintOf(w, s).paint;
      paintKeys.add(Object.keys(paint).sort().join(','));
      if (paint.confirm !== null) questions.add(paint.confirm.question);
      for (const action of paint.sheet?.actions ?? []) sheetActions.add(action);
      for (const input of inputs) {
        const step = press(w, s, input);
        const key = commandKey(step.result);
        if (key !== null) commands.add(key);
        next.push(step.state);
      }
    }
    frontier = next;
  }
  return { commands, questions, paintKeys, sheetActions, states: seen.size };
}

describe('socialScreen — Social › Trades lists only session rows (ts-4, ts-4.6)', () => {
  it('ts-4.6 over every state reachable in a mixed world (sessions in both seats and a foreign one, an incoming and an outgoing challenge) the screen answers exactly openTradeEditor for each own session, acceptChallenge / declineChallenge on 21, cancelChallenge on 22 and the frame results pop / popToBase / toggleHelp: never respondTrade, confirmTrade or cancelTrade', () => {
    // WRONG IMPL KILLED: a `commandOf` trade branch reachable from any row (a respondTrade,
    // confirmTrade or cancelTrade answered for some (row, action)); a session row that opens a
    // sheet whose Cancel answers cancelTrade; an editor opened on the foreign session or with the
    // wrong id; a challenge command carrying a session id; and an exploration that never reaches
    // a command (the anti-vacuity counts below).
    const found = explore(MIXED);
    expect(found.states, 'ANTI-VACUITY: many states visited').toBeGreaterThan(20);
    expect([...found.commands].sort(), 'every answer a press gives').toEqual(
      [
        'acceptChallenge:21',
        'cancelChallenge:22',
        'declineChallenge:21',
        'openTradeEditor:31',
        'openTradeEditor:32',
        'pop',
        'popToBase',
        'toggleHelp',
      ].sort(),
    );
    for (const legacy of ['respondTrade', 'confirmTrade', 'cancelTrade']) {
      expect(
        [...found.commands].filter((c) => c.startsWith(`${legacy}:`) || c === legacy),
        `no ${legacy}`,
      ).toEqual([]);
    }
  });

  it('ts-4.6 the only prompt question any reachable state paints is declineChallenge, every sheet offers only accept / decline / cancel, and every paint hands the view a SocialPaint with exactly the keys tab, sessions, sessionCursor, sheet, confirm', () => {
    // WRONG IMPL KILLED: a `declineTrade` or `confirmTrade` question still asked by some row; a
    // `confirm` action on a sheet; a paint that still carries a `tradeCursor` key (or any key
    // beyond the five) or drops one of them.
    const found = explore(MIXED);
    expect([...found.questions], 'the prompt questions painted').toEqual(['declineChallenge']);
    expect([...found.sheetActions].sort(), 'the actions a sheet offers').toEqual([
      'accept',
      'cancel',
      'decline',
    ]);
    expect([...found.paintKeys], 'the SocialPaint key set').toEqual([
      'confirm,sessionCursor,sessions,sheet,tab',
    ]);
  });

  it('ts-4.6 the view model reads no trade offers: over a store whose only members are allChallenges, allPlayers, characters, allProfiles and allTradeSessions it builds, every member it reads is one of those, and Trades lists exactly the viewer`s session rows', () => {
    // WRONG IMPL KILLED: a viewModel that still calls `store.allTradeOffers()` (a TypeError on
    // this store), or reads any other store member; one whose Trades tab lists anything but the
    // viewer's two sessions.
    const ALLOWED = [
      'allChallenges',
      'allPlayers',
      'characters',
      'allProfiles',
      'allTradeSessions',
    ];
    const reads = new Set<string>();
    const base = ctxOf(MIXED) as unknown as { store: Record<string, unknown> };
    const store = new Proxy(base.store, {
      get(target, prop, receiver) {
        reads.add(String(prop));
        return Reflect.get(target, prop, receiver);
      },
    });
    const ctx = { ...(base as object), store } as unknown as ScreenContext;
    expect(Reflect.has(base.store, 'allTradeOffers'), 'fixture: the store has no offer read').toBe(
      false,
    );
    const vm = socialScreen.viewModel(ctx);
    expect(
      [...reads].filter((r) => !ALLOWED.includes(r)),
      'store members read beyond the five',
    ).toEqual([]);
    expect(reads.has('allTradeSessions'), 'the session read is made').toBe(true);
    expect(vm.trades.map((r) => [r.key, r.kind])).toEqual([
      ['session-31', 'session'],
      ['session-32', 'session'],
    ]);
  });
});
