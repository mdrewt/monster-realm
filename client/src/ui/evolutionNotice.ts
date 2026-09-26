// ui/evolutionNotice.ts — the POST-EVOLVE REVEAL: a pure copy core plus the small passive
// banner that shows it (20r-d, ADR-0254 D6; spec §20r-d gate B1 "the player SHALL see"; the
// announcement and focus-return mechanism below is rb-125, ADR-0272).
//
// WHY A PASSIVE BANNER AND NOT AN ADR-0162 REGISTRY OVERLAY. B1 asks for VISIBILITY, not for a
// modal: "a visible reveal … a modest overlay/banner … satisfies this slice". Everything in the
// overlay registry is a thing the player OPENED and can close, with a focus trap, an accessible
// name in `ui/a11yCopy.ts` and custody of the live region. This surface is none of those — it
// appears because the server did something, and it owns exactly one control. Registering it
// would buy a focus trap it must not have (it would steal focus from whatever the player is
// actually doing) and a second announcement owner. The file is deliberately NOT named
// `*View.ts`: the two readdir rosters that drive the overlay a11y manifests filter on that
// suffix, and joining them would force a ~17-file fan-out plus a twelfth static `aria-modal`
// shell for a surface that is not modal. The cutscene/registry route is the disclosed residual
// (rb-125 measured that route before choosing this one — see ADR-0272's Context).
//
// WHY z-index 60. `#help-hint` sits at 50 at the bottom of the screen and every overlay sits at
// 100. 60 is therefore above the hint — so the banner is never painted over or click-stolen at
// narrow widths — and below every overlay, so an open modal's opaque `inset: 0` backdrop covers
// the OK button. That is what makes "no focus trap, no registry membership" SAFE rather than
// merely cheap: while a modal is open this banner is neither visible nor reachable.
//
// WHY NO aria-live ON THIS ELEMENT, AND WHY THE ANNOUNCEMENT IS INJECTED (ADR-0272 §1). The AT
// gap ADR-0254 D6 disclosed is closed, but not by turning this banner into a second announcement
// owner: the one live region (ui/liveRegion.ts) still owns the single assistive-technology queue,
// and this file never names it — it reaches it only through the `sinks.announce` callback
// `main.ts` hands the constructor. An `aria-live` attribute on the container would still be wrong
// for the reason it always was: two regions race one queue, and this banner re-renders on every
// store batch, i.e. several times a second in a busy zone. The container also carries no
// `aria-label` of its own — an authored name would OVERRIDE the visible sentence for AT users
// with copy nobody reviewed — and it stays out of the Tab order, because a passive banner must
// not insert itself ahead of (or inside) whatever the player has open. The banner is
// edge-triggered instead of live: `render` calls `sinks.announce` exactly once per distinct
// `evolutionNoticeKey`, never again for a re-render of the same entry (a late species name is a
// label change, not a new key), so the caller-owned live region is the one and only voice.
//
// WHY THE `e.repeat` GUARD. The banner re-renders on EVERY store batch, so a three-step
// evolution chain repaints the SAME button with the next entry one frame after each ack. A held
// Enter would therefore auto-dismiss the whole chain in a few dozen milliseconds and the player
// would be told nothing — the exact opposite of the criterion. The guard cancels only REPEAT
// keydowns; a single press must still activate natively, which is the whole reason this control
// is a real `<button>` (Enter/Space, focusable and announced as a button for free) rather than a
// styled div — a div would need a role, a keydown handler and a position in the Tab order, and
// the last of those is banned here, so the div shape is unreachable by construction.
//
// WHY A GENERATION TOKEN AND NOT A BOOLEAN. The ack is count-based and carries no idempotency
// key (ADR-0254 D4), so a second send drains an entry the player never saw. A plain
// `inFlight = false` release is not enough: `main.ts` calls `reset()` on the reconnect edge, and
// the SDK never settles a reducer promise issued on a dropped link (ADR-0085 D3) — that stale
// promise can settle LATER, after a fresh send is already outstanding, and unlock it. Minting a
// fresh token per send and releasing only while it is still the current one — by REMOVING the
// `aria-disabled` lock (ADR-0272 §2), never by writing the `disabled` property or attribute —
// makes the stale settle a no-op. The release rides `.finally`, never `.then`: the two most
// likely rejections this button will ever see are the benign two-tab races below, and a `.then`
// release would leave the banner permanently undismissable after one of them.
//
// WHAT IS DELIBERATELY ABSENT FROM THIS FILE, and would be a defect if added: any write to the
// Tab-order attribute; a live-region attribute; a DIRECT `.focus()` call — ADR-0272 §3 moves the
// WHERE to `main.ts`'s injected `returnFocus` sink, so this file only decides WHEN, by checking
// whether `document.activeElement` sat inside the banner the instant before it hides; an
// HTML-string write (the label is assembled from a player-chosen NICKNAME, so it is an injection
// sink — text only, always); a whole-body child replacement (it would delete the world canvas);
// and a motion-preference media query (this shell animates nothing, so reading one is dead
// weight the reduced-motion eval would then have to model).
//
// m24-s5 (ADR-0261) — every player-facing string here is resolved through the i18n resolver
// (`t()`/`tf()`, ui/i18n/resolver.ts): the species fallback and the two reveal sentences as
// `tf()` return values (species/nickname names are model data, interpolated verbatim — the
// nickname is plain interpolation, as `pvp.incoming.label`'s challenger is), and the OK label in
// `render()` — every store batch, unconditionally, never in the constructor (S6 may negotiate the
// locale after the banner is constructed). The `speciesLabel` ternary sits OUTSIDE the call:
// every `t(`/`tf(` first argument is a string LITERAL.

