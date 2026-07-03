// ui/dialogueModel.ts — pure dialogue view model (M12d, ADR-0071).
// TOTAL: never throws. All error paths return null or a safe default.
import type { StoreNpcRow, StorePlayerConversation } from '../net/store';
import type { ClientDialogueTree } from './dialogueContent';

export interface DialogueChoiceViewModel {
  text: string;
  idx: number; // 0-based array position — sent to the dialogue-advance reducer as choiceIndex
}

export interface DialogueViewModel {
  npcName: string;
  nodeText: string;
  choices: ReadonlyArray<DialogueChoiceViewModel>;
  canDismiss: boolean; // always true from model; dismissPending guard lives in main.ts
}

export function buildDialogueViewModel(
  conv: StorePlayerConversation | undefined,
  npcs: ReadonlyMap<bigint, StoreNpcRow>,
  content: ReadonlyMap<string, ClientDialogueTree>,
): DialogueViewModel | null {
  if (!conv) return null;
  const npc = npcs.get(conv.npcEntityId);
  if (!npc) return null;
  const tree = content.get(npc.dialogueTreeId);
  if (!tree) return { npcName: npc.npcId, nodeText: '...', choices: [], canDismiss: true };
  const node = tree.nodes.get(conv.currentNodeId);
  if (!node) return { npcName: npc.npcId, nodeText: '...', choices: [], canDismiss: true };
  return {
    npcName: npc.npcId,
    nodeText: node.text,
    choices: node.choices.map((c, i) => ({ text: c.text, idx: i })),
    canDismiss: true,
  };
}
