import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// M13.5c dialogue lifecycle e2e — plan §Test plan c-5(b) + red-team fold
// "dialogue.spec.ts includes a SECOND identity" (docs/specs/m13.5c-plan.md).
//
// ROLE: the stays-green regression net through the player_conversation privacy
// swap (T5: private table + owner-scoped my_conversation view), plus the runtime
// isolation net. Every assertion anchors ONLY to UI behavior — overlay element
// visibility (#dialogue-overlay, #quest-log-overlay: client/index.html:11-17) and
// rendered text — NEVER to table/binding names, so the spec passes identically
// against today's public table and tomorrow's owner-scoped view.
//
// T0 SPIKE CONTEXT (plan §T0 outcomes): through the view, live INSERT (talk) and
// DELETE (dismiss / end-of-dialogue) propagate to the owner's subscription, and a
// row UPDATE arrives as an UNORDERED onInsert(new)+onDelete(old) pair (NO
// onUpdate). The pair's net-effect gate is unit-tested in
// client/src/net/viewDelete.test.ts (shouldRemoveOnViewDelete).
//
// RED REASON (today, exactly ONE missing client affordance):
//   No TALK trigger exists anywhere in client/src — verified this session: no
//   `reducers.talk(` call site; the main.ts keydown handler covers only
//   KeyB/KeyI/KeyE/KeyQ/KeyH/KeyG/Escape/movement/Space. The dialogue overlay is
//   pure-subscription (store.ownConversation) and only the `talk` reducer creates
//   the row; the page cannot call reducers out-of-band (DbConnection has no
//   accessible token — recruit.spec.ts design note). talkUntilOpen() therefore
//   times out until the trigger lands.
//
// IMPLEMENTER CONTRACT (client-only; unblocks this spec BEFORE the T5 swap):
//   main.ts keydown gains `KeyT` = TALK: when NO overlay is visible, find the
//   nearest NPC (store.allNpcs() joined to character rows, same zone as the own
//   character, Manhattan distance <= 2 — mirrors server TALK_RANGE, npc.rs:20) to
//   the own AUTHORITATIVE tile and send
//   `sendGuarded('talk', () => conn?.conn.reducers.talk({ npcEntityId }))`;
//   no-op when none is in range; e.preventDefault(). The server re-validates zone
//   + range (npc.rs talk Steps 4-5) — the client check is latency hygiene, not
//   security. Once KeyT lands, this spec MUST run green against TODAY's module
//   (public player_conversation) — that run is the pre-swap baseline — and MUST
//   stay green after the my_conversation view swap.
//
// POST-SWAP TEETH (which wrong implementation each test kills):
//   - "talk opens overlay": a connection.ts swap that subscribes to the view but
//     never hydrates its inserts (overlay never opens — client dark).
//   - "dismiss hides" + "advance ends dialogue": an over-corrected net-effect
//     delete gate that never removes (always-false shouldRemoveOnViewDelete) —
//     genuine deletes would leave the overlay stuck open. (The opposite failure,
//     naive always-remove, is killed at unit level: viewDelete.test.ts.)
//   - "B never renders the overlay": an unfiltered view leaking A's row to B
//     combined with any client keying that surfaces it — end-to-end silence is
//     asserted via a sticky MutationObserver latch, not spot checks. (The
//     transport-level leak itself is also gated by the conversation-privacy eval;
//     this is the runtime half — plan red-team fold RT-H2/e2e.)
//
// DOCUMENTED CONTENT GAP (not a test weakness — content is outside this
// client-only chunk): the plan's "advance → text CHANGES and the overlay does NOT
// close" update-pair tooth is NOT expressible against today's seeded content.
// The ONLY tree (game-core/content/dialogue_trees/000-core.ron: elder_oak_talk)
// is SINGLE-node ("greeting") and its only choice ("I seek a quest.") has
// next_node: None → a successful advance ENDS the dialogue (npc.rs advance Step 8
// None-branch deletes the row). The insert+delete-pair trap is therefore gated by
// the viewDelete.test.ts sequence tests; when content gains a multi-node tree
// (CONTENT_VERSION bump — server-side), extend this spec with: click a
// non-terminal choice → #dialogue-node-text CHANGES && overlay stays visible.
//
// WORLD FACTS used below (empirical, this session):
//   - NPC: npc_id "elder_oak", zone 0, spawn/home (5,5), wander_radius 2,
//     dialogue_tree_id "elder_oak_talk" (content/npcs/000-core.ron). It wanders:
//     up to 1 tile per 200ms tick, 4-in-5 move probability (game-core npc_decide),
//     Manhattan <= 2 of home.
//   - Entry node text "The ancient oak spirit greets you."; npcName renders as
//     the npcId "elder_oak" (dialogueModel.ts:31); choice text "I seek a quest."
//     with effects [StartQuest("quest_001")].
//   - quest_001 starts at stepIndex 0; the quest log li renders
//     "quest_001 (step 0)" (questLogModel displayName = questId verbatim;
//     questLogView li `${displayName} (step ${stepIndex})`).
//   - TALK_RANGE = 2 Manhattan (npc.rs:20). advance_dialogue RE-CHECKS zone+range
//     and DELETES the conversation on failure (walked_away, RT-ADV-01 fix) — the
//     bounded retry loops below exist because the NPC keeps wandering.
//   - Player spawn (1,1), zone 0. Zone-0 map (content/zone_maps/000-core.ron):
//     grass at (2,2),(3,2),(8,2),(8,3),(3,4),(4,4),(8,4),(7,5),(8,5); interior
//     walls (4,3),(5,3); WARP TILE at (5,5)→zone 1 — the walk must NEVER step on
//     (5,5). Grass-free pocket path (1,1)→(5,4): E,E,E,E,E,S,S,S,W — every
//     intermediate tile is floor, so NO encounter can start (encounters roll only
//     on stepping onto grass) and no Escape battle-dismiss latch is needed.

