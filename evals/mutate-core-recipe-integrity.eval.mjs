// mutate-core recipe + .cargo/mutants.toml integrity eval (fix-nightly / ADR-0088).
//
// Guards two files whose contents change mutation semantics for every nightly run:
//   1. the justfile `mutate-core:` recipe (AC-M5): -p game-core scope, missed.txt
//      count-compare, fail-closed `[ ! -f` guard, no scope-narrowing flags, no
//      shell-neuter, and a HARD ZERO — the header must carry NO parameters (a
//      `cap=` in the header is asymmetric vs mutate-server: game-core is
//      zero-tolerance, so no cap knob is allowed to leak in).
//   2. `.cargo/mutants.toml` (AC-M8): EXACTLY ONE exclude_re entry — the
//      line-pinned, provably-equivalent `npc/rules.rs:61:15 replace > with >=`
//      mutant — and nothing that shapes scope beyond that single blessed
//      exclusion (no examine_re/exclude_globs/examine_globs).
//
// EXPECTED REAL-TREE STATE AT RED (fix-nightly branch tip):
//   mutateCoreRecipeIntact(justfile)  → FALSE (bare `cargo mutants -p game-core`
//                                       recipe: no missed.txt, no [ ! -f guard)
//   .cargo/mutants.toml               → ABSENT → pass:false with EXPECTED-RED detail
// The eval is therefore RED right now; the T6 specialist turns it green by
// installing the canonical wrapper + canonical mutants.toml (both copied
// verbatim below as positive-control fixtures).
//
// Proof-of-teeth: every predicate is exercised against a known-bad fixture that
// MUST be rejected BEFORE the real files are read; a tooth that fails to bite
// fails the eval itself. Positive controls (the canonical wrapper + canonical
// toml, verbatim from plan §T6) must PASS every predicate.
//
// IMPORTANT: NO new RegExp(...) — only literal regex literals or String methods
// (detect-non-literal-regexp Semgrep rule has bitten this project 3×). This file
// uses ONLY indexOf / startsWith / split line-scans, no regex at all.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Helper: extract the body lines of a column-0 recipe named `recipeName`.
// A recipe header is a line starting with `recipeName:` or `recipeName ` at
// column 0; the body is the run of following indented (space/tab) non-comment
// lines. Returns { headerLine, bodyLines } or null when the header is absent.
// ---------------------------------------------------------------------------
function extractRecipe(justfileText, recipeName) {
  const lines = justfileText.split('\n');
  let headerLine = null;
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${recipeName}:`) || lines[i].startsWith(`${recipeName} `)) {
      headerLine = lines[i];
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;
  const bodyLines = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    if (line[0] === ' ' || line[0] === '\t') {
      const tr = line.trimStart();
      if (!tr.startsWith('#')) bodyLines.push(tr);
    } else {
      break;
    }
  }
  return { headerLine, bodyLines };
}

// ---------------------------------------------------------------------------
// Pure predicate: the justfile `mutate-core` recipe is intact (AC-M5).
//
//   HEADER: `mutate-core` at column 0 with NO parameters. A `cap=` or ANY
//     parameter token in the header → false (HARD ZERO asymmetry vs
//     mutate-server, which legitimately carries a cap= ratchet knob).
//   BODY must CONTAIN: `-p game-core`, `missed.txt`, a `[ ! -f` fail-closed
//     existence guard, and a `-gt 0` count-compare.
//   BODY must NOT CONTAIN: `--shard`, `--file`, `--exclude-re`, `--exclude`,
//     ` -o `, `--output` (scope-narrowing / output-redirect bypasses), nor the
//     shell-neuter forms `mutants || true`, `exit 0`, or `&& true`.
//
// The canonical wrapper legitimately contains `|| status=$?` and
// `grep -c '' ... || true`, so we ban ONLY the precise neuter substrings that
// disable the gate — never a blanket `|| true` scan (which would false-hit the
// canonical body).
// ---------------------------------------------------------------------------
export function mutateCoreRecipeIntact(justfileText) {
  const recipe = extractRecipe(justfileText, 'mutate-core');
  if (recipe === null) return false;

  // HARD ZERO: header must be exactly `mutate-core:` — no parameters at all.
  // Strip the trailing `:` and assert nothing remains after `mutate-core`.
  const header = recipe.headerLine.trim();
  if (header !== 'mutate-core:') return false;

  const body = recipe.bodyLines.join('\n');
  if (body.length === 0) return false;

  // Required tokens.
  if (body.indexOf('-p game-core') === -1) return false;
  if (body.indexOf('missed.txt') === -1) return false;
  if (body.indexOf('[ ! -f') === -1) return false;
  if (body.indexOf('-gt 0') === -1) return false;

  // Banned scope-narrowing / output-redirect flags.
  if (body.indexOf('--shard') !== -1) return false;
  if (body.indexOf('--file') !== -1) return false;
  if (body.indexOf('--exclude-re') !== -1) return false;
  if (body.indexOf('--exclude') !== -1) return false;
  if (body.indexOf(' -o ') !== -1) return false;
  if (body.indexOf('--output') !== -1) return false;

  // Banned shell-neuter forms (precise — do NOT ban the canonical
  // `|| status=$?` or `grep -c '' ... || true`).
  if (body.indexOf('cargo mutants -p game-core || true') !== -1) return false;
  if (body.indexOf('exit 0') !== -1) return false;
  if (body.indexOf('&& true') !== -1) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Pure predicate: `.cargo/mutants.toml` is pinned to exactly the one blessed
// exclusion (AC-M8). Returns { ok: boolean, reason: string }.
//
//   null/absent input → { ok:false } (handled gracefully — never throws).
//   EXACTLY ONE exclude_re entry (one quoted string inside the array).
//   That entry must contain BOTH the line-pin `npc/rules\.rs:61:15` AND
//     `toward_home`.
//   MORE than one entry → false.
//   An entry lacking the `:61:15` line-pin → false.
//   ANY `examine_re` / `exclude_globs` / `examine_globs` key present → false
//     (scope-shaping beyond the blessed exclusion is banned).
// ---------------------------------------------------------------------------
export function mutantsTomlPinned(tomlText) {
  if (tomlText === null || tomlText === undefined) {
    return { ok: false, reason: '.cargo/mutants.toml is absent' };
  }

  // Ban any scope-shaping key other than exclude_re.
  if (tomlText.indexOf('examine_re') !== -1) {
    return {
      ok: false,
      reason: 'mutants.toml contains examine_re (scope-shaping beyond the blessed exclusion)',
    };
  }
  if (tomlText.indexOf('exclude_globs') !== -1) {
    return {
      ok: false,
      reason: 'mutants.toml contains exclude_globs (scope-shaping beyond the blessed exclusion)',
    };
  }
  if (tomlText.indexOf('examine_globs') !== -1) {
    return {
      ok: false,
      reason: 'mutants.toml contains examine_globs (scope-shaping beyond the blessed exclusion)',
    };
  }

  // Locate the exclude_re array assignment.
  const keyIdx = tomlText.indexOf('exclude_re');
  if (keyIdx === -1) {
    return { ok: false, reason: 'mutants.toml has no exclude_re entry' };
  }
  const openIdx = tomlText.indexOf('[', keyIdx);
  const closeIdx = tomlText.indexOf(']', openIdx);
  if (openIdx === -1 || closeIdx === -1) {
    return { ok: false, reason: 'mutants.toml exclude_re is not a bracketed array' };
  }
  const arrayBody = tomlText.slice(openIdx + 1, closeIdx);

  // Count quoted string entries inside the array (each entry is one `"..."`).
  // Count opening quotes: a well-formed array has an even number of `"`; one
  // entry = 2 quotes. More than 2 → more than one entry → reject.
  let quoteCount = 0;
  for (const ch of arrayBody) {
    if (ch === '"') quoteCount += 1;
  }
  if (quoteCount === 0) {
    return { ok: false, reason: 'mutants.toml exclude_re array is empty (no quoted entry)' };
  }
  if (quoteCount !== 2) {
    return {
      ok: false,
      reason: `mutants.toml exclude_re must have EXACTLY ONE entry (found ${quoteCount / 2} entries / ${quoteCount} quotes) — the list is line-pinned to the single blessed exclusion`,
    };
  }

  // The single entry must contain BOTH the line-pin and the fn name.
  // The line-pin appears in the TOML as `npc/rules\\.rs:61:15` (the `\\` is a
  // regex `\.` escape). We match on the two backslash-independent fragments —
  // `npc/rules` (path head) and `.rs:61:15` (the file+line pin) — so the check
  // is robust to whether the TOML author wrote one or two backslashes.
  if (arrayBody.indexOf('npc/rules') === -1 || arrayBody.indexOf('.rs:61:15') === -1) {
    return {
      ok: false,
      reason:
        'mutants.toml exclude_re entry is missing the npc/rules...:61:15 line-pin (a bare `toward_home` exclusion is too broad and would silence the non-equivalent 53:15 / 61:15-sibling mutants)',
    };
  }
  if (arrayBody.indexOf('toward_home') === -1) {
    return {
      ok: false,
      reason: 'mutants.toml exclude_re entry does not mention toward_home',
    };
  }

  return {
    ok: true,
    reason: 'mutants.toml pins exactly the one blessed 61:15 toward_home exclusion',
  };
}

// ---------------------------------------------------------------------------
// Canonical positive-control fixtures — copied VERBATIM from plan §T6.
// The installed recipe + toml (T6) and these fixtures must be byte-shape
// identical; if the T6 specialist changes the wrapper, these controls document
// the contract the change must still satisfy.
// ---------------------------------------------------------------------------
const CANONICAL_MUTATE_CORE = `mutate-core:
    #!/usr/bin/env bash
    set -euo pipefail
    status=0
    cargo mutants -p game-core || status=$?
    # 0 = clean; 2 = missed mutants; 3 = timeouts (may accompany missed).
    # Anything else (1 usage, 4 baseline-test failure, ...) = fail loud.
    if [ "$status" -ne 0 ] && [ "$status" -ne 2 ] && [ "$status" -ne 3 ]; then
        echo "cargo mutants failed with exit $status (not a mutation verdict)" >&2
        exit "$status"
    fi
    # Fail closed if the outcome file is absent (grep '' || true would
    # otherwise yield missed="" and the -gt test degrades to false → vacuous
    # green; V4).
    if [ ! -f mutants.out/missed.txt ]; then
        echo "mutants.out/missed.txt absent — cannot verify zero-missed" >&2
        exit 1
    fi
    missed=$(grep -c '' mutants.out/missed.txt || true)
    echo "mutate-core: missed=$missed (zero-tolerance ADR-0050; timeouts tolerated iff missed=0, ADR-0088)"
    if [ "$missed" -gt 0 ]; then
        echo "game-core mutation gate: $missed surviving mutant(s) — zero-tolerance (ADR-0050)" >&2
        exit 1
    fi
`;

const CANONICAL_MUTANTS_TOML = `# Single blessed exclusion: provably-equivalent mutant (ADR-0088 §Decision 2).
# The Y-branch of toward_home requires |dx| < |dy| → dy != 0, so \`dy > 0\` and
# \`dy >= 0\` are indistinguishable on the reachable domain. Line-pinned
# (npc/rules.rs:61:15): drift resurfaces the mutant → nightly red → re-pin
# consciously. Guarded by evals/mutate-core-recipe-integrity.eval.mjs.
exclude_re = ["npc/rules\\\\.rs:61:15: replace > with >= in toward_home"]
`;

// ---------------------------------------------------------------------------
// Default export: proof-of-teeth, then real file checks.
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'mutate-core-recipe-integrity (fix-nightly / ADR-0088: mutate-core wrapper + .cargo/mutants.toml pinned to the single blessed exclusion)';

  // =========================================================================
  // PROOF-OF-TEETH — known-bad fixtures first, then positive controls.
  // =========================================================================

  // TEETH 1 — recipe absent → must be rejected.
  const justfileNoCore = 'ci: lint test\n\nlint:\n    cargo fmt --all --check\n';
  if (mutateCoreRecipeIntact(justfileNoCore)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH 1: mutateCoreRecipeIntact accepted a justfile with no mutate-core recipe (false positive)',
    };
  }

  // TEETH 2 — recipe with `--file` scope-narrowing → must be rejected.
  const justfileFile =
    'mutate-core:\n    cargo mutants -p game-core --file src/bin/tiled_import.rs 2>&1 | tee mutants.out/missed.txt\n    [ ! -f mutants.out/missed.txt ] && exit 1\n    [ "$(grep -c \'\' mutants.out/missed.txt)" -gt 0 ] && exit 1\n';
  if (mutateCoreRecipeIntact(justfileFile)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH 2 (--file): mutateCoreRecipeIntact accepted a mutate-core recipe with `--file src/bin/tiled_import.rs` — scope-narrowing to one file means most mutants are never tested (only 522/523 would run); the recipe must mutate the WHOLE game-core crate',
    };
  }

  // TEETH 3 — recipe with `--exclude` → must be rejected.
  const justfileExclude =
    'mutate-core:\n    cargo mutants -p game-core --exclude tiled_import.rs 2>&1 | tee mutants.out/missed.txt\n    [ ! -f mutants.out/missed.txt ] && exit 1\n    [ "$(grep -c \'\' mutants.out/missed.txt)" -gt 0 ] && exit 1\n';
  if (mutateCoreRecipeIntact(justfileExclude)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH 3 (--exclude): mutateCoreRecipeIntact accepted a mutate-core recipe with `--exclude` — excluding a file drops its mutants silently; scope-narrowing bypass must be rejected',
    };
  }

  // TEETH 4 — header carries a `cap=` parameter → must be rejected (HARD ZERO).
  const justfileCap =
    'mutate-core cap="4":\n    cargo mutants -p game-core 2>&1 | tee mutants.out/missed.txt\n    [ ! -f mutants.out/missed.txt ] && exit 1\n    [ "$(grep -c \'\' mutants.out/missed.txt)" -gt 0 ] && exit 1\n';
  if (mutateCoreRecipeIntact(justfileCap)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH 4 (cap=): mutateCoreRecipeIntact accepted `mutate-core cap="4":` — game-core is HARD-ZERO tolerance (ADR-0050); a cap= knob in the header would let a tolerance leak in. The header must carry NO parameters (asymmetric vs mutate-server which is a survivor-count ratchet)',
    };
  }

  // TEETH 5 — body neuters the cargo mutants line with `|| true` → must be rejected.
  const justfileNeuter =
    'mutate-core:\n    cargo mutants -p game-core || true\n    [ ! -f mutants.out/missed.txt ] && exit 1\n    [ "$(grep -c \'\' mutants.out/missed.txt)" -gt 0 ] && exit 1\n';
  if (mutateCoreRecipeIntact(justfileNeuter)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH 5 (|| true neuter): mutateCoreRecipeIntact accepted `cargo mutants -p game-core || true` — swallowing the exit code neuters the gate. Note the canonical body legitimately uses `|| status=$?`; only the precise neuter form is banned',
    };
  }

  // TEETH 6 — body missing `missed.txt` count-compare → must be rejected.
  const justfileNoMissed =
    'mutate-core:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    cargo mutants -p game-core\n';
  if (mutateCoreRecipeIntact(justfileNoMissed)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH 6 (no missed.txt): mutateCoreRecipeIntact accepted a recipe with no missed.txt count-compare — without the explicit count check the recipe relies on cargo-mutants exit codes alone and cannot fail-closed on an absent outcome file (V4 vacuous-green class)',
    };
  }

  // TEETH 7 — body missing the `[ ! -f` fail-closed guard → must be rejected.
  const justfileNoGuard =
    'mutate-core:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    cargo mutants -p game-core || true\n    missed=$(grep -c \'\' mutants.out/missed.txt || true)\n    [ "$missed" -gt 0 ] && exit 1\n';
  if (mutateCoreRecipeIntact(justfileNoGuard)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH 7 (no [ ! -f guard): mutateCoreRecipeIntact accepted a recipe without the `[ ! -f mutants.out/missed.txt ]` fail-closed guard — if the outcome file is absent, `grep -c \'\' || true` yields missed="" and `[ "" -gt 0 ]` errors into a falsy if → vacuous green (V4). Also this fixture carries the `|| true` neuter',
    };
  }

  // TEETH 8 — mutants.toml with TWO exclude_re entries → must be rejected.
  const tomlTwoEntries =
    'exclude_re = ["npc/rules\\\\.rs:61:15: replace > with >= in toward_home", "npc/rules\\\\.rs:53:15: replace > with >= in toward_home"]\n';
  {
    const r = mutantsTomlPinned(tomlTwoEntries);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 8 (two entries): mutantsTomlPinned accepted a mutants.toml with TWO exclude_re entries — the exclusion list is pinned to EXACTLY ONE blessed entry; unbounded growth would silence real surviving mutants (53:15 is NOT equivalent and must get a killing test, not exclusion)',
      };
    }
  }

  // TEETH 9 — mutants.toml entry `toward_home` WITHOUT the `:61:15` line-pin → reject.
  const tomlNoLinePin = 'exclude_re = ["replace > with >= in toward_home"]\n';
  {
    const r = mutantsTomlPinned(tomlNoLinePin);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 9 (no line-pin): mutantsTomlPinned accepted a bare `toward_home` exclusion with no `:61:15` line-pin — an unpinned pattern would ALSO silence the non-equivalent 53:15 and 61:15 `> → ==` / `> → <` siblings, hiding real survivors. The exclusion must be line-pinned',
      };
    }
  }

  // TEETH 10 — mutants.toml with an extra `examine_re` key → reject.
  const tomlExamineRe =
    'examine_re = ["parse_number"]\nexclude_re = ["npc/rules\\\\.rs:61:15: replace > with >= in toward_home"]\n';
  {
    const r = mutantsTomlPinned(tomlExamineRe);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 10 (examine_re): mutantsTomlPinned accepted a mutants.toml with an examine_re key — examine_re narrows which mutants run AT ALL, changing scope for every nightly. Only the single blessed exclude_re exclusion is permitted; any other scope-shaping key must be rejected',
      };
    }
  }

  // TEETH 11 — null / absent toml → graceful { ok:false }, never a throw.
  {
    const r = mutantsTomlPinned(null);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 11 (absent toml): mutantsTomlPinned returned ok for a null input — an absent .cargo/mutants.toml must yield { ok:false } gracefully (no throw, no false-pass)',
      };
    }
    if (typeof r.reason !== 'string' || r.reason.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 11 (absent toml): mutantsTomlPinned(null) must return a non-empty reason string alongside ok:false',
      };
    }
  }

  // POSITIVE CONTROL A — the canonical wrapper (verbatim, plan §T6) must PASS.
  if (!mutateCoreRecipeIntact(CANONICAL_MUTATE_CORE)) {
    return {
      name,
      pass: false,
      detail:
        'POSITIVE CONTROL A: mutateCoreRecipeIntact REJECTED the canonical mutate-core wrapper (plan §T6) — the predicate is too strict and would fail the T6 specialist even with the blessed recipe installed',
    };
  }

  // POSITIVE CONTROL B — the canonical mutants.toml (verbatim, plan §T6) must PASS.
  {
    const r = mutantsTomlPinned(CANONICAL_MUTANTS_TOML);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `POSITIVE CONTROL B: mutantsTomlPinned REJECTED the canonical .cargo/mutants.toml (plan §T6): ${r.reason} — the predicate is too strict and would fail the T6 specialist even with the blessed toml installed`,
      };
    }
  }

  // =========================================================================
  // REAL FILE CHECKS (EXPECTED RED on the fix-nightly branch tip)
  // =========================================================================
  const root = path.resolve('.');
  const justfilePath = path.join(root, 'justfile');
  const tomlPath = path.join(root, '.cargo/mutants.toml');

  let justfile;
  try {
    justfile = readFileSync(justfilePath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read justfile' };
  }

  // Real check 1: mutate-core recipe intact.
  // EXPECTED RED: the current recipe is a bare `cargo mutants -p game-core`
  // (no missed.txt, no [ ! -f guard) — GREEN edit: install the canonical wrapper.
  if (!mutateCoreRecipeIntact(justfile)) {
    return {
      name,
      pass: false,
      detail:
        'justfile mutate-core recipe is bare or incomplete (EXPECTED RED — T6 specialist must install the canonical wrapper: -p game-core, `[ ! -f mutants.out/missed.txt ]` fail-closed guard, missed.txt `-gt 0` count-compare, no cap= header, no scope-narrowing flags)',
    };
  }

  // Real check 2: .cargo/mutants.toml pinned to the one blessed exclusion.
  // EXPECTED RED: the file is absent on the branch tip.
  if (!existsSync(tomlPath)) {
    return {
      name,
      pass: false,
      detail:
        '.cargo/mutants.toml is absent (EXPECTED RED — T6 specialist must add it with exactly the one line-pinned `npc/rules.rs:61:15 replace > with >= in toward_home` exclusion per ADR-0088)',
    };
  }
  const tomlText = readFileSync(tomlPath, 'utf8');
  {
    const r = mutantsTomlPinned(tomlText);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `.cargo/mutants.toml is not correctly pinned: ${r.reason}`,
      };
    }
  }

  return {
    name,
    pass: true,
    detail:
      'mutate-core recipe intact (whole-crate -p game-core, fail-closed missed.txt count-compare, no scope-narrowing / neuter / cap= knob) and .cargo/mutants.toml pins exactly the one blessed 61:15 toward_home equivalent-mutant exclusion (ADR-0088)',
  };
}
