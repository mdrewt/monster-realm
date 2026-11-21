// @vitest-environment happy-dom
/**
 * main.hostNotice.test.ts: the booted client tells a player, once per friends server, that the
 * server's host can read and change their data in that world.
 *
 * EARS: WHEN a player first joins a `private` target, THE CLIENT SHALL show once, for that server,
 * that its host can read and change their data in that world.
 *
 * Every case boots the REAL main.ts over the real client/index.html shell, under a shell document
 * on the page global (the document names the target kind), with the recording connection
 * (`connectionRecordingMock`): the test drives the first join through the `onReady` option main.ts
 * handed `connect()`, and a reconnect through `onReconnect`. It reads what the page shows on
 * `#status`, every write to `#a11y-live` (what the live region said), and the page's real
 * localStorage. Boots in one case share the browser profile: storage is cleared only between cases.
 *
 * The decision is `ui/hostNoticeModel.ts` (hostNoticeModel.test.ts); this file proves the wiring.
 * Every expected line is typed here, never read off the catalogs; the French accents and the
 * apostrophe are built by code point.
 *
 * Harness: main.protocolCheck.test.ts's whole-page boot (a fresh import per boot, window / document
 * listeners recorded and detached in teardown, the live-region write recorder, frames on the
 * harness clock so the announcement pump runs) and main.claimCode.test.ts's instance storage spies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  connectionRecordingMock,
  frame,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  telemetryMock,
  wasmPkgIdentityMoveMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { ConnectionOptions } from './net/connection';
import { SHELL_CONFIG_GLOBAL, type ShellDocument, type TargetKind } from './net/shellDocument';
import { hostNoticeStorageKey } from './ui/hostNoticeModel';

const H = vi.hoisted(() => ({
  identity: 'ef'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  sends: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock('../../client-wasm/pkg/client_wasm.js', () =>
  wasmPkgIdentityMoveMock({ interact: () => [] }),
);

vi.mock('./net/connection', () => connectionRecordingMock(H));

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

vi.mock('./render/world', () => worldRendererMock());

// --- the line under test, typed (never read off the catalogs) --------------------------------
const RIGHT_QUOTE = String.fromCharCode(0x2019);
const O_CIRCUMFLEX = String.fromCharCode(0x00f4);
const E_ACUTE = String.fromCharCode(0x00e9);
const NBSP = String.fromCharCode(0x00a0);
const NOTICE_EN = "This server's host can read and change your data in this world.";
const NOTICE_FR = `L${RIGHT_QUOTE}h${O_CIRCUMFLEX}te de ce serveur peut lire et modifier vos donn${E_ACUTE}es dans ce monde.`;
/** The prefix every host-notice mark is stored under. */
const MARK_PREFIX = 'mr.hostNotice';

// --- the targets ---------------------------------------------------------------------------
const FRIEND_URI = 'wss://friend.example:4443/';
const FRIEND_DB = 'realm-friend';
/** A friends server. */
const PRIVATE_A: ShellDocument = {
  connection: { uri: FRIEND_URI, db: FRIEND_DB, kind: 'private' },
};
/** Another friends server: another uri, the same db. */
const PRIVATE_OTHER_URI: ShellDocument = {
  connection: { uri: 'wss://another.example:5050/', db: FRIEND_DB, kind: 'private' },
};
/** Another world on the same host: the same uri, another db. */
const PRIVATE_OTHER_DB: ShellDocument = {
  connection: { uri: FRIEND_URI, db: 'realm-second', kind: 'private' },
};
/** PRIVATE_A's pair under another kind, so only the kind can decide. */
const sameTargetAs = (kind: TargetKind): ShellDocument => ({
  connection: { uri: FRIEND_URI, db: FRIEND_DB, kind },
});

/** The mark key for PRIVATE_A, typed: the versioned prefix and the two percent-encoded segments. */
const KEY_A = 'mr.hostNotice.v1|wss%3A%2F%2Ffriend.example%3A4443%2F|realm-friend';

// --- harness ---------------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

/** main.ts registers window/document listeners at MODULE scope: record each so teardown can detach
 *  it, or a second import leaves a live handler from a dead module instance. */
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

/** Every value written to #a11y-live's textContent during the current boot, oldest first. */
let liveWrites: string[] = [];

/** Wrap `node`'s own `textContent` setter so every write lands in `sink`, then the real one. */
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
const statusText = (): string => byId('status').textContent ?? '';

/** How many times the live region said `text` this boot (a repeat carries a trailing U+00A0). */
const timesSaid = (text: string): number =>
  liveWrites.filter((w) => w === text || w === `${text}${NBSP}`).length;

/** The host-notice marks a storage area holds, as [key, value] pairs, sorted by key. */
function marksIn(s: Storage): Array<readonly [string, string | null]> {
  const marks: Array<readonly [string, string | null]> = [];
  for (let i = 0; i < s.length; i += 1) {
    const key = s.key(i);
    if (key?.startsWith(MARK_PREFIX)) marks.push([key, s.getItem(key)]);
  }
  return marks.sort((a, b) => {
    if (a[0] === b[0]) return 0;
    return a[0] < b[0] ? -1 : 1;
  });
}

