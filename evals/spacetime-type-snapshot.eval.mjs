// spacetime-type-snapshot eval (M12.5f, ADR-0076): all #[derive(SpacetimeType)]
// structs and enums across server-module/src/** and game-core/src/** must exactly
// match the committed baseline in evals/baselines/spacetime-types.json.
// Wire-format tag order is load-bearing: variant order (enums) and field order
// (structs) are both snapshotted and compared exactly.
//
// Semgrep detect-non-literal-regexp: all patterns use literal /regex/ — NO new RegExp.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const BASELINE_PATH = path.resolve('evals/baselines/spacetime-types.json');
const SERVER_SRC = path.resolve('server-module/src');
const GAME_CORE_SRC = path.resolve('game-core/src');

// ---------------------------------------------------------------------------
// Pure parser helpers (exported for gate-teeth and regeneration)
// ---------------------------------------------------------------------------

function stripRustComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

/**
 * Parse all SpacetimeType-derived structs and enums from combined Rust source.
 *
 * Detects two attribute forms:
 *   #[derive(spacetimedb::SpacetimeType, ...)]
 *   #[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
 *
 * Structs: { kind: 'struct', fields: [[name, type], ...] }  (field order = wire order)
 * Enums:   { kind: 'enum', variants: [name, ...] }          (tag = declaration position)
 *
 * @param {string} rawSrc Combined Rust source (comments stripped internally).
 * @returns {{ [name: string]: { kind: string, fields?: string[][], variants?: string[] } }}
 */
export function parseSpacetimeTypes(rawSrc) {
  const src = stripRustComments(rawSrc);
  const types = {};

  // Regex: "SpacetimeType" inside an attribute, then (no } crossing) leading to
  // pub struct/enum NAME { body }. [^}]* stops before any }, preventing the scan
  // from crossing a preceding type's closing brace.
  // CONSTRAINT (m14.5d-1a, red-team MINOR-1): the `\n\s*\}` body terminator stops
  // at the first line that is whitespace+`}`. Multi-line struct-body enum variants
  // (e.g. `Confuse {\n    turns: u8,\n},`) would cause the parser to terminate at
  // the variant's own `}`, dropping subsequent variants. All SpacetimeType enum
  // variants MUST use the inline struct form (`Variant { field: T },` one line) or
  // unit form — never multi-line struct bodies. Enforce this as a code rule; the
  // variant-add tooth in this eval still catches silent variant count changes.
  const spRe = /SpacetimeType[^}]*?pub\s+(struct|enum)\s+(\w+)\s*\{([\s\S]*?)\n\s*\}/g;
  let m = spRe.exec(src);
  while (m !== null) {
    const kind = m[1];
    const name = m[2];
    const body = m[3];

    if (kind === 'struct') {
      const fields = [];
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (t.startsWith('#[') || t.length === 0) continue;
        const fm = /^pub\s+(\w+)\s*:\s*(.+?),?\s*$/.exec(t);
        if (fm) {
          fields.push([fm[1], fm[2].replace(/,$/, '').trim()]);
        }
      }
      types[name] = { kind: 'struct', fields };
    } else {
      const variants = [];
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (t.startsWith('#[') || t.length === 0) continue;
        const vm = /^(\w+)/.exec(t);
        if (vm) {
          variants.push(vm[1]);
        }
      }
      types[name] = { kind: 'enum', variants };
    }

    m = spRe.exec(src);
  }
  return types;
}

/**
 * Bidirectional exact-match drift check.
 * Returns [] on clean; list of human-readable drift strings otherwise.
 *
 * @param {{ [name: string]: object }} parsed
 * @param {{ [name: string]: object }} baseline
 * @returns {string[]}
 */
export function checkTypeDrift(parsed, baseline) {
  const drifts = [];
  const allNames = new Set([...Object.keys(parsed), ...Object.keys(baseline)]);
  for (const name of [...allNames].sort()) {
    const inParsed = name in parsed;
    const inBaseline = name in baseline;
    if (inBaseline && !inParsed) {
      drifts.push(`'${name}': in baseline but not parsed (type removed?)`);
      continue;
    }
    if (inParsed && !inBaseline) {
      drifts.push(`'${name}': parsed but not in baseline — re-baseline required`);
      continue;
    }
    const p = parsed[name];
    const b = baseline[name];
    if (p.kind !== b.kind) {
      drifts.push(`'${name}': kind changed from '${b.kind}' to '${p.kind}'`);
      continue;
    }
    if (p.kind === 'enum') {
      const pv = p.variants;
      const bv = b.variants;
      if (pv.length !== bv.length || pv.some((v, i) => v !== bv[i])) {
        drifts.push(
          `enum '${name}': variant order/set changed; baseline=[${bv.join(',')}] parsed=[${pv.join(',')}]`,
        );
      }
    } else {
      const pf = p.fields;
      const bf = b.fields;
      if (pf.length !== bf.length) {
        drifts.push(
          `struct '${name}': field count changed from ${bf.length} (baseline) to ${pf.length} (parsed)`,
        );
      } else {
        for (let i = 0; i < bf.length; i++) {
          if (pf[i][0] !== bf[i][0] || pf[i][1] !== bf[i][1]) {
            drifts.push(
              `struct '${name}': field[${i}] changed from ['${bf[i][0]}','${bf[i][1]}'] to ['${pf[i][0]}','${pf[i][1]}']`,
            );
          }
        }
      }
    }
  }
  return drifts;
}

// ---------------------------------------------------------------------------
// File collection (mirrors readServerModuleSources in battle-schema-snapshot)
// ---------------------------------------------------------------------------

function collectRustSrc(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) parts.push(collectRustSrc(full));
    else if (entry.endsWith('.rs')) parts.push(readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Default export — the eval runner calls this
// ---------------------------------------------------------------------------

export default async function () {
  const name = 'spacetime-type-snapshot (structs+enums field/variant order, exact-match, ADR-0076)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: BattleOutcome variant add must be flagged (RED fixture).
  // -------------------------------------------------------------------------
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

  const doctoredSrc = `
#[derive(spacetimedb::SpacetimeType)]
pub enum BattleOutcome {
    Ongoing,
    SideAWins,
    SideBWins,
    Fled,
    Draw,
}
`;
  const doctoredParsed = parseSpacetimeTypes(doctoredSrc);
  const doctoredDrift = checkTypeDrift(doctoredParsed, {
    BattleOutcome: baseline.BattleOutcome,
  });
  if (!doctoredDrift || doctoredDrift.length === 0) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: BattleOutcome variant add (Draw) was not flagged by checkTypeDrift',
    };
  }

  // -------------------------------------------------------------------------
  // Real source must be drift-free against baseline.
  // -------------------------------------------------------------------------
  let rawSrc;
  try {
    rawSrc = `${collectRustSrc(SERVER_SRC)}\n${collectRustSrc(GAME_CORE_SRC)}`;
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `cannot read source: ${e.message}`,
    };
  }

  const parsed = parseSpacetimeTypes(rawSrc);
  const drift = checkTypeDrift(parsed, baseline);
  if (drift.length > 0) {
    return {
      name,
      pass: false,
      detail: `real source drifts from baseline: ${drift.join('; ')}`,
    };
  }

  const typeCount = Object.keys(parsed).length;
  return {
    name,
    pass: true,
    detail: `${typeCount} SpacetimeType defs parsed; all match baseline exactly (field+variant order); variant-add tooth verified`,
  };
}
