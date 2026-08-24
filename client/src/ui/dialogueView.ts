// ui/dialogueView.ts — DOM shell for the dialogue overlay (M12d, ADR-0071).
// DOM shell — coverage-excluded per dom-shell-coverage-exclusion.eval.mjs
//
// m23-s3 -- THE SECOND WIRING MECHANISM. This overlay has NO `show()`: it is opened and closed by
// `render(vm | null)`, driven every store batch from `main.ts`. So the a11y open/close cannot hang
// off `show()`/`hide()` the way the other seven views' do; it hangs off the null<->non-null EDGE of
// the vm, detected against `this.visible` BEFORE the display write (M23 spec 2.2, A11Y-34).
//
// WHY THE EDGE IS DERIVED FROM `visible` AND NOT FROM A `#lastVmWasNull` FIELD. A field updated
// inside `render()` never sees `hide()`, so after a hide the field still reads
// "was non-null", the next `render(vm)` is not a field transition, and the re-opened overlay ships
// no role, no label, no focus and no trap -- while passing every single-cycle test. `visible` is the
// one fact both paths already write, so it cannot drift from itself.
//
// THE CLOSE GUARDS ARE ASYMMETRIC ON PURPOSE. The `render(null)` branch IS guarded: A11Y-34 forbids
// invoking the helper "on a repeat render at the same nullity", and `main.ts:1574` calls `dialogueView.render(vm)` unconditionally on every
// single batch, passing `null` whenever there is no conversation. `hide()` is NOT
// guarded -- see the reasoning in `ui/pvpView.ts`'s `hide()`: an unguarded close is the self-healing
// path, and `closeOverlayA11y` with no open record is a documented no-op.
//
// `hide()` HAS NO PRODUCTION CALLER and that is pinned: `main.ts:362` leaves `dialogueView` out of
// the force-hide handle table (it is the sole NEVER_FORCE_HIDE member -- hiding a live conversation
// client-side strands the server `player_conversation` row), and `main.wiring.test.ts` asserts zero
// `dialogueView.hide` occurrences in `main.ts`. `render(null)` is the real close. `hide()` stays as
// a belt-and-braces API surface and is wired identically.

import type { DialogueViewModel } from './dialogueModel';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

export class DialogueView {
  private overlay: HTMLElement;
  private npcName: HTMLElement;
  private nodeText: HTMLElement;
  private choicesContainer: HTMLElement;

  constructor() {
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.overlay = document.getElementById('dialogue-overlay')!;
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.npcName = document.getElementById('dialogue-npc-name')!;
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.nodeText = document.getElementById('dialogue-node-text')!;
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.choicesContainer = document.getElementById('dialogue-choices')!;
  }

  render(vm: DialogueViewModel | null): void {
    const wasVisible = this.visible;
    if (!vm) {
      this.overlay.style.display = 'none';
      if (wasVisible) closeOverlayA11y('dialogueView', null);
      return;
    }
    this.overlay.style.display = 'block';
    this.npcName.textContent = vm.npcName;
    this.nodeText.textContent = vm.nodeText;
    this.choicesContainer.replaceChildren();
    vm.choices.forEach((choice) => {
      const btn = document.createElement('button');
      btn.textContent = choice.text;
      btn.dataset.choiceIdx = String(choice.idx);
      this.choicesContainer.appendChild(btn);
    });
    // uxd2 (ADR-0161 D4): the enum-derived Shop affordance — rendered from
    // vm.shopAction only (never from choice text). Carries data-shop-id and
    // deliberately NO data-choice-idx, so the existing dialogue click
    // delegation never mistakes it for a choice.
    if (vm.shopAction) {
      const shopBtn = document.createElement('button');
      shopBtn.textContent = 'Shop';
      shopBtn.dataset.shopId = String(vm.shopAction.shopId);
      this.choicesContainer.appendChild(shopBtn);
    }
    // m23-s3: the null->non-null EDGE, and only the edge -- paint first, then claim the
    // overlay (D7: openOverlayA11y is the LAST statement, so its deferred focus resolves
    // `initialFocusSelector` against a fully-painted root).
    if (!wasVisible) openOverlayA11y('dialogueView', this.overlay);
  }

  get visible(): boolean {
    return this.overlay.style.display !== 'none' && this.overlay.style.display !== '';
  }

  hide(): void {
    this.overlay.style.display = 'none';
    // m23-s3 D2: deliberately UNGUARDED (rationale in ui/pvpView.ts's hide()).
    closeOverlayA11y('dialogueView', null);
  }
}
