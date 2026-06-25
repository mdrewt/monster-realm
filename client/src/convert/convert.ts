// convert.ts — the marshaling boundary between the SpacetimeDB SDK binding shapes
// (camelCase columns, `bigint` ids, tagged-union enums `{tag:"West"}`) and the
// wasm/serde shapes client-wasm consumes/produces (bare enum strings, plain
// numbers). DUMB + EXPLICIT on purpose: no clever shared abstraction across the
// boundary ("DRY, but NOT across marshaling boundaries"). Entity ids stay `bigint`
// end-to-end; only bounded-magnitude CharacterState fields cross to wasm as numbers.

// --- wasm / serde shapes (mirror game-core's serde derives; verified by probe) --
export type WasmDirection = 'North' | 'South' | 'East' | 'West';
export type WasmAction = 'Idle' | 'Walking' | 'Jumping';
/** `MoveInput::Step(dir)` -> `{Step:"East"}`; the unit `MoveInput::Jump` -> `"Jump"`. */
export type WasmMoveInput = { readonly Step: WasmDirection } | 'Jump';
export interface WasmCharacterState {
  readonly pos: { readonly x: number; readonly y: number };
  readonly facing: WasmDirection;
  readonly action: WasmAction;
  readonly move_started_at: number;
}

// --- SDK binding shapes (tagged unions; see src/module_bindings/types.ts) --------
export type SdkDirection = { readonly tag: WasmDirection };
export type SdkAction = { readonly tag: WasmAction };
export type SdkMoveInput = { readonly tag: 'Step'; readonly value: SdkDirection } | { readonly tag: 'Jump' };

/**
 * The movement-bearing subset of the generated `character` row that convert reads.
 * The full row also carries `entityId`/`zoneId`/`spriteId`/… — those never cross to
 * wasm; in particular `entityId` stays `bigint` as M4's store key.
 */
export interface SdkCharacterFields {
  readonly tileX: number;
  readonly tileY: number;
  readonly facing: SdkDirection;
  readonly action: SdkAction;
  readonly moveStartedAtMs: bigint;
}

// --- Direction ------------------------------------------------------------------
export function directionToWasm(d: SdkDirection): WasmDirection {
  return d.tag;
}
export function directionToSdk(d: WasmDirection): SdkDirection {
  return { tag: d };
}

// --- MoveInput ------------------------------------------------------------------
export function moveInputToWasm(m: SdkMoveInput): WasmMoveInput {
  return m.tag === 'Jump' ? 'Jump' : { Step: m.value.tag };
}
export function moveInputToSdk(m: WasmMoveInput): SdkMoveInput {
  return m === 'Jump' ? { tag: 'Jump' } : { tag: 'Step', value: { tag: m.Step } };
}

// --- move_queue -----------------------------------------------------------------
export function moveQueueToWasm(q: readonly SdkMoveInput[]): WasmMoveInput[] {
  return q.map(moveInputToWasm);
}
export function moveQueueToSdk(q: readonly WasmMoveInput[]): SdkMoveInput[] {
  return q.map(moveInputToSdk);
}

// --- CharacterState -------------------------------------------------------------
// `moveStartedAtMs` (i64) -> number: it is a millisecond stamp, bounded far under
// 2^53 (safe for ~285k years), and the predicted baseline discards the server epoch
// anyway. Entity ids are NOT touched here — they remain `bigint` on the row.
export function characterToWasm(row: SdkCharacterFields): WasmCharacterState {
  return {
    pos: { x: row.tileX, y: row.tileY },
    facing: row.facing.tag,
    action: row.action.tag,
    move_started_at: Number(row.moveStartedAtMs),
  };
}
/** Inverse of {@link characterToWasm} over the movement subset (for round-trip proofs). */
export function characterFieldsFromWasm(s: WasmCharacterState): SdkCharacterFields {
  return {
    tileX: s.pos.x,
    tileY: s.pos.y,
    facing: { tag: s.facing },
    action: { tag: s.action },
    moveStartedAtMs: BigInt(s.move_started_at),
  };
}

// --- the time-rebasing baseline (ADR-0012; LOSSY, never round-tripped) ----------
// There is no clock sync: the server's `move_started_at` is epoch ms; the local
// drain runs off `performance.now()` (which starts at 0). Rebase to a LOCAL
// "two steps ago" so the first queued move is immediately due. `floor` is required
// (a fractional value fails the integer `Millis` serde); `max(0, …)` is a sane-
// baseline clamp. Never feed the raw server epoch into the local drain.
export function characterToPredictedBaseline(
  row: SdkCharacterFields,
  localNow: number,
  stepMs: number,
): WasmCharacterState {
  return {
    ...characterToWasm(row),
    move_started_at: Math.max(0, Math.floor(localNow) - 2 * stepMs),
  };
}
