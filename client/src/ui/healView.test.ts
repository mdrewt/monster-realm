// @vitest-environment happy-dom
// ui/healView.test.ts — m23-s3 RED gating tests for the RENDER-DRIVEN overlay a11y wiring
// (healView has no show(); its only open edge is render(vm | null)'s null -> non-null transition),
// plus the pre-existing render behaviour this file is the first spec to pin at all.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/15/16/34);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1/F2/F4/F7, §1 D1/D2/D3/D7/D8, §4, §7 A1/A3/A6/A7/A8;
//   memory/projects/gates/m23-s3.gates.md X1/X2/X3/X4/X6/X7/X8/X9;
//   ui/overlayA11y.ts (the S1 helper this view must DELEGATE to), ui/overlayRegistry.ts (OVERLAY_A11Y).
//
// RED REASON: `client/src/ui/healView.ts` DOES NOT CALL openOverlayA11y/closeOverlayA11y AT ALL
// today — the file is byte-unchanged from master @0953db7. Every S3-* test below therefore fails now:
// no aria-label is ever written, nothing schedules a focus, role/aria-modal survive a close (only
// closeOverlayA11y strips them), and every `toHaveBeenCalledTimes(...)` on the spied helpers is 0.
// The NON-S3 tests in this file (render behaviour) pass NOW and must keep passing.
//
// WHY THIS VIEW IS AN ASYMMETRY CASE (plan F4, and the reason X7 exists): healView is OPENED by
// `render(vm)` (main.ts:545-547) but CLOSED by `hide()` (main.ts:1382, :364). A `#lastVmWasNull`
// field would be updated only inside render(), never see the hide, and the SECOND open would
// silently ship no role, no label, no focus and no trap — while passing every single-cycle test.
// S3-healView-REOPEN-AFTER-HIDE is that falsifier.
//
// TWO ORACLES, BOTH REQUIRED (plan A3, measured by red-team):
//   * VALUE oracle  — `aria-label === t(OVERLAY_A11Y['healView'].labelKey)`. `role`/`aria-modal` are
//     ALREADY static literals on every shell in client/index.html:25 (m23-s2), so asserting them
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
// FIXTURE FIDELITY: the overlay root is byte-copied from client/index.html:25-27, INCLUDING
// `style="display:none"` (without it the first render(vm) is a no-edge and every open assertion is
// silently vacuous — vacuity attack V4, pinned by the `view.visible === false` assertion in
// S3-healView-OPEN-ARIA), the static `role`/`aria-modal` literals (without them the "attributes
// absent after close" tooth is vacuous — attack V1) and the `tabindex="-1"` anchor. The tabindex
// buys ZERO test power (plan A7: happy-dom's .focus() moves activeElement onto a bare <div> with no
// tabindex at all — it does not model focusability); it is copied for fidelity only.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/plan only.
//
// WRONG-IMPL-KILLED index:
//   - never opens at all / attribute-only cheat         -> S3-healView-OPEN-ARIA + -HELPER-CALLED
//   - copy-pasted WRONG OverlayId                       -> S3-healView-OPEN-ARIA (label) + -HELPER-CALLED (id arg)
//   - synchronous focus (no defer)                      -> S3-healView-DEFER-FOCUS (negative polarity)
//   - focuses nothing / a wrapper instead of the anchor  -> S3-healView-DEFER-FOCUS (identity, positive polarity)
//   - close never strips ARIA / never restores focus     -> S3-healView-CLOSE-RESTORE
//   - UNGUARDED open on every render                     -> S3-healView-REPEAT-NO-REOPEN + -EDGE-COUNTS
//   - `#lastVmWasNull` field instead of `visible` (D3)   -> S3-healView-REOPEN-AFTER-HIDE
//   - UNGUARDED close in the render(null) branch         -> S3-healView-EDGE-COUNTS + -CLOSE-UNGUARDED (half B)
//   - GUARDED close in hide() (kills S1's A13 self-heal) -> S3-healView-CLOSE-UNGUARDED (half A)
//   - `fallbackFocus` passed as undefined/an element      -> S3-healView-HELPER-CALLED (literal null, D8/A6)
//   - the shell reformatting the cost line itself (the `0x Unknown item` silent-debit trap,
//     ui/healModel.ts:92-100) instead of delegating to formatHealCostLine -> the render-behaviour block

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { formatHealCostLine, type HealLocationViewModel, type HealViewModel } from './healModel';
import { HealView } from './healView';
import { t as i18nT, tf as i18nTf } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';

