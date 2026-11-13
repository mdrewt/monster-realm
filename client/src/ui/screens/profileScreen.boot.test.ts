// @vitest-environment happy-dom
/**
 * profileScreen.boot.test.ts: the ONE Profile frame (uif-16b) booted through main.ts over the REAL
 * client/index.html shell, the REAL ProfileView and its three REAL sections (RenameView, ClaimView,
 * PrivacyView) and the REAL screen-adapter table (`SCREEN_ADAPTERS` is whatever ui/screens/index.ts
 * ships: no stand-in is swapped in).
 *
 * uif-16b (named intentional change, every case): Profile is one frame (`profileView`,
 * `#profile-overlay`) holding the Name, Account and Privacy sections and a Close row, in one
 * column. Was (ctl-8h): three frames of their own (renameView, claimView, privacyView) picked from a
 * Profile sub-list. Each ctl-8h case is REPLACED by its frame-level equivalent, named in the case:
 * - UIF16B.1: one A on Profile opens the one frame, the three sections shown inside it, with their
 *   section headers, the Close row last and the retired `#privacy-close-btn` gone.
 * - UIF16B.2: the D-pad walks one column (Name field, Save, the Account rows, the privacy door, the
 *   enabled Privacy rows, Close), clamped; B pops the frame to the menu on Profile, Start to the base.
 * - UIF16B.3: exactly one live aria-modal root (the frame); the privacy door moves focus and opens
 *   nothing.
 * - UIF16B.4: the commands and guards of the three surfaces (replaces CTL8H-2, -3, -4): a saved
 *   name, Sign in, the two-step decline and delete; every close disarms both confirms; the Name
 *   field's typing rule and its Escape (focus lands on a SHOWN, ENABLED control in the frame, the
 *   No / Keep row when a confirm is armed).
 * - UIF16B.5: where the frame opens (replaces CTL8H-5-N / -C, whose accelerator halves are
 *   main.accel.test.ts's UIF16B.5 cases): the menu on a FRESH session opens on Name, a failed
 *   sign-in and a claim lifecycle paint open on Account, and a claim event never pulls the player
 *   out of the Name field.
 * UIF16B.6 (battle, reconnect) is main.reconnectStack.test.ts's.
 *
 * EVERY key is dispatched ON `document.activeElement` (or on `window` for the main menu's own
 * keys and the accelerators), bubbling, like a real browser, and a focused <button> is CLICKED on
 * Enter's keydown when the page did not prevent it: happy-dom does not synthesize that native
 * activation, a browser does. The deferred initial focus (one macrotask after an open, from
 * ui/overlayA11y.ts) is flushed before the first key. happy-dom "focuses" disabled and
 * `display:none` nodes, so every focus assertion on a control also asserts it is enabled and shown
 * (`expectSafeFocus`).
 *
 * Harness: journalScreen.boot.test.ts's (the real shell mounted, main.ts imported fresh per boot,
 * only the wasm pkg, the connection, telemetry and the world renderer stubbed), with four deltas:
 * every reducer call is recorded with its arguments, `startSignIn` is counted, the claim code's
 * `clear` is a spy (the decline path's one local effect), and the account row is injected into the
 * store (the privacy lattice is derived from it, and the controllable rAF pumps it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountIndexHtmlShell } from '../../../test-util/mainBootHarness';
import type { WasmMoveInput } from '../../convert/convert';
import type { Connection, ConnectionOptions } from '../../net/connection';
import { t } from '../i18n/resolver';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every reducer call except enqueueMove, oldest first, with the exact argument object. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** How many times the connection was asked to start a sign-in (the claim's Sign in). */
  signIns: 0,
  /** The injected `store.ownAccount(identity)` row; undefined falls through to the real one. */
  account: undefined as unknown,
  /** The claim code's `clear`: what the decline path runs when it is confirmed. */
  claimClear: vi.fn(),
}));

// wasm pkg: every name main.ts imports.
vi.mock('../../../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 8;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: (state: unknown) => state,
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 37,
    talk_range: () => 2,
    predict_move: () => ({}),
    predict_tick: () => ({}),
    set_active_zone: () => undefined,
    start: () => undefined,
    step_ms: () => 200,
    zone_map: (zoneId: number) => ({
      zone_id: zoneId,
      width: SIDE,
      height: SIDE,
      walkable: grid(true),
      grass: grid(false),
      warps: [],
    }),
  };
});

// The connection: capture the options; enqueueMove never settles, every other reducer records its
// name and arguments and resolves at once; startSignIn is counted. sessionState() must be 'hidden'
// or the session gate swallows every key. The ONE store read the privacy lattice is derived from
// is wrapped so a case can inject an account row (main.privacyWiring.test.ts's injection point).
vi.mock('../../net/connection', () => {
  const reducers = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'enqueueMove') return () => new Promise<void>(() => {});
        return (args: unknown) => {
          H.calls.push({ name: String(name), args });
          return Promise.resolve();
        };
      },
    },
  );
  const live = { reducers };
  const stub = {
    conn: undefined,
    live: () => live,
    identity: () => H.identity,
    linkFrozen: () => false,
    worldScope: () => ({ own: null, zones: [], settled: false }),
    continueAnonymously: () => undefined,
    sessionState: () => 'hidden',
    startSignIn: () => {
      H.signIns += 1;
    },
    reconnectNow: () => undefined,
  } as unknown as Connection;
  return {
    connect: (opts: ConnectionOptions): Connection => {
      H.connectOpts = opts;
      const store = opts.store as unknown as { ownAccount: (id: string) => unknown };
      const realOwnAccount = store.ownAccount.bind(opts.store);
      store.ownAccount = (id: string) => H.account ?? realOwnAccount(id);
      return stub;
    },
  };
});

