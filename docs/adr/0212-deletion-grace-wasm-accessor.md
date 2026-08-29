# 0212 — Deletion grace window: a wasm accessor so TypeScript never hand-types it

**Status:** Accepted
**Date:** 2026-08-29
**Slice:** rb-8 (residual R-m22-s1-X3)
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, ci-gates
**Decision:** Export `game_core::DELETION_GRACE_MS_DEFAULT` from `client-wasm` as a `#[wasm_bindgen]` accessor returning `i64` (JS `BigInt`), so S8's countdown reads the grace window instead of hand-typing it.

---

## Context and problem statement

M22 spec §8.1 escalation #1 is explicitly UNRESOLVED: the 7-day deletion grace window is an arbitrary placeholder. The constant `game_core::DELETION_GRACE_MS_DEFAULT` (deletion.rs, 604,800,000 ms) ships with an HONESTY NOTE saying an operator will retune it.

The slice R-m22-s1-X3 promoted this constant to the backlog. S8 (the deletion/cancel countdown UX, spec §7.2) needs access to this window to compute remaining time. Today, `client-wasm/pkg` exports 10 functions; none of them is this. The schema carries only `deletion_requested_at_ms: Option<i64>`, not the grace value.

If S8 hardcodes the window as a TS literal, it silently drifts on the day the operator retunes the constant. No test will catch this because `main.ts` is coverage-excluded.

Additionally, `deletionRequestedAtMs` is `Option<i64>` → `bigint | undefined` in TS (client/src/module_bindings/my_account_table.ts:25). A countdown is computed as `requestedAt + grace - now`. If `grace` comes from a `number` accessor (32-bit u32 or f64), the arithmetic throws `Cannot mix BigInt and other types` at runtime — a browser-only failure no unit test sees because those files are excluded from tsconfig.

## Considered alternatives

- **A — hardcode the literal in TS.** Rejected: S8 owns the countdown, and after the operator retunes the constant tomorrow, the TS literal becomes stale and wrong — a silent drift no test sees.
- **B — export a `u32` accessor (32-bit unsigned).** Rejected: `u32` caps the window at ~49.7 days; an operator who picks 60 days is silently truncated. Also: arithmetic with `bigint | undefined` + `number` throws at runtime.
- **C — export an `f64` accessor (JavaScript number).** Rejected: same runtime throw on BigInt mixing. Loses precision; `604800000.5` would be indistinguishable from `604800001`.
- **D — export an `i64` accessor returning `BigInt` (chosen).** The accessor returns the Rust `i64` as JS `BigInt`, matching the type of `deletionRequestedAtMs` in the bindings. Arithmetic with `bigint + bigint - bigint` is type-safe. No precision loss. The i64 → BigInt mapping is pre-existing in this very file: `predict_tick(state: bigint)` and party-move operations already use it, proven by the parity eval. S8's countdown uses the same well-tested path.

## Decision outcome

**Chosen: D.** Add a fifth constant accessor to `client-wasm/src/lib.rs` in the existing cluster beside `step_ms`/`move_queue_cap`/`party_size`/`party_slot_none`:

```rust
#[wasm_bindgen]
#[must_use]
pub fn deletion_grace_ms_default() -> i64 {
    game_core::DELETION_GRACE_MS_DEFAULT
}
```

No TS file hardcodes the literal in this slice. The two repo-wide occurrences are the constant itself and its own comment. TypeScript files excluding the accessor (measured: all 211 `.ts` files under `client/`) would fail typecheck on an unused import due to `noUnusedLocals: true`, so no consumer ships. Reachability is proven EXECUTABLY: the gate builds the wasm and calls the export from Node.

### Why i64/BigInt is load-bearing

The generated `client-wasm/pkg/client_wasm.d.ts` shows the pre-existing mapping:
- `deletion_grace_ms_default(): bigint` (i64)
- `party_size(): number` (u32)
- `predict_tick(state: bigint): bigint` (u64)

The countdown formula in S8 will be: `deletionRequestedAtMs + deletion_grace_ms_default() - now_ms`. All three operands are `bigint`. Mixing a `number` (u32 or f64) into this expression throws `TypeError: Cannot mix BigInt and other types` at runtime.

A unit test calling the countdown would catch this. But the countdown lives in `main.ts` (coverage-excluded) or in a component that never ships standalone test coverage. The fix must prevent the runtime throw **before** S8 writes its first line: a type-safe accessor forces the issue into the type system where `tsc` catches it.

### S8 wiring recipe (single-source for the next slice)

S8 will import the accessor from `../../client-wasm/pkg/client_wasm.js`. The mock factories in **both** `client/src/main.battle-reseed.test.ts` AND `client/src/main.a11yFocus.test.ts` must also declare it, because both mirror the real module's FULL export surface by convention — any sibling importer of the same specifier must never get `undefined` from the mock.

This slice's gate pre-wired both mocks with `deletion_grace_ms_default: () => 1n`, a `BigInt` on purpose. If the stub were `1` (a number), `tsc` would not catch it (test files are excluded), but a unit test importing the countdown function WOULD break at the `bigint` mixing check. This is the early-warning mechanism.

### Proof and proof of teeth (ADR-0010)

**Six gate clauses, 27 fixtures, all values computed not hardcoded** (`evals/deletion-grace-wasm-ssot.eval.mjs`, NEW, auto-discovered):

