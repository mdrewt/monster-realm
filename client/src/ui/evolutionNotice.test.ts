// @vitest-environment happy-dom
// ui/evolutionNotice.test.ts — 20r-d RED gating tests for the post-evolve reveal:
// the pure label core, the name resolver, the benign-rejection filter, and the
// passive DOM banner.
//
// ★ SOURCE OF TRUTH — spec `M-postgate-twentieth-review-residuals.spec.md` §20r-d
// gate B1, and `docs/adr/0254-post-evolve-notification-queue-and-banner.md` D6
// ("Client"). B1's client half is "the player SHALL see a visible reveal … a
// modest overlay/banner … satisfies this slice".
//
// RED REASON AT AUTHORING TIME: `client/src/ui/evolutionNotice.ts` DOES NOT
// EXIST. The value import below fails to resolve, so every test in this file
// reds on a MISSING IMPLEMENTATION — never on a typo here. (The `import type`
// from `../net/store` is erased by the transform, so it cannot red on its own.)
//
// THE CONTRACT THE IMPLEMENTER BUILDS (do not invent variants):
//
//   export interface EvolutionNoticeNames {
//     readonly nickname: string | undefined;
//     readonly fromName: string | undefined;
//     readonly toName: string | undefined;
//   }
//   export function evolutionNoticeLabel(
//     entry: StoreEvolutionReveal, names: EvolutionNoticeNames): string;
//   export function resolveEvolutionNoticeNames(
//     entry: StoreEvolutionReveal,
//     ownMonsters: readonly { readonly monsterId: bigint; readonly nickname: string }[],
//     speciesName: (id: number) => string | undefined): EvolutionNoticeNames;
//   export function isBenignAckRejection(message: string): boolean;
//   export class EvolutionNoticeBanner {
//     constructor(onAck: () => Promise<void>);
//     render(label: string | null): void;
//     get visible(): boolean;
//     reset(): void;
//   }
//
//   COPY (exact — a future wording change is corrected HERE, from the ADR, never
//   bent to match an implementation):
//     nickname present -> `${nickname} evolved from ${from} into ${to}!`
//     nickname absent  -> `Your ${from} evolved into ${to}!`
//     a missing species name renders `Species #${id}` in its place.
//   The label function is TOTAL: it reads no clock, no store and no DOM, and it
//   never throws.
//
// ⚠ EMPTY-STRING CLAUSE — a tester-derived invariant, stated openly, and it
//   applies to ALL THREE names. The store carries an un-nicknamed monster as
//   `nickname: ''` (`Monster.nickname` is `String::new()` server-side) and a
//   species name is a plain `String` column read through
//   `store.species(id)?.name`, so "present" can never mean "the field exists".
//   An implementation that tests only `!== undefined` ships
//   `" evolved from Flameling into Flamewing!"` (no subject) or
//   `"Your  evolved into Flamewing!"` (no species) — sentences that name nothing,
//   which is the exact failure B1's "the player SHALL see" is about. So:
//     nickname `''`  -> the un-nicknamed branch    (EN-LABEL-3)
//     fromName/toName `''` -> `Species #${id}`     (EN-LABEL-5)
//   and `resolveEvolutionNoticeNames` normalises an empty nickname to `undefined`
//   (EN-NAMES-4). Derived from B1 and from the server's own empty-string
//   convention, not from any code.
//
// ⚠ NOTE FOR THE IMPLEMENTER ON THE REJECTION TEST (EN-BANNER-REJECT below): the
//   OK handler's release chain must not leak an UNHANDLED REJECTION. `sendGuarded`
//   always resolves in production (20r-a M-2), so terminating the chain with a
//   `.catch(() => {})` after the `.finally(...)` is inert there — but a bare
//   `onAck().finally(release)` leaves the derived promise rejected and unhandled,
//   which vitest reports as a run-level failure and a browser logs on every
//   transient failure. Add the trailing catch; do not weaken the test.
//
// NO `new RegExp(...)` and no regex literal anywhere in this file (Semgrep bans
// the former repo-wide; the latter blinds the repo's own comment strippers).
// String scanning is indexOf / split / slice only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only, therefore ERASED by the transform: importing it cannot make this
// file red on its own, which keeps the RED reason unambiguous (the value import
// below is the one that must fail).
import type { StoreEvolutionReveal } from '../net/store';
import {
  EvolutionNoticeBanner,
  evolutionNoticeLabel,
  isBenignAckRejection,
  resolveEvolutionNoticeNames,
} from './evolutionNotice';

// ---------------------------------------------------------------------------
// Fixtures + helpers.
// ---------------------------------------------------------------------------

