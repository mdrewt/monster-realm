// @vitest-environment happy-dom
//
// ui/privacyView.test.ts — the privacy surface's DOM shell (rb-52, PRV1-3/PRV1-4;
// ADR-0231 Amendment A2).
//
// ★ SOURCE OF TRUTH — the PROMOTED RESIDUAL, quoted verbatim. Section `rb-52` of
// `specs/monster-realm-v2/M-residual-backlog.spec.md` (source slice m22-s8, residual
// R-m22-s8-X10):
//   "[PRV1-3/PRV1-4 UI surface] WHEN the player opens the privacy surface THE CLIENT SHALL
//    expose reachable delete/cancel controls wired to `conn.reducers` and render the distinct
//    terminal notice once `terminal_at_ms` is `Some`."
//
// Design record: `docs/adr/0231-client-privacy-cores-request-wide-chunk-assembly.md`,
// Amendment A2 (A2-D2 constructed shell, A2-D3 native button anchor, A2-D4 hide() disarms,
// A2-D6 the ROW route, A2-D7 the pinned disclosure).
//
// RED REASON AT AUTHORING TIME: `client/src/ui/privacyBanner.ts` exports ONLY
// `privacyBannerLabel`. `buildPrivacyViewModel`, `PrivacyViewModel`,
// `PRIVACY_PSEUDONYMIZATION_DISCLOSURE` and `PRIVACY_TERMINAL_NOTICE` DO NOT EXIST, and
// `ui/privacyView.ts` imports the disclosure from that module — so both the import below AND
// the shell under test fail to resolve, and every test in this file reds on a MISSING
// IMPLEMENTATION, not on a typo here.
//
// ★ THE ONE THING THIS FILE EXISTS FOR — REACHABILITY IS VISIBILITY, NOT CLICKABILITY.
//   The `ensureElement` idiom both constructed shells use sets `display:none` on EVERY node it
//   creates, and `ui/claimView.ts` never un-hides its buttons. MEASURED CONSEQUENCE: a
//   programmatic `.click()` on such a button fires its handler in happy-dom AND in Chromium
//   while a human sees nothing at all. A suite that only clicks therefore certifies an
//   invisible surface as "reachable". So EVERY control assertion below walks the ancestor
//   chain first (the `focusInsideHiddenSubtree` idiom `client/src/main.ts` already ships),
//   asserts a non-empty accessible label, asserts `disabled` mirrors the view model, and only
//   THEN clicks. `RB52V-WALK-BITES` proves the walk is not vacuous by showing it reporting a
//   REAL hidden ancestor before the overlay is opened.
//
// NO regex literal and no `new RegExp(...)` anywhere (Semgrep bans the latter repo-wide and
// matches comment text; the former blinds this repo's own comment strippers). String scanning
// is indexOf/split only. NO numeric duplicate of the grace window: every value is synthetic.
// NO `innerHTML` (ADR-0135) — DOM reads are `textContent` only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y } from './overlayRegistry';
import {
  buildPrivacyViewModel,
  PRIVACY_PSEUDONYMIZATION_DISCLOSURE,
  PRIVACY_TERMINAL_NOTICE,
  type PrivacyViewModel,
} from './privacyBanner';
import {
  type DeletionCountdown,
  deriveDeletionCountdown,
  PRIVACY_INITIAL,
  type PrivacyEvent,
  type PrivacyModelState,
  privacyStep,
  SERVER_ALREADY_DELETED_MESSAGE,
} from './privacyModel';
import { PrivacyView, type PrivacyViewHandlers } from './privacyView';

// ---------------------------------------------------------------------------
// Element ids — the CONTRACT, spelled once. These are runtime-CONSTRUCTED (A2-D2):
// `client/index.html` declares none of them, and must not, because
// `evals/overlay-live-region-custody.eval.mjs` pins the count of `aria-modal` shells in that
// file at exactly eleven.
// ---------------------------------------------------------------------------

const OVERLAY_ID = 'privacy-overlay';
const TITLE_ID = 'privacy-title';
const STATUS_ID = 'privacy-status';
const NOTICE_ID = 'privacy-notice';
const DISCLOSURE_ID = 'privacy-disclosure';
const CONFIRM_ID = 'privacy-confirm';
const CLOSE_BTN_ID = 'privacy-close-btn';
const DELETE_BTN_ID = 'privacy-delete-btn';
const CONFIRM_BTN_ID = 'privacy-confirm-btn';
const CONFIRM_CANCEL_BTN_ID = 'privacy-confirm-cancel-btn';
const CANCEL_BTN_ID = 'privacy-cancel-btn';
const EXPORT_BTN_ID = 'privacy-export-btn';
// rb-53 (ADR-0231 A3-D4): the download control and its status line. Both ids are PREFIX-FREE of
// every id above — `privacy-export-status` is not a prefix of `privacy-export-btn` and neither
// is a prefix of the other — so a substring-based census cannot confuse the two export nodes.
const DOWNLOAD_BTN_ID = 'privacy-download-btn';
const EXPORT_STATUS_ID = 'privacy-export-status';

/** Every id the shell owns, so a census can assert none of them leaked into index.html and
 *  every one of them really exists after construction. */
const ALL_PRIVACY_IDS: readonly string[] = [
  OVERLAY_ID,
  CLOSE_BTN_ID,
  TITLE_ID,
  STATUS_ID,
  NOTICE_ID,
  DISCLOSURE_ID,
  CONFIRM_ID,
  DELETE_BTN_ID,
  CONFIRM_BTN_ID,
  CONFIRM_CANCEL_BTN_ID,
  CANCEL_BTN_ID,
  EXPORT_BTN_ID,
  DOWNLOAD_BTN_ID,
  EXPORT_STATUS_ID,
];

// ---------------------------------------------------------------------------
// Fixtures. Synthetic values only — `evals/deletion-grace-wasm-ssot.eval.mjs` G5 reads every
// `client/**/*.ts` RAW and does not exempt test files.
// ---------------------------------------------------------------------------

const RB52_GRACE_MS = 90_000n;
const RB52_NOW_EARLY_MS = 30_000n;
const RB52_NOW_LATE_MS = 60_000n;

const RB52_TERMINAL_REJECT_MESSAGE =
  'cancel-account-deletion: this account has already been permanently deleted';
const RB52_PLAIN_REJECT_MESSAGE = 'request-data-export: export is rate limited, try later';

function rb52Countdown(
  status: string | undefined,
  requestedAtMs: bigint | undefined,
  terminalAtMs: bigint | undefined,
  nowMs: bigint,
): DeletionCountdown {
  return deriveDeletionCountdown({
    status,
    deletionRequestedAtMs: requestedAtMs,
    terminalAtMs,
    nowMs,
    graceMs: RB52_GRACE_MS,
  });
}

