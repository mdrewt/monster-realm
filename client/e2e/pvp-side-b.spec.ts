import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import {
  attackByButtons,
  closeAll,
  deployByButtons,
  endTurn,
  openFaceToFace,
  openMenu,
  pressAccel,
  pressButton,
  readTactics,
  sides,
  TACTICS,
  type TacticsSnap,
  waitExecuted,
  waitOwnTurnOrEnd,
} from './controls';

// PvP side-B battle UI, production path
//
// THE DEFECT: store.ongoingBattle()/store.latestPlayerBattle() (client/src/net/store.ts)
// used to filter `playerIdentity === identity` ONLY. A PvP ACCEPTER is stored in the
// row's `opponentIdentity`, so the accepter got NO battle UI at all in production
// builds — frozen until the deadline forfeited them. The PRE-EXISTING pvp e2e suite
// (pvp-full.spec.ts) masked this entirely: it drives BOTH sides through main.ts's
// DEV-gated role-agnostic test hook, a code path production builds never execute. Green
// CI, broken real path, for a whole milestone.
//
// bt-16 (BT16.2) — NAMED INTENTIONAL CHANGE: accepting a challenge now opens a TACTICAL PvP
// battle in Deploying (the 1v1 overlay — Fight, "Submit: <skill>", the turn-number advance —
// never appears for a live battle). SURVIVING CHECKS, each named at its assertion below:
//   - retired "B's 1v1 command list + its own Submit buttons" → after Accept BOTH pages show the
//     PvP deploy panel, both deploy by buttons, and the ACCEPTER's page (B) renders the tactical
//     shell with a unit that is ITS OWN (mine, side B) — the production-path side-B battle UI;
//   - retired "the opponent card names A, not B" (the half-fix discriminator) → B's shell paints
//     B's unit in its OWN info box and A's unit in its FOE box (a raw-row perspective would swap
//     them), and A's page the mirror image;
//   - retired "B's own Submit advances turnNumber by one while Ongoing" → on B's own turn B acts
//     by buttons (an attack through the forecast, else End Turn) and B's event count grows; both
//     sides end a turn and B's page reaches round 2 (STRICT: a Finished battle fails), bounded by
//     ROUND_TWO_MS. Who moves first is a coin flip / speed roll: every oracle here is first-mover
//     independent (each page acts on ITS own turn, concurrently).
//
// TWO-CONTEXT DESIGN: copied from ranked-forfeit.spec.ts — two separate
// chromium.launch() instances generate distinct SpacetimeDB identities (the SDK caches
// its connection+identity in the page's JS module scope, so a shared browser/context
// would yield ONE identity and challenge_pvp would reject the self-challenge).
//
// FILE-ORDERING AUDIT (reviewer, recorded so a future reviewer never has to re-derive
// this): the `workers: 1` comment in playwright.config.ts documents single-worker,
// alphabetical-across-files execution within one Playwright process (one shard) over that
// process's ONE shared world as load-bearing (golden.spec.ts asserts an EXACT
// player population, so a concurrently-joined player from a differently-ordered spec
// would make that unreachable) — docs/specs/m17.5f-plan.md T3 records a prior incident
// where trade-interlock.spec.ts was deliberately NAMED to sort after golden.spec.ts and
// recruit.spec.ts to dodge exactly this. `pvp-side-b.spec.ts` sorts alphabetically
// BEFORE recruit.spec.ts ('p' < 'r') and AFTER golden.spec.ts ('g' < 'p'). Audited safe:
// golden.spec.ts (the only exact-population assertion in this suite) already sorts
// before this file, so it never observes this file's two extra joined players;
// recruit.spec.ts (which sorts after) asserts no population counts at all; and both of
// THIS file's renamed players' rows are deleted on disconnect
// (server-module/src/lib.rs:190-216, on_disconnect deletes the player + character rows)
// via the tolerant afterAll's browser.close() calls, before the next file's beforeAll
// runs. If an earlier-sorting spec ever grows a population-sensitive assertion, this
// audit needs re-deriving.
//
// ZERO USE OF THE DEV MULTIPLAYER HOOK: this spec drives BOTH players through the REAL
// production DOM only — A on the other player -> the Challenge row -> the size pick
// (ctl-10b / bt-15: face to face) -> B's Social sheet Accept (qf-8) -> the deploy panel's Deploy
// -> the tactical shell's menu, aims and Start. `__game()` is used ONLY for readiness and
// `__mrTactics` (the read-only tactical hook, never a reducer) as a READ-ONLY witness. The DEV
// multiplayer test hook the OTHER pvp e2e specs use to read/drive both sides at once must NEVER
// appear here, in ANY form — not even split across a comment — because using it here is EXACTLY
// the failure that hid this CRITICAL: a client-side test that proves the DEV path works while the
// real production path stays broken.
//
// THE ANTI-SLIDE GUARD (why a lexical ban alone is not enough, and what replaces it):
// main.wiring.test.ts's W-PVPB-E2E-NOHOOK raw-scans THIS FILE's text for the DEV hook's
// literal property name and its role-agnostic battle-lookup method name — a CHEAP
// SUPPLEMENT, defeated outright by e.g. string concatenation (neither literal appears
// contiguous). The LOAD-BEARING guard is HERE:
// `installHookCallCounter` (below) runs a `page.addInitScript` on pageB BEFORE main.ts's
// module script executes, defining an ACCESSOR PROPERTY on `window` at the DEV hook's
// runtime property name (built by string-array `.join('')` below — never a contiguous
// literal anywhere in this file, so this guard cannot trip our own lexical-ban scan). Its
// setter wraps every one of the hook's own methods in a call-counting proxy — this
// observes the CALL, not the source text, so it is immune to rename, aliasing, and
// dynamic-property-access obfuscation (all of those still have to CALL the real methods
// to do anything). `expect(hookCalls).toBe(0)` at the end is the real proof this spec
// never used it — DO NOT "simplify" this back to a plain `!('...' in window)` check or a
// bare property reference: both are exactly the obfuscation-defeatable lexical scans this
// guard replaces. bt-16: the shared controls.ts helpers this spec calls read `__mrTactics`
// and the DOM only; the counter proves it at runtime.
//
// DEPLOY HEADROOM (bt-16; replaces the retired 60 s PVP_TURN_DEADLINE_MS arithmetic): the
// tactical PvP deploy window is 45 s from accept_challenge, after which the server auto-fills the
// deploy. `acceptedAt` is captured immediately AFTER B's Accept press, and Active must arrive
// within DEPLOY_HEADROOM_MS (40 s) of it — so the auto-fill can never be what completes the
// deploy this test credits to the buttons. The rename steps run BEFORE the challenge, outside it.
//
// WHY BOTH PLAYERS ARE RENAMED FIRST: distinct, deterministic labels per run (the players strip
// names them; the challenge picker row `Challenge — <B's name>` must name ONE player).
//
// EARS CRITERIA COVERED: AC-1, AC-7, AC-9 (re-expressed on the tactical UI, bt-16 BT16.2)

