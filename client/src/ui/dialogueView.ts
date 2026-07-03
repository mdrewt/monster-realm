// ui/dialogueView.ts — DOM shell for the dialogue overlay (M12d, ADR-0071).
// DOM shell — coverage-excluded per dom-shell-coverage-exclusion.eval.mjs
export class DialogueView {
  private overlay: HTMLElement;
  private npcName: HTMLElement;
  private nodeText: HTMLElement;
  private choicesContainer: HTMLElement;

  constructor() {
    this.overlay = document.getElementById('dialogue-overlay')!;
    this.npcName = document.getElementById('dialogue-npc-name')!;
    this.nodeText = document.getElementById('dialogue-node-text')!;
    this.choicesContainer = document.getElementById('dialogue-choices')!;
  }

  render(vm: import('./dialogueModel').DialogueViewModel | null): void {
    if (!vm) {
      this.overlay.style.display = 'none';
      return;
    }
    this.overlay.style.display = 'block';
    this.npcName.textContent = vm.npcName;
    this.nodeText.textContent = vm.nodeText;
    this.choicesContainer.innerHTML = '';
    vm.choices.forEach((choice) => {
      const btn = document.createElement('button');
      btn.textContent = choice.text;
      btn.dataset['choiceIdx'] = String(choice.idx);
      this.choicesContainer.appendChild(btn);
    });
  }

  get visible(): boolean {
    return this.overlay.style.display !== 'none' && this.overlay.style.display !== '';
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }
}
