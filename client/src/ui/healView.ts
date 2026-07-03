// ui/healView.ts — DOM shell for the heal overlay (M12d, ADR-0071).
// DOM shell — coverage-excluded
import type { HealViewModel } from './healModel';

export class HealView {
  private overlay: HTMLElement;
  private list: HTMLElement;

  constructor() {
    this.overlay = document.getElementById('heal-overlay')!;
    this.list = document.getElementById('heal-list')!;
  }

  render(vm: HealViewModel | null): void {
    if (!vm) {
      this.overlay.style.display = 'none';
      return;
    }
    this.overlay.style.display = 'block';
    this.list.innerHTML = '';
    vm.locations.forEach((loc) => {
      const li = document.createElement('li');
      const cost = loc.isFree ? 'Free' : `${loc.costQty}x ${loc.costItemName ?? 'Unknown item'}`;
      li.textContent = `Heal here (${cost})`;
      li.dataset['locationId'] = String(loc.locationId);
      this.list.appendChild(li);
    });
  }

  get visible(): boolean {
    return this.overlay.style.display !== 'none' && this.overlay.style.display !== '';
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }
}
