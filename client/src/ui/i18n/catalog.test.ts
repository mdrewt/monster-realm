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
import { CATALOG_EN } from './catalog.en';
import { CATALOG_FR } from './catalog.fr';

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
  'battle.weather.banner': [
    { label: 'Rain', turns: 2 },
    { label: 'Sandstorm', turns: 5 },
  ],
  'battle.card.level': [{ level: 7 }, { level: 12 }],
  'battle.card.hpLine': [
    { current: 3, max: 9, affinity: 'Plant' },
    { current: 20, max: 40, affinity: 'Fire' },
  ],
  // ctl-8i (named intentional change): both skill labels take power AND accuracy (the grid cell
  // gives affinity, power and accuracy), so the hover-only `battle.skill.accuracy` key is DELETED
  // (R-rb-56-FOLLOWUP-ACC) and the parameterised `battle.commands.waiting` takes its place here;
  // +7 plain keys (the five command labels, the group label, the Run reason) are in EXPECTED_PLAIN
  // = 279 keys. Every numeric field differs between the two sets, power 0 and accuracy 0 / 100
  // included.
  'battle.skill.pvpSubmit': [
    { name: 'Vine Lash', power: 40, affinity: 'Plant', accuracy: 95 },
    { name: 'Ember Jab', power: 0, affinity: 'Fire', accuracy: 100 },
  ],
  'battle.skill.pveLabel': [
    { name: 'Vine Lash', power: 40, affinity: 'Plant', accuracy: 95 },
    { name: 'Ember Jab', power: 35, affinity: 'Fire', accuracy: 0 },
  ],
  'battle.commands.waiting': [{ name: 'Rival' }, { name: 'Zed' }],
  'battle.cure.option': [
    { name: 'Tonic', cureStatus: 'Poison', count: 1 },
    { name: 'Salve', cureStatus: 'Paralysis', count: 3 },
  ],
  // ctl-8j (named intentional change): +2 parameterised keys — the Recruit confirm names the bait
  // and the Bag target names the active monster. Both are model data, carried verbatim.
  'battle.recruit.confirm': [{ bait: 'Herb' }, { bait: 'Lure Berry' }],
  'battle.cure.target': [{ species: 'Sproutle' }, { species: 'Emberfang' }],
  'battle.swap.pvpSubmit': [{ species: 'Mosshorn' }, { species: 'Cindertail' }],
  'battle.swap.pveLabel': [
    { species: 'Mosshorn', current: 6, max: 10 },
    { species: 'Cindertail', current: 15, max: 20 },
  ],
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
  // ctl-8e: the Review summary of the PARSED on-screen draft (1 ★). `offer` and `ask` are the
  // parsed coin amounts as decimal strings, `monsters` the checked count; every field differs
  // between the two sets, numbers included.
  'tradePropose.review.summary': [
    { target: 'Zed', monsters: 2, offer: '25', ask: '7' },
    { target: 'Amy', monsters: 3, offer: '1000', ask: '4' },
  ],
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
  // qf-17 (named intentional change, QF17.1/QF17.2): 363 → 365, +battle.rewards.gold,
  // +battle.rewards.xp (2 ★), the KO-win payout lines under the outcome banner. `amount` of the gold
  // line is the wallet delta, a bigint; the xp line's `name` is a monster nickname or species name
  // (model data, carried verbatim) and its `amount` a number; every field differs between the sets.
  'battle.rewards.gold': [{ amount: 30n }, { amount: 7n }],
  'battle.rewards.xp': [
    { name: 'Sparky', amount: 12 },
    { name: 'Bolt', amount: 3 },
  ],
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
};

/** ctl-8a's description "none" mark: U+2014 EM DASH, built by code point (never a pasted glyph). */
const EM_DASH = String.fromCharCode(0x2014);
/** ctl-8c's "opens a list" mark on the Feed… / Evolve… rows: U+2026 HORIZONTAL ELLIPSIS. */
const ELLIPSIS = String.fromCharCode(0x2026);
/** ctl-8i's curly apostrophe in the Run reason, U+2019 by code point (RIGHT_QUOTE below is declared
 *  after the plain table, which would read it in its temporal dead zone). */
