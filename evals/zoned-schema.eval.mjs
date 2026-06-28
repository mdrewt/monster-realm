// Zoned-schema eval (ADR-0007): every table that declares a zone_id or map_id
// field must carry that field as either #[primary_key] or #[index(btree)], so
// per-zone subscriptions/ticks are a query change, never a migration.
//
// Scans the server-module source for table structs. Scheduler tables
// (whose #[spacetimedb::table(...)] attribute contains `scheduled(`) are
// exempt — the scheduler framework owns their layout.
//
// Implementation note on Semgrep detect-non-literal-regexp:
//   All pattern matching uses literal /regex/ — NO new RegExp(...).
import { readdirSync, readFileSync, statSync } from 'node:fs';

/**
 * Strip Rust block comments and line comments from source so a comment between
 * the table attribute and the struct (or inside a body) can't drop a table.
 * @param {string} src Raw Rust source.
 * @returns {string}
 */
function stripRustComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

/**
 * Parse `#[spacetimedb::table(name = X, ...)] pub struct ... { ... }` blocks.
 * Each entry carries:
 *   - name: the table name (X)
 *   - attr: the full attribute text (from `#[spacetimedb::table(` through `)]`)
 *   - body: the struct interior text
 *
 * Comments are stripped first, and the struct-body terminator is `\n\s*\}` so an
 * indented closing brace is not silently dropped.
 *
 * @param {string} rawSrc Raw Rust source (comments stripped internally).
 * @returns {{ name: string, attr: string, body: string }[]}
 */
