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
