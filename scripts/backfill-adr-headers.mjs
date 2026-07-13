#!/usr/bin/env node
// scripts/backfill-adr-headers.mjs — one-shot script for the m-infra-d2 slice.
// Inserts the canonical header block into each legacy ADR that lacks it.
// Run from the repo root: node scripts/backfill-adr-headers.mjs
// After running: node scripts/adr-digest.mjs (to regenerate DIGEST.md)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADR_DIR = join(__dirname, '..', 'docs', 'adr');

// ---------------------------------------------------------------------------
// Canonical header data for all 69 legacy ADRs.
// Fields: id, status, date, slice, supersedes, amends, subsystems, decision,
// supersededBy (optional), amendedBy (optional).
// Decision: single sentence, ≤240 chars.
// ---------------------------------------------------------------------------
const HEADERS = [
  {
    id: '0001',
    status: 'Accepted',
    date: '2026-06-23',
    slice: 'm0',
    supersedes: '—',
    amends: '—',
    subsystems: 'tooling-docs',
    decision:
      'Use MADR-format ADRs in docs/adr/, authored by the doc-keeper, as the durable rationale record for non-obvious architectural choices.',
  },
  {
    id: '0035',
    status: 'Accepted',
    date: '2026-06-25',
    slice: 'm0',
    supersedes: '—',
    amends: '—',
    subsystems: 'tooling-docs, ci-gates',
    decision:
      'Harden check-secrets.mjs to skip dangling symlinks and adopt the SpacetimeDB-stack .gitignore so just ci is green from the scaffold baseline.',
  },
  {
    id: '0036',
    status: 'Accepted',
    date: '2026-06-25',
    slice: 'm3',
    supersedes: '—',
    amends: '—',
    subsystems: 'client-ui, tooling-docs',
    decision:
      'Use wasm-bindgen + wasm-pack to compile game-core to wasm for the client-side prediction boundary, with serde-wasm-bindgen for JS interop.',
  },
  {
    id: '0037',
    status: 'Accepted',
    date: '2026-06-25',
    slice: 'm0b',
    supersedes: '—',
    amends: '—',
    subsystems: 'schema-persistence, content',
    decision:
      'Pin SpacetimeDB module SDK + RON (serde-ron) as the server/content dependencies; sync_content reducer updates content without table deletion.',
    amendedBy: 'ADR-0073',
  },
  {
    id: '0038',
    status: 'Accepted',
    date: '2026-06-25',
    slice: 'm1',
    supersedes: '—',
    amends: '—',
    subsystems: 'ci-gates, tooling-docs',
    decision:
      'Use proptest with seeded strategies for property-testing game-core invariants (totality, determinism, behavioral correctness) across randomized inputs.',
  },
  {
    id: '0039',
    status: 'Accepted',
    date: '2026-06-26',
    slice: 'm5b',
    supersedes: '—',
    amends: '—',
    subsystems: 'ci-gates, movement-netcode',
    decision:
      'Run two-window Playwright e2e in CI against a pinned standalone spacetime binary, with a proof-of-teeth fixture that rejects a synthetic desync.',
  },
  {
    id: '0040',
    status: 'Accepted',
    date: '2026-06-26',
    slice: 'm6b',
    supersedes: '—',
    amends: '—',
    subsystems: 'security-authz, schema-persistence',
    decision:
      'Use private monster table + public monster_pub projection as the RLS fallback: IV genes stay hidden from clients; derived stats are world-readable.',
  },
  {
    id: '0041',
    status: 'Accepted',
    date: '2026-06-26',
    slice: 'm7a',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle',
    decision:
      'Integer-only damage formula with u64 intermediates, STAB, type effectiveness, and a seeded ±15% variance roll for cross-platform determinism.',
    amendedBy: 'ADR-0092',
  },
  {
    id: '0042',
    status: 'Accepted',
    date: '2026-06-26',
    slice: 'm7b',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, security-authz',
    decision:
      'Battle table is public for PvE scope; derived stats are acceptable to expose for NPC opponents; revisit per-side privacy when PvP ships in M16.',
  },
  {
    id: '0043',
    status: 'Accepted',
    date: '2026-06-26',
    slice: 'm-infra-a',
    supersedes: '—',
    amends: '—',
    subsystems: 'ci-gates, tooling-docs',
    decision:
      'Add sccache + Swatinem/rust-cache for warm CI builds, cargo-nextest for parallelism; isolate a fast per-PR loop from slow nightly-only gates.',
  },
  {
    id: '0044',
    status: 'Accepted',
    date: '2026-06-26',
    slice: 'm8b',
    supersedes: '—',
    amends: '—',
    subsystems: 'security-authz, content',
    decision:
      'Keep the encounter table private with no public projection to prevent clients from reading spawn weights, level bands, or zone encounter rates.',
  },
  {
    id: '0045',
    status: 'Accepted',
    date: '2026-06-27',
    slice: 'm8c',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, security-authz',
    decision:
      'Store wild individuality (seed, species, level) in a private battle_wild side-table keyed by battle_id, not as columns on the public battle row.',
  },
  {
    id: '0046',
    status: 'Accepted',
    date: '2026-06-27',
    slice: 'm8d',
    supersedes: '—',
    amends: '—',
    subsystems: 'economy-quests, schema-persistence',
    decision:
      'Player inventory is a public owner-scoped stack table; bait item-type is classified by data (recruit_bonus > 0), not by a separate enum variant.',
  },
  {
    id: '0047',
    status: 'Accepted',
    date: '2026-06-27',
    slice: 'm8d',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, economy-quests',
    decision:
      'Recruit success reuses the SideAWins terminal, grants the caught monster at full HP with no XP, and garbage-collects the battle_wild row.',
  },
  {
    id: '0048',
    status: 'Accepted',
    date: '2026-06-27',
    slice: 'm8.5a',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, security-authz',
    decision:
      'start_battle validates opponent provenance server-side (self or WILD_IDENTITY only) and rejects—never clamps—any authorization violation.',
  },
  {
    id: '0049',
    status: 'Accepted',
    date: '2026-06-27',
    slice: 'm8.5b',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, ci-gates',
    decision:
      'Use panic!/unreachable! on content-invariant violations in the pure core and debug_assert for development-time contracts with runtime overhead.',
    amendedBy: 'ADR-0091',
  },
  {
    id: '0050',
    status: 'Accepted',
    date: '2026-06-27',
    slice: 'm8.5c',
    supersedes: '—',
    amends: '—',
    subsystems: 'ci-gates',
    decision:
      'Run mutation and coverage gates nightly (not per-PR); include bindings-drift check in the fast per-PR ci job to catch schema/code divergence early.',
  },
  {
    id: '0051',
    status: 'Accepted',
    date: '2026-06-27',
    slice: 'm8.5d',
    supersedes: '—',
    amends: '—',
    subsystems: 'tooling-docs, ci-gates',
    decision:
      'Use Biome for TS/JS lint+format, scoped to client/src with defined exclusions for generated code; disable noNonNullAssertion only in test files.',
  },
  {
    id: '0052',
    status: 'Accepted',
    date: '2026-06-27',
    slice: 'm8.5f',
    supersedes: '—',
    amends: '—',
    subsystems: 'movement-netcode, client-ui',
    decision:
      'Bound client-side move prediction to the server MOVE_QUEUE_CAP; reject over-cap enqueues rather than allowing over-prediction rubber-band.',
  },
  {
    id: '0053',
    status: 'Accepted',
    date: '2026-06-27',
    slice: 'm8.6a',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, ci-gates',
    decision:
      'Enforce swap legality as a pure-core invariant via BattleSide::set_active; server returns a typed SwapError and never clamps to a valid slot.',
    amendedBy: 'ADR-0091',
  },
  {
    id: '0054',
    status: 'Accepted',
    date: '2026-06-27',
    slice: 'm8.7b',
    supersedes: '—',
    amends: '—',
    subsystems: 'security-authz, ci-gates',
    decision:
      'Gate dev/test reducers behind #[cfg(feature="dev_reducers")] so they compile-exclude from release/bench wasm; zone movement uses reject-not-clamp.',
  },
  {
    id: '0055',
    status: 'Accepted',
    date: '2026-06-28',
    slice: 'm8.8a',
    supersedes: '—',
    amends: '—',
    subsystems: 'ci-gates',
    decision:
      'Enable release/bench overflow-checks=true and expand clippy bans to OS-entropy sinks (getrandom, chrono, OsRng, ThreadRng) for fail-loud determinism.',
  },
  {
    id: '0056',
    status: 'Accepted',
    date: '2026-06-28',
    slice: 'm8.9a',
    supersedes: '—',
    amends: '—',
    subsystems: 'tooling-docs, schema-persistence',
    decision:
      'Split server-module/src/lib.rs into 8 domain submodules with a canonical touches: vocabulary for the build loop; spike proved per-module table/reducer registration.',
  },
  {
    id: '0057',
    status: 'Accepted',
    date: '2026-06-28',
    slice: 'm8.9e',
    supersedes: '—',
    amends: '—',
    subsystems: 'content, tooling-docs',
    decision:
      'Load content registries from content/<registry>/*.ron directories via a build.rs glob embed; deterministic sorted order enables parallel content-adding slices.',
  },
  {
    id: '0058',
    status: 'Accepted',
    date: '2026-06-28',
    slice: 'm9a',
    supersedes: '—',
    amends: '—',
    subsystems: 'evolution-fusion, content',
    decision:
      'Pure focus_train and apply_care functions in game-core: EV top-off with 510-total/252-stat caps and reject-not-clamp on maxed; bond uses saturating_add.',
  },
  {
    id: '0059',
    status: 'Accepted',
    date: '2026-06-28',
    slice: 'm9b',
    supersedes: '—',
    amends: '—',
    subsystems: 'evolution-fusion, schema-persistence',
    decision:
      'M9b server raising: care reducer with per-monster timestamp cooldown in a private table; reuse player inventory as the item backbone; train split from care.',
  },
  {
    id: '0060',
    status: 'Accepted',
    date: '2026-06-28',
    slice: 'm10a',
    supersedes: '—',
    amends: '—',
    subsystems: 'evolution-fusion, content',
    decision:
      'Store evolution/fusion rules in a separate cross-referenced RON registry; additive validate_evolution_fusion (7 integrity rules) runs at sync_content time.',
  },
  {
    id: '0061',
    status: 'Accepted',
    date: '2026-06-28',
    slice: 'm10a',
    supersedes: '—',
    amends: '—',
    subsystems: 'evolution-fusion',
    decision:
      'Pure individuality-preserving evolution and fusion transforms in game-core/src/evolution/; resolve_evolution with first-match dispatch; fuse via per-stat-max IVs.',
  },
  {
    id: '0062',
    status: 'Accepted',
    date: '2026-07-02',
    slice: 'm10b',
    supersedes: '—',
    amends: '—',
    subsystems: 'evolution-fusion, ci-gates',
    decision:
      'Evolution and fusion reducers apply pure game-core transforms with guard ordering (owner→not-in-battle→content/eligibility) and growth-writer registration.',
  },
  {
    id: '0063',
    status: 'Accepted',
    date: '2026-07-02',
    slice: 'm10c',
    supersedes: '—',
    amends: '—',
    subsystems: 'client-ui, evolution-fusion',
    decision:
      'Evolution/fusion client overlay uses KeyE, a pure EvolutionView view-model seam, and fusion recipe display; overlay mutual exclusion with other overlays.',
  },
  {
    id: '0064',
    status: 'Accepted',
    date: '2026-07-02',
    slice: 'm10d',
    supersedes: '—',
    amends: '—',
    subsystems: 'evolution-fusion, ci-gates',
    decision:
      'Add evolution/fusion content-integrity eval (5 rules at dev time) and reducer-security eval (9 structural invariants), both with proof-of-teeth fixtures.',
  },
  {
    id: '0065',
    status: 'Accepted',
    date: '2026-07-02',
    slice: 'm11a',
    supersedes: '—',
    amends: '—',
    subsystems: 'movement-netcode, content',
    decision:
      'Warps live as an overlay list on TileMap content (not a tile glyph or side-table); zone data in content.rs, warp rules in world.rs; std-only Tiled importer.',
  },
  {
    id: '0066',
    status: 'Accepted',
    date: '2026-07-02',
    slice: 'm11b',
    supersedes: '—',
    amends: '—',
    subsystems: 'movement-netcode, schema-persistence',
    decision:
      'Server-authoritative warp runtime uses in-tick warp detection (map_for + warp_at), idempotent per-zone schedule initialization, and content-validated zone maps.',
  },
  {
    id: '0067',
    status: 'Accepted',
    date: '2026-07-02',
    slice: 'm11c',
    supersedes: '—',
    amends: '—',
    subsystems: 'client-ui, movement-netcode',
    decision:
      'Client detects zone warps via global character subscription onDelete/onInsert; follow-camera tracks own character; zone switch triggers predictor reset.',
  },
  {
    id: '0068',
    status: 'Accepted',
    date: '2026-07-02',
    slice: 'm12a',
    supersedes: '—',
    amends: '—',
    subsystems: 'economy-quests, content',
    decision:
      'NPC wander rule, dialogue tree model + evaluation, and quest/flag advance rules are pure game-core; NPC hash is non-commutative; Condition enum is the SSOT.',
    amendedBy: 'ADR-0091',
  },
  {
    id: '0069',
    status: 'Accepted',
    date: '2026-07-02',
    slice: 'm12b',
    supersedes: '—',
    amends: '—',
    subsystems: 'economy-quests, schema-persistence',
    decision:
      'NPC entity loop, talk/advance_dialogue/dismiss_dialogue/heal_party reducers, and six new tables (npc, dialogue state, quest, conversation, heal) in server-module.',
    amendedBy: 'ADR-0087',
  },
  {
    id: '0070',
    status: 'Accepted',
    date: '2026-07-03',
    slice: 'm12c',
    supersedes: '—',
    amends: '—',
    subsystems: 'economy-quests, content',
    decision:
      'RON content loading for NPC/dialogue/quest/heal; validate_npc_content 12-point check; NPCs skip warps; RT-ADV-01 fix adds proximity recheck in advance_dialogue.',
  },
  {
    id: '0071',
    status: 'Accepted',
    date: '2026-07-03',
    slice: 'm12d',
    supersedes: '—',
    amends: '—',
    subsystems: 'client-ui, economy-quests',
    decision:
      'Client dialogue/quest/heal UI uses a static bundle, pure models, dismissal gating via keyboard/overlay mutex, and promise-rejection feedback for reducer errors.',
  },
  {
    id: '0072',
    status: 'Accepted',
    date: '2026-07-03',
    slice: 'm12.5a',
    supersedes: '—',
    amends: '—',
    subsystems: 'evolution-fusion, ci-gates',
    decision:
      'Fix fuse offspring dual-write ordering: capture the insert return value and build MonsterPub from the inserted row, preventing monster ID mismatches.',
  },
  {
    id: '0073',
    status: 'Accepted',
    date: '2026-07-03',
    slice: 'm12.5b',
    supersedes: '—',
    amends: 'ADR-0037',
    subsystems: 'content, schema-persistence',
    decision:
      'Repair sync_content: use ctx.identity() for owner check; load-then-validate-then-write atomically; re-derive all monster evolves_to on CONTENT_VERSION bump.',
  },
  {
    id: '0074',
    status: 'Accepted',
    date: '2026-07-03',
    slice: 'm12.5c',
    supersedes: '—',
    amends: '—',
    subsystems: 'client-ui, movement-netcode',
    decision:
      'Client zone-sync is state-based (not edge-triggered); switchZone is renderer-first atomic; rAF loop is self-contained with try/catch and always re-arms.',
  },
  {
    id: '0075',
    status: 'Accepted',
    date: '2026-07-03',
    slice: 'm12.5d',
    supersedes: '—',
    amends: '—',
    subsystems: 'client-ui, movement-netcode',
    decision:
      'Fix five netcode feel bugs: reduce INTERP_DELAY_STEPS to 1.0, add tile-center camera, snap-on-teleport on zone warp, and isolate the rAF frame-drain timer.',
    amendedBy: 'ADR-0090',
  },
  {
    id: '0076',
    status: 'Accepted',
    date: '2026-07-03',
    slice: 'm12.5f',
    supersedes: '—',
    amends: '—',
    subsystems: 'ci-gates, tooling-docs',
    decision:
      'Add proof-of-teeth fixtures for the sim-harness, a SpacetimeType snapshot eval, and an expired-fixme guard; sim-harness loads real content and resolves warps.',
  },
  {
    id: '0077',
    status: 'Accepted',
    date: '2026-07-03',
    slice: 'm12.5e',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, schema-persistence',
    decision:
      'Battle terminal GC keeps latest terminal per player; XP loop log-and-continues on corrupt rows; canonical skill order follows species.learnable_skill_ids.',
  },
  {
    id: '0078',
    status: 'Accepted',
    date: '2026-07-03',
    slice: 'm12.5e2',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, economy-quests',
    decision:
      'Practice battles (self vs self) award XP at 0.1× multiplier to incentivize real wild/PvP battles; the multiplier applies before the base formula floor.',
  },
  {
    id: '0079',
    status: 'Accepted',
    date: '2026-07-03',
    slice: 'm12.5b6',
    supersedes: '—',
    amends: '—',
    subsystems: 'ci-gates, schema-persistence',
    decision:
      'Nightly smoke test republishes the module without --delete-data, calls sync_content, and asserts that player rows survive and CONTENT_VERSION increments.',
  },
  {
    id: '0080',
    status: 'Accepted',
    date: '2026-07-04',
    slice: 'm8.95d',
    supersedes: '—',
    amends: '—',
    subsystems: 'tooling-docs, ci-gates',
    decision:
      'Generate an OKF-conformant knowledge bundle (docs/knowledge/**) from SpacetimeDB schema metadata via okf-export.mjs; gate its drift in CI.',
  },
  {
    id: '0081',
    status: 'Accepted',
    date: '2026-07-04',
    slice: 'm13a',
    supersedes: '—',
    amends: '—',
    subsystems: 'economy-quests, schema-persistence',
    decision:
      'Currency primitive: private player_wallet table (u64 balance, MAX=999_999_999) with apply_grant/spend_currency helpers as the single mutation surface.',
  },
  {
    id: '0082',
    status: 'Accepted',
    date: '2026-07-04',
    slice: 'm13b',
    supersedes: '—',
    amends: '—',
    subsystems: 'economy-quests, content',
    decision:
      'Add shop content (ShopDef RON registry, sell_price on ItemDef) and buy/sell reducers that use server-computed prices and route through apply_grant/spend_currency.',
  },
  {
    id: '0083',
    status: 'Accepted',
    date: '2026-07-04',
    slice: 'm13c',
    supersedes: '—',
    amends: '—',
    subsystems: 'economy-quests',
    decision:
      'Economy sinks (heal_party costs HealLocationDef.cost_currency) and sources (quest reward, battle reward on loser BST/divisor) all routed through apply_grant/spend.',
  },
  {
    id: '0084',
    status: 'Accepted',
    date: '2026-07-04',
    slice: 'm13d',
    supersedes: '—',
    amends: '—',
    subsystems: 'client-ui, economy-quests',
    decision:
      'Shop client view uses pure shopModel subscription with KeyG toggle, sell eligibility by data (sellPrice > 0), double-spend lock, and reducer rejection feedback.',
  },
  {
    id: '0085',
    status: 'Accepted',
    date: '2026-07-05',
    slice: 'm13.5b',
    supersedes: '—',
    amends: '—',
    subsystems: 'movement-netcode, client-ui',
    decision:
      'Reducer rejections surface as UI feedback; enqueue_move drops rejected seq and forces reconcile; app-level reconnect uses exponential backoff capped at 30s.',
  },
  {
    id: '0086',
    status: 'Accepted',
    date: '2026-07-04',
    slice: 'm13.5h',
    supersedes: '—',
    amends: '—',
    subsystems: 'ci-gates',
    decision:
      'CI e2e pre-builds dev_reducers wasm via --bin-path and publishes it; recruit e2e tests R1–R4 are revived using gameplay flows without dev-reducer calls.',
  },
  {
    id: '0087',
    status: 'Accepted',
    date: '2026-07-05',
    slice: 'm13.5c',
    supersedes: '—',
    amends: 'ADR-0069',
    subsystems: 'security-authz, schema-persistence',
    decision:
      'Scope player_conversation to owner-only via #[view]; onInsert+onDelete delivery model removes the inference channel into private dialogue-state flags.',
  },
  {
    id: '0088',
    status: 'Accepted',
    date: '2026-07-10',
    slice: 'fix-nightly-mutants',
    supersedes: '—',
    amends: '—',
    subsystems: 'ci-gates',
    decision:
      'Repair nightly mutate-core gate: kill 37 missed mutants with tests, exempt one proven-equivalent mutant, and add timeout tolerance via wrap-recipe exit-3 check.',
  },
  {
    id: '0089',
    status: 'Accepted',
    date: '2026-07-10',
    slice: 'm13.5d',
    supersedes: '—',
    amends: '—',
    subsystems: 'content, tooling-docs',
    decision:
      'Cache RON content parse results using LazyLock<Result<...>> statics in content_cache.rs; all hot-path callers switch to cached_skills/items/evolutions/etc.',
  },
  {
    id: '0090',
    status: 'Accepted',
    date: '2026-07-10',
    slice: 'm13.5e',
    supersedes: 'ADR-0075 §12.5d-1',
    amends: '—',
    subsystems: 'client-ui, movement-netcode',
    decision:
      'Replace fixed interpolation delay with an adaptive EWMA jitter estimator per character and variable snapshot depth (max 4) to handle burst delivery without pops.',
  },
  {
    id: '0091',
    status: 'Accepted',
    date: '2026-07-10',
    slice: 'm13.5f',
    supersedes: '—',
    amends: 'ADR-0068, ADR-0049, ADR-0053',
    subsystems: 'security-authz, ci-gates',
    decision:
      'Harden five latent gaps: GrantItem once-only gate, quest-flag exhaustive match, dir/action fail-loud decode, pure check_party_slot, and marshal double-validate.',
  },
  {
    id: '0092',
    status: 'Accepted',
    date: '2026-07-10',
    slice: 'm14a',
    supersedes: '—',
    amends: 'ADR-0017, ADR-0023, ADR-0041',
    subsystems: 'battle',
    decision:
      'StatusEffect enum, separate StatusVariance struct, resolve_full_turn wrapping resolve_turn + apply_post_turn_effects, SideA-first DoT KO tiebreak; pure game-core.',
    amendedBy: 'ADR-0098',
  },
  {
    id: '0093',
    status: 'Accepted',
    date: '2026-07-10',
    slice: 'm14b',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, schema-persistence',
    decision:
      'StatusEffect persists via SpacetimeType in BattleMonster.status (additive field, serde default); StatusVariance from ctx.timestamp_us; submit_attack calls resolve_full_turn.',
  },
  {
    id: '0094',
    status: 'Accepted',
    date: '2026-07-10',
    slice: 'm14c',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, content',
    decision:
      'Passive per-species abilities (StatusImmunity, EntryHeal) stored in content; applied via AbilityStore threaded through resolve_full_turn and entry hooks; OCP-gated.',
  },
  {
    id: '0095',
    status: 'Accepted',
    date: '2026-07-10',
    slice: 'm14d',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle',
    decision:
      'Single active weather (WeatherKind exhaustive enum) with chip damage at Phase 3.5; sets_weather loaded from cached SkillDef; weather ticks in run_post_turn_phases.',
  },
  {
    id: '0096',
    status: 'Accepted',
    date: '2026-07-11',
    slice: 'm14e',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, client-ui',
    decision:
      'Status-curing items: applies_status on SkillDef, cure_status on ItemDef, use_battle_item reducer with 6-guard validation; client renders active monster status badge.',
  },
  {
    id: '0097',
    status: 'Accepted',
    date: '2026-07-11',
    slice: 'm14f',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, tooling-docs',
    decision:
      'Milestone closure record for Phase B (M14 status effects, abilities, weather); verifies integrated correctness and queues residuals for M14.5 Phase C.',
  },
  {
    id: '0098',
    status: 'Accepted',
    date: '2026-07-12',
    slice: 'm14.5a',
    supersedes: '—',
    amends: 'ADR-0092',
    subsystems: 'battle',
    decision:
      'swap_active and attempt_recruit failure paths run the full run_post_turn_phases pipeline; load_skills() replaces skill_defs_from_rows as the SSOT for skill loading.',
  },
  {
    id: '0099',
    status: 'Accepted',
    date: '2026-07-12',
    slice: 'm14.5b',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle',
    decision:
      "StatusApplied event carries the emission-time slot; Phase 4.5 skips writes to non-conscious targets (fainted/just-KO'd); debug_assert pins the slot-bounds contract.",
  },
  {
    id: '0100',
    status: 'Accepted',
    date: '2026-07-12',
    slice: 'm14.5c',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle',
    decision:
      'Wire passive-ability system end-to-end: species_row.ability column, build_ability_store SSOT, AbilityStore threaded through 3 resolve functions and 5 reducers.',
  },
  {
    id: '0101',
    status: 'Accepted',
    date: '2026-07-13',
    slice: 'm14.5d',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, client-ui',
    decision:
      'Client battle UX completeness: weather banner pipeline via battleRowToStore, bindings-derived parity guards (never-checks), and VM-compare refresh guard.',
  },
  {
    id: '0103',
    status: 'Accepted',
    date: '2026-07-13',
    slice: 'm14.5f',
    supersedes: '—',
    amends: '—',
    subsystems: 'battle, ci-gates',
    decision:
      'BSATN schema-compat proof for M14b/14d optional fields: SpacetimeType handles additive schema; convergence net widened with 128-seed random_scenario and battle-lock.',
  },
];

