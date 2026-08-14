import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// 14r-e movement-input e2e (ADR-0187, closing ADR-0158 residuals 3 + 4).
//
// WHAT MAKES THIS FILE DIFFERENT FROM EVERY OTHER SPEC IN client/e2e/:
// it drives movement with SYNTHETIC KEYBOARD EVENTS (page.keyboard.down/up), so main.ts's
// real keydown handler, its real `held` state and its real rAF frame body all execute
// (EARS-2). Every pre-existing spec moves the character via `__game().step(dir)`, which
// bypasses `held` entirely (ADR-0158 residual 9) and therefore cannot regress from — nor
// prove anything about — the held-key continuation gates. ADR-0158 residual 4 recorded
// that gap explicitly: "no test executes main.ts's frame body", which left a class of
// mutants alive that no source scan and no discrete-event sim can see (a `|| true` folded
// into a continuation guard; a second ungated emitter outside the scanned region).
//
// THE FOUR SCENARIOS AND WHAT EACH ONE IS FOR:
//   A  GREEN GUARD  single-code taps -> exactly 1 tile. Passes on the pre-fix tree; it is a
//                   runtime mutant-guard for `committedActive` -> `active` reverts and
//                   HOLD_COMMIT_MS -> 0, NOT a defect tooth. (Labelled per the
//                   W-NH2-NO-CANCEL precedent: mislabelling a green guard as RED is itself
//                   a defect.)
//   B  RED PROOF    dual-code overlap tap -> exactly 1 tile. THE slice defect (EARS-1).
//                   RED against the current tree, which fires `step(dir)` on EVERY keydown
//                   and therefore moves 2 tiles for one physical two-code tap.
//   C  GREEN GUARD  a hold FREEZES under an overlay and RESUMES after it closes. Kills the
//                   whole-gate `|| true` fold, which no source scan can see.
//   D  RED TODAY    a sustained hold stays inside a send budget and is never rejected.
//                   Red now because the snapshot counters do not exist yet; post-fix it is
//                   the only tooth that kills the narrow `&& true ||` outstandingSteps
//                   mutant, because ADR-0148 MEASURED the reject-storm world at unchanged
//                   5.00 tiles/s — tile positions cannot separate the two worlds, only a
//                   send-budget observable can.
//
// WORLD FACTS THIS SUITE DEPENDS ON (all re-asserted at runtime by corridorEastWest, which
// throws loudly rather than skipping): zone 0 row y=1 is "#........#" — a grass-free
// corridor, walkable x=1..8, walls at x=0 and x=9. Spawn is (1,1) (game-core world.rs).
// STEP_MS is read from the hook, never hard-coded. The server drains one queued step per
// movement_tick, so travel is paced at STEP_MS regardless of client send rate.
//
// NO BigInt crosses page.evaluate (structured-clone boundary) — this spec reads only
// numbers, strings and booleans off the snapshot.

interface Tile {
  x: number;
  y: number;
}

/** The RAW zone map as main.ts exposes it (client/src/render/map.ts RawTileMap): both
 *  layers are row-major `bool[]` indexed `y * width + x`. */
interface RawMap {
  zone_id: number;
  width: number;
  height: number;
  walkable: boolean[];
  grass: boolean[];
}

interface Snap {
  identity: string;
  stepMs: number;
  map: RawMap;
  ownAuthTile: Tile | null;
  ownPredictedTile: Tile | null;
  /** 14r-e DEV observability counters (ADR-0187 (b)). DELIBERATELY OPTIONAL: they DO NOT
   *  EXIST on the pre-implementation snapshot, and scenario D's `typeof === 'number'`
   *  assertion is the RED proof of exactly that. */
  moveSendCount?: number;
  moveRejectCount?: number;
}

/** One recorded synthetic key event, from the in-page recorder installed in beforeAll.
 *  MEASUREMENT ONLY — never a behaviour assertion. It exists so a tap that the harness
 *  accidentally stretched past the contract band can be RETRIED instead of scored. */
