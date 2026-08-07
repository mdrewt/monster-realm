// @vitest-environment happy-dom
// ui/evolutionView.test.ts — EG4 gating tests for the evolution overlay's DOM shell.
//
// SOURCE OF TRUTH: memory/projects/monster-realm-EG4-contract.md §C (the frozen
// EvolutionViewModel), §F (main.ts's `onEvolve: (monsterId, toSpecies) => void`), §G
// (EARS EG4-1 / EG4-2 / EG4-5 and the A3 row), plus specs/monster-realm-v2/
// M-evolution-essence-graph.spec.md §2.
//
// WHY THIS FILE EXISTS AT ALL (red-team finding D3, adjudicated ACCEPTED)
//   `src/ui/evolutionView.ts` is a coverage-excluded DOM shell (client/vite.config.ts
//   `coverage.exclude`, an exact set guarded by evals/dom-shell-coverage-exclusion) and
//   there is no TS mutation harness. Until this file existed, EG4-1's requirements/
//   progress panel and EG4-2's multi-choice picker — the slice's MARQUEE deliverables —
//   had ZERO rendering gate, while EG4-8's much smaller badge got four (boxView.test.ts
//   X7-X10). Every view-model test in evolutionModel.test.ts can be green while this
//   overlay renders nothing at all, or still renders a fusion recipe list. VACUITY is
//   therefore the primary risk here: every positive case below ships a control or a
//   named anchor, exactly as boxView.test.ts X7-X10 do.
//
// CONTRACT UNDER TEST — SYMBOLIC ANCHORS ONLY (boxView.test.ts's discipline: cite the
// METHOD or the data-testid, never a line number — line anchors in this repo drifted
// twice inside a single slice). The shell must emit these five testids:
//   • `evo-monster-card`  — one per `vm.monsters` entry;
//   • `evo-path-row`      — one per `mon.paths` entry, INSIDE that monster's card. This
//                           is the progress panel: ALL outgoing edges, met and unmet;
//   • `evo-gate-row`      — one per `path.gates` entry, INSIDE that path's row, and
//                           carrying BOTH `currentText` and `requiredText`. A row that
//                           renders only the requirement is EG4-1 with the progress half
//                           missing (contract A5);
//   • `evo-choice`        — one selectable control per `mon.choices` entry. By the
//                           view-model's construction `choices` is non-empty ONLY at
//                           `eligibleCount >= 2`, so this testid must NEVER appear at 0
//                           or 1 eligible;
//   • `evo-ready-note`    — the `readyPathName` informational copy, present IFF
//                           `readyPathName !== null`. INFORMATIONAL, never an action (A3).
//
// The FORMAT of every string the shell composes is deliberately NOT pinned (the contract
// leaves `currentText`/`requiredText` open): the assertions check that the view-model's
// own strings REACH the DOM, not how they are decorated.
//
// RED REASON (verified against client/src/ui/evolutionView.ts this session): the shell
// still reads `vm.fusionRecipes` in `refresh()` and `callbacks.onFuse` in the Fuse
// button's listener, renders a `Fusion Recipes:` block and an `Evolution & Fusion` title,
// and its `#renderCard` reads the RETIRED `mon.bond` / `mon.canEvolve` /
// `mon.evolvesToSpeciesName`. It emits none of the five testids above. `refresh()`
// therefore THROWS on the contract-shaped view-models below (`recipes.length` on
// `undefined`) — a missing implementation, not a fixture typo: the field it reads was
// deleted by EG4-5 / contract §B.
//
// CI HYGIENE: literal regexes and String.indexOf/.includes ONLY — `new RegExp(...)` is
// Semgrep-banned repo-wide (`--config auto --error`; it has broken this repo's CI twice).
// No `innerHTML` write anywhere in this file.
//
// WHAT THESE CASES CAN AND CANNOT PROVE (same disclosure as boxView.test.ts): happy-dom
// does no layout, so every assertion proves "the element is PRESENT and is not
// display:none" — never that it is visible in a viewport.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EvolutionGateViewModel,
  EvolutionMonsterViewModel,
  EvolutionPathViewModel,
  EvolutionViewModel,
} from './evolutionModel';
import { EvolutionView, type EvolutionViewCallbacks } from './evolutionView';

// ---------------------------------------------------------------------------
// Frozen anchors
// ---------------------------------------------------------------------------

const CARD_SELECTOR = '[data-testid="evo-monster-card"]';
const PATH_ROW_SELECTOR = '[data-testid="evo-path-row"]';
const GATE_ROW_SELECTOR = '[data-testid="evo-gate-row"]';
const CHOICE_SELECTOR = '[data-testid="evo-choice"]';
const READY_NOTE_SELECTOR = '[data-testid="evo-ready-note"]';

// ---------------------------------------------------------------------------
// Fixtures — plain literals matching contract §C exactly.
// ---------------------------------------------------------------------------

function gate(
  kind: EvolutionGateViewModel['kind'],
  label: string,
  currentText: string,
  requiredText: string,
  met: boolean,
): EvolutionGateViewModel {
  return { kind, label, currentText, requiredText, met };
}

/**
 * The five gate rows of one blocked path. Every `currentText` and every `requiredText`
 * is a DISTINCT, unmistakable string — no substring of one is a substring of another —
 * so "the row rendered the requirement twice" and "the row rendered the wrong gate's
 * value" both fail rather than pass by collision.
 */
