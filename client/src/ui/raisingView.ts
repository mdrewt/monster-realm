// ui/raisingView.ts — thin DOM shell for the raising/inventory screen (M9c).
//
// Renders a RaisingViewModel produced by raisingModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes, no joins/filters/classification
// (those live in the model) — one-way flow only. The loop calls refresh() on
// batch-applied; the user triggers reducer intents via callbacks passed at
// construction (never called directly by this module). Coverage-excluded shell.
//
// m24-s4 (ADR-0260) — every player-facing string this view renders is resolved through the i18n
// resolver (`t()`/`tf()`, ui/i18n/resolver.ts) with a `raising.*` key from ui/i18n/catalog.en.ts;
// the English bytes are unchanged (the catalog pins them). Model data (nickname, item
// description, the `showFeedback` message, tiers, stats, names, counts) flow through raw or as
// params, never as catalog text. Every `t(`/`tf(` first argument is a string LITERAL.
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
// NO CLOSE-BEFORE-OPEN. `ui/overlayA11y.ts`'s cross-slice contract (a) once claimed the four
// `#app`-mounted views "share ONE root" and prescribed close-before-open; 17r-e RETRACTED it
// in place (A12, ui/overlayA11y.ts:52-54); (a) now agrees with this code: each view creates its
// OWN root under the shared MOUNT — four roots, four `OverlayId`s, four records. Closing a sibling
// here would close an overlay the player still has open. Pinned by `S4-CROSS-VIEW-DISTINCT-ROOTS`.

import { t, tf } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { InventoryItemViewModel, RaisingViewModel } from './raisingModel';

export interface RaisingViewCallbacks {
  /**
   * Called when the user feeds a training item to a monster.
   *
   * May return a promise (20r-a): the per-monster `#pendingTrain` lock is held until it
   * settles — same contract and same reason as `onCare` below (a `=> void` type would let
   * a future implementation silently reduce the lock to a one-microtask no-op, and the
   * server `train` reducer has no idempotency guard: a double-fire spends two food items).
   */
  readonly onTrain: (monsterId: bigint, foodItemId: number) => void | Promise<void>;
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
  /** The "Raising & Inventory" heading; its text is resolved in show(), not here (m24-s4). */
  readonly #titleEl: HTMLHeadingElement;
  readonly #feedbackEl: HTMLDivElement;
  /** The two section headings; text resolved in show() (m24-s4, see show()). */
  readonly #monstersLabelEl: HTMLHeadingElement;
  readonly #inventoryLabelEl: HTMLHeadingElement;
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
  //
  // rb-120 (R-20r-a-CARE-GEN): the VALUE is a generation token, same shape as
  // #pendingTrain below — `.finally()` releases only if the stored object is still
  // its own. A membership-keyed release (`Set.delete`) let a STALE promise win: click
  // → hide() clears the lock → reopen → click again → the FIRST call's `.finally()`
  // settles, deletes the SECOND click's key, and re-enables the live button while
  // that second call is still in flight.
  readonly #pending = new Map<bigint, object>();
  // The Care button currently on screen for each monster. #renderMonsters
  // rebuilds every node via replaceChildren(), so the button a click closure
  // captured can be detached by the time its call settles — re-enabling that
  // stale node would leave the LIVE one disabled forever.
  readonly #careButtons = new Map<bigint, HTMLButtonElement>();
  // 20r-a: the Train in-flight lock — a SIBLING of #pending, not a shared map (D6): a Care
  // rejection (cooldown) must not block Train and vice versa (different reducers, different
  // failure modes). Keyed per monster like Care; ALL of a monster's Train buttons (one per
  // food) disable together, since two different foods in flight is the same double-spend.
  // Same generation-token release shape as #pending above — see its comment for why.
  readonly #pendingTrain = new Map<bigint, object>();
  // The Train buttons currently on screen per monster (same detached-node reason as
  // #careButtons: a refresh() mid-flight rebuilds every node).
  readonly #trainButtons = new Map<bigint, HTMLButtonElement[]>();

