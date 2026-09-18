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
// m23-s4 — overlay a11y wiring for EvolutionView (constructed-shell, #app-mounted).
// ADDITIVE ONLY: nothing below this block (the EG4-1/2/5, A3, V6/V7 suite) was
// weakened or deleted. Declared FIRST in the file, before any pre-existing describe.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.2/§2.3, §6
// (A11Y-13/14/15/16/17); memory/projects/monster-realm-m23-s4-plan.md §0 F1, §1
// D1/D2/D3/D6/D7; memory/projects/gates/m23-s4.gates.md X1/X2/X3/X6/X7/X8.
//
// RED REASON: evolutionView.ts's show()/hide()/toggle() do not call
// openOverlayA11y/closeOverlayA11y today, and its <h2> title carries neither
// data-testid="evolution-title" nor tabindex="-1" — every S4-evolutionView-* test
// below fails now; every pre-existing test below still passes.
//
// COMPOSITION NOTE (plan §8 A7): DEFER-FOCUS and CLOSE-RESTORE are folded into
// S4-evolutionView-ANCHOR-FOCUS and S4-evolutionView-CLOSE-RESTORE-UNGUARDED — see
// battleView.test.ts's file header for the full rationale.
//
// D3 NOTE: evolutionView.ts:70-72 writes `display` BEFORE `#visible` (unlike its
// three siblings) — the `wasVisible` read this slice adds must be hoisted above
// BOTH writes so "read first" is uniform, but this file's tests observe only the
// PUBLIC `.visible` getter and the ARIA/focus side effects, so they are agnostic
// to that internal write-order detail.
// ---------------------------------------------------------------------------

import { beforeEach } from 'vitest';
import { t } from './a11yCopy';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';

vi.mock('./overlayA11y', { spy: true });

/** ONE real macrotask boundary — never vi.useFakeTimers() (plan anti-pattern #10). */
async function s4FlushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s4FlushMacrotask();
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s4FlushMacrotask();
});

const S4_ID: OverlayId = 'evolutionView';
const S4_META = OVERLAY_A11Y[S4_ID];

function s4OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's4-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

function s4InsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's4-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

/** See battleView.test.ts's file header for the full OPEN-LAST mechanism rationale
 *  (plan §8 A3): a post-hoc read of mock.calls[...][1].style.display is PROVABLY
 *  VACUOUS. This spies on the FIRST attribute write (`role`) and delegates to the
 *  real setAttribute. NEVER vi.importActual('./overlayA11y'). */
function s4CaptureDisplayAtOpen(root: HTMLElement): { display: () => string | undefined } {
  let captured: string | undefined;
  const real = root.setAttribute.bind(root);
  vi.spyOn(root, 'setAttribute').mockImplementation((name: string, value: string) => {
    if (name === 'role' && captured === undefined) captured = root.style.display;
    real(name, value);
  });
  return { display: () => captured };
}

describe('EvolutionView — m23-s4 overlay a11y wiring on the show()/hide()/toggle() edge', () => {
  it('S4-evolutionView-OPEN-ARIA BITES: the first show() from a hidden shell labels the root from OVERLAY_A11Y/t()', () => {
    const { parent, view } = mount();
    const root = parent.firstElementChild as HTMLElement;
    expect(view.visible, 'the shell must start hidden, so show() IS an edge').toBe(false);

    view.show();

    expect(root.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S4_META.role);
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.getAttribute('aria-label')).toBe(t(S4_META.labelKey));
  });

  it('S4-evolutionView-ANCHOR-FOCUS BITES: the anchor resolves to an <h2 tabindex="-1"> with byte-unchanged "Evolution" text, and focus moves to it after ONE real macrotask (never synchronously)', async () => {
    const { parent, view } = mount();
    const root = parent.firstElementChild as HTMLElement;
    view.show();

    const anchor = root.querySelector<HTMLElement>(S4_META.initialFocusSelector);
    expect(
      anchor,
      `the anchor selector ${S4_META.initialFocusSelector} must resolve`,
    ).not.toBeNull();
    expect(anchor!.tagName).toBe('H2');
    expect(anchor!.getAttribute('tabindex')).toBe('-1');
    expect(anchor!.textContent).toBe('Evolution');

    expect(document.activeElement, 'not focused synchronously').not.toBe(anchor);
    await s4FlushMacrotask();
    expect(document.activeElement, 'focused by IDENTITY after one real macrotask').toBe(anchor);
  });

  it('S4-evolutionView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    const { parent, view } = mount();
    const root = parent.firstElementChild as HTMLElement;

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S4_ID, root);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);
  });

  it('S4-evolutionView-CLOSE-RESTORE-UNGUARDED BITES: hide() strips all three attributes and restores focus to the pre-open element; hide() on a never-shown view still closes without throwing; show/hide/hide yields exactly two closes', async () => {
    const outside = s4OutsideSentinel();
    outside.focus();
    const { parent, view } = mount();
    const root = parent.firstElementChild as HTMLElement;

    view.show();
    await s4FlushMacrotask();
    expect(document.activeElement, 'precondition: the open moved focus into the overlay').not.toBe(
      outside,
    );

    view.hide();
    expect(
      root.getAttribute('role'),
      'a display:none root must not keep claiming to be a dialog',
    ).toBeNull();
    expect(root.getAttribute('aria-modal')).toBeNull();
    expect(root.getAttribute('aria-label')).toBeNull();
    expect(document.activeElement, 'focus must return to the pre-open element').toBe(outside);

    const fresh = mount();
    expect(fresh.view.visible).toBe(false);
    expect(() => fresh.view.hide()).not.toThrow();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);

    vi.clearAllMocks();
    const cycle = mount();
    cycle.view.show();
    cycle.view.hide();
    cycle.view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });

  it('S4-evolutionView-REPEAT-NO-REOPEN BITES: show() on an already-visible overlay neither re-opens nor yanks focus off a sentinel parked inside the root', async () => {
    const { parent, view } = mount();
    const root = parent.firstElementChild as HTMLElement;
    view.show();
    await s4FlushMacrotask();

    const inside = s4InsideSentinel(root);
    inside.focus();
    expect(document.activeElement).toBe(inside);

    view.show();
    await s4FlushMacrotask();

    expect(document.activeElement, 'a repeat open must NOT re-run the deferred focus').toBe(inside);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S4-evolutionView-OPEN-LAST BITES: openOverlayA11y is invoked with root.style.display ALREADY painted (neither "none" nor "") — never open-before-paint', () => {
    const { parent, view } = mount();
    const root = parent.firstElementChild as HTMLElement;
    const capture = s4CaptureDisplayAtOpen(root);

    view.show();

    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(capture.display()).not.toBe('none');
    expect(capture.display()).not.toBe('');
  });

  it('S4-evolutionView-TOGGLE BITES: toggle() from hidden opens exactly once; toggle() again closes exactly once', () => {
    const { view } = mount();
    expect(view.visible).toBe(false);

    view.toggle();
    expect(view.visible).toBe(true);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);

    view.toggle();
    expect(view.visible).toBe(false);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
  });
});

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

