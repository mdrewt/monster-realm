import { execSync } from 'node:child_process';
import { chromium, expect, type Page, test } from '@playwright/test';

// pt-c1b — client profile-rename UI e2e (PTC1B-9, ADR-0133 D5)
//
// WHAT THIS PROVES
// ================
// PTC1B-9 (round-trip, server-truth): rename via UI => player.name persists the
// new value (asserted via `spacetime sql SELECT identity, name FROM player`,
// scoped to own identity). The full ranked->leaderboard-DOM reflection is PARKED
// to pt-c1b2 (ADR-0133 D5 rationale).
//
// SINGLE-CONTEXT DESIGN
// =====================
// set_profile_name does not require a second player. One browser/context suffices.
// The SDK's module-scope identity is stable within a single page session.
//
// SERVER-TRUTH SQL ASSERTIONS (RT-RN-10)
// =======================================
// The player table is public and multi-row (all players online). Assertions MUST
// be scoped to the normalized identity of THIS test's player only. Never assert
// on global row counts or on a first-found row (RT-RN-10 — hard-fail on missing
// row / parse failure, never warn-and-continue — recruit.spec / ranked-forfeit
// precedent).
//
// IDENTITY NORMALIZATION
// ======================
// Both __game().identity and the SQL output identity column are normalized to
// lowercase + '0x' prefix stripped before comparison (same as ranked-forfeit.spec.ts).
//
// UNIQUE NAME PER RUN
// ====================
// The name includes Date.now() (truncated mod 1e6 for brevity) so a stale row
// from a prior test run cannot false-pass a name-equality assertion.
//
// LITERAL REGEXES ONLY
// =====================
// No new RegExp() — ReDoS/detect-non-literal lint ban (global-setup.ts pattern).
//
// EARS CRITERIA COVERED
// =====================
//   PTC1B-9 — client rename UI -> reducer -> player.name round-trip (server-truth SQL)
//
// RED UNTIL pt-c1b IS IMPLEMENTED
// =================================
// The rename overlay (#rename-overlay, KeyN handler, renameView) does not exist
// in main.ts or index.html yet. The test will time out polling for
// page.keyboard.press('KeyN') to open the overlay -> test fails RED.

// ---------------------------------------------------------------------------
// GameSnap interface — matches the snapshot() fn in client/src/main.ts.
// We only need identity + ownAuthTile for the ready-poll.
// ---------------------------------------------------------------------------
interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
}

// ---------------------------------------------------------------------------
// gameReady: wait until __game() is present, identity is set, and the player
// has been placed on the map. Mirrors ranked-forfeit.spec.ts.
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
// Reused verbatim from ranked-forfeit.spec.ts (AM-7 empirical risk).
// ---------------------------------------------------------------------------
function normalizeIdentity(id: string): string {
  let s = id.toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  return s;
}

