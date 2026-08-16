// bsatn-compat-smoke.eval.mjs — M14.5f-1: BSATN schema-compatibility smoke (ADR-0006/0093/0095).
//
// The M14b/M14d "old rows deserialize as None" claim rests on #[serde(default)] +
// serde/RON round-trip tests. But battle.state persists via SpacetimeType/BSATN
// derive — a different codec (position-based, all fields required in order; no
// missing-field defaults). This eval documents that finding and verifies the
// serde-side annotations are present.
//
// CORRECTED 11r-i (ADR-0173 D5). This header previously asserted, untested, that
// the engine transparently handles additive schema on a publish without
// --delete-data. That claim is FALSE. Measured against live spacetime 2.6.0 by
// republishing an existing database without --delete-data:
//   - a field added to a NESTED SpacetimeType struct (BattleState; likewise
//     EncounterEntryRow inside a Vec column) is REJECTED — "requires a manual
//     migration". Option<T> + #[serde(default)] does not help: the engine
//     compares the whole nested product type.
//   - a top-level column inserted mid-struct is REJECTED twice over — as a
//     reordering, and for want of a default value annotation.
//   - the ONLY accepted additive shape is a column appended at the END of the
//     table struct carrying an explicit #[default(...)] annotation. That
//     publishes cleanly and pre-existing rows survive.
// So ADR-0006's additive promise is narrower than it read: append-at-end +
// explicit default. The serde(default) annotations below remain correct and
// necessary for the serde/RON path (content, fixtures, save data) — they simply
// buy nothing at the engine boundary.
//
// A nested-type widening is caught in CI by evals/spacetime-type-snapshot.eval.mjs
// (via evals/baselines/spacetime-types.json, which pins BattleState's field
// list) — at authorship time, not 24h later in nightly.
//
// PASS conditions:
//   1. #[serde(default)] on BattleMonster.status (co-located: immediately before field)
//   2. #[serde(default)] on BattleState.weather (co-located: immediately before field)
//   3. SpacetimeType derive on BattleMonster (in the attr block above pub struct)
//   4. SpacetimeType derive on BattleState (in the attr block above pub struct)
//   5. RON/serde default tests for `status` exist in m14b_tests.rs
//      (two specific fn names — module-qualified needles, per m14.5e lesson)
//   6. The BSATN-vs-serde codec finding is machine-visible in eval name+detail
//  11. (EG1-11, ADR-0174 D1) Migration A's 16 Monster + 12 MonsterPub + 1
//      SpeciesRow columns each sit AFTER that struct's last pre-migration column
//      (Monster: last_care_at_ms; MonsterPub: party_slot; SpeciesRow: ability —
//      the Monster/MonsterPub anchors moved when Migration B, EG5-6/ADR-0177 D2,
//      removed the old `evolves_to` anchor), in the ADR's declared order, each
//      carrying an explicit #[default(...)]
//  12. (EG1-11) the nested row struct EssenceRequirementRow exists and derives
//      SpacetimeType (a table/shape snapshot does not cover nested types)
//
// NOTE (weather nuance): there is NO dedicated RON-omits-`weather` test in
// m14b_tests.rs (none was written for the weather field). The weather-side proof
// is criteria 2 + 4 only. Do NOT assert a weather RON test exists.
//
// IMPORTANT: No new RegExp() — detect-non-literal-regexp Semgrep rule bites.
// Only String.prototype.includes() / indexOf() and regex LITERALS used here.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Criterion 1+2: #[serde(default)] co-located with the target field.
//
// Co-location: the attribute must appear IMMEDIATELY before `pub <fieldName>:`
// within the struct body — not merely anywhere in the file and not before a
// different field. We search for the exact two-line pattern:
//   #[serde(default)]\n    pub <fieldName>:
// within the struct body (opening `{` to first closing `\n}`).
//
// This rejects the case where #[serde(default)] is on a different field:
//   e.g. `#[serde(default)]\n    pub species_id: u32,\n    pub status: ...`
//   does NOT contain `#[serde(default)]\n    pub status:`.
// ---------------------------------------------------------------------------
export function hasSerdeDefaultOnField(rustSrc, structName, fieldName) {
  const structMarker = `pub struct ${structName}`;
  const structIdx = rustSrc.indexOf(structMarker);
  if (structIdx === -1) return false;

  const braceIdx = rustSrc.indexOf('{', structIdx);
  if (braceIdx === -1) return false;

  // First `\n}` after the opening brace closes the struct body.
  // Safe for flat structs: field types use angle brackets (<>), not braces.
  const closeIdx = rustSrc.indexOf('\n}', braceIdx);
  if (closeIdx === -1) return false;

  const body = rustSrc.slice(braceIdx, closeIdx + 2);

  // Co-located pattern: attribute on one line, field declaration on the next.
  const pattern = `#[serde(default)]\n    pub ${fieldName}:`;
  return body.includes(pattern);
}

// ---------------------------------------------------------------------------
// Criterion 3+4: SpacetimeType derive in the attribute block above the struct.
//
// The derive is:
//   #[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
// We isolate the attribute block by finding the last blank line (\n\n) or
// block-end (\n}\n) before `pub struct <structName>`, then checking for
// 'SpacetimeType' in that window.
//
// This correctly isolates each struct's own attribute block even when adjacent
// structs also have SpacetimeType derives.
// ---------------------------------------------------------------------------
export function hasSpacetimeTypeDerive(rustSrc, structName) {
  const structMarker = `pub struct ${structName}`;
  const structIdx = rustSrc.indexOf(structMarker);
  if (structIdx === -1) return false;

  const before = rustSrc.slice(0, structIdx);

  // Find the last blank line or block-end immediately before this struct's attrs.
  const lastBlank = before.lastIndexOf('\n\n');
  const lastBlockEnd = before.lastIndexOf('\n}\n');
  const boundary = Math.max(lastBlank, lastBlockEnd);

  const attrBlock = boundary !== -1 ? before.slice(boundary) : before;
  return attrBlock.includes('SpacetimeType');
}

// ---------------------------------------------------------------------------
// Criterion 5: Two specific serde-default test fn names must exist in m14b_tests.rs.
//
// NOTE: there is NO dedicated RON-omits-weather test; only status tests exist.
// The two required fn names are the exact module-qualified needles (m14.5e lesson:
// use specific fn-name needles, not loose substrings).
// ---------------------------------------------------------------------------
export function hasRonDefaultTests(testSrc) {
  return (
    testSrc.includes('m14b_serde_default_allows_missing_status_field') &&
    testSrc.includes('m14b_battle_monster_status_field_defaults_to_none')
  );
}

// ---------------------------------------------------------------------------
// Criterion 6: The BSATN-vs-serde codec finding must be machine-visible in the
// eval's name+detail (deliverable 14.5f-1 point 4). We require 'BSATN',
// 'serde', and 'engine' in the combined name+detail string.
// ---------------------------------------------------------------------------
export function documentsBsatnGap(nameStr, detailStr) {
  const combined = `${nameStr} ${detailStr}`;
  return combined.includes('BSATN') && combined.includes('serde') && combined.includes('engine');
}

// ---------------------------------------------------------------------------
// T6-lite (11r-i): correct the false, unqualified claim this eval's own
// header/detail previously made about the engine handling additive schema
// changes unconditionally on republish without --delete-data. That claim is
// FALSE, verified empirically against live spacetime 2.6.0 (see the
// ADR/handoff notes for the republish matrix). The VERIFIED rule is
// narrower: a nested-struct field widening (e.g. inside BattleState or a
// Vec<...> row) is REJECTED ("requires a manual migration"); only a
// top-level column APPENDED AT THE END with an explicit `#[default(...)]`
// annotation is ACCEPTED.
//
// Criterion 6 (documentsBsatnGap, above) stays UNCHANGED — it only asserts
// the BSATN-vs-serde codec distinction is machine-visible, which remains
// true. These are NEW, ADDITIONAL criteria; they do not weaken 1-7.
// ---------------------------------------------------------------------------

// Criterion 8 (T6-a): the eval's own passing `detail` must make the VERIFIED
// additive-schema rules machine-visible — mirrors documentsBsatnGap's style.
// Requires BOTH:
//   * the nested-struct-widening-requires-manual-migration finding, and
//   * the supported shape (append-at-end + explicit default annotation).
export function documentsVerifiedAdditiveSchemaRules(nameStr, detailStr) {
  const combined = `${nameStr} ${detailStr}`;
  const nestedRequiresManualMigration =
    combined.includes('nested') && combined.includes('manual migration');
  const appendAtEndWithDefaultAnnotation =
    combined.includes('append') && combined.includes('#[default(');
  return nestedRequiresManualMigration && appendAtEndWithDefaultAnnotation;
}

