// tactics/strings.test.ts — bt-10 RED tests for the tactical client's text discipline (BT10.6,
// REV 2 A6): every string the tactical UI shows comes from the typed catalog through
// `tactics/strings.ts` (the ONE resolver importer), in both English and French; and no other
// tactics module can smuggle in a hard-coded text sink, an HTML sink, a live region or a Web
// Animations call.
//
// SOURCE OF TRUTH: spec `### bt-10` BT10.6 ("every string from the typed catalog (en+fr)") and the
// plan's i18n key table + A4 (four status keys replace `tactics.ticker.status`) + A6 + A8
// (`tactics.banner.turn`) + A12 (no live region). The exact English bytes are pinned in
// ui/i18n/catalog.test.ts; THIS file pins the roster (60 keys), each key's parameter set, the French
// side, the `@desc` of each key, and the source scans.
//
// RED REASON: CATALOG_EN / CATALOG_FR carry no `tactics.*` key yet and strings.ts is an empty module,
// so the roster / French / strings.ts tests fail. The two scan tests are GUARDS (they pass over the
// stubs and bite the moment an implementation writes a forbidden sink); BT10-6-SCAN-TEETH proves each
// needle fires on a planted fixture.
//
// bt-11 ROUND 3 (increment B, plan REV 5 A39): the roster grows 60 → 88 (+26 plain, +2
// parameterised — the command menu, its reasons, the queue label, the Too-late notice, the ghost
// and the dock buttons). BT11-1-STRINGS-ROSTER pins the exact 88; BT10-6-STRINGS-ROSTER keeps
// bt-10's own 60 (named intentional change: it no longer pins "exactly"); the FR and RESOLVER tests
// follow the grown roster. RED REASON (round 3): the 28 keys are absent from both catalogs and from
// messageIds.ts / strings.ts.
//
// bt-11 ROUND 4 (increment C, plan REV 6 R6.7 / REV 5 A39): the roster grows 88 → 114 (+12 plain,
// +14 parameterised — the strip's badges, AP pips and `only N held` note, the forecast panel's
// lines, the Projected style's label / assumption / enemies-hold lines). BT11-1-STRINGS-ROSTER pins
// the exact 114 (named intentional change: was 88); the FR and RESOLVER tests follow the grown
// roster. RED REASON (round 4): the 26 keys are absent from both catalogs, messageIds.ts and
// strings.ts.
//
// bt-12 (increment A, plan REV 2 A5 + REV 2b B8): the roster grows 114 → 132 (+14 plain, +4
// parameterised — the deploy panel and the results panel; the results TITLE reuses the shipped
// `battle.outcome.*` keys, so no `results.won/lost/fled` key exists). NAMED INTENTIONAL CHANGE:
// BT11-1-STRINGS-ROSTER pins the exact 132 (was 114; plain 69 → 83, parameterised 45 → 49) and the FR
// and RESOLVER tests follow the grown roster. BT12-6-STRINGS-ROSTER reads NO file text: it calls the
// 18 new strings.ts functions (plus `resultsTitle`) under English and French. RED REASON (bt-12): the
// 18 keys are absent from both catalogs, messageIds.ts and strings.ts.
//
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stripComments } from '../../test-util/stripComments';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import { CATALOG_FR } from '../ui/i18n/catalog.fr';
import { setLocale } from '../ui/i18n/resolver';
import * as s from './strings';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.resolve(HERE, '..', 'ui', 'i18n');
/** U+2014, by code point (never a pasted or escaped glyph). */
const EM_DASH = String.fromCharCode(0x2014);
/** A template-literal hole spelled without a dollar-brace in the test's own source text. */
const hole = (inner: string): string => `$${'{'}${inner}}`;

const EN = CATALOG_EN as unknown as Record<string, unknown>;
const FR = CATALOG_FR as unknown as Record<string, unknown>;

/** The 31 plain `tactics.*` keys bt-10 added. */
const BT10_PLAIN_KEYS: readonly string[] = [
  'tactics.board.label',
  'tactics.dock.label',
  'tactics.ticker.label',
  'tactics.turnbar.label',
  'tactics.turnbar.locked',
  'tactics.turnbar.surgeActive',
  'tactics.hud.guard',
  'tactics.hud.firstStand',
  'tactics.stance.aggressive',
  'tactics.stance.territorial',
  'tactics.stance.skittish',
  'tactics.status.poison',
  'tactics.status.burn',
  'tactics.status.paralysis',
  'tactics.status.sleep',
  'tactics.status.freeze',
  'tactics.intent.attack',
  'tactics.intent.move',
  'tactics.intent.hold',
  'tactics.halt.targetGone',
  'tactics.halt.outOfReach',
  'tactics.halt.cannotAct',
  'tactics.halt.itemNotHeld',
  'tactics.halt.unaffordable',
  'tactics.halt.partyFull',
  'tactics.halt.notAllowed',
  'tactics.ticker.battleStarted',
  'tactics.ticker.won',
  'tactics.ticker.lost',
  'tactics.ticker.fled',
  'tactics.ticker.battleEnded',
];

