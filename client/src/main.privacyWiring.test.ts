// @vitest-environment happy-dom
/**
 * main.privacyWiring.test.ts — the RUNTIME gate over `main.ts`'s privacy surface: the open
 * path, the three `conn.reducers` call sites, the terminal notice reached from the account ROW,
 * non-delivery, and the disarm-on-close (rb-52, PRV1-3/PRV1-4).
 *
 * ★ SOURCE OF TRUTH — the PROMOTED RESIDUAL, quoted verbatim. Section `rb-52` of
 * `specs/monster-realm-v2/M-residual-backlog.spec.md` (source slice m22-s8, residual
 * R-m22-s8-X10):
 *   "[PRV1-3/PRV1-4 UI surface] WHEN the player opens the privacy surface THE CLIENT SHALL
 *    expose reachable delete/cancel controls wired to `conn.reducers` and render the distinct
 *    terminal notice once `terminal_at_ms` is `Some`."
 *
 * Design record: `docs/adr/0231-client-privacy-cores-request-wide-chunk-assembly.md`,
 * Amendment A2 — A2-D5 (the open path + the claim-hidden-FIRST ordering), A2-D6 (the ROW
 * route), A2-D8 (non-delivery must be observable), A2-D9 (change-detected dispatch).
 * uif-16b: the surface is now the Privacy SECTION of the one Profile frame (`#profile-overlay`),
 * reached by KeyC then the Account section's door, which moves focus and hides nothing; A2-D5's
 * hide-first ordering is superseded by the UIF16B.3 "one dialog, one trap" case.
 *
 * THE TERMINAL NOTICE is read from the en catalog (`privacy.notice.terminal`): 21r-b2 moved the
 * sentence into the i18n catalog and removed the `PRIVACY_TERMINAL_NOTICE` export. The read is
 * asserted to be a string when this file loads, so a missing or misspelt key fails loudly instead
 * of turning the `.not.toBe` checks below vacuous.
 *
 * 21r-b2 ADDS A SECOND DESCRIBE that boots the SAME harness under `?locale=fr` (the
 * main.feedbackI18n.test.ts precedent) through the shared `bootMain(url)`. Its locale probe is a
 * DYNAMIC import of `./ui/i18n/resolver` taken AFTER the boot: `bootMain` resets the module
 * registry, so a static import at the top of this file would bind a different resolver instance
 * than the one main.ts switched, and would read `en` whatever main.ts did.
 *
 * MODELLED ON `main.a11yFocus.test.ts` (which is itself modelled on the sanctioned
 * RUNTIME-import exception documented at `main.wiring.test.ts:20-21`). Same `#app` shell built
 * by parsing the REAL `client/index.html` with `DOMParser` + `document.adoptNode` +
 * `replaceChildren` (never `innerHTML`, ADR-0135), same listener-stacking cleanup, same
 * controllable rAF queue.
 *
 * ★ TWO DELIBERATE DELTAS FROM THAT HARNESS, BOTH LOAD-BEARING:
 *
 *   1. `live()` RETURNS A REAL REDUCERS OBJECT. The a11yFocus mock has `live: () => undefined`.
 *      MEASURED: under that stub, `conn?.live()?.reducers.deleteAccount({})` is a silent no-op,
 *      so a build with NO reducer call at all is byte-for-byte indistinguishable from a correct
 *      one — the criterion's "wired to conn.reducers" half would be untestable. This mock hands
 *      back `{ reducers: { deleteAccount, cancelAccountDeletion, requestDataExport } }`, three
 *      independent spies, and `H.live` is mutable so the non-delivery test can take it away.
 *
 *   2. THE ACCOUNT ROW IS INJECTED. `main.ts` derives the whole privacy lattice from
 *      `store.ownAccount(identity)`, and with no row every phase is `unknown` — Delete and
 *      Cancel are permitted in NO state, so the criterion's own two controls could never be
 *      exercised. The `connect` mock therefore wraps that ONE read on the real store instance
 *      `main.ts` handed it (falling through to the real method when no fixture is set), which
 *      is the smallest possible injection point: a deterministic fake for one dependency read,
 *      not a re-implementation of the store.
 *
 * The frame is driven through `runFrame`, which stubs `performance.now()` for the duration of
 * one synchronous call. `Date.now()` is deliberately NOT stubbed: nothing here asserts on a
 * countdown NUMBER, and every fixture's PHASE is clock-independent by construction (the phase
 * comes from the terminal marker and the status tag alone — `ui/privacyModel.ts`).
 *
 * NO `new RegExp(...)`, no regex literal, no `eval`, no `new Function` anywhere. NO `innerHTML`
 *. NO numeric duplicate of the grace window — every fixture value is synthetic.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { telemetryMock, wasmPkgStubMock, worldRendererMock } from '../test-util/mainBootHarness';
import type { Connection, ConnectionOptions } from './net/connection';
import { CATALOG_EN } from './ui/i18n/catalog.en';
import { CATALOG_FR } from './ui/i18n/catalog.fr';
import { OVERLAY_A11Y } from './ui/overlayRegistry';
import { PRIVACY_PSEUDONYMIZATION_DISCLOSURE } from './ui/privacyBanner';

const EN_CATALOG = CATALOG_EN as unknown as Readonly<Record<string, unknown>>;
const FR_CATALOG = CATALOG_FR as unknown as Readonly<Record<string, unknown>>;

/** `catalog[key]`, which MUST be an own plain string. Client specs are not typechecked, so a
 *  mistyped key would otherwise read `undefined` and make every assertion against it vacuous —
 *  this throws instead, naming the locale and the key. */
function catalogString(
  catalog: Readonly<Record<string, unknown>>,
  locale: string,
  key: string,
): string {
  const value = Object.hasOwn(catalog, key) ? catalog[key] : undefined;
  if (typeof value !== 'string') {
    throw new Error(
      `catalog.${locale} has no plain-string entry for '${key}' (got ${typeof value})`,
    );
  }
  return value;
}

/** PRV1-4's distinct terminal notice, in English. */
const PRIVACY_TERMINAL_NOTICE = catalogString(EN_CATALOG, 'en', 'privacy.notice.terminal');

// --- hoisted state shared with the mock factories --------------------------------------
const H = vi.hoisted(() => {
  const deleteAccount = vi.fn(() => Promise.resolve());
  const cancelAccountDeletion = vi.fn(() => Promise.resolve());
  const requestDataExport = vi.fn(() => Promise.resolve());
  const liveHandle = { reducers: { deleteAccount, cancelAccountDeletion, requestDataExport } };
  return {
    identity: 'ab'.repeat(32),
    connectOpts: null as unknown,
    /** Swapped to `undefined` by the non-delivery test. */
    live: liveHandle as unknown,
    liveHandle,
    linkFrozen: false,
    /** The injected `store.ownAccount(identity)` row; `undefined` falls through to the real one. */
    account: undefined as unknown,
    deleteAccount,
    cancelAccountDeletion,
    requestDataExport,
  };
});

