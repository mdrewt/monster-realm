import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { CLAIM_CODE_KEY_PREFIX } from '../src/net/claimCode';
import { t } from '../src/ui/i18n/resolver';
import { pressAccel } from './controls';

// accounts.spec.ts — the BROWSER surface of the guest-claim flow (de-bloat Phase 3 smoke).
//
// SCOPE. evals/account-e2e.eval.mjs drives the live claim end to end from a Node driver (real
// issuer, real JWT, real re-key) and never renders the claim overlay. A full browser claim is not
// reachable here: complete_guest_claim needs a JWT from the module's allowed issuer. So this
// file pins what a real player sees and what a real browser stores; server-side claim
// registration (startSignIn -> start_guest_claim before the redirect) is gated by
// client/src/net/connection.runtime.test.ts (CLAIM-START*):
//   A1  C opens the claim overlay (prompt copy, sign-in button, privacy door, first-run nudge);
//       ctl-11a: through the main menu (Profile > Account), and C again, with its own screen on
//       top, acts as Start (A2 closes it that way)
//   A2  Sign-in with an unreachable auth service fails SAFE: failure copy, a well-formed claim
//       code minted into per-tab sessionStorage (claimCode.ts), identity/party/presence
//       unchanged, the world still plays
//   A3  Declining is two-step: arm -> cancel keeps the code; arm -> confirm deletes it
//
// The claim copy is model English in client/src/ui/claimModel.ts (NOT in the i18n catalog), so
// those strings are literals pinned to that file; catalogued strings go through t().
//
// Every button is clicked through Playwright's real (visibility-checked) click — never a
// programmatic .click(), which would pass against a hidden or unlabelled control.
//
// CLEANUP. One browser/context/identity; afterAll closes the browser (on_disconnect deletes the
// player row before golden.spec's presenceCount === 2).

const PROMPT_TITLE = 'Keep your guest progress'; // claimModel.ts PENDING_TITLE
const NUDGE = 'Guest progress transfers only from the device you claim it on.'; // NUDGE_COPY
const FAILED_TITLE = 'Sign-in did not finish'; // buildClaimViewModel 'sign-in-failed'
const FAILED_BODY = 'Sign-in did not complete. Please try again — your guest progress is safe.';
const CONFIRM_PREFIX = 'Declining permanently deletes this claim code'; // CONFIRM_PROMPT

interface GameSnap {
  identity: string;
  ownEntityId: string | null;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: { monsterId: string; speciesId: number }[];
  characters: { entityId: string }[];
}
type Win = Window & { __game: () => GameSnap & { step: (d: string) => void } };

const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as Win).__game();
    return {
      identity: g.identity,
      ownEntityId: g.ownEntityId,
      ownAuthTile: g.ownAuthTile,
      ownMonsters: g.ownMonsters,
      characters: g.characters,
    };
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as Partial<Win>;
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null && g.ownMonsters.length > 0;
    },
    null,
    { timeout: 30_000 },
  );
}

/** Stored claim codes: values under code keys (prefix|uri|db — the nudge slot has an extra
 *  `|nudge` segment, claimCode.ts, and is excluded by the segment count). The code lives in
 *  per-tab sessionStorage (claimCode.ts / ADR-0179 D3); localStorage is scanned too so a code
 *  that leaked into the cross-tab store is counted (and fails the length pins) rather than
 *  missed. */
const storedCodes = (p: Page): Promise<string[]> =>
  p.evaluate((prefix) => {
    const out: string[] = [];
    for (const store of [sessionStorage, localStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k?.startsWith(`${prefix}|`) && k.split('|').length === 3) {
          out.push(store.getItem(k) ?? '');
        }
      }
    }
    return out;
  }, CLAIM_CODE_KEY_PREFIX);

