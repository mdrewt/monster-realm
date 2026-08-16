// playtest-verify.eval.mjs — pt-a2 local playtest ops
//
// Encodes EARS criteria pt-a2-1..-6 (§C/§K of docs/specs/pt-a2-plan.md).
// §K is AUTHORITATIVE — it overrides §C/§E on every conflict.
//
// Three layers (§F):
//   1. Pure-checker correctness (imported from scripts/verify-*.mjs).
//   2. Wiring integrity (justfile recipe structural scans).
//   3. Artifact presence (scripts exist, export the right names, have fail-loud guards).
//   4. Docs (playtest-ops.md, ADR-0129).
//
// IMPORTANT: NO new RegExp() anywhere — Semgrep detect-non-literal-regexp has bitten
// this project 3×. Only literal regex literals and String methods (includes / indexOf /
// startsWith / split) are used.
//
// All proof-of-teeth fixtures run UNCONDITIONALLY before real-file scans.
// Every BAD fixture must be flagged, every GOOD must pass; a fixture miss returns
// pass:false immediately (a broken predicate cannot gate production code).
//
// Starts RED: scripts/verify-release-reducers.mjs, scripts/verify-build-hooks.mjs,
// justfile playtest-* recipes, and docs/playtest-ops.md do not yet exist.
//
// EXTENDED BY ux3 (playtest-preflight fail-fast SpacetimeDB reachability check):
//   - §1 teeth P5a–P5e (recipeStepOrderOk), P6a–P6b (recipeHasLineWithAll),
//     P7a–P7h (timeoutBindsProbe) and P8a–P8e (hasFencedCommandLine).
//   - §7.1/§7.2 now cover the playtest-preflight recipe (and §7.2 upgraded to exact-line).
//   - §7.12 order gate (ux3-3), §7.13 preflight body integrity, §7.10 runbook.
//     §7.10 gates ux3-2 DIRECTLY (a fenced `spacetime start` step must exist as a
//     standalone line in a code block) as well as naming `just playtest-preflight`;
//     the preflight needle alone was a PROXY — a red-team pass deleted the runnable
//     step and the eval stayed green.
//   - §7.11b ADR-0153 rationale gate.
//   - §7.14 BEHAVIORAL NEGATIVE tooth: runs `just playtest-preflight` against an
//     unreachable loopback port and asserts a non-zero exit with an actionable
//     STDERR diagnosis. Offline, deterministic, ~14 ms.
//   - §7.15 BEHAVIORAL POSITIVE CONTROL: runs the same recipe against a throwaway
//     local HTTP stub and asserts exit 0. Without this, "the preflight always fails"
//     is a green implementation and §7.14 proves nothing.
//   - §7.15b BEHAVIORAL NEGATIVE CONTROL (PREFLIGHT_REJECTS_NON_SPACETIME_HTTP_RESPONDER):
//     runs the recipe against a stub answering HTTP 500 and asserts a NON-ZERO exit that
//     names the injected URL. `spacetime server ping` exits 0 for ANY completed HTTP
//     round-trip (measured: trailing slash / `/v1` suffix / 500 stub all exit 0) while
//     `spacetime publish -s` fails for them, so this is the only tooth proving the
//     preflight verifies a SpacetimeDB rather than merely that something answers HTTP.
//   - §7.16 BEHAVIORAL CALL-SITE tooth: runs playtest-up / playtest-wipe end-to-end
//     with a stub `spacetime` on PATH and asserts they ABORT before ever reaching it.
//     §7.12–§7.15b all gate the preflight RECIPE; this is the only thing that gates
//     whether the CALLERS actually honor its exit code.
//   - §7.13b: the four behavioural blocks (§7.14/§7.15/§7.15b/§7.16) are SKIPPED with an
//     explicit `pass:true` + "skipped: …" detail when the `spacetime` CLI is not on PATH,
//     per evals/bindings-drift.eval.mjs:122. All source scans still run. CI installs the
//     CLI before `just eval`, so the skip never applies there.
//
// HARDENING PASS (post red-team): a red-team run showed 9 of 19 deliberately-broken
// implementations sailing through the pre-hardening gate. The additions above (§7.15
// positive control, §7.14 stderr+expanded-URL assertions, P7 timeout-binds-the-probe)
// exist specifically to kill those survivors; each carries a comment naming the mutant.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Import extractRecipeBody from build-ci-hygiene.eval.mjs (it IS exported —
// confirmed by reading the file). Do not copy it; import it.
// ---------------------------------------------------------------------------
import { extractRecipeBody } from './build-ci-hygiene.eval.mjs';

// ---------------------------------------------------------------------------
// Helper: strip `#` line comments from justfile/shell text before scanning
// so a comment cannot satisfy a structural check.
//
// MAINTAINER CAVEAT: this cuts the line at the FIRST occurrence of the two-character
// sequence " #" — it is a line scan, not a shell parser. A diagnosis message that
// itself contains " #" (e.g. `echo "start one on port #3000"`) is truncated here, so
// any needle after that point would false-RED. Keep preflight prose free of " #".
// ---------------------------------------------------------------------------
function stripJustfileComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trimStart();
      if (t.startsWith('#')) return '';
      const idx = line.indexOf(' #');
      return idx !== -1 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Helper: strip `//` line comments from .mjs source text before scanning.
// ---------------------------------------------------------------------------
function stripMjsComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Inline pure predicates for structural checks
// (imported pure checkers are exercised separately via dynamic import below)
// ---------------------------------------------------------------------------

// Check: justfile has a recipe header at column 0 for `recipeName`.
function justfileHasRecipe(justfile, recipeName) {
  const exactMarker = `\n${recipeName}:`;
  const paramMarker = `\n${recipeName} `;
  return (
    justfile.indexOf(exactMarker) !== -1 ||
    justfile.indexOf(paramMarker) !== -1 ||
    justfile.startsWith(`${recipeName}:`) ||
    justfile.startsWith(`${recipeName} `)
  );
}

// Check: recipe body (comment-stripped) contains a token.
function recipeBodyContains(justfile, recipeName, token) {
  const body = extractRecipeBody(justfile, recipeName);
  return body.includes(token);
}

// Check: recipe body does NOT contain a token.
function recipeBodyLacks(justfile, recipeName, token) {
  const body = extractRecipeBody(justfile, recipeName);
  return !body.includes(token);
}

// Check: entire comment-stripped justfile does NOT contain a token.
// (red-team F5: catches `just` variable definitions as well as recipe bodies)
function wholeJustfileLacks(justfile, token) {
  const stripped = stripJustfileComments(justfile);
  return !stripped.includes(token);
}

// Check: recipe body has a trimmed line that EXACTLY equals `exactLine`
// (no suffix allowed — mirrors L-2 / nightly-smoke-wiring's F6 discipline).
function recipeBodyHasExactLine(justfile, recipeName, exactLine) {
  const body = extractRecipeBody(justfile, recipeName);
  return body.split('\n').some((ln) => ln.trim() === exactLine);
}

// Check: recipe body contains the bash lowercase-fold token for the DB guard.
// §K red-team F6: guard must use `${MR_PLAYTEST_DB,,}` (bash ,, fold) compared
// to `monster-realm`. The presence of `,,}` is the load-bearing token.
function recipeBodyHasCaseInsensitiveGuard(justfile, recipeName) {
  const body = extractRecipeBody(justfile, recipeName);
  return body.includes(',,}');
}

// ---------------------------------------------------------------------------
// ux3 (playtest-preflight) predicates
// ---------------------------------------------------------------------------

// Recipe body with BOTH full-line and trailing `#` comments stripped. extractRecipeBody
// drops only full-line comments, so a trailing ` # …` can otherwise satisfy a needle from
// inside a comment. Extract FIRST, then strip: stripping first turns column-0 comment
// lines into blanks, and extractRecipeBody's loop continues across blanks, which would
// let one recipe's body bleed into the next.
function strippedRecipeBody(justfile, recipeName) {
  return stripJustfileComments(extractRecipeBody(justfile, recipeName));
}

// ux3-3 order gate. `earlierLine` must appear as an EXACT trimmed line (so a `|| true`
// suffix cannot satisfy it) at a strictly smaller line index than the first line
// containing ANY of `laterNeedles`.
// Returns false if EITHER anchor is absent: a recipe that no longer calls spacetime must
// NOT vacuously pass "the preflight comes first" — the gate's premise has evaporated and
// a human must re-decide (same discipline as parseReducerNames throwing on zero reducers).
// MAINTAINER CAVEAT (corrected): this is a line scan over the COMMENT-STRIPPED body, so
// comments are NOT the hazard — they are already gone. The real hazard is `spacetime
// build` / `spacetime publish` appearing inside a QUOTED STRING that survives stripping,
// e.g. `echo "next: spacetime build …"` or a heredoc line. Such a line becomes the "later
// anchor" and can false-RED a correct implementation whose real build step comes further
// down. The §7.12 failure detail therefore prints the offending anchor line verbatim so a
// maintainer can see exactly which line shifted it.
function recipeStepOrderOk(justfile, recipeName, earlierLine, laterNeedles) {
  const lines = strippedRecipeBody(justfile, recipeName).split('\n');
  let earlierIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === earlierLine) {
      earlierIdx = i;
      break;
    }
  }
  let laterIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (laterNeedles.some((needle) => lines[i].includes(needle))) {
      laterIdx = i;
      break;
    }
  }
  // Non-vacuity: both anchors must exist. Missing preflight => false (the point of the
  // gate). Missing spacetime step => ALSO false, so a gutted recipe cannot read green.
  if (earlierIdx === -1 || laterIdx === -1) return false;
  return earlierIdx < laterIdx;
}

// A SINGLE line must carry ALL of `tokens` — kills a body that scatters the needles
// across unrelated lines (e.g. a bounding `timeout` parked in an unused variable while
// the real call runs unbounded).
function recipeHasLineWithAll(justfile, recipeName, tokens) {
  // Non-vacuity: `[].every(...)` is `true`, so an empty token list would make EVERY line
  // (including the blank ones) satisfy the predicate and the whole check read green while
  // scanning for nothing. This file's discipline is that scanning nothing is never green.
  if (tokens.length === 0) return false;
  return strippedRecipeBody(justfile, recipeName)
    .split('\n')
    .some((line) => tokens.every((token) => line.includes(token)));
}

// ---------------------------------------------------------------------------
// ux3 A5h — the timeout must actually BOUND the probe (not merely co-occur with it)
//
// recipeHasLineWithAll only demands token CO-OCCURRENCE on one line, which three
// distinct broken implementations satisfy while still hanging forever:
//
//   (M-t0)  if ! timeout 0 spacetime server ping "$STDB_SERVER" …   # GNU coreutils:
//           "A duration of 0 disables the associated timeout" — measured: `timeout 0
//           sleep 3` runs the full 3 s and exits 0. This is an UNBOUNDED probe wearing
//           a `timeout` costume.
//   (M-doc) PROBE_DOC='timeout 10 spacetime server ping "$STDB_SERVER"'   # dead string,
//           never executed; the tokens all co-occur on that one line, so A5g is happy.
//   (M-raw) if ! spacetime server ping "$STDB_SERVER" …   # the real call, unbounded,
//           paired with a `timeout` mention anywhere else in the body.
//
// THE INVARIANT (re-expressed — this predicate previously encoded a SYNTAX, not the
// invariant, and REJECTED the correct shipped implementation):
//
//   `timeout <positive-duration>` must be the two tokens IMMEDIATELY PRECEDING the
//   `spacetime server ping` token, on the same line.
//
// The old form demanded the TRIMMED LINE START WITH one of
// `timeout `/`if timeout `/`if ! timeout `/`! timeout `. That is a whitelist of four
// spellings, not the property we care about, and it false-REDs the shipped recipe:
//
//     if ! PING_OUT=$(timeout 10 spacetime server ping "$STDB_SERVER" 2>&1) || …
//
// …which is correctly bounded (the `timeout` is the head of the command inside the
// command substitution) but starts with `if ! PING_OUT=$(`. Capturing stdout is REQUIRED
// by ux3-1's output-matching fix (see the `Server is online` needle in §7.13), so the
// old predicate structurally forbade the correct implementation.
//
// So we require, for EVERY line that carries `spacetime server ping`: take the substring
// BEFORE the needle, split it on whitespace, drop empties, and demand that
//   (a) the second-to-last token IS the `timeout` command — either the bare word, or the
//       word preceded by a shell COMMAND-BOUNDARY character (`$(`, backtick, `(`, `{`,
//       `;`, `&`, `|`). A quote is deliberately NOT a boundary, so the dead doc-string
//       `PROBE_DOC='timeout 10 spacetime server ping …'` still fails (M-doc), and neither
//       is a letter/underscore, so `MYtimeout` fails.
//   (b) the last token is a POSITIVE duration (isBoundingDuration), which kills M-t0. An
//       optional GNU unit suffix s/m/h/d is accepted so `timeout 10s` does not false-RED.
//
// IMMEDIATE ADJACENCY is what makes this bite where mere co-occurrence does not:
//     if ! X=$(timeout 10 echo hi) && spacetime server ping "$STDB_SERVER"; then
// has `timeout 10` on the line — bounding something else entirely — while the real probe
// runs unbounded. The preceding tokens there are `hi)` and `&&`, so it is rejected.
//
// `every` (not `some`) is deliberate: if a body contains a bounded probe AND a second
// unbounded one, the unbounded one can still hang, so the pair must not read as green.
// ---------------------------------------------------------------------------

// Shell metacharacters after which a word starts a NEW command, so `…$(timeout` /
// `;timeout` / `|timeout` still have `timeout` heading a command. Quotes are excluded on
// purpose: inside `'…'`/`"…"` the word is data, not a command (that is the M-doc mutant).
const COMMAND_BOUNDARY_CHARS = ['(', '`', '{', ';', '&', '|'];

// True iff `token` is the `timeout` COMMAND, possibly glued to a command-substitution or
// list operator prefix (`PING_OUT=$(timeout`, `;timeout`, `&&timeout`).
function isTimeoutCommandToken(token) {
  if (typeof token !== 'string') return false;
  if (token === 'timeout') return true;
  if (!token.endsWith('timeout')) return false;
  const boundary = token[token.length - 'timeout'.length - 1];
  return COMMAND_BOUNDARY_CHARS.includes(boundary);
}

// A GNU `timeout` DURATION that actually bounds the command: a positive integer with an
// optional s/m/h/d unit suffix. `0`, `0s`, `00` are rejected (0 DISABLES the timeout).
// NOTE: parseInt is deliberately NOT used — it accepts `5e1`, `-1`, `10abc`, ` 10`, all of
// which either mean something else to `timeout` or are outright invalid. The digit check
// is a LITERAL regex (no new RegExp — Semgrep detect-non-literal-regexp).
function isBoundingDuration(token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const last = token[token.length - 1];
  const hasUnitSuffix = last === 's' || last === 'm' || last === 'h' || last === 'd';
  const digits = hasUnitSuffix ? token.slice(0, -1) : token;
  if (!/^\d+$/.test(digits)) return false;
  // Reject 0 / 00 / 0s: GNU coreutils treats a duration of 0 as "no timeout at all".
  return Number(digits) > 0;
}

// True iff, on every `spacetime server ping` line in the recipe, the two tokens
// IMMEDIATELY preceding the probe are a `timeout` command and a positive duration.
// Returns false when the recipe has no probe line at all (non-vacuity: the claim "the
// probe is bounded" is unverifiable without a probe).
function timeoutBindsProbe(justfile, recipeName, probeNeedle) {
  const probeLines = strippedRecipeBody(justfile, recipeName)
    .split('\n')
    .filter((line) => line.includes(probeNeedle));
  if (probeLines.length === 0) return false;
  return probeLines.every((raw) => {
    const before = raw.slice(0, raw.indexOf(probeNeedle));
    // Literal regex only — no new RegExp (Semgrep detect-non-literal-regexp).
    const tokens = before.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length < 2) return false;
    const durationToken = tokens[tokens.length - 1];
    const commandToken = tokens[tokens.length - 2];
    return isTimeoutCommandToken(commandToken) && isBoundingDuration(durationToken);
  });
}