/** The three banned attribute names, FRAGMENT-ASSEMBLED. Several evals read
 *  `client/**` RAW (test files included) when they audit the a11y surface, and a
 *  contiguous copy of one of these markers in a test file poisons their scan —
 *  the same discipline `evolution_tests.rs` applies to production needles. */
const ARIA_LIVE_ATTR = ['aria', '-live'].join('');
const ARIA_LABEL_ATTR = ['aria', '-label'].join('');
const TAB_INDEX_ATTR = ['tab', 'index'].join('');

/** One reveal entry. Every field DISTINCT so a field swap is visible. */
function reveal(
  monsterId: bigint,
  fromSpecies: number,
  toSpecies: number,
  evolvedAtMs: bigint,
): StoreEvolutionReveal {
  return { monsterId, fromSpecies, toSpecies, evolvedAtMs };
}

/** ONE real macrotask boundary — drains the microtask queue the release chain
 *  settles on. Never `vi.useFakeTimers()`: the banner's lock is promise-driven,
 *  and a fake clock proves nothing about a microtask. */
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

/** Dispatch a click EVENT rather than calling `btn.click()`.
 *
 *  Deliberate: `HTMLButtonElement.click()` is allowed to skip activation
 *  behaviour on a disabled button, which would make "a second click while a
 *  send is in flight does not re-send" pass for free — proving the BROWSER's
 *  disabled handling rather than the banner's own generation-token lock. A
 *  dispatched event always reaches the listener, so the guard under test is the
 *  one the code owns. */
function clickOk(): void {
  okBtn().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** A keydown on the OK button, returning the event so the test can read
 *  `defaultPrevented`. `cancelable: true` is load-bearing — `preventDefault()`
 *  on a non-cancelable event is a silent no-op. */
function keydownOk(repeat: boolean): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key: 'Enter',
    repeat,
    bubbles: true,
    cancelable: true,
  });
  okBtn().dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  // A fresh DOM per test so the banner's find-or-create always CREATES, and a
  // previous test's element can never satisfy an assertion here.
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

// ===========================================================================
// The pure label core.
// ===========================================================================