import type { StoreEvolutionReveal } from '../net/store';
import { t, tf } from './i18n/resolver';

/** The three display names a reveal needs, each already resolved or known-absent.
 *  `undefined` means "no name" and is rendered as a `Species #N` fallback, never as the
 *  string "undefined" and never as an empty gap in the sentence. */
export interface EvolutionNoticeNames {
  readonly nickname: string | undefined;
  readonly fromName: string | undefined;
  readonly toName: string | undefined;
}

/** A species name, or the `Species #N` fallback. The fallback is REACHABLE, not defensive:
 *  `species_row` arrives on a separate subscription, so "the reveal lands before the content
 *  table" is an ordinary startup race. An EMPTY name is treated as missing for the same
 *  reason the nickname is (below) — a blank gap reads as a rendering bug. */
function speciesLabel(name: string | undefined, id: number): string {
  return name === undefined || name === '' ? tf('evolutionNotice.species.fallback', { id }) : name;
}

/**
 * The player-facing sentence for ONE reveal. TOTAL: no clock, no DOM, no store, no throw —
 * it runs inside a `store.onBatchApplied` listener, and although `flushBatch` isolates per
 * listener, a throw still costs that listener its whole frame, including the render that
 * would have HIDDEN a stale banner.
 *
 * An EMPTY nickname takes the un-nicknamed branch. The store carries an un-nicknamed monster
 * as `nickname: ''` all the way from the server (`Monster.nickname` is `String::new()`), so
 * "the nickname is present" cannot mean "the field exists": a `!== undefined` test alone
 * ships " evolved from Flameling into Flamewing!" — a leading space and no subject.
 */
export function evolutionNoticeLabel(
  entry: StoreEvolutionReveal,
  names: EvolutionNoticeNames,
): string {
  const from = speciesLabel(names.fromName, entry.fromSpecies);
  const to = speciesLabel(names.toName, entry.toSpecies);
  const nickname = names.nickname;
  if (nickname !== undefined && nickname !== '') {
    return tf('evolutionNotice.reveal.nicknamed', { nickname, from, to });
  }
  return tf('evolutionNotice.reveal.anonymous', { from, to });
}

/**
 * The pure per-entry-IDENTITY key (rb-125, ADR-0272 §1): monster id, both species ids and the
 * transaction timestamp, joined with `:`. Every field is written straight into the template
 * literal — a bigint stringifies EXACTLY that way, and `Number(entry.monsterId)` anywhere here
 * would alias 2^53 with 2^53+1 (monster ids are server `#[auto_inc]` u64) and treat two
 * DIFFERENT monsters' reveals as one entry.
 *
 * The species pair is part of the key, not just the monster id and timestamp, because one
 * evolution CHAIN shares both a `monsterId` and an `evolvedAtMs` (the transaction clock) across
 * its links — a key that dropped the species pair would collapse two distinct chain steps
 * (1->5 then 5->9) into the same identity, and the second step would never be announced. The key
 * is never built from `label`: species names arrive on a separate subscription, so a label-keyed
 * scheme would re-announce the same entry the moment a name lands (`Species #5` -> `Flamewing`).
 */
export function evolutionNoticeKey(entry: StoreEvolutionReveal): string {
  return `${entry.monsterId}:${entry.fromSpecies}:${entry.toSpecies}:${entry.evolvedAtMs}`;
}

/**
 * Resolve the three names for `entry` from the caller's OWN monster roster and the species
 * content table. Pure: both inputs are handed in, so this stays directly unit-testable and
 * `main.ts` — which is excluded from the coverage denominator — holds no copy logic.
 *
 * The roster match is an EXACT bigint compare. Monster ids are server `#[auto_inc]` u64, so a
 * `Number()`-coerced compare aliases 2^53 with 2^53+1 and names somebody else's monster. A
 * MISS is an ordinary outcome, not an error: a monster may have been traded away between the
 * reveal and the dismissal (a disclosed ADR-0254 residual), so this never asserts a hit.
 */
