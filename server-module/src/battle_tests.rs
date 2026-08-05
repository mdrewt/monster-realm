//! `battle` test module — extracted from `battle.rs` (M8.9c, ADR-0056).
//!
//! Behavior-preserving relocation of the inline `#[cfg(test)] mod tests` into a
//! sibling file (matching the game-core `*_tests.rs` convention) so the
//! production module stays lean. Assertions are unchanged; `include_str!`
//! still targets the production `battle.rs` in this same directory.

// =========================================================================
// M8.8b-C: SSOT-wiring source-guard tests
//
// These parse the source text of this file (server-module/src/battle.rs) to
// verify that `attempt_recruit` routes turn-advance through `advance_turn`
// (ADR-0003 SSOT) rather than re-implementing it inline, and that the
// level-up HP heal is delegated to `game_core::level_up_healed_hp` rather
// than re-inlined here.
//
// These tests compile on day 1 (they only do string processing) and fail
// at RUNTIME — runtime-RED — because today's source has:
//   `battle.state.turn_number += 1;`  (raw inline increment)
//   `m.current_hp.saturating_add(derived.hp.saturating_sub(bm.max_hp))`
//     (inlined heal formula)
// and does NOT contain `advance_turn` or `level_up_healed_hp`.
//
// Mirror: evals/recruit-reducer-security.eval.mjs (extractReducerBody logic).
// =========================================================================

/// Include the full source of this file at compile time so the guard runs
/// without any filesystem I/O at test time.
const MODULE_SOURCE: &str = include_str!("battle.rs");

/// Strip Rust block comments (`/* ... */`) and line comments (`// ...`) from
/// `src`. Returns a new String with those regions replaced by spaces (same
/// byte-length, so line numbers are preserved for debugging).
///
/// This is a simple linear scanner — no regex crates required.
/// Corner-cases handled:
///   - Nested block comments are NOT supported (Rust does support them, but
///     no production code in this file uses them, and the eval does not either).
///   - String literals containing `/*` or `//` are NOT special-cased — this
///     is intentional: we only need to remove comments so the body-search
///     does not accidentally match a commented-out `turn_number +=`.
fn strip_rust_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            // Block comment: blank everything until the matching `*/`.
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            // Line comment: blank everything to the end of the line.
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    // SAFETY: we only copy ASCII bytes from the original UTF-8 source and
    // replace with spaces (0x20), which are valid UTF-8. The original source
    // is valid UTF-8 (Rust source files must be). So `out` is valid UTF-8.
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

/// Strip Rust double-quoted string literals from `src`.
///
/// Replaces the contents of each `"..."` literal (including the quotes) with
/// spaces so that source-guard needles do not match text embedded in log
/// strings or error messages. Handles:
///   - Escaped quotes `\"` inside a literal (does not end the literal)
///   - Raw strings `r"..."` and `r#"..."#` are NOT handled (no production
///     code in battle.rs uses raw strings for the patterns we scan; if that
///     changes this function must be extended)
///
/// Used by m17a F1 guard-fakery hardening: `if is_ranked_pvp(&battle)` inside
/// an error string must not satisfy the conditional-guard needle.
fn strip_rust_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = bytes.to_vec();
    let mut i = 0;
    while i < len {
        if bytes[i] == b'"' {
            // Replace the opening quote with a space.
            out[i] = b' ';
            i += 1;
            // Replace content until unescaped closing quote.
            while i < len {
                if bytes[i] == b'\\' && i + 1 < len {
                    // Escaped character — blank both bytes and skip.
                    out[i] = b' ';
                    out[i + 1] = b' ';
                    i += 2;
                } else if bytes[i] == b'"' {
                    // Closing quote — blank it and stop.
                    out[i] = b' ';
                    i += 1;
                    break;
                } else {
                    out[i] = b' ';
                    i += 1;
                }
            }
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

/// Extract the body of a named `fn` from `src` (comment-stripped).
///
/// Finds `pub fn <name>(` or `fn <name>(`, walks to the first `{`, then
/// counts braces to find the matching `}`. Returns the slice BETWEEN the
/// outer braces (exclusive), or `None` if the function is not found.
///
/// Mirrors `extractReducerBody` in evals/recruit-reducer-security.eval.mjs.
///
/// SSOT (ADR-0003): this is a thin slicing wrapper over
/// [`extract_fn_body_range`], which owns the single locate-and-brace-walk
/// implementation. It previously carried a second, independent copy of that
/// parser (locate `fn <name>(`, find `{`, accumulate `len_utf8()` while
/// brace-counting) — byte-for-byte the same algorithm, differing only in that it
/// materialised a `Vec<char>` first. Two parsers for one grammar in one file is a
/// duplicated source of truth; the copy is gone and all callers are unaffected.
fn extract_fn_body<'a>(src: &'a str, name: &str) -> Option<&'a str> {
    let (start, end) = extract_fn_body_range(src, name)?;
    Some(&src[start..end])
}

/// SSOT wiring: the level-up HP heal inside the battle-results write-back
/// must be computed by `game_core::level_up_healed_hp`, not re-inlined.
///
/// Both checks are scoped to the EXTRACTED body of the function that owns
/// the heal so that string literals inside this test module never self-match.
/// The test module lives inside the included source (include_str! captures
/// the whole file), so searching the full stripped source would cause:
///   - the positive needle (`level_up_healed_hp`) to match the failure-message
///     text in this very test → false green;
///   - the negative needle to match the `inline_frag` variable binding in
///     this test → assertion never goes green even after a correct impl.
///
/// Scoping to the production function body eliminates both failure modes.
///
/// RED today: the production body contains the inline formula and no
/// level_up_healed_hp call.
#[test]
fn level_up_heal_is_owned_by_game_core() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    // Scope both checks to the body of the function that owns the heal.
    // The function name is assembled from parts so the complete literal
    // `fn write_back_battle_results(` does not appear in this test's own
    // source text (which is inside the included file) and thereby confuse
    // a hypothetical future caller of extract_fn_body on this test body.
    let heal_fn = ["write_back", "_battle", "_results"].concat();
    let body = extract_fn_body(&stripped, &heal_fn)
        .expect("the battle-results write-back function must exist in lib.rs");

    // Positive: the production body must delegate to game-core.
    // `level_up_healed_hp` does NOT appear in this test's own text, so
    // the assertion has genuine teeth — it only passes when the production
    // body actually contains that call.
    assert!(
        body.contains("level_up_healed_hp"),
        "TEETH(ADR-0003 residual 7c): the battle-results write-back body must \
         call `level_up_healed_hp` (game_core SSOT for level-up HP heal); \
         the heal formula must not be re-inlined. \
         Replace the inline with `game_core::level_up_healed_hp(m.current_hp, bm.max_hp, derived.hp)`."
    );

    // Negative: the inline formula fragment must be absent from the body.
    // Built from parts so the complete literal does not appear verbatim in
    // this test's text — the body slice is restricted to the production
    // function so the binding below is outside the searched region, but
    // constructing from parts keeps the invariant explicit and mirrors the
    // approach used in the attempt_recruit guard above.
    let inline_frag = ["saturating_sub", "(bm.max_hp)"].concat();
    assert!(
        !body.contains(inline_frag.as_str()),
        "TEETH(ADR-0003 residual 7c): the inline heal fragment \
         `saturating_sub(bm.max_hp)` must be removed from the \
         battle-results write-back body once `level_up_healed_hp` is \
         introduced; re-inlining duplicates the SSOT and risks diverging \
         from the game_core rule. Replace with `game_core::level_up_healed_hp(...)`."
    );
}

// =========================================================================
// EG1 (ADR-0174 D2): the two M12.5b-4 structural tests
// (`write_back_battle_results_calls_compute_evolves_to_on_level_up` and
// `write_back_battle_results_assigns_evolves_to_on_level_up`) were DELETED
// here — their subject, the level-up `evolves_to` recompute via
// `compute_evolves_to`, is removed outright: the helper's parameter type
// (`EvolutionCondition`) no longer exists in game-core, so the pinned
// implementation is compile-impossible and `evolves_to` is a frozen dead
// column until Migration B. Removal is the mechanical consequence of the
// deleted subject, not a weakened assertion.
// =========================================================================

// =========================================================================
// M12.5e-1 structural test: write_back_battle_results must GC prior
// terminal (non-Ongoing) battle rows for the player, keeping only the
// latest terminal per player.
//
// EARS: Terminal battles SHALL be GC'd — at terminal write-back, delete all
// prior terminal (non-Ongoing) battle rows for this player, keeping the
// latest terminal per player.
//
// RED state: the current write_back_battle_results body only deletes the
// `battle_wild` side-table row:
//   ctx.db.battle_wild().battle_id().delete(battle.battle_id);
// It does NOT contain `ctx.db.battle().battle_id().delete(` at all.
// The assertion below fails today.
//
// KILLS: an impl that orphans old fled/won/lost battle rows indefinitely.
// =========================================================================

/// 12.5e-1 structural: write_back_battle_results must call
/// `ctx.db.battle().battle_id().delete(` to GC prior terminal battle rows.
///
/// KILLS: any impl that only GCs battle_wild rows and never touches old
/// terminal `battle` rows — those accumulate indefinitely without this delete.
///
/// NOTE: The needle is `ctx.db.battle()` followed by a `.battle_id().delete(`
/// chain, NOT `ctx.db.battle_wild()` — the latter is the existing wild-row GC
/// which is already present. We confirm the ABSENCE of the correct call today.
///
/// Needles built from parts per the convention in this module. MODULE_SOURCE
/// = include_str!("battle.rs") — this test file is NOT inside that source,
/// so self-match is impossible. The split is for consistency only.
#[test]
fn write_back_battle_results_gcs_old_terminal_battles() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    let fn_name = ["write_back", "_battle", "_results"].concat();
    let body = extract_fn_body(&stripped, &fn_name)
        .expect("write_back_battle_results must exist in battle.rs");

    // Build the GC needle in two parts.
    // NOTE: MODULE_SOURCE = include_str!("battle.rs") — this test file
    // (battle_tests.rs) is NOT part of that source, so self-match is not a
    // concern here. We split the needle purely for readability and to keep
    // the convention consistent with other source-guard tests.
    //
    // The production call to detect:
    //   ctx.db.battle().battle_id().delete(
    // We look for the `battle()` table accessor (NOT `battle_wild()`) followed
    // by `.battle_id().delete(` so we require the correct table, correct key,
    // and correct operation — any of which missing means GC is absent.
    let table_access = ["ctx.db.", "battle()"].concat();
    let delete_chain = [".battle_id()", ".delete("].concat();

    // Verify the body contains the correct battle-table accessor followed
    // by the delete chain somewhere after it. We do a simple presence check
    // on the combined needle assembled from parts.
    let full_needle = [table_access.as_str(), delete_chain.as_str()].concat();

    assert!(
        body.contains(full_needle.as_str()),
        "TEETH(12.5e-1): write_back_battle_results body must contain \
         `ctx.db.battle().battle_id().delete(` to GC prior terminal battle \
         rows for the player; currently only `battle_wild()` rows are GC'd. \
         Add: iterate ctx.db.battle().player_identity().filter(battle.player_identity) \
         and delete rows where state.outcome != BattleOutcome::Ongoing (keeping latest). \
         KILLS: any impl that orphans old terminal battle rows indefinitely."
    );
}

// =========================================================================
// M12.5e-3 structural tests: write_back_battle_results XP loop must
// log-and-continue per-monster on parse failure, NOT propagate Err.
//
// EARS: THE XP write-back loop SHALL log-and-continue per-monster on parse
// failure, so a single corrupt row cannot make a battle unwinnable.
//
// RED state: the current body contains:
//   .ok_or_else(|| format!("loser species {} not found", loser_active.species_id))?
//   and
//   game_core::Level::new(bm.level)?
// Both propagate failures as Err (via `?`), making a corrupt battle unwinnable.
// Neither has a `log::error!` fallback.
//
// All three assertions below are RED today.
// =========================================================================

/// 12.5e-3a structural: write_back_battle_results must NOT use `ok_or_else`
/// on the loser-species lookup (which would propagate the error as `Err` and
/// make a missing species row render the battle unwinnable).
///
/// KILLS: the `.ok_or_else(|| format!("loser species {} not found", ...))?`
/// pattern — the `?` propagates the Err upward, aborting the reducer.
///
/// The needle is the `ok_or_else` closure that produces a "loser species"
/// error message. Built from parts to avoid self-match within this test source.
/// (NOTE: MODULE_SOURCE = include_str!("battle.rs"), so only battle.rs is
/// searched — self-match is not a concern, but we build from parts anyway for
/// clarity and to match the convention used throughout this module.)
#[test]
fn write_back_battle_results_xp_loop_does_not_propagate_loser_species_err() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    let fn_name = ["write_back", "_battle", "_results"].concat();
    let body = extract_fn_body(&stripped, &fn_name)
        .expect("write_back_battle_results must exist in battle.rs");

    // The forbidden pattern: ok_or_else on the loser species lookup producing a
    // "loser species" message. The current code is:
    //   .ok_or_else(|| format!("loser species {} not found", loser_active.species_id))?
    // Built from two parts so the verbatim complete string does not appear here.
    let bad_loser_err = ["ok_or_else(|| format!(\"loser", " species"].concat();

    assert!(
        !body.contains(bad_loser_err.as_str()),
        "TEETH(12.5e-3): write_back_battle_results must NOT use \
         `.ok_or_else(|| format!(\"loser species...`))?` on the loser-species lookup — \
         this propagates Err upward, making a missing species row render the battle \
         unwinnable. Replace with a `match` / `if let` that logs an error and continues \
         the XP loop (log-and-continue pattern)."
    );
}

/// 12.5e-3b structural: write_back_battle_results must NOT use `?` on
/// `Level::new(bm.level)` inside the XP loop — a corrupt level value would
/// abort the whole write-back.
///
/// KILLS: the `game_core::Level::new(bm.level)?` pattern in the XP loop.
///
/// Needle built from parts to avoid self-match.
#[test]
fn write_back_battle_results_xp_loop_does_not_propagate_level_parse_err() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    let fn_name = ["write_back", "_battle", "_results"].concat();
    let body = extract_fn_body(&stripped, &fn_name)
        .expect("write_back_battle_results must exist in battle.rs");

    // The forbidden pattern: Level::new(bm.level)? in the XP loop.
    // Built from two parts to avoid verbatim self-appearance.
    // In the body this looks like: `game_core::Level::new(bm.level)?`
    // We look for `Level::new(bm.level)` followed by `?`.
    // Assemble as: ["Level::new(bm.level)", "?"].concat() = "Level::new(bm.level)?"
    let bad_level_parse = ["Level::new(bm.level)", "?"].concat();

    assert!(
        !body.contains(bad_level_parse.as_str()),
        "TEETH(12.5e-3): write_back_battle_results must NOT use `?` on \
         `Level::new(bm.level)` inside the XP loop — a corrupt level value \
         in one monster's row aborts write-back for the entire battle, making \
         it unwinnable. Replace with log::error! + continue so only the \
         affected monster is skipped."
    );
}

/// 12.5e-3c structural: write_back_battle_results must use `log::error!`
/// inside the XP loop body for the log-and-continue pattern.
///
/// KILLS: an impl that silently skips corrupt rows (no log) or that still
/// propagates errors via `?` (no log::error! at all in the XP section).
///
/// Needle built from parts to avoid self-match.
#[test]
fn write_back_battle_results_xp_loop_uses_log_error_for_continue() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    let fn_name = ["write_back", "_battle", "_results"].concat();
    let body = extract_fn_body(&stripped, &fn_name)
        .expect("write_back_battle_results must exist in battle.rs");

    // The required pattern: log::error! somewhere inside the XP-award block.
    // Built from parts; the body slice is the production function so this
    // test's own text is not inside the searched region.
    let log_call = ["log::", "error!"].concat();

    assert!(
        body.contains(log_call.as_str()),
        "TEETH(12.5e-3): write_back_battle_results body must contain `log::error!` \
         for the log-and-continue pattern in the XP loop — currently the body uses `?` \
         to propagate errors (making a corrupt monster row unwinnable). \
         Add `log::error!(\"...\"); continue;` in place of `?` propagation so a single \
         corrupt row is skipped and logged, not fatal."
    );
}

// =========================================================================
// RT-WB-01: Monster HP double-write on SideAWins — derived-stat staleness
//
// FINDING (red-team M12.5e): On a SideAWins outcome, write_back_battle_results
// calls write_back_party_hp first (which writes battle-HP to every party
// monster row from bm.current_hp), and then the XP loop re-reads those same
// rows, increments XP/level, and writes them back a second time.
//
// If the monster leveled up and the stat-recompute 'stat_recompute block is
// NOT entered (e.g. species_row not found for the winner's species_id, which
// returns `None` for `ctx.db.species_row().id().find(m.species_id)` but
// does NOT break early), the monster row is written back with:
//   - new XP/level (correct)
//   - STALE stat_hp, stat_attack, etc. (still the pre-level values)
//   - current_hp from the first write_back_party_hp pass (battle-end HP)
//     NOT re-healed by the level-up formula
//   - monster_pub is written from the stale-stat `m` snapshot
//
// The concrete staleness scenario:
//   1. write_back_party_hp writes m.current_hp = bm.current_hp (battle-end HP).
//   2. XP loop re-reads m from DB (current_hp is now battle-end HP).
//   3. apply_xp_gain fires leveled_up = true.
//   4. `if let Some(species) = ctx.db.species_row().id().find(m.species_id)` → None
//      (winner's species row was deleted by a concurrent sync_content revert,
//       which can't happen in single-threaded SpacetimeDB, but could happen if
//       content is corrupted or the species_id column is wrong on a migrated row).
//   5. The inner `'stat_recompute` block is NEVER entered.
//   6. m.xp and m.level are written; stat_hp, stat_attack, etc. are stale.
//   7. level_up_healed_hp is never called, so current_hp is not adjusted.
//   8. `pub_row = pub_from_monster(&m)` includes the stale derived stats.
//
// This test verifies the structural invariant: when a level-up occurs in the
// XP loop, the code MUST call level_up_healed_hp inside the 'stat_recompute
// block (protected by the `if let Some(species)` guard). If that block is
// skipped (species missing), current_hp must NOT reflect a level-up heal.
// The source-guard below confirms level_up_healed_hp is always inside the
// species guard, never called on the stale path.
//
// GREEN today: the current impl only calls level_up_healed_hp inside
// `if let Some(species) = ...` → `'stat_recompute:` block. This test passes
// as a regression guard: if someone moves the heal call outside the species
// guard (where it could execute with wrong old_max_hp from bm.max_hp which
// is the BATTLE-ENTRY max_hp, not the pre-level-up DB stat_hp), this test
// will catch the error string in the right position.
// =========================================================================

/// RT-WB-01 structural: `level_up_healed_hp` must only appear INSIDE
/// the `'stat_recompute:` labeled block, which is itself inside the
/// `if let Some(species)` guard. It must NOT appear outside that guard
/// where it would execute on the stale path (no species row found).
///
/// KILLS: an impl that moves `level_up_healed_hp` outside the species guard,
/// causing the heal to run with stale `bm.max_hp` (battle-entry max, not the
/// DB stat_hp before level-up) when the species row lookup fails.
///
/// Also kills: an impl that calls `level_up_healed_hp` twice — once before
/// the species lookup (using wrong inputs) and once inside (correct).
#[test]
fn level_up_heal_only_inside_species_guard_not_before_it() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    let fn_name = ["write_back", "_battle", "_results"].concat();
    let body = extract_fn_body(&stripped, &fn_name)
        .expect("write_back_battle_results must exist in battle.rs");

    // The heal call needle — built from parts as per module convention.
    let heal_call = ["level_up_healed", "_hp"].concat();

    // Confirm the heal call is present (positive — kills a naive removal).
    assert!(
        body.contains(heal_call.as_str()),
        "RT-WB-01 regression: level_up_healed_hp must be present in \
         write_back_battle_results (it was removed — re-add inside the \
         `if let Some(species)` guard, inside `'stat_recompute:`)."
    );

    // The species guard needle — the `if let Some` that gates stat recompute.
    // If the heal call appears BEFORE `if let Some(species)` in the body text,
    // it executes on the stale path.
    let species_guard = ["if let Some(species)", " = "].concat();

    let guard_pos = body.find(species_guard.as_str());
    let heal_pos = body.find(heal_call.as_str());

    match (guard_pos, heal_pos) {
        (Some(g), Some(h)) => {
            assert!(
                h > g,
                "RT-WB-01: `level_up_healed_hp` (pos {h}) appears BEFORE \
                 the `if let Some(species)` guard (pos {g}) in \
                 write_back_battle_results. This means the heal runs on the \
                 stale path when species_row is not found, using bm.max_hp \
                 (battle-entry) instead of the pre-level-up DB stat_hp. \
                 Move the heal call INSIDE the `'stat_recompute:` block."
            );
        }
        (None, _) => panic!(
            "RT-WB-01: `if let Some(species) = ` guard not found in \
             write_back_battle_results body — stat recompute has no species guard. \
             The level_up_healed_hp call must be inside an `if let Some(species)` guard."
        ),
        (_, None) => panic!(
            "RT-WB-01: `level_up_healed_hp` not found in write_back_battle_results \
             body — level-up HP heal is missing (should have been caught by \
             level_up_heal_is_owned_by_game_core)."
        ),
    }
}

