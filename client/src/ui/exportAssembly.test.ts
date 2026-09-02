// ui/exportAssembly.test.ts — PRV1-11 / PRV1-12 / PRV1-13, the client half (M22 S8,
// ADR-0231). Gates X5 / X6 / X8 of memory/projects/gates/m22-s8.gates.md.
//
// EARS COVERED (spec specs/monster-realm-v2/M22-privacy-compliance.spec.md §5, §7.4)
//   PRV1-11/12 — the export bundle the player downloads contains exactly the data the SERVER
//                decided to export. `exportable` is a SERVER-side axis: `request_data_export`
//                filters `DATA_LIFECYCLE_MANIFEST` on `entry.exportable`
//                (server-module/src/privacy.rs:1496-1498) BEFORE any row is written, so a
//                non-exportable table can never arrive as a chunk. The client surfaces what
//                arrived and applies NO allowlist of its own — a client-side filter would be
//                a second SSOT for PRV1-12.
//   PRV1-13   — a multi-chunk export is reassembled into ONE artifact. `chunk_index` /
//                `total_chunks` are REQUEST-WIDE, not per-table (privacy.rs:1092-1094 and the
//                insert loop at :1519-1531); a per-table completeness check passes on real
//                data by accident and fails only on the day it matters.
//
// RED REASON AT AUTHORING TIME: `client/src/ui/exportAssembly.ts` DOES NOT EXIST. The import
// below fails to resolve, so every test in this file reds on a MISSING IMPLEMENTATION.
//
// THE CONTRACT THE IMPLEMENTER BUILDS (verbatim from the m22-s8 plan; the field TYPES are
// pinned from client/src/module_bindings/my_export_bundle_table.ts):
//
//   export interface ExportChunkInput {
//     readonly chunkId: bigint;      // u64
//     readonly ownerIdentity: string;// the HEX string — s8b's converter does toHexString()
//     readonly requestId: bigint;    // u64
//     readonly tableName: string;
//     readonly chunkIndex: number;   // u32 — REQUEST-WIDE, 0..totalChunks-1
//     readonly totalChunks: number;  // u32 — the REQUEST's whole chunk count
//     readonly payloadJson: string;  // verbatim server JSON
//     readonly createdAtMs: bigint;  // i64
//   }
//   export type ExportAssemblyStatus = 'none' | 'incomplete' | 'inconsistent' | 'complete';
//   export interface ExportAssembly {
//     readonly status: ExportAssemblyStatus;
//     readonly requestId: bigint | undefined;
//     readonly receivedChunks: number;
//     readonly totalChunks: number | undefined;
//     readonly artifact: string | undefined;   // ONLY when 'complete'
//   }
//   export function assembleExportBundle(
//     chunks: readonly ExportChunkInput[], ownerIdentity: string): ExportAssembly;
//
// ★ REPORTED FIELDS, resolved during this slice's test phase and authoritative here:
//   * `receivedChunks` counts the own-owner chunks OF THE SELECTED (newest) REQUEST — never
//     the whole cache, never another owner's rows.
//   * on `'inconsistent'`, `requestId` IS the selected request (selection precedes
//     validation) and `totalChunks` is `undefined` — the delivered values disagree or are
//     invalid, so there is no defensible number, and a fabricated one is a count the UI will
//     happily render ("1 of 2") for a bundle that can never complete.
//   * on `'none'`, `requestId` and `totalChunks` are `undefined` and `receivedChunks` is 0.
//
// THE ARTIFACT IS BUILT BY STRING SPLICING ONLY:
//   {"request_id":"<decimal>","total_chunks":<n>,"chunks":[<payloadJson>,…]}
// The server hand-rolls its JSON with every 64-bit integer as a QUOTED decimal string
// (`json_u64_into` / `json_i64_into`, privacy.rs:113-127) precisely so the client never
// re-encodes, and `json_escape_into` (:85-105) escapes `"`, `\` and every codepoint < 0x20 so
// a player-authored name cannot break the envelope. A `JSON.parse` round trip is
// BYTE-IDENTICAL on well-formed server output — measured — which is why the ban is enforced
// by a SOURCE SCAN plus a malformed-payload no-throw tooth, and never by byte equality.
//
// NO `new RegExp(...)` anywhere (Semgrep `detect-non-literal-regexp`, banned repo-wide).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assembleExportBundle,
  type ExportAssembly,
  type ExportAssemblyStatus,
  type ExportChunkInput,
} from './exportAssembly';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const ME = 'ac0011223344aabb';
const FOREIGN = 'be99887766554433';

/** Two payloads whose exact bytes are asserted on. Deliberately hand-shaped like the
 *  server's own output: quoted decimals for every 64-bit integer. */
