// battle-schema-snapshot eval (M8.7a, ADR-0006): ALL table definitions under
// server-module/src/** must exactly match the committed baseline in
// evals/baselines/table-schemas.json (columns, declared types, PK, table set).
// (M8.9b split the former single lib.rs into domain submodules; this eval globs
// the whole src tree — see readServerModuleSources below.)
//
// Regeneration (ADR-0193 D6 as amended by ADR-0199 D8) — always RE-DERIVE from
// source, never hand-merge:
//   node evals/battle-schema-snapshot.eval.mjs --write
// a thin main guard (end of file) over the pure `formatBaseline`, which emits
// { pk, visibility, visibility_note?, columns, order, …hand-authored markers }
// per table, keeps the existing top-level table key order (do NOT re-sort) and
// appends new tables at the end. Commit the diff for review: the git
// append-only layer (D4, below) polices the RESULT against the previously
// committed baseline, so neither a mid-struct insert nor a private -> public
// flip can be laundered by regenerating.
//
// Implementation note on Semgrep detect-non-literal-regexp:
//   All pattern matching uses literal /regex/ patterns — NO new RegExp(...).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactWs, stripRustSource } from './rust-scan.mjs';

const BASELINE_PATH = path.resolve('evals/baselines/table-schemas.json');
const SERVER_SRC = path.resolve('server-module/src');

// ---------------------------------------------------------------------------
// Pure parser helpers. `parseTableSchemas` is imported by scripts/okf-export.mjs
// (it renders docs/knowledge/** from the `columns` key INSERTION ORDER),
// evals/gate-teeth.eval.mjs and evals/guest-claim-integrity.eval.mjs — its
// return shape and that key order are load-bearing outside this file.
// The struct-keyed counterpart of the order rules below lives in
// evals/bsatn-compat-smoke.eval.mjs (`parseStructFieldOrder`/`checkAppendedColumns`),
// which pins ONE migration's exact column list; this file gates the SHAPE for
// every table (ADR-0193).
// ---------------------------------------------------------------------------

/**
 * Strip Rust block comments and line comments from source.
 * @param {string} src Raw Rust source.
 * @returns {string}
 */
export function stripRustComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

/**
 * Parse all `#[spacetimedb::table(accessor = X, ...)] pub struct Y { ... }` blocks
 * and return a map of tableName -> { pk: string|null, columns: { [field]: type } }.
 *
 * Keys only on #[spacetimedb::table( — excludes #[derive(SpacetimeType)] structs
 * (e.g. EncounterEntryRow).
 *
 * @param {string} rawSrc Raw Rust source (comments stripped internally).
 * @returns {{ [tableName: string]: { pk: string|null, columns: { [field]: string } } }}
 */
export function parseTableSchemas(rawSrc) {
  const parsed = parseTableFields(rawSrc);
  const tables = {};
  for (const tableName of Object.keys(parsed)) {
    const columns = {};
    // Insertion order == declaration order: scripts/okf-export.mjs renders
    // docs/knowledge/** from it (ADR-0193 D1).
    for (const f of parsed[tableName].fields) columns[f.name] = f.type;
    tables[tableName] = { pk: parsed[tableName].pk, columns };
  }
  return tables;
}

// ---------------------------------------------------------------------------
// ADR-0193 D1 — parse once, project twice. parseTableFields owns the ONLY
// table regex and the ONLY field-line regex in this file; parseTableSchemas
// (unordered name->type map, unchanged shape) and parseTableColumnOrder
// (ordered + hasDefault) are thin projections over it.
// ---------------------------------------------------------------------------

/**
 * Match every `#[spacetimedb::table(accessor = X, ...)] pub struct Y { ... }` block.
 * The /g regex is declared INSIDE the function on purpose: a module-level /g
 * regex carries `lastIndex` across calls, so a second call would return fewer
 * tables and silently exempt them.
 *
 * ADR-0199 D1: the previously UNCAPTURED attribute tail is now captured (group
 * 2) so visibility is a third projection over this single parse. The pattern
 * itself is unchanged — only parentheses were added — but `body` moved from
 * m[2] to m[3]; getting that renumbering wrong silently empties every table.
 *
 * @param {string} src Comment-stripped Rust source.
 * @returns {{ table: string, attrTail: string, body: string }[]}
 */
function matchTableBlocks(src) {
  const tableRe =
    /#\[spacetimedb::table\(accessor\s*=\s*(\w+)([^\]]*)\)\]\s*pub struct \w+\s*\{([\s\S]*?)\n\s*\}/g;
  const blocks = [];
  let m = tableRe.exec(src);
  while (m !== null) {
    blocks.push({ table: m[1], attrTail: m[2], body: m[3] });
    m = tableRe.exec(src);
  }
  return blocks;
}

/**
 * ADR-0199 D2 — the declared visibility of ONE table attribute tail, derived by
 * EXACT TOKEN, never by substring. The tail is split on commas at paren/bracket
 * depth 0 and a token must equal `public`: `index(btree, name = public_view,
 * columns = [x])` is a demonstrated false positive for the superseded
 * `attrRest.indexOf('public')` form, and the depth counter keeps
 * `scheduled(guest_claim_reaper)` from mis-splitting.
 *
 * Exported: scripts/okf-export.mjs derives the knowledge bundle's visibility
 * through THIS function, so the gate and the docs cannot disagree (ADR-0199 D2).
 *
 * @param {string} attrTail The captured `#[spacetimedb::table(accessor = X<TAIL>)]`.
 * @returns {'public'|'private'}
 */
export function visibilityFromAttrArgs(attrTail) {
  if (typeof attrTail !== 'string') return 'private';
  let depth = 0;
  let token = '';
  const tokens = [];
  for (const ch of attrTail) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      tokens.push(token);
      token = '';
      continue;
    }
    token += ch;
  }
  tokens.push(token);
  return tokens.some((t) => t.trim() === 'public') ? 'public' : 'private';
}

/**
 * The single field-line pattern (literal, non-global — no shared lastIndex).
 * @param {string} line Trimmed table-body line.
 * @returns {RegExpExecArray|null}
 */
function matchFieldLine(line) {
  return /^pub\s+(\w+)\s*:\s*(.+?),?\s*$/.exec(line);
}

/** Count `pub <ident>:` field starts on one line (>1 == two fields per line). */
function countFieldStarts(line) {
  const re = /\bpub\s+\w+\s*:/g;
  let n = 0;
  while (re.exec(line) !== null) n++;
  return n;
}

/**
 * Ordered per-table field parse with a per-field `hasDefault`, derived from the
 * field's OWN immediately-preceding attribute lines — never from a file-level
 * search (content_tests.rs / marshal_tests.rs carry `#[default(` inside Rust
 * string literals and this eval concatenates every .rs file).
 *
 * @param {string} rawSrc Raw Rust source (comments stripped internally).
 * @returns {{ [tableName: string]: { pk: string|null, visibility: 'public'|'private', fields: { name: string, type: string, hasDefault: boolean }[] } }}
 */
function parseTableFields(rawSrc) {
  if (typeof rawSrc !== 'string') return {};
  const src = stripRustComments(rawSrc);
  const tables = {};
  for (const { table, attrTail, body } of matchTableBlocks(src)) {
    const fields = [];
    let pk = null;
    let pendingPk = false;
    let pendingDefault = false;
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      if (t.startsWith('#[')) {
        if (t.includes('primary_key')) pendingPk = true;
        if (t.startsWith('#[default(')) pendingDefault = true;
        continue;
      }
      const fm = matchFieldLine(t);
      if (fm) {
        const fname = fm[1];
        fields.push({
          name: fname,
          type: fm[2].replace(/,$/, '').trim(),
          hasDefault: pendingDefault,
        });
        if (pendingPk) pk = fname;
      }
      // A field line AND any unclassifiable line both clear the pending
      // attributes (preserves the pre-ADR-0193 pendingPk semantics exactly).
      pendingPk = false;
      pendingDefault = false;
    }
    tables[table] = { pk, visibility: visibilityFromAttrArgs(attrTail), fields };
  }
  return tables;
}

/**
 * Per-table column order in SOURCE DECLARATION order, with each column's own
 * `#[default(` presence.
 *
 * @param {string} rawSrc Raw Rust source.
 * @returns {{ [tableName: string]: { name: string, hasDefault: boolean }[] }}
 */
export function parseTableColumnOrder(rawSrc) {
  const parsed = parseTableFields(rawSrc);
  const out = {};
  for (const tableName of Object.keys(parsed)) {
    out[tableName] = parsed[tableName].fields.map((f) => ({
      name: f.name,
      hasDefault: f.hasDefault,
    }));
  }
  return out;
}

/**
 * ADR-0199 D1 — the THIRD projection over parseTableFields: per-table declared
 * visibility. Same single parse, same table set BY CONSTRUCTION as
 * parseTableSchemas / parseTableColumnOrder (so a table can never be public in
 * one projection and absent from another), and the same comment-stripped text —
 * the `#[spacetimedb::table(accessor = player_wallet, public)]` decoy inside the
 * `//` comment at server-module/src/economy_tests.rs:73 cannot promote a table.
 *
 * @param {string} rawSrc Raw Rust source.
 * @returns {{ [tableName: string]: 'public'|'private' }}
 */
export function parseTableVisibility(rawSrc) {
  const parsed = parseTableFields(rawSrc);
  const out = {};
  for (const tableName of Object.keys(parsed)) {
    out[tableName] = parsed[tableName].visibility;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ADR-0193 D3/D4 — six always-on, individually tagged rules. Every checker is
// pure and NEVER throws for ANY input: malformed input yields a TAGGED
// diagnostic string, not a TypeError (checkAppendOnly guard style,
// evals/spacetime-type-snapshot.eval.mjs).
// ---------------------------------------------------------------------------

// Whitespace-insensitive: the parser's own regex needs the attribute on ONE line
// with `accessor` first, so a rustfmt-wrapped or argument-reordered attribute must
// still be COUNTED here — otherwise the table vanishes from both sides at once
// and the count agrees vacuously (13r-d red-team F3).
const TABLE_ATTR_NEEDLE = '#[spacetimedb::table(';

// ADR-0193 D7: the per-table, self-expiring escape for a change that only the
// ADR-0177 delete-data runbook can make legal. Value must be a string naming an
// ADR; see checkBaselineAppendOnly.
const MANUAL_MIGRATION_KEY = 'manual_migration';

// ADR-0199 D3/D5: the visibility axis and its PERMANENT escape marker. Unlike
// MANUAL_MIGRATION_KEY the note has no staleness rule — the escalation trigger
// self-disarms once prev and next are both public — and unlike D7's
// `indexOf('ADR-')` escape it is ANCHORED: the note must BEGIN with `ADR-` plus
// at least four digits, so a literal "ADR-" (or "see ADR-0199") authorizes
// nothing (RT-1, demonstrated against the D7 escape this slice does not touch).
const VISIBILITY_KEY = 'visibility';
const VISIBILITY_NOTE_KEY = 'visibility_note';
const VISIBILITY_VALUES = ['public', 'private'];

/** Is `note` an ADR-anchored visibility justification? (literal pattern only). */
const isAnchoredNote = (note) => typeof note === 'string' && /^ADR-\d{4,}/.test(note);

const AUTOMIGRATION_RULE =
  "as a change to an EXISTING table's columns, live spacetime 2.6.0 accepts only " +
  'TAIL-appended columns each carrying an explicit #[default(...)] (ADR-0173 D5; adding a new ' +
  'table or an index is separately safe)';

const DEFAULTS_ESCAPES =
  'two sanctioned escapes: (1) move the column to the TAIL of the struct or give it a ' +
  '#[default(...)]; or (2) perform a delete-data migration per the ADR-0177 runbook and drop ' +
  'the now-stale #[default(...)] attributes in the same change';

const isObj = (v) => v !== null && typeof v === 'object';

/**
 * The recorded column order of a baseline entry.
 *
 * Legacy fallback: a baseline committed BEFORE ADR-0193 D2 has no `order` key,
 * but its `columns` object was generated in source declaration order, so its
 * key insertion order IS the recorded order. Without this, every table in the
 * bootstrap commit (prev = pre-D2 baseline) would report a malformed entry and
 * the append-only layer would be vacuous exactly when it first matters. This
 * applies to the PREVIOUS baseline only — the working-tree one is held to the
 * explicit `order` key by [order-shape].
 *
 * @param {object} entry Baseline table entry.
 * @returns {string[]|null} null == no recorded order at all.
 */
const recordedOrder = (entry) => {
  if (!isObj(entry)) return null;
  if (Array.isArray(entry.order)) return entry.order;
  if (isObj(entry.columns)) return Object.keys(entry.columns);
  return null;
};

/** Column name of a parsed-order entry (entries may be malformed). */
const entryName = (f) => {
  if (typeof f === 'string') return f;
  return isObj(f) && typeof f.name === 'string' ? f.name : undefined;
};

/**
 * [parse-shape] + [table-count]: make previously-SILENT parser blindness loud.
 * A body line the parser cannot classify is an invisible column, and a table
 * the table regex never matches is exempt from every other rule here.
 *
 * @param {string} rawSrc Raw Rust source.
 * @returns {string[]} [] = clean.
 */
function checkParseShapeCore(rawSrc) {
  if (typeof rawSrc !== 'string') {
    return [`[parse-shape] malformed input: expected a source string, got ${typeof rawSrc}`];
  }
  const violations = [];
  for (const { table, body } of matchTableBlocks(stripRustComments(rawSrc))) {
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      if (t.startsWith('#[')) {
        if (/\]\s*pub\s+\w+\s*:/.test(t)) {
          violations.push(
            `[parse-shape] table '${table}': attribute AND field on one line — '${t}'. The ` +
              'parser reads the whole line as a bare attribute, so the column is invisible to ' +
              'the snapshot; put the attribute on its own line',
          );
        }
        continue;
      }
      if (matchFieldLine(t) === null) {
        violations.push(
          `[parse-shape] table '${table}': unparsable body line '${t}' — every non-blank line ` +
            'in a table body must be an attribute (#[...]) or a `pub name: Type,` field on one ' +
            'line; anything else is a column the snapshot cannot see',
        );
        continue;
      }
      if (countFieldStarts(t) > 1) {
        violations.push(
          `[parse-shape] table '${table}': two 'pub' fields on one line — '${t}'. Only the ` +
            'first is parsed; the rest are invisible to the snapshot',
        );
      }
    }
  }
  // [table-count] — string- AND comment-aware strip (evals/rust-scan.mjs): a
  // naive comment-only strip counts the decoy attributes that live inside Rust
  // string literals in server-module/src/economy_tests.rs.
  const declared = compactWs(stripRustSource(rawSrc)).split(TABLE_ATTR_NEEDLE).length - 1;
  const parsedCount = Object.keys(parseTableFields(rawSrc)).length;
  if (declared !== parsedCount) {
    violations.push(
      `[table-count] source declares ${declared} '${TABLE_ATTR_NEEDLE}' attribute(s) but the ` +
        `parser produced ${parsedCount} table(s) — an unparsed table is silently exempt from ` +
        'every schema rule (e.g. a `]` inside the table attribute defeats the table regex)',
    );
  }
  return violations;
}

/**
 * [order-shape] + [order-mismatch] + [order-append]: the recorded per-table
 * `order` must be well-formed, and the source column order must agree with it.
 *
 * @param {{ [t: string]: { name: string, hasDefault: boolean }[] }} parsedOrder
 * @param {{ [t: string]: { columns?: object, order?: string[] } }} baseline
 * @returns {string[]} [] = clean.
 */
