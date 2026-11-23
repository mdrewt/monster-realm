import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { tf } from '../src/ui/i18n/resolver';
import { closeAll, pressAccel, pressButton } from './controls';
import { ownerSql, sqlRows } from './stdb';

// Three identities that share the client's default name read as distinct Players rows.
//
// THREE-BROWSER DESIGN: three separate chromium.launch() instances, each its own SpacetimeDB
// identity, each joined with the default name (no rename). The third opens Social on the Players
// tab the way a player does (U opens Social on Trades, LB steps to Players) and reads the two other
// rows. The expected tag and level come from owner SQL (`player.discriminator`,
// `player.lead_level`, and the `monster` row in the lowest party slot), with the tag padded here,
// never through the client's formatter.
//
// COLOURS IN THE REAL BROWSER: on the plain row the tag is the muted token (rgb(180, 180, 194) in
// the light-on-dark theme) and differs from its name; on the cursor row (`.is-active`, an inverted
// fill) the tag takes the row's own colour.
//
// WHAT THIS KILLS: same-named players merged into one row or indistinguishable (no tag, or the same
// tag); a tag that is not the minted discriminator; a level that is not the lead monster's, or
// missing; a muted tag on the cursor row; a tag in the name's colour on a plain row.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  stack: Array<{ kind: string; id?: string }>;
}

const MUTED = 'rgb(180, 180, 194)';

/** lowercase + strip a leading 0x (`spacetime sql` renders an Identity as 0x + 64 hex). */
function normalizeIdentity(id: string): string {
  let s = id.trim().toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  return s;
}

/** A `spacetime sql` string cell without its surrounding double quotes. */
function unquote(cell: string): string {
  return cell.length >= 2 && cell.startsWith('"') && cell.endsWith('"') ? cell.slice(1, -1) : cell;
}

/** `#` and the decimal digits, left-padded with `0` to four characters. */
const padTag = (discriminator: number): string => `#${String(discriminator).padStart(4, '0')}`;

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

const snapOf = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => (window as unknown as { __game: () => GameSnap }).__game());

interface PlayerFacts {
  readonly name: string;
  readonly discriminator: number;
  readonly leadLevel: number;
}

/** The `player` row of each identity in `ids`, from owner SQL. */
function playerFacts(ids: readonly string[], label: string): Map<string, PlayerFacts> {
  const rows = sqlRows(
    ownerSql('SELECT identity, name, discriminator, lead_level FROM player', label),
    label,
  );
  const out = new Map<string, PlayerFacts>();
  for (const row of rows) {
    const id = normalizeIdentity(row.identity ?? '');
    if (!ids.includes(id)) continue;
    out.set(id, {
      name: unquote(row.name ?? ''),
      discriminator: Number(row.discriminator),
      leadLevel: Number(row.lead_level),
    });
  }
  for (const id of ids) {
    if (!out.has(id)) throw new Error(`${label}: no player row for ${id}`);
  }
  return out;
}

/** The level of the monster in the lowest party slot (< 255) of each identity in `ids`. */
function leadMonsterLevels(ids: readonly string[], label: string): Map<string, number> {
  const rows = sqlRows(
    ownerSql('SELECT owner_identity, level, party_slot FROM monster', label),
    label,
  );
  const best = new Map<string, { slot: number; level: number }>();
  for (const row of rows) {
    const id = normalizeIdentity(row.owner_identity ?? '');
    if (!ids.includes(id)) continue;
    const slot = Number(row.party_slot);
    if (!(slot < 255)) continue;
    const seen = best.get(id);
    if (seen === undefined || slot < seen.slot) best.set(id, { slot, level: Number(row.level) });
  }
  return new Map([...best].map(([id, v]) => [id, v.level]));
}