// =========================================================================
// M12.5e2: practice-XP wiring source-guard tests (ADR-0078)
//
// Verify that `write_back_battle_results` delegates the 0.1× practice-battle
// XP penalty to `game_core::practice_xp_reward` (ADR-0003 SSOT) and guards
// the call behind a `WILD_IDENTITY` provenance check.
//
// Both tests start RED: `practice_xp_reward` is not yet called in battle.rs.
// =========================================================================

/// Verifies write_back_battle_results calls `practice_xp_reward(` — the
/// SSOT delegation gate for the 0.1× practice penalty (ADR-0078).
///
/// Two checks: (1) the bare call-name needle, (2) the call-with-first-arg
/// pattern to guard against a string-literal bypass where a log message
/// mentioning `practice_xp_reward(` would satisfy check 1 but not check 2.
///
/// Kills: inline `/ 10` or `* 0.1` directly in the server shell
/// (ADR-0003 violation — the rule must live in game-core, not battle.rs).
/// RED: fails today because practice_xp_reward is not yet called.
#[test]
fn write_back_battle_results_calls_practice_xp_reward() {
    let stripped = strip_rust_comments(MODULE_SOURCE);
    let fn_name = "write_back_battle_results".to_string();
    let body = extract_fn_body(&stripped, &fn_name)
        .unwrap_or_else(|| panic!("{fn_name} not found in battle.rs"));
    assert!(
        body.contains("practice_xp_reward("),
        "TEETH: write_back_battle_results must call `practice_xp_reward(` \
         (game-core SSOT for the 0.1× practice penalty — ADR-0078 / ADR-0003); \
         an inline `/ 10` in battle.rs is a SSOT violation."
    );
    // Secondary needle: guards against a string-literal bypass where a `log!`
    // call mentioning `practice_xp_reward(` would satisfy the check above but
    // would not satisfy the actual call pattern `practice_xp_reward(base_xp,`.
    assert!(
        body.contains("practice_xp_reward(base_xp,"),
        "TEETH: write_back_battle_results must call `practice_xp_reward(base_xp, ...)` — \
         the secondary needle prevents a string-literal bypass (a log message mentioning \
         practice_xp_reward would satisfy the first check but not this one). \
         Ensure the call is `game_core::practice_xp_reward(base_xp, is_practice)`."
    );
}

/// Verifies write_back_battle_results contains a WILD_IDENTITY provenance check
/// alongside the practice_xp_reward call — determines which battles are practice.
///
/// Kills: an impl that always passes is_practice=true (ignores wild-battle status),
/// or that applies the penalty to wild battles (wrong provenance).
/// RED: fails today because the WILD_IDENTITY + practice_xp_reward wiring is absent.
#[test]
fn write_back_battle_results_gates_practice_xp_on_wild_identity() {
    let stripped = strip_rust_comments(MODULE_SOURCE);
    let fn_name = "write_back_battle_results".to_string();
    let body = extract_fn_body(&stripped, &fn_name)
        .unwrap_or_else(|| panic!("{fn_name} not found in battle.rs"));
    assert!(
        body.contains("WILD_IDENTITY"),
        "TEETH: write_back_battle_results must reference WILD_IDENTITY to compute \
         the is_practice flag — wild battles (opponent == WILD_IDENTITY) receive full XP; \
         practice battles receive 0.1×. Without this check the multiplier would apply to \
         wild battles or never apply. RED today: WILD_IDENTITY provenance gate not present \
         inside write_back_battle_results."
    );
    assert!(
        body.contains("practice_xp_reward("),
        "TEETH: the WILD_IDENTITY gate must accompany a practice_xp_reward( call — \
         having the check without the delegation is a wiring gap. \
         RED today: practice_xp_reward call absent."
    );
}

// =========================================================================
// M14e source-guard tests: use_battle_item reducer security invariants
//
// `use_battle_item` is a server reducer that needs ReducerContext to execute,
// making pure unit tests infeasible. Source-guard tests (the established
// pattern in this module) are the canonical way to verify security invariants
// in server reducer code. Three invariants are tested:
//
//   (1) Ownership guard: `require_owner` must be called — a player must not
//       be able to use items on another player's battle.
//   (2) Battle-state guard: the reducer must check the battle outcome for
//       `Ongoing` before applying the item — items cannot be used in
//       terminated battles.
//   (3) Reject-before-consume order: `cure_status` must be checked BEFORE
//       `consume_one` — an item that doesn't cure any status is rejected
//       without consuming it (reject-not-clamp, ADR-0053 analog).
//
// ALL THREE tests start RED: `use_battle_item` does not exist in battle.rs.
// When it exists, the extract_fn_body().expect() call will succeed and the
// body-content assertions will verify the security invariants.
// =========================================================================

/// M14e source-guard: use_battle_item body must call `require_owner`.
///
/// Kills: an impl of use_battle_item that omits the ownership check — any
/// player could then use items on another player's battle. This is the
/// primary authorization gate for the reducer.
///
/// RED state: use_battle_item does not exist in battle.rs → expect() panics.
#[test]
fn use_battle_item_has_ownership_check() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    // Assembled from parts so the literal `fn use_battle_item(` does not appear
    // verbatim in this test's text (convention consistency with the module).
    let fn_name = ["use", "_battle_item"].concat();
    let body = extract_fn_body(&stripped, &fn_name).expect(
        "TEETH (M14e): use_battle_item must exist in server-module/src/battle.rs; \
         the function is missing — this test is RED until the reducer is implemented",
    );

    // require_owner is the ownership guard (see guards.rs, used throughout this module).
    let ownership_check = ["require", "_owner"].concat();

    assert!(
        body.contains(ownership_check.as_str()),
        "TEETH (M14e): use_battle_item body must call `require_owner` to verify \
         the caller owns the battle row. Without this, any player can use items \
         on another player's active battle — a critical authorization gap. \
         Add: `require_owner(ctx, battle.player_identity)?;` near the top of the body."
    );
}

/// M14e source-guard: use_battle_item body must check battle outcome (Ongoing guard).
///
/// Kills: an impl that applies item effects to terminated battles — items must
/// only be usable in Ongoing battles (same invariant as submit_attack).
///
/// RED state: use_battle_item does not exist in battle.rs → expect() panics.
#[test]
fn use_battle_item_has_outcome_check() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    let fn_name = ["use", "_battle_item"].concat();
    let body = extract_fn_body(&stripped, &fn_name).expect(
        "TEETH (M14e): use_battle_item must exist in server-module/src/battle.rs; \
         the function is missing — this test is RED until the reducer is implemented",
    );

    // The body must reference `outcome` to check the battle is Ongoing.
    // We check for `outcome` (the BattleState field) — the specific check
    // `state.outcome != BattleOutcome::Ongoing` requires this field access.
    // Built from parts: "outc" + "ome" = "outcome" (no self-match risk here,
    // but we follow the convention for consistency).
    let outcome_check = ["outc", "ome"].concat();

    assert!(
        body.contains(outcome_check.as_str()),
        "TEETH (M14e): use_battle_item body must check `outcome` to verify the battle \
         is Ongoing before applying the item. A terminated battle (SideAWins, SideBWins, \
         Fled) must reject the item use. Add: check `state.outcome != BattleOutcome::Ongoing` \
         and return Err(\"battle is not ongoing\") if true."
    );
}

/// M14e source-guard: use_battle_item checks `cure_status` BEFORE calling `consume_one`.
///
/// Kills: an impl that consumes the item before validating it can cure the monster's
/// current status — an item that has no cure_status (or wrong status) must be rejected
/// WITHOUT consuming it. This is the reject-before-consume ordering invariant.
///
/// RED state: use_battle_item does not exist in battle.rs → expect() panics.
#[test]
fn use_battle_item_checks_cure_status_before_consume() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    let fn_name = ["use", "_battle_item"].concat();
    let body = extract_fn_body(&stripped, &fn_name).expect(
        "TEETH (M14e): use_battle_item must exist in server-module/src/battle.rs; \
         the function is missing — this test is RED until the reducer is implemented",
    );

    // Find the position of `cure_status` check and `consume_one` call.
    // The cure_status check must appear BEFORE consume_one in the body text,
    // enforcing the reject-before-consume ordering.
    let cure_check = ["cure", "_status"].concat();
    let consume_call = ["consume", "_one"].concat();

    let cure_pos = body.find(cure_check.as_str());
    let consume_pos = body.find(consume_call.as_str());

    match (cure_pos, consume_pos) {
        (Some(c), Some(k)) => {
            assert!(
                c < k,
                "TEETH (M14e): `cure_status` check (pos {c}) must appear BEFORE \
                 `consume_one` call (pos {k}) in use_battle_item body. \
                 An impl that calls consume_one before validating cure_status \
                 burns the item even on rejection (wrong behavior — reject-not-consume). \
                 Reorder: validate cure_status first, then consume the item only if valid."
            );
        }
        (None, _) => panic!(
            "TEETH (M14e): `cure_status` not found in use_battle_item body — \
             the reducer must check the item's cure_status field before applying it. \
             An impl without this check cannot reject items that have no cure_status \
             or that target the wrong status condition."
        ),
        (_, None) => panic!(
            "TEETH (M14e): `consume_one` not found in use_battle_item body — \
             the reducer must consume the item from inventory after validating it. \
             Without consume_one, the item is never removed from inventory (infinite use)."
        ),
    }
}

// ===========================================================================
// m17a (ADR-0119): PvP-reject guard source-scan tests (RL-8/9, D5)
//
// The four PvE battle reducers (submit_attack, swap_active, flee,
// use_battle_item) must each contain a PvP-reject guard — `is_ranked_pvp(&battle)`
// — IMMEDIATELY AFTER the `outcome == Ongoing` check, before any reducer-specific
// side-effects.
//
// This guarantees (RL-8): flee cannot dodge a rating loss on a PvP battle.
// This guarantees (RL-9): submit_attack/swap_active/use_battle_item cannot drive
//   PvP turns through the PvE path (which would let server AI play side B, or
//   produce a decisive outcome outside the settle_pvp_battle funnel).
//
// All four tests below are RED now — the needle is absent from every reducer body.
//
// Additionally: a GREEN pinned-precondition test verifies that attempt_recruit
// is structurally safe (requires the wild-only `battle_wild` row lookup, which
// errors before any outcome write on a PvP battle). This test is GREEN today by
// design and must REMAIN GREEN — it pins an existing invariant m17a relies upon.
//
// Needle strategy (self-match avoidance): `is_ranked_pvp(&battle)` is assembled
// via concat!() so the complete literal does not appear verbatim in this test
// file, which is inside MODULE_SOURCE = include_str!("battle.rs"). However,
// MODULE_SOURCE includes battle.rs NOT battle_tests.rs, so self-match is not
// actually a risk here. We still use concat!() for convention consistency and to
// explicitly document the evasion.
// ===========================================================================

/// m17a-RL-8 source-guard: `flee` body must contain `if is_ranked_pvp(&battle)`.
///
/// Needle hardened (F1): requires the CONDITIONAL form `if is_ranked_pvp(&battle)`
/// not just presence of the identifier. This kills guard-fakery evasions:
///   - `let _ = is_ranked_pvp(&battle);`       — dead-code call, does nothing
///   - `// if is_ranked_pvp(&battle) { ... }`  — commented-out (stripped by scan)
///
/// The `if` prefix ensures the guard is in a reachable conditional branch.
/// Residual documented evasion: `if is_ranked_pvp(&battle) {}` (no-op body) still
/// passes this scan — that is caught by mutation testing coverage, not a needle scan.
///
/// Also asserts the guard appears AFTER the `outcome != BattleOutcome::Ongoing`
/// check — position ordering guarantees the guard runs only on ongoing battles
/// (the Ongoing check exits early on terminated battles, so the PvP guard is
/// never reached for those).
///
/// Also strips string literals before matching (F1) so a log string containing
/// `"if is_ranked_pvp(&battle)"` does not produce a false-positive.
///
/// Kills: any impl of `flee` that omits the PvP reject, allowing a player to
/// flee a PvP battle and dodge a rating loss (the client `canFlee=false` is
/// not authoritative — ADR-0119 D5).
/// Kills: dead-code call `let _ = is_ranked_pvp(&battle)` with no branch.
/// RED now: needle absent from current flee body.
#[test]
fn m17a_flee_has_pvp_reject_guard() {
    let stripped = strip_rust_comments(MODULE_SOURCE);
    // F1: require the conditional form; strip string literals to avoid false positives
    // from log messages containing the pattern verbatim.
    let pvp_needle = concat!("if is_ranked", "_pvp(&battle)");
    let ongoing_needle = concat!("BattleOutcome::", "Ongoing");

    let body = extract_fn_body(&stripped, "flee")
        .expect("m17a-RL-8: `flee` reducer must exist in battle.rs");

    // Strip string literals from the body before needle search (F1: guard-fakery hardening).
    // This ensures a log string like `log("if is_ranked_pvp(&battle) ...")` is not matched.
    let body_no_strings = strip_rust_strings(body);

    assert!(
        body_no_strings.contains(pvp_needle),
        "m17a-RL-8 FAIL: `flee` body is missing the conditional PvP-reject guard `{}`. \
         Without it, a player can flee a PvP battle and dodge a rating loss. \
         Add: `if is_ranked_pvp(&battle) {{ log_reject(...); return Err(...); }}` \
         immediately after the outcome != Ongoing check. RED: needle absent. (ADR-0119 D5, F1 hardening)",
        pvp_needle
    );

    // Order: ongoing check must precede pvp guard in the source.
    let ongoing_pos = body_no_strings
        .find(ongoing_needle)
        .expect("m17a-RL-8: `flee` body must contain a BattleOutcome::Ongoing check");
    let pvp_pos = body_no_strings
        .find(pvp_needle)
        .expect("already confirmed above");

    assert!(
        pvp_pos > ongoing_pos,
        "m17a-RL-8 ORDER FAIL: `if is_ranked_pvp(&battle)` (pos {pvp_pos}) must appear AFTER \
         `BattleOutcome::Ongoing` check (pos {ongoing_pos}) in `flee` body. \
         Place the PvP guard immediately after the Ongoing reject (ADR-0119 D5)."
    );
}

/// m17a-RL-9 source-guard: `submit_attack` body must contain `is_ranked_pvp(&battle)`.
///
/// Also asserts the guard appears AFTER the `BattleOutcome::Ongoing` check.
///
/// Kills: any impl that allows side A to drive PvP turns via submit_attack, letting
/// the server AI resolve side B's moves — a ranked-farming exploit and an
/// exactly-once violation (decisive outcome produced outside the settle funnel).
/// RED now: needle absent from current submit_attack body.
#[test]
fn m17a_submit_attack_has_pvp_reject_guard() {
    let stripped = strip_rust_comments(MODULE_SOURCE);
    // F1: require conditional form; strip string literals to prevent false positives.
    let pvp_needle = concat!("if is_ranked", "_pvp(&battle)");
    let ongoing_needle = concat!("BattleOutcome::", "Ongoing");

    let body = extract_fn_body(&stripped, "submit_attack")
        .expect("m17a-RL-9: `submit_attack` reducer must exist in battle.rs");

    let body_no_strings = strip_rust_strings(body);

    assert!(
        body_no_strings.contains(pvp_needle),
        "m17a-RL-9 FAIL: `submit_attack` body is missing the conditional PvP-reject guard `{}`. \
         Without it, side A can drive PvP turns via the PvE path (server AI resolves \
         side B — farming exploit + exactly-once violation). \
         Add: `if is_ranked_pvp(&battle) {{ return Err(...); }}` after the Ongoing check (ADR-0119 D5, F1).",
        pvp_needle
    );

    let ongoing_pos = body_no_strings
        .find(ongoing_needle)
        .expect("m17a-RL-9: `submit_attack` body must contain a BattleOutcome::Ongoing check");
    let pvp_pos = body_no_strings
        .find(pvp_needle)
        .expect("already confirmed above");

    assert!(
        pvp_pos > ongoing_pos,
        "m17a-RL-9 ORDER FAIL: `if is_ranked_pvp(&battle)` (pos {pvp_pos}) must appear AFTER \
         `BattleOutcome::Ongoing` check (pos {ongoing_pos}) in `submit_attack` body (ADR-0119 D5)."
    );
}

/// m17a-RL-9 source-guard: `swap_active` body must contain `if is_ranked_pvp(&battle)`.
///
/// Needle hardened (F1): requires the conditional form `if is_ranked_pvp(&battle)`.
/// Also strips string literals before matching to prevent false positives from
/// log messages embedding the pattern text.
///
/// Also asserts the guard appears AFTER the `BattleOutcome::Ongoing` check.
///
/// Kills: an impl where swap_active can be used on a PvP battle, letting a player
/// manipulate team composition outside the both-submit protocol.
/// Kills: dead-code `let _ = is_ranked_pvp(&battle)` evasion.
/// RED now: needle absent from current swap_active body.
#[test]
fn m17a_swap_active_has_pvp_reject_guard() {
    let stripped = strip_rust_comments(MODULE_SOURCE);
    // F1: require conditional form; strip string literals to prevent false positives.
    let pvp_needle = concat!("if is_ranked", "_pvp(&battle)");
    let ongoing_needle = concat!("BattleOutcome::", "Ongoing");

    let body = extract_fn_body(&stripped, "swap_active")
        .expect("m17a-RL-9: `swap_active` reducer must exist in battle.rs");

    let body_no_strings = strip_rust_strings(body);

    assert!(
        body_no_strings.contains(pvp_needle),
        "m17a-RL-9 FAIL: `swap_active` body is missing the conditional PvP-reject guard `{}`. \
         Without it, a player can manipulate PvP team composition outside the \
         both-submit protocol. Add: `if is_ranked_pvp(&battle) {{ return Err(...); }}` \
         after the Ongoing check (ADR-0119 D5, F1).",
        pvp_needle
    );

    let ongoing_pos = body_no_strings
        .find(ongoing_needle)
        .expect("m17a-RL-9: `swap_active` body must contain a BattleOutcome::Ongoing check");
    let pvp_pos = body_no_strings
        .find(pvp_needle)
        .expect("already confirmed above");

    assert!(
        pvp_pos > ongoing_pos,
        "m17a-RL-9 ORDER FAIL: `if is_ranked_pvp(&battle)` (pos {pvp_pos}) must appear AFTER \
         `BattleOutcome::Ongoing` check (pos {ongoing_pos}) in `swap_active` body (ADR-0119 D5)."
    );
}

