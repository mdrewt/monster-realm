// @vitest-environment happy-dom
/**
 * profileScreen.boot.test.ts: the Profile frames (ctl-8h) booted through main.ts over the REAL
 * client/index.html shell, the REAL RenameView / ClaimView / PrivacyView and the REAL screen-adapter
 * table (`SCREEN_ADAPTERS` is whatever ui/screens/index.ts ships: no stand-in is swapped in).
 *
 * - CTL8H-2-STOP-TYPING-IN-FRAME: KeyN, then Escape in the Name field stops typing without losing
 *   the text. With a draft focus lands on the save button INSIDE the frame; ArrowUp / KeyW put it
 *   back in the field (the D-pad now reaches the router from the save button, B5), and Enter in the
 *   field commits `set_profile_name` once. With an EMPTY draft the save button is disabled, so
 *   Escape leaves focus on the page; the D-pad then seats focus back inside the frame.
 * - CTL8H-2-BOOT-TYPING-COMMIT: Name opened through the main menu (Profile, Name): the field has
 *   focus after the deferred focus, and a typed name commits once.
 * - CTL8H-3-BOOT-DPAD: KeyC opens Account; the D-pad moves focus between the shown buttons; Enter on
 *   Decline arms and focus lands on No; B pops the frame and the decline path never ran.
 * - CTL8H-4-BOOT-TWO-STEP: Profile, Privacy through the menu; Delete arms (focus on Keep), Enter on
 *   Keep disarms (no reducer call), arming again then Confirm calls `delete_account` once.
 * - CTL8H-5-N-OPENS-NAME-TYPING / CTL8H-5-C-OPENS-ACCOUNT: the legacy KeyN / KeyC reach the new
 *   screens, and the D-pad drives them.
 *
 * EVERY key is dispatched ON `document.activeElement` (or on `window` for the main menu's own
 * keys), bubbling, like a real browser, and a focused <button> is CLICKED on Enter's keydown when
 * the page did not prevent it: happy-dom does not synthesize that native activation, a browser
 * does. The deferred initial focus (one macrotask after an open, from ui/overlayA11y.ts) is
 * flushed before the first key.
 *
 * Harness: journalScreen.boot.test.ts's (the real shell mounted, main.ts imported fresh per boot,
 * only the wasm pkg, the connection, telemetry and the world renderer stubbed), with three deltas:
 * every reducer call is recorded with its arguments, the claim code's `clear` is a spy (the
 * decline path's one local effect), and the account row is injected into the store (the privacy
 * lattice is derived from it, and the controllable rAF pumps it).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from '../../convert/convert';
import type { Connection, ConnectionOptions } from '../../net/connection';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every reducer call except enqueueMove, oldest first, with the exact argument object. */
  calls: [] as Array<{ name: string; args: unknown }>,
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
// name and arguments and resolves at once. sessionState() must be 'hidden' or the session gate
// swallows every key. The ONE store read the privacy lattice is derived from is wrapped so a case
// can inject an account row (main.privacyWiring.test.ts's injection point).
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
    continueAnonymously: () => undefined,
    sessionState: () => 'hidden',
    startSignIn: () => undefined,
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

/** Mount the REAL client/index.html shell (minus its module script) into the live document. */
function mountIndexHtmlShell(): void {
  const htmlPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'index.html',
  );
  const parsed = new DOMParser().parseFromString(readFileSync(htmlPath, 'utf8'), 'text/html');
  const children = Array.from(parsed.body.children).filter((el) => el.tagName !== 'SCRIPT');
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'index.html must yield a body to mount').toBeGreaterThan(5);
  document.body.replaceChildren(...children.map((el) => document.adoptNode(el)));
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

const clock = { t: 0 };
/** The test's own monotonic time: every key and batch moves it on by 100 ms. */
let tick = 1000;
let rafCallback: FrameRequestCallback | null = null;
let opts: ConnectionOptions;

