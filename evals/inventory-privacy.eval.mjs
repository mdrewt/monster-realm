// inventory-privacy eval (M8d): the `inventory` table carries ONLY
// (owner, item_id, count) — no gene/seed/individuality fields may appear.
//
// Contract (from ADR-0046 + m8d-recruit.md):
//   The inventory table is public (players see their own items via the client
//   binding). Its schema must be minimal — it tracks item ownership and count.
//   It must NOT carry any fields whose names contain `iv_`, `nature`, `seed`,
//   or `individuality` (which would leak gene data through the item binding).
//
// Proof-of-teeth:
//   A fixture struct with an `iv_hp` field MUST be flagged.
//   A fixture with only (owner, item_id, count) MUST pass.
//
// RED STATE: the `inventory` table does not exist yet in lib.rs.
//   This eval returns { pass: false } on absence — not a vacuous pass.
//   Absence is an intentional FAIL so the eval bites until implemented.
//
// Implementation note on Semgrep detect-non-literal-regexp:
//   All scanning uses String.indexOf() or literal /regex/ patterns.
//   NO `new RegExp(...)` with a non-literal argument anywhere in this file.
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// stripComments — verbatim from wild-individuality-privacy.eval.mjs.
// Preserves line count; blanks comment content (preserves newlines).
// ---------------------------------------------------------------------------

/**
 * Strip Rust line and block comments from source.
 * @param {string} src Raw Rust source text.
 * @returns {string} Source with comment content blanked.
 */
export function stripComments(src) {
  const blockRe = /\/\*[\s\S]*?\*\//g;
  let out = src.replace(blockRe, (m) => m.replace(/[^\n]/g, ' '));
  const lineRe = /\/\/[^\n]*/g;
  out = out.replace(lineRe, (m) => ' '.repeat(m.length));
  return out;
}

// ---------------------------------------------------------------------------
// parseTables — verbatim from wild-individuality-privacy.eval.mjs.
// Extracts #[spacetimedb::table(...)] declarations using brace-counting.
// ---------------------------------------------------------------------------

/**
 * Parse all spacetimedb table attribute declarations from comment-stripped Rust.
 * @param {string} src Comment-stripped Rust source.
 * @returns {Array<{name:string, isPublic:boolean, attrText:string, attrEnd:number}>}
 */
export function parseTables(src) {
  const tables = [];
  const marker = '#[spacetimedb::table(';
  let pos = 0;

  while (pos < src.length) {
    const attrStart = src.indexOf(marker, pos);
    if (attrStart === -1) break;

    let depth = 0;
    let i = attrStart + marker.length - 1; // points at the opening `(`
    while (i < src.length) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const attrArgText = src.slice(attrStart + marker.length - 1 + 1, i);

    const nameMatch = attrArgText.match(/\bname\s*=\s*(\w+)/);
    if (!nameMatch) {
      pos = i + 1;
      continue;
    }
    const tableName = nameMatch[1];
    const isPublic = /\bpublic\b/.test(attrArgText);

    tables.push({
      name: tableName,
      isPublic,
      attrText: attrArgText,
      attrEnd: i + 1,
    });

    pos = i + 1;
  }

  return tables;
}

// ---------------------------------------------------------------------------
// parseTableFields — verbatim from wild-individuality-privacy.eval.mjs.
// Extracts field names from the struct body following a table attribute.
// ---------------------------------------------------------------------------

/**
 * Extract field names of the struct body following a table attribute.
 * @param {string} src Comment-stripped Rust source.
 * @param {{attrEnd:number}} table A table entry from parseTables.
 * @returns {string[]} The field names declared in the struct body.
 */