const RB52_ACTIVE = rb52Countdown('Active', undefined, undefined, RB52_NOW_EARLY_MS);
const RB52_GRACE = rb52Countdown('PendingDeletion', 0n, undefined, RB52_NOW_EARLY_MS);
const RB52_GRACE_LATER = rb52Countdown('PendingDeletion', 0n, undefined, RB52_NOW_LATE_MS);
/** ★ `terminalAtMs: 0n` — a VALID `Option<i64>` marker that a truthiness test reads as absent. */
const RB52_TERMINAL = rb52Countdown('PendingDeletion', 0n, 0n, RB52_NOW_LATE_MS);

function rb52State(events: readonly PrivacyEvent[]): PrivacyModelState {
  let state: PrivacyModelState = PRIVACY_INITIAL;
  for (const event of events) state = privacyStep(state, event).next;
  return state;
}

/** The state an already-erased account reaches with NO interaction at all: one
 *  `account-changed` carrying the terminal row. Built by RUNNING the model, never by writing
 *  `notice` by hand — `account-changed` does not write `notice`, and that is the whole point. */
const TERMINAL_ROW_STATE = rb52State([{ kind: 'account-changed', countdown: RB52_TERMINAL }]);
/** The SECOND route: a cancel the server refused because the account is already gone. */
const REJECTED_CANCEL_STATE = rb52State([
  { kind: 'account-changed', countdown: RB52_GRACE },
  { kind: 'cancel-deletion-requested', hasLiveConnection: true },
  { kind: 'request-failed', which: 'cancel', message: RB52_TERMINAL_REJECT_MESSAGE },
]);

/** Every reachable phase x notice x confirm shape, each REACHED by running events. */
const RB52_MATRIX: ReadonlyArray<readonly [string, PrivacyModelState]> = [
  ['dark: no account row yet', PRIVACY_INITIAL],
  ['active', rb52State([{ kind: 'account-changed', countdown: RB52_ACTIVE }])],
  ['grace', rb52State([{ kind: 'account-changed', countdown: RB52_GRACE }])],
  ['terminal, from the ROW', TERMINAL_ROW_STATE],
  [
    'active + delete armed',
    rb52State([{ kind: 'account-changed', countdown: RB52_ACTIVE }, { kind: 'delete-requested' }]),
  ],
  [
    'grace + disconnected',
    rb52State([
      { kind: 'account-changed', countdown: RB52_GRACE },
      { kind: 'cancel-deletion-requested', hasLiveConnection: false },
    ]),
  ],
  [
    'grace + a plain server rejection',
    rb52State([
      { kind: 'account-changed', countdown: RB52_GRACE },
      { kind: 'export-requested', hasLiveConnection: true },
      { kind: 'request-failed', which: 'export', message: RB52_PLAIN_REJECT_MESSAGE },
    ]),
  ],
  ['grace + a REJECTED cancel', REJECTED_CANCEL_STATE],
];

/** A synthetic view model, for the tests that need an arbitrary enabled/label combination
 *  rather than a modelled one. The COPY is pinned in `privacyBanner.test.ts`; this file pins
 *  that the shell PAINTS whatever the model hands it, which is why the defaults are obviously
 *  synthetic strings and not the shipped wording. */