// The claim code primitive: the real one, with `clear` replaced by a spy. main.ts calls it exactly
// when a confirmed decline deletes the stored claim code.
vi.mock('../../net/claimCode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../net/claimCode')>();
  return { ...actual, claimCode: { ...actual.claimCode, clear: H.claimClear } };
});

vi.mock('../../observability/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../observability/telemetry')>();
  return {
    ...actual,
    loadOtelSdk: () => {
      throw new Error('loadOtelSdk must not be reached in this test');
    },
    startClientTelemetry: () => Promise.resolve(actual.NOOP_TELEMETRY),
  };
});

// The renderer: init appends a focusable canvas to the mount, so main.ts finds its world region.
vi.mock('../../render/world', () => {
  class WorldRenderer {
    init(mount: HTMLElement): Promise<void> {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('tabindex', '0');
      canvas.setAttribute('role', 'application');
      mount.appendChild(canvas);
      return Promise.resolve();
    }
    setMap(): void {}
    render(): void {}
    resize(): void {}
    screenFor(): { x: number; y: number } {
      return { x: 0, y: 0 };
    }
    clear(): void {}
    destroy(): void {}
    get viewCount(): number {
      return 0;
    }
  }
  return { WorldRenderer };
});

// --- harness ------------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

/** Record every listener added to `target`, so the teardown removes main.ts's module-scope ones
 *  (a fresh import per boot would otherwise stack them). */
function recordListeners(target: EventTarget): void {
  const own = Object.getOwnPropertyDescriptor(target, 'addEventListener');
  const original = target.addEventListener.bind(target);
  (target as unknown as { addEventListener: typeof original }).addEventListener = (
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    recorded.push({ target, type, handler, options });
    original(type, handler, options);
  };
  restorers.push(() => {
    if (own !== undefined) Object.defineProperty(target, 'addEventListener', own);
    else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
  });
}

const clock = { t: 0 };
/** The test's own monotonic time: every key and batch moves it on by 100 ms. */
let tick = 1000;
let rafCallback: FrameRequestCallback | null = null;
let opts: ConnectionOptions;

/** Boot a fresh main.ts over the real shell and wait for it to connect (no onReady yet). */
async function bootConnected(): Promise<void> {
  H.connectOpts = null;
  H.calls = [];
  H.signIns = 0;
  H.account = undefined;
  H.claimClear.mockClear();
  tick = 1000;
  clock.t = tick;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  rafCallback = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallback = cb;
    return 0;
  });
  vi.resetModules();
  await import('../../main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
}

/** Boot and join (onReady). */
async function bootReady(): Promise<void> {
  await bootConnected();
  opts.onReady(H.identity);
}

function teardownBoot(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rafCallback = null;
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
}

/** Let queued microtasks and zero-delay timers run (the deferred focus). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const EID = 7n;

/** Deliver one authoritative batch: the own player + character. */
function server(): void {
  tick += 100;
  clock.t = tick;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    lastInputSeq: 0n,
  });
  opts.store.upsertCharacter(
    {
      entityId: EID,
      zoneId: 0,
      tileX: 2,
      tileY: 6,
      facing: 'East',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
      ackedSeq: 0n,
    },
    tick,
  );
  opts.store.flushBatch();
}

/** Run one frame (the privacy lattice is pumped from the injected account row in the frame). */
function frame(): void {
  const cb = rafCallback;
  if (cb === null) throw new Error('no rAF callback armed');
  rafCallback = null;
  tick += 100;
  clock.t = tick;
  cb(tick);
  if (rafCallback === null) throw new Error('the frame did not re-arm requestAnimationFrame');
}

/** One key press, then its release. The keydown goes to `target` (default: the element that has
 *  focus, else the body); a focused <button> then clicks on Enter unless the page prevented the
 *  keydown, as a browser does (happy-dom does not). */
function press(code: string, target?: EventTarget): KeyboardEvent {
  tick += 100;
  clock.t = tick;
  const at: EventTarget = target ?? document.activeElement ?? document.body;
  const down = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
  at.dispatchEvent(down);
  if (
    code === 'Enter' &&
    at instanceof HTMLButtonElement &&
    !down.defaultPrevented &&
    !at.disabled
  ) {
    at.click();
  }
  clock.t = tick + 5;
  const upAt: EventTarget = target ?? document.activeElement ?? document.body;
  upAt.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
  return down;
}

/** A key aimed at `window` itself: the main menu's own keys and the accelerators. */
const pressWindow = (code: string): KeyboardEvent => press(code, window);

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} must be in the document`);
  return found;
}

/** Shown unless the element or an ancestor has an inline `display:none`. */
const isShown = (node: Element): boolean => {
  for (let n: Element | null = node; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none') return false;
  }
  return true;
};
const shown = (id: string): boolean => isShown(el(id));

/** The frame root and its three sections, shown or not, in one read. */
const frameShown = (): Record<string, boolean> => ({
  frame: shown('profile-overlay'),
  name: shown('rename-overlay'),
  account: shown('claim-overlay'),
  privacy: shown('privacy-overlay'),
});
const ALL_SHOWN = { frame: true, name: true, account: true, privacy: true };
const ALL_HIDDEN = { frame: false, name: false, account: false, privacy: false };

/** Put `text` into a field the way a user does: set the value, then fire its input event. */
function typeInto(field: HTMLInputElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

const focusedId = (): string => (document.activeElement as HTMLElement | null)?.id ?? '';

/** Focus is on a control a player can see and operate, INSIDE the Profile frame: inside
 *  `#profile-overlay`, not disabled, and neither it nor any ancestor is `display:none` (happy-dom
 *  "focuses" both, so the bare focus would prove nothing). Returns the focused element. */
