// @vitest-environment happy-dom
/**
 * main.privacyCountdown.test.ts — RUNTIME gate over main.ts's deletion-countdown banner:
 * the `#privacy-countdown` DOM shell, the per-frame tick that fills it, and the
 * `deletion_grace_ms_default()` wasm read that gives it a deadline (rb-51, residual
 * R-m22-s8-X9; ADR-0231 Amendment A1; spec §7.4 PRV1-1).
 *
 * SOURCE OF TRUTH — EARS criterion E1: WHEN the deletion grace window is live THE PLAYER
 * SHALL see a ticking countdown to the reaper fire, in a rendered surface (DOM shell +
 * main.ts frame tick + the `deletion_grace_ms_default()` wasm read).
 *
 * SCOPE: the LABEL GRAMMAR is `ui/privacyBanner.test.ts`'s (pure, node-tier) and the PHASE
 * derivation is `ui/privacyModel.test.ts`'s. This file does NOT re-test either. It pins only
 * what no pure test and no source scan can see: that a real element exists in the real
 * document, that the value written into it moves with the WALL clock (and with nothing else),
 * that it is CLEARED again on every path off the grace window, and that the grace window
 * itself comes from the wasm accessor rather than a number typed into main.ts.
 *
 * WHY A RUNTIME IMPORT — `main.wiring.test.ts:20-22` prescribes source-scan, "NOT import",
 * for main.ts. This file is the SANCTIONED, SCOPED exception, modelled on
 * `main.battle-reseed.test.ts` (16r-f), `main.a11yFocus.test.ts` (m23-s5) and
 * `main.reducedMotionWiring.test.ts` (17r-a), all of which import `./main` for the same
 * reason: the subject is WHICH VALUES flow through a call on an animation frame. A text scan
 * can prove `BigInt(Date.now())` appears; it cannot prove the number reaching the label came
 * from there rather than from `performance.now()` — the mutation that ships a countdown
 * roughly 53,000 years long and passes every source pin.
 *
 * LIGHTEST-HARNESS CHOICE (the `main.reducedMotionWiring.test.ts` shape): NO `#app`, and
 * `client/index.html` is never parsed. Verified by reading main.ts (not assumed): `#status`
 * (:2610-2612) and `#interact-prompt` (:2620-2632) are created with
 * `document.createElement` + `document.body.appendChild` INSIDE `main()`, unconditionally,
 * OUTSIDE the `if (mount !== null)` block that guards the sixteen constructed views — and the
 * plan places `#privacy-countdown` beside them. `ui/liveRegion.ts` no-ops without
 * `#a11y-live` (its own header, :46-49), so the frame body is reachable with no DOM shell.
 *
 * ★ TWO INDEPENDENT CLOCKS, AND WHY `runFrame` TAKES BOTH (the critical harness decision).
 * The precedents' `runFrame(atMs)` stubs `performance.now()` ONLY. Under that harness a
 * wiring that passed `performance.now()` as `nowMs` would tick perfectly and pass a naive
 * "the label changed" tooth while being wrong by three orders of magnitude. `runFrame` here
 * therefore takes `(perfMs, wallMs)` and drives `vi.spyOn(performance, 'now')` and
 * `vi.spyOn(Date, 'now')` SEPARATELY, so RB51T-TICK-WALL (wall moves, perf held) and
 * RB51T-TICK-PERF-HELD (perf moves, wall held) can disagree. `vi.useFakeTimers()` is
 * deliberately NOT used: it is a repo anti-pattern here because it may replace
 * `requestAnimationFrame`, which this harness must own.
 *
 * ★ EVERY "HIDDEN" ARM IS A TRANSITION, NEVER A STATIC. The element is BORN hidden, so
 * "boot with an Active account, assert hidden" is vacuous — it passes against an
 * implementation that never writes anything at all. Each arm below therefore first installs a
 * LIVE PendingDeletion row, runs a frame, and asserts the banner is genuinely SHOWING the
 * expected label (the per-arm anti-vacuity control), and only then upserts the arm's row and
 * asserts it went away.
 *
 * HARNESS REQUIREMENT: the Connection stub's `sessionState()` MUST be 'hidden'. Any other
 * value makes the frame early-return at `main.ts:2790` (`if (sessionGateBlocks()) return;`)
 * before reaching the countdown block, and every negative arm would pass vacuously.
 *
 * RED REASON AT AUTHORING TIME: main.ts creates no `#privacy-countdown` element, imports no
 * `deletion_grace_ms_default`, and its frame calls neither `deriveDeletionCountdown` nor
 * `privacyBannerLabel`. Every test below reds on `#privacy-countdown` being absent from the
 * document (a named, loud assertion — never a thrown TypeError on `null.style`).
 *
 * WRONG IMPL KILLED: recorded per test, immediately above each `it`.
 *
 * NO `new RegExp(...)`, no `eval`, no `new Function` (Semgrep bans them — none used here).
 * NO `innerHTML` for DOM CONSTRUCTION (ADR-0135) — nothing is built here at all; the single
 * `document.body.innerHTML = ''` in `afterEach` is the teardown form the sanctioned precedent
 * `main.reducedMotionWiring.test.ts:382` uses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection, ConnectionOptions } from './net/connection';
import type { AuthoritativeStore, StoreAccount } from './net/store';

// --- hoisted state shared with the mock factories --------------------------------------
const H = vi.hoisted(() => ({
  /** 64-char hex — the shape connection.ts hands main.ts's onReady. */
  identity: 'ab'.repeat(32),
  /** The ConnectionOptions main() passed to connect(): our handle on the REAL store. */
  connectOpts: null as ConnectionOptions | null,
  /** What the mocked wasm accessor returns. Set BEFORE each `import('./main')`, because the
   *  contract reads it ONCE at module scope. */
  graceMs: 0n as bigint,
}));