export function resolveEvolutionNoticeNames(
  entry: StoreEvolutionReveal,
  ownMonsters: readonly { readonly monsterId: bigint; readonly nickname: string }[],
  speciesName: (id: number) => string | undefined,
): EvolutionNoticeNames {
  let nickname: string | undefined;
  for (const monster of ownMonsters) {
    if (monster.monsterId === entry.monsterId) {
      nickname = monster.nickname === '' ? undefined : monster.nickname;
      break;
    }
  }
  return {
    nickname,
    fromName: speciesName(entry.fromSpecies),
    toName: speciesName(entry.toSpecies),
  };
}

/** The two REJECTION phrases that mean "another tab already drained this entry". Either the
 *  queue is empty for this sender, or the stale head made the count too large. Both are
 *  millisecond races between two live tabs, i.e. NORMAL states for a count-based ack — and
 *  neither is something the player should read as an error. */
const BENIGN_ACK_PHRASES: readonly string[] = ['no pending evolution notices', 'exceeds'];

/**
 * Is `message` (already reduced by `ui/statusModel.ts`'s `reduceErrorMessage`) one of the two
 * benign stale-banner races? Everything else — a dead link, a schema skew, a server panic, and
 * in particular `ack count must be positive`, which only a bug in THIS feature can provoke —
 * must reach the status line. A predicate that returned `true` unconditionally would leave the
 * player pressing an OK button that silently does nothing.
 */
export function isBenignAckRejection(message: string): boolean {
  for (const phrase of BENIGN_ACK_PHRASES) {
    if (message.includes(phrase)) return true;
  }
  return false;
}

const CONTAINER_ID = 'evolution-notice';
const LABEL_ID = 'evolution-notice-label';
const OK_ID = 'evolution-notice-ok';

/** Find `id` or create it under `parent` — `appendChild` only, so mounting this banner can
 *  never disturb the surfaces already on the page (the `claimView.ts` ensureElement shape). */
function ensureElement(id: string, tag: string, parent: HTMLElement): HTMLElement {
  const found = document.getElementById(id);
  if (found !== null) return found;
  const el = document.createElement(tag);
  el.id = id;
  parent.appendChild(el);
  return el;
}

/** The content ONE render call shows, or `null` to hide the banner. `key` is
 *  `evolutionNoticeKey(entry)` — the identity `render` edge-triggers the announce sink on;
 *  `label` is the player-facing sentence (rb-125, ADR-0272 §1). */
export interface EvolutionNoticeContent {
  readonly key: string;
  readonly label: string;
}

/** The two effects `main.ts` performs on this banner's behalf (rb-125, ADR-0272). Neither is
 *  named by this file: `announce` reaches the one live region (`ui/liveRegion.ts`) and
 *  `returnFocus` reaches the house landing place (ADR-0206) — this module only decides WHEN
 *  each fires, never WHERE it lands. */
export interface EvolutionNoticeSinks {
  readonly announce: (message: string) => void;
  readonly returnFocus: () => void;
}

/**
 * The passive reveal banner: a centred strip near the bottom of the screen carrying ONE
 * sentence and one OK button. It is find-or-create, so constructing it twice reuses the
 * existing nodes rather than stacking a second, permanently stale banner.
 *
 * It starts HIDDEN and is rendered on every store batch, so it must never show an empty box
 * before its first label. `render(null)` hides it again — without that arm a dismissed reveal
 * would stay on screen for the life of the page and every further OK press would reject.
 *
 * rb-125 (ADR-0272): the constructor also takes a required `sinks` pair. `announce` fires once
 * per distinct entry `key`, the first time `render` shows it — this class decides WHEN, `main.ts`
 * decides WHERE the sentence is spoken. `returnFocus` fires from `render(null)` only when focus
 * sat inside this banner the instant before it hid — again, WHEN lives here, WHERE lives in
 * `main.ts`.
 */
export class EvolutionNoticeBanner {
  readonly #container: HTMLElement;
  readonly #label: HTMLElement;
  readonly #okBtn: HTMLButtonElement;
  readonly #sinks: EvolutionNoticeSinks;
  /** The CURRENT send's identity, or `null` when idle. An opaque object, never a counter:
   *  identity comparison cannot collide, wrap or be forged by a stale settle. */
  #pending: object | null = null;
  /** The last entry `key` the announce sink has ever been called for, or `null` before the
   *  first reveal. Deliberately NEVER cleared — not on `render(null)`, not by `reset()` — a
   *  hide-then-reshow of the SAME key only happens across a reconnect or a store reset, and
   *  re-speaking an entry every AT user already heard on every link flap is exactly the noise
   *  ADR-0272 §1 bans. */
  #announcedKey: string | null = null;