1. **G1/delegates** — body extracted from comment-stripped source, EXACTLY EQUAL to `game_core::DELETION_GRACE_MS_DEFAULT`, no `game_core` alias or `DELETION_GRACE_MS_DEFAULT` rebinding (exact-shape text pin, never relaxed to substring).
2. **G2/bindgen** — `#[wasm_bindgen]` attribute is present (presence pin).
3. **G3/js-reachable** — fresh `wasm-pack --target nodejs` build succeeds and the export is CALLED from Node (build + runtime reach).
4. **G4/value-parity** — the returned value is a `bigint` exactly equal to the parsed Rust constant (exactly-one-match, fail-loud on parse ambiguity).
5. **G5/no-ts-dup** — no numeric literal or arithmetic evaluates to the live grace window in any `.ts` file under `client/` (all 211, tests INCLUDED), numeric-only detector, 27 fixtures covering every radix/exponent/separator/BigInt spelling.
6. **COMPILED native test** — `deletion_grace_matches_game_core_const` in `client-wasm/src/lib.rs` (mod tests), assertions load-bearing on the Rust side.

**Proof of teeth (measured, enumerated).** RED before the fix (`FAIL [G1/delegates]: pub fn deletion_grace_ms_default not found`), green after. Ten hand-substituted wrong implementations:

- Nested-block cheat: `let _ = { game_core::DELETION_GRACE_MS_DEFAULT }; 0x240c_8400i64` is rustfmt-stable and clippy-clean AND passes the native parity test (the values are equal) — only G1's exact-shape pin catches it, proving that clause must never be relaxed to a substring.
- Wrong-const delegation (e.g., `STEP_MS`) reds G1 + the native test.
- Deleted attribute reds G2.
- TS duplicates written as `604_800_000`, `6048 * 100000`, `0x240c8400` behind a `.test.ts` suffix each red G5.
- NEGATIVE CONTROL — retuning the constant to `604_800_001` — leaves every gate clause GREEN, proving the gate pins DELEGATION and never the operator's unresolved number.

**Two red-team bypasses found and closed (reusable lesson).**

(1) **Decoy via string literal.** `stripRustComments` removes comments but NOT string literals. A `const _X: &str = r#"...honest looking accessor..."#;` planted above the real one steered a first-hit `indexOf` to the decoy while the real exported fn returned `1_209_600_000i64 / 2`. All six clauses went green. **Fix:** `requireSoleDefinition`, counting occurrences and throwing on more than one. Same hardening `parseGraceConst` already had — the reason the red-team could not break that primitive.

(2) **Decoy via conditional compilation.** `#[cfg(target_arch = "wasm32")] fn deletion_grace_ms_default() { ... }` / `#[cfg(not(...))]` split (the same shape already exists in this file for `zone_map_ok`/`zone_map_err`, reading as idiomatic). **Fix:** same `requireSoleDefinition` counting — no more than one definition allowed, anywhere.

**General lesson: a text gate that locates its subject with a first-hit search is forgeable by planting a decoy; counting occurrences makes the anchor sound.**

## Residuals

**G5 is a numeric DETECTOR, not a proof of absence:**
- Folds `* / + - <<` with correct precedence; every radix/separator/exponent/BigInt spelling.
- Blind to `Number('60480'+'0000')`, base-36, a JSON fixture, a chain split across a newline, or a comment between terms.
- NUMERIC-ONLY. The likeliest real S8 drift is PROSE: a hard-coded "7 days" in a countdown label or UX copy. The closing tooth for that is the positive one S8 owns: the label must be FORMATTED FROM the accessor, never composed with prose constants.

**G5 is coupled to the constant's VALUE — a future retune will collide with unrelated fixtures:**
- The grace window `604_800_000` is exact today (0 hits / 211 files).
- A retune to a rounder number (e.g., one day = `86_400_000`) collides with `86400` in `client/src/ui/healModel.test.ts`.
- The failure is loud and its message says so; it is not silent. Flagged as a follow-up: a `G5-VALUE-COLLISION` known issue.

**G4 is a text oracle over Rust source, cross-checked by the compiled native test.** Consequence recorded in the constant's own comment (deletion.rs): the retuned value must stay a bare integer literal. No computed constants.

**The SSOT is build-time on BOTH sides.** Republishing `server-module` with a retuned constant WITHOUT rebuilding `client-wasm` and the client bundle leaves the client showing the old window while the server enforces the new one. This gate catches SOURCE drift, not DEPLOY skew. The real fix would be a server-supplied due timestamp (not implemented today). Operator playbook: retune, rebuild both, republish both.

**The client now knows the grace window but NOT the rule.** `is_deletion_due` (game-core reducer logic) is deliberately not exposed as a client accessor. The client holding the window + `deletionRequestedAtMs` is one line from reimplementing `is_deletion_due` in TS, including its `>=` boundary, its `None => false` arm, and its saturating subtraction. **S8 must either:**
- Get `is_deletion_due` as a second thin accessor (verify it would not leak the server's own-account deletion state to other players), **OR**
- Only FORMAT the remaining time and never decide due-ness (the countdown label shows "6 days 23 hours remain"; the delete-button disable is server-sourced).

**Disclosure.** The constant is a compile-time public placeholder already printed in ARCHITECTURE.md and ADR-0207. Knowing it confers no capability; the operator can already tune it in source. Erasure (actually forgetting the value after deletion) remains a server reducer decision over server time.
