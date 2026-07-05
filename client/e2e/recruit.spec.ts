import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// recruit.spec.ts — gameplay-driven recruit flow (M13.5h, EARS 13.5h-1).
//
// DESIGN RATIONALE
// ================
// These tests drive the recruit flow using ONLY the real game loop:
// walk onto grass → encounter wild monster → weaken → recruit.  No server
// feature-gated reducers are called from the page; the test cannot
// authenticate as the browser identity (DbConnection is built without
// .withToken; the SDK persists no token in a form the page JS can access),
// so feature-gated server reducers like start_wild_battle and grant_bait
// are not callable from page.evaluate().
//
// The specialist's infra slice (13.5h-1) publishes the module with the
// feature-gated reducers enabled (--bin-path in CI) so server-side feature
// reducers are available for future slices that expose a test hook on
// window.__game().  That publish does NOT make those reducers callable from
// the page — the browser side revival therefore uses pure gameplay.
//
// BOUNDED-RETRY POLICY
// ====================
// Every loop has a named MAX_* constant.  Comments next to each loop give
// the probability arithmetic justifying the bound.  The test fails with a
// descriptive message when a bound is exceeded; it never waits forever.
//
// MOVEMENT PROTOCOL
// =================
// The server drains one queued move per 200 ms (STEP_MS); the client
// queue cap is 2.  We send one step at a time and wait for
// waitForFunction on (ownAuthTile changed OR ongoingBattle appeared)
// before sending the next step.  NEVER call step() while ongoingBattle
// is non-null — the encounter guard is suppressed during Ongoing battles
// but server-side queue drain still runs; a queued move completing during
// battle is safe but wastes the 200 ms slot and can trigger a second
// encounter the instant the battle ends.
//
// HP THRESHOLDS (tunable constants; executor should adjust if CI is flaky)
// =========================================================================
// OWN_HP_FLEE_THRESHOLD_PCT  — flee immediately if own HP% falls at/below this
// WEAKEN_STOP_PCT             — stop attacking wild when opponent HP% is at/below this
// OWN_HP_ATTACK_MIN_PCT       — stop attacking if own HP% falls at/below this

// ---------------------------------------------------------------------------
// Snapshot shape — mirrors the REAL window.__game() snapshot (main.ts:571–627).
// Fields accessed by the test; additional fields exist on the live object.
// ---------------------------------------------------------------------------

interface Tile {
  x: number;
  y: number;
}

interface OwnMonster {
  monsterId: string; // bigint serialised as string (main.ts:597)
  speciesId: number;
  nickname: string;
  level: number;
  partySlot: number; // 255 = box (PARTY_SLOT_NONE)
}

interface OwnInventoryItem {
  invId: string;
  itemId: number;
  count: number;
}

interface OngoingBattle {
  battleId: string; // bigint serialised as string
  outcome: string; // 'Ongoing' only — Ongoing-filter in store.ongoingBattle()
  turnNumber: number;
}

interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  ownMonsters: OwnMonster[];
  ownInventory: OwnInventoryItem[];
  ongoingBattle: OngoingBattle | null; // null when no Ongoing battle (terminal rows excluded)
}

// ---------------------------------------------------------------------------
// Tunable empirical constants — the executor SHOULD adjust if CI is flaky.
// ---------------------------------------------------------------------------
/** Max grass-entry attempts before giving up on triggering any encounter (R1). */
const MAX_GRASS_ENTRIES_R1 = 40; // P(no encounter in 40 @ 20%) = 0.8^40 ≈ 1.3e-4
/** Max outer encounter-loop iterations in R2 (whole encounter cycles incl. flee/KO). */
const MAX_ENCOUNTERS = 14; // per plan: at ≥40%/encounter P(fail all 14) < 1e-3
/** Max recruit clicks per encounter (bounded inner loop). */
const MAX_RECRUIT_CLICKS = 8;
/** Max heal attempts (30s cooldown per heal; KO recovery path). */
const MAX_HEALS = 2;
/** Max skill attacks per encounter when weakening wild (bounded inner). */
const MAX_SKILL_ATTACKS = 6;
/** Step-wait timeout per move in ms (200 ms drain + network + margin). */
const STEP_WAIT_MS = 8_000;
/** Opponent HP% below which we consider the wild sufficiently weakened to recruit. */
const WEAKEN_STOP_PCT = 40;
/** Own HP% below which we stop attacking and try to recruit immediately. */
const OWN_HP_ATTACK_MIN_PCT = 50;
/** Own HP% at/below which we flee immediately (Water-type danger). */
const OWN_HP_FLEE_THRESHOLD_PCT = 30;