function checkColumnOrderCore(parsedOrder, baseline) {
  if (!isObj(parsedOrder) || !isObj(baseline)) {
    return [
      '[order-shape] malformed input: checkColumnOrder requires two non-null objects (got ' +
        `${typeof parsedOrder}, ${typeof baseline})`,
    ];
  }
  const violations = [];
  for (const table of Object.keys(baseline)) {
    const b = baseline[table];
    if (!isObj(b)) {
      violations.push(
        `[order-shape] table '${table}': baseline entry is not an object (got ${typeof b})`,
      );
      continue;
    }
    const cols = isObj(b.columns) ? Object.keys(b.columns) : [];
    const order = b.order;
    if (!Array.isArray(order)) {
      violations.push(
        `[order-shape] table '${table}': baseline records no "order" array (got ${typeof order}) ` +
          '— regenerate the baseline (ADR-0193 D2/D6); a table without a recorded order is ' +
          'silently exempt from [order-mismatch] and [order-append]',
      );
      continue;
    }
    const nonString = order.filter((c) => typeof c !== 'string');
    if (nonString.length > 0) {
      violations.push(
        `[order-shape] table '${table}': recorded order contains ${nonString.length} non-string ` +
          `entr(y|ies) — expected column names, got ${JSON.stringify(order)}`,
      );
      continue;
    }
    const dupes = order.filter((c, i) => order.indexOf(c) !== i);
    if (dupes.length > 0) {
      violations.push(
        `[order-shape] table '${table}': recorded order repeats column(s) ` +
          `${JSON.stringify([...new Set(dupes)])} — order must be a duplicate-free permutation ` +
          'of the recorded columns (a length-only check passes this)',
      );
      continue;
    }
    const missing = cols.filter((c) => !order.includes(c));
    const extra = order.filter((c) => !cols.includes(c));
    if (missing.length > 0 || extra.length > 0) {
      violations.push(
        `[order-shape] table '${table}': recorded order is not a permutation of the recorded ` +
          `columns — missing ${JSON.stringify(missing)}, unknown ${JSON.stringify(extra)}`,
      );
      continue;
    }

    const src = parsedOrder[table];
    if (src === undefined || src === null) continue; // absent from source: checkSchemaDrift's job
    if (!Array.isArray(src)) {
      violations.push(
        `[order-shape] table '${table}': parsed source order is not an array (got ${typeof src})`,
      );
      continue;
    }
    const srcNames = src.map(entryName).filter((n) => typeof n === 'string');
    const defaults = new Map();
    for (const f of src) {
      const n = entryName(f);
      if (typeof n === 'string' && !defaults.has(n)) {
        defaults.set(n, isObj(f) ? f.hasDefault : undefined);
      }
    }

    // [order-mismatch] — positional, over the columns the two sides SHARE.
    const known = new Set(order);
    const srcSet = new Set(srcNames);
    const filteredSrc = srcNames.filter((n) => known.has(n));
    const filteredOrder = order.filter((n) => srcSet.has(n));
    const shared = Math.min(filteredSrc.length, filteredOrder.length);
    for (let i = 0; i < shared; i++) {
      if (filteredSrc[i] !== filteredOrder[i]) {
        violations.push(
          `[order-mismatch] table '${table}': column '${filteredSrc[i]}' sits at source ` +
            `position ${i} but at baseline position ${filteredOrder.indexOf(filteredSrc[i])} ` +
            `(the baseline records '${filteredOrder[i]}' at position ${i}) — column position is ` +
            `persisted, ${AUTOMIGRATION_RULE}`,
        );
      }
    }

    // [order-append] — a source column the ledger does not know must sit after
    // EVERY ledger-known column and must carry a #[default(...)].
    let lastKnownIdx = -1;
    for (let i = 0; i < srcNames.length; i++) {
      if (known.has(srcNames[i])) lastKnownIdx = i;
    }
    for (let i = 0; i < srcNames.length; i++) {
      const nm = srcNames[i];
      if (known.has(nm)) continue;
      const reasons = [];
      if (i < lastKnownIdx) {
        reasons.push(
          `it sits at source position ${i}, before baseline-known column ` +
            `'${srcNames[lastKnownIdx]}' at position ${lastKnownIdx} (not a tail append)`,
        );
      }
      if (defaults.get(nm) !== true) {
        reasons.push('it carries no #[default(...)] attribute (the plain `#[default(` form)');
      }
      if (reasons.length > 0) {
        violations.push(
          `[order-append] table '${table}': new column '${nm}' — ${reasons.join('; ')}. ` +
            `${AUTOMIGRATION_RULE}`,
        );
      }
    }
  }
  return violations;
}

/**
 * [defaults-not-suffix]: within a baseline-KNOWN table, no non-defaulted column
 * may follow a defaulted one. Scoped to baseline-known tables (a brand-new
 * table has no live rows) and, per ADR-0193 D5, has NO exemption parameter.
 *
 * @param {{ [t: string]: { name: string, hasDefault: boolean }[] }} parsedOrder
 * @param {{ [t: string]: object }} baseline
 * @returns {string[]} [] = clean.
 */
function checkDefaultsSuffixCore(parsedOrder, baseline) {
  if (!isObj(parsedOrder) || !isObj(baseline)) {
    return [
      '[defaults-not-suffix] malformed input: checkDefaultsSuffix requires two non-null objects ' +
        `(got ${typeof parsedOrder}, ${typeof baseline})`,
    ];
  }
  const violations = [];
  for (const table of Object.keys(parsedOrder)) {
    if (!(table in baseline)) continue;
    const src = parsedOrder[table];
    if (src === undefined || src === null) continue;
    if (!Array.isArray(src)) {
      violations.push(
        `[defaults-not-suffix] table '${table}': parsed source order is not an array (got ` +
          `${typeof src})`,
      );
      continue;
    }
    let firstDefaulted = null;
    for (const f of src) {
      const nm = entryName(f);
      if (nm === undefined) continue;
      if (isObj(f) && f.hasDefault === true) {
        if (firstDefaulted === null) firstDefaulted = nm;
        continue;
      }
      if (firstDefaulted !== null) {
        violations.push(
          `[defaults-not-suffix] table '${table}': column '${nm}' has no #[default(...)] but ` +
            `follows defaulted column '${firstDefaulted}' — defaulted columns must be a SUFFIX ` +
            `of the struct (${AUTOMIGRATION_RULE}). ${DEFAULTS_ESCAPES}`,
        );
      }
    }
  }
  return violations;
}

/**
 * [append-only] — the re-baseline-proof rule (ADR-0193 D4). Compares the
 * PREVIOUSLY COMMITTED baseline against the working-tree one: each table's
 * previous `order` must be a positional PREFIX of the new one, every column
 * beyond that prefix must carry a #[default(...)] in source, and a table
 * present in prev and absent from next is a live-DB break.
 *
 * Pure; NEVER throws for any input.
 *
 * @param {{ [t: string]: { order?: string[] } }} prevBaseline
 * @param {{ [t: string]: { order?: string[] } }} nextBaseline
 * @param {{ [t: string]: { name: string, hasDefault: boolean }[] }} parsedOrder
 * @returns {string[]} [] = clean.
 */
function checkBaselineAppendOnlyCore(prevBaseline, nextBaseline, parsedOrder) {
  if (!isObj(prevBaseline) || !isObj(nextBaseline)) {
    return [
      '[append-only] malformed input: checkBaselineAppendOnly requires two non-null baseline ' +
        `objects (got ${typeof prevBaseline}, ${typeof nextBaseline})`,
    ];
  }
  const violations = [];
  for (const table of Object.keys(prevBaseline).sort()) {
    // Per-table findings are collected separately so the MANUAL_MIGRATION_KEY
    // escape (below) can suppress exactly this table's findings and nothing else.
    const found = [];
    const next = nextBaseline[table];
    const prev = prevBaseline[table];
    const marker = isObj(next) ? next[MANUAL_MIGRATION_KEY] : undefined;
    const escaped = typeof marker === 'string' && marker.indexOf('ADR-') !== -1;
    if (!(table in nextBaseline)) {
      found.push(
        `[append-only] table '${table}': present in the previously committed baseline and absent ` +
          'from the new one — a table drop is never accepted by automigration (ADR-0177 runbook)',
      );
    } else {
      const prevOrder = recordedOrder(prev);
      const nextOrder = recordedOrder(next);
      if (prevOrder === null || nextOrder === null) {
        found.push(
          `[append-only] table '${table}': malformed baseline entry — no recorded column order ` +
            `(prev=${prevOrder !== null}, next=${nextOrder !== null}); neither an "order" array ` +
            'nor a "columns" object, so the append-only comparison cannot run for this table',
        );
      } else if (
        prevOrder.some((c) => typeof c !== 'string') ||
        nextOrder.some((c) => typeof c !== 'string')
      ) {
        found.push(
          `[append-only] table '${table}': malformed baseline entry — the recorded column order ` +
            'contains non-string entries; the append-only comparison cannot run for this table',
        );
      } else {
        const dropped = prevOrder.filter((c) => !nextOrder.includes(c));
        if (dropped.length > 0) {
          found.push(
            `[append-only] table '${table}': column(s) ${JSON.stringify(dropped)} present in the ` +
              'previously committed baseline are gone — a column removal is never accepted by ' +
              'automigration; it needs the ADR-0177 delete-data runbook, recorded as a ' +
              `"${MANUAL_MIGRATION_KEY}" note on this table`,
          );
        }
        // Positional prefix over the columns that SURVIVED (a removal is already
        // reported above; without this filter one removal cascades into a
        // violation for every following column).
        const expected = prevOrder.filter((c) => nextOrder.includes(c));
        for (let i = 0; i < expected.length; i++) {
          if (nextOrder[i] !== expected[i]) {
            found.push(
              `[append-only] table '${table}': column at position ${i} changed from ` +
                `'${expected[i]}' (prev committed) to '${nextOrder[i]}' (new) — the previously ` +
                'committed order must be a positional PREFIX of the new one; re-baselining does ' +
                `not make a mid-struct insert or a reorder legal (${AUTOMIGRATION_RULE})`,
            );
            break; // one message per table: the first divergence names the defect
          }
        }
        // A persisted column's declared TYPE and the table's PK are as immutable
        // as its position — and `checkSchemaDrift` cannot see either of them once
        // the baseline has been regenerated (13r-d red-team F1).
        const prevCols = isObj(prev) && isObj(prev.columns) ? prev.columns : null;
        const nextCols = isObj(next) && isObj(next.columns) ? next.columns : null;
        if (prevCols !== null && nextCols !== null) {
          for (const c of expected) {
            if (c in prevCols && c in nextCols && prevCols[c] !== nextCols[c]) {
              found.push(
                `[append-only] table '${table}': column '${c}' changed type from ` +
                  `'${prevCols[c]}' (prev committed) to '${nextCols[c]}' (new) — modifying a ` +
                  'persisted column is never accepted by automigration (ADR-0177 runbook)',
              );
            }
          }
        }
        if (isObj(prev) && isObj(next) && prev.pk !== next.pk) {
          found.push(
            `[append-only] table '${table}': primary key changed from '${prev.pk}' (prev ` +
              `committed) to '${next.pk}' (new) — adding or moving a primary-key constraint is ` +
              'never accepted by automigration (ADR-0177 runbook)',
          );
        }
        const srcFields = isObj(parsedOrder) ? parsedOrder[table] : undefined;
        for (let i = expected.length; i < nextOrder.length; i++) {
          const nm = nextOrder[i];
          if (!Array.isArray(srcFields)) {
            found.push(
              `[append-only] table '${table}': appended column '${nm}' (position ${i}) cannot be ` +
                'checked for #[default(...)] — the table has no parsed source order ' +
                `(got ${typeof srcFields})`,
            );
            continue;
          }
          const hit = srcFields.find((f) => entryName(f) === nm);
          if (hit === undefined) {
            found.push(
              `[append-only] table '${table}': appended column '${nm}' (position ${i}) is not ` +
                'present in the parsed source order — cannot confirm it carries #[default(...)]',
            );
            continue;
          }
          if (!(isObj(hit) && hit.hasDefault === true)) {
            found.push(
              `[append-only] table '${table}': appended column '${nm}' (position ${i}) carries ` +
                `no #[default(...)] in source — ${AUTOMIGRATION_RULE}, so this append is ` +
                'rejected by the live publish',
            );
          }
        }
      }
    }

    // ADR-0193 D7 — the ONLY escape, and it is self-expiring. A live-DB change
    // that automigration rejects is legal exactly once: via the ADR-0177
    // delete-data runbook. Recording that on the table (a string naming the ADR)
    // suppresses this table's findings for the one commit that lands it. Once
    // merged, prev == next, there is nothing left to suppress, and the marker
    // must be removed — a stale marker is itself a violation, so the escape
    // cannot silently disarm the rule.
    if (escaped) {
      if (found.length === 0) {
        violations.push(
          `[append-only] table '${table}': stale "${MANUAL_MIGRATION_KEY}" marker — it suppresses ` +
            'nothing now that the migration has landed, and left in place it would hide the next ' +
            'illegal change. Remove it from the baseline entry',
        );
      }
      continue;
    }
    for (const v of found) violations.push(v);
  }
  return violations;
}

/**
 * [visibility-shape] + [visibility-drift] — ADR-0199 D4, checker A. One
 * function, two tags (the checkColumnOrderCore idiom, which already emits
 * three). Pure and git-INDEPENDENT: EARS 1/2 must hold even where the git layer
 * cannot resolve a previous baseline.
 *
 * [visibility-shape]: every baseline entry records `visibility` as exactly
 * 'public' or 'private' — a MISSING key is a violation, never a skip (the
 * empty-target blind spot: a `?? 'private'` default makes the rule vacuous on
 * exactly the entries that were never regenerated). A `visibility_note`, if
 * present, must be an ADR-anchored string and may appear ONLY on a public entry
 * (RT-2a: a note pre-armed on a still-private table would silently authorize a
 * later flip).
 *
 * [visibility-drift]: source-derived vs recorded, bidirectional over the UNION
 * of table names.
 *
 * @param {{ [t: string]: 'public'|'private' }} parsedVisibility
 * @param {{ [t: string]: object }} baseline
 * @returns {string[]} [] = clean.
 */
function checkVisibilityCore(parsedVisibility, baseline) {
  if (!isObj(parsedVisibility) || !isObj(baseline)) {
    return [
      '[visibility-shape] malformed input: checkVisibility requires two non-null objects (got ' +
        `${typeof parsedVisibility}, ${typeof baseline})`,
    ];
  }
  const violations = [];
  for (const table of Object.keys(baseline)) {
    const entry = baseline[table];
    if (!isObj(entry)) {
      violations.push(
        `[visibility-shape] table '${table}': baseline entry is not an object (got ` +
          `${typeof entry})`,
      );
      continue;
    }
    const recorded = entry[VISIBILITY_KEY];
    if (!VISIBILITY_VALUES.includes(recorded)) {
      violations.push(
        `[visibility-shape] table '${table}': baseline records "${VISIBILITY_KEY}": ` +
          `${JSON.stringify(recorded)} — every entry must record exactly 'public' or 'private' ` +
          '(ADR-0199 D3); regenerate with `node evals/battle-schema-snapshot.eval.mjs --write`. ' +
          'A missing or non-canonical value would exempt the table from [visibility-drift] and ' +
          '[visibility-escalation]',
      );
    }
    if (VISIBILITY_NOTE_KEY in entry) {
      const note = entry[VISIBILITY_NOTE_KEY];
      if (!isAnchoredNote(note)) {
        violations.push(
          `[visibility-shape] table '${table}': "${VISIBILITY_NOTE_KEY}" is ` +
            `${JSON.stringify(note)} — it must be a string BEGINNING with 'ADR-' followed by at ` +
            'least four digits (ADR-0199 D5); an unanchored marker authorizes nothing',
        );
      } else if (recorded !== 'public') {
        violations.push(
          `[visibility-shape] table '${table}': "${VISIBILITY_NOTE_KEY}" is present on a ` +
            `${JSON.stringify(recorded)} entry — the note justifies WORLD-READABILITY and may ` +
            'appear only on a public entry; a note pre-armed on a private table would silently ' +
            'authorize a later flip (ADR-0199 D5)',
        );
      }
    }
  }
  const allTables = new Set([...Object.keys(parsedVisibility), ...Object.keys(baseline)]);
  for (const table of allTables) {
    const derived = parsedVisibility[table];
    const entry = baseline[table];
    if (!(table in baseline)) {
      violations.push(
        `[visibility-drift] table '${table}': declared in source (${JSON.stringify(derived)}) but ` +
          'absent from the baseline — regenerate the baseline (ADR-0199 D8)',
      );
      continue;
    }
    if (!(table in parsedVisibility)) {
      violations.push(
        `[visibility-drift] table '${table}': recorded in the baseline but not declared in source ` +
          '— regenerate the baseline (ADR-0199 D8)',
      );
      continue;
    }
    const recorded = isObj(entry) ? entry[VISIBILITY_KEY] : undefined;
    // A malformed/absent recorded value is [visibility-shape]'s finding; comparing
    // it here as well would double-report the same defect.
    if (!VISIBILITY_VALUES.includes(recorded)) continue;
    if (derived !== recorded) {
      violations.push(
        `[visibility-drift] table '${table}': source declares ${JSON.stringify(derived)} but the ` +
          `baseline records ${JSON.stringify(recorded)} — the declared visibility changed and ` +
          'the baseline was not regenerated (`node evals/battle-schema-snapshot.eval.mjs ' +
          '--write`)',
      );
    }
  }
  return violations;
}

