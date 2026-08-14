// zone-warp-server-runtime eval (M11b):
// The `movement_tick` reducer in server-module/src/movement.rs must use the
// real `map_for` + `load_zone_maps` pipeline (not the M2 `zone_map()` stub),
// and the warp branch must guard against a character in an active battle
// (C1 security finding). `sync_content_inner` must validate zone maps before
// upserting, and `ensure_zone_schedules` must be called from both `init` and
// `sync_content` to make schedule management idempotent.
//
// Invariants checked:
//
//   W0. `movement_tick` is defined EXACTLY ONCE across the concatenated
//       server-module sources — a decoy `pub fn movement_tick(` planted earlier
//       in the blob would hijack extraction for W1/W2/W3/W6 (11r-c red-team
//       HIGH-3). Runs BEFORE any extraction; failure is reported as "ambiguous
//       extraction".
//   W1. movement_tick uses `map_for(` (and does NOT use the old stub
//       `zone_0()` call as the map — the stub may appear elsewhere).
//   W2. movement_tick calls `warp_at(` to detect warp tiles.
//   W3. The WARP branch in movement_tick has a battle guard: an
//       `is_in_ongoing_battle(` call inside the REGION `warp_at(` … the first
//       following `stepped_onto_grass(` (ADR-0122 both-role SSOT).
//       De-vacuified in 11r-c — the old `BattleOutcome::Ongoing` needle was
//       satisfied by the grass-encounter pre-check (ADR-0166 R3).
//       REGION-SCOPED in 14r-f (ADR-0188 §W3): counting anywhere AFTER
//       `warp_at(` went HOLLOW the moment the grass block started calling the
//       same SSOT predicate. See checkWarpBattleGuard's docstring.
//       Also in 14r-f, W3 gained two SHAPE layers ported from movement_tests.rs's
//       E3 test (red-team BYPASS 4): W3b pins the guard expression
//       (`p.identity` + `unwrap_or(true)`) and W3c pins that its value is the
//       branch condition (`;if!skip_warp{`). Presence of the call alone was
//       measurably bypassable by a telemetry-only witness beside an
//       unconditional warp write.
//   W4. sync_content_inner calls `validate_zone_maps(` before zone_def upserts.
//   W5. `ensure_zone_schedules` is called from BOTH the `init` reducer body
//       AND the public `sync_content` reducer body.
//   W6. The DRAIN in movement_tick has a battle lock: the FIRST
//       `is_in_ongoing_battle(` in the body precedes `move_queue.remove(`
//       (ADR-0168 D1). W3 structurally cannot see this guard — it counts
//       occurrences AFTER `warp_at(`, and the drain lock sits before it — which
//       is exactly why the two checks are independent and both have teeth.
//
// Proof-of-teeth: each invariant has a pair of synthetic Rust snippets — a BAD
// fixture that MUST be flagged and a GOOD fixture that MUST pass — so a regression
// in the checker is caught before it lets a bad implementation slip through.
//
// All pattern matching uses String.indexOf() or literal /regex/ — NO
// `new RegExp(...)` with a non-literal argument (Semgrep detect-non-literal-regexp).
//
// Every check consumes SCRUBBED source — comments AND string-literal contents
// blanked — never raw source: `scrubRust` for the fixtures, the same two steps
// applied PER FILE inside `readServerModuleSources` for the real scan.
// Comment-stripping alone let a dead `let _decoy = "<needle text>";` satisfy a
// check while the real guard was missing (11r-c red-team); it also let a `{`
// inside a string corrupt extractFnBody's brace counting. Per-file (rather than
// whole-blob) scrubbing is itself load-bearing — see readServerModuleSources.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripRustStrings } from './battle-reducer-security.eval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A double-quote inside a Rust char / byte-char literal is a LANDMINE for any
// text-level string stripper (`stripRustStrings` has no char-literal lexer): the
// lone quote reads as opening a string literal and inverts string/code polarity
// for everything after it. Built by concatenation so this eval's own source does
// not contain the sequence it looks for.
const DOUBLE_QUOTE = String.fromCharCode(34);
const CHAR_LITERAL_QUOTE = "'" + DOUBLE_QUOTE + "'";

// ---------------------------------------------------------------------------
// Shared helpers (mirrors the evolution-reducer-security eval convention).
// ---------------------------------------------------------------------------

/**
 * Strip Rust line and block comments from source.
 * @param {string} src Raw Rust source.
 * @returns {string} Source with comments blanked.
 */
function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The scan pipeline for this eval: blank comments, THEN blank string-literal
 * contents. Every check below consumes scrubbed output — never raw source.
 * `readServerModuleSources` applies these same two steps per file rather than
 * calling this helper, because it needs the comment-stripped intermediate to
 * spot char-literal landmines; keep the two in step if either changes.
 *
 * Why the string pass (11r-c red-team): with comments-only stripping, a dead
 * `let _decoy = "…";` whose CONTENT spelled a needle satisfied W6 (and the Rust
 * gating tests) while the real guard was absent. `stripRustStrings` is imported
 * from `battle-reducer-security.eval.mjs` rather than re-implemented — that file
 * added it for exactly this class (its F1 guard-fakery hardening) and a seventh
 * private copy would be a seventh thing to keep correct. Cross-eval checker reuse
 * is established here (`ci-gate-wiring` ← `e2e-desync-teeth`, `wallet-privacy` ←
 * `conversation-privacy`); importing executes only function/const definitions.
 *
 * Bonus: because string contents become spaces, a `{` or `}` inside a literal can
 * no longer corrupt `extractFnBody`'s brace counting.
 *
 * INHERITED LIMIT: the imported stripper does not handle raw strings
 * (`r"…"`, `r#"…"#`). That is acceptable here because this eval is the COARSE
 * backstop — the airtight layer for `movement.rs` is `movement_tests.rs`, whose
 * local byte-sequential stripper does handle raw strings (and asserts loudly on
 * hash depths it does not). No server source uses raw strings today.
 *
 * @param {string} src Raw Rust source.
 * @returns {string} Source with comment and string-literal text blanked.
 */
function scrubRust(src) {
  return stripRustStrings(stripRustComments(src));
}

/**
 * Extract a single function body (the text between the outer braces) from
 * comment-stripped Rust source. Tries `pub fn <name>(` first, then `fn <name>(`.
 * Returns null if the function is not found.
 *
 * Uses indexOf + brace-depth counting — NO dynamic RegExp.
 *
 * @param {string} src  Comment-stripped Rust source.
 * @param {string} fnName  Bare function name.
 * @returns {string|null}
 */
function extractFnBody(src, fnName) {
  const pubNeedle = `pub fn ${fnName}(`;
  const privNeedle = `fn ${fnName}(`;

  let idx = src.indexOf(pubNeedle);
  if (idx === -1) idx = src.indexOf(privNeedle);
  if (idx === -1) return null;

  let i = idx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;

  let depth = 1;
  const start = i + 1;
  i++;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

/**
 * Read all .rs files under `dir` recursively (ADR-0056 module split), scrubbing
 * EACH FILE before joining them.
 *
 * Per file, NOT once over the joined blob. Every text-level stripper is a state
 * machine, so one stray delimiter misaligns everything that FOLLOWS it — and
 * files are concatenated in sorted order, which means an unrelated test file can
 * silently blank a production reducer that happens to sort later. Both variants
 * were observed on this eval: an unpaired block-comment opener in a test file's
 * comment, and a double-quote inside a `b'…'` byte-char literal in a test
 * helper. Each blanked `pub fn init(` in `lib.rs` and failed W5 with
 * "init not found" — a loud but thoroughly misleading failure. Scrubbing per
 * file bounds the damage to the file that contains the stray delimiter, so
 * `movement.rs`, `lib.rs` and `content.rs` are unreachable from a sibling's
 * lexical accident. (This crate carries four such char-literal landmines today:
 * `battle_tests.rs`, `ranking_tests.rs`, `taming_tests.rs`, `m14_5d_1a_tests.rs`
 * — all outside this slice's touch set, all now harmless.)
 *
 * Also reports which files carry a char-literal double-quote, so that if an
 * extraction ever does come up empty the failure can name the likely culprit.
 *
 * @param {string} dir
 * @returns {{ src: string, quoteLandmines: string[] }}
 */
function readServerModuleSources(dir) {
  const parts = [];
  const quoteLandmines = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = readServerModuleSources(full);
      parts.push(nested.src);
      quoteLandmines.push(...nested.quoteLandmines);
    } else if (entry.endsWith('.rs')) {
      const commentless = stripRustComments(readFileSync(full, 'utf8'));
      if (commentless.indexOf(CHAR_LITERAL_QUOTE) !== -1) quoteLandmines.push(entry);
      parts.push(stripRustStrings(commentless));
    }
  }
  return { src: parts.join('\n'), quoteLandmines };
}

// ---------------------------------------------------------------------------
// Check functions — exported for unit-testability; null = pass.
// ---------------------------------------------------------------------------

/**
 * W1 — movement_tick body must contain `map_for(` and must NOT contain
 * `zone_0()` as the SOLE map source (the stub call).
 *
 * Note: `zone_0()` may legitimately appear in tests or the module-level
 * `zone_map` helper; we check the movement_tick BODY specifically.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped movement_tick function body.
 * @returns {string|null}
 */
function checkMapForUsed(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('map_for(') === -1) {
    return (
      'movement_tick: body does not call map_for( — ' +
      'the M2 zone_map() stub must be replaced with the real map_for(zone, &zone_maps) pipeline (M11b)'
    );
  }
  // The old stub: zone_map( should not appear as the map construction in movement_tick.
  // We look for zone_map( — the private helper function call — as an indicator the stub is still used.
  if (compact.indexOf('zone_map(') !== -1) {
    return (
      'movement_tick: body still calls zone_map( (the M2 stub) — ' +
      'replace with load_zone_maps() + map_for(zone, &zone_maps); the stub must be removed from this reducer'
    );
  }
  return null;
}

/**
 * W2 — movement_tick body must call `warp_at(` to detect warp tiles.
 *
 * @param {string} body  Comment-stripped movement_tick function body.
 * @returns {string|null}
 */
