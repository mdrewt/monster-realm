// @vitest-environment happy-dom
// ui/overlayA11yWiring.test.ts — the CROSS-VIEW overlay-a11y wiring spec (M23 §5.5, slice m23-s10;
// criteria A11Y-13, A11Y-14, A11Y-16).
//
// WHY THIS FILE EXISTS WHEN SIXTEEN PER-VIEW SPECS ALREADY DO. Each of those proves ONE id, from a
// hand-copied byte fixture of its own shell. Two properties are invisible to all of them together:
//
//   1. TOTALITY. Nothing asserts that EVERY `OverlayId` is wired. A seventeenth overlay, or a view
//      whose `show()` quietly stopped calling the helper, is caught by no existing test. Here the
//      opener table is `Readonly<Record<OverlayId, …>>` (`overlayRegistry.ts:76`/`:164`'s device),
//      belt-and-braced with a runtime key-set equality, a runtime SHAPE equality over what each
//      opener hands back, and a `checked === 16` counter.
//      CORRECTION (rb-18): the `Record` is an EDITOR-time device only. `client/tsconfig.json`
//      excludes `**/*.test.ts`, so `just client-typecheck` — and therefore `just ci` — never
//      typechecks this file, and vitest transpiles without checking. The header previously called
//      a missing id "a COMPILE error"; in CI it is not one. Every totality claim below is
//      therefore carried by a RUNTIME assertion, which is why `S10-WIRE-TOTALITY` pins the opener
//      RETURN SHAPE and not merely the key set.
//   2. FIXTURE FIDELITY. The per-view specs copy their shell markup into the test file, so they
//      keep passing if `client/index.html` loses a `tabindex` — the very attribute ADR-0205 D1
//      makes ten of the sixteen anchors depend on. This file adopts the REAL `client/index.html`,
//      so that deletion reds here.
//
// THE ORACLE, AND WHY IT IS NOT THE ONE §5.5 SPECIFIES. Both of §5.5's stated open-side assertions
// are VACUOUS on the shipped tree, measured:
//   * `role === OVERLAY_A11Y[id].role` and `aria-modal === 'true'` are STATIC LITERALS in
//     `client/index.html` for eleven of the sixteen roots (`:17`, `:22`, `:25`, `:29`, `:36`, `:44`,
//     `:52`, `:57`, `:64`, `:90`, `:105`), and for the other five they are echoed straight back from
//     the table the assertion reads. A view whose `show()` calls nothing passes both.
//     `helpView.test.ts:56` and `dialogueView.test.ts:23` already record this in-source.
//   * The `{BUTTON, INPUT, SELECT, A, TEXTAREA}` tag allow-list is UNSATISFIABLE: exactly THREE of
//     sixteen anchors qualify (`#rename-input`, `#tradepropose-target`, `#claim-signin-btn`). The
//     other thirteen are `<div>`/`<ul>`/`<h2>` carrying `tabindex="-1"` — the ARIA APG dialog
//     fallback the milestone DELIBERATELY ships. `docs/adr/0205:31,:50-58` amends the wording to
//     "focusable — natively, or via `tabindex`" and `:284-287` instructs this slice by name to use
//     "the identity assertion as the anti-vacuity device, not a native-tag allow-list".
//     THAT AMENDMENT IS STILL FLAGGED FOR OPERATOR SIGN-OFF; if it is rejected, S2/S4 absorb the
//     cost and `isFocusableByContract` below becomes the tag list.
//
// So the four conjuncts asserted per id are:
//   (a) VALUE — `aria-label === t(OVERLAY_A11Y[id].labelKey)`. `index.html` ships ZERO `aria-label`
//       attributes, so this one exists only if `overlayA11y.ts:108` actually ran. All sixteen
//       catalog values are distinct, so it also kills a copy-pasted wrong `OverlayId`.
//   (b) MECHANISM — `openOverlayA11y` was called EXACTLY ONCE, with THIS id. Call-through spying
//       (`{ spy: true }`) keeps the real attribute writes and focus moves working, so a cheat that
//       hand-writes the three attributes with the correct literals — no trap, no return-focus
//       record, no timer — still reds.
//   (c) FOCUS — `document.activeElement === root.querySelector(initialFocusSelector)` after ONE
//       REAL macrotask, with a SENTINEL button focused outside the root beforehand and asserted
//       un-focused after. Identity, never containment (§5.5's own declared attack), and the
//       sentinel is what makes "the anchor is active because nothing happened" impossible.
//       The root must also not be `display:none` when the deferred focus is due: happy-dom will
//       happily focus a node inside a hidden subtree, where a real browser silently refuses — the
//       open-before-paint defect `battleView.ts:26` warns about.
//   (d) REMOVAL — after close, `role`, `aria-modal` and `aria-label` are all ABSENT and focus is
//       back on the sentinel. Presence is free from the static markup; ABSENCE is impossible
//       without the wiring having run, which is what makes this the anti-vacuity partner of (a).
//   (e) NO RE-OPEN — a SECOND open on an already-visible overlay is a NO-EDGE: the helper is not
//       called again, the manifest anchor node is not rebuilt, and focus stays on whatever the
//       player moved it to inside the overlay. Added by rb-18 (residual R-m23-s10-X21). Until it
//       existed, this file opened each id exactly once, so deleting a view's `if (!wasVisible)`
//       guard shipped GREEN here — MEASURED, all sixteen mutants survived. Sixteen per-view specs
//       each caught their own (also measured), but nothing in the SHARED layer did, so the
//       guarantee rested entirely on sixteen separately-maintained files staying in sync and on
//       a seventeenth overlay's author remembering to copy the idiom. Here the `reopen` handle is
//       a REQUIRED field of `Opened`, so a new `OverlayId` cannot ship without one.
//       SCOPE, stated so it is not over-read: this proves the guard on the open path each view's
//       PRODUCTION caller drives — `show()` for thirteen ids, the `render()` null->non-null edge
//       for `dialogueView`/`questLogView`/`healView`. `claimView` has a SECOND guarded open site
//       (`claimView.ts:107`, `vm.visible && !wasVisible`) which `show()` does not reach; that one
//       is owned by `claimView.test.ts` (`S4-claimView-THREE-DOORS`) and is NOT covered here.
//
// NO FAKE TIMERS: the one-macrotask defer is load-bearing (`overlayA11y.ts:9-15` — an overlay
// opened by a letter hotkey would otherwise swallow that letter into the field it just focused),
// and both polarities are pinned by the per-view specs already.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { BattleView } from './battleView';
import { BoxView } from './boxView';
import { ClaimView } from './claimView';
import { DialogueView } from './dialogueView';
import { EvolutionView } from './evolutionView';
import { HealView } from './healView';
import { HelpView } from './helpView';
import { LeaderboardView } from './leaderboardView';
import { MenuView } from './menuView';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import { PvpView } from './pvpView';
import { QuestLogView } from './questLogView';
import { RaisingView } from './raisingView';
import { RenameView } from './renameView';
import { ShopView } from './shopView';
import { TradeProposeView } from './tradeProposeView';
import { TradeView } from './tradeView';

