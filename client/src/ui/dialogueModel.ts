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

/** Client-side talk range in Manhattan tiles — mirrors the server's
 *  `TALK_RANGE: i64 = 2` (server-module/src/npc.rs:20). Latency hygiene ONLY,
 *  never security: the `talk` reducer re-validates zone + range server-side
 *  (npc.rs talk Steps 4-5). */
export const CLIENT_TALK_RANGE = 2;

/** The positional subset of a character row the talk-target selection reads. */
export interface TalkTile {
  readonly zoneId: number;
  readonly tileX: number;
  readonly tileY: number;
}

/**
 * Nearest NPC within CLIENT_TALK_RANGE of the own AUTHORITATIVE tile (M13.5c
 * KeyT contract — dialogue.spec.ts header). NPC positions come from their
 * CHARACTER rows (current wander position, not home_x/home_y), joined by
 * entityId. Same-zone only. Deterministic: minimum Manhattan distance, ties
 * broken by lowest entityId. Returns undefined when none is in range (KeyT
 * no-ops). TOTAL: never throws; NPCs without a character row are skipped.
 */
export function nearestTalkableNpcId(
  own: TalkTile,
  npcs: readonly StoreNpcRow[],
  characterTiles: ReadonlyMap<bigint, TalkTile>,
): bigint | undefined {
  let best: bigint | undefined;
  let bestDist = CLIENT_TALK_RANGE + 1;
  for (const npc of npcs) {
    const c = characterTiles.get(npc.entityId);
    if (c === undefined || c.zoneId !== own.zoneId) continue;
    const dist = Math.abs(c.tileX - own.tileX) + Math.abs(c.tileY - own.tileY);
    if (dist > CLIENT_TALK_RANGE) continue;
    if (dist < bestDist || (dist === bestDist && best !== undefined && npc.entityId < best)) {
      best = npc.entityId;
      bestDist = dist;
    }
  }
  return best;
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