/** The page clock: every frame moves it forward. */
let T = 1000;

/** Run frames every `stepMs` (default 50 ms) for `ms` of clock. */
function frames(ms: number, stepMs = 50): void {
  const end = T + ms;
  while (T < end) {
    T += stepMs;
    frame(T);
  }
}

let opts: ConnectionOptions;

/** Boot a fresh main.ts under `doc` and `search` (e.g. `?locale=fr`), keeping both storages as
 *  they are (one browser profile across the boots of a case). Resolves once connect() was called,
 *  the frame loop is armed and the boot's own announcements have been pumped; no `onReady` yet. */
async function boot(doc: ShellDocument, search = ''): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  window.history.replaceState(null, '', `/${search}`);
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: unknown, _init?: unknown) =>
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    ),
  );
  (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL] = doc;
  T = 1000;
  clock.t = T;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
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
  await vi.waitFor(
    () => {
      if (raf.cb === null) throw new Error('the frame loop is not armed yet');
    },
    { timeout: 5_000, interval: 5 },
  );
  frames(2_000);
}

/** The page's first successful join, then enough frames for the live region to speak. */
function join(): void {
  clock.t = T;
  opts.onReady(H.identity);
  frames(2_000);
}

/** Remove a boot's listeners and shell, so a second boot in the same case starts clean. Storage
 *  is left alone: the next boot is the same browser profile. */
function teardownBoot(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  raf.cb = null;
  document.body.replaceChildren();
}

/** Record every key the page's session and local storage are asked to get or set (instance
 *  spies, as main.claimCode.test.ts explains: a prototype spy misses happy-dom's bound methods). */
function spyStorage() {
  const stores = [globalThis.sessionStorage, globalThis.localStorage];
  const gets = stores.map((s) => vi.spyOn(s, 'getItem'));
  const sets = stores.map((s) => vi.spyOn(s, 'setItem'));
  const keysOf = (spies: ReadonlyArray<{ mock: { calls: unknown[][] } }>): string[] =>
    spies.flatMap((spy) => spy.mock.calls).map((c) => String(c[0]));
  return {
    gets: (): string[] => keysOf(gets),
    sets: (): string[] => keysOf(sets),
  };
}

