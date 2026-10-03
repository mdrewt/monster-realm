import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { expectPosted, interactChip, interactWithNpc, pressButton, readWorld } from './controls';

// shop-via-NPC context-sensitive interact e2e.
//
// WHAT THIS PROVES (AC-12, the end-to-end half of AC-1/2/5/6; ctl-10a CTL10A.1/.3):
//   ctl-10a: T retired. A acts on what the character FACES — the entities on the tile in
//   front, else on its own tile (game-core interact_candidates) — never on range.
//   1. Manhattan 2, facing away ((6,1) facing North — in the OLD TALK_RANGE, so the old
//      range rule offered the shop here): #interact-prompt is HIDDEN and A opens NOTHING.
//   2. Manhattan 1, the shopkeeper directly BEHIND ((7,1) facing West): the prompt is HIDDEN
//      and A opens NOTHING (r2-024: the old range rule talked to an NPC behind you).
//   3. Facing the shopkeeper from (7,1): #interact-prompt reads EXACTLY
//      `[Enter] Shop — tideglass_shopkeeper` — the A keycap, the destination verb and the
//      name (CTL10A.3).
//   4. A -> #dialogue-overlay with the greeting "Hello, customer!" (GREET-THEN-SHOP:
//      the shop arm sends the existing `talk` reducer, it does not open the shop directly).
//   5. While the dialogue overlay is open the prompt is HIDDEN (AC-6 overlay suppression).
//   6. Clicking the [data-shop-id] Shop action -> #shop-overlay VISIBLE and
//      #dialogue-overlay HIDDEN — the DEFERRED open (dismissDialogue round-trip, consumed
//      in the dialogue batch listener's !conv arm), never two overlays at once.
//
// The two negatives would pass vacuously on a dead A, which is exactly why the same file
// asserts the POSITIVE control on the same tile (7,1) one re-facing later (tests 3 and 4)
// rather than letting them stand alone.
//
// DESIGN NOTES
// ============
// SINGLE CONTEXT: nothing here needs a second player. One browser / one context / one page
// (rename.spec.ts precedent). Under `workers: 1` this suite owns
// the whole world, so presenceCount converges to exactly 1 (golden.spec exact-presence
// discipline). A foreign player could still stand on a faced tile (ctl-10a: players are
// interact candidates, with no action until ctl-10b), so the convergence wait also keeps the
// negatives honest, and keeps a leaked session from turning into a mysterious timeout later.
//
// NO RETRY LOOPS: the shopkeeper is seeded with wander_radius 0, and `npc_decide` treats
// radius 0 as a pinned stationary special case. Unlike dialogue.spec.ts —
// whose elder_oak wanders and therefore needs bounded talk/advance retry loops — every step
// and every press here is deterministic. If this spec ever needs a retry loop, the
// shopkeeper's wander_radius has regressed; fix the content, not the spec.
//
// dialogue.spec.ts IS NOT IMPORTED FROM (AC-13 regression guard). Its stepOne/ready/snap
// helpers are re-implemented here verbatim-in-spirit so this file can evolve without touching
// the frozen regression net. The A press goes through the shared controls.ts helpers
// (pressButton / interactWithNpc), so a binding change lands in one place (ctl-6a, ctl-10a).
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
//   - tideglass_shopkeeper: zone 1, spawn/home (8,1), wander_radius 0 (STATIONARY),
//                       dialogue_tree_id "shopkeeper_greeting", interaction Shop(1).
// dialogue_trees/000-core.ron: shopkeeper_greeting = ONE node, text
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
//     N -> (6,2)  floor
//     N -> (6,1)  floor   <- NEGATIVE 1: Manhattan 2 from (8,1) (the old TALK_RANGE boundary,
//                            where the old range rule offered the shop), facing North (6,0) —
//                            a wall; nothing on the faced tile or the own tile.
//     E -> (7,1)  floor   (facing East, toward the shopkeeper — passes through; not tested
//                            here, the positive is asserted after the negatives)
//     E -> (8,1)  floor   <- the SHOPKEEPER'S TILE: characters never block movement
//                            (game-core world.rs is_walkable is tile-kind only), so this walks
//                            onto it.
//     W -> (7,1)  floor   <- NEGATIVE 2: Manhattan 1, facing West (6,1), the shopkeeper
//                            directly BEHIND.
//     W -> (6,1), E -> (7,1)  <- POSITIVE: the arriving East step faces (8,1) (a step always
//                            sets the facing — world.rs apply_move). (7,1) is the shopkeeper's
//                            only walkable 4-neighbour ((8,2) is grass, (9,1)/(8,0) walls).

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

