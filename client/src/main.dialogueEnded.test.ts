// @vitest-environment happy-dom
/**
 * main.dialogueEnded.test.ts: the booted refused-advance and quest-completion paths through main.ts
 * (qf-6: QF6.1, QF6.2, QF6.4).
 *
 * QF6.1 / QF6.2: `advance_dialogue` refuses, and writes nothing, when the parties are too far apart,
 * in different zones, or the NPC is gone. The client maps exactly those four SenderError messages to
 * catalogued copy on the status line and ends the conversation with `dismiss_dialogue`; the server's
 * delete then closes the overlay (the client never hides a conversation itself). Every other
 * rejection keeps today's `advance: …` report and sends no dismiss.
 *
 * QF6.4: `talk` is the only path that completes a quest, and it always upserts the conversation row
 * in the same transaction. So a batch in which one of my player_quest rows leaves while my
 * conversation row is present is a completion: the status line names the quest and the wallet's gain.
 *
 * Both notices go to the live region too, and must survive its 500 ms coalescer: the overlay's open
 * or close label lands around the same moment, and only the newest message inside a window is
 * spoken (A11Y-9). The live region is observed through every value written to #a11y-live.
 *
 * Harness: main.dialogueDismiss.test.ts's, copied (vi.resetModules + a fresh import per test,
 * recorded window/document listeners detached in afterEach, one controllable clock, a stubbed wasm
 * pkg and SDK connection whose reducers are a recording Proxy, the real client/index.html shell
 * mounted before main.ts imports), plus: a pumped rAF (mainBootHarness `stubRaf` / `frame`) so the
 * frame loop's live-region pump runs; an `advanceDialogue` that rejects with a configurable value
 * or stays unsettled; and rows seeded through the REAL AuthoritativeStore, one `flushBatch` per
 * server transaction burst (the main.feedbackI18n / main.partyFull idiom).
 *
 * Every English line below is typed here, never read off the catalog under test.
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
import type { AuthoritativeStore, StoreCharacter, StorePlayerConversation } from './net/store';
import { a11yCopy } from './ui/a11yCopy';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** What the connection stub's `live()` answers: the handle, or `undefined` when false. */
  linkLive: true,
  /** What the connection stub's `linkFrozen()` answers. */
  frozen: false,
  /** The name of every reducer called, oldest first. */
  calls: [] as string[],
  /** The argument of every `advanceDialogue` call, oldest first. */
  advanceArgs: [] as unknown[],
  /** When not null, `advanceDialogue` rejects with exactly this value. */
  advanceRejection: null as unknown,
  /** When true, `advanceDialogue` returns a promise the test settles by hand. */
  manualAdvance: false,
  /** The controls of every unsettled `advanceDialogue` promise, oldest first. */
  advancePromises: [] as Array<{ resolve: () => void; reject: (err: unknown) => void }>,
  /** When true, `dismissDialogue` returns a promise the test settles by hand. */
  manualDismiss: false,
  /** The controls of every unsettled `dismissDialogue` promise, oldest first. */
  dismissPromises: [] as Array<{ resolve: () => void; reject: (err: unknown) => void }>,
}));

// wasm pkg: every name main.ts imports. apply_move is a real one-tile step on an open grid.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgWalkingMock());

