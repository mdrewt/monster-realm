// @vitest-environment happy-dom
/**
 * main.zoneCue.test.ts: the zone cue through the booted main.ts (qf-15: QF15.1).
 *
 * WHEN the player's own character changes zone, the client announces the destination zone's display
 * name: "Entering <name>" on the status line and, queued behind the live region's 500 ms coalescer,
 * through `#a11y-live`. The name is CONTENT: it arrives in a `zone_def` row, rests in the store
 * (`store.zoneName(id)`), and is never typed into the client; only the sentence around it is
 * catalogued (`chrome.status.zoneEntered`, en + fr). The client never decides a warp: it only names
 * the zone the SERVER put the character in.
 *
 * Both warp paths converge on `switchZone`, which is idempotent, so one real change is one cue:
 *   - the LIVE path: the adapter calls `onOwnWarp(zoneId)` from the character UPDATE, then ingests
 *     the row and flushes a batch;
 *   - the RECONCILE path: a batch whose own character sits in a zone other than the client's
 *     current map (a reconnect strand, a rejoin) switches state-based, with no `onOwnWarp`.
 * Accepted semantics (plan D8): a rejoin that lands in a zone different from the client's current
 * map DOES announce, since the server did change the zone. A first batch in the zone the client
 * already shows, a same-zone batch, a zone with no name row and a FAILED switch announce nothing.
 *
 * Harness: main.dialogueEnded.test.ts's, copied (vi.resetModules + a fresh import per test,
 * recorded window/document listeners detached in afterEach, one controllable clock, a stubbed wasm
 * pkg and SDK connection, the real client/index.html shell mounted before main.ts imports, a pumped
 * rAF so the frame loop's live-region pump runs, rows seeded through the REAL AuthoritativeStore with
 * one `flushBatch` per server burst). Two things are added: the wasm mock records every
 * `set_active_zone` and can refuse one zone's map (the failed-switch leg), and every write to
 * `#status` is recorded beside every write to `#a11y-live`.
 *
 * Every English line below is typed here, never read off the catalog under test. The zone names are
 * NON-shipped, so a hard-coded lookup cannot satisfy them.
 */
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  clock,
  frame,
  mountIndexHtmlShell,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import type { AuthoritativeStore, StoreCharacter } from './net/store';
import { TOAST_MS } from './ui/toast';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** The zone id of every `set_active_zone` call, oldest first. */
  activeZones: [] as number[],
  /** When not null, the wasm mock's `zone_map` throws for exactly this zone id. */
  throwZone: null as number | null,
}));

// wasm pkg: the walking mock, plus the zone switch's observable edges.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const base = wasmPkgWalkingMock();
  return {
    ...base,
    set_active_zone: (zoneId: number): void => {
      H.activeZones.push(zoneId);
    },
    zone_map: (zoneId: number) => {
      if (zoneId === H.throwZone) throw new Error(`no map for zone ${zoneId}`);
      return base.zone_map(zoneId);
    },
  };
});

// The connection: capture the options; every reducer resolves immediately.
vi.mock('./net/connection', () => {
  const reducers = new Proxy({}, { get: () => (): Promise<void> => Promise.resolve() });
  const live = { reducers };
  const stub = {
    conn: undefined,
    live: () => live,
    identity: () => H.identity,
    linkFrozen: () => false,
    worldScope: () => ({ own: null, zones: [], settled: false }),
    continueAnonymously: () => undefined,
    sessionState: () => 'hidden',
    startSignIn: () => undefined,
    reconnectNow: () => undefined,
  } as unknown as Connection;
  return {
    connect: (opts: ConnectionOptions): Connection => {
      H.connectOpts = opts;
      return stub;
    },
  };
});

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

// The renderer: init(mount) appends a focusable canvas so main.ts can resolve its world focus target.
vi.mock('./render/world', () => worldRendererMock());

// --- the lines under test, typed (never read off the catalog) --------------------------------
/** The zones' names, as zone_def rows carry them. NON-shipped on purpose. */
const COBALT = 'Cobalt Reach';
const UMBER = 'Umber Fen';
const ASH = 'Ash Hollow';
const CUE_COBALT = 'Entering Cobalt Reach';
const CUE_UMBER = 'Entering Umber Fen';