interface Tile {
  x: number;
  y: number;
}

interface DialogueSnap {
  identity: string;
  ownEntityId: string | null;
  ownAuthTile: Tile | null;
  presenceCount: number;
  characters: { entityId: string; tileX: number; tileY: number }[];
  ongoingBattle: { battleId: string; outcome: string } | null;
}

const snap = (p: Page): Promise<DialogueSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => DialogueSnap }).__game();
    return {
      identity: g.identity,
      ownEntityId: g.ownEntityId,
      ownAuthTile: g.ownAuthTile,
      presenceCount: g.presenceCount,
      characters: g.characters,
      ongoingBattle: g.ongoingBattle,
    };
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => DialogueSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

// Server TALK_RANGE (npc.rs:20) — Manhattan. Mirrored here for the poll predicate.
const TALK_RANGE = 2;
/** Grass-free, warp-free path spawn (1,1) → talk pocket (5,4); see WORLD FACTS. */
const WALK_PATH: readonly string[] = [
  'East',
  'East',
  'East',
  'East',
  'East', // (6,1)
  'South',
  'South',
  'South', // (6,4)
  'West', // (5,4) — Manhattan 1 from the NPC's home (5,5); NEVER steps on (5,5)
];
const TALK_POCKET: Tile = { x: 5, y: 4 };
/** KeyT retries: each attempt first POLLS (bounded waitForFunction, no fixed
 *  sleeps) until an NPC is in range, then presses KeyT once. A press can still
 *  lose the race (the NPC moves up to 1 tile/200ms between the poll and the
 *  server-side range check), so we bound retries: from the pocket (5,4), 6 of the
 *  ~8 reachable wander tiles are in range → in-range holds most of the time and
 *  the per-press success probability is high; 20 attempts is a generous ceiling. */
const MAX_TALK_ATTEMPTS = 20;
/** Advance retries: a rejected advance (NPC wandered > TALK_RANGE between talk and
 *  click) DELETES the row without applying effects; we re-talk and re-click.
 *  Re-talking is safe precisely because a rejected advance never fired
 *  StartQuest — quest_001 only completes on a talk AFTER it was started. */
const MAX_ADVANCE_ATTEMPTS = 8;

/** One step + bounded wait for the authoritative tile to change. The path is
 *  grass-free by construction, so a battle here means the map changed — fail loud
 *  with a pointer at the path derivation instead of a mysterious timeout. */
