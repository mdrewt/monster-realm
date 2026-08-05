// mutate-core recipe + .cargo/mutants.toml integrity eval (fix-nightly / ADR-0088 + M14.5h).
//
// Guards two files whose contents change mutation semantics for every nightly run:
//   1. the justfile `mutate-core:` recipe (AC-M5): -p game-core scope, missed.txt
//      count-compare, fail-closed `[ ! -f` guard, no scope-narrowing flags, no
//      shell-neuter, and a HARD ZERO — the header must carry NO parameters (a
//      `cap=` in the header is asymmetric vs mutate-server: game-core is
//      zero-tolerance, so no cap knob is allowed to leak in).
//   2. `.cargo/mutants.toml` (AC-M8): EXACTLY FOUR exclude_re entries — all
//      line-pinned, provably-equivalent mutants:
//        • `npc/rules.rs:61:15 replace > with >=` in toward_home (ADR-0088)
//        • `ability.rs:170:60 replace < with <=` in apply_entry_ability (M14.5h)
//        • `trading/types.rs:56:9 TradeStatus::is_active -> true` (fix-nightly-mutants)
//        • `content.rs:624:5 load_evolution_paths -> Ok(vec![])` (EG1)
//      Nothing that shapes scope beyond those four blessed exclusions
//      (no examine_re/exclude_globs/examine_globs).
//
// SELF-EXPIRY (EG1, entry 4 only): entries 1-3 are equivalent by construction,
// permanently. Entry 4 is equivalent only CONTINGENTLY — the evolution-path
// registry (content/evolution_paths/*.ron) is deliberately `[]` until slice EG3
// authors the real graph, and content.rs:624 will NOT move when EG3 adds data,
// so a naive line-pin would suppress a real killable mutant forever. This eval
// therefore enforces, WHENEVER entry 4 is present: (i) the canary test
// `eg1_load_evolution_paths_is_empty_pending_eg3` still exists in
// game-core/src/content.rs, and (ii) every evolution-path RON part is STILL
// semantically empty. The instant EG3 authors one edge, this eval goes red and
// the exclusion must be deleted.
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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// A literal double-quote, built from its char code so the character never
// appears bare inside the scanned/scanning string literals below.
const DQ = String.fromCharCode(0x22);

// The EG1 canary test that pairs with the fourth blessed exclusion.
const CANARY_FN = 'eg1_load_evolution_paths_is_empty_pending_eg3';

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
//     shell-neuter forms `mutants || true`, `exit 0`, `return 0`, or `&& true`.
//
// The canonical wrapper legitimately contains `|| status=$?`, so we ban ONLY
// the precise neuter substrings that disable the gate.
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

  // Banned shell-neuter forms (precise — do NOT ban the canonical `|| status=$?`).
  if (body.indexOf('cargo mutants -p game-core || true') !== -1) return false;
  if (body.indexOf('exit 0') !== -1) return false;
  if (body.indexOf('&& true') !== -1) return false;
  if (body.indexOf('return 0') !== -1) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Pure predicate: `.cargo/mutants.toml` is pinned to exactly the four blessed