interface KeyEvt {
  code: string;
  type: 'keydown' | 'keyup';
  t: number;
}

/** ADR-0158's contract band: a press of <= 140ms is a TAP and must move exactly one tile
 *  at every fps and tick phase. (150, 240) ms is the declared indeterminate band, so a
 *  synthetic "tap" that overran 140ms proves nothing either way. */
const TAP_BUDGET_MS = 140;
/** The zone-0 corridor row every scenario measures along. */
const CORRIDOR_Y = 1;
/** Retries allowed per rep — and ONLY for an over-long measured press (see the retry rule
 *  at each call site). A within-budget rep with a wrong tile count fails immediately.
 *  5, not 3: CI run 31806079496 attempt 1 exhausted 3 attempts on a loaded 4-vCPU runner
 *  whose waitForTimeout overshoot alone ate scenario B's headroom. More attempts do not
 *  weaken the teeth — only harness-overrun reps are ever retried. */
const MAX_ATTEMPTS = 5;

/** STEP_MS, read from the hook in beforeAll (never hard-coded — golden.spec.ts idiom). */
let stepMs = 200;

const snap = (p: Page): Promise<Snap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => Snap }).__game();
    // Strip the methods; keep only serializable state (the `step`/`jump`/`setRawMapZone…`
    // fields on the hook cannot cross the structured-clone boundary).
    return {
      identity: g.identity,
      stepMs: g.stepMs,
      map: g.map,
      ownAuthTile: g.ownAuthTile,
      ownPredictedTile: g.ownPredictedTile,
      moveSendCount: g.moveSendCount,
      moveRejectCount: g.moveRejectCount,
    };
  });

// DUPLICATED LOCALLY on purpose — the 8-file convention in client/e2e/: every spec carries
// its own ready(), never importing from a sibling spec.
async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => Snap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

/** Wait until prediction agrees with authority, then PROVE it stayed that way. The second
 *  half is load-bearing: a convergence observed mid-flight (between a drain and the next
 *  authoritative batch) un-converges a moment later, and every displacement measurement in
 *  this file would then be taken against a moving character. Fails LOUD, never skips. */
async function converged(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const g = (window as unknown as { __game: () => Snap }).__game();
      const a = g.ownAuthTile;
      const q = g.ownPredictedTile;
      return a !== null && q !== null && a.x === q.x && a.y === q.y;
    },
    null,
    { timeout: 15_000 },
  );
  await p.waitForTimeout(250);
  const s = await snap(p);
  expect(
    s.ownAuthTile,
    'the own authoritative tile must be live before a scenario runs',
  ).not.toBeNull();
  expect(
    s.ownPredictedTile,
    'prediction must be SETTLED on the authoritative tile before a scenario runs — a still- ' +
      'moving character makes every displacement measurement below meaningless',
  ).toEqual(s.ownAuthTile);
}

async function tile(p: Page): Promise<Tile> {
  const s = await snap(p);
  const t = s.ownAuthTile;
  if (t === null) {
    throw new Error('__game().ownAuthTile is null — the own character row is not live');
  }
  return t;
}

/** LOUD precondition (never a silent skip): the character is standing in the zone-0 y=1
 *  east/west corridor, inside [minX, maxX], and every tile of that window is walkable and
 *  grass-free in the LIVE map. Grass matters: a wild encounter would open the battle
 *  overlay mid-scenario and freeze movement, producing a flake that looks exactly like the
 *  defect under test. */