/** Zone-1 leg: warp landing (5,5) -> (6,1), arriving facing North.
 *  ctl-10a: T retired — the old dist-3 / dist-2 checkpoints tested a RANGE rule that no
 *  longer exists; (6,1) is now the first negative (Manhattan 2, facing away). */
const ZONE1_TO_RANGE2: readonly string[] = [
  'North', // (5,4) — off the return-warp tile
  'East', // (6,4)
  'North', // (6,3)
  'North', // (6,2)
  'North', // (6,1) — Manhattan 2 from the shopkeeper at (8,1), facing North (a wall)
];

const RANGE2_TILE: Tile = { x: 6, y: 1 }; // dist 2 — in the OLD TALK_RANGE; facing North
/** The shopkeeper's pinned tile (npcs/000-core.ron home (8,1), wander_radius 0). */
const SHOPKEEPER_TILE: Tile = { x: 8, y: 1 };
/** Its only walkable 4-neighbour, and so the only tile A can reach it from. */
const SHOP_POST: Tile = { x: 7, y: 1 };

/** The seeded greeting text (dialogue_trees/000-core.ron). */
const GREETING = 'Hello, customer!';
/** The seeded npc_id, which dialogueModel renders as the display name. */
const SHOPKEEPER_NPC_ID = 'tideglass_shopkeeper';
/** ctl-10a (CTL10A.3): the exact chip while the shopkeeper is the one candidate —
 *  `[Enter] Shop — tideglass_shopkeeper` (A keycap, destination verb, the npc_id as name). */
const SHOP_CHIP = interactChip('Shop', SHOPKEEPER_NPC_ID);

/** ctl-10a (CTL10A.1 "with none, A does nothing and shows no toast"): with nothing on the faced
 *  tile or the own tile, the chip is hidden, A opens neither the greeting nor the shop, and no
 *  frame is pushed. The bounded waits are for the WRONG outcome: `.catch(() => false)` turns
 *  the expected timeout into a pass. */
