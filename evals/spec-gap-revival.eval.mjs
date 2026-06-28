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
// Round-2 teeth (added after specialist implemented detectors) cover additional
// bypass vectors found by red-team/reviewer: swap_active false-positive, give_monster
// and donate_monster broadened detection, cfg_attr-form ignore, and the matrix case
// where a trade reducer lands but the anchor fn is deleted instead of revived.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Recursively collect every `.rs` file path under `dir` (subdirs included).
// A trade/transfer reducer could land in a NEW server file, not just lib.rs —
// gathering all server sources keeps cross-file reducer coverage (red-team S2).
function collectRustFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectRustFiles(full));
    } else if (entry.endsWith('.rs')) {
      out.push(full);
    }
  }
  return out;
}

// --- Detectors (implemented; round-2-hardened) ---

// Returns an array of reducer fn names that are monster trade/transfer/ownership-change
// reducers. Only #[spacetimedb::reducer...]-annotated fns count; match names against
// trade/transfer/gift/exchange/ownership-change patterns. Must NOT match non-reducer
// helpers or unrelated reducers (e.g. grant_item, lead_party, move_player).
export function findTradeTransferReducers(rustSrc) {
  const lines = rustSrc.split('\n');
  const reducers = [];
  let pending = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#[spacetimedb::reducer')) {
      pending = true;
      continue;
    }
    const fnMatch = t.match(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (fnMatch) {
      if (pending) {
        reducers.push(fnMatch[1]);
      }
      pending = false;
      continue;
    }
    // Skip intervening attributes, doc/line comments and blanks without
    // clearing the pending flag; clear it on any other code line (defensive).
    // (`///` doc comments are already covered by the `//` prefix test.)
    if (t === '' || t.startsWith('#[') || t.startsWith('//')) {
      continue;
    }
    pending = false;
  }
  return reducers.filter((name) => {
    const lower = name.toLowerCase();
    // Unambiguous transfer verbs/nouns — always a trade/transfer reducer.
    if (/trade|transfer|gift|exchange|donate|bequeath|relinquish|sell|lend/.test(lower)) {
      return true;
    }
    // Explicit owner-change patterns.
    if (/change_owner|owner_change|set_owner|reassign_owner|new_owner|custody/.test(lower)) {
      return true;
    }
    // Ambiguous verbs (give/send/swap/hand_over/assign) only count when the
    // name ALSO names an ownership noun — so `swap_active` (battle slot swap)
    // does NOT match, but `give_monster`/`swap_monster` do. Plain .includes()
    // keeps this ReDoS-immune and explicit.
    const ambiguousVerbs = ['give', 'send', 'swap', 'hand_over', 'assign'];
    const ownershipNouns = ['monster', 'owner', 'pet', 'creature', 'party_member'];
    const hasAmbiguousVerb = ambiguousVerbs.some((v) => lower.includes(v));
    const hasOwnershipNoun = ownershipNouns.some((n) => lower.includes(n));
    return hasAmbiguousVerb && hasOwnershipNoun;
  });
}

// True iff `fn m7b_2_owner_change_mid_battle_spec_gap` exists AND carries a
// `#[ignore...]` attribute on a preceding attribute line.
export function parkedTestIsIgnored(testSrc) {
  const lines = testSrc.split('\n');
  let fnIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/\bfn\s+m7b_2_owner_change_mid_battle_spec_gap\b/.test(lines[i])) {
      fnIdx = i;
      break;
    }
  }
  if (fnIdx === -1) return false;
  // Scan upward over this fn's contiguous attribute/comment block only.
  for (let i = fnIdx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith('#[') || t.startsWith('//')) {
      // Bare `#[ignore]`/`#[ignore = "..."]` OR a cfg_attr that injects ignore,
      // e.g. `#[cfg_attr(test, ignore = "...")]` — both suppress execution.
      if (/^#\[ignore\b/.test(t)) return true;
      if (/^#\[cfg_attr\(/.test(t) && /\bignore\b/.test(t)) return true;
      continue;
    }
    if (t === '') continue;
    break;
  }
  return false;
}