// ---------------------------------------------------------------------------
// Build canonical header block string for a given entry
// ---------------------------------------------------------------------------
function buildHeaderBlock(h) {
  const lines = [
    `**Status:** ${h.status}`,
    `**Date:** ${h.date}`,
    `**Slice:** ${h.slice}`,
    `**Supersedes:** ${h.supersedes}`,
    `**Amends:** ${h.amends}`,
    `**Subsystems:** ${h.subsystems}`,
    `**Decision:** ${h.decision}`,
  ];
  if (h.supersededBy) lines.push(`**Superseded-by:** ${h.supersededBy}`);
  if (h.amendedBy) lines.push(`**Amended-by:** ${h.amendedBy}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main — apply all headers
// ---------------------------------------------------------------------------
let applied = 0;
let skipped = 0;
for (const h of HEADERS) {
  const headerBlock = buildHeaderBlock(h);

  // Verify Decision length
  if (h.decision.length > 240) {
    console.error(
      `ERROR: Decision for ${h.id} is ${h.decision.length} chars (>240): ${h.decision}`,
    );
    process.exit(1);
  }

  // Find file
  const files = readdirSync(ADR_DIR).sort();
  const filename = files.find(
    (f) =>
      f.startsWith(h.id) &&
      f.endsWith('.md') &&
      f !== 'README.md' &&
      f !== 'template.md' &&
      f !== 'DIGEST.md',
  );
  if (!filename) {
    console.error(`ERROR: ADR file for id ${h.id} not found in ${ADR_DIR}`);
    process.exit(1);
  }
  const filePath = join(ADR_DIR, filename);
  const content = readFileSync(filePath, 'utf8');

  // Idempotency guard — check if we've already inserted a canonical block
  const earlyContent = content.slice(0, 2000);
  const alreadyInserted =
    earlyContent.includes('\n**Status:** Accepted\n**Date:**') ||
    earlyContent.includes('\n**Status:** Superseded\n**Date:**') ||
    earlyContent.includes('\n**Status:** Deprecated\n**Date:**');

  if (alreadyInserted) {
    console.log(`  SKIP ${h.id} ${filename} (canonical block already present)`);
    skipped++;
    continue;
  }

  // Find end of title line
  const titleEnd = content.indexOf('\n');
  if (titleEnd === -1) {
    console.error(`ERROR: No newline found in ${filename}`);
    process.exit(1);
  }

  const title = content.slice(0, titleEnd);
  const rest = content.slice(titleEnd + 1);

  // Insert canonical block: title\n\n<block>\n\n<rest>
  const newContent = title + '\n\n' + headerBlock + '\n\n' + rest;
  writeFileSync(filePath, newContent, 'utf8');
  console.log(`  OK   ${h.id} ${filename}`);
  applied++;
}

console.log(`\nDone: ${applied} headers inserted, ${skipped} already present.`);
console.log(
  'Next: update LEGACY_TOLERANCE in scripts/adr-digest.mjs, then run: node scripts/adr-digest.mjs',
);
