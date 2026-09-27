//! Auto-evolution race guard over the shipped evolution graph (T11).

use std::collections::HashMap;

use game_core::{load_evolution_paths, EvolutionPath};

/// Test-local invariant (deliberately NOT added to `validate_evolution_paths`
/// — ADR-0176 D2 proposes it as a future R13 candidate for the EG5-1 gate
/// rewrite). For every species with 2+ out-edges, either ALL out-edges share
/// one `min_level`, or the lowest-`min_level` out-edge carries at least one
/// additional gate (any of essence / Trust / Quality Time / Nutrition).
///
/// SCOPE, READ CAREFULLY — this catches exactly ONE failure mode:
/// *unconditional* dominance, i.e. a low-level out-edge with NO other gate at
/// all (the literal ADR-0176 D2 regression: `1->4` transcribed verbatim at
/// `min_level: 16` with nothing else, racing `1->6`'s `min_level: 20`).
///
/// It does NOT catch, and CANNOT be extended cheaply to catch, *difficulty*
/// dominance: a low-level out-edge whose non-level gate(s) are in practice
/// EASIER to clear than a higher-level sibling's level gate, so the
/// low-level edge still wins the EG2-11 auto-evolution race despite
/// satisfying "has an extra gate". Edge 2 (`1->5`, `min_level: 1`, essence
/// Fire 150, `min_trust_tier: Some(Friendly)`) is the KNOWN LIVE INSTANCE:
/// it passes this test (it has two extra gates) while still being cheaper
/// than both `1->4` and `1->6`'s `min_level: 20` in expected play time —
/// `Friendly` needs only `fav=5, unfav=0` care() calls (`trust_tier_of`'s
/// smoothing puts that at exactly the 60% `Friendly` floor,
/// `game-core/src/evolution/eligibility.rs:180-201`), roughly a day at the
/// 6h cooldown (`game-core/src/raising/rules.rs:106`) and at NO level at
/// all; Fire 150 is ~15 wild wins against a Fire-type opponent, and
/// Flameling — the very species evolving — is itself a weighted common in
/// zones 0 and 1. So `1->5` forecloses `1->4` and `1->6` in practice, and
/// this test does not and cannot flag it: judging relative gate difficulty
/// needs the essence accrual rate, encounter weights and Trust/Bond math
/// that live in `game-core/src/evolution/` and `game-core/src/raising/`, not
/// in this content-only registry. Do not read a green T11 as "no edge in
/// this graph can race its siblings" — read it as "no edge in this graph is
/// UNCONDITIONALLY undefended". The residual difficulty-dominance risk for
/// edge 2 is recorded as its own item in ADR-0176 (see the ADR's
/// residual-risk note); that note, not this test, is the source of truth for
/// whether `1->5` is an accepted risk or a defect.
#[test]
fn t11_no_out_edge_is_temporally_dominated() {
    let paths = load_evolution_paths().expect("evolution_paths registry must parse");

    let mut by_source: HashMap<u32, Vec<&EvolutionPath>> = HashMap::new();
    for path in &paths {
        by_source.entry(path.from_species).or_default().push(path);
    }

    for (from_species, out_edges) in &by_source {
        if out_edges.len() < 2 {
            continue;
        }
        let levels: Vec<u8> = out_edges.iter().map(|p| p.min_level.as_u8()).collect();
        let all_same_level = levels.iter().all(|&lv| lv == levels[0]);
        if all_same_level {
            continue;
        }
        let min_level = *levels.iter().min().expect("out_edges is non-empty");
        for edge in out_edges {
            if edge.min_level.as_u8() != min_level {
                continue;
            }
            let has_extra_gate = !edge.essence.is_empty()
                || edge.min_trust_tier.is_some()
                || edge.min_quality_time_tier.is_some()
                || edge.min_nutrition_pct.is_some();
            let edge_id = edge.edge_id;
            assert!(
                has_extra_gate,
                "T11: species {from_species}'s lowest-min_level out-edge (edge_id {edge_id}, \
                 level {min_level}) carries NO essence or history gate at all — this is \
                 UNCONDITIONAL dominance (the literal ADR-0176 D2 regression): under EG2-11 \
                 auto-evolution it races and permanently starves its higher-level sibling(s) \
                 with certainty, no playtest data needed. (Note: passing this assertion is NOT \
                 proof the edge is race-safe — an edge with an extra gate can still be a \
                 DIFFICULTY-dominant racer if that gate is cheaper in practice than the \
                 sibling's level gate; this test cannot detect that, see edge 2's doc-comment \
                 case above and ADR-0176's residual-risk note.) levels seen: {levels:?}"
            );
        }
    }
}