/** Zone 0 is the client's boot map (`zone_map(0)`); 0, 1 and 4 carry a name row, 3 deliberately
 *  does not, and the wasm mock refuses to build zone 4 (named on purpose: an impl that announces a
 *  switch that failed would have a name to announce). */
const ZONE_HOME = 0;
const ZONE_FEN = 1;
const ZONE_NAMELESS = 3;
const ZONE_BROKEN = 4;

// --- harness ------------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

/** Record module-scope listeners so afterEach can detach them; otherwise keydown and click
 *  handlers from earlier module generations stack up and double-send. */
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

/** Every value written to #a11y-live's textContent, oldest first. `textContent` is the live
 *  region's only content write (ui/liveRegion.ts), so this is everything it ever said. */
let liveWrites: string[] = [];
/** Every value written to #status's textContent, oldest first (a notice, an error report, a
 *  clear): everything the status line was ever told. Recorded from after boot. */
let statusWrites: string[] = [];
/** uif-4 (named intentional change): every value written to #toast's textContent after boot. The
 *  zone cue is a toast kind now, so what the player was told is read here, not off #status. The
 *  toast re-renders every frame, so a write COUNT means nothing; the DISTINCT non-empty texts do. */
let toastWrites: string[] = [];

/** Wrap `node`'s own `textContent` setter so every write lands in `sink`. The node keeps working:
 *  the write is forwarded to the real accessor. */
function recordWrites(node: HTMLElement, sink: string[]): void {
  let proto: object | null = Object.getPrototypeOf(node);
  let accessor: PropertyDescriptor | undefined;
  while (proto !== null && accessor === undefined) {
    accessor = Object.getOwnPropertyDescriptor(proto, 'textContent');
    proto = Object.getPrototypeOf(proto);
  }
  const get = accessor?.get;
  const set = accessor?.set;
  if (get === undefined || set === undefined) throw new Error('textContent is not an accessor');
  Object.defineProperty(node, 'textContent', {
    configurable: true,
    get() {
      return get.call(this);
    },
    set(value: unknown) {
      sink.push(String(value));
      set.call(this, value);
    },
  });
}

const byId = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`#${id} is not in the document`);
  return node;
};

let opts: ConnectionOptions;
let consoleError: MockInstance<typeof console.error> | undefined;

async function bootReady(): Promise<void> {
  H.connectOpts = null;
  H.activeZones = [];
  H.throwZone = null;
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  recorded = [];
  mountIndexHtmlShell();
  liveWrites = [];
  recordWrites(byId('a11y-live'), liveWrites);
  recordListeners(window);
  recordListeners(document);
  stubRaf();
  vi.resetModules();
  await import('./main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
  opts.onReady(H.identity);
  // main() builds #status before it calls connect(), so it exists by now.
  statusWrites = [];
  recordWrites(byId('status'), statusWrites);
  toastWrites = [];
  recordWrites(byId('toast'), toastWrites);
}

const EID = 7n;

function character(zoneId: number, tileX: number, tileY: number): StoreCharacter {
  return {
    entityId: EID,
    zoneId,
    tileX,
    tileY,
    facing: 'East',
    action: 'Idle',
    moveStartedAtMs: 0n,
    moveQueue: [] as WasmMoveInput[],
    ackedSeq: 0n,
  };
}

/** Write whatever `rows` writes into the REAL store and deliver it as ONE batch at clock `t`. */
function batch(t: number, rows: (store: AuthoritativeStore) => void): void {
  clock.t = t;
  rows(opts.store);
  opts.store.flushBatch();
}

/** My player row and my character in zone `zoneId` at (`tileX`, `tileY`). */
function ownRows(store: AuthoritativeStore, t: number, zoneId: number, tileX = 2, tileY = 6): void {
  store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    lastInputSeq: 0n,
  });
  store.upsertCharacter(character(zoneId, tileX, tileY), t);
}

/** The zone_def rows the server delivers on connect: the home zone, the fen and the broken zone,
 *  never zone 3. */
