// @vitest-environment happy-dom
/**
 * socialScreen.boot.test.ts: the Social screen (ctl-8d) booted through main.ts over the REAL
 * client/index.html shell, the REAL trade, pvp and leaderboard views and the REAL screen-adapter
 * table (`SCREEN_ADAPTERS.social` is whatever ui/screens/index.ts ships: no stand-in is swapped in).
 *
 * - CTL8D-1-BOOT-TABS: U opens Social with the four tabs Players | Trades | Challenges | Rankings
 *   on Trades; RB / LB (PageDown / PageUp) walk the tabs with a wrap, each tab shown over its own
 *   root (Players over the trade root with the placeholder), the strip in the shown root's chrome;
 *   and an incoming challenge arriving with Social closed opens it on Challenges with the cursor on
 *   the request.
 * - CTL8D-2-BOOT-RESPOND: A on the incoming challenge opens a sheet Accept / Decline on Accept;
 *   Decline asks Yes / No on No and sends nothing until Yes; A on Yes sends one declineChallenge;
 *   the legacy Accept button stays clickable; then U, A, A accepts a waiting trade.
 * - CTL8D-3-BOOT-HOTKEYS: with a waiting trade in the store (the waiting-request rule's pick), U,
 *   P and L still open Social on Trades, Challenges and Rankings, each over its own root.
 *
 * Every case asserts what only the real Social adapter paints (the selected `#social-tab-<tab>`,
 * the cursor mark, the sheet and the prompt), never just the panel shown: ctl-8s already opens the
 * right panel with the legacy adapter, so a case that only checked the root would pass on master.
 *
 * Harness: main.social.test.ts's (the real shell mounted, main.ts imported fresh per boot, only
 * the wasm pkg, the connection, telemetry and the world renderer stubbed) with
 * main.dispatch.test.ts's recording connection: every reducer but enqueueMove records its name and
 * its argument object in `H.calls` and resolves at once. Keys are real keydown / keyup pairs on
 * the window (Enter = A, Escape = Start, ArrowUp / ArrowDown = the D-pad, PageUp / PageDown =
 * LB / RB, KeyU / KeyP / KeyL = the legacy Social keys). Store rows arrive through
 * `opts.store` and a flushed batch. `flush()` is one zero-delay macrotask (a settled reducer).
 * No frame is run: a press reaches the adapter on its keydown.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from '../../convert/convert';
import type { Connection, ConnectionOptions } from '../../net/connection';
import type { StoreBattleChallenge, StoreMonsterPub, StoreTradeOffer } from '../../net/store';
import type { SocialTab } from './types';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every reducer call but enqueueMove, oldest first, with the exact argument object. */
  calls: [] as Array<{ name: string; args: unknown }>,
}));

// wasm pkg: every name main.ts imports.
vi.mock('../../../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 8;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: (state: unknown) => state,
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 37,
    talk_range: () => 2,
    predict_move: () => ({}),
    predict_tick: () => ({}),
    set_active_zone: () => undefined,
    start: () => undefined,
    step_ms: () => 200,
    zone_map: (zoneId: number) => ({
      zone_id: zoneId,
      width: SIDE,
      height: SIDE,
      walkable: grid(true),
      grass: grid(false),
      warps: [],
    }),
  };
});

// The connection: capture the options; enqueueMove never settles, every other reducer records its
// name and arguments and resolves at once. sessionState() must be 'hidden' or the session gate
// swallows every key.
vi.mock('../../net/connection', () => {
  const reducers = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'enqueueMove') return () => new Promise<void>(() => {});
        return (args: unknown) => {
          H.calls.push({ name: String(name), args });
          return Promise.resolve();
        };
      },
    },
  );
  const live = { reducers };
  const stub = {
    conn: undefined,
    live: () => live,
    identity: () => H.identity,
    linkFrozen: () => false,
    continueAnonymously: () => undefined,
    sessionState: () => 'hidden',
    startSignIn: () => undefined,
    reconnectNow: () => undefined,
  } as unknown as Connection;
  return {
    connect: (opts: ConnectionOptions): Connection => {
      H.connectOpts = opts;
      return stub;
    },
  };
});

vi.mock('../../observability/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../observability/telemetry')>();
  return {
    ...actual,
    loadOtelSdk: () => {
      throw new Error('loadOtelSdk must not be reached in this test');
    },
    startClientTelemetry: () => Promise.resolve(actual.NOOP_TELEMETRY),
  };
});

