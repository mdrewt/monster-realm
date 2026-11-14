// ui/i18n/catalog.test.ts — m24-s1 RED gating tests for the English catalog: the `// @desc:`
// adjacency scan, the key grammar, catalog-wide shape invariants, and the oneOther-misuse
// proof-of-teeth (SHAPE-01, SHAPE-02, SHAPE-03, SHAPE-06).
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M24-internationalization.spec.md §2.3, §2.6 [I18N-SHAPE-06].
//   memory/projects/monster-realm-m24-s1-plan.md §2 catalog.en.ts, §9 M9/L11/L12/L13.
//
// RED REASON: `client/src/ui/i18n/catalog.en.ts` DOES NOT EXIST YET. The static import below
// fails to resolve at collection, redding every test in this file until the specialist ships it.
//
// KEY-GRAMMAR DEVIATION: segments `[a-z][a-zA-Z0-9]*`, at least two,
// dot-separated. Spec §5.4's own `[a-z0-9]+` rejects the spec's own `chrome.helpHint` example —
// `isValidKey` below encodes the ADR-0205-precedented correction, NOT the spec's literal regex.
//
// `@desc` ADJACENCY (plan §9 L11): the contiguous run of `//` comment lines IMMEDIATELY ABOVE an
// entry line must contain a `// @desc:` line with >=10 non-whitespace characters after the
// marker. An entry line is recognised by LINE-START quoted-key-then-colon so a key merely
// ECHOED inside a comment never counts as an entry (plan §9 L13).
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/ADR/plan
// only.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The comment stripper is IMPORTED, never copied (ADR-0215 single-owner rule).
import { stripComments } from '../../../test-util/stripComments';
import { PRIVACY_PSEUDONYMIZATION_DISCLOSURE } from '../privacyBanner';
import { CATALOG_EN } from './catalog.en';
import { CATALOG_FR } from './catalog.fr';
import { setLocale, tf } from './resolver';

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_EN_PATH = path.join(I18N_DIR, 'catalog.en.ts');
const RAW_SOURCE = readFileSync(CATALOG_EN_PATH, 'utf8');

/** Hand-rolled charCode scanner (no RegExp): >=2 dot-separated segments, each
 *  `[a-z][a-zA-Z0-9]*` — ADR-0256 D5's corrected grammar. */
function isValidKey(key: string): boolean {
  const segments = key.split('.');
  if (segments.length < 2) return false;
  for (const seg of segments) {
    if (seg.length === 0) return false;
    const first = seg.charCodeAt(0);
    if (first < 97 || first > 122) return false; // 'a'-'z'
    for (let i = 1; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      const isLower = c >= 97 && c <= 122;
      const isUpper = c >= 65 && c <= 90;
      const isDigit = c >= 48 && c <= 57;
      if (!isLower && !isUpper && !isDigit) return false;
    }
  }
  return true;
}

/** `indexOf`-loop occurrence counter — no RegExp, reused by the `satisfies Catalog` /
 *  `Object.freeze(` belt-and-braces text pins below. */
function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

interface EntryLine {
  readonly key: string;
  readonly lineIndex: number;
}

/** An entry line is recognised by LINE-START (post-indentation) quoted key immediately followed
 *  by a colon — never a key merely echoed inside a `//` comment (plan §9 L13). */
function scanEntryLines(source: string): EntryLine[] {
  const lines = source.split('\n');
  const out: EntryLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("'")) continue;
    const closeQuote = trimmed.indexOf("'", 1);
    if (closeQuote === -1) continue;
    const afterQuote = trimmed.slice(closeQuote + 1).trimStart();
    if (!afterQuote.startsWith(':')) continue;
    out.push({ key: trimmed.slice(1, closeQuote), lineIndex: i });
  }
  return out;
}

/** For every entry line, walks the contiguous `//` comment block immediately above it and
 *  requires a `// @desc:` line with >=10 non-whitespace characters after the marker. Returns the
 *  keys that FAIL. */
function findDescViolations(source: string): string[] {
  const lines = source.split('\n');
  const violations: string[] = [];
  for (const entry of scanEntryLines(source)) {
    let j = entry.lineIndex - 1;
    let hasDesc = false;
    while (j >= 0) {
      const commentLine = lines[j].trim();
      if (!commentLine.startsWith('//')) break;
      if (commentLine.startsWith('// @desc:')) {
        const rest = commentLine.slice('// @desc:'.length);
        let nonWs = 0;
        for (let k = 0; k < rest.length; k++) {
          const ch = rest[k];
          if (ch !== ' ' && ch !== '\t' && ch !== '\r') nonWs += 1;
        }
        if (nonWs >= 10) hasDesc = true;
      }
      j -= 1;
    }
    if (!hasDesc) violations.push(entry.key);
  }
  return violations;
}

/** [I18N-SHAPE-06]: `oneOther` may only be used, in a locale's catalog source, for a locale
 *  whose Intl.PluralRules category set is exactly {one, other}. Throws naming the locale and its
 *  real category set otherwise. */
function checkOneOtherUsage(localeTag: string, source: string): void {
  if (!source.includes('oneOther(')) return;
  const categories = new Intl.PluralRules(localeTag).resolvedOptions().pluralCategories;
  const isTwoCategory =
    categories.length === 2 && categories.includes('one') && categories.includes('other');
  if (!isTwoCategory) {
    throw new Error(
      `oneOther( used in a catalog for locale '${localeTag}' whose CLDR category set is ${JSON.stringify(categories)} — exceeds {one, other}; author with cldr(...) instead`,
    );
  }
}

// ---------------------------------------------------------------------------
// Sample params + expected literals, transcribed from the
// PRE-MIGRATION battleView.ts/pvpView.ts source (plan R7: this transcription is
// independent of the specialist's later catalog.en.ts authoring, since it is
// written before catalog.en.ts grows past its m24-s1 chrome.* seed).
//
// ---------------------------------------------------------------------------

/** Two sample param sets per parameterised (★) MessageId, DIFFERING IN EVERY
 *  FIELD — numbers included (plan R6). A closure that ignores a numeric-only
 *  param (e.g. `() => 'Acc 50%'`) produces the SAME output for both sets and
 *  dies on the CAT-01 exact-output-equality check below. */
const SAMPLE_PARAMS: Record<string, readonly [Record<string, unknown>, Record<string, unknown>]> = {
  'chrome.status.disconnected': [{ where: 'shop' }, { where: 'trade' }],
  // bt-17 (named intentional change, BT17.1): the 11 parameterised 1v1 `battle.*` keys that sat here
  // (`battle.weather.banner`, `battle.card.{level,hpLine}`, `battle.skill.{pvpSubmit,pveLabel}`,
  // `battle.commands.waiting`, `battle.cure.{option,target}`, `battle.recruit.confirm`,
  // `battle.swap.{pvpSubmit,pveLabel}`) are DELETED with ui/battleView.ts, their only requester
  // (catalogParity DEAD-KEY otherwise); `battle.rewards.{gold,xp}` leave below.
  'pvp.incoming.label': [{ challenger: 'Bob' }, { challenger: 'Dana' }],
  'pvp.outgoing.label': [{ target: 'Alice' }, { target: 'Elliot' }],
  // Evolution.* (5 ★). qf-8 (named intentional change, QF8.1): `evolution.choice.evolve` is
  // RETIRED with the evolution view's choice buttons (catalogParity DEAD-KEY).
  'evolution.card.stats': [
    { level: 7, stage: 1, trust: 'Wary', qualityTime: 1, nutrition: 41 },
    { level: 30, stage: 3, trust: 'Devoted', qualityTime: 4, nutrition: 88 },
  ],
  'evolution.card.ready': [{ species: 'Pyrodrake' }, { species: 'Cindermaw' }],
  'evolution.path.heading': [{ species: 'Pyrodrake' }, { species: 'Cindermaw' }],
  'evolution.gate.metRow': [
    { label: 'Level', current: 'Lv 30', required: 'Lv 20' },
    { label: 'Trust', current: 'Devoted', required: 'Friendly' },
  ],
  'evolution.gate.unmetRow': [
    { label: 'Nutrition', current: '41%', required: '60%' },
    { label: 'Quality time', current: 'Tier 1', required: 'Tier 3' },
  ],
  // Raising.* (1 ★). qf-9 (named intentional change, QF9.2): `raising.card.status`,
  // `raising.card.stats` and `raising.card.train` are RETIRED with the raising screen's monster
  // cards (catalogParity DEAD-KEY); only the inventory row remains.
  'raising.inventory.item': [
    { name: 'Protein', count: 2 },
    { name: 'Iron', count: 5 },
  ],
  // Box.* (2 ★)
  'box.party.emptySlot': [{ slot: 0 }, { slot: 3 }],
  // qf-9 (named intentional change, QF9.1): the Monsters Summary's full-stats line (1 ★); trust is
  // the server-derived tier name, the five stats are numbers, and every field differs between the
  // two sets.
  'box.summary.stats': [
    { trust: 'Wary', attack: 11, defense: 22, speed: 33, spAttack: 44, spDefense: 55 },
    { trust: 'Devoted', attack: 101, defense: 87, speed: 64, spAttack: 120, spDefense: 99 },
  ],
  'box.card.stats': [
    { species: 'Sproutle', level: 5, current: 18, max: 20, percent: 90 },
    { species: 'Emberfang', level: 9, current: 21, max: 21, percent: 100 },
  ],
  // ctl-8c: the food row, the Evolve confirm and the fed line (3 ★).
  'box.feed.item': [
    { name: 'Bait', count: 3 },
    { name: 'Glowberry', count: 12 },
  ],
  'box.evolve.confirm': [
    { name: 'Kip', species: 'Emberfang' },
    { name: 'Sproutle', species: 'Pyroleo' },
  ],
  'box.feedback.fed': [{ name: 'Kip' }, { name: 'Mossling' }],
  // qf-3: the cooling Care row's remaining-cooldown hint (1 ★); hours and minutes are numbers and
  // differ between the two sets.
  'box.sheet.careCooldown': [
    { hours: 5, minutes: 59 },
    { hours: 0, minutes: 1 },
  ],
  // Trade.* (2 ★, side.currency.amount is bigint)
  'trade.side.card': [
    { nickname: 'Sproutle', species: 'Mossback', level: 7, current: 3, max: 9 },
    { nickname: 'Kip', species: 'Duskling', level: 12, current: 20, max: 40 },
  ],
  'trade.side.currency': [{ amount: 250n }, { amount: 1000n }],
  // Shop.* (3 ★, row prices are bigint)
  'shop.buy.row': [
    { name: 'Herb', price: 50n },
    { name: 'Tonic', price: 120n },
  ],
  'shop.sell.row': [
    { name: 'Herb', count: 3, price: 20n },
    { name: 'Tonic', count: 1, price: 60n },
  ],
  'shop.sell.unsellable': [
    { name: 'Charm', count: 2 },
    { name: 'Relic', count: 1 },
  ],
  // The tail batch's 6 ★ keys (leaderboard.row is A's; heal.location,
  // questLog.entry, evolutionNotice.species.fallback/reveal.nicknamed/reveal.anonymous are B's).
  'leaderboard.row': [
    { rating: 1200, wins: 10, losses: 2 },
    { rating: 987, wins: 3, losses: 14 },
  ],
  'heal.location': [{ cost: 'Free' }, { cost: '25 gold' }],
  'questLog.entry': [
    { name: 'quest_001', step: 0 },
    { name: 'quest_kelp', step: 3 },
  ],
  'evolutionNotice.species.fallback': [{ id: 31 }, { id: 44 }],
  'evolutionNotice.reveal.nicknamed': [
    { nickname: 'Sparky', from: 'Flameling', to: 'Flamewing' },
    { nickname: 'Kip', from: 'Mossback', to: 'Duskling' },
  ],
  'evolutionNotice.reveal.anonymous': [
    { from: 'Flameling', to: 'Flamewing' },
    { from: 'Mossback', to: 'Duskling' },
  ],
  // 21r-b2: the privacy countdown / export-status closures (privacyBanner.ts). The four unit keys
  // take a BIGINT `n`: 1157n is past the point where a locale number formatter inserts a grouping
  // separator, and 2^53 + 1 is past exact `Number` precision.
  'privacy.countdown.grace': [{ duration: '2d 3h 4m 5s' }, { duration: '58s' }],
  'privacy.countdown.days': [{ n: 1157n }, { n: 9_007_199_254_740_993n }],
  'privacy.countdown.hours': [{ n: 1157n }, { n: 9_007_199_254_740_993n }],
  'privacy.countdown.minutes': [{ n: 1157n }, { n: 9_007_199_254_740_993n }],
  'privacy.countdown.seconds': [{ n: 1157n }, { n: 9_007_199_254_740_993n }],
  'privacy.export.incomplete': [
    { received: 2, total: 5 },
    { received: 7, total: 9 },
  ],
  'privacy.export.complete': [{ received: 5 }, { received: 12 }],
  // ctl-7d: the four shop success lines (4 ★). `gold` is a bigint, past 2^53 in set B; set B's
  // count quantity is the u32 maximum, past where a locale formatter would group digits.
  'shop.feedback.buy.item': [
    { qty: 2, name: 'Bait', gold: 40n },
    { qty: 3, name: 'Relic', gold: 27_021_597_764_222_979n },
  ],
  'shop.feedback.buy.count': [{ qty: 2 }, { qty: 4_294_967_295 }],
  'shop.feedback.sell.item': [
    { qty: 3, name: 'Berry', gold: 30n },
    { qty: 1, name: 'Tonic', gold: 9_007_199_254_740_993n },
  ],
  'shop.feedback.sell.count': [{ qty: 3 }, { qty: 12 }],
  // ctl-8a: the shop quantity and confirm prompts and the heal question (5 ★). `qty` is a number,
  // `gold` a bigint (past 2^53 in set B), `cost` the heal model's own cost line.
  'shop.qty.buy': [
    { name: 'Herb', qty: 2 },
    { name: 'Tonic', qty: 99 },
  ],
  'shop.qty.sell': [
    { name: 'Berry', qty: 3 },
    { name: 'Relic', qty: 1 },
  ],
  'shop.confirm.buy': [
    { qty: 2, name: 'Bait', gold: 40n },
    { qty: 3, name: 'Relic', gold: 27_021_597_764_222_979n },
  ],
  'shop.confirm.sell': [
    { qty: 3, name: 'Berry', gold: 30n },
    { qty: 1, name: 'Tonic', gold: 9_007_199_254_740_993n },
  ],
  'heal.prompt.question': [{ cost: '25 gold' }, { cost: '2x Herb + 40 gold' }],
  // ts-3 (named intentional change, the Strangler): ctl-8e's `tradePropose.review.summary` is
  // DELETED with the trade-propose wizard. ts-3 adds 7 ★ keys (plan "i18n" ADDED table): the
  // Social › Trades session row's title and marks, the editor's title, a blocked picker row, an
  // item row, the coins row and the collapsed banner line. Names / labels / reasons / marks are
  // caller data carried verbatim; `qty` / `held` / `count` are numbers, `amount` / `balance`
  // bigints (past 2^53 in set B, so a Number round trip or a grouping formatter shows); every field
  // differs between the two sets.
  'trade.row.title': [{ name: 'Bob' }, { name: 'Dana' }],
  'trade.row.marks': [
    { mine: 'Confirmed', theirs: 'Not confirmed' },
    { mine: 'Not confirmed', theirs: 'Confirmed' },
  ],
  'tradeSession.title': [{ name: 'Zed' }, { name: 'Amy' }],
  'tradeSession.row.blocked': [
    { label: 'Kip Lv.7', reason: 'fainted' },
    { label: 'Sproutle Lv.12', reason: 'in battle' },
  ],
  'tradeSession.row.item': [
    { name: 'Herb', qty: 2, held: 5 },
    { name: 'Tonic', qty: 0, held: 9 },
  ],
  'tradeSession.row.coins': [
    { amount: 40n, balance: 900n },
    { amount: 9_007_199_254_740_993n, balance: 27_021_597_764_222_979n },
  ],
  'notice.request.trades': [{ count: 2 }, { count: 5 }],
  // ctl-8f: the Journal detail's step line (questLogView.ts).
  'journal.detail.step': [{ step: 0 }, { step: 4 }],
  // ctl-8g: the Players tab's walk-up line (leaderboardView.ts). `name` is a player-chosen display
  // name: it reaches this closure only in this test, never from the view (I18N-21).
  'social.players.walkUp': [{ name: 'Zed' }, { name: 'Amy' }],
  // ctl-10a (named intentional change): the world interaction chip and the picker / sheet rows
  // (3 ★). `key` is the live A keycap text (the catalog's Enter name, or a raw code), `verb` a
  // resolved interact.verb.* value, `name` an npc id or the healer name; every field differs.
  'interact.chip': [
    { key: 'Enter', verb: 'Talk', name: 'elder_oak' },
    { key: 'KeyZ', verb: 'Shop', name: 'tideglass_shopkeeper' },
  ],
  'interact.choose': [{ key: 'Enter' }, { key: 'Space' }],
  'interact.entry': [
    { verb: 'Talk', name: 'elder_oak' },
    { verb: 'Heal', name: 'Healer' },
  ],
  // ctl-10b (named intentional change): the Challenge confirm names the faced player (1 ★). `name`
  // is a player-chosen display name, carried verbatim.
  'interact.confirm.challenge': [{ name: 'Rival' }, { name: 'Zed' }],
  // ctl-12 (named intentional change): the keycap name of a numpad digit and the Options › Controls
  // capture / swap lines (labels and keycaps are model data, carried verbatim).
  'key.numpad': [{ key: '1' }, { key: '9' }],
  'controls.capture.prompt': [{ label: 'Confirm (A)' }, { label: 'Bag' }],
  'controls.swapped': [
    { key: 'F', label: 'Confirm (A)', otherKey: 'K', otherLabel: 'Info (Y)' },
    { key: 'Q', label: 'Bag', otherKey: 'I', otherLabel: 'Jump (X)' },
  ],
  'controls.swappedSlots': [
    { key: 'Z', otherKey: 'W', label: 'Up' },
    { key: 'N', otherKey: 'M', label: 'Bag' },
  ],
  'controls.swappedUnbound': [
    { key: 'F', label: 'Confirm (A)', otherLabel: 'Info (Y)' },
    { key: 'Q', label: 'Bag', otherLabel: 'Jump (X)' },
  ],
  // ctl-12b (named intentional change): the Options › Controls view's slot cells, Clear cells and
  // cleared line (4 ★). `label` is a controlsModel row label, `key` a glyph() keycap; every field
  // differs between the two sets.
  'controls.slot.primary': [
    { label: 'Confirm (A)', key: 'Enter' },
    { label: 'Bag', key: 'K' },
  ],
  'controls.slot.alt': [
    { label: 'Up', key: 'W' },
    { label: 'Save bug report', key: 'F9' },
  ],
  'controls.clear': [{ label: 'Bag' }, { label: 'Save bug report' }],
  'controls.cleared': [{ label: 'Journal' }, { label: 'Dismiss error' }],
  // ctl-13 (named intentional change): the request banner's two key-free lines (2 ★). `name` is a
  // player-chosen display name, carried verbatim.
  'notice.request.trade': [{ name: 'Bob' }, { name: 'Dana' }],
  'notice.request.challenge': [{ name: 'Bob' }, { name: 'Dana' }],
  // qf-6 (named intentional change): the quest-completion acknowledgement on the status line
  // (2 ★, QF6.4). `name` is the completed quest's id (or several, joined by main.ts), `amount` the
  // gold gained, a bigint; every field differs between the two sets.
  'quest.complete.reward': [
    { name: 'quest_001', amount: 50n },
    { name: 'quest_002', amount: 7n },
  ],
  'quest.complete.done': [{ name: 'quest_001' }, { name: 'quest_002' }],
  // qf-15 (named intentional change, QF15.1): the zone cue on the status line (1 ★). `name` is the
  // destination zone's display name, content data from the zone_def row, carried verbatim; the two
  // sets are NON-shipped names that differ.
  'chrome.status.zoneEntered': [{ name: 'Cobalt Reach' }, { name: 'Umber Fen' }],
  // qf-17 had added `battle.rewards.{gold,xp}` (the 1v1 KO-win payout lines, 363 → 365). bt-17
  // (named intentional change, BT17.1): both are DELETED with the 1v1 view's payout lines; the
  // tactical results panel's `tactics.results.{monster,currency}` lines carry XP and gold.
  // bt-10 (named intentional change, BT10.5/BT10.6): 365 → 425, +29 parameterised `tactics.*` keys
  // (the turn bar's round / surge / retreat badges, the HUD's level / hp / ap / role lines, the
  // ticker's per-event lines and the turn banner). Every field differs between the two sets; names
  // and reason texts are model data carried verbatim, `currency` is a bigint (past 2^53 in set B).
  'tactics.turnbar.round': [{ round: 3 }, { round: 12 }],
  'tactics.turnbar.surgeIn': [{ n: 2 }, { n: 1 }],
  'tactics.turnbar.retreatAt': [{ round: 31 }, { round: 40 }],
  'tactics.hud.level': [{ level: 7 }, { level: 30 }],
  'tactics.hud.hp': [
    { hp: 8, max: 20 },
    { hp: 0, max: 9 },
  ],
  'tactics.hud.ap': [
    { ap: 4, max: 6 },
    { ap: 1, max: 8 },
  ],
  'tactics.hud.role': [{ role: 'Tank' }, { role: 'Healer' }],
  'tactics.ticker.executed': [
    { unit: 'Sprigg', skill: 'Vine Lash' },
    { unit: 'Mossback', skill: 'Ember Jab' },
  ],
  'tactics.ticker.hit': [
    { target: 'Mossback', damage: 12 },
    { target: 'Sprigg', damage: 1 },
  ],
  'tactics.ticker.missed': [
    { unit: 'Sprigg', target: 'Mossback' },
    { unit: 'Flameling', target: 'Kip' },
  ],
  'tactics.ticker.halted': [
    { unit: 'Sprigg', reason: 'out of reach' },
    { unit: 'Kip', reason: 'target gone' },
  ],
  'tactics.ticker.voided': [{ unit: 'Sprigg' }, { unit: 'Kip' }],
  'tactics.ticker.autoPass': [
    { unit: 'Sprigg', strike: 2 },
    { unit: 'Kip', strike: 3 },
  ],
  'tactics.ticker.stoodGround': [{ unit: 'Sprigg' }, { unit: 'Kip' }],
  'tactics.ticker.statusApplied': [
    { unit: 'Sprigg', status: 'Poisoned' },
    { unit: 'Kip', status: 'Frozen' },
  ],
  'tactics.ticker.statusTick': [
    { unit: 'Sprigg', status: 'Burned', amount: 5 },
    { unit: 'Kip', status: 'Poisoned', amount: 12 },
  ],
  'tactics.ticker.statusCured': [
    { unit: 'Sprigg', status: 'Poisoned' },
    { unit: 'Kip', status: 'Asleep' },
  ],
  'tactics.ticker.statusBlocked': [
    { unit: 'Sprigg', status: 'Paralyzed' },
    { unit: 'Kip', status: 'Frozen' },
  ],
  'tactics.ticker.surge': [
    { unit: 'Sprigg', amount: 3 },
    { unit: 'Kip', amount: 11 },
  ],
  'tactics.ticker.ko': [{ unit: 'Sprigg' }, { unit: 'Kip' }],
  'tactics.ticker.recruitOk': [{ target: 'Mossback' }, { target: 'Flameling' }],
  'tactics.ticker.recruitFail': [
    { target: 'Mossback', pct: 42 },
    { target: 'Flameling', pct: 7 },
  ],
  'tactics.ticker.awards': [
    { unit: 'Sprigg', xp: 55, essence: 6, currency: 123n },
    { unit: 'Kip', xp: 0, essence: 12, currency: 9_007_199_254_740_993n },
  ],
  'tactics.ticker.moved': [
    { unit: 'Sprigg', tiles: 3 },
    { unit: 'Kip', tiles: 1 },
  ],
  'tactics.ticker.itemUsed': [
    { unit: 'Sprigg', item: 'Herb', target: 'Kip' },
    { unit: 'Mossback', item: 'Tonic', target: 'Flameling' },
  ],
  'tactics.ticker.turnEnded': [{ unit: 'Sprigg' }, { unit: 'Kip' }],
  'tactics.ticker.guarded': [{ unit: 'Sprigg' }, { unit: 'Kip' }],
  'tactics.ticker.roundEnded': [{ round: 8 }, { round: 25 }],
  'tactics.banner.turn': [{ unit: 'Sprigg' }, { unit: 'Kip' }],
  // bt-11 increment B (named intentional change, BT11.1, plan REV 5 A39): +2 parameterised
  // `tactics.reason.*` keys — the command menu's full-budget reasons, whose `{ap}` is the rules'
  // fresh budget (never a literal 6). The two sets differ (6 is the design ap_turn, 9 is not).
  'tactics.reason.recruitFullAp': [{ ap: 6 }, { ap: 9 }],
  'tactics.reason.fleeFullAp': [{ ap: 6 }, { ap: 9 }],
  // bt-11 increment C (named intentional change, BT11.3/BT11.4/BT11.5, plan REV 6 R6.7; the roster
  // is 486 keys after it): +14 parameterised `tactics.*` keys — the strip's `only N held` note and
  // AP-pip group label, the forecast panel's lines and the Projected assumption line. Every field
  // differs between the two sets; unit / item / status / tile are model data (a name, a resolved
  // status word, an A1 tile) carried verbatim, every other field is a bare number.
  'tactics.badge.onlyHeld': [{ n: 1 }, { n: 3 }],
  'tactics.chip.cost': [{ ap: 5 }, { ap: 11 }],
  'tactics.forecast.vs': [{ unit: 'Mossback' }, { unit: 'Flameling' }],
  'tactics.forecast.hit': [{ pct: 83 }, { pct: 7 }],
  'tactics.forecast.damage': [
    { min: 61, max: 89 },
    { min: 3, max: 5 },
  ],
  'tactics.forecast.typeTimes': [{ num: 2 }, { num: 3 }],
  'tactics.forecast.typeOver': [
    { num: 1, den: 2 },
    { num: 3, den: 4 },
  ],
  'tactics.forecast.flank': [
    { num: 5, den: 4 },
    { num: 7, den: 3 },
  ],
  'tactics.forecast.guard': [
    { num: 3, den: 4 },
    { num: 2, den: 9 },
  ],
  'tactics.forecast.status': [{ status: 'Poisoned' }, { status: 'Asleep' }],
  'tactics.forecast.recruit': [{ pct: 41 }, { pct: 67 }],
  'tactics.forecast.recruitLines': [
    { base: 8, bait: 0, weakened: 31, pct: 41 },
    { base: 12, bait: 19, weakened: 37, pct: 67 },
  ],
  'tactics.forecast.bait': [{ item: 'Lure Berry' }, { item: 'Herb' }],
  'tactics.projected.assumes': [
    { unit: 'Sprigg', tile: 'C4' },
    { unit: 'Mossback', tile: 'E2' },
  ],
  // bt-12 increment A (named intentional change, BT12.2/BT12.4/BT12.6, plan REV 2b B8; the roster is
  // 504 keys after it): +4 parameterised `tactics.*` keys — the deploy panel's slot label and the
  // results panel's monster, gold and recruit lines. Every field differs between the two sets; the
  // names are model data carried verbatim, `n` / `xp` / `essence` are numbers (0 XP in set B, so a
  // falsy fallback shows), `amount` is a bigint past 2^53 in set B.
  'tactics.deploy.slot': [{ n: 1 }, { n: 3 }],
  'tactics.results.monster': [
    { name: 'Sprigg', xp: 53, essence: 7 },
    { name: 'Kip', xp: 0, essence: 11 },
  ],
  'tactics.results.currency': [{ amount: 123n }, { amount: 9_007_199_254_740_993n }],
  'tactics.results.recruited': [{ name: 'Mossback' }, { name: 'Flameling' }],
  // bt-12 increment B (named intentional change, BT12.2, plan §2.9; 511 keys after it): +1
  // parameterised key — the "Still there?" countdown; `s` is a whole-second number (1..60) and
  // differs between the two sets.
  'tactics.clock.stillThere': [{ s: 42 }, { s: 7 }],
  // bt-15 increment A (named intentional change, BT15.1/BT15.5; 512 keys after it): +1 parameterised
  // key — a party-size row of the Challenge pick ("3 vs 3"); `n` is a whole number 1..3 and differs
  // between the two sets.
  'interact.challenge.size': [{ n: 3 }, { n: 1 }],
  // bt-15 increment B (named intentional change, BT15.2/BT15.3/BT15.5; 525 keys after it): +4
  // parameterised `tactics.*` keys — the clock ring's seconds, a player's strikes line, the rating
  // change and the first-game rating. Every field differs between the two sets: `s` / `n` / `max` /
  // `before` / `after` are bare numbers (n 0 in set B, so a falsy fallback shows; max 5 in set B, so
  // a literal 4 shows), `name` is a player name and `delta` the caller's SIGNED string, carried
  // verbatim.
  'tactics.clock.ring': [{ s: 29 }, { s: 4 }],
  'tactics.clock.strikes': [
    { name: 'Marrow', n: 3, max: 4 },
    { name: 'Quill', n: 0, max: 5 },
  ],
  'tactics.results.rating': [
    { before: 1000, after: 984, delta: '-16' },
    { before: 1493, after: 1509, delta: '+16' },
  ],
  'tactics.results.ratingNew': [{ after: 1016 }, { after: 987 }],
  // uif-13 (named intentional change, UIF13.2): +3 parameterised `controls.text.*` keys (the Display
  // tab's row, its live row and the outcome line). `label` is a step label resolved by the caller
  // (carried verbatim); the two sets differ.
  'controls.text.row': [{ label: 'Normal' }, { label: 'Large' }],
  'controls.text.current': [{ label: 'Large' }, { label: 'Extra large' }],
  'controls.text.set': [{ label: 'Normal' }, { label: 'Extra large' }],
  // uif-14 (named intentional change, UIF14.5): +1 parameterised key, the detail sheet's related-
  // mechanics line. `terms` is the caller's already-joined list of related entry terms, carried
  // verbatim; the two sets differ. (Its output is checked by the 'uif-14' describe at the end of this
  // file: the terms appear verbatim and the sets differ; the frame text is authored with the slice.)
  'help.detail.related': [{ terms: 'Party, Storage' }, { terms: 'Bait' }],
};

/** ctl-8a's description "none" mark: U+2014 EM DASH, built by code point (never a pasted glyph). */
const EM_DASH = String.fromCharCode(0x2014);
/** ctl-8c's "opens a list" mark on the Feed… / Evolve… rows: U+2026 HORIZONTAL ELLIPSIS. */
const ELLIPSIS = String.fromCharCode(0x2026);
// bt-17: ctl-8i's CURLY_APOSTROPHE (U+2019 in `battle.command.runPvpReason`) leaves with that key.
/** U+00B7 MIDDLE DOT, the separator of a skill cell (MIDDLE_DOT below is declared after the tables). */
const CELL_DOT = String.fromCharCode(0x00b7);

/** Every PLAIN (non-parameterised) MessageId's expected value, byte-transcribed
 *  from the pre-migration literal at its cited source line (plan R7 — copy-paste
 *  never retype). The 9 `chrome.*` rows are the pre-existing m24-s1 values; the
 *  21 `battle.*`/`pvp.*` rows are m24s3's plain migrated sinks. */
