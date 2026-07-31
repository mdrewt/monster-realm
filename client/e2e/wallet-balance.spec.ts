import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// 11r-e (ux2b) — owner-scoped wallet readout e2e (ADR-0169; parent ADR-0154 D7).
//
// WHAT THIS PROVES (EARS 11r-e-6 / 11r-e-7 / 11r-e-8 / 11r-e-9)
// =============================================================
//   6. A player whose SERVER-SIDE balance is 50 opens the shop overlay and the client
//      renders #shop-balance VISIBLE, data-balance-state="known", text exactly `Gold: 50`
//      — both at FIRST PAINT (the render that accompanied the open) and settled.
//   7. While that overlay stays open and further store batches are applied, the readout
//      stays `Gold: 50` and never blanks to the `unknown` arm.
//   8. A SECOND identity with no wallet row of its own, opening the shop overlay WHILE
//      the first identity's wallet row exists on the server, renders #shop-balance
//      HIDDEN, data-balance-state="unknown", text '' — and the #shop-overlay subtree
//      contains no `Gold:` substring at all.
//   9. Both overlays are demonstrably POPULATED (shop title + >=1 priced buy row) — the
//      anti-vacuity precondition for 6 and 8.
//
// The whole point, in player terms: a cost has been listed in this shop since M13d and
// the player has never been able to see how much money they have (Drew's 2026-07-25
// playtest finding). This is the end-to-end proof of the fix, from the server-authoritative
// `#[view] my_wallet` over the PRIVATE `player_wallet` table all the way to the DOM.
//
// WHAT THIS DOES **NOT** PROVE — read before citing this file (ADR-0169 D8)
// ========================================================================
// 11r-e-8 gates the CLIENT-SIDE OWNER FILTER AND RENDER PATH. It does NOT gate
// server-side view scoping. `store.upsertWallet` (client/src/net/store.ts:985-987) stores
// whatever arrives UNCONDITIONALLY, and `ownWallet(identity)` (:992-995) filters on READ.
// So if the view were ever widened, B's client would RECEIVE AND STORE A's row and STILL
// render `unknown` — observably identical to correct behaviour, while another player's
// balance sits in B's browser memory (the ADR-0015 must-never-leak condition).
// Server-side scoping is owned by `evals/wallet-privacy.eval.mjs` [B/2c] and
// `server-module/src/economy_tests.rs::my_wallet_view_is_owner_scoped`.
// NOBODY MAY LATER CITE THIS SPEC AS THE PRIVACY GATE.
//
// RED REASON — AND ITS DELIBERATE ASYMMETRY (shop-npc.spec.ts:20-27 style)
// =======================================================================
// Verified by direct read this session: `my_wallet` appears NOWHERE in
// client/src/net/connection.ts (the `.subscribe([...])` array at :544-600 ends the shop
// block with the now-false comment "player_wallet is PRIVATE ... and produces no client
// subscription — excluded", :576-577); `playerWalletRowToStore` does not exist in
// client/src/net/rowConvert.ts; and `store.ownWallet(` occurs ZERO times in
// client/src/main.ts, so none of the three `buildShopViewModel*(` call sites (:1378,
// :1436, :1443) passes a wallet. `shopModel.balanceViewModel` therefore returns
// `{kind:'unknown'}` for EVERY player and `shopView.render` writes text '' + hidden +
// data-balance-state="unknown" (shopView.ts:97-100).
//
//   - The 11r-e-6 test (A) FAILS today: `Gold: 50` is never rendered.
//   - The 11r-e-7 test (A) FAILS today, for the same reason.
//   - The 11r-e-8 test (B) PASSES TODAY, **VACUOUSLY** — everyone gets `unknown`.
//     That asymmetry is exactly why 11r-e-9 (catalogue populated) is asserted inside the
//     SAME test as its mandatory positive control, why the SAME readBalance() helper is
//     used for A and B in ONE run against ONE module (so the machinery is shown to
//     DISTINGUISH the two states rather than being uniformly dead), and why B's check
//     also asserts, via `spacetime sql`, that A's wallet row provably exists server-side
//     at the moment B looks.
//   - Under `test.describe.serial` a failing test SKIPS the rest of the group, so in the
//     RED state expect: setup + the two quest preconditions PASS (the 50 gold is granted
//     server-side today — only the client display is missing), the 11r-e-6 test FAILS,
//     and the 11r-e-8 / 11r-e-7 tests report as SKIPPED, not passed.
//
// ---------------------------------------------------------------------------------------
// WORLD FACTS — every one re-derived from source this session, with its citation
// ---------------------------------------------------------------------------------------
// THE GOLD FAUCET IS DETERMINISTIC (no battle win, no RNG):
//   - game-core/content/quests/000-core.ron — `quest_001` "Find the Elder":
//     `start_conditions: []`, ONE step `trigger: Talk(npc_id: "elder_oak")`,
//     `reward: (xp: 0, items: [], currency: 50)`.
//   - game-core/content/dialogue_trees/000-core.ron — `elder_oak_talk` is a single
//     "greeting" node whose only choice, "I seek a quest.", has
//     `effects: [StartQuest("quest_001")]` and `next_node: None` (a successful advance
//     therefore ENDS the dialogue).
//   - server-module/src/npc.rs:269-277 — the `Talked` trigger fires in **`talk`** (Step 12),
//     NOT in `advance_dialogue` (which fires none).
//   - npc.rs:105-120 — `StartQuest` is idempotent against `done_quests`, so a stray extra
//     talk after completion cannot restart the quest or re-grant the reward.
//   - npc.rs:174-183 — the `QuestAdvance::QuestComplete` arm deletes the `player_quest`
//     row AND calls `grant_currency(ctx, owner, reward.currency)`; npc.rs:175 is the
//     module's ONLY `player_quest` delete.
//   ⇒ talk → choose "I seek a quest." → talk again ⇒ exactly 50 gold, zero RNG.
//   The battle-win faucet (~31 gold, `loser_bst/10`) was rejected by ADR-0169 D6: it needs
//   recruit.spec's grass shuttle, encounter loop, HP-restore loop and flee heuristics —
//   hundreds of lines of stochastic machinery for a NON-deterministic amount.
//
// A FRESH IDENTITY HAS NO WALLET ROW AT ALL: `join_game` grants a starter monster, no gold
//   and no items, and `economy.rs`'s `if amount == 0 { return; }` zero-guard prevents a
//   phantom row. So B's `unknown` is a REAL server state, not a client artifact — and
//   `Gold: 0` (the "broke, not dark" arm, ADR-0154 D6) is unreachable in this run and stays
//   unit-tested only (shopModel.test.ts [ux2-M2]).
//
// 50 GOLD BUYS NOTHING, so the balance is stable for the entire run:
//   game-core/content/shops/000-core.ron — shop 1 "Pebble Town Shop", stock priced
//   200 / 300 / 150. The cheapest sink is 150.
//   (Consequence, disclosed: the A/B differentiator is known-vs-unknown, not two different
//   amounts. A second identity with a DIFFERENT nonzero balance IS reachable via
//   `propose_trade`'s currency legs and is the strongest named follow-up — ADR-0169
//   accepted risk 2. It is deferred for cost, NOT because it is unreachable.)
//
// NPCs (game-core/content/npcs/000-core.ron) + npc.rs:19 `TALK_RANGE = 2` (Manhattan):
//   - `elder_oak`: zone 0, home (5,5), **wander_radius 2** ⇒ it MOVES; every interaction
//     with it needs a bounded retry loop (the dialogue.spec.ts machinery, CI-proven for
//     months). Its `interaction` field is absent ⇒ plain Dialogue.
//   - `tideglass_shopkeeper`: zone 1, home (8,1), **wander_radius 0** ⇒ npc_decide's pinned
//     stationary special case; NO retry loop is needed in zone 1 (shop-npc.spec.ts:38-42).
//     `interaction: Shop(1)`, tree `shopkeeper_greeting` ("Hello, customer!").
//
// MAP (game-core/content/zone_maps/000-core.ron) — zones 0 and 1 ship the IDENTICAL 10x7
//   layout; (4,3)/(5,3) are WALLS so x=6 is the only clean northward lane; warp at
//   zone 0 (5,5) <-> zone 1 (5,5). Verified tile-by-tile, all grass-free (an encounter roll
//   happens only on STEPPING ONTO a '~' tile, so a grass-free route cannot start a battle):
//     A: zone 0 spawn (1,1) → elder pocket (5,4) = E,E,E,E,E,S,S,S,W
//     A: (5,4) → warp = a single S onto (5,5). Characters and NPCs do NOT block each other
//        (game-core/src/world.rs:129 is tile-kind only), so a wandering elder_oak standing
//        on the warp cannot stall this step.
//     B: zone 0 spawn (1,1) → warp = E,E,E,E,E,S,S,S,S,W
//     both: zone 1 (5,5) → shopkeeper boundary tile (6,1) = N,E,N,N,N (Manhattan 2 from
//        (8,1) — the inclusive TALK_RANGE boundary).
//
// CROSS-ZONE NOISE IN THE IN-RANGE POLL: `__game().characters` carries NO zoneId and the
//   `character` subscription is globally unfiltered (connection.ts:545-550), so a player
//   standing in zone 1 can still hold zone-0 character rows. Checked: from the zone-1
//   tile (6,1), NO tile in elder_oak's zone-0 wander disc (Manhattan <= 2 of (5,5)) is
//   within Manhattan 2 — the nearest, (5,3), is 3 away. From the zone-0 pocket (5,4) the
//   zone-1 shopkeeper at (8,1) is 6 away. So the poll predicate below cannot be fooled at
//   either stop, and `interactAtNearest` re-filters by zone anyway (main.ts:1033-1053).
//
// THE RENDER PATH: client/src/ui/shopView.ts:97-100 is the SOLE writer of the balance node —
//   `textContent = known ? vm.balance.label : ''`, `hidden = !known`,
//   `dataset.balanceState = vm.balance.kind`. It runs on EVERY render(), unconditionally,
//   BEFORE the `no-shop` early return, and no CSS anywhere touches #shop-balance. The node
//   is CREATED by the ShopView constructor (:58-69), not by index.html, and starts with NO
//   data-balance-state attribute — so `data-balance-state="unknown"` POSITIVELY PROVES
//   render() ran. The label format is `Gold: ${amount}` (shopModel.ts:78).
//
// SHOP-OPEN PATH (precedent shop-npc.spec.ts:412-435): walk to (6,1) → KeyT →
//   #dialogue-node-text = "Hello, customer!" → click [data-shop-id] → #shop-overlay visible,
//   #dialogue-overlay hidden. This is a DEFERRED open through a dismissDialogue round trip
//   (main.ts:1367-1389, the UXD2-SHOPOPEN region).
//
// ---------------------------------------------------------------------------------------
// WHY A MUTATION-RECORD RECORDER, AND NOT JUST A RETRYING toHaveText (ADR-0169 D7 / R4)
// ---------------------------------------------------------------------------------------
// `movement_tick` is scheduled PER ZONE unconditionally, one row per zone_def, at
// `STEP_MS = 200` (server-module/src/lib.rs:110-139) — it does not depend on a player being
// present in that zone. elder_oak keeps wandering in zone 0 forever, every wander writes a
// `character` row, the subscription is globally unfiltered, and the M13d shop batch listener
// (main.ts:1427-1453) re-renders an OPEN overlay on every batch. So an open overlay is
// re-rendered roughly every 200 ms WITH NO PLAYER INPUT, and a retrying
// `toHaveText('Gold: 50')` cannot distinguish a correct implementation from one that
// patched only the batch-listener call site (:1436) and blanks on open.
//
// Worse: `store.flushBatch` (store.ts:589-602) invokes batch listeners SYNCHRONOUSLY in
// registration order, and the deferred-open listener (:1345) is registered BEFORE the shop
// listener (:1427). In a `:1436`-only patch the open therefore goes
//   render(no wallet) → blank  →  show()  →  render(wallet) → `Gold: 50`
// all inside ONE synchronous turn, before any MutationObserver callback or paint. A latch
// that merely READS the DOM when the overlay becomes visible would see the settled
// `Gold: 50` and pass. The recorder below therefore keeps an ORDERED LOG of mutation
// RECORDS — each `childList` record CARRIES the text that was written in its `addedNodes`,
// so the transient blank that precedes `show()` is recoverable verbatim. That is the one
// assertion no source scan and no polled matcher can fake.
//
// The first-paint channel is the TEXT one ONLY (ADR-0169 D7, tightened during the 11r-e
// review — deliberate, and strictly stronger, not a weakening). shopView.ts:97-100 derives
// text, `hidden` and `dataset.balanceState` from ONE boolean in three adjacent statements,
// so per render the text and the state are equivalent; but recovering a written ATTRIBUTE
// value requires chaining the NEXT record's `oldValue` and falling back to the LIVE DOM
// when there is none — the settled-DOM read this whole apparatus exists to avoid, which
// could only ever have turned a red into a green. See readFirstPaint. The sticky latches
// still read `data-balance-state` records' `oldValue` DIRECTLY (no chaining, no fallback)
// and are unaffected.
//
//   patched sites | settled toHaveText | FIRST PAINT | "ever unknown" latch | verdict
//   --------------|--------------------|-------------|----------------------|---------
//   all 3         | pass               | pass        | pass                 | correct
//   :1378 only    | FAIL (11r-e-7)     | pass        | FAIL                 | caught
//   :1436 only    | **pass**           | **FAIL**    | **FAIL**             | caught here only
//   :1443 only    | FAIL               | FAIL        | FAIL                 | caught
//
// (main.ts:1443, the unbound arm, is unreachable at runtime — the overlay only ever opens
// bound — so the behavioural witness covers 2 of the 3 sites and the count tooth in
// main.wiring.test.ts covers the third. Conversely 11r-e-3's `batcher.schedule()` and
// 11r-e-3b's no-`onDelete` are structurally unreachable by ANY e2e. Both surfaces are
// load-bearing; neither may be cut as "redundant" — ADR-0169 Consequences.)
//
// The same recorder also provides:
//   - a RENDER COUNTER (writes to #shop-balance) for 11r-e-7. The naive witness — "B's
//     character moved" — proves NOTHING about the shop listener: character rows are written
//     by the row callback directly, and main.ts:1429-1452 wraps the listener body in
//     try/catch, so a dead listener still shows movement next to a stale DOM.
//   - a STICKY "ever known" LATCH for B. A spot read cannot see a leak that arrives later,
//     and `store.upsertWallet` is unconditional, so a delayed foreign row would be stored
//     silently. The latch is asserted at B's check AND again at the end of the run.
//   - the MIRROR "ever unknown" LATCH for A. 11r-e-7's "WHILE the overlay remains open ...
//     SHALL NOT blank" is a claim about a whole INTERVAL; a spot read or a retrying matcher
//     can only sample it, and a blank that lands between two samples is invisible to both.
// One recorder script is installed on BOTH contexts (it is a pure observer; the fields that
// do not apply to a side are simply unread) — dialogue.spec.ts:242-273 addInitScript idiom.
//
// ---------------------------------------------------------------------------------------
// ANTI-PATTERNS OBSERVED HERE (each is a real trap in this repo)
// ---------------------------------------------------------------------------------------
//  1. The balance is NEVER read from `window.__game()`. Slice 11r-b exists precisely
//     because a DEV-gated hook made an e2e green while the production path was broken.
//     Using addInitScript to OBSERVE THE DOM is fine; reading store state through a debug
//     hook is not. (`__game()` is used only for tiles/zone/presence, as every walk does.)
//  2. B's overlay is NEVER asserted to lack the substring `50` — a catalogue price is 150.
//     The negative is: #shop-balance textContent === '' + data-balance-state="unknown",
//     plus no `Gold:` anywhere in #shop-overlay.
//  3. The `Gold:`-absence check uses **textContent**, never innerText: #shop-balance is
//     `hidden`, and innerText would omit it, making the exclusion vacuous.
//  4. No fixed sleeps — every wait polls a DOM or `__game()` predicate with a bounded timeout.
//  5. Physical key codes only: page.keyboard.press('KeyT'), never 't'.
//  6. Exact-presence discipline: two contexts ⇒ presenceCount === 2 on BOTH pages in
//     beforeAll, and browser.close() in afterAll, or the NEXT spec file's presence wait
//     hangs (playwright.config.ts `workers: 1`).
//  7. dialogue.spec.ts / shop-npc.spec.ts are NOT imported from and NOT modified (frozen
//     regression nets). Their snap/ready/stepOne/walk/talkUntilOpen helpers are
//     re-implemented here verbatim-in-spirit — the shop-npc.spec.ts:44-46 precedent.
//
// ---------------------------------------------------------------------------------------
// FLAKE BUDGET
// ---------------------------------------------------------------------------------------
// Zero RNG by construction: no grass, no encounters, no recruit rolls, no heals, no
// battles. The ONLY stochastic element is elder_oak's wander, handled by the two bounded
// loops below. Expected wall clock: ~4-6 min (about 30 steps at well under 1 s each, four
// dialogue round trips, and three `spacetime sql` invocations — a fourth only on the retry
// escape valve). Worst case under the declared per-test timeouts (120 + 300 + 300 + 240 +
// 240 + 120 s): ~22 min.
// `just e2e` is a merge gate for every future slice. If a bound proves tight, RAISE IT WITH
// A WRITTEN JUSTIFICATION (the MAX_ENCOUNTERS precedent, recruit.spec.ts:97-123) — never
// weaken an assertion. The deflake lever of last resort is running A's and B's walks
// concurrently (Promise.all).
// HONEST NOVELTY NOTE: the quest-COMPLETION path is NEW to e2e. dialogue.spec.ts:385-451
// proves talk → advance → StartQuest and asserts the quest STILL ACTIVE at step 0;
// `quest_001` appears in no other spec, and no spec has ever driven
// `QuestComplete → grant_currency`. The bounded-loop machinery it reuses is CI-proven; the
// completion assertion itself is not yet.