// The MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE and FOCUS oracles still exercise real DOM writes.
vi.mock('./overlayA11y', { spy: true });

// `path.join(path.dirname(fileURLToPath(import.meta.url)), …)` and NOT
// `new URL('…', import.meta.url)`: Vite treats the latter as its asset-URL pattern and rewrites it
// at transform time, so `fileURLToPath` then receives a non-file URL and throws. The form below is
// the one `indexShell.test.ts:91` and `main.a11yFocus.test.ts:243` already use.
const INDEX_HTML_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'index.html',
);
const SENTINEL_ID = 'a11y-wiring-sentinel';

/** Tags the platform focuses with no author intervention. One arm of ADR-0205 D1's disjunction. */
const NATIVE_FOCUSABLE_TAGS: ReadonlySet<string> = new Set([
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'BUTTON',
  'A',
]);

/**
 * ADR-0205 D1's amended criterion, as a predicate rather than a list.
 *
 * An explicit integer `tabindex` makes ANY element programmatically focusable — that is the ARIA
 * APG dialog fallback, and it is what ten static anchors plus the four constructed `<h2>` headings
 * rely on. A decorative wrapper with neither arm fails, which is the property §5.5's tag allow-list
 * was reaching for; the allow-list itself is unsatisfiable here (see the header).
 *
 * NOT `focusTrap.ts:64`'s `FOCUSABLE_SELECTOR`: that one deliberately EXCLUDES `[tabindex="-1"]`
 * (`focusTrap.ts:52-56`), because tab-ring membership and programmatic focusability are different
 * questions. Using it here would fail thirteen of sixteen ids for the wrong reason.
 */
// Module-local, NOT exported: biome's `noExportsInTest` treats an export from a spec file as a
// production-module smell, and nothing outside this file consumes it.
function isFocusableByContract(el: Element): boolean {
  const explicit = el.getAttribute('tabindex');
  // `/^-?\d+$/`, NOT `Number.isInteger(Number(x))` — matching `indexShell.test.ts:1988`.
  // `Number('')` is 0, so the loose form accepts a bare `tabindex` attribute whose VALUE was
  // deleted, which is exactly the shipped-markup regression this file exists to catch (and
  // happy-dom focuses such a node happily, so the identity assertion would not catch it either).
  // `0x10`, `1e3` and `+1` are likewise accepted by `Number()` and invalid per HTML integer parsing.
  if (explicit !== null) return /^-?\d+$/.test(explicit.trim());
  return NATIVE_FOCUSABLE_TAGS.has(el.tagName) && !el.hasAttribute('disabled');
}

/** One real macrotask. A microtask flush does NOT run a `setTimeout(…, 0)`. */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Install the REAL `client/index.html` body into the test document.
 *
 * `DOMParser` + `adoptNode`, the idiom at `main.a11yFocus.test.ts:242-261`. The `<script>` tags are
 * dropped — this spec exercises the view classes directly and must never boot `main.ts`.
 */
function adoptRealIndexHtml(): void {
  const html = readFileSync(INDEX_HTML_PATH, 'utf8');
  // Drop the stylesheet <link> from the TEXT before parsing. happy-dom eagerly fetches it during
  // parseFromString, and with no dev server listening every construction emits a NetworkError to
  // stderr. Nothing in this spec reads computed style (`styles.css` is gated by
  // `indexShell.test.ts`'s own CSS oracle), so the link is pure noise here.
  const parsed = new DOMParser().parseFromString(
    html.split('<link rel="stylesheet" href="/src/styles.css" />').join(''),
    'text/html',
  );
  for (const script of Array.from(parsed.querySelectorAll('script'))) script.remove();
  const adopted = Array.from(parsed.body.childNodes).map((n) => document.adoptNode(n));
  document.body.replaceChildren(...adopted);
}

/** What an opener hands back: the root the helper was given, and how to re-open and close it. */
interface Opened {
  readonly root: HTMLElement;
  readonly close: () => void;
  /**
   * Drive the SAME production open path a SECOND time, on the SAME instance.
   *
   * REQUIRED, never optional: the totality device is `Readonly<Record<OverlayId, () => Opened>>`,
   * and an optional field would make sixteen silent omissions legal — reopening exactly the hole
   * rb-18 closes.
   *
   * It must close over the instance the opener already built. Calling `OPENERS[id]()` a second
   * time instead constructs a NEW view, and the five field-backed ids (`battleView`, `boxView`,
   * `raisingView`, `evolutionView`, `pvpView`) read `this.#visible`, which is `false` on a fresh
   * instance — so those five would legitimately re-open and the tooth would FALSE-RED on correct
   * code. Production never builds a second instance; it calls `show()`/`render()` again.
   */
  readonly reopen: () => void;
}

