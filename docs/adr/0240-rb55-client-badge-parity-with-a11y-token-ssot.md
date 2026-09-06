# 0240 — The client status badge is correlated to game-core's A11Y_TOKENS by a vitest source read, not by a second hand-maintained copy

**Status:** Accepted
**Date:** 2026-09-06
**Slice:** rb-55 (residual R-m23-s8-TSDUP, M-residual-backlog.spec.md#rb-55)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0233 (mechanises the correlation its R-m23-s8-TSDUP residual left to a doc comment), ADR-0224 (invokes its declared-exception clause for a string-matching source scan)
**Subsystems:** client-ui, content
**Decision:** a vitest test reads the A11Y_TOKENS const body from game-core/src/content.rs and asserts the label statusBadge() RETURNS for each StatusEffect variant equals its shipped token, so a label changed in one file alone fails CI.

---

## Context and problem statement

The five status accessibility tokens are written down twice.

- `game-core/src/content.rs:1692` — `A11Y_TOKENS`, the SSOT named by criterion A11Y-29 and
  ADR-0233: `status.poison` -> `PSN`, `status.burn` -> `BRN`, `status.paralysis` -> `PAR`,
  `status.sleep` -> `SLP`, `status.freeze` -> `FRZ`.
- `client/src/ui/battleModel.ts:58` — `statusBadge`, a hand-maintained `switch` returning the same
  five strings, whose own doc comment points back at the Rust const.

ADR-0233 recorded the gap as residual **R-m23-s8-TSDUP**: "nothing correlates the two tables".

The gap was **measured, not assumed**. Renaming a token on the TypeScript side and running the
client suite on the pre-slice tree:

| edit | pre-slice client suite |
| --- | --- |
| `'PSN'` -> `'POI'` | **1 failed**, 120 passed |
| `'BRN'` -> `'BUR'` | 121 passed |
| `'PAR'` -> `'PLZ'` | 121 passed |
| `'SLP'` -> `'SLE'` | 121 passed |
| `'FRZ'` -> `'FZE'` | 121 passed |

So **four of the five** tokens could drift silently. `PSN` alone was already pinned, incidentally,
by a regression assertion at `client/src/ui/battleModel.test.ts:2201`. The two pre-existing parity
tests (`battleModel.test.ts:961` and `:2006`) prove **completeness** — every variant yields a
non-empty, non-warning badge — and deliberately assert nothing about the badge's **value**.

## Decision

A single `it` in `client/src/ui/battleModel.test.ts` reads `game-core/src/content.rs`, slices the
`A11Y_TOKENS` const body, and asserts that for every `StatusEffect` variant `v` in the generated
bindings,

    statusBadge(v.name) === <the token of the `status.<lowercase v.name>` row>

Three properties of that assertion are load-bearing and were each chosen against a measured
alternative:

1. **The oracle is the value `statusBadge()` RETURNS, never a constant it reads.** An earlier
   design compared a new exported `STATUS_BADGE_TOKENS` table against the parsed rows. Three
   mutants survive that shape with the suite fully green: an early `if (tag === 'Poison') return
   'POI';` above the lookup; the table shipped correct while the old `switch` is retained and never
   wired; and `return TABLE[tag].toLowerCase()`. Asserting on the rendered label kills all three.
2. **The parse is scoped to the const body.** `content.rs` contains 17 occurrences of
   `A11yToken {`, four of them outside the const — including `:7819`, a test fixture that
   deliberately ships `key: "status.burn", token: "BR9"` to exercise the duplicate-key rejection.
   A whole-file scan false-REDs on it. The parse therefore anchors on
   `pub const A11Y_TOKENS: &[A11yToken] = &[`, slices to the first `\n];`, and strips `//`
   comments. A separate tuple-form copy at `:7516` (`M23S8_EXPECTED_PAIRS`, the Rust-side rename
   tripwire) is excluded by the struct-shaped row pattern.
3. **The five literals appear nowhere in the new test.** The point is to stop making hand-copies;
   the test asserts a *relation* between two files and introduces no third transcription.

## The ADR-0224 position

ADR-0224 retired scanner-script gates. This test string-matches over Rust source, so the posture
must be explicit rather than assumed.

ADR-0224 retired the **vehicle and the oracle class**: standalone `evals/*.eval.mjs` scanners, and
meta-checks that exist to audit another check. It did not retire reading source from an ordinary
test — its own instruction is that an invariant belongs in "an ordinary test in the crate/module
the invariant belongs to", and `game-core/src/content.rs` itself ships two source-reading tests
written after 0224 (`m23s8_reachability_validate_content_rejects_a_broken_table` and
`m23s8_forgery_validator_judges_only_its_argument`, four `include_str!` read sites between them,
one of which is self-source). `client/src/main.wiring.test.ts:746` is live in-repo
precedent for the same thing under vitest.

ADR-0224:86-89 nonetheless prefers AST analysis and treats string matching as "a rare exception
requiring its own justification". This is that justification: there is no Rust parser available to
a vitest process, a `syn`-grade parser written in TypeScript is wildly disproportionate to five
rows in one const, and the scan reads exactly one anchored region of one file rather than sweeping
a corpus. The two classes ADR-0224 names as the failure mode — comment-stripping bugs and
decoy matches — are the ones an adversarial pass actually exploited, and they are now closed by
assertion rather than by good intentions. An artifact red-team measured four bypasses that kept the
ENTIRE gate set green (client 3119 passed, `cargo nextest` 2238 passed, 99 evals): a raw-string
decoy reproducing the anchor line with its own `];` terminator; a `#[cfg(any())]`-disabled copy of
the correct row beside a real row spelled `concat!("status.", "burn")`; a block-comment carrier for
the same decoy; and a `.replace()` at the `monsterCard` hop below `statusBadge`. The test now
asserts anchor uniqueness, row totality (every `A11yToken {` opener in the region must parse), an
attribute/macro ban and a block-comment ban inside the region, and re-runs the whole comparison
through `buildBattleViewModel`. All four were re-measured RED after that hardening. Two controls
must stay GREEN and are what prove the region scoping is not merely over-matching: C-A, the
deliberately-wrong struct-form `status.burn` fixture at `content.rs:7819`, and C-B, the tuple-form
pin at `:7517`.

This CORRECTS, but does not supersede, ADR-0233:179-182, which asserted that "a mechanical link
would be a text scan (retired by ADR-0224)". That reading of 0224 was too broad. ADR-0233 is left
byte-unchanged and therefore still carries the stale sentence with no forward pointer: editing it
falls outside this slice's one-new-ADR `touches:` grant. Flagged to the supervisor rather than
taken silently.

## Consequences

**The correlation is closed; the duplication is not.** A drift now fails CI in both directions.
The client `switch` remains hand-maintained, so this is a **partial** close of R-m23-s8-TSDUP. The
residual's other half — deriving the labels from shipped data rather than a second listing — needs
`A11Y_TOKENS` to reach the client as content: a table in `server-module`, regenerated bindings, and
an addition to the client subscription set, which is exact-set-pinned by an eval. All three lie
outside this slice's declared `touches:`. That half is deferred to the backlog as its own residual
rather than described in prose here.

**`client/`'s test suite now requires the `game-core/` crate source to be present.** Reading
outside the npm package root is not itself new — `client/src/ui/playtestControlsDoc.test.ts:78-85`
already reads `docs/PLAYTEST.md` with the identical three-`..` idiom, and several client specs
import from the root `evals/` directory — but this is the first client test to read a sibling Rust
crate's source, so the client suite's dependency now spans a language boundary as well as a
directory one.

**Two gaps remain, both measured and neither closed here.** (1) The final DOM hop is unguarded:
`battleView.ts:290` assigns `card.status` to `textContent`, and a rewrite there ships a badge the
test never sees. `battleView.ts` is in this slice's `touches:` but is pinned as source text by
`evals/reduced-motion-hp-bar.eval.mjs`, so it was deliberately left unedited; nothing in the repo
asserts `statusEl.textContent === card.status`. (2) The gate is a one-hunk deletion with no CI
signal — no manifest lists client spec files and no count floors them. The obvious fix, an
`include_str!` pin in `game-core` asserting the describe title exists, was REJECTED: it is exactly
the meta-check ADR-0224:133-141 retires ("no follow-up task audits an existing test for its own
blind spots"), it would put production Rust into a comment-only slice, and it would invert the
layering by pointing the functional core at a presentation-shell file. Both are registered as
residuals rather than papered over.

**A Rust-only edit to `A11Y_TOKENS` can red the client suite.** That is the intent, but the
direction is surprising, so the failure message names both files, the offending variant, and the
instruction to repair both sides.

**One contradiction is now reachable and is documented at the point of failure.** Rust permits a
4-character token (`A11Y_TOKEN_MAX_LEN`, `content.rs:1749`) while the client badge is a pill capped
at 3 characters (`battleModel.test.ts:2033`). A Rust-legal `FRZ` -> `FRZE` therefore has no legal
client repair. The parity failure message states this rather than leaving it to be discovered.

## Alternatives considered

**Rust reads TypeScript** (an `include_str!` of `battleModel.ts` in content.rs's test module).
Rejected: a text scan of TypeScript can prove the `switch` *contains* a string, but not that
`statusBadge()` *returns* it — which measurement 1 above shows is the entire invariant. It also
points the functional core at the outermost presentation shell.

**Both directions.** Rejected: the same equality, a second parser that can go vacuous, and the
recursion ADR-0224 caps.

**Replace the `switch` with an exported data table.** Rejected after being planned. Once the oracle
is `statusBadge()`, the table's only added coverage is a stray `case` arm for a variant the server
cannot send — dead code, and unreachable without also reddening the existing `variants.length`
anchor. Against that it introduces a prototype-chain hazard (`statusBadge('toString')` returning a
function that `battleView.ts:290` would render as `function toString() { [native code] }`) which
then needs its own tooth. A hand-kept object literal is not less duplicated than a hand-kept
`switch`. `content.rs:1607` already rules that these keys are "type space, not designer-authored
rows", so a no-wildcard `switch` is the TypeScript analogue of the exhaustive Rust `match` at
`:1657`.

**Ship the tokens as content data** — the honest end state. Out of `touches:`; deferred, see above.