// exclusions (AC-M8, ADR-0088 + M14.5h + fix-nightly-mutants + EG1).
// Returns { ok: boolean, reason: string }.
//
//   null/absent input → { ok:false } (handled gracefully — never throws).
//   EXACTLY FOUR exclude_re entries (four quoted strings inside the array = 8 quotes).
//     Entry 1: `npc/rules.rs:61:15 replace > with >= in toward_home`
//     Entry 2: `ability.rs:170:60 replace < with <= in apply_entry_ability`
//     Entry 3: `trading/types.rs:56:9 replace TradeStatus::is_active -> bool with true`
//     Entry 4: `content.rs:624:5 replace load_evolution_paths -> ... with Ok(vec![])`
//   Fewer or more than four entries → false.
//   An entry lacking its line-pin → false.
//   ANY `examine_re` / `exclude_globs` / `examine_globs` key present → false
//     (scope-shaping beyond the blessed exclusions is banned).
//
// Entry 4 alone is CONTINGENTLY equivalent; its self-expiry tripwires live in
// canaryTestPresent() + evolutionPathsRegistryEmpty() below, not here.
// ---------------------------------------------------------------------------
export function mutantsTomlPinned(tomlText) {
  if (tomlText === null || tomlText === undefined) {
    return { ok: false, reason: '.cargo/mutants.toml is absent' };
  }

  // Ban any scope-shaping key other than exclude_re.
  if (tomlText.indexOf('examine_re') !== -1) {
    return {
      ok: false,
      reason: 'mutants.toml contains examine_re (scope-shaping beyond the blessed exclusions)',
    };
  }
  if (tomlText.indexOf('exclude_globs') !== -1) {
    return {
      ok: false,
      reason: 'mutants.toml contains exclude_globs (scope-shaping beyond the blessed exclusions)',
    };
  }
  if (tomlText.indexOf('examine_globs') !== -1) {
    return {
      ok: false,
      reason: 'mutants.toml contains examine_globs (scope-shaping beyond the blessed exclusions)',
    };
  }

  // Locate the exclude_re array assignment.
  const keyIdx = tomlText.indexOf('exclude_re');
  if (keyIdx === -1) {
    return { ok: false, reason: 'mutants.toml has no exclude_re entry' };
  }
  const openIdx = tomlText.indexOf('[', keyIdx);
  if (openIdx === -1) {
    return { ok: false, reason: 'mutants.toml exclude_re is not a bracketed array' };
  }
  // Find the array-closing bracket with a QUOTE-AWARE scan. Entry 4 legitimately
  // contains literal bracket characters (the escaped empty-vector token in
  // `Ok(vec![])`), so a naive first-`]` search would truncate the body mid-entry
  // and mis-count the quotes. No blessed entry contains an escaped quote, so a
  // plain in-string toggle is sufficient.
  let closeIdx = -1;
  let inString = false;
  for (let i = openIdx + 1; i < tomlText.length; i++) {
    const ch = tomlText[i];
    if (ch === DQ) {
      inString = !inString;
      continue;
    }
    if (!inString && ch === ']') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { ok: false, reason: 'mutants.toml exclude_re is not a bracketed array' };
  }
  const arrayBody = tomlText.slice(openIdx + 1, closeIdx);

  // Backslash-insensitive view: the entries are cargo-mutants REGEXES, so the
  // same pin may be authored with one or two backslashes. Fragment checks that
  // straddle an escape compare against this copy.
  const arrayBodyBare = arrayBody.split('\\').join('');

  // Count quoted string entries inside the array (each entry is one quoted
  // string). A well-formed array has an even number of quotes; four entries =
  // 8 quotes (we bless exactly four: toward_home + apply_entry_ability +
  // is_active + load_evolution_paths).
  let quoteCount = 0;
  for (const ch of arrayBody) {
    if (ch === DQ) quoteCount += 1;
  }
  if (quoteCount === 0) {
    return { ok: false, reason: 'mutants.toml exclude_re array is empty (no quoted entry)' };
  }
  if (quoteCount === 2) {
    return {
      ok: false,
      reason:
        'mutants.toml exclude_re has only ONE entry — all four blessed exclusions are required: toward_home (npc/rules.rs:61:15), apply_entry_ability (ability.rs:170:60), is_active (trading/types.rs:56:9), and load_evolution_paths (content.rs:624:5)',
    };
  }
  if (quoteCount === 4) {
    return {
      ok: false,
      reason:
        'mutants.toml exclude_re has only TWO entries — the third (trading/types.rs:56:9 is_active, fix-nightly-mutants) and fourth (content.rs:624:5 load_evolution_paths, EG1) blessed exclusions are missing; EXACTLY FOUR entries are required',
    };
  }
  if (quoteCount === 6) {
    return {
      ok: false,
      reason:
        'mutants.toml exclude_re has only THREE entries — the fourth blessed exclusion (content.rs:624:5 load_evolution_paths -> Ok(vec![]) equivalent mutant, EG1) is missing; EXACTLY FOUR entries are required',
    };
  }
  if (quoteCount !== 8) {
    return {
      ok: false,
      reason: `mutants.toml exclude_re must have EXACTLY FOUR entries (found ${quoteCount / 2} entries / ${quoteCount} quotes) — the list is pinned to exactly four blessed exclusions (toward_home + apply_entry_ability + is_active + load_evolution_paths)`,
    };
  }

  // Entry 1: toward_home must be present with its full line-pin.
  // We match on two backslash-independent fragments — `npc/rules` and `.rs:61:15` —
  // so the check is robust to whether the TOML author wrote one or two backslashes.
  if (arrayBody.indexOf('npc/rules') === -1 || arrayBody.indexOf('.rs:61:15') === -1) {
    return {
      ok: false,
      reason:
        'mutants.toml is missing the npc/rules...:61:15 toward_home line-pin (first blessed exclusion, ADR-0088)',
    };
  }
  if (arrayBody.indexOf('toward_home') === -1) {
    return {
      ok: false,
      reason: 'mutants.toml exclude_re entry does not mention toward_home',
    };
  }
  if (arrayBody.indexOf('replace > with >=') === -1) {
    return {
      ok: false,
      reason:
        'mutants.toml toward_home entry is missing the operator text "replace > with >=" — the full canonical exclusion must name the exact operator replacement to prevent silencing non-equivalent sibling mutants at the same line (e.g. > → < is not equivalent and tests WOULD catch it)',
    };
  }

  // Entry 2: apply_entry_ability must be present with its full line-pin (M14.5h).
  // Re-pinned from 169:60 to 170:60 (fix-nightly-mutants: one line inserted above
  // the EntryHeal guard between M14.5h and nightly run 29320384291).
  if (arrayBody.indexOf('ability') === -1 || arrayBody.indexOf('.rs:170:60') === -1) {
    return {
      ok: false,
      reason:
        'mutants.toml is missing the ability.rs:170:60 apply_entry_ability line-pin (second blessed exclusion, M14.5h re-pinned — EntryHeal < vs <= equivalent mutant; was 169:60 before fix-nightly-mutants)',
    };
  }
  if (arrayBody.indexOf('apply_entry_ability') === -1) {
    return {
      ok: false,
      reason: 'mutants.toml second exclude_re entry does not mention apply_entry_ability',
    };
  }
  if (arrayBody.indexOf('replace < with <=') === -1) {
    return {
      ok: false,
      reason:
        'mutants.toml apply_entry_ability entry is missing the operator text "replace < with <=" — the full canonical exclusion must name the exact operator replacement',
    };
  }

  // Entry 3: is_active must be present with its full line-pin (fix-nightly-mutants).
  // TradeStatus::is_active always returns true (terminal state = deleted row, not an
  // enum variant). The ->true mutation is equivalent; ->false IS caught by tests.
  if (arrayBody.indexOf('trading/types') === -1 || arrayBody.indexOf('.rs:56:9') === -1) {
    return {
      ok: false,
      reason:
        'mutants.toml is missing the trading/types.rs:56:9 is_active line-pin (third blessed exclusion, fix-nightly-mutants — TradeStatus::is_active ->true equivalent mutant)',
    };
  }
  if (arrayBody.indexOf('is_active') === -1) {
    return {
      ok: false,
      reason: 'mutants.toml third exclude_re entry does not mention is_active',
    };
  }
  if (arrayBody.indexOf('with true') === -1) {
    return {
      ok: false,
      reason:
        'mutants.toml is_active entry is missing the text "with true" — must name the exact mutation to prevent silencing the non-equivalent ->false sibling (which is caught by trade_status_is_active_covers_both_variants)',
    };
  }

  // Entry 4: load_evolution_paths must be present with its full line-pin (EG1).
  // CONTINGENTLY equivalent — see canaryTestPresent / evolutionPathsRegistryEmpty.
  if (arrayBody.indexOf('content') === -1 || arrayBody.indexOf('.rs:624:5') === -1) {
    return {
      ok: false,
      reason:
        'mutants.toml is missing the content.rs:624:5 load_evolution_paths line-pin (fourth blessed exclusion, EG1 — the registry is deliberately empty until slice EG3, so the whole-body replacement is equivalent TODAY)',
    };
  }
  if (arrayBody.indexOf('load_evolution_paths') === -1) {
    return {
      ok: false,
      reason: 'mutants.toml fourth exclude_re entry does not mention load_evolution_paths',
    };
  }
  if (arrayBodyBare.indexOf('with Ok(vec![])') === -1) {
    return {
      ok: false,
      reason:
        'mutants.toml load_evolution_paths entry is missing the text "with Ok(vec![])" — must name the EXACT mutation to prevent silencing the non-equivalent siblings at the same line (`with Err(...)` and `with Ok(vec![Default::default()])` are both killed by eg1_load_evolution_paths_is_empty_pending_eg3)',
    };
  }

  return {
    ok: true,
    reason:
      'mutants.toml pins exactly the four blessed exclusions: 61:15 toward_home (ADR-0088), 170:60 apply_entry_ability (M14.5h re-pinned), 56:9 is_active (fix-nightly-mutants), and 624:5 load_evolution_paths (EG1, self-expiring)',
  };
}

