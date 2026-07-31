// ui/interactModel.ts — pure context-sensitive interact core (uxd2, ADR-0161 D3/D6).
//
// No DOM, no SDK, no reducer identifiers. TOTAL: never throws — the resolver
// runs EVERY FRAME in main.ts (the prompt) and on every KeyT press; one throw
// would starve the render loop. Replaces dialogueModel's nearestTalkableNpcId
// (deleted, plan I6): ONE resolver drives both the prompt and the dispatch, so
// the prompt can never advertise a target KeyT refuses.
import type { StoreHealLocationRow, StoreNpcRow } from '../net/store';
import { TILE_PX } from '../render/config';

/** Client-side interact range in Manhattan tiles — mirrors the server's
 *  `TALK_RANGE: i64 = 2` (server-module/src/npc.rs:20). Latency hygiene ONLY,
 *  never security: the `talk` reducer re-validates zone + range server-side. */
export const CLIENT_INTERACT_RANGE = 2;

/** The positional subset of a character row the target selection reads. */
export interface InteractTile {
  readonly zoneId: number;
  readonly tileX: number;
  readonly tileY: number;
}

/** A resolved interact target. Anchors are SOURCE px at the TARGET's tile:
 *  X tile-centre `(tileX + 0.5) * TILE_PX`, Y tile-TOP `tileY * TILE_PX` (the
 *  label floats above the head — ADR-0161 D6). The ONLY world→screen transform
 *  is WorldRenderer.screenFor; this module never applies camera or scale. */
export type Interactable =
  | { kind: 'dialogue'; npcEntityId: bigint; anchorWorldX: number; anchorWorldY: number }
  | {
      kind: 'shop';
      npcEntityId: bigint;
      shopId: number;
      anchorWorldX: number;
      anchorWorldY: number;
    }
  | { kind: 'heal'; locationId: number; anchorWorldX: number; anchorWorldY: number };

/** Descriptor for an NPC-row candidate at its CHARACTER tile. Exhaustive over
 *  the interaction union — NO default arm, so a 4th variant compiler-flags
 *  this site (the enum-SSOT rule, ADR-0161 D1). */
function npcDescriptor(npc: StoreNpcRow, tile: InteractTile): Interactable {
  const anchorWorldX = (tile.tileX + 0.5) * TILE_PX;
  const anchorWorldY = tile.tileY * TILE_PX;
  const interaction = npc.interaction;
  switch (interaction.kind) {
    case 'dialogue':
      return { kind: 'dialogue', npcEntityId: npc.entityId, anchorWorldX, anchorWorldY };
    case 'shop':
      return {
        kind: 'shop',
        npcEntityId: npc.entityId,
        shopId: interaction.shopId,
        anchorWorldX,
        anchorWorldY,
      };
    case 'heal':
      // A Heal-variant NPC yields a heal descriptor carrying ITS enum payload,
      // anchored at ITS character tile — but it RANKS as an npc-row candidate
      // (kindRank by SOURCE TABLE, not by this descriptor's kind — D3).
      return { kind: 'heal', locationId: interaction.locationId, anchorWorldX, anchorWorldY };
  }
}

/**
 * Nearest interactable within CLIENT_INTERACT_RANGE of the own AUTHORITATIVE
 * tile (uxd2, ADR-0161 D3). Same-zone only:
 *   - NPC zone comes from the CHARACTER-row join (live wander position), never
 *     the npc registry row's zoneId; NPCs without a character row are skipped.
 *   - Heal rows are filtered by an EXPLICIT `loc.zoneId === own.zoneId` (they
 *     have no character row to inherit from).
 * Ordering is lexicographic on (distance asc, kindRank asc, id asc WITHIN
 * kind); kindRank is by SOURCE TABLE — npc row = 0, heal_location row = 1 — so
 * a bigint entityId and a number locationId are NEVER compared to each other
 * (a cross-kind compare inverts NPC-before-tile for every real entity_id).
 * Returns undefined when nothing is in range. TOTAL: never throws.
 */
export function nearestInteractable(
  own: InteractTile,
  npcs: readonly StoreNpcRow[],
  characterTiles: ReadonlyMap<bigint, InteractTile>,
  healLocations: readonly StoreHealLocationRow[],
): Interactable | undefined {
  let best: Interactable | undefined;
  let bestDist = CLIENT_INTERACT_RANGE + 1;
  let bestRank: 0 | 1 = 1;
  let bestNpcId = 0n; // id-within-kind, valid only while bestRank === 0
  let bestHealId = 0; // id-within-kind, valid only while bestRank === 1

  // npc-row candidates (kindRank 0).
  for (const npc of npcs) {
    const c = characterTiles.get(npc.entityId);
    if (c === undefined || c.zoneId !== own.zoneId) continue;
    const dist = Math.abs(c.tileX - own.tileX) + Math.abs(c.tileY - own.tileY);
    if (dist > CLIENT_INTERACT_RANGE) continue;
    const wins =
      best === undefined ||
      dist < bestDist ||
      (dist === bestDist && (bestRank === 1 || npc.entityId < bestNpcId));
    if (!wins) continue;
    bestDist = dist;
    bestRank = 0;
    bestNpcId = npc.entityId;
    best = npcDescriptor(npc, c);
  }

  // heal_location-row candidates (kindRank 1) — explicit zone filter.
  for (const loc of healLocations) {
    if (loc.zoneId !== own.zoneId) continue;
    const dist = Math.abs(loc.tileX - own.tileX) + Math.abs(loc.tileY - own.tileY);
    if (dist > CLIENT_INTERACT_RANGE) continue;
    const wins =
      best === undefined ||
      dist < bestDist ||
      (dist === bestDist && bestRank === 1 && loc.locationId < bestHealId);
    if (!wins) continue;
    bestDist = dist;
    bestRank = 1;
    bestHealId = loc.locationId;
    best = {
      kind: 'heal',
      locationId: loc.locationId,
      anchorWorldX: (loc.tileX + 0.5) * TILE_PX,
      anchorWorldY: loc.tileY * TILE_PX,
    };
  }

  return best;
}

/** The on-world prompt view model (ADR-0161 D6). `visible` is the literal
 *  `true`: "hidden" is represented by null and ONLY by null. The anchor stays
 *  in SOURCE px — screenFor applies the one tested transform. */
export interface InteractPromptViewModel {
  readonly visible: true;
  readonly actionWord: 'Talk' | 'Shop' | 'Heal';
  readonly keyGlyph: 'T';
  readonly anchorWorldX: number;
  readonly anchorWorldY: number;
}

/**
 * Prompt VM for the resolved target: null when there is no target OR any of
 * the 14 mutual-exclusion overlays is visible (AC-6 — the world label never
 * renders over an open UI). The actionWord names the DESTINATION (a shopkeeper
 * prompts "Shop" even though KeyT dispatches the talk reducer — AC-12).
 */
export function interactPrompt(
  target: Interactable | undefined,
  anyOverlayVisible: boolean,
): InteractPromptViewModel | null {
  if (target === undefined || anyOverlayVisible) return null;
  let actionWord: 'Talk' | 'Shop' | 'Heal';
  switch (target.kind) {
    case 'dialogue':
      actionWord = 'Talk';
      break;
    case 'shop':
      actionWord = 'Shop';
      break;
    case 'heal':
      actionWord = 'Heal';
      break;
  }
  return {
    visible: true,
    actionWord,
    keyGlyph: 'T',
    anchorWorldX: target.anchorWorldX,
    anchorWorldY: target.anchorWorldY,
  };
}
