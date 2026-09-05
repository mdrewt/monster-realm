// @vitest-environment happy-dom
/**
 * main.exportTransport.test.ts — the RUNTIME gate over `main.ts`'s EXPORT TRANSPORT: the live
 * chunk ingest, the on-batch assembly, and the download offer (rb-53, PRV1-11/12/13).
 *
 * ★ SOURCE OF TRUTH — gate E1, quoted verbatim:
 *   "[PRV1-11/12/13 live transport + download] WHEN request_data_export completes THE CLIENT
 *    SHALL read my_export_bundle from a live subscription, assemble it via
 *    assembleExportBundle, and offer the artifact as a downloadable file"
 *
 * Design record: `docs/adr/0231-client-privacy-cores-request-wide-chunk-assembly.md`,
 * Amendment A3 — A3-D2 (assembled ON BATCH, never per frame and never only on click), A3-D3
 * (behind a button, never auto-downloaded), A3-D4 (the control is always painted and only
 * disabled), A3-D7 (the CSP fallback logs a STATIC string — never the artifact), A3-D8
 * (revoke/remove in a `finally`), A3-D9 (`onReconnect` drops the cached assembly), A3-D10 (the
 * recompute is OUTSIDE the visibility guard).
 *
 * ★ CLONED FROM `main.privacyWiring.test.ts`, NOT APPENDED TO IT. That file's ten rb-52 teeth are
 * the gate on the delete/cancel surface and must not be put at risk by this slice's mocks,
 * spies or lifecycle. The harness below is its harness — the same `#app` shell built by parsing
 * the REAL `client/index.html` with `DOMParser` + `document.adoptNode` + `replaceChildren`
 * (never `innerHTML`, ADR-0135), the same listener-stacking cleanup, the same controllable rAF
 * queue, the same `connect` mock that hands back the REAL store instance `main.ts` constructed.
 *
 * ★ FOUR DELIBERATE DELTAS FROM THAT HARNESS, ALL LOAD-BEARING:
 *
 *   1. THE STORE IS DRIVEN DIRECTLY. `connect(opts)` hands this file `opts.store` — the REAL
 *      `AuthoritativeStore` instance main.ts owns — so the transport is exercised by calling
 *      `store.reconcileExportChunksFromView([...])` + `store.flushBatch()`, which is exactly
 *      what `connection.ts`'s batcher flush closure does on a live burst. That is the smallest
 *      possible stand-in for the SDK: a real store, real rows, real batch signal, no wasm, no
 *      socket, no wall clock.
 *
 *   2. `URL.createObjectURL` / `revokeObjectURL` ARE CAPTURED. They are the only observable
 *      boundary between "an artifact was assembled" and "a file was offered". The spy records
 *      the Blob it was handed, so the criterion can be asserted on the BYTES the player would
 *      receive rather than on "the handler ran".
 *
 *   3. `document.body.appendChild` IS CAPTURED during a click, because the download anchor is
 *      created, clicked and REMOVED inside one synchronous handler (A3-D8 puts the removal in a
 *      `finally`). Capturing it as it is appended is the only way to read `a.download` at all —
 *      and asserting the anchor is gone afterwards is how the `finally` is proved.
 *
 *   4. CONSOLE SINKS ARE CAPTURED BY ARGUMENT CONTENT, never by call count. A3-D7's whole point
 *      is that the fallback must not log the ARTIFACT; `toHaveBeenCalled()` says nothing about
 *      that, so every captured argument is stringified and searched for a canary planted inside
 *      the payload bytes.
 *
 * The frame is driven through `runFrame`, which stubs `performance.now()` for the duration of
 * one synchronous call. `Date.now()` is deliberately NOT stubbed: nothing here asserts on a
 * countdown NUMBER, and no export state depends on a clock.
 *
 * NO `new RegExp(...)`, no regex literal, no `eval`, no `new Function` anywhere. NO `innerHTML`
 * (ADR-0135). NO numeric duplicate of the grace window — every fixture value is synthetic.
 *
 * RED REASON AT AUTHORING TIME: `store.reconcileExportChunksFromView` does not exist, so the
 * harness's own precondition tooth fails first and by name; `main.ts` contains no
 * `assembleExportBundle(` call site and `ui/privacyView.ts` constructs no
 * `#privacy-download-btn`, so every case below reds on a MISSING IMPLEMENTATION.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, ConnectionOptions } from './net/connection';

// --- hoisted state shared with the mock factories --------------------------------------
const H = vi.hoisted(() => {
  const deleteAccount = vi.fn(() => Promise.resolve());
  const cancelAccountDeletion = vi.fn(() => Promise.resolve());
  const requestDataExport = vi.fn(() => Promise.resolve());
  const liveHandle = { reducers: { deleteAccount, cancelAccountDeletion, requestDataExport } };
  return {
    identity: 'ab'.repeat(32),
    connectOpts: null as unknown,
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

// The wasm pkg — identical shape to main.privacyWiring.test.ts's mock. `deletion_grace_ms_default`
// crosses as a BigInt (`-> i64`, ADR-0212), so the stub is `1n`, not `1`; it is deliberately a
// SYNTHETIC window and never the shipped value.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
    deletion_grace_ms_default: () => 1n,
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

// The connection. DELTA 1 lives here: `connect` captures the options object, which carries the
// REAL store instance main.ts constructed — the seam every test below drives the transport
// through. `ownAccount` is wrapped exactly as the rb-52 harness wraps it, so an account-row
// fixture stays available if a future case needs one.
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
      const realOwnAccount = opts.store.ownAccount.bind(opts.store);
      opts.store.ownAccount = (id: string) => H.account ?? realOwnAccount(id);
      return stub as unknown as Connection;
    },
  };
});

// Telemetry: keep the real types/NOOP, never bootstrap the OTel SDK (no network).
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

// The renderer: constructed unconditionally before the `#app` guard. `init(mount)` appends a
// real focusable canvas so `mount.querySelector('canvas')` resolves.
vi.mock('./render/world', () => {
  class WorldRenderer {
    init(mount: HTMLElement): Promise<void> {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('tabindex', '0');
      canvas.setAttribute('role', 'application');
      mount.appendChild(canvas);
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

// --- listener-cleanup harness (verbatim from main.privacyWiring.test.ts) ----------------
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
  expect(
    bodyChildren.length,
    'ANTI-VACUITY: parsed index.html yielded no usable <body> children — the DOM this whole ' +
      'file depends on would be empty and every test below would fail for the wrong reason',
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
 *  the per-frame-cost tooth below pass vacuously against a frame that never ran. */
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