const FIVE_GATES: readonly EvolutionGateViewModel[] = [
  gate('level', 'Level', 'Lv 17', 'Lv 20', false),
  gate('essence', 'Fire essence', 'Fire 33', 'Fire 120', false),
  gate('trust', 'Trust', 'Wary', 'Friendly', false),
  gate('qualityTime', 'Quality time', 'QT 1', 'QT 3', false),
  gate('nutrition', 'Nutrition', '41%', '60%', false),
];

function pathVm(overrides: Partial<EvolutionPathViewModel> = {}): EvolutionPathViewModel {
  return {
    edgeId: 1,
    toSpecies: 2,
    toSpeciesName: 'Pyrodrake',
    met: false,
    unmetReason: 'requires level 20',
    gates: FIVE_GATES,
    ...overrides,
  };
}

/** A met path emits gate rows too — the panel shows cleared requirements as cleared. */
function metPathVm(overrides: Partial<EvolutionPathViewModel> = {}): EvolutionPathViewModel {
  return pathVm({
    met: true,
    unmetReason: null,
    gates: [gate('level', 'Level', 'Lv 30', 'Lv 20', true)],
    ...overrides,
  });
}

function monsterVm(overrides: Partial<EvolutionMonsterViewModel> = {}): EvolutionMonsterViewModel {
  return {
    monsterId: 77n,
    speciesName: 'Flameling',
    nickname: 'Blaze',
    level: 30,
    tier: 1,
    trustTier: 'Wary',
    qualityTimeTier: 1,
    nutritionPct: 41,
    paths: [pathVm()],
    eligibleCount: 0,
    choices: [],
    readyPathName: null,
    ...overrides,
  };
}

