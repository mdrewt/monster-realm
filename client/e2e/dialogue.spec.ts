import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { readWasmU32Constant } from '../test-util/wasmPkg';
import {
  type Dir,
  interactChip,
  interactWithNpc,
  pressAccel,
  WANDER_NPC_MAX_ATTEMPTS,
  WANDER_OPEN_WAIT_MS,
  WANDER_TALK_BUDGET_MS,
} from './controls';

// M13.5c dialogue lifecycle e2e.
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
// POST-SWAP TEETH (which wrong implementation each test kills):
//   - "talk opens overlay": a connection.ts swap that subscribes to the view but
//     never hydrates its inserts (overlay never opens — client dark).
//   - "dismiss hides" + "advance ends dialogue": an over-corrected net-effect
//     delete gate that never removes (always-false shouldRemoveOnViewDelete) —
//     genuine deletes would leave the overlay stuck open. (The opposite failure,
//     naive always-remove, is killed at unit level: viewDelete.test.ts.)
//   - "B never renders the overlay": an unfiltered view leaking A's row to B
//     combined with any client keying that surfaces it — end-to-end silence is
//     asserted via a sticky MutationObserver latch, not spot checks.
//   - "re-talking completes quest_001" (qf-6, QF6.4): the silent quest-completion
//     row delete — the status line must acknowledge the quest and its 50 gold.
//   - "a reply after walking away ends the conversation" (qf-6, QF6.1 + QF6.2):
//     the delete-then-Err wedge (the refused advance's delete rolled back, the
//     overlay stuck open forever) and the raw "advance: walked too far away" line.
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
//     one decision a second since qf-5 (game-core npc_decide gated by NPC_STEP_TICKS = 5,
//     a 1-in-5 stay), Manhattan <= 2 of home.
//   - Entry node text "The ancient oak spirit greets you."; npcName renders as
//     the npcId "elder_oak"; choice text "I seek a quest."
//     with effects [StartQuest("quest_001")].
//   - quest_001 starts at stepIndex 0; the quest log li renders
//     "quest_001 (step 0)" (questLogModel displayName = questId verbatim;
//     questLogView li `${displayName} (step ${stepIndex})`).
//   - TALK_RANGE = 2 Manhattan. advance_dialogue RE-CHECKS zone+range
//     and refuses on failure ("walked too far away", RT-ADV-01 fix). A refusal
//     writes nothing: the conversation row stays server-side, and the client
//     shows the catalogued reason on #status and sends dismiss_dialogue, whose
//     delete closes the overlay (qf-6). The bounded retry loops below exist
//     because the NPC wanders between conversations (qf-5 holds him still only
//     while a conversation references him).
//   - Player spawn (1,1), zone 0. Zone-0 map (content/zone_maps/000-core.ron):
//     grass at (2,2),(3,2),(8,2),(8,3),(3,4),(4,4),(8,4),(7,5),(8,5); interior
//     walls (4,3),(5,3); WARP TILE at (5,5)→zone 1 — the walk must NEVER step on
//     (5,5). (That sentence predates qf-15, which moved the warp to (1,5); it is
//     left as written until wap-8, which edits the line above it, has merged. The
//     walk steps on neither tile.) Grass-free path (1,1)→(4,5): S,S,E,S,S,E,E —
//     every tile entered is floor, so NO encounter can start (encounters roll only
//     on stepping onto grass) and no Escape battle-dismiss latch is needed.
//   - ctl-10a: T retired — A talks to what the character FACES (the tile in front,
//     else the own tile; game-core interact_candidates). THE TALK POST is (4,5)
//     FACING EAST, reached by the final E step from (3,5) (a step always sets the
//     facing, game-core world.rs apply_move). It reaches the elder on TWO tiles of
//     his wander disc (npc_decide: walkable AND Manhattan <= 2 of (5,5) — the disc
//     is (5,5),(5,4),(6,4),(4,4),(4,5),(6,5),(3,5),(7,5)): the faced tile (5,5),
//     his home, and the post (4,5) itself, where he and A share a tile (characters
//     never block each other, and with nothing on the faced tile the rule offers
//     the own tile). He stands on one of the two 43% of the time, so a talk waits
//     1.7 s on average (controls.ts WANDER_NPC_WAIT_MS has the measurement; a
//     post that reaches one corner tile waits 39 s). A is pressed only while he
//     is on one of them (controls.ts interactWithNpc). Two more of his steps are
//     needed to leave TALK_RANGE of (4,5) — only (6,4) and (7,5) are out of it —
//     so the server's talk range re-check holds, and a conversation, once open,
//     pins him in range (qf-5). The zone-1 shopkeeper (8,1) can never appear on
//     (4,5) or (5,5), so the zone-less __game().characters cannot fool the poll.