// The wasm pkg — every name main.ts imports, plus the other exports of the real module (the
// same object the sanctioned precedents mock), with `deletion_grace_ms_default` driven from
// the hoisted fixture instead of the precedents' fixed `1n`.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
    // rb-8 / ADR-0212: `-> i64` crosses as a BigInt, so this returns a bigint, never a number.
    deletion_grace_ms_default: () => H.graceMs,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
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

// The connection: capture the options object (its `store` field is this file's injection
// point), hand back a Connection-shaped stub. sessionState() MUST be 'hidden' — see the
// header's HARNESS REQUIREMENT.
vi.mock('./net/connection', () => {
  const stub: Connection = {
    conn: undefined,
    live: () => undefined,
    identity: () => H.identity,
    linkFrozen: () => false,
    continueAnonymously: () => undefined,
    sessionState: () => 'hidden',
    startSignIn: () => undefined,
    reconnectNow: () => undefined,
  };
  return {
    connect: (opts: ConnectionOptions): Connection => {
      H.connectOpts = opts;
      return stub;
    },
  };
});

// Telemetry: keep NOOP_TELEMETRY and the types, never bootstrap the OTel SDK (no network).
vi.mock('./observability/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./observability/telemetry')>();
  return {
    ...actual,
    loadOtelSdk: () => {
      throw new Error('loadOtelSdk must not be reached in this test');
    },
    startClientTelemetry: () => Promise.resolve(actual.NOOP_TELEMETRY),
  };
});

// The renderer: constructed unconditionally before the `#app` guard. Pixi under happy-dom is
// out of scope for this gate. No canvas is appended (this file never drives focus).
vi.mock('./render/world', () => {
  class WorldRenderer {
    init(): Promise<void> {
      return Promise.resolve();
    }
    setMap(): void {
      // no-op stub
    }
    render(): void {
      // no-op stub
    }
    resize(): void {
      // no-op stub
    }
    screenFor(): { x: number; y: number } {
      return { x: 0, y: 0 };
    }
    clear(): void {
      // no-op stub
    }
    destroy(): void {
      // no-op stub
    }
    get viewCount(): number {
      return 0;
    }
  }
  return { WorldRenderer };
});

// --- listener-cleanup harness (verbatim from the sanctioned precedents) ----------------
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

/** Record every addEventListener on `target` (delegating to the real one) so afterEach can
 *  detach each pair from the SAME target. Without this, main.ts's module-scope window/document
 *  listeners STACK across `vi.resetModules()` re-imports. */
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