export function parseTableFields(src, table) {
  const braceOpen = src.indexOf('{', table.attrEnd);
  if (braceOpen === -1) return [];

  let depth = 0;
  let j = braceOpen;
  while (j < src.length) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }
  const body = src.slice(braceOpen + 1, j);

  const fields = [];
  for (const rawFrag of body.split(',')) {
    const colon = rawFrag.indexOf(':');
    if (colon === -1) continue;
    const lhs = rawFrag.slice(0, colon);
    const tokens = lhs.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith('#['));
    if (tokens.length === 0) continue;
    const name = tokens[tokens.length - 1];
    if (/^[A-Za-z_]\w*$/.test(name)) fields.push(name);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Named checks (exported for unit-testability).
// ---------------------------------------------------------------------------

/**
 * The forbidden field-name substrings for the inventory table.
 * Any field whose lowercased name contains one of these is a leak vector.
 *
 * `iv_`         — individual value columns (iv_hp, iv_attack, …)
 * `nature`      — nature_kind or similar
 * `seed`        — raw RNG seed (would re-expose individuality_seed)
 * `individuality` — explicit individuality_seed column
 */
const FORBIDDEN_SUBSTRINGS = ['iv_', 'nature', 'seed', 'individuality'];

/**
 * Check: the `inventory` table EXISTS.
 * Absence is always a FAIL — never a vacuous pass.
 *
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkInventoryExists(tables) {
  const t = tables.find((x) => x.name === 'inventory');
  if (!t) {
    return 'inventory table not found in server-module source (not yet implemented — absence is a FAIL, not a pass; RED state before M8d impl)';
  }
  return null;
}

/**
 * Check: the `inventory` table struct contains NO gene/seed fields.
 * Scans field names for the FORBIDDEN_SUBSTRINGS using indexOf (no new RegExp).
 *
 * @param {string} src Comment-stripped Rust source.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkInventoryFieldsClean(src, tables) {
  const t = tables.find((x) => x.name === 'inventory');
  if (!t) return null; // checkInventoryExists handles absence.

  const fields = parseTableFields(src, t);
  for (const f of fields) {
    const lower = f.toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      if (lower.indexOf(forbidden) !== -1) {
        return `inventory table field '${f}' contains forbidden substring '${forbidden}' — inventory must carry only (owner, item_id, count); gene/seed data must stay in the private monster table`;
      }
    }
  }
  return null;
}

/**
 * Check: the `inventory` table has at least the three expected columns.
 * We do not prescribe exact names (owner may be called owner_identity, etc.)
 * but we assert that 3 or more fields exist — a degenerate single-field table
 * would indicate a placeholder stub, not a real implementation.
 *
 * @param {string} src Comment-stripped Rust source.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkInventoryHasMinimumFields(src, tables) {
  const t = tables.find((x) => x.name === 'inventory');
  if (!t) return null; // checkInventoryExists handles absence.

  const fields = parseTableFields(src, t);
  if (fields.length < 3) {
    return `inventory table has only ${fields.length} field(s) [${fields.join(', ')}]; expected at least 3 (owner, item_id, count)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default export: the eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name = 'inventory-privacy (inventory table exists, no gene/seed fields, minimum schema)';

  // =========================================================================
  // PROOFS-OF-TEETH — every tooth must bite before we scan real source.
  // =========================================================================

  // TOOTH 1: inventory table with iv_hp field MUST be flagged.
  {
    const badSrc = stripComments(
      '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct Inventory {\n' +
        '  #[primary_key] owner: Identity,\n' +
        '  item_id: u32,\n' +
        '  count: u32,\n' +
        '  iv_hp: u8,\n' +
        '}',
    );
    const tables = parseTables(badSrc);
    const err = checkInventoryFieldsClean(badSrc, tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: inventory table with iv_hp field was NOT flagged by checkInventoryFieldsClean — forbidden-substring check is broken',
      };
    }
  }

  // TOOTH 2: inventory table with nature_kind field MUST be flagged.
  {
    const badSrc = stripComments(
      '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct Inventory {\n' +
        '  #[primary_key] owner: Identity,\n' +
        '  item_id: u32,\n' +
        '  count: u32,\n' +
        '  nature_kind: NatureKind,\n' +
        '}',
    );
    const tables = parseTables(badSrc);
    const err = checkInventoryFieldsClean(badSrc, tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: inventory table with nature_kind field was NOT flagged by checkInventoryFieldsClean',
      };
    }
  }

  // TOOTH 3: inventory table with individuality_seed field MUST be flagged.
  {
    const badSrc = stripComments(
      '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct Inventory {\n' +
        '  #[primary_key] owner: Identity,\n' +
        '  item_id: u32,\n' +
        '  count: u32,\n' +
        '  individuality_seed: u32,\n' +
        '}',
    );
    const tables = parseTables(badSrc);
    const err = checkInventoryFieldsClean(badSrc, tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: inventory table with individuality_seed field was NOT flagged by checkInventoryFieldsClean',
      };
    }
  }

  // TOOTH 4: ABSENCE must be a FAIL — an empty table set must not pass.
  {
    const err = checkInventoryExists([]);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: an empty table set was NOT flagged by checkInventoryExists — absence must be a FAIL (vacuous-pass guard is broken)',
      };
    }
  }

  // TOOTH 5 (GREEN PATH): a clean inventory with only (owner, item_id, count)
  // MUST pass all checks (no false positives).
  {
    const goodSrc = stripComments(
      '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct InventoryRow {\n' +
        '  #[primary_key] owner_identity: Identity,\n' +
        '  #[primary_key] item_id: u32,\n' +
        '  count: u32,\n' +
        '}',
    );
    const tables = parseTables(goodSrc);
    const errs = [
      checkInventoryExists(tables),
      checkInventoryFieldsClean(goodSrc, tables),
      checkInventoryHasMinimumFields(goodSrc, tables),
    ].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GREEN-PATH — a clean inventory (owner, item_id, count) was incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }

  // TOOTH 6: comment-stripping — a `iv_hp` inside a comment must NOT count.
  {
    const src = stripComments(
      '// iv_hp: u8, — old design; removed\n' +
        '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct InventoryRow { owner: Identity, item_id: u32, count: u32, }',
    );
    const tables = parseTables(src);
    const err = checkInventoryFieldsClean(src, tables);
    if (err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: comment-stripping — iv_hp inside a line comment was incorrectly treated as a real field and flagged',
      };
    }
  }

  // =========================================================================
  // REAL CHECKS — scan the actual server-module source files.
  // =========================================================================

  const rsSources = [];
  try {
    for await (const f of glob('server-module/src/**/*.rs')) {
      rsSources.push(f);
    }
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `Failed to glob server-module/src/**/*.rs: ${e.message}`,
    };
  }

  if (rsSources.length === 0) {
    return {
      name,
      pass: false,
      detail: 'No .rs files found under server-module/src/ — is the worktree set up correctly?',
    };
  }

  // Collect all tables + per-file stripped sources for field scanning.
  const allTables = [];
  const strippedByFile = [];
  for (const f of rsSources) {
    const raw = readFileSync(f, 'utf8');
    const stripped = stripComments(raw);
    strippedByFile.push(stripped);
    allTables.push(...parseTables(stripped));
  }

  // Check 1: inventory table must exist (absence is a FAIL).
  const err1 = checkInventoryExists(allTables);
  if (err1) return { name, pass: false, detail: err1 };

  // Check 2 + 3: scan each file for the inventory struct body.
  for (const stripped of strippedByFile) {
    const fileTables = parseTables(stripped);

    const err2 = checkInventoryFieldsClean(stripped, fileTables);
    if (err2) return { name, pass: false, detail: err2 };

    const err3 = checkInventoryHasMinimumFields(stripped, fileTables);
    if (err3) return { name, pass: false, detail: err3 };
  }

  return {
    name,
    pass: true,
    detail: `${rsSources.length} source file(s) scanned, inventory table found with clean schema (no iv_/nature/seed/individuality fields, >= 3 columns) — all 6 teeth verified`,
  };
}
