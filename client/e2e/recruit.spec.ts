import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// M8d recruit e2e spec.
//
// EARS criteria covered:
//   R1 — Recruit action is visible when in a wild battle with the Recruit button.
//   R2 — Attempting recruit with a high-chance scenario (wild at 0 HP) eventually
//        succeeds and the box gains a new monster (monster_pub count increments).
//   R3 — After a successful recruit the battle outcome is no longer Ongoing
//        (the battle resolves as SideAWins from the server).
//
// NOTE ON BOUNDED RETRY: the spec NEVER loops without a hard cap. The recruit
// roll uses ctx.random() on the server; we cannot force a specific outcome from
// the client. Instead we call start_wild_battle up to MAX_ATTEMPTS times and
// assert that at least one succeeds — bounded, deterministic timeout.
//
// If the full e2e plumbing is not yet wired (the Recruit button / bait selector
// do not exist in the UI yet), the individual tests below are skipped via
// test.fixme. The skeleton documents the EXACT steps and assertions the
// specialist must un-fixme when the UI lands. Each fixme'd block still
// constitutes a committed, reviewable spec.
//
// DEFERRED TO M9c (M8.7e): the bait/recruit e2e remains test.fixme because the
// bait client surface + dev-reducer wiring (start_wild_battle / grant_bait) is
// deferred to M9c. M9 raising owns the inventory-subscription work (per
// M9-raising.spec §4 — M9c is "a pure subscription view"; M9b introduces the
// canonical player_item table and retrofits the M8 bait grants through
// grant_item), and M8.7b release-gated the dev reducers out of the default
// client bindings (#[cfg(feature = "dev_reducers")]), so there is no green path
// for these from a client-only slice. These stay test.fixme until M9c lands.
//
// Mirror: golden.spec.ts setup/globals.

// ---------------------------------------------------------------------------
// Shared state interface — mirrors golden.spec.ts
// ---------------------------------------------------------------------------

interface Tile {
  x: number;
  y: number;
}

interface MonsterPub {
  monster_id: number;
  owner_identity: string;
  species_id: number;
  level: number;
  current_hp: number;
  stat_hp: number;
  party_slot: number;
}

interface BattleSnap {
  battle_id: number | null;
  outcome: string | null; // "Ongoing" | "SideAWins" | "SideBWins" | "Fled" | null
  wildHp: number | null;
  wildMaxHp: number | null;
  hasBattleView: boolean;
  hasRecruitButton: boolean;
  baitItemCount: number; // number of bait items (recruit_bonus > 0) in inventory binding
}

interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  monsterPubCount: number; // total owned monsters in box+party
  battle: BattleSnap;
}

// The client exposes window.__game() as in golden.spec.ts.
// M8d adds: __game().battle.hasBattleView, .hasRecruitButton, .baitItemCount,
//           __game().monsterPubCount.
// The specialist must wire these fields into the __game() snapshot.
const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      identity: g.identity,
      ownAuthTile: g.ownAuthTile,
      monsterPubCount: g.monsterPubCount,
      battle: g.battle,
    };
  });

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
// Max attempts for a bounded recruit loop.  Even at RECRUIT_BASE_RATE=50 and
// zero bait, 20 attempts gives (1-(50/1000))^20 = ~36% chance of no success,
// which is unacceptably flaky.  With MAX_HP=0 forced via heal_party then
// damage maneuver (or using a 100% bait), the chance per attempt approaches
// certainty, so MAX_ATTEMPTS=1 suffices when the HP path is maximised.
// We cap at 10 as a belt-and-suspenders against a probabilistic failure even
// at high chance, while keeping the test bounded.
// ---------------------------------------------------------------------------
const MAX_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// Suite: one window, sequential tests
// ---------------------------------------------------------------------------

