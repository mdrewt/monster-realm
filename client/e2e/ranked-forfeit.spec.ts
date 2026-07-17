import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// m17c — ranked PvP forfeit e2e (RL-18, ADR-0119)
//
// TWO-CONTEXT DESIGN
// ==================
// Mirrors trade-full.spec.ts (M16.5d): two separate chromium.launch() instances
// generate distinct SpacetimeDB identities. The SDK caches its connection+identity
// in the page's JS module scope, so a shared browser or BrowserContext would yield
// the same identity for both players — challenge_pvp would be rejected (cannot
// challenge yourself).
//
// FORFEIT VIA DISCONNECT
// ======================
// There is no client-callable forfeit reducer. When browserB closes, the server
// fires pvp::forfeit_on_disconnect (on_disconnect → pvp::forfeit_on_disconnect),
// which settles the battle in A's favour with outcome SideBWins applied to
// the forfeit path. PVP_TURN_DEADLINE_MS = 60s — the scenario completes well
// within that window; there is no race.
//
// SERVER-TRUTH SQL ASSERTIONS (AM-7)
// ===================================
// __game() has no profile field (m17b's job; client/src off-limits; no __mrPvp hook).
// Rating assertions read `spacetime sql` via execSync, reusing global-setup.ts env
// pattern. Identity normalization: both __game().identity and the SQL output identity
// column are normalized to lowercase + '0x' prefix stripped before comparison.
// Winner identified by wins===1 row; hard-fail (throw) if no rows parse or no
// winner found after normalization (AM-7, recruit.spec.ts precedent — never warn-and-continue).
//
// PROFILE ROW SCOPING (AM-7)
// ===========================
// Profile rows persist forever; later test runs add more rows. Assertions are
// scoped to the two identities of THIS test only (filter by identityA / identityB);
// never assert global row counts.
//
// ZERO-SUM ASSERTION
// ==================
// winner rating = 1000 + Δ, wins = 1, losses = 0
// loser  rating = 1000 − Δ, wins = 0, losses = 1
// sum of both ratings === 2000 (invariant, ADR-0119 D2)
// Δ ∈ [1, 31] (never hardcode K/2 = 16; RL-3 bounds only)
//
// EARS CRITERIA COVERED
// =====================
//   RL-18 — two-context ranked flow: challenge → accept → disconnect-forfeit →
//            zero-sum profile assertion via server-truth sql
//   RL-5  — rating applied exactly once (observable via wins===1 on winner)
//   RL-2  — profile rows persist past disconnect (rows exist after B closes)
//   RL-11 — rating sum conservation (winner_rating + loser_rating === 2000)
//
// RED UNTIL m17a IS MERGED
// ========================
// If m17a has not merged, the ranked battle setup (challenge_pvp / accept_challenge
// reducers) will be missing or the profile table will not exist → the challenge
// button poll times out or the sql query returns empty → test fails RED.

// ---------------------------------------------------------------------------
// GameSnap interface: matches the snapshot() fn in client/src/main.ts line ~932.
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
// ---------------------------------------------------------------------------
function normalizeIdentity(id: string): string {
  let s = id.toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  return s;
}

