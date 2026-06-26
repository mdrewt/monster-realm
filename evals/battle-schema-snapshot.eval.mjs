// battle-schema-snapshot eval (M7b): the `battle` table definition in
// server-module/src/lib.rs must contain every expected column with a stable PK.
//
// Proof-of-teeth: a fixture source with a missing column MUST be flagged;
// a fixture with all required columns MUST pass.
//
// This eval starts RED until the implementer adds the `battle` table to
// server-module/src/lib.rs with the correct schema.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASELINE_PATH = path.resolve('evals/baselines/battle-columns.json');
const SERVER_SRC = path.resolve('server-module/src/lib.rs');

// ---------------------------------------------------------------------------
// Pure parser helpers (exported for teeth fixtures)
// ---------------------------------------------------------------------------

/**
 * Parse all `#[spacetimedb::table(name = X, ...)] pub struct Y { ... }` blocks
 * and return a map of tableName -> array of field names.
 *
 * Field name extraction: looks for `pub <field_name>:` patterns inside each
 * struct body.
 */
export function parseTableColumns(src) {
  const tables = {};
  // Match the full table attribute + struct block.
  const tableRe =
    /#\[spacetimedb::table\(name\s*=\s*(\w+)[^\]]*\)\]\s*pub struct \w+\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = tableRe.exec(src)) !== null) {
    const tableName = m[1];
    const body = m[2];
    // Extract field names: lines like `    pub <field>:` (with optional attributes above).
    const fieldRe = /\bpub\s+(\w+)\s*:/g;
    const fields = [];
    let fm;
    while ((fm = fieldRe.exec(body)) !== null) {
      fields.push(fm[1]);
    }
    tables[tableName] = fields;
  }
  return tables;
}

/**
 * Check that a parsed table contains all expected columns.
 * Returns null on success, or a string error describing the first violation.
 */
export function checkBattleColumns(tables, expectedColumns) {
  const battle = tables['battle'];
  if (!battle) {
    return 'battle table not found in server-module source';
  }
  const found = new Set(battle);
  const missing = expectedColumns.filter((col) => !found.has(col));
  if (missing.length > 0) {
    return `battle table is missing columns: ${missing.join(', ')}`;
  }
  return null;
}

/**
 * Check that the battle table has `battle_id` as a field (PK stability check).
 * Returns null on success, or a string error.
 */
export function checkBattlePrimaryKey(tables) {
  const battle = tables['battle'];
  if (!battle) return 'battle table not found';
  if (!battle.includes('battle_id')) {
    return 'battle table is missing battle_id (primary key must be stable and append-only)';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default export — the eval runner calls this
// ---------------------------------------------------------------------------

export default async function () {
  const name = 'battle-schema-snapshot (battle table columns are append-only, PK stable)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth #1: a source with a MISSING required column must be flagged.
  // -------------------------------------------------------------------------
  const missingColumnFixture = `
    #[spacetimedb::table(name = battle, public)]
    pub struct Battle {
        #[primary_key]
        #[auto_inc]
        pub battle_id: u64,
        pub player_identity: Identity,
        // opponent_identity is MISSING — this must be caught
        pub state: BattleState,
        pub party_monster_ids: Vec<u64>,
        pub opponent_monster_ids: Vec<u64>,
        pub created_at_ms: i64,
    }
  `;
  const teethTables1 = parseTableColumns(missingColumnFixture);
  const teethErr1 = checkBattleColumns(teethTables1, ['opponent_identity']);
  if (!teethErr1) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: missing opponent_identity column was not flagged',
    };
  }

  // -------------------------------------------------------------------------
  // Proof-of-teeth #2: a source with ALL required columns must PASS.
  // -------------------------------------------------------------------------
  const completeFixture = `
    #[spacetimedb::table(name = battle, public)]
    pub struct Battle {
        #[primary_key]
        #[auto_inc]
        pub battle_id: u64,
        pub player_identity: Identity,
        pub opponent_identity: Identity,
        pub state: BattleState,
        pub party_monster_ids: Vec<u64>,
        pub opponent_monster_ids: Vec<u64>,
        pub created_at_ms: i64,
    }
  `;
  const teethTables2 = parseTableColumns(completeFixture);
  const expectedColumns = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).columns;
  const teethErr2 = checkBattleColumns(teethTables2, expectedColumns);
  if (teethErr2) {
    return {
      name,
      pass: false,
      detail: `TEETH FAILED: complete fixture was incorrectly rejected: ${teethErr2}`,
    };
  }

  // -------------------------------------------------------------------------
  // Proof-of-teeth #3: a source WITHOUT battle_id (no PK) must be flagged.
  // -------------------------------------------------------------------------
  const noPkFixture = `
    #[spacetimedb::table(name = battle, public)]
    pub struct Battle {
        pub player_identity: Identity,
        pub state: BattleState,
        pub party_monster_ids: Vec<u64>,
        pub opponent_monster_ids: Vec<u64>,
        pub created_at_ms: i64,
    }
  `;
  const teethTables3 = parseTableColumns(noPkFixture);
  const teethErr3 = checkBattlePrimaryKey(teethTables3);
  if (!teethErr3) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: table without battle_id was not flagged by PK check',
    };
  }

  // -------------------------------------------------------------------------
  // Real check: scan the actual server-module source.
  // -------------------------------------------------------------------------
  let src;
  try {
    src = readFileSync(SERVER_SRC, 'utf8');
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `cannot read ${SERVER_SRC}: ${e.message}`,
    };
  }

  const tables = parseTableColumns(src);

  const pkErr = checkBattlePrimaryKey(tables);
  if (pkErr) {
    return { name, pass: false, detail: pkErr };
  }

  const colErr = checkBattleColumns(tables, expectedColumns);
  if (colErr) {
    return { name, pass: false, detail: colErr };
  }

  const battleFields = tables['battle'];
  return {
    name,
    pass: true,
    detail: `battle table found with ${battleFields.length} columns; all ${expectedColumns.length} required columns present, PK stable (teeth verified)`,
  };
}
