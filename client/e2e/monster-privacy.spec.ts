import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import {
  closeAll,
  openFaceToFace,
  pressAccel,
  pressButton,
  readChip,
  readWorld,
  safeTile,
  startPvpByButtons,
  TACTICS,
  type Tile,
  walkTo,
} from './controls';

/** bt-16: the tactical battle shell (the PvP leg's battle UI since the cutover). */
const TACTICS_SHELL = TACTICS.shell;

/** bt-16: the species name the server's PUBLIC `species_row` gives `speciesId` (owner SQL, a
 *  literal-shaped statement over a checked integer). The oracle for the opponent info box. */
function speciesNameById(speciesId: number, label: string): string {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  if (
    !/^[A-Za-z0-9:/._-]+$/.test(server) ||
    !/^[A-Za-z0-9_-]+$/.test(db) ||
    !Number.isInteger(speciesId) ||
    speciesId < 0
  ) {
    throw new Error(`${label}: refusing non-literal-shaped input ${server} ${db} ${speciesId}`);
  }
  let out = '';
  try {
    out = execSync(
      `spacetime sql -s ${server} ${db} "SELECT id, name FROM species_row WHERE id = ${speciesId}"`,
      { encoding: 'utf8', timeout: 15_000 },
    );
  } catch (err) {
    throw new Error(
      `${label}: spacetime sql species_row failed (CLI/infra): ${(err as Error).message}`,
    );
  }
  const lines = out.split('\n').filter((l) => l.includes('|'));
  const header = (lines[0] ?? '').split('|').map((c) => c.trim());
  const nameCol = header.indexOf('name');
  const row = lines.slice(1).find((l) => l.split('|')[0]?.trim() === String(speciesId));
  const raw = row?.split('|')[nameCol]?.trim() ?? '';
  const name = raw.replace(/^"(.*)"$/, '$1');
  if (nameCol === -1 || name === '') {
    throw new Error(
      `${label}: species_row has no name for species ${speciesId}: ${out.slice(0, 300)}`,
    );
  }
  return name;
}

// monster_pub need-to-know privacy, end to end
//
// WHAT THIS PROVES THAT NOTHING ELSE CAN. Every other gate in this slice is a
// SOURCE SCAN or a unit test: they prove the table lost `public`, that the view's
// body is the sanctioned filter, that the subscription string changed, that the
// store reconciles. None of them can prove the only thing that actually matters —
// that a REAL second client, connected to a REAL SpacetimeDB, never receives
// another player's monster rows. Non-owner emptiness is provable end to end or
// not at all (ADR-0087:79: the owner-executed `spacetime sql` query cannot show
// it, because the CLI runs AS the owner).
//
// TWO-CONTEXT DESIGN (copied from pvp-full.spec.ts / trade-full.spec.ts): two
// separate chromium.launch() instances generate DISTINCT SpacetimeDB identities.
// The SDK caches its connection+identity in the page's JS module scope, so two
// tabs in one browser (or one context) would share ONE identity — and this whole
// spec is about what identity A can see of identity B.
//
// POSITIVE-ANCHORED, NEVER NEGATIVE-ONLY. "A cannot see B's
// monsters" is trivially true of a client that loaded NOTHING — which is exactly
// the blank-world failure mode a wrong subscription produces (a subscription
// naming a nonexistent view errors the whole batch and `onApplied` never fires).
// Every privacy assertion below is therefore paired with a POSITIVE anchor:
// `ownMonsters.length >= 1` proves the world loaded, `monsterCount ===
// ownMonsters.length` proves what it loaded was ONLY the caller's own rows, and
// the battle/trade tests assert their overlays render FULLY (a real species name,
// real HP numbers) at the same moment.
//
// TWO PAIRS OF BROWSERS, DELIBERATELY. The PvP flow and the trade flow do not share
// one pair: the battle/trade interlock refuses to offer a monster that is in an
// ongoing battle, and the PvP test leaves its battle running. Rather than sequence a
// KO (non-deterministic) or a forfeit through the battle UI (unrelated machinery),
// each flow gets its own pair of fresh browsers, i.e. fresh identities with fresh
// starters in party slot 0. The first pair disconnects in its afterAll, which settles
// its battle by forfeit and deletes both player rows, before the second pair
// launches.
//
// FILE-ORDERING AUDIT (the pvp-side-b.spec.ts idiom — recorded so a future
// reviewer never re-derives it): playwright.config.ts documents single-worker,
// alphabetical-across-files execution over ONE shared world, and golden.spec.ts
// asserts an EXACT player population. `monster-privacy.spec.ts` sorts AFTER
// golden.spec.ts ('g' < 'm'), so golden never observes this file's joined
// players; every browser here is closed in an afterAll before the next file's
// beforeAll runs (on_disconnect deletes the player + character rows).
//
// EARS CRITERIA COVERED
// =====================
//   13r-e-1  a client receives its OWN monster_pub rows and NO other player's
//   13r-e-2  the battle UI and the trade session editor render FULLY while the
//            client holds ZERO other-player monster rows (the empty engaged-view
//            delivery set of ADR-0194 D3)
//   13r-e-3  a live ownership transfer (the session swap) migrates each row
//            between the two clients' views with NO reload (the reveal/revoke
//            analogue)
//
// WHAT EARS 3 CAN AND CANNOT BE TESTED FOR HERE — stated so the coverage is not
// over-read. EARS 3 has two halves: (i) revelation CEASES when an engagement
// ends, and (ii) the client converges on the new row set live. Half (i) is
// VACUOUSLY satisfied in this slice and is untestable by construction:
// `engaged_monster_pub` is DEFERRED, so the engaged delivery set is
// EMPTY — nothing is ever revealed by engagement, therefore nothing has to cease.
// The battle test above is the evidence FOR that emptiness (a fully rendered
// overlay with zero foreign rows), not a test of a cessation path that does not
// exist. Half (ii) is the NON-VACUOUS half and is what the transfer test below
// actually exercises: the view's row set changes under a live subscription and
// both clients converge — A gains a row it could never see before, B loses one it
// still holds, in the same transaction, with no reconnect. When the engaged view
// is eventually built, half (i) needs its own e2e; this file does not cover it.
//
// NO `new RegExp(...)` — Semgrep's detect-non-literal-regexp is an active CI gate
// here (the pvp-side-b.spec.ts convention). Literal regexes and string methods only.

