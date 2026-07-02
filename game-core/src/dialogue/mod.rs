//! Dialogue tree model + pure evaluation rules (ADR-0021, ADR-0068).

pub mod model;
pub mod rules;

#[cfg(test)]
pub mod m12a_gating_tests;

pub use model::{
    Condition, DialogueChoice, DialogueEffect, DialogueNode, DialogueTree, PlayerDialogueState,
};
pub use rules::{
    apply_choice, apply_effects, available_choices, evaluate_condition, find_entry_node,
    ChoiceResult, DialogueError,
};
