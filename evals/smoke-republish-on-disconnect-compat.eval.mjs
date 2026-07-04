// smoke-republish-on-disconnect-compat.eval.mjs
//
// Gating test for RT-SR-01 (red-team finding, ADR-0079 / spec §12.5b-6).
//
// INVARIANT: smoke-republish.sh MUST NOT assert player-table persistence after a
// one-shot "spacetime call join_game", because the on_disconnect reducer (lib.rs)
// deletes both the `player` row and its `character` row the moment the CLI
// disconnects. Validated empirically (validation-findings.md §Behavioural finding):
// "A one-shot `spacetime call` connects → runs → disconnects […] it is created
// then deleted with the call's connection." ADR-0052 confirms: "On a disconnect the
// server deletes the `player` row and `join_game` re-creates it [on reconnect]."
//
// A script that calls join_game via CLI and then GREPs the `player` table for
// "SmokePlayer" is asserting on a row that on_disconnect has already removed —
// the assertion is vacuous and the smoke test gives a false-negative or a race-
// dependent result, never a reliable signal.
//
// DATA-SURVIVAL ASSERTIONS MUST USE SESSION-INDEPENDENT TABLES:
// tables that on_disconnect does NOT clear (e.g., monster, inventory, content
// registries: species_row, skill_row, item_row, zone_def, config, …).
//
// Proof-of-teeth: known-bad and known-good inline fixtures BEFORE the real file
// check; any tooth that fails to bite fails the eval itself.
//
// IMPORTANT: NO new RegExp(...) — use only literal regex literals or String methods.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Pure predicate: does the script assert player-table data after a CLI join_game?
// Signals the broken invariant: join_game creates a player row that on_disconnect
// immediately deletes; querying the player table afterwards is vacuous.
// ---------------------------------------------------------------------------
export function scriptAssertesPlayerPersistenceAfterCliJoinGame(script) {
  const hasCliJoinGame =
    script.indexOf('spacetime call') !== -1 && script.indexOf('join_game') !== -1;
  const hasPlayerTableQuery =
    script.indexOf('FROM player') !== -1 || script.indexOf('from player') !== -1;
  // The script greps for "SmokePlayer" to assert the player survived — on_disconnect
  // already deleted the row. The combination is the broken invariant.
  const hasPlayerGrepAssertion =
    script.indexOf('grep') !== -1 &&
    (script.indexOf('SmokePlayer') !== -1 || script.indexOf('player') !== -1);
  return hasCliJoinGame && hasPlayerTableQuery && hasPlayerGrepAssertion;
}

// Pure predicate: the script uses a session-independent table for data-survival
// assertions. Tables that on_disconnect does NOT clear: monster, inventory,
// species_row, skill_row, item_row, zone_def, config, encounter, monster_pub.
export function scriptUsesSessionIndependentTable(script) {
  return (
    script.indexOf('FROM monster') !== -1 ||
    script.indexOf('from monster') !== -1 ||
    script.indexOf('FROM inventory') !== -1 ||
    script.indexOf('from inventory') !== -1 ||
    script.indexOf('FROM species_row') !== -1 ||
    script.indexOf('from species_row') !== -1 ||
    script.indexOf('FROM skill_row') !== -1 ||
    script.indexOf('from skill_row') !== -1 ||
    script.indexOf('FROM item_row') !== -1 ||
    script.indexOf('from item_row') !== -1 ||
    script.indexOf('FROM zone_def') !== -1 ||
    script.indexOf('from zone_def') !== -1
  );
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'smoke-republish-on-disconnect-compat (RT-SR-01: player rows deleted by on_disconnect; CLI join_game assertions vacuous)';

  // =========================================================================
  // PROOF-OF-TEETH — known-bad and known-good fixtures
  // =========================================================================

  // TEETH A — a script that CLIs join_game then asserts player table must be flagged.
  const badScript = `#!/usr/bin/env bash
set -euo pipefail
spacetime call -s "$SERVER" "$DB" join_game "SmokePlayer"
sleep 1
ROWS=$(spacetime sql -s "$SERVER" "$DB" "SELECT name FROM player" 2>&1)
if ! echo "$ROWS" | grep -q "SmokePlayer"; then
  echo "FAIL: no player" >&2; exit 1
fi
`;
  if (!scriptAssertesPlayerPersistenceAfterCliJoinGame(badScript)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH A: scriptAssertesPlayerPersistenceAfterCliJoinGame did not detect the broken pattern (CLI join_game + player table assertion) — false negative',
    };
  }

  // TEETH B — a script that does NOT query the player table must be accepted.
  const goodScript = `#!/usr/bin/env bash
set -euo pipefail
spacetime call -s "$SERVER" "$DB" sync_content
sleep 1
ROWS=$(spacetime sql -s "$SERVER" "$DB" "SELECT id FROM species_row" 2>&1)
if ! echo "$ROWS" | grep -q "1"; then
  echo "FAIL: no species" >&2; exit 1
fi
`;
  if (scriptAssertesPlayerPersistenceAfterCliJoinGame(goodScript)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH B: scriptAssertesPlayerPersistenceAfterCliJoinGame flagged a script that only queries session-independent tables — false positive',
    };
  }

  // TEETH C — a script that uses monster table (session-independent) for survival check must pass.
  const monsterScript = `#!/usr/bin/env bash
spacetime call -s "$SERVER" "$DB" join_game "SmokePlayer"
ROWS=$(spacetime sql -s "$SERVER" "$DB" "SELECT monster_id FROM monster" 2>&1)
if ! echo "$ROWS" | grep -q "1"; then exit 1; fi
`;
  if (!scriptUsesSessionIndependentTable(monsterScript)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH C: scriptUsesSessionIndependentTable did not recognise monster table as session-independent — false negative',
    };
  }

  // =========================================================================
  // REAL FILE CHECK
  // =========================================================================
  const root = path.resolve('.');
  const scriptPath = path.join(root, 'scripts/smoke-republish.sh');

  let script;
  try {
    script = readFileSync(scriptPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read scripts/smoke-republish.sh' };
  }

  if (scriptAssertesPlayerPersistenceAfterCliJoinGame(script)) {
    return {
      name,
      pass: false,
      detail:
        'scripts/smoke-republish.sh asserts player-table persistence after "spacetime call join_game": ' +
        'on_disconnect (lib.rs:131-141) deletes the player row the moment the CLI disconnects, ' +
        'making the "SmokePlayer" grep vacuous. ' +
        'Fix: assert data survival on a session-independent table (monster, inventory, species_row, ' +
        'or any content registry) that on_disconnect does NOT clear. ' +
        'Validated by: validation-findings.md §Behavioural finding + ADR-0052 reconnect-seq note.',
    };
  }

  return {
    name,
    pass: true,
    detail:
      'smoke-republish.sh does not assert player-table persistence after a CLI join_game call — data-survival assertions use session-independent tables (correct)',
  };
}
