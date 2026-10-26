// @vitest-environment happy-dom
// ui/overlayA11yWiring.test.ts — the CROSS-VIEW overlay-a11y wiring spec (M23 §5.5, slice m23-s10;
// criteria A11Y-13, A11Y-14, A11Y-16).
//
// WHY THIS FILE EXISTS WHEN SEVENTEEN PER-VIEW SPECS ALREADY DO. Each of those proves ONE id, from a
// hand-copied byte fixture of its own shell. Two properties are invisible to all of them together:
//
//   1. TOTALITY. Nothing asserts that EVERY `OverlayId` is wired. A seventeenth overlay, or a view
//      whose `show()` quietly stopped calling the helper, is caught by no existing test. Here the
//      opener table is `Readonly<Record<OverlayId, …>>` (`overlayRegistry.ts:76`/`:164`'s device),
//      belt-and-braced with a runtime key-set equality, a runtime SHAPE equality over what each
//      opener hands back, and a `checked === 16` counter.
//      The `Record` is checked by `just client-typecheck` (test files are typechecked), but
//      vitest transpiles without checking, so every totality claim below is ALSO carried by a
//      RUNTIME assertion — which is why `S10-WIRE-TOTALITY` pins the opener RETURN SHAPE and not
//      merely the key set.
//   2. FIXTURE FIDELITY. The per-view specs copy their shell markup into the test file, so they
//      keep passing if `client/index.html` loses a `tabindex` — the very attribute ADR-0205 D1
//      makes ten of the seventeen anchors depend on. This file adopts the REAL `client/index.html`,
//      so that deletion reds here.
//
// THE ORACLE, AND WHY IT IS NOT THE ONE §5.5 SPECIFIES. Both of §5.5's stated open-side assertions
// are VACUOUS on the shipped tree, measured:
//   * `role === OVERLAY_A11Y[id].role` and `aria-modal === 'true'` are STATIC LITERALS in
//     `client/index.html` for eleven of the seventeen roots (`:17`, `:22`, `:25`, `:29`, `:36`, `:44`,
//     `:52`, `:57`, `:64`, `:90`, `:105`), and for the other five they are echoed straight back from
//     the table the assertion reads. A view whose `show()` calls nothing passes both.
//     `helpView.test.ts:56` and `dialogueView.test.ts:23` already record this in-source.
//   * The `{BUTTON, INPUT, SELECT, A, TEXTAREA}` tag allow-list is UNSATISFIABLE: exactly FOUR of
//     seventeen anchors qualify (`#rename-input`, `#tradepropose-target`, `#claim-signin-btn` and,
//     since rb-52, `#privacy-close-btn`). The other thirteen are `<div>`/`<ul>`/`<h2>` carrying `tabindex="-1"` — the ARIA APG dialog
//     fallback the milestone DELIBERATELY ships. `docs/adr/0205:31,:50-58` amends the wording to
//     "focusable — natively, or via `tabindex`" and `:284-287` instructs this slice by name to use
//     "the identity assertion as the anti-vacuity device, not a native-tag allow-list".
//     THAT AMENDMENT IS STILL FLAGGED FOR OPERATOR SIGN-OFF; if it is rejected, S2/S4 absorb the
//     cost and `isFocusableByContract` below becomes the tag list.
//
// So the four conjuncts asserted per id are:
//   (a) VALUE — `aria-label === t(OVERLAY_A11Y[id].labelKey)`. `index.html` ships ZERO `aria-label`
//       attributes, so this one exists only if `overlayA11y.ts:108` actually ran. All seventeen
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
//       guard shipped GREEN here — MEASURED, all sixteen mutants survived. Seventeen per-view specs
//       each caught their own (also measured), but nothing in the SHARED layer did, so the
//       guarantee rested entirely on seventeen separately-maintained files staying in sync and on
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
import { DEFAULT_BINDINGS } from '../input/bindings';
import { t } from './a11yCopy';
import { BattleView } from './battleView';
import { BoxView } from './boxView';
import { ClaimView } from './claimView';
import { ControlsView } from './controlsView';
import { DialogueView } from './dialogueView';
import { EvolutionView } from './evolutionView';
import { HealView } from './healView';
import { HelpView } from './helpView';
import { LeaderboardView } from './leaderboardView';
import { MenuView } from './menuView';
import { grid as navGrid, list as navList } from './nav';
import { renderNav } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import { PrivacyView } from './privacyView';
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
 * questions. Using it here would fail thirteen of seventeen ids for the wrong reason.
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
  // stderr. The S10 teeth read no computed style, and the qf-1 describe at the bottom of this file
  // installs the real `styles.css` text as a <style> element itself, so the link is pure noise
  // here (`indexShell.smoke.test.ts` reads this file and styles.css together).
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
   * and an optional field would make seventeen silent omissions legal — reopening exactly the hole
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
 * How each of the seventeen overlays is OPENED, keyed by id.
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
 * WHICH DOOR, AND WHERE THAT IS NOT THE PRODUCTION ONE. Two entries drive a door the shipped
 * caller does not, and neither is a false pass — both views derive `visible` LIVE from the DOM
 * rather than from a latch field, so the alternative door is a behaviourally equivalent input to
 * the `wasVisible` guard these teeth exercise:
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
      partySlotNone: 255,
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
  // `main.ts`'s M12d `store.onBatchApplied` dialogue listener (`:1837-1887` today) builds a fresh
  // view model on every batch, at its `buildDialogueViewModel(...)` call (`:1850` today) — the
  // landmark is the listener, the numbers are only dated hints. But that half is DEFENSIVE, not
  // currently load-bearing: none of the three `render()` bodies compares `vm` by identity today,
  // so a reused object would behave identically.
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
    const view = new TradeProposeView({ onSubmit: noop, maxMonstersPerSide: 64 });
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
  // The privacy overlay's shell is JS-created, like claimView's.
  privacyView: () => {
    const view = new PrivacyView({
      onDeleteRequested: noop,
      onDeleteConfirmed: noop,
      onConfirmCancelled: noop,
      onCancelDeletion: noop,
      onExportRequested: noop,
      onDismissed: noop,
    } as ConstructorParameters<typeof PrivacyView>[0]);
    view.show();
    return {
      root: capturedRoot('privacyView'),
      close: () => view.hide(),
      reopen: () => view.show(),
    };
  },
  // ctl-12b (named intentional change): Options › Controls, a JS-created shell like privacyView's,
  // opened by `show()` (the door main.ts's openControls calls). Its anchor `#controls-rows` carries
  // tabindex="0" from construction, so the open needs no paint first.
  controlsView: () => {
    const view = new ControlsView({
      bindings: () => DEFAULT_BINDINGS,
      onClear: () => true,
      onReset: () => true,
      onCancelCapture: noop,
      announce: noop,
    } as ConstructorParameters<typeof ControlsView>[0]);
    view.show();
    return {
      root: capturedRoot('controlsView'),
      close: () => view.hide(),
      reopen: () => view.show(),
    };
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
    } as ConstructorParameters<typeof ClaimView>[0]);
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