function checkWarpAtCalled(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('warp_at(') === -1) {
    return (
      'movement_tick: body does not call warp_at( — ' +
      'the server-authoritative warp resolution requires warp_at(next.pos) ' +
      'to detect when a character steps onto a warp tile (M11b spec §3 Warps)'
    );
  }
  return null;
}

// The three anchors W3 works from, as data. `stepped_onto_grass(` is the END of
// the warp region, mirroring `movement_tests.rs:256-266`'s own `warp_region`
// helper — the two must stay in step.
const WARP_ANCHOR = 'warp_at(';
const GRASS_ANCHOR = 'stepped_onto_grass(';
const SSOT_NEEDLE = 'is_in_ongoing_battle(';

// The two CONTIGUOUS shape needles ported from the Rust-side E3 test
// `e3_warp_guard_uses_the_both_role_ssot_with_the_player_identity`
// (movement_tests.rs layers 1 and 1b) — see checkWarpBattleGuard's W3b/W3c.
//
// W3b pins the guard EXPRESSION: the SSOT is asked about the CHARACTER's own
// `p.identity` (not `ctx.sender`, which inside a scheduler-only reducer is the
// MODULE identity and would make the guard always false), and its Option is
// defaulted with the ADR-0070 `unwrap_or(true)` POLICY (no player row => an NPC
// => do not warp). Deliberately NOT `unwrap_or(false)`: that is the drain
// lock's FACT-shaped default, and movement.rs:347-351 says in as many words
// that the two must not be unified.
const WARP_GUARD_EXPR_NEEDLE = '.map(|p|is_in_ongoing_battle(ctx,p.identity)).unwrap_or(true)';
// W3c pins that the guard's VALUE IS THE BRANCH CONDITION, and pins the
// ADR-0166 D4 `in_battle` -> `skip_warp` rename at the same time.
const WARP_GUARD_BRANCH_NEEDLE = '.unwrap_or(true);if!skip_warp{';

/**
 * Count non-overlapping occurrences of a literal needle (indexOf loop — no
 * dynamic RegExp).
 *
 * @param {string} hay
 * @param {string} needle
 * @returns {number}
 */
function countNeedle(hay, needle) {
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
}

/**
 * The WARP BRANCH region of a compacted `movement_tick` body: everything from
 * the FIRST `warp_at(` up to (exclusive) the FIRST `stepped_onto_grass(` that
 * FOLLOWS it. Mirrors `server-module/src/movement_tests.rs:256-266`'s
 * `warp_region` helper, which scopes the Rust-side E3 assertions the same way.
 *
 * TWO TRAPS, BOTH EMPIRICALLY PoC'd — do not "simplify" this function:
 *
 *  1. `compact.substring(warpAtIdx, grassIdx)` with `grassIdx === -1` is NOT a
 *     no-op fallback. `String.prototype.substring` CLAMPS a negative argument to
 *     0 and then SWAPS the two bounds, so the "region" silently becomes
 *     everything BEFORE `warp_at(` — which is exactly where the ADR-0168 D1
 *     drain lock's legitimate `is_in_ongoing_battle(` call lives. The check then
 *     reports PASS with the warp guard fully deleted: strictly worse than the
 *     unscoped version it replaced. The fallback is therefore written out
 *     explicitly as `grassIdx === -1 ? compact.length : grassIdx` and the slice
 *     uses `String.prototype.slice`. Never `substring`. Never `slice(x, -1)`.
 *     (`BAD_MOVEMENT_TICK_DRAIN_LOCK_ONLY_NO_WARP_GUARD` is the fixture that
 *     kills the swapped variant.)
 *
 *  2. A missing START anchor, or an empty extracted region, must FAIL LOUD.
 *     A region-scoped scan that quietly degrades to "no region, nothing to
 *     count, pass" is the classic false green.
 *
 * The END anchor is deliberately OPTIONAL: most synthetic fixtures in this file
 * are truncated `movement_tick` bodies that stop right after the warp branch and
 * legitimately have no grass block. Their region runs to end-of-body, which is
 * sound — there is no downstream text for it to over-include.
 *
 * @param {string} compact  Whitespace-free movement_tick body.
 * @returns {{region: string, grassAnchored: boolean}|{error: string}}
 */
function warpBranchRegion(compact) {
  const start = compact.indexOf(WARP_ANCHOR);
  if (start === -1) {
    return {
      error:
        'movement_tick: warp_at( not found — cannot verify the warp battle guard without warp ' +
        'detection (W2 precondition). This is a FAIL, never a skip: a region-scoped check whose ' +
        'start anchor has vanished must say so loudly rather than scan an empty region and pass',
    };
  }

  const grassIdx = compact.indexOf(GRASS_ANCHOR, start);
  // EXPLICIT fallback. See trap 1 above — `substring` here inverts the region.
  const end = grassIdx === -1 ? compact.length : grassIdx;
  if (end <= start) {
    return {
      error:
        'movement_tick: the warp region [warp_at( .. stepped_onto_grass() came out EMPTY or ' +
        'INVERTED (start=' +
        String(start) +
        ', end=' +
        String(end) +
        '). An empty region is an error, never a vacuous pass — the anchor arithmetic is wrong ' +
        '(the classic cause is String.prototype.substring clamping a -1 end index to 0 and ' +
        'swapping the bounds, which points the scan at the code BEFORE the warp branch)',
    };
  }

  return { region: compact.slice(start, end), grassAnchored: grassIdx !== -1 };
}

/**
 * W3 — The WARP branch in movement_tick must contain an ADR-0122 both-role SSOT
 * battle guard, scanned inside the REGION `warp_at(` … `stepped_onto_grass(`.
 *
 * HISTORY, so the next reader does not re-derive it.
 *
 * 11r-c (ADR-0166 R3, ADR-0168 D6) DE-VACUIFIED the needle: it used to be
 * `BattleOutcome::Ongoing`, which the grass-encounter block spelled out all by
 * itself, so deleting the warp guard still passed. The needle became
 * `is_in_ongoing_battle(` and the strategy was "count occurrences anywhere AFTER
 * the first `warp_at(`". That worked only because of an ACCIDENT of layout: the
 * grass block's pre-check was an inline single-role
 * `battle().player_identity()` scan that never named the SSOT predicate
 * (ADR-0166 residual R4), so the only post-`warp_at(` occurrence was the warp
 * guard's own.
 *
 * 14r-f closes R4 by routing the grass pre-check through the same both-role
 * `guards::is_in_ongoing_battle`. That takes the post-`warp_at(` count from 1 to
 * 2 — so W3 does NOT go red, it goes **HOLLOW**: delete the real warp guard and
 * the grass block's legitimate call holds the count at 1, and W3 reports PASS
 * with the C1 security finding fully live. (This eval's previous docstring
 * claimed "this check sees the warp guard and only the warp guard — delete it
 * and the count drops to zero". After 14r-f that sentence is FALSE, which is why
 * it is gone.)
 *
 * THE FIX (ADR-0188 §W3): scan the warp REGION, not the whole tail. The region
 * ends at the grass trigger, so the grass block's SSOT call is EXCLUDED by
 * construction and the count once again reflects the warp guard alone —
 * this time by structure rather than by luck. It mirrors
 * `movement_tests.rs:256-266`'s `warp_region`, which scopes the Rust-side E3
 * assertions identically.
 *
 * WHAT IT KILLS:
 *   - a movement_tick that adds `warp_at(` but forgets the warp battle guard
 *     (BAD_MOVEMENT_TICK_NO_BATTLE_GUARD);
 *   - the retired inline single-role filter
 *     `battle().player_identity().filter(..).any(.. BattleOutcome::Ongoing)`,
 *     which sees PvP side A only and lets a side-B player walk through a warp
 *     tile mid-ranked-battle
 *     (BAD_MOVEMENT_TICK_INLINE_SINGLE_ROLE_WARP_GUARD — now carrying a grass
 *     tail, so it also proves the narrowing EXCLUDES the downstream call);
 *   - THE HOLLOWING ITSELF: warp guard deleted while the grass block calls the
 *     SSOT (BAD_MOVEMENT_TICK_GRASS_SSOT_NO_WARP_GUARD). The unscoped
 *     predecessor PASSED this fixture; the teeth block asserts that explicitly
 *     so nobody reverts the narrowing;
 *   - the substring-swap mis-fix (BAD_MOVEMENT_TICK_DRAIN_LOCK_ONLY_NO_WARP_GUARD);
 *   - a DECOY WITNESS: a textbook-perfect SSOT call bound to a telemetry
 *     variable while the warp write runs unconditionally
 *     (BAD_MOVEMENT_TICK_DECOY_TELEMETRY_WARP,
 *     BAD_MOVEMENT_TICK_DECOY_WITNESS_UNGATED_WRITE) — red-team BYPASS 4.
 *
 * THREE LAYERS, in order, each strictly stronger than the last:
 *   W3a  the SSOT predicate is CALLED inside the warp region (count > 0).
 *   W3b  it is called in the sanctioned EXPRESSION — `p.identity` as the
 *        argument, `unwrap_or(true)` as the ADR-0070 default.
 *   W3c  its VALUE is the branch condition (`;if!skip_warp{`).
 * W3a alone is presence, and presence was measurably bypassable: BYPASS 4 kept
 * the call and wrote `row.zone_id` unconditionally. W3b and W3c are ported
 * verbatim from `movement_tests.rs`'s E3 layers 1 and 1b, which already caught
 * that fixture — the point of porting them is that this eval must be sound on
 * its own rather than leaning on a sibling gate in the same `just ci` run.
 *
 * HONEST LIMIT: W3 covers the WARP guard only. The drain-time lock is W6's job,
 * and the drain lock sits BEFORE `warp_at(` so it is outside this region by
 * construction — the two checks stay independent. Second honest limit: W3b/W3c
 * pin a SPELLING. A semantically-equivalent rewrite (a helper fn, a `match`
 * instead of `unwrap_or`) will red them. That is deliberate and matches the
 * Rust-side E3 discipline: re-derive the needle in the open, with the ADR that
 * sanctions the new shape — never relax it to presence.
 *
 * @param {string} body  Comment-stripped movement_tick function body.
 * @returns {string|null}
 */
