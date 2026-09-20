// ui/i18n/catalog.test.ts — m24-s1 RED gating tests for the English catalog: the `// @desc:`
// adjacency scan, the key grammar, catalog-wide shape invariants, and the oneOther-misuse
// proof-of-teeth (SHAPE-01, SHAPE-02, SHAPE-03, SHAPE-06).
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M24-internationalization.spec.md §2.3, §2.6 [I18N-SHAPE-06].
//   docs/adr/0256-i18n-module-total-catalog-resolver-cell-negative-compile.md D2, D5.
//   memory/projects/monster-realm-m24-s1-plan.md §2 catalog.en.ts, §9 M9/L11/L12/L13.
//
// RED REASON: `client/src/ui/i18n/catalog.en.ts` DOES NOT EXIST YET. The static import below
// fails to resolve at collection, redding every test in this file until the specialist ships it.
//
// KEY-GRAMMAR DEVIATION (ADR-0256 D5, plan §1): segments `[a-z][a-zA-Z0-9]*`, at least two,
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
// The comment stripper is IMPORTED, never copied (ADR-0215 single-owner rule). Precedent for a
// `.ts` test importing a `.mjs` eval: client/src/ui/i18n-no-html-sink.test.ts:45 (one `..`
// shallower — this file sits one directory deeper, under `ui/i18n/`).
import { stripComments } from '../../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { CATALOG_EN } from './catalog.en';

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
// m24s3 (ADR-0259) — sample params + expected literals, transcribed from the
// PRE-MIGRATION battleView.ts/pvpView.ts source (plan R7: this transcription is
// independent of the specialist's later catalog.en.ts authoring, since it is
// written before catalog.en.ts grows past its m24-s1 chrome.* seed).
//
// PREDICTED RED REASON: none of the m24s3 keys exist in CATALOG_EN yet, so every
// lookup below (`(CATALOG_EN as Record<string, unknown>)[key]`) is `undefined`,
// and the CAT-01/CAT-02 assertions fail on their first `typeof` check.
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
  'battle.skill.pvpSubmit': [
    { name: 'Vine Lash', affinity: 'Plant' },
    { name: 'Ember Jab', affinity: 'Fire' },
  ],
  'battle.skill.pveLabel': [
    { name: 'Vine Lash', power: 40, affinity: 'Plant' },
    { name: 'Ember Jab', power: 35, affinity: 'Fire' },
  ],
  'battle.skill.accuracy': [{ accuracy: 95 }, { accuracy: 90 }],
  'battle.cure.option': [
    { name: 'Tonic', cureStatus: 'Poison', count: 1 },
    { name: 'Salve', cureStatus: 'Paralysis', count: 3 },
  ],
  'battle.swap.pvpSubmit': [{ species: 'Mosshorn' }, { species: 'Cindertail' }],
  'battle.swap.pveLabel': [
    { species: 'Mosshorn', current: 6, max: 10 },
    { species: 'Cindertail', current: 15, max: 20 },
  ],
  'pvp.incoming.label': [{ challenger: 'Bob' }, { challenger: 'Dana' }],
  'pvp.outgoing.label': [{ target: 'Alice' }, { target: 'Elliot' }],
  // m24s4 (ADR-0260) — evolution.* (6 ★)
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
  'evolution.choice.evolve': [{ species: 'Pyrodrake' }, { species: 'Cindermaw' }],
  // m24s4 — raising.* (4 ★)
  'raising.card.status': [
    { level: 5, trust: 'Neutral', current: 20, max: 20 },
    { level: 12, trust: 'Friendly', current: 15, max: 30 },
  ],
  'raising.card.stats': [
    { attack: 5, defense: 5, speed: 5, spAttack: 5, spDefense: 5 },
    { attack: 22, defense: 18, speed: 27, spAttack: 15, spDefense: 19 },
  ],
  'raising.card.train': [
    { name: 'Protein', count: 2 },
    { name: 'Iron', count: 5 },
  ],
  'raising.inventory.item': [
    { name: 'Protein', count: 2 },
    { name: 'Iron', count: 5 },
  ],
  // m24s4 — box.* (2 ★)
  'box.party.emptySlot': [{ slot: 0 }, { slot: 3 }],
  'box.card.stats': [
    { species: 'Sproutle', level: 5, current: 18, max: 20, percent: 90 },
    { species: 'Emberfang', level: 9, current: 21, max: 21, percent: 100 },
  ],
  // m24s4 — trade.* (2 ★, side.currency.amount is bigint)
  'trade.side.card': [
    { nickname: 'Sproutle', species: 'Mossback', level: 7, current: 3, max: 9 },
    { nickname: 'Kip', species: 'Duskling', level: 12, current: 20, max: 40 },
  ],
  'trade.side.currency': [{ amount: 250n }, { amount: 1000n }],
  // m24s4 — shop.* (3 ★, row prices are bigint)
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
};