// Returns { violated: boolean, anchorMissing: boolean, reducers: string[], reason: string }.
//
// violated  — true iff a trade/transfer reducer exists AND the parked test is still
//             ignored (the precondition outlived itself — gate must FAIL).
// anchorMissing — true iff the parked test fn `m7b_2_owner_change_mid_battle_spec_gap`
//             is absent from testSrc, in EITHER reducer state. The anchor must never
//             silently vanish: deleting/renaming it (whether or not a reducer landed)
//             is a failure — either it stays parked as the dormant guard, or it is
//             revived under its same name. (gate must FAIL.)
// reducers  — the list returned by findTradeTransferReducers(serverSrc).
// reason    — human-readable explanation of which condition triggered (or 'ok').
//
// The eval FAILS if violated || anchorMissing.
export function specGapStatus({ serverSrc, testSrc }) {
  const reducers = findTradeTransferReducers(serverSrc);
  const ignored = parkedTestIsIgnored(testSrc);
  const anchorPresent = /fn\s+m7b_2_owner_change_mid_battle_spec_gap\b/.test(testSrc);
  const violated = reducers.length > 0 && ignored;
  const anchorMissing = !anchorPresent;
  let reason;
  if (violated) {
    reason = `spec gap closed: trade/transfer reducer(s) [${reducers.join(', ')}] landed but m7b_2_owner_change_mid_battle_spec_gap is still #[ignore] — un-ignore m7b_2_owner_change_mid_battle_spec_gap and close the write-back abort-on-owner-change contract`;
  } else if (anchorMissing) {
    reason =
      'anchor missing: m7b_2_owner_change_mid_battle_spec_gap was deleted or renamed — the spec-gap anchor must never silently vanish; keep it parked as the dormant guard, or revive it under the same name';
  } else if (reducers.length === 0) {
    reason = 'ok (dormant: no trade/transfer reducer; parked test present)';
  } else {
    reason = 'ok (feature landed; parked test revived)';
  }
  return { violated, anchorMissing, reducers, reason };
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

  // --- Round-2 fixtures (red-team/reviewer bypass vectors) ---

  // S3-neg: swap_active is a real #[spacetimedb::reducer] in the live codebase.
  // `swap` must NOT match the trade/transfer filter — it is a battle-slot swap,
  // not an ownership transfer. This NEGATIVE tooth guards against an impl that
  // naively broadens the word-list to include `swap`.
  const serverWithSwapActive = `use spacetimedb::{ReducerContext};

#[spacetimedb::reducer]
pub fn swap_active(ctx: &ReducerContext, team_index: u8) -> Result<(), String> {
    // swap which team member is active — NOT an ownership transfer
    Ok(())
}
`;

  // S3-pos-give: `give_monster` is a plausible ownership-transfer reducer name.
  // The filter must detect `give` as an ownership-change pattern.
  const serverWithGiveMonster = `use spacetimedb::{ReducerContext};

#[spacetimedb::reducer]
pub fn give_monster(ctx: &ReducerContext, monster_id: u64, to: spacetimedb::Identity) -> Result<(), String> {
    // transfer ownership of monster to another player
    Ok(())
}
`;

  // S3-pos-donate: `donate_monster` is another plausible ownership-transfer name.
  // The filter must detect `donate` as an ownership-change pattern.
  const serverWithDonate = `use spacetimedb::{ReducerContext};

#[spacetimedb::reducer]
pub fn donate_monster(ctx: &ReducerContext, monster_id: u64, to: spacetimedb::Identity) -> Result<(), String> {
    // donate a monster — transfers ownership
    Ok(())
}
`;

  // S4: the parked fn prefixed with `#[cfg_attr(test, ignore = "...")]` instead of
  // bare `#[ignore = "..."]`. Both forms suppress test execution — the detector must
  // recognise cfg_attr-form as "still ignored".
  const testCfgAttrIgnore = `#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m7b_1_double_battle_double_xp_arithmetic() {
        // ... test body ...
    }

    #[test]
    #[cfg_attr(test, ignore = "spec gap: owner-change-mid-battle write-back unspecified; no trade reducer until M11+")]
    fn m7b_2_owner_change_mid_battle_spec_gap() {
        panic!("spec gap open");
    }

    #[test]
    fn m7b_3_other_test() {
        // ... test body ...
    }
}
`;

  // =========================================================================
  // Round-2 tooth: swap_active NEGATIVE — must NOT appear in results.
  // Kills: an impl that matches the bare substring `swap` in fn names and would
  // false-positive on the live codebase's swap_active battle reducer.
  // =========================================================================
  {
    let swapReducers;
    try {
      swapReducers = findTradeTransferReducers(serverWithSwapActive);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth swap_active-neg (findTradeTransferReducers on serverWithSwapActive): threw — ${err.message}`,
      };
    }
    if (!Array.isArray(swapReducers)) {
      return {
        name,
        pass: false,
        detail: `tooth swap_active-neg: must return an array, got ${typeof swapReducers}`,
      };
    }
    if (swapReducers.includes('swap_active')) {
      return {
        name,
        pass: false,
        detail: `tooth swap_active-neg: findTradeTransferReducers MUST NOT include 'swap_active' (battle-slot swap is not an ownership transfer) — got [${swapReducers.join(', ')}]. Kills: impl that matches bare word 'swap', causing a false-positive on the live codebase.`,
      };
    }
  }

  // =========================================================================
  // Round-2 tooth: give_monster POSITIVE — must appear in results (S3).
  // Kills: an impl whose filter only covers trade/transfer/gift/exchange and
  // misses the `give` ownership-transfer pattern.
  // =========================================================================
  {
    let giveReducers;
    try {
      giveReducers = findTradeTransferReducers(serverWithGiveMonster);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth give_monster-pos (findTradeTransferReducers on serverWithGiveMonster): threw — ${err.message}`,
      };
    }
    if (!Array.isArray(giveReducers) || !giveReducers.includes('give_monster')) {
      return {
        name,
        pass: false,
        detail: `tooth give_monster-pos: findTradeTransferReducers on serverWithGiveMonster MUST include 'give_monster' (ownership-transfer verb 'give'), got [${(giveReducers || []).join(', ')}]. Kills: impl that does not match 'give' as an ownership-change pattern (red-team S3).`,
      };
    }
  }

  // =========================================================================
  // Round-2 tooth: donate_monster POSITIVE — must appear in results (S3).
  // Kills: an impl that does not match `donate` as an ownership-transfer verb.
  // =========================================================================
  {
    let donateReducers;
    try {
      donateReducers = findTradeTransferReducers(serverWithDonate);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth donate_monster-pos (findTradeTransferReducers on serverWithDonate): threw — ${err.message}`,
      };
    }
    if (!Array.isArray(donateReducers) || !donateReducers.includes('donate_monster')) {
      return {
        name,
        pass: false,
        detail: `tooth donate_monster-pos: findTradeTransferReducers on serverWithDonate MUST include 'donate_monster' (ownership-transfer verb 'donate'), got [${(donateReducers || []).join(', ')}]. Kills: impl that does not match 'donate' as an ownership-change pattern (red-team S3).`,
      };
    }
  }

  // =========================================================================
  // Round-2 tooth: cfg_attr-form ignore counts as ignored (S4).
  // `#[cfg_attr(test, ignore = "...")]` is semantically identical to `#[ignore]`
  // in test execution — the parkedTestIsIgnored detector must recognise both forms.
  // Kills: an impl that only checks for bare `#[ignore` and misses cfg_attr.
  // =========================================================================
  {
    let cfgAttrResult;
    try {
      cfgAttrResult = parkedTestIsIgnored(testCfgAttrIgnore);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth cfg_attr-ignore (parkedTestIsIgnored on testCfgAttrIgnore): threw — ${err.message}`,
      };
    }
    if (cfgAttrResult !== true) {
      return {
        name,
        pass: false,
        detail: `tooth cfg_attr-ignore: parkedTestIsIgnored on testCfgAttrIgnore MUST be true (cfg_attr-form ignore suppresses test execution just like bare #[ignore]) — got ${cfgAttrResult}. Kills: impl that only checks '#[ignore' and misses '#[cfg_attr(test, ignore' (red-team S4).`,
      };
    }
  }

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

  // Matrix case 5: {serverWithTrade, testRemoved} → anchorMissing=true (S1/H1).
  // A trade reducer landed but the parked test fn was DELETED (not revived).
  // The gate must FAIL: the anchor vanished without proper revival.
  // `violated` would be false (ignored=false since fn is absent), but `anchorMissing`
  // must be true — the spec requires the anchor to either be revived OR remain present;
  // it cannot silently disappear when a reducer lands.
  // Kills: an impl that sets anchorMissing=true ONLY when NO reducer exists
  // (the current impl), but fails to flag the "reducer landed, fn deleted" case.
  {
    let status5;
    try {
      status5 = specGapStatus({ serverSrc: serverWithTrade, testSrc: testRemoved });
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `specGapStatus matrix 5 {serverWithTrade, testRemoved}: threw — ${err.message}`,
      };
    }
    if (status5.anchorMissing !== true) {
      return {
        name,
        pass: false,
        detail: `specGapStatus matrix 5 {serverWithTrade, testRemoved}: expected anchorMissing=true (trade reducer landed but parked fn deleted — gate must FAIL; the anchor cannot silently vanish), got anchorMissing=${status5.anchorMissing} violated=${status5.violated} — ${status5.reason}. Kills: impl that only sets anchorMissing when reducers.length===0, missing the case where a reducer lands and the fn is deleted instead of revived (red-team S1 / reviewer H1).`,
      };
    }
  }

  // =========================================================================
  // Real-file assertion: current codebase is in the healthy/dormant state.
  // specGapStatus must return violated=false && anchorMissing=false.
  // =========================================================================
  const serverSrcDir = path.resolve('server-module/src');
  const testSrcPath = path.resolve('game-core/src/combat/m7b_redteam_tests.rs');

  // Concatenate ALL .rs files under server-module/src/ (recursing subdirs) so a
  // trade reducer landing in a new file is still seen (cross-file coverage — S2).
  let realServerSrc = '';
  try {
    for (const file of collectRustFiles(serverSrcDir)) {
      realServerSrc += `${readFileSync(file, 'utf8')}\n`;
    }
  } catch (err) {
    return { name, pass: false, detail: `cannot read ${serverSrcDir}: ${err.message}` };
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
      'spec-gap-revival teeth all pass: findTradeTransferReducers correct (swap_active not matched, give_monster/donate_monster matched, trade_monster matched, benign reducers clean), parkedTestIsIgnored correct (bare and cfg_attr forms recognised, revived form false), specGapStatus matrix all 5 cases correct (incl. reducer-landed+fn-deleted), real codebase is in healthy/dormant state',
  };
}