/**
 * [visibility-escalation] — ADR-0199 D4, checker B: the git-resolved layer that
 * survives the sanctioned FULL re-baseline. Fires when the working baseline
 * records a table `public` and the previously committed one either did not know
 * the table or recorded it `private`.
 *
 * The ONLY escape is a key the regenerator never writes: an ADR-anchored
 * `visibility_note` that is ABSENT-OR-DIFFERENT in prev, i.e. authored or
 * updated in THIS transition. A note identical on both sides is a pre-armed
 * marker and releases nothing (RT-2b).
 *
 * Bootstrap (D7): if NO entry in prev carries a `visibility` key at all, the
 * whole prev baseline predates the axis and escalation is skipped (the default
 * export reports the skipped count). If SOME entries carry it and this one does
 * not, that is a DELETED key — a tamper vector back into the skip path — and it
 * FAILS.
 *
 * @param {{ [t: string]: object }} prevBaseline
 * @param {{ [t: string]: object }} nextBaseline
 * @returns {string[]} [] = clean.
 */
function checkVisibilityEscalationCore(prevBaseline, nextBaseline) {
  if (!isObj(prevBaseline) || !isObj(nextBaseline)) {
    return [
      '[visibility-escalation] malformed input: checkVisibilityEscalation requires two non-null ' +
        `baseline objects (got ${typeof prevBaseline}, ${typeof nextBaseline})`,
    ];
  }
  const preAxis = !Object.keys(prevBaseline).some(
    (t) => isObj(prevBaseline[t]) && VISIBILITY_KEY in prevBaseline[t],
  );
  if (preAxis) return []; // ADR-0199 D7 bootstrap: a wholesale pre-axis prev baseline.
  const violations = [];
  for (const table of Object.keys(nextBaseline)) {
    const next = nextBaseline[table];
    if (!isObj(next)) continue; // shape is [visibility-shape]'s finding
    const prev = isObj(prevBaseline[table]) ? prevBaseline[table] : null;
    if (prev !== null && !(VISIBILITY_KEY in prev)) {
      violations.push(
        `[visibility-escalation] table '${table}': the previously committed baseline records no ` +
          `"${VISIBILITY_KEY}" key for this table while OTHER entries carry one — a deleted key ` +
          'is a tamper vector back into the ADR-0199 D7 bootstrap skip, so it fails rather than ' +
          'skipping. Restore the key by regenerating the previous baseline',
      );
      continue;
    }
    if (next[VISIBILITY_KEY] !== 'public') continue;
    // Absent from prev == a brand-new table, which gets the full rule: after the
    // mandated regeneration `checkSchemaDrift`'s "not in baseline" is empty by
    // construction, so this is the only rule that can see it.
    if (prev !== null && prev[VISIBILITY_KEY] !== 'private') continue;
    const note = next[VISIBILITY_NOTE_KEY];
    if (isAnchoredNote(note) && (prev === null || prev[VISIBILITY_NOTE_KEY] !== note)) continue;
    violations.push(
      `[visibility-escalation] table '${table}': recorded "public" in the new baseline but ` +
        `${prev === null ? 'absent from' : 'recorded "private" in'} the previously committed one ` +
        '— every connected client would receive every row. Regenerating the baseline does not ' +
        `make the flip legal; record the decision explicitly as "${VISIBILITY_NOTE_KEY}": ` +
        '"ADR-nnnn — why this table is world-readable" on this entry, authored in this change ' +
        "(a note identical to the previous baseline's releases nothing)",
    );
  }
  return violations;
}

// ---------------------------------------------------------------------------
// ADR-0193 D4 — previous-baseline resolution via git. I/O isolated from the
// pure checkers above. execFileSync('git', [constant args]) only (precedent:
// evals/spacetime-type-snapshot.eval.mjs, ADR-0116 D3) — NO shell strings.
// ---------------------------------------------------------------------------

const BASELINE_GIT_PATH = 'evals/baselines/table-schemas.json';