// The wasm pkg — identical shape to main.a11yFocus.test.ts's mock. `deletion_grace_ms_default`
// crosses as a BigInt (`-> i64`), so the stub is `1n`, not `1`; it is deliberately a
// SYNTHETIC window and never the shipped value.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgStubMock());

// The connection. DELTA 1 + DELTA 2 (see the file header) both live here.
vi.mock('./net/connection', () => {
  const stub = {
    conn: undefined,
    live: () => H.live,
    identity: () => H.identity,
    linkFrozen: () => H.linkFrozen,
    continueAnonymously: () => undefined,
    // MUST be 'hidden' or every keypress in this file is swallowed by main.ts's session gate
    // before it reaches the branch under test.
    sessionState: () => 'hidden',
    startSignIn: () => undefined,
    reconnectNow: () => undefined,
  };
  return {
    connect: (opts: { store: { ownAccount: (id: string) => unknown } }) => {
      H.connectOpts = opts;
      // DELTA 2: wrap the ONE store read the privacy lattice is derived from, on the real
      // instance main.ts constructed. Falls through to the real method whenever no fixture is
      // set, so nothing else main.ts reads from the store is affected.
      const realOwnAccount = opts.store.ownAccount.bind(opts.store);
      opts.store.ownAccount = (id: string) => H.account ?? realOwnAccount(id);
      return stub as unknown as Connection;
    },
  };
});

// Telemetry: keep the real types/NOOP, never bootstrap the OTel SDK (no network).
vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

// The renderer: constructed unconditionally before the `#app` guard. `init(mount)` appends a
// real focusable canvas so `mount.querySelector('canvas')` resolves, exactly as the a11yFocus
// harness needs it to.
vi.mock('./render/world', () => worldRendererMock());

// --- listener-cleanup harness (verbatim from main.a11yFocus.test.ts) --------------------
type AddListener = (
  type: string,
  handler: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
) => void;

interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}

function recordListeners(target: EventTarget, sink: Recorded[]): () => void {
  const hadOwn = Object.hasOwn(target, 'addEventListener');
  const ownDesc = Object.getOwnPropertyDescriptor(target, 'addEventListener');
  const original = target.addEventListener.bind(target) as unknown as AddListener;
  const patched: AddListener = (type, handler, options) => {
    sink.push({ target, type, handler, options });
    original(type, handler, options);
  };
  (target as unknown as { addEventListener: AddListener }).addEventListener = patched;
  return () => {
    if (hadOwn && ownDesc !== undefined) {
      Object.defineProperty(target, 'addEventListener', ownDesc);
    } else {
      delete (target as unknown as { addEventListener?: AddListener }).addEventListener;
    }
  };
}

// --- DOM construction: the REAL client/index.html, never a fixture, never innerHTML ------
function buildAppShellFromRealIndexHtml(): void {
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
  let html: string;
  try {
    html = readFileSync(htmlPath, 'utf8');
  } catch (err) {
    throw new Error(`index.html could not be read at expected path: ${htmlPath} — ${err}`);
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const bodyChildren = Array.from(parsed.body.children).filter((e) => e.tagName !== 'SCRIPT');
  // ctl-7a (named intentional change): the shipped <body> is now three children (#game-screen,
  // #build-stamp, #a11y-live), so the old `body children > 5` floor is retired. The vacuity
  // guard counts the id-bearing elements the parse yielded instead (the real shell has ~60).
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(
    idCount,
    'ANTI-VACUITY: parsed index.html yielded almost no id-bearing elements — the DOM this ' +
      'whole file depends on would be empty and every test below would fail for the wrong reason',
  ).toBeGreaterThan(5);
  const adopted = bodyChildren.map((e) => document.adoptNode(e));
  document.body.replaceChildren(...adopted);
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

// --- the controllable rAF queue ----------------------------------------------------------
let rafCallback: FrameRequestCallback | null = null;

function stubControllableRaf(): void {
  rafCallback = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallback = cb;
    return 0;
  });
}

/** Run ONE frame at a stubbed `performance.now() === atMs`. Throws loud (never a silent no-op)
 *  if no callback is armed or the frame did not re-arm itself — a silent no-op here would make
 *  every account-row test below pass vacuously against a frame that never ran. */
function runFrame(atMs: number): void {
  const cb = rafCallback;
  if (cb === null) {
    throw new Error('runFrame: no requestAnimationFrame callback is armed — has main() booted?');
  }
  rafCallback = null;
  const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(atMs);
  try {
    cb(atMs);
  } finally {
    nowSpy.mockRestore();
  }
  expect(
    rafCallback,
    'the frame did not re-arm requestAnimationFrame(frame) in its `finally` — the frame body ' +
      'threw in a way this harness cannot account for',
  ).not.toBeNull();
}

/**
 * `runFrame`, but driving the WALL clock too.
 *
 * `runFrame` stubs `performance.now()` only, and the deletion countdown reads
 * `BigInt(Math.trunc(Date.now()))` — so under the plain driver every frame sees the same wall
 * time and a frozen deadline is indistinguishable from a ticking one. The two clocks are stubbed
 * SEPARATELY and given different values so a wiring that fed `performance.now()` into `nowMs`
 * would produce a visibly wrong (millennia-long) countdown rather than a passing one.
 */
function runFrameAt(perfMs: number, wallMs: number): void {
  const wallSpy = vi.spyOn(Date, 'now').mockReturnValue(wallMs);
  try {
    runFrame(perfMs);
  } finally {
    wallSpy.mockRestore();
  }
}

// --- account-row fixtures ----------------------------------------------------------------
// Every value is SYNTHETIC. The phases below do not depend on the wall clock: `phase` comes
// from the terminal marker and the status tag alone (ui/privacyModel.ts's own contract).

/** A whole `StoreAccount`-shaped row, so the injection point is fed the same shape the real
 *  `my_account` view converter produces — a partial object would let a future reader of an
 *  unrelated column fail here for a fixture reason rather than a behavioural one. Every
 *  timestamp is a small synthetic value; the PHASE never depends on any of them. */
function accountRow(
  status: string,
  deletionRequestedAtMs: bigint | undefined,
  terminalAtMs: bigint | undefined,
): Record<string, unknown> {
  return {
    identity: H.identity,
    authIssuer: 'rb52-test-issuer',
    createdAtMs: 1n,
    lastLoginAtMs: 2n,
    status,
    deletionRequestedAtMs,
    claimedFrom: undefined,
    claimedAtMs: undefined,
    terminalAtMs,
  };
}

/** Active: delete permitted, export permitted, cancel NOT permitted. */
/** Synthetic wall-clock readings. Small, and unrelated to any tunable window.
 *  `WALL_STEP_MS` is a whole number of seconds so the label's seconds group must move. */