function expectSafeFocus(label: string): HTMLElement {
  const active = document.activeElement;
  expect(
    active instanceof HTMLElement && el('profile-overlay').contains(active),
    `${label}: focus is inside the Profile frame (was #${focusedId()})`,
  ).toBe(true);
  const node = active as HTMLElement;
  expect((node as HTMLButtonElement).disabled === true, `${label}: on an enabled control`).toBe(
    false,
  );
  expect(isShown(node), `${label}: that is on screen`).toBe(true);
  return node;
}

/** Which section holds focus: 'name' | 'account' | 'privacy' | 'close' | 'outside'. */
function focusSection(): string {
  const a = document.activeElement;
  if (a === null) return 'outside';
  if (el('rename-overlay').contains(a)) return 'name';
  if (el('claim-overlay').contains(a)) return 'account';
  if (el('privacy-overlay').contains(a)) return 'privacy';
  if (a.id === 'profile-close-btn') return 'close';
  return 'outside';
}

/** Press `code` up to `n` times on the focused element, recording the focused id after each (and
 *  asserting each landing is a safe control inside the frame). */
function walk(code: string, n: number): string[] {
  const seen: string[] = [];
  for (let i = 0; i < n; i += 1) {
    press(code);
    expectSafeFocus(`${code} #${i + 1}`);
    seen.push(focusedId());
  }
  return seen;
}

/** The whole context stack through the read-only `__game()` DEV hook, as base-first frame names. */
interface GameHook {
  readonly stack: Array<{ kind: string; id?: string }>;
  readonly navActive: string | null;
}
const game = (): GameHook => (window as unknown as { __game: () => GameHook }).__game();
const stackNames = (): string[] =>
  game().stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));
const OVER_MENU = ['world', 'menuView', 'profileView'];

const callsOf = (name: string): Array<{ name: string; args: unknown }> =>
  H.calls.filter((c) => c.name === name);

/** M opens the main menu; four Downs reach Profile (Monsters, Bag, Journal, Social, Profile); ONE A
 *  opens the frame above the menu. The menu's own keys are aimed at the window. */
function openProfileFromMenu(): void {
  pressWindow('KeyM');
  expect(shown('menu-overlay'), 'precondition: M opened the main menu').toBe(true);
  for (let i = 0; i < 4; i += 1) pressWindow('ArrowDown');
  expect(game().navActive, 'precondition: the cursor is on Profile').toBe('profile');
  pressWindow('Enter');
}

/** A whole `StoreAccount`-shaped row for an Active account: delete and export permitted. */
const accountActive = (): Record<string, unknown> => ({
  identity: H.identity,
  authIssuer: 'uif16b-test-issuer',
  createdAtMs: 1n,
  lastLoginAtMs: 2n,
  status: 'Active',
  deletionRequestedAtMs: undefined,
  claimedFrom: undefined,
  claimedAtMs: undefined,
  terminalAtMs: undefined,
});

/** Every `[role="dialog"][aria-modal="true"]` root on screen and not suspended (no inert, no
 *  aria-hidden="true" and no hidden visibility on it or an ancestor), by id. */
function liveModalDialogs(): string[] {
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
    .filter((d) => {
      if (!isShown(d)) return false;
      for (let n: Element | null = d; n instanceof HTMLElement; n = n.parentElement) {
        if (n.hasAttribute('inert')) return false;
        if (n.getAttribute('aria-hidden') === 'true') return false;
        if (n.style.visibility === 'hidden') return false;
      }
      return true;
    })
    .map((d) => d.id);
}

/** KeyC: Profile on Account, then the D-pad onto Decline and Enter: the decline is armed and focus
 *  is on No. */
function armDecline(label: string): void {
  pressWindow('KeyC');
  expect(focusedId(), `${label}: KeyC seats Sign in`).toBe('claim-signin-btn');
  press('ArrowDown');
  expect(focusedId(), `${label}: Down to Decline`).toBe('claim-decline-btn');
  press('Enter');
  expect(focusedId(), `${label}: armed, focus on No`).toBe('claim-decline-cancel-btn');
  expect(shown('claim-decline-confirm-btn'), `${label}: Yes is shown`).toBe(true);
}

/** KeyC, the privacy door, Enter on Delete: the deletion is armed and focus is on Keep (an Active
 *  account must be injected and pumped first). */
function armDelete(label: string): void {
  pressWindow('KeyC');
  el('claim-privacy-btn').focus();
  press('Enter');
  expect(focusedId(), `${label}: the door seats Delete`).toBe('privacy-delete-btn');
  press('Enter');
  expect(focusedId(), `${label}: armed, focus on Keep`).toBe('privacy-confirm-cancel-btn');
  expect((el('privacy-confirm').textContent ?? '').length, `${label}: the prompt`).toBeGreaterThan(
    0,
  );
}