/** The 29 parameterised `tactics.*` keys bt-10 added and the exact fields each closure reads. */
const BT10_PARAM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'tactics.turnbar.round': ['round'],
  'tactics.turnbar.surgeIn': ['n'],
  'tactics.turnbar.retreatAt': ['round'],
  'tactics.hud.level': ['level'],
  'tactics.hud.hp': ['hp', 'max'],
  'tactics.hud.ap': ['ap', 'max'],
  'tactics.hud.role': ['role'],
  'tactics.ticker.executed': ['unit', 'skill'],
  'tactics.ticker.hit': ['target', 'damage'],
  'tactics.ticker.missed': ['unit', 'target'],
  'tactics.ticker.halted': ['unit', 'reason'],
  'tactics.ticker.voided': ['unit'],
  'tactics.ticker.autoPass': ['unit', 'strike'],
  'tactics.ticker.stoodGround': ['unit'],
  'tactics.ticker.statusApplied': ['unit', 'status'],
  'tactics.ticker.statusTick': ['unit', 'status', 'amount'],
  'tactics.ticker.statusCured': ['unit', 'status'],
  'tactics.ticker.statusBlocked': ['unit', 'status'],
  'tactics.ticker.surge': ['unit', 'amount'],
  'tactics.ticker.ko': ['unit'],
  'tactics.ticker.recruitOk': ['target'],
  'tactics.ticker.recruitFail': ['target', 'pct'],
  'tactics.ticker.awards': ['unit', 'xp', 'essence', 'currency'],
  'tactics.ticker.moved': ['unit', 'tiles'],
  'tactics.ticker.itemUsed': ['unit', 'item', 'target'],
  'tactics.ticker.turnEnded': ['unit'],
  'tactics.ticker.guarded': ['unit'],
  'tactics.ticker.roundEnded': ['round'],
  'tactics.banner.turn': ['unit'],
};

/** bt-11 increment B (plan REV 5 A39): the command menu, its reasons, the queue strip label, the
 *  Too-late notice, the ghost and the three dock buttons — 26 plain keys. */
const BT11_PLAIN_KEYS: readonly string[] = [
  'tactics.menu.label',
  'tactics.menu.move',
  'tactics.menu.skills',
  'tactics.menu.item',
  'tactics.menu.recruit',
  'tactics.menu.flee',
  'tactics.menu.endTurn',
  'tactics.menu.guard',
  'tactics.menu.submit',
  'tactics.menu.clearPlan',
  'tactics.menu.clearYes',
  'tactics.menu.clearNo',
  'tactics.menu.noBait',
  'tactics.reason.outOfRange',
  'tactics.reason.partyFull',
  'tactics.reason.unaffordable',
  'tactics.reason.strideCap',
  'tactics.reason.notAvailable',
  'tactics.reason.planComplete',
  'tactics.reason.boxedIn',
  'tactics.queue.label',
  'tactics.queue.tooLate',
  'tactics.ghost.label',
  'tactics.dock.danger',
  'tactics.dock.prevUnit',
  'tactics.dock.nextUnit',
];

/** bt-11 increment B: the two full-budget reasons, each reading the fresh budget's `{ap}`. */
const BT11_PARAM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'tactics.reason.recruitFullAp': ['ap'],
  'tactics.reason.fleeFullAp': ['ap'],
};

/** bt-11 increment C (plan REV 6 R6.7): the strip's three badge words, the forecast panel's plain
 *  lines and the Projected style's label and enemies-hold line — 12 plain keys. */
const BT11C_PLAIN_KEYS: readonly string[] = [
  'tactics.badge.firm',
  'tactics.badge.provisional',
  'tactics.badge.stale',
  'tactics.forecast.label',
  'tactics.forecast.miss',
  'tactics.forecast.typeImmune',
  'tactics.forecast.stab',
  'tactics.forecast.lethal',
  'tactics.forecast.lethalMax',
  'tactics.forecast.firstStand',
  'tactics.projected.label',
  'tactics.projected.enemiesHold',
];

/** bt-11 increment C: the 14 parameterised keys and the exact fields each closure reads (R6.7:
 *  unit / item / status / tile are strings, every other field a number). */
const BT11C_PARAM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'tactics.badge.onlyHeld': ['n'],
  'tactics.chip.cost': ['ap'],
  'tactics.forecast.vs': ['unit'],
  'tactics.forecast.hit': ['pct'],
  'tactics.forecast.damage': ['min', 'max'],
  'tactics.forecast.typeTimes': ['num'],
  'tactics.forecast.typeOver': ['num', 'den'],
  'tactics.forecast.flank': ['num', 'den'],
  'tactics.forecast.guard': ['num', 'den'],
  'tactics.forecast.status': ['status'],
  'tactics.forecast.recruit': ['pct'],
  'tactics.forecast.recruitLines': ['base', 'bait', 'weakened', 'pct'],
  'tactics.forecast.bait': ['item'],
  'tactics.projected.assumes': ['unit', 'tile'],
};

/** bt-12 (plan REV 2b B8): the deploy panel's title, formation label, empty slot, the Deploy / Edit
 *  formation rows, the sending line, the editor's candidate group and its prev / next buttons, its
 *  Confirm / Back rows, and the results panel's list label, empty line and Continue button — 14 plain
 *  keys. */
const BT12_PLAIN_KEYS: readonly string[] = [
  'tactics.deploy.title',
  'tactics.deploy.label',
  'tactics.deploy.empty',
  'tactics.deploy.deploy',
  'tactics.deploy.edit',
  'tactics.deploy.sending',
  'tactics.deploy.candidateLabel',
  'tactics.deploy.prevMonster',
  'tactics.deploy.nextMonster',
  'tactics.deploy.confirm',
  'tactics.deploy.back',
  'tactics.results.label',
  'tactics.results.none',
  'tactics.results.continue',
];

/** bt-12: the 4 parameterised keys and the exact fields each closure reads (B8: `n`, `xp` and
 *  `essence` are numbers, `amount` a bigint, `name` a string). */
const BT12_PARAM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'tactics.deploy.slot': ['n'],
  'tactics.results.monster': ['name', 'xp', 'essence'],
  'tactics.results.currency': ['amount'],
  'tactics.results.recruited': ['name'],
};

/** Every `tactics.*` key after bt-12 increment A: 83 plain, 49 parameterised = 132 (bt-11
 *  increment C's 69 + 45 = 114, named intentional change). */
const PLAIN_KEYS: readonly string[] = [
  ...BT10_PLAIN_KEYS,
  ...BT11_PLAIN_KEYS,
  ...BT11C_PLAIN_KEYS,
  ...BT12_PLAIN_KEYS,
];
const PARAM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ...BT10_PARAM_FIELDS,
  ...BT11_PARAM_FIELDS,
  ...BT11C_PARAM_FIELDS,
  ...BT12_PARAM_FIELDS,
};