const CURLY_APOSTROPHE = String.fromCharCode(0x2019);
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
  'chrome.help.title': 'Controls & Goals',
  // ctl-14 (CTL14.1): the generated Help's tab titles, goals and note.
  'help.tab.screen': 'This screen',
  'help.tab.controls': 'All controls',
  'help.tab.goals': 'Goals',
  'help.goal.recruit': 'Recruit a wild monster',
  'help.goal.battle': 'Win your first battle',
  'help.goal.trade': 'Try trading with another tester',
  'help.note.keysVsButtons':
    'Keys are what you press on the keyboard; buttons (A, B, X, Y, LB, RB, Start, Select) are what they stand for. With the default keys, the key B opens Storage, while the button B goes back.',
  'chrome.rename.submit': 'Rename',
  'chrome.tradePropose.submit': 'Offer',
  'chrome.status.exportBlocked': 'data export: download blocked by the browser',
  'chrome.status.privacyOverlayBusy': 'privacy: close the other overlay first',
  'chrome.status.contentStale': 'content out of date — reload',
  'chrome.status.bugBundleBlocked': 'bug bundle: download blocked — copy from console',
  'chrome.status.healUnavailable': 'heal: no heal location available',
  'chrome.status.partyFull': 'party is full — move a monster to the box first',
  'battle.title': 'Battle', // battleView.ts:110
  'battle.continueHint': 'Press Enter or Esc to continue', // battleView.ts:243
  'battle.swap.hint':
    'No healthy party monster in this battle to swap in. ' +
    // qf-10 (named intentional change, QF10.4): was '... then B for Party & Box.'.
    'When this battle ends, press Esc, then B for Monsters.', // battleView.ts:216-218
  'battle.pvp.waiting': 'Waiting for opponent’s action…', // battleView.ts:347
  'battle.card.you': 'You', // battleView.ts:291
  'battle.card.opponent': 'Opponent', // battleView.ts:289
  // qf-7c (named intentional change, QF7B.1): `battle.action.flee` ('Flee') is RETIRED with the
  // legacy battle Flee button (catalogParity DEAD-KEY); the command list's Run is the only flee.
  'battle.recruit.noBait': 'No bait', // battleView.ts:522
  // ctl-8j (named intentional change): `battle.recruit.submit` ('Recruit'), `battle.cure.placeholder`
  // ('Select item') and `battle.cure.submit` ('Use Item') are RETIRED with the two <select>s and
  // their submit buttons (catalogParity DEAD-KEY); +5 plain keys — the bait list's name, the
  // Recruit confirm's no-bait question and its Yes / No, and the cure list's name.
  'battle.recruit.listLabel': 'Bait',
  'battle.recruit.confirmNoBait': 'Recruit with no bait?',
  'battle.recruit.yes': 'Yes',
  'battle.recruit.no': 'No',
  'battle.cure.listLabel': 'Cure items',
  'battle.outcome.victory': 'Victory!', // battleView.ts:629
  'battle.outcome.defeat': 'Defeat...', // battleView.ts:632
  'battle.outcome.fled': 'Got away safely!', // battleView.ts:635
  // ctl-8i (named intentional change): +7 plain keys — the five command labels, the command
  // group's accessible name and the reason Run is disabled in a player battle (battleView.ts).
  'battle.command.fight': 'Fight',
  'battle.command.recruit': 'Recruit',
  'battle.command.swap': 'Swap',
  // qf-10 (named intentional change, QF10.5): the value was 'Bag'; the id is unchanged.
  'battle.command.bag': 'Items',
  'battle.command.run': 'Run',
  'battle.commands.label': 'Commands',
  'battle.command.runPvpReason': `You can${CURLY_APOSTROPHE}t run from a player battle.`,
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
  'raising.inventory.heading': 'Inventory', // raisingView.ts
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
  'box.section.party': 'Party', // boxView.ts
  'box.section.box': 'Storage', // boxView.ts
  'box.box.empty': 'No monsters in storage.', // boxView.ts
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
  // Trade.* (4 plain). qf-8 (named intentional change): `trade.action.{accept,reject,confirm,
  // cancel}` ('Accept', 'Reject', 'Confirm Trade', 'Cancel') are RETIRED with the trade row's
  // buttons; the Social sheet's `social.action.*` rows answer a trade.
  'trade.status.none': 'No active trade', // tradeView.ts
  'trade.side.offer': 'You offer', // tradeView.ts (hoisted, #renderSide heading arg)
  'trade.side.receive': 'You receive', // tradeView.ts (hoisted, #renderSide heading arg)
  'trade.side.nothing': '(nothing)', // tradeView.ts
  // Shop.* (6 plain)
  'shop.title': 'Shop', // shopView.ts
  'shop.noShop': 'No shop available.', // shopView.ts
  'shop.forSale.empty': 'Nothing for sale.', // shopView.ts
  'shop.inventory.empty': 'No items to sell.', // shopView.ts
  'shop.buy.submit': 'Buy', // shopView.ts
  'shop.sell.submit': 'Sell', // shopView.ts
  // The tail batch's 10 plain keys.
  'tradePropose.target.placeholder': 'Select a player…', // tradeProposeView.ts:168
  'dialogue.action.shop': 'Shop', // dialogueView.ts:72
  'claim.privacyButton': 'Privacy & Account Data', // claimView.ts (resolved in render()/show())
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
  'trade.feedback.accepted': 'Trade accepted!', // main.ts:2668
  'trade.feedback.rejected': 'Trade rejected.', // main.ts:2675
  'trade.feedback.completed': 'Trade complete!', // main.ts:2682
  'trade.feedback.cancelled': 'Trade cancelled.', // main.ts:2689
  'chrome.rename.updated': 'Name updated!', // main.ts:2801
  'tradePropose.feedback.sent': 'Offer sent!', // main.ts:2828
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
  'menu.bag.title': 'Bag',
  'menu.bag.desc': 'Use items and care for your monsters.',
  'menu.journal.title': 'Journal',
  'menu.journal.desc': 'Review your quests and their progress.',
  'menu.social.title': 'Social',
  'menu.social.desc': 'Trades, challenges and rankings with other players.',
  'menu.profile.title': 'Profile',
  'menu.profile.desc': 'Your name, account and privacy settings.',
  'menu.options.title': 'Options',
  'menu.options.desc': 'Help on how to play the game.',
  'menu.close.title': 'Close',
  'menu.close.desc': 'Close the menu and return to the world.',
  'menu.social.trades.title': 'Trades',
  'menu.social.trades.desc': 'See and answer the trade offered to you.',
  'menu.social.challenges.title': 'Challenges',
  // NAMED INTENTIONAL CHANGE (ctl-10b, CTL10B.2): was 'Challenge a player or answer a challenge.';
  // no menu row starts a challenge any more, so the leaf only answers them.
  'menu.social.challenges.desc': 'See and answer challenges.',
  'menu.social.rankings.title': 'Rankings',
  'menu.social.rankings.desc': 'See the ranked leaderboard.',
  'menu.profile.name.title': 'Name',
  'menu.profile.name.desc': 'Change the name other players see.',
  'menu.profile.account.title': 'Account',
  'menu.profile.account.desc': 'Sign in or keep this guest progress.',
  'menu.profile.privacy.title': 'Privacy',
  'menu.profile.privacy.desc': 'Export or delete your data.',
  'menu.options.help.title': 'How to play',
  'menu.options.help.desc': 'Controls and goals of the game.',
  // ctl-6c: 2 new plain keys — the reasons a main-menu entry is disabled over a battle
  // (ui/screens/mainMenuScreen.ts), the first also the dispatch refusal line (main.ts).
  'menu.disabled.inBattle': 'Not during a battle',
  'menu.disabled.battleBag': 'Use items from the battle Bag command',
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
  'social.players.placeholder': 'The player list is not available yet.',
  'social.action.accept': 'Accept',
  'social.action.decline': 'Decline',
  'social.action.confirm': 'Confirm',
  'social.action.cancel': 'Cancel',
  'social.confirm.declineTrade': 'Decline this trade?',
  'social.confirm.confirmTrade': 'Complete this trade? It cannot be undone.',
  'social.confirm.declineChallenge': 'Decline this challenge?',
  // ctl-8e: 9 new plain keys — the trade-propose wizard's step header (five steps), the Review
  // question, the line shown when the on-screen draft cannot be sent, and the Yes / No answers
  // (all painted by tradeProposeView.ts).
  'tradePropose.step.target': 'Target',
  'tradePropose.step.offer': 'Offer',
  'tradePropose.step.coins': 'Coins',
  'tradePropose.step.ask': 'Ask',
  'tradePropose.step.review': 'Review',
  'tradePropose.review.prompt': 'Send this offer?',
  'tradePropose.review.incomplete': 'This offer is not complete.',
  'tradePropose.review.yes': 'Yes',
  'tradePropose.review.no': 'No',
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
  'controls.accel.bag': 'Bag',
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
  'menu.options.controls.title': 'Controls',
  'menu.options.controls.desc': 'Choose which key presses each button.',
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
  'battle.weather.banner': {
    inputA: { label: 'Rain', turns: 2 },
    outputA: 'Rain (2 turns)',
    inputB: { label: 'Sandstorm', turns: 5 },
    outputB: 'Sandstorm (5 turns)',
  },
  'battle.card.level': {
    inputA: { level: 7 },
    outputA: 'Lv7',
    inputB: { level: 12 },
    outputB: 'Lv12',
  },
  'battle.card.hpLine': {
    inputA: { current: 3, max: 9, affinity: 'Plant' },
    outputA: 'HP 3/9 · Plant',
    inputB: { current: 20, max: 40, affinity: 'Fire' },
    outputB: 'HP 20/40 · Fire',
  },
  // INTENTIONAL CHANGE (ctl-8i, CTL8I.2): the skill cell gives affinity, power AND accuracy in both
  // modes, so both labels take all four params and end `· Acc N%`; the accuracy key is deleted.
  // Was: pvpSubmit `Submit: {name} · {affinity}`, pveLabel `{name} ({power}) · {affinity}`, and a
  // separate `battle.skill.accuracy` (`Acc N%`) that only the hover title carried. Power 0 and
  // accuracy 0 / 100 are in the sets so a falsy fallback cannot hide.
  'battle.skill.pvpSubmit': {
    inputA: { name: 'Vine Lash', power: 40, affinity: 'Plant', accuracy: 95 },
    outputA: `Submit: Vine Lash (40) ${CELL_DOT} Plant ${CELL_DOT} Acc 95%`,
    inputB: { name: 'Ember Jab', power: 0, affinity: 'Fire', accuracy: 100 },
    outputB: `Submit: Ember Jab (0) ${CELL_DOT} Fire ${CELL_DOT} Acc 100%`,
  },
  'battle.skill.pveLabel': {
    inputA: { name: 'Vine Lash', power: 40, affinity: 'Plant', accuracy: 95 },
    outputA: `Vine Lash (40) ${CELL_DOT} Plant ${CELL_DOT} Acc 95%`,
    inputB: { name: 'Ember Jab', power: 35, affinity: 'Fire', accuracy: 0 },
    outputB: `Ember Jab (35) ${CELL_DOT} Fire ${CELL_DOT} Acc 0%`,
  },
  // ctl-8i: the caption over a greyed command list while the opponent has not acted.
  'battle.commands.waiting': {
    inputA: { name: 'Rival' },
    outputA: `Waiting for Rival${ELLIPSIS}`,
    inputB: { name: 'Zed' },
    outputB: `Waiting for Zed${ELLIPSIS}`,
  },
  'battle.cure.option': {
    inputA: { name: 'Tonic', cureStatus: 'Poison', count: 1 },
    outputA: 'Tonic (cures Poison) ×1',
    inputB: { name: 'Salve', cureStatus: 'Paralysis', count: 3 },
    outputB: 'Salve (cures Paralysis) ×3',
  },
  // ctl-8j: the Recruit confirm (the bait's name verbatim) and the Bag target (the active monster's
  // species verbatim).
  'battle.recruit.confirm': {
    inputA: { bait: 'Herb' },
    outputA: 'Recruit with Herb?',
    inputB: { bait: 'Lure Berry' },
    outputB: 'Recruit with Lure Berry?',
  },
  'battle.cure.target': {
    inputA: { species: 'Sproutle' },
    outputA: 'Use on Sproutle',
    inputB: { species: 'Emberfang' },
    outputB: 'Use on Emberfang',
  },
  'battle.swap.pvpSubmit': {
    inputA: { species: 'Mosshorn' },
    outputA: 'Submit Swap: Mosshorn',
    inputB: { species: 'Cindertail' },
    outputB: 'Submit Swap: Cindertail',
  },
  'battle.swap.pveLabel': {
    inputA: { species: 'Mosshorn', current: 6, max: 10 },
    outputA: 'Swap: Mosshorn (6/10)',
    inputB: { species: 'Cindertail', current: 15, max: 20 },
    outputB: 'Swap: Cindertail (15/20)',
  },
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
  // ctl-8e: the trade-propose Review summary (CTL8E.1).
  'tradePropose.review.summary': {
    inputA: { target: 'Zed', monsters: 2, offer: '25', ask: '7' },
    // INTENTIONAL CHANGE (ctl-8e round 2): was "To {target}: {n} monsters and {offer} coins,
    // asking {ask} coins" ("1 monsters" for a single one); now a labelled list that reads right for
    // any count.
    outputA: `To Zed ${MIDDLE_DOT} Monsters: 2 ${MIDDLE_DOT} Coins: 25 ${MIDDLE_DOT} Asking: 7`,
    inputB: { target: 'Amy', monsters: 3, offer: '1000', ask: '4' },
    outputB: `To Amy ${MIDDLE_DOT} Monsters: 3 ${MIDDLE_DOT} Coins: 1000 ${MIDDLE_DOT} Asking: 4`,
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
  // qf-17 (QF17.1, QF17.2): the KO-win payout lines; the gold digits are the bigint's own, and the
  // monster name sits once, verbatim, in its xp line.
  'battle.rewards.gold': {
    inputA: { amount: 30n },
    outputA: '+30 gold',
    inputB: { amount: 7n },
    outputB: '+7 gold',
  },
  'battle.rewards.xp': {
    inputA: { name: 'Sparky', amount: 12 },
    outputA: 'Sparky +12 XP',
    inputB: { name: 'Bolt', amount: 3 },
    outputB: 'Bolt +3 XP',
  },
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
};

