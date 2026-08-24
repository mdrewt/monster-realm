// @vitest-environment happy-dom
// ui/dialogueView.test.ts — m23-s3 RED gating tests for the RENDER-DRIVEN overlay a11y wiring
// (dialogueView has no show(); its only edge is render(vm | null)'s null <-> non-null transition),
// plus the pre-existing render behaviour this file is the first spec to pin at all.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/15/16/34);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1-F5, §1 D1/D2/D3/D7/D8, §4, §7 A1/A3/A6/A7/A8;
//   memory/projects/gates/m23-s3.gates.md X1/X2/X3/X4/X6/X7/X8/X9;
//   docs/adr/0205-overlay-a11y-metadata-ssot-and-copy-catalog.md D1-D4, A3;
//   ui/overlayA11y.ts (the S1 helper this view must DELEGATE to), ui/overlayRegistry.ts (OVERLAY_A11Y).
//
// RED REASON: `client/src/ui/dialogueView.ts` DOES NOT CALL openOverlayA11y/closeOverlayA11y AT ALL
// today — the file is byte-unchanged from master @0953db7. Every S3-* test below therefore fails now:
//   - the aria-label assertions fail (the attribute is never written; index.html ships NO aria-label);
//   - the deferred-focus assertions fail (nothing schedules a focus);
//   - the close assertions fail (role/aria-modal survive, because ONLY closeOverlayA11y strips them);
//   - every `toHaveBeenCalledTimes(...)` on the spied helpers fails at 0.
// The NON-S3 tests in this file (render behaviour) pass NOW and must keep passing.
//
// TWO ORACLES, BOTH REQUIRED (plan A3, measured by red-team):
//   * VALUE oracle  — `aria-label === t(OVERLAY_A11Y['dialogueView'].labelKey)`. `role`/`aria-modal`
//     are ALREADY static literals on every shell in client/index.html:17 (m23-s2), so asserting them
//     ALONE is VACUOUS: a view that calls nothing passes. They are asserted here only in the same
//     it() as aria-label, and their ABSENCE after close is the anti-vacuity partner.
//   * MECHANISM oracle — `vi.mock('./overlayA11y', { spy: true })` records the calls AND calls
//     through to the real implementation. A cheat that hand-writes the three attributes with the
//     correct copied literal passes the VALUE oracle while shipping no trap, no return-focus record
//     and no timer; only the call assertion reds it, and the id argument simultaneously kills the
//     copy-pasted-wrong-OverlayId impl (all 16 catalog values are distinct, plan F2).
//
// TEST-ISOLATION DEVICE (plan A8 / V7, copied from ui/overlayA11y.test.ts:97-105 — deliberate, not
// boilerplate): overlayA11y.ts holds ONE module-private Map<OverlayId, record>. It exports no reset
// hook (a zero-consumer production export is banned by that module family's A7/A15 rule,
// ui/overlayRegistry.ts:24-30), so beforeEach/afterEach call the PRODUCTION closeOverlayA11y(id,null)
// for every OverlayId and flush ONE REAL MACROTASK. That is legal precisely because
// close-without-open is a documented no-op (ui/overlayA11y.ts:41-45, gated by
// S1-CLOSE-WITHOUT-OPEN-NOOP). It also cancels any pending deferred-focus timer a test deliberately
// left dangling, so it cannot steal focus inside a later, unrelated test. `vi.clearAllMocks()` runs
// LAST in beforeEach so the sweep's own close calls never pollute a test's call counts.
//
// NEVER FAKE TIMERS (plan anti-pattern #10): the defer is a REAL setTimeout(...,0) by design
// (ui/overlayA11y.ts:17-20); it is flushed with `await new Promise((r) => setTimeout(r, 0))`.
//
// FIXTURE FIDELITY: the overlay root is byte-copied from client/index.html:17-21, INCLUDING
// `style="display:none"` (without it the first render(vm) is a no-edge and every open assertion is
// silently vacuous — vacuity attack V4, pinned by the `view.visible === false` assertion in
// S3-dialogueView-OPEN-ARIA), the static `role`/`aria-modal` literals (without them the
// "attributes absent after close" tooth is vacuous — attack V1) and the `tabindex="-1"` anchor.
// The tabindex buys ZERO test power (plan A7: happy-dom's .focus() moves activeElement onto a bare
// <div> with no tabindex at all — it does not model focusability); it is copied for fidelity only,
// and a passing A11Y-14 here is NOT proof a real browser would honour the focus.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/plan only.
//
// WRONG-IMPL-KILLED index:
//   - never opens at all / attribute-only cheat        -> S3-dialogueView-OPEN-ARIA + -HELPER-CALLED
//   - copy-pasted WRONG OverlayId (opens 'healView')   -> S3-dialogueView-OPEN-ARIA (label) + -HELPER-CALLED (id arg)
//   - synchronous focus (no defer)                     -> S3-dialogueView-DEFER-FOCUS (negative polarity)
//   - focuses nothing / focuses a wrapper, not the anchor -> S3-dialogueView-DEFER-FOCUS (identity, positive polarity)
//   - close never strips ARIA / never restores focus    -> S3-dialogueView-CLOSE-RESTORE
//   - UNGUARDED open on every render (the F5/F6 crux)   -> S3-dialogueView-REPEAT-NO-REOPEN + -EDGE-COUNTS
//   - `#lastVmWasNull` field instead of `visible` (D3)  -> S3-dialogueView-REOPEN-AFTER-HIDE
//   - UNGUARDED close in the render(null) branch        -> S3-dialogueView-EDGE-COUNTS + -CLOSE-UNGUARDED (half B)
//   - GUARDED close in hide() (kills S1's A13 self-heal) -> S3-dialogueView-CLOSE-UNGUARDED (half A)
//   - `fallbackFocus` passed as undefined/an element     -> S3-dialogueView-HELPER-CALLED (literal null, D8/A6)
//   - render() stops painting choices / appends instead of rebuilding -> the render-behaviour block

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import type { DialogueViewModel } from './dialogueModel';
import { DialogueView } from './dialogueView';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';

