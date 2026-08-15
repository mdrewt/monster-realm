// battle-schema-snapshot eval (M8.7a, ADR-0006): ALL table definitions under
// server-module/src/** must exactly match the committed baseline in
// evals/baselines/table-schemas.json (columns, declared types, PK, table set).
// (M8.9b split the former single lib.rs into domain submodules; this eval globs
// the whole src tree — see readServerModuleSources below.)
//
// Regeneration (ADR-0193 D6) — always RE-DERIVE from source, never hand-merge:
// run parseTableSchemas + parseTableColumnOrder over readServerModuleSources(
// server-module/src), emit { pk, columns, order } per table with `order` as the
// LAST key, keep the existing top-level table key order (do NOT re-sort), write
// JSON.stringify(out, null, 2) + '\n', and commit the diff for review. The git
// append-only layer (D4, below) polices the RESULT against the previously
// committed baseline, so a mid-struct insert cannot be laundered by
// regenerating.
//
// Implementation note on Semgrep detect-non-literal-regexp:
//   All pattern matching uses literal /regex/ patterns — NO new RegExp(...).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
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
 * Parse all `#[spacetimedb::table(name = X, ...)] pub struct Y { ... }` blocks
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
 * Match every `#[spacetimedb::table(name = X, ...)] pub struct Y { ... }` block.
 * The /g regex is declared INSIDE the function on purpose: a module-level /g
 * regex carries `lastIndex` across calls, so a second call would return fewer
 * tables and silently exempt them.
 *
 * @param {string} src Comment-stripped Rust source.
 * @returns {{ table: string, body: string }[]}
 */
function matchTableBlocks(src) {
  const tableRe =
    /#\[spacetimedb::table\(name\s*=\s*(\w+)[^\]]*\)\]\s*pub struct \w+\s*\{([\s\S]*?)\n\s*\}/g;
  const blocks = [];
  let m = tableRe.exec(src);
  while (m !== null) {
    blocks.push({ table: m[1], body: m[2] });
    m = tableRe.exec(src);
  }
  return blocks;
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
 * @returns {{ [tableName: string]: { pk: string|null, fields: { name: string, type: string, hasDefault: boolean }[] } }}
 */
function parseTableFields(rawSrc) {
  if (typeof rawSrc !== 'string') return {};
  const src = stripRustComments(rawSrc);
  const tables = {};
  for (const { table, body } of matchTableBlocks(src)) {
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
    tables[table] = { pk, fields };
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

// ---------------------------------------------------------------------------
// ADR-0193 D3/D4 — six always-on, individually tagged rules. Every checker is
// pure and NEVER throws for ANY input: malformed input yields a TAGGED
// diagnostic string, not a TypeError (checkAppendOnly guard style,
// evals/spacetime-type-snapshot.eval.mjs).
// ---------------------------------------------------------------------------

// Whitespace-insensitive: the parser's own regex needs the attribute on ONE line
// with `name` first, so a rustfmt-wrapped or argument-reordered attribute must
// still be COUNTED here — otherwise the table vanishes from both sides at once
// and the count agrees vacuously (13r-d red-team F3).
const TABLE_ATTR_NEEDLE = '#[spacetimedb::table(';

// ADR-0193 D7: the per-table, self-expiring escape for a change that only the
// ADR-0177 delete-data runbook can make legal. Value must be a string naming an
// ADR; see checkBaselineAppendOnly.
const MANUAL_MIGRATION_KEY = 'manual_migration';

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
// Default export — the eval runner calls this
// ---------------------------------------------------------------------------

export default async function () {
  const name = 'schema-snapshot (ALL tables: columns+PK+types, exact-match, ADR-0006)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth #1: a non-battle column DROP must be flagged.
  // (inventory.count removed — exercises bidirectional exact-match)
  // -------------------------------------------------------------------------
  const dropFixtureSrc = `
#[spacetimedb::table(name = inventory, public)]
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
  for (const [fnName, fn] of [
    ['parseTableColumnOrder', parseTableColumnOrder],
    ['checkParseShape', checkParseShape],
    ['checkColumnOrder', checkColumnOrder],
    ['checkDefaultsSuffix', checkDefaultsSuffix],
    ['checkBaselineAppendOnly', checkBaselineAppendOnly],
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

  // -------------------------------------------------------------------------
  // T-MANDATE — the mandated tooth. A mid-struct insert WITH a default, plus a
  // FULL re-baseline. Kills: any gate that only diffs source-vs-working-tree
  // baseline (empty by construction after regeneration) and any order rule that
  // does not reach back to the previously committed baseline.
  // -------------------------------------------------------------------------
  const INSERT_SRC = `
#[spacetimedb::table(name = inventory, public)]
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
#[spacetimedb::table(name = inventory, public)]
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
#[spacetimedb::table(name = inventory, public)]
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
#[spacetimedb::table(name = inventory, public)]
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
#[spacetimedb::table(name = inventory, public)]
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
#[spacetimedb::table(name = inventory, public)]
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
#[spacetimedb::table(name = inventory, public)]
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
#[spacetimedb::table(name = inventory, public)]
pub struct Inventory {
    #[primary_key]
    pub inv_id: u64,
    item_id: u32,
    pub count: u32,
}
`;
  const ONE_LINE_SRC = `
#[spacetimedb::table(name = inventory, public)]
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
#[spacetimedb::table(name = inventory, public)]
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
#[spacetimedb::table(name = alpha_beta, public, index(btree, name = ab, columns = [alpha, beta]))]
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
        `${hiddenCount} table(s) while the source declares 1 #[spacetimedb::table(name ` +
        `attribute, and checkParseShape did not report [table-count] — got ` +
        `${show(hiddenResult)}. An unparsed table is exempt from every other rule here`,
    );
  }

  // -------------------------------------------------------------------------
  // T-IDEMPOTENT — kills a module-level /g regex whose lastIndex survives the
  // call (the second call then returns fewer tables, silently exempting them).
  // -------------------------------------------------------------------------
  const TWO_TABLE_SRC = `${LEGAL_SRC}
#[spacetimedb::table(name = party_slot, public)]
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
  const sourceOrder = parseTableColumnOrder(rawSrc);
  const prevBaseline = readPrevBaseline(baseline);
  const appendOnlyRan = isObj(prevBaseline.data) && Object.keys(prevBaseline.data).length > 0;
  // ADR-0193 D5: [defaults-not-suffix] is scoped to tables that already EXIST in
  // the published schema. The working-tree baseline cannot express that — the
  // mandatory regeneration puts a brand-new table in it before this runs — so the
  // scope comes from the previously committed baseline whenever git resolves it.
  const defaultsScope = appendOnlyRan ? prevBaseline.data : baseline;
  const violations = [
    ...checkParseShape(rawSrc),
    ...checkColumnOrder(sourceOrder, baseline),
    ...checkDefaultsSuffix(sourceOrder, defaultsScope),
  ];
  if (appendOnlyRan) {
    violations.push(...checkBaselineAppendOnly(prevBaseline.data, baseline, sourceOrder));
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
      detail: `ADR-0193 schema-order violations (${violations.length}): ${violations.join('; ')} [${appendOnlyNote}]`,
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
      `NEWTABLE/B1-INTERIOR/PARSE/COUNT/IDEMPOTENT/NOTHROW/REAL); ` +
      `${orderChecked}/${baselineTables.length} baseline tables order-checked; ${appendOnlyNote}`,
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