// The renderer: init appends a focusable canvas to the mount, so main.ts finds its world region.
vi.mock('../../render/world', () => {
  class WorldRenderer {
    init(mount: HTMLElement): Promise<void> {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('tabindex', '0');
      canvas.setAttribute('role', 'application');
      mount.appendChild(canvas);
      return Promise.resolve();
    }
    setMap(): void {}
    render(): void {}
    resize(): void {}
    screenFor(): { x: number; y: number } {
      return { x: 0, y: 0 };
    }
    clear(): void {}
    destroy(): void {}
    get viewCount(): number {
      return 0;
    }
  }
  return { WorldRenderer };
});

// --- harness ------------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

/** Record every listener added to `target`, so the teardown removes main.ts's module-scope ones
 *  (a fresh import per boot would otherwise stack them). */
function recordListeners(target: EventTarget): void {
  const own = Object.getOwnPropertyDescriptor(target, 'addEventListener');
  const original = target.addEventListener.bind(target);
  (target as unknown as { addEventListener: typeof original }).addEventListener = (
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    recorded.push({ target, type, handler, options });
    original(type, handler, options);
  };
  restorers.push(() => {
    if (own !== undefined) Object.defineProperty(target, 'addEventListener', own);
    else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
  });
}

/** Mount the REAL client/index.html shell (minus its module script) into the live document. */
function mountIndexHtmlShell(): void {
  const htmlPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'index.html',
  );
  const parsed = new DOMParser().parseFromString(readFileSync(htmlPath, 'utf8'), 'text/html');
  const children = Array.from(parsed.body.children).filter((el) => el.tagName !== 'SCRIPT');
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'index.html must yield a body to mount').toBeGreaterThan(5);
  document.body.replaceChildren(...children.map((el) => document.adoptNode(el)));
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

const clock = { t: 0 };
let opts: ConnectionOptions;
/** The i18n resolver instance main.ts runs on (imported AFTER the module reset, so it is shared). */
let i18n: typeof import('../i18n/resolver');

/** Boot a fresh main.ts over the real shell and wait for it to connect. No frame ever runs: the
 *  rAF stub never calls back. */
async function bootReady(): Promise<void> {
  H.connectOpts = null;
  H.calls = [];
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  vi.stubGlobal('requestAnimationFrame', (): number => 0);
  vi.resetModules();
  await import('../../main');
  i18n = await import('../i18n/resolver');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
  opts.onReady(H.identity);
}

function teardownBoot(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  H.calls = [];
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
}

/** Let queued microtasks and zero-delay timers run (a settled reducer promise). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const EID = 7n;
/** Another player: the challenger of every incoming challenge, the initiator of every trade. */
const OTHER = 'cd'.repeat(32);
/** Distinct ids per row kind, so a command naming the wrong row shows. */
const TRADE_ID = 11n;
const CHALLENGE_ID = 21n;
const AUTO_SHOW_CHALLENGE_ID = 31n;
const PARTY_MONSTER_ID = 51n;

/** Deliver one authoritative batch at clock `at`: the own player + character at (2, 6), plus
 *  whatever the case put in the store since the last batch. */
function server(at: number): void {
  clock.t = at;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    lastInputSeq: 0n,
  });
  opts.store.upsertCharacter(
    {
      entityId: EID,
      zoneId: 0,
      tileX: 2,
      tileY: 6,
      facing: 'East',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
    },
    at,
  );
  opts.store.flushBatch();
}

/** A Pending challenge from OTHER to the booted player (an incoming, waiting request). */
function incomingChallenge(challengeId: bigint): StoreBattleChallenge {
  return {
    challengeId,
    challenger: OTHER,
    target: H.identity,
    challengerPartyIds: [],
    status: 'Pending',
    createdAtMs: 0n,
  };
}

/** A Pending trade OTHER offered the booted player (the counterparty: a waiting request). */
function waitingTrade(tradeId: bigint): StoreTradeOffer {
  return {
    tradeId,
    initiator: OTHER,
    counterparty: H.identity,
    initiatorMonsterIds: [],
    initiatorItems: [],
    initiatorCurrency: 0n,
    counterpartyMonsterIds: [],
    counterpartyItems: [],
    counterpartyCurrency: 0n,
    initiatorCards: [],
    counterpartyCards: [],
    status: 'Pending',
    createdAtMs: 0n,
  };
}

