// bsatn-compat-smoke.eval.mjs — M14.5f-1: BSATN schema-compatibility smoke (ADR-0006/0093/0095).
//
// The M14b/M14d "old rows deserialize as None" claim rests on #[serde(default)] +
// serde/RON round-trip tests. But battle.state persists via SpacetimeType/BSATN
// derive — a different codec (position-based, all fields required in order; no
// missing-field defaults). SpacetimeDB handles additive schema at the ENGINE level
// when publishing without --delete-data. This eval documents that finding and
// verifies the serde-side annotations are present.
//
// PASS conditions:
//   1. #[serde(default)] on BattleMonster.status (co-located: immediately before field)
//   2. #[serde(default)] on BattleState.weather (co-located: immediately before field)
//   3. SpacetimeType derive on BattleMonster (in the attr block above pub struct)
//   4. SpacetimeType derive on BattleState (in the attr block above pub struct)
//   5. RON/serde default tests for `status` exist in m14b_tests.rs
//      (two specific fn names — module-qualified needles, per m14.5e lesson)
//   6. The BSATN-vs-serde codec finding is machine-visible in eval name+detail
//
// NOTE (weather nuance): there is NO dedicated RON-omits-`weather` test in
// m14b_tests.rs (none was written for the weather field). The weather-side proof
// is criteria 2 + 4 only. Do NOT assert a weather RON test exists.
//
// IMPORTANT: No new RegExp() — detect-non-literal-regexp Semgrep rule bites.
// Only String.prototype.includes() / indexOf() and regex LITERALS used here.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Criterion 1+2: #[serde(default)] co-located with the target field.
//
// Co-location: the attribute must appear IMMEDIATELY before `pub <fieldName>:`
// within the struct body — not merely anywhere in the file and not before a
// different field. We search for the exact two-line pattern:
//   #[serde(default)]\n    pub <fieldName>:
// within the struct body (opening `{` to first closing `\n}`).
//
// This rejects the case where #[serde(default)] is on a different field:
//   e.g. `#[serde(default)]\n    pub species_id: u32,\n    pub status: ...`
//   does NOT contain `#[serde(default)]\n    pub status:`.
// ---------------------------------------------------------------------------
export function hasSerdeDefaultOnField(rustSrc, structName, fieldName) {
  const structMarker = `pub struct ${structName}`;
  const structIdx = rustSrc.indexOf(structMarker);
  if (structIdx === -1) return false;

  const braceIdx = rustSrc.indexOf('{', structIdx);
  if (braceIdx === -1) return false;

  // First `\n}` after the opening brace closes the struct body.
  // Safe for flat structs: field types use angle brackets (<>), not braces.
  const closeIdx = rustSrc.indexOf('\n}', braceIdx);
  if (closeIdx === -1) return false;

  const body = rustSrc.slice(braceIdx, closeIdx + 2);

  // Co-located pattern: attribute on one line, field declaration on the next.
  const pattern = `#[serde(default)]\n    pub ${fieldName}:`;
  return body.includes(pattern);
}

// ---------------------------------------------------------------------------
// Criterion 3+4: SpacetimeType derive in the attribute block above the struct.
//
// The derive is:
//   #[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
// We isolate the attribute block by finding the last blank line (\n\n) or
// block-end (\n}\n) before `pub struct <structName>`, then checking for
// 'SpacetimeType' in that window.
//
// This correctly isolates each struct's own attribute block even when adjacent
// structs also have SpacetimeType derives.
// ---------------------------------------------------------------------------
export function hasSpacetimeTypeDerive(rustSrc, structName) {
  const structMarker = `pub struct ${structName}`;
  const structIdx = rustSrc.indexOf(structMarker);
  if (structIdx === -1) return false;

  const before = rustSrc.slice(0, structIdx);

  // Find the last blank line or block-end immediately before this struct's attrs.
  const lastBlank = before.lastIndexOf('\n\n');
  const lastBlockEnd = before.lastIndexOf('\n}\n');
  const boundary = Math.max(lastBlank, lastBlockEnd);

  const attrBlock = boundary !== -1 ? before.slice(boundary) : before;
  return attrBlock.includes('SpacetimeType');
}

// ---------------------------------------------------------------------------
// Criterion 5: Two specific serde-default test fn names must exist in m14b_tests.rs.
//
// NOTE: there is NO dedicated RON-omits-weather test; only status tests exist.
// The two required fn names are the exact module-qualified needles (m14.5e lesson:
// use specific fn-name needles, not loose substrings).
// ---------------------------------------------------------------------------
export function hasRonDefaultTests(testSrc) {
  return (
    testSrc.includes('m14b_serde_default_allows_missing_status_field') &&
    testSrc.includes('m14b_battle_monster_status_field_defaults_to_none')
  );
}