const EXPECTED_PLAIN: Record<string, string> = {
  // ctl-7a (named intentional change): `chrome.helpHint` is DELETED with the #help-hint button it
  // labelled; the two hint-bar chip labels (main.ts writes them into #chip-start / #chip-select at
  // boot) replace it. Net roster delta: -1 +2 = 211 keys.
  // ctl-7d (named intentional change): -2 plain `shop.feedback.*` keys here, +4 parameterised ones
  // in SAMPLE_PARAMS = 213 keys.
  // ctl-8a (named intentional change): +6 plain keys here (the shop tabs and description mark,
  // the shared Yes / No, the heal reason), +5 parameterised ones in SAMPLE_PARAMS = 224 keys.
  // ctl-8b (named intentional change): -1 plain key (`box.card.rename`, deleted with the per-card
  // Rename button and window.prompt) and +7 plain keys (`box.tab.{party,storage}`,
  // `box.sheet.{summary,nickname,move}`, `box.feedback.{movedToParty,movedToBox}`) = 230 keys.
  // ctl-8c (named intentional change): +4 plain keys (`box.sheet.{care,feed,evolve,feedNone}`)
  // here, +3 parameterised ones (`box.feed.item`, `box.evolve.confirm`, `box.feedback.fed`) in
  // SAMPLE_PARAMS = 237 keys.
  // ctl-8d (named intentional change): +12 plain keys here (`social.tab.{players,trades,
  // challenges,rankings}`, `social.players.placeholder`, `social.action.{accept,decline,confirm,
  // cancel}`, `social.confirm.{declineTrade,confirmTrade,declineChallenge}`) = 249 keys.
  // ctl-8e (named intentional change): +9 plain keys here (`tradePropose.step.{target,offer,coins,
  // ask,review}`, `tradePropose.review.{prompt,incomplete,yes,no}`), +1 parameterised one
  // (`tradePropose.review.summary`) in SAMPLE_PARAMS = 259 keys.
  // ctl-8f (named intentional change): +9 plain keys here (`bag.pocket.{bait,food,medicine,other}`,
  // `bag.action.{feed,use,info}`, `bag.picker.title`, `bag.feed.noMonsters`), +1 parameterised one
  // (`journal.detail.step`) in SAMPLE_PARAMS = 269 keys.
  // ctl-8g (named intentional change): +2 plain keys here (`social.players.{nearby,none}`), +1
  // parameterised one (`social.players.walkUp`) in SAMPLE_PARAMS = 272 keys.
  // ctl-8i (named intentional change): +7 plain keys here (`battle.command.{fight,recruit,swap,
  // bag,run}`, `battle.commands.label`, `battle.command.runPvpReason`); in SAMPLE_PARAMS
  // `battle.commands.waiting` is added and `battle.skill.accuracy` removed = 279 keys.
  // ctl-8j (named intentional change): -3 plain keys (`battle.recruit.submit`,
  // `battle.cure.placeholder`, `battle.cure.submit`) and +5 plain keys (`battle.recruit.{listLabel,
  // confirmNoBait,yes,no}`, `battle.cure.listLabel`) here, +2 parameterised ones
  // (`battle.recruit.confirm`, `battle.cure.target`) in SAMPLE_PARAMS = 283 keys.
  // ctl-8k (named intentional change): +2 plain keys (`session.retry`, `session.hint`) = 285 keys.
  // ctl-10a (named intentional change): -1 plain key (`box.heal`, deleted with the Box Heal Party
  // button, CTL10A.4) and +5 plain keys (`interact.verb.{talk,shop,heal}`, `interact.healer`,
  // `key.enter`) here, +3 parameterised ones (`interact.{chip,choose,entry}`) in SAMPLE_PARAMS =
  // 292 keys.
  // ctl-10b (named intentional change): -2 plain keys (`pvp.players.{none,heading}`, deleted with
  // the pvpView player list, CTL10B.2) and +2 plain keys (`interact.verb.{trade,challenge}`) here,
  // +1 parameterised one (`interact.confirm.challenge`) in SAMPLE_PARAMS = 293 keys.
  // qf-8 (named intentional change, QF8.1): -10 plain keys here (`box.card.{toBox,toParty}`,
  // `trade.action.{accept,reject,confirm,cancel}`, `pvp.incoming.{accept,decline}`,
  // `pvp.outgoing.cancel`, `evolution.card.choosePrompt`) and -1 parameterised one
  // (`evolution.choice.evolve`) in SAMPLE_PARAMS, RETIRED with the four views' mouse-only
  // duplicate controls (their only requesters: catalogParity DEAD-KEY otherwise) = 362 keys.
  // `box.hint` changes VALUE only (the id keeps its name): it now names the Monsters sheet's Move.
  // qf-7c (named intentional change, QF7B.1): -1 plain key (`battle.action.flee`, retired with the
  // legacy battle Flee button; the command list's Run is the only flee) = 361 keys.
  'chrome.chip.menu': 'Menu',
  'chrome.chip.help': 'Help',
  // NAMED INTENTIONAL CHANGE (uif-15a, UIF15A.2): values only; was 'Controls & Goals'.
  'chrome.help.title': 'How to Play',
  // NAMED INTENTIONAL CHANGE (uif-14, UIF14.1 / UIF14.4): -7 plain keys here, RETIRED with the
  // All controls / This screen / Goals tabs (`help.tab.{screen,controls,goals}`,
  // `help.goal.{recruit,battle,trade}`, `help.note.keysVsButtons`; their absence is pinned by the
  // 'uif-14' describe at the end of this file and by helpModel.test.ts). The 36 new plain Help ids
  // (`help.tab.{intro,encyclopedia}`, `help.intro.{p1,p2}`, `help.entry.<key>.{term,def}` x 16) are
  // listed by id in UIF14_PLAIN_IDS below; their copy is authored with the slice, so its bytes are not
  // pinned here (the 'uif-14' describe pins the two tab titles, non-empty-ness and en != fr).
  'chrome.rename.submit': 'Rename',
  // ts-3 (named intentional change, the Strangler): 'chrome.tradePropose.submit' ('Offer') is
  // DELETED with the trade-propose wizard.
  'chrome.status.exportBlocked': 'data export: download blocked by the browser',
  // uif-16b (named intentional change, WF1-A10): 'chrome.status.privacyOverlayBusy' is RETIRED
  // with the `privacy-busy` kind (catalogParity DEAD-KEY otherwise).
  'chrome.status.contentStale': 'content out of date — reload',
  'chrome.status.bugBundleBlocked': 'bug bundle: download blocked — copy from console',
  'chrome.status.healUnavailable': 'heal: no heal location available',
  'chrome.status.partyFull': 'party is full — move a monster to the box first',
  // bt-17 (named intentional change, BT17.1): the four `battle.*` keys the tactical panels still
  // read stay (`battle.title`, `battle.outcome.{victory,defeat,fled}`: the deploy / results titles);
  // the 18 plain 1v1 rows that sat here (`battle.continueHint`, `battle.swap.hint`,
  // `battle.pvp.waiting`, `battle.card.{you,opponent}`, `battle.recruit.{noBait,listLabel,
  // confirmNoBait,yes,no}`, `battle.cure.listLabel`, `battle.command.{fight,recruit,swap,bag,run,
  // runPvpReason}`, `battle.commands.label`) are DELETED with ui/battleView.ts (catalogParity
  // DEAD-KEY otherwise).
  'battle.title': 'Battle', // battleView.ts:110 (pre-migration source)
  'battle.outcome.victory': 'Victory!', // battleView.ts:629 (pre-migration source)
  'battle.outcome.defeat': 'Defeat...', // battleView.ts:632 (pre-migration source)
  'battle.outcome.fled': 'Got away safely!', // battleView.ts:635 (pre-migration source)
  'pvp.title.idle': 'PvP', // pvpView.ts:135
  'pvp.title.challenge': 'PvP Challenge', // pvpView.ts:142
  // qf-8 (named intentional change): `pvp.incoming.accept` ('Accept'), `pvp.incoming.decline`
  // ('Decline') and `pvp.outgoing.cancel` ('Cancel Challenge') are RETIRED with the challenge
  // panel's buttons (catalogParity DEAD-KEY); the Social sheet's `social.action.*` rows answer.
  // ctl-10b (named intentional change): `pvp.players.none` ('No players online to challenge') and
  // `pvp.players.heading` ('Challenge:') are RETIRED with the pvpView player list (catalogParity
  // DEAD-KEY); their absence is pinned by CTL10B-2-CATALOG.
  // Evolution.* (5 plain). qf-8 (named intentional change): `evolution.card.choosePrompt` ('Two or
  // more paths are ready — pick one:') is RETIRED with the evolution view's choice picker.
  'evolution.title': 'Evolution', // evolutionView.ts
  'evolution.hint':
    'Each path lists what it needs and how close this monster is. When two or more ' +
    'paths are ready at once, you choose which one to take.', // evolutionView.ts
  'evolution.monsters.empty': 'No monsters yet.', // evolutionView.ts
  'evolution.card.noPaths': 'No evolution paths.', // evolutionView.ts
  'evolution.path.allMet': 'All requirements met.', // evolutionView.ts
  // Raising.* (3 plain)
  // qf-9 (named intentional change, QF9.2): -3 plain keys here (`raising.monsters.heading`
  // 'Monsters', `raising.monsters.empty` 'No monsters.', `raising.card.care` 'Care'), RETIRED with
  // the raising screen's Monsters section, and -3 parameterised ones in SAMPLE_PARAMS
  // (`raising.card.{status,stats,train}`); +1 parameterised one (`box.summary.stats`, QF9.1) =
  // 373 keys. Their absence is pinned by the 'qf-9' describe at the end of this file.
  // qf-10 (named intentional change, QF10.4): the value was 'Raising & Inventory'; the id is unchanged.
  'raising.title': 'Inventory', // raisingView.ts
  'raising.inventory.empty': 'No items.', // raisingView.ts
  // Box.* (18 plain: 11, -box.card.rename, +7 ctl-8b keys, +4 ctl-8c keys, -box.heal ctl-10a,
  // -box.card.{toBox,toParty} qf-8)
  // ctl-10a (named intentional change): `box.heal` ('Heal Party') is DELETED with the Box Heal
  // Party button: healing happens only at a bound healer (CTL10A.4, B13).
  // qf-8 (named intentional change, QF8.1): `box.card.toBox` ('To Box') and `box.card.toParty`
  // ('To Party') are RETIRED with the cards' buttons; a move is the Monsters sheet's Move row, and
  // `box.hint` (the same id, a new VALUE) now quotes that row's label (`box.sheet.move`) verbatim.
  // qf-10 (named intentional change, QF10.4): VALUES only, the legacy ids are kept: `box.title`
  // was 'Party & Box', `box.section.box` 'Box', `box.box.empty` 'No monsters in box.', and
  // `box.hint` said 'arrive in your Box'.
  'box.title': 'Monsters', // boxView.ts
  'box.hint':
    'Only monsters in your Party can battle or be swapped in. New recruits arrive in Storage ' +
    `${EM_DASH} select one there and choose "Move" to bring it into an open party slot.`, // boxView.ts
  // uif-6 (named intentional change, UIF6.5 / UIF6.6): -2 plain keys (`box.section.party` 'Party' and
  // `box.section.box` 'Storage', RETIRED with the two in-panel h3 headings, R-qf-10-QF10.2:
  // catalogParity DEAD-KEY otherwise) and +2 plain keys (`box.storage.emptyCue`,
  // `box.storage.emptyNext`, the empty Storage EmptyState's cue and next step; the reason line is
  // the existing `box.box.empty`) = a net zero, the roster stays 494 keys. The en bytes of the two
  // new keys are pinned HERE (the implementer copies them); the fr texts are pinned by the uif-6
  // describe at the end of this file (plain strings, different from the en ones).
  'box.box.empty': 'No monsters in storage.', // boxView.ts
  'box.storage.emptyCue': 'Monsters you recruit are kept here.', // boxView.ts
  'box.storage.emptyNext': 'Recruit a wild monster in battle, then come back.', // boxView.ts
  'box.card.evolveBadge': '★ Ready to evolve — choose a path', // boxView.ts
  'box.rename.prompt': 'New nickname:', // boxView.ts (ctl-8b: the typing row's label; was prompt())
  // ctl-8b: the Monsters frame's tab labels, action-sheet rows and Move feedback lines. The check
  // mark of a Move line is the CSS ::before of `.mr-frame-feedback[data-feedback="ok"]`, so the
  // catalog text carries none.
  'box.tab.party': 'Party', // boxView.ts
  'box.tab.storage': 'Storage', // boxView.ts
  'box.sheet.summary': 'Summary', // boxView.ts
  'box.sheet.nickname': 'Nickname', // boxView.ts
  'box.sheet.move': 'Move', // boxView.ts
  'box.feedback.movedToParty': 'Moved to party', // boxView.ts
  'box.feedback.movedToBox': 'Moved to storage', // boxView.ts
  // ctl-8c: the action sheet's Care / Feed… / Evolve… rows (the ellipsis marks a row that opens a
  // list) and the reason a Feed… row is disabled when the player holds no food.
  'box.sheet.care': 'Care', // boxView.ts
  'box.sheet.feed': `Feed${ELLIPSIS}`, // boxView.ts
  'box.sheet.evolve': `Evolve${ELLIPSIS}`, // boxView.ts
  'box.sheet.feedNone': 'No food', // boxView.ts
  // Trade.* (2 plain). ts-4.6: no offer-side heading (`trade.side.{offer,receive}`) is a catalog id;
  // the trade root lists session rows only.
  'trade.status.none': 'No active trade', // tradeView.ts
  'trade.side.nothing': '(nothing)',
  // Shop.* (6 plain)
  'shop.title': 'Shop', // shopView.ts
  'shop.noShop': 'No shop available.', // shopView.ts
  'shop.forSale.empty': 'Nothing for sale.', // shopView.ts
  'shop.inventory.empty': 'No items to sell.', // shopView.ts
  'shop.buy.submit': 'Buy', // shopView.ts
  'shop.sell.submit': 'Sell', // shopView.ts
  // The tail batch's 10 plain keys. ts-3 (named intentional change, the Strangler):
  // 'tradePropose.target.placeholder' ('Select a player…') is DELETED with the wizard; 9 remain.
  'dialogue.action.shop': 'Shop', // dialogueView.ts:72
  'claim.signInButton': 'Sign in', // claimView.ts (resolved in render()/show())
  'claim.joinButton': 'Continue playing', // claimView.ts (resolved in render()/show())
  'claim.declineButton': 'Decline', // claimView.ts (resolved in render()/show())
  'claim.declineConfirmButton': 'Yes, decline', // claimView.ts (resolved in render()/show())
  'claim.declineCancelButton': 'Keep my code', // claimView.ts (resolved in render()/show())
  'leaderboard.empty': 'No ranked players yet', // leaderboardView.ts:60
  // ctl-13 (named intentional change): the overlay is a toast that B dismisses at the world, so the
  // footer names B as well as F8. Was: 'F8 dismiss · F9 bug report'.
  'errorOverlay.footer': `B or F8 dismiss ${CELL_DOT} F9 bug report`, // errorOverlayView.ts (resolved in show())
  'privacy.title': 'Privacy & Account Data', // privacyView.ts (resolved in show())
  'privacy.close': 'Close', // privacyView.ts (resolved in show())
  // The pinned compliance wording, read from its one definition: the en value is that constant
  // byte for byte (the French twin is a translation, pinned by privacyView.i18n.test.ts).
  'privacy.disclosure': PRIVACY_PSEUDONYMIZATION_DISCLOSURE, // privacyView.ts (resolved in show())
  'privacy.confirm.delete': 'Confirm deletion', // privacyView.ts
  'privacy.confirm.keep': 'Keep my account', // privacyView.ts
  'evolutionNotice.ok': 'OK', // evolutionNotice.ts (resolved in render())
  // 21r-b: 15 new plain keys — shop/trade reducer feedback, the rename confirmation, the
  // trade-propose confirmation and the six session-overlay strings (sessionModel.ts:124-134).
  // Every value is byte-transcribed from the pre-migration literal at the cited main.ts/
  // sessionModel.ts line (memory/projects/monster-realm-21r-b-plan.md's key table).
  // ctl-7d (named intentional change): the two fixed shop lines 'shop.feedback.purchased' and
  // 'shop.feedback.sold' are DELETED; the four parameterised `shop.feedback.{buy,sell}.{item,count}`
  // lines (SAMPLE_PARAMS / EXPECTED_PARAM_OUTPUTS) replace them, so 13 of these 15 remain.
  'chrome.feedback.disconnected': 'disconnected — try again', // careAction.ts:72 (performCare) / sessionModel.ts
  // ts-4.6: no `trade.feedback.*` line is a catalog id (no offer-based trade command settles).
  'chrome.rename.updated': 'Name updated!', // main.ts:2801
  // ts-3 (named intentional change, the Strangler): 'tradePropose.feedback.sent' ('Offer sent!')
  // is DELETED with the wizard (no success toast: the editor is the feedback); 12 of the 15 remain.
  'chrome.session.expired.title': 'Session expired', // sessionModel.ts:124
  'chrome.session.expired.body':
    'Your sign-in has expired. Sign in again to keep saving progress across your devices, or ' +
    'continue as a guest on this one.', // sessionModel.ts:125-126
  'chrome.session.unreachable.title': 'Sign-in service unavailable', // sessionModel.ts:127
  'chrome.session.unreachable.body':
    'We could not reach the sign-in service. Your account is safe — the game keeps retrying ' +
    'in the background, or you can continue as a guest for now.', // sessionModel.ts:128-129
  'chrome.session.continue': 'Continue as guest', // sessionModel.ts:130
  'chrome.session.confirmPrompt':
    'Continuing as a guest gives up this account session on this tab and cannot be undone. ' +
    'Continue as a guest?', // sessionModel.ts:133-134
  // 21r-b2: 38 new plain keys — the claim overlay's 23 (claimModel.ts) and the privacy surface's
  // 15 (privacyBanner.ts). Every value is byte-transcribed from the pre-migration literal at the
  // cited line (memory/projects/monster-realm-21r-b2-plan.md's key table).
  'claim.feedback.veto': 'Finish or decline the pending claim before rejoining.', // claimModel.ts:96
  'claim.nudge': 'Guest progress transfers only from the device you claim it on.', // claimModel.ts:320
  'claim.decline.confirmPrompt':
    'Declining permanently deletes this claim code — your guest progress cannot be undone once ' +
    'the code is gone. Decline and continue as a guest?', // claimModel.ts:321-322
  'claim.pending.title': 'Keep your guest progress', // claimModel.ts:324
  'claim.pending.body':
    'Sign in to claim the progress you made as a guest, or decline to keep playing as a guest ' +
    'on this device.', // claimModel.ts:325-326
  'claim.awaiting.title': 'Finishing your claim', // claimModel.ts:327
  'claim.awaiting.body':
    'Waiting for your account to be ready before your guest progress can transfer.', // claimModel.ts:328-329
  'claim.claimed.title': 'Progress claimed', // claimModel.ts:330
  'claim.claimed.body': 'Your guest progress is now attached to your account.', // claimModel.ts:331
  'claim.signInFailed.title': 'Sign-in did not finish', // claimModel.ts:381
  'claim.signInFailed.rejected': 'Sign-in was rejected. Please try signing in again.', // claimModel.ts:353
  'claim.signInFailed.expired': 'That sign-in link expired. Please try signing in again.', // claimModel.ts:354
  'claim.signInFailed.declined': 'Sign-in was cancelled. You can try again whenever you are ready.', // claimModel.ts:355
  'claim.signInFailed.unreachable':
    'We could not reach the sign-in service. Please try again in a moment — your guest ' +
    'progress is safe.', // claimModel.ts:356-357
  'claim.signInFailed.fallback':
    'Sign-in did not complete. Please try again — your guest progress is safe.', // claimModel.ts:363
  'claim.reject.unusable.title': 'That claim code is no longer usable', // claimModel.ts:335
  'claim.reject.unusable.body':
    'This claim code has already been used or has expired. You can keep playing on this ' +
    'device.', // claimModel.ts:336
  'claim.reject.destination.title': 'This account cannot take that progress', // claimModel.ts:339
  'claim.reject.destination.body':
    'This account already has game data, so the guest progress cannot be moved onto it. The ' +
    'claim code is still valid on another account.', // claimModel.ts:340
  'claim.reject.transient.title': 'Not ready to claim yet', // claimModel.ts:343
  'claim.reject.transient.body':
    'The claim could not complete right now — close your other tab or finish your current ' +
    'battle, then try again.', // claimModel.ts:344
  'claim.reject.generic.title': 'Could not complete the claim', // claimModel.ts:347
  'claim.reject.generic.body':
    'Signing in is required before this progress can be claimed. Your guest progress is safe.', // claimModel.ts:348
  'privacy.countdown.dark': 'Account deletion pending — time remaining unavailable', // privacyBanner.ts:31
  'privacy.countdown.due': 'Account deletion is due now', // privacyBanner.ts:32
  'privacy.notice.terminal':
    'This account has already been permanently deleted. It cannot be restored.', // privacyBanner.ts:126-127
  'privacy.notice.disconnected': 'Not connected — your request was not sent. Try again.', // privacyBanner.ts:131
  'privacy.status.active': 'This account is active.', // privacyBanner.ts:133
  'privacy.status.unknown': 'Account status unavailable.', // privacyBanner.ts:134
  'privacy.status.terminal': 'This account has been permanently deleted.', // privacyBanner.ts:135
  'privacy.export.none': 'No data export has arrived on this device yet.', // privacyBanner.ts:147
  'privacy.export.incompleteDark': 'Data export incomplete — some chunks are missing.', // privacyBanner.ts:150
  'privacy.export.inconsistent':
    'Data export could not be assembled — the delivered chunks do not describe one request. ' +
    'Request it again.', // privacyBanner.ts:151-153
  'privacy.action.delete': 'Delete my account', // privacyBanner.ts:157
  'privacy.confirm.prompt': 'This cannot be undone. Confirm deletion?', // privacyBanner.ts:158
  'privacy.action.cancel': 'Cancel account deletion', // privacyBanner.ts:159
  'privacy.action.export': 'Request my data export', // privacyBanner.ts:160
  'privacy.action.download': 'Download my data export', // privacyBanner.ts:164
  'raising.feedback.cared': 'Cared!', // careAction.ts CARED_MESSAGE (pre-migration)
  // ctl-5: 29 new plain keys — the main menu and its three sub-lists (ui/menuModel.ts
  // MENU_ENTRIES). All plain: titles and Y-feedback descriptions; none take parameters.
  'menu.title': 'Menu',
  'menu.monsters.title': 'Monsters',
  'menu.monsters.desc': 'See your party and stored monsters.',
  // NAMED INTENTIONAL CHANGE (uif-15a, UIF15A.1): values only; was 'Bag'. The key keeps its id.
  'menu.bag.title': 'Inventory',
  'menu.bag.desc': 'Use items and care for your monsters.',
  'menu.journal.title': 'Journal',
  'menu.journal.desc': 'Review your quests and their progress.',
  'menu.social.title': 'Social',
  'menu.social.desc': 'Trades, challenges and rankings with other players.',
  'menu.profile.title': 'Profile',
  'menu.profile.desc': 'Your name, account and privacy settings.',
  // NAMED INTENTIONAL CHANGE (uif-15c, UIF15C.5): -2 plain keys here, `menu.options.{title,desc}`
  // ('Options', 'Help on how to play the game.'), RETIRED with the Options group (no menu row reads
  // them: catalogParity DEAD-KEY otherwise). Their absence is pinned by the 'UIF15C.5' test at the
  // end of this file.
  'menu.close.title': 'Close',
  'menu.close.desc': 'Close the menu and return to the world.',
  // NAMED INTENTIONAL CHANGE (uif-15b, UIF15B.1): -6 plain keys here, RETIRED with the Social sub-list
  // (`menu.social.{trades,challenges,rankings}.{title,desc}`; the root Social row opens the Social frame
  // directly, so no menu row reads them: catalogParity DEAD-KEY otherwise) = 530 keys. Was 536. Their
  // absence is pinned by the 'uif-15b' describe at the end of this file.
  // uif-16b (named intentional change, UIF16B.1): -4 plain keys here, RETIRED with the Profile
  // sub-list (`menu.profile.{name,account,privacy}.desc`, `menu.profile.privacy.title`; the
  // Privacy section header reads `privacy.title`), plus `chrome.status.privacyOverlayBusy` above
  // (WF1-A10) = 526 keys. Was 531. `menu.profile.{name,account}.title` stay: the section headers.
  'menu.profile.name.title': 'Name',
  'menu.profile.account.title': 'Account',
  // NAMED INTENTIONAL CHANGE (uif-15c, UIF15C.5): `menu.options.help.{title,desc}` is RE-HOMED as
  // `menu.help.{title,desc}` (the root How to Play row), a net zero. The title VALUE changes to match
  // the frame it opens (`chrome.help.title`); was 'How to play'. The desc is unchanged.
  'menu.help.title': 'How to Play',
  'menu.help.desc': 'Controls and goals of the game.',
  // ctl-6c: 2 new plain keys — the reasons a main-menu entry is disabled over a battle
  // (ui/screens/mainMenuScreen.ts), the first also the dispatch refusal line (main.ts).
  'menu.disabled.inBattle': 'Not during a battle',
  // NAMED INTENTIONAL CHANGE (uif-15a, UIF15A.3): values only; was '…battle Bag command'.
  'menu.disabled.battleBag': 'Use items from the battle Items command',
  // ctl-8a: 6 new plain keys — the Buy | Sell tab labels and the description slot's "none" mark
  // (shopView.ts), the shared Yes / No prompt options (shopView.ts, healView.ts), and the reason a
  // heal frame with no bound healer is disabled (healView.ts).
  'shop.tab.buy': 'Buy',
  'shop.tab.sell': 'Sell',
  'shop.description.none': EM_DASH,
  'prompt.yes': 'Yes',
  'prompt.no': 'No',
  'heal.prompt.unavailable': 'No healer in reach. Healing is unavailable.',
  // ctl-8d: 12 new plain keys — the Social frame's four tab labels, the Players tab's placeholder,
  // the action sheet's four rows and the three Yes / No questions (all painted by tradeView.ts).
  'social.tab.players': 'Players',
  'social.tab.trades': 'Trades',
  'social.tab.challenges': 'Challenges',
  'social.tab.rankings': 'Rankings',
  // ts-6b-10 (named intentional change): `social.players.placeholder` is retired with the Players
  // tab's placeholder path (Players opens on the leaderboard panel). Was: 'The player list is not
  // available yet.'
  // ts-4.6: the sheet's three rows and its one question (no offer-based trade row is listed).
  'social.action.accept': 'Accept',
  'social.action.decline': 'Decline',
  'social.action.cancel': 'Cancel',
  'social.confirm.declineChallenge': 'Decline this challenge?',
  // ts-3 (named intentional change, the Strangler): ctl-8e's 9 plain wizard keys
  // (`tradePropose.step.{target,offer,coins,ask,review}`, `tradePropose.review.{prompt,incomplete,
  // yes,no}`) are DELETED with the trade-propose wizard. ts-3 adds 18 plain keys, byte-transcribed
  // from memory/projects/monster-realm-ts-3-plan.md's "i18n" ADDED table: the Trades status line
  // with sessions and no legacy offer (tradeView.ts), and the session editor's side headings, mark
  // words, unavailable reasons, action rows, prompts and notices (tradeSessionView.ts / main.ts).
  'trade.status.open': 'Open trades',
  'tradeSession.side.mine': 'Your offer',
  'tradeSession.side.theirs': 'Their offer',
  'tradeSession.mark.confirmed': 'Confirmed',
  'tradeSession.mark.unconfirmed': 'Not confirmed',
  'tradeSession.reason.fainted': 'fainted',
  'tradeSession.reason.inAnotherTrade': 'in another trade',
  'tradeSession.reason.inBattle': 'in battle',
  'tradeSession.reason.limit': 'offer is full',
  'tradeSession.reason.unsent': 'update your offer first',
  'tradeSession.reason.nothingToSend': 'no changes',
  'tradeSession.row.apply': 'Update offer',
  'tradeSession.row.confirm': 'Confirm trade',
  'tradeSession.row.cancel': 'Cancel trade',
  'tradeSession.prompt.confirm': 'Confirm this trade? A completed trade cannot be undone.',
  // ts-6b-10 (named intentional change): the confirm question for a side that offers a monster
  // names the bond reset (R-21r-e-E1).
  'tradeSession.prompt.confirmMonsters':
    'Confirm this trade? A completed trade cannot be undone. Traded monsters lose their trust and quality time with you, even if traded back.',
  'tradeSession.prompt.cancel': 'Cancel this trade?',
  'tradeSession.notice.changed': 'The offer changed. Review it before you confirm.',
  'tradeSession.notice.closed': 'Trade closed.',
  // ctl-8f (named intentional change): 9 new plain keys — the Bag frame's pocket tabs, item
  // actions, picker title and the no-monster reason (raisingView.ts).
  'bag.pocket.bait': 'Bait',
  'bag.pocket.food': 'Food',
  'bag.pocket.medicine': 'Medicine',
  'bag.pocket.other': 'Other',
  'bag.action.feed': 'Feed',
  'bag.action.use': 'Use',
  'bag.action.info': 'Info',
  'bag.picker.title': 'Feed which monster?',
  'bag.feed.noMonsters': 'No monsters to feed',
  // ctl-8g (named intentional change): 2 new plain keys — the Players tab's "Nearby" badge and the
  // line shown when nobody else is online (leaderboardView.ts).
  'social.players.nearby': 'Nearby',
  'social.players.none': 'No other players online',
  // ctl-8k (named intentional change): 2 new plain keys — the session gate's Retry label and its
  // frame hint that B and Start are inert (sessionModel.ts, painted by sessionView.ts).
  'session.retry': 'Retry',
  'session.hint': 'B and Start do nothing here. Tab moves, Enter chooses.',
  // ctl-10a (named intentional change): 5 new plain keys — the three interaction verbs the world
  // chip and the picker rows name, the healer's display name (a heal location has no npc id), and
  // the catalog's name for the Enter keycap (main.ts).
  'interact.verb.talk': 'Talk',
  'interact.verb.shop': 'Shop',
  'interact.verb.heal': 'Heal',
  'interact.healer': 'Healer',
  'key.enter': 'Enter',
  // ctl-10b (named intentional change): 2 new plain keys — the verbs a faced player's picker rows
  // name (the Challenge confirm prompt is the parameterised `interact.confirm.challenge`).
  'interact.verb.trade': 'Trade',
  'interact.verb.challenge': 'Challenge',
  // ctl-12 (named intentional change): +38 plain keys — the named keycaps (input/glyphs.ts) and the
  // Options › Controls row labels and feedback lines (ui/controlsModel.ts); +5 parameterised ones in
  // SAMPLE_PARAMS = 336 keys.
  'key.numpadEnter': 'Num Enter',
  'key.backspace': '\u232b',
  'key.space': 'Space',
  'key.escape': 'Esc',
  'key.arrowUp': '\u2191',
  'key.arrowDown': '\u2193',
  'key.arrowLeft': '\u2190',
  'key.arrowRight': '\u2192',
  'key.pageUp': 'PgUp',
  'key.pageDown': 'PgDn',
  'key.slash': '/',
  'controls.button.up': 'Up',
  'controls.button.down': 'Down',
  'controls.button.left': 'Left',
  'controls.button.right': 'Right',
  'controls.button.a': 'Confirm (A)',
  'controls.button.b': 'Back (B)',
  'controls.button.x': 'Jump (X)',
  'controls.button.y': 'Info (Y)',
  'controls.button.lb': 'Previous tab (LB)',
  'controls.button.rb': 'Next tab (RB)',
  'controls.button.start': 'Menu (Start)',
  'controls.button.select': 'Help (Select)',
  'controls.accel.storage': 'Storage',
  // NAMED INTENTIONAL CHANGE (uif-15a, UIF15A.3): values only; was 'Bag'. The key keeps its id.
  'controls.accel.bag': 'Inventory',
  'controls.accel.party': 'Party',
  'controls.accel.journal': 'Journal',
  'controls.accel.trades': 'Trades',
  'controls.accel.challenges': 'Challenges',
  'controls.accel.rankings': 'Rankings',
  'controls.accel.name': 'Name',
  'controls.accel.account': 'Account',
  'controls.accel.bugReport': 'Save bug report',
  'controls.accel.dismissError': 'Dismiss error',
  // qf-14 (named intentional change, QF14.1): +1 plain key, the Shortcuts-tab / Help label of the
  // Controls accelerator Y = 362 keys (the French text, 'Commandes', is pinned at the file's end).
  'controls.accel.controls': 'Controls',
  'controls.refused.reserved': 'That key belongs to the browser and cannot be bound.',
  'controls.refused.protected': 'Movement, Confirm, Back and Menu must always keep a key.',
  'controls.cancelled': 'Unchanged.',
  'controls.bound': 'Saved.',
  // ctl-12b (named intentional change): +11 plain keys — the Controls view's title, tab labels,
  // empty-slot mark, Reset all row, its question and outcome, the Cancel chip and the save-failed
  // line (ui/controlsView.ts), and the Options › Controls menu leaf (ui/menuModel.ts); +4
  // parameterised ones in SAMPLE_PARAMS = 351 keys.
  'controls.title': 'Controls',
  'controls.tab.buttons': 'Buttons',
  'controls.tab.shortcuts': 'Shortcuts',
  'controls.slot.none': EM_DASH,
  'controls.resetAll': 'Reset all',
  'controls.reset.question': 'Reset every control to its default?',
  'controls.reset.done': 'All controls are back to their defaults.',
  'controls.cancel': 'Cancel',
  'controls.saveFailed': 'Could not save: this lasts until you reload.',
  // NAMED INTENTIONAL CHANGE (uif-15c, UIF15C.5): `menu.options.controls.{title,desc}` is RE-HOMED as
  // `menu.controls.{title,desc}` (the root Controls row), values unchanged, a net zero.
  'menu.controls.title': 'Controls',
  'menu.controls.desc': 'Choose which key presses each button.',
  // ctl-13 (named intentional change): +10 plain keys — the hint bar's six verbs
  // (`chrome.chip.{ok,back,close,view,dismiss,done}`), the "New" badge (`chrome.badge.request`,
  // shown on the Start chip and in the Social menu row as real text) and the request sheet's three
  // rows (`notice.sheet.{accept,decline,view}`); +2 parameterised ones (`notice.request.{trade,
  // challenge}`) in SAMPLE_PARAMS = 363 keys. `errorOverlay.footer` changes text (above): the toast
  // names B as well as F8.
  'chrome.chip.ok': 'OK',
  'chrome.chip.back': 'Back',
  'chrome.chip.close': 'Close',
  'chrome.chip.view': 'View',
  'chrome.chip.dismiss': 'Dismiss',
  'chrome.chip.done': 'Done',
  'chrome.badge.request': 'New',
  'notice.sheet.accept': 'Accept',
  'notice.sheet.decline': 'Decline',
  'notice.sheet.view': 'View',
  // qf-4 (named intentional change): +2 plain keys = 373 keys. `journal.title` is the visible
  // title of the Journal frame (QF4.1, `#quest-log-title`); `journal.empty` is the empty-state line
  // shown when no quest is active (QF4.2, `#quest-log-empty`): the reason, then the next step.
  'journal.title': 'Journal',
  'journal.empty': 'No active quests yet. Talk to villagers to find out who needs help.',
  // qf-6 (named intentional change): +3 plain keys here, +2 parameterised ones
  // (`quest.complete.{reward,done}`) in SAMPLE_PARAMS = 378 keys. A refused advance that ends the
  // conversation says so and why on the status line (QF6.2), never the raw reducer reason.
  'dialogue.ended.walkedAway': 'Conversation ended: you moved too far away.',
  'dialogue.ended.leftZone': 'Conversation ended: you left the area.',
  'dialogue.ended.npcGone': 'Conversation ended: they are no longer here.',
  // bt-10 (named intentional change, BT10.5/BT10.6): 365 → 425, +60 `tactics.*` keys — these 31 plain
  // ones (tactics/strings.ts is their only requester) and the 29 parameterised ones in SAMPLE_PARAMS /
  // EXPECTED_PARAM_OUTPUTS. The English texts are chosen so each differs from its French twin
  // (tactics/strings.test.ts asserts fr != en for every key): status words are adjectives
  // ("Poisoned"), the territorial stance is spelled out ("Holds its turf").
  'tactics.board.label': 'Battlefield',
  'tactics.dock.label': 'Commands',
  'tactics.ticker.label': 'Battle log',
  'tactics.turnbar.label': 'Turn order',
  'tactics.turnbar.locked': 'Plan locked',
  'tactics.turnbar.surgeActive': 'Surge!',
  'tactics.hud.guard': 'Guard',
  'tactics.hud.firstStand': 'First Stand',
  'tactics.stance.aggressive': 'Aggressive',
  'tactics.stance.territorial': 'Holds its turf',
  'tactics.stance.skittish': 'Skittish',
  'tactics.status.poison': 'Poisoned',
  'tactics.status.burn': 'Burned',
  'tactics.status.paralysis': 'Paralyzed',
  'tactics.status.sleep': 'Asleep',
  'tactics.status.freeze': 'Frozen',
  'tactics.intent.attack': 'Attack',
  'tactics.intent.move': 'Move',
  'tactics.intent.hold': 'Hold',
  'tactics.halt.targetGone': 'target gone',
  'tactics.halt.outOfReach': 'out of reach',
  'tactics.halt.cannotAct': 'cannot act',
  'tactics.halt.itemNotHeld': 'item not held',
  'tactics.halt.unaffordable': 'cannot afford it',
  'tactics.halt.partyFull': 'party full',
  'tactics.halt.notAllowed': 'not allowed',
  'tactics.ticker.battleStarted': 'The battle begins',
  'tactics.ticker.won': 'You won the battle',
  'tactics.ticker.lost': 'You lost the battle',
  'tactics.ticker.fled': 'The battle ended: fled',
  'tactics.ticker.battleEnded': 'Battle over',
  // bt-11 increment B (named intentional change, BT11.1 / BT11.2 / BT11.3 / BT11.6, plan REV 5 A39):
  // +26 plain `tactics.*` keys (the command menu's rows and reasons, the queue strip's label, the
  // Too-late notice, the ghost and the three dock buttons; tactics/strings.ts is their only
  // requester) and +7 plain `chrome.chip.*` hint-bar verbs (ui/hintBarModel.ts requests them); the
  // 2 parameterised reasons are in SAMPLE_PARAMS / EXPECTED_PARAM_OUTPUTS. U+2014 by code point.
  'tactics.menu.label': 'Command menu',
  'tactics.menu.move': 'Move',
  'tactics.menu.skills': 'Skills',
  // NAMED INTENTIONAL CHANGE (uif-11, UIF11.4, #586 D4): the battle menu's inventory row reads
  // "Items" (was "Item"); the key is unchanged.
  'tactics.menu.item': 'Items',
  'tactics.menu.recruit': 'Recruit',
  'tactics.menu.flee': 'Flee',
  'tactics.menu.endTurn': 'End Turn',
  'tactics.menu.guard': 'Guard',
  'tactics.menu.submit': 'Submit',
  'tactics.menu.clearPlan': 'Clear plan',
  'tactics.menu.clearYes': 'Yes, clear the plan',
  'tactics.menu.clearNo': 'Keep the plan',
  'tactics.menu.noBait': 'No bait',
  'tactics.reason.outOfRange': 'Out of range',
  'tactics.reason.partyFull': 'Party full',
  'tactics.reason.unaffordable': 'Not enough AP',
  'tactics.reason.strideCap': 'No strides left',
  'tactics.reason.notAvailable': 'Not available yet',
  'tactics.reason.planComplete': 'Plan complete',
  'tactics.reason.boxedIn': 'No tile in reach',
  'tactics.queue.label': 'Plan',
  'tactics.queue.tooLate': `Too late ${EM_DASH} already acting`,
  'tactics.ghost.label': 'Planned position',
  'tactics.dock.danger': 'Danger overlay',
  'tactics.dock.prevUnit': 'Previous unit',
  'tactics.dock.nextUnit': 'Next unit',
  'chrome.chip.danger': 'Danger',
  'chrome.chip.prevUnit': 'Previous unit',
  'chrome.chip.nextUnit': 'Next unit',
  'chrome.chip.undo': 'Undo',
  'chrome.chip.endTurn': 'End turn',
  'chrome.chip.guard': 'Guard',
  'chrome.chip.submit': 'Submit',
  // bt-11 increment C (named intentional change, BT11.3/BT11.4/BT11.5, plan REV 6 R6.7; 486 keys
  // after it): +12 plain `tactics.*` keys — the strip's three badge words (the check / tilde /
  // cross glyphs are CSS, so the words carry none), the forecast panel's plain lines and the
  // Projected label and enemies-hold line (tactics/strings.ts is their only requester); the 14
  // parameterised ones are in SAMPLE_PARAMS / EXPECTED_PARAM_OUTPUTS. U+2014 by code point.
  'tactics.badge.firm': 'Firm',
  'tactics.badge.provisional': 'Provisional',
  'tactics.badge.stale': 'Stale',
  'tactics.forecast.label': 'Forecast',
  'tactics.forecast.miss': 'Cannot hit',
  'tactics.forecast.typeImmune': 'No effect',
  'tactics.forecast.stab': 'STAB',
  'tactics.forecast.lethal': 'Lethal',
  'tactics.forecast.lethalMax': 'Lethal on the top roll',
  'tactics.forecast.firstStand': 'Survives at 1 HP',
  'tactics.projected.label': `Projected ${EM_DASH} the board may change`,
  'tactics.projected.enemiesHold': 'assumes enemies hold',
  // bt-12 increment A (named intentional change, BT12.2/BT12.4/BT12.6, plan REV 2b B8; 504 keys
  // after it): +14 plain `tactics.*` keys — the deploy panel's title, formation label, empty slot,
  // Deploy / Edit formation rows, sending line, the editor's candidate group, its prev / next
  // buttons and Confirm / Back rows, and the results panel's list label, empty line and Continue
  // button (tactics/strings.ts is their only requester); the 4 parameterised ones are in
  // SAMPLE_PARAMS / EXPECTED_PARAM_OUTPUTS. The results TITLE reuses battle.outcome.* (no new key).
  // U+2026 by code point.
  'tactics.deploy.title': 'Choose your team',
  'tactics.deploy.label': 'Formation',
  'tactics.deploy.empty': 'Empty',
  'tactics.deploy.deploy': 'Deploy',
  'tactics.deploy.edit': 'Edit formation',
  'tactics.deploy.sending': `Deploying${ELLIPSIS}`,
  'tactics.deploy.candidateLabel': 'Monster to place',
  'tactics.deploy.prevMonster': 'Previous monster',
  'tactics.deploy.nextMonster': 'Next monster',
  'tactics.deploy.confirm': 'Confirm',
  'tactics.deploy.back': 'Back',
  'tactics.results.label': 'Rewards',
  'tactics.results.none': 'No rewards',
  'tactics.results.continue': 'Continue',
  // bt-12 increment B (named intentional change, BT12.2/BT12.6, plan §2.5 + §2.9; 511 keys after it):
  // +1 plain `tactics.*` key — the deploy confirm screen's wild-pack list label (tactics/strings.ts
  // is its only requester) — and +5 plain `chrome.chip.*` hint verbs for the deploy panel's two
  // screens (ui/hintBarModel.ts requests them, R-bt-12-DEPLOYHINT); the 1 parameterised "Still
  // there?" countdown line is in SAMPLE_PARAMS / EXPECTED_PARAM_OUTPUTS.
  'tactics.deploy.wilds': 'Wild pack',
  'chrome.chip.deploy': 'Deploy',
  'chrome.chip.editFormation': 'Edit formation',
  'chrome.chip.assign': 'Assign',
  'chrome.chip.prevMonster': 'Prev monster',
  'chrome.chip.nextMonster': 'Next monster',
  // bt-15 increment B (named intentional change, BT15.2/BT15.3/BT15.5, plan REV 3.1; 525 keys after
  // it): +9 plain `tactics.*` keys — the players strip's label, the Forfeit row and its two confirm
  // rows, and the five results reasons (tactics/strings.ts is their only requester); the 4
  // parameterised ones are in SAMPLE_PARAMS / EXPECTED_PARAM_OUTPUTS. Text from the API freeze.
  'tactics.players.label': 'Players',
  'tactics.menu.forfeit': 'Forfeit',
  'tactics.menu.forfeitYes': 'Yes, forfeit the match',
  'tactics.menu.forfeitNo': 'Keep fighting',
  'tactics.results.endHow.adjudicatedHpPercent': 'Decided on remaining HP',
  'tactics.results.endHow.adjudicatedConscious': 'Decided on conscious monsters',
  'tactics.results.endHow.adjudicatedDamageDealt': 'Decided on damage dealt',
  'tactics.results.endHow.adjudicatedCoin': 'Decided by the coin',
  'tactics.results.endHow.forfeit': 'Ended by forfeit',
  // uif-7 (named intentional change, UIF7.2): +2 plain `kit.sheet.*` keys = 496 keys. The context
  // sheet's closing rows: Close ends the Monsters sheet, Back ends its Feed… and Evolve… lists. They
  // are the kit's, reused by later slices with no further catalog edit.
  'kit.sheet.close': 'Close',
  'kit.sheet.back': 'Back',
  // uif-8 (named intentional change, UIF8.4): 496 -> 498, +bag.empty.cue, +bag.empty.next. The Bag's
  // EmptyState says where items come from (cue) and what to do next; its reason line reuses
  // `raising.inventory.empty` (no new key).
  'bag.empty.cue': 'Items come from the shop and from battles in the wild.',
  'bag.empty.next': 'Visit a shop, or press LB / RB to check another pocket.',
  // uif-12 (named intentional change, UIF12.3): 498 -> 499, +interact.chip.choose. The hint-bar's A
  // verb over a multi-row entity x action picker (a plain key under `interact.*`, not `chrome.*`).
  'interact.chip.choose': 'Choose',
  // uif-13 (named intentional change, UIF13.2): 499 -> 506, +4 plain keys here (the Controls Display
  // tab label and the three text-size step labels) and +3 parameterised ones in SAMPLE_PARAMS (the
  // Display row, the live row and the outcome line). The en bytes are pinned HERE; the fr texts are
  // pinned by the uif-13 describe at the end of this file.
  'controls.tab.display': 'Display',
  'controls.text.normal': 'Normal',
  'controls.text.large': 'Large',
  'controls.text.xlarge': 'Extra large',
};

