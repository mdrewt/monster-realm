// ui/questLogView.ts — DOM shell for the quest log overlay (M12d, ADR-0071).
// DOM shell — coverage-excluded
export class QuestLogView {
  private overlay: HTMLElement;
  private list: HTMLElement;

  constructor() {
    this.overlay = document.getElementById('quest-log-overlay')!;
    this.list = document.getElementById('quest-log-list')!;
  }

  render(vm: import('./questLogModel').QuestLogViewModel | null): void {
    if (!vm) {
      this.overlay.style.display = 'none';
      return;
    }
    this.overlay.style.display = 'block';
    this.list.innerHTML = '';
    vm.active.forEach((entry) => {
      const li = document.createElement('li');
      li.textContent = `${entry.displayName} (step ${entry.stepIndex})`;
      this.list.appendChild(li);
    });
  }

  get visible(): boolean {
    return this.overlay.style.display !== 'none' && this.overlay.style.display !== '';
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.overlay.style.display = 'block';
    }
  }
}