// ===========================================================================
// m23-s9 (M23 §2.7) — contrast tokens, `prefers-contrast: more`, em → px
// ===========================================================================
//
// SOURCE OF TRUTH: memory/projects/monster-realm-m23-s9-plan.md ("Design (D1–D3) — AMENDED",
// the token table, "Extra assertions the red-team demanded") and
// memory/projects/gates/m23-s9.gates.md X1–X4. S8 precedent: battleView.test.ts's s8Rgb /
// s8Luminance / s8Contrast oracle and its `m23s8 status badge contrast` case.
//
// ORACLE = the RENDERED DOM + WCAG 2.x arithmetic — never the view's source text. Every colour
// operand is read off a LIVE element through happy-dom's CSSStyleDeclaration LONGHANDS
// (`style.color`, `style.backgroundColor`), resolved against the two `:root` token scopes parsed
// out of client/src/styles.css by the hp-bar eval's exported CSS parser (`parseCssStyleRules` +
// `atStack` + `normaliseMediaPrelude` — never text slicing), alpha-composited from the innermost
// surface outward onto BOTH a white and a black page, and ratioed here.
//
// RED REASON (verified against client/src/ui/evolutionView.ts and client/src/styles.css in this
// worktree): the view ships hex literals inline (`#666` empties at 2.2:1 over the worst-case
// `#333` the translucent root composites to on white; `#fff` on the `#059669` Evolve button at
// 3.77:1), `em` font sizes (0.85 / 0.8 / 0.75em) and NO `--mr-evo-*` tokens; styles.css has no
// `:root` block and no `@media (prefers-contrast: more)` block — its header merely MENTIONS that
// prelude in prose, which is why the census below runs on comment-STRIPPED text.
//
// HAPPY-DOM 20.10.6 FACTS THIS SECTION LEANS ON (read from client/node_modules/happy-dom/lib/css/
// declaration/CSSStyleDeclaration.js and property-manager/*.js — NOT assumed):
//   * `style.cssText = …` REWRITES the `style` attribute from the property manager's own
//     serialisation, so `getAttribute('style')` is happy-dom's canonical spelling, not the
//     author's. A declaration happy-dom cannot parse is DROPPED from both the object model and the
//     attribute, and an upper-case NAME is stored under a key no getter reads — both render in a
//     browser. Closed by `s9Recording`: the CSSStyleDeclaration setters are wrapped during
//     construct/refresh/show so every RAW author write is recorded and required to SURVIVE
//     serialisation by name (`s9AssertRawWritesSurvive`).
//   * `rgba(0,0,0,0.8)` reads back re-spaced as `rgba(0, 0, 0, 0.8)`; 4/8-digit hex and named
//     colours pass happy-dom and are REFUSED here.
//   * `background: var(--x)` (SHORTHAND) is stored under the `background` key only and leaves
//     `style.backgroundColor` EMPTY — the longhand is the only var()-safe surface. For today's
//     hex/rgba-literal shorthands the longhand IS populated (getBackground → getBackgroundColor
//     per part), and `s9OwnBg` additionally falls back to a bare-colour `style.background` so X1
//     reds on CONTRAST rather than on a thrown read. X3 enforces the longhand.
//   * `border: 1px solid var(--x)`: the var() PART matches happy-dom's width, style AND colour
//     part-parsers, so the manager holds `border-width` / `border-style` / `border-color` =
//     `var(--x)` beside the four literal sides; `style.border` reconstructs `1px solid` (colour
//     initial → omitted) and `style.borderColor` carries the var(). `border-left: 3px solid …`
//     is ALWAYS serialised as the three `border-left-*` longhands. The declaration allow-list
//     admits exactly those serialisations.
//
// CI HYGIENE: literal regexes and indexOf/includes only (`new RegExp` is Semgrep-banned); no
// `innerHTML`; plain `describe(` / `it(` (an eval scans for the literal); the four `it` titles
// below are the ONLY names in this file carrying the ledger's `-t` prefixes.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declarations,
  normaliseMediaPrelude,
  parseCssStyleRules,
  stripCssComments,
} from '../../../evals/reduced-motion-hp-bar.eval.mjs';

type S9Rgba = readonly [number, number, number, number];
type S9Rgb = readonly [number, number, number];

interface S9CssRule {
  readonly prelude: string;
  readonly body: string;
  readonly atStack: readonly string[];
  /** Offsets of the rule's own braces in the comment-stripped source — source ORDER. */
  readonly startIndex: number;
  readonly endIndex: number;
}
interface S9Declaration {
  readonly prop: string;
  readonly value: string;
  readonly important: boolean;
}

// The .mjs module is untyped from a .ts spec (client/tsconfig excludes specs); these are the
// shapes read from evals/reduced-motion-hp-bar.eval.mjs at `parseCssStyleRules` (`{ prelude,
// body, atStack, startIndex, endIndex }`), `declarations` (`{ prop, value, important, custom }`),
// `normaliseMediaPrelude` and `stripCssComments`.
const s9ParseRules = parseCssStyleRules as unknown as (css: string) => readonly S9CssRule[];
const s9Declarations = declarations as unknown as (body: string) => readonly S9Declaration[];
const s9NormalisePrelude = normaliseMediaPrelude as unknown as (prelude: string) => string;
const s9StripComments = stripCssComments as unknown as (css: string) => string;

const S9_TOKEN_PREFIX = '--mr-evo-';
const S9_VAR_PREFIX = 'var(--mr-evo-';
const S9_MORE_PRELUDE = '@media (prefers-contrast: more)';
const S9_WHITE: S9Rgb = [255, 255, 255];
const S9_BLACK: S9Rgb = [0, 0, 0];
const S9_PAGES: readonly (readonly [string, S9Rgb])[] = [
  ['white', S9_WHITE],
  ['black', S9_BLACK],
];
/** WCAG 1.4.3 AA for text — every string here is far below the 24px / 18.67px-bold "large" tier. */
const S9_AA = 4.5;
/** WCAG 1.4.6 AAA — the plan's tier for the `prefers-contrast: more` override. */
const S9_AAA = 7.0;
/** WCAG 1.4.11 non-text — the card boundary under `more` (default scope is out of scope, §3.1). */
const S9_NON_TEXT = 3.0;
/** 0.85em → 14px, 0.8em → 13px, 0.75em → 12px (plan D2). */
const S9_PX_SIZES: readonly number[] = [12, 13, 14];

// ---------------------------------------------------------------------------
// Colour reader — REFUSES, never defaults
// ---------------------------------------------------------------------------

const S9_HEX3 = /^#([0-9a-f]{3})$/i;
const S9_HEX6 = /^#([0-9a-f]{6})$/i;
const S9_RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
const S9_RGBA = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d*\.?\d+)\s*\)$/;
const S9_VAR = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i;

function s9Refuse(raw: string, where: string, why: string): never {
  throw new Error(
    `m23s9 COLOUR REFUSED (${where}): ${JSON.stringify(raw)} — ${why}. Only #rgb, #rrggbb, ` +
      'rgb(r, g, b) and rgba(r, g, b, a) with integer 0–255 channels and 0 ≤ a ≤ 1 are ' +
      'admissible. This reader never defaults (an empty value defaulted to black would pass ' +
      'the gate by DELETING the colour) and never parses alpha-blind (an 8-digit hex read as 6 ' +
      'digits scores an invisible colour as opaque)',
  );
}

/** `[r, g, b, a]` from a bare colour literal, or a THROW. Whitespace-tolerant (happy-dom re-spaces). */
function s9Rgb(raw: string, where: string): S9Rgba {
  const value = raw.trim();
  if (value === '') s9Refuse(raw, where, 'empty');
  const hex3 = S9_HEX3.exec(value);
  if (hex3 !== null) {
    const body = hex3[1]!;
    return [
      Number.parseInt(body.charAt(0).repeat(2), 16),
      Number.parseInt(body.charAt(1).repeat(2), 16),
      Number.parseInt(body.charAt(2).repeat(2), 16),
      1,
    ];
  }
  const hex6 = S9_HEX6.exec(value);
  if (hex6 !== null) {
    const body = hex6[1]!;
    return [
      Number.parseInt(body.slice(0, 2), 16),
      Number.parseInt(body.slice(2, 4), 16),
      Number.parseInt(body.slice(4, 6), 16),
      1,
    ];
  }
  const fn = S9_RGB.exec(value) ?? S9_RGBA.exec(value);
  if (fn === null) s9Refuse(raw, where, 'not a bare #rgb / #rrggbb / rgb() / rgba() literal');
  const channels = [fn[1]!, fn[2]!, fn[3]!].map((c) => Number.parseInt(c, 10));
  for (const c of channels) {
    if (c > 255) s9Refuse(raw, where, `channel ${c} exceeds 255`);
  }
  const alpha = fn[4] === undefined ? 1 : Number.parseFloat(fn[4]);
  if (!(alpha >= 0 && alpha <= 1)) s9Refuse(raw, where, `alpha ${fn[4]} is outside 0..1`);
  return [channels[0]!, channels[1]!, channels[2]!, alpha];
}

/** WCAG 2.x sRGB channel linearisation (identical to S8's s8ChannelLuminance). */
function s9Channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance. Alpha, if present, is ignored — callers composite first. */
function s9Luminance(rgb: S9Rgba | S9Rgb): number {
  const lum = 0.2126 * s9Channel(rgb[0]) + 0.7152 * s9Channel(rgb[1]) + 0.0722 * s9Channel(rgb[2]);
  if (!Number.isFinite(lum)) {
    throw new Error(`m23s9 LUMINANCE: ${JSON.stringify(rgb)} produced a non-finite L`);
  }
  return lum;
}

/** WCAG 2.x contrast ratio between two relative luminances, order-independent. */
function s9Contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Source-over: `top` painted onto `under`; both may be translucent. Unrounded. */
function s9Over(top: S9Rgba, under: S9Rgba): S9Rgba {
  const at = top[3];
  const au = under[3] * (1 - at);
  const a = at + au;
  if (a === 0) return [0, 0, 0, 0];
  const mix = (i: 0 | 1 | 2): number => (top[i] * at + under[i] * au) / a;
  return [mix(0), mix(1), mix(2), a];
}

function s9Hex(rgb: S9Rgba | S9Rgb): string {
  const two = (v: number): string => Math.round(v).toString(16).padStart(2, '0');
  return `#${two(rgb[0])}${two(rgb[1])}${two(rgb[2])}`;
}

// ---------------------------------------------------------------------------
// Token scopes — client/src/styles.css, located by atStack, never by text slicing
// ---------------------------------------------------------------------------

