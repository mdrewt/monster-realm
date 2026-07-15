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

  // =========================================================================
  // 16.5e teeth (m16.5e, ADR-0116) — checkAdditiveColumnCoupling teeth C-1..C-6
  //
  // Signature chosen (document for implementer):
  //   checkAdditiveColumnCoupling(
  //     schemaSrc: string,      // raw schema.rs source
  //     contentSrc: string,     // raw content.rs source (FULL FILE, not fn body)
  //   ) -> string[]             // [] = clean; non-empty = violations
  //
  // The function:
  //   1. Calls parseContentTableStructs(schemaSrc) to get:
  //        { [structName: string]: { tableName: string, optionFields: string[] } }
  //      for each #[spacetimedb::table(name = <tableName>)] + struct with Option<…> fields.
  //   2. Calls parseSyncedTables(contentSrc) to get Set<string> of table names
  //      written to in content.rs (via ctx.db.<tableName>().<op>( pattern).
  //   3. For each struct where tableName is in the synced set, for each Option field,
  //      checks that contentSrc contains a field-assignment `<fieldName>:` inside
  //      a `<StructName> {` row-literal block (word-boundary rule: preceding char
  //      must NOT be [A-Za-z0-9_]).
  //   4. Returns [] if all coupling present; one string per missing coupling.
  //   5. Vacuity guard: if zero Option fields are found across ALL structs, returns
  //      a non-empty diagnostic array (parser rot guard).
  //
  // parseContentTableStructs and parseSyncedTables and checkAdditiveColumnCoupling
  // do NOT exist yet; calls below are intentionally RED.
  // =========================================================================

  // C-1: synced table, Option field, row literal OMITS <field>: assignment → flagged.
  // Simulates the `..existing` spread refactor omission: the row literal for ShopItemRow
  // uses spread syntax and does NOT include `cure_status:`.
  {
    // Schema fixture: shop_item table with a struct containing Option<StatusKind> cure_status.
    const schemaC1 =
      '#[spacetimedb::table(name = shop_item, public)]\n' +
      'pub struct ShopItemRow {\n' +
      '    pub item_id: u32,\n' +
      '    pub price: u32,\n' +
      '    pub cure_status: Option<StatusKind>,\n' +
      '}\n';

    // Content fixture: shop_item is synced (insert call present), but the row literal
    // uses ..Default::default() spread and OMITS `cure_status:`.
    const contentC1 =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    ctx.db.shop_item().insert(ShopItemRow {\n' +
      '        item_id: 1,\n' +
      '        price: 100,\n' +
      '        ..Default::default()\n' +
      '    });\n' +
      '}\n';

    let result;
    try {
      result = checkAdditiveColumnCoupling(schemaC1, contentC1);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-1): checkAdditiveColumnCoupling must flag missing cure_status: assignment ' +
          'in ShopItemRow literal (..Default::default() spread omits the field); got: ' +
          JSON.stringify(result),
      };
    }
    const flagText = result.join(' ');
    if (flagText.indexOf('cure_status') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-1): violation message must mention field name "cure_status"; got: ' +
          flagText,
      };
    }
  }

  // C-2: Option field WITH <field>: assignment in row literal must be clean.
  // Tests BOTH upsert shape and clear-and-reinsert (delete+insert) shape.
  {
    // Upsert shape: one row literal feeds both update and insert paths.
    const schemaC2Upsert =
      '#[spacetimedb::table(name = item_def, public)]\n' +
      'pub struct ItemDefRow {\n' +
      '    pub item_id: u32,\n' +
      '    pub train_stat: Option<StatKind>,\n' +
      '}\n';

    const contentC2Upsert =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    let row = ItemDefRow {\n' +
      '        item_id: 1,\n' +
      '        train_stat: Some(StatKind::Attack),\n' +
      '    };\n' +
      '    if let Some(existing) = ctx.db.item_def().item_id().find(1) {\n' +
      '        ctx.db.item_def().item_id().update(row);\n' +
      '    } else {\n' +
      '        ctx.db.item_def().item_id().insert(row);\n' +
      '    }\n' +
      '}\n';

    let resultUpsert;
    try {
      resultUpsert = checkAdditiveColumnCoupling(schemaC2Upsert, contentC2Upsert);
    } catch (e) {
      resultUpsert = [e.message];
    }
    if (!Array.isArray(resultUpsert) || resultUpsert.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-2 upsert): checkAdditiveColumnCoupling must return [] when train_stat: ' +
          'is present in the ItemDefRow row literal (upsert shape); got: ' +
          JSON.stringify(resultUpsert),
      };
    }

    // Clear-and-reinsert shape: delete all then insert fresh rows (no update branch).
    // This is the shop_item_row/type_relation_row/fusion shape.
    const schemaC2Clear =
      '#[spacetimedb::table(name = shop_item, public)]\n' +
      'pub struct ShopItemRow {\n' +
      '    pub item_id: u32,\n' +
      '    pub cure_status: Option<StatusKind>,\n' +
      '}\n';

    const contentC2Clear =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    for row in ctx.db.shop_item().iter() {\n' +
      '        ctx.db.shop_item().item_id().delete(row.item_id);\n' +
      '    }\n' +
      '    for entry in &content {\n' +
      '        ctx.db.shop_item().insert(ShopItemRow {\n' +
      '            item_id: entry.id,\n' +
      '            cure_status: entry.cure_status,\n' +
      '        });\n' +
      '    }\n' +
      '}\n';

    let resultClear;
    try {
      resultClear = checkAdditiveColumnCoupling(schemaC2Clear, contentC2Clear);
    } catch (e) {
      resultClear = [e.message];
    }
    if (!Array.isArray(resultClear) || resultClear.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-2 clear-and-reinsert): checkAdditiveColumnCoupling must return [] when cure_status: ' +
          'is present in the ShopItemRow literal (clear-and-reinsert shape, no update branch); got: ' +
          JSON.stringify(resultClear),
      };
    }
  }

  // C-3: vacuity guard — zero Option content fields discovered → loud FAIL.
  // Schema has no Option fields at all; function must not silently return [].
  // Kills any impl that skips the vacuity guard and returns [] when the parser finds nothing.
  {
    const schemaC3NoOptions =
      '#[spacetimedb::table(name = simple_table, public)]\n' +
      'pub struct SimpleRow {\n' +
      '    pub id: u32,\n' +
      '    pub name: String,\n' +
      '}\n';

    const contentC3 =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    ctx.db.simple_table().insert(SimpleRow { id: 1, name: "x".to_string() });\n' +
      '}\n';

    let result;
    try {
      result = checkAdditiveColumnCoupling(schemaC3NoOptions, contentC3);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-3): checkAdditiveColumnCoupling must return a non-empty diagnostic when ' +
          'zero Option fields are discovered (vacuity guard — parser rot); got: ' +
          JSON.stringify(result),
      };
    }
  }

  // C-4: real files missing an anchor → FAIL (parser rot).
  // Tests that parseContentTableStructs discovers the four anchors: ability, train_stat,
  // cure_status, cost_item_id. Uses the real schema.rs and content.rs files.
  // If any anchor is absent, the real-file coupling check would silently pass a false clean.
  {
    const schemaPath = 'server-module/src/schema.rs';
    const contentPath = 'server-module/src/content.rs';
    let schemaSrc = '';
    let contentSrc = '';
    let readOk = true;
    try {
      // Use readFileSync imported at module top level
      schemaSrc = readFileSync(schemaPath, 'utf8');
      contentSrc = readFileSync(contentPath, 'utf8');
    } catch {
      readOk = false;
    }
    if (readOk) {
      let parsed;
      try {
        parsed = parseContentTableStructs(schemaSrc);
      } catch (e) {
        parsed = null;
      }
      if (parsed !== null) {
        // Collect all discovered option fields across all structs
        const allFields = [];
        for (const entry of Object.values(parsed)) {
          if (Array.isArray(entry.optionFields)) {
            for (const f of entry.optionFields) {
              allFields.push(f);
            }
          }
        }
        const anchors = ['ability', 'train_stat', 'cure_status', 'cost_item_id'];
        for (const anchor of anchors) {
          if (allFields.indexOf(anchor) === -1) {
            return {
              name,
              pass: false,
              detail:
                'TEETH FAILED (C-4): parseContentTableStructs on real schema.rs did not discover anchor field "' +
                anchor +
                '" — parser rot; discovered fields: ' +
                JSON.stringify(allFields),
            };
          }
        }
      }
    }
    // If files not readable (CI env issue) or parser not yet implemented, skip gracefully —
    // the RED state is caused by C-1 calling undefined checkAdditiveColumnCoupling anyway.
  }

  // C-5: Option field on table NOT written by content.rs must NOT be flagged.
  // Simulates monster.evolves_to: parseSyncedTables must not include 'monster' if
  // content.rs does not write to it.
  {
    const schemaC5 =
      '#[spacetimedb::table(name = species, public)]\n' +
      'pub struct SpeciesRow {\n' +
      '    pub species_id: u32,\n' +
      '    pub ability: Option<AbilityKind>,\n' +
      '}\n' +
      '#[spacetimedb::table(name = monster, public)]\n' +
      'pub struct MonsterRow {\n' +
      '    pub monster_id: u64,\n' +
      '    pub evolves_to: Option<u32>,\n' +
      '}\n';

    // content.rs writes to species but NOT to monster.
    const contentC5 =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    ctx.db.species().insert(SpeciesRow {\n' +
      '        species_id: 1,\n' +
      '        ability: Some(AbilityKind::Blaze),\n' +
      '    });\n' +
      '}\n';

    let result;
    try {
      result = checkAdditiveColumnCoupling(schemaC5, contentC5);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-5): checkAdditiveColumnCoupling did not return an array; got: ' +
          JSON.stringify(result),
      };
    }
    // Check that monster.evolves_to is NOT flagged (not synced — no monster write in content).
    const flagText = result.join(' ');
    if (flagText.indexOf('evolves_to') !== -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-5): checkAdditiveColumnCoupling wrongly flagged monster.evolves_to ' +
          'even though content.rs does NOT write to the monster table — synced-tables-only filter not applied; got: ' +
          flagText,
      };
    }
  }

  // C-6: heal_location_row written OUTSIDE sync_content_inner body (in a helper fn) →
  // still discovered + coupled because parseSyncedTables scopes to ALL of content.rs.
  // Also exercises multi-line chain and intermediate accessor patterns (review m-4).
  {
    const schemaC6 =
      '#[spacetimedb::table(name = heal_location, public)]\n' +
      'pub struct HealLocationRow {\n' +
      '    pub location_id: u32,\n' +
      '    pub cost_item_id: Option<u32>,\n' +
      '}\n';

    // content.rs: heal_location is written by a HELPER FUNCTION outside sync_content_inner.
    // Uses multi-line chain pattern (review m-4):
    //   ctx.db
    //       .heal_location_row()
    //       .location_id()
    //       .delete(...)
    // and the update form: ctx.db.heal_location_row().location_id().update(row)
    // parseSyncedTables must capture these (whole-file scope, D4).
    const contentC6 =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    sync_species(ctx);\n' +
      '    seed_heal_locations_from(ctx, &HEAL_LOCATIONS);\n' +
      '}\n' +
      '\n' +
      'fn seed_heal_locations_from(ctx: &ReducerContext, locations: &[HealLocationEntry]) {\n' +
      '    for row in ctx.db\n' +
      '        .heal_location_row()\n' +
      '        .iter() {\n' +
      '        ctx.db\n' +
      '            .heal_location_row()\n' +
      '            .location_id()\n' +
      '            .delete(row.location_id);\n' +
      '    }\n' +
      '    for loc in locations {\n' +
      '        ctx.db.heal_location_row().insert(HealLocationRow {\n' +
      '            location_id: loc.id,\n' +
      '            cost_item_id: loc.cost_item_id,\n' +
      '        });\n' +
      '    }\n' +
      '}\n';

    let result;
    try {
      result = checkAdditiveColumnCoupling(schemaC6, contentC6);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-6): checkAdditiveColumnCoupling must return [] for heal_location_row ' +
          'written by a helper function outside sync_content_inner (whole-file scope D4) ' +
          'with cost_item_id: present in row literal; got: ' +
          JSON.stringify(result),
      };
    }
  }

  // C-W: word-boundary tooth — `stability: x.stability` must NOT satisfy required field `ability`.
  // Uses indexOf + manual preceding-char check (no dynamic RegExp).
  // Kills any impl that does a naive indexOf('ability:') which matches inside 'stability:'.
  {
    const schemaWB =
      '#[spacetimedb::table(name = species, public)]\n' +
      'pub struct SpeciesRow {\n' +
      '    pub species_id: u32,\n' +
      '    pub ability: Option<AbilityKind>,\n' +
      '}\n';

    // The row literal has `stability:` (a different field) but NOT `ability:` standalone.
    // A naive indexOf('ability:') would match inside 'stability:ability:' or if
    // 'stability:' contains 'ability' as a substring — specifically: 'st' + 'ability' + ':'.
    // This fixture directly tests the word-boundary rule.
    const contentWB =
      'fn sync_content_inner(ctx: &ReducerContext) {\n' +
      '    ctx.db.species().insert(SpeciesRow {\n' +
      '        species_id: 1,\n' +
      '        stability: x.stability,\n' +
      '    });\n' +
      '}\n';

    let result;
    try {
      result = checkAdditiveColumnCoupling(schemaWB, contentWB);
    } catch (e) {
      result = [e.message];
    }
    if (!Array.isArray(result) || result.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-W word-boundary): checkAdditiveColumnCoupling must flag missing `ability:` ' +
          'assignment even when `stability:` (which contains "ability" as substring) is present in the ' +
          'row literal — word-boundary check required (preceding char [A-Za-z0-9_] before "ability:" must reject); got: ' +
          JSON.stringify(result),
      };
    }
    const flagText = result.join(' ');
    if (flagText.indexOf('ability') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (C-W word-boundary): violation message must mention field "ability"; got: ' +
          flagText,
      };
    }
  }

  // =========================================================================
  // END 16.5e teeth (C-1..C-6, C-W)
  // =========================================================================

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
