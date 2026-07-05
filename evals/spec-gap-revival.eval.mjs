// spec-gap-revival.eval.mjs — M8.8f parked-test revival gate + M13.5h dev_reducers fixme tripwire.
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
// M13.5h addition (spec §13.5h-2): dev_reducers fixme tripwire.
//
//   A test.fixme that cites "dev_reducers" (or "dev-reducers") while ANY CI workflow
//   publishes the module with dev_reducers (--features dev_reducers OR --bin-path with
//   dev_reducers) is a stale blocker: the claimed infra precondition has been met.
//   The detector (devReducerRevivalStatus) is RED when both conditions hold simultaneously.
//
//   Accepted gaps (documented here per the plan):
//   - Shell line-continuation (`\` token splitting): a `--features` flag broken across
//     lines with `\` may not be detected. Accepted: the real ci.yml uses a single `run:`
//     line for the feature build step; multi-line form is not currently used.
//   - env-var rename: if the wasm path env var is renamed the --bin-path scan still
//     matches 'MR_DEV_MODULE_WASM' (the canonical name in ADR-0086); an implementer who
//     renames the variable must also update this detector.
//
//   Scan scope (reviewer B4):
//   - workflows: ALL *.yml and *.yaml files under .github/workflows/ (readdirSync flat).
//   - specs:     client/e2e/*.spec.ts ONLY — never evals/**, so synthetic fixtures in
//                this eval file cannot self-trip.
//
// Round-2 teeth (added after specialist implemented detectors) cover additional
// bypass vectors found by red-team/reviewer: swap_active false-positive, give_monster
// and donate_monster broadened detection, cfg_attr-form ignore, and the matrix case
// where a trade reducer lands but the anchor fn is deleted instead of revived.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// ===========================================================================
// 12.5f-5: test.fixme condition-expiry guard for client/e2e/
//
// Mirrors the Rust #[ignore] anchor logic but for TypeScript e2e specs.
// A test.fixme whose file references a MERGED milestone token must fail CI,
// forcing the author to either un-fixme the test or update the condition to
// the real current blocker.
//
// EXPIRED_FIXME_MILESTONES: milestone tokens whose merge means any test.fixme
// citing them has outlived its stated condition. Still-pending blockers like
// "dev_reducers" or "M12.5-recruit" are NOT in this list and remain GREEN.
// ===========================================================================
export const EXPIRED_FIXME_MILESTONES = [
  'M9c', // M9c raising client — merged (M12d era); tests citing "until M9c lands" are expired
  'M8.7e', // M8.7e recruit e2e milestone — merged
  'M12.5-recruit', // this token NEVER existed in the spec corpus; citing it is always expired
  // (closes the 13.5h loophole: recruit.spec.ts used this token to evade the condition-expiry
  // guard while the detector deliberately excluded it from EXPIRED_FIXME_MILESTONES)
];

/**
 * Returns true iff the spec source contains BOTH a `test.fixme` call AND a
 * reference to any of `expiredTokens` — meaning the stated fixme condition
 * references a merged milestone and has expired.
 *
 * Uses indexOf (not RegExp) to stay ReDoS-immune (12.5f-3 discipline).
 */
export function hasExpiredFixme(specSrc, expiredTokens) {
  if (!specSrc.includes('test.fixme')) return false;
  for (const token of expiredTokens) {
    if (specSrc.indexOf(token) !== -1) return true;
  }
  return false;
}

// ===========================================================================
// 13.5h-2: dev_reducers fixme tripwire
//
// Mirrors the Rust #[ignore] anchor logic but for the CI publish + e2e fixme
// pairing.  A test.fixme citing dev_reducers while any workflow publishes with
// dev_reducers is a stale blocker (the revival condition has been met).
// ===========================================================================

/**
 * Returns true iff `workflowSrc` contains a line (ignoring comment lines whose
 * trimStart() starts with '#') that satisfies EITHER:
 *   - form 1: line contains '--features' AND 'dev_reducers'
 *   - form 2: line contains '--bin-path' AND ('MR_DEV_MODULE_WASM' OR 'dev_reducers')
 *
 * Uses indexOf only — no new RegExp() (spec-gap-revival discipline).
 * Comment lines (trimStart() starts with '#') are skipped; they document intent
 * but do not constitute an active publish step.
 */
