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
  // Evolution.* (6 ★)
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
  // Raising.* (4 ★)
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
  // Box.* (2 ★)
  'box.party.emptySlot': [{ slot: 0 }, { slot: 3 }],
  'box.card.stats': [
    { species: 'Sproutle', level: 5, current: 18, max: 20, percent: 90 },
    { species: 'Emberfang', level: 9, current: 21, max: 21, percent: 100 },
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
};

/** ctl-8a's description "none" mark: U+2014 EM DASH, built by code point (never a pasted glyph). */
const EM_DASH = String.fromCharCode(0x2014);

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
  'chrome.chip.menu': 'Menu',
  'chrome.chip.help': 'Help',
  'chrome.help.title': 'Controls & Goals',
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
  // Evolution.* (6 plain)
  'evolution.title': 'Evolution', // evolutionView.ts
  'evolution.hint':
    'Each path lists what it needs and how close this monster is. When two or more ' +
    'paths are ready at once, you choose which one to take.', // evolutionView.ts
  'evolution.monsters.empty': 'No monsters yet.', // evolutionView.ts
  'evolution.card.noPaths': 'No evolution paths.', // evolutionView.ts
  'evolution.card.choosePrompt': 'Two or more paths are ready — pick one:', // evolutionView.ts
  'evolution.path.allMet': 'All requirements met.', // evolutionView.ts
  // Raising.* (6 plain)
  'raising.title': 'Raising & Inventory', // raisingView.ts
  'raising.monsters.heading': 'Monsters', // raisingView.ts
  'raising.inventory.heading': 'Inventory', // raisingView.ts
  'raising.monsters.empty': 'No monsters.', // raisingView.ts
  'raising.inventory.empty': 'No items.', // raisingView.ts
  'raising.card.care': 'Care', // raisingView.ts
  // Box.* (11 plain)
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
  // Trade.* (8 plain)
  'trade.status.none': 'No active trade', // tradeView.ts
  'trade.side.offer': 'You offer', // tradeView.ts (hoisted, #renderSide heading arg)
  'trade.side.receive': 'You receive', // tradeView.ts (hoisted, #renderSide heading arg)
  'trade.side.nothing': '(nothing)', // tradeView.ts
  'trade.action.accept': 'Accept', // tradeView.ts (hoisted, #actionLabel)
  'trade.action.reject': 'Reject', // tradeView.ts (hoisted, #actionLabel)
  'trade.action.confirm': 'Confirm Trade', // tradeView.ts (hoisted, #actionLabel)
  'trade.action.cancel': 'Cancel', // tradeView.ts (hoisted, #actionLabel)
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
  'errorOverlay.footer': 'F8 dismiss · F9 bug report', // errorOverlayView.ts (resolved in show())
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
  'menu.social.challenges.desc': 'Challenge a player or answer a challenge.',
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
  // Evolution.* (6 ★)
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
  // Raising.* (4 ★)
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
};

/** The full 224-key roster (ctl-8a: +`shop.tab.buy` +`shop.tab.sell` +`shop.description.none`
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

  it('m24s1 CATALOG-SHAPE: CATALOG_EN is frozen, its source entry-line count matches Object.keys, no own prototype-name keys, every value resolves to a non-empty string, the key roster is exactly the ctl-8a 224-key roster, and the source spells `satisfies Catalog` + `Object.freeze(` exactly once each', () => {
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
  it('m24s3/21r-b/21r-b2 CAT-01 [21R-B2-ROSTER-178]: the roster is exactly 224 keys, SAMPLE_PARAMS is a bijection with the function-valued keys, every plain/param value is byte-identical to the pre-migration source (both sample sets), and the two glyph pins hold', () => {
    const keys = Object.keys(CATALOG_EN as Record<string, unknown>);

    // (a) roster is exactly the EXPECTED_KEYS roster (224 keys since ctl-8a).
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
