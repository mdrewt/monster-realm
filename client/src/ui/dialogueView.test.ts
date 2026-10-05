// @vitest-environment happy-dom
// ui/dialogueView.test.ts — m23-s3 RED gating tests for the RENDER-DRIVEN overlay a11y wiring
// (dialogueView has no show(); its only edge is render(vm | null)'s null <-> non-null transition),
// plus the pre-existing render behaviour this file is the first spec to pin at all.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/15/16/34);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1-F5, §1 D1/D2/D3/D7/D8, §4, §7 A1/A3/A6/A7/A8;
//   memory/projects/gates/m23-s3.gates.md X1/X2/X3/X4/X6/X7/X8/X9;
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
import { t as i18nT, setLocale } from './i18n/resolver';
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
// Overlay a11y wiring on the render(vm | null) edge
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
    // defer exists to avoid — the letter that OPENED the overlay lands in
    // the field it just opened.
    expect(document.activeElement, 'the initial focus must NOT have landed synchronously').not.toBe(
      target,
    );

    // The defer must come from the S1 helper, not from a view-local setTimeout. This
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
    // only way they can be ABSENT is if closeOverlayA11y really ran.
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
    // THE CRUX: main.ts's M12d store.onBatchApplied listener
    // calls dialogueView.render(vm) UNCONDITIONALLY on every store batch. An unguarded delegation
    // would clear and re-schedule the deferred-focus timer every tick,
    // so focus is yanked off whatever the player Tabbed to and the overlay is untabbable. This
    // failure mode is INVISIBLE to every attribute assertion — a re-open rewrites byte-identical
    // values.
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
    // and main.ts's M12d store.onBatchApplied listener makes that branch run
    // on EVERY batch forever (F5).
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
    // heals it, and close-without-open is a documented pure no-op.
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
    // repeat render at the same nullity, and main.ts's M12d store.onBatchApplied listener
    // would otherwise fire one every batch.
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

  it('BITES: render(null) hides the overlay (the ONLY production close — the UXD3C-HANDLES-delimited overlayHandles table in main.ts keeps dialogueView out of the force-hide table, plan F3)', () => {
    const root = mountDialogueOverlay();
    const view = new DialogueView();

    view.render(dialogueVm());
    expect(view.visible).toBe(true);

    view.render(null);
    expect(view.visible).toBe(false);
    expect(root.style.display).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// ctl-8a (CTL8A.1): the bottom box and the painted cursor / reveal.
//
// The constructor docks the shell (`mr-dock` on the root) and moves the three content nodes
// into ONE inner `div.mr-frame.mr-frame--bottom` (`data-size="bottom"`), idempotently.
// `paint({ active, revealStart })` keeps what it is handed and applies it: the cursor button (the
// `data-choice-idx` button whose idx is `active`, or the `data-shop-id` button for 'shop') carries
// `is-active` and `aria-current="true"` and no other button does; `#dialogue-node-text` carries
// `is-revealing` iff `revealStart` is non-null. Every button in `#dialogue-choices` is an
// `mr-nav-item`. The kept paint survives each batch's legacy `render(vm)` and resets to
// `{ active: null, revealStart: null }` on the hidden→visible edge.
// ---------------------------------------------------------------------------

const ctl8aEl = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is missing`);
  return el;
};

const ctl8aButtons = (): HTMLButtonElement[] =>
  Array.from(ctl8aEl('dialogue-choices').querySelectorAll('button'));

/** Every button carrying a cursor mark (`is-active` or `aria-current="true"`), named `c<idx>` or
 *  `shop`. */
function ctl8aMarked(): string[] {
  return ctl8aButtons()
    .filter((b) => b.classList.contains('is-active') || b.getAttribute('aria-current') === 'true')
    .map((b) => (b.dataset.shopId !== undefined ? 'shop' : `c${b.dataset.choiceIdx}`));
}

/** The one button `name` (`c<idx>` or `shop`) carries BOTH halves of the cursor mark. */
function ctl8aExpectCursor(name: string): void {
  expect(ctl8aMarked(), 'exactly one button is the cursor').toEqual([name]);
  const btn = ctl8aButtons().find(
    (b) => (b.dataset.shopId !== undefined ? 'shop' : `c${b.dataset.choiceIdx}`) === name,
  );
  expect(btn?.classList.contains('is-active'), `${name}: is-active`).toBe(true);
  expect(btn?.getAttribute('aria-current'), `${name}: aria-current`).toBe('true');
}

describe('DialogueView — the bottom box and paint (ctl-8a, CTL8A.1)', () => {
  it('CTL8A-1-VIEW-BOTTOM-BOX: the constructor docks the shell and moves the npc name, the node text and the choices, in that order, into ONE div.mr-frame.mr-frame--bottom (data-size bottom) that is a child of the root; a second construction creates nothing more; render still paints into the moved nodes', () => {
    // WRONG IMPL KILLED: a bottom box made by an inline style or an inset on the shell (A11Y-12,
    // the CTL7A-2 shell rule) instead of a docked shell with an inner frame; the content left as
    // direct root children; each node wrapped in its own frame; a frame outside the root or nested
    // deeper; a second view that wraps the wrapper again; and nodes CLONED into the frame instead
    // of moved (render would then paint the detached originals and the box would stay blank).
    const root = mountDialogueOverlay();
    const name = ctl8aEl('dialogue-npc-name');
    const text = ctl8aEl('dialogue-node-text');
    const choices = ctl8aEl('dialogue-choices');
    new DialogueView();

    // `mr-dock`, not `mr-shell--dock`: battleView.test.ts CTL7B-1-FRAME-CSS-ROSTER pins every
    // styles.css selector matching /mr-(shell|frame)/, so the dock rule is named outside that family.
    expect(root.classList.contains('mr-dock'), 'the shell is docked').toBe(true);
    const frame = name.parentElement as HTMLElement;
    expect(frame, 'the name moved into an inner frame').not.toBe(root);
    expect(frame.tagName).toBe('DIV');
    expect(frame.classList.contains('mr-frame'), 'mr-frame').toBe(true);
    expect(frame.classList.contains('mr-frame--bottom'), 'mr-frame--bottom').toBe(true);
    expect(frame.dataset.size).toBe('bottom');
    expect(frame.parentElement, 'the frame is a child of the root').toBe(root);
    expect(text.parentElement, 'the text shares the frame').toBe(frame);
    expect(choices.parentElement, 'the choices share the frame').toBe(frame);
    expect(
      Array.from(frame.children).filter((c) => c === name || c === text || c === choices),
      'in their order',
    ).toEqual([name, text, choices]);

    const view = new DialogueView();
    expect(root.querySelectorAll('.mr-frame--bottom'), 'still ONE bottom frame').toHaveLength(1);
    expect(name.parentElement, 'not wrapped again').toBe(frame);
    expect(frame.parentElement).toBe(root);
    const moved: ReadonlyArray<readonly [string, HTMLElement]> = [
      ['dialogue-npc-name', name],
      ['dialogue-node-text', text],
      ['dialogue-choices', choices],
    ];
    for (const [id, node] of moved) {
      expect(document.querySelectorAll(`#${id}`), `one #${id}`).toHaveLength(1);
      expect(document.getElementById(id), `#${id} is the very node, moved`).toBe(node);
    }

    view.render(dialogueVm());
    expect(view.visible).toBe(true);
    expect(name.textContent).toBe('Elder Rowan');
    expect(text.textContent).toBe('Welcome, traveller.');
    expect(choices.querySelectorAll('button')).toHaveLength(2);
  });

  it('CTL8A-1-VIEW-PAINT: every choice button is an mr-nav-item; before any paint no button is the cursor and the text is not revealing; paint marks exactly the cursor button (a choice by idx, or Shop) with is-active and aria-current and toggles is-revealing; a legacy render(vm) keeps the kept paint; render(null) or hide() then render(vm) is back to the opening state', () => {
    // WRONG IMPL KILLED: a cursor marked by class alone (no aria-current) or by colour; two buttons
    // marked (the old cursor left behind); a mark found by list position instead of
    // data-choice-idx (the Shop button has none); a reveal class that is never removed or is set
    // with no reveal; a paint lost on the next store batch's render(vm) (the cursor would vanish
    // on every batch); a paint kept across a close (a reopened talk shows the last one's cursor
    // and no reveal); and a Shop button without mr-nav-item.
    mountDialogueOverlay();
    const view = new DialogueView();
    const text = ctl8aEl('dialogue-node-text');
    const vm = dialogueVm({ shopAction: { shopId: 4 } });

    view.render(vm);
    expect(ctl8aButtons(), 'two choices and Shop').toHaveLength(3);
    expect(
      ctl8aButtons().every((b) => b.classList.contains('mr-nav-item')),
      'every button is a nav item',
    ).toBe(true);
    expect(ctl8aMarked(), 'no cursor before any paint').toEqual([]);
    expect(text.classList.contains('is-revealing'), 'no reveal before any paint').toBe(false);

    view.paint({ active: 1, revealStart: 500 });
    ctl8aExpectCursor('c1');
    expect(text.classList.contains('is-revealing'), 'a reveal is painted').toBe(true);

    view.render(vm);
    ctl8aExpectCursor('c1');
    expect(text.classList.contains('is-revealing'), 'the batch render keeps the reveal').toBe(true);
    expect(ctl8aButtons().every((b) => b.classList.contains('mr-nav-item'))).toBe(true);

    view.paint({ active: 'shop', revealStart: null });
    ctl8aExpectCursor('shop');
    expect(text.classList.contains('is-revealing'), 'a finished reveal').toBe(false);

    view.paint({ active: null, revealStart: null });
    expect(ctl8aMarked(), 'no cursor').toEqual([]);

    view.paint({ active: 0, revealStart: 700 });
    view.render(null);
    view.render(vm);
    expect(ctl8aMarked(), 'reopened after render(null): no cursor').toEqual([]);
    expect(text.classList.contains('is-revealing')).toBe(false);

    view.paint({ active: 1, revealStart: 800 });
    view.hide();
    view.render(vm);
    expect(ctl8aMarked(), 'reopened after hide(): no cursor').toEqual([]);
    expect(text.classList.contains('is-revealing')).toBe(false);

    view.paint({ active: 0, revealStart: 900 });
    ctl8aExpectCursor('c0');
    expect(text.classList.contains('is-revealing'), 'the reopened view paints again').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// polish-1 P1: a store batch that leaves the dialogue view model unchanged keeps the choice and Shop
// button NODES (and the focus on one of them).
//
// EARS: WHEN the dialogue view model is unchanged across a store batch, THE CLIENT SHALL keep the
// existing choice and Shop button nodes (same DOM nodes, focus kept).
//
// main.ts builds a NEW view model object on EVERY store batch and calls `render(vm)` with it, so
// "unchanged" is deep equality, never reference identity: every vm below comes from `p1Vm()`, which
// returns a fresh object with fresh arrays each call. RED REASON today: `render()` calls
// `choicesContainer.replaceChildren()` and rebuilds every button, so no button node survives a
// second render and a focused button loses focus.
// ---------------------------------------------------------------------------

/** A FRESH view model every call: deep-equal to every other `p1Vm()` with the same overrides, never
 *  the same reference (main.ts's per-batch rebuild). Three choices and a Shop action. */
const p1Vm = (over: Partial<DialogueViewModel> = {}): DialogueViewModel => ({
  npcName: 'Elder Rowan',
  nodeText: 'Welcome, traveller.',
  choices: [
    { text: 'Tell me about the realm', idx: 0 },
    { text: 'Ask about the road', idx: 1 },
    { text: 'Goodbye', idx: 2 },
  ],
  canDismiss: true,
  shopAction: { shopId: 7 },
  ...over,
});

/** What each button shows: its text, its data-choice-idx and its data-shop-id (undefined when absent). */
const p1Shape = (): Array<{
  text: string | null;
  idx: string | undefined;
  shop: string | undefined;
}> =>
  ctl8aButtons().map((b) => ({
    text: b.textContent,
    idx: b.dataset.choiceIdx,
    shop: b.dataset.shopId,
  }));

const P1_SHOP_LABEL = i18nT('dialogue.action.shop');

describe('DialogueView — an unchanged view model keeps its button nodes (polish-1 P1)', () => {
  it('POLISH1-P1-KEEP-NODES: render(vm) again with a FRESH deep-equal vm keeps every choice and Shop button as the identical node, keeps the focused button focused, and touches the choices container not at all', async () => {
    // WRONG IMPL KILLED: the current replaceChildren() + rebuild (no node survives, focus falls to
    // <body>); a "keep" that re-appends the same nodes (identity holds, but a real browser drops
    // focus on a remove + insert: caught by the zero DOM-mutation-call clause); a keep keyed on the
    // vm REFERENCE (main.ts hands a new object per batch, so it never keeps); a keep for the choices
    // only that still rebuilds the Shop button.
    mountDialogueOverlay();
    const view = new DialogueView();
    view.render(p1Vm());
    await flushMacrotask(); // the open's deferred initial focus lands before the player focuses a button

    const before = ctl8aButtons();
    expect(before, 'three choices and the Shop button').toHaveLength(4);
    expect(before[3]?.dataset.shopId, 'precondition: the last button is Shop').toBe('7');
    const focused = before[1] as HTMLButtonElement;
    focused.focus();
    expect(document.activeElement, 'precondition: a choice button holds focus').toBe(focused);

    const choices = ctl8aEl('dialogue-choices');
    const spies = (
      [
        'replaceChildren',
        'appendChild',
        'removeChild',
        'insertBefore',
        'append',
        'prepend',
      ] as const
    ).map((name) => vi.spyOn(choices, name as 'appendChild'));
    try {
      for (let batch = 0; batch < 3; batch += 1) {
        const next = p1Vm();
        view.render(next);
        await flushMacrotask();
        const after = ctl8aButtons();
        expect(after, `batch ${batch}: the button count is unchanged`).toHaveLength(4);
        after.forEach((btn, i) => {
          expect(btn, `batch ${batch}: button ${i} is the identical node`).toBe(before[i]);
        });
        expect(document.activeElement, `batch ${batch}: the focused button keeps focus`).toBe(
          focused,
        );
      }
      expect(
        spies.flatMap((s) => s.mock.calls),
        'an unchanged vm performs no DOM insertion or removal in the choices container',
      ).toEqual([]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(p1Shape(), 'and they still read the same').toEqual([
      { text: 'Tell me about the realm', idx: '0', shop: undefined },
      { text: 'Ask about the road', idx: '1', shop: undefined },
      { text: 'Goodbye', idx: '2', shop: undefined },
      { text: P1_SHOP_LABEL, idx: undefined, shop: '7' },
    ]);
    expect(vi.mocked(openOverlayA11y), 'no re-open on a repeat render').toHaveBeenCalledTimes(1);
  });

  it('POLISH1-P1-KEEP-NODES-AFTER-CHANGE: after a changed vm rebuilds the buttons, the NEXT equal vm keeps those new nodes (the remembered model follows the change)', () => {
    // WRONG IMPL KILLED: a remembered key set on the first render only (every later render differs
    // from it, so it rebuilds forever); a key that is never updated by a rebuild.
    mountDialogueOverlay();
    const view = new DialogueView();
    view.render(p1Vm());
    const first = ctl8aButtons();

    view.render(p1Vm({ choices: [{ text: 'Only one', idx: 0 }], shopAction: null }));
    const changed = ctl8aButtons();
    expect(changed, 'precondition: the changed vm shows one button').toHaveLength(1);
    expect(changed[0], 'precondition: a changed vm shows a new node').not.toBe(first[0]);

    view.render(p1Vm({ choices: [{ text: 'Only one', idx: 0 }], shopAction: null }));
    view.render(p1Vm({ choices: [{ text: 'Only one', idx: 0 }], shopAction: null }));
    const kept = ctl8aButtons();
    expect(kept).toHaveLength(1);
    expect(kept[0], 'the equal vm after the change keeps the changed vm`s node').toBe(changed[0]);
  });

  const BASE_CHOICES = (): DialogueViewModel['choices'] => [
    { text: 'Tell me about the realm', idx: 0 },
    { text: 'Ask about the road', idx: 1 },
    { text: 'Goodbye', idx: 2 },
  ];
  const SHAPE = (
    text: string,
    idx: string | undefined,
    shop?: string,
  ): { text: string; idx: string | undefined; shop: string | undefined } => ({ text, idx, shop });

  it.each([
    [
      'only choice.text differs at the same idx',
      p1Vm({
        choices: [
          { text: 'Tell me about the realm', idx: 0 },
          { text: 'Ask about the wares', idx: 1 },
          { text: 'Goodbye', idx: 2 },
        ],
      }),
      [
        SHAPE('Tell me about the realm', '0'),
        SHAPE('Ask about the wares', '1'),
        SHAPE('Goodbye', '2'),
        SHAPE(P1_SHOP_LABEL, undefined, '7'),
      ],
    ],
    [
      'only a choice idx differs (same text)',
      p1Vm({
        choices: [
          { text: 'Tell me about the realm', idx: 0 },
          { text: 'Ask about the road', idx: 1 },
          { text: 'Goodbye', idx: 5 },
        ],
      }),
      [
        SHAPE('Tell me about the realm', '0'),
        SHAPE('Ask about the road', '1'),
        SHAPE('Goodbye', '5'),
        SHAPE(P1_SHOP_LABEL, undefined, '7'),
      ],
    ],
    [
      'a choice is added',
      p1Vm({ choices: [...BASE_CHOICES(), { text: 'Farewell', idx: 3 }] }),
      [
        SHAPE('Tell me about the realm', '0'),
        SHAPE('Ask about the road', '1'),
        SHAPE('Goodbye', '2'),
        SHAPE('Farewell', '3'),
        SHAPE(P1_SHOP_LABEL, undefined, '7'),
      ],
    ],
    [
      'a choice is removed',
      p1Vm({ choices: BASE_CHOICES().slice(0, 2) }),
      [
        SHAPE('Tell me about the realm', '0'),
        SHAPE('Ask about the road', '1'),
        SHAPE(P1_SHOP_LABEL, undefined, '7'),
      ],
    ],
    [
      'the choices swap order',
      p1Vm({
        choices: [
          { text: 'Ask about the road', idx: 1 },
          { text: 'Tell me about the realm', idx: 0 },
          { text: 'Goodbye', idx: 2 },
        ],
      }),
      [
        SHAPE('Ask about the road', '1'),
        SHAPE('Tell me about the realm', '0'),
        SHAPE('Goodbye', '2'),
        SHAPE(P1_SHOP_LABEL, undefined, '7'),
      ],
    ],
    [
      'the shopAction is removed',
      p1Vm({ shopAction: null }),
      [
        SHAPE('Tell me about the realm', '0'),
        SHAPE('Ask about the road', '1'),
        SHAPE('Goodbye', '2'),
      ],
    ],
    [
      'only the shopId differs',
      p1Vm({ shopAction: { shopId: 9 } }),
      [
        SHAPE('Tell me about the realm', '0'),
        SHAPE('Ask about the road', '1'),
        SHAPE('Goodbye', '2'),
        SHAPE(P1_SHOP_LABEL, undefined, '9'),
      ],
    ],
    [
      'every choice is removed and only Shop remains',
      p1Vm({ choices: [] }),
      [SHAPE(P1_SHOP_LABEL, undefined, '7')],
    ],
  ])('POLISH1-P1-CHANGED-REBUILDS: %s -> the new content shows, with no stale button', (_name, changedVm, expected) => {
    // WRONG IMPL KILLED: a key over the choice COUNT or idx list alone (a text-only change keeps
    // the stale button text); a key that omits the shopAction (a removed / re-pointed Shop button
    // stays); a key that omits idx or text; a keep that skips the rebuild when the lengths match.
    mountDialogueOverlay();
    const view = new DialogueView();
    view.render(p1Vm());
    expect(p1Shape(), 'precondition: the base vm shows four buttons').toHaveLength(4);

    view.render(changedVm);
    expect(p1Shape()).toEqual(expected);
    // The Shop button never carries a choice idx and a choice never carries a shop id.
    for (const b of ctl8aButtons()) {
      expect(
        (b.dataset.shopId === undefined) !== (b.dataset.choiceIdx === undefined),
        'exactly one of data-shop-id / data-choice-idx',
      ).toBe(true);
    }
    expect(vi.mocked(openOverlayA11y), 'a changed vm is not a re-open').toHaveBeenCalledTimes(1);
  });

  it('POLISH1-P1-CHANGED-REBUILDS-TEXT: when only npcName or only nodeText differs, those texts update (and the choices still read as before)', () => {
    // WRONG IMPL KILLED: a render skipped wholesale whenever the CHOICES are unchanged (the NPC
    // name / node text of the next conversation node would never show).
    mountDialogueOverlay();
    const view = new DialogueView();
    view.render(p1Vm());
    const choicesBefore = p1Shape();

    view.render(p1Vm({ npcName: 'Captain Ash' }));
    expect(ctl8aEl('dialogue-npc-name').textContent).toBe('Captain Ash');
    expect(ctl8aEl('dialogue-node-text').textContent).toBe('Welcome, traveller.');
    expect(p1Shape()).toEqual(choicesBefore);

    view.render(p1Vm({ npcName: 'Captain Ash', nodeText: 'Mind the road.' }));
    expect(ctl8aEl('dialogue-npc-name').textContent).toBe('Captain Ash');
    expect(ctl8aEl('dialogue-node-text').textContent).toBe('Mind the road.');
    expect(p1Shape()).toEqual(choicesBefore);

    view.render(p1Vm());
    expect(ctl8aEl('dialogue-npc-name').textContent).toBe('Elder Rowan');
    expect(ctl8aEl('dialogue-node-text').textContent).toBe('Welcome, traveller.');
  });

  it('POLISH1-P1-PAINT-KEPT: with the nodes kept, the painted cursor (is-active and aria-current) stays on its button across equal re-renders, and follows a rebuild', () => {
    // WRONG IMPL KILLED: a keep that skips re-applying the kept paint after a REBUILD (the cursor
    // would vanish when a choice's text changes); a keep that clears the marks on every batch; a
    // cursor mark moved onto a different button by the keep.
    mountDialogueOverlay();
    const view = new DialogueView();
    view.render(p1Vm());
    const nodes = ctl8aButtons();

    view.paint({ active: 1, revealStart: null });
    ctl8aExpectCursor('c1');
    view.render(p1Vm());
    view.render(p1Vm());
    ctl8aExpectCursor('c1');
    ctl8aButtons().forEach((btn, i) => {
      expect(btn, `button ${i} is still the identical node`).toBe(nodes[i]);
    });

    view.paint({ active: 'shop', revealStart: null });
    view.render(p1Vm());
    ctl8aExpectCursor('shop');
    expect(ctl8aButtons()[3], 'the Shop button is the identical node').toBe(nodes[3]);

    // A changed vm rebuilds; the kept paint is applied to the new button.
    view.paint({ active: 1, revealStart: null });
    view.render(
      p1Vm({
        choices: [
          { text: 'Tell me about the realm', idx: 0 },
          { text: 'Ask about the wares', idx: 1 },
          { text: 'Goodbye', idx: 2 },
        ],
      }),
    );
    ctl8aExpectCursor('c1');
    expect(ctl8aButtons()[1]?.textContent).toBe('Ask about the wares');
  });

  it('POLISH1-P1-PAINT-KEPT-REOPEN: render(null) then render(an equal vm) is a reopen: no button carries the last talk`s cursor, and a fresh paint marks again', () => {
    // WRONG IMPL KILLED: kept nodes whose old is-active / aria-current survive the close (the
    // reopened talk would start on the last cursor), because the equal-vm shortcut also skips the
    // reset of the kept paint on the hidden -> visible edge.
    mountDialogueOverlay();
    const view = new DialogueView();
    const text = ctl8aEl('dialogue-node-text');
    view.render(p1Vm());
    view.paint({ active: 0, revealStart: 700 });
    ctl8aExpectCursor('c0');
    expect(text.classList.contains('is-revealing')).toBe(true);

    view.render(null);
    expect(view.visible).toBe(false);
    view.render(p1Vm());
    expect(view.visible, 'the equal vm reopens the overlay').toBe(true);
    expect(ctl8aButtons(), 'the reopened talk still shows its buttons').toHaveLength(4);
    expect(ctl8aMarked(), 'no button carries the last cursor').toEqual([]);
    expect(text.classList.contains('is-revealing'), 'and the reveal starts over').toBe(false);

    view.paint({ active: 2, revealStart: 900 });
    ctl8aExpectCursor('c2');
  });
});

// ---------------------------------------------------------------------------
// polish-1 P1, round 2: the "unchanged" key must be exact (no delimiter collisions), a build that
// throws must not poison the key, the Shop label follows the locale, and only the BUTTONS' content
// is what the keep is keyed on (a changed npc name / node text keeps the nodes and the focus).
// ---------------------------------------------------------------------------

/** The buttons a vm must produce, in order: its choices, then Shop when it has one. */
const p1Expected = (
  vm: DialogueViewModel,
  shopLabel = P1_SHOP_LABEL,
): Array<{ text: string | null; idx: string | undefined; shop: string | undefined }> => [
  ...vm.choices.map((c) => ({ text: c.text, idx: String(c.idx), shop: undefined })),
  ...(vm.shopAction
    ? [{ text: shopLabel, idx: undefined, shop: String(vm.shopAction.shopId) }]
    : []),
];

describe('DialogueView — exact keep key, throw recovery, locale, over-keying (polish-1 P1 round 2)', () => {
  it.each([
    [
      'two choices vs one choice whose text spells the join (idx:text|idx:text)',
      p1Vm({
        choices: [
          { text: 'a', idx: 0 },
          { text: 'b', idx: 1 },
        ],
        shopAction: null,
      }),
      p1Vm({ choices: [{ text: 'a|1:b', idx: 0 }], shopAction: null }),
    ],
    [
      'the same collision with a comma join',
      p1Vm({
        choices: [
          { text: 'a', idx: 0 },
          { text: 'b', idx: 1 },
        ],
        shopAction: null,
      }),
      p1Vm({ choices: [{ text: 'a,1:b', idx: 0 }], shopAction: null }),
    ],
    [
      'the same collision with a newline join',
      p1Vm({
        choices: [
          { text: 'a', idx: 0 },
          { text: 'b', idx: 1 },
        ],
        shopAction: null,
      }),
      p1Vm({ choices: [{ text: 'a\n1:b', idx: 0 }], shopAction: null }),
    ],
    [
      'quote and bracket text that spells a JSON-ish split',
      p1Vm({
        choices: [
          { text: 'a', idx: 0 },
          { text: 'b', idx: 1 },
        ],
        shopAction: null,
      }),
      p1Vm({ choices: [{ text: 'a"],[1,"b', idx: 0 }], shopAction: null }),
    ],
    [
      'idx digits spilling into the text (idx 1 + text "2x" vs idx 12 + text "x")',
      p1Vm({ choices: [{ text: '2x', idx: 1 }], shopAction: null }),
      p1Vm({ choices: [{ text: 'x', idx: 12 }], shopAction: null }),
    ],
    [
      'a choice text that spells the Shop suffix vs a real Shop action',
      p1Vm({ choices: [{ text: 'x', idx: 0 }], shopAction: { shopId: 7 } }),
      p1Vm({ choices: [{ text: 'x|shop:7', idx: 0 }], shopAction: null }),
    ],
    [
      'a choice text that ends in the shop id vs a real Shop action',
      p1Vm({ choices: [{ text: 'x|7', idx: 0 }], shopAction: null }),
      p1Vm({ choices: [{ text: 'x', idx: 0 }], shopAction: { shopId: 7 } }),
    ],
  ])('POLISH1-P1-KEY-COLLISION: %s -> the new content shows', (_name, first, second) => {
    // WRONG IMPL KILLED: a key built by join('|') / join(',') / template concatenation: the two vms
    // produce the same key string, the second render is wrongly skipped and the stale buttons stay.
    mountDialogueOverlay();
    const view = new DialogueView();
    view.render(first);
    expect(p1Shape(), 'precondition: the first vm shows its buttons').toEqual(p1Expected(first));
    view.render(second);
    expect(p1Shape(), 'the second vm shows ITS buttons, not the first`s').toEqual(
      p1Expected(second),
    );
  });

  /** `document.createElement` made to throw on its `nth` call for a <button> (1-based), once. */
  function throwOnButton(nth: number): { restore: () => void; thrown: () => boolean } {
    const real = document.createElement.bind(document);
    let seen = 0;
    let thrown = false;
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((
      tag: string,
      options?: ElementCreationOptions,
    ) => {
      if (tag === 'button') {
        seen += 1;
        if (seen === nth) {
          thrown = true;
          throw new Error('p1: build failed');
        }
      }
      return real(tag, options);
    }) as typeof document.createElement);
    return { restore: () => spy.mockRestore(), thrown: () => thrown };
  }

  it.each([
    ['the changed vm again', 'changed'],
    ['the PREVIOUS vm again (the key must not still say it is on screen)', 'previous'],
  ] as const)('POLISH1-P1-THROW-RECOVERY: a build that throws part-way surfaces, and rendering %s rebuilds the right content', (_name, which) => {
    // WRONG IMPL KILLED: a key recorded BEFORE the build (the retry with the same vm is skipped and
    // the half-built buttons stay); a key NOT cleared before the build (the old vm's key still
    // matches, so re-rendering the old vm is skipped while the container holds half of the new
    // one); a swallowed throw (the failure would be invisible).
    mountDialogueOverlay();
    const view = new DialogueView();
    const previous = (): DialogueViewModel => p1Vm();
    const changed = (): DialogueViewModel =>
      p1Vm({
        choices: [
          { text: 'One', idx: 0 },
          { text: 'Two', idx: 1 },
          { text: 'Three', idx: 2 },
        ],
        shopAction: { shopId: 9 },
      });
    view.render(previous());

    const fault = throwOnButton(2);
    try {
      expect(() => view.render(changed()), 'the throw surfaces').toThrow('p1: build failed');
    } finally {
      fault.restore();
    }
    expect(fault.thrown(), 'fixture: the fault fired').toBe(true);

    const retry = which === 'changed' ? changed() : previous();
    view.render(retry);
    expect(p1Shape()).toEqual(p1Expected(retry));
    // And it is stable again: an equal vm keeps what the recovery built.
    const built = ctl8aButtons();
    view.render(which === 'changed' ? changed() : previous());
    ctl8aButtons().forEach((btn, i) => {
      expect(btn, `button ${i} is kept after the recovery`).toBe(built[i]);
    });
  });

  it('POLISH1-P1-THROW-RECOVERY-FIRST-RENDER: a throw on the very first build leaves nothing remembered: the same vm renders fully next time', () => {
    mountDialogueOverlay();
    const view = new DialogueView();
    const fault = throwOnButton(1);
    try {
      expect(() => view.render(p1Vm())).toThrow('p1: build failed');
    } finally {
      fault.restore();
    }
    view.render(p1Vm());
    expect(p1Shape()).toEqual(p1Expected(p1Vm()));
  });

  it('POLISH1-P1-LOCALE: after the locale switches, an EQUAL vm re-renders the Shop label in the new language (and back)', () => {
    // WRONG IMPL KILLED: a hardcoded Shop label; a key that omits the label / locale (the equal vm
    // is skipped and the label stays in the old language).
    mountDialogueOverlay();
    const view = new DialogueView();
    try {
      setLocale('en');
      view.render(p1Vm());
      expect(p1Shape().at(-1)?.text).toBe(P1_SHOP_LABEL);
      setLocale('fr');
      const frLabel = i18nT('dialogue.action.shop');
      expect(frLabel, 'fixture: the French label differs from the English one').not.toBe(
        P1_SHOP_LABEL,
      );
      view.render(p1Vm());
      expect(p1Shape(), 'the Shop button now reads French').toEqual(p1Expected(p1Vm(), frLabel));
      expect(ctl8aButtons().at(-1)?.dataset.shopId).toBe('7');
      setLocale('en');
      view.render(p1Vm());
      expect(p1Shape()).toEqual(p1Expected(p1Vm()));
    } finally {
      setLocale('en');
    }
  });

  it.each([
    ['only nodeText', { nodeText: 'Mind the road.' }],
    ['only npcName', { npcName: 'Captain Ash' }],
    ['both npcName and nodeText', { npcName: 'Captain Ash', nodeText: 'Mind the road.' }],
  ] as Array<
    [string, Partial<DialogueViewModel>]
  >)('POLISH1-P1-OVERKEY: a vm differing in %s keeps the button nodes and the focus, and the text still updates', async (_name, over) => {
    // WRONG IMPL KILLED: a key over the whole vm (every conversation node rebuilds the buttons and
    // drops the focus); a keep that also skips the npcName / nodeText writes.
    mountDialogueOverlay();
    const view = new DialogueView();
    view.render(p1Vm());
    await flushMacrotask();
    const before = ctl8aButtons();
    const focused = before[1] as HTMLButtonElement;
    focused.focus();
    expect(document.activeElement).toBe(focused);

    const next = p1Vm(over);
    view.render(next);
    await flushMacrotask();
    ctl8aButtons().forEach((btn, i) => {
      expect(btn, `button ${i} is the identical node`).toBe(before[i]);
    });
    expect(document.activeElement, 'focus is kept').toBe(focused);
    expect(ctl8aEl('dialogue-npc-name').textContent).toBe(next.npcName);
    expect(ctl8aEl('dialogue-node-text').textContent).toBe(next.nodeText);
  });
});
