// Append-only-ids eval (ADR-0006): stable content ids are NEVER removed or
// renumbered (clients + saved data key on them). New ids are fine; a vanished id
// fails the gate. Compares game-core/content/zones.ron against a committed
// baseline (evals/baselines/zone-ids.json).
import { readFileSync } from 'node:fs';

export function parseZoneIds(ron) {
  return [...ron.matchAll(/\bid:\s*(\d+)/g)].map((m) => Number(m[1]));
}

// Returns the baseline ids that are MISSING from current (the violation set).
export function removedIds(baselineIds, currentIds) {
  const cur = new Set(currentIds);
  return baselineIds.filter((id) => !cur.has(id));
}

export default async function () {
  const name = 'append-only-ids (stable content ids never removed/renumbered)';

  // Proof-of-teeth: dropping a baseline id must be flagged.
  if (removedIds([0, 1, 2], [0, 1]).length === 0) {
    return { name, pass: false, detail: 'proof-of-teeth: failed to flag a removed id' };
  }

  const ron = readFileSync('game-core/content/zones.ron', 'utf8');
  const baseline = JSON.parse(readFileSync('evals/baselines/zone-ids.json', 'utf8')).zones;
  const current = parseZoneIds(ron);
  const missing = removedIds(baseline, current);
  return {
    name,
    pass: missing.length === 0,
    detail: missing.length
      ? `removed/renumbered stable ids: ${missing.join(', ')} (ids are append-only)`
      : `${current.length} zone ids; all ${baseline.length} baseline ids retained (teeth verified)`,
  };
}
