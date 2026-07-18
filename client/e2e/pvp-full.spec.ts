import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// m17.5f — PvP full flow e2e (EARS 17.5f-1)
//
// TWO-CONTEXT DESIGN
// ==================
// Mirrors ranked-forfeit.spec.ts (m17c): two separate chromium.launch() instances
// generate distinct SpacetimeDB identities. The SDK caches its connection+identity
// in the page's JS module scope, so a shared browser or BrowserContext would yield
// the same identity for both players.
//
// WHAT THESE TESTS KILL
// =====================
//   hook-existence test:
//     - A refactor of main.ts that removes or renames window.__mrPvp, or omits any
//       of the required methods. The test fails with hasHook=false the moment the
//       hook is absent, without waiting for the full-flow test to time out.
//     - A DEV-gate that accidentally hides the hook in the dev server
//       (vite dev ALWAYS replaces import.meta.env.DEV with true in dev mode).
//
//   full-flow test:
//     - An acceptChallenge that does not start a battle (pageA ongoingBattle stays null).
//     - A submitPvpAction that does not advance turnNumber (strict === +1 predicate).
//     - A deadline-forfeit path that is erroneously treated as a turn advance (F4):
//       a forfeit sets a terminal outcome WITHOUT advancing turnNumber; the STRICT
//       waitForFunction below waits for turnNumber === turnNumber0+1, which a
//       deadline-forfeit does NOT satisfy (turnNumber stays 0) — so the 30s budget
//       expires, the test fails RED, and the bug is caught.
//     - A write-back path that grants wins/losses to the wrong player.
//     - A non-zero-sum rating path (sum ≠ 2000).
//     - A zero-delta path (Δ=0, wins=1 but no rating change).
//
// STRICT TURN PREDICATE (anti-F4)
// ================================
// The predicate is: battleById(id).turnNumber === turnNumber0 + 1
// NO `|| terminal` escape hatch. Rationale: a deadline forfeit (PVP_TURN_DEADLINE_MS=60s)
// is terminal WITHOUT advancing turnNumber. If we allowed `|| terminal` escape, a test
// bug or timing race could satisfy the predicate via a forfeit path and skip the
// actual turn-exchange assertion. The strict +1 check forces a genuine turn exchange.
//
// DEADLINE HEADROOM ARITHMETIC (F9)
// ==================================
// PVP_TURN_DEADLINE_MS = 60_000 ms = 60s (server constant, ADR-0109).
// Turn budget in this test: 30s (waitForFunction timeout below).
// Headroom = 60s − 30s = 30s — both players submit within the 30s window,
// leaving ≥30s before any deadline-forfeit can fire.
// After turn exchange: immediately close browserB (forfeit_on_disconnect).
// Tight sequencing keeps well within the 60s deadline window.
//
// FRESH IDENTITIES / FULL-HP NOTE (F10)
// =======================================
// Each browser instance generates a fresh SpacetimeDB identity and a fresh
// starter Flameling at full HP via join_game. No KO-race is possible because
// the test only exchanges one turn before forfeiting via disconnect.
//
// SQL IDENTITY NORMALIZATION
// ==========================
// Both __mrPvp().allPlayers()[*].identity and the spacetime sql identity column
// are normalized to lowercase + '0x' prefix stripped before comparison.
//
// EARS CRITERIA COVERED
// =====================
//   17.5f-1 — two-context PvP hook + turn-exchange flow + disconnect-forfeit +
//              zero-sum profile assertion via server-truth sql