interface Tile {
  x: number;
  y: number;
}

interface DialogueSnap {
  identity: string;
  ownEntityId: string | null;
  ownAuthTile: Tile | null;
  presenceCount: number;
  characters: { entityId: string; tileX: number; tileY: number; facing: Dir }[];
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

/** Grass-free, warp-free path spawn (1,1) → the talk post (4,5); see WORLD FACTS.
 *  It ends with an East step, which leaves the character facing the elder's home (5,5). */
const WALK_PATH: readonly string[] = [
  'South', // (1,2)
  'South', // (1,3)
  'East', // (2,3)
  'South', // (2,4)
  'South', // (2,5) — beside the warp (1,5), NEVER on it
  'East', // (3,5)
  'East', // (4,5) — facing East, toward (5,5)
];
const TALK_POST: Tile = { x: 4, y: 5 };
const TALK_FACING: Dir = 'East';
/** Grass-free walk from the talk post to a tile out of TALK_RANGE of EVERY tile of the
 *  elder's disc (the nearest, (3,5) and (4,4), are Manhattan 3 away), so wherever he
 *  wanders once A has left, a reply sent from there is refused. */
const WALK_AWAY_PATH: readonly string[] = [
  'West', // (3,5)
  'West', // (2,5)
  'North', // (2,4)
  'North', // (2,3)
];
const AWAY_TILE: Tile = { x: 2, y: 3 };
/** A-press retries (ctl-10a: T retired). Each attempt first POLLS (bounded, no
 *  fixed sleeps) until elder_oak stands on the faced tile (5,5) or on the post
 *  (4,5), then presses A once. A press can still lose the race (he steps about
 *  once a second since qf-5, between the poll and the keydown), so attempts are
 *  bounded; controls.ts WANDER_NPC_MAX_ATTEMPTS has the arithmetic. Every test
 *  that may talk runs under TALK_TEST_TIMEOUT_MS. */
const MAX_TALK_ATTEMPTS = WANDER_NPC_MAX_ATTEMPTS;
/** One worst-case talk (WANDER_TALK_BUDGET_MS, 184 s) plus 120 s for the test's own round
 *  trips and reads: 304 s. */
const TALK_TEST_TIMEOUT_MS = WANDER_TALK_BUDGET_MS + 120_000;
/** Advance retries: a refused advance (the parties > TALK_RANGE apart between talk
 *  and click) applies no effects and keeps the row server-side; the client answers
 *  it with dismiss_dialogue, whose delete closes the overlay; we re-talk and
 *  re-click. Re-talking is safe precisely because a refused advance never fired
 *  StartQuest — quest_001 only completes on a talk AFTER it was started. */
const MAX_ADVANCE_ATTEMPTS = 8;
/** game-core TALK_RANGE, read from the wasm boundary (the built client-wasm pkg's `talk_range()`
 *  export), never copied: the Manhattan distance within which talk and advance are admitted. */
const TALK_RANGE = readWasmU32Constant('talk_range');

/** Manhattan distance between a character row and a tile. */
const manhattan = (c: { tileX: number; tileY: number }, t: Tile): number =>
  Math.abs(c.tileX - t.x) + Math.abs(c.tileY - t.y);

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

/** ctl-10a: T retired — press A (controls.ts pressButton) with elder_oak in reach
 *  until the dialogue overlay opens. interactWithNpc asserts the post (4,5) and the
 *  East facing before every press, and presses only while a non-player character
 *  (NPC = neither player's own entity: this suite owns the whole 2-player world
 *  under workers:1) stands on the faced tile (5,5) or on the post, and the chip
 *  names him. It throws after MAX_TALK_ATTEMPTS attempts that opened nothing. */
async function talkUntilOpen(p: Page, playerEntityIds: readonly string[]): Promise<void> {
  await interactWithNpc(p, {
    stand: TALK_POST,
    facing: TALK_FACING,
    opened: p.locator('#dialogue-overlay'),
    ignoreEntityIds: playerEntityIds,
    chip: interactChip('Talk', 'elder_oak'),
    maxAttempts: MAX_TALK_ATTEMPTS,
    openWaitMs: WANDER_OPEN_WAIT_MS,
    label: 'dialogue.spec talkUntilOpen',
  });
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
    // Setup walk: deterministic grass-free path to the talk post (4,5), facing
    // East (ctl-10a: T retired — A acts on the faced tile, see WORLD FACTS).
    // -------------------------------------------------------------------------
    test('setup: A walks the grass-free path (1,1)→(4,5) with no battle, facing East', async () => {
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
      expect(done.ownAuthTile).toEqual(TALK_POST);
      // Belt: the grass-free path must not have started an encounter.
      expect(done.ongoingBattle).toBeNull();
      // ctl-10a: the last step (East) is what aims A at (5,5).
      const ownRow = done.characters.find((c) => c.entityId === done.ownEntityId);
      expect(ownRow?.facing, 'the arriving East step faces the talk tile (5,5)').toBe(TALK_FACING);
    });

    // -------------------------------------------------------------------------
    // Live INSERT net: talk → the owner's subscription hydrates the row → overlay
    // shows the entry node. Kills (post-swap): a view subscription whose inserts
    // never reach the store/overlay (client dark after the transport swap).
    // -------------------------------------------------------------------------
    // ctl-10a: T retired — the talk is A, with the elder on the faced tile or the own tile.
    test('13.5c-5: A (elder_oak in reach) opens the overlay with the entry-node text; B stays dark', async () => {
      test.setTimeout(TALK_TEST_TIMEOUT_MS);
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
      test.setTimeout(TALK_TEST_TIMEOUT_MS);
      const overlay = a.locator('#dialogue-overlay');
      await expect(overlay).toBeVisible(); // precondition from the previous test
      await a.keyboard.press('Escape');
      // 20 s: dismiss_dialogue fires a server-side row delete whose subscription
      // propagation can exceed 10 s under CI load (same mechanism as the advance path).
      await expect(overlay).toBeHidden({ timeout: 20_000 });
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
    // walked-away refusal (which applies NO effects and keeps the row server-side;
    // the client's dismiss_dialogue then ends the conversation).
    // The "text changes and overlay stays open" update-pair tooth needs a
    // multi-node tree — see DOCUMENTED CONTENT GAP in the header; its trap is
    // unit-gated in viewDelete.test.ts.
    // -------------------------------------------------------------------------
    test('13.5c-5: advancing via the real choice applies its effect and ends the dialogue', async () => {
      test.setTimeout(TALK_TEST_TIMEOUT_MS);
      const overlay = a.locator('#dialogue-overlay');
      const questLog = a.locator('#quest-log-overlay');
      let advanced = false;

      for (let attempt = 0; attempt < MAX_ADVANCE_ATTEMPTS && !advanced; attempt++) {
        if (!(await overlay.isVisible())) {
          // Safe to re-talk: a REJECTED advance never fires StartQuest, and
          // quest_001's Talk step can only complete AFTER the quest started.
          await talkUntilOpen(a, playerEntityIds);
        }
        // No wait for the elder here: the talk was admitted within TALK_RANGE of
        // him, and qf-5 pins him there for as long as the conversation is open and
        // A stays on the post, so the server's walked_away re-check holds.
        await a
          .locator('#dialogue-choices')
          .getByText('I seek a quest.', { exact: true })
          .click({ timeout: 5_000 })
          .catch(() => {
            // The overlay can vanish between the isVisible() check and the click
            // when a PREVIOUS attempt's slow row-delete finally propagates. That
            // is not a failure — the hidden-wait below picks the flow back up.
          });
        // Both outcomes end the conversation (success: next_node None deletes
        // the row; a walked-away refusal keeps the row server-side and the
        // client's dismiss_dialogue deletes it) — the overlay must hide either way.
        // Deflake (2026-07-15, flaked twice at 20 s on GHA): subscription
        // propagation has a long tail under CI load. A slow attempt is treated as
        // a FAILED attempt (continue) instead of failing the whole test — the
        // never-remove-delete tooth is preserved by the post-loop assertions:
        // `advanced` must become true within MAX_ADVANCE_ATTEMPTS and the overlay
        // must be hidden at the end, so a genuinely stuck delete still fails.
        const hidden = await overlay
          .waitFor({ state: 'hidden', timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        if (!hidden) continue;
        // Distinguish success via the quest-log UI signal. ctl-11a: Q is LB now; J opens
        // the Journal through the main menu (stack [world, menuView, questLogView]) and
        // is denied while a dialogue frame is still the top of the stack, so wait (bounded,
        // no sleep) for the stack to be the bare world first; a slow one is a FAILED attempt.
        const worldBack = await a
          .waitForFunction(
            () =>
              (window as unknown as { __game: () => { stack: unknown[] } }).__game().stack
                .length === 1,
            null,
            { timeout: 5_000 },
          )
          .then(() => true)
          .catch(() => false);
        if (!worldBack) continue;
        await pressAccel(a, 'J');
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
    // Quest completion is acknowledged (qf-6, QF6.4). quest_001, started by the
    // advance above, is ONE Talk step at the elder, so the next talk completes it:
    // that transaction deletes the player_quest row, credits the 50-gold reward
    // and opens the conversation. The status line must name the quest and the
    // gold. Kills: the silent row delete (the reward goes unseen), a line without
    // the amount, and the new balance reported instead of the gain.
    // The conversation this talk opens is left open for the next test.
    // -------------------------------------------------------------------------
    test('UIF4.2 re-talking the elder completes quest_001 and the toast acknowledges its 50 gold above the open dialogue frame', async () => {
      test.setTimeout(TALK_TEST_TIMEOUT_MS);
      // uif-4 (UIF4.2): a recorder armed BEFORE the talk captures, in the very microtask after the
      // toast un-hides (the same synchronous batch that opens the dialogue), the dialogue frame's
      // rect and a hit test at the toast's centre. pointer-events:none makes hit-testing skip the
      // toast, so the recorder flips it to `auto` inside that one callback and restores it;
      // pointer-events does not change paint order, so a hit inside #toast proves it paints above
      // the open frame. Nothing is awaited between the un-hide and the read.
      await a.evaluate(() => {
        const toast = document.getElementById('toast');
        if (toast === null) throw new Error('#toast must exist');
        const w = window as unknown as { __mrUif4Toast?: unknown };
        w.__mrUif4Toast = null;
        new MutationObserver(() => {
          if (toast.hidden || w.__mrUif4Toast !== null) return;
          const dlg = document.getElementById('dialogue-overlay');
          const d = dlg === null ? null : dlg.getBoundingClientRect();
          const prior = toast.style.pointerEvents;
          toast.style.pointerEvents = 'auto';
          const r = toast.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          toast.style.pointerEvents = prior;
          w.__mrUif4Toast = {
            dialogueRect: d === null ? null : { x: d.x, y: d.y, width: d.width, height: d.height },
            toastRect: { x: r.x, y: r.y, width: r.width, height: r.height },
            hitInToast: hit !== null && toast.contains(hit),
            hit: hit === null ? 'null' : `${hit.tagName}#${hit.id}.${hit.className}`,
          };
        }).observe(toast, { attributes: true, attributeFilter: ['hidden'] });
      });
      await talkUntilOpen(a, playerEntityIds);
      // uif-4 (named intentional change, UIF4.2): quest-complete is a toast kind, so the line is
      // read off #toast (was #status), and the status line stays empty.
      await expect(a.locator('#toast')).toHaveText(
        'Quest complete: quest_001. You received 50 gold.',
        { timeout: 20_000 },
      );
      await expect(a.locator('#status')).toHaveText('');
      await expect(a.locator('#dialogue-overlay')).toBeVisible();
      const seen = await a.evaluate(
        () => (window as unknown as { __mrUif4Toast?: unknown }).__mrUif4Toast,
      );
      const rec = seen as {
        dialogueRect: { x: number; y: number; width: number; height: number } | null;
        toastRect: { x: number; y: number; width: number; height: number };
        hitInToast: boolean;
        hit: string;
      } | null;
      expect(rec, 'the recorder saw the toast un-hide').not.toBeNull();
      if (rec === null || rec.dialogueRect === null) throw new Error('recorder missed the frame');
      expect(
        rec.hitInToast,
        `UIF4.2: the toast is the top hit at its centre over the open frame (hit: ${rec.hit})`,
      ).toBe(true);
      const overlaps =
        rec.toastRect.x < rec.dialogueRect.x + rec.dialogueRect.width &&
        rec.toastRect.x + rec.toastRect.width > rec.dialogueRect.x &&
        rec.toastRect.y < rec.dialogueRect.y + rec.dialogueRect.height &&
        rec.toastRect.y + rec.toastRect.height > rec.dialogueRect.y;
      expect(
        overlaps,
        'UIF4.2: the toast rect overlaps the open dialogue frame (not vacuous)',
      ).toBe(true);
      // Nothing moved: once the toast has expired, the frame's rect is exactly what it was while
      // the toast showed (the toast is out of flow).
      await expect(a.locator('#toast')).toBeHidden({ timeout: 15_000 });
      const after = await a.evaluate(() => {
        const el = document.getElementById('dialogue-overlay');
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      expect(after, 'UIF4.2: the frame did not move when the toast went away').toEqual(
        rec.dialogueRect,
      );
    });

    // -------------------------------------------------------------------------
    // Walked away, then a reply (qf-6, QF6.1 + QF6.2). With the conversation open,
    // A walks out of talk range and only then chooses "I seek a quest.".
    // advance_dialogue refuses ("walked too far away") and writes nothing; the
    // client shows the catalogued reason and sends dismiss_dialogue, whose
    // server-side delete closes the overlay. The client never hides a dialogue
    // itself, so the overlay closing proves the dismissal persisted. Kills: the
    // delete-then-Err wedge (the overlay stays open forever), the raw
    // "advance: walked too far away" line, and a client-side range check that
    // ends the conversation before any reply is chosen (the overlay must still be
    // open after the walk).
    // -------------------------------------------------------------------------
    test('choosing a reply after walking out of talk range ends the conversation with its reason and closes the overlay', async () => {
      test.setTimeout(TALK_TEST_TIMEOUT_MS);
      const overlay = a.locator('#dialogue-overlay');
      if (!(await overlay.isVisible())) await talkUntilOpen(a, playerEntityIds);
      await expect(overlay).toBeVisible();

      // The elder: the one non-player character within TALK_RANGE of the post, read
      // BEFORE the walk. qf-5 holds him still while the conversation references him;
      // he is usually on the faced tile (5,5) or on the post (4,5), and a talk that
      // landed just after he stepped off them leaves him one step away, still in
      // range. The zone-1 shopkeeper at (8,1) is Manhattan 8 from the post, so the
      // zone-less list cannot offer him here.
      const posted = await snap(a);
      expect(posted.ownAuthTile, 'A is on the talk post').toEqual(TALK_POST);
      const inRange = posted.characters.filter(
        (c) => !playerEntityIds.includes(c.entityId) && manhattan(c, TALK_POST) <= TALK_RANGE,
      );
      expect(
        inRange.map((c) => `${c.entityId}@(${c.tileX},${c.tileY})`),
        'exactly one non-player character (the elder) is within talk range of the post',
      ).toHaveLength(1);
      const [elder] = inRange;
      if (elder === undefined) throw new Error('unreachable: one elder was asserted above');

      // Back along the walk: (4,5) → (3,5) → (2,5) → (2,4) → (2,3).
      for (const dir of WALK_AWAY_PATH) {
        const g = await snap(a);
        if (g.ownAuthTile === null) throw new Error('walk away: lost the own authoritative tile');
        await stepOne(a, dir, g.ownAuthTile);
      }
      const away = await snap(a);
      expect(away.ownAuthTile, 'A walked back to (2,3)').toEqual(AWAY_TILE);
      if (away.ownAuthTile === null) throw new Error('walk away: lost the own authoritative tile');
      const elderNow = away.characters.find((c) => c.entityId === elder.entityId);
      expect(elderNow, 'the elder is still listed').toBeDefined();
      if (elderNow === undefined) throw new Error('unreachable: the elder was asserted above');
      expect(
        manhattan(elderNow, away.ownAuthTile),
        'A is out of talk range of THIS elder (never measured to all characters: zone-less)',
      ).toBeGreaterThanOrEqual(TALK_RANGE + 1);
      await expect(overlay, 'walking away ends nothing by itself').toBeVisible();

      await a
        .locator('#dialogue-choices')
        .getByText('I seek a quest.', { exact: true })
        .click({ timeout: 5_000 });
      // uif-4 (named intentional change, UIF4.2): dialogue-ended is a toast kind, so the reason is
      // read off #toast (was #status).
      const status = a.locator('#toast');
      await expect(status).toHaveText('Conversation ended: you moved too far away.', {
        timeout: 20_000,
      });
      await expect(status).not.toContainText('advance:');
      await expect(overlay).toBeHidden({ timeout: 20_000 });
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