// ---------------------------------------------------------------------------------------
// Snapshot shape — mirrors snapshot() in client/src/main.ts (structured-clone boundary;
// the type system cannot check across page.evaluate, so keep this in sync by hand).
// ---------------------------------------------------------------------------------------
interface Tile {
  x: number;
  y: number;
}

interface WalletSnap {
  identity: string;
  ownEntityId: string | null;
  ownAuthTile: Tile | null;
  presenceCount: number;
  characters: { entityId: string; tileX: number; tileY: number }[];
  map: { zone_id: number };
  ongoingBattle: { battleId: string; outcome: string } | null;
}

type GameWindow = { __game: () => WalletSnap };

/** One recorded DOM mutation on the shop overlay / balance node. `old` is the
 *  MutationRecord's attributeOldValue; `text` is the text a childList record ADDED. */
interface ShopLogEntry {
  k: string;
  old: string | null;
  text: string;
}

const snap = (p: Page): Promise<WalletSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as GameWindow).__game();
    return {
      identity: g.identity,
      ownEntityId: g.ownEntityId,
      ownAuthTile: g.ownAuthTile,
      presenceCount: g.presenceCount,
      characters: g.characters,
      map: { zone_id: g.map.zone_id },
      ongoingBattle: g.ongoingBattle,
    };
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => WalletSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