interface S9Scopes {
  readonly css: string;
  /** `:root { … }` at at-rule depth 0 — the DEFAULT scope. */
  readonly base: ReadonlyMap<string, string>;
  /** `:root { … }` whose ONLY enclosing at-rule normalises to `@media (prefers-contrast: more)`. */
  readonly more: ReadonlyMap<string, string>;
  /** Declaration COUNTS per name (a Map silently dedupes a double declaration). */
  readonly baseCounts: ReadonlyMap<string, number>;
  readonly moreCounts: ReadonlyMap<string, number>;
  /** How many `:root` rules in each scope declare at least one `--mr-evo-*` token. */
  readonly baseRules: number;
  readonly moreRules: number;
  /** Every OTHER rule that declares a `--mr-evo-*` token, described for the failure message. */
  readonly outside: readonly string[];
  /** The (last) token-declaring `:root` rule of each scope — for the source-ORDER pin. */
  readonly baseRule: S9CssRule | null;
  readonly moreRule: S9CssRule | null;
  /** EVERY style rule in the sheet, for the stylesheet-route hygiene pins. */
  readonly rules: readonly S9CssRule[];
}

function s9TokenScopes(): S9Scopes {
  // The spec lives in client/src/ui/, the sheet in client/src/ — resolved from THIS file's URL so
  // the read does not depend on vitest's cwd.
  const sheetPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css');
  const css = readFileSync(sheetPath, 'utf8');
  const expectedMore = s9NormalisePrelude(S9_MORE_PRELUDE);
  const base = new Map<string, string>();
  const more = new Map<string, string>();
  const baseCounts = new Map<string, number>();
  const moreCounts = new Map<string, number>();
  const outside: string[] = [];
  let baseRules = 0;
  let moreRules = 0;
  let baseRule: S9CssRule | null = null;
  let moreRule: S9CssRule | null = null;
  const rules = s9ParseRules(css);
  for (const rule of rules) {
    const tokens = s9Declarations(rule.body).filter((d) => d.prop.startsWith(S9_TOKEN_PREFIX));
    const isRoot = rule.prelude === ':root';
    const inBase = isRoot && rule.atStack.length === 0;
    const inMore =
      isRoot && rule.atStack.length === 1 && s9NormalisePrelude(rule.atStack[0]!) === expectedMore;
    if (inBase || inMore) {
      if (tokens.length === 0) continue;
      const map = inBase ? base : more;
      const counts = inBase ? baseCounts : moreCounts;
      if (inBase) {
        baseRules += 1;
        baseRule = rule;
      } else {
        moreRules += 1;
        moreRule = rule;
      }
      for (const t of tokens) {
        map.set(t.prop, t.value);
        counts.set(t.prop, (counts.get(t.prop) ?? 0) + 1);
      }
    } else if (tokens.length > 0) {
      const where = [...rule.atStack, rule.prelude].join(' > ');
      outside.push(`${where} declares ${tokens.map((t) => t.prop).join(', ')}`);
    }
  }
  return {
    css,
    base,
    more,
    baseCounts,
    moreCounts,
    baseRules,
    moreRules,
    outside,
    baseRule,
    moreRule,
    rules,
  };
}

/** The token name inside a bare `var(--name)` reference, or null (a fallback comma → null). */
function s9TokenName(raw: string): string | null {
  const matched = S9_VAR.exec(raw.trim());
  return matched === null ? null : matched[1]!;
}

/**
 * A DOM colour source resolved in `scope`: `var(--mr-evo-x)` → the token's declared value; a bare
 * literal → itself (so X1 is evaluable against TODAY's hex-literal tree and reds on CONTRAST; X3
 * is where "must be a token" is asserted). THROWS on a fallback (`var(--x, #fb)`) or a token the
 * scope does not declare — the browser would render the fallback / initial colour while this
 * gate measured nothing.
 */
