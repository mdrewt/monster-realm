// @vitest-environment happy-dom
// shell/views — the view handles main() builds at boot. A real boot of main.ts on the real
// index.html shell mounts each handle into this module; the suite reads the handles back through
// `./views` in the same module registry and checks they are the instances the shell drives.
// Harness: main.help.test.ts's pattern (vi.resetModules + a fresh import per boot, one
// controllable clock and rAF, a stubbed wasm pkg, SDK connection, telemetry and renderer).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectionRecordingMock,
  mountIndexHtmlShell,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../../test-util/mainBootHarness';
import type { WasmMoveInput } from '../convert/convert';
import type { ConnectionOptions } from '../net/connection';
import type { ViewHandles } from './views';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  sends: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
}));

// The 17 `tactics_*` exports the rules port binds (`bindTacticsRules` refuses a pkg missing any).
vi.mock('../../../client-wasm/pkg/client_wasm.js', () => ({
  ...wasmPkgWalkingMock(),
  tactics_map: () => ({
    width: 7,
    height: 5,
    tiles: [],
    spawn_a: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ],
    spawn_b: [],
  }),
  tactics_fresh_budget: () => ({ ap: 6, strides_used: 0, attacks: 0, last: null }),
  tactics_unit: (row: unknown) => row,
  tactics_targets: () => ({ Ok: [] }),
  tactics_path: () => ({ Err: 'Unreachable' }),
  tactics_disengage: () => ({ Ok: false }),
  tactics_flank: () => false,
  tactics_forecast: () => ({}),
  tactics_recruit_odds: () => ({ Err: { UnknownUnit: { id: 0 } } }),
  tactics_ai_plan: () => [],
  tactics_recruit_targets: () => [],
  tactics_is_exhausted: () => false,
  tactics_plan: () => ({ Err: 'ZeroStrides' }),
  tactics_overlays: () => ({
    reach1: [],
    reach2: [],
    range: [],
    aoe: [],
    danger: [],
    shield: [],
    intents: [],
  }),
  tactics_tuning: () => ({ surge_start_round: 9, wild_round_cap: 30, autopass_forfeit: 4 }),
  tactics_next_initiative: () => [],
  tactics_deploy_slots: () => 3,
}));

vi.mock('../net/connection', () => connectionRecordingMock(H));

vi.mock('../observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('../observability/telemetry')>()),
);

vi.mock('../render/world', () => worldRendererMock());

// --- the handle roster ------------------------------------------------------------------------
type Views = typeof import('./views');
type HandleName = keyof ViewHandles;
type Ctor = abstract new (...args: never[]) => object;
/** What a mounted handle must be: an instance of its view class, or exactly a module export. */
type Want = { readonly cls: Ctor } | { readonly value: unknown };
/** Which shell element the boot builds the handle under (`none`: built unconditionally). */
type Gate = 'app' | 'hint-bar' | 'none';

/** Every handle, the element its boot mount depends on, and how to load what it must be. The
 *  loaders import AFTER a boot, from the same module registry main.ts used. */
const ROSTER: Readonly<Record<HandleName, { readonly gate: Gate; load(): Promise<Want> }>> = {
  boxView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/boxView')).BoxView }),
  },
  raisingView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/raisingView')).RaisingView }),
  },
  evolutionView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/evolutionView')).EvolutionView }),
  },
  dialogueView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/dialogueView')).DialogueView }),
  },
  questLogView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/questLogView')).QuestLogView }),
  },
  healView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/healView')).HealView }),
  },
  shopView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/shopView')).ShopView }),
  },
  tradeView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/tradeView')).TradeView }),
  },
  pvpView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/pvpView')).PvpView }),
  },
  leaderboardView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/leaderboardView')).LeaderboardView }),
  },
  profileView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/profileView')).ProfileView }),
  },
  renameView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/renameView')).RenameView }),
  },
  tradeSessionView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/tradeSessionView')).TradeSessionView }),
  },
  helpView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/helpView')).HelpView }),
  },
  menuView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/menuView')).MenuView }),
  },
  claimView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/claimView')).ClaimView }),
  },
  privacyView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/privacyView')).PrivacyView }),
  },
  controlsView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/controlsView')).ControlsView }),
  },
  controlsSavedLine: {
    gate: 'app',
    load: async () => ({ value: (await import('../ui/controlsView')).savedLine }),
  },
  sessionView: {
    gate: 'app',
    load: async () => ({ cls: (await import('../ui/sessionView')).SessionView }),
  },
  evolutionNoticeBanner: {
    gate: 'none',
    load: async () => ({ cls: (await import('../ui/evolutionNotice')).EvolutionNoticeBanner }),
  },
  errorOverlayView: {
    gate: 'none',
    load: async () => ({ cls: (await import('../ui/errorOverlayView')).ErrorOverlayView }),
  },
  hintBarView: {
    gate: 'hint-bar',
    load: async () => ({ cls: (await import('../ui/hintBar')).HintBarView }),
  },
};