interface ParamOutputSpec {
  readonly inputA: Record<string, unknown>;
  readonly outputA: string;
  readonly inputB: Record<string, unknown>;
  readonly outputB: string;
}

/** ctl-7d's shop-line glyphs, built by code point so no expectation holds a pasted glyph:
 *  U+2713 CHECK MARK, U+2212 MINUS SIGN (never the ASCII hyphen) and U+00D7 MULTIPLICATION SIGN. */
const CHECK_MARK = String.fromCharCode(0x2713);
const MINUS_SIGN = String.fromCharCode(0x2212);
const TIMES_SIGN = String.fromCharCode(0x00d7);
/** ctl-8e's summary separator: U+00B7 MIDDLE DOT, by code point. */
const MIDDLE_DOT = String.fromCharCode(0x00b7);
/** bt-11 increment C's damage range dash: U+2013 EN DASH, by code point (never the ASCII hyphen). */
const EN_DASH = String.fromCharCode(0x2013);
/** bt-15 increment B's rating arrow: U+2192 RIGHTWARDS ARROW, by code point. */
const BT15_ARROW = String.fromCharCode(0x2192);

/** Every parameterised MessageId's expected output for BOTH `SAMPLE_PARAMS` sets
 *  — pins the EXACT output string (plan R6), which as a consequence also pins
 *  outputA !== outputB (asserted explicitly below, belt-and-braces). */
const EXPECTED_PARAM_OUTPUTS: Record<string, ParamOutputSpec> = {
  'chrome.status.disconnected': {
    inputA: { where: 'shop' },
    outputA: 'shop: disconnected — try again',
    inputB: { where: 'trade' },
    outputB: 'trade: disconnected — try again',
  },
  // bt-17 (named intentional change, BT17.1): the 11 parameterised 1v1 `battle.*` outputs that sat
  // here are DELETED with their keys (see SAMPLE_PARAMS); `battle.rewards.{gold,xp}` leave below.
  'pvp.incoming.label': {
    inputA: { challenger: 'Bob' },
    outputA: 'Bob has challenged you!',
    inputB: { challenger: 'Dana' },
    outputB: 'Dana has challenged you!',
  },
  'pvp.outgoing.label': {
    inputA: { target: 'Alice' },
    outputA: 'Challenge sent to Alice — waiting…',
    inputB: { target: 'Elliot' },
    outputB: 'Challenge sent to Elliot — waiting…',
  },
  // Evolution.* (5 ★; qf-8 retired `evolution.choice.evolve`, 'Evolve into {species}')
  'evolution.card.stats': {
    inputA: { level: 7, stage: 1, trust: 'Wary', qualityTime: 1, nutrition: 41 },
    outputA: 'Lv.7 · Stage 1 · Trust Wary · Quality time 1 · Nutrition 41%',
    inputB: { level: 30, stage: 3, trust: 'Devoted', qualityTime: 4, nutrition: 88 },
    outputB: 'Lv.30 · Stage 3 · Trust Devoted · Quality time 4 · Nutrition 88%',
  },
  'evolution.card.ready': {
    inputA: { species: 'Pyrodrake' },
    outputA: 'Ready — evolves into Pyrodrake on your next action.',
    inputB: { species: 'Cindermaw' },
    outputB: 'Ready — evolves into Cindermaw on your next action.',
  },
  'evolution.path.heading': {
    inputA: { species: 'Pyrodrake' },
    outputA: '→ Pyrodrake',
    inputB: { species: 'Cindermaw' },
    outputB: '→ Cindermaw',
  },
  'evolution.gate.metRow': {
    inputA: { label: 'Level', current: 'Lv 30', required: 'Lv 20' },
    outputA: '✓ Level: Lv 30 / Lv 20',
    inputB: { label: 'Trust', current: 'Devoted', required: 'Friendly' },
    outputB: '✓ Trust: Devoted / Friendly',
  },
  'evolution.gate.unmetRow': {
    inputA: { label: 'Nutrition', current: '41%', required: '60%' },
    outputA: '• Nutrition: 41% / 60%',
    inputB: { label: 'Quality time', current: 'Tier 1', required: 'Tier 3' },
    outputB: '• Quality time: Tier 1 / Tier 3',
  },
  // Raising.* (1 ★; qf-9 retired `raising.card.{status,stats,train}`)
  'raising.inventory.item': {
    inputA: { name: 'Protein', count: 2 },
    outputA: 'Protein (x2)',
    inputB: { name: 'Iron', count: 5 },
    outputB: 'Iron (x5)',
  },
  // Box.* (2 ★)
  'box.party.emptySlot': {
    inputA: { slot: 0 },
    outputA: 'Slot 0: (empty)',
    inputB: { slot: 3 },
    outputB: 'Slot 3: (empty)',
  },
  'box.card.stats': {
    inputA: { species: 'Sproutle', level: 5, current: 18, max: 20, percent: 90 },
    outputA: 'Sproutle · Lv5 · HP 18/20 (90%)',
    inputB: { species: 'Emberfang', level: 9, current: 21, max: 21, percent: 100 },
    outputB: 'Emberfang · Lv9 · HP 21/21 (100%)',
  },
  // qf-9 (QF9.1): the Summary's full-stats line, the retired raising.card.stats labels plus the
  // trust tier; the separator is U+00B7 (CELL_DOT), built by code point.
  'box.summary.stats': {
    inputA: { trust: 'Wary', attack: 11, defense: 22, speed: 33, spAttack: 44, spDefense: 55 },
    outputA: `Trust Wary ${CELL_DOT} ATK 11 ${CELL_DOT} DEF 22 ${CELL_DOT} SPD 33 ${CELL_DOT} SP.ATK 44 ${CELL_DOT} SP.DEF 55`,
    inputB: { trust: 'Devoted', attack: 101, defense: 87, speed: 64, spAttack: 120, spDefense: 99 },
    outputB: `Trust Devoted ${CELL_DOT} ATK 101 ${CELL_DOT} DEF 87 ${CELL_DOT} SPD 64 ${CELL_DOT} SP.ATK 120 ${CELL_DOT} SP.DEF 99`,
  },
  // ctl-8c: the food row (the raising inventory row's shape), the Evolve confirm, the fed line
  // (the check mark is the CSS ::before of the ok feedback line, so the text carries none).
  'box.feed.item': {
    inputA: { name: 'Bait', count: 3 },
    outputA: 'Bait (x3)',
    inputB: { name: 'Glowberry', count: 12 },
    outputB: 'Glowberry (x12)',
  },
  'box.evolve.confirm': {
    inputA: { name: 'Kip', species: 'Emberfang' },
    outputA: 'Evolve Kip into Emberfang?',
    inputB: { name: 'Sproutle', species: 'Pyroleo' },
    outputB: 'Evolve Sproutle into Pyroleo?',
  },
  'box.feedback.fed': {
    inputA: { name: 'Kip' },
    outputA: 'Fed Kip',
    inputB: { name: 'Mossling' },
    outputB: 'Fed Mossling',
  },
  // qf-3: the cooling Care row's hint, after its label (QF3.3); bare digits, no padding.
  'box.sheet.careCooldown': {
    inputA: { hours: 5, minutes: 59 },
    outputA: 'Ready in 5h 59m',
    inputB: { hours: 0, minutes: 1 },
    outputB: 'Ready in 0h 1m',
  },
  // Trade.* (2 ★)
  'trade.side.card': {
    inputA: { nickname: 'Sproutle', species: 'Mossback', level: 7, current: 3, max: 9 },
    outputA: 'Sproutle (Mossback) Lv.7 HP:3/9',
    inputB: { nickname: 'Kip', species: 'Duskling', level: 12, current: 20, max: 40 },
    outputB: 'Kip (Duskling) Lv.12 HP:20/40',
  },
  'trade.side.currency': {
    inputA: { amount: 250n },
    outputA: '250 gold',
    inputB: { amount: 1000n },
    outputB: '1000 gold',
  },
  // Shop.* (3 ★, trailing space pinned exactly)
  'shop.buy.row': {
    inputA: { name: 'Herb', price: 50n },
    outputA: 'Herb — 50 gold ',
    inputB: { name: 'Tonic', price: 120n },
    outputB: 'Tonic — 120 gold ',
  },
  'shop.sell.row': {
    inputA: { name: 'Herb', count: 3, price: 20n },
    outputA: 'Herb (×3) — 20 gold ',
    inputB: { name: 'Tonic', count: 1, price: 60n },
    outputB: 'Tonic (×1) — 60 gold ',
  },
  'shop.sell.unsellable': {
    inputA: { name: 'Charm', count: 2 },
    outputA: 'Charm (×2) — Cannot sell',
    inputB: { name: 'Relic', count: 1 },
    outputB: 'Relic (×1) — Cannot sell',
  },
  // The tail batch's 6 ★ keys, both sample sets differing in every field.
  'leaderboard.row': {
    inputA: { rating: 1200, wins: 10, losses: 2 },
    outputA: ' — 1200 (W10/L2)',
    inputB: { rating: 987, wins: 3, losses: 14 },
    outputB: ' — 987 (W3/L14)',
  },
  'heal.location': {
    inputA: { cost: 'Free' },
    outputA: 'Heal here (Free)',
    inputB: { cost: '25 gold' },
    outputB: 'Heal here (25 gold)',
  },
  'questLog.entry': {
    inputA: { name: 'quest_001', step: 0 },
    outputA: 'quest_001 (step 0)',
    inputB: { name: 'quest_kelp', step: 3 },
    outputB: 'quest_kelp (step 3)',
  },
  'evolutionNotice.species.fallback': {
    inputA: { id: 31 },
    outputA: 'Species #31',
    inputB: { id: 44 },
    outputB: 'Species #44',
  },
  'evolutionNotice.reveal.nicknamed': {
    inputA: { nickname: 'Sparky', from: 'Flameling', to: 'Flamewing' },
    outputA: 'Sparky evolved from Flameling into Flamewing!',
    inputB: { nickname: 'Kip', from: 'Mossback', to: 'Duskling' },
    outputB: 'Kip evolved from Mossback into Duskling!',
  },
  'evolutionNotice.reveal.anonymous': {
    inputA: { from: 'Flameling', to: 'Flamewing' },
    outputA: 'Your Flameling evolved into Flamewing!',
    inputB: { from: 'Mossback', to: 'Duskling' },
    outputB: 'Your Mossback evolved into Duskling!',
  },
  // 21r-b2: the privacy countdown / export-status closures. The unit outputs are the bare decimal
  // digits of the bigint — `'1,157d'` (a locale formatter) or `'9007199254740992d'` (a `Number`
  // round trip) both fail here. The chunk sentences keep the pre-migration "N chunks" shape.
  'privacy.countdown.grace': {
    inputA: { duration: '2d 3h 4m 5s' },
    outputA: 'Account deletion in 2d 3h 4m 5s',
    inputB: { duration: '58s' },
    outputB: 'Account deletion in 58s',
  },
  'privacy.countdown.days': {
    inputA: { n: 1157n },
    outputA: '1157d',
    inputB: { n: 9_007_199_254_740_993n },
    outputB: '9007199254740993d',
  },
  'privacy.countdown.hours': {
    inputA: { n: 1157n },
    outputA: '1157h',
    inputB: { n: 9_007_199_254_740_993n },
    outputB: '9007199254740993h',
  },
  'privacy.countdown.minutes': {
    inputA: { n: 1157n },
    outputA: '1157m',
    inputB: { n: 9_007_199_254_740_993n },
    outputB: '9007199254740993m',
  },
  'privacy.countdown.seconds': {
    inputA: { n: 1157n },
    outputA: '1157s',
    inputB: { n: 9_007_199_254_740_993n },
    outputB: '9007199254740993s',
  },
  'privacy.export.incomplete': {
    inputA: { received: 2, total: 5 },
    outputA: 'Data export incomplete — 2 of 5 chunks delivered.',
    inputB: { received: 7, total: 9 },
    outputB: 'Data export incomplete — 7 of 9 chunks delivered.',
  },
  'privacy.export.complete': {
    inputA: { received: 5 },
    outputA: 'Data export ready — 5 chunks.',
    inputB: { received: 12 },
    outputB: 'Data export ready — 12 chunks.',
  },
  // ctl-7d: the shop success lines (CTL7D.4) — the quantity, the item and the gold moved, or the
  // quantity alone. The gold digits are the bigint's own (`27021597764222976` would be a Number
  // round trip), the quantity's are bare (`4,294,967,295` would be a locale formatter).
  'shop.feedback.buy.item': {
    inputA: { qty: 2, name: 'Bait', gold: 40n },
    outputA: `${CHECK_MARK} Bought 2 Bait (${MINUS_SIGN}40g)`,
    inputB: { qty: 3, name: 'Relic', gold: 27_021_597_764_222_979n },
    outputB: `${CHECK_MARK} Bought 3 Relic (${MINUS_SIGN}27021597764222979g)`,
  },
  'shop.feedback.buy.count': {
    inputA: { qty: 2 },
    outputA: `${CHECK_MARK} Bought ${TIMES_SIGN}2`,
    inputB: { qty: 4_294_967_295 },
    outputB: `${CHECK_MARK} Bought ${TIMES_SIGN}4294967295`,
  },
  'shop.feedback.sell.item': {
    inputA: { qty: 3, name: 'Berry', gold: 30n },
    outputA: `${CHECK_MARK} Sold 3 Berry (+30g)`,
    inputB: { qty: 1, name: 'Tonic', gold: 9_007_199_254_740_993n },
    outputB: `${CHECK_MARK} Sold 1 Tonic (+9007199254740993g)`,
  },
  'shop.feedback.sell.count': {
    inputA: { qty: 3 },
    outputA: `${CHECK_MARK} Sold ${TIMES_SIGN}3`,
    inputB: { qty: 12 },
    outputB: `${CHECK_MARK} Sold ${TIMES_SIGN}12`,
  },
  // ctl-8a: the shop's quantity and confirm prompts (CTL8A.2) and the heal question (CTL8A.3).
  // The quantity mark is U+00D7; the gold digits are the bigint's own (no grouping, no Number
  // round trip); the cost is the heal model's line, carried verbatim.
  'shop.qty.buy': {
    inputA: { name: 'Herb', qty: 2 },
    outputA: `Buy how many Herb? ${TIMES_SIGN}2`,
    inputB: { name: 'Tonic', qty: 99 },
    outputB: `Buy how many Tonic? ${TIMES_SIGN}99`,
  },
  'shop.qty.sell': {
    inputA: { name: 'Berry', qty: 3 },
    outputA: `Sell how many Berry? ${TIMES_SIGN}3`,
    inputB: { name: 'Relic', qty: 1 },
    outputB: `Sell how many Relic? ${TIMES_SIGN}1`,
  },
  'shop.confirm.buy': {
    inputA: { qty: 2, name: 'Bait', gold: 40n },
    outputA: 'Buy 2 Bait for 40 gold?',
    inputB: { qty: 3, name: 'Relic', gold: 27_021_597_764_222_979n },
    outputB: 'Buy 3 Relic for 27021597764222979 gold?',
  },
  'shop.confirm.sell': {
    inputA: { qty: 3, name: 'Berry', gold: 30n },
    outputA: 'Sell 3 Berry for 30 gold?',
    inputB: { qty: 1, name: 'Tonic', gold: 9_007_199_254_740_993n },
    outputB: 'Sell 1 Tonic for 9007199254740993 gold?',
  },
  'heal.prompt.question': {
    inputA: { cost: '25 gold' },
    outputA: 'Heal party for 25 gold?',
    inputB: { cost: '2x Herb + 40 gold' },
    outputB: 'Heal party for 2x Herb + 40 gold?',
  },
  // ts-3 (named intentional change, the Strangler): ctl-8e's `tradePropose.review.summary` output
  // pins are DELETED with the key. ts-3's 7 parameterised keys, en bytes from the plan's "i18n"
  // ADDED table; the marks separator is U+00B7 (MIDDLE_DOT), the digits are the value's own (no
  // grouping, no Number round trip).
  'trade.row.title': {
    inputA: { name: 'Bob' },
    outputA: 'Trade with Bob',
    inputB: { name: 'Dana' },
    outputB: 'Trade with Dana',
  },
  'trade.row.marks': {
    inputA: { mine: 'Confirmed', theirs: 'Not confirmed' },
    outputA: `You: Confirmed ${MIDDLE_DOT} Them: Not confirmed`,
    inputB: { mine: 'Not confirmed', theirs: 'Confirmed' },
    outputB: `You: Not confirmed ${MIDDLE_DOT} Them: Confirmed`,
  },
  'tradeSession.title': {
    inputA: { name: 'Zed' },
    outputA: 'Trade with Zed',
    inputB: { name: 'Amy' },
    outputB: 'Trade with Amy',
  },
  'tradeSession.row.blocked': {
    inputA: { label: 'Kip Lv.7', reason: 'fainted' },
    outputA: 'Kip Lv.7 (fainted)',
    inputB: { label: 'Sproutle Lv.12', reason: 'in battle' },
    outputB: 'Sproutle Lv.12 (in battle)',
  },
  'tradeSession.row.item': {
    inputA: { name: 'Herb', qty: 2, held: 5 },
    outputA: 'Herb: 2 of 5',
    inputB: { name: 'Tonic', qty: 0, held: 9 },
    outputB: 'Tonic: 0 of 9',
  },
  'tradeSession.row.coins': {
    inputA: { amount: 40n, balance: 900n },
    outputA: 'Coins: 40 of 900',
    inputB: { amount: 9_007_199_254_740_993n, balance: 27_021_597_764_222_979n },
    outputB: 'Coins: 9007199254740993 of 27021597764222979',
  },
  'notice.request.trades': {
    inputA: { count: 2 },
    outputA: '2 trade requests',
    inputB: { count: 5 },
    outputB: '5 trade requests',
  },
  // ctl-8f: the Journal detail's step line (CTL8F.3).
  'journal.detail.step': {
    inputA: { step: 0 },
    outputA: 'Step 0',
    inputB: { step: 4 },
    outputB: 'Step 4',
  },
  // ctl-8g: the Players tab's walk-up line (CTL8G.1). The name sits once, verbatim, in the text.
  'social.players.walkUp': {
    inputA: { name: 'Zed' },
    outputA: 'Walk up to Zed and press A',
    inputB: { name: 'Amy' },
    outputB: 'Walk up to Amy and press A',
  },
  // ctl-10a: the world interaction chip (CTL10A.3) `[{A keycap}] {verb} — {name}` / `[{A keycap}]
  // Choose…`, and the picker / sheet row `{verb} — {name}`. The dash is U+2014 and the ellipsis
  // U+2026, built by code point.
  'interact.chip': {
    inputA: { key: 'Enter', verb: 'Talk', name: 'elder_oak' },
    outputA: `[Enter] Talk ${EM_DASH} elder_oak`,
    inputB: { key: 'KeyZ', verb: 'Shop', name: 'tideglass_shopkeeper' },
    outputB: `[KeyZ] Shop ${EM_DASH} tideglass_shopkeeper`,
  },
  'interact.choose': {
    inputA: { key: 'Enter' },
    outputA: `[Enter] Choose${ELLIPSIS}`,
    inputB: { key: 'Space' },
    outputB: `[Space] Choose${ELLIPSIS}`,
  },
  'interact.entry': {
    inputA: { verb: 'Talk', name: 'elder_oak' },
    outputA: `Talk ${EM_DASH} elder_oak`,
    inputB: { verb: 'Heal', name: 'Healer' },
    outputB: `Heal ${EM_DASH} Healer`,
  },
  // ctl-10b: the Challenge confirm question (CTL10B.1); the name sits once, verbatim.
  'interact.confirm.challenge': {
    inputA: { name: 'Rival' },
    outputA: 'Challenge Rival?',
    inputB: { name: 'Zed' },
    outputB: 'Challenge Zed?',
  },
  // ctl-12: the numpad keycap and the Options › Controls capture / swap lines.
  'key.numpad': {
    inputA: { key: '1' },
    outputA: 'Num 1',
    inputB: { key: '9' },
    outputB: 'Num 9',
  },
  'controls.capture.prompt': {
    inputA: { label: 'Confirm (A)' },
    outputA: `Press a key for Confirm (A)${ELLIPSIS}`,
    inputB: { label: 'Bag' },
    outputB: `Press a key for Bag${ELLIPSIS}`,
  },
  'controls.swapped': {
    inputA: { key: 'F', label: 'Confirm (A)', otherKey: 'K', otherLabel: 'Info (Y)' },
    outputA: 'Swapped: F is now Confirm (A), K is now Info (Y)',
    inputB: { key: 'Q', label: 'Bag', otherKey: 'I', otherLabel: 'Jump (X)' },
    outputB: 'Swapped: Q is now Bag, I is now Jump (X)',
  },
  'controls.swappedSlots': {
    inputA: { key: 'Z', otherKey: 'W', label: 'Up' },
    outputA: 'Swapped: Z and W on Up',
    inputB: { key: 'N', otherKey: 'M', label: 'Bag' },
    outputB: 'Swapped: N and M on Bag',
  },
  'controls.swappedUnbound': {
    inputA: { key: 'F', label: 'Confirm (A)', otherLabel: 'Info (Y)' },
    outputA: 'Swapped: F is now Confirm (A), Info (Y) has no key',
    inputB: { key: 'Q', label: 'Bag', otherLabel: 'Jump (X)' },
    outputB: 'Swapped: Q is now Bag, Jump (X) has no key',
  },
  // ctl-12b: the Controls view's cells (each names its row: the grid is read one cell at a time)
  // and the line a Clear writes.
  'controls.slot.primary': {
    inputA: { label: 'Confirm (A)', key: 'Enter' },
    outputA: 'Confirm (A): Enter',
    inputB: { label: 'Bag', key: 'K' },
    outputB: 'Bag: K',
  },
  'controls.slot.alt': {
    inputA: { label: 'Up', key: 'W' },
    outputA: 'Up (alt): W',
    inputB: { label: 'Save bug report', key: 'F9' },
    outputB: 'Save bug report (alt): F9',
  },
  'controls.clear': {
    inputA: { label: 'Bag' },
    outputA: 'Clear Bag',
    inputB: { label: 'Save bug report' },
    outputB: 'Clear Save bug report',
  },
  'controls.cleared': {
    inputA: { label: 'Journal' },
    outputA: 'Journal has no key now.',
    inputB: { label: 'Dismiss error' },
    outputB: 'Dismiss error has no key now.',
  },
  // ctl-13: the request banner's lines are KEY-FREE (they survive a remap) and name the sender once.
  'notice.request.trade': {
    inputA: { name: 'Bob' },
    outputA: 'Bob wants to trade',
    inputB: { name: 'Dana' },
    outputB: 'Dana wants to trade',
  },
  'notice.request.challenge': {
    inputA: { name: 'Bob' },
    outputA: 'Bob challenges you to a battle',
    inputB: { name: 'Dana' },
    outputB: 'Dana challenges you to a battle',
  },
  // qf-6 (QF6.4): the quest-completion lines; the gold digits are the bigint's own.
  'quest.complete.reward': {
    inputA: { name: 'quest_001', amount: 50n },
    outputA: 'Quest complete: quest_001. You received 50 gold.',
    inputB: { name: 'quest_002', amount: 7n },
    outputB: 'Quest complete: quest_002. You received 7 gold.',
  },
  'quest.complete.done': {
    inputA: { name: 'quest_001' },
    outputA: 'Quest complete: quest_001.',
    inputB: { name: 'quest_002' },
    outputB: 'Quest complete: quest_002.',
  },
  // qf-15 (QF15.1): the zone cue; the zone name sits once, verbatim, in the text.
  'chrome.status.zoneEntered': {
    inputA: { name: 'Cobalt Reach' },
    outputA: 'Entering Cobalt Reach',
    inputB: { name: 'Umber Fen' },
    outputB: 'Entering Umber Fen',
  },
  // bt-17 (named intentional change, BT17.1): qf-17's `battle.rewards.{gold,xp}` outputs are
  // DELETED with the 1v1 payout lines.
  // bt-10 (BT10.5/BT10.6): the tactical client's parameterised lines. Names, reason texts and status
  // words are model data (a catalog text resolved by the caller) and sit once, verbatim, in the line;
  // the numbers are bare digits (no locale grouping); the bigint currency keeps every digit.
  'tactics.turnbar.round': {
    inputA: { round: 3 },
    outputA: 'Round 3',
    inputB: { round: 12 },
    outputB: 'Round 12',
  },
  'tactics.turnbar.surgeIn': {
    inputA: { n: 2 },
    outputA: 'Surge in 2',
    inputB: { n: 1 },
    outputB: 'Surge in 1',
  },
  'tactics.turnbar.retreatAt': {
    inputA: { round: 31 },
    outputA: 'Retreat at 31',
    inputB: { round: 40 },
    outputB: 'Retreat at 40',
  },
  'tactics.hud.level': {
    inputA: { level: 7 },
    outputA: 'Lv.7',
    inputB: { level: 30 },
    outputB: 'Lv.30',
  },
  'tactics.hud.hp': {
    inputA: { hp: 8, max: 20 },
    outputA: 'HP 8/20',
    inputB: { hp: 0, max: 9 },
    outputB: 'HP 0/9',
  },
  'tactics.hud.ap': {
    inputA: { ap: 4, max: 6 },
    outputA: 'AP 4/6',
    inputB: { ap: 1, max: 8 },
    outputB: 'AP 1/8',
  },
  'tactics.hud.role': {
    inputA: { role: 'Tank' },
    outputA: 'Role: Tank',
    inputB: { role: 'Healer' },
    outputB: 'Role: Healer',
  },
  'tactics.ticker.executed': {
    inputA: { unit: 'Sprigg', skill: 'Vine Lash' },
    outputA: 'Sprigg uses Vine Lash',
    inputB: { unit: 'Mossback', skill: 'Ember Jab' },
    outputB: 'Mossback uses Ember Jab',
  },
  'tactics.ticker.hit': {
    inputA: { target: 'Mossback', damage: 12 },
    outputA: 'Mossback takes 12 damage',
    inputB: { target: 'Sprigg', damage: 1 },
    outputB: 'Sprigg takes 1 damage',
  },
  'tactics.ticker.missed': {
    inputA: { unit: 'Sprigg', target: 'Mossback' },
    outputA: 'Sprigg misses Mossback',
    inputB: { unit: 'Flameling', target: 'Kip' },
    outputB: 'Flameling misses Kip',
  },
  'tactics.ticker.halted': {
    inputA: { unit: 'Sprigg', reason: 'out of reach' },
    outputA: 'Sprigg stops: out of reach',
    inputB: { unit: 'Kip', reason: 'target gone' },
    outputB: 'Kip stops: target gone',
  },
  'tactics.ticker.voided': {
    inputA: { unit: 'Sprigg' },
    outputA: 'Sprigg loses the queued plan',
    inputB: { unit: 'Kip' },
    outputB: 'Kip loses the queued plan',
  },
  'tactics.ticker.autoPass': {
    inputA: { unit: 'Sprigg', strike: 2 },
    outputA: 'Sprigg passes (strike 2)',
    inputB: { unit: 'Kip', strike: 3 },
    outputB: 'Kip passes (strike 3)',
  },
  'tactics.ticker.stoodGround': {
    inputA: { unit: 'Sprigg' },
    outputA: 'Sprigg stands its ground',
    inputB: { unit: 'Kip' },
    outputB: 'Kip stands its ground',
  },
  'tactics.ticker.statusApplied': {
    inputA: { unit: 'Sprigg', status: 'Poisoned' },
    outputA: 'Sprigg is now Poisoned',
    inputB: { unit: 'Kip', status: 'Frozen' },
    outputB: 'Kip is now Frozen',
  },
  'tactics.ticker.statusTick': {
    inputA: { unit: 'Sprigg', status: 'Burned', amount: 5 },
    outputA: 'Sprigg takes 5 damage while Burned',
    inputB: { unit: 'Kip', status: 'Poisoned', amount: 12 },
    outputB: 'Kip takes 12 damage while Poisoned',
  },
  'tactics.ticker.statusCured': {
    inputA: { unit: 'Sprigg', status: 'Poisoned' },
    outputA: 'Sprigg is no longer Poisoned',
    inputB: { unit: 'Kip', status: 'Asleep' },
    outputB: 'Kip is no longer Asleep',
  },
  'tactics.ticker.statusBlocked': {
    inputA: { unit: 'Sprigg', status: 'Paralyzed' },
    outputA: 'Sprigg resists being Paralyzed',
    inputB: { unit: 'Kip', status: 'Frozen' },
    outputB: 'Kip resists being Frozen',
  },
  'tactics.ticker.surge': {
    inputA: { unit: 'Sprigg', amount: 3 },
    // bt-10 round 2 (named intentional change): Surge is damage ("takes N Surge damage"), not a buff.
    outputA: 'Sprigg takes 3 Surge damage',
    inputB: { unit: 'Kip', amount: 11 },
    outputB: 'Kip takes 11 Surge damage',
  },
  'tactics.ticker.ko': {
    inputA: { unit: 'Sprigg' },
    outputA: 'Sprigg is knocked out',
    inputB: { unit: 'Kip' },
    outputB: 'Kip is knocked out',
  },
  'tactics.ticker.recruitOk': {
    inputA: { target: 'Mossback' },
    outputA: 'Mossback joins your team',
    inputB: { target: 'Flameling' },
    outputB: 'Flameling joins your team',
  },
  'tactics.ticker.recruitFail': {
    inputA: { target: 'Mossback', pct: 42 },
    outputA: 'Recruiting Mossback failed (42%)',
    inputB: { target: 'Flameling', pct: 7 },
    outputB: 'Recruiting Flameling failed (7%)',
  },
  'tactics.ticker.awards': {
    inputA: { unit: 'Sprigg', xp: 55, essence: 6, currency: 123n },
    outputA: 'Sprigg earns 55 XP, 6 essence and 123 gold',
    inputB: { unit: 'Kip', xp: 0, essence: 12, currency: 9_007_199_254_740_993n },
    outputB: 'Kip earns 0 XP, 12 essence and 9007199254740993 gold',
  },
  'tactics.ticker.moved': {
    inputA: { unit: 'Sprigg', tiles: 3 },
    outputA: 'Sprigg moves (tiles: 3)',
    inputB: { unit: 'Kip', tiles: 1 },
    outputB: 'Kip moves (tiles: 1)',
  },
  'tactics.ticker.itemUsed': {
    inputA: { unit: 'Sprigg', item: 'Herb', target: 'Kip' },
    outputA: 'Sprigg uses Herb on Kip',
    inputB: { unit: 'Mossback', item: 'Tonic', target: 'Flameling' },
    outputB: 'Mossback uses Tonic on Flameling',
  },
  'tactics.ticker.turnEnded': {
    inputA: { unit: 'Sprigg' },
    outputA: 'Sprigg ends the turn',
    inputB: { unit: 'Kip' },
    outputB: 'Kip ends the turn',
  },
  'tactics.ticker.guarded': {
    inputA: { unit: 'Sprigg' },
    outputA: 'Sprigg guards',
    inputB: { unit: 'Kip' },
    outputB: 'Kip guards',
  },
  'tactics.ticker.roundEnded': {
    inputA: { round: 8 },
    outputA: 'Round 8 ends',
    inputB: { round: 25 },
    outputB: 'Round 25 ends',
  },
  'tactics.banner.turn': {
    inputA: { unit: 'Sprigg' },
    // bt-10 round 2 (named intentional change): the banner also shows for a human opponent's live
    // turn, so its copy is neutral ("{unit}'s turn"), never "Your turn".
    outputA: "Sprigg's turn",
    inputB: { unit: 'Kip' },
    outputB: "Kip's turn",
  },
  // bt-11 (named intentional change, BT11.1): the spec's own reason line ("Needs all 6 AP — start
  // your turn adjacent") with the fresh budget's ap as a param; the flee reason is its first clause.
  'tactics.reason.recruitFullAp': {
    inputA: { ap: 6 },
    outputA: `Needs all 6 AP ${EM_DASH} start your turn adjacent`,
    inputB: { ap: 9 },
    outputB: `Needs all 9 AP ${EM_DASH} start your turn adjacent`,
  },
  'tactics.reason.fleeFullAp': {
    inputA: { ap: 6 },
    outputA: 'Needs all 6 AP',
    inputB: { ap: 9 },
    outputB: 'Needs all 9 AP',
  },
  // bt-11 increment C (BT11.3/BT11.4/BT11.5, plan REV 6 R6.7): the strip note and pip label, the
  // forecast panel's lines, the Projected assumption line. Numbers are bare digits; the damage
  // range dash is U+2013 and the multiplier U+00D7 (built by code point); the recruit line items
  // print the rules' four fields as given (the two sets do not sum on purpose: the closure never
  // adds).
  'tactics.badge.onlyHeld': {
    inputA: { n: 1 },
    outputA: 'only 1 held',
    inputB: { n: 3 },
    outputB: 'only 3 held',
  },
  'tactics.chip.cost': {
    inputA: { ap: 5 },
    outputA: '5 AP',
    inputB: { ap: 11 },
    outputB: '11 AP',
  },
  'tactics.forecast.vs': {
    inputA: { unit: 'Mossback' },
    outputA: 'vs Mossback',
    inputB: { unit: 'Flameling' },
    outputB: 'vs Flameling',
  },
  'tactics.forecast.hit': {
    inputA: { pct: 83 },
    outputA: 'Hit 83%',
    inputB: { pct: 7 },
    outputB: 'Hit 7%',
  },
  'tactics.forecast.damage': {
    inputA: { min: 61, max: 89 },
    outputA: `61${EN_DASH}89 damage`,
    inputB: { min: 3, max: 5 },
    outputB: `3${EN_DASH}5 damage`,
  },
  'tactics.forecast.typeTimes': {
    inputA: { num: 2 },
    outputA: `Type ${TIMES_SIGN}2`,
    inputB: { num: 3 },
    outputB: `Type ${TIMES_SIGN}3`,
  },
  'tactics.forecast.typeOver': {
    inputA: { num: 1, den: 2 },
    outputA: `Type ${TIMES_SIGN}1/2`,
    inputB: { num: 3, den: 4 },
    outputB: `Type ${TIMES_SIGN}3/4`,
  },
  'tactics.forecast.flank': {
    inputA: { num: 5, den: 4 },
    outputA: `Flank ${TIMES_SIGN}5/4`,
    inputB: { num: 7, den: 3 },
    outputB: `Flank ${TIMES_SIGN}7/3`,
  },
  'tactics.forecast.guard': {
    inputA: { num: 3, den: 4 },
    outputA: `Guard ${TIMES_SIGN}3/4`,
    inputB: { num: 2, den: 9 },
    outputB: `Guard ${TIMES_SIGN}2/9`,
  },
  'tactics.forecast.status': {
    inputA: { status: 'Poisoned' },
    outputA: 'May inflict Poisoned',
    inputB: { status: 'Asleep' },
    outputB: 'May inflict Asleep',
  },
  'tactics.forecast.recruit': {
    inputA: { pct: 41 },
    outputA: 'Recruit 41%',
    inputB: { pct: 67 },
    outputB: 'Recruit 67%',
  },
  'tactics.forecast.recruitLines': {
    inputA: { base: 8, bait: 0, weakened: 31, pct: 41 },
    outputA: '8 + 0 + 31 = 41%',
    inputB: { base: 12, bait: 19, weakened: 37, pct: 67 },
    outputB: '12 + 19 + 37 = 67%',
  },
  'tactics.forecast.bait': {
    inputA: { item: 'Lure Berry' },
    outputA: 'Bait: Lure Berry',
    inputB: { item: 'Herb' },
    outputB: 'Bait: Herb',
  },
  'tactics.projected.assumes': {
    inputA: { unit: 'Sprigg', tile: 'C4' },
    outputA: 'if Sprigg is still at C4',
    inputB: { unit: 'Mossback', tile: 'E2' },
    outputB: 'if Mossback is still at E2',
  },
  // bt-12 increment A (BT12.2/BT12.4/BT12.6, plan REV 2b B8): the slot label is 1-based as given
  // (the caller passes i + 1), the monster line reads "{name}: +{xp} XP, +{essence} essence", the
  // gold line "+{amount} gold" (the word is gold, never coins; the bigint printed digit for digit),
  // the recruit line "{name} joined your team!".
  'tactics.deploy.slot': {
    inputA: { n: 1 },
    outputA: 'Slot 1',
    inputB: { n: 3 },
    outputB: 'Slot 3',
  },
  'tactics.results.monster': {
    inputA: { name: 'Sprigg', xp: 53, essence: 7 },
    outputA: 'Sprigg: +53 XP, +7 essence',
    inputB: { name: 'Kip', xp: 0, essence: 11 },
    outputB: 'Kip: +0 XP, +11 essence',
  },
  'tactics.results.currency': {
    inputA: { amount: 123n },
    outputA: '+123 gold',
    inputB: { amount: 9_007_199_254_740_993n },
    outputB: '+9007199254740993 gold',
  },
  'tactics.results.recruited': {
    inputA: { name: 'Mossback' },
    outputA: 'Mossback joined your team!',
    inputB: { name: 'Flameling' },
    outputB: 'Flameling joined your team!',
  },
  // bt-12 increment B (BT12.2, plan §2.9): "Still there? {s} s" — the bare number, a space, then "s".
  'tactics.clock.stillThere': {
    inputA: { s: 42 },
    outputA: 'Still there? 42 s',
    inputB: { s: 7 },
    outputB: 'Still there? 7 s',
  },
  // bt-15 increment A (BT15.1, API freeze): "{n} vs {n}" — the bare number on both sides.
  'interact.challenge.size': {
    inputA: { n: 3 },
    outputA: '3 vs 3',
    inputB: { n: 1 },
    outputB: '1 vs 1',
  },
  // bt-15 increment B (BT15.2/BT15.3, API freeze): "{s} s left"; "{name}: {n} of {max} strikes";
  // "Rating {before} → {after} ({delta})" with the caller's signed delta; "Rating {after}".
  'tactics.clock.ring': {
    inputA: { s: 29 },
    outputA: '29 s left',
    inputB: { s: 4 },
    outputB: '4 s left',
  },
  'tactics.clock.strikes': {
    inputA: { name: 'Marrow', n: 3, max: 4 },
    outputA: 'Marrow: 3 of 4 strikes',
    inputB: { name: 'Quill', n: 0, max: 5 },
    outputB: 'Quill: 0 of 5 strikes',
  },
  'tactics.results.rating': {
    inputA: { before: 1000, after: 984, delta: '-16' },
    outputA: `Rating 1000 ${BT15_ARROW} 984 (-16)`,
    inputB: { before: 1493, after: 1509, delta: '+16' },
    outputB: `Rating 1493 ${BT15_ARROW} 1509 (+16)`,
  },
  'tactics.results.ratingNew': {
    inputA: { after: 1016 },
    outputA: 'Rating 1016',
    inputB: { after: 987 },
    outputB: 'Rating 987',
  },
  // uif-13 (UIF13.2): the Display tab's three lines; the label sits once, verbatim.
  'controls.text.row': {
    inputA: { label: 'Normal' },
    outputA: 'Text size: Normal',
    inputB: { label: 'Large' },
    outputB: 'Text size: Large',
  },
  'controls.text.current': {
    inputA: { label: 'Large' },
    outputA: 'Text size: Large (current)',
    inputB: { label: 'Extra large' },
    outputB: 'Text size: Extra large (current)',
  },
  'controls.text.set': {
    inputA: { label: 'Normal' },
    outputA: 'Text size: Normal.',
    inputB: { label: 'Extra large' },
    outputB: 'Text size: Extra large.',
  },
};