function s9Resolve(raw: string, scope: ReadonlyMap<string, string>, where: string): string {
  const value = raw.trim();
  if (!value.startsWith('var(')) return value;
  const name = s9TokenName(value);
  if (name === null) {
    throw new Error(
      `m23s9 TOKEN REFUSED (${where}): ${JSON.stringify(raw)} is not a bare var(--name) reference` +
        ' — a fallback would let a deleted token render the fallback while this gate measured' +
        ' nothing',
    );
  }
  const resolved = scope.get(name);
  if (resolved === undefined) {
    throw new Error(
      `m23s9 TOKEN MISSING (${where}): ${name} is referenced by the DOM but declared in no :root ` +
        'scope of client/src/styles.css that this scope reads — the browser would render the ' +
        'initial colour',
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// DOM walk — every element with a direct non-blank text node, fg/bg by ancestor walk
// ---------------------------------------------------------------------------

type S9StateName = 'S_EMPTY' | 'S_NOPATHS' | 'S_READY' | 'S_CHOICES';
const S9_STATES: readonly S9StateName[] = ['S_EMPTY', 'S_NOPATHS', 'S_READY', 'S_CHOICES'];

/**
 * Text-element census per state, derived BY HAND from evolutionView.ts's structure (root =
 * title h2 + hint p + list div; a card = name + stats [+ "No evolution paths."] + path rows +
 * [ready note] + [prompt + picker of buttons]; a path row = heading + status + one row per gate;
 * containers — root, list, card, path row, picker — carry no direct text):
 *   S_EMPTY    title, hint, "No monsters yet."                                         = 3
 *   S_NOPATHS  title, hint, name, stats, "No evolution paths."                         = 5
 *   S_READY    title, hint, name, stats, heading, status, gate×2 (met + unmet), ready  = 9
 *   S_CHOICES  title, hint, name, stats, rowA (heading, status, gate) 3, rowB 3,
 *              rowC (heading, status, FIVE_GATES) 7, prompt, button×2                  = 20
 * A shrunk walk (e.g. `children.length === 0`, which drops nothing here but would drop any
 * future element that carries both text and a child) cannot pass these pins vacuously.
 */
const S9_CENSUS: Readonly<Record<S9StateName, number>> = {
  S_EMPTY: 3,
  S_NOPATHS: 5,
  S_READY: 9,
  S_CHOICES: 20,
};

/**
 * TOTAL element census per state (root included, textless containers included) — derived by
 * hand from the same structure. A textless cover element (red-team: `position:absolute;inset:0;
 * background-color:var(--mr-evo-card)` inside the card) is invisible to the TEXT census and
 * changes what the eye sees; it cannot hide from this one.
 *   S_EMPTY    root, h2, hint, list, "No monsters yet."                                  = 5
 *   S_NOPATHS  root, h2, hint, list, card, name, stats, "No evolution paths."             = 8
 *   S_READY    root, h2, hint, list, card, name, stats, row, heading, status, gate×2, ready = 13
 *   S_CHOICES  root, h2, hint, list, card, name, stats (7); rowA row+heading+status+gate (4);
 *              rowB (4); rowC row+heading+status+5 gates (8); prompt, picker, button×2 (4)  = 27
 */
const S9_TOTAL_ELEMENTS: Readonly<Record<S9StateName, number>> = {
  S_EMPTY: 5,
  S_NOPATHS: 8,
  S_READY: 13,
  S_CHOICES: 27,
};
/** `evo-monster-card` count per state (one monster in every non-empty fixture). */
const S9_CARD_COUNT: Readonly<Record<S9StateName, number>> = {
  S_EMPTY: 0,
  S_NOPATHS: 1,
  S_READY: 1,
  S_CHOICES: 1,
};
/** `evo-path-row` count per state. */
const S9_ROW_COUNT: Readonly<Record<S9StateName, number>> = {
  S_EMPTY: 0,
  S_NOPATHS: 0,
  S_READY: 1,
  S_CHOICES: 3,
};

function s9StateVm(state: S9StateName): EvolutionViewModel {
  switch (state) {
    case 'S_EMPTY':
      return viewModel();
    case 'S_NOPATHS':
      return viewModel(monsterVm({ paths: [] }));
    case 'S_READY':
      // One MET path with MIXED gates so BOTH gate-row colours render, plus the ready note.
      return viewModel(
        monsterVm({
          paths: [
            metPathVm({
              edgeId: 2,
              toSpecies: 2,
              toSpeciesName: 'Pyrodrake',
              gates: [
                gate('level', 'Level', 'Lv 30', 'Lv 20', true),
                gate('essence', 'Fire essence', 'Fire 33', 'Fire 120', false),
              ],
            }),
          ],
          eligibleCount: 1,
          choices: [],
          readyPathName: 'Pyrodrake',
        }),
      );
    case 'S_CHOICES': {
      // Two MET paths offered as choices (two Evolve buttons) plus one UNMET path (unmet heading,
      // warn status, five unmet gates) — the V3 fixture shape.
      const met: readonly EvolutionPathViewModel[] = [
        metPathVm({ edgeId: 3, toSpecies: 2, toSpeciesName: 'Pyrodrake' }),
        metPathVm({ edgeId: 6, toSpecies: 3, toSpeciesName: 'Cindermaw' }),
      ];
      return viewModel(
        monsterVm({
          paths: [...met, pathVm({ edgeId: 9, toSpecies: 4, toSpeciesName: 'Emberwing' })],
          eligibleCount: 2,
          choices: met,
          readyPathName: null,
        }),
      );
    }
  }
}

interface S9Pair {
  readonly state: S9StateName;
  readonly label: string;
  readonly el: HTMLElement;
  /** The nearest inline `color` up the chain (root inclusive), verbatim from the DOM. */
  readonly fgRaw: string;
  /** Every inline background from the element up to the root, INNERMOST FIRST, verbatim. */
  readonly bgRaws: readonly string[];
}

/** One RAW author write to an element's inline style, as the view wrote it (pre-happy-dom). */
interface S9RawWrite {
  readonly name: string;
  readonly value: string;
}

interface S9Render {
  readonly state: S9StateName;
  readonly root: HTMLElement;
  readonly listEl: HTMLElement;
  readonly pairs: readonly S9Pair[];
  /** Every raw inline-style write recorded during construct + refresh + show, per declaration. */
  readonly writes: ReadonlyMap<CSSStyleDeclaration, readonly S9RawWrite[]>;
}

function s9Label(el: HTMLElement): string {
  const testid = el.getAttribute('data-testid');
  const text = (el.textContent ?? '').trim().slice(0, 40);
  return testid === null ? `"${text}"` : `${testid} "${text}"`;
}

/** EVERY element in the subtree, root first, document order. */
function s9AllElements(root: HTMLElement): HTMLElement[] {
  return [root, ...root.querySelectorAll('*')] as HTMLElement[];
}

/** EVERY element in the subtree (root included) with at least one direct non-blank text node. */
function s9TextElements(root: HTMLElement): HTMLElement[] {
  return s9AllElements(root).filter((el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== ''),
  );
}

/**
 * The CSSStyleDeclaration setters this section intercepts to see the AUTHOR's text: `cssText`
 * (the view's idiom; `el.style = '…'` routes through it too) plus the four property setters a
 * view could style a colour or size through. Kebab name '' marks the cssText setter.
 *
 * WHY: happy-dom DROPS any declaration it cannot parse — `color:var(--x, #666)` (fallback),
 * `VAR(--x)`, `font-size:0.85EM` — and stores an upper-case NAME (`COLOR`, `FONT-SIZE`) under a
 * key the longhand getters never read. Each one renders in a browser and is invisible to every
 * `style.*` read (red-team, five measured GREEN cheats). Recording the raw write and requiring it
 * to SURVIVE serialisation closes the class DOM-side, without a source-text oracle.
 */
const S9_SPIED_SETTERS: readonly (readonly [string, string])[] = [
  ['cssText', ''],
  ['color', 'color'],
  ['backgroundColor', 'background-color'],
  ['background', 'background'],
  ['fontSize', 'font-size'],
];

/** The prototype that OWNS an accessor with a setter for `key`, walking up from `proto`. */
function s9FindSetter(proto: object, key: string): { owner: object; desc: PropertyDescriptor } {
  let cur: object | null = proto;
  while (cur !== null) {
    const desc = Object.getOwnPropertyDescriptor(cur, key);
    if (desc !== undefined) {
      if (typeof desc.set !== 'function') {
        throw new Error(
          `m23s9 SPY: CSSStyleDeclaration.${key} exists but is not an accessor with a setter — the ` +
            'raw-write recorder cannot intercept it; a source-level absence tripwire is needed instead',
        );
      }
      return { owner: cur, desc };
    }
    cur = Object.getPrototypeOf(cur);
  }
  throw new Error(`m23s9 SPY: CSSStyleDeclaration.${key} not found on the prototype chain`);
}

/**
 * Run `body` with every spied setter wrapped to RECORD the raw author string per declaration
 * object (then call the original), restoring the prototypes in `finally`. `element.style` is
 * cached per element in happy-dom (HTMLElement `[PropertySymbol.style]`), so the map key later
 * resolves back to the subtree's elements; writes to anything else are simply ignored.
 */
function s9Recording<T>(body: () => T): {
  readonly result: T;
  readonly writes: Map<CSSStyleDeclaration, S9RawWrite[]>;
} {
  const writes = new Map<CSSStyleDeclaration, S9RawWrite[]>();
  const proto = Object.getPrototypeOf(document.createElement('div').style) as object;
  const restores: (() => void)[] = [];
  for (const [key, kebab] of S9_SPIED_SETTERS) {
    const { owner, desc } = s9FindSetter(proto, key);
    const original = desc.set!;
    Object.defineProperty(owner, key, {
      ...desc,
      set(this: CSSStyleDeclaration, value: unknown) {
        const text = String(value);
        const list = writes.get(this) ?? [];
        if (kebab === '') {
          for (const chunk of text.split(';')) {
            const colon = chunk.indexOf(':');
            if (colon === -1) continue;
            list.push({ name: chunk.slice(0, colon).trim(), value: chunk.slice(colon + 1).trim() });
          }
        } else {
          list.push({ name: kebab, value: text });
        }
        writes.set(this, list);
        original.call(this, value);
      },
    });
    restores.push(() => {
      Object.defineProperty(owner, key, desc);
    });
  }
  try {
    return { result: body(), writes };
  } finally {
    for (const restore of restores) restore();
  }
}

/**
 * An element's OWN inline background: the `background-color` LONGHAND (the only surface happy-dom
 * reads a `var()` back through). Falls back to a bare-colour `background` SHORTHAND ONLY so that
 * today's literal tree is measurable and X1 reds on contrast; the implementation is REQUIRED to
 * use the longhand and X3's coherence + allow-list assertions enforce it (a `background: var(…)`
 * shorthand leaves this read empty AND names `background` in the attribute).
 */
function s9OwnBg(el: HTMLElement): string {
  const longhand = el.style.backgroundColor;
  if (longhand !== '') return longhand;
  const shorthand = el.style.background;
  if (shorthand.startsWith('#') || shorthand.startsWith('rgb')) return shorthand;
  return '';
}

function s9FgRaw(el: HTMLElement, root: HTMLElement): string {
  let cur: HTMLElement | null = el;
  while (cur !== null) {
    const colour = cur.style.color;
    if (colour !== '') return colour;
    if (cur === root) break;
    cur = cur.parentElement;
  }
  throw new Error(
    `m23s9 NO COLOUR (${s9Label(el)}): no inline \`color\` on the element or any ancestor up to ` +
      'the overlay root — the text would render in the page default, which this gate refuses to ' +
      'guess at',
  );
}

function s9BgRaws(el: HTMLElement, root: HTMLElement): string[] {
  const out: string[] = [];
  let cur: HTMLElement | null = el;
  while (cur !== null) {
    const raw = s9OwnBg(cur);
    if (raw !== '') out.push(raw);
    if (cur === root) break;
    cur = cur.parentElement;
  }
  return out;
}

function s9Render(state: S9StateName): S9Render {
  // STYLE INJECTION (red-team: a constructor appending `<style>` to document.head passed): the
  // document must hold no stylesheet element before or after, and the head must not grow.
  const headBefore = document.head.children.length;
  expect(
    document.querySelectorAll('style, link'),
    `${state}: the test document must start with no <style>/<link>`,
  ).toHaveLength(0);
  const { result, writes } = s9Recording(() => {
    const h = mount();
    h.view.refresh(s9StateVm(state));
    h.view.show();
    return h;
  });
  expect(
    document.querySelectorAll('style, link'),
    `${state}: the view must not inject a <style>/<link> anywhere — every colour must be an ` +
      'inline var() this oracle can read',
  ).toHaveLength(0);
  expect(
    document.head.children.length,
    `${state}: document.head must not grow during construct + refresh + show`,
  ).toBe(headBefore);
  const { parent } = result;
  expect(parent.children.length, `${state}: mount() must hold exactly the overlay root`).toBe(1);
  const root = parent.children[0] as HTMLElement;
  expect(root.children.length, `${state}: the root must hold title, hint and list`).toBe(3);
  const listEl = root.children[2] as HTMLElement;
  const pairs = s9TextElements(root).map(
    (el): S9Pair => ({
      state,
      label: s9Label(el),
      el,
      fgRaw: s9FgRaw(el, root),
      bgRaws: s9BgRaws(el, root),
    }),
  );
  return { state, root, listEl, pairs, writes };
}

/** The per-state census + marker pins that make every "for each pair" loop non-vacuous. */
function s9AssertCensus(r: S9Render): void {
  const labels = r.pairs.map((p) => p.label);
  expect(
    r.pairs.length,
    `${r.state} CENSUS: the walk must find exactly ${S9_CENSUS[r.state]} text elements (hand ` +
      `derivation in the S9_CENSUS comment); found ${r.pairs.length}: ${labels.join(' | ')}`,
  ).toBe(S9_CENSUS[r.state]);
  const all = s9AllElements(r.root);
  expect(
    all.length,
    `${r.state} TOTAL CENSUS: the subtree must hold exactly ${S9_TOTAL_ELEMENTS[r.state]} elements ` +
      `(hand derivation in the S9_TOTAL_ELEMENTS comment); found ${all.length}: ` +
      `${all.map((el) => el.tagName.toLowerCase()).join(' ')}. KILLS a textless cover element`,
  ).toBe(S9_TOTAL_ELEMENTS[r.state]);
  expect(
    r.root.querySelectorAll(CARD_SELECTOR),
    `${r.state}: ${S9_CARD_COUNT[r.state]} monster card(s)`,
  ).toHaveLength(S9_CARD_COUNT[r.state]);
  expect(
    r.root.querySelectorAll(PATH_ROW_SELECTOR),
    `${r.state}: ${S9_ROW_COUNT[r.state]} path row(s)`,
  ).toHaveLength(S9_ROW_COUNT[r.state]);
  expect(
    s9OwnBg(r.root) !== '',
    `${r.state}: the overlay root must declare its OWN background — every ratio composites onto it`,
  ).toBe(true);
  switch (r.state) {
    case 'S_EMPTY':
      expect(
        labels.some((l) => l.includes('No monsters yet.')),
        `${r.state} marker`,
      ).toBe(true);
      break;
    case 'S_NOPATHS':
      expect(
        labels.some((l) => l.includes('No evolution paths.')),
        `${r.state} marker`,
      ).toBe(true);
      break;
    case 'S_READY': {
      expect(
        r.root.querySelectorAll(READY_NOTE_SELECTOR),
        `${r.state}: one ready note`,
      ).toHaveLength(1);
      expect(
        r.pairs.filter((p) => p.el.matches(READY_NOTE_SELECTOR)),
        `${r.state}: the ready note must be a walked text element`,
      ).toHaveLength(1);
      const gates = r.pairs.filter((p) => p.el.matches(GATE_ROW_SELECTOR));
      expect(gates, `${r.state}: one met + one unmet gate row`).toHaveLength(2);
      expect(
        gates[0]!.fgRaw !== gates[1]!.fgRaw,
        `${r.state}: met and unmet gate rows must carry DIFFERENT colours, so both gate colours ` +
          'are evaluated (a single-colour fixture would leave one token unmeasured)',
      ).toBe(true);
      break;
    }
    case 'S_CHOICES': {
      expect(
        r.root.querySelectorAll(CHOICE_SELECTOR),
        `${r.state}: two Evolve buttons`,
      ).toHaveLength(2);
      expect(
        r.pairs.filter((p) => p.el.matches(CHOICE_SELECTOR)),
        `${r.state}: both buttons must be walked text elements`,
      ).toHaveLength(2);
      const metStatus = r.pairs.filter((p) => p.label.includes('All requirements met.'));
      const unmetStatus = r.pairs.filter((p) => p.label.includes('requires level 20'));
      expect(metStatus, `${r.state}: two met statuses`).toHaveLength(2);
      expect(unmetStatus, `${r.state}: one unmet (warn) status`).toHaveLength(1);
      expect(
        metStatus[0]!.fgRaw !== unmetStatus[0]!.fgRaw,
        `${r.state}: the met (ok) and unmet (warn) statuses must carry DIFFERENT colours`,
      ).toBe(true);
      break;
    }
  }
}

interface S9Reading {
  readonly ratio: number;
  readonly fg: S9Rgba;
  readonly bg: S9Rgba;
}

/** One pair's ratio in `scope` on `page`: bg stack composited innermost-out until opaque. */
function s9Read(pair: S9Pair, scope: ReadonlyMap<string, string>, page: S9Rgb): S9Reading {
  const where = `${pair.state}/${pair.label}`;
  let acc: S9Rgba | null = null;
  for (const raw of pair.bgRaws) {
    const layer = s9Rgb(s9Resolve(raw, scope, `${where} background`), `${where} background`);
    acc = acc === null ? layer : s9Over(acc, layer);
    if (acc[3] >= 1) break;
  }
  const opaquePage: S9Rgba = [page[0], page[1], page[2], 1];
  const bg = acc === null ? opaquePage : s9Over(acc, opaquePage);
  const fgRead = s9Rgb(s9Resolve(pair.fgRaw, scope, `${where} color`), `${where} color`);
  const fg = fgRead[3] >= 1 ? fgRead : s9Over(fgRead, bg);
  return { ratio: s9Contrast(s9Luminance(fg), s9Luminance(bg)), fg, bg };
}

function s9Describe(pair: S9Pair, reading: S9Reading, pageName: string): string {
  return (
    `${pair.state}/${pair.label}: fg ${pair.fgRaw} → ${s9Hex(reading.fg)} on bg ` +
    `[${pair.bgRaws.join(' over ')}] → ${s9Hex(reading.bg)} over a ${pageName} page measures ` +
    `${reading.ratio.toFixed(2)}:1`
  );
}

// ---------------------------------------------------------------------------
// Inline-declaration hygiene helpers
// ---------------------------------------------------------------------------

/**
 * Every declaration NAME the shipped view may carry inline, as happy-dom SERIALISES it (see the
 * section header). Absent on purpose — and each is a measured or plan-named cheat: `background`
 * (shorthand: the var()-blind read AND `background-image`), `opacity`, `filter`,
 * `mix-blend-mode`, `text-shadow`, `-webkit-text-fill-color`, `font` (shorthand), `zoom`,
 * `transform`, `visibility`, `clip-path`.
 */
const S9_ALLOWED_DECLARATIONS: ReadonlySet<string> = new Set([
  'position',
  'inset',
  'z-index',
  'background-color',
  'display',
  'flex-direction',
  'align-items',
  'padding',
  'overflow-y',
  'font-family',
  'color',
  'margin',
  'margin-top',
  'margin-bottom',
  'font-size',
  'max-width',
  'grid-template-columns',
  'gap',
  'width',
  'border-radius',
  'border',
  // happy-dom serialises the var() colour part of `border: 1px solid var(--x)` as these three
  // beside `border: 1px solid` (measured in CSSStyleDeclarationPropertySetParser.getBorder).
  'border-width',
  'border-style',
  'border-color',
  // `border-left: …` is ALWAYS serialised as its three longhands; `border-left` itself is kept
  // for the day happy-dom starts reconstructing it.
  'border-left',
  'border-left-width',
  'border-left-style',
  'border-left-color',
  'font-weight',
  'flex-wrap',
  'cursor',
]);

/** Declaration names in the element's (happy-dom-serialised) `style` attribute, lowercased. */
function s9DeclaredNames(el: HTMLElement): string[] {
  const out: string[] = [];
  for (const chunk of (el.getAttribute('style') ?? '').split(';')) {
    const colon = chunk.indexOf(':');
    if (colon === -1) continue;
    const name = chunk.slice(0, colon).trim().toLowerCase();
    if (name !== '') out.push(name);
  }
  return out;
}

/** Every read through which happy-dom can surface the card's `border` colour part. */
function s9BorderText(el: HTMLElement): string {
  return [el.style.border, el.style.borderColor, el.style.borderTopColor].join(' ');
}

/** Every read through which happy-dom can surface a row's `border-left` colour part. */
function s9BorderLeftText(el: HTMLElement): string {
  return [el.style.borderLeft, el.style.borderLeftColor].join(' ');
}

/** Distinct `--mr-evo-*` names referenced as `var(…)` anywhere in `text`. */
function s9VarNamesIn(text: string): string[] {
  const out = new Set<string>();
  let from = 0;
  for (;;) {
    const at = text.indexOf(S9_VAR_PREFIX, from);
    if (at === -1) break;
    const close = text.indexOf(')', at);
    if (close === -1) break;
    out.add(text.slice(at + 'var('.length, close).trim());
    from = close + 1;
  }
  return [...out];
}

/**
 * The ONE `--mr-evo-*` token a border read references, resolved in BOTH scopes and parsed as a
 * colour in each (so a border token missing from either block, or carrying a fallback, throws
 * here). Returns the name and the more-scope colour.
 */
function s9BorderToken(
  text: string,
  scopes: S9Scopes,
  where: string,
): { readonly name: string; readonly base: S9Rgba; readonly more: S9Rgba } {
  const names = s9VarNamesIn(text);
  expect(
    names,
    `m23s9 BORDER ${where}: the border colour must reference exactly ONE --mr-evo-* token (read ` +
      `${JSON.stringify(text)}) — a literal, a second token or none at all is not a tokenised border`,
  ).toHaveLength(1);
  const ref = `var(${names[0]!})`;
  const base = s9Rgb(s9Resolve(ref, scopes.base, `${where} (default)`), `${where} (default)`);
  const more = s9Rgb(s9Resolve(ref, scopes.more, `${where} (more)`), `${where} (more)`);
  expect(
    base[3],
    `m23s9 BORDER ${where}: ${ref} must be VISIBLE in the default scope`,
  ).toBeGreaterThan(0);
  return { name: names[0]!, base, more };
}

/** Is a raw author declaration NAME accounted for in the serialised names (self or longhands)? */
function s9Explains(raw: string, serialised: string): boolean {
  return serialised === raw || serialised.startsWith(`${raw}-`);
}

/** How many times `needle` occurs in `text` (indexOf loop — no dynamic regex). */
function s9Count(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Every raw write to `el` must SURVIVE happy-dom's serialisation, and vice versa, by NAME:
 *   forward — each raw name is itself a serialised name or the parent of serialised longhands
 *             (`border` → `border-width`…, `border-left` → `border-left-*`; a dropped
 *             declaration has neither);
 *   reverse — each serialised name is explained by some raw write (a `setProperty` /
 *             `setAttribute('style')` route the recorder cannot see leaves it unexplained);
 *   unique  — no raw name is written twice (a later same-name override is how a dropped or
 *             literal declaration would hide behind a clean first one);
 *   spelled — raw names are lower-case (`COLOR:` is stored under a key no getter reads) and every
 *             `var(` is lower-case with NO fallback comma (both are dropped by happy-dom, both
 *             render in a browser).
 * Exact COUNT equality is deliberately NOT used: happy-dom expands one `border` into four names
 * and one `border-left` into three (measured), so a count would false-RED the honest impl.
 */
function s9AssertRawWritesSurvive(
  el: HTMLElement,
  raw: readonly S9RawWrite[],
  label: string,
): void {
  const serialised = s9DeclaredNames(el);
  const rawNames = raw.map((w) => w.name);
  expect(
    new Set(rawNames).size,
    `m23s9 RAW ${label}: no declaration may be written twice (raw: ${rawNames.join(', ')})`,
  ).toBe(rawNames.length);
  for (const write of raw) {
    expect(
      write.name,
      `m23s9 RAW ${label}: declaration name ${JSON.stringify(write.name)} must be lower-case — ` +
        'happy-dom stores an upper-case name under a key no longhand getter reads, so it renders ' +
        'in a browser and is invisible to every style.* read',
    ).toBe(write.name.toLowerCase());
    const lower = write.value.toLowerCase();
    expect(
      s9Count(write.value, 'var('),
      `m23s9 RAW ${label}: every var( in ${JSON.stringify(write.value)} must be lower-case`,
    ).toBe(s9Count(lower, 'var('));
    let from = 0;
    for (;;) {
      const at = lower.indexOf('var(', from);
      if (at === -1) break;
      const close = lower.indexOf(')', at);
      const inner = close === -1 ? lower.slice(at) : lower.slice(at, close);
      expect(
        inner.includes(','),
        `m23s9 RAW ${label}: ${JSON.stringify(write.value)} carries a var() FALLBACK — happy-dom drops ` +
          'it, a browser renders the fallback, and the token scope is never consulted',
      ).toBe(false);
      from = close === -1 ? lower.length : close + 1;
    }
    expect(
      serialised.some((s) => s9Explains(write.name, s)),
      `m23s9 RAW ${label}: raw declaration \`${write.name}: ${write.value}\` did NOT survive ` +
        `happy-dom's serialisation (style="${el.getAttribute('style') ?? ''}") — a declaration happy-dom ` +
        'cannot parse is dropped from every read this oracle makes yet renders in a browser',
    ).toBe(true);
  }
  for (const name of serialised) {
    expect(
      rawNames.some((r) => s9Explains(r, name)),
      `m23s9 RAW ${label}: serialised declaration \`${name}\` has no recorded raw write — a ` +
        'setProperty() / setAttribute("style") route bypasses the recorder and is refused',
    ).toBe(true);
  }
}

/** The layout containers that must declare NO font-size (plan: "containers declare no font-size"). */
function s9Containers(r: S9Render): { readonly label: string; readonly el: HTMLElement }[] {
  const out: { readonly label: string; readonly el: HTMLElement }[] = [
    { label: 'root', el: r.root },
    { label: 'list', el: r.listEl },
  ];
  for (const card of r.root.querySelectorAll(CARD_SELECTOR)) {
    out.push({ label: 'card', el: card as HTMLElement });
  }
  for (const row of r.root.querySelectorAll(PATH_ROW_SELECTOR)) {
    out.push({ label: 'path row', el: row as HTMLElement });
  }
  const pickers = new Set<HTMLElement>();
  for (const choice of r.root.querySelectorAll(CHOICE_SELECTOR)) {
    const picker = choice.parentElement;
    if (picker !== null) pickers.add(picker);
  }
  for (const picker of pickers) out.push({ label: 'picker', el: picker });
  return out;
}

// ===========================================================================
// The four gates
// ===========================================================================

describe('EvolutionView — m23-s9 contrast tokens, prefers-contrast: more, em→px', () => {
  it('m23s9 X1 every text element reaches 4.5:1 in the default token scope, over a white and a black page', () => {
    // WRONG IMPLEMENTATIONS KILLED: the shipped `#666` empties (2.2:1 on the worst-case `#333`
    // the translucent root composites to over white, 2.86:1 on the `#1e1e2e` card); `#fff` on
    // the `#059669` Evolve button (3.77:1); any palette that only clears 4.5:1 over a black page
    // (the white page is the worst case for a dark translucent root); a walk that skips nested
    // text; a reader that defaults an unparseable colour. Each per-pair failure names the pair,
    // both resolved operands, the page and the measured ratio.

    // ---- PRECONDITIONS: the oracle's arithmetic is proven before it judges anything ----
    const composite = s9Over([0, 0, 0, 0.8], [S9_WHITE[0], S9_WHITE[1], S9_WHITE[2], 1]);
    expect(
      [Math.round(composite[0]), Math.round(composite[1]), Math.round(composite[2]), composite[3]],
      'PRECONDITION: rgba(0,0,0,0.8) over white composites to #333 (51,51,51), opaque — the ' +
        'worst-case backdrop every root-level string sits on',
    ).toEqual([51, 51, 51, 1]);
    const badPair = s9Contrast(
      s9Luminance(s9Rgb('#777', 'precondition BAD fg')),
      s9Luminance(s9Rgb('#0b0d12', 'precondition BAD bg')),
    );
    expect(
      badPair,
      'PRECONDITION: the spec §5.3 BAD pair #777 on #0b0d12 must measure BELOW 4.5 (hand: 4.34) ' +
        '— an oracle that passes it passes anything',
    ).toBeLessThan(S9_AA);
    expect(badPair, 'PRECONDITION: …and above 4.3 (hand: 4.34)').toBeGreaterThan(4.3);
    const goodPair = s9Contrast(
      s9Luminance(s9Rgb('#b5c9b5', 'precondition GOOD fg')),
      s9Luminance(s9Rgb('#2a3a2a', 'precondition GOOD bg')),
    );
    expect(
      goodPair,
      'PRECONDITION: a hostile GOOD pair far from black/white (#b5c9b5 on #2a3a2a, hand: 6.90) ' +
        'must PASS — an oracle that only passes white-on-black is not measuring contrast',
    ).toBeGreaterThanOrEqual(S9_AA);
    expect(goodPair, 'PRECONDITION: …at 6.90 ± 0.05').toBeCloseTo(6.9, 1);
    const hostileInputs: readonly string[] = [
      '',
      'var(--mr-evo-fg, #fff)',
      'white',
      'hsl(0, 0%, 50%)',
      'color-mix(in srgb, #000, #fff)',
      '#ffff',
      '#ffffff80',
      'rgba(0, 0, 0, 1.5)',
      'rgb(50%, 50%, 50%)',
    ];
    for (const hostile of hostileInputs) {
      expect(
        () => s9Rgb(hostile, 'precondition'),
        `PRECONDITION: the colour reader must THROW on ${JSON.stringify(hostile)} — never default`,
      ).toThrow();
    }
    expect(
      s9Rgb('rgba(0, 0, 0, 0.8)', 'precondition re-spaced'),
      "PRECONDITION: happy-dom's re-spaced rgba(0, 0, 0, 0.8) must read with alpha 0.8",
    ).toEqual([0, 0, 0, 0.8]);

    // ---- THE WALK: four states × two pages × every text element ----
    const { base } = s9TokenScopes();
    for (const state of S9_STATES) {
      const render = s9Render(state);
      s9AssertCensus(render);
      for (const [pageName, page] of S9_PAGES) {
        for (const pair of render.pairs) {
          const reading = s9Read(pair, base, page);
          expect(
            reading.ratio,
            `m23s9 X1 CONTRAST ${s9Describe(pair, reading, pageName)}; WCAG 1.4.3 AA needs ` +
              `≥ ${S9_AA}:1 (small text)`,
          ).toBeGreaterThanOrEqual(S9_AA);
        }
      }
    }
  });

  it('m23s9 X2 under prefers-contrast: more every pair reaches 7:1 on an OPAQUE backdrop, never below its default ratio, and the card border keeps 3:1', () => {
    // WRONG IMPLEMENTATIONS KILLED: no override block at all (the header comment's prose mention
    // would satisfy a RAW census — hence the STRIPPED one); an override located by text slicing
    // that a nested or renamed at-rule fools; a block that re-declares the default values (7:1
    // fails); a `more` backdrop that stays translucent; an override that LOWERS a pair (the
    // per-pair more ≥ default assertion); a `more` border that vanishes into the card.
    const scopes = s9TokenScopes();
    const stripped = s9StripComments(scopes.css);
    expect(
      stripped.split(S9_MORE_PRELUDE).length - 1,
      `m23s9 X2 CENSUS: client/src/styles.css must carry exactly ONE \`${S9_MORE_PRELUDE}\` on ` +
        'COMMENT-STRIPPED text. The file header mentions that prelude in prose, so a raw census ' +
        'reads 1 with no block at all — the stripped count is the only honest one',
    ).toBe(1);
    expect(
      scopes.moreRules,
      'm23s9 X2 SCOPE: exactly ONE `:root` rule whose sole enclosing at-rule normalises to ' +
        `\`${S9_MORE_PRELUDE}\` declares --mr-evo-* tokens (located by atStack, never text)`,
    ).toBe(1);
    expect(
      scopes.baseRules,
      'm23s9 X2 SCOPE: exactly ONE depth-0 `:root` rule declares --mr-evo-* tokens',
    ).toBe(1);
    // SOURCE ORDER (red-team: the `more` block written BEFORE the default `:root` passed every
    // other clause and is INERT in a browser — same specificity, a media query adds none, the
    // later rule wins). `startIndex`/`endIndex` are brace offsets in the comment-stripped sheet.
    expect(
      scopes.moreRule!.startIndex,
      `m23s9 X2 ORDER: the \`${S9_MORE_PRELUDE}\` :root rule (starts at offset ` +
        `${scopes.moreRule!.startIndex}) must come AFTER the default :root rule (ends at offset ` +
        `${scopes.baseRule!.endIndex}) — written first, it loses the cascade to the default and ` +
        'every override below is dead in every real browser',
    ).toBeGreaterThan(scopes.baseRule!.endIndex);
    // `scopes.more` is used UNMERGED: a token missing from the override block must throw HERE (each
    // gate runs alone under `-t`), not be papered over by a fallback to the default value.
    const moreScope = scopes.more;

    for (const state of S9_STATES) {
      const render = s9Render(state);
      s9AssertCensus(render);
      const rootBg = s9Rgb(
        s9Resolve(s9OwnBg(render.root), moreScope, `${state} root backdrop (more)`),
        `${state} root backdrop (more)`,
      );
      expect(
        rootBg[3],
        `m23s9 X2 OPAQUE: ${state} root backdrop resolves to ${s9OwnBg(render.root)} → alpha ` +
          `${rootBg[3]} under more; a high-contrast user must not see the game through the overlay`,
      ).toBe(1);
      for (const [pageName, page] of S9_PAGES) {
        for (const pair of render.pairs) {
          const more = s9Read(pair, moreScope, page);
          const base = s9Read(pair, scopes.base, page);
          expect(
            more.ratio,
            `m23s9 X2 AAA ${s9Describe(pair, more, pageName)} under more; needs ≥ ${S9_AAA}:1`,
          ).toBeGreaterThanOrEqual(S9_AAA);
          // 1e-9 slack: an identical pair measured through an unrounded translucent composite and
          // through an opaque backdrop differed by one ulp (red-team, measured).
          expect(
            more.ratio,
            `m23s9 X2 MONOTONE ${pair.state}/${pair.label}: more (${more.ratio.toFixed(2)}) must ` +
              `not fall below default (${base.ratio.toFixed(2)}) over a ${pageName} page — an ` +
              'override is not allowed to make anything WORSE for the user who asked for more',
          ).toBeGreaterThanOrEqual(base.ratio - 1e-9);
        }
      }
      // Card boundary — pinned count first so the loop cannot be vacuous.
      const cards = [...render.root.querySelectorAll(CARD_SELECTOR)] as HTMLElement[];
      expect(cards, `m23s9 X2 ${state}: ${S9_CARD_COUNT[state]} card(s)`).toHaveLength(
        S9_CARD_COUNT[state],
      );
      for (const card of cards) {
        const border = s9BorderToken(s9BorderText(card), scopes, `${state} card border`);
        const cardOwn = s9Rgb(s9Resolve(s9OwnBg(card), moreScope, 'card bg (more)'), 'card bg');
        const cardBg = cardOwn[3] >= 1 ? cardOwn : s9Over(cardOwn, rootBg);
        expect(
          s9Contrast(s9Luminance(border.more), s9Luminance(cardBg)),
          `m23s9 X2 BORDER ${state}: var(${border.name}) → ${s9Hex(border.more)} vs the more card ` +
            `${s9Hex(cardBg)} must reach ≥ ${S9_NON_TEXT}:1 (WCAG 1.4.11) so a high-contrast user ` +
            'keeps the card boundary',
        ).toBeGreaterThanOrEqual(S9_NON_TEXT);
        expect(
          s9Contrast(s9Luminance(border.more), s9Luminance(rootBg)),
          `m23s9 X2 BORDER ${state}: var(${border.name}) → ${s9Hex(border.more)} vs the more ` +
            `backdrop ${s9Hex(rootBg)} must reach ≥ ${S9_NON_TEXT}:1`,
        ).toBeGreaterThanOrEqual(S9_NON_TEXT);
        // Row boundary (red-team: a token consumed ONLY by the unmet row's border-left was counted
        // as consumed yet never measured). Each row's border-left token vs the resolved row surface.
        const rows = [...card.querySelectorAll(PATH_ROW_SELECTOR)] as HTMLElement[];
        expect(rows, `m23s9 X2 ${state}: ${S9_ROW_COUNT[state]} row(s)`).toHaveLength(
          S9_ROW_COUNT[state],
        );
        for (const row of rows) {
          const where = `${state} ${s9Label(row)} border-left`;
          const left = s9BorderToken(s9BorderLeftText(row), scopes, where);
          const rowOwn = s9Rgb(s9Resolve(s9OwnBg(row), moreScope, `${where} row bg`), 'row bg');
          const rowBg = rowOwn[3] >= 1 ? rowOwn : s9Over(rowOwn, cardBg);
          expect(
            s9Contrast(s9Luminance(left.more), s9Luminance(rowBg)),
            `m23s9 X2 BORDER ${where}: var(${left.name}) → ${s9Hex(left.more)} vs the more row ` +
              `${s9Hex(rowBg)} must reach ≥ ${S9_NON_TEXT}:1 — the met/unmet edge is the row's only ` +
              'non-text status cue',
          ).toBeGreaterThanOrEqual(S9_NON_TEXT);
        }
      }
    }
  });

  it('m23s9 X3 token hygiene: every inline colour is a var(--mr-evo-*), both scopes declare the same names exactly once, every token is consumed, and only allow-listed declarations ship', () => {
    // WRONG IMPLEMENTATIONS KILLED: a hex literal left inline (today's tree); a token declared in
    // the default scope but missing from `more` (the override would be PARTIAL — the browser
    // falls through to the default value); a token declared twice (the Map dedupes, the count does
    // not); a decoy token nothing reads; a `--mr-evo-*` smuggled into another rule/at-rule;
    // `opacity` / `filter` / `mix-blend-mode` / `text-shadow` / `-webkit-text-fill-color` /
    // `background-image` / bare `background` / `font` / `zoom` / `transform`, which all change
    // rendered contrast without touching `color` or `background-color`; a `background: var(…)`
    // SHORTHAND (empty longhand read → the pair silently measures against the wrong surface).
    // RED-TEAM ROUND 2 (measured GREEN, now closed here): a class/id on an element + a rule in
    // styles.css (`.evo-dim{opacity:.3}`), `p{color:#666 !important}` in styles.css, a textless
    // positioned cover element inside the card, and five happy-dom-DROPPED declarations
    // (`var(--x, #666)` fallback, `COLOR:`, `VAR(`, `0.85EM`, `FONT-SIZE:`) that render in a browser.
    const consumed = new Set<string>();
    const scopes = s9TokenScopes();

    for (const state of S9_STATES) {
      const render = s9Render(state);
      s9AssertCensus(render);
      for (const el of s9AllElements(render.root)) {
        const label = `${state}/${s9Label(el)}`;
        const colour = el.style.color;
        if (colour !== '') {
          expect(
            colour.startsWith(S9_VAR_PREFIX) && s9TokenName(colour) !== null,
            `m23s9 X3 TOKEN ${label}: inline color ${JSON.stringify(colour)} must be a bare ` +
              `${S9_VAR_PREFIX}…) reference — a literal is invisible to the prefers-contrast override`,
          ).toBe(true);
        }
        const bg = el.style.backgroundColor;
        if (bg !== '') {
          expect(
            bg.startsWith(S9_VAR_PREFIX) && s9TokenName(bg) !== null,
            `m23s9 X3 TOKEN ${label}: inline background-color ${JSON.stringify(bg)} must be a ` +
              `bare ${S9_VAR_PREFIX}…) reference`,
          ).toBe(true);
        }
        // STYLESHEET ROUTE, element side (red-team: `className = 'evo-dim'` + `.evo-dim{opacity:.3}`
        // in styles.css passed). No element in the subtree may be reachable by a class or id rule.
        expect(
          el.className,
          `m23s9 X3 NO-CLASS ${label}: no element in the overlay may carry a class — a stylesheet ` +
            'rule reaching it changes rendered contrast behind every inline read',
        ).toBe('');
        expect(el.id, `m23s9 X3 NO-ID ${label}: no element in the overlay may carry an id`).toBe(
          '',
        );
        const names = s9DeclaredNames(el);
        for (const name of names) {
          expect(
            S9_ALLOWED_DECLARATIONS.has(name),
            `m23s9 X3 ALLOW-LIST ${label}: inline declaration \`${name}\` is not in the allow-list ` +
              `(style="${el.getAttribute('style') ?? ''}"). Every name outside it is a way to change ` +
              'rendered contrast that no colour read can see',
          ).toBe(true);
          // COVER ELEMENT (red-team: a textless absolutely-positioned child painted over the card
          // passed). Only the root positions itself; nothing below it may.
          if (el !== render.root) {
            expect(
              name === 'position' || name === 'inset' || name === 'z-index',
              `m23s9 X3 NO-COVER ${label}: \`${name}\` is allowed on the root only — a positioned ` +
                'descendant can paint over the text this oracle measured',
            ).toBe(false);
          }
        }
        // happy-dom populates the longhand from a LITERAL shorthand too, so this equivalence is
        // about the attribute's own spelling: a `background:` shorthand (literal or var()) names
        // `background`, never `background-color`, and is refused by the ALLOW-LIST above; here the
        // two reads are pinned to agree so neither can be gamed without the other noticing.
        expect(
          names.includes('background-color'),
          `m23s9 X3 COHERENCE ${label}: the attribute names background-color ⇔ ` +
            `style.backgroundColor is non-empty (read ${JSON.stringify(bg)}; names: ${names.join(', ')})`,
        ).toBe(bg !== '');
        // RAW WRITES: what the view actually wrote must be what happy-dom kept (see the helper).
        s9AssertRawWritesSurvive(el, render.writes.get(el.style) ?? [], label);
      }
      // Consumption: every fg / bg source the walk EVALUATED.
      for (const pair of render.pairs) {
        for (const raw of [pair.fgRaw, ...pair.bgRaws]) {
          const name = s9TokenName(raw);
          if (name !== null) consumed.add(name);
        }
      }
      // Border references — the two consumers that are not text pairs; counts pinned first.
      const cards = [...render.root.querySelectorAll(CARD_SELECTOR)] as HTMLElement[];
      expect(cards, `m23s9 X3 ${state}: ${S9_CARD_COUNT[state]} card(s)`).toHaveLength(
        S9_CARD_COUNT[state],
      );
      for (const card of cards) {
        consumed.add(s9BorderToken(s9BorderText(card), scopes, `${state} card border`).name);
      }
      const rows = [...render.root.querySelectorAll(PATH_ROW_SELECTOR)] as HTMLElement[];
      expect(rows, `m23s9 X3 ${state}: ${S9_ROW_COUNT[state]} row(s)`).toHaveLength(
        S9_ROW_COUNT[state],
      );
      for (const row of rows) {
        const where = `${state} ${s9Label(row)} border-left`;
        consumed.add(s9BorderToken(s9BorderLeftText(row), scopes, where).name);
      }
    }

    // ---- stylesheet hygiene ----
    // STYLESHEET ROUTE, sheet side (red-team: `p{color:#666 !important}` in styles.css passed).
    // Every rule is a single class selector or `:root`, and nothing is `!important`. The exact
    // rule roster is deliberately NOT pinned — a future class rule must not red this gate.
    expect(
      scopes.rules.length,
      'm23s9 X3 SHEET ANTI-VACUITY: styles.css must parse to at least one style rule',
    ).toBeGreaterThanOrEqual(1);
    for (const rule of scopes.rules) {
      const where = [...rule.atStack, rule.prelude].join(' > ');
      for (const part of rule.prelude.split(',')) {
        const selector = part.trim();
        const simpleClass =
          selector.startsWith('.') &&
          !selector.includes(' ') &&
          !selector.includes('>') &&
          !selector.includes('+') &&
          !selector.includes('~') &&
          !selector.includes('*') &&
          !selector.includes('[') &&
          !selector.includes(':');
        expect(
          selector === ':root' || simpleClass,
          `m23s9 X3 SHEET SELECTOR \`${where}\`: every selector must be \`:root\` or a single ` +
            `class selector (\`.name\`, \`.a.b\`); \`${selector}\` could reach the class-less ` +
            'evolution subtree (element / attribute / universal selectors match it directly; a ' +
            'combinator reaches it through a classed ancestor)',
        ).toBe(true);
      }
      for (const decl of s9Declarations(rule.body)) {
        expect(
          decl.important,
          `m23s9 X3 SHEET IMPORTANT \`${where}\`: \`${decl.prop}\` is !important — the only way a ` +
            'stylesheet beats an inline declaration, and therefore banned sheet-wide',
        ).toBe(false);
      }
    }
    const baseNames = [...scopes.base.keys()].sort();
    const moreNames = [...scopes.more.keys()].sort();
    expect(
      baseNames.length,
      'm23s9 X3 ANTI-VACUITY: the default `:root` scope must declare at least one --mr-evo-* ' +
        'token (the plan table has nine)',
    ).toBeGreaterThanOrEqual(1);
    expect(
      moreNames,
      'm23s9 X3 TOTAL OVERRIDE: the `prefers-contrast: more` scope must declare EXACTLY the same ' +
        'SET of names as the default scope — a missing name falls through to the default value ' +
        'and the override is partial',
    ).toEqual(baseNames);
    for (const [name, count] of scopes.baseCounts) {
      expect(count, `m23s9 X3 ONCE: ${name} declared ${count}× in the default scope`).toBe(1);
    }
    for (const [name, count] of scopes.moreCounts) {
      expect(count, `m23s9 X3 ONCE: ${name} declared ${count}× in the more scope`).toBe(1);
    }
    expect(
      scopes.outside,
      'm23s9 X3 SCOPE: no rule outside the two `:root` scopes may declare a --mr-evo-* token',
    ).toEqual([]);
    for (const name of baseNames) {
      expect(
        consumed.has(name),
        `m23s9 X3 CONSUMED: ${name} is declared but no evaluated fg/bg pair or border reference ` +
          `across the four states reads it — a decoy token. Consumed: ${[...consumed].sort().join(', ')}`,
      ).toBe(true);
    }
    // The converse: every name the DOM consumes is declared in BOTH scopes (a reference to an
    // undeclared token renders the initial colour; a reference declared only in one scope is a
    // partial override that the set-equality above cannot see if the name is missing from both).
    for (const name of [...consumed].sort()) {
      expect(
        scopes.base.has(name),
        `m23s9 X3 DECLARED: the DOM references ${name} but the default :root scope does not declare it`,
      ).toBe(true);
      expect(
        scopes.more.has(name),
        `m23s9 X3 DECLARED: the DOM references ${name} but the more :root scope does not declare it`,
      ).toBe(true);
    }
  });

  it('m23s9 X4 every inline font-size is 12, 13 or 14 px, no font shorthand, and the layout containers declare none', () => {
    // WRONG IMPLEMENTATIONS KILLED: today's `0.85em` / `0.8em` / `0.75em` (WCAG 1.4.3's large-text
    // threshold is stated in px/pt, and an em chain is unauditable without layout); `rem` / `%`;
    // a `font:` shorthand hiding the size; a container `font-size` that rescales every child at
    // once (defeats per-element auditing and browser zoom uniformity, WCAG 1.4.4); a size outside
    // the plan's three values.
    let declared = 0;
    for (const state of S9_STATES) {
      const render = s9Render(state);
      s9AssertCensus(render);
      for (const el of s9AllElements(render.root)) {
        const label = `${state}/${s9Label(el)}`;
        const names = s9DeclaredNames(el);
        expect(
          names.includes('font'),
          `m23s9 X4 SHORTHAND ${label}: a \`font\` shorthand hides the size from this audit`,
        ).toBe(false);
        const size = el.style.fontSize;
        if (size === '') continue;
        declared += 1;
        expect(
          size.endsWith('px'),
          `m23s9 X4 UNIT ${label}: font-size ${JSON.stringify(size)} must be in px (plan D2: ` +
            '0.85em→14px, 0.8em→13px, 0.75em→12px)',
        ).toBe(true);
        const px = Number.parseFloat(size.slice(0, -'px'.length));
        expect(
          S9_PX_SIZES.includes(px),
          `m23s9 X4 SIZE ${label}: font-size ${JSON.stringify(size)} must be one of ` +
            `${S9_PX_SIZES.join(' / ')}px`,
        ).toBe(true);
      }
      for (const { label, el } of s9Containers(render)) {
        expect(
          el.style.fontSize,
          `m23s9 X4 CONTAINER ${state}/${label}: layout containers declare NO font-size, so every ` +
            'text element carries its own auditable px size and zoom scales them uniformly',
        ).toBe('');
      }
    }
    expect(
      declared,
      'm23s9 X4 ANTI-VACUITY: at least six text elements across the four states must declare an ' +
        'inline font-size (hint, stats, headings, statuses, gates, ready note, prompt, buttons)',
    ).toBeGreaterThanOrEqual(6);
  });
});