beforeEach(() => {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  teardownBoot();
  delete (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
  localStorage.clear();
});

describe('the booted client shows a friends server`s host notice once per server', () => {
  it('shows the host notice on #status and says it through the live region on the first join of a private target, and marks exactly that server in localStorage [lpw-9.6]', async () => {
    // WRONG IMPL KILLED: no notice at all; a mark written but the line never painted (or painted
    // on the toast, gone after its timer); the line painted but never marked; a mark in
    // sessionStorage (gone with the tab); a mark under another key or value.
    await boot(PRIVATE_A);
    expect(statusText(), 'precondition: not shown before the join').not.toBe(NOTICE_EN);
    expect(timesSaid(NOTICE_EN), 'precondition: not said before the join').toBe(0);
    expect(marksIn(localStorage), 'precondition: nothing marked before the join').toEqual([]);

    join();

    expect(statusText(), 'the line stands on #status').toBe(NOTICE_EN);
    expect(timesSaid(NOTICE_EN), 'the live region said it once').toBe(1);
    expect(hostNoticeStorageKey(FRIEND_URI, FRIEND_DB), 'fixture: the model`s key').toBe(KEY_A);
    expect(marksIn(localStorage), 'exactly this server is marked, with 1').toEqual([[KEY_A, '1']]);
    expect(marksIn(sessionStorage), 'nothing is marked per tab').toEqual([]);
  }, 30_000);

  it('does not show or say the notice on a second page load against the same server [lpw-9.6]', async () => {
    // WRONG IMPL KILLED: the notice shown on every page load (a module-scope flag in place of the
    // stored mark; a mark that is written and never read).
    await boot(PRIVATE_A);
    join();
    expect(statusText(), 'precondition: the first load showed it').toBe(NOTICE_EN);
    expect(marksIn(localStorage), 'precondition: the server is marked').toEqual([[KEY_A, '1']]);
    teardownBoot();

    await boot(PRIVATE_A);
    join();
    frames(3_000);

    expect(statusText(), 'the second load does not show it').not.toBe(NOTICE_EN);
    expect(timesSaid(NOTICE_EN), 'and the live region does not say it').toBe(0);
    expect(marksIn(localStorage), 'the mark is unchanged').toEqual([[KEY_A, '1']]);
  }, 30_000);

  it('does not show or say the notice again when the same page reconnects, with the mark present or gone [lpw-9.6]', async () => {
    // WRONG IMPL KILLED: the notice shown on every reconnect (wired in onReconnect too); a reconnect
    // that re-checks storage and shows it again when the mark is gone (a blocked or cleared write).
    await boot(PRIVATE_A);
    join();
    expect(statusText(), 'precondition: the first join showed it').toBe(NOTICE_EN);
    expect(timesSaid(NOTICE_EN), 'precondition: said once').toBe(1);

    opts.onReconnect(H.identity);
    frames(3_000);
    expect(statusText(), 'a reconnect with the mark present does not show it').not.toBe(NOTICE_EN);
    expect(timesSaid(NOTICE_EN), 'and does not say it again').toBe(1);

    localStorage.clear();
    opts.onReconnect(H.identity);
    frames(3_000);
    expect(statusText(), 'a reconnect on a never-marked server does not show it').not.toBe(
      NOTICE_EN,
    );
    expect(timesSaid(NOTICE_EN), 'and does not say it again').toBe(1);
    expect(marksIn(localStorage), 'and a reconnect writes no mark').toEqual([]);
  }, 30_000);

  it('shows the notice for another private server in the same browser profile: another uri, then the same uri with another db [lpw-9.6]', async () => {
    // WRONG IMPL KILLED: one mark per browser (no second server ever shows it); a mark keyed on the
    // uri alone (another world on the same host never shows it).
    await boot(PRIVATE_A);
    join();
    expect(statusText(), 'precondition: the first server showed it').toBe(NOTICE_EN);
    teardownBoot();

    await boot(PRIVATE_OTHER_URI);
    join();
    expect(statusText(), 'another uri: shown').toBe(NOTICE_EN);
    expect(timesSaid(NOTICE_EN), 'another uri: said').toBe(1);
    teardownBoot();

    await boot(PRIVATE_OTHER_DB);
    join();
    expect(statusText(), 'the same uri, another db: shown').toBe(NOTICE_EN);
    expect(timesSaid(NOTICE_EN), 'the same uri, another db: said').toBe(1);

    // Sorted by key: `another.example` sorts before `friend.example`, `realm-friend` before
    // `realm-second`.
    expect(marksIn(localStorage), 'each server holds its own mark').toEqual([
      ['mr.hostNotice.v1|wss%3A%2F%2Fanother.example%3A5050%2F|realm-friend', '1'],
      [KEY_A, '1'],
      ['mr.hostNotice.v1|wss%3A%2F%2Ffriend.example%3A4443%2F|realm-second', '1'],
    ]);
  }, 60_000);

  for (const kind of ['local', 'official', 'test'] as const) {
    it(`never shows the notice for a ${kind} target, and reads and writes no host-notice key [lpw-9.6]`, async () => {
      // WRONG IMPL KILLED: the notice on a single-player world (the player is the host) or on a
      // server we operate; a kind check made after the storage read; a mark written for any kind.
      const storage = spyStorage();
      await boot(sameTargetAs(kind));
      join();
      frames(3_000);

      expect(opts.targetKind, `precondition: main.ts booted a ${kind} target`).toBe(kind);
      expect(statusText(), `${kind}: not shown`).not.toBe(NOTICE_EN);
      expect(timesSaid(NOTICE_EN), `${kind}: not said`).toBe(0);
      expect(
        storage.gets().filter((k) => k.startsWith(MARK_PREFIX)),
        `${kind}: no host-notice key read`,
      ).toEqual([]);
      expect(
        storage.sets().filter((k) => k.startsWith(MARK_PREFIX)),
        `${kind}: no host-notice key written`,
      ).toEqual([]);
      expect(marksIn(localStorage), `${kind}: nothing marked`).toEqual([]);
    }, 30_000);
  }

  it('shows the French host notice under the French locale [lpw-9.6]', async () => {
    // WRONG IMPL KILLED: a literal English line in main.ts; the key missing from the French
    // catalog; the French entry left as the English copy.
    await boot(PRIVATE_A, '?locale=fr');
    join();
    expect(statusText()).toBe(NOTICE_FR);
    expect(statusText()).not.toBe(NOTICE_EN);
    expect(timesSaid(NOTICE_FR), 'said once, in French').toBe(1);
    expect(marksIn(localStorage), 'and marked').toEqual([[KEY_A, '1']]);
  }, 30_000);

  it('still shows the notice when localStorage throws on read and on write [lpw-9.6]', async () => {
    // WRONG IMPL KILLED: unreadable storage suppresses the notice (a blocked-storage player is never
    // told); a throw from the read or the write that escapes onReady before the line is painted.
    await boot(PRIVATE_A);
    const reads = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });
    const writes = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });
    clock.t = T;
    opts.onReady(H.identity);
    const readKeys = reads.mock.calls.map((c) => String(c[0]));
    const writtenKeys = writes.mock.calls.map((c) => String(c[0]));
    reads.mockRestore();
    writes.mockRestore();
    frames(2_000);

    expect(readKeys, 'precondition: the join tried to read the mark').toContain(KEY_A);
    expect(writtenKeys, 'and tried to write it').toContain(KEY_A);
    expect(statusText(), 'the line stands on #status').toBe(NOTICE_EN);
    expect(timesSaid(NOTICE_EN), 'and the live region said it').toBe(1);
    expect(marksIn(localStorage), 'no write landed').toEqual([]);
  }, 30_000);
});