function checkWarpBattleGuard(body) {
  const compact = body.replace(/\s+/g, '');

  const scoped = warpBranchRegion(compact);
  if (scoped.error) return scoped.error;

  if (countNeedle(scoped.region, SSOT_NEEDLE) === 0) {
    return (
      'movement_tick: warp branch is missing a battle guard — the needle ' +
      SSOT_NEEDLE +
      ' does not appear anywhere in the WARP REGION, which runs from ' +
      WARP_ANCHOR +
      ' up to ' +
      (scoped.grassAnchored
        ? 'the grass-encounter trigger ' + GRASS_ANCHOR
        : 'the end of the body (' + GRASS_ANCHOR + ' is absent from this body)') +
      '. The warp code path itself must ask the ADR-0122 both-role SSOT before teleporting ' +
      '(C1 security finding: a character mid-battle must not be warped to a new zone). ' +
      'An inline battle scan does NOT satisfy this on purpose: the retired ' +
      'battle().player_identity().filter(..) filter matches side A only, so a PvP ' +
      'side-B player walks through a warp tile mid-ranked-battle (ADR-0166 D4). ' +
      'NOTE: neither the drain-time lock (ADR-0168 D1, which sits BEFORE the warp anchor — ' +
      'that is W6, deliberately independent) NOR the grass-encounter pre-check (ADR-0122 D1 / ' +
      'ADR-0166 R4, which sits after the grass anchor) can satisfy this check: both are outside ' +
      'the region by construction, which is the whole point of the ADR-0188 §W3 re-scoping'
    );
  }

  // --- W3b/W3c (14r-f, red-team BYPASS 4) ---------------------------------
  // Presence of the SSOT call inside the region is necessary but NOT sufficient.
  // A red-team kept a textbook-perfect call, bound it to a telemetry variable,
  // logged it, and wrote `row.zone_id = to_zone;` UNCONDITIONALLY — the C1
  // finding fully reintroduced, and this check reported pass:true. The needles
  // below are ported verbatim from the Rust-side E3 test, which already caught
  // that fixture; they make the eval layer independently sound instead of
  // relying on its sibling.
  if (scoped.region.indexOf(WARP_GUARD_EXPR_NEEDLE) === -1) {
    return (
      'movement_tick: the warp branch calls the SSOT but not in the sanctioned guard EXPRESSION — ' +
      'the contiguous needle ' +
      WARP_GUARD_EXPR_NEEDLE +
      ' does not appear in the warp region. Presence of ' +
      SSOT_NEEDLE +
      ' proves the predicate is CALLED; it proves nothing about WHICH identity is asked or what ' +
      'happens to the answer. Two failures land here, both real: (1) the argument is not the ' +
      "CHARACTER's own `p.identity` — `movement_tick` is scheduler-only, so `ctx.sender` here is " +
      'the MODULE identity and `is_in_ongoing_battle(ctx, ctx.sender)` is ALWAYS FALSE, warping ' +
      'every player out of every battle, strictly worse than the bug being fixed; (2) the Option ' +
      'is defaulted with something other than the ADR-0070 `unwrap_or(true)` POLICY (no player ' +
      "row => an NPC => do not warp). `unwrap_or(false)` is the DRAIN lock's FACT-shaped default " +
      'and movement.rs:347-351 states explicitly that the two must not be unified. Ported from ' +
      'movement_tests.rs `e3_warp_guard_uses_the_both_role_ssot_with_the_player_identity` layer 1'
    );
  }

  if (scoped.region.indexOf(WARP_GUARD_BRANCH_NEEDLE) === -1) {
    return (
      'movement_tick: the warp guard is computed but its VALUE does not gate the warp write — ' +
      'the contiguous needle ' +
      WARP_GUARD_BRANCH_NEEDLE +
      ' does not appear in the warp region. This is red-team BYPASS 4: a textbook-perfect SSOT ' +
      'call bound to a witness variable, logged or compared for telemetry, while ' +
      '`row.zone_id = to_zone;` runs UNCONDITIONALLY — every character warps, battling or not, ' +
      'and a presence-only check reports PASS with the C1 security finding fully live. The ' +
      "guard's result must be the branch condition, and the binding must be named `skip_warp` " +
      '(ADR-0166 D4 renamed it from `in_battle` because the boolean decides whether to SKIP, not ' +
      'whether the player is in a battle — the name is what keeps `unwrap_or(true)` readable as ' +
      'correct). Ported from movement_tests.rs E3 layer 1b'
    );
  }

  return null;
}

/**
 * TEETH-ONLY. The RETIRED unscoped strategy: count `is_in_ongoing_battle(`
 * anywhere after the first `warp_at(`.
 *
 * This exists for exactly one reason — the teeth block uses it as a REGRESSION
 * WITNESS, asserting that the hollowing fixture (warp guard deleted, grass block
 * calling the SSOT) would have PASSED under this strategy and is FLAGGED under
 * the region-scoped one. That makes the ADR-0188 §W3 narrowing self-documenting
 * and makes a silent revert to the old shape impossible: revert it, and the
 * witness assertion fails.
 *
 * It is NEVER used to produce a verdict about the real source.
 *
 * @param {string} compact  Whitespace-free movement_tick body.
 * @returns {number}  -1 when `warp_at(` is absent.
 */
function unscopedCountAfterWarpAtForTeethOnly(compact) {
  const start = compact.indexOf(WARP_ANCHOR);
  if (start === -1) return -1;
  return countNeedle(compact.slice(start + WARP_ANCHOR.length), SSOT_NEEDLE);
}

/**
 * W6 (11r-c, ADR-0168 D1) — the DRAIN in movement_tick must be battle-locked:
 * the first `is_in_ongoing_battle(` in the body must appear BEFORE
 * `move_queue.remove(`.
 *
 * This is the eval-layer tie for the real server-side movement lock. Before
 * 11r-c the ONLY battle read in `movement_tick` was the warp guard, which runs
 * long after the queue has been drained and `apply_move` has already moved the
 * character — so a modified client could walk out of a wild encounter's tile or
 * reposition during ranked PvP, with only honest-client overlay suppression
 * preventing it (ADR-0166 R10).
 *
 * Ordering, not presence, is the property: a guard sited after the drain has
 * already consumed the input and already moved the character, so it is a
 * decorative no-op. `move_queue.remove(` is the drain site; if it cannot be
 * found the check fails loudly rather than passing vacuously.
 *
 * Kills: BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH — a movement_tick whose
 * only SSOT call is the warp guard (i.e. the pre-11r-c real source). That
 * fixture PASSES W3, which is precisely why W6 has to exist separately.
 *
 * HONEST LIMIT: this is an ordering scan over source text. The lock's semantics
 * (frozen tile, queue intact) are pinned by `movement_tests.rs`'s full-block
 * needles and proven behaviorally by the sim-harness's own battle-lock tests in
 * the same `just ci` run; no reducer is executed anywhere (ADR-0156 P7).
 *
 * @param {string} body  Comment-stripped movement_tick function body.
 * @returns {string|null}
 */
function checkDrainBattleGuard(body) {
  const compact = body.replace(/\s+/g, '');

  const removeIdx = compact.indexOf('move_queue.remove(');
  if (removeIdx === -1) {
    return (
      'movement_tick: move_queue.remove( not found — cannot verify the drain-time battle lock ' +
      'without the drain site (W6 precondition: the drain was renamed or restructured; ' +
      're-derive this check rather than deleting it)'
    );
  }

  const guardIdx = compact.indexOf('is_in_ongoing_battle(');
  if (guardIdx === -1) {
    return (
      'movement_tick: no is_in_ongoing_battle( call in the body at all — ' +
      'the drain-time battle lock (ADR-0168 D1) is missing: a character whose player is in an ' +
      'ongoing battle must not have its move queue drained (spec E1 — it stays at its pre-lock tile)'
    );
  }

  if (guardIdx > removeIdx) {
    return (
      'movement_tick: the drain-time battle lock is missing or mis-sited — the first ' +
      'is_in_ongoing_battle( call is at compact offset ' +
      String(guardIdx) +
      ', AFTER move_queue.remove( at ' +
      String(removeIdx) +
      '. A battle check that runs after the drain has already consumed the queued input and ' +
      'already applied the move, so it prevents nothing (this is exactly the pre-11r-c shape: ' +
      'the only battle read was the warp guard, which is why W3 passes on it). ADR-0168 D1 ' +
      'places the lock after the empty-queue early-continue and BEFORE move_queue.remove(0)'
    );
  }

  return null;
}

/**
 * W0 — count `fn <name>(` definitions in `src`.
 *
 * Ported from `battle-reducer-security.eval.mjs`'s C3 `countFnDefinitions`
 * (String.indexOf loop — NO dynamic RegExp, Semgrep detect-non-literal-regexp).
 * Used to assert `movement_tick` is defined exactly once across the concatenated
 * server sources BEFORE `extractFnBody` picks one: `extractFnBody` takes the
 * FIRST match, so a decoy `pub fn movement_tick(` planted earlier in the blob
 * (alphabetically-earlier file, or earlier in movement.rs itself) would hand
 * W1/W2/W3/W6 a body that is not the real reducer (11r-c red-team HIGH-3).
 *
 * String literals are blanked as well as comments (`scrubRust`), matching
 * battle-reducer-security's C3, so a `fn movement_tick(` inside a log message
 * cannot inflate the count. HONEST LIMIT: raw strings are not blanked by the
 * imported stripper — a `fn movement_tick(` inside `r"…"` would still be counted,
 * which fails loudly ("ambiguous extraction") rather than passing silently, the
 * safe direction. No server source uses raw strings today.
 *
 * @param {string} src  Rust source (scrubbing is applied internally).
 * @param {string} fnName  Bare function name.
 * @returns {number}
 */
