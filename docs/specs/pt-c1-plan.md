# pt-c1 — server-side `set_profile_name` reducer + RL-7 tooth amendment (plan)

**Slice:** pt-c1 (M-playtest-c) · **ADR:** 0132 · **Resolves:** D-17.5-C · subsumes parked `m17b-2`
**Off:** master `f82fbd7` · **Workflow:** planner → reviewer+red-team plan lenses → tester → specialist → verifier → doc-keeper.

## Scope (right-sized)
Add **exactly one** client-callable reducer `set_profile_name` to `server-module/src/ranking.rs` (a module
that declared **zero** reducers — `profile` is module-write-only, ADR-0119 D6), reusing `guards::validate_name`
(same rules as `join_game`), and **refine** the two RL-7 "zero reducers" teeth to "exactly one reducer named
`set_profile_name` that touches no `profile` table". No schema change.

**PARKED to pt-c1b:** the client rename UI. It CANNOT live in `client/src/ui/leaderboard*` (those files carry
RL-15 source-scans forbidding `set_profile_name`/`reducers.`/`module_bindings`), so a real UI needs a NEW
non-leaderboard ui file + `client/index.html` input + `client/src/main.ts` wiring — outside this slice's
touch-set (`main.ts` is the pt-c2 serial-overlap file). Server→client rhythm mirrors m17a→m17b. Depends on
this slice's regenerated bindings existing first.

