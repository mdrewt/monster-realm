//! Native test-vector generator for the prediction-parity eval: prints the
//! game-core rule output (the SERVER path) for a fixed set of inputs as JSON.
//! The eval feeds the same inputs through the wasm-pack build and asserts
//! identical output (no feature-flag/target divergence). u64 fields are strings
//! so JS reads them losslessly via BigInt.

use game_core::tick_seed;

fn main() {
    let vectors: [(u64, u64, u64); 6] = [
        (0, 0, 0),
        (1, 2, 3),
        (42, 7, 99),
        (u64::MAX, 1, 1),
        (123, 456, 789),
        (9_999_999, 12_345, 678),
    ];
    let items: Vec<String> = vectors
        .iter()
        .map(|(s, i, seed)| {
            format!(
                "{{\"s\":\"{s}\",\"i\":\"{i}\",\"seed\":\"{seed}\",\"out\":\"{}\"}}",
                tick_seed(*s, *i, *seed)
            )
        })
        .collect();
    println!("[{}]", items.join(","));
}