function countFnDefinitions(src, fnName) {
  const code = scrubRust(src);
  const needle = 'fn ' + fnName + '(';
  let count = 0;
  let idx = 0;
  while (true) {
    idx = code.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * W4 — sync_content_inner must call `validate_zone_maps(` (M11b spec).
 * The call must appear before the zone_def upsert loop.
 *
 * @param {string} body  Comment-stripped sync_content_inner function body.
 * @returns {string|null}
 */
function checkValidateZoneMaps(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('validate_zone_maps(') === -1) {
    return (
      'sync_content_inner: does not call validate_zone_maps( — ' +
      'M11b requires validating zone maps after load_zone_maps() and before ' +
      'upserting zone_def rows; without this check a malformed zone_map can reach the DB'
    );
  }
  // Ensure validate_zone_maps appears BEFORE zone_def upsert.
  const validateIdx = compact.indexOf('validate_zone_maps(');
  const upsertIdx = compact.indexOf('zone_def()');
  if (upsertIdx !== -1 && validateIdx > upsertIdx) {
    return (
      'sync_content_inner: validate_zone_maps( appears AFTER zone_def() upsert — ' +
      'M11b requires the validation to run BEFORE any zone_def upsert so invalid content is rejected early'
    );
  }
  return null;
}

/**
 * W5 — `ensure_zone_schedules` must appear in both the `init` reducer body
 * AND the public `sync_content` reducer body.
 *
 * @param {string} initBody  Comment-stripped init function body.
 * @param {string} syncBody  Comment-stripped sync_content function body.
 * @returns {string|null}
 */
function checkEnsureZoneSchedulesBothSites(initBody, syncBody) {
  const compactInit = initBody.replace(/\s+/g, '');
  const compactSync = syncBody.replace(/\s+/g, '');
  const needle = 'ensure_zone_schedules(';
  if (compactInit.indexOf(needle) === -1) {
    return (
      'init: does not call ensure_zone_schedules( — ' +
      'M11b replaces the hardcoded ZONE_0 schedule insert with the idempotent ensure_zone_schedules(ctx); ' +
      'missing here means only zone 0 is ever scheduled'
    );
  }
  if (compactSync.indexOf(needle) === -1) {
    return (
      'sync_content: does not call ensure_zone_schedules( — ' +
      'M11b requires calling ensure_zone_schedules(ctx) from sync_content after sync_content_inner ' +
      'so newly-added zones get a schedule row without wiping existing schedules'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixture strings.
// ---------------------------------------------------------------------------

// W1 BAD — movement_tick using zone_map() stub (not map_for).
const BAD_MOVEMENT_TICK_USES_STUB = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let map = zone_map(zone);
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          ctx.db.character().entity_id().update(row);
      }
      Ok(())
  }
`;

// GOOD (W1 + W2 + W3 + W6) — the full sanctioned POST-11r-c shape of
// movement_tick: the real `map_for` pipeline, `warp_at(` detection, the ADR-0168
// D1 drain-time battle lock BEFORE `move_queue.remove(`, and the ADR-0166 D4
// both-role SSOT warp guard (`skip_warp` / `unwrap_or(true)`) AFTER `warp_at(`.
//
// ONE fixture serves four GOOD teeth on purpose: it is the only shape that can
// satisfy all four checks simultaneously, so if a future needle change breaks the
// combination the teeth say so immediately. Required properties, spelled out so a
// later edit cannot quietly void a check: it MUST contain `map_for(`, MUST NOT
// contain `zone_map(` (W1), MUST contain `warp_at(` (W2), MUST call
// `is_in_ongoing_battle(` INSIDE the warp region (W3) AND before
// `move_queue.remove(` (W6).
//
// 14r-f (ADR-0188 §W3): this fixture now carries the POST-item-2 grass tail — a
// `stepped_onto_grass(` trigger followed by the grass block's OWN both-role SSOT
// call. That makes it exercise the narrowed-region branch with BOTH anchors real
// (before 14r-f every fixture here was a truncated body with no grass block at
// all, so only one fixture would ever have taken that path and everything else
// would have silently ridden the no-grass-anchor fallback). Its total
// `is_in_ongoing_battle(` count is THREE — drain lock, warp guard, grass
// pre-check — and exactly ONE of them lies inside the warp region.
const GOOD_MOVEMENT_TICK_MAP_FOR = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = match game_core::load_zone_maps() {
          Ok(zm) => zm,
          Err(e) => { log::error!("zone_maps load failed: {e}"); return Ok(()); }
      };
      let map = match game_core::map_for(zone, &zone_maps) {
          Ok(m) => m,
          Err(e) => { log::error!("map_for failed zone {zone}: {e}"); return Ok(()); }
      };
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() {
              if row.action != ActionState::Idle {
                  row.action = ActionState::Idle;
                  ctx.db.character().entity_id().update(row);
              }
              continue;
          }
          let battle_locked = ctx.db.player().entity_id().filter(id).next()
              .map(|p| is_in_ongoing_battle(ctx, p.identity))
              .unwrap_or(false);
          if battle_locked {
              if row.action != ActionState::Idle {
                  row.action = ActionState::Idle;
                  ctx.db.character().entity_id().update(row);
              }
              continue;
          }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          let entity_id = row.entity_id;
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  let skip_warp = ctx.db.player().entity_id().filter(entity_id).next()
                      .map(|p| is_in_ongoing_battle(ctx, p.identity))
                      .unwrap_or(true);
                  if !skip_warp {
                      row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                      row.move_queue.clear(); row.action = ActionState::Idle;
                      ctx.db.character().entity_id().update(row);
                      continue;
                  }
              }
          }
          ctx.db.character().entity_id().update(row);
          if !stepped_onto_grass(prev, next.pos, &map) {
              continue;
          }
          let Some(player) = ctx.db.player().entity_id().filter(entity_id).next() else {
              continue;
          };
          let player_identity = player.identity;
          let already = is_in_ongoing_battle(ctx, player_identity);
          if already { continue; }
          begin_encounter(ctx, player_identity, zone);
      }
      Ok(())
  }
`;

// W3 BAD (11r-c, ADR-0166 R3) — the RETIRED inline single-role warp guard: a
// `battle().player_identity().filter(..).any(.. BattleOutcome::Ongoing)` scan
// inside the warp branch and no SSOT call anywhere.
//
// This fixture is what the previous GOOD fixture used to contain, and it is the
// whole point of the W3 needle change: under the OLD needle
// (`BattleOutcome::Ongoing` after `warp_at(`) it passed, because the inline scan
// spells the outcome compare out. Under the new `is_in_ongoing_battle(` needle it
// is flagged. Without this fixture the R3 de-vacuification would be unproven.
//
// The bug it encodes is real: `player_identity` matches PvP side A only, so a
// side-B player (recorded as `opponent_identity`) walks through a warp tile
// mid-ranked-battle while the battle row stays Ongoing (ADR-0166 D4).
//
// 14r-f (ADR-0188 §W3): a POST-item-2 grass tail is appended, and it calls the
// both-role SSOT. This fixture therefore now carries an `is_in_ongoing_battle(`
// call — just not one in the warp region — and it must STILL be flagged. That is
// the direct proof that the narrowing EXCLUDES the downstream grass call rather
// than merely tolerating it. Under the retired unscoped "count anywhere after
// warp_at(" strategy this fixture would have started PASSING, i.e. the 11r-c R3
// bite would have silently evaporated; the teeth block asserts the flag survives.
const BAD_MOVEMENT_TICK_INLINE_SINGLE_ROLE_WARP_GUARD = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          let entity_id = row.entity_id;
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  let in_battle = ctx.db.player().entity_id().filter(entity_id).next()
                      .map(|p| ctx.db.battle().player_identity().filter(p.identity)
                          .any(|b| b.state.outcome == BattleOutcome::Ongoing))
                      .unwrap_or(true);
                  if !in_battle {
                      row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                      row.move_queue.clear(); row.action = ActionState::Idle;
                      ctx.db.character().entity_id().update(row);
                      continue;
                  }
              }
          }
          ctx.db.character().entity_id().update(row);
          if !stepped_onto_grass(prev, next.pos, &map) {
              continue;
          }
          let Some(player) = ctx.db.player().entity_id().filter(entity_id).next() else {
              continue;
          };
          let player_identity = player.identity;
          let already = is_in_ongoing_battle(ctx, player_identity);
          if already { continue; }
          begin_encounter(ctx, player_identity, zone);
      }
      Ok(())
  }
`;

// W3 BAD (14r-f, ADR-0188 §W3) — THE HOLLOWING FIXTURE. This is the exact shape
// item 2 of slice 14r-f makes reachable, and the whole reason W3 had to be
// re-scoped:
//   * the ADR-0168 D1 drain lock is present and correct (so W6 passes);
//   * the warp branch's OWN battle guard has been DELETED — a character in an
//     ongoing battle is teleported to another zone (the C1 security finding,
//     fully live);
//   * the grass-encounter pre-check calls the both-role SSOT (ADR-0122 D1 /
//     ADR-0166 R4 closed), which is legitimate and desirable.
//
// Under the retired "count `is_in_ongoing_battle(` anywhere after `warp_at(`"
// strategy this fixture reports PASS (count = 1, contributed entirely by the
// grass block) — W3 would be HOLLOW, green, and worthless. Under the region-
// scoped scan it is FLAGGED. The teeth block asserts BOTH halves of that
// sentence, so a revert to the unscoped shape cannot land quietly.
const BAD_MOVEMENT_TICK_GRASS_SSOT_NO_WARP_GUARD = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let battle_locked = ctx.db.player().entity_id().filter(id).next()
              .map(|p| is_in_ongoing_battle(ctx, p.identity))
              .unwrap_or(false);
          if battle_locked { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          let entity_id = row.entity_id;
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                  row.move_queue.clear(); row.action = ActionState::Idle;
                  ctx.db.character().entity_id().update(row);
                  continue;
              }
          }
          ctx.db.character().entity_id().update(row);
          if !stepped_onto_grass(prev, next.pos, &map) {
              continue;
          }
          let Some(player) = ctx.db.player().entity_id().filter(entity_id).next() else {
              continue;
          };
          let player_identity = player.identity;
          let already = is_in_ongoing_battle(ctx, player_identity);
          if already { continue; }
          begin_encounter(ctx, player_identity, zone);
      }
      Ok(())
  }
`;

// W3 BAD (14r-f, ADR-0188 §W3) — THE SUBSTRING-SWAP FIXTURE. Same deleted warp
// guard, but with NO grass block at all, so `stepped_onto_grass(` is ABSENT and
// the region extractor must take its end-of-body fallback. The ONLY
// `is_in_ongoing_battle(` in the whole body is the ADR-0168 D1 drain lock, which
// sits BEFORE `warp_at(`.
//
// This is the fixture that kills the plausible one-line mis-fix
// `compact.substring(warpAtIdx, grassIdx)`: with `grassIdx === -1`,
// `String.prototype.substring` clamps -1 to 0 and SWAPS the bounds, so the
// "region" becomes everything BEFORE `warp_at(` — which contains the drain
// lock's call — and the check reports PASS with the warp guard deleted. The
// correct `grassIdx === -1 ? compact.length : grassIdx` + `slice` flags it.
const BAD_MOVEMENT_TICK_DRAIN_LOCK_ONLY_NO_WARP_GUARD = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let battle_locked = ctx.db.player().entity_id().filter(id).next()
              .map(|p| is_in_ongoing_battle(ctx, p.identity))
              .unwrap_or(false);
          if battle_locked { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                  row.move_queue.clear(); row.action = ActionState::Idle;
                  ctx.db.character().entity_id().update(row);
                  continue;
              }
          }
          ctx.db.character().entity_id().update(row);
      }
      Ok(())
  }
`;

// W3 BAD (14r-f, red-team BYPASS 4) — THE DECOY WITNESS. A textbook-perfect
// both-role SSOT call sits inside the warp branch, is bound, and is even
// consumed — by a telemetry log. The warp write is UNCONDITIONAL: every
// character teleports, battling or not. The C1 security finding is fully
// reintroduced, and a presence-only W3 reported `pass: true` on it.
//
// This fixture has NO `.unwrap_or(true)`, so it is killed by W3b (the guard
// EXPRESSION needle). Its sibling below keeps `.unwrap_or(true)` and is killed
// by W3c instead — together they prove the two layers are independently
// load-bearing rather than one implying the other.
const BAD_MOVEMENT_TICK_DECOY_TELEMETRY_WARP = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let battle_locked = ctx.db.player().entity_id().filter(id).next()
              .map(|p| is_in_ongoing_battle(ctx, p.identity))
              .unwrap_or(false);
          if battle_locked { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          let entity_id = row.entity_id;
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  let decoy_witness = ctx.db.player().entity_id().filter(entity_id).next()
                      .map(|p| is_in_ongoing_battle(ctx, p.identity));
                  if decoy_witness == Some(true) {
                      log::debug!("warp telemetry probe observed an ongoing battle");
                  }
                  row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                  row.move_queue.clear(); row.action = ActionState::Idle;
                  ctx.db.character().entity_id().update(row);
                  continue;
              }
          }
          ctx.db.character().entity_id().update(row);
          if !stepped_onto_grass(prev, next.pos, &map) {
              continue;
          }
          let Some(player) = ctx.db.player().entity_id().filter(entity_id).next() else {
              continue;
          };
          let player_identity = player.identity;
          let already = is_in_ongoing_battle(ctx, player_identity);
          if already { continue; }
          begin_encounter(ctx, player_identity, zone);
      }
      Ok(())
  }
`;

// W3 BAD (14r-f, red-team BYPASS 4, harder variant) — the SAME ungated write,
// but the witness is spelled EXACTLY like the sanctioned guard, `skip_warp`
// name and `unwrap_or(true)` default included. It therefore SATISFIES W3a and
// W3b, and is caught only by W3c: the value never becomes the branch condition,
// so `row.zone_id = to_zone;` still runs for a character in an ongoing battle.
//
// This is the fixture that makes W3c non-decorative. If a future edit collapses
// W3b and W3c into one needle, this fixture goes green and the C1 finding is
// reachable again.
const BAD_MOVEMENT_TICK_DECOY_WITNESS_UNGATED_WRITE = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let battle_locked = ctx.db.player().entity_id().filter(id).next()
              .map(|p| is_in_ongoing_battle(ctx, p.identity))
              .unwrap_or(false);
          if battle_locked { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          let entity_id = row.entity_id;
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  let skip_warp = ctx.db.player().entity_id().filter(entity_id).next()
                      .map(|p| is_in_ongoing_battle(ctx, p.identity))
                      .unwrap_or(true);
                  log::debug!("warp telemetry probe recorded the skip decision");
                  row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                  row.move_queue.clear(); row.action = ActionState::Idle;
                  ctx.db.character().entity_id().update(row);
                  continue;
              }
          }
          ctx.db.character().entity_id().update(row);
          if !stepped_onto_grass(prev, next.pos, &map) {
              continue;
          }
          let Some(player) = ctx.db.player().entity_id().filter(entity_id).next() else {
              continue;
          };
          let player_identity = player.identity;
          let already = is_in_ongoing_battle(ctx, player_identity);
          if already { continue; }
          begin_encounter(ctx, player_identity, zone);
      }
      Ok(())
  }
`;

// W6 BAD (11r-c, ADR-0168 D1) — the PRE-SLICE real shape: the only
// `is_in_ongoing_battle(` call in the whole reducer is the warp guard, which runs
// AFTER `move_queue.remove(0)` and after `apply_move`/`apply_state` have already
// moved the character. The drain itself is unlocked, so a modified client walks
// mid-battle.
//
// Note this fixture PASSES W3 (its SSOT call sits inside the warp region) — that
// is exactly why W6 must exist as a separate check: W3 scans from `warp_at(`
// onward and is structurally blind to the drain-side guard, which is upstream.
// It deliberately has NO grass block, so it also exercises warpBranchRegion's
// end-of-body fallback branch on a shape that must PASS — the mirror image of
// BAD_MOVEMENT_TICK_DRAIN_LOCK_ONLY_NO_WARP_GUARD, which takes the same branch
// and must FAIL.
const BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          let entity_id = row.entity_id;
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  let skip_warp = ctx.db.player().entity_id().filter(entity_id).next()
                      .map(|p| is_in_ongoing_battle(ctx, p.identity))
                      .unwrap_or(true);
                  if !skip_warp {
                      row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                      row.move_queue.clear(); row.action = ActionState::Idle;
                      ctx.db.character().entity_id().update(row);
                      continue;
                  }
              }
          }
          ctx.db.character().entity_id().update(row);
      }
      Ok(())
  }
`;

// W0 BAD — two definitions of movement_tick in one blob (the decoy-extraction
// hijack, 11r-c red-team HIGH-3). extractFnBody takes the FIRST match, so the
// decoy's harmless body would be handed to W1/W2/W3/W6.
const BAD_TWO_MOVEMENT_TICK_DEFS =
  'pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> { Ok(()) }\n' +
  'pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> { Ok(()) }\n';

// W2 BAD — movement_tick with map_for but no warp_at call.
const BAD_MOVEMENT_TICK_NO_WARP_AT = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          ctx.db.character().entity_id().update(row);
      }
      Ok(())
  }
`;

// W3 BAD — warp branch present but no battle guard.
const BAD_MOVEMENT_TICK_NO_BATTLE_GUARD = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  // DELIBERATELY MISSING: no battle guard before warping!
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                  row.move_queue.clear(); row.action = ActionState::Idle;
                  ctx.db.character().entity_id().update(row);
                  continue;
              }
          }
          ctx.db.character().entity_id().update(row);
      }
      Ok(())
  }
`;

// W4 BAD — sync_content_inner without validate_zone_maps call.
const BAD_SYNC_CONTENT_NO_VALIDATE = `
  pub(crate) fn sync_content_inner(ctx: &ReducerContext) {
      if let Some(cfg) = ctx.db.config().id().find(0) {
          if cfg.content_version == CONTENT_VERSION { return; }
      }
      let zones = match game_core::load_zones() { Ok(z) => z, Err(e) => { log::error!("{e}"); return; } };
      if let Err(e) = game_core::validate_zones(&zones) { log::error!("{e}"); return; }
      let zone_maps = match game_core::load_zone_maps() { Ok(zm) => zm, Err(e) => { log::error!("{e}"); return; } };
      // DELIBERATELY MISSING: no validate_zone_maps call!
      for z in &zones {
          match ctx.db.zone_def().zone_id().find(z.id) {
              Some(_) => { ctx.db.zone_def().zone_id().update(ZoneDefRow { zone_id: z.id, name: z.name.clone(), width: z.width, height: z.height }); }
              None => { ctx.db.zone_def().insert(ZoneDefRow { zone_id: z.id, name: z.name.clone(), width: z.width, height: z.height }); }
          }
      }
  }
`;

// W4 GOOD — sync_content_inner with validate_zone_maps before zone_def.
const GOOD_SYNC_CONTENT_VALIDATE_FIRST = `
  pub(crate) fn sync_content_inner(ctx: &ReducerContext) {
      if let Some(cfg) = ctx.db.config().id().find(0) {
          if cfg.content_version == CONTENT_VERSION { return; }
      }
      let zones = match game_core::load_zones() { Ok(z) => z, Err(e) => { log::error!("{e}"); return; } };
      if let Err(e) = game_core::validate_zones(&zones) { log::error!("{e}"); return; }
      let zone_maps = match game_core::load_zone_maps() { Ok(zm) => zm, Err(e) => { log::error!("{e}"); return; } };
      if let Err(e) = game_core::validate_zone_maps(&zone_maps, &zones) { log::error!("{e}"); return; }
      for z in &zones {
          match ctx.db.zone_def().zone_id().find(z.id) {
              Some(_) => { ctx.db.zone_def().zone_id().update(ZoneDefRow { zone_id: z.id, name: z.name.clone(), width: z.width, height: z.height }); }
              None => { ctx.db.zone_def().insert(ZoneDefRow { zone_id: z.id, name: z.name.clone(), width: z.width, height: z.height }); }
          }
      }
  }
`;

// W5 BAD (init) — init still uses hardcoded ZONE_0 schedule insert, not ensure_zone_schedules.
const BAD_INIT_NO_ENSURE = `
  #[spacetimedb::reducer(init)]
  pub fn init(ctx: &ReducerContext) {
      ctx.db.config().insert(Config { id: 0, content_version: 0 });
      sync_content_inner(ctx);
      ctx.db.movement_tick_schedule().insert(MovementTickSchedule {
          id: 0, zone_id: ZONE_0,
          scheduled_at: ScheduleAt::Interval(Duration::from_millis(STEP_MS.unsigned_abs()).into()),
      });
  }
`;

// W5 BAD (sync_content) — sync_content missing ensure_zone_schedules.
const BAD_SYNC_CONTENT_NO_ENSURE = `
  #[spacetimedb::reducer]
  pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("sync_content is module-only".to_string()); }
      sync_content_inner(ctx);
      Ok(())
  }
`;

// W5 GOOD — both init and sync_content call ensure_zone_schedules.
const GOOD_INIT_WITH_ENSURE = `
  #[spacetimedb::reducer(init)]
  pub fn init(ctx: &ReducerContext) {
      ctx.db.config().insert(Config { id: 0, content_version: 0 });
      sync_content_inner(ctx);
      ensure_zone_schedules(ctx);
  }
`;

const GOOD_SYNC_CONTENT_WITH_ENSURE = `
  #[spacetimedb::reducer]
  pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("sync_content is module-only".to_string()); }
      sync_content_inner(ctx);
      ensure_zone_schedules(ctx);
      Ok(())
  }
`;

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'zone-warp-server-runtime (M11b: movement_tick map_for+warp_at+warp battle-guard; sync_content validate_zone_maps; ensure_zone_schedules; ADR-0020 — 11r-c adds W0 extraction-uniqueness and W6 drain battle lock, ADR-0168; 14r-f region-scopes W3 to the warp branch, ADR-0188 §W3)';

  // =========================================================================
  // PROOFS-OF-TEETH — run before real-source scan.
  // =========================================================================

  // --- Tooth W1 BAD: zone_map() stub must be flagged ---
  {
    const body = extractFnBody(scrubRust(BAD_MOVEMENT_TICK_USES_STUB), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_USES_STUB',
      };
    }
    if (!checkMapForUsed(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_USES_STUB (zone_map stub) was NOT flagged by checkMapForUsed',
      };
    }
  }

  // --- Tooth W1 GOOD: map_for() usage must pass ---
  {
    const body = extractFnBody(scrubRust(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract movement_tick body from GOOD_MOVEMENT_TICK_MAP_FOR',
      };
    }
    const err = checkMapForUsed(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_MOVEMENT_TICK_MAP_FOR was incorrectly flagged by checkMapForUsed: ${err}`,
      };
    }
  }

  // --- Tooth W2 BAD: movement_tick without warp_at must be flagged ---
  {
    const body = extractFnBody(scrubRust(BAD_MOVEMENT_TICK_NO_WARP_AT), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_NO_WARP_AT',
      };
    }
    if (!checkWarpAtCalled(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_NO_WARP_AT (no warp_at) was NOT flagged by checkWarpAtCalled',
      };
    }
  }

  // --- Tooth W2 GOOD: movement_tick with warp_at must pass ---
  {
    const body = extractFnBody(scrubRust(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from GOOD_MOVEMENT_TICK_MAP_FOR (W2 check)',
      };
    }
    const err = checkWarpAtCalled(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_MOVEMENT_TICK_MAP_FOR was incorrectly flagged by checkWarpAtCalled: ${err}`,
      };
    }
  }

  // --- Tooth W3 BAD: warp branch without battle guard must be flagged ---
  {
    const body = extractFnBody(scrubRust(BAD_MOVEMENT_TICK_NO_BATTLE_GUARD), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_NO_BATTLE_GUARD',
      };
    }
    if (!checkWarpBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_NO_BATTLE_GUARD (no battle guard of any kind in the warp ' +
          'branch — no is_in_ongoing_battle( after warp_at() was NOT flagged by ' +
          'checkWarpBattleGuard — kills: C1 security finding: a character in battle must not be ' +
          'warped away',
      };
    }
  }

  // --- Tooth W3 GOOD: warp branch with battle guard must pass ---
  {
    const body = extractFnBody(scrubRust(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from GOOD_MOVEMENT_TICK_MAP_FOR (W3 check)',
      };
    }
    const err = checkWarpBattleGuard(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_MOVEMENT_TICK_MAP_FOR was incorrectly flagged by checkWarpBattleGuard: ${err}`,
      };
    }
  }

  // --- Tooth W3 BAD (11r-c / R3): the retired INLINE SINGLE-ROLE warp guard ---
  // This is the fixture that proves the needle change from `BattleOutcome::Ongoing`
  // to `is_in_ongoing_battle(` actually bites. Under the old needle this snippet
  // PASSED (its inline scan spells the outcome compare out); under the new one it
  // must be flagged, because a single-role `player_identity()` filter sees PvP
  // side A only and lets a side-B player warp mid-ranked-battle (ADR-0166 D4).
  {
    const body = extractFnBody(
      scrubRust(BAD_MOVEMENT_TICK_INLINE_SINGLE_ROLE_WARP_GUARD),
      'movement_tick',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_INLINE_SINGLE_ROLE_WARP_GUARD',
      };
    }
    if (!checkWarpBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_INLINE_SINGLE_ROLE_WARP_GUARD (inline single-role ' +
          'battle().player_identity() scan in the warp branch, no SSOT call there) was NOT ' +
          'flagged by checkWarpBattleGuard — the ADR-0166 R3 de-vacuification is not in effect. ' +
          'Since 14r-f this fixture also carries a grass tail whose pre-check DOES call the SSOT, ' +
          'so a miss here additionally means the ADR-0188 §W3 region narrowing is not excluding ' +
          'the downstream grass call. Kills: a warp guard that sees PvP side A only, letting a ' +
          'side-B player walk through a warp tile mid-ranked-battle',
      };
    }
    // REGRESSION WITNESS (14r-f): the grass tail contributes exactly one
    // post-`warp_at(` SSOT call, so under the RETIRED unscoped strategy this
    // fixture would now PASS and the 11r-c R3 bite would have silently
    // evaporated. Pinning the number makes that claim mechanical rather than a
    // comment nobody re-checks.
    const inlineUnscoped = unscopedCountAfterWarpAtForTeethOnly(body.replace(/\s+/g, ''));
    if (inlineUnscoped !== 1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_INLINE_SINGLE_ROLE_WARP_GUARD must contain EXACTLY ONE ' +
          "is_in_ongoing_battle( after warp_at( — the grass tail's, and nothing else — so it " +
          'demonstrably PASSES the retired unscoped strategy while FAILING the region-scoped one. ' +
          'Measured ' +
          String(inlineUnscoped) +
          '. At 0 the grass tail is gone and this fixture no longer proves the narrowing excludes ' +
          'the downstream call (plan finding R1, trap 1)',
      };
    }
  }

  // --- Tooth W3 STRUCTURE (14r-f, ADR-0188 §W3): the region really narrows ----
  // Before asserting what the region CONTAINS, prove it EXCLUDES what it must.
  // Without this, "the narrowing works" is an assertion about a function nobody
  // has looked inside.
  {
    const body = extractFnBody(scrubRust(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from GOOD_MOVEMENT_TICK_MAP_FOR (W3 region check)',
      };
    }
    const compact = body.replace(/\s+/g, '');
    const scoped = warpBranchRegion(compact);
    if (scoped.error) {
      return {
        name,
        pass: false,
        detail: `TEETH: warpBranchRegion errored on the GOOD fixture: ${scoped.error}`,
      };
    }
    if (!scoped.grassAnchored) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: the GOOD fixture no longer contains a stepped_onto_grass( tail, so the ' +
          'BOTH-ANCHORS-REAL branch of warpBranchRegion is unexercised and every W3 verdict in ' +
          'this file would silently ride the end-of-body fallback (plan finding R1, trap 1)',
      };
    }
    if (scoped.region.indexOf(WARP_ANCHOR) !== 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: the extracted warp region does not START at warp_at(',
      };
    }
    if (scoped.region.indexOf(GRASS_ANCHOR) !== -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: the extracted warp region still CONTAINS stepped_onto_grass( — the region is ' +
          'not bounded at the grass trigger, so every downstream SSOT call is back inside it and ' +
          'the ADR-0188 §W3 fix is cosmetic',
      };
    }
    const inRegion = countNeedle(scoped.region, SSOT_NEEDLE);
    const inBody = countNeedle(compact, SSOT_NEEDLE);
    if (inRegion !== 1 || inBody !== 3) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: GOOD_MOVEMENT_TICK_MAP_FOR must carry exactly 3 is_in_ongoing_battle( calls ' +
          '(drain lock, warp guard, grass pre-check) of which exactly 1 lies inside the warp ' +
          'region — measured ' +
          String(inBody) +
          ' in the body and ' +
          String(inRegion) +
          ' in the region. A region that captures 2 or 3 of them is not narrowed at all',
      };
    }
  }

  // --- Tooth W3 BAD (14r-f / §W3): THE HOLLOWING ---------------------------
  // Warp guard deleted; grass block calls the both-role SSOT. This is the exact
  // shape item 2 of this slice makes reachable, and the reason the unscoped
  // count had to go.
  {
    const body = extractFnBody(
      scrubRust(BAD_MOVEMENT_TICK_GRASS_SSOT_NO_WARP_GUARD),
      'movement_tick',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_GRASS_SSOT_NO_WARP_GUARD',
      };
    }
    if (!checkWarpBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_GRASS_SSOT_NO_WARP_GUARD (warp battle guard DELETED, but the ' +
          'grass-encounter pre-check calls the both-role SSOT downstream) was NOT flagged by ' +
          'checkWarpBattleGuard — W3 is HOLLOW: it reports PASS while the C1 security finding is ' +
          'fully live and a character mid-battle is teleported to another zone. Kills: the ' +
          'retired "count is_in_ongoing_battle( anywhere after warp_at(" strategy, which this ' +
          'fixture satisfies with the grass block alone (ADR-0188 §W3)',
      };
    }
    // REGRESSION WITNESS. Pin the fact the narrowing was NECESSARY: the retired
    // strategy PASSES this fixture. If someone reverts checkWarpBattleGuard to
    // the unscoped count, the tooth above starts failing and this line explains
    // why in one number.
    const unscoped = unscopedCountAfterWarpAtForTeethOnly(body.replace(/\s+/g, ''));
    if (unscoped !== 1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: the hollowing fixture must contain EXACTLY ONE is_in_ongoing_battle( after ' +
          'warp_at( (the grass pre-check, and nothing else) so it demonstrably PASSES the retired ' +
          'unscoped strategy while FAILING the region-scoped one — measured ' +
          String(unscoped) +
          '. If this is 0 the fixture no longer encodes the hollowing at all and the §W3 ' +
          'narrowing is proven by nothing',
      };
    }
  }

  // --- Tooth W3 BAD (14r-f / §W3): THE SUBSTRING-SWAP MIS-FIX ---------------
  // No grass block at all, and the ONLY SSOT call is the drain lock, upstream of
  // warp_at(. A `substring(warpAtIdx, -1)` fallback inverts the region onto that
  // call and reports PASS with the warp guard deleted.
  {
    const body = extractFnBody(
      scrubRust(BAD_MOVEMENT_TICK_DRAIN_LOCK_ONLY_NO_WARP_GUARD),
      'movement_tick',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_DRAIN_LOCK_ONLY_NO_WARP_GUARD',
      };
    }
    const compact = body.replace(/\s+/g, '');
    // Fixture integrity: the hazard only exists if the pre-warp_at text really
    // does contain an SSOT call for an inverted region to latch onto.
    const upstream = compact.slice(0, compact.indexOf(WARP_ANCHOR));
    if (countNeedle(upstream, SSOT_NEEDLE) !== 1 || compact.indexOf(GRASS_ANCHOR) !== -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_DRAIN_LOCK_ONLY_NO_WARP_GUARD must have exactly one ' +
          'is_in_ongoing_battle( BEFORE warp_at( and NO stepped_onto_grass( anywhere — otherwise ' +
          'it cannot exercise the substring clamp-and-swap hazard it exists for (plan finding R1, ' +
          'trap 2, red-team PoC /tmp/w3_hollow_poc.mjs)',
      };
    }
    if (!checkWarpBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_DRAIN_LOCK_ONLY_NO_WARP_GUARD (warp guard deleted, no grass ' +
          'block, only the upstream ADR-0168 D1 drain lock) was NOT flagged by ' +
          'checkWarpBattleGuard. Kills: the plausible one-line mis-fix ' +
          'compact.substring(warpAtIdx, grassIdx) — with grassIdx === -1, substring clamps to 0 ' +
          'and SWAPS the bounds, pointing the scan at everything BEFORE the warp branch, where ' +
          'the drain lock lives. The fallback must be an explicit ' +
          'grassIdx === -1 ? compact.length : grassIdx with String.prototype.slice',
      };
    }
  }

  // --- Tooth W3b (14r-f / BYPASS 4): THE DECOY TELEMETRY WITNESS ------------
  // A perfect SSOT call inside the warp branch, consumed by a log line, with an
  // UNCONDITIONAL warp write. W3a (presence) reports PASS on this; W3b must not.
  {
    const body = extractFnBody(scrubRust(BAD_MOVEMENT_TICK_DECOY_TELEMETRY_WARP), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_DECOY_TELEMETRY_WARP',
      };
    }
    const scoped = warpBranchRegion(body.replace(/\s+/g, ''));
    if (scoped.error || countNeedle(scoped.region, SSOT_NEEDLE) === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_DECOY_TELEMETRY_WARP must CONTAIN an is_in_ongoing_battle( ' +
          'call inside the warp region — otherwise it is killed by the trivial W3a presence ' +
          'count and proves nothing about W3b (the failure must be attributable to the guard ' +
          'EXPRESSION needle, not to the call being missing)',
      };
    }
    if (!checkWarpBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_DECOY_TELEMETRY_WARP (textbook-perfect both-role SSOT call ' +
          'bound to `decoy_witness`, consumed by a telemetry log, while row.zone_id = to_zone runs ' +
          'UNCONDITIONALLY) was NOT flagged by checkWarpBattleGuard. This is red-team BYPASS 4: ' +
          'W3 degenerates to "the predicate is mentioned somewhere in the warp branch" and reports ' +
          'PASS with the C1 security finding fully live — every character warps, battling or not. ' +
          'Kills: presence mistaken for a guard. The close is the ported movement_tests.rs E3 ' +
          'layer-1 needle ' +
          WARP_GUARD_EXPR_NEEDLE,
      };
    }
  }

  // --- Tooth W3c (14r-f / BYPASS 4, harder): VALUE MUST BE THE CONDITION -----
  // Same ungated write, but the witness is spelled EXACTLY like the sanctioned
  // guard — `skip_warp`, `unwrap_or(true)` and all. It satisfies W3a AND W3b;
  // only W3c can see that the value never gates anything.
  {
    const body = extractFnBody(
      scrubRust(BAD_MOVEMENT_TICK_DECOY_WITNESS_UNGATED_WRITE),
      'movement_tick',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_DECOY_WITNESS_UNGATED_WRITE',
      };
    }
    const scoped = warpBranchRegion(body.replace(/\s+/g, ''));
    if (scoped.error || scoped.region.indexOf(WARP_GUARD_EXPR_NEEDLE) === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_DECOY_WITNESS_UNGATED_WRITE must SATISFY the W3b guard-' +
          'expression needle so its rejection is attributable to W3c (the value-is-the-condition ' +
          'layer) alone. Without that, W3c is unproven and could be deleted or folded into W3b ' +
          'with nothing going red',
      };
    }
    if (!checkWarpBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_DECOY_WITNESS_UNGATED_WRITE (a guard expression that is ' +
          'letter-perfect — `skip_warp`, p.identity, unwrap_or(true) — whose value is then merely ' +
          'LOGGED while the warp write runs unconditionally) was NOT flagged by ' +
          'checkWarpBattleGuard. Kills: a W3 that pins the guard EXPRESSION but never checks that ' +
          'anything BRANCHES on it. The close is the ported movement_tests.rs E3 layer-1b needle ' +
          WARP_GUARD_BRANCH_NEEDLE,
      };
    }
  }

  // --- Tooth W3: a missing START anchor must FAIL LOUD, never pass vacuously --
  {
    const body = extractFnBody(scrubRust(BAD_MOVEMENT_TICK_NO_WARP_AT), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_NO_WARP_AT (W3 anchor check)',
      };
    }
    const err = checkWarpBattleGuard(body);
    if (!err || err.indexOf('warp_at( not found') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: a movement_tick body with NO warp_at( did not produce the loud ' +
          '"warp_at( not found" failure from checkWarpBattleGuard — a region-scoped check whose ' +
          'start anchor is gone must fail, not silently scan an empty region and pass',
      };
    }
  }

  // --- Tooth W6 BAD: guard only in the warp branch (the pre-11r-c shape) ---
  {
    const body = extractFnBody(
      scrubRust(BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH),
      'movement_tick',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH',
      };
    }
    if (!checkDrainBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH — whose only SSOT call sits in the ' +
          'warp branch, after move_queue.remove(0) — was NOT flagged by checkDrainBattleGuard. ' +
          'Kills: ADR-0168 D1 / spec E1: the DRAIN must be locked, not just the warp; a battle ' +
          'check that runs after the drain has already consumed the input and moved the character',
      };
    }
    // Cross-check that makes the independence of W6 explicit: this same fixture
    // must PASS W3 (its SSOT call IS after warp_at). If it ever started failing
    // W3 too, the two checks would have collapsed into one and W6 would prove
    // nothing beyond W3.
    if (checkWarpBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH was flagged by checkWarpBattleGuard — ' +
          'it must PASS W3 (its guard is in the warp branch) and FAIL W6 (the drain is unlocked). ' +
          'If it fails both, W3 and W6 are no longer independent and the teeth of W6 are unproven',
      };
    }
  }

  // --- Tooth W6 GOOD: drain lock before move_queue.remove( must pass ---
  {
    const body = extractFnBody(scrubRust(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from GOOD_MOVEMENT_TICK_MAP_FOR (W6 check)',
      };
    }
    const err = checkDrainBattleGuard(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_MOVEMENT_TICK_MAP_FOR was incorrectly flagged by checkDrainBattleGuard: ${err}`,
      };
    }
  }

  // --- Tooth W0: definition-uniqueness counter must count 2 and 1 ---
  {
    const twoDefs = countFnDefinitions(BAD_TWO_MOVEMENT_TICK_DEFS, 'movement_tick');
    if (twoDefs !== 2) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: countFnDefinitions returned ' +
          String(twoDefs) +
          ' (expected 2) for BAD_TWO_MOVEMENT_TICK_DEFS — the counter is broken, so the ' +
          'ambiguous-extraction guard protecting W1/W2/W3/W6 would never fire',
      };
    }
    const oneDef = countFnDefinitions(GOOD_MOVEMENT_TICK_MAP_FOR, 'movement_tick');
    if (oneDef !== 1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: countFnDefinitions returned ' +
          String(oneDef) +
          ' (expected 1) for GOOD_MOVEMENT_TICK_MAP_FOR — false positive; the ' +
          'ambiguous-extraction guard would fail a correct source tree',
      };
    }
  }

  // --- Tooth W4 BAD: sync_content_inner without validate_zone_maps must be flagged ---
  {
    const body = extractFnBody(scrubRust(BAD_SYNC_CONTENT_NO_VALIDATE), 'sync_content_inner');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract sync_content_inner body from BAD_SYNC_CONTENT_NO_VALIDATE',
      };
    }
    if (!checkValidateZoneMaps(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_SYNC_CONTENT_NO_VALIDATE (no validate_zone_maps) was NOT flagged by checkValidateZoneMaps',
      };
    }
  }

  // --- Tooth W4 GOOD: sync_content_inner with validate_zone_maps before zone_def must pass ---
  {
    const body = extractFnBody(scrubRust(GOOD_SYNC_CONTENT_VALIDATE_FIRST), 'sync_content_inner');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract sync_content_inner body from GOOD_SYNC_CONTENT_VALIDATE_FIRST',
      };
    }
    const err = checkValidateZoneMaps(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_SYNC_CONTENT_VALIDATE_FIRST was incorrectly flagged by checkValidateZoneMaps: ${err}`,
      };
    }
  }

  // --- Tooth W5 BAD (init): init without ensure_zone_schedules must be flagged ---
  {
    const initBody = extractFnBody(scrubRust(BAD_INIT_NO_ENSURE), 'init');
    const syncBody = extractFnBody(scrubRust(GOOD_SYNC_CONTENT_WITH_ENSURE), 'sync_content');
    if (!initBody || !syncBody) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract init or sync_content body from W5 BAD-init fixtures',
      };
    }
    if (!checkEnsureZoneSchedulesBothSites(initBody, syncBody)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_INIT_NO_ENSURE (init missing ensure_zone_schedules) was NOT flagged by checkEnsureZoneSchedulesBothSites',
      };
    }
  }

  // --- Tooth W5 BAD (sync_content): sync_content without ensure_zone_schedules must be flagged ---
  {
    const initBody = extractFnBody(scrubRust(GOOD_INIT_WITH_ENSURE), 'init');
    const syncBody = extractFnBody(scrubRust(BAD_SYNC_CONTENT_NO_ENSURE), 'sync_content');
    if (!initBody || !syncBody) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract init or sync_content body from W5 BAD-sync fixtures',
      };
    }
    if (!checkEnsureZoneSchedulesBothSites(initBody, syncBody)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_SYNC_CONTENT_NO_ENSURE (sync_content missing ensure_zone_schedules) was NOT flagged by checkEnsureZoneSchedulesBothSites',
      };
    }
  }

  // --- Tooth W5 GOOD: both init and sync_content with ensure_zone_schedules must pass ---
  {
    const initBody = extractFnBody(scrubRust(GOOD_INIT_WITH_ENSURE), 'init');
    const syncBody = extractFnBody(scrubRust(GOOD_SYNC_CONTENT_WITH_ENSURE), 'sync_content');
    if (!initBody || !syncBody) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract bodies from GOOD_INIT_WITH_ENSURE / GOOD_SYNC_CONTENT_WITH_ENSURE',
      };
    }
    const err = checkEnsureZoneSchedulesBothSites(initBody, syncBody);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD ensure_zone_schedules fixtures were incorrectly flagged: ${err}`,
      };
    }
  }

  // =========================================================================
  // REAL-SOURCE SCAN — apply all checks to the actual server-module source.
  // =========================================================================

  const serverSrc = join(__dirname, '..', 'server-module', 'src');
  let src;
  let quoteLandmines = [];
  try {
    const read = readServerModuleSources(serverSrc);
    src = read.src;
    quoteLandmines = read.quoteLandmines;
  } catch (e) {
    return { name, pass: false, detail: `cannot read server-module/src: ${e.message}` };
  }

  const failures = [];
  const checks = [];

  // Appended to every "reducer not found" failure below. An empty extraction is
  // almost never a deleted reducer — it is the scan pipeline having blanked it.
  const blankingHint =
    ' If the reducer plainly exists in the source, the SCAN blanked it: look for an unpaired ' +
    'block-comment opener, or a double-quote inside a char / byte-char literal (spell it 0x22 ' +
    'in Rust — the string stripper has no char-literal lexer). Files carrying a char-literal ' +
    'double-quote: ' +
    (quoteLandmines.length > 0 ? quoteLandmines.join(', ') : 'none') +
    ' (harmless while scrubbing is per-file).';

  // --- W-pre: no char-literal double-quote in a PRODUCTION source ------------
  // Scrubbing is per file, so a landmine can only misalign the file that holds
  // it — which is fine for a test file and fatal for one this eval extracts from
  // (`movement.rs`, `lib.rs`, `content.rs`). Production files are clean today;
  // this makes any reintroduction there a loud, attributable failure rather than
  // a mysteriously "missing" reducer. Deliberately NOT applied to `*_tests.rs`:
  // four of them have carried this spelling for many slices, they are outside
  // this slice's touch set, and per-file scrubbing already neutralised them.
  const productionLandmines = quoteLandmines.filter((f) => !f.endsWith('_tests.rs'));
  if (productionLandmines.length > 0) {
    const wPre =
      'char-literal double-quote in production source (' +
      productionLandmines.join(', ') +
      '): a lone double-quote inside a char or byte-char literal is read as a string opener by ' +
      'stripRustStrings, which inverts string/code polarity for the rest of THAT file and can ' +
      'blank the very reducer being checked. Spell it as a 0x22 constant in the Rust source.';
    failures.push(wPre);
    checks.push({
      check: 'W-pre no char-literal quote in production source',
      pass: false,
      detail: wPre,
    });
  } else {
    checks.push({
      check: 'W-pre no char-literal quote in production source',
      pass: true,
      detail: 'ok',
    });
  }

  // --- W0: movement_tick must be defined EXACTLY ONCE, BEFORE any extraction ---
  // extractFnBody takes the FIRST `pub fn movement_tick(` in the concatenated
  // blob, so a decoy definition — in an alphabetically-earlier file, or earlier
  // in movement.rs itself — silently redirects W1/W2/W3/W6 at a body that is not
  // the real reducer (11r-c red-team HIGH-3). Precedent: battle-reducer-security
  // C3's countFnDefinitions SSOT guard.
  const movementTickDefs = countFnDefinitions(src, 'movement_tick');
  if (movementTickDefs !== 1) {
    const w0 =
      'ambiguous extraction: found ' +
      String(movementTickDefs) +
      ' definitions of fn movement_tick( across server-module/src (expected exactly 1, in movement.rs). ' +
      'A count of 0 means the reducer was renamed or moved (W1/W2/W3/W6 would silently stop ' +
      'checking anything); a count above 1 means extractFnBody — which takes the FIRST match — ' +
      'may be scanning a decoy body while the real movement_tick goes unchecked. Either way every ' +
      'W1/W2/W3/W6 result below is untrustworthy (11r-c red-team HIGH-3; precedent: ' +
      'battle-reducer-security C3).';
    failures.push(w0);
    checks.push({ check: 'W0 movement_tick defined exactly once', pass: false, detail: w0 });
  } else {
    checks.push({ check: 'W0 movement_tick defined exactly once', pass: true, detail: 'ok' });
  }

  // --- W1 + W2 + W3 + W6: movement_tick body ---
  const movementTickBody = extractFnBody(src, 'movement_tick');
  if (!movementTickBody) {
    failures.push('movement_tick: reducer not found in server-module source.' + blankingHint);
    checks.push({ check: 'W1', pass: false, detail: 'movement_tick not found' });
    checks.push({ check: 'W2', pass: false, detail: 'movement_tick not found' });
    checks.push({ check: 'W3', pass: false, detail: 'movement_tick not found' });
    checks.push({ check: 'W6', pass: false, detail: 'movement_tick not found' });
  } else {
    const w1 = checkMapForUsed(movementTickBody);
    checks.push({ check: 'W1 map_for used (not zone_map stub)', pass: !w1, detail: w1 ?? 'ok' });
    if (w1) failures.push(w1);

    const w2 = checkWarpAtCalled(movementTickBody);
    checks.push({ check: 'W2 warp_at called', pass: !w2, detail: w2 ?? 'ok' });
    if (w2) failures.push(w2);

    const w3 = checkWarpBattleGuard(movementTickBody);
    checks.push({ check: 'W3 warp branch battle guard (SSOT)', pass: !w3, detail: w3 ?? 'ok' });
    if (w3) failures.push(w3);

    // W6 (11r-c, ADR-0168 D1): RED until the implementer adds the drain-time lock.
    const w6 = checkDrainBattleGuard(movementTickBody);
    checks.push({
      check: 'W6 drain battle lock before move_queue.remove(',
      pass: !w6,
      detail: w6 ?? 'ok',
    });
    if (w6) failures.push(w6);
  }

  // --- W4: sync_content_inner body ---
  const syncInnerBody = extractFnBody(src, 'sync_content_inner');
  if (!syncInnerBody) {
    failures.push('sync_content_inner: function not found in server-module source.' + blankingHint);
    checks.push({ check: 'W4', pass: false, detail: 'sync_content_inner not found' });
  } else {
    const w4 = checkValidateZoneMaps(syncInnerBody);
    checks.push({
      check: 'W4 validate_zone_maps before zone_def upsert',
      pass: !w4,
      detail: w4 ?? 'ok',
    });
    if (w4) failures.push(w4);
  }

  // --- W5: init body + sync_content body ---
  const initBody = extractFnBody(src, 'init');
  const syncContentBody = extractFnBody(src, 'sync_content');
  if (!initBody) {
    failures.push('init: reducer not found in server-module source.' + blankingHint);
    checks.push({ check: 'W5', pass: false, detail: 'init not found' });
  } else if (!syncContentBody) {
    failures.push('sync_content: reducer not found in server-module source.' + blankingHint);
    checks.push({ check: 'W5', pass: false, detail: 'sync_content not found' });
  } else {
    const w5 = checkEnsureZoneSchedulesBothSites(initBody, syncContentBody);
    checks.push({
      check: 'W5 ensure_zone_schedules in init + sync_content',
      pass: !w5,
      detail: w5 ?? 'ok',
    });
    if (w5) failures.push(w5);
  }

  const allPass = failures.length === 0;
  return {
    name,
    pass: allPass,
    checks,
    detail: allPass
      ? 'W-pre + W0-W6 all pass: production source free of char-literal quote landmines; movement_tick uniquely defined; map_for+warp_at+SSOT warp guard (scanned in the warp REGION warp_at( .. stepped_onto_grass(, ADR-0188 §W3)+drain battle lock in movement_tick; validate_zone_maps in sync_content_inner; ensure_zone_schedules in init+sync_content (teeth: 32 fixture checks verified — 17 pre-14r-f, 11 pinning the ADR-0188 §W3 region narrowing (the region excludes the grass trigger; the hollowing and substring-swap fixtures are both flagged; two regression witnesses record that the retired unscoped strategy would have passed them; a missing warp_at( anchor fails loud), and 4 closing red-team BYPASS 4 (a decoy telemetry witness beside an unconditional warp write is flagged by the ported E3 guard-expression needle, and a letter-perfect witness whose value is only logged is flagged by the ported value-is-the-branch-condition needle))'
      : failures.join('; '),
  };
}
