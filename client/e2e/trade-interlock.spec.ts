import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// m17.5f — battle↔trade interlock e2e (EARS 17.5f-2)
//
// FILE NAMED `trade-interlock.spec.ts` (not `battle-*`) so it sorts AFTER
// golden.spec.ts and recruit.spec.ts in Playwright's alphabetical run order,
// eliminating the presenceCount===2 cross-contamination hazard from golden.spec
// (red-team F7 / reviewer W-3).
//
// WHAT THIS KILLS
// ===============
// This spec exists to prove that `reject_if_in_battle` in trading.rs is ACTIVE.
// If that guard is deleted (or never lands), step (c) below would insert a
// trade_offer row for A-while-in-battle. The spacetime sql absence assertion at
// the end would then see a row and FAIL RED — surfacing the missing guard.
//
// Trading.rs guard order (relevant excerpt):
//   G1. joined/self guard          — player must have joined and not be self
//   G2. active-offer guard         — player must not already have an offer
//   G3. validate_proposal (TR-1)   — monsters must be non-empty per side
//   G4. currency guard             — must have sufficient currency
//   G5. items guard                — must own offered items
//   G6. reject_if_in_battle        — initiator must not be in a wild battle
//
// Paired positive-control design (red-team F1/F2):
//   Step (b): B successfully proposes a trade (G1-G6 all pass) and it appears.
//   Step (b-cancel): B cancels the trade (ensuring G2 cannot confound step (c)).
//   Step (c): B tries the IDENTICAL proposal after A enters a wild battle.
//   The two calls differ ONLY in A's in-battle state.
//   If step (c) inserts a row, the guard is missing — the sql absence catches it.
//   If step (b) does NOT insert a row, the positive control fails — guards G1-G5
//   have a bug and the interlock cannot be tested (the sql absence would be
//   vacuously true regardless of G6).
//
// POSITIVE-CONTROL LOAD-BEARING PROPERTY:
//   If G2 (active-offer guard) is broken, step (b-cancel) ensures it is cleared
//   before step (c). Without the cancel-then-assert-gone cycle, a stale offer
//   from step (b) could confound step (c) via G2 rather than G6 — making the
//   absence assertion vacuously pass on a G2 hit, not a G6 hit.
//
// FRESH IDENTITIES / FULL-HP NOTE (F10)
// =======================================
// Each browser instance generates a fresh identity and a full-HP starter.
// A proposes a trade IMMEDIATELY when ongoingBattle is non-null (before any
// attack), so the wild monster cannot KO the party before the interlock fires.
//
// WILD BATTLE VIA GRASS WALK (NOT start_wild_battle)
// ====================================================
// The test cannot call start_wild_battle from page.evaluate() because the
// browser's DbConnection has no auth token accessible to the test process
// (ADR-0086 §infra; recruit.spec.ts:13-27 precedent). We grass-walk instead.
//
// SETTLE WINDOW / SQL ABSENCE PROOF
// ==================================
// After step (c)'s proposeTrade call (or rejection), we poll allTradeOffers()
// for MAX_SETTLE_POLLS × SETTLE_POLL_INTERVAL_MS to confirm the offer count
// stays 0 across consecutive polls. Then we run a spacetime sql query as the
// authoritative check. The settle window closes the race: a slow server insert
// would show up in the consecutive zero-count window.
//
// SETTLE WINDOW ARITHMETIC:
//   MAX_SETTLE_POLLS = 10
//   SETTLE_POLL_INTERVAL_MS = 500ms
//   Total settle window: 5 000ms (5s)
//   Rationale: a server-side reject fires within <200ms on a local instance;
//   a genuine (buggy) insert also arrives within 200ms. 5s catches both cases
//   with a 25× safety margin. If the server is genuinely slow (>1s), the sql
//   assertion is the backstop.
//
// EARS CRITERIA COVERED
// =====================
//   17.5f-2 — two-context interlock: A in wild battle, B proposes trade including
//              A's in-battle monster → assert no trade_offer row (server truth).

