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

  // =========================================================================
  // 16.5e teeth (m16.5e, ADR-0116) — checkAppendOnly gating teeth A-1..A-12
  // checkAppendOnly does NOT exist yet; calls below are intentionally RED.
  // =========================================================================

  // A-1: enum tail-append (prev [A,B] → new [A,B,C]) must be clean.
  {
    const prev = { Alpha: { kind: 'enum', variants: ['A', 'B'] } };
    const next = { Alpha: { kind: 'enum', variants: ['A', 'B', 'C'] } };
    let result;
    try {
      result = checkAppendOnly(prev, next);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-1): checkAppendOnly([A,B],[A,B,C]) should return [] for valid tail-append; got: ' +
          JSON.stringify(result),
      };
    }
  }

  // A-2: mid-insert (prev [A,B,C] → new [A,X,B,C]) must be flagged.
  {
    const prev = { Alpha: { kind: 'enum', variants: ['A', 'B', 'C'] } };
    const next = { Alpha: { kind: 'enum', variants: ['A', 'X', 'B', 'C'] } };
    let result;
    try {
      result = checkAppendOnly(prev, next);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-2): checkAppendOnly should flag mid-insert [A,X,B,C] vs prev [A,B,C]; got: ' +
          JSON.stringify(result),
      };
    }
    const flagText = result.join(' ');
    if (flagText.indexOf('Alpha') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-2): drift message must mention offending type name "Alpha"; got: ' +
          flagText,
      };
    }
  }

  // A-3: reorder (prev [A,B] → new [B,A]) must be flagged.
  {
    const prev = { Beta: { kind: 'enum', variants: ['A', 'B'] } };
    const next = { Beta: { kind: 'enum', variants: ['B', 'A'] } };
    let result;
    try {
      result = checkAppendOnly(prev, next);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-3): checkAppendOnly should flag reorder [B,A] vs prev [A,B]; got: ' +
          JSON.stringify(result),
      };
    }
    const flagText = result.join(' ');
    if (flagText.indexOf('Beta') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-3): drift message must mention offending type name "Beta"; got: ' +
          flagText,
      };
    }
  }

  // A-4: removal (prev [A,B,C] → new [A,C]) must be flagged.
  {
    const prev = { Gamma: { kind: 'enum', variants: ['A', 'B', 'C'] } };
    const next = { Gamma: { kind: 'enum', variants: ['A', 'C'] } };
    let result;
    try {
      result = checkAppendOnly(prev, next);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-4): checkAppendOnly should flag removal [A,C] vs prev [A,B,C]; got: ' +
          JSON.stringify(result),
      };
    }
    const flagText = result.join(' ');
    if (flagText.indexOf('Gamma') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-4): drift message must mention offending type name "Gamma"; got: ' +
          flagText,
      };
    }
  }

  // A-5: struct tail-append of fields must be clean.
  {
    const prev = {
      MyStruct: {
        kind: 'struct',
        fields: [
          ['x', 'u32'],
          ['y', 'u32'],
        ],
      },
    };
    const next = {
      MyStruct: {
        kind: 'struct',
        fields: [
          ['x', 'u32'],
          ['y', 'u32'],
          ['z', 'u32'],
        ],
      },
    };
    let result;
    try {
      result = checkAppendOnly(prev, next);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-5): struct tail-append of field z should be clean ([]); got: ' +
          JSON.stringify(result),
      };
    }
  }

  // A-6: struct fields mid-insert must be flagged.
  {
    const prev = {
      MyStruct: {
        kind: 'struct',
        fields: [
          ['x', 'u32'],
          ['y', 'u32'],
        ],
      },
    };
    const next = {
      MyStruct: {
        kind: 'struct',
        fields: [
          ['x', 'u32'],
          ['injected', 'u8'],
          ['y', 'u32'],
        ],
      },
    };
    let result;
    try {
      result = checkAppendOnly(prev, next);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-6): struct mid-insert of field "injected" should be flagged; got: ' +
          JSON.stringify(result),
      };
    }
    const flagText = result.join(' ');
    if (flagText.indexOf('MyStruct') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-6): drift message must mention offending type name "MyStruct"; got: ' +
          flagText,
      };
    }
  }

  // A-7: new type present only in new baseline must not be flagged (allowed).
  {
    const prev = { OldType: { kind: 'enum', variants: ['X'] } };
    const next = {
      OldType: { kind: 'enum', variants: ['X'] },
      NewType: { kind: 'enum', variants: ['A', 'B'] },
    };
    let result;
    try {
      result = checkAppendOnly(prev, next);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-7): new type in new-only baseline should be allowed ([]); got: ' +
          JSON.stringify(result),
      };
    }
  }

  // A-8: inline self-proof — doctored mid-insert on REAL BattleOutcome baseline.
  // Real variants: [Ongoing, SideAWins, SideBWins, Fled].
  // Doctored: [Ongoing, Doctored, SideAWins, SideBWins, Fled] (mid-insert at position 1).
  // checkAppendOnly MUST flag this — kills any impl that only checks length or tail.
  {
    const realBattleOutcome = { BattleOutcome: baseline.BattleOutcome };
    const doctoredMidInsert = {
      BattleOutcome: {
        kind: 'enum',
        variants: ['Ongoing', 'Doctored', 'SideAWins', 'SideBWins', 'Fled'],
      },
    };
    let result;
    try {
      result = checkAppendOnly(realBattleOutcome, doctoredMidInsert);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-8): checkAppendOnly did not flag mid-insert "Doctored" at position 1 in real BattleOutcome [Ongoing,SideAWins,SideBWins,Fled] vs doctored [Ongoing,Doctored,SideAWins,SideBWins,Fled]',
      };
    }
    const flagText = result.join(' ');
    if (flagText.indexOf('BattleOutcome') === -1) {
      return {
        name,
        pass: false,
        detail: 'TEETH FAILED (A-8): drift message must mention "BattleOutcome"; got: ' + flagText,
      };
    }
  }

  // A-9: kind flip (prev enum → new struct same name) must be flagged and NOT throw.
  {
    const prev = { FlipMe: { kind: 'enum', variants: ['A', 'B'] } };
    const next = { FlipMe: { kind: 'struct', fields: [['a', 'u32']] } };
    let threw = false;
    let result;
    try {
      result = checkAppendOnly(prev, next);
    } catch (e) {
      threw = true;
      result = [e.message];
    }
    if (threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-9): kind flip enum→struct must NOT throw; checkAppendOnly threw instead of returning a diagnostic string',
      };
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-9): kind flip enum→struct must be flagged (non-empty array); got: ' +
          JSON.stringify(result),
      };
    }
    const flagText = result.join(' ');
    if (flagText.indexOf('FlipMe') === -1) {
      return {
        name,
        pass: false,
        detail: 'TEETH FAILED (A-9): kind-flip message must mention "FlipMe"; got: ' + flagText,
      };
    }
  }

  // A-10: tail rename (prev [A,B] → new [A,C], counts equal) must be flagged.
  // Kills any impl that only compares lengths without comparing prefix content.
  {
    const prev = { Delta: { kind: 'enum', variants: ['A', 'B'] } };
    const next = { Delta: { kind: 'enum', variants: ['A', 'C'] } };
    let result;
    try {
      result = checkAppendOnly(prev, next);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-10): tail rename [A,C] vs prev [A,B] (same length) must be flagged; got: ' +
          JSON.stringify(result),
      };
    }
    const flagText = result.join(' ');
    if (flagText.indexOf('Delta') === -1) {
      return {
        name,
        pass: false,
        detail: 'TEETH FAILED (A-10): drift message must mention "Delta"; got: ' + flagText,
      };
    }
  }

  // A-11: malformed entry {kind:'enum'} with no variants array must produce
  // a diagnostic flag string, NOT throw a TypeError.
  // Kills any impl that blindly does .slice() on a missing variants property.
  {
    const prev = { Malformed: { kind: 'enum', variants: ['A'] } };
    const next = { Malformed: { kind: 'enum' } }; // no variants array
    let threw = false;
    let result;
    try {
      result = checkAppendOnly(prev, next);
    } catch (e) {
      threw = true;
      result = [e.message];
    }
    if (threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-11): malformed entry with no variants array caused checkAppendOnly to THROW instead of returning a diagnostic string',
      };
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-11): malformed entry with no variants array must produce a non-empty diagnostic array; got: ' +
          JSON.stringify(result),
      };
    }
  }

  // A-12: symmetric check — checkAppendOnly(realBaseline, realBaseline) must be [].
  // Kills any impl that spuriously flags identical inputs.
  {
    let result;
    try {
      result = checkAppendOnly(baseline, baseline);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A-12): checkAppendOnly(realBaseline, realBaseline) must return [] (symmetric identity); got: ' +
          JSON.stringify(result),
      };
    }
  }

  // =========================================================================
  // END 16.5e teeth (A-1..A-12)
  // =========================================================================

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