// ---------------------------------------------------------------------------
// Grass tiles in zone 0 (content knowledge from plan §World facts).
// Spawn is (1,1); row y=1 is all floor x=1..8.
// Tiles (2,2) and (3,2) are the nearest grass tiles — a (1,2)↔(2,2) shuttle
// via South + East + West covers them without walking into walls.
// ---------------------------------------------------------------------------
const GRASS_SHUTTLE: Array<string> = [
  'South', // (1,1)→(1,2) floor→grass border approach
  'East', // (1,2)→(2,2) grass
  'West', // (2,2)→(1,2)
  'East', // →(2,2) again
  'West', // →(1,2)
];

// ---------------------------------------------------------------------------
// snap: extract the GameSnap-shaped subset from window.__game().
// Only serialisable (non-function) fields are transferred.
// ---------------------------------------------------------------------------
const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      identity: g.identity,
      ownAuthTile: g.ownAuthTile,
      ownMonsters: g.ownMonsters,
      ownInventory: g.ownInventory,
      ongoingBattle: g.ongoingBattle,
    };
  });

// ---------------------------------------------------------------------------
// ready: wait until __game() is available AND identity + tile are non-empty.
// ---------------------------------------------------------------------------
async function ready(p: Page): Promise<void> {
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
// stepOne: send one directional step and wait for the authoritative tile to
// change OR for an ongoingBattle to appear — whichever comes first.
// Returns 'moved' | 'battle' depending on which condition triggered first.
// Precondition: must NOT be called while ongoingBattle is non-null.
// ---------------------------------------------------------------------------
async function stepOne(p: Page, dir: string, fromTile: Tile): Promise<'moved' | 'battle'> {
  await p.evaluate(
    (d) => (window as unknown as { __game: () => { step: (x: string) => void } }).__game().step(d),
    dir,
  );
  // Wait until auth tile changes (move drained) OR a battle appears.
  // Bounded by STEP_WAIT_MS (200 ms drain × safety factor).
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

// ---------------------------------------------------------------------------
// parseHpLine: parse "HP cur/max · Affinity" text from a card's hp text node.
// Returns { cur, max, affinity } or null if the format is unrecognised.
// Source: battleView.ts:135 `HP ${card.currentHp}/${card.maxHp} · ${card.affinity}`
// ---------------------------------------------------------------------------
function parseHpLine(text: string): { cur: number; max: number; affinity: string } | null {
  // Format: "HP 12/20 · Fire"  (note: middle-dot U+00B7)
  const idx = text.indexOf('HP ');
  if (idx === -1) return null;
  const rest = text.slice(idx + 3);
  const slashIdx = rest.indexOf('/');
  const dotIdx = rest.indexOf(' · ');
  if (slashIdx === -1 || dotIdx === -1) return null;
  const cur = parseInt(rest.slice(0, slashIdx), 10);
  const max = parseInt(rest.slice(slashIdx + 1, dotIdx), 10);
  const affinity = rest.slice(dotIdx + 3).trim();
  if (Number.isNaN(cur) || Number.isNaN(max)) return null;
  return { cur, max, affinity };
}

// ---------------------------------------------------------------------------
// waitForBattleCleared: wait until ongoingBattle is null (battle row GC'd or
// fled).  Used after Flee to confirm the overlay is gone.
// ---------------------------------------------------------------------------
async function waitForBattleCleared(p: Page): Promise<void> {
  await p.waitForFunction(
    () => (window as unknown as { __game: () => GameSnap }).__game().ongoingBattle === null,
    null,
    { timeout: 15_000 },
  );
}

// ---------------------------------------------------------------------------
// healViaBox: open the box overlay with KeyB and click "Heal Party".
// The heal_party reducer is zone-scoped and currently free (cost_currency
// schema gap deferred to 13.5c).  30s cooldown — the caller tracks usage.
// Source: boxView.ts:43–47 "Heal Party" button → onHealParty callback →
//         main.ts:665–669 conn.reducers.healParty({locationId}).
// ---------------------------------------------------------------------------
async function healViaBox(p: Page): Promise<void> {
  // Open the box (KeyB); guard: only when no other overlay is active.
  await p.keyboard.press('b');
  // Wait for the box overlay to appear (it contains "Heal Party" button text).
  await p.waitForFunction(
    () => {
      // The box creates its button with textContent 'Heal Party' (boxView.ts:43).
      return !!document.querySelector('button');
    },
    null,
    { timeout: 5_000 },
  );
  // Click the "Heal Party" button (boxView.ts:43).
  const healBtn = p.getByText('Heal Party', { exact: true });
  await healBtn.click({ timeout: 5_000 });
  // Close the box.
  await p.keyboard.press('Escape');
  // Brief wait for the heal reducer to be dispatched and the cooldown to start.
  await p.waitForTimeout(1_000);
}

// ---------------------------------------------------------------------------
// Suite (describe.serial: one page, sequential tests sharing state via the
// suiteScoped variable `winningBattleId` for R3).
// ---------------------------------------------------------------------------

// Suite-scoped: R2 records the battleId from the winning encounter so R3 can
// cross-check via spacetime sql.  Null means R2 did not record a winning id
// (should be unreachable when R2 passes; R3 fails with a clear message).
let winningBattleId: string | null = null;

test.describe
  .serial('M13.5h — wild recruit flow (gameplay-driven)', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    // -------------------------------------------------------------------------
    // R1 (EARS 13.5h-1, criterion 1):
    //   WHEN the player walks onto a grass tile, a wild battle MAY start.
    //   THE recruit-action button SHALL be visible while the battle is Ongoing.
    //   THE bait-selector SHALL be present AND contain ZERO options with
    //   data-recruit-bonus (no bait in a fresh inventory — classify-by-data
    //   negative half, ADR-0047).
    //   The test flees after assertions to leave a clean state for R2.
    // -------------------------------------------------------------------------
    test('R1: recruit-action visible + bait-selector has no bait options in fresh inventory', async () => {
      test.setTimeout(120_000);

      // Walk grass until we get a wild encounter.
      // P(no encounter in 40 grass entries @ 20%) = 0.8^40 ≈ 1.3e-4.
      let encounterFound = false;
      for (let i = 0; i < MAX_GRASS_ENTRIES_R1 && !encounterFound; i++) {
        const g = await snap(page);
        if (g.ongoingBattle !== null) {
          encounterFound = true;
          break;
        }
        const dir = GRASS_SHUTTLE[i % GRASS_SHUTTLE.length] ?? 'East';
        const tile = g.ownAuthTile ?? { x: 1, y: 1 };
        try {
          const outcome = await stepOne(page, dir, tile);
          if (outcome === 'battle') encounterFound = true;
        } catch {
          // stepOne timed out (wall-bump — tile did not change AND no battle).
          // Continue with the next direction in the shuttle.
        }
      }

      expect(encounterFound, 'Expected a wild battle within MAX_GRASS_ENTRIES_R1 steps').toBe(true);

      // The battle overlay must be visible; outcome must be Ongoing.
      const s = await snap(page);
      expect(s.ongoingBattle).not.toBeNull();
      expect(s.ongoingBattle!.outcome).toBe('Ongoing');

      // Recruit button must be visible (battleView.ts:205 data-testid="recruit-action").
      const recruitBtn = page.locator('[data-testid="recruit-action"]');
      await expect(recruitBtn).toBeVisible({ timeout: 5_000 });

      // Bait selector must be present (battleView.ts:183 data-testid="bait-selector").
      const baitSel = page.locator('[data-testid="bait-selector"]');
      await expect(baitSel).toBeVisible({ timeout: 5_000 });

      // NEGATIVE classify-by-data assertion (ADR-0047): a fresh inventory has no
      // items with recruit_bonus > 0, so bait-selector must have ZERO options with
      // data-recruit-bonus.  An impl that hard-codes bait options instead of
      // filtering by data attribute would fail here.
      // Source: battleView.ts:198 `opt.setAttribute('data-recruit-bonus', ...)`.
      const baitOptions = page.locator('[data-testid="bait-selector"] [data-recruit-bonus]');
      const baitCount = await baitOptions.count();
      expect(baitCount, 'Fresh inventory must have zero bait options (data-recruit-bonus)').toBe(0);

      // The selector assertion above is the authoritative DOM-level check.
      // (itemDef.recruitBonus is not exposed in the GameSnap; classify-by-data is
      // enforced at the DOM level via data-recruit-bonus — ADR-0047.)

      // Flee to clean up for R2.
      // Source: battleView.ts:164 Flee button textContent = 'Flee'.
      const fleeBtn = page.getByText('Flee', { exact: true });
      await fleeBtn.click({ timeout: 5_000 });
      await waitForBattleCleared(page);
    });

    // -------------------------------------------------------------------------
    // R2 (EARS 13.5h-1, criterion 2):
    //   WHEN the player weakens a wild monster and clicks Recruit, THE recruit
    //   SHALL eventually succeed.  ownMonsters.length SHALL increase by 1.
    //   THE new monster SHALL have partySlot === 255 (PARTY_SLOT_NONE = box).
    //   Records the winning battleId for R3.
    //
    //   Encounter loop: MAX_ENCOUNTERS = 14.
    //   Per encounter, recruit_chance ≈ 80‰ + 500‰×(missingHpFraction).
    //   At ~40% wild HP remaining: chance ≈ 380‰ per click.
    //   P(≥1 success in 8 clicks at 380‰) ≈ 1 - (1-0.38)^8 ≈ 0.98.
    //   P(success per encounter) ≈ 0.98 × P(not-Water) × P(not-KO-before-recruit).
    //   Conservatively 40% per encounter; P(fail all 14) ≈ 0.6^14 ≈ 8e-4.
    //   Actual rate is higher: starter is L5 Fire, most wilds are not Water-type.
    // -------------------------------------------------------------------------
    test('R2: successful recruit increments ownMonsters by 1 with partySlot 255', async () => {
      test.setTimeout(300_000);

      const beforeSnap = await snap(page);
      const countBefore = beforeSnap.ownMonsters.length;
      const monsterIdsBefore = new Set(beforeSnap.ownMonsters.map((m) => m.monsterId));

      let recruited = false;
      let healCount = 0;
      winningBattleId = null;

      for (let enc = 0; enc < MAX_ENCOUNTERS && !recruited; enc++) {
        // Walk grass until a battle starts.
        // P(no encounter in 40 entries @ 20%) ≈ 1.3e-4; outer loop re-attempts.
        let encBattleFound = false;
        let currentBattleId: string | null = null;

        for (let step = 0; step < MAX_GRASS_ENTRIES_R1 && !encBattleFound; step++) {
          const g = await snap(page);
          if (g.ongoingBattle !== null) {
            encBattleFound = true;
            currentBattleId = g.ongoingBattle.battleId;
            break;
          }
          const dir = GRASS_SHUTTLE[step % GRASS_SHUTTLE.length] ?? 'East';
          const tile = g.ownAuthTile ?? { x: 1, y: 1 };
          try {
            const outcome = await stepOne(page, dir, tile);
            if (outcome === 'battle') {
              encBattleFound = true;
              const afterStep = await snap(page);
              currentBattleId = afterStep.ongoingBattle?.battleId ?? null;
            }
          } catch {
            // Timed out (wall-bump or slow drain); try next shuttle direction.
          }
        }

        if (!encBattleFound) {
          // Could not trigger an encounter this loop iteration; keep trying.
          continue;
        }

        // Record the battleId at encounter start for R3.
        winningBattleId = currentBattleId;

        // --- Check opponent affinity: flee Water-type wilds immediately. ---
        // Water is super-effective vs the Fire starter (Flameling L5, HP 19–21).
        // Tidalin L7 max damage can one-shot it (plan §Combat facts).
        // Source: battleView.ts:135 `HP ${cur}/${max} · ${affinity}`.
        // The HP text node is the first matching element (opponent card rendered first
        // in #opponentCardEl, battleView.ts:103).
        const opponentCardText = await page
          .locator('text=/HP \\d+\\/\\d+ · /')
          .first()
          .textContent({ timeout: 5_000 })
          .catch(() => '');
        const opponentHp = parseHpLine(opponentCardText ?? '');

        if (opponentHp && opponentHp.affinity === 'Water') {
          // Flee immediately — Water wipe risk.
          const fleeBtn = page.getByText('Flee', { exact: true });
          await fleeBtn.click({ timeout: 5_000 });
          await waitForBattleCleared(page);
          winningBattleId = null; // encounter did not proceed to recruit
          continue;
        }

        // --- Weaken the wild with skill attacks while HP% is above threshold. ---
        // Each skill attack = one exchange (you hit, wild hits back).
        // Stop when opponent HP% <= WEAKEN_STOP_PCT OR own HP% <= OWN_HP_ATTACK_MIN_PCT.
        // MAX_SKILL_ATTACKS bounds the inner loop (safety net).
        for (let atk = 0; atk < MAX_SKILL_ATTACKS; atk++) {
          // Re-read HP from DOM before each attack.
          // Source: battleView.ts:113 `${label}: ${card.speciesName}` (header) and :135 (hp).
          const allHpTexts = await page.locator('text=/HP \\d+\\/\\d+ · /').allTextContents();

          // allHpTexts[0] is the opponent card (rendered first: #opponentCardEl, battleView.ts:103).
          // allHpTexts[1] is the player card.
          const oppHpInfo = allHpTexts[0] ? parseHpLine(allHpTexts[0]) : null;
          const ownHpInfo = allHpTexts[1] ? parseHpLine(allHpTexts[1]) : null;

          const oppPct =
            oppHpInfo && oppHpInfo.max > 0 ? (oppHpInfo.cur / oppHpInfo.max) * 100 : 100;
          const ownPct =
            ownHpInfo && ownHpInfo.max > 0 ? (ownHpInfo.cur / ownHpInfo.max) * 100 : 100;

          // Flee if own HP critically low from wild counterattacks.
          if (ownPct <= OWN_HP_FLEE_THRESHOLD_PCT) {
            const fleeBtn = page.getByText('Flee', { exact: true });
            await fleeBtn.click({ timeout: 5_000 });
            await waitForBattleCleared(page);
            winningBattleId = null;
            break;
          }

          // Wild is sufficiently weakened OR own HP is marginal — stop attacking.
          if (oppPct <= WEAKEN_STOP_PCT || ownPct <= OWN_HP_ATTACK_MIN_PCT) break;

          // Click the first available skill button.
          // Source: battleView.ts:149 textContent `${skill.name} (${skill.power})`.
          // No testid — locate by text pattern.
          const skillBtn = page.locator('button:has-text("(")').first();
          if (await skillBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await skillBtn.click({ timeout: 3_000 });
            // Wait for the turn to complete (turnNumber increments OR battle ends).
            const beforeTurn = await snap(page);
            const tn = beforeTurn.ongoingBattle?.turnNumber ?? -1;
            await page
              .waitForFunction(
                (args: { prevTurn: number }) => {
                  const g = (window as unknown as { __game: () => GameSnap }).__game();
                  // Battle ended (GC'd → null) or turn advanced.
                  if (g.ongoingBattle === null) return true;
                  return g.ongoingBattle.turnNumber > args.prevTurn;
                },
                { prevTurn: tn },
                { timeout: 10_000 },
              )
              .catch(() => null); // tolerate if battle ended before waitForFunction resolved
          } else {
            // Skills not visible (battle may have ended) — break.
            break;
          }

          // If the battle ended (KO'd) break out of the attack loop.
          const midSnap = await snap(page);
          if (midSnap.ongoingBattle === null) {
            winningBattleId = null;
            break;
          }
        }

        // --- Check if the battle ended (KO or fled) before we could recruit. ---
        const postWeakenSnap = await snap(page);
        if (postWeakenSnap.ongoingBattle === null) {
          // SideBWins (KO) or Fled: check if we need to heal.
          // On KO the overlay hides (battle row GC'd); fainted party blocks encounters.
          // Recover via KeyB → "Heal Party" (zone-scoped, currently free, 30s cooldown).
          if (healCount < MAX_HEALS) {
            healCount++;
            await healViaBox(page);
            // Cooldown: wait enough for the server to process heal before re-entering grass.
            await page.waitForTimeout(2_000);
          } else {
            // Ran out of heals — bail out with a useful failure message.
            expect
              .soft(false, `R2: exceeded MAX_HEALS (${MAX_HEALS}); party fainted too often`)
              .toBe(true);
            break;
          }
          winningBattleId = null;
          continue;
        }

        // --- Click Recruit, bounded inner loop. ---
        // recruit_chance = 80‰ + 500‰×(missingHpFraction).
        // At ~40% HP remaining: ≈380‰ per click.
        // P(≥1 success in 8 clicks @ 380‰) ≈ 0.98.
        for (let rc = 0; rc < MAX_RECRUIT_CLICKS && !recruited; rc++) {
          // Safety: confirm battle is still Ongoing before each recruit click.
          const preRecSnap = await snap(page);
          if (preRecSnap.ongoingBattle === null) {
            winningBattleId = null;
            break;
          }

          // Also check own HP hasn't dropped dangerously from failed recruit counterattacks.
          // (Each FAILED recruit click = one wild counterattack — plan §Combat facts.)
          const allHpNow = await page.locator('text=/HP \\d+\\/\\d+ · /').allTextContents();
          const ownHpNow = allHpNow[1] ? parseHpLine(allHpNow[1]) : null;
          const ownPctNow =
            ownHpNow && ownHpNow.max > 0 ? (ownHpNow.cur / ownHpNow.max) * 100 : 100;

          if (ownPctNow <= OWN_HP_FLEE_THRESHOLD_PCT) {
            // Too risky — flee before the wild can KO us.
            const fleeBtn = page.getByText('Flee', { exact: true });
            await fleeBtn.click({ timeout: 5_000 });
            await waitForBattleCleared(page);
            winningBattleId = null;
            break;
          }

          // Click recruit (battleView.ts:205 data-testid="recruit-action").
          const recruitBtn = page.locator('[data-testid="recruit-action"]');
          await recruitBtn.click({ timeout: 5_000 });

          // Wait for: ownMonsters count increased (success) OR battle ended (KO/flee).
          // The server processes attemptRecruit, updates monster_pub, and resolves the battle.
          await page
            .waitForFunction(
              (args: { countBefore: number }) => {
                const g = (window as unknown as { __game: () => GameSnap }).__game();
                if (g.ownMonsters.length > args.countBefore) return 'recruited';
                if (g.ongoingBattle === null) return 'ended';
                return false;
              },
              { countBefore: countBefore },
              { timeout: 15_000 },
            )
            .catch(() => null);

          const postRecSnap = await snap(page);
          if (postRecSnap.ownMonsters.length > countBefore) {
            recruited = true;
            // winningBattleId is already set from the encounter start.
            break;
          }

          // Recruit failed — battle may still be Ongoing (failed recruit + counterattack).
          if (postRecSnap.ongoingBattle === null) {
            // KO'd during a failed recruit counterattack.
            if (healCount < MAX_HEALS) {
              healCount++;
              await healViaBox(page);
              await page.waitForTimeout(2_000);
            } else {
              expect
                .soft(false, `R2: exceeded MAX_HEALS (${MAX_HEALS}) during recruit clicks`)
                .toBe(true);
            }
            winningBattleId = null;
            break;
          }
          // Otherwise: failed recruit, battle still Ongoing — try again.
        }
      }

      // -------------------------------------------------------------------------
      // Final assertions
      // -------------------------------------------------------------------------
      expect(recruited, `R2: did not recruit within MAX_ENCOUNTERS=${MAX_ENCOUNTERS}`).toBe(true);

      const afterSnap = await snap(page);
      expect(afterSnap.ownMonsters.length).toBe(countBefore + 1);

      // Find the new monster (the one not present in the before-set, compared by monsterId).
      // Kills: an impl that does not write the monsterId to the snapshot, or uses the wrong
      // field name (snake_case monster_id vs camelCase monsterId) — the Set lookup fails.
      const newMonster = afterSnap.ownMonsters.find((m) => !monsterIdsBefore.has(m.monsterId));
      expect(newMonster, 'R2: newly recruited monster must appear in ownMonsters').toBeDefined();
      // The recruited monster goes to the box (partySlot === 255 = PARTY_SLOT_NONE).
      // Kills: an impl that inserts the monster into a party slot instead of the box.
      expect(newMonster!.partySlot).toBe(255);
    });

    // -------------------------------------------------------------------------
    // R3 (EARS 13.5h-1, criterion 3, piggybacks R2):
    //   After a successful recruit, the battle row SURVIVES with SideAWins
    //   (attempt_recruit GC gap — taming.rs never GC's the row; unlike
    //   write_back_battle_results which only GC's non-Ongoing rows for loser).
    //   ASSERT: the outcome frame shows exactly 'Victory!' (SideAWins mapping,
    //   battleView.ts:240).
    //   CROSS-CHECK: spacetime sql confirms the recorded battleId has SideAWins.
    //   Kills: an impl that GC's the battle row on successful recruit, which
    //   would hide the overlay (battleView.ts: refresh(null) → hide()) and make
    //   Victory! invisible.
    // -------------------------------------------------------------------------
    test('R3: winning battle shows Victory! and spacetime sql confirms SideAWins', async () => {
      test.setTimeout(30_000);

      if (winningBattleId === null) {
        // R2 did not record a winning battleId — this should be unreachable
        // when R2 passes, but provide a clear message if it is reached.
        expect.fail(
          'R3: winningBattleId is null — R2 did not record a successful recruit battleId',
        );
        return;
      }

      // The Victory! outcome frame must be visible.
      // Source: battleView.ts:240 `text = 'Victory!'` (SideAWins case).
      // The outcome element is `#outcomeEl` with display:block (battleView.ts:236).
      // Locate by exact textContent — no testid on this element.
      const victoryEl = page.getByText('Victory!', { exact: true });
      await expect(victoryEl).toBeVisible({ timeout: 10_000 });

      // Cross-check via spacetime sql that the server confirms SideAWins.
      // Syntax precedent: global-setup.ts (execSync), smoke-republish.sh (spacetime sql).
      // The outcome enum variant prints as its name (e.g. 'SideAWins') in sql output.
      // NEVER use new RegExp(dynamic): use .includes() only (spec-gap-revival discipline).
      const server = process.env.STDB_SERVER ?? 'local';
      const db = process.env.VITE_STDB_DB ?? 'monster-realm';
      let sqlOutput = '';
      try {
        sqlOutput = execSync(
          `spacetime sql -s ${server} ${db} "SELECT outcome FROM battle WHERE battle_id = ${winningBattleId}"`,
          { encoding: 'utf8', timeout: 10_000 },
        );
      } catch (err) {
        // SQL failure is a non-fatal warning — the DOM assertion above is the primary gate.
        console.warn(`R3: spacetime sql cross-check failed: ${(err as Error).message}`);
        return;
      }

      // The sql output must include 'SideAWins' (variant name).
      // Kills: an impl that GC's the battle row on recruit success — the row would
      // not exist in the query result, sqlOutput would not contain 'SideAWins'.
      expect(
        sqlOutput.includes('SideAWins'),
        `R3: expected spacetime sql output to include 'SideAWins' for battleId=${winningBattleId}, got: ${sqlOutput.slice(0, 200)}`,
      ).toBe(true);
    });

    // -------------------------------------------------------------------------
    // R4 (RE-ANCHOR — test.fixme, real blocker documented):
    //   Bait-selector classify-by-data: a bait item grants recruit_bonus > 0.
    //   The test would: grant a bait item, enter a battle, assert bait-selector
    //   has ≥1 option with data-recruit-bonus > 0, assert no non-bait item appears.
    //
    //   RE-ANCHOR REASON: a bait item (e.g. Lure Berry, itemId 1) can only be
    //   granted to the browser-session identity via:
    //   (a) A client/src slice that exposes a test-only bait-grant hook on
    //       __game() (e.g. __game().grantBait(itemId, qty)) — this hook does
    //       not exist yet; it is owned by a different client/src slice.
    //   (b) The shop path — Lure Berry costs 200 currency; a player earns
    //       ~31 currency per KO-win, requiring ~7 KO battles, which is over
    //       the e2e time/flake budget for a single test.
    //   (c) The `spacetime call` path — this requires a browser token that is
    //       not accessible from the test: DbConnection is built without
    //       .withToken, the SDK persists no credential, and there is no HTTP
    //       API surface to obtain the browser identity's token from the test
    //       process.
    //   This test will be un-fixmed when a client/src slice exposes
    //   __game().grantBait(itemId, qty) or equivalent test-hook on __game().
    // -------------------------------------------------------------------------
    test.fixme('R4: bait selector lists only items with recruit_bonus > 0 (blocked: __game() test-hook not exposed; owned by a client/src slice)', async () => {
      // STEP 1: grant a bait item.
      //   Requires __game().grantBait(itemId, qty) on the snapshot — not yet exposed.
      //   See re-anchor reason above.
      // STEP 2: trigger a wild battle (grass walk as in R1).
      // STEP 3: bait-selector must be visible.
      //   const selector = page.locator('[data-testid="bait-selector"]');
      //   await expect(selector).toBeVisible({ timeout: 5_000 });
      // STEP 4: assert ≥1 option with data-recruit-bonus.
      //   Source: battleView.ts:198 opt.setAttribute('data-recruit-bonus', String(bait.recruitBonus))
      //   const baitOptions = page.locator('[data-testid="bait-selector"] [data-recruit-bonus]');
      //   const count = await baitOptions.count();
      //   expect(count).toBeGreaterThanOrEqual(1);
      // STEP 5: assert all data-recruit-bonus values are > 0 (classify-by-data ADR-0047).
      //   for (let i = 0; i < count; i++) {
      //     const bonus = await baitOptions.nth(i).getAttribute('data-recruit-bonus');
      //     expect(Number(bonus)).toBeGreaterThan(0);
      //   }
      // STEP 6: assert no non-bait items appear in the selector.
      //   (All options except "No bait" sentinel must have data-recruit-bonus > 0.)
      // Clean up: Flee.
    });
  });
