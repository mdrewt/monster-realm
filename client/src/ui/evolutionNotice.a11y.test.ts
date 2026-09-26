// @vitest-environment happy-dom
// ui/evolutionNotice.a11y.test.ts — rb-125 RED gating tests for ADR-0272: the pure
// `evolutionNoticeKey`, the injected announce/returnFocus sinks, the aria-disabled ack lock,
// and the passive-surface invariants the DOM behaviour above cannot show.
//
// ★ SOURCE OF TRUTH — docs/adr/0272-evolution-notice-announcement-and-focus.md and
// /tmp/rb125-plan-tests.md.
//
// RED REASON AT AUTHORING TIME: `client/src/ui/evolutionNotice.ts` (shipped by 20r-d) has
// no `evolutionNoticeKey` export at all — the named import below fails module evaluation
// (`SyntaxError: The requested module ... does not provide an export named 'evolutionNoticeKey'`),
// which reds EVERY test in this file, including the ones marked "(green at fork)" below. That
// marking describes the test's role ONCE the ADR-0272 sinks/lock/focus-return mechanism has
// landed — a regression/mutation pin rather than a new-behaviour gate — not a claim that it
// passes on the current commit; a brand-new test file for a not-yet-existing export cannot be
// green today by construction. `EvolutionNoticeBanner`'s CURRENT constructor also takes only
// ONE argument (`onAck`) and its CURRENT `render` takes a bare `string | null`, so even once the
// import above no longer throws, the ANN-*/AD-*/FOCUS-* behavioural tests still red on their own
// terms (no sink is ever invoked; the lock is `disabled`, not `aria-disabled`).
//
// THE CONTRACT THE IMPLEMENTER BUILDS (do not invent variants; ADR-0272 §Decision):
//
//   export function evolutionNoticeKey(entry: StoreEvolutionReveal): string;
//   export interface EvolutionNoticeContent { readonly key: string; readonly label: string }
//   export interface EvolutionNoticeSinks {
//     readonly announce: (message: string) => void;
//     readonly returnFocus: () => void;
//   }
//   export class EvolutionNoticeBanner {
//     constructor(onAck: () => Promise<void>, sinks: EvolutionNoticeSinks);
//     render(notice: EvolutionNoticeContent | null): void;
//     get visible(): boolean;
//     reset(): void;
//   }
//
// NO `new RegExp(...)` and no regex literal anywhere in this file (Semgrep bans the former
// repo-wide; the latter blinds the repo's own comment strippers). String scanning is
// indexOf / split / slice only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only, therefore ERASED by the transform: cannot make this file red on its own.
import type { StoreEvolutionReveal } from '../net/store';
import {
  EvolutionNoticeBanner,
  type EvolutionNoticeContent,
  type EvolutionNoticeSinks,
  evolutionNoticeKey,
} from './evolutionNotice';

// ---------------------------------------------------------------------------
// Fixtures + helpers (evolutionNotice.test.ts's own idioms, reused verbatim in form).
// ---------------------------------------------------------------------------

function reveal(
  monsterId: bigint,
  fromSpecies: number,
  toSpecies: number,
  evolvedAtMs: bigint,
): StoreEvolutionReveal {
  return { monsterId, fromSpecies, toSpecies, evolvedAtMs };
}

function notice(key: string, label: string): EvolutionNoticeContent {
  return { key, label };
}

/** Fresh, independently-observable vi.fn() sinks — never a shared default. */
function makeSinks(): EvolutionNoticeSinks {
  return {
    announce: vi.fn<(message: string) => void>(),
    returnFocus: vi.fn<() => void>(),
  };
}

function container(): HTMLElement {
  const el = document.getElementById('evolution-notice');
  expect(el, 'the banner must create #evolution-notice on construction').not.toBeNull();
  return el as HTMLElement;
}

function labelEl(): HTMLElement {
  const el = document.getElementById('evolution-notice-label');
  expect(el, 'the banner must create #evolution-notice-label on construction').not.toBeNull();
  return el as HTMLElement;
}

function okBtn(): HTMLButtonElement {
  const el = document.getElementById('evolution-notice-ok');
  expect(el, 'the banner must create #evolution-notice-ok on construction').not.toBeNull();
  return el as HTMLButtonElement;
}