// The MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works in the
// same test. Measured working in this repo's vitest 4 (plan §7 "Verified mechanics").
vi.mock('./overlayA11y', { spy: true });

const ID: OverlayId = 'healView';
const META = OVERLAY_A11Y[ID];

// ---------------------------------------------------------------------------
// Fixture + helpers
// ---------------------------------------------------------------------------

/** Byte-copy of client/index.html:25-27 — the shell HealView binds to. */
function mountHealOverlay(): HTMLElement {
  document.body.innerHTML = `
    <div id="heal-overlay" role="dialog" aria-modal="true" style="display:none">
      <ul id="heal-list" tabindex="-1"></ul>
    </div>
  `;
  return document.getElementById('heal-overlay') as HTMLElement;
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

/** A focusable INSIDE the overlay, as a DIRECT child of the root: render() only rebuilds #heal-list,
 *  so this node survives every re-render. If it loses focus, something RE-OPENED the overlay and
 *  re-ran the deferred initial focus. */
function addInsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

function healLocation(overrides: Partial<HealLocationViewModel> = {}): HealLocationViewModel {
  return {
    locationId: 1,
    zoneId: 0,
    tileX: 4,
    tileY: 9,
    costItemName: null,
    costQty: 0,
    costCurrency: 0n,
    cooldownMs: 0,
    isFree: true,
    ...overrides,
  };
}

function healVm(locations: HealLocationViewModel[] = [healLocation()]): HealViewModel {
  return { locations };
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

describe('HealView — overlay a11y wiring on the render edge (m23-s3)', () => {
  it('S3-healView-OPEN-ARIA BITES: the null->non-null edge labels the root from OVERLAY_A11Y/t(), and the fixture really starts hidden', () => {
    const root = mountHealOverlay();
    const view = new HealView();

    // VACUITY ATTACK V4, closed here: a fixture missing `style="display:none"` makes the FIRST
    // render(vm) a NO-EDGE (wasVisible already true), so every open assertion below would be
    // silently vacuous. Pin the precondition before asserting anything about the open.
    expect(
      view.visible,
      'V4: the shell must start hidden, so the first render(vm) IS an edge',
    ).toBe(false);

    view.render(healVm());

    // Every expectation is DERIVED from the table at assert time — never a literal (V5).
    // WRONG IMPL KILLED: a hardcoded 'Heal'/'dialog' pair reds the day the catalog changes; a
    // copy-pasted WRONG OverlayId reds NOW (all 16 catalog values are distinct, F2).
    expect(root.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(META.role);
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(
      root.getAttribute('aria-label'),
      'THE tooth: role/aria-modal are static literals in index.html:25 and pass a view that calls ' +
        'nothing; aria-label is absent from every shell, so only a real open can produce it',
    ).toBe(t(META.labelKey));
  });

  it('S3-healView-DEFER-FOCUS BITES: both polarities — NOT focused synchronously, focused after ONE real macrotask, and the defer is owned by openOverlayA11y', async () => {
    const root = mountHealOverlay();
    const target = root.querySelector<HTMLElement>(META.initialFocusSelector);
    expect(target, `the fixture must contain ${META.initialFocusSelector}`).not.toBeNull();
    const view = new HealView();

    view.render(healVm());

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

  it('S3-healView-CLOSE-RESTORE BITES: hide() strips role, aria-modal AND aria-label from the root and hands focus back to the pre-overlay element', async () => {
    // hide() is healView's PRODUCTION close — render(null) is unreachable for
    // this view in production (plan F4/F5), so the restore path is pinned through the path the app
    // actually takes.
    const root = mountHealOverlay();
    const outside = addOutsideSentinel();
    outside.focus();
    expect(document.activeElement, 'precondition: focus starts OUTSIDE the overlay').toBe(outside);

    const view = new HealView();
    view.render(healVm());
    await flushMacrotask();
    expect(
      document.activeElement,
      'precondition: the open moved focus INTO the overlay, so the restore below is a real move',
    ).not.toBe(outside);

    view.hide();

    // VACUITY ATTACK V1, closed here: index.html ships role/aria-modal as STATIC LITERALS, so the
    // only way they can be ABSENT is if closeOverlayA11y really ran.
    // This is the anti-vacuity partner of S3-healView-OPEN-ARIA and it kills the "rely on the
    // static literals, call nothing" cheat outright.
    expect(
      root.getAttribute('role'),
      'a display:none node must not keep claiming to be a dialog',
    ).toBeNull();
    expect(root.getAttribute('aria-modal')).toBeNull();
    expect(root.getAttribute('aria-label')).toBeNull();

    expect(document.activeElement, 'focus must return to the pre-overlay element').toBe(outside);
  });

  it('S3-healView-REPEAT-NO-REOPEN BITES: a repeat render(vm) at the SAME nullity neither re-opens nor yanks focus back', async () => {
    // THE CRUX (plan F6): a re-open clears and re-schedules the deferred-focus timer,
    // so an unguarded delegation yanks focus off whatever the player
    // Tabbed to on every re-render and the overlay becomes untabbable. This failure mode is
    // INVISIBLE to every attribute assertion — a re-open rewrites byte-identical values.
    const root = mountHealOverlay();
    const view = new HealView();

    view.render(healVm());
    await flushMacrotask();

    const inside = addInsideSentinel(root);
    inside.focus();
    expect(document.activeElement, 'precondition: focus is parked INSIDE the overlay').toBe(inside);

    view.render(healVm());
    await flushMacrotask();

    expect(
      document.activeElement,
      'a repeat render must NOT re-run the deferred initial focus',
    ).toBe(inside);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S3-healView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    // THE MECHANISM ORACLE (plan A3). Measured by red-team: a view that hand-writes
    // role/aria-modal/aria-label with the correct copied literal passes every VALUE assertion in
    // this file while shipping NO focus trap, NO return-focus record and NO deferred-focus timer.
    // Only this call assertion reds it. The id argument also kills the copy-pasted-wrong-id impl,
    // and the literal `null` pins ADR-0205 A3 / plan D8 (S3 views hold no canvas handle).
    const root = mountHealOverlay();
    const view = new HealView();

    view.render(healVm());
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(ID, root);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(ID, null);
  });

  it('S3-healView-EDGE-COUNTS BITES: 3x render(vm) = ONE open; 3x render(null) = ONE close; and a full cycle fires open -> close -> open IN THAT ORDER', () => {
    // A11Y-34. The close side is NOT DOM-observable (a second close is an idempotent no-op,
    // ui/overlayA11y.ts:136-137), so only a call COUNT can see an unguarded render(null) branch.
    mountHealOverlay();
    const view = new HealView();

    // Phase 1 — three identical non-null renders collapse to ONE open.
    view.render(healVm());
    view.render(healVm());
    view.render(healVm());
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
    view.render(healVm());
    view.render(null);
    view.render(healVm());
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    const opens = vi.mocked(openOverlayA11y).mock.invocationCallOrder;
    const closes = vi.mocked(closeOverlayA11y).mock.invocationCallOrder;
    // WRONG IMPL KILLED: an impl that closes then re-opens on the same non-null render would show
    // close BEFORE the first open; the ordering pins open -> close -> open exactly.
    expect(opens[0]).toBeLessThan(closes[0]);
    expect(closes[0]).toBeLessThan(opens[1]);
  });

  it('S3-healView-REOPEN-AFTER-HIDE BITES: render(vm) -> hide() -> render(vm) re-applies the FULL a11y contract on the SECOND open', () => {
    // THE FALSIFIER for the rejected `#lastVmWasNull` field (plan D3), and the reason it matters
    // here (plan F4): healView is opened by render() but closed by hide(), so a field updated only
    // inside render() never sees the close and the second open ships nothing.
    const root = mountHealOverlay();
    const view = new HealView();

    view.render(healVm());
    expect(root.getAttribute('aria-label'), 'precondition: the first open labelled the root').toBe(
      t(META.labelKey),
    );

    view.hide();
    expect(root.getAttribute('aria-label'), 'hide() must close the overlay a11y record').toBeNull();

    view.render(healVm());
    expect(
      root.getAttribute('aria-label'),
      'the SECOND open must re-apply the label — a `#lastVmWasNull` field would skip it',
    ).toBe(t(META.labelKey));
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(2);
  });

  it('S3-healView-CLOSE-UNGUARDED BITES: hide() closes UNCONDITIONALLY (self-healing), while the render(null) branch stays GUARDED', () => {
    // Plan D2's deliberate ASYMMETRY, pinned in both directions.
    // Half A — a GUARDED hide() would read `visible === false` and skip the close whenever a record
    // desynchronised from the DOM (S1's named A13 leak, ui/overlayA11y.ts:55-59), making a live
    // capture listener, a pending timer and a stale return target PERMANENT. Unguarded, hide()
    // heals it, and close-without-open is a documented pure no-op.
    mountHealOverlay();
    const view = new HealView();
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
    view.render(healVm());
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
// Pre-existing render behaviour — this file is the FIRST spec for healView, so the behaviour the S3
// tests lean on (the list rebuild, the display flip) is pinned here rather than assumed.
// ---------------------------------------------------------------------------

describe('HealView render(): existing paint behaviour (pinned, not changed by m23-s3)', () => {
  it('BITES: render(vm) shows the overlay and paints one <li> per location, carrying data-location-id', () => {
    const root = mountHealOverlay();
    const view = new HealView();
    const vm = healVm([
      healLocation({ locationId: 1 }),
      healLocation({ locationId: 42, isFree: false, costItemName: 'Herb', costQty: 3 }),
    ]);

    view.render(vm);

    expect(view.visible).toBe(true);
    expect(root.style.display).not.toBe('none');

    const items = (document.getElementById('heal-list') as HTMLElement).querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(Array.from(items).map((li) => (li as HTMLElement).dataset.locationId)).toEqual([
      '1',
      '42',
    ]);
  });

  it('BITES: the row text DELEGATES to formatHealCostLine — a shell that reformats can silently drop the currency channel (ui/healModel.ts:92-100)', () => {
    // WRONG IMPL KILLED: the pre-12r-d shell that rendered a currency-only pad as `0x Unknown item`
    // (the named silent-debit trap). The expected string is DERIVED from the model SSOT at assert
    // time, never hardcoded, so the two cannot drift.
    mountHealOverlay();
    const view = new HealView();
    const free = healLocation({ locationId: 1 });
    const costed = healLocation({
      locationId: 2,
      isFree: false,
      costItemName: 'Herb',
      costQty: 3,
      costCurrency: 5n,
    });

    view.render(healVm([free, costed]));

    const items = (document.getElementById('heal-list') as HTMLElement).querySelectorAll('li');
    expect(items[0].textContent).toBe(`Heal here (${formatHealCostLine(free)})`);
    expect(items[1].textContent).toBe(`Heal here (${formatHealCostLine(costed)})`);
    // The currency channel must be visible to the player, not silently dropped.
    expect(items[1].textContent).toContain('5 gold');
  });

  it('BITES: a second render REPLACES the rows rather than appending them', () => {
    mountHealOverlay();
    const view = new HealView();

    view.render(healVm([healLocation({ locationId: 1 }), healLocation({ locationId: 2 })]));
    expect(
      (document.getElementById('heal-list') as HTMLElement).querySelectorAll('li'),
    ).toHaveLength(2);

    view.render(healVm([healLocation({ locationId: 9 })]));
    const items = (document.getElementById('heal-list') as HTMLElement).querySelectorAll('li');
    expect(items).toHaveLength(1);
    expect((items[0] as HTMLElement).dataset.locationId).toBe('9');
  });

  it('BITES: hide() hides the overlay (healView is opened by render() but CLOSED by hide() — main.ts:1382/:364)', () => {
    const root = mountHealOverlay();
    const view = new HealView();

    view.render(healVm());
    expect(view.visible).toBe(true);

    view.hide();
    expect(view.visible).toBe(false);
    expect(root.style.display).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// ctl-8a (CTL8A.3): the heal question, Yes / No and the disabled reason.
//
// The constructor locate-or-creates `#heal-question`, `#heal-reason` and `#heal-options` inside
// `#heal-overlay`, after and OUTSIDE `#heal-list` (HL-01 / HL-02 pin that list to its rows).
// `paint({ active, cost })` is kept and applied: with a cost the question reads
// `tf('heal.prompt.question', { cost })` and the reason is empty and hidden; with a null cost the
// question is empty and hidden and the reason reads `t('heal.prompt.unavailable')`. The options
// are `#heal-root-yes` / `#heal-root-no` (`role="option"`, `t('prompt.yes')` / `t('prompt.no')`),
// the cursor one `is-active` + `aria-selected="true"`, Yes `aria-disabled="true"` with no cost; the
// options are labelled by the question, or by the reason when there is no cost. On the
// hidden→visible edge the kept paint resets to Yes with the legacy vm's first location's cost.
// Expected text is resolved through the real catalog, never retyped.
// ---------------------------------------------------------------------------

const ctl8aHealEl = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is missing`);
  return el;
};

describe('HealView — the question and Yes / No (ctl-8a, CTL8A.3)', () => {
  it('CTL8A-3-VIEW-QUESTION: the constructor creates #heal-question, #heal-reason and #heal-options inside #heal-overlay, after and outside #heal-list, once however often it runs; the open asks the catalogued question with the location`s cost, Yes and No as options with the cursor on Yes, labelled by the question; a paint moves the cursor and survives a legacy render; a reopen is back on Yes; #heal-list keeps its rows', () => {
    // WRONG IMPL KILLED: the question or the options written into #heal-list (HL-01/HL-02 walk
    // its rows: foreign text there breaks them); the elements duplicated by a second view; a
    // question from a retyped literal or with another location's cost; an open on No; a cursor
    // marked without aria-selected; options with no label; a paint lost on the next batch render;
    // and a cursor kept across a close (a reopened healer would offer No first).
    const root = mountHealOverlay();
    const list = ctl8aHealEl('heal-list');
    new HealView();
    const view = new HealView();
    for (const id of ['heal-question', 'heal-reason', 'heal-options']) {
      expect(document.querySelectorAll(`#${id}`), `one #${id}`).toHaveLength(1);
      const el = ctl8aHealEl(id);
      expect(root.contains(el), `#${id} is inside #heal-overlay`).toBe(true);
      expect(list.contains(el), `#${id} is outside #heal-list`).toBe(false);
      expect(
        list.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
        `#${id} comes after #heal-list`,
      ).not.toBe(0);
    }

    const loc = healLocation({
      locationId: 7,
      isFree: false,
      costItemName: 'Herb',
      costQty: 2,
      costCurrency: 25n,
    });
    const cost = formatHealCostLine(loc);
    view.render(healVm([loc]));

    const question = ctl8aHealEl('heal-question');
    const reason = ctl8aHealEl('heal-reason');
    const options = ctl8aHealEl('heal-options');
    expect(question.textContent, 'the catalogued question').toBe(
      i18nTf('heal.prompt.question', { cost }),
    );
    expect(question.textContent, 'naming the cost').toContain(cost);
    expect(question.hidden).toBe(false);
    expect(reason.hidden, 'no reason with a cost').toBe(true);
    expect(reason.textContent).toBe('');
    expect(options.getAttribute('aria-labelledby'), 'the options are labelled by it').toBe(
      'heal-question',
    );

    const yes = ctl8aHealEl('heal-root-yes');
    const no = ctl8aHealEl('heal-root-no');
    for (const [el, text] of [
      [yes, i18nT('prompt.yes')],
      [no, i18nT('prompt.no')],
    ] as const) {
      expect(options.contains(el), `#${el.id} is an option of #heal-options`).toBe(true);
      expect(el.getAttribute('role')).toBe('option');
      expect(el.textContent).toBe(text);
    }
    expect(yes.classList.contains('is-active'), 'the open is on Yes').toBe(true);
    expect(yes.getAttribute('aria-selected')).toBe('true');
    expect(yes.getAttribute('aria-disabled'), 'Yes is enabled with a cost').toBeNull();
    expect(no.classList.contains('is-active')).toBe(false);
    expect(no.getAttribute('aria-selected')).toBe('false');

    const rows = list.querySelectorAll('li');
    expect(rows, '#heal-list keeps its one row').toHaveLength(1);
    expect(rows[0]?.textContent).toBe(`Heal here (${cost})`);

    view.paint({ active: 'no', cost });
    expect(ctl8aHealEl('heal-root-no').classList.contains('is-active'), 'painted on No').toBe(true);
    expect(ctl8aHealEl('heal-root-no').getAttribute('aria-selected')).toBe('true');
    expect(ctl8aHealEl('heal-root-yes').classList.contains('is-active')).toBe(false);
    view.render(healVm([loc]));
    expect(ctl8aHealEl('heal-root-no').classList.contains('is-active'), 'kept by a render').toBe(
      true,
    );

    view.hide();
    view.render(healVm([loc]));
    expect(ctl8aHealEl('heal-root-yes').classList.contains('is-active'), 'reopened on Yes').toBe(
      true,
    );
    expect(ctl8aHealEl('heal-root-no').classList.contains('is-active')).toBe(false);
    expect(ctl8aHealEl('heal-question').textContent).toBe(i18nTf('heal.prompt.question', { cost }));
  });

  it('CTL8A-3-VIEW-DISABLED-REASON: opened with no location the question is empty and hidden, the catalogued reason shows, Yes is aria-disabled and the options are labelled by the reason; painting a cost and then null swaps question and reason both ways', () => {
    // WRONG IMPL KILLED: a disabled Heal with no reason (CTL8A.3: "disabled with a reason"); a
    // question left showing with no cost ("Heal party for null?"); a Yes that does not say it is
    // disabled; options labelled by a hidden question; a reason from a retyped literal; and a
    // reason or a disabled mark that lingers once a cost arrives.
    mountHealOverlay();
    const view = new HealView();
    view.render(healVm([]));

    const question = ctl8aHealEl('heal-question');
    const reason = ctl8aHealEl('heal-reason');
    const options = ctl8aHealEl('heal-options');
    expect(question.hidden, 'no question without a cost').toBe(true);
    expect(question.textContent).toBe('');
    expect(reason.hidden).toBe(false);
    expect(reason.textContent, 'the catalogued reason').toBe(i18nT('heal.prompt.unavailable'));
    expect(ctl8aHealEl('heal-root-yes').getAttribute('aria-disabled'), 'Yes is disabled').toBe(
      'true',
    );
    expect(ctl8aHealEl('heal-root-yes').classList.contains('is-active'), 'still the cursor').toBe(
      true,
    );
    expect(options.getAttribute('aria-labelledby'), 'labelled by the reason').toBe('heal-reason');
    expect(ctl8aHealEl('heal-list').querySelectorAll('li'), 'no rows').toHaveLength(0);

    view.paint({ active: 'yes', cost: 'Free' });
    expect(question.hidden).toBe(false);
    expect(question.textContent).toBe(i18nTf('heal.prompt.question', { cost: 'Free' }));
    expect(reason.hidden).toBe(true);
    expect(reason.textContent).toBe('');
    expect(ctl8aHealEl('heal-root-yes').getAttribute('aria-disabled')).toBeNull();
    expect(options.getAttribute('aria-labelledby')).toBe('heal-question');

    view.paint({ active: 'no', cost: null });
    expect(question.hidden).toBe(true);
    expect(question.textContent).toBe('');
    expect(reason.hidden).toBe(false);
    expect(reason.textContent).toBe(i18nT('heal.prompt.unavailable'));
    expect(ctl8aHealEl('heal-root-yes').getAttribute('aria-disabled')).toBe('true');
    expect(ctl8aHealEl('heal-root-no').classList.contains('is-active')).toBe(true);
    expect(options.getAttribute('aria-labelledby')).toBe('heal-reason');
  });
});
