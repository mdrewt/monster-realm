// spec-gap-revival.eval.mjs — M8.8f parked-test revival gate.
//
// Background: `game-core/src/combat/m7b_redteam_tests.rs` contains the parked test
// `m7b_2_owner_change_mid_battle_spec_gap` annotated
//   #[ignore = "spec gap: owner-change-mid-battle write-back unspecified; no trade reducer until M11+"]
//
// This eval ensures:
//   (a) if a trade/transfer reducer lands (annotated #[spacetimedb::reducer]) while
//       the parked test still carries #[ignore], the gate FAILS — the spec gap was
//       closed by the feature landing but the test was not revived (violated).
//   (b) if the parked test fn is silently deleted while still dormant (no reducer
//       landed), the gate FAILS — the anchor was removed without closure (anchorMissing).
//   (c) the current state (no reducer, test still parked+ignored) is GREEN (dormant).
//
// The detection functions are exported as stubs that throw — this eval is RED until
// the specialist implements them. The proof-of-teeth fixtures + real-file assertion
// live in the default export and drive the RED state.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// --- Stub exports (specialist implements; bodies throw → RED) ---

// Returns an array of reducer fn names that are monster trade/transfer/ownership-change
// reducers. Only #[spacetimedb::reducer...]-annotated fns count; match names against
// trade/transfer/gift/exchange/ownership-change patterns. Must NOT match non-reducer
// helpers or unrelated reducers (e.g. grant_item, lead_party, move_player).
export function findTradeTransferReducers(rustSrc) {
  throw new Error('M8.8f: implement in specialist phase');
}

// True iff `fn m7b_2_owner_change_mid_battle_spec_gap` exists AND carries a
// `#[ignore...]` attribute on a preceding attribute line.
export function parkedTestIsIgnored(testSrc) {
  throw new Error('M8.8f: implement in specialist phase');
}

// Returns { violated: boolean, anchorMissing: boolean, reducers: string[], reason: string }.
//
// violated  — true iff a trade/transfer reducer exists AND the parked test is still
//             ignored (the precondition outlived itself — gate must FAIL).
// anchorMissing — true iff NO trade/transfer reducer exists AND the parked test fn
//             `m7b_2_owner_change_mid_battle_spec_gap` is absent from testSrc (the
//             guard was silently deleted while still dormant — gate must FAIL).
// reducers  — the list returned by findTradeTransferReducers(serverSrc).
// reason    — human-readable explanation of which condition triggered (or 'ok').
//
// The eval FAILS if violated || anchorMissing.
export function specGapStatus({ serverSrc, testSrc }) {
  throw new Error('M8.8f: implement in specialist phase');
}