// Runtime property name of the DEV multiplayer test hook, built by array-join so the
// literal NEVER appears as a contiguous substring anywhere in this file's source text
// (main.wiring.test.ts's W-PVPB-E2E-NOHOOK raw-scans this whole file, comments
// included). Read ONLY by installHookCallCounter below — this spec never reads or calls
// anything through it.
const DEV_HOOK_PROP = ['__mr', 'Pvp'].join('');
// Counter property name — deliberately does NOT share a contiguous substring with
// DEV_HOOK_PROP's runtime value either, so a future rename of one cannot silently
// collide with the other.
const HOOK_CALL_COUNTER_PROP = '__pvpDevHookCallCount';

/** bt-16: how long each page's deploy panel may take to show after the Accept press. */
const DEPLOY_PANEL_MS = 15_000;
/** bt-16: Active must arrive this soon after the Accept (under the 45 s deploy auto-fill). */
const DEPLOY_HEADROOM_MS = 40_000;
/** bt-16: one PvP turn window is 30 s (`pvp_window_ms`); a page waits for its own turn at most
 *  the other side's whole window plus slack. */
const PVP_WINDOW_MS = 30_000;
const TURN_SLACK_MS = 10_000;
const OWN_PVP_TURN_MS = PVP_WINDOW_MS + TURN_SLACK_MS;
/** bt-16: both sides end one turn each → round 2, bounded by two windows plus slack. */
const ROUND_TWO_MS = 2 * PVP_WINDOW_MS + TURN_SLACK_MS;
/** bt-16: how long an End Turn press may take to move the turn on. */
const END_TURN_ACK_MS = 5_000;

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
}

/** Mirrors ranked-forfeit.spec.ts / pvp-full.spec.ts: wait until __game() exists,
 *  identity is assigned, and the player has been placed on the map. */
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

