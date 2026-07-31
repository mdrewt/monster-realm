import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// uxd2 — shop-via-NPC context-sensitive interact e2e (plan I8; ADR-0161).
//
// WHAT THIS PROVES (AC-12, the end-to-end half of AC-1/2/5/6):
//   1. dist 3 from the shopkeeper: #interact-prompt is HIDDEN and KeyT opens NOTHING.
//   2. dist 2: #interact-prompt is VISIBLE and names the destination ("Shop") + the key (T).
//   3. KeyT -> #dialogue-overlay with the greeting "Hello, customer!" (GREET-THEN-SHOP:
//      the shop arm sends the existing `talk` reducer, it does not open the shop directly).
//   4. While the dialogue overlay is open the prompt is HIDDEN (AC-6 overlay suppression).
//   5. Clicking the [data-shop-id] Shop action -> #shop-overlay VISIBLE and
//      #dialogue-overlay HIDDEN — the DEFERRED open (dismissDialogue round-trip, consumed
//      in the dialogue batch listener's !conv arm), never two overlays at once.
//
// RED UNTIL uxd2 SHIPS. On master: there is no shopkeeper NPC in zone 1 at all (content
// I3), no #interact-prompt element, and no [data-shop-id] button. The first failure is the
// zone-1 walk finishing with a hidden prompt where the test demands a visible one; the
// negative-case test at dist 3 is the one case that would pass vacuously today, which is
// exactly why it asserts a POSITIVE control first (the prompt must become visible one tile
// later, in the sibling test) rather than standing alone.
//
// DESIGN NOTES
// ============
// SINGLE CONTEXT: nothing here needs a second player. One browser / one context / one page
// (rename.spec.ts precedent). Under `workers: 1` (playwright.config.ts:30) this suite owns
// the whole world, so presenceCount converges to exactly 1 (golden.spec exact-presence
// discipline). A foreign player could not corrupt the assertions anyway — the resolver only
// ranks npc rows and heal_location rows — but the convergence wait keeps a leaked session
// from turning into a mysterious timeout later.
//
// NO RETRY LOOPS: the shopkeeper is seeded with wander_radius 0, and `npc_decide` treats
// radius 0 as a pinned stationary special case (ADR-0161 D7). Unlike dialogue.spec.ts —
// whose elder_oak wanders and therefore needs bounded talk/advance retry loops — every step
// and every press here is deterministic. If this spec ever needs a retry loop, the
// shopkeeper's wander_radius has regressed; fix the content, not the spec.
//
// dialogue.spec.ts IS NOT IMPORTED FROM and IS NOT MODIFIED (AC-13 regression guard). Its
// stepOne/ready/snap helpers are re-implemented here verbatim-in-spirit so this file can
// evolve without touching the frozen regression net.
//
// PHYSICAL KEY CODES: `page.keyboard.press('KeyT')` (the physical-code form the main.ts
// handler switches on — recruit.spec reviewer L3).
//
// ---------------------------------------------------------------------------------------
// WORLD FACTS (derived this session from game-core/content/*, not from memory)
// ---------------------------------------------------------------------------------------
// zone_maps/000-core.ron — zone 0 and zone 1 ship the IDENTICAL 10x7 layout:
//     y=0  "##########"
//     y=1  "#........#"      <- x=1..8 all floor
//     y=2  "#.~~....~#"      <- grass at x=2,3,8
//     y=3  "#...##..~#"      <- WALLS at x=4,5 ; grass at x=8
//     y=4  "#..~~...~#"      <- grass at x=3,4,8
//     y=5  "#......~~#"      <- grass at x=7,8
//     y=6  "##########"
//   warps: zone0 (5,5) -> zone1 (5,5)   and   zone1 (5,5) -> zone0 (5,5)
//
// npcs/000-core.ron:
//   - elder_oak       : zone 0, home (5,5), wander_radius 2, interaction Dialogue.
//                       IT NEVER ENTERS ZONE 1, so it cannot interfere with any assertion
//                       made after the warp. (It is also why the zone-0 leg presses no key.)
//   - tideglass_shopkeeper (uxd2 I3): zone 1, spawn/home (8,1), wander_radius 0 (STATIONARY),
//                       dialogue_tree_id "shopkeeper_greeting", interaction Shop(1).
// dialogue_trees/000-core.ron (uxd2 I3): shopkeeper_greeting = ONE node, text
//   "Hello, customer!", single choice ("Leave", next_node: None) — genuinely inert, so the
//   Shop action can only come from the NpcInteraction enum, never from choice text.
// heal_locations/000-core.ron: exactly ONE row — location 1, ZONE 0, (8,3). Zone 1 has NO
//   heal tile, so nothing can out-rank the shopkeeper on the zone-1 leg and the prompt in
//   zone 1 can only ever read "Shop".
// shops/000-core.ron: shop id 1 = "Pebble Town Shop" (the shopkeeper's Shop(1) target).
//
// ---------------------------------------------------------------------------------------
// THE ROUTE — and why every step is grass-free (an encounter roll happens only when the
// player STEPS ONTO a '~' tile, so a grass-free path cannot start a wild battle and this
// spec needs no battle-dismiss latch).
// ---------------------------------------------------------------------------------------
//   ZONE 0, from spawn (1,1):
//     E,E,E,E,E -> (2,1)(3,1)(4,1)(5,1)(6,1)   row y=1 is floor for x=1..8   [grass-free]
//     S,S,S     -> (6,2)(6,3)(6,4)             column x=6 is floor for y=1..5 [grass-free]
//     S         -> (6,5)                       floor                          [grass-free]
//     W         -> (5,5) = THE WARP TILE       floor; warps to zone 1 (5,5)
//   ZONE 1, from the warp landing (5,5):
//     N -> (5,4)  floor                        (steps OFF the return-warp tile immediately)
//     E -> (6,4)  floor
//     N -> (6,3)  floor   <- NOTE (4,3)/(5,3) are WALLS; the x=6 column is the only clean
//                            northward lane. The naive N,N,N,N from (5,5) bumps the (5,3)
//                            wall — do not "simplify" this route.
//     N -> (6,2)  floor   <- NEGATIVE CHECKPOINT: Manhattan to (8,1) = |8-6|+|1-2| = 3
//     N -> (6,1)  floor   <- POSITIVE CHECKPOINT: Manhattan to (8,1) = |8-6|+|1-1| = 2
//   The two checkpoints are ADJACENT tiles straddling CLIENT_INTERACT_RANGE = 2, which is
//   what makes the pair a real boundary test rather than two unrelated observations.