function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`${id} missing from the adopted client/index.html`);
  return el;
}

/** The element `#app`, the mount the four constructed overlays share. */
function appMount(): HTMLElement {
  return requireElement('app');
}

const noop = (): void => {};
const asyncNoop = async (): Promise<void> => {};

/**
 * How each of the sixteen overlays is OPENED, keyed by id.
 *
 * `Readonly<Record<OverlayId, …>>` on purpose: a seventeenth `OverlayId` is a COMPILE error here,
 * not a silently unchecked overlay — the same device `OVERLAY_TIERS` and `OVERLAY_A11Y` use.
 *
 * Three groups, matching the three open mechanisms the milestone actually ships:
 *   * thirteen with a `show()`;
 *   * `dialogueView` / `questLogView` / `healView`, which have NO `show()` and open on the
 *     `render(vm | null)` null -> non-null EDGE (criterion A11Y-34);
 *   * `claimView`, which has both and is body-appended by its own `ensureElement` — `show()` is
 *     used, which is the door `main.ts` calls.
 *
 * WHICH DOOR, AND WHERE THAT IS NOT THE PRODUCTION ONE (disclosed by rb-18 rather than left to be
 * discovered). Two entries drive a door the shipped caller does not, and neither is a false pass —
 * both views derive `visible` LIVE from the DOM rather than from a latch field, so the alternative
 * door is a behaviourally equivalent input to the `wasVisible` guard these teeth exercise:
 *   * `claimView`: `main.ts`'s `openClaim()` (`:454-462`) runs `applyClaim` -> `renderClaim()`
 *     BEFORE `show()`, and `applyClaim` moves the phase off `'hidden'`, so `render()` has already
 *     flipped `wasVisible` by the time `show()` runs. `show()`'s guard (`claimView.ts:118`) is
 *     therefore a structural no-op in every current call path; the door that really opens this
 *     overlay is `claimView.ts:107`, and it is owned by `claimView.test.ts`
 *     (`S4-claimView-THREE-DOORS`). Read the `claimView` rows below as pinning a real class
 *     invariant, NOT as covering the live production edge.
 *   * `questLogView` / `healView`: opened by `render(vm)` as production does, but CLOSED here by
 *     `render(null)`, whereas `main.ts:366-367` closes both with `hide()`. The mixed-door sequence
 *     (render-open -> hide-close -> render-reopen) is covered by each view's own
 *     `S3-<view>-REOPEN-AFTER-HIDE`.
 * Changing either opener would re-point five PRE-EXISTING per-id tests as well, which is a
 * decision of its own rather than a line rb-18 should quietly move.
 */
const OPENERS: Readonly<Record<OverlayId, () => Opened>> = {
  battleView: () => {
    const view = new BattleView(appMount(), {
      onAttack: noop,
      onFlee: noop,
      onSwap: noop,
      onRecruit: noop,
      onUseItem: noop,
      onPvpAttack: noop,
      onPvpSwap: noop,
    });
    view.show();
    return {
      root: capturedRoot('battleView'),
      close: () => view.hide(),
      reopen: () => view.show(),
    };
  },
  boxView: () => {
    const view = new BoxView(appMount(), {
      onSetNickname: noop,
      onSetPartySlot: noop,
      onHealParty: noop,
    });
    view.show();
    return { root: capturedRoot('boxView'), close: () => view.hide(), reopen: () => view.show() };
  },
  raisingView: () => {
    const view = new RaisingView(appMount(), { onTrain: noop, onCare: noop });
    view.show();
    return {
      root: capturedRoot('raisingView'),
      close: () => view.hide(),
      reopen: () => view.show(),
    };
  },
  evolutionView: () => {
    const view = new EvolutionView(appMount(), { onEvolve: noop });
    view.show();
    return {
      root: capturedRoot('evolutionView'),
      close: () => view.hide(),
      reopen: () => view.show(),
    };
  },
  // The three render-edge ids share one shape: a thunk that re-creates the view model, called once
  // to open and again to `reopen`. A thunk rather than a hoisted `const vm` because the object
  // literals below are contextually typed by `render()`'s parameter, which a hoisted `const` would
  // widen (`shopAction: null`, `costCurrency: 0n`). It is also the shape production really drives:
  // `main.ts`'s M12d store-batch listener builds a fresh view model on every batch (`:1627-1641`
  // as of 2026-09-02 — the landmark is the listener, the number is only a hint). But that half is
  // DEFENSIVE, not currently
  // load-bearing: none of the three `render()` bodies compares `vm` by identity today, so a
  // reused object would behave identically. Stated rather than left as an implied guarantee.
  // (rb-18 cited `main.ts:1574` for this fact and recorded that `dialogueView.ts` and
  // `dialogueView.test.ts` carried the same drifted number, flagged but untouched. rb-36 (PR#414)
  // has since retargeted all of them onto the landmark above, so that note is retired here too —
  // residual R-rb36-WIRINGCITE.)
  dialogueView: () => {
    const view = new DialogueView();
    const renderIt = (): void => {
      view.render({
        npcName: 'Elder Rowan',
        nodeText: 'Welcome, traveller.',
        choices: [{ text: 'Goodbye', idx: 0 }],
        canDismiss: true,
        shopAction: null,
      });
    };
    renderIt();
    return {
      root: capturedRoot('dialogueView'),
      close: () => view.render(null),
      reopen: renderIt,
    };
  },
  questLogView: () => {
    const view = new QuestLogView();
    const renderIt = (): void => {
      view.render({ active: [{ questId: 'q1', stepIndex: 0, displayName: 'Q1' }] });
    };
    renderIt();
    return {
      root: capturedRoot('questLogView'),
      close: () => view.render(null),
      reopen: renderIt,
    };
  },
  healView: () => {
    const view = new HealView();
    const renderIt = (): void => {
      view.render({
        locations: [
          {
            locationId: 1,
            zoneId: 1,
            tileX: 0,
            tileY: 0,
            costItemName: null,
            costQty: 0,
            costCurrency: 0n,
            cooldownMs: 0,
            isFree: true,
          },
        ],
      });
    };
    renderIt();
    return {
      root: capturedRoot('healView'),
      close: () => view.render(null),
      reopen: renderIt,
    };
  },
  shopView: () => {
    const view = new ShopView({ onBuy: noop, onSell: noop });
    view.show();
    return { root: capturedRoot('shopView'), close: () => view.hide(), reopen: () => view.show() };
  },
  tradeView: () => {
    const view = new TradeView({
      onAccept: asyncNoop,
      onReject: asyncNoop,
      onConfirm: asyncNoop,
      onCancel: asyncNoop,
    });
    view.show();
    return { root: capturedRoot('tradeView'), close: () => view.hide(), reopen: () => view.show() };
  },
  pvpView: () => {
    const view = new PvpView({
      onAccept: noop,
      onDecline: noop,
      onCancel: noop,
      onChallenge: noop,
    });
    view.show();
    return { root: capturedRoot('pvpView'), close: () => view.hide(), reopen: () => view.show() };
  },
  leaderboardView: () => {
    const view = new LeaderboardView();
    view.show();
    return {
      root: capturedRoot('leaderboardView'),
      close: () => view.hide(),
      reopen: () => view.show(),
    };
  },
  renameView: () => {
    const view = new RenameView({ onSubmit: noop });
    view.show();
    return {
      root: capturedRoot('renameView'),
      close: () => view.hide(),
      reopen: () => view.show(),
    };
  },
  tradeProposeView: () => {
    const view = new TradeProposeView({ onSubmit: noop });
    view.show();
    return {
      root: capturedRoot('tradeProposeView'),
      close: () => view.hide(),
      reopen: () => view.show(),
    };
  },
  helpView: () => {
    const view = new HelpView();
    view.show();
    return { root: capturedRoot('helpView'), close: () => view.hide(), reopen: () => view.show() };
  },
  menuView: () => {
    const view = new MenuView({ onInput: noop });
    view.show();
    return { root: capturedRoot('menuView'), close: () => view.hide(), reopen: () => view.show() };
  },
  claimView: () => {
    const view = new ClaimView({
      onSignIn: noop,
      onJoin: noop,
      onDeclineRequested: noop,
      onDeclineConfirmed: noop,
      onDeclineCancelled: noop,
    });
    view.show();
    return { root: capturedRoot('claimView'), close: () => view.hide(), reopen: () => view.show() };
  },
};