/// m17a-RL-9 source-guard: `use_battle_item` body must contain `if is_ranked_pvp(&battle)`.
///
/// Needle hardened (F1): requires the conditional form `if is_ranked_pvp(&battle)`.
/// Also strips string literals before matching.
///
/// Also asserts the guard appears AFTER the `BattleOutcome::Ongoing` check.
///
/// Kills: an impl where items can be used in PvP battles — state mutation outside
/// the both-submit secret-pick protocol (PvP item use is deferred; reject now,
/// lift deliberately later — ADR-0119 D5).
/// Kills: dead-code `let _ = is_ranked_pvp(&battle)` evasion.
/// RED now: needle absent from current use_battle_item body.
#[test]
fn m17a_use_battle_item_has_pvp_reject_guard() {
    let stripped = strip_rust_comments(MODULE_SOURCE);
    // F1: require conditional form; strip string literals to prevent false positives.
    let pvp_needle = concat!("if is_ranked", "_pvp(&battle)");
    let ongoing_needle = concat!("BattleOutcome::", "Ongoing");

    let body = extract_fn_body(&stripped, "use_battle_item")
        .expect("m17a-RL-9: `use_battle_item` reducer must exist in battle.rs");

    let body_no_strings = strip_rust_strings(body);

    assert!(
        body_no_strings.contains(pvp_needle),
        "m17a-RL-9 FAIL: `use_battle_item` body is missing the conditional PvP-reject guard `{}`. \
         PvP item use is rejected in m17a (deferred feature; lift deliberately later). \
         Add: `if is_ranked_pvp(&battle) {{ return Err(...); }}` after the Ongoing check (ADR-0119 D5, F1).",
        pvp_needle
    );

    let ongoing_pos = body_no_strings
        .find(ongoing_needle)
        .expect("m17a-RL-9: `use_battle_item` body must contain a BattleOutcome::Ongoing check");
    let pvp_pos = body_no_strings
        .find(pvp_needle)
        .expect("already confirmed above");

    assert!(
        pvp_pos > ongoing_pos,
        "m17a-RL-9 ORDER FAIL: `if is_ranked_pvp(&battle)` (pos {pvp_pos}) must appear AFTER \
         `BattleOutcome::Ongoing` check (pos {ongoing_pos}) in `use_battle_item` body (ADR-0119 D5)."
    );
}

/// m17a PINNED PRECONDITION (GREEN today): `attempt_recruit` is structurally safe
/// — it requires a `battle_wild` row lookup and returns Err("not a wild battle")
/// before any outcome write, so it cannot be used to drive PvP battles.
///
/// This is NOT a new behavior test — it pins an EXISTING invariant that m17a
/// relies on to justify NOT adding a PvP guard to attempt_recruit (ADR-0119 D5,
/// "attempt_recruit needs no guard (wild-only battle_wild row requirement)").
///
/// If this test goes RED, the structural safety assumption has broken and a PvP
/// guard MUST be added to attempt_recruit — it is NOT a signal to remove the test.
///
/// Kills (if ever broken): a refactor that removes the battle_wild lookup, which
/// would allow attempt_recruit to fire on a PvP battle.
/// GREEN today by design.
#[test]
fn m17a_attempt_recruit_is_structurally_safe_precondition() {
    let taming_src = include_str!("taming.rs");
    let stripped_taming = strip_rust_comments(taming_src);

    // Pinned needle 1: attempt_recruit body must look up battle_wild().
    // This is the structural gate that makes it safe for PvP battles: a PvP battle
    // has no battle_wild row, so the lookup returns None and the function returns Err
    // before any outcome mutation.
    let battle_wild_needle = concat!("battle_wild()", ".battle_id()");

    let body = extract_fn_body(&stripped_taming, "attempt_recruit")
        .expect("m17a PRECONDITION: `attempt_recruit` must exist in taming.rs");

    assert!(
        body.contains(battle_wild_needle),
        "m17a PRECONDITION BROKEN: `attempt_recruit` no longer contains `{}`. \
         The structural safety guarantee that protects PvP battles relies on this \
         lookup returning None (and Err) for non-wild battles. \
         If this lookup was removed, a PvP guard MUST be added to attempt_recruit. \
         (ADR-0119 D5 documents this invariant.)",
        battle_wild_needle
    );

    // Pinned needle 2: the not-a-wild-battle error string must be present.
    // This confirms the battle_wild lookup is used as a gate (not just for reads).
    let not_wild_needle = concat!("not a wild", " battle");

    assert!(
        body.contains(not_wild_needle),
        "m17a PRECONDITION BROKEN: `attempt_recruit` body no longer contains the \
         \"not a wild battle\" error string (assembled: `{}`). \
         This error is returned when the battle_wild row is absent — the path that \
         protects PvP battles from attempt_recruit. \
         Restore or add an equivalent guard that rejects non-wild battles. (ADR-0119 D5)",
        not_wild_needle
    );
}

// ===========================================================================
// ptc5b (wild-disconnect GC): Tests T1, T2, T3
//
// Slice: resolve_wild_battle_on_disconnect — when a player disconnects while
// in an Ongoing WILD battle, the battle must be cleaned up automatically so
// the player is not soft-locked (re-entry blocked) on reconnect.
//
// EARS criteria addressed:
//   ptc5b-1: The `resolve_wild_battle_on_disconnect` function exists in
//             battle.rs and is wired into `on_disconnect` in lib.rs.
//   ptc5b-2: `is_ongoing_wild_battle` is a pure predicate scoping to
//             the caller's Ongoing WILD rows only (caller-scoping +
//             idempotency: no-op when there are no wild rows).
//   ptc5b-3: After resolve, the player's Ongoing WILD battle is absent from
//             the battle set, unblocking re-entry (soft-lock proof); the fn
//             body calls write_back_battle_results, battle_wild().delete,
//             and battle().delete.
//
// RED state: `super::is_ongoing_wild_battle` and
//            `super::resolve_wild_battle_on_disconnect` do not yet
//            exist → T1 and T2 fail to compile; T3 compiles but fails at
//            runtime because the needles are absent from battle.rs.
// ===========================================================================

/// Minimal `Battle` row builder for ptc5b tests — mirrors `ongoing_battle` in
/// raising_tests.rs (same field set, same convention).  The `battle_id` is
/// supplied by the caller so each fixture is distinct.
fn battle_fixture(
    id: u64,
    player: spacetimedb::Identity,
    opponent: spacetimedb::Identity,
    outcome: game_core::BattleOutcome,
) -> crate::schema::Battle {
    crate::schema::Battle {
        battle_id: id,
        player_identity: player,
        opponent_identity: opponent,
        state: game_core::BattleState {
            side_a: game_core::BattleSide {
                active: 0,
                team: vec![],
            },
            side_b: game_core::BattleSide {
                active: 0,
                team: vec![],
            },
            outcome,
            turn_number: 1,
            weather: None,
        },
        party_monster_ids: vec![],
        opponent_monster_ids: vec![],
        created_at_ms: 0,
    }
}

// ---------------------------------------------------------------------------
// T1 — pure-core selection (EARS ptc5b-2: caller-scoping + idempotency)
//
// Proof-of-teeth: asserts is_ongoing_wild_battle returns true ONLY for the
// exact combination (player==P, opponent==WILD_IDENTITY, outcome==Ongoing).
//
// Each of the four fixture rows exercises a different rejection axis:
//   (a) true  — all three conditions met
//   (b) false — wrong opponent (PvP, not WILD)
//   (c) false — wrong outcome (terminal)
//   (d) false — wrong owner (different player Q)
//
// Kills:
//   - An impl that ignores opponent_identity (b would become true)
//   - An impl that ignores outcome (c would become true)
//   - An impl that ignores player_identity (d would become true)
//   - An always-true impl (all b/c/d assertions would fail)
//   - An always-false impl (assertion a would fail)
//   - An idempotency regression: iterating zero rows must yield no matches
//     (the empty-set arm at the end).
// ---------------------------------------------------------------------------

// EARS ptc5b-2
// PROOF-OF-TEETH: kills wrong-opponent / wrong-outcome / wrong-owner / always-true /
//                 always-false mutants of is_ongoing_wild_battle.
#[test]
fn ptc5b_1_selection_is_ongoing_wild_battle_predicate() {
    let p = spacetimedb::Identity::from_byte_array([1u8; 32]);
    let q = spacetimedb::Identity::from_byte_array([2u8; 32]);
    let pvp_opponent = spacetimedb::Identity::from_byte_array([3u8; 32]);
    let wild = crate::WILD_IDENTITY;

    // (a) Ongoing WILD battle owned by P → must be true.
    let row_a = battle_fixture(1, p, wild, game_core::BattleOutcome::Ongoing);
    assert!(
        super::is_ongoing_wild_battle(&row_a, p),
        "ptc5b-T1(a) FAIL: Ongoing wild battle owned by P must return true. \
         TEETH: kills any impl that ignores any of the three conditions."
    );

    // (b) Ongoing PvP battle owned by P (opponent is real identity, NOT WILD) → false.
    // Kills: an impl that ignores opponent_identity (accepts any Ongoing battle for P).
    let row_b = battle_fixture(2, p, pvp_opponent, game_core::BattleOutcome::Ongoing);
    assert!(
        !super::is_ongoing_wild_battle(&row_b, p),
        "ptc5b-T1(b) FAIL: Ongoing PvP battle (non-WILD opponent) must return false. \
         TEETH: kills an impl that drops the opponent==WILD_IDENTITY check."
    );

    // (c) Terminal (Fled) WILD battle owned by P → false.
    // Kills: an impl that ignores outcome and accepts any wild battle for P.
    let row_c = battle_fixture(3, p, wild, game_core::BattleOutcome::Fled);
    assert!(
        !super::is_ongoing_wild_battle(&row_c, p),
        "ptc5b-T1(c) FAIL: Terminal (Fled) wild battle must return false. \
         TEETH: kills an impl that drops the outcome==Ongoing check."
    );

    // (d) Ongoing WILD battle owned by Q (not P) → false for P.
    // Kills: an impl that ignores player_identity and counts all wild Ongoing rows.
    let row_d = battle_fixture(4, q, wild, game_core::BattleOutcome::Ongoing);
    assert!(
        !super::is_ongoing_wild_battle(&row_d, p),
        "ptc5b-T1(d) FAIL: Ongoing wild battle owned by Q must return false for P. \
         TEETH: kills an impl that drops the player_identity check."
    );

    // Idempotency: an empty set yields no matches — the no-op / no-wild-battle case.
    // Kills: an impl that returns true from empty input (always-true).
    let empty: [crate::schema::Battle; 0] = [];
    let any_match = empty.iter().any(|b| super::is_ongoing_wild_battle(b, p));
    assert!(
        !any_match,
        "ptc5b-T1(e) FAIL: empty battle set must yield no wild matches. \
         TEETH: kills an always-true impl and documents the no-op idempotency case."
    );

    // Idempotency: a set containing only non-wild rows also yields no matches.
    let non_wild = [row_b, row_c, row_d];
    let any_non_wild = non_wild.iter().any(|b| super::is_ongoing_wild_battle(b, p));
    assert!(
        !any_non_wild,
        "ptc5b-T1(f) FAIL: set with no qualifying wild rows must yield no matches. \
         TEETH: documents idempotency — no-op when there are no wild Ongoing rows for P."
    );
}

// ---------------------------------------------------------------------------
// T2 — re-entry flip + mutation tooth (EARS ptc5b-3: THE soft-lock proof)
//
// This is the critical regression test.  The scenario:
//   1. Player P has an Ongoing WILD battle in the set → is_in_ongoing_battle_either_role
//      returns true (P is soft-locked from starting a new battle).
//   2. `is_ongoing_wild_battle` identifies P's wild battle ids to resolve.
//   3. The resolved rows are removed from the set (simulating the GC delete).
//   4. With those rows gone, is_in_ongoing_battle_either_role returns false (P unblocked).
//
// MUTATION TOOTH (explicit): if `is_ongoing_wild_battle` were replaced by an
// implementation that always returns false (the removed-branch mutant), then
// `to_resolve` would be empty, `remaining` would still contain P's wild row,
// and step 4's assertion (!is_locked_after) would FAIL — this test re-fails
// under that mutant.  The assertion is not tautological: it depends on the
// predicate correctly identifying P's row.
//
// Kills:
//   - The always-false predicate mutant (step 2 collects nothing → step 4 fails)
//   - An impl that resolves Q's row instead of P's (Q unblocked, P still locked)
//   - An impl that resolves only terminal rows (step 2 skips Ongoing → step 4 fails)
// ---------------------------------------------------------------------------

// EARS ptc5b-3
// PROOF-OF-TEETH: kills the removed-branch (always-false) mutant of
//                 is_ongoing_wild_battle — remaining still has P's wild row and
//                 the step-4 assertion catches the lingering soft-lock.
#[test]
fn ptc5b_2_reentry_flip_soft_lock_proof() {
    let p = spacetimedb::Identity::from_byte_array([5u8; 32]);
    let q = spacetimedb::Identity::from_byte_array([6u8; 32]);
    let wild = crate::WILD_IDENTITY;

    // Build a mixed set: P's Ongoing wild battle + Q's Ongoing wild + a terminal.
    let row_p_wild = battle_fixture(10, p, wild, game_core::BattleOutcome::Ongoing);
    let row_q_wild = battle_fixture(11, q, wild, game_core::BattleOutcome::Ongoing);
    let row_p_terminal = battle_fixture(12, p, wild, game_core::BattleOutcome::SideAWins);

    let all_battles = [
        row_p_wild.clone(),
        row_q_wild.clone(),
        row_p_terminal.clone(),
    ];

    // Step 1: confirm P is soft-locked before resolution.
    // as_player iterator: all rows where player_identity == P.
    let is_locked_before = crate::guards::is_in_ongoing_battle_either_role(
        all_battles.iter().filter(|b| b.player_identity == p),
        std::iter::empty::<&crate::schema::Battle>(),
    );
    assert!(
        is_locked_before,
        "ptc5b-T2 precondition FAIL: P must be soft-locked before disconnect resolution. \
         The player arm should fire on P's Ongoing wild battle row."
    );

    // Step 2: collect the ids to resolve using is_ongoing_wild_battle.
    // MUTATION TOOTH: if is_ongoing_wild_battle always returned false, to_resolve
    // would be empty, remaining == all_battles, and step 4 would fail.
    let to_resolve: Vec<u64> = all_battles
        .iter()
        .filter(|b| super::is_ongoing_wild_battle(b, p))
        .map(|b| b.battle_id)
        .collect();

    // Structural assertion: exactly one row is resolved (P's Ongoing wild battle).
    // Kills: an impl that resolves 0 rows (always-false) or resolves too many rows.
    assert_eq!(
        to_resolve.len(),
        1,
        "ptc5b-T2 FAIL: exactly one battle should be resolved for P (the Ongoing wild row, \
         id=10); found {} ids: {:?}. \
         TEETH: kills always-false impl (0 resolved) and over-broad impl (>1 resolved).",
        to_resolve.len(),
        to_resolve
    );
    assert_eq!(
        to_resolve[0], 10,
        "ptc5b-T2 FAIL: the resolved id must be 10 (P's Ongoing wild battle), not {}. \
         TEETH: kills an impl that resolves the wrong row (e.g. Q's row or the terminal).",
        to_resolve[0]
    );

    // Step 3: build `remaining` — the set as it would look after the GC delete.
    let remaining: Vec<_> = all_battles
        .iter()
        .filter(|b| !to_resolve.contains(&b.battle_id))
        .collect();

    // Step 4: confirm P is no longer soft-locked after removal.
    // MUTATION TOOTH (the key bite): if is_ongoing_wild_battle was always-false,
    // to_resolve would be empty, remaining would contain row_p_wild, and the
    // is_in_ongoing_battle_either_role call below would return true, failing this assertion.
    let is_locked_after = crate::guards::is_in_ongoing_battle_either_role(
        remaining.iter().filter(|b| b.player_identity == p).copied(),
        std::iter::empty::<&crate::schema::Battle>(),
    );
    assert!(
        !is_locked_after,
        "ptc5b-T2 FAIL: P must NOT be soft-locked after the wild battle GC. \
         If is_ongoing_wild_battle returned false (removed-branch mutant), to_resolve \
         is empty, remaining still has P's wild row, and this assertion FAILS. \
         TEETH: this is the primary mutation kill for the predicate."
    );

    // Bonus: Q's wild row is still in remaining (only P's rows were resolved).
    let q_still_locked = crate::guards::is_in_ongoing_battle_either_role(
        remaining.iter().filter(|b| b.player_identity == q).copied(),
        std::iter::empty::<&crate::schema::Battle>(),
    );
    assert!(
        q_still_locked,
        "ptc5b-T2 FAIL: Q's Ongoing wild battle must remain after resolving P's battle — \
         the resolution must be caller-scoped to P, not a global GC of all wild battles."
    );
}

// ---------------------------------------------------------------------------
// T3 — body source-scan on resolve_wild_battle_on_disconnect
//       (EARS ptc5b-1 + ptc5b-3(a): structure of the GC fn)
//
// Scans the body of `resolve_wild_battle_on_disconnect` from MODULE_SOURCE
// (= battle.rs, NOT this test file) to verify four structural invariants:
//
//   (i)   References WILD_IDENTITY (directly or via is_ongoing_wild_battle).
//   (ii)  Calls write_back_battle_results (log-and-continue on Err).
//   (iii) Contains a battle_wild() ... .delete( sequence.
//   (iv)  Contains a battle() ... .delete( sequence (NOT only battle_wild).
//
// All needles are assembled from concat!-split parts to avoid self-match
// (the test file battle_tests.rs is included in MODULE_SOURCE via include_str!
// targeting battle.rs, so this test file IS NOT in MODULE_SOURCE — but we
// follow the concat!-parts convention for consistency and to keep the pattern
// robust against future include changes).
//
// RED state: resolve_wild_battle_on_disconnect does not yet exist in battle.rs
// → extract_fn_body returns None → expect() panics with the TEETH message.
// ---------------------------------------------------------------------------

// EARS ptc5b-1 + ptc5b-3(a)
// PROOF-OF-TEETH:
//   (i)   Kills: impl that uses a hardcoded all-zeros literal without WILD_IDENTITY.
//   (ii)  Kills: impl that deletes without calling write_back (skips XP/HP write-back).
//   (iii) Kills: impl that omits the battle_wild side-table delete (orphaned rows).
//   (iv)  Kills: impl that omits the main battle table delete (zombie battle row).
#[test]
fn ptc5b_3_body_scan_resolve_wild_battle_on_disconnect() {
    let stripped = strip_rust_strings(&strip_rust_comments(MODULE_SOURCE));

    // Assemble fn name from parts per convention (avoid verbatim self-match).
    let fn_name = ["resolve_wild_battle", "_on_disconnect"].concat();

    let body = extract_fn_body(&stripped, &fn_name).unwrap_or_else(|| {
        panic!(
            "TEETH(ptc5b-1): `{}` function not found in battle.rs. \
             This function must exist (ADR pending ptc5b). \
             RED: function not yet implemented.",
            fn_name
        )
    });

    // (i) WILD_IDENTITY must appear in the body — the predicate gates the GC
    //     to the caller's Ongoing WILD battles only.
    //     Assembled in two parts so the literal `WILD_IDENTITY` does not appear
    //     as a single token from this test's own source inside the scanned body.
    let wild_id_needle = ["WILD", "_IDENTITY"].concat();
    assert!(
        body.contains(wild_id_needle.as_str()),
        "TEETH(ptc5b-1/i): `resolve_wild_battle_on_disconnect` body must reference \
         `WILD_IDENTITY` (directly or via `is_ongoing_wild_battle`). Without it the \
         predicate cannot scope to wild battles — any Ongoing battle would be GC'd."
    );

    // (ii) write_back_battle_results must be called — ensures HP/XP are flushed
    //      before the rows are deleted, and uses the log-and-continue pattern on Err.
    let wb_needle = ["write_back_battle", "_results"].concat();
    assert!(
        body.contains(wb_needle.as_str()),
        "TEETH(ptc5b-3/ii): `resolve_wild_battle_on_disconnect` body must call \
         `write_back_battle_results` before deleting the battle rows. \
         Skipping it loses the player's earned XP/HP for the disconnected battle."
    );

    // (iii) battle_wild side-table must be deleted.
    //       The production call: ctx.db.battle_wild().battle_id().delete(id)
    //       Needle assembled in two parts.
    let bw_access = ["ctx.db.battle_wild()", ""].concat();
    let bw_delete = [".battle_id()", ".delete("].concat();
    let bw_needle = [bw_access.as_str(), bw_delete.as_str()].concat();
    assert!(
        body.contains(bw_needle.as_str()),
        "TEETH(ptc5b-3/iii): `resolve_wild_battle_on_disconnect` body must contain \
         `battle_wild().battle_id().delete(` to remove the side-table row. \
         Without it, the wild-encounter side table is orphaned after the main battle delete."
    );

    // (iv) main battle table must also be deleted (NOT only battle_wild).
    //      The production call: ctx.db.battle().battle_id().delete(id)
    //      We must distinguish `battle()` from `battle_wild()`:
    //      needle is `battle()` immediately followed by `.battle_id().delete(`.
    //      Since stripped text has string literals blanked, `battle_wild` is blanked
    //      if it appeared in a string, so we look for the exact accessor sequence.
    let b_access = ["ctx.db.battle()", ".battle_id()"].concat();
    let b_delete = [".delete("].concat();
    let b_needle = [b_access.as_str(), b_delete.as_str()].concat();
    assert!(
        body.contains(b_needle.as_str()),
        "TEETH(ptc5b-3/iv): `resolve_wild_battle_on_disconnect` body must contain \
         `ctx.db.battle().battle_id().delete(` to remove the main battle row. \
         Without it the battle row persists as a zombie, keeping the player soft-locked."
    );
}