async function stepOne(p: Page, dir: string, from: Tile): Promise<void> {
  await p.evaluate(
    (d) => (window as unknown as { __game: () => { step: (x: string) => void } }).__game().step(d),
    dir,
  );
  const result = await p.waitForFunction(
    (args: { fromX: number; fromY: number }) => {
      const g = (window as unknown as { __game: () => DialogueSnap }).__game();
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
      `dialogue.spec walk: unexpected wild battle stepping ${dir} from (${from.x},${from.y}) — ` +
        'WALK_PATH is grass-free by construction; re-derive it from zone_maps/000-core.ron',
    );
  }
}

/** Press KeyT (the real talk key — implementer contract above) until the dialogue
 *  overlay opens. Poll-based: each attempt waits until some non-player character
 *  is within TALK_RANGE of the own authoritative tile before pressing. */
async function talkUntilOpen(p: Page, playerEntityIds: readonly string[]): Promise<void> {
  const overlay = p.locator('#dialogue-overlay');
  for (let attempt = 0; attempt < MAX_TALK_ATTEMPTS; attempt++) {
    await p.waitForFunction(
      (args: { ownIds: readonly string[]; range: number }) => {
        const g = (window as unknown as { __game: () => DialogueSnap }).__game();
        const own = g.ownAuthTile;
        if (own === null) return false;
        // NPC = any character that is neither player's own entity (exact-presence
        // discipline: this suite owns the whole 2-player world under workers:1).
        return g.characters
          .filter((c) => !args.ownIds.includes(c.entityId))
          .some((c) => Math.abs(c.tileX - own.x) + Math.abs(c.tileY - own.y) <= args.range);
      },
      { ownIds: playerEntityIds, range: TALK_RANGE },
      { timeout: 20_000 },
    );
    await p.keyboard.press('KeyT'); // physical-code form (recruit.spec reviewer L3)
    const opened = await overlay
      .waitFor({ state: 'visible', timeout: 1_500 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
    // Lost the race (NPC stepped out of range before the server processed talk,
    // or the reducer rejected silently) — loop re-polls and re-presses.
  }
  throw new Error(
    `talkUntilOpen: dialogue overlay did not open after ${MAX_TALK_ATTEMPTS} KeyT attempts — ` +
      'is the KeyT talk trigger wired in main.ts (implementer contract in this spec header)?',
  );
}

test.describe
  .serial('M13.5c — dialogue lifecycle through the conversation subscription', () => {
    let browser: Browser;
    let ctxA: BrowserContext;
    let ctxB: BrowserContext;
    let a: Page;
    let b: Page;
    /** Both players' own entity ids — everything else in `characters` is an NPC. */
    let playerEntityIds: string[] = [];

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctxA = await browser.newContext();
      ctxB = await browser.newContext();
      // RUNTIME-ISOLATION LATCH (installed BEFORE B's app scripts run): a sticky
      // flag that latches true if B's #dialogue-overlay EVER becomes visible —
      // "never" is asserted for the whole session, not just at spot checks.
      // Visibility predicate mirrors DialogueView.visible (display !== 'none' &&
      // !== ''); index.html ships the element with inline display:none, so the
      // initial check cannot false-positive. MutationObserver catches the inline
      // style writes dialogueView.render performs; the interval is the belt.
      await ctxB.addInitScript(() => {
        const w = window as unknown as { __mrDialogueEverVisible?: boolean };
        w.__mrDialogueEverVisible = false;
        const arm = (): void => {
          const el = document.getElementById('dialogue-overlay');
          if (!el) {
            setTimeout(arm, 50);
            return;
          }
          const check = (): void => {
            if (el.style.display !== 'none' && el.style.display !== '') {
              w.__mrDialogueEverVisible = true;
            }
          };
          new MutationObserver(check).observe(el, {
            attributes: true,
            attributeFilter: ['style'],
          });
          setInterval(check, 100);
          check();
        };
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', arm);
        } else {
          arm();
        }
      });
      a = await ctxA.newPage();
      b = await ctxB.newPage();
      await a.goto('/');
      await b.goto('/');
      await ready(a);
      await ready(b);
      // Both joined: converge to the exact 2-player presence (golden.spec idiom;
      // workers:1 guarantees no foreign player is connected).
      await a.waitForFunction(
        () => (window as unknown as { __game: () => DialogueSnap }).__game().presenceCount === 2,
        null,
        { timeout: 30_000 },
      );
      await b.waitForFunction(
        () => (window as unknown as { __game: () => DialogueSnap }).__game().presenceCount === 2,
        null,
        { timeout: 30_000 },
      );
      const ga = await snap(a);
      const gb = await snap(b);
      if (ga.ownEntityId === null || gb.ownEntityId === null) {
        throw new Error('beforeAll: own entity ids must be resolved after ready()');
      }
      playerEntityIds = [ga.ownEntityId, gb.ownEntityId];
    });

    test.afterAll(async () => {
      // Clean disconnects: closing the browser tears down both sockets so the
      // next spec file's exact-presence waits converge (workers:1 discipline).
      await browser.close();
    });

    // -------------------------------------------------------------------------
    // Setup walk: deterministic grass-free path to the talk pocket (5,4).
    // -------------------------------------------------------------------------
    test('setup: A walks the grass-free path (1,1)→(5,4) with no battle', async () => {
      test.setTimeout(120_000);
      const start = await snap(a);
      expect(start.ownAuthTile, 'A spawns with an authoritative tile').not.toBeNull();
      expect(start.ownAuthTile).toEqual({ x: 1, y: 1 });
      for (const dir of WALK_PATH) {
        const g = await snap(a);
        if (g.ownAuthTile === null) throw new Error('walk: lost the own authoritative tile');
        await stepOne(a, dir, g.ownAuthTile);
      }
      const done = await snap(a);
      expect(done.ownAuthTile).toEqual(TALK_POCKET);
      // Belt: the grass-free path must not have started an encounter.
      expect(done.ongoingBattle).toBeNull();
    });

    // -------------------------------------------------------------------------
    // Live INSERT net: talk → the owner's subscription hydrates the row → overlay
    // shows the entry node. Kills (post-swap): a view subscription whose inserts
    // never reach the store/overlay (client dark after the transport swap).
    // -------------------------------------------------------------------------
    test('13.5c-5: KeyT talk opens the overlay with the entry-node text; B stays dark', async () => {
      test.setTimeout(120_000);
      await talkUntilOpen(a, playerEntityIds);

      // Entry-node content — EXACT text from content/dialogue_trees/000-core.ron.
      // Kills: a swap that hydrates the wrong node id, or a rowConvert path that
      // mangles currentNodeId (overlay would show '...' — dialogueModel fallback).
      await expect(a.locator('#dialogue-node-text')).toHaveText(
        'The ancient oak spirit greets you.',
      );
      await expect(a.locator('#dialogue-npc-name')).toHaveText('elder_oak');
      await expect(
        a.locator('#dialogue-choices').getByText('I seek a quest.', { exact: true }),
      ).toBeVisible();

      // Isolation spot check (the sticky latch is the full-session net, below):
      // A's conversation row must never render on B.
      await expect(b.locator('#dialogue-overlay')).toBeHidden();
    });

    // -------------------------------------------------------------------------
    // Live DELETE net (+ re-INSERT round trip): Escape → dismiss_dialogue deletes
    // the row → overlay hides; a fresh talk re-opens it. Kills (post-swap): an
    // over-corrected net-effect delete gate that never removes stored rows — the
    // overlay would stay stuck open here.
    // -------------------------------------------------------------------------
    test('13.5c-5: Escape dismiss hides the overlay; re-talk re-opens it', async () => {
      test.setTimeout(120_000);
      const overlay = a.locator('#dialogue-overlay');
      await expect(overlay).toBeVisible(); // precondition from the previous test
      await a.keyboard.press('Escape');
      await expect(overlay).toBeHidden({ timeout: 10_000 });
      // Round trip: the dismissal was a server-side row delete, not a local hide —
      // a fresh talk must be able to re-create and re-hydrate the row.
      await talkUntilOpen(a, playerEntityIds);
      await expect(a.locator('#dialogue-node-text')).toHaveText(
        'The ancient oak spirit greets you.',
      );
    });

    // -------------------------------------------------------------------------
    // Real-choice advance: clicking "I seek a quest." calls advance_dialogue with
    // the real choice idx. TODAY'S CONTENT is single-node (next_node: None), so a
    // SUCCESSFUL advance ends the dialogue: the row is genuinely deleted and the
    // overlay MUST close — that assertion kills a never-remove delete gate
    // post-swap. Effect proof: StartQuest("quest_001") fired ⇔ the quest log
    // shows "quest_001 (step 0)" — this distinguishes a successful advance from a
    // walked-away rejection (which also deletes the row but applies NO effects).
    // The "text changes and overlay stays open" update-pair tooth needs a
    // multi-node tree — see DOCUMENTED CONTENT GAP in the header; its trap is
    // unit-gated in viewDelete.test.ts.
    // -------------------------------------------------------------------------
    test('13.5c-5: advancing via the real choice applies its effect and ends the dialogue', async () => {
      test.setTimeout(300_000);
      const overlay = a.locator('#dialogue-overlay');
      const questLog = a.locator('#quest-log-overlay');
      let advanced = false;

      for (let attempt = 0; attempt < MAX_ADVANCE_ATTEMPTS && !advanced; attempt++) {
        if (!(await overlay.isVisible())) {
          // Safe to re-talk: a REJECTED advance never fires StartQuest, and
          // quest_001's Talk step can only complete AFTER the quest started.
          await talkUntilOpen(a, playerEntityIds);
        }
        await a
          .locator('#dialogue-choices')
          .getByText('I seek a quest.', { exact: true })
          .click({ timeout: 5_000 });
        // Both outcomes delete the row (success: next_node None ends the
        // dialogue; reject: walked_away) — the overlay must hide either way.
        await expect(overlay).toBeHidden({ timeout: 10_000 });
        // Distinguish success via the quest-log UI signal (KeyQ is guarded on
        // "no other overlay visible" — the dialogue overlay is hidden here).
        await a.keyboard.press('KeyQ');
        advanced = await a
          .waitForFunction(
            () => {
              const list = document.getElementById('quest-log-list');
              return list !== null && (list.textContent ?? '').includes('quest_001');
            },
            null,
            { timeout: 5_000 },
          )
          .then(() => true)
          .catch(() => false);
        if (advanced) {
          // Exact li text while the log is open — kills a stepIndex mismapping
          // (StartQuest creates the row at stepIndex 0) and a displayName drift.
          await expect(a.locator('#quest-log-list li').filter({ hasText: 'quest_001' })).toHaveText(
            'quest_001 (step 0)',
          );
        }
        await a.keyboard.press('Escape'); // close the quest log either way
        await expect(questLog).toBeHidden({ timeout: 5_000 });
      }

      expect(
        advanced,
        `advance did not apply within ${MAX_ADVANCE_ATTEMPTS} attempts (every attempt ` +
          'was rejected as walked_away, or the choice click never reached advance_dialogue)',
      ).toBe(true);
      // The single-node dialogue is over: genuine delete ⇒ overlay closed.
      await expect(overlay).toBeHidden();
    });

    // -------------------------------------------------------------------------
    // Runtime isolation net (red-team fold): B — connected for the WHOLE session
    // spanning A's talk / dismiss / re-talk / advance — must never have rendered
    // a dialogue overlay. The sticky latch (installed pre-load) catches even a
    // transient flash between assertions; the typeof check makes a silently
    // uninstalled latch FAIL instead of vacuously passing.
    // -------------------------------------------------------------------------
    test('13.5c-5 isolation: B never rendered a dialogue overlay at any point', async () => {
      const latch = await b.evaluate(
        () => (window as unknown as { __mrDialogueEverVisible?: unknown }).__mrDialogueEverVisible,
      );
      expect(typeof latch, 'isolation latch must be installed (anti-vacuity)').toBe('boolean');
      expect(latch, "B's #dialogue-overlay became visible during A's session").toBe(false);
      await expect(b.locator('#dialogue-overlay')).toBeHidden();
    });
  });