/**
 * The root the view handed to `openOverlayA11y` for `id`.
 *
 * Read from the SPY rather than resolved by id, because the four `#app`-mounted overlays build
 * their root with `document.createElement` and give it no id at all — there is no other handle on
 * it from outside. The circularity that would otherwise introduce (asserting about the argument of
 * the call under test) is closed by `S10-WIRE-ROOT-IDENTITY`, which independently resolves the
 * twelve id-addressable roots and requires them to BE this element.
 */
function capturedRoot(id: OverlayId): HTMLElement {
  const calls = vi.mocked(openOverlayA11y).mock.calls.filter((c) => c[0] === id);
  if (calls.length === 0) {
    throw new Error(
      `openOverlayA11y was never called with '${id}' — the view's open path is not wired ` +
        '(A11Y-13). This is the defect, not a harness problem.',
    );
  }
  return calls[calls.length - 1][1];
}

/** The eleven static shells plus `claimView`: the roots that ARE addressable by id. */
const ROOT_IDS: Partial<Record<OverlayId, string>> = {
  dialogueView: 'dialogue-overlay',
  questLogView: 'quest-log-overlay',
  healView: 'heal-overlay',
  shopView: 'shop-overlay',
  tradeView: 'trade-overlay',
  pvpView: 'pvp-challenge-overlay',
  leaderboardView: 'leaderboard-overlay',
  renameView: 'rename-overlay',
  tradeProposeView: 'tradepropose-overlay',
  helpView: 'help-overlay',
  menuView: 'menu-overlay',
  claimView: 'claim-overlay',
};

function installSentinel(): HTMLElement {
  const sentinel = document.createElement('button');
  sentinel.id = SENTINEL_ID;
  sentinel.type = 'button';
  sentinel.textContent = 'sentinel';
  document.body.appendChild(sentinel);
  sentinel.focus();
  return sentinel;
}

// `overlayA11y.ts` holds ONE module-private Map and exports no reset hook (a zero-consumer export
// is banned by that family's rule), so the isolation device is the PRODUCTION close for every id
// plus one real macrotask — legal because close-without-open is a documented no-op
// (`overlayA11y.ts:41-45`). It also cancels any deferred-focus timer a previous test scheduled.
beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.replaceChildren();
  adoptRealIndexHtml();
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.replaceChildren();
});