/** Boot a fresh main.ts over the real shell and wait for it to connect. */
async function bootReady(): Promise<void> {
  H.connectOpts = null;
  H.calls = [];
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

/** A key aimed at `window` itself: the main menu's own keys. */
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

/** Put `text` into a field the way a user does: set the value, then fire its input event. */
function typeInto(field: HTMLInputElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

const focusedId = (): string => (document.activeElement as HTMLElement | null)?.id ?? '';
const focusOnPage = (): boolean =>
  document.activeElement === null || document.activeElement === document.body;

/** The whole context stack through the read-only `__game()` DEV hook, as base-first frame names. */
const stackNames = (): string[] =>
  (
    window as unknown as {
      __game: () => { stack: Array<{ kind: string; id?: string }> };
    }
  )
    .__game()
    .stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));

const callsOf = (name: string): Array<{ name: string; args: unknown }> =>
  H.calls.filter((c) => c.name === name);

/** M opens the main menu; four Downs reach Profile (Monsters, Bag, Journal, Social, Profile); A
 *  enters it; `childDowns` Downs reach Name (0), Account (1) or Privacy (2); A opens that child
 *  above the menu. The menu's own keys are aimed at the window. */
function openFromProfileMenu(childDowns: number): void {
  pressWindow('KeyM');
  expect(shown('menu-overlay'), 'precondition: M opened the main menu').toBe(true);
  for (let i = 0; i < 4; i += 1) pressWindow('ArrowDown');
  pressWindow('Enter');
  for (let i = 0; i < childDowns; i += 1) pressWindow('ArrowDown');
  pressWindow('Enter');
}

/** A whole `StoreAccount`-shaped row for an Active account: delete and export permitted. */
const accountActive = (): Record<string, unknown> => ({
  identity: H.identity,
  authIssuer: 'ctl8h-test-issuer',
  createdAtMs: 1n,
  lastLoginAtMs: 2n,
  status: 'Active',
  deletionRequestedAtMs: undefined,
  claimedFrom: undefined,
  claimedAtMs: undefined,
  terminalAtMs: undefined,
});

