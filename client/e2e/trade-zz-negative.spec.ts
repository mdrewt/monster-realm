import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// 14r-b — trading reducer NEGATIVE-PATH suite (ADR-0184).
//
// AUTHORED TEST-FIRST. This file is the 14r-b gating suite: it was written by the
// tester against trading.rs / game-core rules.rs BEFORE any implementation work, and
// the orchestrator proves its teeth by inverting one guard at a time in trading.rs
// (proof-of-teeth register B1-B11) and checking that the named test goes RED. No
// assertion in this file may ever be relaxed to match a buggy implementation — a wrong
// assertion is re-derived FROM the reducer source, never from the observed behaviour.
//
// WHY THE FILE NAME IS `trade-zz-negative.spec.ts` (LOAD-BEARING)
// ==============================================================
// Playwright runs spec files in alphabetical order under `workers: 1` against ONE shared
// published database (playwright.config.ts:22-31), so file name IS run order.
//   - `trade-propose.spec.ts` reads `allTradeOffers()[0]` GLOBALLY (:288/:307/:321) — an
//     offer left behind by another file lands in its `[0]` slot and corrupts it. `zz`
//     sorts after `propose`, so this file runs AFTER trade-propose and can never feed it
//     a foreign offer row.
//   - `-` is 0x2D and `.` is 0x2E, so `trade-zz-negative.spec.ts` still sorts BEFORE
//     `trade.spec.ts`, keeping this file inside the trade block.
// Precedent: m17.5f named its interlock spec `trade-interlock.spec.ts` (not `battle-*`)
// for exactly this reason — see that file's header, "FILE NAMED `trade-interlock.spec.ts`
// ... so it sorts AFTER golden.spec.ts and recruit.spec.ts".
//
// THREE CONTEXTS, ONE BROWSER
// ===========================
// A = initiator, B = counterparty, C = a joined NON-PARTY (the third identity is what
// makes 5a and 6a possible at all). One `chromium.launch()` + three `newContext()` gives
// three distinct SpacetimeDB identities (precedent wallet-balance.spec.ts:825-857) and
// exactly one `browser.close()` to leak.
//
// EVERY TEST IS SELF-CONTAINED — DO NOT "OPTIMISE" THIS AWAY
// ==========================================================
// Each test creates its own offer, acts, asserts, cleans up, and asserts the world is
// clean again. The bite-proofs run ONE test at a time (`npm run e2e -- e2e/trade-zz-
// negative.spec.ts -g "<title>"`), so a test that depended on a sibling's setup would run
// against an EMPTY world. That failure mode is silent, not loud: with no offer row, the
// tradeId would be '' , `BigInt('')` is `0n`, `cancel_trade(0)` returns "trade offer not
// found", and a `toContain`-style assertion would go GREEN having proven nothing. Two
// defences: (1) no cross-test state, (2) `pairOfferTradeId` hard-fails unless the id is a
// non-empty decimal integer read from server truth for THIS pair.
// `test.describe` is deliberately NOT `.serial`: under `.serial` one failure SKIPS the
// remaining tests, and the register needs the status of EVERY test per mutation.
//
// TEST TITLES ARE `-g` REGEX-SAFE: no parentheses and no square brackets anywhere in a
// title, so the orchestrator can paste a full title into `-g` and have it match literally.
//
// ASSERTION DISCIPLINE
// ====================
//   - Reducer rejections are asserted THREE-part: not-null, name === 'SenderError'
//     (statusModel.ts:20 keys off the name string), message toBe EXACT. Never toContain:
//     "insufficient inventory for item N" is emitted by BOTH trading.rs:331 AND the
//     qty == 0 path in game-core rules.rs:93-97 via types.rs:114-116, and the two are
//     indistinguishable by substring.
//   - Every Err test carries a DIFFERENTIAL CONTROL in the same test: the identical
//     proposal MINUS the offending leg must resolve Ok. That is what attributes the
//     rejection to the intended guard rather than to any earlier one.
//   - State is read from SERVER TRUTH via `spacetime sql`, always scoped to the A/B pair
//     or to one trade_id — never `allTradeOffers()[0]`, never a global row count.
//
// EARS / GUARD MAP
// ================
//   1a  trading.rs:330  initiator item qty > on-hand            → insufficient inventory
//   1b  trading.rs:355  counterparty item qty > on-hand         → counterparty ... item
//   3a  trading.rs:287  initiator currency > balance            → insufficient currency
//   3b  trading.rs:304  counterparty currency > balance         → counterparty ... currency
//   4   trading.rs:439  respond(accepted=false) deletes the row
//       trading.rs:442  ...and disarms the reaper schedule
//   5a  trading.rs:747  non-party cancel rejected, offer survives
//   5b  trading.rs:747  counterparty may cancel
//   5c  trading.rs:747  initiator may cancel
//   6a  trading.rs:433  role checked BEFORE status on respond
//   6b  trading.rs:472  role checked BEFORE status on confirm
//
// PARKED, NOT FORGOTTEN — recorded in ADR-0184 D4, in PROSE only:
//   P1 item exact-boundary accept  — no item faucet reaches a browser identity.
//   P2 near-cap bilateral swap     — same blocker.
//   P3 currency exact boundary     — the quest_001 50-gold faucet costs 4-6 min and has
//      a flake history; the `>` vs `>=` mutants at :330/:355/:287/:304 therefore survive
//      this suite by construction.
// A parked-test marker here would arm the spec-gap-revival.eval.mjs FILE-LEVEL tripwires:
// they scan client/e2e/*.spec.ts for the marker token co-located with a blocker token, so
// even a marker in a COMMENT counts. This file therefore contains no such marker at all,
// and parks live in the ADR instead.
//
// SEMGREP / PROJECT BANS OBSERVED IN THIS FILE: no dynamic `new RegExp`, no URL schemes
// anywhere including in comments (Semgrep matches comment text — say "the local server"),
// no focused-test marker, no parked-test marker.

// ---------------------------------------------------------------------------
// Shapes crossing the page.evaluate boundary.
// Re-declared locally on purpose: sibling specs are frozen and must not be imported
// from, and page.evaluate crosses a structured-clone boundary the type system cannot
// check. Verified against client/src/main.ts:1840-1955 this session.
// ---------------------------------------------------------------------------
interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  presenceCount: number;
  ownMonsters: Array<{
    monsterId: string; // bigint serialised as string — BigInt cannot cross evaluate
    speciesId: number;
    nickname: string;
    level: number;
    partySlot: number;
  }>;
  ownInventory: Array<{ invId: string; itemId: number; count: number }>;
}