// RB37-SEQUENTIAL-RATIONALE (slice rb-37, residual R-rb18-CONCURRENT). This suite is pinned
// SERIAL, and the annotation below is load-bearing rather than stylistic. DO NOT "clean it up".
//
// WHAT WAS MEASURED. At origin/master@318eb70, before this annotation existed,
// `vitest run src/ui/overlayA11yWiring.test.ts --sequence.concurrent` reported
// `76 failed | 40 passed (116)`. The rb-18 verifier measured the same 76/40 on its own branch and
// 43/41 on master, i.e. the same root cause from a different interleaving: this is a PRE-EXISTING
// file-wide property, not something any one slice introduced. With the annotation the file is
// 116/116 in all four sequence modes — default, `--sequence.shuffle`, `--sequence.concurrent`, and
// both together. `vite.config.ts` enables neither flag, which is why `just ci` never saw it.
//
// WHY SERIAL RATHER THAN REAL ISOLATION. Four pieces of mutable state are shared by all 116 tests,
// and NO vitest API can fork any of them per test:
//   * ONE happy-dom `document`. The environment is installed per test FILE, not per test, and
//     `installSentinel`, `adoptRealIndexHtml` and every `document.activeElement` oracle read it.
//   * The module-scope `beforeEach`/`afterEach` directly above, which `replaceChildren()` the body,
//     re-adopt `client/index.html`, and `vi.clearAllMocks()`.
//   * ONE spy per module registry, from `vi.mock('./overlayA11y', { spy: true })` above;
//     `vi.clearAllMocks()` is process-global and most teeth here read `mock.calls.length`.
//   * `overlayA11y.ts`'s module-private OPEN_OVERLAYS map, which exports no reset hook — a
//     zero-consumer export is banned by that family's rule, as the hook comment above records.
// Every test awaits at least one REAL macrotask (`flushMacrotask`), so under concurrency test B's
// `beforeEach` wipes test A's DOM and mock record mid-flight. Genuine per-test isolation would mean
// constructing a happy-dom Window per test and injecting `document` into all sixteen view classes
// plus overlayA11y/focusTrap/liveRegion — a production refactor of the whole overlay family, which
// is not something a one-spec-file residual slice gets to do. The residual's own text authorises
// the serial route "with a documented reason"; this block is that reason.
//
// A `vite.config.ts` SETTING CANNOT SUBSTITUTE: the criterion is the CLI flag, and the CLI flag
// overrides config. Moving this into the runner config would satisfy nobody and gate nothing.
//
// IF YOU DELETE THIS: `RB37-CONCURRENT-SAFE` and `RB37-RATIONALE-DURABLE` in the sibling
// `overlayA11yWiring.concurrency.test.ts` both red — the first spawns a child vitest carrying the
// flag, the second pins this marker and this block's content. If you ever make the file genuinely
// per-test-isolated, delete the annotation AND that spec in the same commit.
describe.sequential('m23-s10 / A11Y-13,14,16 — the cross-view overlay-a11y wiring spec', () => {
  it('S10-WIRE-TOTALITY BITES: the opener table covers EVERY OverlayId and nothing else, and the manifest is the real sixteen', () => {
    // Compile-time totality is the primary device (Record<OverlayId, _>); these are the runtime
    // belts, so an `as` cast or a `@ts-expect-error` cannot quietly shrink the parameterisation.
    expect(OVERLAY_IDS.length, 'the manifest must hold sixteen mutual-exclusion overlays').toBe(16);
    expect(Object.keys(OPENERS).sort()).toEqual([...OVERLAY_IDS].sort());
    expect(Object.keys(OVERLAY_A11Y).sort()).toEqual([...OVERLAY_IDS].sort());

    // The unstated PREMISE of S10-WIRE-OPEN-ARIA's copy-paste kill: a wrong OverlayId is only
    // detectable through `aria-label` if the sixteen resolved NAMES are distinct. The delegated
    // `A11YCOPY-OVERLAY-NAMESPACE-EXACT` pins KEY set-equality, not VALUE distinctness, so nothing
    // asserted this before.
    const names = OVERLAY_IDS.map((id) => t(OVERLAY_A11Y[id].labelKey));
    expect(new Set(names).size, 'the sixteen accessible names must be pairwise distinct').toBe(16);

    // rb-18: SHAPE totality, not just KEY totality. `Opened.reopen` is what makes the repeat and
    // reopen-after-close teeth possible, and since this file is not typechecked in CI (see the
    // header correction) a `reopen`-less opener is a RUNTIME question. Asserted here, over every
    // id, so a seventeenth overlay cannot ship an opener that satisfies the key set while handing
    // back nothing to re-open — which is exactly how the guarantee would drift back to resting on
    // sixteen separately-maintained per-view specs.
    for (const id of OVERLAY_IDS) {
      const opened = OPENERS[id]();
      expect(
        Object.keys(opened).sort(),
        `${id}: every opener must hand back root + close + reopen`,
      ).toEqual(['close', 'reopen', 'root']);
      expect(typeof opened.reopen, `${id}: reopen must be callable`).toBe('function');
      expect(typeof opened.close, `${id}: close must be callable`).toBe('function');
      opened.close();
    }
  });

  it('S10-WIRE-REAL-INDEX-HTML BITES: the fixture is the SHIPPED client/index.html, tabindex attributes included — never a hand-copied shell', () => {
    // The whole point of adopting the real file. A per-view byte-copy fixture keeps passing when
    // the shipped markup loses an attribute; this assertion is what makes that deletion red.
    expect(document.body.children.length).toBeGreaterThan(5);
    expect(document.getElementById('a11y-live')).not.toBeNull();
    expect(document.getElementById('app')).not.toBeNull();

    // Every id-addressable anchor named by the manifest resolves in the SHIPPED markup, and each
    // one is focusable by ADR-0205 D1's amended criterion.
    let checkedAnchors = 0;
    for (const id of OVERLAY_IDS) {
      const rootId = ROOT_IDS[id];
      if (rootId === undefined || id === 'claimView') continue; // claim's shell is JS-created
      const root = requireElement(rootId);
      const anchor = root.querySelector(OVERLAY_A11Y[id].initialFocusSelector);
      expect(
        anchor,
        `${id}: '${OVERLAY_A11Y[id].initialFocusSelector}' must resolve inside #${rootId} in the SHIPPED index.html`,
      ).not.toBeNull();
      expect(
        isFocusableByContract(anchor as Element),
        `${id}: the shipped anchor is not focusable — ADR-0205 D1 requires a native control or an explicit integer tabindex`,
      ).toBe(true);
      checkedAnchors++;
    }
    expect(checkedAnchors, 'eleven static shells must have been checked').toBe(11);
  });

  it('S10-WIRE-VACUITY-CONTROL BITES: the weak oracle §5.5 warns about passes on a decorative wrapper, and each of the four conjuncts that replaces it rejects it', () => {
    // The stated attack, EXECUTED rather than narrated. A decorative <div> with no tabindex, and a
    // shell carrying role/aria-modal as static markup — exactly what index.html ships.
    const root = document.createElement('div');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    const wrapper = document.createElement('div');
    wrapper.id = 'decorative-wrapper';
    root.appendChild(wrapper);
    document.body.appendChild(root);
    wrapper.focus();

    // (i) the containment oracle PASSES on the attack — this is why it is not used.
    expect(root.contains(document.activeElement)).toBe(true);
    // (ii) identity rejects it: the manifest anchor is not what is focused.
    expect(document.activeElement === root.querySelector('#nonexistent-anchor')).toBe(false);
    // (iii) focusability-by-contract rejects the wrapper outright.
    expect(isFocusableByContract(wrapper)).toBe(false);
    // (iv) the static-markup attributes are already present with NO wiring having run, which is
    //      why `aria-label` (absent here, and absent everywhere in index.html) is the value oracle.
    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.getAttribute('aria-label')).toBeNull();
  });

  it('S10-WIRE-STATIC-MARKUP-CONTROL BITES: on the SHIPPED shells, role and aria-modal read correct BEFORE anything is opened — so asserting them alone proves nothing', () => {
    // No view is constructed in this test. If these pass, §5.5's two stated open-side assertions
    // are satisfied by markup alone for eleven of sixteen ids.
    const shell = requireElement('dialogue-overlay');
    expect(shell.getAttribute('role')).toBe(OVERLAY_A11Y.dialogueView.role);
    expect(shell.getAttribute('aria-modal')).toBe('true');
    expect(shell.getAttribute('aria-label')).toBeNull();
    expect(vi.mocked(openOverlayA11y)).not.toHaveBeenCalled();
  });

  let checked = 0;
  let repeatChecked = 0;
  let reopenChecked = 0;

  for (const id of OVERLAY_IDS) {
    const meta = OVERLAY_A11Y[id];

    describe(`${id}`, () => {
      it(`S10-WIRE-MECHANISM:${id} BITES: opening calls openOverlayA11y exactly once, with THIS id — a hand-written attribute cheat reds here`, () => {
        installSentinel();
        OPENERS[id]();
        const calls = vi.mocked(openOverlayA11y).mock.calls;
        expect(calls.length, `${id}: the open path must invoke the helper exactly once`).toBe(1);
        expect(calls[0][0], `${id}: a copy-pasted OverlayId would show up here`).toBe(id);
        expect(calls[0][1], `${id}: the helper must be handed a live element`).toBeInstanceOf(
          HTMLElement,
        );
        expect(calls[0][1].isConnected).toBe(true);
      });

      it(`S10-WIRE-OPEN-ARIA:${id} BITES: the root is labelled from the OVERLAY_A11Y table via the copy catalog, and role/aria-modal agree with it`, () => {
        installSentinel();
        const { root } = OPENERS[id]();

        // THE LOAD-BEARING ASSERTION. index.html ships zero aria-label attributes, so this one
        // exists only because overlayA11y.ts:108 ran; and all sixteen catalog values are distinct,
        // so a wrong id would land the wrong name here.
        expect(
          root.getAttribute('aria-label'),
          `${id}: aria-label must be resolved from the copy catalog, never a literal`,
        ).toBe(t(meta.labelKey));

        // Asserted only ALONGSIDE aria-label — see the header for why these two alone are vacuous.
        expect(root.getAttribute('role')).toBe(meta.role);
        expect(root.getAttribute('aria-modal')).toBe('true');
      });

      it(`S10-WIRE-ROOT-IDENTITY:${id} BITES: the element handed to the helper is the overlay's real root, not some inner node`, () => {
        installSentinel();
        const { root } = OPENERS[id]();
        const rootId = ROOT_IDS[id];
        if (rootId === undefined) {
          // The four #app-mounted overlays have no id; the checkable property is that the root is
          // a live descendant of the shared mount and is NOT the mount itself (an application role
          // on #app would swallow four dialogs — the defect world.ts:73 records).
          const app = appMount();
          expect(root).not.toBe(app);
          // `parentElement`, not `contains`: `contains` is satisfied by handing the helper an
          // INNER wrapper, which would put role/aria-modal/aria-label on the wrong node and install
          // the focus trap on a strictly smaller subtree than the overlay — green under a
          // containment check. All four constructed views append their root directly to `#app`.
          expect(root.parentElement).toBe(app);
        } else {
          expect(root).toBe(document.getElementById(rootId));
        }
        expect(root.querySelector(meta.initialFocusSelector)).not.toBeNull();
      });

      it(`S10-WIRE-FOCUS-IDENTITY:${id} BITES: one real macrotask after opening, the manifest anchor IS document.activeElement — identity, and focus demonstrably moved off a sentinel`, async () => {
        const sentinel = installSentinel();
        expect(document.activeElement, 'the sentinel must hold focus before opening').toBe(
          sentinel,
        );

        const { root } = OPENERS[id]();

        // The root must be PAINTED when the deferred focus is due. happy-dom focuses nodes inside
        // a display:none subtree; a real browser silently refuses, so an open-before-paint bug is
        // green here and broken in Chromium (battleView.ts:26 warns about exactly this).
        expect(
          root.style.display,
          `${id}: the root is still display:none when the deferred focus is due — .focus() on a ` +
            'hidden node is a silent no-op in a real browser',
        ).not.toBe('none');

        // The defer is real: synchronously, focus has NOT moved yet.
        expect(document.activeElement).toBe(sentinel);

        // ...and it is a MACROtask, not a microtask. Draining the microtask queue must not move
        // focus either: `queueMicrotask` would satisfy the synchronous check above while
        // microtasks drain BEFORE the keydown's default action, restoring the letter-hotkey
        // swallow `overlayA11y.ts:9-15` calls load-bearing.
        await Promise.resolve();
        await Promise.resolve();
        expect(
          document.activeElement,
          `${id}: focus moved on a MICROtask — the defer must outlast the opening key event`,
        ).toBe(sentinel);

        await flushMacrotask();

        const anchor = root.querySelector(meta.initialFocusSelector);
        expect(
          anchor,
          `${id}: '${meta.initialFocusSelector}' must resolve inside the root`,
        ).not.toBeNull();
        expect(
          document.activeElement,
          `${id}: focus must land ON the manifest anchor — containment is the vacuity §5.5 names`,
        ).toBe(anchor);
        expect(
          document.activeElement,
          `${id}: focus never left the sentinel, so nothing was proved`,
        ).not.toBe(sentinel);
        expect(
          isFocusableByContract(anchor as Element),
          `${id}: the anchor is neither a native control nor tabindex-focusable (ADR-0205 D1)`,
        ).toBe(true);
        checked++;
      });

      it(`S10-WIRE-REPEAT-NO-REOPEN:${id} BITES: a SECOND open on an ALREADY-visible overlay is a NO-EDGE — the helper is not called again, the manifest anchor is not rebuilt, and focus stays where the player put it`, async () => {
        // rb-18 / residual R-m23-s10-X21. The per-view idiom (`leaderboardView.test.ts:598`,
        // `dialogueView.test.ts:242`, `menuView.test.ts:1254`) lifted into the SHARED layer, where
        // the `Record<OverlayId, …>` opener table makes it total by construction. A re-open clears
        // (`overlayA11y.ts:110`) and re-schedules (`:134`) the deferred-focus timer, dragging focus off
        // whatever the player Tabbed to — INVISIBLE to every attribute assertion in this file,
        // because a re-open rewrites byte-identical values.
        const sentinel = installSentinel();
        const { root, reopen } = OPENERS[id]();
        await flushMacrotask();

        const anchor = root.querySelector(meta.initialFocusSelector);
        expect(
          anchor,
          `${id}: '${meta.initialFocusSelector}' must resolve inside the root`,
        ).not.toBeNull();
        // PRECONDITION, not decoration: without it, a view whose open path does NOTHING satisfies
        // "focus did not move" below for free.
        expect(
          document.activeElement,
          `${id}: the FIRST open must have landed focus on the anchor before a repeat can be judged`,
        ).toBe(anchor);
        expect(document.activeElement, `${id}: focus never left the sentinel`).not.toBe(sentinel);

        // Parked as a DIRECT CHILD of the root, never deeper. The three render-edge views empty a
        // SUB-container on every repeat render (`questLogView.ts:42` and `healView.ts:43` clear
        // their <ul>'s contents, `dialogueView.ts:57` replaceChildren()s its choices container).
        // Those containers are CHILDREN of the root, hence SIBLINGS of the parked node, and each
        // clears its OWN contents — so a direct child of the root survives. Parking it inside
        // one of them would FALSE-RED on three ids, and the tempting "fix" for that false red is to
        // weaken the identity assertion below to containment, which is the exact vacuity this
        // file's header rejects at the (c) conjunct.
        const parked = document.createElement('button');
        parked.type = 'button';
        parked.textContent = 'parked-inside';
        root.appendChild(parked);
        parked.focus();
        expect(
          parked,
          `${id}: the parked node must not BE the anchor, or "focus stayed put" and "focus was ` +
            'yanked back" become the same assertion',
        ).not.toBe(anchor);
        expect(document.activeElement, `${id}: precondition — the parked node holds focus`).toBe(
          parked,
        );

        reopen();
        await flushMacrotask();

        // MECHANISM, in both polarities. The filtered count is the direct statement of the guard;
        // the UNFILTERED one additionally kills a repeat branch that opens a DIFFERENT id, which
        // the filtered count alone reads as 1 (red-team MEASURED both).
        expect(
          vi.mocked(openOverlayA11y).mock.calls.filter((c) => c[0] === id).length,
          `${id}: a repeat open on an already-visible overlay must NOT re-invoke the helper — ` +
            'this is the `if (!wasVisible)` guard, and deleting it reds exactly here',
        ).toBe(1);
        expect(
          vi.mocked(openOverlayA11y).mock.calls.length,
          `${id}: the repeat must not open some OTHER overlay either`,
        ).toBe(1);

        // Asserted BEFORE the focus identity purely for the failure message: if a future repeat
        // path ever rebuilds the root's children, `activeElement` becomes <body> and the identity
        // assertion below reds for a reason that reads like a focus regression. This one says what
        // actually happened.
        expect(
          parked.isConnected,
          `${id}: the repeat destroyed a direct child of the root — this is a rebuild, not a ` +
            'focus bug; do NOT weaken the assertion below to containment',
        ).toBe(true);
        expect(
          document.activeElement,
          `${id}: a repeat open must NOT re-run the deferred initial focus (A11Y-14)`,
        ).toBe(parked);

        // The cross-view-only conjunct: no per-view spec asserts anchor-node IDENTITY across a
        // repeat. A repeat that rebuilds the anchor detaches the node the manifest names, so the
        // guard stops mattering and production drops focus to <body> — while the assertion above
        // still passes. Pins `overlayRegistry.ts:152`'s "STABLE, CONSTRUCTOR-TIME ANCHOR" contract
        // for all sixteen ids at once.
        expect(
          root.querySelector(meta.initialFocusSelector),
          `${id}: the repeat rebuilt the manifest anchor node`,
        ).toBe(anchor);

        // LAST STATEMENT, always: an increment above a surviving assertion would let the afterAll
        // floor read 16 while the oracles it stands for never ran.
        repeatChecked++;
      });

      it(`S10-WIRE-REOPEN-AFTER-CLOSE:${id} BITES: after closing, opening AGAIN is a REAL edge — the helper fires a second time and the deferred focus is re-armed`, async () => {
        // THE MIRROR POLARITY, and it is not symmetry-for-its-own-sake: red-team MEASURED that a
        // sticky "have I ever opened" latch —
        //     `#everOpened = false; … const wasVisible = this.#everOpened; this.#everOpened = true;`
        // — is INDISTINGUISHABLE from the correct live-state read to every assertion in the test
        // above, passes that view's own full spec, and leaves the overlay permanently unannounced,
        // untrapped and unfocused for the rest of the instance's life after the first close.
        // TWELVE of the sixteen per-view specs have no reopen-after-close coverage at all, so this
        // is the one place the class is closed for every id. Only a scenario that CLOSES first can
        // force `wasVisible` to be read from live state rather than from a one-shot latch.
        const sentinel = installSentinel();
        const first = OPENERS[id]();
        await flushMacrotask();
        expect(document.activeElement, `${id}: precondition — the first open landed`).not.toBe(
          sentinel,
        );

        first.close();
        expect(
          document.activeElement,
          `${id}: precondition — closing returned focus to the sentinel (A11Y-16)`,
        ).toBe(sentinel);

        first.reopen();

        expect(
          vi.mocked(openOverlayA11y).mock.calls.filter((c) => c[0] === id).length,
          `${id}: re-opening after a close MUST call the helper again — a guard that reads a ` +
            'latch instead of live visibility passes every same-session assertion while leaving ' +
            'the overlay permanently unlabelled, untrapped and unfocused',
        ).toBe(2);
        expect(
          vi.mocked(openOverlayA11y).mock.calls[1][1],
          `${id}: the second open must be handed the same live root`,
        ).toBe(first.root);

        // Effects, not just the call: the ARIA the close stripped is back, and the deferred focus
        // is genuinely RE-ARMED rather than a call whose scheduled work was cancelled.
        expect(
          first.root.getAttribute('aria-label'),
          `${id}: the re-open must re-apply the accessible name the close stripped`,
        ).toBe(t(meta.labelKey));
        await flushMacrotask();
        expect(
          document.activeElement,
          `${id}: the re-open must re-arm the deferred initial focus onto the manifest anchor`,
        ).toBe(first.root.querySelector(meta.initialFocusSelector));

        reopenChecked++;
      });

      it(`S10-WIRE-CLOSE-RESTORE:${id} BITES: closing strips ALL THREE ARIA attributes and hands focus back to where it was — absence is impossible without the wiring`, async () => {
        const sentinel = installSentinel();
        const { root, close } = OPENERS[id]();
        await flushMacrotask();
        expect(document.activeElement).not.toBe(sentinel);

        const closesBefore = vi
          .mocked(closeOverlayA11y)
          .mock.calls.filter((c) => c[0] === id).length;
        close();

        // The MECHANISM mirror of the open side. Without it this test asserts EFFECTS only, and a
        // guarded close that skips the helper was measured (m23-s3 red-team) to ship 62/62 green
        // while permanently leaking a capture listener, a pending timer and a stale return target.
        expect(
          vi.mocked(closeOverlayA11y).mock.calls.filter((c) => c[0] === id).length - closesBefore,
          `${id}: the close path must invoke closeOverlayA11y exactly once for this id`,
        ).toBe(1);

        // REMOVAL is the anti-vacuity partner of the open-side value oracle: role and aria-modal
        // are free from the static markup, but only closeOverlayA11y (overlayA11y.ts:142-144) can
        // take them away.
        expect(root.getAttribute('aria-label'), `${id}: aria-label must be stripped`).toBeNull();
        expect(root.getAttribute('aria-modal'), `${id}: aria-modal must be stripped`).toBeNull();
        expect(root.getAttribute('role'), `${id}: role must be stripped`).toBeNull();
        expect(
          document.activeElement,
          `${id}: focus must return to the element focused immediately before opening (A11Y-16)`,
        ).toBe(sentinel);
      });
    });
  }

  // THE COVERAGE FLOOR, in `afterAll` rather than a trailing `it`. A `for` loop over an empty
  // array is the classic silent pass, and `checked` is the belt that makes it loud — but as a
  // trailing test it was ORDER-DEPENDENT: measured, `--sequence.shuffle` moved it ahead of the
  // per-id blocks and produced a FALSE RED in 2 of 3 runs. `vite.config.ts` does not enable
  // shuffling, so `just ci` never saw it; `afterAll` runs after every test in the file whatever
  // the order, so the belt survives a future config change instead of becoming a flake.
  // (The primary devices remain S10-WIRE-TOTALITY's compile-time `Record<OverlayId, …>` and its
  // runtime key-set equality; this only catches a loop that never ran.)
  afterAll(() => {
    expect(
      checked,
      'S10-WIRE-FOCUS-IDENTITY must have executed once per OverlayId — a loop that never ran ' +
        'reports success in exactly the same way as one that passed',
    ).toBe(16);
    // Siblings, in the SAME hook rather than a second one, so the rationale above stays
    // co-located and a future reader cannot delete one half. Not redundant with the compile-time
    // `Record<OverlayId, …>` (which forces the openers to EXIST) nor with `checked` (which only
    // proves the FOCUS-IDENTITY loop ran): neither notices an `it.skip` on one id's repeat tooth,
    // and `just ci` does not run the nightly `a11y-e2e` recipe whose `numPendingTests` clause
    // would otherwise catch it.
    expect(repeatChecked, 'S10-WIRE-REPEAT-NO-REOPEN must have executed once per OverlayId').toBe(
      16,
    );
    expect(reopenChecked, 'S10-WIRE-REOPEN-AFTER-CLOSE must have executed once per OverlayId').toBe(
      16,
    );
  });
});