/** The booted player's one party monster (slot 0), so a challenge Accept has a party to send. */
function partyMonster(monsterId: bigint): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: H.identity,
    speciesId: 1,
    nickname: `m${monsterId}`,
    level: 5,
    xp: 0,
    currentHp: 20,
    statHp: 20,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
    partySlot: 0,
    tier: 0,
    essence: {} as StoreMonsterPub['essence'],
    trustTier: 'Unknown' as StoreMonsterPub['trustTier'],
    qualityTimeTier: 0,
    nutritionPct: 0,
  };
}

/** A keydown at `at` at the window and its keyup 5 ms later. */
function press(code: string, at: number): void {
  clock.t = at;
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  clock.t = at + 5;
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

/** The whole context stack, base first, through the read-only `__game()` DEV hook. */
const stackNow = (): unknown[] =>
  (window as unknown as { __game: () => { stack: unknown[] } }).__game().stack;

const WORLD_FRAME = { kind: 'world' } as const;
const SOCIAL_STACK = [WORLD_FRAME, { kind: 'screen', id: 'social' }];

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} must be in the document`);
  return found;
}

/** The Social tabs in strip order (design §5), and the root each tab's panel is. */
const TAB_ORDER: readonly SocialTab[] = ['players', 'trades', 'challenges', 'rankings'];
const ROOT_OF: Readonly<Record<SocialTab, string>> = {
  players: 'trade-overlay',
  trades: 'trade-overlay',
  challenges: 'pvp-challenge-overlay',
  rankings: 'leaderboard-overlay',
};
const SOCIAL_ROOTS = ['trade-overlay', 'pvp-challenge-overlay', 'leaderboard-overlay'];

/** Which Social roots are on screen (each view shows and hides its root by inline display). */
const shownRoots = (): string[] => SOCIAL_ROOTS.filter((id) => el(id).style.display !== 'none');

function tabLabel(tab: SocialTab): string {
  switch (tab) {
    case 'players':
      return i18n.t('social.tab.players');
    case 'trades':
      return i18n.t('social.tab.trades');
    case 'challenges':
      return i18n.t('social.tab.challenges');
    case 'rankings':
      return i18n.t('social.tab.rankings');
  }
}

/** Social is the one frame over the world, on `tab`: that tab's root is the one shown, its first
 *  child is the chrome holding the one tab strip, the strip lists the four tabs in order with
 *  their catalogued labels, and exactly `tab` is selected (is-active and aria-selected). */
function expectSocialOn(label: string, tab: SocialTab): void {
  expect(stackNow(), `${label}: the one Social frame`).toEqual(SOCIAL_STACK);
  const rootId = ROOT_OF[tab];
  expect(shownRoots(), `${label}: the ${tab} panel's root alone`).toEqual([rootId]);
  const strips = document.querySelectorAll<HTMLElement>('#social-tabs');
  expect(strips.length, `${label}: one tab strip`).toBe(1);
  const strip = strips[0] as HTMLElement;
  const chrome = el(rootId).firstElementChild;
  expect(
    chrome !== null && chrome !== strip && chrome.contains(strip),
    `${label}: the strip is in the chrome, the first child of #${rootId}`,
  ).toBe(true);
  const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')];
  expect(
    tabs.map((t) => t.id),
    `${label}: the four tabs in order`,
  ).toEqual(TAB_ORDER.map((t) => `social-tab-${t}`));
  expect(
    tabs.map((t) => t.textContent),
    `${label}: their catalogued labels`,
  ).toEqual(TAB_ORDER.map(tabLabel));
  expect(
    tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.id),
    `${label}: ${tab} alone is aria-selected`,
  ).toEqual([`social-tab-${tab}`]);
  expect(
    tabs.filter((t) => t.classList.contains('is-active')).map((t) => t.id),
    `${label}: ${tab} alone is-active`,
  ).toEqual([`social-tab-${tab}`]);
}

/** The five trade-shell parts, in shell order, and which of them are `hidden` now. */
const TRADE_PARTS = [
  'trade-status',
  'trade-my-side',
  'trade-their-side',
  'trade-actions',
  'trade-feedback',
];
const hiddenTradeParts = (): string[] => TRADE_PARTS.filter((id) => el(id).hidden);

/** The Players placeholder in the shown trade root: the status reads it, both sides and the
 *  actions are hidden, the status and the feedback are not. */
function expectPlayersPlaceholder(label: string): void {
  expect(el('trade-status').textContent, `${label}: the placeholder`).toBe(
    i18n.t('social.players.placeholder'),
  );
  expect(hiddenTradeParts(), `${label}: the sides and the actions hidden`).toEqual([
    'trade-my-side',
    'trade-their-side',
    'trade-actions',
  ]);
}

