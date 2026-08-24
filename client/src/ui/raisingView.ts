// ui/raisingView.ts — thin DOM shell for the raising/inventory screen (M9c).
//
// Renders a RaisingViewModel produced by raisingModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes, no joins/filters/classification
// (those live in the model) — one-way flow only. The loop calls refresh() on
// batch-applied; the user triggers reducer intents via callbacks passed at
// construction (never called directly by this module). Coverage-excluded shell.
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

import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { InventoryItemViewModel, RaisingViewModel } from './raisingModel';

export interface RaisingViewCallbacks {
  /** Called when the user feeds a training item to a monster. */
  readonly onTrain: (monsterId: bigint, foodItemId: number) => void;
  /**
   * Called when the user clicks the Care button on a monster.
   *
   * May return a promise: the `#pending` re-entrancy lock is held until that
   * promise settles, so the return type must express it. Typing this `=> void`
   * would let a future implementation type-check cleanly while silently
   * reducing the lock to a no-op (a double-click would fire two care calls).
   */
  readonly onCare: (monsterId: bigint) => void | Promise<void>;
}

export class RaisingView {
  readonly #root: HTMLDivElement;
  readonly #feedbackEl: HTMLDivElement;
  readonly #monsterEl: HTMLDivElement;
  readonly #inventoryEl: HTMLDivElement;
  readonly #callbacks: RaisingViewCallbacks;
  #visible = false;
  // In-flight lock: prevents a double-click from firing two care calls (whose
  // contradictory outcomes would flash "Cared!" then "care cooldown not yet
  // elapsed"). shopView/renameView precedent.
  //
  // PER MONSTER, not view-wide: a single shared boolean made a care call in
  // flight for monster A silently swallow monster B's click (B's own button was
  // never disabled, so it looked clickable), and had no way to express "A is
  // still pending" to a mid-flight refresh() that rebuilds every button.
  readonly #pending = new Set<bigint>();
  // The Care button currently on screen for each monster. #renderMonsters
  // rebuilds every node via replaceChildren(), so the button a click closure
  // captured can be detached by the time its call settles — re-enabling that
  // stale node would leave the LIVE one disabled forever.
  readonly #careButtons = new Map<bigint, HTMLButtonElement>();

