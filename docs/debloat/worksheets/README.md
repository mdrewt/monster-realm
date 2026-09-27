# Per-test worksheets (Phase 1 EXTRACT contracts)

One NDJSON row per `#[test]` in each mixed server test file: `{file, test_name, verdict: KEEP|DELETE, reason}`,
written independently by the classifier and verifier keys. Phase 2 EXTRACT surgeons follow the governing rule:

- Default (two-key agreement files): a test is deleted only if BOTH sides say DELETE; either side saying KEEP keeps it.
- Arbitrated exceptions (arb-7): the CLASSIFIER worksheet governs privacy_tests, battle_tests, evolution_tests,
  pvp_tests, accounts_tests, trading_tests (the two are identical); the VERIFIER worksheet governs economy_tests.
  In accounts_tests the 11 rb39_*/rb108_* rows the verifier marked behavioral are DELETE (they exercise the file's
  own source scanner over synthetic fixtures — meta-gates).

Deletion counts are re-validated at surgery time with `cargo test -- --list` parity per the plan.