describe('the Profile frames booted through main.ts over the real views and adapter table (ctl-8h)', {
  sequential: true,
}, () => {
  afterEach(teardownBoot);

  it('CTL8H-2-STOP-TYPING-IN-FRAME: Escape in the Name field keeps the text and leaves the field; with a draft focus is on the save button inside the frame and ArrowUp or KeyW put it back in the field, where Enter commits set_profile_name once; with an empty draft focus is on the page and ArrowDown or ArrowUp seat it back inside the frame', async () => {
    // WRONG IMPL KILLED: a save button that shields the D-pad (B5: ArrowUp / KeyW pressed on it
    // never reach the router and the player is stuck there); a legacy adapter on the rename frame
    // (the D-pad is swallowed and nothing moves focus); an empty-draft Escape that strands the
    // player on the page with no way back (the residual of CTL6B.5): the D-pad must seat focus
    // inside the frame; a stop-typing that wipes the draft; and a commit sent twice or with the
    // untrimmed text.
    await bootReady();
    server();
    press('KeyN');
    expect(shown('rename-overlay'), 'KeyN shows the Name frame').toBe(true);
    expect(stackNames()).toEqual(['world', 'renameView']);
    await flush();
    const field = el('rename-input') as HTMLInputElement;
    const save = el('rename-submit') as HTMLButtonElement;
    const frameRoot = el('rename-overlay');
    expect(document.activeElement, 'precondition: the deferred focus is in the field').toBe(field);
    expect(save.disabled, 'precondition: an empty draft disables save').toBe(true);

    // --- an EMPTY draft: Escape leaves focus on the page, the D-pad seats it back in the frame ---
    const empty = press('Escape');
    expect(empty.defaultPrevented, 'the stop-typing press is prevented').toBe(true);
    expect(focusOnPage(), 'no enabled control: focus ends on the page').toBe(true);
    expect(shown('rename-overlay'), 'the frame stays open').toBe(true);
    expect(stackNames(), 'and on the stack').toEqual(['world', 'renameView']);
    press('ArrowDown');
    expect(
      frameRoot.contains(document.activeElement),
      'ArrowDown seats focus inside the frame',
    ).toBe(true);
    expect(document.activeElement, 'on the default row, the field').toBe(field);
    press('Escape');
    expect(focusOnPage(), 'stop typing again: back on the page').toBe(true);
    press('ArrowUp');
    expect(document.activeElement, 'ArrowUp seats focus inside the frame too').toBe(field);
    expect(shown('rename-overlay')).toBe(true);

    // --- a DRAFT: Escape lands on the enabled save button, the D-pad walks back to the field ---
    typeInto(field, 'Bob');
    expect(save.disabled, 'precondition: a draft enables save').toBe(false);
    const typed = press('Escape');
    expect(typed.defaultPrevented).toBe(true);
    expect(document.activeElement, 'with a draft focus lands on save, inside the frame').toBe(save);
    expect(field.value, 'the draft is kept').toBe('Bob');
    expect(shown('rename-overlay')).toBe(true);

    press('ArrowUp');
    expect(document.activeElement, 'ArrowUp from the save button: back in the field').toBe(field);
    expect(field.value, 'the draft survives the round trip').toBe('Bob');
    press('Escape');
    expect(document.activeElement, 'stop typing once more: save').toBe(save);
    press('KeyW');
    expect(document.activeElement, 'KeyW from the save button: back in the field').toBe(field);
    expect(callsOf('setProfileName'), 'nothing was sent while moving around').toEqual([]);

    press('Enter');
    expect(callsOf('setProfileName'), 'Enter in the field commits the trimmed name once').toEqual([
      { name: 'setProfileName', args: { name: 'Bob' } },
    ]);
    await flush();
    expect(callsOf('setProfileName'), 'and only once').toHaveLength(1);
  });

  it('CTL8H-2-BOOT-TYPING-COMMIT: Name opened through the main menu (Menu, Profile, Name) shows the frame above the menu, the field has focus after the deferred focus, and a typed name commits once with Enter', async () => {
    // WRONG IMPL KILLED: a menu leaf that opens the frame without its deferred focus (the player
    // types into the page); an adapter that swallows the Enter that should reach the field's own
    // commit; a commit sent twice (the adapter's A and the field's own Enter both firing); and an
    // untrimmed name.
    await bootReady();
    server();
    openFromProfileMenu(0);
    expect(shown('rename-overlay'), 'the Name leaf shows the frame').toBe(true);
    expect(stackNames(), 'above the menu').toEqual(['world', 'menuView', 'renameView']);
    await flush();
    const field = el('rename-input') as HTMLInputElement;
    expect(document.activeElement, 'the field has focus after the deferred focus').toBe(field);

    typeInto(field, '  Bob ');
    press('Enter');
    expect(callsOf('setProfileName'), 'the trimmed name, once').toEqual([
      { name: 'setProfileName', args: { name: 'Bob' } },
    ]);
    await flush();
    expect(callsOf('setProfileName'), 'and still once').toHaveLength(1);
    expect(shown('rename-overlay'), 'the frame stays open on success').toBe(true);
  });

  it('CTL8H-3-BOOT-DPAD: KeyC opens Account with focus on Sign in; ArrowDown and ArrowUp move focus between the shown buttons (clamped); Enter on Decline arms and focus lands on No; Backspace pops the frame and the decline path never ran', async () => {
    // WRONG IMPL KILLED: a legacy adapter on the claim frame (the arrows are swallowed and focus
    // never moves); rows that include a hidden button; a default-No that only runs on the click
    // edge (the arm render hides the focused Decline and focus falls to the page); a Backspace
    // that does not pop the frame, or one that also runs the decline (the claim code would be
    // deleted by a back-out); and, as the control, a claim-code spy that is wired to nothing (the
    // control click on Confirm must reach it).
    await bootReady();
    server();
    const clearsBefore = H.claimClear.mock.calls.length;
    press('KeyC');
    expect(shown('claim-overlay'), 'KeyC shows Account').toBe(true);
    expect(stackNames()).toEqual(['world', 'claimView']);
    await flush();
    expect(focusedId(), 'the initial focus is Sign in').toBe('claim-signin-btn');

    const walked: string[] = [];
    for (const code of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp']) {
      press(code);
      walked.push(focusedId());
    }
    expect(walked, 'down, down, clamped on the privacy door, then up').toEqual([
      'claim-decline-btn',
      'claim-privacy-btn',
      'claim-privacy-btn',
      'claim-decline-btn',
    ]);
    expect(el('claim-confirm').textContent ?? '', 'nothing is armed yet').toBe('');

    press('Enter');
    expect(
      (el('claim-confirm').textContent ?? '').length,
      'Enter on Decline arms the prompt',
    ).toBeGreaterThan(0);
    expect(shown('claim-confirm'), 'and shows it').toBe(true);
    expect(focusedId(), 'focus lands on No, never Confirm').toBe('claim-decline-cancel-btn');
    expect(H.claimClear.mock.calls.length, 'arming deletes nothing').toBe(clearsBefore);

    press('Backspace');
    expect(shown('claim-overlay'), 'B closes the Account frame').toBe(false);
    expect(stackNames(), 'the frame was popped').toEqual(['world']);
    expect(H.claimClear.mock.calls.length, 'the decline path never ran').toBe(clearsBefore);

    // Control: the spy is wired. The model is still armed (a pop is not a cancel), so reopening
    // shows Confirm, and a click on it runs the decline and clears the stored code.
    await flush();
    press('KeyC');
    expect(shown('claim-overlay'), 'control: KeyC reopens Account').toBe(true);
    expect(shown('claim-decline-confirm-btn'), 'control: Confirm is shown, still armed').toBe(true);
    (el('claim-decline-confirm-btn') as HTMLButtonElement).click();
    expect(H.claimClear.mock.calls.length, 'control: Confirm runs the decline').toBe(
      clearsBefore + 1,
    );
  });

  it('CTL8H-4-BOOT-TWO-STEP: Privacy opened through the main menu (Menu, Profile, Privacy): ArrowDown reaches Delete, Enter arms with focus on Keep, Enter on Keep disarms back onto Delete with no reducer call, arming again and ArrowUp to Confirm then Enter calls delete_account exactly once', async () => {
    // WRONG IMPL KILLED: a legacy adapter on the privacy frame (the arrows are swallowed); an arm
    // that leaves focus on the hidden Delete button or puts it on Confirm (one more Enter would
    // delete the account); a Keep that does not disarm or that calls the reducer; a disarm that
    // strands focus on a hidden button; rows that include the disabled Cancel or Download; a
    // Confirm that never reaches the reducer; and a deleteAccount sent more than once.
    await bootReady();
    H.account = accountActive();
    server();
    frame(); // pumps the injected Active row into the privacy lattice: Delete becomes enabled
    openFromProfileMenu(2);
    expect(shown('privacy-overlay'), 'the Privacy leaf shows the frame').toBe(true);
    expect(stackNames(), 'above the menu').toEqual(['world', 'menuView', 'privacyView']);
    await flush();
    expect(focusedId(), 'the initial focus is Close').toBe('privacy-close-btn');
    expect(
      (el('privacy-delete-btn') as HTMLButtonElement).disabled,
      'precondition: an Active account may delete',
    ).toBe(false);
    expect(el('privacy-confirm').textContent ?? '', 'precondition: nothing is armed').toBe('');

    press('ArrowDown');
    expect(focusedId(), 'ArrowDown from Close reaches Delete').toBe('privacy-delete-btn');
    press('Enter');
    expect(
      (el('privacy-confirm').textContent ?? '').length,
      'Enter on Delete arms step two',
    ).toBeGreaterThan(0);
    expect(focusedId(), 'focus lands on Keep, never Confirm').toBe('privacy-confirm-cancel-btn');
    expect(callsOf('deleteAccount'), 'arming sends nothing').toEqual([]);

    press('Enter');
    expect(el('privacy-confirm').textContent ?? '', 'Enter on Keep disarms').toBe('');
    expect(focusedId(), 'focus returns to the button that armed it').toBe('privacy-delete-btn');
    expect(callsOf('deleteAccount'), 'Keep sends nothing').toEqual([]);

    press('Enter');
    expect(focusedId(), 'armed again: focus on Keep').toBe('privacy-confirm-cancel-btn');
    press('ArrowUp');
    expect(focusedId(), 'ArrowUp from Keep reaches Confirm').toBe('privacy-confirm-btn');
    expect(callsOf('deleteAccount'), 'moving to Confirm sends nothing').toEqual([]);
    press('Enter');
    expect(callsOf('deleteAccount'), 'Enter on Confirm deletes the account once').toEqual([
      { name: 'deleteAccount', args: {} },
    ]);
    await flush();
    expect(callsOf('deleteAccount'), 'and only once').toHaveLength(1);
  });

  it('CTL8H-5-N-OPENS-NAME-TYPING: KeyN at the world shows the Name frame on top of the stack, the field has focus after the deferred focus, and the D-pad drives the frame (Escape then ArrowDown seats focus back in the field)', async () => {
    // WRONG IMPL KILLED: a KeyN that no longer opens the frame; a frame opened without its
    // deferred focus (the opening `n` would be typed, or the page keeps focus); and the legacy
    // adapter still on the frame (the D-pad is swallowed: the last step moves nothing).
    await bootReady();
    server();
    expect(shown('rename-overlay'), 'precondition: the frame starts closed').toBe(false);
    press('KeyN');
    expect(shown('rename-overlay'), 'KeyN shows the Name frame').toBe(true);
    expect(stackNames(), 'it is the top frame').toEqual(['world', 'renameView']);
    await flush();
    const field = el('rename-input') as HTMLInputElement;
    expect(document.activeElement, 'the field has focus after the deferred focus').toBe(field);
    expect(field.value, 'the opening n was not typed').toBe('');

    press('Escape');
    expect(focusOnPage(), 'precondition: Escape left the empty field for the page').toBe(true);
    press('ArrowDown');
    expect(
      document.activeElement,
      'the Name screen takes the D-pad: focus is back in the field',
    ).toBe(field);
  });

  it('CTL8H-5-C-OPENS-ACCOUNT: KeyC at the world shows the Account frame on top of the stack, and the D-pad reaches it: ArrowDown moves focus off Sign in onto another button of the frame', async () => {
    // WRONG IMPL KILLED: a KeyC that no longer opens the frame; the legacy adapter still on the
    // claim frame (the D-pad is swallowed and focus never leaves Sign in); and a cursor that moves
    // focus out of the frame or onto a hidden button.
    await bootReady();
    server();
    expect(shown('claim-overlay'), 'precondition: the frame starts closed').toBe(false);
    press('KeyC');
    expect(shown('claim-overlay'), 'KeyC shows the Account frame').toBe(true);
    expect(stackNames(), 'it is the top frame').toEqual(['world', 'claimView']);
    await flush();
    const first = document.activeElement;
    expect(first, 'the initial focus is Sign in').toBe(el('claim-signin-btn'));

    press('ArrowDown');
    const next = document.activeElement;
    expect(next, 'focus moved').not.toBe(first);
    expect(next?.tagName, 'onto a button').toBe('BUTTON');
    expect(el('claim-overlay').contains(next), 'inside the frame').toBe(true);
    expect(isShown(next as Element), 'that is on screen').toBe(true);
  });
});