const WALL_T0 = 5_000;
const WALL_STEP_MS = 2_000;

/** A live grace window whose deadline is still AHEAD of `WALL_T0`. The harness stubs the wasm
 *  grace accessor to a tiny value, so the deadline is essentially `deletionRequestedAtMs` — a
 *  request stamped in the future is how this fixture buys a countdown that is still running. */
const ACCOUNT_PENDING_FUTURE = accountRow('PendingDeletion', BigInt(WALL_T0 + 60_000), undefined);

const ACCOUNT_ACTIVE = accountRow('Active', undefined, undefined);
/** A live deletion request: cancel permitted, delete and export NOT permitted. */
const ACCOUNT_PENDING = accountRow('PendingDeletion', 0n, undefined);
/** ★ ALREADY ERASED. `terminalAtMs: 0n` specifically — `0n` is a VALID `Option<i64>` marker,
 *  and a truthiness-keyed read (`if (terminalAtMs)`) inverts PRV1-4 on exactly this value,
 *  offering a Cancel button for an account that is already permanently gone. */
const ACCOUNT_TERMINAL = accountRow('PendingDeletion', 0n, 0n);

// --- DOM helpers -------------------------------------------------------------------------

/** The nearest ancestor (INCLUDING the node itself) that is `display:none`, or `null` when the
 *  node is on-screen all the way to `<body>`. This is `main.ts`'s own `focusInsideHiddenSubtree`
 *  idiom, which that file documents as the ONE hiding discriminator in this repo.
 *  `checkVisibility()` is deliberately not used — this happy-dom version does not implement it,
 *  which would make the whole proof vacuous. */
function hiddenAncestorOf(node: Element | null): string | null {
  for (let el: Element | null = node; el instanceof HTMLElement; el = el.parentElement) {
    if (el.style.display === 'none') return el.id === '' ? el.tagName : `#${el.id}`;
  }
  return null;
}

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  expect(found, `#${id} must exist in the live document`).not.toBeNull();
  return found as HTMLElement;
}

function privacyOverlayVisible(): boolean {
  const overlay = document.getElementById('privacy-overlay');
  return overlay !== null && overlay.style.display !== 'none' && overlay.style.display !== '';
}

function claimOverlayVisible(): boolean {
  const overlay = document.getElementById('claim-overlay');
  return overlay !== null && overlay.style.display !== 'none' && overlay.style.display !== '';
}

/**
 * The front door: the ONE button inside the Account & Sign-in overlay that opens the privacy
 * surface.
 *
 * DISCOVERED BY ROLE, NOT BY A HARD-CODED ID, and the count is asserted: "exactly one privacy
 * door in the account overlay" is the contract-level statement, and it also catches a second,
 * duplicate door left behind by a rename.
 */
function privacyOpener(): HTMLButtonElement {
  const claim = byId('claim-overlay');
  const doors = Array.from(claim.querySelectorAll('button')).filter((b) =>
    b.id.includes('privacy'),
  );
  expect(
    doors.length,
    'the Account & Sign-in overlay must contain EXACTLY ONE button whose id names the privacy ' +
      `surface; found ${doors.length} (${doors.map((b) => b.id).join(', ')}). Zero means the ` +
      'surface has no front door and the criterion`s "WHEN the player opens" precondition is ' +
      'unreachable; two means a rename left a dead duplicate behind',
  ).toBe(1);
  return doors[0] as HTMLButtonElement;
}

/** Open the surface through the real production path and assert it actually opened.
 *  uif-16b (named intentional change): the privacy surface is the Privacy SECTION of the one
 *  Profile frame, shown whenever the frame is. The production path is therefore KeyC (Profile,
 *  on Account) and then the Account section's privacy door, which moves focus into the Privacy
 *  section. Was: the door alone opened a separate privacy dialog (and hid the account one). */
function openPrivacySurface(): void {
  if (!profileFrameVisible()) pressKey({ code: 'KeyC' });
  expect(profileFrameVisible(), 'KeyC must open the Profile frame').toBe(true);
  privacyOpener().click();
  expect(
    privacyOverlayVisible(),
    'with the Profile frame open its Privacy section must be on screen',
  ).toBe(true);
  // The door seats the Privacy section's first live row; when the section has none (an
  // already-erased account), it falls back to the frame's Close row. Decided from the DOM.
  const target = privacyDoorTarget();
  expect(
    document.activeElement,
    target.id === 'profile-close-btn'
      ? 'the Privacy section has no live row: the door must seat the frame`s Close row'
      : 'the privacy door must move focus INTO the Privacy section, onto its first live row',
  ).toBe(target);
}

/** Where the privacy door must seat focus, read off the DOM: the Privacy section's first shown,
 *  enabled button, else the frame's `#profile-close-btn`. */
function privacyDoorTarget(): HTMLElement {
  const live = Array.from(byId('privacy-overlay').querySelectorAll('button')).filter(
    (b) => !b.disabled && hiddenAncestorOf(b) === null,
  );
  return live[0] ?? byId('profile-close-btn');
}

/** The one Profile frame (uif-16b) is on screen. */
function profileFrameVisible(): boolean {
  const frame = document.getElementById('profile-overlay');
  return frame !== null && frame.style.display !== 'none' && frame.style.display !== '';
}

/** Every `[role="dialog"][aria-modal="true"]` root that is on screen and not suspended (no inert
 *  or aria-hidden on it or an ancestor, no hidden visibility), by id. */
function liveModalDialogs(): string[] {
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
    .filter((d) => {
      if (hiddenAncestorOf(d) !== null) return false;
      for (let n: Element | null = d; n instanceof HTMLElement; n = n.parentElement) {
        if (n.hasAttribute('inert')) return false;
        if (n.getAttribute('aria-hidden') === 'true') return false;
        if (n.style.visibility === 'hidden') return false;
      }
      return true;
    })
    .map((d) => d.id);
}

interface KeySpec {
  readonly code?: string;
  readonly key?: string;
}

function pressKey(spec: KeySpec, target: EventTarget = window): KeyboardEvent {
  const init: KeyboardEventInit = { bubbles: true, cancelable: true };
  if (spec.code !== undefined) init.code = spec.code;
  if (spec.key !== undefined) init.key = spec.key;
  const event = new KeyboardEvent('keydown', init);
  target.dispatchEvent(event);
  return event;
}

/** Exactly one of the three privacy reducers was called, exactly once; the other two ZERO
 *  times. A single "something was called" assertion misses delete -> cancel misrouting, which
 *  on this surface is the difference between starting and aborting an account deletion. */