const ALL = Object.keys(ROSTER) as HandleName[];
const gated = (gate: Gate): HandleName[] => ALL.filter((name) => ROSTER[name].gate === gate);

/** Asserts each named handle is mounted as what the roster says; answers how many it checked. */
async function expectMounted(views: Views, names: readonly HandleName[]): Promise<number> {
  let visited = 0;
  for (const name of names) {
    const want = await ROSTER[name].load();
    const got: unknown = views[name];
    if ('cls' in want) {
      expect(got, `${name} is mounted as an instance of its view class`).toBeInstanceOf(want.cls);
    } else {
      expect(got, `${name} is mounted as exactly that module export`).toBe(want.value);
    }
    visited += 1;
  }
  return visited;
}

/** Asserts each named handle is still `undefined`; answers how many it checked. */
function expectUnmounted(views: Views, names: readonly HandleName[]): number {
  let visited = 0;
  for (const name of names) {
    expect(views[name], `${name} is not mounted`).toBeUndefined();
    visited += 1;
  }
  return visited;
}

// --- harness ------------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

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

const clock = { t: 0 };
let rafCallback: FrameRequestCallback | null = null;
let rafCalls = 0;
let opts: ConnectionOptions;
let T = 1000;
const next = (ms: number): number => {
  T += ms;
  return T;
};

function teardown(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rafCallback = null;
  rafCalls = 0;
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
  vi.resetModules();
}

/** Boot a fresh main.ts on the real shell, minus the element `without` names; answers the
 *  `./views` module main.ts mounted into. `onReady` is not called. */
async function boot(without?: 'app' | 'hint-bar'): Promise<Views> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  T = 1000;
  clock.t = T;
  localStorage.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  if (without !== undefined) {
    const el = document.getElementById(without);
    expect(el, `the real shell ships #${without}`).not.toBeNull();
    el?.remove();
    expect(document.getElementById(without), `#${without} is gone from the shell`).toBeNull();
  }
  recordListeners(window);
  recordListeners(document);
  rafCallback = null;
  rafCalls = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallback = cb;
    rafCalls += 1;
    return 0;
  });
  vi.resetModules();
  await import('../main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
  // Same registry, no reset: this is the module instance main.ts imported.
  return import('./views');
}

function frame(ms = 50): void {
  const cb = rafCallback;
  if (cb === null) throw new Error('no rAF callback armed');
  rafCallback = null;
  clock.t = next(ms);
  cb(clock.t);
  expect(rafCallback, 'frame did not re-arm requestAnimationFrame').not.toBeNull();
}

const EID = 7n;

/** One server batch: the own player and character, on the world. */
function batch(): void {
  clock.t = next(50);
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
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
      ackedSeq: BigInt(H.sends.length),
    },
    clock.t,
  );
  opts.store.flushBatch();
}

