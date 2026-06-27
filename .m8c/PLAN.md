# M8c Build Plan — Grass-Encounter Spine

**Slice:** M8c (grass-encounter spine; first half of M8). M8d (`attempt_recruit`, inventory, bait, recruit wiring, client recruit action) is OUT of scope.
**Worktree:** `feat/m8c-grass-encounters`, off `origin/master`.

## 1. Design resolutions

### 1.1 Wild-individuality storage — load-bearing decision (RESOLVED → ADR-0045)
Store rolled wild IVs/nature in a NEW **PRIVATE** side-table `battle_wild`, keyed by `battle_id`. Do NOT add IV/nature columns to the public `battle` row (ADR-0042 public + ADR-0015/0040 hidden-gene must-never-leak). `BattleState`/`BattleMonster` already carry only derived stats, never IVs/nature. Mirrors the ADR-0040 mode-2 pattern of `encounter`/`monster`.

```rust
#[spacetimedb::table(name = battle_wild)]   // PRIVATE — no `public`
pub struct BattleWild {
    #[primary_key] pub battle_id: u64,       // 1:1 FK to public battle row
    pub wild_species_id: u32,
    pub wild_level: u8,
    pub wild_iv_hp: u8, pub wild_iv_attack: u8, pub wild_iv_defense: u8,
    pub wild_iv_speed: u8, pub wild_iv_sp_attack: u8, pub wild_iv_sp_defense: u8,
    pub wild_nature: NatureKind,
}
```
New ADR-0045 documents the spec-wording deviation ("on the battle row" → private side-table); doc-keeper reconciles the M8 spec text. M8c only WRITES this row; M8d reads/clears it (no speculative cleanup now — YAGNI; document the post-battle residual).

### 1.2 `begin_encounter` — one internal fn, two callers
```rust
fn begin_encounter(ctx, player_identity, party_monster_ids: Vec<u64>,
    wild_species_id: u32, wild_level: u8, individuality_seed: u32) -> Result<u64, String>
```
Callers: (a) grass path in `movement_tick`; (b) manual `start_wild_battle` reducer (deterministic, test-addressable; `movement_tick` is scheduler-only). Responsibilities: reject if already Ongoing; build side A like `start_battle`; build wild `BattleMonster` (§1.3) WITHOUT an owned Monster row; insert public `Battle`; insert private `battle_wild`; return battle_id; log `wild_encounter`.

### 1.3 Wild `BattleMonster` (no owned Monster row)
Load `SpeciesRow` (reject if absent — partial-sync); `roll_individuality(seed)`; `derive_stats(&base, &ivs, &EVs::zero, &nature, Level::new(wild_level)?)`; `known_skill_ids` = species learnable ∩ skill_row; assemble full-HP `BattleMonster`. IVs/nature consumed only into derive_stats + the private row, never onto `BattleMonster`.

### 1.4 Sentinel opponent + empty owned ids
`opponent_identity = WILD_IDENTITY` (zero-byte sentinel const); `opponent_monster_ids = vec![]`. Build the `Battle` row DIRECTLY in `begin_encounter` (do NOT call `start_battle`, do NOT relax its owned-opponent guards). Build-time grep gate: confirm no reducer indexes `opponent_monster_ids[i]` for side B (read confirms write_back/submit_attack/swap_active/flee do not).

### 1.5 `TileMap` carries grass (additive)
`TileKind::TallGrass` (glyph `'~'`, walkable). `from_rows` builds a parallel `grass: Vec<bool>` (`matches!(kind, TallGrass)`); add `is_grass(p)` (bounds-safe). serde rides along (one-way Serialize). Add `~` tiles to `ZONE_0_ROWS` interior floor — keep spawn `(1,1)` and test-asserted tiles plain floor.

## 2. Build order (each independently green)
- (a) game-core tile layer (pure) — `cargo test -p game-core`.
- (b) wasm + renderer grass (shell) — client unit tests for map.ts.
- (c) private `battle_wild` table + ADR-0045 + `wild-individuality-privacy.eval.mjs` (clone encounter-privacy; NO `new RegExp`).
- (d) `begin_encounter` + `start_wild_battle` reducer — integration tests.
- (e) grass trigger in `movement_tick` — integration tests (cheap-roll-first, steps-onto-grass-only, player-only, in-battle-skip, partial-sync no-op, rate-0 never).

## 3. Cross-boundary contracts
- `zone_map()` serde: additive `grass: boolean[]`; TS `RawTileMap.grass` + `fromRaw` ragged guard + `isGrass`. Only wire change.
- Private `battle_wild` → NO `battle_wild*_table.ts` accessor. `types.ts` shape metadata regen acceptable (ADR-0044 residual a).
- `battle-schema-snapshot` eval UNAFFECTED (no columns added to `battle`).
- `movement_tick` netcode: one cheap roll, ≤1 table read on hit, bounded, single transaction.

## 4. EARS → tests (M8c scope; recruit_chance is M8d)
Tile layer (unit/property): from_char('~')→TallGrass walkable; is_grass truth table + OOB→false; grass.len==walkable.len==w*h; serde round-trip includes grass.
Renderer (unit): fromRaw ragged-grass throws; isGrass truth table.
Trigger (integration teeth — each bites if trigger over-fires): steps-onto-grass forced-hit→battle+battle_wild; forced-miss→none (cheap-roll-first); bump→none; standing-still→none; NPC→none; in-battle→none; partial-sync (no encounter row)→no-op no panic; rate-0→never.
Determinism: fixed seed → identical battle_wild row.

Proof-of-teeth: (1) wild-individuality-privacy eval (battle_wild public flagged, projection flagged, RLS-filter flagged, accessor flagged, green-path passes, comment-stripping); (2) trigger-does-not-fire teeth; (3) determinism tooth.

## 5. Anti-patterns to avoid
Leaking IVs on public battle; re-rolling wild at recruit; reading encounter table before cheap roll; firing on bump/standstill; hard-coding grass glyph in TS; `new RegExp` in evals; relaxing start_battle guards; speculative battle_wild cleanup.

## 6. touches: path-set
game-core `types.rs`/`world.rs`; `client-wasm/src/lib.rs` (doc note); `client/src/render/map.ts` + `world.ts`; `server-module/src/lib.rs`; `evals/wild-individuality-privacy.eval.mjs` (NEW; check eval-runner registration); `docs/adr/0045-*.md` (NEW); CHANGELOG/ARCHITECTURE/memory. Hidden-dep flags: eval-runner manifest registration; bindings regen (private→no accessor); keep spawn (1,1) plain floor.

## 7. Risks + defaults
R1 spec-wording → ADR-0045 + spec amend. R2 partial-sync → missing encounter row = no-op. R3 empty opponent ids → vec![] + WILD_IDENTITY, build Battle directly. R4 EVs zero ctor → EVs::zero or all-zero new. R5 movement_tick scheduler-only → factor trigger DECISION into a pure testable predicate + drive begin_encounter via start_wild_battle. R6 ZONE_0 art change → grass only on non-asserted interior `.` tiles; run game-core tests immediately.