const PARAM_KEYS = Object.keys(PARAM_FIELDS);
const ROSTER = [...PLAIN_KEYS, ...PARAM_KEYS].sort();
const BT10_PARAM_KEYS = Object.keys(BT10_PARAM_FIELDS);
const BT10_ROSTER = [...BT10_PLAIN_KEYS, ...BT10_PARAM_KEYS].sort();
const BT11_PARAM_KEYS = Object.keys(BT11_PARAM_FIELDS);
const BT11_ROSTER = [...BT11_PLAIN_KEYS, ...BT11_PARAM_KEYS].sort();
const BT11C_PARAM_KEYS = Object.keys(BT11C_PARAM_FIELDS);
const BT11C_ROSTER = [...BT11C_PLAIN_KEYS, ...BT11C_PARAM_KEYS].sort();

/** The keys of `roster` whose catalog.en.ts entry line has no adjacent `// @desc:` of >= 10
 *  characters (or no entry line at all). */
function missingDescs(roster: readonly string[]): string[] {
  const lines = readFileSync(path.join(I18N_DIR, 'catalog.en.ts'), 'utf8').split('\n');
  const missing: string[] = [];
  for (const key of roster) {
    const at = lines.findIndex((l) => l.trim().startsWith(`'${key}':`));
    if (at === -1) {
      missing.push(`${key} (no entry line)`);
      continue;
    }
    let described = false;
    for (let j = at - 1; j >= 0; j--) {
      const c = lines[j].trim();
      if (!c.startsWith('//')) break;
      if (
        c.startsWith('// @desc:') &&
        c.slice('// @desc:'.length).replace(/\s/g, '').length >= 10
      ) {
        described = true;
      }
    }
    if (!described) missing.push(key);
  }
  return missing;
}

const tacticsKeys = (catalog: Record<string, unknown>): string[] =>
  Object.keys(catalog)
    .filter((k) => k.startsWith('tactics.'))
    .sort();

/** Call a closure with a Proxy that records the fields it reads and hands back a sentinel for each. */
function probe(fn: (p: Record<string, unknown>) => string): { out: string; fields: string[] } {
  const accessed = new Set<string>();
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        accessed.add(prop);
        return `<<${prop}>>`;
      },
    },
  ) as Record<string, unknown>;
  const out = fn(proxy);
  return { out, fields: [...accessed].sort() };
}

