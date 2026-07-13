# 0044. Encounter table: private with no projection

**Status:** Accepted
**Date:** 2026-06-26
**Slice:** m8b
**Supersedes:** —
**Amends:** —
**Subsystems:** security-authz, content
**Decision:** Keep the encounter table private with no public projection to prevent clients from reading spawn weights, level bands, or zone encounter rates.

- Status: accepted
- Date: 2026-06-26

## Context and problem statement

Encounter spawn data (weights, level bands, zone encounter rates) is a cheat
surface — exposing it would allow clients to predict spawn chances and adjust
strategy unfairly. The taming subsystem (M8a) defines the pure rules; M8b must
seed the encounter registry into the server's persistent tables in a way that
guarantees clients cannot read this data.

ADR-0040 established two visibility modes for content tables:
1. Private table + public projection (for data that has both secret and public facets)
2. Private-only table (for data with no legitimate client reads)

Encounters require mode 2: clients have zero need to read encounter spawn weights,
only the server needs them (to resolve triggers and rolls server-side). Unlike the
`monster` table (which has both hidden genes and public stats), encounters have no
projection — they are purely server-side.

## Considered alternatives

- Option A — Row-per-entry with denormalized encounter_rate: each zone's
  encounter_rate repeated on every entry row. Rejected: denormalization
  consistency risk (a zone's rate could diverge across rows if a writer fails
  mid-sync); encourages auto-increment id + clear-and-reinsert pattern (id
  bloat on every content sync). Chose the bulk-upsert single zone row instead.

- Option B — Derive `SpacetimeType` on the `Level` newtype to avoid flattening.
  Rejected: `Level` is a parse-don't-validate newtype with custom `Deserialize`
  and invalid constructors blocked — deriving `SpacetimeType` would bypass the
  invariant checks in codegen. The SpacetimeDB codec is an unsafe boundary that
  cannot be trusted with a validated type. Flatten the newtype at the table
  boundary to preserve the validation contract.

- Option C — Store entries as a RON-encoded blob. Rejected: opaque to the server
  and SQL (no ability to query/index entries later if M8c/M8d need to validate
  per-entry cross-refs), and bleeds Rust-specific serialization into the schema.

- Chosen: Option C from ADR-0040 — a **private** `encounter` table (no `public`
  attribute, no projection), keyed by `zone_id` (pk), with one `encounter_rate`
  per zone and a `Vec<EncounterEntryRow>` (flattened-at-boundary with `Level`
  newtype serialized as `u8`). Seed via validate-before-write upsert-by-zone_id.

## Decision outcome

- Chosen: private encounter table (no projection), because the data has no
  legitimate client read (only server triggers), the privacy guarantee is
  absolute (no codegen accessor, no subscription path), and the validation
  contract (parse-don't-validate `Level`) is preserved by flattening at the
  boundary.

- Table structure:
  - **`encounter`** (private, keyed by `zone_id`):
    - `zone_id: u32` — primary key, matches zone_id in `zone_def`.
    - `encounter_rate: u16` — per-mille (0–1000), stored once per zone, not
      denormalized per entry.
    - `entries: Vec<EncounterEntryRow>` — serialized vector of encounter options
      for the zone.
    - **`EncounterEntryRow`** (flattened-at-boundary):
      - `species_id: u32` — references species registry (matches the `species_id`
        width across `EncounterEntryRow`, the species registry, and the other
        species-bearing tables; corrected from `u16` in M8.7d — the code has always
        been `u32`).
      - `weight: u16` — probability weight (arbitrary units, summed during
        weighted selection).
      - `min_level: u8` — `Level` newtype serialized as `u8`; validated at
        deserialization (1–100 checked by `Level::new`).
      - `max_level: u8` — `Level` newtype serialized as `u8`; validated at
        deserialization.

- Seeding (`sync_content_inner`):
  - Parse `encounters.ron` via `load_encounters()` (pure, reuses M8a loaders).
  - Validate via `validate_encounters()` (M8a rules: unique zones, zone exists,
    rate ≤ 1000, weight > 0, min ≤ max level, species exists).
  - Upsert by `zone_id`: one reducer call per zone, idempotent, no auto_inc id
    or clear-and-reinsert churn.
  - Seeding validation catches (B1 hardening):
    - Empty `entries` vector rejected.
    - Duplicate `species_id` within a zone rejected.

- Consequences:
  - **Positive:** Encounter spawn data never reaches a client at the transport
    level (not just filtered in UI). The `encounter-privacy` eval (6 teeth)
    mechanically enforces the invariant: private table declaration, no projection
    leak, no RLS bypass, no generated accessor.
  
  - **Negative (accepted residuals):**
    (a) **Schema shape in codegen:** `spacetime generate` emits the structural
        type (`EncounterRow`/`EncounterEntryRow` field shapes) into
        `client/src/module_bindings/types.ts` even though the table is private
        — this is *schema shape metadata, not row data*. No table accessor and
        no subscription path exist (identical behavior to the private `monster`
        table). The cheat-surface values (per-zone weights/rates) never reach a
        client.
    
    (b) **Stale-zone rows:** A zone removed from `encounters.ron` leaves its
        `encounter` row until overwritten — same gap as every other content
        table (species/skills/items). Acceptable parity; noted for an operator
        wipe-reseed if ever needed.
    
    (c) **Partial-sync window:** `sync_content_inner` validates and writes each
        registry independently and returns `()` without rollback. If encounter
        validation fails after species already wrote (rare), the encounter table
        keeps prior rows. This is pre-existing cross-registry pattern; M8c's
        grass trigger must tolerate this (validate cross-refs at trigger time or
        rely on the next successful sync). Logged for visibility.
    
    (d) **Eval coverage edge case:** The regex-based `encounter-privacy` eval is
        blind to a `cfg_attr`-wrapped or runtime-renamed-table leak. The
        `bindings-drift` eval (proof-of-teeth: flags any `*_table.ts` accessor
        in committed bindings) is the defense-in-depth backstop — a public
        encounter would generate an accessor and drift the snapshot.

- **Follow-ups:** M8c (grass movement trigger on tile-change, wild encounter
  spawn + start_battle call), M8d (attempt_recruit, client battle-view + wild
  monster individuality storage, inventory/bait tracking).
