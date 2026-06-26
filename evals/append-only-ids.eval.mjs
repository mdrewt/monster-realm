// Append-only-ids eval (ADR-0006): stable content ids are NEVER removed or
// renumbered (clients + saved data key on them). New ids are fine; a vanished id
// fails the gate. Compares game-core/content/*.ron against committed
// baselines (evals/baselines/*-ids.json).
import { readFileSync } from 'node:fs';

export function parseIds(ron) {
  return [...ron.matchAll(/\bid:\s*(\d+)/g)].map((m) => Number(m[1]));
}

// Returns the baseline ids that are MISSING from current (the violation set).
export function removedIds(baselineIds, currentIds) {
  const cur = new Set(currentIds);
  return baselineIds.filter((id) => !cur.has(id));
}

function checkRegistry(ronPath, baselinePath, baselineKey, label) {
  const ron = readFileSync(ronPath, 'utf8');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))[baselineKey];
  const current = parseIds(ron);
  const missing = removedIds(baseline, current);
  return {
    pass: missing.length === 0,
    detail: missing.length
      ? `${label}: removed/renumbered stable ids: ${missing.join(', ')} (ids are append-only)`
      : `${label}: ${current.length} ids; all ${baseline.length} baseline ids retained`,
  };
}

export default async function () {
  const name = 'append-only-ids (stable content ids never removed/renumbered)';

  // Proof-of-teeth: dropping a baseline id must be flagged.
  if (removedIds([0, 1, 2], [0, 1]).length === 0) {
    return { name, pass: false, detail: 'proof-of-teeth: failed to flag a removed id' };
  }

  const registries = [
    {
      ron: 'game-core/content/zones.ron',
      baseline: 'evals/baselines/zone-ids.json',
      key: 'zones',
      label: 'zones',
    },
    {
      ron: 'game-core/content/species.ron',
      baseline: 'evals/baselines/species-ids.json',
      key: 'species',
      label: 'species',
    },
    {
      ron: 'game-core/content/skills.ron',
      baseline: 'evals/baselines/skill-ids.json',
      key: 'skills',
      label: 'skills',
    },
    {
      ron: 'game-core/content/items.ron',
      baseline: 'evals/baselines/item-ids.json',
      key: 'items',
      label: 'items',
    },
  ];

  const results = registries.map((r) => checkRegistry(r.ron, r.baseline, r.key, r.label));
  const failures = results.filter((r) => !r.pass);

  return {
    name,
    pass: failures.length === 0,
    detail: failures.length
      ? failures.map((f) => f.detail).join('; ')
      : `${results.map((r) => r.detail).join('; ')} (teeth verified)`,
  };
}
