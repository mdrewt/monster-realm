// ui/exportAssembly.ts — the PURE data-export assembly core (M22 S8, ADR-0231).
//
// FUNCTIONAL CORE (ADR-0014). No DOM, no SDK, no store, no clock, no I/O — the whole module is
// one total function over rows the caller has already normalised. PRV1-11/12/13.
//
// THE CHUNK FIELDS ARE READ REQUEST-WIDE, VERBATIM FROM THE PRODUCER. `chunk_index` is globally
// contiguous 0..N-1 across the WHOLE request and `total_chunks` is the request's whole chunk count
// (server-module/src/privacy.rs, `plan_export_chunks` + the `request_data_export` insert loop).
// Spec PRV1-13's prose ("split THAT TABLE's payload") and §5's ("one row per
// (owner_identity, request_id, table_name)") both read per-table, and the shipped producer is
// neither — §7.3 makes the producer the contract, so it wins. A per-table completeness check
// passes on real data by accident and would silently accept an incomplete export.
//
// `exportable` IS A SERVER-SIDE AXIS. `request_data_export` filters the manifest on
// `entry.exportable` before any row is written, so a non-exportable table can never arrive as a
// chunk. This module applies NO allowlist, filter or redaction of its own: one would be a second
// SSOT for PRV1-12 and could only ever hide data the player is entitled to.
//
// NO `JSON.parse`, EVER — enforced by a source scan in the sibling spec, because a
// parse/re-encode round trip is BYTE-IDENTICAL on well-formed server output and byte equality
// therefore cannot detect it. The server hand-rolls its JSON with every 64-bit integer as a
// QUOTED decimal string precisely so this client never re-encodes them (that is what keeps values
// above 2^53 exact), and it escapes `"`, `\` and every codepoint below 0x20, so a player-authored
// name cannot break out of the envelope this module splices. Parsing would re-open the precision
// hole and would throw `SyntaxError` on a torn chunk inside an SDK callback that has no
// per-listener isolation (ADR-0085 A6).

/** One `export_bundle` row, normalised. Field types are pinned from the generated binding
 *  `client/src/module_bindings/my_export_bundle_table.ts`: u64 -> bigint, u32 -> number,
 *  Identity -> the caller's `toHexString()` result. */
export interface ExportChunkInput {
  readonly chunkId: bigint;
  readonly ownerIdentity: string;
  readonly requestId: bigint;
  readonly tableName: string;
  /** REQUEST-WIDE 0..totalChunks-1, not per-table. */
  readonly chunkIndex: number;
  /** The REQUEST's whole chunk count, not the table's. */
  readonly totalChunks: number;
  /** The server's bytes. Spliced verbatim; never parsed, never re-encoded. */
  readonly payloadJson: string;
  readonly createdAtMs: bigint;
}

/**
 * - `none` — nothing of this owner's has arrived (or the owner is not addressable).
 * - `incomplete` — the newest request is still streaming in. §5's wait rule; the ORDINARY state.
 * - `inconsistent` — the delivered rows cannot describe one coherent request.
 * - `complete` — and ONLY then is there an artifact.
 */
export type ExportAssemblyStatus = 'none' | 'incomplete' | 'inconsistent' | 'complete';

export interface ExportAssembly {
  readonly status: ExportAssemblyStatus;
  /** The SELECTED (newest own-owner) request, present on every status but `none`. */
  readonly requestId: bigint | undefined;
  /** Own-owner chunks OF THE SELECTED REQUEST. */
  readonly receivedChunks: number;
  /** `undefined` on `none` and on `inconsistent` — when the delivered values disagree or are
   *  invalid there is no defensible number to report, and reporting one leaks a fabricated
   *  total (or a fractional one) into the UI. */
  readonly totalChunks: number | undefined;
  /** Present iff `status === 'complete'`. */
  readonly artifact: string | undefined;
}

const NONE: ExportAssembly = {
  status: 'none',
  requestId: undefined,
  receivedChunks: 0,
  totalChunks: undefined,
  artifact: undefined,
};

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

/**
 * Assemble the newest complete export for `ownerIdentity` into one downloadable artifact.
 *
 * TOTAL: never throws, for any input. Ordering-immune (the SDK cache gives no order guarantee).
 */
export function assembleExportBundle(
  chunks: readonly ExportChunkInput[],
  ownerIdentity: string,
): ExportAssembly {
  // An unresolved identity must never address someone else's rows: with no owner to compare
  // against, an `undefined === undefined` match would return every chunk in the cache.
  if (typeof ownerIdentity !== 'string' || ownerIdentity === '') return NONE;

  // THE OWNER FILTER RUNS FIRST, AND ITS RESULT IS THE ONLY ARRAY THAT REACHES THE ARTIFACT.
  // Filtering merely to SELECT the request and then splicing the raw input is the measured leak:
  // a foreign chunk sharing the live request_id lands in the file the player downloads.
  // Exact comparison — no case folding, no trimming (the store's own owner-filter rule).
  const mine = chunks.filter((c) => c.ownerIdentity === ownerIdentity);
  if (mine.length === 0) return NONE;

  // Newest request by BIGINT comparison in a reduce. `.sort()` here is a string compare, under
  // which `9n` beats `10n` and the client serves the PREVIOUS export as if it were fresh.
  let requestId = mine[0].requestId;
  for (const c of mine) {
    if (c.requestId > requestId) requestId = c.requestId;
  }
  // Older requests are DROPPED, never merged: a stale chunk must not fill a hole in the new one.
  const selected = mine.filter((c) => c.requestId === requestId);
  const receivedChunks = selected.length;
  const inconsistent: ExportAssembly = {
    status: 'inconsistent',
    requestId,
    receivedChunks,
    totalChunks: undefined,
    artifact: undefined,
  };

  const totalChunks = selected[0].totalChunks;
  if (!isPositiveInt(totalChunks)) return inconsistent;

  const seen = new Set<number>();
  for (const c of selected) {
    if (c.totalChunks !== totalChunks) return inconsistent;
    // `Number.isInteger` is load-bearing, not defensive: a bare `idx < 0 || idx >= total` range
    // test admits NaN (every relational comparison against it is false) and fractions, and a
    // count-based completeness check then reports COMPLETE for an export that is missing a chunk.
    if (!Number.isInteger(c.chunkIndex)) return inconsistent;
    if (c.chunkIndex < 0 || c.chunkIndex >= totalChunks) return inconsistent;
    if (seen.has(c.chunkIndex)) return inconsistent;
    seen.add(c.chunkIndex);
  }

  if (seen.size < totalChunks) {
    return { status: 'incomplete', requestId, receivedChunks, totalChunks, artifact: undefined };
  }

  // Sort by the REQUEST-WIDE index, then splice the payload bytes verbatim.
  const ordered = [...selected].sort((a, b) => a.chunkIndex - b.chunkIndex);
  let artifact = '{"request_id":"';
  artifact += requestId.toString();
  artifact += '","total_chunks":';
  artifact += String(totalChunks);
  artifact += ',"chunks":[';
  for (let i = 0; i < ordered.length; i += 1) {
    if (i > 0) artifact += ',';
    artifact += ordered[i].payloadJson;
  }
  artifact += ']}';

  return { status: 'complete', requestId, receivedChunks, totalChunks, artifact };
}
