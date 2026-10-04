import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { closeAll, openFaceToFace, pressButton } from './controls';

// trade-PROPOSE overlay e2e (EARS criterion PTC2-16; ctl-8e CTL8E.1, defect B5)
//
// TWO-CONTEXT DESIGN
// ==================
// Mirrors trade-full.spec.ts: two separate browser instances, each generating a
// distinct SpacetimeDB identity. The initiator (pageA) drives the REAL UI by KEYS (A on the other
// player, A on Trade → the wizard on Offer with the target pre-selected → A toggles the cursor
// monster → RB → A → A → A on Yes). The counterparty (pageB) responds+confirms via __mrTrade.
// This is the one test that proves the face-to-face overlay (not the hook) initiates a trade —
// trade-full.spec.ts cannot.
//
// INTENTIONAL CHANGE (ctl-10b, CTL10B.1): O is retired. The wizard opens FACE TO FACE
// (`openFaceToFace(pageA, 'Trade', undefined, pageB)`: both players join at the zone spawn, so
// A stands on B's tile and B is an own-tile candidate; A then chooses `Trade — <name>`). It lands
// on Offer with B pre-selected and the select DISABLED, so the Target-pick steps are gone and the
// "Escape on the focused select" case is now "Escape on the Offer list".
//
// INTENTIONAL CHANGE (ctl-8e): the propose leg was "set the checkbox in page.evaluate and click
// #tradepropose-submit". It is now the wizard by keys: the converted overlay's step header is the
// observable state (`[data-testid="tradepropose-steps"] li[aria-current="step"]`), DOM focus
// follows the step (Offer = #tradepropose-monsters, Coins = the offer field, Review = the review
// row), and the cursor monster's label carries aria-current="true". The submit button is left
// alone: the legacy click path is still pinned by the unit suites.
//
// KEY NOTE: RB is PageDown here, not KeyE: until ctl-11a the legacy ladder owns Q and E and the
// router resolves LB / RB only from PageUp / PageDown (CTL6B.6).
//
// WHY NOT __mrTrade FOR THE PROPOSE LEG (D8 / red-team L-3)
// =========================================================
// "the INITIATOR opens KeyO, selects the counterparty in the <select>,
// checks its starter monster, and CLICKS submit — pure DOM, NOT __mrTrade (red-team L-3)."
// Using __mrTrade.proposeTrade() for the initiator would leave the overlay untested —
// the e2e would pass even if KeyO / tradeProposeView were never implemented.
//
// IDENTITY ASSERTION (red-team H-5)
// ==================================
// We assert the SPECIFIC checked monsterId leaves the initiator and arrives at the
// counterparty. Conservation counts alone are not enough: A could lose a different
// monster and B could gain a different one, both conserving counts.
//
// BIGINT BOUNDARY RULE (trade-full.spec.ts precedent)
// ====================================================
// BigInt cannot cross page.evaluate() in Playwright (serialization strips it).
// monsterIds are carried as string ('42') inside the page and compared as strings.
// The data-monster-id attribute on the checkbox is the source of truth for which
// specific monster was offered.
//
// EARS CRITERIA COVERED
// =====================
//   PTC2-16  UI-driven propose: KeyO→select→check monster→submit → __mrTrade respond+confirm
//            → specific monsterId leaves initiator + arrives at counterparty (identity, not
//            just conservation) + allTradeOffers().length===0.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{
    monsterId: string; // bigint serialized as string via window.__game()
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

// ---------------------------------------------------------------------------
// gameReady: wait until __game() is present, identity is set, and the player
// has been placed on the map (ownAuthTile non-null).
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
// getSnap: pull the snapshot needed for trade assertions.
// ---------------------------------------------------------------------------
async function getSnap(p: Page): Promise<{
  identity: string;
  ownMonsters: GameSnap['ownMonsters'];
}> {
  return p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return { identity: g.identity, ownMonsters: g.ownMonsters };
  });
}