function seedZoneNames(store: AuthoritativeStore): void {
  store.upsertZoneName(ZONE_HOME, COBALT);
  store.upsertZoneName(ZONE_FEN, UMBER);
  store.upsertZoneName(ZONE_BROKEN, ASH);
}

/** The adapter's live-warp edge (connection.ts character.onUpdate -> isOwnZoneChange). */
function ownWarp(zoneId: number): void {
  const warp = opts.onOwnWarp;
  if (warp === undefined) throw new Error('main.ts must pass connect() an onOwnWarp');
  warp(zoneId);
}

/** Pump the frame loop every `stepMs` from `from` to `to`, inclusive. */
function frames(from: number, to: number, stepMs = 50): void {
  for (let t = from; t <= to; t += stepMs) frame(t);
}

/** The boot: the zone names and my character in the zone the client already shows, one batch,
 *  then frames until anything the boot would say has been said. */
function bootInHomeZone(): void {
  batch(1000, (s) => {
    seedZoneNames(s);
    ownRows(s, 1000, ZONE_HOME);
  });
  frames(1050, 1950);
  H.activeZones = [];
}

const statusText = (): string => byId('status').textContent ?? '';
/** uif-4: the toast's visible text, '' while it is hidden. */
const toastText = (): string => {
  const el = byId('toast');
  return el.hidden ? '' : (el.textContent ?? '');
};
/** The distinct non-empty texts #toast was ever painted with, in first-seen order. */
const toastShown = (): string[] => [...new Set(toastWrites.filter((w) => w !== ''))];
/** Everything either line was ever told (the status writes and the toast's distinct texts). */
const anyLine = (): string[] => [...statusWrites, ...toastShown()];
/** A write that announces a zone: the cue's sentence or any zone name. */
const isZoneCue = (write: string): boolean =>
  write.startsWith('Entering') ||
  write.includes(COBALT) ||
  write.includes(UMBER) ||
  write.includes(ASH);
const spokenCues = (): string[] => liveWrites.filter(isZoneCue);
const writtenCues = (): string[] => anyLine().filter(isZoneCue);
/** How many calls main.ts's console.error made whose first argument starts with `prefix`. */
const errorsWith = (prefix: string): number =>
  (consoleError?.mock.calls ?? []).filter(
    (c) => typeof c[0] === 'string' && c[0].startsWith(prefix),
  ).length;