// ---------------------------------------------------------------------------
// GameSnap: the DEV introspection bundle from main.ts's snapshot().
// `monsterCount` is the WHOLE store map's size; `ownMonsters`
// is the caller-filtered projection. The gap between those two
// numbers IS the leak this slice closes.
// ---------------------------------------------------------------------------
interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  monsterCount: number;
  ownMonsters: Array<{
    monsterId: string;
    speciesId: number;
    nickname: string;
    level: number;
    partySlot: number;
  }>;
  ongoingBattle: {
    battleId: string;
    outcome: string;
    turnNumber: number;
  } | null;
}

/** One side of a trade session, as the `__mrTrade` hook hands it across the evaluate boundary. */
interface HookOffer {
  monsterIds: string[];
  items: { itemId: number; qty: number }[];
  currency: string;
}

/** A trade session row as `__mrTrade.mySessions()` returns it (bigints as decimal strings). */
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

/** The `window.__mrTrade` session hook (main.ts `mrTradeHook`). */
interface MrTrade {
  allPlayers(): Array<{ identity: string; name: string }>;
  openTradeSession(partnerHex: string): Promise<void> | undefined;
  setTradeOffer(sessionId: string, offer: HookOffer): Promise<void> | undefined;
  confirmTradeSession(sessionId: string, revision: string): Promise<void> | undefined;
  cancelTradeSession(sessionId: string): Promise<void> | undefined;
  mySessions(): HookSession[];
}

/** The monster-bearing slice of the debug bundle — the only part this spec judges. */
interface MonsterView {
  identity: string;
  monsterCount: number;
  ownMonsters: GameSnap['ownMonsters'];
}

// ---------------------------------------------------------------------------
// gameReady: wait until __game() exists, identity is assigned, and the player has
// been placed on the map. join_game grants the starter Flameling synchronously,
// so ownAuthTile non-null implies the grant has been processed.
// Copied from pvp-full.spec.ts / trade-full.spec.ts — do NOT cross-import.
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

async function monsterView(p: Page): Promise<MonsterView> {
  return p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return { identity: g.identity, monsterCount: g.monsterCount, ownMonsters: g.ownMonsters };
  });
}

/**
 * THE core invariant, asserted the same way everywhere: the store holds at least
 * one monster (POSITIVE anchor — the world loaded; a blank world would satisfy a
 * negative-only privacy check trivially) and holds NOTHING BUT the caller's own
 * rows (`monsterCount === ownMonsters.length`).
 *
 */
function expectOnlyOwnMonsters(view: MonsterView, label: string): void {
  expect(
    view.ownMonsters.length,
    `${label}: POSITIVE ANCHOR — the client must hold at least one of its OWN monsters. ` +
      'Zero means the world never loaded (a subscription naming a nonexistent view errors ' +
      'the WHOLE batch and onApplied never fires: ADR-0087:88 blank world), and every ' +
      'privacy assertion here would then be vacuously true',
  ).toBeGreaterThanOrEqual(1);
  expect(
    view.monsterCount,
    `${label}: the store's ENTIRE monster map must contain nothing but this client's own ` +
      `rows — monsterCount=${view.monsterCount} vs ownMonsters=${view.ownMonsters.length}. ` +
      "Every extra row is another player's monster_pub row delivered to this client " +
      "(issue #284 / ADR-0194: data about other players' monsters is need-to-know). RED ON " +
      'MASTER: monster_pub is a PUBLIC table on an unfiltered subscription, so this equals ' +
      'the number of joined players',
  ).toBe(view.ownMonsters.length);
}

/**
 * The disjointness half, stated over the monster-bearing part of the bundle ONLY.
 *
 * WHY SCOPED AND NOT A WHOLE-BUNDLE STRING SCAN: monster ids and character
 * entity ids are independent auto-inc u64 sequences that both start at 1, so a
 * scan of the whole bundle for the decimal text of a monster id collides with an
 * unrelated entityId almost immediately — a FALSE RED. Scoping to
 * `{monsterCount, ownMonsters}` loses nothing: `expectOnlyOwnMonsters` already
 * proves the map holds no row outside `ownMonsters`, so "none of B's ids appear
 * in A's ownMonsters" is the complete statement.
 */
function expectNoForeignIds(mine: MonsterView, theirs: MonsterView, label: string): void {
  const myIds = mine.ownMonsters.map((m) => m.monsterId);
  const theirIds = theirs.ownMonsters.map((m) => m.monsterId);
  const overlap = myIds.filter((id) => theirIds.includes(id));
  expect(
    overlap,
    `${label}: none of the other player's monster ids may appear anywhere in this client's ` +
      `monster state. Overlap: [${overlap.join(', ')}] (mine=[${myIds.join(', ')}], ` +
      `theirs=[${theirIds.join(', ')}])`,
  ).toEqual([]);
  const bundle = JSON.stringify({
    monsterCount: mine.monsterCount,
    ownMonsters: mine.ownMonsters,
  });
  for (const id of theirIds) {
    expect(
      bundle.includes(`"${id}"`),
      `${label}: the other player's monster id ${id} appears in this client's monster ` +
        `bundle: ${bundle}`,
    ).toBe(false);
  }
}

