// @vitest-environment happy-dom
/**
 * tactics/results.test.ts — bt-12 RED tests for the Finished-phase results (BT12.4) and their text
 * (BT12.6): the pure `resultsVM` fold over the transcript, the `ResultsPanel` DOM, the Continue
 * skip, and the auto-advance predicate main.ts drives from its frame clock.
 *
 * SOURCE OF TRUTH: spec `### bt-12` BT12.4 ("WHEN a battle ends, THE Finished phase SHALL list XP,
 * essence and currency per monster, recruits, and the outcome, auto-advancing after 3 s and
 * skippable") and BT12.6; plan memory/projects/monster-realm-bt-12-plan.md §3.5 (resultsVM
 * semantics), §3.8 (the results DOM) as amended by REV 2 A7 (no clock in the panel: deps are
 * `{ onContinue }` only; `shouldAutoContinue(outcomeShownAtMs, nowMs, resultsShown, capMs)` in
 * ui/battlePolicy.ts is the countdown), A10 (an equal VM writes nothing) and REV 2b B4 (the same
 * Continue node and its focus survive an equal re-render), B7 (currency on TWO Awards lines, one on a
 * non-zero unit, summing past 2^53; the recruiter's species differs from the target's; a mySide 'B'
 * fixture) and B8 (the title reuses `battle.outcome.victory` / `.defeat` / `.fled`; the gold line;
 * ONE currency line per player).
 *
 * DOM CONTRACT (plan §3.8): the root is
 * `div.mr-frame.mr-shell.mr-shell--top.mr-shell--battle.tactics-results` (display none until shown)
 * holding, in order, `h2.tactics-title[data-testid=battle-title][tabindex=-1]`,
 * `ul.tactics-results-list[aria-label]` of `li.tactics-results-line[data-line]` (monster lines,
 * recruit lines, then a currency line only when the amount is > 0n; a single `none` line when there
 * are no lines) and `button.tactics-results-continue[type=button]`.
 *
 * RESOLVED AMBIGUITY (reported): `ResultsVM.recruits[i].unitId` is not pinned (the plan does not say
 * whether it is the recruiter's or the target's unit); recruits are asserted by name and order.
 *
 * RED REASON: `resultsVM`, `ResultsPanel` and `shouldAutoContinue` throw `bt-12: not implemented` on
 * the API-freeze stubs, and the `tactics.results.*` catalog keys are absent.
 *
 * Do NOT edit these tests to match a buggy implementation; correct them from the spec only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EventPayload } from '../module_bindings/types';
import type { StoreBattleEvent, StoreBattleUnit } from '../net/store';
import { shouldAutoContinue } from '../ui/battlePolicy';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import { CATALOG_FR } from '../ui/i18n/catalog.fr';
import { setLocale } from '../ui/i18n/resolver';
import { closeOverlayA11y } from '../ui/overlayA11y';
import { type ResultsInput, ResultsPanel, type ResultsVM, resultsVM } from './results';
import type { RuleSide, UnitRow } from './wasm';

// --- fixtures -----------------------------------------------------------------------------------

const BATTLE = 9_007_199_254_740_993n;
const ME = 'ab'.repeat(32);
const RIVAL = 'cd'.repeat(32);
/** Own monsters and a rival's, every id past 2^53. */
const MA = 9_007_199_254_740_995n;
const MB = 9_007_199_254_740_997n;
const MC = 9_007_199_254_740_999n;

const NAMES: ReadonlyMap<bigint, string> = new Map([
  [MA, 'Sprigg'],
  [MB, 'Cindertail'],
  [MC, 'Rival Mossback'],
]);
const SPECIES: ReadonlyMap<number, string> = new Map([
  [3, 'Sproutle'],
  [5, 'Emberfang'],
  [13, 'Duskling'],
  [19, 'Flameling'],
  [23, 'Tidepup'],
]);
const monsterName = (id: bigint): string => NAMES.get(id) ?? `#${id}`;
const speciesName = (id: number): string => SPECIES.get(id) ?? `species ${id}`;

