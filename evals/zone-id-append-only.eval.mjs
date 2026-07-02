// zone-id-append-only eval (M11a): zone_maps stable zone_id values are NEVER
// removed or renumbered. Compares game-core/content/zone_maps/*.ron zone_ids
// against the committed baseline evals/baselines/zone-map-ids.json.
//
// Uses `\bzone_id\s*:\s*(\d+)/g` (NOT `to_zone`) to avoid counting warp
// target references as declared map ids. Comment-stripped before scanning.
// Proof-of-teeth: both a dropped id AND a `to_zone:` false-positive are tested.
import { readdirSync, readFileSync } from 'node:fs';

function readRegistryDir(dirPath) {
  return readdirSync(dirPath)
    .filter((name) => name.endsWith('.ron'))
    .sort()
    .map((name) => readFileSync(`${dirPath}/${name}`, 'utf8'))
    .join('\n')
    .replace(/\/\/[^\n]*/g, ''); // strip both whole-line and inline // comments
}

export function parseZoneMapIds(ron) {
  // Match only top-level zone_id: N fields (word-boundary prevents to_zone match).
  // `\b` before `zone_id` ensures we do NOT match `to_zone_id` hypothetically;
  // the critical property is that `to_zone: 7` does NOT have `zone_id` in it,
  // so the regex already excludes it by literal match — the \b makes it explicit.
  return [...ron.matchAll(/\bzone_id\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
}

export function removedIds(baselineIds, currentIds) {
  const cur = new Set(currentIds);
  return baselineIds.filter((id) => !cur.has(id));
}

export default async function () {
  const name = 'zone-id-append-only (zone_map stable ids never removed/renumbered)';

  // Proof-of-teeth A: dropping a baseline id must be flagged.
  if (removedIds([0, 1], [0]).length === 0) {
    return {
      name,
      pass: false,
      detail: 'proof-of-teeth A: failed to flag a removed zone_map id',
    };
  }

  // Proof-of-teeth B: to_zone: N must NOT be counted as a declared map id.
  // A warp field `to_zone: 7` must not be mistaken for a zone_maps declaration.
  const toZoneRon =
    '[\n  (zone_id: 0, rows: [], warps: [(from: (x:1,y:1), to_zone: 7, to_tile: (x:1,y:1))])\n]';
  const extractedIds = parseZoneMapIds(toZoneRon);
  if (extractedIds.includes(7)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth B: to_zone: 7 was incorrectly counted as a zone_map id (regex must use \\bzone_id, not to_zone)',
    };
  }
  if (!extractedIds.includes(0)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth B: zone_id: 0 was not detected (regex broken — parseZoneMapIds must match \\bzone_id\\s*:\\s*(\\d+))',
    };
  }

  const ron = readRegistryDir('game-core/content/zone_maps');
  const baseline = JSON.parse(readFileSync('evals/baselines/zone-map-ids.json', 'utf8'))[
    'zone_maps'
  ];
  const current = parseZoneMapIds(ron);
  const missing = removedIds(baseline, current);

  return {
    name,
    pass: missing.length === 0,
    detail: missing.length
      ? `zone_maps: removed/renumbered stable zone_ids: ${missing.join(', ')} (ids are append-only)`
      : `zone_maps: ${current.length} zone_ids found; all ${baseline.length} baseline ids retained (teeth verified)`,
  };
}