// ===========================================================================
// battle-0hp-fix (ADR-0156): 0 HP lead selection + fainted-actor rejection
//
// These are SOURCE-SCAN tests by necessity, not by preference: this module is
// `include_str!("battle.rs")`-based and there is no reducer-executing harness
// (a reducer needs a live `ReducerContext`). The BEHAVIORAL proof for lead
// selection lives in game-core (`combat/types.rs` `with_lead` unit tests and
// `combat/battle_0hp_tests.rs`); what can only be proven here is that the
// server shells actually ADOPT that rule.
//
// Non-vacuity strategy — each scan below asserts more than mere presence. Every
// item marked (verified) is an evasion that a red-team pass actually built and
// got past an earlier, weaker version of these tests:
//   - C1/C2 assert an exact per-body OCCURRENCE COUNT (kills the half-applied
//     fix), a WHITELIST on every access to the two still-`pub` fields `active`
//     and `team` (both can be tampered with immediately after a correct
//     `with_lead` call — verified, twice: `side_a.active -= side_a.active;` and
//     `side_a.team.swap(0, 1);`, each a single inline statement), and the
//     ARGUMENT passed to `with_lead`, because pinning the constructor in
//     game-core does not pin the call site (verified). The field checks are
//     whitelists rather than blacklists on purpose: an enumerated forbidden-list
//     has to guess the next spelling, and it guessed wrong both times.
//   - C3 asserts a PER-CALL-SITE audit, not a whole-function count: a count floor
//     is both evadable (drop both audits, add any unrelated reject) and a
//     false-positive landmine on audit-preserving refactors (verified).
//   - C4 asserts BYTE-POSITION ORDERING *and* that the needle is the whole
//     condition of an `if` *and* that the `if`'s own brace-matched block contains
//     both a `return Err` and an audit call. Ordering alone is satisfied by a
//     dead `let _x = ..is_fainted();` (verified) and by `if false && ..`.
//   - C5/C6 use a DISCRIMINATING expression rather than a generic `is_fainted()`
//     (because `swap_active` legitimately contains a different fainted check),
//     plus a per-body CAP on the bare substring `fainted` to catch a guard hidden
//     behind an obviously-named helper (verified). C5 documents what a source
//     scan provably cannot see.
//
// All scans locate the function body on the FULLY stripped source (comments AND
// strings blanked) via `extract_fn_body_range`, then cut the SAME byte range out
// of the string-bearing view when a needle is itself a string literal. Passing a
// string-bearing source to a brace counter means every `{`/`}` inside every
// string literal is counted; in `battle.rs` that balances today only by accident.
//
// Needles are assembled from parts per this module's convention. (MODULE_SOURCE
// is `battle.rs`, and this file is NOT inside it, so self-match is not an actual
// risk — the split is for consistency.)
//
// EARS coverage: E1 (C1, C2, C3), E2 (C4), E3 (C6), D6 (C5).
// ===========================================================================

// ---------------------------------------------------------------------------
// Scanning helpers (S7): brace-count on a source with NO live string literals
// ---------------------------------------------------------------------------

/// Byte range `[start, end)` of a named `fn`'s body within `src`.
///
/// The SINGLE locate-and-brace-walk implementation in this module (ADR-0003
/// SSOT); [`extract_fn_body`] is a two-line slicing wrapper over it. Returning
/// the RANGE rather than the slice is what lets the identical range be cut out of
/// a DIFFERENT length-preserving view of the same source — see [`fn_body_views`].
///
/// S7: brace-counting is only sound on a source with no live string literals.
/// A caller that passes a comment-stripped-but-string-BEARING source is relying
/// on every `{`/`}` inside every string literal in the scanned function happening
/// to balance — in `battle.rs` that is true today only by accident (the
/// `log::info!` format strings at the tails of `start_battle` and
/// `begin_encounter` use `{{ .. }}`). Every ADR-0156 scan below therefore locates
/// the range on the FULLY stripped source, where no string literal survives to be
/// counted. (Pre-existing callers via [`extract_fn_body`] keep their historical
/// behaviour — this refactor changed no call site.)
fn extract_fn_body_range(src: &str, name: &str) -> Option<(usize, usize)> {
    let pub_needle = format!("pub fn {}(", name);
    let priv_needle = format!("fn {}(", name);
    let fn_start = src
        .find(pub_needle.as_str())
        .or_else(|| src.find(priv_needle.as_str()))?;

    let brace_offset = src[fn_start..].find('{')?;
    let body_start = fn_start + brace_offset + 1;

    let mut depth: usize = 1;
    let mut rel: usize = 0;
    for ch in src[body_start..].chars() {
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                return Some((body_start, body_start + rel));
            }
        }
        rel += ch.len_utf8();
    }
    None
}

/// Two length-preserving views of ONE `fn` body, cut at the SAME byte range.
///
/// Returns `(with_strings, no_strings)`:
///   - `with_strings` — comments blanked, string literals INTACT. Needed for
///     needles that ARE string literals (e.g. `log_reject("start_battle"`).
///   - `no_strings`  — comments AND string literals blanked. Pure ASCII, so any
///     byte offset is a char boundary, and no needle can match text that only
///     exists inside an error message or a log line.
///
/// Both stripper functions blank IN PLACE, so the two strings have identical
/// length and a byte offset found in one is valid in the other. Every ordering /
/// windowing assertion below depends on that property.
fn fn_body_views(name: &str) -> (String, String) {
    let comments_only = strip_rust_comments(MODULE_SOURCE);
    let fully_stripped = strip_rust_strings(&comments_only);
    let (start, end) = extract_fn_body_range(&fully_stripped, name)
        .unwrap_or_else(|| panic!("ADR-0156: `{name}` must exist in server-module/src/battle.rs"));
    debug_assert_eq!(
        comments_only.len(),
        fully_stripped.len(),
        "strip_rust_comments / strip_rust_strings must be length-preserving"
    );
    (
        comments_only[start..end].to_string(),
        fully_stripped[start..end].to_string(),
    )
}

/// The fully-stripped view of a `fn` body — [`fn_body_views`]`.1`.
///
/// Most scans never need the string-bearing view; only the two assertions whose
/// needle IS a string literal (`log_reject("start_battle"` in C3,
/// `log_reject("submit_attack"` in C4) do. This wrapper keeps the other six call
/// sites from binding an ignored `_body_ws`.
fn fn_body(name: &str) -> String {
    fn_body_views(name).1
}

/// Byte range `[inner_start, close)` of the `{ .. }` block that OPENS at or
/// after `from`. `src` must be a fully-stripped (no live strings) body.
///
/// Used to scope an assertion to the body of the `if` that contains a needle,
/// rather than to a window that merely runs "somewhere after" it.
fn block_after(src: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = src.as_bytes();
    let open = from + src[from..].find('{')?;
    let mut depth: usize = 0;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((open + 1, i));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Index of the delimiter that terminates the STATEMENT (or struct-field
/// initialiser) starting at `from` — the first `;` or `,` at nesting depth 0, or
/// the closer that leaves the enclosing construct.
///
/// Depth-aware so a `;` inside an `ok_or_else(|| { .. })` closure, a `let ..
/// else { .. }` block, or a `match { .. }` arm does NOT truncate the window. This
/// is what lets a per-call-site audit assertion (C3) accept every reasonable
/// spelling of the `with_lead` adoption instead of only the one the test author
/// happened to imagine.
fn statement_end(src: &str, from: usize) -> usize {
    let bytes = src.as_bytes();
    let mut depth: i32 = 0;
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth < 0 {
                    return i;
                }
            }
            b';' | b',' if depth == 0 => return i,
            _ => {}
        }
        i += 1;
    }
    bytes.len()
}

// ---------------------------------------------------------------------------
// Lead-construction needles, shared by C1 and C2 so the two reducers cannot
// drift apart in what they are held to.
// ---------------------------------------------------------------------------

/// The one sanctioned construction-time way to establish `active` (ADR-0156 D1).
fn with_lead_needle() -> String {
    ["BattleSide::", "with_lead("].concat()
}

/// Construction-time spellings that ADR-0156 D1 forbids outright, paired with
/// why. Each is asserted to occur ZERO times.
///
/// These are the two *shapes* that can be named exactly. The two *field-access*
/// families — any touch of `BattleSide.active` and any non-order-preserving touch
/// of `BattleSide.team` — cannot be enumerated safely and are handled by the
/// whitelist counts in [`assert_lead_fields_untouched`] instead.
fn forbidden_lead_needles() -> Vec<(String, &'static str)> {
    vec![
        (
            ["BattleSide", " {"].concat(),
            "a `BattleSide { .. }` struct literal — hardcodes the lead with no \
             regard for the monster's HP; this IS the defect",
        ),
        (
            ["set", "_active("].concat(),
            "a `set_active(..)` call at construction — `set_active` is the \
             mid-battle swap mutator (ADR-0053), not a lead selector; \
             `set_active(0)` silently SUCCEEDS whenever slot 0 happens to be \
             conscious and rejects otherwise, which is not the D1 rule",
        ),
    ]
}

/// Assert that a construction reducer's body never touches `BattleSide.active`,
/// and never touches `BattleSide.team` in a way that could reorder or resize it.
///
/// Both checks are WHITELISTS, not blacklists, and that is the point. `active`
/// and `team` are both still `pub` fields (privatization is parked as ADR-0156
/// residual P2, blocked by the `spacetime-type-snapshot` eval), so a shell can
/// adopt `with_lead` correctly for both sides and then undo it on the next line.
/// An enumerated blacklist loses this arms race by construction — two verified
/// evasions walked straight through the previous one:
///
/// - **T1** `side_a.active -= side_a.active;` — a compound assignment. The old
///   needle set listed `.active = ` and `.active=` but no operator form, so
///   `-=`, `+=`, `*=`, `&=`, `|=`, `^=`, `%=`, `<<=`, `>>=` all passed. Rather
///   than list ten operators (and miss the eleventh), forbid the bare field
///   ENTIRELY: `.active` may appear only as part of `.active_monster`.
/// - **T2** `side_a.team.swap(0, 1);` — a post-construction permutation. The
///   argument pin (`with_lead(team_a)` verbatim) kills the PRE-construction
///   permutation but says nothing about afterwards, so the strictly stronger form
///   of the same attack passed. `side_a.team[i]` is positionally coupled to
///   `party_monster_ids[i]` for HP write-back and the XP award loop, and
///   `check_team_coupling` compares LENGTHS ONLY — a permutation is invisible to
///   every other check in the tree. So: `.team` may appear only as `.team.iter()`
///   or `.team.iter_mut()`. Neither can reorder or resize a `Vec` (they hand out
///   element references, never `&mut Vec`), while every mutator that can —
///   `swap`, `sort*`, `rotate_*`, `reverse`, `retain`, `remove`, `insert`,
///   `push`, `pop`, `drain`, `truncate`, `dedup*`, `clear`, `split_off`,
///   `append`, `resize`, whole-field assignment, `[i] =` — is excluded because it
///   is not on the list, without anyone having had to think of it.
///
/// Both whitelists are exact on the shipped code: each reducer reads
/// `state.side_X.team.iter()` twice (building the `BattleStatusStore`) and
/// `state.side_X.team.iter_mut()` twice (writing status back), and neither
/// mentions `.active` at all.
///
/// If a future change needs another genuinely order-preserving accessor (say
/// `.team.len()`), this fails and the whitelist must be widened DELIBERATELY.
/// That is the intended failure mode, not a defect.
fn assert_lead_fields_untouched(reducer: &str, body: &str) {
    // --- T1: `.active` may only appear inside `.active_monster` ---------------
    let active_any = body.matches(".active").count();
    let active_accessor = body.matches(".active_monster").count();
    let bare_active = active_any.saturating_sub(active_accessor);
    assert_eq!(
        bare_active, 0,
        "TEETH (E1/D1 T1): `{reducer}` touches the bare `BattleSide.active` field \
         {bare_active} time(s). At construction, `active` is computed by \
         `with_lead` (first slot with current_hp > 0) and by NOTHING else — not \
         `= 0`, and not a compound assignment such as `side_a.active -= \
         side_a.active`, which is how this evasion was actually built. The field \
         is still `pub` (residual P2), so the only durable rule is: do not name \
         it here. If you need to READ the lead, call `active_monster()`."
    );

    // --- T2: `.team` may only appear as an order-preserving accessor ----------
    let team_any = body.matches(".team").count();
    let team_iter = body.matches(".team.iter()").count();
    let team_iter_mut = body.matches(".team.iter_mut()").count();
    let team_other = team_any.saturating_sub(team_iter + team_iter_mut);
    assert_eq!(
        team_other, 0,
        "TEETH (E1/D1 T2): `{reducer}` touches `BattleSide.team` in \
         {team_other} way(s) that are not `.team.iter()` ({team_iter}) or \
         `.team.iter_mut()` ({team_iter_mut}) out of {team_any} total `.team` \
         occurrences. After `with_lead` returns, the team must not be reordered or \
         resized: `side_a.team[i]` is positionally coupled to \
         `party_monster_ids[i]` for HP write-back and the XP award loop, and \
         `check_team_coupling` compares LENGTHS ONLY — so a `team.swap(0, 1)` \
         here silently writes one monster's post-battle HP onto another's row and \
         awards its XP to the wrong monster, and nothing else in the tree can see \
         it. `iter()`/`iter_mut()` hand out element references and cannot reorder \
         a Vec; every method that can is excluded by not being on this list. \
         Widening the whitelist is a deliberate decision, not a formality."
    );
}

/// **C1** — EARS E1 (ADR-0156 D1): `start_battle` must build BOTH sides through
/// `BattleSide::with_lead`, passing the team vectors UNMODIFIED, and must
/// establish `active` in no other way.
///
/// Three layers, each closing a verified evasion:
///
/// 1. **Exact count (== 2).** `assert!(body.contains("with_lead"))` passes on a
///    half-applied fix that converts side A and leaves side B as
///    `BattleSide { active: 0, team: team_b }` — still seating a 0 HP opponent
///    lead. A presence-only needle cannot see that; the count can.
/// 2. **The fields, whitelisted (S2 + T1 + T2).** `BattleSide { .. }` and
///    `set_active(` are forbidden outright; then
///    [`assert_lead_fields_untouched`] requires that `.active` appear ONLY inside
///    `.active_monster`, and `.team` ONLY as `.team.iter()` / `.team.iter_mut()`.
///    Both fields are still `pub` (residual P2), so a tree can adopt `with_lead`
///    for both sides and undo it on the next line. Enumerated needles lose that
///    arms race: `side_a.active -= side_a.active;` (T1) walked past a set that
///    listed `.active = ` and `.active=` but no compound operator, and
///    `side_a.team.swap(0, 1);` (T2) walked past layer 3 entirely. Whitelists do
///    not have to anticipate the next spelling.
/// 3. **The ARGUMENT (S3).** `with_lead(team_a)` / `with_lead(team_b)` verbatim.
///    `with_lead_preserves_team_order` in game-core pins the CONSTRUCTOR; nothing
///    pinned the CALL SITE. `let mut t = team_a; t.swap(0, i);
///    BattleSide::with_lead(t)` passes layers 1 and 2 and produces exactly the
///    silent HP/XP write-back corruption D1 warns about — `side_a.team[i]` is
///    positionally coupled to `party_monster_ids[i]` and `check_team_coupling`
///    compares LENGTHS ONLY, so a permutation is invisible everywhere else.
///    Layer 2's `.team` whitelist closes the mirror-image attack AFTER the call.
///
/// Kills: the half-applied fix; adopt-then-overwrite via either pub field, by
/// plain OR compound assignment; a permuted/filtered team argument before the
/// call OR a permuted `side.team` after it; `set_active(0)` masquerading as lead
/// selection.
///
/// NOTE (deliberate, ADR-0156-recorded constraint): the two calls must stay
/// INLINE in this body. Factoring them into a shared `fn build_side(..)` helper
/// would leave both reducer bodies with zero `with_lead(` and fail this test on
/// an otherwise-correct fix. The per-body count is the point — a whole-file count
/// cannot distinguish "both sides converted" from "side A converted twice".
///
/// GREEN as of the ADR-0156 implementation: 2 `with_lead` calls, 0 forbidden
/// spellings, `.active` untouched, `.team` only iterated, both teams passed
/// directly. It was RED before: two `BattleSide {` literals with `active: 0`.
#[test]
fn start_battle_constructs_both_sides_via_with_lead() {
    let body = fn_body("start_battle");

    // Layer 1: exact call count.
    let with_lead = with_lead_needle();
    let call_count = body.matches(with_lead.as_str()).count();
    assert_eq!(
        call_count, 2,
        "TEETH (C1/E1/D1): `start_battle` must call `BattleSide::with_lead(` \
         EXACTLY twice — once for side A, once for side B; found {call_count}. \
         A count of 1 is the half-applied fix: side A is repaired while side B \
         still seats a 0 HP opponent as lead. Keep both calls INLINE in this body \
         (a shared build_side() helper would zero this count on a correct fix)."
    );

    // Layer 2: no other way to establish `active`, and no post-construction
    // tampering with either `active` (T1) or `team` (T2).
    for (needle, why) in forbidden_lead_needles() {
        let n = body.matches(needle.as_str()).count();
        assert_eq!(
            n, 0,
            "TEETH (C1/E1/D1): `start_battle` must contain no `{needle}` — {why}. \
             Found {n} occurrence(s). At construction, `active` is computed by \
             `with_lead` (first slot with current_hp > 0) and by nothing else."
        );
    }
    assert_lead_fields_untouched("start_battle", &body);

    // Layer 3: the argument itself (S3).
    let arg_a = ["with_lead(", "team_a)"].concat();
    let arg_b = ["with_lead(", "team_b)"].concat();
    assert!(
        body.contains(arg_a.as_str()),
        "TEETH (C1/E1/D1 S3): `start_battle` must pass `team_a` to `with_lead` \
         DIRECTLY — the exact text `with_lead(team_a)`. Any intervening \
         reorder/filter (`t.swap(0, i)`, `sort_by_key`, `retain`) breaks the \
         positional coupling between `side_a.team[i]` and `party_monster_ids[i]`, \
         silently writing one monster's post-battle HP onto another's row and \
         awarding its XP to the wrong monster. `check_team_coupling` compares \
         lengths only and cannot detect a permutation."
    );
    assert!(
        body.contains(arg_b.as_str()),
        "TEETH (C1/E1/D1 S3): `start_battle` must pass `team_b` to `with_lead` \
         DIRECTLY — the exact text `with_lead(team_b)`. Side B is positionally \
         coupled to `opponent_monster_ids[i]` the same way side A is to \
         `party_monster_ids[i]`."
    );
}