export function workflowPublishesDevReducers(workflowSrc) {
  const lines = workflowSrc.split('\n');
  for (const line of lines) {
    if (line.trimStart().startsWith('#')) continue;
    // Form 1: cargo build/publish with --features dev_reducers
    if (line.indexOf('--features') !== -1 && line.indexOf('dev_reducers') !== -1) return true;
    // Form 2: spacetime publish with --bin-path and dev_reducers wasm
    if (
      line.indexOf('--bin-path') !== -1 &&
      (line.indexOf('MR_DEV_MODULE_WASM') !== -1 || line.indexOf('dev_reducers') !== -1)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true iff `specSrc` contains BOTH:
 *   - a `test.fixme` call
 *   - a reference to 'dev_reducers' OR 'dev-reducers' (hyphen bypass — red-team F10)
 *
 * File-level scan mirrors hasExpiredFixme; per-block brace matching rejected as
 * fragile (the reviewer's rewording-loophole critique applies equally to any text
 * matcher; re-anchoring with different words is the spec's own design).
 * Uses indexOf/includes only — no new RegExp().
 */
export function fixmeCitesDevReducers(specSrc) {
  if (!specSrc.includes('test.fixme')) return false;
  if (specSrc.indexOf('dev_reducers') !== -1) return true;
  if (specSrc.indexOf('dev-reducers') !== -1) return true;
  return false;
}

/**
 * Returns { violated, offenders, reason }.
 *
 * violated  — true iff ANY workflow publishes with dev_reducers AND ANY spec
 *             cites dev_reducers in a test.fixme.  This is the forcing condition:
 *             the fixme's stated blocker (dev_reducers not published) has been met,
 *             so the fixme is stale and must be revived or re-anchored.
 * offenders — array of offending spec file identifiers (keys from specSources).
 * reason    — human-readable explanation.
 *
 * Mirroring specGapStatus: the eval FAILS if violated.
 *
 * @param {{ specSources: Record<string,string>, workflowSources: Record<string,string> }} args
 */
export function devReducerRevivalStatus({ specSources, workflowSources }) {
  const publishingWorkflows = Object.keys(workflowSources).filter((k) =>
    workflowPublishesDevReducers(workflowSources[k]),
  );
  const anyPublishes = publishingWorkflows.length > 0;

  const offenders = Object.keys(specSources).filter((k) => fixmeCitesDevReducers(specSources[k]));
  const anyCites = offenders.length > 0;

  const violated = anyPublishes && anyCites;
  let reason;
  if (violated) {
    reason =
      `dev_reducers fixme tripwire fired: workflow(s) [${publishingWorkflows.join(', ')}] ` +
      `publish with dev_reducers, but spec(s) [${offenders.join(', ')}] still have ` +
      `test.fixme citing dev_reducers — the stated blocker has been met; un-fixme or ` +
      `re-anchor the blocked tests to the real current blocker`;
  } else if (!anyPublishes && !anyCites) {
    reason = 'ok (no dev_reducers publish; no fixme cites it — both sides dormant)';
  } else if (anyPublishes && !anyCites) {
    reason =
      `ok (dev_reducers published by [${publishingWorkflows.join(', ')}]; ` +
      `no test.fixme cites dev_reducers — fixmes already revived or re-anchored)`;
  } else {
    reason =
      `ok (fixme(s) [${offenders.join(', ')}] cite dev_reducers, ` +
      `but no workflow publishes with dev_reducers — blocker still valid)`;
  }
  return { violated, offenders, reason };
}

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
    if (/trade|transfer|gift|exchange|donate|bequeath|relinquish|lend/.test(lower)) {
      return true;
    }
    // Explicit owner-change patterns.
    if (/change_owner|owner_change|set_owner|reassign_owner|new_owner|custody/.test(lower)) {
      return true;
    }
    // Ambiguous verbs (give/send/swap/hand_over/assign/sell) only count when the
    // name ALSO names an ownership noun — so `swap_active` (battle slot swap) and
    // `sell` (item shop sell) do NOT match, but `give_monster`/`sell_monster` do.
    // Plain .includes() keeps this ReDoS-immune and explicit.
    const ambiguousVerbs = ['give', 'send', 'swap', 'hand_over', 'assign', 'sell'];
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

  // =========================================================================
  // 12.5f-5: test.fixme condition-expiry guard for client/e2e/
  // =========================================================================

  // Proof-of-teeth T-E1: a spec with test.fixme + expired "M9c" token → expired.
  // Kill target: an impl that always returns false (never detects expired fixme).
  const expiredFixtureM9c = `
// DEFERRED TO M9c: stays test.fixme until M9c lands.
test.fixme('R1: Recruit button visible', async () => {
  // ...
});
`;
  {
    let result;
    try {
      result = hasExpiredFixme(expiredFixtureM9c, EXPIRED_FIXME_MILESTONES);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth T-E1 (hasExpiredFixme with M9c): threw — ${err.message}`,
      };
    }
    if (result !== true) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T-E1: hasExpiredFixme must return true for a spec with test.fixme + "M9c" (expired milestone) — kill target: impl that always returns false, missing the condition-expiry detection.',
      };
    }
  }

  // Proof-of-teeth T-E2: a spec with test.fixme + still-valid blocker → NOT expired.
  // Kill target: an impl that returns true for any test.fixme regardless of condition.
  //
  // MODERNIZED (13.5h): the old fixture cited M12.5-recruit + dev_reducers — both of
  // which are now in EXPIRED_FIXME_MILESTONES (M12.5-recruit added per plan 13.5h,
  // and dev_reducers as a file-level scan via fixmeCitesDevReducers).  The fixture
  // must use a genuinely-pending blocker with NO milestone token and NO dev_reducers
  // variant so that T-E2's assertion (must return false) remains valid.
  // Correction rationale (per spec): old fixture was testing that dev_reducers was
  // not in EXPIRED_FIXME_MILESTONES — that was true then, is false now.  New fixture
  // points at the real current blocker text from the re-anchored R4: the __game()
  // test-hook is not exposed, owned by a client slice.  Still fails a wrong impl
  // (one that flags any test.fixme regardless of token).
  const stillPendingFixture = `
// BLOCKED: __game() test-hook not exposed; owned by a client slice.
// Bait grant requires a hook on window.__game() (e.g. grantBait(itemId, qty))
// that has not yet been added to main.ts by a client/src slice owner.
test.fixme('R4: Bait selector classify-by-data', async () => {
  // ...
});
`;
  {
    let result;
    try {
      result = hasExpiredFixme(stillPendingFixture, EXPIRED_FIXME_MILESTONES);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth T-E2 (hasExpiredFixme with still-valid blocker): threw — ${err.message}`,
      };
    }
    if (result !== false) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T-E2: hasExpiredFixme must return false for a spec with test.fixme citing a still-pending blocker (no milestone token, no dev_reducers variant) — kill target: impl that flags any test.fixme regardless of condition.',
      };
    }
  }

  // Proof-of-teeth T-E3: a spec with NO test.fixme → NOT expired (no false positive).
  const noFixtureSpec = `
// Normal active tests — no test.fixme blocks.
test('G1: Golden flow movement', async () => {
  // ...
});
`;
  {
    let result;
    try {
      result = hasExpiredFixme(noFixtureSpec, EXPIRED_FIXME_MILESTONES);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth T-E3 (hasExpiredFixme with no test.fixme): threw — ${err.message}`,
      };
    }
    if (result !== false) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T-E3: hasExpiredFixme must return false for a spec with no test.fixme — false positive on active tests.',
      };
    }
  }

  // Real-file check: scan all .spec.ts files in client/e2e/.
  const e2eDir = path.resolve('client/e2e');
  let e2eFiles = [];
  try {
    e2eFiles = readdirSync(e2eDir).filter((f) => f.endsWith('.spec.ts'));
  } catch (err) {
    return { name, pass: false, detail: `cannot read client/e2e/: ${err.message}` };
  }

  for (const f of e2eFiles) {
    const fPath = path.join(e2eDir, f);
    let src;
    try {
      src = readFileSync(fPath, 'utf8');
    } catch (err) {
      return { name, pass: false, detail: `cannot read ${fPath}: ${err.message}` };
    }
    if (hasExpiredFixme(src, EXPIRED_FIXME_MILESTONES)) {
      return {
        name,
        pass: false,
        detail:
          `condition-expiry: ${f} contains test.fixme blocks whose stated condition references ` +
          `a MERGED milestone (${EXPIRED_FIXME_MILESTONES.join(' or ')}) — the condition has ` +
          `expired. Either un-fixme the test or update its condition to the real current ` +
          `blocker (e.g., "M12.5-recruit: dev_reducers --bin-path publish not CI-wired"). ` +
          `See spec §12.5f-5.`,
      };
    }
  }

  // =========================================================================
  // 13.5h-2: dev_reducers fixme tripwire — fixture definitions
  // =========================================================================

  // Workflow fixtures
  const workflowWithFeatures = `
      - name: Build dev module
        run: cargo build -p monster-realm-module --release --target wasm32-unknown-unknown --features dev_reducers
`;
  const workflowWithBinPath = `
      - name: Two-window e2e
        env:
          MR_DEV_MODULE_WASM: \${{ github.workspace }}/target/wasm32-unknown-unknown/release/monster_realm_module.wasm
        run: npx playwright test --bin-path MR_DEV_MODULE_WASM
`;
  const workflowCommentOnly = `
      # - run: cargo build --features dev_reducers
      # This line is commented out and not active.
      - name: Normal build
        run: cargo build -p monster-realm-module --release --target wasm32-unknown-unknown
`;
  // The existing stock ci.yml (no dev_reducers publish at all before this slice).
  const workflowStock = `
      - name: Publish module
        run: spacetime publish -s local --module-path ../server-module --delete-data -y monster-realm
`;

  // Spec fixtures
  const specWithFixmeCitingDevReducers = `
// BLOCKED ON dev_reducers: start_wild_battle not callable from e2e until the
// dev_reducers feature is published via --bin-path in CI.
test.fixme('R1: Recruit button visible', async () => {
  // ...
});
`;
  const specWithFixmeCitingHyphenForm = `
// Blocked on dev-reducers publish step in CI.
test.fixme('R2: Recruit success', async () => {
  // ...
});
`;
  const specWithFixmeReanchored = `
// BLOCKED: __game() test-hook not exposed; owned by a client slice.
// No milestone token; no reference to the gated-reducer feature name.
test.fixme('R4: Bait selector classify-by-data', async () => {
  // ...
});
`;
  const specWithNoFixme = `
test('G1: Golden flow movement', async () => {
  // active test; no fixme
});
`;

  // =========================================================================
  // Tooth W1 (workflowPublishesDevReducers — --features form positive).
  // Kills: impl that only checks --bin-path and misses the --features form.
  // =========================================================================
  {
    let w1result;
    try {
      w1result = workflowPublishesDevReducers(workflowWithFeatures);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth W1 (workflowPublishesDevReducers with --features form): threw — ${err.message}`,
      };
    }
    if (w1result !== true) {
      return {
        name,
        pass: false,
        detail:
          'tooth W1: workflowPublishesDevReducers must return true for a workflow line with --features dev_reducers — kills: impl that only checks --bin-path and misses the --features cargo build form.',
      };
    }
  }

  // =========================================================================
  // Tooth W2 (workflowPublishesDevReducers — --bin-path form positive).
  // Kills: impl that only checks --features and misses the --bin-path form.
  // =========================================================================
  {
    let w2result;
    try {
      w2result = workflowPublishesDevReducers(workflowWithBinPath);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth W2 (workflowPublishesDevReducers with --bin-path form): threw — ${err.message}`,
      };
    }
    if (w2result !== true) {
      return {
        name,
        pass: false,
        detail:
          'tooth W2: workflowPublishesDevReducers must return true for a workflow line with --bin-path + MR_DEV_MODULE_WASM — kills: impl that only checks --features and misses the --bin-path spacetime publish form.',
      };
    }
  }

  // =========================================================================
  // Tooth W3 (workflowPublishesDevReducers — comment-only → false).
  // Kills: impl that matches commented-out lines (ignores the # skip rule).
  // =========================================================================
  {
    let w3result;
    try {
      w3result = workflowPublishesDevReducers(workflowCommentOnly);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth W3 (workflowPublishesDevReducers with comment-only): threw — ${err.message}`,
      };
    }
    if (w3result !== false) {
      return {
        name,
        pass: false,
        detail:
          'tooth W3: workflowPublishesDevReducers must return false when dev_reducers only appears in comment lines (trimStart() starts with "#") — kills: impl that does not skip comment lines and false-positives on commented-out build steps.',
      };
    }
  }

  // =========================================================================
  // Tooth W4 (workflowPublishesDevReducers — stock ci.yml → false).
  // Kills: impl that always returns true (never checks line content).
  // =========================================================================
  {
    let w4result;
    try {
      w4result = workflowPublishesDevReducers(workflowStock);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth W4 (workflowPublishesDevReducers with stock publish): threw — ${err.message}`,
      };
    }
    if (w4result !== false) {
      return {
        name,
        pass: false,
        detail:
          'tooth W4: workflowPublishesDevReducers must return false for a stock publish without dev_reducers — kills: impl that always returns true.',
      };
    }
  }

  // =========================================================================
  // Tooth F1 (fixmeCitesDevReducers — underscore form positive).
  // Kills: impl that only checks hyphen form and misses 'dev_reducers'.
  // =========================================================================
  {
    let f1result;
    try {
      f1result = fixmeCitesDevReducers(specWithFixmeCitingDevReducers);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth F1 (fixmeCitesDevReducers with dev_reducers form): threw — ${err.message}`,
      };
    }
    if (f1result !== true) {
      return {
        name,
        pass: false,
        detail:
          "tooth F1: fixmeCitesDevReducers must return true when test.fixme cites 'dev_reducers' (underscore form) — kills: impl that only checks hyphen form 'dev-reducers'.",
      };
    }
  }

  // =========================================================================
  // Tooth F1h (fixmeCitesDevReducers — hyphen form positive, red-team F10).
  // Kills: impl that only checks underscore form and misses 'dev-reducers'.
  // =========================================================================
  {
    let f1hresult;
    try {
      f1hresult = fixmeCitesDevReducers(specWithFixmeCitingHyphenForm);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth F1h (fixmeCitesDevReducers with dev-reducers hyphen form): threw — ${err.message}`,
      };
    }
    if (f1hresult !== true) {
      return {
        name,
        pass: false,
        detail:
          "tooth F1h: fixmeCitesDevReducers must return true when test.fixme cites 'dev-reducers' (hyphen form) — kills: impl that only checks underscore form, missing the red-team F10 hyphen bypass.",
      };
    }
  }

  // =========================================================================
  // Tooth F2 (fixmeCitesDevReducers — re-anchored R4-style text → false).
  // Kills: impl that matches any test.fixme regardless of content.
  // =========================================================================
  {
    let f2result;
    try {
      f2result = fixmeCitesDevReducers(specWithFixmeReanchored);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth F2 (fixmeCitesDevReducers with re-anchored fixme): threw — ${err.message}`,
      };
    }
    if (f2result !== false) {
      return {
        name,
        pass: false,
        detail:
          'tooth F2: fixmeCitesDevReducers must return false for a re-anchored test.fixme that does not cite dev_reducers or dev-reducers — kills: impl that flags any test.fixme regardless of its content.',
      };
    }
  }

  // =========================================================================
  // Tooth F3 (fixmeCitesDevReducers — no test.fixme → false).
  // Kills: impl that matches any file containing dev_reducers even without fixme.
  // =========================================================================
  {
    let f3result;
    try {
      f3result = fixmeCitesDevReducers(specWithNoFixme);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth F3 (fixmeCitesDevReducers with no test.fixme): threw — ${err.message}`,
      };
    }
    if (f3result !== false) {
      return {
        name,
        pass: false,
        detail:
          'tooth F3: fixmeCitesDevReducers must return false when there is no test.fixme in the file — kills: impl that matches dev_reducers without requiring the test.fixme co-presence.',
      };
    }
  }

  // =========================================================================
  // Tooth S1 (devReducerRevivalStatus — publish+cite → violated, THE forcing tooth).
  // This is the primary gate: a CI workflow publishes with dev_reducers AND a spec
  // still cites dev_reducers in a test.fixme.  The detector MUST fire.
  // Kills: impl that allows a live dev_reducers publish to coexist with a stale fixme.
  // =========================================================================
  {
    let s1result;
    try {
      s1result = devReducerRevivalStatus({
        specSources: { 'recruit.spec.ts': specWithFixmeCitingDevReducers },
        workflowSources: { 'ci.yml': workflowWithFeatures },
      });
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth S1 (devReducerRevivalStatus publish+cite): threw — ${err.message}`,
      };
    }
    if (!s1result.violated) {
      return {
        name,
        pass: false,
        detail:
          `tooth S1: devReducerRevivalStatus must be violated=true when a workflow publishes ` +
          `with dev_reducers AND a spec cites dev_reducers in test.fixme — ` +
          `got violated=${s1result.violated} — ${s1result.reason}. ` +
          `Kills: impl that does not fire when both conditions hold simultaneously (the forcing tooth).`,
      };
    }
  }

  // =========================================================================
  // Tooth S2 (devReducerRevivalStatus — no publish + cite → ok, not violated).
  // Kills: impl that fires whenever a spec cites dev_reducers, even without publish.
  // =========================================================================
  {
    let s2result;
    try {
      s2result = devReducerRevivalStatus({
        specSources: { 'recruit.spec.ts': specWithFixmeCitingDevReducers },
        workflowSources: { 'ci.yml': workflowStock },
      });
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth S2 (devReducerRevivalStatus no-publish+cite): threw — ${err.message}`,
      };
    }
    if (s2result.violated) {
      return {
        name,
        pass: false,
        detail:
          `tooth S2: devReducerRevivalStatus must NOT be violated when no workflow publishes ` +
          `with dev_reducers (the blocker is still valid) — ` +
          `got violated=${s2result.violated} — ${s2result.reason}. ` +
          `Kills: impl that fires on any fixme citation regardless of publish status.`,
      };
    }
  }

  // =========================================================================
  // Tooth S3 (devReducerRevivalStatus — publish + no cite → ok, not violated).
  // Kills: impl that fires whenever a workflow publishes dev_reducers regardless
  // of whether any spec still cites it.
  // =========================================================================
  {
    let s3result;
    try {
      s3result = devReducerRevivalStatus({
        specSources: { 'recruit.spec.ts': specWithFixmeReanchored },
        workflowSources: { 'ci.yml': workflowWithFeatures },
      });
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth S3 (devReducerRevivalStatus publish+no-cite): threw — ${err.message}`,
      };
    }
    if (s3result.violated) {
      return {
        name,
        pass: false,
        detail:
          `tooth S3: devReducerRevivalStatus must NOT be violated when the workflow publishes ` +
          `with dev_reducers but the spec has been re-anchored (no dev_reducers citation) — ` +
          `got violated=${s3result.violated} — ${s3result.reason}. ` +
          `Kills: impl that fires on any publish regardless of spec fixme content.`,
      };
    }
  }

  // =========================================================================
  // Tooth R-real (devReducerRevivalStatus on the real file tree → ok).
  // The real tree is the ground truth: if the specialist wired the dev_reducers
  // publish correctly AND the tester rewrote recruit.spec.ts without citing
  // dev_reducers in any test.fixme, this must be NOT violated.
  // Kills: impl that always returns violated=true (broken detector).
  // Scan scope per plan (reviewer B4):
  //   workflows = ALL *.yml/*.yaml under .github/workflows/ (flat readdirSync)
  //   specs     = client/e2e/*.spec.ts ONLY (never evals/**)
  // =========================================================================
  {
    const workflowsDir = path.resolve('.github/workflows');
    const e2eSpecDir = path.resolve('client/e2e');

    const realWorkflowSources = {};
    try {
      const wfFiles = readdirSync(workflowsDir).filter(
        (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
      );
      for (const f of wfFiles) {
        realWorkflowSources[f] = readFileSync(path.join(workflowsDir, f), 'utf8');
      }
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth R-real: cannot read .github/workflows/: ${err.message}`,
      };
    }

    const realSpecSources = {};
    try {
      const specFiles = readdirSync(e2eSpecDir).filter((f) => f.endsWith('.spec.ts'));
      for (const f of specFiles) {
        realSpecSources[f] = readFileSync(path.join(e2eSpecDir, f), 'utf8');
      }
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth R-real: cannot read client/e2e/: ${err.message}`,
      };
    }

    let realDevStatus;
    try {
      realDevStatus = devReducerRevivalStatus({
        specSources: realSpecSources,
        workflowSources: realWorkflowSources,
      });
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `tooth R-real: devReducerRevivalStatus threw on real files — ${err.message}`,
      };
    }

    if (realDevStatus.violated) {
      return {
        name,
        pass: false,
        detail:
          `tooth R-real: devReducerRevivalStatus on real tree is violated — ` +
          `offending specs: [${realDevStatus.offenders.join(', ')}] — ${realDevStatus.reason}. ` +
          `A spec in client/e2e/ still cites dev_reducers or dev-reducers in a test.fixme ` +
          `while a workflow publishes with dev_reducers — un-fixme or re-anchor the test.`,
      };
    }
  }

  return {
    name,
    pass: true,
    detail:
      'spec-gap-revival teeth all pass: findTradeTransferReducers correct (swap_active not matched, give_monster/donate_monster matched, trade_monster matched, benign reducers clean), parkedTestIsIgnored correct (bare and cfg_attr forms recognised, revived form false), specGapStatus matrix all 5 cases correct (incl. reducer-landed+fn-deleted), real codebase is in healthy/dormant state; test.fixme condition-expiry guard GREEN (T-E1/T-E2/T-E3 teeth pass, no expired conditions in client/e2e/); 13.5h-2 dev_reducers fixme tripwire GREEN (W1/W2/W3/W4 workflow detector teeth, F1/F1h/F2/F3 spec-citation teeth, S1/S2/S3 combined-status teeth, R-real on live tree all pass)',
  };
}