function press(code: string): void {
  clock.t = next(50);
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  clock.t = next(5);
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

const NOTICE_BANNER = 'notice-banner';

// --- tests ----------------------------------------------------------------------------------
describe('boot-built view handles are read from shell/views', { sequential: true }, () => {
  afterEach(teardown);

  it('a boot on the real shell mounts all 23 handles, each as its real view class (and the Controls saved line as the controlsView module export)', async () => {
    const views = await boot();
    expect(ALL, 'the roster names every handle').toHaveLength(23);
    expect(await expectMounted(views, ALL), 'every handle was checked').toBe(23);
  }, 60_000);

  it('Select opens the mounted How to Play view: its visible turns from false to true', async () => {
    const views = await boot();
    opts.onReady(H.identity);
    batch();
    frame();
    expect(views.helpView?.visible, 'the mounted Help view starts hidden').toBe(false);
    press('KeyR'); // Select
    frame();
    expect(views.helpView?.visible, 'Select showed the mounted Help view').toBe(true);
  }, 60_000);

  it('the mounted Profile frame holds the mounted Name, Account and Privacy sections', async () => {
    const views = await boot();
    const frameRoot = views.profileView?.sectionRoot;
    expect(frameRoot, 'the Profile frame is mounted').toBeInstanceOf(HTMLElement);
    const sections = {
      renameView: views.renameView?.sectionRoot,
      claimView: views.claimView?.sectionRoot,
      privacyView: views.privacyView?.sectionRoot,
    };
    let visited = 0;
    for (const [name, root] of Object.entries(sections)) {
      expect(root, `${name}'s section root exists`).toBeInstanceOf(HTMLElement);
      expect(root, `${name}'s section root is not the frame root`).not.toBe(frameRoot);
      expect(
        frameRoot?.contains(root ?? null),
        `the Profile frame holds the mounted ${name}'s section`,
      ).toBe(true);
      visited += 1;
    }
    expect(visited, 'all three sections were checked').toBe(3);
  }, 60_000);

  it('the mounted hint bar view paints #hint-bar at boot, before any animation frame runs', async () => {
    const views = await boot();
    expect(rafCalls, 'boot requested its first frame').toBeGreaterThan(0);
    expect(rafCallback, 'and that frame has not run').not.toBeNull();
    const bar = document.getElementById('hint-bar');
    expect(bar, 'the real shell ships #hint-bar').not.toBeNull();
    const verbs = Array.from(bar?.querySelectorAll('.mr-chip-verb') ?? []).map(
      (el) => el.textContent ?? '',
    );
    expect(verbs.length, 'boot painted at least one chip').toBeGreaterThan(0);
    for (const verb of verbs) expect(verb.trim(), 'each painted chip names its verb').not.toBe('');

    const hint = views.hintBarView;
    expect(hint, 'hintBarView is mounted').toBeDefined();
    const banner = document.getElementById(NOTICE_BANNER);
    expect(banner?.parentElement, 'the hint bar view built its banner in #hint-bar').toBe(bar);
    expect(banner?.hidden, 'the boot paint carries no banner').toBe(true);
    // The mounted instance is the one bound to #hint-bar: its render reaches that element.
    hint?.render([], 'probe');
    expect(document.getElementById(NOTICE_BANNER)?.textContent).toBe('probe');
    expect(document.getElementById(NOTICE_BANNER)?.hidden).toBe(false);
  }, 60_000);

  it('a boot with no #app leaves the 20 #app-built handles undefined and still mounts the evolution banner, the error overlay and the hint bar', async () => {
    const views = await boot('app');
    const appBuilt = gated('app');
    expect(appBuilt, 'the roster marks 20 handles as built under #app').toHaveLength(20);
    expect(expectUnmounted(views, appBuilt), 'every #app-built handle was checked').toBe(20);
    expect(
      await expectMounted(views, [...gated('none'), ...gated('hint-bar')]),
      'the three handles built outside #app were checked',
    ).toBe(3);
  }, 60_000);

  it('a boot with no #hint-bar leaves hintBarView undefined and mounts the other 22 handles', async () => {
    const views = await boot('hint-bar');
    expect(expectUnmounted(views, ['hintBarView'])).toBe(1);
    const others = ALL.filter((name) => name !== 'hintBarView');
    expect(await expectMounted(views, others), 'every other handle was checked').toBe(22);
  }, 60_000);
});

describe('mountViews', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('mounts the handles it is given and keeps every handle a later call omits', async () => {
    vi.resetModules();
    const views = await import('./views');
    expect(expectUnmounted(views, ALL), 'every handle starts undefined').toBe(23);

    const box = { sentinel: 'boxView' } as unknown as ViewHandles['boxView'];
    views.mountViews({ boxView: box });
    expect(views.boxView, 'the first call mounted boxView').toBe(box);
    const rest1 = ALL.filter((name) => name !== 'boxView');
    expect(expectUnmounted(views, rest1), 'the first call mounted nothing else').toBe(22);

    const help = { sentinel: 'helpView' } as unknown as ViewHandles['helpView'];
    views.mountViews({ helpView: help });
    expect(views.helpView, 'the second call mounted helpView').toBe(help);
    expect(views.boxView, 'boxView keeps the instance the first call mounted').toBe(box);
    const rest2 = ALL.filter((name) => name !== 'boxView' && name !== 'helpView');
    expect(expectUnmounted(views, rest2), 'the second call mounted nothing else').toBe(21);
  });
});