async function focusWorld(p: Page): Promise<void> {
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The context stack's length (1 = the bare world: the menu and the leaf beneath it are closed). */
const stackLength = (p: Page): Promise<number> =>
  p.evaluate(
    () => (window as unknown as { __game: () => { stack: unknown[] } }).__game().stack.length,
  );

test.describe
  .serial('Phase 3 smoke — guest-claim browser surface', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    let before: GameSnap;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      // The auth service is unreachable by construction: whatever issuer the build carries,
      // its discovery document answers 503 (oidc.ts beginSignIn -> 'transient-error').
      await page.route('**/.well-known/openid-configuration', (route) =>
        route.fulfill({ status: 503, body: '' }),
      );
      await page.goto('/');
      await ready(page);
      before = await snap(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('A1: KeyC opens the claim overlay with the guest prompt, a sign-in button, the privacy door and the first-run nudge', async () => {
      expect(await storedCodes(page), 'a fresh guest holds no claim code').toEqual([]);
      await focusWorld(page);
      await pressAccel(page, 'C');
      await expect(page.locator('#claim-overlay')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('#claim-title')).toHaveText(PROMPT_TITLE);
      // B2 (ctl-8h): the title and the body are ON SCREEN, not just present in the DOM. They used to
      // be created display:none and never un-hidden, so toHaveText alone passed against an overlay
      // whose copy no player could read.
      await expect(page.locator('#claim-title')).toBeVisible();
      await expect(page.locator('#claim-body')).toBeVisible();
      await expect(page.locator('#claim-nudge')).toHaveText(NUDGE);
      await expect(page.locator('#claim-signin-btn')).toBeVisible();
      await expect(page.locator('#claim-signin-btn')).toHaveText(t('claim.signInButton'));
      // The overlay's initial-focus anchor is the (now painted) sign-in button.
      await expect(page.locator('#claim-signin-btn')).toBeFocused();
      await expect(page.locator('#claim-decline-btn')).toHaveText(t('claim.declineButton'));
      await expect(page.locator('#claim-join-btn')).toBeHidden();
      await expect(page.locator('#claim-privacy-btn')).toHaveText(t('claim.privacyButton'));
    });

    test('A2: sign-in with an unreachable auth service fails safe — failure copy, a minted claim code, and the guest session untouched', async () => {
      await page.locator('#claim-signin-btn').click();
      await expect(page.locator('#claim-title')).toHaveText(FAILED_TITLE, { timeout: 10_000 });
      await expect(page.locator('#claim-body')).toHaveText(FAILED_BODY);
      // B2 (ctl-8h): the failure copy is visible to the player in this phase too.
      await expect(page.locator('#claim-title')).toBeVisible();
      await expect(page.locator('#claim-body')).toBeVisible();

      // The code is minted BEFORE the provider is contacted (connection.ts startSignIn) and
      // survives the failure (claimModel 'sign-in-failed' never deletes it).
      const codes = await storedCodes(page);
      expect(codes).toHaveLength(1);
      expect(codes[0]).toMatch(/^[0-9a-f]{64}$/);

      // Guest progress is safe: same identity, same party, still present in the world.
      const after = await snap(page);
      expect(after.identity).toBe(before.identity);
      expect(after.ownMonsters.map((m) => m.monsterId)).toEqual(
        before.ownMonsters.map((m) => m.monsterId),
      );
      expect(after.ownEntityId).not.toBe(null);
      expect(after.characters.map((c) => c.entityId)).toContain(after.ownEntityId);

      // Closing the overlay hands the world back: one step still moves the character. ctl-11a: C
      // with its own screen on top acts as Start, which closes the overlay and the menu beneath it.
      await pressAccel(page, 'C');
      await expect(page.locator('#claim-overlay')).toBeHidden({ timeout: 5_000 });
      await expect.poll(() => stackLength(page), { timeout: 5_000 }).toBe(1);
      const from = after.ownAuthTile;
      if (from === null) throw new Error('A2: own tile missing');
      // Spawn row y=1 is floor for x=1..8 (recruit.spec) — East along it never rolls grass.
      await page.evaluate(
        (d) => (window as unknown as Win).__game().step(d),
        from.y === 1 && from.x < 8 ? 'East' : 'North',
      );
      await page.waitForFunction(
        (f) => {
          const g = (window as unknown as Win).__game();
          return g.ownAuthTile !== null && (g.ownAuthTile.x !== f.x || g.ownAuthTile.y !== f.y);
        },
        from,
        { timeout: 8_000 },
      );
    });

    test('A3: declining is two-step — cancel keeps the claim code, confirm deletes it', async () => {
      const [code] = await storedCodes(page);
      expect(code).toMatch(/^[0-9a-f]{64}$/);
      await focusWorld(page);
      await pressAccel(page, 'C');
      await expect(page.locator('#claim-overlay')).toBeVisible({ timeout: 10_000 });

      const confirm = page.locator('#claim-confirm');
      await page.locator('#claim-decline-btn').click();
      await expect(confirm).toContainText(CONFIRM_PREFIX);
      await page.locator('#claim-decline-cancel-btn').click();
      await expect(confirm).toBeHidden();
      expect(await storedCodes(page), 'cancel must delete nothing').toEqual([code]);

      await page.locator('#claim-decline-btn').click();
      await expect(confirm).toContainText(CONFIRM_PREFIX);
      await page.locator('#claim-decline-confirm-btn').click();
      await expect(confirm).toBeHidden();
      await expect.poll(() => storedCodes(page), { timeout: 5_000 }).toEqual([]);
    });
  });
