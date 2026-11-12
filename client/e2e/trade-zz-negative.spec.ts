import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { readWorld, walkTo } from './controls';
import { ownerSql } from './stdb';

// Trade SESSION reducer NEGATIVE-PATH suite: the caller's own-side refusals, the no-oracle cases
// (ts-4.2: no outcome depends on the partner's holdings), cancel roles, non-participant lookups
// and the stale-revision rule.
//
// No assertion in this file may ever be relaxed to match a buggy implementation. A wrong
// assertion is re-derived FROM the reducer source (server-module/src/trading_session.rs,
// game-core/src/trading/session.rs), never from the observed behaviour.
//
// WHY THE FILE NAME IS `trade-zz-negative.spec.ts` (LOAD-BEARING)
// ==============================================================
// Within one Playwright process (one shard) spec files run in alphabetical order under
// `workers: 1` against that process's ONE published database, so file name IS run order
// there. `zz` sorts after every other `trade-*` spec,
// so no session this file opens is ever live while another trade spec runs; and since `-` is
// 0x2D and `.` is 0x2E, it still sorts before a `trade.spec.ts`. The acceptance ledger and the
// bite-proof register also select this file by path and its tests by title prefix (`1b:`, `3b:`
// ...), so neither the name nor the prefixes may change.
//
// THREE CONTEXTS, ONE BROWSER
// ===========================
// A = the opener, B = the partner, C = a joined NON-PARTICIPANT (the third identity is what
// makes 5a and 6a possible at all). One `chromium.launch()` + three `newContext()` gives three
// distinct SpacetimeDB identities, each freshly joined: one starter monster in party slot 0, NO
// player_wallet row, NO inventory row.
//
// RANGE. open_trade_session needs both characters in the same zone within interact range
// (game-core/src/interact.rs `within_interact_range`: same zone, Manhattan <= TALK_RANGE). All
// three join at the zone spawn; every test that opens a session first calls `ensureInRange`,
// which walks A onto B's tile when they stand apart, so a `-g`-selected single test still has
// its range. The hook open is otherwise exactly the reducer: no UI is driven here.
//
// EVERY TEST IS SELF-CONTAINED — DO NOT "OPTIMISE" THIS AWAY
// ==========================================================
// Each test opens its own session, acts, asserts, cleans up, and asserts the world is clean
// again (no session for the pair, no snapshot row and no reaper row for any session id it used).
// The bite-proofs run ONE test at a time (`-g "<title>"`), so a test that depended on a sibling's
// setup would run against an EMPTY world — and the failure would be silent: a session id of ''
// becomes `BigInt('')` = 0n inside the hook, session 0 does not exist, and the reducer answers
// "trade session not found", which looks exactly like the non-participant refusal 5a/6a pin.
// Two defences: (1) no cross-test state, (2) `pairSessionId` hard-fails unless the id is a
// non-empty decimal integer read from server truth for THIS pair.
// `test.describe` is deliberately NOT `.serial`: under `.serial` one failure SKIPS the remaining
// tests, and the register needs the status of EVERY test per mutation.
//
// TEST TITLES ARE `-g` REGEX-SAFE: no parentheses, square brackets, braces, `?`, `+`, `*`, `|`
// or `$` in any title, so a full title pasted into `-g` matches literally.
//
// ASSERTION DISCIPLINE
// ====================
//   - Reducer rejections are asserted THREE-part: not-null, name === 'SenderError', message toBe
//     EXACT (never toContain: the session errors share words — "your offer is empty" vs "the other
//     offer is empty" — and only the exact string says which rule fired).
//   - Every Err test carries a CONTROL in the same test, of one of three kinds:
//       * LEG-DIFFERENTIAL (1a/3a): the identical offer MINUS the offending leg resolves Ok.
//       * ROLE-DIFFERENTIAL (5a/6a): the same reducer on the same session, called by a
//         participant, succeeds; only the CALLER varies.
//       * REVISION-DIFFERENTIAL (6b): the same participant's confirm at the CURRENT revision
//         reaches the side check instead; only the revision varies.
//     5b/5c are the positive halves of 5a; 4 is a positive delete-site test with a two-sided
//     arming assert.
//   - 1b/3b are PARTNER-STATE DIFFERENTIALS: the same caller script, two partner states proven
//     different by server truth, outcome lists deep-equal (and equal to the pinned expectation).
//   - State is read from SERVER TRUTH via owner `spacetime sql`, always scoped to the A/B pair or
//     to one session id — never a global row count.
//
// EARS / GUARD MAP (rule file and symbol; the strings are pinned below with file:line)
// ================
//   1a  set_trade_offer → check_offer_eligibility → check_offered_item
//       (session.rs): an item the CALLER does not hold → InsufficientItems
//   1b  ts-4.2: every caller-visible outcome is independent of the PARTNER's inventory
//   3a  set_trade_offer → check_offer_eligibility (session.rs): more coins than the CALLER
//       has → InsufficientCurrency
//   3b  ts-4.2: every caller-visible outcome is independent of the PARTNER's wallet
//   4   cancel_trade_session → delete_session (trading_session.rs): the partner cancels; the
//       session row, its snapshot rows and its reaper schedule row are all deleted
//   5a  find_own_session (trading_session.rs): a non-participant's cancel is the not-found
//       refusal, byte-identical to a missing session's; the session survives
//   5b  cancel_trade_session: the partner may cancel
//   5c  cancel_trade_session: the opener may cancel
//   6a  find_own_session in set_trade_offer AND confirm_trade_session: a non-participant gets
//       exactly what a missing session id gets; the session is unchanged
//   6b  can_confirm (session.rs): a stale revision is refused FIRST, for a participant, with
//       the stale-revision error and not a role or side error
//
// SEMGREP / PROJECT BANS OBSERVED IN THIS FILE: no dynamic `new RegExp`, no URL schemes anywhere
// including in comments (Semgrep matches comment text — say "the local server"), no focused-test
// marker, no shell: owner SQL goes through stdb.ts `ownerSql` (execFileSync, charset-checked).

// ---------------------------------------------------------------------------
// Shapes crossing the page.evaluate boundary. Re-declared locally on purpose: page.evaluate
// crosses a structured-clone boundary the type system cannot check. They mirror the
// `mrTradeHook` object in client/src/main.ts, whose members are exactly allPlayers,
// openTradeSession, setTradeOffer, confirmTradeSession, cancelTradeSession and mySessions
// (trade-full.spec.ts m16.5d-1 pins that key set).
// ---------------------------------------------------------------------------
interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  presenceCount: number;
  ownMonsters: Array<{
    monsterId: string; // bigint serialised as string — BigInt cannot cross evaluate
    partySlot: number;
  }>;
}

interface HookOffer {
  monsterIds: string[];
  items: { itemId: number; qty: number }[];
  currency: string;
}

interface HookSession {
  sessionId: string;
  opener: string;
  partner: string;
  revision: string;
  openerConfirmed: boolean;
  partnerConfirmed: boolean;
  openerOffer: HookOffer;
  partnerOffer: HookOffer;
}

interface MrTrade {
  openTradeSession(partnerHex: string): Promise<void> | undefined;
  setTradeOffer(sessionId: string, offer: HookOffer): Promise<void> | undefined;
  confirmTradeSession(sessionId: string, revision: string): Promise<void> | undefined;
  cancelTradeSession(sessionId: string): Promise<void> | undefined;
  mySessions(): HookSession[];
}

/** One reducer-promise rejection, flattened to clonable primitives INSIDE the page. */
interface ReducerRejection {
  name: string;
  message: string;
}

/** A reducer call described as data, so it can pass THROUGH page.evaluate without evaluating a
 *  source string in the page (dynamic code execution, and no type-checking of the hook args). */
