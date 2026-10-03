// @vitest-environment happy-dom
/**
 * tradeProposeScreen.boot.test.ts: the trade-propose wizard (ctl-8e) booted through main.ts over
 * the REAL client/index.html shell, the REAL TradeProposeView and the REAL screen-adapter table
 * (`SCREEN_ADAPTERS.tradeProposeView` is whatever ui/screens/index.ts ships: no stand-in is swapped
 * in).
 *
 * - CTL8E-2-BOOT-O-OPENS: the legacy O opens the overlay on the Target step with the five-step header
 *   painted and focus on the select after the overlay helper's deferred focus; A on the select is
 *   heard by the converted adapter (the legacy adapter ignores it); Start closes it and a reopen
 *   starts over on Target.
 * - CTL8E-1-BOOT-WIZARD: with another player and two own monsters in the store, the whole wizard by
 *   keys: pick the target (set natively on the select), A to Offer, Down + A ticks the SECOND monster,
 *   RB to Coins (focus in the offer field), type 25, A to Ask, type 7, A to Review (Yes marked,
 *   prompt, summary of the parsed draft), A on Yes sends exactly ONE proposeTrade with that
 *   counterparty, [that monster], 25n and 7n; the next A (the cursor is on No) steps back and sends
 *   nothing; B steps back from Review; LB on Offer goes back to Target.
 * - CTL8E-1-BOOT-ESCAPE (B5): Escape on the select after the defer closes the overlay (it used to be
 *   dead), and Escape in the offer field keeps the typed text, keeps the overlay open and does not
 *   advance the step; the next Escape closes it.
 *
 * EVERY key is dispatched ON `document.activeElement`, bubbling, like a real browser: the router
 * ignores keys a focused SELECT / INPUT owns (input/router.ts `ownership`), and the views' own
 * keydown shields run before the window listeners. A key dispatched straight at the window would
 * skip both and pass vacuously. The deferred initial focus (one macrotask after KeyO, from
 * ui/overlayA11y.ts) is flushed before the first key.
 *
 * Harness: socialScreen.boot.test.ts's (the real shell mounted, main.ts imported fresh per boot, only
 * the wasm pkg, the connection, telemetry and the world renderer stubbed) with a recording connection:
 * every reducer but enqueueMove records its name and its argument object in `H.calls` and resolves at
 * once. No frame is run: a press reaches the adapter, and the adapter's paint reaches the view, on the
 * keydown.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from '../../convert/convert';
import type { Connection, ConnectionOptions } from '../../net/connection';
import type { StoreMonsterPub } from '../../net/store';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every reducer call but enqueueMove, oldest first, with the exact argument object. */
  calls: [] as Array<{ name: string; args: unknown }>,
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
// swallows every key.
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
      return stub;
    },
  };
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
let opts: ConnectionOptions;
/** The i18n resolver instance main.ts runs on (imported AFTER the module reset, so it is shared). */
let i18n: typeof import('../i18n/resolver');

/** Boot a fresh main.ts over the real shell and wait for it to connect. No frame ever runs: the
 *  rAF stub never calls back. */
async function bootReady(): Promise<void> {
  H.connectOpts = null;
  H.calls = [];
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  vi.stubGlobal('requestAnimationFrame', (): number => 0);
  vi.resetModules();
  await import('../../main');
  i18n = await import('../i18n/resolver');
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
  H.calls = [];
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
}

/** Let queued microtasks and zero-delay timers run (a settled reducer, the deferred focus). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const EID = 7n;
/** The one other player: the only counterparty the wizard can pick. */
const OTHER = 'cd'.repeat(32);
const OTHER_NAME = 'Zed';

/** Deliver one authoritative batch at clock `at`: the own player + character at (2, 6), plus
 *  whatever the case put in the store since the last batch. */
function server(at: number): void {
  clock.t = at;
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
    at,
  );
  opts.store.flushBatch();
}

/** An own monster in the box (slot 255), so it is offerable. */
function ownMonster(monsterId: bigint, nickname: string): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: H.identity,
    speciesId: 1,
    nickname,
    level: 5,
    xp: 0,
    currentHp: 20,
    statHp: 20,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
    partySlot: 255,
    tier: 0,
    essence: {} as StoreMonsterPub['essence'],
    trustTier: 'Unknown' as StoreMonsterPub['trustTier'],
    qualityTimeTier: 0,
    nutritionPct: 0,
  };
}