function unitRow(id: number, side: RuleSide, speciesId: number): UnitRow {
  return {
    id,
    side,
    slot: 0,
    species_id: speciesId,
    level: 5,
    stats: { hp: 20, attack: 5, defense: 5, speed: 5, sp_attack: 5, sp_defense: 5 },
    pos: { x: 0, y: 0 },
    cur_hp: 10,
    status: null,
    budget: { ap: 0, strides_used: 0, attacks: 0, last: null },
    guard: false,
    first_stand: false,
    state: 'Active',
    stance: null,
    wild_index: null,
  };
}
const unit = (
  unitId: number,
  side: RuleSide,
  monsterId: bigint | null,
  speciesId: number,
  owner: string | null,
): StoreBattleUnit => ({
  unitId,
  battleId: BATTLE,
  owner,
  monsterId,
  affinity: 'Plant',
  row: unitRow(unitId, side, speciesId),
});

let nextEventId = 9_007_199_254_741_101n;
const ev = (seq: number, payload: EventPayload): StoreBattleEvent => {
  nextEventId += 2n;
  return { eventId: nextEventId, battleId: BATTLE, seq, round: 1, payload };
};
const awards = (u: number, xp: number, essence: number, currency: bigint): EventPayload => ({
  tag: 'Awards',
  value: { unit: u, xp, essence, currency },
});
const recruit = (u: number, target: number, success: boolean): EventPayload => ({
  tag: 'RecruitResult',
  value: { unit: u, target, success, pct: 41 },
});

/** Side A: Sprigg (unit 2, species 3) and Cindertail (unit 3, species 5) are mine; unit 11 is mine
 *  with no monster row. Side B: the rival's Mossback (unit 5, species 19) and two wilds (units 7
 *  and 9, species 13 and 23, no monster). */
const UNITS: readonly StoreBattleUnit[] = [
  unit(2, 'A', MA, 3, ME),
  unit(3, 'A', MB, 5, ME),
  unit(11, 'A', null, 3, ME),
  unit(5, 'B', MC, 19, RIVAL),
  unit(7, 'B', null, 13, null),
  unit(9, 'B', null, 23, null),
];

/** The gold, split over TWO Awards lines (the unit-0 total line and a non-zero unit's), summing to
 *  2^53 + 1 (an odd total: a Number() sum reads 2^53). */
const GOLD_TOTAL = 9_007_199_254_740_993n;
const GOLD_ON_UNIT_0 = 9_007_199_254_740_000n;
const GOLD_ON_UNIT_2 = GOLD_TOTAL - GOLD_ON_UNIT_0;

const MYSTERY = { tag: 'Mystery', value: {} } as unknown as EventPayload;

/** The transcript in seq order: awards for my Cindertail, then my Sprigg (event order is not unit
 *  order), the rival's Mossback, an unresolved unit, my monster-less unit and the unit-0 gold line,
 *  interleaved with other kinds and an unknown one. */
function lineEvents(): StoreBattleEvent[] {
  return [
    ev(1, { tag: 'BattleStarted', value: { round: 1 } }),
    ev(2, awards(3, 53, 7, 0n)),
    ev(3, { tag: 'Ko', value: { unit: 7 } }),
    ev(4, awards(2, 59, 11, GOLD_ON_UNIT_2)),
    ev(5, awards(5, 61, 13, 0n)),
    ev(6, awards(99, 67, 17, 0n)),
    ev(7, awards(11, 71, 19, 0n)),
    ev(8, awards(0, 0, 0, GOLD_ON_UNIT_0)),
    ev(9, { tag: 'TurnEnded', value: { unit: 2, guard: false, committed: true } }),
    ev(10, MYSTERY),
    ev(11, {
      tag: 'BattleEnd',
      value: { outcome: { tag: 'SideAWins' }, how: { tag: 'SideEmpty' } },
    }),
  ];
}

const input = (o: Partial<ResultsInput> = {}): ResultsInput => ({
  battleId: BATTLE,
  outcome: 'SideAWins',
  mySide: 'A',
  units: UNITS,
  events: lineEvents(),
  monsterName,
  speciesName,
  ...o,
});

type Catalog = Record<string, unknown>;
const EN = CATALOG_EN as unknown as Catalog;
const FR = CATALOG_FR as unknown as Catalog;