function expectOnlyReducer(which: 'delete' | 'cancel' | 'export' | 'none'): void {
  expect(H.deleteAccount, 'reducers.deleteAccount').toHaveBeenCalledTimes(
    which === 'delete' ? 1 : 0,
  );
  expect(H.cancelAccountDeletion, 'reducers.cancelAccountDeletion').toHaveBeenCalledTimes(
    which === 'cancel' ? 1 : 0,
  );
  expect(H.requestDataExport, 'reducers.requestDataExport').toHaveBeenCalledTimes(
    which === 'export' ? 1 : 0,
  );
}

// --- the shared harness: reset, boot, teardown (used by BOTH describes below) ------------

let recorded: Recorded[] = [];
let restoreWindowAdd: (() => void) | undefined;
let restoreDocumentAdd: (() => void) | undefined;

/** Everything a test needs BEFORE main.ts boots: fresh spies/fixtures, the real index.html shell,
 *  the controllable rAF queue and the listener recorder. */
function setUpHarness(): void {
  recorded = [];
  H.connectOpts = null;
  H.live = H.liveHandle;
  H.linkFrozen = false;
  H.account = undefined;
  H.deleteAccount.mockClear();
  H.cancelAccountDeletion.mockClear();
  H.requestDataExport.mockClear();
  buildAppShellFromRealIndexHtml();
  stubControllableRaf();
  restoreWindowAdd = recordListeners(window, recorded);
  restoreDocumentAdd = recordListeners(document, recorded);
}

/** Boot the REAL main.ts at `url` (its query string is what main.ts negotiates the locale from),
 *  wait for `connect()`, and fire `onReady`. Shape copied from main.feedbackI18n.test.ts. */
async function bootMain(url: string): Promise<void> {
  window.history.replaceState(null, '', url);
  vi.resetModules();
  await import('./main');
  const opts = (await vi.waitFor(
    () => {
      const captured = H.connectOpts;
      if (captured === null) throw new Error('connect() has not been called by main() yet');
      return captured;
    },
    { timeout: 5_000, interval: 5 },
  )) as ConnectionOptions;
  opts.onReady(H.identity);
}

/** Detach every listener main.ts added, restore the patched adders and globals, empty the DOM. */
function tearDownHarness(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  restoreDocumentAdd?.();
  restoreWindowAdd?.();
  restoreDocumentAdd = undefined;
  restoreWindowAdd = undefined;
  H.connectOpts = null;
  vi.unstubAllGlobals();
  rafCallback = null;
  document.body.replaceChildren();
}

// --- the suite ---------------------------------------------------------------------------