// --- export-chunk fixtures ---------------------------------------------------------------
//
// The store row shape is spelled STRUCTURALLY here rather than imported: `StoreExportChunk` does
// not exist yet, and a type-only import of it would be erased anyway, so a local interface both
// documents the contract and keeps this file's collection independent of it. `store.test.ts` is
// what pins the exported NAME.

interface Rb53Chunk {
  readonly chunkId: bigint;
  readonly ownerIdentity: string;
  readonly requestId: bigint;
  readonly tableName: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly payloadJson: string;
  readonly createdAtMs: bigint;
}

/** A byte sequence that exists ONLY inside the export payload. Every "did the dump leak?"
 *  assertion in this file searches for it, so a leak is caught by CONTENT rather than by a
 *  length, a call count or a shape. */
const RB53_CANARY = 'RB53-EXPORT-CANARY-4d1e';
/** The same idea for a DIFFERENT owner's payload, so an owner-filter failure is caught by the
 *  presence of foreign bytes rather than by an absence. */
const RB53_FOREIGN_MARKER = 'RB53-FOREIGN-CANARY-7a05';

const RB53_REQUEST_ID = 4242n;
/** A LATER request id belonging to somebody else — see RB53T-FOREIGN-ABSENT for why "later"
 *  is the load-bearing part. */
const RB53_FOREIGN_REQUEST_ID = 9999n;

const RB53_PAYLOAD_0 = `{"table":"account","rows":[{"note":"${RB53_CANARY}"}]}`;
const RB53_PAYLOAD_1 = '{"table":"player","rows":[{"name":"rb53-player"}]}';
const RB53_PAYLOAD_2 = '{"table":"monster_pub","rows":[{"nickname":"rb53-monster"}]}';

/**
 * ★ THE EXPECTED ARTIFACT, HAND-WRITTEN FROM THE ENVELOPE THE CORE SPECIFIES — never recomputed
 * by calling `assembleExportBundle` here. Deriving the expectation from the implementation under
 * test is the one shape that cannot fail: a core replaced by `artifact: ''` would produce an
 * expectation of `''` and the assertion would pass. Spelling the envelope out is what makes the
 * equality a specification. (`exportAssembly.ts`'s own suite is what proves the core BUILDS it;
 * this file proves the whole path from a delivered row to the bytes in the file.)
 */
const RB53_EXPECTED_ARTIFACT =
  '{"request_id":"4242","total_chunks":3,"chunks":[' +
  RB53_PAYLOAD_0 +
  ',' +
  RB53_PAYLOAD_1 +
  ',' +
  RB53_PAYLOAD_2 +
  ']}';

function rb53Chunk(chunkId: bigint, overrides: Partial<Rb53Chunk> = {}): Rb53Chunk {
  return {
    chunkId,
    ownerIdentity: H.identity,
    requestId: RB53_REQUEST_ID,
    tableName: 'account',
    chunkIndex: 0,
    totalChunks: 3,
    payloadJson: RB53_PAYLOAD_0,
    createdAtMs: 1_700_000_000_000n,
    ...overrides,
  };
}

/** The three chunks of one complete request, DELIBERATELY DELIVERED OUT OF ORDER. The SDK cache
 *  gives no ordering guarantee, and the artifact must be spliced by the REQUEST-WIDE
 *  `chunkIndex`, so a delivery order that already matches the required order would let an
 *  order-blind concatenation pass. */
const RB53_COMPLETE_ROWS: readonly Rb53Chunk[] = [
  rb53Chunk(3n, { chunkIndex: 2, tableName: 'monster_pub', payloadJson: RB53_PAYLOAD_2 }),
  rb53Chunk(1n, { chunkIndex: 0, tableName: 'account', payloadJson: RB53_PAYLOAD_0 }),
  rb53Chunk(2n, { chunkIndex: 1, tableName: 'player', payloadJson: RB53_PAYLOAD_1 }),
];

/** Two of the three — the ORDINARY state while an export is still streaming in. */
const RB53_INCOMPLETE_ROWS: readonly Rb53Chunk[] = [
  RB53_COMPLETE_ROWS[1] as Rb53Chunk,
  RB53_COMPLETE_ROWS[2] as Rb53Chunk,
];

/** Another player's chunk, carrying a NEWER request id and its own marker payload. */
const RB53_FOREIGN_ROW: Rb53Chunk = {
  chunkId: 99n,
  ownerIdentity: 'ff'.repeat(32),
  requestId: RB53_FOREIGN_REQUEST_ID,
  tableName: 'account',
  chunkIndex: 0,
  totalChunks: 1,
  payloadJson: `{"table":"account","rows":[{"note":"${RB53_FOREIGN_MARKER}"}]}`,
  createdAtMs: 1_700_000_000_000n,
};

// --- store handle -------------------------------------------------------------------------

/** The subset of the real store this file drives. Declared structurally so a missing method is
 *  a clear "is not a function" at the call site rather than a type-only complaint in an editor. */
interface Rb53StoreHandle {
  reconcileExportChunksFromView(rows: readonly Rb53Chunk[]): void;
  ownExportChunks(identity: string): readonly Rb53Chunk[];
  flushBatch(): void;
  reset(): void;
}

