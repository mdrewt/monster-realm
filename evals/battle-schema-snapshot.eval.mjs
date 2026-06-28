// battle-schema-snapshot eval (M8.7a, ADR-0006): ALL table definitions in
// server-module/src/lib.rs must exactly match the committed baseline in
// evals/baselines/table-schemas.json (columns, declared types, PK, table set).
//
// The baseline is a committed generated artifact. To regenerate after an
// intentional schema change: run parseTableSchemas (below) over
// server-module/src/lib.rs, write the sorted result to
// evals/baselines/table-schemas.json, and commit the diff for review.
//
// Implementation note on Semgrep detect-non-literal-regexp:
//   All pattern matching uses literal /regex/ patterns — NO new RegExp(...).
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASELINE_PATH = path.resolve('evals/baselines/table-schemas.json');
const SERVER_SRC = path.resolve('server-module/src/lib.rs');

// ---------------------------------------------------------------------------
// Pure parser helpers (exported for gate-teeth and regeneration)
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
  const src = stripRustComments(rawSrc);
  const tables = {};
  const tableRe =
    /#\[spacetimedb::table\(name\s*=\s*(\w+)[^\]]*\)\]\s*pub struct \w+\s*\{([\s\S]*?)\n\s*\}/g;
  let m = tableRe.exec(src);
  while (m !== null) {
    const tableName = m[1];
    const body = m[2];
    const columns = {};
    let pk = null;
    let pendingPk = false;
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      if (t.startsWith('#[')) {
        if (t.includes('primary_key')) pendingPk = true;
        continue;
      }
      const fm = /^pub\s+(\w+)\s*:\s*(.+?),?\s*$/.exec(t);
      if (fm) {
        const fname = fm[1];
        const ftype = fm[2].replace(/,$/, '').trim();
        columns[fname] = ftype;
        if (pendingPk) pk = fname;
        pendingPk = false;
      } else {
        pendingPk = false;
      }
    }
    tables[tableName] = { pk, columns };
    m = tableRe.exec(src);
  }
  return tables;
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
    rawSrc = readFileSync(SERVER_SRC, 'utf8');
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

  const tableCount = Object.keys(parsed).length;
  return {
    name,
    pass: true,
    detail: `${tableCount} tables parsed; all match baseline exactly (columns, types, PKs); EncounterEntryRow excluded; column-drop tooth verified`,
  };
}
