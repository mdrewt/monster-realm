//! rb-82 — RON comment claims must cross-check against the authoritative
//! content data. Two shipped comments make FACTUAL claims that contradict the
//! data they describe; these tests parse the real data via the public
//! `game_core` API and assert the claim against it, so they are RED until the
//! comment (never the data) is corrected.
//!
//! Criteria -> tests:
//!   Claim 1  rb82_claim1_*  species/070-wave3.ron:17 "Electric resists
//!            nothing but its own mirror" vs `load_type_chart()`.
//!   Claim 2  rb82_claim2_*  species/071-wave3-derived.ron:36 "Tempestrix
//!            owns the Regeneration pivot" vs `load_abilities()` +
//!            `load_species()`.
//!
//! Every pure helper below is proven non-vacuous by a SYNTHETIC sentence or a
//! synthetic RON-parsed roster — never by mutating the shipped content files
//! (a tooth that edits shipped content is a content change, not a tooth).

use std::collections::BTreeSet;

use game_core::{load_abilities, load_species, load_type_chart, parse_species, Affinity, Species};

// ===========================================================================
// Fixture helpers
// ===========================================================================

fn content_dir_file(rel: &str) -> String {
    format!("{}/content/{rel}", env!("CARGO_MANIFEST_DIR"))
}

/// A minimal, valid `Species` RON roster — copies the required-field shape
/// from `game-core/content/species/000-core.ron` (id/name/base_stats/
/// affinity/learnable_skill_ids; `ability`/`tier` are `#[serde(default)]`).
fn synth_species_roster() -> Vec<Species> {
    let ron_str = r#"
        [
            (
                id: 900,
                name: "Sproutlet",
                base_stats: (hp: 1, attack: 1, defense: 1, speed: 1, sp_attack: 1, sp_defense: 1),
                affinity: Plant,
                learnable_skill_ids: [1],
            ),
            (
                id: 901,
                name: "Stoneward",
                base_stats: (hp: 1, attack: 1, defense: 1, speed: 1, sp_attack: 1, sp_defense: 1),
                affinity: Earth,
                learnable_skill_ids: [1],
            ),
            (
                id: 902,
                name: "Tempestrix",
                base_stats: (hp: 1, attack: 1, defense: 1, speed: 1, sp_attack: 1, sp_defense: 1),
                affinity: Wind,
                learnable_skill_ids: [1],
            ),
        ]
    "#;
    parse_species(ron_str).expect("synth_species_roster: fixture RON must parse")
}

// ===========================================================================
// Pure helpers under test (extracted so the teeth can call them directly on
// synthetic strings/structs, never on shipped content)
// ===========================================================================

/// Whole-word substring match: `needle` must not be flanked by an
/// alphanumeric character on either side. Byte-index based (safe on UTF-8:
/// reading a continuation byte's `is_ascii_alphanumeric()` is always `false`,
/// so no char-boundary panic and no false "word" boundary inside a multibyte
/// character).
fn contains_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let mut start = 0usize;
    while let Some(rel) = haystack[start..].find(needle) {
        let idx = start + rel;
        let before_ok = idx == 0 || !bytes[idx - 1].is_ascii_alphanumeric();
        let after = idx + needle.len();
        let after_ok = after >= bytes.len() || !bytes[after].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        start = idx + needle.len().max(1);
    }
    false
}

/// Extracts "sentences" out of the RON file's `//` prose comments. Consecutive
/// whole-line `//` comments are joined (with a single space) into one run;
/// each run is then split at every `.` or `;`, and each non-empty trimmed
/// piece is one sentence. A non-comment line (including a truly blank line)
/// ends the current run.
fn comment_sentences(src: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut run: Vec<&str> = Vec::new();
    for line in src.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("//") {
            run.push(rest.trim());
        } else {
            flush_run(&mut run, &mut sentences);
        }
    }
    flush_run(&mut run, &mut sentences);
    sentences
}

fn flush_run<'a>(run: &mut Vec<&'a str>, out: &mut Vec<String>) {
    if run.is_empty() {
        return;
    }
    let joined = run.join(" ");
    for piece in joined.split(['.', ';']) {
        let piece = piece.trim();
        if !piece.is_empty() {
            out.push(piece.to_string());
        }
    }
    run.clear();
}

/// Every `Affinity` variant named as a whole word in `sentence`. Because the
/// content comments always name their subject affinity by its enum spelling
/// (e.g. "Electric resists..."), a plain whole-word scan over `Affinity::ALL`
/// already captures a self-reference like "Electric ... its own mirror" —
/// "Electric" is itself present in the sentence text.
fn stated_affinities(sentence: &str) -> BTreeSet<Affinity> {
    Affinity::ALL
        .into_iter()
        .filter(|a| contains_word(sentence, &format!("{a:?}")))
        .collect()
}