/** One step + a bounded wait for the AUTHORITATIVE tile to change. Every route in this
 *  file is grass-free by construction (see WORLD FACTS), so a battle here means the map
 *  or the route changed — fail loud with a pointer at the derivation instead of a
 *  mysterious timeout. */
async function stepOne(p: Page, dir: string, from: Tile): Promise<void> {
  await p.evaluate(
    (d) => (window as unknown as { __game: () => { step: (x: string) => void } }).__game().step(d),
    dir,
  );
  const result = await p.waitForFunction(
    (args: { fromX: number; fromY: number }) => {
      const g = (window as unknown as GameWindow).__game();
      if (g.ongoingBattle !== null) return 'battle';
      if (
        g.ownAuthTile !== null &&
        (g.ownAuthTile.x !== args.fromX || g.ownAuthTile.y !== args.fromY)
      ) {
        return 'moved';
      }
      return false;
    },
    { fromX: from.x, fromY: from.y },
    { timeout: 8_000 },
  );
  const outcome = (await result.jsonValue()) as 'moved' | 'battle';
  if (outcome === 'battle') {
    throw new Error(
      `wallet-balance.spec walk: unexpected wild battle stepping ${dir} from (${from.x},${from.y}) — ` +
        'every route here is grass-free by construction; re-derive it from the WORLD FACTS ' +
        'header against game-core/content/zone_maps/000-core.ron',
    );
  }
}

/** Walk a sequence of directions, re-reading the authoritative tile before each step. */
async function walk(p: Page, dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    const g = await snap(p);
    if (g.ownAuthTile === null) throw new Error('walk: lost the own authoritative tile');
    await stepOne(p, dir, g.ownAuthTile);
  }
}

/** Server TALK_RANGE (npc.rs:19) — Manhattan. Mirrored here for the poll predicate. */
const TALK_RANGE = 2;
/** KeyT retries. Each attempt first POLLS (bounded, no fixed sleep) until some
 *  non-player character is within TALK_RANGE of the own authoritative tile, then presses
 *  KeyT once. A press can still lose the race against a wandering elder_oak (up to 1 tile
 *  per 200 ms tick between the poll and the server-side range check), so retries are
 *  bounded. Against the zone-1 shopkeeper (wander_radius 0, pinned) attempt 1 always wins.
 *  SIX, not dialogue.spec.ts's 20: from the pocket (5,4), 6 of elder_oak's ~8 reachable
 *  wander tiles are in range, so per-press success is high and the tail is short — while
 *  20 attempts would cost 20 x (20 s poll + 2 s wait) = ~440 s, i.e. MORE than the whole
 *  300 s phase budget, so those attempts could never actually be spent. 6 x 22 s = 132 s
 *  is a bound the enclosing budget can honour. */
const MAX_TALK_ATTEMPTS = 6;

async function talkUntilOpen(p: Page, playerEntityIds: readonly string[]): Promise<void> {
  const overlay = p.locator('#dialogue-overlay');
  for (let attempt = 0; attempt < MAX_TALK_ATTEMPTS; attempt++) {
    await p.waitForFunction(
      (args: { ownIds: readonly string[]; range: number }) => {
        const g = (window as unknown as GameWindow).__game();
        const own = g.ownAuthTile;
        if (own === null) return false;
        // NPC = any character row that is neither player's own entity (exact-presence
        // discipline: this suite owns the whole 2-player world under workers: 1).
        return g.characters
          .filter((c) => !args.ownIds.includes(c.entityId))
          .some((c) => Math.abs(c.tileX - own.x) + Math.abs(c.tileY - own.y) <= args.range);
      },
      { ownIds: playerEntityIds, range: TALK_RANGE },
      { timeout: 20_000 },
    );
    await p.keyboard.press('KeyT'); // physical-code form
    const opened = await overlay
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
    // Lost the race (the NPC stepped out of range before the server processed `talk`, or
    // the reducer rejected silently) — the loop re-polls and re-presses.
  }
  throw new Error(
    `talkUntilOpen: #dialogue-overlay did not open after ${MAX_TALK_ATTEMPTS} KeyT attempts`,
  );
}

