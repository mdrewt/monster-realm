// @vitest-environment happy-dom
/**
 * main.partyFull.test.ts — runtime gate over the Box "To Party" action in `main.ts`.
 *
 * Intended behavior (ADR-0155 D3, first-principles UX): moving a boxed monster to the party
 * either puts it in the first free party slot or TELLS THE PLAYER WHY NOT. With a full party
 * there is no free slot; the reducer must not be sent (the server would treat the fallback
 * slot as "move to box" — an accepted no-op the player never sees) and the status line must
 * say the party is full.
 *
 * Harness: the REAL main.ts booted against the REAL index.html shell, the SDK connection
 * mocked (its `live().reducers.setPartySlot` is a spy), the REAL store driven directly
 * (`reconcileMonstersFromView` + `flushBatch`, which is what connection.ts's batch flush does),
 * the box opened with a real KeyB press, and the real To Party button clicked.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionOptions } from './net/connection';
import type { StoreMonsterPub } from './net/store';
import { t } from './ui/i18n/resolver';

const H = vi.hoisted(() => {
  const setPartySlot = vi.fn(() => Promise.resolve());
  return {
    identity: 'ab'.repeat(32),
    connectOpts: null as unknown,
    setPartySlot,
    live: { reducers: { setPartySlot } } as unknown,
  };
});

// party_size() is 3 here, so three party monsters fill the party.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 64,
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

vi.mock('./net/connection', () => {
  const stub = {
    conn: undefined,
    live: () => H.live,
    identity: () => H.identity,
    linkFrozen: () => false,
    continueAnonymously: () => undefined,
    sessionState: () => 'hidden',
    startSignIn: () => undefined,
    reconnectNow: () => undefined,
  };
  return {
    connect: (opts: unknown) => {
      H.connectOpts = opts;
      return stub;
    },
  };
});

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

vi.mock('./render/world', () => {
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

/** Record module-scope listeners so afterEach can detach them (main.ts is re-imported per test). */
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

function buildAppShellFromRealIndexHtml(): void {
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const bodyChildren = Array.from(parsed.body.children).filter((e) => e.tagName !== 'SCRIPT');
  // ctl-7a (named intentional change): the shipped <body> is now three children (#game-screen,
  // #build-stamp, #a11y-live), so the old `body children > 5` floor is retired. The vacuity
  // guard counts the id-bearing elements the parse yielded instead (the real shell has ~60).
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'parsed index.html yielded almost no id-bearing elements').toBeGreaterThan(5);
  document.body.replaceChildren(...bodyChildren.map((e) => document.adoptNode(e)));
}

function monster(monsterId: bigint, partySlot: number): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: H.identity,
    speciesId: 1,
    nickname: `m${monsterId}`,
    level: 5,
    xp: 0,
    currentHp: 10,
    statHp: 10,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
    partySlot,
    tier: 0,
    essence: { Fire: 0, Water: 0, Plant: 0, Electric: 0, Earth: 0, Wind: 0, Light: 0, Dark: 0 },
    trustTier: 'Neutral',
    qualityTimeTier: 0,
    nutritionPct: 0,
  };
}

interface StoreHandle {
  reconcileMonstersFromView(rows: readonly StoreMonsterPub[]): void;
  flushBatch(): void;
}

let opts!: ConnectionOptions;
let recorded: Recorded[] = [];
let restoreWindowAdd: (() => void) | undefined;
let restoreDocumentAdd: (() => void) | undefined;

function deliverMonsters(rows: readonly StoreMonsterPub[]): void {
  const store = (opts as unknown as { store: StoreHandle }).store;
  store.reconcileMonstersFromView(rows);
  store.flushBatch();
}

/** Open the box with a real KeyB press (the world canvas holds focus) and return the
 *  To Party button on the boxed monster's card. */
function openBoxAndFindToParty(): HTMLButtonElement {
  document.querySelector('canvas')?.focus();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }));
  const label = t('box.card.toParty');
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
  expect(btn, `a "${label}" button must be rendered for the boxed monster`).toBeDefined();
  return btn as HTMLButtonElement;
}

function statusText(): string {
  return document.getElementById('status')?.textContent ?? '';
}

describe('main.ts Box "To Party" (BUG-party-full-to-party-silent-noop)', () => {
  beforeEach(async () => {
    recorded = [];
    H.connectOpts = null;
    H.setPartySlot.mockClear();
    buildAppShellFromRealIndexHtml();
    vi.stubGlobal('requestAnimationFrame', (): number => 0);
    restoreWindowAdd = recordListeners(window, recorded);
    restoreDocumentAdd = recordListeners(document, recorded);
    vi.resetModules();
    await import('./main');
    opts = (await vi.waitFor(
      () => {
        if (H.connectOpts === null) throw new Error('connect() has not been called by main() yet');
        return H.connectOpts;
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
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('with a free party slot, sends setPartySlot with that slot', () => {
    deliverMonsters([monster(1n, 0), monster(2n, 1), monster(3n, 255)]);
    openBoxAndFindToParty().click();
    expect(H.setPartySlot).toHaveBeenCalledTimes(1);
    expect(H.setPartySlot).toHaveBeenCalledWith({ monsterId: 3n, slot: 2 });
  });

  it('with a FULL party, sends nothing and tells the player the party is full', () => {
    deliverMonsters([monster(1n, 0), monster(2n, 1), monster(3n, 2), monster(4n, 255)]);
    openBoxAndFindToParty().click();
    expect(
      H.setPartySlot,
      'a full party must not send the move-to-box fallback slot — the server accepts it as a ' +
        'no-op and the player sees nothing happen',
    ).not.toHaveBeenCalled();
    expect(statusText()).toBe(t('chrome.status.partyFull'));
  });
});