// ---------------------------------------------------------------------------
// SELF-EXPIRY TRIPWIRE 1 (EG1) — pure predicate: the canary test that pairs with
// the fourth blessed exclusion still exists in game-core/src/content.rs.
// Returns { ok: boolean, reason: string }.
//
// The exclusion at content.rs:624:5 is equivalent only while the evolution-path
// registry is empty. `eg1_load_evolution_paths_is_empty_pending_eg3` is the test
// that goes red when that stops being true, so deleting the canary while keeping
// the exclusion would strand the pin with no expiry mechanism at all.
//
// We require the actual `fn <canary>` DECLARATION, not a mere mention: the name
// also appears in prose (this file, the toml comment block), and a doc-comment
// reference must not be able to satisfy the tripwire.
// ---------------------------------------------------------------------------
export function canaryTestPresent(contentRsText) {
  if (typeof contentRsText !== 'string' || contentRsText.length === 0) {
    return { ok: false, reason: 'game-core/src/content.rs is absent or empty' };
  }
  if (contentRsText.indexOf(`fn ${CANARY_FN}`) === -1) {
    return {
      ok: false,
      reason: `game-core/src/content.rs has no \`fn ${CANARY_FN}\` declaration — the fourth blessed exclusion (content.rs:624:5 load_evolution_paths) is CONTINGENT on the empty registry and MUST keep its canary; without it the pin would silence a real killable mutant forever once slice EG3 lands`,
    };
  }
  return { ok: true, reason: `content.rs declares the canary test ${CANARY_FN}` };
}