// ---------------------------------------------------------------------------------------
// The recorder (installed via addInitScript BEFORE any app script runs, on BOTH contexts).
// A PURE OBSERVER of the DOM — never a source of truth about store state (anti-pattern 1).
// All analysis lives in the assertions below, so this stays dumb and auditable.
// ---------------------------------------------------------------------------------------
const installShopBalanceRecorder = (): void => {
  const w = window as unknown as {
    __mrRecorderInstalled?: boolean;
    __mrShopLog?: ShopLogEntry[];
    __mrBalanceWrites?: number;
    __mrBalanceEverKnown?: boolean;
    __mrBalanceEverUnknown?: boolean;
  };
  w.__mrRecorderInstalled = false;
  w.__mrShopLog = [];
  w.__mrBalanceWrites = 0;
  w.__mrBalanceEverKnown = false;
  w.__mrBalanceEverUnknown = false;

  // The log is capped: an open overlay is re-rendered ~5x/second forever (movement_tick),
  // and only the PREFIX up to the first "overlay became visible" record is analysed. No
  // shop render happens at all before the open (the batch listener early-returns while the
  // overlay is hidden, main.ts:1428), so the open sequence is always at the very front.
  // The write counter and the two sticky latches below are NOT capped.
  const LOG_CAP = 400;
  const push = (k: string, old: string | null, text: string): void => {
    const log = w.__mrShopLog;
    if (log !== undefined && log.length < LOG_CAP) log.push({ k, old, text });
  };
  const latchCheck = (): void => {
    const bal = document.getElementById('shop-balance');
    if (bal === null) return;
    const state = bal.getAttribute('data-balance-state');
    if (state === 'known' || (bal.textContent ?? '') !== '') w.__mrBalanceEverKnown = true;
    // The mirror latch, asserted on the BUYER: `unknown` is a legitimate state only
    // BEFORE any shop render (when the attribute is absent, not 'unknown'), so once a
    // wallet-owning player has opened the shop, a single 'unknown' write anywhere is a
    // blank the polling matchers may never happen to observe.
    if (state === 'unknown') w.__mrBalanceEverUnknown = true;
  };
  const arm = (): void => {
    const overlay = document.getElementById('shop-overlay');
    if (overlay === null) {
      // #shop-overlay is static markup in index.html, but at document-start the body is
      // not parsed yet. Retry until it exists — this arms during parsing, long before
      // main.ts (a deferred module script) constructs ShopView and creates #shop-balance.
      setTimeout(arm, 25);
      return;
    }
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as Element;
        if (r.type === 'attributes' && el.id === 'shop-overlay' && r.attributeName === 'style') {
          push('overlay', r.oldValue, '');
        } else if (el.id === 'shop-balance') {
          if (r.type === 'attributes' && r.attributeName === 'data-balance-state') {
            // Deliberately NOT pushed into the log: the first-paint reconstruction reads
            // the TEXT channel only (see readFirstPaint). data-balance-state is still
            // OBSERVED — the two sticky latches and the write counter live here.
            w.__mrBalanceWrites = (w.__mrBalanceWrites ?? 0) + 1;
            // Sticky latches, transient-proof: this write REPLACED the recorded value,
            // so a state that existed only between two synchronous renders is still seen.
            if (r.oldValue === 'known') w.__mrBalanceEverKnown = true;
            if (r.oldValue === 'unknown') w.__mrBalanceEverUnknown = true;
          } else if (r.type === 'childList') {
            // `textContent = x` replaces the child text node wholesale, so addedNodes IS
            // the value written at that moment (and is empty for `textContent = ''`).
            let text = '';
            for (const n of Array.from(r.addedNodes)) text += n.textContent ?? '';
            push('text', null, text);
            w.__mrBalanceWrites = (w.__mrBalanceWrites ?? 0) + 1;
            if (text !== '') w.__mrBalanceEverKnown = true;
          }
        }
        // Every other record in the subtree (the for-sale / inventory list rebuilds) is
        // dropped without being pushed, so it cannot crowd out the open sequence.
      }
      latchCheck();
    });
    obs.observe(overlay, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['style', 'data-balance-state'],
    });
    setInterval(latchCheck, 100); // belt, mirroring dialogue.spec.ts's latch
    latchCheck();
    w.__mrRecorderInstalled = true;
  };
  arm();
};

interface FirstPaint {
  installed: boolean;
  logLength: number;
  openIndex: number;
  /** #shop-balance textContent as written by the render that immediately PRECEDED show().
   *  `null` = no text was written to the balance node at ALL before the overlay went
   *  visible, which is itself the `:1436`-only signature (see readFirstPaint). */
  text: string | null;
  liveText: string;
}

/** Reconstruct the balance TEXT as it stood at the instant #shop-overlay became visible.
 *
 *  TEXT ONLY, deliberately (ADR-0169 D7, tightened during the 11r-e review). shopView.ts:97-100
 *  derives `textContent`, `hidden` and `dataset.balanceState` from ONE boolean in three
 *  adjacent statements, so within any SINGLE render `textContent === 'Gold: 50'` ⟺
 *  `balanceState === 'known'` — the state channel carried no information the text channel
 *  lacks. It was also strictly weaker: a childList record CARRIES the written text in
 *  `addedNodes` (no chaining), whereas recovering a written ATTRIBUTE value needs the next
 *  record's `oldValue` and falls back to the LIVE DOM when there is no next record — which
 *  is exactly the read-the-settled-DOM anti-pattern this recorder exists to avoid, and
 *  would have silently converted a `:1436`-only FAIL into a PASS if it ever fired.
 *  The text channel alone catches that patch: its pre-`show()` render writes '' (or, on a
 *  never-yet-rendered node, produces no childList record at all), so `text` comes back ''
 *  or `null` and the assertion is red either way. The two sticky latches read `r.oldValue`
 *  DIRECTLY and are unaffected. */
const readFirstPaint = (p: Page): Promise<FirstPaint> =>
  p.evaluate(() => {
    const w = window as unknown as {
      __mrRecorderInstalled?: boolean;
      __mrShopLog?: ShopLogEntry[];
    };
    const log = w.__mrShopLog ?? [];
    const bal = document.getElementById('shop-balance');
    const liveText = bal === null ? '' : (bal.textContent ?? '');

    // The transition to VISIBLE is the style write whose OLD value hid the overlay.
    // (index.html ships `style="display:none"`; a programmatic hide serialises as
    // `display: none;` — both collapse to `display:none` once spaces are removed.)
    const openIndex = log.findIndex(
      (e) => e.k === 'overlay' && (e.old ?? '').split(' ').join('').includes('display:none'),
    );

    // The LAST text written before that transition (overwrite-as-you-go, so no indexing).
    let text: string | null = null;
    if (openIndex >= 0) {
      for (const e of log.slice(0, openIndex)) {
        if (e.k === 'text') text = e.text;
      }
    }
    return {
      installed: w.__mrRecorderInstalled === true,
      logLength: log.length,
      openIndex,
      text,
      liveText,
    };
  });

const readBalanceWrites = (p: Page): Promise<number> =>
  p.evaluate(() => (window as unknown as { __mrBalanceWrites?: number }).__mrBalanceWrites ?? -1);

const readEverKnown = (p: Page): Promise<unknown> =>
  p.evaluate(() => (window as unknown as { __mrBalanceEverKnown?: unknown }).__mrBalanceEverKnown);

const readEverUnknown = (p: Page): Promise<unknown> =>
  p.evaluate(
    () => (window as unknown as { __mrBalanceEverUnknown?: unknown }).__mrBalanceEverUnknown,
  );

interface BalanceReading {
  state: string | null;
  text: string;
  hidden: boolean;
  overlayText: string;
}

/** THE SAME reading for both identities (vacuity argument (i)): one helper, one run, one
 *  module — it must return known/`Gold: 50` for A and unknown/'' for B, which is what
 *  makes B's negative a demonstration that the machinery DISTINGUISHES the states rather
 *  than being uniformly dead. `overlayText` is textContent (never innerText, which would
 *  silently drop the `hidden` balance node and make the `Gold:` exclusion vacuous). */
const readBalance = (p: Page): Promise<BalanceReading> =>
  p.evaluate(() => {
    const bal = document.getElementById('shop-balance');
    const ov = document.getElementById('shop-overlay');
    return {
      state: bal === null ? null : bal.getAttribute('data-balance-state'),
      text: bal === null ? '' : (bal.textContent ?? ''),
      hidden: bal === null ? true : bal.hidden,
      overlayText: ov === null ? '' : (ov.textContent ?? ''),
    };
  });