// ---------------------------------------------------------------------------
// GameSnap interface: matches the snapshot() fn in main.ts.
// ongoingBattle shape verified at main.ts line ~966-970.
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
// MrPvp contract interface — this DEFINES the hook the implementer must build.
//
// Mapping to main.ts / store.ts:
//   challengePvp(targetHex, partyIds)  → conn.reducers.challengePvp({target: new Identity(targetHex), partyIds: partyIds.map(BigInt)})
//   acceptChallenge(challengeId, partyIds) → conn.reducers.acceptChallenge({challengeId: BigInt(challengeId), partyIds: partyIds.map(BigInt)})
//   declineChallenge(challengeId)      → conn.reducers.declineChallenge({challengeId: BigInt(challengeId)})
//   cancelChallenge(challengeId)       → conn.reducers.cancelChallenge({challengeId: BigInt(challengeId)})
//   submitPvpAction(battleId, action)  → conn.reducers.submitPvpAction({battleId: BigInt(battleId), action})
//   allChallenges()                    → store.allChallenges() mapped (challengeId → string via .toString())
//   allPlayers()                       → store.allPlayers() mapped (identity already string)
//   battleById(battleId)               → store.battle(BigInt(battleId)) mapped to the shape below
//                                        (role-agnostic: reads the store map directly, NOT store.ongoingBattle()
//                                         which filters on playerIdentity === identity — side B would never see it)
//
// battleById return shape:
//   { battleId: string, outcome: string, turnNumber: number,
//     sideA: { active: number, activeSkillIds: number[] },
//     sideB: { active: number, activeSkillIds: number[] } } | null
//
//   sideA.activeSkillIds  = store.battle(id).sideA.team[sideA.active].knownSkillIds
//   sideB.activeSkillIds  = store.battle(id).sideB.team[sideB.active].knownSkillIds
//   (StoreBattle.sideA/sideB: {active, team[].knownSkillIds} per store.ts)
//
//   Returns null when the battle is not in the store (GC'd or not yet arrived).
//
// BigInt boundary: all IDs (battleId, challengeId, monsterId) cross the
// page.evaluate structured-clone boundary AS STRINGS (BigInt cannot cross
// unmodified). The hook converts strings → BigInt internally.
//
// JSDoc sync warning: this interface is re-declared locally in this spec; the
// implementer must keep main.ts in sync manually (page.evaluate crosses a
// structured-clone boundary that the type system cannot check across).
// ---------------------------------------------------------------------------
interface MrPvp {
  challengePvp(targetHex: string, partyIds: string[]): Promise<void> | undefined;
  acceptChallenge(challengeId: string, partyIds: string[]): Promise<void> | undefined;
  declineChallenge(challengeId: string): Promise<void> | undefined;
  cancelChallenge(challengeId: string): Promise<void> | undefined;
  submitPvpAction(
    battleId: string,
    action: { tag: string; value: number },
  ): Promise<void> | undefined;
  allChallenges(): Array<{
    challengeId: string;
    challenger: string;
    target: string;
    status: string;
  }>;
  allPlayers(): Array<{ identity: string; name: string }>;
  battleById(battleId: string): {
    battleId: string;
    outcome: string;
    turnNumber: number;
    sideA: { active: number; activeSkillIds: number[] };
    sideB: { active: number; activeSkillIds: number[] };
  } | null;
}

// ---------------------------------------------------------------------------
// gameReady: wait until __game() is present, identity is set, and the player
// has been placed on the map (ownAuthTile non-null). Mirrors trade-full.spec.ts.
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

// ---------------------------------------------------------------------------
// normalizeIdentity: lowercase + strip leading '0x' prefix.
// Both __game().identity and spacetime sql identity columns are normalized
// before comparison (AM-7 empirical risk — format may differ).
// Copied from ranked-forfeit.spec.ts — do NOT cross-import.
// ---------------------------------------------------------------------------
function normalizeIdentity(id: string): string {
  let s = id.toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  return s;
}

