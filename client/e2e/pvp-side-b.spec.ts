import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// 11r-b — PvP side-B battle overlay, production path (ADR-0167, closes ADR-0155 D6)
//
// THE DEFECT: store.ongoingBattle()/store.latestPlayerBattle() (client/src/net/store.ts)
// used to filter `playerIdentity === identity` ONLY. A PvP ACCEPTER is stored in the
// row's `opponentIdentity` (server-module/src/pvp.rs:289-297), so the accepter got NO
// battle overlay at all in production builds — no cards, no skills, no swap — frozen
// until the 60s deadline reaper forfeited them. The PRE-EXISTING pvp e2e suite
// (pvp-full.spec.ts) masked this entirely: it drives BOTH sides through main.ts's
// DEV-gated role-agnostic test hook, a code path production builds never execute. Green
// CI, broken real path, for a whole milestone.
//
// TWO-CONTEXT DESIGN: copied from ranked-forfeit.spec.ts (m17c) — two separate
// chromium.launch() instances generate distinct SpacetimeDB identities (the SDK caches
// its connection+identity in the page's JS module scope, so a shared browser/context
// would yield ONE identity and challenge_pvp would reject the self-challenge).
//
// ZERO USE OF THE DEV TEST HOOK: this spec drives BOTH players through the REAL
// production DOM only — KeyP -> the challenge button -> the accept button -> the real
// "Submit: <skill>" buttons. `__game()` is used ONLY for readiness and as a READ-ONLY
// witness (identity, ongoingBattle.turnNumber/outcome) — never to drive gameplay. The
// DEV multiplayer test hook the OTHER pvp e2e specs use to read/drive both sides at once
// must NEVER appear here, in ANY form — not even split across a comment — because using
// it here is EXACTLY the failure that hid this CRITICAL: a client-side test that proves
// the DEV path works while the real production path stays broken.
//
// THE ANTI-SLIDE GUARD (why a lexical ban alone is not enough, and what replaces it):
// main.wiring.test.ts's W-PVPB-E2E-NOHOOK raw-scans THIS FILE's text for the DEV hook's
// literal property name and its role-agnostic battle-lookup method name — a CHEAP
// SUPPLEMENT, defeated outright by e.g. `window['__mr' + 'Pvp']['battle' + 'ById'](id)`
// (neither literal appears contiguous). The LOAD-BEARING guard is HERE:
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
// guard replaces.
//
// DEADLINE HEADROOM ARITHMETIC (house style per pvp-full.spec.ts:48-56):
// PVP_TURN_DEADLINE_MS = 60_000 ms (server constant, server-module/src/pvp.rs) — the
// server's deadline clock starts at `accept_challenge`. `acceptedAt` is therefore
// captured immediately AFTER pageB's accept-button click (never before A's challenge
// click, which would also fold the challenge-button poll into the budget — stricter
// than intended and a spurious-flake risk). This test asserts the accept-click ->
// both-players-submitted flow completes within 45_000 ms of THAT click — a hard ceiling
// with 15s of headroom under the 60s deadline, so the deadline reaper can never be the
// reason the turn-advance assertion below passes. The rename steps (below) run BEFORE
// the challenge and are therefore entirely outside this window.
//
// WHY BOTH PLAYERS ARE RENAMED FIRST (red-team HIGH — the half-fix discriminator):
// STARTER_SPECIES_ID=1 (server-module/src/lib.rs:72) and roll_starter hardcodes level 5
// (game-core/src/monster/rolls.rs:75) — the join_game seed perturbs only genes/IVs/
// nature — so two FRESH players' active starters share identical species, level and
// known_skill_ids. That makes the turn-advance witness (AC-9) alone UNABLE to
// discriminate the HALF-FIX (role-agnostic accessors landed, `ownPerspective` never
// wired into `refreshBattle`) from the real fix: under the half-fix, B's overlay
// renders the RAW row, so B's Submit buttons are built from the CHALLENGER's
// known_skill_ids — but those ids are cross-legal for B's own identical starter too, so
// submit_pvp_action still accepts them and the turn still advances. A rename (via the
// production KeyN -> rename-input -> rename-submit path, ADR-0133/PTC1B-9) gives each
// player a distinct, deterministic label with NO such coincidental overlap: the opponent
// card's header text is resolved from `battle.opponentIdentity` (main.ts:1309-1313,
// battleView.ts:170,203-214) — on a RAW side-B row `opponentIdentity` IS side B, so the
// half-fix mislabels B's OWN opponent card with B's OWN name. See the two
// `getByText(...)` assertions after the Submit-visible check for the exact proof; that
// pair — not the turn-advance witness — is what makes this file catch the half-fix.
//
// WHAT THIS TEST KILLS:
//   - The CURRENT defect: side B's client renders no battle overlay at all — the
//     "Submit:" assertion below is RED today (zero elements match).
//   - THE HALF-FIX (role-agnostic accessors landed, `ownPerspective` never wired into
//     `refreshBattle`): the turn-advance witness alone CANNOT see it (see the rename
//     rationale above — both fresh starters share identical known_skill_ids, so a
//     wrong-side skill submission is cross-legal and the server accepts it). The two
//     opponent-label assertions below are the discriminator: under the half-fix, B's
//     "opponent" card is mislabeled with B's OWN name instead of the challenger's.
//   - A silently-rejected side-B action masquerading as success: the poll below requires
//     `turnNumber === turnNumber0 + 1` WHILE `outcome === 'Ongoing'` — never merely "the
//     waiting banner hid", because that banner's underlying pending flag is ALSO cleared
//     on any terminal outcome (main.ts:1301-1306), and the 60s deadline reaper produces a
//     terminal outcome WITHOUT advancing the turn (pvp.rs:1124-1178). A banner-hidden-only
//     check would pass on a silently-rejected action once the reaper eventually fires;
//     turn-advance-while-still-Ongoing is unambiguous proof the server ACCEPTED the skill
//     id B itself submitted (AC-9) — but that alone does not prove PERSPECTIVE (AC-7),
//     which is why the label assertions are complementary, not a replacement.
//
// EARS CRITERIA COVERED: AC-1, AC-7, AC-9 (memory/projects/monster-realm-11r-b-plan.md §4)

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

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ongoingBattle: { battleId: string; outcome: string; turnNumber: number } | null;
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
 * DEV-gated hook assignment (main.ts:1834-1838).
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
 * Renames `page`'s own player through the REAL production UI (Escape -> KeyN ->
 * rename-input -> rename-submit), copied from rename.spec.ts:228-245 (PTC1B-9). This is
 * the half-fix discriminator setup — see the file header. Leaves NO overlay open on exit
 * (the rename overlay does NOT auto-close on success, main.ts:2182-2186, so this presses
 * Escape again after the feedback confirms) — required because the incoming-challenge
 * auto-show and A's own KeyP open both need `!anyOverlayVisible`.
 */