/** Every PLAIN (non-parameterised) MessageId's expected value, byte-transcribed
 *  from the pre-migration literal at its cited source line (plan R7 — copy-paste
 *  never retype). The 9 `chrome.*` rows are the pre-existing m24-s1 values; the
 *  21 `battle.*`/`pvp.*` rows are m24s3's plain migrated sinks. */
const EXPECTED_PLAIN: Record<string, string> = {
  'chrome.helpHint': 'Press ? for help · click or M for menu',
  'chrome.help.title': 'Controls & Goals',
  'chrome.rename.submit': 'Rename',
  'chrome.tradePropose.submit': 'Offer',
  'chrome.status.exportBlocked': 'data export: download blocked by the browser',
  'chrome.status.privacyOverlayBusy': 'privacy: close the other overlay first',
  'chrome.status.contentStale': 'content out of date — reload',
  'chrome.status.bugBundleBlocked': 'bug bundle: download blocked — copy from console',
  'chrome.status.healUnavailable': 'heal: no heal location available',
  'battle.title': 'Battle', // battleView.ts:110
  'battle.continueHint': 'Press Esc to continue', // battleView.ts:243
  'battle.swap.hint':
    'No healthy party monster in this battle to swap in. ' +
    'When this battle ends, press Esc, then B for Party & Box.', // battleView.ts:216-218
  'battle.pvp.waiting': 'Waiting for opponent’s action…', // battleView.ts:347
  'battle.card.you': 'You', // battleView.ts:291
  'battle.card.opponent': 'Opponent', // battleView.ts:289
  'battle.action.flee': 'Flee', // battleView.ts:470
  'battle.recruit.noBait': 'No bait', // battleView.ts:522
  'battle.recruit.submit': 'Recruit', // battleView.ts:541
  'battle.cure.placeholder': 'Select item', // battleView.ts:562
  'battle.cure.submit': 'Use Item', // battleView.ts:580
  'battle.outcome.victory': 'Victory!', // battleView.ts:629
  'battle.outcome.defeat': 'Defeat...', // battleView.ts:632
  'battle.outcome.fled': 'Got away safely!', // battleView.ts:635
  'pvp.title.idle': 'PvP', // pvpView.ts:135
  'pvp.title.challenge': 'PvP Challenge', // pvpView.ts:142
  'pvp.incoming.accept': 'Accept', // pvpView.ts:198
  'pvp.incoming.decline': 'Decline', // pvpView.ts:206
  'pvp.outgoing.cancel': 'Cancel Challenge', // pvpView.ts:226
  'pvp.players.none': 'No players online to challenge', // pvpView.ts:241
  'pvp.players.heading': 'Challenge:', // pvpView.ts:241
  // m24s4 (ADR-0260) — evolution.* (6 plain)
  'evolution.title': 'Evolution', // evolutionView.ts
  'evolution.hint':
    'Each path lists what it needs and how close this monster is. When two or more ' +
    'paths are ready at once, you choose which one to take.', // evolutionView.ts
  'evolution.monsters.empty': 'No monsters yet.', // evolutionView.ts
  'evolution.card.noPaths': 'No evolution paths.', // evolutionView.ts
  'evolution.card.choosePrompt': 'Two or more paths are ready — pick one:', // evolutionView.ts
  'evolution.path.allMet': 'All requirements met.', // evolutionView.ts
  // m24s4 — raising.* (6 plain)
  'raising.title': 'Raising & Inventory', // raisingView.ts
  'raising.monsters.heading': 'Monsters', // raisingView.ts
  'raising.inventory.heading': 'Inventory', // raisingView.ts
  'raising.monsters.empty': 'No monsters.', // raisingView.ts
  'raising.inventory.empty': 'No items.', // raisingView.ts
  'raising.card.care': 'Care', // raisingView.ts
  // m24s4 — box.* (11 plain)
  'box.title': 'Party & Box', // boxView.ts
  'box.heal': 'Heal Party', // boxView.ts
  'box.hint':
    'Only monsters in your Party can battle or be swapped in. New recruits arrive in your ' +
    'Box — each box monster has a "To Party" button that moves it into an open party slot.', // boxView.ts
  'box.section.party': 'Party', // boxView.ts
  'box.section.box': 'Box', // boxView.ts
  'box.box.empty': 'No monsters in box.', // boxView.ts
  'box.card.rename': 'Rename', // boxView.ts
  'box.card.evolveBadge': '★ Ready to evolve — choose a path', // boxView.ts
  'box.card.toBox': 'To Box', // boxView.ts
  'box.card.toParty': 'To Party', // boxView.ts
  'box.rename.prompt': 'New nickname:', // boxView.ts (hoisted, prompt() argument)
  // m24s4 — trade.* (8 plain)
  'trade.status.none': 'No active trade', // tradeView.ts
  'trade.side.offer': 'You offer', // tradeView.ts (hoisted, #renderSide heading arg)
  'trade.side.receive': 'You receive', // tradeView.ts (hoisted, #renderSide heading arg)
  'trade.side.nothing': '(nothing)', // tradeView.ts
  'trade.action.accept': 'Accept', // tradeView.ts (hoisted, #actionLabel)
  'trade.action.reject': 'Reject', // tradeView.ts (hoisted, #actionLabel)
  'trade.action.confirm': 'Confirm Trade', // tradeView.ts (hoisted, #actionLabel)
  'trade.action.cancel': 'Cancel', // tradeView.ts (hoisted, #actionLabel)
  // m24s4 — shop.* (6 plain)
  'shop.title': 'Shop', // shopView.ts
  'shop.noShop': 'No shop available.', // shopView.ts
  'shop.forSale.empty': 'Nothing for sale.', // shopView.ts
  'shop.inventory.empty': 'No items to sell.', // shopView.ts
  'shop.buy.submit': 'Buy', // shopView.ts
  'shop.sell.submit': 'Sell', // shopView.ts
};