  constructor(parent: HTMLElement, callbacks: RaisingViewCallbacks) {
    this.#callbacks = callbacks;

    this.#root = document.createElement('div');
    this.#root.style.cssText =
      'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.75);' +
      'display:none;flex-direction:column;align-items:center;padding:24px;' +
      'overflow-y:auto;font-family:monospace;color:#e0e0e0;';

    const title = document.createElement('h2');
    title.textContent = 'Raising & Inventory';
    // m23-s4: the OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'raising-title');
    title.setAttribute('tabindex', '-1');
    title.style.cssText = 'margin:0 0 16px;color:#fff;';
    this.#root.appendChild(title);

    // ADR-0159 D1: the feedback line lives INSIDE the overlay root. main.ts's
    // statusEl sits in normal document flow, so this `position:fixed; z-index:100`
    // overlay painted over every care message it raised — the player saw nothing.
    this.#feedbackEl = document.createElement('div');
    this.#feedbackEl.id = 'raising-feedback';
    this.#feedbackEl.style.cssText =
      'min-height:16px;margin:0 0 12px;font-size:12px;color:#ffd479;';
    this.#root.appendChild(this.#feedbackEl);

    const monsterLabel = document.createElement('h3');
    monsterLabel.textContent = 'Monsters';
    monsterLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#root.appendChild(monsterLabel);

    this.#monsterEl = document.createElement('div');
    this.#monsterEl.style.cssText =
      'display:grid;grid-template-columns:repeat(2,1fr);gap:8px;width:100%;max-width:700px;margin-bottom:16px;';
    this.#root.appendChild(this.#monsterEl);

    const inventoryLabel = document.createElement('h3');
    inventoryLabel.textContent = 'Inventory';
    inventoryLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#root.appendChild(inventoryLabel);

    this.#inventoryEl = document.createElement('div');
    this.#inventoryEl.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:700px;';
    this.#root.appendChild(this.#inventoryEl);

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
    if (!wasVisible) openOverlayA11y('raisingView', this.#root);
  }

  hide(): void {
    this.#visible = false;
    this.#root.style.display = 'none';
    // A stale "Cared!" must not greet the next open, and the in-flight lock is
    // released here because the SDK never settles a reducer promise after a link
    // drop — .finally() may never run (shopView/renameView precedent).
    this.#feedbackEl.textContent = '';
    this.#pending.clear();
    closeOverlayA11y('raisingView', null);
  }

  /** Display a care outcome. textContent ONLY — the message can carry a
   * server-supplied error reason, so innerHTML would be an injection vector. */
  showFeedback(message: string): void {
    this.#feedbackEl.textContent = message;
  }

  refresh(vm: RaisingViewModel): void {
    this.#renderMonsters(vm.monsters, vm.items);
    this.#renderInventory(vm.items);
  }

  #renderMonsters(
    monsters: RaisingViewModel['monsters'],
    items: readonly InventoryItemViewModel[],
  ): void {
    this.#monsterEl.replaceChildren();
    this.#careButtons.clear();
    if (monsters.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No monsters.';
      empty.style.opacity = '0.4';
      this.#monsterEl.appendChild(empty);
      return;
    }
    for (const mon of monsters) {
      const el = document.createElement('div');
      el.style.cssText = 'border:1px solid #444;border-radius:4px;padding:8px;background:#1a1a2e;';

      const nameSpan = document.createElement('div');
      nameSpan.textContent = mon.nickname;
      nameSpan.style.fontWeight = 'bold';
      el.appendChild(nameSpan);

      const info = document.createElement('div');
      info.style.cssText = 'font-size:12px;margin-top:4px;color:#ccc;';
      info.textContent = `Lv${mon.level} · Trust ${mon.trustTier} · HP ${mon.currentHp}/${mon.statHp}`;
      el.appendChild(info);

      const stats = document.createElement('div');
      stats.style.cssText = 'font-size:11px;margin-top:4px;color:#9ab;';
      stats.textContent =
        `ATK ${mon.statAttack} · DEF ${mon.statDefense} · SPD ${mon.statSpeed} · ` +
        `SP.ATK ${mon.statSpAttack} · SP.DEF ${mon.statSpDefense}`;
      el.appendChild(stats);

      const actions = document.createElement('div');
      actions.style.cssText = 'margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;';

      const monsterId = mon.monsterId;
      const careBtn = document.createElement('button');
      careBtn.textContent = 'Care';
      careBtn.style.cssText = 'font-size:11px;cursor:pointer;';
      // Re-derive the disabled state from the pending SET rather than defaulting
      // to enabled: refresh() can rebuild this button while THIS monster's care
      // call is still in flight, and a brand-new enabled-looking button whose
      // click the lock then swallows is worse than no button at all.
      careBtn.disabled = this.#pending.has(monsterId);
      this.#careButtons.set(monsterId, careBtn);
      // Re-entrancy guard (ADR-0159 D1, shopView/renameView precedent): the
      // callback's return value is wrapped so a genuinely pending care call holds
      // the lock until it settles; .finally() resets on BOTH arms (no dead button).
      // The lock is keyed by monsterId, so it only ever blocks a second click on
      // the SAME monster — a sibling monster's Care button stays live.
      careBtn.addEventListener('click', () => {
        if (this.#pending.has(monsterId)) return;
        this.#pending.add(monsterId);
        careBtn.disabled = true;
        void Promise.resolve(this.#callbacks.onCare(monsterId))
          .finally(() => {
            this.#pending.delete(monsterId);
            // Re-enable whichever button is on screen NOW: a refresh() during the
            // call replaces this closure's node, and re-enabling the detached one
            // would strand the live button disabled forever.
            const live = this.#careButtons.get(monsterId) ?? careBtn;
            live.disabled = false;
          })
          .catch((err: unknown) => {
            // Feedback is the caller's responsibility, so this is swallowed to
            // avoid an unhandled rejection — but a rejecting onCare violates the
            // contract (performCare never rejects), so log it rather than making
            // the violation invisible in a coverage-excluded shell.
            console.error('care click handler error', err);
          });
      });
      actions.appendChild(careBtn);

      for (const item of items) {
        if (item.count > 0 && item.canTrain) {
          const trainBtn = document.createElement('button');
          trainBtn.textContent = `Train: ${item.name} (x${item.count})`;
          trainBtn.style.cssText = 'font-size:11px;cursor:pointer;';
          trainBtn.addEventListener('click', () =>
            this.#callbacks.onTrain(mon.monsterId, item.itemId),
          );
          actions.appendChild(trainBtn);
        }
      }
      el.appendChild(actions);

      this.#monsterEl.appendChild(el);
    }
  }

  #renderInventory(items: readonly InventoryItemViewModel[]): void {
    this.#inventoryEl.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No items.';
      empty.style.opacity = '0.4';
      this.#inventoryEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const el = document.createElement('div');
      el.style.cssText = 'border:1px solid #444;border-radius:4px;padding:8px;background:#1a1a2e;';

      const nameSpan = document.createElement('div');
      nameSpan.textContent = `${item.name} (x${item.count})`;
      nameSpan.style.fontWeight = 'bold';
      el.appendChild(nameSpan);

      const desc = document.createElement('div');
      desc.style.cssText = 'font-size:11px;margin-top:4px;color:#ccc;';
      desc.textContent = item.description;
      el.appendChild(desc);

      this.#inventoryEl.appendChild(el);
    }
  }
}