const FIRST_MONSTER = 31n;
const SECOND_MONSTER = 32n;

/** Another player and two own monsters, delivered in one batch. */
function seedStore(): void {
  opts.store.upsertPlayer({
    identity: OTHER,
    entityId: 99n,
    name: OTHER_NAME,
    online: true,
    lastInputSeq: 0n,
  });
  opts.store.upsertMonster(ownMonster(FIRST_MONSTER, 'Kip'));
  opts.store.upsertMonster(ownMonster(SECOND_MONSTER, 'Sprig'));
  server(1000);
}

/** A keydown at `at` on the ELEMENT THAT HAS FOCUS (the body when nothing does) and its keyup 5 ms
 *  later on whatever has focus then: the keydown may move focus (the wizard follows its step). Both
 *  bubble to the window listeners, as in a browser. */
function press(code: string, at: number): void {
  clock.t = at;
  const down = (document.activeElement ?? document.body) as HTMLElement;
  down.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  clock.t = at + 5;
  const up = (document.activeElement ?? document.body) as HTMLElement;
  up.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

/** Put `text` into a field the way a user does: set the value, then fire its input event. */
function typeInto(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} must be in the document`);
  return found;
}
function testEl(testId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`[data-testid="${testId}"] must be in the document`);
  return found;
}

const selectEl = (): HTMLSelectElement => el('tradepropose-target') as HTMLSelectElement;
const monstersEl = (): HTMLElement => el('tradepropose-monsters');
const offerEl = (): HTMLInputElement => el('tradepropose-offer-currency') as HTMLInputElement;
const requestEl = (): HTMLInputElement => el('tradepropose-request-currency') as HTMLInputElement;
const reviewRow = (): HTMLElement => testEl('tradepropose-review');
/** The review row is on screen: it exists and its inline display is not none. */
const reviewShown = (): boolean => {
  const row = document.querySelector<HTMLElement>('[data-testid="tradepropose-review"]');
  return row !== null && row.style.display !== 'none';
};

/** The overlay is on screen (its inline display is not none). */
const proposeShown = (): boolean => el('tradepropose-overlay').style.display !== 'none';

/** The whole context stack through the read-only `__game()` DEV hook, as base-first frame names. */
const stackNames = (): string[] =>
  (
    window as unknown as {
      __game: () => { stack: Array<{ kind: string; id?: string }> };
    }
  )
    .__game()
    .stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));

const STEPS = ['target', 'offer', 'coins', 'ask', 'review'] as const;
type Step = (typeof STEPS)[number];

/** The step header's items in order, and which carry aria-current (with its value). */
function header(): { steps: (string | null)[]; texts: (string | null)[]; current: string[] } {
  const items = Array.from(testEl('tradepropose-steps').querySelectorAll('li'));
  return {
    steps: items.map((li) => li.getAttribute('data-step')),
    texts: items.map((li) => li.textContent),
    current: items
      .filter((li) => li.getAttribute('aria-current') !== null)
      .map((li) => `${li.getAttribute('data-step')}=${li.getAttribute('aria-current')}`),
  };
}
const currentStep = (): string[] => header().current;

function stepText(step: Step): string {
  switch (step) {
    case 'target':
      return i18n.t('tradePropose.step.target');
    case 'offer':
      return i18n.t('tradePropose.step.offer');
    case 'coins':
      return i18n.t('tradePropose.step.coins');
    case 'ask':
      return i18n.t('tradePropose.step.ask');
    case 'review':
      return i18n.t('tradePropose.step.review');
  }
}

/** The monster whose label carries the cursor mark (aria-current="true"). */
const cursorMonsters = (): (string | null | undefined)[] =>
  Array.from(monstersEl().querySelectorAll('label'))
    .filter((l) => l.getAttribute('aria-current') === 'true')
    .map((l) => l.querySelector('input')?.getAttribute('data-monster-id'));
const checkedMonsters = (): (string | null)[] =>
  Array.from(monstersEl().querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(
    (b) => b.getAttribute('data-monster-id'),
  );
const proposeCalls = (): Array<{ name: string; args: unknown }> =>
  H.calls.filter((c) => c.name === 'proposeTrade');

/** The hex of an SDK Identity (or the string itself). */
function hexOf(identity: unknown): string {
  const withHex = identity as { toHexString?: () => string };
  return typeof withHex.toHexString === 'function' ? withHex.toHexString() : String(identity);
}

/** Pick the counterparty the way a user does: set the select natively, then fire its change. */
function pickTarget(identity: string): void {
  const select = selectEl();
  select.value = identity;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('the trade-propose wizard booted through main.ts over the real view and adapter table (ctl-8e)', {
  sequential: true,
}, () => {
  afterEach(teardownBoot);

  it('CTL8E-2-BOOT-O-OPENS: the legacy O opens the overlay on Target with the five-step header painted (Target current) and focus on the select after the deferred focus; A on the select is heard by the converted adapter and moves to Offer with focus on the monsters; Escape (Start) closes it and a reopen starts over on Target', async () => {
    // WRONG IMPL KILLED: the legacy adapter on the frame (A on the select does nothing: the wizard
    // is a plain form again); an opening header that is missing, on the wrong step, or with a step
    // name that is not the catalog's; a wizard that moves focus off the select on open (the
    // S10-WIRE-FOCUS-IDENTITY pin, and the legacy Escape/Enter keys would start in the wrong
    // place); a review row visible on Target; a reopen that resumes the last visit's step
    // instead of starting over on Target; and an Escape that the select's shield swallows.
    await bootReady();
    seedStore();
    expect(proposeShown(), 'precondition: the overlay starts closed').toBe(false);

    press('KeyO', 1010);
    expect(proposeShown(), 'O opened the overlay').toBe(true);
    expect(stackNames()).toEqual(['world', 'tradeProposeView']);
    await flush();
    expect(document.activeElement, 'the deferred focus lands on the select').toBe(selectEl());

    const opened = header();
    expect(opened.steps, 'all five steps, in order').toEqual([...STEPS]);
    expect(opened.texts, 'their catalogued names').toEqual(STEPS.map(stepText));
    expect(opened.current, 'opens on Target').toEqual(['target=step']);
    expect(reviewShown(), 'no review question on Target').toBe(false);

    press('Enter', 1100);
    expect(currentStep(), 'the adapter heard A on the select').toEqual(['offer=step']);
    expect(document.activeElement, 'the Offer step is the monsters').toBe(monstersEl());
    expect(proposeShown(), 'A does not close the overlay').toBe(true);

    press('Escape', 1200);
    expect(proposeShown(), 'Escape (Start) closes it').toBe(false);
    expect(stackNames()).toEqual(['world']);

    press('KeyO', 1300);
    await flush();
    expect(proposeShown(), 'reopened').toBe(true);
    expect(currentStep(), 'starts over on Target').toEqual(['target=step']);
    expect(document.activeElement, 'focus on the select again').toBe(selectEl());
    press('Enter', 1400);
    expect(currentStep(), 'a fresh A on Target, not a resumed Review').toEqual(['offer=step']);
    expect(proposeCalls(), 'nothing was sent').toEqual([]);
  });

  it('CTL8E-1-BOOT-WIZARD: by keys alone: pick the target, A to Offer (focus on the monsters, cursor on the first), Down + A ticks the SECOND monster only, RB to Coins (focus in the offer field), type 25, A to Ask (focus in the request field), type 7, A to Review (row shown, Yes marked, the prompt, a summary of the parsed draft), A on Yes sends exactly ONE proposeTrade for that counterparty, that monster, 25n and 7n; the next A (cursor on No) steps back to Ask and sends nothing; A to Review and B steps back to Ask; and after a reopen LB on Offer goes back to Target', async () => {
    // WRONG IMPL KILLED: the legacy adapter (every key but Escape is inert: B5's red); a step
    // header that does not follow the adapter; focus that stays on the select (the D-pad and B
    // never reach the router from a form control: only a focus move onto a non-form element
    // gives the player the keys); a cursor that starts on the second monster, an Enter that
    // ticks the first, both or no box (the toggle token is keyed by monster id); an RB/PageDown
    // that does nothing on Offer; an Enter in a coin field that still SUBMITS (the pre-ctl-8e
    // local Enter=submit: the half-built offer would go out from Coins); a Review that opens on
    // No or shows "incomplete" for a complete draft; a summary of the raw field text; a Yes that
    // sends nothing, sends twice (a double-tap of Enter), sends before Review, or sends the
    // draft the screen remembers instead of the one on screen (wrong target, extra monster, coins
    // as numbers); a second Enter that re-sends; a B that does not step back from the focused
    // review row; and an LB that does not page back to Target.
    await bootReady();
    seedStore();
    let at = 1010;
    const key = (code: string): void => {
      press(code, at);
      at += 20;
    };

    key('KeyO');
    await flush();
    expect(document.activeElement, 'precondition: the select has focus').toBe(selectEl());
    expect(
      Array.from(monstersEl().querySelectorAll('input')).map((b) =>
        b.getAttribute('data-monster-id'),
      ),
      'precondition: both own monsters are offerable',
    ).toEqual([FIRST_MONSTER.toString(), SECOND_MONSTER.toString()]);

    // --- Target -> Offer ---------------------------------------------------------------------
    pickTarget(OTHER);
    expect(selectEl().value, 'precondition: the player chose Zed').toBe(OTHER);
    key('Enter');
    expect(currentStep(), 'A on Target').toEqual(['offer=step']);
    expect(document.activeElement, 'Offer: focus on the monsters container').toBe(monstersEl());
    expect(cursorMonsters(), 'the cursor opens on the first monster').toEqual(['31']);
    expect(checkedMonsters(), 'nothing is ticked yet').toEqual([]);

    // --- Offer: Down moves the cursor, A ticks that monster ------------------------------------
    key('ArrowDown');
    expect(cursorMonsters(), 'Down: the second monster').toEqual(['32']);
    expect(checkedMonsters(), 'moving ticks nothing').toEqual([]);
    key('Enter');
    expect(checkedMonsters(), 'A ticks the SECOND monster only').toEqual(['32']);
    expect(currentStep(), 'A stays on Offer').toEqual(['offer=step']);
    expect(document.activeElement, 'and focus stays on the monsters').toBe(monstersEl());

    // --- Offer -> Coins -> Ask -> Review ------------------------------------------------------
    key('PageDown');
    expect(currentStep(), 'RB').toEqual(['coins=step']);
    expect(document.activeElement, 'Coins: focus in the offer field').toBe(offerEl());
    typeInto(offerEl(), '25');
    key('Enter');
    expect(currentStep(), 'Enter in the offer field steps to Ask').toEqual(['ask=step']);
    expect(document.activeElement, 'Ask: focus in the request field').toBe(requestEl());
    expect(proposeCalls(), 'Enter in a coin field sends nothing').toEqual([]);
    typeInto(requestEl(), '7');
    key('Enter');
    expect(currentStep(), 'Enter in the request field steps to Review').toEqual(['review=step']);
    expect(proposeCalls(), 'reaching Review sends nothing').toEqual([]);

    expect(reviewShown(), 'the review row is shown').toBe(true);
    expect(document.activeElement, 'Review: focus on the review row').toBe(reviewRow());
    expect(
      testEl('tradepropose-review-yes').getAttribute('aria-current'),
      'Yes is the default answer',
    ).toBe('true');
    expect(testEl('tradepropose-review-no').hasAttribute('aria-current')).toBe(false);
    expect(testEl('tradepropose-review-prompt').textContent, 'a complete draft').toBe(
      i18n.t('tradePropose.review.prompt'),
    );
    const summary = testEl('tradepropose-review-summary').textContent ?? '';
    expect(summary, 'the summary of the parsed on-screen draft').toBe(
      i18n.tf('tradePropose.review.summary', {
        target: OTHER_NAME,
        monsters: 1,
        offer: '25',
        ask: '7',
      } as never),
    );
    expect(summary.includes('25') && summary.includes('7'), 'both coin amounts appear').toBe(true);

    // --- Yes: exactly one proposeTrade of the on-screen draft ---------------------------------
    key('Enter');
    await flush();
    const sent = proposeCalls();
    expect(sent.length, 'A on Yes sends exactly one proposeTrade').toBe(1);
    const args = sent[0]?.args as {
      counterparty: unknown;
      initiatorMonsterIds: bigint[];
      initiatorCurrency: bigint;
      counterpartyCurrency: bigint;
    };
    expect(hexOf(args.counterparty), 'to Zed').toBe(OTHER);
    expect(args.initiatorMonsterIds, 'offering the second monster only').toEqual([SECOND_MONSTER]);
    expect(args.initiatorCurrency, 'offering 25 coins').toBe(25n);
    expect(args.counterpartyCurrency, 'asking 7 coins').toBe(7n);

    // --- the cursor moved to No: the next A steps back and sends nothing ------------------------
    key('Enter');
    await flush();
    expect(proposeCalls().length, 'a further Enter sends nothing more').toBe(1);
    expect(currentStep(), 'A on No steps back to Ask').toEqual(['ask=step']);
    expect(document.activeElement, 'back in the request field').toBe(requestEl());
    expect(reviewShown(), 'the review row is hidden again').toBe(false);

    // --- B steps back from the focused review row -------------------------------------------------
    key('Enter');
    expect(currentStep(), 'A on Ask').toEqual(['review=step']);
    expect(document.activeElement, 'on the review row').toBe(reviewRow());
    key('Backspace');
    expect(currentStep(), 'B steps back one step').toEqual(['ask=step']);
    expect(document.activeElement, 'to the request field').toBe(requestEl());
    expect(proposeCalls().length, 'stepping back sends nothing').toBe(1);

    // --- a reopen starts clean, and LB on Offer pages back to Target ---------------------------
    key('Escape'); // stops typing: the overlay and the text stay
    expect(proposeShown(), 'the first Escape only stops typing').toBe(true);
    key('Escape'); // Start
    expect(proposeShown(), 'the second Escape closes it').toBe(false);
    key('KeyO');
    await flush();
    expect(currentStep(), 'reopened on Target').toEqual(['target=step']);
    expect(checkedMonsters(), 'the closed draft is gone').toEqual([]);
    expect(offerEl().value).toBe('');
    pickTarget(OTHER);
    key('Enter');
    expect(currentStep()).toEqual(['offer=step']);
    expect(document.activeElement).toBe(monstersEl());
    key('PageUp');
    expect(currentStep(), 'LB on Offer goes back to Target').toEqual(['target=step']);
    expect(document.activeElement, 'with focus on the select').toBe(selectEl());
    expect(proposeCalls().length, 'still exactly one offer was sent in all').toBe(1);
  });

  it('CTL8E-1-BOOT-WIZARD: a monster ticked on Review that leaves the store before Yes makes the confirm send NOTHING (the token is spent on the draft it was seen with), the summary shows the changed draft, and flipping back to Yes and confirming again sends the new draft once', async () => {
    // WRONG IMPL KILLED: a commit that rebuilds the lists from the live store and then sends the
    // draft as it now is: the player confirmed "monster 31 + 25 coins" and an offer of 25 coins
    // alone goes out (or the server rejects a monster that is gone). What is sent must be what
    // was on screen when Yes was pressed.
    await bootReady();
    seedStore();
    let at = 1010;
    const key = (code: string): void => {
      press(code, at);
      at += 20;
    };
    key('KeyO');
    await flush();
    pickTarget(OTHER);
    key('Enter'); // Offer, cursor on the first monster
    key('Enter'); // ticks it
    expect(checkedMonsters(), 'precondition: the first monster is ticked').toEqual(['31']);
    key('PageDown');
    typeInto(offerEl(), '25');
    key('Enter'); // Ask
    key('Enter'); // Review
    expect(currentStep(), 'precondition: on Review').toEqual(['review=step']);
    expect(testEl('tradepropose-review-summary').textContent, 'precondition: monster + coins').toBe(
      i18n.tf('tradePropose.review.summary', {
        target: OTHER_NAME,
        monsters: 1,
        offer: '25',
        ask: '0',
      } as never),
    );

    // The ticked monster leaves the store (a batch), then Yes.
    opts.store.reconcileMonstersFromView([ownMonster(SECOND_MONSTER, 'Sprig')]);
    server(at);
    at += 20;
    key('Enter');
    await flush();
    expect(proposeCalls(), 'the confirmed draft changed: nothing is sent').toEqual([]);
    expect(
      Array.from(monstersEl().querySelectorAll('input')).map((b) =>
        b.getAttribute('data-monster-id'),
      ),
      'the gone monster`s box is gone',
    ).toEqual([SECOND_MONSTER.toString()]);
    expect(
      testEl('tradepropose-review-summary').textContent,
      'the summary shows the new draft',
    ).toBe(
      i18n.tf('tradePropose.review.summary', {
        target: OTHER_NAME,
        monsters: 0,
        offer: '25',
        ask: '0',
      } as never),
    );

    key('ArrowUp'); // the cursor was moved to No by the spent Yes: back to Yes
    key('Enter');
    await flush();
    const sent = proposeCalls();
    expect(sent.length, 'a fresh confirm sends the new draft once').toBe(1);
    const args = sent[0]?.args as {
      initiatorMonsterIds: bigint[];
      initiatorCurrency: bigint;
    };
    expect(args.initiatorMonsterIds, 'no monster in the new offer').toEqual([]);
    expect(args.initiatorCurrency).toBe(25n);
  });

  it('CTL8E-1-BOOT-WIZARD: closing from Review with Escape and reopening shows no review row: the reopened wizard is on Target with the Review question hidden', async () => {
    // WRONG IMPL KILLED: a close that leaves the runtime review row displayed (the reopened wizard
    // shows "Send this offer? Yes / No" under the Target step), and a reopen that resumes Review.
    await bootReady();
    seedStore();
    let at = 1010;
    const key = (code: string): void => {
      press(code, at);
      at += 20;
    };
    key('KeyO');
    await flush();
    pickTarget(OTHER);
    key('Enter'); // Offer
    key('PageDown'); // Coins
    key('Enter'); // Ask
    key('Enter'); // Review
    expect(currentStep(), 'precondition: on Review').toEqual(['review=step']);
    expect(reviewShown(), 'precondition: the row is shown').toBe(true);

    key('Escape'); // focus is on the review row, not a field: Start
    expect(proposeShown(), 'Escape closed the overlay').toBe(false);
    key('KeyO');
    await flush();
    expect(proposeShown(), 'reopened').toBe(true);
    expect(currentStep(), 'on Target').toEqual(['target=step']);
    expect(reviewShown(), 'with the review row hidden').toBe(false);
    expect(proposeCalls(), 'nothing was sent').toEqual([]);
  });

  it('CTL8E-1-BOOT-ESCAPE: Escape on the select after the deferred focus closes the overlay (B5: it was dead), and in a second run Escape in the offer field keeps the typed text, keeps the overlay open, does not advance the step and sends nothing, with the next Escape closing it', async () => {
    // WRONG IMPL KILLED: a select or field shield that swallows Escape (the overlay opens and the
    // player is trapped: B5); an Escape in the field that closes the overlay and drops the draft
    // (CTL6B.5 says it stops typing and keeps the text); one that wipes the field; one that
    // advances or steps back the wizard (an Escape reaching the adapter as A or B); one that
    // sends; and a stop-typing that leaves focus in the field so the next Escape types nowhere.
    await bootReady();
    seedStore();
    let at = 1010;
    const key = (code: string): void => {
      press(code, at);
      at += 20;
    };

    // --- run 1: Escape on the freshly opened wizard ----------------------------------------------
    key('KeyO');
    await flush();
    expect(proposeShown(), 'precondition: O opened the wizard').toBe(true);
    expect(document.activeElement, 'precondition: the select has focus').toBe(selectEl());
    key('Escape');
    expect(proposeShown(), 'Escape on the select closes the overlay').toBe(false);
    expect(stackNames()).toEqual(['world']);

    // --- run 2: Escape in the offer field -----------------------------------------------------
    key('KeyO');
    await flush();
    expect(proposeShown(), 'precondition: reopened').toBe(true);
    pickTarget(OTHER);
    key('Enter');
    key('PageDown');
    expect(currentStep(), 'precondition: on Coins').toEqual(['coins=step']);
    expect(document.activeElement, 'precondition: typing in the offer field').toBe(offerEl());
    typeInto(offerEl(), '25');

    key('Escape');
    expect(proposeShown(), 'Escape in the field keeps the overlay open').toBe(true);
    expect(offerEl().value, 'and the typed text').toBe('25');
    expect(currentStep(), 'and does not move the wizard').toEqual(['coins=step']);
    expect(document.activeElement, 'focus left the field').not.toBe(offerEl());
    expect(
      el('tradepropose-overlay').contains(document.activeElement),
      'and stayed inside the overlay',
    ).toBe(true);
    expect(proposeCalls(), 'nothing was sent').toEqual([]);
    expect(stackNames()).toEqual(['world', 'tradeProposeView']);

    key('Escape');
    expect(proposeShown(), 'the next Escape is Start: it closes the overlay').toBe(false);
    expect(stackNames()).toEqual(['world']);
    expect(proposeCalls(), 'abandoning the draft sends nothing').toEqual([]);
  });
});