describe('main.ts privacy surface wiring (rb-52, PRV1-3/PRV1-4)', () => {
  beforeEach(async () => {
    setUpHarness();
    await bootMain('/');
  });

  afterEach(() => {
    tearDownHarness();
  });

  // ---------------------------------------------------------------------------------------
  // The front door (the criterion's "WHEN the player opens the privacy surface").
  // ---------------------------------------------------------------------------------------

  it('RB52T-OPENER-REACHABLE: the account overlay`s privacy door is a labelled, on-screen native button once that overlay is open', () => {
    // WRONG IMPL KILLED ★ THE MEASURED ONE: adding the door with `claimView.ts`'s existing
    // `#wireButton` and nothing else. `ensureElement` creates every node `display:none` and
    // claimView never un-hides its buttons, so the door would ship BLANK and INVISIBLE while a
    // programmatic `.click()` still opened the surface — every other test in this file would
    // stay green and no human could ever reach the privacy surface at all.
    // TRANSITION, never a static: the door is asserted hidden while the account overlay is
    // closed (which is correct), then the overlay is opened and it must become reachable. A
    // born-hidden element makes a bare "is it visible" assertion meaningless in one direction
    // and impossible in the other.
    const door = privacyOpener();
    expect(door.tagName, 'the door must be a NATIVE <button>').toBe('BUTTON');
    expect(
      hiddenAncestorOf(door),
      'while the account overlay is CLOSED the door must be off screen — if this is null the ' +
        'walk is broken and the reachability assertion below proves nothing',
    ).not.toBeNull();

    pressKey({ code: 'KeyC' });
    expect(claimOverlayVisible(), 'KeyC must open the Account & Sign-in overlay').toBe(true);
    expect(
      hiddenAncestorOf(door),
      'with the account overlay open, NOTHING on the path from the privacy door to <body> may ' +
        'be display:none — an invisible door is not a front door',
    ).toBeNull();
    expect(
      (door.textContent ?? '').length,
      'the door must carry a non-empty label: a blank button has no accessible name and ' +
        'nothing for a sighted player to read either',
    ).toBeGreaterThan(0);
  });

  it('UIF16B.3 one dialog, one trap: with Profile open on Account the privacy door moves focus into the Privacy section and opens nothing; the account section stays on screen, exactly one aria-modal root (the Profile frame) is live, and closing never strands focus in a hidden subtree', async () => {
    // uif-16b (named intentional change, SUPERSEDES RB52T-OPEN-ORDER): the old pin "the account
    // overlay must be CLOSED once the privacy surface is up — two aria-modal roots and two focus
    // traps cannot both be correct" is replaced. Its reason still holds, and is now met the other
    // way round: Account and Privacy are sections of ONE dialog (`#profile-overlay`) with ONE focus
    // trap, so the door hides nothing and opens nothing; it only moves focus. ADR-0231 A2-D5's
    // hide-claim-first ordering has no subject left (`openPrivacy`'s verdict retired).
    // WRONG IMPL KILLED: a door that still hides the Account section (the old verdict left in);
    // a door that opens a second dialog or pushes a frame (two live aria-modal roots, or a
    // `privacyView` frame on the stack); a section that kept its own role="dialog"; a door that
    // focuses nothing (focus left on the door, outside the Privacy section); a close that parks
    // focus in the hidden frame.
    pressKey({ code: 'KeyC' });
    expect(claimOverlayVisible(), 'KeyC shows the Account section').toBe(true);
    expect(profileFrameVisible(), 'inside the one Profile frame').toBe(true);
    expect(
      byId('claim-overlay').contains(document.activeElement),
      'focus is inside the Account section at once',
    ).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // the deferred focus settles
    const stackOf = (): unknown =>
      (window as unknown as { __game: () => { stack: unknown } }).__game().stack;
    const before = JSON.stringify(stackOf());
    expect(liveModalDialogs(), 'one live modal root: the Profile frame').toEqual([
      'profile-overlay',
    ]);

    openPrivacySurface();
    expect(claimOverlayVisible(), 'the Account section is still on screen').toBe(true);
    expect(JSON.stringify(stackOf()), 'the door pushed and popped nothing').toBe(before);
    expect(liveModalDialogs(), 'still exactly one live modal root').toEqual(['profile-overlay']);
    const focused = document.activeElement as HTMLButtonElement;
    expect(focused.tagName, 'focus is on a Privacy row').toBe('BUTTON');
    expect(focused.disabled, 'an enabled one').toBe(false);
    expect(hiddenAncestorOf(focused), 'that is on screen').toBeNull();

    pressKey({ code: 'Escape' });
    expect(profileFrameVisible(), 'Start closes the Profile frame').toBe(false);
    expect(privacyOverlayVisible(), 'Escape must close the privacy surface').toBe(false);
    expect(
      hiddenAncestorOf(document.activeElement),
      'after the close, focus must NOT be inside a display:none subtree. If it is, the privacy ' +
        'overlay captured its return target BEFORE the account overlay was hidden — and every ' +
        'overlay hotkey is now dead until the player clicks the canvas',
    ).toBeNull();
  });

  it('RB52T-OPEN-EXPOSES-CONTROLS: the opened surface exposes all three controls on screen, with the registry focus anchor among them', () => {
    // WRONG IMPL KILLED (1): `openPrivacy()` that shows the overlay without rendering it first
    // — the controls would be present but unlabelled and still `display:none` from
    // `ensureElement`, i.e. an empty black box.
    // WRONG IMPL KILLED (2): a `canOpen` verdict check that denies its own open (e.g. probing
    // the privacy view itself as a blocker), so the door is a dead button.
    H.account = ACCOUNT_ACTIVE;
    runFrame(0);
    openPrivacySurface();
    for (const id of ['privacy-delete-btn', 'privacy-cancel-btn', 'privacy-export-btn']) {
      const control = byId(id);
      expect(control.tagName, `#${id} must be a native <button>`).toBe('BUTTON');
      expect(
        hiddenAncestorOf(control),
        `#${id} must be ON SCREEN once the surface opens`,
      ).toBeNull();
      expect(
        (control.textContent ?? '').length,
        `#${id} must carry a non-empty label`,
      ).toBeGreaterThan(0);
    }
    // uif-16b (named intentional change): the Privacy section has no registry anchor of its own
    // (`OVERLAY_A11Y.privacyView` retired with the overlay id); the frame's anchor is `#rename-input`.
    // What a player reaching the surface needs is focus inside it: the door seats it on the
    // section's first live control, Delete for an Active account. Was: the privacyView
    // initialFocusSelector resolved inside #privacy-overlay.
    expect(document.activeElement, 'the door seats focus on Delete').toBe(
      byId('privacy-delete-btn'),
    );
    expect(
      byId('profile-overlay').querySelector(OVERLAY_A11Y.profileView.initialFocusSelector),
      'the frame`s registry anchor resolves INSIDE the frame root',
    ).not.toBeNull();
  });

  // ---------------------------------------------------------------------------------------
  // "wired to conn.reducers" — three controls, three spies, exclusive.
  // ---------------------------------------------------------------------------------------

  it('RB52T-DELETE-WIRED: the two-step delete calls reducers.deleteAccount exactly once and NEITHER other reducer', () => {
    // WRONG IMPL KILLED (1) ★ THE ONE THE a11yFocus MOCK CANNOT SEE: no reducer call at all.
    // With `live()` returning undefined (that harness's stub) `conn?.live()?.reducers.X()` is a
    // silent no-op and a build that wires NOTHING is indistinguishable from a correct one. This
    // file's `live()` returns real spies precisely so the absence is observable.
    // WRONG IMPL KILLED (2): step one emitting the call (a one-click account deletion). The
    // assertion after the FIRST click is what sees it, and it is the reason step one and step
    // two are asserted separately rather than as one "click through the flow" sequence.
    // WRONG IMPL KILLED (3): the delete effect routed to the wrong reducer — the two ZERO
    // counts see it, where a bare `toHaveBeenCalled` on deleteAccount alone would not.
    H.account = ACCOUNT_ACTIVE;
    runFrame(0);
    openPrivacySurface();

    const deleteBtn = byId('privacy-delete-btn') as HTMLButtonElement;
    expect(hiddenAncestorOf(deleteBtn), 'the delete control must be ON SCREEN').toBeNull();
    expect(
      deleteBtn.disabled,
      'an Active account may request deletion, so the control must be enabled',
    ).toBe(false);
    deleteBtn.click();
    expectOnlyReducer('none');
    expect(
      (byId('privacy-confirm').textContent ?? '').length,
      'step one must ARM a visible confirmation and send nothing — this is an irreversible ' +
        'action, and a one-click delete is the defect the two-step gate exists to prevent',
    ).toBeGreaterThan(0);

    const confirmBtn = byId('privacy-confirm-btn') as HTMLButtonElement;
    expect(hiddenAncestorOf(confirmBtn), 'step two must be ON SCREEN once armed').toBeNull();
    expect(confirmBtn.disabled, 'step two must be enabled once armed').toBe(false);
    confirmBtn.click();
    expectOnlyReducer('delete');
  });

  it('RB52T-CANCEL-WIRED: cancelling a live deletion calls reducers.cancelAccountDeletion exactly once and NEITHER other reducer', () => {
    // ★ PRV1-3's own criterion at the wiring tier. WRONG IMPL KILLED (1): the cancel control
    // wired to `deleteAccount` (a copy-paste of the delete branch) — the player presses Cancel
    // and issues a SECOND deletion request. The zero-count on deleteAccount is what sees it.
    // WRONG IMPL KILLED (2): a cancel control that is disabled during the grace window (a
    // client-side re-derivation of the server's cancel rule, which ADR-0231 bans: the server's
    // ONLY cancel refusal is the terminal marker, so a client that pre-rejects a past-deadline
    // cancel costs the player their real window).
    H.account = ACCOUNT_PENDING;
    runFrame(0);
    openPrivacySurface();

    const cancelBtn = byId('privacy-cancel-btn') as HTMLButtonElement;
    expect(hiddenAncestorOf(cancelBtn), 'the cancel control must be ON SCREEN').toBeNull();
    expect((cancelBtn.textContent ?? '').length).toBeGreaterThan(0);
    expect(
      cancelBtn.disabled,
      'a live deletion request is cancellable — the server`s only refusal is the terminal marker',
    ).toBe(false);
    cancelBtn.click();
    expectOnlyReducer('cancel');
  });

  it('RB52T-EXPORT-WIRED: the export control calls reducers.requestDataExport exactly once and NEITHER other reducer', () => {
    // WRONG IMPL KILLED: the `call-request-data-export` effect left unwired. `privacyStep`
    // already emits it, and an unreachable effect variant is dead code that silently makes the
    // Export button a no-op — the exact "button that silently does nothing" this repo bans.
    H.account = ACCOUNT_ACTIVE;
    runFrame(0);
    openPrivacySurface();

    const exportBtn = byId('privacy-export-btn') as HTMLButtonElement;
    expect(hiddenAncestorOf(exportBtn), 'the export control must be ON SCREEN').toBeNull();
    expect((exportBtn.textContent ?? '').length).toBeGreaterThan(0);
    expect(exportBtn.disabled).toBe(false);
    exportBtn.click();
    expectOnlyReducer('export');
  });

  it('RB52T-DISABLED-MIRRORS-ROW: the account row decides which controls are live, in both directions', () => {
    // WRONG IMPL KILLED (1) ★: controls that are always enabled. A live Delete button on an
    // account that is ALREADY pending deletion issues a second request; a live Cancel on an
    // Active account asks the server to cancel something that does not exist. Both are the
    // "button that silently does nothing" failure, on the one surface where the player cannot
    // tell "nothing happened" from "your account is being erased".
    // WRONG IMPL KILLED (2): a snapshot taken once at boot and never refreshed — the second
    // half below is a TRANSITION driven by a real frame, not a second fixture read at t=0.
    H.account = ACCOUNT_ACTIVE;
    runFrame(0);
    openPrivacySurface();
    expect((byId('privacy-delete-btn') as HTMLButtonElement).disabled, 'active: delete').toBe(
      false,
    );
    expect((byId('privacy-cancel-btn') as HTMLButtonElement).disabled, 'active: cancel').toBe(true);

    H.account = ACCOUNT_PENDING;
    runFrame(600);
    expect((byId('privacy-delete-btn') as HTMLButtonElement).disabled, 'pending: delete').toBe(
      true,
    );
    expect((byId('privacy-cancel-btn') as HTMLButtonElement).disabled, 'pending: cancel').toBe(
      false,
    );
  });

  // ---------------------------------------------------------------------------------------
  // "render the distinct terminal notice once terminal_at_ms is Some" — from the ROW.
  // ---------------------------------------------------------------------------------------

  it('RB52T-TERMINAL-ROW-NO-CLICK: an already-erased account shows the exact PRIVACY_TERMINAL_NOTICE on open, with no privacy control ever clicked', () => {
    // ★ THE CRITERION'S SECOND HALF, END TO END: row -> deriveDeletionCountdown ->
    // account-changed -> buildPrivacyViewModel -> the DOM, with ZERO interaction.
    // WRONG IMPL KILLED (1) ★ THE MEASURED DEFECT: a view model keyed on
    // `state.notice` alone. `privacyStep`'s `account-changed` arm never writes `notice`, so the
    // notice element is EMPTY when the player opens the surface on an already-erased account —
    // the criterion fails while every click-driven test in this file passes.
    // WRONG IMPL KILLED (2): a truthiness-keyed terminal read. `terminalAtMs` is `0n` here, a
    // VALID marker; `if (terminalAtMs)` reads it as absent and this account arrives as a live
    // grace window with a Cancel button.
    // WRONG IMPL KILLED (3): the frame's change-detector ignoring the terminal transition, so
    // `account-changed` is never dispatched at all and the surface keeps the boot-time model.
    H.account = ACCOUNT_TERMINAL;
    runFrame(0);
    openPrivacySurface();
    expectOnlyReducer('none');
    const notice = byId('privacy-notice');
    expect(notice.textContent).toBe(PRIVACY_TERMINAL_NOTICE);
    expect(
      hiddenAncestorOf(notice),
      'the terminal notice must be ON SCREEN — it is the only place the player is told the ' +
        'account is already permanently gone',
    ).toBeNull();
    expect(
      (byId('privacy-cancel-btn') as HTMLButtonElement).disabled,
      'and a permanently deleted account offers NO cancel — the server refuses it, and a live ' +
        'button here promises a recovery that cannot happen',
    ).toBe(true);

    // TRANSITION AWAY, never a static: a row that is no longer terminal must clear the notice.
    // Without this arm a frozen terminal notice would sit on the surface for the rest of the
    // page`s life, which is how the rb-51 banner`s hide arm became load-bearing.
    H.account = ACCOUNT_ACTIVE;
    runFrame(600);
    expect(byId('privacy-notice').textContent, 'the notice must be cleared, not frozen').toBe('');
    expect(hiddenAncestorOf(byId('privacy-notice')), 'and hidden again').not.toBeNull();
  });

  it('UIF16B.3 for an already-erased account the Privacy section has no live row, so the privacy door seats the frame`s Close row (enabled, on screen), never a disabled or hidden Privacy control, and the frame stays the one live dialog', () => {
    // WRONG IMPL KILLED: a door that focuses the Privacy section's first DOM button whatever its
    // state (a disabled Delete or Cancel: focus on a dead control, the trap has nothing to keep);
    // a door that focuses nothing when the section is empty (focus left on the door, or on the
    // page); a fallback to a section root instead of the Close row.
    H.account = ACCOUNT_TERMINAL;
    runFrame(0);
    pressKey({ code: 'KeyC' });
    expect(profileFrameVisible(), 'precondition: KeyC opened the Profile frame').toBe(true);
    const live = Array.from(byId('privacy-overlay').querySelectorAll('button')).filter(
      (b) => !b.disabled && hiddenAncestorOf(b) === null,
    );
    expect(
      live.map((b) => b.id),
      'precondition: a terminal account leaves the Privacy section with no live row',
    ).toEqual([]);

    privacyOpener().click();
    const close = byId('profile-close-btn') as HTMLButtonElement;
    expect(document.activeElement, 'the door seats the frame`s Close row').toBe(close);
    expect(close.disabled, 'Close is enabled').toBe(false);
    expect(hiddenAncestorOf(close), 'Close is on screen').toBeNull();
    expect(liveModalDialogs(), 'one live modal root').toEqual(['profile-overlay']);
    expectOnlyReducer('none');
  });

  it('UIF16B.4 a privacy render that disables the FOCUSED control without arming (an export request now in flight) seats focus on the frame`s Close row, enabled and on screen, never the page', () => {
    // WRONG IMPL KILLED: main.ts's `fallbackRow: () => profileView?.closeRow` handler removed (the
    // view suites wire their own fallback, so nothing checked the shipped wiring): the reseat has
    // no safe row and focus falls to the page; and a fallback to the section's first action
    // (Delete), which a second Enter would press.
    H.account = ACCOUNT_ACTIVE;
    runFrame(0);
    openPrivacySurface();
    const exportBtn = byId('privacy-export-btn') as HTMLButtonElement;
    expect(exportBtn.disabled, 'precondition: an Active account may export').toBe(false);
    exportBtn.focus();
    expect(document.activeElement, 'precondition: focus is on Export').toBe(exportBtn);

    exportBtn.click();
    expectOnlyReducer('export');
    expect(exportBtn.disabled, 'precondition: the in-flight request disabled Export').toBe(true);
    expect(byId('privacy-confirm').textContent, 'precondition: nothing is armed').toBe('');

    const close = byId('profile-close-btn') as HTMLButtonElement;
    expect(document.activeElement, 'focus moved to the frame`s Close row').toBe(close);
    expect(close.disabled, 'Close is enabled').toBe(false);
    expect(hiddenAncestorOf(close), 'Close is on screen').toBeNull();
  });

  // ---------------------------------------------------------------------------------------
  // ADR-0231 A2-D8 — non-delivery must be observable, and must not spend anything.
  // ---------------------------------------------------------------------------------------

  it('RB52T-NON-DELIVERY-VISIBLE: with no live handle the surface says so, the control stays usable, and the next click still delivers', () => {
    // ★ ADR-0231 A2-D8, and it is a measured hole rather than a hypothetical one: `sendGuarded`
    // reports a FROZEN link but cannot see `conn.live()` returning `undefined` —
    // `undefined?.catch(...)` is a silent no-op, so no `request-succeeded` and no
    // `request-failed` ever arrives, `inFlight` sticks forever, and every later click returns
    // `begin`'s silent no-op. The player clicks Cancel during a live grace window and nothing
    // happens, ever, with no message.
    // WRONG IMPL KILLED (1) ★: `hasLiveConnection` computed as `conn !== undefined &&
    // !conn.linkFrozen()` (the first draft). Both operands are TRUE here, so the model takes
    // the DELIVERED path: no notice is rendered and `inFlight` is set — and the SECOND click
    // below then delivers nothing, which is what the final assertion catches.
    // WRONG IMPL KILLED (2): a notice that is rendered but is the terminal sentence, telling a
    // player with a live grace window that their account is already gone.
    H.account = ACCOUNT_PENDING;
    runFrame(0);
    openPrivacySurface();
    H.live = undefined;

    const cancelBtn = byId('privacy-cancel-btn') as HTMLButtonElement;
    expect(cancelBtn.disabled, 'precondition: the control is live before the click').toBe(false);
    expect(
      byId('privacy-notice').textContent,
      'precondition: nothing is on the notice line yet, so the assertion below is a TRANSITION',
    ).toBe('');
    cancelBtn.click();
    expectOnlyReducer('none');

    const notice = byId('privacy-notice');
    expect(
      (notice.textContent ?? '').length,
      'a click that could not be delivered must SAY SO — silence here is the dead-button black ' +
        'hole, on a control that is the player`s only way to stop an irreversible deletion',
    ).toBeGreaterThan(0);
    expect(hiddenAncestorOf(notice), 'and the message must be on screen').toBeNull();
    expect(
      notice.textContent,
      'a missing link must never read as "your account is permanently deleted"',
    ).not.toBe(PRIVACY_TERMINAL_NOTICE);
    expect(
      (byId('privacy-cancel-btn') as HTMLButtonElement).disabled,
      'the control must stay USABLE — nothing was spent by a click that delivered nothing',
    ).toBe(false);

    // The link comes back. The very same click must now reach the reducer: if `inFlight` were
    // stuck from the undelivered attempt, this would be a silent no-op forever.
    H.live = H.liveHandle;
    byId('privacy-cancel-btn').click();
    expectOnlyReducer('cancel');
  });

  // ---------------------------------------------------------------------------------------
  // ADR-0231 A2-D4 — every close disarms.
  // ---------------------------------------------------------------------------------------

  it('RB52T-DISARM-ON-CLOSE: closing an armed surface disarms it, and the re-opened surface offers no half-completed deletion', () => {
    // ★ WHY THIS MATTERS MORE HERE THAN ANYWHERE ELSE. `privacyView` is in
    // `BATTLE_FORCE_HIDE`, so a battle auto-show hides this surface through `main.ts`'s handle
    // thunk. If the close does not disarm, the model stays `delete-armed` behind a hidden
    // overlay and the player's NEXT click on a re-opened surface is step two of a confirmation
    // they no longer remember giving — a one-click account deletion.
    // WRONG IMPL KILLED (1) ★: `onDismissed` never dispatched (a `hide()` that only writes
    // display + closeOverlayA11y, i.e. the claimView shape).
    // WRONG IMPL KILLED (2): a disarm wired only to the Escape branch in `main.ts` rather than
    // to the shell's own `hide()` — this test drives Escape, so it does NOT distinguish the
    // two; `privacyView.test.ts`'s RB52V-DISARM-ON-CLOSE is the tooth that does, by calling
    // `hide()` directly. Recorded rather than glossed: a WRONG IMPL KILLED list naming a
    // mutant this test cannot see would be worse than saying nothing.
    // POSITIVE FIRST, then the transition — a born-empty confirm row would make the closing
    // assertion vacuous.
    H.account = ACCOUNT_ACTIVE;
    runFrame(0);
    openPrivacySurface();
    byId('privacy-delete-btn').click();
    expect(
      (byId('privacy-confirm').textContent ?? '').length,
      'POSITIVE FIRST: step one must really have armed a visible confirmation',
    ).toBeGreaterThan(0);
    expect(hiddenAncestorOf(byId('privacy-confirm'))).toBeNull();

    pressKey({ code: 'Escape' });
    expect(privacyOverlayVisible(), 'Escape must close the privacy surface').toBe(false);

    openPrivacySurface();
    expect(
      byId('privacy-confirm').textContent,
      'the re-opened surface must carry NO armed confirmation',
    ).toBe('');
    expect(
      hiddenAncestorOf(byId('privacy-confirm')),
      'and the confirm row must be off screen again',
    ).not.toBeNull();
    expect(
      hiddenAncestorOf(byId('privacy-confirm-btn')),
      'step two must not be reachable on a freshly re-opened surface',
    ).not.toBeNull();
    expectOnlyReducer('none');
  });

  it('RB52T-STATUS-TICKS-WITH-THE-WALL-CLOCK: the OPEN surface repaints its deadline as the wall clock advances', () => {
    // WRONG IMPL KILLED ★: rendering the surface
    //   from `privacyModelState.countdown`. The model is pumped only when the phase or a
    //   permission flips, and neither moves for the whole grace window — so the
    //   status line would freeze at the value the `active -> grace` edge left behind, showing a
    //   day-0 deadline on day six, WHILE the `#privacy-countdown` HUD banner beside it — derived
    //   fresh every frame — showed the true remainder. Two contradictory deletion deadlines from
    //   one derivation, on a compliance surface.
    // WRONG IMPL KILLED (2): re-pumping `account-changed` every frame to keep it fresh. That
    //   clears `inFlight` on every frame and destroys the double-submit guard (A2-D9); it is why
    //   the fix is a RENDER path, not a model write. `RB52T-DELETE-WIRED` and the pure-tier
    //   `RB52C-DOUBLE-SUBMIT` are what keep that alternative closed.
    // WRONG IMPL KILLED (3): feeding `performance.now()` where the wall clock belongs — the two
    //   clocks below are stubbed to DIFFERENT values, so that wiring cannot pass both frames.
    H.account = ACCOUNT_PENDING_FUTURE;
    runFrameAt(0, WALL_T0);
    openPrivacySurface();

    const statusAt = (): string => byId('privacy-status').textContent ?? '';
    const first = statusAt();
    // ANTI-VACUITY, ASSERTED FIRST: the surface really is showing a countdown, not an empty
    // string — otherwise "it changed" below could be satisfied by two different flavours of blank.
    expect(first.length, 'the grace status line must not be empty').toBeGreaterThan(0);
    expect(
      hiddenAncestorOf(byId('privacy-status')),
      'the status line must be ON SCREEN for this tooth to mean anything',
    ).toBeNull();

    // Advance the WALL clock only. The perf clock moves too (a real rAF always does), but to a
    // different value, so neither can be mistaken for the other.
    runFrameAt(1, WALL_T0 + WALL_STEP_MS);
    const second = statusAt();
    expect(
      second,
      'the OPEN surface must repaint its deadline as the wall clock advances — a frozen status ' +
        'line is a stale legal deadline',
    ).not.toBe(first);
    expect(second.length, 'the repainted status line must not be blank').toBeGreaterThan(0);
  });

  it('RB52T-FRAME-DOES-NOT-CLEAR-INFLIGHT: an unchanged frame must not re-pump account-changed, so the in-flight lock survives', () => {
    // WRONG IMPL KILLED ★: dropping the
    //   `lastPrivacyCountdown = privacyCountdown` memo write, so the change-detector fires on
    //   EVERY frame. `privacyStep`'s `account-changed` arm writes `inFlight: 'none'`
    //   unconditionally, and `begin`'s only double-submit guard is `inFlight !== 'none'` — so at
    //   60fps that guard would have a ~16ms lifetime and a second click could issue a SECOND
    //   delete_account. ADR-0231 A2-D9 is exactly this decision; the pure-tier
    //   `RB52C-DOUBLE-SUBMIT` proves the MODEL holds the lock, and this proves the WIRING does
    //   not throw it away once per frame.
    // WRONG IMPL KILLED (2): a change-detector that compares the countdown by IDENTITY rather
    //   than by field — `deriveDeletionCountdown` returns a fresh object every frame, so an
    //   identity comparison is always "changed" and behaves exactly like the mutant above.
    H.account = ACCOUNT_ACTIVE;
    runFrame(0);
    openPrivacySurface();

    byId('privacy-delete-btn').click();
    byId('privacy-confirm-btn').click();
    expectOnlyReducer('delete');

    // ANTI-VACUITY, ASSERTED FIRST: the request really is in flight, i.e. the lock is genuinely
    // held right now. Without this, "still disabled after a frame" could be satisfied by a
    // surface whose controls were never enabled at all.
    const deleteBtn = byId('privacy-delete-btn') as HTMLButtonElement;
    expect(
      deleteBtn.disabled,
      'precondition: an in-flight delete must disable its own control',
    ).toBe(true);

    // A frame with NO row change. The countdown object is freshly derived, but every field the
    // detector compares is identical, so nothing may reach the model.
    runFrame(1);

    expect(
      (byId('privacy-delete-btn') as HTMLButtonElement).disabled,
      'an unchanged frame must NOT clear the in-flight lock — a per-frame account-changed pump ' +
        'destroys the only double-submit guard the model has',
    ).toBe(true);
    // And the reducer must still have been called exactly once, from the one confirmed click.
    expectOnlyReducer('delete');
  });
});