// The connection: capture the options; `live()` and `linkFrozen()` answer from the hoisted
// controls; every reducer resolves immediately except a configured `advanceDialogue` and a manual
// `dismissDialogue`.
vi.mock('./net/connection', () => {
  const reducers = new Proxy(
    {},
    {
      get:
        (_t, name) =>
        (args?: unknown): Promise<void> => {
          H.calls.push(String(name));
          if (name === 'advanceDialogue') {
            H.advanceArgs.push(args);
            if (H.manualAdvance) {
              return new Promise<void>((resolve, reject) => {
                H.advancePromises.push({ resolve, reject });
              });
            }
            if (H.advanceRejection !== null) return Promise.reject(H.advanceRejection);
          }
          if (name === 'dismissDialogue' && H.manualDismiss) {
            return new Promise<void>((resolve, reject) => {
              H.dismissPromises.push({ resolve, reject });
            });
          }
          return Promise.resolve();
        },
    },
  );
  const live = { reducers };
  const stub = {
    conn: undefined,
    live: () => (H.linkLive ? live : undefined),
    identity: () => H.identity,
    linkFrozen: () => H.frozen,
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
const ENDED_WALKED_AWAY = 'Conversation ended: you moved too far away.';
const ENDED_LEFT_ZONE = 'Conversation ended: you left the area.';
const ENDED_NPC_GONE = 'Conversation ended: they are no longer here.';
const QUEST_001_ACK = 'Quest complete: quest_001. You received 50 gold.';
/** The server's single deletion-gate refusal (server-module guards.rs REJECT_DELETION_GATED). */
const DELETION_GATED =
  'account deletion requested; new trades, battles and challenges are unavailable';

/** An existing a11y label (M23 copy, not this slice's): what the live region says on an edge. */
function a11yLabel(key: string): string {
  const value = a11yCopy[key];
  if (value === undefined) throw new Error(`a11yCopy has no ${key}`);
  return value;
}
/** Spoken when the dialogue comes to the top. */
const DIALOGUE_LABEL = a11yLabel('a11y.overlay.dialogueView.title');
/** Spoken when the last overlay closes and the world has focus again. */
const WORLD_LABEL = a11yLabel('a11y.world.region');

/** A reducer rejection as the SDK hands it over: an Error whose `name` is its class. */
const senderError = (message: string): Error =>
  Object.assign(new Error(message), { name: 'SenderError' });
const internalError = (message: string): Error =>
  Object.assign(new Error(message), { name: 'InternalError' });

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

/** Wrap the live-region node's own `textContent` setter so every write is recorded. The node is
 *  moved (never replaced) between <body> and an open overlay, so the wrapper travels with it. */
function recordLiveWrites(): void {
  const node = document.getElementById('a11y-live');
  if (node === null) throw new Error('the shell must ship #a11y-live');
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
      liveWrites.push(String(value));
      set.call(this, value);
    },
  });
}

let opts: ConnectionOptions;
let consoleError: MockInstance<typeof console.error> | undefined;

async function bootReady(): Promise<void> {
  H.connectOpts = null;
  H.linkLive = true;
  H.frozen = false;
  H.calls = [];
  H.advanceArgs = [];
  H.advanceRejection = null;
  H.manualAdvance = false;
  H.advancePromises = [];
  H.manualDismiss = false;
  H.dismissPromises = [];
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  consoleError = vi.spyOn(console, 'error');
  recorded = [];
  mountIndexHtmlShell();
  liveWrites = [];
  recordLiveWrites();
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
const ELDER = 11n;
/** A second elder_oak_talk NPC, for a conversation that moved on. */
const OTHER_NPC = 12n;
const OTHER = 'cd'.repeat(32);

function character(entityId: bigint, tileX: number, tileY: number): StoreCharacter {
  return {
    entityId,
    zoneId: 0,
    tileX,
    tileY,
    facing: 'East',
    action: 'Idle',
    moveStartedAtMs: 0n,
    moveQueue: [] as WasmMoveInput[],
  };
}

/** Write whatever `rows` writes into the REAL store and deliver it as ONE batch at clock `t`. */
function batch(t: number, rows: (store: AuthoritativeStore) => void): void {
  clock.t = t;
  rows(opts.store);
  opts.store.flushBatch();
}

/** My player row and my character at (`tileX`, `tileY`). */
function ownRows(store: AuthoritativeStore, t: number, tileX = 2, tileY = 6): void {
  store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    lastInputSeq: 0n,
  });
  store.upsertCharacter(character(EID, tileX, tileY), t);
}

/** An NPC with the shipped `elder_oak_talk` tree, standing at (`tileX`, 6). */
function elderRows(store: AuthoritativeStore, t: number, entityId = ELDER, tileX = 3): void {
  store.upsertNpc({
    entityId,
    npcId: entityId === ELDER ? 'elder_oak' : `elder_oak_${entityId}`,
    zoneId: 0,
    homeX: tileX,
    homeY: 6,
    wanderRadius: 0,
    dialogueTreeId: 'elder_oak_talk',
    interaction: { kind: 'dialogue' },
  });
  store.upsertCharacter(character(entityId, tileX, 6), t);
}

