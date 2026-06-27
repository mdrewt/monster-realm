// Zoned-schema eval (ADR-0007): every WORLD table (one with spatial fields)
// must carry an indexed `zone_id`, so per-zone subscriptions/tick are a query
// change, never a migration. Scans the server-module source for table structs.
import { readFileSync } from 'node:fs';

// Parse `#[spacetimedb::table(name = X, ...)] pub struct ... { ... }` blocks.
export function parseTables(src) {
  const tables = [];
  const re = /#\[spacetimedb::table\(name = (\w+)[^\]]*\)\]\s*pub struct \w+\s*\{([\s\S]*?)\n\}/g;
  let m = re.exec(src);
  while (m !== null) {
    tables.push({ name: m[1], body: m[2] });
    m = re.exec(src);
  }
  return tables;
}

// A world table has spatial fields (tile_x/tile_y); it MUST have an indexed zone_id.
export function zoningViolations(tables) {
  const violations = [];
  for (const t of tables) {
    if (!/\btile_x\b|\btile_y\b/.test(t.body)) continue; // not a world table
    const indexed = /#\[index\(btree\)\]\s*pub zone_id/.test(t.body);
    if (!indexed) violations.push(t.name);
  }
  return violations;
}

export default async function () {
  const name = 'zoned-schema (world tables carry an indexed zone_id)';

  // Proof-of-teeth: a spatial table WITHOUT an indexed zone_id must be flagged.
  const bad = parseTables(
    '#[spacetimedb::table(name = ghost, public)]\npub struct Ghost {\n  pub tile_x: i32,\n  pub tile_y: i32,\n}',
  );
  if (zoningViolations(bad).length === 0) {
    return { name, pass: false, detail: 'proof-of-teeth: failed to flag a zoneless spatial table' };
  }

  const src = readFileSync('server-module/src/lib.rs', 'utf8');
  const tables = parseTables(src);
  const v = zoningViolations(tables);
  return {
    name,
    pass: v.length === 0,
    detail: v.length
      ? `world tables missing an indexed zone_id: ${v.join(', ')}`
      : `${tables.length} tables scanned; world tables zoned (teeth verified)`,
  };
}