/** Dispatch a click EVENT rather than calling `btn.click()` — see evolutionNotice.test.ts's
 *  own `clickOk` for why: `HTMLButtonElement.click()` may skip activation behaviour on a
 *  disabled control, proving the BROWSER's handling rather than the banner's own lock. */
function clickOk(): void {
  okBtn().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** One real macrotask boundary — drains the microtask queue the release chain settles on. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** A hand-controlled promise: the test decides WHEN the ack settles. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

// ===========================================================================
// evolutionNoticeKey — the pure per-entry-identity key.
// ===========================================================================

describe('RB125-KEY — evolutionNoticeKey is a pure key over entry identity', () => {
  it('RB125-KEY-1 BITES: equal for field-equal separate objects, distinct for ANY one differing field, incl. exact bigint (2^53 vs 2^53+1) and a same-ms chain pair (1->5 vs 5->9)', () => {
    // WRONG IMPL KILLED (a): keying on `label` or any derived text — species names arrive on a
    //   separate subscription (ADR-0272 §1), so a key derived from copy would change under the
    //   entry and defeat the whole "announce once per identity" contract.
    // WRONG IMPL KILLED (b) ★: `Number(monsterId)` anywhere in the key. Monster ids are server
    //   `#[auto_inc]` u64 — 2^53 and 2^53+1 collapse to the same IEEE-754 double, so a coerced
    //   key would treat two DIFFERENT monsters' reveals as the SAME entry and never re-announce
    //   the second one.
    // WRONG IMPL KILLED (c) ★: a key built from `monsterId` alone (or from the species pair
    //   alone). One evolution CHAIN shares one monsterId across several links, and each link
    //   shares one `evolvedAtMs` (the transaction clock) with its siblings — a key that drops
    //   either the species pair or the timestamp collapses two DISTINCT chain steps (1->5 then
    //   5->9) into the same key, and the second step is silently never announced.
    const base = reveal(7n, 1, 5, 1000n);
    const sameFieldsSeparateObject = reveal(7n, 1, 5, 1000n);
    expect(
      evolutionNoticeKey(base),
      'two field-equal but reference-distinct entries must produce the SAME key',
    ).toBe(evolutionNoticeKey(sameFieldsSeparateObject));

    const diffMonster = reveal(8n, 1, 5, 1000n);
    const diffFrom = reveal(7n, 2, 5, 1000n);
    const diffTo = reveal(7n, 1, 6, 1000n);
    const diffMs = reveal(7n, 1, 5, 1001n);
    for (const [label, other] of [
      ['monsterId', diffMonster],
      ['fromSpecies', diffFrom],
      ['toSpecies', diffTo],
      ['evolvedAtMs', diffMs],
    ] as const) {
      expect(
        evolutionNoticeKey(base),
        `a differing \`${label}\` alone must produce a DIFFERENT key`,
      ).not.toBe(evolutionNoticeKey(other));
    }

    // Exact bigint compare — never Number()-coerced.
    const big53 = reveal(2n ** 53n, 1, 5, 1000n);
    const big53Plus1 = reveal(2n ** 53n + 1n, 1, 5, 1000n);
    expect(
      evolutionNoticeKey(big53),
      'a Number()-coerced monsterId aliases 2^53 with 2^53+1',
    ).not.toBe(evolutionNoticeKey(big53Plus1));

    // Same-ms chain: two DIFFERENT steps of one chain share monsterId + evolvedAtMs; only the
    // species pair differs.
    const step1of3 = reveal(7n, 1, 5, 2000n);
    const step2of3 = reveal(7n, 5, 9, 2000n);
    expect(
      evolutionNoticeKey(step1of3),
      'two links of one chain sharing monsterId + evolvedAtMs must still key DIFFERENTLY — ' +
        'only their species pair differs',
    ).not.toBe(evolutionNoticeKey(step2of3));
  });
});

// ===========================================================================
// Announce-once-per-key.
// ===========================================================================

describe('RB125-ANN — the announce sink fires exactly once per distinct key', () => {
  it('RB125-ANN-1 BITES: rendering the SAME key six times announces its label exactly once', () => {
    const sinks = makeSinks();
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), sinks);
    const entry = notice('k1', 'Sparky evolved from Flameling into Flamewing!');
    for (let i = 0; i < 6; i++) banner.render(entry);
    expect(sinks.announce).toHaveBeenCalledTimes(1);
    expect(sinks.announce).toHaveBeenCalledWith('Sparky evolved from Flameling into Flamewing!');
  });

  it('RB125-ANN-2 BITES: a LABEL change for the SAME key does not re-announce, but the DOM text still updates', () => {
    // WRONG IMPL KILLED: keying the announce dedupe on the rendered LABEL rather than the
    //   entry's own key — a late species name landing on the SAME entry (`Species #5` ->
    //   `Flamewing`) would re-announce it, which is exactly the double-speak ADR-0272 bans
    //   ("it is edge-triggered on entry identity, not on label text").
    const sinks = makeSinks();
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), sinks);
    banner.render(notice('k1', 'Species #5'));
    banner.render(notice('k1', 'Flamewing'));
    expect(sinks.announce).toHaveBeenCalledTimes(1);
    expect(sinks.announce).toHaveBeenCalledWith('Species #5');
    expect(labelEl().textContent).toBe('Flamewing');
  });

  it('RB125-ANN-3 BITES: a chain A -> B (two DIFFERENT keys) announces BOTH labels, in order', () => {
    const sinks = makeSinks();
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), sinks);
    banner.render(notice('a', 'label A'));
    banner.render(notice('b', 'label B'));
    expect(vi.mocked(sinks.announce).mock.calls).toEqual([['label A'], ['label B']]);
  });

  it('RB125-ANN-4 BITES: A, then null, then A again announces ONCE (the last-announced key is NOT cleared on hide); a NEW key after that announces a second time', () => {
    // WRONG IMPL KILLED (ADR-0272 §1 ★): clearing the last-announced key on `render(null)`. A
    //   hide-then-reshow of the SAME key only happens across a reconnect or a store reset, and
    //   re-speaking an entry already heard on every link flap is exactly the noise this rule
    //   bans.
    const sinks = makeSinks();
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), sinks);
    banner.render(notice('a', 'label A'));
    banner.render(null);
    banner.render(notice('a', 'label A'));
    expect(sinks.announce).toHaveBeenCalledTimes(1);
    banner.render(notice('c', 'label C'));
    expect(sinks.announce).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sinks.announce).mock.calls).toEqual([['label A'], ['label C']]);
  });

  it('RB125-ANN-5 (green at fork): render(null) five times in a row never announces', () => {
    const sinks = makeSinks();
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), sinks);
    for (let i = 0; i < 5; i++) banner.render(null);
    expect(sinks.announce).not.toHaveBeenCalled();
  });

  it('RB125-ANN-6 BITES: render(A) then render(null) twice never re-announces the outgoing label', () => {
    // WRONG IMPL KILLED: announcing the OUTGOING label on hide (e.g. reaching for the sink from
    //   the `notice === null` branch to "read out" the banner's disappearance) — ADR-0272 §1
    //   fires the sink only on an entry's OWN identity edge, never on a hide, and the label the
    //   player was shown is never spoken a second time by this route.
    const sinks = makeSinks();
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), sinks);
    banner.render(notice('k1', 'X'));
    banner.render(null);
    banner.render(null);
    expect(sinks.announce).toHaveBeenCalledTimes(1);
    expect(sinks.announce).toHaveBeenCalledWith('X');
  });

  it('RB125-ANN-7 BITES: reset() does not clear the last-announced key — a re-render of the SAME key after reset() still announces only once; a genuinely NEW key after that announces a second time', () => {
    // WRONG IMPL KILLED (ADR-0272 §1 ★): clearing `#announcedKey` inside `reset()`. `main.ts`
    //   calls `reset()` on the reconnect edge (a link flap), and re-speaking an entry every AT
    //   user already heard on that flap is exactly the noise ADR-0272 §1 bans ("never re-speak
    //   on a link flap") — `reset()` must only ever touch the in-flight ack lock, never the
    //   announce dedupe.
    const sinks = makeSinks();
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), sinks);
    banner.render(notice('k1', 'X'));
    banner.reset();
    banner.render(notice('k1', 'X'));
    expect(sinks.announce).toHaveBeenCalledTimes(1);
    // Non-vacuity: a genuinely new key still gets through after the reset().
    banner.render(notice('k2', 'Y'));
    expect(sinks.announce).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sinks.announce).mock.calls).toEqual([['X'], ['Y']]);
  });

  it('RB125-ANN-8 BITES: a THROWING announce sink still leaves the DOM already updated, and the key is recorded BEFORE the sink call — a second render of the same key does not throw again', () => {
    // WRONG IMPL KILLED (a): calling `sinks.announce()` before writing the label / display / OK
    //   text — a throwing sink would then leave the banner's DOM stale (or still hidden) even
    //   though `render()` was invoked with real content, which is exactly the "stale banner on
    //   screen" ADR-0272 rules out for a throwing sink.
    // WRONG IMPL KILLED (b): recording `#announcedKey = notice.key` only AFTER `sinks.announce()`
    //   returns. A throwing sink never reaches that assignment under that ordering, so a second
    //   render of the SAME key re-invokes (and re-throws from) the sink instead of treating the
    //   entry as already announced.
    const throwingAnnounce = vi.fn<(message: string) => void>(() => {
      throw new Error('boom');
    });
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), {
      announce: throwingAnnounce,
      returnFocus: vi.fn(),
    });

    expect(() => banner.render(notice('k1', 'X'))).toThrow();
    expect(labelEl().textContent).toBe('X');
    expect(container().style.display).toBe('block');
    expect(okBtn().textContent, 'the OK button label must already be resolved').not.toBe('');
    expect(throwingAnnounce).toHaveBeenCalledTimes(1);

    expect(
      () => banner.render(notice('k1', 'X')),
      'the key was already recorded before the sink threw, so the same key must not re-invoke it',
    ).not.toThrow();
    expect(throwingAnnounce).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// The aria-disabled in-flight ack lock.
