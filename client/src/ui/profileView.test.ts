// @vitest-environment happy-dom
// ui/profileView.test.ts — uif-16b (UIF16B.1-UIF16B.4): Profile is ONE dialog with three sections.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-ui-foundation.spec.md § uif-16b;
//   memory/projects/monster-realm-uif-16b-plan.md (DOM, `ui/profileView.ts`, Sections).
//
// RED REASON: `ui/profileView.ts` does not exist yet (module-not-found), and the three views are
// still overlays of their own (their own a11y, their own `mr-frame`/`mr-shell`, a frame title bar
// instead of a section header, `#privacy-close-btn` still shipped).
//
// THE FIXTURE IS THE REAL THING. `ProfileView` is handed the REAL `RenameView`, `ClaimView` and
// `PrivacyView` (never fakes), over a minimal shell: `#game-screen > #app + #frame-layer`, the
// frame layer holding the static `#rename-overlay` exactly as the new index.html ships it (no
// role, no aria-modal, class `mr-button-rows`). Claim and privacy phases are REACHED by running
// the real reducers (`claimStep` / `privacyStep`) and their view models (`buildClaimViewModel` /
// `buildPrivacyViewModel`) wherever a test is about phases; synthetic privacy view models are
// used only where a test needs an exact enable/disable combination.
//
// THE MECHANISM ORACLE. `vi.mock('./overlayA11y', { spy: true })` records every call AND calls
// through, so a frame that hand-writes role/aria-label without the helper (no trap, no return
// focus, no deferred anchor) still reds.
//
// happy-dom FOCUSES disabled and display:none nodes, so every focus assertion on a control ALSO
// asserts that it is enabled and that neither it nor any ancestor up to the frame root is inline
// `display: none` (`expectUsableFocus`).
//
// ISOLATION: overlayA11y.ts holds one module-private Map with no reset hook, so the file-level
// hooks call the PRODUCTION `closeOverlayA11y(id, null)` for every OverlayId and flush one real
// macrotask (a close without an open is a documented no-op).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t as copyT } from './a11yCopy';
import {
  buildClaimViewModel,
  CLAIM_INITIAL,
  type ClaimEvent,
  type ClaimModelState,
  type ClaimViewModel,
  claimStep,
} from './claimModel';
import { ClaimView } from './claimView';
import { CATALOG_EN } from './i18n/catalog.en';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS } from './overlayRegistry';
import { buildPrivacyViewModel, type PrivacyViewModel } from './privacyBanner';
import {
  type DeletionCountdown,
  deriveDeletionCountdown,
  PRIVACY_INITIAL,
  type PrivacyEvent,
  type PrivacyModelState,
  privacyStep,
} from './privacyModel';
import { PrivacyView } from './privacyView';
import { ProfileView } from './profileView';
import { RenameView } from './renameView';
import type { RowOp } from './screens/profileScreen';

vi.mock('./overlayA11y', { spy: true });

/** One REAL macrotask (the deferred anchor is a setTimeout(…, 0); never fake timers). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function sweep(): Promise<void> {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flush();
}

beforeEach(async () => {
  await sweep();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(async () => {
  await sweep();
  document.body.innerHTML = '';
});

/** A plain English catalogue message, or a loud failure (a missing key must not read as ''). */
function en(key: string): string {
  const value = (CATALOG_EN as unknown as Readonly<Record<string, unknown>>)[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`catalog.en has no plain, non-empty message for '${key}'`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// The frame under test: the real three sections, behind the real frame.
// ---------------------------------------------------------------------------------------------

const CLAIM_HANDLERS = [
  'onSignIn',
  'onJoin',
  'onDeclineRequested',
  'onDeclineConfirmed',
  'onDeclineCancelled',
  'onDismissed',
] as const;
type ClaimHandlerName = (typeof CLAIM_HANDLERS)[number];

const PRIVACY_HANDLERS = [
  'onDeleteRequested',
  'onDeleteConfirmed',
  'onConfirmCancelled',
  'onCancelDeletion',
  'onExportRequested',
  'onExportDownload',
  'onDismissed',
] as const;
type PrivacyHandlerName = (typeof PRIVACY_HANDLERS)[number];

type Spy = ReturnType<typeof vi.fn<() => void>>;

interface Built {
  readonly profile: ProfileView;
  readonly rename: RenameView;
  readonly claim: ClaimView;
  readonly privacy: PrivacyView;
  readonly onSubmit: ReturnType<typeof vi.fn<(name: string) => Promise<void>>>;
  readonly claimH: Readonly<Record<ClaimHandlerName, Spy>>;
  readonly privacyH: Readonly<Record<PrivacyHandlerName, Spy>>;
  readonly root: () => HTMLElement;
  readonly outside: HTMLButtonElement;
}

/** The new index.html's shape for what the frame needs: the frame layer and the static Name
 *  section (no role, no aria-modal, `mr-button-rows`), plus a focusable OUTSIDE the frame. */
function mountShell(): void {
  document.body.innerHTML = `
    <div id="game-screen">
      <div id="app"></div>
      <div id="frame-layer">
        <div id="rename-overlay" class="mr-button-rows" style="display:none">
          <div id="rename-current" data-testid="rename-current"></div>
          <input id="rename-input" data-testid="rename-input" type="text" maxlength="24" />
          <button id="rename-submit" data-testid="rename-submit" type="button"></button>
        </div>
      </div>
    </div>
    <button id="profile-test-outside" type="button">outside</button>
  `;
}

function build(): Built {
  mountShell();
  const onSubmit = vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined);
  const rename = new RenameView({ onSubmit });
  const claimH = Object.fromEntries(CLAIM_HANDLERS.map((n) => [n, vi.fn<() => void>()])) as Record<
    ClaimHandlerName,
    Spy
  >;
  const claim = new ClaimView(claimH);
  const privacyH = Object.fromEntries(
    PRIVACY_HANDLERS.map((n) => [n, vi.fn<() => void>()]),
  ) as Record<PrivacyHandlerName, Spy>;
  // main.ts wires the frame's Close as privacy's fallback row (plan § Sections, privacy).
  let frame: ProfileView | undefined;
  const privacy = new PrivacyView({ ...privacyH, fallbackRow: () => frame?.closeRow });
  frame = new ProfileView({ name: rename, account: claim, privacy });
  const outside = document.getElementById('profile-test-outside') as HTMLButtonElement;
  return {
    profile: frame,
    rename,
    claim,
    privacy,
    onSubmit,
    claimH,
    privacyH,
    root: () => {
      const root = document.getElementById('profile-overlay');
      if (root === null) throw new Error('#profile-overlay must exist once ProfileView is built');
      return root;
    },
    outside,
  };
}

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} must exist`);
  return el;
};
const ids = (els: readonly HTMLElement[]): string[] => els.map((e) => e.id);
const focusedId = (): string => (document.activeElement as HTMLElement | null)?.id ?? '';
const blurAll = (): void => (document.activeElement as HTMLElement | null)?.blur();
const move = (delta: -1 | 1): RowOp => ({ kind: 'move', delta });
const activate = (): RowOp => ({ kind: 'activate' });

/** The names of the handlers that fired. */
function fired(b: Built): string[] {
  return [
    ...(b.onSubmit.mock.calls.length > 0 ? ['onSubmit'] : []),
    ...CLAIM_HANDLERS.filter((n) => b.claimH[n].mock.calls.length > 0).map((n) => `claim.${n}`),
    ...PRIVACY_HANDLERS.filter((n) => b.privacyH[n].mock.calls.length > 0).map(
      (n) => `privacy.${n}`,
    ),
  ];
}

function clearHandlers(b: Built): void {
  b.onSubmit.mockClear();
  for (const n of CLAIM_HANDLERS) b.claimH[n].mockClear();
  for (const n of PRIVACY_HANDLERS) b.privacyH[n].mockClear();
}

/** Paint the Name section with `draft` typed into the field (the input event refreshes Save). */
function paintName(b: Built, draft: string): void {
  const input = byId('rename-input') as HTMLInputElement;
  input.value = draft;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  b.rename.render({
    displayCurrentName: 'Wanderer',
    trimmedDraft: draft.trim(),
    canSubmit: draft.trim() !== '',
  });
}

/** The focused control is a usable anchor: inside the frame, enabled, and on screen up to the
 *  root (happy-dom would happily "focus" a disabled or hidden node). */
function expectUsableFocus(root: HTMLElement, label: string): HTMLElement {
  const active = document.activeElement;
  expect(
    active instanceof HTMLElement && active !== root && root.contains(active),
    `${label}: focus is on a control inside the frame (got ${focusedId() || 'the page'})`,
  ).toBe(true);
  const el = active as HTMLElement;
  expect(
    (el as HTMLButtonElement | HTMLInputElement).disabled === true,
    `${label}: #${el.id} is not disabled`,
  ).toBe(false);
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    expect(
      node.style.display,
      `${label}: #${el.id}: ${node.id || node.tagName} is not display:none`,
    ).not.toBe('none');
    if (node === root) break;
  }
  return el;
}