// ---------------------------------------------------------------------------
// GameSnap interface — mirrors main.ts snapshot shape.
// ---------------------------------------------------------------------------
interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ongoingBattle: {
    battleId: string;
    outcome: string;
    turnNumber: number;
  } | null;
  ownMonsters: Array<{
    monsterId: string;
    speciesId: number;
    nickname: string;
    level: number;
    partySlot: number;
  }>;
  ownInventory: Array<{ invId: string; itemId: number; count: number }>;
}

// ---------------------------------------------------------------------------
// MrTrade interface — re-declared locally (do NOT cross-import from trade-full.spec.ts).
// Verified against main.ts mrTradeHook ~:1067-1113 and trade-full.spec.ts.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Tile + grass-walk helpers — copied from recruit.spec.ts (do NOT cross-import).
// ---------------------------------------------------------------------------
interface Tile {
  x: number;
  y: number;
}

/** Max walk steps to trigger one encounter. 80 steps ≈ 40 grass entries.
 *  P(no encounter) = 0.8^40 ≈ 1.3e-4. */
const MAX_WALK_STEPS = 80;

/** Per-step wait timeout (200ms drain + network + margin). */
const STEP_WAIT_MS = 8_000;

/** shuttleDir: tile-aware direction for the (1,2)↔(2,2) shuttle (recruit.spec.ts:167).
 *  Only the East step onto (2,2) rolls an encounter. */
function shuttleDir(tile: Tile): string {
  if (tile.x === 1 && tile.y === 1) return 'South';
  if (tile.x === 1 && tile.y === 2) return 'East';
  if (tile.x === 2 && tile.y === 2) return 'West';
  if (tile.y > 2) return 'North';
  if (tile.x > 2) return 'West';
  return 'South';
}

/** stepOne: send one directional step and wait for tile change OR battle. */
async function stepOne(p: Page, dir: string, fromTile: Tile): Promise<'moved' | 'battle'> {
  await p.evaluate(
    (d) => (window as unknown as { __game: () => { step: (x: string) => void } }).__game().step(d),
    dir,
  );
  const result = await p.waitForFunction(
    (args: { fromX: number; fromY: number }) => {
      const g = (window as unknown as { __game: () => GameSnap }).__game();
      if (g.ongoingBattle !== null) return 'battle';
      if (
        g.ownAuthTile !== null &&
        (g.ownAuthTile.x !== args.fromX || g.ownAuthTile.y !== args.fromY)
      ) {
        return 'moved';
      }
      return false;
    },
    { fromX: fromTile.x, fromY: fromTile.y },
    { timeout: STEP_WAIT_MS },
  );
  return result.jsonValue() as Promise<'moved' | 'battle'>;
}

/** waitForBattleCleared: wait until ongoingBattle is null (fled or ended). */
async function waitForBattleCleared(p: Page): Promise<void> {
  await p.waitForFunction(
    () => (window as unknown as { __game: () => GameSnap }).__game().ongoingBattle === null,
    null,
    { timeout: 15_000 },
  );
}

/** gameReady: wait until __game() is available, identity set, tile placed. */
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