describe('tactics strings: the catalog (BT10.6, A4, A8)', () => {
  // bt-11 (named intentional change, plan REV 5 A39): the EXACT-roster pin moved to
  // BT11-1-STRINGS-ROSTER below (88 keys; 114 since round 4); this test keeps bt-10's own claim —
  // its 60 keys are still in both catalogs with the right shape, declared and described. Was:
  // "exactly the 60".
  it('BT10-6-STRINGS-ROSTER: both catalogs still hold the 60 bt-10 tactics.* keys (31 plain, 29 parameterised), with the four status* keys instead of tactics.ticker.status, every one declared in messageIds.ts and every English entry carrying an adjacent @desc', () => {
    // WRONG IMPL KILLED: a key missing from one locale (t()/tf() throws in a French boot); the
    // dropped tactics.ticker.status left behind (A4); a parameterised key authored as a plain
    // string (or the reverse); a key in the catalog but not in the MessageId union / the
    // MessageParams table (the typed seam bypassed); an entry with no @desc (translators get no
    // context); a bt-10 key lost while the bt-11 keys were added.
    expect(BT10_PLAIN_KEYS, 'fixture: 31 plain keys').toHaveLength(31);
    expect(BT10_PARAM_KEYS, 'fixture: 29 parameterised keys').toHaveLength(29);
    expect(new Set(BT10_ROSTER).size, 'fixture: no key listed twice').toBe(60);

    const en = new Set(tacticsKeys(EN));
    const fr = new Set(tacticsKeys(FR));
    expect(
      BT10_ROSTER.filter((k) => !en.has(k)),
      'no bt-10 key is missing from the English catalog',
    ).toEqual([]);
    expect(
      BT10_ROSTER.filter((k) => !fr.has(k)),
      'no bt-10 key is missing from the French catalog',
    ).toEqual([]);
    expect(
      Object.hasOwn(EN, 'tactics.ticker.status'),
      'tactics.ticker.status was replaced (A4)',
    ).toBe(false);
    expect(Object.hasOwn(FR, 'tactics.ticker.status'), 'and in French').toBe(false);

    for (const key of BT10_PLAIN_KEYS) {
      expect(typeof EN[key], `en ${key} is a plain string`).toBe('string');
      expect(typeof FR[key], `fr ${key} is a plain string`).toBe('string');
      expect((EN[key] as string).length > 0, `en ${key} is not empty`).toBe(true);
    }
    for (const key of BT10_PARAM_KEYS) {
      expect(typeof EN[key], `en ${key} is a closure`).toBe('function');
      expect(typeof FR[key], `fr ${key} is a closure`).toBe('function');
    }

    const ids = stripComments(readFileSync(path.join(I18N_DIR, 'messageIds.ts'), 'utf8'));
    for (const key of BT10_ROSTER) {
      expect(ids.includes(`| '${key}'`), `${key} is in the MessageId union`).toBe(true);
    }
    for (const key of BT10_PARAM_KEYS) {
      expect(ids.includes(`readonly '${key}':`), `${key} is in the MessageParams table`).toBe(true);
    }
    for (const key of BT10_PLAIN_KEYS) {
      expect(ids.includes(`readonly '${key}':`), `${key} is plain: not in MessageParams`).toBe(
        false,
      );
    }
    expect(
      missingDescs(BT10_ROSTER),
      'every bt-10 tactics.* entry has an adjacent // @desc: of >= 10 characters',
    ).toEqual([]);
  });

  it('BT11-1-STRINGS-ROSTER: both catalogs hold exactly the 132 tactics.* keys — bt-10`s 60, the command menu`s 26 plain and 2 parameterised keys, the strip / forecast / Projected 12 plain and 14 parameterised keys, and (bt-12) the deploy / results panels` 14 plain and 4 parameterised keys — each bt-11 one the right shape, declared in messageIds.ts and carrying an adjacent @desc, and the two full-budget reasons print their {ap}', () => {
    // WRONG IMPL KILLED (plan REV 5 A39 / A23 seam; round 4: REV 6 R6.7): a menu label, reason,
    // dock or queue key missing from one locale (a French boot throws on opening the command menu);
    // a badge word, a forecast line or a Projected line missing from one locale (a French boot
    // throws on the first aim); a reason that takes no {ap} (the "6" baked into the text: R4.11
    // reads it from rules.freshBudget()); a parameterised key authored as plain or the reverse (a
    // `forecast.hit` with the percent concatenated by the caller; a `projected.label` closure); a
    // key outside the MessageId union / MessageParams table; an undescribed entry; the dropped
    // `forecast.typeSuper` / `typeResist` words kept (A27 replaced them with typeTimes / typeOver);
    // the roster left at 88; and a stray tactics.* key nobody asked for.
    expect(BT11_PLAIN_KEYS, 'fixture: 26 increment-B plain keys').toHaveLength(26);
    expect(BT11_PARAM_KEYS, 'fixture: 2 increment-B parameterised keys').toHaveLength(2);
    expect(BT11C_PLAIN_KEYS, 'fixture: 12 increment-C plain keys').toHaveLength(12);
    expect(BT11C_PARAM_KEYS, 'fixture: 14 increment-C parameterised keys').toHaveLength(14);
    // bt-12 (named intentional change): 69 → 83 plain, 45 → 49 parameterised, 114 → 132.
    expect(PLAIN_KEYS, 'fixture: 83 plain keys in all').toHaveLength(83);
    expect(PARAM_KEYS, 'fixture: 49 parameterised keys in all').toHaveLength(49);
    expect(new Set(ROSTER).size, 'fixture: 132 keys, none listed twice').toBe(132);
    expect(
      BT11_ROSTER.filter((k) => BT10_ROSTER.includes(k)),
      'fixture: the increment-B keys are new',
    ).toEqual([]);
    expect(
      BT11C_ROSTER.filter((k) => BT10_ROSTER.includes(k) || BT11_ROSTER.includes(k)),
      'fixture: the increment-C keys are new',
    ).toEqual([]);
    for (const dropped of ['tactics.forecast.typeSuper', 'tactics.forecast.typeResist']) {
      expect(Object.hasOwn(EN, dropped), `en ${dropped} was dropped by A27`).toBe(false);
      expect(Object.hasOwn(FR, dropped), `fr ${dropped} was dropped by A27`).toBe(false);
    }

    expect(tacticsKeys(EN), 'the English catalog holds exactly the 132-key roster').toEqual(ROSTER);
    expect(tacticsKeys(FR), 'the French catalog holds exactly the 132-key roster').toEqual(ROSTER);

    for (const key of BT11C_PLAIN_KEYS) {
      expect(typeof EN[key], `en ${key} is a plain string`).toBe('string');
      expect(typeof FR[key], `fr ${key} is a plain string`).toBe('string');
      expect((EN[key] as string).length > 0, `en ${key} is not empty`).toBe(true);
    }
    for (const key of BT11C_PARAM_KEYS) {
      expect(typeof EN[key], `en ${key} is a closure`).toBe('function');
      expect(typeof FR[key], `fr ${key} is a closure`).toBe('function');
    }

    for (const key of BT11_PLAIN_KEYS) {
      expect(typeof EN[key], `en ${key} is a plain string`).toBe('string');
      expect(typeof FR[key], `fr ${key} is a plain string`).toBe('string');
      expect((EN[key] as string).length > 0, `en ${key} is not empty`).toBe(true);
    }
    for (const key of BT11_PARAM_KEYS) {
      expect(typeof EN[key], `en ${key} is a closure`).toBe('function');
      expect(typeof FR[key], `fr ${key} is a closure`).toBe('function');
      for (const ap of [7, 13]) {
        const enLine = (EN[key] as (p: Record<string, unknown>) => string)({ ap });
        const frLine = (FR[key] as (p: Record<string, unknown>) => string)({ ap });
        expect(enLine.includes(String(ap)), `en ${key} prints {ap} = ${ap}`).toBe(true);
        expect(frLine.includes(String(ap)), `fr ${key} prints {ap} = ${ap}`).toBe(true);
        expect(enLine.includes('6'), `en ${key} bakes in no literal 6 (ap ${ap})`).toBe(false);
      }
    }

    const ids = stripComments(readFileSync(path.join(I18N_DIR, 'messageIds.ts'), 'utf8'));
    for (const key of [...BT11_ROSTER, ...BT11C_ROSTER]) {
      expect(ids.includes(`| '${key}'`), `${key} is in the MessageId union`).toBe(true);
    }
    for (const key of [...BT11_PARAM_KEYS, ...BT11C_PARAM_KEYS]) {
      expect(ids.includes(`readonly '${key}':`), `${key} is in the MessageParams table`).toBe(true);
    }
    for (const key of [...BT11_PLAIN_KEYS, ...BT11C_PLAIN_KEYS]) {
      expect(ids.includes(`readonly '${key}':`), `${key} is plain: not in MessageParams`).toBe(
        false,
      );
    }
    expect(
      missingDescs(ROSTER),
      'every tactics.* entry has an adjacent // @desc: of >= 10 characters',
    ).toEqual([]);
  });

  it('BT10-6-STRINGS-FR: for every tactics.* key the French differs from the English, and every closure reads exactly the same fields in both locales and prints each of them', () => {
    // WRONG IMPL KILLED: the English copied into catalog.fr.ts (a French boot reads English);
    // a French closure that drops a param (the damage, the unit, the amount) or reads a
    // different field name (the sentinel would not appear); an English closure that reads a field
    // the roster does not list (an undeclared param); a closure that ignores one of its params.
    for (const key of PLAIN_KEYS) {
      expect(FR[key], `${key}: French is not the English copy`).not.toBe(EN[key]);
    }
    for (const key of PARAM_KEYS) {
      const want = [...PARAM_FIELDS[key]].sort();
      const en = probe(EN[key] as (p: Record<string, unknown>) => string);
      const fr = probe(FR[key] as (p: Record<string, unknown>) => string);
      expect(en.fields, `${key}: the English closure reads exactly ${want.join(', ')}`).toEqual(
        want,
      );
      expect(fr.fields, `${key}: the French closure reads exactly ${want.join(', ')}`).toEqual(
        want,
      );
      for (const field of want) {
        expect(en.out.includes(`<<${field}>>`), `${key}: en prints {${field}}`).toBe(true);
        expect(fr.out.includes(`<<${field}>>`), `${key}: fr prints {${field}}`).toBe(true);
      }
      expect(fr.out, `${key}: French is not the English line`).not.toBe(en.out);
    }
  });
});