/** The nearest display:none ancestor (the node included), or null when on screen to <body>. */
function hiddenAncestorOf(start: Element | null): string | null {
  for (let node: Element | null = start; node instanceof HTMLElement; node = node.parentElement) {
    if (node.style.display === 'none') return node.id === '' ? node.tagName : `#${node.id}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Phases, reached by running the real reducers.
// ---------------------------------------------------------------------------------------------

const OPENED: ClaimEvent = { kind: 'claim-ui-opened', nudgeAlreadySeen: true };

function claimAfter(...events: ClaimEvent[]): ClaimModelState {
  let state: ClaimModelState = CLAIM_INITIAL;
  for (const event of events) state = claimStep(state, event).next;
  return state;
}

const rejected = (message: string): ClaimEvent => ({
  kind: 'claim-rejected',
  message,
  claimedFrom: undefined,
});

/** Every visible claim phase (the claimView.test.ts CLAIM_PHASES set). */
const CLAIM_PHASES: ReadonlyArray<readonly [string, ClaimModelState]> = [
  ['prompt', claimAfter(OPENED)],
  ['prompt + nudge', claimAfter({ kind: 'claim-ui-opened', nudgeAlreadySeen: false })],
  ['code-pending', claimAfter(OPENED, { kind: 'claim-pending', code: 'c0de' })],
  ['awaiting-account', claimAfter(OPENED, { kind: 'claim-awaiting-account' })],
  ['rejected: dead code', claimAfter(OPENED, rejected('code expired'))],
  ['rejected: terminal', claimAfter(OPENED, rejected('account already claimed'))],
  ['rejected: transient', claimAfter(OPENED, rejected('close your other tab, then retry'))],
  ['rejected: other', claimAfter(OPENED, rejected('sign in required'))],
  ['sign-in-failed', claimAfter(OPENED, { kind: 'sign-in-failed', reason: 'sign-in-rejected' })],
  ['sign-in-failed, unknown', claimAfter(OPENED, { kind: 'sign-in-failed', reason: 'new' })],
  ['claimed', claimAfter(OPENED, { kind: 'claim-succeeded' })],
  ['decline armed', claimAfter(OPENED, { kind: 'decline-requested' })],
];

const PROMPT_VM = buildClaimViewModel(claimAfter(OPENED));
const ARMED_VM = buildClaimViewModel(claimAfter(OPENED, { kind: 'decline-requested' }));
const CLAIMED_VM = buildClaimViewModel(claimAfter(OPENED, { kind: 'claim-succeeded' }));

const GRACE_MS = 90_000n;
function countdown(
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
    graceMs: GRACE_MS,
  });
}
const ACTIVE = countdown('Active', undefined, undefined, 30_000n);
const GRACE = countdown('PendingDeletion', 0n, undefined, 30_000n);
const TERMINAL = countdown('PendingDeletion', 0n, 0n, 60_000n);

function privacyAfter(events: readonly PrivacyEvent[]): PrivacyModelState {
  let state: PrivacyModelState = PRIVACY_INITIAL;
  for (const event of events) state = privacyStep(state, event).next;
  return state;
}

/** Synthetic privacy view model (an exact enable/disable combination). */
function pvm(overrides: Partial<PrivacyViewModel> = {}): PrivacyViewModel {
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
    exportStatusLabel: undefined,
    downloadLabel: 'SYNTHETIC DOWNLOAD',
    downloadEnabled: false,
    ...overrides,
  };
}
const P_ARMED = 'SYNTHETIC ARE YOU SURE';
const P_REFUSED = pvm({
  deleteEnabled: false,
  cancelEnabled: false,
  exportEnabled: false,
  downloadEnabled: false,
});

/** Every privacy shape the matrix needs: the model's phases, plus one synthetic shape in which
 *  every control is refused (the Close fallback must then hold the anchor). */
const PRIVACY_PHASES: ReadonlyArray<readonly [string, PrivacyViewModel]> = [
  ['dark: no account row', buildPrivacyViewModel(PRIVACY_INITIAL)],
  ['active', buildPrivacyViewModel(privacyAfter([{ kind: 'account-changed', countdown: ACTIVE }]))],
  ['grace', buildPrivacyViewModel(privacyAfter([{ kind: 'account-changed', countdown: GRACE }]))],
  [
    'terminal',
    buildPrivacyViewModel(privacyAfter([{ kind: 'account-changed', countdown: TERMINAL }])),
  ],
  [
    'active + delete armed',
    buildPrivacyViewModel(
      privacyAfter([{ kind: 'account-changed', countdown: ACTIVE }, { kind: 'delete-requested' }]),
    ),
  ],
  [
    'grace + disconnected',
    buildPrivacyViewModel(
      privacyAfter([
        { kind: 'account-changed', countdown: GRACE },
        { kind: 'cancel-deletion-requested', hasLiveConnection: false },
      ]),
    ),
  ],
  [
    'grace + a plain rejection',
    buildPrivacyViewModel(
      privacyAfter([
        { kind: 'account-changed', countdown: GRACE },
        { kind: 'export-requested', hasLiveConnection: true },
        { kind: 'request-failed', which: 'export', message: 'export is rate limited' },
      ]),
    ),
  ],
  ['synthetic: every control refused', P_REFUSED],
];

// =============================================================================================
// UIF16B.1 — one screen, three sections, headers and separators from tokens.
// =============================================================================================

describe('ProfileView (uif-16b): one frame holding the Name, Account and Privacy sections', () => {
  it('UIF16B.1 one #profile-overlay in #frame-layer (mr-frame mr-shell) whose children are exactly the title bar and #profile-body (mr-frame-body, not mr-scroll), the body holding the Name, Account and Privacy section roots and the close row, in that order', () => {
    // INTENTIONAL CHANGE (uif-16b, kit frame anatomy "title bar -> body (grows, scrolls)"): a
    // browser run measured the three sections ~170px taller than the frame at 1280x720, so the
    // sections and the close row moved from the root into a scrolling `#profile-body`. Was: the
    // root's children were [title bar, the three sections, the close row].
    // WRONG IMPL KILLED: three separate overlays (the sections left where they were built); a
    // frame appended to <body> instead of the frame layer; sections in another order (Privacy
    // above Account); the close row above a section; a title bar missing or after the sections;
    // a second frame root (two `#profile-overlay`s); sections left directly in the root (the
    // column overflows the frame and Close falls off screen); a body that does not scroll.
    const b = build();
    const root = b.root();
    expect(document.querySelectorAll('#profile-overlay').length, 'one frame root').toBe(1);
    expect(root.parentElement?.id, 'the frame lives in the frame layer').toBe('frame-layer');
    expect(root.classList.contains('mr-frame'), 'the frame carries mr-frame').toBe(true);
    expect(root.classList.contains('mr-shell'), 'the frame carries mr-shell').toBe(true);
    const children = Array.from(root.children) as HTMLElement[];
    expect(children[0]?.classList.contains('mr-frame-titlebar'), 'the title bar leads').toBe(true);
    expect(
      children[0]?.querySelector('#profile-title'),
      'the bar holds #profile-title',
    ).not.toBeNull();
    expect(children.length, 'the root holds exactly the title bar and the body').toBe(2);
    expect(children[1]?.id, 'the body follows the title bar').toBe('profile-body');
    const body = byId('profile-body');
    expect(body.classList.contains('mr-frame-body'), 'the body carries mr-frame-body').toBe(true);
    // uif-16b (named change): NOT mr-scroll. Running text must not sit over the list cue's four
    // background gradients (the browser contrast gate refuses to measure text over a
    // background-image); `.mr-frame-body` alone already scrolls (overflow-y: auto).
    expect(body.classList.contains('mr-scroll'), 'the body does not carry mr-scroll').toBe(false);
    expect(
      ids(Array.from(body.children) as HTMLElement[]),
      'sections then the close row, nothing else',
    ).toEqual(['rename-overlay', 'claim-overlay', 'privacy-overlay', 'profile-close-row']);
    expect(
      ids(Array.from(byId('profile-close-row').children) as HTMLElement[]),
      'the close row holds the one Close button',
    ).toEqual(['profile-close-btn']);
    expect(byId('profile-close-btn').tagName, 'Close is a native button').toBe('BUTTON');
    expect(b.profile.closeRow, 'closeRow is #profile-close-btn').toBe(byId('profile-close-btn'));
  });

  it('UIF16B.1 show() writes the frame title (menu.profile.title) and the Close label (privacy.close) on every call, and #privacy-close-btn no longer exists', () => {
    // WRONG IMPL KILLED: no title, or one hard-coded / written once in the constructor (a repeat
    // show() after a stale write keeps it stale); Close unlabelled; the retired privacy close
    // anchor still shipped (two Close rows in one column).
    const b = build();
    const title = byId('profile-title');
    expect(title.classList.contains('mr-frame-title'), 'frame-chrome title class').toBe(true);
    b.profile.show('account');
    expect(title.textContent).toBe(en('menu.profile.title'));
    expect(b.profile.closeRow.textContent).toBe(en('privacy.close'));
    title.textContent = 'stale';
    b.profile.closeRow.textContent = 'stale';
    b.profile.show('account');
    expect(title.textContent, 'a repeat show() rewrites the title').toBe(en('menu.profile.title'));
    expect(b.profile.closeRow.textContent, 'and the Close label').toBe(en('privacy.close'));
    expect(document.getElementById('privacy-close-btn'), 'the privacy close anchor retired').toBe(
      null,
    );
  });

  it('UIF16B.1 each section leads with an h2.mr-section-header carrying its catalogue title, as its first element child', () => {
    // WRONG IMPL KILLED: the old frame title bars kept (a `div.mr-frame-titlebar` per section: a
    // frame inside a frame); a header that is a div, misses the class, or sits after the
    // controls; the frame title reused for a section; a header text hard-coded.
    const b = build();
    b.profile.show('account');
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['rename-overlay', 'rename-title', 'menu.profile.name.title'],
      ['claim-overlay', 'claim-frame-title', 'menu.profile.account.title'],
      ['privacy-overlay', 'privacy-title', 'privacy.title'],
    ];
    for (const [sectionId, headerId, key] of cases) {
      const header = byId(headerId);
      expect(byId(sectionId).firstElementChild, `#${headerId} leads #${sectionId}`).toBe(header);
      expect(header.tagName, `#${headerId} is an h2`).toBe('H2');
      expect(header.classList.contains('mr-section-header'), `#${headerId} class`).toBe(true);
      expect(header.classList.contains('mr-frame-title'), `#${headerId} is not frame chrome`).toBe(
        false,
      );
      expect(header.textContent, `#${headerId} text`).toBe(en(key));
      expect(hiddenAncestorOf(header), `#${headerId} is on screen`).toBeNull();
    }
    expect(
      b.root().querySelectorAll('.mr-frame-titlebar').length,
      'one title bar in the whole frame: the sections carry none',
    ).toBe(1);
  });

  it('UIF16B.1 the Account and Privacy sections and the close row carry an inline token separator (--mr-border-thin, --mr-separator), the Name section does not', () => {
    // WRONG IMPL KILLED: no separators (three sections read as one list); a literal colour or
    // width instead of the tokens; a separator above the first section too (a line under the
    // title bar's own border); one missing above the close row.
    const b = build();
    b.profile.show('account');
    const inline = (id: string): string =>
      `${byId(id).getAttribute('style') ?? ''} ${byId(id).style.cssText}`;
    for (const id of ['claim-overlay', 'privacy-overlay', 'profile-close-row']) {
      expect(inline(id), `#${id} references --mr-separator`).toContain('--mr-separator');
      expect(inline(id), `#${id} references --mr-border-thin`).toContain('--mr-border-thin');
    }
    expect(inline('rename-overlay'), 'the first section has no separator').not.toContain(
      '--mr-separator',
    );
  });

  it('UIF16B.1 the section roots carry mr-button-rows and none of mr-frame / mr-shell, and no role or aria-modal of their own', () => {
    // WRONG IMPL KILLED: a section still styled as a frame (a bordered absolute shell inside the
    // shell); a section without the column class (its buttons flow in a row: the D-pad axis would
    // not match the layout, 102); a section that keeps its static dialog role.
    const b = build();
    b.profile.show('account');
    for (const id of ['rename-overlay', 'claim-overlay', 'privacy-overlay']) {
      const el = byId(id);
      expect(el.classList.contains('mr-button-rows'), `#${id}: mr-button-rows`).toBe(true);
      expect(el.classList.contains('mr-frame'), `#${id}: not mr-frame`).toBe(false);
      expect(el.classList.contains('mr-shell'), `#${id}: not mr-shell`).toBe(false);
      expect(el.hasAttribute('role'), `#${id}: no role`).toBe(false);
      expect(el.hasAttribute('aria-modal'), `#${id}: no aria-modal`).toBe(false);
    }
    expect(byId('profile-close-row').classList.contains('mr-button-rows')).toBe(true);
  });

  it('UIF16B.1 show() shows the frame and all three sections at once; hide() hides the frame and every section', async () => {
    // WRONG IMPL KILLED: a frame that shows only the chosen section (the sub-list in disguise);
    // a hide() that only hides the root (a section left `display:block` re-appears alone the
    // next time its view is shown); a `visible` that reads a shadow field.
    const b = build();
    // The sections' controls show once painted: the claim prompt's rows, the privacy controls.
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    expect(b.profile.visible, 'constructed hidden').toBe(false);
    for (const section of ['name', 'account', 'privacy'] as const) {
      b.profile.show(section);
      expect(b.profile.visible, `${section}: visible`).toBe(true);
      // uif-16b (named change): 'block' -> 'flex'. Measured in Chromium: an inline `display: block`
      // overrides `.mr-frame`'s flex column, so #profile-body gets no bounded height and the whole
      // shell scrolls instead of the body. An open root is inline flex (hidden: none).
      expect(b.root().style.display, `${section}: the root is flex`).toBe('flex');
      for (const id of [
        'rename-overlay',
        'claim-overlay',
        'privacy-overlay',
        'profile-close-row',
      ]) {
        expect(hiddenAncestorOf(byId(id)), `${section}: #${id} on screen`).toBeNull();
      }
      for (const id of [
        'rename-input',
        'claim-signin-btn',
        'privacy-export-btn',
        'profile-close-btn',
      ]) {
        expect(hiddenAncestorOf(byId(id)), `${section}: #${id} on screen`).toBeNull();
      }
      await flush();
      b.profile.hide();
      expect(b.profile.visible, `${section}: hidden again`).toBe(false);
      expect(b.root().style.display).toBe('none');
      for (const id of ['rename-overlay', 'claim-overlay', 'privacy-overlay']) {
        expect(byId(id).style.display, `${section}: hide() hid #${id}`).toBe('none');
      }
    }
  });
});