let opts!: ConnectionOptions;

function storeOf(): Rb53StoreHandle {
  return (opts as unknown as { store: Rb53StoreHandle }).store;
}

/** Deliver a row set exactly as `connection.ts`'s batcher flush closure does: reconcile from the
 *  post-burst set, then signal the batch. */
function deliver(rows: readonly Rb53Chunk[]): void {
  const store = storeOf();
  store.reconcileExportChunksFromView(rows);
  store.flushBatch();
}

// --- DOM helpers -------------------------------------------------------------------------

/** The nearest ancestor (INCLUDING the node itself) that is `display:none`, or `null` when the
 *  node is on-screen all the way to `<body>`. `main.ts`'s own `focusInsideHiddenSubtree` idiom;
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

function downloadBtn(): HTMLButtonElement {
  const node = byId('privacy-download-btn');
  expect(
    node.tagName,
    '#privacy-download-btn must be a NATIVE <button> (ADR-0231 A2-D3 / A3-D4)',
  ).toBe('BUTTON');
  return node as HTMLButtonElement;
}

function privacyOverlayVisible(): boolean {
  const overlay = document.getElementById('privacy-overlay');
  return overlay !== null && overlay.style.display !== 'none' && overlay.style.display !== '';
}

/**
 * The front door: the ONE button inside the Account & Sign-in overlay that opens the privacy
 * surface (ADR-0231 A2-D5). DISCOVERED BY ROLE, not by a hard-coded id, and the count is
 * asserted — "exactly one privacy door" is the contract-level statement.
 */
function privacyOpener(): HTMLButtonElement {
  const claim = byId('claim-overlay');
  const doors = Array.from(claim.querySelectorAll('button')).filter((b) =>
    b.id.includes('privacy'),
  );
  expect(
    doors.length,
    'the Account & Sign-in overlay must contain EXACTLY ONE button whose id names the privacy ' +
      `surface; found ${doors.length} (${doors.map((b) => b.id).join(', ')})`,
  ).toBe(1);
  return doors[0] as HTMLButtonElement;
}

/** Open the surface through the real production path and assert it actually opened. */
function openPrivacySurface(): void {
  privacyOpener().click();
  expect(
    privacyOverlayVisible(),
    'clicking the account overlay`s privacy door must open #privacy-overlay',
  ).toBe(true);
}

// --- the object-URL capture (DELTA 2) -----------------------------------------------------

interface UrlCapture {
  readonly blobs: unknown[];
  readonly urls: string[];
  readonly revoked: string[];
  /** Flipped by the CSP/sandbox case: the next `createObjectURL` throws, as a hardened browser
   *  policy makes it do. */
  throwOnCreate: boolean;
}

let urlCapture: UrlCapture;
let restoreUrlSpies: (() => void) | undefined;

function installUrlSpies(): void {
  const urlCtor = URL as unknown as Record<string, unknown>;
  // ANTI-VACUITY: if this happy-dom build does not implement the object-URL API, every capture
  // below would be empty and every "a file was offered" assertion would be measuring nothing.
  // Fail here, by name, rather than silently.
  expect(
    typeof urlCtor.createObjectURL,
    'ANTI-VACUITY: this happy-dom build must implement URL.createObjectURL — it is the ONE ' +
      'observable boundary between "an artifact was assembled" and "a file was offered", and ' +
      'without it every download assertion in this file is vacuous',
  ).toBe('function');
  expect(typeof urlCtor.revokeObjectURL, 'ANTI-VACUITY: …and URL.revokeObjectURL').toBe('function');

  const capture: UrlCapture = { blobs: [], urls: [], revoked: [], throwOnCreate: false };
  const createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(((
    blob: unknown,
  ): string => {
    if (capture.throwOnCreate) {
      throw new Error('rb53: object URLs are blocked by policy');
    }
    capture.blobs.push(blob);
    const url = `blob:rb53-export-${capture.urls.length}`;
    capture.urls.push(url);
    return url;
  }) as unknown as typeof URL.createObjectURL);
  const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(((url: string): void => {
    capture.revoked.push(url);
  }) as unknown as typeof URL.revokeObjectURL);

  urlCapture = capture;
  restoreUrlSpies = () => {
    createSpy.mockRestore();
    revokeSpy.mockRestore();
  };
}

/** The text of the one Blob handed to `createObjectURL`. Asserts the captured value really is a
 *  Blob first — a handler that passed a raw string would otherwise read as "the bytes are
 *  right" while producing a file the browser cannot type. */
async function soleBlobText(): Promise<string> {
  expect(
    urlCapture.blobs.length,
    'exactly ONE object URL must have been created — zero means no file was offered at all, ' +
      'two means the click produced two downloads',
  ).toBe(1);
  const blob = urlCapture.blobs[0] as Blob;
  expect(
    typeof (blob as unknown as { text?: unknown }).text,
    'ANTI-VACUITY: the value handed to createObjectURL must be a real Blob with a text() ' +
      'method — a raw string would produce a file with no type and no length',
  ).toBe('function');
  return blob.text();
}

// --- the download-anchor capture (DELTA 3) ------------------------------------------------

/** Click the download control while watching what gets appended to <body>, so the anchor can be
 *  read before the `finally` removes it (A3-D8). Returns every element appended during the
 *  click, nearest-first order preserved. */
function clickDownloadCapturingAnchors(): HTMLElement[] {
  const appended: HTMLElement[] = [];
  const realAppend = document.body.appendChild.bind(document.body);
  const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation(((node: Node) => {
    if (node instanceof HTMLElement) appended.push(node);
    return realAppend(node);
  }) as typeof document.body.appendChild);
  try {
    downloadBtn().click();
  } finally {
    appendSpy.mockRestore();
  }
  return appended;
}

// --- console capture (DELTA 4) ------------------------------------------------------------