async function expectANoOp(p: Page, where: string): Promise<void> {
  const prompt = p.locator('#interact-prompt');
  const dialogue = p.locator('#dialogue-overlay');
  const shop = p.locator('#shop-overlay');
  // The chip is recomputed per batch/frame, so give the loop a few frames after the walk.
  await expect(prompt, `${where}: nothing faced and nothing underfoot ⇒ no chip`).toBeHidden({
    timeout: 5_000,
  });
  expect((await readWorld(p)).stackLength, `${where}: precondition — a bare world base`).toBe(1);

  await pressButton(p, 'A');

  const dialogueOpened = await dialogue
    .waitFor({ state: 'visible', timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  expect(
    dialogueOpened,
    `${where}: A must NOT open the dialogue overlay — the shopkeeper is not on the faced tile ` +
      'or the own tile (the server would still ACCEPT this talk: it checks TALK_RANGE 2 only, ' +
      'so only the client rule can keep it shut)',
  ).toBe(false);
  const shopOpened = await shop
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  expect(
    shopOpened,
    `${where}: A must NOT open the shop overlay (only the greeting's Shop action may open it)`,
  ).toBe(false);
  expect(
    (await readWorld(p)).stackLength,
    `${where}: A with no candidate pushes no frame at all`,
  ).toBe(1);
  await expect(prompt, `${where}: the chip stays hidden after a no-op A`).toBeHidden();
}

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
    // x=6 column to (6,1) (ctl-10a: T retired — the first negative, Manhattan 2).
    // ---------------------------------------------------------------------------
    test('setup: walk (1,1) -> warp -> zone 1 -> (6,1), grass-free and battle-free', async () => {
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

      await walk(page, ZONE1_TO_RANGE2);

      const done = await snap(page);
      expect(done.ownAuthTile).toEqual(RANGE2_TILE);
      expect(done.map.zone_id, 'the return warp at zone 1 (5,5) must not have re-fired').toBe(1);
      expect(done.ongoingBattle, 'the zone-1 leg is grass-free').toBeNull();
    });

    // ---------------------------------------------------------------------------
    // ctl-10a negative 1 (CTL10A.1; T retired — this replaces the old dist-3 negative and
    // the old dist-2 positive): Manhattan 2 from the shopkeeper, facing North (a wall).
    // Under the OLD range rule this very tile offered "Shop / T"; under the faced-tile rule
    // nothing is in front or underfoot, so nothing is offered and A does nothing.
    //
    // KILLS: a resolver that still ranks by range (nearestInteractable within TALK_RANGE —
    // the chip would show here); an A that dispatches `talk` by range and leans on the
    // server (which ACCEPTS Manhattan 2 — the greeting would open); an A at the world base
    // that falls through to some other frame (the stack must stay a bare world).
    // ---------------------------------------------------------------------------
    test('ctl-10a negative: at Manhattan 2 facing away the chip is hidden and A opens nothing', async () => {
      test.setTimeout(120_000);
      // The post AND the facing, from the authoritative own character row: the last step
      // of the setup walk was North, toward the (6,0) wall.
      await expectPosted(page, RANGE2_TILE, 'North', 'shop-npc negative 1');
      await expectANoOp(page, 'Manhattan 2, facing North');
    });

    // ---------------------------------------------------------------------------
    // ctl-10a negative 2 (CTL10A.1's Red, r2-024): the shopkeeper DIRECTLY BEHIND the
    // character, Manhattan 1. Reaching (7,1) facing West needs a West step FROM (8,1) —
    // the shopkeeper's own tile, which the character can stand on because characters
    // never block movement.
    //
    // On (8,1) the shopkeeper is underfoot and the faced tile (9,1) is a wall, so the OWN
    // tile tier offers it (game-core interact_candidates: the faced tile, else the own
    // tile) — asserted as the in-between positive. Then one step West puts it behind.
    //
    // KILLS: a rule that ignores facing (any adjacent NPC — the old behaviour this
    // criterion's Red names); a rule that looks at the tile BEHIND (step(opposite)); an
    // own-tile tier that is missing (the chip on (8,1) would stay hidden).
    // ---------------------------------------------------------------------------
    test('ctl-10a negative: with the shopkeeper directly behind, the chip is hidden and A opens nothing', async () => {
      test.setTimeout(120_000);
      await walk(page, ['East', 'East']); // (6,1) -> (7,1) -> (8,1), the shopkeeper's tile
      const onKeeper = await snap(page);
      expect(
        onKeeper.ownAuthTile,
        'characters never block movement — the walk stands ON the shopkeeper',
      ).toEqual(SHOPKEEPER_TILE);
      await expect(
        page.locator('#interact-prompt'),
        'standing on the shopkeeper, facing the (9,1) wall: the own-tile tier offers it',
      ).toHaveText(SHOP_CHIP, { timeout: 10_000 });

      await walk(page, ['West']); // (8,1) -> (7,1), facing West: the shopkeeper is behind
      await expectPosted(page, SHOP_POST, 'West', 'shop-npc negative 2');
      await expectANoOp(page, 'Manhattan 1, shopkeeper directly behind');
    });

    // ---------------------------------------------------------------------------
    // ctl-10a positive (CTL10A.3): re-face the shopkeeper from the SAME tile (7,1) — a
    // West step to (6,1), then the arriving East step — and the chip names the A keycap,
    // the destination verb and the shopkeeper, exactly.
    //
    // KILLS: a chip that still prints the retired "T" glyph, or a hard-coded key instead of
    // the A binding's keycap; an actionWord hard-coded to "Talk" (the shopkeeper would be
    // indistinguishable from a villager); a chip that drops the name; and — together with
    // negative 2 on the same tile — a rule that ignores facing.
    // ---------------------------------------------------------------------------
    test('ctl-10a positive: facing the shopkeeper the chip reads exactly "[Enter] Shop — tideglass_shopkeeper"', async () => {
      test.setTimeout(120_000);
      await walk(page, ['West', 'East']); // (7,1) -> (6,1) -> (7,1), arriving facing East
      await expectPosted(page, SHOP_POST, 'East', 'shop-npc positive');

      const prompt = page.locator('#interact-prompt');
      await expect(prompt, 'the faced shopkeeper is the one candidate ⇒ a chip').toBeVisible({
        timeout: 10_000,
      });
      await expect(
        prompt,
        'the chip names the A keycap, the DESTINATION — a shopkeeper reads "Shop" (AC-12), ' +
          'which makes greet-then-shop legible though the dispatch sends `talk` — and the npc_id',
      ).toHaveText(SHOP_CHIP);
    });

    // ---------------------------------------------------------------------------
    // AC-1 / AC-2 / AC-6: A greets (it does NOT open the shop directly), the
    // greeting is the seeded inert tree, and the prompt is suppressed while the
    // overlay is up. (ctl-10a: T retired — the press is A, facing the shopkeeper.)
    //
    // KILLS: an A that opens the shop overlay directly for a Shop NPC;
    // a dispatch that targets the wrong NPC; a prompt with no overlay-visible
    // suppression (AC-6), which would float the chip on top of the open dialogue.
    // ---------------------------------------------------------------------------
    test('AC-1/2: A opens the greeting "Hello, customer!" and suppresses the prompt (AC-6)', async () => {
      test.setTimeout(120_000);
      const dialogue = page.locator('#dialogue-overlay');
      const shop = page.locator('#shop-overlay');
      const prompt = page.locator('#interact-prompt');

      // ONE press (the shopkeeper is pinned — no retry loop, see NO RETRY LOOPS): the
      // helper asserts the post (7,1) and the East facing, sees the shopkeeper on the
      // faced tile and the exact chip, presses A once, and waits up to 15 s for the greeting.
      await interactWithNpc(page, {
        stand: SHOP_POST,
        facing: 'East',
        opened: dialogue,
        chip: SHOP_CHIP,
        maxAttempts: 1,
        npcWaitMs: 10_000,
        openWaitMs: 15_000,
        label: 'shop-npc AC-1/2',
      });
      await expect(dialogue, 'A on a Shop NPC sends `talk` — the GREETING opens').toBeVisible();

      // Exact seeded content: proves we greeted the SHOPKEEPER (not elder_oak, who is in
      // zone 0 and whose greeting text is different) and that dialogueContent.ts mirrors
      // the RON tree rather than falling back to the '...' arm.
      await expect(page.locator('#dialogue-node-text')).toHaveText(GREETING);
      await expect(page.locator('#dialogue-npc-name')).toHaveText(SHOPKEEPER_NPC_ID);

      // AC-2 / adjudication 1: greet-then-shop, NOT direct-open. The shop must still be
      // closed at this point — a direct-open impl would already have two overlays stacked.
      await expect(
        shop,
        'the shop must NOT be open yet — A greets; the Shop ACTION opens the shop (AC-2)',
      ).toBeHidden();

      // AC-6: overlay suppression of the on-world prompt.
      await expect(
        prompt,
        'the interact prompt must be hidden while an overlay is visible (AC-6) — otherwise the ' +
          'Shop chip floats over the open dialogue',
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
