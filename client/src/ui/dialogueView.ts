// ui/dialogueView.ts — DOM shell for the dialogue overlay (M12d, ADR-0071).
// DOM shell — coverage-excluded per dom-shell-coverage-exclusion.eval.mjs
import type { DialogueViewModel } from './dialogueModel';

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
  }

  get visible(): boolean {
    return this.overlay.style.display !== 'none' && this.overlay.style.display !== '';
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }
}