/// **C2** — EARS E1 (ADR-0156 D1): `begin_encounter` — the wild-encounter shell
/// — must build BOTH sides through `BattleSide::with_lead` as well.
///
/// `begin_encounter` builds the `Battle` row DIRECTLY rather than delegating to
/// `start_battle` (so `start_battle`'s owned-opponent guards stay intact), which
/// means it carries its own copy of the defect and needs its own scan. Drew's r2
/// repro came through the wild path, so this is the reducer his session actually
/// exercised.
///
/// Same three layers as C1 (exact count / whitelisted `active` + `team` field
/// access / the argument), with one asymmetry: only `with_lead(team_a)` is pinned
/// by argument. Side B here is the single freshly-rolled wild, which has NO
/// backing `monster` row (`opponent_monster_ids` is empty by design — see the
/// ASYMMETRY note in `begin_encounter`), so it carries no positional coupling to
/// protect. The `.team` whitelist still applies to BOTH sides: the status-store
/// write-back loop below the constructor iterates side B too.
///
/// Same inline-call constraint as C1 (see its note).
///
/// GREEN as of the ADR-0156 implementation; it was RED before (two
/// `BattleSide {` literals with `active: 0`, zero `with_lead` calls).
#[test]
fn begin_encounter_constructs_both_sides_via_with_lead() {
    let body = fn_body("begin_encounter");

    let with_lead = with_lead_needle();
    let call_count = body.matches(with_lead.as_str()).count();
    assert_eq!(
        call_count, 2,
        "TEETH (C2/E1/D1): `begin_encounter` must call `BattleSide::with_lead(` \
         EXACTLY twice (the player's party on side A, the single wild on side B); \
         found {call_count}. A count of 1 is the half-applied fix. Keep both calls \
         INLINE in this body."
    );

    for (needle, why) in forbidden_lead_needles() {
        let n = body.matches(needle.as_str()).count();
        assert_eq!(
            n, 0,
            "TEETH (C2/E1/D1): `begin_encounter` must contain no `{needle}` — \
             {why}. Found {n} occurrence(s). This is the reducer Drew's r2 wild \
             encounter actually went through."
        );
    }
    assert_lead_fields_untouched("begin_encounter", &body);

    let arg_a = ["with_lead(", "team_a)"].concat();
    assert!(
        body.contains(arg_a.as_str()),
        "TEETH (C2/E1/D1 S3): `begin_encounter` must pass `team_a` to `with_lead` \
         DIRECTLY — the exact text `with_lead(team_a)`. A reorder between building \
         `team_a` and constructing the side breaks the positional coupling with \
         `party_monster_ids[i]`, corrupting HP write-back and the XP award loop. \
         (Side B is the unowned wild and is deliberately not pinned by argument.)"
    );
}

/// **C3** — EARS E1 audit-preservation (ADR-0156 D1): each of `start_battle`'s
/// two `with_lead` call sites must carry its own `log_reject` audit call.
///
/// D1 folds `start_battle`'s two separate "has a conscious member" guards into
/// `with_lead`'s `None` — most naturally `.ok_or_else(|| { .. })?`. It is very
/// easy to write that closure with the error string but WITHOUT the `log_reject`
/// call the current `if !team.iter().any(..)` block performs, because `?`
/// propagation reads as complete. Nothing else in `just ci` notices a lost audit
/// record: the reducer still returns exactly the right `Err`.
///
/// The assertion is PER CALL SITE, not a count over the whole function (S6). A
/// whole-function floor is both too loose and a false-positive landmine:
///   - too loose — both `with_lead` audit calls can be dropped and the floor
///     still met if any unrelated reject is added elsewhere in the body;
///   - landmine — an audit-PRESERVING refactor (hoisting the reducer name into a
///     `const`, or wrapping the two lines in a local closure) trips a
///     whole-function count and blames the `with_lead` refactor for it.
///
/// The window for each site runs from `BattleSide::with_lead(` to the delimiter
/// that ends that statement/field-initialiser at nesting depth 0, so a `;` inside
/// the `ok_or_else` closure (or a `let .. else { .. }` / `match { .. }` spelling)
/// does not truncate it. The needle inside the window is the bare `log_reject(`
/// — name-agnostic, so hoisting `"start_battle"` into a const still passes.
///
/// HONEST LIMIT: a source scan cannot see through indirection. If the audit call
/// is moved behind a differently-named helper invoked from the window, this scan
/// reports a pass. It catches the realistic failure — the audit simply not being
/// written — not a determined evasion.
///
/// Kills: an `ok_or_else`/`let .. else`/`match` adoption of `with_lead` that
/// returns the reject `Err` without auditing it; a fix that audits one side and
/// not the other (the site count is asserted too).
///
/// GREEN as of the ADR-0156 implementation: both `ok_or_else` closures call
/// `log_reject("start_battle", me, &e)` before returning the message. It was RED
/// while the reducer still used `BattleSide { active: 0, .. }` literals (zero
/// call sites to audit).
#[test]
fn start_battle_still_logs_the_no_conscious_monster_rejects() {
    // `body_ws` keeps string literals (the audit call is easier to read there);
    // `body` is fully stripped and is what we locate offsets in.
    let (body_ws, body) = fn_body_views("start_battle");

    let with_lead = with_lead_needle();
    let audit_needle = ["log", "_reject("].concat();

    let mut sites = 0usize;
    let mut search_from = 0usize;
    while let Some(rel) = body[search_from..].find(with_lead.as_str()) {
        let site = search_from + rel;
        let end = statement_end(&body, site);
        sites += 1;

        let window = &body_ws[site..end];
        assert!(
            window.contains(audit_needle.as_str()),
            "TEETH (C3/E1/D1 audit preservation): the `BattleSide::with_lead(` \
             call site at byte {site} of `start_battle` (site #{sites}) has no \
             `log_reject(` in its statement. D1 folds a log_reject-carrying \
             'has a conscious member' guard into this constructor's `None` arm — \
             the arm must still audit before returning the error string. A dropped \
             audit record is invisible to every other check in `just ci` because \
             the reducer still returns the correct Err. Statement scanned:\n{window}"
        );

        search_from = site + with_lead.len();
    }

    assert_eq!(
        sites, 2,
        "TEETH (C3/E1/D1): `start_battle` must have EXACTLY 2 `BattleSide::with_lead(` \
         call sites to audit (side A: 'party has no conscious monster'; side B: \
         'opponent has no conscious monster'); found {sites}. RED today because \
         the reducer still uses `BattleSide {{ active: 0, .. }}` literals."
    );
}

/// **C4** — EARS E2 (ADR-0156 D2): `submit_attack` must reject an attack whose
/// active monster has already fainted — and must do so in the right PLACE, with
/// a real rejection, and with an audit record.
///
/// This guard is defence for LEGACY `battle` rows: rows already persisted in the
/// live playtest DB with a 0 HP active. D1 is start-time-only and does not
/// retroactively repair them. Without this guard, `calc_damage` (which never
/// reads the attacker's HP) lets a corpse deal FULL damage — Drew's "the attack
/// appears to process" is not cosmetic, the hit is real.
///
/// Presence is not enough, and neither is ordering. Three layers:
///
/// **(i) ORDER.** `is_ranked_pvp` < `active_monster().is_fainted()` <
/// `known_skill_ids` < `resolve_full_turn`.
/// - after `is_ranked_pvp`: PvP is funnelled to `submit_pvp_action` first
///   (ADR-0119 D5); PvP is explicitly NOT fixed by this slice (ADR-0156 D7).
/// - before the moveset check: a corpse must not produce the misleading
///   "skill N not in active monster's moveset".
/// - before `resolve_full_turn`: a guard after the resolver is not a guard.
///
/// **(ii) SHAPE (S1a).** The needle must be the WHOLE condition of an `if`. A
/// position-only scan is satisfied by
/// `let _adr0156_d2 = battle.state.side_a.active_monster().is_fainted();` — a
/// dead binding that rejects nothing (verified evasion) — and by
/// `if false && ..`. So: an `if ` in the bytes just before the needle, and the
/// text between the last such `if ` and the needle must be a bare receiver path
/// (no `=`/`;`, which mean a binding; no `&&`/`||`/`!`, which mean defused or
/// inverted).
///
/// **(iii) EFFECT (S1b).** The `if`'s own brace-matched block must contain both a
/// `return Err` and a `log_reject("submit_attack"`, and must CLOSE before the
/// moveset check. An earlier version searched `body[fainted_pos..]` — a window
/// running to end-of-function — for the audit needle. That was structurally
/// incapable of failing: layer (i) already guarantees the PRE-EXISTING moveset
/// `log_reject("submit_attack", ..)` falls inside it. Scoping to the guard's own
/// block is what gives the assertion teeth.
///
/// Reject-not-clamp: the reducer must NOT auto-swap to a conscious monster — a
/// silent auto-swap is precisely the round-2 surprise Drew reported, promoted to
/// a feature.
///
/// Kills: a missing guard; a DEAD guard (`let _x = ..is_fainted();` — verified to
/// slip past a position-only scan); a defused guard (`if false && ..`); a guard
/// placed after the moveset check (wrong error message) or after
/// `resolve_full_turn` (no effect); a guard that merely mentions `is_fainted` in
/// a log string; a guard on the wrong subject (`team[i]`); a guard that returns
/// no `Err`; a guard that returns `Err` without an audit record.
///
/// GREEN as of the ADR-0156 implementation (`battle.rs`: the guard sits between
/// the `is_ranked_pvp` reject and the moveset check, with its own `log_reject` +
/// `return Err`). It was RED while `active_monster().is_fainted()` was absent.
#[test]
fn submit_attack_rejects_a_fainted_active() {
    // Two length-preserving views of the SAME byte range (see `fn_body_views`):
    // `body_ws` keeps string literals, `body_ns` blanks them. Offsets are shared.
    let (body_ws, body_ns) = fn_body_views("submit_attack");

    let fainted_needle = ["active_monster()", ".is_fainted()"].concat();
    let pvp_needle = ["is_ranked", "_pvp"].concat();
    let moveset_needle = ["known_skill", "_ids"].concat();
    let resolver_needle = ["resolve_full", "_turn"].concat();
    let reject_needle = ["log_reject(\"submit", "_attack\""].concat();
    let return_err = ["return ", "Err"].concat();

    let fainted_pos = body_ns.find(fainted_needle.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (C4/E2/D2): `submit_attack` must contain the fainted-active guard \
             expression `battle.state.side_a.active_monster().is_fainted()`. \
             Without it, a legacy row with a 0 HP active resolves a FULL-damage \
             attack (calc_damage never reads the attacker's HP) and the enemy's \
             counter-hit produces the unexplained Faint+Switch Drew reported. \
             RED: needle absent from the current body."
        )
    });

    let pvp_pos = body_ns
        .find(pvp_needle.as_str())
        .expect("ADR-0119 D5: `submit_attack` must contain the is_ranked_pvp guard");
    let moveset_pos = body_ns
        .find(moveset_needle.as_str())
        .expect("`submit_attack` must validate skill_id against known_skill_ids");
    let resolver_pos = body_ns
        .find(resolver_needle.as_str())
        .expect("`submit_attack` must call resolve_full_turn");

    // ---- Ordering ---------------------------------------------------------
    assert!(
        pvp_pos < fainted_pos,
        "TEETH (C4/E2/D2) ORDER: the fainted-active guard (pos {fainted_pos}) must \
         be sited AFTER the `is_ranked_pvp` guard (pos {pvp_pos}) — a PvP battle \
         must be funnelled to submit_pvp_action first (ADR-0119 D5); PvP is not \
         fixed by this slice (ADR-0156 D7)."
    );
    assert!(
        fainted_pos < moveset_pos,
        "TEETH (C4/E2/D2) ORDER: the fainted-active guard (pos {fainted_pos}) must \
         be sited BEFORE the `known_skill_ids` moveset check (pos {moveset_pos}) — \
         a corpse must not produce the misleading error \
         'skill N not in active monster's moveset'."
    );
    assert!(
        moveset_pos < resolver_pos,
        "TEETH (C4/E2/D2) ORDER: the moveset check (pos {moveset_pos}) must precede \
         `resolve_full_turn` (pos {resolver_pos}); a guard sited after the resolver \
         is not a guard at all."
    );

    // ---- S1(a): the needle must BE the condition of an `if`, whole ---------
    // A position-only scan is satisfied by `let _adr0156_d2 = battle.state
    // .side_a.active_monster().is_fainted();` — a dead binding that rejects
    // nothing (verified evasion). Require an `if ` in the bytes just before the
    // needle, and require the text between the LAST such `if ` and the needle to
    // be a bare receiver path: no `=` / `;` (a binding), and no `&&` / `||` / `!`
    // (a defused `if false && ..` or an inverted condition).
    //
    // The teeth are the `=`/`;` check, not the window size: even if the window is
    // wide enough to reach an `if ` belonging to an EARLIER guard, everything
    // between it and a dead binding necessarily contains `{`, `;` and `=`. The
    // window is sized generously (64 bytes, vs ~55 for the one-line guard) purely
    // so an unusual-but-correct line break cannot produce a false failure.
    let window_start = fainted_pos.saturating_sub(64);
    let prefix = &body_ns[window_start..fainted_pos]; // body_ns is pure ASCII
    let if_rel = prefix.rfind("if ").unwrap_or_else(|| {
        panic!(
            "TEETH (C4/E2/D2 S1a): the fainted-active check at byte {fainted_pos} of \
             `submit_attack` is not the condition of an `if` — no `if ` in the 64 \
             bytes before it. A dead binding \
             (`let _x = ..active_monster().is_fainted();`) rejects nothing while \
             satisfying a presence/position scan. Write the guard as \
             `if battle.state.side_a.active_monster().is_fainted() {{ .. }}`. \
             Preceding bytes were:\n{prefix}"
        )
    });
    let condition_head = &prefix[if_rel + "if ".len()..];
    for bad in ["=", ";", "&&", "||", "!"] {
        assert!(
            !condition_head.contains(bad),
            "TEETH (C4/E2/D2 S1a): the text between `if ` and \
             `active_monster().is_fainted()` in `submit_attack` contains `{bad}`, so \
             the fainted check is not the whole condition. `=`/`;` mean it is a \
             binding rather than a guard; `&&`/`||` mean it is defused (`if false \
             && ..`); `!` means it is inverted. Found:\n`if {condition_head}`"
        );
    }

    // ---- S1(b): the guard's OWN block must reject, and audit ---------------
    // Scope both assertions to the brace-matched `{ .. }` that opens after the
    // needle. The previous formulation searched `body[fainted_pos..]` — a window
    // running to end-of-function, which the ordering assertion above guarantees
    // contains the PRE-EXISTING moveset `log_reject("submit_attack", ..)`. That
    // made it structurally incapable of failing.
    let (blk_start, blk_end) = block_after(&body_ns, fainted_pos).unwrap_or_else(|| {
        panic!(
            "TEETH (C4/E2/D2 S1b): the fainted-active guard in `submit_attack` has \
             no `{{ .. }}` block after it. The guard must be \
             `if .. {{ let e = ..; log_reject(..); return Err(e); }}`."
        )
    });
    let block_ns = &body_ns[blk_start..blk_end];
    let block_ws = &body_ws[blk_start..blk_end];

    assert!(
        block_ns.contains(return_err.as_str()),
        "TEETH (C4/E2/D2 S1b): the fainted-active guard's block (bytes \
         {blk_start}..{blk_end} of `submit_attack`) contains no `return Err`. \
         An `if` whose body does not reject is a no-op — reject-not-clamp \
         (ADR-0156 D2): do NOT auto-swap to a conscious monster, because a silent \
         auto-swap is precisely the round-2 surprise Drew reported, promoted to a \
         feature. Block scanned:\n{block_ns}"
    );
    assert!(
        block_ws.contains(reject_needle.as_str()),
        "TEETH (C4/E2/D2 S1b): the fainted-active guard's block (bytes \
         {blk_start}..{blk_end} of `submit_attack`) contains no \
         `log_reject(\"submit_attack\", ..)`. Every reducer rejection in this module \
         is audited, and this is the one that will actually fire on the live \
         playtest DB's legacy rows. Block scanned:\n{block_ws}"
    );
    assert!(
        blk_end < moveset_pos,
        "TEETH (C4/E2/D2 S1c): the fainted-active guard's block must CLOSE (byte \
         {blk_end}) before the `known_skill_ids` moveset check (byte {moveset_pos}) \
         — otherwise the 'block' the audit was found in is some enclosing scope, \
         not the guard's own, and the audit could belong to the moveset reject."
    );
}

/// **C5** — ADR-0156 **D6** (the no-soft-lock contract): `swap_active` and `flee`
/// must deliberately NOT gain a fainted-active guard.
///
/// This is an ANTI-regression test — it protects an intentional asymmetry that a
/// later reader will be tempted to "fix for consistency". Swapping AWAY from a
/// 0 HP active and fleeing are the player's RECOVERY paths out of a legacy row.
/// Guarding them would strand the player in an unplayable `Ongoing` battle:
/// `submit_attack` rejects (D2), `swap_active` rejects, `flee` rejects, and
/// `is_in_ongoing_battle` blocks every other battle path — a soft-lock with no
/// exit. The full state walk (ADR-0156 D6) is: submit_attack rejects;
/// swap_active succeeds; attempt_recruit on failure lets the wild strike the
/// corpse, which self-repairs the row; flee exits unconditionally in PvE.
///
/// Two needle layers, because one is not enough:
///
/// 1. The DISCRIMINATING expression `active_monster().is_fainted()` must be
///    absent from `swap_active` / `flee` and present in `submit_attack`. A
///    generic `is_fainted()` needle would be useless: `swap_active` legitimately
///    contains `team[idx].is_fainted()` for the swap TARGET (see C6).
/// 2. A CAP on the bare substring `fainted` per body — exactly 1 in
///    `swap_active` (its one legitimate target check) and 0 in `flee`, counted on
///    the string-stripped body so the `"monster at index N is fainted"` error
///    message does not register. Layer 1 alone is evaded by one level of
///    indirection: adding `reject_if_active_fainted(&battle, me, "swap_active")?;`
///    to both reducers soft-locks the player exactly as D6 forbids while keeping
///    the literal expression out of the body (verified evasion). The cap catches
///    any such helper whose name contains `fainted`.
///
/// HONEST LIMIT (this replaces an earlier, wrong claim that this test "kills a
/// fix that adds the guard to a shared helper"): a source scan cannot see through
/// indirection. A helper named to avoid the word `fainted` — say
/// `reject_if_lead_is_ko(..)` — is invisible to every needle here. What this test
/// can and does enforce is that no fainted-active check is written INLINE in
/// these two recovery paths, and that no obviously-named helper is called from
/// them. Proving the deeper property needs a reducer-executing harness, which
/// this module does not have.
///
/// Kills: a "consistency" refactor that inlines the fainted-active guard into
/// `swap_active` or `flee`; the `reject_if_active_fainted(..)` helper-indirection
/// variant; a build where the guard was never written at all (the positive arm).
///
/// All four arms are GREEN as of the ADR-0156 implementation and must STAY green:
/// `swap_active` has exactly its one target check, `flee` has none, and
/// `submit_attack` carries the D2 guard inline. The positive arm was RED before
/// the implementation landed.
#[test]
fn swap_active_and_flee_deliberately_have_no_fainted_active_guard() {
    let fainted_needle = ["active_monster()", ".is_fainted()"].concat();
    let bare_needle = ["fain", "ted"].concat();

    let swap_body = fn_body("swap_active");
    let flee_body = fn_body("flee");
    let attack_body = fn_body("submit_attack");

    // ---- Layer 1: the discriminating expression ---------------------------
    assert!(
        !swap_body.contains(fainted_needle.as_str()),
        "TEETH (C5/ADR-0156 D6): `swap_active` must NOT contain \
         `active_monster().is_fainted()`. Swapping AWAY from a 0 HP active is the \
         player's recovery path out of a legacy row; guarding it 'for consistency' \
         strands the player in an unplayable Ongoing battle with no exit. \
         (`swap_active`'s legitimate `team[idx].is_fainted()` check on the swap \
         TARGET is a different expression and is required — see \
         swap_active_rejects_a_fainted_swap_target.)"
    );
    assert!(
        !flee_body.contains(fainted_needle.as_str()),
        "TEETH (C5/ADR-0156 D6): `flee` must NOT contain \
         `active_monster().is_fainted()`. Fleeing is the unconditional PvE exit \
         from a legacy 0 HP-active row; guarding it removes the last way out."
    );

    // ---- Layer 2: cap the bare substring, catching named helpers ----------
    let swap_fainted = swap_body.matches(bare_needle.as_str()).count();
    assert_eq!(
        swap_fainted, 1,
        "TEETH (C5/ADR-0156 D6): `swap_active` must contain EXACTLY ONE `fainted` \
         in code — its `team[idx].is_fainted()` check on the swap TARGET; found \
         {swap_fainted}. More than one means a second fainted check crept in \
         (inline, or as a call to a helper such as `reject_if_active_fainted(..)`), \
         which soft-locks any player sitting on a legacy 0 HP-active row. Fewer \
         means the required target check was removed (see C6). Counted on the \
         string-stripped body, so the \"is fainted\" error message does not count."
    );
    let flee_fainted = flee_body.matches(bare_needle.as_str()).count();
    assert_eq!(
        flee_fainted, 0,
        "TEETH (C5/ADR-0156 D6): `flee` must contain NO `fainted` in code at all; \
         found {flee_fainted}. `flee` is the unconditional PvE exit — it has no \
         business inspecting anyone's HP, inline or through a helper."
    );

    // ---- The positive arm: the guard must exist SOMEWHERE ------------------
    // Without this, the two absence assertions above pass trivially on a build
    // where the D2 guard was never implemented.
    assert!(
        attack_body.contains(fainted_needle.as_str()),
        "TEETH (C5/ADR-0156 D6/D2): `submit_attack` MUST contain \
         `active_monster().is_fainted()`, written INLINE in that reducer. This arm \
         is what makes the two absence assertions above non-vacuous — it proves the \
         guard exists and that swap_active/flee were exempted deliberately rather \
         than the guard never having been written. Do NOT satisfy this by routing \
         all three reducers through a shared helper: D6 requires submit_attack to \
         reject where swap_active and flee do not. \
         RED today (see submit_attack_rejects_a_fainted_active)."
    );
}

