//! DELIBERATELY IMPURE determinism-gate proof-of-teeth fixture (M8.8a, ADR-0055).
//! Every line below is a determinism violation the workspace `clippy.toml` bans.
//! This crate is detached from the workspace and is NEVER part of a green build;
//! `evals/determinism-fail-loud.eval.mjs` runs clippy on it and asserts each sink
//! is rejected. If you are reading this because clippy failed here — that is the
//! point. Do not "fix" it.
#![allow(unused, dead_code, deprecated)]

/// Touch one wall-clock / OS-entropy / unseeded-RNG sink per determinism ban.
pub fn impure() {
    // std::time wall clocks (already banned pre-M8.8a — kept to mirror the existing teeth)
    let _ = std::time::SystemTime::now();
    let _ = std::time::Instant::now();
    let _ = std::time::SystemTime::UNIX_EPOCH.elapsed(); // exercises std::time::SystemTime::elapsed (no ::now needed)
    let _ = std::time::Instant::now().elapsed(); // exercises std::time::Instant::elapsed
                                                 // chrono wall clocks (M8.8a: new ban)
    let _ = chrono::Utc::now();
    let _ = chrono::Local::now();
    // rand unseeded RNG (random/thread_rng already banned; rng is the rand 0.9 alias — new)
    let _ = rand::random::<u8>();
    let _ = rand::thread_rng();
    let _ = rand::rng();
    // OS entropy types (M8.8a: new disallowed-types bans)
    let _osr: rand::rngs::OsRng = rand::rngs::OsRng;
    let _tr: rand::rngs::ThreadRng = rand::rng();
    // getrandom OS entropy (M8.8a: new bans) — fill (0.3+) and getrandom (0.2)
    let mut b = [0u8; 4];
    let _ = getrandom::fill(&mut b);
    let mut c = [0u8; 4];
    // alias to getrandom 0.2; clippy reports the CANONICAL path getrandom::getrandom (verified: Part A is green)
    let _ = getrandom02::getrandom(&mut c);
}
