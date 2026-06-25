//! Native movement test vectors for the movement-parity eval: runs the SAME
//! `game_core::apply_move` (the SERVER path) over `zone_0()` for a fixed set of
//! inputs and prints `{in, out}` JSON. The eval feeds the same inputs through the
//! wasm-pack build and asserts identical output (no feature-flag/target divergence).

use game_core::apply_move_coded;

fn main() {
    // [x, y, facing, action, started, input_kind, step_dir, now]
    let vectors: [[i64; 8]; 6] = [
        [1, 1, 0, 0, 0, 0, 2, 1000], // Step East -> move
        [1, 1, 0, 0, 0, 0, 0, 1000], // Step North into border wall -> bump
        [3, 3, 2, 0, 0, 1, 0, 1000], // Jump (facing East) into inner wall -> hop in place
        [1, 1, 2, 0, 0, 1, 0, 1000], // Jump (facing East) -> move
        [8, 5, 1, 0, 0, 0, 1, 1000], // Step South into border wall -> bump
        [2, 2, 3, 0, 0, 0, 3, 1000], // Step West -> move
    ];
    let items: Vec<String> = vectors
        .iter()
        .map(|v| {
            let r = apply_move_coded(
                v[0] as i32, v[1] as i32, v[2] as u8, v[3] as u8, v[4], v[5] as u8, v[6] as u8, v[7],
            );
            format!(
                "{{\"in\":[{},{},{},{},{},{},{},{}],\"out\":[{},{},{},{}]}}",
                v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], r[0], r[1], r[2], r[3]
            )
        })
        .collect();
    println!("[{}]", items.join(","));
}
