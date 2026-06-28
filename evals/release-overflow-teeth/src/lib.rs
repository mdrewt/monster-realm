//! Release fail-loud proof-of-teeth fixture (M8.8a, ADR-0055). See Cargo.toml.
//! `core::hint::black_box` defeats const-folding so the overflow is a RUNTIME
//! event gated by overflow-checks, not a compile-time error.

#[cfg(test)]
mod teeth {
    /// PROOF-OF-TEETH: a deliberate runtime u8 overflow. With the workspace
    /// `[profile.release] overflow-checks = true`, a release build PANICS here
    /// ("attempt to add with overflow"); without it, it silently wraps and this
    /// `#[should_panic]` test FAILS. Run in release by
    /// `evals/determinism-fail-loud.eval.mjs`.
    #[test]
    #[should_panic(expected = "overflow")]
    fn release_build_aborts_on_integer_overflow() {
        let x: u8 = core::hint::black_box(u8::MAX);
        let _ = x + core::hint::black_box(1u8);
    }
}