  constructor(parent: HTMLElement, callbacks: RaisingViewCallbacks) {
    this.#callbacks = callbacks;

    this.#root = document.createElement('div');
    this.#root.style.cssText =
      'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.75);' +
      'display:none;flex-direction:column;align-items:center;padding:24px;' +
      'overflow-y:auto;font-family:monospace;color:#e0e0e0;';

    // m24-s4 (ADR-0260): NO text here — `raising.title` is resolved in show() (see there for why).
    const title = document.createElement('h2');
    // m23-s4: the OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'raising-title');
    title.setAttribute('tabindex', '-1');
    title.style.cssText = 'margin:0 0 16px;color:#fff;';
    this.#titleEl = title;
    this.#root.appendChild(title);

    // ADR-0159 D1: the feedback line lives INSIDE the overlay root. main.ts's
    // statusEl sits in normal document flow, so this `position:fixed; z-index:100`
    // overlay painted over every care message it raised — the player saw nothing.
    this.#feedbackEl = document.createElement('div');
    this.#feedbackEl.id = 'raising-feedback';
    this.#feedbackEl.style.cssText =
      'min-height:16px;margin:0 0 12px;font-size:12px;color:#ffd479;';
    this.#root.appendChild(this.#feedbackEl);

    // Its text (`raising.monsters.heading`) is resolved in show() (m24-s4), not here.
    const monsterLabel = document.createElement('h3');
    monsterLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#monstersLabelEl = monsterLabel;
    this.#root.appendChild(monsterLabel);

    this.#monsterEl = document.createElement('div');
    this.#monsterEl.style.cssText =
      'display:grid;grid-template-columns:repeat(2,1fr);gap:8px;width:100%;max-width:700px;margin-bottom:16px;';
    this.#root.appendChild(this.#monsterEl);

    // Its text (`raising.inventory.heading`) is resolved in show() (m24-s4), not here.
    const inventoryLabel = document.createElement('h3');
    inventoryLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#inventoryLabelEl = inventoryLabel;
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
    // m24-s4 (ADR-0260 D4): the strings set ONCE and never rewritten by a render are resolved
    // HERE, on EVERY show() — unconditionally, after the `wasVisible` read, before the display
    // write. See evolutionView.show() for the boot-order / locale-switch reasoning.
    this.#titleEl.textContent = t('raising.title');
    this.#monstersLabelEl.textContent = t('raising.monsters.heading');
    this.#inventoryLabelEl.textContent = t('raising.inventory.heading');
    this.#root.style.display = 'flex';
    if (!wasVisible) openOverlayA11y('raisingView', this.#root);
  }

  hide(): void {
    this.#visible = false;
    this.#root.style.display = 'none';
    // A stale "Cared!" must not greet the next open, and the in-flight lock is
    // released here because the SDK never settles a reducer promise after a link
    // drop — .finally() may never run (shopView/renameView precedent). Clearing also
    // makes every in-flight call STALE (its token is gone), so its late settle is a
    // no-op; the reopen's refresh() (main.ts pairs show() with it) re-derives the buttons.
    this.#feedbackEl.textContent = '';
    this.#pending.clear();
    this.#pendingTrain.clear(); // 20r-a: same never-settles-after-drop reason as #pending.
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

  /** rb-121 (ADR-0271): a lock-owning release that finds focus stranded on `<body>` re-asserts the
   *  dialog; the idempotent re-open re-installs the trap and defers focus to the registry anchor.
   *  `#visible` is load-bearing: re-opening a hidden view would CREATE an open record. */
  #reanchorStrandedFocus(): void {
    if (this.#visible && document.activeElement === document.body) {
      openOverlayA11y('raisingView', this.#root);
    }
  }

  #renderMonsters(
    monsters: RaisingViewModel['monsters'],
    items: readonly InventoryItemViewModel[],
  ): void {
    this.#monsterEl.replaceChildren();
    this.#careButtons.clear();
    this.#trainButtons.clear();
    if (monsters.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = t('raising.monsters.empty');
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
      info.textContent = tf('raising.card.status', {
        level: mon.level,
        trust: mon.trustTier,
        current: mon.currentHp,
        max: mon.statHp,
      });
      el.appendChild(info);

      const stats = document.createElement('div');
      stats.style.cssText = 'font-size:11px;margin-top:4px;color:#9ab;';
      stats.textContent = tf('raising.card.stats', {
        attack: mon.statAttack,
        defense: mon.statDefense,
        speed: mon.statSpeed,
        spAttack: mon.statSpAttack,
        spDefense: mon.statSpDefense,
      });
      el.appendChild(stats);

      const actions = document.createElement('div');
      actions.style.cssText = 'margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;';

      const monsterId = mon.monsterId;
      const careBtn = document.createElement('button');
      careBtn.textContent = t('raising.card.care');
      careBtn.style.cssText = 'font-size:11px;cursor:pointer;';
      // Re-derive the disabled state from the pending map rather than defaulting
      // to enabled: refresh() can rebuild this button while THIS monster's care
      // call is still in flight, and a brand-new enabled-looking button whose
      // click the lock then swallows is worse than no button at all.
      careBtn.disabled = this.#pending.has(monsterId);
      this.#careButtons.set(monsterId, careBtn);
      // Re-entrancy guard (ADR-0159 D1, shopView/renameView precedent): a genuinely
      // pending care call holds the lock until it settles; .finally() resets on BOTH
      // arms. Keyed by monsterId, so a sibling monster's Care button stays live.
      // rb-120 (R-20r-a-CARE-GEN) ported the Train shape here: the release is gated on
      // this click's own token (see #pending), and the call runs INSIDE the executor —
      // `Promise.resolve(onCare(id))` evaluates it as an argument, so a synchronous
      // throw escaped the listener after the lock was taken and stranded it.
      careBtn.addEventListener('click', () => {
        if (this.#pending.has(monsterId)) return;
        const lock = {};
        this.#pending.set(monsterId, lock);
        careBtn.disabled = true;
        void new Promise<void>((resolve) => resolve(this.#callbacks.onCare(monsterId)))
          .finally(() => {
            if (this.#pending.get(monsterId) !== lock) return;
            this.#pending.delete(monsterId);
            // Re-enable whichever button is on screen NOW: a refresh() during the
            // call replaces this closure's node, and re-enabling the detached one
            // would strand the live button disabled forever.
            const live = this.#careButtons.get(monsterId) ?? careBtn;
            live.disabled = false;
            this.#reanchorStrandedFocus();
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

      // 20r-a/rb-120: Train and Care carry the SAME lock shape — re-derived disabled
      // state, the LIVE-button re-enable, the throw-safe `new Promise((resolve) =>
      // resolve(...))` executor, and the generation-token release — but in SEPARATE
      // maps (D6: a Care rejection must not block Train and vice versa). Train's one
      // remaining difference is that it disables ALL of a monster's Train buttons
      // (one per food) together, since two different foods in flight is the same
      // double-spend.
      const trainBtns: HTMLButtonElement[] = [];
      for (const item of items) {
        if (item.count > 0 && item.canTrain) {
          const trainBtn = document.createElement('button');
          trainBtn.textContent = tf('raising.card.train', { name: item.name, count: item.count });
          trainBtn.style.cssText = 'font-size:11px;cursor:pointer;';
          trainBtn.disabled = this.#pendingTrain.has(monsterId);
          trainBtn.addEventListener('click', () => {
            if (this.#pendingTrain.has(monsterId)) return;
            const lock = {};
            this.#pendingTrain.set(monsterId, lock);
            for (const b of trainBtns) b.disabled = true;
            void new Promise<void>((resolve) =>
              resolve(this.#callbacks.onTrain(monsterId, item.itemId)),
            )
              .finally(() => {
                if (this.#pendingTrain.get(monsterId) !== lock) return;
                this.#pendingTrain.delete(monsterId);
                for (const b of this.#trainButtons.get(monsterId) ?? trainBtns) {
                  b.disabled = false;
                }
                this.#reanchorStrandedFocus();
              })
              .catch((err: unknown) => {
                // Feedback is main.ts's job (sendGuarded reported it); swallowed only to
                // avoid an unhandled rejection, logged so a contract breach stays visible.
                console.error('train click handler error', err);
              });
          });
          trainBtns.push(trainBtn);
          actions.appendChild(trainBtn);
        }
      }
      this.#trainButtons.set(monsterId, trainBtns);
      el.appendChild(actions);

      this.#monsterEl.appendChild(el);
    }
  }

  #renderInventory(items: readonly InventoryItemViewModel[]): void {
    this.#inventoryEl.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = t('raising.inventory.empty');
      empty.style.opacity = '0.4';
      this.#inventoryEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const el = document.createElement('div');
      el.style.cssText = 'border:1px solid #444;border-radius:4px;padding:8px;background:#1a1a2e;';

      const nameSpan = document.createElement('div');
      nameSpan.textContent = tf('raising.inventory.item', { name: item.name, count: item.count });
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
