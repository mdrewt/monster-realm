// gate-teeth.eval.mjs — M8.7a independent anti-reward-hacking gate.
//
// This eval imports the STRENGTHENED pure functions from the three eval modules
// and asserts every proof-of-teeth criterion from the spec. It starts RED
// (functions not yet strengthened) and must turn GREEN only after the specialist
// delivers the correct implementations.
//
// Contract: default export async () => { name, pass, detail }
// On any failure: pass:false, detail naming the exact failing tooth.
// On all teeth passing AND real-source passing: pass:true.
//
// Implementation note: ALL pattern matching uses String.indexOf() or literal
// /regex/ — NO new RegExp(...) with non-literal arguments (Semgrep ReDoS gate).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SERVER_SRC = path.resolve('server-module/src');
const BASELINE_PATH = path.resolve('evals/baselines/table-schemas.json');

export default async function () {
  const name =
    'gate-teeth (M8.7a: schema-snapshot all-tables, zoned-schema broadening, recruit-security rejecting-comparison, IV-inversion real HP)';

  const failures = [];

  // =========================================================================
  // IMPORT BLOCK — defensive try/catch so a missing export yields RED, not crash
  // =========================================================================

  let parseTableSchemas, checkSchemaDrift;
  let parseTables, zoningViolations;
  let stripRustComments, extractReducerBody, checkOwnershipGuard, checkWildBattleGuard;

  try {
    const schemaSnapshotMod = await import('./battle-schema-snapshot.eval.mjs');
    parseTableSchemas = schemaSnapshotMod.parseTableSchemas;
    checkSchemaDrift = schemaSnapshotMod.checkSchemaDrift;
    if (typeof parseTableSchemas !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'RED: parseTableSchemas not exported from battle-schema-snapshot.eval.mjs (specialist has not implemented it yet)',
      };
    }
    if (typeof checkSchemaDrift !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'RED: checkSchemaDrift not exported from battle-schema-snapshot.eval.mjs (specialist has not implemented it yet)',
      };
    }
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `RED: cannot import battle-schema-snapshot.eval.mjs — ${e.message}`,
    };
  }

  try {
    const zonedSchemaMod = await import('./zoned-schema.eval.mjs');
    parseTables = zonedSchemaMod.parseTables;
    zoningViolations = zonedSchemaMod.zoningViolations;
    if (typeof parseTables !== 'function') {
      return {
        name,
        pass: false,
        detail: 'RED: parseTables not exported from zoned-schema.eval.mjs',
      };
    }
    if (typeof zoningViolations !== 'function') {
      return {
        name,
        pass: false,
        detail: 'RED: zoningViolations not exported from zoned-schema.eval.mjs',
      };
    }
  } catch (e) {
    return { name, pass: false, detail: `RED: cannot import zoned-schema.eval.mjs — ${e.message}` };
  }

  try {
    const recruitSecMod = await import('./recruit-reducer-security.eval.mjs');
    stripRustComments = recruitSecMod.stripRustComments;
    extractReducerBody = recruitSecMod.extractReducerBody;
    checkOwnershipGuard = recruitSecMod.checkOwnershipGuard;
    checkWildBattleGuard = recruitSecMod.checkWildBattleGuard;
    if (typeof stripRustComments !== 'function') {
      return {
        name,
        pass: false,
        detail: 'RED: stripRustComments not exported from recruit-reducer-security.eval.mjs',
      };
    }
    if (typeof extractReducerBody !== 'function') {
      return {
        name,
        pass: false,
        detail: 'RED: extractReducerBody not exported from recruit-reducer-security.eval.mjs',
      };
    }
    if (typeof checkOwnershipGuard !== 'function') {
      return {
        name,
        pass: false,
        detail: 'RED: checkOwnershipGuard not exported from recruit-reducer-security.eval.mjs',
      };
    }
    if (typeof checkWildBattleGuard !== 'function') {
      return {
        name,
        pass: false,
        detail: 'RED: checkWildBattleGuard not exported from recruit-reducer-security.eval.mjs',
      };
    }
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `RED: cannot import recruit-reducer-security.eval.mjs — ${e.message}`,
    };
  }

  // =========================================================================
  // Read the real source files up front (needed by multiple teeth)
  // =========================================================================

  let realSrc;
  try {
    realSrc = readServerModuleSources(SERVER_SRC);
  } catch (e) {
    return { name, pass: false, detail: `RED: cannot read ${SERVER_SRC}: ${e.message}` };
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `RED: cannot read baseline ${BASELINE_PATH}: ${e.message}`,
    };
  }

  // =========================================================================
  // SCHEMA-SNAPSHOT TEETH (items 1–6)
  // =========================================================================

  // --- TOOTH 1: parseTableSchemas on real source returns all 15 tables ---
  // The new parseTableSchemas must key on #[spacetimedb::table(] and EXCLUDE
  // EncounterEntryRow (which is #[derive(SpacetimeType)], not a table).
  // Kills: an impl that falls back to the old parseTableColumns (returns fields,
  // not typed columns) or accidentally includes EncounterEntryRow.
  let parsed;
  try {
    parsed = parseTableSchemas(realSrc);
  } catch (e) {
    failures.push(`TOOTH 1 FAILED: parseTableSchemas threw on real source — ${e.message}`);
    parsed = null;
  }

  // Defensive object guard: a bad impl returning a non-object (string/number/array)
  // would cause `'x' in parsed` to throw an uncaught TypeError, crashing run.mjs.
  if (parsed !== null && typeof parsed !== 'object') {
    failures.push(
      `TOOTH 1 FAILED: parseTableSchemas returned a non-object (${typeof parsed}) — must return a plain object keyed by table name`,
    );
    parsed = null;
  }

  if (parsed !== null) {
    if ('EncounterEntryRow' in parsed) {
      failures.push(
        'TOOTH 1 FAILED: parseTableSchemas included EncounterEntryRow, which is a SpacetimeType struct, not a table — parser must key only on #[spacetimedb::table(',
      );
    }

    // Check count: 15 expected tables from the baseline
    const expectedTableNames = Object.keys(baseline);
    const _parsedTableNames = Object.keys(parsed);
    const missingTables = expectedTableNames.filter((t) => !(t in parsed));
    if (missingTables.length > 0) {
      failures.push(
        `TOOTH 1 FAILED: parseTableSchemas missing ${missingTables.length} table(s): ${missingTables.join(', ')}`,
      );
    }

    // Spot-check: inventory.pk === 'inv_id'
    if (parsed.inventory) {
      if (parsed.inventory.pk !== 'inv_id') {
        failures.push(
          `TOOTH 1 FAILED: parsed.inventory.pk is '${parsed.inventory.pk}', expected 'inv_id'`,
        );
      }
      // inventory.columns.count === 'u32'
      if (parsed.inventory.columns?.count !== 'u32') {
        failures.push(
          `TOOTH 1 FAILED: parsed.inventory.columns.count is '${parsed.inventory?.columns?.count}', expected 'u32'`,
        );
      }
    } else {
      failures.push('TOOTH 1 FAILED: parsed.inventory is absent');
    }

    // Spot-check: encounter.pk === 'zone_id'
    if (parsed.encounter) {
      if (parsed.encounter.pk !== 'zone_id') {
        failures.push(
          `TOOTH 1 FAILED: parsed.encounter.pk is '${parsed.encounter.pk}', expected 'zone_id'`,
        );
      }
      // encounter.columns.entries === 'Vec<EncounterEntryRow>'
      if (parsed.encounter.columns?.entries !== 'Vec<EncounterEntryRow>') {
        failures.push(
          `TOOTH 1 FAILED: parsed.encounter.columns.entries is '${parsed.encounter?.columns?.entries}', expected 'Vec<EncounterEntryRow>'`,
        );
      }
    } else {
      failures.push('TOOTH 1 FAILED: parsed.encounter is absent');
    }
  }

  // --- TOOTH 2: real source drift-free against committed baseline ---
  // Kills: a parseTableSchemas that produces a superset/subset of columns,
  // wrong types, or wrong PK for any table.
  if (parsed !== null) {
    let drift;
    try {
      drift = checkSchemaDrift(parsed, baseline);
    } catch (e) {
      failures.push(
        `TOOTH 2 FAILED: checkSchemaDrift threw on real source vs baseline — ${e.message}`,
      );
      drift = null;
    }
    if (drift !== null) {
      if (!Array.isArray(drift)) {
        failures.push(`TOOTH 2 FAILED: checkSchemaDrift must return an array, got ${typeof drift}`);
      } else if (drift.length > 0) {
        failures.push(`TOOTH 2 FAILED: real source drifts from baseline — ${drift.join('; ')}`);
      }
    }
  }

  // --- TOOTH 3: column DROP bites (non-battle table: inventory.count removed) ---
  // Inline Rust fixture exercises the parser. Kills: a checkSchemaDrift that only
  // checks presence of baseline columns in parsed (not vice-versa) — i.e., it
  // would wrongly PASS a parsed map that is a subset of baseline.
  {
    const dropFixtureSrc = `
#[spacetimedb::table(name = inventory, public)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    // count field deliberately REMOVED to test column-drop detection
}
`;
    let dropParsed;
    try {
      dropParsed = parseTableSchemas(dropFixtureSrc);
    } catch (e) {
      failures.push(`TOOTH 3 FAILED: parseTableSchemas threw on drop fixture — ${e.message}`);
      dropParsed = null;
    }
    if (dropParsed !== null) {
      let dropDrift;
      try {
        // Build a minimal baseline with just the inventory table for this check
        const inventoryOnlyBaseline = { inventory: baseline.inventory };
        dropDrift = checkSchemaDrift(dropParsed, inventoryOnlyBaseline);
      } catch (e) {
        failures.push(`TOOTH 3 FAILED: checkSchemaDrift threw on drop fixture — ${e.message}`);
        dropDrift = null;
      }
      if (dropDrift !== null) {
        if (!Array.isArray(dropDrift) || dropDrift.length === 0) {
          failures.push(
            'TOOTH 3 FAILED: column DROP on inventory.count was NOT flagged by checkSchemaDrift — exact-match must catch removals (a SetMove-style append-only check wrongly passes this)',
          );
        }
      }
    }
  }

  // --- TOOTH 4: PK CHANGE bites (encounter.pk changed from zone_id to encounter_rate) ---
  // Kills: a checkSchemaDrift that ignores PK changes (checks only column sets).
  {
    const pkFixtureSrc = `
#[spacetimedb::table(name = encounter)]
pub struct EncounterRow {
    pub zone_id: u32,
    #[primary_key]
    pub encounter_rate: u16,
    pub entries: Vec<EncounterEntryRow>,
}
`;
    let pkParsed;
    try {
      pkParsed = parseTableSchemas(pkFixtureSrc);
    } catch (e) {
      failures.push(`TOOTH 4 FAILED: parseTableSchemas threw on PK-change fixture — ${e.message}`);
      pkParsed = null;
    }
    if (pkParsed !== null) {
      let pkDrift;
      try {
        const encounterOnlyBaseline = { encounter: baseline.encounter };
        pkDrift = checkSchemaDrift(pkParsed, encounterOnlyBaseline);
      } catch (e) {
        failures.push(`TOOTH 4 FAILED: checkSchemaDrift threw on PK-change fixture — ${e.message}`);
        pkDrift = null;
      }
      if (pkDrift !== null) {
        if (!Array.isArray(pkDrift) || pkDrift.length === 0) {
          failures.push(
            'TOOTH 4 FAILED: PK CHANGE on encounter (zone_id → encounter_rate) was NOT flagged by checkSchemaDrift — PK drift must be caught',
          );
        }
      }
    }
  }

  // --- TOOTH 5: TYPE CHANGE bites (inventory.count changed u32 → u16) ---
  // Kills: a checkSchemaDrift that only checks field names, not declared types.
  {
    const typeFixtureSrc = `
#[spacetimedb::table(name = inventory, public)]
pub struct Inventory {
    #[primary_key]
    #[auto_inc]
    pub inv_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    pub count: u16,
}
`;
    let typeParsed;
    try {
      typeParsed = parseTableSchemas(typeFixtureSrc);
    } catch (e) {
      failures.push(
        `TOOTH 5 FAILED: parseTableSchemas threw on type-change fixture — ${e.message}`,
      );
      typeParsed = null;
    }
    if (typeParsed !== null) {
      let typeDrift;
      try {
        const inventoryOnlyBaseline = { inventory: baseline.inventory };
        typeDrift = checkSchemaDrift(typeParsed, inventoryOnlyBaseline);
      } catch (e) {
        failures.push(
          `TOOTH 5 FAILED: checkSchemaDrift threw on type-change fixture — ${e.message}`,
        );
        typeDrift = null;
      }
      if (typeDrift !== null) {
        if (!Array.isArray(typeDrift) || typeDrift.length === 0) {
          failures.push(
            'TOOTH 5 FAILED: TYPE CHANGE on inventory.count (u32 → u16) was NOT flagged by checkSchemaDrift — declared-type drift must be caught',
          );
        }
      }
    }
  }

  // --- TOOTH 6: ADDITIVE column bites (proves exact-match) ---
  // inventory gets an extra `extra: u8` field. The OLD schema-snapshot eval used
  // subset checks (only "are expected cols present?") and would WRONGLY pass this.
  // Kills: any implementation that uses subset checking instead of exact-match.
  // Structural clone approach acceptable here per spec: mutate parsed object directly.
  if (parsed?.inventory) {
    const additiveParsed = {
      inventory: {
        pk: parsed.inventory.pk,
        columns: { ...parsed.inventory.columns, extra: 'u8' },
      },
    };
    let addDrift;
    try {
      const inventoryOnlyBaseline = { inventory: baseline.inventory };
      addDrift = checkSchemaDrift(additiveParsed, inventoryOnlyBaseline);
    } catch (e) {
      failures.push(
        `TOOTH 6 FAILED: checkSchemaDrift threw on additive-column clone — ${e.message}`,
      );
      addDrift = null;
    }
    if (addDrift !== null) {
      if (!Array.isArray(addDrift) || addDrift.length === 0) {
        failures.push(
          'TOOTH 6 FAILED: ADDITIVE column (inventory.extra: u8) was NOT flagged by checkSchemaDrift — exact-match must catch additions (subset-only check wrongly passes this; the old battle-columns approach had this flaw)',
        );
      }
    }
  } else if (parsed !== null) {
    failures.push('TOOTH 6 FAILED: parsed.inventory absent — cannot run additive-column tooth');
  }

  // =========================================================================
  // ZONED-SCHEMA TEETH (items 7–11)
  // =========================================================================

  // --- TOOTH 7: existing zoneless-spatial ghost tooth still FLAGGED ---
  // The broadened zoningViolations must still catch the original tile_x/tile_y case.
  // Kills: an impl that removed the tile_x/tile_y check while adding zone_id support.
  {
    const ghostSrc =
      '#[spacetimedb::table(name = ghost, public)]\npub struct Ghost {\n  pub tile_x: i32,\n  pub tile_y: i32,\n}';
    let ghostTables, ghostViolations;
    try {
      ghostTables = parseTables(ghostSrc);
      ghostViolations = zoningViolations(ghostTables);
    } catch (e) {
      failures.push(
        `TOOTH 7 FAILED: parseTables/zoningViolations threw on ghost fixture — ${e.message}`,
      );
      ghostViolations = null;
    }
    if (ghostViolations !== null) {
      if (!Array.isArray(ghostViolations) || ghostViolations.length === 0) {
        failures.push(
          'TOOTH 7 FAILED: existing zoneless-spatial ghost fixture (tile_x/tile_y, no indexed zone_id) NOT flagged by zoningViolations — the original tile-bearing check must be preserved',
        );
      }
    }
  }

  // --- TOOTH 8: encounter-shaped tooth PASSES (zone_id as primary_key) ---
  // Real encounter table uses zone_id as PK (not an index). The broadened eval
  // must recognise PK as satisfying the zoning requirement.
  // Kills: an impl that only accepts #[index(btree)] and not #[primary_key] for zone_id.
  {
    const encounterFixtureSrc = `
#[spacetimedb::table(name = encounter)]
pub struct EncounterRow {
    #[primary_key]
    pub zone_id: u32,
    pub encounter_rate: u16,
    pub entries: Vec<EncounterEntryRow>,
}
`;
    let encTables, encViolations;
    try {
      encTables = parseTables(encounterFixtureSrc);
      encViolations = zoningViolations(encTables);
    } catch (e) {
      failures.push(
        `TOOTH 8 FAILED: parseTables/zoningViolations threw on encounter fixture — ${e.message}`,
      );
      encViolations = null;
    }
    if (encViolations !== null) {
      if (!Array.isArray(encViolations) || encViolations.length > 0) {
        failures.push(
          `TOOTH 8 FAILED: encounter-shaped fixture (zone_id as #[primary_key]) was incorrectly FLAGGED as a violation — PK satisfies the zoning requirement; violations: ${encViolations?.join(', ')}`,
        );
      }
    }
  }

  // --- TOOTH 9: bare zone_id tooth FLAGGED (no PK, no index, no scheduled) ---
  // A table declaring `pub zone_id: u32` with no attribute must be flagged.
  // Kills: an impl that only checks tile_x/tile_y tables (the old behavior).
  // This is the KEY new behavior of the broadened eval.
  {
    const bareZoneFixtureSrc = `
#[spacetimedb::table(name = stray_zone, public)]
pub struct StrayZone {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub zone_id: u32,
    pub some_data: String,
}
`;
    let bzTables, bzViolations;
    try {
      bzTables = parseTables(bareZoneFixtureSrc);
      bzViolations = zoningViolations(bzTables);
    } catch (e) {
      failures.push(
        `TOOTH 9 FAILED: parseTables/zoningViolations threw on bare-zone_id fixture — ${e.message}`,
      );
      bzViolations = null;
    }
    if (bzViolations !== null) {
      if (!Array.isArray(bzViolations) || bzViolations.length === 0) {
        failures.push(
          'TOOTH 9 FAILED: bare zone_id table (no PK, no index) NOT flagged by zoningViolations — the broadened eval must flag any table with zone_id/map_id that is neither PK nor btree-indexed (ADR-0007). The OLD eval only checked tile_x/tile_y tables and would wrongly PASS this.',
        );
      }
    }
  }

  // --- TOOTH 10: scheduler carve-out PASSES (scheduled( attr + bare zone_id) ---
  // movement_tick_schedule has `zone_id: u32` as plain field (no PK, no index)
  // but it is a scheduler table — it must NOT be flagged.
  // The carve-out must read the attribute string, not the body.
  // Kills: an impl that ignores the scheduled( carve-out.
  {
    const schedFixtureSrc = `
#[spacetimedb::table(name = movement_tick_schedule, scheduled(movement_tick))]
pub struct MovementTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub zone_id: u32,
    pub scheduled_at: ScheduleAt,
}
`;
    let schedTables, schedViolations;
    try {
      schedTables = parseTables(schedFixtureSrc);
      schedViolations = zoningViolations(schedTables);
    } catch (e) {
      failures.push(
        `TOOTH 10 FAILED: parseTables/zoningViolations threw on scheduler fixture — ${e.message}`,
      );
      schedViolations = null;
    }
    if (schedViolations !== null) {
      if (!Array.isArray(schedViolations) || schedViolations.length > 0) {
        failures.push(
          `TOOTH 10 FAILED: scheduler carve-out fixture (scheduled(movement_tick) + bare zone_id) was incorrectly FLAGGED — tables whose attribute contains 'scheduled(' are exempt from the zone_id index requirement (ADR-0007 D5); violations: ${schedViolations?.join(', ')}`,
        );
      }
    }
  }

  // --- TOOTH 11: real source has NO zoned violation ---
  // character has #[index(btree)] zone_id; zone_def/encounter have zone_id as PK;
  // movement_tick_schedule is carved out. All other tables have no zone_id.
  // Kills: a broadened impl that over-flags real tables it shouldn't.
  // If this fails RED because the function isn't broadened yet, that is expected —
  // the specialist makes it green WITHOUT editing server source.
  {
    let realTables, realViolations;
    try {
      realTables = parseTables(realSrc);
      realViolations = zoningViolations(realTables);
    } catch (e) {
      failures.push(
        `TOOTH 11 FAILED: parseTables/zoningViolations threw on real source — ${e.message}`,
      );
      realViolations = null;
    }
    if (realViolations !== null) {
      if (!Array.isArray(realViolations) || realViolations.length > 0) {
        failures.push(
          `TOOTH 11 FAILED: real server source has zoned violations — ${realViolations?.join(', ')}. Expected 0 violations (character indexed, zone_def/encounter PK, movement_tick_schedule carved out). This failure is expected RED until zoningViolations is broadened correctly by the specialist.`,
        );
      }
    }
  }

  // =========================================================================
  // RECRUIT-SECURITY TEETH (items 12–15)
  // =========================================================================

  // --- TOOTH 12: real attempt_recruit PASSES both STRENGTHENED checks ---
  // The real code (lib.rs:1927–1953) uses:
  //   let me = ctx.sender;
  //   if battle.player_identity != me { ...; return Err(e); }
  //   match ctx.db.battle_wild().battle_id().find(battle_id) { Some(bw) => bw, None => { ...; return Err(e); } }
  // The STRENGTHENED checkOwnershipGuard must recognise the `me` alias pattern.
  // The STRENGTHENED checkWildBattleGuard must recognise the lookup+None-reject pattern.
  // Kills: a strengthened impl that is TOO strict and breaks on the real code's alias.
  {
    let realStripped, realRecruitBody;
    try {
      realStripped = stripRustComments(realSrc);
      realRecruitBody = extractReducerBody(realStripped, 'attempt_recruit');
    } catch (e) {
      failures.push(
        `TOOTH 12 FAILED: stripRustComments/extractReducerBody threw on real source — ${e.message}`,
      );
      realRecruitBody = null;
    }
    if (realRecruitBody !== null) {
      if (realRecruitBody === null || realRecruitBody === undefined) {
        failures.push(
          'TOOTH 12 FAILED: extractReducerBody returned null for attempt_recruit in real source — function not found',
        );
      } else {
        let ownerErr, wildErr;
        try {
          ownerErr = checkOwnershipGuard(realRecruitBody);
        } catch (e) {
          failures.push(
            `TOOTH 12 FAILED: checkOwnershipGuard threw on real attempt_recruit body — ${e.message}`,
          );
          ownerErr = 'threw';
        }
        try {
          wildErr = checkWildBattleGuard(realRecruitBody);
        } catch (e) {
          failures.push(
            `TOOTH 12 FAILED: checkWildBattleGuard threw on real attempt_recruit body — ${e.message}`,
          );
          wildErr = 'threw';
        }
        if (ownerErr !== null && ownerErr !== undefined) {
          failures.push(
            `TOOTH 12 FAILED: checkOwnershipGuard REJECTED real attempt_recruit (which correctly uses 'let me = ctx.sender; if battle.player_identity != me { return Err }') — the strengthened check must recognise the me-alias pattern. Error: ${ownerErr}`,
          );
        }
        if (wildErr !== null && wildErr !== undefined) {
          failures.push(
            `TOOTH 12 FAILED: checkWildBattleGuard REJECTED real attempt_recruit (which correctly uses match ctx.db.battle_wild()...find(...) { Some(bw)=>bw, None=>{ return Err } }) — the strengthened check must recognise the lookup+None-reject pattern. Error: ${wildErr}`,
          );
        }
      }
    } else {
      failures.push('TOOTH 12 FAILED: could not extract real attempt_recruit body');
    }
  }

  // --- TOOTH 13: ownership no-rejection bad fixture BITES ---
  // This body MENTIONS player_identity AND ctx.sender but wires NO != comparison
  // that leads to Err. The OLD substring check wrongly passes it (both tokens present).
  // The STRENGTHENED check must require the rejecting comparison.
  // Kills: the old checkOwnershipGuard (pure substring presence).
  {
    const BAD_OWNERSHIP_NO_REJECTION = `
pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64, bait_item_id: Option<u32>) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = ctx.db.battle().battle_id().find(battle_id)
        .ok_or_else(|| "battle not found".to_string())?;
    // DELIBERATELY WEAK: both tokens present but no != comparison that leads to Err.
    // A logging call that mentions player_identity should NOT satisfy the ownership guard.
    log::info!("attempt_recruit: caller={:?}, battle.player_identity={:?}", ctx.sender, battle.player_identity);
    if battle.state.outcome != BattleOutcome::Ongoing {
        return Err("not ongoing".to_string());
    }
    let wild = ctx.db.battle_wild().battle_id().find(battle_id)
        .ok_or_else(|| "not a wild battle".to_string())?;
    let roll: u32 = ctx.random();
    write_back_party_hp(ctx, &battle);
    ctx.db.battle_wild().battle_id().delete(battle_id);
    Ok(())
}
`;
    let badOwnerBody, badOwnerResult;
    try {
      badOwnerBody = extractReducerBody(
        stripRustComments(BAD_OWNERSHIP_NO_REJECTION),
        'attempt_recruit',
      );
    } catch (e) {
      failures.push(
        `TOOTH 13 FAILED: extractReducerBody threw on BAD_OWNERSHIP_NO_REJECTION fixture — ${e.message}`,
      );
      badOwnerBody = null;
    }
    if (badOwnerBody !== null) {
      try {
        badOwnerResult = checkOwnershipGuard(badOwnerBody);
      } catch (e) {
        failures.push(
          `TOOTH 13 FAILED: checkOwnershipGuard threw on bad-ownership fixture — ${e.message}`,
        );
        badOwnerResult = 'threw';
      }
      if (badOwnerResult === null || badOwnerResult === undefined) {
        failures.push(
          'TOOTH 13 FAILED: ownership no-rejection fixture (player_identity + ctx.sender present, but no != then Err) NOT flagged by checkOwnershipGuard. The OLD substring-presence check wrongly passes this — the STRENGTHENED check must require a rejecting != comparison followed by Err (see spec §3 "reject-comparison" requirement).',
        );
      }
    }
  }

  // --- TOOTH 14: wild no-rejection bad fixture BITES ---
  // This body has battle_wild( ONLY in the GC .delete() call, no lookup that rejects
  // on None. The OLD check (mere battle_wild( presence) wrongly passes it.
  // The STRENGTHENED checkWildBattleGuard must require a lookup whose not-found path
  // rejects (None => return Err / ok_or_else / ?).
  // Kills: the old checkWildBattleGuard (pure substring presence on 'battle_wild(').
  {
    const BAD_WILD_NO_REJECTION = `
pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64, bait_item_id: Option<u32>) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = ctx.db.battle().battle_id().find(battle_id)
        .ok_or_else(|| "battle not found".to_string())?;
    if battle.player_identity != me {
        return Err("not owner".to_string());
    }
    if battle.state.outcome != BattleOutcome::Ongoing {
        return Err("not ongoing".to_string());
    }
    // DELIBERATELY WRONG: battle_wild( appears ONLY in a GC delete, no lookup+reject.
    // The old check sees 'battle_wild(' and passes. The strengthened check must
    // require a lookup whose None arm returns Err.
    let roll: u32 = ctx.random();
    write_back_party_hp(ctx, &battle);
    ctx.db.battle_wild().battle_id().delete(battle_id);
    Ok(())
}
`;
    let badWildBody, badWildResult;
    try {
      badWildBody = extractReducerBody(stripRustComments(BAD_WILD_NO_REJECTION), 'attempt_recruit');
    } catch (e) {
      failures.push(
        `TOOTH 14 FAILED: extractReducerBody threw on BAD_WILD_NO_REJECTION fixture — ${e.message}`,
      );
      badWildBody = null;
    }
    if (badWildBody !== null) {
      try {
        badWildResult = checkWildBattleGuard(badWildBody);
      } catch (e) {
        failures.push(
          `TOOTH 14 FAILED: checkWildBattleGuard threw on bad-wild fixture — ${e.message}`,
        );
        badWildResult = 'threw';
      }
      if (badWildResult === null || badWildResult === undefined) {
        failures.push(
          'TOOTH 14 FAILED: wild no-rejection fixture (battle_wild( only in GC .delete(), no lookup+None-reject) NOT flagged by checkWildBattleGuard. The OLD check sees "battle_wild(" and wrongly passes — the STRENGTHENED check must require a lookup pattern whose not-found path rejects with Err.',
        );
      }
    }
  }

  // --- TOOTH 15: ownership GOOD fixtures PASS (alias form AND direct form) ---
  // The strengthened check must accept BOTH:
  //   (a) alias form:  let me = ctx.sender; if battle.player_identity != me { return Err(...); }
  //   (b) direct form: if battle.player_identity != ctx.sender { return Err(...) }
  // Kills: an impl that is too narrow and only accepts one form.
  {
    const GOOD_ALIAS_FORM = `
pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = ctx.db.battle().battle_id().find(battle_id)
        .ok_or_else(|| "not found".to_string())?;
    if battle.player_identity != me {
        return Err("x".into());
    }
    let bw = ctx.db.battle_wild().battle_id().find(battle_id)
        .ok_or_else(|| "not wild".to_string())?;
    Ok(())
}
`;
    const GOOD_DIRECT_FORM = `
pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
    let mut battle = ctx.db.battle().battle_id().find(battle_id)
        .ok_or_else(|| "not found".to_string())?;
    if battle.player_identity != ctx.sender {
        return Err("not owner".to_string());
    }
    let bw = ctx.db.battle_wild().battle_id().find(battle_id)
        .ok_or_else(|| "not wild".to_string())?;
    Ok(())
}
`;

    for (const [label, src] of [
      ['alias (let me = ctx.sender)', GOOD_ALIAS_FORM],
      ['direct (ctx.sender)', GOOD_DIRECT_FORM],
    ]) {
      let goodBody, goodResult;
      try {
        goodBody = extractReducerBody(stripRustComments(src), 'attempt_recruit');
      } catch (e) {
        failures.push(`TOOTH 15 FAILED [${label}]: extractReducerBody threw — ${e.message}`);
        goodBody = null;
      }
      if (goodBody !== null) {
        try {
          goodResult = checkOwnershipGuard(goodBody);
        } catch (e) {
          failures.push(`TOOTH 15 FAILED [${label}]: checkOwnershipGuard threw — ${e.message}`);
          goodResult = 'threw';
        }
        if (goodResult !== null && goodResult !== undefined) {
          failures.push(
            `TOOTH 15 FAILED [${label}]: GOOD ownership fixture incorrectly flagged by checkOwnershipGuard: ${goodResult}. The strengthened check must accept both alias form (let me = ctx.sender; ... != me) and direct form (... != ctx.sender).`,
          );
        }
      }
    }
  }

  // =========================================================================
  // TOOTH 16 — extra-table direction of checkSchemaDrift (table-level exact-match)
  // =========================================================================
  // A parsed map with an EXTRA table not in the baseline must be flagged.
  // Kills: a checkSchemaDrift that only iterates baseline keys (one-directional
  // at the table level) — it would see every baseline table is present and wrongly
  // return []. The extra table `ghost_table` is in parsed but absent from baseline.
  if (parsed?.inventory) {
    const extraTableParsed = {
      inventory: parsed.inventory,
      ghost_table: { pk: 'id', columns: { id: 'u64' } },
    };
    let extraDrift;
    try {
      const inventoryOnlyBaseline = { inventory: baseline.inventory };
      extraDrift = checkSchemaDrift(extraTableParsed, inventoryOnlyBaseline);
    } catch (e) {
      failures.push(
        `TOOTH 16 FAILED: checkSchemaDrift threw on extra-table parsed map — ${e.message}`,
      );
      extraDrift = null;
    }
    if (extraDrift !== null) {
      if (!Array.isArray(extraDrift) || extraDrift.length === 0) {
        failures.push(
          'TOOTH 16 FAILED: parsed map with extra table ghost_table (absent from baseline) was NOT flagged by checkSchemaDrift — table-level exact-match must be bidirectional (checked in both parsed-vs-baseline and baseline-vs-parsed directions); a one-directional impl that only iterates baseline keys wrongly passes this',
        );
      }
    }
  } else if (parsed !== null) {
    failures.push('TOOTH 16 FAILED: parsed.inventory absent — cannot run extra-table tooth');
  }

  // =========================================================================
  // TOOTH 17 — scheduler carve-out must be ATTRIBUTE-based, not body-based
  // =========================================================================
  // A non-scheduler table that has a `ScheduleAt` field type AND a bare zone_id
  // (no PK/index, NO `scheduled(` in its attribute) MUST be FLAGGED.
  // Kills: a sloppy carve-out that exempts via t.body.includes('ScheduleAt')
  // instead of t.attr.includes('scheduled(') — the body-based carve-out would
  // wrongly pass this fixture because it sees `ScheduleAt` in the struct body.
  {
    const notSchedulerFixtureSrc = `
#[spacetimedb::table(name = not_a_scheduler, public)]
pub struct NotAScheduler {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub zone_id: u32,
    pub when: ScheduleAt,
}
`;
    let nsTables, nsViolations;
    try {
      nsTables = parseTables(notSchedulerFixtureSrc);
      nsViolations = zoningViolations(nsTables);
    } catch (e) {
      failures.push(
        `TOOTH 17 FAILED: parseTables/zoningViolations threw on not-a-scheduler fixture — ${e.message}`,
      );
      nsViolations = null;
    }
    if (nsViolations !== null) {
      if (!Array.isArray(nsViolations) || nsViolations.length === 0) {
        failures.push(
          "TOOTH 17 FAILED: non-scheduler table with ScheduleAt field type + bare zone_id (no 'scheduled(' in attribute) was NOT flagged by zoningViolations — the scheduler carve-out MUST key on the table's attribute string containing 'scheduled(', NOT on the struct body containing 'ScheduleAt'; a body-based carve-out wrongly exempts this table",
        );
      }
    }
  }

  // =========================================================================
  // TOOTH 18 — baseline contains all spec-required tables (EARS lock)
  // =========================================================================
  // Spec §3 ("Schema-snapshot gate") requires the baseline to include at minimum:
  // encounter, battle_wild, inventory, item_row, monster, monster_pub.
  // This tooth asserts those keys exist in the committed baseline JSON so that
  // a future baseline-pruning edit cannot silently narrow coverage below the spec
  // floor without failing this gate.
  for (const t of ['encounter', 'battle_wild', 'inventory', 'item_row', 'monster', 'monster_pub']) {
    if (!(t in baseline)) {
      failures.push(
        `TOOTH 18 FAILED: baseline missing required table '${t}' (spec §3 requires encounter, battle_wild, inventory, item_row, monster, monster_pub at minimum — a future baseline-pruning edit must not shrink coverage below this floor)`,
      );
    }
  }

  // =========================================================================
  // TOOTH 19 — ownership: two-alias GOOD fixture must PASS
  // =========================================================================
  // A body that declares TWO `ctx.sender` aliases and guards with the SECOND
  // must pass checkOwnershipGuard. Kills: a first-alias-only capture that binds
  // `caller` (the first alias) and then fails to recognise `!= me` (the second).
  // Currently RED: the current check captures only the first `let <alias> = ctx.sender`
  // binding, so `player_identity != me` is not recognised when `caller` was first.
  {
    const GOOD_TWO_ALIAS = `
pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
    let caller = ctx.sender;
    let me = ctx.sender;
    let mut battle = ctx.db.battle().battle_id().find(battle_id)
        .ok_or_else(|| "not found".to_string())?;
    if battle.player_identity != me {
        return Err("not owner".to_string());
    }
    let bw = ctx.db.battle_wild().battle_id().find(battle_id)
        .ok_or_else(|| "not wild".to_string())?;
    let _ = caller;
    Ok(())
}
`;
    let t19Body, t19Result;
    try {
      t19Body = extractReducerBody(stripRustComments(GOOD_TWO_ALIAS), 'attempt_recruit');
    } catch (e) {
      failures.push(
        `TOOTH 19 FAILED: extractReducerBody threw on two-alias GOOD fixture — ${e.message}`,
      );
      t19Body = null;
    }
    if (t19Body !== null) {
      try {
        t19Result = checkOwnershipGuard(t19Body);
      } catch (e) {
        failures.push(
          `TOOTH 19 FAILED: checkOwnershipGuard threw on two-alias GOOD fixture — ${e.message}`,
        );
        t19Result = 'threw';
      }
      if (t19Result !== null && t19Result !== undefined) {
        failures.push(
          `TOOTH 19 FAILED: two-alias GOOD fixture (let caller = ctx.sender; let me = ctx.sender; ... if battle.player_identity != me { return Err }) was INCORRECTLY FLAGGED by checkOwnershipGuard: ${t19Result}. A first-alias-only capture binds 'caller' and then fails to recognise '!= me' — the strengthened check must collect ALL aliases bound to ctx.sender and accept any of them in the != comparison.`,
        );
      }
    }
  }

  // =========================================================================
  // TOOTH 20 — wild: discarded battle_wild lookup must be FLAGGED
  // =========================================================================
  // A body that calls battle_wild().find() but DISCARDS the result (semicolon,
  // no binding, no rejection), with an unrelated ok_or_else from a different
  // lookup nearby, must be FLAGGED by checkWildBattleGuard.
  // Kills: a check that sees `.find(` after `battle_wild(` and an `ok_or` within
  // the window and wrongly passes — the rejection must bind to the battle_wild
  // lookup specifically, not to an unrelated query. A discarded `;` result
  // (`let _ = ctx.db.battle_wild()...find(...);`) does not reject on not-wild.
  {
    const BAD_WILD_DISCARDED = `
pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = ctx.db.battle().battle_id().find(battle_id)
        .ok_or_else(|| "battle not found".to_string())?;
    if battle.player_identity != me {
        return Err("not owner".to_string());
    }
    let _ = ctx.db.battle_wild().battle_id().find(battle_id);
    let _species = ctx.db.species_row().id().find(99u32).ok_or_else(|| "no species".to_string())?;
    ctx.db.battle_wild().battle_id().delete(battle_id);
    Ok(())
}
`;
    let t20Body, t20Result;
    try {
      t20Body = extractReducerBody(stripRustComments(BAD_WILD_DISCARDED), 'attempt_recruit');
    } catch (e) {
      failures.push(
        `TOOTH 20 FAILED: extractReducerBody threw on discarded-lookup BAD fixture — ${e.message}`,
      );
      t20Body = null;
    }
    if (t20Body !== null) {
      try {
        t20Result = checkWildBattleGuard(t20Body);
      } catch (e) {
        failures.push(
          `TOOTH 20 FAILED: checkWildBattleGuard threw on discarded-lookup BAD fixture — ${e.message}`,
        );
        t20Result = 'threw';
      }
      if (t20Result === null || t20Result === undefined) {
        failures.push(
          'TOOTH 20 FAILED: discarded battle_wild lookup fixture (let _ = ctx.db.battle_wild()...find(...); result discarded, unrelated ok_or_else nearby) was NOT flagged by checkWildBattleGuard. The current check wrongly passes because it finds .find( after battle_wild( and an ok_or within the window — but that ok_or binds to a different lookup (species_row), not the wild guard. The strengthened check must require the rejection to bind directly to the battle_wild lookup result; a discarded semicolon result must NOT satisfy it.',
        );
      }
    }
  }

  // =========================================================================
  // RESULT — report ALL failures so the specialist sees every failing tooth
  // =========================================================================

  if (failures.length > 0) {
    return {
      name,
      pass: false,
      detail: failures.join(' | '),
    };
  }

  return {
    name,
    pass: true,
    detail:
      'All 20 gate-teeth pass: schema-snapshot (all-tables, EncounterEntryRow excluded, drift-free, drop/PK/type/additive/extra-table all bite), zoned-schema (ghost still flagged, encounter-PK passes, bare-zone_id flagged, scheduler attr-carve-out correct, non-scheduler ScheduleAt-body NOT exempted, real source clean), recruit-security (real code passes strengthened checks, no-rejection bad fixtures bite, two-alias GOOD passes, discarded-lookup BAD flagged, good alias+direct forms pass), baseline contains all 6 spec-required tables',
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
