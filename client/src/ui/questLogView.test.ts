// @vitest-environment happy-dom
// ui/questLogView.test.ts — m23-s3 RED gating tests for the RENDER-DRIVEN overlay a11y wiring
// (questLogView has no show(); its only open edge is render(vm | null)'s null -> non-null
// transition), plus the pre-existing render behaviour this file is the first spec to pin at all.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/15/16/34);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1/F2/F4/F7, §1 D1/D2/D3/D7/D8, §4, §7 A1/A3/A6/A7/A8;
//   memory/projects/gates/m23-s3.gates.md X1/X2/X3/X4/X6/X7/X8/X9;
//   ui/overlayA11y.ts (the S1 helper this view must DELEGATE to), ui/overlayRegistry.ts (OVERLAY_A11Y).
//
// RED REASON: `client/src/ui/questLogView.ts` DOES NOT CALL openOverlayA11y/closeOverlayA11y AT ALL
// today — the file is byte-unchanged from master @0953db7. Every S3-* test below therefore fails now:
// no aria-label is ever written, nothing schedules a focus, role/aria-modal survive a close (only
// closeOverlayA11y strips them), and every `toHaveBeenCalledTimes(...)` on the spied helpers is 0.
// The NON-S3 tests in this file (render behaviour) pass NOW and must keep passing.
//
// WHY THIS VIEW IS THE ASYMMETRY CASE (plan F4, and the reason X7 exists): questLogView is OPENED by
// `render(vm)` (main.ts:477-479 `openQuestLog()` calls ONLY render) but CLOSED by `hide()`
// (main.ts:1142, :1376, :363). A `#lastVmWasNull` field would be updated only inside render(), never
// see the hide, and the SECOND open would silently ship no role, no label, no focus and no trap —
// while passing every single-cycle test. S3-questLogView-REOPEN-AFTER-HIDE is that falsifier.
//
// TWO ORACLES, BOTH REQUIRED (plan A3, measured by red-team):
//   * VALUE oracle  — `aria-label === t(OVERLAY_A11Y['questLogView'].labelKey)`. `role`/`aria-modal`
//     are ALREADY static literals on every shell in client/index.html:22 (m23-s2), so asserting them
//     ALONE is VACUOUS: a view that calls nothing passes. They appear here only in the same it() as
//     aria-label, and their ABSENCE after close is the anti-vacuity partner.
//   * MECHANISM oracle — `vi.mock('./overlayA11y', { spy: true })` records the calls AND calls
//     through to the real implementation. A cheat that hand-writes the three attributes with the
//     correct copied literal passes the VALUE oracle while shipping no trap, no return-focus record
//     and no timer; only the call assertion reds it, and the id argument simultaneously kills the
//     copy-pasted-wrong-OverlayId impl (all 16 catalog values are distinct, plan F2).
//
// TEST-ISOLATION DEVICE (plan A8 / V7, copied from ui/overlayA11y.test.ts:97-105 — deliberate, not
// boilerplate): overlayA11y.ts holds ONE module-private Map<OverlayId, record> and exports no reset
// hook (a zero-consumer production export is banned by that module family's A7/A15 rule,
// ui/overlayRegistry.ts:24-30), so beforeEach/afterEach call the PRODUCTION closeOverlayA11y(id,null)
// for every OverlayId and flush ONE REAL MACROTASK. That is legal precisely because
// close-without-open is a documented no-op (ui/overlayA11y.ts:41-45, gated by
// S1-CLOSE-WITHOUT-OPEN-NOOP). It also cancels any pending deferred-focus timer a test deliberately
// left dangling. `vi.clearAllMocks()` runs LAST in beforeEach so the sweep's own close calls never
// pollute a test's call counts.
//
// NEVER FAKE TIMERS (plan anti-pattern #10): the defer is a REAL setTimeout(...,0) by design
// (ui/overlayA11y.ts:17-20); it is flushed with `await new Promise((r) => setTimeout(r, 0))`.
//
// FIXTURE FIDELITY: the overlay root is byte-copied from client/index.html:22-24, INCLUDING
// `style="display:none"` (without it the first render(vm) is a no-edge and every open assertion is
// silently vacuous — vacuity attack V4, pinned by the `view.visible === false` assertion in
// S3-questLogView-OPEN-ARIA), the static `role`/`aria-modal` literals (without them the
// "attributes absent after close" tooth is vacuous — attack V1) and the `tabindex="-1"` anchor.
// The tabindex buys ZERO test power (plan A7: happy-dom's .focus() moves activeElement onto a bare
// <div> with no tabindex at all — it does not model focusability); it is copied for fidelity only.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/plan only.
//
// WRONG-IMPL-KILLED index:
//   - never opens at all / attribute-only cheat         -> S3-questLogView-OPEN-ARIA + -HELPER-CALLED
//   - copy-pasted WRONG OverlayId                       -> S3-questLogView-OPEN-ARIA (label) + -HELPER-CALLED (id arg)
//   - synchronous focus (no defer)                      -> S3-questLogView-DEFER-FOCUS (negative polarity)
//   - focuses nothing / a wrapper instead of the anchor  -> S3-questLogView-DEFER-FOCUS (identity, positive polarity)
//   - close never strips ARIA / never restores focus     -> S3-questLogView-CLOSE-RESTORE
//   - UNGUARDED open on every render                     -> S3-questLogView-REPEAT-NO-REOPEN + -EDGE-COUNTS
//   - `#lastVmWasNull` field instead of `visible` (D3)   -> S3-questLogView-REOPEN-AFTER-HIDE
//   - UNGUARDED close in the render(null) branch         -> S3-questLogView-EDGE-COUNTS + -CLOSE-UNGUARDED (half B)
//   - GUARDED close in hide() (kills S1's A13 self-heal) -> S3-questLogView-CLOSE-UNGUARDED (half A)
//   - `fallbackFocus` passed as undefined/an element      -> S3-questLogView-HELPER-CALLED (literal null, D8/A6)
//   - render() stops painting rows / appends instead of rebuilding -> the render-behaviour block

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import type { QuestLogViewModel } from './questLogModel';
import { QuestLogView } from './questLogView';

// The MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works in the
// same test. Measured working in this repo's vitest 4 (plan §7 "Verified mechanics").
vi.mock('./overlayA11y', { spy: true });

const ID: OverlayId = 'questLogView';
const META = OVERLAY_A11Y[ID];

// ---------------------------------------------------------------------------
// Fixture + helpers
// ---------------------------------------------------------------------------

/** Byte-copy of client/index.html:22-24 — the shell QuestLogView binds to. */
function mountQuestLogOverlay(): HTMLElement {
  document.body.innerHTML = `
    <div id="quest-log-overlay" role="dialog" aria-modal="true" style="display:none">
      <ul id="quest-log-list" tabindex="-1"></ul>
    </div>
  `;
  return document.getElementById('quest-log-overlay') as HTMLElement;
}

/** One REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0). */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A focusable OUTSIDE the overlay: the "pre-overlay" element a close must restore focus to. */
function addOutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root: render() only rebuilds
 *  #quest-log-list, so this node survives every re-render. If it loses focus, something RE-OPENED
 *  the overlay and re-ran the deferred initial focus. */
function addInsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

function questVm(count = 2): QuestLogViewModel {
  return {
    active: Array.from({ length: count }, (_unused, i) => ({
      questId: `quest_${i}`,
      stepIndex: i,
      displayName: `quest_${i}`,
    })),
  };
}

beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
  // LAST: the sweep above calls the spied close; clearing after it keeps per-test counts honest.
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Overlay a11y wiring on the render(vm | null) edge
// ---------------------------------------------------------------------------