// --- the controllable rAF queue ---------------------------------------------------------
let rafCallback: FrameRequestCallback | null = null;

function stubControllableRaf(): void {
  rafCallback = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallback = cb;
    return 0;
  });
}

/** Run ONE frame with the two clocks driven INDEPENDENTLY (see the header). Throws loud
 *  (never a silent no-op) if no callback is armed, or if the frame did not re-arm itself —
 *  main.ts's frame re-arms unconditionally in a `finally`, so a missing re-arm means the body
 *  threw in a way this harness cannot account for, and a silent no-op here would make every
 *  assertion below measure a frame that never ran.
 *
 *  ANTI-VACUITY LIMIT, stated rather than implied: the re-arm assertion proves only that the
 *  callback RAN — `sessionGateBlocks()`'s early return re-arms too. The real control that the
 *  frame reached the countdown block is each test's POSITIVE assertion on the label. */
function runFrame(perfMs: number, wallMs: number): void {
  const cb = rafCallback;
  if (cb === null) {
    throw new Error('runFrame: no requestAnimationFrame callback is armed — has main() booted?');
  }
  rafCallback = null;
  const perfSpy = vi.spyOn(performance, 'now').mockReturnValue(perfMs);
  const wallSpy = vi.spyOn(Date, 'now').mockReturnValue(wallMs);
  try {
    cb(perfMs);
  } finally {
    perfSpy.mockRestore();
    wallSpy.mockRestore();
  }
  expect(
    rafCallback,
    'the frame did not re-arm requestAnimationFrame(frame) in its `finally` — runFrame cannot ' +
      'be called again and every later assertion would silently measure nothing',
  ).not.toBeNull();
}

// --- fixtures ---------------------------------------------------------------------------

/** A wall-clock instant, as a plain number for `Date.now()` and as the bigint the store's
 *  timestamp columns carry. NOT the real time: every assertion below is exact. */
const WALL_T0 = 1_700_000_000_000;
const WALL_T0_MS = 1_700_000_000_000n;

/** A DAY-SCALE synthetic grace window whose remaining time has FOUR non-zero unit groups
 *  (2d 3h 4m 5s). Day-scale is required by the plan: on a minutes-scale fixture a formatter
 *  that renders only the two largest units still ticks every second and cannot be told apart.
 *
 *  SYNTHETIC, and it must stay synthetic: `evals/deletion-grace-wasm-ssot.eval.mjs` G5 reads
 *  every client `.ts` RAW — comments included — for a numeric duplicate of the SHIPPED grace
 *  window, which is exactly why the value is injected through the wasm mock in the first place. */
const GRACE_DAY_SCALE = 183_845_000n;
const LABEL_AT_T0 = 'Account deletion in 2d 3h 4m 5s';
const LABEL_AT_T0_PLUS_2S = 'Account deletion in 2d 3h 4m 3s';

/** A foreign identity — the store's owner filter (`ownAccount(identity)`, store.ts:1163-1166)
 *  returns undefined for it. This is how the "no account row" arm is reached without calling
 *  `reset()` (which would clear unrelated store state this harness does not model). */
const OTHER_IDENTITY = 'cd'.repeat(32);

function accountOf(overrides: Partial<StoreAccount> = {}): StoreAccount {
  return {
    identity: H.identity,
    authIssuer: 'test-issuer',
    createdAtMs: WALL_T0_MS,
    lastLoginAtMs: WALL_T0_MS,
    // `status` is the BARE AccountStatus tag as the store carries it (store.ts:245) — never a
    // `{ tag: ... }` wrapper.
    status: 'Active',
    deletionRequestedAtMs: undefined,
    claimedFrom: undefined,
    claimedAtMs: undefined,
    terminalAtMs: undefined,
    ...overrides,
  };
}

/** The LIVE grace-window row every test starts from: requested exactly at WALL_T0, so the
 *  remaining time at WALL_T0 is the whole (mocked) grace window. */
const LIVE_ROW: StoreAccount = accountOf({
  status: 'PendingDeletion',
  deletionRequestedAtMs: WALL_T0_MS,
});