// ---------------------------------------------------------------------------
// Wizard locators (ctl-8e). Each is a data-testid / id the converted overlay paints.
// ---------------------------------------------------------------------------
const TARGET = '[data-testid="tradepropose-target"]';
const MONSTERS = '#tradepropose-monsters';
const OFFER_FIELD = '[data-testid="tradepropose-offer-currency"]';
const CURSOR_BOX = '#tradepropose-monsters label[aria-current="true"] input';
const REVIEW_ROW = '[data-testid="tradepropose-review"]';
const ACTIVE_STEP = '[data-testid="tradepropose-steps"] li[aria-current="step"]';

/** The wizard is on `step`: the header's one aria-current="step" item says so. */
async function expectStep(p: Page, step: string): Promise<void> {
  await expect(p.locator(ACTIVE_STEP)).toHaveAttribute('data-step', step);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe
  .serial('pt-c2 — trade-PROPOSE overlay e2e (PTC2-16)', () => {
    let browserA: Browser;
    let ctxA: BrowserContext;
    let pageA: Page; // initiator — drives the REAL KeyO UI

    let browserB: Browser;
    let ctxB: BrowserContext;
    let pageB: Page; // counterparty — responds+confirms via __mrTrade

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
      await browserA.close();
      await browserB.close();
    });

    // -------------------------------------------------------------------------
    // B5: Escape on a freshly opened wizard closes it (it was dead: every control's own
    // stopPropagation swallowed it, and the initial focus is the target select).
    //
    // WHAT THESE TESTS KILL:
    //   - A view whose select / field shield still swallows Escape → the overlay stays open
    //   - An Escape in a field that closes the overlay and drops the text (CTL6B.5 says the first
    //     Escape only stops typing and keeps the text; the next one is Start)
    // -------------------------------------------------------------------------
    test('CTL8E-1-BOOT-ESCAPE: opened face to face, Escape on the Offer list closes the overlay (B5)', async () => {
      test.setTimeout(60_000);
      await closeAll(pageA);
      await openFaceToFace(pageA, 'Trade', undefined, pageB);
      await expect(pageA.locator(TARGET)).toBeVisible({ timeout: 10_000 });
      // INTENTIONAL CHANGE (ctl-10b): was "Escape on the focused select". The wizard opens on Offer
      // with the faced player pre-selected, the select locked, and focus on the Offer list.
      await expectStep(pageA, 'offer');
      await expect(pageA.locator(TARGET)).toBeDisabled();
      await expect(pageA.locator(MONSTERS)).toBeFocused();

      await pressButton(pageA, 'Start');
      await expect(pageA.locator('#tradepropose-overlay')).toBeHidden();
      await closeAll(pageA);
    });

    test('CTL8E-1-BOOT-ESCAPE: Escape in the offer field keeps the typed text and the overlay, the next Escape closes it', async () => {
      test.setTimeout(60_000);
      await closeAll(pageA);
      await openFaceToFace(pageA, 'Trade', undefined, pageB);
      await expectStep(pageA, 'offer');
      await expect(pageA.locator(MONSTERS)).toBeFocused();
      await pageA.keyboard.press('PageDown'); // RB: Offer -> Coins
      await expectStep(pageA, 'coins');
      await expect(pageA.locator(OFFER_FIELD)).toBeFocused();
      await pageA.keyboard.type('25');

      await pressButton(pageA, 'Start'); // stops typing
      await expect(pageA.locator('#tradepropose-overlay')).toBeVisible();
      await expect(pageA.locator(OFFER_FIELD)).toHaveValue('25');
      await expect(pageA.locator(OFFER_FIELD)).not.toBeFocused();
      await expectStep(pageA, 'coins');

      await pressButton(pageA, 'Start'); // Start proper
      await expect(pageA.locator('#tradepropose-overlay')).toBeHidden();
      await closeAll(pageA);
    });

    // -------------------------------------------------------------------------
    // UI-driven propose → respond+confirm → specific monsterId transfers
    //
    // WHAT THIS TEST KILLS:
    //   - A KeyO handler that does nothing → target-select never visible → timeout
    //   - A tradeProposeView.render() that does not paint target options → select is empty
    //   - An onSubmit that uses __mrTrade internally instead of reducers.proposeTrade
    //     → the propose leg passes even without the KeyO UI (ADR-0134 D8 / red-team L-3)
    //   - A confirm_trade impl that transfers the wrong monster → identity assertion fails
    //     even if conservation count holds (red-team H-5)
    //   - A propose UI that sends the wrong counterparty identity → server rejects
    //
    // -------------------------------------------------------------------------
    test('PTC2-16: face to face → Trade → wizard on Offer with the target pre-selected→A toggles the cursor monster→RB→A→A→A on Yes → respond+confirm → specific monsterId transfers (identity) + offer row deleted', async () => {
      test.setTimeout(120_000);

      // Snapshots before trade.
      const snapABefore = await getSnap(pageA);
      const snapBBefore = await getSnap(pageB);

      const identityA = snapABefore.identity;
      const identityB = snapBBefore.identity;

      // Each player gets exactly 1 starter monster from join_game.
      expect(
        snapABefore.ownMonsters.length,
        'initiator (A) must have exactly 1 starter monster',
      ).toBe(1);
      expect(
        snapBBefore.ownMonsters.length,
        'counterparty (B) must have exactly 1 starter monster',
      ).toBe(1);

      const totalMonstersBefore = snapABefore.ownMonsters.length + snapBBefore.ownMonsters.length;

      // -----------------------------------------------------------------------
      // Step 1: Initiator (A) waits until B appears in __mrTrade.allPlayers()
      //   so the target <select> will have B as an option after render().
      // -----------------------------------------------------------------------
      await pageA.waitForFunction(
        (myIdentity: string) => {
          const w = window as unknown as { __mrTrade?: MrTrade };
          if (!w.__mrTrade) return false;
          return w.__mrTrade.allPlayers().some((pl) => pl.identity !== myIdentity);
        },
        identityA,
        { timeout: 15_000 },
      );

      // Resolve B's identity as seen from A's allPlayers().
      const counterpartyId = await pageA.evaluate((myIdentity: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const others = w.__mrTrade.allPlayers().filter((pl) => pl.identity !== myIdentity);
        if (others.length !== 1) throw new Error(`Expected 1 other player, found ${others.length}`);
        return others[0]?.identity;
      }, identityA);

      expect(counterpartyId, 'counterpartyId must resolve to a non-empty identity').not.toBe('');
      expect(counterpartyId).toBe(identityB);

      // -----------------------------------------------------------------------
      // Step 2 (INTENTIONAL CHANGE, ctl-10b): O is retired. The initiator closes every stale
      //   frame, stands on B's tile (the helper walks there when the two stand apart; both join at
      //   the spawn), waits for the chip, presses A, chooses `Trade — <B's name>` and presses A.
      // -----------------------------------------------------------------------
      await openFaceToFace(pageA, 'Trade', undefined, pageB);

      // The wizard is open (first structural gate) on Offer, with the FACED player pre-selected
      // and the select locked: there is no Target step and no way to retarget.
      await pageA.waitForSelector(TARGET, { state: 'visible', timeout: 10_000 });
      await expectStep(pageA, 'offer');
      await expect(pageA.locator(TARGET), 'the counterparty is pre-selected').toHaveValue(
        counterpartyId as string,
      );
      await expect(pageA.locator(TARGET), 'and the select is locked').toBeDisabled();

      // -----------------------------------------------------------------------
      // Step 3: DOM focus is on the monsters container, a non-form element, so the D-pad and A
      //   reach the router from here on.
      // -----------------------------------------------------------------------
      await expect(pageA.locator(MONSTERS)).toBeFocused();

      // -----------------------------------------------------------------------
      // Step 4: Check the first monster checkbox in #tradepropose-monsters.
      //   Capture the data-monster-id attribute — this is the SPECIFIC monsterId
      //   we will assert on after the trade completes (identity assertion, not
      //   just conservation counts — red-team H-5).
      //
      //   The checkbox must carry its monsterId in data-monster-id.
      //   BigInt does NOT cross page.evaluate() — carry as string.
      // -----------------------------------------------------------------------
      //
      //   ctl-8e: the cursor's checkbox label carries aria-current="true" (the cursor opens on
      //   the first monster); A (Enter) ticks THAT monster. Read its id BEFORE the press, so the
      //   identity assertion names the monster the wizard marked, not whichever box is first.
      // -----------------------------------------------------------------------
      await expect(pageA.locator(CURSOR_BOX)).toHaveCount(1);
      const offeredMonsterIdStr = await pageA.locator(CURSOR_BOX).getAttribute('data-monster-id');
      expect(offeredMonsterIdStr, 'offered monsterId string must be non-empty').toBeTruthy();
      await expect(pageA.locator(CURSOR_BOX)).not.toBeChecked();

      await pressButton(pageA, 'A'); // toggles the cursor monster in place
      await expect(pageA.locator(CURSOR_BOX)).toBeChecked();
      await expectStep(pageA, 'offer');

      // -----------------------------------------------------------------------
      // Step 4b: RB (PageDown) to Coins, A to Ask, A to Review: the coin fields stay empty (the
      //   monster is the whole offer). Focus follows: the offer field, then the request field,
      //   then the review row.
      // -----------------------------------------------------------------------
      await pageA.keyboard.press('PageDown');
      await expectStep(pageA, 'coins');
      await expect(pageA.locator(OFFER_FIELD)).toBeFocused();
      await pressButton(pageA, 'A');
      await expectStep(pageA, 'ask');
      await expect(pageA.locator('[data-testid="tradepropose-request-currency"]')).toBeFocused();
      await pressButton(pageA, 'A');
      await expectStep(pageA, 'review');
      await expect(pageA.locator(REVIEW_ROW)).toBeVisible();
      await expect(pageA.locator(REVIEW_ROW)).toBeFocused();
      await expect(
        pageA.locator('[data-testid="tradepropose-review-yes"]'),
        'Review confirms with Yes as the default',
      ).toHaveAttribute('aria-current', 'true');

      // -----------------------------------------------------------------------
      // Step 5: A on Yes (the Review default) confirms.
      //   The commit sends the ON-SCREEN draft through the REAL onSubmit →
      //   reducers.proposeTrade() path. NOT __mrTrade — this is the D8 / red-team L-3 gate.
      //   The cursor then moves to No, so a second A cannot send twice.
      // -----------------------------------------------------------------------
      await pressButton(pageA, 'A');
      await expect(
        pageA.locator('[data-testid="tradepropose-review-no"]'),
        'after Yes the cursor is on No',
      ).toHaveAttribute('aria-current', 'true');

      // -----------------------------------------------------------------------
      // Step 6: Both players wait for the offer row to appear (Pending).
      // -----------------------------------------------------------------------
      await Promise.all([
        pageA.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length > 0;
          },
          null,
          { timeout: 20_000 },
        ),
        pageB.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length > 0;
          },
          null,
          { timeout: 20_000 },
        ),
      ]);

      // Verify the offer is Pending after the UI-driven propose.
      const offerStatusAfterPropose = await pageA.evaluate(() => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allTradeOffers()[0]?.status ?? '';
      });
      expect(
        offerStatusAfterPropose,
        'offer must be Pending immediately after UI-driven propose',
      ).toBe('Pending');

      // Exactly ONE offer row: the commit sent once (a double-tap of A, or a send per paint,
      // would have tried a second proposal for the same monster).
      const offerCountAfterPropose = await pageA.evaluate(() => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allTradeOffers().length;
      });
      expect(offerCountAfterPropose, 'one UI-driven propose makes exactly one offer').toBe(1);

      // -----------------------------------------------------------------------
      // Step 7: Counterparty (B) responds and initiator (A) confirms via __mrTrade.
      //   The counterparty side is driven by __mrTrade (not UI — B's UI is KeyU,
      //   not the propose overlay, and the respond UI is separate from pt-c2 scope).
      // -----------------------------------------------------------------------
      const tradeId = await pageB.evaluate(() => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allTradeOffers()[0]?.tradeId ?? '';
      });
      expect(tradeId, 'tradeId must be a non-empty string').not.toBe('');

      await pageB.evaluate((tid: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const p = w.__mrTrade.respondTrade(tid, true);
        if (!p) throw new Error('respondTrade: conn not ready or __mrTrade hook missing');
        return p;
      }, tradeId);

      // A waits for status to become ConfirmedByCounterparty.
      await pageA.waitForFunction(
        (tid: string) => {
          const w = window as unknown as { __mrTrade?: MrTrade };
          if (!w.__mrTrade) return false;
          const offer = w.__mrTrade.allTradeOffers().find((o) => o.tradeId === tid);
          return offer?.status === 'ConfirmedByCounterparty';
        },
        tradeId,
        { timeout: 15_000 },
      );

      // A confirms.
      await pageA.evaluate((tid: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const p = w.__mrTrade.confirmTrade(tid);
        if (!p) throw new Error('confirmTrade: conn not ready or __mrTrade hook missing');
        return p;
      }, tradeId);

      // -----------------------------------------------------------------------
      // Step 8: Both players wait for the offer row to disappear.
      // -----------------------------------------------------------------------
      await Promise.all([
        pageA.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length === 0;
          },
          null,
          { timeout: 20_000 },
        ),
        pageB.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length === 0;
          },
          null,
          { timeout: 20_000 },
        ),
      ]);

      // -----------------------------------------------------------------------
      // Step 9: Wait for monster counts to settle (ownership transfer takes a
      //   round-trip; poll both snapshots together to avoid a race).
      // -----------------------------------------------------------------------
      await Promise.all([
        pageA.waitForFunction(
          (args: { totalBefore: number }) => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            // A offered their starter monster → A should end with 0 monsters.
            return g.ownMonsters.length === args.totalBefore - 1;
          },
          { totalBefore: snapABefore.ownMonsters.length },
          { timeout: 20_000 },
        ),
        pageB.waitForFunction(
          (args: { totalBefore: number }) => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            // B received A's monster → B should end with 2 monsters.
            return g.ownMonsters.length === args.totalBefore + 1;
          },
          { totalBefore: snapBBefore.ownMonsters.length },
          { timeout: 20_000 },
        ),
      ]);

      // -----------------------------------------------------------------------
      // Step 10: Identity assertion (red-team H-5) — the SPECIFIC offered
      //   monsterId must be absent from A's roster and present in B's roster.
      //   Conservation count is a secondary check.
      // -----------------------------------------------------------------------
      const snapAAfter = await getSnap(pageA);
      const snapBAfter = await getSnap(pageB);

      // ★ Identity: offered monster must NOT be in A's ownMonsters after trade.
      const aStillHasMonster = snapAAfter.ownMonsters.some(
        (m) => m.monsterId === offeredMonsterIdStr,
      );
      expect(
        aStillHasMonster,
        `Initiator (A) must NOT have monsterId=${offeredMonsterIdStr} after trade — ` +
          'it was offered and should have transferred to the counterparty',
      ).toBe(false);

      // ★ Identity: offered monster MUST be in B's ownMonsters after trade.
      const bHasMonster = snapBAfter.ownMonsters.some((m) => m.monsterId === offeredMonsterIdStr);
      expect(
        bHasMonster,
        `Counterparty (B) MUST have monsterId=${offeredMonsterIdStr} after trade — ` +
          'the specific offered monster must arrive at B, not just any monster',
      ).toBe(true);

      // Secondary: monster conservation (total unchanged).
      const totalMonstersAfter = snapAAfter.ownMonsters.length + snapBAfter.ownMonsters.length;
      expect(
        totalMonstersAfter,
        `Monster conservation violated: before=${totalMonstersBefore} after=${totalMonstersAfter}`,
      ).toBe(totalMonstersBefore);

      // Secondary: offer row deleted.
      const tradeOffersAfter = await pageA.evaluate(() => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allTradeOffers().length;
      });
      expect(
        tradeOffersAfter,
        'allTradeOffers() must be empty after confirm — offer row must be deleted',
      ).toBe(0);
    });
  });