/**
 * Renames `page`'s own player through the REAL production UI (closeAll -> N ->
 * rename-input -> rename-submit). Copied from pvp-side-b.spec.ts:205.
 * The distinct label is what lets the battle test assert WHOSE card the opponent
 * card is, and it leaves NO overlay open on exit (the rename overlay does not
 * auto-close, and the incoming-challenge auto-show and the face-to-face A press
 * need a bare world). ctl-11a: N opens the Name screen through the main menu
 * (Profile > Name), so the closing `closeAll` also takes the menu beneath it.
 */
async function renamePlayer(page: Page, name: string): Promise<void> {
  await closeAll(page);
  await pressAccel(page, 'N');
  await page.waitForSelector('[data-testid="rename-input"]', { state: 'visible', timeout: 10_000 });
  await page.fill('[data-testid="rename-input"]', name);
  await page.click('[data-testid="rename-submit"]');
  // INTENTIONAL CHANGE (uif-4b, UIF4B.1): the rename outcome is a toast (the one seam), read from
  // `#toast`. Was: the overlay's own `[data-testid="rename-feedback"]` line, retired from index.html.
  await page.waitForFunction(
    () => {
      const fb = document.querySelector('#toast');
      return fb !== null && !(fb as HTMLElement).hidden && (fb.textContent ?? '').trim().length > 0;
    },
    null,
    { timeout: 15_000 },
  );
  const feedbackText = await page.textContent('#toast');
  expect(
    feedbackText ?? '',
    `13r-e: rename feedback for "${name}" must not indicate an error — the opponent-label ` +
      'assertion below is meaningless if the rename itself silently failed',
  ).not.toMatch(/error|failed|reject/i);
  await closeAll(page);
}

// ---------------------------------------------------------------------------
// Inventory privacy (BUG-inventory-world-readable). Stacks are seeded by owner SQL
// (the CLI runs as the module OWNER, which can write the private table — the
// wallet-balance.spec / evolution.spec precedent), then each client's store is read:
// `inventoryRowCount` counts EVERY held row of any owner, so it must equal the
// caller's own stack count.
// ---------------------------------------------------------------------------
interface InventoryView {
  identity: string;
  inventoryRowCount: number;
  ownInventory: Array<{ invId: string; itemId: number; count: number }>;
}

async function inventoryView(p: Page): Promise<InventoryView> {
  return p.evaluate(() => {
    const g = (
      window as unknown as {
        __game: () => InventoryView;
      }
    ).__game();
    return {
      identity: g.identity,
      inventoryRowCount: g.inventoryRowCount,
      ownInventory: g.ownInventory,
    };
  });
}

/** Owner-SQL insert of one inventory stack. Every interpolated value is charset-checked
 *  (literal regexes only) so nothing but hex/digits reaches the shell. */
function seedInventoryStack(identityHex: string, itemId: number, count: number): void {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  const hex = identityHex.toLowerCase().startsWith('0x') ? identityHex.slice(2) : identityHex;
  if (
    !/^[A-Za-z0-9:/._-]+$/.test(server) ||
    !/^[A-Za-z0-9_-]+$/.test(db) ||
    !/^[0-9a-f]{64}$/.test(hex.toLowerCase()) ||
    !Number.isInteger(itemId) ||
    !Number.isInteger(count)
  ) {
    throw new Error(`seedInventoryStack: refusing non-literal-shaped input ${identityHex}`);
  }
  execSync(
    `spacetime sql -s ${server} ${db} "INSERT INTO inventory (inv_id, owner_identity, item_id, count) VALUES (0, 0x${hex.toLowerCase()}, ${itemId}, ${count})"`,
    { encoding: 'utf8', timeout: 15_000 },
  );
}