// ---------------------------------------------------------------------------
// Settle window constants — see arithmetic in the header comment.
// ---------------------------------------------------------------------------
/** Number of consecutive zero-count polls before the settle window closes. */
const MAX_SETTLE_POLLS = 10;
/** Delay between polls in milliseconds. */
const SETTLE_POLL_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// runTradeOfferSql: authoritative spacetime sql query for trade_offer rows
// scoped to the (initiator, counterparty) pair — BOTH directions checked.
// Returns raw sql output. Hard-fails on CLI/infra error.
// ---------------------------------------------------------------------------
function runTradeOfferSql(normA: string, normB: string): string {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  // Literal regexes only — no new RegExp().
  if (!/^[A-Za-z0-9:/._-]+$/.test(server)) {
    throw new Error(`STDB_SERVER contains characters outside [A-Za-z0-9:/._-]: ${server}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(`VITE_STDB_DB contains characters outside [A-Za-z0-9_-]: ${db}`);
  }
  // Identity hex strings: normA/normB are lowercase hex without 0x prefix.
  // Validate: only lowercase hex chars allowed (32 bytes = 64 hex chars).
  if (!/^[0-9a-f]+$/.test(normA)) {
    throw new Error(`normA identity failed hex charset validation: ${normA}`);
  }
  if (!/^[0-9a-f]+$/.test(normB)) {
    throw new Error(`normB identity failed hex charset validation: ${normB}`);
  }
  // The trade_offer table uses Identity columns (stored with 0x prefix in sql output).
  // We SELECT all trade_offer rows (small table) and filter client-side to avoid
  // identity-format ambiguity in the WHERE clause.
  let output: string;
  try {
    output = execSync(
      `spacetime sql -s ${server} ${db} "SELECT trade_id, initiator, counterparty FROM trade_offer"`,
      { encoding: 'utf8', timeout: 15_000 },
    );
  } catch (err) {
    throw new Error(
      `17.5f-2: spacetime sql trade_offer query failed (CLI/infra): ${(err as Error).message}`,
    );
  }
  return output;
}

/** normalizeIdentity: lowercase + strip leading '0x'. Copied from ranked-forfeit. */
function normalizeIdentity(id: string): string {
  let s = id.toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  return s;
}

/** tradeOfferRowsForPair: parse sql output and return rows matching (normA, normB).
 *  Checks BOTH directions: initiator=A/counterparty=B and initiator=B/counterparty=A. */
function tradeOfferRowsForPair(sqlOutput: string, normA: string, normB: string): number {
  const lines = sqlOutput.split('\n').map((l) => l.trim());
  let count = 0;
  for (const line of lines) {
    if (!line.includes('|')) continue;
    if (line.includes('---')) continue;
    const firstCol = line.split('|')[0]?.trim() ?? '';
    // Skip header row (contains 'trade_id' as a column name).
    if (firstCol === 'trade_id') continue;

    const cols = line.split('|').map((c) => c.trim());
    if (cols.length < 3) continue;
    const initiator = normalizeIdentity(cols[1] ?? '');
    const counterparty = normalizeIdentity(cols[2] ?? '');
    // Check both directions.
    if (
      (initiator === normA && counterparty === normB) ||
      (initiator === normB && counterparty === normA)
    ) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe
  .serial('m17.5f — battle↔trade interlock e2e (17.5f-2)', () => {
    let browserA: Browser;
    let ctxA: BrowserContext;
    let pageA: Page;

    let browserB: Browser;
    let ctxB: BrowserContext;
    let pageB: Page;

    test.beforeAll(async () => {
      browserA = await chromium.launch();
      ctxA = await browserA.newContext();
      pageA = await ctxA.newPage();

      browserB = await chromium.launch();
      ctxB = await browserB.newContext();
      pageB = await ctxB.newPage();

      await pageA.goto('/');
      await pageB.goto('/');
      await Promise.all([gameReady(pageA), gameReady(pageB)]);
    });

    test.afterAll(async () => {
      // Close both browsers; tolerate already-closed (e.g., A fled and closed,
      // or B closed during a test error path).
      try {
        await browserA?.close();
      } catch {
        // tolerate
      }
      try {
        await browserB?.close();
      } catch {
        // tolerate
      }
    });

    // -------------------------------------------------------------------------
    // Battle↔trade interlock test
    //
    // Flow:
    //   (a)  Capture identities from both pages.
    //   (b)  POSITIVE CONTROL (pre-battle): B proposes a trade (B's starter for
    //        A's starter, no items/currency) → assert row APPEARS in allTradeOffers.
    //   (b-cancel) B cancels → assert row GONE (clears G2 so it cannot confound step (c)).
    //   (c)  A grass-walks into a wild battle (stepOne/shuttleDir helpers from recruit.spec).
    //   (d)  Immediately (ongoingBattle !== null): B repeats the IDENTICAL proposeTrade.
    //        The two calls differ ONLY in A's in-battle state (A is now in battle).
    //        The battle interlock guard (G6: reject_if_in_battle) must reject the call.
    //   (e)  Settle window: poll allTradeOffers() for 5s to confirm count stays 0.
    //   (f)  Authoritative spacetime sql absence assertion scoped to (A,B) pair.
    //   (g)  A flees (waitForBattleCleared).
    //
    // WHAT THIS KILLS:
    //   Step (d) row appearing → reject_if_in_battle was deleted or never implemented.
    //   Step (b) row NOT appearing → guards G1-G5 have a bug; test would give a
    //            vacuous positive (confounding). The positive control hard-fails here.
    //
    // GREEN-AT-BIRTH NOTE (reviewer N-3):
    //   This test covers an ALREADY-SHIPPED guard (reject_if_in_battle, m16.5a).
    //   It is GREEN when the guard is present. Its teeth = the paired positive
    //   control (step b) which turns RED if the guard is deleted. The adversarial
    //   protocol is: run ≥5× to confirm no flake.
    //
    // RED-AT-BIRTH conditions:
    //   - __mrTrade not yet wired (hook-existence test in trade-full.spec.ts covers this).
    //   - step (b) fails if proposeTrade rejects for a guard other than G6.
    // -------------------------------------------------------------------------
    test('battle↔trade interlock: A in wild battle, B proposeTrade rejected; positive control pre-battle succeeds (17.5f-2)', async () => {
      test.setTimeout(90_000);

      // (a) Capture identities.
      const identityA = await pageA.evaluate(() => {
        return (window as unknown as { __game: () => GameSnap }).__game().identity;
      });
      const identityB = await pageB.evaluate(() => {
        return (window as unknown as { __game: () => GameSnap }).__game().identity;
      });
      expect(identityA, 'identityA must be non-empty').not.toBe('');
      expect(identityB, 'identityB must be non-empty').not.toBe('');
      expect(identityA, 'identityA and identityB must differ').not.toBe(identityB);

      const normA = normalizeIdentity(identityA);
      const normB = normalizeIdentity(identityB);

      // Read starters: each fresh identity gets exactly 1 starter from join_game.
      const starterA = await pageA.evaluate(() => {
        const g = (window as unknown as { __game: () => GameSnap }).__game();
        const m = g.ownMonsters[0];
        if (!m) throw new Error('17.5f-2: no starter monster for A');
        return m.monsterId;
      });
      const starterB = await pageB.evaluate(() => {
        const g = (window as unknown as { __game: () => GameSnap }).__game();
        const m = g.ownMonsters[0];
        if (!m) throw new Error('17.5f-2: no starter monster for B');
        return m.monsterId;
      });

      // B waits until A appears in allPlayers().
      await pageB.waitForFunction(
        (aIdentity: string) => {
          const w = window as unknown as { __mrTrade?: MrTrade };
          if (!w.__mrTrade) return false;
          return w.__mrTrade.allPlayers().some((pl) => pl.identity === aIdentity);
        },
        identityA,
        { timeout: 15_000 },
      );

      // -----------------------------------------------------------------------
      // (b) POSITIVE CONTROL (pre-battle): B proposes trade with EXACT final arg shape.
      //     initiatorMonsterIds=[B's starter], counterpartyMonsterIds=[A's starter],
      //     zero items and currency on both sides.
      //     Non-empty on BOTH sides so validate_proposal (TR-1/G3) cannot fire.
      //     Both monsters are owned by their respective players, so ownership guards pass.
      //
      // WHAT THIS KILLS (positive control load-bearing):
      //     If this row does NOT appear, guards G1-G5 have a bug. The test fails here
      //     with a clear message, preventing a vacuous absence assertion at step (f).
      // -----------------------------------------------------------------------
      const proposeArgs = {
        counterparty: identityA,
        initiatorMonsterIds: [starterB],
        initiatorItems: [] as { itemId: number; qty: number }[],
        initiatorCurrency: '0',
        counterpartyMonsterIds: [starterA],
        counterpartyItems: [] as { itemId: number; qty: number }[],
        counterpartyCurrency: '0',
      };

      // B proposes (pre-battle control). Catch rejection so we can report it as a
      // test failure rather than an unhandled promise rejection — following trade-full
      // pattern (trade-full.spec.ts:268-270).
      const controlProposalError = await pageB
        .evaluate((args: typeof proposeArgs) => {
          const w = window as unknown as { __mrTrade: MrTrade };
          const p = w.__mrTrade.proposeTrade(args);
          if (!p) throw new Error('17.5f-2: proposeTrade returned undefined (conn not ready?)');
          return p;
        }, proposeArgs)
        .then(() => null)
        .catch((err: Error) => err.message);

      if (controlProposalError !== null) {
        throw new Error(
          `17.5f-2: POSITIVE CONTROL FAILED — pre-battle proposeTrade was rejected: ` +
            `${controlProposalError}. Guards G1-G5 have a bug that confounds the interlock test.`,
        );
      }

      // Assert the offer row appears (both pages subscribe to public trade_offer table).
      await Promise.all([
        pageA.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length > 0;
          },
          null,
          { timeout: 10_000 },
        ),
        pageB.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length > 0;
          },
          null,
          { timeout: 10_000 },
        ),
      ]);

      // Confirm the offer is Pending.
      const controlOfferStatus = await pageB.evaluate(() => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allTradeOffers()[0]?.status ?? '';
      });
      expect(
        controlOfferStatus,
        '17.5f-2: POSITIVE CONTROL: offer must be Pending after pre-battle proposeTrade',
      ).toBe('Pending');

      // -----------------------------------------------------------------------
      // (b-cancel) B cancels the offer to clear G2 (active-offer guard).
      //     Without this cancel, step (c)'s failure would be attributable to G2
      //     (B already has an active offer) rather than G6 (A is in battle).
      // -----------------------------------------------------------------------
      const tradeIdForCancel = await pageB.evaluate(() => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allTradeOffers()[0]?.tradeId ?? '';
      });
      expect(tradeIdForCancel, 'tradeIdForCancel must be non-empty').not.toBe('');

      await pageB.evaluate((tid: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const p = w.__mrTrade.cancelTrade(tid);
        if (!p) throw new Error('17.5f-2: cancelTrade returned undefined');
        return p;
      }, tradeIdForCancel);

      // Wait for the offer row to disappear from BOTH pages.
      await Promise.all([
        pageA.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length === 0;
          },
          null,
          { timeout: 10_000 },
        ),
        pageB.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length === 0;
          },
          null,
          { timeout: 10_000 },
        ),
      ]);

      // -----------------------------------------------------------------------
      // (c) A grass-shuttles into a wild battle.
      //     shuttleDir/stepOne copied from recruit.spec.ts (do NOT cross-import).
      //     We propose IMMEDIATELY on ongoingBattle !== null, before any attack,
      //     so the wild cannot KO us before the interlock fires (R3/F10 moot).
      // -----------------------------------------------------------------------
      let encounterFound = false;
      for (let i = 0; i < MAX_WALK_STEPS && !encounterFound; i++) {
        const g = await pageA.evaluate(() => {
          const s = (window as unknown as { __game: () => GameSnap }).__game();
          return { tile: s.ownAuthTile, battle: s.ongoingBattle };
        });
        if (g.battle !== null) {
          encounterFound = true;
          break;
        }
        const tile = g.tile ?? { x: 1, y: 1 };
        const dir = shuttleDir(tile);
        try {
          const outcome = await stepOne(pageA, dir, tile);
          if (outcome === 'battle') encounterFound = true;
        } catch {
          // stepOne timed out (wall-bump or slow drain); try next direction.
        }
      }

      expect(
        encounterFound,
        `17.5f-2: did not trigger a wild battle within MAX_WALK_STEPS=${MAX_WALK_STEPS}`,
      ).toBe(true);

      // Confirm battle is live on A's page.
      const ongoingAfterEncounter = await pageA.evaluate(() => {
        return (window as unknown as { __game: () => GameSnap }).__game().ongoingBattle;
      });
      if (ongoingAfterEncounter === null) {
        throw new Error(
          '17.5f-2: ongoingBattle is null after encounterFound — snapshot inconsistent',
        );
      }
      expect(
        ongoingAfterEncounter.outcome,
        '17.5f-2: ongoingBattle.outcome must be Ongoing after encounter',
      ).toBe('Ongoing');

      // -----------------------------------------------------------------------
      // (d) INTERLOCK CALL: B repeats the IDENTICAL proposeTrade.
      //     The two calls (b) and (d) differ ONLY in A's in-battle state.
      //     A rejection here is attributable to reject_if_in_battle (G6) — not G1-G5
      //     which were proven to pass in step (b).
      //
      //     We catch the rejection so a Promise<void> rejection does not abort the
      //     test via Playwright's unhandled-rejection detection. The SQL absence
      //     assertion at step (f) is the GATE — whether the call threw or silently
      //     succeeded, we check the authoritative server state.
      // -----------------------------------------------------------------------
      const interlockError = await pageB
        .evaluate((args: typeof proposeArgs) => {
          const w = window as unknown as { __mrTrade: MrTrade };
          const p = w.__mrTrade.proposeTrade(args);
          if (!p) {
            // conn not ready — this would be a test-infra failure, not the guard.
            throw new Error('17.5f-2: proposeTrade returned undefined (conn not ready?)');
          }
          return p;
        }, proposeArgs)
        .then(() => null as string | null)
        .catch((err: Error) => err.message);

      // Log the rejection reason for CI diagnostics (the guard rejection IS expected here).
      if (interlockError !== null) {
        console.log(`17.5f-2: interlock proposeTrade rejected (expected): ${interlockError}`);
      } else {
        // The call resolved without error — this is suspicious. The sql absence is
        // still the gate; log a warning so CI traces can spot a guard gap.
        console.warn(
          '17.5f-2: interlock proposeTrade RESOLVED (not rejected) — checking sql for absence. ' +
            'If a row appears below, reject_if_in_battle is missing.',
        );
      }

      // -----------------------------------------------------------------------
      // (e) Settle window: poll allTradeOffers() for MAX_SETTLE_POLLS consecutive
      //     zero-count polls, each separated by SETTLE_POLL_INTERVAL_MS.
      //
      //     ARITHMETIC:
      //       10 polls × 500ms = 5 000ms total window.
      //       A buggy insert arrives <200ms after the call on a local instance.
      //       5 000ms / 200ms = 25× safety margin.
      //       A genuine reject (correct behaviour) also fires in <200ms, so the
      //       consecutive-zero window will close quickly for correct impls.
      // -----------------------------------------------------------------------
      let consecutiveZeroPollCount = 0;
      for (let i = 0; i < MAX_SETTLE_POLLS; i++) {
        await pageB.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
        const offerCount = await pageB.evaluate(() => {
          const w = window as unknown as { __mrTrade?: MrTrade };
          if (!w.__mrTrade) return 0;
          return w.__mrTrade.allTradeOffers().length;
        });
        if (offerCount === 0) {
          consecutiveZeroPollCount++;
        } else {
          // An offer appeared — break immediately; the sql assertion will catch it.
          console.warn(
            `17.5f-2: allTradeOffers().length=${offerCount} during settle window (poll ${i + 1}/${MAX_SETTLE_POLLS}) — reject_if_in_battle may be missing.`,
          );
          break;
        }
      }

      // -----------------------------------------------------------------------
      // (f) Authoritative spacetime sql absence assertion.
      //     This is the load-bearing gate — client subscription state could lag
      //     or differ from server truth. The sql query is the final word.
      //
      //     WHAT THIS KILLS:
      //       - A deleted/missing reject_if_in_battle guard → row appears → sql check FAILS.
      //       - A vacuously passing test where step (b) also failed (caught above).
      // -----------------------------------------------------------------------
      const tradeOfferSqlOutput = runTradeOfferSql(normA, normB);
      const rowCountForPair = tradeOfferRowsForPair(tradeOfferSqlOutput, normA, normB);

      expect(
        rowCountForPair,
        `17.5f-2: expected 0 trade_offer rows for the (A, B) pair after the in-battle proposeTrade, ` +
          `but spacetime sql found ${rowCountForPair} row(s). ` +
          `reject_if_in_battle guard is absent or broken. ` +
          `consecutive zero polls before abort: ${consecutiveZeroPollCount}/${MAX_SETTLE_POLLS}. ` +
          `Raw sql output: ${tradeOfferSqlOutput}`,
      ).toBe(0);

      // -----------------------------------------------------------------------
      // (g) Cleanup: A flees the battle (so afterAll can close the browser cleanly).
      // -----------------------------------------------------------------------
      const fleeBtn = pageA.getByText('Flee', { exact: true });
      await fleeBtn.click({ timeout: 5_000 });
      await waitForBattleCleared(pageA);
    });
  });