## Write-target decision — **Option (a): write `player.name` only** (rely on the ADR-0125 mirror)
`player.name` is the display-name SSOT (set at `join_game`; read by `live_player_name` → mirrored to
`profile.name` on each rated game via `apply_pvp_rating`'s spreads, ADR-0125). The reducer writes ONLY
`player.name`; the passive mirror surfaces the new name on the leaderboard on the caller's next rated game
(≤1-game staleness — the already-accepted ADR-0125 contract).

- **(b) rejected** (write `player.name` + eager `profile.name` mirror): the eager profile write adds a THIRD
  `profile().identity().update(` and **breaks the existing `==2` whole-file update pin**
  (`ranking_tests.rs:596`, `d1_scan_no_eager_write_in_get_or_init`) — a deliberate ADR-0125 D1
  ("refresh is in-memory only") invariant. Loosening it to `==3` would weaken an existing gate and
  contradict ADR-0125. The immediacy benefit has NO observer this slice (UI parked). Reviewer BLOCKER B1.
- **(c) rejected** (write `profile.name` only): the ADR-0125 mirror overwrites `profile.name` from the stale
  `player.name` on the next rated game — a silent-revert bug (traced end-to-end).

## Reducer shape (specialist — Option a)
```rust
#[spacetimedb::reducer]
pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let me = ctx.sender;
    // `match` form (NOT `let Some(..) = ctx.db.player()`) so the whitespace-squash of
    // `= ctx.db.player()` (pin (c), ranking_tests.rs:628) is NOT produced. Mirrors get_or_init_profile.
    let mut player = match ctx.db.player().identity().find(me) {
        Some(p) => p,
        None => {
            let e = "not joined".to_string();
            log_reject("set_profile_name", me, &e);
            return Err(e);
        }
    };
    let validated = validate_name(&name).inspect_err(|e| log_reject("set_profile_name", me, e))?;
    player.name = validated;
    ctx.db.player().identity().update(player);
    Ok(())
}
```
Imports: extend `ranking.rs` to `use crate::guards::{log_reject, validate_name};`. Refine the module
doc-comment "declares NO reducers" → "declares exactly one reducer, `set_profile_name`, which writes only
`player.name`; `profile` rating/W/L stay module-write-only via `apply_pvp_rating`".

**Anti-patterns to avoid (from the red-team, all HIGH):**
- F1/F2: NEVER a profile write in the reducer or a helper it calls (`p.rating = …`, `Profile{ rating.. }`,
  a rating-writing helper). Under (a) the reducer touches no profile at all; the whole-file `==2` update pin
  is the backstop against any helper adding one.
- F3: NEVER call `get_or_init_profile(ctx, me)` / `profile().insert(` from the reducer — it would inject a
  rating-1000 row onto the public leaderboard for an unrated player.
- Split-bindings `= ctx.db.player()` / `= ctx.db.profile()` (pins (b)/(c), C1b).
- No cooldown / rate-limit (validation-only — closed-test YAGNI). "RL-7 tooth" = the module-write-only eval
  tooth, NOT a rate-limiter.

## RL-7 tooth amendment (REFINEMENT, monotone-preserves the security property)
The security invariant "no client-callable reducer writes `profile` rating/W/L" is PRESERVED: the one allowed
reducer touches no `profile` table at all. Old tooth: 0 reducers. New tooth: exactly 1, named, profile-untouching.

**1. `evals/ranking-security.eval.mjs` — replace A1 (`checkNoReducerAttr`) with `checkExactlyOneNameReducer`:**
- reducer-attr count == 1 (was: 0). (A1-BAD-ZERO now flags; A1-BAD-TWO flags.)
- the identifier of the fn immediately following the single `#[spacetimedb::reducer]` == `set_profile_name`
  (F4: tie count to name; extract via the existing brace-matcher `extractReducerBody`).
- **allowlist body scan** (F1/F2/F3): the `set_profile_name` body CONTAINS `validate_name(` and
  `player().identity().update(`, and CONTAINS NONE of `profile().identity()`, `profile().insert`,
  `profile().delete`, `get_or_init_profile(`, `refresh_profile_name(`, `= ctx.db.profile()`.
- Teeth (must BITE): A1-GOOD (clean set_profile_name writing only player → pass); A1-BAD-ZERO (no reducer →
  flag); A1-BAD-TWO-REDUCERS (→ flag); A1-BAD-PROFILE-TOUCH (set_profile_name body with `p.rating=…` /
  `get_or_init_profile(` / `profile().identity().update(` → flag); A1-EVASION (attr in a string literal →
  count still 1). A2/B/C1a/C1b/C2 UNCHANGED (all stay green — the reducer adds no `apply_pvp_rating` call,
  no profile access, no delete, no on_disconnect touch). Update the header + pass-detail strings.
- **Amend in place** (not a new eval file): A1 is the literal RL-7 tooth; splitting would leave the old A1 to
  go RED against correct code.

**2. `server-module/src/pvp_tests.rs::m17a_rl7_server_ranking_module_invariants` (i)/(i-b):**
- (i): `#[spacetimedb::reducer` count == 1 (was `!contains`).
- new (i-a): source contains `fn set_profile_name(`.
- new (i-c): extract the `set_profile_name` body (via `extract_pvp_fn_body`) and assert it contains none of
  `profile().identity()`, `profile().insert`, `get_or_init_profile(`, `refresh_profile_name(`,
  `= ctx.db.profile()` (name-setter is profile-untouching).
- keep (i-b) `reducer as` alias ban.
- **supersede** the comment "a future name-setter belongs in a separate reducer file" (line 1123) → it lives
  IN ranking.rs (eval A2 couples profile access to ranking.rs; declared touch is ranking.rs). Reference ADR-0132.
- (ii)–(viii) UNCHANGED (the reducer touches none of get_or_init/compute_rating/is_ranked_pvp/W-L/delete/mod-decl).

**3. `ranking_tests.rs` (sibling) — new source-scan tests + keep existing pins green:**
- add T2-style scans pinning the reducer shape (`fn set_profile_name(`, body composes `validate_name(` +
  `player().identity().update(`, body contains none of the profile needles) + a `scan_machinery_teeth`-style
  BAD/GOOD/EVASION fixture proving the profile-untouching scan bites.
- **existing pins that MUST stay green** (backstops): (a) `profile().identity().update(` == 2 (F1/F2 backstop —
  any helper adding a profile update → 3 → RED); (b) `= ctx.db.profile()` absent; (c) `= ctx.db.player()`
  absent (→ the `match` form is mandatory).
- **optionally add** a whole-file `profile().insert(` == 1 pin (extra F3 backstop against a new insert anywhere).

## Bindings + docs
- `spacetime generate` → `client/src/module_bindings/**` gains `set_profile_name_reducer.ts` +
  `reducers.setProfileName` + a types.ts row (mechanical/structural; bindings-drift gated). Do NOT hand-edit.
- `just knowledge` → `docs/knowledge/reducers/set_profile_name.md` (knowledge-drift gated).
- ADR `docs/adr/0132-*.md` (canonical header; Decision ≤ 240 chars). `just adr-digest` regen.
- ARCHITECTURE.md line 155 (ranking.rs map) += the `set_profile_name` reducer (one line, doc-keeper).
- CHANGELOG via Conventional Commit message only (git-cliff; do NOT hand-edit).

## EARS acceptance criteria
- **pt-c1-1:** WHEN a joined player invokes `set_profile_name(name)` with a name passing `validate_name`,
  THE reducer SHALL set that player's `player.name` to the canonical (trimmed, NFC) validated name.
- **pt-c1-2:** IF the name fails `validate_name` (empty / > MAX_NAME_LEN / non-alphanumeric-non-space incl.
  bidi/zero-width), THEN the reducer SHALL reject with that error and make no write (reject-not-clamp).
- **pt-c1-3:** IF the caller has no `player` row (not joined), THEN the reducer SHALL reject `"not joined"`
  and make no write.
- **pt-c1-4:** WHEN `set_profile_name` updates `player.name`, THE new name SHALL surface on the public
  leaderboard on the caller's next rated game via the ADR-0125 passive mirror (no direct `profile` write).
- **pt-c1-5:** THE `set_profile_name` reducer SHALL NOT read or write the `profile` table (no leaderboard-row
  creation, no rating/wins/losses mutation) — the name-setter is profile-untouching.
- **pt-c1-6:** `ranking.rs` SHALL declare exactly one `#[spacetimedb::reducer]`, named `set_profile_name`;
  all `profile` mutation SHALL remain module-write-only via `apply_pvp_rating`.
- **pt-c1-7 (recorded, not a new gate):** the reducer SHALL apply validation only — no rename cooldown/rate-limit
  (closed-playtest YAGNI); homoglyph/duplicate leaderboard-name spoofing is accepted for the closed solo test.

## Deferrals
- **pt-c1b** — client rename UI (new non-leaderboard ui file + index.html input + main.ts wiring →
  `reducers.setProfileName` + round-trip/e2e asserting the leaderboard reflects the new name after a rated game).
- Rename cooldown / homoglyph+duplicate mitigation — deferred to any public-exposure milestone (ADR-0132 records the accept).
- Container integration test for the reducer's runtime DB effect — optional (tester's call); ReducerContext is
  not unit-constructible, so source-scan + eval is the established honest proof for this module.

## Tasks (ordered)
1. tester: amend `pvp_tests.rs` (i)/(i-a)/(i-c) + supersede comment → RED. amend `ranking-security.eval.mjs`
   A1 + teeth → real-source A1 RED, synthetic teeth self-bite green. add `ranking_tests.rs` T2 scans + machinery
   teeth → RED. Confirm the existing (a)/(b)/(c) pins stay green post-impl.
2. specialist: implement `set_profile_name` (match form, player-only write) + module doc refinement → green.
3. bindings: `spacetime generate` → commit `module_bindings/**`.
4. docs: ADR-0132, `just knowledge`, ARCHITECTURE line.
5. full `just ci` + Semgrep once; verifier confirms teeth not weakened; then PR.