/// Every species `name` (from `roster`) named as a whole word in `sentence`.
fn stated_species(sentence: &str, roster: &[Species]) -> BTreeSet<String> {
    roster
        .iter()
        .filter(|s| contains_word(sentence, &s.name))
        .map(|s| s.name.clone())
        .collect()
}

/// Does `sentence` assert SOLE ownership/exclusivity ("owns"/"only"/"sole"/
/// "unique")? Kept small and literal per the spec.
fn has_sole_ownership_claim(sentence: &str) -> bool {
    ["owns", "only", "sole", "unique"]
        .iter()
        .any(|w| contains_word(sentence, w))
}

// ===========================================================================
// Claim 1 — species/070-wave3.ron:17 "Electric resists nothing but its own
// mirror" vs the real type chart.
// ===========================================================================

#[test]
fn rb82_claim1_electric_resist_roster_matches_type_chart() {
    let src = std::fs::read_to_string(content_dir_file("species/070-wave3.ron"))
        .expect("species/070-wave3.ron must be readable");
    let sentence = comment_sentences(&src)
        .into_iter()
        .find(|s| s.contains("Electric resists"))
        .expect(
            "rb82-1: a comment sentence mentioning \"Electric resists\" must exist in \
             species/070-wave3.ron",
        );
    let stated = stated_affinities(&sentence);

    let type_chart = load_type_chart().expect("type chart must parse");
    let data: BTreeSet<Affinity> = type_chart
        .iter()
        .filter(|r| r.defender == Affinity::Electric && r.effectiveness < 10)
        .map(|r| r.attacker)
        .collect();

    assert_eq!(
        stated, data,
        "rb82-1: species/070-wave3.ron's comment (\"{sentence}\") claims Electric resists \
         {stated:?}, but load_type_chart() says the real resist roster is {data:?}"
    );
}

// ===========================================================================
// Claim 2 — species/071-wave3-derived.ron:36 "Tempestrix owns the
// Regeneration pivot" vs the real species/abilities data.
// ===========================================================================

#[test]
fn rb82_claim2_regeneration_owner_roster_matches_species_data() {
    let src = std::fs::read_to_string(content_dir_file("species/071-wave3-derived.ron"))
        .expect("species/071-wave3-derived.ron must be readable");
    let sentence = comment_sentences(&src)
        .into_iter()
        .find(|s| s.contains("Regeneration"))
        .expect(
            "rb82-2: a comment sentence mentioning \"Regeneration\" must exist in \
             species/071-wave3-derived.ron",
        );

    let abilities = load_abilities().expect("abilities registry must parse");
    let regeneration_id = abilities
        .iter()
        .find(|a| a.name == "Regeneration")
        .map(|a| a.id)
        .expect("rb82-2: an ability named \"Regeneration\" must exist in the abilities registry");

    let species = load_species().expect("species registry must parse");
    let data: BTreeSet<String> = species
        .iter()
        .filter(|s| s.ability == Some(regeneration_id))
        .map(|s| s.name.clone())
        .collect();

    let stated = stated_species(&sentence, &species);

    assert_eq!(
        stated, data,
        "rb82-2: species/071-wave3-derived.ron's comment (\"{sentence}\") names {stated:?} as \
         owning the Regeneration ability, but the species data says the real roster is {data:?}"
    );
    assert!(
        !has_sole_ownership_claim(&sentence),
        "rb82-2: species/071-wave3-derived.ron's comment (\"{sentence}\") claims sole ownership \
         (\"owns\"/\"only\"/\"sole\"/\"unique\") of the Regeneration ability, but {} species \
         share it: {data:?}",
        data.len()
    );
}

// ===========================================================================
// Teeth — pure helpers proven non-vacuous on synthetic input only.
// ===========================================================================

#[test]
fn rb82_teeth_stated_affinities_reads_the_mirror_sentence_exactly() {
    // TEETH(rb82-a): a wrong implementation that hardcodes {Electric, Water}
    // regardless of input, or that fails to recognize the self-named subject
    // "Electric", is caught here: the ORIGINAL (uncorrected) comment sentence
    // must read back as exactly {Electric}, not {Electric, Water}.
    let stated = stated_affinities("Electric resists nothing but its own mirror");
    assert_eq!(
        stated,
        BTreeSet::from([Affinity::Electric]),
        "TEETH(rb82-a): the original comment sentence must parse to exactly {{Electric}}"
    );
}