// ---------------------------------------------------------------------------
// Criterion 6: The BSATN-vs-serde codec finding must be machine-visible in the
// eval's name+detail (deliverable 14.5f-1 point 4). We require 'BSATN',
// 'serde', and 'engine' in the combined name+detail string.
// ---------------------------------------------------------------------------
export function documentsBsatnGap(nameStr, detailStr) {
  const combined = `${nameStr} ${detailStr}`;
  return combined.includes('BSATN') && combined.includes('serde') && combined.includes('engine');
}

export default async function () {
  const name =
    'bsatn-compat-smoke (14.5f-1: serde(default)+SpacetimeType on battle.state fields; ' +
    'BSATN is a different codec — SpacetimeDB engine handles additive columns)';

  // -------------------------------------------------------------------------
  // PROOF-OF-TEETH: each predicate must reject its known-bad fixture BEFORE
  // real-file checks. If any tooth fails to bite, return RED immediately.
  // -------------------------------------------------------------------------

  // Tooth A: hasSerdeDefaultOnField rejects a struct missing #[serde(default)]
  const badNoDefault =
    'pub struct BattleMonster {\n    pub species_id: u32,\n    pub status: Option<StatusEffect>,\n}\n';
  if (hasSerdeDefaultOnField(badNoDefault, 'BattleMonster', 'status')) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth A: hasSerdeDefaultOnField failed to reject BattleMonster where ' +
        'status has NO #[serde(default)] — a loose whole-file search would wrongly pass here',
    };
  }

  // Tooth A': accepts the good fixture (attribute immediately above the field)
  const goodWithDefault =
    'pub struct BattleMonster {\n    pub species_id: u32,\n' +
    '    #[serde(default)]\n    pub status: Option<StatusEffect>,\n}\n';
  if (!hasSerdeDefaultOnField(goodWithDefault, 'BattleMonster', 'status')) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth A': hasSerdeDefaultOnField failed to accept BattleMonster where " +
        '#[serde(default)] is co-located immediately above the status field',
    };
  }

  // Tooth A'': attribute on a DIFFERENT field must NOT satisfy the status requirement
  // (co-location rigor: the attribute on species_id is NOT co-located with status)
  const badAttrOnOtherField =
    'pub struct BattleMonster {\n    #[serde(default)]\n    pub species_id: u32,\n' +
    '    pub status: Option<StatusEffect>,\n}\n';
  if (hasSerdeDefaultOnField(badAttrOnOtherField, 'BattleMonster', 'status')) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth A'': hasSerdeDefaultOnField accepted a struct where #[serde(default)] " +
        'is on species_id (not status) — co-location check must require the attribute ' +
        'immediately before the TARGET field, not merely anywhere in the struct',
    };
  }

  // Tooth B: hasSpacetimeTypeDerive rejects a struct with only serde derives
  const badNoSpacetimeType =
    '#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]\n' +
    'pub struct BattleMonster {\n    pub species_id: u32,\n}\n';
  if (hasSpacetimeTypeDerive(badNoSpacetimeType, 'BattleMonster')) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth B: hasSpacetimeTypeDerive failed to reject a struct with only ' +
        'serde derives (no SpacetimeType) — must check for SpacetimeType specifically',
    };
  }

  // Tooth B': accepts the good fixture (SpacetimeType cfg_attr present)
  const goodWithSpacetimeType =
    '#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]\n' +
    'pub struct BattleMonster {\n    pub species_id: u32,\n}\n';
  if (!hasSpacetimeTypeDerive(goodWithSpacetimeType, 'BattleMonster')) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth B': hasSpacetimeTypeDerive failed to accept a struct with the " +
        'correct SpacetimeType cfg_attr derive',
    };
  }

  // Tooth C: hasRonDefaultTests rejects source missing one of the two required fn names
  const badMissingOneFn = 'fn m14b_serde_default_allows_missing_status_field() {}\n';
  if (hasRonDefaultTests(badMissingOneFn)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth C: hasRonDefaultTests failed to reject a test source missing ' +
        'm14b_battle_monster_status_field_defaults_to_none — requires BOTH fn names',
    };
  }

  // Tooth C': accepts source with both required fn names
  const goodBothFns =
    'fn m14b_serde_default_allows_missing_status_field() {}\n' +
    'fn m14b_battle_monster_status_field_defaults_to_none() {}\n';
  if (!hasRonDefaultTests(goodBothFns)) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth C': hasRonDefaultTests failed to accept test source with both required fn names",
    };
  }

  // Tooth D: documentsBsatnGap rejects name+detail missing the codec-gap finding terms
  const badNoFinding = { name: 'just a name', detail: 'serde is nice' };
  if (documentsBsatnGap(badNoFinding.name, badNoFinding.detail)) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth D: documentsBsatnGap failed to reject name+detail missing 'BSATN' " +
        "and 'engine' — the codec-gap finding must be machine-visible in eval output",
    };
  }

  // Tooth D': accepts the real passing detail (which contains BSATN + serde + engine)
  const goodFindingDetail =
    'serde/RON tests prove serde-codec compat; BSATN is a different codec; ' +
    'SpacetimeDB engine migration handles additive columns at the engine level';
  if (!documentsBsatnGap(name, goodFindingDetail)) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth D': documentsBsatnGap failed to accept real name+detail containing " +
        "'BSATN', 'serde', and 'engine'",
    };
  }

  // -------------------------------------------------------------------------
  // REAL FILE CHECKS
  // -------------------------------------------------------------------------
  const typesPath = path.resolve('game-core/src/combat/types.rs');
  const m14bTestsPath = path.resolve('game-core/src/combat/m14b_tests.rs');

  let typesSrc = '';
  try {
    typesSrc = readFileSync(typesPath, 'utf8');
  } catch {
    return { name, pass: false, detail: `cannot read ${typesPath}` };
  }

  let testSrc = '';
  try {
    testSrc = readFileSync(m14bTestsPath, 'utf8');
  } catch {
    return { name, pass: false, detail: `cannot read ${m14bTestsPath}` };
  }

  // Criterion 1: #[serde(default)] co-located with BattleMonster.status
  if (!hasSerdeDefaultOnField(typesSrc, 'BattleMonster', 'status')) {
    return {
      name,
      pass: false,
      detail:
        'criterion 1 FAIL: BattleMonster.status is missing #[serde(default)] immediately ' +
        'before the field declaration in game-core/src/combat/types.rs',
    };
  }

  // Criterion 2: #[serde(default)] co-located with BattleState.weather
  if (!hasSerdeDefaultOnField(typesSrc, 'BattleState', 'weather')) {
    return {
      name,
      pass: false,
      detail:
        'criterion 2 FAIL: BattleState.weather is missing #[serde(default)] immediately ' +
        'before the field declaration in game-core/src/combat/types.rs',
    };
  }

  // Criterion 3: SpacetimeType derive on BattleMonster
  if (!hasSpacetimeTypeDerive(typesSrc, 'BattleMonster')) {
    return {
      name,
      pass: false,
      detail:
        'criterion 3 FAIL: BattleMonster is missing the SpacetimeType cfg_attr derive in ' +
        'game-core/src/combat/types.rs — the BSATN codec finding applies only to SpacetimeType-derived types',
    };
  }

  // Criterion 4: SpacetimeType derive on BattleState
  if (!hasSpacetimeTypeDerive(typesSrc, 'BattleState')) {
    return {
      name,
      pass: false,
      detail:
        'criterion 4 FAIL: BattleState is missing the SpacetimeType cfg_attr derive in ' +
        'game-core/src/combat/types.rs — the BSATN codec finding applies only to SpacetimeType-derived types',
    };
  }

  // Criterion 5: serde/RON default test fn names exist in m14b_tests.rs
  if (!hasRonDefaultTests(testSrc)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 5 FAIL: m14b_tests.rs is missing one or both required serde-default tests — ' +
        'expected: m14b_serde_default_allows_missing_status_field AND ' +
        'm14b_battle_monster_status_field_defaults_to_none',
    };
  }

  // Criterion 6: BSATN gap finding documented in name+detail (self-check)
  const passingDetail =
    'serde(default) present on BattleMonster.status and BattleState.weather (co-located); ' +
    'SpacetimeType derive confirmed on both structs; serde/RON default tests confirmed in m14b_tests.rs. ' +
    'FINDING (14.5f-1): serde/RON tests prove serde-codec compat only. ' +
    'battle.state persists via BSATN (SpacetimeType derive — position-based codec, no missing-field defaults). ' +
    'SpacetimeDB engine migration handles additive columns at the engine level ' +
    '(publish without --delete-data), NOT the BSATN codec. ' +
    'The serde(default) annotation covers the serde serialization path (RON content, JSON wire format) ' +
    'but is NOT what makes BSATN-persisted rows backward-compatible with new optional fields.';

  if (!documentsBsatnGap(name, passingDetail)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 6 FAIL: BSATN gap finding not present in eval name+detail — ' +
        "expected 'BSATN', 'serde', 'engine' in combined string",
    };
  }

  return {
    name,
    pass: true,
    detail: passingDetail,
  };
}