// ---------------------------------------------------------------------------
// SELF-EXPIRY TRIPWIRE 2 (EG1) — pure predicate: every evolution-path RON part
// is STILL semantically empty. Input is an array of { file, text } parts (the
// caller reads content/evolution_paths/*.ron); returns { ok, reason }.
//
// Each part is reduced by stripping `//` line comments and trimming every line,
// then concatenating; the remainder must be exactly `[]`. 000-core.ron is a
// heavily commented `[]` today, which reduces cleanly. The instant slice EG3
// authors ONE edge, this predicate fails → the eval goes red → the fourth
// blessed exclusion must be deleted, at which point an ordinary non-emptiness
// test kills the content.rs:624:5 mutant for real.
//
// Zero parts is a FAILURE, not a vacuous pass: an empty (or mis-globbed)
// directory would otherwise satisfy the tripwire without proving anything.
// ---------------------------------------------------------------------------
export function evolutionPathsRegistryEmpty(parts) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return {
      ok: false,
      reason:
        'no content/evolution_paths/*.ron parts were found — build.rs globs that directory into EVOLUTION_PATHS_RON_PARTS, so an empty glob means a broken checkout or a moved registry, not an empty registry (vacuous-green class)',
    };
  }
  for (const part of parts) {
    const reduced = part.text
      .split('\n')
      .map((line) => {
        const c = line.indexOf('//');
        return (c === -1 ? line : line.slice(0, c)).trim();
      })
      .join('');
    if (reduced !== '[]') {
      return {
        ok: false,
        reason: `content/evolution_paths/${part.file} is no longer semantically empty (reduces to \`${reduced.slice(0, 80)}\`, expected \`[]\`) — slice EG3 has authored evolution-path content, so the fourth blessed exclusion (content.rs:624:5 load_evolution_paths -> Ok(vec![])) is NO LONGER EQUIVALENT. SELF-EXPIRY FIRED: delete that exclude_re entry and the ${CANARY_FN} canary together; a plain non-emptiness assertion now kills the mutant for real`,
      };
    }
  }
  return {
    ok: true,
    reason: `all ${parts.length} evolution-path RON part(s) still reduce to \`[]\` (pre-EG3 state)`,
  };
}

// ---------------------------------------------------------------------------
// Canonical positive-control fixtures — updated to include ALL FOUR blessed
// exclusions (EG1 adds the fourth). The installed recipe + toml and these
// fixtures must be byte-consistent; if a later slice changes the wrapper or the
// toml, these controls document the contract the change must still satisfy.
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
    # Fail closed if the outcome file is absent — wc -l would also fail
    # under set -euo pipefail, but the explicit guard gives a clearer message (V4).
    if [ ! -f mutants.out/missed.txt ]; then
        echo "mutants.out/missed.txt absent — cannot verify zero-missed" >&2
        exit 1
    fi
    missed=$(wc -l < mutants.out/missed.txt)
    echo "mutate-core: missed=$missed (zero-tolerance ADR-0050; timeouts tolerated iff missed=0, ADR-0088)"
    if [ "$missed" -gt 0 ]; then
        echo "game-core mutation gate: $missed surviving mutant(s) — zero-tolerance (ADR-0050)" >&2
        exit 1
    fi
