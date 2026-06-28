// Monster privacy eval (ADR-0015 fallback): hidden genes (IVs, EVs, nature)
// live in a PRIVATE table; the public projection contains only safe fields.
// Proof-of-teeth: a bad fixture (public table with IVs) must be flagged.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

const HIDDEN_FIELDS = [
  'iv_hp',
  'iv_attack',
  'iv_defense',
  'iv_speed',
  'iv_sp_attack',
  'iv_sp_defense',
  'ev_hp',
  'ev_attack',
  'ev_defense',
  'ev_speed',
  'ev_sp_attack',
  'ev_sp_defense',
  'nature_kind',
];

// Parse `#[spacetimedb::table(name = X, ...)] pub struct ... { ... }` blocks.
export function parseTables(src) {
  const tables = [];
  const re = /#\[spacetimedb::table\(name = (\w+)[^\]]*\)\]\s*pub struct \w+\s*\{([\s\S]*?)\n\}/g;
  let m = re.exec(src);
  while (m !== null) {
    const attr = src.slice(m.index, m.index + m[0].indexOf('pub struct'));
    tables.push({ name: m[1], body: m[2], isPublic: /\bpublic\b/.test(attr) });
    m = re.exec(src);
  }
  return tables;
}

// Check: private monster table exists and is NOT public.
export function checkMonsterPrivate(tables) {
  const monster = tables.find((t) => t.name === 'monster');
  if (!monster) return 'monster table not found in server-module source';
  if (monster.isPublic) return 'monster table is public — hidden genes would leak';
  return null;
}

// Check: public projection exists, is public, and has NO hidden fields.
export function checkMonsterPubClean(tables) {
  const pub = tables.find((t) => t.name === 'monster_pub');
  if (!pub) return 'monster_pub table not found in server-module source';
  if (!pub.isPublic) return 'monster_pub table is not public — clients cannot subscribe';
  for (const f of HIDDEN_FIELDS) {
    if (pub.body.includes(f)) return `monster_pub contains hidden field: ${f}`;
  }
  return null;
}

export default async function () {
  const name = 'monster-privacy (hidden genes in private table, public projection clean)';

  // Proof-of-teeth: a PUBLIC monster table with IV fields MUST be flagged.
  const badPublicMonster = parseTables(
    '#[spacetimedb::table(name = monster, public)]\npub struct Monster {\n  pub iv_hp: u8,\n  pub owner_identity: Identity,\n}',
  );
  const teethPublic = checkMonsterPrivate(badPublicMonster);
  if (!teethPublic) {
    return { name, pass: false, detail: 'TEETH: failed to flag a public monster table' };
  }

  // Proof-of-teeth: a monster_pub with hidden fields MUST be flagged.
  const badPubLeak = parseTables(
    '#[spacetimedb::table(name = monster_pub, public)]\npub struct MonsterPub {\n  pub iv_hp: u8,\n  pub species_id: u32,\n}',
  );
  const teethLeak = checkMonsterPubClean(badPubLeak);
  if (!teethLeak) {
    return { name, pass: false, detail: 'TEETH: failed to flag hidden field in monster_pub' };
  }

  // Real check: scan the actual server-module source.
  const src = readServerModuleSources('server-module/src');
  const tables = parseTables(src);

  const err1 = checkMonsterPrivate(tables);
  if (err1) return { name, pass: false, detail: err1 };

  const err2 = checkMonsterPubClean(tables);
  if (err2) return { name, pass: false, detail: err2 };

  // Bindings gate: no monster_table.ts should be generated (private table = no client accessor).
  if (existsSync('client/src/module_bindings/monster_table.ts')) {
    return {
      name,
      pass: false,
      detail: 'monster_table.ts exists — private table leaked to client bindings',
    };
  }

  return {
    name,
    pass: true,
    detail: `${tables.length} tables scanned; monster private, projection clean, no client accessor (teeth verified)`,
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