interface ConsoleCapture {
  readonly args: unknown[];
  restore(): void;
}

const CONSOLE_SINKS = ['log', 'error', 'warn', 'info', 'debug'] as const;

function installConsoleSpies(): ConsoleCapture {
  const args: unknown[] = [];
  const restores: Array<() => void> = [];
  for (const sink of CONSOLE_SINKS) {
    const spy = vi.spyOn(console, sink).mockImplementation((...called: unknown[]) => {
      for (const a of called) args.push(a);
    });
    restores.push(() => spy.mockRestore());
  }
  return {
    args,
    restore: () => {
      for (const r of restores) r();
    },
  };
}

/**
 * A searchable rendering of one logged argument.
 *
 * ACCEPTED LIMIT, stated rather than hidden: a value whose `JSON.stringify` throws (a circular
 * object) degrades to `String(value)`, which for a plain object is "[object Object]" and would
 * hide a canary held in a property. Nothing on the download path constructs such a value, and
 * the failure direction is a MISSED leak rather than a false alarm — so the artifact ban below
 * is a floor, not a ceiling.
 */
function argText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return `${value.name}: ${value.message} ${value.stack ?? ''}`;
  try {
    const json = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

// --- the suite ---------------------------------------------------------------------------

describe('main.ts export transport (rb-53, PRV1-11/12/13)', () => {
  let recorded: Recorded[] = [];
  let restoreWindowAdd: (() => void) | undefined;
  let restoreDocumentAdd: (() => void) | undefined;

  beforeEach(async () => {
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
    installUrlSpies();
    restoreWindowAdd = recordListeners(window, recorded);
    restoreDocumentAdd = recordListeners(document, recorded);

    vi.resetModules();
    await import('./main');
    opts = (await vi.waitFor(
      () => {
        const captured = H.connectOpts;
        if (captured === null) throw new Error('connect() has not been called by main() yet');
        return captured;
      },
      { timeout: 5_000, interval: 5 },
    )) as ConnectionOptions;
    opts.onReady(H.identity);
  });

  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    restoreDocumentAdd?.();
    restoreWindowAdd?.();
    restoreDocumentAdd = undefined;
    restoreWindowAdd = undefined;
    restoreUrlSpies?.();
    restoreUrlSpies = undefined;
    H.connectOpts = null;
    vi.unstubAllGlobals();
    rafCallback = null;
    document.body.replaceChildren();
  });

  // ---------------------------------------------------------------------------------------
  // The harness's own precondition. Asserted as a TEST, not as a silent helper, so a broken
  // seam reports itself by name instead of making nine other cases fail obscurely.
  // ---------------------------------------------------------------------------------------

  it('★ RB53T-HARNESS-DRIVES-THE-REAL-STORE: the captured connect() options carry the real store, and a delivered row set is readable back through the owner filter', () => {
    // WHY THIS EXISTS: every other case in this file drives the transport through
    // `opts.store.reconcileExportChunksFromView(...)`. If that seam were wrong — a different
    // store instance, a stubbed method, a silently-swallowed call — the download control would
    // simply never enable and NINE cases would red with "expected false to be true", which
    // diagnoses nothing. This one fails first and says exactly what is missing.
    const store = storeOf();
    expect(
      typeof store.reconcileExportChunksFromView,
      'the real AuthoritativeStore must expose reconcileExportChunksFromView — RED AT AUTHORING ' +
        'TIME: it does not exist (store.test.ts owns its unit contract)',
    ).toBe('function');
    expect(typeof store.ownExportChunks, '…and ownExportChunks').toBe('function');

    deliver(RB53_COMPLETE_ROWS);
    expect(
      [...store.ownExportChunks(H.identity)].length,
      'the three delivered chunks must be readable back for THIS identity — if this is 0 the ' +
        'harness is driving a different store instance than main.ts holds',
    ).toBe(3);
  });

  // ---------------------------------------------------------------------------------------
  // ★ THE CRITERION, END TO END.
  // ---------------------------------------------------------------------------------------

  it('★★★ RB53T-CRITERION-END-TO-END: three delivered chunks become a downloadable file whose BYTES are exactly the assembled artifact', async () => {
    // ★ THIS IS GATE E1 IN ONE TEST: a live row set is read from the store, assembled via
    // `assembleExportBundle`, and offered as a downloadable file — asserted on the BYTES the
    // player would receive, not on "the handler ran".
    //
    // WRONG IMPL KILLED (1) ★ THE ONE EVERY OTHER TOOTH IN THIS SLICE MISSES: the assembly
    //   stubbed or short-circuited — a core replaced by `artifact: ''`, a handler that builds
    //   the Blob from `JSON.stringify(chunks)`, or one that writes the FIRST chunk only. Every
    //   presence and enablement assertion in this file still passes; the player gets a file
    //   that is empty, differently-shaped, or missing most of their data. Byte equality against
    //   a HAND-WRITTEN envelope is the only assertion that sees it.
    // WRONG IMPL KILLED (2): a download that never produces bytes at all (a handler wired to
    //   nothing, or one that only reports "not implemented") — `createObjectURL` is never
    //   called and `soleBlobText` reds on a zero count.
    // WRONG IMPL KILLED (3) ★: an ORDER-BLIND concatenation. The rows are delivered 2, 0, 1, so
    //   an implementation that splices them in delivery order (or in Map-insertion order)
    //   produces a DIFFERENT artifact and fails the equality — while a fixture delivered in
    //   index order would let it pass.
    // WRONG IMPL KILLED (4): the surface repainting on open but not on the arrival BATCH — the
    //   surface is opened BEFORE the rows arrive here on purpose, so the control must come
    //   alive on the batch signal alone (A3-D2: the assembly is computed ON BATCH).
    openPrivacySurface();
    expect(
      downloadBtn().disabled,
      'precondition: with no export delivered the control is painted and REFUSED — a control ' +
        'that starts enabled would make the transition below meaningless',
    ).toBe(true);

    deliver(RB53_COMPLETE_ROWS);

    const control = downloadBtn();
    expect(
      hiddenAncestorOf(control),
      'the download control must be ON SCREEN — A3-D4: always painted, only ever disabled',
    ).toBeNull();
    expect(
      (control.textContent ?? '').length,
      'and labelled — a blank button has no accessible name',
    ).toBeGreaterThan(0);
    expect(
      control.disabled,
      'a COMPLETE export must enable the control on the arrival batch, with no re-open and no ' +
        'further interaction (A3-D2)',
    ).toBe(false);

    control.click();

    const text = await soleBlobText();
    expect(
      text.indexOf(RB53_CANARY),
      'the downloaded bytes must contain the payload canary — if they do not, the file the ' +
        'player receives is not built from the delivered chunks at all',
    ).not.toBe(-1);
    expect(
      text,
      'the downloaded bytes must be EXACTLY the assembled artifact: the request-wide envelope ' +
        'with the three payloads spliced VERBATIM in chunk_index order. This expectation is ' +
        'hand-written from the envelope the core specifies — do NOT "fix" a failure by ' +
        'recomputing it from the implementation',
    ).toBe(RB53_EXPECTED_ARTIFACT);
  });

  it('★★ RB53T-DOWNLOAD-ANCHOR: the anchor carries a SAFE filename, is clicked, and is removed with its object URL revoked', async () => {
    // ★ A3-D8, and it is not hygiene: in the F9 bug-bundle precedent (`main.ts:2333-2336`) the
    // `a.remove()` and `URL.revokeObjectURL(url)` sit inside the `try`, AFTER `a.click()`. A
    // throw there pins the object URL — and therefore the whole Blob — for the page's lifetime,
    // and leaves a stray `<a href>` in the document. At bug-bundle scale that is kilobytes; at
    // export scale it is the player's entire personal-data dump, retained in memory.
    // WRONG IMPL KILLED (1): no revoke at all (the Blob is pinned forever).
    // WRONG IMPL KILLED (2): revoking a DIFFERENT url than the one created — the equality below.
    // WRONG IMPL KILLED (3): the anchor left in the document.
    // WRONG IMPL KILLED (4): a filename that ignores the request (or renders the token
    //   "undefined"). The exhaustive filename contract is pinned in privacyBanner.test.ts; what
    //   is pinned HERE is that the safe name actually reaches `a.download` — a wiring fact no
    //   pure test can see.
    openPrivacySurface();
    deliver(RB53_COMPLETE_ROWS);
    expect(downloadBtn().disabled, 'precondition: the control is live').toBe(false);

    const appended = clickDownloadCapturingAnchors();
    const anchors = appended.filter((n) => n.tagName === 'A') as HTMLAnchorElement[];
    expect(
      anchors.length,
      'the download must go through EXACTLY ONE anchor appended to <body> — zero means no file ' +
        'was offered, two means the click produced two downloads',
    ).toBe(1);
    const anchor = anchors[0] as HTMLAnchorElement;

    const name = anchor.download;
    expect(typeof name, 'the anchor must carry a `download` filename').toBe('string');
    expect(name.length, 'and it must be non-empty').toBeGreaterThan(0);
    expect(name.endsWith('.json'), `the filename must end with .json — got ${name}`).toBe(true);
    for (const banned of ['/', '\\', '..', ':', ' ', 'undefined']) {
      expect(
        name.indexOf(banned),
        `the download filename ${JSON.stringify(name)} contains ${JSON.stringify(banned)}. It ` +
          'reaches the OS, and it is the only part of this feature the player sees before they ' +
          'open the file',
      ).toBe(-1);
    }

    expect(
      anchor.isConnected,
      'the anchor must be REMOVED after the click (A3-D8: in a `finally`) — a stray <a href> ' +
        'holding a blob URL keeps the whole export alive in memory for the page`s lifetime',
    ).toBe(false);
    expect(urlCapture.urls.length, 'one object URL was created').toBe(1);
    expect(
      urlCapture.revoked,
      'URL.revokeObjectURL must be called with the SAME url that was created — revoking ' +
        'nothing, or revoking a different handle, pins the Blob for the page`s lifetime',
    ).toContain(urlCapture.urls[0]);

    // …and the bytes are still the right ones (so this case cannot pass on an empty file).
    expect((await soleBlobText()).indexOf(RB53_CANARY)).not.toBe(-1);
  });

  // ---------------------------------------------------------------------------------------
  // Refusals: incomplete, foreign-owned, reaped, rotated identity.
  // ---------------------------------------------------------------------------------------

  it('★★ RB53T-INCOMPLETE-REFUSED: 2 of 3 chunks leave the control disabled, and a click produces NO file', () => {
    // ★ WRONG IMPL KILLED: enabling the download on ANY assembly that has rows —
    //   `downloadEnabled: assembly !== undefined`, or `receivedChunks > 0`. The player would be
    //   handed a TRUNCATED personal-data file and told it was their export, which is worse than
    //   refusing because it looks authoritative. `exportAssembly` returns `artifact: undefined`
    //   for every non-complete status, so such a build also downloads the literal text
    //   "undefined" or an empty file.
    // ★ THE SECOND CLAUSE IS DEFENCE IN DEPTH AND IS DELIBERATE: `disabled` is the contract, but
    //   a programmatic click must ALSO produce nothing. Whether happy-dom (or a future browser)
    //   dispatches to a disabled control is not something this feature should depend on — the
    //   artifact is the player's complete personal data, and "no truncated file is ever
    //   produced" must hold however the handler is reached. If this clause reds while the
    //   `disabled` one passes, the fix is a guard in the download handler, not a weaker test.
    openPrivacySurface();
    deliver(RB53_INCOMPLETE_ROWS);

    const control = downloadBtn();
    expect(
      hiddenAncestorOf(control),
      'and it stays ON SCREEN while refused (A3-D4) — a control that vanishes under focus ' +
        'strands the focus trap',
    ).toBeNull();
    expect(
      control.disabled,
      'an INCOMPLETE export must not be downloadable — two of three chunks is a truncated ' +
        'personal-data file',
    ).toBe(true);

    expect(() => control.click()).not.toThrow();
    expect(
      urlCapture.blobs.length,
      'no file may be produced for an incomplete export, by any route',
    ).toBe(0);

    // ANTI-VACUITY: the very same surface DOES enable once the third chunk lands, so the
    // refusal above is a real decision and not a control that is simply never live.
    deliver(RB53_COMPLETE_ROWS);
    expect(
      downloadBtn().disabled,
      'ANTI-VACUITY: the third chunk must flip the control live — otherwise "disabled on 2 of ' +
        '3" is satisfied by a button that is disabled forever',
    ).toBe(false);
  });

  it('★★ RB53T-FOREIGN-ABSENT: a FOREIGN chunk with a NEWER request id never reaches the downloaded file', async () => {
    // ★ WHY THE FOREIGN ROW CARRIES A **NEWER** REQUEST ID, and what this does and does not
    // prove — stated honestly, because the shape matters.
    //   The owner filter exists in TWO places by design: `store.ownExportChunks(identity)`
    //   (ADR-0015 V1) and `assembleExportBundle`'s own first-line filter (exportAssembly.ts:96).
    //   With a foreign row of the same-or-lower request id, removing EITHER one alone changes
    //   nothing observable here — the surviving filter still produces the correct artifact — so
    //   such a fixture would be a defence-in-depth check with no teeth.
    //   A foreign row with a HIGHER request id changes that: `assembleExportBundle` selects the
    //   NEWEST request, so if BOTH filters are gone the selected request becomes the foreign
    //   one and the downloaded file is ANOTHER PLAYER'S DATA — caught below by the presence of
    //   the foreign marker, the absence of our canary, and the wrong request id in the envelope.
    //   It ALSO kills a wiring slip this file is the only place to catch: `main.ts` passing the
    //   WRONG owner to the assembler (a stale identity, `''`, or a chunk's own `ownerIdentity`),
    //   which makes the whole assembly collapse to `none` and the control dead.
    //   The store-side filter's own both-directions proof lives in `store.test.ts`
    //   (RB53S-OWNER-BOTH-DIRECTIONS); the core's lives in `exportAssembly.test.ts`.
    openPrivacySurface();
    deliver([...RB53_COMPLETE_ROWS, RB53_FOREIGN_ROW]);

    expect(
      downloadBtn().disabled,
      "a foreign player's chunk must not disturb my own complete export",
    ).toBe(false);
    downloadBtn().click();

    const text = await soleBlobText();
    expect(
      text.indexOf(RB53_FOREIGN_MARKER),
      "the downloaded file contains ANOTHER PLAYER'S payload bytes. Both owner filters (the " +
        "store's client-side scope and assembleExportBundle's own) are gone, and the artifact " +
        "the player is about to save is somebody else's personal data",
    ).toBe(-1);
    expect(
      text.indexOf(RB53_CANARY),
      'and it must still contain MY payload — an implementation that filtered everything out ' +
        'would satisfy the ban above while producing an empty export',
    ).not.toBe(-1);
    expect(text, 'the envelope must name MY request, not the newer foreign one').toBe(
      RB53_EXPECTED_ARTIFACT,
    );
  });

  it('★★ RB53T-REAPED-GOES-DEAD: when the server purges the chunks, the next applied batch takes the download offer away', () => {
    // ★ THE TTL REAPER, END TO END. `export_bundle` rows are deleted server-side after 7 days
    // (and by `delete_account`'s cascade), so the view stops delivering them and the reconcile
    // prunes the map. The offer must go with them.
    // WRONG IMPL KILLED (1): a cached assembly that is computed once and never recomputed —
    //   the control would keep offering a file assembled from rows the server has already
    //   purged, which is a retention promise the product does not keep.
    // WRONG IMPL KILLED (2): an upsert-only reconcile (store.test.ts's RB53S-RECONCILE-PRUNES
    //   is the unit half; this is the end-to-end consequence).
    //
    // ⚠ WHY THIS IS PHRASED AS A PRUNE AND NOT AS `store.reset()`: `reset()` sets the store's
    // dirty flag to FALSE, so a `flushBatch()` immediately after it is a documented no-op and no
    // batch listener runs — the cached assembly could not possibly be recomputed by that
    // sequence. ADR-0231 A3-D9 ACCEPTS exactly that window ("between a link drop and the next
    // applied batch the button still offers the last artifact") and covers the case that
    // matters — an identity rotation — through `onReconnect`, which the next test pins. Writing
    // this tooth against `reset()` would have made it unsatisfiable without changing the pinned
    // one-call-site design.
    openPrivacySurface();
    deliver(RB53_COMPLETE_ROWS);
    expect(downloadBtn().disabled, 'precondition: the export is downloadable').toBe(false);

    deliver([]);

    expect(
      downloadBtn().disabled,
      'once the view stops delivering the chunks, the download offer must be withdrawn',
    ).toBe(true);
    expect(
      hiddenAncestorOf(downloadBtn()),
      'and the control stays PAINTED while refused (A3-D4)',
    ).toBeNull();
    expect(() => downloadBtn().click()).not.toThrow();
    expect(urlCapture.blobs.length, 'and no file may be produced from the purged rows').toBe(0);
  });

  it('★★ RB53T-RECONNECT-DROPS-ARTIFACT: onReconnect with a DIFFERENT identity kills the offer', async () => {
    // ★ ADR-0231 A3-D9. A rebuild can mint a NEW identity (`connection.ts:722`,
    // `main.ts:2868`), and the cached artifact is `main.ts` state, NOT store state — so
    // `store.reset()` does not reach it. Without an explicit clear, the download button keeps
    // offering the PREVIOUS identity's complete personal-data export to whoever is at the
    // keyboard after the rotation. That is the one case in A3-D9 that is a leak rather than
    // merely stale.
    // WRONG IMPL KILLED (1) ★: no clear at all — the assertion below reads `false` (still
    //   enabled) and a click would hand over the old artifact.
    // WRONG IMPL KILLED (2): the clear placed BEFORE `identity = id` in the onReconnect body,
    //   where a same-frame recompute would immediately restore it from the old identity's
    //   chunks. (The ordering itself is pinned in main.wiring.test.ts; this is the behaviour.)
    // THE FRAME IS LOAD-BEARING: `onReconnect` clears main.ts's countdown memo, so the NEXT
    // frame re-pumps `account-changed` and repaints the surface. Without running a frame the
    // DOM would still show the pre-reconnect paint and this tooth would pass for the wrong
    // reason — so the positive (still enabled after the reconnect, before any repaint) is NOT
    // asserted, only the post-repaint state.
    openPrivacySurface();
    deliver(RB53_COMPLETE_ROWS);
    expect(downloadBtn().disabled, 'precondition: the export is downloadable').toBe(false);
    // ANTI-VACUITY: prove a file really is producible in this state, before taking it away.
    downloadBtn().click();
    expect((await soleBlobText()).indexOf(RB53_CANARY)).not.toBe(-1);
    urlCapture.blobs.length = 0;
    urlCapture.urls.length = 0;

    const rotatedIdentity = 'cd'.repeat(32);
    expect(
      rotatedIdentity,
      'ANTI-VACUITY: the rotation must be a REAL change of identity',
    ).not.toBe(H.identity);
    opts.onReconnect(rotatedIdentity);
    runFrame(1);

    expect(
      downloadBtn().disabled,
      'after an identity rotation the cached artifact must be GONE — it belongs to the previous ' +
        'identity, and the person at the keyboard may not be the same person (A3-D9)',
    ).toBe(true);
    expect(() => downloadBtn().click()).not.toThrow();
    expect(
      urlCapture.blobs.length,
      "and no file may be produced from the previous identity's artifact",
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------------------
  // A3-D10 — the recompute is OUTSIDE the visibility guard.
  // ---------------------------------------------------------------------------------------

  it('★★ RB53T-COMPLETE-WHILE-CLOSED: an export that completes while the surface is CLOSED is ready the moment it opens', () => {
    // ★ A3-D10, and it is the bug that decision forecloses: putting the recompute INSIDE
    // `if (privacyView?.visible)`. The overlay is closed for almost the entire life of a
    // session — the player clicks Export, closes the surface, and comes back later — so a
    // guarded recompute means the arrival batch is DROPPED and the surface, on open, still
    // believes nothing has arrived. `openPrivacy()` renders from CURRENT state, so the correct
    // shape (recompute unconditionally, repaint only while visible) picks it up for free.
    // WRONG IMPL KILLED (2): a recompute that only runs on CLICK — then the surface could never
    //   say whether an export is ready, and the button would be a coin flip (A3-D2's other half).
    expect(privacyOverlayVisible(), 'precondition: the surface starts CLOSED').toBe(false);

    deliver(RB53_COMPLETE_ROWS);

    openPrivacySurface();
    expect(
      downloadBtn().disabled,
      'the export completed while the surface was closed — opening it must find the artifact ' +
        'already assembled (A3-D10)',
    ).toBe(false);

    const statusLine = byId('privacy-export-status');
    expect(
      (statusLine.textContent ?? '').length,
      'and the surface must SAY the export is ready — the status line is the only place the ' +
        'player learns what state their export is in',
    ).toBeGreaterThan(0);
    expect(hiddenAncestorOf(statusLine), 'and that sentence must be on screen').toBeNull();
  });

  // ---------------------------------------------------------------------------------------
  // A3-D7 — the failure path must never log the artifact.
  // ---------------------------------------------------------------------------------------

  it('★★★ RB53T-NO-LEAK-ON-FAILURE: when createObjectURL throws, nothing escapes the handler and NO log sink or on-screen surface receives the artifact bytes', async () => {
    // ★ ADR-0231 A3-D7, and it is a DELIBERATE DIVERGENCE from the precedent this handler is
    // otherwise modelled on. `downloadBugBundle` (main.ts:2336-2340) logs its WHOLE PAYLOAD on
    // failure — which is safe there only because `KeyStoreSnapshot` is a no-PII allowlist by
    // construction (bugBundle.ts:24-33). The export artifact is the exact opposite: every
    // exportable table, including player-authored names and behavioural history. Logging it
    // would retain the player's complete personal-data dump in the devtools buffer for the
    // page's life and — routed through `reportError` — put it ON SCREEN and into the
    // `errorRing` that `buildBugBundle` embeds in the file players are asked to ATTACH to bug
    // reports. No existing gate would catch that: `evals/client-no-pii-logs.eval.mjs`'s ban
    // list is credential-shaped.
    //
    // WRONG IMPL KILLED (1) ★ THE COPY-PASTE: `catch { console.log('[export]', artifact); … }`.
    // WRONG IMPL KILLED (2): `reportError(\`export failed: ${artifact}\`)` — same bytes, worse
    //   destination (statusEl, the error overlay, and the downloadable bug bundle).
    // WRONG IMPL KILLED (3): no catch at all — the throw escapes the click handler into the
    //   listener dispatch. The `.not.toThrow()` clause is what sees it.
    //
    // ★ ASSERTED ON ARGUMENT CONTENTS, NEVER ON `toHaveBeenCalled()`. A call-count assertion
    // says nothing about what was logged, which is the entire question here.
    openPrivacySurface();
    deliver(RB53_COMPLETE_ROWS);
    expect(downloadBtn().disabled, 'precondition: the control is live').toBe(false);

    // ANTI-VACUITY, FIRST: the artifact really does contain the canary on the SUCCESS path, so
    // "the canary is absent from the logs" below is a statement about the failure handler and
    // not about a canary that was never in play.
    downloadBtn().click();
    expect(
      (await soleBlobText()).indexOf(RB53_CANARY),
      'ANTI-VACUITY: the successful download must carry the canary — otherwise the leak checks ' +
        'below are searching for bytes this build never had',
    ).not.toBe(-1);

    // Now make the browser refuse, as a CSP/sandbox policy does.
    urlCapture.throwOnCreate = true;
    const consoleCapture = installConsoleSpies();
    let escaped: unknown;
    try {
      try {
        downloadBtn().click();
      } catch (err) {
        escaped = err;
      }

      expect(
        escaped,
        'nothing may escape the download handler — a throw out of a click listener reaches the ' +
          'window `error` path, and on this surface that means an unhandled exception in the ' +
          'middle of a privacy interaction (A3-D7 requires a catch, not an absent one)',
      ).toBeUndefined();

      // The catch must be OBSERVABLE — a silent no-op is the dead-button black hole this repo
      // bans. This also makes the content bans below non-vacuous: it proves the failure path
      // really executed and really wrote somewhere.
      const surfaceText = document.body.textContent ?? '';
      const wroteSomething = consoleCapture.args.length > 0 || surfaceText.length > 0;
      expect(
        wroteSomething,
        'a blocked download must SAY SO somewhere — a silent no-op leaves the player clicking a ' +
          'live button that does nothing, forever',
      ).toBe(true);

      for (const arg of consoleCapture.args) {
        const text = argText(arg);
        expect(
          text.indexOf(RB53_CANARY),
          `a console sink received the ARTIFACT BYTES: ${JSON.stringify(text.slice(0, 200))}. ` +
            'The fallback must log a STATIC string (A3-D7). This is the player`s complete ' +
            'personal-data export — logging it retains it in the devtools buffer for the ' +
            'page`s life, and anything that routes it through reportError also puts it in the ' +
            'errorRing that buildBugBundle embeds in the file players ATTACH to bug reports',
        ).toBe(-1);
        expect(
          text.indexOf(RB53_PAYLOAD_1),
          'and not a single chunk payload either — a "just the first chunk, for debugging" ' +
            'variant is the same leak with a smaller number',
        ).toBe(-1);
      }

      expect(
        surfaceText.indexOf(RB53_CANARY),
        'the ON-SCREEN error surface must not carry the artifact bytes either — reportError ' +
          'writes the status line AND pushes into the error overlay, both of which are visible ' +
          'and one of which is serialised into the downloadable bug bundle',
      ).toBe(-1);
    } finally {
      consoleCapture.restore();
      urlCapture.throwOnCreate = false;
    }
  });

  // ---------------------------------------------------------------------------------------
  // A3-D2 — the assembly is computed ON BATCH, never per frame.
  // ---------------------------------------------------------------------------------------

  it('★★ RB53T-NO-PER-FRAME-WORK: after a complete export, several frames read the chunk map ZERO times', () => {
    // ★ A3-D2. Per-frame is a full re-scan of the chunk map and, at `complete`, a full
    // re-concatenation of the whole export — 60 times a second, forever, for a value that only
    // changes when a transaction burst lands. At export scale that is not a micro-optimisation:
    // the artifact is every exportable row the player owns.
    // WRONG IMPL KILLED ★: moving the recompute into the frame body (the obvious "keep it
    //   fresh" edit, and the one that reads as harmless because every behavioural assertion in
    //   this file would still pass). The wrapper below is the DELTA-2 idiom this harness family
    //   already uses for `ownAccount`: wrap ONE store read on the real instance and count it.
    // WRONG IMPL KILLED (2): a recompute placed in the rAF repaint gate — `main.ts:3028` is
    //   keyed on `statusLabel` alone, which export state does not move, so the batch listener
    //   is the SOLE repaint owner for this part of the surface (A3-D10's closing note).
    openPrivacySurface();
    deliver(RB53_COMPLETE_ROWS);
    expect(
      downloadBtn().disabled,
      'precondition: the export is assembled and offered, so the frame has every reason to ' +
        'want to recompute it',
    ).toBe(false);

    // Wrap AFTER the arrival batch, so the legitimate on-batch read is not counted.
    const store = storeOf();
    const reads: string[] = [];
    const realOwnExportChunks = store.ownExportChunks.bind(store);
    (store as unknown as Record<string, unknown>).ownExportChunks = (id: string) => {
      reads.push(id);
      return realOwnExportChunks(id);
    };

    for (let i = 0; i < 4; i += 1) runFrame(10 + i);

    expect(
      reads.length,
      `the frame body read the chunk map ${reads.length} time(s) across four frames. The ` +
        'assembly is computed ON BATCH (ADR-0231 A3-D2) — `store.onBatchApplied` fires once per ' +
        'coalesced transaction burst, which is precisely the arrival edge. A per-frame read ' +
        're-scans the map and re-concatenates the whole export 60x/s',
    ).toBe(0);

    // ANTI-VACUITY: the wrapper is real — a further BATCH must still reach it. Without this, a
    // wrapper that was never installed (or a store method that no longer exists) would report
    // zero reads for the wrong reason and this tooth would be permanently green.
    deliver([...RB53_COMPLETE_ROWS, rb53Chunk(4n, { chunkIndex: 3, totalChunks: 4 })]);
    expect(
      reads.length,
      'ANTI-VACUITY: the wrapped accessor must be reached by the next BATCH — if this is still ' +
        '0 the wrapper was never installed and the zero above proves nothing',
    ).toBeGreaterThan(0);
  });
});