/** The full 425-key roster (bt-10: +60 `tactics.*` keys over the 365-key roster below;
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
const EXPECTED_KEYS = Object.keys(EXPECTED_PLAIN).concat(Object.keys(SAMPLE_PARAMS)).sort();

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

  it('m24s1 CATALOG-SHAPE: CATALOG_EN is frozen, its source entry-line count matches Object.keys, no own prototype-name keys, every value resolves to a non-empty string, the key roster is exactly the bt-10 425-key roster (bt-10, named intentional change, BT10.5/BT10.6: 365 → 425, +tactics.*), and the source spells `satisfies Catalog` + `Object.freeze(` exactly once each', () => {
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
  it('m24s3/21r-b/21r-b2 CAT-01 [21R-B2-ROSTER-178]: the roster is exactly 425 keys (bt-10, named intentional change, BT10.5/BT10.6: 365 → 425, +tactics.*), SAMPLE_PARAMS is a bijection with the function-valued keys, every plain/param value is byte-identical to the pre-migration source (both sample sets), and the two glyph pins hold', () => {
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
    expect(EXPECTED_KEYS, 'ANTI-VACUITY: the bt-10 roster is 425 keys').toHaveLength(425);

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

    // (e) the two glyph pins — by code point, not a pasted glyph.
    const waiting = (CATALOG_EN as Record<string, unknown>)['battle.pvp.waiting'] as string;
    expect(waiting.includes('’'), 'battle.pvp.waiting must carry U+2019').toBe(true);
    expect(waiting.includes('…'), 'battle.pvp.waiting must carry U+2026').toBe(true);
    const outgoingFn = (CATALOG_EN as Record<string, unknown>)['pvp.outgoing.label'] as (p: {
      target: string;
    }) => string;
    const outgoingSample = outgoingFn({ target: 'Zed' });
    expect(outgoingSample.includes('…'), 'pvp.outgoing.label output must carry U+2026').toBe(true);
    expect(
      outgoingSample.includes(' — '),
      'pvp.outgoing.label output must carry " " + U+2014 (em dash) + " "',
    ).toBe(true);

    // (f) battle.swap.hint is one string containing '. When'.
    const swapHint = (CATALOG_EN as Record<string, unknown>)['battle.swap.hint'] as string;
    expect(typeof swapHint, 'battle.swap.hint must be a plain string').toBe('string');
    expect(swapHint.includes('. When'), 'battle.swap.hint must contain the literal ". When"').toBe(
      true,
    );
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

const EXPECTED_FR_CTL6C: Record<string, string> = {
  'battle.continueHint': `Appuyez sur Entr${E_ACUTE}e ou Esc pour continuer`,
  'menu.disabled.inBattle': 'Impossible pendant un combat',
  'menu.disabled.battleBag': 'Utilisez les objets avec la commande Sac du combat',
};

describe('ctl-6c: catalog.fr.ts, the battle keys ctl-6c changed or added', () => {
  it('ctl-6c FR-PINS: the French battle.continueHint names Enter as well as Esc, and the two menu.disabled.* reasons are their exact French text, each a translation of its English entry', () => {
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
// ctl-8d: the French values of the 12 keys ctl-8d adds (the Social tabs, the Players placeholder,
// the action sheet's rows and its three Yes / No questions), pinned exactly as the English ones are
// in EXPECTED_PLAIN above. Before each `?` stands a U+00A0 NO-BREAK SPACE: the French typography
// convention catalog.fr.ts documents in its header and follows in `box.evolve.confirm`.
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
  'social.players.placeholder': `La liste des joueurs n${RIGHT_QUOTE}est pas encore disponible.`,
  'social.action.accept': 'Accepter',
  'social.action.decline': 'Refuser',
  'social.action.confirm': 'Confirmer',
  'social.action.cancel': 'Annuler',
  'social.confirm.declineTrade': `Refuser cet ${E_ACUTE}change${NO_BREAK_SPACE}?`,
  'social.confirm.confirmTrade': `Conclure cet ${E_ACUTE}change${NO_BREAK_SPACE}? Cette action est irr${E_ACUTE}versible.`,
  'social.confirm.declineChallenge': `Refuser ce d${E_ACUTE}fi${NO_BREAK_SPACE}?`,
};

describe('ctl-8d: catalog.fr.ts, the keys ctl-8d adds', () => {
  it('ctl-8d FR-PINS: the 12 new plain keys carry their exact French text in catalog.fr.ts, each a translation of its English entry', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot); a French entry left
    // as the English copy, reworded, or swapped with a sibling (Accepter / Refuser, the two
    // trade questions); a confirm question that drops the irreversibility; a straight apostrophe
    // (not U+2019) in the placeholder; a decomposed or missing accent; and a question mark glued
    // to its word or set off by a plain breaking space instead of the catalog's U+00A0 (a browser
    // could wrap the `?` onto a line of its own).
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
      'ANTI-VACUITY: all 12 ctl-8d keys are pinned in French',
    ).toBe(12);
  });
});

// =============================================================================
// ctl-8e: the French side of the 10 keys ctl-8e adds (the wizard's step header, the Review
// question, the incomplete line, Yes / No and the summary). The exact French wording is the
// translator's; what is pinned is that every key EXISTS in catalog.fr.ts with the right shape (a
// missing key makes t() throw in a French boot, the whole wizard blank), that the three sentences
// are translations rather than the English copy, and that the summary closure carries every param
// through.
// =============================================================================

describe('ctl-8e: catalog.fr.ts, the keys ctl-8e adds', () => {
  it('CTL8E-1-VIEW-PAINT: the 9 new plain keys are non-empty strings and the summary a closure in catalog.fr.ts; the prompt, the incomplete line and the summary are not the English copy; and the summary closure echoes every param, both sample sets, with two different outputs', () => {
    // WRONG IMPL KILLED: a key added to en only (the French wizard header and Review would throw);
    // a French sentence left as the English copy; a summary closure that drops or swaps a param
    // (the target, the count or a coin amount); and a closure that ignores the numeric params
    // (both sample sets would print the same line).
    const fr = CATALOG_FR as Record<string, unknown>;
    const plainKeys = Object.keys(EXPECTED_PLAIN).filter((k) => k.startsWith('tradePropose.'));
    const wizardPlain = plainKeys.filter(
      (k) => k !== 'tradePropose.target.placeholder' && k !== 'tradePropose.feedback.sent',
    );
    expect(wizardPlain.slice().sort(), 'fixture: the 9 ctl-8e plain keys').toEqual([
      'tradePropose.review.incomplete',
      'tradePropose.review.no',
      'tradePropose.review.prompt',
      'tradePropose.review.yes',
      'tradePropose.step.ask',
      'tradePropose.step.coins',
      'tradePropose.step.offer',
      'tradePropose.step.review',
      'tradePropose.step.target',
    ]);
    for (const key of wizardPlain) {
      expect(typeof fr[key], `${key} must be a plain string in the fr catalog`).toBe('string');
      expect((fr[key] as string).length > 0, `${key} must be non-empty`).toBe(true);
    }
    for (const key of ['tradePropose.review.prompt', 'tradePropose.review.incomplete']) {
      expect(fr[key], `${key}: a translation, not the English copy`).not.toBe(EXPECTED_PLAIN[key]);
    }

    const key = 'tradePropose.review.summary';
    const spec = EXPECTED_PARAM_OUTPUTS[key] as ParamOutputSpec;
    expect(spec, 'fixture: the English output pins exist').toBeDefined();
    expect(typeof fr[key], `${key} must be a closure in the fr catalog`).toBe('function');
    const fn = fr[key] as (p: Record<string, unknown>) => string;
    const outA = fn(spec.inputA);
    const outB = fn(spec.inputB);
    expect(outA, 'a translation, not the English line').not.toBe(spec.outputA);
    expect(outA, 'the two sample sets print different lines').not.toBe(outB);
    for (const [out, input] of [
      [outA, spec.inputA],
      [outB, spec.inputB],
    ] as const) {
      for (const [field, value] of Object.entries(input)) {
        expect(out.includes(String(value)), `${field}=${String(value)} appears in ${out}`).toBe(
          true,
        );
      }
    }
  });

  it('CTL8E-1-VIEW-PAINT: the summary reads right for a single monster (no "1 monsters") and its French is the exact labelled list, every space before a colon a U+00A0 NO-BREAK SPACE, for both sample sets', () => {
    // WRONG IMPL KILLED: the plural sentence "{n} monsters and ..." (a single ticked monster reads
    // "1 monsters"); a French colon set off by a plain breaking space (a browser may wrap the colon
    // onto a line of its own); a French line with an ASCII e grave stand-in, or the English words
    // left in; and a closure that reorders or drops a field.
    const en = (CATALOG_EN as Record<string, unknown>)['tradePropose.review.summary'] as (
      p: Record<string, unknown>,
    ) => string;
    expect(en({ target: 'Zed', monsters: 1, offer: '0', ask: '0' })).toBe(
      `To Zed ${MIDDLE_DOT} Monsters: 1 ${MIDDLE_DOT} Coins: 0 ${MIDDLE_DOT} Asking: 0`,
    );
    expect(
      en({ target: 'Zed', monsters: 1, offer: '0', ask: '0' }).includes(' monsters'),
      'no plural noun after a count',
    ).toBe(false);

    const E_GRAVE = String.fromCharCode(0x00e8);
    const fr = (CATALOG_FR as Record<string, unknown>)['tradePropose.review.summary'] as (
      p: Record<string, unknown>,
    ) => string;
    const spec = EXPECTED_PARAM_OUTPUTS['tradePropose.review.summary'] as ParamOutputSpec;
    const frame = (p: { target: string; monsters: number; offer: string; ask: string }): string =>
      `Pour ${p.target} ${MIDDLE_DOT} Monstres${NO_BREAK_SPACE}: ${p.monsters} ${MIDDLE_DOT} ` +
      `Pi${E_GRAVE}ces${NO_BREAK_SPACE}: ${p.offer} ${MIDDLE_DOT} Demande${NO_BREAK_SPACE}: ${p.ask}`;
    expect(fr(spec.inputA)).toBe(frame({ target: 'Zed', monsters: 2, offer: '25', ask: '7' }));
    expect(fr(spec.inputB)).toBe(frame({ target: 'Amy', monsters: 3, offer: '1000', ask: '4' }));
  });
});

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
// ctl-8j: the French side of the 7 keys ctl-8j adds (the bait list's name, the Recruit confirm and
// its Yes / No, the cure list's name and the Bag target), and the 3 keys it retires. Before each `?`
// stands a U+00A0 NO-BREAK SPACE, the typography catalog.fr.ts documents in its header (ctl-8d).
// =============================================================================

/** U+00E2 (a circumflex), built by code point so the expected text holds no pasted glyph. */
const A_CIRCUMFLEX = String.fromCharCode(0x00e2);