/** The full 511-key roster (bt-12 increment B: +2 `tactics.*` keys — `tactics.deploy.wilds` plain,
 *  `tactics.clock.stillThere` parameterised — and +5 plain `chrome.chip.*` deploy hint verbs over
 *  increment A's 504-key roster; bt-12 increment A: +18 `tactics.*` keys — 14 plain, 4 parameterised —
 *  over bt-11 increment C's 486-key roster; bt-11 increment C: +26 `tactics.*` keys — 12 plain, 14 parameterised —
 *  over increment B's roster; bt-11 increment B: +28 `tactics.*` keys — 26 plain, 2 parameterised —
 *  and +7 `chrome.chip.*` hint verbs over the 425-key roster below; bt-10: +60 `tactics.*` keys over the
 *  365-key roster below;
 *  qf-17: +`battle.rewards.{gold,xp}` over the 363-key roster below;
 *  qf-15: +`chrome.status.zoneEntered` over the 362-key roster below;
 *  qf-14: +`controls.accel.controls` over the 361-key roster below;
 *  qf-7c: -`battle.action.flee` over the 362-key roster below;
 *  qf-8: -`box.card.{toBox,toParty}` -`trade.action.{accept,reject,confirm,
 *  cancel}` -`pvp.incoming.{accept,decline}` -`pvp.outgoing.cancel` -`evolution.card.choosePrompt`
 *  -`evolution.choice.evolve` over the 373-key roster below;
 *  qf-9: -`raising.monsters.{heading,empty}` -`raising.card.{status,stats,
 *  care,train}` +`box.summary.stats` over the 378-key roster below; qf-6: +`dialogue.ended.{walkedAway,leftZone,npcGone}`
 *  +`quest.complete.{reward,done}` over the 373-key roster below; qf-4: +`journal.title`
 *  +`journal.empty` over the 371-key roster below; qf-3: +`box.sheet.careCooldown` over the
 *  370-key roster below;
 *  ctl-14: +`help.tab.{screen,controls,goals}`
 *  +`help.goal.{recruit,battle,trade}` +`help.note.keysVsButtons` over the 363-key roster below;
 *  ctl-13: +`chrome.chip.{ok,back,close,view,dismiss,done}`
 *  +`chrome.badge.request` +`notice.sheet.{accept,decline,view}` +`notice.request.{trade,challenge}`
 *  over the 351-key roster below; ctl-12b: +15 `controls.*` / `menu.options.controls.*` keys over the
 *  336-key roster below; ctl-12: +43 `key.*` / `controls.*` keys over the 293-key roster below;
 *  ctl-10b: -`pvp.players.{none,heading}` +`interact.verb.{trade,challenge}`
 *  +`interact.confirm.challenge` over the 292-key roster below;
 *  ctl-10a: -`box.heal` +`interact.{chip,choose,entry,healer}`
 *  +`interact.verb.{talk,shop,heal}` +`key.enter` over the 285-key roster below;
 *  ctl-8k: +`session.retry` +`session.hint` over the 283-key roster below;
 *  ctl-8j: -`battle.recruit.submit` -`battle.cure.placeholder`
 *  -`battle.cure.submit` +`battle.recruit.{listLabel,confirmNoBait,yes,no,confirm}`
 *  +`battle.cure.{listLabel,target}` over the 279-key roster below; ctl-8i: +`battle.command.{fight,recruit,swap,bag,run}`
 *  +`battle.commands.label` +`battle.command.runPvpReason` +`battle.commands.waiting`
 *  -`battle.skill.accuracy` over the 272-key roster below; ctl-8g: +`social.players.{nearby,none,walkUp}` over the 269-key roster
 *  below; ctl-8f: +`bag.pocket.{bait,food,medicine,other}`
 *  +`bag.action.{feed,use,info}` +`bag.picker.title` +`bag.feed.noMonsters` +`journal.detail.step`
 *  over the 259-key roster below; ctl-8e: +`tradePropose.step.{target,offer,coins,ask,review}`
 *  +`tradePropose.review.{prompt,incomplete,yes,no,summary}` over the 249-key roster below;
 *  ctl-8d: +`social.tab.{players,trades,challenges,rankings}`
 *  +`social.players.placeholder` +`social.action.{accept,decline,confirm,cancel}`
 *  +`social.confirm.{declineTrade,confirmTrade,declineChallenge}` over the 237-key roster below;
 *  ctl-8c: +`box.sheet.{care,feed,evolve,feedNone}` +`box.feed.item`
 *  +`box.evolve.confirm` +`box.feedback.fed` over the 230-key roster below; ctl-8b:
 *  -`box.card.rename` +`box.tab.{party,storage}`
 *  +`box.sheet.{summary,nickname,move}` +`box.feedback.{movedToParty,movedToBox}` over the 224-key
 *  roster below; ctl-8a:+`shop.tab.buy` +`shop.tab.sell` +`shop.description.none`
 *  +`prompt.yes` +`prompt.no` +`heal.prompt.unavailable` +`shop.qty.{buy,sell}`
 *  +`shop.confirm.{buy,sell}` +`heal.prompt.question` over the 213-key roster below; ctl-7d: -`shop.feedback.purchased` -`shop.feedback.sold`
 *  +`shop.feedback.{buy,sell}.{item,count}` over the 211-key roster below; ctl-7a: -`chrome.helpHint`
 *  +`chrome.chip.menu` +`chrome.chip.help` over the 210-key roster below; ctl-6c added the 2 `menu.disabled.*` keys to the 208-key roster; ctl-5 added the 29 `menu.*` keys to the 179-key roster; pgcc-a added `raising.feedback.cared` to the 178-key roster below;
 *  21r-b2 growth of 21r-b's 133-key roster by the 45 new `claim.*` /
 *  `privacy.*` keys; 21r-b had grown the 118-key roster by the 15 new
 *  `chrome.feedback.*`/`shop.feedback.*`/`trade.feedback.*`/`chrome.rename.updated`/
 *  `tradePropose.feedback.sent`/`chrome.session.*` keys), sorted — `EXPECTED_PLAIN` and
 *  `SAMPLE_PARAMS` are disjoint by construction (plain vs. parameterised), so their key union is
 *  exactly the roster. */
/** uif-14 (named intentional change, UIF14.1 / UIF14.2 / UIF14.4): the 36 plain Help ids added by the
 *  slice — the two tab titles, the two Introduction paragraphs and the sixteen entries' term and
 *  definition. Listed by id (the copy is authored with the slice; see the 'uif-14' describe). */
const UIF14_ENTRY_KEYS = [
  'party',
  'storage',
  'recruit',
  'bait',
  'evolution',
  'essence',
  'affinity',
  'status',
  'ap',
  'initiative',
  'queue',
  'idle',
  'stance',
  'guard',
  'deploy',
  'ranked',
] as const;
const UIF14_PLAIN_IDS: readonly string[] = [
  'help.tab.intro',
  'help.tab.encyclopedia',
  'help.intro.p1',
  'help.intro.p2',
  ...UIF14_ENTRY_KEYS.flatMap((key) => [`help.entry.${key}.term`, `help.entry.${key}.def`]),
];

/** uif-14b (named intentional change, UIF14B.1): the one plain id the slice adds, the Introduction's
 *  Report a problem row. Its en and fr bytes are pinned by the 'uif-14b' describe below. */
const UIF14B_PLAIN_IDS: readonly string[] = ['help.intro.report'];

/** ts-6b-8 (named intentional change, R-uif-10-TITLES): the one plain id the slice adds, the Heal
 *  frame's title. Its en and fr bytes are pinned by the 'ts-6b-8' describe below. */
const TS6B8_PLAIN_IDS: readonly string[] = ['heal.title'];

/** ts-6b-9 (named intentional change, R-weekly-review-2026-10-02-F4): the 17 `a11y.*` keys move into
 *  the catalogs (16 overlay titles + the world region), 528 -> 545. The en values are byte-identical
 *  to the literals `ui/a11yCopy.ts` held before the move (so the accessible names do not change);
 *  the fr values are pinned by the 'ts-6b-9' describe below. */
const TS6B9_A11Y_EN: Readonly<Record<string, string>> = {
  'a11y.overlay.battleView.title': 'Battle',
  'a11y.overlay.boxView.title': 'Monsters',
  'a11y.overlay.raisingView.title': 'Inventory',
  'a11y.overlay.evolutionView.title': 'Evolution',
  'a11y.overlay.dialogueView.title': 'Conversation',
  'a11y.overlay.questLogView.title': 'Journal (Quests)',
  'a11y.overlay.healView.title': 'Heal',
  'a11y.overlay.shopView.title': 'Shop',
  'a11y.overlay.tradeView.title': 'Incoming Trade',
  'a11y.overlay.pvpView.title': 'PvP Challenge',
  'a11y.overlay.leaderboardView.title': 'Leaderboard',
  'a11y.overlay.profileView.title': 'Profile',
  'a11y.overlay.tradeSessionView.title': 'Trade',
  'a11y.overlay.helpView.title': 'How to Play',
  'a11y.overlay.menuView.title': 'Menu',
  'a11y.overlay.controlsView.title': 'Controls',
  'a11y.world.region': 'World map',
};
const TS6B9_A11Y_IDS: readonly string[] = Object.keys(TS6B9_A11Y_EN);

const EXPECTED_KEYS = Object.keys(EXPECTED_PLAIN)
  .concat(UIF14_PLAIN_IDS)
  .concat(UIF14B_PLAIN_IDS)
  .concat(TS6B8_PLAIN_IDS)
  .concat(TS6B9_A11Y_IDS)
  .concat(Object.keys(SAMPLE_PARAMS))
  .sort();

describe('catalog.en — the English catalog: @desc adjacency, key grammar, and shape invariants (m24-s1, ADR-0256)', () => {
  it('m24s1 SHAPE-01: every catalog.en.ts entry line has an immediately-adjacent `// @desc:` comment with >=10 non-whitespace characters', () => {
    const violations = findDescViolations(RAW_SOURCE);
    expect(
      violations,
      `entries missing an adjacent @desc comment (>=10 non-ws chars): ${violations.join(', ')}`,
    ).toEqual([]);
  });

  // ctl-7a (named intentional change): this pin guarded the length of `chrome.helpHint` (a
  // fixed-position badge that must not overflow a 320px viewport). That key is deleted; the same
  // concern now applies to the two hint-bar chip labels, which share one row.
  it("m24s1 SHAPE-02: the hint-bar chip labels CATALOG_EN['chrome.chip.menu'] / ['chrome.chip.help'] are short strings (<=12 characters, exactly 4 today)", () => {
    for (const key of ['chrome.chip.menu', 'chrome.chip.help']) {
      const value = (CATALOG_EN as Record<string, unknown>)[key];
      expect(typeof value, `CATALOG_EN['${key}'] must be a string`).toBe('string');
      expect((value as string).length).toBeLessThanOrEqual(12);
      expect((value as string).length).toBe(4);
    }
  });

  it('m24s1 SHAPE-03: the ADR-0256 D5 key grammar (>=2 dot-segments, each [a-z][a-zA-Z0-9]*) accepts the boundary-valid fixtures, rejects the boundary-invalid fixtures, and accepts every real CATALOG_EN key', () => {
    // ctl-7a: 'chrome.helpHint' (deleted key) swapped for another camelCase-segment example.
    const validFixtures = ['a.b', 'chrome.tradePropose', 'chrome.status.disconnected'];
    const invalidFixtures = [
      'chrome',
      'chrome.',
      '.chrome',
      'chrome..status',
      'Battle.HPLine',
      'chrome.help_hint',
      'chrome.1x',
      'chrome.help-hint',
      'chrome.tradePropose ',
    ];
    for (const f of validFixtures) {
      expect(isValidKey(f), `${f} must be VALID`).toBe(true);
    }
    for (const f of invalidFixtures) {
      expect(isValidKey(f), `${f} must be INVALID`).toBe(false);
    }

    const realKeys = Object.keys(CATALOG_EN as Record<string, unknown>);
    expect(realKeys.length > 0, 'ANTI-VACUITY: CATALOG_EN must not be empty').toBe(true);
    for (const key of realKeys) {
      expect(isValidKey(key), `real key ${key} must satisfy the grammar`).toBe(true);
    }
  });

  it('m24s1 CATALOG-SHAPE: CATALOG_EN is frozen, its source entry-line count matches Object.keys, no own prototype-name keys, every value resolves to a non-empty string, the key roster is exactly the bt-12 511-key roster (bt-12 increment B, named intentional change, BT12.2/BT12.6: 504 → 511, +tactics.deploy.wilds, +tactics.clock.stillThere, +5 chrome.chip.*; bt-12, named intentional change, BT12.2/BT12.4/BT12.6: 486 → 504, +tactics.deploy/results.*; bt-11, named intentional change, BT11.1/BT11.6 then BT11.3/BT11.4/BT11.5: 425 → 486, +tactics.menu/reason/queue/ghost/dock.*, +chrome.chip.*, +tactics.badge/chip/forecast/projected.*; bt-10: 365 → 425, +tactics.*), and the source spells `satisfies Catalog` + `Object.freeze(` exactly once each', () => {
    expect(Object.isFrozen(CATALOG_EN), 'CATALOG_EN must be Object.freeze()d').toBe(true);

    const keys = Object.keys(CATALOG_EN as Record<string, unknown>);
    const entryLineCount = scanEntryLines(RAW_SOURCE).length;
    expect(
      entryLineCount,
      'the number of line-start-quoted-key entry lines in catalog.en.ts must equal Object.keys(CATALOG_EN).length — a key merely echoed in a comment must not count',
    ).toBe(keys.length);

    for (const forbidden of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(
        Object.hasOwn(CATALOG_EN as object, forbidden),
        `CATALOG_EN must not have an OWN key named ${forbidden}`,
      ).toBe(false);
    }

    let checked = 0;
    for (const key of keys) {
      const value = (CATALOG_EN as Record<string, unknown>)[key];
      if (typeof value === 'function') {
        // m24s3 (ADR-0259 D-generalise): a bare `{ where: 'x' }` only fits ONE ★ key —
        // SAMPLE_PARAMS supplies a real (first) sample set per key, so a ★ key with no
        // entry fails LOUDLY here rather than being called with a foreign shape.
        const sample = SAMPLE_PARAMS[key];
        if (sample === undefined) {
          throw new Error(
            `m24s1 CATALOG-SHAPE: function-valued key '${key}' has no SAMPLE_PARAMS entry — every parameterised key needs two sample param sets`,
          );
        }
        const result = (value as (p: Record<string, unknown>) => string)(sample[0]);
        expect(typeof result, `${key}(...) must return a string`).toBe('string');
        expect(result.length > 0, `${key}(...) must return a non-empty string`).toBe(true);
      } else {
        expect(typeof value, `CATALOG_EN[${key}] must be a string or a function`).toBe('string');
        expect((value as string).length > 0, `CATALOG_EN[${key}] must be non-empty`).toBe(true);
      }
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: every catalog key must have been examined').toBe(keys.length);

    expect(keys.slice().sort()).toEqual(EXPECTED_KEYS);

    // Belt-and-braces TEXT pin, scoped to this OWNED file: `satisfies
    // Catalog` restores the excess-property check that `Object.freeze<T>`'s generic signature
    // would otherwise swallow (plan §2 D2), and both structural checks above (Object.isFrozen,
    // the exact key-roster/stowaway checks) remain the REAL runtime backstop if this text pin is
    // ever weakened or the clause is dropped without breaking either of them.
    const strippedSource = stripComments(RAW_SOURCE);
    expect(
      countOccurrences(strippedSource, 'satisfies Catalog'),
      "catalog.en.ts must spell 'satisfies Catalog' exactly once",
    ).toBe(1);
    expect(
      countOccurrences(strippedSource, 'Object.freeze('),
      "catalog.en.ts must call 'Object.freeze(' exactly once",
    ).toBe(1);
  });

  it('m24s1 SHAPE-06: checkOneOtherUsage BITES when oneOther( appears in a catalog for a locale whose CLDR set exceeds {one, other}, and is silent for en; every real catalog.<tag>.ts in the i18n directory passes it', () => {
    // PROOF-OF-TEETH, asserted first: the helper itself must actually discriminate before it is
    // trusted on real files.
    expect(() => checkOneOtherUsage('ru', "x: oneOther('a','b')")).toThrow();
    expect(() => checkOneOtherUsage('en', "x: oneOther('a','b')")).not.toThrow();

    const found: string[] = [];
    for (const entry of readdirSync(I18N_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith('catalog.')) continue;
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      const tag = entry.name.slice('catalog.'.length, entry.name.length - '.ts'.length);
      const source = readFileSync(path.join(I18N_DIR, entry.name), 'utf8');
      found.push(tag);
      checkOneOtherUsage(tag, source);
    }
    expect(
      found.length > 0,
      `ANTI-VACUITY: at least catalog.en.ts must have been found under ${I18N_DIR}`,
    ).toBe(true);
  });
});

// =============================================================================
// The full roster, the SAMPLE_PARAMS bijection, and the
// byte-identical pinned values (both sample sets) for every migrated key.
//
// =============================================================================
describe('m24s3 (ADR-0259): catalog.en.ts — full roster, SAMPLE_PARAMS bijection, byte-identical migrated values', () => {
  it('m24s3/21r-b/21r-b2 CAT-01 [21R-B2-ROSTER-178]: the roster is exactly 511 keys (bt-12 increment B, named intentional change, BT12.2/BT12.6: 504 → 511, +2 tactics.*, +5 chrome.chip.*; bt-12, named intentional change, BT12.2/BT12.4/BT12.6: 486 → 504, +18 tactics.*; bt-11, named intentional change, BT11.1/BT11.6 then BT11.3/BT11.4/BT11.5: 425 → 486, +54 tactics.*, +7 chrome.chip.*; bt-10: 365 → 425, +tactics.*), SAMPLE_PARAMS is a bijection with the function-valued keys, every plain/param value is byte-identical to the pre-migration source (both sample sets), and the two glyph pins hold', () => {
    const keys = Object.keys(CATALOG_EN as Record<string, unknown>);

    // (a) roster is exactly the EXPECTED_KEYS roster (365 keys since qf-17: +2 parameterised,
    // `battle.rewards.gold` and `battle.rewards.xp`, the KO-win payout lines; 363 keys since qf-15: +1 parameterised,
    // `chrome.status.zoneEntered`, the zone cue's announcement template; 362 keys since qf-14: +1
    // plain, `controls.accel.controls`, the label of the Controls accelerator Y; 361 keys since
    // qf-7c: -1 plain, `battle.action.flee`, retired with the legacy battle Flee button; 362 since qf-8: -10 plain, -1
    // parameterised retired with the four views' mouse-only duplicate controls; 373 since qf-9: -3
    // plain, -3 parameterised retired with the raising Monsters section, +1 parameterised
    // `box.summary.stats`; 378 since qf-6: +3 plain, +2 parameterised; 373 since qf-4: +2 plain; 371
    // since qf-3: +1 parameterised; 370 since ctl-14: +7 plain; 363 since ctl-13: +10 plain, +2
    // parameterised; was 351 since ctl-12b).
    expect(keys.slice().sort()).toEqual(EXPECTED_KEYS);
    // qf-17 (named intentional change, QF17.1/QF17.2): 363 → 365, +battle.rewards.gold,
    // +battle.rewards.xp. (qf-15 had taken 362 → 363, +`chrome.status.zoneEntered`.)
    // bt-10 (named intentional change, BT10.5/BT10.6): 365 → 425, +60 `tactics.*` keys (31 plain in
    // EXPECTED_PLAIN, 29 parameterised in SAMPLE_PARAMS).
    // bt-11 increment B (named intentional change, BT11.1/BT11.6, plan REV 5 A39): +33 plain (26
    // `tactics.*`, 7 `chrome.chip.*`) in EXPECTED_PLAIN, +2 parameterised `tactics.reason.*`.
    // bt-11 increment C (named intentional change, BT11.3/BT11.4/BT11.5, plan REV 6 R6.7): +12 plain
    // and +14 parameterised `tactics.*` = 486.
    // bt-12 increment A (named intentional change, BT12.2/BT12.4/BT12.6, plan REV 2b B8): +14 plain
    // and +4 parameterised `tactics.*` = 504.
    // bt-12 increment B (named intentional change, BT12.2/BT12.6, plan §2.9): +6 plain (1 `tactics.*`,
    // 5 `chrome.chip.*`) in EXPECTED_PLAIN and +1 parameterised `tactics.clock.stillThere` = 511.
    // bt-15 increment A (named intentional change, BT15.1/BT15.5): +1 parameterised
    // `interact.challenge.size` (the Challenge pick's size rows) = 512.
    // bt-15 increment B (named intentional change, BT15.2/BT15.3/BT15.5): +9 plain and +4
    // parameterised `tactics.*` keys (the players label, the forfeit rows, the results reasons; the
    // clock ring, the strikes line, the rating lines) = 525.
    // bt-17 (named intentional change, BT17.1): -31 `battle.*` keys (18 plain, 13 parameterised)
    // with the 1v1 view; `battle.title` and `battle.outcome.{victory,defeat,fled}` stay = 494.
    // RED TODAY: catalog.en.ts still carries the 31 keys (the roster below is 525 there).
    // uif-7 (named intentional change, UIF7.2): 494 → 496, +kit.sheet.close, +kit.sheet.back.
    // uif-8 (named intentional change, UIF8.4): 496 -> 498, +bag.empty.cue, +bag.empty.next.
    // uif-12 (named intentional change, UIF12.3): 498 -> 499, +interact.chip.choose.
    // uif-13 (named intentional change, UIF13.2): 499 -> 506, +4 plain, +3 parameterised.
    // uif-14 (named intentional change, UIF14.1 / UIF14.4 / UIF14.5): 506 -> 536, -7 retired plain
    // `help.*` ids, +36 plain (`help.tab.{intro,encyclopedia}`, `help.intro.{p1,p2}`,
    // `help.entry.<16 keys>.{term,def}`), +1 parameterised (`help.detail.related`).
    // uif-15b (named intentional change, UIF15B.1): 536 -> 530, -6 plain
    // `menu.social.{trades,challenges,rankings}.{title,desc}` (the Social sub-list is gone).
    // uif-14b (named intentional change, UIF14B.1): 530 -> 531, +1 plain `help.intro.report`.
    // uif-16b (named intentional change): 531 -> 526: -4 menu.profile.* sub-list ids, -chrome.status.privacyOverlayBusy.
    // uif-15c (named intentional change, UIF15C.5): 526 -> 524: -2 plain `menu.options.{title,desc}`
    // (the Options group is gone); the `menu.options.{help,controls}.*` pairs are re-homed as
    // `menu.{help,controls}.*` (a net zero).
    // ts-3 (named intentional change, the Strangler, spec §ts-3 / ts-3.7): 524 -> 536: -13 wizard
    // keys (`chrome.tradePropose.submit`, `tradePropose.target.placeholder`,
    // `tradePropose.feedback.sent`, the 9 ctl-8e plain `tradePropose.{step,review}.*` keys and
    // `tradePropose.review.summary`), +25 (18 plain, 7 parameterised: `trade.status.open`,
    // `trade.row.{title,marks}`, `tradeSession.*`, `notice.request.trades`).
    // ts-4 (named intentional change, the Strangler's second half): 536 -> 527, -9 plain
    // (`trade.side.{offer,receive}`, `trade.feedback.{accepted,rejected,completed,cancelled}`,
    // `social.action.confirm`, `social.confirm.{declineTrade,confirmTrade}`).
    // ts-6b-8 (named intentional change, R-uif-10-TITLES): 527 -> 528, +heal.title.
    // ts-6b-9 (named intentional change, R-weekly-review-2026-10-02-F4): 528 -> 545, +17 `a11y.*`
    // keys (16 overlay titles + the world region) moved in from ui/a11yCopy.ts.
    // ts-6b-10 (named intentional change): -social.players.placeholder +tradeSession.prompt.confirmMonsters, 545 unchanged
    // ts-6b-11 (named intentional change): -claim.privacyButton -raising.inventory.heading
    // +privacy.disclosure, 545 -> 544.
    expect(EXPECTED_KEYS, 'ANTI-VACUITY: the pinned roster is 544 keys').toHaveLength(544);
    expect(
      EXPECTED_KEYS.filter((k) => k.startsWith('battle.')),
      'bt-17: the four surviving battle.* keys, and no other',
    ).toEqual([
      'battle.outcome.defeat',
      'battle.outcome.fled',
      'battle.outcome.victory',
      'battle.title',
    ]);

    // (b) SAMPLE_PARAMS keys === the set of function-valued catalog keys (bijection).
    const functionKeys = keys.filter(
      (k) => typeof (CATALOG_EN as Record<string, unknown>)[k] === 'function',
    );
    expect(
      functionKeys.slice().sort(),
      'SAMPLE_PARAMS must cover every parameterised key and nothing else',
    ).toEqual(Object.keys(SAMPLE_PARAMS).slice().sort());

    // (c) every PLAIN entry equals its expected English string.
    for (const [key, expected] of Object.entries(EXPECTED_PLAIN)) {
      const value = (CATALOG_EN as Record<string, unknown>)[key];
      expect(typeof value, `${key} must be a plain string`).toBe('string');
      expect(value, `${key} must be byte-identical to the pre-migration literal`).toBe(expected);
    }

    // (d) every closure's output for BOTH sample sets equals the exact expected string.
    for (const [key, spec] of Object.entries(EXPECTED_PARAM_OUTPUTS)) {
      const value = (CATALOG_EN as Record<string, unknown>)[key];
      expect(typeof value, `${key} must be a function`).toBe('function');
      const fn = value as (p: Record<string, unknown>) => string;
      expect(fn(spec.inputA), `${key}(sample A) must be byte-identical`).toBe(spec.outputA);
      expect(fn(spec.inputB), `${key}(sample B) must be byte-identical`).toBe(spec.outputB);
      expect(
        spec.outputA,
        `${key}: the two DIFFERING sample sets must produce DIFFERENT outputs — a closure that ` +
          'ignores a param would tie this',
      ).not.toBe(spec.outputB);
    }

    // (e) the glyph pins — by code point, not a pasted glyph.
    // bt-17 (named intentional change, BT17.1): the `battle.pvp.waiting` half (U+2019, U+2026) is
    // deleted with the key; pvp.outgoing.label's U+2026 / U+2014 pin below stays.
    const outgoingFn = (CATALOG_EN as Record<string, unknown>)['pvp.outgoing.label'] as (p: {
      target: string;
    }) => string;
    const outgoingSample = outgoingFn({ target: 'Zed' });
    expect(outgoingSample.includes('…'), 'pvp.outgoing.label output must carry U+2026').toBe(true);
    expect(
      outgoingSample.includes(' — '),
      'pvp.outgoing.label output must carry " " + U+2014 (em dash) + " "',
    ).toBe(true);

    // (f) bt-17 (named intentional change, BT17.1): the `battle.swap.hint` ". When" pin is deleted
    // with the key (the 1v1 bench hint).
  });

  it('m24s3 CAT-02: every STRING param value appears verbatim in its output (I18N-21 structural half, both sample sets), and the @desc census stays clean over the grown catalog', () => {
    for (const [key, spec] of Object.entries(EXPECTED_PARAM_OUTPUTS)) {
      const value = (CATALOG_EN as Record<string, unknown>)[key] as (
        p: Record<string, unknown>,
      ) => string;
      for (const sample of [spec.inputA, spec.inputB]) {
        const output = value(sample);
        for (const [field, fieldValue] of Object.entries(sample)) {
          if (typeof fieldValue === 'string') {
            expect(
              output.includes(fieldValue),
              `${key}: string param ${field}=${JSON.stringify(fieldValue)} must appear verbatim in the output ${JSON.stringify(output)}`,
            ).toBe(true);
          }
        }
      }
    }

    // Re-run the file's existing @desc adjacency scan over the GROWN catalog source —
    // proves the 32 new entries each carry their own adjacent `// @desc:` comment too,
    // not just the 10 pre-existing chrome.* rows m24s1 SHAPE-01 already covers.
    const violations = findDescViolations(RAW_SOURCE);
    expect(
      violations,
      `every entry (including the 32 new m24s3 keys) needs an adjacent @desc comment: ${violations.join(', ')}`,
    ).toEqual([]);
  });
});

// =============================================================================
// ctl-6c: the French values of the keys ctl-6c changed (battle.continueHint: A continues an
// outcome too, so the hint names Enter) or added (the two menu.disabled.* reasons), pinned exactly
// as the English ones are in EXPECTED_PLAIN above.
// =============================================================================

/** U+00E9 (e acute), built by code point so the expected French text holds no pasted glyph. */
const E_ACUTE = String.fromCharCode(0x00e9);

// bt-17 (named intentional change, BT17.1): the `battle.continueHint` row is deleted with the key
// (the 1v1 outcome's continue hint); the two menu.disabled.* rows stay.
const EXPECTED_FR_CTL6C: Record<string, string> = {
  'menu.disabled.inBattle': 'Impossible pendant un combat',
  // NAMED INTENTIONAL CHANGE (uif-15a, UIF15A.3): values only; was '…commande Sac du combat'.
  'menu.disabled.battleBag': 'Utilisez les objets avec la commande Objets du combat',
};

describe('ctl-6c: catalog.fr.ts, the battle keys ctl-6c changed or added', () => {
  it('ctl-6c FR-PINS: the two menu.disabled.* reasons are their exact French text, each a translation of its English entry (bt-17: the battle.continueHint half is deleted with the key)', () => {
    // WRONG IMPL KILLED (measured): the French continue hint left at, or reverted to, the
    // pre-ctl-6c "Appuyez sur Esc pour continuer" while the English one names Enter too (a French
    // player is never told that A continues the outcome); a French reason left as the English copy
    // or reworded; and an accented "Entree" whose e acute is not the precomposed U+00E9.
    for (const [key, expected] of Object.entries(EXPECTED_FR_CTL6C)) {
      const en = EXPECTED_PLAIN[key];
      expect(typeof en, `fixture: ${key} has an English pin`).toBe('string');
      const fr = (CATALOG_FR as Record<string, unknown>)[key];
      expect(typeof fr, `${key} must be a plain string in the fr catalog`).toBe('string');
      expect(fr, `${key}: the exact French text`).toBe(expected);
      expect(fr, `${key}: a translation, not the English copy`).not.toBe(en);
    }
  });
});

// =============================================================================
// ctl-7a: the hint-bar chip labels (Start / Select chips in #hint-bar) replace the deleted
// `chrome.helpHint` badge text.
// =============================================================================

describe('ctl-7a: the hint-bar chip catalog keys', () => {
  it('CTL7A-4-CATALOG-KEYS: both catalogs carry chrome.chip.menu (Menu / Menu) and chrome.chip.help (Help / Aide) as plain strings, and chrome.helpHint is gone from both', () => {
    // WRONG IMPL KILLED: a chip whose label is hard-coded in index.html or main.ts instead of
    // coming from the catalog (the keys would not exist); a key added to en only (fr falls back
    // to English in a French boot); `chrome.helpHint` left behind as a dead key.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    expect(en['chrome.chip.menu'], 'en chrome.chip.menu').toBe('Menu');
    expect(en['chrome.chip.help'], 'en chrome.chip.help').toBe('Help');
    expect(fr['chrome.chip.menu'], 'fr chrome.chip.menu').toBe('Menu');
    expect(fr['chrome.chip.help'], 'fr chrome.chip.help').toBe('Aide');
    expect(Object.hasOwn(en, 'chrome.helpHint'), 'en chrome.helpHint must be deleted').toBe(false);
    expect(Object.hasOwn(fr, 'chrome.helpHint'), 'fr chrome.helpHint must be deleted').toBe(false);
  });
});

// =============================================================================
// ctl-8a: the French values of the 11 keys ctl-8a adds (the shop tabs, quantity and confirm
// prompts and description mark, the shared Yes / No, the heal question and its disabled reason),
// pinned exactly as the English ones are in EXPECTED_PLAIN / EXPECTED_PARAM_OUTPUTS above. Each
// French closure is fed the same two sample sets as its English one.
// =============================================================================

/** U+00E0 (a grave) and U+2019 (right single quotation mark), built by code point. */
const A_GRAVE = String.fromCharCode(0x00e0);
const RIGHT_QUOTE = String.fromCharCode(0x2019);

const EXPECTED_FR_CTL8A_PLAIN: Record<string, string> = {
  'shop.tab.buy': 'Acheter',
  'shop.tab.sell': 'Vendre',
  'shop.description.none': EM_DASH,
  'prompt.yes': 'Oui',
  'prompt.no': 'Non',
  'heal.prompt.unavailable': `Aucun soigneur ${A_GRAVE} port${E_ACUTE}e. Soin indisponible.`,
};

/** The French output for sample A, then sample B, of each new parameterised key. */
const EXPECTED_FR_CTL8A_PARAMS: Record<string, readonly [string, string]> = {
  'shop.qty.buy': [
    `Combien de Herb acheter ? ${TIMES_SIGN}2`,
    `Combien de Tonic acheter ? ${TIMES_SIGN}99`,
  ],
  'shop.qty.sell': [
    `Combien de Berry vendre ? ${TIMES_SIGN}3`,
    `Combien de Relic vendre ? ${TIMES_SIGN}1`,
  ],
  'shop.confirm.buy': [
    'Acheter 2 Bait pour 40 or ?',
    'Acheter 3 Relic pour 27021597764222979 or ?',
  ],
  'shop.confirm.sell': ['Vendre 3 Berry pour 30 or ?', 'Vendre 1 Tonic pour 9007199254740993 or ?'],
  'heal.prompt.question': [
    `Soigner l${RIGHT_QUOTE}${E_ACUTE}quipe pour 25 gold ?`,
    `Soigner l${RIGHT_QUOTE}${E_ACUTE}quipe pour 2x Herb + 40 gold ?`,
  ],
};

describe('ctl-8a: catalog.fr.ts, the keys ctl-8a adds', () => {
  it('ctl-8a FR-PINS: the 6 new plain keys and the 5 new parameterised keys carry their exact French text in catalog.fr.ts, each French closure fed both English sample sets', () => {
    // WRONG IMPL KILLED (measured shapes): a key added to en only (t() throws in a French boot);
    // a French entry left as the English copy or reworded; a closure that drops or swaps a param;
    // a gold or quantity run through a locale formatter or a Number; a straight apostrophe (not
    // U+2019) or a decomposed e acute (not U+00E9) in the heal question's elided article; and a
    // question mark glued to its word or set off by a no-break space where the catalog table has a
    // plain space.
    for (const [key, expected] of Object.entries(EXPECTED_FR_CTL8A_PLAIN)) {
      expect(typeof EXPECTED_PLAIN[key], `fixture: ${key} has an English pin`).toBe('string');
      const fr = (CATALOG_FR as Record<string, unknown>)[key];
      expect(typeof fr, `${key} must be a plain string in the fr catalog`).toBe('string');
      expect(fr, `${key}: the exact French text`).toBe(expected);
    }
    for (const [key, [outputA, outputB]] of Object.entries(EXPECTED_FR_CTL8A_PARAMS)) {
      const spec = EXPECTED_PARAM_OUTPUTS[key];
      expect(spec, `fixture: ${key} has English output pins`).toBeDefined();
      const fr = (CATALOG_FR as Record<string, unknown>)[key];
      expect(typeof fr, `${key} must be a closure in the fr catalog`).toBe('function');
      const fn = fr as (p: Record<string, unknown>) => string;
      expect(fn((spec as ParamOutputSpec).inputA), `${key}(sample A) in French`).toBe(outputA);
      expect(fn((spec as ParamOutputSpec).inputB), `${key}(sample B) in French`).toBe(outputB);
    }
    expect(
      Object.keys(EXPECTED_FR_CTL8A_PLAIN).length + Object.keys(EXPECTED_FR_CTL8A_PARAMS).length,
      'ANTI-VACUITY: all 11 ctl-8a keys are pinned in French',
    ).toBe(11);
  });
});

// =============================================================================
// ctl-8d: the French values of the Social frame's 9 plain keys (the Social tabs, the Players
// placeholder, the action sheet's three rows and its one Yes / No question; ts-4.6: no offer-based
// trade row or question), pinned exactly as the English ones are in EXPECTED_PLAIN above. Before the
// `?` stands a U+00A0 NO-BREAK SPACE: the French typography convention catalog.fr.ts documents in
// its header and follows in `box.evolve.confirm`.
// =============================================================================

/** U+00C9 (capital E acute) and U+00A0 (no-break space), built by code point so the expected
 *  French text holds no pasted glyph (E_ACUTE and RIGHT_QUOTE are the ones declared above). */
const CAPITAL_E_ACUTE = String.fromCharCode(0x00c9);
const NO_BREAK_SPACE = String.fromCharCode(0x00a0);

const EXPECTED_FR_CTL8D_PLAIN: Record<string, string> = {
  'social.tab.players': 'Joueurs',
  'social.tab.trades': `${CAPITAL_E_ACUTE}changes`,
  'social.tab.challenges': `D${E_ACUTE}fis`,
  'social.tab.rankings': 'Classement',
  // ts-6b-10 (named intentional change): `social.players.placeholder` is retired (8 keys, was 9).
  'social.action.accept': 'Accepter',
  'social.action.decline': 'Refuser',
  'social.action.cancel': 'Annuler',
  'social.confirm.declineChallenge': `Refuser ce d${E_ACUTE}fi${NO_BREAK_SPACE}?`,
};

describe('ctl-8d: catalog.fr.ts, the Social frame`s keys', () => {
  it('ctl-8d FR-PINS: the 8 plain Social keys carry their exact French text in catalog.fr.ts, each a translation of its English entry', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot); a French entry left
    // as the English copy, reworded, or swapped with a sibling (Accepter / Refuser); a straight
    // apostrophe (not U+2019) in the placeholder; a decomposed or missing accent; and a question
    // mark glued to its word or set off by a plain breaking space instead of the catalog's U+00A0
    // (a browser could wrap the `?` onto a line of its own).
    for (const [key, expected] of Object.entries(EXPECTED_FR_CTL8D_PLAIN)) {
      const en = EXPECTED_PLAIN[key];
      expect(typeof en, `fixture: ${key} has an English pin`).toBe('string');
      const fr = (CATALOG_FR as Record<string, unknown>)[key];
      expect(typeof fr, `${key} must be a plain string in the fr catalog`).toBe('string');
      expect(fr, `${key}: the exact French text`).toBe(expected);
      expect(fr, `${key}: a translation, not the English copy`).not.toBe(en);
    }
    expect(
      Object.keys(EXPECTED_FR_CTL8D_PLAIN).length,
      // ts-6b-10 (named intentional change): -social.players.placeholder. Was: all 9, toBe(9).
      'ANTI-VACUITY: all 8 Social keys are pinned in French',
    ).toBe(8);
  });
});

