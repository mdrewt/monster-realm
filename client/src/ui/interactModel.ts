// ui/interactModel.ts — the world interaction adapter (ctl-10a). Pure: no DOM, SDK or reducer
// identifiers, and NO interaction rule: which entities you can act on is game-core's
// `interact_candidates` ("the tile in front, then your own tile"), reached through the client-wasm
// export `interact_candidates_coded`. This module only marshals store rows into that export's
// input, maps its answer (indices) back to candidates, and names what each candidate offers.
import type { WasmDirection } from '../convert/convert';
import type { StoreCharacter, StoreHealLocationRow, StoreNpcRow, StorePlayer } from '../net/store';
import { TILE_PX } from '../render/config';
import { pickerEntries } from './actionSheetModel';

/** What A or a sheet row does. A shopkeeper's `shop` is sent as the talk reducer (greet-then-shop);
 *  `heal` opens the heal frame bound to that location, it never transacts. `trade` opens the trade
 *  wizard with that player as the target; `challenge` sends a challenge after a Yes-default confirm
 *  (ctl-10b). A player's identity is the store's hex key. */
export type InteractAction =
  | { readonly kind: 'talk'; readonly npcEntityId: bigint }
  | { readonly kind: 'shop'; readonly npcEntityId: bigint }
  | { readonly kind: 'heal'; readonly locationId: number }
  | { readonly kind: 'trade'; readonly playerIdentity: string }
  | { readonly kind: 'challenge'; readonly playerIdentity: string };

export interface InteractCandidate {
  /** `npc:<entityId>`, `heal:<locationId>` or `player:<entityId>`. */
  readonly key: string;
  readonly kind: 'npc' | 'heal' | 'player';
  /** An npc's npcId, a player's name; '' for a heal location (the shell names it). */
  readonly name: string;
  /** In default-first order. An online player offers Trade, then Challenge unless busy. */
  readonly actions: readonly InteractAction[];
  /** SOURCE px at the entity's tile: X tile-centre, Y tile-top (the label floats above it). */
  readonly anchorWorldX: number;
  readonly anchorWorldY: number;
}

/** One entity as `interact_candidates_coded` reads it; `id` is decimal (a u64 never crosses the
 *  boundary as a JS number). */
export interface WireInteractEntity {
  readonly kind: 'npc' | 'heal' | 'player';
  readonly x: number;
  readonly y: number;
  readonly zone: number;
  readonly id: string;
}

/** `wire[i]` is `candidates[i]` as the export sees it. */
export interface InteractInput {
  readonly wire: readonly WireInteractEntity[];
  readonly candidates: readonly InteractCandidate[];
}

/** client-wasm's facing codes (`dir_from_code`). */
export const FACING_CODE: Readonly<Record<WasmDirection, 0 | 1 | 2 | 3>> = {
  North: 0,
  South: 1,
  East: 2,
  West: 3,
};

/** What the character stands on and faces, in the zone it is in. */
export interface InteractOrigin {
  readonly x: number;
  readonly y: number;
  readonly facing: WasmDirection;
  readonly zone: number;
}

/** The export's shape: `(ownX, ownY, facing, zone, entities) -> indices`. */
export type CandidatesFn = (
  ownX: number,
  ownY: number,
  facing: number,
  zone: number,
  entities: unknown,
) => unknown;

/** The actions an npc offers, by its interaction. Exhaustive, no default arm: a new interaction
 *  kind fails client-typecheck here. */
function npcActions(npc: StoreNpcRow): readonly InteractAction[] {
  const interaction = npc.interaction;
  switch (interaction.kind) {
    case 'dialogue':
      return [{ kind: 'talk', npcEntityId: npc.entityId }];
    case 'shop':
      return [{ kind: 'shop', npcEntityId: npc.entityId }];
    case 'heal':
      return [{ kind: 'heal', locationId: interaction.locationId }];
  }
}

/** What a player offers: nothing when offline (the server refuses both); Trade, then Challenge
 *  unless that player or you are in a Pending challenge (`busy`, the identities on both sides of
 *  every Pending challenge, yours included when you are on one). */