export function parseTables(rawSrc) {
  const src = stripRustComments(rawSrc);
  const tables = [];
  // Capture the full attribute (group 1) and body (group 2).
  const re = /(#\[spacetimedb::table\([^\]]*\)\])\s*pub struct \w+\s*\{([\s\S]*?)\n\s*\}/g;
  let m = re.exec(src);
  while (m !== null) {
    const attr = m[1];
    const body = m[2];
    // Extract table name from the attribute
    const nameMatch = /name\s*=\s*(\w+)/.exec(attr);
    if (nameMatch) {
      tables.push({ name: nameMatch[1], attr, body });
    }
    m = re.exec(src);
  }
  return tables;
}

/**
 * Return a list of table names that violate the zoning rule.
 *
 * A table violates the rule if:
 *   1. It is NOT a scheduler table (its `attr` does NOT contain `scheduled(`), AND
 *   2. It declares a `zone_id` or `map_id` field, AND
 *   3. That field is neither preceded by `#[primary_key]` nor `#[index(btree)]`.
 *
 * OR (legacy tile-bearing rule):
 *   1. It has tile_x/tile_y fields, AND
 *   2. It does NOT have an indexed (or PK) zone_id.
 *
 * The scheduler carve-out keys ONLY on the `attr` string containing `scheduled(`,
 * NOT on the body containing `ScheduleAt` — a non-scheduler table that happens to
 * have a ScheduleAt-typed field is still subject to the zoning rule.
 *
 * @param {{ name: string, attr: string, body: string }[]} tables
 * @returns {string[]}
 */
export function zoningViolations(tables) {
  const violations = [];

  for (const t of tables) {
    // Scheduler carve-out: key on attr, NOT body (tooth 17)
    if (t.attr.indexOf('scheduled(') !== -1) continue;

    const hasTileXY = /\btile_x\b|\btile_y\b/.test(t.body);
    const hasZoneId = /\bzone_id\b/.test(t.body);
    const hasMapId = /\bmap_id\b/.test(t.body);

    // Determine if zone_id is indexed (PK or btree index)
    const zoneIdIsPk = /#\[primary_key\](?:\s*#\[[^\]]*\]\s*)*\s*pub zone_id/.test(t.body);
    const zoneIdIsBtree = /#\[index\(btree\)\]\s*pub zone_id/.test(t.body);
    const zoneIdIndexed = zoneIdIsPk || zoneIdIsBtree;

    // Determine if map_id is indexed (PK or btree index)
    const mapIdIsPk = /#\[primary_key\](?:\s*#\[[^\]]*\]\s*)*\s*pub map_id/.test(t.body);
    const mapIdIsBtree = /#\[index\(btree\)\]\s*pub map_id/.test(t.body);
    const mapIdIndexed = mapIdIsPk || mapIdIsBtree;

    // Legacy tile-bearing rule: spatial table must have indexed zone_id
    if (hasTileXY && !zoneIdIndexed) {
      violations.push(t.name);
      continue;
    }

    // Broadened rule: any table with bare zone_id (not PK, not indexed) is a violation
    if (hasZoneId && !zoneIdIndexed && !hasTileXY) {
      // tile_x/tile_y case already handled above
      violations.push(t.name);
      continue;
    }

    // Broadened rule: any table with bare map_id (not PK, not indexed) is a violation
    if (hasMapId && !mapIdIndexed) {
      violations.push(t.name);
    }
  }

  return violations;
}

export default async function () {
  const name =
    'zoned-schema (world tables carry indexed zone_id/map_id; scheduler tables exempt; attr-based carve-out)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: ghost table (tile_x/tile_y, no indexed zone_id) must flag
  // -------------------------------------------------------------------------
  const ghostSrc =
    '#[spacetimedb::table(name = ghost, public)]\npub struct Ghost {\n  pub tile_x: i32,\n  pub tile_y: i32,\n}';
  const ghostTables = parseTables(ghostSrc);
  if (zoningViolations(ghostTables).length === 0) {
    return {
      name,
      pass: false,
      detail: 'proof-of-teeth: failed to flag a zoneless spatial table (tile_x/tile_y, no zone_id)',
    };
  }

  // -------------------------------------------------------------------------
  // Proof-of-teeth: bare zone_id (no PK, no index, no scheduler) must flag
  // -------------------------------------------------------------------------
  const bareZoneSrc = `
#[spacetimedb::table(name = stray_zone, public)]
pub struct StrayZone {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub zone_id: u32,
}
`;
  const bareZoneTables = parseTables(bareZoneSrc);
  if (zoningViolations(bareZoneTables).length === 0) {
    return {
      name,
      pass: false,
      detail: 'proof-of-teeth: failed to flag a table with bare zone_id (no PK, no index)',
    };
  }

  // -------------------------------------------------------------------------
  // Proof-of-teeth: scheduler table with bare zone_id must NOT flag
  // -------------------------------------------------------------------------
  const schedSrc = `
#[spacetimedb::table(name = movement_tick_schedule, scheduled(movement_tick))]
pub struct MovementTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub zone_id: u32,
    pub scheduled_at: ScheduleAt,
}
`;
  const schedTables = parseTables(schedSrc);
  if (zoningViolations(schedTables).length > 0) {
    return {
      name,
      pass: false,
      detail: 'proof-of-teeth: incorrectly flagged scheduler table with bare zone_id',
    };
  }

  // -------------------------------------------------------------------------
  // Real source check
  // -------------------------------------------------------------------------
  const src = readServerModuleSources('server-module/src');
  const tables = parseTables(src);
  const v = zoningViolations(tables);
  return {
    name,
    pass: v.length === 0,
    detail: v.length
      ? `tables with unindexed zone_id/map_id: ${v.join(', ')}`
      : `${tables.length} tables scanned; all zone_id/map_id fields indexed or PK; scheduler tables exempt; teeth verified`,
  };
}

// M8.9b (ADR-0056): server-module/src was split from a single lib.rs into cohesive
// domain submodules. Concatenate ALL .rs files under it (sorted, recursive — a
// deterministic order) so this static check parses the whole crate, surviving the
// split. Mirrors the glob pattern already used by encounter-privacy / spec-gap-
// revival. The set of tables/reducers/fns is unchanged — only their files moved.
function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) parts.push(readServerModuleSources(full));
    else if (entry.endsWith('.rs')) parts.push(readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}