/** A catalog value (a closure called with `params`); a missing key fails loudly by name. */
function cat(catalog: Catalog, key: string, params: Record<string, unknown> = {}): string {
  const value = catalog[key];
  if (typeof value === 'function') return (value as (p: Record<string, unknown>) => string)(params);
  if (typeof value !== 'string') throw new Error(`catalog key missing: ${key}`);
  return value;
}

/** A results panel on a fresh host, rendered with `vm` and shown; `continues` counts Continue. */
function mountPanel(vm: ResultsVM): {
  readonly panel: ResultsPanel;
  readonly root: HTMLElement;
  readonly continues: () => number;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let count = 0;
  const panel = new ResultsPanel(host, {
    onContinue: () => {
      count += 1;
    },
  });
  const root = host.querySelector<HTMLElement>('.tactics-results');
  if (root === null) throw new Error('the panel built no .tactics-results root under its parent');
  panel.render(vm);
  panel.show();
  return { panel, root, continues: () => count };
}

const lines = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('ul.tactics-results-list > li.tactics-results-line'),
];

/** Every non-blank text node under `root`, trimmed. */
function textsOf(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    if (text !== '') out.push(text);
  }
  return out;
}

const VM: ResultsVM = {
  battleId: BATTLE,
  outcome: 'won',
  monsters: [
    { unitId: 3, name: 'Cindertail', xp: 53, essence: 7 },
    { unitId: 2, name: 'Sprigg', xp: 59, essence: 11 },
  ],
  recruits: [{ unitId: 7, name: 'Duskling' }],
  currency: GOLD_TOTAL,
};

afterEach(() => {
  closeOverlayA11y('battleView', null);
  document.body.replaceChildren();
  setLocale('en');
});

// --- the view model -------------------------------------------------------------------------------

describe('results: the view model (bt-12, BT12.4)', () => {
  it('resultsVM lists one XP and essence line per Awards event for a unit on my side with a monster, in event order, and sums the gold of every Awards line exactly past 2^53 [BT12-4-RESULTS-VM-LINES]', () => {
    // WRONG IMPL KILLED: lines in unit order instead of event order; the rival's monster, a wild,
    // an Awards for a unit with no row, or my monster-less unit listed; xp and essence swapped; the
    // name read from the unit id, not monsterName(monsterId); the gold read off the unit-0 line
    // alone (`find(unit === 0)`: misses the second line), or summed through Number() (2^53 + 1
    // reads 2^53), or from a CURRENCY_AWARD_UNIT constant copied into TS; a mySide ignored (side B
    // would list side A's monsters); a throw on an unknown event kind.
    const vm = resultsVM(input());
    expect(vm, 'a won battle has results').not.toBeNull();
    expect(vm?.battleId, 'the battle id, exactly').toBe(BATTLE);
    expect(vm?.monsters, 'my two monsters, in event order').toEqual([
      { unitId: 3, name: 'Cindertail', xp: 53, essence: 7 },
      { unitId: 2, name: 'Sprigg', xp: 59, essence: 11 },
    ]);
    expect(typeof vm?.currency, 'the gold is a bigint').toBe('bigint');
    expect(vm?.currency, 'the gold of BOTH Awards lines, 2^53 + 1 exactly').toBe(GOLD_TOTAL);
    expect(vm?.currency, 'not the unit-0 line alone').not.toBe(GOLD_ON_UNIT_0);

    const sideB = resultsVM(input({ mySide: 'B' }));
    expect(sideB?.monsters, 'on side B: the side-B monster only').toEqual([
      { unitId: 5, name: 'Rival Mossback', xp: 61, essence: 13 },
    ]);
    expect(sideB?.currency, 'the gold total does not depend on the side').toBe(GOLD_TOTAL);

    const quiet = resultsVM(input({ events: [] }));
    expect(quiet?.monsters, 'no transcript: no lines').toEqual([]);
    expect(quiet?.recruits, 'and no recruits').toEqual([]);
    expect(quiet?.currency, 'and no gold').toBe(0n);
  });

  it('resultsVM lists one recruit per SUCCESSFUL recruit made by a unit on my side, named by the TARGET unit`s species, in event order; a failed attempt, a rival`s recruit and a target with no unit row are left out [BT12-4-RESULTS-VM-RECRUITS]', () => {
    // WRONG IMPL KILLED: a failed attempt listed (`success` ignored); the recruiter's species named
    // instead of the target's (Sproutle / Emberfang instead of Duskling / Tidepup); a rival's
    // recruit listed as mine; a missing target unit that throws or prints an `undefined` name; the
    // species read through monsterName (a wild has no monster).
    const events = [
      ev(1, recruit(2, 7, true)),
      ev(2, recruit(2, 9, false)),
      ev(3, recruit(5, 7, true)),
      ev(4, recruit(2, 31, true)),
      ev(5, recruit(3, 9, true)),
    ];
    const vm = resultsVM(input({ events }));
    expect(
      vm?.recruits.map((r) => r.name),
      'my two successful recruits, by the target`s species, in event order',
    ).toEqual(['Duskling', 'Tidepup']);
    const asB = resultsVM(input({ events, mySide: 'B' }));
    expect(
      asB?.recruits.map((r) => r.name),
      'on side B: the rival`s recruit',
    ).toEqual(['Duskling']);
    expect(vm?.monsters, 'no Awards: no monster lines').toEqual([]);
  });

  it('resultsVM reads the RAW outcome against my side: SideAWins is won for side A and lost for side B, SideBWins the reverse, Fled is fled for both, and an Ongoing or unknown outcome has no results [BT12-4-RESULTS-VM-OUTCOME]', () => {
    // WRONG IMPL KILLED: the side ignored (side B's player told they won when A won: the PvP
    // swap); SideAWins and SideBWins both read as won; Fled read as lost; results for an Ongoing
    // battle (the panel would show mid-battle); an unknown tag read as a win.
    const cases: ReadonlyArray<readonly [string, RuleSide, string | null]> = [
      ['SideAWins', 'A', 'won'],
      ['SideAWins', 'B', 'lost'],
      ['SideBWins', 'A', 'lost'],
      ['SideBWins', 'B', 'won'],
      ['Fled', 'A', 'fled'],
      ['Fled', 'B', 'fled'],
      ['Ongoing', 'A', null],
      ['Ongoing', 'B', null],
      ['Draw', 'A', null],
    ];
    for (const [outcome, mySide, want] of cases) {
      const vm = resultsVM(input({ outcome, mySide }));
      expect(vm?.outcome ?? null, `${outcome} seen from side ${mySide}`).toBe(want);
      if (want === null) expect(vm, `${outcome}: no results at all`).toBeNull();
    }
  });
});

