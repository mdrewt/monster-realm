// @vitest-environment happy-dom
/**
 * main.shopBalance.test.ts: the wallet balance in the booted shop overlay (qf-17, QF17.3).
 *
 * The readout (`#shop-balance`, built by ShopView) and its per-batch re-render (main.ts's shop batch
 * listener) shipped before qf-17; this file is the tagged, user-surface proof of the criterion: the
 * shop overlay SHOWS the player's current wallet balance, sourced from the store's `my_wallet`
 * ingest, and UPDATES when that balance changes while the shop is open.
 *
 * Every case drives the REAL store of a freshly imported main.ts, mounted over the real
 * client/index.html shell with the REAL ShopView, and opens the shop the way a player does: the
 * greet-then-shop button of a server conversation (main.dialogueDismiss.test.ts's path), which
 * sends the dismiss and opens the shop on the first batch with no conversation. It reads only the
 * rendered `#shop-balance` (text, `hidden`, `data-balance-state`).
 *
 * Harness: main.dialogueDismiss.test.ts's pattern, copied (vi.resetModules + a fresh import per
 * boot, recorded window / document listeners detached in teardown, one controllable clock, a
 * stubbed wasm pkg and SDK connection).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  connectionRecordingMock,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { WasmMoveInput } from './convert/convert';
import type { ConnectionOptions } from './net/connection';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued. */
  sends: [] as unknown[],
  /** Every other reducer call, oldest first, with the exact argument object it received. */
  calls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgWalkingMock({ interact: () => [] }));

// The connection: capture the options; every reducer records its call and resolves at once.
vi.mock('./net/connection', () => connectionRecordingMock(H));

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

// The renderer: init(mount) appends a focusable canvas so main.ts can resolve its world focus.
vi.mock('./render/world', () => worldRendererMock());

// --- harness ------------------------------------------------------------------------------
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

function teardown(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  raf.cb = null;
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
}

let opts: ConnectionOptions;

async function bootReady(): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
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
}

const EID = 7n;
const NPC_ENTITY = 11n;
const SHOP_ID = 1;

/** Deliver one authoritative batch: own player + character row at clock `t`. */
function server(t: number): void {
  clock.t = t;
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
    t,
  );
  opts.store.flushBatch();
}

/** Seed the world: the own player at (2, 6), one NPC at (3, 6), the shop row, and the wallet row
 *  when `balance` is given (none = a player the server has not credited yet), in one batch. */
function seedWorld(t: number, balance?: bigint): void {
  opts.store.upsertNpc({
    entityId: NPC_ENTITY,
    npcId: 'guide',
    zoneId: 0,
    homeX: 3,
    homeY: 6,
    wanderRadius: 0,
    dialogueTreeId: 'no-such-tree',
    interaction: { kind: 'dialogue' },
  });
  opts.store.upsertCharacter(
    {
      entityId: NPC_ENTITY,
      zoneId: 0,
      tileX: 3,
      tileY: 6,
      facing: 'South',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
    },
    t,
  );
  opts.store.upsertShop({ shopId: SHOP_ID, name: 'General Store' });
  if (balance !== undefined) {
    opts.store.upsertWallet({ ownerIdentity: H.identity, balance });
  }
  server(t);
}

/** Click a greet-then-shop button, as the dialogue renders one (main.dialogueDismiss.test.ts). */
function clickShop(t: number): void {
  const button = document.createElement('button');
  button.dataset.shopId = String(SHOP_ID);
  const host =
    document.getElementById('dialogue-overlay') ?? document.getElementById('game-screen');
  if (host === null) throw new Error('the shell must ship #dialogue-overlay inside #game-screen');
  host.appendChild(button);
  clock.t = t;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  button.remove();
}

const shopShown = (): boolean => {
  const el = document.getElementById('shop-overlay');
  if (el === null) throw new Error('#shop-overlay is not in the shell');
  return el.style.display !== 'none';
};

function balanceEl(): HTMLElement {
  const el = document.getElementById('shop-balance');
  if (el === null) throw new Error('#shop-balance is not in the document');
  return el;
}

/** A player talking to the NPC clicks the shop button; the conversation ends and the shop opens. */
function openShop(t: number): void {
  opts.store.upsertConversation({
    ownerIdentity: H.identity,
    npcEntityId: NPC_ENTITY,
    currentNodeId: 'start',
  });
  server(t + 10);
  clickShop(t + 100);
  opts.store.removeConversation(H.identity);
  server(t + 200);
}

describe('main.ts booted: the wallet balance in the shop overlay (qf-17)', {
  sequential: true,
}, () => {
  afterEach(teardown);

  it('the open shop shows the wallet balance and follows it while the shop stays open: 50 reads Gold: 50, a batch carrying 80 reads Gold: 80, then 0 reads Gold: 0, and a player with no wallet row sees the readout hidden [QF17-3-WIRE-BALANCE-LIVE]', async () => {
    // WRONG IMPL KILLED: a balance painted once when the shop opens and never refreshed (the
    // player buys and the number stays frozen: the batch re-render is the criterion); a balance
    // read from the wrong place (another identity's wallet, a stale snapshot taken before the
    // open); a zero balance hidden as if unknown (truthiness instead of presence: a broke player
    // loses the readout exactly when it matters); a missing wallet row rendered as `Gold: 0`
    // (the broke-vs-dark rule: a row the server has not written is unknown, not empty); and a
    // readout that is never shown.
    await bootReady();
    seedWorld(1000, 50n);
    openShop(1100);
    expect(shopShown(), 'precondition: the shop is open').toBe(true);
    expect(balanceEl().textContent, 'the balance the store holds').toBe('Gold: 50');
    expect(balanceEl().hidden, 'a known balance is shown').toBe(false);
    expect(balanceEl().dataset.balanceState).toBe('known');

    // The balance changes while the shop is open (a sale, a payout, a settled trade).
    opts.store.upsertWallet({ ownerIdentity: H.identity, balance: 80n });
    server(1400);
    expect(shopShown(), 'the shop is still open').toBe(true);
    expect(balanceEl().textContent, 'the next batch updates the open shop').toBe('Gold: 80');
    expect(balanceEl().hidden).toBe(false);

    opts.store.upsertWallet({ ownerIdentity: H.identity, balance: 0n });
    server(1500);
    expect(balanceEl().textContent, 'a zero balance is a balance').toBe('Gold: 0');
    expect(balanceEl().hidden, 'and is shown, not hidden').toBe(false);
    expect(balanceEl().dataset.balanceState).toBe('known');

    // A player the server has not credited yet: no wallet row, so nothing to show.
    teardown();
    await bootReady();
    seedWorld(1000);
    openShop(1100);
    expect(shopShown(), 'precondition: the shop is open for the uncredited player').toBe(true);
    expect(balanceEl().hidden, 'no wallet row, no readout').toBe(true);
    expect(balanceEl().textContent, 'and no text').toBe('');
    expect(balanceEl().dataset.balanceState).toBe('unknown');
  });
});