// =============================================================================
// ts-4 (ts-4.6): no catalog carries an id of the offer-based trade surface; the ids the session
// rows, the session editor and the challenge sheet read stay in both.
// =============================================================================

/** The nine ids of the offer-based trade surface (the ts-4 plan "Resume 2"). HARD-CODED. */
const TS46_RETIRED_IDS = [
  'trade.side.offer',
  'trade.side.receive',
  'trade.feedback.accepted',
  'trade.feedback.rejected',
  'trade.feedback.completed',
  'trade.feedback.cancelled',
  'social.action.confirm',
  'social.confirm.declineTrade',
  'social.confirm.confirmTrade',
] as const;

/** Their neighbours that stay (other readers). HARD-CODED. */
const TS46_KEPT_IDS = [
  'trade.status.none',
  'trade.status.open',
  'trade.side.card',
  'trade.side.currency',
  'trade.side.nothing',
  'trade.row.title',
  'trade.row.marks',
  'social.action.accept',
  'social.action.decline',
  'social.action.cancel',
  'social.confirm.declineChallenge',
] as const;

describe('ts-4.6: the offer-based trade ids are in no catalog', () => {
  it('ts-4.6 CATALOG-RETIRED: the nine offer-based trade ids are own keys of neither catalog.en nor catalog.fr nor the pinned roster, while their eleven neighbours stay in both', () => {
    // WRONG IMPL KILLED: a retired id left in one catalog (a dead key catalogParity would also
    // flag, or an en-only deletion that leaves fr carrying a stray); a deletion that takes a
    // neighbour with it (the status line, the session row title and marks, the session editor's
    // side lines or the challenge sheet would read a missing id).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    for (const id of TS46_RETIRED_IDS) {
      expect(Object.hasOwn(en, id), `en ${id} is gone`).toBe(false);
      expect(Object.hasOwn(fr, id), `fr ${id} is gone`).toBe(false);
      expect(EXPECTED_KEYS.includes(id), `the pinned roster does not list ${id}`).toBe(false);
    }
    for (const id of TS46_KEPT_IDS) {
      expect(Object.hasOwn(en, id), `en ${id} stays`).toBe(true);
      expect(Object.hasOwn(fr, id), `fr ${id} stays`).toBe(true);
      expect(EXPECTED_KEYS.includes(id), `the pinned roster lists ${id}`).toBe(true);
    }
  });
});

// =============================================================================
// ts-3 (named intentional change, the Strangler): the ctl-8e describe "catalog.fr.ts, the keys
// ctl-8e adds" is DELETED with the trade-propose wizard and its keys. Adjudication:
//   CTL8E-1-VIEW-PAINT (the 9 plain keys + summary in fr) → ts-3.7 TS3-I18N
//     (ui/i18n/catalogParity.test.ts) | retired: wizard deleted by spec §ts-3 Strangler
//   CTL8E-1-VIEW-PAINT (the single-monster summary and its exact French) → ts-3.7 TS3-I18N
//     (ui/i18n/catalogParity.test.ts) | retired: wizard deleted by spec §ts-3 Strangler
// The ts-3 keys' French side (present in fr, distinct from en, every param interpolated) is
// pinned by TS3-I18N; their en bytes by CAT-01 above (EXPECTED_PLAIN / EXPECTED_PARAM_OUTPUTS).
// =============================================================================

// =============================================================================
// ctl-8g: the French side of the 3 keys ctl-8g adds (the Players tab's Nearby badge, its empty
// line and the walk-up line), pinned exactly as the English ones are above.
// =============================================================================

/** U+00C0 (capital A grave), built by code point (A_GRAVE above is the lowercase one). */
const CAPITAL_A_GRAVE = String.fromCharCode(0x00c0);

describe('ctl-8g: catalog.fr.ts, the keys ctl-8g adds', () => {
  it('ctl-8g FR-PINS: social.players.nearby and social.players.none carry their exact French text, social.players.walkUp is a closure carrying the name once and verbatim for both sample sets, and none is the English copy', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot, the whole Players
    // tab blank); a French entry left as the English copy; a decomposed or missing accent on
    // "A proximite"; a walk-up closure that drops the name, repeats it or swaps it for a fixed
    // string (both sample sets would print one line).
    const fr = CATALOG_FR as Record<string, unknown>;
    expect(fr['social.players.nearby'], 'the exact French badge').toBe(
      `${CAPITAL_A_GRAVE} proximit${E_ACUTE}`,
    );
    expect(fr['social.players.none'], 'the exact French empty line').toBe(
      'Aucun autre joueur en ligne',
    );
    for (const key of ['social.players.nearby', 'social.players.none']) {
      expect(fr[key], `${key}: a translation, not the English copy`).not.toBe(EXPECTED_PLAIN[key]);
    }
    const key = 'social.players.walkUp';
    const spec = EXPECTED_PARAM_OUTPUTS[key] as ParamOutputSpec;
    expect(spec, 'fixture: the English output pins exist').toBeDefined();
    expect(typeof fr[key], `${key} must be a closure in the fr catalog`).toBe('function');
    const fn = fr[key] as (p: Record<string, unknown>) => string;
    expect(fn(spec.inputA)).toBe('Approchez-vous de Zed et appuyez sur A');
    expect(fn(spec.inputB)).toBe('Approchez-vous de Amy et appuyez sur A');
    expect(fn(spec.inputA), 'a translation, not the English line').not.toBe(spec.outputA);
  });
});

// =============================================================================
// ctl-8j's French pins (the bait list, the Recruit confirm and its Yes / No, the cure list and the Bag
// target) and its retired-id loop are DELETED by bt-17 (named intentional change, BT17.1): every key
// they named is a 1v1 `battle.*` key deleted with ui/battleView.ts. The retired-id half's survivor is
// CAT-01's exact roster census (EXPECTED_KEYS holds no `battle.*` key but the four survivors).
// =============================================================================

/** U+00E2 (a circumflex), built by code point so the expected text holds no pasted glyph (the bt-15 B
 *  French pins below read it). */
const A_CIRCUMFLEX = String.fromCharCode(0x00e2);

// =============================================================================
// ctl-8k: the French side of the 2 keys ctl-8k adds (the session gate's Retry label and its frame
// hint), pinned exactly as the English ones are in EXPECTED_PLAIN above.
// =============================================================================

const EXPECTED_FR_CTL8K_PLAIN: Record<string, string> = {
  'session.retry': `R${E_ACUTE}essayer`,
  'session.hint': `B et Start sont sans effet ici. Tab pour naviguer, Entr${E_ACUTE}e pour choisir.`,
};

describe('ctl-8k: catalog.fr.ts, the keys ctl-8k adds', () => {
  it('ctl-8k FR-PINS: session.retry and session.hint carry their exact French text in catalog.fr.ts, each a translation of its English entry', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot, the whole session
    // gate blank); a French entry left as the English copy or reworded; and a decomposed or missing
    // accent in "Reessayer" / "Entree" (the e acute is the precomposed U+00E9).
    for (const [key, expected] of Object.entries(EXPECTED_FR_CTL8K_PLAIN)) {
      const en = EXPECTED_PLAIN[key];
      expect(typeof en, `fixture: ${key} has an English pin`).toBe('string');
      const fr = (CATALOG_FR as Record<string, unknown>)[key];
      expect(typeof fr, `${key} must be a plain string in the fr catalog`).toBe('string');
      expect(fr, `${key}: the exact French text`).toBe(expected);
      expect(fr, `${key}: a translation, not the English copy`).not.toBe(en);
    }
    expect(
      Object.keys(EXPECTED_FR_CTL8K_PLAIN).length,
      'ANTI-VACUITY: both ctl-8k keys are pinned in French',
    ).toBe(2);
  });
});

// =============================================================================
// uif-8 (UIF8.4): the Bag's EmptyState cue and next-step lines exist in BOTH catalogs.
// =============================================================================

describe('uif-8: the Bag EmptyState keys in both catalogs', () => {
  it('UIF8.4 bag.empty.cue and bag.empty.next are non-empty plain strings in en and in fr, the fr copy is a translation (not the en line), and the two lines differ from each other and from the reason line in each locale', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot and the whole Bag
    // panel stays blank); a French entry left as the English copy; one sentence used for both the
    // cue and the next step (the EmptyState would repeat itself); a cue or next step that just
    // repeats the reason line `raising.inventory.empty` (no new information for the player).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    for (const key of ['bag.empty.cue', 'bag.empty.next']) {
      expect(typeof en[key], `en ${key} is a plain string`).toBe('string');
      expect((en[key] as string).trim().length, `en ${key} is non-empty`).toBeGreaterThan(0);
      expect(en[key], `en ${key} is the pinned roster value`).toBe(EXPECTED_PLAIN[key]);
      expect(typeof fr[key], `fr ${key} is a plain string`).toBe('string');
      expect((fr[key] as string).trim().length, `fr ${key} is non-empty`).toBeGreaterThan(0);
      expect(fr[key], `fr ${key} is a translation, not the English copy`).not.toBe(en[key]);
    }
    for (const [name, cat] of [
      ['en', en],
      ['fr', fr],
    ] as const) {
      const lines = [
        cat['raising.inventory.empty'],
        cat['bag.empty.cue'],
        cat['bag.empty.next'],
      ] as string[];
      expect(
        new Set(lines).size,
        `${name}: reason, cue and next step are three different lines`,
      ).toBe(3);
    }
  });
});

// =============================================================================
// uif-14b (UIF14B.1): the Introduction's Report a problem row label in both catalogs.
// =============================================================================

describe('ts-6b-8: the Heal title in both catalogs', () => {
  it('ts-6b-8 heal.title is "Heal" in en and "Soins" in fr, both plain strings, the fr a translation', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot and the Heal frame is
    // untitled); an fr entry left as the English copy; a reworded title (the spec names it).
    // ts-6b-8 (named intentional change, R-uif-10-TITLES): 527 -> 528, +heal.title.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    expect(en['heal.title']).toBe('Heal');
    expect(fr['heal.title']).toBe('Soins');
    expect(fr['heal.title']).not.toBe(en['heal.title']);
  });
});

describe('ts-6b-9: the 17 a11y.* accessible names in both catalogs', () => {
  it('ts-6b-9 the en a11y.* values are byte-identical to the pre-move a11yCopy literals; every fr one is a plain non-empty string, translated except the cognate Menu / Conversation', () => {
    // WRONG IMPL KILLED: a key added to en only (a French boot throws on the first overlay open); an
    // en value reworded in the move (the accessible names would change under en); an fr value
    // copied through from en.
    // ts-6b-9 (named intentional change, R-weekly-review-2026-10-02-F4): 528 -> 545, +17 a11y.*.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    expect(Object.keys(TS6B9_A11Y_EN), 'ANTI-VACUITY: 17 pinned a11y keys').toHaveLength(17);
    let differing = 0;
    for (const [key, expected] of Object.entries(TS6B9_A11Y_EN)) {
      expect(en[key], `en ${key}`).toBe(expected);
      const frValue = fr[key];
      expect(typeof frValue, `fr ${key} is a plain string`).toBe('string');
      expect((frValue as string).trim().length > 0, `fr ${key} is non-empty`).toBe(true);
      if (frValue !== expected) differing += 1;
      else {
        expect(
          ['a11y.overlay.menuView.title', 'a11y.overlay.dialogueView.title'],
          `${key}: only the cognates may equal the English copy`,
        ).toContain(key);
      }
    }
    expect(differing, 'at least 15 of the 17 French names are translations').toBeGreaterThanOrEqual(
      15,
    );
    const a11yKeysIn = (c: Record<string, unknown>) =>
      Object.keys(c)
        .filter((k) => k.startsWith('a11y.'))
        .sort();
    expect(a11yKeysIn(en), 'en holds exactly the 17 a11y.* keys').toEqual(
      Object.keys(TS6B9_A11Y_EN).sort(),
    );
    expect(a11yKeysIn(fr), 'fr holds exactly the same 17').toEqual(a11yKeysIn(en));
  });
});

describe('uif-14b: the Report a problem label in both catalogs', () => {
  it('UIF14B.1 help.intro.report is "Report a problem" in en and "Signaler un probleme" (e grave, by code point) in fr, both plain strings, the fr a translation', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot and Help is blank); an
    // fr entry left as the English copy; a decomposed e grave (e + U+0300) instead of U+00E8; a
    // reworded label (the spec names the row).
    const E_GRAVE_CP = String.fromCharCode(0x00e8);
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    expect(en['help.intro.report']).toBe('Report a problem');
    expect(fr['help.intro.report']).toBe(`Signaler un probl${E_GRAVE_CP}me`);
    expect(fr['help.intro.report']).not.toBe(en['help.intro.report']);
  });
});

// =============================================================================
// uif-11 (UIF11.4, #586 D4): the battle menu's inventory row is "Items" / "Objets"; no tactical
// string still says Bag / Sac. `menu.disabled.battleBag` (the MAIN MENU's reason over a battle) is out
// of scope: its literal is pinned by raisingView.test.ts and mainMenuScreen.test.ts (R-uif-11-BATTLEBAGREASON).
// =============================================================================

describe('uif-11: the tactical menu says Items, not Bag, in both catalogs', () => {
  /** Every text a `tactics.*` key resolves to: a plain value, or a closure's output for BOTH sample sets. */
  const tacticsTexts = (catalog: Record<string, unknown>): string[] => {
    const out: string[] = [];
    for (const [key, value] of Object.entries(catalog)) {
      if (!key.startsWith('tactics.')) continue;
      if (typeof value === 'function') {
        const samples = SAMPLE_PARAMS[key];
        if (samples === undefined) throw new Error(`${key} is parameterised with no sample set`);
        for (const sample of samples)
          out.push((value as (p: Record<string, unknown>) => string)(sample));
      } else {
        out.push(String(value));
      }
    }
    return out;
  };

  it('UIF11.4 tactics.menu.item is Items in en and Objets in fr, and no tactics.* value says Bag (en) or Sac (fr)', () => {
    // WRONG IMPL KILLED: the value left at "Item" or "Bag"/"Sac" (the old copy); en changed and fr
    // left on "Sac" (a French boot keeps the old name); "Items" typed into another key; a wholesale
    // rewrite that renames the key (the exact key is read); a reworded en such as "Bag (items)" that
    // keeps the word; an accent-stripped "Objets" is the same bytes, so a decomposed "Objets" cannot occur.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    expect(en['tactics.menu.item'], 'en tactics.menu.item').toBe('Items');
    expect(fr['tactics.menu.item'], 'fr tactics.menu.item').toBe('Objets');
    const enTexts = tacticsTexts(en);
    const frTexts = tacticsTexts(fr);
    expect(enTexts.length, 'ANTI-VACUITY: many tactics.* texts were read').toBeGreaterThan(100);
    expect(frTexts.length, 'ANTI-VACUITY: many fr tactics.* texts were read').toBeGreaterThan(100);
    expect(
      enTexts.filter((t) => /\bbag\b/i.test(t)),
      'no en tactics.* value says Bag',
    ).toEqual([]);
    expect(
      frTexts.filter((t) => /\bsac\b/i.test(t)),
      'no fr tactics.* value says Sac',
    ).toEqual([]);
  });
});

// =============================================================================
// ctl-10a: the 8 keys ctl-10a adds (the world interaction chip, the picker / sheet row, the three
// verbs, the healer's name and the Enter keycap name) in BOTH catalogs, and the one it retires
// (`box.heal`, with the Box Heal Party button). The chip and row closures have the same shape in
// French (the verb and the keycap they carry are already localised); `Choose…` is translated.
// =============================================================================

const EXPECTED_FR_CTL10A_PLAIN: Record<string, string> = {
  'interact.verb.talk': 'Parler',
  'interact.verb.shop': 'Boutique',
  'interact.verb.heal': 'Soigner',
  'interact.healer': `Gu${E_ACUTE}risseur`,
  'key.enter': `Entr${E_ACUTE}e`,
};

/** The French output for sample A, then sample B, of each new parameterised key. */
const EXPECTED_FR_CTL10A_PARAMS: Record<string, readonly [string, string]> = {
  'interact.chip': [
    `[Enter] Talk ${EM_DASH} elder_oak`,
    `[KeyZ] Shop ${EM_DASH} tideglass_shopkeeper`,
  ],
  'interact.choose': [`[Enter] Choisir${ELLIPSIS}`, `[Space] Choisir${ELLIPSIS}`],
  'interact.entry': [`Talk ${EM_DASH} elder_oak`, `Heal ${EM_DASH} Healer`],
};

describe('ctl-10a: the interaction keys in both catalogs', () => {
  it('CTL10A-3-CATALOG: the 5 new plain keys and the 3 new closures carry their exact English and French text; each closure echoes every param in its slot for two differing sample sets; the plain French values are translations', () => {
    // WRONG IMPL KILLED (CTL10A.3: the chip reads `[{A keycap}] {verb} — {name}` or
    // `[{A keycap}] Choose…` from the live binding and the catalog): a key added to en only
    // (t() throws in a French boot, the chip and picker blank); a chip closure that hard-codes the
    // keycap ("[T]", "[Enter]") or the verb instead of reading its params (the sample sets differ
    // in every field); a hyphen or a spaced ASCII "--" where the catalog has U+2014, or three dots
    // where it has U+2026; brackets dropped from the keycap; a French "Choose…" left in English; a
    // French verb or name left as the English copy; and a decomposed or missing e acute in
    // "Guerisseur" / "Entree".
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    for (const [key, expected] of Object.entries(EXPECTED_FR_CTL10A_PLAIN)) {
      expect(en[key], `en ${key}: its exact text`).toBe(EXPECTED_PLAIN[key]);
      expect(typeof EXPECTED_PLAIN[key], `fixture: ${key} has an English pin`).toBe('string');
      expect(typeof fr[key], `${key} must be a plain string in the fr catalog`).toBe('string');
      expect(fr[key], `fr ${key}: the exact French text`).toBe(expected);
      expect(fr[key], `${key}: a translation, not the English copy`).not.toBe(en[key]);
    }
    for (const [key, [frA, frB]] of Object.entries(EXPECTED_FR_CTL10A_PARAMS)) {
      const spec = EXPECTED_PARAM_OUTPUTS[key] as ParamOutputSpec;
      expect(spec, `fixture: ${key} has English output pins`).toBeDefined();
      expect(typeof en[key], `en ${key} must be a closure`).toBe('function');
      expect(typeof fr[key], `fr ${key} must be a closure`).toBe('function');
      const enFn = en[key] as (p: Record<string, unknown>) => string;
      const frFn = fr[key] as (p: Record<string, unknown>) => string;
      expect(enFn(spec.inputA), `en ${key}(sample A)`).toBe(spec.outputA);
      expect(enFn(spec.inputB), `en ${key}(sample B)`).toBe(spec.outputB);
      expect(frFn(spec.inputA), `fr ${key}(sample A)`).toBe(frA);
      expect(frFn(spec.inputB), `fr ${key}(sample B)`).toBe(frB);
      expect(frA, `${key}: the two sample sets differ`).not.toBe(frB);
    }
    expect(
      Object.keys(EXPECTED_FR_CTL10A_PLAIN).length + Object.keys(EXPECTED_FR_CTL10A_PARAMS).length,
      'ANTI-VACUITY: all 8 ctl-10a keys are pinned in both catalogs',
    ).toBe(8);
  });

  it('CTL10A-4-ROSTER: `box.heal` (the Box Heal Party label) is gone from both catalogs and from the pinned roster', () => {
    // WRONG IMPL KILLED (CTL10A.4, B13): the Heal Party button removed from boxView while its
    // label stays behind in either catalog (catalogParity's DEAD-KEY would then fire on a key
    // nobody requests, or worse, a surviving requester keeps a Box heal path alive).
    expect(Object.hasOwn(CATALOG_EN as object, 'box.heal'), 'en box.heal is retired').toBe(false);
    expect(Object.hasOwn(CATALOG_FR as object, 'box.heal'), 'fr box.heal is retired').toBe(false);
    expect(EXPECTED_KEYS.includes('box.heal'), 'the pinned roster no longer lists it').toBe(false);
    // The other Box keys are untouched (a wholesale `box.*` deletion would also pass the three
    // lines above).
    // qf-10 (named intentional change, QF10.4): the value was 'Party & Box'; the id stays.
    expect((CATALOG_EN as Record<string, unknown>)['box.title']).toBe('Monsters');
  });
});

// =============================================================================
// ctl-10b: the face-to-face trade / challenge keys in BOTH catalogs, and the two pvp.players.* ids
// retired with the pvpView player list.
// =============================================================================

describe('ctl-10b: the Trade / Challenge keys in both catalogs', () => {
  it('CTL10B-2-CATALOG: interact.verb.trade / interact.verb.challenge are Trade / Challenge in en and Echanger / Defier (accented) in fr, interact.confirm.challenge is a closure carrying the name once and verbatim in both (en `Challenge {name}?`, fr `Defier {name} ?`), and pvp.players.none / pvp.players.heading are gone from both catalogs', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot, the picker rows and
    // the confirm blank); a French entry left as the English copy; a decomposed or missing accent
    // ("Echanger" with a plain E, "Defier" with a plain e); a confirm closure that drops or repeats
    // the name, or hard-codes the question; a retired pvp.players.* id left behind as a dead key
    // (catalogParity DEAD-KEY) in either catalog; and a roster edit that adds the three ids but
    // forgets to remove the two (293 keys: see CAT-01).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    expect(en['interact.verb.trade'], 'en trade verb').toBe('Trade');
    expect(en['interact.verb.challenge'], 'en challenge verb').toBe('Challenge');
    expect(fr['interact.verb.trade'], 'fr trade verb').toBe(`${CAPITAL_E_ACUTE}changer`);
    expect(fr['interact.verb.challenge'], 'fr challenge verb').toBe(`D${E_ACUTE}fier`);

    const enFn = en['interact.confirm.challenge'] as (p: Record<string, unknown>) => string;
    const frFn = fr['interact.confirm.challenge'] as (p: Record<string, unknown>) => string;
    expect(typeof enFn, 'en interact.confirm.challenge is a closure').toBe('function');
    expect(typeof frFn, 'fr interact.confirm.challenge is a closure').toBe('function');
    const spec = EXPECTED_PARAM_OUTPUTS['interact.confirm.challenge'] as ParamOutputSpec;
    expect(enFn(spec.inputA)).toBe('Challenge Rival?');
    expect(enFn(spec.inputB)).toBe('Challenge Zed?');
    // The French question mark follows the catalog's typography (a U+00A0 before it, as the
    // ctl-8d / ctl-8j keys have); a plain breaking space is accepted too, since ctl-8a's keys use one.
    for (const [input, name] of [
      [spec.inputA, 'Rival'],
      [spec.inputB, 'Zed'],
    ] as const) {
      const out = frFn(input);
      const accepted = [`D${E_ACUTE}fier ${name}${NO_BREAK_SPACE}?`, `D${E_ACUTE}fier ${name} ?`];
      expect(accepted, `fr interact.confirm.challenge(${name}): "${out}"`).toContain(out);
    }
    expect(frFn(spec.inputA), 'the two sample sets differ').not.toBe(frFn(spec.inputB));

    for (const retired of ['pvp.players.none', 'pvp.players.heading']) {
      expect(Object.hasOwn(en, retired), `en ${retired} is retired`).toBe(false);
      expect(Object.hasOwn(fr, retired), `fr ${retired} is retired`).toBe(false);
      expect(EXPECTED_KEYS.includes(retired), `the pinned roster no longer lists ${retired}`).toBe(
        false,
      );
    }
    // The other pvp keys are untouched (a wholesale `pvp.*` deletion would pass the loop above).
    // qf-8 (named intentional change): the control was `pvp.incoming.accept`, retired with the
    // challenge panel's Accept button; the incoming request's label is a surviving pvp key.
    expect(
      (en['pvp.incoming.label'] as (p: Record<string, unknown>) => string)({ challenger: 'Bob' }),
    ).toBe('Bob has challenged you!');
  });
});