// ===========================================================================
// SESSION 1 — join + the PvP battle overlay (EARS 13r-e-1).
// ===========================================================================
test.describe
  .serial('13r-e — monster_pub privacy: rosters + the battle overlay (ADR-0194)', () => {
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
      // Tolerant teardown (ranked-forfeit.spec.ts precedent): a failing assertion
      // must never orphan a browser process. Closing B also settles any battle
      // still Ongoing via forfeit_on_disconnect, so session 2 starts clean.
      try {
        await browserA?.close();
      } catch {
        // may already be closed on an error path
      }
      try {
        await browserB?.close();
      } catch {
        // may already be closed on an error path
      }
    });

    // -------------------------------------------------------------------------
    // Inventory privacy — item counts are owner-private: each client receives its
    // OWN stacks (positive anchor: the seeded stack arrives live) and NONE of the
    // other player's. RED on the public-table build: B's stack reached A's store.
    // -------------------------------------------------------------------------
    test('INVENTORY: each client receives its OWN item stacks and NONE of the other player`s', async () => {
      test.setTimeout(60_000);
      const a = await inventoryView(pageA);
      const b = await inventoryView(pageB);
      expect(a.identity).not.toBe(b.identity);
      seedInventoryStack(a.identity, 1, 3);
      seedInventoryStack(b.identity, 2, 5);
      const seeded = (p: Page, itemId: number, count: number) =>
        p.waitForFunction(
          ([i, c]) =>
            (
              window as unknown as {
                __game: () => InventoryView;
              }
            )
              .__game()
              .ownInventory.some((s) => s.itemId === i && s.count === c),
          [itemId, count],
          { timeout: 20_000 },
        );
      // POSITIVE ANCHOR: each client's own stack arrives over the live subscription.
      await Promise.all([seeded(pageA, 1, 3), seeded(pageB, 2, 5)]);
      // Settle one more burst so a late-arriving foreign row would also have landed.
      await pageA.waitForTimeout(500);

      for (const [label, mine, theirs] of [
        ['client A', await inventoryView(pageA), await inventoryView(pageB)],
        ['client B', await inventoryView(pageB), await inventoryView(pageA)],
      ] as const) {
        expect(mine.ownInventory.length, `${label}: holds its own stack`).toBeGreaterThanOrEqual(1);
        expect(
          mine.inventoryRowCount,
          `${label}: the store's WHOLE inventory map must hold nothing but this client's own ` +
            `stacks (inventoryRowCount=${mine.inventoryRowCount} vs own=${mine.ownInventory.length}); ` +
            "every extra row is another player's item counts delivered to this client",
        ).toBe(mine.ownInventory.length);
        const theirIds = theirs.ownInventory.map((s) => s.invId);
        expect(
          mine.ownInventory.filter((s) => theirIds.includes(s.invId)),
          `${label}: none of the other player's stack ids may appear`,
        ).toEqual([]);
      }
    });

    // -------------------------------------------------------------------------
    // EARS 13r-e-1 — the whole slice, in one assertion pair, symmetric.
    //
    // -------------------------------------------------------------------------
    test('EARS 13r-e-1: each client receives its OWN monster rows and NONE of the other player`s', async () => {
      test.setTimeout(60_000);

      // Both clients must have converged on their own roster before the
      // equality is meaningful (the initial subscription burst is async).
      await Promise.all([
        pageA.waitForFunction(
          () => (window as unknown as { __game: () => GameSnap }).__game().ownMonsters.length >= 1,
          null,
          { timeout: 20_000 },
        ),
        pageB.waitForFunction(
          () => (window as unknown as { __game: () => GameSnap }).__game().ownMonsters.length >= 1,
          null,
          { timeout: 20_000 },
        ),
      ]);

      const viewA = await monsterView(pageA);
      const viewB = await monsterView(pageB);

      expect(viewA.identity, 'the two clients must have distinct identities').not.toBe(
        viewB.identity,
      );

      expectOnlyOwnMonsters(viewA, 'client A');
      expectOnlyOwnMonsters(viewB, 'client B');
      expectNoForeignIds(viewA, viewB, 'client A');
      expectNoForeignIds(viewB, viewA, 'client B');
    });

    // -------------------------------------------------------------------------
    // EARS 13r-e-2 (battle half) — the empty engaged-view delivery set.
    //
    // ADR-0194 D3 DEFERS `engaged_monster_pub` on the claim that NO client code
    // reads another player's monster_pub row: the PvP overlay renders entirely
    // from `battle.state`. This test is the evidence for that claim. If the
    // overlay were secretly reading monster_pub rows, the opponent card would
    // degrade the moment those rows stopped arriving — a `Unknown (#<id>)`
    // species name or missing HP numbers — WHILE `monsterCount ===
    // ownMonsters.length` holds. Asserting both at the same instant is what
    // makes the deferral honest rather than hopeful.
    // -------------------------------------------------------------------------
    test('EARS 13r-e-2: the PvP tactical battle UI renders the opponent`s info box FULLY (its real species, an HP readout) while each client holds zero other-player monster rows (bt-16: was the 1v1 overlay)', async () => {
      // bt-16: + both deploys (≤ 40 s) on top of the 120 s flow.
      test.setTimeout(180_000);

      // Distinct labels so the opponent card can be identified by WHOSE it is.
      // Unique per run (the e2e world is shared across runs); alphanumeric and
      // well under the server's MAX_NAME_LEN=24.
      const uniqueSuffix = String(Date.now() % 1_000_000);
      const nameA = `MpA${uniqueSuffix}`;
      const nameB = `MpB${uniqueSuffix}`;
      await Promise.all([renamePlayer(pageA, nameA), renamePlayer(pageB, nameB)]);

      // B must have no overlay open — P below must OPEN Social, not act as Start over an open
      // screen (ranked-forfeit.spec.ts precedent).
      await closeAll(pageB);

      // A challenges B through the production DOM (INTENTIONAL CHANGE, ctl-10b CTL10B.1-2: the
      // PvP overlay's per-player Challenge button and P / O initiation are gone). A challenges B
      // FACE TO FACE: it stands on B's tile (both joined at the spawn; the helper walks there
      // when they stand apart), presses A, chooses `Challenge — <B's unique rename label>` and
      // sends the size pick's first row (bt-15).
      // B accepts through the Social sheet (ctl-13 CTL13.2: the banner announces the request, P
      // opens Social on it; qf-8 QF8.3: A opens its sheet on Accept, A accepts), and BOTH sides
      // deploy by buttons: bt-16 — the accept opens a TACTICAL PvP battle in Deploying
      // (`startPvpByButtons`: face to face, the accept, then each page's Deploy, to Active).
      const battleId = await startPvpByButtons(pageA, pageB, nameB, '13r-e-2');
      expect(battleId, 'the PvP battle has a decimal id').toMatch(/^[0-9]+$/);

      // --- the battle UI renders FULLY, on BOTH sides ---------------------------
      // SURVIVING CHECK (bt-16): retired the 1v1 overlay's `battle-commands`, "Submit: <skill>"
      // buttons, `${name}: ${species}` opponent header and "HP x/y" card readouts (a live battle
      // is tactical now) → each page's `.tactics-battle` renders the OPPONENT's unit in its FOE
      // info box (tactics/hud.ts: name / level / HP / affinity — the bt-10 keep-signal) with a
      // species name EQUAL to the opponent's real species — derived from the OPPONENT page's own
      // `__game().ownMonsters[0].speciesId` through the server's `species_row` (owner SQL), never
      // a literal — and an HP readout.
      //
      // WHAT THESE CLAUSES DO AND DO NOT PROVE (stated precisely, because the
      // obvious over-claim is tempting): they prove the battle UI RENDERED — the real
      // species name, real HP numbers — under the privacy regime. They do NOT prove
      // non-dependence on monster_pub: the shell resolves the name from the PUBLIC
      // species_row map keyed by the battle unit's species_id, so it never had a
      // monster_pub dependency to lose.
      //
      // The load-bearing pairing is what follows the loop: a FULLY rendered
      // battle UI AT THE SAME INSTANT as `monsterCount === ownMonsters.length`. That
      // is the evidence for ADR-0194 D3's deferral — the engaged delivery set is
      // empty and the engagement UI is complete anyway — and it is a behavioural
      // observation, not a proof of the code path. The static half of that claim
      // (nothing in the client reads a non-own monster row) is owned by the store
      // accessor deletion and its test in client/src/net/store.test.ts.
      for (const [page, opponentPage, label] of [
        [pageA, pageB, 'client A'],
        [pageB, pageA, 'client B'],
      ] as const) {
        const opponentSpeciesId = await opponentPage.evaluate(
          () =>
            (window as unknown as { __game: () => GameSnap }).__game().ownMonsters[0]?.speciesId,
        );
        if (opponentSpeciesId === undefined || !Number.isInteger(opponentSpeciesId)) {
          throw new Error(`${label}: the opponent page holds no own monster species id`);
        }
        const expectedSpecies = speciesNameById(opponentSpeciesId, label);
        await expect(
          page.locator(TACTICS_SHELL),
          `${label}: the tactical shell is shown`,
        ).toBeVisible({
          timeout: 20_000,
        });
        const foeRows = page.locator(`${TACTICS_SHELL} .tactics-info--foe .tactics-info-row`);
        await expect(
          foeRows,
          `${label}: the FOE info box holds the opponent's one unit`,
        ).toHaveCount(1, { timeout: 20_000 });
        await expect(
          foeRows.first().locator('.tactics-info-name'),
          `${label}: the opponent unit's info box names the opponent's REAL species (${expectedSpecies}, species ${opponentSpeciesId})`,
        ).toHaveText(expectedSpecies);
        const hpText = (
          (await foeRows.first().locator('.tactics-info-hp').textContent()) ?? ''
        ).trim();
        const hp = /(\d+)\D+(\d+)/.exec(hpText);
        expect(
          hp !== null && Number(hp[2]) > 0 && Number(hp[1]) <= Number(hp[2]),
          `${label}: the opponent unit's info box renders an HP readout (current / max) — got "${hpText}"`,
        ).toBe(true);
        const shellText = (await page.locator(TACTICS_SHELL).textContent()) ?? '';
        expect(
          shellText.includes('Unknown (#') || shellText.includes(`#${opponentSpeciesId}`),
          `${label}: the shell shows a placeholder species name somewhere: ${shellText.slice(0, 400)}`,
        ).toBe(false);
      }

      // --- and, at the SAME instant, neither client holds a foreign row -------
      const viewA = await monsterView(pageA);
      const viewB = await monsterView(pageB);
      expectOnlyOwnMonsters(viewA, 'client A (mid-battle)');
      expectOnlyOwnMonsters(viewB, 'client B (mid-battle)');
      expectNoForeignIds(viewA, viewB, 'client A (mid-battle)');
      expectNoForeignIds(viewB, viewA, 'client B (mid-battle)');
    });
  });