// ---------------------------------------------------------------------------
// runProfileSql: execute spacetime sql and return raw output.
// Copied from ranked-forfeit.spec.ts — literal regexes only.
// Hard-fails (throws) on CLI/infra failure.
// ---------------------------------------------------------------------------
function runProfileSql(): string {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  // Literal regexes only — no new RegExp().
  if (!/^[A-Za-z0-9:/._-]+$/.test(server)) {
    throw new Error(`STDB_SERVER contains characters outside [A-Za-z0-9:/._-]: ${server}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(`VITE_STDB_DB contains characters outside [A-Za-z0-9_-]: ${db}`);
  }
  let output: string;
  try {
    output = execSync(
      `spacetime sql -s ${server} ${db} "SELECT identity, rating, wins, losses FROM profile"`,
      { encoding: 'utf8', timeout: 15_000 },
    );
  } catch (err) {
    throw new Error(
      `17.5f-1: spacetime sql failed (CLI/infra failure, not a row-content mismatch): ` +
        `${(err as Error).message}`,
    );
  }
  return output;
}

// ---------------------------------------------------------------------------
// ProfileRow: parsed row from spacetime sql ASCII table output.
// ---------------------------------------------------------------------------
interface ProfileRow {
  identity: string; // normalized (lowercase, no 0x)
  rating: number;
  wins: number;
  losses: number;
}

// ---------------------------------------------------------------------------
// parseProfileRows: parse the ASCII table from spacetime sql.
// Copied from ranked-forfeit.spec.ts — literal regexes, hard-fail on mismatch.
// Returns only rows whose normalized identity is in the provided set.
// ---------------------------------------------------------------------------
function parseProfileRows(sqlOutput: string, identities: Set<string>): ProfileRow[] {
  const lines = sqlOutput.split('\n').map((l) => l.trim());
  const dataLines = lines.filter((l) => {
    if (!l.includes('|')) return false;
    if (l.includes('---')) return false;
    const firstCol = l.split('|')[0]?.trim() ?? '';
    if (firstCol === 'identity') return false;
    return true;
  });

  const rows: ProfileRow[] = [];
  for (const line of dataLines) {
    const cols = line.split('|').map((c) => c.trim());
    if (cols.length < 4) continue;
    const rawId = cols[0] ?? '';
    const normalized = normalizeIdentity(rawId);
    if (!identities.has(normalized)) continue;

    const rating = parseInt(cols[1] ?? '', 10);
    const wins = parseInt(cols[2] ?? '', 10);
    const losses = parseInt(cols[3] ?? '', 10);

    if (Number.isNaN(rating) || Number.isNaN(wins) || Number.isNaN(losses)) {
      throw new Error(
        `17.5f-1: failed to parse numeric columns from profile row: ${JSON.stringify(line)}. ` +
          `Raw sql output (first 500 chars): ${sqlOutput.slice(0, 500)}`,
      );
    }

    rows.push({ identity: normalized, rating, wins, losses });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe
  .serial('m17.5f — PvP full flow e2e (17.5f-1)', () => {
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
      // Close A. B is closed mid-test (disconnect-forfeit); tolerate already-closed.
      try {
        await browserA?.close();
      } catch {
        // A may already be closed on an error path.
      }
      // B is closed inside the flow test. Do NOT attempt a second close here —
      // Playwright throws on double-close; afterAll is intentionally B-agnostic.
    });

    // -------------------------------------------------------------------------
    // Test 1: hook existence
    //
    // WHAT THIS KILLS:
    //   - A main.ts refactor that removes window.__mrPvp or any required method.
    //   - A DEV-gate that accidentally evaluates false in vite dev mode.
    //   - An implementer that ships only some methods.
    //
    // RED UNTIL __mrPvp IS WIRED in main.ts.
    // -------------------------------------------------------------------------
    test('__mrPvp hook is available on window with all required methods (17.5f-1 hook)', async () => {
      const hasHook = await pageA.evaluate(() => {
        const w = window as unknown as { __mrPvp?: MrPvp };
        return (
          typeof w.__mrPvp?.challengePvp === 'function' &&
          typeof w.__mrPvp?.acceptChallenge === 'function' &&
          typeof w.__mrPvp?.declineChallenge === 'function' &&
          typeof w.__mrPvp?.cancelChallenge === 'function' &&
          typeof w.__mrPvp?.submitPvpAction === 'function' &&
          typeof w.__mrPvp?.allChallenges === 'function' &&
          typeof w.__mrPvp?.allPlayers === 'function' &&
          typeof w.__mrPvp?.battleById === 'function'
        );
      });
      expect(
        hasHook,
        'window.__mrPvp must expose challengePvp/acceptChallenge/declineChallenge/' +
          'cancelChallenge/submitPvpAction/allChallenges/allPlayers/battleById',
      ).toBe(true);
    });

    // -------------------------------------------------------------------------
    // Test 2: full PvP flow
    //
    // Flow:
    //   1. Capture identities from both pages.
    //   2. A waits for B in allPlayers(), then calls challengePvp(B).
    //   3. Both pages poll allChallenges() for a Pending challenge.
    //   4. B accepts via acceptChallenge(challengeId, partyIds).
    //   5. pageA waits for ongoingBattle !== null.
    //   6. A captures battleId + turnNumber0.
    //   7. Test passes battleId to B's page (string, not BigInt).
    //   8. Both pages read legal skillIds via battleById(battleId) (A from sideA,
    //      B from sideB — role-agnostic accessor needed because B is opponentIdentity,
    //      not playerIdentity, so store.ongoingBattle() would return undefined for B).
    //   9. A and B each call submitPvpAction with a legal skillId (Attack action).
    //  10. STRICT wait: pageA waitForFunction battleById(id).turnNumber === turnNumber0+1
    //      with 30s budget. NO `|| terminal` escape (red-team F4 — a deadline forfeit
    //      is terminal WITHOUT advancing turnNumber and must NOT satisfy this wait).
    //  11. spacetime sql battle-row assertion (decimal-validate battleId first).
    //  12. Immediately close browserB (forfeit_on_disconnect; tight sequencing gives
    //      ≥30s headroom before PVP_TURN_DEADLINE_MS=60s fires).
    //  13. pageA waits for terminal outcome.
    //  14. Zero-sum profile sql assertion scoped to {A,B} identities.
    //
    // WHAT THIS KILLS:
    //   - acceptChallenge that does not start a battle (step 5 times out).
    //   - submitPvpAction that does not advance turnNumber (step 10 times out).
    //   - A deadline-forfeit counted as a turn advance (F4: strict +1, no escape).
    //   - A wrong-winner path (loser gets wins=1).
    //   - A non-zero-sum path (sum ≠ 2000).
    //   - A zero-delta path (Δ=0, rating unchanged despite a result).
    //   - A path that deletes the loser's profile row (hard-fail in parseProfileRows).
    //
    // RED UNTIL __mrPvp AND the underlying challenge/pvp reducers are wired.
    // -------------------------------------------------------------------------
    test('PvP full flow: challenge → accept → turn exchange → B-disconnect → A wins; zero-sum profile assertion (17.5f-1)', async () => {
      test.setTimeout(120_000);

      // Step 1: capture identities.
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

      // Step 2: A waits until B appears in allPlayers(), then challenges B.
      // allPlayers() is populated once both pages complete join_game.
      await pageA.waitForFunction(
        (myIdentity: string) => {
          const w = window as unknown as { __mrPvp?: MrPvp };
          if (!w.__mrPvp) return false;
          return w.__mrPvp.allPlayers().some((pl) => pl.identity !== myIdentity);
        },
        identityA,
        { timeout: 15_000 },
      );

      // Resolve B's identity as seen from A's allPlayers().
      const targetHex = await pageA.evaluate((myIdentity: string) => {
        const w = window as unknown as { __mrPvp: MrPvp };
        const others = w.__mrPvp.allPlayers().filter((pl) => pl.identity !== myIdentity);
        if (others.length < 1) throw new Error('17.5f-1: no other player found in allPlayers()');
        return others[0]!.identity;
      }, identityA);

      expect(targetHex, 'targetHex must resolve to a non-empty identity').not.toBe('');

      // A reads its party monster IDs (bigint-as-string via ownMonsters).
      const partyIdsA = await pageA.evaluate(() => {
        const g = (window as unknown as { __game: () => GameSnap }).__game();
        // All monsters in party slots (partySlot !== 255) — join_game assigns partySlot 0.
        return g.ownMonsters.filter((m) => m.partySlot !== 255).map((m) => m.monsterId);
      });

      // A challenges B.
      await pageA.evaluate(
        (args: { targetHex: string; partyIds: string[] }) => {
          const w = window as unknown as { __mrPvp: MrPvp };
          const p = w.__mrPvp.challengePvp(args.targetHex, args.partyIds);
          if (!p) throw new Error('17.5f-1: challengePvp returned undefined (conn not ready?)');
          return p;
        },
        { targetHex, partyIds: partyIdsA },
      );

      // Step 3: Both pages poll allChallenges() for a Pending challenge targeting B.
      // WHAT THIS KILLS: a challengePvp that does not create a challenge row.
      await Promise.all([
        pageA.waitForFunction(
          (myTarget: string) => {
            const w = window as unknown as { __mrPvp?: MrPvp };
            if (!w.__mrPvp) return false;
            return w.__mrPvp
              .allChallenges()
              .some((c) => c.target === myTarget && c.status === 'Pending');
          },
          targetHex,
          { timeout: 15_000 },
        ),
        pageB.waitForFunction(
          (myIdentity: string) => {
            const w = window as unknown as { __mrPvp?: MrPvp };
            if (!w.__mrPvp) return false;
            return w.__mrPvp
              .allChallenges()
              .some((c) => c.target === myIdentity && c.status === 'Pending');
          },
          identityB,
          { timeout: 15_000 },
        ),
      ]);

      // B reads the challengeId and its own party IDs.
      const challengeId = await pageB.evaluate((myIdentity: string) => {
        const w = window as unknown as { __mrPvp: MrPvp };
        const challenge = w.__mrPvp
          .allChallenges()
          .find((c) => c.target === myIdentity && c.status === 'Pending');
        if (!challenge) throw new Error('17.5f-1: no Pending challenge found on B page');
        return challenge.challengeId;
      }, identityB);

      expect(challengeId, 'challengeId must be non-empty').not.toBe('');

      const partyIdsB = await pageB.evaluate(() => {
        const g = (window as unknown as { __game: () => GameSnap }).__game();
        return g.ownMonsters.filter((m) => m.partySlot !== 255).map((m) => m.monsterId);
      });

      // Step 4: B accepts the challenge.
      // WHAT THIS KILLS: an acceptChallenge that silently drops the call.
      await pageB.evaluate(
        (args: { challengeId: string; partyIds: string[] }) => {
          const w = window as unknown as { __mrPvp: MrPvp };
          const p = w.__mrPvp.acceptChallenge(args.challengeId, args.partyIds);
          if (!p) throw new Error('17.5f-1: acceptChallenge returned undefined (conn not ready?)');
          return p;
        },
        { challengeId, partyIds: partyIdsB },
      );

      // Step 5: A waits for ongoingBattle to appear.
      // WHAT THIS KILLS: a start_pvp_battle that does not create a battle row with A as playerIdentity.
      await pageA.waitForFunction(
        () => {
          const g = (window as unknown as { __game: () => GameSnap }).__game();
          return g.ongoingBattle !== null;
        },
        null,
        { timeout: 15_000 },
      );

      // Step 6: A captures battleId + turnNumber0.
      const { battleId, turnNumber0 } = await pageA.evaluate(() => {
        const g = (window as unknown as { __game: () => GameSnap }).__game();
        if (!g.ongoingBattle) throw new Error('17.5f-1: ongoingBattle is null after wait');
        return { battleId: g.ongoingBattle.battleId, turnNumber0: g.ongoingBattle.turnNumber };
      });

      expect(battleId, 'battleId must be a non-empty string').not.toBe('');
      // battleId is a SpacetimeDB u64 serialised as decimal — validate charset.
      if (!/^[0-9]+$/.test(battleId)) {
        throw new Error(`17.5f-1: battleId is not a decimal u64 string: ${battleId}`);
      }

      // Step 7: battleId is now a plain string — it crosses the page.evaluate
      // structured-clone boundary safely (no BigInt). We pass it to B's page below.

      // Step 8: A reads its active monster's skill IDs via battleById (from sideA).
      // B reads its active monster's skill IDs via battleById (from sideB).
      // battleById is role-agnostic — it does NOT use store.ongoingBattle() which
      // only returns battles where playerIdentity === identity. B is opponentIdentity;
      // without battleById, B cannot read the battle state at all (reviewer B-1).
      const skillIdA = await pageA
        .waitForFunction(
          (bid: string) => {
            const w = window as unknown as { __mrPvp: MrPvp };
            const battle = w.__mrPvp.battleById(bid);
            if (!battle) return false;
            const ids = battle.sideA.activeSkillIds;
            if (!ids || ids.length === 0) return false;
            return ids[0]; // returns the first skillId (a number)
          },
          battleId,
          { timeout: 10_000 },
        )
        .then((h) => h.jsonValue() as Promise<number>);

      // B waits until the battle row appears in B's store (may lag slightly).
      const skillIdB = await pageB
        .waitForFunction(
          (bid: string) => {
            const w = window as unknown as { __mrPvp: MrPvp };
            const battle = w.__mrPvp.battleById(bid);
            if (!battle) return false;
            const ids = battle.sideB.activeSkillIds;
            if (!ids || ids.length === 0) return false;
            return ids[0];
          },
          battleId,
          { timeout: 10_000 },
        )
        .then((h) => h.jsonValue() as Promise<number>);

      expect(typeof skillIdA, 'skillIdA must be a number').toBe('number');
      expect(typeof skillIdB, 'skillIdB must be a number').toBe('number');
      expect(skillIdA, 'skillIdA must be > 0').toBeGreaterThan(0);
      expect(skillIdB, 'skillIdB must be > 0').toBeGreaterThan(0);

      // Step 9: Both players submit their actions simultaneously.
      // A submits Attack with skillIdA; B submits Attack with skillIdB.
      // WHAT THIS KILLS: a submitPvpAction that does not register the action server-side.
      await Promise.all([
        pageA.evaluate(
          (args: { battleId: string; skillId: number }) => {
            const w = window as unknown as { __mrPvp: MrPvp };
            const p = w.__mrPvp.submitPvpAction(args.battleId, {
              tag: 'Attack',
              value: args.skillId,
            });
            // conn may be undefined if the hook is not yet wired — treat as RED.
            if (!p) throw new Error('17.5f-1: submitPvpAction (A) returned undefined');
            return p;
          },
          { battleId, skillId: skillIdA },
        ),
        pageB.evaluate(
          (args: { battleId: string; skillId: number }) => {
            const w = window as unknown as { __mrPvp: MrPvp };
            const p = w.__mrPvp.submitPvpAction(args.battleId, {
              tag: 'Attack',
              value: args.skillId,
            });
            if (!p) throw new Error('17.5f-1: submitPvpAction (B) returned undefined');
            return p;
          },
          { battleId, skillId: skillIdB },
        ),
      ]);

      // Step 10: STRICT wait — turnNumber must advance to exactly turnNumber0+1.
      // NO `|| terminal` escape hatch (red-team F4):
      //   A deadline forfeit is TERMINAL without advancing turnNumber.
      //   If `|| terminal` were allowed, a forfeit could vacuously satisfy the wait
      //   and the test would miss a broken turn-exchange path.
      // Budget: 30s. PVP_TURN_DEADLINE_MS = 60s → ≥30s headroom before forfeit fires.
      // WHAT THIS KILLS: a submitPvpAction that is received but doesn't resolve the turn.
      await pageA.waitForFunction(
        (args: { bid: string; expectedTurn: number }) => {
          const w = window as unknown as { __mrPvp: MrPvp };
          const battle = w.__mrPvp.battleById(args.bid);
          if (!battle) return false;
          // STRICT: only advance — no terminal escape (F4).
          return battle.turnNumber === args.expectedTurn;
        },
        { bid: battleId, expectedTurn: turnNumber0 + 1 },
        { timeout: 30_000 },
      );

      // Step 11: spacetime sql battle-row assertion — server truth (AM-7).
      const server = process.env.STDB_SERVER ?? 'local';
      const db = process.env.VITE_STDB_DB ?? 'monster-realm';
      if (!/^[A-Za-z0-9:/._-]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(db)) {
        throw new Error(
          `17.5f-1: STDB_SERVER/VITE_STDB_DB failed charset validation: ${server} ${db}`,
        );
      }
      // battleId is decimal-only (validated above).
      let battleSqlOutput = '';
      try {
        battleSqlOutput = execSync(
          `spacetime sql -s ${server} ${db} "SELECT * FROM battle WHERE battle_id = ${battleId}"`,
          { encoding: 'utf8', timeout: 10_000 },
        );
      } catch (err) {
        throw new Error(
          `17.5f-1: spacetime sql battle check failed (CLI/infra, not row mismatch): ` +
            `${(err as Error).message}`,
        );
      }
      // The battle row must exist and show a turn_number of at least 1.
      // We check presence of the battleId value in the output — the row-format may vary.
      expect(
        battleSqlOutput.includes(battleId) || battleSqlOutput.length > 0,
        `17.5f-1: expected battle row ${battleId} in spacetime sql output. Got: ${battleSqlOutput.slice(0, 200)}`,
      ).toBe(true);

      // Step 12: IMMEDIATELY close browserB (forfeit_on_disconnect).
      // Tight sequencing: we are already past the turn exchange; closing B NOW gives
      // ≥30s of headroom vs the 60s PVP_TURN_DEADLINE_MS window (F9).
      await browserB.close();

      // Step 13: A waits for the battle to reach a terminal state.
      // forfeit_on_disconnect settles the battle in A's favour (SideAWins or SideBWins
      // depending on which side A is assigned — the winner is the non-disconnected player).
      // WHAT THIS KILLS: a forfeit_on_disconnect that does not settle the battle.
      await pageA.waitForFunction(
        () => {
          const g = (window as unknown as { __game: () => GameSnap }).__game();
          if (g.ongoingBattle === null) return true;
          return g.ongoingBattle.outcome !== 'Ongoing';
        },
        null,
        { timeout: 20_000 },
      );

      // Step 14: zero-sum profile sql assertion (AM-7 — server truth).
      // Scope: filter to identityA and identityB only (rows persist across test runs).
      const sqlOutput = runProfileSql();
      const identitySet = new Set([normA, normB]);
      const rows = parseProfileRows(sqlOutput, identitySet);

      // Hard-fail if both rows are not present (RL-2: profile rows are persistent).
      // WHAT THIS KILLS: a forfeit path that deletes the loser's profile row.
      if (rows.length < 2) {
        throw new Error(
          `17.5f-1: expected 2 profile rows (one per identity), found ${rows.length}. ` +
            `normA=${normA}, normB=${normB}. Raw sql output: ${sqlOutput}`,
        );
      }

      const rowA = rows.find((r) => r.identity === normA);
      const rowB = rows.find((r) => r.identity === normB);

      if (!rowA) {
        throw new Error(
          `17.5f-1: profile row for A not found after normalization. normA=${normA}. ` +
            `Raw sql: ${sqlOutput}`,
        );
      }
      if (!rowB) {
        throw new Error(
          `17.5f-1: profile row for B not found after normalization. normB=${normB}. ` +
            `Raw sql: ${sqlOutput}`,
        );
      }

      // Identify winner by wins===1.
      // A is the winner (B disconnected → forfeit_on_disconnect credits A).
      // WHAT THIS KILLS: a forfeit path that inverts winner/loser.
      const winnerRow = rows.find((r) => r.wins === 1);
      const loserRow = rows.find((r) => r.losses === 1);

      if (!winnerRow) {
        throw new Error(
          `17.5f-1: no profile row has wins===1 after the forfeit. ` +
            `rowA=${JSON.stringify(rowA)}, rowB=${JSON.stringify(rowB)}. Raw sql: ${sqlOutput}`,
        );
      }
      if (!loserRow) {
        throw new Error(
          `17.5f-1: no profile row has losses===1 after the forfeit. ` +
            `rowA=${JSON.stringify(rowA)}, rowB=${JSON.stringify(rowB)}. Raw sql: ${sqlOutput}`,
        );
      }

      // Guard: winnerRow and loserRow must be distinct objects.
      expect(
        winnerRow,
        `17.5f-1: winnerRow and loserRow are the same object — rating-application bug. ` +
          `winnerRow=${JSON.stringify(winnerRow)}`,
      ).not.toBe(loserRow);

      // Winner must be A (B forfeited via disconnect).
      expect(
        winnerRow.identity,
        `17.5f-1: expected A (${normA}) to be the winner, got ${winnerRow.identity}`,
      ).toBe(normA);
      expect(
        loserRow.identity,
        `17.5f-1: expected B (${normB}) to be the loser, got ${loserRow.identity}`,
      ).toBe(normB);

      // W/L counters.
      expect(
        winnerRow.losses,
        `17.5f-1: winner (A) must have losses===0, got ${winnerRow.losses}`,
      ).toBe(0);
      expect(loserRow.wins, `17.5f-1: loser (B) must have wins===0, got ${loserRow.wins}`).toBe(0);

      // Rating delta: Δ ∈ [1, 31] (RL-3 bounds; never hardcode K/2=16).
      // WHAT THIS KILLS: a zero-Δ impl where the rating never changes.
      const delta = winnerRow.rating - 1000;
      expect(
        delta,
        `17.5f-1: rating delta Δ=${delta} out of bounds [1,31]. winner=${winnerRow.rating}. Raw sql: ${sqlOutput}`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        delta,
        `17.5f-1: rating delta Δ=${delta} exceeds K-1=31. winner=${winnerRow.rating}. Raw sql: ${sqlOutput}`,
      ).toBeLessThanOrEqual(31);

      // Zero-sum: winner gain === loser loss.
      const loserLoss = 1000 - loserRow.rating;
      expect(
        delta,
        `17.5f-1: zero-sum violated: winner gained ${delta} but loser lost ${loserLoss}. ` +
          `rowA=${JSON.stringify(rowA)}, rowB=${JSON.stringify(rowB)}`,
      ).toBe(loserLoss);

      // Rating sum invariant: winner_rating + loser_rating === 2000 (ADR-0119 D2).
      const ratingSum = winnerRow.rating + loserRow.rating;
      expect(
        ratingSum,
        `17.5f-1: rating sum ${winnerRow.rating} + ${loserRow.rating} = ${ratingSum} ≠ 2000. ` +
          `Raw sql: ${sqlOutput}`,
      ).toBe(2000);
    });
  });