// =============================================================================
// ctl-12b: the 15 keys the Options › Controls view and its menu leaf add, in BOTH catalogs. Before a
// `:` or a `?` the French text may carry the catalog's U+00A0 or a plain space (the ctl-10b
// precedent accepts both); every other byte is exact.
// =============================================================================

describe('ctl-12b: the Controls keys in both catalogs', () => {
  it('ctl-12b FR-PINS: the 11 new plain keys and the 4 new closures carry their exact English and French text; each closure echoes its params for two differing sample sets; the French values are translations', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot: the whole Controls
    // screen and the Options menu blank); a French entry left as the English copy; a slot closure
    // that drops the row label or the keycap, or swaps them (a cell that no longer names its row);
    // the Alt cell reading like the Primary one; a Clear or cleared line that hard-codes its row; a
    // decomposed or missing e acute in "réinitialiser" / "défaut" / "réglage"; and an ASCII
    // apostrophe where the catalog writes U+2019.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    /** `before` + (U+00A0 or a plain space) + `after`. */
    const spaced = (before: string, after: string): string[] => [
      `${before}${NO_BREAK_SPACE}${after}`,
      `${before} ${after}`,
    ];
    const FR_PLAIN: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['controls.title', ['Commandes']],
      ['controls.tab.buttons', ['Boutons']],
      ['controls.tab.shortcuts', ['Raccourcis']],
      ['controls.slot.none', [EM_DASH]],
      ['controls.resetAll', [`Tout r${E_ACUTE}initialiser`]],
      ['controls.reset.question', spaced(`R${E_ACUTE}initialiser toutes les commandes`, '?')],
      ['controls.reset.done', [`Toutes les commandes ont repris leur valeur par d${E_ACUTE}faut.`]],
      ['controls.cancel', ['Annuler']],
      [
        'controls.saveFailed',
        spaced(
          'Enregistrement impossible',
          `: ce r${E_ACUTE}glage dure jusqu${RIGHT_QUOTE}au rechargement.`,
        ),
      ],
      // uif-15c (named intentional change, UIF15C.5): the ids are re-homed, the values unchanged.
      // Was: 'menu.options.controls.title' / 'menu.options.controls.desc'.
      ['menu.controls.title', ['Commandes']],
      ['menu.controls.desc', ['Choisir la touche de chaque bouton.']],
    ];
    /** The French output for sample A, then sample B (the English SAMPLE_PARAMS sets). */
    const FR_PARAMS: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
      ['controls.slot.primary', spaced('Confirm (A)', ': Enter'), spaced('Bag', ': K')],
      ['controls.slot.alt', spaced('Up (alt.)', ': W'), spaced('Save bug report (alt.)', ': F9')],
      ['controls.clear', ['Effacer Bag'], ['Effacer Save bug report']],
      [
        'controls.cleared',
        [`Journal n${RIGHT_QUOTE}a plus de touche.`],
        [`Dismiss error n${RIGHT_QUOTE}a plus de touche.`],
      ],
    ];

    for (const [key, accepted] of FR_PLAIN) {
      expect(typeof EXPECTED_PLAIN[key], `fixture: ${key} has an English pin`).toBe('string');
      expect(en[key], `en ${key}: its exact text`).toBe(EXPECTED_PLAIN[key]);
      expect(typeof fr[key], `${key} must be a plain string in the fr catalog`).toBe('string');
      expect(accepted, `fr ${key}: ${JSON.stringify(fr[key])}`).toContain(fr[key]);
      if (key !== 'controls.slot.none') {
        expect(fr[key], `${key}: a translation, not the English copy`).not.toBe(en[key]);
      }
    }
    for (const [key, frA, frB] of FR_PARAMS) {
      const spec = EXPECTED_PARAM_OUTPUTS[key] as ParamOutputSpec;
      expect(spec, `fixture: ${key} has English output pins`).toBeDefined();
      expect(typeof en[key], `en ${key} must be a closure`).toBe('function');
      expect(typeof fr[key], `fr ${key} must be a closure`).toBe('function');
      const enFn = en[key] as (p: Record<string, unknown>) => string;
      const frFn = fr[key] as (p: Record<string, unknown>) => string;
      expect(enFn(spec.inputA), `en ${key}(sample A)`).toBe(spec.outputA);
      expect(enFn(spec.inputB), `en ${key}(sample B)`).toBe(spec.outputB);
      const outA = frFn(spec.inputA);
      const outB = frFn(spec.inputB);
      expect(frA, `fr ${key}(sample A): ${JSON.stringify(outA)}`).toContain(outA);
      expect(frB, `fr ${key}(sample B): ${JSON.stringify(outB)}`).toContain(outB);
      expect(outA, `${key}: the two sample sets differ`).not.toBe(outB);
      expect(outA, `${key}: a translation, not the English line`).not.toBe(spec.outputA);
    }
    expect(
      FR_PLAIN.length + FR_PARAMS.length,
      'ANTI-VACUITY: all 15 ctl-12b keys are pinned in both catalogs',
    ).toBe(15);
  });
});

// =============================================================================
// ctl-13: the 12 keys the live hint bar, the request banner and the request sheet add, in BOTH
// catalogs (the English text is pinned in EXPECTED_PLAIN / EXPECTED_PARAM_OUTPUTS above; catalogParity
// FR-01 checks every French closure reads the English closure's params). The exact French wording is
// the translator's, except the badge the plan names ("Nouveau").
// =============================================================================

describe('ctl-13: the notice keys in both catalogs', () => {
  it('ctl-13 FR-PINS: the 10 new plain keys exist as non-empty strings in fr (all but the OK chip differ from English), the badge reads "Nouveau", and each request line is a closure carrying the name once and verbatim for two differing names, in a French sentence, with the toast footer still naming F8 and B', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot and the whole hint
    // bar blanks); a French entry left as the English copy; a badge that is not the plan's
    // "Nouveau"; a request closure that drops, repeats or swaps the name, or hard-codes a key
    // ("press Y": the lines are key-free), and one identical for the trade and the challenge.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const PLAIN = [
      'chrome.chip.ok',
      'chrome.chip.back',
      'chrome.chip.close',
      'chrome.chip.view',
      'chrome.chip.dismiss',
      'chrome.chip.done',
      'chrome.badge.request',
      'notice.sheet.accept',
      'notice.sheet.decline',
      'notice.sheet.view',
    ] as const;
    expect(PLAIN, 'ANTI-VACUITY: ten plain keys').toHaveLength(10);
    for (const key of PLAIN) {
      expect(typeof EXPECTED_PLAIN[key], `fixture: ${key} has an English pin`).toBe('string');
      expect(typeof fr[key], `${key} must be a plain string in the fr catalog`).toBe('string');
      expect((fr[key] as string).length > 0, `${key} must be non-empty in fr`).toBe(true);
      if (key !== 'chrome.chip.ok') {
        expect(fr[key], `${key}: a translation, not the English copy`).not.toBe(en[key]);
      }
    }
    expect(fr['chrome.badge.request'], 'the French badge').toBe('Nouveau');

    for (const key of ['notice.request.trade', 'notice.request.challenge'] as const) {
      const spec = EXPECTED_PARAM_OUTPUTS[key] as ParamOutputSpec;
      expect(spec, `fixture: ${key} has English output pins`).toBeDefined();
      expect(typeof en[key], `en ${key} must be a closure`).toBe('function');
      expect(typeof fr[key], `fr ${key} must be a closure`).toBe('function');
      const frFn = fr[key] as (p: Record<string, unknown>) => string;
      const outA = frFn(spec.inputA);
      const outB = frFn(spec.inputB);
      expect(outA, `${key}: a translation, not the English line`).not.toBe(spec.outputA);
      expect(outA, `${key}: the two names differ`).not.toBe(outB);
      expect(outA.split('Bob').length - 1, `${key}: the name sits once`).toBe(1);
      expect(outB.split('Dana').length - 1).toBe(1);
    }
    expect(
      (fr['notice.request.trade'] as (p: Record<string, unknown>) => string)({ name: 'Bob' }),
      'the trade and the challenge read differently',
    ).not.toBe(
      (fr['notice.request.challenge'] as (p: Record<string, unknown>) => string)({ name: 'Bob' }),
    );
    expect(String(fr['errorOverlay.footer']), 'the French toast footer still names F8').toContain(
      'F8',
    );
    expect(` ${String(fr['errorOverlay.footer'])} `, 'and now names B too').toContain(' B ');
  });
});

// =============================================================================
// qf-3 (QF3.3): the remaining-cooldown hint the Monsters sheet shows after a cooling Care row's
// label, in BOTH catalogs. The English text is pinned above (EXPECTED_PARAM_OUTPUTS); here both
// closures are fed the same two sample sets and a third, and the French bytes are exact.
// =============================================================================

/** U+00EA (e circumflex), built by code point so the expected French text holds no pasted glyph. */
const QF3_E_CIRCUMFLEX = String.fromCharCode(0x00ea);

describe('qf-3: the care cooldown hint in both catalogs', () => {
  it('the care cooldown hint is catalogued in en and fr with hours/minutes params [QF3-3-CATALOG]', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot: the cooling Care row
    // goes blank); a French hint left as the English copy; a closure that hard-codes, drops or
    // swaps its params (hours read as minutes: both sample sets differ in both fields), pads them
    // ("05h") or prints a single combined figure; units glued to the digits or set off unlike the
    // catalog table; and a decomposed or missing circumflex in the French first word.
    const key = 'box.sheet.careCooldown';
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const spec = EXPECTED_PARAM_OUTPUTS[key] as ParamOutputSpec;
    expect(spec, 'fixture: the English output pins exist').toBeDefined();
    expect(SAMPLE_PARAMS[key], 'fixture: the two sample sets').toEqual([
      { hours: 5, minutes: 59 },
      { hours: 0, minutes: 1 },
    ]);
    expect(typeof en[key], `en ${key} must be a closure`).toBe('function');
    expect(typeof fr[key], `fr ${key} must be a closure`).toBe('function');
    const enFn = en[key] as (p: Record<string, unknown>) => string;
    const frFn = fr[key] as (p: Record<string, unknown>) => string;

    expect(enFn(spec.inputA), 'en, sample A').toBe('Ready in 5h 59m');
    expect(enFn(spec.inputB), 'en, sample B').toBe('Ready in 0h 1m');
    expect(frFn(spec.inputA), 'fr, sample A').toBe(`Pr${QF3_E_CIRCUMFLEX}t dans 5 h 59 min`);
    expect(frFn(spec.inputB), 'fr, sample B').toBe(`Pr${QF3_E_CIRCUMFLEX}t dans 0 h 1 min`);
    // A third set: two-digit hours, zero minutes.
    expect(enFn({ hours: 12, minutes: 0 }), 'en, 12h 0m').toBe('Ready in 12h 0m');
    expect(frFn({ hours: 12, minutes: 0 }), 'fr, 12 h 0 min').toBe(
      `Pr${QF3_E_CIRCUMFLEX}t dans 12 h 0 min`,
    );
    expect(frFn(spec.inputA), 'a translation, not the English line').not.toBe(spec.outputA);
  });
});

// =============================================================================
// qf-6 (QF6.2, QF6.4): the conversation-ended lines and the quest-completion lines the status line
// shows, in BOTH catalogs. Every expected byte is typed here (the French glyphs by code point);
// none is read off the catalog under test.
// =============================================================================

/** U+00EA (e circumflex) and U+00E7 (c cedilla), built by code point. E_ACUTE, RIGHT_QUOTE and
 *  NO_BREAK_SPACE are the ones declared above. */
const QF6_E_CIRCUMFLEX = String.fromCharCode(0x00ea);
const QF6_C_CEDILLA = String.fromCharCode(0x00e7);

/** The French text before ':' carries the catalog's U+00A0, not a breaking space: true when every
 *  ':' in `text` is preceded by U+00A0. */
function noBreakBeforeEveryColon(text: string): boolean {
  let colons = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 0x3a) continue;
    colons += 1;
    if (i === 0 || text.charCodeAt(i - 1) !== 0x00a0) return false;
  }
  return colons > 0;
}

describe('qf-6: the conversation-ended and quest-completion lines in both catalogs', () => {
  it('each conversation-ended line says the conversation ended and why, in en and fr QF6.2', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot: the refusal reaches
    // the player as nothing at all); the raw reducer reason as the copy; one generic line for all
    // three reasons (the player is not told why); a French line left in English; a French colon set
    // off by a breaking space (the browser may wrap it onto its own line) or glued to its word; an
    // ASCII apostrophe where the catalog writes U+2019; a decomposed or missing accent.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const ENDED_FR = `Conversation termin${E_ACUTE}e${NO_BREAK_SPACE}: `;
    const LINES: ReadonlyArray<readonly [string, string, string]> = [
      [
        'dialogue.ended.walkedAway',
        'Conversation ended: you moved too far away.',
        `${ENDED_FR}vous ${QF6_E_CIRCUMFLEX}tes trop loin.`,
      ],
      [
        'dialogue.ended.leftZone',
        'Conversation ended: you left the area.',
        `${ENDED_FR}vous avez quitt${E_ACUTE} la zone.`,
      ],
      [
        'dialogue.ended.npcGone',
        'Conversation ended: they are no longer here.',
        `${ENDED_FR}il n${RIGHT_QUOTE}y a plus personne ici.`,
      ],
    ];
    for (const [key, enText, frText] of LINES) {
      expect(en[key], `en ${key}`).toBe(enText);
      expect(fr[key], `fr ${key}`).toBe(frText);
      expect(noBreakBeforeEveryColon(fr[key] as string), `fr ${key}: U+00A0 before ':'`).toBe(true);
    }
    expect((fr['dialogue.ended.npcGone'] as string).includes("'"), 'no ASCII apostrophe').toBe(
      false,
    );
    expect(new Set(LINES.map(([, enText]) => enText)).size, 'three distinct reasons').toBe(3);
  });

  it('each quest-completion line names the quest, and the reward line the gold received, in en and fr QF6.4', () => {
    // WRONG IMPL KILLED: a key added to en only; a closure that drops, repeats or hard-codes the
    // quest name or the amount (the two sample sets differ in both); a gold amount run through a
    // locale formatter or a Number (9007199254740993 would print grouped or as ...992); the
    // reward line used where no gold moved (the two keys must differ); a French line left in
    // English; a French colon off its U+00A0; a decomposed or missing circumflex, acute or cedilla.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    for (const key of ['quest.complete.reward', 'quest.complete.done']) {
      expect(typeof en[key], `en ${key} is a closure`).toBe('function');
      expect(typeof fr[key], `fr ${key} is a closure`).toBe('function');
    }
    type Reward = (p: { name: string; amount: bigint }) => string;
    type Done = (p: { name: string }) => string;
    const enReward = en['quest.complete.reward'] as Reward;
    const frReward = fr['quest.complete.reward'] as Reward;
    const enDone = en['quest.complete.done'] as Done;
    const frDone = fr['quest.complete.done'] as Done;
    const QUEST_FR = `Qu${QF6_E_CIRCUMFLEX}te termin${E_ACUTE}e${NO_BREAK_SPACE}: `;
    const RECEIVED_FR = `Vous avez re${QF6_C_CEDILLA}u`;
    const BIG = 9_007_199_254_740_993n;

    expect(enReward({ name: 'quest_001', amount: 50n })).toBe(
      'Quest complete: quest_001. You received 50 gold.',
    );
    expect(enReward({ name: 'quest_002', amount: 7n })).toBe(
      'Quest complete: quest_002. You received 7 gold.',
    );
    expect(enReward({ name: 'quest_001', amount: BIG })).toBe(
      'Quest complete: quest_001. You received 9007199254740993 gold.',
    );
    expect(frReward({ name: 'quest_001', amount: 50n })).toBe(
      `${QUEST_FR}quest_001. ${RECEIVED_FR} 50 or.`,
    );
    expect(frReward({ name: 'quest_002', amount: 7n })).toBe(
      `${QUEST_FR}quest_002. ${RECEIVED_FR} 7 or.`,
    );
    expect(frReward({ name: 'quest_001', amount: BIG })).toBe(
      `${QUEST_FR}quest_001. ${RECEIVED_FR} 9007199254740993 or.`,
    );

    expect(enDone({ name: 'quest_001' })).toBe('Quest complete: quest_001.');
    expect(enDone({ name: 'quest_002' })).toBe('Quest complete: quest_002.');
    expect(frDone({ name: 'quest_001' })).toBe(`${QUEST_FR}quest_001.`);
    expect(frDone({ name: 'quest_002' })).toBe(`${QUEST_FR}quest_002.`);

    expect(noBreakBeforeEveryColon(frReward({ name: 'q', amount: 1n })), 'fr reward U+00A0').toBe(
      true,
    );
    expect(noBreakBeforeEveryColon(frDone({ name: 'q' })), 'fr done U+00A0').toBe(true);
  });
});

// =============================================================================
// ts-6b-11: the ids left with no requester (the Account section's privacy door, the Inventory
// in-panel heading) are retired, and the pseudonymization disclosure is catalogued.
// =============================================================================

describe('ts-6b-11: the two ids with no requester left are retired and the disclosure id is catalogued', () => {
  it('claim.privacyButton and raising.inventory.heading are in neither catalog nor the pinned roster, while privacy.disclosure is in both, plain, with en equal to the pinned constant and fr a different non-empty translation', () => {
    // WRONG IMPL KILLED: a retired id left behind as a dead key in either catalog (catalogParity
    // DEAD-KEY), or retired from en only (a French boot still carries it); the disclosure id added
    // to one catalog only, parameterised, or missing from the roster; an en value that drifts from
    // the pinned wording by a byte; a fr value that is the English text copied across, empty, or
    // missing the literal `Identity` token.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const RETIRED = ['claim.privacyButton', 'raising.inventory.heading'] as const;
    for (const retired of RETIRED) {
      expect(Object.hasOwn(en, retired), `en ${retired} is retired`).toBe(false);
      expect(Object.hasOwn(fr, retired), `fr ${retired} is retired`).toBe(false);
      expect(EXPECTED_KEYS.includes(retired), `the pinned roster no longer lists ${retired}`).toBe(
        false,
      );
    }
    expect(RETIRED, 'ANTI-VACUITY: two ids').toHaveLength(2);

    const KEY = 'privacy.disclosure';
    expect(Object.hasOwn(en, KEY), 'en carries the id').toBe(true);
    expect(Object.hasOwn(fr, KEY), 'fr carries the id').toBe(true);
    expect(EXPECTED_KEYS.includes(KEY), 'the pinned roster lists the id').toBe(true);
    expect(en[KEY], 'en is the pinned constant, byte for byte').toBe(
      PRIVACY_PSEUDONYMIZATION_DISCLOSURE,
    );
    const french = fr[KEY];
    expect(typeof french, 'fr is a plain string').toBe('string');
    expect((french as string).length, 'fr is non-empty').toBeGreaterThan(0);
    expect(french, 'fr is not the English text').not.toBe(PRIVACY_PSEUDONYMIZATION_DISCLOSURE);
    expect(french as string, 'fr keeps the literal Identity token').toContain('`Identity`');
  });

  it('the fr disclosure names purging and erasure only to deny them', () => {
    // The English is pinned byte for byte; the French is compliance copy too, and the legally false
    // claim is a French line that says the Identity history IS purged or that deletion IS erasure.
    // WRONG IMPL KILLED: a translation that drops the negation ("sont purgés des lignes", "et un
    // effacement"), says either word a second time, or leaves the English word in.
    const french = String((CATALOG_FR as Record<string, unknown>)['privacy.disclosure']);
    const count = (text: string, needle: string): number => {
      let n = 0;
      for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) n += 1;
      return n;
    };
    expect(count(french, 'purg'), 'the stem purg occurs once').toBe(1);
    expect(french, 'and only in the denial').toContain('ne sont pas purgés');
    expect(count(french, 'effac'), 'the stem effac occurs once').toBe(1);
    expect(french, 'and only in the denial').toContain('et non d\u2019un effacement');
    expect(count(french, 'erasure'), 'no English word left in').toBe(0);
  });
});

// =============================================================================
// qf-9 (QF9.1, QF9.2): the Summary's full-stats line in BOTH catalogs (exact bytes, two differing
// sample sets and a third), and the six raising ids retired with the raising screen's Monsters
// section. Every expected byte is typed here (the separator and the French capitals by code point);
// none is read off the catalog under test.
// =============================================================================

describe('qf-9: the Summary stats line and the retired raising ids', () => {
  const KEY = 'box.summary.stats';
  type StatsParams = {
    trust: string;
    attack: number;
    defense: number;
    speed: number;
    spAttack: number;
    spDefense: number;
  };
  const SET_A: StatsParams = {
    trust: 'Wary',
    attack: 11,
    defense: 22,
    speed: 33,
    spAttack: 44,
    spDefense: 55,
  };
  const SET_B: StatsParams = {
    trust: 'Devoted',
    attack: 101,
    defense: 87,
    speed: 64,
    spAttack: 120,
    spDefense: 99,
  };
  /** A third set with zeros: a falsy-fallback closure (`attack || '?'`) would hide here. */
  const SET_ZERO: StatsParams = {
    trust: 'Hostile',
    attack: 0,
    defense: 0,
    speed: 0,
    spAttack: 0,
    spDefense: 0,
  };
  const DOT = String.fromCharCode(0x00b7);

  it('the Summary stats line reads the exact English and French text, each field in its own slot, for three differing sample sets [QF9-1-CATALOG-STATS]', () => {
    // WRONG IMPL KILLED: a key added to en only (tf() throws in a French boot: the Summary goes
    // blank); a French line left as the English copy; two labels or two numbers swapped (every
    // field differs between the sets, and the zero set pins a falsy fallback); the trust tier
    // dropped or glued to the wrong label; "DEF" where French reads "DÉF" (a missing or
    // decomposed accent), "ATQ SPÉ" collapsed to "ATQ"; a separator that is a hyphen or a bullet
    // instead of U+00B7; a stat run through a locale formatter (the 120 would read "120" but a
    // 1,000-style grouping would show on a larger value; the closures take bare digits).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    expect(typeof en[KEY], 'en box.summary.stats is a closure').toBe('function');
    expect(typeof fr[KEY], 'fr box.summary.stats is a closure').toBe('function');
    const enFn = en[KEY] as (p: StatsParams) => string;
    const frFn = fr[KEY] as (p: StatsParams) => string;

    expect(enFn(SET_A)).toBe(
      `Trust Wary ${DOT} ATK 11 ${DOT} DEF 22 ${DOT} SPD 33 ${DOT} SP.ATK 44 ${DOT} SP.DEF 55`,
    );
    expect(enFn(SET_B)).toBe(
      `Trust Devoted ${DOT} ATK 101 ${DOT} DEF 87 ${DOT} SPD 64 ${DOT} SP.ATK 120 ${DOT} SP.DEF 99`,
    );
    expect(enFn(SET_ZERO)).toBe(
      `Trust Hostile ${DOT} ATK 0 ${DOT} DEF 0 ${DOT} SPD 0 ${DOT} SP.ATK 0 ${DOT} SP.DEF 0`,
    );

    const frLine = (p: StatsParams): string =>
      `Confiance ${p.trust} ${DOT} ATQ ${p.attack} ${DOT} D${CAPITAL_E_ACUTE}F ${p.defense} ` +
      `${DOT} VIT ${p.speed} ${DOT} ATQ SP${CAPITAL_E_ACUTE} ${p.spAttack} ` +
      `${DOT} D${CAPITAL_E_ACUTE}F SP${CAPITAL_E_ACUTE} ${p.spDefense}`;
    expect(frFn(SET_A)).toBe(frLine(SET_A));
    expect(frFn(SET_B)).toBe(frLine(SET_B));
    expect(frFn(SET_ZERO)).toBe(frLine(SET_ZERO));
    expect(frFn(SET_A), 'the exact French bytes, set A').toBe(
      `Confiance Wary ${DOT} ATQ 11 ${DOT} D${CAPITAL_E_ACUTE}F 22 ${DOT} VIT 33 ${DOT} ATQ SP${CAPITAL_E_ACUTE} 44 ${DOT} D${CAPITAL_E_ACUTE}F SP${CAPITAL_E_ACUTE} 55`,
    );

    expect(frFn(SET_A), 'a translation, not the English line').not.toBe(enFn(SET_A));
    expect(enFn(SET_A), 'the two sample sets differ (en)').not.toBe(enFn(SET_B));
    expect(frFn(SET_A), 'the two sample sets differ (fr)').not.toBe(frFn(SET_B));
    // The trust tier is carried verbatim, once, in both languages.
    for (const set of [SET_A, SET_B, SET_ZERO]) {
      expect(enFn(set).split(set.trust).length - 1, `en carries ${set.trust} once`).toBe(1);
      expect(frFn(set).split(set.trust).length - 1, `fr carries ${set.trust} once`).toBe(1);
    }
  });

  it('the six raising ids that carried the retired Monsters section are gone from both catalogs, the pinned roster and the sample tables, while the inventory ids stay [QF9-2-CATALOG-RETIRED]', () => {
    // WRONG IMPL KILLED: a retired id left behind as a dead key in either catalog (catalogParity
    // DEAD-KEY fires, or worse a surviving requester keeps the removed section half alive); an id
    // retired from en only (a French boot still carries it); a wholesale `raising.*` deletion (the
    // kept ids below would go with it); the new id missing from the roster.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const RETIRED = [
      'raising.monsters.heading',
      'raising.monsters.empty',
      'raising.card.status',
      'raising.card.stats',
      'raising.card.care',
      'raising.card.train',
    ] as const;
    for (const retired of RETIRED) {
      expect(Object.hasOwn(en, retired), `en ${retired} is retired`).toBe(false);
      expect(Object.hasOwn(fr, retired), `fr ${retired} is retired`).toBe(false);
      expect(EXPECTED_KEYS.includes(retired), `the pinned roster no longer lists ${retired}`).toBe(
        false,
      );
    }
    expect(RETIRED, 'ANTI-VACUITY: six ids').toHaveLength(6);

    for (const kept of [
      'raising.title',
      'raising.inventory.empty',
      'raising.inventory.item',
      'raising.feedback.cared',
    ]) {
      expect(Object.hasOwn(en, kept), `en ${kept} stays`).toBe(true);
      expect(Object.hasOwn(fr, kept), `fr ${kept} stays`).toBe(true);
    }
    expect(Object.hasOwn(en, KEY), 'en carries the new id').toBe(true);
    expect(Object.hasOwn(fr, KEY), 'fr carries the new id').toBe(true);
    expect(EXPECTED_KEYS.includes(KEY), 'the pinned roster lists the new id').toBe(true);
    // qf-8 (named intentional change): 373 → 362, the eleven ids qf-8 retired with the four views'
    // mouse-only duplicate controls (CAT-01 lists them).
    // qf-7c (named intentional change, QF7B.1): 362 → 361, `battle.action.flee` retired with the
    // legacy battle Flee button (the command list's Run is the only flee).
    // qf-14 (named intentional change, QF14.1): 361 → 362, +`controls.accel.controls`.
    // qf-15 (named intentional change, QF15.1): 362 → 363, +`chrome.status.zoneEntered`.
    // qf-17 (named intentional change, QF17.1/QF17.2): 363 → 365, +battle.rewards.gold,
    // +battle.rewards.xp.
    // bt-10 (named intentional change, BT10.5/BT10.6): 365 → 425, +tactics.*
    // bt-11 (named intentional change, BT11.1/BT11.6): +28 tactics.*, +7 chrome.chip.*; increment C
    // (BT11.3/BT11.4/BT11.5): +26 tactics.* = 486.
    // bt-12 increment A (named intentional change, BT12.2/BT12.4/BT12.6): +18 tactics.* = 504.
    // bt-12 increment B (named intentional change, BT12.2/BT12.6): +2 tactics.*
    // (tactics.deploy.wilds, tactics.clock.stillThere), +5 chrome.chip.* (deploy, editFormation,
    // assign, prevMonster, nextMonster) = 511.
    // NAMED INTENTIONAL CHANGE (bt-12 B, plan §2.9): 504 → 511.
    // NAMED INTENTIONAL CHANGE (bt-15 A, BT15.1): 511 → 512, +interact.challenge.size.
    // NAMED INTENTIONAL CHANGE (bt-15 B, BT15.2/BT15.3/BT15.5): 512 → 525, +13 tactics.*.
    // NAMED INTENTIONAL CHANGE (bt-17, BT17.1): 525 → 494, -31 1v1 battle.*.
    // NAMED INTENTIONAL CHANGE (uif-7, UIF7.2): 494 → 496, +kit.sheet.close, +kit.sheet.back.
    // uif-8 (named intentional change, UIF8.4): 496 -> 498, +bag.empty.cue, +bag.empty.next
    // uif-12 (named intentional change, UIF12.3): 498 -> 499, +interact.chip.choose.
    // uif-13 (named intentional change, UIF13.2): 499 -> 506, +4 plain, +3 parameterised.
    // uif-14 (named intentional change, UIF14.1/UIF14.4): 506 -> 536, -7 retired help.*, +36 plain, +1 parameterised.
    // uif-15b (named intentional change, UIF15B.1): 536 -> 530, -6 retired menu.social.* sub-list ids.
    // uif-14b (named intentional change, UIF14B.1): 530 -> 531, +1 plain help.intro.report.
    // uif-16b (named intentional change): 531 -> 526: -4 menu.profile.* sub-list ids, -chrome.status.privacyOverlayBusy.
    // uif-15c (named intentional change, UIF15C.5): 526 -> 524, -2 `menu.options.{title,desc}` (the
    // `menu.options.{help,controls}.*` pairs are re-homed as `menu.{help,controls}.*`, a net zero).
    // ts-3: 524 -> 536 (-13 wizard, +25 session keys).
    // ts-4 (named intentional change): 536 -> 527, -9 trade.side.* / trade.feedback.* /
    // social.action.confirm / social.confirm.{declineTrade,confirmTrade}.
    // ts-6b-8 (named intentional change, R-uif-10-TITLES): 527 -> 528, +heal.title.
    // ts-6b-9 (named intentional change): 528 -> 545, +17 `a11y.*` keys.
    // ts-6b-10 (named intentional change): -social.players.placeholder +tradeSession.prompt.confirmMonsters, 545 unchanged
    // ts-6b-11 (named intentional change): -claim.privacyButton -raising.inventory.heading
    // +privacy.disclosure, 545 -> 544.
    expect(Object.keys(en).length, 'the English catalog holds exactly 544 keys').toBe(544);
    expect(Object.keys(fr).length, 'and so does the French one').toBe(544);
  });
});

// =============================================================================
// qf-8 (QF8.1): the eleven ids whose only requesters were the four views' mouse-only duplicate
// controls (the cards' To Box / To Party, the trade row's four buttons, the challenge panel's
// Accept / Decline / Cancel Challenge, the evolution view's prompt and choice buttons), retired with
// them, and `box.hint`, which keeps its id and changes VALUE (the spec's values-only rule) to name
// the Monsters sheet's Move row. Every expected byte is typed here from the qf-8 plan §1.5 (the
// French glyphs by code point); none is read off the catalog under test. The French quote follows
// catalog.fr.ts's documented typography: a U+00A0 inside « » guillemets.
// =============================================================================

/** U+00EA (e circumflex), U+00EE (i circumflex) and the two guillemets U+00AB / U+00BB, built by
 *  code point. E_ACUTE, RIGHT_QUOTE, NO_BREAK_SPACE and EM_DASH are the ones declared above. */
const QF8_E_CIRCUMFLEX = String.fromCharCode(0x00ea);
const QF8_I_CIRCUMFLEX = String.fromCharCode(0x00ee);
const QF8_LEFT_GUILLEMET = String.fromCharCode(0x00ab);
const QF8_RIGHT_GUILLEMET = String.fromCharCode(0x00bb);

/** The French Move label `box.hint` quotes (plan §1.5: Move / Déplacer). */
const QF8_FR_MOVE = `D${E_ACUTE}placer`;

/** The French `box.hint`, byte for byte (qf-8 plan §1.5). NAMED INTENTIONAL CHANGE (qf-10, QF10.4):
 *  the destination reads "le Stockage" (was "votre Boîte"); every other byte is unchanged. */
const QF8_FR_BOX_HINT =
  `Seuls les monstres de votre ${E_ACUTE}quipe peuvent combattre ou ${QF8_E_CIRCUMFLEX}tre ` +
  `${E_ACUTE}chang${E_ACUTE}s en cours de combat. Les nouvelles recrues arrivent dans le ` +
  `Stockage ${EM_DASH} s${E_ACUTE}lectionnez-en une et choisissez ` +
  `${QF8_LEFT_GUILLEMET}${NO_BREAK_SPACE}${QF8_FR_MOVE}${NO_BREAK_SPACE}${QF8_RIGHT_GUILLEMET} ` +
  `pour la placer dans un emplacement libre de l${RIGHT_QUOTE}${E_ACUTE}quipe.`;