type TradeAction =
  | { kind: 'open'; partner: string }
  | { kind: 'setOffer'; sessionId: string; offer: HookOffer }
  | { kind: 'confirm'; sessionId: string; revision: string }
  | { kind: 'cancel'; sessionId: string };

// ---------------------------------------------------------------------------
// EXPECTED SERVER MESSAGES — each pinned from source, with the line it sits on.
// A change to any of them is a deliberate API change made HERE, never by loosening an assertion.
// ---------------------------------------------------------------------------
/** server-module/src/trading_session.rs:282 `ERR_SESSION_NOT_FOUND`, returned by
 *  `find_own_session` (:566-582) for a missing session AND for one the caller is not party to. */
const ERR_SESSION_NOT_FOUND = 'trade session not found';
/** game-core/src/trading/session.rs:230-232 `TradeSessionError::InsufficientItems` Display,
 *  raised by `check_offered_item` (:356-360) against the CALLER's own stack. */
const errNotEnoughItem = (itemId: number): string => `not enough of item ${itemId} to offer`;
/** game-core/src/trading/session.rs:233 `InsufficientCurrency` Display, raised by
 *  `check_offer_eligibility` (:323-325) against the CALLER's own wallet. */
const ERR_NOT_ENOUGH_CURRENCY = 'not enough currency to offer';
/** game-core/src/trading/session.rs:234 `OwnSideEmpty` Display (`side_check` :386-388). */
const ERR_OWN_OFFER_EMPTY = 'your offer is empty';
/** game-core/src/trading/session.rs:235 `OtherSideEmpty` Display (`side_check` :389-391). */
const ERR_OTHER_OFFER_EMPTY = 'the other offer is empty';
/** game-core/src/trading/session.rs:241 `StaleRevision` Display (`can_confirm` :425-427),
 *  returned by confirm_trade_session (trading_session.rs:1164-1170) before anything else. */
const ERR_STALE_REVISION = 'the trade changed since you reviewed it';

/** A KNOWN item id (an `item_row` exists — check_offered_item refuses an unknown id FIRST with
 *  "unknown item N", session.rs:225/:350-352, which would move 1a/1b off the stack rule). Item 1
 *  is the bait recruit.spec.ts seeds; every test that uses it re-proves `item_row` holds it. */
const ITEM_X = 1;
/** The item quantity A offers in 1a/1b. > 0: qty 0 is ZeroItemQuantity (session.rs:353-355). */
const ITEM_X_QTY = 1;
/** What 1b seeds into B's stack of ITEM_X — strictly more than ITEM_X_QTY, so a reducer that
 *  reads the PARTNER's stack instead of the caller's finds enough and accepts. */
const PARTNER_ITEM_X_SEED = 5;
/** The coins A offers in 3a/3b against a provably empty own wallet. */
const OVERDRAWN_CURRENCY = '1';
/** What 3b seeds as B's balance — strictly more than OVERDRAWN_CURRENCY, so a reducer that read
 *  the PARTNER's wallet instead of the caller's finds enough and accepts. */
const PARTNER_WALLET_SEED = 100;
/** game-core `PARTY_SIZE` (game-core/src/world.rs): slots 0..6 are the party. */
const PARTY_SIZE = 6;
/** Walk A onto B's tile when they stand further apart than this (the server's range,
 *  game-core interact.rs `within_interact_range`, is wider; 1 leaves a latency margin). */
const WALK_IF_FURTHER_THAN = 1;
/** An offset no live session id reaches during a run (session_id is auto_inc, never reused):
 *  the "session that does not exist" of 5a/6a is `live id + GHOST_OFFSET`, proven absent. */
const GHOST_OFFSET = 1_000_000;

/** Settle window for server-truth reads: 20 polls x 500 ms = 10 s. */
const SQL_POLLS = 20;
const SQL_POLL_MS = 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Server truth via owner `spacetime sql` (stdb.ts `ownerSql`: execFileSync, no shell, a literal
// statement charset). The CLI runs as the module OWNER, so it reads the PRIVATE trade_session,
// trade_session_snapshot, trade_session_reaper_schedule, inventory and player_wallet tables.
// Every session-table read PROJECTS scalar columns only: the nested offer columns and the
// reaper's ScheduleAt sum type are never selected, so no cell rendering can shift the columns.
// ---------------------------------------------------------------------------

/** Parse `spacetime sql` stdout into row objects keyed BY HEADER NAME — STRICT, not stdb.ts's
 *  tolerant `sqlRows`: a header + separator + zero data lines is a valid EMPTY result; anything
 *  else, or a row whose cell count differs from the header's, THROWS. A tolerant parser returning
 *  [] on a shape surprise would make every "the row is gone" assertion here vacuously true. */
function parseSqlTable(stdout: string, label: string): Record<string, string>[] {
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
          `columns, so mapping by position would read the wrong values. Header: ` +
          `${header.trim()} | Row: ${line.trim()}`,
      );
    }
    const row: Record<string, string> = {};
    columns.forEach((col, i) => {
      row[col] = cells[i] ?? '';
    });
    return row;
  });
}

function sqlSelect(query: string, label: string): Record<string, string>[] {
  return parseSqlTable(ownerSql(query, label), label);
}

/** lowercase + strip a leading 0x (`spacetime sql` renders an Identity as 0x + 64 hex). */
function normalizeIdentity(id: string): string {
  const lower = id.toLowerCase();
  return lower.startsWith('0x') ? lower.slice(2) : lower;
}

/** The identity as the 64-hex literal an owner statement needs; throws on anything else. */
function identityHex(id: string, label: string): string {
  const hex = normalizeIdentity(id);
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`${label}: identity ${JSON.stringify(id)} is not 64 hex digits`);
  }
  return hex;
}

function assertDecimal(value: string, what: string, label: string): string {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(
      `${label}: ${what} ${JSON.stringify(value)} is not a decimal integer — refusing to use it`,
    );
  }
  return value;
}

/** One trade_session row, scalar columns only. Booleans lowercased. */
interface SessionRow {
  sessionId: string;
  opener: string;
  partner: string;
  revision: string;
  openerConfirmed: string;
  partnerConfirmed: string;
}

function allSessionRows(label: string): SessionRow[] {
  return sqlSelect(
    'SELECT session_id, opener, partner, revision, opener_confirmed, partner_confirmed FROM trade_session',
    label,
  ).map((r) => ({
    sessionId: (r.session_id ?? '').trim(),
    opener: normalizeIdentity(r.opener ?? ''),
    partner: normalizeIdentity(r.partner ?? ''),
    revision: (r.revision ?? '').trim(),
    openerConfirmed: (r.opener_confirmed ?? '').trim().toLowerCase(),
    partnerConfirmed: (r.partner_confirmed ?? '').trim().toLowerCase(),
  }));
}

/** Every session whose pair is exactly {a, b}, in EITHER orientation. */
function pairSessionRows(a: string, b: string, label: string): SessionRow[] {
  const na = normalizeIdentity(a);
  const nb = normalizeIdentity(b);
  return allSessionRows(label).filter(
    (r) => (r.opener === na && r.partner === nb) || (r.opener === nb && r.partner === na),
  );
}

function sessionRowsById(sessionId: string, label: string): SessionRow[] {
  return allSessionRows(label).filter((r) => r.sessionId === sessionId);
}

/** The trade_session_snapshot rows of one session, as `snapshot_id:monster_id`, sorted. */
function snapshotRowsFor(sessionId: string, label: string): string[] {
  return sqlSelect('SELECT snapshot_id, session_id, monster_id FROM trade_session_snapshot', label)
    .filter((r) => (r.session_id ?? '').trim() === sessionId)
    .map((r) => `${(r.snapshot_id ?? '').trim()}:${(r.monster_id ?? '').trim()}`)
    .sort();
}

