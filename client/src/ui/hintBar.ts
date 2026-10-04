// ui/hintBar.ts — paints the live hint bar (ctl-13, CTL13.1) and the request banner (CTL13.2) into
// client/index.html's #hint-bar. A keyed reconcile on `data-button`: the shipped Start and Select
// buttons (their ids and click launchers) are reused, and every other chip is a span that takes no
// pointer events until ctl-15 gives it a click. Text only (textContent, never markup: a banner
// carries a player name), no focus moves, no live region (ui/liveRegion.ts announces). A render
// identical to the last one touches nothing, so the frame loop can call it every frame.
import type { HintChip } from './hintBarModel';
import { t } from './i18n/resolver';

/** Set `el`'s text only when it differs, so an unchanged part is never rewritten. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** The chip's `cls` part, created on first use. */
function partOf(chip: HTMLElement, cls: string): HTMLElement {
  const found = chip.querySelector(`:scope > .${cls}`);
  if (found instanceof HTMLElement) return found;
  const el = chip.ownerDocument.createElement('span');
  el.className = cls;
  chip.appendChild(el);
  return el;
}

export class HintBarView {
  readonly #root: HTMLElement;
  readonly #banner: HTMLElement;
  /** Every chip node ever shown, by button: a dropped chip comes back as the same node. */
  readonly #chips = new Map<string, HTMLElement>();
  #last = '';

  constructor(root: HTMLElement) {
    this.#root = root;
    for (const el of root.querySelectorAll<HTMLElement>('[data-button]')) {
      const button = el.dataset.button;
      if (button !== undefined) this.#chips.set(button, el);
    }
    const banner = root.ownerDocument.createElement('div');
    banner.id = 'notice-banner';
    banner.hidden = true;
    root.prepend(banner);
    this.#banner = banner;
  }

  render(chips: readonly HintChip[], banner: string | null): void {
    const sig = JSON.stringify([chips.map((c) => [c.button, c.keycap, c.verb, c.badge]), banner]);
    if (sig === this.#last) return;
    this.#last = sig;

    if (banner === null) this.#banner.hidden = true;
    else {
      setText(this.#banner, banner);
      this.#banner.hidden = false;
    }

    const shown = chips.map((chip) => this.#paint(chip));
    for (const [, el] of this.#chips) if (!shown.includes(el)) el.remove();
    // Model order, after the banner; a node already in place is not moved.
    shown.forEach((el, i) => {
      const at = this.#root.children[i + 1] ?? null;
      if (at !== el) this.#root.insertBefore(el, at);
    });
  }

  #paint(chip: HintChip): HTMLElement {
    let el = this.#chips.get(chip.button);
    if (el === undefined) {
      el = this.#root.ownerDocument.createElement('span');
      el.className = 'mr-chip';
      el.dataset.button = chip.button;
      el.style.pointerEvents = 'none';
      this.#chips.set(chip.button, el);
    }
    setText(partOf(el, 'mr-chip-key'), chip.keycap);
    setText(partOf(el, 'mr-chip-verb'), chip.verb);
    const badge = el.querySelector(':scope > .mr-chip-badge');
    if (chip.badge) setText(partOf(el, 'mr-chip-badge'), t('chrome.badge.request'));
    else badge?.remove();
    return el;
  }
}