describe('the one Profile frame booted through main.ts over the real views and adapter table (uif-16b)', {
  sequential: true,
}, () => {
  afterEach(teardownBoot);

  // ------------------------------------------------------------------------------------------
  // UIF16B.1: one frame, three sections
  // ------------------------------------------------------------------------------------------

  it('UIF16B.1 Start, walk to Profile, ONE A opens ONE frame: the stack is [world, menuView, profileView], #profile-overlay shows the Name, Account and Privacy sections in that order with their section headers and the Close row last, and the retired #privacy-close-btn is gone', async () => {
    // Replaces CTL8H-2-BOOT-TYPING-COMMIT's "Menu, Profile, Name" open (its commit half is the
    // UIF16B.4 name case below).
    // WRONG IMPL KILLED: a Profile sub-list (one A lands on `name`, no frame); a frame showing one
    // section (the old one-frame-per-surface shape); sections constructed outside the frame root
    // (a section shown alone in the frame layer); a section order other than Name, Account,
    // Privacy, Close; a missing or wrong section header; a frame title not written; the old privacy
    // close anchor left beside the frame's Close (two Close rows in one column).
    await bootReady();
    server();
    openProfileFromMenu();
    expect(stackNames(), 'one A: the frame over the menu').toEqual(OVER_MENU);
    expect(frameShown(), 'the frame and all three sections are shown').toEqual(ALL_SHOWN);
    expect(game().navActive, 'the menu beneath is on Profile').toBe('profile');

    const root = el('profile-overlay');
    expect(
      [
        ...root.querySelectorAll(
          '#rename-overlay, #claim-overlay, #privacy-overlay, #profile-close-btn',
        ),
      ].map((n) => n.id),
      'the sections, then Close, inside the one frame, in order',
    ).toEqual(['rename-overlay', 'claim-overlay', 'privacy-overlay', 'profile-close-btn']);
    expect(el('profile-title').textContent, 'the one frame title').toBe(t('menu.profile.title'));
    const headers: ReadonlyArray<readonly [string, string, string]> = [
      ['rename-title', 'rename-overlay', t('menu.profile.name.title')],
      ['claim-frame-title', 'claim-overlay', t('menu.profile.account.title')],
      ['privacy-title', 'privacy-overlay', t('privacy.title')],
    ];
    for (const [id, section, text] of headers) {
      const header = el(id);
      expect(header.textContent, `#${id}: the section header text`).toBe(text);
      expect(header.classList.contains('mr-section-header'), `#${id}: a section header`).toBe(true);
      expect(el(section).contains(header), `#${id}: inside its own section`).toBe(true);
      expect(isShown(header), `#${id}: on screen`).toBe(true);
    }
    expect(el('profile-close-btn').textContent, 'the Close row').toBe(t('privacy.close'));
    expect(document.getElementById('privacy-close-btn'), 'the privacy close anchor retired').toBe(
      null,
    );
  });

  it('UIF16B.5 menu, then Profile on a FRESH session (claim phase still hidden) opens on Name: focus lands on #rename-input after the deferred focus, while the Account section already offers Sign in and Decline', async () => {
    // Plan review B-1. WRONG IMPL KILLED: an open that steps the claim model through its painting
    // path (`renderClaim`): a fresh session's first `claim-ui-opened` makes the phase visible, the
    // paint reads that as the claim auto-open and opens Profile on ACCOUNT first, so focus lands on
    // Sign in and the deferred Name anchor is skipped (focus already inside the root); and an open
    // that never steps the model at all (the Account section shows no action rows on a fresh
    // session: an empty section with only the privacy door).
    await bootReady();
    server();
    expect(frameShown(), 'precondition: nothing is open').toEqual(ALL_HIDDEN);
    openProfileFromMenu();
    expect(stackNames()).toEqual(OVER_MENU);
    await flush();
    expect(document.activeElement, 'focus is on the Name field').toBe(el('rename-input'));
    expect(focusSection(), 'in the Name section').toBe('name');
    expect(
      ['claim-signin-btn', 'claim-decline-btn'].map(shown),
      'the Account section offers its prompt rows',
    ).toEqual([true, true]);
  });

  // ------------------------------------------------------------------------------------------
  // UIF16B.2: one column, B and Start
  // ------------------------------------------------------------------------------------------

  it('UIF16B.2 the D-pad walks ONE column in visual order (Name field, Save with a valid draft, the Account rows, the privacy door, the enabled Privacy rows, Close), clamped at Close, and back up to the field; with no account the Privacy rows are Export alone, with an Active account Delete then Export', async () => {
    // WRONG IMPL KILLED: a walk confined to one section (Down at the last Account row stays put);
    // a column in another order (Privacy before Account, Close first); rows that include a hidden
    // or disabled control (the disabled Cancel or Download, the hidden decline confirm, a disabled
    // Save); a walk that wraps at Close (repeat or fresh, the column clamps); Close missing from the
    // column; a Save that shields the D-pad (B5: Up from Save must reach the field).
    const fixtures: ReadonlyArray<{
      readonly label: string;
      readonly account: boolean;
      readonly privacy: readonly string[];
    }> = [
      { label: 'no account row', account: false, privacy: ['privacy-export-btn'] },
      {
        label: 'an Active account',
        account: true,
        privacy: ['privacy-delete-btn', 'privacy-export-btn'],
      },
    ];
    let driven = 0;
    for (const fx of fixtures) {
      await bootReady();
      if (fx.account) H.account = accountActive();
      server();
      frame();
      openProfileFromMenu();
      await flush();
      const field = el('rename-input') as HTMLInputElement;
      expect(document.activeElement, `${fx.label}: precondition: the field`).toBe(field);
      typeInto(field, 'Bob');
      press('Escape');
      expect(focusedId(), `${fx.label}: Escape with a draft lands on Save`).toBe('rename-submit');

      const account = ['claim-signin-btn', 'claim-decline-btn', 'claim-privacy-btn'];
      const down = [...account, ...fx.privacy, 'profile-close-btn'];
      expect(walk('ArrowDown', down.length + 1), `${fx.label}: Down from Save, clamped`).toEqual([
        ...down,
        'profile-close-btn',
      ]);
      const up = [...down.slice(0, -1)].reverse();
      expect(walk('ArrowUp', up.length + 1), `${fx.label}: Up from Close`).toEqual([
        ...up,
        'rename-submit',
      ]);
      press('ArrowUp');
      expect(document.activeElement, `${fx.label}: Up from Save: the field`).toBe(field);
      expect(field.value, `${fx.label}: the draft survived the walk`).toBe('Bob');
      expect(stackNames(), `${fx.label}: the walk opened and closed nothing`).toEqual(OVER_MENU);
      expect(callsOf('setProfileName'), `${fx.label}: and sent nothing`).toEqual([]);
      driven += 1;
      teardownBoot();
    }
    expect(driven, 'ANTI-VACUITY: both fixtures were walked').toBe(2);
  });

  it('UIF16B.2 B pops the frame back to the menu with its cursor on Profile; A on Profile reopens it; Start pops the frame and the menu to the base; every section closes with the frame', async () => {
    // Replaces CTL8H-3-BOOT-DPAD's "Backspace pops the frame" half.
    // WRONG IMPL KILLED: a B that pops a section but leaves the frame (or the reverse); a B that
    // pops the menu too; a return onto a stale Profile sub-list; a Start that only pops the frame;
    // a section left on screen behind a closed frame.
    await bootReady();
    server();
    openProfileFromMenu();
    await flush();
    press('Escape'); // stop typing: focus leaves the field for a control in the frame
    expectSafeFocus('after stop typing');
    expect(stackNames(), 'precondition: still open').toEqual(OVER_MENU);

    press('Backspace');
    expect(stackNames(), 'B pops the frame').toEqual(['world', 'menuView']);
    expect(frameShown(), 'the frame and its sections are closed').toEqual(ALL_HIDDEN);
    expect(shown('menu-overlay'), 'the menu is on screen').toBe(true);
    expect(game().navActive, 'its cursor on Profile').toBe('profile');
    expect(el('menu-rows').getAttribute('aria-activedescendant'), 'the root row').toBe(
      'menu-root-profile',
    );

    pressWindow('Enter');
    expect(stackNames(), 'A on Profile reopens it').toEqual(OVER_MENU);
    await flush();
    press('Escape'); // stop typing
    const at = expectSafeFocus('stop typing again');
    press('Escape', at); // Start, from a control in the frame
    expect(stackNames(), 'Start pops to the base').toEqual(['world']);
    expect(frameShown(), 'every section closed').toEqual(ALL_HIDDEN);
    expect(shown('menu-overlay'), 'and the menu').toBe(false);
  });

  // ------------------------------------------------------------------------------------------
  // UIF16B.3: one dialog, one trap
  // ------------------------------------------------------------------------------------------

  it('UIF16B.3 with Profile open exactly one live [role="dialog"][aria-modal="true"] exists (the frame; the menu beneath is suspended), no section carries a dialog role, and the privacy door moves focus into the Privacy section (Delete, for an Active account) and opens nothing', async () => {
    // WRONG IMPL KILLED: a section that kept its own dialog role or aria-modal (the static
    // `#rename-overlay` markup left as it was: two live modal roots); a menu beneath that stays a
    // live modal; a door that hides Account or pushes a frame (the old openPrivacy verdict); a door
    // that focuses the Privacy section's first DOM button whatever its state, or nothing.
    await bootReady();
    H.account = accountActive();
    server();
    frame();
    pressWindow('KeyC');
    expect(stackNames(), 'KeyC: the frame over the menu').toEqual(OVER_MENU);
    await flush();
    expect(liveModalDialogs(), 'one live modal root').toEqual(['profile-overlay']);
    for (const id of ['rename-overlay', 'claim-overlay', 'privacy-overlay']) {
      expect(el(id).getAttribute('role'), `#${id} is no dialog of its own`).not.toBe('dialog');
      expect(el(id).getAttribute('aria-modal'), `#${id} is not modal`).toBe(null);
    }

    el('claim-privacy-btn').focus();
    press('Enter');
    expect(focusSection(), 'the door moved focus into Privacy').toBe('privacy');
    expect(expectSafeFocus('the door').id, 'onto Delete').toBe('privacy-delete-btn');
    expect(stackNames(), 'it opened nothing').toEqual(OVER_MENU);
    expect(frameShown(), 'and hid nothing').toEqual(ALL_SHOWN);
    expect(liveModalDialogs(), 'still one live modal root').toEqual(['profile-overlay']);
  });

  // ------------------------------------------------------------------------------------------
  // UIF16B.4: the same commands, the same guards
  // ------------------------------------------------------------------------------------------

  it('UIF16B.4 a saved name dispatches setProfileName exactly once with the trimmed name, by Enter in the field and by A on Save, and the frame stays open', async () => {
    // Replaces CTL8H-2-BOOT-TYPING-COMMIT's commit half.
    // WRONG IMPL KILLED: an adapter that swallows the field's Enter; a commit sent twice (the
    // adapter's A and the field's own Enter both firing, or Save's click and the router's A); an
    // untrimmed name; a frame A that presses Save while focus is in the field.
    await bootReady();
    server();
    openProfileFromMenu();
    await flush();
    const field = el('rename-input') as HTMLInputElement;
    typeInto(field, '  Bob ');
    press('Enter');
    expect(callsOf('setProfileName'), 'Enter in the field: the trimmed name, once').toEqual([
      { name: 'setProfileName', args: { name: 'Bob' } },
    ]);
    await flush();
    expect(callsOf('setProfileName'), 'and still once').toHaveLength(1);
    expect(stackNames(), 'the frame stays open').toEqual(OVER_MENU);

    H.calls = [];
    field.focus();
    typeInto(field, ' Ann  ');
    press('Escape');
    expect(focusedId(), 'precondition: Save').toBe('rename-submit');
    press('Enter');
    expect(callsOf('setProfileName'), 'A on Save: the trimmed name, once').toEqual([
      { name: 'setProfileName', args: { name: 'Ann' } },
    ]);
    await flush();
    expect(callsOf('setProfileName'), 'and still once').toHaveLength(1);
    expect(stackNames(), 'the frame stays open').toEqual(OVER_MENU);
  });

  it('UIF16B.4 letters typed in the Name field (n, c, b, the D-pad letters and more) are typed and open nothing: unprevented, the stack, the frame and the field`s focus unchanged', async () => {
    // WRONG IMPL KILLED: an accelerator or a D-pad letter taken from the field (the player could not
    // type a name with n, c, w, a, s or d in it), a letter that is prevented (it never reaches the
    // field), and N or C acting on the frame (moving focus between sections) while the field types.
    await bootReady();
    server();
    pressWindow('KeyN');
    await flush();
    const field = el('rename-input') as HTMLInputElement;
    expect(document.activeElement, 'precondition: the field').toBe(field);
    for (const code of ['KeyN', 'KeyC', 'KeyB', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyM', 'KeyJ']) {
      const down = press(code);
      expect(down.defaultPrevented, `${code}: left to the field`).toBe(false);
      expect(stackNames(), `${code}: the stack is unchanged`).toEqual(OVER_MENU);
      expect(frameShown(), `${code}: the frame is unchanged`).toEqual(ALL_SHOWN);
      expect(document.activeElement, `${code}: the field keeps focus`).toBe(field);
    }
  });

  it('UIF16B.4 Escape in the Name field stops typing and the frame stays open: with a valid draft focus lands on Save (draft kept); with an empty draft on a SHOWN, ENABLED control inside the frame (never the hidden or disabled Save); with the decline armed on No and with the deletion armed on Keep, never on Yes or Confirm', async () => {
    // Replaces CTL8H-2-STOP-TYPING-IN-FRAME (named intentional change: its empty-draft arm read
    // "focus ends on the page"; in one column there is always a control to land on, so it now
    // lands inside the frame).
    // WRONG IMPL KILLED: a stop-typing that lands on the next control in DOM order whatever it is (a
    // disabled Save, a hidden decline row, an armed Yes or Confirm: one more Enter would decline the
    // claim or delete the account); one that strands focus on the page; one that wipes the draft;
    // the Name section's old Escape that hides the section (the frame would be left without it).
    await bootReady();
    H.account = accountActive();
    server();
    frame();
    pressWindow('KeyN');
    await flush();
    const field = el('rename-input') as HTMLInputElement;
    const save = el('rename-submit') as HTMLButtonElement;

    typeInto(field, 'Bob');
    const typed = press('Escape');
    expect(typed.defaultPrevented, 'the stop-typing press is prevented').toBe(true);
    expect(focusedId(), 'a valid draft: Save').toBe('rename-submit');
    expectSafeFocus('a valid draft');
    expect(field.value, 'the draft is kept').toBe('Bob');
    expect(frameShown(), 'the frame stays open').toEqual(ALL_SHOWN);

    field.focus();
    typeInto(field, '');
    expect(save.disabled, 'precondition: an empty draft disables Save').toBe(true);
    press('Escape');
    const landed = expectSafeFocus('an empty draft');
    expect(landed, 'an empty draft: not the field').not.toBe(field);
    expect(landed, 'and not the disabled Save').not.toBe(save);
    expect(stackNames(), 'the frame stays open').toEqual(OVER_MENU);

    // The decline armed, then back in the field with an empty draft.
    pressWindow('Escape');
    expect(stackNames(), 'precondition: Start closed the frame').toEqual(['world']);
    armDecline('decline');
    field.focus();
    press('Escape');
    expect(focusedId(), 'decline armed: No, never Yes').toBe('claim-decline-cancel-btn');
    expectSafeFocus('decline armed');
    expect(H.claimClear, 'nothing was declined').not.toHaveBeenCalled();
    expect(stackNames(), 'the frame stays open').toEqual(OVER_MENU);

    // The deletion armed (a fresh open: the close disarmed the decline).
    pressWindow('Escape');
    armDelete('delete');
    field.focus();
    press('Escape');
    expect(focusedId(), 'delete armed: Keep, never Confirm').toBe('privacy-confirm-cancel-btn');
    expectSafeFocus('delete armed');
    expect(callsOf('deleteAccount'), 'nothing was deleted').toEqual([]);
    expect(stackNames(), 'the frame stays open').toEqual(OVER_MENU);
  });

  it('UIF16B.4 the claim actions fire the same commands as before: Sign in starts one sign-in; Decline then No disarms (back on Decline) and deletes nothing; Decline then Yes runs the decline once', async () => {
    // Replaces CTL8H-3-BOOT-DPAD (its D-pad half is UIF16B.2's walk).
    // WRONG IMPL KILLED: a Sign in that never reaches the connection or reaches it twice; an arm
    // that lands on Yes; a No that does not disarm or that declines; a disarm that strands focus;
    // a Yes that never runs the decline or runs it twice; any of them sending a reducer call.
    await bootReady();
    server();
    pressWindow('KeyC');
    expect(focusedId(), 'KeyC seats Sign in').toBe('claim-signin-btn');
    press('Enter');
    expect(H.signIns, 'Sign in starts one sign-in').toBe(1);

    if (!shown('profile-overlay')) pressWindow('KeyC');
    el('claim-decline-btn').focus();
    press('Enter');
    expect(focusedId(), 'armed: focus on No').toBe('claim-decline-cancel-btn');
    press('Enter');
    expect(shown('claim-decline-cancel-btn'), 'No disarms').toBe(false);
    expect(el('claim-confirm').textContent, 'no prompt left').toBe('');
    expect(focusedId(), 'focus back on the armer').toBe('claim-decline-btn');
    expect(H.claimClear, 'No declines nothing').not.toHaveBeenCalled();

    press('Enter');
    expect(focusedId(), 'armed again: No').toBe('claim-decline-cancel-btn');
    press('ArrowUp');
    expect(focusedId(), 'Up from No: Yes').toBe('claim-decline-confirm-btn');
    press('Enter');
    expect(H.claimClear, 'Yes runs the decline once').toHaveBeenCalledTimes(1);
    expect(H.calls, 'no reducer call').toEqual([]);
  });

  it('UIF16B.4 the two-step delete: Delete arms with focus on Keep, Keep sends nothing and returns to Delete, armed again Confirm sends deleteAccount exactly once', async () => {
    // Replaces CTL8H-4-BOOT-TWO-STEP (named intentional change: the open is KeyC then the privacy
    // door; was the Profile sub-list's Privacy leaf, with focus on the retired Close anchor).
    // WRONG IMPL KILLED: an arm that leaves focus on the button it armed from, or on Confirm (one
    // more Enter would delete the account); a Keep that does not disarm or that calls a reducer; a
    // Confirm that never reaches the reducer, or reaches it twice.
    await bootReady();
    H.account = accountActive();
    server();
    frame();
    armDelete('delete');
    expect(callsOf('deleteAccount'), 'arming sends nothing').toEqual([]);
    press('Enter');
    expect(el('privacy-confirm').textContent ?? '', 'Keep disarms').toBe('');
    expect(focusedId(), 'back on Delete').toBe('privacy-delete-btn');
    expect(callsOf('deleteAccount'), 'Keep sends nothing').toEqual([]);

    press('Enter');
    expect(focusedId(), 'armed again: Keep').toBe('privacy-confirm-cancel-btn');
    press('ArrowUp');
    expect(focusedId(), 'Up from Keep: Confirm').toBe('privacy-confirm-btn');
    press('Enter');
    expect(callsOf('deleteAccount'), 'Confirm deletes once').toEqual([
      { name: 'deleteAccount', args: {} },
    ]);
    await flush();
    expect(callsOf('deleteAccount'), 'and only once').toHaveLength(1);
  });

  it('UIF16B.4 closing the frame by B, by Start, by the Close row or by a reconnect disarms an armed decline AND an armed deletion: the reopened frame shows no Yes / No and no Confirm / Keep, and nothing was declined or deleted', async () => {
    // WRONG IMPL KILLED (plan review RT-1): a decline that stays armed behind a closed frame (one
    // column makes its Yes reachable from the Name field: the next Enter after a Down declines the
    // claim); a privacy disarm wired only to one close path; a close path that confirms instead of
    // cancelling; a Close row that hides the frame without the sections' own hide.
    await bootReady();
    H.account = accountActive();
    server();
    frame();
    const closes: ReadonlyArray<readonly [string, () => void]> = [
      ['B', () => press('Backspace')],
      ['Start', () => press('Escape')],
      [
        'the Close row',
        () => {
          for (let i = 0; i < 12 && focusedId() !== 'profile-close-btn'; i += 1) press('ArrowDown');
          expect(focusedId(), 'precondition: on Close').toBe('profile-close-btn');
          press('Enter');
        },
      ],
      ['a reconnect', () => opts.onReconnect(H.identity)],
    ];
    let driven = 0;
    for (const [how, close] of closes) {
      armDecline(`${how} / decline`);
      close();
      expect(frameShown(), `${how} / decline: the frame closed`).toEqual(ALL_HIDDEN);
      expect(el('claim-decline-confirm-btn').style.display, `${how}: Yes painted away`).toBe(
        'none',
      );
      pressWindow('KeyC');
      expect(frameShown(), `${how}: reopened`).toEqual(ALL_SHOWN);
      expect(
        ['claim-decline-confirm-btn', 'claim-decline-cancel-btn'].map(shown),
        `${how}: no Yes / No on the reopened frame`,
      ).toEqual([false, false]);
      expect(shown('claim-decline-btn'), `${how}: Decline is offered again`).toBe(true);
      expect(focusedId(), `${how}: the reopen seats Sign in, not No`).toBe('claim-signin-btn');
      pressWindow('Escape');

      armDelete(`${how} / delete`);
      close();
      expect(frameShown(), `${how} / delete: the frame closed`).toEqual(ALL_HIDDEN);
      expect(el('privacy-confirm').textContent, `${how}: the delete prompt is cleared`).toBe('');
      pressWindow('KeyC');
      el('claim-privacy-btn').focus();
      press('Enter');
      expect(focusedId(), `${how}: the reopened door seats Delete, not Keep`).toBe(
        'privacy-delete-btn',
      );
      expect(
        ['privacy-confirm-btn', 'privacy-confirm-cancel-btn'].map(shown),
        `${how}: no Confirm / Keep on the reopened frame`,
      ).toEqual([false, false]);
      pressWindow('Escape');
      driven += 1;
    }
    expect(driven, 'ANTI-VACUITY: all four close paths were driven').toBe(4);
    expect(H.claimClear, 'nothing was declined').not.toHaveBeenCalled();
    expect(callsOf('deleteAccount'), 'nothing was deleted').toEqual([]);
  });

  // ------------------------------------------------------------------------------------------
  // UIF16B.5: where the frame opens
  // ------------------------------------------------------------------------------------------

  // CTL8H-5-N-OPENS-NAME-TYPING and CTL8H-5-C-OPENS-ACCOUNT are DELETED here (uif-16b, named): KeyN
  // and KeyC open the one frame now, and main.accel.test.ts's UIF16B.5 cases pin both (N: the stack,
  // the deferred focus on #rename-input, the `n` not typed; C: focus inside Account at once), with
  // the D-pad half covered by the UIF16B.2 walk above.

  it('UIF16B.5 a failed sign-in (onSignInFailed) opens Profile focused in the Account section; with Profile already open on Name it moves focus to Account and the frame stays', async () => {
    // WRONG IMPL KILLED: a sign-in failure that opens the old claim frame alone, opens Profile on
    // Name (focus left in the field, the failure unread), opens a second frame over an open one, or
    // leaves focus in the field of an already open frame.
    await bootReady();
    server();
    const failed = opts.onSignInFailed;
    if (failed === undefined) throw new Error('onSignInFailed was not wired by main.ts');
    failed('sign-in-rejected' as never);
    expect(frameShown(), 'Profile is open').toEqual(ALL_SHOWN);
    expect(stackNames().at(-1), 'the frame is on top').toBe('profileView');
    expect(focusSection(), 'focus in Account').toBe('account');
    expectSafeFocus('sign-in failed');
    expect(el('claim-title').textContent, 'the failure is shown').toBe(
      t('claim.signInFailed.title'),
    );
    await flush();
    expect(focusSection(), 'the deferred Name anchor does not steal it').toBe('account');
    pressWindow('Escape');
    expect(frameShown(), 'precondition: Start closed it').toEqual(ALL_HIDDEN);

    pressWindow('KeyN');
    await flush();
    expect(document.activeElement, 'precondition: on the Name field').toBe(el('rename-input'));
    failed('sign-in-expired' as never);
    expect(stackNames(), 'the frame stays (no second one)').toEqual(OVER_MENU);
    expect(focusSection(), 'focus moved to Account').toBe('account');
    expectSafeFocus('sign-in failed while open');
  });

  it('UIF16B.5 a claim lifecycle paint raised before onReady (onClaimPending, or onClaimAwaitingAccount) auto-opens Profile on Account once onReady runs', async () => {
    // WRONG IMPL KILLED: a lifecycle event that paints the section but never opens the frame (the
    // prompt stays unseen: the code stays retained behind a veto the player cannot see), or an
    // onReady that closes it again; an auto-open on Name;
    // an auto-open of the old claim frame alone; an auto-open with a menu beneath (it is not a
    // player's accelerator).
    const raisers: ReadonlyArray<readonly [string, () => void]> = [
      ['onClaimPending', () => opts.onClaimPending?.('claim-code')],
      ['onClaimAwaitingAccount', () => opts.onClaimAwaitingAccount?.()],
    ];
    let driven = 0;
    for (const [label, raise] of raisers) {
      await bootConnected();
      raise();
      opts.onReady(H.identity);
      server();
      expect(frameShown(), `${label}: Profile is open`).toEqual(ALL_SHOWN);
      expect(stackNames(), `${label}: the frame alone over the world`).toEqual([
        'world',
        'profileView',
      ]);
      expect(focusSection(), `${label}: focus in Account`).toBe('account');
      expectSafeFocus(label);
      driven += 1;
      teardownBoot();
    }
    expect(driven, 'ANTI-VACUITY: both lifecycle events were driven').toBe(2);
  });

  it('UIF16B.5 a claim event arriving while Profile is open on Name with a typed draft paints the Account section in place: focus stays in the field and the draft is intact', async () => {
    // WRONG IMPL KILLED: a claim render that re-runs the open (focus yanked to Account, or the
    // section's hide clearing the draft); a render that re-shows the frame (a second frame); a
    // render that never reaches the section (the refusal unread).
    await bootReady();
    server();
    pressWindow('KeyN');
    await flush();
    const field = el('rename-input') as HTMLInputElement;
    typeInto(field, 'Bob');
    const result = opts.onClaimResult;
    if (result === undefined) throw new Error('onClaimResult was not wired by main.ts');
    result({ ok: false, message: 'close your other tab, then retry' } as never);
    expect(el('claim-title').textContent, 'the Account section shows the refusal').toBe(
      t('claim.reject.transient.title'),
    );
    expect(document.activeElement, 'focus stays in the field').toBe(field);
    expect(field.value, 'the draft is intact').toBe('Bob');
    expect(stackNames(), 'no frame surfaced').toEqual(OVER_MENU);
  });
});