test.describe
  .serial('the Players tab tells same-named identities apart by tag and lead level', () => {
    const browsers: Browser[] = [];
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];

    test.beforeAll(async () => {
      test.setTimeout(90_000);
      for (let i = 0; i < 3; i += 1) {
        const browser = await chromium.launch();
        browsers.push(browser);
        const ctx = await browser.newContext();
        contexts.push(ctx);
        pages.push(await ctx.newPage());
      }
      for (const page of pages) await page.goto('/');
      await Promise.all(pages.map((p) => gameReady(p)));
    });

    test.afterAll(async () => {
      for (const ctx of contexts) {
        try {
          await ctx.close();
        } catch {
          // ignore: may already be closed by an error path
        }
      }
      for (const browser of browsers) {
        try {
          await browser.close();
        } catch {
          // ignore
        }
      }
    });

    test('three identities joined with the default name: the third`s Players tab lists the other two with the same name, each its own minted tag in the muted colour and its lead monster`s level, and the cursor row`s tag in the row`s own colour [ih-3.7]', async () => {
      test.setTimeout(120_000);
      const third = pages[2] as Page;
      const ids = (await Promise.all(pages.map(snapOf))).map((s) => normalizeIdentity(s.identity));
      expect(new Set(ids).size, 'three browsers, three identities').toBe(3);
      const [idA, idB] = ids as [string, string, string];

      // Owner SQL: the two others' names, tags and lead levels, and their lead monsters' levels.
      const facts = playerFacts(ids, 'ih-3.7 player rows');
      const factA = facts.get(idA) as PlayerFacts;
      const factB = facts.get(idB) as PlayerFacts;
      expect(factA.name, 'the default name, shared (no rename)').toBe(factB.name);
      expect(factA.name.length, 'a non-empty name').toBeGreaterThan(0);
      expect(factA.discriminator, 'a minted tag').toBeGreaterThan(0);
      expect(factB.discriminator, 'a minted tag').toBeGreaterThan(0);
      expect(factA.discriminator, 'two different tags').not.toBe(factB.discriminator);
      const lead = leadMonsterLevels(ids, 'ih-3.7 monster rows');
      for (const id of [idA, idB]) {
        const f = facts.get(id) as PlayerFacts;
        expect(f.leadLevel, `${id}: a lead level`).toBeGreaterThan(0);
        expect(f.leadLevel, `${id}: the lead level is the lowest party slot's monster's`).toBe(
          lead.get(id),
        );
      }

      // The third opens Social on Players as a player does: U (Trades), then LB.
      await closeAll(third);
      await pressAccel(third, 'U');
      await expect(third.locator('#social-tabs')).toHaveCount(1, { timeout: 5_000 });
      await pressButton(third, 'LB');
      await expect(
        third.locator('#social-tab-players'),
        'LB from Trades is the Players tab',
      ).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });

      const rows = third.locator('#leaderboard-players > [data-nav-key]');
      await expect(rows, 'exactly the two other players').toHaveCount(2, { timeout: 20_000 });
      const keys = (
        await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.navKey ?? ''))
      ).map(normalizeIdentity);
      expect([...keys].sort(), 'the rows are the two other identities').toEqual([idA, idB].sort());
      const byTag = [idA, idB].sort(
        (x, y) =>
          (facts.get(x) as PlayerFacts).discriminator - (facts.get(y) as PlayerFacts).discriminator,
      );
      expect(keys, 'same-named rows in tag-number order').toEqual(byTag);

      for (let i = 0; i < 2; i += 1) {
        const row = rows.nth(i);
        const f = facts.get(keys[i] as string) as PlayerFacts;
        await expect(row.locator('bdi'), `${keys[i]}: the name`).toHaveText(f.name);
        await expect(row.locator('.mr-player-tag'), `${keys[i]}: the minted tag`).toHaveText(
          padTag(f.discriminator),
        );
        await expect(row.locator('.mr-player-level'), `${keys[i]}: the lead level`).toHaveText(
          tf('tactics.hud.level', { level: f.leadLevel }),
        );
      }

      // The colours the browser computes.
      const colours = await rows.evaluateAll((els) =>
        els.map((el) => {
          const tag = el.querySelector('.mr-player-tag');
          const name = el.querySelector('bdi');
          return {
            active: el.classList.contains('is-active'),
            row: getComputedStyle(el).color,
            tag: tag === null ? '' : getComputedStyle(tag).color,
            name: name === null ? '' : getComputedStyle(name).color,
          };
        }),
      );
      const cursorRows = colours.filter((c) => c.active);
      const plainRows = colours.filter((c) => !c.active);
      expect(cursorRows.length, 'one cursor row').toBe(1);
      expect(plainRows.length, 'one plain row').toBe(1);
      const plain = plainRows[0] as (typeof colours)[number];
      const cursor = cursorRows[0] as (typeof colours)[number];
      expect(plain.tag, 'a plain row: the muted tag').toBe(MUTED);
      expect(plain.tag, 'a plain row: the tag is not the name`s colour').not.toBe(plain.name);
      expect(cursor.tag, 'the cursor row: the tag in the row`s own colour').toBe(cursor.row);
      expect(cursor.tag, 'the cursor row: not the muted colour').not.toBe(MUTED);

      await closeAll(third);
    });

    test('two same-named identities each open Profile: the Name section shows the name with the tag the third`s Players tab lists for that identity, the owner-SQL minted tag, in the muted colour [lpw-40.4]', async () => {
      // WRONG IMPL KILLED: a Profile that shows the name alone (no tag element text); a tag read
      // from another field (entity id, lead level) or another player's row; a tag in the name's
      // colour; a tag that differs from the one the Players tab lists for the same identity.
      test.setTimeout(120_000);
      const [pageA, pageB, third] = pages as [Page, Page, Page];
      const ids = (await Promise.all(pages.map(snapOf))).map((s) => normalizeIdentity(s.identity));
      expect(new Set(ids).size, 'three browsers, three identities').toBe(3);
      const [idA, idB] = ids as [string, string, string];
      const facts = playerFacts(ids, 'lpw-40.4 player rows');
      const factA = facts.get(idA) as PlayerFacts;
      const factB = facts.get(idB) as PlayerFacts;
      expect(factA.name, 'the default name, shared').toBe(factB.name);
      expect(factA.discriminator, 'a minted tag').toBeGreaterThan(0);
      expect(factB.discriminator, 'a minted tag').toBeGreaterThan(0);
      expect(factA.discriminator, 'two different tags').not.toBe(factB.discriminator);

      // The third's Players tab: the tag text and colour listed for each identity.
      await closeAll(third);
      await pressAccel(third, 'U');
      await expect(third.locator('#social-tabs')).toHaveCount(1, { timeout: 5_000 });
      await pressButton(third, 'LB');
      await expect(third.locator('#social-tab-players')).toHaveAttribute('aria-selected', 'true', {
        timeout: 5_000,
      });
      const rows = third.locator('#leaderboard-players > [data-nav-key]');
      await expect(rows, 'exactly the two other players').toHaveCount(2, { timeout: 20_000 });
      const listed = (
        await rows.evaluateAll((els) =>
          els.map((el) => {
            const tag = el.querySelector('.mr-player-tag');
            return {
              key: (el as HTMLElement).dataset.navKey ?? '',
              active: el.classList.contains('is-active'),
              text: tag === null ? '' : (tag.textContent ?? ''),
              colour: tag === null ? '' : getComputedStyle(tag).color,
            };
          }),
        )
      ).map((r) => ({ ...r, key: normalizeIdentity(r.key) }));
      const plainRow = listed.find((r) => !r.active);
      expect(plainRow, 'one plain Players row').toBeDefined();
      const plainColour = (plainRow as (typeof listed)[number]).colour;
      expect(plainColour, 'the Players-tab plain-row tag colour').toBe(MUTED);
      await closeAll(third);

      for (const [page, id, fact] of [
        [pageA, idA, factA],
        [pageB, idB, factB],
      ] as const) {
        const players = listed.find((r) => r.key === id);
        expect(players, `${id}: listed by the third`).toBeDefined();
        const playersTag = (players as (typeof listed)[number]).text;
        expect(playersTag, `${id}: the Players tab lists the minted tag`).toBe(
          padTag(fact.discriminator),
        );

        await closeAll(page);
        await pressAccel(page, 'N');
        await expect(page.locator('#profile-overlay')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#rename-current bdi'), `${id}: the name`).toHaveText(fact.name, {
          timeout: 10_000,
        });
        await expect(page.locator('#rename-tag'), `${id}: the minted tag`).toHaveText(
          padTag(fact.discriminator),
          { timeout: 10_000 },
        );
        await expect(
          page.locator('#rename-tag'),
          `${id}: the tag the Players tab lists`,
        ).toHaveText(playersTag);
        const colours = await page.evaluate(() => {
          const tag = document.querySelector('#rename-tag');
          const name = document.querySelector('#rename-current bdi');
          return {
            tag: tag === null ? '' : getComputedStyle(tag).color,
            name: name === null ? '' : getComputedStyle(name).color,
          };
        });
        expect(colours.tag, `${id}: the tag is the Players-tab muted colour`).toBe(plainColour);
        expect(colours.tag, `${id}: the tag is not the name's colour`).not.toBe(colours.name);
        await closeAll(page);
      }
    });

    test('a rename repaints the open Profile frame with the new name and the same tag, and the owner-SQL name and tag agree [lpw-40.3]', async () => {
      // WRONG IMPL KILLED: a Profile that paints the name once on open (the first name stays until a
      // close and reopen); a repaint that drops the tag; a tag recomputed to another number.
      test.setTimeout(120_000);
      const pageA = pages[0] as Page;
      const idA = normalizeIdentity((await snapOf(pageA)).identity);
      const before = (playerFacts([idA], 'lpw-40.3 before') as Map<string, PlayerFacts>).get(
        idA,
      ) as PlayerFacts;
      expect(before.discriminator, 'a minted tag').toBeGreaterThan(0);

      // B holds an unsubmitted valid draft in its open Profile frame while A renames.
      const pageB = pages[1] as Page;
      const idB = normalizeIdentity((await snapOf(pageB)).identity);
      const factB = (playerFacts([idB], 'lpw-40.3 B') as Map<string, PlayerFacts>).get(
        idB,
      ) as PlayerFacts;
      const draftB = `Keep${Date.now() % 100000}`;
      await closeAll(pageB);
      await pressAccel(pageB, 'N');
      await expect(pageB.locator('#rename-input')).toBeFocused({ timeout: 10_000 });
      await pageB.locator('#rename-input').fill(draftB);
      await expect(pageB.locator('#rename-submit'), 'B: a valid draft enables Save').toBeEnabled();

      await closeAll(pageA);
      await pressAccel(pageA, 'N');
      await expect(pageA.locator('#profile-overlay')).toBeVisible({ timeout: 10_000 });
      await expect(pageA.locator('#rename-tag')).toHaveText(padTag(before.discriminator), {
        timeout: 10_000,
      });

      const newName = `Tag${Date.now() % 100000}`;
      const input = pageA.locator('#rename-input');
      await input.fill(newName);
      await input.press('Enter');

      // The frame stays open: the arriving row repaints the name with the same tag.
      await expect(pageA.locator('#profile-overlay'), 'the frame is still open').toBeVisible();
      await expect(pageA.locator('#rename-current bdi'), 'the new name').toHaveText(newName, {
        timeout: 15_000,
      });
      await expect(pageA.locator('#rename-tag'), 'the same tag').toHaveText(
        padTag(before.discriminator),
      );

      const after = (playerFacts([idA], 'lpw-40.3 after') as Map<string, PlayerFacts>).get(
        idA,
      ) as PlayerFacts;
      expect(after.name, 'owner SQL: the new name').toBe(newName);
      expect(after.discriminator, 'owner SQL: the tag is unchanged').toBe(before.discriminator);

      // The row reaches every subscriber in the same transaction broadcast; the wait bounds it.
      await pageB.waitForTimeout(1_500);
      await expect(pageB.locator('#rename-input'), 'B: the draft survives A`s row').toHaveValue(
        draftB,
      );
      await expect(pageB.locator('#rename-submit'), 'B: Save stays enabled').toBeEnabled();
      await expect(pageB.locator('#rename-current bdi'), 'B: its own name').toHaveText(factB.name);
      await expect(pageB.locator('#rename-tag'), 'B: its own tag').toHaveText(
        padTag(factB.discriminator),
      );
      await closeAll(pageB);
      await closeAll(pageA);
    });
  });