/** The trade root as the no-trade render leaves it: no placeholder, nothing hidden. */
function expectNoTradeRoot(label: string): void {
  expect(el('trade-status').textContent, `${label}: the no-trade status`).toBe(
    i18n.t('trade.status.none'),
  );
  expect(hiddenTradeParts(), `${label}: nothing hidden in the trade root`).toEqual([]);
}

/** The cursor mark on a legacy row: the nav-item class, the active class, aria-current. */
const MARKED = [true, true, 'true'] as const;
const UNMARKED = [false, false, null] as const;
const cursorMark = (node: HTMLElement): [boolean, boolean, string | null] => [
  node.classList.contains('mr-nav-item'),
  node.classList.contains('is-active'),
  node.getAttribute('aria-current'),
];

const sheetShown = (): boolean => {
  const sheet = document.getElementById('social-sheet');
  return sheet !== null && !sheet.hidden;
};
const promptShown = (): boolean => {
  const prompt = document.getElementById('social-prompt');
  return prompt !== null && !prompt.hidden;
};

interface NavRows {
  readonly keys: readonly string[];
  readonly texts: readonly string[];
  readonly activeByClass: readonly string[];
  readonly activeByAria: readonly string[];
}

/** The `[data-nav-key]` rows of a nav container, and which carry the cursor (class and aria). */
function navRows(container: HTMLElement): NavRows {
  const rows = [...container.querySelectorAll<HTMLElement>('[data-nav-key]')];
  const key = (r: HTMLElement): string => r.dataset.navKey ?? '';
  return {
    keys: rows.map(key),
    texts: rows.map((r) => r.textContent ?? ''),
    activeByClass: rows.filter((r) => r.classList.contains('is-active')).map(key),
    activeByAria: rows.filter((r) => r.getAttribute('aria-selected') === 'true').map(key),
  };
}

/** The sheet of an incoming request (a challenge, or a trade offered to the player): Accept then
 *  Decline, the cursor on `active`. */
function expectAnswerSheet(label: string, active: 'accept' | 'decline'): void {
  expect(sheetShown(), `${label}: the sheet shows`).toBe(true);
  expect(navRows(el('social-sheet')), `${label}: Accept, Decline, the cursor on ${active}`).toEqual(
    {
      keys: ['accept', 'decline'],
      texts: [i18n.t('social.action.accept'), i18n.t('social.action.decline')],
      activeByClass: [active],
      activeByAria: [active],
    },
  );
}

/** The challenge Decline question, Yes then No, the cursor on `active`. */
function expectDeclineChallengePrompt(label: string, active: 'yes' | 'no'): void {
  expect(promptShown(), `${label}: the prompt shows`).toBe(true);
  expect(el('social-prompt-text').textContent, `${label}: the question`).toBe(
    i18n.t('social.confirm.declineChallenge'),
  );
  expect(navRows(el('social-confirm')), `${label}: Yes, No, the cursor on ${active}`).toEqual({
    keys: ['yes', 'no'],
    texts: [i18n.t('prompt.yes'), i18n.t('prompt.no')],
    activeByClass: [active],
    activeByAria: [active],
  });
}