function countdownEl(): HTMLElement {
  const el = document.getElementById('privacy-countdown');
  expect(
    el,
    'main.ts must create a `#privacy-countdown` element and append it to document.body ' +
      '(rb-51 / PRV1-1: the countdown needs a rendered surface). It does not exist.',
  ).not.toBeNull();
  return el as HTMLElement;
}

/** The banner is SHOWING exactly `label`. Both halves matter: text without `display: block`
 *  is an invisible countdown, and `display: block` without text is an empty box. */
function expectShowing(label: string, where: string): void {
  const el = countdownEl();
  expect(el.textContent, `${where}: the banner must read exactly this`).toBe(label);
  expect(el.style.display, `${where}: the banner must be displayed`).toBe('block');
}

/** The banner is GONE — cleared, not merely blanked or merely hidden. */
function expectHidden(where: string): void {
  const el = countdownEl();
  expect(el.style.display, `${where}: the banner must be hidden`).toBe('none');
  expect(
    el.textContent,
    `${where}: the banner's text must be CLEARED, not left behind under display:none — a ` +
      'stale sentence is one CSS edit away from being visible again',
  ).toBe('');
}

// --- the suite ---------------------------------------------------------------------------
// `describe(name, { sequential: true }, fn)` — NOT `describe.sequential(...)`. Same isolation,
// but the literal `describe(` is REQUIRED: motionPreference.test.ts's S7T-SCAN scans every
// comment-stripped `.test.ts` under client/src for that exact token as a tripwire against
// production code disguised with a spec suffix, and the dotted form does not contain it.
// Sequential because happy-dom's document and this file's module-scope rAF slot are per-FILE.
describe('main.ts deletion-countdown banner (rb-51, PRV1-1)', { sequential: true }, () => {
  let recorded: Recorded[] = [];
  let restoreWindowAdd: (() => void) | undefined;
  let restoreDocumentAdd: (() => void) | undefined;

  /** Boot main.ts with `deletion_grace_ms_default()` mocked to `graceMs`, and return the REAL
   *  store main() handed to connect(). Called at the top of each test body (never in a shared
   *  beforeEach — each tooth needs its own grace window), and TWICE in RB51T-WASM-GRACE. */
  async function setupMain(graceMs: bigint): Promise<AuthoritativeStore> {
    // Restore any wrapper from a previous setupMain in the SAME test before installing a new
    // one, so the recorder can never wrap itself.
    restoreDocumentAdd?.();
    restoreWindowAdd?.();
    restoreDocumentAdd = undefined;
    restoreWindowAdd = undefined;

    H.connectOpts = null;
    H.graceMs = graceMs;
    // A fresh boot appends its OWN #privacy-countdown; clearing first is what makes the
    // "exactly one element" assertion in RB51T-WASM-GRACE meaningful rather than cumulative.
    document.body.innerHTML = '';
    // `recorded` is NOT reset here: afterEach owns that. A second setupMain in the same test
    // must keep the FIRST boot's listener records so they are detached too — dropping them
    // would leak main.ts's module-scope window/document handlers into the next test.
    restoreWindowAdd = recordListeners(window, recorded);
    restoreDocumentAdd = recordListeners(document, recorded);
    stubControllableRaf();

    vi.resetModules();
    await import('./main');
    // main() awaits the dynamic view imports before connect() — poll, never a fixed delay.
    const opts = await vi.waitFor(
      () => {
        const captured = H.connectOpts;
        if (captured === null) throw new Error('connect() has not been called by main() yet');
        return captured;
      },
      { timeout: 5_000, interval: 5 },
    );
    opts.onReady(H.identity);
    // The loop is armed behind main()'s `ready` promise — wait for the callback rather than
    // assuming the microtask queue has drained, so runFrame never throws for a timing reason.
    await vi.waitFor(
      () => {
        expect(rafCallback, 'main() must have armed requestAnimationFrame(frame)').not.toBeNull();
      },
      { timeout: 5_000, interval: 5 },
    );
    return opts.store;
  }

  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    restoreDocumentAdd?.();
    restoreWindowAdd?.();
    restoreDocumentAdd = undefined;
    restoreWindowAdd = undefined;
    H.connectOpts = null;
    vi.unstubAllGlobals();
    rafCallback = null;
    document.body.innerHTML = '';
  });

  // -------------------------------------------------------------------------------------
  // (d) The shell exists, in the document, hidden until there is something to say.
  // -------------------------------------------------------------------------------------

  it('★ RB51T-SHELL BITES: #privacy-countdown is a DIRECT document.body child and starts hidden', async () => {
    // WRONG IMPL KILLED (1) ★ THE DEFECT (master today): no element at all. PRV1-1 asks for a
    // RENDERED surface; a countdown computed and thrown away satisfies nothing.
    // WRONG IMPL KILLED (2): the element created but never appended (or appended to `#app`,
    // which does not exist in a boot without a mount — the banner would silently never render
    // for any player whose mount failed, and `document.getElementById` would return null here).
    // WRONG IMPL KILLED (3): created VISIBLE, so a player with no deletion request sees an
    // empty box (or a flash of one) on every page load. `display` is asserted at CREATION,
    // before any frame has run.
    await setupMain(GRACE_DAY_SCALE);
    const el = countdownEl();
    expect(
      el.parentElement,
      '#privacy-countdown must be a DIRECT child of document.body (beside #status and ' +
        '#interact-prompt), so it renders on a boot with no #app mount too',
    ).toBe(document.body);
    expect(el.style.display, 'the banner must be created hidden — no frame has run yet').toBe(
      'none',
    );
    expect(el.textContent, 'the banner must be created empty').toBe('');
  });

  // -------------------------------------------------------------------------------------
  // (a) TICKING — the pair. The two clocks must disagree, and only one of them may matter.
  // -------------------------------------------------------------------------------------

  it('★ RB51T-TICK-WALL BITES: +2000ms of WALL clock, performance clock HELD — the label drops by exactly two seconds', async () => {
    // WRONG IMPL KILLED (1) ★: a frozen countdown — the deadline recomputed as
    // `now + graceMs` every frame (the label never moves), or the label computed once at boot
    // and memoised forever. Either way the player watches a number that never counts down for
    // a deadline that is very much running.
    // WRONG IMPL KILLED (2) ★: `performance.now()` (or the rAF timestamp argument) used as
    // `nowMs`. The perf clock is HELD here, so that mutant's label does not move and this
    // assertion fails — the companion RB51T-TICK-PERF-HELD closes the other direction.
    // WRONG IMPL KILLED (3): a formatter reading only the two largest units. This fixture is
    // DAY-scale on purpose: '2d 3h' is stable across a two-second step, so such a formatter
    // fails the second assertion while passing any minutes-scale fixture.
    // WRONG IMPL KILLED (4): a wrong-direction subtraction or a Number() round-trip — the
    // labels are pinned EXACTLY, not merely as "different".
    const store = await setupMain(GRACE_DAY_SCALE);
    store.upsertAccount(LIVE_ROW);

    runFrame(0, WALL_T0);
    expectShowing(LABEL_AT_T0, 'frame 1 (wall = T0)');

    // The wall clock advances 2s; the performance clock does NOT move at all.
    runFrame(0, WALL_T0 + 2_000);
    expectShowing(LABEL_AT_T0_PLUS_2S, 'frame 2 (wall = T0 + 2s, perf still 0)');
  });

  it('★ RB51T-TICK-PERF-HELD BITES: +2000ms of PERFORMANCE clock with the WALL clock held — the label does NOT move', async () => {
    // ★ THE CRITICAL TOOTH OF THIS FILE. WRONG IMPL KILLED: `nowMs: BigInt(Math.trunc(
    // performance.now()))` — a plausible copy of the line two rows above it in the same frame
    // body (`const now = performance.now();`). It TICKS, so it passes any "the label changed"
    // test, and it passes every source scan; but `performance.now()` is milliseconds since
    // timeOrigin, not since the epoch, so `deadline - now` is off by the whole UNIX epoch and
    // the player is told their account will be deleted in about 53,000 years. Only a frame
    // that moves the performance clock while HOLDING the wall clock separates the two, which
    // is why this file's runFrame takes the clocks as two independent parameters.
    const store = await setupMain(GRACE_DAY_SCALE);
    store.upsertAccount(LIVE_ROW);

    runFrame(0, WALL_T0);
    expectShowing(LABEL_AT_T0, 'frame 1 (perf = 0)');

    // The performance clock jumps 2s; the WALL clock is frozen at the same instant.
    runFrame(2_000, WALL_T0);
    expectShowing(LABEL_AT_T0, 'frame 2 (perf = 2000, wall unchanged)');
  });

  // -------------------------------------------------------------------------------------
  // (b) Every path OFF the grace window clears the banner. Each arm is a TRANSITION.
  // -------------------------------------------------------------------------------------

  const OFF_ARMS: ReadonlyArray<{ readonly name: string; readonly row: StoreAccount }> = [
    // PRV1-3's happy ending: the player cancelled and the server flipped the row back to
    // Active. The stale `deletionRequestedAtMs` is DELIBERATELY left on the row — that is what
    // the server does, and a banner keyed on the timestamp instead of the STATUS would keep
    // counting down a window that no longer exists.
    {
      name: 'the CANCEL path: back to Active with a stale deletionRequestedAtMs',
      row: accountOf({ status: 'Active', deletionRequestedAtMs: WALL_T0_MS }),
    },
    { name: 'a plain Active row', row: accountOf({ status: 'Active' }) },
    // PRV1-4: `terminalAtMs` is an Option<i64>, so 0n is a REAL marker value. A truthiness
    // test on it would leave a live "cancellable" countdown on an account that is already gone.
    {
      name: 'the TERMINAL marker at 0n (already permanently deleted)',
      row: accountOf({
        status: 'PendingDeletion',
        deletionRequestedAtMs: WALL_T0_MS,
        terminalAtMs: 0n,
      }),
    },
    // No row for THIS identity — the store's owner filter answers undefined.
    { name: 'no account row for this identity', row: accountOf({ identity: OTHER_IDENTITY }) },
    // A tag this client does not recognise is DARK (ADR-0154), never a synonym for Active —
    // and dark is not a grace window either, so nothing may be claimed about a deadline.
    {
      name: 'an unrecognised status tag',
      row: accountOf({ status: 'Suspended', deletionRequestedAtMs: WALL_T0_MS }),
    },
  ];

  it.each(OFF_ARMS)(
    '★ RB51T-OFF BITES ($name): the banner is showing, then is cleared and hidden',
    async ({ row }) => {
      // WRONG IMPL KILLED (1) ★ THE MEASURED SURVIVOR: a memo write with NO `else` branch —
      // `if (label !== null && label !== lastCountdownLabel) { write }`. It renders the
      // countdown correctly and then NEVER TAKES IT DOWN: a player who cancels their deletion
      // (arm 1) keeps staring at "your account will be deleted in 2d 3h 4m 5s", frozen, for
      // the rest of the session. The second half of each arm is the only thing that sees it.
      // WRONG IMPL KILLED (2): keying the banner on `deletionRequestedAtMs !== undefined`
      // rather than on the derived PHASE — arms 1 (cancel), 3 (terminal) and 5 (dark tag) all
      // carry a timestamp and must all render nothing.
      // WRONG IMPL KILLED (3): a truthiness test on `terminalAtMs` (arm 3, the 0n marker).
      // WRONG IMPL KILLED (4): dropping the store's owner filter, or fabricating an empty row
      // when there is none (arm 4).
      // ANTI-VACUITY: the FIRST half asserts the banner genuinely SHOWS the exact label, so
      // this arm can never pass because nothing was ever rendered — which is precisely how a
      // "boot straight into the off-state and assert hidden" test lies (the element is born
      // hidden). The wall clock is IDENTICAL across both frames, so the only thing that
      // changed is the row.
      const store = await setupMain(GRACE_DAY_SCALE);
      store.upsertAccount(LIVE_ROW);
      runFrame(0, WALL_T0);
      expectShowing(LABEL_AT_T0, 'the live grace window (anti-vacuity control)');

      store.upsertAccount(row);
      runFrame(16, WALL_T0);
      expectHidden('after the row left the grace window');
    },
  );

  // -------------------------------------------------------------------------------------
  // (e) The memo must not swallow a real update.
  // -------------------------------------------------------------------------------------

  it('★ RB51T-MEMO-CLEARS BITES: grace -> terminal at an UNCHANGED wall clock still takes the banner down', async () => {
    // The same shape as the RB51T-OFF terminal arm, kept as its own named tooth because it is
    // the one that pins the MEMO specifically: the change-detection key (the rendered label)
    // goes from a sentence to `null`, and an implementation that only writes when the new
    // label is non-null leaves the old sentence on screen forever. Stated plainly so a future
    // reader does not "deduplicate" it: this is NOT a memo-KEY discriminator (a `remainingMs`
    // key would pass it too — see the plan's D2); it is the missing-`else` killer.
    // WRONG IMPL KILLED: `if (label !== null && label !== lastCountdownLabel)` with no else.
    // ALSO KILLED: an else branch that hides the element but leaves `textContent` behind.
    const store = await setupMain(GRACE_DAY_SCALE);
    store.upsertAccount(LIVE_ROW);
    runFrame(0, WALL_T0);
    expectShowing(LABEL_AT_T0, 'the live grace window');

    store.upsertAccount(
      accountOf({
        status: 'PendingDeletion',
        deletionRequestedAtMs: WALL_T0_MS,
        terminalAtMs: 0n,
      }),
    );
    // Same wall clock, same everything except the row: nothing about the passage of time can
    // be credited for the banner going away.
    runFrame(16, WALL_T0);
    expectHidden('after the terminal marker landed');
  });

  // -------------------------------------------------------------------------------------
  // (c) The grace window comes from the WASM accessor — proved behaviourally, never by a
  //     call-site text pin (ADR-0231/ADR-0212: the number must not live in the client).
  // -------------------------------------------------------------------------------------

  it('★ RB51T-WASM-GRACE BITES: two DIFFERENT mocked grace windows produce two different deadlines, and each boot appends exactly one banner', async () => {
    // WRONG IMPL KILLED (1) ★: a grace window hard-coded in main.ts (or in privacyBanner.ts,
    // or defaulted `?? <number>`). ADR-0212 makes game-core the single source of truth for
    // that number and the wasm accessor the ONLY route to it; a client-side copy silently
    // drifts from the reaper the day the server value changes, and the player is told a
    // deadline the server does not honour. Two arms with two DISTINCT windows are what makes
    // this behavioural: a hard-coded value cannot satisfy both, and neither can a stub that
    // ignores the accessor.
    // WRONG IMPL KILLED (2): reading the accessor but dropping it before the derivation (e.g.
    // passing `0n`, or omitting `graceMs` so the countdown goes dark) — both arms would render
    // the DARK sentence or '0s', not these labels.
    // WRONG IMPL KILLED (3): a SECOND `#privacy-countdown` appended per boot (or per frame) —
    // duplicate ids make `getElementById` non-deterministic and leak one node per reconnect.
    // WHY A SECOND BOOT AND NOT JUST A SECOND FRAME: the contract reads the accessor ONCE at
    // module scope, so the only way to observe a different window is a fresh module generation
    // (`vi.resetModules()` + re-import), which is exactly what setupMain does.
    const firstStore = await setupMain(123_000n);
    firstStore.upsertAccount(
      accountOf({ status: 'PendingDeletion', deletionRequestedAtMs: WALL_T0_MS - 3_000n }),
    );
    runFrame(0, WALL_T0);
    // 123_000ms of window, 3_000ms already elapsed -> 120_000ms remaining.
    expectShowing('Account deletion in 2m 0s', 'grace window #1 (123_000n)');

    const secondStore = await setupMain(45_000n);
    secondStore.upsertAccount(
      accountOf({ status: 'PendingDeletion', deletionRequestedAtMs: WALL_T0_MS - 5_000n }),
    );
    runFrame(0, WALL_T0);
    // 45_000ms of window, 5_000ms already elapsed -> 40_000ms remaining.
    expectShowing('Account deletion in 40s', 'grace window #2 (45_000n)');

    expect(
      document.querySelectorAll('#privacy-countdown').length,
      'each boot must create exactly ONE #privacy-countdown (the previous document was cleared ' +
        'before this re-import) — duplicates make getElementById pick an arbitrary node',
    ).toBe(1);
  });
});