async function renamePlayer(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Escape'); // dismiss any stale overlay first
  await page.waitForTimeout(200);
  await page.keyboard.press('KeyN');
  await page.waitForSelector('[data-testid="rename-input"]', {
    state: 'visible',
    timeout: 10_000,
  });
  await page.fill('[data-testid="rename-input"]', name);
  await page.click('[data-testid="rename-submit"]');
  await page.waitForFunction(
    () => {
      const fb = document.querySelector('[data-testid="rename-feedback"]');
      return fb !== null && (fb.textContent ?? '').trim().length > 0;
    },
    null,
    { timeout: 15_000 },
  );
  const feedbackText = await page.textContent('[data-testid="rename-feedback"]');
  expect(
    feedbackText ?? '',
    `11r-b: rename feedback for "${name}" must not indicate an error — the opponent-label ` +
      'discriminator below is meaningless if the rename itself silently failed',
  ).not.toMatch(/error|failed|reject/i);
  // Close the overlay (see doc comment above) before the challenge/accept flow.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

test.describe
  .serial('11r-b — PvP side-B battle overlay (production path, zero DEV-hook use)', () => {
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

    test('side B (the accepter) gets a real battle overlay with its OWN cards/skills, and its own submitted action resolves the turn', async () => {
      test.setTimeout(120_000);

      const identityA = await pageA.evaluate(
        () => (window as unknown as { __game: () => GameSnap }).__game().identity,
      );
      const identityB = await pageB.evaluate(
        () => (window as unknown as { __game: () => GameSnap }).__game().identity,
      );
      expect(identityA, 'identityA must be non-empty').not.toBe('');
      expect(identityB, 'identityB must be non-empty').not.toBe('');
      expect(identityA, 'identityA and identityB must differ').not.toBe(identityB);

      // Rename BOTH players through the production UI — the half-fix discriminator setup
      // (see the file header's "WHY BOTH PLAYERS ARE RENAMED FIRST"). Runs BEFORE the
      // challenge, so it is entirely outside the deadline-headroom window measured below.
      // Unique per-run suffix so the shared e2e world can't collide with a prior run's row;
      // alphanumeric-only, well under the server's MAX_NAME_LEN=24 (server-module/src/
      // guards.rs:49-62, validate_name).
      const uniqueSuffix = String(Date.now() % 1_000_000);
      const nameA = `PvpA${uniqueSuffix}`;
      const nameB = `PvpB${uniqueSuffix}`;
      await Promise.all([renamePlayer(pageA, nameA), renamePlayer(pageB, nameB)]);

      // B must have no overlay open — the incoming-challenge auto-show requires
      // !anyOverlayVisible (ranked-forfeit.spec.ts:282-287 precedent). renamePlayer already
      // closes its own overlay on exit; this is a defensive re-assert immediately before
      // the challenge, matching the ranked-forfeit.spec.ts placement exactly.
      await pageB.keyboard.press('Escape');
      await pageB.waitForTimeout(200);

      // A opens the PvP overlay and challenges B. Identity-attribute selection is
      // MANDATORY, not stylistic: every client joins as name:'Player' (main.ts:2271) and
      // this scan runs on whatever the challenge list shows at click time — selecting by
      // the `data-player-identity` attribute is robust regardless of the current display
      // name, so it stays the selection method even though both players now have distinct
      // rename labels by this point.
      await pageA.keyboard.press('KeyP');
      await pageA.waitForFunction(
        (myIdentity: string) => {
          const btn = document.querySelector(
            '[data-testid="pvp-challenge-player-btn"]',
          ) as HTMLElement | null;
          return btn !== null && btn.getAttribute('data-player-identity') !== myIdentity;
        },
        identityA,
        { timeout: 15_000 },
      );
      await pageA.evaluate((myIdentity: string) => {
        const buttons = Array.from(
          document.querySelectorAll('[data-testid="pvp-challenge-player-btn"]'),
        ) as HTMLElement[];
        const btn = buttons.find((b) => b.getAttribute('data-player-identity') !== myIdentity);
        if (!btn) throw new Error('11r-b: no challenge button found for a non-self player');
        btn.click();
      }, identityA);

      // B accepts through the real DOM button. `acceptedAt` is captured HERE (never
      // earlier) — the server's PVP_TURN_DEADLINE_MS clock starts at accept_challenge, so
      // capturing before A's challenge-button poll (or before the rename steps above)
      // would fold unrelated setup time into the 45s budget asserted below (see the file
      // header's DEADLINE HEADROOM ARITHMETIC).
      await pageB.waitForSelector('[data-testid="pvp-accept-btn"]', { timeout: 15_000 });
      await pageB.click('[data-testid="pvp-accept-btn"]');
      const acceptedAt = Date.now();

      // RED TODAY (AC-7): side B renders NO battle overlay at all on master — zero
      // elements match this selector, because refreshBattle returns early
      // (store.ongoingBattle(identity) is undefined for the accepter today; see
      // battleView.ts:252 for the button this selector targets). toBeVisible() — never
      // toBeAttached() — is deliberate: battleView's root toggles display:none/flex
      // (battleView.ts:146,151) and real chromium does layout, so visibility here is a
      // meaningful assertion, not merely a cosmetic one.
      await expect(pageB.getByRole('button', { name: /^Submit: / }).first()).toBeVisible({
        timeout: 15_000,
      });

      // THE HALF-FIX DISCRIMINATOR (red-team HIGH; see the file header for the full chain
      // of evidence — identical starters make the turn-advance witness below unable to
      // catch this on its own). WRONG IMPL KILLED: role-agnostic accessors landed with
      // `ownPerspective` never wired into `refreshBattle`. Under that half-fix, B's overlay
      // renders the RAW row, whose `opponentIdentity` field IS B itself — so B's "opponent"
      // card is mislabeled with B's OWN name (main.ts:1309-1313 resolves the label from
      // that raw field via store.allPlayers()). Plain-string getByText substring matching —
      // no `new RegExp(...)` (Semgrep detect-non-literal-regexp is an active CI gate here).
      await expect(pageB.getByText(`${nameA}: `)).toBeVisible();
      await expect(pageB.getByText(`${nameB}: `)).toHaveCount(0);

      // Direct production-path witness of AC-1: __game().ongoingBattle is non-null on
      // side B ONLY because store.ongoingBattle() became role-agnostic (11r-b). Read-only
      // witness — never used to drive the flow.
      const snapB0 = await pageB.evaluate(
        () => (window as unknown as { __game: () => GameSnap }).__game().ongoingBattle,
      );
      expect(snapB0, 'side B must have a non-null ongoingBattle (AC-1)').not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: null-checked immediately above
      const turnNumber0 = snapB0!.turnNumber;

      // B submits through its own real Submit button.
      await pageB
        .getByRole('button', { name: /^Submit: / })
        .first()
        .click();
      await expect(pageB.getByTestId('pvp-status')).toContainText(/Waiting for opponent/, {
        timeout: 10_000,
      });

      // A submits through its own real Submit button.
      await pageA
        .getByRole('button', { name: /^Submit: / })
        .first()
        .click();

      // RED TODAY + the disambiguating assertion (AC-9): see the file header for why the
      // predicate must be STRICT turn-advance-while-Ongoing, not merely "banner hidden".
      await pageB.waitForFunction(
        (expected: number) => {
          const g = (window as unknown as { __game: () => GameSnap }).__game();
          const b = g.ongoingBattle;
          if (!b) return false;
          if (b.outcome !== 'Ongoing') {
            throw new Error(
              `11r-b: battle resolved to a terminal outcome (${b.outcome}) before the turn ` +
                'advanced — consistent with a silently-rejected side-B action (wrong-side ' +
                'skill id, the half-fix symptom) letting the 60s deadline reaper fire',
            );
          }
          return b.turnNumber === expected;
        },
        turnNumber0 + 1,
        { timeout: 30_000 },
      );

      // Deadline-headroom assertion (see file header arithmetic).
      expect(
        Date.now() - acceptedAt,
        '11r-b: accept -> both-submit flow must finish well inside PVP_TURN_DEADLINE_MS=60s',
      ).toBeLessThan(45_000);

      // Witness: side B is not frozen — its Submit buttons are visible again next turn.
      await expect(pageB.getByRole('button', { name: /^Submit: / }).first()).toBeVisible({
        timeout: 10_000,
      });

      // THE anti-slide guard's actual assertion: this spec never called through the DEV hook.
      const hookCalls = await readHookCallCount(pageB);
      expect(
        hookCalls,
        '11r-b: this spec must drive side B ENTIRELY through the production DOM — the DEV ' +
          'hook call counter must stay 0 throughout',
      ).toBe(0);
    });
  });
