# 0057. Content as glob-loaded directories via a `build.rs` embed

**Status:** Accepted
**Date:** 2026-06-28
**Slice:** m8.9e
**Supersedes:** —
**Amends:** —
**Subsystems:** content, tooling-docs
**Decision:** Load content registries from content/<registry>/*.ron directories via a build.rs glob embed; deterministic sorted order enables parallel content-adding slices.


- Status: accepted
- Date: 2026-06-28
- Milestone: M8.9e (server-module modularization — workstream B, content)

> **ADR numbering note.** The M8.9 spec (§1, Appendix) records this decision in the
> **harness corpus** as **ADR-0056** ("content-directory glob loading"). The project-side
> `docs/adr/` numbering has diverged from the corpus (project `0055` = release-fail-loud
> determinism gate, M8.8a; project `0056` is reserved for the sibling slice M8.9a
> "server-module modularization", workstream A). The next-free project number, assigned by
> the supervisor for this slice, is **0057**. This file is the project-side SSOT for the
> decision; the corpus ADR-0056 is its mirror.

## Context and problem statement

The six content registries each live in **one monolithic RON file**
(`game-core/content/{species,skills,items,encounters,zones,type_chart}.ron`), embedded at
compile time via `include_str!` and parsed by pure loaders (`load_species()`, …) under
parse-don't-validate (ADR-0006, content-is-data).

Under the fleet's `touches:`-disjoint parallel-build model (`PLAN.md` §9,
`WORKSPACE-PLAN.md` §7), two slices that both add content to a registry (e.g. M9 training
items + M13 shop items both editing `items.ron`, or two slices adding species) **collide on
the single file** and are forced serial. Content is tiny today (≤ ~2 KB/file) but Phase
B/C is content-heavy — M9 (training items), M10 (fusion recipes), M11 (multi-zone world),
M12 (dialogue/quests), M13 (shop items), M14 (abilities) all append content. The single
file is the bottleneck the content side of M8.9 exists to remove.

The fix must be **behavior-preserving**: the merged registry must be byte-for-byte the same
set of rows in the same order, content does not touch `module_bindings` or the schema
snapshot (those derive from `server-module` tables/reducers, not data), and the pure
determinism-critical core must stay free of runtime I/O and wall-clock/RNG.

## Considered alternatives

- **(a) `build.rs` codegen that emits per-registry `include_str!` lists** — chosen (below).
- **(b) The `include_dir` crate** — rejected: it adds a **runtime dependency** to
  `game-core`, the crate the determinism gate keeps lean and that compiles into both the
  STDB module and the client-prediction wasm. A host build-script that emits `include_str!`
  gives the same compile-time embed with **zero** dependency in the dependency-graph of the
  shipped artifact.
- **(c) A `glob` build-dependency** — rejected as unnecessary: `std::fs::read_dir` +
  filter-by-extension + sort is ~20 lines and needs **no** new crate at all (build-dep
  included). YAGNI / minimize the dependency surface (AGENTS.md golden rule #4 weighs every
  dep). Recorded as the cheapest mechanism that satisfies the requirement.
- **(d) Defer to M11** (keep single files until the authored world explodes) — rejected:
  M9/M10 add content **imminently**; doing the layout change before the Phase-B content
  explosion avoids a larger migration later, and the change is small and provably lossless
  now.

## Decision outcome

**Chosen: (a) a `game-core/build.rs` that globs `content/<registry>/*.ron` in sorted
filename order and emits a per-registry `&[(&str, &str)]` of `(filename, include_str!(…))`
parts; the loaders concatenate the parsed `Vec`s.** No runtime dependency, no build-dep —
`std::fs` only.

### 1. The `build.rs` embed (host build-time, deterministic)

`build.rs` runs on the **host** at compile time (never in the shipped wasm), so reading the
`content/` tree is not runtime I/O — the embedded strings become `&'static str` via
`include_str!`, exactly as the monolithic `const … = include_str!(…)` did before. For each
**glob-loaded** registry (`zones`, `species`, `skills`, `items`, `encounters`) it:

- reads `content/<registry>/`, keeps entries whose extension is `ron`, **sorts by file
  name** (byte-ordered → deterministic, machine-independent), and
- generates `static <REGISTRY>_RON_PARTS: &[(&str, &str)] = &[("000-core.ron",
  include_str!("<abs>/content/<registry>/000-core.ron")), …];` into `OUT_DIR`, included by
  `content.rs`. Absolute paths (via `CARGO_MANIFEST_DIR`) are required because `include_str!`
  in the generated file resolves relative to `OUT_DIR`, not the crate root.
- emits `cargo:rerun-if-changed` for each registry directory **and** each `.ron` file, so
  adding/removing/editing a content file re-triggers the embed.

`type_chart` is **not** migrated — it is one coherent effectiveness matrix, rarely appended
in parallel, so it stays a single `include_str!("../content/type_chart.ron")` in
`content.rs` (the spec sanctions this). The `build.rs` only manages the five directory
registries.

### 2. Loaders concatenate parsed `Vec`s — loud per-file rejection

Each loader parses **each part** and concatenates the resulting `Vec`s in sorted order:

```rust
fn parse_species_parts(parts: &[(&str, &str)]) -> Result<Vec<Species>, String> {
    let mut all = Vec::new();
    for (file, src) in parts {
        let rows = ron::from_str::<Vec<Species>>(src)
            .map_err(|e| format!("species registry parse error in {file}: {e}"))?;
        all.extend(rows);
    }
    Ok(all)
}
```

A malformed file is **rejected loudly** — the loader returns `Err` naming the offending
file and never silently skips it (the anti-pattern the proof-of-teeth guards). The existing
single-string `parse_species(&str)` etc. are retained for fixture tests. `validate_content`
runs unchanged on the merged rows (parse-don't-validate boundary preserved).

### 3. The fan-out property

After this, **adding a content file is a new `content/<registry>/NNN-*.ron` and nothing
else** — no `content.rs` edit, no loader edit, no `build.rs` edit (the glob picks it up).
`touches: …/species.ron` becomes `touches: …/species/<new>.ron`, so two content-adding
slices become `touches:`-disjoint and fan out. The same glob update is applied to the
`append-only-ids` eval (it now reads the registry **directory**, concatenating its `*.ron`
files in sorted order before extracting ids) so a new file in a registry dir is covered
without an eval edit either.

### 4. Migration: byte-identical rows

Each registry file moves into its directory unchanged: `species.ron → species/000-core.ron`
(byte-for-byte, comments included), likewise `skills`, `items`, `encounters`, `zones`. The
`000-` prefix sorts first and leaves room to append `001-`, `010-`, … The merged registry
is therefore **row-identical and order-stable** vs. pre-migration — proven by the
content-parity proof-of-teeth below; every `id` is preserved (the `append-only-ids` eval
enforces it cross-version).

> **Foot-gun — zero-pad the numeric prefix to a consistent width.** The embed sorts files
> **lexicographically** (byte order), in both `build.rs` and the `append-only-ids` eval, so
> `10-foo.ron` sorts **before** `9-foo.ron`. Always pad to the same width (`009-`, `010-`).
> Cross-file *row order* does not affect game behavior — every registry is keyed by `id` /
> `zone_id`, never by position, and `validate_content` enforces id-uniqueness across the
> merged Vec regardless of order — so this only matters for keeping `000-core.ron` the
> stable first ("core") part; the convention is documented, not mechanically enforced
> (a build-time prefix-format check was judged YAGNI vs. the convention + this note).

### 5. Determinism, schema, bindings — all unchanged

Sorted filename order makes the embed deterministic; the loaders stay pure (compile-time
embed + pure parse, no runtime I/O / clock / RNG), so the determinism gate is unaffected.
Content is **data, not schema** — no `#[table]`/`#[reducer]` changes — so `module_bindings`
and the schema snapshot are byte-identical (this slice touches neither; that is the
behavior-preservation gate, alongside content-parity).

## Proof-of-teeth (gating tests, authored by the `tester` from the EARS criteria)

- **Merge correctness (fan-out).** `parse_*_parts` over synthetic multi-file fixtures
  equals the concatenation of each part parsed alone, **in sorted-filename order** — a
  durable property (survives content growth), independent of the live content.
- **Migration parity.** The live merged loader (`load_species()`, …) reproduces the
  **pre-migration rows in the same order** — the migrated `000-core.ron` rows are an
  unchanged prefix of the merged registry (append-only; future files append, never alter
  the migrated core). This is the row-identical migration gate.
- **Malformed file ⇒ loud `Err`.** A deliberately malformed `*.ron` part in a (fixture)
  registry directory makes the merged parse return `Err` **naming the file** — never a
  silent skip. Kills a loader that drops unparseable files.
- **`append-only-ids` unchanged + `validate_content` green** over the embedded, now-merged
  content.

## Consequences

- **Positive:** content-adding slices become `touches:`-disjoint and parallelizable;
  adding content is a one-file change with no code edit; zero new dependency (build-dep or
  runtime) on the lean core; behavior provably unchanged (content-parity + untouched
  bindings/schema). Sorted-glob keeps the embed deterministic.
- **Negative / accepted:** a `build.rs` adds a small host build step and embeds absolute
  paths into generated code (local-build artifact in `OUT_DIR`; the embedded *bytes* are
  deterministic, only the path string is machine-local — irrelevant to output). A second
  content file per registry is now possible, so authors must keep ids globally unique within
  a registry across files (already enforced by `validate_content` + `append-only-ids`).
- **Grain:** per-**registry** directories now (the simplest fan-out win); per-**zone**
  grouping (`content/zones/<zone>/{species,encounters}.ron`) is revisited at M11 when
  multiple zones are authored. `type_chart` stays a single file.
- **References:** ADR-0006 (additive schema / content-is-data — the invariant this upholds),
  harness ADR-0056 (corpus mirror), ADR-0055 server-module modularization / M8.9a (sibling
  workstream A); the `append-only-ids` eval (id-stability gate) and `validate_content`
  (parse-don't-validate boundary) are the existing gates this preserves.