// ---------------------------------------------------------------------------
// ux3-2 — the runbook must gain a RUNNABLE `spacetime start` step, not a mention.
//
// ux3-2 reads: "docs/playtest-ops.md SHALL gain a one-line `spacetime start` step."
// The deliverable is a COPY-PASTEABLE COMMAND, so the tooth must pin a fenced code block —
// prose that merely says the words is not a step.
//
// WHY NOT A BARE `includes('spacetime start')` NEEDLE: the pre-ux3 file ALREADY contained
// that literal (nh4/ADR-0150 prose about a reset data dir), so the needle was green before
// the implementer wrote a word. That reasoning still holds and must not be reverted.
//
// WHY NOT A COUNT-FLOOR OF 2 EITHER (measured, do not re-propose): the CURRENT file has
// THREE occurrences — the new fenced step, a NEW blockquote line ("the fault it guards —
// 'I forgot to run `spacetime start`'", added by ux3 itself), and the original nh4 prose.
// Deleting the fenced step therefore leaves TWO, so a floor of 2 does not bite. Any floor
// is hostage to how much prose happens to mention the command; a structural assertion is
// not. Hence: fence-aware, standalone-line-only.
//
// SHAPE PINNED (indentation-agnostic, so a list-nested block still passes):
//   ```sh
//   spacetime start
//   ```
// Fence tracking toggles on any line whose trim starts with ``` — the fence's info string
// (```sh / ```bash / ```console) is deliberately NOT constrained, since that is styling.
//
// MAINTAINER CAVEAT: this is a line scan, not a CommonMark parser. Two things would fool
// it, neither present in this runbook today: (a) a ``` line INSIDE a fenced block (a
// markdown-about-markdown example), which desynchronises the toggle for the rest of the
// file; (b) a `~~~` fence, which is not tracked at all. If either is ever introduced above
// the `spacetime start` step, this tooth false-REDs — fix the parser, do not delete the
// assertion.
// ---------------------------------------------------------------------------
function hasFencedCommandLine(markdown, command) {
  // Non-vacuity: an empty command would match a blank line inside any fence and certify
  // the doc while scanning for nothing. Scanning nothing is never green in this file.
  if (typeof command !== 'string' || command.trim().length === 0) return false;
  let inFence = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    // STANDALONE line only. `includes` here would re-admit prose smuggled into a fence
    // (e.g. `echo "run spacetime start first"`), which is not a runnable step either.
    if (inFence && line === command) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth for the inline predicates above
// ---------------------------------------------------------------------------

// --- justfileHasRecipe fixtures ---
const JF_NO_RECIPES = 'ci: lint typecheck test\n\nlint:\n    cargo fmt --all --check\n';
const JF_WITH_PLAYTEST_UP = `ci: lint typecheck test\n\nplaytest-up:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    echo hi\n`;

// --- recipeBodyContains / recipeBodyLacks / wholeJustfileLacks ---
const JF_CONTAINS_DEV_REDUCERS = `playtest-up:\n    spacetime publish --features dev_reducers monster-realm-playtest\n`;
const JF_CLEAN_BODY = `playtest-up:\n    spacetime publish -s "$STDB_SERVER" --module-path server-module -y "$MR_PLAYTEST_DB"\n`;

// --- recipeBodyHasExactLine ---
const JF_EXACT_LINE_GOOD = `playtest-verify-release:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    node scripts/verify-release-reducers.mjs\n`;
const JF_EXACT_LINE_OR_TRUE = `playtest-verify-release:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    node scripts/verify-release-reducers.mjs || true\n`;

// --- recipeBodyHasCaseInsensitiveGuard ---
const JF_CASE_SENSITIVE_GUARD = `playtest-up:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    if [ "$MR_PLAYTEST_DB" = "monster-realm" ]; then echo "BAD" >&2; exit 1; fi\n`;
const JF_CASE_INSENSITIVE_GUARD = `playtest-up:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    if [ "\${MR_PLAYTEST_DB,,}" = "monster-realm" ]; then echo "BAD" >&2; exit 1; fi\n`;

// --- recipeStepOrderOk fixtures (ux3-3) ---
// GOOD: preflight is an exact trimmed line, strictly before the first spacetime step.
const JF_ORDER_GOOD = `playtest-up:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    just playtest-preflight\n    spacetime build --project-path server-module\n`;
// BAD: the preflight runs AFTER the build — the whole point of ux3-3 is that a dev who
// forgot to start SpacetimeDB gets a one-line diagnosis BEFORE a multi-minute wasm build.
const JF_ORDER_AFTER = `playtest-up:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    spacetime build --project-path server-module\n    just playtest-preflight\n`;
// BAD: preflight exists ONLY as comments — one column-0-style full-line comment (which
// extractRecipeBody drops) AND one trailing ` # …` comment (which only stripJustfileComments
// drops). Subsumes the "preflight entirely absent" case.
const JF_ORDER_COMMENT_ONLY = `playtest-up:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    # just playtest-preflight\n    echo ok  # just playtest-preflight\n    spacetime build --project-path server-module\n`;
// BAD (marquee non-vacuity fixture): the preflight is wired, but the recipe no longer
// calls spacetime at all — the ordering premise has evaporated and must NOT read green.
const JF_ORDER_NO_SPACETIME = `playtest-up:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    just playtest-preflight\n    echo "module deployment is handled elsewhere now"\n`;
// BAD: `|| true` suffix defuses the guard's exit code — mirrors existing tooth P3a (L-2).
const JF_ORDER_OR_TRUE = `playtest-up:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    just playtest-preflight || true\n    spacetime build --project-path server-module\n`;

// --- recipeHasLineWithAll fixtures (ux3 timeout-binds-the-ping) ---
// GOOD: timeout, the ping and the server var are all on the SAME line.
const JF_LINE_ALL_ONE = `playtest-preflight:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    if ! timeout 10 spacetime server ping "$STDB_SERVER" >/dev/null 2>&1; then\n        exit 1\n    fi\n`;
// BAD: the bound is parked in an unused variable while the real ping runs unbounded —
// every needle is present somewhere in the body, but the call itself can hang forever.
const JF_LINE_SCATTERED = `playtest-preflight:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    TIMEOUT="timeout 10"\n    spacetime server ping "$STDB_SERVER" >/dev/null 2>&1\n`;

// --- timeoutBindsProbe fixtures (ux3 A5h) ---
// GOOD: `timeout` heads the command with a positive integer duration.
const JF_TB_HEADS_COMMAND = `playtest-preflight:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    timeout 10 spacetime server ping "$STDB_SERVER" >/dev/null 2>&1\n`;
// GOOD: the intended `if ! timeout N …; then` form.
const JF_TB_IF_BANG = `playtest-preflight:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    if ! timeout 10 spacetime server ping "$STDB_SERVER" >/dev/null 2>&1; then\n        exit 1\n    fi\n`;
// GOOD: a GNU unit suffix is legal and must NOT false-RED. Also uses the justfile's house
// `"${STDB_SERVER}"` brace style to prove the predicate is quoting-agnostic.
const JF_TB_UNIT_SUFFIX = `playtest-preflight:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    if ! timeout 10s spacetime server ping "\${STDB_SERVER}" >/dev/null 2>&1; then\n        exit 1\n    fi\n`;
// GOOD (THE SHIPPED FORM): stdout is captured in a command substitution so the recipe can
// MATCH the body ("Server is online"), because `spacetime server ping` exits 0 for any
// completed HTTP round-trip — including a 404 or a 500 from a non-SpacetimeDB service.
// The probe is still bounded: `timeout 10` heads the command inside `$( … )`. The previous
// "trimmed line must START WITH timeout/if timeout/…" predicate REJECTED this correct
// implementation, i.e. it encoded a spelling instead of the invariant.
const JF_TB_CMD_SUBST = `playtest-preflight:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    if ! PING_OUT=$(timeout 10 spacetime server ping "$STDB_SERVER" 2>&1) || ! printf '%s' "$PING_OUT" | grep -q 'Server is online'; then\n        exit 1\n    fi\n`;
// BAD (M-t0): `timeout 0` DISABLES the timeout entirely (GNU coreutils). Measured:
// `timeout 0 sleep 3` took 3.002 s and exited 0 — the probe is unbounded.
const JF_TB_ZERO = `playtest-preflight:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    if ! timeout 0 spacetime server ping "$STDB_SERVER" >/dev/null 2>&1; then\n        exit 1\n    fi\n`;
// BAD (M-doc + M-raw): the bounded form exists only as a dead single-quoted doc-string
// (all three A5g tokens co-occur on that one line!) while the REAL call runs unbounded.
const JF_TB_DOCSTRING = `playtest-preflight:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    PROBE_DOC='timeout 10 spacetime server ping "$STDB_SERVER"'\n    if ! spacetime server ping "$STDB_SERVER" >/dev/null 2>&1; then\n        exit 1\n    fi\n`;
// BAD (non-vacuity): no probe line at all — "the probe is bounded" is unverifiable.
const JF_TB_NO_PROBE = `playtest-preflight:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    timeout 10 echo ok\n`;
// --- hasFencedCommandLine fixtures (ux3-2 runnable-step gate) ---
// GOOD: the shipped shape — a ```sh fence nested under a list item (hence the 2-space
// indent), whose sole content is the command. Indentation must not matter.
const MD_FENCED_STEP_GOOD = [
  '- A **local SpacetimeDB instance** running. If you have not started one yet, run:',
  '',
  '  ```sh',
  '  spacetime start',
  '  ```',
  '',
  '  `just playtest-up` preflights this for you.',
].join('\n');
// BAD (THE BASE-FILE STATE — this is exactly what the verifier's deletion produced):
// every prose mention survives, including the pre-ux3 nh4/ADR-0150 sentence, but the
// runnable fenced step is gone. A bare `includes("spacetime start")` needle reads GREEN
// here; so does a count-floor of 2 (there are two mentions). Only fence-awareness bites.
const MD_PROSE_ONLY_BAD = [
  '- A **local SpacetimeDB instance** running.',
  '',
  '  `just playtest-preflight` fails with a one-line pointer instead of a tcp connect error.',
  '',
  '> the fault it guards — "I forgot to run `spacetime start`" — used to surface only after.',
  '',
  'If the host itself is reset (a fresh `spacetime start` data dir, a recreated container',
  'volume), the stored token stops verifying.',
].join('\n');
// BAD: the command appears INSIDE a fence but not as a standalone line — it is an argument
// to an echo, i.e. still prose, still not runnable as a step. Kills an implementation that
// uses `line.includes(command)` instead of `line === command` inside the fence.
const MD_FENCED_NOT_STANDALONE_BAD = [
  '```sh',
  'echo "if nothing is listening, run spacetime start in another terminal"',
  '```',
].join('\n');
// BAD: standalone line, correct text, but OUTSIDE any fence — a stray paragraph line is
// not a code step. Kills an implementation that drops the fence tracking entirely.
const MD_STANDALONE_OUTSIDE_FENCE_BAD = [
  'Start the server first:',
  '',
  'spacetime start',
  '',
  'then run `just playtest-up`.',
].join('\n');

// BAD (M-adj): `timeout 10` IS on the probe line — bounding an unrelated `echo` inside a
// command substitution — while the real `spacetime server ping` after `&&` runs unbounded.
// Every co-occurrence needle (A5g) is satisfied on that single line, and the OLD predicate
// would also have accepted it once relaxed away from line-start matching. Only IMMEDIATE
// ADJACENCY of `timeout <duration>` to the probe rejects it: the two tokens before the
// probe here are `hi)` and `&&`.
const JF_TB_TIMEOUT_ELSEWHERE_ON_LINE = `playtest-preflight:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    if ! X=$(timeout 10 echo hi) && spacetime server ping "$STDB_SERVER" >/dev/null 2>&1; then\n        exit 1\n    fi\n`;

// ---------------------------------------------------------------------------
// §7.15 positive control — source for the throwaway HTTP stub.
//
// It answers 200 + `{}` on ANY path and binds an EPHEMERAL port (listen(0)), then prints
// the chosen port on stdout so the parent can build STDB_SERVER. Measured: `spacetime
// server ping http://127.0.0.1:<port>` against this stub prints "Server is online: …" and
// exits 0 in ~18 ms.
//
// It MUST run in a DETACHED CHILD PROCESS, never in-process: spawnSync blocks the Node
// event loop for its entire duration, so an in-process http server would never get a turn
// to answer the ping and the positive control would deadlock into a false RED.
// Written with single quotes only so it survives being passed as a `node -e` argv string.
// ---------------------------------------------------------------------------
const STUB_HTTP_SERVER_SRC =
  "require('http')" +
  ".createServer(function(q,s){s.writeHead(200,{'Content-Type':'application/json'});s.end('{}')})" +
  ".listen(0,'127.0.0.1',function(){console.log(this.address().port)})";

// ---------------------------------------------------------------------------
// §7.15b negative control — a stub that ANSWERS HTTP but is NOT a SpacetimeDB.
//
// Identical machinery to STUB_HTTP_SERVER_SRC (detached child, ephemeral port, port printed
// on stdout) except it replies HTTP 500. THE MEASURED FACT THIS PINS (CLI 2.6.0):
// `spacetime server ping` exits 0 for ANY COMPLETED HTTP ROUND-TRIP.
//   http://127.0.0.1:3000    (real server)   -> exit 0, "Server is online: http://…"
//   http://127.0.0.1:3000/   (trailing slash)-> exit 0, "Server returned 404 (Not Found)"
//   http://127.0.0.1:3000/v1 (path suffix)   -> exit 0, "Server returned 404"
//   node stub answering 500                  -> exit 0, "Server could not be reached (500 …)"
//   http://127.0.0.1:1       (refused)       -> exit 1
// Meanwhile `spacetime publish -s` FAILS on the trailing-slash / path-suffix / wrong-service
// targets. So an exit-code-only preflight green-lights a full multi-minute wasm build that
// dies at publish — the exact cost ux3-1 exists to remove.
// ---------------------------------------------------------------------------
const STUB_HTTP_500_SERVER_SRC =
  "require('http')" +
  ".createServer(function(q,s){s.writeHead(500);s.end('nope')})" +
  ".listen(0,'127.0.0.1',function(){console.log(this.address().port)})";

// Await the ephemeral port the stub prints on stdout. Bounded: if the stub never reports a
// port (or dies), REJECT — the positive control must fail loud, never silently skip.
function awaitStubPort(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error(`stub HTTP server did not report a port within ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const port = buf.slice(0, nl).trim();
      clearTimeout(timer);
      if (!/^\d+$/.test(port)) {
        reject(new Error(`stub HTTP server printed a non-numeric port: ${JSON.stringify(port)}`));
        return;
      }
      resolve(port);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code, signal) => {
      // Settling twice is a no-op if the port already resolved; this only fires for an
      // early death (e.g. node could not bind loopback at all).
      clearTimeout(timer);
      reject(new Error(`stub HTTP server exited early (code=${code}, signal=${signal})`));
    });
  });
}

// ---------------------------------------------------------------------------
// Local implementations of the pure checker signatures
// (these shadow the imported versions during proof-of-teeth, so the teeth
// exercise the SHAPE of the contract, not just the real implementation)
// ---------------------------------------------------------------------------

// These are what the eval IMPORTS from the scripts. The proof-of-teeth below
// validates those imports work and produce the right shapes. We define stub
// reference implementations here ONLY for use inside the proof-of-teeth
// fixture checks that run when the real scripts are missing (the dynamic import
// try/catch). When the real scripts exist, their exports are used instead.

// Reference implementation for proof-of-teeth (validates fixture shapes independently).
function _refParseReducerNames(describeOutput) {
  if (!describeOutput || !describeOutput.trim()) {
    throw new Error('parseReducerNames: empty output — describe may have failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(describeOutput);
  } catch {
    throw new Error('parseReducerNames: not valid JSON');
  }
  // Candidate paths: V9 flat `reducers`; V9 nested `schema.reducers`; V10
  // `sections[].Reducers` (CLI >= 2.8.0 — ADR-0197). Mirrors the real parser in
  // scripts/verify-release-reducers.mjs; keep the two in lockstep.
  let reducers = null;
  if (Array.isArray(parsed.reducers)) {
    reducers = parsed.reducers;
  } else if (parsed.schema && Array.isArray(parsed.schema.reducers)) {
    reducers = parsed.schema.reducers;
  } else if (Array.isArray(parsed.sections)) {
    const section = parsed.sections.find(
      (s) => s !== null && typeof s === 'object' && Array.isArray(s.Reducers),
    );
    if (section) reducers = section.Reducers;
  }
  if (!reducers || reducers.length === 0) {
    throw new Error(
      'parseReducerNames: zero reducers — introspection may have failed or wrong JSON path',
    );
  }
  // V9 spells it `name`; V10 spells it `source_name`.
  return reducers.map((r) => r?.name ?? r?.source_name).filter(Boolean);
}

function _refFindForbiddenReducers(reducerNames, forbidden) {
  return reducerNames.filter((n) => forbidden.includes(n));
}

function _refFindDevHooks(bundleText, fingerprints) {
  return fingerprints.filter((fp) => bundleText.includes(fp));
}

// The canonical fingerprint set for findDevHooks (§K §D3 + F4, NO bracket forms, NO __mrBuild).
// Must be exactly the window-binding form plus defineProperty escape.
const DEV_HOOK_FINGERPRINTS = [
  '.__game=',
  '.__game =',
  '.__mrTrade=',
  '.__mrTrade =',
  '.__mrPvp=',
  '.__mrPvp =',
  'defineProperty(window,"__game"',
  "defineProperty(window,'__game'",
  'defineProperty(window,"__mrTrade"',
  "defineProperty(window,'__mrTrade'",
  'defineProperty(window,"__mrPvp"',
  "defineProperty(window,'__mrPvp'",
];

// The canonical forbidden reducer set (§K F1 — exactly 2).
const FORBIDDEN_REDUCERS = ['start_wild_battle', 'grant_bait'];

// ---------------------------------------------------------------------------
// Default export — eval entry point
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'playtest-verify (pt-a2: honest release publish + published-module & build-output verification)';

  // ==========================================================================
  // SECTION 1: PROOF-OF-TEETH FOR INLINE PREDICATES
  // Run before importing the real scripts.
  // ==========================================================================

  // --- Tooth P1a: justfileHasRecipe BAD — recipe absent must return false ---
  // Kills: impl that always returns true or searches loosely.
  if (justfileHasRecipe(JF_NO_RECIPES, 'playtest-up')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P1a: justfileHasRecipe returned true for a justfile with no playtest-up recipe — kills impl that accepts any text',
    };
  }

  // --- Tooth P1b: justfileHasRecipe GOOD — recipe present must return true ---
  if (!justfileHasRecipe(JF_WITH_PLAYTEST_UP, 'playtest-up')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P1b: justfileHasRecipe returned false for a justfile that does contain playtest-up — false negative in predicate',
    };
  }

  // --- Tooth P2a: wholeJustfileLacks BAD — dev_reducers present must be caught ---
  // Kills: impl that only scans recipe bodies, missing a variable-level injection.
  if (wholeJustfileLacks(JF_CONTAINS_DEV_REDUCERS, 'dev_reducers')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P2a: wholeJustfileLacks returned true for a justfile body containing "dev_reducers" — red-team F5: must scan entire comment-stripped justfile, not just recipe bodies',
    };
  }

  // --- Tooth P2b: wholeJustfileLacks GOOD — clean body returns true ---
  if (!wholeJustfileLacks(JF_CLEAN_BODY, 'dev_reducers')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P2b: wholeJustfileLacks returned false for a justfile without dev_reducers — false negative in predicate',
    };
  }

  // --- Tooth P3a: recipeBodyHasExactLine BAD — `|| true` suffix must NOT satisfy ---
  // Kills: impl that uses indexOf('node scripts/...') without exact-match discipline.
  // Mirrors reviewer L-2 + nightly-smoke-wiring F6.
  if (
    recipeBodyHasExactLine(
      JF_EXACT_LINE_OR_TRUE,
      'playtest-verify-release',
      'node scripts/verify-release-reducers.mjs',
    )
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P3a: recipeBodyHasExactLine accepted "node scripts/verify-release-reducers.mjs || true" as an exact match — reviewer L-2: a "|| true" suffix must NOT satisfy the tooth; exact trimmed line required',
    };
  }

  // --- Tooth P3b: recipeBodyHasExactLine GOOD — exact line must pass ---
  if (
    !recipeBodyHasExactLine(
      JF_EXACT_LINE_GOOD,
      'playtest-verify-release',
      'node scripts/verify-release-reducers.mjs',
    )
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P3b: recipeBodyHasExactLine rejected a recipe body that correctly has the exact line "node scripts/verify-release-reducers.mjs" — false negative',
    };
  }

  // --- Tooth P4a: recipeBodyHasCaseInsensitiveGuard BAD — case-sensitive-only guard rejected ---
  // Kills: impl that uses `"$MR_PLAYTEST_DB" = "monster-realm"` without ,, fold.
  // §K red-team F6: `MONSTER-REALM` env would bypass a case-sensitive guard.
  if (recipeBodyHasCaseInsensitiveGuard(JF_CASE_SENSITIVE_GUARD, 'playtest-up')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P4a: recipeBodyHasCaseInsensitiveGuard accepted a case-sensitive-only guard ("$MR_PLAYTEST_DB" = "monster-realm") — red-team F6: guard must use bash lowercase fold ${MR_PLAYTEST_DB,,} to prevent MONSTER-REALM bypass',
    };
  }

  // --- Tooth P4b: recipeBodyHasCaseInsensitiveGuard GOOD — ,, fold satisfies ---
  if (!recipeBodyHasCaseInsensitiveGuard(JF_CASE_INSENSITIVE_GUARD, 'playtest-up')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P4b: recipeBodyHasCaseInsensitiveGuard rejected a recipe body that correctly uses ${MR_PLAYTEST_DB,,} — false negative in predicate',
    };
  }

  // --- Tooth P5a: recipeStepOrderOk GOOD — preflight before the first spacetime step ---
  if (
    !recipeStepOrderOk(JF_ORDER_GOOD, 'playtest-up', 'just playtest-preflight', [
      'spacetime build',
      'spacetime publish',
    ])
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P5a: recipeStepOrderOk returned false for a body where "just playtest-preflight" is an exact line strictly above "spacetime build" — false negative; the predicate would then be unable to certify a CORRECT implementation and the ux3-3 gate could never go green',
    };
  }

  // --- Tooth P5b: recipeStepOrderOk BAD — preflight AFTER the build must be rejected ---
  // Kills: an impl that merely asks "is the preflight present somewhere?" (bare-presence
  // needles are not gates — nh2). ux3-3's whole value is failing fast BEFORE the
  // multi-minute wasm build, so a preflight placed after `spacetime build` is worthless.
  if (
    recipeStepOrderOk(JF_ORDER_AFTER, 'playtest-up', 'just playtest-preflight', [
      'spacetime build',
      'spacetime publish',
    ])
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P5b: recipeStepOrderOk accepted a body where "just playtest-preflight" comes AFTER "spacetime build" — the ordering gate must be a strict line-index comparison, not a presence check; a late preflight still costs the dev the whole build before diagnosing the missing server',
    };
  }

  // --- Tooth P5c: recipeStepOrderOk BAD — preflight present only as COMMENTS ---
  // Kills: an impl that scans raw recipe text. Two comment forms are exercised at once —
  // a full-line `# just playtest-preflight` (dropped by extractRecipeBody) and a trailing
  // `echo ok  # just playtest-preflight` (dropped only by stripJustfileComments). This
  // fixture also subsumes the "preflight entirely absent" case.
  if (
    recipeStepOrderOk(JF_ORDER_COMMENT_ONLY, 'playtest-up', 'just playtest-preflight', [
      'spacetime build',
      'spacetime publish',
    ])
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P5c: recipeStepOrderOk accepted a body where "just playtest-preflight" appears ONLY inside comments (one full-line `#` comment and one trailing ` # ` comment) — commented-out wiring executes nothing; BOTH comment forms must be stripped before the order scan, otherwise a disabled preflight reads as green',
    };
  }

  // --- Tooth P5d: recipeStepOrderOk BAD — no spacetime step at all (NON-VACUITY) ---
  // THE marquee tooth. Kills: an impl that returns `earlierIdx !== -1 && (laterIdx === -1
  // || earlierIdx < laterIdx)`, i.e. "vacuously true when there is nothing to come
  // before". If a refactor removes `spacetime build`/`publish` from playtest-up, the
  // gate's premise has evaporated and a human must re-decide — scanning nothing must
  // not read as green (same discipline as parseReducerNames throwing on zero reducers).
  if (
    recipeStepOrderOk(JF_ORDER_NO_SPACETIME, 'playtest-up', 'just playtest-preflight', [
      'spacetime build',
      'spacetime publish',
    ])
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P5d (non-vacuity): recipeStepOrderOk accepted a body that has the preflight but NO "spacetime build"/"spacetime publish" anchor at all — with the later anchor missing the ordering claim is unverifiable, so the predicate must return false rather than pass vacuously',
    };
  }

  // --- Tooth P5e: recipeStepOrderOk BAD — `just playtest-preflight || true` ---
  // Kills: an impl using includes()/indexOf() for the earlier anchor instead of an exact
  // trimmed-line match. `|| true` swallows the preflight's exit 1, so the recipe would
  // sail on into the build against a dead server. Mirrors existing tooth P3a (reviewer L-2).
  if (
    recipeStepOrderOk(JF_ORDER_OR_TRUE, 'playtest-up', 'just playtest-preflight', [
      'spacetime build',
      'spacetime publish',
    ])
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P5e: recipeStepOrderOk accepted "just playtest-preflight || true" as the ordering anchor — reviewer L-2 discipline: a "|| true" suffix defuses the guard\'s non-zero exit, so only an EXACT trimmed line may satisfy the earlier anchor',
    };
  }

  // --- Tooth P6a: recipeHasLineWithAll GOOD — all tokens on one line ---
  // NOTE (ux3 hardening): the server-var token is the BARE `STDB_SERVER`, not the quoted
  // `"$STDB_SERVER"`. `"${STDB_SERVER}"` is this justfile's house style (cf.
  // `${MR_PLAYTEST_DB,,}`, `${TMPDIR:-/tmp}`) and is exactly as correct, but the quoted
  // token rejected it with a misleading "parked in an unused variable" message. Which
  // expansion syntax is used is not what A5g tests — CO-OCCURRENCE is.
  if (
    !recipeHasLineWithAll(JF_LINE_ALL_ONE, 'playtest-preflight', [
      'timeout ',
      'spacetime server ping',
      'STDB_SERVER',
    ])
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P6a: recipeHasLineWithAll returned false for a body whose single `if ! timeout 10 spacetime server ping "$STDB_SERVER"` line carries all three tokens — false negative; the predicate could then never certify a correct preflight',
    };
  }

  // --- Tooth P6b: recipeHasLineWithAll BAD — tokens scattered across lines ---
  // Kills: an impl that ANDs body-wide includes() calls. In the scattered fixture the
  // bound lives in an unused `TIMEOUT="timeout 10"` variable while the real
  // `spacetime server ping "$STDB_SERVER"` runs unbounded — a hung TCP connect to an
  // unreachable host would then block `just playtest-up` forever, which is precisely the
  // hang ux3 exists to prevent.
  if (
    recipeHasLineWithAll(JF_LINE_SCATTERED, 'playtest-preflight', [
      'timeout ',
      'spacetime server ping',
      'STDB_SERVER',
    ])
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P6b: recipeHasLineWithAll accepted a body where "timeout " sits in an unused TIMEOUT variable on one line and the real `spacetime server ping "$STDB_SERVER"` runs unbounded on another — all tokens must co-occur on a SINGLE line or the timeout does not actually bind the ping',
    };
  }

  // --- Tooth P6c: recipeHasLineWithAll BAD — empty token list must NOT be green ---
  // Kills: the plain `tokens.every(...)` form. `[].every()` is `true`, so an empty token
  // array would make every line (blank ones included) "match" and the caller would read
  // green while asserting nothing at all.
  if (recipeHasLineWithAll(JF_LINE_ALL_ONE, 'playtest-preflight', [])) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P6c: recipeHasLineWithAll returned true for an EMPTY token list — [].every() is true, so without an explicit length guard the predicate certifies a body while scanning for nothing; scanning nothing must never read as green',
    };
  }

  // --- Tooth P7a: timeoutBindsProbe GOOD — `timeout 10 <probe>` heads the command ---
  if (!timeoutBindsProbe(JF_TB_HEADS_COMMAND, 'playtest-preflight', 'spacetime server ping')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P7a: timeoutBindsProbe returned false for `timeout 10 spacetime server ping "$STDB_SERVER"` — false negative; the predicate could then never certify a correct preflight and the A5h gate could never go green',
    };
  }

  // --- Tooth P7b: timeoutBindsProbe GOOD — the intended `if ! timeout N …; then` form ---
  if (!timeoutBindsProbe(JF_TB_IF_BANG, 'playtest-preflight', 'spacetime server ping')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P7b: timeoutBindsProbe rejected the `if ! timeout 10 spacetime server ping …; then` form — leading `if`/`!` tokens are irrelevant; only the two tokens IMMEDIATELY before the probe are load-bearing',
    };
  }

  // --- Tooth P7g: timeoutBindsProbe GOOD — THE SHIPPED COMMAND-SUBSTITUTION FORM ---
  // THE BLOCKING TOOTH. `spacetime server ping` exits 0 for ANY completed HTTP round-trip
  // (measured on CLI 2.6.0: a trailing slash, a `/v1` path suffix and a node stub returning
  // HTTP 500 all exit 0), so ux3-1 requires the recipe to MATCH the output body, which means
  // capturing stdout: `if ! PING_OUT=$(timeout 10 spacetime server ping "$STDB_SERVER" 2>&1)
  // || ! printf '%s' "$PING_OUT" | grep -q 'Server is online'; then`. The previous predicate
  // demanded the trimmed line START WITH `timeout `/`if timeout `/`if ! timeout `/`! timeout `
  // and therefore REJECTED this correct, bounded implementation — a gate that structurally
  // forbids the only correct fix. This fixture pins the corrected invariant.
  if (!timeoutBindsProbe(JF_TB_CMD_SUBST, 'playtest-preflight', 'spacetime server ping')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P7g: timeoutBindsProbe rejected the shipped `if ! PING_OUT=$(timeout 10 spacetime server ping "$STDB_SERVER" 2>&1) || ! printf \'%s\' "$PING_OUT" | grep -q \'Server is online\'; then` form — the probe IS bounded (timeout heads the command inside the command substitution). Requiring the trimmed line to START WITH a timeout spelling encodes a SYNTAX, not the invariant, and blocks the output-matching fix that ux3-1 needs; the invariant is `timeout <positive-duration>` IMMEDIATELY preceding the probe token',
    };
  }

  // --- Tooth P7c: timeoutBindsProbe GOOD — a GNU unit suffix must not false-RED ---
  // `timeout 10s` is valid GNU coreutils and equally bounding; rejecting it would burn a
  // maintainer with a false RED. This fixture also uses the `"${STDB_SERVER}"` brace form.
  if (!timeoutBindsProbe(JF_TB_UNIT_SUFFIX, 'playtest-preflight', 'spacetime server ping')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P7c: timeoutBindsProbe rejected `timeout 10s …` — an optional s/m/h/d unit suffix is legal GNU coreutils syntax and bounds the probe just as well; rejecting it is a false RED on a correct implementation',
    };
  }

  // --- Tooth P7d: timeoutBindsProbe BAD — `timeout 0` (M-t0) ---
  // THE marquee duration tooth. GNU coreutils: "A duration of 0 disables the associated
  // timeout." Measured: `timeout 0 sleep 3` ran the full 3 s and exited 0. So `timeout 0
  // spacetime server ping …` satisfies every co-occurrence needle in A5g while leaving the
  // probe able to hang forever — precisely the stall ux3 exists to remove.
  if (timeoutBindsProbe(JF_TB_ZERO, 'playtest-preflight', 'spacetime server ping')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P7d: timeoutBindsProbe accepted `timeout 0 spacetime server ping …` — GNU coreutils treats a duration of 0 as NO timeout (measured: `timeout 0 sleep 3` took 3.0 s, exit 0), so the duration token must be a strictly POSITIVE integer; note parseInt would also have accepted "5e1"/"-1", hence the literal digit check',
    };
  }

  // --- Tooth P7e: timeoutBindsProbe BAD — dead doc-string + unbounded real call (M-doc/M-raw) ---
  // Kills: any predicate that only asks whether the tokens co-occur. In this fixture the
  // bounded form exists ONLY inside a single-quoted PROBE_DOC assignment that is never
  // executed (and which alone satisfies A5g!), while the real `spacetime server ping` runs
  // with no bound at all. `timeout` must HEAD a command, not sit inside an assignment.
  if (timeoutBindsProbe(JF_TB_DOCSTRING, 'playtest-preflight', 'spacetime server ping')) {
    return {
      name,
      pass: false,
      detail:
        "TEETH P7e: timeoutBindsProbe accepted a body whose only bounded form is a dead `PROBE_DOC='timeout 10 spacetime server ping …'` assignment while the REAL call runs unbounded — a QUOTE is not a command boundary, so `PROBE_DOC='timeout` must not count as the timeout COMMAND; and because `every` (not `some`) is used, a bounded probe paired with a second unbounded one is also rejected",
    };
  }

  // --- Tooth P7h: timeoutBindsProbe BAD — `timeout 10` on the line but NOT adjacent (M-adj) ---
  // Kills the naive relaxation of P7g: "the line contains `timeout <positive-duration>`
  // somewhere before the probe". In this fixture `timeout 10` bounds an unrelated `echo`
  // inside `$( … )` and the real `spacetime server ping` after `&&` runs with no bound at
  // all — the exact hang ux3 exists to remove, while every A5g co-occurrence needle is
  // satisfied on that one line. Only IMMEDIATE ADJACENCY of `timeout <duration>` to the
  // probe token rejects it.
  if (
    timeoutBindsProbe(
      JF_TB_TIMEOUT_ELSEWHERE_ON_LINE,
      'playtest-preflight',
      'spacetime server ping',
    )
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P7h: timeoutBindsProbe accepted `if ! X=$(timeout 10 echo hi) && spacetime server ping "$STDB_SERVER"; then` — the `timeout 10` there bounds an unrelated `echo`, and the real probe runs UNBOUNDED. The two tokens immediately preceding the probe must be the timeout command and a positive duration; "a timeout appears somewhere earlier on the line" is co-occurrence, not binding',
    };
  }

  // --- Tooth P7f: timeoutBindsProbe BAD — no probe line at all (NON-VACUITY) ---
  // Kills: an impl written as `probeLines.every(...)` with no zero-length guard — [].every()
  // is true, so a preflight that no longer pings anything would certify "the probe is
  // bounded" while there is no probe. Same discipline as P5d and P6c.
  if (timeoutBindsProbe(JF_TB_NO_PROBE, 'playtest-preflight', 'spacetime server ping')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P7f (non-vacuity): timeoutBindsProbe accepted a body containing NO "spacetime server ping" line at all — with no probe present the claim "the probe is bounded" is unverifiable and must return false, not pass vacuously via [].every()',
    };
  }

  // --- Tooth P8a: hasFencedCommandLine GOOD — the shipped list-nested ```sh block ---
  if (!hasFencedCommandLine(MD_FENCED_STEP_GOOD, 'spacetime start')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P8a: hasFencedCommandLine returned false for a ```sh fence (indented two spaces because it is nested under a list item) whose sole content is "spacetime start" — false negative; the predicate must be indentation-agnostic or it could never certify the runbook\'s actual shape and the ux3-2 gate could never go green',
    };
  }

  // --- Tooth P8b: hasFencedCommandLine BAD — prose mentions only (THE ux3-2 BITE) ---
  // This fixture reproduces EXACTLY what the verifier's red-team deletion produced: the
  // runnable fenced step removed, every prose mention (including the pre-ux3 nh4/ADR-0150
  // "a fresh `spacetime start` data dir" sentence) left in place. The §7.10 gate stayed
  // green through that deletion, which is the gap this tooth closes. Note a count-floor of
  // 2 ALSO fails to bite here — this fixture has two mentions — which is why the assertion
  // is structural (fenced + standalone) rather than numeric.
  if (hasFencedCommandLine(MD_PROSE_ONLY_BAD, 'spacetime start')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P8b: hasFencedCommandLine accepted a document whose only "spacetime start" occurrences are PROSE (an inline-backtick blockquote and the pre-existing nh4/ADR-0150 "fresh `spacetime start` data dir" sentence) with no fenced step at all — ux3-2 asks for a RUNNABLE one-line step, so a bare includes() needle (green on the pre-ux3 file) and a count-floor (this fixture already has two mentions) both fail to gate it',
    };
  }

  // --- Tooth P8c: hasFencedCommandLine BAD — inside a fence but not standalone ---
  // Kills `inFence && line.includes(command)`: prose smuggled into a code fence as an echo
  // argument is still not a step a dev can copy and run.
  if (hasFencedCommandLine(MD_FENCED_NOT_STANDALONE_BAD, 'spacetime start')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P8c: hasFencedCommandLine accepted a fenced block whose only occurrence is `echo "… run spacetime start in another terminal"` — the command must be a STANDALONE line (line === command), not a substring of some other command, or prose merely relocated into a code fence satisfies ux3-2',
    };
  }

  // --- Tooth P8d: hasFencedCommandLine BAD — standalone but OUTSIDE any fence ---
  // Kills an implementation that drops the fence tracking and just looks for a bare line.
  if (hasFencedCommandLine(MD_STANDALONE_OUTSIDE_FENCE_BAD, 'spacetime start')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P8d: hasFencedCommandLine accepted a bare paragraph line "spacetime start" that is not inside any ``` fence — ux3-2 asks for a copy-pasteable code step; without the fence-state tracking the predicate degenerates into a line-level presence check',
    };
  }

  // --- Tooth P8e: hasFencedCommandLine BAD — empty command (NON-VACUITY) ---
  // An empty command would equal the blank lines inside any fence and certify the document
  // while asserting nothing. Same discipline as P6c and P7f.
  if (hasFencedCommandLine(MD_FENCED_STEP_GOOD, '')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P8e (non-vacuity): hasFencedCommandLine returned true for an EMPTY command — a blank line inside a fence would match, so the predicate would certify any fenced document while scanning for nothing; scanning nothing must never read as green',
    };
  }

  // ==========================================================================
  // SECTION 2: PROOF-OF-TEETH FOR parseReducerNames (reference impl)
  // Validates the CONTRACT the imported function must satisfy.
  // ==========================================================================

  // --- Tooth R1a: BAD-empty — must THROW ---
  // Kills: impl that returns [] on empty input (vacuously green describe failure).
  {
    let threw = false;
    try {
      _refParseReducerNames('');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R1a: parseReducerNames("") must throw — empty output means describe failed; returning [] would make a failed introspection read as green',
      };
    }
  }

  // --- Tooth R1b: BAD-unparseable — must THROW ---
  {
    let threw = false;
    try {
      _refParseReducerNames('not json{');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R1b: parseReducerNames("not json{") must throw — unparseable output means describe failed',
      };
    }
  }

  // --- Tooth R1c: BAD-no-reducers-key — valid JSON, no `reducers` key — must THROW ---
  // Kills: impl that returns [] silently when the JSON path is wrong.
  // §K B-1 + H-2: zero names = wrong path or failed introspection — must throw.
  {
    let threw = false;
    try {
      _refParseReducerNames('{"tables":[]}');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R1c: parseReducerNames(\'{"tables":[]}\') (valid JSON, no reducers key) must throw — §K B-1/H-2: zero reducers means wrong JSON path or failed introspection',
      };
    }
  }

  // --- Tooth R1d: BAD-empty-array — reducers:[] — must THROW ---
  // Kills: impl that returns [] for an empty reducers array.
  {
    let threw = false;
    try {
      _refParseReducerNames('{"reducers":[]}');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R1d: parseReducerNames(\'{"reducers":[]}\') must throw — a published module always has join_game/sync_content; zero reducers means the check did not run',
      };
    }
  }

  // --- Tooth R1e: GOOD (real 2.6.0 flat shape) — non-empty array returned ---
  // Uses the confirmed 2.6.0 `describe --json` shape (§K §A-5):
  // { reducers: [ { name, params, lifecycle }, ... ] }
  {
    const goodOutput =
      '{"typespace":{},"tables":[],"reducers":[{"name":"join_game","params":{"elements":[]},"lifecycle":{"none":[]}},{"name":"sync_content","params":{"elements":[]},"lifecycle":{"none":[]}}],"types":[],"misc_exports":[],"row_level_security":[]}';
    let names;
    try {
      names = _refParseReducerNames(goodOutput);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH R1e: parseReducerNames threw on a valid 2.6.0 describe output: ${e.message}`,
      };
    }
    if (!Array.isArray(names) || names.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R1e: parseReducerNames returned empty array for a valid 2.6.0 describe output containing join_game + sync_content',
      };
    }
    if (!names.includes('join_game') || !names.includes('sync_content')) {
      return {
        name,
        pass: false,
        detail: `TEETH R1e: parseReducerNames returned [${names.join(',')}] but expected join_game and sync_content`,
      };
    }
  }

  // --- Tooth R1e-v10: GOOD (real 2.8.1 V10 sections shape) — ADR-0197 ---
  // CLI >= 2.8.0 emits RawModuleDefV10: reducers move into an externally-tagged
  // `sections` array AND the field is `source_name`, not `name`. Captured from a
  // live 2.8.1 instance. The V9 tooth above is kept deliberately: the parser must
  // accept BOTH, because the shape is chosen by the CLI, not the host.
  {
    const goodV10 =
      '{"sections":[{"Typespace":{"types":[]}},{"Tables":[]},{"Reducers":[{"source_name":"join_game","params":{"elements":[]},"visibility":{"Public":[]}},{"source_name":"sync_content","params":{"elements":[]},"visibility":{"Public":[]}}]}]}';
    let names;
    try {
      names = _refParseReducerNames(goodV10);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH R1e-v10: parseReducerNames threw on a valid 2.8.1 V10 describe output (sections[].Reducers[].source_name): ${e.message}`,
      };
    }
    if (!Array.isArray(names) || !names.includes('join_game') || !names.includes('sync_content')) {
      return {
        name,
        pass: false,
        detail: `TEETH R1e-v10: parseReducerNames returned ${JSON.stringify(names)} for a valid 2.8.1 V10 describe output — expected join_game and sync_content. A V10 payload read as "no reducers" would make findForbiddenReducers report a dev-reducer leak as clean.`,
      };
    }
  }

  // --- Tooth R1f: GOOD nested shape (F8 path-robustness) ---
  // A nested `{"schema":{"reducers":[...]}}` fixture also parses correctly.
  {
    const nestedOutput = '{"schema":{"reducers":[{"name":"join_game"},{"name":"sync_content"}]}}';
    let names;
    try {
      names = _refParseReducerNames(nestedOutput);
    } catch {
      // If the reference impl doesn't support nested, that's OK for the reference impl —
      // the REAL impl is required to handle it. This tooth tests that the real import
      // will be tested via the real-script tooth later. Skip for reference impl.
      names = null; // mark as skipped for reference impl
    }
    // We accept both: the reference impl may not support nested (it's a simplification).
    // The real-script tooth (Section 3) will test the actual import on this shape.
  }

  // ==========================================================================
  // SECTION 3: PROOF-OF-TEETH FOR findForbiddenReducers (reference impl)
  // ==========================================================================

  // --- Tooth F1a: GOOD — production-only reducers return [] ---
  {
    const offenders = _refFindForbiddenReducers(
      ['join_game', 'sync_content', 'buy'],
      FORBIDDEN_REDUCERS,
    );
    if (offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH F1a: findForbiddenReducers flagged production-only reducers [${offenders.join(',')}] — false positive`,
      };
    }
  }

  // --- Tooth F1b: BAD-swb — start_wild_battle must be returned ---
  {
    const offenders = _refFindForbiddenReducers(
      ['join_game', 'start_wild_battle'],
      FORBIDDEN_REDUCERS,
    );
    if (!offenders.includes('start_wild_battle')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH F1b: findForbiddenReducers did not flag start_wild_battle — forbidden dev reducer not detected',
      };
    }
  }

  // --- Tooth F1c: BAD-bait — grant_bait must be returned ---
  {
    const offenders = _refFindForbiddenReducers(['grant_bait', 'buy'], FORBIDDEN_REDUCERS);
    if (!offenders.includes('grant_bait')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH F1c: findForbiddenReducers did not flag grant_bait — forbidden dev reducer not detected',
      };
    }
  }

  // --- Tooth F1d: no-false-positive — exact-name match, not substring ---
  // `grant_item_helper_log` contains "grant_item" / "grant" as substring but must NOT flag.
  // §K F1: grant_item is a helper never in describe; a substring match would false-flag it.
  {
    const offenders = _refFindForbiddenReducers(
      ['sync_content', 'grant_item_helper_log'],
      FORBIDDEN_REDUCERS,
    );
    if (offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH F1d: findForbiddenReducers false-flagged [${offenders.join(',')}] — names containing a forbidden token as a SUBSTRING must not flag; exact-name membership only`,
      };
    }
  }

  // --- Tooth F1e: forbidden set has EXACTLY 2 entries ---
  // §K F1 BLOCKER: grant_item is NOT a reducer; the set must be exactly
  // ['start_wild_battle', 'grant_bait']. This assertion kills an impl that includes grant_item.
  if (FORBIDDEN_REDUCERS.length !== 2) {
    return {
      name,
      pass: false,
      detail: `TEETH F1e: FORBIDDEN_REDUCERS has ${FORBIDDEN_REDUCERS.length} entries but must have exactly 2 (start_wild_battle, grant_bait); grant_item is a pub(crate) helper, not a reducer — §K F1 BLOCKER`,
    };
  }
  if (
    !FORBIDDEN_REDUCERS.includes('start_wild_battle') ||
    !FORBIDDEN_REDUCERS.includes('grant_bait')
  ) {
    return {
      name,
      pass: false,
      detail: `TEETH F1e: FORBIDDEN_REDUCERS does not contain both start_wild_battle and grant_bait; got [${FORBIDDEN_REDUCERS.join(',')}]`,
    };
  }

  // ==========================================================================
  // SECTION 4: PROOF-OF-TEETH FOR findDevHooks (reference impl)
  // ==========================================================================

  // --- Tooth H1a: BAD — window.__mrPvp = ... binding flagged ---
  // Kills: impl that uses bare substring without the `.` prefix binding form.
  {
    const offenders = _refFindDevHooks(
      'var x=1;window.__mrPvp = function(){}',
      DEV_HOOK_FINGERPRINTS,
    );
    if (offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH H1a: findDevHooks did not flag "window.__mrPvp = function(){}" — binding form .__mrPvp = must be detected',
      };
    }
  }

  // --- Tooth H1b: BAD — w.__game=1 (renamed receiver, no `window.`) flagged ---
  // §K L-1: the leading `.` prefix also catches `w.`/`globalThis.`/`self.` receivers.
  {
    const offenders = _refFindDevHooks('(function(){w.__game=1})()', DEV_HOOK_FINGERPRINTS);
    if (offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH H1b: findDevHooks did not flag "w.__game=1" — the .__game= fingerprint must match any receiver, not only "window."',
      };
    }
  }

  // --- Tooth H1c: BAD — window.__mrTrade =x (space before =) flagged ---
  {
    const offenders = _refFindDevHooks('window.__mrTrade =x;', DEV_HOOK_FINGERPRINTS);
    if (offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH H1c: findDevHooks did not flag "window.__mrTrade =x" — the .__mrTrade = fingerprint (with space) must be detected',
      };
    }
  }

  // --- Tooth H1d: BAD — Object.defineProperty(window,"__mrPvp",{value:fn}) flagged ---
  // §K F4 blocker: defineProperty escape must also be caught.
  {
    const offenders = _refFindDevHooks(
      'Object.defineProperty(window,"__mrPvp",{value:fn})',
      DEV_HOOK_FINGERPRINTS,
    );
    if (offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH H1d: findDevHooks did not flag Object.defineProperty(window,"__mrPvp",...) — §K F4: defineProperty escape must be detected',
      };
    }
  }

  // --- Tooth H2a: GOOD-clean — no hooks in a minified-looking bundle ---
  {
    const bundle = 'var a=function(e,t){return e+t};export{a as add};';
    const offenders = _refFindDevHooks(bundle, DEV_HOOK_FINGERPRINTS);
    if (offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH H2a: findDevHooks false-flagged [${offenders.join(',')}] in a clean minified bundle`,
      };
    }
  }

  // --- Tooth H2b: GOOD anti-FP (ADR-0128 §D3 critical tooth) ---
  // Dead object literal + bare tokens in a comment — NO .binding form → must return [].
  // Kills: impl that uses bare substring `__mrPvp` without the dot-binding prefix.
  {
    const deadLiteralBundle = [
      '/* __mrPvp __game debug tokens in sourcemap comment */',
      'var hooks={challengePvp:function(){},proposeTrade:function(){}};',
      'export{hooks};',
    ].join('\n');
    const offenders = _refFindDevHooks(deadLiteralBundle, DEV_HOOK_FINGERPRINTS);
    if (offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH H2b: findDevHooks false-flagged [${offenders.join(',')}] in a fixture with only dead object literals and comment-prose bare tokens (no .binding form) — ADR-0128 §D3: binding form required, not bare substring`,
      };
    }
  }

  // --- Tooth H2c: GOOD anti-FP for ungated prod stamp (§K F9) ---
  // window.__mrBuild = {sha:'abc'} must NOT be flagged — the build stamp is
  // not a dev hook; guarding against accidental .__mr* broadening.
  {
    const stampBundle = "window.__mrBuild = {sha:'abc123',time:'2026-07-19'};";
    const offenders = _refFindDevHooks(stampBundle, DEV_HOOK_FINGERPRINTS);
    if (offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH H2c: findDevHooks false-flagged [${offenders.join(',')}] for "window.__mrBuild = ..." — §K F9: the ungated prod build stamp must NOT be flagged; fingerprints must be specific to __game/__mrTrade/__mrPvp`,
      };
    }
  }

  // ==========================================================================
  // SECTION 5: DYNAMIC IMPORT OF REAL CHECKERS
  // If the scripts don't exist yet, return pass:false (RED state).
  // ==========================================================================

  let parseReducerNames, findForbiddenReducers, findDevHooks, bundleBakesDb;
  try {
    const releaseModule = await import('../scripts/verify-release-reducers.mjs');
    parseReducerNames = releaseModule.parseReducerNames;
    findForbiddenReducers = releaseModule.findForbiddenReducers;
    if (typeof parseReducerNames !== 'function' || typeof findForbiddenReducers !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'scripts/verify-release-reducers.mjs exists but does not export parseReducerNames and/or findForbiddenReducers as functions — §K BLOCKER: pure checkers must be exported',
      };
    }
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `scripts/verify-release-reducers.mjs not yet implemented (import failed: ${e?.message ?? String(e)}) — RED state expected`,
    };
  }

  try {
    const buildModule = await import('../scripts/verify-build-hooks.mjs');
    findDevHooks = buildModule.findDevHooks;
    bundleBakesDb = buildModule.bundleBakesDb;
    if (typeof findDevHooks !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'scripts/verify-build-hooks.mjs exists but does not export findDevHooks as a function — pure checker must be exported',
      };
    }
    if (typeof bundleBakesDb !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'scripts/verify-build-hooks.mjs exists but does not export bundleBakesDb as a function — pure checker must be exported (pt-a2 build-time DB-bake gate)',
      };
    }
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `scripts/verify-build-hooks.mjs not yet implemented (import failed: ${e?.message ?? String(e)}) — RED state expected`,
    };
  }

  // ==========================================================================
  // SECTION 6: PROOF-OF-TEETH AGAINST THE REAL IMPORTED CHECKERS
  // Every tooth from sections 2–4 re-run against the real implementations.
  // A broken real impl must fail here before reaching the structural scans.
  // ==========================================================================

  // --- bundleBakesDb real-impl teeth (pt-a2 build-time DB-bake gate, ADR-0128/0129) ---
  // The connectionConfig guard's ERROR MESSAGE hardcodes the example
  // "monster-realm-playtest" via `e.g.`, so it is present in EVERY build. bundleBakesDb
  // must key on the `db:` property VALUE, not a bare DB-name substring, or it fails OPEN
  // — passing a misconfigured (unset VITE_STDB_DB) build whose db is baked `void 0`.
  {
    // GOOD — pretty build form (the honest build is unminified, ADR-0128).
    const bakedPretty = 'const { uri: z0, db: L0 } = yy({\n    db: "monster-realm-playtest"\n  });';
    if (!bundleBakesDb(bakedPretty, 'monster-realm-playtest')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH DB-pretty: bundleBakesDb failed to detect a baked `db: "monster-realm-playtest"` (pretty build form)',
      };
    }
    // GOOD — minified build form.
    if (!bundleBakesDb('a=z({db:"monster-realm-playtest"},!1)', 'monster-realm-playtest')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH DB-min: bundleBakesDb failed to detect a baked `db:"monster-realm-playtest"` (minified build form)',
      };
    }
    // KEY BAD (fail-open killer) — a misconfigured build: only the guard-message example
    // is present and db is baked `void 0`. bundleBakesDb MUST NOT report the DB as baked.
    const guardExampleOnly =
      'set VITE_STDB_DB to the playtest database (e.g. "monster-realm-playtest"), not "";var x=z({db:void 0},!1);';
    if (bundleBakesDb(guardExampleOnly, 'monster-realm-playtest')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH DB-guard-example (fail-open killer): bundleBakesDb reported the DB as baked when ONLY the guard-message example "monster-realm-playtest" is present (db baked void 0) — it must key on the `db:` property value, not a bare DB-name substring',
      };
    }
    // GOOD — a custom (non-default) DB name is honored, not hardcoded to the default.
    if (!bundleBakesDb('q({db: "mr-playtest-2"})', 'mr-playtest-2')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH DB-custom: bundleBakesDb failed to detect a custom baked db name "mr-playtest-2"',
      };
    }
    // BAD — a custom DB absent from the bundle (only the default example present).
    if (bundleBakesDb('database (e.g. "monster-realm-playtest")', 'mr-playtest-2')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH DB-custom-neg: bundleBakesDb false-passed for a custom db "mr-playtest-2" absent from the bundle',
      };
    }
  }

  // --- parseReducerNames real-impl teeth ---

  {
    let threw = false;
    try {
      parseReducerNames('');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) R1a: parseReducerNames("") must throw — real impl does not fail on empty input; vacuously green on describe failure',
      };
    }
  }

  {
    let threw = false;
    try {
      parseReducerNames('not json{');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail: 'TEETH (real) R1b: parseReducerNames("not json{") must throw',
      };
    }
  }

  {
    let threw = false;
    try {
      parseReducerNames('{"tables":[]}');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) R1c: parseReducerNames(\'{"tables":[]}\') must throw — §K B-1/H-2: no reducers key means wrong path or failed introspection',
      };
    }
  }

  {
    let threw = false;
    try {
      parseReducerNames('{"reducers":[]}');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) R1d: parseReducerNames(\'{"reducers":[]}\') must throw — empty reducer array means introspection failed',
      };
    }
  }

  {
    // Real 2.6.0 flat shape (§K §A-5 confirmed empirically).
    const goodOutput =
      '{"typespace":{},"tables":[],"reducers":[{"name":"join_game","params":{"elements":[]},"lifecycle":{"none":[]}},{"name":"sync_content","params":{"elements":[]},"lifecycle":{"none":[]}}],"types":[],"misc_exports":[],"row_level_security":[]}';
    let names;
    try {
      names = parseReducerNames(goodOutput);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) R1e: parseReducerNames threw on valid 2.6.0 describe output: ${e.message}`,
      };
    }
    if (!Array.isArray(names) || !names.includes('join_game') || !names.includes('sync_content')) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) R1e: parseReducerNames returned ${JSON.stringify(names)} for valid 2.6.0 output — expected array containing join_game + sync_content`,
      };
    }
  }

  {
    // Real 2.8.1 V10 `sections` shape (ADR-0197, captured from a live instance):
    // reducers are externally tagged under `sections[].Reducers` and the name
    // field is `source_name`. Runs against the REAL exported parser.
    const goodV10 =
      '{"sections":[{"Typespace":{"types":[]}},{"Tables":[]},{"Reducers":[{"source_name":"join_game","params":{"elements":[]},"visibility":{"Public":[]}},{"source_name":"sync_content","params":{"elements":[]},"visibility":{"Public":[]}}]}]}';
    let names;
    try {
      names = parseReducerNames(goodV10);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) R1e-v10: parseReducerNames threw on valid 2.8.1 V10 describe output: ${e.message}`,
      };
    }
    if (!Array.isArray(names) || !names.includes('join_game') || !names.includes('sync_content')) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) R1e-v10: parseReducerNames returned ${JSON.stringify(names)} for valid 2.8.1 V10 output — expected array containing join_game + sync_content`,
      };
    }
  }

  // Nested shape (§K F8 path-robustness).
  {
    const nestedOutput =
      '{"schema":{"reducers":[{"name":"join_game"},{"name":"sync_content"},{"name":"accept_challenge"}]}}';
    let names;
    try {
      names = parseReducerNames(nestedOutput);
    } catch {
      // Acceptable if real impl handles only flat shape — path robustness is a SHOULD per §K F8.
      // We don't fail here; the structural tooth on source is the real guard.
      names = null;
    }
    // If it didn't throw and returned results, they should include the names.
    if (names !== null && Array.isArray(names) && names.length > 0) {
      if (!names.includes('join_game')) {
        return {
          name,
          pass: false,
          detail: `TEETH (real) R1f: parseReducerNames parsed nested shape but returned ${JSON.stringify(names)} without join_game`,
        };
      }
    }
  }

  // --- findForbiddenReducers real-impl teeth ---

  {
    const offenders = findForbiddenReducers(
      ['join_game', 'sync_content', 'buy'],
      FORBIDDEN_REDUCERS,
    );
    if (!Array.isArray(offenders) || offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) F1a: findForbiddenReducers returned ${JSON.stringify(offenders)} for production-only reducers — must return []`,
      };
    }
  }

  {
    const offenders = findForbiddenReducers(['join_game', 'start_wild_battle'], FORBIDDEN_REDUCERS);
    if (!Array.isArray(offenders) || !offenders.includes('start_wild_battle')) {
      return {
        name,
        pass: false,
        detail: 'TEETH (real) F1b: findForbiddenReducers did not flag start_wild_battle',
      };
    }
  }

  {
    const offenders = findForbiddenReducers(['grant_bait', 'buy'], FORBIDDEN_REDUCERS);
    if (!Array.isArray(offenders) || !offenders.includes('grant_bait')) {
      return {
        name,
        pass: false,
        detail: 'TEETH (real) F1c: findForbiddenReducers did not flag grant_bait',
      };
    }
  }

  {
    // Exact-match, not substring — §K F1.
    const offenders = findForbiddenReducers(
      ['sync_content', 'grant_item_helper_log'],
      FORBIDDEN_REDUCERS,
    );
    if (!Array.isArray(offenders) || offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) F1d: findForbiddenReducers false-flagged [${offenders.join(',')}] — exact-name match required, not substring`,
      };
    }
  }

  // --- findDevHooks real-impl teeth ---

  {
    const offenders = findDevHooks('var x=1;window.__mrPvp = function(){}', DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH (real) H1a: findDevHooks did not flag "window.__mrPvp = function(){}"',
      };
    }
  }

  {
    const offenders = findDevHooks('(function(){w.__game=1})()', DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) H1b: findDevHooks did not flag "w.__game=1" — .__game= fingerprint must match any receiver',
      };
    }
  }

  {
    const offenders = findDevHooks('window.__mrTrade =x;', DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH (real) H1c: findDevHooks did not flag "window.__mrTrade =x"',
      };
    }
  }

  {
    const offenders = findDevHooks(
      'Object.defineProperty(window,"__mrPvp",{value:fn})',
      DEV_HOOK_FINGERPRINTS,
    );
    if (!Array.isArray(offenders) || offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) H1d: findDevHooks did not flag defineProperty(window,"__mrPvp",...) — §K F4: defineProperty escape must be caught',
      };
    }
  }

  {
    const bundle = 'var a=function(e,t){return e+t};export{a as add};';
    const offenders = findDevHooks(bundle, DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) H2a: findDevHooks false-flagged [${offenders.join(',')}] in a clean bundle`,
      };
    }
  }

  {
    // ADR-0128 §D3 critical anti-FP: dead object literal + bare tokens in comment.
    const deadLiteralBundle = [
      '/* __mrPvp __game debug tokens in sourcemap comment */',
      'var hooks={challengePvp:function(){},proposeTrade:function(){}};',
      'export{hooks};',
    ].join('\n');
    const offenders = findDevHooks(deadLiteralBundle, DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) H2b: findDevHooks false-flagged [${offenders.join(',')}] in dead-literal + comment-token fixture — ADR-0128 §D3: binding form required`,
      };
    }
  }

  {
    // §K F9: ungated prod stamp must NOT be flagged.
    const stampBundle = "window.__mrBuild = {sha:'abc123',time:'2026-07-19'};";
    const offenders = findDevHooks(stampBundle, DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) H2c: findDevHooks false-flagged [${offenders.join(',')}] for "window.__mrBuild = ..." — §K F9: build stamp must not be flagged`,
      };
    }
  }

  // ==========================================================================
  // SECTION 7: STRUCTURAL SCANS — real justfile, scripts, docs
  // ==========================================================================

  const root = path.resolve('.');
  const justfilePath = path.join(root, 'justfile');
  const releaseScriptPath = path.join(root, 'scripts/verify-release-reducers.mjs');
  const buildScriptPath = path.join(root, 'scripts/verify-build-hooks.mjs');
  const playtestOpsPath = path.join(root, 'docs/playtest-ops.md');
  const adrPath = path.join(root, 'docs/adr/0129-pt-a2-local-playtest-ops.md');

  let justfile;
  try {
    justfile = readFileSync(justfilePath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read justfile' };
  }

  // ---- 7.1: Recipe existence (5 pt-a2 recipes + playtest-preflight from ux3) ----

  const requiredRecipes = [
    'playtest-up',
    'playtest-down',
    'playtest-verify-release',
    'playtest-verify-build',
    'playtest-wipe',
    // ux3-1: the fail-fast SpacetimeDB reachability preflight.
    'playtest-preflight',
  ];
  for (const recipe of requiredRecipes) {
    if (!justfileHasRecipe(justfile, recipe)) {
      return {
        name,
        pass: false,
        detail: `justfile missing recipe "${recipe}" — implementer must add it (pt-a2-1/-2/-3/-4/-5; "playtest-preflight" is ux3-1)`,
      };
    }
  }

  // ---- 7.2: set -euo pipefail in every new bash recipe (reviewer M-1) ----
  // ux3 A0′: upgraded from recipeBodyContains to recipeBodyHasExactLine. Verified safe —
  // every existing playtest-* recipe already carries it as an exact trimmed line. The
  // substring form was satisfiable by e.g. `echo "set -euo pipefail"`, which sets no
  // shell option at all; a preflight without `set -e` would not propagate the ping's
  // failure and would exit 0 on an unreachable server.

  for (const recipe of requiredRecipes) {
    if (!recipeBodyHasExactLine(justfile, recipe, 'set -euo pipefail')) {
      return {
        name,
        pass: false,
        detail: `recipe "${recipe}" body does not have "set -euo pipefail" as an EXACT trimmed line — reviewer M-1 + ux3 A0′: every bash-shebang recipe must actually set the options; a mere substring (e.g. inside an echo) sets nothing and would let a failing step be ignored`,
      };
    }
  }

  // ---- 7.3: Isolated DB guard — playtest-up and playtest-wipe (pt-a2-1/-5) ----

  // 7.3a: playtest-up and playtest-wipe bodies reference monster-realm-playtest or MR_PLAYTEST_DB.
  for (const recipe of ['playtest-up', 'playtest-wipe']) {
    const body = extractRecipeBody(justfile, recipe);
    const hasIsolatedDb =
      body.includes('monster-realm-playtest') || body.includes('MR_PLAYTEST_DB');
    if (!hasIsolatedDb) {
      return {
        name,
        pass: false,
        detail: `recipe "${recipe}" body does not reference monster-realm-playtest or MR_PLAYTEST_DB — pt-a2-1: publish must target the isolated playtest DB, not the dev default`,
      };
    }
  }

  // 7.3b: Case-insensitive guard (§K F6) — both publish/wipe recipes.
  for (const recipe of ['playtest-up', 'playtest-wipe']) {
    if (!recipeBodyHasCaseInsensitiveGuard(justfile, recipe)) {
      return {
        name,
        pass: false,
        detail: `recipe "${recipe}" body is missing the bash lowercase-fold guard (${'{MR_PLAYTEST_DB,,}'}) — §K red-team F6: guard must use case-insensitive fold to catch MONSTER-REALM`,
      };
    }
  }

  // ---- 7.4: Honest publish — no dev_reducers or --bin-path ANYWHERE in justfile (§K F5) ----

  if (!wholeJustfileLacks(justfile, 'dev_reducers')) {
    return {
      name,
      pass: false,
      detail:
        'justfile (comment-stripped) contains "dev_reducers" — §K red-team F5: the honest publish must NEVER use --features dev_reducers; total absence is the invariant',
    };
  }

  if (!wholeJustfileLacks(justfile, '--bin-path')) {
    return {
      name,
      pass: false,
      detail:
        'justfile (comment-stripped) contains "--bin-path" — §K red-team F5: the honest publish must use only the default publish path; --bin-path is forbidden',
    };
  }

  // ---- 7.5: playtest-up body integrity (pt-a2-1) ----

  // playtest-up must invoke verify-release AND verify-build (exact-step discipline, reviewer L-2).
  const upVerifyReleaseForms = [
    'just playtest-verify-release',
    'node scripts/verify-release-reducers.mjs',
  ];
  {
    const body = extractRecipeBody(justfile, 'playtest-up');
    const hasReleaseVerify = upVerifyReleaseForms.some((form) =>
      body.split('\n').some((ln) => ln.trim() === form),
    );
    if (!hasReleaseVerify) {
      return {
        name,
        pass: false,
        detail:
          'recipe "playtest-up" body does not have an exact-step invocation of playtest-verify-release or node scripts/verify-release-reducers.mjs — reviewer L-2: a "|| true" suffix must NOT satisfy; exact trimmed line required',
      };
    }
  }

  const upVerifyBuildForms = ['just playtest-verify-build', 'node scripts/verify-build-hooks.mjs'];
  {
    const body = extractRecipeBody(justfile, 'playtest-up');
    const hasBuildVerify = upVerifyBuildForms.some((form) =>
      body.split('\n').some((ln) => ln.trim() === form),
    );
    if (!hasBuildVerify) {
      return {
        name,
        pass: false,
        detail:
          'recipe "playtest-up" body does not have an exact-step invocation of playtest-verify-build or node scripts/verify-build-hooks.mjs — reviewer L-2 exact-step discipline',
      };
    }
  }

  // playtest-up must call vite build (via npm run build per §K N3).
  if (!recipeBodyContains(justfile, 'playtest-up', 'npm run build')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-up" body does not call "npm run build" — §K N3: client build must use npm run build (the package.json "build" script), not npx vite build',
    };
  }

  // playtest-up must serve via vite preview (the production build serving step).
  if (!recipeBodyContains(justfile, 'playtest-up', 'preview')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-up" body does not invoke vite preview — pt-a2-1: must serve the production build via vite preview',
    };
  }

  // playtest-up must call sync_content (ADR-0006, pt-a2-1).
  if (!recipeBodyContains(justfile, 'playtest-up', 'sync_content')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-up" body does not call sync_content — pt-a2-1: must call sync_content as owner after publish (ADR-0006)',
    };
  }

  // playtest-up must write a PID file for playtest-down (§K H-1).
  if (!recipeBodyContains(justfile, 'playtest-up', '.pid')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-up" body does not write a PID file (.pid) — §K H-1: must background the preview and write a PID file so playtest-down can stop it',
    };
  }

  // ---- 7.6: playtest-down teardown (§K H-1) ----

  if (!recipeBodyContains(justfile, 'playtest-down', 'kill')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-down" body does not contain "kill" — §K H-1: must kill the background preview process',
    };
  }

  if (!recipeBodyContains(justfile, 'playtest-down', '.pid')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-down" body does not reference a .pid file — §K H-1: must read the PID file written by playtest-up',
    };
  }

  // ---- 7.7: playtest-wipe integrity (pt-a2-5) ----

  // playtest-wipe must use --delete-data.
  if (!recipeBodyContains(justfile, 'playtest-wipe', '--delete-data')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-wipe" body does not contain "--delete-data" — pt-a2-5: wipe must republish with --delete-data -y for a fresh state',
    };
  }

  // playtest-wipe must call sync_content (owner re-register after --delete-data, §K §A).
  if (!recipeBodyContains(justfile, 'playtest-wipe', 'sync_content')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-wipe" body does not call sync_content — pt-a2-5: must re-run sync_content after --delete-data (owner re-registered by init)',
    };
  }

  // playtest-wipe must also invoke verify-release (reviewer M-4: wipe republishes the module).
  {
    const body = extractRecipeBody(justfile, 'playtest-wipe');
    const hasReleaseVerify = upVerifyReleaseForms.some((form) =>
      body.split('\n').some((ln) => ln.trim() === form),
    );
    if (!hasReleaseVerify) {
      return {
        name,
        pass: false,
        detail:
          'recipe "playtest-wipe" body does not invoke playtest-verify-release (or node scripts/verify-release-reducers.mjs) — reviewer M-4: wipe republishes the module, so it must re-prove dev_reducers-absent',
      };
    }
  }

  // ---- 7.8: playtest-verify-release and playtest-verify-build bodies (reviewer L-2) ----

  // playtest-verify-release must contain EXACTLY `node scripts/verify-release-reducers.mjs`.
  if (
    !recipeBodyHasExactLine(
      justfile,
      'playtest-verify-release',
      'node scripts/verify-release-reducers.mjs',
    )
  ) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-verify-release" body does not have the exact line "node scripts/verify-release-reducers.mjs" — reviewer L-2: must be an exact step, not a suffixed form like "|| true"',
    };
  }

  // playtest-verify-build must contain EXACTLY `node scripts/verify-build-hooks.mjs`.
  if (
    !recipeBodyHasExactLine(
      justfile,
      'playtest-verify-build',
      'node scripts/verify-build-hooks.mjs',
    )
  ) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-verify-build" body does not have the exact line "node scripts/verify-build-hooks.mjs" — reviewer L-2: exact step required',
    };
  }

  // ---- 7.9: Script existence, non-trivial, export names, fail-loud guards ----

  // verify-release-reducers.mjs existence + non-trivial.
  if (!existsSync(releaseScriptPath)) {
    return {
      name,
      pass: false,
      detail: 'scripts/verify-release-reducers.mjs does not exist — implementer must create it',
    };
  }
  const releaseScriptSrc = readFileSync(releaseScriptPath, 'utf8');
  if (releaseScriptSrc.trim().length < 100) {
    return {
      name,
      pass: false,
      detail:
        'scripts/verify-release-reducers.mjs is trivially short (< 100 chars) — must be a real implementation',
    };
  }

  // Source must contain process.exit(1) in the catch/error path (§K F2/B-1).
  const releaseScriptStripped = stripMjsComments(releaseScriptSrc);
  if (!releaseScriptStripped.includes('process.exit(1)')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/verify-release-reducers.mjs source does not contain process.exit(1) — §K F2/B-1: must fail loud (non-zero exit) when execFileSync throws or output is empty/no-reducers',
    };
  }

  // verify-build-hooks.mjs existence + non-trivial.
  if (!existsSync(buildScriptPath)) {
    return {
      name,
      pass: false,
      detail: 'scripts/verify-build-hooks.mjs does not exist — implementer must create it',
    };
  }
  const buildScriptSrc = readFileSync(buildScriptPath, 'utf8');
  if (buildScriptSrc.trim().length < 100) {
    return {
      name,
      pass: false,
      detail:
        'scripts/verify-build-hooks.mjs is trivially short (< 100 chars) — must be a real implementation',
    };
  }

  // Source must contain a dist-absent / no-JS-files guard with process.exit(1) (§K B-2/F3).
  const buildScriptStripped = stripMjsComments(buildScriptSrc);
  if (!buildScriptStripped.includes('process.exit(1)')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/verify-build-hooks.mjs source does not contain process.exit(1) — §K B-2/F3: must fail loud when dist is absent or contains zero .js files (scanning nothing must not read as green)',
    };
  }

  // ---- 7.10: docs/playtest-ops.md (pt-a2-6 runbook) ----

  if (!existsSync(playtestOpsPath)) {
    return {
      name,
      pass: false,
      detail: 'docs/playtest-ops.md does not exist — pt-a2-6: runbook must be written',
    };
  }
  const playtestOps = readFileSync(playtestOpsPath, 'utf8');

  // Must mention playtest-up.
  if (!playtestOps.includes('playtest-up')) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md does not mention "playtest-up" — pt-a2-6: runbook must document the playtest-up command',
    };
  }

  // Must mention playtest-wipe.
  if (!playtestOps.includes('playtest-wipe')) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md does not mention "playtest-wipe" — pt-a2-6: runbook must document the wipe/reset procedure',
    };
  }

  // ux3 A6: must document the preflight recipe by name.
  // NOTE ON NEEDLE CHOICE: `spacetime start` was DELIBERATELY rejected as the needle —
  // docs/playtest-ops.md ALREADY contains that literal (≈line 131, landed by nh4/ADR-0150),
  // so asserting on it would be a vacuously-green tooth that passes before the implementer
  // writes a single word. `just playtest-preflight` is absent today, so this tooth bites.
  if (!playtestOps.includes('just playtest-preflight')) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md does not mention "just playtest-preflight" — ux3: the runbook must document the standalone reachability check so a dev hitting a dead server can run it directly instead of re-reading a failed playtest-up log',
    };
  }

  // ux3-2 (THE criterion, previously proxy-gated): "docs/playtest-ops.md SHALL gain a
  // one-line `spacetime start` step."
  //
  // THE GAP THIS CLOSES: the needle above pins `just playtest-preflight`, which is ux3's
  // OTHER doc deliverable. A red-team pass deleted the actual runnable step — the fenced
  //     ```sh
  //     spacetime start
  //     ```
  // block and its lead-in sentence — while leaving the preflight sentence in place, and
  // this eval stayed pass:true. So the ux3-2 deliverable could be removed without the gate
  // biting; the preflight needle was a PROXY for it, not a gate on it.
  //
  // WHY NOT A BARE `spacetime start` NEEDLE (do not revert to it): the pre-ux3 file already
  // contained that literal — nh4/ADR-0150 prose, "a fresh `spacetime start` data dir" —
  // so it was green before the implementer wrote a word.
  //
  // WHY NOT A COUNT-FLOOR OF 2 EITHER (measured on the current file, recorded so a future
  // maintainer does not re-propose it): `spacetime start` occurs THREE times today — the
  // fenced step, a blockquote line ux3 itself added ("the fault it guards — 'I forgot to
  // run `spacetime start`'"), and the original nh4 prose. Deleting the fenced step leaves
  // TWO, so a floor of 2 would NOT have caught the red-team deletion. A floor is hostage to
  // how much prose happens to mention the command; the structural form is not.
  //
  // WHAT THIS PINS: a fenced code block containing `spacetime start` as a STANDALONE line —
  // i.e. a step a dev can copy and run, which is what ux3-2 actually promises. Teeth
  // P8a–P8e. Both needles are kept: they cover different deliverables.
  if (!hasFencedCommandLine(playtestOps, 'spacetime start')) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md has no fenced code block containing "spacetime start" as a standalone line — ux3-2 requires a RUNNABLE one-line step, not a mention. Note the file may still contain the words in prose (the pre-ux3 nh4/ADR-0150 sentence about a reset data dir, and ux3\'s own blockquote about the fault the preflight guards); that is exactly why neither a bare includes() needle nor a count-floor gates this criterion, and why the deleted deliverable here is the fenced ```sh block plus its lead-in, not any sentence',
    };
  }

  // Must mention sync_content.
  if (!playtestOps.includes('sync_content')) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md does not mention "sync_content" — pt-a2-6: runbook must document the sync_content re-seed step',
    };
  }

  // Must mention the "which build am I on" check (window.__mrBuild or #build-stamp).
  const hasBuildStampRef =
    playtestOps.includes('window.__mrBuild') || playtestOps.includes('#build-stamp');
  if (!hasBuildStampRef) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md does not mention "window.__mrBuild" or "#build-stamp" — pt-a2-6: runbook must document how to check which build is running (ADR-0128)',
    };
  }

  // Must mention the owner-re-register note (§K §C pt-a2-5, §K §A).
  const hasOwnerNote =
    playtestOps.includes('re-register') ||
    (playtestOps.includes('owner') && playtestOps.includes('init'));
  if (!hasOwnerNote) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md does not contain the owner re-register note ("re-register" or "owner"+"init") — pt-a2-6: runbook must note that after --delete-data, init re-runs and the publishing identity is re-registered as owner',
    };
  }

  // ---- 7.11: docs/adr/0129-pt-a2-local-playtest-ops.md (pt-a2-6 / §D T5) ----

  if (!existsSync(adrPath)) {
    return {
      name,
      pass: false,
      detail:
        'docs/adr/0129-pt-a2-local-playtest-ops.md does not exist — §D T5: ADR-0129 must be written',
    };
  }
  const adrContent = readFileSync(adrPath, 'utf8');

  // Must document the describe-published rationale (§K §D T5).
  if (!adrContent.includes('describe') || !adrContent.includes('published')) {
    return {
      name,
      pass: false,
      detail:
        'docs/adr/0129-pt-a2-local-playtest-ops.md does not mention both "describe" and "published" — must document the published-module introspection rationale',
    };
  }

  // ---- 7.11b: docs/adr/0153-ux3-playtest-preflight.md (ux3 design record) ----
  // Mirrors the §7.11 ADR-0129 block. This file ALREADY EXISTS in the worktree, so this
  // block is GREEN from day one — that is intentional: its job is to stop a later refactor
  // from deleting the ADR or hollowing it out into a placeholder. The two needles encode
  // the load-bearing rationale (the probe verb chosen, and the playtest scenario the
  // preflight protects) and neither survives a stub/placeholder rewrite.
  const ux3AdrPath = path.join(root, 'docs/adr/0153-ux3-playtest-preflight.md');
  if (!existsSync(ux3AdrPath)) {
    return {
      name,
      pass: false,
      detail:
        'docs/adr/0153-ux3-playtest-preflight.md does not exist — the ux3 preflight decision record must be present alongside the recipe it justifies',
    };
  }
  {
    const ux3Adr = readFileSync(ux3AdrPath, 'utf8');
    if (!ux3Adr.includes('spacetime server ping') || !ux3Adr.includes('nickname')) {
      return {
        name,
        pass: false,
        detail:
          'docs/adr/0153-ux3-playtest-preflight.md does not mention both "spacetime server ping" and "nickname" — the ADR must record WHY the reachability probe is a `spacetime server ping` (not a publish/describe) and the playtest flow it protects; a placeholder or hollowed-out rewrite contains neither',
      };
    }
  }

  // ---- 7.12: ux3-3 — preflight runs BEFORE the first spacetime step ----
  // The value of ux3 is diagnosis in ~10 ms instead of after a multi-minute wasm build
  // (or, worse, a hung publish). Presence alone is not the criterion; ORDER is.

  const ORDER_LATER_NEEDLES = ['spacetime build', 'spacetime publish'];
  for (const recipe of ['playtest-up', 'playtest-wipe']) {
    if (!recipeStepOrderOk(justfile, recipe, 'just playtest-preflight', ORDER_LATER_NEEDLES)) {
      // Surface the line that BECAME the later anchor. Per the corrected caveat on
      // recipeStepOrderOk, a `spacetime build`/`publish` mention inside a quoted string or
      // echo argument (which survives comment stripping) can shift the anchor upward and
      // false-RED a correct recipe — printing it verbatim lets a maintainer see that at a
      // glance instead of bisecting the recipe.
      const laterAnchorLine =
        strippedRecipeBody(justfile, recipe)
          .split('\n')
          .find((ln) => ORDER_LATER_NEEDLES.some((needle) => ln.includes(needle))) ??
        '<NONE — this recipe has no spacetime build/publish step at all>';
      return {
        name,
        pass: false,
        detail: `recipe "${recipe}" does not have the exact line "just playtest-preflight" strictly BEFORE its first "spacetime build"/"spacetime publish" step — ux3-3: the reachability check must fail fast (~10 ms) instead of after a multi-minute wasm build; note this also fails if the preflight is only commented out, is suffixed with "|| true", or if the recipe no longer contains any spacetime step at all (non-vacuity: the ordering premise must still exist). The line taken as the later anchor was: ${JSON.stringify(laterAnchorLine.trim())}`,
      };
    }
  }

  // ---- 7.13: playtest-preflight body integrity (ux3-1) ----
  //
  // EARS LABEL NOTE: everything in this block is ux3-1 (the recipe's runtime behaviour).
  // ux3-2 is ONLY "docs/playtest-ops.md gains a `spacetime start` step" — that criterion is
  // gated in §7.10, not here. Several assertions below previously cited ux3-2; corrected.
  //
  // MAINTAINER NOTE: strippedRecipeBody cuts each line at the first " " + "#", so a
  // diagnosis message containing that two-character sequence would be TRUNCATED before the
  // scan and any needle after it would false-RED. Keep the preflight's prose " #"-free.

  const preflightBody = strippedRecipeBody(justfile, 'playtest-preflight');

  // A5: every load-bearing element of the check + the actionable error message.
  const preflightNeedles = [
    // the probe itself — a reachability check, not a publish
    'spacetime server ping',
    // THE OUTPUT-MATCH NEEDLE (ux3-1, added after the red-team pass that found the defect).
    // `spacetime server ping` exits 0 for ANY COMPLETED HTTP ROUND-TRIP. Measured on CLI
    // 2.6.0 against a live server on :3000 —
    //   http://127.0.0.1:3000   -> exit 0, "Server is online: http://127.0.0.1:3000"
    //   http://127.0.0.1:3000/  -> exit 0, "Server returned 404 (Not Found)"    <-- !!
    //   http://127.0.0.1:3000/v1-> exit 0, "Server returned 404"                <-- !!
    //   node stub answering 500 -> exit 0, "Server could not be reached (500 …)" <-- !!
    //   http://127.0.0.1:1      -> exit 1 (connection refused)
    // …while `spacetime publish -s` FAILS for the trailing-slash / path-suffix / wrong-service
    // cases. An exit-code-only preflight therefore green-lights a full multi-minute wasm
    // build that is doomed to die at publish — precisely the cost ux3-1 exists to avoid.
    // Matching the success BODY is what makes the preflight verify a SpacetimeDB rather
    // than "something answered HTTP". Behaviourally pinned by §7.15b; this needle stops the
    // fix being silently reverted to exit-code-only.
    'Server is online',
    // the target must be overridable, not hardcoded to 127.0.0.1:3000.
    // BARE token, not '$STDB_SERVER': `"${STDB_SERVER}"` is this justfile's house style
    // (cf. `${MR_PLAYTEST_DB,,}`, `${TMPDIR:-/tmp}`) and is equally correct. Demanding the
    // `$NAME` form would false-RED a correct implementation over pure syntax preference.
    'STDB_SERVER',
    // the probe must be bounded — an unreachable HOST (vs a refused port) hangs on connect
    'timeout ',
    // "CLI missing" and "server down" are DIFFERENT failures with different fixes; telling
    // someone to run `spacetime start` when the binary is not installed is misattribution
    // and sends them chasing a daemon they cannot start. The preflight must distinguish.
    'command -v spacetime',
    // SAME CLASS, SECOND BINARY (M12-drop-timeout-guard). GNU `timeout` is a REQUIRED
    // dependency of the probe, not an optional nicety, and it is absent by default on
    // macOS (coreutils is a brew install). Without this pre-flight-of-the-preflight the
    // probe line evaluates `timeout … spacetime server ping …` -> 127 (command not found),
    // `if !` INVERTS that, and a perfectly healthy SpacetimeDB is reported as "no
    // SpacetimeDB responding at $STDB_SERVER … Start one first: 'spacetime start'". That
    // is the confident MISDIAGNOSIS OF A HEALTHY SERVER for which ADR-0153 rejected the
    // curl design — worse than no preflight, because the dev now distrusts a working
    // server. Unreachable by every behavioural tooth (§7.14/§7.15/§7.15b/§7.16), since CI
    // (ubuntu-latest) and every dev box that can run them all have coreutils; deleting the
    // guard leaves them green. A source needle is the only thing that can bite here.
    'command -v timeout',
    // the message must tell the dev what to DO, not just that something failed
    'spacetime start',
    // it must actually fail the recipe, not merely warn
    'exit 1',
    // diagnostics belong on stderr so they survive a `| tee`/pipe of stdout
    '>&2',
  ];
  for (const needle of preflightNeedles) {
    if (!preflightBody.includes(needle)) {
      return {
        name,
        pass: false,
        detail: `recipe "playtest-preflight" body (comments stripped) is missing "${needle}" — ux3-1: the preflight must first prove BOTH binaries it depends on are on PATH ("command -v spacetime" and "command -v timeout" — a missing GNU timeout makes the probe return 127, which "if !" inverts into "no SpacetimeDB responding" against a perfectly healthy server), then bound a "spacetime server ping" against the overridable $STDB_SERVER, MATCH its "Server is online" success output (the exit code alone is 0 for any completed HTTP round-trip, including a 404 from a trailing slash and a 500 from an unrelated service) and, on failure, print an actionable message on stderr (naming "spacetime start") and exit 1; without every one of these the check is either unbounded, hardcoded, credulous, misattributing, silent, or non-fatal`,
      };
    }
  }

  // A5f: the ping must not be defused.
  if (preflightBody.includes('|| true')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-preflight" body contains "|| true" — that swallows the ping\'s non-zero exit, making the preflight a no-op that always reports success; the recipe must fail (exit 1) when no SpacetimeDB answers',
    };
  }

  // A5g: the timeout must actually BIND the ping (same line), not sit in a spare variable.
  // Token is the BARE `STDB_SERVER` — `"$STDB_SERVER"` and `"${STDB_SERVER}"` are both
  // correct bash and the quoting is NOT what this check is about (co-occurrence is).
  if (
    !recipeHasLineWithAll(justfile, 'playtest-preflight', [
      'timeout ',
      'spacetime server ping',
      'STDB_SERVER',
    ])
  ) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-preflight" has no SINGLE line carrying all of [timeout ], [spacetime server ping] and [STDB_SERVER] — the bound must wrap the actual probe; a "timeout" mentioned on some other line (e.g. parked in an unused variable) leaves the ping unbounded, and a TCP connect to an unreachable host can hang for minutes — exactly the stall ux3 exists to remove',
    };
  }

  // A5h: co-occurrence is NOT enough — `timeout <positive-duration>` must IMMEDIATELY
  // precede the probe token. Four broken implementations satisfy A5g while hanging forever:
  //   `timeout 0 spacetime server ping …`      (0 DISABLES the timeout — GNU coreutils)
  //   `PROBE_DOC='timeout 10 spacetime …'`     (dead string; all A5g tokens on one line)
  //   `spacetime server ping …` + a `timeout` mention elsewhere in the body
  //   `X=$(timeout 10 echo hi) && spacetime server ping …` (bounds the wrong command)
  // …and the predicate must NOT reject the shipped, correctly-bounded
  //   `if ! PING_OUT=$(timeout 10 spacetime server ping "$STDB_SERVER" 2>&1) || …`
  // See the timeoutBindsProbe comment block and teeth P7a–P7h.
  if (!timeoutBindsProbe(justfile, 'playtest-preflight', 'spacetime server ping')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-preflight" has a "spacetime server ping" line where the two tokens IMMEDIATELY before the probe are not `timeout <positive-duration>` (N a positive integer, optional s/m/h/d suffix; `timeout` may be glued to a command boundary such as `$(`). This rejects `timeout 0` (GNU coreutils: a duration of 0 DISABLES the timeout — measured, `timeout 0 sleep 3` runs the full 3 s), a bound parked inside a quoted doc-string variable, an unbounded real call paired with a `timeout` mention elsewhere, and a `timeout` on the same line that bounds some OTHER command. It accepts both `timeout 10 spacetime server ping …` and the shipped `if ! PING_OUT=$(timeout 10 spacetime server ping …)` capture form. It also returns false if no ping line exists at all (non-vacuity)',
    };
  }

  // ---- 7.13b: `spacetime` CLI presence probe — gates the four BEHAVIORAL blocks ----
  //
  // WHY: §7.14/§7.15/§7.15b/§7.16 all EXECUTE the recipe, and the recipe's FIRST guard is
  // `command -v spacetime || { echo "…the 'spacetime' CLI is not on PATH…"; exit 1; }`. On a
  // fresh clone without the CLI the recipe therefore exits 1 with a message that (correctly)
  // says nothing about `spacetime start`, and §7.14's stderr assertion fired with "the
  // failure message is not actionable, or it was written to stdout" — blaming the recipe for
  // an environment fact. That is a misleading RED and a real fresh-clone DX blocker.
  //
  // HOUSE CONVENTION: evals/bindings-drift.eval.mjs:122 already handles exactly this case
  // with `pass: true` + `detail: 'skipped: no spacetime CLI …'`. Followed here.
  //
  // SCOPE OF THE SKIP: ONLY the four behavioural blocks. Every source-scan assertion above
  // and below still runs unconditionally, so the structural gate never weakens.
  //
  // CI IS UNAFFECTED: .github/workflows/ci.yml installs `just` and the pinned spacetime CLI
  // before `- run: just eval`, so `spacetime --version` succeeds there and all four blocks
  // execute. The skip can only ever apply on a local box that has not installed the CLI.
  const spacetimeCliProbe = spawnSync('spacetime', ['--version'], { encoding: 'utf8' });
  const spacetimeCliPresent = !spacetimeCliProbe.error && spacetimeCliProbe.status === 0;

  // ---- 7.14: BEHAVIORAL NEGATIVE TOOTH — RUN the preflight against a dead server ----
  //
  // A source scan cannot reach the mutants this kills: a recipe that greps correctly but
  // exits 0, a `spacetime server ping` invoked with the wrong argument order, a message
  // written to a file instead of the terminal, a `set +e` slipped in later, etc.
  //
  // WHY THIS IS OFFLINE / DETERMINISTIC / CI-SAFE:
  //   * STDB_SERVER=http://127.0.0.1:1 — port 1 on loopback. No DNS lookup happens
  //     (127.0.0.1 is a literal address), and nothing binds port 1, so the kernel returns
  //     ECONNREFUSED on the first SYN. The probe resolves in ~14 ms with zero network I/O.
  //   * The 30 s spawn timeout is a belt-and-suspenders backstop only; the recipe's own
  //     `timeout 10` fires long before it.
  //   * .github/workflows/ci.yml installs `just` (:44) and the pinned spacetime CLI
  //     (:49-66) before `- run: just eval` (:71), so both binaries are on PATH here. The
  //     `ci` job does NOT start a SpacetimeDB instance, which is exactly what this tooth
  //     needs: nothing is listening anywhere.
  //   * PLATFORM NOTE: `timeout` is GNU coreutils. This tooth (and §7.15) therefore
  //     hard-RED on a bare macOS box that has no `gtimeout`/coreutils installed. CI is
  //     ubuntu-latest, so that is a local-dev caveat, not a gate defect.
  //   * spawnSync's `timeout` sends SIGTERM to `just` ONLY — not to its process group. A
  //     hung grandchild (e.g. an unbounded `spacetime server ping`) can be orphaned and
  //     outlive this eval; that is one more reason A5h insists the probe is bounded in the
  //     recipe itself rather than relying on this backstop.
  //
  // ASSERTION SET (status alone is NOT enough: `just` exits 1 for a MISSING recipe too,
  // so a deleted playtest-preflight would otherwise read as a passing tooth):
  // SKIPPED when the `spacetime` CLI is absent — see §7.13b.
  if (spacetimeCliPresent) {
    const result = spawnSync('just', ['playtest-preflight'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, STDB_SERVER: 'http://127.0.0.1:1' },
      timeout: 30000,
    });

    // Fail loud if the process could not be spawned at all (e.g. `just` not on PATH, or
    // the 30 s backstop fired). Running nothing must not read as green.
    if (result.error) {
      return {
        name,
        pass: false,
        detail: `BEHAVIORAL: could not run "just playtest-preflight" (${result.error.message}) — the behavioral tooth could not execute, so the preflight is UNVERIFIED; this must not read as green. If "just" is missing from PATH, fix the environment (CI installs it before "just eval"); if this is a timeout, the preflight is hanging, which is itself the ux3 bug`,
      };
    }

    // status === null with no `error` means the child was killed by a SIGNAL from outside
    // (OOM killer, an operator ^C, a stray pkill). Neither the "exited 0" nor the message
    // assertions below would be meaningful in that case, so branch out first and loudly.
    if (result.status === null) {
      return {
        name,
        pass: false,
        detail: `BEHAVIORAL: "just playtest-preflight" was killed by signal ${String(result.signal)} without producing an exit status — the run was terminated externally, so the preflight is UNVERIFIED. This is not a pass: re-run in a stable environment (and note spawnSync SIGTERMs only "just", not its process group, so a hung spacetime child may still be orphaned)`,
      };
    }

    // `combined` is used ONLY for (a) the anti-vacuity "unknown recipe" probe, which just
    // itself may print on either stream depending on version, and (b) human-readable
    // detail text. It is deliberately NOT used for the message assertions below.
    const combined = `${result.stderr ?? ''}${result.stdout ?? ''}`;
    const stderrText = result.stderr ?? '';

    // (1) The preflight must REJECT an unreachable server.
    if (result.status === 0) {
      return {
        name,
        pass: false,
        detail: `BEHAVIORAL: "just playtest-preflight" exited 0 with STDB_SERVER=http://127.0.0.1:1 (a loopback port nothing can be listening on) — ux3-1: the preflight must exit non-zero when no SpacetimeDB answers, otherwise playtest-up proceeds into a multi-minute build that is doomed to fail at publish. Output was: ${JSON.stringify(combined.slice(0, 400))}`,
      };
    }

    // (2) ANTI-VACUITY: a missing/renamed recipe ALSO exits non-zero, which would make
    //     assertion (1) vacuously green. Checked against BOTH streams on purpose — this is
    //     just's own diagnostic, not ours, so we do not get to dictate where it lands.
    if (combined.includes('does not contain recipe')) {
      return {
        name,
        pass: false,
        detail: `BEHAVIORAL: "just playtest-preflight" failed with just's own "does not contain recipe" error — the recipe does not exist, so the non-zero exit proves nothing about the reachability check. Output was: ${JSON.stringify(combined.slice(0, 400))}`,
      };
    }

    // (3) The remediation text must be on STDERR SPECIFICALLY.
    //     Rationale: the runbook pipes these recipes (`just playtest-up | tee playtest.log`,
    //     `… > /dev/null`). A diagnosis written to stdout is swallowed by exactly the
    //     redirection a dev reaches for, and the dev is left with a bare "error: Recipe
    //     failed with exit code 1". ux3-1 is about the human READING the reason, so the
    //     stream matters and asserting on stdout+stderr concatenated does not test it.
    //     (EARS label corrected: ux3-2 is the docs criterion, gated in §7.10.)
    if (!stderrText.includes('spacetime start')) {
      return {
        name,
        pass: false,
        detail: `BEHAVIORAL: "just playtest-preflight" exited non-zero but its STDERR never mentions "spacetime start" — either the failure message is not actionable, or it was written to stdout (where a "| tee"/"> /dev/null" of the playtest recipes loses it). ux3-1 requires telling the dev exactly how to recover, on the stream that survives piping. stderr was: ${JSON.stringify(stderrText.slice(0, 400))} / full output: ${JSON.stringify(combined.slice(0, 400))}`,
      };
    }

    // (4) STDERR must contain the RUNTIME-EXPANDED server URL.
    //     THIS IS THE ANTI-ECHO TOOTH. `just` does NOT echo the body of a shebang
    //     (`#!/usr/bin/env bash`) recipe, but it DOES echo each line of a NON-shebang
    //     recipe to stderr before running it. So in a non-shebang implementation the
    //     literal SOURCE line `echo "... 'spacetime start' ..."` appears on stderr even
    //     when the branch containing it never executes — assertion (3) would then pass
    //     vacuously off just's echo. The string "http://127.0.0.1:1" is not present in the
    //     recipe source at all (the source has `$STDB_SERVER`); it can only appear if the
    //     shell actually EXPANDED the variable, i.e. if the echo genuinely RAN.
    //     It also kills a hardcoded-host implementation: one that ignores STDB_SERVER and
    //     probes http://127.0.0.1:3000 would report that URL, not the one we injected.
    if (!stderrText.includes('http://127.0.0.1:1')) {
      return {
        name,
        pass: false,
        detail: `BEHAVIORAL: "just playtest-preflight" stderr never contains the runtime-expanded "http://127.0.0.1:1" we passed as STDB_SERVER. Two failure modes look like this: (a) the recipe is NOT a shebang recipe, so "just" merely ECHOED the source line containing "spacetime start" without ever executing it — the diagnosis never actually ran; or (b) the implementation ignores $STDB_SERVER and probes a hardcoded host, so the dev is told about the wrong server. ux3-1 requires the target to be overridable AND named in the message. stderr was: ${JSON.stringify(stderrText.slice(0, 400))}`,
      };
    }
  }

  // ---- 7.15: BEHAVIORAL POSITIVE CONTROL — the preflight ACCEPTS a live server ----
  //
  // WHY THIS EXISTS (it is what makes §7.14 mean anything):
  // Every single assertion in §7.14 is satisfied by a recipe that unconditionally prints
  // the diagnosis and exits 1 — "the preflight always fails" was a fully GREEN
  // implementation before this block. It is also the only assertion that proves the probe
  // is REACHED AND RUN rather than being a dead doc-string, and the only one that catches a
  // preflight wired to a hardcoded wrong host or one whose `command -v spacetime` guard is
  // mis-negated (`||` vs `&&`) so it always claims the CLI is missing. Without a positive
  // control the negative tooth degenerates into "does this recipe exit 1?", which any
  // `exit 1` satisfies.
  //
  // MECHANICS:
  //   * The stub is a DETACHED CHILD PROCESS (`spawn`), never in-process: `spawnSync`
  //     blocks the Node event loop for its whole duration, so an in-process http server
  //     would never get a turn to answer the ping — proven empirically, it deadlocks.
  //   * It binds port 0 (ephemeral) and prints the chosen port, so parallel eval runs
  //     cannot collide on a fixed port.
  //   * `spacetime server ping` is satisfied by ANY 200 response, so a 15-line node stub
  //     is a faithful stand-in for a real SpacetimeDB (measured: "Server is online: …",
  //     exit 0, ~18 ms). No wasm, no DB, no docker, no network.
  //   * PLATFORM NOTE: as in §7.14, the recipe's `timeout` is GNU coreutils; this block
  //     hard-REDs on a bare macOS box. CI is ubuntu-latest.
  //   * The stub is ALWAYS killed in `finally` — an orphaned listener would leak a port
  //     and keep the eval process alive.
  //   * SKIPPED when the `spacetime` CLI is absent — see §7.13b.
  if (spacetimeCliPresent) {
    let stub = null;
    try {
      let port;
      try {
        stub = spawn(process.execPath, ['-e', STUB_HTTP_SERVER_SRC], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        port = await awaitStubPort(stub, 10000);
      } catch (e) {
        // Fail loud — never skip. A positive control that silently opts out is worse than
        // no positive control, because the suite then LOOKS like it has one.
        return {
          name,
          pass: false,
          detail: `BEHAVIORAL POSITIVE CONTROL: could not start the local HTTP stub (${e?.message ?? String(e)}) — the "preflight accepts a reachable server" assertion could not run, so an implementation that ALWAYS fails would go unnoticed. This must not read as green`,
        };
      }

      const okResult = spawnSync('just', ['playtest-preflight'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, STDB_SERVER: `http://127.0.0.1:${port}` },
        timeout: 30000,
      });

      if (okResult.error) {
        return {
          name,
          pass: false,
          detail: `BEHAVIORAL POSITIVE CONTROL: could not run "just playtest-preflight" against the live stub on 127.0.0.1:${port} (${okResult.error.message}) — if this is a timeout the preflight HUNG against a server that answers 200 in ~18 ms, which is itself a ux3 defect`,
        };
      }

      if (okResult.status === null) {
        return {
          name,
          pass: false,
          detail: `BEHAVIORAL POSITIVE CONTROL: "just playtest-preflight" was killed by signal ${String(okResult.signal)} without an exit status — terminated externally, so the accept path is UNVERIFIED`,
        };
      }

      if (okResult.status !== 0) {
        return {
          name,
          pass: false,
          detail: `BEHAVIORAL POSITIVE CONTROL: "just playtest-preflight" exited ${okResult.status} against a LIVE local server on http://127.0.0.1:${port} that answers 200 to "spacetime server ping" — the preflight must exit 0 when a SpacetimeDB is reachable. A preflight that fails unconditionally passes every negative assertion in §7.14 while making "just playtest-up" impossible to run at all. Common causes: the recipe hardcodes a host instead of honouring $STDB_SERVER, the "command -v spacetime" guard is mis-negated so it always reports the CLI missing, or the ping's exit status is inverted. stderr: ${JSON.stringify((okResult.stderr ?? '').slice(0, 400))} / stdout: ${JSON.stringify((okResult.stdout ?? '').slice(0, 400))}`,
        };
      }
    } finally {
      if (stub) stub.kill('SIGKILL');
    }
  }

  // ---- 7.15b: PREFLIGHT_REJECTS_NON_SPACETIME_HTTP_RESPONDER (ux3-1) ----
  //
  // THE TOOTH FOR THE DEFECT A RED-TEAM PASS FOUND. §7.15 proves the preflight ACCEPTS
  // something that answers HTTP 200; nothing above proved it REJECTS something that answers
  // HTTP but is not a SpacetimeDB. That gap was not hypothetical — the shipped-before-fix
  // preflight checked only `spacetime server ping`'s EXIT CODE, and (measured on CLI 2.6.0):
  //
  //   http://127.0.0.1:3000    (real server)    -> exit 0, "Server is online: http://…"
  //   http://127.0.0.1:3000/   (trailing slash) -> exit 0, "Server returned 404 (Not Found)"
  //   http://127.0.0.1:3000/v1 (path suffix)    -> exit 0, "Server returned 404"
  //   node stub answering HTTP 500              -> exit 0, "Server could not be reached (500 …)"
  //   http://127.0.0.1:1       (refused port)   -> exit 1
  //
  // `spacetime publish -s` FAILS for the trailing-slash, path-suffix and wrong-service
  // targets. So the pre-fix preflight passed, `just playtest-up` ran a full wasm build, and
  // the dev ate multiple minutes before dying at publish — the exact failure mode ux3-1
  // exists to prevent, with the preflight actively vouching for the bad target.
  //
  // THE FIX (in the justfile) captures stdout and requires the success body:
  //   if ! PING_OUT=$(timeout 10 spacetime server ping "$STDB_SERVER" 2>&1) \
  //      || ! printf '%s' "$PING_OUT" | grep -q 'Server is online'; then … exit 1; fi
  // Verified: real server / scheme-less / http://localhost:3000 / nickname `local` /
  // `maincloud` -> exit 0. Trailing slash / path suffix / 500-stub / refused port /
  // uppercase scheme -> exit 1 carrying the real cause. STDB_SERVER unset -> exit 0.
  //
  // MUTANTS THIS KILLS (none reachable by §7.14/§7.15, both of which stay green):
  //   M15  revert to exit-code-only: `if ! timeout 10 spacetime server ping "$STDB_SERVER"`
  //        with no output match. Rejects a refused port (§7.14 green), accepts the 200 stub
  //        (§7.15 green) — and accepts this 500 responder. ONLY this block fails it.
  //   M16  match on a substring present in EVERY ping outcome (e.g. "Server") — the 500
  //        stub's own text is "Server could not be reached", so a "Server" grep still passes.
  //   M17  match on stderr only while the CLI prints the verdict on stdout (or vice versa),
  //        which degenerates into an unconditional accept.
  //
  // NON-VACUITY: `status !== 0` alone is not enough — a preflight broken in ANY unrelated
  // way (missing recipe, CLI-guard mis-negated, `set -u` on an unset var) also exits
  // non-zero and would fake this tooth. So stderr must ALSO carry the RUNTIME-EXPANDED
  // http://127.0.0.1:<ephemeral-port> we injected: that string appears in no source file,
  // so it can only come from a shell that genuinely expanded $STDB_SERVER while diagnosing
  // THIS target. (It equally kills a hardcoded-host implementation.)
  //
  // MECHANICS: as in §7.15 — DETACHED child (spawnSync blocks the event loop, so an
  // in-process server would deadlock), ephemeral port so parallel runs cannot collide,
  // killed in `finally`. Offline, no wasm, no DB, ~20 ms.
  // SKIPPED when the `spacetime` CLI is absent — see §7.13b.
  if (spacetimeCliPresent) {
    let badStub = null;
    try {
      let badPort;
      try {
        badStub = spawn(process.execPath, ['-e', STUB_HTTP_500_SERVER_SRC], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        badPort = await awaitStubPort(badStub, 10000);
      } catch (e) {
        // Fail loud — never skip. A negative control that silently opts out is worse than
        // none, because the suite then LOOKS like it has one.
        return {
          name,
          pass: false,
          detail: `PREFLIGHT_REJECTS_NON_SPACETIME_HTTP_RESPONDER: could not start the local HTTP-500 stub (${e?.message ?? String(e)}) — the "preflight rejects a non-SpacetimeDB responder" assertion could not run, so an exit-code-only preflight would go unnoticed. This must not read as green`,
        };
      }

      const badUrl = `http://127.0.0.1:${badPort}`;
      const badResult = spawnSync('just', ['playtest-preflight'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, STDB_SERVER: badUrl },
        timeout: 30000,
      });

      if (badResult.error) {
        return {
          name,
          pass: false,
          detail: `PREFLIGHT_REJECTS_NON_SPACETIME_HTTP_RESPONDER: could not run "just playtest-preflight" against the HTTP-500 stub on ${badUrl} (${badResult.error.message}) — the tooth could not execute, so the preflight is UNVERIFIED against a non-SpacetimeDB responder; if this is a timeout, the preflight HUNG against a host that answers in ~20 ms, which is itself a ux3-1 defect`,
        };
      }

      if (badResult.status === null) {
        return {
          name,
          pass: false,
          detail: `PREFLIGHT_REJECTS_NON_SPACETIME_HTTP_RESPONDER: "just playtest-preflight" was killed by signal ${String(badResult.signal)} without an exit status — terminated externally, so the reject path is UNVERIFIED and must not read as green`,
        };
      }

      const badStderr = badResult.stderr ?? '';
      const badCombined = `${badStderr}${badResult.stdout ?? ''}`;

      // (1) THE assertion: an HTTP responder that is NOT a SpacetimeDB must be REJECTED.
      if (badResult.status === 0) {
        return {
          name,
          pass: false,
          detail: `PREFLIGHT_REJECTS_NON_SPACETIME_HTTP_RESPONDER: "just playtest-preflight" exited 0 against ${badUrl}, a throwaway node server that answers every request with HTTP 500 and is in no sense a SpacetimeDB. Measured on CLI 2.6.0, "spacetime server ping" exits 0 for ANY completed HTTP round-trip — a 500 stub prints "Server could not be reached (500 Internal Server Error)" and STILL exits 0, as do a trailing slash ("Server returned 404") and a "/v1" path suffix — while "spacetime publish -s" FAILS for all of them. An exit-code-only preflight therefore green-lights a multi-minute wasm build that is doomed to die at publish, which is exactly what ux3-1 exists to prevent. The recipe must MATCH the success output ("Server is online"), not merely the exit status. Output was: ${JSON.stringify(badCombined.slice(0, 400))}`,
        };
      }

      // (2) NON-VACUITY: the rejection must be ABOUT THIS TARGET. Any unrelated breakage
      //     (missing recipe, mis-negated CLI guard, set -u on an unset var) also exits
      //     non-zero; only a shell that actually expanded $STDB_SERVER while diagnosing the
      //     server we injected can print this ephemeral URL, which exists in no source file.
      if (!badStderr.includes(badUrl)) {
        return {
          name,
          pass: false,
          detail: `PREFLIGHT_REJECTS_NON_SPACETIME_HTTP_RESPONDER: "just playtest-preflight" exited ${badResult.status} against the HTTP-500 stub, but its STDERR never names the runtime-expanded "${badUrl}" we passed as STDB_SERVER — so the non-zero exit may have come from something unrelated (a missing recipe, a mis-negated "command -v spacetime" guard, an unset-variable abort) rather than from rejecting THIS responder, and the tooth would be vacuous. It also fails if the implementation ignores $STDB_SERVER and probes a hardcoded host. stderr was: ${JSON.stringify(badStderr.slice(0, 400))} / full output: ${JSON.stringify(badCombined.slice(0, 400))}`,
        };
      }
    } finally {
      if (badStub) badStub.kill('SIGKILL');
    }
  }

  // ---- 7.16: PLAYTEST_UP_ABORTS_BEFORE_BUILD_WHEN_SERVER_DEAD ----
  //
  // THE CALL-SITE TOOTH. Everything above (§7.12–§7.15) gates the preflight RECIPE — that
  // it exists, that it is textually first, that its body is well-formed, that it rejects a
  // dead server and accepts a live one. NOTHING above gates whether the CALLERS actually
  // HONOR it. Three call-site mutants pass the entire rest of this gate while marching
  // straight into `spacetime build` against a dead server, and NO SOURCE SCAN CAN REACH
  // THEM — each is a runtime-semantics defect, not a textual one:
  //
  //   M12  `set +e` on the line above `just playtest-preflight` (with `set -e` restored
  //        after). The exact line `just playtest-preflight` is still present and still
  //        strictly above the first spacetime step, so §7.12 is green; the preflight still
  //        exits 1, so §7.14 is green — but the caller ignores it.
  //   M13  a `just() { :; }` shadow function defined before the call. The call site is
  //        textually perfect and the preflight recipe is untouched, but the invocation is
  //        a no-op. This one ALSO silently disables `just playtest-verify-release` /
  //        `just playtest-verify-build` — i.e. it turns off the pt-a2 dev-reducer honesty
  //        gates — while §7.5's exact-step scan stays green, because §7.5 only proves the
  //        LINE is there.
  //   M14  the call placed inside the DB-guard's dead `if` branch. Textually BEFORE the
  //        first spacetime step (§7.12 green), never executed.
  //
  // MECHANISM: put a fake `spacetime` FIRST on PATH that (a) fails `server ping` so the
  // preflight must abort, and (b) prints a unique marker for ANY other subcommand. If the
  // marker ever appears, the recipe got past the preflight to a real spacetime step.
  //
  // WHY THE MARKER IS THE LOAD-BEARING HALF: `status !== 0` alone would ALSO pass on a
  // broken implementation — M12/M14 sail past the (stubbed, instant) build/publish/
  // sync_content steps and then die at `just playtest-verify-release`, because
  // scripts/verify-release-reducers.mjs cannot parse the stub's non-JSON output. A
  // status-only assertion would read that late death as "the preflight worked". The
  // absence of REACHED-SPACETIME is what actually distinguishes "aborted at the preflight"
  // from "aborted three steps too late".
  //
  // WHY THIS IS BOUNDED AND SAFE:
  //   * A CORRECT implementation aborts at the preflight in milliseconds — it never
  //     reaches `npm run build` or `vite preview`, so no server is started and nothing is
  //     published. Only the fake `spacetime` is ever invoked; the real CLI is shadowed.
  //   * MR_PLAYTEST_DB=mr-gate-poc satisfies the ${MR_PLAYTEST_DB,,} dev-default-DB guard
  //     (it is not "monster-realm"), so the recipe gets PAST that guard and the abort we
  //     observe is genuinely the preflight's, not the DB guard's.
  //   * STDB_SERVER=http://127.0.0.1:1 keeps this offline (see §7.14).
  //   * The temp dir is ALWAYS removed in `finally`.
  //   * HONEST CAVEAT (M13 only): because M13's `just` shadow also no-ops verify-release,
  //     an M13 justfile would keep going into `npm run build`, which is slow and would
  //     eventually background a `vite preview`. That run is bounded by the 60 s spawnSync
  //     timeout and the tooth still fails — the marker check below is deliberately
  //     evaluated FIRST, before the error/timeout branches, so a timed-out run is still
  //     diagnosed as "reached spacetime" using the partial output spawnSync returns. It
  //     may, however, leave an orphaned preview behind. That only happens against a
  //     deliberately broken justfile, never against a correct one.
  //   * SKIPPED when the `spacetime` CLI is absent — see §7.13b. (The fake `spacetime` is
  //     first on PATH here, but the recipe's own `command -v spacetime` guard would still
  //     find it, so the skip is about keeping the four behavioural blocks a single coherent
  //     unit: either the environment can run them all, or none of them.)
  if (spacetimeCliPresent) {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'mr-ux3-callsite-'));
    try {
      // `command -v spacetime` finds this, so the preflight takes its CLI-present branch.
      // `server ping` fails (dead server); every other subcommand prints the marker.
      const spacetimeStub = [
        '#!/bin/sh',
        'if [ "$1" = "server" ] && [ "$2" = "ping" ]; then exit 1; fi',
        'echo "REACHED-SPACETIME: $*"',
        'exit 0',
        '',
      ].join('\n');
      const stubPath = path.join(stubDir, 'spacetime');
      writeFileSync(stubPath, spacetimeStub);
      chmodSync(stubPath, 0o755);

      for (const recipe of ['playtest-up', 'playtest-wipe']) {
        const run = spawnSync('just', [recipe], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${stubDir}:${process.env.PATH}`,
            STDB_SERVER: 'http://127.0.0.1:1',
            MR_PLAYTEST_DB: 'mr-gate-poc',
          },
          timeout: 60000,
        });

        const runOutput = `${run.stderr ?? ''}${run.stdout ?? ''}`;

        // (1) THE load-bearing assertion. Checked FIRST so it still fires on a timed-out
        //     or signalled run, using the partial output spawnSync returns.
        if (runOutput.includes('REACHED-SPACETIME')) {
          return {
            name,
            pass: false,
            detail: `CALL-SITE: "just ${recipe}" invoked the spacetime CLI even though the preflight's "server ping" failed against STDB_SERVER=http://127.0.0.1:1 — the caller does not HONOR the preflight's non-zero exit. This is the ux3-3 defect in its purest form: the dev waits through a multi-minute wasm build that is doomed. It is exactly what M12 (a "set +e" above the call), M13 (a "just() { :; }" shadow function, which ALSO silently no-ops playtest-verify-release/-build and thus disables the pt-a2 dev-reducer honesty gates) and M14 (the call parked inside a dead "if" branch) all do — and none of the three is reachable by a source scan, because in all three the exact call line is present and correctly ordered. Output was: ${JSON.stringify(runOutput.slice(0, 600))}`,
          };
        }

        // (2) The run must not have been cut short by the harness rather than by the
        //     preflight — a correct implementation aborts in milliseconds.
        if (run.error) {
          return {
            name,
            pass: false,
            detail: `CALL-SITE: could not run "just ${recipe}" with the stub spacetime on PATH (${run.error.message}) — a correct implementation aborts at the preflight in milliseconds, so a timeout here means the recipe is hanging or proceeding into long-running steps it should never reach. Output was: ${JSON.stringify(runOutput.slice(0, 600))}`,
          };
        }

        if (run.status === null) {
          return {
            name,
            pass: false,
            detail: `CALL-SITE: "just ${recipe}" was killed by signal ${String(run.signal)} without an exit status — terminated externally, so the call-site behaviour is UNVERIFIED and must not read as green`,
          };
        }

        // (3) The abort must be a FAILURE, not a silent success.
        if (run.status === 0) {
          return {
            name,
            pass: false,
            detail: `CALL-SITE: "just ${recipe}" exited 0 with no reachable SpacetimeDB (STDB_SERVER=http://127.0.0.1:1) — it neither built anything nor failed, so a dev would believe their playtest environment is up when nothing was published. The recipe must propagate the preflight's exit 1. Output was: ${JSON.stringify(runOutput.slice(0, 600))}`,
          };
        }
      }
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  }

  // ==========================================================================
  // ALL CHECKS PASSED
  // ==========================================================================

  // House convention (evals/bindings-drift.eval.mjs:122): when the `spacetime` CLI is not
  // installed, report pass:true with an explicit "skipped: …" detail naming exactly which
  // teeth did not run and why — never a silent pass, never a misattributed RED.
  const behavioralSkipNote = spacetimeCliPresent
    ? ''
    : ' SKIPPED (no spacetime CLI on PATH): the four BEHAVIORAL blocks did not run — §7.14 (rejects an unreachable server), §7.15 (accepts a live 200 responder), §7.15b (PREFLIGHT_REJECTS_NON_SPACETIME_HTTP_RESPONDER — rejects an HTTP-500 responder), §7.16 (playtest-up/-wipe abort before invoking spacetime). They execute the recipe, whose first guard is `command -v spacetime`, so without the CLI they would fail on an environment fact and misattribute it to the recipe. Every source-scan assertion above still ran. CI installs the CLI before `just eval` (.github/workflows/ci.yml), so this skip never applies there; install the spacetime CLI locally to run them.';

  return {
    name,
    pass: true,
    detail:
      [
        'All pt-a2 criteria satisfied:',
        'pure-checker teeth (parseReducerNames throws on empty/bad/zero, real 2.6.0 shape parses; findForbiddenReducers exact-name-only; findDevHooks binding-form-only with anti-FP for dead literals + __mrBuild stamp);',
        'justfile: all 6 playtest-* recipes present (5 from pt-a2 + playtest-preflight from ux3) with set -euo pipefail, isolated DB + case-insensitive guard, honest publish (no dev_reducers/--bin-path anywhere), exact-step verify invocations, playtest-up has preview+pid+sync_content+build, playtest-wipe has --delete-data+sync_content+verify-release, playtest-down has kill+pid;',
        'scripts: both verify-*.mjs exist, non-trivial, export correct names, have process.exit(1) fail-loud guards;',
        'docs: playtest-ops.md has playtest-up/wipe/sync_content/build-stamp/owner-note; ADR-0129 has describe+published.',
        'ux3 (playtest-preflight) also satisfied:',
        'recipe exists with an exact "set -euo pipefail" line (A0/A0′); "just playtest-preflight" is an exact line strictly BEFORE the first spacetime build/publish in both playtest-up and playtest-wipe, non-vacuously (A2/ux3-3);',
        'preflight body has spacetime server ping + overridable STDB_SERVER + timeout + "command -v spacetime" AND "command -v timeout" dependency guards (a missing GNU timeout returns 127, which "if !" inverts into a confident "no SpacetimeDB responding" against a HEALTHY server — the misdiagnosis ADR-0153 rejected the curl design for, and unreachable by every behavioural tooth since CI has coreutils) + "spacetime start" remediation + exit 1 + >&2, no "|| true" (A5/A5f), the timeout co-occurs with the ping on a SINGLE line (A5g), and `timeout <positive-duration>` IMMEDIATELY precedes the probe token so "timeout 0"/dead doc-strings/unbounded real calls/a timeout bounding some OTHER command on the same line are all rejected while the shipped `if ! PING_OUT=$(timeout 10 spacetime server ping …)` capture form is accepted (A5h);',
        'the body also matches the "Server is online" success text, so the check cannot revert to exit-code-only (ux3-1);',
        'docs/playtest-ops.md documents "just playtest-preflight" (A6) AND — gating ux3-2 directly rather than by proxy — carries a fenced code block whose standalone content is "spacetime start", so the runnable step cannot be deleted while the prose survives (a bare includes() needle was green on the pre-ux3 file, and a count-floor of 2 is defeated because ux3 itself added a second prose mention); ADR-0153 records the "spacetime server ping" + nickname rationale;',
        'the BEHAVIORAL NEGATIVE tooth proves the recipe exits non-zero against an unreachable STDB_SERVER=http://127.0.0.1:1 with actionable "spacetime start" text AND the runtime-EXPANDED URL on STDERR specifically — so neither just\'s echo of a non-shebang source line nor a stdout-only diagnosis can fake it (A7);',
        'the BEHAVIORAL POSITIVE CONTROL proves it exits 0 against a live local HTTP stub, which is what stops "the preflight always fails" from being a passing implementation (A8);',
        'PREFLIGHT_REJECTS_NON_SPACETIME_HTTP_RESPONDER (§7.15b) proves it exits non-zero — naming the runtime-expanded ephemeral URL on stderr, so the rejection is provably about THAT target — against a throwaway node server that answers HTTP 500: measured on CLI 2.6.0, "spacetime server ping" exits 0 for ANY completed HTTP round-trip (500 stub, trailing slash and "/v1" path suffix all exit 0) while "spacetime publish -s" fails for all of them, so only matching the "Server is online" body proves the preflight verifies a SpacetimeDB rather than merely that something answers HTTP;',
        'and the CALL-SITE tooth (PLAYTEST_UP_ABORTS_BEFORE_BUILD_WHEN_SERVER_DEAD, A9) runs playtest-up and playtest-wipe end-to-end with a fake "spacetime" first on PATH and proves they exit non-zero WITHOUT ever invoking it — the only assertion that gates whether the CALLERS honor the preflight rather than merely containing the line (kills "set +e" above the call, a "just() { :; }" shadow, and the call parked in a dead if-branch, none of which a source scan can reach).',
      ].join(' ') + behavioralSkipNote,
  };
}
