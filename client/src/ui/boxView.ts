// ui/boxView.ts — thin DOM shell for the box/party screen (M6c, ADR-0014).
//
// Renders MonsterCardViewModels produced by boxModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes — one-way flow only.
// The loop calls refresh() on batch-applied; the user triggers reducer intents
// via callbacks passed at construction (never called directly by this module).
//
// m23-s4 (M23 §2.2, ADR-0205 D1/D2/A3) — overlay a11y wiring. This view is a CONSTRUCTED shell:
// its root is `document.createElement`'d here and appended into the shared `#app` MOUNT, so unlike
// the ten static shells S3 wired it ships NO ARIA of its own from `client/index.html` — every
// attribute below comes from `openOverlayA11y`, never from a literal in this file.
//
// THE EDGE, AND WHY IT IS READ FIRST. `wasVisible` is read as the FIRST statement of `show()`,
// before any write. A re-open tears down and re-schedules `openOverlayA11y`'s deferred focus, which
// drags focus off whatever control the player had Tabbed to — invisible to every attribute
// assertion, since a re-open rewrites the same values.
//
// AND WHY THE CLOSE IS DELIBERATELY UNGUARDED. `hide()` calls `closeOverlayA11y` every time, even
// when already hidden. A guarded close reads correct and passes every other assertion while
// permanently leaking a live capture listener, a pending timer and an expiring return target
// whenever a record desynchronises from the DOM; `closeOverlayA11y` with no record is a documented
// pure no-op, so unguarded is the self-healing path. S3's red-team measured the guarded shape
// shipping 62/62 green.
//
// THE OPEN IS THE LAST STATEMENT of the open path, after the display write: in a real browser
// `.focus()` on a `display:none` node is a silent no-op, so an open-before-paint overlay announces
// itself and then never receives focus.
//
// NO CLOSE-BEFORE-OPEN. `ui/overlayA11y.ts`'s cross-slice contract (a) says the four `#app`-mounted
// views "share ONE root" and that S4 must therefore close-before-open. That is a misstatement of
// this code: each view creates its OWN root and appends it into the shared MOUNT, so there are four
// distinct roots, four distinct `OverlayId`s and four distinct records. Closing a sibling here would
// close an overlay the player still has open. Pinned by `S4-CROSS-VIEW-DISTINCT-ROOTS`.
import type { MonsterCardViewModel } from './boxModel';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

export interface BoxViewCallbacks {
  /** Called when the user confirms a nickname edit. */
  readonly onSetNickname: (monsterId: bigint, nickname: string) => void;
  /** Called when the user moves a monster to a party slot (0–5) or to box (255). */
  readonly onSetPartySlot: (monsterId: bigint, slot: number) => void;
  /** Called when the user clicks the Heal Party button (M7c). */
  readonly onHealParty: () => void;
}

const BOX_SLOT = 255;

export class BoxView {
  readonly #root: HTMLDivElement;
  readonly #partyEl: HTMLDivElement;
  readonly #boxEl: HTMLDivElement;
  /** Static box-vs-party explainer (ux4, ADR-0155); never toggled — it states an invariant. */
  readonly #hintEl: HTMLDivElement;
  readonly #callbacks: BoxViewCallbacks;
  #visible = false;