function playerActions(
  player: StorePlayer,
  busy: ReadonlySet<string>,
  ownIdentity: string | undefined,
): readonly InteractAction[] {
  if (!player.online) return [];
  const trade: InteractAction = { kind: 'trade', playerIdentity: player.identity };
  const ownBusy = ownIdentity !== undefined && busy.has(ownIdentity);
  return busy.has(player.identity) || ownBusy
    ? [trade]
    : [trade, { kind: 'challenge', playerIdentity: player.identity }];
}

/** Every npc (at its character row; one with no row has no position and is left out), every heal
 *  location and every other player, as the export's input. Nothing is filtered by zone, distance
 *  or facing: that is the rule's. */
export function marshalInteract(
  npcs: readonly StoreNpcRow[],
  characters: Iterable<StoreCharacter>,
  players: readonly StorePlayer[],
  heals: readonly StoreHealLocationRow[],
  ownEntityId: bigint | undefined,
  busy: ReadonlySet<string> = new Set(),
): InteractInput {
  const wire: WireInteractEntity[] = [];
  const candidates: InteractCandidate[] = [];
  const add = (w: WireInteractEntity, name: string, actions: readonly InteractAction[]): void => {
    wire.push(w);
    candidates.push({
      key: `${w.kind}:${w.id}`,
      kind: w.kind,
      name,
      actions,
      anchorWorldX: (w.x + 0.5) * TILE_PX,
      anchorWorldY: w.y * TILE_PX,
    });
  };
  const npcById = new Map(npcs.map((n) => [n.entityId, n]));
  const playerById = new Map(players.map((p) => [p.entityId, p]));
  const ownIdentity = players.find((p) => p.entityId === ownEntityId)?.identity;
  for (const c of characters) {
    if (c.entityId === ownEntityId) continue;
    const at = { x: c.tileX, y: c.tileY, zone: c.zoneId, id: c.entityId.toString() };
    const npc = npcById.get(c.entityId);
    if (npc !== undefined) {
      add({ kind: 'npc', ...at }, npc.npcId, npcActions(npc));
      continue;
    }
    const player = playerById.get(c.entityId);
    if (player !== undefined)
      add({ kind: 'player', ...at }, player.name, playerActions(player, busy, ownIdentity));
  }
  for (const h of heals) {
    add({ kind: 'heal', x: h.tileX, y: h.tileY, zone: h.zoneId, id: h.locationId.toString() }, '', [
      { kind: 'heal', locationId: h.locationId },
    ]);
  }
  return { wire, candidates };
}

/** The candidates `fn` names for `origin`, in its order. TOTAL: no export, a throw (reported to
 *  `onError`), a non-array answer or any index that is not one of `input`'s gives none. */
export function resolveCandidates(
  fn: CandidatesFn | undefined,
  origin: InteractOrigin,
  input: InteractInput,
  onError?: (err: unknown) => void,
): readonly InteractCandidate[] {
  if (fn === undefined) return [];
  let out: unknown;
  try {
    out = fn(origin.x, origin.y, FACING_CODE[origin.facing], origin.zone, input.wire);
  } catch (err) {
    onError?.(err);
    return [];
  }
  if (!Array.isArray(out)) return [];
  const picked: InteractCandidate[] = [];
  for (const i of out) {
    const c = Number.isInteger(i) ? input.candidates[i as number] : undefined;
    if (c === undefined) return [];
    picked.push(c);
  }
  return picked;
}

/** The world chip: what A does with these candidates. Counts their actions, so an offline player
 *  (no action) beside an npc leaves the npc's single action. */
export type InteractChip =
  | {
      readonly kind: 'single';
      readonly candidate: InteractCandidate;
      readonly action: InteractAction;
    }
  | { readonly kind: 'choose'; readonly anchorWorldX: number; readonly anchorWorldY: number };

export function interactChip(cands: readonly InteractCandidate[]): InteractChip | null {
  // The picker's rows, so the chip always says what A (worldButton) does with them.
  const [first, second] = pickerEntries(cands);
  if (first === undefined) return null;
  if (second === undefined)
    return { kind: 'single', candidate: first.candidate, action: first.action };
  const { anchorWorldX, anchorWorldY } = first.candidate;
  return { kind: 'choose', anchorWorldX, anchorWorldY };
}