function vmOf(overrides: Partial<PrivacyViewModel> = {}): PrivacyViewModel {
  return {
    statusLabel: 'SYNTHETIC STATUS',
    deleteLabel: 'SYNTHETIC DELETE',
    cancelLabel: 'SYNTHETIC CANCEL',
    exportLabel: 'SYNTHETIC EXPORT',
    deleteEnabled: true,
    cancelEnabled: true,
    exportEnabled: true,
    confirmPrompt: undefined,
    noticeKind: 'none',
    noticeLabel: undefined,
    // rb-53: the three export fields. Defaults are the QUIET state (nothing to say, nothing to
    // download), so every pre-existing rb-52 case is unaffected and the rb-53 cases below opt in
    // through `overrides`.
    exportStatusLabel: undefined,
    downloadLabel: 'SYNTHETIC DOWNLOAD',
    downloadEnabled: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Handlers: six spies, so every "exactly one fired" assertion can also say "and the other
// five did not". A single "something was called" check misses delete -> cancel misrouting,
// which on this surface is the difference between starting and aborting an irreversible
// deletion.
// ---------------------------------------------------------------------------

type HandlerName = keyof PrivacyViewHandlers;

const HANDLER_NAMES: readonly HandlerName[] = [
  'onDeleteRequested',
  'onDeleteConfirmed',
  'onConfirmCancelled',
  'onCancelDeletion',
  'onExportRequested',
  'onDismissed',
  // rb-53: SEVEN now. Joining the roster (rather than being spied separately) is what makes
  // every pre-existing `expectOnly` assertion ALSO say "and the download handler did not fire" —
  // which is the misrouting this surface can least afford: `onExportRequested` asks the SERVER
  // to build a new export, `onExportDownload` saves the one already in the client.
  'onExportDownload',
];

let spies: Record<HandlerName, ReturnType<typeof vi.fn>>;
let view: PrivacyView;

function freshSpies(): Record<HandlerName, ReturnType<typeof vi.fn>> {
  return {
    onDeleteRequested: vi.fn(),
    onDeleteConfirmed: vi.fn(),
    onConfirmCancelled: vi.fn(),
    onCancelDeletion: vi.fn(),
    onExportRequested: vi.fn(),
    onDismissed: vi.fn(),
    onExportDownload: vi.fn(),
  };
}

function clearSpies(): void {
  for (const name of HANDLER_NAMES) spies[name].mockClear();
}

/** Exactly one handler fired, exactly once; the other five fired ZERO times. */
function expectOnly(fired: HandlerName): void {
  for (const name of HANDLER_NAMES) {
    expect(
      spies[name],
      name === fired
        ? `${name} must have fired exactly once`
        : `${name} must NOT have fired — a control wired to the wrong handler is how a Cancel ` +
            'button starts a deletion',
    ).toHaveBeenCalledTimes(name === fired ? 1 : 0);
  }
}

// ---------------------------------------------------------------------------
// The visibility walk — `main.ts`'s own `focusInsideHiddenSubtree` idiom, which that file
// documents as the ONE hiding discriminator in this repo ("inline `style.display = 'none'` is
// this repo's ONE hiding idiom — every overlay in both shell families hides that way").
// `checkVisibility()` is deliberately NOT used: this happy-dom version does not implement it,
// which would make the whole proof vacuous.
// ---------------------------------------------------------------------------

/** The nearest ancestor (INCLUDING the node itself) that is `display:none`, described for a
 *  failure message — or `null` when the node is on-screen all the way to `<body>`. */
function hiddenAncestorOf(start: Element | null): string | null {
  for (let node: Element | null = start; node instanceof HTMLElement; node = node.parentElement) {
    if (node.style.display === 'none') return node.id === '' ? node.tagName : `#${node.id}`;
  }
  return null;
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  expect(found, `#${id} must exist — the shell constructs it (A2-D2)`).not.toBeNull();
  return found as HTMLElement;
}

function btn(id: string): HTMLButtonElement {
  const node = el(id);
  expect(
    node.tagName,
    `#${id} must be a NATIVE <button>: evals/keyboard-operable-rows.eval.mjs only accepts a ` +
      'native click receiver, and a div-with-a-listener is unreachable by keyboard',
  ).toBe('BUTTON');
  return node as HTMLButtonElement;
}

/**
 * The full reachability contract for one control, in the order that matters:
 * on-screen -> labelled -> correctly enabled -> and only then clickable.
 */
function expectReachableControl(id: string, label: string, enabled: boolean): HTMLButtonElement {
  const node = btn(id);
  expect(
    hiddenAncestorOf(node),
    `#${id} (or one of its ancestors) is display:none, so no human can reach it. A ` +
      '`.click()` still fires its handler in happy-dom and in Chromium, which is exactly why ' +
      'this assertion runs BEFORE the click ones',
  ).toBeNull();
  expect(
    (node.textContent ?? '').length,
    `#${id} must carry a non-empty label — a blank button has no accessible name and nothing ` +
      'for a sighted player to read either',
  ).toBeGreaterThan(0);
  expect(node.textContent, `#${id} must render the view model's own label`).toBe(label);
  expect(
    node.disabled,
    `#${id}.disabled must mirror the view model (expected disabled=${!enabled})`,
  ).toBe(!enabled);
  return node;
}

// ---------------------------------------------------------------------------

describe('PrivacyView (rb-52, PRV1-3/PRV1-4): the constructed DOM shell', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    spies = freshSpies();
    view = new PrivacyView(spies as unknown as PrivacyViewHandlers);
  });

  afterEach(() => {
    // Calling the PRODUCTION close is the sanctioned test-isolation device: `closeOverlayA11y`
    // with no record is a documented pure no-op (ui/overlayA11y.ts), and the module exports no
    // reset hook by design. Without this the deferred-focus timer and the focus trap from one
    // test leak into the next.
    closeOverlayA11y('privacyView', null);
    document.body.replaceChildren();
  });

  // -------------------------------------------------------------------------
  // Anti-vacuity for the whole file.
  // -------------------------------------------------------------------------

  it('RB52V-WALK-BITES: the display:none ancestor walk reports a REAL hidden ancestor before the overlay is opened, and none after', () => {
    // ★ THE ANTI-VACUITY TOOTH FOR EVERY OTHER TEST HERE. `hiddenAncestorOf` returning `null`
    // is the shape of "reachable"; a helper that had degenerated to always-null would make
    // every `expectReachableControl` call below pass regardless of what the shell ships. So it
    // is shown FAILING first, on a state where the answer is known: a freshly constructed,
    // never-shown overlay really is `display:none`, and the delete button really is inside it.
    // This is also the TRANSITION discipline in miniature — the hidden arm is asserted, then
    // the state is changed, then the visible arm is asserted. Neither is a static.
    expect(view.visible, 'a freshly constructed surface must start closed').toBe(false);
    expect(
      hiddenAncestorOf(el(DELETE_BTN_ID)),
      'before anything is painted, the delete button must be reported as hidden — if this is ' +
        'null the walk is broken and every reachability assertion in this file is vacuous',
    ).not.toBeNull();

    // ★ THE ANCESTOR HALF, ISOLATED. After `render()` but BEFORE `show()`, the button`s OWN
    // inline display has been cleared while the overlay root is still `display:none`. A walk
    // that only inspected the node itself (the third mutant `main.ts` records for this idiom)
    // would answer "reachable" here — which is precisely the state a claimView-shaped shell
    // ships in. The exact id below is what proves the walk CLIMBED.
    view.render(vmOf());
    expect(
      hiddenAncestorOf(el(DELETE_BTN_ID)),
      'with the button painted but the overlay still closed, the walk must climb to the ' +
        'overlay root — a self-only check would wrongly report this as reachable',
    ).toBe(`#${OVERLAY_ID}`);

    view.show();
    view.render(vmOf());
    expect(view.visible).toBe(true);
    expect(
      hiddenAncestorOf(el(DELETE_BTN_ID)),
      'after show() + render(), nothing on the path from the delete button to <body> may be ' +
        'display:none',
    ).toBeNull();
  });

  it('RB52V-SHELL-IDS: every id the contract names is constructed at runtime and lives inside the overlay root', () => {
    // WRONG IMPL KILLED (1): a shell that renames an id. `OVERLAY_A11Y.privacyView`'s
    // `initialFocusSelector` and `main.ts`'s Escape branch both resolve by id, so a rename is a
    // silently unfocusable, silently undismissable modal.
    // WRONG IMPL KILLED (2): a STATIC `index.html` shell (A2-D2). A twelfth `aria-modal` root
    // in that file reds `evals/overlay-live-region-custody.eval.mjs`, which pins the count at
    // exactly eleven and is OUTSIDE this slice's touches — a slice-parking stop. The
    // constructed route is proven here by the fact that the ids exist at all in a happy-dom
    // document that was emptied in `beforeEach` and never parsed any markup.
    for (const id of ALL_PRIVACY_IDS) {
      expect(document.getElementById(id), `#${id} must be constructed at runtime`).not.toBeNull();
    }
    expect(
      new Set(ALL_PRIVACY_IDS).size,
      'ANTI-VACUITY: the id roster must have no duplicates',
    ).toBe(ALL_PRIVACY_IDS.length);
    const overlay = el(OVERLAY_ID);
    for (const id of ALL_PRIVACY_IDS) {
      if (id === OVERLAY_ID) continue;
      expect(
        overlay.contains(el(id)),
        `#${id} must live INSIDE #${OVERLAY_ID} — a node parked on <body> is not hidden by ` +
          'the overlay`s close and would stay on screen forever',
      ).toBe(true);
    }
  });

  it('RB52V-FOCUS-ANCHOR: the registry initialFocusSelector resolves to a native <button> inside the overlay root', () => {
    // WRONG IMPL KILLED (A2-D3): a `tabindex`-ed heading anchor. `openOverlayA11y` resolves
    // `initialFocusSelector` with `root.querySelector(...)`, so an anchor that does not resolve
    // INSIDE the root leaves an opened modal with focus still outside it — and
    // `evals/keyboard-operable-rows.eval.mjs` hard-fails any `tabindex` write from this file,
    // in an eval outside this slice's touches.
    const selector = OVERLAY_A11Y.privacyView.initialFocusSelector;
    expect(selector, 'the registry must point at the always-enabled close button').toBe(
      `#${CLOSE_BTN_ID}`,
    );
    const anchor = el(OVERLAY_ID).querySelector(selector);
    expect(anchor, 'the anchor must resolve INSIDE the overlay root').not.toBeNull();
    expect((anchor as HTMLElement).tagName).toBe('BUTTON');
  });

  it('RB52V-ANCHOR-NEVER-DISABLED: the initial-focus anchor is enabled in EVERY phase, incl. grace and terminal', () => {
    // WRONG IMPL KILLED (the shipped first draft): pointing `initialFocusSelector` at
    // `#privacy-delete-btn`. `deletePermitted` is true ONLY in phase `active`, so in `grace`
    // (PRV1-3's own state) and `terminal` (PRV1-4's) the anchor carries `disabled` — and a
    // disabled control is unfocusable, so `openOverlayA11y`'s `.focus()` is a silent no-op,
    // focus stays on <body>, and `focusTrap`'s capture listener on the root NEVER fires: Tab
    // walks the page behind an open modal. In `terminal` every other control is disabled or
    // hidden, so the trap would have no focusable content at all.
    //
    // happy-dom will happily "focus" a disabled node, so asserting activeElement here would be
    // green against the very bug this kills. The honest oracle is the `disabled` property on the
    // anchor across every phase.
    const anchorId = OVERLAY_A11Y.privacyView.initialFocusSelector.slice(1);
    let checked = 0;
    const phasesSeen = new Set<string>();
    for (const [label, state] of RB52_MATRIX) {
      view.render(buildPrivacyViewModel(state));
      const anchor = el(anchorId) as HTMLButtonElement;
      expect(anchor.disabled, `${label}: the initial-focus anchor must never be disabled`).toBe(
        false,
      );
      expect(
        anchor.style.display,
        `${label}: the initial-focus anchor must never be display:none`,
      ).not.toBe('none');
      phasesSeen.add(state.countdown.phase);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: every matrix state must have been rendered').toBe(
      RB52_MATRIX.length,
    );
    // The two phases that make this tooth necessary must BOTH be in the matrix, or it is a
    // parameterised assertion over states in which the delete button happens to be enabled.
    expect(phasesSeen.has('grace'), 'ANTI-VACUITY: the matrix must reach grace').toBe(true);
    expect(phasesSeen.has('terminal'), 'ANTI-VACUITY: the matrix must reach terminal').toBe(true);
  });

  // -------------------------------------------------------------------------
  // TOOTH 1 + TOOTH 2 — reachable controls, exclusively wired.
  // -------------------------------------------------------------------------

  const CONTROLS: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly handler: HandlerName;
  }> = [
    { id: DELETE_BTN_ID, label: 'SYNTHETIC DELETE', handler: 'onDeleteRequested' },
    { id: CANCEL_BTN_ID, label: 'SYNTHETIC CANCEL', handler: 'onCancelDeletion' },
    { id: EXPORT_BTN_ID, label: 'SYNTHETIC EXPORT', handler: 'onExportRequested' },
  ];

  it.each(CONTROLS)(
    'RB52V-CONTROL-REACHABLE ($id is visible, labelled, enabled — and fires $handler and NOTHING else)',
    ({ id, label, handler }) => {
      // WRONG IMPL KILLED (1) ★ THE MEASURED ONE: copying `claimView.ts`'s `#wireButton`
      // verbatim. `ensureElement` creates every node `display:none` and claimView never
      // un-hides its buttons, so that shell ships five blank invisible controls whose handlers
      // a `.click()` still fires. Every click-only test passes; the human sees an empty box.
      // The walk + the label assertion inside `expectReachableControl` are what see it.
      // WRONG IMPL KILLED (2): a control wired to the wrong handler (delete -> cancel). The
      // five zero-count assertions in `expectOnly` are what see THAT; a bare "some handler
      // fired" check cannot.
      // WRONG IMPL KILLED (3): a handler bound at construction to a stale closure so a second
      // click fires nothing — the call count is exact, not `toHaveBeenCalled`.
      view.show();
      view.render(vmOf());
      clearSpies();
      const node = expectReachableControl(id, label, true);
      node.click();
      expectOnly(handler);
    },
  );

  it('RB52V-DISABLED-MIRROR: `disabled` follows the view model in BOTH directions, per control', () => {
    // WRONG IMPL KILLED (1) ★: never writing `disabled` at all. Every control would stay live,
    // so a `terminal` account still offers Cancel and a `PendingDeletion` one still offers
    // Delete — a button that silently does nothing, on the one surface where "nothing happened"
    // and "your account is being erased" are the two possible readings.
    // WRONG IMPL KILLED (2): writing `disabled` ONCE and never clearing it on the way back —
    // hence the TRANSITION below (enabled -> disabled -> enabled), never a static snapshot.
    // WRONG IMPL KILLED (3): a transposition (delete reading cancelEnabled): the middle render
    // gives the three flags three DIFFERENT values, so a swap cannot survive it.
    view.show();
    view.render(vmOf());
    expect(btn(DELETE_BTN_ID).disabled).toBe(false);
    expect(btn(CANCEL_BTN_ID).disabled).toBe(false);
    expect(btn(EXPORT_BTN_ID).disabled).toBe(false);

    view.render(vmOf({ deleteEnabled: false, cancelEnabled: true, exportEnabled: false }));
    expect(btn(DELETE_BTN_ID).disabled, 'delete must follow deleteEnabled').toBe(true);
    expect(btn(CANCEL_BTN_ID).disabled, 'cancel must follow cancelEnabled').toBe(false);
    expect(btn(EXPORT_BTN_ID).disabled, 'export must follow exportEnabled').toBe(true);

    view.render(vmOf({ deleteEnabled: true, cancelEnabled: false, exportEnabled: true }));
    expect(btn(DELETE_BTN_ID).disabled).toBe(false);
    expect(btn(CANCEL_BTN_ID).disabled).toBe(true);
    expect(btn(EXPORT_BTN_ID).disabled).toBe(false);
  });

  it('RB52V-CONFIRM-STEP-TWO: the confirm row appears only while armed, is reachable while it is, and its two buttons are exclusively wired', () => {
    // WRONG IMPL KILLED (1) ★: painting step two unconditionally. A bare "Confirm deletion"
    // sitting beside "Delete my account" at all times turns the two-step gate for an
    // irreversible action into a one-click delete.
    // WRONG IMPL KILLED (2): a confirm row that is present but display:none while armed —
    // clickable in a test, invisible to the player, so the two-step flow dead-ends after step
    // one. The `hiddenAncestorOf` walks inlined below are what see it.
    // WRONG IMPL KILLED (3): both confirm buttons wired to the same handler (so "Keep my
    // account" confirms the deletion). Two separate exclusive assertions are what see it.
    // ORDER IS THE TRANSITION DISCIPLINE: the armed (positive) state is asserted FIRST, then
    // the render that must remove it — a born-hidden row makes the disarmed assertion vacuous.
    view.show();
    view.render(vmOf({ confirmPrompt: 'SYNTHETIC CONFIRM PROMPT' }));
    expect(el(CONFIRM_ID).textContent).toBe('SYNTHETIC CONFIRM PROMPT');
    expect(
      hiddenAncestorOf(el(CONFIRM_ID)),
      'the armed prompt must be ON SCREEN, not merely present in the DOM',
    ).toBeNull();

    clearSpies();
    const confirmNode = btn(CONFIRM_BTN_ID);
    expect(hiddenAncestorOf(confirmNode), 'step two must be reachable while armed').toBeNull();
    expect((confirmNode.textContent ?? '').length).toBeGreaterThan(0);
    expect(confirmNode.disabled, 'step two must be enabled while armed').toBe(false);
    confirmNode.click();
    expectOnly('onDeleteConfirmed');

    view.render(vmOf({ confirmPrompt: 'SYNTHETIC CONFIRM PROMPT' }));
    clearSpies();
    const keepNode = btn(CONFIRM_CANCEL_BTN_ID);
    expect(hiddenAncestorOf(keepNode)).toBeNull();
    expect((keepNode.textContent ?? '').length).toBeGreaterThan(0);
    expect(
      keepNode.textContent,
      'the two confirm-row buttons must not share one label — a player must be able to tell ' +
        'the irreversible one from the escape hatch',
    ).not.toBe(confirmNode.textContent);
    keepNode.click();
    expectOnly('onConfirmCancelled');

    // TRANSITION AWAY: disarming must take the whole row off screen again.
    view.render(vmOf({ confirmPrompt: undefined }));
    expect(el(CONFIRM_ID).textContent, 'the disarmed prompt must be blank').toBe('');
    expect(
      hiddenAncestorOf(el(CONFIRM_ID)),
      'the disarmed prompt must be HIDDEN, not just emptied — a blank paragraph still occupies ' +
        'the layout and still reads as a control the player half-completed',
    ).not.toBeNull();
    expect(
      hiddenAncestorOf(btn(CONFIRM_BTN_ID)),
      'step two must be off screen once the confirmation is disarmed',
    ).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // TOOTH 3 — the distinct terminal notice, from the ROW, with no click.
  // -------------------------------------------------------------------------

  it('RB52V-TERMINAL-ROW-NO-CLICK: opening on an already-erased account renders the exact PRIVACY_TERMINAL_NOTICE with ZERO interaction', () => {
    // ★ THE CRITERION, AT THE DOM TIER. "render the distinct terminal notice once
    // terminal_at_ms is Some" — on OPEN, with no click anywhere.
    // WRONG IMPL KILLED (1) ★ THE MEASURED DEFECT (ADR-0231 A2-D6): a view model keyed on
    // `state.notice` alone. `account-changed` never writes `notice`, so the notice element
    // would be EMPTY here and the criterion fails while every click-driven test passes. The
    // fixture is built by RUNNING `privacyStep` with a real `deriveDeletionCountdown`, never by
    // hand-setting `notice`, precisely so that route is the one under test.
    // WRONG IMPL KILLED (2): a truthiness-keyed terminal test upstream — `terminalAtMs` is `0n`
    // here, a valid marker, and `if (terminalAtMs)` inverts PRV1-4 on exactly this value.
    // WRONG IMPL KILLED (3): a notice element that carries the right text but is display:none
    // (or sits inside a hidden row) — invisible to the player, green to a textContent check.
    expect(
      TERMINAL_ROW_STATE.countdown.phase,
      'ANTI-VACUITY: the fixture must really be the terminal phase',
    ).toBe('terminal');
    expect(
      TERMINAL_ROW_STATE.notice,
      'ANTI-VACUITY + THE POINT: no notice CODE was written, so only the ROW can drive this',
    ).toBe('none');

    view.show();
    view.render(buildPrivacyViewModel(TERMINAL_ROW_STATE));
    for (const name of HANDLER_NAMES) {
      expect(
        spies[name],
        `${name} must not have fired — nothing was clicked`,
      ).toHaveBeenCalledTimes(0);
    }
    const notice = el(NOTICE_ID);
    expect(notice.textContent).toBe(PRIVACY_TERMINAL_NOTICE);
    expect(
      hiddenAncestorOf(notice),
      'the terminal notice must be ON SCREEN — this is the only place the player is told the ' +
        'account is already gone',
    ).toBeNull();

    // TRANSITION AWAY: a cancelled/never-started deletion must clear it again. Without this
    // arm, a frozen notice would sit on the surface for the rest of the page's life.
    view.render(
      buildPrivacyViewModel(rb52State([{ kind: 'account-changed', countdown: RB52_ACTIVE }])),
    );
    expect(el(NOTICE_ID).textContent, 'the notice must be cleared, not frozen').toBe('');
    expect(
      hiddenAncestorOf(el(NOTICE_ID)),
      'and hidden — an empty but displayed notice box is a paint bug the player reads as a ' +
        'half-loaded surface',
    ).not.toBeNull();
  });

  it('RB52V-TERMINAL-BOTH-ROUTES: the rejected-cancel route renders the SAME string, and a plain rejection renders a DIFFERENT one', () => {
    // WRONG IMPL KILLED (1): keying the terminal copy on `countdown.phase` alone. The row can
    // still read `grace` when the client's subscription has not caught up with the server's
    // erasure, and this rejection is then the only signal the player gets.
    // WRONG IMPL KILLED (2) ★: collapsing `request-rejected` onto the terminal sentence, so a
    // rate-limited export tells the player their account is permanently deleted.
    expect(
      RB52_TERMINAL_REJECT_MESSAGE.endsWith(SERVER_ALREADY_DELETED_MESSAGE),
      'ANTI-DRIFT: the fixture must still be the composed shape the shell really delivers',
    ).toBe(true);
    expect(
      REJECTED_CANCEL_STATE.notice,
      'ANTI-VACUITY: the model must have classified this as the terminal outcome',
    ).toBe('permanently-deleted');

    view.show();
    view.render(buildPrivacyViewModel(REJECTED_CANCEL_STATE));
    expect(el(NOTICE_ID).textContent).toBe(PRIVACY_TERMINAL_NOTICE);
    expect(hiddenAncestorOf(el(NOTICE_ID))).toBeNull();

    view.render(
      buildPrivacyViewModel(
        rb52State([
          { kind: 'account-changed', countdown: RB52_GRACE },
          { kind: 'export-requested', hasLiveConnection: true },
          { kind: 'request-failed', which: 'export', message: RB52_PLAIN_REJECT_MESSAGE },
        ]),
      ),
    );
    expect(el(NOTICE_ID).textContent, 'the server message is rendered VERBATIM').toBe(
      RB52_PLAIN_REJECT_MESSAGE,
    );
    expect(
      el(NOTICE_ID).textContent,
      'and it must NOT be the terminal sentence — this account still has a live, cancellable ' +
        'grace window',
    ).not.toBe(PRIVACY_TERMINAL_NOTICE);
  });

  // -------------------------------------------------------------------------
  // TOOTH 7 — the section 9 disclosure is on screen in EVERY state.
  // -------------------------------------------------------------------------

  it.each(RB52_MATRIX.map(([where, state]) => ({ where, state })))(
    'RB52V-DISCLOSURE-ALWAYS ($where still shows the full section 9 pseudonymization sentence)',
    ({ state }) => {
      // WRONG IMPL KILLED ★: a render path that blanks or replaces the disclosure on ONE branch
      // — the terminal one being the obvious candidate ("the account is gone, the caveat no
      // longer applies"). It is exactly backwards: the sentence explains that the Identity key
      // and its behavioral history are NOT purged, which is most load-bearing precisely when
      // the account has just been erased. A single-state assertion cannot see a one-branch
      // blank; the matrix can.
      // WRONG IMPL KILLED (2): a disclosure written once at construction and then destroyed by
      // a later `replaceChildren()`-style rebuild — the assertion runs AFTER a render.
      view.show();
      view.render(buildPrivacyViewModel(state));
      const disclosure = el(DISCLOSURE_ID);
      expect(disclosure.textContent).toBe(PRIVACY_PSEUDONYMIZATION_DISCLOSURE);
      expect(
        hiddenAncestorOf(disclosure),
        'the disclosure must be ON SCREEN in this state, not merely present in the DOM',
      ).toBeNull();
    },
  );

  it('RB52V-ERASURE-CENSUS-DOM: "erasure" appears exactly once in the rendered surface, and only inside the disclosure element', () => {
    // ⚠ A "the surface must not contain the word erasure" scan is the WRONG gate and would fail
    // CORRECT code: the mandated sentence ENDS in "not erasure." The invariant is a census.
    // WRONG IMPL KILLED ★: a terminal notice, status line or confirm prompt that promises
    // "permanent erasure of your data" — legally false on this server, which anonymizes the
    // Identity key rather than erasing it. It is invisible to any assertion scoped to the
    // disclosure alone, because the disclosure would still be correct.
    view.show();
    view.render(buildPrivacyViewModel(TERMINAL_ROW_STATE));

    let count = 0;
    let from = 0;
    const disclosureText = el(DISCLOSURE_ID).textContent ?? '';
    for (;;) {
      const at = disclosureText.indexOf('erasure', from);
      if (at === -1) break;
      count += 1;
      from = at + 'erasure'.length;
    }
    expect(count, 'the disclosure carries the word exactly once, as its final word').toBe(1);

    for (const id of ALL_PRIVACY_IDS) {
      if (id === DISCLOSURE_ID || id === OVERLAY_ID) continue;
      const text = el(id).textContent ?? '';
      expect(
        text.indexOf('erasure'),
        `#${id} renders ${JSON.stringify(text)}, which uses the word "erasure". Only the ` +
          'section 9 disclosure may — every other sentence promising erasure is a legally ' +
          'significant false claim about what this server actually does',
      ).toBe(-1);
    }
  });

  // -------------------------------------------------------------------------
  // TOOTH 8 — the status line is FORMATTED from the injected window.
  // -------------------------------------------------------------------------

  it('RB52V-STATUS-TICKS: two different injected remaining times paint two different status lines', () => {
    // WRONG IMPL KILLED (1) ★: an AUTHORED duration anywhere on the path ("in 7 days").
    // `evals/deletion-grace-wasm-ssot.eval.mjs` G5 catches only NUMERIC duplicates of the
    // window, so a PROSE one ships silently and desyncs the moment an operator retunes the real
    // constant. Two different injected windows producing two different painted sentences is the
    // positive tooth that closes it, and it is asserted on the DOM rather than on the model so
    // a shell that paints a hard-coded string of its own is caught too.
    // WRONG IMPL KILLED (2): a status element written once at construction and never
    // re-rendered — the second render below would leave the first sentence on screen.
    view.show();
    view.render(
      buildPrivacyViewModel(rb52State([{ kind: 'account-changed', countdown: RB52_GRACE }])),
    );
    const first = el(STATUS_ID).textContent ?? '';
    expect(first.length, 'the status line must be painted and non-empty').toBeGreaterThan(0);
    expect(hiddenAncestorOf(el(STATUS_ID)), 'and on screen').toBeNull();

    view.render(
      buildPrivacyViewModel(rb52State([{ kind: 'account-changed', countdown: RB52_GRACE_LATER }])),
    );
    const second = el(STATUS_ID).textContent ?? '';
    expect(
      second,
      `both remaining times painted ${JSON.stringify(first)} — the duration was AUTHORED, not ` +
        'formatted from the injected window',
    ).not.toBe(first);
  });

  // -------------------------------------------------------------------------
  // TOOTH 4 — every close disarms.
  // -------------------------------------------------------------------------

  it('RB52V-DISARM-ON-CLOSE: hide() calls onDismissed, and a re-open shows no confirmation prompt', () => {
    // ★ WHY THE DISARM LIVES IN `hide()` AND NOT AT THE CALL SITE (ADR-0231 A2-D4):
    // `privacyView` is in `BATTLE_FORCE_HIDE`, and a battle auto-show reaches this shell
    // through `main.ts`'s handle table, whose entry is the byte-identical
    // `privacyView?.hide()` pinned by W-UXD3C-HANDLE-TABLE — it cannot carry the disarm itself.
    // So a force-hide with an armed delete confirmation would leave the model armed behind a
    // hidden overlay, and the player's NEXT click on a re-opened surface would be step two of a
    // confirmation they no longer remember giving.
    // WRONG IMPL KILLED (1) ★: `hide()` that only writes display + closeOverlayA11y (the
    // claimView shape). `onDismissed` never fires and the model stays armed.
    // WRONG IMPL KILLED (2): a disarm wired to Escape only, in `main.ts`, leaving the
    // force-hide path armed. The handler is asserted here, on the shell's own `hide()`.
    // The model is driven for real below — the spy runs the SAME `confirm-cancelled` event
    // `main.ts`'s `onDismissed` dispatches — so this proves the round trip, not just the call.
    let state = rb52State([
      { kind: 'account-changed', countdown: RB52_ACTIVE },
      { kind: 'delete-requested' },
    ]);
    expect(state.confirm, 'ANTI-VACUITY: step one must really have armed the model').toBe(
      'delete-armed',
    );
    spies.onDismissed.mockImplementation(() => {
      state = privacyStep(state, { kind: 'confirm-cancelled' }).next;
    });

    view.show();
    view.render(buildPrivacyViewModel(state));
    expect(
      (el(CONFIRM_ID).textContent ?? '').length,
      'POSITIVE FIRST: the armed prompt must really be on screen before the close',
    ).toBeGreaterThan(0);
    expect(hiddenAncestorOf(el(CONFIRM_ID))).toBeNull();

    clearSpies();
    view.hide();
    expect(spies.onDismissed, 'hide() must notify the model exactly once').toHaveBeenCalledTimes(1);
    for (const name of HANDLER_NAMES) {
      if (name === 'onDismissed') continue;
      expect(spies[name], `${name} must not fire on a close`).toHaveBeenCalledTimes(0);
    }
    expect(view.visible, 'and the surface must actually be closed').toBe(false);
    expect(state.confirm, 'the close must have DISARMED the confirmation').toBe('none');

    // RE-OPEN: the surface must come back with no half-completed irreversible action on it.
    view.show();
    view.render(buildPrivacyViewModel(state));
    expect(el(CONFIRM_ID).textContent, 'a re-opened surface shows no prompt').toBe('');
    expect(
      hiddenAncestorOf(el(CONFIRM_ID)),
      'and the confirm row is off screen again',
    ).not.toBeNull();
    expect(
      hiddenAncestorOf(btn(CONFIRM_BTN_ID)),
      'step two must not be reachable on a re-opened, disarmed surface',
    ).not.toBeNull();
  });

  it('RB52V-VISIBILITY-LIFECYCLE: `visible` tracks show/hide/toggle, and toggle-close also disarms', () => {
    // WRONG IMPL KILLED (1): a `visible` getter reading a shadow field rather than the DOM —
    // `main.ts` probes this getter for `canOpen`, `anyOverlayVisible` and the Escape branch, so
    // a getter that disagrees with the paint makes the modal simultaneously open and closed.
    // WRONG IMPL KILLED (2): `toggle()` that only ever shows (or that bypasses `hide()` and so
    // skips the disarm) — the toggle path is a real close path and must carry the same
    // guarantee. The call count below is what sees it.
    expect(view.visible).toBe(false);
    view.show();
    expect(view.visible).toBe(true);
    clearSpies();
    view.toggle();
    expect(view.visible, 'toggle on an open surface must close it').toBe(false);
    expect(spies.onDismissed, 'and the toggle-close must disarm too').toHaveBeenCalledTimes(1);
    view.toggle();
    expect(view.visible, 'toggle on a closed surface must open it').toBe(true);
  });

  // -------------------------------------------------------------------------
  // rb-53 (PRV1-11/12/13, ADR-0231 Amendment A3) — the DOWNLOAD control and the
  // export status line. Appended INSIDE this describe so they share the same
  // beforeEach/afterEach lifecycle (one constructed shell, one cleanup path).
  //
  // THE CONTRACT THIS TIER ADDS:
  //   * `<button id="privacy-download-btn">`, declared `HTMLButtonElement`, ALWAYS PAINTED and
  //     only ever `disabled` (A3-D4) — never `display:none`;
  //   * `<p id="privacy-export-status">`, hidden when `vm.exportStatusLabel === undefined`,
  //     mirroring `#privacy-notice`;
  //   * `PrivacyViewHandlers` gains `readonly onExportDownload: () => void;`.
  // Every decision stays in `ui/privacyBanner.ts`; this file only paints.
  // -------------------------------------------------------------------------

  /** The four `ExportAssemblyStatus` outcomes as this tier sees them: a label and an enablement.
   *  The COPY is pinned in privacyBanner.test.ts — these are obviously synthetic strings, so a
   *  shell that painted a hard-coded sentence of its own would fail here. */
  const RB53_EXPORT_STATES: ReadonlyArray<{
    readonly where: string;
    readonly label: string;
    readonly enabled: boolean;
  }> = [
    { where: 'none: nothing has arrived', label: 'SYNTHETIC EXPORT NONE', enabled: false },
    { where: 'incomplete: still streaming', label: 'SYNTHETIC EXPORT INCOMPLETE', enabled: false },
    {
      where: 'inconsistent: the delivered rows disagree',
      label: 'SYNTHETIC EXPORT INCONSISTENT',
      enabled: false,
    },
    { where: 'complete: the artifact is ready', label: 'SYNTHETIC EXPORT COMPLETE', enabled: true },
  ];

  /** The ids of every ancestor of `node`, nearest first — used to prove a node is REACHABLE
   *  from the overlay root by WALKING, never by clicking it (this file's standing rule). */
  function ancestorMarkersOf(node: Element | null): string[] {
    const out: string[] = [];
    for (
      let el: Element | null = node?.parentElement ?? null;
      el instanceof HTMLElement;
      el = el.parentElement
    ) {
      out.push(el.id === '' ? el.tagName : `#${el.id}`);
    }
    return out;
  }

  it('★★ RB53V-DOWNLOAD-ALWAYS-PAINTED: the download control is a labelled native <button> that is NEVER display:none — in all four export states', () => {
    // ★ THIS IS A3-D4, AND IT IS LOAD-BEARING RATHER THAN COSMETIC. Unlike every other control
    // in this file, the download control's enablement is driven by INCOMING SERVER DATA, so it
    // can flip WHILE THE PLAYER HAS IT FOCUSED. `overlayRegistry.ts:275-279` records the
    // consequence of a focused node disappearing: focus falls to <body>, which is NOT a
    // descendant of the overlay root, so `focusTrap`'s capture listener never fires and Tab
    // walks the page behind an `aria-modal` dialog Chromium does not make AT-inert. A control
    // that vanishes under focus is that defect through a new door.
    // WRONG IMPL KILLED (1) ★ THE MEASURED SHAPE: hide-when-disabled —
    //   `this.#downloadBtn.style.display = vm.downloadEnabled ? '' : 'none';`, i.e. exactly what
    //   the confirm row two methods above legitimately does. The THREE non-complete states are
    //   asserted explicitly because they are the states the export spends almost all of its
    //   life in, and a `complete`-only assertion would never see it.
    // WRONG IMPL KILLED (2): the claimView `#wireButton` shape — `ensureElement` creates every
    //   node `display:none` and never un-hides it, so the control ships BLANK and INVISIBLE
    //   while a programmatic `.click()` still fires its handler. The walk + the label assertion
    //   are what see it; a click-only test certifies an invisible surface as reachable.
    // WRONG IMPL KILLED (3): a `<div>` with a listener — `evals/keyboard-operable-rows.eval.mjs`
    //   only accepts a native click receiver, and a div is unreachable by keyboard.
    view.show();
    let checked = 0;
    for (const state of RB53_EXPORT_STATES) {
      view.render(vmOf({ exportStatusLabel: state.label, downloadEnabled: state.enabled }));
      const node = btn(DOWNLOAD_BTN_ID);
      expect(
        hiddenAncestorOf(node),
        `${state.where}: #${DOWNLOAD_BTN_ID} (or an ancestor) is display:none, so no human can ` +
          'reach it — and if it vanished while focused, focus falls to <body> and every ' +
          'keyboard user is outside the modal with the trap silently inert (A3-D4)',
      ).toBeNull();
      expect(
        node.style.display,
        `${state.where}: the download control must never carry an inline display:none of its own`,
      ).not.toBe('none');
      expect(
        (node.textContent ?? '').length,
        `${state.where}: the download control must carry a non-empty label — a blank button has ` +
          'no accessible name and nothing for a sighted player to read either',
      ).toBeGreaterThan(0);
      expect(node.textContent, `${state.where}: it must render the view model's own label`).toBe(
        'SYNTHETIC DOWNLOAD',
      );
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: all four export states must have been rendered').toBe(
      RB53_EXPORT_STATES.length,
    );
  });

  it('★★ RB53V-DOWNLOAD-DISABLED-MIRROR: `disabled` is false EXACTLY when downloadEnabled, in BOTH directions', () => {
    // WRONG IMPL KILLED (1) ★: never writing `disabled` at all — the control would be live on an
    //   `incomplete` assembly, and clicking it hands the player a TRUNCATED personal-data file
    //   (or an empty one: the core returns `artifact: undefined` for every non-complete status)
    //   while calling it their export. That is worse than refusing, because it looks
    //   authoritative.
    // WRONG IMPL KILLED (2): writing `disabled` ONCE and never clearing it on the way back —
    //   hence the TRANSITION below (disabled -> enabled -> disabled), never a static snapshot.
    //   This direction is the one the arrival edge depends on: chunks stream in and the control
    //   must come alive without a re-open.
    // WRONG IMPL KILLED (3): reading the WRONG flag (`vm.exportEnabled`, its nearest neighbour)
    //   — the middle render gives the two flags DIFFERENT values, so the transposition cannot
    //   survive it.
    view.show();
    view.render(vmOf({ downloadEnabled: false, exportEnabled: true }));
    expect(
      btn(DOWNLOAD_BTN_ID).disabled,
      'nothing to download yet — the control is painted and refused',
    ).toBe(true);

    view.render(vmOf({ downloadEnabled: true, exportEnabled: false }));
    expect(
      btn(DOWNLOAD_BTN_ID).disabled,
      'the artifact arrived: the control must come ALIVE without a re-open. (exportEnabled is ' +
        'false here on purpose — a shell reading that flag instead would still be disabled)',
    ).toBe(false);

    view.render(vmOf({ downloadEnabled: false, exportEnabled: true }));
    expect(
      btn(DOWNLOAD_BTN_ID).disabled,
      'and it must go BACK to refused when the export is reaped server-side — a one-way write ' +
        'leaves a live button over a file that no longer exists',
    ).toBe(true);
  });

  it('★★ RB53V-DOWNLOAD-CLICK-EXCLUSIVE: clicking the enabled control fires onExportDownload exactly once and NOTHING else', () => {
    // WRONG IMPL KILLED (1) ★ THE MISROUTING THAT MATTERS ON THIS SURFACE: the download control
    //   wired to `onExportRequested` (a copy-paste of the export branch one line above). The
    //   player presses "Download" and the client asks the SERVER to build ANOTHER export — which
    //   purges the live rows and re-mints them, so the artifact they were about to save
    //   disappears. The six zero-count assertions in `expectOnly` are what see it; a bare
    //   "something fired" check cannot.
    // WRONG IMPL KILLED (2): a handler bound at construction to a stale closure so a second
    //   click fires nothing — the call count is exact, not `toHaveBeenCalled`.
    // REACHABILITY FIRST, as everywhere in this file: on screen and labelled BEFORE the click.
    view.show();
    view.render(vmOf({ downloadEnabled: true, exportStatusLabel: 'SYNTHETIC EXPORT COMPLETE' }));
    clearSpies();
    const node = expectReachableControl(DOWNLOAD_BTN_ID, 'SYNTHETIC DOWNLOAD', true);
    node.click();
    expectOnly('onExportDownload');
  });

  it('★★ RB53V-EXPORT-STATUS-BOTH-WAYS: the status line shows the label and HIDES on undefined — asserted in BOTH directions', () => {
    // WRONG IMPL KILLED (1) ★: a node written ONCE and then frozen — the transition is asserted
    //   twice, hidden -> visible -> hidden, so a shell that paints the first label and never
    //   updates fails the second render, and one that never hides fails the third.
    // WRONG IMPL KILLED (2): keying the hide on `''` instead of `undefined` (or on
    //   `?? ''`) — the view model deliberately distinguishes "nothing to say" (undefined) from
    //   any sentence, and an empty-but-displayed paragraph occupies the layout forever, which
    //   the player reads as a half-loaded surface.
    // WRONG IMPL KILLED (3): rendering the export status into `#privacy-notice` or
    //   `#privacy-status` instead of its own node — the two neighbours are asserted UNMOVED, so
    //   a shell that reused either would fail here rather than silently overwriting the
    //   deletion deadline or the server's rejection message with an export sentence.
    view.show();

    // HIDDEN FIRST — the state the surface opens in before any batch has been applied.
    view.render(vmOf({ exportStatusLabel: undefined }));
    expect(el(EXPORT_STATUS_ID).textContent, 'nothing to say ⇒ nothing rendered').toBe('');
    expect(
      hiddenAncestorOf(el(EXPORT_STATUS_ID)),
      'and the paragraph must be OFF SCREEN, not merely emptied',
    ).not.toBeNull();

    // VISIBLE — a real sentence arrives.
    const beforeStatus = el(STATUS_ID).textContent;
    const beforeNotice = el(NOTICE_ID).textContent;
    view.render(vmOf({ exportStatusLabel: 'SYNTHETIC EXPORT INCOMPLETE' }));
    expect(el(EXPORT_STATUS_ID).textContent).toBe('SYNTHETIC EXPORT INCOMPLETE');
    expect(
      hiddenAncestorOf(el(EXPORT_STATUS_ID)),
      'the export sentence must be ON SCREEN — it is the only place the player is told whether ' +
        'their export is streaming, broken or ready',
    ).toBeNull();
    expect(
      el(STATUS_ID).textContent,
      'the DELETION status line must be untouched — it carries a legal deadline, and an export ' +
        'sentence written over it is that deadline silently replaced',
    ).toBe(beforeStatus);
    expect(el(NOTICE_ID).textContent, 'and the notice line must be untouched too').toBe(
      beforeNotice,
    );

    // HIDDEN AGAIN — the assembly is cleared (a reconnect, or a reaped export).
    view.render(vmOf({ exportStatusLabel: undefined }));
    expect(el(EXPORT_STATUS_ID).textContent, 'the sentence must be cleared, not frozen').toBe('');
    expect(
      hiddenAncestorOf(el(EXPORT_STATUS_ID)),
      'and hidden again — without this arm a stale "your export is ready" sits on the surface ' +
        'for the rest of the page`s life, over an artifact the client no longer holds',
    ).not.toBeNull();
  });

  it('★ RB53V-NEW-NODES-INSIDE-OVERLAY: both new ids are DESCENDANTS of #privacy-overlay, proved by walking the ancestor chain', () => {
    // WRONG IMPL KILLED: a node created by `ensureElement` and never appended to the overlay
    //   root — it stays parked on <body>, where `hide()` cannot reach it. The download control
    //   would then remain on screen, over the world, after the modal closes; and because it is
    //   outside the root, `focusTrap` would never see it either.
    // Proved by WALKING, never by clicking: a `.click()` fires the handler of a node parked
    // anywhere in the document, so it says nothing at all about where the node lives.
    view.show();
    view.render(vmOf({ exportStatusLabel: 'SYNTHETIC EXPORT COMPLETE', downloadEnabled: true }));
    for (const id of [DOWNLOAD_BTN_ID, EXPORT_STATUS_ID]) {
      const markers = ancestorMarkersOf(el(id));
      expect(
        markers.indexOf(`#${OVERLAY_ID}`),
        `#${id} must have #${OVERLAY_ID} among its ancestors; walked ${JSON.stringify(markers)}. ` +
          'A node parked on <body> is not hidden by the overlay`s close and would stay on ' +
          'screen forever',
      ).not.toBe(-1);
      expect(
        hiddenAncestorOf(el(id)),
        `#${id} must be reachable once the surface is open`,
      ).toBeNull();
    }
    expect(
      el(EXPORT_STATUS_ID).tagName,
      'the export status line is a paragraph, not a button',
    ).toBe('P');
  });
});