/**
 * THE load-bearing anti-slide guard (see file header). Must be called BEFORE
 * `page.goto()` — Playwright only applies an init script to navigations that start
 * AFTER it is registered, which is what lets it win the race against main.ts's own
 * DEV-gated hook assignment.
 */
async function installHookCallCounter(page: Page): Promise<void> {
  await page.addInitScript(
    ({ hookProp, counterProp }: { hookProp: string; counterProp: string }) => {
      const w = window as unknown as Record<string, unknown>;
      w[counterProp] = 0;
      let real: Record<string, unknown> | undefined;
      Object.defineProperty(w, hookProp, {
        configurable: true,
        enumerable: true,
        get() {
          return real;
        },
        set(value: Record<string, unknown>) {
          const wrapped: Record<string, unknown> = {};
          for (const key of Object.keys(value)) {
            const orig = value[key];
            if (typeof orig === 'function') {
              wrapped[key] = (...args: unknown[]) => {
                w[counterProp] = (w[counterProp] as number) + 1;
                return orig.apply(value, args);
              };
            } else {
              wrapped[key] = orig;
            }
          }
          real = wrapped;
        },
      });
    },
    { hookProp: DEV_HOOK_PROP, counterProp: HOOK_CALL_COUNTER_PROP },
  );
}

async function readHookCallCount(page: Page): Promise<number> {
  return page.evaluate(
    (counterProp: string) => (window as unknown as Record<string, unknown>)[counterProp] as number,
    HOOK_CALL_COUNTER_PROP,
  );
}

/**
 * Renames `page`'s own player through the REAL production UI (closeAll -> N ->
 * rename-input -> rename-submit), copied from rename.spec.ts:228-245. Leaves NO overlay open on
 * exit (the rename overlay does NOT auto-close on success, main.ts:2182-2186, so this runs
 * closeAll again after the feedback confirms) — required because the incoming-challenge banner
 * path and A's own face-to-face A press both need a bare world. ctl-11a: N opens the Name screen
 * through the main menu (Profile > Name), so that closeAll takes the menu too.
 */
async function renamePlayer(page: Page, name: string): Promise<void> {
  await closeAll(page); // dismiss any stale overlay first
  await pressAccel(page, 'N');
  await page.waitForSelector('[data-testid="rename-input"]', {
    state: 'visible',
    timeout: 10_000,
  });
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
    `11r-b: rename feedback for "${name}" must not indicate an error — the challenge picker ` +
      'row below is ambiguous if the rename itself silently failed',
  ).not.toMatch(/error|failed|reject/i);
  // Close the overlay (see doc comment above) before the challenge/accept flow.
  await closeAll(page);
}

/** On `page`'s next OWN live turn, ends it by buttons (Start) and waits for the turn to move on;
 *  `act` first acts on B's page (an attack through the forecast when one reaches). Fails naming
 *  the bound when no own turn comes or the battle finishes first. Returns the turn snapshot. */
async function playOwnTurn(page: Page, who: string, act: boolean): Promise<TacticsSnap> {
  const t = await waitOwnTurnOrEnd(page, null, OWN_PVP_TURN_MS);
  if (t.phase !== 'Active') {
    throw new Error(`${who}: the battle is ${t.phase} before its own turn was played (STRICT)`);
  }
  const { me, enemy } = sides(t);
  await openMenu(page, me);
  if (act) {
    const hit = await attackByButtons(page, { allowKo: false, enemyHp: enemy.curHp });
    if (hit === 'attacked') await waitExecuted(page, t.events);
  }
  await endTurn(page);
  await expect
    .poll(
      async () => {
        const now = await readTactics(page);
        return (
          now !== null &&
          (now.round !== t.round || now.turnIdx !== t.turnIdx || now.activeUnitId !== me.unitId)
        );
      },
      { message: `${who}: Start (End Turn) moves the turn on`, timeout: END_TURN_ACK_MS },
    )
    .toBe(true);
  return t;
}