// =============================================================================================
// UIF16B.2 — one column of rows in visual order, Close last, clamped.
// =============================================================================================

describe('ProfileView (uif-16b): one column of rows', () => {
  it('UIF16B.2 sectionRows() is the Name rows, then the Account rows, then the Privacy rows, then Close, in several claim and privacy phases (exact arrays)', () => {
    // WRONG IMPL KILLED: only the chosen section's rows (a section-scoped walk); sections
    // concatenated in another order; Close missing, first, or duplicated; a hidden or disabled
    // control in the column; rows cached at show() instead of read afresh after a render.
    const b = build();
    b.profile.show('account');
    const cases: ReadonlyArray<{
      label: string;
      draft: string;
      claim: ClaimViewModel;
      privacy: PrivacyViewModel;
      want: readonly string[];
    }> = [
      {
        label: 'empty draft, sign-in prompt, privacy idle',
        draft: '',
        claim: PROMPT_VM,
        privacy: pvm(),
        want: [
          'rename-input',
          'claim-signin-btn',
          'claim-decline-btn',
          'privacy-delete-btn',
          'privacy-cancel-btn',
          'privacy-export-btn',
          'profile-close-btn',
        ],
      },
      {
        label: 'a draft, decline armed, delete armed, download ready',
        draft: 'Bob',
        claim: ARMED_VM,
        privacy: pvm({ confirmPrompt: P_ARMED, downloadEnabled: true }),
        want: [
          'rename-input',
          'rename-submit',
          'claim-decline-confirm-btn',
          'claim-decline-cancel-btn',
          'privacy-delete-btn',
          'privacy-confirm-btn',
          'privacy-confirm-cancel-btn',
          'privacy-cancel-btn',
          'privacy-export-btn',
          'privacy-download-btn',
          'profile-close-btn',
        ],
      },
      {
        label: 'claimed, every privacy control refused',
        draft: '   ',
        claim: CLAIMED_VM,
        privacy: P_REFUSED,
        want: ['rename-input', 'claim-join-btn', 'profile-close-btn'],
      },
    ];
    for (const { label, draft, claim, privacy, want } of cases) {
      paintName(b, draft);
      b.claim.render(claim);
      b.privacy.render(privacy);
      expect(ids(b.profile.sectionRows()), label).toEqual(want);
    }
  });

  it('UIF16B.2 over every real claim phase x privacy phase the column is exactly name ++ account ++ privacy ++ [Close]', () => {
    // WRONG IMPL KILLED: a column that drops a section in some phase (an empty privacy section
    // that ends the column early, so Close is unreachable); a Close row that appears only when
    // the privacy section has no rows.
    const b = build();
    b.profile.show('account');
    let checked = 0;
    for (const [cLabel, cState] of CLAIM_PHASES) {
      for (const [pLabel, pVm] of PRIVACY_PHASES) {
        paintName(b, checked % 2 === 0 ? '' : 'Bob');
        b.claim.render(buildClaimViewModel(cState));
        b.privacy.render(pVm);
        expect(ids(b.profile.sectionRows()), `${cLabel} x ${pLabel}`).toEqual([
          ...ids(b.rename.sectionRows()),
          ...ids(b.claim.sectionRows()),
          ...ids(b.privacy.sectionRows()),
          'profile-close-btn',
        ]);
        checked += 1;
      }
    }
    expect(checked, 'ANTI-VACUITY: every pair').toBe(CLAIM_PHASES.length * PRIVACY_PHASES.length);
  });

  it('UIF16B.2 Down walks the whole column top to bottom across the section boundaries and clamps on Close; Up walks back and clamps on the field (no wrap at either end)', async () => {
    // WRONG IMPL KILLED: a walk that stops at a section boundary (Down from the last Account row
    // does nothing); a wrap (Down on Close lands on the field, Up on the field lands on Close); a walk
    // that skips a row or visits a hidden one.
    const b = build();
    paintName(b, '');
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    b.profile.show('name');
    await flush();
    expect(focusedId(), 'precondition: the field holds focus').toBe('rename-input');
    const column = ids(b.profile.sectionRows());
    const down: string[] = [];
    // column.length presses from row 0: every later row once, then one clamped press on Close.
    for (let i = 0; i < column.length; i += 1) {
      b.profile.applyRowOp(move(1));
      down.push(focusedId());
    }
    expect(down, 'down the column, then clamped on Close').toEqual([
      ...column.slice(1),
      'profile-close-btn',
    ]);
    const up: string[] = [];
    for (let i = 0; i < column.length; i += 1) {
      b.profile.applyRowOp(move(-1));
      up.push(focusedId());
    }
    expect(up, 'up the column, then clamped on the field').toEqual([
      ...column.slice(0, -1).reverse(),
      'rename-input',
    ]);
  });

  it('UIF16B.2 a token is applied once: the same object twice is one step, an equal fresh object is a new press', async () => {
    // WRONG IMPL KILLED: no identity memo (the host repaints after every step with the same
    // state, so one Down would walk two rows and one A would click twice); a memo by shape (a
    // second real Down is dropped).
    const b = build();
    paintName(b, '');
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    b.profile.show('name');
    await flush();
    const hop = move(1);
    b.profile.applyRowOp(hop);
    expect(focusedId(), 'the first application moves').toBe('claim-signin-btn');
    byId('rename-input').focus();
    b.profile.applyRowOp(hop);
    expect(focusedId(), 'the same object is not applied again').toBe('rename-input');
    b.profile.applyRowOp(move(1));
    expect(focusedId(), 'a fresh equal token moves').toBe('claim-signin-btn');

    const press = activate();
    b.profile.applyRowOp(press);
    b.profile.applyRowOp(press);
    expect(b.claimH.onSignIn, 'the same activate token clicks once').toHaveBeenCalledTimes(1);
    b.profile.applyRowOp(activate());
    expect(b.claimH.onSignIn, 'a fresh activate clicks again').toHaveBeenCalledTimes(2);
  });

  it('UIF16B.2 with no row focused a move or an A only seats the default row and presses nothing (the field unarmed, No while the decline is armed)', async () => {
    // WRONG IMPL KILLED: an A with focus on the page that presses the first row (a stray Enter
    // would act); a move from nothing that lands on the SECOND row; an armed frame that seats
    // the first row (one more A would then confirm nothing the player chose, or Save).
    const b = build();
    paintName(b, 'Bob');
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    b.profile.show('name');
    await flush();
    for (const op of [move(1), move(-1), activate()]) {
      blurAll();
      clearHandlers(b);
      b.profile.applyRowOp(op);
      expect(focusedId(), `${op.kind}: seats the field`).toBe('rename-input');
      expect(fired(b), `${op.kind}: presses nothing`).toEqual([]);
    }
    b.claim.render(ARMED_VM);
    for (const op of [move(1), activate()]) {
      blurAll();
      clearHandlers(b);
      b.profile.applyRowOp(op);
      expect(focusedId(), `armed ${op.kind}: seats No`).toBe('claim-decline-cancel-btn');
      expect(fired(b), `armed ${op.kind}: presses nothing`).toEqual([]);
    }
  });

  it('UIF16B.2 A on the name field presses nothing and keeps focus there; A on Save submits the trimmed draft once', async () => {
    // WRONG IMPL KILLED: a frame that clicks any pressed row (A on the field would submit the
    // draft mid-typing, or `click()` the input); a Save that sends the raw draft.
    const b = build();
    paintName(b, '  Bob  ');
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    b.profile.show('name');
    await flush();
    const clickSpy = vi.spyOn(byId('rename-input'), 'click');
    b.profile.applyRowOp(activate());
    expect(focusedId(), 'A on the field keeps focus on it').toBe('rename-input');
    expect(clickSpy, 'the field is never clicked').not.toHaveBeenCalled();
    expect(fired(b), 'nothing pressed').toEqual([]);
    clickSpy.mockRestore();
    b.profile.applyRowOp(move(1));
    expect(focusedId()).toBe('rename-submit');
    b.profile.applyRowOp(activate());
    await Promise.resolve();
    expect(b.onSubmit).toHaveBeenCalledTimes(1);
    expect(b.onSubmit).toHaveBeenCalledWith('Bob');
  });

  it('UIF16B.2 A on Close hides the frame (and every section)', async () => {
    // WRONG IMPL KILLED: a Close that is a dead row (pressing it does nothing); a Close wired to
    // privacy's own hide (the frame stays open over a hidden privacy section).
    const b = build();
    paintName(b, '');
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    b.profile.show('name');
    await flush();
    b.profile.closeRow.focus();
    b.profile.applyRowOp(activate());
    expect(b.profile.visible, 'the frame is hidden').toBe(false);
    for (const id of ['rename-overlay', 'claim-overlay', 'privacy-overlay']) {
      expect(byId(id).style.display, `#${id} hidden`).toBe('none');
    }
  });

  it('UIF16B.2 sectionOf() names the section that holds an element, and none for Close or the page', () => {
    // WRONG IMPL KILLED: a lookup by id prefix (a claim row reads as Privacy);
    // Close attributed to Privacy (the accelerator rule would read focus "in Privacy").
    const b = build();
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    b.profile.show('account');
    expect(b.profile.sectionOf(byId('rename-input'))).toBe('name');
    expect(b.profile.sectionOf(byId('rename-submit'))).toBe('name');
    expect(b.profile.sectionOf(byId('claim-decline-btn')), 'Decline is in Account').toBe('account');
    expect(b.profile.sectionOf(byId('privacy-export-btn'))).toBe('privacy');
    expect(b.profile.sectionOf(b.profile.closeRow), 'Close is no section').toBeUndefined();
    expect(b.profile.sectionOf(b.outside), 'the page is no section').toBeUndefined();
    expect(b.profile.sectionOf(null)).toBeUndefined();
  });
});