interface Tile {
  x: number;
  y: number;
}

interface ShopNpcSnap {
  identity: string;
  ownEntityId: string | null;
  ownAuthTile: Tile | null;
  presenceCount: number;
  map: { zone_id: number };
  ongoingBattle: { battleId: string; outcome: string } | null;
}

type GameWindow = { __game: () => ShopNpcSnap };

const snap = (p: Page): Promise<ShopNpcSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as GameWindow).__game();
    return {
      identity: g.identity,
      ownEntityId: g.ownEntityId,
      ownAuthTile: g.ownAuthTile,
      presenceCount: g.presenceCount,
      map: { zone_id: g.map.zone_id },
      ongoingBattle: g.ongoingBattle,
    };
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => ShopNpcSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

/** One step + a bounded wait for the authoritative tile to change. The route is grass-free
 *  by construction (see WORLD FACTS), so a battle here means the map or the route changed —
 *  fail loud with a pointer at the derivation instead of a mysterious timeout. */
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
      `shop-npc.spec walk: unexpected wild battle stepping ${dir} from (${from.x},${from.y}) — ` +
        'the route is grass-free by construction; re-derive it from the WORLD FACTS header ' +
        'against game-core/content/zone_maps/000-core.ron',
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

/** Zone-0 leg: spawn (1,1) -> the warp tile (5,5). The final W step IS the warp. */
const ZONE0_PATH: readonly string[] = [
  'East',
  'East',
  'East',
  'East',
  'East', // (6,1)
  'South',
  'South',
  'South', // (6,4)
  'South', // (6,5)
  'West', // (5,5) — WARP -> zone 1 (5,5)
];