#[test]
fn rb82_teeth_stated_affinities_reads_an_added_water_clause() {
    // TEETH(rb82-b): kills an implementation that only ever returns a
    // single-element set (e.g. always the first Affinity found, or a set
    // capped at size 1) — a sentence naming TWO affinities must yield both.
    let stated = stated_affinities("Electric resists only Water and its own mirror");
    assert_eq!(
        stated,
        BTreeSet::from([Affinity::Electric, Affinity::Water]),
        "TEETH(rb82-b): a sentence naming Electric AND Water must yield both, not just one"
    );
}

#[test]
fn rb82_teeth_stated_species_reads_a_single_named_species() {
    // TEETH(rb82-c): kills an implementation that returns every species in the
    // roster unconditionally (a vacuous "always full roster" stub) — a
    // sentence naming only Tempestrix must yield exactly {Tempestrix}.
    let roster = synth_species_roster();
    let stated = stated_species("Tempestrix owns the Regeneration pivot", &roster);
    assert_eq!(
        stated,
        BTreeSet::from(["Tempestrix".to_string()]),
        "TEETH(rb82-c): a sentence naming only Tempestrix must yield exactly {{Tempestrix}}"
    );
}

#[test]
fn rb82_teeth_stated_species_reads_all_named_species() {
    // TEETH(rb82-d): kills an implementation that returns only the FIRST
    // matched species (e.g. `.find().into_iter().collect()`) — a sentence
    // naming all three roster species must yield all three.
    let roster = synth_species_roster();
    let stated = stated_species(
        "Sproutlet, Stoneward and Tempestrix all use the Regeneration ability",
        &roster,
    );
    assert_eq!(
        stated,
        BTreeSet::from([
            "Sproutlet".to_string(),
            "Stoneward".to_string(),
            "Tempestrix".to_string(),
        ]),
        "TEETH(rb82-d): a sentence naming all three roster species must yield all three"
    );
}

#[test]
fn rb82_teeth_comment_sentences_joins_consecutive_lines_and_splits_on_period() {
    // TEETH(rb82-e): kills an implementation that (a) treats every `//` line
    // as its own separate sentence (never joining), or (b) fails to stop a
    // sentence at `.` (swallowing the next block into one giant string).
    let src =
        "// Electric resists nothing but its\n// own mirror.\n// Next sentence starts here.\n";
    let sentences = comment_sentences(src);
    assert_eq!(
        sentences,
        vec![
            "Electric resists nothing but its own mirror".to_string(),
            "Next sentence starts here".to_string(),
        ],
        "TEETH(rb82-e): two consecutive `//` lines must join into one sentence, split at the \
         period into two independent sentences: {sentences:?}"
    );
}

#[test]
fn rb82_teeth_sole_ownership_predicate_flags_owns_even_with_a_correct_roster() {
    // TEETH(rb82-f): kills an implementation that only checks the NAMED
    // roster for correctness and never separately gates on sole-ownership
    // language — a sentence can name the FULL correct roster and still be
    // wrong because it also claims exclusivity.
    let roster = synth_species_roster();
    let sentence = "Sproutlet, Stoneward and Tempestrix owns the Regeneration ability";
    let stated = stated_species(sentence, &roster);
    let data: BTreeSet<String> = roster.iter().map(|s| s.name.clone()).collect();
    assert_eq!(
        stated, data,
        "TEETH(rb82-f) setup: the roster named in this sentence must match the full synthetic \
         roster (proves this is NOT a roster-mismatch failure)"
    );
    assert!(
        has_sole_ownership_claim(sentence),
        "TEETH(rb82-f): a sentence containing \"owns\" must still be flagged as a sole-ownership \
         claim even though its named roster is complete"
    );
}

#[test]
fn rb82_teeth_sole_ownership_predicate_does_not_flag_neutral_language() {
    // Non-vacuity arm: a sentence with none of the four ownership words must
    // NOT be flagged (kills a predicate that is `true` unconditionally).
    assert!(
        !has_sole_ownership_claim("Sproutlet, Stoneward and Tempestrix all learn Regeneration"),
        "TEETH(rb82-f/neutral): a sentence with no ownership verb must not be flagged"
    );
}

#[test]
fn rb82_teeth_contains_word_does_not_match_a_substring_of_a_longer_word() {
    // Non-vacuity arm for the shared word-boundary helper both stated_*
    // functions depend on: "Electric" must not match inside "Electricity",
    // and a bare substring scan (`str::contains`) would wrongly say it does.
    let stated = stated_affinities("Electricity lore aside, no real Affinity is named here");
    assert!(
        stated.is_empty(),
        "TEETH(rb82-g): \"Electricity\" must not be misread as the \"Electric\" affinity: \
         {stated:?}"
    );
}