async function corridorEastWest(p: Page, minX: number, maxX: number): Promise<Tile> {
  const s = await snap(p);
  const t = s.ownAuthTile;
  if (t === null) {
    throw new Error('corridor precondition: ownAuthTile is null — the character row is not live');
  }
  if (t.y !== CORRIDOR_Y) {
    throw new Error(
      `corridor precondition: the character is at y=${t.y}, but this suite measures east/west ` +
        `displacement along the zone-0 y=${CORRIDOR_Y} corridor only`,
    );
  }
  if (t.x < minX || t.x > maxX) {
    throw new Error(
      `corridor precondition: x=${t.x} is outside the required [${minX}, ${maxX}] window — a ` +
        'scenario starting too near a wall would measure a wall bump, not a step',
    );
  }
  for (let x = minX; x <= maxX; x += 1) {
    const i = CORRIDOR_Y * s.map.width + x;
    if (s.map.walkable[i] !== true) {
      throw new Error(
        `corridor precondition: (${x}, ${CORRIDOR_Y}) is NOT walkable in the live zone map — ` +
          'the corridor this suite assumes no longer exists; re-derive the window from the map',
      );
    }
    if (s.map.grass[i] === true) {
      throw new Error(
        `corridor precondition: (${x}, ${CORRIDOR_Y}) is GRASS in the live zone map — a wild ` +
          'encounter would open the battle overlay mid-scenario and freeze movement, which is ' +
          'indistinguishable from the defect under test',
      );
    }
  }
  return t;
}

/** SETUP ONLY. `__game().step()` bypasses `held` entirely (ADR-0158 residual 9), so it can
 *  prove NOTHING about keyboard input — it is used here purely to park the character in a
 *  known column before a keyboard-driven scenario begins. Steps are spaced 1.5x STEP_MS so
 *  each one is fully drained before the next is issued. */
async function recenter(p: Page, targetX: number): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const t = await tile(p);
    if (t.x === targetX) break;
    const dir = t.x < targetX ? 'East' : 'West';
    await p.evaluate((d: string) => {
      (window as unknown as { __game: () => { step: (x: string) => void } }).__game().step(d);
    }, dir);
    await p.waitForTimeout(Math.round(stepMs * 1.5));
  }
  await converged(p);
  const t = await tile(p);
  expect(t.x, `recenter(${targetX}) must actually reach column ${targetX} within 12 steps`).toBe(
    targetX,
  );
  expect(t.y, 'recenter must never leave the y=1 corridor').toBe(CORRIDOR_Y);
}

async function resetKeyLog(p: Page): Promise<void> {
  await p.evaluate(() => {
    (window as unknown as { __keyTimes: KeyEvt[] }).__keyTimes.length = 0;
  });
}

/** The ACTUAL press duration the page observed, first keydown -> last keyup. Used ONLY to
 *  decide whether a rep is scoreable (see TAP_BUDGET_MS); never asserted on as behaviour. */
async function measuredPressMs(p: Page): Promise<number> {
  const evts = await p.evaluate(() =>
    (window as unknown as { __keyTimes: KeyEvt[] }).__keyTimes.slice(),
  );
  const downs = evts.filter((e) => e.type === 'keydown');
  const ups = evts.filter((e) => e.type === 'keyup');
  if (downs.length === 0 || ups.length === 0) {
    throw new Error(
      `the in-page key recorder saw ${downs.length} keydown(s) and ${ups.length} keyup(s) — the ` +
        'page never received the synthetic keys (lost window keyboard focus?), so nothing in ' +
        'this suite is measuring what it claims',
    );
  }
  return ups[ups.length - 1].t - downs[0].t;
}

/** Wait for prediction to re-agree with authority, then hold still for `stabilityMs`.
 *  The waitForFunction timeout is swallowed ON PURPOSE: falling through to the explicit
 *  displacement assertion turns "moved 2 tiles" into a precise expected/received message
 *  instead of an opaque waitForFunction failure. */