function viewModel(...monsters: EvolutionMonsterViewModel[]): EvolutionViewModel {
  return { monsters };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Callbacks with a spy on EVERY member the shell could plausibly reach — including the
 * RETIRED `onFuse`, deliberately. EG4-5 deletes it from `EvolutionViewCallbacks`, and the
 * runtime probe for "it is gone" is that no interaction anywhere in the overlay can make
 * this spy fire. Handing the shell an `onFuse` it must never call is strictly stronger
 * than omitting it (an omitted member would surface as a TypeError, which a `try/catch`
 * in the shell could swallow).
 */
type SpiedCallbacks = EvolutionViewCallbacks & {
  onEvolve: ReturnType<typeof vi.fn>;
  onFuse: ReturnType<typeof vi.fn>;
};

function makeCallbacks(): SpiedCallbacks {
  return {
    onEvolve: vi.fn(),
    onFuse: vi.fn(),
  } as unknown as SpiedCallbacks;
}

function mount(): {
  parent: HTMLElement;
  view: EvolutionView;
  callbacks: ReturnType<typeof makeCallbacks>;
} {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const callbacks = makeCallbacks();
  const view = new EvolutionView(parent, callbacks);
  return { parent, view, callbacks };
}

/** The single card element for a monster, with a loud precondition. */
function cardOf(parent: HTMLElement, index = 0): HTMLElement {
  const cards = parent.querySelectorAll(CARD_SELECTOR);
  expect(
    cards.length,
    `precondition: the overlay must render a [data-testid="evo-monster-card"] per monster — ` +
      'without it every containment assertion made through it is vacuous',
  ).toBeGreaterThan(index);
  return cards[index] as HTMLElement;
}

/** Find the ONE element under `root` matching `selector` whose text contains `needle`. */
function elementNamed(root: HTMLElement, selector: string, needle: string): HTMLElement {
  const hits = [...root.querySelectorAll(selector)].filter((el) =>
    (el.textContent ?? '').includes(needle),
  );
  expect(
    hits.length,
    `precondition: exactly one "${selector}" under this root must name "${needle}" — ` +
      `found ${hits.length}. A control the player cannot tell apart from its sibling is ` +
      'not a choice.',
  ).toBe(1);
  return hits[0] as HTMLElement;
}

/**
 * Dispatch a bubbling click on EVERY element in the subtree (the element itself included).
 *
 * This is the idiom-agnostic way to assert "there is no evolve affordance ANYWHERE": it
 * does not care whether the affordance is a `<button>`, an `<a>`, a `<div>` with a click
 * listener, or a handler bound on the card that a child click bubbles into — which is
 * exactly the shape the shell uses today (`card.addEventListener('click', ...)`).
 */
function clickEverything(root: HTMLElement): number {
  const all = [root, ...root.querySelectorAll('*')];
  let clicked = 0;
  for (const el of all) {
    const target = el as HTMLElement;
    if (typeof target.dispatchEvent !== 'function') continue;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    clicked++;
  }
  return clicked;
}

// REQUIRED, not hygiene theatre: a document-scoped query resolving to a STALE overlay
// left by an earlier case is how a DOM suite goes spuriously red — or vacuously green.
afterEach(() => {
  document.body.replaceChildren();
});

// ===========================================================================
// V1 (EG4-1) — the requirements/PROGRESS panel
// ===========================================================================

describe('EvolutionView V1 (EG4-1): the progress panel renders a row per path and a row per gate', () => {
  it('★ BITES: every outgoing path renders a row, and every gate renders CURRENT and REQUIRED', () => {
    // KILLS (1): a card that renders only the target species name — the "→ Pyrodrake"
    //   line the M10c shell ships today. EG4-1 is a requirements/PROGRESS panel: a player
    //   who cannot see WHICH gate is blocking them and HOW FAR OFF they are has been told
    //   nothing actionable, and the essence graph's whole point is that there are five
    //   independent axes to raise.
    // KILLS (2): rendering `requiredText` only (the requirements half without the progress
    //   half — contract A5's named failure mode). Every currentText below is a distinct
    //   string that appears nowhere else in the fixture, so a missing current value cannot
    //   be masked by a collision.
    // KILLS (3): a panel that lists only the ELIGIBLE paths — `mon.paths` is the FULL
    //   outgoing set, and the 0-eligible monster is the one that most needs to read it.
    // KILLS (4): gate rows hoisted out of their path's row (flattened into the card). With
    //   two paths carrying different gate counts, a flattened render cannot satisfy the
    //   per-row counts below.
    const { parent, view } = mount();
    const mon = monsterVm({
      paths: [
        pathVm({ edgeId: 2, toSpecies: 2, toSpeciesName: 'Pyrodrake' }), // blocked, 5 gates
        metPathVm({ edgeId: 5, toSpecies: 3, toSpeciesName: 'Cindermaw' }), // met, 1 gate
      ],
      eligibleCount: 1,
      choices: [],
      readyPathName: 'Cindermaw',
    });
    view.refresh(viewModel(mon));
    view.show();

    const card = cardOf(parent);
    const rows = card.querySelectorAll(PATH_ROW_SELECTOR);
    expect(
      rows.length,
      'EG4-1 (V1): the panel must render one row per OUTGOING path — both the reachable ' +
        'one and the blocked one',
    ).toBe(2);

    const blocked = elementNamed(card, PATH_ROW_SELECTOR, 'Pyrodrake');
    const reachable = elementNamed(card, PATH_ROW_SELECTOR, 'Cindermaw');

    // The blocked row states WHY, in the model's own words (the same string the server's
    // reject message uses — evolutionModel.test.ts pins the format, this pins the wiring).
    expect(
      blocked.textContent ?? '',
      'EG4-1 (V1): a blocked path must render its unmetReason — a path shown as blocked ' +
        'with no explanation is the requirements panel with the requirements missing',
    ).toContain('requires level 20');

    // ...one gate row per gate, INSIDE that path's row.
    const blockedGates = blocked.querySelectorAll(GATE_ROW_SELECTOR);
    expect(
      blockedGates.length,
      'EG4-1 (V1): the blocked path carries five gates, so its row must carry five gate rows',
    ).toBe(5);
    expect(
      reachable.querySelectorAll(GATE_ROW_SELECTOR).length,
      'EG4-1 (V1): the reachable path carries ONE gate — a per-path count, not a constant',
    ).toBe(1);
    expect(
      card.querySelectorAll(GATE_ROW_SELECTOR).length,
      'EG4-1 (V1): 5 + 1 gate rows in the card total — proves the rows are NESTED in their ' +
        'own path row and not duplicated or hoisted',
    ).toBe(6);

    // ...and each gate row carries its label, its CURRENT value and its REQUIRED value.
    for (const g of FIVE_GATES) {
      const row = elementNamed(blocked, GATE_ROW_SELECTOR, g.label);
      const text = row.textContent ?? '';
      expect(
        text,
        `EG4-1 (V1): the "${g.label}" gate row must render the monster's CURRENT value ` +
          `("${g.currentText}"). Rendering only the requirement is A5's named defect: the ` +
          'panel becomes a yes/no with no progress in it',
      ).toContain(g.currentText);
      expect(
        text,
        `EG4-1 (V1): the "${g.label}" gate row must render the REQUIRED value ` +
          `("${g.requiredText}")`,
      ).toContain(g.requiredText);
    }

    // ANTI-VACUITY: the met path's cleared gate renders too, with ITS own numbers — so
    // "gate rows are only emitted for unmet gates" (which would hide a player's progress
    // the moment they cleared a gate) also reds.
    const clearedGate = reachable.querySelector(GATE_ROW_SELECTOR) as HTMLElement;
    expect(clearedGate.textContent ?? '').toContain('Lv 30');
    expect(clearedGate.textContent ?? '').toContain('Lv 20');
  });

  it('BITES: a monster with NO outgoing paths renders a card and zero path rows, no throw', () => {
    // Reached on every fresh connect (refreshEvolution runs before the evolution_path
    // subscription applies) and permanently for every top-tier species.
    // KILLS: `paths[0]` indexing, and a card suppressed entirely when it has no edges —
    // the player would think the monster had vanished from the screen.
    const { parent, view } = mount();
    expect(() => {
      view.refresh(viewModel(monsterVm({ paths: [], eligibleCount: 0, readyPathName: null })));
    }).not.toThrow();
    view.show();
    expect(parent.querySelectorAll(CARD_SELECTOR)).toHaveLength(1);
    expect(parent.querySelectorAll(PATH_ROW_SELECTOR)).toHaveLength(0);
    expect(parent.querySelectorAll(GATE_ROW_SELECTOR)).toHaveLength(0);
    expect(cardOf(parent).textContent ?? '').toContain('Blaze');
  });

  it('BITES: repeated refresh() does not accumulate cards, path rows or gate rows', () => {
    // KILLS: an append-without-clear render. refresh() fires on EVERY batch-applied, so a
    // missing `replaceChildren()`/`textContent = ''` makes the panel grow without bound
    // during normal play — and every count assertion in this file would then be
    // order-of-execution dependent.
    const { parent, view } = mount();
    const vm = viewModel(monsterVm({ paths: [pathVm(), metPathVm({ edgeId: 5 })] }));
    view.refresh(vm);
    view.refresh(vm);
    view.refresh(vm);
    view.show();
    expect(parent.querySelectorAll(CARD_SELECTOR)).toHaveLength(1);
    expect(parent.querySelectorAll(PATH_ROW_SELECTOR)).toHaveLength(2);
    expect(parent.querySelectorAll(GATE_ROW_SELECTOR)).toHaveLength(6);
  });
});

// ===========================================================================
// V2 (EG4-2) — at exactly ONE eligible path there is NO evolve affordance
// ===========================================================================

describe('EvolutionView V2 (EG4-2): at eligibleCount === 1 there is NO clickable evolve affordance', () => {
  it('★★ BITES: one eligible path → zero choice controls, and clicking EVERY element never calls onEvolve', () => {
    // ★★ THE EG4-2 TOOTH. The spec is explicit that the client SHALL NOT present an Evolve
    //   action for the single-eligible case: the server auto-applies it (EG2-11), so a
    //   button there is an action the player must never be offered — click it and the
    //   reducer either no-ops or races the auto-apply.
    // KILLS (1): the shipped M10c "Evolve" button surviving the rewrite (today's state).
    // KILLS (2): a `choices`-driven picker rendered from `paths.filter(met)` instead of
    //   from `choices` — the view-model keeps `choices` empty at 1 eligible precisely so
    //   the view cannot get this wrong, and re-deriving it in the shell throws that away.
    // KILLS (3): an affordance that is not a <button> — a clickable card or row. The
    //   click sweep does not care about the tag: it dispatches a bubbling click on every
    //   node in the overlay, which is also how the shell's current card-level
    //   `addEventListener('click', ...)` would be caught.
    const { parent, view, callbacks } = mount();
    view.refresh(
      viewModel(
        monsterVm({
          paths: [
            metPathVm({ edgeId: 2, toSpecies: 2, toSpeciesName: 'Pyrodrake' }),
            pathVm({ edgeId: 5, toSpecies: 3, toSpeciesName: 'Cindermaw' }),
          ],
          eligibleCount: 1,
          choices: [],
          readyPathName: 'Pyrodrake',
        }),
      ),
    );
    view.show();

    expect(
      parent.querySelectorAll(CHOICE_SELECTOR),
      'EG4-2 (V2): `choices` is empty at exactly one eligible path, so the overlay must ' +
        'render NO [data-testid="evo-choice"] control',
    ).toHaveLength(0);

    const swept = clickEverything(parent);
    expect(
      swept,
      'ANTI-VACUITY: the sweep must actually have clicked something — a zero here means ' +
        'the overlay rendered nothing and the assertion below proves nothing',
    ).toBeGreaterThan(3);
    expect(
      callbacks.onEvolve,
      'EG4-2 (V2): NOTHING in the overlay may invoke onEvolve while exactly one path is ' +
        'eligible. The server auto-applies that evolution (EG2-11); an affordance here ' +
        'offers the player an action that does not exist',
    ).not.toHaveBeenCalled();
  });

  it('★ BITES: ZERO eligible paths → no choice control either, and no onEvolve on any click', () => {
    // KILLS: `>= 0` / an unconditional picker. The 0-eligible monster is the common case
    //   at low level and must be purely informational.
    const { parent, view, callbacks } = mount();
    view.refresh(
      viewModel(
        monsterVm({ paths: [pathVm()], eligibleCount: 0, choices: [], readyPathName: null }),
      ),
    );
    view.show();
    expect(parent.querySelectorAll(CHOICE_SELECTOR)).toHaveLength(0);
    clickEverything(parent);
    expect(callbacks.onEvolve).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// V3 (EG4-2) — at TWO+ eligible, one control per choice, each sending ITS OWN target
// ===========================================================================

describe('EvolutionView V3 (EG4-2): 2+ eligible renders one control per choice and sends the RIGHT toSpecies', () => {
  const TWO_CHOICES: readonly EvolutionPathViewModel[] = [
    metPathVm({ edgeId: 3, toSpecies: 2, toSpeciesName: 'Pyrodrake' }),
    metPathVm({ edgeId: 6, toSpecies: 3, toSpeciesName: 'Cindermaw' }),
  ];

  function mountTwoChoice() {
    const h = mount();
    h.view.refresh(
      viewModel(
        monsterVm({
          monsterId: 77n,
          paths: [...TWO_CHOICES, pathVm({ edgeId: 9, toSpecies: 4, toSpeciesName: 'Emberwing' })],
          eligibleCount: 2,
          choices: TWO_CHOICES,
          readyPathName: null,
        }),
      ),
    );
    h.view.show();
    return h;
  }

  it('★★ BITES: exactly one control PER CHOICE, each naming its own target species', () => {
    // KILLS (1): a single "Evolve" button for an ambiguous monster — the client would have
    //   to pick, which is the auto-resolve EG4-2 exists to forbid.
    // KILLS (2): a control per PATH rather than per CHOICE — the blocked Emberwing edge is
    //   in `paths` but not in `choices`, so a 3-control render offers the player an
    //   evolution the server will reject.
    // KILLS (3): unlabelled controls. Two identical buttons are not a choice; the player
    //   must be able to tell which one is which BEFORE clicking an irreversible action.
    const { parent } = mountTwoChoice();
    const controls = parent.querySelectorAll(CHOICE_SELECTOR);
    expect(
      controls.length,
      'EG4-2 (V3): two eligible paths → exactly two choice controls (the third, blocked, ' +
        'path must NOT get one)',
    ).toBe(2);
    const texts = [...controls].map((c) => c.textContent ?? '');
    expect(texts.some((t) => t.includes('Pyrodrake'))).toBe(true);
    expect(texts.some((t) => t.includes('Cindermaw'))).toBe(true);
    expect(
      texts.some((t) => t.includes('Emberwing')),
      'EG4-2 (V3): the blocked path must not be offered as a choice',
    ).toBe(false);
  });

  it('★★ BITES: clicking the SECOND choice sends ITS toSpecies — a first-match picker dies here', () => {
    // ★★ THE `[0]` / `.find()` KILLER. Two DISTINCT targets and the assertion names the
    //   SECOND one: a picker that forwards `choices[0].toSpecies`, or a shared handler
    //   closed over the wrong loop variable, sends 2 where the player asked for 3 — and
    //   evolution is irreversible. A single-choice fixture cannot tell the two apart.
    // KILLS: forwarding `monsterId` only (the pre-EG4 signature), forwarding the edgeId in
    //   the toSpecies position (3 vs 6 — distinct on purpose), and calling onEvolve more
    //   than once per click (a listener registered on every refresh).
    const { parent, callbacks } = mountTwoChoice();
    const cindermaw = elementNamed(parent, CHOICE_SELECTOR, 'Cindermaw');
    cindermaw.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(
      callbacks.onEvolve,
      'EG4-2/§F (V3): clicking a choice must invoke onEvolve exactly once, with the ' +
        "monster's id and the CHOSEN target species — `onEvolve(monsterId, toSpecies)`",
    ).toHaveBeenCalledTimes(1);
    expect(callbacks.onEvolve).toHaveBeenCalledWith(77n, 3);
    // Explicit: not the OTHER choice's species, and not the edgeId (6) either.
    expect(callbacks.onEvolve).not.toHaveBeenCalledWith(77n, 2);
    expect(callbacks.onEvolve).not.toHaveBeenCalledWith(77n, 6);
  });

  it('★ BITES: clicking the FIRST choice sends ITS OWN toSpecies (so the handler is not hard-coded)', () => {
    // Paired with the case above: together they prove the target is READ from the choice
    // that was clicked. Either case alone is satisfiable by a constant.
    const { parent, callbacks } = mountTwoChoice();
    const pyrodrake = elementNamed(parent, CHOICE_SELECTOR, 'Pyrodrake');
    pyrodrake.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(callbacks.onEvolve).toHaveBeenCalledTimes(1);
    expect(callbacks.onEvolve).toHaveBeenCalledWith(77n, 2);
    expect(callbacks.onEvolve).not.toHaveBeenCalledWith(77n, 3);
  });

  it('★★ BITES: the monsterId is per-card — two ambiguous monsters do not cross-wire', () => {
    // KILLS: a handler closed over the last-rendered monster (the classic `for`-loop
    //   capture bug) OR over the first — either one evolves the WRONG monster, and
    //   evolution is irreversible.
    //
    // RED-TEAM SELF-CORRECTION: the first draft of this case clicked only the SECOND
    // monster's control and asserted `(22n, 3)`. A handler closed over the LAST rendered
    // monster produces exactly that, so the mutant survived — verified against a scratch
    // reference render before this file was finalized. Both controls are now clicked, in
    // order, and the FULL ordered call list is asserted: "always the last id" fails on the
    // first call, "always the first id" fails on the second. Neither can pass.
    const { parent, view, callbacks } = mount();
    const choicesFor = (a: string, b: string): readonly EvolutionPathViewModel[] => [
      metPathVm({ edgeId: 3, toSpecies: 2, toSpeciesName: a }),
      metPathVm({ edgeId: 6, toSpecies: 3, toSpeciesName: b }),
    ];
    view.refresh(
      viewModel(
        monsterVm({
          monsterId: 11n,
          nickname: 'Alpha',
          paths: choicesFor('Pyrodrake', 'Cindermaw'),
          eligibleCount: 2,
          choices: choicesFor('Pyrodrake', 'Cindermaw'),
        }),
        monsterVm({
          monsterId: 22n,
          nickname: 'Beta',
          paths: choicesFor('Emberwing', 'Foreignling'),
          eligibleCount: 2,
          choices: choicesFor('Emberwing', 'Foreignling'),
        }),
      ),
    );
    view.show();
    expect(parent.querySelectorAll(CARD_SELECTOR)).toHaveLength(2);
    expect(parent.querySelectorAll(CHOICE_SELECTOR)).toHaveLength(4);

    // RED-TEAM SELF-CORRECTION: overlay-scoped counts alone let a picker hoisted to the
    // overlay ROOT pass (the same defect the ready-note containment case pins). Two
    // ambiguous monsters means two INDEPENDENT decisions; a shared picker cannot express
    // them, and a control the player cannot attribute to a monster is not a choice.
    const alpha = elementNamed(parent, CARD_SELECTOR, 'Alpha');
    const beta = elementNamed(parent, CARD_SELECTOR, 'Beta');
    expect(
      alpha.querySelectorAll(CHOICE_SELECTOR),
      'EG4-2 (V3): each card must hold ITS OWN two choice controls — a picker hoisted to ' +
        'the overlay root is not attributable to a monster',
    ).toHaveLength(2);
    expect(beta.querySelectorAll(CHOICE_SELECTOR)).toHaveLength(2);

    // FIRST monster's control, then the SECOND — both target species 3, so the ONLY thing
    // that can distinguish the two calls is the monsterId each control closed over.
    elementNamed(parent, CHOICE_SELECTOR, 'Cindermaw').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    elementNamed(parent, CHOICE_SELECTOR, 'Foreignling').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(
      callbacks.onEvolve.mock.calls,
      "EG4-2 (V3): each card's choice must carry ITS OWN monsterId. The ordered call list " +
        'is asserted whole: a handler closed over the LAST rendered monster fails the first ' +
        'entry ([11n,3] would read [22n,3]); one closed over the FIRST fails the second',
    ).toEqual([
      [11n, 3],
      [22n, 3],
    ]);
  });
});

// ===========================================================================
// V4 (A3) — readyPathName is rendered, informational, and IFF eligibleCount === 1
// ===========================================================================

describe('EvolutionView V4 (A3): readyPathName renders as informational copy, and only at 1 eligible', () => {
  const READY = monsterVm({
    paths: [metPathVm({ edgeId: 2, toSpecies: 2, toSpeciesName: 'Pyrodrake' })],
    eligibleCount: 1,
    choices: [],
    readyPathName: 'Pyrodrake',
  });
  const NOT_READY = monsterVm({
    paths: [pathVm({ edgeId: 2, toSpecies: 2, toSpeciesName: 'Pyrodrake' })],
    eligibleCount: 0,
    choices: [],
    readyPathName: null,
  });

  it('★ BITES: at exactly one eligible path the ready note IS rendered and names the target', () => {
    // KILLS: dropping `readyPathName` from the shell. A3 was adjudicated precisely because
    //   a monster can sit at exactly-1-eligible INDEFINITELY (a content republish adds an
    //   edge; boxed monsters; enqueue_move's ~60s QT-tick gate), so the EARS premise "the
    //   server has already auto-applied it" is false in at least three reachable states.
    //   Rendering that state identically to 0-eligible tells the player nothing is
    //   happening when in fact everything is ready.
    const { parent, view } = mount();
    view.refresh(viewModel(READY));
    view.show();
    const note = parent.querySelector(READY_NOTE_SELECTOR) as HTMLElement | null;
    expect(
      note,
      'A3 (V4): a [data-testid="evo-ready-note"] must render at 1 eligible',
    ).not.toBeNull();
    expect(
      (note!.textContent ?? '').trim().length,
      'A3 (V4): the note must carry copy — an empty element satisfies a presence query ' +
        'while telling the player nothing',
    ).toBeGreaterThan(0);
    expect(note!.textContent ?? '', 'A3 (V4): the note must name the path that is ready').toContain(
      'Pyrodrake',
    );
    expect(
      note!.style.display,
      'A3 (V4): a display:none note is the ux1 defect in its purest form (ADR-0151)',
    ).not.toBe('none');
  });

  it('★★ BITES: the note is PER MONSTER — it renders inside the ready card and nowhere else', () => {
    // RED-TEAM SELF-CORRECTION: every other case in this describe queries `parent`, i.e.
    // the whole overlay. A note appended to the overlay ROOT instead of to the card
    // satisfies all of them — verified by mutation against the live shell before this case
    // was added. That is the same defect boxView X8 kills for the EG4-8 badge: a
    // notification that is not attributable to a monster tells a player with six monsters
    // that "something" is ready, and points at nothing.
    //
    // KILLS (1): a root-level (singleton) note.
    // KILLS (2): a note stamped on every card from a per-LIST predicate — the second
    //   card's absence assertion catches it.
    const { parent, view } = mount();
    view.refresh(
      viewModel(
        monsterVm({
          monsterId: 11n,
          nickname: 'Alpha',
          paths: [metPathVm({ edgeId: 2, toSpecies: 2, toSpeciesName: 'Pyrodrake' })],
          eligibleCount: 1,
          choices: [],
          readyPathName: 'Pyrodrake',
        }),
        monsterVm({
          monsterId: 22n,
          nickname: 'Beta',
          paths: [pathVm({ edgeId: 5, toSpecies: 3, toSpeciesName: 'Cindermaw' })],
          eligibleCount: 0,
          choices: [],
          readyPathName: null,
        }),
      ),
    );
    view.show();

    const cards = parent.querySelectorAll(CARD_SELECTOR);
    expect(cards, 'precondition: two monsters → two cards').toHaveLength(2);
    const notes = parent.querySelectorAll(READY_NOTE_SELECTOR);
    expect(
      notes,
      'A3 (V4): exactly ONE of the two monsters is ready, so exactly one note may exist ' +
        'in the whole overlay',
    ).toHaveLength(1);

    const ready = elementNamed(parent, CARD_SELECTOR, 'Alpha');
    const notReady = elementNamed(parent, CARD_SELECTOR, 'Beta');
    expect(
      ready.contains(notes[0] as Node),
      "A3 (V4): the note must render INSIDE the ready monster's own card. A note hoisted to " +
        'the overlay root is not attributable to a monster — the player cannot tell WHICH ' +
        'of their six monsters is ready',
    ).toBe(true);
    expect(
      notReady.contains(notes[0] as Node),
      "A3 (V4): the not-ready monster's card must not contain the note",
    ).toBe(false);
    expect(
      notReady.querySelectorAll(READY_NOTE_SELECTOR),
      'A3 (V4): ...and must not carry one of its own',
    ).toHaveLength(0);
  });

  it('★★ BITES: the 1-eligible render is NOT textually identical to the 0-eligible render', () => {
    // ★★ A3's LITERAL requirement, stated as a differential so it cannot be satisfied by
    //   a note that renders in both states (or in neither). Same monster, same single
    //   outgoing edge — only its reachability differs.
    const a = mount();
    a.view.refresh(viewModel(NOT_READY));
    a.view.show();
    const notReadyText = (a.parent.textContent ?? '').trim();
    expect(
      a.parent.querySelectorAll(READY_NOTE_SELECTOR),
      'A3 (V4): 0 eligible → readyPathName is null → NO note. A note here would advertise ' +
        'a readiness that does not hold',
    ).toHaveLength(0);

    const b = mount();
    b.view.refresh(viewModel(READY));
    b.view.show();
    const readyText = (b.parent.textContent ?? '').trim();

    expect(
      readyText,
      'A3 (V4): the ready state must READ differently from the not-ready state — that ' +
        'difference is the entire deliverable of the A3 adjudication',
    ).not.toBe(notReadyText);
  });

  it('★ BITES: at 2+ eligible there is NO ready note (the choice list is the surface)', () => {
    // KILLS: `eligibleCount >= 1` on the note, which would tell the player "evolves on
    //   your next action" about the one case that will NEVER auto-resolve (EG2-11).
    const { parent, view } = mount();
    const choices: readonly EvolutionPathViewModel[] = [
      metPathVm({ edgeId: 3, toSpecies: 2, toSpeciesName: 'Pyrodrake' }),
      metPathVm({ edgeId: 6, toSpecies: 3, toSpeciesName: 'Cindermaw' }),
    ];
    view.refresh(
      viewModel(monsterVm({ paths: choices, eligibleCount: 2, choices, readyPathName: null })),
    );
    view.show();
    expect(parent.querySelectorAll(READY_NOTE_SELECTOR)).toHaveLength(0);
    expect(parent.querySelectorAll(CHOICE_SELECTOR)).toHaveLength(2);
  });

  it('★ BITES: the ready note is NOT an action — it is not a button and clicking it does nothing', () => {
    // A3: "Informational copy only — NEVER an action." KILLS: implementing the note AS the
    //   forbidden single-eligible Evolve button with softer wording, which would satisfy
    //   the presence assertions above while re-introducing exactly what EG4-2 forbids.
    const { parent, view, callbacks } = mount();
    view.refresh(viewModel(READY));
    view.show();
    const note = parent.querySelector(READY_NOTE_SELECTOR) as HTMLElement;
    expect(note.tagName, 'A3 (V4): the ready note must not be a <button>').not.toBe('BUTTON');
    expect(note.querySelectorAll('button'), 'A3 (V4): ...nor may it contain one').toHaveLength(0);
    expect(
      note.matches(CHOICE_SELECTOR),
      'A3 (V4): ...nor may it double as an evo-choice control',
    ).toBe(false);
    note.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(callbacks.onEvolve).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// V5 (EG4-5) — the fusion surface is gone from the overlay
// ===========================================================================

describe('EvolutionView V5 (EG4-5): no fusion recipe list, no fuse picker, no Fuse button, no onFuse', () => {
  it('★ BITES: refresh() on the EG4 view-model does not throw — the shell no longer reads vm.fusionRecipes', () => {
    // RED TODAY, and this is the honest first red for this whole file: `refresh()` ends in
    //   `this.#renderRecipes(vm.fusionRecipes)` and `#renderRecipes` dereferences
    //   `recipes.length`. The contract's EvolutionViewModel has exactly ONE key
    //   (`monsters`), so that read is `undefined.length` — a TypeError inside a render
    //   driven by the store's batch listener.
    // KILLS: a partial EG4-5 that deletes `toFusionRecipe` from the model but leaves the
    //   shell reading the field.
    const { view } = mount();
    expect(() => {
      view.refresh(viewModel(monsterVm()));
    }).not.toThrow();
    expect(() => {
      view.refresh(viewModel());
    }).not.toThrow();
  });

  it('★ BITES: the overlay renders no Fuse control and no fusion copy anywhere', () => {
    // KILLS: leaving the Fuse button / the "Select two monsters to fuse (0/2):" label /
    //   the "Fusion Recipes:" block / the "Evolution & Fusion" title in place. The `fuse`
    //   reducer was DELETED server-side by EG1/ADR-0174 — every one of those is a control
    //   or a promise the game can no longer honour (ADR-0151: never advertise an action
    //   that cannot be taken).
    // Literal substring probes only — no `new RegExp` (Semgrep ban).
    const { parent, view } = mount();
    view.refresh(viewModel(monsterVm()));
    view.show();
    const text = parent.textContent ?? '';
    expect(text, 'EG4-5 (V5): no "Fuse" copy may survive in the overlay').not.toContain('Fuse');
    expect(text, 'EG4-5 (V5): ...nor "Fusion"').not.toContain('Fusion');
    expect(text, 'EG4-5 (V5): ...nor "fuse" in any casing the shell ships today').not.toContain(
      'fuse',
    );
    expect(
      [...parent.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes('Fuse')),
      'EG4-5 (V5): no button may be labelled Fuse',
    ).toHaveLength(0);
    // ANTI-VACUITY: the overlay is not empty — it really did render the monster.
    expect(text, 'ANTI-VACUITY: the card actually rendered').toContain('Blaze');
  });

  it('★★ BITES: NO interaction anywhere in the overlay can invoke onFuse', () => {
    // ★★ The runtime proof that `onFuse` left `EvolutionViewCallbacks`. The harness hands
    //   the shell a live `onFuse` spy on purpose: if any listener still reaches it, this
    //   reds — whereas simply OMITTING the member would surface as a TypeError the shell
    //   could swallow. The sweep covers the current selection idiom too (clicking two
    //   cards then the Fuse button), because it clicks every node in document order.
    const { parent, view, callbacks } = mount();
    view.refresh(
      viewModel(
        monsterVm({ monsterId: 11n, nickname: 'Alpha' }),
        monsterVm({ monsterId: 22n, nickname: 'Beta' }),
      ),
    );
    view.show();
    const swept = clickEverything(parent);
    expect(swept, 'ANTI-VACUITY: the sweep must have clicked something').toBeGreaterThan(3);
    // Twice: the shipped shell needs TWO card clicks before its Fuse button enables.
    clickEverything(parent);
    expect(
      callbacks.onFuse,
      'EG4-5 (V5): `onFuse` is deleted from EvolutionViewCallbacks — no element in this ' +
        'overlay may reach it. The `fuse` reducer no longer exists server-side',
    ).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// V6 (security) — player-controlled text reaches the DOM as TEXT
// ===========================================================================

describe('EvolutionView V6 (security): nicknames and species names render as literal text, never markup', () => {
  it('★★ BITES: an XSS-shaped nickname renders as literal text with ZERO element children', () => {
    // ★★ Nicknames are PLAYER-CONTROLLED (the `set_nickname` reducer) and this overlay is
    //   rendered for the LOCAL player's own roster today — but the same shell is the
    //   pattern the trade/roster screens copy, and Semgrep runs `--config auto --error`
    //   repo-wide. An `innerHTML` write here is a stored-XSS primitive: the payload lands
    //   in the DB and re-executes on every refresh.
    // KILLS: `el.innerHTML = ...`, `insertAdjacentHTML`, and any template-string assembly
    //   piped into a markup sink. Mirrors the established tooth at raisingView.test.ts:308.
    // Literal probes only — no `new RegExp`.
    const payload = '<img src=x onerror=alert(1)>';
    const { parent, view } = mount();
    view.refresh(
      viewModel(
        monsterVm({
          nickname: payload,
          speciesName: '<script>alert(2)</script>',
          paths: [pathVm({ toSpeciesName: '<b>Pyrodrake</b>' })],
        }),
      ),
    );
    view.show();

    expect(
      parent.querySelectorAll('img'),
      'SECURITY (V6): a nickname must NEVER be parsed as markup — an <img> element here ' +
        'means the shell used innerHTML and the payload would fire onerror',
    ).toHaveLength(0);
    expect(parent.querySelectorAll('script'), 'SECURITY (V6): ...nor a <script>').toHaveLength(0);
    expect(parent.querySelectorAll('b'), 'SECURITY (V6): ...nor inline markup').toHaveLength(0);

    const text = parent.textContent ?? '';
    expect(
      text,
      'SECURITY (V6): the payload must survive as LITERAL text (textContent), which is ' +
        'both the safe render and the honest one — the player sees the name they set',
    ).toContain(payload);
    expect(text).toContain('<script>alert(2)</script>');
    expect(text).toContain('<b>Pyrodrake</b>');
  });

  it('BITES: an EMPTY nickname falls back to the species name (no falsy-coercion hole)', () => {
    // Kills: `mon.nickname || mon.speciesName` reasoning applied to the WRONG field, and a
    // card that renders an empty name box. `''` is a real, reachable nickname value.
    const { parent, view } = mount();
    view.refresh(viewModel(monsterVm({ nickname: '', speciesName: 'Flameling' })));
    view.show();
    expect(cardOf(parent).textContent ?? '').toContain('Flameling');
  });
});

// ===========================================================================
// V7 (totality) — the shell survives every state the loop can hand it
// ===========================================================================

describe('EvolutionView V7 (totality): show/hide/refresh in any order, no throw', () => {
  it('BITES: refresh BEFORE show, an empty roster, and hide→refresh→show all survive', () => {
    // main.ts refreshes on batch-applied whether or not the overlay is visible, and the
    // first refresh of a session lands before any subscription has applied. A throw in a
    // refresh path takes the whole coalesced flushBatch burst with it (store.ts has no
    // per-listener isolation on the ingest side) — every OTHER overlay stops updating.
    const { parent, view } = mount();
    expect(() => {
      view.refresh(viewModel());
    }).not.toThrow();
    expect(view.visible).toBe(false);
    view.show();
    expect(view.visible).toBe(true);
    view.hide();
    expect(() => {
      view.refresh(viewModel(monsterVm()));
      view.show();
      view.refresh(viewModel());
    }).not.toThrow();
    expect(parent.querySelectorAll(CARD_SELECTOR)).toHaveLength(0);
    expect(parent.querySelectorAll(CHOICE_SELECTOR)).toHaveLength(0);
    expect(parent.querySelectorAll(READY_NOTE_SELECTOR)).toHaveLength(0);
  });
});