// ===========================================================================

describe('RB125-AD — the in-flight ack lock is aria-disabled, never the disabled property', () => {
  it('RB125-AD-1 BITES: a click sets aria-disabled="true" (the `disabled` PROPERTY stays false) while the ack is in flight; a second click sends nothing; settling removes the attribute entirely', async () => {
    // WRONG IMPL KILLED (a) ★ THE DEFECT (ADR-0272 §2): the CURRENT lock writes
    //   `okBtn.disabled = true`. The HTML focus-fixup rule blurs a focused control the instant
    //   `disabled` becomes true, so a keyboard player acking entry 1 of a three-step chain lands
    //   on <body> and must re-Tab for entries 2 and 3.
    // WRONG IMPL KILLED (b): releasing to `setAttribute('aria-disabled', 'false')` instead of
    //   removing the attribute — ADR-0272 §2 requires REMOVAL ("the attribute is removed on
    //   release, never set to 'false'"), and `hasAttribute` is what tells the two apart.
    const d = deferred();
    const onAck = vi.fn(() => d.promise);
    const banner = new EvolutionNoticeBanner(onAck, makeSinks());
    banner.render(notice('a', 'x'));

    clickOk();
    expect(onAck).toHaveBeenCalledTimes(1);
    expect(
      okBtn().disabled,
      'the OK button`s `disabled` PROPERTY must stay false while the ack is in flight',
    ).toBe(false);
    expect(
      okBtn().getAttribute('aria-disabled'),
      'the in-flight lock must be aria-disabled="true"',
    ).toBe('true');

    clickOk();
    expect(
      onAck,
      'a second click while the lock is held must not send again',
    ).toHaveBeenCalledTimes(1);

    d.resolve();
    await settle();
    expect(okBtn().disabled).toBe(false);
    expect(
      okBtn().hasAttribute('aria-disabled'),
      'a released lock must REMOVE the attribute, never leave it set to the string "false"',
    ).toBe(false);
  });

  it('RB125-AD-2 BITES: a REJECTED ack and reset() each remove aria-disabled at once, and a STALE settle after reset() leaves aria-disabled="true" on the send it did not release', async () => {
    // ★ THE GENERATION-TOKEN TOOTH, restated for aria-disabled: send #1 -> reject -> released;
    //   send #2 -> reset() (the onReconnect edge) -> released; send #3 goes out under a FRESH
    //   token -> send #2's stale settle (arriving AFTER reset() already forgot it) must not
    //   release send #3's lock. A release chain that simply toggles a shared attribute lets the
    //   dead connection's promise unlock a send that is still outstanding.
    const d1 = deferred();
    const onAck = vi.fn(() => d1.promise);
    const banner = new EvolutionNoticeBanner(onAck, makeSinks());
    banner.render(notice('a', 'x'));

    // (1) a REJECTED ack releases the lock.
    clickOk(); // send #1
    expect(okBtn().getAttribute('aria-disabled')).toBe('true');
    d1.reject(new Error('no pending evolution notices'));
    await settle();
    expect(okBtn().hasAttribute('aria-disabled'), 'a rejected ack must release the lock').toBe(
      false,
    );
    expect(okBtn().disabled).toBe(false);

    // (2) reset() releases an in-flight lock immediately, without waiting on the promise.
    const d2 = deferred();
    onAck.mockImplementation(() => d2.promise);
    clickOk(); // send #2
    expect(okBtn().getAttribute('aria-disabled')).toBe('true');
    banner.reset();
    expect(okBtn().hasAttribute('aria-disabled'), 'reset() must remove the attribute at once').toBe(
      false,
    );
    expect(okBtn().disabled).toBe(false);

    // (3) send #3 under a fresh token; send #2's stale settle must not release it.
    const d3 = deferred();
    onAck.mockImplementation(() => d3.promise);
    clickOk(); // send #3
    expect(onAck).toHaveBeenCalledTimes(3);
    expect(okBtn().getAttribute('aria-disabled')).toBe('true');

    d2.resolve(); // the STALE settle of send #2, which reset() already forgot about
    await settle();
    expect(
      okBtn().getAttribute('aria-disabled'),
      'send #2`s stale settle must NOT release send #3`s lock',
    ).toBe('true');

    d3.resolve();
    await settle();
    expect(okBtn().hasAttribute('aria-disabled')).toBe(false);
  });

  it('RB125-AD-3 (green at fork): the OK button keeps focus across a rendered chain step while its own ack is in flight', () => {
    // A regression pin for the WHOLE reason aria-disabled replaces disabled (ADR-0272 §2): a
    // focused control that becomes `disabled` is blurred by the browser; aria-disabled carries
    // no such fixup, so focus must survive the very re-render the lock is held across.
    const d = deferred();
    const onAck = vi.fn(() => d.promise);
    const banner = new EvolutionNoticeBanner(onAck, makeSinks());
    banner.render(notice('a', 'x'));
    okBtn().focus();
    expect(document.activeElement).toBe(okBtn());

    clickOk();
    banner.render(notice('b', 'y')); // the next chain step repaints the SAME button
    expect(
      document.activeElement,
      'aria-disabled must never blur the button the way the `disabled` PROPERTY would',
    ).toBe(okBtn());
  });
});