// ---------------------------------------------------------------------------
// runProfileSql: execute spacetime sql and return raw output.
// Validates env values with the SAME literal regexes as global-setup.ts (AM-7).
// Hard-fails (throws) on CLI/infra failure — never warns-and-continues
// (recruit.spec.ts precedent: the cross-check IS the gate).
// ---------------------------------------------------------------------------
function runProfileSql(): string {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  // Literal regexes only — no new RegExp() (global-setup.ts pattern).
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
      `RL-18: spacetime sql failed (CLI/infra failure, not a row-content mismatch): ` +
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
// parseProfileRows: parse the ASCII table output from spacetime sql.
//
// Format (empirically verified):
//   header row: " identity | rating | wins | losses "
//   separator:  "----------+--------+------+--------"
//   data rows:  " 0x<64 hex chars> | 1016 | 1 | 0 "
//
// Returns only rows whose normalized identity is in the provided set.
// Hard-fails (throws with raw output embedded) if:
//   - fewer than 2 data rows are found for the given identities
//   - any numeric column fails to parse
// (AM-7: never warn-and-continue)
// ---------------------------------------------------------------------------
function parseProfileRows(sqlOutput: string, identities: Set<string>): ProfileRow[] {
  const lines = sqlOutput.split('\n').map((l) => l.trim());
  const dataLines = lines.filter((l) => {
    // Data rows contain '|' and start with a hex identity (with or without 0x prefix).
    // Skip header and separator lines (header has text like 'identity', separator has '---').
    if (!l.includes('|')) return false;
    if (l.includes('---')) return false;
    // Skip the header row (contains the word 'identity' as a column name, not a hex value).
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
        `RL-18: failed to parse numeric columns from profile row: ${JSON.stringify(line)}. ` +
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
  .serial('m17c — ranked PvP forfeit e2e (RL-18)', () => {
    let browserA: Browser;
    let ctxA: BrowserContext;
    let pageA: Page;

    let browserB: Browser;
    let ctxB: BrowserContext;
    let pageB: Page;

    // identityA / identityB captured in the flow test; used in afterAll sql check.
    // afterAll is tolerant of already-closed B (B is closed mid-test).
    test.beforeAll(async () => {
      // Two separate browser instances — each gets a distinct SpacetimeDB identity.
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
      // Close A. B is closed mid-test (disconnect-forfeit); be tolerant if
      // afterAll runs after B is already closed (no double-close error surface).
      try {
        await browserA?.close();
      } catch {
        // Ignore — A may have already been closed by a test error path.
      }
      // B is closed inside the flow test. A second close attempt throws in
      // Playwright; we skip it here to keep afterAll clean.
    });

    // -------------------------------------------------------------------------
    // RL-18: challenge → accept → disconnect-forfeit → zero-sum sql assertion
    //
    // WHAT THIS TEST KILLS:
    //   - A forfeit path that does not apply rating (profile rows unchanged → wins=0)
    //   - A double-count path (winner rating > 1000+31, sum ≠ 2000)
    //   - A delete path (profile row missing after forfeit → hard-fail on sql parse)
    //   - A wrong-winner path (B gets wins=1 instead of A)
    //   - A non-zero-sum path (winner gain ≠ loser loss → sum ≠ 2000)
    //
    // RED UNTIL m17a MERGED:
    //   If challenge_pvp / accept_challenge reducers do not exist, the challenge
    //   button never appears → 15s poll times out → test fails RED.
    //   If profile table does not exist, sql returns empty → hard-fail.
    // -------------------------------------------------------------------------
    test('ranked forfeit flow: challenge → accept → B-disconnect → A wins; zero-sum profile assertion (RL-18)', async () => {
      test.setTimeout(120_000);

      // Step 1: capture identities.
      const identityA = await pageA.evaluate(() => {
        return (window as unknown as { __game: () => GameSnap }).__game().identity;
      });
      const identityB = await pageB.evaluate(() => {
        return (window as unknown as { __game: () => GameSnap }).__game().identity;
      });
      expect(identityA, 'identityA must be a non-empty string').not.toBe('');
      expect(identityB, 'identityB must be a non-empty string').not.toBe('');
      expect(identityA, 'identityA and identityB must differ').not.toBe(identityB);

      const normA = normalizeIdentity(identityA);
      const normB = normalizeIdentity(identityB);

      // Step 2: press Escape on B first (AM-5) to ensure no overlay is visible
      // (auto-show on pvp-accept-btn requires !anyOverlayVisible; a stale overlay
      // would suppress the auto-show and leave B unable to accept).
      await pageB.keyboard.press('Escape');
      // Small settle delay — Escape handler is synchronous but give the DOM a tick.
      await pageB.waitForTimeout(200);

      // Step 3: A presses KeyP (opens pvp overlay), THEN polls for the challenge
      // button with a player-identity that is NOT identityA (AM-6 — B's player-row
      // subscription may lag; the list renders "No players online" until B arrives).
      await pageA.keyboard.press('KeyP');

      await pageA.waitForFunction(
        (myIdentity: string) => {
          const btn = document.querySelector(
            '[data-testid="pvp-challenge-player-btn"]',
          ) as HTMLElement | null;
          if (!btn) return false;
          return btn.getAttribute('data-player-identity') !== myIdentity;
        },
        identityA,
        { timeout: 15_000 },
      );

      // Step 4: A clicks the challenge button → challenge_pvp reducer fires.
      // Click the FIRST challenge button whose data-player-identity ≠ identityA.
      // WHAT THIS KILLS: a UI that renders a challenge button with A's own identity
      // (self-challenge), or that does not render any button at all.
      await pageA.evaluate((myIdentity: string) => {
        const buttons = Array.from(
          document.querySelectorAll('[data-testid="pvp-challenge-player-btn"]'),
        ) as HTMLElement[];
        const btn = buttons.find((b) => b.getAttribute('data-player-identity') !== myIdentity);
        if (!btn) throw new Error('RL-18: no challenge button found for a non-self player');
        btn.click();
      }, identityA);

      // Step 5: B waits for pvp-accept-btn to appear (auto-show on incoming challenge;
      // requires !anyOverlayVisible — that is why we pressed Escape on B in step 2).
      // WHAT THIS KILLS: a pvp overlay that does not auto-show on incoming challenge,
      // or an accept button that is absent from the rendered incoming section.
      await pageB.waitForSelector('[data-testid="pvp-accept-btn"]', { timeout: 15_000 });

      // B clicks accept → accept_challenge reducer → ranked battle starts.
      await pageB.click('[data-testid="pvp-accept-btn"]');

      // Step 6: assert battle live on A's page ONLY (AM-2).
      // __game().ongoingBattle is non-null for the player_identity (side A);
      // B is opponent_identity — B's client has NO battle view (store.ongoingBattle
      // matches player_identity only). Do NOT assert B has ongoingBattle.
      // WHAT THIS KILLS: a start_pvp_battle impl that does not create a battle row,
      // or that creates it with the wrong player_identity.
      await pageA.waitForFunction(
        () => {
          const g = (window as unknown as { __game: () => GameSnap }).__game();
          return g.ongoingBattle !== null;
        },
        null,
        { timeout: 15_000 },
      );

      // Step 7: forfeit via disconnect — close browserB.
      // pvp::forfeit_on_disconnect fires inside on_disconnect on the server.
      // PVP_TURN_DEADLINE_MS = 60s; our scenario is well within budget.
      await browserB.close();

      // Step 8: A waits for terminal state — ongoingBattle null (battle GC'd) or
      // outcome changed from Ongoing. 20s headroom: local disconnect→forfeit settle
      // is sub-second; CI containerized spacetime adds latency.
      // WHAT THIS KILLS: a forfeit_on_disconnect impl that does not settle the battle,
      // leaving A stuck in an ongoing battle forever.
      await pageA.waitForFunction(
        () => {
          const g = (window as unknown as { __game: () => GameSnap }).__game();
          // Battle is terminal when ongoingBattle is null (GC'd after outcome write)
          // OR when outcome is no longer 'Ongoing'.
          if (g.ongoingBattle === null) return true;
          return g.ongoingBattle.outcome !== 'Ongoing';
        },
        null,
        { timeout: 20_000 },
      );

      // Step 9: zero-sum sql assertion via server-truth (AM-7).
      // Empirical: identity col = 0x + 64 lowercase hex chars; numeric cols are integers.
      // Scope: filter to identityA and identityB only (rows persist across test runs).
      const sqlOutput = runProfileSql();

      const identitySet = new Set([normA, normB]);
      const rows = parseProfileRows(sqlOutput, identitySet);

      // Hard-fail if we cannot find both rows — profile must be persistent (RL-2).
      // WHAT THIS KILLS: a forfeit path that deletes the loser's profile row.
      if (rows.length < 2) {
        throw new Error(
          `RL-18 / RL-2: expected 2 profile rows (one per identity), found ${rows.length}. ` +
            `identityA (normalized)=${normA}, identityB (normalized)=${normB}. ` +
            `Raw sql output: ${sqlOutput}`,
        );
      }

      const rowA = rows.find((r) => r.identity === normA);
      const rowB = rows.find((r) => r.identity === normB);

      if (!rowA) {
        throw new Error(
          `RL-18: profile row for identityA not found after normalization. ` +
            `normA=${normA}. Raw sql output: ${sqlOutput}`,
        );
      }
      if (!rowB) {
        throw new Error(
          `RL-18: profile row for identityB not found after normalization. ` +
            `normB=${normB}. Raw sql output: ${sqlOutput}`,
        );
      }

      // Identify winner by wins===1 (cross-check identity normalization — AM-7).
      // A is the winner (B forfeited by disconnect → SideAWins or SideBWins depending
      // on which side A is; forfeit_on_disconnect credits A as the survivor).
      // We do not hardcode which identity wins — we find by wins===1 and assert it is A.
      const winnerRow = rows.find((r) => r.wins === 1);
      const loserRow = rows.find((r) => r.losses === 1);

      if (!winnerRow) {
        throw new Error(
          `RL-18 / RL-5: no profile row has wins===1 after the forfeit. ` +
            `rowA=${JSON.stringify(rowA)}, rowB=${JSON.stringify(rowB)}. ` +
            `Raw sql output: ${sqlOutput}`,
        );
      }
      if (!loserRow) {
        throw new Error(
          `RL-18 / RL-5: no profile row has losses===1 after the forfeit. ` +
            `rowA=${JSON.stringify(rowA)}, rowB=${JSON.stringify(rowB)}. ` +
            `Raw sql output: ${sqlOutput}`,
        );
      }

      // Guard: winnerRow and loserRow must be distinct objects.
      // Pathological case: a single row has both wins===1 and losses===1 (a bug
      // where the same row satisfies both predicates — e.g. an identity that won
      // and lost in the same transaction). This assertion catches it before the
      // identity checks below would silently pass on the same row twice.
      expect(
        winnerRow,
        `RL-18: winnerRow and loserRow must be different rows — ` +
          `same row satisfying both wins===1 and losses===1 indicates a rating-application bug. ` +
          `winnerRow=${JSON.stringify(winnerRow)}`,
      ).not.toBe(loserRow);

      // Winner must be A (the surviving player; B disconnected = B forfeited).
      // WHAT THIS KILLS: a forfeit path that inverts winner/loser, crediting B.
      expect(
        winnerRow.identity,
        `RL-18: expected A (${normA}) to be the winner (B forfeited by disconnect), ` +
          `but winner row has identity=${winnerRow.identity}. ` +
          `rowA=${JSON.stringify(rowA)}, rowB=${JSON.stringify(rowB)}`,
      ).toBe(normA);

      // Loser must be B.
      expect(
        loserRow.identity,
        `RL-18: expected B (${normB}) to be the loser (B forfeited by disconnect), ` +
          `but loser row has identity=${loserRow.identity}. ` +
          `rowA=${JSON.stringify(rowA)}, rowB=${JSON.stringify(rowB)}`,
      ).toBe(normB);

      // W/L counters: winner wins=1 losses=0; loser wins=0 losses=1.
      // WHAT THIS KILLS: a path that increments wins without setting the counter correctly.
      expect(
        winnerRow.losses,
        `RL-18 / RL-5: winner (A) must have losses===0, got ${winnerRow.losses}. ` +
          `rowA=${JSON.stringify(rowA)}`,
      ).toBe(0);
      expect(
        loserRow.wins,
        `RL-18 / RL-5: loser (B) must have wins===0, got ${loserRow.wins}. ` +
          `rowB=${JSON.stringify(rowB)}`,
      ).toBe(0);

      // Rating delta: Δ must be in [1, 31] (RL-3 bounds; never hardcode K/2=16).
      // WHAT THIS KILLS: a zero-Δ impl (Δ=0 → wins=1 but no rating change).
      const delta = winnerRow.rating - 1000;
      expect(
        delta,
        `RL-18 / RL-3: rating delta Δ=${delta} is out of bounds [1, 31]. ` +
          `winner rating=${winnerRow.rating}. Raw sql output: ${sqlOutput}`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        delta,
        `RL-18 / RL-3: rating delta Δ=${delta} exceeds K-1=31 bound. ` +
          `winner rating=${winnerRow.rating}. Raw sql output: ${sqlOutput}`,
      ).toBeLessThanOrEqual(31);

      // Zero-sum: winner gain === loser loss (Δ conservation, RL-11).
      // WHAT THIS KILLS: a non-zero-sum impl where winner gains more than loser loses
      // (or vice versa), inflating the total rating pool.
      const loserLoss = 1000 - loserRow.rating;
      expect(
        delta,
        `RL-18 / RL-11: zero-sum violated: winner gained Δ=${delta} but loser lost ${loserLoss}. ` +
          `rowA=${JSON.stringify(rowA)}, rowB=${JSON.stringify(rowB)}. ` +
          `Raw sql output: ${sqlOutput}`,
      ).toBe(loserLoss);

      // Rating sum invariant: winner_rating + loser_rating === 2000 (ADR-0119 D2).
      // WHAT THIS KILLS: a partial-write path where only one row is updated,
      // or a rounding error that breaks the zero-sum contract.
      const ratingSum = winnerRow.rating + loserRow.rating;
      expect(
        ratingSum,
        `RL-18 / RL-11: rating sum invariant violated: ${winnerRow.rating} + ${loserRow.rating} = ${ratingSum} ≠ 2000. ` +
          `Both players start at INITIAL_RATING=1000; zero-sum means sum must remain 2000 (ADR-0119 D2). ` +
          `Raw sql output: ${sqlOutput}`,
      ).toBe(2000);
    });
  });