interface MrTrade {
  proposeTrade(args: {
    counterparty: string;
    initiatorMonsterIds: string[];
    initiatorItems: { itemId: number; qty: number }[];
    initiatorCurrency: string;
    counterpartyMonsterIds: string[];
    counterpartyItems: { itemId: number; qty: number }[];
    counterpartyCurrency: string;
  }): Promise<void> | undefined;
  respondTrade(tradeId: string, accepted: boolean): Promise<void> | undefined;
  confirmTrade(tradeId: string): Promise<void> | undefined;
  cancelTrade(tradeId: string): Promise<void> | undefined;
  allTradeOffers(): Array<{
    tradeId: string;
    initiator: string;
    counterparty: string;
    status: string;
  }>;
  allPlayers(): Array<{ identity: string; name: string }>;
}

/** One reducer-promise rejection, flattened to clonable primitives INSIDE the page
 *  (an Error instance does not survive the structured-clone boundary). */
interface ReducerRejection {
  name: string;
  message: string;
}

interface TradeItemArg {
  itemId: number;
  qty: number;
}

/** A reducer call, described as data so it can be passed THROUGH page.evaluate.
 *  Deviation from the plan memo (which sketched `errorOf(page, exprBody)`): a data
 *  descriptor rather than a source string, because evaluating a string inside the page
 *  would be dynamic code execution (a Semgrep magnet) and would lose type-checking on
 *  the hook's argument shapes — the exact thing that must stay pinned to main.ts. */
type TradeAction =
  | {
      kind: 'propose';
      counterparty: string;
      initiatorMonsterIds: string[];
      initiatorItems: TradeItemArg[];
      initiatorCurrency: string;
      counterpartyMonsterIds: string[];
      counterpartyItems: TradeItemArg[];
      counterpartyCurrency: string;
    }
  | { kind: 'respond'; tradeId: string; accepted: boolean }
  | { kind: 'confirm'; tradeId: string }
  | { kind: 'cancel'; tradeId: string };

// ---------------------------------------------------------------------------
// EXPECTED SERVER MESSAGES — the pinned strings, each with its source line.
// Read from source this session; a change to any of them is a deliberate API change and
// must be made HERE and in the ADR, never by loosening an assertion.
// ---------------------------------------------------------------------------
/** server-module/src/trading.rs:331 (guard :330). NOTE: byte-identical to the qty == 0
 *  rejection in game-core/src/trading/rules.rs:93-97 via types.rs:114-116 — which is
 *  precisely why test 1a asserts qty > 0 as a precondition and runs a differential
 *  control instead of trusting the message alone. */
const errInsufficientItem = (itemId: number): string => `insufficient inventory for item ${itemId}`;
/** server-module/src/trading.rs:356-358 (guard :355). */
const errCounterpartyInsufficientItem = (itemId: number): string =>
  `counterparty has insufficient inventory for item ${itemId}`;
/** server-module/src/trading.rs:288 (guard :287). */
const ERR_INSUFFICIENT_CURRENCY = 'insufficient currency for trade offer';
/** server-module/src/trading.rs:305 (guard :304). */
const ERR_COUNTERPARTY_INSUFFICIENT_CURRENCY =
  'counterparty has insufficient currency for this trade';
/** server-module/src/trading.rs:748 (guard :747). */
const ERR_NOT_A_PARTY = 'not a party to this trade';
/** game-core/src/trading/types.rs:107-109, raised by rules.rs:445-447 (authorize_respond,
 *  ROLE arm — checked BEFORE status). */
const ERR_NOT_COUNTERPARTY = 'only the trade counterparty can perform this action';
/** game-core/src/trading/types.rs:104-106, raised by rules.rs:460-462 (authorize_confirm,
 *  ROLE arm — checked BEFORE status). */
const ERR_NOT_INITIATOR = 'only the trade initiator can perform this action';
/** game-core/src/trading/types.rs:110, raised by rules.rs:448-450. NEVER an expected
 *  result in this file: it is the STATUS message a status-first authorize_respond would
 *  leak to a non-party in test 6a, and naming it here documents what 6a's exact-message
 *  pin is discriminating against. */
const ERR_NOT_PENDING = 'trade offer is not in Pending state';
/** game-core/src/trading/types.rs:111-113, raised by rules.rs:463-465. Same role as
 *  ERR_NOT_PENDING, for test 6b: under the :472 `==`→`!=` mutant, 6b's rejection message
 *  flips from ERR_NOT_INITIATOR to this string and the exact-match assertion goes red. */
const ERR_NOT_CONFIRMED_BY_COUNTERPARTY = 'trade offer is not in ConfirmedByCounterparty state';

/** An item id no joined identity can own: `join_game` grants a starter monster and NO
 *  items, there is no item faucet reachable from a browser identity, and propose_trade
 *  never checks that an item id exists in content — it only counts inventory rows
 *  (trading.rs:312-330). So the inventory count is provably 0 and qty 1 > 0. */
const PHANTOM_ITEM_ID = 424242;
/** MUST be > 0: qty == 0 is rejected UPSTREAM by validate_proposal (rules.rs:92-97) with
 *  the IDENTICAL message, which would move the rejection off the guard under test. */
const PHANTOM_ITEM_QTY = 1;
/** 1 unit of currency against a provably empty wallet: a fresh identity has no
 *  player_wallet row at all, and economy.rs's zero-guard prevents a phantom one. */
const OVERDRAWN_CURRENCY = '1';

/** Settle window for server-truth reads: 20 polls x 500 ms = 10 s. A reducer promise
 *  only resolves after the transaction commits, so one read is normally enough; the
 *  window exists so a slow local server produces a slow PASS, never a fast false RED. */
const SQL_POLLS = 20;
const SQL_POLL_MS = 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Server truth via `spacetime sql` — OWN COPY (do not import from a sibling spec).
// Modelled on wallet-balance.spec.ts:597-662, NOT on trade-interlock's tolerant parser:
// an unrecognised table shape must THROW, because a silently-empty parse would turn
// every "the row is gone" assertion in this file into a vacuous pass.
// The CLI runs as the module OWNER, so it can read the PRIVATE
// trade_offer_reaper_schedule table directly (ADR-0087: the closed channel is client
// SUBSCRIPTIONS, not owner queries).
// ---------------------------------------------------------------------------

/** Only `server` and `db` are interpolated into the shell string, and the query slot is
 *  charset-checked so nothing but `SELECT * FROM <table>` shapes can reach the shell.
 *  Literal regexes only — `new RegExp(dynamic)` is banned project-wide.
 *  The charset deliberately admits `SELECT * FROM trade_offer_reaper_schedule` and
 *  deliberately does NOT admit a comma or a WHERE clause: every filter in this file is
 *  applied in JS after parsing. */