interface ParamOutputSpec {
  readonly inputA: Record<string, unknown>;
  readonly outputA: string;
  readonly inputB: Record<string, unknown>;
  readonly outputB: string;
}

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
  'battle.skill.pvpSubmit': {
    inputA: { name: 'Vine Lash', affinity: 'Plant' },
    outputA: 'Submit: Vine Lash · Plant',
    inputB: { name: 'Ember Jab', affinity: 'Fire' },
    outputB: 'Submit: Ember Jab · Fire',
  },
  'battle.skill.pveLabel': {
    inputA: { name: 'Vine Lash', power: 40, affinity: 'Plant' },
    outputA: 'Vine Lash (40) · Plant',
    inputB: { name: 'Ember Jab', power: 35, affinity: 'Fire' },
    outputB: 'Ember Jab (35) · Fire',
  },
  'battle.skill.accuracy': {
    inputA: { accuracy: 95 },
    outputA: 'Acc 95%',
    inputB: { accuracy: 90 },
    outputB: 'Acc 90%',
  },
  'battle.cure.option': {
    inputA: { name: 'Tonic', cureStatus: 'Poison', count: 1 },
    outputA: 'Tonic (cures Poison) ×1',
    inputB: { name: 'Salve', cureStatus: 'Paralysis', count: 3 },
    outputB: 'Salve (cures Paralysis) ×3',
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
  // m24s4 (ADR-0260) — evolution.* (6 ★)
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
  'evolution.choice.evolve': {
    inputA: { species: 'Pyrodrake' },
    outputA: 'Evolve into Pyrodrake',
    inputB: { species: 'Cindermaw' },
    outputB: 'Evolve into Cindermaw',
  },
  // m24s4 — raising.* (4 ★)
  'raising.card.status': {
    inputA: { level: 5, trust: 'Neutral', current: 20, max: 20 },
    outputA: 'Lv5 · Trust Neutral · HP 20/20',
    inputB: { level: 12, trust: 'Friendly', current: 15, max: 30 },
    outputB: 'Lv12 · Trust Friendly · HP 15/30',
  },
  'raising.card.stats': {
    inputA: { attack: 5, defense: 5, speed: 5, spAttack: 5, spDefense: 5 },
    outputA: 'ATK 5 · DEF 5 · SPD 5 · SP.ATK 5 · SP.DEF 5',
    inputB: { attack: 22, defense: 18, speed: 27, spAttack: 15, spDefense: 19 },
    outputB: 'ATK 22 · DEF 18 · SPD 27 · SP.ATK 15 · SP.DEF 19',
  },
  'raising.card.train': {
    inputA: { name: 'Protein', count: 2 },
    outputA: 'Train: Protein (x2)',
    inputB: { name: 'Iron', count: 5 },
    outputB: 'Train: Iron (x5)',
  },
  'raising.inventory.item': {
    inputA: { name: 'Protein', count: 2 },
    outputA: 'Protein (x2)',
    inputB: { name: 'Iron', count: 5 },
    outputB: 'Iron (x5)',
  },
  // m24s4 — box.* (2 ★)
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
  // m24s4 — trade.* (2 ★)
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
  // m24s4 — shop.* (3 ★, trailing space pinned exactly)
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
};