// ===========================================================================
// Focus return on hide.
// ===========================================================================

describe('RB125-FOCUS — render(null) returns focus to the sink ONLY when it held it', () => {
  it('RB125-FOCUS-1 BITES: render(null) with focus INSIDE the banner calls returnFocus() exactly once, moving focus to a REAL fallback control; the banner is hidden; a second render(null) does not call it again', () => {
    const fallback = document.createElement('button');
    fallback.id = 'fallback-focus-target';
    document.body.appendChild(fallback);
    const returnFocus = vi.fn<() => void>(() => fallback.focus());
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), {
      announce: vi.fn(),
      returnFocus,
    });
    banner.render(notice('a', 'x'));
    okBtn().focus();
    expect(document.activeElement, 'precondition: the OK button holds focus').toBe(okBtn());

    banner.render(null);
    expect(returnFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement, 'the returnFocus sink must actually move focus').toBe(fallback);
    expect(container().style.display).toBe('none');

    banner.render(null);
    expect(
      returnFocus,
      'a second render(null) while already hidden must not call returnFocus again',
    ).toHaveBeenCalledTimes(1);
  });

  it('RB125-FOCUS-2 (green at fork): focus OUTSIDE the banner is never touched by show or hide — covered for an outside control AND for <body>', () => {
    // An outside <input> holds focus.
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const returnFocusA = vi.fn<() => void>();
    const bannerA = new EvolutionNoticeBanner(() => Promise.resolve(), {
      announce: vi.fn(),
      returnFocus: returnFocusA,
    });
    bannerA.render(notice('a', 'x'));
    expect(document.activeElement, 'show must never move focus').toBe(outside);
    expect(document.activeElement, 'show must never focus the OK button').not.toBe(okBtn());
    bannerA.render(null);
    expect(
      returnFocusA,
      'hide must not call returnFocus when focus was never inside the banner',
    ).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);

    document.body.innerHTML = '';

    // <body> holds focus — the ordinary boot state.
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    const returnFocusB = vi.fn<() => void>();
    const bannerB = new EvolutionNoticeBanner(() => Promise.resolve(), {
      announce: vi.fn(),
      returnFocus: returnFocusB,
    });
    bannerB.render(notice('b', 'y'));
    expect(document.activeElement).toBe(document.body);
    bannerB.render(null);
    expect(returnFocusB).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it('RB125-FOCUS-3 (green at fork): a same-session A -> B render (no intervening hide) never calls returnFocus, even though focus sits on the OK button', () => {
    const returnFocus = vi.fn<() => void>();
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), {
      announce: vi.fn(),
      returnFocus,
    });
    banner.render(notice('a', 'x'));
    okBtn().focus();
    expect(document.activeElement).toBe(okBtn());
    banner.render(notice('b', 'y')); // the next chain step, no null in between
    expect(returnFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(okBtn());
  });

  it('RB125-FOCUS-4 BITES: a NO-OP returnFocus sink (an unmounted canvas) never re-fires on later hides once the visible->hidden edge has already passed', () => {
    // WRONG IMPL KILLED: a LEVEL-triggered `hadFocus` check — testing "is focus inside the
    //   banner" on every `render(null)` instead of only on the visible->hidden EDGE. When the
    //   sink cannot actually move focus (a canvas that has not mounted yet), the OK button stays
    //   `document.activeElement` even after the banner hides, so a level check would call
    //   `returnFocus` again on every LATER `render(null)`, fighting whatever the player has since
    //   focused instead of firing exactly once on the edge.
    const returnFocus = vi.fn<() => void>();
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), {
      announce: vi.fn(),
      returnFocus,
    });
    banner.render(notice('k1', 'x'));
    okBtn().focus();
    expect(document.activeElement).toBe(okBtn());

    banner.render(null);
    expect(returnFocus).toHaveBeenCalledTimes(1);
    expect(
      document.activeElement,
      'precondition: the no-op sink could not actually move focus off the now-hidden OK button',
    ).toBe(okBtn());

    banner.render(null);
    banner.render(null);
    expect(
      returnFocus,
      'a level check would re-fire on every later render(null) since focus never left the button',
    ).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Passive-surface invariants that hold regardless of the sinks under test.
