// ui/dialogueModel.ts — pure dialogue view model (M12d, ADR-0071).
// TOTAL: never throws. All error paths return null or a safe default.
// uxd2 (ADR-0161 D3): the nearest-NPC resolver moved to interactModel.ts
// (nearestInteractable) — this module is view-model derivation only.
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
  /** uxd2 (ADR-0161 D4): the greet-then-shop affordance, derived from the
   *  SERVER enum (npc.interaction) — never from choice text, never from a
   *  second content source. null for every non-Shop NPC. */
  shopAction: { readonly shopId: number } | null;
}

/** Derive the Shop affordance from the npc row's interaction. Explicit kind
 *  check (never payload truthiness) so shop id 0 survives (AC-16 discipline).
 *  `?.` keeps this total for a row that predates the interaction column. */
function shopActionFor(npc: StoreNpcRow): { readonly shopId: number } | null {
  return npc.interaction?.kind === 'shop' ? { shopId: npc.interaction.shopId } : null;
}

export function buildDialogueViewModel(
  conv: StorePlayerConversation | undefined,
  npcs: ReadonlyMap<bigint, StoreNpcRow>,
  content: ReadonlyMap<string, ClientDialogueTree>,
): DialogueViewModel | null {
  if (!conv) return null;
  const npc = npcs.get(conv.npcEntityId);
  if (!npc) return null;
  // BOTH '...'-fallback arms carry shopAction too (the npc row IS present
  // here): a shopkeeper whose greeting tree failed to bundle must still be
  // shoppable — the affordance derives from the enum, not from content.
  const shopAction = shopActionFor(npc);
  const tree = content.get(npc.dialogueTreeId);
  if (!tree) {
    return { npcName: npc.npcId, nodeText: '...', choices: [], canDismiss: true, shopAction };
  }
  const node = tree.nodes.get(conv.currentNodeId);
  if (!node) {
    return { npcName: npc.npcId, nodeText: '...', choices: [], canDismiss: true, shopAction };
  }
  return {
    npcName: npc.npcId,
    nodeText: node.text,
    choices: node.choices.map((c, i) => ({ text: c.text, idx: i })),
    canDismiss: true,
    shopAction,
  };
}