/** The full 96-key roster (m24s4 growth of the m24s3 42-key roster, itself grown from the
 *  m24-s1 10-key `chrome.*` seed), sorted — `EXPECTED_PLAIN` and `SAMPLE_PARAMS` are disjoint
 *  by construction (plain vs. parameterised), so their key union is exactly the roster. */
const EXPECTED_KEYS = Object.keys(EXPECTED_PLAIN).concat(Object.keys(SAMPLE_PARAMS)).sort();

describe('catalog.en — the English catalog: @desc adjacency, key grammar, and shape invariants (m24-s1, ADR-0256)', () => {
  it('m24s1 SHAPE-01: every catalog.en.ts entry line has an immediately-adjacent `// @desc:` comment with >=10 non-whitespace characters', () => {
    const violations = findDescViolations(RAW_SOURCE);
    expect(
      violations,
      `entries missing an adjacent @desc comment (>=10 non-ws chars): ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it("m24s1 SHAPE-02: CATALOG_EN['chrome.helpHint'] is <=47 characters, and is exactly 38 today", () => {
    const value = (CATALOG_EN as Record<string, unknown>)['chrome.helpHint'];
    expect(typeof value, "CATALOG_EN['chrome.helpHint'] must be a string").toBe('string');
    expect((value as string).length).toBeLessThanOrEqual(47);
    expect((value as string).length).toBe(38);
  });

  it('m24s1 SHAPE-03: the ADR-0256 D5 key grammar (>=2 dot-segments, each [a-z][a-zA-Z0-9]*) accepts the boundary-valid fixtures, rejects the boundary-invalid fixtures, and accepts every real CATALOG_EN key', () => {
    const validFixtures = ['a.b', 'chrome.helpHint', 'chrome.status.disconnected'];
    const invalidFixtures = [
      'chrome',
      'chrome.',
      '.chrome',
      'chrome..status',
      'Battle.HPLine',
      'chrome.help_hint',
      'chrome.1x',
      'chrome.help-hint',
      'chrome.helpHint ',
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

  it('m24s1 CATALOG-SHAPE: CATALOG_EN is frozen, its source entry-line count matches Object.keys, no own prototype-name keys, every value resolves to a non-empty string, the key roster is exactly the m24s4 96-key roster, and the source spells `satisfies Catalog` + `Object.freeze(` exactly once each', () => {
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

    // Belt-and-braces TEXT pin (test-review round), scoped to this OWNED file: `satisfies
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
// m24s3 (ADR-0259) — the 42-key roster, the SAMPLE_PARAMS bijection, and the
// byte-identical pinned values (both sample sets) for every m24s3 migrated key.
//
// PREDICTED RED REASON AT HEAD: catalog.en.ts carries only the 10 m24-s1 chrome.*
// keys — every one of the 32 new lookups below reads `undefined` off CATALOG_EN,
// so CAT-01 fails on its very first `typeof value` check (or the roster-length
// check, whichever runs first) and CAT-02 fails calling `undefined` as a function.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the
// plan/ADR-0259 only.
// =============================================================================
describe('m24s3 (ADR-0259): catalog.en.ts — 42-key roster, SAMPLE_PARAMS bijection, byte-identical migrated values', () => {
  it('m24s3 CAT-01: the roster is exactly 96 keys, SAMPLE_PARAMS is a bijection with the function-valued keys, every plain/param value is byte-identical to the pre-migration source (both sample sets), and the two glyph pins hold', () => {
    const keys = Object.keys(CATALOG_EN as Record<string, unknown>);

    // (a) roster is exactly the 96 keys.
    expect(keys.slice().sort()).toEqual(EXPECTED_KEYS);

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