describe('qf-8: the ids retired with the mouse-only duplicates, and the box hint that names Move', () => {
  it('the eleven ids that labelled the four views` mouse-only duplicate controls are gone from both catalogs and the pinned roster, while the views` surviving ids and the Social sheet`s answer rows stay, 527 keys each (ts-4, named intentional change: 536 → 527, -9 trade.side.* / trade.feedback.* / social.action.confirm / social.confirm.{declineTrade,confirmTrade}; bt-12 increment B, named intentional change, BT12.2/BT12.6: 504 → 511, +2 tactics.* (tactics.deploy.wilds, tactics.clock.stillThere), +5 chrome.chip.* (deploy, editFormation, assign, prevMonster, nextMonster); bt-12, named intentional change, BT12.2/BT12.4/BT12.6: 486 → 504; bt-11, named intentional change, BT11.1/BT11.6 then BT11.3/BT11.4/BT11.5: 425 → 486; bt-10: 365 → 425, +tactics.*) [QF8-1-CATALOG-RETIRED]', () => {
    // WRONG IMPL KILLED: a retired id left behind as a dead key in either catalog (catalogParity
    // DEAD-KEY fires, or a surviving requester keeps a deleted control half alive); an id retired
    // from en only (a French boot still carries it); a wholesale `box.card.*`, `trade.*`,
    // `pvp.incoming.*`, `pvp.outgoing.*` or `evolution.*` deletion (the kept ids below go with
    // it); and the Social sheet's answer rows retired with the panel buttons they replace (the nav
    // path, now the only one, would lose its words).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const RETIRED = [
      'box.card.toBox',
      'box.card.toParty',
      'trade.action.accept',
      'trade.action.reject',
      'trade.action.confirm',
      'trade.action.cancel',
      'pvp.incoming.accept',
      'pvp.incoming.decline',
      'pvp.outgoing.cancel',
      'evolution.card.choosePrompt',
      'evolution.choice.evolve',
    ] as const;
    expect(RETIRED, 'ANTI-VACUITY: eleven ids').toHaveLength(11);
    for (const retired of RETIRED) {
      expect(Object.hasOwn(en, retired), `en ${retired} is retired`).toBe(false);
      expect(Object.hasOwn(fr, retired), `fr ${retired} is retired`).toBe(false);
      expect(EXPECTED_KEYS.includes(retired), `the pinned roster no longer lists ${retired}`).toBe(
        false,
      );
    }

    const KEPT = [
      // boxView: the hint (a new value), the Move row it quotes, the card's badge and stats.
      'box.hint',
      'box.sheet.move',
      'box.card.evolveBadge',
      'box.card.stats',
      // tradeView: the status line.
      'trade.status.none',
      // pvpView: the title and the two request labels the Social cursor marks.
      'pvp.title.challenge',
      'pvp.incoming.label',
      'pvp.outgoing.label',
      // evolutionView: the hint, the ready note and the path heading.
      'evolution.hint',
      'evolution.card.ready',
      'evolution.path.heading',
      // The Social sheet's rows: where Accept / Decline / Cancel live now.
      'social.action.accept',
      'social.action.decline',
      'social.action.cancel',
    ] as const;
    for (const kept of KEPT) {
      expect(Object.hasOwn(en, kept), `en ${kept} stays`).toBe(true);
      expect(Object.hasOwn(fr, kept), `fr ${kept} stays`).toBe(true);
      expect(EXPECTED_KEYS.includes(kept), `the pinned roster keeps ${kept}`).toBe(true);
    }
    // qf-7c (named intentional change, QF7B.1): 362 → 361, `battle.action.flee` retired with the
    // legacy battle Flee button.
    // qf-14 (named intentional change, QF14.1): 361 → 362, +`controls.accel.controls`.
    // qf-15 (named intentional change, QF15.1): 362 → 363, +`chrome.status.zoneEntered`.
    // qf-17 (named intentional change, QF17.1/QF17.2): 363 → 365, +battle.rewards.gold,
    // +battle.rewards.xp.
    // bt-10 (named intentional change, BT10.5/BT10.6): 365 → 425, +tactics.*
    // bt-11 (named intentional change, BT11.1/BT11.6): +28 tactics.*, +7 chrome.chip.*; increment C
    // (BT11.3/BT11.4/BT11.5): +26 tactics.* = 486.
    // bt-12 increment A (named intentional change, BT12.2/BT12.4/BT12.6): +18 tactics.* = 504.
    // bt-12 increment B (named intentional change, BT12.2/BT12.6): +2 tactics.*
    // (tactics.deploy.wilds, tactics.clock.stillThere), +5 chrome.chip.* (deploy, editFormation,
    // assign, prevMonster, nextMonster) = 511.
    // NAMED INTENTIONAL CHANGE (bt-12 B, plan §2.9): 504 → 511.
    // NAMED INTENTIONAL CHANGE (bt-15 A, BT15.1): 511 → 512, +interact.challenge.size.
    // NAMED INTENTIONAL CHANGE (bt-15 B, BT15.2/BT15.3/BT15.5): 512 → 525, +13 tactics.*.
    // NAMED INTENTIONAL CHANGE (bt-17, BT17.1): 525 → 494, -31 1v1 battle.*.
    // NAMED INTENTIONAL CHANGE (uif-7, UIF7.2): 494 → 496, +kit.sheet.close, +kit.sheet.back.
    // uif-8 (named intentional change, UIF8.4): 496 -> 498, +bag.empty.cue, +bag.empty.next
    // uif-12 (named intentional change, UIF12.3): 498 -> 499, +interact.chip.choose.
    // uif-13 (named intentional change, UIF13.2): 499 -> 506, +4 plain, +3 parameterised.
    // uif-14 (named intentional change, UIF14.1/UIF14.4): 506 -> 536, -7 retired help.*, +36 plain, +1 parameterised.
    // uif-15b (named intentional change, UIF15B.1): 536 -> 530, -6 retired menu.social.* sub-list ids.
    // uif-14b (named intentional change, UIF14B.1): 530 -> 531, +1 plain help.intro.report.
    // uif-16b (named intentional change): 531 -> 526: -4 menu.profile.* sub-list ids, -chrome.status.privacyOverlayBusy.
    // uif-15c (named intentional change, UIF15C.5): 526 -> 524, -2 `menu.options.{title,desc}` (the
    // `menu.options.{help,controls}.*` pairs are re-homed as `menu.{help,controls}.*`, a net zero).
    // ts-3: 524 -> 536 (-13 wizard, +25 session keys).
    // ts-4 (named intentional change): 536 -> 527, -9 trade.side.* / trade.feedback.* /
    // social.action.confirm / social.confirm.{declineTrade,confirmTrade}.
    // ts-6b-8 (named intentional change, R-uif-10-TITLES): 527 -> 528, +heal.title.
    // ts-6b-9 (named intentional change): 528 -> 545, +17 `a11y.*` keys.
    // ts-6b-10 (named intentional change): -social.players.placeholder +tradeSession.prompt.confirmMonsters, 545 unchanged
    // ts-6b-11 (named intentional change): -claim.privacyButton -raising.inventory.heading
    // +privacy.disclosure, 545 -> 544.
    expect(Object.keys(en).length, 'the English catalog holds exactly 544 keys').toBe(544);
    expect(Object.keys(fr).length, 'and so does the French one').toBe(544);
  });

  it('box.hint names the Monsters sheet`s Move row in both catalogs: the exact en and fr copy, each quoting its own locale`s box.sheet.move, the French quote inside guillemets with no-break spaces [QF8-1-CATALOG-BOX-HINT]', () => {
    // WRONG IMPL KILLED: the hint left quoting the retired "To Party" button in either locale (the
    // player hunts for a control that no longer exists: ux1, ADR-0151); the copy reworded in en
    // only (a French boot still points at the deleted button); a quoted label that drifted from
    // the sheet row's own text (box.sheet.move), or the English "Move" inside the French copy; a
    // French quote in ASCII quotes, or set off by breaking spaces inside « » (catalog.fr.ts's
    // typography: a browser could wrap a guillemet away from its word); a decomposed or missing
    // accent; and a renamed id where the spec allows only a new value (the test reads `box.hint`).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    // The quoted label, each locale's Monsters sheet row (plan §1.5: Move / Déplacer).
    expect(en['box.sheet.move'], 'fixture: the English Move row').toBe('Move');
    expect(fr['box.sheet.move'], 'the French Move row').toBe(QF8_FR_MOVE);

    expect(en['box.hint'], 'the exact English copy (plan §1.5)').toBe(EXPECTED_PLAIN['box.hint']);
    expect(fr['box.hint'], 'the exact French copy (plan §1.5)').toBe(QF8_FR_BOX_HINT);

    const enHint = String(en['box.hint']);
    const frHint = String(fr['box.hint']);
    expect(enHint, 'en quotes its own Move row').toContain(`"${String(en['box.sheet.move'])}"`);
    const frMove = String(fr['box.sheet.move']);
    expect(frHint, 'fr quotes its own Move row inside guillemets').toContain(
      `${QF8_LEFT_GUILLEMET}${NO_BREAK_SPACE}${frMove}${NO_BREAK_SPACE}${QF8_RIGHT_GUILLEMET}`,
    );
    expect(frHint.includes('"Move"'), 'fr never quotes the English label').toBe(false);
    for (const retired of ['To Party', 'To Box']) {
      expect(enHint.includes(retired), `en names no retired "${retired}" button`).toBe(false);
    }
    expect(frHint, 'a translation, not the English copy').not.toBe(enHint);
  });

  it('no English or French catalog value still names a retired mouse-only control: none carries To Party, To Box, Confirm Trade, Cancel Challenge, Evolve into or the pick-one prompt, nor their French copies, every parameterised value evaluated with both sample sets [QF8-1-CATALOG-NO-RETIRED-COPY]', () => {
    // WRONG IMPL KILLED (measured, red-team M13): copy that advertises a deleted control from a
    // KEPT id, which the retired-id checks above never see: the French `pvp.outgoing.label` closure
    // pointing the player at a Cancel Challenge button below it (FR_NEEDLES[3]), the French
    // `evolution.hint` telling the player to pick one by clicking an Evolve into button
    // (FR_NEEDLES[4], FR_NEEDLES[5]); the same words spelled with a zero-width space, a no-break
    // space or a straight apostrophe; and a closure that says it only for some params (both sample
    // sets are evaluated). `evolution.hint` itself keeps "you choose which one to take" and its
    // French twin (plan section 1.5: not reworded): neither is a needle, so no exemption exists.
    const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((code) =>
      String.fromCodePoint(code),
    );
    const APOSTROPHE = "'";
    /** As a player reads it: NFKC, zero-width characters dropped, a curly apostrophe (U+2019) read
     *  as the straight one, every run of whitespace (U+00A0 included) one space. Case is kept:
     *  "Moved to party" (box.feedback.movedToParty) is live copy, not the retired "To Party". */
    const normalise = (text: string): string => {
      let folded = text.normalize('NFKC');
      for (const hidden of ZERO_WIDTH) folded = folded.split(hidden).join('');
      folded = folded.split(RIGHT_QUOTE).join(APOSTROPHE);
      // Whitespace collapsed by a character loop (this file's helpers use no RegExp): `trim()`
      // reads U+00A0 and every other Unicode space as whitespace.
      let out = '';
      let gap = false;
      for (const ch of folded) {
        if (ch.trim() === '') {
          gap = out !== '';
          continue;
        }
        if (gap) out += ' ';
        gap = false;
        out += ch;
      }
      return out;
    };
    const EN_NEEDLES = [
      'To Party',
      'To Box',
      'Confirm Trade',
      'Cancel Challenge',
      'Evolve into',
      'pick one:',
    ];
    const FR_NEEDLES = [
      `Vers l${RIGHT_QUOTE}${E_ACUTE}quipe`,
      `Vers la bo${QF8_I_CIRCUMFLEX}te`,
      `Confirmer l${RIGHT_QUOTE}${E_ACUTE}change`,
      `Annuler le d${E_ACUTE}fi`,
      `Faire ${E_ACUTE}voluer en`,
      'choisissez-en une',
    ];
    /** Every text `catalog` resolves to: a plain value, or a closure's output for BOTH sample sets
     *  (a parameterised key with no sample set fails loudly). Returns the hits and the count. */
    const scan = (
      locale: string,
      catalog: Record<string, unknown>,
      needles: readonly string[],
    ): { readonly hits: string[]; readonly texts: number } => {
      const hits: string[] = [];
      let texts = 0;
      for (const [key, value] of Object.entries(catalog)) {
        let resolved: string[];
        if (typeof value === 'function') {
          const samples = SAMPLE_PARAMS[key];
          if (samples === undefined) {
            throw new Error(`${locale} ${key} is parameterised and has no SAMPLE_PARAMS entry`);
          }
          const fn = value as (p: Record<string, unknown>) => string;
          resolved = samples.map((sample) => fn(sample));
        } else {
          resolved = [String(value)];
        }
        for (const text of resolved) {
          texts += 1;
          const flat = normalise(text);
          for (const needle of needles) {
            if (flat.includes(normalise(needle))) {
              hits.push(`${locale} ${key}: ${JSON.stringify(text)} names "${needle}"`);
            }
          }
        }
      }
      return { hits, texts };
    };

    const en = scan('en', CATALOG_EN as Record<string, unknown>, EN_NEEDLES);
    const fr = scan('fr', CATALOG_FR as Record<string, unknown>, FR_NEEDLES);
    expect([...en.hits, ...fr.hits], 'no value names a retired control').toEqual([]);
    // ANTI-VACUITY: every value was read, each closure twice (the full roster is pinned above).
    // uif-14 (named intentional change, UIF14.1/UIF14.4): + the 36 plain Help ids, which are plain values not in EXPECTED_PLAIN.
    // uif-14b (named intentional change, UIF14B.1): + the plain `help.intro.report` id (653 -> 654
    // values read; help.intro.report is read once, a plain value not in EXPECTED_PLAIN).
    // uif-16b (named intentional change): 654 -> 649 values read: the five retired plain ids leave
    // EXPECTED_PLAIN (the four menu.profile.* sub-list ids and chrome.status.privacyOverlayBusy).
    const expectedTexts =
      Object.keys(EXPECTED_PLAIN).length +
      UIF14_PLAIN_IDS.length +
      UIF14B_PLAIN_IDS.length +
      // ts-6b-8 (named intentional change, R-uif-10-TITLES): + the plain `heal.title` id.
      TS6B8_PLAIN_IDS.length +
      // ts-6b-9 (named intentional change, R-weekly-review-2026-10-02-F4): 657 -> 674, + the 17
      // plain `a11y.*` values now in both catalogs.
      TS6B9_A11Y_IDS.length +
      2 * Object.keys(SAMPLE_PARAMS).length;
    expect(en.texts, 'every English value was read').toBe(expectedTexts);
    expect(fr.texts, 'every French value was read').toBe(expectedTexts);
  });
});

// =============================================================================
// qf-10 (QF10.4, QF10.5): the frame is named Monsters, its Box panel Storage, the raising screen
// Inventory and the battle Bag command Items, in BOTH catalogs. VALUES only: every legacy id keeps
// its name (the spec's values-only rule; messageIds.ts is untouched). Every expected byte is typed
// here (the French glyphs by code point); none is read off the catalog under test.
// =============================================================================

// bt-17 (named intentional change, BT17.1): two of qf-10's seven revalued keys —
// `battle.swap.hint` (the 1v1 bench hint) and `battle.command.bag` (the 1v1 Items command) — are
// DELETED with ui/battleView.ts, so the tables below hold the five that remain (were seven) and the
// naming set four (was five; the "À la fin du combat" capital A-grave leaves with the swap hint).

/** The five keys qf-10 revalued that remain (bt-17), with their exact English text. */
const QF10_EN: Record<string, string> = {
  'box.title': 'Monsters',
  'box.hint':
    'Only monsters in your Party can battle or be swapped in. New recruits arrive in Storage ' +
    `${EM_DASH} select one there and choose "Move" to bring it into an open party slot.`,
  // uif-6 (named intentional change, UIF6.5): `box.section.box` is RETIRED with the Storage h3, so
  // this table holds four keys (was five).
  'box.box.empty': 'No monsters in storage.',
  'raising.title': 'Inventory',
};

/** The five keys qf-10 revalued that remain (bt-17), with their exact French text. The apostrophe is
 *  U+2019 and the quote is a guillemet pair with U+00A0 inside, as catalog.fr.ts documents; the dash
 *  is U+2014. */
const QF10_FR: Record<string, string> = {
  'box.title': 'Monstres',
  'box.hint':
    `Seuls les monstres de votre ${E_ACUTE}quipe peuvent combattre ou ${QF8_E_CIRCUMFLEX}tre ` +
    `${E_ACUTE}chang${E_ACUTE}s en cours de combat. Les nouvelles recrues arrivent dans le ` +
    `Stockage ${EM_DASH} s${E_ACUTE}lectionnez-en une et choisissez ` +
    `${QF8_LEFT_GUILLEMET}${NO_BREAK_SPACE}D${E_ACUTE}placer${NO_BREAK_SPACE}${QF8_RIGHT_GUILLEMET} ` +
    `pour la placer dans un emplacement libre de l${RIGHT_QUOTE}${E_ACUTE}quipe.`,
  // uif-6 (named intentional change, UIF6.5): `box.section.box` is RETIRED (four keys, was five).
  'box.box.empty': 'Aucun monstre dans le stockage.',
  'raising.title': 'Inventaire',
};

/** The five values that named the Box / Raising screens (bt-17: `battle.swap.hint` deleted). */
const QF10_NAMING_KEYS = ['box.title', 'box.hint', 'box.box.empty', 'raising.title'] as const;

/** True iff `word` occurs in `text` bounded on both sides by a non-letter, non-digit (or an edge):
 *  a hand-rolled scan (this file's helpers use no RegExp). A letter is ASCII or any code point
 *  above U+007F that is not whitespace, so an accented letter never splits a word. */
function hasWholeWord(text: string, word: string): boolean {
  const isWordChar = (ch: string | undefined): boolean => {
    if (ch === undefined) return false;
    const c = ch.charCodeAt(0);
    if (c > 0x7f) return ch.trim() !== '';
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  };
  let from = 0;
  for (;;) {
    const at = text.indexOf(word, from);
    if (at === -1) return false;
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + word.length])) return true;
    from = at + 1;
  }
}

describe('qf-10: the Monsters / Storage / Inventory / Items wording in both catalogs', () => {
  it('the English catalog carries the five remaining qf-10 values exactly (bt-17: the two 1v1 battle values deleted) and the legacy Party & Box, Raising & Inventory and Box wording is gone from the naming values [QF10-4-EN-VALUES]', () => {
    // WRONG IMPL KILLED: a value left on the shipped 'Party & Box' / 'Raising & Inventory' /
    // 'Box' / 'No monsters in box.' / 'Bag'; the hint still saying 'arrive in your Box'; the swap
    // hint still pointing at 'Party & Box'; a reworded value (every byte is pinned); and a value
    // that keeps the legacy word in a new sentence (the absence scan reads whole words, so
    // 'Boxes' is not a false hit but 'a Box' is).
    const en = CATALOG_EN as Record<string, unknown>;
    for (const [key, expected] of Object.entries(QF10_EN)) {
      expect(en[key], `en ${key}: the exact qf-10 text`).toBe(expected);
    }
    expect(Object.keys(QF10_EN), 'ANTI-VACUITY: four keys (uif-6: was five)').toHaveLength(4);
    for (const key of QF10_NAMING_KEYS) {
      const value = String(en[key]);
      expect(value.includes('Party & Box'), `en ${key} no longer says "Party & Box"`).toBe(false);
      expect(
        value.includes('Raising & Inventory'),
        `en ${key} no longer says "Raising & Inventory"`,
      ).toBe(false);
      expect(hasWholeWord(value, 'Box'), `en ${key} has no whole word "Box"`).toBe(false);
      expect(hasWholeWord(value, 'box'), `en ${key} has no whole word "box"`).toBe(false);
    }
    // Control: the scan does see a whole word, and does not see one inside another word.
    expect(hasWholeWord('arrive in your Box.', 'Box'), 'control: a whole word is found').toBe(true);
    expect(hasWholeWord('Boxes and sandbox', 'Box'), 'control: a substring is not').toBe(false);
  });

  it('the French catalog carries the five remaining qf-10 values exactly (bt-17: the two 1v1 battle values deleted) and the legacy Equipe et boite, boite, Elevage and Sac wording is gone from the naming values [QF10-4-FR-VALUES]', () => {
    // WRONG IMPL KILLED: a French value left on 'Équipe et boîte' / 'Boîte' / 'Élevage' / 'Sac'
    // while the English moved (a French boot keeps the old names); the hint still saying
    // 'votre Boîte'; a reworded value or a lost accent / U+2019 / U+00A0 (every byte is pinned); a
    // plain apostrophe or a plain space inside the guillemets.
    const fr = CATALOG_FR as Record<string, unknown>;
    const BOITE = `bo${QF8_I_CIRCUMFLEX}te`;
    const BOITE_CAP = `Bo${QF8_I_CIRCUMFLEX}te`;
    const EQUIPE_ET_BOITE = `${CAPITAL_E_ACUTE}quipe et ${BOITE}`;
    const ELEVAGE = `${CAPITAL_E_ACUTE}levage`;
    for (const [key, expected] of Object.entries(QF10_FR)) {
      expect(fr[key], `fr ${key}: the exact qf-10 text`).toBe(expected);
    }
    expect(Object.keys(QF10_FR), 'ANTI-VACUITY: four keys (uif-6: was five)').toHaveLength(4);
    for (const key of QF10_NAMING_KEYS) {
      const value = String(fr[key]);
      expect(value.includes(EQUIPE_ET_BOITE), `fr ${key} no longer says "${EQUIPE_ET_BOITE}"`).toBe(
        false,
      );
      expect(value.includes(BOITE), `fr ${key} has no "${BOITE}"`).toBe(false);
      expect(value.includes(BOITE_CAP), `fr ${key} has no "${BOITE_CAP}"`).toBe(false);
      expect(value.includes(ELEVAGE), `fr ${key} has no "${ELEVAGE}"`).toBe(false);
      expect(hasWholeWord(value, 'Sac'), `fr ${key} has no whole word "Sac"`).toBe(false);
    }
    // bt-17 (named intentional change): the "the bag command is French too" pin is deleted with
    // `battle.command.bag` (subject deleted: the 1v1 Items command).
    // Every guillemet in the hint is padded by U+00A0, never a breaking space.
    const hint = String(fr['box.hint']);
    expect(hint.includes(`${QF8_LEFT_GUILLEMET} `), 'no breaking space after the opening «').toBe(
      false,
    );
    expect(hint.includes(` ${QF8_RIGHT_GUILLEMET}`), 'no breaking space before the closing »').toBe(
      false,
    );
  });

  it('the legacy ids keep their names in both catalogs and the roster is still the pinned one, 527 keys (ts-4, named intentional change: 536 → 527, -9 trade.side.* / trade.feedback.* / social.action.confirm / social.confirm.{declineTrade,confirmTrade}; bt-12 increment B, named intentional change, BT12.2/BT12.6: 504 → 511, +2 tactics.* (tactics.deploy.wilds, tactics.clock.stillThere), +5 chrome.chip.* (deploy, editFormation, assign, prevMonster, nextMonster); bt-12, named intentional change, BT12.2/BT12.4/BT12.6: 486 → 504; bt-11, named intentional change, BT11.1/BT11.6 then BT11.3/BT11.4/BT11.5: 425 → 486; bt-10: 365 → 425, +tactics.*) [QF10-4-KEY-IDS-UNCHANGED]', () => {
    // WRONG IMPL KILLED: an id renamed to follow its new value (box.title -> monsters.title, ...)
    // so messageIds.ts and every t() call site would have to move too (the spec allows values
    // only); a retired legacy id (the Party heading, the Bag command); a roster that grew or
    // shrank (an id added beside the old one instead of revalued).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    // bt-17 (named intentional change, BT17.1): `battle.swap.hint` and `battle.command.bag` leave this
    // list — they are not renamed, they are DELETED with the 1v1 view (the roster census below and
    // CAT-01's `battle.*` census pin their absence).
    const LEGACY_IDS = ['box.title', 'box.hint', 'box.box.empty', 'raising.title'] as const;
    // uif-6 (named intentional change, UIF6.5): `box.section.party` and `box.section.box` leave this
    // list, they are RETIRED with the two h3 headings (the uif-6 describe pins their absence).
    expect(LEGACY_IDS, 'ANTI-VACUITY: four ids (uif-6: was six)').toHaveLength(4);
    for (const id of LEGACY_IDS) {
      expect(Object.hasOwn(en, id), `en keeps ${id}`).toBe(true);
      expect(Object.hasOwn(fr, id), `fr keeps ${id}`).toBe(true);
      expect(EXPECTED_KEYS.includes(id), `the pinned roster keeps ${id}`).toBe(true);
    }
    // qf-14 (named intentional change, QF14.1): 361 → 362, +`controls.accel.controls`.
    // qf-15 (named intentional change, QF15.1): 362 → 363, +`chrome.status.zoneEntered`.
    // qf-17 (named intentional change, QF17.1/QF17.2): 363 → 365, +battle.rewards.gold,
    // +battle.rewards.xp.
    // bt-10 (named intentional change, BT10.5/BT10.6): 365 → 425, +tactics.*
    // bt-11 (named intentional change, BT11.1/BT11.6): +28 tactics.*, +7 chrome.chip.*; increment C
    // (BT11.3/BT11.4/BT11.5): +26 tactics.* = 486.
    // bt-12 increment A (named intentional change, BT12.2/BT12.4/BT12.6): +18 tactics.* = 504.
    // bt-12 increment B (named intentional change, BT12.2/BT12.6): +2 tactics.*
    // (tactics.deploy.wilds, tactics.clock.stillThere), +5 chrome.chip.* (deploy, editFormation,
    // assign, prevMonster, nextMonster) = 511.
    // NAMED INTENTIONAL CHANGE (bt-12 B, plan §2.9): 504 → 511.
    // NAMED INTENTIONAL CHANGE (bt-15 A, BT15.1): 511 → 512, +interact.challenge.size.
    // NAMED INTENTIONAL CHANGE (bt-15 B, BT15.2/BT15.3/BT15.5): 512 → 525, +13 tactics.*.
    // NAMED INTENTIONAL CHANGE (bt-17, BT17.1): 525 → 494, -31 1v1 battle.*.
    // NAMED INTENTIONAL CHANGE (uif-7, UIF7.2): 494 → 496, +kit.sheet.close, +kit.sheet.back.
    // uif-8 (named intentional change, UIF8.4): 496 -> 498, +bag.empty.cue, +bag.empty.next
    // uif-12 (named intentional change, UIF12.3): 498 -> 499, +interact.chip.choose.
    // uif-13 (named intentional change, UIF13.2): 499 -> 506, +4 plain, +3 parameterised.
    // uif-14 (named intentional change, UIF14.1/UIF14.4): 506 -> 536, -7 retired help.*, +36 plain, +1 parameterised.
    // uif-15b (named intentional change, UIF15B.1): 536 -> 530, -6 retired menu.social.* sub-list ids.
    // uif-14b (named intentional change, UIF14B.1): 530 -> 531, +1 plain help.intro.report.
    // uif-16b (named intentional change): 531 -> 526: -4 menu.profile.* sub-list ids, -chrome.status.privacyOverlayBusy.
    // uif-15c (named intentional change, UIF15C.5): 526 -> 524, -2 `menu.options.{title,desc}` (the
    // `menu.options.{help,controls}.*` pairs are re-homed as `menu.{help,controls}.*`, a net zero).
    // ts-3: 524 -> 536 (-13 wizard, +25 session keys).
    // ts-4 (named intentional change): 536 -> 527, -9 trade.side.* / trade.feedback.* /
    // social.action.confirm / social.confirm.{declineTrade,confirmTrade}.
    // ts-6b-8 (named intentional change, R-uif-10-TITLES): 527 -> 528, +heal.title.
    // ts-6b-9 (named intentional change): 528 -> 545, +17 `a11y.*` keys.
    // ts-6b-10 (named intentional change): -social.players.placeholder +tradeSession.prompt.confirmMonsters, 545 unchanged
    // ts-6b-11 (named intentional change): -claim.privacyButton -raising.inventory.heading
    // +privacy.disclosure, 545 -> 544.
    expect(Object.keys(en).length, 'the English catalog holds exactly 544 keys').toBe(544);
    expect(Object.keys(fr).length, 'and so does the French one').toBe(544);
    expect(EXPECTED_KEYS, 'and the pinned roster').toHaveLength(544);
    expect(Object.keys(en).slice().sort(), 'en and the pinned roster are the same ids').toEqual(
      EXPECTED_KEYS,
    );
    // uif-6 (named intentional change, UIF6.5): the Party heading id is RETIRED, not kept untouched
    // (was: `en['box.section.party']` reads 'Party'); the tab label `box.tab.party` is the name.
    expect(en['box.tab.party'], 'en box.tab.party names the Party tab').toBe('Party');
  });
});

// =============================================================================
// uif-6 (UIF6.5, UIF6.6): the empty Storage's EmptyState lines and the retired section headings.
// =============================================================================

describe('uif-6: the empty Storage copy and the retired headings, in both catalogs', () => {
  const en = CATALOG_EN as Record<string, unknown>;
  const fr = CATALOG_FR as Record<string, unknown>;
  const NEW_KEYS = ['box.storage.emptyCue', 'box.storage.emptyNext'] as const;

  it('UIF6.6 box.storage.emptyCue and box.storage.emptyNext exist in en and fr as plain non-empty strings, French different from English, each different from the reason line and from each other', () => {
    // WRONG IMPL KILLED: a key added to en only (the French boot throws or shows the key: both
    // catalogs must carry it); a closure value (the view reads it with t(), which a parameterised
    // entry cannot serve); an empty string (the EmptyState would render an empty cue line); a
    // French text left as the English copy (an untranslated line in a French boot); one text reused
    // for the cue and the next step, or either reused as the reason line (three lines that read the
    // same tell the player nothing new).
    for (const [locale, catalog] of [
      ['en', en],
      ['fr', fr],
    ] as const) {
      const texts = [...NEW_KEYS, 'box.box.empty'].map((key) => catalog[key]);
      for (const [i, value] of texts.entries()) {
        expect(
          typeof value,
          `${locale} ${[...NEW_KEYS, 'box.box.empty'][i]} is a plain string`,
        ).toBe('string');
        expect(String(value).trim().length, `${locale}: not empty`).toBeGreaterThan(0);
      }
      expect(new Set(texts).size, `${locale}: three different lines`).toBe(3);
    }
    for (const key of NEW_KEYS) {
      expect(fr[key], `fr ${key} is a translation, not the English copy`).not.toBe(en[key]);
    }
  });

  it('UIF6.5 box.section.party and box.section.box are in neither catalog: the in-panel headings are retired with their ids', () => {
    // WRONG IMPL KILLED: headings deleted from the view but their ids left in the catalogs
    // (catalogParity DEAD-KEY, and the retired copy lingers); a key removed from en only (the
    // French catalog keeps a key the typed table no longer has); the tab labels `box.tab.*`
    // removed along with them (the control: they stay).
    for (const [locale, catalog] of [
      ['en', en],
      ['fr', fr],
    ] as const) {
      for (const key of ['box.section.party', 'box.section.box']) {
        expect(Object.hasOwn(catalog, key), `${locale} no longer has ${key}`).toBe(false);
      }
      expect(Object.hasOwn(catalog, 'box.tab.party'), `${locale} keeps box.tab.party`).toBe(true);
      expect(Object.hasOwn(catalog, 'box.tab.storage'), `${locale} keeps box.tab.storage`).toBe(
        true,
      );
    }
  });
});

// =============================================================================
// qf-14 (QF14.2): the label of the Controls accelerator Y, in BOTH catalogs. Every expected byte is
// typed here; none is read off the catalog under test.
// =============================================================================

describe('qf-14: the Controls accelerator label in both catalogs', () => {
  it('controls.accel.controls is the plain string Controls in English and Commandes in French, a new id beside the other accelerator labels, with the Controls view`s title and the menu leaf unchanged [QF14-2-CATALOG-LABEL]', () => {
    // WRONG IMPL KILLED: a key added to en only (rowLabel throws in a French boot: the Controls
    // screen's Shortcuts tab and the generated Help go blank); a French label left as the English
    // copy; a label that is a closure (rowLabel reads it with t()); the label missing from the
    // pinned roster; a new id that reuses an existing accelerator label's wording (two rows a
    // player cannot tell apart); and the existing Controls wordings (the frame title and the
    // Options leaf) edited on the way.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const KEY = 'controls.accel.controls';
    expect(en[KEY], 'the English label').toBe('Controls');
    expect(fr[KEY], 'the French label').toBe('Commandes');
    expect(fr[KEY], 'a translation, not the English copy').not.toBe(en[KEY]);
    expect(EXPECTED_PLAIN[KEY], 'the pinned roster lists it as a plain key').toBe('Controls');
    expect(EXPECTED_KEYS.includes(KEY), 'and in the roster').toBe(true);
    // The siblings keep their own distinct labels.
    const SIBLINGS = [
      'controls.accel.storage',
      'controls.accel.bag',
      'controls.accel.party',
      'controls.accel.journal',
      'controls.accel.trades',
      'controls.accel.challenges',
      'controls.accel.rankings',
      'controls.accel.name',
      'controls.accel.account',
      'controls.accel.bugReport',
      'controls.accel.dismissError',
    ] as const;
    for (const sibling of SIBLINGS) {
      expect(en[sibling], `en ${sibling} differs from the Controls label`).not.toBe(en[KEY]);
      expect(fr[sibling], `fr ${sibling} differs from the Controls label`).not.toBe(fr[KEY]);
    }
    expect(SIBLINGS, 'ANTI-VACUITY: the eleven other accelerator labels').toHaveLength(11);
    // The frame title and the Options leaf already read Controls / Commandes and stay so.
    expect(en['controls.title']).toBe('Controls');
    expect(fr['controls.title']).toBe('Commandes');
    // uif-15c (named intentional change, UIF15C.5): the menu row's ids are re-homed. Was:
    // 'menu.options.controls.title'.
    expect(en['menu.controls.title']).toBe('Controls');
    expect(fr['menu.controls.title']).toBe('Commandes');
  });
});

// =============================================================================
// qf-15 (QF15.1): the zone cue's announcement template in BOTH catalogs. The zone's own name is
// content data (a zone_def row), carried verbatim by the closure and never catalogued; only the
// sentence around it is. Every expected byte is typed here, and the names are NON-shipped; none is
// read off the catalog under test.
// =============================================================================

describe('qf-15: the zone cue template in both catalogs', () => {
  it('chrome.status.zoneEntered is a closure in both catalogs: Entering X in English and Vous entrez dans X in French, the zone name echoed once and verbatim, for differing names [QF15-1-CATALOG-KEY]', () => {
    // WRONG IMPL KILLED: a key added to en only (tf() throws in a French boot: the cue never
    // shows); a plain string where the name must be interpolated; a French line left as the
    // English copy; a closure that hard-codes a zone name, or drops, repeats or swaps the param
    // (the three names differ); a name run through a transform (case, trim, escaping); and the key
    // missing from the pinned roster or the two sample tables.
    const KEY = 'chrome.status.zoneEntered';
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    expect(Object.hasOwn(en, KEY), 'en carries the key').toBe(true);
    expect(Object.hasOwn(fr, KEY), 'fr carries the key').toBe(true);
    expect(typeof en[KEY], 'en is a closure').toBe('function');
    expect(typeof fr[KEY], 'fr is a closure').toBe('function');
    const enFn = en[KEY] as (p: { name: string }) => string;
    const frFn = fr[KEY] as (p: { name: string }) => string;

    type Case = readonly [{ name: string }, string, string];
    const COBALT: Case = [
      { name: 'Cobalt Reach' },
      'Entering Cobalt Reach',
      'Vous entrez dans Cobalt Reach',
    ];
    const UMBER: Case = [{ name: 'Umber Fen' }, 'Entering Umber Fen', 'Vous entrez dans Umber Fen'];
    const ASH: Case = [
      { name: 'Ash Hollow' },
      'Entering Ash Hollow',
      'Vous entrez dans Ash Hollow',
    ];
    const CASES: readonly Case[] = [COBALT, UMBER, ASH];
    for (const [params, enLine, frLine] of CASES) {
      expect(enFn(params), `en, ${params.name}`).toBe(enLine);
      expect(frFn(params), `fr, ${params.name}`).toBe(frLine);
      expect(frFn(params), `${params.name}: a translation, not the English line`).not.toBe(
        enFn(params),
      );
      expect(enFn(params).split(params.name).length - 1, `en carries ${params.name} once`).toBe(1);
      expect(frFn(params).split(params.name).length - 1, `fr carries ${params.name} once`).toBe(1);
    }
    expect(CASES, 'ANTI-VACUITY: three names').toHaveLength(3);
    expect(enFn(COBALT[0]), 'the names change the line (en)').not.toBe(enFn(UMBER[0]));
    expect(frFn(COBALT[0]), 'the names change the line (fr)').not.toBe(frFn(UMBER[0]));

    // The key is in the pinned roster and in both sample tables (the two sample sets are Cobalt
    // Reach and Umber Fen), so CAT-01's bijection and exact-output checks cover it.
    expect(EXPECTED_KEYS.includes(KEY), 'the pinned roster lists the key').toBe(true);
    expect(SAMPLE_PARAMS[KEY], 'the two sample sets').toEqual([COBALT[0], UMBER[0]]);
    const spec = EXPECTED_PARAM_OUTPUTS[KEY] as ParamOutputSpec;
    expect(spec, 'the English output pins exist').toBeDefined();
    expect(spec.outputA).toBe(COBALT[1]);
    expect(spec.outputB).toBe(UMBER[1]);
  });
});

// =============================================================================
// qf-17's catalog pins (QF17-1-CATALOG-GOLD, QF17-2-CATALOG-XP: the 1v1 KO-win payout lines
// `battle.rewards.{gold,xp}` in both catalogs) are DELETED by bt-17 (named intentional change,
// BT17.1) with the keys. Survivors: tactics/results.test.ts BT12-6-RESULTS-TEXT-FROM-CATALOG and the
// `tactics.results.{monster,currency}` rows of CAT-01 above (the tactical results panel's XP and
// gold lines, bigint digit-for-digit).
// =============================================================================

// =============================================================================
// bt-15 increment A (BT15.1, BT15.5): the Challenge pick's size row in BOTH catalogs, read through
// the resolver main.ts uses (`tf('interact.challenge.size', { n })`). Every expected byte is typed
// here from the API freeze (en "{n} vs {n}", fr "{n} contre {n}"); none is read off the catalog.
// RED REASON: the key does not exist yet — `tf` throws "no entry for key" in both locales.
// =============================================================================

