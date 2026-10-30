// @vitest-environment happy-dom
/**
 * main.battleRewards.test.ts: the booted KO-win payout lines (qf-17, QF17.1 and QF17.2).
 *
 * THE FEATURE. A win pays gold and XP SILENTLY on the server, in the same transaction that flips
 * the battle row terminal, so the client sees them as the DIFFERENCE between two consecutive store
 * batches: the wallet balance and each own monster's xp, before and after the batch in which the
 * player's latest battle turned `Ongoing` -> `SideAWins`. main.ts hands that payout to the battle
 * view, which shows it under the outcome banner as `[data-testid="battle-rewards"]`. The view's own
 * rules (what a line says, where the element sits) are proven in battleView.test.ts; the lines'
 * bytes in catalog.test.ts. This file proves the SHELL: which batch pair the payout is taken from,
 * who is paid, and when the lines are kept or dropped. It reads only what a player sees: the
 * rendered outcome banner and the reward lines, plus the recorded reducer calls.
 *
 * Every case drives the REAL store (`upsertWallet`, `upsertMonster`, `upsertBattle`, then
 * `flushBatch`, what connection.ts's batch flush does) of a freshly imported main.ts, mounted over
 * the real client/index.html shell with the REAL BattleView (main.accel.test.ts's pattern).
 * `onHydrated()` is signalled after `onReady()`: main.ts takes no payout baseline before the
 * connection's snapshot has been applied, so an unhydrated store is a different, tested state.
 *
 * Every negative case carries a positive control in the same fixture (a payout that DOES show), so
 * "no lines" cannot be the answer of a view that never shows any.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  connectionRecordingMock,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { WasmMoveInput } from './convert/convert';
import type { ConnectionOptions } from './net/connection';
import type {
  StoreBattle,
  StoreBattleMonster,
  StoreMonsterPub,
  StoreSpeciesRow,
} from './net/store';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued. */
  sends: [] as unknown[],
  /** Every other reducer call, oldest first, with the exact argument object it received. */
  calls: [] as Array<{ name: string; args: unknown }>,
}));

// wasm pkg: every name main.ts imports. Nothing here is faced or walked.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgWalkingMock({ interact: () => [] }));

// The connection: capture the options; every reducer records its call and resolves at once.
vi.mock('./net/connection', () => connectionRecordingMock(H));

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

// The renderer: init(mount) appends a focusable canvas so main.ts can resolve its world focus.
vi.mock('./render/world', () => worldRendererMock());

// --- harness ------------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

/** main.ts registers window/document listeners at MODULE scope: record each so teardown can detach
 *  it, or a second import leaves a live handler from a dead module instance. */
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

function teardown(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  raf.cb = null;
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
}

let opts: ConnectionOptions;
/** The clock of the next batch: every batch moves it on by 100 ms. */
let tick = 1000;

async function boot(): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  tick = 1000;
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  stubRaf();
  vi.resetModules();
  await import('./main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
}

/** A connected, HYDRATED session: the store holds the applied snapshot, as after a join. */
async function bootHydrated(): Promise<void> {
  await boot();
  opts.onReady(H.identity);
  opts.onHydrated();
}

const EID = 7n;
const OTHER_IDENTITY = 'cd'.repeat(32);
const WILD_IDENTITY = '0'.repeat(64);

/** One authoritative batch: the own player + character, flushed (every other row upserted before
 *  this call rides the same flush, as one transaction burst does). */
function server(t: number): void {
  clock.t = t;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    lastInputSeq: BigInt(H.sends.length),
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
    t,
  );
  opts.store.flushBatch();
}

// --- fixtures ----------------------------------------------------------------------------
const BATTLE_MONSTER: StoreBattleMonster = {
  speciesId: 1,
  affinity: 'Neutral',
  level: 5,
  currentHp: 20,
  maxHp: 20,
  statHp: 20,
  statAttack: 5,
  statDefense: 5,
  statSpeed: 5,
  statSpAttack: 5,
  statSpDefense: 5,
  knownSkillIds: [1],
  status: null,
};

