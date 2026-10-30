// @vitest-environment happy-dom
/**
 * main.partyFull.test.ts — runtime gate over moving a boxed monster to the party in `main.ts`.
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
 * and real key taps (keydown, then keyup).
 *
 * qf-8 (named intentional change, QF8.1): the Box card's "To Party" button is deleted; the move is
 * the Monsters sheet's Move row. The path is the player's: KeyB opens the Monsters frame directly
 * on Storage (`ACCEL_PATHS.B = { tab: 'storage' }`; no RB, which from a fresh Storage would wrap to
 * Party), the cursor on the boxed monster; Enter (A) opens its sheet on Summary; ArrowDown ×5 walks
 * Summary, Care, Feed…, Evolve…, Nickname to Move; Enter (A) on Move sends `setPartySlot` with -1,
 * which main.ts resolves. Both oracles are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAppShellFromRealIndexHtml,
  telemetryMock,
  wasmPkgStubMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
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
vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgStubMock());

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

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

vi.mock('./render/world', () => worldRendererMock());

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
    lastCareAtMs: 0n,
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

/** A keydown and its keyup at the world (the canvas focused), as a player's tap: the keyboard
 *  source reads a second non-repeat keydown of a code it holds as a lost keyup. */
function tap(code: string): void {
  document.querySelector('canvas')?.focus();
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

/** Open the Monsters frame on Storage with a real KeyB tap, open the boxed monster's sheet (Enter)
 *  and walk it to Move (ArrowDown ×5). Pressing Enter then is the move. */
function openStorageSheetOnMove(boxedNickname: string): void {
  tap('KeyB');
  tap('Enter'); // A on the boxed monster (the frame opens on Storage, its first card)
  expect(
    document.getElementById('monsters-sheet-name')?.textContent,
    `precondition: the sheet is the boxed monster's (${boxedNickname})`,
  ).toBe(boxedNickname);
  for (let i = 0; i < 5; i += 1) tap('ArrowDown'); // Care, Feed…, Evolve…, Nickname, Move
  expect(
    document.getElementById('monstersSheet-root-move')?.getAttribute('aria-selected'),
    'precondition: the sheet cursor is on Move',
  ).toBe('true');
}

function statusText(): string {
  return document.getElementById('status')?.textContent ?? '';
}

describe('main.ts Monsters sheet Move from Storage (BUG-party-full-to-party-silent-noop)', () => {
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
    openStorageSheetOnMove('m3');
    expect(H.setPartySlot, 'precondition: nothing sent before the Move').not.toHaveBeenCalled();
    tap('Enter'); // A on Move
    expect(H.setPartySlot).toHaveBeenCalledTimes(1);
    expect(H.setPartySlot).toHaveBeenCalledWith({ monsterId: 3n, slot: 2 });
  });

  it('with a FULL party, sends nothing and tells the player the party is full', () => {
    deliverMonsters([monster(1n, 0), monster(2n, 1), monster(3n, 2), monster(4n, 255)]);
    openStorageSheetOnMove('m4');
    tap('Enter'); // A on Move
    expect(
      H.setPartySlot,
      'a full party must not send the move-to-box fallback slot — the server accepts it as a ' +
        'no-op and the player sees nothing happen',
    ).not.toHaveBeenCalled();
    expect(statusText()).toBe(t('chrome.status.partyFull'));
  });
});