`;

const CANONICAL_MUTANTS_TOML = `# Blessed equivalent-mutant exclusions (ADR-0088 §Decision 2 + M14.5h + EG1).
#
# 1. toward_home Y-branch (npc/rules.rs:61:15): |dx| < |dy| → dy != 0, so
#    \`dy > 0\` and \`dy >= 0\` are indistinguishable on the reachable domain.
#    Line-pinned: drift resurfaces the mutant → nightly red → re-pin consciously.
#    Guarded by evals/mutate-core-recipe-integrity.eval.mjs.
#
# 2. apply_entry_ability EntryHeal guard (ability.rs:170:60): \`current_hp < max_hp\`
#    vs \`current_hp <= max_hp\` produce identical output because the branch body
#    clamps: \`current_hp.saturating_add(heal).min(max_hp)\`. At current_hp == max_hp
#    both branches yield max_hp after the clamp; no test can distinguish them.
#    Proved by EARS-h-1a (boundary_full_hp_no_heal) in m14_5h_tests.rs ("no mutation
#    test can be written here to distinguish the two operators"). Line-pinned;
#    re-pinned from 169 to 170 (fix-nightly-mutants: one line of code inserted above
#    the condition between M14.5h and the nightly run 29320384291).
#
# 3. TradeStatus::is_active (trading/types.rs:56:9): \`replace TradeStatus::is_active
#    -> bool with true\` is equivalent. Both Pending and ConfirmedByCounterparty return
#    true; terminal state is a DELETED ROW not an enum variant, so \`is_active()\` is
#    correctly always true. No behavioral test can distinguish correct-always-true from
#    mutation-always-true. Line-pinned.
#
# 4. load_evolution_paths (content.rs:624:5): \`replace load_evolution_paths ->
#    Result<Vec<EvolutionPath>, String> with Ok(vec![])\` is equivalent. game-core's
#    build.rs globs content/evolution_paths/*.ron into the compile-time constant
#    EVOLUTION_PATHS_RON_PARTS; that directory holds exactly one part, 000-core.ron,
#    whose payload is \`[]\` — DELIBERATELY empty until slice EG3 authors the real
#    evolution graph (EG1-10 / ADR-0174 D6 require rules R1-R12 to be runnable
#    against the empty set). load_evolution_paths is a nullary pure delegate, so it
#    really does return \`Ok(vec![])\` today, and no test can distinguish the mutant
#    because no test can alter a build-time constant. The pin names the EXACT
#    mutation: the siblings at the same line (\`with Err(...)\`, \`with
#    Ok(vec![Default::default()])\`) are NOT equivalent and stay killable.
#
#    CONTINGENT, NOT PERMANENT — this is the one entry that differs in kind from
#    1-3. Those are equivalent by construction, forever. This one is equivalent
#    only while the registry is empty, and content.rs:624 will NOT move when EG3
#    adds RON data — so a naive line-pin would silently suppress a real, killable
#    mutant forever. It is therefore SELF-EXPIRING via two mechanical tripwires
#    that both go red the instant EG3 authors a single edge:
#      • the canary test \`eg1_load_evolution_paths_is_empty_pending_eg3\`
#        (game-core/src/content.rs), which asserts the registry is still empty; and
#      • evals/mutate-core-recipe-integrity.eval.mjs, whose self-expiry teeth
#        require — WHENEVER this entry is present — that the canary still exists
#        and that every content/evolution_paths/*.ron is still semantically \`[]\`.
#    When EG3 lands, delete this entry and the canary together; an ordinary
#    non-emptiness test then kills the mutant for real.
exclude_re = [
    "npc/rules\\\\.rs:61:15: replace > with >= in toward_home",
    "ability\\\\.rs:170:60: replace < with <= in apply_entry_ability",
    "trading/types\\\\.rs:56:9: replace TradeStatus::is_active -> bool with true",
    "content\\\\.rs:624:5: replace load_evolution_paths -> Result<Vec<EvolutionPath>, String> with Ok\\\\(vec!\\\\[\\\\]\\\\)",
]
`;

// ---------------------------------------------------------------------------
// Default export: proof-of-teeth, then real file checks.
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'mutate-core-recipe-integrity (fix-nightly / ADR-0088 + M14.5h + EG1: mutate-core wrapper + .cargo/mutants.toml pinned to four blessed exclusions, the fourth self-expiring)'; // name kept for log-stability

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

  // TEETH 8 — mutants.toml with FIVE exclude_re entries → must be rejected
  // (unbounded growth: only four blessed exclusions are allowed). The fixture is
  // the four blessed entries PLUS a bogus fifth, so the tooth bites on the count
  // alone and cannot be satisfied by any per-entry fragment check.
  const tomlFiveEntries =
    'exclude_re = ["npc/rules\\\\.rs:61:15: replace > with >= in toward_home", "ability\\\\.rs:170:60: replace < with <= in apply_entry_ability", "trading/types\\\\.rs:56:9: replace TradeStatus::is_active -> bool with true", "content\\\\.rs:624:5: replace load_evolution_paths -> Result<Vec<EvolutionPath>, String> with Ok\\\\(vec!\\\\[\\\\]\\\\)", "npc/rules\\\\.rs:53:15: replace > with >= in toward_home"]\n';
  {
    const r = mutantsTomlPinned(tomlFiveEntries);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 8 (five entries): mutantsTomlPinned accepted a mutants.toml with FIVE exclude_re entries — the exclusion list is pinned to EXACTLY FOUR blessed entries; unbounded growth would silence real surviving mutants (the fifth 53:15 entry is NOT equivalent and must get a killing test, not exclusion)',
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
          'TEETH 10 (examine_re): mutantsTomlPinned accepted a mutants.toml with an examine_re key — examine_re narrows which mutants run AT ALL, changing scope for every nightly. Only the four blessed exclude_re exclusions are permitted; any other scope-shaping key must be rejected',
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

  // TEETH 12 — body contains `return 0` shell neuter → must be rejected.
  // In a top-level `#!/usr/bin/env bash` script, `return 0` exits the script
  // with status 0 (same effect as `exit 0`), bypassing every gate that follows.
  const justfileReturnZero =
    'mutate-core:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    status=0\n    cargo mutants -p game-core || status=$?\n    return 0\n    if [ "$status" -ne 0 ] && [ "$status" -ne 2 ] && [ "$status" -ne 3 ]; then exit "$status"; fi\n    if [ ! -f mutants.out/missed.txt ]; then exit 1; fi\n    missed=$(wc -l < mutants.out/missed.txt)\n    if [ "$missed" -gt 0 ]; then exit 1; fi\n';
  if (mutateCoreRecipeIntact(justfileReturnZero)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH 12 (return 0 neuter): mutateCoreRecipeIntact accepted a recipe with `return 0` immediately after cargo mutants — in a top-level bash script `return 0` exits with status 0, bypassing all gates. The predicate must ban `return 0` the same way it bans `exit 0`',
    };
  }

  // TEETH 13 — mutants.toml with correct line-pin but wrong operator text → reject.
  // An exclusion of `replace > with <` at the same line is NOT equivalent —
  // `> → <` would make `toward_home` return North where South is expected and
  // tests WOULD catch it. Only `replace > with >=` is the provably-equivalent form.
  const tomlWrongOperator =
    'exclude_re = ["npc/rules\\\\.rs:61:15: replace > with < in toward_home"]\n';
  {
    const r = mutantsTomlPinned(tomlWrongOperator);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 13 (wrong operator): mutantsTomlPinned accepted an exclusion with the correct line-pin but wrong operator `replace > with <` — this would silence a non-equivalent mutant (> → < makes the NPC head North where South is expected; tests WOULD catch it). The full canonical text including `replace > with >=` must be present',
      };
    }
  }

  // TEETH 14 — mutants.toml with only the toward_home exclusion (missing entries
  // 2+3+4) → must be rejected. Four blessed entries are required; a single-entry
  // file misses the ability.rs, is_active and load_evolution_paths exclusions.
  const tomlOnlyTowardHome =
    'exclude_re = ["npc/rules\\\\.rs:61:15: replace > with >= in toward_home"]\n';
  {
    const r = mutantsTomlPinned(tomlOnlyTowardHome);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 14 (missing entries 2+3+4): mutantsTomlPinned accepted a single-entry mutants.toml missing the ability.rs:170:60, is_active and load_evolution_paths exclusions — the gate must require EXACTLY FOUR blessed entries',
      };
    }
  }

  // TEETH 15 — mutants.toml with toward_home + ability.rs only (missing entries
  // 3+4) → must be rejected. All four blessed entries are required; two is
  // insufficient.
  const tomlMissingIsActive =
    'exclude_re = ["npc/rules\\\\.rs:61:15: replace > with >= in toward_home", "ability\\\\.rs:170:60: replace < with <= in apply_entry_ability"]\n';
  {
    const r = mutantsTomlPinned(tomlMissingIsActive);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 15 (missing entries 3+4): mutantsTomlPinned accepted a two-entry mutants.toml that is missing the third (trading/types.rs:56:9 is_active, fix-nightly-mutants) and fourth (content.rs:624:5 load_evolution_paths, EG1) blessed exclusions — four entries are now required',
      };
    }
  }

  // TEETH 16 — the pre-EG1 three-entry mutants.toml (missing entry 4) → must be
  // rejected. This is the exact file shape that shipped before EG1; without this
  // tooth the count bump from THREE to FOUR would be unenforced.
  const tomlMissingLoadEvolutionPaths =
    'exclude_re = ["npc/rules\\\\.rs:61:15: replace > with >= in toward_home", "ability\\\\.rs:170:60: replace < with <= in apply_entry_ability", "trading/types\\\\.rs:56:9: replace TradeStatus::is_active -> bool with true"]\n';
  {
    const r = mutantsTomlPinned(tomlMissingLoadEvolutionPaths);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 16 (missing load_evolution_paths entry): mutantsTomlPinned accepted the pre-EG1 three-entry mutants.toml — the fourth blessed exclusion (content.rs:624:5 load_evolution_paths -> Ok(vec![]), EG1) is required, otherwise the nightly zero-tolerance gate (ADR-0050) stays red on a provably-equivalent mutant',
      };
    }
  }

  // TEETH 17 (SELF-EXPIRY 1) — content.rs that only MENTIONS the canary in prose,
  // with no `fn` declaration → must be rejected. Deleting the canary while keeping
  // the fourth exclusion would strand a contingently-equivalent pin with no expiry
  // mechanism; a doc-comment reference must not satisfy the tripwire.
  const contentRsCanaryOnlyInProse = `pub fn load_evolution_paths() -> Result<Vec<EvolutionPath>, String> {
    parse_evolution_paths_parts(EVOLUTION_PATHS_RON_PARTS)
}
#[cfg(test)]
mod tests {
    /// See ${CANARY_FN} (deleted in a cleanup pass) for why the
    /// content.rs:624:5 exclusion is blessed.
    #[test]
    fn unrelated_test() {}
}
`;
  {
    const r = canaryTestPresent(contentRsCanaryOnlyInProse);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH 17 (canary in prose only): canaryTestPresent accepted a content.rs where ${CANARY_FN} appears ONLY in a doc comment, with no \`fn\` declaration — the fourth blessed exclusion is CONTINGENTLY equivalent and must be tied to a live canary; a prose mention keeps no tripwire at all`,
      };
    }
  }

  // TEETH 17b — absent / empty content.rs → graceful reject, never a throw.
  {
    const r = canaryTestPresent(null);
    if (r.ok || typeof r.reason !== 'string' || r.reason.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 17b (absent content.rs): canaryTestPresent(null) must return { ok:false } with a non-empty reason — an unreadable content.rs must never yield a vacuous pass',
      };
    }
  }

  // TEETH 18 (SELF-EXPIRY 2) — an evolution-path RON part carrying a real edge
  // → must be rejected. This is the tooth that fires the instant slice EG3 lands
  // content: at that moment content.rs:624:5 stops being equivalent and the
  // fourth exclusion MUST be deleted.
  const ronWithOneEdge = `// Evolution-path graph — DATA, not code.
[
    (
        edge_id: 1,
        from_species: 7,
        to_species: 9,
        min_level: 18,
    ),
]
`;
  {
    const r = evolutionPathsRegistryEmpty([{ file: '000-core.ron', text: ronWithOneEdge }]);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 18 (EG3 content landed): evolutionPathsRegistryEmpty accepted a RON part containing a real edge (edge_id: 1) — this is exactly the self-expiry condition. Once the registry is non-empty, load_evolution_paths no longer returns Ok(vec![]) and the fourth blessed exclusion silences a REAL, killable mutant; the checker must reject it so the exclusion is forced out',
      };
    }
  }

  // TEETH 18b — a commented-out edge that is NOT actually commented out on every
  // line (the comment-stripper must not be fooled by a trailing `//` elsewhere).
  {
    const r = evolutionPathsRegistryEmpty([
      { file: 'a.ron', text: '[]\n' },
      { file: '999-eg3.ron', text: '// EG3 first pass\n[(edge_id: 2)] // one edge\n' },
    ]);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 18b (second part non-empty): evolutionPathsRegistryEmpty accepted a part list where the FIRST part is `[]` but a later part carries an edge — every part is globbed into EVOLUTION_PATHS_RON_PARTS and concatenated, so ALL parts must reduce to `[]`',
      };
    }
  }

  // TEETH 18c — zero parts → must be rejected (vacuous-green class). An empty or
  // mis-globbed directory must not be mistaken for an empty registry.
  {
    const r = evolutionPathsRegistryEmpty([]);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 18c (zero parts): evolutionPathsRegistryEmpty accepted an EMPTY part list — a broken glob or moved registry directory would then satisfy the self-expiry tripwire while proving nothing (V4 vacuous-green class)',
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
        detail: `POSITIVE CONTROL B: mutantsTomlPinned REJECTED the canonical .cargo/mutants.toml (plan §T6 + EG1 entry 4): ${r.reason} — the predicate is too strict and would fail even with the blessed toml installed`,
      };
    }
  }

  // POSITIVE CONTROL C — a content.rs carrying the real canary declaration must PASS.
  {
    const contentRsWithCanary = `#[cfg(test)]
mod tests {
    #[test]
    fn ${CANARY_FN}() {
        let paths = load_evolution_paths().expect("evolution_paths registry must parse");
        assert!(paths.is_empty(), "CANARY EXPIRED");
    }
}
`;
    const r = canaryTestPresent(contentRsWithCanary);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `POSITIVE CONTROL C: canaryTestPresent REJECTED a content.rs that DOES declare ${CANARY_FN}: ${r.reason} — the tripwire is too strict and would fail a correct tree`,
      };
    }
  }

  // POSITIVE CONTROL D — the shipped, heavily-commented `[]` registry must PASS.
  // 000-core.ron is ~25 lines of comment around a bare `[]`; the reducer must see
  // through that or the self-expiry tooth would fire permanently (a tooth that
  // ALWAYS bites is as useless as one that never does).
  {
    const ronCommentedEmpty = `// Evolution-path graph — DATA, not code (ADR-0006/0057/0174).
//
// (
//     edge_id: 1,
//     from_species: 7,
// ),
//
// DELIBERATELY EMPTY in EG1: the schema/type freeze ships before the content
// pass (EG3) authors the real graph.
[]
`;
    const r = evolutionPathsRegistryEmpty([{ file: '000-core.ron', text: ronCommentedEmpty }]);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `POSITIVE CONTROL D: evolutionPathsRegistryEmpty REJECTED a commented-out-but-empty RON part: ${r.reason} — the comment stripper is broken and the self-expiry tooth would fire on the correct pre-EG3 tree`,
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

  // Real check 2: .cargo/mutants.toml pinned to the four blessed exclusions.
  if (!existsSync(tomlPath)) {
    return {
      name,
      pass: false,
      detail:
        '.cargo/mutants.toml is absent — it must carry the four line-pinned blessed exclusions per ADR-0088 + M14.5h + fix-nightly-mutants + EG1',
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

  // Real check 3 (SELF-EXPIRY, EG1): entry 4 is CONTINGENTLY equivalent, so while
  // it is present BOTH tripwires must hold. Keyed off the entry itself — delete
  // the exclusion and these checks retire with it, exactly as intended.
  const entry4Present = tomlText.indexOf('load_evolution_paths') !== -1;
  if (entry4Present) {
    const contentRsPath = path.join(root, 'game-core/src/content.rs');
    let contentRs = null;
    try {
      contentRs = readFileSync(contentRsPath, 'utf8');
    } catch {
      return {
        name,
        pass: false,
        detail:
          'cannot read game-core/src/content.rs — required while the fourth blessed exclusion (content.rs:624:5 load_evolution_paths) is pinned',
      };
    }
    const canary = canaryTestPresent(contentRs);
    if (!canary.ok) {
      return { name, pass: false, detail: `SELF-EXPIRY 1 failed: ${canary.reason}` };
    }

    const ronDir = path.join(root, 'game-core/content/evolution_paths');
    let parts = [];
    try {
      parts = readdirSync(ronDir)
        .filter((f) => f.endsWith('.ron'))
        .sort()
        .map((f) => ({ file: f, text: readFileSync(path.join(ronDir, f), 'utf8') }));
    } catch {
      return {
        name,
        pass: false,
        detail:
          'cannot read game-core/content/evolution_paths/ — required while the fourth blessed exclusion (content.rs:624:5 load_evolution_paths) is pinned',
      };
    }
    const registry = evolutionPathsRegistryEmpty(parts);
    if (!registry.ok) {
      return { name, pass: false, detail: `SELF-EXPIRY 2 failed: ${registry.reason}` };
    }
  }

  return {
    name,
    pass: true,
    detail:
      'mutate-core recipe intact (whole-crate -p game-core, fail-closed missed.txt count-compare, no scope-narrowing / neuter / cap= knob) and .cargo/mutants.toml pins exactly the four blessed equivalent-mutant exclusions: 61:15 toward_home (ADR-0088), 170:60 apply_entry_ability (M14.5h re-pinned), 56:9 is_active (fix-nightly-mutants), and 624:5 load_evolution_paths (EG1) — the last of which is CONTINGENTLY equivalent and self-expires: its canary eg1_load_evolution_paths_is_empty_pending_eg3 is declared in game-core/src/content.rs and every content/evolution_paths/*.ron still reduces to `[]`',
  };
}