// --- the panel --------------------------------------------------------------------------------------

describe('results: the panel (bt-12, BT12.4)', () => {
  it('the results panel is a battle-frame shell holding the title, the lines (monsters, recruits, then the gold only when there is any, or one none line) and a Continue button, and an equal re-render writes nothing, keeping the Continue node and its focus [BT12-4-RESULTS-DOM]', () => {
    // WRONG IMPL KILLED: the lines out of order or a gold line for 0 gold; no `none` line for an
    // empty result (a blank list); the Continue a non-button or a submit button; the panel visible
    // before show(); an equal VM (a batch that changed nothing) rebuilding the list and the button
    // (the focused Continue loses focus every batch: A10 / B4), or a compare via JSON.stringify
    // (throws on the bigint gold); a changed VM NOT repainted.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const panel = new ResultsPanel(host, { onContinue: () => {} });
    const root = host.querySelector<HTMLElement>('.tactics-results');
    expect(root, 'the root is built under the parent').not.toBeNull();
    if (root === null) return;
    for (const cls of ['mr-frame', 'mr-shell', 'mr-shell--top', 'mr-shell--battle']) {
      expect(root.classList.contains(cls), `the root is a battle-frame shell: .${cls}`).toBe(true);
    }
    expect(panel.visible, 'hidden until shown').toBe(false);
    expect(root.style.display, 'display none until shown').toBe('none');
    panel.render(VM);
    panel.show();
    expect(panel.visible, 'shown').toBe(true);
    expect(root.style.display, 'displayed').not.toBe('none');
    expect(root.getAttribute('role'), 'the open dialog').toBe('dialog');
    const kids = [...root.children];
    expect(kids[0]?.matches('h2.tactics-title'), 'first the title').toBe(true);
    expect(kids[0]?.getAttribute('data-testid'), 'the frame anchor').toBe('battle-title');
    expect(kids[0]?.getAttribute('tabindex'), 'focusable by script only').toBe('-1');
    expect(kids[1]?.matches('ul.tactics-results-list'), 'then the list').toBe(true);
    expect(kids[2]?.matches('button.tactics-results-continue'), 'then Continue').toBe(true);
    expect(
      lines(root).map((li) => li.getAttribute('data-line')),
      'monsters, recruits, then the gold',
    ).toEqual(['monster', 'monster', 'recruit', 'currency']);
    const button = root.querySelector<HTMLButtonElement>('button.tactics-results-continue');
    expect(button?.getAttribute('type'), 'a plain button').toBe('button');

    button?.focus();
    expect(document.activeElement, 'fixture: Continue has focus').toBe(button);
    const firstLine = lines(root)[0];
    panel.render(structuredClone(VM));
    expect(
      root.querySelector('button.tactics-results-continue'),
      'an equal VM keeps the SAME Continue node',
    ).toBe(button);
    expect(lines(root)[0], 'and the same line nodes').toBe(firstLine);
    expect(document.activeElement, 'so Continue keeps focus').toBe(button);

    panel.render({ ...VM, monsters: [], recruits: [], currency: 0n });
    expect(
      lines(root).map((li) => li.getAttribute('data-line')),
      'nothing earned: one none line',
    ).toEqual(['none']);
    panel.render({ ...VM, recruits: [], currency: 0n });
    expect(
      lines(root).map((li) => li.getAttribute('data-line')),
      'no gold: no gold line',
    ).toEqual(['monster', 'monster']);
    panel.render({ ...VM, monsters: [], recruits: [], currency: 7n });
    expect(
      lines(root).map((li) => li.getAttribute('data-line')),
      'gold alone',
    ).toEqual(['currency']);
    panel.hide();
    expect(panel.visible, 'hidden').toBe(false);
    expect(root.style.display, 'display none').toBe('none');
    expect(root.getAttribute('role'), 'the dialog record closed').toBeNull();
    expect(root.querySelector('[aria-live]'), 'no live region').toBeNull();
  });

  it('a click on Continue continues at once, once per click, with no timer [BT12-4-RESULTS-SKIP]', () => {
    // WRONG IMPL KILLED: a Continue that waits for the countdown (not skippable); a Continue wired
    // to nothing or to a timer; a click that continues twice (two listeners) or never.
    const m = mountPanel(VM);
    expect(m.continues(), 'nothing before a click').toBe(0);
    m.root
      .querySelector('button.tactics-results-continue')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(m.continues(), 'one click, one continue, synchronously').toBe(1);
    m.root
      .querySelector('button.tactics-results-continue')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(m.continues(), 'a second click, a second continue').toBe(2);
  });

  it('the results continue on their own once the outcome frame has been on top for the cap, and only while the results panel is what it shows: never before the cap, never with no shown edge, never for another view [BT12-4-RESULTS-AUTO-ADVANCE]', () => {
    // WRONG IMPL KILLED: a literal 3000 instead of the cap given (the cap here is 2999 and 3001,
    // primes); `>` instead of `>=` (the cap itself is the advance); a null shown-edge read as 0 (a
    // frame over the outcome would not pause it); a shown-edge of 0 read as "never shown"
    // (`!shownAt`); the 1v1 outcome view (resultsShown false) auto-continued; a clock running
    // backwards treated as elapsed.
    const CAP = 2_999;
    const SHOWN = 1_009;
    expect(shouldAutoContinue(null, SHOWN + CAP * 2, true, CAP), 'no shown edge: never').toBe(
      false,
    );
    expect(shouldAutoContinue(SHOWN, SHOWN + CAP - 1, true, CAP), 'one ms before the cap').toBe(
      false,
    );
    expect(shouldAutoContinue(SHOWN, SHOWN + CAP, true, CAP), 'at the cap').toBe(true);
    expect(shouldAutoContinue(SHOWN, SHOWN + CAP + 7, true, CAP), 'past the cap').toBe(true);
    expect(shouldAutoContinue(SHOWN, SHOWN + CAP, false, CAP), 'not the results panel: never').toBe(
      false,
    );
    expect(
      shouldAutoContinue(SHOWN, SHOWN + 2_999, true, 3_001),
      'the cap is the one given, not a constant',
    ).toBe(false);
    expect(shouldAutoContinue(SHOWN, SHOWN + 3_001, true, 3_001), 'at the other cap').toBe(true);
    expect(shouldAutoContinue(0, CAP, true, CAP), 'a shown edge at 0 is a real edge').toBe(true);
    expect(shouldAutoContinue(SHOWN, SHOWN - 13, true, CAP), 'a clock before the edge').toBe(false);
  });
});