/** A wild battle row for the booted player (the opponent is unowned: no opponent party). */
function wild(battleId: bigint, outcome: string): StoreBattle {
  return {
    battleId,
    playerIdentity: H.identity,
    opponentIdentity: WILD_IDENTITY,
    outcome,
    turnNumber: 1,
    sideA: { active: 0, team: [BATTLE_MONSTER] },
    sideB: { active: 0, team: [BATTLE_MONSTER] },
    partyMonsterIds: [1n],
    opponentMonsterIds: [],
    createdAtMs: 0n,
    weather: null,
  };
}

/** A player battle the booted player CHALLENGED: they are the row's `playerIdentity`, side A. */
function pvpChallenger(battleId: bigint, outcome: string): StoreBattle {
  return {
    ...wild(battleId, outcome),
    opponentIdentity: OTHER_IDENTITY,
    opponentMonsterIds: [2n],
  };
}

/** A player battle the booted player ACCEPTED: they are the row's `opponentIdentity`, side B, so
 *  the server's `SideBWins` is their win and the view reads it as Victory (own perspective). */
function pvpAccepter(battleId: bigint, outcome: string): StoreBattle {
  return {
    ...wild(battleId, outcome),
    playerIdentity: OTHER_IDENTITY,
    opponentIdentity: H.identity,
    partyMonsterIds: [2n],
    opponentMonsterIds: [1n],
  };
}

function species(id: number, name: string): StoreSpeciesRow {
  return {
    id,
    name,
    baseHp: 10,
    baseAttack: 5,
    baseDefense: 5,
    baseSpeed: 5,
    baseSpAttack: 5,
    baseSpDefense: 5,
    affinity: 'Neutral',
    learnableSkillIds: [],
  };
}

/** One own monster row: party slot `partySlot` (255 = boxed), `xp`, `nickname`. */
function mon(
  monsterId: bigint,
  partySlot: number,
  xp: number,
  nickname: string,
  speciesId = 1,
  currentHp = 10,
): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: H.identity,
    speciesId,
    nickname,
    level: 5,
    xp,
    currentHp,
    statHp: 10,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
    partySlot,
    tier: 0,
    essence: { Fire: 0, Water: 0, Plant: 0, Electric: 0, Earth: 0, Wind: 0, Light: 0, Dark: 0 },
    trustTier: 'Neutral',
    qualityTimeTier: 0,
    nutritionPct: 0,
    lastCareAtMs: 0n,
  };
}

interface Change {
  readonly species?: readonly StoreSpeciesRow[];
  readonly wallet?: bigint;
  readonly monsters?: readonly StoreMonsterPub[];
  readonly battle?: StoreBattle;
}

/** Deliver ONE batch carrying `change`: every row upserted, then one flush. No argument = a batch
 *  that changes nothing a payout reads (the player and character rows still ride it). */
function deliver(change: Change = {}): void {
  const { store } = opts;
  for (const row of change.species ?? []) store.upsertSpecies(row);
  if (change.wallet !== undefined) {
    store.upsertWallet({ ownerIdentity: H.identity, balance: change.wallet });
  }
  for (const m of change.monsters ?? []) store.upsertMonster(m);
  if (change.battle !== undefined) store.upsertBattle(change.battle);
  tick += 100;
  server(tick);
}

/** A reconnect as connection.ts performs it: the store emptied, then onReconnect(identity). */
function reconnect(): void {
  opts.store.reset();
  opts.onReconnect(H.identity);
}

const callsOf = (name: string): Array<{ name: string; args: unknown }> =>
  H.calls.filter((c) => c.name === name);

/** Let queued microtasks and zero-delay timers run (a click handler's promise chain). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

// --- what a player sees ------------------------------------------------------------------
const REWARDS = '[data-testid="battle-rewards"]';

/** Displayed unless the element or an ancestor has an inline `display: none`. */
const isShown = (el: Element): boolean => {
  for (let n: Element | null = el; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none') return false;
  }
  return true;
};

/** The reward lines on screen, one string per line. Fails loud when the view built no such
 *  element, so a missing feature is a red with its reason rather than an empty list. */