// The MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works in the
// same test. Measured working in this repo's vitest 4 (plan §7 "Verified mechanics").
vi.mock('./overlayA11y', { spy: true });

const ID: OverlayId = 'dialogueView';
const META = OVERLAY_A11Y[ID];

// ---------------------------------------------------------------------------
// Fixture + helpers
// ---------------------------------------------------------------------------

/** Byte-copy of client/index.html:17-21 — the shell DialogueView binds to. */
function mountDialogueOverlay(): HTMLElement {
  document.body.innerHTML = `
    <div id="dialogue-overlay" role="dialog" aria-modal="true" style="display:none">
      <div id="dialogue-npc-name" tabindex="-1"></div>
      <div id="dialogue-node-text"></div>
      <div id="dialogue-choices"></div>
    </div>
  `;
  return document.getElementById('dialogue-overlay') as HTMLElement;
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

/** A focusable INSIDE the overlay, as a DIRECT child of the root: no render path rebuilds it
 *  (render() only touches #dialogue-npc-name, #dialogue-node-text and #dialogue-choices), so if it
 *  loses focus it is because something RE-OPENED the overlay and re-ran the deferred focus. */
function addInsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

function dialogueVm(overrides: Partial<DialogueViewModel> = {}): DialogueViewModel {
  return {
    npcName: 'Elder Rowan',
    nodeText: 'Welcome, traveller.',
    choices: [
      { text: 'Tell me about the realm', idx: 0 },
      { text: 'Goodbye', idx: 1 },
    ],
    canDismiss: true,
    shopAction: null,
    ...overrides,
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
// m23-s3 — overlay a11y wiring on the render(vm | null) edge
// ---------------------------------------------------------------------------

describe('DialogueView — overlay a11y wiring on the render edge (m23-s3)', () => {
  it('S3-dialogueView-OPEN-ARIA BITES: the null->non-null edge labels the root from OVERLAY_A11Y/t(), and the fixture really starts hidden', () => {
    const root = mountDialogueOverlay();
    const view = new DialogueView();

    // VACUITY ATTACK V4, closed here: a fixture missing `style="display:none"` makes the FIRST
    // render(vm) a NO-EDGE (wasVisible already true), so every open assertion below would be
    // silently vacuous. Pin the precondition before asserting anything about the open.
    expect(
      view.visible,
      'V4: the shell must start hidden, so the first render(vm) IS an edge',
    ).toBe(false);

    view.render(dialogueVm());

    // Every expectation is DERIVED from the table at assert time — never a literal (V5).
    // WRONG IMPL KILLED: a hardcoded 'Conversation'/'dialog' pair reds the day the catalog changes;
    // a copy-pasted WRONG OverlayId reds NOW, because all 16 catalog values are distinct (F2).
    expect(root.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(META.role);
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(
      root.getAttribute('aria-label'),
      'THE tooth: role/aria-modal are static literals in index.html:17 and pass a view that calls ' +
        'nothing; aria-label is absent from every shell, so only a real open can produce it',
    ).toBe(t(META.labelKey));
  });

  it('S3-dialogueView-DEFER-FOCUS BITES: both polarities — NOT focused synchronously, focused after ONE real macrotask, and the defer is owned by openOverlayA11y', async () => {
    const root = mountDialogueOverlay();
    const target = root.querySelector<HTMLElement>(META.initialFocusSelector);
    expect(target, `the fixture must contain ${META.initialFocusSelector}`).not.toBeNull();
    const view = new DialogueView();

    view.render(dialogueVm());

    // NEGATIVE polarity. WRONG IMPL KILLED: a synchronous focus reintroduces the exact bug the
    // defer exists to avoid (ui/overlayA11y.ts:9-15) — the letter that OPENED the overlay lands in
    // the field it just opened.
    expect(document.activeElement, 'the initial focus must NOT have landed synchronously').not.toBe(
      target,
    );

    // The defer must come from the S1 helper, not from a view-local setTimeout (A11Y-15). This
    // clause is what makes the test RED for renameView/tradeProposeView-shaped impls that already
    // defer their own focus; it is the reason a passing positive polarity is not enough.
    expect(
      vi.mocked(openOverlayA11y),
      'the deferred focus must be scheduled by openOverlayA11y, not by the view',
    ).toHaveBeenCalledTimes(1);

    await flushMacrotask();

    // POSITIVE polarity, by IDENTITY — never `root.contains(activeElement)`, which passes on any
    // decorative wrapper. WRONG IMPL KILLED: an impl that focuses the root itself, or nothing.
    expect(document.activeElement).toBe(target);
  });

  it('S3-dialogueView-CLOSE-RESTORE BITES: render(null) strips role, aria-modal AND aria-label from the root and hands focus back to the pre-overlay element', async () => {
    const root = mountDialogueOverlay();
    const outside = addOutsideSentinel();
    outside.focus();
    expect(document.activeElement, 'precondition: focus starts OUTSIDE the overlay').toBe(outside);

    const view = new DialogueView();
    view.render(dialogueVm());
    await flushMacrotask();
    expect(
      document.activeElement,
      'precondition: the open moved focus INTO the overlay, so the restore below is a real move',
    ).not.toBe(outside);

    view.render(null);

    // VACUITY ATTACK V1, closed here: index.html ships role/aria-modal as STATIC LITERALS, so the
    // only way they can be ABSENT is if closeOverlayA11y really ran (ui/overlayA11y.ts:142-144).
    // This is the anti-vacuity partner of S3-dialogueView-OPEN-ARIA and it kills the
    // "rely on the static literals, call nothing" cheat outright.
    expect(
      root.getAttribute('role'),
      'a display:none node must not keep claiming to be a dialog',
    ).toBeNull();
    expect(root.getAttribute('aria-modal')).toBeNull();
    expect(root.getAttribute('aria-label')).toBeNull();

    expect(document.activeElement, 'focus must return to the pre-overlay element').toBe(outside);
  });

  it('S3-dialogueView-REPEAT-NO-REOPEN BITES: a repeat render(vm) at the SAME nullity neither re-opens nor yanks focus back', async () => {
    // THE CRUX (plan F5/F6): main.ts:1574 calls dialogueView.render(vm) UNCONDITIONALLY on every
    // store batch. An unguarded delegation would clear and re-schedule the deferred-focus timer
    // every tick (ui/overlayA11y.ts:100-113), so focus is yanked off whatever the player Tabbed to
    // and the overlay is untabbable. This failure mode is INVISIBLE to every attribute assertion —
    // a re-open rewrites byte-identical values.
    const root = mountDialogueOverlay();
    const view = new DialogueView();

    view.render(dialogueVm());
    await flushMacrotask();

    const inside = addInsideSentinel(root);
    inside.focus();
    expect(document.activeElement, 'precondition: focus is parked INSIDE the overlay').toBe(inside);

    view.render(dialogueVm());
    await flushMacrotask();

    expect(
      document.activeElement,
      'a repeat render must NOT re-run the deferred initial focus',
    ).toBe(inside);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S3-dialogueView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    // THE MECHANISM ORACLE (plan A3). Measured by red-team: a view that hand-writes
    // role/aria-modal/aria-label with the correct copied literal passes every VALUE assertion in
    // this file while shipping NO focus trap, NO return-focus record and NO deferred-focus timer.
    // Only this call assertion reds it. The id argument also kills the copy-pasted-wrong-id impl,
    // and the literal `null` pins ADR-0205 A3 / plan D8 (S3 views hold no canvas handle).
    const root = mountDialogueOverlay();
    const view = new DialogueView();

    view.render(dialogueVm());
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(ID, root);

    view.render(null);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(ID, null);
  });

  it('S3-dialogueView-EDGE-COUNTS BITES: 3x render(vm) = ONE open; 3x render(null) = ONE close; and a full cycle fires open -> close -> open IN THAT ORDER', () => {
    // A11Y-34. The close side is NOT DOM-observable (a second close is an idempotent no-op,
    // ui/overlayA11y.ts:136-137), so only a call COUNT can see an unguarded render(null) branch —
    // and main.ts:1574 makes that branch run on EVERY batch forever (F5).
    mountDialogueOverlay();
    const view = new DialogueView();

    // Phase 1 — three identical non-null renders collapse to ONE open.
    view.render(dialogueVm());
    view.render(dialogueVm());
    view.render(dialogueVm());
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
    view.render(dialogueVm());
    view.render(null);
    view.render(dialogueVm());
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    const opens = vi.mocked(openOverlayA11y).mock.invocationCallOrder;
    const closes = vi.mocked(closeOverlayA11y).mock.invocationCallOrder;
    // WRONG IMPL KILLED: an impl that closes then re-opens on the same non-null render would show
    // close BEFORE the first open, or two closes; the ordering pins open -> close -> open exactly.
    expect(opens[0]).toBeLessThan(closes[0]);
    expect(closes[0]).toBeLessThan(opens[1]);
  });

  it('S3-dialogueView-REOPEN-AFTER-HIDE BITES: render(vm) -> hide() -> render(vm) re-applies the FULL a11y contract on the SECOND open', () => {
    // THE FALSIFIER for the rejected `#lastVmWasNull` field (plan D3). A field updated only inside
    // render() never sees hide(), so the second open silently ships no role, no label, no focus and
    // no trap — while passing every single-cycle test in this file.
    const root = mountDialogueOverlay();
    const view = new DialogueView();

    view.render(dialogueVm());
    expect(root.getAttribute('aria-label'), 'precondition: the first open labelled the root').toBe(
      t(META.labelKey),
    );

    view.hide();
    expect(root.getAttribute('aria-label'), 'hide() must close the overlay a11y record').toBeNull();

    view.render(dialogueVm());
    expect(
      root.getAttribute('aria-label'),
      'the SECOND open must re-apply the label — a `#lastVmWasNull` field would skip it',
    ).toBe(t(META.labelKey));
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(2);
  });

  it('S3-dialogueView-CLOSE-UNGUARDED BITES: hide() closes UNCONDITIONALLY (self-healing), while the render(null) branch stays GUARDED', () => {
    // Plan D2's deliberate ASYMMETRY, pinned in both directions.
    // Half A — a GUARDED hide() would read `visible === false` and skip the close whenever a record
    // desynchronised from the DOM (S1's named A13 leak, ui/overlayA11y.ts:55-59), making a live
    // capture listener, a pending timer and a stale return target PERMANENT. Unguarded, hide()
    // heals it, and close-without-open is a documented pure no-op (ui/overlayA11y.ts:136-137).
    mountDialogueOverlay();
    const view = new DialogueView();
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

    // Half B — the render(null) path is the one that MUST be guarded: A11Y-34 forbids a close on a
    // repeat render at the same nullity, and main.ts:1574 would otherwise fire one every batch.
    vi.clearAllMocks();
    view.render(dialogueVm());
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
// Pre-existing render behaviour — this file is the FIRST spec for dialogueView, so the behaviour
// the S3 tests lean on (the choices rebuild, the display flip) is pinned here rather than assumed.
// These tests pass on master TODAY and must keep passing after the S3 wiring lands.
// ---------------------------------------------------------------------------

describe('DialogueView render(): existing paint behaviour (pinned, not changed by m23-s3)', () => {
  it('BITES: render(vm) shows the overlay and paints npcName, nodeText and exactly one <button> per choice', () => {
    const root = mountDialogueOverlay();
    const view = new DialogueView();
    const vm = dialogueVm();

    view.render(vm);

    expect(view.visible).toBe(true);
    expect(root.style.display).not.toBe('none');
    expect(document.getElementById('dialogue-npc-name')?.textContent).toBe(vm.npcName);
    expect(document.getElementById('dialogue-node-text')?.textContent).toBe(vm.nodeText);

    const buttons = (document.getElementById('dialogue-choices') as HTMLElement).querySelectorAll(
      'button',
    );
    expect(buttons).toHaveLength(vm.choices.length);
    expect(Array.from(buttons).map((b) => b.textContent)).toEqual(vm.choices.map((c) => c.text));
    expect(Array.from(buttons).map((b) => b.dataset.choiceIdx)).toEqual(['0', '1']);
  });

  it('BITES: a shopAction renders ONE extra button carrying data-shop-id and NO data-choice-idx (uxd2/ADR-0161 D4)', () => {
    // The dialogue click delegation keys off data-choice-idx; a Shop button carrying one would be
    // mistaken for a choice and advance the conversation instead of opening the shop.
    mountDialogueOverlay();
    const view = new DialogueView();

    view.render(dialogueVm({ choices: [{ text: 'Hi', idx: 0 }], shopAction: { shopId: 7 } }));

    const buttons = Array.from(
      (document.getElementById('dialogue-choices') as HTMLElement).querySelectorAll('button'),
    );
    expect(buttons).toHaveLength(2);
    const shopBtn = buttons[1];
    expect(shopBtn.dataset.shopId).toBe('7');
    expect(shopBtn.dataset.choiceIdx).toBeUndefined();
  });

  it('BITES: a second render REPLACES the choice buttons rather than appending them', () => {
    mountDialogueOverlay();
    const view = new DialogueView();

    view.render(dialogueVm());
    expect(
      (document.getElementById('dialogue-choices') as HTMLElement).querySelectorAll('button'),
    ).toHaveLength(2);

    view.render(dialogueVm({ choices: [{ text: 'Only one', idx: 0 }] }));
    const buttons = (document.getElementById('dialogue-choices') as HTMLElement).querySelectorAll(
      'button',
    );
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('Only one');
  });

  it('BITES: render(null) hides the overlay (the ONLY production close — main.ts:362 keeps dialogueView out of the force-hide table, plan F3)', () => {
    const root = mountDialogueOverlay();
    const view = new DialogueView();

    view.render(dialogueVm());
    expect(view.visible).toBe(true);

    view.render(null);
    expect(view.visible).toBe(false);
    expect(root.style.display).toBe('none');
  });
});
