// ui/evolutionNotice.ts — the POST-EVOLVE REVEAL: a pure copy core plus the small passive
// banner that shows it (20r-d, ADR-0254 D6; spec §20r-d gate B1 "the player SHALL see").
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
// shell for a surface that is not modal. The cutscene/registry route is the disclosed residual.
//
// WHY z-index 60. `#help-hint` sits at 50 at the bottom of the screen and every overlay sits at
// 100. 60 is therefore above the hint — so the banner is never painted over or click-stolen at
// narrow widths — and below every overlay, so an open modal's opaque `inset: 0` backdrop covers
// the OK button. That is what makes "no focus trap, no registry membership" SAFE rather than
// merely cheap: while a modal is open this banner is neither visible nor reachable.
//
// WHY NO aria-live AND NO SECOND ANNOUNCEMENT OWNER. `ui/liveRegion.ts` is the sole announcement
// owner (ADR-0205); two regions race for one assistive-technology queue. This one would fire on
// every batch flush, i.e. several times a second in a busy zone. It also carries no accessible
// name of its own — an authored name on the container would OVERRIDE the visible sentence for
// AT users with copy nobody reviewed — and it stays out of the Tab order, because a passive
// banner must not insert itself ahead of (or inside) whatever the player has open. The AT gap is a
// disclosed residual, closed together with the cutscene.
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
// fresh token per send and releasing only while it is still the current one makes the stale
// settle a no-op. The release rides `.finally`, never `.then`: the two most likely rejections
// this button will ever see are the benign two-tab races below, and a `.then` release would
// leave the banner permanently undismissable after one of them.
//
// WHAT IS DELIBERATELY ABSENT FROM THIS FILE, and would be a defect if added: any write to the
// Tab-order attribute; a live-region attribute; a focus call; an HTML-string write (the label is
// assembled from a player-chosen NICKNAME, so it is an injection sink — text only, always); a
// whole-body child replacement (it would delete the world canvas); and a motion-preference
// media query (this shell animates nothing, so reading one is dead weight the reduced-motion
// eval would then have to model).

import type { StoreEvolutionReveal } from '../net/store';

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
  return name === undefined || name === '' ? `Species #${id}` : name;
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
    return `${nickname} evolved from ${from} into ${to}!`;
  }
  return `Your ${from} evolved into ${to}!`;
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

/**
 * The passive reveal banner: a centred strip near the bottom of the screen carrying ONE
 * sentence and one OK button. It is find-or-create, so constructing it twice reuses the
 * existing nodes rather than stacking a second, permanently stale banner.
 *
 * It starts HIDDEN and is rendered on every store batch, so it must never show an empty box
 * before its first label. `render(null)` hides it again — without that arm a dismissed reveal
 * would stay on screen for the life of the page and every further OK press would reject.
 */
export class EvolutionNoticeBanner {
  readonly #container: HTMLElement;
  readonly #label: HTMLElement;
  readonly #okBtn: HTMLButtonElement;
  /** The CURRENT send's identity, or `null` when idle. An opaque object, never a counter:
   *  identity comparison cannot collide, wrap or be forged by a stale settle. */
  #pending: object | null = null;

  constructor(onAck: () => Promise<void>) {
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
    const existing = document.getElementById(OK_ID) as HTMLButtonElement | null;
    const okBtn = existing ?? document.createElement('button');
    okBtn.id = OK_ID;
    okBtn.textContent = 'OK';
    okBtn.style.pointerEvents = 'auto';
    if (okBtn.parentElement !== this.#container) this.#container.appendChild(okBtn);

    okBtn.addEventListener('click', () => {
      if (this.#pending !== null) return;
      const token = {};
      this.#pending = token;
      okBtn.disabled = true;
      onAck()
        .finally(() => {
          if (this.#pending === token) {
            this.#pending = null;
            okBtn.disabled = false;
          }
        })
        .catch(() => {});
    });

    okBtn.addEventListener('keydown', (e) => {
      if (e.repeat) e.preventDefault();
    });

    this.#okBtn = okBtn;
  }

  /** Show `label`, or hide the banner when it is `null`. Text is written with `textContent`
   *  only: the sentence embeds a player-chosen nickname. */
  render(label: string | null): void {
    this.#label.textContent = label ?? '';
    this.#container.style.display = label === null ? 'none' : 'block';
  }

  get visible(): boolean {
    return this.#container.style.display !== 'none' && this.#container.style.display !== '';
  }

  /** Drop the in-flight lock immediately (the `main.ts` reconnect edge). Clearing the token
   *  as well as the disabled bit is what makes the dropped link's late settle inert. */
  reset(): void {
    this.#pending = null;
    this.#okBtn.disabled = false;
  }
}