// Criterion 9 (T6-b): the eval's own HEADER (the comment block above the
// first `import`) must no longer contain the false, unqualified claim that
// the engine handles additive schema without qualification.
//
// The banned phrase is assembled from two parts via `.join('')` — NOT
// written contiguously anywhere in this file's source text — so this
// checker's own presence in the file can never satisfy its own negative
// assertion (the self-scan target IS this file).
function bannedUnqualifiedEngineClaim() {
  const partA = 'SpacetimeDB handles additive schema';
  const partB = ' at the ENGINE level';
  return [partA, partB].join('');
}

function headerRegion(rawSrc) {
  const importIdx = rawSrc.indexOf('import {');
  return importIdx === -1 ? rawSrc : rawSrc.slice(0, importIdx);
}

export function headerHasUnqualifiedEngineAdditiveClaim(rawSrc) {
  const header = headerRegion(rawSrc);
  return header.indexOf(bannedUnqualifiedEngineClaim()) !== -1;
}

// Criterion 10 (T6-c): the eval must name `spacetime-type-snapshot` — the
// gate (evals/spacetime-type-snapshot.eval.mjs) that actually pins
// BattleState's field list and so catches a nested-type widening in CI —
// routing a reader from this smoke-eval's narrower finding to the mechanism
// that enforces it.
export function namesEnforcingSnapshotGate(nameStr, detailStr) {
  const combined = `${nameStr} ${detailStr}`;
  return combined.includes('spacetime-type-snapshot');
}

// ---------------------------------------------------------------------------
// 16.5e-3 (ADR-0116 D4): additive-content coupling.
// Every Option<...> column on a content-synced table must have its
// field-assignment inside a StructName-row-literal block in content.rs —
// otherwise a future re-seed (e.g. a spread refactor of the row literal)
// silently drops the column. No new RegExp — literal regexes + indexOf only.
// ---------------------------------------------------------------------------

// Comments first, then strings (order documented in ADR-0116; a block-comment
// terminator inside a normal string is an accepted residual). The string
// escape-branch matches backslash + any char INCLUDING newline: content.rs has
// a backslash-newline line-continuation string that inverts quote pairing
// under the newline-excluding form.
function stripRustCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""');
}