export default async function () {
  const name = 'spec-gap-revival (m7b_2 parked test revived when trade reducer lands)';

  // =========================================================================
  // Rust source fixtures — kept minimal and structurally representative so the
  // line-based parsers are genuinely exercised. The #[spacetimedb::reducer]
  // attribute appears on the line directly above fn <name>(...).
  // =========================================================================

  // A couple of benign reducers + a non-reducer helper.
  const serverNoTrade = `use spacetimedb::{ReducerContext};

#[spacetimedb::reducer]
pub fn move_player(ctx: &ReducerContext, direction: u8) -> Result<(), String> {
    // ... movement logic ...
    Ok(())
}

// Not a reducer — just a helper function.
fn grant_item(ctx: &ReducerContext, item_id: u32) {
    // ... grant logic ...
}

#[spacetimedb::reducer]
pub fn join_game(ctx: &ReducerContext, name: String) -> Result<(), String> {
    // ... join logic ...
    Ok(())
}
`;

  // serverNoTrade plus a trade_monster reducer.
  const serverWithTrade = `${serverNoTrade}
#[spacetimedb::reducer]
pub fn trade_monster(ctx: &ReducerContext, monster_id: u64, recipient: spacetimedb::Identity) -> Result<(), String> {
    // ... trade logic transfers ownership ...
    Ok(())
}
`;

  // A test file containing the parked test with #[ignore].
  const testIgnored = `#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m7b_1_double_battle_double_xp_arithmetic() {
        // ... test body ...
    }

    #[test]
    #[ignore = "spec gap: owner-change-mid-battle write-back unspecified; no trade reducer until M11+"]
    fn m7b_2_owner_change_mid_battle_spec_gap() {
        panic!("spec gap open");
    }

    #[test]
    fn m7b_3_other_test() {
        // ... test body ...
    }
}
`;

  // Same fn but WITHOUT #[ignore] — the test has been revived.
  const testRevived = `#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m7b_1_double_battle_double_xp_arithmetic() {
        // ... test body ...
    }

    #[test]
    fn m7b_2_owner_change_mid_battle_spec_gap() {
        // Test is now active — spec gap closed and write-back abort verified.
        assert!(true);
    }

    #[test]
    fn m7b_3_other_test() {
        // ... test body ...
    }
}
`;

  // Test file that LACKS the parked fn entirely (anchor silently deleted).
  const testRemoved = `#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m7b_1_double_battle_double_xp_arithmetic() {
        // ... test body ...
    }

    #[test]
    fn m7b_3_other_test() {
        // ... test body ...
    }
}
`;

  // =========================================================================
  // Tooth A: findTradeTransferReducers on serverNoTrade must return []
  // Kills: an impl that matches non-reducer helpers or false-positives on
  // move_player / join_game (neither is a trade/transfer fn).
  // =========================================================================
  let noTradeReducers;
  try {
    noTradeReducers = findTradeTransferReducers(serverNoTrade);
  } catch (err) {
    return {
      name,
      pass: false,
      detail: `tooth A (findTradeTransferReducers on serverNoTrade): threw — ${err.message}`,
    };
  }
  if (!Array.isArray(noTradeReducers)) {
    return {
      name,
      pass: false,
      detail: `tooth A: findTradeTransferReducers must return an array, got ${typeof noTradeReducers}`,
    };
  }
  if (noTradeReducers.length !== 0) {
    return {
      name,
      pass: false,
      detail: `tooth A: findTradeTransferReducers on serverNoTrade must return [] (no trade reducers), got [${noTradeReducers.join(', ')}]. Kills: impl that matches benign reducers (move_player, join_game) or non-reducer fn grant_item.`,
    };
  }

  // =========================================================================
  // Tooth B: findTradeTransferReducers on serverWithTrade must return ['trade_monster']
  // Kills: an impl that ignores #[spacetimedb::reducer]-annotated trade fns.
  // =========================================================================
  let withTradeReducers;
  try {
    withTradeReducers = findTradeTransferReducers(serverWithTrade);
  } catch (err) {
    return {
      name,
      pass: false,
      detail: `tooth B (findTradeTransferReducers on serverWithTrade): threw — ${err.message}`,
    };
  }
  if (!Array.isArray(withTradeReducers) || withTradeReducers.length === 0) {
    return {
      name,
      pass: false,
      detail: `tooth B: findTradeTransferReducers on serverWithTrade must return ['trade_monster'] (non-empty), got [${(withTradeReducers || []).join(', ')}]. Kills: impl that misses annotated trade_monster reducer.`,
    };
  }
  if (!withTradeReducers.includes('trade_monster')) {
    return {
      name,
      pass: false,
      detail: `tooth B: findTradeTransferReducers on serverWithTrade must include 'trade_monster', got [${withTradeReducers.join(', ')}]`,
    };
  }

  // =========================================================================
  // Tooth C: parkedTestIsIgnored on testIgnored must be true
  // Kills: an impl that returns false when #[ignore] is present on the parked fn.
  // =========================================================================
  let ignoredResult;
  try {
    ignoredResult = parkedTestIsIgnored(testIgnored);
  } catch (err) {
    return {
      name,
      pass: false,
      detail: `tooth C (parkedTestIsIgnored on testIgnored): threw — ${err.message}`,
    };
  }
  if (ignoredResult !== true) {
    return {
      name,
      pass: false,
      detail: `tooth C: parkedTestIsIgnored on testIgnored must be true, got ${ignoredResult}. Kills: impl that ignores the #[ignore] attribute or fails to locate the fn.`,
    };
  }

  // =========================================================================
  // Tooth D: parkedTestIsIgnored on testRevived must be false
  // Kills: an impl that always returns true, or that sees #[ignore] from
  // another test and assigns it to m7b_2.
  // =========================================================================
  let revivedResult;
  try {
    revivedResult = parkedTestIsIgnored(testRevived);
  } catch (err) {
    return {
      name,
      pass: false,
      detail: `tooth D (parkedTestIsIgnored on testRevived): threw — ${err.message}`,
    };
  }
  if (revivedResult !== false) {
    return {
      name,
      pass: false,
      detail: `tooth D: parkedTestIsIgnored on testRevived must be false, got ${revivedResult}. Kills: impl that always returns true or misattributes a different test's #[ignore] to m7b_2.`,
    };
  }

  // =========================================================================
  // specGapStatus matrix assertions
  // =========================================================================

  // Matrix case 1: {serverNoTrade, testIgnored} → violated=false, anchorMissing=false
  // This is the CURRENT healthy/dormant state — no reducer, test parked but present.
  {
    let status;
    try {
      status = specGapStatus({ serverSrc: serverNoTrade, testSrc: testIgnored });
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `specGapStatus matrix 1 {serverNoTrade, testIgnored}: threw — ${err.message}`,
      };
    }
    if (status.violated !== false || status.anchorMissing !== false) {
      return {
        name,
        pass: false,
        detail: `specGapStatus matrix 1 {serverNoTrade, testIgnored}: expected violated=false anchorMissing=false (dormant/healthy), got violated=${status.violated} anchorMissing=${status.anchorMissing} — ${status.reason}`,
      };
    }
  }

  // Matrix case 2: {serverWithTrade, testIgnored} → violated=true
  // The mandated RED: reducer landed but test is still parked.
  {
    let status;
    try {
      status = specGapStatus({ serverSrc: serverWithTrade, testSrc: testIgnored });
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `specGapStatus matrix 2 {serverWithTrade, testIgnored}: threw — ${err.message}`,
      };
    }
    if (status.violated !== true) {
      return {
        name,
        pass: false,
        detail: `specGapStatus matrix 2 {serverWithTrade, testIgnored}: expected violated=true (reducer landed, test still parked — gate must FAIL), got violated=${status.violated} anchorMissing=${status.anchorMissing} — ${status.reason}. Kills: impl that allows the parked test to coexist with a live trade reducer.`,
      };
    }
  }

  // Matrix case 3: {serverWithTrade, testRevived} → violated=false
  // Feature landed AND test revived — this is the correct end state.
  {
    let status;
    try {
      status = specGapStatus({ serverSrc: serverWithTrade, testSrc: testRevived });
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `specGapStatus matrix 3 {serverWithTrade, testRevived}: threw — ${err.message}`,
      };
    }
    if (status.violated !== false) {
      return {
        name,
        pass: false,
        detail: `specGapStatus matrix 3 {serverWithTrade, testRevived}: expected violated=false (reducer landed AND test revived — GREEN), got violated=${status.violated} — ${status.reason}`,
      };
    }
  }

  // Matrix case 4: {serverNoTrade, testRemoved} → anchorMissing=true
  // Guard silently deleted while still dormant — gate must FAIL.
  {
    let status;
    try {
      status = specGapStatus({ serverSrc: serverNoTrade, testSrc: testRemoved });
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `specGapStatus matrix 4 {serverNoTrade, testRemoved}: threw — ${err.message}`,
      };
    }
    if (status.anchorMissing !== true) {
      return {
        name,
        pass: false,
        detail: `specGapStatus matrix 4 {serverNoTrade, testRemoved}: expected anchorMissing=true (anchor deleted while dormant — gate must FAIL), got anchorMissing=${status.anchorMissing} violated=${status.violated} — ${status.reason}. Kills: impl that silently accepts a deleted anchor fn without a corresponding reducer landing.`,
      };
    }
  }

  // =========================================================================
  // Real-file assertion: current codebase is in the healthy/dormant state.
  // specGapStatus must return violated=false && anchorMissing=false.
  // =========================================================================
  const serverSrcPath = path.resolve('server-module/src/lib.rs');
  const testSrcPath = path.resolve('game-core/src/combat/m7b_redteam_tests.rs');

  let realServerSrc;
  try {
    realServerSrc = readFileSync(serverSrcPath, 'utf8');
  } catch (err) {
    return { name, pass: false, detail: `cannot read ${serverSrcPath}: ${err.message}` };
  }

  let realTestSrc;
  try {
    realTestSrc = readFileSync(testSrcPath, 'utf8');
  } catch (err) {
    return { name, pass: false, detail: `cannot read ${testSrcPath}: ${err.message}` };
  }

  let realStatus;
  try {
    realStatus = specGapStatus({ serverSrc: realServerSrc, testSrc: realTestSrc });
  } catch (err) {
    return {
      name,
      pass: false,
      detail: `real-file specGapStatus threw — ${err.message}`,
    };
  }

  if (realStatus.violated || realStatus.anchorMissing) {
    return {
      name,
      pass: false,
      detail: `real-file specGapStatus: expected violated=false anchorMissing=false (current dormant/healthy state), got violated=${realStatus.violated} anchorMissing=${realStatus.anchorMissing} reducers=[${(realStatus.reducers || []).join(', ')}] — ${realStatus.reason}`,
    };
  }

  return {
    name,
    pass: true,
    detail:
      'spec-gap-revival teeth all pass: findTradeTransferReducers correct on no-trade and with-trade fixtures, parkedTestIsIgnored correct on ignored and revived fixtures, specGapStatus matrix all 4 cases correct, real codebase is in healthy/dormant state',
  };
}