/// **C6** — EARS E3 layer 1 (ADR-0156 D5): swapping INTO a 0 HP monster is
/// rejected — `swap_active`'s fainted check must index the swap TARGET, not the
/// current active.
///
/// The spec asked us to VERIFY rather than assume, and the verification found no
/// hole. That is a result, not a gap, so it is pinned rather than left implicit.
///
/// Layer 2 of this criterion — `BattleSide::set_active` returning
/// `SwapError::Fainted` and leaving `active` unchanged (the ADR-0053
/// sanctioned-mutator contract) — is ALREADY proven by
/// `set_active_fainted_target_rejects_and_leaves_active_unchanged` in
/// `game-core/src/combat/types.rs`. It is deliberately NOT duplicated here.
///
/// Kills: a refactor that "simplifies" the target check into a current-active
/// check (which would let a player swap into a corpse while rejecting a legal
/// swap away from one — precisely inverted); removal of the target check
/// entirely (which would rely solely on `set_active`'s silent rejection inside
/// `resolve_player_swap`, losing the reducer-level `Err` and its audit record).
///
/// GREEN today — an anti-regression pin.
#[test]
fn swap_active_rejects_a_fainted_swap_target() {
    let body = fn_body("swap_active");

    let target_needle = ["team[idx]", ".is_fainted()"].concat();
    assert!(
        body.contains(target_needle.as_str()),
        "TEETH (C6/E3/D5 layer 1): `swap_active` must reject a fainted swap TARGET \
         via `battle.state.side_a.team[idx].is_fainted()` before mutating anything. \
         Without it the reducer returns Ok while `resolve_player_swap` silently \
         no-ops (set_active rejects internally), so the player sees a successful \
         swap that did not happen."
    );

    let active_needle = ["active_monster()", ".is_fainted()"].concat();
    assert!(
        !body.contains(active_needle.as_str()),
        "TEETH (C6/E3/D5 + D6): `swap_active`'s fainted check must index the swap \
         TARGET (`team[idx]`), NOT the current active (`active_monster()`). \
         Checking the active inverts the rule: it would reject the legal recovery \
         swap away from a corpse while still permitting a swap INTO one."
    );
}

// ===========================================================================
// EG2 — battle-side essence / Trust / Quality-Time credits
// (spec `M-evolution-essence-graph.spec.md` §2 EG2-7 + EG2-12; ADR-0175 D4)
//
// EARS criteria covered in this section:
//
//   EG2-7   `write_back_battle_results` SHALL, on a WILD-battle win, grant
//           `max(1, loser_bst / 30)` essence of the DEFEATED species' Affinity to
//           each winning active-participant monster; on a WILD-battle faint,
//           increment `trust_unfavorable_count`; on a WILD-battle win, credit
//           Trust-favorable at most once per monster per day via
//           `trust_favorable_battle_day_epoch`; and accrue Quality Time for the
//           winning participants. ALL THREE credits SHALL be BOTH practice-
//           AND PvP-exempted — wild battles only.
//
//   EG2-12  The auto-evolution check SHALL run as the LAST step, after the
//           essence / Trust / Quality-Time / level mutation this reducer performs
//           has actually been written back.
//
// SEAM AVAILABILITY — stated up front because it decides the shape of every test
// below. This module has NO reducer-executing harness and no TestDb: a reducer
// needs a live `ReducerContext`, a finding already recorded twice in this file
// (the M14e header, and the ADR-0156 header) and again in `movement_tests.rs`
// (ADR-0156 P7). `write_back_battle_results` therefore cannot be EXECUTED here,
// so "a wild win grants essence to conscious winners only" has no honest
// behavioural expression in this crate today, and standing up a DB harness for
// one slice is out of scope. The split used instead is exactly the one this file
// already applies to `is_ongoing_wild_battle` (T1/T2 above):
//
//   * every rule that CAN be a pure function is one, and is asserted BY VALUE
//     against constructed fixtures — `essence_battle_reward`, `day_epoch_utc`,
//     `is_wild_battle`. Those three are RED BY COMPILE until the specialist adds
//     them (the symbols do not exist in `battle.rs` at HEAD).
//   * the residue that exists only as wiring inside the reducer body — placement,
//     gating, ordering, and the post-dual-write tails — is pinned by source scan
//     over the extracted body. Those are RED BY SCAN (they compile today and fail
//     at runtime because the needles are absent).
//
// What a scan provably cannot see is restated per test under HONEST LIMITS.
// Needles are assembled from parts per this module's convention (MODULE_SOURCE is
// `battle.rs` and this file is not inside it, but several evals concatenate every
// non-test source in this crate, so keeping needle text un-spelled here is free
// insurance).
// ===========================================================================

/// **EG2-7 (pure)** — the essence reward FLOORS at 1, so a low-BST wild win is
/// never a zero-essence win.
///
/// kills: `bst / 30` written without the `max(1, ..)` floor — every species below
/// BST 30 would award nothing at all, making those encounters silently
/// evolution-inert (the floor is the literal text of EG2-7: `max(1, loser_bst / 30)`).
/// Also kills a `saturating_sub`-flavoured mis-transcription that returns 0.
///
/// Values are HARDCODED, never derived from `ESSENCE_BST_DIVISOR` — a test that
/// recomputes the formula from the same constant the implementation uses proves
/// nothing about either.
#[test]
fn essence_battle_reward_floors_at_one() {
    assert_eq!(
        super::essence_battle_reward(0),
        1,
        "EG2-7: a BST of 0 must still award the floor of 1 essence, not 0. \
         TEETH: kills a bare `bst / 30` with no `max(1, ..)`."
    );
    assert_eq!(
        super::essence_battle_reward(20),
        1,
        "EG2-7: BST 20 -> 20/30 = 0, which must be floored to 1. \
         TEETH: kills a bare `bst / 30` with no `max(1, ..)`."
    );
    assert_eq!(
        super::essence_battle_reward(29),
        1,
        "EG2-7: BST 29 is the last value below the divisor and must still award 1. \
         TEETH: kills an off-by-one floor such as `max(1, ..)` applied to the wrong side."
    );
    assert_eq!(
        super::essence_battle_reward(30),
        1,
        "EG2-7: BST 30 -> exactly 1 (30/30). TEETH: kills a `+ 1` fudge that would \
         make the divisor boundary award 2, and kills a `max(1, ..)` that clamps \
         everything to 1."
    );
}

/// **EG2-7 (pure)** — the essence reward SCALES with the defeated species' BST at
/// the deliberately steeper divisor, three times steeper than currency's.
///
/// kills: reusing `battle_currency_reward`'s `loser_bst / 10` rate for essence.
/// EG2-7 calls that out by name: at /10 a BST-300 win yields 30, which cleared
/// every authored essence threshold in 3-5 wins (a real undertuning risk). The
/// assertions below are 10, not 30 — an aliased or copy-pasted currency formula
/// fails all three. Also kills a rounding-up variant: 318/30 is 10.6 and must
/// truncate to 10, not 11.
#[test]
fn essence_battle_reward_scales() {
    assert_eq!(
        super::essence_battle_reward(300),
        10,
        "EG2-7: BST 300 must award 10 essence (300/30). A value of 30 here means the \
         implementation reused `battle_currency_reward`'s /10 rate, which EG2-7 \
         explicitly rejects as a 3x undertuning."
    );
    assert_eq!(
        super::essence_battle_reward(318),
        10,
        "EG2-7: BST 318 (the lowest BST in shipped content) must award 10 — integer \
         division TRUNCATES 10.6 down. TEETH: kills a round-half-up or ceiling variant."
    );
    assert_eq!(
        super::essence_battle_reward(450),
        15,
        "EG2-7: BST 450 must award 15 essence (450/30). TEETH: kills a constant \
         reward that ignores the loser's BST entirely — with the two assertions \
         above, only a genuinely BST-proportional formula passes all three."
    );
}

/// **EG2-7 (pure)** — the day epoch is the UTC-day index of a server timestamp,
/// and it SATURATES instead of panicking on an out-of-range clock.
///
/// The day-granular epoch is ADR-0175 D4's recorded deviation from EG2-7's
/// "rolling-24h" prose: the EG1-frozen `trust_favorable_battle_day_epoch` column
/// is a `u32` and cannot hold a rolling millisecond timestamp.
///
/// kills: (a) a seconds- or minutes-based divisor (86_399_999 would no longer
/// share day 0 with 0, so the once-per-day cap would fire many times per day);
/// (b) an off-by-one boundary — 86_400_000 ms is the FIRST millisecond of day 1,
/// not the last of day 0; (c) an `as u32` cast or a bare `unwrap()` on the
/// conversion, which would wrap or PANIC the whole write-back on an absurd clock
/// value instead of saturating to a day epoch no future day can exceed (a bounded
/// credit lockout — never a double credit).
#[test]
fn day_epoch_utc_maps_ms_to_day() {
    assert_eq!(super::day_epoch_utc(0), 0, "EG2-7/D4: epoch 0 ms is day 0.");
    assert_eq!(
        super::day_epoch_utc(86_399_999),
        0,
        "EG2-7/D4: the last millisecond of the first UTC day is still day 0. \
         TEETH: kills a divisor that is not 86_400_000 ms — with a seconds or \
         minutes divisor this lands in a different bucket from 0 and the \
         once-per-day Trust cap fires repeatedly within one day."
    );
    assert_eq!(
        super::day_epoch_utc(86_400_000),
        1,
        "EG2-7/D4: the first millisecond of the second UTC day is day 1. \
         TEETH: kills an off-by-one boundary (`>=` vs `>` inside the division, or a \
         `- 1` correction) that would merge two calendar days into one epoch."
    );
    assert_eq!(
        super::day_epoch_utc(172_800_000),
        2,
        "EG2-7/D4: two whole days of milliseconds is day 2 — a second scale point so \
         a constant-returning implementation cannot pass."
    );
    // Saturation, not panic. `i64::MAX / 86_400_000` is ~1.07e11, far beyond u32.
    assert_eq!(
        super::day_epoch_utc(i64::MAX),
        u32::MAX,
        "EG2-7/D4: an absurd forward clock must SATURATE to u32::MAX, not wrap and \
         not panic. `i64::MAX / 86_400_000` is about 1.07e11, well past u32::MAX; \
         an `as u32` cast wraps to an arbitrary small day (re-enabling repeat \
         credits) and a bare `unwrap()` panics the entire battle write-back. \
         TEETH: this assertion is the one that distinguishes \
         `u32::try_from(..).unwrap_or(u32::MAX)` from both."
    );
    // A backwards clock is representable (`now_ms` is server-injected, ADR-0003).
    assert_eq!(
        super::day_epoch_utc(-1),
        0,
        "EG2-7/D4: -1 ms truncates toward zero, so it is still day 0 — no panic."
    );
    assert_eq!(
        super::day_epoch_utc(-86_400_000),
        u32::MAX,
        "EG2-7/D4: a negative day index has no u32 representation and must saturate \
         to u32::MAX — the MAXIMUM epoch, so `day > stored` is false and a rewound \
         clock produces a bounded lockout rather than a credit. TEETH: kills an \
         `unwrap_or(0)` default, which would make every monster instantly \
         re-creditable after a clock rewind (and kills `unwrap()`, which panics)."
    );
}

/// **EG2-7 (pure)** — `is_wild_battle` is TRUE for wild battles and for nothing
/// else: it is the single predicate that exempts BOTH practice and PvP.
///
/// kills:
///   * an `opponent_identity != player_identity` formulation (practice would be
///     correctly false, but a PvP battle — a genuine third identity — would read
///     as WILD and two colluding accounts could farm essence + Trust through
///     repeated `challenge_pvp` rematches, the exact collusion vector EG2-7's PvP
///     exemption exists to close, and there is no rematch cooldown in `pvp.rs`);
///   * an always-true impl (the practice and PvP cases below fail);
///   * an always-false impl (the wild cases fail);
///   * copying `is_ongoing_wild_battle`'s shape, which ALSO requires
///     `outcome == Ongoing` and takes a player argument. That predicate is right
///     for disconnect GC and WRONG here: the faint penalty must credit on ANY
///     wild outcome — a loss, a flee, and the disconnect write-back path — so the
///     terminal-outcome rows below must still read as wild.
#[test]
fn is_wild_battle_true_only_for_wild_identity() {
    let p = spacetimedb::Identity::from_byte_array([7u8; 32]);
    let q = spacetimedb::Identity::from_byte_array([8u8; 32]);
    let wild = crate::WILD_IDENTITY;

    let wild_row = battle_fixture(20, p, wild, game_core::BattleOutcome::Ongoing);
    assert!(
        super::is_wild_battle(&wild_row),
        "EG2-7: a battle whose opponent is WILD_IDENTITY IS a wild battle. \
         TEETH: kills an always-false impl."
    );

    // Practice = the self-vs-self sandbox (ADR-0078): player == opponent.
    let practice_row = battle_fixture(21, p, p, game_core::BattleOutcome::Ongoing);
    assert!(
        !super::is_wild_battle(&practice_row),
        "EG2-7: a PRACTICE battle (player_identity == opponent_identity) must NOT be \
         wild — practice is exempt from essence, Trust and Quality-Time credit, \
         mirroring the existing practice-XP exemption."
    );

    // PvP = a genuine third identity.
    let pvp_row = battle_fixture(22, p, q, game_core::BattleOutcome::Ongoing);
    assert!(
        !super::is_wild_battle(&pvp_row),
        "EG2-7: a PvP battle (opponent is another player's identity) must NOT be \
         wild. TEETH: this is the assertion an `opponent != player` implementation \
         fails — that spelling exempts practice but hands two colluding accounts \
         unlimited essence and Trust through repeated PvP rematches (no rematch \
         cooldown exists in pvp.rs)."
    );

    // Outcome-independence: the faint penalty credits on ANY wild outcome.
    for outcome in [
        game_core::BattleOutcome::SideAWins,
        game_core::BattleOutcome::SideBWins,
        game_core::BattleOutcome::Fled,
    ] {
        let terminal = battle_fixture(23, p, wild, outcome);
        assert!(
            super::is_wild_battle(&terminal),
            "EG2-7: a TERMINAL wild battle is still a wild battle. \
             TEETH: kills an implementation copied from `is_ongoing_wild_battle`, \
             which also demands `outcome == Ongoing`. The faint penalty must apply \
             on a loss, on a flee, and on the disconnect write-back path — all of \
             which reach this function with a non-Ongoing outcome."
        );
    }

    // Owner-independence: unlike `is_ongoing_wild_battle`, there is no player arg.
    let other_owner = battle_fixture(24, q, wild, game_core::BattleOutcome::Ongoing);
    assert!(
        super::is_wild_battle(&other_owner),
        "EG2-7: wildness is a property of the ROW, not of who is asking — the \
         predicate takes no player argument. TEETH: documents the deliberate \
         difference from `is_ongoing_wild_battle`."
    );
}

// ---------------------------------------------------------------------------
// Scanning helpers for the EG2 body pins
//
// All of them operate on the FULLY stripped view (comments AND string literals
// blanked) produced by `fn_body`, which is pure ASCII — so every byte index is a
// char boundary and the windowing below cannot split a character.
// ---------------------------------------------------------------------------

/// The fully-stripped body of the battle write-back, the subject of every EG2
/// scan below. Panics loudly if the function is missing, so no scan can pass
/// vacuously against a renamed or deleted target.
fn write_back_body() -> String {
    let name = ["write_back", "_battle", "_results"].concat();
    fn_body(name.as_str())
}

/// `src` with ALL whitespace removed, so a rustfmt line split can never turn a
/// correct implementation red. Used only where adjacency is the property under
/// test (the day-cap comparator).
fn squash_ws(src: &str) -> String {
    src.split_whitespace().collect()
}