function sqlQuery(query: string, label: string): string {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  if (!/^[A-Za-z0-9:/._-]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(
      `${label}: STDB_SERVER/VITE_STDB_DB failed charset validation: ${server} ${db}`,
    );
  }
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
      `${label}: spacetime sql could not run — CLI/infra failure, NOT a row mismatch: ` +
        `${(err as Error).message}`,
    );
  }
}

/** Parse `spacetime sql` stdout into row objects keyed BY HEADER NAME.
 *
 *  Contract, and why each clause exists:
 *   - header line, then a `-+-` separator, then zero or more data lines;
 *   - header + separator + ZERO data lines is a VALID EMPTY result, not an error (this
 *     is the shape every "the offer is gone" assertion in this file depends on);
 *   - anything else THROWS. A tolerant parser returning [] on a shape surprise would
 *     make every absence assertion here vacuously true;
 *   - a data line whose cell count differs from the header's column count THROWS. The
 *     reaper table's `scheduled_at` is a ScheduleAt SUM TYPE whose CLI rendering is not
 *     pinned by anything in this repo; if it ever renders a `|` the column mapping would
 *     silently shift and `trade_id` would be read from the wrong cell. Failing loud here
 *     is deliberate: the orchestrator repairs this parser against real output at first
 *     run rather than shipping a quietly-misaligned reader. */
function parseSqlTable(stdout: string, label: string): Record<string, string>[] {
  // shift() rather than [0]/[1] so the undefined-ness is in the type under every tsconfig.
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const header = lines.shift();
  const separator = lines.shift();
  if (header === undefined || separator === undefined || !/^[-+]+$/.test(separator.trim())) {
    throw new Error(
      `${label}: unrecognised spacetime sql table shape — expected a header line then a ` +
        `-+- separator. Got: ${stdout.slice(0, 400)}`,
    );
  }
  const columns = header.split('|').map((c) => c.trim());
  return lines.map((line) => {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length !== columns.length) {
      throw new Error(
        `${label}: sql row has ${cells.length} cells but the header has ${columns.length} ` +
          `columns — a cell almost certainly contains a pipe character, so mapping columns ` +
          `by position would read the wrong values. Header: ${header.trim()} | Row: ${line.trim()}`,
      );
    }
    const row: Record<string, string> = {};
    columns.forEach((col, i) => {
      row[col] = cells[i] ?? '';
    });
    return row;
  });
}

/** lowercase + strip a leading 0x. `spacetime sql` renders Identity as 0x + 64 lowercase
 *  hex; `__game().identity` is the SDK's Identity.toHexString. Normalising both ends makes
 *  the comparison prefix-agnostic. */
function normalizeIdentity(id: string): string {
  const lower = id.toLowerCase();
  return lower.startsWith('0x') ? lower.slice(2) : lower;
}

/** Every trade_offer row whose party pair is exactly {a, b}, in EITHER direction.
 *  PAIR-SCOPED ON PURPOSE: a global count would be satisfied (or broken) by any other
 *  identity's offer, and `allTradeOffers()[0]` is the exact anti-pattern this file exists
 *  to avoid re-committing. */
function tradeOfferRowsForPair(a: string, b: string, label: string): Record<string, string>[] {
  const rows = parseSqlTable(sqlQuery('SELECT * FROM trade_offer', label), label);
  const normA = normalizeIdentity(a);
  const normB = normalizeIdentity(b);
  return rows.filter((r) => {
    const initiator = normalizeIdentity(r.initiator ?? '');
    const counterparty = normalizeIdentity(r.counterparty ?? '');
    return (
      (initiator === normA && counterparty === normB) ||
      (initiator === normB && counterparty === normA)
    );
  });
}

/** Every trade_offer_reaper_schedule row armed for ONE trade_id. Scoped to the id, never
 *  a global count: other specs' offers arm their own schedule rows in the same table. */
function reaperRowsFor(tradeId: string, label: string): Record<string, string>[] {
  const rows = parseSqlTable(sqlQuery('SELECT * FROM trade_offer_reaper_schedule', label), label);
  return rows.filter((r) => (r.trade_id ?? '').trim() === tradeId);
}

/** All trade_offer rows (teardown only — the per-test assertions are always scoped). */
function allTradeOfferRows(label: string): Record<string, string>[] {
  return parseSqlTable(sqlQuery('SELECT * FROM trade_offer', label), label);
}

async function pollSql<T>(read: () => T, done: (v: T) => boolean): Promise<T> {
  let value = read();
  for (let i = 0; i < SQL_POLLS && !done(value); i += 1) {
    await sleep(SQL_POLL_MS);
    value = read();
  }
  return value;
}

/** Wait for, and assert, the number of pair-scoped offer rows in server truth. */
async function expectPairOfferRows(
  a: string,
  b: string,
  expected: number,
  label: string,
): Promise<Record<string, string>[]> {
  const rows = await pollSql(
    () => tradeOfferRowsForPair(a, b, label),
    (r) => r.length === expected,
  );
  expect(
    rows.length,
    `${label}: server truth must hold exactly ${expected} trade_offer row(s) for the ` +
      `A/B pair after the settle window, found ${rows.length}`,
  ).toBe(expected);
  return rows;
}

/** Wait for, and assert, the number of reaper schedule rows armed for one trade_id. */
async function expectReaperRows(tradeId: string, expected: number, label: string): Promise<void> {
  const rows = await pollSql(
    () => reaperRowsFor(tradeId, label),
    (r) => r.length === expected,
  );
  expect(
    rows.length,
    `${label}: server truth must hold exactly ${expected} trade_offer_reaper_schedule ` +
      `row(s) for trade_id=${tradeId} after the settle window, found ${rows.length}`,
  ).toBe(expected);
}

/** The single pair-scoped offer's trade_id, hard-validated.
 *  THE VACUOUS-GREEN ENGINE THIS KILLS: an empty or garbage id string reaches
 *  `BigInt(tradeId)` inside the hook, `BigInt('')` is `0n`, and `cancel_trade(0)` returns
 *  "trade offer not found" — a rejection that looks like a guard firing while proving
 *  nothing at all. Nothing in this file may call a reducer with an unvalidated id. */
function pairOfferTradeId(rows: Record<string, string>[], label: string): string {
  if (rows.length !== 1) {
    throw new Error(
      `${label}: expected exactly 1 pair-scoped trade_offer row to read a trade_id from, ` +
        `found ${rows.length}`,
    );
  }
  const row = rows[0];
  if (row === undefined) throw new Error(`${label}: row 0 missing after a length check`);
  const tradeId = (row.trade_id ?? '').trim();
  if (!/^[0-9]+$/.test(tradeId)) {
    throw new Error(
      `${label}: trade_id cell ${JSON.stringify(tradeId)} is not a decimal integer — ` +
        `refusing to drive a reducer with it`,
    );
  }
  return tradeId;
}