describe('QuestLogView — overlay a11y wiring on the render edge (m23-s3)', () => {
  it('S3-questLogView-OPEN-ARIA BITES: the null->non-null edge labels the root from OVERLAY_A11Y/t(), and the fixture really starts hidden', () => {
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();

    // VACUITY ATTACK V4, closed here: a fixture missing `style="display:none"` makes the FIRST
    // render(vm) a NO-EDGE (wasVisible already true), so every open assertion below would be
    // silently vacuous. Pin the precondition before asserting anything about the open.
    expect(
      view.visible,
      'V4: the shell must start hidden, so the first render(vm) IS an edge',
    ).toBe(false);

    view.render(questVm());

    // Every expectation is DERIVED from the table at assert time — never a literal (V5).
    // WRONG IMPL KILLED: a hardcoded 'Journal (Quests)'/'dialog' pair reds the day the catalog
    // changes; a copy-pasted WRONG OverlayId reds NOW (all 16 catalog values are distinct, F2).
    expect(root.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(META.role);
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(
      root.getAttribute('aria-label'),
      'THE tooth: role/aria-modal are static literals in index.html:22 and pass a view that calls ' +
        'nothing; aria-label is absent from every shell, so only a real open can produce it',
    ).toBe(t(META.labelKey));
  });

  it('S3-questLogView-DEFER-FOCUS BITES: both polarities — NOT focused synchronously, focused after ONE real macrotask, and the defer is owned by openOverlayA11y', async () => {
    const root = mountQuestLogOverlay();
    const target = root.querySelector<HTMLElement>(META.initialFocusSelector);
    expect(target, `the fixture must contain ${META.initialFocusSelector}`).not.toBeNull();
    const view = new QuestLogView();

    view.render(questVm());

    // NEGATIVE polarity. WRONG IMPL KILLED: a synchronous focus reintroduces the exact bug the
    // defer exists to avoid — the letter that OPENED the overlay lands in
    // the field it just opened.
    expect(document.activeElement, 'the initial focus must NOT have landed synchronously').not.toBe(
      target,
    );

    // The defer must come from the S1 helper, not from a view-local setTimeout. This is
    // the clause that reds a view which schedules its OWN focus and never calls the helper.
    expect(
      vi.mocked(openOverlayA11y),
      'the deferred focus must be scheduled by openOverlayA11y, not by the view',
    ).toHaveBeenCalledTimes(1);

    await flushMacrotask();

    // POSITIVE polarity, by IDENTITY — never `root.contains(activeElement)`, which passes on any
    // decorative wrapper. WRONG IMPL KILLED: an impl that focuses the root itself, or nothing.
    expect(document.activeElement).toBe(target);
  });

  it('S3-questLogView-CLOSE-RESTORE BITES: hide() strips role, aria-modal AND aria-label from the root and hands focus back to the pre-overlay element', async () => {
    // hide() is questLogView's PRODUCTION close — render(null) is
    // unreachable for this view in production (plan F4/F5), so the restore path is pinned here
    // through the path the app actually takes.
    const root = mountQuestLogOverlay();
    const outside = addOutsideSentinel();
    outside.focus();
    expect(document.activeElement, 'precondition: focus starts OUTSIDE the overlay').toBe(outside);

    const view = new QuestLogView();
    view.render(questVm());
    await flushMacrotask();
    expect(
      document.activeElement,
      'precondition: the open moved focus INTO the overlay, so the restore below is a real move',
    ).not.toBe(outside);

    view.hide();

    // VACUITY ATTACK V1, closed here: index.html ships role/aria-modal as STATIC LITERALS, so the
    // only way they can be ABSENT is if closeOverlayA11y really ran.
    // This is the anti-vacuity partner of S3-questLogView-OPEN-ARIA and it kills the
    // "rely on the static literals, call nothing" cheat outright.
    expect(
      root.getAttribute('role'),
      'a display:none node must not keep claiming to be a dialog',
    ).toBeNull();
    expect(root.getAttribute('aria-modal')).toBeNull();
    expect(root.getAttribute('aria-label')).toBeNull();

    expect(document.activeElement, 'focus must return to the pre-overlay element').toBe(outside);
  });

  it('S3-questLogView-REPEAT-NO-REOPEN BITES: a repeat render(vm) at the SAME nullity neither re-opens nor yanks focus back', async () => {
    // THE CRUX (plan F6): a re-open clears and re-schedules the deferred-focus timer,
    // so an unguarded delegation yanks focus off whatever the player
    // Tabbed to on every re-render and the overlay becomes untabbable. This failure mode is
    // INVISIBLE to every attribute assertion — a re-open rewrites byte-identical values.
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render(questVm());
    await flushMacrotask();

    const inside = addInsideSentinel(root);
    inside.focus();
    expect(document.activeElement, 'precondition: focus is parked INSIDE the overlay').toBe(inside);

    view.render(questVm());
    await flushMacrotask();

    expect(
      document.activeElement,
      'a repeat render must NOT re-run the deferred initial focus',
    ).toBe(inside);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S3-questLogView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    // THE MECHANISM ORACLE (plan A3). Measured by red-team: a view that hand-writes
    // role/aria-modal/aria-label with the correct copied literal passes every VALUE assertion in
    // this file while shipping NO focus trap, NO return-focus record and NO deferred-focus timer.
    // Only this call assertion reds it. The id argument also kills the copy-pasted-wrong-id impl,
    // and the literal `null` pins ADR-0205 A3 / plan D8 (S3 views hold no canvas handle).
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render(questVm());
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(ID, root);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(ID, null);
  });

  it('S3-questLogView-EDGE-COUNTS BITES: 3x render(vm) = ONE open; 3x render(null) = ONE close; and a full cycle fires open -> close -> open IN THAT ORDER', () => {
    // A11Y-34. The close side is NOT DOM-observable (a second close is an idempotent no-op,
    // ui/overlayA11y.ts:136-137), so only a call COUNT can see an unguarded render(null) branch.
    mountQuestLogOverlay();
    const view = new QuestLogView();

    // Phase 1 — three identical non-null renders collapse to ONE open.
    view.render(questVm());
    view.render(questVm());
    view.render(questVm());
    expect(vi.mocked(openOverlayA11y), '3x render(vm) is ONE open edge').toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y), 'no close on the non-null path').toHaveBeenCalledTimes(0);

    // Phase 2 — three identical null renders collapse to ONE close.
    view.render(null);
    view.render(null);
    view.render(null);
    expect(vi.mocked(closeOverlayA11y), '3x render(null) is ONE close edge').toHaveBeenCalledTimes(
      1,
    );
    expect(vi.mocked(openOverlayA11y), 'still exactly one open').toHaveBeenCalledTimes(1);

    // Phase 3 — a full cycle is exactly three calls, in order.
    vi.clearAllMocks();
    view.render(questVm());
    view.render(null);
    view.render(questVm());
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    const opens = vi.mocked(openOverlayA11y).mock.invocationCallOrder;
    const closes = vi.mocked(closeOverlayA11y).mock.invocationCallOrder;
    // WRONG IMPL KILLED: an impl that closes then re-opens on the same non-null render would show
    // close BEFORE the first open; the ordering pins open -> close -> open exactly.
    expect(opens[0]).toBeLessThan(closes[0]);
    expect(closes[0]).toBeLessThan(opens[1]);
  });

  it('S3-questLogView-REOPEN-AFTER-HIDE BITES: render(vm) -> hide() -> render(vm) re-applies the FULL a11y contract on the SECOND open', () => {
    // THE FALSIFIER for the rejected `#lastVmWasNull` field (plan D3), and the reason it matters
    // MOST here (plan F4): questLogView is opened by render() but closed by hide(), so a field
    // updated only inside render() never sees the close and the second open ships nothing.
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render(questVm());
    expect(root.getAttribute('aria-label'), 'precondition: the first open labelled the root').toBe(
      t(META.labelKey),
    );

    view.hide();
    expect(root.getAttribute('aria-label'), 'hide() must close the overlay a11y record').toBeNull();

    view.render(questVm());
    expect(
      root.getAttribute('aria-label'),
      'the SECOND open must re-apply the label — a `#lastVmWasNull` field would skip it',
    ).toBe(t(META.labelKey));
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(2);
  });

  it('S3-questLogView-CLOSE-UNGUARDED BITES: hide() closes UNCONDITIONALLY (self-healing), while the render(null) branch stays GUARDED', () => {
    // Plan D2's deliberate ASYMMETRY, pinned in both directions.
    // Half A — a GUARDED hide() would read `visible === false` and skip the close whenever a record
    // desynchronised from the DOM (S1's named A13 leak, ui/overlayA11y.ts:55-59), making a live
    // capture listener, a pending timer and a stale return target PERMANENT. Unguarded, hide()
    // heals it, and close-without-open is a documented pure no-op.
    mountQuestLogOverlay();
    const view = new QuestLogView();
    expect(view.visible, 'precondition: never opened').toBe(false);

    expect(() => view.hide()).not.toThrow();
    expect(
      vi.mocked(closeOverlayA11y),
      'hide() on a never-opened view MUST still call the close — a guarded hide would call it zero times',
    ).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(ID, null);

    view.hide();
    expect(
      vi.mocked(closeOverlayA11y),
      'unguarded means unguarded: every hide() calls the close',
    ).toHaveBeenCalledTimes(2);

    // Half B — the render(null) path is the one that MUST be guarded.
    vi.clearAllMocks();
    view.render(questVm());
    view.render(null);
    expect(
      vi.mocked(closeOverlayA11y),
      'the non-null -> null edge closes once',
    ).toHaveBeenCalledTimes(1);
    view.render(null);
    expect(
      vi.mocked(closeOverlayA11y),
      'a repeat render(null) at the SAME nullity must NOT close again',
    ).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Pre-existing render behaviour — this file is the FIRST spec for questLogView, so the behaviour
// the S3 tests lean on (the list rebuild, the display flip) is pinned here rather than assumed.
// ---------------------------------------------------------------------------

describe('QuestLogView render(): existing paint behaviour (pinned, not changed by m23-s3)', () => {
  it('BITES: render(vm) shows the overlay and paints exactly one <li> per active quest, with displayName and step index', () => {
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();
    const vm = questVm(3);

    view.render(vm);

    expect(view.visible).toBe(true);
    expect(root.style.display).not.toBe('none');

    const items = (document.getElementById('quest-log-list') as HTMLElement).querySelectorAll('li');
    expect(items).toHaveLength(vm.active.length);
    expect(Array.from(items).map((li) => li.textContent)).toEqual(
      vm.active.map((e) => `${e.displayName} (step ${e.stepIndex})`),
    );
  });

  it('BITES: an empty active list renders zero <li>s (a real state — the server deletes the row on completion)', () => {
    mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render({ active: [] });

    expect(
      (document.getElementById('quest-log-list') as HTMLElement).querySelectorAll('li'),
    ).toHaveLength(0);
  });

  it('BITES: a second render REPLACES the rows rather than appending them', () => {
    mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render(questVm(3));
    expect(
      (document.getElementById('quest-log-list') as HTMLElement).querySelectorAll('li'),
    ).toHaveLength(3);

    view.render(questVm(1));
    expect(
      (document.getElementById('quest-log-list') as HTMLElement).querySelectorAll('li'),
    ).toHaveLength(1);
  });

  it('BITES: hide() hides the overlay (questLogView is opened by render() but CLOSED by hide() — main.ts:1142/:1376/:363)', () => {
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render(questVm());
    expect(view.visible).toBe(true);

    view.hide();
    expect(view.visible).toBe(false);
    expect(root.style.display).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// ctl-8f (CTL8F.3): the Journal's D-pad paint.
//
// `QuestLogView.paint({ questId, detail })` marks the cursor quest's row and shows the detail of the
// quest `detail` names. The rows stay `<li>`s in `#quest-log-list` with their text EXACTLY
// `tf('questLog.entry', ...)` (an e2e pins "quest_001 (step 0)"); each row also carries
// `data-quest-id`, the nav kit's `mr-nav-item` class, `role="option"` and `aria-selected`
// ("true" + `is-active` on the cursor row only), and the list `role="listbox"` plus
// `aria-activedescendant` naming the cursor row. `#quest-log-detail` is created by the view as a
// SIBLING AFTER the list (never an `li`, never inside it) and is shown only when `detail` names a
// listed quest. `render(vm)` re-applies the kept paint after it rebuilds the rows; on the hidden to
// visible edge (after `hide()` and after `render(null)`) the kept paint resets: the cursor is on the
// FIRST row and there is no detail.
//
// The fixture is this file's byte-copy of index.html's overlay, which has no detail element, so the
// view must make its own. The new journalScreen module is imported dynamically inside the WIRED case
// only, so a missing module reds that case alone.
// ---------------------------------------------------------------------------

import { tf as ctl8fTf, t as qf4T } from './i18n/resolver';

const ctl8fListEl = (): HTMLElement => document.getElementById('quest-log-list') as HTMLElement;
/** The list's own <li> children (a nested one, were a detail ever put inside, would not count). */
const ctl8fRows = (): HTMLLIElement[] =>
  [...ctl8fListEl().children].filter((el): el is HTMLLIElement => el.tagName === 'LI');
const ctl8fQuestIds = (): Array<string | undefined> => ctl8fRows().map((r) => r.dataset.questId);
/** The ids of the rows marked as the cursor (is-active). */
const ctl8fCursor = (): Array<string | undefined> =>
  ctl8fRows()
    .filter((r) => r.classList.contains('is-active'))
    .map((r) => r.dataset.questId);
const ctl8fDetailEl = (): HTMLElement | null => document.getElementById('quest-log-detail');
const ctl8fDetailShown = (): boolean => {
  const el = ctl8fDetailEl();
  return el !== null && el.style.display !== 'none';
};

/** Quests whose step index differs from their position, so a detail built from the wrong field or
 *  the wrong row shows. */
function ctl8fSteps(): QuestLogViewModel {
  return {
    active: [
      { questId: 'alpha', stepIndex: 4, displayName: 'alpha' },
      { questId: 'beta', stepIndex: 7, displayName: 'beta' },
      { questId: 'gamma', stepIndex: 0, displayName: 'gamma' },
    ],
  };
}

describe('QuestLogView ctl-8f: the Journal cursor and detail (CTL8F.3)', () => {
  it('CTL8F-3-VIEW-PAINT: a paint marks only the cursor row (is-active and aria-selected true, the others false) with the nav kit roles and a listbox naming it through aria-activedescendant, keeps the row text exactly as before, and shows a detail as a sibling AFTER the list only for a listed quest, with that quest`s name and its own step', () => {
    // WRONG IMPL KILLED: a paint that changes the row text (the e2e pins "quest_001 (step 0)"); a
    // cursor marked by colour alone or on every row or on the wrong one; rows with no roles (a
    // screen reader hears a bare list); an aria-activedescendant that names nothing, a row that is
    // not the cursor, or an id with whitespace (an IDREF is one token: a quest id with a space or
    // an empty one must not leak into it); a detail built from the FIRST row or from the row index
    // instead of the quest's step; a detail inside the list (it would be counted as a quest) or an
    // li; a detail shown for no quest, for a quest that is not listed, or after the paint cleared
    // it; and markup injected from a quest id.
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();
    view.render(questVm(3));
    view.paint({ questId: 'quest_1', detail: null });

    expect(ctl8fQuestIds(), 'one row per quest, each carrying its id').toEqual([
      'quest_0',
      'quest_1',
      'quest_2',
    ]);
    expect(
      ctl8fRows().map((r) => r.textContent),
      'the row text is unchanged',
    ).toEqual(['quest_0 (step 0)', 'quest_1 (step 1)', 'quest_2 (step 2)']);
    expect(ctl8fRows().map((r) => r.tagName)).toEqual(['LI', 'LI', 'LI']);
    expect(ctl8fCursor(), 'the cursor row only').toEqual(['quest_1']);
    expect(ctl8fRows().map((r) => r.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    for (const row of ctl8fRows()) {
      expect(row.classList.contains('mr-nav-item'), `${row.dataset.questId}: nav item`).toBe(true);
      expect(row.getAttribute('role'), `${row.dataset.questId}: option`).toBe('option');
    }
    expect(ctl8fListEl().getAttribute('role'), 'the list is a listbox').toBe('listbox');
    const activeId = ctl8fListEl().getAttribute('aria-activedescendant');
    expect(activeId, 'aria-activedescendant names a row').not.toBeNull();
    expect(document.getElementById(activeId ?? ''), 'the cursor row').toBe(ctl8fRows()[1]);
    expect(ctl8fDetailShown(), 'no detail without one in the paint').toBe(false);

    // The cursor moves; the old row is unmarked.
    view.paint({ questId: 'quest_2', detail: null });
    expect(ctl8fCursor()).toEqual(['quest_2']);
    expect(document.getElementById(ctl8fListEl().getAttribute('aria-activedescendant') ?? '')).toBe(
      ctl8fRows()[2],
    );

    // The detail: a sibling after the list, named and stepped by ITS quest.
    view.render(ctl8fSteps());
    view.paint({ questId: 'beta', detail: 'beta' });
    const detail = ctl8fDetailEl();
    expect(detail, 'the detail element exists').not.toBeNull();
    expect(ctl8fDetailShown(), 'and is shown').toBe(true);
    const el = detail as HTMLElement;
    expect(el.tagName, 'never a list row').not.toBe('LI');
    expect(el.parentElement, 'a sibling of the list').toBe(ctl8fListEl().parentElement);
    expect(ctl8fListEl().contains(el), 'never inside the list').toBe(false);
    const siblings = [...(el.parentElement?.children ?? [])];
    expect(
      siblings.indexOf(el) > siblings.indexOf(ctl8fListEl()) &&
        siblings.indexOf(ctl8fListEl()) >= 0,
      'after the list',
    ).toBe(true);
    expect(root.contains(el), 'inside the overlay').toBe(true);
    expect(ctl8fRows(), 'the detail is not a row').toHaveLength(3);
    const text = el.textContent ?? '';
    expect(text, 'the quest`s name').toContain('beta');
    expect(text, 'its own step, English "Step N"').toContain('Step 7');
    expect(text, 'the resolver`s journal.detail.step').toContain(
      ctl8fTf('journal.detail.step', { step: 7 }),
    );
    expect(text, 'not another quest`s').not.toContain('alpha');
    expect(text).not.toContain('Step 4');

    view.paint({ questId: 'alpha', detail: 'alpha' });
    expect(ctl8fDetailEl()?.textContent ?? '', 'the detail follows the paint').toContain('Step 4');
    expect(ctl8fDetailEl()?.textContent ?? '').not.toContain('Step 7');
    view.paint({ questId: 'alpha', detail: 'ghost' });
    expect(ctl8fDetailShown(), 'a detail naming a quest that is not listed is hidden').toBe(false);
    view.paint({ questId: 'gamma', detail: 'gamma' });
    expect(ctl8fDetailEl()?.textContent ?? '', 'a step of 0 is a step').toContain('Step 0');
    view.paint({ questId: 'gamma', detail: null });
    expect(ctl8fDetailShown(), 'a paint with no detail hides it').toBe(false);

    // Awkward ids: the row id is a single token and unique, the data attribute keeps the id.
    const awkward = ['a b', '', 'a_b', 'tab\tstop'];
    view.render({
      active: awkward.map((id, i) => ({ questId: id, stepIndex: i, displayName: id })),
    });
    for (const id of awkward) {
      view.paint({ questId: id, detail: null });
      expect(ctl8fCursor(), `the cursor on ${JSON.stringify(id)}`).toEqual([id]);
      const pointed = ctl8fListEl().getAttribute('aria-activedescendant') ?? '';
      expect(pointed, `an IDREF is one token (${JSON.stringify(id)})`).toMatch(/^\S+$/);
      expect(document.getElementById(pointed)?.dataset.questId, 'it names that very row').toBe(id);
    }
    const ids = ctl8fRows().map((r) => r.id);
    expect(new Set(ids).size, 'every row id is unique').toBe(awkward.length);
    view.paint({ questId: '', detail: '' });
    expect(ctl8fDetailShown(), 'the empty id is a quest too: its detail shows').toBe(true);

    // A quest id is text, never markup.
    const markup = '<img src=x onerror=alert(1)>';
    view.render({ active: [{ questId: markup, stepIndex: 1, displayName: markup }] });
    view.paint({ questId: markup, detail: markup });
    expect(root.querySelector('img'), 'no element was created from an id').toBeNull();
    expect(ctl8fRows().map((r) => r.dataset.questId)).toEqual([markup]);
  });

  it('CTL8F-3-VIEW-RENDER-KEEPS: render(vm) re-applies the kept cursor and detail after it rebuilds the rows (so a store batch never loses them); a quest vanishing mid-detail hides the detail; on the hidden to visible edge, after hide() and after render(null), the cursor is back on the FIRST row with no detail, and a later paint works as before', () => {
    // WRONG IMPL KILLED: a render() that rebuilds the rows and drops the cursor or the detail (the
    // journal would lose its place on every store batch, several times a second); a detail that
    // stays up for a quest that is gone; a kept paint that survives a close (the next KeyQ would
    // open on the old cursor with an old detail on top, for a quest the player has since left); a
    // reset on only one of the two close paths (hide() is the production close, render(null) the
    // other); an opening whose first row is not marked (a screen reader announces no selection); a
    // reset that also resets on every ordinary render; and a paint after the reset that is ignored.
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();
    view.render(questVm(3));
    expect(ctl8fCursor(), 'the opening: the first row is the cursor before any paint').toEqual([
      'quest_0',
    ]);
    expect(ctl8fRows()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(ctl8fDetailShown(), 'no detail on open').toBe(false);

    // Survives renders, including one that adds a quest.
    view.paint({ questId: 'quest_1', detail: 'quest_1' });
    const before = ctl8fRows();
    view.render(questVm(3));
    expect(ctl8fRows()[0], 'precondition: the rows were rebuilt').not.toBe(before[0]);
    expect(ctl8fCursor(), 'the cursor survives a render').toEqual(['quest_1']);
    expect(ctl8fDetailShown(), 'the detail survives a render').toBe(true);
    expect(ctl8fDetailEl()?.textContent ?? '').toContain('quest_1');
    expect(document.getElementById(ctl8fListEl().getAttribute('aria-activedescendant') ?? '')).toBe(
      ctl8fRows()[1],
    );
    view.render(questVm(3));
    view.render(questVm(4));
    expect(ctl8fCursor(), 'and several renders').toEqual(['quest_1']);
    expect(ctl8fDetailShown()).toBe(true);

    // The detail's quest vanishes mid-detail.
    view.render({ active: questVm(3).active.filter((e) => e.questId !== 'quest_1') });
    expect(ctl8fDetailShown(), 'a vanished quest`s detail is hidden').toBe(false);
    expect(ctl8fQuestIds()).toEqual(['quest_0', 'quest_2']);

    // hide() then render(vm): the opening again.
    view.render(questVm(3));
    view.paint({ questId: 'quest_2', detail: 'quest_2' });
    expect(ctl8fCursor(), 'precondition').toEqual(['quest_2']);
    expect(ctl8fDetailShown(), 'precondition').toBe(true);
    view.hide();
    view.render(questVm(3));
    expect(ctl8fCursor(), 'after hide(): the cursor is on the first row').toEqual(['quest_0']);
    expect(ctl8fDetailShown(), 'after hide(): no detail').toBe(false);
    expect(document.getElementById(ctl8fListEl().getAttribute('aria-activedescendant') ?? '')).toBe(
      ctl8fRows()[0],
    );
    view.render(questVm(3));
    expect(ctl8fCursor(), 'an ordinary render after the reset keeps it').toEqual(['quest_0']);

    // render(null) then render(vm): the same.
    view.paint({ questId: 'quest_1', detail: 'quest_1' });
    expect(ctl8fCursor(), 'precondition').toEqual(['quest_1']);
    expect(ctl8fDetailShown(), 'precondition').toBe(true);
    view.render(null);
    view.render(questVm(3));
    expect(ctl8fCursor(), 'after render(null): the cursor is on the first row').toEqual([
      'quest_0',
    ]);
    expect(ctl8fDetailShown(), 'after render(null): no detail').toBe(false);

    // A paint after the reset works as before.
    view.paint({ questId: 'quest_2', detail: null });
    expect(ctl8fCursor()).toEqual(['quest_2']);
    expect(root.contains(ctl8fListEl())).toBe(true);
  });

  it('CTL8F-3-VIEW-WIRED: the real journalScreen driving the real view over the overlay: the opening cursor is the first quest; Down moves it, A opens that quest`s detail, B closes it with the cursor kept, and a batch that renders again changes none of it', async () => {
    // WRONG IMPL KILLED: a view whose paint shape is not the adapter's (the hand-built cases above
    // would pass while the pair is unwired); a paint the adapter never makes after a step; a detail
    // for the wrong quest; and a render that wipes what the adapter painted.
    const { journalScreen } = await import('./screens/journalScreen');
    const me = 'ab'.repeat(32);
    const quests = [
      { pqId: 1n, ownerIdentity: me, questId: 'quest_001', stepIndex: 0 },
      { pqId: 2n, ownerIdentity: me, questId: 'quest_002', stepIndex: 3 },
    ];
    const ctx = {
      store: { ownQuests: (identity: string) => (identity === me ? quests : []) },
      identity: me,
      now: () => 0,
    } as unknown as Parameters<typeof journalScreen.viewModel>[0];
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();
    const vm = journalScreen.viewModel(ctx);
    view.render(vm);
    expect(
      ctl8fRows().map((r) => r.textContent),
      'the exact legacy row text',
    ).toEqual(['quest_001 (step 0)', 'quest_002 (step 3)']);

    let state = journalScreen.init(vm);
    const step = (button: 'Down' | 'A' | 'B') => {
      const out = journalScreen.onButton(vm, state, { button, repeat: false });
      state = out.state;
      journalScreen.paint?.(view, vm, state);
      return out.result;
    };
    journalScreen.paint?.(view, vm, state);
    expect(ctl8fCursor(), 'the opening cursor').toEqual(['quest_001']);

    expect(step('Down')).toBe('consumed');
    expect(ctl8fCursor()).toEqual(['quest_002']);
    expect(step('A')).toBe('consumed');
    expect(ctl8fDetailShown(), 'the detail is open').toBe(true);
    expect(ctl8fDetailEl()?.textContent ?? '').toContain('quest_002');
    expect(ctl8fDetailEl()?.textContent ?? '').toContain('Step 3');

    view.render(journalScreen.viewModel(ctx)); // a store batch
    expect(ctl8fCursor(), 'a batch keeps the cursor').toEqual(['quest_002']);
    expect(ctl8fDetailShown(), 'and the detail').toBe(true);

    expect(step('B')).toBe('consumed');
    expect(ctl8fDetailShown(), 'B closes the detail').toBe(false);
    expect(ctl8fCursor(), 'the cursor stays on that quest').toEqual(['quest_002']);
    expect(root.contains(ctl8fListEl())).toBe(true);
    expect(view.visible, 'the overlay stays open').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ctl-8f red-team teeth for the Journal view: the listbox pointers and names. Untagged cases.
// ---------------------------------------------------------------------------
describe('QuestLogView ctl-8f: the listbox pointers and names', () => {
  it('an emptied journal leaves the list with no aria-activedescendant', () => {
    // WRONG IMPL KILLED: a render that rebuilds the rows but never removes the pointer (it names
    // a row that is gone: a dangling IDREF a screen reader announces as nothing).
    mountQuestLogOverlay();
    const view = new QuestLogView();
    view.render(questVm(3));
    view.paint({ questId: 'quest_1', detail: null });
    expect(
      ctl8fListEl().getAttribute('aria-activedescendant'),
      'precondition: a pointer while rows exist',
    ).not.toBeNull();
    view.render({ active: [] });
    expect(ctl8fRows()).toHaveLength(0);
    expect(ctl8fListEl().hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('the list is named by the overlay, and described by the detail only while the detail is shown', () => {
    // WRONG IMPL KILLED: a listbox with no accessible name; a name pointing at another element; a
    // description that never appears, or that stays after the detail hides (by a paint, by a
    // vanished quest, or by a close and reopen) and so points at a hidden element.
    mountQuestLogOverlay();
    const view = new QuestLogView();
    view.render(questVm(3));
    view.paint({ questId: 'quest_1', detail: null });
    expect(ctl8fListEl().getAttribute('aria-labelledby')).toBe('quest-log-overlay');
    expect(ctl8fListEl().hasAttribute('aria-describedby'), 'no detail, no description').toBe(false);

    view.paint({ questId: 'quest_1', detail: 'quest_1' });
    expect(ctl8fListEl().getAttribute('aria-describedby')).toBe('quest-log-detail');
    expect(
      document.getElementById('quest-log-detail'),
      'the element it names exists',
    ).not.toBeNull();
    expect(ctl8fListEl().getAttribute('aria-labelledby'), 'the name is unchanged').toBe(
      'quest-log-overlay',
    );

    view.paint({ questId: 'quest_1', detail: null });
    expect(ctl8fListEl().hasAttribute('aria-describedby'), 'a paint that hides the detail').toBe(
      false,
    );

    view.paint({ questId: 'quest_1', detail: 'quest_1' });
    expect(ctl8fListEl().getAttribute('aria-describedby')).toBe('quest-log-detail');
    view.render({ active: questVm(3).active.filter((e) => e.questId !== 'quest_1') });
    expect(ctl8fDetailShown(), 'precondition: the vanished quest hid the detail').toBe(false);
    expect(ctl8fListEl().hasAttribute('aria-describedby'), 'a render that hides the detail').toBe(
      false,
    );

    view.render(questVm(3));
    view.paint({ questId: 'quest_2', detail: 'quest_2' });
    expect(ctl8fListEl().getAttribute('aria-describedby')).toBe('quest-log-detail');
    view.hide();
    view.render(questVm(3));
    expect(ctl8fDetailShown(), 'precondition: the reopen hides the detail').toBe(false);
    expect(ctl8fListEl().hasAttribute('aria-describedby'), 'a reopen').toBe(false);
    expect(ctl8fListEl().getAttribute('aria-labelledby'), 'the name survives the reopen').toBe(
      'quest-log-overlay',
    );
  });
});

// ---------------------------------------------------------------------------
// qf-4 (QF4.1, QF4.2): the Journal frame's visible title and its empty state.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-pt3-quickfix.spec.md §qf-4;
// memory/projects/monster-realm-qf-4-plan.md (design + AMENDMENTS A1-A8, which supersede the body).
//
// WHY BOTH ELEMENTS ARE BUILT AT RUNTIME. indexShell.smoke.test.ts exact-pins the set of `[id]`
// elements inside `#frame-layer` in the static index.html, so neither `#quest-log-title` nor
// `#quest-log-empty` may be added there; `QuestLogView` constructs them, as it already does for
// `#quest-log-detail`. This file's fixture (a byte-copy of the shell) therefore needs no change.
//
// RED REASON AT HEAD: the view builds no title and no empty element, so every `getElementById` below
// is null and every assertion on it fails.
//
// The catalog keys are added by this slice and are not in the MessageId union at the red phase, so
// the two literals are cast with `as never`; the runtime resolver is the oracle either way.
// ---------------------------------------------------------------------------

const qf4TitleText = (): string => qf4T('chrome.journal.title' as never);
const qf4EmptyText = (): string => qf4T('journal.empty' as never);
const qf4Title = (): HTMLElement | null => document.getElementById('quest-log-title');
const qf4Empty = (): HTMLElement | null => document.getElementById('quest-log-empty');
/** How many elements carry this id (getElementById returns only the first, so a duplicate hides). */
const qf4IdCount = (id: string): number => document.querySelectorAll(`[id="${id}"]`).length;

describe('QuestLogView qf-4: the Journal title (QF4.1)', () => {
  it('QF4-1-TITLE-FIRST-CHILD: after a render of any size the overlay holds exactly one #quest-log-title, its first element child, outside the listbox, class exactly mr-frame-title, text exactly the resolver`s chrome.journal.title', () => {
    // WRONG IMPL KILLED: no title at all; a title appended AFTER the list (list.after) or at the end
    // of the overlay (it would read below the rows); a title built INSIDE the listbox (it would be a
    // non-option child painted as a row); a literal `Journal` in the view instead of the catalog
    // (see the i18n file); an extra class (mr-frame-title plus something) or a different class; a
    // title that nests an element instead of text; a second title per render.
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();

    const expectTitle = (when: string): void => {
      expect(qf4IdCount('quest-log-title'), `${when}: exactly one title`).toBe(1);
      const title = qf4Title();
      expect(title, `${when}: the title exists`).not.toBeNull();
      expect(root.firstElementChild, `${when}: the overlay's first element child`).toBe(title);
      expect(ctl8fListEl().contains(title), `${when}: outside the listbox`).toBe(false);
      expect(title?.className, `${when}: the class, exactly`).toBe('mr-frame-title');
      expect([...(title?.classList ?? [])], `${when}: one class only`).toEqual(['mr-frame-title']);
      expect(title?.textContent, `${when}: the resolver's text`).toBe(qf4TitleText());
      expect((title?.textContent ?? '').length > 0, `${when}: not blank`).toBe(true);
      expect(title?.children.length, `${when}: text only, no child elements`).toBe(0);
    };

    view.render(questVm(2));
    expectTitle('with quests');

    view.render({ active: [] });
    expectTitle('empty');

    view.render(questVm(3));
    expectTitle('quests again');
  });

  it('QF4-1-TITLE-INERT: the title is plain visible text — no hidden, aria-hidden, tabindex or inline style', () => {
    // WRONG IMPL KILLED: a title hidden from sight or from a screen reader (display none, hidden,
    // aria-hidden); a title that is a tab stop or a focus anchor (the Journal's initial focus is the
    // list, overlayRegistry.ts); an inline style standing in for the .mr-frame-title class.
    mountQuestLogOverlay();
    const view = new QuestLogView();
    view.render(questVm(2));

    const title = qf4Title() as HTMLElement;
    expect(title, 'precondition: the title exists').not.toBeNull();
    expect(title.hasAttribute('hidden')).toBe(false);
    expect(title.hasAttribute('aria-hidden')).toBe(false);
    expect(title.hasAttribute('tabindex')).toBe(false);
    expect(title.hasAttribute('style')).toBe(false);
    expect(title.style.display).toBe('');
    expect(title.hidden).toBe(false);
  });

  it('QF4-1-TITLE-ONE-AFTER-REOPEN: render, hide and render again (and a null render) never leave two titles, and the title stays the first child', () => {
    // WRONG IMPL KILLED: a title built in render() on every call instead of once in the constructor
    // (one more title per batch, several a second); a title removed by hide() or render(null) and
    // not rebuilt; a reopen that moves the title behind the list.
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render(questVm(2));
    view.render(questVm(2));
    view.render(questVm(2));
    expect(qf4IdCount('quest-log-title'), 'three renders').toBe(1);

    view.hide();
    view.render(questVm(1));
    expect(qf4IdCount('quest-log-title'), 'hide then render').toBe(1);
    expect(root.firstElementChild).toBe(qf4Title());

    view.render(null);
    view.render({ active: [] });
    expect(qf4IdCount('quest-log-title'), 'render(null) then render').toBe(1);
    expect(root.firstElementChild).toBe(qf4Title());
    expect(qf4Title()?.textContent).toBe(qf4TitleText());
  });

  it('QF4-1-TITLE-NOT-A-ROW: the title never becomes a list row — the listbox holds exactly one <li> per active quest, none of them the title', () => {
    // WRONG IMPL KILLED: a title put in the list as an <li> or as any other child (the row count
    // would be one too many, the cursor fallback rows[0] would land on it, and the "zero <li>s when
    // empty" pin would break).
    mountQuestLogOverlay();
    const view = new QuestLogView();

    for (const count of [0, 1, 3]) {
      view.render(questVm(count));
      expect(ctl8fListEl().children.length, `${count} quests: the list's children`).toBe(count);
      expect(ctl8fRows(), `${count} quests: its <li> rows`).toHaveLength(count);
      for (const row of ctl8fRows()) {
        expect(row.textContent).not.toBe(qf4TitleText());
        expect(row.id).not.toBe('quest-log-title');
      }
    }
  });

  it('QF4-1-TITLE-FOCUS-ANCHOR-UNCHANGED: with the title in place the deferred initial focus still lands on #quest-log-list, never on the title', async () => {
    // WRONG IMPL KILLED: a title that steals the initial focus (a tabindex on it, or focus() called
    // on it) — the Journal's initial focus anchor is the listbox (overlayRegistry.ts
    // initialFocusSelector); and a title inserted so the anchor query resolves elsewhere.
    mountQuestLogOverlay();
    const view = new QuestLogView();
    view.render(questVm(2));
    expect(qf4Title(), 'precondition: the title exists').not.toBeNull();

    await flushMacrotask();

    expect(document.activeElement).toBe(ctl8fListEl());
    expect(document.activeElement).not.toBe(qf4Title());
  });
});

describe('QuestLogView qf-4: the Journal empty state (QF4.2)', () => {
  it('QF4-2-EMPTY-SHOWN: an empty active list shows #quest-log-empty after the list and outside it, with the resolver`s journal.empty text, no <li>, and the listbox described by it', () => {
    // WRONG IMPL KILLED: no empty state (a blank frame); the message placed INSIDE the listbox as an
    // <li role=option> (the cursor paint would land on it and "zero <li>s when empty" would break);
    // a literal English string instead of the catalog; an element that exists but stays hidden; a
    // listbox with no description, so a screen reader focused on the option-less list hears nothing;
    // a describedby naming something else.
    const root = mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render({ active: [] });

    expect(qf4IdCount('quest-log-empty'), 'exactly one empty element').toBe(1);
    const empty = qf4Empty() as HTMLElement;
    expect(empty, 'the empty element exists').not.toBeNull();
    expect(root.contains(empty), 'inside the overlay').toBe(true);
    expect(ctl8fListEl().contains(empty), 'never inside the listbox').toBe(false);
    expect(empty.tagName, 'never a list row').not.toBe('LI');
    expect(empty.getAttribute('role'), 'never an option').not.toBe('option');
    const siblings = [...(empty.parentElement?.children ?? [])];
    expect(
      siblings.indexOf(ctl8fListEl()) >= 0 &&
        siblings.indexOf(empty) > siblings.indexOf(ctl8fListEl()),
      'after the list',
    ).toBe(true);
    expect(empty.style.display, 'shown').toBe('');
    expect(empty.textContent, 'the resolver`s text').toBe(qf4EmptyText());
    expect((empty.textContent ?? '').length > 0, 'not blank').toBe(true);
    expect(ctl8fRows(), 'no row for the message').toHaveLength(0);
    expect(ctl8fListEl().children.length, 'nothing at all inside the list').toBe(0);
    expect(ctl8fListEl().getAttribute('aria-describedby'), 'the listbox is described by it').toBe(
      'quest-log-empty',
    );
  });

  it('QF4-2-EMPTY-HIDDEN-WITH-QUESTS: with quests the empty element is hidden (display none), its text cleared, and the listbox has no description; going back to empty shows it again', () => {
    // WRONG IMPL KILLED: an empty state that stays up beside real quests; a hidden element still
    // carrying its text (a find-in-page and some readers still reach it); a describedby left
    // pointing at a hidden element; an empty state that never comes back after a quest completes;
    // a second empty element built per render.
    mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render({ active: [] });
    const empty = qf4Empty() as HTMLElement;
    expect(empty, 'precondition: shown while empty').not.toBeNull();
    expect(empty.style.display).toBe('');

    view.render(questVm(2));
    expect(qf4Empty(), 'the same element, not a rebuilt one').toBe(empty);
    expect(qf4IdCount('quest-log-empty')).toBe(1);
    expect(empty.style.display, 'hidden beside quests').toBe('none');
    expect(empty.textContent, 'its text is cleared while hidden').toBe('');
    expect(ctl8fListEl().hasAttribute('aria-describedby'), 'no description (no detail open)').toBe(
      false,
    );
    expect(ctl8fRows()).toHaveLength(2);

    view.render({ active: [] });
    expect(qf4Empty()).toBe(empty);
    expect(qf4IdCount('quest-log-empty')).toBe(1);
    expect(empty.style.display, 'shown again').toBe('');
    expect(empty.textContent).toBe(qf4EmptyText());
    expect(ctl8fListEl().getAttribute('aria-describedby')).toBe('quest-log-empty');
  });

  it('QF4-2-EMPTY-SET-NOT-TOGGLED: the empty state is SET from the data on every render — empty then empty stays shown, quests then quests stays hidden, and a hide() then an empty render shows it', () => {
    // WRONG IMPL KILLED: a flip (display = display === none ? "" : none) instead of an assignment —
    // the second empty render would hide it and the second quest render would show it; an empty
    // state written only on the null to non-null edge, so a batch that empties the list while the
    // overlay stays open never shows it; a state that survives a close and reopen.
    mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render({ active: [] });
    view.render({ active: [] });
    expect(qf4Empty()?.style.display, 'empty, empty: still shown').toBe('');
    expect(qf4Empty()?.textContent).toBe(qf4EmptyText());

    view.render(questVm(2));
    view.render(questVm(2));
    expect(qf4Empty()?.style.display, 'quests, quests: still hidden').toBe('none');
    expect(qf4Empty()?.textContent).toBe('');

    view.hide();
    view.render({ active: [] });
    expect(qf4Empty()?.style.display, 'hide, then empty: shown').toBe('');
    expect(qf4Empty()?.textContent).toBe(qf4EmptyText());
    expect(ctl8fListEl().getAttribute('aria-describedby')).toBe('quest-log-empty');
  });

  it('QF4-2-EMPTY-DESCRIBEDBY-SURVIVES-PAINT: a paint after an empty render (even one naming a detail that is not listed) keeps the listbox described by the empty element; with a detail open it names the detail, and closing the detail does not leave the empty one behind', () => {
    // WRONG IMPL KILLED: a describedby written once in render() and then removed by applyPaint's
    // existing `removeAttribute` branch on the very next paint (the journal screen paints right after
    // every render); a description that names the empty element while a quest detail is open
    // (the detail wins when shown); a stale quest-log-empty left on the list once quests exist.
    mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render({ active: [] });
    view.paint({ questId: null, detail: null });
    expect(ctl8fListEl().getAttribute('aria-describedby'), 'paint after empty').toBe(
      'quest-log-empty',
    );
    view.paint({ questId: null, detail: 'ghost' });
    expect(ctl8fListEl().getAttribute('aria-describedby'), 'a detail that is not listed').toBe(
      'quest-log-empty',
    );

    view.render(questVm(3));
    view.paint({ questId: 'quest_1', detail: 'quest_1' });
    expect(ctl8fListEl().getAttribute('aria-describedby'), 'a detail is open').toBe(
      'quest-log-detail',
    );
    view.paint({ questId: 'quest_1', detail: null });
    expect(
      ctl8fListEl().hasAttribute('aria-describedby'),
      'quests listed, no detail: no description',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// qf-4 (QF4.3): the list-style sweep. Every static <ul> in index.html carries `mr-nav-list`, and
// styles.css gives that class `list-style: none`, so no overlay list paints a bullet or a stray
// marker (Rankings showed an inverted one).
//
// ORACLE. The REAL client/index.html and the REAL client/src/styles.css are loaded into happy-dom
// (the overlayA11yWiring.test.ts precedent: the <link rel=stylesheet> is stripped from the text, the
// css text is installed as a <style>). happy-dom 20.x has NO user-agent default list style (a bare
// <ul> computes listStyle ''), and does NOT expand the `list-style` shorthand: `.x{list-style:none}`
// computes listStyle 'none' and listStyleType ''. So the oracle is `listStyle === 'none'` (equality),
// guarded by sanity probes that show the sheet is parsed and applied and that the class is what does it.
//
// HAZARD (measured in overlayA11yWiring.test.ts): happy-dom caches computed style per element, so
// every element below is read ONCE, and the with-class / class-removed probes are two separate
// fresh elements.
//
// RED REASON AT HEAD: no `<ul>` carries the class and styles.css has no rule for it, so each tooth
// below fails (the static ULs compute '', the probe `<ul class="mr-nav-list">` computes '').
// ---------------------------------------------------------------------------

const QF4_UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const QF4_INDEX_HTML_PATH = path.join(QF4_UI_DIR, '..', '..', 'index.html');
const QF4_STYLES_CSS_PATH = path.join(QF4_UI_DIR, '..', 'styles.css');
const QF4_NAV_LIST = 'mr-nav-list';

/** The nine static <ul>s of client/index.html (an exact roster: the census below pins it). */
const QF4_STATIC_UL_IDS: readonly string[] = [
  'quest-log-list',
  'heal-list',
  'shop-for-sale',
  'shop-inventory',
  'pvp-player-list',
  'leaderboard-list',
  'help-controls',
  'help-goals',
  'menu-rows',
];

/** Install the REAL index.html body (no <script>, no <link>) into the test document. */
function qf4AdoptRealIndexHtml(): void {
  const html = readFileSync(QF4_INDEX_HTML_PATH, 'utf8');
  const parsed = new DOMParser().parseFromString(
    html.split('<link rel="stylesheet" href="/src/styles.css" />').join(''),
    'text/html',
  );
  for (const script of Array.from(parsed.querySelectorAll('script'))) script.remove();
  const adopted = Array.from(parsed.body.childNodes).map((n) => document.adoptNode(n));
  document.body.replaceChildren(...adopted);
}

interface Qf4CssRule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyArray<{ readonly prop: string; readonly value: string }>;
}

/** The TOP-LEVEL style rules of a stylesheet, comments stripped (a commented-out rule is not a
 *  rule). At-rule blocks (@media, @supports) are skipped whole: a rule that lives only inside one
 *  does not apply unconditionally. */
function qf4TopLevelRules(css: string): Qf4CssRule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Qf4CssRule[] = [];
  let depth = 0;
  let head = '';
  let body = '';
  for (const ch of stripped) {
    if (depth === 0) {
      if (ch === '{') {
        depth = 1;
        body = '';
      } else if (ch === ';') {
        head = ''; // an at-rule statement such as @import
      } else {
        head += ch;
      }
      continue;
    }
    if (ch === '{') {
      depth += 1;
      body += ch;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const selectorText = head.trim();
        if (!selectorText.startsWith('@')) {
          rules.push({
            selectors: selectorText.split(',').map((s) => s.trim()),
            declarations: body
              .split(';')
              .map((d) => {
                const colon = d.indexOf(':');
                if (colon === -1) return null;
                return {
                  prop: d.slice(0, colon).trim().toLowerCase(),
                  value: d
                    .slice(colon + 1)
                    .replace(/!important/i, '')
                    .trim()
                    .toLowerCase(),
                };
              })
              .filter((d): d is { prop: string; value: string } => d !== null),
          });
        }
        head = '';
      } else {
        body += ch;
      }
    } else {
      body += ch;
    }
  }
  return rules;
}

describe('QuestLogView qf-4: the list-style sweep (QF4.3)', () => {
  const stylesCss = readFileSync(QF4_STYLES_CSS_PATH, 'utf8');
  let sheet: HTMLStyleElement | null = null;

  // The file-level hooks empty the body before every test; this describe adopts the real markup and
  // installs the real sheet itself, and removes the sheet again (the body is the file hooks' to clear).
  beforeEach(() => {
    qf4AdoptRealIndexHtml();
    sheet = document.createElement('style');
    sheet.textContent = stylesCss;
    document.head.appendChild(sheet);
  });
  afterEach(() => {
    sheet?.remove();
    sheet = null;
  });

  it('QF4-3-STATIC-ULS-NO-MARKER: each of the nine static <ul>s carries mr-nav-list, has no inline style, and computes list-style none', () => {
    // WRONG IMPL KILLED: a sweep that misses one list (the class absent on any of the nine); the
    // marker removed by an inline style instead of the class (the inline attribute is banned, so the
    // class is what is being tested); a class on the element but no rule behind it (computes '').
    for (const id of QF4_STATIC_UL_IDS) {
      const ul = document.getElementById(id);
      expect(ul, `#${id} exists in the real index.html`).not.toBeNull();
      expect(ul?.tagName, `#${id} is a <ul>`).toBe('UL');
      expect(ul?.classList.contains(QF4_NAV_LIST), `#${id} carries ${QF4_NAV_LIST}`).toBe(true);
      expect(ul?.hasAttribute('style'), `#${id} has no inline style`).toBe(false);
      expect(
        ul === null ? '' : getComputedStyle(ul).listStyle,
        `#${id} computes list-style none`,
      ).toBe('none');
    }
  });

  it('QF4-3-CENSUS-EVERY-UL: every <ul> in the static index.html carries mr-nav-list (and there are exactly nine)', () => {
    // WRONG IMPL KILLED: a hand-picked subset of the lists; a tenth <ul> added later without the
    // class; the census passing vacuously on an empty document (the count and the id roster are
    // pinned).
    const uls = [...document.querySelectorAll('ul')];
    expect(uls, 'ANTI-VACUITY: the nine static lists are in the document').toHaveLength(9);
    expect(uls.map((u) => u.id).sort()).toEqual([...QF4_STATIC_UL_IDS].sort());
    const without = uls
      .filter((u) => !u.classList.contains(QF4_NAV_LIST))
      .map((u) => u.id || '(no id)');
    expect(without, `<ul>s without ${QF4_NAV_LIST}`).toEqual([]);
  });

  it('QF4-3-SANITY-CLASS-DOES-THE-WORK: a fresh <ul class="mr-nav-list"> computes list-style none and the same element with the class removed does not, so the sheet is parsed and applied and the class is the cause', () => {
    // WRONG IMPL KILLED: a harness whose <style> install is a no-op (every "computes none" tooth
    // would then be read as "nothing parsed" and every "not none" would pass free); a rule that
    // matches every <ul> or sets the list style some other way, making the class decorative. Two
    // separate fresh elements: happy-dom caches computed style per element.
    const withClass = document.createElement('ul');
    withClass.className = QF4_NAV_LIST;
    document.body.appendChild(withClass);
    expect(getComputedStyle(withClass).listStyle, 'with the class').toBe('none');

    const withoutClass = document.createElement('ul');
    withoutClass.className = QF4_NAV_LIST;
    withoutClass.classList.remove(QF4_NAV_LIST);
    document.body.appendChild(withoutClass);
    expect(getComputedStyle(withoutClass).listStyle, 'with the class removed').not.toBe('none');
  });

  it('QF4-3-SHEET-RULE: styles.css has a top-level rule whose selector list includes .mr-nav-list and whose body declares list-style: none, with no #id selector in it (comments do not count)', () => {
    // WRONG IMPL KILLED: the rule written only inside a comment; an #id selector list
    // (#quest-log-list, ...) — styles.css bans ids, and that form would not carry to a new list;
    // list-style: disc/none on the wrong selector; a parser that finds no rules at all (the
    // .sr-only rule is read first to prove the scan sees real rules).
    const rules = qf4TopLevelRules(stylesCss);
    const srOnly = rules.find((r) => r.selectors.includes('.sr-only'));
    expect(srOnly, 'ANTI-VACUITY: the scan sees the existing .sr-only rule').toBeDefined();
    expect(srOnly?.declarations.some((d) => d.prop === 'position' && d.value === 'absolute')).toBe(
      true,
    );

    const navList = rules.filter((r) => r.selectors.includes(`.${QF4_NAV_LIST}`));
    expect(navList.length > 0, 'a rule whose selector list includes .mr-nav-list').toBe(true);
    expect(
      navList.some((r) =>
        r.declarations.some((d) => d.prop === 'list-style' && d.value === 'none'),
      ),
      'and it declares list-style: none',
    ).toBe(true);
    for (const rule of navList) {
      expect(
        rule.selectors.every((s) => !s.includes('#')),
        `no #id selector in the ${QF4_NAV_LIST} rule: ${rule.selectors.join(', ')}`,
      ).toBe(true);
    }
  });

  it('QF4-3-RUNTIME-KEEPS-CLASS: over the real markup, constructing the view and rendering, painting and re-rendering leaves #quest-log-list carrying mr-nav-list and computing list-style none', () => {
    // WRONG IMPL KILLED: a view that overwrites the list's className (the rows' `mr-nav-item` write
    // is on the <li>s, but a className assignment on the list would drop the class); a view that
    // sets an inline list style or replaces the list element; the class lost after the first paint.
    const view = new QuestLogView();
    view.render(questVm(2));
    view.paint({ questId: 'quest_1', detail: 'quest_1' });
    view.render(questVm(2));

    const list = document.getElementById('quest-log-list') as HTMLElement;
    expect(list, 'the real #quest-log-list is still the view`s list').not.toBeNull();
    expect(list.classList.contains(QF4_NAV_LIST), 'the class survives the view').toBe(true);
    expect(getComputedStyle(list).listStyle, 'and still computes none').toBe('none');
  });
});
