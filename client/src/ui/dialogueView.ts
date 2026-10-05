// ui/dialogueView.ts — DOM shell for the dialogue overlay.
// DOM shell — coverage-excluded
//
// THE SECOND WIRING MECHANISM. This overlay has NO `show()`: it is opened and closed by
// `render(vm | null)`, driven every store batch from `main.ts`. So the a11y open/close cannot hang
// off `show()`/`hide()` the way the other seven views' do; it hangs off the null<->non-null EDGE of
// the vm, detected against `this.visible` BEFORE the display write.
//
// WHY THE EDGE IS DERIVED FROM `visible` AND NOT FROM A `#lastVmWasNull` FIELD. A field updated
// inside `render()` never sees `hide()`, so after a hide the field still reads
// "was non-null", the next `render(vm)` is not a field transition, and the re-opened overlay ships
// no role, no label, no focus and no trap -- while passing every single-cycle test. `visible` is the
// one fact both paths already write, so it cannot drift from itself.
//
// THE CLOSE GUARDS ARE ASYMMETRIC ON PURPOSE. The `render(null)` branch IS guarded: A11Y-34 forbids
// invoking the helper "on a repeat render at the same nullity", and `main.ts`'s M12d
// `store.onBatchApplied` listener calls `dialogueView.render(vm)`
// unconditionally on every single batch, passing `null` whenever there is no conversation.
// `hide()` is NOT guarded -- see the reasoning in `ui/pvpView.ts`'s `hide()`: an unguarded close
// is the self-healing path, and `closeOverlayA11y` with no open record is a documented no-op.
//
// `hide()` HAS NO PRODUCTION CALLER : `main.ts`'s
// `overlayHandles` force-hide table leaves `dialogueView` out (`dialogueView: undefined`;
// it is the sole NEVER_FORCE_HIDE member -- hiding a live conversation client-side
// strands the server `player_conversation` row), and `main.wiring.test.ts` asserts zero
// `dialogueView.hide` occurrences in `main.ts`. `render(null)` is the real close. `hide()` stays as
// a belt-and-braces API surface and is wired identically.
//
// The one string this view owns, the Shop button label, is resolved through
// the i18n resolver (`t('dialogue.action.shop')`, ui/i18n/resolver.ts). `vm.npcName`,
// `vm.nodeText` and `choice.text` are content/model data, rendered raw.
//
// THE BOTTOM BOX AND THE D-PAD (ctl-8a, CTL8A.1). The shell root stays the overlay (its id, role
// and focus anchor are frozen seams); the constructor docks it (`mr-dock`, a class rule
// that aligns to the bottom and paints nothing itself) and moves the three content nodes into one
// inner `.mr-frame--bottom`, so the visible box is a bottom box without an inset on the shell
// (A11Y-12, the CTL7A-2 shell rule). `paint()` is the screen adapter's (ui/screens/dialogueScreen.ts):
// the cursor button and the reveal class. The kept paint is re-applied after every batch
// `render(vm)` and reset to its opening value on the hidden→visible edge, so a reopened talk never
// shows the last one's cursor.

import type { DialogueViewModel } from './dialogueModel';
import { t } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

/** What the dialogue screen paints: the cursor (a choice's idx, the shop action, or none) and
 *  the reveal, keyed by when it began (a NEW value restarts the animation; null: shown in full). */
export interface DialoguePaint {
  readonly active: number | 'shop' | null;
  readonly revealStart: number | null;
}

/** Before the screen's first paint after an open: no cursor, no reveal. */
const OPENING: DialoguePaint = { active: null, revealStart: null };

export class DialogueView {
  private overlay: HTMLElement;
  private npcName: HTMLElement;
  private nodeText: HTMLElement;
  private choicesContainer: HTMLElement;
  #paint: DialoguePaint = OPENING;
  /** What the choice and Shop buttons show (`#renderButtons`); null: rebuild on the next render. */
  #buttonsKey: string | null = null;

  constructor() {
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.overlay = document.getElementById('dialogue-overlay')!;
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.npcName = document.getElementById('dialogue-npc-name')!;
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.nodeText = document.getElementById('dialogue-node-text')!;
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.choicesContainer = document.getElementById('dialogue-choices')!;
    // The bottom box: dock the shell and move (never clone) the content into one inner frame.
    // Locate-or-create, so a second construction against the same document wraps nothing twice.
    this.overlay.classList.add('mr-dock');
    let box = Array.from(this.overlay.children).find((c) =>
      c.classList.contains('mr-frame--bottom'),
    ) as HTMLElement | undefined;
    if (box === undefined) {
      box = document.createElement('div');
      box.className = 'mr-frame mr-frame--bottom';
      box.dataset.size = 'bottom';
      this.overlay.appendChild(box);
    }
    box.append(this.npcName, this.nodeText, this.choicesContainer);
  }