/// The interior of the balanced parenthesis group that OPENS at or after `from`.
///
/// Used to read a call's ARGUMENT LIST rather than an arbitrary character window,
/// so the affinity/amount pins below say something exact about the call instead of
/// "these tokens appear near each other".
fn paren_group(src: &str, from: usize) -> Option<&str> {
    let bytes = src.as_bytes();
    let open = from + src[from..].find('(')?;
    let mut depth: usize = 0;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&src[open + 1..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The header of the brace block whose `{` sits at `open`: the text back to the
/// previous `;`, `{` or `}`.
///
/// An EXACT header, not a fixed-width window. A window bleeds neighbouring
/// statements in, which is a false-GREEN generator for every gate assertion below
/// — most concretely, it could bleed the `SideAWins` condition (or an earlier
/// `is_wild_battle` gate) into an inner block's header and make an ungated credit
/// look gated. Stopping at the previous statement/block delimiter yields the whole
/// condition and nothing else.
fn block_header(body: &str, open: usize) -> &str {
    let bytes = body.as_bytes();
    let mut start = open;
    while start > 0 {
        let b = bytes[start - 1];
        if b == b';' || b == b'{' || b == b'}' {
            break;
        }
        start -= 1;
    }
    &body[start..open]
}

/// `(open_index, header)` for every brace block that ENCLOSES byte `at` in
/// `body`, outermost first.
///
/// Walks the brace stack from the start of the body to `at`; whatever is still
/// open at `at` is an enclosing block, and its header is the condition / loop
/// header that decides whether the block runs. This is how "the write is INSIDE
/// the gate" is expressed without pinning one exact spelling of the gate.
fn enclosing_block_headers(body: &str, at: usize) -> Vec<(usize, &str)> {
    let bytes = body.as_bytes();
    let mut stack: Vec<usize> = Vec::new();
    let mut i = 0usize;
    while i < at && i < bytes.len() {
        match bytes[i] {
            b'{' => stack.push(i),
            b'}' => {
                stack.pop();
            }
            _ => {}
        }
        i += 1;
    }
    let mut out: Vec<(usize, &str)> = Vec::new();
    for &open in &stack {
        out.push((open, block_header(body, open)));
    }
    out
}

/// Is byte `at` inside a brace block that OPENS at or after `min_open` and whose
/// header names a `wild` decision?
///
/// `min_open` is what makes a win-credit check INDEPENDENT of the faint loop's
/// own gate: passing the `SideAWins` anchor rejects every block that opened
/// earlier, so a shell that nests the whole win block inside the faint loop's
/// `is_wild_battle` gate does NOT count as gating the win credits (and that shell
/// would be wrong anyway — it would also strip XP and currency from practice and
/// PvP winners).
///
/// `battle_wild` is scrubbed first, so the pre-existing `battle_wild` GC
/// statement can never satisfy the token match.
///
/// Accepts every reasonable spelling of the gate — `if is_wild_battle(battle) {`,
/// `if wild_win {`, `if is_wild {` — because it matches the token in the header
/// that actually guards the block, not one exact line.
fn wild_gated_at(body: &str, at: usize, min_open: usize) -> bool {
    enclosing_block_headers(body, at)
        .iter()
        .any(|(open, h)| *open >= min_open && h.replace("battle_wild", "").contains("wild"))
}

/// For every occurrence of `field` in `src`, the two bytes immediately BEFORE the
/// start of its dotted path and the two bytes immediately AFTER the field name.
///
/// `src` must be whitespace-squashed, where an operator is always physically
/// adjacent to its operand — which is exactly what makes `>` distinguishable from
/// `>=`, `==` and `!=` by two bytes of context.
fn field_adjacency(src: &str, field: &str) -> Vec<(String, String)> {
    let bytes = src.as_bytes();
    let mut out: Vec<(String, String)> = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = src[from..].find(field) {
        let at = from + rel;
        // Walk back over the dotted path (`m.trust_..` -> the `m`).
        let mut path_start = at;
        while path_start > 0 {
            let b = bytes[path_start - 1];
            if b.is_ascii_alphanumeric() || b == b'_' || b == b'.' {
                path_start -= 1;
            } else {
                break;
            }
        }
        let before = src[path_start.saturating_sub(2)..path_start].to_string();
        let end = at + field.len();
        let after = src[end..(end + 2).min(src.len())].to_string();
        out.push((before, after));
        from = end;
    }
    out
}

/// **EG2-7 (scan)** — the faint-penalty loop must sit textually BEFORE the
/// `SideAWins` block.
///
/// kills: the placement bug. `write_back_battle_results`'s win block early-RETURNS
/// twice on corrupt loser data (`xp_skip_loser_species`, `xp_skip_loser_level`),
/// and it only runs at all on `SideAWins`. A faint loop written INSIDE it, or
/// after it, therefore silently drops the `trust_unfavorable_count` penalty for
/// every wild LOSS, every FLEE, the whole disconnect write-back path, and — even
/// on a win — for any battle whose loser row is corrupt. Trust would then only
/// ever move up, and the Bayesian smoothing would drift permanently favourable.
///
/// The comparison is against the FIRST `SideAWins` occurrence in the body, which
/// is the conservative choice: if a later refactor introduces a second one, the
/// penalty still has to precede the first.
///
/// RED BY SCAN at HEAD: `trust_unfavorable_count` does not appear in `battle.rs`.
#[test]
fn faint_loop_precedes_side_a_wins_block() {
    let body = write_back_body();

    let unfavorable = ["trust_unfavorable", "_count"].concat();
    let win_outcome = ["SideA", "Wins"].concat();

    let unfav_at = body.find(unfavorable.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7): `write_back_battle_results` must write \
             `trust_unfavorable_count` — the per-fainted-party-member Trust penalty \
             on a WILD battle. RED at HEAD: the field is never written in battle.rs. \
             It must be a saturating +1 per fainted member of side A's team, with the \
             usual dual-write (copy-forward tier, fail loud on a missing monster_pub \
             row), in its own loop placed BEFORE the SideAWins block."
        )
    });
    let win_at = body.find(win_outcome.as_str()).unwrap_or_else(|| {
        panic!(
            "SCAN PRECONDITION (EG2-7): the SideAWins outcome comparison vanished from \
             `write_back_battle_results` — the ordering assertion below has no anchor \
             and every EG2 win-credit scan in this file is untrustworthy. Re-derive \
             the anchor deliberately."
        )
    });

    assert!(
        unfav_at < win_at,
        "TEETH (EG2-7): the faint penalty is written at body byte {unfav_at}, but the \
         SideAWins block opens at byte {win_at} — the penalty must come FIRST. \
         WHY: that block runs ONLY on a win, and it early-RETURNS on a missing loser \
         species row and on a corrupt loser level. A faint loop placed inside or after \
         it credits nothing on a wild LOSS, nothing on a FLEE, nothing on the \
         disconnect write-back path, and nothing at all when the loser row is corrupt \
         — so `trust_unfavorable_count` would stay 0 forever while the favourable \
         counter keeps climbing, permanently skewing every Trust gate upward. \
         ADR-0175 D4 places the loop in its own pass before the win block for exactly \
         this reason. \
         HONEST LIMIT: this proves textual ORDER in the source, not execution order \
         under every control-flow shape; the two coincide here because there is no \
         early return above the win block."
    );
}

/// **EG2-7 (scan)** — the faint penalty is WILD-gated: practice and PvP faints
/// credit nothing.
///
/// kills: an ungated faint loop. Without the gate, a player could farm Trust
/// DOWNWARD on demand in a practice sandbox, and — worse in the other direction —
/// two colluding PvP accounts control both sides of every faint. EG2-7 requires
/// all three credits to be practice- AND PvP-exempt; this is the faint third.
///
/// Three layers:
///   1. the wild predicate is called at all inside this body;
///   2. it is called BEFORE the penalty write. Given
///      [`faint_loop_precedes_side_a_wins_block`], this is stronger than it looks:
///      a gate that exists only inside the winner loop necessarily appears AFTER
///      the faint write, so "gated the win credits, forgot the faint loop" fails
///      here;
///   3. some brace block ENCLOSING the penalty write is headed by a wild
///      decision — which is what makes layer 2 non-satisfiable by a hoisted
///      `let is_wild = ..;` that nothing ever branches on. The header check
///      accepts any spelling (`if is_wild_battle(battle) {`, `if is_wild {`,
///      `if wild {`) because it looks for the token, not one exact line, and
///      `battle_wild` is scrubbed out of the header first so the existing
///      `battle_wild` GC statement can never satisfy it.
///
/// RED BY SCAN at HEAD: neither the predicate nor the field exists in `battle.rs`.
///
/// HONEST LIMITS. (a) A scan cannot prove the gate's VALUE is what the branch
/// tests — layer 3 proves an enclosing block is headed by a wild decision, not
/// that the decision is not inverted. The pure test
/// [`is_wild_battle_true_only_for_wild_identity`] owns the predicate's meaning.
/// (b) Gating with `is_ongoing_wild_battle` instead would satisfy layer 3's token
/// check while wrongly re-adding an outcome condition; layer 1's exact-name pin is
/// what makes that shape visible.
#[test]
fn faint_loop_is_wild_gated() {
    let body = write_back_body();

    let wild_call = ["is_wild", "_battle("].concat();
    let unfavorable = ["trust_unfavorable", "_count"].concat();

    // --- Layer 1: the wild predicate is used here at all ---------------------
    let wild_at = body.find(wild_call.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7, layer 1): `write_back_battle_results` must call \
             `is_wild_battle(` — the ONE predicate that exempts practice \
             (player == opponent) and PvP (a third identity) from every EG2 credit. \
             RED at HEAD: the predicate does not exist in battle.rs."
        )
    });
    let unfav_at = body.find(unfavorable.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7, layer 1): the `trust_unfavorable_count` penalty write is \
             missing entirely — see faint_loop_precedes_side_a_wins_block."
        )
    });

    // --- Layer 2: the gate is established before the penalty write -----------
    assert!(
        wild_at < unfav_at,
        "TEETH (EG2-7, layer 2): the first `is_wild_battle(` call is at body byte \
         {wild_at}, AFTER the faint penalty write at {unfav_at}. Combined with the \
         mandated placement of the faint loop before the SideAWins block, this is the \
         signature of the half-applied fix: the WIN credits were wild-gated and the \
         faint loop was left ungated, so practice and PvP faints still push \
         `trust_unfavorable_count` up. EG2-7 exempts all three credits, not two."
    );

    // --- Layer 3: the penalty write lives INSIDE a wild-gated block ----------
    assert!(
        wild_gated_at(&body, unfav_at, 0),
        "TEETH (EG2-7, layer 3): no brace block enclosing the \
         `trust_unfavorable_count` write is headed by a wild decision. Layer 2 only \
         proves the predicate is CALLED somewhere earlier; a hoisted \
         `let is_wild = is_wild_battle(battle);` that no branch ever consumes \
         satisfies it while every practice and PvP faint still credits. The penalty \
         loop must sit inside the gate — `if is_wild_battle(battle) {{ .. }}` or \
         `if is_wild {{ .. }}` — with the loop and its dual-write inside. \
         (`battle_wild` is scrubbed from each header first, so the existing \
         `battle_wild` GC statement cannot satisfy this.) \
         HONEST LIMIT: a source scan sees the SHAPE of the gate, never that the \
         condition is un-inverted; `is_wild_battle_true_only_for_wild_identity` owns \
         the predicate's meaning."
    );
}

/// **EG2-7 (scan)** — the faint penalty increments SATURATINGLY.
///
/// kills: `m.trust_unfavorable_count += 1`. The workspace ships
/// `overflow-checks = true`, so a plain `+= 1` on a `u32` at `u32::MAX` PANICS —
/// and it panics inside the battle write-back, which every battle-ending path
/// funnels through, including the disconnect resolver. A panicking write-back
/// aborts the whole transaction: the battle never resolves and the player is
/// soft-locked out of every future battle by the lingering `Ongoing` row. Reaching
/// `u32::MAX` faints is not a realistic play pattern, but "unreachable therefore
/// unguarded" is exactly the reasoning this codebase's saturating discipline
/// rejects everywhere else, and the raising-side sibling pins the identical
/// property for `trust_favorable_count`.
///
/// The needle is scoped to the STATEMENT that first mentions the column (via the
/// existing depth-aware `statement_end`), not to the whole body — a
/// `saturating_add` somewhere else in the function cannot satisfy it.
///
/// RED BY SCAN at HEAD: the column is never written.
#[test]
fn faint_penalty_uses_a_saturating_increment() {
    let body = write_back_body();
    let unfavorable = ["trust_unfavorable", "_count"].concat();
    let saturating = [".saturating_add(", "1"].concat();

    let unfav_at = body.find(unfavorable.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7): the `trust_unfavorable_count` penalty write is missing \
             entirely — see faint_loop_precedes_side_a_wins_block."
        )
    });
    let stmt = &body[unfav_at..statement_end(&body, unfav_at)];
    assert!(
        stmt.contains(saturating.as_str()),
        "TEETH (EG2-7): the statement writing `trust_unfavorable_count` is \
         `{stmt}` — it must increment with `.saturating_add(1)`. A plain `+= 1` \
         panics at `u32::MAX` under this workspace's `overflow-checks = true`, and it \
         panics INSIDE the battle write-back that every battle-ending path (including \
         the disconnect resolver) funnels through — aborting the transaction, leaving \
         the battle row `Ongoing`, and soft-locking the player out of every future \
         battle."
    );
}

/// **EG2-7 (scan)** — the two NEW win credits must be computed INDEPENDENT of the
/// winner-level parse (the RT-WB-CURRENCY-01 discipline, applied to essence and
/// Trust).
///
/// kills: the exact regression this function already suffered once for currency.
/// At HEAD the winner loop parses `Level::new(bm.level)` and `continue`s on error —
/// so a single corrupt level byte on ONE monster skips everything below it for
/// that monster. If essence and the Trust-favorable credit are written after that
/// parse and behind that `continue`, a corrupt level silently costs the player
/// their essence and Trust as well, even though neither depends on the winner's
/// level at all. ADR-0175 D4 says it plainly: a corrupt winner level skips XP
/// ONLY. The same fix was already made for currency (grant it as soon as the
/// loser BST is known) — this is that decision applied to the new resources.
///
/// Both pins are scoped to the SideAWins region so a faint-loop write cannot
/// satisfy them.
///
/// RED BY SCAN at HEAD: neither the grant helper nor the day-epoch column appears.
///
/// HONEST LIMIT: textual ORDER is the pinned property, and it is the sanctioned
/// shape (ADR-0175 D4). An implementation that keeps the parse first but genuinely
/// removes the `continue` — writing the credits afterwards on both paths — is also
/// correct and would false-RED here. When that happens, re-argue against D4 and
/// move the credits above the parse rather than weakening this test.
#[test]
fn win_credits_not_gated_behind_winner_level_parse() {
    let body = write_back_body();
    let win_outcome = ["SideA", "Wins"].concat();
    let win_at = body
        .find(win_outcome.as_str())
        .expect("SCAN PRECONDITION (EG2-7): the SideAWins block anchor is missing");
    let win_region = &body[win_at..];

    let level_parse = ["Level::new(", "bm.level)"].concat();
    let grant = ["grant", "_essence("].concat();
    let day_epoch_field = ["trust_favorable_battle", "_day_epoch"].concat();

    let parse_at = win_region.find(level_parse.as_str()).unwrap_or_else(|| {
        panic!(
            "SCAN PRECONDITION (EG2-7): `Level::new(bm.level)` — the per-winner level \
             parse — is no longer in the SideAWins region, so the ordering assertions \
             below have no anchor. If the parse was legitimately restructured, \
             re-derive this anchor DELIBERATELY."
        )
    });
    let grant_at = win_region.find(grant.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7): the winner loop must call the essence grant helper on a \
             wild win. RED at HEAD: no essence is granted anywhere in battle.rs."
        )
    });
    let day_at = win_region.find(day_epoch_field.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7): the winner loop must read and write \
             `trust_favorable_battle_day_epoch` — the once-per-day cap on the \
             Trust-favorable battle credit. RED at HEAD: the column is never touched."
        )
    });

    assert!(
        grant_at < parse_at,
        "TEETH (EG2-7 / RT-WB-CURRENCY-01): the essence grant is at region byte \
         {grant_at}, BELOW the winner-level parse at {parse_at}. A corrupt \
         `bm.level` makes that parse fail and skip the rest of the iteration, so the \
         player loses essence they earned by winning — even though essence is typed \
         and sized entirely by the DEFEATED species and does not use the winner's \
         level at all. This is the identical defect already fixed once in this \
         function for currency; ADR-0175 D4 requires a corrupt winner level to skip \
         XP ONLY. Compute the essence grant BEFORE the parse."
    );
    assert!(
        day_at < parse_at,
        "TEETH (EG2-7 / RT-WB-CURRENCY-01): the Trust-favorable day-cap read/write is \
         at region byte {day_at}, BELOW the winner-level parse at {parse_at}. Same \
         defect as the essence grant above: the Trust credit does not depend on the \
         winner's level, so a corrupt level byte must not consume it. Compute the \
         Trust credit BEFORE the parse."
    );
}

/// **EG2-12 (scan)** — the Quality-Time accrual and the auto-evolution check are
/// TAILS: they run after the winner's own dual-write, in that order.
///
/// kills:
///   * running either tail BEFORE the monster row is written. Both re-FIND the
///     monster fresh from the DB (ADR-0175 D3's fresh-find semantics), so a tail
///     placed above the `update` reads the PRE-battle row: the auto-evolution check
///     evaluates gates against stale essence/level and refuses an evolution the
///     player just earned, or the accrual's own write is immediately overwritten by
///     the winner update that follows it, silently discarding the tick.
///   * inverting the two — EG2-12 says the evolution check is the LAST step, after
///     every gate-relevant mutation this reducer performs, and Quality Time is
///     itself one of the five gate factors. Checking first and accruing after can
///     leave a monster eligible-but-unevolved until some unrelated later action.
///
/// Scoped to the SideAWins region, so the faint loop's own dual-write (which is
/// textually earlier and deliberately carries no tails) cannot be mistaken for the
/// winner's.
///
/// RED BY SCAN at HEAD: neither helper exists in `battle.rs`.
#[test]
fn winner_tails_after_dual_write() {
    let body = write_back_body();
    let win_outcome = ["SideA", "Wins"].concat();
    let win_at = body
        .find(win_outcome.as_str())
        .expect("SCAN PRECONDITION (EG2-12): the SideAWins block anchor is missing");
    let win_region = &body[win_at..];

    let pub_update = ["monster_pub()", ".monster_id().update("].concat();
    let accrue = ["accrue_quality", "_time("].concat();
    let evolve_check = ["check_and", "_evolve("].concat();

    let update_at = win_region.find(pub_update.as_str()).unwrap_or_else(|| {
        panic!(
            "SCAN PRECONDITION (EG2-12): the winner loop's public dual-write \
             (`monster_pub().monster_id().update(`) is missing from the SideAWins \
             region — the tail-ordering assertions have no anchor."
        )
    });
    let accrue_at = win_region.find(accrue.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-8/EG2-12): the winner loop must call the Quality-Time accrual \
             for each winning participant. RED at HEAD: `write_back_battle_results` \
             is one of the mandated call sites and calls it nowhere."
        )
    });
    let check_at = win_region.find(evolve_check.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-12): the winner loop must call the auto-evolution check as its \
             LAST step. RED at HEAD: `write_back_battle_results` is the one call site \
             covering essence, Trust AND level together, and calls it nowhere."
        )
    });

    assert!(
        update_at < accrue_at,
        "TEETH (EG2-12): the Quality-Time accrual is at region byte {accrue_at}, \
         BEFORE the winner's dual-write at {update_at}. Both tails re-find the \
         monster row fresh, so running them first means they read the pre-write row \
         — and worse, the accrual's own write is then clobbered by the winner update \
         that follows, silently discarding the credited time. The tails belong after \
         each winner's own `monster` + `monster_pub` update."
    );
    assert!(
        accrue_at < check_at,
        "TEETH (EG2-12): the auto-evolution check (region byte {check_at}) must run \
         AFTER the Quality-Time accrual (byte {accrue_at}), not before. EG2-12 makes \
         the check the LAST step after every gate-relevant mutation, and Quality Time \
         is itself one of the five gate factors — checking first can leave a monster \
         that just crossed its Quality-Time tier un-evolved until some unrelated \
         later action, contradicting EG2-1's 'evolves the instant it becomes \
         eligible'."
    );
}

/// **EG2-7 (scan)** — essence is typed by the DEFEATED species' Affinity and sized
/// by the shared reward helper.
///
/// kills:
///   * typing the essence by the WINNER's affinity. That inverts the entire
///     strategy EG2-7 is built on ("go fight the type you need"): a Fire monster
///     grinding Water opponents would bank Fire essence it already has, and the
///     Water-gated edges would be unreachable by design. The winner's species row
///     is bound as `species` in this very loop, so `species.affinity` is one
///     plausible slip away — and the positive needle here (`loser`) is exactly
///     what that slip does not contain.
///   * a hardcoded `Affinity::` variant (which would make every wild win award the
///     same element).
///   * inlining the reward arithmetic instead of calling `essence_battle_reward`,
///     which is where the `max(1, bst/30)` rule and its unit tests live.
///
/// The assertions read the call's ARGUMENT LIST via balanced-paren matching, not a
/// character window, so they say something exact about this call.
///
/// RED BY SCAN at HEAD: the grant helper does not exist.
///
/// HONEST LIMIT: `loser` is matched as a token inside the argument list rather
/// than the exact spelling `loser_species.affinity`, so a hoisted
/// `let loser_affinity = loser_species.affinity;` also passes. That is deliberate
/// — the property is provenance (the defeated side), and pinning one variable
/// name would false-RED an equivalent refactor.
#[test]
fn essence_uses_defeated_species_affinity() {
    let body = write_back_body();
    let win_outcome = ["SideA", "Wins"].concat();
    let win_at = body
        .find(win_outcome.as_str())
        .expect("SCAN PRECONDITION (EG2-7): the SideAWins block anchor is missing");
    let win_region = &body[win_at..];

    let grant = ["grant", "_essence("].concat();
    let grant_at = win_region.find(grant.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7): the winner loop must call the essence grant helper. \
             RED at HEAD: no essence is granted anywhere in battle.rs."
        )
    });
    let args = paren_group(win_region, grant_at).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7): the essence grant call has no balanced argument list — \
             the scan cannot read what affinity or amount is being granted."
        )
    });

    let affinity_token = ["affin", "ity"].concat();
    assert!(
        args.contains(affinity_token.as_str()),
        "TEETH (EG2-7): the essence grant's arguments are `{args}` — no `affinity` \
         expression among them. A hardcoded `Affinity::Fire`-style variant (which \
         does NOT contain the lowercase field name) would make every wild win award \
         the same element regardless of what was defeated, and every non-Fire \
         evolution edge unreachable through battle."
    );
    assert!(
        args.contains("loser"),
        "TEETH (EG2-7): the essence grant's arguments are `{args}` — nothing there \
         comes from the LOSER. EG2-7 types essence by the DEFEATED species' Affinity \
         ('go fight the type you need'), not the winner's. The winner's own species \
         row is bound as `species` in this same loop, so `species.affinity` is one \
         slip away and is precisely what this assertion catches: a Fire monster \
         farming Water opponents would bank Fire essence and could never reach a \
         Water-gated edge."
    );
    let reward_helper = ["essence_battle", "_reward("].concat();
    assert!(
        args.contains(reward_helper.as_str()),
        "TEETH (EG2-7): the essence grant's arguments are `{args}` — the amount is \
         not computed by `essence_battle_reward(`. That helper is where the \
         `max(1, bst / 30)` rule lives and where its floor/scale unit tests bite; an \
         inlined division here can silently drift from both (most plausibly back to \
         currency's 3x-shallower `/ 10`)."
    );
}