describe('20r-d EN-LABEL — evolutionNoticeLabel renders the reveal copy', () => {
  it('20r-d EN-LABEL-1 BITES: a nicknamed monster renders the three-part sentence, EXACTLY', () => {
    // WRONG IMPL KILLED: a label that drops the FROM species ("Sparky evolved
    //   into Flamewing!") — the whole point of the reveal is that the player may
    //   not have seen which form it left, because an auto-evolution needs no
    //   player action at all (EG2-11).
    // WRONG IMPL KILLED: from/to transposed — the sentence still reads fluently
    //   and is exactly backwards, which no shape/regex assertion would catch.
    expect(
      evolutionNoticeLabel(reveal(7n, 1, 2, 100n), {
        nickname: 'Sparky',
        fromName: 'Flameling',
        toName: 'Flamewing',
      }),
    ).toBe('Sparky evolved from Flameling into Flamewing!');
  });

  it('20r-d EN-LABEL-2 BITES: an absent nickname renders the "Your <from> evolved into <to>!" form', () => {
    // WRONG IMPL KILLED: rendering `undefined evolved from …` — the literal string
    //   "undefined" in player-facing copy, which a "does it mention the species"
    //   assertion would happily accept.
    expect(
      evolutionNoticeLabel(reveal(7n, 1, 2, 100n), {
        nickname: undefined,
        fromName: 'Flameling',
        toName: 'Flamewing',
      }),
    ).toBe('Your Flameling evolved into Flamewing!');
  });

  it('20r-d EN-LABEL-3 BITES: an EMPTY nickname takes the un-nicknamed branch', () => {
    // WRONG IMPL KILLED ★ (the store convention makes this the LIKELY shape):
    //   `names.nickname !== undefined ? …` — an un-nicknamed monster carries
    //   `nickname: ''` all the way from the server (`Monster.nickname` is
    //   `String::new()`), so the banner would read
    //   " evolved from Flameling into Flamewing!" with a leading space and no
    //   subject. See this file's header for why this clause is tester-derived.
    expect(
      evolutionNoticeLabel(reveal(7n, 1, 2, 100n), {
        nickname: '',
        fromName: 'Flameling',
        toName: 'Flamewing',
      }),
    ).toBe('Your Flameling evolved into Flamewing!');
  });

  it('20r-d EN-LABEL-4 BITES: a missing species name falls back to "Species #<id>" on EITHER side', () => {
    // WRONG IMPL KILLED (a): rendering `undefined` / `null` / an empty string
    //   where a species name is missing. The species content table arrives on a
    //   separate subscription, so "the reveal lands before species_row does" is a
    //   NORMAL startup race, not an error state.
    // WRONG IMPL KILLED (b): a fallback that uses the WRONG id — both sides are
    //   pinned separately, with different ids, so a `fromSpecies` used for both
    //   reds here and nowhere else.
    expect(
      evolutionNoticeLabel(reveal(7n, 31, 44, 100n), {
        nickname: 'Sparky',
        fromName: undefined,
        toName: undefined,
      }),
    ).toBe('Sparky evolved from Species #31 into Species #44!');
    expect(
      evolutionNoticeLabel(reveal(7n, 31, 44, 100n), {
        nickname: undefined,
        fromName: 'Flameling',
        toName: undefined,
      }),
    ).toBe('Your Flameling evolved into Species #44!');
    expect(
      evolutionNoticeLabel(reveal(7n, 31, 44, 100n), {
        nickname: undefined,
        fromName: undefined,
        toName: 'Flamewing',
      }),
    ).toBe('Your Species #31 evolved into Flamewing!');
  });

  it('20r-d EN-LABEL-5 BITES: TOTAL — an EMPTY species name takes the "Species #<id>" fallback, and degenerate input never throws', () => {
    // WRONG IMPL KILLED (a) ★ THE EMPTY-STRING SPECIES NAME, the same rule as the
    //   empty nickname (EN-LABEL-3) and reachable for the same kind of reason: the
    //   name arrives from `store.species(id)?.name`, a content row whose `name`
    //   column is a plain `String`. An implementation that falls back only on
    //   `undefined` (a `??` or a `!== undefined` test) renders " evolved into "
    //   with a hole where the species should be — a sentence that names NOTHING,
    //   which is the exact failure B1's "the player SHALL see" is about. Pinned as
    //   an exact string on BOTH sides, with different ids, so a fallback that
    //   reuses one id for both reds here too.
    // WRONG IMPL KILLED (b): any lookup/parse that can throw. This function runs
    //   inside a `store.onBatchApplied` listener; `flushBatch` catches per
    //   listener (store.ts:766-772), but a throw here still costs the WHOLE
    //   listener its frame — including the render that would have hidden a stale
    //   banner.
    expect(
      evolutionNoticeLabel(reveal(7n, 31, 44, 100n), {
        nickname: 'Sparky',
        fromName: '',
        toName: '',
      }),
      'an EMPTY species name must render the `Species #<id>` fallback, exactly as an absent one does',
    ).toBe('Sparky evolved from Species #31 into Species #44!');
    expect(
      evolutionNoticeLabel(reveal(7n, 31, 44, 100n), {
        nickname: undefined,
        fromName: '',
        toName: 'Flamewing',
      }),
      'the empty-string rule applies per SIDE — an empty `fromName` beside a present `toName`',
    ).toBe('Your Species #31 evolved into Flamewing!');
    expect(
      evolutionNoticeLabel(reveal(7n, 31, 44, 100n), {
        nickname: undefined,
        fromName: 'Flameling',
        toName: '',
      }),
      'the empty-string rule applies per SIDE — an empty `toName` beside a present `fromName`',
    ).toBe('Your Flameling evolved into Species #44!');

    const degenerate: readonly [
      StoreEvolutionReveal,
      Parameters<typeof evolutionNoticeLabel>[1],
    ][] = [
      [reveal(0n, 0, 0, 0n), { nickname: undefined, fromName: undefined, toName: undefined }],
      [
        reveal(-1n, Number.NaN, Number.MAX_SAFE_INTEGER, -5n),
        { nickname: '  ', fromName: '', toName: '' },
      ],
      [
        reveal(2n ** 70n, 2 ** 31, -3, 2n ** 63n),
        { nickname: '<script>', fromName: 'a'.repeat(400), toName: '\n\t' },
      ],
    ];
    for (const [entry, names] of degenerate) {
      const out = evolutionNoticeLabel(entry, names);
      expect(
        typeof out,
        `evolutionNoticeLabel must be TOTAL — it returned a non-string for ${JSON.stringify({
          fromSpecies: entry.fromSpecies,
          toSpecies: entry.toSpecies,
        })}`,
      ).toBe('string');
      expect(out.length, 'a reveal label must never be empty').toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// The name resolver.
// ===========================================================================

describe('20r-d EN-NAMES — resolveEvolutionNoticeNames', () => {
  it('20r-d EN-NAMES-1 BITES: the nickname comes from the matching monster and both species names resolve', () => {
    const names = resolveEvolutionNoticeNames(
      reveal(42n, 1, 2, 0n),
      [
        { monsterId: 41n, nickname: 'Wrong' },
        { monsterId: 42n, nickname: 'Sparky' },
        { monsterId: 43n, nickname: 'AlsoWrong' },
      ],
      (id) => (id === 1 ? 'Flameling' : id === 2 ? 'Flamewing' : undefined),
    );
    // WRONG IMPL KILLED: taking `ownMonsters[0]` instead of the matching row —
    //   the roster is unordered (a Map values() walk), so the first entry is
    //   whichever row the store happened to ingest first.
    expect(names.nickname).toBe('Sparky');
    expect(names.fromName).toBe('Flameling');
    expect(names.toName).toBe('Flamewing');
  });

  it('20r-d EN-NAMES-2 BITES: an unknown monster or unknown species yields undefined, never a throw', () => {
    // WRONG IMPL KILLED: `roster.find(...)!.nickname` — the monster may already
    //   have been TRADED AWAY by the time the player dismisses the banner (an
    //   ADR-0254 disclosed residual), so "the reveal names a monster the roster
    //   no longer holds" is a REACHABLE state, not a defensive hypothetical.
    const names = resolveEvolutionNoticeNames(reveal(99n, 1, 2, 0n), [], () => undefined);
    expect(names.nickname).toBeUndefined();
    expect(names.fromName).toBeUndefined();
    expect(names.toName).toBeUndefined();
    // …and the label core still produces the fallback sentence from it.
    expect(evolutionNoticeLabel(reveal(99n, 1, 2, 0n), names)).toBe(
      'Your Species #1 evolved into Species #2!',
    );
  });

  it('20r-d EN-NAMES-3 BITES: the monster match is an exact BIGINT compare — no Number() coercion', () => {
    // WRONG IMPL KILLED: `Number(m.monsterId) === Number(entry.monsterId)`. Both
    //   ids below collapse to the same double, so a coerced compare picks the
    //   WRONG monster and the banner names somebody else's nickname. Monster ids
    //   are server auto_inc u64 — this is the T1d bigint rule the store already
    //   follows for battleId (store.ts:951).
    const names = resolveEvolutionNoticeNames(
      reveal(9007199254740993n, 1, 2, 0n),
      [{ monsterId: 9007199254740992n, nickname: 'Neighbour' }],
      () => undefined,
    );
    expect(
      names.nickname,
      'a Number()-coerced id compare matches 2^53 against 2^53+1 and yields "Neighbour"',
    ).toBeUndefined();
  });

  it('20r-d EN-NAMES-4 BITES: an EMPTY nickname normalises to undefined', () => {
    // WRONG IMPL KILLED: passing the raw `''` through. The label core also
    //   defends against it (EN-LABEL-3), and BOTH sides are pinned on purpose:
    //   this is the resolver's own contract, and a future caller of the resolver
    //   must not have to re-derive the convention.
    const names = resolveEvolutionNoticeNames(
      reveal(42n, 1, 2, 0n),
      [{ monsterId: 42n, nickname: '' }],
      () => 'Flameling',
    );
    expect(names.nickname).toBeUndefined();
  });
});

// ===========================================================================
// The benign-rejection filter.
// ===========================================================================

describe('20r-d EN-BENIGN — isBenignAckRejection', () => {
  it('20r-d EN-BENIGN-1 BITES: both server phrases are benign, and nothing else is', () => {
    // THE TWO BENIGN RACES (ADR-0254 D5 + the client catch at main.ts): a second
    //   tab already drained the queue ("no pending evolution notices"), or its
    //   stale head made the count too large ("… exceeds N pending evolution
    //   notices"). Neither is an error the player should see in the status line.
    // WRONG IMPL KILLED (a): swallowing EVERYTHING (`return true`) — a real
    //   failure (a dead link, a schema skew, a server panic) would then be
    //   invisible, and the banner would sit there with a dead button.
    // WRONG IMPL KILLED (b) ★: swallowing `ack count must be positive`. That
    //   message can ONLY be produced by a client that sent `count: 0`, i.e. by a
    //   bug in this very feature — it must reach the status line.
    // WRONG IMPL KILLED (c): matching on the reducer NAME rather than the
    //   message (every rejection from this reducer would be swallowed).
    //
    // ★ EVERY FIXTURE BELOW IS A TRANSCRIPTION of a message the SERVER actually
    //   produces, and each is pinned WHOLE on the other side of the wire by
    //   `server-module/src/evolution_tests.rs` (the `S20RD_ERR_*` constants:
    //   `s20rd_ack_prefix_truth_table` asserts the 4-of-3 and 1-of-0 spellings and
    //   the zero-count one, `s20rd_ack_rejects_*` assert the no-row and 3-of-2
    //   spellings against the REAL reducer). Neither half may be re-worded alone:
    //   the server pins the sentence, this file pins how the client classifies it.
    //   If a message legitimately changes, both sides are re-derived from ADR-0254
    //   D5 in the same change.
    for (const benign of [
      'no pending evolution notices',
      'ack count 3 exceeds 2 pending evolution notices',
      'ack count 4 exceeds 3 pending evolution notices',
      'ack count 1 exceeds 0 pending evolution notices',
      // …and the same sentences once the SDK has wrapped them (the shape
      // `reduceErrorMessage` hands the classifier at the real call site).
      'ackEvolutionNotices: no pending evolution notices',
    ]) {
      expect(isBenignAckRejection(benign), `"${benign}" must be benign`).toBe(true);
    }
    for (const loud of [
      // The one server rejection that must NOT be swallowed: only a client that
      // sent `count: 0` can produce it.
      'ack count must be positive',
      'not owner',
      '',
      'ackEvolutionNotices',
      'Error: InternalError',
      // Truncations of the two benign phrases — a predicate that matched on these
      // prefixes would also swallow unrelated messages that happen to contain them.
      'no pending',
      'exceed',
    ]) {
      expect(isBenignAckRejection(loud), `"${loud}" must NOT be swallowed`).toBe(false);
    }
  });
});

// ===========================================================================
// The passive DOM banner.
// ===========================================================================

describe('20r-d EN-BANNER — the passive banner shell', () => {
  it('20r-d EN-BANNER-MOUNT BITES: construction APPENDS #evolution-notice to body and leaves siblings alone', () => {
    // WRONG IMPL KILLED ★: `document.body.replaceChildren(el)` — banned repo-wide
    //   by the a11y static-shell rule, and here it would delete the world canvas,
    //   the status line and every overlay the moment the banner mounts. The
    //   sentinel below is what catches it; a `parentElement` check alone does not.
    const sentinel = document.createElement('div');
    sentinel.id = 'sentinel-before-banner';
    document.body.appendChild(sentinel);

    const banner = new EvolutionNoticeBanner(() => Promise.resolve());
    expect(banner).toBeDefined();

    expect(
      document.getElementById('sentinel-before-banner'),
      'constructing the banner must NOT clear document.body — appendChild only, never replaceChildren',
    ).not.toBeNull();
    expect(container().parentElement).toBe(document.body);
    expect(labelEl().tagName).toBe('SPAN');
    expect(
      container().style.display,
      'the banner must start HIDDEN — it is rendered on every batch, and a banner that is visible before its first label shows an empty box on connect',
    ).toBe('none');
    expect(banner.visible).toBe(false);
  });

  it('20r-d EN-BANNER-TOGGLE BITES: render(label) shows with the exact text; render(null) hides', () => {
    // WRONG IMPL KILLED ★ (claimView's own shipped defect, ADR-0254 D6 names it):
    //   writing the text and never un-hiding, so the element exists, carries the
    //   right label, and is invisible forever. `display === ''` is ALSO a failure
    //   here: the claimView `visible` convention treats an empty display as
    //   hidden, so a half-fix would disagree with every other overlay.
    // WRONG IMPL KILLED: a missing hide arm — a dismissed reveal stays on screen
    //   for the life of the page (the rb-51 countdown's documented failure).
    const banner = new EvolutionNoticeBanner(() => Promise.resolve());

    banner.render('Sparky evolved from Flameling into Flamewing!');
    expect(container().style.display).not.toBe('none');
    expect(container().style.display).not.toBe('');
    expect(banner.visible).toBe(true);
    expect(labelEl().textContent).toBe('Sparky evolved from Flameling into Flamewing!');

    banner.render(null);
    expect(container().style.display).toBe('none');
    expect(banner.visible).toBe(false);
  });

  it('20r-d EN-BANNER-TEXT BITES: the label is written with textContent — no child nodes, no innerHTML', () => {
    // WRONG IMPL KILLED: `innerHTML = label`. The label is assembled from a
    //   player-chosen NICKNAME, so an HTML write is a direct injection sink.
    //   `children.length === 0` is the oracle that survives a nickname that
    //   happens to contain no tags today.
    const banner = new EvolutionNoticeBanner(() => Promise.resolve());
    banner.render('<b>Sparky</b> evolved from <i>A</i> into <i>B</i>!');
    expect(labelEl().children.length, 'the label must hold TEXT only — zero element children').toBe(
      0,
    );
    expect(labelEl().textContent).toBe('<b>Sparky</b> evolved from <i>A</i> into <i>B</i>!');
  });

  it('20r-d EN-BANNER-A11Y BITES: no aria-live, no aria-label, no tabindex on any of the three nodes', () => {
    // WHY (ADR-0254 D6): `ui/liveRegion.ts` is the SOLE announcement owner. A
    //   second live region means two utterances race for one AT queue, and this
    //   one would fire on every batch flush. An `aria-label` on the container
    //   would OVERRIDE the visible sentence for AT users with text nobody
    //   reviewed. A `tabindex` puts a passive banner into the Tab order, ahead of
    //   (or inside) whatever overlay is open.
    // WRONG IMPL KILLED: copying the overlay a11y wiring from a *View.ts shell.
    const banner = new EvolutionNoticeBanner(() => Promise.resolve());
    banner.render('Sparky evolved from Flameling into Flamewing!');

    for (const [name, el] of [
      ['container', container()],
      ['label', labelEl()],
      ['ok button', okBtn()],
    ] as const) {
      expect(
        el.getAttribute(ARIA_LIVE_ATTR),
        `${name} must carry NO ${ARIA_LIVE_ATTR} — ui/liveRegion.ts is the sole announcement owner`,
      ).toBeNull();
      expect(
        el.getAttribute(ARIA_LABEL_ATTR),
        `${name} must carry NO ${ARIA_LABEL_ATTR} — it would OVERRIDE the visible sentence for AT users`,
      ).toBeNull();
      expect(
        el.getAttribute(TAB_INDEX_ATTR),
        `${name} must carry NO ${TAB_INDEX_ATTR} — a passive banner stays out of the Tab order`,
      ).toBeNull();
    }
  });

  it('20r-d EN-BANNER-LAYOUT BITES: z-index 60, container pointer-events none, button pointer-events auto', () => {
    // WHY EACH NUMBER (ADR-0254 D6): z-index 60 sits ABOVE `#help-hint` (50) so
    //   the banner is never painted over at narrow widths, and BELOW every
    //   overlay (100) so an open modal's opaque backdrop covers it — which is what
    //   makes "no focus trap, no registry membership" safe.
    // WRONG IMPL KILLED ★: leaving the CONTAINER click-through-able but also
    //   leaving the BUTTON click-through-able — the OK control would be
    //   unclickable, the reveal undismissable, and nothing else in the slice
    //   would notice.
    const banner = new EvolutionNoticeBanner(() => Promise.resolve());
    banner.render('x');
    expect(container().style.zIndex).toBe('60');
    expect(container().style.pointerEvents).toBe('none');
    expect(okBtn().style.pointerEvents).toBe('auto');
  });

  it('20r-d EN-BANNER-BUTTON BITES: the OK control is a NATIVE button with the literal text OK', () => {
    // WHY NATIVE (ADR-0254 D6 / evals keyboard-operable-rows): a real <button> is
    //   Enter- and Space-operable, focusable and announced as a button for free.
    //   A <div role="button"> needs a keydown handler, a tabindex and a role — and
    //   the tabindex is banned here, so the div shape is unreachable by
    //   construction.
    const banner = new EvolutionNoticeBanner(() => Promise.resolve());
    banner.render('x');
    expect(okBtn().tagName).toBe('BUTTON');
    expect(okBtn() instanceof HTMLButtonElement).toBe(true);
    expect(okBtn().textContent).toBe('OK');
  });

  it('20r-d EN-BANNER-CLICK BITES: one click sends once, disables until settle, and re-enables after', async () => {
    // WRONG IMPL KILLED (a): no in-flight lock — a player mashing OK on a 3-entry
    //   chain sends three acks for one entry, and the two extras drain reveals
    //   that were never rendered (the count-based ack's known sharp edge,
    //   ADR-0254 residual 1).
    // WRONG IMPL KILLED (b): a lock that is never released — one ack and the
    //   button is dead for the life of the page.
    const d = deferred();
    const onAck = vi.fn(() => d.promise);
    const banner = new EvolutionNoticeBanner(onAck);
    banner.render('Sparky evolved from Flameling into Flamewing!');

    clickOk();
    expect(onAck).toHaveBeenCalledTimes(1);
    expect(okBtn().disabled, 'the OK button must be disabled while the ack is in flight').toBe(
      true,
    );

    clickOk();
    expect(
      onAck,
      'a SECOND click while the first ack is in flight must not send again — the count-based ack has no idempotency key, so the extra send drains an entry the player never saw',
    ).toHaveBeenCalledTimes(1);

    d.resolve();
    await settle();
    expect(okBtn().disabled, 'settling the ack must RE-ENABLE the button').toBe(false);

    const d2 = deferred();
    onAck.mockImplementation(() => d2.promise);
    clickOk();
    expect(onAck, 'after a settled ack the button must send again').toHaveBeenCalledTimes(2);
    d2.resolve();
    await settle();
  });

  it('20r-d EN-BANNER-REJECT BITES: a REJECTED ack still re-enables the button', async () => {
    // WRONG IMPL KILLED: releasing the lock in `.then()` instead of `.finally()`.
    //   One transient rejection then leaves the banner permanently undismissable
    //   — and the two BENIGN rejections (a two-tab race) are the most likely
    //   rejections this button will ever see.
    // ⚠ IMPLEMENTER: terminate the release chain with `.catch(() => {})` so the
    //   derived promise is handled. See this file's header.
    const d = deferred();
    const onAck = vi.fn(() => d.promise);
    const banner = new EvolutionNoticeBanner(onAck);
    banner.render('x');

    clickOk();
    expect(okBtn().disabled).toBe(true);
    d.reject(new Error('no pending evolution notices'));
    await settle();
    expect(
      okBtn().disabled,
      'a rejected ack must release the lock — `.finally()`, never `.then()`',
    ).toBe(false);
  });

  it('20r-d EN-BANNER-RESET BITES: reset() releases an in-flight lock immediately', async () => {
    // WHY IT EXISTS (ADR-0254 D6): `main.ts` calls `reset()` at the TAIL of
    //   onReconnect. The SDK never settles an in-flight reducer promise after a
    //   link drop (ADR-0085 D3), so without this the OK button is dead for the
    //   rest of the session — for exactly the player whose connection just
    //   flapped mid-chain.
    const d = deferred();
    const onAck = vi.fn(() => d.promise);
    const banner = new EvolutionNoticeBanner(onAck);
    banner.render('x');

    clickOk();
    expect(okBtn().disabled).toBe(true);

    banner.reset();
    expect(okBtn().disabled, 'reset() must re-enable the button at once').toBe(false);

    const d2 = deferred();
    onAck.mockImplementation(() => d2.promise);
    clickOk();
    expect(
      onAck,
      'reset() must also clear the in-flight flag, not just the disabled bit',
    ).toHaveBeenCalledTimes(2);
    d2.resolve();
    await settle();
  });

  it('20r-d EN-BANNER-STALE BITES: a STALE settle after reset() must not release the CURRENT send', async () => {
    // ★ THE GENERATION-TOKEN TOOTH. Sequence: click (send #1) -> reset() (the
    //   reconnect edge) -> click (send #2) -> send #1 finally settles. A release
    //   chain that simply writes `inFlight = false` / `disabled = false` lets the
    //   dead connection's promise unlock a send that is still outstanding, so the
    //   very next click double-acks — draining an entry the player never saw.
    //   Every other banner test in this file passes with that bug in the tree.
    const d1 = deferred();
    const d2 = deferred();
    const onAck = vi.fn(() => d1.promise);
    const banner = new EvolutionNoticeBanner(onAck);
    banner.render('x');

    clickOk(); // send #1
    banner.reset(); // the onReconnect edge
    onAck.mockImplementation(() => d2.promise);
    clickOk(); // send #2 — now in flight
    expect(onAck).toHaveBeenCalledTimes(2);
    expect(okBtn().disabled).toBe(true);

    d1.resolve(); // the STALE settle
    await settle();
    expect(
      okBtn().disabled,
      'the stale send #1 settling must NOT re-enable the button while send #2 is still in flight — mint a generation token on each send and release only when it is still current',
    ).toBe(true);

    clickOk();
    expect(
      onAck,
      'and it must not let a third click through either — the in-flight flag belongs to send #2',
    ).toHaveBeenCalledTimes(2);

    d2.resolve();
    await settle();
    expect(okBtn().disabled, 'send #2 settling releases its own lock').toBe(false);
  });

  it('20r-d EN-BANNER-REPEAT BITES: a HELD key is prevented on the button; a single press is not', () => {
    // WHY (ADR-0254 D6): the banner re-renders on every batch, so a 3-entry chain
    //   repaints the same button with the NEXT entry one frame after each ack. A
    //   held Enter would auto-dismiss the whole chain in a few dozen ms — the
    //   player is told nothing, which is the exact opposite of the criterion.
    // WRONG IMPL KILLED: no keydown handler at all; a handler that calls
    //   preventDefault UNCONDITIONALLY (that kills Enter-to-activate outright and
    //   makes the button mouse-only, breaking keyboard operability).
    const banner = new EvolutionNoticeBanner(() => Promise.resolve());
    banner.render('x');

    expect(keydownOk(true).defaultPrevented, 'a REPEAT keydown must be prevented').toBe(true);
    expect(
      keydownOk(false).defaultPrevented,
      'a single (non-repeat) keydown must NOT be prevented — the native Enter/Space activation is the whole reason this is a <button>',
    ).toBe(false);
  });

  it('20r-d EN-BANNER-IDEMPOTENT BITES: constructing twice REUSES the existing element', () => {
    // WRONG IMPL KILLED: an unconditional `createElement` + `appendChild`, which
    //   after any second construction (a test harness, a future re-init) leaves
    //   two stacked banners, one of them permanently stale.
    const first = new EvolutionNoticeBanner(() => Promise.resolve());
    first.render('x');
    const second = new EvolutionNoticeBanner(() => Promise.resolve());
    second.render('y');

    expect(
      document.querySelectorAll('#evolution-notice').length,
      'exactly ONE #evolution-notice element may exist',
    ).toBe(1);
    expect(document.querySelectorAll('#evolution-notice-ok').length).toBe(1);
    expect(document.querySelectorAll('#evolution-notice-label').length).toBe(1);
  });
});

// ===========================================================================
// Static source discipline — the facts the DOM cannot show.
// ===========================================================================

describe('20r-d EN-SOURCE — evolutionNotice.ts carries no banned affordance', () => {
  it('20r-d EN-SOURCE-1 BITES: zero tabindex / aria-live / .focus( / innerHTML / replaceChildren / matchMedia', () => {
    // WHY A SOURCE SCAN ALONGSIDE THE DOM TESTS: the DOM assertions above read
    //   the state after `render()`. A `.focus()` call made on a path this file
    //   does not drive (a future `show()` door, an error branch) is invisible to
    //   them, and `matchMedia` is invisible to them entirely — happy-dom stubs it
    //   and nothing observable changes. Each needle is a REPO RULE, not a style
    //   preference:
    //     tabindex     — a passive banner must stay out of the Tab order;
    //     aria-live    — ui/liveRegion.ts is the sole announcement owner;
    //     .focus(      — stealing focus from an open overlay's trap;
    //     innerHTML    — the label carries a player-chosen nickname;
    //     replaceChildren — the a11y static-shell ban (it would clear <body>);
    //     matchMedia   — the reduced-motion purity rule; this shell animates
    //                    nothing, so a motion-preference read is dead weight
    //                    that the reduced-motion eval would then have to model.
    // Comment-stripped first, so the file may (and should) EXPLAIN in prose why
    // each of these is absent without tripping its own gate.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'evolutionNotice.ts'),
      'utf8',
    );
    const stripped = stripComments(src);

    // ANTI-VACUITY, ASSERTED FIRST: the stripper left real code behind, and this
    // really is the module under test.
    expect(
      stripped.length,
      'comment-stripped evolutionNotice.ts collapsed to under a quarter of its raw size — the stripper bailed early and every ban below would judge a prefix',
    ).toBeGreaterThan(src.length / 4);
    for (const required of ['evolutionNoticeLabel', 'EvolutionNoticeBanner', 'addEventListener']) {
      expect(
        stripped.indexOf(required),
        `ANTI-VACUITY: the stripped source must still contain \`${required}\` — otherwise the zeros below are a broken scan, not an absence`,
      ).toBeGreaterThanOrEqual(0);
    }

    // FRAGMENT-ASSEMBLED, like every production needle in this repo's scan
    // files: several evals read `client/**` RAW (test files included), so a
    // contiguous copy of one of these markers in a TEST would poison their
    // scans. The fragments also make this file immune to being its own subject.
    for (const banned of [
      ['tab', 'Index'].join(''),
      TAB_INDEX_ATTR,
      ARIA_LIVE_ATTR,
      ['.foc', 'us('].join(''),
      ['inner', 'HTML'].join(''),
      ['replace', 'Children'].join(''),
      ['match', 'Media'].join(''),
    ]) {
      expect(
        stripped.split(banned).length - 1,
        `client/src/ui/evolutionNotice.ts must contain ZERO occurrences of \`${banned}\` as CODE (comments are stripped first, so explaining the absence is free)`,
      ).toBe(0);
    }
  });
});

/** Drop block comments, then line comments. Marker scan, never a regex —
 *  `new RegExp` is banned repo-wide and a regex literal blinds the repo's own
 *  comment strippers. Copied in FORM from connection.test.ts. */
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