// ---------------------------------------------------------------------------------------------
// 21r-b2 — the privacy surface renders the FRENCH catalog when main.ts boots under fr.
//
// SOURCE OF TRUTH — spec 21r-b2: "WHEN any claim-overlay or privacy-surface text renders THE
// CLIENT SHALL source it from the typed catalog (en+fr), with no raw string literals reaching the
// DOM". The pure copy layer is swept key by key in privacyBanner.test.ts; this describe is the
// one end-to-end proof that main.ts's REAL boot negotiation reaches the painted surface.
// ---------------------------------------------------------------------------------------------

describe('main.ts privacy surface under a French boot (21r-b2)', () => {
  beforeEach(() => {
    setUpHarness();
  });

  afterEach(async () => {
    // The resolver main.ts switched lives in the CURRENT module registry (bootMain reset it), so
    // it is restored through a dynamic import, never a static one (see the file header).
    const resolver = await import('./ui/i18n/resolver');
    resolver.setLocale('en');
    window.history.replaceState(null, '', '/');
    tearDownHarness();
  });

  it('[21R-B2-WIRING-FR] booted with ?locale=fr, an already-erased account opens onto the French terminal notice and status line, beside the still-English disclosure', async () => {
    // WRONG IMPL KILLED (1) ★: privacyBanner.ts copy resolved at MODULE LOAD. main.ts imports
    //   privacyBanner.ts before its own module-scope `setLocale(LOCALE)` runs, so a module-level
    //   `t(...)` freezes English and the painted notice/status stay English under fr.
    // WRONG IMPL KILLED (2): the terminal notice / status left as raw English literals.
    // WRONG IMPL KILLED (3): the notice wired to the status key or vice versa — each node is
    //   compared with its OWN key.
    // WRONG IMPL KILLED (4): a "translate the disclosure too" edit that blanks or drops the raw
    //   §9 sentence under fr — it stays English (a French rendering needs a DECISIONS.md ruling
    //   first), and the toContain below pins that it is still on the surface.
    document.documentElement.removeAttribute('lang');
    await bootMain('/?locale=fr');
    const resolver = await import('./ui/i18n/resolver');
    // ANTI-VACUITY FIRST: the boot really negotiated fr. Without these, an un-awaited or
    // en-negotiated boot would make every assertion below a comparison against the wrong locale.
    expect(
      document.documentElement.lang,
      'main.ts must have negotiated fr from ?locale=fr and stamped <html lang>',
    ).toBe('fr');
    expect(resolver.currentLocale(), "main.ts's resolver must be switched to fr").toBe('fr');

    const noticeFr = catalogString(FR_CATALOG, 'fr', 'privacy.notice.terminal');
    const statusFr = catalogString(FR_CATALOG, 'fr', 'privacy.status.terminal');

    // The RB52T-TERMINAL-ROW-NO-CLICK flow: terminal row, one frame, open, no privacy click.
    H.account = ACCOUNT_TERMINAL;
    runFrame(0);
    openPrivacySurface();
    expectOnlyReducer('none');

    const notice = byId('privacy-notice');
    expect(notice.textContent, 'the terminal notice must render in French').toBe(noticeFr);
    expect(hiddenAncestorOf(notice), 'and it must be ON SCREEN').toBeNull();
    expect(byId('privacy-status').textContent, 'the status line must render in French').toBe(
      statusFr,
    );
    expect(
      byId('privacy-overlay').textContent ?? '',
      'the raw English section 9 disclosure must still be on the surface under fr',
    ).toContain(PRIVACY_PSEUDONYMIZATION_DISCLOSURE);
  });
});