test.describe
  .serial('M8d — wild recruit flow', () => {
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
    // R1 — Recruit button is visible in a wild battle
    // -------------------------------------------------------------------------
    test.fixme('R1: Recruit button is visible in the battle view during a wild encounter', async () => {
      // STEP 1: trigger a wild battle via the dev reducer.
      //   The client must expose a callable that invokes start_wild_battle(0).
      //   The specialist wires: window.__game().startWildBattle(zoneId: number).
      await page.evaluate(() => {
        (window as unknown as { __game: () => { startWildBattle: (z: number) => void } })
          .__game()
          .startWildBattle(0);
      });

      // STEP 2: wait until hasBattleView is true (the battle UI mounted).
      await page.waitForFunction(
        () => {
          const g = (window as unknown as { __game: () => GameSnap }).__game();
          return g.battle.hasBattleView && g.battle.outcome === 'Ongoing';
        },
        null,
        { timeout: 15_000 },
      );

      // STEP 3: assert Recruit button is present in the DOM.
      //   The specialist renders a button with data-testid="recruit-action".
      const btn = page.locator('[data-testid="recruit-action"]');
      await expect(btn).toBeVisible({ timeout: 5_000 });

      // STEP 4: snapshot also confirms hasBattleView + hasRecruitButton via state.
      const s = await snap(page);
      expect(s.battle.hasBattleView).toBe(true);
      expect(s.battle.hasRecruitButton).toBe(true);

      // Clean up: flee so subsequent tests start fresh.
      await page.evaluate(() => {
        const g = (window as unknown as { __game: () => { flee: () => void } }).__game();
        g.flee();
      });
      await page.waitForFunction(
        () => {
          const g = (window as unknown as { __game: () => GameSnap }).__game();
          return g.battle.outcome !== 'Ongoing' || g.battle.battle_id === null;
        },
        null,
        { timeout: 10_000 },
      );
    });

    // -------------------------------------------------------------------------
    // R2 — Successful recruit increments monster_pub count in the box
    // -------------------------------------------------------------------------
    test.fixme('R2: A successful recruit (wild at low HP) appears in the box (monster_pub count +1)', async () => {
      // PRECONDITION: snapshot before to capture the current monster count.
      const before = await snap(page);
      const countBefore = before.monsterPubCount;

      // STEP 1: bounded recruit-attempt loop.
      //   We call start_wild_battle + Recruit up to MAX_ATTEMPTS times.
      //   The loop exits as soon as monsterPubCount increases by 1.
      //   This is BOUNDED (MAX_ATTEMPTS = 10); never an unbounded retry.
      let recruited = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !recruited; attempt++) {
        // Trigger a wild battle.
        await page.evaluate(() => {
          (window as unknown as { __game: () => { startWildBattle: (z: number) => void } })
            .__game()
            .startWildBattle(0);
        });

        // Wait for Ongoing battle.
        await page.waitForFunction(
          () => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            return g.battle.outcome === 'Ongoing' && g.battle.hasBattleView;
          },
          null,
          { timeout: 15_000 },
        );

        // Click Recruit. The specialist wires data-testid="recruit-action".
        const btn = page.locator('[data-testid="recruit-action"]');
        await btn.click({ timeout: 5_000 });

        // Wait for the battle to resolve (any non-Ongoing outcome) or for
        // monsterPubCount to increase.
        await page.waitForFunction(
          (countBefore: number) => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            return g.battle.outcome !== 'Ongoing' || g.monsterPubCount > countBefore;
          },
          countBefore,
          { timeout: 10_000 },
        );

        const after = await snap(page);
        if (after.monsterPubCount > countBefore) {
          recruited = true;
          // ASSERTION: exactly one new monster in box (party_slot == PARTY_SLOT_NONE = 255).
          //   The specialist exposes window.__game().ownedMonsters: MonsterPub[].
          const newMonsters = await page.evaluate(() => {
            const g = (
              window as unknown as {
                __game: () => { monsterPubCount: number; ownedMonsters: MonsterPub[] };
              }
            ).__game();
            return g.ownedMonsters.filter((m) => m.party_slot === 255);
          });

          // The recruited monster must be in the box (party_slot = 255 = PARTY_SLOT_NONE).
          expect(newMonsters.length).toBeGreaterThanOrEqual(1);
          expect(after.monsterPubCount).toBe(countBefore + 1);
        } else if (after.battle.outcome !== 'Ongoing') {
          // Failed recruit — battle resolved as failure. Allow next attempt.
          // (No action needed: the next iteration re-starts a fresh battle.)
        }
      }

      // Final assertion: within MAX_ATTEMPTS, at least one recruit succeeded.
      expect(recruited).toBe(true);
    });

    // -------------------------------------------------------------------------
    // R3 — Successful recruit resolves battle as SideAWins (not Ongoing / Fled)
    // -------------------------------------------------------------------------
    test.fixme('R3: After a successful recruit the battle outcome is SideAWins (not Ongoing or Fled)', async () => {
      // This test uses the same bounded loop pattern as R2 but specifically
      // asserts the outcome transitions to SideAWins (not Fled or SideBWins).

      let sawSideAWins = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !sawSideAWins; attempt++) {
        await page.evaluate(() => {
          (window as unknown as { __game: () => { startWildBattle: (z: number) => void } })
            .__game()
            .startWildBattle(0);
        });

        await page.waitForFunction(
          () => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            return g.battle.outcome === 'Ongoing' && g.battle.hasBattleView;
          },
          null,
          { timeout: 15_000 },
        );

        const btn = page.locator('[data-testid="recruit-action"]');
        await btn.click({ timeout: 5_000 });

        await page.waitForFunction(
          () => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            return g.battle.outcome !== 'Ongoing';
          },
          null,
          { timeout: 10_000 },
        );

        const s = await snap(page);
        if (s.battle.outcome === 'SideAWins') {
          sawSideAWins = true;
        }
        // If outcome is SideBWins or Fled, that means recruit failed on this
        // attempt — continue to next attempt in the bounded loop.
      }

      // Within MAX_ATTEMPTS, at least one recruit must have produced SideAWins.
      expect(sawSideAWins).toBe(true);
    });

    // -------------------------------------------------------------------------
    // R4 — Bait selector shows only items with recruit_bonus > 0
    //
    // This test is purely structural — it checks the client-side classification
    // rule (ADR-0047: classify by data, not by magic id).
    // -------------------------------------------------------------------------
    test.fixme('R4: Bait selector lists only items whose recruit_bonus > 0 from the item_row binding', async () => {
      // STEP 1: grant a bait item via the dev reducer grant_bait.
      //   The specialist exposes window.__game().grantBait(itemId, qty).
      //   This calls the grant_bait reducer which self-scopes to ctx.sender.
      await page.evaluate(() => {
        (
          window as unknown as {
            __game: () => { grantBait: (itemId: number, qty: number) => void };
          }
        )
          .__game()
          .grantBait(1, 5); // item_id=1 must have recruit_bonus > 0 in the content
      });

      // STEP 2: trigger a wild battle so the battle UI appears.
      await page.evaluate(() => {
        (window as unknown as { __game: () => { startWildBattle: (z: number) => void } })
          .__game()
          .startWildBattle(0);
      });

      await page.waitForFunction(
        () => {
          const g = (window as unknown as { __game: () => GameSnap }).__game();
          return g.battle.hasBattleView && g.battle.outcome === 'Ongoing';
        },
        null,
        { timeout: 15_000 },
      );

      // STEP 3: the bait selector must be visible and list at least 1 item.
      //   The specialist renders data-testid="bait-selector".
      const selector = page.locator('[data-testid="bait-selector"]');
      await expect(selector).toBeVisible({ timeout: 5_000 });

      // STEP 4: assert the bait count in the game snapshot matches the selector.
      const s = await snap(page);
      expect(s.battle.baitItemCount).toBeGreaterThanOrEqual(1);

      // STEP 5: assert no non-bait item appears in the selector.
      //   The specialist filters by item_row.recruit_bonus > 0 (not by item id).
      //   We verify by checking the selector options via aria or data attributes.
      const options = page.locator('[data-testid="bait-selector"] [data-recruit-bonus]');
      const count = await options.count();
      expect(count).toBeGreaterThanOrEqual(1);

      for (let i = 0; i < count; i++) {
        const bonus = await options.nth(i).getAttribute('data-recruit-bonus');
        expect(Number(bonus)).toBeGreaterThan(0);
      }

      // Clean up.
      await page.evaluate(() => {
        const g = (window as unknown as { __game: () => { flee: () => void } }).__game();
        g.flee();
      });
    });
  });
