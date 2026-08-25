// @vitest-environment happy-dom
// ui/overlayA11yWiring.test.ts — the CROSS-VIEW overlay-a11y wiring spec (M23 §5.5, slice m23-s10;
// criteria A11Y-13, A11Y-14, A11Y-16).
//
// WHY THIS FILE EXISTS WHEN SIXTEEN PER-VIEW SPECS ALREADY DO. Each of those proves ONE id, from a
// hand-copied byte fixture of its own shell. Two properties are invisible to all of them together:
//
//   1. TOTALITY. Nothing asserts that EVERY `OverlayId` is wired. A seventeenth overlay, or a view
//      whose `show()` quietly stopped calling the helper, is caught by no existing test. Here the
//      opener table is `Readonly<Record<OverlayId, …>>`, so a missing id is a COMPILE error
//      (`overlayRegistry.ts:76`/`:164`'s device), belt-and-braced with a runtime key-set equality
//      and a `checked === 16` counter.
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
//
// NO FAKE TIMERS: the one-macrotask defer is load-bearing (`overlayA11y.ts:17-20` — an overlay
// opened by a letter hotkey would otherwise swallow that letter into the field it just focused),
// and both polarities are pinned by the per-view specs already.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
export function isFocusableByContract(el: Element): boolean {
  const explicit = el.getAttribute('tabindex');
  if (explicit !== null) return Number.isInteger(Number(explicit));
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

/** What an opener hands back: the root the helper was given, and how to close it again. */
interface Opened {
  readonly root: HTMLElement;
  readonly close: () => void;
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
 *     used, matching production (`main.ts`).
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
    return { root: capturedRoot('battleView'), close: () => view.hide() };
  },
  boxView: () => {
    const view = new BoxView(appMount(), {
      onSetNickname: noop,
      onSetPartySlot: noop,
      onHealParty: noop,
    });
    view.show();
    return { root: capturedRoot('boxView'), close: () => view.hide() };
  },
  raisingView: () => {
    const view = new RaisingView(appMount(), { onTrain: noop, onCare: noop });
    view.show();
    return { root: capturedRoot('raisingView'), close: () => view.hide() };
  },
  evolutionView: () => {
    const view = new EvolutionView(appMount(), { onEvolve: noop });
    view.show();
    return { root: capturedRoot('evolutionView'), close: () => view.hide() };
  },
  dialogueView: () => {
    const view = new DialogueView();
    view.render({
      npcName: 'Elder Rowan',
      nodeText: 'Welcome, traveller.',
      choices: [{ text: 'Goodbye', idx: 0 }],
      canDismiss: true,
      shopAction: null,
    });
    return { root: capturedRoot('dialogueView'), close: () => view.render(null) };
  },
  questLogView: () => {
    const view = new QuestLogView();
    view.render({ active: [{ questId: 'q1', stepIndex: 0, displayName: 'Q1' }] });
    return { root: capturedRoot('questLogView'), close: () => view.render(null) };
  },
  healView: () => {
    const view = new HealView();
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
    return { root: capturedRoot('healView'), close: () => view.render(null) };
  },
  shopView: () => {
    const view = new ShopView({ onBuy: noop, onSell: noop });
    view.show();
    return { root: capturedRoot('shopView'), close: () => view.hide() };
  },
  tradeView: () => {
    const view = new TradeView({
      onAccept: asyncNoop,
      onReject: asyncNoop,
      onConfirm: asyncNoop,
      onCancel: asyncNoop,
    });
    view.show();
    return { root: capturedRoot('tradeView'), close: () => view.hide() };
  },
  pvpView: () => {
    const view = new PvpView({
      onAccept: noop,
      onDecline: noop,
      onCancel: noop,
      onChallenge: noop,
    });
    view.show();
    return { root: capturedRoot('pvpView'), close: () => view.hide() };
  },
  leaderboardView: () => {
    const view = new LeaderboardView();
    view.show();
    return { root: capturedRoot('leaderboardView'), close: () => view.hide() };
  },
  renameView: () => {
    const view = new RenameView({ onSubmit: noop });
    view.show();
    return { root: capturedRoot('renameView'), close: () => view.hide() };
  },
  tradeProposeView: () => {
    const view = new TradeProposeView({ onSubmit: noop });
    view.show();
    return { root: capturedRoot('tradeProposeView'), close: () => view.hide() };
  },
  helpView: () => {
    const view = new HelpView();
    view.show();
    return { root: capturedRoot('helpView'), close: () => view.hide() };
  },
  menuView: () => {
    const view = new MenuView({ onInput: noop });
    view.show();
    return { root: capturedRoot('menuView'), close: () => view.hide() };
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
    return { root: capturedRoot('claimView'), close: () => view.hide() };
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

describe('m23-s10 / A11Y-13,14,16 — the cross-view overlay-a11y wiring spec', () => {
  it('S10-WIRE-TOTALITY BITES: the opener table covers EVERY OverlayId and nothing else, and the manifest is the real sixteen', () => {
    // Compile-time totality is the primary device (Record<OverlayId, _>); these are the runtime
    // belts, so an `as` cast or a `@ts-expect-error` cannot quietly shrink the parameterisation.
    expect(OVERLAY_IDS.length, 'the manifest must hold sixteen mutual-exclusion overlays').toBe(16);
    expect(Object.keys(OPENERS).sort()).toEqual([...OVERLAY_IDS].sort());
    expect(Object.keys(OVERLAY_A11Y).sort()).toEqual([...OVERLAY_IDS].sort());
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
          expect(app.contains(root)).toBe(true);
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

      it(`S10-WIRE-CLOSE-RESTORE:${id} BITES: closing strips ALL THREE ARIA attributes and hands focus back to where it was — absence is impossible without the wiring`, async () => {
        const sentinel = installSentinel();
        const { root, close } = OPENERS[id]();
        await flushMacrotask();
        expect(document.activeElement).not.toBe(sentinel);

        close();

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

  it('S10-WIRE-COVERAGE-FLOOR BITES: the parameterised focus assertion ran for all sixteen ids — an empty or truncated loop cannot report success', () => {
    // Declared last so every per-id block above has executed. A `for` over an empty array is the
    // classic silent pass; this counter is the floor that makes it loud.
    expect(checked, 'S10-WIRE-FOCUS-IDENTITY must have executed once per OverlayId').toBe(16);
  });
});