// ---------------------------------------------------------------------------
// Page helpers.
// ---------------------------------------------------------------------------

/** Wait until __game() exists, the identity is assigned, and the player has been placed
 *  on the map. join_game grants the starter monster synchronously, so a non-null
 *  ownAuthTile implies the grant has been processed. */
async function gameReady(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

/** EXACT presence, never `>=`: `>= 3` would pass while a fourth identity from a leaked
 *  browser is still joined, and that fourth player could hold an active offer that makes
 *  every propose in this file fail the one-active-offer rule for reasons unrelated to the
 *  guard under test. */
async function waitForPresence3(p: Page): Promise<void> {
  await p.waitForFunction(
    () => (window as unknown as { __game: () => GameSnap }).__game().presenceCount === 3,
    null,
    { timeout: 30_000 },
  );
}

/** PROJECT the three fields this file needs — never return `__game()` wholesale.
 *  The real snapshot carries `step`/`jump`/`setRawMapZoneForTest` FUNCTIONS and the raw
 *  wasm map object (main.ts:1840-1891), none of which survive the structured-clone
 *  boundary; returning it whole makes page.evaluate throw on serialisation.
 *  (trade-full.spec.ts:105-118 projects for the same reason.) */
async function snap(
  p: Page,
): Promise<Pick<GameSnap, 'identity' | 'presenceCount' | 'ownMonsters'>> {
  return p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      identity: g.identity,
      presenceCount: g.presenceCount,
      ownMonsters: g.ownMonsters,
    };
  });
}

/** The identity's own starter monster id — the >= 1 asset that satisfies the EmptyOffer
 *  rule (rules.rs:52-61) in every proposal in this file. Positive controls NEVER confirm a
 *  trade, so this monster stays with A for the whole run. */
async function starterMonsterId(p: Page, label: string): Promise<string> {
  const g = await snap(p);
  const first = g.ownMonsters[0];
  if (first === undefined) {
    throw new Error(
      `${label}: this identity owns no monster, so no proposal in this file can satisfy ` +
        `the EmptyOffer rule — join_game must grant exactly one starter`,
    );
  }
  return first.monsterId;
}

/** Drive ONE reducer through window.__mrTrade and report its outcome as data.
 *
 *  Returns null when the reducer resolved Ok, or {name, message} when it rejected.
 *
 *  Three traps closed inside the evaluate:
 *   1. HOOK MISSING → throw with a named diagnosis, rather than a TypeError on undefined.
 *   2. HOOK RETURNED undefined → throw. The hook's signature is `Promise<void> | undefined`
 *      (main.ts:1919-1938) and it returns undefined when the connection is not live;
 *      `await undefined` RESOLVES, which would counterfeit a successful reducer call and
 *      turn every positive control in this file green for free.
 *   3. THE AWAIT HAPPENS INSIDE THE EVALUATE. An un-awaited hook promise that later
 *      rejects raises `unhandledrejection`, which main.ts:729 pushes into the error ring
 *      and paints as a persistent #mr-error-overlay — it would then intercept whatever a
 *      later test does with the page. */
async function errorOf(p: Page, action: TradeAction): Promise<ReducerRejection | null> {
  return p.evaluate(async (a: TradeAction): Promise<ReducerRejection | null> => {
    const hook = (window as unknown as { __mrTrade?: MrTrade }).__mrTrade;
    if (hook === undefined) {
      throw new Error(
        'window.__mrTrade is missing on this page — the DEV-gated trade hook ' +
          '(main.ts:1910-1955) is not installed, so no reducer can be driven',
      );
    }
    const call =
      a.kind === 'propose'
        ? hook.proposeTrade({
            counterparty: a.counterparty,
            initiatorMonsterIds: a.initiatorMonsterIds,
            initiatorItems: a.initiatorItems,
            initiatorCurrency: a.initiatorCurrency,
            counterpartyMonsterIds: a.counterpartyMonsterIds,
            counterpartyItems: a.counterpartyItems,
            counterpartyCurrency: a.counterpartyCurrency,
          })
        : a.kind === 'respond'
          ? hook.respondTrade(a.tradeId, a.accepted)
          : a.kind === 'confirm'
            ? hook.confirmTrade(a.tradeId)
            : hook.cancelTrade(a.tradeId);
    if (call === undefined) {
      throw new Error(
        `__mrTrade.${a.kind} returned undefined — the connection is not live. Awaiting ` +
          'undefined would resolve and fake a successful reducer call',
      );
    }
    try {
      await call;
      return null;
    } catch (e) {
      const err = e as { name?: unknown; message?: unknown } | null;
      return { name: String(err?.name ?? ''), message: String(err?.message ?? '') };
    }
  }, action);
}

/** POSITIVE CONTROL: the call must resolve Ok. */
async function expectOk(p: Page, action: TradeAction, label: string): Promise<void> {
  const rejection = await errorOf(p, action);
  expect(
    rejection,
    `${label}: POSITIVE CONTROL must resolve Ok — it rejected with ${JSON.stringify(rejection)}. ` +
      `A control that cannot pass makes the paired negative assertion vacuous`,
  ).toBeNull();
}