// ===========================================================================
// SECOND PAIR — the trade session editor + a live ownership transfer
// (EARS 13r-e-2 trade half, 13r-e-3). Fresh browsers: see the two-pairs rationale in
// the file header.
//
// HOW THE EDITOR OPENS (trade-session.spec.ts precedent): A opens the session face to
// face (`openFaceToFace`: A walks onto B's tile, A, `Trade — <B>`, A), which opens A's
// editor on it; B answers from the banner (B stands apart so Y has no target, Y opens
// the request sheet on Accept, A opens B's editor on that session). The offers and the
// confirms then go through the DEV `__mrTrade` hook: the editor's buttons are
// trade-session.spec.ts's subject, and this test is about what each client RECEIVES.
// ===========================================================================

/** The editor's DOM contract (ui/tradeSessionView.ts): the static shell it mounts on, and the
 *  monster cards of one side. */
const EDITOR = '#tradepropose-overlay';
const sideCard = (side: 'mine' | 'theirs', monsterId: string): string =>
  `#tradesession-${side} ul[data-section="monsters"] > li[data-monster-id="${monsterId}"]`;
const sideCards = (side: 'mine' | 'theirs'): string =>
  `#tradesession-${side} ul[data-section="monsters"] > li`;
const BANNER = '#notice-banner';

/** The context stack as base-first names. */
const stackNames = (p: Page): Promise<string[]> =>
  p.evaluate(() => {
    const g = (
      window as unknown as { __game: () => { stack: Array<{ kind: string; id?: string }> } }
    ).__game();
    return g.stack.map((f) => f.id ?? f.kind);
  });

/** The session between `me` and `other` (either orientation) as `p`'s hook reads it, else null. */
const sessionBetween = (p: Page, me: string, other: string): Promise<HookSession | null> =>
  p.evaluate(
    ({ me: a, other: b }) => {
      const w = window as unknown as { __mrTrade: MrTrade };
      return (
        w.__mrTrade
          .mySessions()
          .find(
            (s) => (s.opener === a && s.partner === b) || (s.opener === b && s.partner === a),
          ) ?? null
      );
    },
    { me, other },
  );