async function settle(p: Page, stabilityMs: number): Promise<void> {
  await p
    .waitForFunction(
      () => {
        const g = (window as unknown as { __game: () => Snap }).__game();
        const a = g.ownAuthTile;
        const q = g.ownPredictedTile;
        return a !== null && q !== null && a.x === q.x && a.y === q.y;
      },
      null,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  await p.waitForTimeout(stabilityMs);
}

test.describe
  .serial('14r-e — keyboard-driven movement input (ADR-0187)', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      // The recorder is installed BEFORE navigation so it is armed from the first frame.
      // Capture phase, so it records regardless of what main.ts's own listener does.
      await page.addInitScript(() => {
        const w = window as unknown as { __keyTimes: KeyEvt[] };
        w.__keyTimes = [];
        window.addEventListener(
          'keydown',
          (e) => {
            w.__keyTimes.push({ code: e.code, type: 'keydown', t: performance.now() });
          },
          true,
        );
        window.addEventListener(
          'keyup',
          (e) => {
            w.__keyTimes.push({ code: e.code, type: 'keyup', t: performance.now() });
          },
          true,
        );
      });
      await page.goto('/');
      await ready(page);
      // Guarantee window keyboard focus: page.keyboard dispatches to the focused element, and
      // an unfocused page silently swallows every synthetic key (which would make the whole
      // suite pass or fail for the wrong reason). The click lands on the canvas, which owns
      // no click handler — main.ts delegates only on [data-menu-launcher] / [data-choice-idx].
      await page.mouse.click(400, 200);
      stepMs = (await snap(page)).stepMs;
      expect(stepMs, 'the hook must report the real STEP_MS cadence').toBeGreaterThan(0);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    // -------------------------------------------------------------------------------
    // A — GREEN GUARD (passes pre-fix; a runtime guard, not a defect tooth)
    // -------------------------------------------------------------------------------
    test('A GREEN GUARD: a single-code 90ms tap moves EXACTLY one tile (kills committedActive/HOLD_COMMIT_MS reverts at runtime)', async () => {
      // WRONG IMPL KILLED (1): `held.committedActive(now)` reverted to `held.active()` at
      //   either continuation emitter — the frame after the server's drain snapshot lands
      //   re-issues a step while the tap key is still physically down, and the tap moves 2
      //   tiles. The source scans (W-MVI-COMMITTED-WIRED) see the TEXT of that revert; this
      //   sees the BEHAVIOUR, including revert shapes the scanners cannot spell.
      // WRONG IMPL KILLED (2): HOLD_COMMIT_MS tuned to 0 (or a constructor arg forking it) —
      //   the threshold degenerates to `active()` and the same double-move returns.
      //
      // RETRY RULE (read before changing it): a rep is retried ONLY when the IN-PAGE measured
      // press exceeded TAP_BUDGET_MS, i.e. the harness itself failed to produce a tap. A rep
      // that WAS a tap and moved the wrong number of tiles fails immediately and is never
      // retried — retrying a wrong count is precisely how a suite stops detecting the defect
      // class it exists to catch.
      await recenter(page, 4);
      for (const code of ['ArrowRight', 'ArrowLeft', 'ArrowRight'] as const) {
        const dx = code === 'ArrowRight' ? 1 : -1;
        let scoredAttempt = 0;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          await converged(page);
          const t0 = await corridorEastWest(page, 2, 7);
          await resetKeyLog(page);
          await page.keyboard.down(code);
          await page.waitForTimeout(90);
          await page.keyboard.up(code);
          const pressedMs = await measuredPressMs(page);
          if (pressedMs > TAP_BUDGET_MS) continue; // harness-timing miss — retry, do not score
          const target: Tile = { x: t0.x + dx, y: t0.y };
          await page
            .waitForFunction(
              (want: Tile) => {
                const g = (window as unknown as { __game: () => Snap }).__game();
                const a = g.ownAuthTile;
                const q = g.ownPredictedTile;
                return (
                  a !== null &&
                  q !== null &&
                  a.x === q.x &&
                  a.y === q.y &&
                  a.x === want.x &&
                  a.y === want.y
                );
              },
              target,
              { timeout: 3_000 },
            )
            .catch(() => undefined);
          // Settle: a SECOND tile arriving late is exactly the defect shape, so the count is
          // re-read after the server has had more than two full cadence slots to deliver it.
          await page.waitForTimeout(500);
          const s1 = await snap(page);
          const t1 = s1.ownAuthTile;
          if (t1 === null) throw new Error('own authoritative tile went null mid-scenario');
          expect(
            t1.x - t0.x,
            `a ${Math.round(pressedMs)}ms ${code} tap must move EXACTLY one tile (ADR-0158: taps ` +
              '<= 140ms are contractually one tile at every fps and tick phase). 2 means a ' +
              'continuation fired inside the tap; 0 means the ungated first step was lost',
          ).toBe(dx);
          expect(t1.y, 'a horizontal tap must not change the row').toBe(t0.y);
          expect(
            s1.ownPredictedTile,
            'prediction must be back on authority after the tap — a lingering disagreement is a ' +
              'desync, not a slow frame',
          ).toEqual(t1);
          scoredAttempt = attempt;
          break;
        }
        expect(
          scoredAttempt,
          `every ${code} tap overran ${TAP_BUDGET_MS}ms in all ${MAX_ATTEMPTS} attempts — the ` +
            'harness could not produce a tap inside the contract band, so this scenario measured ' +
            'nothing. Investigate machine load; do NOT widen TAP_BUDGET_MS (150+ is the declared ' +
            'indeterminate band, where either outcome is contractual)',
        ).toBeGreaterThan(0);
      }
    });

    // -------------------------------------------------------------------------------
    // B — THE RED PROOF (EARS-1)
    // -------------------------------------------------------------------------------
    test('B RED PROOF: a dual-code overlap tap (ArrowRight+KeyD / ArrowLeft+KeyA) moves EXACTLY one tile — EARS-1', async () => {
      // ★ RED REASON, against the CURRENT tree: main.ts's keydown fires `step(dir)`
      // UNCONDITIONALLY. KEY_DIR binds two codes per direction, so pressing the second code
      // while the direction is already held fires a SECOND ungated first step: two intents,
      // two server drains, 2 tiles from one physical tap. No hold-commit threshold can see
      // it — both steps are keydown-immediate, not continuations — which is why ADR-0158
      // named it (its residual 3) the SOLE remaining same-direction double-move path.
      // After the ADR-0187 dedup (`if (!held.isHeld(dir)) step(dir);`) this is 1 tile.
      //
      // WRONG IMPL KILLED (a): the dedup absent — 2 tiles (today).
      // WRONG IMPL KILLED (b): the dedup written as `held.active() === dir` — survives THIS
      //   scenario (only one dir is held here) but dies at U-DK2 / movementSim S11.
      // WRONG IMPL KILLED (c): the dedup over-applied so the FIRST press stops emitting —
      //   0 tiles, and this same assertion reds from the other side.
      //
      // Same retry rule as scenario A: retry ONLY on an over-long measured press.
      const reps = [
        { c1: 'ArrowRight', c2: 'KeyD', dx: 1 },
        { c1: 'ArrowLeft', c2: 'KeyA', dx: -1 },
      ] as const;
      for (const rep of reps) {
        let scoredAttempt = 0;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          await converged(page);
          const t0 = await corridorEastWest(page, 2, 7);
          await resetKeyLog(page);
          // 40ms gaps, not 55: the nominal press is first-down -> last-up, so two gaps put
          // it at ~80ms — 60ms of headroom under TAP_BUDGET_MS for CI scheduling overshoot
          // (55/55 left only 30ms; CI run 31806079496 attempt 1 overran it 3/3 times). The
          // dedup under test is STATEFUL, not timed — both worlds emit (or not) on the
          // keydown EVENT itself — so shrinking the gaps changes nothing about what the
          // scenario proves, only how often a loaded runner can execute it inside the band.
          await page.keyboard.down(rep.c1);
          await page.waitForTimeout(40);
          await page.keyboard.down(rep.c2); // the OTHER code for the SAME direction
          await page.waitForTimeout(40);
          await page.keyboard.up(rep.c2);
          await page.keyboard.up(rep.c1);
          const pressedMs = await measuredPressMs(page); // first down -> last up
          if (pressedMs > TAP_BUDGET_MS) continue; // harness-timing miss — retry, do not score
          await settle(page, 600);
          const s1 = await snap(page);
          const t1 = s1.ownAuthTile;
          if (t1 === null) throw new Error('own authoritative tile went null mid-scenario');
          expect(
            t1.x - t0.x,
            `pressing BOTH codes bound to one direction (${rep.c1} + ${rep.c2}) inside a ` +
              `${Math.round(pressedMs)}ms tap must move EXACTLY one tile (ADR-0187 EARS-1). ` +
              'Received 2 means the second keydown fired its own ungated first step — the ' +
              'defect this slice closes; received 0 means the dedup also suppressed the first',
          ).toBe(rep.dx);
          expect(t1.y, 'a horizontal tap must not change the row').toBe(t0.y);
          expect(
            s1.ownPredictedTile,
            'prediction must agree with authority after the dual-code tap — the dedup is a pure ' +
              'NOT-EMIT and must never leave predicted state ahead of the server',
          ).toEqual(t1);
          scoredAttempt = attempt;
          break;
        }
        expect(
          scoredAttempt,
          `every ${rep.c1}+${rep.c2} overlap tap overran ${TAP_BUDGET_MS}ms in all ` +
            `${MAX_ATTEMPTS} attempts — the harness could not produce a tap inside the contract ` +
            'band, so this scenario measured nothing',
        ).toBeGreaterThan(0);
      }
    });

    // -------------------------------------------------------------------------------
    // C — GREEN GUARD (passes pre-fix; the runtime killer for the whole-gate fold)
    // -------------------------------------------------------------------------------
    test('C GREEN GUARD: a held key FREEZES under the box overlay and RESUMES when it closes (kills the whole-gate `|| true` fold)', async () => {
      // ★ THE UN-KILLABLE CLASS THIS CLOSES: `if (true || <predicate>)` around the frame
      // loop's continuation guard. Every source scan in main.wiring.test.ts matches the text
      // and the semantics are reverted — only EVALUATING the expression can see it. A folded
      // gate keeps walking under the overlay, so T3 !== T2 and this test reds.
      //
      // KeyB is chosen deliberately: the box toggle does NOT call held.clear() (unlike KeyN /
      // KeyO / the menu), so the ArrowRight press genuinely survives the open/close cycle.
      // That is what makes the RESUME arm (T4 > T3) an anti-vacuity proof rather than a
      // restatement of the freeze: it shows the character stopped because the GATE shut, not
      // because the held key was wiped. It also pins ADR-0013's resume-after-overlay contract.
      await recenter(page, 2);
      await corridorEastWest(page, 1, 8);
      // BoxView's static box-vs-party hint (ux4 / ADR-0155): a direct child of the overlay
      // root, created in the constructor and never re-rendered, so it is the stable visibility
      // probe. Asserted via a locator — never inferred from the game state.
      const overlay = page.locator('[data-testid="box-party-hint"]');
      await expect(overlay).toBeHidden();

      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(250); // past HOLD_COMMIT_MS: a committed, walking hold
      await page.keyboard.press('KeyB');
      await expect(
        overlay,
        'the box overlay must actually be OPEN — without it this scenario is not testing an ' +
          'overlay-suppressed hold at all',
      ).toBeVisible({ timeout: 3_000 });

      const t1 = await tile(page);
      // WAIT FOR THE IN-FLIGHT STEP TO DRAIN, DO NOT GUESS AT IT. This used to be a fixed
      // 400ms sleep, which opens a false-red window: on a slow runner the one legitimately
      // outstanding step can land AFTER T2 is sampled, i.e. inside the frozen window below,
      // and the FROZEN assertion reds on a perfectly correct client.
      //
      // Two halves, and BOTH are needed — they close different races:
      //  1. ONE CADENCE SLOT first. `ownAuthTile === ownPredictedTile` is also transiently
      //     true in the narrow window where a continuation has been ENQUEUED locally but not
      //     yet drained (prediction has not advanced yet, so it still agrees with authority).
      //     Polling alone can return inside that window and let the step land during the
      //     frozen window — the same false red, one frame narrower. A full STEP_MS slot is
      //     longer than that window by construction.
      //  2. THEN poll for convergence, generously. This is the exact "nothing is in flight
      //     and prediction has settled" condition, so the 700ms frozen window below starts
      //     only once the pipeline is genuinely quiet, however slow the runner is.
      //
      // The poll timeout is swallowed ON PURPOSE: in the mutant world the client keeps
      // SENDING under the overlay, so prediction never settles and the poll would expire.
      // Falling through hands the diagnosis to the two assertions below, which name the
      // actual defect (a moved character) instead of reporting an opaque poll timeout.
      await page.waitForTimeout(stepMs);
      await page
        .waitForFunction(
          () => {
            const g = (window as unknown as { __game: () => Snap }).__game();
            const a = g.ownAuthTile;
            const q = g.ownPredictedTile;
            return a !== null && q !== null && a.x === q.x && a.y === q.y;
          },
          null,
          { timeout: 3_000 },
        )
        .catch(() => undefined);
      const t2 = await tile(page);
      expect(
        Math.abs(t2.x - t1.x),
        'at most ONE already-in-flight step may drain after the overlay opens (the nh2/ADR-0148 ' +
          'gate keeps exactly one step outstanding). More than one means the client kept SENDING ' +
          'under the overlay',
      ).toBeLessThanOrEqual(1);
      expect(t2.y, 'the character must stay in the y=1 corridor').toBe(CORRIDOR_Y);
      expect(
        t2.x,
        'the character must still have east clearance for the kill: a mutant that walks under ' +
          'the overlay needs somewhere to walk, or "frozen" would be indistinguishable from ' +
          '"blocked by the x=9 wall"',
      ).toBeLessThanOrEqual(6);

      await page.waitForTimeout(700); // > 3 cadence slots: a walking mutant travels 3 tiles
      const t3 = await tile(page);
      expect(
        t3,
        'FROZEN — the kill assertion: with an overlay visible the held-key continuation must ' +
          'emit nothing, so the character must not have moved at all across 700ms. A whole-gate ' +
          '`|| true` fold (or any overlay term dropped from the guard) walks here',
      ).toEqual(t2);

      await page.keyboard.press('KeyB');
      await expect(overlay).toBeHidden({ timeout: 3_000 });
      await page.waitForTimeout(600);
      const t4 = await tile(page);
      expect(
        t4.x,
        'RESUME — the anti-vacuity arm: the key was never released, and KeyB does not clear the ' +
          'held set, so closing the overlay must resume the walk (ADR-0013). If it does not, the ' +
          'FROZEN assertion above passed for the wrong reason (a cleared/lost held key rather ' +
          'than a shut gate) and this whole scenario proves nothing',
      ).toBeGreaterThan(t3.x);
      expect(t4.y, 'the resumed walk must stay in the y=1 corridor').toBe(CORRIDOR_Y);

      await page.keyboard.up('ArrowRight');
      await converged(page);
    });

    // -------------------------------------------------------------------------------
    // D — RED TODAY (missing snapshot fields); post-fix the send-budget tooth
    // -------------------------------------------------------------------------------
    test('D: a sustained 1s hold stays inside the send budget and is NEVER rejected (kills the narrow `&& true ||` outstandingSteps mutant)', async () => {
      // ★ RED REASON TODAY: `moveSendCount` / `moveRejectCount` are not on the DEV snapshot,
      // so both read `undefined` and the two typeof assertions below fail immediately.
      //
      // ★ WHY A COUNTER AND NOT TILES (the whole reason these fields exist): ADR-0148
      // MEASURED the broken-gate world at UNCHANGED 5.00 tiles/s. The server's movement_tick
      // paces ACCEPTANCE at one step per STEP_MS no matter how fast the client sends, so a
      // client re-issuing every frame the local queue is empty (~60+/s at 60fps) travels at
      // exactly the same speed as a correctly gated one. Tile assertions are structurally
      // blind to it; a send-budget observable is the minimal sufficient instrument.
      //
      // THE BUDGET: a gated 1s hold issues ~1 first step + ~5 continuations = ~6 sends. 12 is
      // 2x headroom for jitter and the reconcile-divergence emitter, and still ~5x below the
      // storm the narrow mutant produces. `ΔmoveRejectCount === 0` is the healthy-contract
      // half: a client that only sends when the server owes nothing is NEVER queue-full
      // rejected, so any rejection at all means the gate is leaking.
      await recenter(page, 1);
      const g0 = await snap(page);
      expect(
        typeof g0.moveSendCount,
        'window.__game() must expose a numeric `moveSendCount` (ADR-0187 (b)) — RED TODAY: the ' +
          'field does not exist, so this reads `undefined`. Without it nothing at runtime can ' +
          'distinguish a gated continuation loop from the ADR-0148 reject storm',
      ).toBe('number');
      expect(
        typeof g0.moveRejectCount,
        'window.__game() must expose a numeric `moveRejectCount` (ADR-0187 (b)) — RED TODAY: the ' +
          'field does not exist',
      ).toBe('number');
      const send0 = g0.moveSendCount ?? Number.NaN;
      const reject0 = g0.moveRejectCount ?? Number.NaN;

      const t0 = await corridorEastWest(page, 1, 8);
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(1_000);
      await page.keyboard.up('ArrowRight');
      await settle(page, 600);

      const g1 = await snap(page);
      const t1 = g1.ownAuthTile;
      if (t1 === null) throw new Error('own authoritative tile went null mid-scenario');
      expect(
        t1.x - t0.x,
        'ANTI-VACUITY: a 1s hold must actually WALK (>= 3 tiles at a 200ms cadence). If the ' +
          'character barely moved, the send-budget assertion below is satisfied by a client that ' +
          'is simply broken, not by a correctly gated one',
      ).toBeGreaterThanOrEqual(3);
      expect(t1.y, 'the held walk must stay in the y=1 corridor').toBe(CORRIDOR_Y);

      const sendDelta = (g1.moveSendCount ?? Number.NaN) - send0;
      const rejectDelta = (g1.moveRejectCount ?? Number.NaN) - reject0;
      expect(
        sendDelta,
        `a gated 1s hold issues ~6 movement intents (1 first step + ~5 continuations); observed ` +
          `${sendDelta}. A continuation guard that re-issues on every frame the LOCAL queue is ` +
          'empty (the narrow `outstandingSteps === 0 && true || !anyOverlayVisible()` mutant — ' +
          'which survives every source scan AND scenarios A-C) floods to 60+/s while travelling ' +
          'at the identical 5.00 tiles/s. 12 is 2x headroom over the gated cadence and ~5x below ' +
          'the storm',
      ).toBeLessThanOrEqual(12);
      expect(
        rejectDelta,
        'a gate-respecting client is NEVER queue-full rejected: it only sends while the server ' +
          'owes nothing, so the server can always accept. Any rejection during an ordinary hold ' +
          'means the client is over-sending — the same leak the budget above bounds, observed ' +
          'from the server side',
      ).toBe(0);
    });
  });
