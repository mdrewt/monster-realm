# ADR-0267 — The export reaper's per-tick row cap is named for the READ it bounds: `EXPORT_REAP_MAX_READ_PER_TICK`, no alias (rb-110)

**Status:** Accepted
**Date:** 2026-09-25
**Slice:** rb-110 (residual R-rb-86-READCAP-NAME, promoted from source slice rb-86; M-residual-backlog.spec.md#rb-110)
**Supersedes:** —
**Amends:** —
**Extends:** 0238
**Subsystems:** schema-persistence, tooling-docs
**Decision:** The reaper's 256-row per-tick cap in privacy.rs is renamed `EXPORT_REAP_MAX_READ_PER_TICK` (was `…_DELETE_PER_TICK`), value and consumers unchanged, no alias; tests and ADR-0238/0231/0265 + ARCHITECTURE.md carry the new name.

---

## Context

ADR-0238 (rb-48) shipped the `export_bundle` TTL reaper with one cap, `EXPORT_REAP_MAX_DELETE_PER_TICK = 256`,
and at that point the name was true: the tick planned at most 256 expired chunk ids and deleted exactly those.
rb-85 (ADR-0238 amendment, 2026-09-13) turned the tick into a bounded btree range read whose `.take(...)` is
this constant — the READ window — while the delete set was still the ids inside it, so the two bounds were one
number and the name still held. rb-86 (ADR-0238 amendment, 2026-09-18) split them: a tick now deletes WHOLE
creation stamps, tail rows beyond the window included, and the write side got its own constant,
`EXPORT_REAP_MAX_STAMPS_PER_TICK = 16`. From that day the DELETE-named constant bounded only the read. rb-86
disclosed the misnomer rather than fixing it — the name was pinned by value or by frozen text in roughly ten
`privacy_tests.rs` clauses (`rb48_reap_interval_and_batch_cap_pinned`, the rb-85 take-adjacent and body pins,
`[rb86/cap-wiring]`, the rb-107 derivation and rb-109 execution tests) and quoted in ADR-0238, ADR-0231,
ADR-0265 and ARCHITECTURE.md — and filed residual **R-rb-86-READCAP-NAME**: a crate-visible rename is its own
slice. ADR-0265 (rb-107) then DERIVED a production constant from it (`EXPORT_LIVE_ROW_CAP = 256 × 168`), so the
misnomer had started to propagate into new reasoning: "what the reaper deletes per tick" and "what it reads
per tick" are different numbers, and a constant named for the wrong one invites the wrong derivation.

This slice is that rename. It is a pure line-neutral identifier change plus the test re-freezes and document
retruths the rename forces. **No behaviour, value, schema, reducer roster or client surface changes.**

## Decision

**D1 — The name is `EXPORT_REAP_MAX_READ_PER_TICK`.** The family shape is
`EXPORT_REAP_MAX_<quantity>_PER_TICK`; `READ` is the one-token parallel of `STAMPS` and matches the vocabulary
the code already uses for itself (the helper's comment says "bounds the READ at 256 rows / the WRITE at 16
stamps"; the per-tick observation record is `ExportReapTick { read, planned, reaped }`). It is two characters
shorter than the old name, so the two rustfmt-wrapped sites (`EXPORT_LIVE_ROW_CAP`'s derivation and the
helper's `.take` chain) stay wrapped and `privacy.rs` stays line-count-neutral — the three `docs/knowledge/**`
anchors into this file (`#L1514`, `#L1740`, `#L1827`) and every out-of-file line citation keep resolving.
Rejected spellings: `EXPORT_REAP_MAX_ROWS_READ_PER_TICK` (breaks the one-token parallel with `STAMPS`),
`EXPORT_REAP_READ_WINDOW_ROWS` (drops the `_PER_TICK` family suffix the other two constants carry).

**D2 — No alias, no compatibility constant.** A `pub(crate) const EXPORT_REAP_MAX_DELETE_PER_TICK: usize =
EXPORT_REAP_MAX_READ_PER_TICK;` shim was rejected: it keeps the misnomer reachable for the next derivation,
and it defeats the census that proves the rename complete. `privacy_tests.rs` pins the closed set of
`EXPORT_REAP_MAX_*` declarations in `privacy.rs` as exactly `{READ_PER_TICK, STAMPS_PER_TICK}` and the old
spelling at zero occurrences in both `privacy.rs` and `privacy_tests.rs` (needles assembled from `concat!`
fragments, anti-vacuity on needle length and on the new name being found by the same helper).

**D3 — The documents are retruthed in place; every surviving old-name line is MARKED with the slice that
retired it.** ADR-0238 (five sites — three identifier citations in live text renamed in place, the rb-86
amendment's "name retained; a rename is its own slice" parenthetical replaced by a bracket note recording the
rename, and the one sentence ADR-0238 had itself already declared superseded history left as written with a
same-line bracket note), ADR-0231 (one site, whose surrounding sentence — "so it can cut across one owner's
request" — has been false since rb-86 and is retruthed with it), ADR-0265 (four sites in the derivation) and
ARCHITECTURE.md (the rb-85 and rb-107 slice paragraphs) now spell the new name; the rb-86 paragraph of
ARCHITECTURE.md keeps the old spelling on the line that names `R-rb-86-READCAP-NAME` and this slice, so a
reader who greps for the old name lands on the record of its retirement. A test reads the four documents as
text (`include_str!`, the rb-67/rb-74 idiom) and pins, per file, that the new name occurs at least as often
as the old one did before the rename (a rename, not a deletion); that every line still carrying the old name
also carries `rb-110`, with at least one such line naming the residual; that no token is split across a
comment or line break (the identifier-only count equals the raw count); and that the identifier-free stale
claims ("name retained", "a crate-visible rename is its own slice", "keeps its now-misnamed name") are gone.
A plain occurrence count was rejected as the ratchet: it would have forced ADR-0238's own dated amendment
and ARCHITECTURE.md's rb-110 paragraph to describe a rename without naming what was renamed. This ADR is not
in that census — it is the one place the old spelling is legitimately quoted in full, and the census test
reads it as the independent witness for its needle. Two `privacy_tests.rs` comments that transcribed the
rb-109 criterion verbatim (the spec section and the rb-109 ledger are seed-hashed and keep the old spelling)
now carry the new name and say so; they are paraphrases, not quotations, from this slice on.

**D4 — Comments carry no cross-file meta-claims.** The old doc comment said the name was "pinned in roughly
ten tests and three documents". That sentence class is unclosable (measured across four slices in this
repository: a comment about other files is falsified by any slice that touches them, and nothing in CI can
see it). The replacement comment says what the constant IS and points at this ADR; the archaeology lives in
ARCHITECTURE.md's slice log and here.

## Rejected alternatives

- **Keep the name, keep disclosing.** Rejected because ADR-0265 already derived a second production constant
  from the misnamed one; a name that reads as the write bound is a live hazard for the next derivation, not a
  cosmetic debt.
- **Alias constant / `#[deprecated]` shim.** Rejected (D2).
- **Rename the tests' literals only where compilation forces it** (leave prose and frozen-text pins alone).
  Rejected: the frozen-text pins (`rb85_nd_take`, the squashed and rustfmt-shaped body literals,
  `[rb86/cap-wiring]`'s argument equality) would go red anyway, and a prose mention left behind is exactly
  what the zero-occurrence census exists to forbid.
- **Append-only amendment in ADR-0238, no in-place edits** (ADR-0238's own "superseded sentences are listed,
  not edited" convention). Rejected for the identifier citations in live text: the convention protects
  DECISION text from silent rewriting; an identifier that no longer exists in the crate is a citation, and
  the spec for this slice says "update citations". Honoured for the one sentence the file had already marked
  as superseded history (the rb-85 amendment's "deletes by primary key" sentence): it keeps its wording and
  gains a same-line bracket note. The rb-110 amendment in ADR-0238 lists both sets, so its convention
  statement stays true.
- **`**Amends:** 0238` instead of `**Extends:** 0238`.** Rejected: the digest gate enforces Amends ↔
  Amended-by in both directions, so it would force a header line into ADR-0238 and shift every one of the
  ~40 inbound `0238-…md:<line>` citations by one; `Extends` is enforced only in the reverse direction and
  needs nothing from ADR-0238. The dated amendment in ADR-0238's body is the record; this header field is
  the pointer.

## Consequences

- One production file changes, by identifier only; `privacy.rs` line count and every frozen body are
  otherwise byte-identical modulo the token. `just knowledge-check` is green without regeneration (its three
  anchors sit above the renamed lines; the acceptance ledger's line-count gate owns the region below them).
- Inside `privacy.rs`, the squashed source names the read cap exactly three times, the stamp cap exactly
  twice and the `EXPORT_REAP_MAX_` family exactly five times, so a third family member, an alias of either
  cap or a re-export under the old spelling anywhere in the crate has to move a literal in a reviewed test.
  What the census does NOT see: a differently-prefixed constant defined from the read cap in some other
  module — that is a new derivation, and it is what `EXPORT_LIVE_ROW_CAP`'s own frozen pin is for.
- `docs/adr/DIGEST.md` gains this ADR's rows (`just adr-digest`); no other index changes.
- Two comments outside this slice's touches still spell the old name — `client/src/net/connection.test.ts`
  and `client/src/net/store.test.ts`, both in "why this handler exists" prose that also repeats the
  pre-rb-86 "can cut across one owner's request" claim. Not edited here (hidden dependency under the
  supervised loop; the client tree is a sibling's surface). Residual **R-rb-110-CLIENTCITE**.
- The harness spec section and the rb-109 acceptance ledger quote the old name as part of their frozen
  criterion text; they are seed-hashed and stay as written.

## Confirmation

`server-module/src/privacy_tests.rs`: the four `rb110_` tests — `rb110_read_cap_constant_is_named_for_the_read_and_valued_256`
(value + single squashed declaration), `rb110_the_delete_named_read_cap_is_gone_from_the_crate` (raw,
identifier-only and crate-wide zero-occurrence census; the three exact family counts; every quoted `EXPORT_*`
needle in the test file still exists in production; the residual id gone from production),
`rb110_docs_name_the_read_cap_correctly` (per-file new-name floors, the marker rule, the split-token
cross-check, the stale-claim ban) and `rb110_test_roster_is_closed` — plus the seven re-frozen frozen-text
pins (`rb48 [E1/seam-params]`, `rb85_nd_take`, `rb85_helper_body_pin`, `rb85_helper_body_source`,
`[rb86/cap-wiring]`, `rb107_nd_cap_decl`, `rb107_cap_decl_source`) and ten re-frozen value reads, RED before
the rename (record: harness `memory/projects/gates/rb-110.red-before.md`) and GREEN after with zero further
test edits; `just ci`; acceptance ledger `memory/projects/gates/rb-110.gates.md` (harness).