describe('socialScreen booted through main.ts over the real views and adapter table (ctl-8d)', {
  sequential: true,
}, () => {
  afterEach(teardownBoot);

  it('CTL8D-1-BOOT-TABS: U opens Social on Trades with the four tabs Players, Trades, Challenges, Rankings in the trade root`s chrome; RB walks Challenges (the pvp root), Rankings (the leaderboard root) and wraps to Players (the trade root with the placeholder, the sides and the actions hidden), then Trades with no render between (the placeholder gone); LB walks back with the wrap, each tab over its own root with the strip following it; and with Social closed an incoming challenge arriving in a batch opens it on Challenges with the cursor mark on #pvp-challenge-incoming', async () => {
    // WRONG IMPL KILLED: the legacy adapter on the Social frame (nothing paints a strip; RB and LB
    // do nothing); an adapter whose LB / RB do not wrap, or step the wrong way; a paint that
    // selects a tab but leaves the previous panel shown (or shows the trade root for Challenges);
    // a strip left in the hidden root's chrome (two strips, or the chrome never moves); a Players
    // tab with no placeholder or with the trade sides left showing; a placeholder that survives
    // the switch to Trades with no render between, or is left in the hidden trade root; and an
    // auto-show that opens on the remembered tab (Trades) or puts no cursor on the request.
    await bootReady();
    server(1000);
    let at = 1100;
    const key = (code: string): void => {
      press(code, at);
      at += 10;
    };

    key('KeyU');
    expectSocialOn('U', 'trades');
    expectNoTradeRoot('U');

    // RB: Challenges, Rankings, then the wrap to Players, then Trades.
    key('PageDown');
    expectSocialOn('RB from Trades', 'challenges');
    key('PageDown');
    expectSocialOn('RB from Challenges', 'rankings');
    key('PageDown');
    expectSocialOn('RB from Rankings wraps', 'players');
    expectPlayersPlaceholder('Players');
    key('PageDown');
    expectSocialOn('RB from Players', 'trades');
    expectNoTradeRoot('Players to Trades, no render between');

    // LB: Players, then the wrap to Rankings, Challenges, Trades.
    key('PageUp');
    expectSocialOn('LB from Trades', 'players');
    expectPlayersPlaceholder('Players again');
    key('PageUp');
    expectSocialOn('LB from Players wraps', 'rankings');
    expectNoTradeRoot('the hidden trade root holds no placeholder');
    key('PageUp');
    expectSocialOn('LB from Rankings', 'challenges');
    key('PageUp');
    expectSocialOn('LB from Challenges', 'trades');
    expectNoTradeRoot('Trades again');

    key('Escape');
    expect(stackNow(), 'precondition: Start closed Social').toEqual([WORLD_FRAME]);
    expect(shownRoots(), 'precondition: no Social root is shown').toEqual([]);

    // The auto-show: an incoming challenge, Social closed, no overlay up, a world base.
    opts.store.upsertChallenge(incomingChallenge(AUTO_SHOW_CHALLENGE_ID));
    server(at);
    expectSocialOn('auto-show', 'challenges');
    expect(
      document.querySelector('[data-testid="pvp-incoming-label"]'),
      'precondition: the request is listed in the pvp root',
    ).not.toBeNull();
    expect(
      cursorMark(el('pvp-challenge-incoming')),
      'auto-show: the cursor is on the incoming request',
    ).toEqual(MARKED);
    expect(cursorMark(el('pvp-challenge-outgoing')), 'auto-show: and on nothing else').toEqual(
      UNMARKED,
    );
  });

  it('CTL8D-2-BOOT-RESPOND: with an incoming challenge, P then A opens a sheet Accept, Decline on Accept; Down, A on Decline asks the catalogued question with No selected and sends nothing; A on No closes the prompt and still sends nothing; A on Decline again, Up to Yes, A sends exactly one declineChallenge for that challenge; the legacy Accept button still sends acceptChallenge; and with a trade offered to the player U, A, A sends exactly one respondTrade accepting it', async () => {
    // WRONG IMPL KILLED: the legacy adapter (A does nothing on the Social frame); a sheet that
    // opens on Decline, or with a single action; a Decline that sends at once (skips the prompt)
    // or whose prompt defaults to Yes; a No that declines anyway; an Up that does not reach Yes;
    // a decline sent twice, as acceptChallenge or cancelChallenge, or for another id; a Social
    // frame that disables or swallows the legacy Accept button; and a trade answer sent as
    // accepted:false, as confirmTrade, for the wrong id, or only after a prompt.
    await bootReady();
    server(1000);
    opts.store.upsertMonster(partyMonster(PARTY_MONSTER_ID));
    server(1010);

    // --- a challenge: Decline asks Yes / No, No first -----------------------------------------
    opts.store.upsertChallenge(incomingChallenge(CHALLENGE_ID));
    server(1100);
    expect(stackNow(), 'precondition: the incoming challenge opened Social').toEqual(SOCIAL_STACK);
    press('Escape', 1110);
    expect(stackNow(), 'precondition: Start closed it').toEqual([WORLD_FRAME]);
    press('KeyP', 1200);
    expectSocialOn('P', 'challenges');
    expect(cursorMark(el('pvp-challenge-incoming')), 'P: the cursor is on the request').toEqual(
      MARKED,
    );
    expect(sheetShown(), 'P: no sheet at the open').toBe(false);
    expect(promptShown(), 'P: no prompt at the open').toBe(false);

    H.calls = [];
    press('Enter', 1210);
    expectAnswerSheet('A on the request', 'accept');
    expect(promptShown(), 'A on the request: no prompt yet').toBe(false);
    press('ArrowDown', 1220);
    expectAnswerSheet('Down', 'decline');
    press('Enter', 1230);
    expectDeclineChallengePrompt('A on Decline', 'no');
    expectAnswerSheet('the sheet beneath the prompt', 'decline');
    await flush();
    expect(H.calls, 'A on Decline only asks: nothing is sent').toEqual([]);

    press('Enter', 1240);
    expect(promptShown(), 'A on No closes the prompt').toBe(false);
    expectAnswerSheet('after No, the sheet stays on Decline', 'decline');
    await flush();
    expect(H.calls, 'No sends nothing').toEqual([]);

    press('Enter', 1250);
    expectDeclineChallengePrompt('A on Decline again', 'no');
    press('ArrowUp', 1260);
    expectDeclineChallengePrompt('Up', 'yes');
    await flush();
    expect(H.calls, 'moving to Yes sends nothing').toEqual([]);
    press('Enter', 1270);
    await flush();
    expect(H.calls, 'A on Yes declines that challenge, once').toEqual([
      { name: 'declineChallenge', args: { challengeId: CHALLENGE_ID } },
    ]);
    expect(promptShown(), 'after Yes: the prompt is gone').toBe(false);
    expect(sheetShown(), 'after Yes: back to the list').toBe(false);

    // The legacy Accept button in the pvp root stays directly clickable.
    H.calls = [];
    const acceptBtn = document.querySelector<HTMLButtonElement>('[data-testid="pvp-accept-btn"]');
    if (acceptBtn === null) throw new Error('precondition: the legacy Accept button is rendered');
    acceptBtn.click();
    await flush();
    expect(H.calls, 'the legacy Accept click sends acceptChallenge').toEqual([
      {
        name: 'acceptChallenge',
        args: { challengeId: CHALLENGE_ID, partyIds: [PARTY_MONSTER_ID] },
      },
    ]);

    // The request goes (the auto-show would re-open Social while it is pending), then Social closes.
    opts.store.removeChallenge(CHALLENGE_ID);
    server(1300);
    press('Escape', 1310);
    expect(stackNow(), 'precondition: Start closed Social').toEqual([WORLD_FRAME]);

    // --- a trade offered to the player: U, A, A accepts it -------------------------------------
    opts.store.upsertTradeOffer(waitingTrade(TRADE_ID));
    server(1400);
    expect(stackNow(), 'precondition: a trade opens nothing by itself').toEqual([WORLD_FRAME]);
    H.calls = [];
    press('KeyU', 1500);
    expectSocialOn('U', 'trades');
    expect(cursorMark(el('trade-status')), 'U: the cursor is on the offered trade').toEqual(MARKED);
    press('Enter', 1510);
    expectAnswerSheet('A on the trade', 'accept');
    expect(promptShown(), 'A on the trade: no prompt').toBe(false);
    await flush();
    expect(H.calls, 'A on the trade only opens the sheet').toEqual([]);
    press('Enter', 1520);
    await flush();
    expect(H.calls, 'U, A, A accepts that trade, once').toEqual([
      { name: 'respondTrade', args: { tradeId: TRADE_ID, accepted: true } },
    ]);
  });

  it('CTL8D-3-BOOT-HOTKEYS: with a trade offered to the player waiting in the store, U opens Social on Trades over the trade root, P on Challenges over the pvp root and L on Rankings over the leaderboard root, each with the four-tab strip in the shown root`s chrome and exactly its own tab selected', async () => {
    // WRONG IMPL KILLED: the legacy adapter (no strip is painted); an adapter that ignores the
    // requested tab and opens on the oldest waiting request's (P and L would open on Trades over
    // the trade root) or on the remembered tab (P would reopen on Trades, L on Challenges); and a
    // paint that selects the requested tab but shows another panel, or the reverse.
    await bootReady();
    server(1000);
    opts.store.upsertTradeOffer(waitingTrade(TRADE_ID));
    server(1010);
    expect(stackNow(), 'precondition: a waiting trade opens nothing by itself').toEqual([
      WORLD_FRAME,
    ]);

    const keys: ReadonlyArray<readonly [string, SocialTab]> = [
      ['KeyU', 'trades'],
      ['KeyP', 'challenges'],
      ['KeyL', 'rankings'],
    ];
    let at = 1100;
    for (const [code, tab] of keys) {
      press(code, at);
      expectSocialOn(code, tab);
      press('Escape', at + 10);
      expect(stackNow(), `${code}: precondition: Start closed Social`).toEqual([WORLD_FRAME]);
      at += 100;
    }
  });
});