  render(vm: DialogueViewModel | null): void {
    const wasVisible = this.visible;
    if (!vm) {
      this.overlay.style.display = 'none';
      if (wasVisible) closeOverlayA11y('dialogueView', null);
      return;
    }
    // A flex column, so the dock rule can align the box to the bottom (`block` cannot).
    this.overlay.style.display = 'flex';
    if (!wasVisible) this.#paint = OPENING; // a reopened talk starts without the last one's cursor
    this.npcName.textContent = vm.npcName;
    this.nodeText.textContent = vm.nodeText;
    this.#renderButtons(vm);
    this.#apply(this.#paint);
    // The null->non-null EDGE, and only the edge -- paint first, then claim the
    // overlay (D7: openOverlayA11y is the LAST statement, so its deferred focus resolves
    // `initialFocusSelector` against a fully-painted root).
    if (!wasVisible) openOverlayA11y('dialogueView', this.overlay);
  }

  /** Rebuild the choice and Shop buttons only when what they show changed: main.ts renders on every
   *  store batch, and a rebuild drops focus and the press in flight. The key is JSON, never a
   *  delimiter join (choice text is content). A rebuild that throws leaves no key, so the next
   *  render rebuilds again. */
  #renderButtons(vm: DialogueViewModel): void {
    const shopLabel = vm.shopAction ? t('dialogue.action.shop') : null;
    const key = JSON.stringify([
      vm.choices.map((c) => [c.idx, c.text]),
      vm.shopAction ? vm.shopAction.shopId : null,
      shopLabel,
    ]);
    if (key === this.#buttonsKey) return;
    this.#buttonsKey = null;
    this.choicesContainer.replaceChildren();
    vm.choices.forEach((choice) => {
      const btn = document.createElement('button');
      btn.className = 'mr-nav-item';
      btn.textContent = choice.text;
      btn.dataset.choiceIdx = String(choice.idx);
      this.choicesContainer.appendChild(btn);
    });
    // The enum-derived Shop affordance — rendered from
    // vm.shopAction only (never from choice text). Carries data-shop-id and
    // deliberately NO data-choice-idx, so the existing dialogue click
    // delegation never mistakes it for a choice.
    if (vm.shopAction) {
      const shopBtn = document.createElement('button');
      shopBtn.className = 'mr-nav-item';
      shopBtn.textContent = shopLabel;
      shopBtn.dataset.shopId = String(vm.shopAction.shopId);
      this.choicesContainer.appendChild(shopBtn);
    }
    this.#buttonsKey = key;
  }

  get visible(): boolean {
    return this.overlay.style.display !== 'none' && this.overlay.style.display !== '';
  }

  /** The screen's paint: kept, so the next batch render re-applies it. */
  paint(p: DialoguePaint): void {
    const restart = p.revealStart !== null && p.revealStart !== this.#paint.revealStart;
    this.#paint = p;
    this.#apply(p, restart);
  }

  /** Mark the cursor button (class AND aria-current, never colour alone) and the reveal class.
   *  `restart` takes the class off and on again around a reflow, so a new reveal of an element
   *  already revealing animates from its start. */
  #apply(p: DialoguePaint, restart = false): void {
    for (const btn of Array.from(this.choicesContainer.querySelectorAll('button'))) {
      const name = btn.dataset.shopId !== undefined ? 'shop' : Number(btn.dataset.choiceIdx);
      const on = name === p.active;
      btn.classList.toggle('is-active', on);
      if (on) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    }
    const el = this.nodeText;
    if (restart && el.classList.contains('is-revealing')) {
      el.classList.remove('is-revealing');
      void el.offsetWidth; // a style flush: the animation restarts only across one
    }
    el.classList.toggle('is-revealing', p.revealStart !== null);
  }

  hide(): void {
    this.overlay.style.display = 'none';
    // Deliberately UNGUARDED (rationale in ui/pvpView.ts's hide()).
    closeOverlayA11y('dialogueView', null);
  }
}