/// **EG2-7 (scan)** — the once-per-day Trust cap compares with STRICT GREATER-THAN.
///
/// kills:
///   * `>=` — every wild win on the same day would re-credit, turning a
///     once-per-day cap into no cap at all and letting one grinding session climb
///     the whole Trust ladder;
///   * `!=` — the spelling a "day changed?" reading naturally produces. It is
///     wrong in one specific direction that matters: a server clock rewind makes
///     `day(now) != stored` true again, so every monster becomes instantly
///     re-creditable, and repeated rewinds are a double-credit engine. With `>` a
///     rewind is a bounded (<= 24 h) lockout instead — ADR-0175 D4 accepts that
///     trade explicitly;
///   * dropping the helper: `day_epoch_utc(` must actually be called, so the
///     comparison is against a real UTC-day index and not raw milliseconds
///     (a `u32` column cannot hold a rolling ms timestamp — the reason for the
///     day-granularity deviation from EG2-7's 'rolling-24h' prose).
///
/// Runs on the whitespace-squashed body, where an operator is always physically
/// adjacent to its operand, so `>` is distinguishable from `>=` / `==` / `!=` by
/// two bytes of context. Both orientations are accepted (`day > stored` and
/// `stored < day`).
///
/// RED BY SCAN at HEAD: neither the helper nor the column appears in `battle.rs`.
///
/// HONEST LIMIT: the comparison must be written against the column directly, which
/// is the sanctioned shape. Hoisting it into a local first
/// (`let stored = m.trust_favorable_battle_day_epoch; if today > stored`) removes
/// the adjacency this test reads and would false-RED; keep the comparison on the
/// field.
#[test]
fn day_cap_comparator_is_strictly_greater() {
    let body = write_back_body();
    let squashed = squash_ws(&body);

    let helper = ["day_epoch", "_utc("].concat();
    assert!(
        squashed.contains(helper.as_str()),
        "TEETH (EG2-7): `write_back_battle_results` must call `day_epoch_utc(` to \
         derive the UTC-day index it compares against \
         `trust_favorable_battle_day_epoch`. RED at HEAD: the helper does not exist. \
         Comparing raw milliseconds is not an option — the EG1-frozen column is a \
         `u32`, which is why ADR-0175 D4 records day granularity as a deliberate \
         deviation from EG2-7's 'rolling-24h' prose."
    );

    let field = ["trust_favorable_battle", "_day_epoch"].concat();
    let adjacency = field_adjacency(&squashed, field.as_str());
    assert!(
        !adjacency.is_empty(),
        "TEETH (EG2-7): `trust_favorable_battle_day_epoch` is never touched in \
         `write_back_battle_results`, so the Trust-favorable battle credit has no \
         once-per-day cap at all — every wild win would credit Trust, and a grinding \
         session would saturate the Trust ladder in minutes."
    );

    let strictly_greater = adjacency.iter().any(|(before, after)| {
        let prev = before.chars().last();
        let prev2 = before.chars().rev().nth(1);
        let gt_before =
            prev == Some('>') && !matches!(prev2, Some('-') | Some('=') | Some('<') | Some('>'));
        let next = after.chars().next();
        let next2 = after.chars().nth(1);
        let lt_after = next == Some('<') && next2 != Some('=');
        gt_before || lt_after
    });
    assert!(
        strictly_greater,
        "TEETH (EG2-7 / ADR-0175 D4): no STRICT `>` comparison against \
         `trust_favorable_battle_day_epoch` was found (adjacency contexts seen: \
         {adjacency:?}). The credit must fire iff `day_epoch_utc(now) > \
         m.trust_favorable_battle_day_epoch` (or the equivalent \
         `m.trust_favorable_battle_day_epoch < day`). A `>=` re-credits on every win \
         within the same day — no cap at all. \
         HONEST LIMIT: the comparison must name the field directly; hoisting it into \
         a local first removes the adjacency this assertion reads."
    );

    let uses_inequality = adjacency
        .iter()
        .any(|(before, after)| before.ends_with("!=") || after.starts_with("!="));
    assert!(
        !uses_inequality,
        "TEETH (EG2-7 / ADR-0175 D4): `trust_favorable_battle_day_epoch` is compared \
         with `!=` (adjacency contexts: {adjacency:?}). 'The day changed' is the \
         natural reading and it is wrong in the one direction that matters: a server \
         clock REWIND makes `day(now) != stored` true again, so every monster is \
         instantly re-creditable and each rewind mints another day's Trust. `>` turns \
         the same event into a bounded (<= 24 h) lockout, which ADR-0175 D4 accepts \
         explicitly as the safer failure direction."
    );

    let uses_equality = adjacency
        .iter()
        .any(|(before, after)| before.ends_with("==") || after.starts_with("=="));
    assert!(
        !uses_equality,
        "TEETH (EG2-7): `trust_favorable_battle_day_epoch` is compared with `==` \
         (adjacency contexts: {adjacency:?}), which would credit ONLY on a day whose \
         index already equals the stored one — the cap inverted into a permanent \
         lock (or, with a 0 default, a same-day-only credit). The comparator is `>`."
    );
}

// ---------------------------------------------------------------------------
// ONE body shape that satisfies EVERY scan in this section simultaneously.
//
// Written out because these tests are not editable by the implementer, so joint
// satisfiability has to be demonstrated, not asserted. This is a SKETCH of
// `write_back_battle_results` (the `fn` keyword is deliberately omitted from the
// signature line so nothing that extracts function bodies from a concatenation of
// this crate's sources can mistake the sketch for a second definition):
//
//   write_back_battle_results(ctx, battle) -> Result<(), String> {
//       check_team_coupling(..)?;  write_back_party_hp(ctx, battle)?;
//       ctx.db.battle_wild().battle_id().delete(battle.battle_id);
//       ..the two terminal-battle GC blocks, unchanged..
//
//       // EG2-7 faint penalties: WILD only, ANY outcome, BEFORE the win block.
//       if is_wild_battle(battle) {                                  // [W1]
//           for (i, bm) in battle.state.side_a.team.iter().enumerate() {
//               if !bm.is_fainted() { continue; }
//               ..resolve mid, find the monster row, else continue..
//               m.trust_unfavorable_count =
//                   m.trust_unfavorable_count.saturating_add(1);      // [U]
//               ..copy-forward tier, fail loud on a missing pub row, dual-write..
//           }
//       }
//
//       if battle.state.outcome == BattleOutcome::SideAWins {         // [ANCHOR]
//           ..loser_species (log+return on miss), bst, grant_currency, loser_lvl..
//           let is_practice = battle.player_identity == battle.opponent_identity;
//           let wild_win = is_wild_battle(battle);
//           let today = day_epoch_utc(now_ms(ctx));
//           for (i, bm) in battle.state.side_a.team.iter().enumerate() {
//               if bm.is_fainted() { continue; }
//               ..resolve mid, find the monster row, else continue..
//
//               if wild_win {                                         // [W2]
//                   grant_essence(&mut m, loser_species.affinity,
//                                 essence_battle_reward(bst));        // [G]
//                   if today > m.trust_favorable_battle_day_epoch {    // [D1]
//                       m.trust_favorable_count =
//                           m.trust_favorable_count.saturating_add(1); // [F]
//                       m.trust_favorable_battle_day_epoch = today;    // [D2]
//                   }
//               }
//
//               if let Ok(winner_lvl) = game_core::Level::new(bm.level) {  // [P]
//                   ..battle_xp_reward, practice_xp_reward(base_xp, ..),
//                     apply_xp_gain, and on level-up the existing
//                     `if let Some(species)` + 'stat_recompute + level_up_healed_hp..
//               } else {
//                   log::error!(..xp_skip_level..);   // skips XP ONLY, no continue
//               }
//
//               ..copy-forward tier, fail loud on a missing pub row..
//               ctx.db.monster().monster_id().update(m);
//               ctx.db.monster_pub().monster_id().update(pub_row);     // [UP]
//
//               if wild_win {
//                   accrue_quality_time(ctx, mid);                     // [A]
//                   check_and_evolve(ctx, mid);                        // [C]
//               }
//           }
//       }
//       Ok(())
//   }
//
// Check against every assertion in this section (win_region = body from ANCHOR):
//   faint_loop_precedes_side_a_wins_block ....... [U] < [ANCHOR]              OK
//   faint_loop_is_wild_gated ..... [W1] < [U]; [U] enclosed by [W1]'s block   OK
//   faint_penalty_uses_a_saturating_increment ... [U]'s statement saturates   OK
//   win_credits_and_qt_are_wild_gated ... [G], [F], [A] all enclosed by [W2],
//        whose `{` opens after [ANCHOR] (so [W1] cannot stand in for it)      OK
//   trust_favorable_count_increments_inside_the_day_cap ... [F] saturates,
//        [F] enclosed by [D1]'s block, epoch mentioned twice ([D1] + [D2])    OK
//   win_credits_not_gated_behind_winner_level_parse ... [G] < [P], [D1] < [P] OK
//   winner_tails_after_dual_write ............... [UP] < [A] < [C]            OK
//   essence_uses_defeated_species_affinity ... [G]'s args carry `affinity`,
//        `loser` and `essence_battle_reward(`                                 OK
//   day_cap_comparator_is_strictly_greater ... `day_epoch_utc(` present, and
//        [D1] puts `>` adjacent to the column; no `!=` / `==` on it           OK
// And the pre-existing pins still hold: `level_up_healed_hp` stays below
// `if let Some(species) = `, `practice_xp_reward(base_xp,` survives, the body
// still names `WILD_IDENTITY` (opponent GC block) and still has `log::error!`,
// no `Level::new(bm.level)?`, and the `battle().battle_id().delete(` GC remains.
// ---------------------------------------------------------------------------

/// **EG2-7 (scan)** — ALL THREE win credits are WILD-gated, with a gate of their
/// own that opens inside the win block.
///
/// THE GAP THIS CLOSES (review finding, HIGH). Every other scan in this section
/// is satisfied by an implementation that grants essence, the Trust-favorable
/// credit and the winner's Quality Time to EVERY winner — practice and PvP
/// included. That reopens the exact collusion vector EG2-7's PvP exemption exists
/// to close: `pvp.rs` has no rematch cooldown, so two accounts can trade wins as
/// fast as they can click and mint essence + Trust for both sides. The practice
/// sandbox is worse still — it is a single account fighting itself.
///
/// kills:
///   * un-gated win credits (no enclosing block names a wild decision);
///   * a hoisted `let wild_win = is_wild_battle(battle);` that no branch consumes
///     — the value has to be the header of a block the credit sits inside;
///   * borrowing the FAINT loop's gate by nesting the whole `SideAWins` block
///     inside it. `min_open = win_at` rejects any block that opened before the
///     anchor, which is what makes this check independent of
///     [`faint_loop_is_wild_gated`]. (That shell is wrong for a second reason
///     anyway: it would strip XP and currency from practice and PvP winners.)
///   * gating essence but forgetting Quality Time (or vice versa) — all three
///     credits are asserted separately, because EG2-7 exempts all three and a
///     half-applied gate is the likeliest partial fix.
///
/// RED BY SCAN at HEAD: none of the three credits exists.
///
/// HONEST LIMITS. (a) A scan sees the gate's SHAPE, never that its condition is
/// un-inverted; [`is_wild_battle_true_only_for_wild_identity`] owns the
/// predicate's meaning. (b) The gate is matched by the token `wild` in the
/// enclosing block's header (with `battle_wild` scrubbed), so `if wild_win {`,
/// `if is_wild {` and `if is_wild_battle(battle) {` all pass while
/// `if !is_practice && !is_pvp {` does not — deliberately, since EG2-7 mandates
/// the ONE predicate. (c) A `if !wild_win { continue; }` early-exit at the top of
/// the winner loop would false-RED — and would also be wrong, since it would skip
/// XP for practice and PvP winners; the gate must wrap the credits only.
#[test]
fn win_credits_and_qt_are_wild_gated() {
    let body = write_back_body();
    let win_outcome = ["SideA", "Wins"].concat();
    let win_at = body
        .find(win_outcome.as_str())
        .expect("SCAN PRECONDITION (EG2-7): the SideAWins block anchor is missing");
    let win_region = &body[win_at..];

    let grant = ["grant", "_essence("].concat();
    let favorable = ["trust_favorable", "_count"].concat();
    let accrue = ["accrue_quality", "_time("].concat();

    let grant_rel = win_region.find(grant.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7): the winner loop grants no essence at all. RED at HEAD; \
             see the body sketch above this test for the sanctioned shape."
        )
    });
    assert!(
        wild_gated_at(&body, win_at + grant_rel, win_at),
        "TEETH (EG2-7, HIGH): the essence grant is not inside a wild-gated block \
         that opens within the `SideAWins` region. Without that gate every PRACTICE \
         and PvP winner banks essence: `pvp.rs` has no rematch cooldown, so two \
         colluding accounts trade wins and mint essence for both sides, and a single \
         account farms itself in the practice sandbox — the precise vector EG2-7's \
         'BOTH practice- AND PvP-exempted' clause exists to close. Wrap the credits \
         in `if wild_win {{ .. }}` (or `if is_wild_battle(battle) {{ .. }}`) INSIDE \
         the win block. Reusing the faint loop's gate by nesting the whole \
         `SideAWins` block inside it does NOT satisfy this, deliberately — that \
         shell would also strip XP and currency from practice and PvP winners."
    );

    let fav_rel = win_region.find(favorable.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7): `trust_favorable_count` is never incremented in the \
             winner loop, so a wild win grows no Trust at all. RED at HEAD. Writing \
             only `trust_favorable_battle_day_epoch` (the cap anchor) without the \
             counter passes every ordering scan while Trust stays frozen at 0 \
             forever and no Trust-gated evolution edge can ever open."
        )
    });
    assert!(
        wild_gated_at(&body, win_at + fav_rel, win_at),
        "TEETH (EG2-7, HIGH): the Trust-favorable increment is not inside a \
         wild-gated block that opens within the `SideAWins` region. Same collusion \
         vector as the essence grant above — EG2-7 exempts ALL THREE credits from \
         practice and PvP, and Trust is the one that feeds the `min_trust_tier` \
         evolution gates."
    );

    let accrue_rel = win_region.find(accrue.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7/EG2-12): the winner loop never accrues Quality Time. \
             RED at HEAD; see winner_tails_after_dual_write."
        )
    });
    assert!(
        wild_gated_at(&body, win_at + accrue_rel, win_at),
        "TEETH (EG2-7, HIGH): the winner-side Quality-Time accrual is not inside a \
         wild-gated block that opens within the `SideAWins` region. EG2-7 names \
         Quality Time explicitly as the THIRD credit that is practice- and \
         PvP-exempt: an ungated accrual lets two colluding accounts (or one \
         self-battling account) pump the Quality-Time tier — one of the five \
         evolution gate factors — with no wild encounter at all. Put the tails \
         inside the same wild gate, after the dual-write."
    );
}

/// **EG2-7 (scan)** — the Trust-favorable COUNTER is incremented, saturatingly,
/// INSIDE the once-per-day gate, and the day anchor is both read and written.
///
/// THE GAP THIS CLOSES (review finding, HIGH). The comparator test proves the cap
/// is spelled with `>`; nothing proved anything actually happens inside it. An
/// implementation that advances `trust_favorable_battle_day_epoch` and never
/// touches `trust_favorable_count` satisfies every ordering and comparator scan in
/// this section while Trust never grows from battle at all — silently disabling
/// every `min_trust_tier` evolution edge, with no error and no log line.
///
/// kills:
///   * the missing counter increment (layer 1);
///   * `+= 1` instead of `saturating_add` — the same overflow-panic hazard
///     [`faint_penalty_uses_a_saturating_increment`] documents, scoped here to the
///     statement that first names the column (layer 2);
///   * an increment placed OUTSIDE the day-gated block — i.e. a cap that is
///     computed and then ignored, crediting Trust on every wild win of the day and
///     letting a grinding session saturate the Trust ladder in minutes (layer 3);
///   * a cap that is read but never advanced (or advanced but never read): the
///     column must appear at least twice in the win region — once in the
///     comparison, once in the store. With a single mention the cap is decorative
///     and every win credits (layer 4).
///
/// RED BY SCAN at HEAD: neither column is touched.
///
/// HONEST LIMITS. (a) Layer 3 requires the day-gate's condition to NAME the column
/// (`if today > m.trust_favorable_battle_day_epoch {`), which is the same spelling
/// [`day_cap_comparator_is_strictly_greater`] already requires; hoisting the
/// stored value into a local first would false-RED both, consistently. (b) Layer 4
/// counts mentions, not distinct roles — two reads and no write would pass it, but
/// layer 3 plus the comparator test make that shape hard to write by accident, and
/// only an executing seam (which this crate does not have) could prove the store.
#[test]
fn trust_favorable_count_increments_inside_the_day_cap() {
    let body = write_back_body();
    let win_outcome = ["SideA", "Wins"].concat();
    let win_at = body
        .find(win_outcome.as_str())
        .expect("SCAN PRECONDITION (EG2-7): the SideAWins block anchor is missing");
    let win_region = &body[win_at..];

    let favorable = ["trust_favorable", "_count"].concat();
    let day_field = ["trust_favorable_battle", "_day_epoch"].concat();
    let saturating = [".saturating_add(", "1"].concat();

    // --- Layer 1: the counter is written at all ------------------------------
    let fav_rel = win_region.find(favorable.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-7, HIGH): `trust_favorable_count` is never incremented in \
             the winner loop. RED at HEAD. An implementation that only advances \
             `trust_favorable_battle_day_epoch` passes every other scan here while a \
             wild win grows NO Trust — every `min_trust_tier` evolution edge stays \
             shut forever, silently."
        )
    });

    // --- Layer 2: saturating, not `+= 1` -------------------------------------
    let stmt = &win_region[fav_rel..statement_end(win_region, fav_rel)];
    assert!(
        stmt.contains(saturating.as_str()),
        "TEETH (EG2-7): the statement writing `trust_favorable_count` is `{stmt}` — \
         it must increment with `.saturating_add(1)`. A plain `+= 1` panics at \
         `u32::MAX` under this workspace's `overflow-checks = true`, inside the \
         write-back every battle-ending path funnels through."
    );

    // --- Layer 3: the increment is INSIDE the day-capped block ---------------
    let headers = enclosing_block_headers(&body, win_at + fav_rel);
    let capped = headers
        .iter()
        .any(|(open, h)| *open >= win_at && h.contains(day_field.as_str()));
    assert!(
        capped,
        "TEETH (EG2-7, HIGH): no brace block enclosing the `trust_favorable_count` \
         increment is headed by a condition naming \
         `trust_favorable_battle_day_epoch`, so the once-per-day cap does not gate \
         the credit it exists to cap. EG2-7 caps the Trust-favorable battle credit \
         at once per monster per day; an increment outside the gate credits EVERY \
         wild win, and a grinding session walks the whole Trust ladder in minutes. \
         The sanctioned shape is \
         `if today > m.trust_favorable_battle_day_epoch {{ ..increment..; \
         m.trust_favorable_battle_day_epoch = today; }}` — see the body sketch above \
         this test."
    );

    // --- Layer 4: the anchor is both READ and WRITTEN ------------------------
    let n_day = win_region.matches(day_field.as_str()).count();
    assert!(
        n_day >= 2,
        "TEETH (EG2-7): `trust_favorable_battle_day_epoch` appears {n_day} time(s) \
         in the `SideAWins` region; it must appear at least twice — once in the \
         comparison that gates the credit, once in the store that advances it. With \
         one mention the cap is decorative: read-but-never-advanced credits every \
         win forever, and advanced-but-never-read never blocks anything."
    );
}