// ===========================================================================

describe('RB125-PASSIVE — the banner still carries no modal semantics', () => {
  it('RB125-PASSIVE (green at fork): no role, aria-modal or tabindex on any banner node after show', () => {
    // Fragment-assembled, like evolutionNotice.test.ts's own EN-BANNER-A11Y markers, so a
    // contiguous copy of one of these can never poison a raw `client/**` scan of this test file.
    const roleAttr = 'role';
    const ariaModalAttr = ['aria', '-modal'].join('');
    const tabIndexAttr = ['tab', 'index'].join('');
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), makeSinks());
    banner.render(notice('a', 'x'));

    for (const [name, el] of [
      ['container', container()],
      ['label', labelEl()],
      ['ok button', okBtn()],
    ] as const) {
      expect(el.getAttribute(roleAttr), `${name} must carry no role`).toBeNull();
      expect(el.getAttribute(ariaModalAttr), `${name} must carry no ${ariaModalAttr}`).toBeNull();
      expect(el.getAttribute(tabIndexAttr), `${name} must carry no ${tabIndexAttr}`).toBeNull();
    }
  });
});

// ===========================================================================
// Static source discipline — the facts the DOM tests above cannot show.
// ===========================================================================

describe('RB125-SOURCE — evolutionNotice.ts carries the aria-disabled lock and never re-implements the live region', () => {
  it("RB125-SOURCE-1 BITES: zero raw disabled-property/attribute writes, zero LiveRegion/liveRegion/a11y-live/LIVE_REGION_ID mentions, and zero aria-disabled 'false' writes", () => {
    // WHY A SOURCE SCAN ALONSIDE THE DOM TESTS ABOVE (evolutionNotice.test.ts's own EN-SOURCE-1
    // precedent): the DOM assertions read the state AFTER specific call sequences; a stray
    // `okBtn.disabled = false` left on some OTHER branch (an error path, a future door) is
    // invisible to them. Each needle is a REPO RULE:
    //   .disabled = / ['disabled'] / setAttribute('disabled'/toggleAttribute('disabled' — the
    //     lock must be aria-disabled, never the disabled PROPERTY OR ATTRIBUTE (ADR-0272 §2);
    //   LiveRegion / liveRegion / a11y-live / LIVE_REGION_ID — ui/liveRegion.ts stays the SOLE
    //     announcement owner ([A11Y-05b]); this file must reach it only through the injected
    //     `sinks.announce` callback, never by name;
    //   'aria-disabled', 'false' — the release path must REMOVE the attribute, never set the
    //     literal string "false" (a value ARIA readers still treat as present-and-disabled).
    // Comment-stripped first, so the file may (and should) EXPLAIN in prose why each of these is
    // absent without tripping its own gate.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'evolutionNotice.ts'),
      'utf8',
    );
    const stripped = stripComments(src);

    // ANTI-VACUITY, ASSERTED FIRST.
    expect(
      stripped.length,
      'comment-stripped evolutionNotice.ts collapsed to under a quarter of its raw size — the ' +
        'stripper bailed early and every ban below would judge a prefix',
    ).toBeGreaterThan(src.length / 4);
    const ariaDisabledAttr = ['aria', '-disabled'].join('');
    for (const required of ['EvolutionNoticeBanner', ariaDisabledAttr]) {
      expect(
        stripped.indexOf(required),
        `ANTI-VACUITY: the stripped source must still contain \`${required}\` — otherwise the ` +
          'zeros below are a broken scan, not an absence',
      ).toBeGreaterThanOrEqual(0);
    }

    // FRAGMENT-ASSEMBLED, like every production needle in this repo's scan files: several evals
    // read `client/**` RAW (test files included), so a contiguous copy of one of these markers
    // in a TEST would poison their scans. The fragments also make this file immune to being its
    // own subject.
    const dotDisabledAssign = ['.disabled', ' ='].join('');
    const bracketDisabled = ['[', "'disabled'", ']'].join('');
    const setAttrDisabled = ["setAttribute('disabled", "'"].join('');
    const toggleAttrDisabled = ["toggleAttribute('disabled", "'"].join('');
    const liveRegionClassName = ['Live', 'Region'].join('');
    const liveRegionVarName = ['live', 'Region'].join('');
    const a11yLiveId = ['a11y', '-live'].join('');
    const liveRegionIdConstName = ['LIVE_REGION', '_ID'].join('');
    const ariaLiveAttr = ['aria', '-live'].join('');
    // Given verbatim per the rb-125 handoff: `"'aria-" + "disabled', 'false'"`.
    const ariaDisabledFalseLiteral = "'aria-" + "disabled', 'false'";

    for (const banned of [
      dotDisabledAssign,
      bracketDisabled,
      setAttrDisabled,
      toggleAttrDisabled,
      liveRegionClassName,
      liveRegionVarName,
      a11yLiveId,
      liveRegionIdConstName,
      ariaLiveAttr,
      ariaDisabledFalseLiteral,
    ]) {
      expect(
        stripped.split(banned).length - 1,
        `client/src/ui/evolutionNotice.ts must contain ZERO occurrences of \`${banned}\` as CODE ` +
          '(comments are stripped first, so explaining the absence is free). RED AT AUTHORING ' +
          'TIME for the disabled-property writes: the current lock still writes `okBtn.disabled ' +
          '= …` (ADR-0272 requires aria-disabled instead, so the HTML focus-fixup rule never ' +
          'blurs the button mid-chain)',
      ).toBe(0);
    }
  });
});

/** Drop block comments, then line comments. Marker scan, never a regex — `new RegExp` is banned
 *  repo-wide and a regex literal blinds the repo's own comment strippers. Copied in FORM from
 *  evolutionNotice.test.ts's own `stripComments` (and, before that, connection.test.ts's). */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = src.indexOf('/*', i);
    if (start === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, start);
    const end = src.indexOf('*/', start + 2);
    if (end === -1) break;
    i = end + 2;
  }
  return out
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}
