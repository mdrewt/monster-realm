// ui/healView.ts — DOM shell for the heal overlay (M12d, ADR-0071).
// DOM shell — coverage-excluded
//
// m23-s3 -- THE SECOND WIRING MECHANISM. This overlay has NO `show()`: it is opened and closed by
// `render(vm | null)`, driven every store batch from `main.ts`. So the a11y open/close cannot hang
// off `show()`/`hide()` the way the other seven views' do; it hangs off the null<->non-null EDGE of
// the vm, detected against `this.visible` BEFORE the display write (M23 spec 2.2, A11Y-34).
//
// WHY THE EDGE IS DERIVED FROM `visible` AND NOT FROM A `#lastVmWasNull` FIELD. A field updated
// inside `render()` never sees `hide()` -- and for THIS view that is not hypothetical, since it is
// opened by `render(vm)` (`main.ts:545-547`) but closed by `hide()` (`main.ts:1382`, `:364`), so after a hide the field still reads
// "was non-null", the next `render(vm)` is not a field transition, and the re-opened overlay ships
// no role, no label, no focus and no trap -- while passing every single-cycle test. `visible` is the
// one fact both paths already write, so it cannot drift from itself.
//
// THE CLOSE GUARDS ARE ASYMMETRIC ON PURPOSE. The `render(null)` branch IS guarded: A11Y-34 forbids
// invoking the helper "on a repeat render at the same nullity", and a guarded branch costs nothing. `hide()` is NOT
// guarded -- see the reasoning in `ui/pvpView.ts`'s `hide()`: an unguarded close is the self-healing
// path, and `closeOverlayA11y` with no open record is a documented no-op.

import { formatHealCostLine, type HealViewModel } from './healModel';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

export class HealView {
  private overlay: HTMLElement;
  private list: HTMLElement;

  constructor() {
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.overlay = document.getElementById('heal-overlay')!;
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.list = document.getElementById('heal-list')!;
  }

  render(vm: HealViewModel | null): void {
    const wasVisible = this.visible;
    if (!vm) {
      this.overlay.style.display = 'none';
      if (wasVisible) closeOverlayA11y('healView', null);
      return;
    }
    this.overlay.style.display = 'block';
    this.list.innerHTML = '';
    vm.locations.forEach((loc) => {
      const li = document.createElement('li');
      const cost = formatHealCostLine(loc);
      li.textContent = `Heal here (${cost})`;
      li.dataset.locationId = String(loc.locationId);
      this.list.appendChild(li);
    });
    // m23-s3: the null->non-null EDGE, and only the edge -- paint first, then claim the
    // overlay (D7: openOverlayA11y is the LAST statement, so its deferred focus resolves
    // `initialFocusSelector` against a fully-painted root).
    if (!wasVisible) openOverlayA11y('healView', this.overlay);
  }

  get visible(): boolean {
    return this.overlay.style.display !== 'none' && this.overlay.style.display !== '';
  }

  hide(): void {
    this.overlay.style.display = 'none';
    // m23-s3 D2: deliberately UNGUARDED (rationale in ui/pvpView.ts's hide()).
    closeOverlayA11y('healView', null);
  }
}
