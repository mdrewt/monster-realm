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
fn extract_fn_body<'a>(src: &'a str, name: &str) -> Option<&'a str> {
    // Try `pub fn <name>(` first, then `fn <name>(`.
    let pub_needle = format!("pub fn {}(", name);
    let priv_needle = format!("fn {}(", name);
    let fn_start = src
        .find(pub_needle.as_str())
        .or_else(|| src.find(priv_needle.as_str()))?;

    // Walk forward from fn_start to find the opening `{`.
    let after_fn = &src[fn_start..];
    let brace_offset = after_fn.find('{')?;
    let body_start = fn_start + brace_offset + 1; // character after '{'

    // Count brace depth to find the matching '}'.
    // `rel` tracks the byte offset within `src[body_start..]`.
    let mut depth: usize = 1;
    let mut rel: usize = 0;
    let chars: Vec<char> = src[body_start..].chars().collect();
    let mut char_pos = 0;
    while char_pos < chars.len() && depth > 0 {
        match chars[char_pos] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        rel += chars[char_pos].len_utf8();
        char_pos += 1;
    }

    if depth == 0 {
        Some(&src[body_start..body_start + rel])
    } else {
        None // unbalanced braces (should not happen in valid Rust)
    }
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
// M12.5b-4 structural tests: write_back_battle_results must call
// compute_evolves_to after a level-up so evolves_to is updated in the
// written-back monster row.
//
// EARS criterion: after a level-up in write_back_battle_results, the
// monster row's `evolves_to` must be recomputed — not left stale.
//
// RED state: the current write_back_battle_results body (see battle.rs
// lines 667-725) does NOT contain any `evolves_to` assignment or call
// to `compute_evolves_to`. Both assertions below will fail today:
//   - positive: `compute_evolves_to` is NOT called in the level-up block
//   - negative: `evolves_to` is NOT written back in the level-up block
//
// This test uses the include_str!/extract_fn_body pattern established above.
// =========================================================================

/// 12.5b-4 structural: write_back_battle_results must call `compute_evolves_to`
/// inside the level-up block so evolves_to is refreshed after a level-up.
///
/// KILLS: a level-up path that recomputes stats but omits the evolves_to
///        recomputation — a monster that crosses a level threshold during battle
///        would not show its evolution eligibility until the next sync_content.
#[test]
fn write_back_battle_results_calls_compute_evolves_to_on_level_up() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    let fn_name = ["write_back", "_battle", "_results"].concat();
    let body = extract_fn_body(&stripped, &fn_name)
        .expect("write_back_battle_results must exist in battle.rs");

    // Assemble needle from parts to avoid self-match inside this test file
    // (which is inside the included source).
    let compute_call = ["compute", "_evolves_to"].concat();

    assert!(
        body.contains(compute_call.as_str()),
        "TEETH(12.5b-4): write_back_battle_results body must call `compute_evolves_to` \
         after a level-up to refresh the monster's evolution eligibility; \
         currently absent. Add: `m.evolves_to = crate::evolution::compute_evolves_to(&evolutions, &m);` \
         inside the level-up block (after the stats are updated)."
    );
}

/// 12.5b-4 structural: write_back_battle_results must write `evolves_to` back
/// to the monster row inside the level-up block.
///
/// KILLS: an impl that calls compute_evolves_to but ignores the result
///        (assigns to a temporary) or forgets to update `m.evolves_to`.
#[test]
fn write_back_battle_results_assigns_evolves_to_on_level_up() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    let fn_name = ["write_back", "_battle", "_results"].concat();
    let body = extract_fn_body(&stripped, &fn_name)
        .expect("write_back_battle_results must exist in battle.rs");

    // The assignment must appear in the body; built from parts to avoid self-match.
    let assignment = ["m.evolves_to", " ="].concat();

    assert!(
        body.contains(assignment.as_str()),
        "TEETH(12.5b-4): write_back_battle_results body must assign `m.evolves_to = ...` \
         after calling compute_evolves_to; without this assignment the recomputed value \
         is discarded and the DB row remains stale. \
         Add: `m.evolves_to = crate::evolution::compute_evolves_to(&evolutions, &m);` \
         inside the level-up block."
    );
}

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