/** `git show <ref>:evals/baselines/table-schemas.json` parsed as JSON, or null. */
function gitShowBaselineJson(ref) {
  try {
    const out = execFileSync('git', ['show', `${ref}:${BASELINE_GIT_PATH}`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** Is this process running inside a git work tree at all? */
function insideGitWorkTree() {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the previously committed baseline (ADR-0116 D3 resolution order):
 *   (1) git merge-base HEAD origin/master -> git show <sha>:<baseline>
 *   (2) git show origin/master:<baseline>
 *   (3) give up -> { source: 'none', data: null }
 *
 * D3's third element matters as much as the first two: on a master-PUSH run the
 * merge-base IS HEAD, so the resolved baseline deep-equals the working one and
 * the comparison is vacuous. In that case validate the last TRANSITION instead
 * (HEAD~1 vs HEAD), which is exactly the change that just landed.
 */
function readPrevBaseline(workingBaseline) {
  const selfIdentical = (data) =>
    data !== null && JSON.stringify(data) === JSON.stringify(workingBaseline);
  const lastTransition = () => {
    const prior = gitShowBaselineJson('HEAD~1');
    return prior === null
      ? { source: 'none', data: null }
      : { source: 'HEAD~1 (self-compare would be vacuous)', data: prior };
  };
  try {
    const sha = execFileSync('git', ['merge-base', 'HEAD', 'origin/master'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (sha) {
      const data = gitShowBaselineJson(sha);
      if (selfIdentical(data)) return lastTransition();
      if (data !== null) return { source: `merge-base ${sha.slice(0, 7)}`, data };
    }
  } catch {
    // merge-base unavailable (no origin/master, shallow clone, no git) — fall through
  }
  const tip = gitShowBaselineJson('origin/master');
  if (selfIdentical(tip)) return lastTransition();
  if (tip !== null) return { source: 'origin/master', data: tip };
  return { source: 'none', data: null };
}

/**
 * Exact-match, bidirectional schema drift check.
 * Compares parsed table schemas against a baseline.
 * Scope = union of keys in both parsed and baseline.
 *
 * Returns [] iff the scoped schemas are identical.
 * Returns a list of human-readable drift descriptions otherwise.
 *
 * Handles sub-baseline calls (e.g. { inventory: baseline.inventory }) correctly:
 * the union approach means only the tables in scope are compared.
 *
 * @param {{ [tableName: string]: { pk: string|null, columns: { [field]: string } } }} parsed
 * @param {{ [tableName: string]: { pk: string|null, columns: { [field]: string } } }} baseline
 * @returns {string[]}
 */
export function checkSchemaDrift(parsed, baseline) {
  const drifts = [];

  // Union of all table names from both sides
  const allTables = new Set([...Object.keys(parsed), ...Object.keys(baseline)]);

  for (const tableName of allTables) {
    const inParsed = tableName in parsed;
    const inBaseline = tableName in baseline;

    if (inBaseline && !inParsed) {
      drifts.push(`table '${tableName}' missing from source (in baseline but not parsed)`);
      continue;
    }
    if (inParsed && !inBaseline) {
      drifts.push(
        `table '${tableName}' not in baseline / un-baselined (in parsed but not baseline)`,
      );
      continue;
    }

    // Both present — compare PK and columns
    const p = parsed[tableName];
    const b = baseline[tableName];

    // PK comparison
    if (p.pk !== b.pk) {
      drifts.push(
        `table '${tableName}': PK changed from '${b.pk}' (baseline) to '${p.pk}' (source)`,
      );
    }

    // Column comparison — bidirectional exact-match
    const parsedCols = p.columns || {};
    const baselineCols = b.columns || {};

    // Baseline-side: removal (col absent in parsed) OR type-change (present in
    // both but type differs).
    for (const col of Object.keys(baselineCols)) {
      if (!(col in parsedCols)) {
        drifts.push(`table '${tableName}': column '${col}' removed (in baseline, not in source)`);
      } else if (parsedCols[col] !== baselineCols[col]) {
        drifts.push(
          `table '${tableName}': column '${col}' type changed from '${baselineCols[col]}' (baseline) to '${parsedCols[col]}' (source)`,
        );
      }
    }

    // Parsed-side: addition (col absent in baseline).
    for (const col of Object.keys(parsedCols)) {
      if (!(col in baselineCols)) {
        drifts.push(`table '${tableName}': column '${col}' added (in source, not in baseline)`);
      }
    }
  }

  return drifts;
}

// ---------------------------------------------------------------------------
// ADR-0199 D8 — the regenerator, as a PURE function. `--write` (main guard at
// the end of this file) is a thin shell over it, and [baseline-stale]-style
// byte identity is provable because the checker and the generator are one
// function, not two (a generator/checker split is how a snapshot silently
// diverges from what the gate reads).
// ---------------------------------------------------------------------------

const VISIBILITY_ENTRY_KEYS = ['pk', VISIBILITY_KEY, VISIBILITY_NOTE_KEY, 'columns', 'order'];

/**
 * Render the baseline file text from the three projections plus the currently
 * committed baseline (the source of hand-authored keys).
 *
 * Top-level: the existing baseline's key order FIRST (never re-sorted), then
 * parsed-only tables appended at the END. Per entry: the canonical order
 * `pk, visibility, visibility_note?, columns, order`, then every OTHER
 * pre-existing key verbatim, after `order`, in its prior relative order —
 * without that canonicalisation a legitimate hand-added note would move on the
 * next regeneration and RED the byte-identity check for the wrong reason.
 *
 * @param {{ [t: string]: { pk: string|null, columns: object } }} schemas
 * @param {{ [t: string]: { name: string }[] }} order
 * @param {{ [t: string]: 'public'|'private' }} visibility
 * @param {{ [t: string]: object }} existingBaseline
 * @returns {string} The full file text, trailing newline included.
 */
export function formatBaseline(schemas, order, visibility, existingBaseline) {
  const src = isObj(schemas) ? schemas : {};
  const orders = isObj(order) ? order : {};
  const vis = isObj(visibility) ? visibility : {};
  const existing = isObj(existingBaseline) ? existingBaseline : {};
  const existingFirst = Object.keys(existing).filter((t) => t in src);
  const parsedOnly = Object.keys(src).filter((t) => !(t in existing));
  const out = {};
  for (const table of [...existingFirst, ...parsedOnly]) {
    const schema = isObj(src[table]) ? src[table] : {};
    const prior = isObj(existing[table]) ? existing[table] : {};
    const columns = isObj(schema.columns) ? schema.columns : {};
    const parsedNames = Array.isArray(orders[table])
      ? orders[table].map(entryName).filter((n) => typeof n === 'string')
      : Object.keys(columns);
    const entry = { pk: schema.pk ?? null, [VISIBILITY_KEY]: vis[table] };
    if (VISIBILITY_NOTE_KEY in prior) entry[VISIBILITY_NOTE_KEY] = prior[VISIBILITY_NOTE_KEY];
    entry.columns = columns;
    entry.order = parsedNames;
    for (const key of Object.keys(prior)) {
      if (VISIBILITY_ENTRY_KEYS.includes(key)) continue;
      entry[key] = prior[key];
    }
    out[table] = entry;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * The SSOT aggregation the real verdict block calls. Every rule this gate
 * enforces is reachable from HERE and nowhere else — a checker that exists but
 * is not wired in is a gate that reports green on the very change it was
 * written to catch (reviewer BLOCKER; tooth T-VIS-WIRED).
 *
 * @param {string} rawSrc Raw Rust source.
 * @param {{ [t: string]: object }} baseline Working-tree baseline.
 * @param {{ [t: string]: object }|null} prevData Git-resolved previous baseline.
 * @param {boolean} appendOnlyRan Did the git layer resolve a usable prevData?
 * @returns {string[]} [] = clean.
 */
export function computeViolations(rawSrc, baseline, prevData, appendOnlyRan) {
  const sourceOrder = parseTableColumnOrder(rawSrc);
  // ADR-0193 D5: [defaults-not-suffix] is scoped to tables that already EXIST in
  // the published schema, which only the previously committed baseline can express.
  const defaultsScope = appendOnlyRan ? prevData : baseline;
  const violations = [
    ...checkParseShape(rawSrc),
    ...checkColumnOrder(sourceOrder, baseline),
    ...checkDefaultsSuffix(sourceOrder, defaultsScope),
    // EARS 1/2 — git-INDEPENDENT, so deliberately NOT gated on appendOnlyRan.
    ...checkVisibility(parseTableVisibility(rawSrc), baseline),
  ];
  if (appendOnlyRan) {
    // Both git-resolved layers ride the same flag the ADR-0193 layer already uses.
    violations.push(...checkBaselineAppendOnly(prevData, baseline, sourceOrder));
    violations.push(...checkVisibilityEscalation(prevData, baseline));
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Default export — the eval runner calls this
// ---------------------------------------------------------------------------

export default async function () {
  const name = 'schema-snapshot (ALL tables: columns+PK+types, exact-match, ADR-0006)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth #1: a non-battle column DROP must be flagged.
  // (inventory.count removed — exercises bidirectional exact-match)
  // -------------------------------------------------------------------------
  const dropFixtureSrc = `
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    // count deliberately REMOVED
}
`;
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `cannot read baseline ${BASELINE_PATH}: ${e.message}`,
    };
  }

  const dropParsed = parseTableSchemas(dropFixtureSrc);
  const dropDrift = checkSchemaDrift(dropParsed, { inventory: baseline.inventory });
  if (!dropDrift || dropDrift.length === 0) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: column DROP on inventory.count was not flagged by checkSchemaDrift',
    };
  }

  // -------------------------------------------------------------------------
  // Proof-of-teeth #2: real source must pass (drift-free against baseline).
  // -------------------------------------------------------------------------
  let rawSrc;
  try {
    rawSrc = readServerModuleSources(SERVER_SRC);
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `cannot read ${SERVER_SRC}: ${e.message}`,
    };
  }

  const parsed = parseTableSchemas(rawSrc);
  const drift = checkSchemaDrift(parsed, baseline);
  if (drift.length > 0) {
    return {
      name,
      pass: false,
      detail: `real source drifts from baseline: ${drift.join('; ')}`,
    };
  }

  // ===========================================================================
  // ADR-0193 (13r-d) PROOF-OF-TEETH — column-ORDER awareness + re-baseline
  // proofing. `checkSchemaDrift` compares columns as an UNORDERED name->type
  // map, so a mid-struct insert PLUS the sanctioned full re-baseline is GREEN
  // today while live spacetime 2.6.0 rejects the publish. Everything below is
  // the gating suite for the five new pure checkers.
  //
  // These teeth are revised only FROM ADR-0193 — never to match an
  // implementation. Every assertion keys on the rule's bracket TAG.
  // ===========================================================================

  // Import guard (gate-teeth.eval.mjs precedent): a missing export must yield a
  // readable RED, never a stack trace. The self-import hits the ESM cache — the
  // module has finished evaluating by the time the runner calls this default.
  const selfMod = await import('./battle-schema-snapshot.eval.mjs').catch((e) => e);
  if (selfMod instanceof Error) {
    return {
      name,
      pass: false,
      detail: `RED: cannot self-import battle-schema-snapshot.eval.mjs — ${selfMod.message}`,
    };
  }
  const { parseTableColumnOrder, checkParseShape } = selfMod;
  const { checkColumnOrder, checkDefaultsSuffix, checkBaselineAppendOnly } = selfMod;
  // ADR-0199 (15r-sec-vis) — the visibility axis: a third projection over
  // parseTableFields, its low-level token helper, the two new checkers, and
  // the pure regenerator.
  const { parseTableVisibility, visibilityFromAttrArgs } = selfMod;
  const { checkVisibility, checkVisibilityEscalation, formatBaseline } = selfMod;
  // ADR-0199 — the WIRING contract. Reviewer BLOCKER: neither new checker was
  // reachable from the real verdict block, so a perfect implementation of both
  // could still ship a gate that never calls them. `computeViolations` is the
  // SSOT aggregation the default export's verdict block (below, ~:2650) MUST
  // call instead of inlining its own spread list, so this is the ONE place a
  // wiring regression can hide.
  //
  // computeViolations(rawSrc, baseline, prevData, appendOnlyRan) -> string[]
  //   - always: checkParseShape(rawSrc) + checkColumnOrder(sourceOrder, baseline)
  //     + checkDefaultsSuffix(sourceOrder, defaultsScope) violations, where
  //     sourceOrder = parseTableColumnOrder(rawSrc) and defaultsScope follows
  //     ADR-0193 D5 (prevData when appendOnlyRan, else baseline);
  //   - always: checkVisibility(parseTableVisibility(rawSrc), baseline)
  //     violations (EARS 1/2 — this one is UNCONDITIONAL, git-independent);
  //   - only when appendOnlyRan: checkBaselineAppendOnly(prevData, baseline,
  //     sourceOrder) AND checkVisibilityEscalation(prevData, baseline)
  //     violations (EARS 3 — both are git-resolved, so both are gated on the
  //     same appendOnlyRan flag the existing ADR-0193 layer already uses).
  const { computeViolations } = selfMod;
  for (const [fnName, fn] of [
    ['parseTableColumnOrder', parseTableColumnOrder],
    ['checkParseShape', checkParseShape],
    ['checkColumnOrder', checkColumnOrder],
    ['checkDefaultsSuffix', checkDefaultsSuffix],
    ['checkBaselineAppendOnly', checkBaselineAppendOnly],
    ['parseTableVisibility', parseTableVisibility],
    ['visibilityFromAttrArgs', visibilityFromAttrArgs],
    ['checkVisibility', checkVisibility],
    ['checkVisibilityEscalation', checkVisibilityEscalation],
    ['formatBaseline', formatBaseline],
    ['computeViolations', computeViolations],
  ]) {
    if (typeof fn !== 'function') {
      return {
        name,
        pass: false,
        detail:
          `RED: ${fnName} not exported from battle-schema-snapshot.eval.mjs ` +
          '(specialist has not implemented it yet)',
      };
    }
  }

  const teeth = [];
  const isArr = (r) => Array.isArray(r);
  const clean = (r) => isArr(r) && r.length === 0;
  const hasTag = (r, tag) => isArr(r) && r.some((s) => String(s).indexOf(tag) !== -1);
  const show = (r) => (isArr(r) ? JSON.stringify(r) : `NOT-AN-ARRAY(${typeof r})`);
  const colNames = (entries) => (isArr(entries) ? entries.map((f) => f?.name) : []);
  const defaultOf = (entries, col) => {
    const hit = isArr(entries) ? entries.find((f) => f && f.name === col) : undefined;
    return hit === undefined ? 'MISSING' : hit.hasDefault;
  };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // A FULL re-baseline, exactly as the sanctioned regeneration produces it:
  // columns AND order both re-derived from the (already edited) source.
  const rebaseline = (src) => {
    const cols = parseTableSchemas(src);
    const ord = parseTableColumnOrder(src);
    const out = {};
    for (const t of Object.keys(cols)) {
      out[t] = { pk: cols[t].pk, columns: cols[t].columns, order: colNames(ord[t]) };
    }
    return out;
  };

  // ADR-0199 — the same FULL re-baseline, plus the visibility axis. Mirrors
  // `formatBaseline`'s canonical key order (pk, visibility, columns, order) so
  // fixtures built with it look like real `--write` output.
  const rebaselineVis = (src) => {
    const cols = parseTableSchemas(src);
    const ord = parseTableColumnOrder(src);
    const vis = parseTableVisibility(src);
    const out = {};
    for (const t of Object.keys(cols)) {
      out[t] = {
        pk: cols[t].pk,
        visibility: vis[t],
        columns: cols[t].columns,
        order: colNames(ord[t]),
      };
    }
    return out;
  };

  // A baseline that knows no tables at all — the state a brand-new table is in.
  const PREV_BASELINE_EMPTY = {};

  // The pre-change committed baseline for `inventory` (4 columns, no defaults).
  const PREV_BASELINE = {
    inventory: {
      pk: 'inv_id',
      columns: { inv_id: 'u64', owner_identity: 'Identity', item_id: 'u32', count: 'u32' },
      order: ['inv_id', 'owner_identity', 'item_id', 'count'],
    },
  };

  // ADR-0199 — the same table, but the prev baseline ALREADY carries the
  // visibility axis and records it as 'private'. Used by every escalation
  // tooth that needs a non-bootstrap prev (some entry already carries the key).
  const PREV_BASELINE_VIS_PRIVATE = {
    inventory: {
      pk: 'inv_id',
      visibility: 'private',
      columns: PREV_BASELINE.inventory.columns,
      order: PREV_BASELINE.inventory.order,
    },
  };

  // -------------------------------------------------------------------------
  // T-MANDATE — the mandated tooth. A mid-struct insert WITH a default, plus a
  // FULL re-baseline. Kills: any gate that only diffs source-vs-working-tree
  // baseline (empty by construction after regeneration) and any order rule that
  // does not reach back to the previously committed baseline.
  // -------------------------------------------------------------------------
  const INSERT_SRC = `
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    #[default(0)]
    pub inserted: u32,
    pub item_id: u32,
    pub count: u32,
}
`;
  const insertParsed = parseTableSchemas(INSERT_SRC);
  const insertOrder = parseTableColumnOrder(INSERT_SRC);
  const insertRebased = rebaseline(INSERT_SRC);
  const insertNames = colNames(insertOrder.inventory);
  const wantInsertNames = ['inv_id', 'owner_identity', 'inserted', 'item_id', 'count'];
  if (!eq(insertNames, wantInsertNames)) {
    teeth.push(
      `T-MANDATE VACUOUS: parseTableColumnOrder(inventory) = ${JSON.stringify(insertNames)}, ` +
        `expected declaration order ${JSON.stringify(wantInsertNames)}`,
    );
  } else if (defaultOf(insertOrder.inventory, 'inserted') !== true) {
    teeth.push(
      "T-MANDATE VACUOUS: column 'inserted' carries #[default(0)] in the fixture but " +
        `hasDefault = ${JSON.stringify(defaultOf(insertOrder.inventory, 'inserted'))}`,
    );
  } else {
    // (a) The OLD gate is provably blind — this is the defect ADR-0193 closes.
    const blindDrift = checkSchemaDrift(insertParsed, insertRebased);
    if (!clean(blindDrift)) {
      teeth.push(
        `T-MANDATE(a): checkSchemaDrift was expected to be BLIND to the mid-struct insert ` +
          `after a full re-baseline (that blindness is the whole defect) but returned ` +
          `${show(blindDrift)} — the fixture or the drift contract changed; re-derive this ` +
          'tooth from ADR-0193',
      );
    }
    // (b) The in-tree order rules are ALSO blind after a full re-baseline
    // (ADR-0193 Context: "empty by construction"). Pinned so nobody claims the
    // in-tree layer alone closes the hole.
    const blindOrder = checkColumnOrder(insertOrder, insertRebased);
    if (!clean(blindOrder)) {
      teeth.push(
        `T-MANDATE(b): checkColumnOrder against a FULLY re-baselined baseline must be clean ` +
          `([order-mismatch] cannot fire — the recorded order was regenerated from this very ` +
          `source) but returned ${show(blindOrder)}`,
      );
    }
    // (c) THE BITE: prev-committed vs re-baselined, resolved by the git layer.
    const appendOnly = checkBaselineAppendOnly(PREV_BASELINE, insertRebased, insertOrder);
    if (!hasTag(appendOnly, '[append-only]')) {
      teeth.push(
        'T-MANDATE(c) FAILED: a mid-struct insert of `inserted` between owner_identity and ' +
          'item_id, followed by the sanctioned FULL re-baseline, was NOT flagged with ' +
          `[append-only] by checkBaselineAppendOnly — got ${show(appendOnly)}. This is the ` +
          'exact change live spacetime 2.6.0 rejects (reordering + non-tail position)',
      );
    } else if (!hasTag(appendOnly, 'inserted')) {
      teeth.push(
        'T-MANDATE(c): the [append-only] violation does not name the offending column ' +
          `'inserted' — got ${show(appendOnly)}; a message that cannot identify the column ` +
          'cannot be acted on',
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-B1 — an INDEPENDENT bite on the same fixture with no order/append
  // machinery at all. Kills: an implementation whose only order awareness is
  // the git layer (which is fail-open-loud and can be unavailable offline).
  // -------------------------------------------------------------------------
  if (colNames(insertOrder.inventory).length !== 5) {
    teeth.push(
      `T-B1 VACUOUS: expected 5 parsed columns on the insert fixture, got ` +
        `${colNames(insertOrder.inventory).length}`,
    );
  } else {
    const suffix = checkDefaultsSuffix(insertOrder, insertRebased);
    if (!hasTag(suffix, '[defaults-not-suffix]')) {
      teeth.push(
        'T-B1 FAILED: checkDefaultsSuffix did not flag [defaults-not-suffix] for a defaulted ' +
          "column ('inserted') followed by two non-defaulted columns (item_id, count) — got " +
          `${show(suffix)}. This rule needs NO baseline order and must bite on its own`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-NODEFAULT — a TAIL append with NO #[default(...)], on a table with no
  // other defaulted column, fully re-baselined. This is the exact class a
  // red-team prototype measured GREEN on 33 of 38 tables (ADR-0193 Context).
  // -------------------------------------------------------------------------
  const NODEFAULT_SRC = `
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    pub count: u32,
    pub tail_no_default: u32,
}
`;
  const noDefOrder = parseTableColumnOrder(NODEFAULT_SRC);
  const noDefRebased = rebaseline(NODEFAULT_SRC);
  const wantNoDefNames = ['inv_id', 'owner_identity', 'item_id', 'count', 'tail_no_default'];
  if (!eq(colNames(noDefOrder.inventory), wantNoDefNames)) {
    teeth.push(
      `T-NODEFAULT VACUOUS: order = ${JSON.stringify(colNames(noDefOrder.inventory))}, ` +
        `expected ${JSON.stringify(wantNoDefNames)}`,
    );
  } else if (defaultOf(noDefOrder.inventory, 'tail_no_default') !== false) {
    teeth.push(
      "T-NODEFAULT VACUOUS: 'tail_no_default' has no #[default( in the fixture but " +
        `hasDefault = ${JSON.stringify(defaultOf(noDefOrder.inventory, 'tail_no_default'))}`,
    );
  } else {
    const appendNoDef = checkBaselineAppendOnly(PREV_BASELINE, noDefRebased, noDefOrder);
    if (!hasTag(appendNoDef, '[append-only]')) {
      teeth.push(
        'T-NODEFAULT FAILED: a tail append WITHOUT #[default( — rejected by live automigration ' +
          `— was not flagged [append-only] after a full re-baseline; got ${show(appendNoDef)}`,
      );
    }
    // Proof that [append-only] is what bites here: the defaults-suffix rule is
    // vacuous on a table with zero defaulted columns (33/38 of the real corpus).
    const noDefSuffix = checkDefaultsSuffix(noDefOrder, noDefRebased);
    if (!clean(noDefSuffix)) {
      teeth.push(
        'T-NODEFAULT: checkDefaultsSuffix must be CLEAN on a table with no defaulted column ' +
          `(no non-defaulted column follows a defaulted one) but returned ${show(noDefSuffix)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-LEGAL — false-RED guard. A LEGAL tail append with a default must be
  // clean through ALL FIVE checkers, against BOTH the pre-change baseline and
  // the re-baselined one. Kills: a checker that fires on every diff.
  // -------------------------------------------------------------------------
  const LEGAL_SRC = `
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    pub count: u32,
    #[default(0)]
    pub appended: u32,
}
`;
  const legalParsed = parseTableSchemas(LEGAL_SRC);
  const legalOrder = parseTableColumnOrder(LEGAL_SRC);
  const legalRebased = rebaseline(LEGAL_SRC);
  const legalTables = Object.keys(legalParsed);
  const wantLegalNames = ['inv_id', 'owner_identity', 'item_id', 'count', 'appended'];
  if (legalTables.length !== 1 || legalTables[0] !== 'inventory') {
    teeth.push(
      `T-LEGAL VACUOUS: expected exactly 1 parsed table 'inventory', got ` +
        JSON.stringify(legalTables),
    );
  } else if (Object.keys(legalParsed.inventory.columns).length !== 5) {
    teeth.push(
      `T-LEGAL VACUOUS: expected 5 columns, got ` +
        JSON.stringify(Object.keys(legalParsed.inventory.columns)),
    );
  } else if (!eq(colNames(legalOrder.inventory), wantLegalNames)) {
    teeth.push(
      `T-LEGAL VACUOUS: order = ${JSON.stringify(colNames(legalOrder.inventory))}, expected ` +
        JSON.stringify(wantLegalNames),
    );
  } else if (defaultOf(legalOrder.inventory, 'appended') !== true) {
    teeth.push(
      "T-LEGAL VACUOUS: 'appended' carries #[default(0)] but hasDefault = " +
        JSON.stringify(defaultOf(legalOrder.inventory, 'appended')),
    );
  } else {
    const legalChecks = [
      ['checkParseShape', checkParseShape(LEGAL_SRC)],
      ['checkColumnOrder(re-baselined)', checkColumnOrder(legalOrder, legalRebased)],
      // [order-append]'s POSITIVE path: a source column absent from the recorded
      // order, sitting after every recorded column, carrying a default.
      ['checkColumnOrder(prev baseline)', checkColumnOrder(legalOrder, PREV_BASELINE)],
      ['checkDefaultsSuffix', checkDefaultsSuffix(legalOrder, legalRebased)],
      ['checkSchemaDrift', checkSchemaDrift(legalParsed, legalRebased)],
      ['checkBaselineAppendOnly', checkBaselineAppendOnly(PREV_BASELINE, legalRebased, legalOrder)],
    ];
    for (const [label, result] of legalChecks) {
      if (!clean(result)) {
        teeth.push(
          `T-LEGAL FALSE-RED: ${label} flagged a LEGAL tail append ` +
            `(#[default(0)] pub appended: u32 at the tail) — got ${show(result)}. Live ` +
            'automigration accepts exactly this shape; the gate must too',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // T-SWAP — two existing columns swapped. The name->type map is IDENTICAL, so
  // checkSchemaDrift is blind; only [order-mismatch] can see it.
  // -------------------------------------------------------------------------
  const SWAP_SRC = `
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub count: u32,
    pub item_id: u32,
}
`;
  const swapParsed = parseTableSchemas(SWAP_SRC);
  const swapOrder = parseTableColumnOrder(SWAP_SRC);
  const wantSwapNames = ['inv_id', 'owner_identity', 'count', 'item_id'];
  if (!eq(colNames(swapOrder.inventory), wantSwapNames)) {
    teeth.push(
      `T-SWAP VACUOUS: order = ${JSON.stringify(colNames(swapOrder.inventory))}, expected ` +
        JSON.stringify(wantSwapNames),
    );
  } else {
    const swapDrift = checkSchemaDrift(swapParsed, PREV_BASELINE);
    if (!clean(swapDrift)) {
      teeth.push(
        `T-SWAP: checkSchemaDrift must be blind to a pure swap (same names, same types) but ` +
          `returned ${show(swapDrift)} — the fixture drifted from the baseline entry`,
      );
    }
    const swapOrderResult = checkColumnOrder(swapOrder, PREV_BASELINE);
    if (!hasTag(swapOrderResult, '[order-mismatch]')) {
      teeth.push(
        'T-SWAP FAILED: item_id and count were swapped relative to the recorded order but ' +
          `checkColumnOrder did not report [order-mismatch] — got ${show(swapOrderResult)}. A ` +
          'set/sorted comparison of column names passes this fixture; only an element-wise ' +
          'positional comparison catches it',
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-APPEND — [order-append]'s TWO distinct failure modes, against a baseline
  // that was NOT regenerated (the only state in which a source column can be
  // absent from the recorded order at all). Every OTHER checkColumnOrder tooth
  // either asserts the result is CLEAN (T-MANDATE(b), T-LEGAL, T-REAL) or keys
  // on [order-mismatch]/[order-shape], so deleting the whole [order-append]
  // branch — one of ADR-0193 D3's six rules — survives all of them.
  // (a) kills a rule that only checks POSITION (the tail append with no
  // default is at the tail); (b) kills one that only checks the DEFAULT (the
  // mid-struct insert carries one).
  // -------------------------------------------------------------------------
  const appendCases = [
    ['tail append with NO #[default(', noDefOrder, wantNoDefNames, 'tail_no_default', false],
    ['mid-struct insert (not a tail append)', insertOrder, wantInsertNames, 'inserted', true],
  ];
  for (const [label, order, wantNames, col, wantDefault] of appendCases) {
    const gotNames = colNames(order.inventory);
    if (!eq(gotNames, wantNames) || defaultOf(order.inventory, col) !== wantDefault) {
      teeth.push(
        `T-APPEND VACUOUS (${label}): parsed order ${JSON.stringify(gotNames)} with hasDefault ` +
          `${JSON.stringify(defaultOf(order.inventory, col))} for '${col}', expected ` +
          `${JSON.stringify(wantNames)} with ${wantDefault}`,
      );
      continue;
    }
    const appendResult = checkColumnOrder(order, PREV_BASELINE);
    if (!hasTag(appendResult, '[order-append]')) {
      teeth.push(
        `T-APPEND FAILED (${label}): '${col}' is present in source and absent from the recorded ` +
          `order, but checkColumnOrder reported no [order-append] — got ${show(appendResult)}. ` +
          AUTOMIGRATION_RULE,
      );
    } else if (!hasTag(appendResult, col)) {
      teeth.push(
        `T-APPEND (${label}): the [order-append] violation does not name the offending column ` +
          `'${col}' — got ${show(appendResult)}; a message that cannot identify the column ` +
          'cannot be acted on',
      );
    }
  }

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // T-LAUNDER — the same laundering attack as T-MANDATE, on the TYPE and PK
  // axes. A retype or a PK move at a persisted position is rejected by live
  // spacetime exactly like a reorder; `checkSchemaDrift` cannot see either once
  // the baseline has been regenerated. Kills a checkBaselineAppendOnly that
  // compares column NAMES only.
  // -------------------------------------------------------------------------
  const retypedBaseline = {
    inventory: {
      pk: 'inv_id',
      columns: { inv_id: 'u64', owner_identity: 'Identity', item_id: 'u64', count: 'u32' },
      order: ['inv_id', 'owner_identity', 'item_id', 'count'],
    },
  };
  const retypeDrift = checkSchemaDrift(
    { inventory: { pk: 'inv_id', columns: retypedBaseline.inventory.columns } },
    retypedBaseline,
  );
  if (!clean(retypeDrift)) {
    teeth.push(
      `T-LAUNDER VACUOUS: the re-baselined map must be self-consistent, got ${show(retypeDrift)}`,
    );
  } else {
    const retyped = checkBaselineAppendOnly(PREV_BASELINE, retypedBaseline, {
      inventory: colNames(PREV_BASELINE.inventory.order).map((n) => ({ name: n })),
    });
    if (!hasTag(retyped, '[append-only]') || !hasTag(retyped, 'item_id')) {
      teeth.push(
        'T-LAUNDER(a) FAILED: inventory.item_id retyped u32 -> u64 at a persisted position, ' +
          `then fully re-baselined, was not flagged [append-only] naming the column — got ${show(retyped)}`,
      );
    }
    const pkMoved = {
      inventory: {
        pk: 'owner_identity',
        columns: PREV_BASELINE.inventory.columns,
        order: PREV_BASELINE.inventory.order,
      },
    };
    const pkResult = checkBaselineAppendOnly(PREV_BASELINE, pkMoved, {});
    if (!hasTag(pkResult, '[append-only]')) {
      teeth.push(
        `T-LAUNDER(b) FAILED: the primary key moved from inv_id to owner_identity across a ` +
          `re-baseline and was not flagged [append-only] — got ${show(pkResult)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-SWAP-REBASED — a pure REORDER (no column added or removed) survives a full
  // re-baseline. Kills a checkBaselineAppendOnly that only compares the last
  // prefix position or the column count.
  // -------------------------------------------------------------------------
  const swapRebased = rebaseline(SWAP_SRC);
  const swapAppendOnly = checkBaselineAppendOnly(PREV_BASELINE, swapRebased, swapOrder);
  if (!hasTag(swapAppendOnly, '[append-only]')) {
    teeth.push(
      'T-SWAP-REBASED FAILED: item_id and count swapped and then FULLY re-baselined (same ' +
        'column set, same count, same types) was not flagged [append-only] — got ' +
        `${show(swapAppendOnly)}. A length-preserving reorder is a live-DB rejection`,
    );
  }

  // -------------------------------------------------------------------------
  // T-B1-INTERIOR — a non-defaulted column BETWEEN two defaulted ones. Kills a
  // checkDefaultsSuffix that only inspects the last column.
  // -------------------------------------------------------------------------
  const INTERIOR_SRC = `
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    pub inv_id: u64,
    #[default(0)]
    pub a: u32,
    pub gap: u32,
    #[default(0)]
    pub z: u32,
}
`;
  const interiorOrder = parseTableColumnOrder(INTERIOR_SRC);
  const wantInterior = ['inv_id', 'a', 'gap', 'z'];
  if (!eq(colNames(interiorOrder.inventory), wantInterior)) {
    teeth.push(
      `T-B1-INTERIOR VACUOUS: order = ${JSON.stringify(colNames(interiorOrder.inventory))}`,
    );
  } else {
    const interior = checkDefaultsSuffix(interiorOrder, rebaseline(INTERIOR_SRC));
    if (!hasTag(interior, '[defaults-not-suffix]') || !hasTag(interior, 'gap')) {
      teeth.push(
        "T-B1-INTERIOR FAILED: a non-defaulted column ('gap') declared BETWEEN two defaulted " +
          `columns was not flagged naming it — got ${show(interior)}. An implementation that ` +
          'only inspects the LAST column passes without this tooth',
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-ESCAPE — the ADR-0193 D7 manual-migration escape must (a) suppress the
  // findings of the ONE table it names when the ADR-0177 runbook is recorded,
  // and (b) be self-expiring: a marker with nothing left to suppress is itself
  // a violation, so it can never silently disarm the rule.
  // -------------------------------------------------------------------------
  const removedCol = {
    inventory: {
      pk: 'inv_id',
      columns: { inv_id: 'u64', owner_identity: 'Identity', item_id: 'u32' },
      order: ['inv_id', 'owner_identity', 'item_id'],
    },
  };
  if (!hasTag(checkBaselineAppendOnly(PREV_BASELINE, removedCol, {}), '[append-only]')) {
    teeth.push('T-ESCAPE VACUOUS: the un-escaped column removal must be flagged first');
  } else {
    const escaped = {
      inventory: { ...removedCol.inventory, manual_migration: 'ADR-0177 delete-data runbook' },
    };
    const escapedResult = checkBaselineAppendOnly(PREV_BASELINE, escaped, {});
    if (!clean(escapedResult)) {
      teeth.push(
        'T-ESCAPE(a) FAILED: a removal recorded with a manual_migration note naming an ADR must ' +
          `be accepted for that table — got ${show(escapedResult)}`,
      );
    }
    const stale = {
      inventory: { ...PREV_BASELINE.inventory, manual_migration: 'ADR-0177 delete-data runbook' },
    };
    const staleResult = checkBaselineAppendOnly(PREV_BASELINE, stale, {});
    if (!hasTag(staleResult, '[append-only]') || !hasTag(staleResult, 'stale')) {
      teeth.push(
        'T-ESCAPE(b) FAILED: a manual_migration marker left behind once the migration has landed ' +
          `(nothing to suppress) must be flagged as STALE — got ${show(staleResult)}. An escape ` +
          'that outlives its migration silently disarms the rule for that table',
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-NEWTABLE — ADR-0193 D5: a brand-new table cannot break a migration, so
  // [defaults-not-suffix] must NOT fire for a table absent from the (previously
  // committed) baseline. Kills a rule scoped to the regenerated working baseline,
  // which false-REDs every new table the next slice adds.
  // -------------------------------------------------------------------------
  const newTableOrder = parseTableColumnOrder(INTERIOR_SRC);
  const newTableResult = checkDefaultsSuffix(newTableOrder, PREV_BASELINE_EMPTY);
  if (!clean(newTableResult)) {
    teeth.push(
      'T-NEWTABLE FAILED: [defaults-not-suffix] fired for a table that is NOT in the baseline ' +
        `— got ${show(newTableResult)}. ADR-0193 D5 scopes the rule to already-published tables`,
    );
  }

  // T-SHAPE — the recorded `order` itself must be well-formed. Sub-case (c),
  // a RIGHT-LENGTH array with a duplicate, kills a length-only permutation
  // check; (a) kills "absent order == nothing to check" (vacuous green).
  // -------------------------------------------------------------------------
  const baseOrder = parseTableColumnOrder(dropFixtureSrc); // inv_id, owner_identity, item_id
  const DUP_SRC = `
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    pub inv_id: u64,
    pub item_id: u32,
    pub count: u32,
}
`;
  const dupOrder = parseTableColumnOrder(DUP_SRC);
  const shapeCases = [
    [
      'order key ABSENT',
      baseOrder,
      { inventory: { pk: 'inv_id', columns: PREV_BASELINE.inventory.columns } },
    ],
    [
      'order MISSING a column that is in columns',
      baseOrder,
      {
        inventory: {
          pk: 'inv_id',
          columns: PREV_BASELINE.inventory.columns,
          order: ['inv_id', 'owner_identity', 'item_id'],
        },
      },
    ],
    [
      'order of the RIGHT LENGTH with a DUPLICATE entry',
      dupOrder,
      {
        inventory: {
          pk: 'inv_id',
          columns: { inv_id: 'u64', item_id: 'u32', count: 'u32' },
          order: ['inv_id', 'item_id', 'item_id'],
        },
      },
    ],
  ];
  for (const [label, order, bl] of shapeCases) {
    const result = checkColumnOrder(order, bl);
    if (!hasTag(result, '[order-shape]')) {
      teeth.push(
        `T-SHAPE FAILED (${label}): checkColumnOrder did not report [order-shape] — got ` +
          `${show(result)}. A baseline whose recorded order is not a duplicate-free ` +
          'permutation of its own columns must fail LOUD, never be silently skipped',
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-REMOVE — automigration never accepts a column or table removal.
  // -------------------------------------------------------------------------
  const dropRebased = rebaseline(dropFixtureSrc); // inventory minus `count`
  const removeCol = checkBaselineAppendOnly(PREV_BASELINE, dropRebased, baseOrder);
  if (!hasTag(removeCol, '[append-only]')) {
    teeth.push(
      "T-REMOVE(a) FAILED: column 'count' present in the prev committed baseline and dropped " +
        `from the next baseline was not flagged [append-only] — got ${show(removeCol)}`,
    );
  }
  const baseSrcOrder = parseTableColumnOrder(`
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    pub count: u32,
}
`);
  const prevWithGhost = {
    inventory: PREV_BASELINE.inventory,
    ghost_table: { pk: 'g_id', columns: { g_id: 'u64' }, order: ['g_id'] },
  };
  const removeTable = checkBaselineAppendOnly(
    prevWithGhost,
    { inventory: PREV_BASELINE.inventory },
    baseSrcOrder,
  );
  if (!hasTag(removeTable, '[append-only]')) {
    teeth.push(
      "T-REMOVE(b) FAILED: table 'ghost_table' present in the prev committed baseline and " +
        `absent from the next baseline was not flagged [append-only] — got ${show(removeTable)}`,
    );
  }

  // -------------------------------------------------------------------------
  // T-PARSE — a table body line the parser cannot classify is a SILENT column.
  // Both fixtures are invisible to the current parser: (a) drops a private
  // field, (b) treats `#[default(0)] pub sneaky: u32,` as a bare attribute.
  // -------------------------------------------------------------------------
  const RAW_LINE_SRC = `
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    pub inv_id: u64,
    item_id: u32,
    pub count: u32,
}
`;
  const ONE_LINE_SRC = `
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    pub inv_id: u64,
    #[default(0)] pub sneaky: u32,
}
`;
  for (const [label, src] of [
    ['unparsable body line (`item_id: u32,` — no `pub`)', RAW_LINE_SRC],
    ['attribute AND field on ONE line (`#[default(0)] pub sneaky: u32,`)', ONE_LINE_SRC],
  ]) {
    if (!('inventory' in parseTableSchemas(src))) {
      teeth.push(`T-PARSE VACUOUS (${label}): the fixture's table did not parse at all`);
      continue;
    }
    const result = checkParseShape(src);
    if (!hasTag(result, '[parse-shape]')) {
      teeth.push(
        `T-PARSE FAILED (${label}): checkParseShape did not report [parse-shape] — got ` +
          `${show(result)}. The column is invisible to the snapshot, so every downstream ` +
          'order/default rule is vacuous on it',
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-PARSE(c) — TWO `pub` fields on ONE line. Unlike the two fixtures above,
  // this line DOES match the field pattern: the second field is swallowed into
  // the first one's TYPE, so the unparsable-line branch stays silent, the table
  // count is right, and the second column is invisible to the snapshot (the
  // non-vacuity assertion below proves that blindness). Kills a [parse-shape]
  // that ships only the attribute-and-field and unparsable-line branches and
  // drops the per-line `pub <ident>:` COUNT (ADR-0193 D3 lists two fields per
  // line as a distinct kill).
  // -------------------------------------------------------------------------
  const TWO_FIELD_SRC = `
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    pub inv_id: u64,
    pub item_id: u32, pub count: u32,
}
`;
  const twoFieldEntry = parseTableSchemas(TWO_FIELD_SRC).inventory;
  const twoFieldTypes = isObj(twoFieldEntry) ? twoFieldEntry.columns : null;
  const twoFieldCols = isObj(twoFieldTypes) ? Object.keys(twoFieldTypes) : [];
  if (!eq(twoFieldCols, ['inv_id', 'item_id'])) {
    teeth.push(
      'T-PARSE(c) VACUOUS: the two-fields-on-one-line fixture was expected to parse to exactly ' +
        "['inv_id','item_id'] with 'count' INVISIBLE, but parsed to " +
        `${JSON.stringify(twoFieldCols)} — the parser changed; re-derive this tooth from ` +
        'ADR-0193 D3',
    );
  } else {
    const twoFieldShape = checkParseShape(TWO_FIELD_SRC);
    if (!hasTag(twoFieldShape, '[parse-shape]')) {
      teeth.push(
        'T-PARSE(c) FAILED: `pub item_id: u32, pub count: u32,` on ONE line hides the `count` ' +
          "column from the snapshot (it is parsed as part of item_id's type) but " +
          `checkParseShape did not report [parse-shape] — got ${show(twoFieldShape)}. The field ` +
          'pattern MATCHES this line and the table count is unchanged, so only a per-line ' +
          '`pub <ident>:` count can see it',
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-COUNT — a `]` inside the table attribute defeats the table regex and the
  // whole table VANISHES from the parse. Silent blindness must become loud.
  // (If a future parser learns this attribute shape, revise this tooth from
  // ADR-0193 D3 — do not delete it.)
  // -------------------------------------------------------------------------
  const HIDDEN_TABLE_SRC = `
#[spacetimedb::table(accessor = alpha_beta, public, index(btree, accessor = ab, columns = [alpha, beta]))]
pub struct AlphaBeta {
    #[primary_key]
    pub alpha: u32,
    pub beta: u32,
}
`;
  const hiddenCount = Object.keys(parseTableSchemas(HIDDEN_TABLE_SRC)).length;
  const hiddenResult = checkParseShape(HIDDEN_TABLE_SRC);
  if (!hasTag(hiddenResult, '[table-count]')) {
    teeth.push(
      'T-COUNT FAILED: a table attribute carrying `columns = [alpha, beta]` parsed to ' +
        `${hiddenCount} table(s) while the source declares 1 #[spacetimedb::table(accessor ` +
        `attribute, and checkParseShape did not report [table-count] — got ` +
        `${show(hiddenResult)}. An unparsed table is exempt from every other rule here`,
    );
  }

  // -------------------------------------------------------------------------
  // T-IDEMPOTENT — kills a module-level /g regex whose lastIndex survives the
  // call (the second call then returns fewer tables, silently exempting them).
  // -------------------------------------------------------------------------
  const TWO_TABLE_SRC = `${LEGAL_SRC}
#[spacetimedb::table(accessor = party_slot, public)]
pub struct PartySlot {
    #[primary_key]
    pub slot_id: u64,
    pub monster_id: u64,
}
`;
  const orderA = parseTableColumnOrder(TWO_TABLE_SRC);
  const orderB = parseTableColumnOrder(TWO_TABLE_SRC);
  const schemaA = parseTableSchemas(TWO_TABLE_SRC);
  const schemaB = parseTableSchemas(TWO_TABLE_SRC);
  if (Object.keys(orderA).length !== 2 || Object.keys(schemaA).length !== 2) {
    teeth.push(
      'T-IDEMPOTENT VACUOUS: the two-table fixture parsed to ' +
        `${Object.keys(orderA).length} order entries / ${Object.keys(schemaA).length} schema ` +
        'entries on the FIRST call, expected 2 and 2',
    );
  }
  if (!eq(orderA, orderB)) {
    teeth.push(
      'T-IDEMPOTENT FAILED: parseTableColumnOrder returned different results on two identical ' +
        `calls — first ${JSON.stringify(orderA)}, second ${JSON.stringify(orderB)} (a shared ` +
        '/g regex leaking lastIndex across calls)',
    );
  }
  if (!eq(schemaA, schemaB)) {
    teeth.push(
      'T-IDEMPOTENT FAILED: parseTableSchemas returned different results on two identical ' +
        `calls — first ${JSON.stringify(schemaA)}, second ${JSON.stringify(schemaB)}`,
    );
  }

  // ===========================================================================
  // ADR-0199 (15r-sec-vis) PROOF-OF-TEETH — declared table visibility as a
  // gated axis of the schema snapshot. `checkSchemaDrift`/`checkColumnOrder`/
  // etc. never look at `public`/`private` at all, so a table flip is silently
  // GREEN through every rule above — including after the sanctioned FULL
  // re-baseline (the exact laundering shape ADR-0193's own Context describes).
  // Everything below gates the two new pure checkers + the regenerator.
  //
  // These teeth are revised only FROM ADR-0199 — never to match an
  // implementation. Every assertion keys on the rule's bracket TAG and, where
  // a table is involved, the table NAME.
  // ===========================================================================

  // -------------------------------------------------------------------------
  // T-VIS-SHAPE — four malformed baselines. Kills: a checkVisibility that
  // treats a missing `visibility` key as an implicit default (e.g. `?? 'private'`
  // — the fail-secure default `scripts/okf-export.mjs` uses for its OWN,
  // non-gating purpose) instead of failing loud — the empty-target blind spot.
  // -------------------------------------------------------------------------
  const visShapeCases = [
    [
      'visibility key ABSENT',
      {
        pk: 'inv_id',
        columns: PREV_BASELINE.inventory.columns,
        order: PREV_BASELINE.inventory.order,
      },
    ],
    [
      'visibility "Public" (wrong case)',
      {
        pk: 'inv_id',
        visibility: 'Public',
        columns: PREV_BASELINE.inventory.columns,
        order: PREV_BASELINE.inventory.order,
      },
    ],
    [
      'visibility true (not a string)',
      {
        pk: 'inv_id',
        visibility: true,
        columns: PREV_BASELINE.inventory.columns,
        order: PREV_BASELINE.inventory.order,
      },
    ],
    [
      'visibility "" (empty string)',
      {
        pk: 'inv_id',
        visibility: '',
        columns: PREV_BASELINE.inventory.columns,
        order: PREV_BASELINE.inventory.order,
      },
    ],
  ];
  for (const [label, entry] of visShapeCases) {
    const result = checkVisibility({ inventory: 'private' }, { inventory: entry });
    if (!hasTag(result, '[visibility-shape]') || !hasTag(result, 'inventory')) {
      teeth.push(
        `T-VIS-SHAPE FAILED (${label}): checkVisibility did not report [visibility-shape] naming ` +
          `'inventory' — got ${show(result)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-VIS-NOTE — the escape marker's shape. Kills: (a)/(b) an unanchored
  // `marker.indexOf('ADR-') !== -1` escape — RT-1, empirically demonstrated
  // against the PRE-EXISTING `manual_migration` escape at :497-498, which this
  // slice deliberately does NOT fix (a different rule, out of EARS scope) but
  // whose degenerate shape `visibility_note` must not repeat; (c) an anchor
  // that only requires `ADR-\d{4,}` to appear SOMEWHERE rather than at
  // position 0; (d) a note pre-armed on a still-private entry — RT-2a.
  // -------------------------------------------------------------------------
  const visNoteCases = [
    ['note "ADR-" — no digits, on a PUBLIC entry', 'public', 'ADR-', false],
    [
      'note substring cheat "trust me ADR- not a real adr", on a PUBLIC entry',
      'public',
      'trust me ADR- not a real adr',
      false,
    ],
    [
      'note "see ADR-0199" — matches but NOT at position 0, on a PUBLIC entry',
      'public',
      'see ADR-0199',
      false,
    ],
    ['note present on a PRIVATE entry (pre-arming)', 'private', 'ADR-0199 — pre-armed', false],
    [
      'note "ADR-0199 — world-readable because …" on a PUBLIC entry',
      'public',
      'ADR-0199 — world-readable because …',
      true,
    ],
    // Reviewer MAJOR: the digit-count / position-0 boundary was untested — a
    // `\d{3,}` implementation and a fixed `\d{4}$` implementation both passed
    // every case above. Kills either, plus a `.trim()` before the anchor check.
    [
      'note "ADR-123 too short" — only 3 digits, on a PUBLIC entry',
      'public',
      'ADR-123 too short',
      false,
    ],
    [
      'note "ADR-12345 five digits" — 5 digits clears the >=4 minimum, on a PUBLIC entry',
      'public',
      'ADR-12345 five digits',
      true,
    ],
    [
      'note " ADR-0199 leading space" — anchor is position 0, not position 0 after trim, on a PUBLIC entry',
      'public',
      ' ADR-0199 leading space',
      false,
    ],
    // Reviewer MINOR: visibility_note is never fed a non-string. Kills an
    // impl doing `String(note).startsWith('ADR-')` instead of
    // `typeof note === 'string' && ...`.
    ['note is 42 (not a string), on a PUBLIC entry', 'public', 42, false],
    ['note is {} (not a string), on a PUBLIC entry', 'public', {}, false],
  ];
  for (const [label, vis, note, wantClean] of visNoteCases) {
    const bl = {
      inventory: {
        pk: 'inv_id',
        visibility: vis,
        visibility_note: note,
        columns: PREV_BASELINE.inventory.columns,
        order: PREV_BASELINE.inventory.order,
      },
    };
    const result = checkVisibility({ inventory: vis }, bl);
    if (wantClean) {
      if (!clean(result)) {
        teeth.push(
          `T-VIS-NOTE FALSE-RED (${label}): expected checkVisibility to be clean, got ${show(result)}`,
        );
      }
    } else if (!hasTag(result, '[visibility-shape]') || !hasTag(result, 'inventory')) {
      teeth.push(
        `T-VIS-NOTE FAILED (${label}): checkVisibility did not report [visibility-shape] naming ` +
          `'inventory' — got ${show(result)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-VIS-DRIFT — source says one thing, baseline records the other, in BOTH
  // directions. Pre-asserts `checkSchemaDrift` is CLEAN on the identical pair
  // (the file's own T-MANDATE/T-LAUNDER triple-assertion idiom) — proving the
  // bite is a NEW axis, not a pre-existing column/PK rule. Kills: a
  // checkVisibility that validates baseline SHAPE but never re-derives
  // visibility from source at all.
  // -------------------------------------------------------------------------
  const FLIP_TO_PRIVATE_SRC = `
#[spacetimedb::table(accessor = inventory)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    pub count: u32,
}
`;
  const FLIP_TO_PUBLIC_SRC = `
#[spacetimedb::table(accessor = inventory, public)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    pub count: u32,
}
`;
  const flipToPrivateVis = parseTableVisibility(FLIP_TO_PRIVATE_SRC);
  const flipToPublicVis = parseTableVisibility(FLIP_TO_PUBLIC_SRC);
  if (flipToPrivateVis.inventory !== 'private' || flipToPublicVis.inventory !== 'public') {
    teeth.push(
      `T-VIS-DRIFT VACUOUS: expected the two flip fixtures to derive private/public respectively, ` +
        `got ${JSON.stringify(flipToPrivateVis.inventory)}/${JSON.stringify(flipToPublicVis.inventory)}`,
    );
  } else {
    const baselineStillPublic = {
      inventory: {
        pk: 'inv_id',
        visibility: 'public',
        columns: PREV_BASELINE.inventory.columns,
        order: PREV_BASELINE.inventory.order,
      },
    };
    const baselineStillPrivate = {
      inventory: {
        pk: 'inv_id',
        visibility: 'private',
        columns: PREV_BASELINE.inventory.columns,
        order: PREV_BASELINE.inventory.order,
      },
    };
    const preDriftA = checkSchemaDrift(parseTableSchemas(FLIP_TO_PRIVATE_SRC), baselineStillPublic);
    if (!clean(preDriftA)) {
      teeth.push(
        `T-VIS-DRIFT VACUOUS (public->private): checkSchemaDrift must be clean on this pair — got ` +
          `${show(preDriftA)}`,
      );
    } else {
      const driftA = checkVisibility(flipToPrivateVis, baselineStillPublic);
      if (!hasTag(driftA, '[visibility-drift]') || !hasTag(driftA, 'inventory')) {
        teeth.push(
          `T-VIS-DRIFT FAILED (public->private): source declares inventory PRIVATE (no ` +
            `'public' token) but the baseline still records "public" — checkSchemaDrift is CLEAN ` +
            `on the identical pair, yet checkVisibility did not report [visibility-drift] naming ` +
            `'inventory' — got ${show(driftA)}`,
        );
      }
    }
    const preDriftB = checkSchemaDrift(parseTableSchemas(FLIP_TO_PUBLIC_SRC), baselineStillPrivate);
    if (!clean(preDriftB)) {
      teeth.push(
        `T-VIS-DRIFT VACUOUS (private->public): checkSchemaDrift must be clean on this pair — got ` +
          `${show(preDriftB)}`,
      );
    } else {
      const driftB = checkVisibility(flipToPublicVis, baselineStillPrivate);
      if (!hasTag(driftB, '[visibility-drift]') || !hasTag(driftB, 'inventory')) {
        teeth.push(
          `T-VIS-DRIFT FAILED (private->public): source declares inventory PUBLIC but the ` +
            `baseline still records "private" — checkSchemaDrift is CLEAN on the identical pair, ` +
            `yet checkVisibility did not report [visibility-drift] naming 'inventory' — got ` +
            `${show(driftB)}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // T-VIS-LAUNDER — the flip PLUS a full re-baseline (the sanctioned
  // regeneration). Kills: an escalation checker that only compares against
  // the WORKING baseline (empty by construction after regeneration, exactly
  // ADR-0193's own laundering argument) instead of the previously COMMITTED
  // one — the whole point of the git layer.
  // -------------------------------------------------------------------------
  const launderVis = parseTableVisibility(FLIP_TO_PUBLIC_SRC);
  const launderRebased = rebaselineVis(FLIP_TO_PUBLIC_SRC);
  if (launderVis.inventory !== 'public') {
    teeth.push(
      `T-VIS-LAUNDER VACUOUS: expected the fully-public flip fixture to derive 'public', got ` +
        `${JSON.stringify(launderVis.inventory)}`,
    );
  } else {
    const launderShape = checkVisibility(launderVis, launderRebased);
    if (!clean(launderShape)) {
      teeth.push(
        `T-VIS-LAUNDER(a) FAILED: after a FULL re-baseline, checkVisibility must be clean ` +
          `([visibility-shape]/[visibility-drift] cannot fire — the recorded visibility was ` +
          `regenerated from this very source) but returned ${show(launderShape)}`,
      );
    }
    const launderEscalation = checkVisibilityEscalation(PREV_BASELINE_VIS_PRIVATE, launderRebased);
    if (
      !hasTag(launderEscalation, '[visibility-escalation]') ||
      !hasTag(launderEscalation, 'inventory')
    ) {
      teeth.push(
        `T-VIS-LAUNDER(b) FAILED: 'inventory' flipped private->public and was fully re-baselined ` +
          `(the sanctioned regeneration, which makes [visibility-drift] clean by construction — ` +
          `pinned above) — but checkVisibilityEscalation(prev, rebased) did not report ` +
          `[visibility-escalation] naming 'inventory' — got ${show(launderEscalation)}. Laundering ` +
          `through regeneration must not disarm the gate`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-VIS-NEWPUB — a brand-new `public` table, fully re-baselined against a
  // prev that does not know it. Triple assertion proving independence from
  // checkSchemaDrift and checkVisibility. Kills: an escalation checker whose
  // only signal is "table not in baseline" — already reported by
  // checkSchemaDrift and empty by construction after the mandated
  // regeneration (ADR-0193's own argument); the triple proves
  // [visibility-escalation] fires from a genuinely INDEPENDENT axis.
  // -------------------------------------------------------------------------
  const NEWPUB_SRC = `
#[spacetimedb::table(accessor = party_slot, public)]
pub struct PartySlot {
    #[primary_key]
    pub slot_id: u64,
    pub monster_id: u64,
}
`;
  const newPubParsed = parseTableSchemas(NEWPUB_SRC);
  const newPubVis = parseTableVisibility(NEWPUB_SRC);
  const newPubRebased = rebaselineVis(NEWPUB_SRC);
  if (newPubVis.party_slot !== 'public') {
    teeth.push(
      `T-VIS-NEWPUB VACUOUS: expected the new-table fixture to derive 'public', got ` +
        `${JSON.stringify(newPubVis.party_slot)}`,
    );
  } else {
    const npDrift = checkSchemaDrift(newPubParsed, newPubRebased);
    const npShape = checkVisibility(newPubVis, newPubRebased);
    if (!clean(npDrift) || !clean(npShape)) {
      teeth.push(
        `T-VIS-NEWPUB VACUOUS: a FULLY re-baselined brand-new table must be clean through both ` +
          `checkSchemaDrift (got ${show(npDrift)}) and checkVisibility (got ${show(npShape)})`,
      );
    } else {
      const npEscalation = checkVisibilityEscalation(PREV_BASELINE_VIS_PRIVATE, newPubRebased);
      if (!hasTag(npEscalation, '[visibility-escalation]') || !hasTag(npEscalation, 'party_slot')) {
        teeth.push(
          `T-VIS-NEWPUB FAILED: a brand-new table 'party_slot' declared public, fully ` +
            `re-baselined (checkSchemaDrift AND checkVisibility are BOTH clean, proven above), was ` +
            `not flagged by checkVisibilityEscalation against a prev that does not know it — got ` +
            `${show(npEscalation)}`,
        );
      }
      const newPubNoted = {
        party_slot: {
          ...newPubRebased.party_slot,
          visibility_note: 'ADR-0199 — party slots are intentionally public',
        },
      };
      const npEscalationNoted = checkVisibilityEscalation(PREV_BASELINE_VIS_PRIVATE, newPubNoted);
      if (!clean(npEscalationNoted)) {
        teeth.push(
          `T-VIS-NEWPUB FALSE-RED: a valid visibility_note authored on the new public table must ` +
            `clear [visibility-escalation] but returned ${show(npEscalationNoted)}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // T-VIS-PREARM — a `visibility_note` pre-armed weeks ahead on a
  // still-private entry, kept IDENTICAL when the entry flips to public.
  // Kills: an escalation escape that checks only "does next carry a note"
  // instead of "is the note DIFFERENT from prev" — RT-2's pre-arming attack.
  // -------------------------------------------------------------------------
  const PREARM_NOTE = 'ADR-0199 — pre-armed weeks ahead';
  const prearmPrev = {
    inventory: {
      pk: 'inv_id',
      visibility: 'private',
      visibility_note: PREARM_NOTE,
      columns: PREV_BASELINE.inventory.columns,
      order: PREV_BASELINE.inventory.order,
    },
  };
  const prearmNextSameNote = {
    inventory: { ...prearmPrev.inventory, visibility: 'public' },
  };
  const prearmResult = checkVisibilityEscalation(prearmPrev, prearmNextSameNote);
  if (!hasTag(prearmResult, '[visibility-escalation]') || !hasTag(prearmResult, 'inventory')) {
    teeth.push(
      `T-VIS-PREARM FAILED: 'inventory' flipped private->public but its visibility_note is ` +
        `IDENTICAL in prev and next (not authored in this transition) — the escape must be ` +
        `DENIED, but checkVisibilityEscalation did not report [visibility-escalation] naming ` +
        `'inventory' — got ${show(prearmResult)}`,
    );
  }
  const prearmNextChangedNote = {
    inventory: {
      ...prearmNextSameNote.inventory,
      visibility_note: `${PREARM_NOTE} — updated in this PR`,
    },
  };
  const prearmChangedResult = checkVisibilityEscalation(prearmPrev, prearmNextChangedNote);
  if (!clean(prearmChangedResult)) {
    teeth.push(
      `T-VIS-PREARM FALSE-RED: a visibility_note that CHANGED between prev and next (authored in ` +
        `this transition) must clear [visibility-escalation] but returned ${show(prearmChangedResult)}`,
    );
  }

  // -------------------------------------------------------------------------
  // T-VIS-TAMPER — prev where SOME entries carry `visibility` and the table
  // under test does NOT (a deleted key). Kills: a bootstrap-skip test that
  // checks "does prev[t] carry visibility" per-table instead of scanning the
  // WHOLE prev baseline — a deleted key on one table would silently re-enter
  // the skip path table-by-table.
  // -------------------------------------------------------------------------
  const tamperTableCols = { slot_id: 'u64', monster_id: 'u64' };
  const tamperPrev = {
    inventory: {
      pk: 'inv_id',
      visibility: 'private',
      columns: PREV_BASELINE.inventory.columns,
      order: PREV_BASELINE.inventory.order,
    },
    party_slot: { pk: 'slot_id', columns: tamperTableCols, order: ['slot_id', 'monster_id'] }, // no visibility key
  };
  const tamperNext = {
    inventory: {
      pk: 'inv_id',
      visibility: 'private',
      columns: PREV_BASELINE.inventory.columns,
      order: PREV_BASELINE.inventory.order,
    },
    party_slot: {
      pk: 'slot_id',
      visibility: 'public',
      columns: tamperTableCols,
      order: ['slot_id', 'monster_id'],
    },
  };
  const tamperResult = checkVisibilityEscalation(tamperPrev, tamperNext);
  if (!hasTag(tamperResult, '[visibility-escalation]') || !hasTag(tamperResult, 'party_slot')) {
    teeth.push(
      `T-VIS-TAMPER FAILED: prev baseline has SOME entries carrying "visibility" ('inventory') ` +
        `but 'party_slot' does not (a deleted-key tamper vector re-entering the bootstrap-skip ` +
        `path) — must FAIL, not silently skip; got ${show(tamperResult)}`,
    );
  }
  const wholesalePrev = {
    inventory: {
      pk: 'inv_id',
      columns: PREV_BASELINE.inventory.columns,
      order: PREV_BASELINE.inventory.order,
    },
    party_slot: { pk: 'slot_id', columns: tamperTableCols, order: ['slot_id', 'monster_id'] },
  };
  const wholesaleResult = checkVisibilityEscalation(wholesalePrev, tamperNext);
  if (!clean(wholesaleResult)) {
    teeth.push(
      `T-VIS-TAMPER FALSE-RED: a WHOLESALE pre-axis prev baseline (NO entry carries "visibility" ` +
        `at all) must SKIP escalation entirely (bootstrap) and be clean — got ${show(wholesaleResult)}`,
    );
  }

  // -------------------------------------------------------------------------
  // T-VIS-COMMENT — the only `public` spelling for a table appears (i) inside
  // a `//` line comment and (ii) inside a Rust string literal. Assembled from
  // concat/join-broken parts so this eval file cannot match itself if it is
  // ever included in a source scan — mirrors
  // server-module/src/economy_tests.rs:73-76's decoy for `player_wallet`
  // (which T-VIS-ANCHORS below pins as private). Kills: a naive
  // raw-line/whole-source scan for the `public` token instead of one anchored
  // to the captured `#[spacetimedb::table(...)]` block belonging to THIS table.
  // -------------------------------------------------------------------------
  const commentDecoyText = ['#[spacetimedb::table(accessor = inventory', ', public)]'].join('');
  const COMMENT_DECOY_SRC = `
// The forbidden pattern: ${commentDecoyText}
let s = "${commentDecoyText}";
#[spacetimedb::table(accessor = inventory)]
pub struct Inventory {
    #[primary_key]
    pub inv_id: u64,
    pub item_id: u32,
}
`;
  const decoyVis = parseTableVisibility(COMMENT_DECOY_SRC);
  if (decoyVis.inventory !== 'private') {
    teeth.push(
      `T-VIS-COMMENT FAILED: the only 'public' spelling for 'inventory' appears inside a '//' ` +
        `comment and inside a Rust string literal; the REAL declaration carries no 'public' ` +
        `token, so parseTableVisibility must derive 'private' but got ` +
        `${JSON.stringify(decoyVis.inventory)}`,
    );
  }

  // -------------------------------------------------------------------------
  // T-VIS-TOKEN — visibilityFromAttrArgs must be exact-token, never substring.
  // Kills: the shipped scripts/okf-export.mjs derivation
  // `attrRest.indexOf('public') !== -1` (RT-5, demonstrated to false-positive
  // on `index(btree, name = public_view, ...)`) and a comma-split that does
  // not track paren depth.
  // -------------------------------------------------------------------------
  const tokenCases = [
    [
      "index(btree, name = public_view, columns = [x]) must NOT match on the substring 'public'",
      ', index(btree, name = public_view, columns = [x])',
      'private',
    ],
    ["', public' — simple top-level token", ', public', 'public'],
    ["',public' — no leading space", ',public', 'public'],
    [
      "', scheduled(reaper), public' — public after a nested-paren clause",
      ', scheduled(reaper), public',
      'public',
    ],
    [
      "', scheduled(guest_claim_reaper)' — nested parens must not mis-split",
      ', scheduled(guest_claim_reaper)',
      'private',
    ],
  ];
  for (const [label, tail, want] of tokenCases) {
    const got = visibilityFromAttrArgs(tail);
    if (got !== want) {
      teeth.push(
        `T-VIS-TOKEN FAILED (${label}): visibilityFromAttrArgs(${JSON.stringify(tail)}) = ` +
          `${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-VIS-ANCHORS — baseline-INDEPENDENT, run against the REAL corpus. Kills:
  // an all-'private' (or all-'public') derivation that would be
  // self-consistently green after `--write`, and a derivation shared with
  // scripts/okf-export.mjs's docs bundle that `just knowledge-check` cannot
  // independently catch (RT-6). If a table's declared visibility legitimately
  // changes, update this tooth's pinned counts/names DELIBERATELY from
  // ADR-0199 — that churn is the point, not a defect.
  // -------------------------------------------------------------------------
  const realVisAll = parseTableVisibility(rawSrc);
  const realVisTableNames = Object.keys(realVisAll);
  const realPublicCount = realVisTableNames.filter((t) => realVisAll[t] === 'public').length;
  const realPrivateCount = realVisTableNames.filter((t) => realVisAll[t] === 'private').length;
  if (realPublicCount !== 18 || realPrivateCount !== 20) {
    teeth.push(
      `T-VIS-ANCHORS FAILED: the real corpus derives ${realPublicCount} public / ` +
        `${realPrivateCount} private table(s), expected 18/20 (measured a6ae43c) — if a table's ` +
        `declared visibility legitimately changed, update this tooth's pinned counts DELIBERATELY ` +
        `from ADR-0199, not to silence a red`,
    );
  }
  const pinnedPrivateTables = [
    'player_wallet',
    'battle',
    'encounter',
    'monster',
    'account',
    'guest_claim',
  ];
  for (const t of pinnedPrivateTables) {
    if (realVisAll[t] !== 'private') {
      teeth.push(
        `T-VIS-ANCHORS FAILED: '${t}' must derive 'private' (ADR-0015/ADR-0198/ADR-0040/ADR-0044/` +
          `ADR-0179) but parseTableVisibility(realSrc) got ${JSON.stringify(realVisAll[t])} — this ` +
          `is the ONLY independent cross-check on visibility derivation once ` +
          `scripts/okf-export.mjs consumes it; a legitimate visibility change is expected to ` +
          `update this tooth deliberately, not silence it`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // T-VIS-REGEN — formatBaseline. Kills: (a) a regenerator that emits a
  // semantically-equal-but-differently-formatted baseline (whitespace, key
  // order, trailing newline) — [baseline-stale] would then RED on every run;
  // (b) a formatBaseline that emits unknown/marker keys in INPUT order
  // instead of canonical placement — the reviewer's MAJOR finding: without
  // this a legitimate hand-added note REDs the gate on first use; (c) a
  // formatBaseline that hardcodes a single hidden marker slot or sorts
  // unknown keys alphabetically — (b) alone, with only ONE unknown key,
  // cannot distinguish "canonical placement" from "the only marker this impl
  // knows about"; TWO markers in a deliberately non-alphabetical relative
  // order close that gap; (d) a formatBaseline that re-sorts top-level keys
  // or inserts a new table anywhere but the end.
  // -------------------------------------------------------------------------
  const regenSourceOrder = parseTableColumnOrder(rawSrc);
  const regenSourceVisibility = parseTableVisibility(rawSrc);
  let baselineRaw;
  try {
    baselineRaw = readFileSync(BASELINE_PATH, 'utf8');
  } catch (e) {
    teeth.push(
      `T-VIS-REGEN VACUOUS: cannot re-read ${BASELINE_PATH} for the byte round-trip — ${e.message}`,
    );
  }
  if (typeof baselineRaw === 'string') {
    const roundTrip = formatBaseline(parsed, regenSourceOrder, regenSourceVisibility, baseline);
    if (roundTrip !== baselineRaw) {
      teeth.push(
        `T-VIS-REGEN(a) FAILED: formatBaseline(realSchemas, realOrder, realVisibility, ` +
          `committedBaseline) did not byte-for-byte equal the committed ${BASELINE_PATH} — the ` +
          `regenerator is not idempotent against the real corpus`,
      );
    }
  }

  const arbitraryOrderParam = {
    inventory: PREV_BASELINE.inventory.order.map((n) => ({ name: n, hasDefault: false })),
  };
  const arbitrarySchemas = {
    inventory: { pk: 'inv_id', columns: PREV_BASELINE.inventory.columns },
  };
  const arbitraryVisibility = { inventory: 'public' };
  const arbitraryExisting = {
    inventory: {
      // Deliberately SCRAMBLED key order — proves formatBaseline CANONICALIZES
      // rather than mirroring input key order.
      manual_migration: 'ADR-0177 delete-data runbook',
      order: PREV_BASELINE.inventory.order,
      pk: 'inv_id',
      visibility_note: 'ADR-0199 — hand-added note',
      columns: PREV_BASELINE.inventory.columns,
      visibility: 'public',
    },
  };
  const arbitraryOut = formatBaseline(
    arbitrarySchemas,
    arbitraryOrderParam,
    arbitraryVisibility,
    arbitraryExisting,
  );
  let arbitraryEntryKeys;
  try {
    arbitraryEntryKeys = Object.keys(JSON.parse(arbitraryOut).inventory);
  } catch (e) {
    arbitraryEntryKeys = [`PARSE ERROR: ${e.message}`];
  }
  const wantEntryKeys = [
    'pk',
    'visibility',
    'visibility_note',
    'columns',
    'order',
    'manual_migration',
  ];
  if (!eq(arbitraryEntryKeys, wantEntryKeys)) {
    teeth.push(
      `T-VIS-REGEN(b) FAILED: an existing entry carrying "visibility_note" AND "manual_migration" ` +
        `in ARBITRARY key positions must round-trip to the canonical key order ` +
        `${JSON.stringify(wantEntryKeys)} but formatBaseline produced ` +
        `${JSON.stringify(arbitraryEntryKeys)}`,
    );
  }

  // Reviewer MINOR: the previous case exercises only ONE unknown key
  // (`manual_migration`), so a formatBaseline that hardcodes a single
  // hidden slot for it — or sorts unknown keys — still passes. TWO unknown
  // markers, authored in a deliberately NON-alphabetical relative order
  // (`zzz_marker` before `aaa_marker`), must keep exactly that relative
  // order after `order`. Kills: a hardcoded-one-slot impl and an
  // alphabetical-sort impl (both would move `aaa_marker` first).
  const twoMarkerExisting = {
    inventory: {
      pk: 'inv_id',
      visibility: 'public',
      columns: PREV_BASELINE.inventory.columns,
      order: PREV_BASELINE.inventory.order,
      zzz_marker: 'authored FIRST',
      aaa_marker: 'authored SECOND',
    },
  };
  const twoMarkerOut = formatBaseline(
    arbitrarySchemas,
    arbitraryOrderParam,
    arbitraryVisibility,
    twoMarkerExisting,
  );
  let twoMarkerEntryKeys;
  try {
    twoMarkerEntryKeys = Object.keys(JSON.parse(twoMarkerOut).inventory);
  } catch (e) {
    twoMarkerEntryKeys = [`PARSE ERROR: ${e.message}`];
  }
  const wantTwoMarkerKeys = ['pk', 'visibility', 'columns', 'order', 'zzz_marker', 'aaa_marker'];
  if (!eq(twoMarkerEntryKeys, wantTwoMarkerKeys)) {
    teeth.push(
      `T-VIS-REGEN(c) FAILED: TWO unknown marker keys ('zzz_marker' authored before ` +
        `'aaa_marker') must keep their PRIOR RELATIVE ORDER after "order" — expected ` +
        `${JSON.stringify(wantTwoMarkerKeys)} but formatBaseline produced ` +
        `${JSON.stringify(twoMarkerEntryKeys)}`,
    );
  }

  const orderPreserveExisting = {
    zebra_table: { pk: 'z_id', visibility: 'private', columns: { z_id: 'u64' }, order: ['z_id'] },
    alpha_table: { pk: 'a_id', visibility: 'private', columns: { a_id: 'u64' }, order: ['a_id'] },
  };
  const orderPreserveSchemas = {
    zebra_table: { pk: 'z_id', columns: { z_id: 'u64' } },
    alpha_table: { pk: 'a_id', columns: { a_id: 'u64' } },
    brand_new_table: { pk: 'n_id', columns: { n_id: 'u64' } },
  };
  const orderPreserveOrderParam = {
    zebra_table: [{ name: 'z_id', hasDefault: false }],
    alpha_table: [{ name: 'a_id', hasDefault: false }],
    brand_new_table: [{ name: 'n_id', hasDefault: false }],
  };
  const orderPreserveVisibility = {
    zebra_table: 'private',
    alpha_table: 'private',
    brand_new_table: 'private',
  };
  const orderPreserveOut = formatBaseline(
    orderPreserveSchemas,
    orderPreserveOrderParam,
    orderPreserveVisibility,
    orderPreserveExisting,
  );
  let orderPreserveTopKeys;
  try {
    orderPreserveTopKeys = Object.keys(JSON.parse(orderPreserveOut));
  } catch (e) {
    orderPreserveTopKeys = [`PARSE ERROR: ${e.message}`];
  }
  const wantTopKeys = ['zebra_table', 'alpha_table', 'brand_new_table'];
  if (!eq(orderPreserveTopKeys, wantTopKeys)) {
    teeth.push(
      `T-VIS-REGEN(d) FAILED: formatBaseline must iterate the EXISTING baseline's top-level key ` +
        `order first (never re-sort — 'zebra_table' stays before 'alpha_table' despite ` +
        `alphabetical order) and append the parsed-only 'brand_new_table' at the END, but produced ` +
        `top-level key order ${JSON.stringify(orderPreserveTopKeys)}, expected ` +
        `${JSON.stringify(wantTopKeys)}`,
    );
  }

  // -------------------------------------------------------------------------
  // T-VIS-LEGAL — false-RED guard. Kills: a checkVisibility/
  // checkVisibilityEscalation that fires on every diff — a checker with these
  // false positives is worse than no checker at all.
  // -------------------------------------------------------------------------
  const legalVisResult = checkVisibility(realVisAll, baseline);
  if (!clean(legalVisResult)) {
    teeth.push(
      `T-VIS-LEGAL FALSE-RED: checkVisibility(realVisibility, realBaseline) must be clean on the ` +
        `unchanged real corpus but returned ${show(legalVisResult)}`,
    );
  }
  const realBaselineRederived = rebaselineVis(rawSrc);
  const legalEscalationResult = checkVisibilityEscalation(realBaselineRederived, baseline);
  if (!clean(legalEscalationResult)) {
    teeth.push(
      `T-VIS-LEGAL FALSE-RED: checkVisibilityEscalation against a prev built by RE-DERIVING the ` +
        `real baseline (no flip occurred) must be clean but returned ${show(legalEscalationResult)}`,
    );
  }

  // -------------------------------------------------------------------------
  // T-VIS-WIRED — reviewer BLOCKER. Every tooth above calls checkVisibility /
  // checkVisibilityEscalation DIRECTLY, so a perfect implementation of both
  // could still ship a real verdict block (below) that never calls either —
  // every existing tooth would pass, and a live commit flipping a table to
  // `public` would still return `pass:true`. This tooth is the ONLY one that
  // exercises the AGGREGATION (`computeViolations`) the verdict block must
  // actually call, closing that gap. Kills: a `computeViolations` that wires
  // in the four ADR-0193 rules but forgets one or both new checkers, wires
  // `checkVisibility` but gates it on `appendOnlyRan` (EARS 1/2 must NOT
  // depend on git resolving), or wires `checkVisibilityEscalation`
  // unconditionally (EARS 3 is deliberately git-gated, mirroring
  // checkBaselineAppendOnly's own appendOnlyRan gate) — and a
  // `computeViolations` that silently drops one of the four PRE-EXISTING
  // ADR-0193 rules while adding the new ones (the anti-regression case).
  // -------------------------------------------------------------------------
  const wiredBaselineStillPublic = {
    inventory: {
      pk: 'inv_id',
      visibility: 'public',
      columns: PREV_BASELINE.inventory.columns,
      order: PREV_BASELINE.inventory.order,
    },
  };
  const wiredDriftResult = computeViolations(
    FLIP_TO_PRIVATE_SRC,
    wiredBaselineStillPublic,
    null,
    false,
  );
  if (!hasTag(wiredDriftResult, '[visibility-drift]') || !hasTag(wiredDriftResult, 'inventory')) {
    teeth.push(
      `T-VIS-WIRED FAILED (drift): computeViolations(rawSrc, baseline, null, false) over a ` +
        `source/baseline pair whose ONLY defect is a visibility flip did not carry ` +
        `[visibility-drift] naming 'inventory' — got ${show(wiredDriftResult)}. checkVisibility ` +
        `is not reachable from the aggregation`,
    );
  }
  const wiredEscalationOn = computeViolations(
    FLIP_TO_PUBLIC_SRC,
    launderRebased,
    PREV_BASELINE_VIS_PRIVATE,
    true,
  );
  if (
    !hasTag(wiredEscalationOn, '[visibility-escalation]') ||
    !hasTag(wiredEscalationOn, 'inventory')
  ) {
    teeth.push(
      `T-VIS-WIRED FAILED (escalation, appendOnlyRan=true): computeViolations over a ` +
        `prevData/baseline pair whose ONLY defect is an un-noted private->public escalation did ` +
        `not carry [visibility-escalation] naming 'inventory' — got ${show(wiredEscalationOn)}. ` +
        `checkVisibilityEscalation is not reachable from the aggregation`,
    );
  }
  const wiredEscalationOff = computeViolations(
    FLIP_TO_PUBLIC_SRC,
    launderRebased,
    PREV_BASELINE_VIS_PRIVATE,
    false,
  );
  if (hasTag(wiredEscalationOff, '[visibility-escalation]')) {
    teeth.push(
      `T-VIS-WIRED FAILED (escalation, appendOnlyRan=false): the IDENTICAL escalation pair with ` +
        `appendOnlyRan=false must NOT carry [visibility-escalation] (the git-layer gate must be ` +
        `deliberate, mirroring checkBaselineAppendOnly's own gate) — got ${show(wiredEscalationOff)}`,
    );
  }
  const wiredLegalResult = computeViolations(rawSrc, baseline, realBaselineRederived, true);
  if (
    hasTag(wiredLegalResult, '[visibility-shape]') ||
    hasTag(wiredLegalResult, '[visibility-drift]') ||
    hasTag(wiredLegalResult, '[visibility-escalation]')
  ) {
    teeth.push(
      `T-VIS-WIRED FALSE-RED: computeViolations(realSrc, realBaseline, prevRederivedFromReal, ` +
        `true) must carry NONE of [visibility-shape]/[visibility-drift]/[visibility-escalation] ` +
        `but returned ${show(wiredLegalResult)}`,
    );
  }
  // Anti-regression: a fixture that trips ONLY a PRE-EXISTING ADR-0193 rule
  // ([order-mismatch], via the file's own T-SWAP fixture) must still surface
  // through computeViolations — a rewrite that adds the two new checkers must
  // not silently drop an old one.
  const wiredOldRuleResult = computeViolations(SWAP_SRC, PREV_BASELINE, null, false);
  if (!hasTag(wiredOldRuleResult, '[order-mismatch]') || !hasTag(wiredOldRuleResult, 'inventory')) {
    teeth.push(
      `T-VIS-WIRED FAILED (anti-regression): computeViolations over the T-SWAP fixture (a pure ` +
        `column reorder, no visibility defect) did not carry [order-mismatch] naming 'inventory' ` +
        `— got ${show(wiredOldRuleResult)}. A pre-existing ADR-0193 rule was dropped from the ` +
        `aggregation`,
    );
  }

  // -------------------------------------------------------------------------
  // T-NOTHROW — every checker is pure and NEVER throws, on ANY input. A throw
  // inside the eval runner is an unhandled failure mode, not a gate result.
  // -------------------------------------------------------------------------
  const badOrder = { t: [{ name: 'a', hasDefault: false }] };
  const nothrowCases = [
    ['checkParseShape(null)', () => checkParseShape(null)],
    ['checkParseShape(undefined)', () => checkParseShape(undefined)],
    ['checkParseShape(42)', () => checkParseShape(42)],
    ['checkColumnOrder(null, null)', () => checkColumnOrder(null, null)],
    ['checkColumnOrder({}, {})', () => checkColumnOrder({}, {})],
    ['checkColumnOrder({t:{}}, {t:{}})', () => checkColumnOrder({ t: {} }, { t: {} })],
    [
      'checkColumnOrder(order is a string)',
      () => checkColumnOrder(badOrder, { t: { columns: { a: 'u32' }, order: 'nope' } }),
    ],
    [
      'checkColumnOrder(parsed table undefined)',
      () => checkColumnOrder({ t: undefined }, { t: { columns: { a: 'u32' }, order: ['a'] } }),
    ],
    ['checkDefaultsSuffix(null, null)', () => checkDefaultsSuffix(null, null)],
    ['checkDefaultsSuffix({}, {})', () => checkDefaultsSuffix({}, {})],
    [
      'checkDefaultsSuffix(parsed table undefined)',
      () => checkDefaultsSuffix({ t: undefined }, { t: {} }),
    ],
    [
      'checkDefaultsSuffix(order is a string)',
      () => checkDefaultsSuffix({ t: 'nope' }, { t: { columns: {}, order: 'nope' } }),
    ],
    ['checkBaselineAppendOnly(null,null,null)', () => checkBaselineAppendOnly(null, null, null)],
    ['checkBaselineAppendOnly({},{},{})', () => checkBaselineAppendOnly({}, {}, {})],
    [
      'checkBaselineAppendOnly({t:{}},{t:{}},{t:undefined})',
      () => checkBaselineAppendOnly({ t: {} }, { t: {} }, { t: undefined }),
    ],
    [
      'checkBaselineAppendOnly(prev.order is a string)',
      () => checkBaselineAppendOnly({ t: { order: 'nope' } }, { t: { order: ['a'] } }, {}),
    ],
    [
      'checkBaselineAppendOnly(parsedOrder table is a string)',
      () =>
        checkBaselineAppendOnly({ t: { order: ['a'] } }, { t: { order: ['a', 'b'] } }, { t: 'x' }),
    ],
    // ADR-0199 (15r-sec-vis) — the two new checkers must never throw either.
    ['checkVisibility(null, null)', () => checkVisibility(null, null)],
    ['checkVisibility(42)', () => checkVisibility(42)],
    ["checkVisibility({t:'x'}, {t:{}})", () => checkVisibility({ t: 'x' }, { t: {} })],
    ['checkVisibilityEscalation(null, null)', () => checkVisibilityEscalation(null, null)],
    [
      'checkVisibilityEscalation({t:{visibility:1}}, {t:{}})',
      () => checkVisibilityEscalation({ t: { visibility: 1 } }, { t: {} }),
    ],
    [
      'checkVisibilityEscalation({}, {t:undefined})',
      () => checkVisibilityEscalation({}, { t: undefined }),
    ],
  ];
  for (const [label, run] of nothrowCases) {
    try {
      const result = run();
      if (!isArr(result)) {
        teeth.push(`T-NOTHROW FAILED: ${label} returned ${show(result)}, expected an array`);
      }
    } catch (e) {
      teeth.push(`T-NOTHROW FAILED: ${label} THREW ${e?.message} — checkers must never throw`);
    }
  }

  // -------------------------------------------------------------------------
  // T-REAL — the real server-module source against the real committed baseline.
  // RED until evals/baselines/table-schemas.json gains per-table "order".
  // -------------------------------------------------------------------------
  const realOrder = parseTableColumnOrder(rawSrc);
  const baselineTables = Object.keys(baseline);
  const orderChecked = baselineTables.filter(
    (t) => isArr(baseline[t]?.order) && isArr(realOrder[t]),
  ).length;
  // COVERAGE only. The real-source VERDICT belongs to the gate block below, which
  // runs the identical checks with the right attribution: a genuine schema
  // violation must read as "schema-order violations", not "teeth FAILED" (a
  // message that sends the author to audit the gate instead of their own diff).
  if (orderChecked !== baselineTables.length) {
    teeth.push(
      `T-REAL FAILED: only ${orderChecked} of ${baselineTables.length} baseline tables have BOTH ` +
        'a recorded "order" array and a parsed source order — every table without a recorded ' +
        'order is silently exempt from [order-mismatch] and [order-append]',
    );
  }

  if (teeth.length > 0) {
    return {
      name,
      pass: false,
      detail: `ADR-0193 teeth FAILED (${teeth.length}): ${teeth.join(' ;; ')}`,
    };
  }

  // -------------------------------------------------------------------------
  // ADR-0193 D3/D4 — the real gate: the five in-tree rules over the real source
  // vs the working-tree baseline, plus the git-resolved append-only layer that
  // survives a full, sanctioned re-baseline.
  // -------------------------------------------------------------------------
  const prevBaseline = readPrevBaseline(baseline);
  const appendOnlyRan = isObj(prevBaseline.data) && Object.keys(prevBaseline.data).length > 0;
  // ADR-0199 — the aggregation is `computeViolations` (above) and NOTHING else:
  // an inlined spread list here is a second wiring that can silently diverge
  // from the one T-VIS-WIRED gates. It applies ADR-0193 D5's defaultsScope and
  // gates the two git-resolved layers on `appendOnlyRan` internally.
  const violations = computeViolations(rawSrc, baseline, prevBaseline.data, appendOnlyRan);
  let visibilityNote = appendOnlyRan
    ? 'visibility escalation checked against the previously committed baseline'
    : 'visibility escalation DID NOT RUN (no previously committed baseline); the git-independent ' +
      '[visibility-shape]/[visibility-drift] rules still ran';
  if (appendOnlyRan) {
    // ADR-0199 D7 — the bootstrap skip must be LOUD or it becomes permanent.
    if (
      !Object.keys(prevBaseline.data).some(
        (t) => isObj(prevBaseline.data[t]) && VISIBILITY_KEY in prevBaseline.data[t],
      )
    ) {
      const skipped = Object.keys(baseline).filter(
        (t) => isObj(baseline[t]) && baseline[t][VISIBILITY_KEY] === 'public',
      ).length;
      visibilityNote =
        `[visibility-escalation] SKIPPED (ADR-0199 D7 bootstrap): NO entry in the previously ` +
        `committed baseline (${prevBaseline.source}) carries a "${VISIBILITY_KEY}" key, so ` +
        `${skipped} public table(s) were not escalation-checked. This window closes as soon as a ` +
        'baseline carrying the axis is committed';
    }
  } else if (insideGitWorkTree()) {
    // Fail-CLOSED inside a repo. For the 33 tables that carry no defaulted column,
    // the append-only layer is the ONLY rule that survives a full re-baseline, so a
    // silently unresolvable prev baseline (shallow clone, renamed default branch,
    // pruned remote ref) would disarm the gate while it still reported green.
    violations.push(
      '[append-only] the previously committed baseline could not be resolved from git ' +
        `(${prevBaseline.source}) even though this IS a git work tree — the ADR-0193 D4 layer ` +
        'cannot run, and it is the only rule that survives a full re-baseline. Fetch the ' +
        'default branch (git fetch origin master) or run outside a repo to accept the reduced gate',
    );
  }
  const appendOnlyNote = appendOnlyRan
    ? `append-only layer ran against the previously committed baseline (${prevBaseline.source})`
    : 'WARNING — the ADR-0193 D4 append-only layer DID NOT RUN: no git work tree, so the ' +
      'previously committed baseline is unavailable. A mid-struct insert laundered through a ' +
      'full re-baseline is NOT policed by this run';
  if (violations.length > 0) {
    return {
      name,
      pass: false,
      detail: `ADR-0193 schema-order violations (${violations.length}): ${violations.join('; ')} [${appendOnlyNote}] [${visibilityNote}]`,
    };
  }

  const tableCount = Object.keys(parsed).length;
  return {
    name,
    pass: true,
    detail:
      `${tableCount} tables parsed; all match baseline exactly (columns, types, PKs); ` +
      `EncounterEntryRow excluded; column-drop tooth verified; ADR-0193 order teeth verified ` +
      `(T-MANDATE/B1/NODEFAULT/LEGAL/SWAP/SWAP-REBASED/LAUNDER/APPEND/SHAPE/REMOVE/ESCAPE/` +
      `NEWTABLE/B1-INTERIOR/PARSE/COUNT/IDEMPOTENT/NOTHROW/REAL); ADR-0199 visibility teeth ` +
      `verified (T-VIS-SHAPE/NOTE/DRIFT/LAUNDER/NEWPUB/PREARM/TAMPER/COMMENT/TOKEN/ANCHORS/` +
      `REGEN/LEGAL/WIRED); ${orderChecked}/${baselineTables.length} baseline tables order-checked; ` +
      `${appendOnlyNote}; ${visibilityNote}`,
  };
}

// ADR-0193 D3 — the never-throws contract, mechanically. The rule bodies above
// guard their inputs, but an exotic value (a throwing getter, a Proxy, a BigInt
// inside JSON.stringify) must still yield a TAGGED diagnostic rather than kill
// the eval: a checker that throws is a checker that cannot fail loudly.
const neverThrows =
  (tag, fn) =>
  (...args) => {
    try {
      const out = fn(...args);
      return Array.isArray(out) ? out : [`${tag} checker returned a non-array (${typeof out})`];
    } catch (e) {
      return [`${tag} checker threw on malformed input — ${e?.message}`];
    }
  };
export const checkParseShape = neverThrows('[parse-shape]', checkParseShapeCore);
export const checkColumnOrder = neverThrows('[order-shape]', checkColumnOrderCore);
export const checkDefaultsSuffix = neverThrows('[defaults-not-suffix]', checkDefaultsSuffixCore);
export const checkBaselineAppendOnly = neverThrows('[append-only]', checkBaselineAppendOnlyCore);
export const checkVisibility = neverThrows('[visibility-shape]', checkVisibilityCore);
export const checkVisibilityEscalation = neverThrows(
  '[visibility-escalation]',
  checkVisibilityEscalationCore,
);

// M8.9b (ADR-0056): server-module/src was split from a single lib.rs into cohesive
// domain submodules. Concatenate ALL .rs files under it (sorted, recursive — a
// deterministic order) so this static check parses the whole crate, surviving the
// split. Mirrors the glob pattern already used by encounter-privacy / spec-gap-
// revival. The set of tables/reducers/fns is unchanged — only their files moved.
// Exported so the ADR-0193 D6 regeneration one-shot reads the byte-identical
// concatenation this gate parses (a divergent reader would bake drift into the
// baseline it writes).
export function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) parts.push(readServerModuleSources(full));
    else if (entry.endsWith('.rs')) parts.push(readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// ADR-0199 D8 — the regenerator, as a command (observability-log-wrapper.eval
// .mjs:1629 idiom). Inert under evals/run.mjs, which IMPORTS this module, so
// process.argv[1] is the runner, not this file.
//   node evals/battle-schema-snapshot.eval.mjs --write
// Regeneration is always a RE-DERIVATION from server-module/src through the
// very projections this gate reads; hand-authored keys (visibility_note,
// manual_migration) are carried forward from the committed baseline verbatim.
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    const src = readServerModuleSources(SERVER_SRC);
    let existing = {};
    try {
      existing = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    } catch {
      existing = {}; // no committed baseline yet: emit a fresh one in parse order
    }
    const visibility = parseTableVisibility(src);
    const text = formatBaseline(
      parseTableSchemas(src),
      parseTableColumnOrder(src),
      visibility,
      existing,
    );
    writeFileSync(BASELINE_PATH, text);
    const names = Object.keys(visibility);
    const publicCount = names.filter((t) => visibility[t] === 'public').length;
    console.log(
      `wrote ${BASELINE_PATH} — ${names.length} tables, ${publicCount} public / ` +
        `${names.length - publicCount} private; EVERY visibility delta must be explained in the ` +
        'PR (a private -> public flip needs a "visibility_note": "ADR-nnnn — …", ADR-0199 D5)',
    );
    process.exit(0);
  }
}