  constructor(onAck: () => Promise<void>, sinks: EvolutionNoticeSinks) {
    this.#sinks = sinks;
    this.#container = ensureElement(CONTAINER_ID, 'div', document.body);
    this.#container.style.position = 'fixed';
    this.#container.style.bottom = '48px';
    this.#container.style.left = '50%';
    this.#container.style.transform = 'translateX(-50%)';
    this.#container.style.zIndex = '60';
    // The strip itself is click-through so it never steals a click meant for the world; the
    // button below re-enables pointer events for itself alone. Leaving BOTH click-through
    // would make the reveal undismissable and nothing else in the slice would notice.
    this.#container.style.pointerEvents = 'none';
    this.#container.style.display = 'none';
    this.#container.style.font = '12px/1.4 monospace';
    this.#container.style.color = '#e8f6ff';
    this.#container.style.background = 'rgba(12, 32, 60, 0.86)';
    this.#container.style.padding = '4px 10px';
    this.#container.style.borderRadius = '3px';

    this.#label = ensureElement(LABEL_ID, 'span', this.#container);
    this.#label.style.marginRight = '8px';

    // The OK control, adopted if it is already on the page and otherwise built here. The
    // `document.createElement('button')` literal is written out in the RECEIVER'S OWN binding
    // rather than behind a helper: the keyboard-operability scan reads a click receiver's
    // native evidence from that binding, and a helper call, a ternary tag or a computed tag all
    // read (correctly) as forged evidence. A real `<button>` is Enter/Space-operable, focusable
    // and announced as a button for free, which is the whole reason this is not a styled div.
    // Its label is resolved in `render()` (header), not here — the banner starts hidden, so the
    // empty button is never seen before its first render.
    const existing = document.getElementById(OK_ID) as HTMLButtonElement | null;
    const okBtn = existing ?? document.createElement('button');
    okBtn.id = OK_ID;
    okBtn.style.pointerEvents = 'auto';
    if (okBtn.parentElement !== this.#container) this.#container.appendChild(okBtn);

    okBtn.addEventListener('click', () => {
      if (this.#pending !== null) return;
      const token = {};
      this.#pending = token;
      // ADR-0272 §2: the in-flight lock is `aria-disabled`, never the `disabled` PROPERTY. The
      // HTML focus-fixup rule blurs a focused control the instant `disabled` becomes true, which
      // would strand a keyboard player on <body> mid-chain; `aria-disabled` carries no such
      // fixup, so the button — and the player's place in the Tab order — survives the ack.
      okBtn.setAttribute('aria-disabled', 'true');
      onAck()
        .finally(() => {
          if (this.#pending === token) {
            this.#pending = null;
            okBtn.removeAttribute('aria-disabled');
          }
        })
        .catch(() => {});
    });

    okBtn.addEventListener('keydown', (e) => {
      if (e.repeat) e.preventDefault();
    });

    this.#okBtn = okBtn;
  }

  /** Show `notice`, or hide the banner when it is `null`. The DOM writes come first (label
   *  `textContent` only — the sentence embeds a player-chosen nickname — and the OK label,
   *  re-resolved on every call, m24-s5), then the announce sink is invoked at most once per
   *  distinct `key`, then the focus sink is invoked at most once per hide. A throwing sink can
   *  therefore neither leave a stale banner on screen nor re-fire on the next batch (ADR-0272
   *  §1).
   *
   *  `hadFocus` is read from `document.activeElement` BEFORE the hide's DOM writes run, because
   *  a real browser's blur fixup for a control that leaves the tree is asynchronous — reading it
   *  afterwards could observe a focus the browser has not moved yet. It is read on the
   *  visible-to-hidden EDGE only: if the sink cannot move focus (the canvas is not mounted yet),
   *  focus stays inside the hidden strip, and a level check would re-fire the sink on every
   *  later store batch. */
  render(notice: EvolutionNoticeContent | null): void {
    const hadFocus =
      notice === null && this.visible && this.#container.contains(document.activeElement);
    this.#label.textContent = notice === null ? '' : notice.label;
    this.#okBtn.textContent = t('evolutionNotice.ok');
    this.#container.style.display = notice === null ? 'none' : 'block';
    if (notice !== null && notice.key !== this.#announcedKey) {
      this.#announcedKey = notice.key;
      this.#sinks.announce(notice.label);
    }
    if (notice === null && hadFocus) this.#sinks.returnFocus();
  }

  get visible(): boolean {
    return this.#container.style.display !== 'none' && this.#container.style.display !== '';
  }

  /** Drop the in-flight lock immediately (the `main.ts` reconnect edge). Clearing the token
   *  as well as removing `aria-disabled` is what makes the dropped link's late settle inert.
   *  The last-announced key is untouched — see `#announcedKey`'s own doc comment. */
  reset(): void {
    this.#pending = null;
    this.#okBtn.removeAttribute('aria-disabled');
  }
}