/** The trade_session_reaper_schedule rows armed for one session (scheduled ids). */
function reaperRowsFor(sessionId: string, label: string): string[] {
  return sqlSelect('SELECT scheduled_id, session_id FROM trade_session_reaper_schedule', label)
    .filter((r) => (r.session_id ?? '').trim() === sessionId)
    .map((r) => (r.scheduled_id ?? '').trim());
}

/** `owner`'s inventory rows of `itemId` (inventory is all-scalar: inv_id, owner_identity,
 *  item_id, count). */
function inventoryRowsOf(owner: string, itemId: number, label: string): Record<string, string>[] {
  const hex = normalizeIdentity(owner);
  return sqlSelect('SELECT * FROM inventory', label).filter(
    (r) =>
      normalizeIdentity(r.owner_identity ?? '') === hex && (r.item_id ?? '').trim() === `${itemId}`,
  );
}

/** `owner`'s player_wallet rows (PK owner_identity, so 0 or 1). */
function walletRowsOf(owner: string, label: string): Record<string, string>[] {
  const hex = normalizeIdentity(owner);
  return sqlSelect('SELECT * FROM player_wallet', label).filter(
    (r) => normalizeIdentity(r.owner_identity ?? '') === hex,
  );
}

/** A wallet's spendable balance as server truth holds it: no row reads 0. */
function balanceOf(owner: string, label: string): string {
  const rows = walletRowsOf(owner, label);
  if (rows.length > 1) throw new Error(`${label}: ${rows.length} wallet rows for one owner`);
  return (rows[0]?.balance ?? '0').trim();
}

async function pollSql<T>(read: () => T, done: (v: T) => boolean): Promise<T> {
  let value = read();
  for (let i = 0; i < SQL_POLLS && !done(value); i += 1) {
    await sleep(SQL_POLL_MS);
    value = read();
  }
  return value;
}

/** Wait for, and assert, the number of pair-scoped session rows in server truth. */
async function expectPairSessions(
  a: string,
  b: string,
  expected: number,
  label: string,
): Promise<SessionRow[]> {
  const rows = await pollSql(
    () => pairSessionRows(a, b, label),
    (r) => r.length === expected,
  );
  expect(
    rows.length,
    `${label}: server truth must hold exactly ${expected} trade_session row(s) for the pair ` +
      `after the settle window, found ${rows.length}`,
  ).toBe(expected);
  return rows;
}

/** The single pair-scoped session's id, hard-validated, and that A opened it with B. */
function pairSessionId(rows: SessionRow[], opener: string, label: string): string {
  if (rows.length !== 1) {
    throw new Error(`${label}: expected exactly 1 pair-scoped session row, found ${rows.length}`);
  }
  const row = rows[0];
  if (row === undefined) throw new Error(`${label}: row 0 missing after a length check`);
  expect(row.opener, `${label}: the session's opener is the caller`).toBe(
    normalizeIdentity(opener),
  );
  return assertDecimal(row.sessionId, 'session_id', label);
}

/** The session, its snapshot rows and its reaper row are ALL gone (each polled). */
async function expectSessionGone(sessionId: string, label: string, why = ''): Promise<void> {
  const rows = await pollSql(
    () => sessionRowsById(sessionId, label),
    (r) => r.length === 0,
  );
  expect(rows.length, `${label}: trade_session ${sessionId} must be deleted ${why}`).toBe(0);
  const snaps = await pollSql(
    () => snapshotRowsFor(sessionId, label),
    (r) => r.length === 0,
  );
  expect(
    snaps,
    `${label}: no trade_session_snapshot row may outlive session ${sessionId} ${why}`,
  ).toEqual([]);
  const reapers = await pollSql(
    () => reaperRowsFor(sessionId, label),
    (r) => r.length === 0,
  );
  expect(
    reapers,
    `${label}: no trade_session_reaper_schedule row may outlive session ${sessionId} ${why}`,
  ).toEqual([]);
}

/** Everything server truth says about one live session that a refused call must not change. */
function sessionFacts(sessionId: string, label: string): string {
  const rows = sessionRowsById(sessionId, label);
  return JSON.stringify({
    rows,
    snapshots: snapshotRowsFor(sessionId, label),
    reapers: reaperRowsFor(sessionId, label),
  });
}

// ---------------------------------------------------------------------------
// Page helpers.
// ---------------------------------------------------------------------------

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

/** EXACT presence on every page: proves each page holds the other two players' rows, and fails
 *  loud on a leaked identity from an earlier spec file (`>= 3` would tolerate it). */
async function waitForPresence3(p: Page): Promise<void> {
  await p.waitForFunction(
    () => (window as unknown as { __game: () => GameSnap }).__game().presenceCount === 3,
    null,
    { timeout: 30_000 },
  );
}

/** PROJECT the fields this file needs — `__game()` carries functions that do not clone. */
async function snap(
  p: Page,
): Promise<Pick<GameSnap, 'identity' | 'presenceCount' | 'ownMonsters'>> {
  return p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      identity: g.identity,
      presenceCount: g.presenceCount,
      ownMonsters: g.ownMonsters.map((m) => ({ monsterId: m.monsterId, partySlot: m.partySlot })),
    };
  });
}

/** The identity's lowest-slot PARTY monster — the asset every offer here lists. Nothing in this
 *  file executes a trade, so it never leaves its owner. */
async function partyMonsterId(p: Page, label: string): Promise<string> {
  const party = (await snap(p)).ownMonsters
    .filter((m) => m.partySlot < PARTY_SIZE)
    .sort((x, y) => x.partySlot - y.partySlot);
  const first = party[0];
  if (first === undefined) {
    throw new Error(`${label}: this identity has no party monster — join_game grants a starter`);
  }
  return assertDecimal(first.monsterId, 'monster id', label);
}

const manhattan = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Puts `mover` within range of `anchor` for open_trade_session: same zone required; walks onto
 *  the anchor's tile (grass-free, warp-free `walkTo`) when further than WALK_IF_FURTHER_THAN. */
async function ensureInRange(mover: Page, anchor: Page, label: string): Promise<void> {
  const there = await readWorld(anchor);
  const here = await readWorld(mover);
  if (there.ownAuthTile === null || here.ownAuthTile === null) {
    throw new Error(`${label}: a character has no authoritative tile`);
  }
  expect(here.map.zone_id, `${label}: opener and partner must be in the same zone`).toBe(
    there.map.zone_id,
  );
  if (manhattan(here.ownAuthTile, there.ownAuthTile) > WALK_IF_FURTHER_THAN) {
    if ((await walkTo(mover, there.ownAuthTile, label)) === 'battle') {
      throw new Error(`${label}: a battle started on the grass-free walk to the partner`);
    }
  }
  const after = await readWorld(mover);
  if (after.ownAuthTile === null) throw new Error(`${label}: no own tile after the walk`);
  expect(
    manhattan(after.ownAuthTile, there.ownAuthTile),
    `${label}: the opener must stand next to the partner before the open`,
  ).toBeLessThanOrEqual(WALK_IF_FURTHER_THAN);
}

/** Drive ONE reducer through window.__mrTrade and report its outcome as data: null when it
 *  resolved Ok, {name, message} when it rejected. Ids are validated BEFORE the page sees them.
 *  Inside the evaluate: a missing hook throws; a hook returning undefined (connection not live)
 *  throws, because `await undefined` resolves and would fake an Ok; the await happens IN the
 *  page so a rejection never becomes an unhandledrejection (and an error overlay). */