describe('main.ts zone cue (runtime, qf-15)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    H.throwZone = null;
    consoleError = undefined;
    document.body.replaceChildren();
  });

  it('a live own-character warp announces the destination zone once on the status line, and the live region speaks it after its coalescing window [QF15-1-CUE-LIVE-WARP]', async () => {
    // WRONG IMPL KILLED: no cue (the status line and the live region stay as they were); a cue only
    // on the reconcile path (onOwnWarp reaches switchZone first, so the status line must already
    // read the cue before any batch arrives); a cue read before the store row is updated or from
    // the ORIGIN zone (the name must be zone 1's, "Umber Fen", not "Cobalt Reach"); a hard-coded
    // name (the zone names here are not shipped content); a second cue from the reconcile that
    // follows the warp (switchZone's idempotency: exactly one write); a cue that reaches the status
    // line but is never queued for the live region (a screen-reader user hears nothing); and a
    // cue spoken at once (it must wait out the coalescer, so the speak lands in the frames).
    await bootReady();
    bootInHomeZone();
    // uif-4 (named intentional change, UIF4.2): the cue is a toast kind. Every read of the cue below
    // is #toast's (was #status); the status line must never be told it. "Written exactly once" is
    // now "the toast's only distinct text is the cue" (the toast re-renders each frame, so a raw
    // write count is meaningless).
    expect(anyLine(), 'precondition: the boot batch told the player nothing').toEqual([]);
    expect(spokenCues(), 'precondition: the boot batch said no zone').toEqual([]);

    // The live path: onOwnWarp from the character UPDATE, then the row is ingested and flushed.
    clock.t = 2000;
    ownWarp(ZONE_FEN);
    expect(toastText(), 'the cue is on the toast at the warp').toBe(CUE_UMBER);
    batch(2000, (s) => ownRows(s, 2000, ZONE_FEN));
    expect(toastText(), 'and still the cue after the batch that confirms it').toBe(CUE_UMBER);
    expect(toastShown(), 'the toast was only ever painted with the cue').toEqual([CUE_UMBER]);
    expect(statusWrites, 'and the status line was told nothing').toEqual([]);
    expect(H.activeZones, 'one real zone change, one switch').toEqual([ZONE_FEN]);

    // The coalescer: queued at 2000, handed over at 2500, painted a full window later at 3000.
    frames(2050, 4000);
    expect(spokenCues(), 'the live region spoke the cue, once').toEqual([CUE_UMBER]);
    expect(toastText(), 'the toast still shows it').toBe(CUE_UMBER);
  });

  it('a reconcile-only zone change announces each destination zone by its own name, once per change, in both directions [QF15-1-CUE-RECONCILE]', async () => {
    // WRONG IMPL KILLED: a cue only on the live path (a reconnect strand or a rejoin never
    // announces); a cue naming the ORIGIN zone (the first change would read "Cobalt Reach"); a
    // hard-coded or first-name-wins cue (the way back must read "Cobalt Reach", the way there
    // "Umber Fen"); a cue written twice for one change; and a cue that reaches the status line
    // but not the live region (both are spoken, in order, once their windows have passed).
    await bootReady();
    bootInHomeZone();
    // uif-4 (named intentional change, UIF4.2): the cue is read off #toast (was #status), and
    // "one status write per change" is "the toast's distinct texts, in order".
    expect(anyLine(), 'precondition: the boot batch told the player nothing').toEqual([]);

    // No onOwnWarp: the batch alone puts my character in zone 1, and the state-based sync follows.
    batch(2000, (s) => ownRows(s, 2000, ZONE_FEN));
    expect(toastText(), 'the destination zone, by name').toBe(CUE_UMBER);
    expect(toastShown(), 'exactly one cue for the change').toEqual([CUE_UMBER]);
    expect(H.activeZones, 'one switch, to zone 1').toEqual([ZONE_FEN]);
    // Frames until the first cue has been painted (queued 2000, handed over 2500, painted 3000).
    frames(2050, 3450);
    expect(spokenCues(), 'the first cue was spoken').toEqual([CUE_UMBER]);

    // And back: the other direction, the other name.
    batch(3500, (s) => ownRows(s, 3500, ZONE_HOME));
    expect(toastText(), 'the way back names the home zone').toBe(CUE_COBALT);
    expect(toastShown(), 'one more cue, for the second change').toEqual([CUE_UMBER, CUE_COBALT]);
    expect(statusWrites, 'and the status line was told nothing').toEqual([]);
    expect(H.activeZones, 'two switches, there and back').toEqual([ZONE_FEN, ZONE_HOME]);
    frames(3550, 5500);
    expect(spokenCues(), 'both cues were spoken, in order, each once').toEqual([
      CUE_UMBER,
      CUE_COBALT,
    ]);
    expect(toastText(), 'the toast shows the newest').toBe(CUE_COBALT);
  });

  it('no zone is announced for the boot batch, a same-zone batch, a zone with no name row or a failed switch, and a later batch never re-asserts the cue over an error report [QF15-1-CUE-SILENT]', async () => {
    // WRONG IMPL KILLED, step by step (frames are pumped after each step, so every negative has had
    // the time to be spoken): a cue on the first batch in the zone the client already shows (the
    // boot would announce the home zone on every page load); a cue on every batch while the
    // character stays put (a per-tick re-announce); a cue for a zone with no zone_def row that
    // prints "Entering undefined", an empty name, or throws inside the reconcile; a cue re-asserted
    // over an error report (the status line must stay on "x: boom" through the batches that
    // follow); and a cue for a switch that failed (the client keeps the old map: announcing the new
    // zone would be a lie; zone 4 has a name row, so a cue outside the success path has a name to
    // announce and the negative is not vacuous).
    await bootReady();
    bootInHomeZone();
    // uif-4 (named intentional change, UIF4.2): every "wrote nothing to the status line" below is
    // "told the player nothing on either line" (`anyLine`: the status writes and the toast's texts),
    // and the cue itself is read off #toast.
    expect(anyLine(), 'the boot batch told the player nothing').toEqual([]);
    expect(spokenCues(), 'and the live region said no zone').toEqual([]);

    // Two more batches in the zone the client already shows.
    batch(2050, (s) => ownRows(s, 2050, ZONE_HOME, 3, 6));
    batch(2100, (s) => ownRows(s, 2100, ZONE_HOME, 4, 6));
    frames(2150, 3500);
    expect(anyLine(), 'same-zone batches tell the player nothing').toEqual([]);
    expect(spokenCues(), 'and say no zone').toEqual([]);
    expect(H.activeZones, 'and switch nothing').toEqual([]);

    // A real change into a zone the server sent no name row for: the switch runs, the cue does not.
    const reconcileErrors = errorsWith('[reconcile]');
    batch(3550, (s) => ownRows(s, 3550, ZONE_NAMELESS));
    frames(3600, 5000);
    expect(H.activeZones, 'precondition: the switch to the nameless zone really ran').toEqual([
      ZONE_NAMELESS,
    ]);
    expect(anyLine(), 'a zone with no name row tells the player nothing').toEqual([]);
    expect(spokenCues(), 'and says nothing').toEqual([]);
    expect(errorsWith('[zone-sync]'), 'it is not a failed switch').toBe(0);
    expect(errorsWith('[reconcile]'), 'and throws nothing out of the reconcile').toBe(
      reconcileErrors,
    );

    // A real change into the named fen: the cue, spoken, so what follows has something to lose.
    batch(5050, (s) => ownRows(s, 5050, ZONE_FEN));
    expect(toastText(), 'precondition: the named zone announces').toBe(CUE_UMBER);
    frames(5100, 7000);
    expect(spokenCues(), 'precondition: and the cue was spoken').toEqual([CUE_UMBER]);

    // An error report replaces the cue; batches that change no zone must leave the report alone.
    clock.t = 7050;
    opts.onError('x', 'boom');
    expect(statusText(), 'the error report is on the status line').toBe('x: boom');
    batch(7100, (s) => ownRows(s, 7100, ZONE_FEN, 3, 6));
    batch(7150, (s) => ownRows(s, 7150, ZONE_FEN, 4, 6));
    frames(7200, 8500);
    expect(statusText(), 'two same-zone batches leave the report alone').toBe('x: boom');
    expect(statusWrites, 'the report is the only thing the status line was told').toEqual([
      'x: boom',
    ]);
    expect(toastShown(), 'and the cue the only thing the toast was').toEqual([CUE_UMBER]);
    expect(spokenCues(), 'and the live region repeated no zone').toEqual([CUE_UMBER]);

    // A switch that fails: the wasm module cannot build zone 4, so the client keeps zone 1's map.
    H.throwZone = ZONE_BROKEN;
    const written = statusWrites.length;
    const toasted = toastWrites.length;
    batch(8550, (s) => ownRows(s, 8550, ZONE_BROKEN));
    frames(8600, 11000);
    expect(errorsWith('[zone-sync]'), 'precondition: the switch really failed').toBeGreaterThan(0);
    expect(H.activeZones, 'and never made the broken zone active').toEqual([
      ZONE_NAMELESS,
      ZONE_FEN,
    ]);
    expect(
      [...statusWrites.slice(written), ...toastWrites.slice(toasted)].filter(isZoneCue),
      'a failed switch tells the player no zone on either line',
    ).toEqual([]);
    expect(statusText().startsWith('Entering'), 'and the status line is not a cue').toBe(false);
    expect(spokenCues(), 'and the live region says no new zone').toEqual([CUE_UMBER]);
    expect(writtenCues(), 'the only cue ever written is the fen').toEqual([CUE_UMBER]);
  });

  // ------------------------------------------------------------------------------------------
  // uif-4 (UIF4.2): the toast channel
  // ------------------------------------------------------------------------------------------

  it('UIF4.2 a zone cue paints #toast with the cue and not #status', async () => {
    // WRONG IMPL KILLED: the cue left on the status line (it paints at z-index 45, under an open
    // frame); a cue painted on both lines.
    await bootReady();
    bootInHomeZone();
    clock.t = 2000;
    ownWarp(ZONE_FEN);
    expect(toastText()).toBe(CUE_UMBER);
    expect(statusText()).toBe('');
  });

  it('UIF4.2 the zone cue reaches #a11y-live exactly once across pumped frames', async () => {
    // WRONG IMPL KILLED: a toast the live region never speaks; a cue spoken once by the toast path
    // and again by the status path (two announcers); a cue re-queued by every frame's toast render.
    await bootReady();
    bootInHomeZone();
    clock.t = 2000;
    ownWarp(ZONE_FEN);
    batch(2000, (s) => ownRows(s, 2000, ZONE_FEN));
    frames(2050, 5500);
    expect(spokenCues()).toEqual([CUE_UMBER]);
  });

  it('UIF4.2 #toast is still visible one millisecond before TOAST_MS has elapsed', async () => {
    // WRONG IMPL KILLED: an early expiry (a dwell shorter than TOAST_MS, or an expiry off by one).
    await bootReady();
    bootInHomeZone();
    clock.t = 2000;
    ownWarp(ZONE_FEN);
    batch(2000, (s) => ownRows(s, 2000, ZONE_FEN));
    frame(2000 + TOAST_MS - 1);
    expect(toastText()).toBe(CUE_UMBER);
  });

  it('UIF4.2 #toast is hidden once TOAST_MS has elapsed', async () => {
    // WRONG IMPL KILLED: a toast that never expires, expires only on the next show, or lingers one
    // frame past its time (`>` instead of `>=`).
    await bootReady();
    bootInHomeZone();
    clock.t = 2000;
    ownWarp(ZONE_FEN);
    batch(2000, (s) => ownRows(s, 2000, ZONE_FEN));
    frame(2000 + TOAST_MS);
    expect(byId('toast').hidden).toBe(true);
    expect(toastText()).toBe('');
  });

  // ------------------------------------------------------------------------------------------
  // uif-4 (UIF4.5): hint precedence with content-stale (WF1-A9). content-stale is raised by
  // switchZone once three consecutive zone switches fail (zoneSyncGuard threshold 3): here the wasm
  // mock refuses zone 4's map and the reconcile batch keeps asking for it.
  // ------------------------------------------------------------------------------------------

  /** Fail zone switches until the status line carries the content-stale hint; returns its text. */
  function raiseContentStale(): string {
    H.throwZone = ZONE_BROKEN;
    let t = 3000;
    for (let i = 0; i < 8 && statusText() === ''; i += 1) {
      const at = t;
      batch(at, (s) => ownRows(s, at, ZONE_BROKEN));
      frames(at + 50, at + 250);
      t += 300;
    }
    const stale = statusText();
    expect(stale, 'precondition: repeated failed zone switches raised a status hint').not.toBe('');
    expect(isZoneCue(stale), 'precondition: it is not a zone cue').toBe(false);
    return stale;
  }

  it('UIF4.5 a content-stale hint followed by a link error keeps showing content-stale', async () => {
    // WRONG IMPL KILLED: a hint precedence that lets a later, lower-ranked persistent state
    // (world-disconnect, rank 2) overwrite an action-required content-stale (rank 3): the player
    // would lose the "reload" prompt behind a link message.
    await bootReady();
    bootInHomeZone();
    const stale = raiseContentStale();
    opts.onError('link', 'zz-socket-closed');
    frames(3600, 3900);
    expect(statusText()).toBe(stale);
    expect(toastShown().includes('link: zz-socket-closed')).toBe(false);
  });

  it('UIF4.5 after onReconnect the link error is gone and content-stale still shows', async () => {
    // WRONG IMPL KILLED: a reconnect that clears the content-stale hint too (it is "until reload":
    // a new link does not fix a client whose content is out of date), or one that leaves the link
    // error up.
    await bootReady();
    bootInHomeZone();
    const stale = raiseContentStale();
    opts.onError('link', 'zz-socket-closed');
    opts.onReconnect(H.identity);
    frames(3600, 3900);
    expect(statusText(), 'content-stale still shows').toBe(stale);
    expect(statusText().includes('zz-socket-closed'), 'the link error is gone').toBe(false);
  });
});