describe('tactics strings: copy rules (bt-10 round 2)', () => {
  it("BT10-5-STRINGS-COPY: the turn banner is neutral (it also shows for a human opponent's turn) and the Surge line says damage", () => {
    // WRONG IMPL KILLED (ROUND 2, R2/R3): "Your turn: {unit}" shown over an OPPONENT's live turn
    // (it reads as the player's), in either language; a Surge line that reads as a buff ("surges
    // (+3)") when Surge is damage dealt to the unit.
    const banner = (catalog: Record<string, unknown>, unit: string): string =>
      (catalog['tactics.banner.turn'] as (p: Record<string, unknown>) => string)({ unit });
    for (const unit of ['Sprigg', 'Rival Mon']) {
      const en = banner(EN, unit);
      const fr = banner(FR, unit);
      expect(en.includes(unit), `en banner names ${unit}`).toBe(true);
      expect(fr.includes(unit), `fr banner names ${unit}`).toBe(true);
      for (const second of ['your', 'you ']) {
        expect(en.toLowerCase().includes(second), `en banner has no "${second}"`).toBe(false);
      }
      for (const second of ['votre', 'ton tour']) {
        expect(fr.toLowerCase().includes(second), `fr banner has no "${second}"`).toBe(false);
      }
    }
    expect(banner(EN, 'Sprigg'), 'the exact neutral English').toBe("Sprigg's turn");

    const surge = (catalog: Record<string, unknown>): string =>
      (catalog['tactics.ticker.surge'] as (p: Record<string, unknown>) => string)({
        unit: 'Sprigg',
        amount: 3,
      });
    expect(surge(EN), 'the exact English Surge line').toBe('Sprigg takes 3 Surge damage');
    expect(surge(EN).includes('surges'), 'no buff wording').toBe(false);
    expect(surge(FR), 'a French line exists and differs').not.toBe(surge(EN));
  });
});

// ---------------------------------------------------------------------------------------------
// Source scans (A6)
// ---------------------------------------------------------------------------------------------

/** The text of every string literal in `expr` (a template literal contributes only the text
 *  outside its `${...}` holes). */
function literalTexts(expr: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') {
      let text = '';
      i += 1;
      while (i < expr.length && expr[i] !== ch) {
        if (expr[i] === '\\') i += 1;
        text += expr[i] ?? '';
        i += 1;
      }
      out.push(text);
      i += 1;
    } else if (ch === '`') {
      let text = '';
      let depth = 0;
      i += 1;
      while (i < expr.length && !(expr[i] === '`' && depth === 0)) {
        if (expr[i] === '\\' && depth === 0) {
          i += 2;
          continue;
        }
        if (expr[i] === '$' && expr[i + 1] === '{') {
          depth += 1;
          i += 2;
          continue;
        }
        if (depth > 0 && expr[i] === '{') depth += 1;
        else if (depth > 0 && expr[i] === '}') depth -= 1;
        else if (depth === 0) text += expr[i];
        i += 1;
      }
      out.push(text);
      i += 1;
    } else {
      i += 1;
    }
  }
  return out;
}

const hasLetter = (s: string): boolean => /[A-Za-z]/.test(s);

/** Text of the balanced `( ... )` starting at the `(` at `open`, or '' when unbalanced. */
function balanced(src: string, open: number): string {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote !== '') {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** The right-hand side of an assignment: from `from` to the first `;` or end of line outside
 *  quotes and brackets. */
function rhs(src: string, from: number): string {
  let depth = 0;
  let quote = '';
  let start = from;
  while (start < src.length && /\s/.test(src[start])) start += 1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote !== '') {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if ((c === ';' || c === '\n') && depth <= 0) return src.slice(start, i);
  }
  return src.slice(start);
}

const SINK_PROPS = 'textContent|innerText|title|ariaLabel|alt|placeholder';
const SINK_ATTRS = [
  'aria-label',
  'title',
  'alt',
  'placeholder',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
];