/** My conversation row at the tree's `greeting` node (whose choice 0 is "I seek a quest."). */
const conversationWith = (npcEntityId: bigint = ELDER): StorePlayerConversation => ({
  ownerIdentity: H.identity,
  npcEntityId,
  currentNodeId: 'greeting',
});

/** Pump the frame loop every `stepMs` from `from` to `to`, inclusive. */
function frames(from: number, to: number, stepMs = 50): void {
  for (let t = from; t <= to; t += stepMs) frame(t);
}

/** Me beside the elder plus my conversation with him, in one batch at `t`; then frames until the
 *  dialogue's open label has been spoken. */
function openConversation(t: number): void {
  batch(t, (s) => {
    ownRows(s, t);
    elderRows(s, t);
    s.upsertConversation(conversationWith());
  });
  frames(t + 50, t + 750);
}

/** The server deletes my conversation row, in one batch at `t`. */
function endConversation(t: number): void {
  batch(t, (s) => s.removeConversation(H.identity));
}

/** Click the dialogue's choice 0 at clock `t` (the pointer source dispatches `advanceDialogue`). */
function clickChoice(t: number): void {
  const button = document.querySelector<HTMLElement>(
    '#dialogue-overlay button[data-choice-idx="0"]',
  );
  if (button === null) throw new Error('the dialogue must render choice 0 ("I seek a quest.")');
  clock.t = t;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** Click a greet-then-shop button inside the dialogue overlay, as the dialogue renders one. */
function clickShop(t: number, shopId = '1'): void {
  const button = document.createElement('button');
  button.dataset.shopId = shopId;
  const host = document.getElementById('dialogue-overlay');
  if (host === null) throw new Error('the shell must ship #dialogue-overlay');
  host.appendChild(button);
  clock.t = t;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  button.remove();
}

const dismissCalls = (): number => H.calls.filter((name) => name === 'dismissDialogue').length;
const advanceCalls = (): number => H.calls.filter((name) => name === 'advanceDialogue').length;
const dialogueShown = (): boolean => {
  const el = document.getElementById('dialogue-overlay');
  if (el === null) throw new Error('#dialogue-overlay is not in the shell');
  return el.style.display !== 'none' && el.style.display !== '';
};
const shopShown = (): boolean => {
  const el = document.getElementById('shop-overlay');
  if (el === null) throw new Error('#shop-overlay is not in the shell');
  return el.style.display !== 'none';
};
const statusText = (): string => document.getElementById('status')?.textContent ?? '';
/** What reached main.ts's error report (`console.error('[status]', text)`), oldest first. */
const statusReports = (): string[] =>
  (consoleError?.mock.calls ?? []).filter((c) => c[0] === '[status]').map((c) => String(c[1]));
/** Let queued microtasks and zero-delay timers run (a rejection handler, a deferred focus). */
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('main.ts refused advance and quest completion (runtime, qf-6)', {
  sequential: true,
}, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    H.linkLive = true;
    H.frozen = false;
    H.advanceRejection = null;
    H.manualAdvance = false;
    H.manualDismiss = false;
    consoleError = undefined;
    document.body.replaceChildren();
  });

  // ------------------------------------------------------------------------------------------
  // QF6.1 + QF6.2: the refusals that end a conversation
  // ------------------------------------------------------------------------------------------

  it('a walked-away refusal shows the catalogued ended line, sends one dismiss, leaves the overlay to the server, and the live region says the line last QF6.1 QF6.2', async () => {
    // WRONG IMPL KILLED: today's report ("advance: walked too far away" on the status line and in
    // the error report); a mapped line with no dismiss (the overlay wedges open: QF6.1); a second
    // dismiss; a client-side hide on the rejection (the overlay is the server's to close); and a
    // notice spoken at once or after a fixed hold (the coalescer then keeps only the close's world
    // label, or drops the world label, and the ended line is never the last thing said).
    await bootReady();
    openConversation(1000);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);
    expect(liveWrites, 'precondition: the dialogue label was spoken').toContain(DIALOGUE_LABEL);
    H.advanceRejection = senderError('walked too far away');

    clickChoice(2000);
    await settle();
    expect(advanceCalls(), 'the click sent one advance').toBe(1);
    expect(H.advanceArgs, 'for choice 0').toEqual([{ choiceIdx: 0 }]);
    expect(statusText(), 'the catalogued ended line').toBe(ENDED_WALKED_AWAY);
    expect(statusText(), 'never the reducer prefix').not.toContain('advance:');
    expect(statusText(), 'never the raw reason').not.toContain('walked too far away');
    expect(statusReports(), 'an ended conversation is not an error report').toEqual([]);
    expect(dismissCalls(), 'the client ends the conversation: exactly one dismiss').toBe(1);
    expect(dialogueShown(), 'the client never hides the dialogue itself').toBe(true);

    frames(2050, 2100);
    expect(dialogueShown(), 'still open until the server ends it').toBe(true);
    expect(dismissCalls(), 'and no second dismiss').toBe(1);

    endConversation(2150);
    expect(dialogueShown(), "the server's no-conversation batch closes it").toBe(false);
    frames(2200, 4000);
    expect(liveWrites, 'the close spoke the world label').toContain(WORLD_LABEL);
    expect(liveWrites.at(-1), 'the ended line is the last thing the live region said').toBe(
      ENDED_WALKED_AWAY,
    );
    expect(
      liveWrites.lastIndexOf(WORLD_LABEL),
      'the world label first, then the ended line',
    ).toBeLessThan(liveWrites.lastIndexOf(ENDED_WALKED_AWAY));
    expect(dismissCalls(), 'still exactly one dismiss').toBe(1);
  });

  it.each<[string, string]>([
    ['no longer in same zone', ENDED_LEFT_ZONE],
    ['npc not found', ENDED_NPC_GONE],
    ['npc character not found', ENDED_NPC_GONE],
  ])('the "%s" refusal shows its own ended line and sends one dismiss QF6.1 QF6.2', async (message, line) => {
    // WRONG IMPL KILLED: one reason's line for every refusal (the player is told the wrong cause), a
    // refusal left on today's raw report, the npc-gone refusals left wedged (no dismiss), and a
    // client-side hide.
    await bootReady();
    openConversation(1000);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);
    H.advanceRejection = senderError(message);

    clickChoice(2000);
    await settle();
    expect(statusText(), 'its own catalogued ended line').toBe(line);
    expect(statusText(), 'never the reducer prefix').not.toContain('advance:');
    expect(statusText(), 'never the raw reason').not.toContain(message);
    expect(statusReports(), 'an ended conversation is not an error report').toEqual([]);
    expect(dismissCalls(), 'exactly one dismiss').toBe(1);
    expect(dialogueShown(), 'the client never hides the dialogue itself').toBe(true);

    endConversation(2100);
    expect(dialogueShown(), "the server's no-conversation batch closes it").toBe(false);
    expect(dismissCalls(), 'still exactly one dismiss').toBe(1);
  });

  it.each<[string, unknown, string]>([
    [
      'the battle refusal',
      senderError('cannot advance dialogue during an ongoing battle'),
      'advance: cannot advance dialogue during an ongoing battle',
    ],
    ['the deletion-gate refusal', senderError(DELETION_GATED), `advance: ${DELETION_GATED}`],
    [
      'no active conversation',
      senderError('no active conversation'),
      'advance: no active conversation',
    ],
    ['not joined', senderError('not joined'), 'advance: not joined'],
    ['character not found', senderError('character not found'), 'advance: character not found'],
    [
      'dialogue tree not found',
      senderError('dialogue tree not found'),
      'advance: dialogue tree not found',
    ],
    ['node not found', senderError('node not found'), 'advance: node not found'],
    [
      'an InternalError carrying the walked-away text',
      internalError('walked too far away'),
      'advance: server error',
    ],
    [
      'a plain Error carrying the walked-away text',
      new Error('walked too far away'),
      'advance: unexpected error',
    ],
  ])('%s keeps the advance report and sends no dismiss QF6.1', async (_label, rejection, report) => {
    // WRONG IMPL KILLED: a dismiss on every advance rejection (a battle-suspended dialogue, a
    // deletion-gated account or a bad choice would lose the conversation the server kept), a
    // mapping that reads the message without the class (the InternalError and plain-Error rows),
    // and a swallowed report (the player is told nothing).
    await bootReady();
    openConversation(1000);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);
    H.advanceRejection = rejection;

    clickChoice(2000);
    await settle();
    expect(advanceCalls(), 'the click sent one advance').toBe(1);
    expect(statusText(), "today's report").toBe(report);
    expect(statusReports(), 'reported as an error, once').toEqual([report]);
    expect(dismissCalls(), 'no dismiss').toBe(0);

    frames(2050, 3000);
    batch(3050, (s) => ownRows(s, 3050));
    expect(dismissCalls(), 'no dismiss later either').toBe(0);
    expect(dialogueShown(), 'the conversation the server kept stays on screen').toBe(true);
  });

  it('a walked-away refusal that lands after my conversation row is gone shows nothing and sends no dismiss QF6.1', async () => {
    // WRONG IMPL KILLED: a mapping that reads only the error. The conversation is already over
    // (another tab dismissed it, or a talk replaced it): an ended line now is stale, and a dismiss
    // could end a conversation the player starts next.
    await bootReady();
    openConversation(1000);
    H.manualAdvance = true;
    clickChoice(2000);
    expect(H.advancePromises, 'precondition: the advance is in flight').toHaveLength(1);
    endConversation(2100);
    expect(dialogueShown(), 'precondition: the row is gone').toBe(false);

    H.advancePromises[0]?.reject(senderError('walked too far away'));
    await settle();
    expect(statusText(), 'nothing on the status line').toBe('');
    expect(statusReports(), 'and nothing reported').toEqual([]);
    expect(dismissCalls(), 'no dismiss').toBe(0);
  });

  it('a walked-away refusal that lands after my conversation moved to another NPC shows nothing and sends no dismiss QF6.1', async () => {
    // WRONG IMPL KILLED: a mapping that checks only that SOME conversation is open: the refusal
    // was for the old one, so its line and its dismiss would end the conversation just started.
    await bootReady();
    openConversation(1000);
    H.manualAdvance = true;
    clickChoice(2000);
    expect(H.advancePromises, 'precondition: the advance is in flight').toHaveLength(1);
    batch(2100, (s) => {
      elderRows(s, 2100, OTHER_NPC, 2);
      s.upsertConversation(conversationWith(OTHER_NPC));
    });
    expect(dialogueShown(), 'precondition: the new conversation is on screen').toBe(true);

    H.advancePromises[0]?.reject(senderError('walked too far away'));
    await settle();
    expect(statusText(), 'nothing on the status line').toBe('');
    expect(statusReports(), 'and nothing reported').toEqual([]);
    expect(dismissCalls(), 'no dismiss').toBe(0);
    expect(dialogueShown(), 'the new conversation stays').toBe(true);
  });

  it('a walked-away refusal that lands after my conversation with the same NPC moved to another node shows nothing and sends no dismiss QF6.1', async () => {
    // WRONG IMPL KILLED: a staleness guard that compares only the NPC. The refusal was for the
    // node the reply was chosen on; the conversation has since moved on (another tab advanced it),
    // so the line and the dismiss would end a conversation the refusal says nothing about.
    await bootReady();
    openConversation(1000);
    H.manualAdvance = true;
    clickChoice(2000);
    expect(H.advancePromises, 'precondition: the advance is in flight').toHaveLength(1);
    // An unknown node: the overlay may show its fallback or hide; only what the refusal does counts.
    batch(2100, (s) => s.upsertConversation({ ...conversationWith(), currentNodeId: 'farewell' }));

    H.advancePromises[0]?.reject(senderError('walked too far away'));
    await settle();
    expect(statusText(), 'nothing on the status line').toBe('');
    expect(statusReports(), 'and nothing reported').toEqual([]);
    expect(dismissCalls(), 'no dismiss').toBe(0);
  });

  it('walking out of talk range ends nothing by itself: no dismiss, the overlay stays QF6.1', async () => {
    // WRONG IMPL KILLED: a client-side range check that ends or hides the conversation when the
    // player walks away. The ending belongs to the server's refusal of a chosen reply.
    await bootReady();
    openConversation(1000);
    batch(2000, (s) => ownRows(s, 2000, 6, 6)); // Manhattan 3 from the elder at (3, 6)
    frames(2050, 3000);
    batch(3050, (s) => ownRows(s, 3050, 7, 7)); // Manhattan 5
    frames(3100, 4000);
    expect(dismissCalls(), 'no dismiss').toBe(0);
    expect(advanceCalls(), 'no advance').toBe(0);
    expect(dialogueShown(), 'the overlay stays').toBe(true);
    expect(statusText(), 'nothing on the status line').toBe('');
  });

  it("a walked-away refusal while a Shop pick's dismiss is in flight shows the ended line, sends no second dismiss and keeps the picked shop QF6.1", async () => {
    // WRONG IMPL KILLED: an unconditional `dismissDialogue` dispatch. Its `dismissRequested` means
    // "end it, no shop" (last intent wins), so the shop the player picked would never open; and a
    // second dismiss on top of the one already ending the conversation.
    await bootReady();
    openConversation(1000);
    H.manualDismiss = true;
    clickShop(1900);
    expect(dismissCalls(), "precondition: the Shop pick's dismiss is in flight").toBe(1);
    H.advanceRejection = senderError('walked too far away');

    clickChoice(2000);
    await settle();
    expect(statusText(), 'the ended line still shows').toBe(ENDED_WALKED_AWAY);
    expect(dismissCalls(), 'the dismiss in flight ends it: no second one').toBe(1);

    H.dismissPromises[0]?.resolve();
    await settle();
    endConversation(2200);
    expect(dialogueShown(), "the server's no-conversation batch closes it").toBe(false);
    expect(shopShown(), 'the shop the player picked still opens').toBe(true);
  });

  // ------------------------------------------------------------------------------------------
  // QF6.4: the quest-completion acknowledgement
  // ------------------------------------------------------------------------------------------

  /** One server transaction before the completing talk: me, the elder, my wallet of `balance`, my
   *  quest_001 row (pqId 1, step 0) and, when `conversation`, my conversation row. */
  function beforeCompletion(t: number, balance: bigint, conversation = false): void {
    batch(t, (s) => {
      ownRows(s, t);
      elderRows(s, t);
      s.upsertWallet({ ownerIdentity: H.identity, balance });
      s.upsertQuest({ pqId: 1n, ownerIdentity: H.identity, questId: 'quest_001', stepIndex: 0 });
      if (conversation) s.upsertConversation(conversationWith());
    });
  }

  /** The completing talk as one transaction: quest row `pqId` leaves, my wallet becomes `balance`
   *  and my conversation row is upserted. */
  function completingTalk(t: number, balance: bigint, pqId = 1n): void {
    batch(t, (s) => {
      s.removeQuest(pqId);
      s.upsertWallet({ ownerIdentity: H.identity, balance });
      s.upsertConversation(conversationWith());
    });
  }

  it('a completing talk acknowledges the quest and its gold on the status line, and the live region says it after the dialogue label QF6.4', async () => {
    // WRONG IMPL KILLED: the silent row delete (no acknowledgement: the reward went unseen); an
    // acknowledgement without the amount, or with the new balance (80) instead of the gain (50);
    // one already fired by the baseline batch; one routed through the error report; and one spoken
    // at once (the dialogue's open label, one frame later, replaces it in the coalescer).
    await bootReady();
    opts.onHydrated();
    beforeCompletion(1000, 30n);
    expect(statusText(), 'the baseline acknowledges nothing').toBe('');

    completingTalk(2000, 80n);
    expect(statusText(), 'the quest and the gold it paid').toBe(QUEST_001_ACK);
    expect(statusReports(), 'an acknowledgement is not an error report').toEqual([]);
    frames(2050, 4000);
    expect(liveWrites, 'the dialogue label was spoken').toContain(DIALOGUE_LABEL);
    expect(liveWrites.at(-1), 'the acknowledgement is the last thing the live region said').toBe(
      QUEST_001_ACK,
    );
    expect(
      liveWrites.indexOf(DIALOGUE_LABEL),
      'the dialogue label first, then the acknowledgement',
    ).toBeLessThan(liveWrites.indexOf(QUEST_001_ACK));
  });

  it('a completing talk that moved no gold acknowledges the quest without a reward QF6.4', async () => {
    // WRONG IMPL KILLED: main.ts always using the reward line ("You received null gold" or "0
    // gold"), or dropping the acknowledgement when there is no gain.
    await bootReady();
    opts.onHydrated();
    beforeCompletion(1000, 30n);
    completingTalk(2000, 30n);
    expect(statusText(), 'the quest, and no gold').toBe('Quest complete: quest_001.');
    expect(statusReports(), 'an acknowledgement is not an error report').toEqual([]);
  });

  it.each<[string, () => void]>([
    [
      'a batch before the snapshot is hydrated',
      () => {
        beforeCompletion(1000, 30n);
        completingTalk(2000, 80n);
      },
    ],
    [
      'a step advance (the same row at a new step)',
      () => {
        opts.onHydrated();
        beforeCompletion(1000, 30n);
        batch(2000, (s) => {
          s.upsertQuest({
            pqId: 1n,
            ownerIdentity: H.identity,
            questId: 'quest_001',
            stepIndex: 1,
          });
          s.upsertWallet({ ownerIdentity: H.identity, balance: 80n });
          s.upsertConversation(conversationWith());
        });
      },
    ],
    [
      'a wallet-only gain while a conversation opens',
      () => {
        opts.onHydrated();
        beforeCompletion(1000, 30n);
        batch(2000, (s) => {
          s.upsertWallet({ ownerIdentity: H.identity, balance: 80n });
          s.upsertConversation(conversationWith());
        });
      },
    ],
    [
      'the deletion cascade (my quest and my conversation leave together)',
      () => {
        opts.onHydrated();
        beforeCompletion(1000, 30n, true);
        batch(2000, (s) => {
          s.removeQuest(1n);
          s.removeConversation(H.identity);
        });
      },
    ],
    [
      "another player's quest_001 leaving while my wallet gains 50",
      () => {
        opts.onHydrated();
        batch(1000, (s) => {
          ownRows(s, 1000);
          elderRows(s, 1000);
          s.upsertWallet({ ownerIdentity: H.identity, balance: 30n });
          s.upsertQuest({ pqId: 2n, ownerIdentity: OTHER, questId: 'quest_001', stepIndex: 0 });
        });
        completingTalk(2000, 80n, 2n);
      },
    ],
    [
      'a reconnect whose fresh snapshot simply lacks the quest',
      () => {
        opts.onHydrated();
        beforeCompletion(1000, 30n);
        // The link drops (connection.ts resets the store on the drop edge) and comes back; the
        // first flush after the new snapshot is the hydrated one.
        opts.store.reset();
        opts.onReconnect(H.identity);
        opts.onHydrated();
        batch(2000, (s) => {
          ownRows(s, 2000);
          elderRows(s, 2000);
          s.upsertWallet({ ownerIdentity: H.identity, balance: 80n });
          s.upsertConversation(conversationWith());
        });
      },
    ],
  ])('no quest acknowledgement for %s QF6.4', async (_label, run) => {
    // WRONG IMPL KILLED, row by row: an acknowledgement before hydration (a half-applied store);
    // one keyed on the step instead of the row (a step advance keeps its pqId, and its questId
    // too, so it cannot tell pqId keying from questId keying: statusModel.test.ts's re-keyed-row
    // test does); one on any balance gain (a trade payout, a sale); one that ignores the conversation row
    // (account deletion erases both rows in one transaction); one over every player's quest rows
    // (player_quest is a public table); and a baseline kept across a reconnect (the fresh snapshot
    // would read as a completion of the quest the old one held).
    await bootReady();
    run();
    expect(statusText(), 'nothing on the status line').toBe('');
    frames(2050, 3500);
    expect(
      liveWrites.filter((w) => w.startsWith('Quest complete')),
      'nothing about a quest is spoken',
    ).toEqual([]);
  });
});