/** Polls until `p` holds a session between the two that satisfies `ok`; returns it. */
async function waitSession(
  p: Page,
  me: string,
  other: string,
  label: string,
  ok: (s: HookSession) => boolean = () => true,
): Promise<HookSession> {
  let found: HookSession | null = null;
  await expect
    .poll(
      async () => {
        found = await sessionBetween(p, me, other);
        return found !== null && ok(found);
      },
      { message: `${label}: the session reaches this page in the expected state`, timeout: 20_000 },
    )
    .toBe(true);
  const s = found as HookSession | null;
  if (s === null) throw new Error(`${label}: no session`);
  return s;
}

/** A session reducer call through the hook, made in the page. */
type SessionCall =
  | { kind: 'offer'; sessionId: string; monsterIds: string[] }
  | { kind: 'confirm'; sessionId: string; revision: string }
  | { kind: 'cancel'; sessionId: string };

/** Sends `call` from `p` and awaits the reducer: null on success, else the rejection's name and
 *  message as the page saw them. */
const sendSession = (
  p: Page,
  call: SessionCall,
): Promise<{ name: string; message: string } | null> =>
  p.evaluate(async (c: SessionCall) => {
    const w = window as unknown as { __mrTrade: MrTrade };
    let sent: Promise<void> | undefined;
    switch (c.kind) {
      case 'offer':
        sent = w.__mrTrade.setTradeOffer(c.sessionId, {
          monsterIds: c.monsterIds,
          items: [],
          currency: '0',
        });
        break;
      case 'confirm':
        sent = w.__mrTrade.confirmTradeSession(c.sessionId, c.revision);
        break;
      case 'cancel':
        sent = w.__mrTrade.cancelTradeSession(c.sessionId);
        break;
    }
    if (sent === undefined) return { name: 'NotSent', message: `${c.kind}: no live connection` };
    try {
      await sent;
      return null;
    } catch (e) {
      const err = e as { name?: unknown; message?: unknown } | null;
      return { name: String(err?.name ?? typeof e), message: String(err?.message ?? e) };
    }
  }, call);

/** Cleanup only (a `finally`): cancels any session the two still share. Never throws. */
async function cancelLeftover(pa: Page, pb: Page, a: string, b: string): Promise<void> {
  try {
    const left = await sessionBetween(pa, a, b);
    if (left !== null) {
      await sendSession(pa, { kind: 'cancel', sessionId: left.sessionId });
      await expect
        .poll(async () => (await sessionBetween(pa, a, b)) === null, { timeout: 20_000 })
        .toBe(true);
    }
  } catch (err) {
    console.error('[monster-privacy cleanup]', err);
  }
  await closeAll(pa).catch(() => undefined);
  await closeAll(pb).catch(() => undefined);
}

/** Walks `page`'s player a few tiles away along a safe path until the world chip clears (nothing
 *  faced), so Y opens the request sheet (respond-request.spec.ts's helper, copied). */
async function standApart(page: Page): Promise<void> {
  const w = await readWorld(page);
  const from = w.ownAuthTile;
  if (from === null) throw new Error('standApart: no authoritative own tile');
  const candidates: Tile[] = [];
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      const dist = Math.abs(dx) + Math.abs(dy);
      const t = { x: from.x + dx, y: from.y + dy };
      if (dist >= 3 && dist <= 6 && safeTile(w.map, t)) candidates.push(t);
    }
  }
  candidates.sort(
    (a, b) =>
      Math.abs(a.x - from.x) +
      Math.abs(a.y - from.y) -
      (Math.abs(b.x - from.x) + Math.abs(b.y - from.y)),
  );
  for (const target of candidates.slice(0, 8)) {
    if ((await walkTo(page, target, 'standApart')) === 'battle') {
      throw new Error('standApart: a battle started on a grass-free walk');
    }
    const clear = await expect
      .poll(() => readChip(page), { timeout: 3_000 })
      .toBeNull()
      .then(() => true)
      .catch(() => false);
    if (clear) return;
  }
  throw new Error('standApart: no nearby tile leaves the character with nothing faced');
}

/** The request sheet's rows inside `#interact-prompt`. */
const sheetRows = (p: Page): Promise<Array<{ text: string; selected: boolean }>> =>
  p.evaluate(() =>
    [...document.querySelectorAll('#interact-prompt [role="option"]')].map((row) => ({
      text: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
      selected: row.getAttribute('aria-selected') === 'true',
    })),
  );

/** The partner answers an incoming session from the banner: it stands apart, Y opens the request
 *  sheet on Accept, A opens the editor on that session (trade-session.spec.ts `openFromBanner`). */
async function openFromBanner(p: Page, sessionId: string, label: string): Promise<void> {
  await expect(p.locator(BANNER), `${label}: the banner shows`).toBeVisible({ timeout: 20_000 });
  await standApart(p);
  await expect(p.locator(BANNER), `${label}: the banner still waits`).toBeVisible();
  await pressButton(p, 'Y');
  await expect
    .poll(async () => (await sheetRows(p)).map((r) => r.text), {
      message: `${label}: Y opens the request sheet`,
      timeout: 5_000,
    })
    .toEqual(['Accept', 'Decline', 'View', 'Close']);
  expect(
    (await sheetRows(p)).findIndex((r) => r.selected),
    `${label}: on Accept`,
  ).toBe(0);
  await pressButton(p, 'A');
  await expect
    .poll(() => stackNames(p), { message: `${label}: Accept opens the editor`, timeout: 10_000 })
    .toEqual(['world', 'tradeSessionView']);
  await expect(p.locator(EDITOR), `${label}: on THIS session`).toHaveAttribute(
    'data-session-id',
    sessionId,
  );
}