// --- BT12.6: the text ---------------------------------------------------------------------------------

describe('results: every string from the catalog (bt-12, BT12.6)', () => {
  it('every text and accessible name the results panel paints is exactly its catalog value or model data, in English and in French: the title is the shipped battle outcome text of each outcome, then the list label, the XP and essence lines, the recruit line, the gold line, the none line and Continue [BT12-6-RESULTS-TEXT-FROM-CATALOG]', () => {
    // WRONG IMPL KILLED: a literal English word (a French boot shows it: the sweep finds it); the
    // title from `battle.title` or a fresh key instead of `battle.outcome.*` (B8); the won / lost
    // titles swapped; a line built by concatenation (the catalog's own wording is pinned); the gold
    // through Number() (2^53 + 1 printed as ...992); a live region on the panel.
    for (const key of [
      'tactics.results.label',
      'tactics.results.none',
      'tactics.results.continue',
    ]) {
      expect(cat(FR, key), `${key}: the French is a translation`).not.toBe(cat(EN, key));
    }
    const TITLES: ReadonlyArray<readonly [ResultsVM['outcome'], string]> = [
      ['won', 'battle.outcome.victory'],
      ['lost', 'battle.outcome.defeat'],
      ['fled', 'battle.outcome.fled'],
    ];
    for (const [locale, C] of [
      ['en', EN],
      ['fr', FR],
    ] as const) {
      setLocale(locale);
      for (const [outcome, key] of TITLES) {
        const m = mountPanel({ ...VM, outcome });
        expect(
          m.root.querySelector('h2.tactics-title')?.textContent,
          `${locale} ${outcome}: the title is ${key}`,
        ).toBe(cat(C, key));
        m.panel.hide();
      }
      const m = mountPanel(VM);
      const root = m.root;
      expect(
        root.querySelector('h2.tactics-title')?.textContent,
        `${locale}: never the 1v1 view's battle.title`,
      ).not.toBe(cat(C, 'battle.title'));
      expect(
        root.querySelector('ul.tactics-results-list')?.getAttribute('aria-label'),
        `${locale}: the list's name`,
      ).toBe(cat(C, 'tactics.results.label'));
      const expectedLines = [
        cat(C, 'tactics.results.monster', { name: 'Cindertail', xp: 53, essence: 7 }),
        cat(C, 'tactics.results.monster', { name: 'Sprigg', xp: 59, essence: 11 }),
        cat(C, 'tactics.results.recruited', { name: 'Duskling' }),
        cat(C, 'tactics.results.currency', { amount: GOLD_TOTAL }),
      ];
      expect(
        lines(root).map((li) => li.textContent),
        `${locale}: each line is its catalog line`,
      ).toEqual(expectedLines);
      expect(
        (lines(root)[3]?.textContent ?? '').includes('9007199254740993'),
        `${locale}: the gold printed digit for digit`,
      ).toBe(true);
      expect(
        root.querySelector('button.tactics-results-continue')?.textContent,
        `${locale}: Continue`,
      ).toBe(cat(C, 'tactics.results.continue'));
      const allowed = new Set([
        cat(C, 'battle.outcome.victory'),
        ...expectedLines,
        cat(C, 'tactics.results.continue'),
      ]);
      expect(
        textsOf(root).filter((text) => !allowed.has(text)),
        `${locale}: the panel paints no other text`,
      ).toEqual([]);
      m.panel.render({ ...VM, monsters: [], recruits: [], currency: 0n });
      expect(
        lines(root).map((li) => li.textContent),
        `${locale}: the none line`,
      ).toEqual([cat(C, 'tactics.results.none')]);
      expect(root.hasAttribute('aria-live'), `${locale}: no live region on the root`).toBe(false);
      m.panel.hide();
    }
  });
});