/** Every forbidden construct in one non-strings tactics module, by rule id. */
function scanSource(raw: string): string[] {
  const src = stripComments(raw);
  const found = new Set<string>();
  if (/i18n\/resolver/.test(src)) found.add('resolver-import');
  if (/\b(innerHTML|outerHTML|insertAdjacentHTML)\b/.test(src)) found.add('html-sink');
  if (
    /aria-live|ariaLive|a11y-live|LIVE_REGION_ID/.test(src) ||
    /role\s*=\s*["'](status|log)["']/.test(src) ||
    /["']role["']\s*,\s*["'](status|log)["']/.test(src) ||
    /\.role\s*=\s*["'](status|log)["']/.test(src) ||
    /\brole\s*:\s*["'](status|log)["']/.test(src)
  ) {
    found.add('live-region');
  }
  if (/\.animate\s*\(/.test(src)) found.add('animate');

  const assign = new RegExp(`\\.(${SINK_PROPS})\\s*\\+?=(?!=)`, 'g');
  for (const m of src.matchAll(assign)) {
    const from = (m.index ?? 0) + m[0].length;
    if (literalTexts(rhs(src, from)).some(hasLetter)) found.add('text-literal');
  }
  for (const m of src.matchAll(/\.setAttribute\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const args = balanced(src, open);
    const [name, ...rest] = literalTexts(args);
    if (name !== undefined && SINK_ATTRS.includes(name) && rest.some(hasLetter)) {
      found.add('text-literal');
    }
  }
  for (const m of src.matchAll(/createTextNode\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (literalTexts(balanced(src, open)).some(hasLetter)) found.add('text-literal');
  }
  return [...found].sort();
}

/** What strings.ts does with the resolver: how it imports it and every t()/tf() call's first argument. */
function resolverUse(raw: string): {
  imported: boolean;
  aliased: boolean;
  calls: { fn: 't' | 'tf'; key: string | null }[];
} {
  const src = stripComments(raw);
  const imp = [
    ...src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g),
  ].filter((m) => /i18n\/resolver(\.ts|\.js)?$/.test(m[2]));
  const calls: { fn: 't' | 'tf'; key: string | null }[] = [];
  for (const m of src.matchAll(/(?<![.\w$])(tf|t)\s*(?:<[^>()]*>)?\s*\(\s*/g)) {
    const after = src.slice((m.index ?? 0) + m[0].length);
    const q = after[0];
    let key: string | null = null;
    if (q === "'" || q === '"') {
      const end = after.indexOf(q, 1);
      const next = after.slice(end + 1).trimStart()[0];
      if (end !== -1 && (next === ',' || next === ')')) key = after.slice(1, end);
    }
    calls.push({ fn: m[1] as 't' | 'tf', key });
  }
  return {
    imported: imp.length > 0,
    aliased: imp.some((m) => /\bas\b/.test(m[1])),
    calls,
  };
}

const TACTICS_FILES: string[] = readdirSync(HERE).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'strings.ts',
);

describe('tactics strings: the source scans (A6)', () => {
  it('BT10-6-SCAN-LIVE: no non-strings tactics module imports the resolver, writes an HTML sink, a live region or .animate(, or assigns a literal word to a text sink', () => {
    // WRONG IMPL KILLED: a second resolver importer (PARITY-02's roster is exact: one file); an
    // innerHTML / insertAdjacentHTML write (hostile species names are data); aria-live /
    // role=log|status (A11Y-05b keeps live regions in ui/liveRegion.ts); .animate() (the biome
    // no-waapi rule; reduced motion is CSS + the boolean); a hard-coded English label on
    // textContent / title / aria-label (the typed catalog is the only text source).
    for (const required of [
      'boardModel.ts',
      'boardRender.ts',
      'hud.ts',
      'turnBar.ts',
      'ticker.ts',
      'presentation.ts',
      'tacticsBattle.ts',
      // bt-11 increment B: the command-menu model and the draft (codes only, never text).
      'commandModel.ts',
      'draft.ts',
    ]) {
      expect(TACTICS_FILES, `${required} is among the scanned files`).toContain(required);
    }
    const bad: string[] = [];
    for (const file of TACTICS_FILES) {
      const findings = scanSource(readFileSync(path.join(HERE, file), 'utf8'));
      for (const f of findings) bad.push(`${file}: ${f}`);
    }
    expect(bad, 'forbidden constructs in the tactics modules').toEqual([]);
  });

  it('BT10-6-SCAN-TEETH: every needle fires on a planted fixture and stays quiet on clean code and on comments', () => {
    // WRONG IMPL KILLED (of the scan itself): a needle that never matches (the live scan above
    // would pass over a real violation); a needle that fires on a comment or on letter-free
    // assignments (the live scan would force contortions); a template literal text sink the
    // scanner reads as safe; a setAttribute sink the scanner misses.
    const cases: readonly (readonly [string, string, string])[] = [
      ['resolver-import', "import { t } from '../ui/i18n/resolver';", 'resolver-import'],
      ['html-sink: innerHTML', 'el.innerHTML = name;', 'html-sink'],
      ['html-sink: insertAdjacentHTML', "el.insertAdjacentHTML('beforeend', x);", 'html-sink'],
      ['html-sink: outerHTML', 'el.outerHTML = x;', 'html-sink'],
      ['live: aria-live', "el.setAttribute('aria-live', 'polite');", 'live-region'],
      ['live: role=log call', "el.setAttribute('role', 'log');", 'live-region'],
      ['live: role=status markup', 'const m = \'<div role="status"></div>\';', 'live-region'],
      ['live: .role', "el.role = 'status';", 'live-region'],
      ['live: object role', "const o = { role: 'log' };", 'live-region'],
      ['animate', 'el.animate([], { duration: 100 });', 'animate'],
      ['text: textContent literal', "el.textContent = 'Hello';", 'text-literal'],
      [
        'text: textContent literal on the next line',
        "el.textContent =\n  'Hello';",
        'text-literal',
      ],
      ['text: textContent template', `el.textContent = \`Lv ${hole('level')}\`;`, 'text-literal'],
      ['text: textContent ternary', "el.textContent = many ? 'many' : 'one';", 'text-literal'],
      ['text: textContent concat', "el.textContent += ' items';", 'text-literal'],
      ['text: title literal', "el.title = 'x y';", 'text-literal'],
      ['text: aria-label literal', "el.setAttribute('aria-label', 'Close');", 'text-literal'],
      [
        'text: title attribute template',
        `el.setAttribute("title", \`Open ${hole('name')}\`);`,
        'text-literal',
      ],
      ['text: createTextNode', "el.appendChild(document.createTextNode('Hi'));", 'text-literal'],
    ];
    for (const [label, source, rule] of cases) {
      expect(scanSource(source), `${label} fires ${rule}`).toContain(rule);
    }
    const clean = [
      "el.textContent = '';",
      `el.textContent = ' ${EM_DASH} ';`,
      `el.textContent = \`${hole('n')}\`;`,
      `el.textContent = \`${hole('pct / 10')}%\`;`,
      'el.textContent =\n  label(n);',
      'el.textContent = label(n);',
      "el.textContent = 12 + ' ' + 3;",
      "el.setAttribute('aria-label', strings.lock());",
      "el.setAttribute('data-unit-id', String(id));",
      "el.setAttribute('role', 'presentation');",
      "el.className = 'tactics-chip';",
      "el.classList.toggle('tactics--reduced', on);",
      "const t = (x: number) => x; t(1); // el.innerHTML = 'x'",
      "/* el.setAttribute('aria-live', 'polite'); el.animate() */ const a = 1;",
      "// import { t } from '../ui/i18n/resolver';",
    ];
    for (const source of clean) {
      expect(scanSource(source), `clean: ${source}`).toEqual([]);
    }
  });
});

describe('tactics strings: strings.ts (BT10.6, A6)', () => {
  it('BT10-6-STRINGS-RESOLVER: strings.ts imports t/tf from the resolver unaliased, every t()/tf() first argument is a string literal, plain keys go through t and parameterised keys through tf, and all 132 tactics.* keys (bt-12: 60 + 28 + 26 + 18) are requested', () => {
    // WRONG IMPL KILLED: a dynamic key (`t(\`tactics.stance.${s}\`)` — PARITY-02's dynamic-key scan
    // refuses it, and a typo would only fail at runtime); an aliased import the scan cannot follow;
    // t() on a closure key or tf() on a plain key (the resolver throws); a catalog key nothing
    // requests (PARITY-04 DEAD-KEY); a key requested that the catalog does not define.
    const raw = readFileSync(path.join(HERE, 'strings.ts'), 'utf8');
    const use = resolverUse(raw);
    expect(use.imported, 'strings.ts imports from ui/i18n/resolver').toBe(true);
    expect(use.aliased, 'and does not alias t / tf').toBe(false);
    expect(use.calls.length > 0, 'strings.ts calls t / tf').toBe(true);
    expect(
      use.calls.filter((c) => c.key === null).map((c) => c.fn),
      'no dynamic-key call',
    ).toEqual([]);

    const requested = new Map<string, Set<'t' | 'tf'>>();
    for (const c of use.calls) {
      if (c.key === null) continue;
      const set = requested.get(c.key) ?? new Set<'t' | 'tf'>();
      set.add(c.fn);
      requested.set(c.key, set);
    }
    for (const key of PLAIN_KEYS) {
      expect(requested.get(key)?.has('t'), `${key} is requested through t()`).toBe(true);
      expect(requested.get(key)?.has('tf') ?? false, `${key} is not requested through tf()`).toBe(
        false,
      );
    }
    for (const key of PARAM_KEYS) {
      expect(requested.get(key)?.has('tf'), `${key} is requested through tf()`).toBe(true);
      expect(requested.get(key)?.has('t') ?? false, `${key} is not requested through t()`).toBe(
        false,
      );
    }
    for (const key of requested.keys()) {
      expect(Object.hasOwn(EN, key), `${key} (requested by strings.ts) exists in the catalog`).toBe(
        true,
      );
    }

    // Teeth for the extractor itself.
    const sample = [
      "import { t, tf } from '../ui/i18n/resolver';",
      "export const a = () => t('tactics.board.label');",
      "export const b = (n: number) => tf('tactics.turnbar.round', { round: n });",
      'export const c = (k: string) => t(k);',
      'export const d = (k: string) => t(`tactics.x.${k}`);',
      "export const e = () => obj.t('tactics.not.a.call');",
    ].join('\n');
    const probeUse = resolverUse(sample);
    expect(
      probeUse.calls.map((c) => [c.fn, c.key]),
      'literal keys read, dynamic keys flagged, member calls ignored',
    ).toEqual([
      ['t', 'tactics.board.label'],
      ['tf', 'tactics.turnbar.round'],
      ['t', null],
      ['t', null],
    ]);
    expect(
      resolverUse("import { t as tt } from '../ui/i18n/resolver';").aliased,
      'an alias is seen',
    ).toBe(true);
    expect(
      resolverUse("import { x } from './other';").imported,
      'another module is not the resolver',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// bt-12: the deploy and results panels' strings.ts functions (BT12.6, plan REV 2 A5 / REV 2b B8).
// No file text is read: every function is CALLED, under English and under French. A function is
// looked up on the module namespace by name, so a missing one is a failed expect (a named import
// of an absent export would be a link error that reds the whole file).
// ---------------------------------------------------------------------------------------------

/** U+2026 HORIZONTAL ELLIPSIS, by code point (never a pasted glyph). */
const ELLIPSIS = String.fromCharCode(0x2026);
/** 2^53 + 1: the first integer a JS number cannot hold (a `Number()` on the way prints ...992). */
const PAST_2_53 = 9_007_199_254_740_993n;

describe('tactics strings: the deploy and results panels (bt-12, BT12.6)', () => {
  afterEach(() => {
    setLocale('en');
  });

  it('the deploy and results strings.ts functions resolve their exact English, a different French, and print every parameter they take, the gold amount past 2^53 digit for digit; the results title is the shipped battle outcome text of each of the three outcomes [BT12-6-STRINGS-ROSTER]', () => {
    // WRONG IMPL KILLED (plan REV 2 A5, REV 2b B8): a function missing from strings.ts (the panel
    // would have to write its own literal); a function that resolves a sibling's key (Deploy for
    // Confirm, Back for Edit formation); the deploy title read from `battle.title` (the 1v1 view's
    // "Battle"); a slot label that bakes in its number or reads it 0-based; a results line that drops
    // or swaps xp and essence; a currency line run through Number() (2^53 + 1 prints ...992) or
    // worded "coins" (the catalog's word is gold); a results title from a fresh key instead of the
    // shipped battle.outcome.* texts (the French would not be theirs); the English copied into the
    // French catalog; and a French closure that drops a parameter.
    const EN_CAT = CATALOG_EN as unknown as Record<string, unknown>;
    const FR_CAT = CATALOG_FR as unknown as Record<string, unknown>;
    const fns = s as unknown as Record<string, unknown>;
    /** strings.ts's `name`, called with `args`; a missing export fails here, by name. */
    const call = (name: string, ...args: unknown[]): string => {
      const fn = fns[name];
      expect(typeof fn, `strings.ts exports ${name}()`).toBe('function');
      const out = (fn as (...a: unknown[]) => unknown)(...args);
      expect(typeof out, `${name}() returns a string`).toBe('string');
      return out as string;
    };
    const PLAIN: ReadonlyArray<readonly [string, string]> = [
      ['deployTitle', 'Choose your team'],
      ['deployLabel', 'Formation'],
      ['deployEmpty', 'Empty'],
      ['deployDeploy', 'Deploy'],
      ['deployEdit', 'Edit formation'],
      ['deploySending', `Deploying${ELLIPSIS}`],
      ['deployCandidateLabel', 'Monster to place'],
      ['deployPrevMonster', 'Previous monster'],
      ['deployNextMonster', 'Next monster'],
      ['deployConfirm', 'Confirm'],
      ['deployBack', 'Back'],
      ['resultsLabel', 'Rewards'],
      ['resultsNone', 'No rewards'],
      ['resultsContinue', 'Continue'],
    ];
    expect(PLAIN, 'fixture: the 14 plain functions').toHaveLength(14);
    const TITLES: ReadonlyArray<readonly [string, string, string]> = [
      ['won', 'battle.outcome.victory', 'Victory!'],
      ['lost', 'battle.outcome.defeat', 'Defeat...'],
      ['fled', 'battle.outcome.fled', 'Got away safely!'],
    ];

    // --- English: the exact text ---------------------------------------------------------------
    setLocale('en');
    const en = new Map<string, string>();
    for (const [name, text] of PLAIN) {
      const out = call(name);
      expect(out, `en ${name}()`).toBe(text);
      en.set(name, out);
    }
    expect(en.get('deployTitle'), 'the deploy title is not the battle frame`s title').not.toBe(
      EN_CAT['battle.title'],
    );
    expect(call('deploySlot', 1), 'en deploySlot(1): the first slot is Slot 1').toBe('Slot 1');
    expect(call('deploySlot', 13), 'en deploySlot(13): the number is read').toBe('Slot 13');
    expect(call('resultsMonster', 'Sprigg', 53, 7), 'en resultsMonster').toBe(
      'Sprigg: +53 XP, +7 essence',
    );
    expect(call('resultsMonster', 'Kip', 0, 11), 'en resultsMonster, zero XP printed').toBe(
      'Kip: +0 XP, +11 essence',
    );
    expect(call('resultsCurrency', PAST_2_53), 'en resultsCurrency past 2^53, in gold').toBe(
      '+9007199254740993 gold',
    );
    expect(call('resultsCurrency', 7n), 'en resultsCurrency, a small amount').toBe('+7 gold');
    expect(call('resultsRecruited', 'Mossback'), 'en resultsRecruited').toBe(
      'Mossback joined your team!',
    );
    for (const [outcome, key, text] of TITLES) {
      const out = call('resultsTitle', outcome);
      expect(out, `en resultsTitle('${outcome}')`).toBe(text);
      expect(out, `en resultsTitle('${outcome}') is the shipped ${key} text`).toBe(EN_CAT[key]);
    }

    // --- French: a translation, every parameter printed ---------------------------------------
    setLocale('fr');
    for (const [name] of PLAIN) {
      const out = call(name);
      expect(out.length > 0, `fr ${name}() is not empty`).toBe(true);
      expect(out, `fr ${name}() is a translation, not the English`).not.toBe(en.get(name));
    }
    expect(call('deployLabel'), 'fr deployLabel(): the plan`s French (B8)').toBe(
      'Ordre de bataille',
    );
    const frSlot = call('deploySlot', 13);
    expect(frSlot.includes('13'), `fr deploySlot(13) prints 13: ${frSlot}`).toBe(true);
    expect(frSlot, 'fr deploySlot is not the English line').not.toBe('Slot 13');
    const frMonster = call('resultsMonster', 'Sprigg', 53, 7);
    for (const field of ['Sprigg', '53', '7']) {
      expect(frMonster.includes(field), `fr resultsMonster prints ${field}: ${frMonster}`).toBe(
        true,
      );
    }
    expect(frMonster, 'fr resultsMonster is not the English line').not.toBe(
      'Sprigg: +53 XP, +7 essence',
    );
    const frCurrency = call('resultsCurrency', PAST_2_53);
    expect(
      frCurrency.includes('9007199254740993'),
      `fr resultsCurrency prints the amount digit for digit: ${frCurrency}`,
    ).toBe(true);
    expect(frCurrency, 'fr resultsCurrency is not the English line').not.toBe(
      '+9007199254740993 gold',
    );
    const frRecruited = call('resultsRecruited', 'Mossback');
    expect(
      frRecruited.includes('Mossback'),
      `fr resultsRecruited prints the name: ${frRecruited}`,
    ).toBe(true);
    expect(frRecruited, 'fr resultsRecruited is not the English line').not.toBe(
      'Mossback joined your team!',
    );
    for (const [outcome, key, text] of TITLES) {
      const out = call('resultsTitle', outcome);
      expect(out, `fr resultsTitle('${outcome}') is the shipped French ${key}`).toBe(FR_CAT[key]);
      expect(out, `fr resultsTitle('${outcome}') is not the English`).not.toBe(text);
    }
  });
});