test.describe
  .serial('13r-e — monster_pub privacy: the trade session editor + live ownership transfer, ADR-0194', () => {
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
      try {
        await browserA?.close();
      } catch {
        // may already be closed on an error path
      }
      try {
        await browserB?.close();
      } catch {
        // may already be closed on an error path
      }
    });

    test('EARS 13r-e-2 + 13r-e-3: the trade session editor renders both parties` offered cards while each client holds zero foreign monster rows, and the confirmed swap migrates both rows live with NO reload', async () => {
      test.setTimeout(180_000);

      await Promise.all([
        pageA.waitForFunction(
          () => (window as unknown as { __game: () => GameSnap }).__game().ownMonsters.length >= 1,
          null,
          { timeout: 20_000 },
        ),
        pageB.waitForFunction(
          () => (window as unknown as { __game: () => GameSnap }).__game().ownMonsters.length >= 1,
          null,
          { timeout: 20_000 },
        ),
      ]);
      await closeAll(pageA);
      await closeAll(pageB);

      const beforeA = await monsterView(pageA);
      const beforeB = await monsterView(pageB);
      expectOnlyOwnMonsters(beforeA, 'client A (pre-trade)');
      expectOnlyOwnMonsters(beforeB, 'client B (pre-trade)');

      const identityA = beforeA.identity;
      const identityB = beforeB.identity;
      expect(identityA, 'the two clients must have distinct identities').not.toBe(identityB);
      expect(
        await sessionBetween(pageA, identityA, identityB),
        'precondition: no session yet',
      ).toBeNull();
      // Each side offers its lowest-slot party monster (the starter of a fresh identity).
      const offerOf = (v: MonsterView, label: string): GameSnap['ownMonsters'][number] => {
        const m = [...v.ownMonsters]
          .filter((x) => x.partySlot < 6)
          .sort((x, y) => x.partySlot - y.partySlot)[0];
        if (m === undefined) throw new Error(`${label}: no party monster to offer`);
        return m;
      };
      const monA = offerOf(beforeA, 'client A');
      const monB = offerOf(beforeB, 'client B');
      // The species each card must name, from the server's PUBLIC species_row (owner SQL),
      // keyed by the OFFERING page's own row — never a literal.
      const speciesA = speciesNameById(monA.speciesId, 'client A');
      const speciesB = speciesNameById(monB.speciesId, 'client B');

      // A page-side marker: still present at the end means neither page reloaded.
      for (const p of [pageA, pageB]) {
        await p.evaluate(() => {
          (window as unknown as { __mrNoReload?: boolean }).__mrNoReload = true;
        });
      }

      try {
        // --- open the editor on both pages -----------------------------------------
        await openFaceToFace(pageA, 'Trade', undefined, pageB);
        const opened = await waitSession(pageA, identityA, identityB, 'A opens');
        expect(opened.opener, 'A opened it').toBe(identityA);
        const sid = opened.sessionId;
        await expect
          .poll(() => stackNames(pageA), { message: 'A: the editor opens', timeout: 10_000 })
          .toEqual(['world', 'tradeSessionView']);
        await expect(pageA.locator(EDITOR), 'A: the editor is on the new session').toHaveAttribute(
          'data-session-id',
          sid,
        );
        await waitSession(pageB, identityB, identityA, 'B sees the session');
        await openFromBanner(pageB, sid, 'B');

        // --- both offer their monster ------------------------------------------------
        const offeredA = await sendSession(pageA, {
          kind: 'offer',
          sessionId: sid,
          monsterIds: [monA.monsterId],
        });
        expect(offeredA, `A offers: ${JSON.stringify(offeredA)}`).toBeNull();
        const offeredB = await sendSession(pageB, {
          kind: 'offer',
          sessionId: sid,
          monsterIds: [monB.monsterId],
        });
        expect(offeredB, `B offers: ${JSON.stringify(offeredB)}`).toBeNull();
        const both = await waitSession(
          pageA,
          identityA,
          identityB,
          'both offers land',
          (s) =>
            s.revision === '2' &&
            s.openerOffer.monsterIds.join() === monA.monsterId &&
            s.partnerOffer.monsterIds.join() === monB.monsterId,
        );

        // --- EARS 13r-e-2 (trade half): BOTH parties' cards render fully ------------
        // Each side's cards are the MonsterCard snapshots the server stored in the session's
        // offer, so A's `#tradesession-theirs` shows B's offered monster — a monster_pub row A
        // never receives — and must name its real species.
        //
        // WHAT THIS PROVES, PRECISELY: that the session editor is COMPLETE under the privacy
        // regime, at the same instant as the monsterCount assertion below. It is NOT a proof of
        // non-dependence: the editor resolves the name from `speciesMap` (the PUBLIC species_row
        // table) keyed by the speciesId the card carries, so it never had a monster_pub
        // dependency to lose. `Unknown (#N)` is that lookup's fallback, not a monster_pub
        // sentinel. The pairing — full render WITH an empty foreign-row set — is the evidence
        // for ADR-0194 D3's deferral; the static half is owned by the store-accessor deletion
        // test.
        for (const [page, label, mine, theirs, mySpecies, theirSpecies] of [
          [pageA, 'client A', monA, monB, speciesA, speciesB],
          [pageB, 'client B', monB, monA, speciesB, speciesA],
        ] as const) {
          await expect(page.locator(EDITOR), `${label}: the editor is open`).toBeVisible();
          await expect(page.locator(EDITOR)).toHaveAttribute('data-revision', '2', {
            timeout: 15_000,
          });
          const own = page.locator(sideCard('mine', mine.monsterId));
          const other = page.locator(sideCard('theirs', theirs.monsterId));
          await expect(own, `${label}: its own offered card renders`).toHaveCount(1, {
            timeout: 15_000,
          });
          await expect(
            other,
            `${label}: POSITIVE ANCHOR — the OTHER player's offered card renders`,
          ).toHaveCount(1, { timeout: 15_000 });
          await expect(page.locator(sideCards('mine')), `${label}: one own card`).toHaveCount(1);
          await expect(page.locator(sideCards('theirs')), `${label}: one other card`).toHaveCount(
            1,
          );
          await expect(
            other,
            `${label}: the other player's card names its REAL species (${theirSpecies})`,
          ).toContainText(theirSpecies);
          await expect(
            own,
            `${label}: its own card names its REAL species (${mySpecies})`,
          ).toContainText(mySpecies);
          const cardsText = `${(await own.textContent()) ?? ''}\n${(await other.textContent()) ?? ''}`;
          expect(
            cardsText.includes('Unknown (#'),
            `${label}: a session card degraded to a placeholder species name. The editor renders ` +
              'from the MonsterCard snapshots the server stores in the session offer (ADR-0194 ' +
              'D3), so it must be unaffected by monster_pub going private. ' +
              `cards=${cardsText}`,
          ).toBe(false);
        }

        // At the SAME time, neither client holds a foreign monster row.
        const midA = await monsterView(pageA);
        const midB = await monsterView(pageB);
        expectOnlyOwnMonsters(midA, 'client A (session open)');
        expectOnlyOwnMonsters(midB, 'client B (session open)');
        expectNoForeignIds(midA, midB, 'client A (session open)');
        expectNoForeignIds(midB, midA, 'client B (session open)');

        // --- both confirm: the last confirm executes the swap ---------------------------
        const confirmedA = await sendSession(pageA, {
          kind: 'confirm',
          sessionId: sid,
          revision: both.revision,
        });
        expect(confirmedA, `A confirms: ${JSON.stringify(confirmedA)}`).toBeNull();
        const half = await waitSession(
          pageB,
          identityB,
          identityA,
          'B sees A`s confirm',
          (s) => s.openerConfirmed,
        );
        const confirmedB = await sendSession(pageB, {
          kind: 'confirm',
          sessionId: sid,
          revision: half.revision,
        });
        expect(confirmedB, `B confirms: ${JSON.stringify(confirmedB)}`).toBeNull();

        // --- EARS 13r-e-3: each row MIGRATES between the two views, live --------------
        // NO reload: the view's row set changes under a live subscription, and each client's
        // store must converge on it. This is the reveal/revoke analogue — each client gains a
        // row it could never see before and loses the one it gave, in the same transaction.
        //
        // WRONG IMPL KILLED: `my_wallet`-style insert-only wiring. Each client would gain the
        // received monster and KEEP the given one forever (stranded in its store because the
        // view's onDelete is never handled) — the monsterCount assertions below catch that, and
        // no amount of waiting fixes it.
        await Promise.all([
          pageA.waitForFunction(
            (ids: { gained: string; gave: string }) => {
              const g = (window as unknown as { __game: () => GameSnap }).__game();
              return (
                g.ownMonsters.some((m) => m.monsterId === ids.gained) &&
                !g.ownMonsters.some((m) => m.monsterId === ids.gave)
              );
            },
            { gained: monB.monsterId, gave: monA.monsterId },
            { timeout: 30_000 },
          ),
          pageB.waitForFunction(
            (ids: { gained: string; gave: string }) => {
              const g = (window as unknown as { __game: () => GameSnap }).__game();
              return (
                g.ownMonsters.some((m) => m.monsterId === ids.gained) &&
                !g.ownMonsters.some((m) => m.monsterId === ids.gave)
              );
            },
            { gained: monA.monsterId, gave: monB.monsterId },
            { timeout: 30_000 },
          ),
        ]);

        const afterA = await monsterView(pageA);
        const afterB = await monsterView(pageB);
        expect(
          afterA.ownMonsters.map((m) => m.monsterId).sort(),
          'client A: gave its monster, received B`s',
        ).toEqual(
          [
            ...beforeA.ownMonsters.map((m) => m.monsterId).filter((id) => id !== monA.monsterId),
            monB.monsterId,
          ].sort(),
        );
        expect(
          afterB.ownMonsters.map((m) => m.monsterId).sort(),
          'client B: gave its monster, received A`s',
        ).toEqual(
          [
            ...beforeB.ownMonsters.map((m) => m.monsterId).filter((id) => id !== monB.monsterId),
            monA.monsterId,
          ].sort(),
        );

        // The invariant still holds on BOTH sides after the migration: neither client keeps a
        // stale copy of the row it gave away (a live leak of a monster it no longer owns).
        expect(
          afterA.monsterCount,
          'client A: the row it gave away must be GONE from the store, not merely filtered out ' +
            `of ownMonsters — monsterCount=${afterA.monsterCount} vs ownMonsters=` +
            `${afterA.ownMonsters.length}. A stale copy here is the my_wallet insert-only ` +
            'failure ADR-0194 D4 names: the traded-away monster is stranded in the client',
        ).toBe(afterA.ownMonsters.length);
        expect(
          afterB.monsterCount,
          'client B: the row it gave away must be GONE from the store — ' +
            `monsterCount=${afterB.monsterCount} vs ownMonsters=${afterB.ownMonsters.length}`,
        ).toBe(afterB.ownMonsters.length);
        expectNoForeignIds(afterA, afterB, 'client A (post-transfer)');
        expectNoForeignIds(afterB, afterA, 'client B (post-transfer)');

        for (const [p, label] of [
          [pageA, 'client A'],
          [pageB, 'client B'],
        ] as const) {
          expect(
            await p.evaluate(
              () => (window as unknown as { __mrNoReload?: boolean }).__mrNoReload === true,
            ),
            `${label}: the page never reloaded during the migration`,
          ).toBe(true);
          expect((await monsterView(p)).identity, `${label}: the same identity throughout`).toBe(
            label === 'client A' ? identityA : identityB,
          );
        }
      } finally {
        await cancelLeftover(pageA, pageB, identityA, identityB);
      }
    });
  });