/** The eleven static shells plus the three JS-created ones (`claimView`, `privacyView` and, since
 *  ctl-12b, `controlsView`): the roots that ARE addressable by id. */
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
  privacyView: 'privacy-overlay',
  controlsView: 'controls-overlay',
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

// RB37-SEQUENTIAL-RATIONALE (residual R-rb18-CONCURRENT). This suite is pinned
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
// constructing a happy-dom Window per test and injecting `document` into all seventeen view classes
// plus overlayA11y/focusTrap/liveRegion — a production refactor of the whole overlay family, which
// is not something a one-spec-file residual slice gets to do. The residual's own text authorises
// the serial route "with a documented reason"; this block is that reason.
//
// A `vite.config.ts` SETTING CANNOT SUBSTITUTE: the criterion is the CLI flag, and the CLI flag
// overrides config. Moving this into the runner config would satisfy nobody and gate nothing.
describe.sequential('m23-s10 / A11Y-13,14,16 — the cross-view overlay-a11y wiring spec', () => {
  it('S10-WIRE-TOTALITY BITES: the opener table covers EVERY OverlayId and nothing else, and the manifest is the real eighteen', () => {
    // Compile-time totality is the primary device (Record<OverlayId, _>); these are the runtime
    // belts, so an `as` cast or a `@ts-expect-error` cannot quietly shrink the parameterisation.
    // ctl-12b (named intentional change): seventeen -> eighteen, `controlsView` joined.
    expect(OVERLAY_IDS.length, 'the manifest must hold eighteen mutual-exclusion overlays').toBe(
      18,
    );
    expect(Object.keys(OPENERS).sort()).toEqual([...OVERLAY_IDS].sort());
    expect(Object.keys(OVERLAY_A11Y).sort()).toEqual([...OVERLAY_IDS].sort());

    // The unstated PREMISE of S10-WIRE-OPEN-ARIA's copy-paste kill: a wrong OverlayId is only
    // detectable through `aria-label` if the seventeen resolved NAMES are distinct. The delegated
    // `A11YCOPY-OVERLAY-NAMESPACE-EXACT` pins KEY set-equality, not VALUE distinctness, so nothing
    // asserted this before.
    const names = OVERLAY_IDS.map((id) => t(OVERLAY_A11Y[id].labelKey));
    expect(new Set(names).size, 'the eighteen accessible names must be pairwise distinct').toBe(18);

    // SHAPE totality, not just KEY totality. `Opened.reopen` is what makes the repeat and
    // reopen-after-close teeth possible, and since vitest runs without typechecking (see the
    // header) a `reopen`-less opener is also asserted at RUNTIME. Asserted here, over every
    // id, so a seventeenth overlay cannot ship an opener that satisfies the key set while handing
    // back nothing to re-open — which is exactly how the guarantee would drift back to resting on
    // seventeen separately-maintained per-view specs.
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
    // ctl-7a (named intentional change): the shipped <body> is now three direct children
    // (#game-screen, #build-stamp, #a11y-live), so the old `body.children > 5` floor is retired;
    // the vacuity guard counts the id-bearing elements the adopted body holds instead.
    expect(document.body.querySelectorAll('[id]').length).toBeGreaterThan(5);
    expect(document.getElementById('a11y-live')).not.toBeNull();
    expect(document.getElementById('app')).not.toBeNull();

    // Every id-addressable anchor named by the manifest resolves in the SHIPPED markup, and each
    // one is focusable by ADR-0205 D1's amended criterion.
    let checkedAnchors = 0;
    for (const id of OVERLAY_IDS) {
      const rootId = ROOT_IDS[id];
      // claim's, privacy's and (ctl-12b) controls' shells are JS-created, so their anchors cannot
      // resolve in the shipped markup — the eleven STATIC shells are what this clause is about.
      if (
        rootId === undefined ||
        id === 'claimView' ||
        id === 'privacyView' ||
        id === 'controlsView'
      ) {
        continue;
      }
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
    // are satisfied by markup alone for eleven of seventeen ids.
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
        // exists only because overlayA11y.ts:108 ran; and all seventeen catalog values are distinct,
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
        // for all seventeen ids at once.
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
        // TWELVE of the seventeen per-view specs have no reopen-after-close coverage at all, so this
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
        // are free from the static markup, but only closeOverlayA11y can
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
    ).toBe(18);
    // Siblings, in the SAME hook rather than a second one, so the rationale above stays
    // co-located and a future reader cannot delete one half. Not redundant with the compile-time
    // `Record<OverlayId, …>` (which forces the openers to EXIST) nor with `checked` (which only
    // proves the FOCUS-IDENTITY loop ran): neither notices an `it.skip` on one id's repeat tooth,
    // and nothing else in the run would catch it.
    expect(repeatChecked, 'S10-WIRE-REPEAT-NO-REOPEN must have executed once per OverlayId').toBe(
      18,
    );
    expect(reopenChecked, 'S10-WIRE-REOPEN-AFTER-CLOSE must have executed once per OverlayId').toBe(
      18,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// qf-1 — the FOCUS-RING POLICY (spec M-pt3-quickfix § qf-1: QF1.1, QF1.2; QF1.3 is "every tooth
// above is unchanged").
//
// WHAT IS UNDER TEST. styles.css decides what a focused element paints:
//   * QF1.1 — a programmatic-only anchor (`tabindex="-1"`: the dialog headings and status nodes the
//     overlay helper focuses on open) must paint NO focus ring; a ring on a heading that nobody
//     can Tab to is noise on every open.
//   * QF1.2 — the nav-kit container (`role="listbox" | "grid"`, the single tab stop of a screen)
//     MUST paint a ring that is visibly distinct from the `.is-active` row inside it.
//   * Everything else (native controls, the canvas `role="application" tabindex="0"`) keeps the
//     browser's own ring: no rule may match it.
//
// THE ORACLE IS happy-dom's COMPUTED STYLE over the REAL styles.css text, installed as a <style>
// element — never a text scan of the sheet (a comment or a decoy string would satisfy a scan).
// happy-dom has NO user-agent focus ring: an UNSTYLED focused element computes `outlineStyle ===
// ''`, an explicit `outline: none` computes `'none'`. That difference is the QF1.1 oracle, and it
// is why the scope teeth assert `!== 'none'` rather than `!== ''`.
//
// HAZARD (measured): happy-dom CACHES computed style per element and a focus change does NOT
// invalidate it. Every element below is therefore read EXACTLY ONCE, immediately after it is
// focused, and never before. happy-dom also matches `:focus-visible` on every focus, so this tier
// cannot tell `:focus` from `:focus-visible`; the EARS wording ("WHEN ... receives focus") is the
// reason the policy keys on `:focus`.
//
// THE ENUMERATION IS THE DOCUMENT, NOT THE ANCHOR LIST. A tooth that only looked at the eighteen
// `initialFocusSelector` anchors would pass a stylesheet that mis-paints a non-anchor node
// (`#heal-options`, a tradePropose wizard pane). `survey()` opens every overlay through the
// existing `OPENERS`, one at a time (the totality tooth's own open/close cycle — one document, one
// `#app` mount), collects every `[tabindex="-1"]`, `[role="listbox"]` and `[role="grid"]` it can
// see after each open, de-duplicates by element identity, and reads each element's ring once at
// the end, in its final state.
// ---------------------------------------------------------------------------------------------

const STYLES_CSS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css');

/** The three runtime classes every anchor falls into (see `classifyAnchor`). */
type AnchorClass = 'heading' | 'nav' | 'native';

/** What an element paints when focused: the four outline longhands plus the two properties that
 *  can hide a ring without touching `outline` (`display: contents`, `clip-path`), read once. */
interface RingFacts {
  readonly style: string;
  readonly width: string;
  readonly offset: string;
  readonly color: string;
  readonly display: string;
  readonly clipPath: string;
}

/** The `.mr-nav-row > .mr-nav-item.is-active` row: what the container ring must differ from. */
interface ActiveRowFacts {
  readonly style: string;
  readonly outlineColor: string;
  readonly background: string;
}

/** One surveyed element: its markup state at survey time and its ring when focused. */
interface SurveyedEl {
  readonly el: HTMLElement;
  readonly label: string;
  readonly tabindex: string | null;
  readonly role: string | null;
  /** null when `.focus()` did not make it `document.activeElement` (not a focus target). */
  readonly ring: RingFacts | null;
}

interface Survey {
  readonly elements: readonly SurveyedEl[];
  readonly anchors: ReadonlyMap<OverlayId, SurveyedEl>;
}

/** The sweep: everything the focus policy's selectors could possibly match. */
const SWEEP_SELECTOR = '[tabindex="-1"], [role="listbox"], [role="grid"]';

/**
 * Roles that make an element something a player ACTS on. A `tabindex="-1"` element carrying one is
 * interactive-but-unreachable-by-Tab, and the blanket `[tabindex="-1"]:focus { outline: none }`
 * would strip the only cue it has. `listbox` / `grid` are deliberately absent: those are the
 * containers QF1.2 re-rings.
 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'combobox',
  'gridcell',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/**
 * The anchor's class from its LIVE state: a listbox/grid role makes it a nav container (even at
 * `tabindex="-1"` — `#quest-log-list`), else `tabindex="-1"` makes it a programmatic-only heading,
 * else a native control. THROWS on anything else, so a fourth runtime shape cannot hide: the
 * three classes must partition `OVERLAY_IDS`.
 */
function classifyAnchor(el: Element): AnchorClass {
  const role = el.getAttribute('role');
  if (role === 'listbox' || role === 'grid') return 'nav';
  if (el.getAttribute('tabindex') === '-1') return 'heading';
  // The browser paints a native control's own ring, so no rule may suppress it.
  if (NATIVE_FOCUSABLE_TAGS.has(el.tagName)) return 'native';
  throw new Error(
    `unclassified anchor <${el.tagName.toLowerCase()} id="${el.id}" role="${role ?? ''}" ` +
      `tabindex="${el.getAttribute('tabindex') ?? ''}">: not a listbox/grid, not tabindex=-1, ` +
      'not a native control',
  );
}

function hasInteractiveRole(el: Element): boolean {
  const roles = (el.getAttribute('role') ?? '').toLowerCase().split(/\s+/);
  return roles.some((r) => INTERACTIVE_ROLES.has(r));
}

function describeEl(el: Element): string {
  const id = el.id === '' ? '' : `#${el.id}`;
  const role = el.getAttribute('role');
  const tabindex = el.getAttribute('tabindex');
  return (
    `<${el.tagName.toLowerCase()}${id}` +
    `${role === null ? '' : ` role=${role}`}${tabindex === null ? '' : ` tabindex=${tabindex}`}>`
  );
}

/**
 * Focus `el` and read its outline ONCE. Null when focus did not land on it. The read is the first
 * `getComputedStyle` call on this element in the test (happy-dom caches per element and a later
 * focus change does not invalidate the cache).
 */
function focusAndReadRing(el: HTMLElement): RingFacts | null {
  el.focus();
  if (document.activeElement !== el) return null;
  const cs = getComputedStyle(el);
  return {
    style: cs.outlineStyle,
    width: cs.outlineWidth,
    offset: cs.outlineOffset || cs.getPropertyValue('outline-offset'),
    color: cs.outlineColor,
    display: cs.display,
    clipPath: cs.clipPath || cs.getPropertyValue('clip-path'),
  };
}

/** A `var(--x)` left unresolved by the engine is looked up on `:root`; anything else passes. */
function resolveVars(raw: string): string {
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw.trim());
  if (m === null) return raw;
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
}

/**
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)`, `rgba(...)` and `rgb(r g b / a)` ->
 * [r, g, b]. THROWS on an unreadable form AND on any alpha below 1: a translucent ring
 * (`rgba(204, 85, 0, 0)`) passes every other check and paints nothing, and compositing it would
 * need a backdrop this tier does not have.
 */
function parseRgb(raw: string): readonly [number, number, number] {
  const s = resolveVars(raw).trim().toLowerCase();
  const rejectTranslucent = (alpha: number): void => {
    if (!(alpha >= 1)) throw new Error(`translucent computed colour ${JSON.stringify(raw)}`);
  };
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  const digits = hex?.[1];
  if (digits !== undefined) {
    const full = digits.length <= 4 ? [...digits].map((c) => c + c).join('') : digits;
    if (full.length === 8) rejectTranslucent(Number.parseInt(full.slice(6, 8), 16) / 255);
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ];
  }
  const num = '(\\d+(?:\\.\\d+)?)';
  const fn = new RegExp(
    `^rgba?\\(\\s*${num}[\\s,]+${num}[\\s,]+${num}(?:\\s*[,/]\\s*(\\d*\\.?\\d+)(%?))?\\s*\\)$`,
  ).exec(s);
  if (fn !== null) {
    if (fn[4] !== undefined) {
      rejectTranslucent(fn[5] === '%' ? Number(fn[4]) / 100 : Number(fn[4]));
    }
    return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  }
  throw new Error(`unparseable computed colour ${JSON.stringify(raw)}`);
}

/** WCAG 2.x relative luminance. */
function relativeLuminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two computed colour strings (1..21). */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseRgb(a));
  const lb = relativeLuminance(parseRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Build and read the `.mr-nav-row > .mr-nav-item.is-active` probe. Never focused, read once.
 * Appended to <body>, which the module-level hooks wipe.
 */
function readActiveRowProbe(): ActiveRowFacts {
  const row = document.createElement('div');
  row.className = 'mr-nav-row';
  const item = document.createElement('div');
  item.className = 'mr-nav-item is-active';
  row.appendChild(item);
  document.body.appendChild(row);
  const cs = getComputedStyle(item);
  return {
    style: cs.outlineStyle,
    outlineColor: resolveVars(cs.outlineColor),
    background: resolveVars(cs.backgroundColor),
  };
}

/**
 * A computed length in whole `px` ("2px", "-2px", "0px") as a number; NaN for any other unit or
 * keyword. Strict on purpose: a width of `2em` or a unitless value is not what the ring contract
 * pins, and `parseFloat` would read "2em" as 2.
 */
function pxLength(raw: string): number {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(raw.trim());
  return m === null ? Number.NaN : Number(m[1]);
}

/**
 * Every way a focused container's ring can fail QF1.2, as human-readable problems ([] = the ring
 * is a dashed/dotted line 2-4px thick, sits INSIDE its box by no more than twice its width, is
 * visually distinct from the active row, is opaque and legible against BOTH the row's fill and the
 * row's own inset outline — WCAG 1.4.11's 3:1 — and the container is neither `display: contents`
 * (no box, no outline) nor clipped away).
 */
function ringProblems(ring: RingFacts | null, probe: ActiveRowFacts): string[] {
  if (ring === null) return ['the element could not take focus'];
  const problems: string[] = [];
  // An allow-list, not a deny-list: `double` at 2px renders as a solid line (the active row's
  // look), `groove` / `ridge` as a bevelled one, `inset` / `outset` as a shaded solid.
  if (!['dashed', 'dotted'].includes(ring.style)) {
    problems.push(`outline-style ${JSON.stringify(ring.style)} is not dashed or dotted`);
  }
  if (ring.style === probe.style) {
    problems.push(`outline-style ${ring.style} is the same as the is-active row's`);
  }
  const width = pxLength(ring.width);
  if (!(width >= 2 && width <= 4)) {
    problems.push(`outline-width ${JSON.stringify(ring.width)} is not 2px-4px`);
  }
  // Negative (a zero or positive offset is clipped by .mr-shell, which scrolls and clips its
  // overflow) but not so negative the ring leaves the box it frames (-1000px).
  const offset = pxLength(ring.offset);
  if (!(offset < 0 && offset >= -2 * width)) {
    problems.push(
      `outline-offset ${JSON.stringify(ring.offset)} is outside [-2*width, 0): clipped or off-box`,
    );
  }
  if (ring.display === 'contents') {
    problems.push('display: contents gives the container no box, so no outline paints');
  }
  if (ring.clipPath !== '' && ring.clipPath !== 'none') {
    problems.push(`clip-path ${JSON.stringify(ring.clipPath)} can clip the ring away`);
  }
  for (const [name, against] of [
    ['active-row fill', probe.background],
    ['active-row outline', probe.outlineColor],
  ] as const) {
    try {
      const ratio = contrastRatio(ring.color, against);
      if (ratio < 3) {
        problems.push(
          `ring ${ring.color} vs ${name} ${against} is ${ratio.toFixed(2)}:1, under 3:1`,
        );
      }
    } catch (e) {
      problems.push(`${name}: ${(e as Error).message}`);
    }
  }
  return problems;
}

/** `<div role="dialog">` wrapper in <body> that a synthetic element is built inside. */
function dialogWrapper(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('role', 'dialog');
  document.body.appendChild(wrapper);
  return wrapper;
}

function anchorFor(survey: Survey, id: OverlayId): SurveyedEl {
  const found = survey.anchors.get(id);
  if (found === undefined) throw new Error(`${id}: no surveyed anchor`);
  return found;
}

/**
 * Open every overlay (one at a time, closing each), then read every focus-policy-relevant element
 * once. See the block header for why the enumeration is the document and not the anchor list.
 */
async function survey(): Promise<Survey> {
  const sentinel = installSentinel();
  const targets = new Set<HTMLElement>();
  const anchorEls = new Map<OverlayId, HTMLElement>();
  /** Elements whose state does not survive their overlay's close: read at their open instead. */
  const preRead = new Map<HTMLElement, SurveyedEl>();
  for (const id of OVERLAY_IDS) {
    const opened = OPENERS[id]();
    // PRODUCTION RENDERS BEFORE THE DEFERRED FOCUS. The S10 OPENERS call `show()` alone, so the
    // two nav-container anchors have no role yet when focus lands. In production main.ts's
    // `openMenu` runs `renderMenu(); menuView?.show();` and its `openControls` seats the controls
    // frame so its rows paint at the open: the role is present at focus time. Reproduce that order with the REAL `renderNav` on the anchor container, after
    // the opener and BEFORE the macrotask flush, so the survey sees the production-state anchor
    // (a role-less tabindex=0 container is deliberately NOT accepted by `classifyAnchor`).
    if (id === 'menuView' || id === 'controlsView') {
      const container = opened.root.querySelector<HTMLElement>(
        OVERLAY_A11Y[id].initialFocusSelector,
      );
      if (container === null) throw new Error(`${id}: the nav container anchor is missing`);
      renderNav(
        container,
        navList([{ key: 'a', enabled: true }]),
        { tab: null, item: 'a', perTab: {} },
        {
          frame: id === 'menuView' ? 'menu' : 'controls',
          fill: (el, item) => {
            el.textContent = item.key;
          },
        },
      );
    }
    await flushMacrotask();
    const anchor = opened.root.querySelector(OVERLAY_A11Y[id].initialFocusSelector);
    if (!(anchor instanceof HTMLElement) || document.activeElement !== anchor) {
      throw new Error(`${id}: the manifest anchor is not document.activeElement after opening`);
    }
    anchorEls.set(id, anchor);
    targets.add(anchor);
    if (id === 'leaderboardView') {
      // THE POPULATED RANKINGS STATE. `#leaderboard-list` is a plain `<ul>` until the Social
      // screen paints Rankings over a populated board: leaderboardView's `#apply` then writes
      // role=listbox + tabindex=0 on it (and ONLY then — an empty board stays a plain list). A
      // survey that never reached this state would never see the list as a nav container, so
      // `#leaderboard-list:focus { outline: none }` would ship green. A second instance over the
      // same DOM drives the REAL public API (`render` then `paintSocial`; the overlay is visible,
      // so the paint is kept). Closing the first instance later runs its `#drop`, which strips
      // these marks again, so the list is focused and read NOW, once, and phase 2 reuses it.
      const board = new LeaderboardView();
      const row = (identityHex: string, displayName: string, rating: number) => ({
        identityHex,
        displayName,
        rating,
        wins: 3,
        losses: 1,
        isOwn: false,
      });
      board.render({ rows: [row('aa11', 'Ann', 1300), row('bb22', 'Bob', 1200)], isEmpty: false });
      board.paintSocial({ tab: 'rankings', players: [], cursor: null, walkUp: null });
      const list = requireElement('leaderboard-list');
      if (list.getAttribute('role') !== 'listbox' || list.getAttribute('tabindex') !== '0') {
        throw new Error(
          'leaderboardView: a populated Rankings paint did not make the list a listbox',
        );
      }
      preRead.set(list, {
        el: list,
        label: describeEl(list),
        tabindex: list.getAttribute('tabindex'),
        role: list.getAttribute('role'),
        ring: focusAndReadRing(list),
      });
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SWEEP_SELECTOR))) {
      targets.add(el);
    }
    opened.close();
    if (document.activeElement !== sentinel) {
      throw new Error(`${id}: closing did not return focus to the sentinel`);
    }
  }
  for (const [id, anchor] of anchorEls) {
    if (!anchor.isConnected) throw new Error(`${id}: the anchor was detached before it was read`);
  }
  const elements: SurveyedEl[] = [];
  const byEl = new Map<HTMLElement, SurveyedEl>();
  for (const el of targets) {
    if (!el.isConnected) continue;
    const early = preRead.get(el);
    if (early !== undefined) {
      elements.push(early);
      byEl.set(el, early);
      continue;
    }
    // Markup state first (focus does not change it), then the single computed-style read.
    const record: SurveyedEl = {
      el,
      label: describeEl(el),
      tabindex: el.getAttribute('tabindex'),
      role: el.getAttribute('role'),
      ring: focusAndReadRing(el),
    };
    elements.push(record);
    byEl.set(el, record);
  }
  const anchors = new Map<OverlayId, SurveyedEl>();
  for (const [id, el] of anchorEls) {
    const record = byEl.get(el);
    if (record === undefined) throw new Error(`${id}: the anchor was not surveyed`);
    anchors.set(id, record);
  }
  return { elements, anchors };
}

describe.sequential('qf-1 focus-ring policy (QF1.1, QF1.2)', () => {
  const stylesCss = readFileSync(STYLES_CSS_PATH, 'utf8');
  let sheet: HTMLStyleElement | null = null;

  // The REAL styles.css text as a <style> in <head>, after the module-level hook has adopted the
  // real index.html (which has had its <link rel=stylesheet> stripped). Removed after each test.
  beforeEach(() => {
    sheet = document.createElement('style');
    sheet.textContent = stylesCss;
    document.head.appendChild(sheet);
  });
  afterEach(() => {
    sheet?.remove();
    sheet = null;
  });

  it('QF1-SANITY-SHEET-LOADED BITES: the injected styles.css is parsed and applied — a probe active nav row computes a solid outline, so every other tooth is non-vacuous', () => {
    // WRONG IMPL KILLED: a harness whose <style> install is a no-op (or a styles.css happy-dom
    // refuses to parse). Without this every "computes none" tooth below could be read as
    // "nothing parsed" and every "!== none" scope tooth would pass for free.
    const probe = readActiveRowProbe();
    expect(probe.style, 'the sheet was not parsed: .mr-nav-item.is-active has no outline').toBe(
      'solid',
    );
    // The contrast teeth parse these two computed strings; if happy-dom hands back a form the
    // parser cannot read (an unresolved var(), a named colour), fail HERE, loudly, rather than as
    // an unparseable-colour problem inside a ring tooth.
    const fill = parseRgb(probe.background);
    const outline = parseRgb(probe.outlineColor);
    expect(fill, 'the is-active fill and outline must be different colours').not.toEqual(outline);
  });

  it('QF1-1-HEADING-ROSTER BITES: the live anchor classes include boxView and raisingView as headings, menuView as a nav container and the four native controls — a reclassification reds', async () => {
    // WRONG IMPL KILLED: a retype that quietly moves an anchor out of the class its paint rule is
    // written for (e.g. a heading given a listbox role, or a native control given tabindex=-1),
    // which would leave the QF1.1 / QF1.2 teeth below iterating a list that no longer holds it.
    // Must-include members, not an exact id list: a new heading-class overlay must not need this
    // file edited, a removed one must not be silently tolerated.
    const s = await survey();
    const classOf = (id: OverlayId): AnchorClass => classifyAnchor(anchorFor(s, id).el);
    expect(classOf('boxView')).toBe('heading');
    expect(classOf('raisingView')).toBe('heading');
    expect(classOf('menuView')).toBe('nav');
    expect(classOf('questLogView')).toBe('nav');
    expect(classOf('renameView')).toBe('native');
    expect(classOf('tradeProposeView')).toBe('native');
    expect(classOf('claimView')).toBe('native');
    expect(classOf('privacyView')).toBe('native');
  });

  it('QF1-1-TABINDEX-MINUS-ONE-NO-RING BITES: EVERY focused [tabindex="-1"] element that is not a listbox/grid — anchor or not — computes outline-style none', async () => {
    // WRONG IMPL KILLED: (1) no suppression rule at all (the shipped state: every heading anchor
    // computes ''), (2) a suppression keyed to the anchors only — `[data-testid$="-title"]`,
    // `.mr-frame-title`, an id list — which leaves the non-anchor tabindex=-1 panes
    // (tradePropose's wizard panes) ringed, (3) a rule covering only the static index.html
    // shells and not the TS-constructed headings (boxView / raisingView / battleView /
    // evolutionView titles).
    const s = await survey();
    const targets = s.elements.filter(
      (e) => e.tabindex === '-1' && e.role !== 'listbox' && e.role !== 'grid',
    );
    expect(targets, 'boxView heading anchor must be in the enumerated set').toContain(
      anchorFor(s, 'boxView'),
    );
    expect(targets, 'raisingView heading anchor must be in the enumerated set').toContain(
      anchorFor(s, 'raisingView'),
    );
    const offenders = targets
      .filter((e) => e.ring === null || e.ring.style !== 'none')
      .map((e) => `${e.label} computes ${JSON.stringify(e.ring?.style ?? 'NOT-FOCUSABLE')}`);
    expect(offenders, 'these tabindex=-1 elements still paint a focus ring').toEqual([]);
  });

  it('QF1-1-NO-INTERACTIVE-ROLE BITES: no [tabindex="-1"] element in any opened overlay carries an interactive role other than listbox/grid', async () => {
    // WRONG IMPL KILLED: the blanket `[tabindex="-1"]:focus { outline: none }` is only safe while
    // every tabindex=-1 element is non-interactive. A new `<li role="option" tabindex="-1">`
    // would be silently stripped of its only focus cue. The predicate is exercised on a known
    // positive and a known negative first, so an always-false predicate cannot pass this.
    const option = document.createElement('li');
    option.setAttribute('role', 'option');
    option.setAttribute('tabindex', '-1');
    const heading = document.createElement('h2');
    heading.setAttribute('tabindex', '-1');
    expect(hasInteractiveRole(option), 'control: role=option is interactive').toBe(true);
    expect(hasInteractiveRole(heading), 'control: a bare heading is not').toBe(false);

    const s = await survey();
    const offenders = s.elements
      .filter((e) => e.tabindex === '-1' && hasInteractiveRole(e.el))
      .map((e) => e.label);
    expect(offenders, 'interactive-role elements at tabindex=-1').toEqual([]);
  });

  it('QF1-1-SCOPE-NATIVE-ANCHORS BITES: the four native-control anchors (#rename-input, #tradepropose-target, #claim-signin-btn, #privacy-close-btn) do NOT compute outline-style none when focused', async () => {
    // WRONG IMPL KILLED: `*:focus { outline: none }`, `input:focus, select:focus, button:focus
    // { outline: none }` or `:focus-visible { outline: none }` — blanket suppression that strips
    // the browser's own ring from the controls a keyboard player actually types into.
    const s = await survey();
    const natives: readonly OverlayId[] = [
      'renameView',
      'tradeProposeView',
      'claimView',
      'privacyView',
    ];
    const offenders = natives
      .map((id) => ({ id, e: anchorFor(s, id) }))
      .filter(({ e }) => e.ring === null || e.ring.style === 'none')
      .map(
        ({ id, e }) =>
          `${id} ${e.label} computes ${JSON.stringify(e.ring?.style ?? 'NOT-FOCUSED')}`,
      );
    expect(offenders, 'a native-control anchor lost its focus ring').toEqual([]);
  });

  it('QF1-1-SCOPE-SYNTHETIC BITES: a focused native <button> in a dialog, a role=application tabindex=0 div and <canvas>, and a plain tabindex=0 node do NOT compute outline-style none', () => {
    // WRONG IMPL KILLED: `*:focus`, `button:focus`, `[tabindex]:focus` (kills tabindex=0 as well
    // as -1), `[role]:focus` / `[role="application"]:focus` (strips the world canvas's ring),
    // `canvas:focus { outline: none }` (the real world canvas is a <canvas role="application"
    // tabindex="0">; a div stand-in would not be matched by it).
    // Each element is created inside a role=dialog wrapper and read ONCE, after its own focus.
    const wrapper = dialogWrapper();
    const button = document.createElement('button');
    button.type = 'button';
    const canvas = document.createElement('div');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('tabindex', '0');
    const realCanvas = document.createElement('canvas');
    realCanvas.setAttribute('role', 'application');
    realCanvas.setAttribute('tabindex', '0');
    const plain = document.createElement('div');
    plain.setAttribute('tabindex', '0');
    wrapper.append(button, canvas, realCanvas, plain);
    const offenders: string[] = [];
    for (const el of [button, canvas, realCanvas, plain]) {
      const ring = focusAndReadRing(el);
      if (ring === null) offenders.push(`${describeEl(el)} could not take focus`);
      else if (ring.style === 'none') offenders.push(`${describeEl(el)} computes none`);
    }
    expect(offenders, 'scope leak: a focus-suppression rule matches a non-heading element').toEqual(
      [],
    );
  });

  it('QF1-1-SCOPE-NATIVE-EVERYWHERE BITES: EVERY natively focusable element of the shipped index.html, plus one input of every type, a select, a textarea, an a[href] and a contenteditable, keeps the browser ring (never computes none)', () => {
    // WRONG IMPL KILLED: a suppression scoped to one native control family that the four anchors
    // do not cover — `input[type="number"]:focus { outline: none }` (the two currency inputs are
    // type=number, the anchors are type=text / select / buttons), `input[type="range"]:focus`,
    // `textarea:focus`, `a:focus`, `[contenteditable]:focus`, `select:focus`. Each element is read
    // ONCE, after its own focus (the computed-style cache hazard).
    const shipped = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [contenteditable]',
      ),
    );
    expect(
      shipped.length,
      'the adopted index.html ships eight native controls (rename x2, tradepropose x4, chips x2)',
    ).toBeGreaterThanOrEqual(8);

    const wrapper = dialogWrapper();
    const synthetic: HTMLElement[] = [];
    for (const type of [
      'text',
      'search',
      'tel',
      'url',
      'email',
      'password',
      'number',
      'date',
      'time',
      'datetime-local',
      'month',
      'week',
      'color',
      'range',
      'checkbox',
      'radio',
      'file',
    ]) {
      const input = document.createElement('input');
      input.type = type;
      synthetic.push(input);
    }
    synthetic.push(document.createElement('select'), document.createElement('textarea'));
    const link = document.createElement('a');
    link.setAttribute('href', '#qf1');
    synthetic.push(link);
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    synthetic.push(editable);
    wrapper.append(...synthetic);

    const offenders: string[] = [];
    let read = 0;
    for (const el of [...shipped, ...synthetic]) {
      const ring = focusAndReadRing(el);
      // A contenteditable with no tabindex is focusable in a browser; if happy-dom's strict focus
      // model refuses it there is nothing to read, so it alone is tolerated as unfocusable.
      if (ring === null) {
        if (!el.hasAttribute('contenteditable')) offenders.push(`${describeEl(el)} took no focus`);
        continue;
      }
      read++;
      if (ring.style === 'none') {
        offenders.push(`${describeEl(el)} type=${el.getAttribute('type') ?? ''} computes none`);
      }
    }
    expect(
      read,
      'vacuity guard: the loop must have read the native controls',
    ).toBeGreaterThanOrEqual(8 + 17 + 3);
    expect(
      offenders,
      'a focus-suppression rule strips the browser ring from a native control',
    ).toEqual([]);
  });

  it('QF1-1-PARTITION-TOTAL BITES: heading + nav + native partition ALL OverlayIds, and an unclassifiable anchor throws', async () => {
    // WRONG IMPL KILLED: a nineteenth runtime shape (e.g. a tabindex=0 div anchor with no role)
    // that none of the three paint rules was written for — it would slip between the QF1.1 and
    // QF1.2 teeth and be tested by neither.
    const s = await survey();
    const counts: Record<AnchorClass, number> = { heading: 0, nav: 0, native: 0 };
    for (const id of OVERLAY_IDS) counts[classifyAnchor(anchorFor(s, id).el)]++;
    expect(counts.heading + counts.nav + counts.native).toBe(OVERLAY_IDS.length);
    expect(counts.heading, 'at least boxView and raisingView').toBeGreaterThanOrEqual(2);
    expect(counts.nav, 'at least menuView').toBeGreaterThanOrEqual(1);
    expect(counts.native, 'the four native controls').toBeGreaterThanOrEqual(4);

    const unclassifiable = document.createElement('div');
    unclassifiable.setAttribute('tabindex', '0');
    expect(() => classifyAnchor(unclassifiable)).toThrow();
    expect(() => classifyAnchor(document.createElement('span'))).toThrow();
  });

  it('QF1-2-LISTBOX-GRID-RING BITES: EVERY focusable [role="listbox"] / [role="grid"] in any opened overlay (anchors, siblings, and the populated Rankings list) computes an opaque dashed/dotted 2-4px inside-offset ring with 3:1 contrast on a box that is neither display:contents nor clipped', async () => {
    // WRONG IMPL KILLED: (1) no ring rule (shipped state: `''`), (2) a ring keyed to the anchors
    // only, leaving `#heal-options` bare, (2b) `#leaderboard-list:focus { outline: none }` — the
    // list is a listbox only in the populated Rankings state, which the survey now drives,
    // (3) a ring in the SAME style as the is-active row's solid outline, or in `double` /
    // `groove` / `ridge` / `inset` / `outset` (not dashed or dotted: `double` at 2px renders solid),
    // (4) a 1px or `2em` / 8px ring, (5) a zero, positive or -1000px outline-offset (a zero or
    // positive offset is clipped by `.mr-shell`, which has `overflow: auto`), (6) an
    // fg-coloured ring (#e0e0e0) that vanishes over the fg-filled active row, a bg-coloured one
    // that vanishes against the frame, or a fully transparent one (`rgba(204, 85, 0, 0)`),
    // (7) the blanket `[tabindex="-1"]:focus { outline: none }` winning on `#quest-log-list`, a
    // tabindex=-1 listbox, because the ring's specificity does not beat the suppression's,
    // (8) `[role="listbox"]:focus { display: contents }` or a `clip-path` that hides the ring.
    const s = await survey();
    const probe = readActiveRowProbe();
    const containers = s.elements.filter(
      (e) => (e.role === 'listbox' || e.role === 'grid') && e.ring !== null,
    );
    expect(
      containers.map((e) => e.el.id),
      'the populated Rankings list (#leaderboard-list) must be enumerated',
    ).toContain('leaderboard-list');
    expect(containers, 'menuView anchor (#menu-rows) must be enumerated').toContain(
      anchorFor(s, 'menuView'),
    );
    expect(containers, 'questLogView anchor (tabindex=-1 listbox) must be enumerated').toContain(
      anchorFor(s, 'questLogView'),
    );
    const failing = containers
      .map((e) => ({ label: e.label, problems: ringProblems(e.ring, probe) }))
      .filter((r) => r.problems.length > 0);
    expect(failing, 'nav containers whose focus ring is missing or too weak').toEqual([]);
  });

  it('QF1-2-RENDERNAV-CONTAINERS BITES: a renderNav-built LIST container and GRID container inside a dialog (not anchors) compute the same ring when focused', () => {
    // WRONG IMPL KILLED: a ring rule keyed on `[role="listbox"]` alone (the grid container,
    // which `controlsView` and every grid frame use, stays bare), or on `.mr-nav-row` /
    // `.mr-nav-item` descendants, or on one specific container id.
    const probe = readActiveRowProbe();
    const items = [
      { key: 'a', enabled: true },
      { key: 'b', enabled: true },
    ];
    const failing: { kind: string; problems: string[] }[] = [];
    for (const kind of ['list', 'grid'] as const) {
      const wrapper = dialogWrapper();
      const container = document.createElement('div');
      wrapper.appendChild(container);
      renderNav(
        container,
        kind === 'grid' ? navGrid(items, 2) : navList(items),
        { tab: null, item: 'a', perTab: {} },
        {
          frame: `qf1${kind}`,
          fill: (el, item) => {
            el.textContent = item.key;
          },
        },
      );
      expect(container.getAttribute('role'), `${kind}: renderNav's role`).toBe(
        kind === 'grid' ? 'grid' : 'listbox',
      );
      expect(container.getAttribute('tabindex'), `${kind}: renderNav's tab stop`).toBe('0');
      failing.push({ kind, problems: ringProblems(focusAndReadRing(container), probe) });
    }
    expect(failing.filter((f) => f.problems.length > 0)).toEqual([]);
  });

  it('QF1-2-TABINDEX-MINUS-ONE-LISTBOX BITES: a role=listbox element at tabindex="-1" (the #quest-log-list shape) still computes the ring — the heading suppression does not win', () => {
    // WRONG IMPL KILLED: `[tabindex="-1"]:focus { outline: none }` written at (0,2,0) or later
    // in source order than an equal-specificity ring rule, which silently cancels the ring on
    // every tabindex=-1 listbox. Synthetic, so it holds even if questLogView's markup changes.
    const probe = readActiveRowProbe();
    const wrapper = dialogWrapper();
    const listbox = document.createElement('ul');
    listbox.setAttribute('role', 'listbox');
    listbox.setAttribute('tabindex', '-1');
    wrapper.appendChild(listbox);
    expect(ringProblems(focusAndReadRing(listbox), probe)).toEqual([]);
  });
});