function isWordChar(ch) {
  return (
    (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_'
  );
}

/**
 * Parse schema.rs table structs: for each #[spacetimedb::table(accessor = X ...)]
 * attribute, capture the following struct and its Option<...> fields.
 * Returns { [structName]: { tableName, optionFields: string[] } }.
 */
export function parseContentTableStructs(schemaSrc) {
  const src = stripRustCommentsAndStrings(schemaSrc);
  const out = {};
  const tableAttrRe = /#\[spacetimedb::table\(\s*accessor\s*=\s*(\w+)/g;
  const attrMatches = Array.from(src.matchAll(tableAttrRe));
  for (let a = 0; a < attrMatches.length; a++) {
    const m = attrMatches[a];
    const tableName = m[1];
    // Bound the struct search at the NEXT table attribute: an attr whose
    // struct is missing/misplaced must not claim a later table's struct.
    const bound = a + 1 < attrMatches.length ? attrMatches[a + 1].index : src.length;
    const structIdx = src.indexOf('pub struct ', m.index);
    if (structIdx === -1 || structIdx >= bound) continue;
    const nameStart = structIdx + 'pub struct '.length;
    let nameEnd = nameStart;
    while (nameEnd < src.length && isWordChar(src[nameEnd])) nameEnd++;
    const structName = src.slice(nameStart, nameEnd);
    const braceIdx = src.indexOf('{', structIdx);
    if (braceIdx === -1) continue;
    let depth = 1;
    let i = braceIdx + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const body = src.slice(braceIdx + 1, i - 1);
    const optionFields = [];
    const fieldRe = /pub\s+(\w+)\s*:\s*Option\s*</g;
    for (const fm of body.matchAll(fieldRe)) optionFields.push(fm[1]);
    out[structName] = { tableName, optionFields };
  }
  return out;
}

function scanDbWrites(contentSrc) {
  const src = stripRustCommentsAndStrings(contentSrc);
  // One literal regex for DB write call sites: ctx.db.<table>() followed by a
  // chain of zero-arg accessors (index accessors like .item_id()) and then
  // .insert( / .update( / .delete(. Multi-line chains tolerated via \s*.
  // Zero-arg chain elements (not a bounded [\s\S] lookahead) so a match can
  // never leak across statement boundaries into a DIFFERENT table's write.
  // Function-local so no lastIndex state can ever be shared across calls.
  const dbWriteRe =
    /ctx\s*\.\s*db\s*\.\s*(\w+)\s*\(\s*\)(?:\s*\.\s*\w+\s*\(\s*\))*\s*\.\s*(insert|update|delete)\s*\(/g;
  const writes = [];
  for (const m of src.matchAll(dbWriteRe)) {
    writes.push({ table: m[1], op: m[2] });
  }
  return writes;
}

/**
 * Table names written to anywhere in content.rs (whole-file scope, D4 —
 * captures helper fns like seed_heal_locations_from outside sync_content_inner).
 * Returns Set<string>.
 */
export function parseSyncedTables(contentSrc) {
  const synced = new Set();
  for (const w of scanDbWrites(contentSrc)) synced.add(w.table);
  return synced;
}

// Row-literal blocks: every word-boundary occurrence of `StructName {` in the
// stripped source, brace-walked to its matching close.
function collectRowLiteralBlocks(strippedSrc, structName) {
  const blocks = [];
  let pos = 0;
  while (true) {
    const idx = strippedSrc.indexOf(structName, pos);
    if (idx === -1) break;
    pos = idx + structName.length;
    if (idx > 0 && isWordChar(strippedSrc[idx - 1])) continue;
    let j = pos;
    while (j < strippedSrc.length && ' \t\r\n'.indexOf(strippedSrc[j]) !== -1) j++;
    if (strippedSrc[j] !== '{') continue;
    let depth = 1;
    let k = j + 1;
    while (k < strippedSrc.length && depth > 0) {
      if (strippedSrc[k] === '{') depth++;
      else if (strippedSrc[k] === '}') depth--;
      k++;
    }
    blocks.push(strippedSrc.slice(j + 1, k - 1));
    pos = k;
  }
  return blocks;
}

// Word-boundary field-assignment check (C-W): `<field>:` where the preceding
// char is NOT [A-Za-z0-9_] — so `stability:` never satisfies `ability`.
// indexOf + manual preceding-char check; no dynamic RegExp.
function hasFieldAssignment(blockText, fieldName) {
  const needle = fieldName + ':';
  let pos = 0;
  while (true) {
    const idx = blockText.indexOf(needle, pos);
    if (idx === -1) return false;
    pos = idx + needle.length;
    if (idx > 0 && isWordChar(blockText[idx - 1])) continue;
    return true;
  }
}

/**
 * The 16.5e-3 gate (ADR-0116 D4). [] = clean; one string per violation.
 * Vacuity guard: zero Option fields discovered across ALL table structs is
 * itself a violation (parser rot — m16.5a lesson).
 * Exemption: a synced table with NO row literal in content.rs AND NO insert
 * call site is an in-place mutation of existing rows (the monster/monster_pub
 * recompute_monster_derived_fields shape) — updates preserve columns they do
 * not touch, and nothing is re-seeded from content, so no coupling is owed.
 * Insert-written tables stay held to the rule even without a local literal
 * (the encounter shape: its literal lives in marshal.rs — a future Option
 * column there must surface in content.rs to pass).
 */
export function checkAdditiveColumnCoupling(schemaSrc, contentSrc) {
  const structs = parseContentTableStructs(schemaSrc);
  const writes = scanDbWrites(contentSrc);
  const synced = new Set();
  const inserted = new Set();
  for (const w of writes) {
    synced.add(w.table);
    if (w.op === 'insert') inserted.add(w.table);
  }

  let totalOptionFields = 0;
  for (const entry of Object.values(structs)) {
    totalOptionFields += entry.optionFields.length;
  }
  if (totalOptionFields === 0) {
    return [
      'vacuity guard (16.5e-3, ADR-0116): zero Option<...> fields discovered across all table structs — parser rot',
    ];
  }

  const strippedContent = stripRustCommentsAndStrings(contentSrc);
  const violations = [];
  for (const [structName, entry] of Object.entries(structs)) {
    const { tableName, optionFields } = entry;
    if (optionFields.length === 0) continue;
    if (!synced.has(tableName)) continue; // not a content-synced table
    const blocks = collectRowLiteralBlocks(strippedContent, structName);
    if (blocks.length === 0) {
      if (!inserted.has(tableName)) continue; // in-place mutation shape — exempt
      for (const f of optionFields) {
        violations.push(
          "table '" +
            tableName +
            "' (struct " +
            structName +
            "): Option field '" +
            f +
            "' — insert-written by content.rs but no '" +
            structName +
            " {' row literal found in content.rs to carry the assignment (16.5e-3, ADR-0116 D4)",
        );
      }
      continue;
    }
    const combined = blocks.join('\n');
    for (const f of optionFields) {
      if (!hasFieldAssignment(combined, f)) {
        violations.push(
          "table '" +
            tableName +
            "' (struct " +
            structName +
            "): Option field '" +
            f +
            "' has no '" +
            f +
            ":' assignment in any '" +
            structName +
            " {' row literal in content.rs — the re-seed path would drop it (16.5e-3, ADR-0116 D4)",
        );
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// EG1-11 (ADR-0174 D1): Migration A's appended columns.
//
// The verified additive rule (ADR-0173 D5, measured on live spacetime 2.6.0) is
// narrow: a column must be APPENDED AT THE END of the table struct and carry an
// explicit `#[default(...)]`. A mid-struct insert is rejected twice over (as a
// reordering AND for want of a default). This section pins Migration A's exact
// column lists against that rule so the migration cannot be authored in a shape
// the engine will reject at publish time.
//
// Only String.indexOf / literal regexes — no new RegExp (Semgrep
// detect-non-literal-regexp).
// ---------------------------------------------------------------------------

// Monster +16, in ADR-0174 D1 declaration order — appended after `evolves_to` at
// EG1; the live anchor is `last_care_at_ms` since Migration B removed it (EG5-6).
export const EG1_MONSTER_APPENDED_COLUMNS = [
  'essence_fire',
  'essence_water',
  'essence_plant',
  'essence_electric',
  'essence_earth',
  'essence_wind',
  'essence_light',
  'essence_dark',
  'trust_favorable_count',
  'trust_unfavorable_count',
  'trust_favorable_battle_day_epoch',
  'quality_time_ticks_total',
  'quality_time_accum_ms',
  'quality_time_window_ms',
  'quality_time_window_start_ms',
  'last_essence_train_at_ms',
];

// MonsterPub +12, in ADR-0174 D1 declaration order — appended after `evolves_to` at
// EG1; the live anchor is `party_slot` since Migration B removed it (EG5-6).
export const EG1_MONSTER_PUB_APPENDED_COLUMNS = [
  'tier',
  'essence_fire',
  'essence_water',
  'essence_plant',
  'essence_electric',
  'essence_earth',
  'essence_wind',
  'essence_light',
  'essence_dark',
  'trust_tier',
  'quality_time_tier',
  'nutrition_pct',
];

// SpeciesRow +1, appended after `ability`.
export const EG1_SPECIES_ROW_APPENDED_COLUMNS = ['tier'];

/**
 * Locate `pub struct <structName> {` (word-boundary on the name) and return its
 * body text, or null. Brace-walked, so a nested block cannot end it early.
 * @param {string} src Comment/string-stripped Rust source.
 * @param {string} structName
 * @returns {string|null}
 */
function findStructBody(src, structName) {
  const marker = `pub struct ${structName}`;
  let pos = 0;
  for (;;) {
    const idx = src.indexOf(marker, pos);
    if (idx === -1) return null;
    pos = idx + marker.length;
    // Word boundary: `pub struct Monster` must not match `pub struct MonsterPub`.
    if (isWordChar(src[pos])) continue;
    const braceIdx = src.indexOf('{', idx);
    if (braceIdx === -1) return null;
    let depth = 1;
    let i = braceIdx + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    return src.slice(braceIdx + 1, i - 1);
  }
}

/**
 * Ordered field list of a struct, each with the attribute lines that immediately
 * precede it.
 *
 * Struct-keyed and retained deliberately: ADR-0193 (13r-d) generalized the
 * append-at-end + `#[default(` SHAPE rule to every table in
 * `evals/battle-schema-snapshot.eval.mjs` (`parseTableColumnOrder`,
 * `checkColumnOrder`, `checkDefaultsSuffix`, `checkBaselineAppendOnly`), keyed on
 * the `#[spacetimedb::table(accessor = ...)]` attribute and stripping comments only.
 * This helper keys on the STRUCT name over comment- AND string-stripped source,
 * which is the substrate the EG1 pin below needs; the two are not interchangeable.
 *
 * @param {string} rustSrc Raw Rust source.
 * @param {string} structName
 * @returns {{ name: string, attrs: string[] }[] | null}
 */
export function parseStructFieldOrder(rustSrc, structName) {
  const src = stripRustCommentsAndStrings(rustSrc);
  const body = findStructBody(src, structName);
  if (body === null) return null;
  const fields = [];
  let pending = [];
  const fieldRe = /^pub\s+(\w+)\s*:/;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.indexOf('#[') === 0) {
      pending.push(line);
      continue;
    }
    const m = fieldRe.exec(line);
    if (m) {
      fields.push({ name: m[1], attrs: pending });
      pending = [];
    } else {
      pending = [];
    }
  }
  return fields;
}

/**
 * EG1-11 gate: every column in `requiredCols` must
 *   (a) exist on `structName`,
 *   (b) sit STRICTLY AFTER `anchorField` (the struct's last pre-migration
 *       column) — i.e. be appended, never inserted mid-struct,
 *   (c) carry an explicit `#[default(` annotation, and
 *   (d) appear in the same relative order as `requiredCols` (ADR-0174 D1 fixes
 *       the append order).
 * Returns [] when clean; one string per violation.
 *
 * @param {string} rustSrc Raw schema.rs source.
 * @param {string} structName
 * @param {string} anchorField Last column that existed BEFORE the migration.
 * @param {string[]} requiredCols Appended columns, in their required order.
 * @returns {string[]}
 */
export function checkAppendedColumns(rustSrc, structName, anchorField, requiredCols) {
  const fields = parseStructFieldOrder(rustSrc, structName);
  if (fields === null) {
    return [`struct '${structName}' not found in schema source`];
  }
  const names = fields.map((f) => f.name);
  const anchorIdx = names.indexOf(anchorField);
  if (anchorIdx === -1) {
    return [
      `struct '${structName}': anchor column '${anchorField}' (the last pre-migration column) not found — parser rot or an unexpected schema rewrite`,
    ];
  }

  const violations = [];
  const foundIdx = [];
  for (const col of requiredCols) {
    const idx = names.indexOf(col);
    if (idx === -1) {
      violations.push(`struct '${structName}': appended column '${col}' is MISSING`);
      continue;
    }
    foundIdx.push({ col, idx });
    if (idx <= anchorIdx) {
      violations.push(
        `struct '${structName}': column '${col}' is at position ${idx}, at or BEFORE the pre-migration anchor '${anchorField}' (position ${anchorIdx}) — a mid-struct insert is REJECTED by live spacetime 2.6.0 automigration (as a reordering AND for want of a default)`,
      );
    }
    const attrs = fields[idx].attrs.join(' ');
    if (attrs.indexOf('#[default(') === -1) {
      violations.push(
        `struct '${structName}': column '${col}' has no explicit #[default(...)] annotation — the only accepted additive shape is append-at-end WITH a default`,
      );
    }
  }

  for (let i = 1; i < foundIdx.length; i++) {
    if (foundIdx[i].idx <= foundIdx[i - 1].idx) {
      violations.push(
        `struct '${structName}': column '${foundIdx[i].col}' must be declared AFTER '${foundIdx[i - 1].col}' (ADR-0174 D1 fixes the append order)`,
      );
    }
  }

  return violations;
}

/**
 * Does the attribute block immediately above `pub struct <structName>` contain
 * `deriveName`? Comment-stripped first, so a doc comment mentioning the derive
 * cannot produce a false pass. The window starts at the last `}` before the
 * struct (the end of the preceding item), so a neighbouring struct's derives
 * cannot leak in.
 *
 * @param {string} rustSrc Raw Rust source.
 * @param {string} structName
 * @param {string} deriveName
 * @returns {boolean}
 */
export function hasDeriveOnStruct(rustSrc, structName, deriveName) {
  const src = stripRustCommentsAndStrings(rustSrc);
  const marker = `pub struct ${structName}`;
  let structIdx = -1;
  let pos = 0;
  for (;;) {
    const idx = src.indexOf(marker, pos);
    if (idx === -1) break;
    pos = idx + marker.length;
    if (isWordChar(src[pos])) continue;
    structIdx = idx;
    break;
  }
  if (structIdx === -1) return false;
  const before = src.slice(0, structIdx);
  const boundary = before.lastIndexOf('}');
  const attrBlock = boundary === -1 ? before : before.slice(boundary + 1);
  return attrBlock.indexOf(deriveName) !== -1;
}

export default async function () {
  const name =
    'bsatn-compat-smoke (14.5f-1: serde(default)+SpacetimeType on battle.state fields; ' +
    'BSATN is a different codec — SpacetimeDB engine handles additive columns; ' +
    'EG1-11: Migration A appended-column + EssenceRequirementRow checks)';

  // -------------------------------------------------------------------------
  // PROOF-OF-TEETH: each predicate must reject its known-bad fixture BEFORE
  // real-file checks. If any tooth fails to bite, return RED immediately.
  // -------------------------------------------------------------------------

  // Tooth A: hasSerdeDefaultOnField rejects a struct missing #[serde(default)]
  const badNoDefault =
    'pub struct BattleMonster {\n    pub species_id: u32,\n    pub status: Option<StatusEffect>,\n}\n';
  if (hasSerdeDefaultOnField(badNoDefault, 'BattleMonster', 'status')) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth A: hasSerdeDefaultOnField failed to reject BattleMonster where ' +
        'status has NO #[serde(default)] — a loose whole-file search would wrongly pass here',
    };
  }

  // Tooth A': accepts the good fixture (attribute immediately above the field)
  const goodWithDefault =
    'pub struct BattleMonster {\n    pub species_id: u32,\n' +
    '    #[serde(default)]\n    pub status: Option<StatusEffect>,\n}\n';
  if (!hasSerdeDefaultOnField(goodWithDefault, 'BattleMonster', 'status')) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth A': hasSerdeDefaultOnField failed to accept BattleMonster where " +
        '#[serde(default)] is co-located immediately above the status field',
    };
  }

  // Tooth A'': attribute on a DIFFERENT field must NOT satisfy the status requirement
  // (co-location rigor: the attribute on species_id is NOT co-located with status)
  const badAttrOnOtherField =
    'pub struct BattleMonster {\n    #[serde(default)]\n    pub species_id: u32,\n' +
    '    pub status: Option<StatusEffect>,\n}\n';
  if (hasSerdeDefaultOnField(badAttrOnOtherField, 'BattleMonster', 'status')) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth A'': hasSerdeDefaultOnField accepted a struct where #[serde(default)] " +
        'is on species_id (not status) — co-location check must require the attribute ' +
        'immediately before the TARGET field, not merely anywhere in the struct',
    };
  }

  // Tooth B: hasSpacetimeTypeDerive rejects a struct with only serde derives
  const badNoSpacetimeType =
    '#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]\n' +
    'pub struct BattleMonster {\n    pub species_id: u32,\n}\n';
  if (hasSpacetimeTypeDerive(badNoSpacetimeType, 'BattleMonster')) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth B: hasSpacetimeTypeDerive failed to reject a struct with only ' +
        'serde derives (no SpacetimeType) — must check for SpacetimeType specifically',
    };
  }

  // Tooth B': accepts the good fixture (SpacetimeType cfg_attr present)
  const goodWithSpacetimeType =
    '#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]\n' +
    'pub struct BattleMonster {\n    pub species_id: u32,\n}\n';
  if (!hasSpacetimeTypeDerive(goodWithSpacetimeType, 'BattleMonster')) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth B': hasSpacetimeTypeDerive failed to accept a struct with the " +
        'correct SpacetimeType cfg_attr derive',
    };
  }

  // Tooth C: hasRonDefaultTests rejects source missing one of the two required fn names
  const badMissingOneFn = 'fn m14b_serde_default_allows_missing_status_field() {}\n';
  if (hasRonDefaultTests(badMissingOneFn)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth C: hasRonDefaultTests failed to reject a test source missing ' +
        'm14b_battle_monster_status_field_defaults_to_none — requires BOTH fn names',
    };
  }

  // Tooth C': accepts source with both required fn names
  const goodBothFns =
    'fn m14b_serde_default_allows_missing_status_field() {}\n' +
    'fn m14b_battle_monster_status_field_defaults_to_none() {}\n';
  if (!hasRonDefaultTests(goodBothFns)) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth C': hasRonDefaultTests failed to accept test source with both required fn names",
    };
  }

  // Tooth D: documentsBsatnGap rejects name+detail missing the codec-gap finding terms
  const badNoFinding = { name: 'just a name', detail: 'serde is nice' };
  if (documentsBsatnGap(badNoFinding.name, badNoFinding.detail)) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth D: documentsBsatnGap failed to reject name+detail missing 'BSATN' " +
        "and 'engine' — the codec-gap finding must be machine-visible in eval output",
    };
  }

  // Tooth D': accepts the real passing detail (which contains BSATN + serde + engine)
  const goodFindingDetail =
    'serde/RON tests prove serde-codec compat; BSATN is a different codec; ' +
    'SpacetimeDB engine migration handles additive columns at the engine level';
  if (!documentsBsatnGap(name, goodFindingDetail)) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth D': documentsBsatnGap failed to accept real name+detail containing " +
        "'BSATN', 'serde', and 'engine'",
    };
  }

  // =========================================================================
  // T6-lite proof-of-teeth: documentsVerifiedAdditiveSchemaRules,
  // headerHasUnqualifiedEngineAdditiveClaim, namesEnforcingSnapshotGate.
  // =========================================================================

  // Tooth E (T6-a): documentsVerifiedAdditiveSchemaRules rejects a detail that
  // only has the nested/manual-migration half of the finding.
  const badOnlyNestedHalf =
    'a nested struct field widening requires a manual migration in spacetime 2.6.0';
  if (documentsVerifiedAdditiveSchemaRules('name', badOnlyNestedHalf)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth E: documentsVerifiedAdditiveSchemaRules failed to reject a detail ' +
        'missing the append-at-end + #[default(...)] half of the finding',
    };
  }

  // Tooth E-bis: rejects a detail that only has the append/default half.
  const badOnlyAppendHalf =
    'a column appended at the end with an explicit #[default(0)] annotation is accepted';
  if (documentsVerifiedAdditiveSchemaRules('name', badOnlyAppendHalf)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth E-bis: documentsVerifiedAdditiveSchemaRules failed to reject a detail ' +
        'missing the nested-struct + manual-migration half of the finding',
    };
  }

  // Tooth E': accepts a detail containing BOTH halves.
  const goodVerifiedRulesDetail =
    'verified against live spacetime 2.6.0: a nested struct field widening (e.g. inside ' +
    'BattleState) requires a manual migration and is REJECTED on republish; the only ' +
    'accepted additive shape is a top-level column appended at the end with an explicit ' +
    '#[default(0)] annotation.';
  if (!documentsVerifiedAdditiveSchemaRules('name', goodVerifiedRulesDetail)) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth E': documentsVerifiedAdditiveSchemaRules failed to accept a detail " +
        'containing both the nested/manual-migration finding and the append/default shape',
    };
  }

  // Tooth F: headerHasUnqualifiedEngineAdditiveClaim detects the false claim when present.
  const badHeaderWithFalseClaim =
    '// SpacetimeDB handles additive schema at the ENGINE level when publishing\n' +
    '// without --delete-data.\n' +
    'import { readFileSync } from "node:fs";\n';
  if (!headerHasUnqualifiedEngineAdditiveClaim(badHeaderWithFalseClaim)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth F: headerHasUnqualifiedEngineAdditiveClaim failed to detect the false ' +
        'unqualified claim in a header fixture that contains it verbatim',
    };
  }

  // Tooth F': accepts (returns false for) a corrected header with no such claim.
  const goodHeaderCorrected =
    '// A top-level column appended at the end with an explicit #[default(0)]\n' +
    '// annotation is accepted on republish without --delete-data; a nested\n' +
    '// struct widening requires a manual migration and is rejected.\n' +
    'import { readFileSync } from "node:fs";\n';
  if (headerHasUnqualifiedEngineAdditiveClaim(goodHeaderCorrected)) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth F': headerHasUnqualifiedEngineAdditiveClaim wrongly flagged a corrected " +
        'header that does not contain the unqualified claim',
    };
  }

  // Tooth G: namesEnforcingSnapshotGate rejects a detail that never names the gate.
  if (namesEnforcingSnapshotGate('name', 'no mention of any enforcing gate here')) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth G: namesEnforcingSnapshotGate failed to reject a detail that never ' +
        "names 'spacetime-type-snapshot'",
    };
  }

  // Tooth G': accepts a detail that names the enforcing gate.
  if (
    !namesEnforcingSnapshotGate(
      'name',
      'see evals/spacetime-type-snapshot.eval.mjs for the enforcing gate',
    )
  ) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth G': namesEnforcingSnapshotGate failed to accept a detail naming " +
        "'spacetime-type-snapshot'",
    };
  }

  // =========================================================================
  // 16.5e teeth (m16.5e, ADR-0116) — checkAdditiveColumnCoupling teeth C-1..C-6
  //
  // Signature chosen (document for implementer):
  //   checkAdditiveColumnCoupling(
  //     schemaSrc: string,      // raw schema.rs source
  //     contentSrc: string,     // raw content.rs source (FULL FILE, not fn body)
  //   ) -> string[]             // [] = clean; non-empty = violations
  //
  // The function:
  //   1. Calls parseContentTableStructs(schemaSrc) to get:
  //        { [structName: string]: { tableName: string, optionFields: string[] } }
  //      for each #[spacetimedb::table(accessor = <tableName>)] + struct with Option<…> fields.
  //   2. Calls parseSyncedTables(contentSrc) to get Set<string> of table names
  //      written to in content.rs (via ctx.db.<tableName>().<op>( pattern).
  //   3. For each struct where tableName is in the synced set, for each Option field,
  //      checks that contentSrc contains a field-assignment `<fieldName>:` inside
  //      a `<StructName> {` row-literal block (word-boundary rule: preceding char
  //      must NOT be [A-Za-z0-9_]).
  //   4. Returns [] if all coupling present; one string per missing coupling.
  //   5. Vacuity guard: if zero Option fields are found across ALL structs, returns
  //      a non-empty diagnostic array (parser rot guard).
  //
  // parseContentTableStructs and parseSyncedTables and checkAdditiveColumnCoupling
  // do NOT exist yet; calls below are intentionally RED.
  // =========================================================================

  // C-1: synced table, Option field, row literal OMITS <field>: assignment → flagged.
  // Simulates the `..existing` spread refactor omission: the row literal for ShopItemRow
  // uses spread syntax and does NOT include `cure_status:`.
  {
    // Schema fixture: shop_item table with a struct containing Option<StatusKind> cure_status.
    const schemaC1 =
      '#[spacetimedb::table(accessor = shop_item, public)]\n' +
      'pub struct ShopItemRow {\n' +
      '    pub item_id: u32,\n' +
      '    pub price: u32,\n' +
      '    pub cure_status: Option<StatusKind>,\n' +
      '}\n';

    // Content fixture: shop_item is synced (insert call present), but the row literal
    // uses ..Default::default() spread and OMITS `cure_status:`.
    const contentC1 =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    ctx.db.shop_item().insert(ShopItemRow {\n' +
      '        item_id: 1,\n' +
      '        price: 100,\n' +
      '        ..Default::default()\n' +
      '    });\n' +
      '}\n';

    let result;
    try {
      result = checkAdditiveColumnCoupling(schemaC1, contentC1);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-1): checkAdditiveColumnCoupling must flag missing cure_status: assignment ' +
          'in ShopItemRow literal (..Default::default() spread omits the field); got: ' +
          JSON.stringify(result),
      };
    }
    const flagText = result.join(' ');
    if (flagText.indexOf('cure_status') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-1): violation message must mention field name "cure_status"; got: ' +
          flagText,
      };
    }
  }

  // C-2: Option field WITH <field>: assignment in row literal must be clean.
  // Tests BOTH upsert shape and clear-and-reinsert (delete+insert) shape.
  {
    // Upsert shape: one row literal feeds both update and insert paths.
    const schemaC2Upsert =
      '#[spacetimedb::table(accessor = item_def, public)]\n' +
      'pub struct ItemDefRow {\n' +
      '    pub item_id: u32,\n' +
      '    pub train_stat: Option<StatKind>,\n' +
      '}\n';

    const contentC2Upsert =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    let row = ItemDefRow {\n' +
      '        item_id: 1,\n' +
      '        train_stat: Some(StatKind::Attack),\n' +
      '    };\n' +
      '    if let Some(existing) = ctx.db.item_def().item_id().find(1) {\n' +
      '        ctx.db.item_def().item_id().update(row);\n' +
      '    } else {\n' +
      '        ctx.db.item_def().item_id().insert(row);\n' +
      '    }\n' +
      '}\n';

    let resultUpsert;
    try {
      resultUpsert = checkAdditiveColumnCoupling(schemaC2Upsert, contentC2Upsert);
    } catch (e) {
      resultUpsert = [e.message];
    }
    if (!Array.isArray(resultUpsert) || resultUpsert.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-2 upsert): checkAdditiveColumnCoupling must return [] when train_stat: ' +
          'is present in the ItemDefRow row literal (upsert shape); got: ' +
          JSON.stringify(resultUpsert),
      };
    }

    // Clear-and-reinsert shape: delete all then insert fresh rows (no update branch).
    // This is the shop_item_row/type_relation_row/fusion shape.
    const schemaC2Clear =
      '#[spacetimedb::table(accessor = shop_item, public)]\n' +
      'pub struct ShopItemRow {\n' +
      '    pub item_id: u32,\n' +
      '    pub cure_status: Option<StatusKind>,\n' +
      '}\n';

    const contentC2Clear =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    for row in ctx.db.shop_item().iter() {\n' +
      '        ctx.db.shop_item().item_id().delete(row.item_id);\n' +
      '    }\n' +
      '    for entry in &content {\n' +
      '        ctx.db.shop_item().insert(ShopItemRow {\n' +
      '            item_id: entry.id,\n' +
      '            cure_status: entry.cure_status,\n' +
      '        });\n' +
      '    }\n' +
      '}\n';

    let resultClear;
    try {
      resultClear = checkAdditiveColumnCoupling(schemaC2Clear, contentC2Clear);
    } catch (e) {
      resultClear = [e.message];
    }
    if (!Array.isArray(resultClear) || resultClear.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-2 clear-and-reinsert): checkAdditiveColumnCoupling must return [] when cure_status: ' +
          'is present in the ShopItemRow literal (clear-and-reinsert shape, no update branch); got: ' +
          JSON.stringify(resultClear),
      };
    }
  }

  // C-3: vacuity guard — zero Option content fields discovered → loud FAIL.
  // Schema has no Option fields at all; function must not silently return [].
  // Kills any impl that skips the vacuity guard and returns [] when the parser finds nothing.
  {
    const schemaC3NoOptions =
      '#[spacetimedb::table(accessor = simple_table, public)]\n' +
      'pub struct SimpleRow {\n' +
      '    pub id: u32,\n' +
      '    pub name: String,\n' +
      '}\n';

    const contentC3 =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    ctx.db.simple_table().insert(SimpleRow { id: 1, name: "x".to_string() });\n' +
      '}\n';

    let result;
    try {
      result = checkAdditiveColumnCoupling(schemaC3NoOptions, contentC3);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-3): checkAdditiveColumnCoupling must return a non-empty diagnostic when ' +
          'zero Option fields are discovered (vacuity guard — parser rot); got: ' +
          JSON.stringify(result),
      };
    }
  }

  // C-4: real files missing an anchor → FAIL (parser rot).
  // Tests that parseContentTableStructs discovers the four anchors: ability, train_stat,
  // cure_status, cost_item_id. Uses the real schema.rs and content.rs files.
  // If any anchor is absent, the real-file coupling check would silently pass a false clean.
  {
    const schemaPath = 'server-module/src/schema.rs';
    const contentPath = 'server-module/src/content.rs';
    let schemaSrc = '';
    let contentSrc = '';
    let readOk = true;
    try {
      // Use readFileSync imported at module top level
      schemaSrc = readFileSync(schemaPath, 'utf8');
      contentSrc = readFileSync(contentPath, 'utf8');
    } catch {
      readOk = false;
    }
    if (readOk) {
      let parsed;
      try {
        parsed = parseContentTableStructs(schemaSrc);
      } catch (e) {
        parsed = null;
      }
      if (parsed !== null) {
        // Collect all discovered option fields across all structs
        const allFields = [];
        for (const entry of Object.values(parsed)) {
          if (Array.isArray(entry.optionFields)) {
            for (const f of entry.optionFields) {
              allFields.push(f);
            }
          }
        }
        const anchors = ['ability', 'train_stat', 'cure_status', 'cost_item_id'];
        for (const anchor of anchors) {
          if (allFields.indexOf(anchor) === -1) {
            return {
              name,
              pass: false,
              detail:
                'TEETH FAILED (C-4): parseContentTableStructs on real schema.rs did not discover anchor field "' +
                anchor +
                '" — parser rot; discovered fields: ' +
                JSON.stringify(allFields),
            };
          }
        }
      }
    }
    // If files not readable (CI env issue) or parser not yet implemented, skip gracefully —
    // the RED state is caused by C-1 calling undefined checkAdditiveColumnCoupling anyway.
  }

  // C-5: Option field on table NOT written by content.rs must NOT be flagged.
  // Simulates monster.evolves_to: parseSyncedTables must not include 'monster' if
  // content.rs does not write to it.
  {
    const schemaC5 =
      '#[spacetimedb::table(accessor = species, public)]\n' +
      'pub struct SpeciesRow {\n' +
      '    pub species_id: u32,\n' +
      '    pub ability: Option<AbilityKind>,\n' +
      '}\n' +
      '#[spacetimedb::table(accessor = monster, public)]\n' +
      'pub struct MonsterRow {\n' +
      '    pub monster_id: u64,\n' +
      '    pub evolves_to: Option<u32>,\n' +
      '}\n';

    // content.rs writes to species but NOT to monster.
    const contentC5 =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    ctx.db.species().insert(SpeciesRow {\n' +
      '        species_id: 1,\n' +
      '        ability: Some(AbilityKind::Blaze),\n' +
      '    });\n' +
      '}\n';

    let result;
    try {
      result = checkAdditiveColumnCoupling(schemaC5, contentC5);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-5): checkAdditiveColumnCoupling did not return an array; got: ' +
          JSON.stringify(result),
      };
    }
    // Check that monster.evolves_to is NOT flagged (not synced — no monster write in content).
    const flagText = result.join(' ');
    if (flagText.indexOf('evolves_to') !== -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-5): checkAdditiveColumnCoupling wrongly flagged monster.evolves_to ' +
          'even though content.rs does NOT write to the monster table — synced-tables-only filter not applied; got: ' +
          flagText,
      };
    }
  }

  // C-6: heal_location_row written OUTSIDE sync_content_inner body (in a helper fn) →
  // still discovered + coupled because parseSyncedTables scopes to ALL of content.rs.
  // Also exercises multi-line chain and intermediate accessor patterns (review m-4).
  {
    const schemaC6 =
      '#[spacetimedb::table(accessor = heal_location, public)]\n' +
      'pub struct HealLocationRow {\n' +
      '    pub location_id: u32,\n' +
      '    pub cost_item_id: Option<u32>,\n' +
      '}\n';

    // content.rs: heal_location is written by a HELPER FUNCTION outside sync_content_inner.
    // Uses multi-line chain pattern (review m-4):
    //   ctx.db
    //       .heal_location_row()
    //       .location_id()
    //       .delete(...)
    // and the update form: ctx.db.heal_location_row().location_id().update(row)
    // parseSyncedTables must capture these (whole-file scope, D4).
    const contentC6 =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    sync_species(ctx);\n' +
      '    seed_heal_locations_from(ctx, &HEAL_LOCATIONS);\n' +
      '}\n' +
      '\n' +
      'fn seed_heal_locations_from(ctx: &ReducerContext, locations: &[HealLocationEntry]) {\n' +
      '    for row in ctx.db\n' +
      '        .heal_location_row()\n' +
      '        .iter() {\n' +
      '        ctx.db\n' +
      '            .heal_location_row()\n' +
      '            .location_id()\n' +
      '            .delete(row.location_id);\n' +
      '    }\n' +
      '    for loc in locations {\n' +
      '        ctx.db.heal_location_row().insert(HealLocationRow {\n' +
      '            location_id: loc.id,\n' +
      '            cost_item_id: loc.cost_item_id,\n' +
      '        });\n' +
      '    }\n' +
      '}\n';

    let result;
    try {
      result = checkAdditiveColumnCoupling(schemaC6, contentC6);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-6): checkAdditiveColumnCoupling must return [] for heal_location_row ' +
          'written by a helper function outside sync_content_inner (whole-file scope D4) ' +
          'with cost_item_id: present in row literal; got: ' +
          JSON.stringify(result),
      };
    }
  }

  // C-W: word-boundary tooth — `stability: x.stability` must NOT satisfy required field `ability`.
  // Uses indexOf + manual preceding-char check (no dynamic RegExp).
  // Kills any impl that does a naive indexOf('ability:') which matches inside 'stability:'.
  {
    const schemaWB =
      '#[spacetimedb::table(accessor = species, public)]\n' +
      'pub struct SpeciesRow {\n' +
      '    pub species_id: u32,\n' +
      '    pub ability: Option<AbilityKind>,\n' +
      '}\n';

    // The row literal has `stability:` (a different field) but NOT `ability:` standalone.
    // A naive indexOf('ability:') would match inside 'stability:ability:' or if
    // 'stability:' contains 'ability' as a substring — specifically: 'st' + 'ability' + ':'.
    // This fixture directly tests the word-boundary rule.
    const contentWB =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    ctx.db.species().insert(SpeciesRow {\n' +
      '        species_id: 1,\n' +
      '        stability: x.stability,\n' +
      '    });\n' +
      '}\n';

    let result;
    try {
      result = checkAdditiveColumnCoupling(schemaWB, contentWB);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-W word-boundary): checkAdditiveColumnCoupling must flag missing `ability:` ' +
          'assignment even when `stability:` (which contains "ability" as substring) is present in the ' +
          'row literal — word-boundary check required (preceding char [A-Za-z0-9_] before "ability:" must reject); got: ' +
          JSON.stringify(result),
      };
    }
    const flagText = result.join(' ');
    if (flagText.indexOf('ability') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-W word-boundary): violation message must mention field "ability"; got: ' +
          flagText,
      };
    }
  }

  // =========================================================================
  // END 16.5e teeth (C-1..C-6, C-W)
  // =========================================================================

  // =========================================================================
  // EG1-11 teeth (H-0..H-6, ADR-0174 D1) — checkAppendedColumns must bite on
  // each shape live spacetime 2.6.0 actually rejects, and hasDeriveOnStruct
  // must bite on a missing SpacetimeType derive.
  //
  // Fixtures are deliberately MINIMAL (a two-column append) so each tooth
  // isolates one failure mode.
  // =========================================================================

  // H-0 (positive control): a correctly appended pair must be clean.
  {
    const goodAppend =
      'pub struct Monster {\n' +
      '    pub monster_id: u64,\n' +
      '    pub evolves_to: Option<u32>,\n' +
      '    #[default(0)]\n' +
      '    pub essence_fire: u32,\n' +
      '    #[default(0)]\n' +
      '    pub trust_favorable_count: u32,\n' +
      '}\n';
    const result = checkAppendedColumns(goodAppend, 'Monster', 'evolves_to', [
      'essence_fire',
      'trust_favorable_count',
    ]);
    if (!Array.isArray(result) || result.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (H-0): checkAppendedColumns must return [] for two columns appended ' +
          'after the anchor with explicit #[default(0)]; got: ' +
          JSON.stringify(result),
      };
    }
  }

  // H-1: a MID-STRUCT INSERT (column placed before the pre-migration anchor)
  // must be flagged — this is the shape the engine rejects as a reordering.
  {
    const midStructInsert =
      'pub struct Monster {\n' +
      '    pub monster_id: u64,\n' +
      '    #[default(0)]\n' +
      '    pub essence_fire: u32,\n' +
      '    pub evolves_to: Option<u32>,\n' +
      '    #[default(0)]\n' +
      '    pub trust_favorable_count: u32,\n' +
      '}\n';
    const result = checkAppendedColumns(midStructInsert, 'Monster', 'evolves_to', [
      'essence_fire',
      'trust_favorable_count',
    ]);
    const text = Array.isArray(result) ? result.join(' ') : String(result);
    if (!Array.isArray(result) || result.length === 0 || text.indexOf('essence_fire') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (H-1): checkAppendedColumns must FLAG essence_fire declared BEFORE the ' +
          'pre-migration anchor evolves_to (a mid-struct insert — rejected by live spacetime ' +
          '2.6.0 both as a reordering and for want of a default); got: ' +
          JSON.stringify(result),
      };
    }
  }

  // H-2: an appended column with NO #[default(...)] must be flagged.
  {
    const missingDefault =
      'pub struct Monster {\n' +
      '    pub monster_id: u64,\n' +
      '    pub evolves_to: Option<u32>,\n' +
      '    #[default(0)]\n' +
      '    pub essence_fire: u32,\n' +
      '    pub trust_favorable_count: u32,\n' +
      '}\n';
    const result = checkAppendedColumns(missingDefault, 'Monster', 'evolves_to', [
      'essence_fire',
      'trust_favorable_count',
    ]);
    const text = Array.isArray(result) ? result.join(' ') : String(result);
    if (
      !Array.isArray(result) ||
      result.length === 0 ||
      text.indexOf('trust_favorable_count') === -1 ||
      text.indexOf('#[default(') === -1
    ) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (H-2): checkAppendedColumns must FLAG an appended column carrying no ' +
          'explicit #[default(...)] annotation (append-at-end alone is not sufficient); got: ' +
          JSON.stringify(result),
      };
    }
  }

  // H-3: an attribute belonging to a DIFFERENT field must not satisfy the
  // default requirement (co-location rigor, mirroring tooth A'').
  {
    const defaultOnWrongField =
      'pub struct Monster {\n' +
      '    pub monster_id: u64,\n' +
      '    #[default(0)]\n' +
      '    pub evolves_to: Option<u32>,\n' +
      '    pub essence_fire: u32,\n' +
      '}\n';
    const result = checkAppendedColumns(defaultOnWrongField, 'Monster', 'evolves_to', [
      'essence_fire',
    ]);
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (H-3): checkAppendedColumns accepted essence_fire although the ' +
          '#[default(0)] sits on evolves_to — the annotation must be co-located with the ' +
          'TARGET column, not merely present in the struct',
      };
    }
  }

  // H-4: a MISSING appended column must be flagged (not silently skipped).
  {
    const missingColumn =
      'pub struct Monster {\n' +
      '    pub monster_id: u64,\n' +
      '    pub evolves_to: Option<u32>,\n' +
      '    #[default(0)]\n' +
      '    pub essence_fire: u32,\n' +
      '}\n';
    const result = checkAppendedColumns(missingColumn, 'Monster', 'evolves_to', [
      'essence_fire',
      'trust_favorable_count',
    ]);
    const text = Array.isArray(result) ? result.join(' ') : String(result);
    if (!Array.isArray(result) || result.length === 0 || text.indexOf('MISSING') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (H-4): checkAppendedColumns must FLAG a required appended column that ' +
          'is absent from the struct; got: ' +
          JSON.stringify(result),
      };
    }
  }

  // H-5: the two appended columns declared in the WRONG relative order must be
  // flagged (ADR-0174 D1 fixes the append order).
  {
    const wrongOrder =
      'pub struct Monster {\n' +
      '    pub monster_id: u64,\n' +
      '    pub evolves_to: Option<u32>,\n' +
      '    #[default(0)]\n' +
      '    pub trust_favorable_count: u32,\n' +
      '    #[default(0)]\n' +
      '    pub essence_fire: u32,\n' +
      '}\n';
    const result = checkAppendedColumns(wrongOrder, 'Monster', 'evolves_to', [
      'essence_fire',
      'trust_favorable_count',
    ]);
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (H-5): checkAppendedColumns must FLAG the two appended columns declared ' +
          'in the wrong relative order (ADR-0174 D1 pins the append order)',
      };
    }
  }

  // H-6: hasDeriveOnStruct must reject a nested row struct that lacks the
  // SpacetimeType derive, and accept one that has it.
  {
    const noDerive =
      'pub struct Other {\n    pub x: u32,\n}\n' +
      '#[derive(Clone, Debug, PartialEq, Eq)]\n' +
      'pub struct EssenceRequirementRow {\n    pub affinity: Affinity,\n    pub amount: u32,\n}\n';
    if (hasDeriveOnStruct(noDerive, 'EssenceRequirementRow', 'SpacetimeType')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (H-6): hasDeriveOnStruct accepted EssenceRequirementRow with no ' +
          'SpacetimeType derive — a nested row struct without it cannot be a column type at all',
      };
    }
    const withDerive =
      'pub struct Other {\n    pub x: u32,\n}\n' +
      '#[derive(spacetimedb::SpacetimeType, Clone, Debug, PartialEq, Eq)]\n' +
      'pub struct EssenceRequirementRow {\n    pub affinity: Affinity,\n    pub amount: u32,\n}\n';
    if (!hasDeriveOnStruct(withDerive, 'EssenceRequirementRow', 'SpacetimeType')) {
      return {
        name,
        pass: false,
        detail:
          "TEETH FAILED (H-6'): hasDeriveOnStruct failed to accept EssenceRequirementRow with " +
          'the SpacetimeType derive in its own attribute block',
      };
    }
    // A neighbouring struct's derive must not leak across the item boundary.
    const neighbourDerive =
      '#[derive(spacetimedb::SpacetimeType)]\n' +
      'pub struct Other {\n    pub x: u32,\n}\n' +
      '#[derive(Clone)]\n' +
      'pub struct EssenceRequirementRow {\n    pub affinity: Affinity,\n    pub amount: u32,\n}\n';
    if (hasDeriveOnStruct(neighbourDerive, 'EssenceRequirementRow', 'SpacetimeType')) {
      return {
        name,
        pass: false,
        detail:
          "TEETH FAILED (H-6''): hasDeriveOnStruct let the PRECEDING struct's SpacetimeType " +
          'derive satisfy EssenceRequirementRow — the attribute window must stop at the end of ' +
          'the previous item',
      };
    }
  }

  // =========================================================================
  // END EG1-11 teeth (H-0..H-6)
  // =========================================================================

  // -------------------------------------------------------------------------
  // REAL FILE CHECKS
  // -------------------------------------------------------------------------
  const typesPath = path.resolve('game-core/src/combat/types.rs');
  const m14bTestsPath = path.resolve('game-core/src/combat/m14b_tests.rs');

  let typesSrc = '';
  try {
    typesSrc = readFileSync(typesPath, 'utf8');
  } catch {
    return { name, pass: false, detail: `cannot read ${typesPath}` };
  }

  let testSrc = '';
  try {
    testSrc = readFileSync(m14bTestsPath, 'utf8');
  } catch {
    return { name, pass: false, detail: `cannot read ${m14bTestsPath}` };
  }

  // Criterion 1: #[serde(default)] co-located with BattleMonster.status
  if (!hasSerdeDefaultOnField(typesSrc, 'BattleMonster', 'status')) {
    return {
      name,
      pass: false,
      detail:
        'criterion 1 FAIL: BattleMonster.status is missing #[serde(default)] immediately ' +
        'before the field declaration in game-core/src/combat/types.rs',
    };
  }

  // Criterion 2: #[serde(default)] co-located with BattleState.weather
  if (!hasSerdeDefaultOnField(typesSrc, 'BattleState', 'weather')) {
    return {
      name,
      pass: false,
      detail:
        'criterion 2 FAIL: BattleState.weather is missing #[serde(default)] immediately ' +
        'before the field declaration in game-core/src/combat/types.rs',
    };
  }

  // Criterion 3: SpacetimeType derive on BattleMonster
  if (!hasSpacetimeTypeDerive(typesSrc, 'BattleMonster')) {
    return {
      name,
      pass: false,
      detail:
        'criterion 3 FAIL: BattleMonster is missing the SpacetimeType cfg_attr derive in ' +
        'game-core/src/combat/types.rs — the BSATN codec finding applies only to SpacetimeType-derived types',
    };
  }

  // Criterion 4: SpacetimeType derive on BattleState
  if (!hasSpacetimeTypeDerive(typesSrc, 'BattleState')) {
    return {
      name,
      pass: false,
      detail:
        'criterion 4 FAIL: BattleState is missing the SpacetimeType cfg_attr derive in ' +
        'game-core/src/combat/types.rs — the BSATN codec finding applies only to SpacetimeType-derived types',
    };
  }

  // Criterion 5: serde/RON default test fn names exist in m14b_tests.rs
  if (!hasRonDefaultTests(testSrc)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 5 FAIL: m14b_tests.rs is missing one or both required serde-default tests — ' +
        'expected: m14b_serde_default_allows_missing_status_field AND ' +
        'm14b_battle_monster_status_field_defaults_to_none',
    };
  }

  // Criterion 7 (16.5e-3, ADR-0116 D4): additive-content coupling on the REAL
  // schema.rs + content.rs. Fail loud if unreadable — these paths are fixed.
  const schemaPath = path.resolve('server-module/src/schema.rs');
  const contentPath = path.resolve('server-module/src/content.rs');
  let schemaSrc = '';
  try {
    schemaSrc = readFileSync(schemaPath, 'utf8');
  } catch {
    return { name, pass: false, detail: `criterion 7 FAIL: cannot read ${schemaPath}` };
  }
  let contentSrc = '';
  try {
    contentSrc = readFileSync(contentPath, 'utf8');
  } catch {
    return { name, pass: false, detail: `criterion 7 FAIL: cannot read ${contentPath}` };
  }
  const couplingViolations = checkAdditiveColumnCoupling(schemaSrc, contentSrc);
  if (couplingViolations.length > 0) {
    return {
      name,
      pass: false,
      detail:
        'criterion 7 FAIL (16.5e-3 additive-content coupling, ADR-0116 D4): ' +
        couplingViolations.join('; '),
    };
  }

  // Criterion 11 (EG1-11, ADR-0174 D1): Migration A's 16 Monster + 12 MonsterPub
  // + 1 SpeciesRow columns must each be APPENDED after that struct's last
  // pre-migration column AND carry an explicit #[default(...)] — the only shape
  // live spacetime 2.6.0 accepts without --delete-data.
  // Still needed after ADR-0193 (13r-d): that slice made the SHAPE rule always-on
  // for every table, but only this block pins these NAMED columns in this ORDER,
  // which is what freezes Migration A's wire layout.
  const eg1Violations = [
    // Anchors moved by Migration B (EG5-6/ADR-0177 D2): `evolves_to` (and `bond`)
    // were removed, so the last PRE-Migration-A column is now `last_care_at_ms`
    // on Monster and `party_slot` on MonsterPub.
    ...checkAppendedColumns(schemaSrc, 'Monster', 'last_care_at_ms', EG1_MONSTER_APPENDED_COLUMNS),
    ...checkAppendedColumns(
      schemaSrc,
      'MonsterPub',
      'party_slot',
      EG1_MONSTER_PUB_APPENDED_COLUMNS,
    ),
    ...checkAppendedColumns(schemaSrc, 'SpeciesRow', 'ability', EG1_SPECIES_ROW_APPENDED_COLUMNS),
  ];
  if (eg1Violations.length > 0) {
    return {
      name,
      pass: false,
      detail:
        'criterion 11 FAIL (EG1-11 / ADR-0174 D1 — Migration A appended columns): ' +
        eg1Violations.join('; '),
    };
  }

  // Criterion 12 (EG1-11): the new NESTED row struct EssenceRequirementRow must
  // exist and derive SpacetimeType. A table/shape snapshot alone does not cover
  // nested SpacetimeType structs (battle-schema-snapshot's own documented
  // exclusion), and ADR-0174 D8 records that this struct's field set is a
  // one-shot freeze — widening it later is rejected by automigration.
  if (!hasDeriveOnStruct(schemaSrc, 'EssenceRequirementRow', 'SpacetimeType')) {
    return {
      name,
      pass: false,
      detail:
        'criterion 12 FAIL (EG1-11): server-module/src/schema.rs must declare the nested row ' +
        'struct EssenceRequirementRow { affinity: Affinity, amount: u32 } deriving ' +
        'spacetimedb::SpacetimeType (the EncounterEntryRow precedent) — it is the element type ' +
        'of evolution_path.essence: Vec<EssenceRequirementRow>, and its field set is a one-shot ' +
        'freeze (ADR-0174 D8): a nested-struct widening is rejected by live automigration.',
    };
  }

  // Criterion 6: BSATN gap finding documented in name+detail (self-check)
  const passingDetail =
    'serde(default) present on BattleMonster.status and BattleState.weather (co-located); ' +
    'SpacetimeType derive confirmed on both structs; serde/RON default tests confirmed in m14b_tests.rs. ' +
    'FINDING (14.5f-1): serde/RON tests prove serde-codec compat only. ' +
    'battle.state persists via BSATN (SpacetimeType derive — position-based codec, no missing-field defaults). ' +
    'The serde(default) annotation covers the serde serialization path (RON content, JSON wire format) ' +
    'but is NOT what makes BSATN-persisted rows backward-compatible with new optional fields. ' +
    'VERIFIED RULES (11r-i / ADR-0173 D5 — measured against live spacetime 2.6.0 by republishing an ' +
    'existing database WITHOUT --delete-data, superseding the earlier unqualified engine-handles-it claim): ' +
    'adding a field to a nested SpacetimeType struct (BattleState, or EncounterEntryRow inside a Vec column) ' +
    'is REJECTED and requires a manual migration — Option<T> plus serde(default) does NOT help, because the ' +
    'engine compares the whole nested product type; a top-level column inserted mid-struct is REJECTED as a ' +
    'reordering AND for want of a default value annotation; the ONLY accepted additive shape is a column ' +
    'append-ed at the END of the table struct carrying an explicit #[default(...)] annotation, which ' +
    'publishes cleanly and preserves pre-existing rows. ' +
    'ENFORCING GATE: a nested-type widening is caught in CI by spacetime-type-snapshot ' +
    '(evals/spacetime-type-snapshot.eval.mjs + evals/baselines/spacetime-types.json, which pins ' +
    "BattleState's field list) — not by this static eval and not by the nightly smoke job. " +
    '16.5e-3 (ADR-0116 D4): additive-content coupling verified — every Option column on a ' +
    'content-synced table has its field-assignment in a content.rs re-seed row literal ' +
    '(anchors: ability, train_stat, cure_status, cost_item_id). ' +
    'EG1-11 (ADR-0174 D1): Migration A verified against the same rule — all 16 Monster and ' +
    '12 MonsterPub columns sit after last_care_at_ms/party_slot (the post-Migration-B ' +
    'anchors, ADR-0177 D2) and SpeciesRow.tier after ability, in the ' +
    "ADR's declared order, each with an explicit #[default(...)]; the nested row struct " +
    'EssenceRequirementRow derives SpacetimeType (its field set is a one-shot freeze, ' +
    'ADR-0174 D8 — nested widening is rejected by automigration).';

  if (!documentsBsatnGap(name, passingDetail)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 6 FAIL: BSATN gap finding not present in eval name+detail — ' +
        "expected 'BSATN', 'serde', 'engine' in combined string",
    };
  }

  // Criterion 8 (T6-a): the eval's passing detail must make the VERIFIED
  // additive-schema rules machine-visible (nested-widening-requires-manual-
  // migration AND append-at-end-with-#[default(...)]-is-accepted) — not the
  // false unqualified "engine handles additive schema" claim this eval
  // previously made. RED until the implementer rewrites `passingDetail`.
  if (!documentsVerifiedAdditiveSchemaRules(name, passingDetail)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 8 FAIL (T6-a): eval name+detail must document the VERIFIED additive-schema ' +
        'rules (empirically tested against live spacetime 2.6.0, republishing WITHOUT ' +
        '--delete-data): a nested-struct field widening requires a manual migration and is ' +
        'REJECTED; the only accepted additive shape is a top-level column appended at the end ' +
        'with an explicit #[default(...)] annotation. The prior unqualified claim ("SpacetimeDB ' +
        'handles additive schema at the ENGINE level") is FALSE — got detail: ' +
        passingDetail,
    };
  }

  // Criterion 9 (T6-b): this eval's own HEADER must no longer assert the
  // false, unqualified claim. RED until the implementer corrects the header
  // comment (lines ~1-25).
  const selfPath = path.resolve('evals/bsatn-compat-smoke.eval.mjs');
  let selfSrc = '';
  try {
    selfSrc = readFileSync(selfPath, 'utf8');
  } catch {
    return { name, pass: false, detail: `criterion 9 FAIL (T6-b): cannot read ${selfPath}` };
  }
  if (headerHasUnqualifiedEngineAdditiveClaim(selfSrc)) {
    return {
      name,
      pass: false,
      detail:
        "criterion 9 FAIL (T6-b): this eval's own header still asserts the false, unqualified " +
        'claim that "SpacetimeDB handles additive schema at the ENGINE level when publishing ' +
        'without --delete-data" — verified FALSE against live spacetime 2.6.0 (nested-struct ' +
        'widening is REJECTED with "requires a manual migration"; only append-at-end + ' +
        '#[default(...)] is accepted). Correct the header comment.',
    };
  }

  // Criterion 10 (T6-c): route a reader to the mechanism that actually
  // enforces this: evals/spacetime-type-snapshot.eval.mjs, which pins
  // BattleState's field list and so catches a nested-type widening in CI.
  if (!namesEnforcingSnapshotGate(name, passingDetail)) {
    return {
      name,
      pass: false,
      detail:
        "criterion 10 FAIL (T6-c): eval name+detail must name 'spacetime-type-snapshot' — the " +
        "gate (evals/spacetime-type-snapshot.eval.mjs) that pins BattleState's field list and " +
        'so actually catches a nested-type widening in CI, per the baseline in ' +
        'evals/baselines/spacetime-types.json.',
    };
  }

  return {
    name,
    pass: true,
    detail: passingDetail,
  };
}
