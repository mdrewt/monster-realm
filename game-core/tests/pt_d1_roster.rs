//! Registry-wide STAB invariant over the shipped content: every species can
//! learn at least one skill of its own affinity. A species without one is
//! strictly broken in the affinity battle loop, and `validate_content` does not
//! check it.

use game_core::{load_skills, load_species, SkillDef, Species};

/// Ids of every species that cannot learn a single skill matching its own affinity.
fn stab_violations(species: &[Species], skills: &[SkillDef]) -> Vec<u32> {
    species
        .iter()
        .filter(|sp| {
            !sp.learnable_skill_ids.iter().any(|sid| {
                skills
                    .iter()
                    .any(|sk| sk.id == *sid && sk.affinity == sp.affinity)
            })
        })
        .map(|sp| sp.id)
        .collect()
}

#[test]
fn pt_d1_3_every_species_can_learn_a_same_affinity_skill() {
    let species = load_species().expect("species registry must parse");
    let skills = load_skills().expect("skills registry must parse");
    let violations = stab_violations(&species, &skills);
    assert!(
        violations.is_empty(),
        "every species must be able to learn at least one skill of its OWN affinity; violating ids: {violations:?}"
    );
}