// ---------------------------------------------------------------------------
// runPlayerSql: execute spacetime sql and return raw output for the player table.
// Validates env values with LITERAL regexes only (no new RegExp() — ReDoS ban).
// Hard-fails (throws) on CLI/infra failure — never warns-and-continues
// (recruit.spec.ts / ranked-forfeit.spec.ts precedent: the cross-check IS the gate).
// ---------------------------------------------------------------------------
function runPlayerSql(): string {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  // Literal regexes only — no new RegExp() (global-setup.ts pattern; ADR-0133 §rename.spec.ts).
  if (!/^[A-Za-z0-9:/._-]+$/.test(server)) {
    throw new Error(`STDB_SERVER contains characters outside [A-Za-z0-9:/._-]: ${server}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(`VITE_STDB_DB contains characters outside [A-Za-z0-9_-]: ${db}`);
  }
  let output: string;
  try {
    output = execSync(`spacetime sql -s ${server} ${db} "SELECT identity, name FROM player"`, {
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch (err) {
    throw new Error(
      `PTC1B-9: spacetime sql failed (CLI/infra failure, not a row-content mismatch): ` +
        `${(err as Error).message}`,
    );
  }
  return output;
}

// ---------------------------------------------------------------------------
// PlayerRow: parsed row from spacetime sql ASCII table output.
// ---------------------------------------------------------------------------
interface PlayerRow {
  identity: string; // normalized (lowercase, no 0x)
  name: string;
}

// ---------------------------------------------------------------------------
// parsePlayerRows: parse the ASCII table output from spacetime sql.
//
// Format (empirically verified from ranked-forfeit.spec.ts precedent):
//   header row: " identity | name "
//   separator:  "----------+------"
//   data rows:  " 0x<64 hex chars> | SomeName "
//
// RT-RN-10: filters to the single normalized identity of THIS test's player.
// Hard-fails (throws with raw output embedded) if:
//   - the own identity row is not found
//   - any column fails to parse
// (never warn-and-continue — recruit.spec.ts precedent)
// ---------------------------------------------------------------------------
function parsePlayerRow(sqlOutput: string, ownNormalizedIdentity: string): PlayerRow {
  const lines = sqlOutput.split('\n').map((l) => l.trim());
  const dataLines = lines.filter((l) => {
    if (!l.includes('|')) return false;
    if (l.includes('---')) return false;
    // Skip header row (first column is the word 'identity', not a hex value).
    const firstCol = l.split('|')[0]?.trim() ?? '';
    if (firstCol === 'identity') return false;
    return true;
  });

  for (const line of dataLines) {
    const cols = line.split('|').map((c) => c.trim());
    if (cols.length < 2) continue;
    const rawId = cols[0] ?? '';
    const normalized = normalizeIdentity(rawId);
    if (normalized !== ownNormalizedIdentity) continue;

    // Found the own identity row. spacetime sql wraps STRING column values in
    // double-quotes ("Name") — strip the surrounding pair so the comparison is
    // against the raw stored name. (ranked-forfeit.spec.ts only parses NUMERIC
    // columns, which are unquoted, so that precedent never needed this.) Plain
    // string ops — no RegExp (Semgrep detect-non-literal-regexp hygiene).
    let name = cols[1] ?? '';
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1);
    }
    return { identity: normalized, name };
  }

  // RT-RN-10: hard-fail if no matching row found (never warn-and-continue).
  throw new Error(
    `PTC1B-9 / RT-RN-10: own identity row not found in player table after normalization. ` +
      `Expected normalized identity: ${ownNormalizedIdentity}. ` +
      `Raw sql output (first 800 chars): ${sqlOutput.slice(0, 800)}`,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe
  .serial('pt-c1b — client profile-rename UI e2e (PTC1B-9)', () => {
    // -------------------------------------------------------------------------
    // PTC1B-9: rename via UI -> player.name persists (server-truth SQL)
    //
    // WHAT THIS TEST KILLS:
    //   - A rename overlay that never calls setProfileName (name unchanged in SQL)
    //   - A call that sends the wrong arg key (server rejects → name unchanged)
    //   - An onSubmit that is double-called (idempotent here, but the lock test
    //     in renameView.test.ts covers the primary guard)
    //   - A SQL scope error: asserting a different player's name (RT-RN-10 filter)
    //   - A stale-row false-pass: the unique timestamp suffix prevents a prior run's
    //     name from satisfying the assertion
    //
    // RED UNTIL pt-c1b IMPLEMENTED:
    //   KeyN does not open the overlay → waitForSelector('#rename-overlay[style=""]')
    //   or '[data-testid="rename-input"]' visible → times out → test fails RED.
    // -------------------------------------------------------------------------
    test('PTC1B-9: rename via overlay -> player.name updated in DB (server-truth SQL)', async () => {
      test.setTimeout(60_000);

      const browser = await chromium.launch();
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      try {
        // Step 1: navigate and wait for game ready.
        await page.goto('/');
        await gameReady(page);

        // Step 2: capture own identity.
        const identitySelf = await page.evaluate(() => {
          return (window as unknown as { __game: () => GameSnap }).__game().identity;
        });
        expect(identitySelf, 'own identity must be a non-empty string').not.toBe('');
        const normSelf = normalizeIdentity(identitySelf);

        // Step 3: generate a unique name for this run (timestamp suffix prevents
        // stale-row false-pass from a prior test run).
        // Suffix: last 6 digits of Date.now() (avoids the 24-char maxlength).
        const uniqueSuffix = String(Date.now() % 1_000_000);
        const newName = `RHero${uniqueSuffix}`;
        // Sanity: unique name must be <= 24 chars (server MAX_NAME_LEN).
        expect(
          newName.length,
          'unique name must be <= 24 chars (server MAX_NAME_LEN)',
        ).toBeLessThanOrEqual(24);

        // Step 4: open the rename overlay via KeyN.
        // The overlay must be hidden initially; KeyN opens it when no other overlay is visible.
        await page.keyboard.press('Escape'); // dismiss any stale overlay first
        await page.waitForTimeout(200);
        await page.keyboard.press('KeyN');

        // Step 5: wait for the rename input to be visible (overlay opened).
        // data-testid="rename-input" matches the index.html shell (ADR-0133 §index.html shell).
        await page.waitForSelector('[data-testid="rename-input"]', {
          state: 'visible',
          timeout: 10_000,
        });

        // Step 6: fill the rename input with the unique name.
        await page.fill('[data-testid="rename-input"]', newName);

        // Step 7: click the submit button.
        await page.click('[data-testid="rename-submit"]');

        // Step 8: wait for the feedback element to show a success marker.
        // The onSubmit in main.ts calls showFeedback with a success message after the
        // reducer resolves. We wait for any non-empty textContent in the feedback div.
        // Timeout 15s: local reducer round-trip is sub-second; add headroom for CI.
        await page.waitForFunction(
          () => {
            const fb = document.querySelector('[data-testid="rename-feedback"]');
            return fb !== null && (fb.textContent ?? '').trim().length > 0;
          },
          null,
          { timeout: 15_000 },
        );

        // Step 9: assert the feedback does NOT contain an error indicator.
        // If the server rejected the name (e.g. too long, invalid chars), the feedback
        // would contain an error. We check it is NOT a known error pattern.
        const feedbackText = await page.textContent('[data-testid="rename-feedback"]');
        expect(
          feedbackText ?? '',
          'rename feedback must not contain "error" or "failed" after a valid rename',
        ).not.toMatch(/error|failed|reject/i);

        // Step 10: server-truth SQL assertion (PTC1B-9 / RT-RN-10).
        // Query the player table and filter to the own normalized identity only.
        // Hard-fail on missing row or parse error (never warn-and-continue).
        const sqlOutput = runPlayerSql();
        const row = parsePlayerRow(sqlOutput, normSelf);

        // ★ RT-RN-10: the row is scoped to own identity — never an unscoped assertion.
        // Assert the name was persisted.
        expect(
          row.name,
          `PTC1B-9: player.name in DB must equal the submitted name "${newName}". ` +
            `Got "${row.name}" for normalized identity ${normSelf}. ` +
            `Raw sql output (first 800 chars): ${sqlOutput.slice(0, 800)}`,
        ).toBe(newName);
      } finally {
        await browser.close();
      }
    });
  });