const P0 = '{"table":"player_monster","rows":[{"pm_id":"1"}]}';
const P1 = '{"table":"player_wallet","rows":[{"balance":"7"}]}';
const P2 = '{"table":"player_quest","rows":[{"pq_id":"3"}]}';

function chunkOf(overrides: Partial<ExportChunkInput> = {}): ExportChunkInput {
  return {
    chunkId: 1n,
    ownerIdentity: ME,
    requestId: 7n,
    tableName: 'player_monster',
    chunkIndex: 0,
    totalChunks: 1,
    payloadJson: P0,
    createdAtMs: 1_700_000_000_000n,
    ...overrides,
  };
}

const ALL_STATUSES: readonly ExportAssemblyStatus[] = [
  'none',
  'incomplete',
  'inconsistent',
  'complete',
];

/** `JSON.stringify` THROWS on a BigInt and `ExportAssembly.requestId` is one. Used by the
 *  leak assertions, which must be able to search the WHOLE result, not just the artifact. */
function show(value: unknown): string {
  return JSON.stringify(value, (_key, raw) => (typeof raw === 'bigint' ? `${raw}n` : raw));
}

function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

// ===========================================================================
// PRV1-13 — request-wide multi-chunk assembly. Gate X6.
// ===========================================================================

describe('assembleExportBundle (PRV1-13): assembling one artifact from many chunks', () => {
  it('★★ S8T-ASSEMBLE-COMPLETE BITES: a full 0..n-1 cover splices ONE artifact in chunkIndex order', () => {
    // The chunks are handed in REVERSE order on purpose: the SDK cache has no ordering
    // guarantee, so an implementation that splices input order produces a corrupt bundle that
    // looks right in every hand test where the rows happened to arrive sorted.
    //
    // WRONG IMPLS KILLED:
    //   (a) splicing in input order — the payloads come out swapped.
    //   (b) `Number(requestId)` / an unquoted `request_id` — the server writes every 64-bit
    //       integer as a QUOTED decimal (privacy.rs:113-127) and re-encoding reopens the 2^53
    //       hole. The second assertion uses 2^53+1, the first value a JS number cannot hold.
    //   (c) a JSON.stringify round trip of the payloads — the payload would come back as a
    //       QUOTED STRING inside "chunks", not as embedded JSON.
    const result = assembleExportBundle(
      [
        chunkOf({ chunkId: 2n, chunkIndex: 1, totalChunks: 2, payloadJson: P1 }),
        chunkOf({ chunkId: 1n, chunkIndex: 0, totalChunks: 2, payloadJson: P0 }),
      ],
      ME,
    );
    expect(result.status).toBe('complete');
    expect(result.requestId).toBe(7n);
    expect(result.receivedChunks).toBe(2);
    expect(result.totalChunks).toBe(2);
    expect(result.artifact).toBe(
      `{"request_id":"7","total_chunks":2,"chunks":[${P0},${P1}]}`,
    );

    const huge = assembleExportBundle(
      [chunkOf({ requestId: 9007199254740993n, chunkIndex: 0, totalChunks: 1 })],
      ME,
    );
    expect(huge.requestId).toBe(9007199254740993n);
    expect(huge.artifact).toBe(`{"request_id":"9007199254740993","total_chunks":1,"chunks":[${P0}]}`);
    expect(
      String(huge.artifact).indexOf('9007199254740992'),
      'a Number() round trip lands on 9007199254740992 — the classic silent corruption',
    ).toBe(-1);
  });

  it('★★ S8T-ASSEMBLE-INCOMPLETE BITES: a missing index yields `incomplete` with NO artifact', () => {
    // §5's wait rule: chunks stream in, so "not all here yet" is the ORDINARY state and must
    // never produce a partial download the player believes is their whole account.
    //
    // WRONG IMPL KILLED: `if (chunks.length > 0) build(...)` — a one-chunk-of-three bundle is
    // handed over as a complete export, and the player deletes their account believing they
    // have a copy of everything.
    const result = assembleExportBundle(
      [
        chunkOf({ chunkId: 1n, chunkIndex: 0, totalChunks: 3, payloadJson: P0 }),
        chunkOf({ chunkId: 3n, chunkIndex: 2, totalChunks: 3, payloadJson: P2 }),
      ],
      ME,
    );
    expect(result.status).toBe('incomplete');
    expect(result.artifact, 'no artifact may exist outside `complete`').toBeUndefined();
    expect(result.receivedChunks).toBe(2);
    expect(result.totalChunks).toBe(3);
    expect(result.requestId).toBe(7n);
  });

  it('★★ S8T-ASSEMBLE-DUPLICATE-INDEX BITES: a repeated chunkIndex is `inconsistent`, never silently deduped or padded', () => {
    // ★ THE COUNT-VS-COVER TOOTH. With `total_chunks: 2` and indices [0, 1, 1] the DISTINCT
    // index count is 2 — so a `new Set(indices).size === total` check says COMPLETE and the
    // splice then writes THREE payloads into a two-chunk envelope. The duplicate is a real
    // possibility: `chunk_id` is `#[auto_inc]` unique, so two rows can carry the same
    // `chunk_index` for one request without violating any server constraint.
    const duplicated = assembleExportBundle(
      [
        chunkOf({ chunkId: 1n, chunkIndex: 0, totalChunks: 2, payloadJson: P0 }),
        chunkOf({ chunkId: 2n, chunkIndex: 1, totalChunks: 2, payloadJson: P1 }),
        chunkOf({ chunkId: 3n, chunkIndex: 1, totalChunks: 2, payloadJson: P2 }),
      ],
      ME,
    );
    expect(duplicated.status).toBe('inconsistent');
    expect(duplicated.artifact).toBeUndefined();
    expect(duplicated.requestId, 'the SELECTED request is still reported').toBe(7n);
    expect(
      duplicated.totalChunks,
      'the delivered totals are contradictory, so there is no defensible number to report — ' +
        'a fabricated one would let the UI render "1 of 2" for a bundle that can never complete',
    ).toBeUndefined();

    // And the other shape: a duplicate that leaves a HOLE is inconsistent too, not merely
    // `incomplete` — the data is contradictory, and telling the player "still waiting" would
    // leave them waiting forever for a chunk that will never come.
    const holed = assembleExportBundle(
      [
        chunkOf({ chunkId: 1n, chunkIndex: 0, totalChunks: 2, payloadJson: P0 }),
        chunkOf({ chunkId: 2n, chunkIndex: 0, totalChunks: 2, payloadJson: P1 }),
      ],
      ME,
    );
    expect(holed.status).toBe('inconsistent');
    expect(holed.artifact).toBeUndefined();
    expect(holed.requestId).toBe(7n);
    expect(holed.totalChunks).toBeUndefined();
  });

  it('★★ S8T-ASSEMBLE-NONINTEGER BITES: NaN / fractional indices and a fractional totalChunks are `inconsistent`', () => {
    // ★ THE RT3 TOOTH, measured. A bare range check `idx < 0 || idx >= total` admits BOTH
    // `NaN` (every comparison with NaN is false, so it passes) and `1.5` — and with a
    // distinct-count completeness check the bundle then reports COMPLETE while silently
    // dropping or misplacing a chunk. `2.5` as `total_chunks` is the mirror: it otherwise
    // reaches the envelope verbatim as `"total_chunks":2.5`, which is not what the server
    // wrote and not what any consumer can read.
    const cases: readonly (readonly [string, ExportChunkInput[]])[] = [
      [
        'NaN index',
        [
          chunkOf({ chunkId: 1n, chunkIndex: 0, totalChunks: 3, payloadJson: P0 }),
          chunkOf({ chunkId: 2n, chunkIndex: 1, totalChunks: 3, payloadJson: P1 }),
          chunkOf({ chunkId: 3n, chunkIndex: Number.NaN, totalChunks: 3, payloadJson: P2 }),
        ],
      ],
      [
        'fractional index',
        [
          chunkOf({ chunkId: 1n, chunkIndex: 0, totalChunks: 3, payloadJson: P0 }),
          chunkOf({ chunkId: 2n, chunkIndex: 1, totalChunks: 3, payloadJson: P1 }),
          chunkOf({ chunkId: 3n, chunkIndex: 1.5, totalChunks: 3, payloadJson: P2 }),
        ],
      ],
      [
        'fractional totalChunks',
        [
          chunkOf({ chunkId: 1n, chunkIndex: 0, totalChunks: 2.5, payloadJson: P0 }),
          chunkOf({ chunkId: 2n, chunkIndex: 1, totalChunks: 2.5, payloadJson: P1 }),
        ],
      ],
      ['zero totalChunks', [chunkOf({ chunkIndex: 0, totalChunks: 0 })]],
      ['negative totalChunks', [chunkOf({ chunkIndex: 0, totalChunks: -1 })]],
      ['NaN totalChunks', [chunkOf({ chunkIndex: 0, totalChunks: Number.NaN })]],
      [
        'a non-number index that slipped past the types',
        [chunkOf({ chunkIndex: '0' as unknown as number, totalChunks: 1 })],
      ],
    ];
    for (const [label, chunks] of cases) {
      const result = assembleExportBundle(chunks, ME);
      expect(result.status, label).toBe('inconsistent');
      expect(
        result.artifact,
        `${label}: no artifact may escape an inconsistent bundle`,
      ).toBeUndefined();
      expect(result.requestId, `${label}: the SELECTED request is still reported`).toBe(7n);
      expect(
        result.totalChunks,
        `${label}: an invalid total is NOT a total — reporting 2.5 (or a NaN-derived number) ` +
          'hands the UI a count it will happily render',
      ).toBeUndefined();
    }
  });

  it('★★ S8T-ASSEMBLE-STALE-9-VS-10 BITES: request 10n beats request 9n — a bigint max, never a .sort()', () => {
    // ★ THE RT8 TOOTH, measured. `[...].sort()` with no comparator is a STRING compare, so
    // '9' > '10' and the client serves the PREVIOUS export as if it were the fresh one. This
    // fixture is adversarial about it: the STALE request (9n) is COMPLETE and holds exactly
    // the index the LIVE request (10n) is still missing.
    //
    // WRONG IMPLS KILLED:
    //   (a) `.sort()` picking 9n — the assembly reports `complete` and hands the player the
    //       previous export, which is precisely the data they asked to be re-generated.
    //   (b) merging the two requests — index 1 from request 9 fills request 10's hole and the
    //       "complete" artifact is a splice of two different exports.
    const result = assembleExportBundle(
      [
        chunkOf({ chunkId: 1n, requestId: 9n, chunkIndex: 0, totalChunks: 2, payloadJson: P0 }),
        chunkOf({ chunkId: 2n, requestId: 9n, chunkIndex: 1, totalChunks: 2, payloadJson: P1 }),
        chunkOf({ chunkId: 3n, requestId: 10n, chunkIndex: 0, totalChunks: 2, payloadJson: P2 }),
      ],
      ME,
    );
    expect(result.requestId, 'the NEWEST request is 10n, not the lexically-largest 9n').toBe(10n);
    expect(result.status).toBe('incomplete');
    expect(result.artifact).toBeUndefined();
    expect(result.receivedChunks, 'only the live request`s own chunk counts').toBe(1);
    expect(result.totalChunks).toBe(2);
    // The stale request's payloads must not appear ANYWHERE in the result, artifact or not.
    const rendered = show(result);
    expect(rendered.indexOf('player_monster'), 'stale request 9n leaked P0').toBe(-1);
    expect(rendered.indexOf('player_wallet'), 'stale request 9n leaked P1').toBe(-1);
  });

  it('★★ S8T-ASSEMBLE-MIXED-OWNER-LEAK BITES: a foreign-owner chunk sharing the live request never reaches the artifact', () => {
    // ★ THE RT2 TOOTH, measured. The dangerous implementation filters by owner ONLY to SELECT
    // the newest request and then splices `chunks` — the RAW input — so another player's
    // export chunk lands inside this player's download. `my_export_bundle` is owner-scoped
    // today, but the assembly core is the last line of defence and takes `ownerIdentity` as a
    // parameter precisely so it can be the one that holds.
    const shared = assembleExportBundle(
      [
        chunkOf({ chunkId: 1n, ownerIdentity: ME, chunkIndex: 0, totalChunks: 2, payloadJson: P0 }),
        chunkOf({
          chunkId: 2n,
          ownerIdentity: FOREIGN,
          chunkIndex: 1,
          totalChunks: 2,
          payloadJson: P1,
        }),
      ],
      ME,
    );
    expect(shared.status, 'the foreign chunk does NOT complete the bundle').toBe('incomplete');
    expect(shared.artifact).toBeUndefined();
    expect(shared.receivedChunks, 'only own-owner chunks are counted').toBe(1);
    expect(
      show(shared).indexOf('player_wallet'),
      'the foreign payload must not appear anywhere in the result',
    ).toBe(-1);

    // The same leak in the shape where it would otherwise look like a SUCCESS: the foreign
    // chunk is the last one missing, so a raw splice would report `complete`.
    const wouldComplete = assembleExportBundle(
      [
        chunkOf({ chunkId: 1n, ownerIdentity: ME, chunkIndex: 0, totalChunks: 3, payloadJson: P0 }),
        chunkOf({ chunkId: 2n, ownerIdentity: ME, chunkIndex: 1, totalChunks: 3, payloadJson: P1 }),
        chunkOf({
          chunkId: 3n,
          ownerIdentity: FOREIGN,
          chunkIndex: 2,
          totalChunks: 3,
          payloadJson: P2,
        }),
      ],
      ME,
    );
    expect(wouldComplete.status).toBe('incomplete');
    expect(wouldComplete.artifact).toBeUndefined();
    expect(show(wouldComplete).indexOf('player_quest')).toBe(-1);
  });

  it('★★ BITES: chunks disagreeing on totalChunks, or an index outside the range, are inconsistent', () => {
    // `total_chunks` is written once per request by the same insert loop
    // (privacy.rs:1519-1531), so a disagreement means the client is looking at rows it cannot
    // reconcile — reporting `incomplete` there would wait forever, and picking one of the two
    // values would invent an answer.
    const disagreeing = assembleExportBundle(
      [
        chunkOf({ chunkId: 1n, chunkIndex: 0, totalChunks: 2, payloadJson: P0 }),
        chunkOf({ chunkId: 2n, chunkIndex: 1, totalChunks: 3, payloadJson: P1 }),
      ],
      ME,
    );
    expect(disagreeing.status).toBe('inconsistent');
    expect(disagreeing.artifact).toBeUndefined();
    expect(disagreeing.requestId).toBe(7n);
    expect(
      disagreeing.totalChunks,
      'picking one of the two disagreeing values would invent an answer',
    ).toBeUndefined();

    for (const [label, index] of [
      ['above the range', 5],
      ['negative', -1],
    ] as const) {
      const result = assembleExportBundle(
        [
          chunkOf({ chunkId: 1n, chunkIndex: 0, totalChunks: 2, payloadJson: P0 }),
          chunkOf({ chunkId: 2n, chunkIndex: index, totalChunks: 2, payloadJson: P1 }),
        ],
        ME,
      );
      expect(result.status, `index ${label}`).toBe('inconsistent');
      expect(result.artifact, `index ${label}`).toBeUndefined();
      expect(result.totalChunks, `index ${label}`).toBeUndefined();
    }

    // ★ AND THE SELECTION HAPPENS FIRST: a BROKEN newest request is still the reported one,
    // even when an older request is perfectly well-formed. WRONG IMPL KILLED: falling back to
    // the last good request on an inconsistency — the player would be handed the previous
    // export's identity for a bundle that is not it.
    const brokenNewest = assembleExportBundle(
      [
        chunkOf({ chunkId: 1n, requestId: 9n, chunkIndex: 0, totalChunks: 1, payloadJson: P0 }),
        chunkOf({ chunkId: 2n, requestId: 10n, chunkIndex: 0, totalChunks: 2, payloadJson: P1 }),
        chunkOf({ chunkId: 3n, requestId: 10n, chunkIndex: 0, totalChunks: 2, payloadJson: P2 }),
      ],
      ME,
    );
    expect(brokenNewest.status).toBe('inconsistent');
    expect(brokenNewest.requestId, 'selection precedes validation').toBe(10n);
    expect(brokenNewest.totalChunks).toBeUndefined();
    expect(brokenNewest.artifact).toBeUndefined();
  });

  it('★★ BITES: nothing to assemble is `none` — an empty cache, an empty owner, and an all-foreign cache', () => {
    // `none` and `incomplete` are DIFFERENT states (ADR-0154's broke-vs-dark rule applied to
    // the export): "you have not asked for an export" must not render as "your export is
    // still coming".
    for (const [label, chunks, owner] of [
      ['no chunks at all', [], ME],
      ['an empty owner identity (RT13)', [chunkOf()], ''],
      ['only foreign chunks', [chunkOf({ ownerIdentity: FOREIGN })], ME],
      ['an owner that matches nothing', [chunkOf()], FOREIGN],
    ] as const) {
      const result = assembleExportBundle(chunks, owner);
      expect(result.status, label).toBe('none');
      expect(result.artifact, label).toBeUndefined();
      expect(result.requestId, label).toBeUndefined();
      expect(result.totalChunks, label).toBeUndefined();
      expect(result.receivedChunks, label).toBe(0);
    }

    // The owner match is EXACT — no case folding, no trimming. Any normalisation applied here
    // and not at the `toHexString()` call site silently empties (or, far worse, mis-fills) the
    // player's download.
    expect(assembleExportBundle([chunkOf({ ownerIdentity: ME })], ME.toUpperCase()).status).toBe(
      'none',
    );
    expect(assembleExportBundle([chunkOf({ ownerIdentity: ME })], ` ${ME} `).status).toBe('none');
  });
});