/** Zone-1 leg: warp landing (5,5) -> the dist-3 checkpoint (6,2). */
const ZONE1_TO_FAR: readonly string[] = [
  'North', // (5,4) — off the return-warp tile
  'East', // (6,4)
  'North', // (6,3)
  'North', // (6,2) — Manhattan 3 from the shopkeeper at (8,1)
];

const FAR_TILE: Tile = { x: 6, y: 2 }; // dist 3 — OUT of CLIENT_INTERACT_RANGE
const NEAR_TILE: Tile = { x: 6, y: 1 }; // dist 2 — the inclusive boundary, IN range

/** The seeded greeting text (dialogue_trees/000-core.ron, uxd2 I3). */
const GREETING = 'Hello, customer!';
/** The seeded npc_id, which dialogueModel renders as the display name. */
const SHOPKEEPER_NPC_ID = 'tideglass_shopkeeper';

test.describe
  .serial('uxd2 — shop via NPC: context-sensitive interact (AC-12)', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
      // Exact-presence discipline (workers: 1 — this suite owns the whole world).
      await page.waitForFunction(
        () => (window as unknown as GameWindow).__game().presenceCount === 1,
        null,
        { timeout: 30_000 },
      );
    });

    test.afterAll(async () => {
      // Clean disconnect so the next spec file's exact-presence wait converges.
      await browser.close();
    });

    // ---------------------------------------------------------------------------
    // Setup: walk zone 0 to the warp, cross into zone 1, and approach along the
    // x=6 column to the dist-3 checkpoint.
    // ---------------------------------------------------------------------------
    test('setup: walk (1,1) -> warp -> zone 1 -> (6,2), grass-free and battle-free', async () => {
      test.setTimeout(180_000);
      const start = await snap(page);
      expect(start.ownAuthTile, 'the player spawns with an authoritative tile').not.toBeNull();
      expect(start.ownAuthTile).toEqual({ x: 1, y: 1 });
      expect(start.map.zone_id, 'the player spawns in zone 0').toBe(0);

      await walk(page, ZONE0_PATH);

      // The warp is server-authoritative and asynchronous with respect to the step ack:
      // poll the client's active zone map rather than assuming it flipped by the time the
      // tile changed (zoneSync.spec idiom — rawMap.zone_id is the client's active zone).
      await page.waitForFunction(
        () => (window as unknown as GameWindow).__game().map.zone_id === 1,
        null,
        { timeout: 20_000 },
      );
      const warped = await snap(page);
      expect(warped.map.zone_id, 'stepping onto (5,5) must warp to zone 1').toBe(1);
      expect(warped.ownAuthTile, 'the warp lands on zone 1 (5,5)').toEqual({ x: 5, y: 5 });
      expect(warped.ongoingBattle, 'the zone-0 leg is grass-free').toBeNull();

      await walk(page, ZONE1_TO_FAR);

      const done = await snap(page);
      expect(done.ownAuthTile).toEqual(FAR_TILE);
      expect(done.map.zone_id, 'the return warp at zone 1 (5,5) must not have re-fired').toBe(1);
      expect(done.ongoingBattle, 'the zone-1 leg is grass-free').toBeNull();
    });

    // ---------------------------------------------------------------------------
    // AC-5 / AC-12 negative half: 3 tiles away, nothing is offered and nothing happens.
    //
    // KILLS: a resolver with an off-by-one range (`<= 3`, or a Chebyshev metric under
    // which (8,1) is distance 2 from (6,2)); a prompt that renders whenever ANY NPC row
    // exists rather than one in range; a KeyT that dispatches without a range check and
    // leans on the server's rejection (silent Err, no user feedback, and the overlay
    // would open on any latency-favourable ordering).
    // ---------------------------------------------------------------------------
    test('AC-12 negative: at Manhattan 3 the prompt is hidden and KeyT opens nothing', async () => {
      test.setTimeout(120_000);
      const g = await snap(page);
      expect(g.ownAuthTile, 'precondition: standing on the dist-3 checkpoint').toEqual(FAR_TILE);

      const prompt = page.locator('#interact-prompt');
      const dialogue = page.locator('#dialogue-overlay');
      const shop = page.locator('#shop-overlay');

      // The prompt is recomputed every frame, so a single settled observation is enough —
      // but give the loop a couple of frames after the walk before observing.
      await expect(prompt, 'no interactable in range ⇒ no prompt (AC-5)').toBeHidden({
        timeout: 5_000,
      });

      await page.keyboard.press('KeyT');

      // Bounded wait for the WRONG outcome: if either overlay opens within this window the
      // range gate failed. `.catch(() => false)` turns the expected timeout into a pass.
      const dialogueOpened = await dialogue
        .waitFor({ state: 'visible', timeout: 4_000 })
        .then(() => true)
        .catch(() => false);
      expect(
        dialogueOpened,
        'KeyT at Manhattan 3 must NOT open the dialogue overlay — CLIENT_INTERACT_RANGE is 2 ' +
          'and the server re-validates at TALK_RANGE 2 (npc.rs:20)',
      ).toBe(false);

      const shopOpened = await shop
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      expect(
        shopOpened,
        'KeyT at Manhattan 3 must NOT open the shop overlay (and nothing but the greeting ' +
          'Shop action may open it at all — there is no global shop hotkey after uxd2)',
      ).toBe(false);

      await expect(prompt, 'the prompt stays hidden after a no-op KeyT').toBeHidden();
    });

    // ---------------------------------------------------------------------------
    // AC-7 / AC-12 positive half: one tile closer (Manhattan 2, the inclusive
    // boundary) the prompt appears and NAMES THE DESTINATION.
    //
    // KILLS: a strict `<` range comparison (the boundary tile would stay silent — and
    // this is the tile the player naturally stops on); a prompt whose actionWord is
    // hard-coded to "Talk" (the shopkeeper would be indistinguishable from a villager);
    // a prompt that omits the key glyph (the affordance would be undiscoverable).
    // ---------------------------------------------------------------------------
    test('AC-12 positive: at Manhattan 2 the prompt reads "Shop" and names the T key', async () => {
      test.setTimeout(120_000);
      await walk(page, ['North']); // (6,2) -> (6,1)
      const g = await snap(page);
      expect(g.ownAuthTile, 'moved to the dist-2 boundary tile').toEqual(NEAR_TILE);

      const prompt = page.locator('#interact-prompt');
      await expect(
        prompt,
        'an interactable at exactly CLIENT_INTERACT_RANGE must produce a prompt (inclusive <=)',
      ).toBeVisible({ timeout: 10_000 });

      // The exact copy is the implementer's choice; the CONTRACT is that the label names the
      // destination ("Shop", not "Talk") and the key that triggers it.
      await expect(
        prompt,
        'the prompt must name the DESTINATION — a shopkeeper reads "Shop" (AC-12), which is ' +
          'what makes greet-then-shop legible even though the dispatch sends `talk`',
      ).toContainText('Shop');
      const text = (await prompt.textContent()) ?? '';
      expect(
        text.includes('T'),
        `the prompt must name the interact key glyph "T" — got ${JSON.stringify(text)}`,
      ).toBe(true);
    });

    // ---------------------------------------------------------------------------
    // AC-1 / AC-2 / AC-6: KeyT greets (it does NOT open the shop directly), the
    // greeting is the seeded inert tree, and the prompt is suppressed while the
    // overlay is up.
    //
    // KILLS: a KeyT that opens the shop overlay directly for a Shop NPC (the spec's
    // pre-adjudication default — Drew's answer is GREET-THEN-SHOP); a dispatch that
    // targets the wrong NPC; a prompt with no overlay-visible suppression (AC-6),
    // which would float "Shop / T" on top of the open dialogue.
    // ---------------------------------------------------------------------------
    test('AC-1/2: KeyT opens the greeting "Hello, customer!" and suppresses the prompt (AC-6)', async () => {
      test.setTimeout(120_000);
      const dialogue = page.locator('#dialogue-overlay');
      const shop = page.locator('#shop-overlay');
      const prompt = page.locator('#interact-prompt');

      await page.keyboard.press('KeyT');
      await expect(dialogue, 'KeyT on a Shop NPC sends `talk` — the GREETING opens').toBeVisible({
        timeout: 15_000,
      });

      // Exact seeded content: proves we greeted the SHOPKEEPER (not elder_oak, who is in
      // zone 0 and whose greeting text is different) and that dialogueContent.ts mirrors
      // the RON tree rather than falling back to the '...' arm.
      await expect(page.locator('#dialogue-node-text')).toHaveText(GREETING);
      await expect(page.locator('#dialogue-npc-name')).toHaveText(SHOPKEEPER_NPC_ID);

      // AC-2 / adjudication 1: greet-then-shop, NOT direct-open. The shop must still be
      // closed at this point — a direct-open impl would already have two overlays stacked.
      await expect(
        shop,
        'the shop must NOT be open yet — KeyT greets; the Shop ACTION opens the shop (AC-2)',
      ).toBeHidden();

      // AC-6: overlay suppression of the on-world prompt.
      await expect(
        prompt,
        'the interact prompt must be hidden while an overlay is visible (AC-6) — otherwise the ' +
          '"Shop / T" label floats over the open dialogue',
      ).toBeHidden({ timeout: 5_000 });
    });

    // ---------------------------------------------------------------------------
    // AC-2 completion: the Shop action ends the conversation and opens the BOUND shop.
    //
    // KILLS: a Shop button wired onto data-choice-idx (advance_dialogue with a bogus
    // index — the overlay would close with no shop); an IMMEDIATE open (both overlays
    // visible at once for the round-trip, puncturing the one-overlay invariant); a
    // deferred open that never fires because the pending id was cleared/ungated wrongly.
    //
    // 20 s: the open is deferred behind a server-side row DELETE (dismissDialogue) whose
    // subscription propagation has a long tail under CI load — the same mechanism
    // dialogue.spec.ts already budgets 20 s for.
    // ---------------------------------------------------------------------------
    test('AC-2: the Shop action closes the dialogue and opens the shop overlay (deferred, never stacked)', async () => {
      test.setTimeout(180_000);
      const dialogue = page.locator('#dialogue-overlay');
      const shop = page.locator('#shop-overlay');
      const shopButton = page.locator('[data-shop-id]');

      await expect(dialogue, 'precondition: the greeting is open').toBeVisible();
      await expect(
        shopButton,
        'the greeting must render a [data-shop-id] Shop action, derived from the ' +
          'NpcInteraction enum (never from choice text) — ADR-0161 D4',
      ).toBeVisible({ timeout: 10_000 });

      await shopButton.click();

      await expect(shop, 'the Shop action must open the shop overlay').toBeVisible({
        timeout: 20_000,
      });
      await expect(
        dialogue,
        'the conversation must be ENDED (dismissDialogue) before the shop opens — the two ' +
          'overlays must never be visible simultaneously (adjudication 1: deferred open)',
      ).toBeHidden({ timeout: 20_000 });
    });
  });