  constructor(parent: HTMLElement, callbacks: BoxViewCallbacks) {
    this.#callbacks = callbacks;

    this.#root = document.createElement('div');
    this.#root.style.cssText =
      'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.75);' +
      'display:none;flex-direction:column;align-items:center;padding:24px;' +
      'overflow-y:auto;font-family:monospace;color:#e0e0e0;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:16px;margin-bottom:16px;';
    const title = document.createElement('h2');
    title.textContent = 'Party & Box';
    // m23-s4: the OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'box-title');
    title.setAttribute('tabindex', '-1');
    title.style.cssText = 'margin:0;color:#fff;';
    header.appendChild(title);
    const healBtn = document.createElement('button');
    healBtn.textContent = 'Heal Party';
    healBtn.style.cssText =
      'padding:4px 12px;cursor:pointer;font-family:monospace;background:#2a3a2a;color:#8f8;border:1px solid #4a4;border-radius:3px;';
    healBtn.addEventListener('click', () => this.#callbacks.onHealParty());
    header.appendChild(healBtn);
    this.#root.appendChild(header);

    // ux4 (ADR-0155): a direct #root child, so it cannot be wiped by #renderParty / #renderBox,
    // which only touch #partyEl / #boxEl. A SIBLING of `header`, never wrapping it:
    // three client/e2e/recruit.spec.ts sites resolve this root as
    // h2['Party & Box'].parentElement.parentElement, and a wrapper retargets that chain.
    // The copy DESCRIBES the "To Party" button (#renderCard) rather than commanding a click —
    // the empty-box short-circuit below renders no such button in the fresh-player state.
    this.#hintEl = document.createElement('div');
    this.#hintEl.setAttribute('data-testid', 'box-party-hint');
    this.#hintEl.textContent =
      'Only monsters in your Party can battle or be swapped in. New recruits arrive in your ' +
      'Box — each box monster has a "To Party" button that moves it into an open party slot.';
    this.#hintEl.style.cssText = 'max-width:600px;margin:0 0 12px;font-size:12px;color:#aaa;';
    this.#root.appendChild(this.#hintEl);

    const partyLabel = document.createElement('h3');
    partyLabel.textContent = 'Party';
    partyLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#root.appendChild(partyLabel);

    this.#partyEl = document.createElement('div');
    this.#partyEl.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:600px;margin-bottom:16px;';
    this.#root.appendChild(this.#partyEl);

    const boxLabel = document.createElement('h3');
    boxLabel.textContent = 'Box';
    boxLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#root.appendChild(boxLabel);

    this.#boxEl = document.createElement('div');
    this.#boxEl.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:600px;';
    this.#root.appendChild(this.#boxEl);

    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  toggle(): void {
    this.#visible ? this.hide() : this.show();
  }

  show(): void {
    const wasVisible = this.#visible;
    this.#visible = true;
    this.#root.style.display = 'flex';
    if (!wasVisible) openOverlayA11y('boxView', this.#root);
  }

  hide(): void {
    this.#visible = false;
    this.#root.style.display = 'none';
    closeOverlayA11y('boxView', null);
  }

  refresh(
    partySlots: readonly (MonsterCardViewModel | null)[],
    boxMonsters: readonly MonsterCardViewModel[],
  ): void {
    this.#renderParty(partySlots);
    this.#renderBox(boxMonsters);
  }

  #renderParty(slots: readonly (MonsterCardViewModel | null)[]): void {
    this.#partyEl.replaceChildren();
    for (let i = 0; i < slots.length; i++) {
      const card = slots[i];
      const el = document.createElement('div');
      el.style.cssText =
        'border:1px solid #444;border-radius:4px;padding:8px;min-height:80px;background:#1a1a2e;';
      if (card === null) {
        el.textContent = `Slot ${i}: (empty)`;
        el.style.opacity = '0.4';
      } else {
        el.appendChild(this.#renderCard(card, true));
      }
      this.#partyEl.appendChild(el);
    }
  }

  #renderBox(monsters: readonly MonsterCardViewModel[]): void {
    this.#boxEl.replaceChildren();
    if (monsters.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No monsters in box.';
      empty.style.opacity = '0.4';
      this.#boxEl.appendChild(empty);
      return;
    }
    for (const card of monsters) {
      const el = document.createElement('div');
      el.style.cssText = 'border:1px solid #444;border-radius:4px;padding:8px;background:#1a1a2e;';
      el.appendChild(this.#renderCard(card, false));
      this.#boxEl.appendChild(el);
    }
  }

  #renderCard(card: MonsterCardViewModel, inParty: boolean): HTMLDivElement {
    const wrap = document.createElement('div');

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = card.nickname || card.speciesName;
    nameSpan.style.fontWeight = 'bold';
    nameRow.appendChild(nameSpan);

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Rename';
    editBtn.style.cssText = 'font-size:11px;cursor:pointer;';
    editBtn.addEventListener('click', () => this.#promptNickname(card.monsterId, card.nickname));
    nameRow.appendChild(editBtn);
    wrap.appendChild(nameRow);

    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px;margin-top:4px;color:#ccc;';
    info.textContent = `${card.speciesName} · Lv${card.level} · HP ${card.currentHp}/${card.statHp} (${card.hpPercent}%)`;
    wrap.appendChild(info);

    // EG4-8: the evolution-choice badge. Built INSIDE the card (so it is per-monster and
    // is cleared by #renderParty/#renderBox's replaceChildren), never wrapping `header`
    // and never a #root child: five client/e2e/recruit.spec.ts sites resolve the box root
    // as h2['Party & Box'].parentElement.parentElement, and those helpers scan the root's
    // text for an `HP cur/max` shape — so this copy carries NO "HP " token.
    if (card.evolutionChoicePending) {
      const badge = document.createElement('div');
      badge.setAttribute('data-testid', 'evo-choice-badge');
      badge.textContent = '★ Ready to evolve — choose a path';
      badge.style.cssText =
        'margin-top:4px;font-size:11px;color:#fbbf24;border:1px solid #fbbf24;' +
        'border-radius:3px;padding:1px 4px;display:inline-block;';
      wrap.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:6px;';
    if (inParty) {
      const toBoxBtn = document.createElement('button');
      toBoxBtn.textContent = 'To Box';
      toBoxBtn.style.cssText = 'font-size:11px;cursor:pointer;';
      toBoxBtn.addEventListener('click', () =>
        this.#callbacks.onSetPartySlot(card.monsterId, BOX_SLOT),
      );
      actions.appendChild(toBoxBtn);
    } else {
      const toPartyBtn = document.createElement('button');
      toPartyBtn.textContent = 'To Party';
      toPartyBtn.style.cssText = 'font-size:11px;cursor:pointer;';
      toPartyBtn.addEventListener('click', () =>
        this.#callbacks.onSetPartySlot(card.monsterId, -1),
      );
      actions.appendChild(toPartyBtn);
    }
    wrap.appendChild(actions);

    return wrap;
  }

  #promptNickname(monsterId: bigint, currentName: string): void {
    const name = prompt('New nickname:', currentName);
    if (name !== null && name !== currentName) {
      this.#callbacks.onSetNickname(monsterId, name);
    }
  }
}