// ===========================================================================
// PRV1-11 / PRV1-12 — no client-side second SSOT. Gate X5.
// ===========================================================================

describe('assembleExportBundle (PRV1-11/12): the client re-derives nothing', () => {
  it('★★ S8T-NO-CLIENT-ALLOWLIST BITES: a table name no allowlist could contain is surfaced VERBATIM', () => {
    // `exportable` is a SERVER-side axis (privacy.rs:1496-1498 filters
    // DATA_LIFECYCLE_MANIFEST before a single row is written), so anything that ARRIVES is by
    // construction exportable. A client-side allowlist would be a second SSOT for PRV1-12 —
    // and it fails silently and asymmetrically: the day a new exportable table ships, the
    // client quietly drops it from the player's download and no test notices.
    //
    // The two names are chosen to defeat an allowlist that happens to contain the fixtures:
    // `zzz_not_a_real_table` is in no manifest anywhere, and `guest_claim` IS a real table the
    // server marks exportable:false — so a client that reasons about exportability at all
    // drops one of them.
    const result = assembleExportBundle(
      [
        chunkOf({
          chunkId: 1n,
          tableName: 'zzz_not_a_real_table',
          chunkIndex: 0,
          totalChunks: 2,
          payloadJson: '{"table":"zzz_not_a_real_table","rows":[{"k":"v"}]}',
        }),
        chunkOf({
          chunkId: 2n,
          tableName: 'guest_claim',
          chunkIndex: 1,
          totalChunks: 2,
          payloadJson: '{"table":"guest_claim","rows":[{"code":"abc"}]}',
        }),
      ],
      ME,
    );
    expect(result.status, 'every delivered chunk is part of the bundle').toBe('complete');
    expect(result.artifact).toBe(
      '{"request_id":"7","total_chunks":2,"chunks":[' +
        '{"table":"zzz_not_a_real_table","rows":[{"k":"v"}]},' +
        '{"table":"guest_claim","rows":[{"code":"abc"}]}]}',
    );
  });

  it('★★ S8T-COLUMN-BEATS-PAYLOAD BITES: the tableName COLUMN is the identity — nothing is read out of payloadJson', () => {
    // Anti-pattern #9: deriving anything (the table name, a row count) from INSIDE the
    // payload. The column and the embedded name agree on real data, which is exactly why a
    // fixture has to make them disagree.
    //
    // WRONG IMPLS KILLED:
    //   (a) grouping / de-duplicating chunks by the embedded `"table"` value — the two chunks
    //       below share `"table":"monster"` while carrying DIFFERENT tableName columns, so a
    //       group-by collapses them and the player loses half their data.
    //   (b) rewriting the payload to agree with the column (or vice versa) — the artifact must
    //       be the server's bytes, unmodified.
    const disagreeing = assembleExportBundle(
      [
        chunkOf({
          chunkId: 1n,
          tableName: 'wallet',
          chunkIndex: 0,
          totalChunks: 2,
          payloadJson: '{"table":"monster","rows":[{"a":"1"}]}',
        }),
        chunkOf({
          chunkId: 2n,
          tableName: 'monster',
          chunkIndex: 1,
          totalChunks: 2,
          payloadJson: '{"table":"monster","rows":[{"b":"2"}]}',
        }),
      ],
      ME,
    );
    expect(disagreeing.status).toBe('complete');
    expect(disagreeing.artifact).toBe(
      '{"request_id":"7","total_chunks":2,"chunks":[' +
        '{"table":"monster","rows":[{"a":"1"}]},' +
        '{"table":"monster","rows":[{"b":"2"}]}]}',
    );
    const artifact = String(disagreeing.artifact);
    expect(
      countOccurrences(artifact, '"table":'),
      'exactly the two payloads` own table fields — the envelope adds none of its own',
    ).toBe(2);
    expect(
      artifact.indexOf('wallet'),
      'the tableName COLUMN is not injected into the envelope; the envelope has no table axis',
    ).toBe(-1);
  });

  it('★★ S8T-MALFORMED-PAYLOAD-NO-THROW BITES: a truncated payload is spliced verbatim and never parsed', () => {
    // The behavioural half of the JSON.parse ban (the source scan is the other half). A
    // `JSON.parse` of this payload THROWS — inside a download handler that would leave the
    // player with a dead button and no explanation. The client is a TRANSPORT for the
    // server's bytes; validating them is not its job and re-encoding them is forbidden.
    const truncated = '{"table":"monster","rows":[{';
    let result: ExportAssembly | undefined;
    expect(() => {
      result = assembleExportBundle(
        [chunkOf({ chunkIndex: 0, totalChunks: 1, payloadJson: truncated })],
        ME,
      );
    }, 'assembleExportBundle must never throw on a payload it did not write').not.toThrow();
    expect(result?.status).toBe('complete');
    expect(result?.artifact).toBe(
      '{"request_id":"7","total_chunks":1,"chunks":[{"table":"monster","rows":[{]}',
    );
    expect(
      String(result?.artifact).indexOf(truncated),
      'the malformed bytes must be present VERBATIM',
    ).toBeGreaterThanOrEqual(0);
  });

  it('★★ BITES (property): the assembly is total, and an artifact exists ONLY when the status is `complete`', () => {
    // The invariant that makes every negative tooth above meaningful, quantified: no path may
    // produce a downloadable artifact from a bundle the client has not proved whole.
    // Block-bodied arrow — fast-check reads an expression-bodied matcher's return as a
    // `false` predicate and fails spuriously (repo convention, rowConvert.test.ts:3025).
    const chunkArb = fc.record({
      chunkId: fc.bigInt({ min: 0n, max: 999n }),
      ownerIdentity: fc.constantFrom(ME, FOREIGN, ''),
      requestId: fc.constantFrom(7n, 9n, 10n),
      tableName: fc.constantFrom('player_monster', 'guest_claim', ''),
      chunkIndex: fc.oneof(
        fc.integer({ min: -1, max: 3 }),
        fc.constantFrom(Number.NaN, 1.5, -0.5),
      ),
      totalChunks: fc.constantFrom(1, 2, 3, 0, 2.5, Number.NaN),
      payloadJson: fc.constantFrom(P0, P1, P2, '', '{"broken":'),
      createdAtMs: fc.bigInt({ min: 0n, max: 999n }),
    });
    fc.assert(
      fc.property(
        fc.array(chunkArb, { maxLength: 6 }),
        fc.constantFrom(ME, FOREIGN, ''),
        (chunks, owner) => {
          const result = assembleExportBundle(chunks, owner);
          expect(ALL_STATUSES).toContain(result.status);
          expect(result.artifact !== undefined).toBe(result.status === 'complete');
          expect(Number.isInteger(result.receivedChunks)).toBe(true);
          expect(result.receivedChunks >= 0).toBe(true);
          if (result.status === 'inconsistent') {
            // Quantified: no inconsistent bundle may report a chunk count. Kills a
            // `totalChunks: chunks[0].totalChunks` that leaks `2.5` or `NaN` to the UI.
            expect(result.totalChunks).toBeUndefined();
          }
          if (result.totalChunks !== undefined) {
            expect(Number.isInteger(result.totalChunks)).toBe(true);
            expect(result.totalChunks > 0).toBe(true);
          }
          if (result.artifact !== undefined) {
            expect(result.artifact.indexOf('{"request_id":"')).toBe(0);
            expect(result.artifact.lastIndexOf(']}')).toBe(result.artifact.length - 2);
            expect(result.artifact.indexOf('undefined')).toBe(-1);
            expect(result.artifact.indexOf('[object Object]')).toBe(-1);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ===========================================================================
// SOURCE SCANS — the JSON.parse ban (gate X5) and purity (gate X8).
//
// WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST FOR THE PARSE BAN: a
// `JSON.parse` + `JSON.stringify` round trip of real server output is
// BYTE-IDENTICAL — measured — so no equality assertion over well-formed data can
// see it. What it changes is the FAILURE mode: a throw on the one payload that
// matters, and a silent re-encoding of any number the server deliberately quoted.
//
// NAMED RESIDUAL: a substring scan cannot see `globalThis['JSON']['parse']`. What
// it guarantees is that the shipped source does not NAME the call.
// ===========================================================================

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_ASSEMBLY_TS_PATH = path.join(UI_DIR, 'exportAssembly.ts');

function readSourceOrThrow(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    // Fail loud — a missing file must never make a scan vacuously pass.
    throw new Error(`could not read ${filePath} — ${String(err)}`);
  }
}

/** Copied in behaviour from claimModel.test.ts:940-961 so the source scans cannot drift. */
function stripComments(src: string): string {
  let withoutBlocks = '';
  let i = 0;
  for (;;) {
    const start = src.indexOf('/*', i);
    if (start === -1) {
      withoutBlocks += src.slice(i);
      break;
    }
    withoutBlocks += src.slice(i, start);
    const end = src.indexOf('*/', start + 2);
    if (end === -1) break;
    i = end + 2;
  }
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const j = line.indexOf('//');
      return j === -1 ? line : line.slice(0, j);
    })
    .join('\n');
}

/** Every module specifier the stripped source imports from. Line-oriented so a quoted string
 *  in ordinary code cannot be mistaken for an import (a line whose `=` precedes the quote is
 *  an assignment, not an import). */
function importSpecifiers(src: string): readonly string[] {
  const out: string[] = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    const isImportHead = line.indexOf('import ') === 0;
    const hasFrom = line.indexOf('from ') === 0 || line.indexOf(' from ') !== -1;
    if (!isImportHead && !hasFrom) continue;
    const q = line.indexOf("'");
    if (q === -1) continue;
    const eq = line.indexOf('=');
    if (eq !== -1 && eq < q) continue;
    const end = line.indexOf("'", q + 1);
    if (end === -1) continue;
    out.push(line.slice(q + 1, end));
  }
  return out;
}

const IMPURE_TOKENS: readonly string[] = [
  'Date',
  'performance',
  'globalThis',
  'document',
  'window',
  'await import(',
  'console',
];

const FORBIDDEN_SPECIFIER_PARTS: readonly string[] = [
  'store',
  'module_bindings',
  'spacetimedb',
  'node:',
  'connection',
  'View',
  'main',
];

describe('X5 / X8 source scans: exportAssembly.ts parses nothing and imports nothing', () => {
  it('★ CALIBRATION: the stripper and the import scanner both BITE on a planted fixture', () => {
    // Without this, a stripper that ate the whole file (or a scanner that found no imports in
    // anything) would make every zero below vacuously true. The planted specifiers are
    // DELIBERATELY not real repo paths, so this fixture cannot make the test file look like an
    // importer of the store or the bindings to a repo-wide text scan.
    const fixture = [
      "import { Probe } from './x-store-probe';",
      'import {',
      '  Probe2,',
      "} from './x-module_bindings-probe';",
      'const live = 1;',
      '// const parsed = JSON.parse(payload);',
      '/* JSON.parse(other) */ const also = 2;',
      "const message = 'a value from the server';",
    ].join('\n');
    const stripped = stripComments(fixture);
    expect(countOccurrences(stripped, 'JSON.parse')).toBe(0);
    expect(countOccurrences(stripped, 'const live = 1;')).toBe(1);
    expect(countOccurrences(stripped, 'const also = 2;')).toBe(1);
    const found = importSpecifiers(stripped);
    expect([...found]).toEqual(['./x-store-probe', './x-module_bindings-probe']);
    expect(found).not.toContain('a value from the server');
    for (const specifier of found) {
      const banned = FORBIDDEN_SPECIFIER_PARTS.filter((part) => specifier.indexOf(part) !== -1);
      expect(banned.length, `${specifier} must be rejected by the ban list`).toBeGreaterThan(0);
    }
  });

  it('★★ S8T-NO-JSON-PARSE-SOURCE BITES: exportAssembly.ts contains ZERO occurrences of JSON.parse', () => {
    const src = readSourceOrThrow(EXPORT_ASSEMBLY_TS_PATH);
    // ANTI-VACUITY FIRST: a missing, empty or stub file satisfies every zero below.
    expect(src.length, 'the scanned source must be non-empty').toBeGreaterThan(0);
    const stripped = stripComments(src);
    expect(
      countOccurrences(stripped, 'assembleExportBundle'),
      'the scanned source must define the assembler',
    ).toBeGreaterThanOrEqual(1);
    expect(
      countOccurrences(stripped, 'payloadJson'),
      'and must actually handle the payload column',
    ).toBeGreaterThanOrEqual(1);
    expect(countOccurrences(src, ':' + '//'), 'no URL literal to hide behind the // stripper').toBe(
      0,
    );

    expect(
      countOccurrences(stripped, 'JSON.parse'),
      'the payload is the SERVER`s bytes: spliced, never parsed and re-encoded ' +
        '(privacy.rs:113-127 quotes every 64-bit integer precisely so the client never has to)',
    ).toBe(0);
  });

  it('★★ S8T-PURE-EXPORT BITES: exportAssembly.ts names no clock, no DOM, no console — and imports no store, SDK or binding', () => {
    const src = readSourceOrThrow(EXPORT_ASSEMBLY_TS_PATH);
    expect(src.length, 'the scanned source must be non-empty').toBeGreaterThan(0);
    const stripped = stripComments(src);
    expect(
      countOccurrences(stripped, 'export'),
      'the scanned source must export the frozen seam',
    ).toBeGreaterThanOrEqual(3);
    expect(countOccurrences(stripped, 'assembleExportBundle')).toBeGreaterThanOrEqual(1);

    for (const token of IMPURE_TOKENS) {
      expect(
        countOccurrences(stripped, token),
        `exportAssembly.ts must never name "${token}" — the assembly core takes DATA and ` +
          'returns a STRING; the Blob / URL.createObjectURL download belongs to s8b`s view',
      ).toBe(0);
    }
    for (const specifier of importSpecifiers(stripped)) {
      expect(specifier.indexOf('./'), `import ${specifier} must be a relative sibling`).toBe(0);
      for (const part of FORBIDDEN_SPECIFIER_PARTS) {
        expect(
          specifier.indexOf(part),
          `exportAssembly.ts must not import ${specifier} — the pure core takes DATA, not wiring`,
        ).toBe(-1);
      }
    }
  });
});