// ---------------------------------------------------------------------------------------
// Server truth via `spacetime sql` (precedent: recruit.spec.ts:934-979, pvp-full.spec.ts:612-646,
// rename.spec.ts:88-110). `player_wallet` is PRIVATE, but the CLI runs as the module OWNER,
// which can still read the table directly (ADR-0087:100 — the closed channel is client
// SUBSCRIPTIONS, not owner queries). Failures are HARD failures, never warn-and-continue.
//
// ⚠ EVERY WALLET ASSERTION MUST BE IDENTITY-SCOPED. `global-setup.ts` republishes with
// --delete-data ONCE PER RUN, `workers: 1`, and 15 spec files share that one database;
// this file is 14th alphabetically. By the time it runs, `recruit.spec.ts` has won wild
// battles (battle.rs:1074 pays `bst/10` per KO, accumulating) and `dialogue.spec.ts`'s
// advance-retry path can itself complete quest_001 for exactly 50. So `player_wallet` is
// NOT a one-row table here, and a substring test like `output.includes('50')` passes on
// ANY foreign balance containing "50" (50 / 150 / 250 / 502 / …) while A's own row reads 0.
// The parse below therefore looks up A's row BY IDENTITY and asserts THAT row's balance.
//
// Only `server`/`db`/`query` are interpolated into the shell string and all three are
// charset-validated first (literal regexes only — never new RegExp(dynamic)).
// ---------------------------------------------------------------------------------------
function sqlQuery(query: string, label: string): string {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  if (!/^[A-Za-z0-9:/._-]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(
      `${label}: STDB_SERVER/VITE_STDB_DB failed charset validation: ${server} ${db}`,
    );
  }
  // Defense in depth: every call site passes a literal, and this keeps it that way —
  // no quote, backtick, $ or ; can reach the shell through the query slot.
  if (!/^[A-Za-z0-9_ *]+$/.test(query)) {
    throw new Error(`${label}: refusing to run a non-literal-shaped sql query: ${query}`);
  }
  try {
    return execSync(`spacetime sql -s ${server} ${db} "${query}"`, {
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch (err) {
    throw new Error(
      `${label}: spacetime sql could not run (CLI/infra failure, not a row mismatch): ` +
        `${(err as Error).message}`,
    );
  }
}

/** lowercase + strip a leading '0x'. `spacetime sql` renders Identity as '0x' + 64
 *  lowercase hex (ADR-0121 D1, resolved empirically); `__game().identity` is the SDK's
 *  `Identity.toHexString()`. Normalising both ends makes the comparison prefix-agnostic.
 *  (ranked-forfeit.spec.ts / rename.spec.ts:77-84 precedent.) */
function normalizeIdentity(id: string): string {
  let s = id.toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  return s;
}

/** Parse `spacetime sql` stdout (the pinned 2.6.0 CLI has no --json mode) into row
 *  objects keyed by column name. Fixed-width pipe table: header, a `-+-` separator, then
 *  one line per row; header + separator + zero rows is a valid EMPTY result.
 *  Re-implemented verbatim-in-spirit from scripts/playtest-report.mjs:113-138 (that file is
 *  a repo-root .mjs outside client/tsconfig's include, and its own eval pins its behaviour).
 *  An unrecognised shape THROWS rather than returning [] — a silent [] would turn every
 *  identity lookup below into a vacuous "no such row". */
function parseSqlTable(stdout: string, label: string): Record<string, string>[] {
  // shift() (rather than [0]/[1]) so the undefined-ness is in the type under every
  // tsconfig, with or without noUncheckedIndexedAccess; what remains in `lines` after the
  // two shifts is exactly the data rows.
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const header = lines.shift();
  const separator = lines.shift();
  if (header === undefined || separator === undefined || !/^[-+]+$/.test(separator.trim())) {
    throw new Error(
      `${label}: unrecognised \`spacetime sql\` table shape (expected a header line then a ` +
        `-+- separator). Got: ${stdout.slice(0, 400)}`,
    );
  }
  const columns = header.split('|').map((c) => c.trim());
  return lines.map((line) => {
    const cells = line.split('|').map((c) => c.trim());
    const row: Record<string, string> = {};
    columns.forEach((col, i) => {
      row[col] = cells[i] ?? '';
    });
    return row;
  });
}

/** The `player_wallet` balance cell for ONE identity, or undefined when that identity owns
 *  no row. This is the ONLY wallet reader in this file: every assertion is scoped to a row
 *  the test itself created, never to the shared table's contents (see the ⚠ note above). */
function walletBalanceFor(identityHex: string, label: string): string | undefined {
  const rows = parseSqlTable(sqlQuery('SELECT * FROM player_wallet', label), label);
  const wanted = normalizeIdentity(identityHex);
  const row = rows.find((r) => normalizeIdentity(r.owner_identity ?? '') === wanted);
  return row === undefined ? undefined : row.balance;
}

/** Open the quest log, poll for `wanted`-ness of `questId`, close it again.
 *  ANTI-VACUITY: a quest log that never OPENED must not read as "the quest is gone", so
 *  the visibility of #quest-log-overlay is asserted before the list is read. KeyQ is
 *  guarded on "no other overlay visible" (main.ts:944-957), so callers must dismiss the
 *  dialogue overlay first. */
async function questLogShows(
  p: Page,
  questId: string,
  wanted: boolean,
  timeout: number,
): Promise<boolean> {
  const log = p.locator('#quest-log-overlay');
  await p.keyboard.press('KeyQ');
  await expect(
    log,
    'KeyQ must open #quest-log-overlay — a log that never opened would make the ' +
      '"quest_001 has left the log" reading VACUOUS (and KeyQ is guarded on no other ' +
      'overlay being visible, so an undismissed dialogue overlay lands here)',
  ).toBeVisible({ timeout: 15_000 });
  const held = await p
    .waitForFunction(
      (args: { q: string; want: boolean }) => {
        const list = document.getElementById('quest-log-list');
        if (list === null) return false;
        return (list.textContent ?? '').includes(args.q) === args.want;
      },
      { q: questId, want: wanted },
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
  await p.keyboard.press('Escape');
  await expect(log).toBeHidden({ timeout: 15_000 });
  return held;
}

/** Grass-free, warp-free: A's zone 0 spawn (1,1) → elder pocket (5,4). */
const A_TO_ELDER: readonly string[] = [
  'East',
  'East',
  'East',
  'East',
  'East', // (6,1)
  'South',
  'South',
  'South', // (6,4)
  'West', // (5,4) — Manhattan 1 from elder_oak's home (5,5); never steps on the warp
];
const ELDER_POCKET: Tile = { x: 5, y: 4 };
/** A: (5,4) → (5,5). That single step IS the warp to zone 1 (5,5). */
const A_TO_WARP: readonly string[] = ['South'];
/** B: zone 0 spawn (1,1) → the warp tile (5,5). B presses NO key in zone 0 — it must never
 *  talk to elder_oak (a second quest_001 completion would give B 50 gold and destroy the
 *  whole 11r-e-8 premise). */
const B_TO_WARP: readonly string[] = [
  'East',
  'East',
  'East',
  'East',
  'East', // (6,1)
  'South',
  'South',
  'South', // (6,4)
  'South', // (6,5)
  'West', // (5,5) — WARP → zone 1 (5,5)
];
/** Zone 1: the warp landing (5,5) → the shopkeeper boundary tile (6,1). Do NOT "simplify"
 *  this to N,N,N,N — (4,3)/(5,3) are WALLS (shop-npc.spec.ts:88-97). */
const ZONE1_TO_SHOPKEEPER: readonly string[] = ['North', 'East', 'North', 'North', 'North'];
const SHOP_TILE: Tile = { x: 6, y: 1 };

const QUEST_ID = 'quest_001';
const QUEST_CHOICE = 'I seek a quest.';
const SHOPKEEPER_GREETING = 'Hello, customer!';
const SHOP_NAME = 'Pebble Town Shop';
const EXPECTED_BALANCE_TEXT = 'Gold: 50';
/** Bounded retries per quest phase. Elder_oak wanders, so a talk or an advance can be
 *  rejected as walked_away and the phase must be able to try again.
 *  ARITHMETIC, stated honestly: an attempt normally costs ~8 s (one talk round trip, one
 *  dismiss, one quest-log read), so the expected phase is ~10-20 s inside a 300 s budget.
 *  Its THEORETICAL worst case — every internal bound below also running to its limit —
 *  is ~207 s (132 s talkUntilOpen + 10 npc-name + 5 click + 20 hidden + 40 quest log), so
 *  a phase in which several attempts fully degrade trips the 300 s TEST timeout rather
 *  than this loop bound. Both are red and neither can false-pass; this bound exists to
 *  give the FAST failure a named diagnosis, not to cap the phase. */
const MAX_QUEST_ATTEMPTS = 5;

test.describe
  .serial('11r-e (ADR-0169) — the shop overlay shows YOUR gold, and only yours', () => {
    let browser: Browser;
    let ctxA: BrowserContext;
    let ctxB: BrowserContext;
    let a: Page;
    let b: Page;
    /** Both players' own entity ids — everything else in `characters` is an NPC. */
    let playerEntityIds: string[] = [];
    let identityA = '';
    let identityB = '';
    /** Set when a retry's re-talk completed quest_001 before the log could be re-read —
     *  the one race the two-phase loop structure cannot otherwise absorb. Server truth
     *  (`spacetime sql`), never the client UI under test, decides it. */
    let questGrantedDuringRetry = false;
    /** Baseline captured in the 11r-e-6 test; the 11r-e-7 test diffs against it. */
    let balanceWritesAtOpen = -1;

    test.beforeAll(async () => {
      // A hook's default timeout is the config `timeout` (45 s); this one can legitimately
      // spend two 30 s ready-waits plus two 30 s presence-waits under CI load.
      test.setTimeout(150_000);
      browser = await chromium.launch();
      ctxA = await browser.newContext();
      ctxB = await browser.newContext();
      await ctxA.addInitScript(installShopBalanceRecorder);
      await ctxB.addInitScript(installShopBalanceRecorder);
      a = await ctxA.newPage();
      b = await ctxB.newPage();
      await a.goto('/');
      await b.goto('/');
      await ready(a);
      await ready(b);
      // Exact-presence discipline: converge to exactly 2 players on BOTH pages.
      await a.waitForFunction(
        () => (window as unknown as GameWindow).__game().presenceCount === 2,
        null,
        { timeout: 30_000 },
      );
      await b.waitForFunction(
        () => (window as unknown as GameWindow).__game().presenceCount === 2,
        null,
        { timeout: 30_000 },
      );
      const ga = await snap(a);
      const gb = await snap(b);
      if (ga.ownEntityId === null || gb.ownEntityId === null) {
        throw new Error('beforeAll: own entity ids must be resolved after ready()');
      }
      playerEntityIds = [ga.ownEntityId, gb.ownEntityId];
      identityA = ga.identity;
      identityB = gb.identity;
      if (identityA === identityB) {
        throw new Error('beforeAll: the two contexts share an identity — B is not a second player');
      }
    });

    test.afterAll(async () => {
      // Clean disconnects, or the next spec file's exact-presence wait hangs (workers: 1).
      await browser.close();
    });

    // -------------------------------------------------------------------------
    // Setup: A walks the grass-free pocket path to elder_oak.
    // -------------------------------------------------------------------------
    test('setup: A walks (1,1) → (5,4), grass-free and battle-free', async () => {
      test.setTimeout(120_000);
      const start = await snap(a);
      expect(start.ownAuthTile, 'A spawns with an authoritative tile').not.toBeNull();
      expect(start.ownAuthTile).toEqual({ x: 1, y: 1 });
      expect(start.map.zone_id, 'A spawns in zone 0').toBe(0);
      // The recorders must be armed before anything can be missed (anti-vacuity for every
      // first-paint / sticky-latch assertion below). They arm during HTML parsing, so this
      // is already true by the time __game() is ready — the wait is a bounded belt.
      for (const p of [a, b]) {
        await p.waitForFunction(
          () =>
            (window as unknown as { __mrRecorderInstalled?: unknown }).__mrRecorderInstalled ===
            true,
          null,
          { timeout: 15_000 },
        );
      }
      expect(
        await readEverKnown(b),
        "B's sticky latch starts false — a latch that began true would make its negative vacuous",
      ).toBe(false);

      await walk(a, A_TO_ELDER);
      const done = await snap(a);
      expect(done.ownAuthTile).toEqual(ELDER_POCKET);
      expect(done.ongoingBattle, 'the pocket path is grass-free').toBeNull();
    });

    // -------------------------------------------------------------------------
    // Precondition (a): A STARTS quest_001.
    //   talk → click "I seek a quest." → advance_dialogue applies
    //   StartQuest("quest_001") → the quest log shows it at step 0.
    // Both outcomes of an advance delete the conversation row (success: next_node None
    // ends the dialogue; rejection: walked_away), so the overlay hides either way and a
    // slow attempt is treated as a failed attempt rather than failing the test.
    // ESCAPE VALVE (the one race two sequential loops cannot absorb): if an attempt's
    // advance SUCCEEDED but its hidden-wait or log-read timed out, the NEXT attempt's
    // re-talk COMPLETES the quest — the log would then never be observed containing
    // quest_001 and this phase would fail although the 50 gold was granted. Server truth
    // decides: if A already owns a player_wallet row, the grant has happened and phase (b)
    // is skipped. (Deviation from plan R9's pure two-loop form, deliberately narrow.)
    // -------------------------------------------------------------------------
    test('precondition (a): A starts quest_001 via the elder_oak dialogue choice', async () => {
      test.setTimeout(300_000);
      const overlay = a.locator('#dialogue-overlay');
      let started = false;

      for (let attempt = 0; attempt < MAX_QUEST_ATTEMPTS && !started; attempt++) {
        if (!(await overlay.isVisible())) {
          await talkUntilOpen(a, playerEntityIds);
        }
        await expect(a.locator('#dialogue-npc-name')).toHaveText('elder_oak', { timeout: 10_000 });
        await a
          .locator('#dialogue-choices')
          .getByText(QUEST_CHOICE, { exact: true })
          .click({ timeout: 5_000 })
          .catch(() => {
            // The overlay can vanish between isVisible() and the click when a previous
            // attempt's slow row-delete finally propagates — not a failure; the
            // hidden-wait below picks the flow back up.
          });
        const hidden = await overlay
          .waitFor({ state: 'hidden', timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        if (!hidden) continue;
        started = await questLogShows(a, QUEST_ID, true, 8_000);
        if (!started) {
          // Identity-scoped: A is a fresh identity created in this file's beforeAll, so a
          // row under A's OWN identity can only have come from quest_001's grant.
          questGrantedDuringRetry = walletBalanceFor(identityA, 'precondition (a)') !== undefined;
          if (questGrantedDuringRetry) break;
        }
      }

      expect(
        started || questGrantedDuringRetry,
        `quest_001 was neither started nor already completed after ${MAX_QUEST_ATTEMPTS} attempts. ` +
          "Contract: game-core/content/dialogue_trees/000-core.ron elder_oak_talk's choice " +
          `"${QUEST_CHOICE}" carries effects: [StartQuest("${QUEST_ID}")], and npc.rs:105-120 ` +
          'inserts the player_quest row at step 0.',
      ).toBe(true);
      if (started) {
        // Exact li text — kills a stepIndex mismapping and a displayName drift.
        await a.keyboard.press('KeyQ');
        await expect(a.locator('#quest-log-overlay')).toBeVisible({ timeout: 15_000 });
        await expect(a.locator('#quest-log-list li').filter({ hasText: QUEST_ID })).toHaveText(
          `${QUEST_ID} (step 0)`,
        );
        await a.keyboard.press('Escape');
        await expect(a.locator('#quest-log-overlay')).toBeHidden({ timeout: 15_000 });
      }
    });

    // -------------------------------------------------------------------------
    // Precondition (b): a SECOND talk completes quest_001 ⇒ exactly 50 gold.
    //   npc.rs:269-277 fires the Talked trigger inside `talk` itself, and
    //   npc.rs:174-183's QuestComplete arm deletes the player_quest row AND calls
    //   grant_currency in the SAME arm. npc.rs:175 is the module's only player_quest
    //   delete, so "quest_001 left the log" is an EXACT server-side witness of the grant.
    // The final assertion is server truth (`spacetime sql`), deliberately independent of
    // the client render path this whole spec is testing.
    // -------------------------------------------------------------------------
    test('precondition (b): a second talk completes quest_001 ⇒ server-side balance 50', async () => {
      test.setTimeout(300_000);
      const overlay = a.locator('#dialogue-overlay');
      let completed = questGrantedDuringRetry;

      for (let attempt = 0; attempt < MAX_QUEST_ATTEMPTS && !completed; attempt++) {
        if (!(await overlay.isVisible())) {
          await talkUntilOpen(a, playerEntityIds);
        }
        // Do NOT click the choice here: the completion happens in `talk` itself. (Clicking
        // would be harmless anyway — StartQuest is idempotent against done_quests — but
        // the dismiss is what the quest-log read needs.)
        await a.keyboard.press('Escape');
        const hidden = await overlay
          .waitFor({ state: 'hidden', timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        if (!hidden) continue;
        completed = await questLogShows(a, QUEST_ID, false, 10_000);
      }

      expect(
        completed,
        `quest_001 did not leave A's quest log after ${MAX_QUEST_ATTEMPTS} talk attempts. ` +
          'Contract: game-core/content/quests/000-core.ron gives quest_001 the single step ' +
          'trigger Talk(npc_id: "elder_oak"), and server-module/src/npc.rs:174-183 deletes the ' +
          'player_quest row and calls grant_currency(reward.currency = 50) in the same arm.',
      ).toBe(true);

      // SERVER TRUTH — the precondition for 11r-e-6 stated as an assertion, not as prose.
      // ONE identity-scoped read: A's OWN row's balance cell. A substring test over the
      // whole table would pass on any foreign balance containing "50" left behind by an
      // earlier spec file in this shared --delete-data database (see the ⚠ note above
      // sqlQuery) while A's own row read 0.
      expect(
        walletBalanceFor(identityA, 'precondition (b)'),
        `A's OWN server-side player_wallet row must read exactly 50 before the shop ` +
          `assertions mean anything (quest_001 reward.currency = 50; A=${identityA}). ` +
          'undefined here = the QuestComplete arm never ran; any other number = the faucet ' +
          'is not the one this spec derives its expectation from.',
      ).toBe('50');
    });

    // -------------------------------------------------------------------------
    // 11r-e-6 + 11r-e-9 (A): the player sees their OWN real balance — at FIRST PAINT
    // and settled — in a demonstrably populated catalogue.
    //
    // KILLS: the slice being inert (today: #shop-balance exists, hidden, `unknown`
    // forever); a subscription wired but the store never fed; a store fed but no call site
    // passing it; and — uniquely, via the first-paint reconstruction — the `:1436`-only
    // 2-of-3 patch that a retrying matcher cannot see (see the header truth table).
    // The overlay is LEFT OPEN for the 11r-e-7 test.
    // -------------------------------------------------------------------------
    test('11r-e-6/9: A opens the shop and #shop-balance reads exactly "Gold: 50" (first paint AND settled)', async () => {
      test.setTimeout(240_000);
      await walk(a, A_TO_WARP);
      // The warp is server-authoritative and asynchronous w.r.t. the step ack: poll the
      // client's ACTIVE zone map rather than assuming it flipped with the tile.
      await a.waitForFunction(
        () => (window as unknown as GameWindow).__game().map.zone_id === 1,
        null,
        { timeout: 20_000 },
      );
      const warped = await snap(a);
      expect(warped.ownAuthTile, 'the warp lands on zone 1 (5,5)').toEqual({ x: 5, y: 5 });
      await walk(a, ZONE1_TO_SHOPKEEPER);
      const atShop = await snap(a);
      expect(atShop.ownAuthTile, 'A stands on the TALK_RANGE boundary tile').toEqual(SHOP_TILE);
      expect(atShop.map.zone_id, 'the return warp at zone 1 (5,5) must not have re-fired').toBe(1);
      expect(atShop.ongoingBattle, 'the zone-1 leg is grass-free').toBeNull();

      // Greet-then-shop: KeyT sends `talk`; the [data-shop-id] action opens the shop
      // through a dismissDialogue round trip (never two overlays at once).
      await talkUntilOpen(a, playerEntityIds);
      await expect(a.locator('#dialogue-node-text')).toHaveText(SHOPKEEPER_GREETING);
      const shopButton = a.locator('[data-shop-id]');
      await expect(shopButton).toBeVisible({ timeout: 10_000 });
      await shopButton.click();
      await expect(a.locator('#shop-overlay')).toBeVisible({ timeout: 20_000 });
      await expect(a.locator('#dialogue-overlay')).toBeHidden({ timeout: 20_000 });

      // --- 11r-e-9: the catalogue is POPULATED (the anti-vacuity control) --------------
      await expect(a.locator('#shop-title')).toHaveText(SHOP_NAME, { timeout: 15_000 });
      expect(
        await a.locator('#shop-for-sale li').count(),
        '11r-e-9: the bound shop must render at least one stock row',
      ).toBeGreaterThanOrEqual(1);
      expect(
        await a.locator('#shop-for-sale button[data-item-id]').count(),
        '11r-e-9: at least one stock row must carry a Buy button',
      ).toBeGreaterThanOrEqual(1);
      const forSaleText = (await a.locator('#shop-for-sale').textContent()) ?? '';
      expect(forSaleText.includes('gold'), '11r-e-9: stock rows are PRICED').toBe(true);
      expect(forSaleText.includes('Nothing for sale.')).toBe(false);

      // --- 11r-e-6, settled ------------------------------------------------------------
      const balance = a.locator('#shop-balance');
      await expect(
        balance,
        '11r-e-6: #shop-balance must be VISIBLE for a player with a known balance',
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        balance,
        '11r-e-6: the readout is exactly `Gold: ${amount}` (shopModel.ts:78) for the ' +
          'server-authoritative 50 granted by quest_001',
      ).toHaveText(EXPECTED_BALANCE_TEXT, { timeout: 15_000 });
      await expect(balance).toHaveAttribute('data-balance-state', 'known');
      const reading = await readBalance(a);
      expect(reading.hidden, '11r-e-6: the known arm un-hides the node').toBe(false);
      expect(reading.state).toBe('known');
      expect(reading.text).toBe(EXPECTED_BALANCE_TEXT);

      // --- 11r-e-6, FIRST PAINT (ADR-0169 D7) ------------------------------------------
      const fp = await readFirstPaint(a);
      expect(fp.installed, 'the recorder must be installed (anti-vacuity)').toBe(true);
      expect(
        fp.openIndex,
        'no "#shop-overlay became visible" mutation was recorded — the recorder missed the ' +
          `open, so the first-paint tooth would be vacuous. log=${JSON.stringify(fp).slice(0, 400)}`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        fp.text,
        '11r-e-6 FIRST PAINT: the render that ran immediately BEFORE shopView.show() must ' +
          "already carry the balance. '' here — or null, meaning that render wrote no text " +
          'to the node at all — is the `:1436`-only 2-of-3 patch: the ' +
          'dialogue listener at main.ts:1378 rendered without store.ownWallet(identity) and the ' +
          'shop batch listener papered over it in the same synchronous flushBatch turn. ' +
          `Recorded: ${JSON.stringify(fp).slice(0, 400)}`,
      ).toBe(EXPECTED_BALANCE_TEXT);

      // Baseline the 11r-e-7 test diffs against.
      balanceWritesAtOpen = await readBalanceWrites(a);
      expect(
        balanceWritesAtOpen,
        'the recorder must have counted the open renders (anti-vacuity for 11r-e-7)',
      ).toBeGreaterThan(0);
      // A's overlay is deliberately LEFT OPEN from here on.
    });

    // -------------------------------------------------------------------------
    // 11r-e-8 + 11r-e-9 (B): a second identity never sees A's gold.
    //
    // KILLS: any RENDER path that puts a balance on screen for a player who has none —
    // a store keyed as a Map over identities that surfaces the first row it holds
    // (ADR-0154 D5), an `ownWallet` call replaced by a raw slot read, a fabricated
    // `?? 0n` default anywhere between the view and the DOM.
    //
    // DOES NOT KILL a dropped owner FILTER inside store.ownWallet, and must never be
    // described as if it did (the header says the same, and ADR-0169 D8 is the SSOT):
    // with the server view correctly scoped, B's slot is EMPTY, so `ownWallet` returns
    // undefined with or without its `slot.ownerIdentity === identity` test. That mutant
    // is killed by store.test.ts S1/S4, and server-side scoping by
    // evals/wallet-privacy.eval.mjs [B/2c] + economy_tests.rs::my_wallet_view_is_owner_scoped.
    // PASSES VACUOUSLY TODAY: hence 11r-e-9 in the same test, the shared readBalance()
    // helper, and the server-truth query below.
    // -------------------------------------------------------------------------
    test('11r-e-8/9: B (no wallet row) opens the same shop and sees NO balance at all', async () => {
      test.setTimeout(240_000);
      const startB = await snap(b);
      expect(startB.ownAuthTile, 'B spawns at (1,1) in zone 0').toEqual({ x: 1, y: 1 });
      expect(startB.map.zone_id).toBe(0);
      await walk(b, B_TO_WARP);
      await b.waitForFunction(
        () => (window as unknown as GameWindow).__game().map.zone_id === 1,
        null,
        { timeout: 20_000 },
      );
      await walk(b, ZONE1_TO_SHOPKEEPER);
      const atShopB = await snap(b);
      expect(atShopB.ownAuthTile).toEqual(SHOP_TILE);
      expect(atShopB.ongoingBattle, "B's route is grass-free").toBeNull();

      await talkUntilOpen(b, playerEntityIds);
      await expect(b.locator('#dialogue-node-text')).toHaveText(SHOPKEEPER_GREETING);
      const shopButtonB = b.locator('[data-shop-id]');
      await expect(shopButtonB).toBeVisible({ timeout: 10_000 });
      await shopButtonB.click();
      await expect(b.locator('#shop-overlay')).toBeVisible({ timeout: 20_000 });
      await expect(b.locator('#dialogue-overlay')).toBeHidden({ timeout: 20_000 });

      // --- 11r-e-9 for B: the overlay really rendered a live catalogue ------------------
      await expect(b.locator('#shop-title')).toHaveText(SHOP_NAME, { timeout: 15_000 });
      expect(
        await b.locator('#shop-for-sale li').count(),
        "11r-e-9: B's overlay must be populated — otherwise every negative below is vacuous",
      ).toBeGreaterThanOrEqual(1);
      const forSaleTextB = (await b.locator('#shop-for-sale').textContent()) ?? '';
      expect(forSaleTextB.includes('gold')).toBe(true);

      // --- 11r-e-8 ---------------------------------------------------------------------
      const readingB = await readBalance(b);
      expect(
        readingB.state,
        '11r-e-8: data-balance-state must be "unknown". It is written on EVERY render ' +
          '(shopView.ts:100), before the no-shop early return, and is ABSENT from index.html ' +
          'and from the freshly created node — so this also positively proves render() ran.',
      ).toBe('unknown');
      expect(
        readingB.text,
        '11r-e-8: the unknown arm renders EMPTY text, never a fabricated 0',
      ).toBe('');
      expect(readingB.hidden, '11r-e-8: the unknown arm hides the node').toBe(true);
      await expect(b.locator('#shop-balance')).toBeHidden();
      expect(
        readingB.overlayText.includes('Gold:'),
        "11r-e-8: no `Gold:` substring may appear ANYWHERE in B's #shop-overlay subtree. " +
          '(textContent, not innerText — the balance node is `hidden`, and innerText would ' +
          'drop it and make this exclusion vacuous. And note the absence of `50` is NOT ' +
          'asserted: a catalogue price is 150.) Got: ' +
          `${JSON.stringify(readingB.overlayText).slice(0, 300)}`,
      ).toBe(false);

      // Sticky latch: not a spot check but a whole-session claim (store.upsertWallet is
      // unconditional, so a foreign row arriving LATE would be stored silently).
      const latch = await readEverKnown(b);
      expect(typeof latch, "B's sticky latch must be installed (anti-vacuity)").toBe('boolean');
      expect(
        latch,
        "B's #shop-balance was NEVER allowed to become `known` or non-empty at any point in " +
          "the session, including transiently between assertions — A's balance is not B's.",
      ).toBe(false);

      // Server truth AT THE MOMENT B LOOKS: A's row exists, B's does not. This turns the
      // vacuity argument ("B's `unknown` is not just an empty table") into an assertion.
      // Identity rendering: '0x' + 64 lowercase hex (ADR-0121 D1); both sides normalized.
      // If the CLI ever abbreviates identities this check is the ADR-0169 D8 SHOULD and may
      // be dropped — the 11r-e-8 gate itself does not depend on it.
      expect(
        walletBalanceFor(identityA, '11r-e-8'),
        `A's player_wallet row must still read 50 server-side at the moment B looks ` +
          `(A=${identityA}) — otherwise B's "no balance" is not a contrast with anything.`,
      ).toBe('50');
      expect(
        walletBalanceFor(identityB, '11r-e-8'),
        `B must own NO player_wallet row at all — join_game grants no gold and ` +
          `grant_currency's zero-guard prevents a phantom row (B=${identityB}). A row here ` +
          'means B earned currency somewhere in this run and the 11r-e-8 premise is gone.',
      ).toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // 11r-e-7 (A): the readout SURVIVES the shop batch listener.
    //
    // KILLS: the `:1378`-only 2-of-3 patch — ADR-0154 D7's named half-catastrophe (renders
    // once on open, then blanks on the very next batch, which is WORSE than not shipping).
    // The witness is a RENDER COUNTER on #shop-balance's own writes, not "the other player
    // moved": character rows are written by the row callback directly and main.ts:1429-1452
    // swallows listener throws, so a dead listener still shows movement beside a stale DOM.
    // Batches are guaranteed: movement_tick is scheduled per zone unconditionally at
    // STEP_MS = 200 (lib.rs:110-139) and elder_oak wanders forever on the globally
    // unfiltered `character` subscription — plus B's whole walk just happened.
    // -------------------------------------------------------------------------
    test('11r-e-7: after further batches re-render the OPEN overlay, A still reads "Gold: 50"', async () => {
      test.setTimeout(120_000);
      await expect(
        a.locator('#shop-overlay'),
        "precondition: A's overlay stayed open across B's whole session",
      ).toBeVisible();
      expect(
        balanceWritesAtOpen,
        'precondition: the 11r-e-6 test captured a baseline',
      ).toBeGreaterThan(0);

      await a.waitForFunction(
        (baseline: number) =>
          ((window as unknown as { __mrBalanceWrites?: number }).__mrBalanceWrites ?? 0) > baseline,
        balanceWritesAtOpen,
        { timeout: 60_000 },
      );
      const writesNow = await readBalanceWrites(a);
      expect(
        writesNow,
        '#shop-balance must have been re-written since the overlay opened — otherwise this ' +
          'test proves nothing about the shop batch listener (main.ts:1427-1453)',
      ).toBeGreaterThan(balanceWritesAtOpen);

      const balance = a.locator('#shop-balance');
      await expect(
        balance,
        '11r-e-7: a re-render must NOT blank the readout. A blank here is the `:1378`-only ' +
          "2-of-3 patch: the batch listener's buildShopViewModelForShop( call at main.ts:1436 " +
          'omitted store.ownWallet(identity), so the first batch after the open collapses the ' +
          'balance to the `unknown` arm (ADR-0154 D7 / ADR-0169 D4 — ALL THREE call sites).',
      ).toHaveText(EXPECTED_BALANCE_TEXT, { timeout: 15_000 });
      await expect(balance).toBeVisible();
      await expect(balance).toHaveAttribute('data-balance-state', 'known');
      const reading = await readBalance(a);
      expect(reading.state).toBe('known');
      expect(reading.text).toBe(EXPECTED_BALANCE_TEXT);
      expect(reading.hidden).toBe(false);

      // The EARS "WHILE the overlay remains open ... SHALL NOT blank" clause is a claim
      // about the whole interval, which no spot read or retrying matcher can express: a
      // blank that lands between two observations is invisible to both. The mirror sticky
      // latch closes that — it fires on ANY 'unknown' write to A's balance node, including
      // one that lived only between two synchronous renders inside a single flushBatch.
      const everUnknown = await readEverUnknown(a);
      expect(typeof everUnknown, "A's mirror latch must be installed (anti-vacuity)").toBe(
        'boolean',
      );
      expect(
        everUnknown,
        "A's #shop-balance must NEVER have been written as `unknown` — not on open, not on " +
          'any of the ~5 re-renders per second the shop batch listener performs while the ' +
          'overlay is up. Any hit here is a call site that omitted store.ownWallet(identity) ' +
          '(ADR-0169 D4). A wallet-owning player never legitimately renders the unknown arm: ' +
          'the my_wallet row arrives with the initial subscription, minutes before this open.',
      ).toBe(false);

      // End-of-run re-assertion of B's whole-session claim (R5): a leak that arrived after
      // B's own check — while A's overlay was live and re-rendering — is caught here.
      const latch = await readEverKnown(b);
      expect(typeof latch, "B's sticky latch must still be installed").toBe('boolean');
      expect(
        latch,
        "B's #shop-balance never became `known` at ANY point in the run, including after B's " +
          'own assertions had already passed',
      ).toBe(false);
      const readingB = await readBalance(b);
      expect(readingB.state).toBe('unknown');
      expect(readingB.text).toBe('');
      expect(readingB.overlayText.includes('Gold:')).toBe(false);
    });
  });