/** THREE-PART rejection assertion: not-null, SenderError, EXACT message. */
function expectRejection(
  rejection: ReducerRejection | null,
  expectedMessage: string,
  label: string,
): void {
  expect(
    rejection,
    `${label}: the reducer RESOLVED — the guard did not fire at all. Expected a rejection ` +
      `carrying ${JSON.stringify(expectedMessage)}`,
  ).not.toBeNull();
  expect(
    rejection?.name,
    `${label}: rejection must be a SenderError, i.e. a reducer Err the server addressed to ` +
      `the caller. An InternalError here means the reducer panicked instead of rejecting`,
  ).toBe('SenderError');
  expect(
    rejection?.message,
    `${label}: EXACT server message mismatch — a different guard fired, or the guard's ` +
      `message changed. Expected ${JSON.stringify(expectedMessage)}, got ` +
      `${JSON.stringify(rejection?.message)}`,
  ).toBe(expectedMessage);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('14r-b — trading reducer negative paths, three identities, server truth', () => {
  let browser: Browser;
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page;
  let identityA = '';
  let identityB = '';
  let identityC = '';

  test.beforeAll(async () => {
    // Three 30 s ready-waits plus three 30 s presence-waits can legitimately outrun the
    // 45 s config default under CI load.
    test.setTimeout(150_000);
    browser = await chromium.launch();
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    ctxC = await browser.newContext();
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
    pageC = await ctxC.newPage();
    await pageA.goto('/');
    await pageB.goto('/');
    await pageC.goto('/');
    await Promise.all([gameReady(pageA), gameReady(pageB), gameReady(pageC)]);
    // Converge to EXACTLY three players on ALL three pages before any test runs.
    await Promise.all([waitForPresence3(pageA), waitForPresence3(pageB), waitForPresence3(pageC)]);
    const [ga, gb, gc] = await Promise.all([snap(pageA), snap(pageB), snap(pageC)]);
    identityA = ga.identity;
    identityB = gb.identity;
    identityC = gc.identity;
    // Pairwise distinct, each with the consequence named: two contexts sharing an
    // identity would make propose_trade fail the self-trade rule (A vs B), or would make
    // C a PARTY to the offer, which silently converts tests 5a and 6a from "a non-party
    // is rejected" into "a party is accepted" — passing for the wrong reason.
    expect(
      identityA,
      'A and B must be distinct identities — if they share one, every propose in this ' +
        'file hits the self-trade rule instead of the guard under test',
    ).not.toBe(identityB);
    expect(
      identityA,
      'A and C must be distinct identities — if they share one, C is the INITIATOR and ' +
        'tests 5a/6a stop testing the non-party path entirely',
    ).not.toBe(identityC);
    expect(
      identityB,
      'B and C must be distinct identities — if they share one, C is the COUNTERPARTY ' +
        'and tests 5a/6a stop testing the non-party path entirely',
    ).not.toBe(identityC);
  });

  test.afterAll(async () => {
    // Cancel anything this file left live BEFORE closing, or the next spec file inherits
    // an offer row (and, under the one-active-offer rule, a wedged player).
    // try/finally, not try/catch: the close still runs even if the sweep throws, and the
    // sweep's error still propagates — nothing is swallowed.
    try {
      const parties: Array<{ page: Page; identity: string }> = [
        { page: pageA, identity: identityA },
        { page: pageB, identity: identityB },
        { page: pageC, identity: identityC },
      ];
      const rows = allTradeOfferRows('afterAll sweep');
      for (const row of rows) {
        const initiator = normalizeIdentity(row.initiator ?? '');
        const counterparty = normalizeIdentity(row.counterparty ?? '');
        const owner = parties.find((p) => {
          const norm = normalizeIdentity(p.identity);
          return norm === initiator || norm === counterparty;
        });
        if (owner === undefined) continue;
        const tradeId = (row.trade_id ?? '').trim();
        if (!/^[0-9]+$/.test(tradeId)) continue;
        await errorOf(owner.page, { kind: 'cancel', tradeId });
        // Await it GONE from server truth — a fire-and-forget cancel would leave the next
        // spec file racing a row this file created.
        const remainingOffers = await pollSql(
          () =>
            allTradeOfferRows('afterAll sweep').filter(
              (r) => (r.trade_id ?? '').trim() === tradeId,
            ),
          (r) => r.length === 0,
        );
        expect(
          remainingOffers.length,
          `afterAll sweep: trade_offer trade_id=${tradeId} survived the teardown cancel — ` +
            `the world is not clean for the next spec file`,
        ).toBe(0);
        const remainingReapers = await pollSql(
          () => reaperRowsFor(tradeId, 'afterAll sweep'),
          (r) => r.length === 0,
        );
        expect(
          remainingReapers.length,
          `afterAll sweep: trade_id=${tradeId} still has ${remainingReapers.length} armed ` +
            `reaper row(s) after cancel — the world is not clean for the next spec file`,
        ).toBe(0);
      }
    } finally {
      await browser.close();
    }
  });

  // -------------------------------------------------------------------------
  // 1a — trading.rs:330 (initiator item leg). Register: B7.
  //
  // WHAT THE DIFFERENTIAL CONTROL BUYS: propose_trade runs eight guards before the
  // initiator item loop. Without the control, an implementation that rejected EVERY
  // proposal (or that broke the counterparty-joined check, or the active-offer rule)
  // would produce a rejection and this test would look green on a substring. The control
  // is the SAME proposal minus the item leg: it must resolve Ok, which proves guards
  // 0-7 all pass for this world, so the only difference left is the phantom item.
  //
  // WHAT THIS KILLS: `>` → `<` at trading.rs:330 (B7) — 1 < 0 is false, the phantom item
  // is accepted, the proposal RESOLVES and the not-null assertion fails.
  // HONEST GAP: `>` → `>=` survives (0 items on hand, so no exact-boundary probe exists);
  // recorded in ADR-0184 D4 as a named park, not a silent omission.
  // -------------------------------------------------------------------------
  test('1a: propose listing a phantom item on the initiator leg is rejected — guard trading.rs:330', async () => {
    test.setTimeout(120_000);
    const label = '1a';
    expect(
      PHANTOM_ITEM_QTY,
      '1a precondition: qty must be > 0. A qty of 0 is rejected UPSTREAM by ' +
        'validate_proposal with the IDENTICAL message, which would move this test off ' +
        'the guard it claims to cover',
    ).toBeGreaterThan(0);
    const monsterA = await starterMonsterId(pageA, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} precondition`);

    // --- DIFFERENTIAL CONTROL: identical proposal WITHOUT the item leg → Ok ---
    await expectOk(
      pageA,
      {
        kind: 'propose',
        counterparty: identityB,
        initiatorMonsterIds: [monsterA],
        initiatorItems: [],
        initiatorCurrency: '0',
        counterpartyMonsterIds: [],
        counterpartyItems: [],
        counterpartyCurrency: '0',
      },
      `${label} control`,
    );
    const controlRows = await expectPairOfferRows(identityA, identityB, 1, `${label} control`);
    const controlTradeId = pairOfferTradeId(controlRows, `${label} control`);
    await expectOk(pageA, { kind: 'cancel', tradeId: controlTradeId }, `${label} control cancel`);
    // The control MUST be cleared before the negative half: a surviving offer would make
    // the next propose fail the one-active-offer rule (AlreadyInTrade), not the item guard.
    await expectPairOfferRows(identityA, identityB, 0, `${label} control cleared`);

    // --- NEGATIVE: the same proposal PLUS a phantom item on A's leg ---
    const rejection = await errorOf(pageA, {
      kind: 'propose',
      counterparty: identityB,
      initiatorMonsterIds: [monsterA],
      initiatorItems: [{ itemId: PHANTOM_ITEM_ID, qty: PHANTOM_ITEM_QTY }],
      initiatorCurrency: '0',
      counterpartyMonsterIds: [],
      counterpartyItems: [],
      counterpartyCurrency: '0',
    });
    expectRejection(rejection, errInsufficientItem(PHANTOM_ITEM_ID), label);
    // No row may have been written: a reject-then-insert impl would leave an offer behind.
    await expectPairOfferRows(identityA, identityB, 0, `${label} no row written`);
  });

  // -------------------------------------------------------------------------
  // 1b — trading.rs:355 (counterparty item leg). Register: B8.
  //
  // Same differential structure as 1a. The distinct message is the whole point: the two
  // loops are copy-paste siblings, and only the message distinguishes which one fired.
  // WHAT THIS KILLS: `>` → `<` at trading.rs:355 (B8), and any impl that checks only the
  // initiator's inventory — the phantom item would then be accepted and the proposal
  // would resolve.
  // -------------------------------------------------------------------------
  test('1b: propose listing a phantom item on the counterparty leg is rejected — guard trading.rs:355', async () => {
    test.setTimeout(120_000);
    const label = '1b';
    expect(PHANTOM_ITEM_QTY, '1b precondition: qty must be > 0, see 1a').toBeGreaterThan(0);
    const monsterA = await starterMonsterId(pageA, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} precondition`);

    await expectOk(
      pageA,
      {
        kind: 'propose',
        counterparty: identityB,
        initiatorMonsterIds: [monsterA],
        initiatorItems: [],
        initiatorCurrency: '0',
        counterpartyMonsterIds: [],
        counterpartyItems: [],
        counterpartyCurrency: '0',
      },
      `${label} control`,
    );
    const controlRows = await expectPairOfferRows(identityA, identityB, 1, `${label} control`);
    const controlTradeId = pairOfferTradeId(controlRows, `${label} control`);
    await expectOk(pageA, { kind: 'cancel', tradeId: controlTradeId }, `${label} control cancel`);
    await expectPairOfferRows(identityA, identityB, 0, `${label} control cleared`);

    const rejection = await errorOf(pageA, {
      kind: 'propose',
      counterparty: identityB,
      initiatorMonsterIds: [monsterA],
      initiatorItems: [],
      initiatorCurrency: '0',
      counterpartyMonsterIds: [],
      counterpartyItems: [{ itemId: PHANTOM_ITEM_ID, qty: PHANTOM_ITEM_QTY }],
      counterpartyCurrency: '0',
    });
    expectRejection(rejection, errCounterpartyInsufficientItem(PHANTOM_ITEM_ID), label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} no row written`);
  });

  // -------------------------------------------------------------------------
  // 3a — trading.rs:287 (initiator currency leg). Register: B9.
  //
  // A fresh identity has NO player_wallet row: join_game grants no gold, and economy.rs's
  // zero-guard prevents a phantom row, so wallet_balance is provably 0 and escrow is
  // provably 0 (the active-offer rule already rejected any party holding an offer).
  // WHAT THIS KILLS: `>` → `<` at trading.rs:287 (B9) — 1 < 0 is false, so the overdrawn
  // currency leg is accepted and the proposal resolves.
  // -------------------------------------------------------------------------
  test('3a: propose listing currency the initiator does not have is rejected — guard trading.rs:287', async () => {
    test.setTimeout(120_000);
    const label = '3a';
    const monsterA = await starterMonsterId(pageA, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} precondition`);

    await expectOk(
      pageA,
      {
        kind: 'propose',
        counterparty: identityB,
        initiatorMonsterIds: [monsterA],
        initiatorItems: [],
        initiatorCurrency: '0',
        counterpartyMonsterIds: [],
        counterpartyItems: [],
        counterpartyCurrency: '0',
      },
      `${label} control`,
    );
    const controlRows = await expectPairOfferRows(identityA, identityB, 1, `${label} control`);
    const controlTradeId = pairOfferTradeId(controlRows, `${label} control`);
    await expectOk(pageA, { kind: 'cancel', tradeId: controlTradeId }, `${label} control cancel`);
    await expectPairOfferRows(identityA, identityB, 0, `${label} control cleared`);

    const rejection = await errorOf(pageA, {
      kind: 'propose',
      counterparty: identityB,
      initiatorMonsterIds: [monsterA],
      initiatorItems: [],
      initiatorCurrency: OVERDRAWN_CURRENCY,
      counterpartyMonsterIds: [],
      counterpartyItems: [],
      counterpartyCurrency: '0',
    });
    expectRejection(rejection, ERR_INSUFFICIENT_CURRENCY, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} no row written`);
  });

  // -------------------------------------------------------------------------
  // 3b — trading.rs:304 (counterparty currency leg). Register: B10.
  //
  // This is the anti-griefing guard: without it the initiator could name any
  // counterparty_currency at all, the offer would stick, and confirm would fail forever
  // while the counterparty's single trade slot stayed occupied.
  // WHAT THIS KILLS: `>` → `<` at trading.rs:304 (B10), and any impl that balance-checks
  // only the caller's own wallet.
  // -------------------------------------------------------------------------
  test('3b: propose listing currency the counterparty does not have is rejected — guard trading.rs:304', async () => {
    test.setTimeout(120_000);
    const label = '3b';
    const monsterA = await starterMonsterId(pageA, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} precondition`);

    await expectOk(
      pageA,
      {
        kind: 'propose',
        counterparty: identityB,
        initiatorMonsterIds: [monsterA],
        initiatorItems: [],
        initiatorCurrency: '0',
        counterpartyMonsterIds: [],
        counterpartyItems: [],
        counterpartyCurrency: '0',
      },
      `${label} control`,
    );
    const controlRows = await expectPairOfferRows(identityA, identityB, 1, `${label} control`);
    const controlTradeId = pairOfferTradeId(controlRows, `${label} control`);
    await expectOk(pageA, { kind: 'cancel', tradeId: controlTradeId }, `${label} control cancel`);
    await expectPairOfferRows(identityA, identityB, 0, `${label} control cleared`);

    const rejection = await errorOf(pageA, {
      kind: 'propose',
      counterparty: identityB,
      initiatorMonsterIds: [monsterA],
      initiatorItems: [],
      initiatorCurrency: '0',
      counterpartyMonsterIds: [],
      counterpartyItems: [],
      counterpartyCurrency: OVERDRAWN_CURRENCY,
    });
    expectRejection(rejection, ERR_COUNTERPARTY_INSUFFICIENT_CURRENCY, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} no row written`);
  });

  // -------------------------------------------------------------------------
  // 4 — respond_trade(accepted=false): row deleted AND reaper disarmed.
  // Register: B5 covers assertion 4a, B6 covers assertion 4b.
  //
  // TWO-SIDED ARMING ASSERT, AND WHY IT IS NOT OPTIONAL: "the schedule row is gone"
  // proves nothing unless a schedule row provably EXISTED first. Deleting the arming
  // call in propose_trade would otherwise make the disarm assertion pass trivially. So
  // this test asserts 1 armed row immediately after propose, then 0 after the decline.
  //
  // WHAT THIS KILLS:
  //   B5 `!accepted` → `accepted` at trading.rs:439 — the decline then takes the ACCEPT
  //      branch: the row survives with status ConfirmedByCounterparty, so 4a sees 1 row.
  //   B6 delete the disarm line at trading.rs:442 — 4a still passes, 4b sees 1 orphaned
  //      schedule row. The two assertions are deliberately independent.
  // -------------------------------------------------------------------------
  test('4: respondTrade with accepted=false deletes the offer row and disarms its reaper — guards trading.rs:439 and trading.rs:442', async () => {
    test.setTimeout(120_000);
    const label = '4';
    const monsterA = await starterMonsterId(pageA, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} precondition`);

    await expectOk(
      pageA,
      {
        kind: 'propose',
        counterparty: identityB,
        initiatorMonsterIds: [monsterA],
        initiatorItems: [],
        initiatorCurrency: '0',
        counterpartyMonsterIds: [],
        counterpartyItems: [],
        counterpartyCurrency: '0',
      },
      `${label} propose`,
    );
    const rows = await expectPairOfferRows(identityA, identityB, 1, `${label} after propose`);
    const tradeId = pairOfferTradeId(rows, `${label} after propose`);
    const proposed = rows[0];
    if (proposed === undefined) throw new Error(`${label}: pair row missing after a length check`);
    // TradeStatus is a sum type; its CLI rendering is not pinned by anything in this repo,
    // but the two variant names are disjoint tokens, so a two-sided token check is exact.
    expect(
      proposed.status ?? '',
      `${label}: a freshly proposed offer must be Pending in server truth — status cell was ` +
        `${JSON.stringify(proposed.status ?? '')}`,
    ).toContain('Pending');
    expect(
      proposed.status ?? '',
      `${label}: a freshly proposed offer must NOT already be ConfirmedByCounterparty`,
    ).not.toContain('ConfirmedByCounterparty');
    // ARMED side of the two-sided assert.
    await expectReaperRows(tradeId, 1, `${label} armed after propose`);

    // The counterparty declines.
    await expectOk(pageB, { kind: 'respond', tradeId, accepted: false }, `${label} decline`);

    // 4a — offer row deleted (escrow released, no assets moved).
    await expectPairOfferRows(identityA, identityB, 0, `${label}a offer deleted after decline`);
    // 4b — reaper schedule disarmed for that exact trade_id.
    await expectReaperRows(tradeId, 0, `${label}b reaper disarmed after decline`);
  });

  // -------------------------------------------------------------------------
  // 5a — trading.rs:747: a non-party cannot cancel. Register: B3 (and B11 indirectly).
  //
  // C is joined but is neither initiator nor counterparty. Two assertions, both needed:
  // the exact rejection, AND the offer SURVIVING in server truth. A guard that rejected
  // AFTER deleting the row would satisfy the first alone.
  //
  // WHAT THIS KILLS: both `!=` → `==` at trading.rs:747 (B3) — the condition becomes
  // `initiator == me && counterparty == me`, false for C, so C's cancel SUCCEEDS: the
  // rejection assertion fails AND the survival assertion fails.
  // (B4, `&&` → `||`, leaves 5a green by design — it is 5b that catches that one.)
  // -------------------------------------------------------------------------
  test('5a: a non-party cancel_trade is rejected and the offer survives — guard trading.rs:747', async () => {
    test.setTimeout(120_000);
    const label = '5a';
    const monsterA = await starterMonsterId(pageA, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} precondition`);

    await expectOk(
      pageA,
      {
        kind: 'propose',
        counterparty: identityB,
        initiatorMonsterIds: [monsterA],
        initiatorItems: [],
        initiatorCurrency: '0',
        counterpartyMonsterIds: [],
        counterpartyItems: [],
        counterpartyCurrency: '0',
      },
      `${label} propose`,
    );
    const rows = await expectPairOfferRows(identityA, identityB, 1, `${label} after propose`);
    const tradeId = pairOfferTradeId(rows, `${label} after propose`);

    const rejection = await errorOf(pageC, { kind: 'cancel', tradeId });
    expectRejection(rejection, ERR_NOT_A_PARTY, label);
    // The offer must still be there — a rejection that also destroyed the offer would be
    // just as broken as no rejection at all.
    await expectPairOfferRows(identityA, identityB, 1, `${label} offer survives non-party cancel`);

    // Cleanup: the initiator cancels their own offer and the world returns to clean.
    await expectOk(pageA, { kind: 'cancel', tradeId }, `${label} cleanup cancel`);
    await expectPairOfferRows(identityA, identityB, 0, `${label} cleanup verified`);
  });

  // -------------------------------------------------------------------------
  // 5b — trading.rs:747: the COUNTERPARTY may cancel. Register: B4.
  //
  // WHAT THIS KILLS: `&&` → `||` at trading.rs:747 — for B, `initiator != me` is true, so
  // the disjunction is true and B is rejected from cancelling their own trade. The Ok
  // control fails immediately. This is also the behavioural authority behind the tightened
  // CANCEL_PARTY_CHECK regex in evals/trade-reducer-security.eval.mjs, whose `||` fixture
  // is the static half of the same proof.
  // -------------------------------------------------------------------------
  test('5b: the counterparty may cancel and the offer row is gone — guard trading.rs:747', async () => {
    test.setTimeout(120_000);
    const label = '5b';
    const monsterA = await starterMonsterId(pageA, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} precondition`);

    await expectOk(
      pageA,
      {
        kind: 'propose',
        counterparty: identityB,
        initiatorMonsterIds: [monsterA],
        initiatorItems: [],
        initiatorCurrency: '0',
        counterpartyMonsterIds: [],
        counterpartyItems: [],
        counterpartyCurrency: '0',
      },
      `${label} propose`,
    );
    const rows = await expectPairOfferRows(identityA, identityB, 1, `${label} after propose`);
    const tradeId = pairOfferTradeId(rows, `${label} after propose`);

    await expectOk(pageB, { kind: 'cancel', tradeId }, `${label} counterparty cancel`);
    await expectPairOfferRows(identityA, identityB, 0, `${label} offer gone after cancel`);
  });

  // -------------------------------------------------------------------------
  // 5c — trading.rs:747: the INITIATOR may cancel. Register: B11.
  //
  // WHY THIS TEST EXISTS AT ALL: without it, a mutant that replaces the FIRST clause with
  // `true` (`true && offer.counterparty != me`) survives the entire rest of the suite —
  // 5a still rejects C, 5b still lets B cancel, and only the initiator's own cancel breaks.
  // WHAT THIS KILLS: first-clause → `true` at trading.rs:747 — A is then rejected from
  // cancelling A's own offer, so the Ok control fails.
  // -------------------------------------------------------------------------
  test('5c: the initiator may cancel and the offer row is gone — guard trading.rs:747', async () => {
    test.setTimeout(120_000);
    const label = '5c';
    const monsterA = await starterMonsterId(pageA, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} precondition`);

    await expectOk(
      pageA,
      {
        kind: 'propose',
        counterparty: identityB,
        initiatorMonsterIds: [monsterA],
        initiatorItems: [],
        initiatorCurrency: '0',
        counterpartyMonsterIds: [],
        counterpartyItems: [],
        counterpartyCurrency: '0',
      },
      `${label} propose`,
    );
    const rows = await expectPairOfferRows(identityA, identityB, 1, `${label} after propose`);
    const tradeId = pairOfferTradeId(rows, `${label} after propose`);

    await expectOk(pageA, { kind: 'cancel', tradeId }, `${label} initiator cancel`);
    await expectPairOfferRows(identityA, identityB, 0, `${label} offer gone after cancel`);
  });

  // -------------------------------------------------------------------------
  // 6a — trading.rs:433 / rules.rs:444-451: ROLE is authorized BEFORE STATUS.
  // Register: B1.
  //
  // THE SETUP IS THE PROOF. C responds to an offer that is NO LONGER Pending. A
  // status-first implementation would answer with the STATUS message
  // ("trade offer is not in Pending state"), leaking the state of a trade C is not party
  // to. A role-first implementation answers with the ROLE message. Both are rejections —
  // only the EXACT message distinguishes them, which is why toContain is banned here and
  // why this assertion is what makes bite-proof B1 bite.
  //
  // WHAT THIS KILLS: `==` → `!=` at trading.rs:433 — the role boolean inverts, so B's own
  // accept is rejected as NotCounterparty and the positive control fails first.
  // CASCADE NOTE for the register: B5 also reds this test, because under B5 the accept
  // branch deletes the row instead of advancing it, so the ConfirmedByCounterparty
  // precondition never arrives.
  // -------------------------------------------------------------------------
  test('6a: a non-counterparty responding to a ConfirmedByCounterparty offer gets the ROLE error, not the status — guard trading.rs:433', async () => {
    test.setTimeout(120_000);
    const label = '6a';
    const monsterA = await starterMonsterId(pageA, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} precondition`);

    await expectOk(
      pageA,
      {
        kind: 'propose',
        counterparty: identityB,
        initiatorMonsterIds: [monsterA],
        initiatorItems: [],
        initiatorCurrency: '0',
        counterpartyMonsterIds: [],
        counterpartyItems: [],
        counterpartyCurrency: '0',
      },
      `${label} propose`,
    );
    const rows = await expectPairOfferRows(identityA, identityB, 1, `${label} after propose`);
    const tradeId = pairOfferTradeId(rows, `${label} after propose`);

    // The counterparty accepts — this is BOTH the positive control for the role boolean
    // and the setup that takes the offer out of Pending.
    await expectOk(pageB, { kind: 'respond', tradeId, accepted: true }, `${label} accept`);
    const advanced = await pollSql(
      () => tradeOfferRowsForPair(identityA, identityB, `${label} status`),
      (r) => r.length === 1 && (r[0]?.status ?? '').includes('ConfirmedByCounterparty'),
    );
    const advancedRow = advanced[0];
    expect(
      advancedRow?.status ?? '',
      `${label}: the offer must be ConfirmedByCounterparty in server truth before the ` +
        `non-party responds — otherwise this test degenerates into "a non-party responded ` +
        `to a Pending offer", which a status-first implementation also passes`,
    ).toContain('ConfirmedByCounterparty');

    // A non-party responds to a NON-Pending offer. Role first ⇒ the ROLE message.
    const rejection = await errorOf(pageC, { kind: 'respond', tradeId, accepted: true });
    expectRejection(
      rejection,
      ERR_NOT_COUNTERPARTY,
      `${label} — a status-first authorize_respond would answer ` +
        `${JSON.stringify(ERR_NOT_PENDING)} here, leaking the offer's state to a non-party`,
    );

    // Cleanup: cancel from a real party, then verify.
    await expectOk(pageA, { kind: 'cancel', tradeId }, `${label} cleanup cancel`);
    await expectPairOfferRows(identityA, identityB, 0, `${label} cleanup verified`);
  });

  // -------------------------------------------------------------------------
  // 6b — trading.rs:472 / rules.rs:459-466: ROLE before STATUS on confirm.
  // Register: B2.
  //
  // The offer is left PENDING and the COUNTERPARTY calls confirm. Role-first answers
  // NotInitiator. Under the `==` → `!=` mutant at :472 the role boolean inverts: B reads
  // as "the initiator", the role arm passes, and the STATUS arm fires instead — the
  // message flips to "trade offer is not in ConfirmedByCounterparty state" and this
  // exact-match assertion goes red. Both branches reject; only the message separates them.
  // -------------------------------------------------------------------------
  test('6b: the counterparty confirming a Pending offer gets the ROLE error, not the status — guard trading.rs:472', async () => {
    test.setTimeout(120_000);
    const label = '6b';
    const monsterA = await starterMonsterId(pageA, label);
    await expectPairOfferRows(identityA, identityB, 0, `${label} precondition`);

    await expectOk(
      pageA,
      {
        kind: 'propose',
        counterparty: identityB,
        initiatorMonsterIds: [monsterA],
        initiatorItems: [],
        initiatorCurrency: '0',
        counterpartyMonsterIds: [],
        counterpartyItems: [],
        counterpartyCurrency: '0',
      },
      `${label} propose`,
    );
    const rows = await expectPairOfferRows(identityA, identityB, 1, `${label} after propose`);
    const tradeId = pairOfferTradeId(rows, `${label} after propose`);
    const pending = rows[0];
    if (pending === undefined) throw new Error(`${label}: pair row missing after a length check`);
    expect(
      pending.status ?? '',
      `${label}: the offer must still be Pending when the counterparty confirms — that is ` +
        `the wrong-status condition the role-first ordering is proven against`,
    ).toContain('Pending');

    const rejection = await errorOf(pageB, { kind: 'confirm', tradeId });
    expectRejection(
      rejection,
      ERR_NOT_INITIATOR,
      `${label} — under an inverted role boolean the message flips to ` +
        `${JSON.stringify(ERR_NOT_CONFIRMED_BY_COUNTERPARTY)}`,
    );

    // The offer must be untouched, then cleaned up by its initiator.
    await expectPairOfferRows(identityA, identityB, 1, `${label} offer survives rejected confirm`);
    await expectOk(pageA, { kind: 'cancel', tradeId }, `${label} cleanup cancel`);
    await expectPairOfferRows(identityA, identityB, 0, `${label} cleanup verified`);
  });
});