// =============================================================================================
// UIF16B.3 — one dialog, one trap, one title, one valid anchor in every phase.
// =============================================================================================

describe('ProfileView (uif-16b): one dialog, one trap, one anchor', () => {
  it('UIF16B.3 while open exactly one element is a dialog (the frame root, labelled from a11yCopy) and no section root is; hide() strips all three attributes and returns focus to where it was', async () => {
    // WRONG IMPL KILLED: sections that still open their own a11y (two or three dialogs, two
    // traps that cannot coexist); a root labelled with a section's name; a hand-written
    // attribute cheat (the helper call count); a hide() that leaves the root claiming to be a
    // dialog, or a guarded close.
    const b = build();
    b.outside.focus();
    b.profile.show('name');
    const root = b.root();
    expect(Array.from(document.querySelectorAll('[role="dialog"]'))).toEqual([root]);
    expect(Array.from(document.querySelectorAll('[aria-modal]'))).toEqual([root]);
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.getAttribute('aria-label')).toBe(copyT(OVERLAY_A11Y.profileView.labelKey));
    expect(vi.mocked(openOverlayA11y).mock.calls.map((c) => c[0])).toEqual(['profileView']);
    expect(vi.mocked(openOverlayA11y).mock.calls[0]?.[1]).toBe(root);
    await flush();

    b.profile.hide();
    expect(root.getAttribute('role')).toBeNull();
    expect(root.getAttribute('aria-modal')).toBeNull();
    expect(root.getAttribute('aria-label')).toBeNull();
    expect(document.querySelectorAll('[role="dialog"]').length, 'no dialog left').toBe(0);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith('profileView', null);
    expect(document.activeElement, 'focus returns to the pre-open element').toBe(b.outside);

    // Unguarded: a hide() on a hidden frame still closes (the self-healing path).
    vi.mocked(closeOverlayA11y).mockClear();
    b.profile.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith('profileView', null);
  });

  it('UIF16B.3 the trap is the root`s: Tab from Close (the last row) wraps to the field, Shift+Tab from the field wraps to Close', async () => {
    // WRONG IMPL KILLED: a trap installed on a section root (Close is outside every section, so
    // Tab from it would escape the dialog); no trap at all.
    const b = build();
    paintName(b, '');
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    b.profile.show('name');
    await flush();
    b.profile.closeRow.focus();
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      code: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    b.profile.closeRow.dispatchEvent(tab);
    expect(tab.defaultPrevented, 'the trap handled Tab').toBe(true);
    expect(focusedId(), 'Tab from Close wraps to the first control of the frame').toBe(
      'rename-input',
    );
    const back = new KeyboardEvent('keydown', {
      key: 'Tab',
      code: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    byId('rename-input').dispatchEvent(back);
    expect(focusedId(), 'Shift+Tab from the field wraps to Close').toBe('profile-close-btn');
  });

  it("UIF16B.3 show('name') leaves the anchor to the deferred focus: not synchronously, #rename-input one macrotask later", async () => {
    // WRONG IMPL KILLED: a synchronous focus of the field (the KeyN that opened Profile would be
    // typed into the field it just opened); a focus on the frame's first BUTTON; no focus at all.
    const b = build();
    paintName(b, '');
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    b.outside.focus();
    b.profile.show('name');
    expect(document.activeElement, 'not synchronously').toBe(b.outside);
    await flush();
    expect(focusedId(), 'one macrotask later: the field').toBe('rename-input');
    expectUsableFocus(b.root(), 'name');
  });

  it("UIF16B.3 show('account') and show('privacy') seat that section's default row synchronously, and it stays after the macrotask", async () => {
    // WRONG IMPL KILLED: a show(section) that ignores the section (the deferred anchor pulls the
    // player to the Name field); a section focus done inside the timer (a key pressed in the gap
    // lands on the page); a deferred anchor that overrides the section focus a tick later.
    for (const [section, want] of [
      ['account', 'claim-signin-btn'],
      ['privacy', 'privacy-delete-btn'],
    ] as const) {
      await sweep();
      const b = build();
      paintName(b, '');
      b.claim.render(PROMPT_VM);
      b.privacy.render(pvm());
      b.outside.focus();
      b.profile.show(section);
      expect(focusedId(), `${section}: synchronously`).toBe(want);
      await flush();
      expect(focusedId(), `${section}: still there after the deferred anchor`).toBe(want);
      expectUsableFocus(b.root(), section);
    }
  });

  it('UIF16B.3 a second show() on a visible frame moves no focus and does not re-open, whatever section it names; focusSection() moves to a section on demand', async () => {
    // WRONG IMPL KILLED: an unguarded open (a repeat show re-schedules the deferred anchor and
    // yanks the player to the field); a repeat show(section) that focuses that section (a claim
    // event repainting Profile would pull a player out of the Name field).
    const b = build();
    paintName(b, '');
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    b.profile.show('name');
    await flush();
    b.profile.closeRow.focus();
    for (const section of ['name', 'account', 'privacy'] as const) {
      b.profile.show(section);
      await flush();
      expect(focusedId(), `a repeat show('${section}') moves nothing`).toBe('profile-close-btn');
    }
    expect(
      vi.mocked(openOverlayA11y).mock.calls.filter((c) => c[0] === 'profileView').length,
      'opened once',
    ).toBe(1);
    b.profile.focusSection('privacy');
    expect(focusedId(), 'focusSection(privacy): its default row').toBe('privacy-delete-btn');
    b.profile.focusSection('account');
    expect(focusedId(), 'focusSection(account): its default row').toBe('claim-signin-btn');
  });

  it('every open of the frame reads from the top of its body, whatever offset the last open left, and a repeat show() keeps the offset', async () => {
    // WRONG IMPL KILLED: a body that keeps the last open's scroll offset (Profile opened on
    // Account shows the Name section half scrolled off the top, measured in Chromium by
    // e2e/a11y.spec.ts's axe scan); a reset on every show(), which would jump a frame that is
    // already open whenever a claim event repaints it.
    const b = build();
    paintName(b, '');
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    const body = byId('profile-body');
    b.profile.show('name');
    await flush();
    body.scrollTop = 40;
    expect(body.scrollTop, 'ANTI-VACUITY: the body takes a scroll offset').toBe(40);
    b.profile.show('account');
    expect(body.scrollTop, 'a repeat show() on the open frame keeps the offset').toBe(40);
    b.profile.hide();
    for (const section of ['account', 'name', 'privacy'] as const) {
      b.profile.show(section);
      await flush();
      expect(body.scrollTop, `opened on ${section}: the body is at its top`).toBe(0);
      body.scrollTop = 40;
      b.profile.hide();
    }
  });

  it('UIF16B.3 the opening anchor is shown and enabled in EVERY claim phase x privacy phase x section; Privacy falls back to Close when it has no enabled row', async () => {
    // WRONG IMPL KILLED: a privacy anchor that is a disabled Delete (grace/terminal: focus on a
    // dead control, the trap has nothing to hand on); a privacy section with no rows that leaves
    // focus on the page; an account anchor on a hidden button (an armed decline hides Decline);
    // a name anchor that a claim phase displaces.
    let checked = 0;
    let fellBack = 0;
    for (const section of ['name', 'account', 'privacy'] as const) {
      for (const [cLabel, cState] of CLAIM_PHASES) {
        for (const [pLabel, pVm] of PRIVACY_PHASES) {
          await sweep();
          document.body.innerHTML = '';
          const b = build();
          paintName(b, '');
          b.claim.render(buildClaimViewModel(cState));
          b.privacy.render(pVm);
          b.outside.focus();
          b.profile.show(section);
          await flush();
          const label = `${section} / ${cLabel} / ${pLabel}`;
          const el = expectUsableFocus(b.root(), label);
          const want =
            section === 'name'
              ? byId('rename-input')
              : section === 'account'
                ? (b.claim.defaultRow() ?? b.profile.closeRow)
                : (b.privacy.defaultRow() ?? b.profile.closeRow);
          expect(el, `${label}: the section's anchor`).toBe(want);
          if (section === 'privacy' && b.privacy.sectionRows().length === 0) {
            expect(el.id, `${label}: no privacy row, so Close`).toBe('profile-close-btn');
            fellBack += 1;
          }
          checked += 1;
        }
      }
    }
    expect(checked, 'ANTI-VACUITY: every combination').toBe(
      3 * CLAIM_PHASES.length * PRIVACY_PHASES.length,
    );
    expect(fellBack, 'ANTI-VACUITY: the Close fallback was exercised').toBeGreaterThanOrEqual(
      CLAIM_PHASES.length,
    );
  });
});

// =============================================================================================
// UIF16B.4 — same commands, same guards.
// =============================================================================================

describe('ProfileView (uif-16b): the same commands through the same handlers', () => {
  it('UIF16B.4 clicking each control fires its own handler once and nothing else: Save (trimmed draft), the five claim actions, the six privacy actions', async () => {
    // WRONG IMPL KILLED: a frame that rebuilds the controls and drops their listeners; two
    // controls wired to one handler (Keep confirming the deletion); a Save that sends the raw
    // draft.
    const b = build();
    b.profile.show('account');
    const press = (id: string, want: string, setup: () => void): void => {
      setup();
      clearHandlers(b);
      expect(hiddenAncestorOf(byId(id)), `#${id} is on screen before the click`).toBeNull();
      byId(id).click();
      expect(fired(b), `#${id}`).toEqual([want]);
    };
    paintName(b, '  Bob  ');
    clearHandlers(b);
    byId('rename-submit').click();
    await Promise.resolve();
    expect(b.onSubmit).toHaveBeenCalledWith('Bob');
    expect(fired(b)).toEqual(['onSubmit']);
    const claimShows = (vm: ClaimViewModel) => () => b.claim.render(vm);
    press('claim-signin-btn', 'claim.onSignIn', claimShows(PROMPT_VM));
    press('claim-decline-btn', 'claim.onDeclineRequested', claimShows(PROMPT_VM));
    press('claim-join-btn', 'claim.onJoin', claimShows(CLAIMED_VM));
    press('claim-decline-confirm-btn', 'claim.onDeclineConfirmed', claimShows(ARMED_VM));
    press('claim-decline-cancel-btn', 'claim.onDeclineCancelled', claimShows(ARMED_VM));
    const privacyShows = (vm: PrivacyViewModel) => () => b.privacy.render(vm);
    press('privacy-delete-btn', 'privacy.onDeleteRequested', privacyShows(pvm()));
    press(
      'privacy-confirm-btn',
      'privacy.onDeleteConfirmed',
      privacyShows(pvm({ confirmPrompt: P_ARMED })),
    );
    press(
      'privacy-confirm-cancel-btn',
      'privacy.onConfirmCancelled',
      privacyShows(pvm({ confirmPrompt: P_ARMED })),
    );
    press('privacy-cancel-btn', 'privacy.onCancelDeletion', privacyShows(pvm()));
    press('privacy-export-btn', 'privacy.onExportRequested', privacyShows(pvm()));
    press(
      'privacy-download-btn',
      'privacy.onExportDownload',
      privacyShows(pvm({ downloadEnabled: true })),
    );
  });

  it('UIF16B.4 hide() calls privacy`s onDismissed AND claim`s onDismissed exactly once each and clears the rename draft, on hide() and on the Close button alike', async () => {
    // WRONG IMPL KILLED: a frame hide that only hides its root (privacy stays armed behind a
    // closed frame; an armed decline survives the close, reachable from the field next time); a
    // dismissal fired twice (once by the frame, once by the section); a stale draft that
    // survives a re-open.
    for (const how of ['hide()', 'the Close button'] as const) {
      await sweep();
      const b = build();
      b.claim.render(ARMED_VM);
      b.privacy.render(pvm({ confirmPrompt: P_ARMED }));
      b.profile.show('name');
      await flush();
      (byId('rename-input') as HTMLInputElement).value = 'Draft';
      clearHandlers(b);
      if (how === 'hide()') b.profile.hide();
      else b.profile.closeRow.click();
      expect(b.privacyH.onDismissed, `${how}: privacy dismissed once`).toHaveBeenCalledTimes(1);
      expect(b.claimH.onDismissed, `${how}: claim dismissed once`).toHaveBeenCalledTimes(1);
      expect(fired(b), `${how}: nothing else`).toEqual([
        'claim.onDismissed',
        'privacy.onDismissed',
      ]);
      expect((byId('rename-input') as HTMLInputElement).value, `${how}: draft cleared`).toBe('');
      expect(b.profile.visible).toBe(false);
    }
  });

  it('UIF16B.4 in the open frame arming the decline seats No and disarming seats Decline; arming delete seats Keep and disarming seats Delete', async () => {
    // WRONG IMPL KILLED: a section reseat that stopped running inside the frame (the arm edge
    // hides Decline under focus: focus falls to the page); a reseat onto Confirm (one more Enter
    // confirms); a disarm that seats the first row of the column.
    const b = build();
    paintName(b, '');
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    b.profile.show('account');
    byId('claim-decline-btn').focus();
    b.claim.render(ARMED_VM);
    expect(focusedId(), 'armed: No').toBe('claim-decline-cancel-btn');
    b.claim.render(PROMPT_VM);
    expect(focusedId(), 'disarmed: Decline').toBe('claim-decline-btn');

    byId('privacy-delete-btn').focus();
    b.privacy.render(pvm({ confirmPrompt: P_ARMED }));
    expect(focusedId(), 'armed: Keep').toBe('privacy-confirm-cancel-btn');
    b.privacy.render(pvm());
    expect(focusedId(), 'disarmed: Delete').toBe('privacy-delete-btn');
    expectUsableFocus(b.root(), 'after the disarm');
  });

  it('UIF16B.4 defaultRow() is the armed section`s No/Keep (privacy before account when both are armed), else the first row; armed mirrors the sections', () => {
    // WRONG IMPL KILLED: a default that always reads the first row (an armed frame re-shown with
    // focus on the page seats the field, and the armed Yes is one Down away); account preferred
    // over privacy (the irreversible deletion's Keep must win); an `armed` that reads one section.
    const b = build();
    paintName(b, '');
    b.profile.show('account');
    const cases: ReadonlyArray<
      readonly [string, ClaimViewModel, PrivacyViewModel, string, boolean, boolean, boolean]
    > = [
      ['nothing armed', PROMPT_VM, pvm(), 'rename-input', false, false, false],
      ['decline armed', ARMED_VM, pvm(), 'claim-decline-cancel-btn', true, true, false],
      [
        'delete armed',
        PROMPT_VM,
        pvm({ confirmPrompt: P_ARMED }),
        'privacy-confirm-cancel-btn',
        true,
        false,
        true,
      ],
      [
        'both armed',
        ARMED_VM,
        pvm({ confirmPrompt: P_ARMED }),
        'privacy-confirm-cancel-btn',
        true,
        true,
        true,
      ],
    ];
    for (const [label, claimVm, privacyVm, want, armed, claimArmed, privacyArmed] of cases) {
      b.claim.render(claimVm);
      b.privacy.render(privacyVm);
      expect(b.profile.defaultRow()?.id, `${label}: defaultRow`).toBe(want);
      expect(b.profile.armed, `${label}: frame armed`).toBe(armed);
      expect(b.claim.armed, `${label}: claim armed`).toBe(claimArmed);
      expect(b.privacy.armed, `${label}: privacy armed`).toBe(privacyArmed);
      expect(b.rename.armed, `${label}: the Name section is never armed`).toBe(false);
    }
  });

  it('UIF16B.4 privacy fallbackRow: a render that disables the FOCUSED privacy control seats the frame`s Close, never the section`s first action; armed, it seats Keep', () => {
    // WRONG IMPL KILLED: the old reseat to the section's first row (Delete: a second Enter would
    // start an account deletion); a reseat to the retired close anchor (gone: focus falls to the
    // page and the trap has nothing to hand on); an armed confirm that falls back to Close
    // instead of Keep; a plain re-render that moves focus.
    const b = build();
    paintName(b, '');
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    b.profile.show('privacy');
    byId('privacy-export-btn').focus();
    b.privacy.render(pvm({ statusLabel: 'SYNTHETIC TICK' }));
    expect(focusedId(), 'a plain re-render moves nothing').toBe('privacy-export-btn');
    b.privacy.render(pvm({ exportEnabled: false }));
    expect(focusedId(), 'Export disabled under focus: the frame`s Close').toBe('profile-close-btn');
    expect(focusedId(), 'never Delete').not.toBe('privacy-delete-btn');
    expectUsableFocus(b.root(), 'fallback');

    b.privacy.render(pvm({ confirmPrompt: P_ARMED }));
    byId('privacy-export-btn').focus();
    b.privacy.render(pvm({ confirmPrompt: P_ARMED, exportEnabled: false }));
    expect(focusedId(), 'armed: Keep, not Close').toBe('privacy-confirm-cancel-btn');
  });
});

// =============================================================================================
// uif-16b red-team round: return focus after a section open, and entering an armed section.
// =============================================================================================

describe('ProfileView (uif-16b): red-team round', () => {
  it("UIF16B.3 show('account') / show('privacy') then hide() hands focus back to the element focused before the open", async () => {
    // WRONG IMPL KILLED (measured: 356 tests stayed green): seating the section's row BEFORE
    // `openOverlayA11y`, so the recorded return target is a button INSIDE the frame and the
    // close strands focus on a hidden node instead of the pre-open element.
    for (const section of ['account', 'privacy'] as const) {
      await sweep();
      const b = build();
      paintName(b, '');
      b.claim.render(PROMPT_VM);
      b.privacy.render(pvm());
      b.outside.focus();
      expect(document.activeElement, `${section}: precondition`).toBe(b.outside);
      b.profile.show(section);
      expect(b.root().contains(document.activeElement), `${section}: the open seated a row`).toBe(
        true,
      );
      await flush();
      b.profile.hide();
      expect(document.activeElement, `${section}: focus is back on the pre-open element`).toBe(
        b.outside,
      );
    }
  });

  it('UIF16B.4 a move that crosses INTO a section whose confirm is armed lands on its No / Keep, never its Yes; inside the section the walk is the plain row order; unarmed, a crossing lands on the first row', async () => {
    // WRONG IMPL KILLED: the plain column walk across an armed boundary (Down from Save lands on
    // the armed decline's Yes, so one more A confirms a decline the player never looked at; Down
    // from the last Account row lands on Delete's Confirm); a re-seat applied to every move (inside
    // an armed section Up from No must reach Yes); a blanket jump on every crossing (unarmed,
    // Down from Save must land on the first Account row).
    const armedClaim = buildClaimViewModel(claimAfter(OPENED, { kind: 'decline-requested' }));
    const armedPrivacy = buildPrivacyViewModel(
      privacyAfter([{ kind: 'account-changed', countdown: ACTIVE }, { kind: 'delete-requested' }]),
    );
    const b = build();
    paintName(b, 'Bob');
    b.claim.render(armedClaim);
    b.privacy.render(pvm());
    b.profile.show('name');
    await flush();
    expect(b.claim.armed, 'ANTI-VACUITY: the decline is armed').toBe(true);
    expect(ids(b.rename.sectionRows()), 'ANTI-VACUITY: Save is a row').toEqual([
      'rename-input',
      'rename-submit',
    ]);

    byId('rename-submit').focus();
    b.profile.applyRowOp(move(1));
    expect(focusedId(), 'Down from Save into the armed Account: No').toBe(
      'claim-decline-cancel-btn',
    );
    expect(focusedId(), 'never Yes').not.toBe('claim-decline-confirm-btn');
    b.profile.applyRowOp(move(-1));
    expect(focusedId(), 'inside the section, Up from No reaches Yes').toBe(
      'claim-decline-confirm-btn',
    );
    byId('claim-decline-cancel-btn').focus();
    b.profile.applyRowOp(move(1));
    expect(
      focusedId(),
      'Down from No, the last Account row, crosses into Privacy: its first row, Delete',
    ).toBe('privacy-delete-btn');

    // Delete armed too: Down from the last Account row into Privacy lands on Keep.
    b.privacy.render(armedPrivacy);
    expect(b.privacy.armed, 'ANTI-VACUITY: delete is armed').toBe(true);
    byId('claim-decline-cancel-btn').focus();
    b.profile.applyRowOp(move(1));
    expect(focusedId(), 'Down into the armed Privacy: Keep').toBe('privacy-confirm-cancel-btn');
    expect(focusedId(), 'never Confirm').not.toBe('privacy-confirm-btn');

    // Coming UP into the armed Account from the first privacy row also lands on No.
    const firstPrivacy = b.privacy.sectionRows()[0];
    expect(firstPrivacy, 'ANTI-VACUITY: privacy has rows').toBeDefined();
    firstPrivacy?.focus();
    b.profile.applyRowOp(move(-1));
    expect(focusedId(), 'Up into the armed Account: No').toBe('claim-decline-cancel-btn');

    // Unarmed: the plain order, the crossing lands on the first Account row.
    b.claim.render(PROMPT_VM);
    b.privacy.render(pvm());
    expect(b.claim.armed, 'ANTI-VACUITY: disarmed').toBe(false);
    byId('rename-submit').focus();
    b.profile.applyRowOp(move(1));
    expect(focusedId(), 'unarmed: Down from Save is the first Account row').toBe(
      'claim-signin-btn',
    );
  });
});