describe('bt-15: the Challenge pick`s size row in both catalogs', () => {
  it('tf(`interact.challenge.size`, { n }) renders "n vs n" in English and "n contre n" in French, the number printed twice, the two locales differing, for differing n [BT15-5]', () => {
    // WRONG IMPL KILLED: a key added to en only (tf() throws in a French boot: the pick shows no
    // rows); a French value left as the English copy; a plain string where the size must be
    // interpolated (every row reads the same, so "1 vs 1" and "3 vs 3" cannot be told apart); a
    // closure that prints n once ("vs 2"), hard-codes a size, or reads a different param name; and
    // a row text that is the legacy Yes (`prompt.yes`).
    try {
      const rows: (readonly [number, string, string])[] = [
        [2, '2 vs 2', '2 contre 2'],
        [3, '3 vs 3', '3 contre 3'],
        [1, '1 vs 1', '1 contre 1'],
      ];
      for (const [n, enLine, frLine] of rows) {
        setLocale('en');
        const en = tf('interact.challenge.size', { n });
        setLocale('fr');
        const fr = tf('interact.challenge.size', { n });
        expect(en, `en, n = ${n}`).toBe(enLine);
        expect(fr, `fr, n = ${n}`).toBe(frLine);
        expect(fr, `n = ${n}: a translation, not the English row`).not.toBe(en);
        expect(en.split(String(n)).length - 1, `en prints ${n} twice`).toBe(2);
        expect(fr.split(String(n)).length - 1, `fr prints ${n} twice`).toBe(2);
      }
      setLocale('en');
      expect(tf('interact.challenge.size', { n: 2 }), 'the sizes change the row').not.toBe(
        tf('interact.challenge.size', { n: 3 }),
      );
      expect(
        tf('interact.challenge.size', { n: 1 }),
        'a size row is never the legacy Yes',
      ).not.toBe((CATALOG_EN as Record<string, unknown>)['prompt.yes']);
      expect(EXPECTED_KEYS.includes('interact.challenge.size'), 'the pinned roster lists it').toBe(
        true,
      );
    } finally {
      setLocale('en');
    }
  });
});

// =============================================================================
// bt-15 increment B (BT15.2, BT15.3, BT15.5): the 13 clock / forfeit / results keys in BOTH catalogs.
// The English text is pinned above (EXPECTED_PLAIN / EXPECTED_PARAM_OUTPUTS); here every French byte
// is typed from the API freeze (accents and the U+00A0 before the strikes colon by code point), each
// closure fed the English sample sets. None is read off the catalog under test.
// RED REASON: the 13 keys exist in neither catalog.
// =============================================================================

describe('bt-15 B: the clock, forfeit and results keys in both catalogs', () => {
  it('the 9 plain keys and the 4 closures carry their exact French text, each a translation of its English, the strikes colon set off by a U+00A0, the rating keeping the arrow and the signed delta [BT15-5]', () => {
    // WRONG IMPL KILLED: a key added to en only (t() / tf() throws in a French boot: the confirm
    // row, the strip or the results line goes blank); a French entry left as the English copy or
    // swapped with a sibling (Oui / Continuer, two reasons); a decomposed or missing accent; a
    // breaking space (or none) before the French strikes colon; a closure that drops, repeats or
    // re-signs a param (the delta is the caller's string); the English closures not pinned (CAT-01
    // above pins them; this case re-reads two of them so a mis-keyed sample shows here too).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const FR_PLAIN: Record<string, string> = {
      'tactics.players.label': 'Joueurs',
      'tactics.menu.forfeit': 'Abandonner',
      'tactics.menu.forfeitYes': 'Oui, abandonner le match',
      'tactics.menu.forfeitNo': 'Continuer le combat',
      'tactics.results.endHow.adjudicatedHpPercent': `D${E_ACUTE}cid${E_ACUTE} aux PV restants`,
      'tactics.results.endHow.adjudicatedConscious': `D${E_ACUTE}cid${E_ACUTE} aux monstres conscients`,
      'tactics.results.endHow.adjudicatedDamageDealt': `D${E_ACUTE}cid${E_ACUTE} aux d${E_ACUTE}g${A_CIRCUMFLEX}ts inflig${E_ACUTE}s`,
      'tactics.results.endHow.adjudicatedCoin': `D${E_ACUTE}cid${E_ACUTE} ${A_GRAVE} pile ou face`,
      'tactics.results.endHow.forfeit': `Termin${E_ACUTE} par abandon`,
    };
    const FR_PARAMS: Record<string, readonly [string, string]> = {
      'tactics.clock.ring': ['29 s restantes', '4 s restantes'],
      'tactics.clock.strikes': [
        `Marrow${NO_BREAK_SPACE}: 3 prises sur 4`,
        `Quill${NO_BREAK_SPACE}: 0 prises sur 5`,
      ],
      'tactics.results.rating': [
        `Classement 1000 ${BT15_ARROW} 984 (-16)`,
        `Classement 1493 ${BT15_ARROW} 1509 (+16)`,
      ],
      'tactics.results.ratingNew': ['Classement 1016', 'Classement 987'],
    };
    for (const [key, expected] of Object.entries(FR_PLAIN)) {
      expect(typeof EXPECTED_PLAIN[key], `fixture: ${key} has an English pin`).toBe('string');
      expect(en[key], `en ${key}: its exact text`).toBe(EXPECTED_PLAIN[key]);
      expect(typeof fr[key], `${key} must be a plain string in the fr catalog`).toBe('string');
      expect(fr[key], `fr ${key}: the exact French text`).toBe(expected);
      expect(fr[key], `${key}: a translation, not the English copy`).not.toBe(en[key]);
    }
    for (const [key, [frA, frB]] of Object.entries(FR_PARAMS)) {
      const spec = EXPECTED_PARAM_OUTPUTS[key] as ParamOutputSpec;
      expect(spec, `fixture: ${key} has English output pins`).toBeDefined();
      expect(typeof en[key], `en ${key} must be a closure`).toBe('function');
      expect(typeof fr[key], `fr ${key} must be a closure`).toBe('function');
      const enFn = en[key] as (p: Record<string, unknown>) => string;
      const frFn = fr[key] as (p: Record<string, unknown>) => string;
      expect(enFn(spec.inputA), `en ${key}(sample A)`).toBe(spec.outputA);
      expect(enFn(spec.inputB), `en ${key}(sample B)`).toBe(spec.outputB);
      expect(frFn(spec.inputA), `fr ${key}(sample A)`).toBe(frA);
      expect(frFn(spec.inputB), `fr ${key}(sample B)`).toBe(frB);
      expect(frA, `${key}: a translation, not the English line`).not.toBe(spec.outputA);
      expect(frA, `${key}: the two sample sets differ`).not.toBe(frB);
    }
    expect(
      Object.keys(FR_PLAIN).length + Object.keys(FR_PARAMS).length,
      'ANTI-VACUITY: all 13 bt-15 B keys are pinned in both catalogs',
    ).toBe(13);
    for (const key of [...Object.keys(FR_PLAIN), ...Object.keys(FR_PARAMS)]) {
      expect(EXPECTED_KEYS.includes(key), `the pinned roster lists ${key}`).toBe(true);
    }
  });
});

// =============================================================================
// uif-7 (UIF7.2): the context sheet's two closing rows, in BOTH catalogs. Every expected byte is
// typed here; none is read off the catalog under test. The French wording is the kit's: Close is
// "Fermer" and Back is "Retour".
// =============================================================================

describe('uif-7: the sheet Close and Back rows in both catalogs', () => {
  it('UIF7.2 kit.sheet.close reads Close / Fermer and kit.sheet.back reads Back / Retour, plain non-empty strings, French different from English, the two different from each other, and both in the pinned roster', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot: the sheet's last row
    // goes blank); a French value left as the English copy; one text reused for both rows (the
    // player could not tell Close from Back); a closure where the view calls t(); a key missing
    // from the pinned roster; the existing `chrome.chip.close` / `chrome.chip.back` (hint-bar
    // verbs) edited on the way instead of new ids added.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const EXPECTED: ReadonlyArray<readonly [string, string, string]> = [
      ['kit.sheet.close', 'Close', 'Fermer'],
      ['kit.sheet.back', 'Back', 'Retour'],
    ];
    for (const [key, enText, frText] of EXPECTED) {
      expect(en[key], `en ${key}`).toBe(enText);
      expect(fr[key], `fr ${key}`).toBe(frText);
      expect(fr[key], `${key}: a translation, not the English copy`).not.toBe(en[key]);
      expect(EXPECTED_PLAIN[key], `the pinned roster lists ${key} as a plain key`).toBe(enText);
      expect(EXPECTED_KEYS.includes(key), `${key} is in the roster`).toBe(true);
    }
    expect(EXPECTED, 'ANTI-VACUITY: two keys').toHaveLength(2);
    expect(en['kit.sheet.close'], 'Close and Back differ (en)').not.toBe(en['kit.sheet.back']);
    expect(fr['kit.sheet.close'], 'Close and Back differ (fr)').not.toBe(fr['kit.sheet.back']);
    // The hint-bar verbs keep their own ids and text.
    expect(en['chrome.chip.close']).toBe('Close');
    expect(en['chrome.chip.back']).toBe('Back');
  });
});

// =============================================================================
// uif-12 (UIF12.3): the hint bar's Choose verb over a multi-row picker, in BOTH catalogs. Every
// expected byte is typed here. The key lives under `interact.*`, not `chrome.*` (resolver.test.ts
// pins the exact `chrome.*` plain-value snapshot).
// =============================================================================

describe('uif-12: the picker Choose verb in both catalogs', () => {
  it('UIF12.3 interact.chip.choose reads Choose / Choisir as a plain string, French different from English, different from the OK verb, and in the pinned roster', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot: the picker's A chip
    // blanks); a French value left as the English copy; a closure where the model calls t(); the
    // key missing from the pinned roster; the verb reusing `chrome.chip.ok` (A would read OK over a
    // picker); and the `interact.choose` chip closure (`[key] Choose...`) edited instead.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const KEY = 'interact.chip.choose';
    expect(en[KEY], 'en').toBe('Choose');
    expect(fr[KEY], 'fr').toBe('Choisir');
    expect(typeof en[KEY], 'en is a plain string').toBe('string');
    expect(typeof fr[KEY], 'fr is a plain string').toBe('string');
    expect(fr[KEY], 'a translation, not the English copy').not.toBe(en[KEY]);
    expect(en[KEY], 'not the OK verb').not.toBe(en['chrome.chip.ok']);
    expect(EXPECTED_PLAIN[KEY], 'the pinned roster lists it as a plain key').toBe('Choose');
    expect(EXPECTED_KEYS.includes(KEY), 'and in the roster').toBe(true);
  });
});

// =============================================================================
// uif-13 (UIF13.2): the Controls Display tab's seven ids, in BOTH catalogs. Every expected byte is
// typed here. Before a `:` the French text carries the catalog's U+00A0 or a plain space (the
// ctl-12b `spaced` precedent accepts both); every other byte is exact.
// =============================================================================

/** U+00E8 (e grave), built by code point so the expected French text holds no pasted glyph. */
const UIF13_E_GRAVE = String.fromCharCode(0x00e8);

describe('uif-13: the Controls Display tab ids in both catalogs', () => {
  const en = CATALOG_EN as Record<string, unknown>;
  const fr = CATALOG_FR as Record<string, unknown>;
  /** `before` + (U+00A0 or a plain space) + `after`. */
  const spaced = (before: string, after: string): string[] => [
    `${before}${NO_BREAK_SPACE}${after}`,
    `${before} ${after}`,
  ];

  it('UIF13.2 controls.tab.display and the three step labels read Display / Affichage, Normal / Normale, Large / Grande and Extra large / Tres grande (accented) as plain strings, French different from English, the three labels different from each other, all in the pinned roster', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot: the third tab or a row
    // goes blank); a French value left as the English copy; a closure where the view calls t(); one
    // label reused for two steps (the rows could not be told apart); the existing `controls.tab.*`
    // edited instead of a new id added; a key missing from the pinned roster; a decomposed or
    // missing grave accent in "Tres grande".
    const PLAIN: ReadonlyArray<readonly [string, string, string]> = [
      ['controls.tab.display', 'Display', 'Affichage'],
      ['controls.text.normal', 'Normal', 'Normale'],
      ['controls.text.large', 'Large', 'Grande'],
      ['controls.text.xlarge', 'Extra large', `Tr${UIF13_E_GRAVE}s grande`],
    ];
    for (const [key, enText, frText] of PLAIN) {
      expect(typeof en[key], `en ${key} is a plain string`).toBe('string');
      expect(typeof fr[key], `fr ${key} is a plain string`).toBe('string');
      expect(en[key], `en ${key}`).toBe(enText);
      expect(fr[key], `fr ${key}`).toBe(frText);
      expect(fr[key], `${key}: a translation, not the English copy`).not.toBe(en[key]);
      expect(EXPECTED_PLAIN[key], `the pinned roster lists ${key} as a plain key`).toBe(enText);
      expect(EXPECTED_KEYS.includes(key), `${key} is in the roster`).toBe(true);
    }
    expect(PLAIN, 'ANTI-VACUITY: four plain keys').toHaveLength(4);
    for (const catalog of [en, fr]) {
      expect(
        new Set([
          catalog['controls.text.normal'],
          catalog['controls.text.large'],
          catalog['controls.text.xlarge'],
        ]).size,
        'three different step labels',
      ).toBe(3);
    }
    // The siblings keep their own text.
    expect(en['controls.tab.buttons']).toBe('Buttons');
    expect(en['controls.tab.shortcuts']).toBe('Shortcuts');
  });

  it('UIF13.2 controls.text.row, controls.text.current and controls.text.set are closures carrying the label once and verbatim: "Text size: {label}", "Text size: {label} (current)", "Text size: {label}." in English and the "Taille du texte" forms in French, for differing labels', () => {
    // WRONG IMPL KILLED: a key added to en only (tf() throws in a French boot: the Display rows
    // blank); a plain string where the label must be interpolated (every row reads the same); a
    // French line left as the English copy; a closure that drops, repeats or hard-codes the label
    // (three labels are fed); the live row and the plain row reading alike (the current step could
    // not be told from the rest); the outcome line missing its closing full stop (it would read
    // like the row); a French colon glued to its word; and a key missing from the roster or the
    // two sample tables.
    type Fn = (p: { label: string }) => string;
    const LABELS = ['Normal', 'Large', 'Extra large'] as const;
    const SPEC: ReadonlyArray<
      readonly [string, (label: string) => string, (label: string) => string[]]
    > = [
      [
        'controls.text.row',
        (label) => `Text size: ${label}`,
        (label) => spaced('Taille du texte', `: ${label}`),
      ],
      [
        'controls.text.current',
        (label) => `Text size: ${label} (current)`,
        (label) => spaced('Taille du texte', `: ${label} (actuelle)`),
      ],
      [
        'controls.text.set',
        (label) => `Text size: ${label}.`,
        (label) => spaced('Taille du texte', `: ${label}.`),
      ],
    ];
    for (const [key, enLine, frLines] of SPEC) {
      expect(typeof en[key], `en ${key} is a closure`).toBe('function');
      expect(typeof fr[key], `fr ${key} is a closure`).toBe('function');
      const enFn = en[key] as Fn;
      const frFn = fr[key] as Fn;
      for (const label of LABELS) {
        expect(enFn({ label }), `en ${key}(${label})`).toBe(enLine(label));
        expect(frLines(label), `fr ${key}(${label}): ${JSON.stringify(frFn({ label }))}`).toContain(
          frFn({ label }),
        );
        expect(frFn({ label }), `${key}(${label}): a translation, not the English line`).not.toBe(
          enFn({ label }),
        );
        expect(enFn({ label }).split(label).length - 1, `en carries ${label} once`).toBe(1);
        expect(frFn({ label }).split(label).length - 1, `fr carries ${label} once`).toBe(1);
      }
      expect(enFn({ label: 'Normal' }), `${key}: the labels change the line (en)`).not.toBe(
        enFn({ label: 'Large' }),
      );
      expect(frFn({ label: 'Normal' }), `${key}: the labels change the line (fr)`).not.toBe(
        frFn({ label: 'Large' }),
      );
      expect(EXPECTED_KEYS.includes(key), `the pinned roster lists ${key}`).toBe(true);
      expect(SAMPLE_PARAMS[key], `${key} has two sample sets`).toHaveLength(2);
      expect(EXPECTED_PARAM_OUTPUTS[key], `${key} has English output pins`).toBeDefined();
    }
    // The three lines differ from each other for one label.
    const probe = { label: 'Large' };
    const lines = SPEC.map(([key]) => (en[key] as Fn)(probe));
    expect(new Set(lines).size, 'row, current and set read differently').toBe(3);
    expect(
      new Set(SPEC.map(([key]) => (fr[key] as Fn)(probe))).size,
      'and so do the French lines',
    ).toBe(3);
  });
});

// =============================================================================
// uif-14 (UIF14.1, UIF14.2, UIF14.4, UIF14.5): the Help ids, in BOTH catalogs. Only the two tab
// titles are pinned byte for byte (typed here, none read off the catalog under test); the copy of the
// paragraphs and of the sixteen entries is authored with the slice, so those ids are pinned by
// presence, shape and en != fr (helpModel.test.ts proves the model reads them).
// =============================================================================

/** U+00E9 (e acute), by code point, for the French "Encyclopedie". */
const UIF14_E_ACUTE = String.fromCharCode(0x00e9);

describe('uif-14: the Help ids in both catalogs', () => {
  const en = CATALOG_EN as Record<string, unknown>;
  const fr = CATALOG_FR as Record<string, unknown>;

  it('UIF14.1 help.tab.intro and help.tab.encyclopedia read Introduction / Introduction and Encyclopedia / Encyclopedie (accented) as plain strings, in the pinned roster', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot: a tab label goes
    // blank); a decomposed or missing accent in the French title; the Encyclopedia title left as the
    // English copy; a key missing from the roster; the retired `help.tab.screen` reused with a new text.
    const PINNED: ReadonlyArray<readonly [string, string, string]> = [
      ['help.tab.intro', 'Introduction', 'Introduction'],
      ['help.tab.encyclopedia', 'Encyclopedia', `Encyclop${UIF14_E_ACUTE}die`],
    ];
    for (const [key, enText, frText] of PINNED) {
      expect(typeof en[key], `en ${key} is a plain string`).toBe('string');
      expect(typeof fr[key], `fr ${key} is a plain string`).toBe('string');
      expect(en[key], `en ${key}`).toBe(enText);
      expect(fr[key], `fr ${key}`).toBe(frText);
      expect(EXPECTED_KEYS.includes(key), `${key} is in the roster`).toBe(true);
    }
    expect(fr['help.tab.encyclopedia'], 'the Encyclopedia title is a translation').not.toBe(
      en['help.tab.encyclopedia'],
    );
  });

  it('UIF14.4 the other 34 plain Help ids (two paragraphs, sixteen terms, sixteen definitions) are non-empty plain strings in both catalogs, every fr text differs from its en text, and the sixteen terms (and definitions) are distinct within a locale', () => {
    // WRONG IMPL KILLED: an id present in en only, or empty; an fr entry copy-pasted from English (a
    // French player reads English: UIF14.4 "in en and fr"); two entries sharing one term (the list
    // would show two identical rows) or one definition; an id missing from the pinned roster.
    const ids = UIF14_PLAIN_IDS.filter(
      (id) => id !== 'help.tab.intro' && id !== 'help.tab.encyclopedia',
    );
    expect(ids, 'ANTI-VACUITY: 2 paragraphs + 16 terms + 16 definitions').toHaveLength(34);
    for (const id of ids) {
      expect(typeof en[id], `en ${id} is a plain string`).toBe('string');
      expect(typeof fr[id], `fr ${id} is a plain string`).toBe('string');
      expect((en[id] as string).trim().length, `en ${id} is non-empty`).toBeGreaterThan(0);
      expect((fr[id] as string).trim().length, `fr ${id} is non-empty`).toBeGreaterThan(0);
      // A term may legitimately be the same word in both languages (e.g. "Initiative"), so the
      // translation pin covers the paragraphs and the definitions only.
      if (!id.endsWith('.term')) {
        expect(fr[id], `${id}: a translation, not the English copy`).not.toBe(en[id]);
      }
      expect(EXPECTED_KEYS.includes(id), `${id} is in the roster`).toBe(true);
    }
    for (const catalog of [en, fr]) {
      for (const kind of ['term', 'def'] as const) {
        const texts = UIF14_ENTRY_KEYS.map((k) => catalog[`help.entry.${k}.${kind}`]);
        expect(new Set(texts).size, `sixteen distinct ${kind} texts`).toBe(16);
      }
    }
  });

  it('UIF14.5 help.detail.related is a closure carrying {terms} once and verbatim in both catalogs, the fr frame a translation, for differing term lists', () => {
    // WRONG IMPL KILLED: a plain string where the terms must be interpolated (every detail reads the
    // same); a closure that drops or repeats the terms; the key in en only (tf() throws in a French
    // boot and the detail sheet loses its related line); an fr frame left as the English one.
    expect(typeof en['help.detail.related'], 'en is a closure').toBe('function');
    expect(typeof fr['help.detail.related'], 'fr is a closure').toBe('function');
    type Fn = (p: { terms: string }) => string;
    const enFn = en['help.detail.related'] as Fn;
    const frFn = fr['help.detail.related'] as Fn;
    for (const terms of ['Party, Storage', 'Bait']) {
      for (const [name, fn] of [
        ['en', enFn],
        ['fr', frFn],
      ] as const) {
        const line = fn({ terms });
        expect(line.split(terms).length - 1, `${name}: the terms appear once, verbatim`).toBe(1);
        expect(line.trim().length, `${name}: more than the terms alone`).toBeGreaterThan(
          terms.length,
        );
      }
      expect(frFn({ terms }), 'the fr line is a translation').not.toBe(enFn({ terms }));
    }
    expect(enFn({ terms: 'A' }), 'the terms change the line (en)').not.toBe(enFn({ terms: 'B' }));
    expect(frFn({ terms: 'A' }), 'the terms change the line (fr)').not.toBe(frFn({ terms: 'B' }));
    expect(EXPECTED_KEYS.includes('help.detail.related')).toBe(true);
  });

  it('UIF14.1 the seven retired Help ids are in neither catalog nor in the pinned roster', () => {
    // WRONG IMPL KILLED: a retired id left behind as a dead key (catalogParity DEAD-KEY): the
    // old tab titles, the three goals and the keys-vs-buttons note.
    for (const id of [
      'help.tab.screen',
      'help.tab.controls',
      'help.tab.goals',
      'help.goal.recruit',
      'help.goal.battle',
      'help.goal.trade',
      'help.note.keysVsButtons',
    ]) {
      expect(Object.hasOwn(en, id), `en still has ${id}`).toBe(false);
      expect(Object.hasOwn(fr, id), `fr still has ${id}`).toBe(false);
      expect(EXPECTED_KEYS.includes(id), `the roster still lists ${id}`).toBe(false);
    }
  });
});

// =============================================================================
// uif-15a (UIF15A.3): no player-facing "Bag" / "Sac" in the menu, the shortcuts row or party-full
// =============================================================================

describe('uif-15a: the Bag / Sac wording is gone from the menu, the shortcuts row and the party-full lines', () => {
  it('UIF15A.3 no menu.* value, controls.accel.bag or partyFull value reads Bag (en) or Sac (fr), and the shortcut and battle-reason values are exact', () => {
    // WRONG IMPL KILLED: a relabel that changed the root title but left the description, the
    // shortcuts row or the party-full line saying Bag / Sac; a key renamed instead of re-valued
    // (the ids `menu.bag.*`, `controls.accel.bag`, `menu.disabled.battleBag` stay); a sweep that
    // matches nothing (ANTI-VACUITY below); a French value still saying Sac; a lowercase or plural
    // spelling ("your bag", "bags", "votre sac") that a case-sensitive match would let through.
    const enAll = CATALOG_EN as unknown as Record<string, unknown>;
    const frAll = CATALOG_FR as unknown as Record<string, unknown>;
    const swept = (catalog: Record<string, unknown>): string[] =>
      Object.keys(catalog).filter(
        (k) => k.startsWith('menu.') || k === 'controls.accel.bag' || k.includes('partyFull'),
      );
    const enKeys = swept(enAll);
    const frKeys = swept(frAll);
    expect(
      enKeys.filter((k) => k.startsWith('menu.')).length,
      'ANTI-VACUITY: menu.*',
    ).toBeGreaterThan(20);
    expect(enKeys, 'the shortcuts key stays').toContain('controls.accel.bag');
    expect(enKeys, 'the battle reason key stays').toContain('menu.disabled.battleBag');
    expect(enKeys, 'the nav-key title stays').toContain('menu.bag.title');
    expect(enKeys, 'the party-full line stays').toContain('chrome.status.partyFull');
    expect(frKeys, 'fr has the same swept keys').toEqual(enKeys);

    // A closure value is called with an empty-ish probe so its text is swept too.
    const textOf = (value: unknown): string =>
      typeof value === 'function'
        ? String((value as (p: Record<string, unknown>) => unknown)({ n: 1, count: 1, name: 'X' }))
        : String(value);
    for (const key of enKeys) {
      expect(textOf(enAll[key]), `en ${key} must not say bag (any case)`).not.toMatch(/\bbags?\b/i);
    }
    for (const key of frKeys) {
      expect(textOf(frAll[key]), `fr ${key} must not say sac (any case)`).not.toMatch(/\bsacs?\b/i);
    }

    expect(enAll['menu.bag.title']).toBe('Inventory');
    expect(frAll['menu.bag.title']).toBe('Inventaire');
    expect(enAll['controls.accel.bag'], 'en shortcuts row').toBe('Inventory');
    expect(frAll['controls.accel.bag'], 'fr shortcuts row').toBe('Inventaire');
    expect(enAll['menu.disabled.battleBag']).toBe('Use items from the battle Items command');
    expect(frAll['menu.disabled.battleBag']).toBe(
      'Utilisez les objets avec la commande Objets du combat',
    );
    expect(String(enAll['menu.disabled.battleBag'])).toContain(String(enAll['tactics.menu.item']));
    expect(String(frAll['menu.disabled.battleBag'])).toContain(String(frAll['tactics.menu.item']));
    expect(enAll['chrome.help.title']).toBe('How to Play');
    expect(frAll['chrome.help.title']).toBe('Comment jouer');
  });
});

// =============================================================================
// uif-15b (UIF15B.1): the Social sub-list's six ids are retired; the Social row's own ids stay.
// =============================================================================

describe('uif-15b: the Social sub-list ids are retired in both catalogs', () => {
  it('UIF15B.1 the six menu.social.{trades,challenges,rankings}.{title,desc} ids are in neither catalog nor in the pinned roster, and the Social row keeps menu.social.title and menu.social.desc', () => {
    // WRONG IMPL KILLED: a retired id left behind as a dead key (catalogParity DEAD-KEY: no menu row
    // reads it any more); an id removed from one locale only (the other keeps a dead key); the
    // Social ROW's own two ids removed with the sub-list's (the root row would print a catalog id);
    // a roster pin that was not lowered with the ids (530 then, 531 since uif-14b; not 536).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const RETIRED = ['trades', 'challenges', 'rankings'].flatMap((leaf) => [
      `menu.social.${leaf}.title`,
      `menu.social.${leaf}.desc`,
    ]);
    expect(RETIRED, 'ANTI-VACUITY: six retired ids').toHaveLength(6);
    for (const id of RETIRED) {
      expect(Object.hasOwn(en, id), `en still has ${id}`).toBe(false);
      expect(Object.hasOwn(fr, id), `fr still has ${id}`).toBe(false);
      expect(EXPECTED_KEYS.includes(id), `the roster still lists ${id}`).toBe(false);
    }
    for (const id of ['menu.social.title', 'menu.social.desc']) {
      expect(typeof en[id], `en keeps ${id}`).toBe('string');
      expect(typeof fr[id], `fr keeps ${id}`).toBe('string');
      expect(EXPECTED_KEYS.includes(id), `the roster keeps ${id}`).toBe(true);
    }
    // uif-14b (named intentional change, UIF14B.1): 530 -> 531, +1 plain help.intro.report.
    // uif-16b (named intentional change): 531 -> 526: -4 menu.profile.* sub-list ids, -chrome.status.privacyOverlayBusy.
    // uif-15c (named intentional change, UIF15C.5): 526 -> 524, -2 `menu.options.{title,desc}`.
    // ts-3: 524 -> 536 (-13 wizard, +25 session keys).
    // ts-4 (named intentional change): 536 -> 527, -9 trade.side.* / trade.feedback.* /
    // social.action.confirm / social.confirm.{declineTrade,confirmTrade}.
    // ts-6b-8 (named intentional change, R-uif-10-TITLES): 527 -> 528, +heal.title.
    // ts-6b-9 (named intentional change): 528 -> 545, +17 `a11y.*` keys.
    // ts-6b-10 (named intentional change): -social.players.placeholder +tradeSession.prompt.confirmMonsters, 545 unchanged
    // ts-6b-11 (named intentional change): -claim.privacyButton -raising.inventory.heading
    // +privacy.disclosure, 545 -> 544.
    expect(Object.keys(en), 'the English roster is 544 keys').toHaveLength(544);
    expect(Object.keys(fr), 'and the French one matches it').toHaveLength(544);
  });
});

// =============================================================================
// uif-16b: the Profile sub-list ids and the privacy-busy line are retired; the one frame's ids stay.
// =============================================================================

describe('uif-16b: the Profile sub-list ids and the privacy-busy line are retired in both catalogs', () => {
  it('UIF16B.7 the five retired ids are in neither catalog nor the pinned roster, while the Profile title, description, section headers and Close row remain in en and fr', () => {
    // WRONG IMPL KILLED: a retired id left as a dead key (catalogParity DEAD-KEY: no row and no
    // `privacy-busy` toast reads it); an id removed from one locale only; the frame's own ids
    // removed with the sub-list's (the title, a section header or the Close row would print a
    // catalog id); a roster pin not lowered with the ids.
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const RETIRED = [
      'menu.profile.name.desc',
      'menu.profile.account.desc',
      'menu.profile.privacy.desc',
      'menu.profile.privacy.title',
      'chrome.status.privacyOverlayBusy',
    ];
    for (const id of RETIRED) {
      expect(Object.hasOwn(en, id), `en still has ${id}`).toBe(false);
      expect(Object.hasOwn(fr, id), `fr still has ${id}`).toBe(false);
      expect(EXPECTED_KEYS.includes(id), `the roster still lists ${id}`).toBe(false);
    }
    const KEPT = [
      'menu.profile.title',
      'menu.profile.desc',
      'menu.profile.name.title',
      'menu.profile.account.title',
      'privacy.title',
      'privacy.close',
    ];
    for (const id of KEPT) {
      expect(typeof en[id], `en keeps ${id}`).toBe('string');
      expect(String(en[id]).trim().length, `en ${id} is not empty`).toBeGreaterThan(0);
      expect(typeof fr[id], `fr keeps ${id}`).toBe('string');
      expect(String(fr[id]).trim().length, `fr ${id} is not empty`).toBeGreaterThan(0);
      expect(EXPECTED_KEYS.includes(id), `the roster keeps ${id}`).toBe(true);
    }
    expect(en['menu.profile.title'], 'the frame title').toBe('Profile');
  });
});

// =============================================================================
// uif-15c (UIF15C.5): the Options group's two ids are retired, and the help / controls pairs are
// re-homed from `menu.options.*` to `menu.*`, in both catalogs.
// =============================================================================

describe('uif-15c: the Options menu ids are retired and re-homed in both catalogs', () => {
  it('UIF15C.5 the six menu.options.* ids are in neither catalog nor the pinned roster, and menu.help.* and menu.controls.* hold the exact re-homed text in en and fr', () => {
    // WRONG IMPL KILLED: a retired id left behind as a dead key (catalogParity DEAD-KEY: no row reads
    // it any more); an id removed from one locale only; the help / controls rows left reading
    // `menu.options.help.*` / `menu.options.controls.*` (the old ids kept AND the new ones missing);
    // the new help title left at 'How to play' (it must match the frame it opens, 'How to Play'); an
    // fr title that drifted ('Comment jouer' / 'Commandes' are pinned); the new ids missing from the
    // roster; a pair swapped with its sibling's text (every byte is pinned).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const RETIRED = [
      'menu.options.title',
      'menu.options.desc',
      'menu.options.help.title',
      'menu.options.help.desc',
      'menu.options.controls.title',
      'menu.options.controls.desc',
    ];
    expect(RETIRED, 'ANTI-VACUITY: six retired ids').toHaveLength(6);
    for (const id of RETIRED) {
      expect(Object.hasOwn(en, id), `en still has ${id}`).toBe(false);
      expect(Object.hasOwn(fr, id), `fr still has ${id}`).toBe(false);
      expect(EXPECTED_KEYS.includes(id), `the roster still lists ${id}`).toBe(false);
    }
    expect(
      Object.keys(en).filter((k) => k.startsWith('menu.options')),
      'no menu.options.* id of any kind in en',
    ).toEqual([]);
    expect(
      Object.keys(fr).filter((k) => k.startsWith('menu.options')),
      'no menu.options.* id of any kind in fr',
    ).toEqual([]);

    const NEW: ReadonlyArray<readonly [string, string, string]> = [
      ['menu.help.title', 'How to Play', 'Comment jouer'],
      ['menu.help.desc', 'Controls and goals of the game.', 'Commandes et objectifs du jeu.'],
      ['menu.controls.title', 'Controls', 'Commandes'],
      [
        'menu.controls.desc',
        'Choose which key presses each button.',
        'Choisir la touche de chaque bouton.',
      ],
    ];
    expect(NEW, 'ANTI-VACUITY: four new ids').toHaveLength(4);
    for (const [id, enText, frText] of NEW) {
      expect(en[id], `en ${id}`).toBe(enText);
      expect(fr[id], `fr ${id}`).toBe(frText);
      expect(typeof en[id], `en ${id} is a plain string`).toBe('string');
      expect(typeof fr[id], `fr ${id} is a plain string`).toBe('string');
      expect(EXPECTED_KEYS.includes(id), `the roster lists ${id}`).toBe(true);
      expect(EXPECTED_PLAIN[id], `the plain table pins ${id}`).toBe(enText);
    }
    // The help row names the frame it opens.
    expect(en['menu.help.title'], 'the help row reads like the frame title').toBe(
      en['chrome.help.title'],
    );
    expect(fr['menu.help.title']).toBe(fr['chrome.help.title']);
    // The rest of the menu is untouched (a wholesale menu.* deletion would pass the loops above).
    for (const id of ['menu.title', 'menu.close.title', 'menu.close.desc', 'menu.social.title']) {
      expect(typeof en[id], `en keeps ${id}`).toBe('string');
      expect(typeof fr[id], `fr keeps ${id}`).toBe('string');
    }
    // ts-3: 524 -> 536 (-13 wizard, +25 session keys).
    // ts-4 (named intentional change): 536 -> 527, -9 trade.side.* / trade.feedback.* /
    // social.action.confirm / social.confirm.{declineTrade,confirmTrade}.
    // ts-6b-8 (named intentional change, R-uif-10-TITLES): 527 -> 528, +heal.title.
    // ts-6b-9 (named intentional change): 528 -> 545, +17 `a11y.*` keys.
    // ts-6b-10 (named intentional change): -social.players.placeholder +tradeSession.prompt.confirmMonsters, 545 unchanged
    // ts-6b-11 (named intentional change): -claim.privacyButton -raising.inventory.heading
    // +privacy.disclosure, 545 -> 544.
    expect(Object.keys(en), 'the English roster is 544 keys').toHaveLength(544);
    expect(Object.keys(fr), 'and the French one matches it').toHaveLength(544);
  });
});