const EXPECTED_FR_CTL8J_PLAIN: Record<string, string> = {
  'battle.recruit.listLabel': `App${A_CIRCUMFLEX}t`,
  'battle.recruit.confirmNoBait': `Recruter sans app${A_CIRCUMFLEX}t${NO_BREAK_SPACE}?`,
  'battle.recruit.yes': 'Oui',
  'battle.recruit.no': 'Non',
  'battle.cure.listLabel': 'Objets de soin',
};

/** The French output for sample A, then sample B, of each new parameterised key. */
const EXPECTED_FR_CTL8J_PARAMS: Record<string, readonly [string, string]> = {
  'battle.recruit.confirm': [
    `Recruter avec Herb${NO_BREAK_SPACE}?`,
    `Recruter avec Lure Berry${NO_BREAK_SPACE}?`,
  ],
  'battle.cure.target': ['Utiliser sur Sproutle', 'Utiliser sur Emberfang'],
};

describe('ctl-8j: catalog.fr.ts, the keys ctl-8j adds and retires', () => {
  it('ctl-8j FR-PINS: the 5 new plain keys and the 2 new parameterised keys carry their exact French text, each a translation of its English entry and each closure fed both English sample sets; the three retired ids are gone from both catalogs', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot, the whole Recruit
    // and Bag step blank); a French entry left as the English copy or swapped with a sibling (Oui /
    // Non); a closure that drops or swaps its param (the bait or the species); a question mark
    // glued to its word or set off by a plain breaking space instead of the catalog's U+00A0; a
    // decomposed or missing circumflex in "Appat"; and a retired id left behind as a dead key in
    // either catalog.
    for (const [key, expected] of Object.entries(EXPECTED_FR_CTL8J_PLAIN)) {
      const en = EXPECTED_PLAIN[key];
      expect(typeof en, `fixture: ${key} has an English pin`).toBe('string');
      const fr = (CATALOG_FR as Record<string, unknown>)[key];
      expect(typeof fr, `${key} must be a plain string in the fr catalog`).toBe('string');
      expect(fr, `${key}: the exact French text`).toBe(expected);
      expect(fr, `${key}: a translation, not the English copy`).not.toBe(en);
    }
    for (const [key, [outputA, outputB]] of Object.entries(EXPECTED_FR_CTL8J_PARAMS)) {
      const spec = EXPECTED_PARAM_OUTPUTS[key];
      expect(spec, `fixture: ${key} has English output pins`).toBeDefined();
      const fr = (CATALOG_FR as Record<string, unknown>)[key];
      expect(typeof fr, `${key} must be a closure in the fr catalog`).toBe('function');
      const fn = fr as (p: Record<string, unknown>) => string;
      expect(fn((spec as ParamOutputSpec).inputA), `${key}(sample A) in French`).toBe(outputA);
      expect(fn((spec as ParamOutputSpec).inputB), `${key}(sample B) in French`).toBe(outputB);
      expect(outputA, `${key}: a translation, not the English line`).not.toBe(
        (spec as ParamOutputSpec).outputA,
      );
    }
    expect(
      Object.keys(EXPECTED_FR_CTL8J_PLAIN).length + Object.keys(EXPECTED_FR_CTL8J_PARAMS).length,
      'ANTI-VACUITY: all 7 ctl-8j keys are pinned in French',
    ).toBe(7);

    for (const retired of [
      'battle.recruit.submit',
      'battle.cure.placeholder',
      'battle.cure.submit',
    ]) {
      expect(Object.hasOwn(CATALOG_EN as object, retired), `en ${retired} is retired`).toBe(false);
      expect(Object.hasOwn(CATALOG_FR as object, retired), `fr ${retired} is retired`).toBe(false);
    }
  });
});

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
      ['menu.options.controls.title', ['Commandes']],
      ['menu.options.controls.desc', ['Choisir la touche de chaque bouton.']],
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
      'raising.inventory.heading',
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
    expect(Object.keys(en).length, 'the English catalog holds exactly 425 keys').toBe(425);
    expect(Object.keys(fr).length, 'and so does the French one').toBe(425);
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
  it('the eleven ids that labelled the four views` mouse-only duplicate controls are gone from both catalogs and the pinned roster, while the views` surviving ids and the Social sheet`s answer rows stay, 425 keys each (bt-10, named intentional change, BT10.5/BT10.6: 365 → 425, +tactics.*) [QF8-1-CATALOG-RETIRED]', () => {
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
      // tradeView: the status line and the two side headings.
      'trade.status.none',
      'trade.side.offer',
      'trade.side.receive',
      // pvpView: the title and the two request labels the Social cursor marks.
      'pvp.title.challenge',
      'pvp.incoming.label',
      'pvp.outgoing.label',
      // evolutionView: the hint, the ready note and the path heading.
      'evolution.hint',
      'evolution.card.ready',
      'evolution.path.heading',
      // The Social sheet's rows: where Accept / Decline / Confirm / Cancel live now.
      'social.action.accept',
      'social.action.decline',
      'social.action.confirm',
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
    expect(Object.keys(en).length, 'the English catalog holds exactly 425 keys').toBe(425);
    expect(Object.keys(fr).length, 'and so does the French one').toBe(425);
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
    // ANTI-VACUITY: every value was read, each closure twice (the 362-key roster is pinned above).
    const expectedTexts =
      Object.keys(EXPECTED_PLAIN).length + 2 * Object.keys(SAMPLE_PARAMS).length;
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

/** The seven keys qf-10 revalues, with their exact English text. */
const QF10_EN: Record<string, string> = {
  'box.title': 'Monsters',
  'box.hint':
    'Only monsters in your Party can battle or be swapped in. New recruits arrive in Storage ' +
    `${EM_DASH} select one there and choose "Move" to bring it into an open party slot.`,
  'box.section.box': 'Storage',
  'box.box.empty': 'No monsters in storage.',
  'battle.swap.hint':
    'No healthy party monster in this battle to swap in. ' +
    'When this battle ends, press Esc, then B for Monsters.',
  'raising.title': 'Inventory',
  'battle.command.bag': 'Items',
};

/** U+00C0 (A grave) opens "À la fin du combat". */
const QF10_A_GRAVE_CAP = String.fromCharCode(0x00c0);

/** The seven keys qf-10 revalues, with their exact French text. The apostrophe is U+2019 and the
 *  quote is a guillemet pair with U+00A0 inside, as catalog.fr.ts documents; the dash is U+2014. */
const QF10_FR: Record<string, string> = {
  'box.title': 'Monstres',
  'box.hint':
    `Seuls les monstres de votre ${E_ACUTE}quipe peuvent combattre ou ${QF8_E_CIRCUMFLEX}tre ` +
    `${E_ACUTE}chang${E_ACUTE}s en cours de combat. Les nouvelles recrues arrivent dans le ` +
    `Stockage ${EM_DASH} s${E_ACUTE}lectionnez-en une et choisissez ` +
    `${QF8_LEFT_GUILLEMET}${NO_BREAK_SPACE}D${E_ACUTE}placer${NO_BREAK_SPACE}${QF8_RIGHT_GUILLEMET} ` +
    `pour la placer dans un emplacement libre de l${RIGHT_QUOTE}${E_ACUTE}quipe.`,
  'box.section.box': 'Stockage',
  'box.box.empty': 'Aucun monstre dans le stockage.',
  'battle.swap.hint':
    `Aucun monstre de l${RIGHT_QUOTE}${E_ACUTE}quipe en ${E_ACUTE}tat de combattre ne peut ` +
    `entrer dans ce combat. ${QF10_A_GRAVE_CAP} la fin du combat, appuyez sur Esc, puis sur B ` +
    'pour Monstres.',
  'raising.title': 'Inventaire',
  'battle.command.bag': 'Objets',
};

/** The six values that named the Box / Raising screens (the bag command is not among them). */
const QF10_NAMING_KEYS = [
  'box.title',
  'box.hint',
  'box.section.box',
  'box.box.empty',
  'battle.swap.hint',
  'raising.title',
] as const;

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
  it('the English catalog carries the seven qf-10 values exactly and the legacy Party & Box, Raising & Inventory and Box wording is gone from the naming values [QF10-4-EN-VALUES]', () => {
    // WRONG IMPL KILLED: a value left on the shipped 'Party & Box' / 'Raising & Inventory' /
    // 'Box' / 'No monsters in box.' / 'Bag'; the hint still saying 'arrive in your Box'; the swap
    // hint still pointing at 'Party & Box'; a reworded value (every byte is pinned); and a value
    // that keeps the legacy word in a new sentence (the absence scan reads whole words, so
    // 'Boxes' is not a false hit but 'a Box' is).
    const en = CATALOG_EN as Record<string, unknown>;
    for (const [key, expected] of Object.entries(QF10_EN)) {
      expect(en[key], `en ${key}: the exact qf-10 text`).toBe(expected);
    }
    expect(Object.keys(QF10_EN), 'ANTI-VACUITY: seven keys').toHaveLength(7);
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

  it('the French catalog carries the seven qf-10 values exactly and the legacy Equipe et boite, boite, Elevage and Sac wording is gone from the naming values [QF10-4-FR-VALUES]', () => {
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
    expect(Object.keys(QF10_FR), 'ANTI-VACUITY: seven keys').toHaveLength(7);
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
    // The bag command is French too, and is not the English word.
    expect(fr['battle.command.bag'], 'fr battle.command.bag is not the English copy').not.toBe(
      (CATALOG_EN as Record<string, unknown>)['battle.command.bag'],
    );
    // Every guillemet in the hint is padded by U+00A0, never a breaking space.
    const hint = String(fr['box.hint']);
    expect(hint.includes(`${QF8_LEFT_GUILLEMET} `), 'no breaking space after the opening «').toBe(
      false,
    );
    expect(hint.includes(` ${QF8_RIGHT_GUILLEMET}`), 'no breaking space before the closing »').toBe(
      false,
    );
  });

  it('the legacy ids keep their names in both catalogs and the roster is still the 425-key one (bt-10, named intentional change, BT10.5/BT10.6: 365 → 425, +tactics.*) [QF10-4-KEY-IDS-UNCHANGED]', () => {
    // WRONG IMPL KILLED: an id renamed to follow its new value (box.title -> monsters.title, ...)
    // so messageIds.ts and every t() call site would have to move too (the spec allows values
    // only); a retired legacy id (the Party heading, the Bag command); a roster that grew or
    // shrank (an id added beside the old one instead of revalued).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const LEGACY_IDS = [
      'box.title',
      'box.hint',
      'box.section.party',
      'box.section.box',
      'box.box.empty',
      'battle.swap.hint',
      'raising.title',
      'battle.command.bag',
    ] as const;
    expect(LEGACY_IDS, 'ANTI-VACUITY: eight ids').toHaveLength(8);
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
    expect(Object.keys(en).length, 'the English catalog holds exactly 425 keys').toBe(425);
    expect(Object.keys(fr).length, 'and so does the French one').toBe(425);
    expect(EXPECTED_KEYS, 'and the pinned roster').toHaveLength(425);
    expect(Object.keys(en).slice().sort(), 'en and the pinned roster are the same ids').toEqual(
      EXPECTED_KEYS,
    );
    // The Party heading is deliberately NOT revalued (the Party panel keeps its name).
    expect(en['box.section.party'], 'en box.section.party is untouched').toBe('Party');
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
    expect(en['menu.options.controls.title']).toBe('Controls');
    expect(fr['menu.options.controls.title']).toBe('Commandes');
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
// qf-17 (QF17.1, QF17.2): the KO-win payout lines in BOTH catalogs. The gold line carries the wallet
// delta, a bigint; the xp line carries a monster's display name (a nickname or a species name, model
// data, never catalogued) and its XP gain, a number. Every expected byte is typed here, the names
// are NON-shipped, and none is read off the catalog under test. The French xp line puts a U+00A0
// before its colon (catalog.fr.ts's documented typography), asserted by code point.
// =============================================================================

/** U+00A0 NO-BREAK SPACE, built by code point (never a pasted invisible character). */
const QF17_NBSP = String.fromCharCode(0x00a0);

describe('qf-17: the KO-win payout lines in both catalogs', () => {
  it('battle.rewards.gold is a closure in both catalogs: +N gold in English and +N or in French, the bigint amount echoed once and digit-for-digit, for differing amounts [QF17-1-CATALOG-GOLD]', () => {
    // WRONG IMPL KILLED: a key added to en only (tf() throws in a French boot: the gold line never
    // shows); a plain string where the amount must be interpolated; a French line left as the
    // English copy; a closure that drops or repeats the amount, or hard-codes one; an amount run
    // through Number() or a locale formatter (past 2^53 the last digit changes, and 1157 becomes
    // "1,157"); a sign dropped; the key missing from the pinned roster or the two sample tables.
    const KEY = 'battle.rewards.gold';
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    expect(Object.hasOwn(en, KEY), 'en carries the key').toBe(true);
    expect(Object.hasOwn(fr, KEY), 'fr carries the key').toBe(true);
    expect(typeof en[KEY], 'en is a closure').toBe('function');
    expect(typeof fr[KEY], 'fr is a closure').toBe('function');
    const enFn = en[KEY] as (p: { amount: bigint }) => string;
    const frFn = fr[KEY] as (p: { amount: bigint }) => string;

    type Case = readonly [bigint, string, string];
    const CASES: readonly Case[] = [
      [30n, '+30 gold', '+30 or'],
      [7n, '+7 gold', '+7 or'],
      [1157n, '+1157 gold', '+1157 or'],
      [9_007_199_254_740_993n, '+9007199254740993 gold', '+9007199254740993 or'],
    ];
    for (const [amount, enLine, frLine] of CASES) {
      expect(enFn({ amount }), `en, ${amount}`).toBe(enLine);
      expect(frFn({ amount }), `fr, ${amount}`).toBe(frLine);
      expect(frFn({ amount }), `${amount}: a translation, not the English line`).not.toBe(
        enFn({ amount }),
      );
      expect(enFn({ amount }).split(String(amount)).length - 1, `en carries ${amount} once`).toBe(
        1,
      );
      expect(frFn({ amount }).split(String(amount)).length - 1, `fr carries ${amount} once`).toBe(
        1,
      );
    }
    expect(CASES, 'ANTI-VACUITY: four amounts').toHaveLength(4);
    expect(enFn({ amount: 30n }), 'the amounts change the line (en)').not.toBe(
      enFn({ amount: 7n }),
    );
    expect(frFn({ amount: 30n }), 'the amounts change the line (fr)').not.toBe(
      frFn({ amount: 7n }),
    );

    // The key is in the pinned roster and in both sample tables, so CAT-01's bijection and
    // exact-output checks cover it.
    expect(EXPECTED_KEYS.includes(KEY), 'the pinned roster lists the key').toBe(true);
    expect(SAMPLE_PARAMS[KEY], 'the two sample sets').toEqual([{ amount: 30n }, { amount: 7n }]);
    const spec = EXPECTED_PARAM_OUTPUTS[KEY] as ParamOutputSpec;
    expect(spec, 'the English output pins exist').toBeDefined();
    expect(spec.outputA).toBe('+30 gold');
    expect(spec.outputB).toBe('+7 gold');
  });

  it('battle.rewards.xp is a closure in both catalogs: Name +N XP in English and Name, a no-break space, a colon, +N XP in French, the name echoed once and verbatim, for differing names and amounts [QF17-2-CATALOG-XP]', () => {
    // WRONG IMPL KILLED: a key added to en only (tf() throws in a French boot: the xp line never
    // shows); a French line left as the English copy; the French colon preceded by a breaking space
    // or by nothing (a browser can strand the colon on the next line; catalog.fr.ts spaces every
    // colon with U+00A0); a closure that swaps, drops or repeats a param; a name run through a
    // transform (case, trim, escaping: `<b>x</b>` must stay as typed); an amount run through a
    // locale formatter (1000000 becomes "1,000,000"); the key missing from the pinned roster or the
    // two sample tables.
    const KEY = 'battle.rewards.xp';
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    expect(Object.hasOwn(en, KEY), 'en carries the key').toBe(true);
    expect(Object.hasOwn(fr, KEY), 'fr carries the key').toBe(true);
    expect(typeof en[KEY], 'en is a closure').toBe('function');
    expect(typeof fr[KEY], 'fr is a closure').toBe('function');
    type Params = { name: string; amount: number };
    const enFn = en[KEY] as (p: Params) => string;
    const frFn = fr[KEY] as (p: Params) => string;

    type Case = readonly [Params, string, string];
    const SPARKY: Case = [
      { name: 'Sparky', amount: 12 },
      'Sparky +12 XP',
      `Sparky${QF17_NBSP}: +12 XP`,
    ];
    const BOLT: Case = [{ name: 'Bolt', amount: 3 }, 'Bolt +3 XP', `Bolt${QF17_NBSP}: +3 XP`];
    const MARKUP: Case = [
      { name: '<b>x</b>', amount: 1_000_000 },
      '<b>x</b> +1000000 XP',
      `<b>x</b>${QF17_NBSP}: +1000000 XP`,
    ];
    const CASES: readonly Case[] = [SPARKY, BOLT, MARKUP];
    for (const [params, enLine, frLine] of CASES) {
      expect(enFn(params), `en, ${params.name}`).toBe(enLine);
      expect(frFn(params), `fr, ${params.name}`).toBe(frLine);
      expect(frFn(params), `${params.name}: a translation, not the English line`).not.toBe(
        enFn(params),
      );
      expect(enFn(params).split(params.name).length - 1, `en carries ${params.name} once`).toBe(1);
      expect(frFn(params).split(params.name).length - 1, `fr carries ${params.name} once`).toBe(1);
      expect(
        enFn(params).split(String(params.amount)).length - 1,
        `en carries ${params.amount} once`,
      ).toBe(1);
      expect(
        frFn(params).split(String(params.amount)).length - 1,
        `fr carries ${params.amount} once`,
      ).toBe(1);

      // The space before the French colon is U+00A0 and nothing else, by code point.
      const frText = frFn(params);
      const at = params.name.length;
      expect(frText.charCodeAt(at), `fr ${params.name}: the space before the colon`).toBe(0x00a0);
      expect(frText.charAt(at + 1), `fr ${params.name}: then the colon`).toBe(':');
      expect(frText.includes(`${params.name} :`), 'no breaking space before the colon').toBe(false);
    }
    expect(CASES, 'ANTI-VACUITY: three names').toHaveLength(3);
    expect(enFn(SPARKY[0]), 'the params change the line (en)').not.toBe(enFn(BOLT[0]));
    expect(frFn(SPARKY[0]), 'the params change the line (fr)').not.toBe(frFn(BOLT[0]));

    // The key is in the pinned roster and in both sample tables (the two sample sets are Sparky and
    // Bolt), so CAT-01's bijection and exact-output checks cover it.
    expect(EXPECTED_KEYS.includes(KEY), 'the pinned roster lists the key').toBe(true);
    expect(SAMPLE_PARAMS[KEY], 'the two sample sets').toEqual([SPARKY[0], BOLT[0]]);
    const spec = EXPECTED_PARAM_OUTPUTS[KEY] as ParamOutputSpec;
    expect(spec, 'the English output pins exist').toBeDefined();
    expect(spec.outputA).toBe(SPARKY[1]);
    expect(spec.outputB).toBe(BOLT[1]);
  });
});