async function errorOf(
  p: Page,
  action: TradeAction,
  label: string,
): Promise<ReducerRejection | null> {
  if (action.kind === 'open') identityHex(action.partner, label);
  else assertDecimal(action.sessionId, 'session id', label);
  if (action.kind === 'confirm') assertDecimal(action.revision, 'revision', label);
  return p.evaluate(async (a: TradeAction): Promise<ReducerRejection | null> => {
    const hook = (window as unknown as { __mrTrade?: MrTrade }).__mrTrade;
    if (hook === undefined) {
      throw new Error('window.__mrTrade is missing — the DEV-gated trade hook is not installed');
    }
    const call =
      a.kind === 'open'
        ? hook.openTradeSession(a.partner)
        : a.kind === 'setOffer'
          ? hook.setTradeOffer(a.sessionId, a.offer)
          : a.kind === 'confirm'
            ? hook.confirmTradeSession(a.sessionId, a.revision)
            : hook.cancelTradeSession(a.sessionId);
    if (call === undefined) {
      throw new Error(
        `__mrTrade ${a.kind} returned undefined — the connection is not live; awaiting ` +
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
  const rejection = await errorOf(p, action, label);
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
    `${label}: the reducer RESOLVED — the rule did not fire. Expected a rejection carrying ` +
      `${JSON.stringify(expectedMessage)}`,
  ).not.toBeNull();
  expect(
    rejection?.name,
    `${label}: the rejection must be a SenderError (a reducer Err addressed to the caller); an ` +
      `InternalError means the reducer panicked instead of refusing`,
  ).toBe('SenderError');
  expect(
    rejection?.message,
    `${label}: EXACT server message mismatch — a different rule fired. Expected ` +
      `${JSON.stringify(expectedMessage)}, got ${JSON.stringify(rejection?.message)}`,
  ).toBe(expectedMessage);
}

/** Opens a session A→B through the hook (range ensured first) and returns its server-truth id. */
async function openSession(
  opener: Page,
  partnerPage: Page,
  openerId: string,
  partnerId: string,
  label: string,
): Promise<string> {
  await ensureInRange(opener, partnerPage, label);
  await expectPairSessions(openerId, partnerId, 0, `${label} precondition: no session yet`);
  await expectOk(opener, { kind: 'open', partner: partnerId }, `${label} open`);
  const rows = await expectPairSessions(openerId, partnerId, 1, `${label} after open`);
  const sid = pairSessionId(rows, openerId, `${label} after open`);
  expect(rows[0]?.revision, `${label}: a fresh session has revision 0`).toBe('0');
  return sid;
}

const monsterOffer = (monsterId: string): HookOffer => ({
  monsterIds: [monsterId],
  items: [],
  currency: '0',
});
const EMPTY_OFFER: HookOffer = { monsterIds: [], items: [], currency: '0' };

// ---------------------------------------------------------------------------
// The 1b/3b caller script and its normalised record.
// ---------------------------------------------------------------------------

/** A's `mySessions()` row for the pair with the session id and the identities normalised out:
 *  the session id differs between the two runs by construction (auto_inc), nothing else may. */
interface NormalisedSession {
  session: string;
  opener: string;
  partner: string;
  revision: string;
  openerConfirmed: boolean;
  partnerConfirmed: boolean;
  openerOffer: HookOffer;
  partnerOffer: HookOffer;
}

interface StepRecord {
  step: string;
  result: ReducerRejection | 'Ok';
  /** Server truth for the pair after the step: `revision/openerConfirmed/partnerConfirmed`. */
  server: string[];
  /** A's own view after the step (the hook's mySessions, normalised). */
  view: NormalisedSession[];
}

const pairView = (p: Page, me: string, other: string): Promise<HookSession[]> =>
  p.evaluate(
    ({ me: a, other: b }) => {
      const hook = (window as unknown as { __mrTrade?: MrTrade }).__mrTrade;
      if (hook === undefined) throw new Error('window.__mrTrade is missing');
      return hook
        .mySessions()
        .filter((s) => (s.opener === a && s.partner === b) || (s.opener === b && s.partner === a));
    },
    { me, other },
  );

test.describe('ts-4 — trade session negative paths, three identities, server truth', () => {
  // `| undefined`: if beforeAll throws, teardown still runs and must not blow up first.
  let browser: Browser | undefined;
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let ctxC: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page;
  let identityA = '';
  let identityB = '';
  let identityC = '';

  const role = (id: string): string => {
    const n = normalizeIdentity(id);
    if (n === normalizeIdentity(identityA)) return 'A';
    if (n === normalizeIdentity(identityB)) return 'B';
    return `other:${n}`;
  };

  const pairFacts = (label: string): string[] =>
    pairSessionRows(identityA, identityB, label).map(
      (r) => `${r.revision}/${r.openerConfirmed}/${r.partnerConfirmed}`,
    );

  /** Waits until A's hook view of the pair agrees with server truth (rows, revision, confirms)
   *  and returns both, normalised. Makes each recorded projection deterministic: a reducer
   *  promise and its subscription update need not land in the same tick. */
  async function settledRecord(
    step: string,
    result: ReducerRejection | null,
    label: string,
  ): Promise<StepRecord> {
    const viewFacts = async (): Promise<string[]> =>
      (await pairView(pageA, identityA, identityB)).map(
        (s) => `${s.revision}/${s.openerConfirmed}/${s.partnerConfirmed}`,
      );
    await expect
      .poll(async () => JSON.stringify(await viewFacts()) === JSON.stringify(pairFacts(label)), {
        message: `${label} ${step}: A's mySessions view converges on server truth`,
        timeout: 15_000,
      })
      .toBe(true);
    const view = (await pairView(pageA, identityA, identityB)).map(
      (s): NormalisedSession => ({
        session: '<session>',
        opener: role(s.opener),
        partner: role(s.partner),
        revision: s.revision,
        openerConfirmed: s.openerConfirmed,
        partnerConfirmed: s.partnerConfirmed,
        openerOffer: s.openerOffer,
        partnerOffer: s.partnerOffer,
      }),
    );
    return { step, result: result ?? 'Ok', server: pairFacts(label), view };
  }

  /** THE caller script of 1b and 3b, run by A against B. B does NOTHING in it, so B's side is
   *  empty in every run. Returns every step's outcome and A's view, plus the session id (for
   *  the cleanup check only — it is normalised out of the records). */
  async function runCallerScript(
    monsterA: string,
    label: string,
  ): Promise<{ records: StepRecord[]; sessionId: string }> {
    const records: StepRecord[] = [];
    await ensureInRange(pageA, pageB, label);
    await expectPairSessions(identityA, identityB, 0, `${label} precondition: no session yet`);
    const opened = await errorOf(pageA, { kind: 'open', partner: identityB }, label);
    records.push(await settledRecord('open', opened, label));
    if (opened !== null) return { records, sessionId: '' };
    const sid = pairSessionId(
      await expectPairSessions(identityA, identityB, 1, `${label} after open`),
      identityA,
      label,
    );
    const step = async (name: string, action: TradeAction): Promise<void> => {
      records.push(await settledRecord(name, await errorOf(pageA, action, label), label));
    };
    await step('set own monster', {
      kind: 'setOffer',
      sessionId: sid,
      offer: monsterOffer(monsterA),
    });
    await step('set own monster plus an item A does not hold', {
      kind: 'setOffer',
      sessionId: sid,
      offer: { ...monsterOffer(monsterA), items: [{ itemId: ITEM_X, qty: ITEM_X_QTY }] },
    });
    await step('set own monster plus a coin A does not have', {
      kind: 'setOffer',
      sessionId: sid,
      offer: { ...monsterOffer(monsterA), currency: OVERDRAWN_CURRENCY },
    });
    const seen = (await pairView(pageA, identityA, identityB))[0]?.revision ?? '';
    await step('confirm at the revision A sees', {
      kind: 'confirm',
      sessionId: sid,
      revision: seen,
    });
    await step('confirm at revision 0', { kind: 'confirm', sessionId: sid, revision: '0' });
    await step('cancel', { kind: 'cancel', sessionId: sid });
    return { records, sessionId: sid };
  }

  /** What the caller script MUST produce, whatever the partner holds. */
  function expectedScript(monsterA: string): StepRecord[] {
    const rej = (message: string): ReducerRejection => ({ name: 'SenderError', message });
    const live = (revision: string, mine: HookOffer): NormalisedSession[] => [
      {
        session: '<session>',
        opener: 'A',
        partner: 'B',
        revision,
        openerConfirmed: false,
        partnerConfirmed: false,
        openerOffer: mine,
        partnerOffer: EMPTY_OFFER,
      },
    ];
    const offered = monsterOffer(monsterA);
    return [
      { step: 'open', result: 'Ok', server: ['0/false/false'], view: live('0', EMPTY_OFFER) },
      {
        step: 'set own monster',
        result: 'Ok',
        server: ['1/false/false'],
        view: live('1', offered),
      },
      {
        step: 'set own monster plus an item A does not hold',
        result: rej(errNotEnoughItem(ITEM_X)),
        server: ['1/false/false'],
        view: live('1', offered),
      },
      {
        step: 'set own monster plus a coin A does not have',
        result: rej(ERR_NOT_ENOUGH_CURRENCY),
        server: ['1/false/false'],
        view: live('1', offered),
      },
      {
        step: 'confirm at the revision A sees',
        result: rej(ERR_OTHER_OFFER_EMPTY),
        server: ['1/false/false'],
        view: live('1', offered),
      },
      {
        step: 'confirm at revision 0',
        result: rej(ERR_STALE_REVISION),
        server: ['1/false/false'],
        view: live('1', offered),
      },
      { step: 'cancel', result: 'Ok', server: [], view: [] },
    ];
  }

  /** A's own side holds no ITEM_X and no coin, and ITEM_X is a known item: the preconditions
   *  that make "not enough of item X" / "not enough currency" the CALLER's own refusal. */
  function expectCallerHoldsNothing(label: string): void {
    const known = sqlSelect('SELECT id FROM item_row', label).map((r) => (r.id ?? '').trim());
    expect(known, `${label}: item ${ITEM_X} must exist in item_row`).toContain(`${ITEM_X}`);
    expect(
      inventoryRowsOf(identityA, ITEM_X, label),
      `${label}: A must hold no stack of item ${ITEM_X}`,
    ).toEqual([]);
    expect(balanceOf(identityA, label), `${label}: A must hold no coin`).toBe('0');
  }

  /** Cancel every live session involving A, B or C and await it — and its snapshot and reaper
   *  rows — GONE. Runs after EVERY test and at teardown: a test that fails midway would
   *  otherwise leave a session and every later sibling's "no session yet" precondition would
   *  fail on the debris. It runs strictly AFTER a test's expectations and only removes state. */
  async function sweepSessions(label: string): Promise<void> {
    const parties: Array<{ page: Page; identity: string }> = [
      { page: pageA, identity: identityA },
      { page: pageB, identity: identityB },
      { page: pageC, identity: identityC },
    ];
    for (const row of allSessionRows(label)) {
      const owner = parties.find((p) => {
        const norm = normalizeIdentity(p.identity);
        // An EMPTY identity (beforeAll failed early) matches nothing.
        return norm !== '' && (norm === row.opener || norm === row.partner);
      });
      if (owner === undefined || !/^[0-9]+$/.test(row.sessionId)) continue;
      const rejection = await errorOf(
        owner.page,
        { kind: 'cancel', sessionId: row.sessionId },
        label,
      );
      await expectSessionGone(
        row.sessionId,
        label,
        `by the sweep cancel, which returned ${JSON.stringify(rejection)}`,
      );
    }
  }

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    const launched = await chromium.launch();
    browser = launched;
    ctxA = await launched.newContext();
    ctxB = await launched.newContext();
    ctxC = await launched.newContext();
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
    pageC = await ctxC.newPage();
    await pageA.goto('/');
    await pageB.goto('/');
    await pageC.goto('/');
    await Promise.all([gameReady(pageA), gameReady(pageB), gameReady(pageC)]);
    await Promise.all([waitForPresence3(pageA), waitForPresence3(pageB), waitForPresence3(pageC)]);
    const [ga, gb, gc] = await Promise.all([snap(pageA), snap(pageB), snap(pageC)]);
    identityA = ga.identity;
    identityB = gb.identity;
    identityC = gc.identity;
    // Pairwise distinct, each with its consequence: A = B makes every open a SelfTrade; C equal
    // to A or B makes C a PARTICIPANT and turns 5a/6a into "a participant is accepted".
    expect(identityA, 'A and B must be distinct identities').not.toBe(identityB);
    expect(identityA, 'A and C must be distinct identities').not.toBe(identityC);
    expect(identityB, 'B and C must be distinct identities').not.toBe(identityC);
  });

  test.afterEach(async () => {
    await sweepSessions('afterEach sweep');
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    try {
      await sweepSessions('afterAll sweep');
    } finally {
      await browser?.close();
    }
  });

  // -------------------------------------------------------------------------
  // 1a — the CALLER's own item leg (check_offered_item, session.rs).
  //
  // LEG-DIFFERENTIAL: the same offer minus the item resolves Ok first, so the refusal is the
  // item leg's and not the session lookup's, the size cap's or the monster's.
  // WHAT THIS KILLS: `item.qty > unlocked` → `<` or deleted (the unheld item is accepted and
  // the call resolves); a refused edit that still writes (the revision or the snapshot rows
  // move); a message other than the caller's own stack refusal.
  // -------------------------------------------------------------------------
  test('1a: set_trade_offer listing an item the caller does not hold is refused with the own-side error, and the same offer without it is accepted', async () => {
    test.setTimeout(120_000);
    const label = '1a';
    expectCallerHoldsNothing(label);
    const monsterA = await partyMonsterId(pageA, label);
    const sid = await openSession(pageA, pageB, identityA, identityB, label);

    await expectOk(
      pageA,
      { kind: 'setOffer', sessionId: sid, offer: monsterOffer(monsterA) },
      `${label} control: the offer without the item`,
    );
    await expect
      .poll(() => sessionRowsById(sid, label)[0]?.revision ?? null, {
        message: `${label}: the accepted edit advances the revision to 1`,
        timeout: 10_000,
      })
      .toBe('1');
    const before = sessionFacts(sid, label);
    expect(snapshotRowsFor(sid, label).length, `${label}: one snapshot row for one monster`).toBe(
      1,
    );

    const rejection = await errorOf(
      pageA,
      {
        kind: 'setOffer',
        sessionId: sid,
        offer: { ...monsterOffer(monsterA), items: [{ itemId: ITEM_X, qty: ITEM_X_QTY }] },
      },
      label,
    );
    expectRejection(rejection, errNotEnoughItem(ITEM_X), label);
    expect(sessionFacts(sid, label), `${label}: the refused edit wrote nothing`).toBe(before);

    await expectOk(pageA, { kind: 'cancel', sessionId: sid }, `${label} cleanup cancel`);
    await expectSessionGone(sid, `${label} cleanup`);
    await expectPairSessions(identityA, identityB, 0, `${label} world clean`);
  });

  // -------------------------------------------------------------------------
  // 1b — ts-4.2, the PARTNER's INVENTORY (the no-oracle security case).
  //
  // The same caller script runs twice against B: run 1 with B holding NO stack of ITEM_X,
  // run 2 with B holding PARTNER_ITEM_X_SEED of it (owner SQL), the difference proven by a
  // server-truth SELECT before run 2. The two outcome lists — every call's Ok or exact error,
  // plus server truth and A's own view after each step — must be deep-equal, and equal to the
  // pinned expectation.
  //
  // A reducer that never reads the partner passes this by construction, so its bite is a wrong
  // reducer, not a red first run. WHAT THIS KILLS: a session reducer whose result or error text
  // depends on the partner's stack (one that answers "counterparty has insufficient inventory
  // for item N" when the partner lacks the item fails here), and the wrong-party operand: an
  // eligibility check that reads `stacks` of the partner instead of the caller accepts A's
  // one-unit item leg in run 2 only.
  // -------------------------------------------------------------------------
  test('1b: every caller-visible trade session outcome is identical whether or not the partner holds the item', async () => {
    test.setTimeout(180_000);
    const label = '1b';
    expectCallerHoldsNothing(label);
    const monsterA = await partyMonsterId(pageA, label);
    const hexB = identityHex(identityB, label);
    expect(
      inventoryRowsOf(identityB, ITEM_X, label),
      `${label} state 1: B holds no stack of item ${ITEM_X}`,
    ).toEqual([]);

    let seededInvId = '';
    try {
      const run1 = await runCallerScript(monsterA, `${label} run 1, partner without the item`);
      // One live session per pair: run 1's must be gone, rows and all, before B changes.
      if (run1.sessionId !== '') await expectSessionGone(run1.sessionId, `${label} run 1 end`);
      await expectPairSessions(identityA, identityB, 0, `${label} between the runs`);

      const state1 = inventoryRowsOf(identityB, ITEM_X, `${label} state 1`);
      ownerSql(
        `INSERT INTO inventory (inv_id, owner_identity, item_id, count) VALUES (0, 0x${hexB}, ${ITEM_X}, ${PARTNER_ITEM_X_SEED})`,
        `${label} seed the partner's stack`,
      );
      const state2 = await pollSql(
        () => inventoryRowsOf(identityB, ITEM_X, `${label} state 2`),
        (r) => r.length === 1,
      );
      seededInvId = assertDecimal((state2[0]?.inv_id ?? '').trim(), 'inv_id', label);
      // THE NON-VACUITY PROOF: the two partner states really differ in server truth.
      expect(state1, `${label} state 1: no stack`).toEqual([]);
      expect(state2.length, `${label} state 2: exactly one stack`).toBe(1);
      expect((state2[0]?.count ?? '').trim(), `${label} state 2: the seeded count`).toBe(
        `${PARTNER_ITEM_X_SEED}`,
      );
      expect(
        Number((state2[0]?.count ?? '0').trim()),
        `${label}: the partner holds MORE than A's item leg asks, so a partner-reading rule would accept`,
      ).toBeGreaterThan(ITEM_X_QTY);

      const run2 = await runCallerScript(monsterA, `${label} run 2, partner holding the item`);
      if (run2.sessionId !== '') await expectSessionGone(run2.sessionId, `${label} run 2 end`);
      expect(run2.sessionId, `${label}: run 2 opened a NEW session`).not.toBe(run1.sessionId);

      expect(
        run2.records,
        `${label}: the caller-visible outcome must not depend on the partner's inventory`,
      ).toEqual(run1.records);
      expect(run1.records, `${label}: the outcome is the caller-own-side script`).toEqual(
        expectedScript(monsterA),
      );
      expect(
        inventoryRowsOf(identityB, ITEM_X, `${label} partner untouched`).map((r) =>
          (r.count ?? '').trim(),
        ),
        `${label}: nothing moved the partner's stack`,
      ).toEqual([`${PARTNER_ITEM_X_SEED}`]);
    } finally {
      if (seededInvId !== '') {
        ownerSql(`DELETE FROM inventory WHERE inv_id = ${seededInvId}`, `${label} restore`);
      }
      const left = await pollSql(
        () => inventoryRowsOf(identityB, ITEM_X, `${label} restore`),
        (r) => r.length === 0,
      );
      expect(left, `${label} restore: B's seeded stack is gone`).toEqual([]);
    }
    await expectPairSessions(identityA, identityB, 0, `${label} world clean`);
  });

  // -------------------------------------------------------------------------
  // 3a — the CALLER's own coins (check_offer_eligibility's currency rule, session.rs).
  //
  // A fresh identity has no player_wallet row: the balance is provably 0 (re-proven below).
  // WHAT THIS KILLS: `currency > balance - locked` → `<` or deleted (the coin is accepted and
  // the call resolves); a refused edit that still writes.
  // -------------------------------------------------------------------------
  test('3a: set_trade_offer listing more coins than the caller has is refused with the own-side error, and the same offer without them is accepted', async () => {
    test.setTimeout(120_000);
    const label = '3a';
    expectCallerHoldsNothing(label);
    const monsterA = await partyMonsterId(pageA, label);
    const sid = await openSession(pageA, pageB, identityA, identityB, label);

    await expectOk(
      pageA,
      { kind: 'setOffer', sessionId: sid, offer: monsterOffer(monsterA) },
      `${label} control: the offer without the coins`,
    );
    await expect
      .poll(() => sessionRowsById(sid, label)[0]?.revision ?? null, {
        message: `${label}: the accepted edit advances the revision to 1`,
        timeout: 10_000,
      })
      .toBe('1');
    const before = sessionFacts(sid, label);

    const rejection = await errorOf(
      pageA,
      {
        kind: 'setOffer',
        sessionId: sid,
        offer: { ...monsterOffer(monsterA), currency: OVERDRAWN_CURRENCY },
      },
      label,
    );
    expectRejection(rejection, ERR_NOT_ENOUGH_CURRENCY, label);
    expect(sessionFacts(sid, label), `${label}: the refused edit wrote nothing`).toBe(before);

    await expectOk(pageA, { kind: 'cancel', sessionId: sid }, `${label} cleanup cancel`);
    await expectSessionGone(sid, `${label} cleanup`);
    await expectPairSessions(identityA, identityB, 0, `${label} world clean`);
  });

  // -------------------------------------------------------------------------
  // 3b — ts-4.2, the PARTNER's WALLET (the second security case).
  //
  // Same caller script, two partner states: run 1 with B holding no coin (no player_wallet row,
  // or a zero balance), run 2 with B's balance seeded to PARTNER_WALLET_SEED by owner SQL; the
  // difference proven by a server-truth SELECT before run 2; the two outcome lists deep-equal.
  //
  // As in 1b, a reducer that never reads the partner passes by construction. WHAT THIS KILLS: a
  // session reducer whose result or error text depends on the partner's wallet (one that
  // answers "counterparty has insufficient currency for this trade" when the partner is broke
  // fails here), and the wrong-party operand: a currency rule that reads the partner's balance
  // instead of the caller's accepts A's one-coin leg in run 2 only.
  // -------------------------------------------------------------------------
  test('3b: every caller-visible trade session outcome is identical whether or not the partner has coins', async () => {
    test.setTimeout(180_000);
    const label = '3b';
    expectCallerHoldsNothing(label);
    const monsterA = await partyMonsterId(pageA, label);
    const hexB = identityHex(identityB, label);
    const original = walletRowsOf(identityB, `${label} state 1`);
    expect(original.length, `${label}: at most one wallet row for B`).toBeLessThanOrEqual(1);
    expect(balanceOf(identityB, label), `${label} state 1: B holds no coin`).toBe('0');
    const hadRow = original.length === 1;

    let seeded = false;
    try {
      const run1 = await runCallerScript(monsterA, `${label} run 1, partner without coins`);
      if (run1.sessionId !== '') await expectSessionGone(run1.sessionId, `${label} run 1 end`);
      await expectPairSessions(identityA, identityB, 0, `${label} between the runs`);

      const state1 = balanceOf(identityB, `${label} state 1`);
      ownerSql(
        hadRow
          ? `UPDATE player_wallet SET balance = ${PARTNER_WALLET_SEED} WHERE owner_identity = 0x${hexB}`
          : `INSERT INTO player_wallet (owner_identity, balance) VALUES (0x${hexB}, ${PARTNER_WALLET_SEED})`,
        `${label} seed the partner's wallet`,
      );
      seeded = true;
      const state2 = await pollSql(
        () => balanceOf(identityB, `${label} state 2`),
        (b) => b === `${PARTNER_WALLET_SEED}`,
      );
      // THE NON-VACUITY PROOF: the two partner states really differ in server truth.
      expect(state1, `${label} state 1: zero`).toBe('0');
      expect(state2, `${label} state 2: the seeded balance`).toBe(`${PARTNER_WALLET_SEED}`);
      expect(
        PARTNER_WALLET_SEED,
        `${label}: the partner holds MORE than A's coin leg asks, so a partner-reading rule would accept`,
      ).toBeGreaterThan(Number(OVERDRAWN_CURRENCY));

      const run2 = await runCallerScript(monsterA, `${label} run 2, partner with coins`);
      if (run2.sessionId !== '') await expectSessionGone(run2.sessionId, `${label} run 2 end`);
      expect(run2.sessionId, `${label}: run 2 opened a NEW session`).not.toBe(run1.sessionId);

      expect(
        run2.records,
        `${label}: the caller-visible outcome must not depend on the partner's wallet`,
      ).toEqual(run1.records);
      expect(run1.records, `${label}: the outcome is the caller-own-side script`).toEqual(
        expectedScript(monsterA),
      );
      expect(balanceOf(identityB, `${label} partner untouched`), `${label}: B's coins stay`).toBe(
        `${PARTNER_WALLET_SEED}`,
      );
    } finally {
      if (seeded) {
        ownerSql(
          hadRow
            ? `UPDATE player_wallet SET balance = 0 WHERE owner_identity = 0x${hexB}`
            : `DELETE FROM player_wallet WHERE owner_identity = 0x${hexB}`,
          `${label} restore`,
        );
      }
      const restored = await pollSql(
        () => walletRowsOf(identityB, `${label} restore`).length,
        (n) => n === (hadRow ? 1 : 0),
      );
      expect(restored, `${label} restore: B's wallet row count is back`).toBe(hadRow ? 1 : 0);
      expect(balanceOf(identityB, `${label} restore`), `${label} restore: B holds no coin`).toBe(
        '0',
      );
    }
    await expectPairSessions(identityA, identityB, 0, `${label} world clean`);
  });

  // -------------------------------------------------------------------------
  // 4 — the partner cancels: delete_session removes the session row, its snapshot rows AND its
  // reaper schedule row (trading_session.rs `delete_session` → `delete_session_rows`).
  //
  // TWO-SIDED ARMING: each "is gone" is preceded by "exactly this existed", so deleting the
  // arming (`arm_session_reaper`) or the snapshot insert cannot make the disarm pass trivially.
  // WHAT THIS KILLS: a cancel that leaves the reaper row (the schedule loop dropped), that
  // leaves the snapshot rows (`delete_snapshots` dropped), or that refuses the partner.
  // -------------------------------------------------------------------------
  test('4: the partner cancels and the session row, its snapshot rows and its reaper schedule row are all gone', async () => {
    test.setTimeout(120_000);
    const label = '4';
    const monsterA = await partyMonsterId(pageA, label);
    const sid = await openSession(pageA, pageB, identityA, identityB, label);
    await expectOk(
      pageA,
      { kind: 'setOffer', sessionId: sid, offer: monsterOffer(monsterA) },
      `${label} A offers its monster`,
    );

    const snaps = await pollSql(
      () => snapshotRowsFor(sid, label),
      (r) => r.length === 1,
    );
    expect(
      snaps.map((s) => s.split(':')[1]),
      `${label}: armed — one snapshot row, for A's offered monster`,
    ).toEqual([monsterA]);
    expect(reaperRowsFor(sid, label).length, `${label}: armed — one reaper schedule row`).toBe(1);

    await expectOk(pageB, { kind: 'cancel', sessionId: sid }, `${label} the partner cancels`);
    await expectSessionGone(sid, `${label} after the partner's cancel`);
    await expectPairSessions(identityA, identityB, 0, `${label} world clean`);
  });

  // -------------------------------------------------------------------------
  // 5a — a NON-participant cannot cancel (find_own_session, trading_session.rs).
  //
  // C is joined but neither opener nor partner. C's cancel on the live session must be the
  // byte-identical refusal C gets for a session id that does not exist (so it leaks nothing
  // about the session), and the session must survive untouched. ROLE-DIFFERENTIAL half: the
  // same reducer on the same session, called by the opener, succeeds.
  // WHAT THIS KILLS: a cancel with no participant check (C deletes it); a distinct "not a
  // party" message that confirms the session exists; a cancel that refuses everyone.
  // -------------------------------------------------------------------------
  test('5a: a non-participant cancel_trade_session is refused exactly like a missing session and the session survives', async () => {
    test.setTimeout(120_000);
    const label = '5a';
    const sid = await openSession(pageA, pageB, identityA, identityB, label);
    const ghost = (BigInt(sid) + BigInt(GHOST_OFFSET)).toString();
    expect(sessionRowsById(ghost, label), `${label}: session ${ghost} does not exist`).toEqual([]);
    const before = sessionFacts(sid, label);
    expect(reaperRowsFor(sid, label).length, `${label}: the session is armed`).toBe(1);

    const onLive = await errorOf(pageC, { kind: 'cancel', sessionId: sid }, `${label} live`);
    const onGhost = await errorOf(pageC, { kind: 'cancel', sessionId: ghost }, `${label} ghost`);
    expectRejection(onLive, ERR_SESSION_NOT_FOUND, `${label} on the live session`);
    expectRejection(onGhost, ERR_SESSION_NOT_FOUND, `${label} on a missing session`);
    expect(onLive, `${label}: the live-session refusal is byte-identical to a missing one`).toEqual(
      onGhost,
    );
    // Transactional rollback makes this unable to fail on its own while the refusal holds; it
    // stays to catch a delete moved OUT of the reducer transaction.
    expect(sessionFacts(sid, label), `${label}: the session survives untouched`).toBe(before);

    await expectOk(pageA, { kind: 'cancel', sessionId: sid }, `${label} the opener cancels`);
    await expectSessionGone(sid, `${label} cleanup`);
    await expectPairSessions(identityA, identityB, 0, `${label} world clean`);
  });

  // -------------------------------------------------------------------------
  // 5b — the PARTNER may cancel an untouched session.
  // WHAT THIS KILLS: a participant check that admits only the opener (`side_of` matching
  // `opener` alone); a cancel that refuses the partner.
  // -------------------------------------------------------------------------
  test('5b: the partner may cancel and the session row and its reaper row are gone', async () => {
    test.setTimeout(120_000);
    const label = '5b';
    const sid = await openSession(pageA, pageB, identityA, identityB, label);
    expect(reaperRowsFor(sid, label).length, `${label}: the session is armed`).toBe(1);
    await expectOk(pageB, { kind: 'cancel', sessionId: sid }, `${label} the partner cancels`);
    await expectSessionGone(sid, `${label} after the partner's cancel`);
    await expectPairSessions(identityA, identityB, 0, `${label} world clean`);
  });

  // -------------------------------------------------------------------------
  // 5c — the OPENER may cancel, with an offer on the table.
  // WHAT THIS KILLS: a participant check that admits only the partner (`side_of` matching
  // `partner` alone); a cancel that refuses the opener or leaves rows behind.
  // -------------------------------------------------------------------------
  test('5c: the opener may cancel and the session row, its snapshot rows and its reaper row are gone', async () => {
    test.setTimeout(120_000);
    const label = '5c';
    const monsterA = await partyMonsterId(pageA, label);
    const sid = await openSession(pageA, pageB, identityA, identityB, label);
    await expectOk(
      pageA,
      { kind: 'setOffer', sessionId: sid, offer: monsterOffer(monsterA) },
      `${label} A offers its monster`,
    );
    const snaps = await pollSql(
      () => snapshotRowsFor(sid, label),
      (r) => r.length === 1,
    );
    expect(snaps.length, `${label}: armed — one snapshot row`).toBe(1);
    expect(reaperRowsFor(sid, label).length, `${label}: armed — one reaper row`).toBe(1);

    await expectOk(pageA, { kind: 'cancel', sessionId: sid }, `${label} the opener cancels`);
    await expectSessionGone(sid, `${label} after the opener's cancel`);
    await expectPairSessions(identityA, identityB, 0, `${label} world clean`);
  });

  // -------------------------------------------------------------------------
  // 6a — no leak to a non-participant through set_trade_offer or confirm_trade_session.
  //
  // C calls both reducers on the LIVE session and on a session id that does not exist; each
  // pair of results must be equal (name AND message) and equal to the not-found refusal, and
  // the session must be unchanged. ROLE-DIFFERENTIAL: the participants' calls to the SAME
  // reducers on the SAME session succeed — A's and B's edits, then A's confirm is recorded
  // (B is not confirmed, so nothing executes and no monster moves).
  // WHAT THIS KILLS: a reducer that answers a non-participant with a side or revision error
  // ("the trade changed since you reviewed it", "your offer is empty") — which proves the
  // session exists and leaks its state — or that applies C's edit to a side; a lookup that
  // refuses everyone.
  // -------------------------------------------------------------------------
  test('6a: a non-participant set_trade_offer or confirm_trade_session on a live session gets exactly what a missing session id gets and the session is unchanged', async () => {
    test.setTimeout(120_000);
    const label = '6a';
    const monsterA = await partyMonsterId(pageA, label);
    const monsterB = await partyMonsterId(pageB, label);
    const monsterC = await partyMonsterId(pageC, label);
    const sid = await openSession(pageA, pageB, identityA, identityB, label);
    await expectOk(
      pageA,
      { kind: 'setOffer', sessionId: sid, offer: monsterOffer(monsterA) },
      `${label} control: the opener's edit`,
    );
    await expect
      .poll(() => sessionRowsById(sid, label)[0]?.revision ?? null, { timeout: 10_000 })
      .toBe('1');
    const ghost = (BigInt(sid) + BigInt(GHOST_OFFSET)).toString();
    expect(sessionRowsById(ghost, label), `${label}: session ${ghost} does not exist`).toEqual([]);
    const before = sessionFacts(sid, label);

    const offerC = monsterOffer(monsterC);
    const setLive = await errorOf(
      pageC,
      { kind: 'setOffer', sessionId: sid, offer: offerC },
      `${label} set live`,
    );
    const setGhost = await errorOf(
      pageC,
      { kind: 'setOffer', sessionId: ghost, offer: offerC },
      `${label} set ghost`,
    );
    const confirmLive = await errorOf(
      pageC,
      { kind: 'confirm', sessionId: sid, revision: '1' },
      `${label} confirm live`,
    );
    const confirmGhost = await errorOf(
      pageC,
      { kind: 'confirm', sessionId: ghost, revision: '1' },
      `${label} confirm ghost`,
    );
    expectRejection(setLive, ERR_SESSION_NOT_FOUND, `${label} set_trade_offer on the live session`);
    expectRejection(setGhost, ERR_SESSION_NOT_FOUND, `${label} set_trade_offer on a missing one`);
    expect(setLive, `${label}: set_trade_offer — live and missing are byte-identical`).toEqual(
      setGhost,
    );
    expectRejection(
      confirmLive,
      ERR_SESSION_NOT_FOUND,
      `${label} confirm_trade_session on the live session`,
    );
    expectRejection(
      confirmGhost,
      ERR_SESSION_NOT_FOUND,
      `${label} confirm_trade_session on a missing one`,
    );
    expect(confirmLive, `${label}: confirm — live and missing are byte-identical`).toEqual(
      confirmGhost,
    );
    expect(sessionFacts(sid, label), `${label}: the session is unchanged`).toBe(before);

    // ROLE-DIFFERENTIAL: the partner edits, then the opener's confirm at the current revision
    // is recorded.
    await expectOk(
      pageB,
      { kind: 'setOffer', sessionId: sid, offer: monsterOffer(monsterB) },
      `${label} control: the partner's edit`,
    );
    await expect
      .poll(() => sessionRowsById(sid, label)[0]?.revision ?? null, { timeout: 10_000 })
      .toBe('2');
    await expectOk(
      pageA,
      { kind: 'confirm', sessionId: sid, revision: '2' },
      `${label} control: the opener's confirm`,
    );
    await expect
      .poll(
        () => {
          const r = sessionRowsById(sid, label)[0];
          return r === undefined
            ? null
            : `${r.revision}/${r.openerConfirmed}/${r.partnerConfirmed}`;
        },
        {
          message: `${label}: the opener's confirm is recorded, nothing executes`,
          timeout: 10_000,
        },
      )
      .toBe('2/true/false');

    await expectOk(pageA, { kind: 'cancel', sessionId: sid }, `${label} cleanup cancel`);
    await expectSessionGone(sid, `${label} cleanup`);
    await expectPairSessions(identityA, identityB, 0, `${label} world clean`);
  });

  // -------------------------------------------------------------------------
  // 6b — a PARTICIPANT confirming a stale revision gets the stale-revision error FIRST
  // (can_confirm, session.rs; confirm_trade_session returns it before the drift and side
  // checks, trading_session.rs:1164-1170).
  //
  // B (the partner, side empty) confirms revisions behind AND ahead of the current one: stale
  // both times — not the not-found refusal (B IS a participant) and not "your offer is empty"
  // (the side check must not run first). REVISION-DIFFERENTIAL: B's confirm at the CURRENT
  // revision reaches the side check and answers "your offer is empty", so only the revision
  // separates the two answers.
  // WHAT THIS KILLS: `reviewed != current` → `<` (the ahead revision passes) or deleted; the
  // side check ordered before the revision check; a participant lookup that misses the partner;
  // a stale confirm that writes.
  // -------------------------------------------------------------------------
  test('6b: a participant confirming a stale revision gets the stale-revision error, not a role or side error', async () => {
    test.setTimeout(120_000);
    const label = '6b';
    const monsterA = await partyMonsterId(pageA, label);
    const sid = await openSession(pageA, pageB, identityA, identityB, label);
    await expectOk(
      pageA,
      { kind: 'setOffer', sessionId: sid, offer: monsterOffer(monsterA) },
      `${label} A offers its monster`,
    );
    await expect
      .poll(() => sessionRowsById(sid, label)[0]?.revision ?? null, { timeout: 10_000 })
      .toBe('1');
    const before = sessionFacts(sid, label);

    const behind = await errorOf(pageB, { kind: 'confirm', sessionId: sid, revision: '0' }, label);
    expectRejection(behind, ERR_STALE_REVISION, `${label} revision behind`);
    const ahead = await errorOf(pageB, { kind: 'confirm', sessionId: sid, revision: '2' }, label);
    expectRejection(ahead, ERR_STALE_REVISION, `${label} revision ahead`);
    expect(sessionFacts(sid, label), `${label}: a stale confirm writes nothing`).toBe(before);

    const current = await errorOf(pageB, { kind: 'confirm', sessionId: sid, revision: '1' }, label);
    expectRejection(current, ERR_OWN_OFFER_EMPTY, `${label} control: the current revision`);
    expect(sessionFacts(sid, label), `${label}: the refused confirm writes nothing`).toBe(before);

    await expectOk(pageA, { kind: 'cancel', sessionId: sid }, `${label} cleanup cancel`);
    await expectSessionGone(sid, `${label} cleanup`);
    await expectPairSessions(identityA, identityB, 0, `${label} world clean`);
  });
});