test.describe
  .serial('11r-b — PvP side-B battle UI (production path, zero DEV-hook use)', () => {
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

      // Must be installed before goto() (see installHookCallCounter's doc comment).
      await installHookCallCounter(pageB);

      await pageA.goto('/');
      await pageB.goto('/');
      await Promise.all([gameReady(pageA), gameReady(pageB)]);
    });

    test.afterAll(async () => {
      // Tolerant teardown (ranked-forfeit.spec.ts precedent) — a failing assertion above
      // must not leave either browser process orphaned.
      try {
        await browserA?.close();
      } catch {
        // ignore — may already be closed by an error path
      }
      try {
        await browserB?.close();
      } catch {
        // ignore
      }
    });

    test('side B (the accepter) gets a real tactical battle UI through the production path: both deploy panels, B`s own unit in its shell, B acts on its own turn by buttons and the round advances on B`s page (bt-16: was the 1v1 overlay`s Fight / Submit / turn advance)', async () => {
      test.setTimeout(240_000);

      const identityA = await pageA.evaluate(
        () => (window as unknown as { __game: () => GameSnap }).__game().identity,
      );
      const identityB = await pageB.evaluate(
        () => (window as unknown as { __game: () => GameSnap }).__game().identity,
      );
      expect(identityA, 'identityA must be non-empty').not.toBe('');
      expect(identityB, 'identityB must be non-empty').not.toBe('');
      expect(identityA, 'identityA and identityB must differ').not.toBe(identityB);

      // Rename BOTH players through the production UI. Runs BEFORE the challenge, so it is
      // entirely outside the deploy-headroom window measured below. Unique per-run suffix so the
      // shared e2e world can't collide with a prior run's row; alphanumeric-only, well under the
      // server's MAX_NAME_LEN=24 (server-module/src/guards.rs:49-62, validate_name).
      const uniqueSuffix = String(Date.now() % 1_000_000);
      const nameA = `PvpA${uniqueSuffix}`;
      const nameB = `PvpB${uniqueSuffix}`;
      await Promise.all([renamePlayer(pageA, nameA), renamePlayer(pageB, nameB)]);

      // B must have no overlay open — P must OPEN Social (with Social already up it would act as
      // Start and close it). renamePlayer already closes its own overlay on exit; this is a
      // defensive re-assert immediately before the challenge (ranked-forfeit.spec.ts placement).
      await closeAll(pageB);

      // INTENTIONAL CHANGE (ctl-10b, CTL10B.1-2 / bt-15): A challenges B FACE TO FACE: A stands on
      // B's tile, presses A, chooses `Challenge — <B's name>` and sends the size pick's first row.
      await openFaceToFace(pageA, 'Challenge', nameB, pageB);

      // B accepts through the Social sheet (ctl-13 CTL13.4: the banner announces the request; P
      // opens Social on it; qf-8 QF8.3: A opens its sheet on Accept, A accepts). Y is not used: A
      // stands on B's tile, so for B that player is a TARGET and Y would open the player's sheet.
      await expect(pageB.locator('#notice-banner')).toBeVisible({ timeout: 15_000 });
      await pressAccel(pageB, 'P');
      await expect(pageB.locator('#pvp-challenge-incoming[aria-current="true"]')).toBeVisible({
        timeout: 15_000,
      });
      await pressButton(pageB, 'A');
      await expect(pageB.locator('#social-sheet [aria-selected="true"]')).toHaveText('Accept');
      await pressButton(pageB, 'A');
      const acceptedAt = Date.now();

      // SURVIVING CHECK (bt-16): retired "B's 1v1 command list is visible" → after Accept BOTH
      // pages show the PvP deploy panel (toBeVisible: the roots toggle display none/flex and real
      // chromium does layout), and each deploys by buttons.
      await expect(pageA.locator(TACTICS.deploy), 'A shows the PvP deploy panel').toBeVisible({
        timeout: DEPLOY_PANEL_MS,
      });
      await expect(
        pageB.locator(TACTICS.deploy),
        'B (the accepter) shows the PvP deploy panel',
      ).toBeVisible({
        timeout: DEPLOY_PANEL_MS,
      });
      await Promise.all([deployByButtons(pageA, 'A deploys'), deployByButtons(pageB, 'B deploys')]);
      let activeB: TacticsSnap | null = null;
      await expect
        .poll(
          async () => {
            activeB = await readTactics(pageB);
            return activeB?.phase ?? 'none';
          },
          { message: 'B reaches Active after both locks', timeout: DEPLOY_HEADROOM_MS },
        )
        .toBe('Active');
      expect(
        Date.now() - acceptedAt,
        'Active arrived inside DEPLOY_HEADROOM_MS of the Accept: the buttons deployed, not the 45 s auto-fill',
      ).toBeLessThan(DEPLOY_HEADROOM_MS);
      const snapB = activeB as TacticsSnap | null;
      if (snapB === null) throw new Error('B has no tactical battle');
      const snapA = await readTactics(pageA);
      if (snapA === null) throw new Error('A has no tactical battle');
      expect(snapA.battleId, 'both pages hold the same battle').toBe(snapB.battleId);
      expect(snapB.kind, 'a PvP battle').toBe('Pvp');

      // SURVIVING CHECK (bt-16): retired "B's own Submit buttons render" → THE DEFECT's witness on
      // the tactical UI: the ACCEPTER's page renders the shell with a unit that is ITS OWN.
      await expect(pageB.locator(TACTICS.shell), 'B renders the tactical shell').toBeVisible({
        timeout: DEPLOY_PANEL_MS,
      });
      const ownB = snapB.units.filter((u) => u.mine);
      const ownA = snapA.units.filter((u) => u.mine);
      expect(ownB.length, 'B (the accepter) holds a unit that is its own').toBeGreaterThan(0);
      expect(
        ownB.map((u) => u.side),
        'the accepter`s own units are side B',
      ).toEqual(ownB.map(() => 'B'));
      expect(
        ownA.map((u) => u.side),
        'the challenger`s own units are side A',
      ).toEqual(ownA.map(() => 'A'));
      // SURVIVING CHECK (bt-16): retired "the opponent card names A, not B" (the half-fix
      // discriminator) → B's shell paints B's unit in its OWN info box and A's unit in its FOE
      // box; a raw-row (unprojected) perspective would swap them.
      const unitB = ownB[0];
      const unitA = ownA[0];
      if (unitA === undefined || unitB === undefined) throw new Error('one unit per side expected');
      await expect(
        pageB.locator(
          `${TACTICS.shell} .tactics-info--own .tactics-info-row[data-unit-id="${unitB.unitId}"]`,
        ),
        'B`s own info box holds B`s unit',
      ).toHaveCount(1, { timeout: DEPLOY_PANEL_MS });
      await expect(
        pageB.locator(
          `${TACTICS.shell} .tactics-info--foe .tactics-info-row[data-unit-id="${unitA.unitId}"]`,
        ),
        'B`s foe info box holds A`s unit',
      ).toHaveCount(1);
      await expect(
        pageB.locator(
          `${TACTICS.shell} .tactics-info--own .tactics-info-row[data-unit-id="${unitA.unitId}"]`,
        ),
        'A`s unit is never in B`s own box',
      ).toHaveCount(0);

      // SURVIVING CHECK (bt-16): retired "B's Submit advances turnNumber by one while Ongoing" →
      // each side plays ITS own turn by buttons, concurrently (first-mover independent): B attacks
      // through the forecast when a skill reaches (else ends its turn), A ends its turn. B's event
      // count grows past its Active baseline, and B's page reaches round 2 — STRICT: a battle that
      // finishes first fails (playOwnTurn throws on a non-Active battle).
      const eventsB0 = snapB.events;
      const [turnA, turnB] = await Promise.all([
        playOwnTurn(pageA, 'A', false),
        playOwnTurn(pageB, 'B', true),
      ]);
      console.log(
        `[bt-16 side-B ORDER] A's turn ${turnA.round}:${turnA.turnIdx}, B's turn ${turnB.round}:${turnB.turnIdx}; initiative ${snapB.initiative.join(',')}`,
      );
      await expect
        .poll(async () => (await readTactics(pageB))?.events ?? -1, {
          message: 'B`s own action executed: B`s event count grows',
          timeout: END_TURN_ACK_MS,
        })
        .toBeGreaterThan(eventsB0);
      await expect
        .poll(
          async () => {
            const t = await readTactics(pageB);
            if (t === null) return 'no battle';
            if (t.phase !== 'Active') return `phase ${t.phase}`;
            return `round ${t.round}`;
          },
          {
            message: `B's page reaches round 2 within ROUND_TWO_MS=${ROUND_TWO_MS} ms, the battle still Active`,
            timeout: ROUND_TWO_MS,
          },
        )
        .toBe('round 2');

      // THE anti-slide guard's actual assertion: this spec never called through the DEV hook.
      const hookCalls = await readHookCallCount(pageB);
      expect(
        hookCalls,
        '11r-b: this spec must drive side B ENTIRELY through the production DOM — the DEV ' +
          'hook call counter must stay 0 throughout',
      ).toBe(0);
    });
  });