function rewardLines(): string[] {
  const el = document.querySelector<HTMLElement>(REWARDS);
  if (el === null) throw new Error(`${REWARDS} is not in the document: the battle view builds it`);
  return isShown(el) ? [...el.children].map((line) => line.textContent ?? '') : [];
}

/** The outcome banner's text while it is displayed, '' otherwise. */
function outcomeText(): string {
  const el = document.querySelector('[data-testid="outcome-text"]');
  return el !== null && isShown(el) ? (el.textContent ?? '') : '';
}

/** The battle screen's whole text (the header of a card names its species). */
function battleScreenText(): string {
  return document.querySelector('[data-testid="battle-title"]')?.parentElement?.textContent ?? '';
}

/** The battle screen is up (its title is displayed). */
function battleShown(): boolean {
  const title = document.querySelector('[data-testid="battle-title"]');
  return title !== null && isShown(title);
}

describe('main.ts booted: the KO-win payout lines (qf-17)', { sequential: true }, () => {
  afterEach(teardown);

  it('a KO win shows the gold the wallet gained in the batch that ended the battle, not the gold it gained earlier in the fight: 100, then an unrelated 150, then a winning 180 reads +30 gold, there as soon as the winning batch is flushed [QF17-1-WIRE-GOLD]', async () => {
    // WRONG IMPL KILLED: a payout taken against the balance at the battle's FIRST batch (+80, the
    // unrelated income in between is paid to the fight); against a zero balance (+180, the whole
    // wallet); a payout computed on a LATER tick or after an await (absent from the winning batch
    // itself); a diff taken against the previous batch of ANY kind rather than the previous batch's
    // balance (each batch re-baselines); and a feature that shows nothing (the Ongoing batches
    // carry no lines, the winning batch does).
    await bootHydrated();
    deliver({
      species: [species(1, 'Mosshorn')],
      wallet: 100n,
      battle: wild(5n, 'Ongoing'),
    });
    expect(outcomeText(), 'precondition: an Ongoing battle has no outcome banner').toBe('');
    expect(rewardLines(), 'nothing is paid mid-fight').toEqual([]);

    deliver({ wallet: 150n }); // an unrelated +50 (a settled trade) while the battle is Ongoing
    expect(rewardLines(), 'an unrelated income mid-fight is no payout').toEqual([]);

    deliver({ wallet: 180n, battle: wild(5n, 'SideAWins') });
    expect(outcomeText(), 'the outcome frame is up').toBe('Victory!');
    expect(rewardLines(), 'the winning batch itself carries the +30, no await needed').toEqual([
      '+30 gold',
    ]);
  });

  it('a player with no wallet row yet is paid their first win in full: nothing, then 30 reads +30 gold, and the next win shows only its own +45 [QF17-1-WIRE-FIRST-WIN]', async () => {
    // WRONG IMPL KILLED: a missing wallet row read as "wallet unknown" (no payout line for the
    // very first win of every new player: the server inserts the row lazily on that win); a diff
    // that needs both sides present; a first payout that is never re-baselined (the second win
    // shows +75, the whole balance, or +30 added to it); and a payout line that stays up from the
    // first fight (the second fight starts clean).
    await bootHydrated();
    deliver({ species: [species(1, 'Mosshorn')], battle: wild(1n, 'Ongoing') }); // no wallet row
    expect(rewardLines()).toEqual([]);

    deliver({ wallet: 30n, battle: wild(1n, 'SideAWins') });
    expect(outcomeText(), 'the outcome frame is up').toBe('Victory!');
    expect(rewardLines(), 'the first win, whose wallet row appears in the winning batch').toEqual([
      '+30 gold',
    ]);

    deliver({ battle: wild(2n, 'Ongoing') }); // the wallet row stays at 30
    expect(rewardLines(), 'the second fight starts with no lines').toEqual([]);

    deliver({ wallet: 75n, battle: wild(2n, 'SideAWins') });
    expect(outcomeText()).toBe('Victory!');
    expect(rewardLines(), 'the second win shows its own +45, not +75 and not +30').toEqual([
      '+45 gold',
    ]);
  });

  it('the payout stays as the winning batch showed it: a batch that changes nothing, an unrelated +500 that also re-renders the screen, leave +30 gold up, and a NEW battle that is won with no gains shows no lines [QF17-1-WIRE-NO-RETRIGGER]', async () => {
    // WRONG IMPL KILLED: a payout recomputed on every batch (the next no-op batch finds no
    // difference and clears the line, or an unrelated +500 replaces it with +500 gold); a payout
    // handed to the view once and then dropped (the re-render the species rename forces paints no
    // lines); a payout that outlives its battle (the next fight's Victory wears the old +30); a
    // payout invented for a win that gained nothing.
    await bootHydrated();
    deliver({ species: [species(1, 'Mosshorn')], wallet: 100n, battle: wild(5n, 'Ongoing') });
    deliver({ wallet: 130n, battle: wild(5n, 'SideAWins') });
    expect(rewardLines(), 'precondition (the positive control): the win shows +30').toEqual([
      '+30 gold',
    ]);

    deliver();
    expect(rewardLines(), 'a no-op batch leaves the shown payout').toEqual(['+30 gold']);

    // An unrelated +500 AND a species rename, which changes the battle screen's cards so the view
    // really re-renders in this batch (an unchanged screen is not re-rendered at all).
    deliver({ wallet: 630n, species: [species(1, 'Mossy')] });
    expect(battleScreenText(), 'precondition: the screen was re-rendered by this batch').toContain(
      'Mossy',
    );
    expect(outcomeText()).toBe('Victory!');
    expect(rewardLines(), 'an unrelated +500 changes nothing the screen says').toEqual([
      '+30 gold',
    ]);

    // A new battle: Ongoing shows no lines, and its win with no gains shows none either.
    deliver({ battle: wild(6n, 'Ongoing') });
    expect(rewardLines(), 'the next fight starts with no lines').toEqual([]);
    deliver({ battle: wild(6n, 'SideAWins') });
    expect(outcomeText(), 'the next fight is won').toBe('Victory!');
    expect(rewardLines(), 'a win that gained nothing shows no lines, not the last fight`s').toEqual(
      [],
    );
  });

  it('only a win the server pays shows lines: the challenger of a player battle sees +30 gold, but the accepter whose win the view reads as Victory, a loss and a flee, each with the same +30 in the wallet, show none [QF17-1-WIRE-ROLE-GATE]', async () => {
    // WRONG IMPL KILLED: a payout gated on the VIEW's perspective-flipped outcome (the accepter's
    // Victory, which the server did not pay, shows +30), or on the flipped playerIdentity; one with
    // no outcome gate (a loss or a flee "earns" the coincidental +30); one that never pays at all
    // (the two controls, the challenger's win before and a wild win after, still show it).
    await bootHydrated();
    interface Scenario {
      readonly label: string;
      readonly row: (outcome: string) => StoreBattle;
      readonly terminal: string;
      readonly banner: string;
      readonly lines: readonly string[];
    }
    const SCENARIOS: readonly Scenario[] = [
      {
        label: 'the challenger wins (control)',
        row: (o) => pvpChallenger(31n, o),
        terminal: 'SideAWins',
        banner: 'Victory!',
        lines: ['+30 gold'],
      },
      {
        label: 'the accepter wins (server side B wins)',
        row: (o) => pvpAccepter(32n, o),
        terminal: 'SideBWins',
        banner: 'Victory!',
        lines: [],
      },
      {
        label: 'a wild battle is lost',
        row: (o) => wild(33n, o),
        terminal: 'SideBWins',
        banner: 'Defeat...',
        lines: [],
      },
      {
        label: 'a wild battle is fled',
        row: (o) => wild(34n, o),
        terminal: 'Fled',
        banner: 'Got away safely!',
        lines: [],
      },
      {
        label: 'a wild battle is won (control after the refusals)',
        row: (o) => wild(35n, o),
        terminal: 'SideAWins',
        banner: 'Victory!',
        lines: ['+30 gold'],
      },
    ];
    let balance = 100n;
    deliver({ species: [species(1, 'Mosshorn')] });
    for (const s of SCENARIOS) {
      deliver({ wallet: balance, battle: s.row('Ongoing') });
      expect(rewardLines(), `${s.label}: nothing mid-fight`).toEqual([]);
      balance += 30n; // the same coincidental +30 in every scenario
      deliver({ wallet: balance, battle: s.row(s.terminal) });
      expect(outcomeText(), `${s.label}: the outcome frame is up`).toBe(s.banner);
      expect(rewardLines(), `${s.label}: the lines`).toEqual(s.lines);
    }
    expect(SCENARIOS, 'ANTI-VACUITY: two paid controls and three refusals').toHaveLength(5);
  });

  it('no payout is taken from a store that was not hydrated: a battle that ends in the first hydrated batch after a reconnect shows no lines, not the whole new balance, a terminal battle met on hydration shows none, and payouts resume on the next fight [QF17-1-WIRE-RESET]', async () => {
    // WRONG IMPL KILLED: a baseline taken from UNHYDRATED batches (the wallet view has not
    // delivered its row yet, so the dark wallet reads as an empty one and the first hydrated
    // batch pays the player their entire balance, +160 here); a payout baseline that survives the
    // reconnect; a gate that never reopens (the last fight still pays); and a feature that never
    // pays (the two hydrated controls).
    await bootHydrated();
    // Part 1, control: a hydrated fight pays.
    deliver({ species: [species(1, 'Mosshorn')], wallet: 100n, battle: wild(61n, 'Ongoing') });
    deliver({ wallet: 130n, battle: wild(61n, 'SideAWins') });
    expect(rewardLines(), 'control: the hydrated fight is paid').toEqual(['+30 gold']);

    // Part 2: a fight in progress when the link drops. The store is emptied and the reconnect's
    // first flush (UNHYDRATED) re-delivers the Ongoing battle but not yet the wallet row; the
    // snapshot lands (hydration), and the battle has ended meanwhile, wallet row and all.
    deliver({ wallet: 130n, battle: wild(62n, 'Ongoing') });
    expect(rewardLines()).toEqual([]);
    reconnect();
    deliver({ species: [species(1, 'Mosshorn')], battle: wild(62n, 'Ongoing') });
    expect(battleShown(), 'precondition: the surviving battle is on screen').toBe(true);
    expect(outcomeText(), 'precondition: and still Ongoing').toBe('');
    opts.onHydrated();
    deliver({ wallet: 160n, battle: wild(62n, 'SideAWins') });
    expect(outcomeText(), 'the surviving battle ended: its outcome frame is up').toBe('Victory!');
    expect(rewardLines(), 'no hydrated baseline, no payout (never +160)').toEqual([]);

    // Part 2b: a terminal battle that is already there when the store hydrates.
    reconnect();
    opts.onHydrated();
    deliver({ species: [species(1, 'Mosshorn')], wallet: 190n, battle: wild(63n, 'SideAWins') });
    expect(rewardLines(), 'a battle already over at hydration pays nothing').toEqual([]);

    // Part 3, control: the gate is open again for the next fight.
    deliver({ battle: wild(64n, 'Ongoing') });
    deliver({ wallet: 220n, battle: wild(64n, 'SideAWins') });
    expect(outcomeText()).toBe('Victory!');
    expect(rewardLines(), 'control: payouts resume after a reconnect').toEqual(['+30 gold']);
  });

  it('a winning batch pays its own gold however the screen was refreshed in between: a PvP action sent after the wallet row landed but before the winning batch is flushed does not swallow the +30, and a monster row whose xp cannot be read costs that fight its lines but not its Victory screen, nor the next fight its payout [QF17-1-WIRE-TOTAL]', async () => {
    // WRONG IMPL KILLED: part A, a payout baseline advanced by an out-of-band battle refresh (the
    // pre-send refresh of a PvP action runs between the SDK's eager wallet upsert and the batch
    // flush, so a baseline taken there already holds the new balance and the win pays 0); part B, a
    // payout computed inside the battle refresh with no isolation (a throw there leaves the player
    // looking at an Ongoing screen that never shows Victory), a throw left uncaught in the listener,
    // and a listener that stays dead after one throw (the next fight shows no lines).
    await bootHydrated();

    // ----- part A: the out-of-band refresh -----
    opts.store.upsertSkill({
      id: 1,
      name: 'Vine Lash',
      affinity: 'Plant',
      power: 40,
      accuracy: 95,
      pp: 20,
    });
    deliver({
      species: [species(1, 'Mosshorn')],
      wallet: 100n,
      battle: pvpChallenger(71n, 'Ongoing'),
    });
    const fight = document.querySelector<HTMLElement>('[data-testid="battle-command-fight"]');
    expect(fight, 'precondition: the battle screen has its Fight command').not.toBeNull();
    fight?.click();
    const cell = document.querySelector<HTMLElement>('button[data-battle-list="skills"]');
    expect(cell, 'precondition: Fight opened the PvP skill list').not.toBeNull();

    // The wallet row lands BEFORE the winning batch is flushed (the SDK upserts per row, the
    // batcher flushes a microtask later), and a PvP action sent right then refreshes the battle
    // screen out of band.
    opts.store.upsertWallet({ ownerIdentity: H.identity, balance: 130n });
    cell?.click();
    await flush();
    expect(callsOf('submitPvpAction'), 'precondition: the action was sent').toHaveLength(1);
    const waiting = document.querySelector('[data-testid="pvp-status"]');
    expect(
      waiting !== null && isShown(waiting),
      'precondition: the out-of-band refresh painted the pending banner',
    ).toBe(true);

    opts.store.upsertBattle(pvpChallenger(71n, 'SideAWins'));
    tick += 100;
    server(tick);
    expect(outcomeText(), 'part A: the outcome frame is up').toBe('Victory!');
    expect(rewardLines(), 'part A: the out-of-band refresh swallowed nothing').toEqual([
      '+30 gold',
    ]);

    // ----- part B: a payout read that throws -----
    const boom = new Error('qf-17: an xp that cannot be read');
    let armed = false;
    let armedHits = 0;
    const booby = mon(82n, 1, 5, 'Booby');
    Object.defineProperty(booby, 'xp', {
      enumerable: true,
      configurable: true,
      get: () => {
        if (armed) {
          armedHits += 1;
          throw boom;
        }
        return 5;
      },
    });
    deliver({ monsters: [mon(81n, 0, 10, 'Sparky'), booby], battle: wild(72n, 'Ongoing') });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    armed = true;
    deliver({
      wallet: 140n,
      monsters: [mon(81n, 0, 14, 'Sparky')],
      battle: wild(72n, 'SideAWins'),
    });
    armed = false;
    expect(armedHits, 'ANTI-VACUITY: the payout code read the unreadable xp').toBeGreaterThan(0);
    expect(outcomeText(), 'part B: the battle screen still refreshed, Victory shown').toBe(
      'Victory!',
    );
    expect(
      errorSpy.mock.calls.filter((args) =>
        args.some((arg) => arg === boom || String(arg).includes(boom.message)),
      ).length,
      'part B: the read failure was logged (by the payout code or by the flush that caught it)',
    ).toBeGreaterThanOrEqual(1);

    // The next fight is paid in full: one failure does not leave the payout dead.
    deliver({ battle: wild(73n, 'Ongoing') });
    deliver({
      wallet: 150n,
      monsters: [mon(81n, 0, 20, 'Sparky')],
      battle: wild(73n, 'SideAWins'),
    });
    expect(outcomeText()).toBe('Victory!');
    expect(rewardLines(), 'part B: the next fight shows its gold and its xp').toEqual([
      '+10 gold',
      'Sparky +6 XP',
    ]);
  });

  it('a win lists the XP only of the own monsters that gained it, in party-slot order with ties by monster id: one risen monster reads Sparky +12 XP alone, while an unchanged fainted one, an unchanged boxed one and a monster with no earlier row get no line [QF17-2-WIRE-XP]', async () => {
    // WRONG IMPL KILLED: a line for every own monster (unchanged ones read +0 XP); a monster that
    // first appears in the winning batch diffed against zero (+4 XP for a recruit); the xp amount
    // taken as the new total (22) or the level; lines in store insertion order, in name order, in
    // monster-id order, or in party-slot order with ties left in insertion order; and the gold
    // line printed (or an XP line dropped) when the wallet did not change.
    await bootHydrated();
    // Phase 1: one risen monster among the ones that must not be listed. No wallet change at all.
    deliver({
      species: [species(1, 'Mosshorn')],
      monsters: [
        mon(1n, 0, 10, 'Sparky'),
        mon(2n, 1, 5, 'Fainty', 1, 0), // fainted, xp unchanged
        mon(3n, 255, 3, 'Boxer'), // boxed, xp unchanged
      ],
      battle: wild(81n, 'Ongoing'),
    });
    deliver({
      monsters: [
        mon(1n, 0, 22, 'Sparky'), // 10 -> 22
        mon(4n, 2, 4, 'Newbie'), // no earlier row
      ],
      battle: wild(81n, 'SideAWins'),
    });
    expect(outcomeText(), 'the outcome frame is up').toBe('Victory!');
    expect(rewardLines(), 'exactly the one risen monster, and no gold line').toEqual([
      'Sparky +12 XP',
    ]);

    // Phase 2: the order. Inserted Abe (slot 1, id 30), Zoe (slot 0, id 20), Mia (slot 1, id 10):
    // slot 0 first, then the slot-1 tie by id (Mia before Abe) - neither insertion, name nor id order.
    deliver({
      monsters: [mon(30n, 1, 20, 'Abe'), mon(20n, 0, 10, 'Zoe'), mon(10n, 1, 0, 'Mia')],
      battle: wild(82n, 'Ongoing'),
    });
    deliver({
      wallet: 30n,
      monsters: [mon(30n, 1, 29, 'Abe'), mon(20n, 0, 15, 'Zoe'), mon(10n, 1, 3, 'Mia')],
      battle: wild(82n, 'SideAWins'),
    });
    expect(outcomeText()).toBe('Victory!');
    expect(rewardLines(), 'gold first, then party slot, then monster id').toEqual([
      '+30 gold',
      'Zoe +5 XP',
      'Mia +3 XP',
      'Abe +9 XP',
    ]);
  });

  it('an XP line names the monster by nickname first, then species name when the nickname is empty, then #id when the species name is empty or the species is unknown [QF17-2-WIRE-NAME-FALLBACK]', async () => {
    // WRONG IMPL KILLED: the species name preferred over the nickname; an empty nickname printed
    // as a blank name (" +2 XP"); `??` where `||` is needed (an empty nickname or an empty species
    // name never falls through); an unknown species printed as "undefined" or "Unknown (#3)"; the
    // fallback id taken from the species id (#2) or the list position instead of the monster id.
    await bootHydrated();
    deliver({
      species: [species(1, 'Mosshorn'), species(2, '')],
      monsters: [
        mon(51n, 0, 0, 'Sparky', 1), // nickname beats the species name
        mon(52n, 1, 0, '', 1), // empty nickname: the species name
        mon(53n, 2, 0, '', 2), // empty nickname, empty species name: #id
        mon(54n, 3, 0, '', 3), // empty nickname, unknown species: #id
      ],
      battle: wild(91n, 'Ongoing'),
    });
    deliver({
      monsters: [
        mon(51n, 0, 1, 'Sparky', 1),
        mon(52n, 1, 2, '', 1),
        mon(53n, 2, 3, '', 2),
        mon(54n, 3, 4, '', 3),
      ],
      battle: wild(91n, 'SideAWins'),
    });
    expect(outcomeText(), 'the outcome frame is up').toBe('Victory!');
    expect(rewardLines()).toEqual(['Sparky +1 XP', 'Mosshorn +2 XP', '#53 +3 XP', '#54 +4 XP']);
  });
});
