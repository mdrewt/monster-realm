// nightly-coverage-wasm-wiring.eval.mjs — the `coverage`-needs-`wasm` wiring gate.
//
// THE BUG THIS GATES. `justfile` declares a bare `coverage:` with NO just-dependency,
// but `client/src/main.ts` imports the GITIGNORED `../../client-wasm/pkg/client_wasm.js`.
// So the nightly `coverage` job runs vitest against a tree with no pkg and dies with
// `Failed to resolve import … from "src/main.ts"` — measured `36 failed | 2782 passed`,
// i.e. the coverage threshold is never even reached. The siblings `e2e:` and
// `a11y-e2e:` already declare `: wasm` for EXACTLY this reason (the rationale is
// written out above `a11y-e2e` in the justfile). Separately, the nightly `coverage`
// JOB provisions only checkout/setup-node/setup-just — no Rust, no wasm-pack — so
// the justfile dependency alone would be unsatisfiable on the runner.
//
// THREE CRITERIA, three exported pure predicates:
//   C1  `coverage` declares `wasm` as a PRIOR dependency, and `wasm` still builds.
//   C2  Totality, job-scoped AND ORDERED: no OTHER nightly-or-ci `just X` invocation
//       has the same gap.
//   C3  The nightly `coverage` JOB BLOCK actually provisions Rust + wasm-pack.
//
// ORACLE. C1/C2 read the recipe graph from `just --dump --dump-format json`, spawned
// with an explicit `--justfile <repoRoot>/justfile --working-directory <repoRoot>`:
// `just` searches UPWARD, and this repo is nested inside a harness that ships its own
// justfile, so without the pin the gate can silently parse the WRONG file. Verified
// shape-compatible on just 1.21.0 and 1.55.1 (both emit `dependencies:
// [{recipe, arguments}]` and an integer `priors`).
//
// FAIL CLOSED, NEVER SKIP. A non-zero exit, empty stdout, a JSON.parse throw, a
// missing/empty `recipes` map, a missing `priors`, or a dependency entry that is
// neither a string nor an object with a string `recipe` all FAIL LOUDLY and name
// `just --version` in the message. A "skipped" verdict here would be a permanently
// vacuous gate — the exact failure mode this eval exists to prevent.
//
// NO MAIN GUARD, deliberately. A `dirname`/`endsWith(process.argv[1])` guard in an
// eval module has been MEASURED to truncate `evals/run.mjs` mid-loop at exit 0 (37 of
// 90 evals ran, 3 FAILs swallowed, CI green). This module is import-only; `run.mjs`
// discovers it by readdir and calls the default export.
//
// NO DYNAMICALLY CONSTRUCTED REGEXES ANYWHERE. Semgrep's `detect-non-literal-regexp`
// is remote-only in this repo and has bitten twice. Literal regex or String.indexOf
// only. (The banned constructor is deliberately not spelled out here either: that
// same remote Semgrep pass matches raw comment TEXT, so naming it would re-introduce
// the finding this file exists to avoid.)
//
// NODE 18 COMPATIBLE. The acceptance ledger imports this module under /usr/bin/node
// v18.19.1 — no `Array.prototype.findLast`, no `Object.hasOwn`, no `structuredClone`.
//
// ---------------------------------------------------------------------------
// KNOWN LIMITS (written down rather than papered over)
// ---------------------------------------------------------------------------
//  L1. The C2 roster is DERIVED from recipe BODY TEXT (`vitest` / `npm test` /
//      `npm run typecheck`). A future recipe that reaches vitest through a WRAPPER
//      SCRIPT (`node scripts/run-unit.mjs`) is invisible to a body-text matcher.
//      The anti-vacuity floors below catch REMOVAL of the known four roster members;
//      they cannot catch ADDITION of an invisible fifth. Closing that would need a
//      script-call graph, which is out of scope here.
//  L2. The dependency graph is `just`'s, and `just`'s graph does not see a recipe
//      that SHELLS OUT to `just`. There is a LIVE in-tree instance: `justfile:60-62`,
//      where `eval:` runs `just perf-budget` as a body line. Anything reached that
//      way is outside C2's closure by construction.
//  L3. `wasm` reachability inside a closure is computed over PRIORS ONLY (a
//      SUBSEQUENT dependency runs after the body, so it cannot provision it). That is
//      conservative: an exotic-but-correct shape where the roster member is a nested
//      dependency and `wasm` is prior only to its parent would be rejected. No such
//      shape exists in this tree; if one is ever wanted, widen deliberately.
//  L4. Comment stripping truncates a body line at the first `#`, including a `#`
//      inside a shell quote (e.g. `grep -Eo '^(ℹ|#) pass'` in the `test:` recipe).
//      That direction is SAFE for this gate — it can only hide a roster marker, never
//      invent one — but it means the stripped body is not a faithful shell script.
//  L5. C3's per-step key scan does not resolve YAML anchors/merge keys. None appear
//      in `.github/workflows/nightly.yml`.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// strictJobBlock, NOT extractJobBlock from e2e-desync-teeth.eval.mjs: the latter is
// unanchored (it can bind to a `  coverage:` line inside any top-level string above
// `jobs:`) and terminates at ANY line at indent 2 — INCLUDING a comment — so a step
// parked below a `  # …` comment falls outside the scanned block entirely. Cross-eval
// import is an established pattern here (ci-gate-wiring.eval.mjs does the same), and
// nightly-smoke-wiring.eval.mjs has no top-level execution.
import { strictJobBlock } from './nightly-smoke-wiring.eval.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Constants (the contract, hardcoded so that changing BOTH sides still reds)
// ---------------------------------------------------------------------------

export const WASM_PACK_ACTION_REF =
  'jetli/wasm-pack-action@0d096b08b4e5a7de8c28de67e11e945404e9eefa';
export const WASM_PACK_VERSION_LITERAL = "version: 'v0.15.0'";
export const RUST_TOOLCHAIN_ACTION_REF = 'dtolnay/rust-toolchain@stable';
export const WASM_TARGET_LITERAL = 'targets: wasm32-unknown-unknown';
export const COVERAGE_GATE_STEP = '- run: just coverage';
export const WASM_PROVISION_STEP = '- run: just wasm';
export const WASM_BUILD_MARKER = 'wasm-pack build client-wasm';
// The FULL command, pinned by EQUALITY rather than containment. A containment pin is
// satisfied by `echo "wasm-pack build client-wasm"`, by a `-` ignore-failure prefix,
// and by `--out-dir pkg-dist` writing the pkg somewhere main.ts does not import from —
// all three measured green against an indexOf pin.
export const WASM_BUILD_COMMAND = 'wasm-pack build client-wasm --target bundler';
// The runtime self-assertion in the `coverage` recipe. This is the one clause no text
// oracle over `just --dump` can be fooled about: whatever the recipe graph claims, the
// runner checks the actual artifact main.ts imports and dies loudly if it is absent.
export const COVERAGE_ARTIFACT_ASSERT = 'test -f client-wasm/pkg/client_wasm.js';

// Structural soundness of the `wasm` recipe. Returns a reason string, or null if clean.
export function c1WasmStructureFault(w) {
  if (w.paramCount !== 0) {
    return `the \`wasm\` recipe takes ${w.paramCount} parameter(s). A parameterized build can be steered to a no-op by a single call site while every other one still builds; only an unparameterized \`wasm\` is admitted.`;
  }
  if (w.hasShebang) {
    return 'the `wasm` recipe carries a shebang. `#!/bin/true` (or a shebang script with an early `exit 0` guard) neuters the whole recipe while every body line survives verbatim in the dump — measured green against a text pin.';
  }
  if (w.attrCount !== 0) {
    return `the \`wasm\` recipe carries ${w.attrCount} attribute(s); attributes can make it conditional or non-executing, so only an unattributed \`wasm\` is admitted.`;
  }
  if (!w.bodyIsPureLiterals) {
    return 'the `wasm` recipe body contains a non-literal fragment (an interpolation or a `{{ if ... }}` conditional). `just` dumps BOTH branches of a conditional as sibling literals, so the build command can be PRESENT in the text while the branch that actually executes is the other one — measured green against a text pin. Only a plain literal command line is admitted.';
  }
  if (w.literalLines.length !== 1) {
    return `the \`wasm\` recipe body has ${w.literalLines.length} line(s); exactly one is admitted so the build command can be pinned by equality.`;
  }
  const only = w.literalLines[0].trim();
  if (only !== WASM_BUILD_COMMAND) {
    return `the \`wasm\` recipe body is ${JSON.stringify(only)}, not exactly ${JSON.stringify(WASM_BUILD_COMMAND)}. Containment is not enough: \`echo "${WASM_BUILD_MARKER}"\`, a leading \`-\` ignore-failure prefix, and a redirected \`--out-dir\` all contain the marker while building nothing main.ts can import.`;
  }
  return null;
}

// A recipe is on the "client-loading roster" when its body actually runs the client
// test/typecheck toolchain — those are the ones whose entry module chain reaches
// client/src/main.ts and therefore the gitignored wasm pkg.
export const ROSTER_MARKERS = ['vitest', 'npm test', 'npm run typecheck'];

// ANTI-VACUITY FLOORS. Without these, C2 is a loop over a possibly-empty set that
// passes trivially — the single most common way a totality gate goes silently dead.
export const ROSTER_FLOOR = ['coverage', 'client-test', 'client-typecheck', 'a11y-e2e'];
export const NIGHTLY_ENTRY_FLOOR = [
  'mutate-core',
  'mutate-server',
  'coverage',
  'smoke-republish',
  'a11y-e2e',
];
export const CI_ENTRY_FLOOR = [
  'lint',
  'typecheck',
  'test',
  'eval',
  'wasm',
  'client-typecheck',
  'client-test',
  'observability-validate',
  'e2e',
];
export const MIN_OBLIGATIONS_CHECKED = 3;

// ---------------------------------------------------------------------------
// just --dump ingestion
// ---------------------------------------------------------------------------

function justVersionString() {
  try {
    const v = spawnSync('just', ['--version'], { encoding: 'utf8' });
    if (v.error) return `<just --version failed: ${v.error.message}>`;
    return String(v.stdout || v.stderr || '').trim() || '<no output>';
  } catch (err) {
    return `<just --version threw: ${err && err.message}>`;
  }
}

function collectStrings(node, out) {
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) collectStrings(node[key], out);
  }
}

// `body` is an array of LINES; each line is an array of FRAGMENTS (plain strings for
// literal text, objects for `{{interpolations}}`). Strings are collected recursively
// and joined; lines are joined with newlines.
export function bodyToText(body) {
  if (!Array.isArray(body)) return '';
  const lines = [];
  for (const line of body) {
    const parts = [];
    collectStrings(line, parts);
    lines.push(parts.join(''));
  }
  return lines.join('\n');
}

// `just --dump` DOES include `#` comment lines in a recipe body (verified). An
// unstripped matcher therefore matches `vitest` in a COMMENT — which would put a
// recipe on the roster that never runs vitest at all. Strip `#` to end-of-line, but
// never eat a `#!/usr/bin/env bash` shebang (that line is load-bearing: it selects
// the recipe's interpreter).
export function stripJustComments(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (line.trimStart().indexOf('#!') === 0) {
      out.push(line);
      continue;
    }
    const hash = line.indexOf('#');
    out.push(hash === -1 ? line : line.slice(0, hash));
  }
  return out.join('\n');
}

// Raw `just --dump --dump-format json` object -> the normalized recipe map:
//   { <name>: { name, deps: string[], priors: number, body: string /* stripped */ } }
// Every malformed shape THROWS, naming `just --version`.
export function normalizeRecipes(dump, versionHint) {
  const ver = versionHint === undefined ? '<not probed>' : versionHint;
  const suffix = ` (just --version: ${ver})`;
  if (dump === null || typeof dump !== 'object' || Array.isArray(dump)) {
    throw new Error(`just --dump produced a non-object payload${suffix}`);
  }
  const raw = dump.recipes;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`just --dump payload has no \`recipes\` object${suffix}`);
  }
  const names = Object.keys(raw);
  if (names.length === 0) {
    throw new Error(
      `just --dump reported ZERO recipes — an empty recipe map would make every check below vacuously true${suffix}`,
    );
  }
  const out = {};
  for (const name of names) {
    const rec = raw[name];
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new Error(`just --dump recipe '${name}' is not an object${suffix}`);
    }
    const rawDeps = rec.dependencies === undefined ? [] : rec.dependencies;
    if (!Array.isArray(rawDeps)) {
      throw new Error(`just --dump recipe '${name}' has a non-array \`dependencies\`${suffix}`);
    }
    const deps = [];
    const depArgCounts = [];
    for (const dep of rawDeps) {
      if (typeof dep === 'string') {
        deps.push(dep);
        depArgCounts.push(0);
        continue;
      }
      if (dep !== null && typeof dep === 'object' && typeof dep.recipe === 'string') {
        deps.push(dep.recipe);
        // F1: `coverage: (wasm "prebuilt")` dumps a dependency BYTE-IDENTICAL to the
        // honest `coverage: wasm` once arguments are discarded — and a parameterized
        // `wasm mode="build":` can then branch to a no-op for exactly that one caller
        // while every other call site still builds. Retain the arity.
        depArgCounts.push(Array.isArray(dep.arguments) ? dep.arguments.length : 0);
        continue;
      }
      throw new Error(
        `just --dump recipe '${name}' has a dependency entry that is neither a string nor an object with a string \`recipe\` — refusing to guess${suffix}`,
      );
    }
    const priors = rec.priors;
    if (typeof priors !== 'number' || !Number.isInteger(priors) || priors < 0) {
      throw new Error(
        `just --dump recipe '${name}' has no usable integer \`priors\` — without it a SUBSEQUENT dependency (\`x: && wasm\`) is indistinguishable from a PRIOR one${suffix}`,
      );
    }
    if (priors > deps.length) {
      throw new Error(
        `just --dump recipe '${name}' reports priors=${priors} but only ${deps.length} dependency/ies${suffix}`,
      );
    }
    if (rec.body !== undefined && !Array.isArray(rec.body)) {
      throw new Error(`just --dump recipe '${name}' has a non-array \`body\`${suffix}`);
    }
    // F2/F4/F5: a text view of the body is not a sound oracle for "this recipe
    // really runs the build". `just` dumps BOTH branches of a
    // `{{ if ... { A } else { B } }}` conditional as sibling literals, so the marker
    // can be present while the executed branch is the other one; a leading `-`
    // ignore-failure prefix stays glued to the text; and a `#!/bin/true` shebang
    // neuters the recipe while every body line survives verbatim. Keep the raw
    // structure so C1 can demand a pure, single, literal command line.
    const bodyLines = Array.isArray(rec.body) ? rec.body : [];
    let bodyIsPureLiterals = true;
    const literalLines = [];
    for (const line of bodyLines) {
      if (!Array.isArray(line)) {
        bodyIsPureLiterals = false;
        continue;
      }
      let joined = '';
      for (const frag of line) {
        if (typeof frag === 'string') joined += frag;
        else bodyIsPureLiterals = false;
      }
      literalLines.push(joined);
    }
    out[name] = {
      name,
      deps,
      depArgCounts,
      priors,
      body: stripJustComments(bodyToText(rec.body)),
      literalLines,
      bodyIsPureLiterals,
      paramCount: Array.isArray(rec.parameters) ? rec.parameters.length : 0,
      hasShebang: rec.shebang === true,
      attrCount: Array.isArray(rec.attributes) ? rec.attributes.length : 0,
    };
  }
  return out;
}

// The recipe map for the REAL tree. Fail-closed at every step.
export function loadRecipes() {
  const justfile = path.join(REPO_ROOT, 'justfile');
  const res = spawnSync(
    'just',
    ['--justfile', justfile, '--working-directory', REPO_ROOT, '--dump', '--dump-format', 'json'],
    { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  const ver = justVersionString();
  if (res.error) {
    throw new Error(
      `could not spawn \`just\` to dump ${justfile}: ${res.error.message} (just --version: ${ver})`,
    );
  }
  if (res.status !== 0) {
    throw new Error(
      `\`just --dump\` exited ${res.status} for ${justfile}: ${String(res.stderr || '').trim()} (just --version: ${ver})`,
    );
  }
  const stdout = String(res.stdout || '');
  if (stdout.trim() === '') {
    throw new Error(
      `\`just --dump\` produced EMPTY stdout for ${justfile} (just --version: ${ver})`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `\`just --dump --dump-format json\` output did not parse as JSON: ${err.message} (just --version: ${ver})`,
    );
  }
  return normalizeRecipes(parsed, ver);
}

// ---------------------------------------------------------------------------
// Workflow ingestion
// ---------------------------------------------------------------------------

export function loadWorkflows() {
  const files = {
    ci: path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
    nightly: path.join(REPO_ROOT, '.github', 'workflows', 'nightly.yml'),
  };
  const out = {};
  for (const key of Object.keys(files)) {
    let text;
    try {
      text = readFileSync(files[key], 'utf8');
    } catch (err) {
      throw new Error(`could not read ${files[key]}: ${err.message}`);
    }
    if (text.trim() === '') {
      throw new Error(`${files[key]} is empty — refusing to run a workflow gate over nothing`);
    }
    out[key] = { file: files[key], text };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared YAML line helpers (String/literal-regex only)
// ---------------------------------------------------------------------------

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isCommentLine(line) {
  return line.trim().indexOf('#') === 0;
}

// Drop a trailing ` # …` comment from an already-trimmed line.
function stripInlineComment(trimmed) {
  const idx = trimmed.indexOf(' #');
  return idx === -1 ? trimmed : trimmed.slice(0, idx).trimEnd();
}

// Anchored `key: value` parse. Tolerates `"if": false`, `'if': false` and `if : false`
// — all three are valid YAML and all three neuter a step, and none of them is seen by
// a naive `trimmed.startsWith('if:')`.
function parseKeyLine(trimmedText) {
  let rest = trimmedText;
  if (rest === '-') return null;
  if (rest.indexOf('- ') === 0) rest = rest.slice(2).trim();
  let key = null;
  if (rest.indexOf('"') === 0 || rest.indexOf("'") === 0) {
    const quote = rest[0];
    const end = rest.indexOf(quote, 1);
    if (end === -1) return null;
    key = rest.slice(1, end);
    rest = rest.slice(end + 1);
  } else {
    const colon = rest.indexOf(':');
    if (colon === -1) return null;
    key = rest.slice(0, colon).trimEnd();
    rest = rest.slice(colon);
  }
  rest = rest.trimStart();
  if (rest.indexOf(':') !== 0) return null;
  return { key, value: rest.slice(1).trim() };
}

// Map every line index in a workflow to the job it belongs to (or null). Anchored
// under a 0-indent `jobs:` key so a 2-space `  coverage:` line inside some unrelated
// top-level block scalar can never be mistaken for a job.
export function assignJobs(lines) {
  const owner = new Array(lines.length).fill(null);
  let inJobs = false;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || isCommentLine(line)) {
      owner[i] = current;
      continue;
    }
    const ind = indentOf(line);
    if (ind === 0) {
      inJobs = trimmed === 'jobs:' || trimmed.indexOf('jobs:') === 0;
      current = null;
      owner[i] = null;
      continue;
    }
    if (inJobs && ind === 2) {
      const bare = stripInlineComment(trimmed);
      if (bare.length > 1 && bare.lastIndexOf(':') === bare.length - 1) {
        current = bare.slice(0, -1).trim();
        owner[i] = current;
        continue;
      }
    }
    owner[i] = current;
  }
  return owner;
}

const TRAILING_PUNCT = ';,.)]}"\'`';

// Entry-point discovery. Per NON-COMMENT line: strip a ` #` tail, tokenize on
// whitespace, and for each token EXACTLY `just`, take the next token stripped of
// trailing punctuation; if it names a known recipe, record it.
//
// Token EQUALITY (not indexOf) is what makes `- uses: extractions/setup-just@dd310ad…`
// — a single token — never match. Tokenizing rather than matching `- run: just X` is
// what catches a `just X` buried inside a `run: |` block, which a line-form matcher
// would miss entirely.
export function findJustEntryPoints(yamlText, recipes) {
  const lines = String(yamlText).split('\n');
  const owner = assignJobs(lines);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || isCommentLine(line)) continue;
    const work = stripInlineComment(trimmed);
    const tokens = work.split(/\s+/);
    for (let t = 0; t < tokens.length - 1; t++) {
      if (tokens[t] !== 'just') continue;
      let cand = tokens[t + 1];
      while (cand.length > 0 && TRAILING_PUNCT.indexOf(cand[cand.length - 1]) !== -1) {
        cand = cand.slice(0, -1);
      }
      if (cand !== '' && Object.hasOwn(recipes, cand)) {
        found.push({ job: owner[i], recipe: cand, lineIndex: i });
      }
    }
  }
  return found;
}

// Line indices of every non-comment line whose TRIMMED form is EXACTLY
// `- run: just wasm`, grouped by job. Exactness is the point: `- run: just wasm || true`
// cannot fail, and `# - run: just wasm` does not run at all.
function wasmProvisionLinesByJob(yamlText) {
  const lines = String(yamlText).split('\n');
  const owner = assignJobs(lines);
  const byJob = {};
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue;
    if (lines[i].trim() !== WASM_PROVISION_STEP) continue;
    const job = owner[i] === null ? '<none>' : owner[i];
    if (!Object.hasOwn(byJob, job)) byJob[job] = [];
    byJob[job].push(i);
  }
  return byJob;
}

// ---------------------------------------------------------------------------
// Closures over the recipe graph
// ---------------------------------------------------------------------------

function closureOver(recipes, start, priorsOnly) {
  const seen = {};
  const order = [];
  const stack = [start];
  while (stack.length > 0) {
    const nameRaw = stack.pop();
    if (Object.hasOwn(seen, nameRaw)) continue;
    // hasOwnProperty, not a bare lookup: a recipe legitimately named `constructor`
    // or `toString` would otherwise resolve to Object.prototype and be "found".
    const rec = Object.hasOwn(recipes, nameRaw) ? recipes[nameRaw] : undefined;
    if (rec === undefined) {
      // An unknown recipe name is a FAIL, not a skip: a graph we cannot resolve is a
      // graph whose intersection with the roster we do not know.
      throw new Error(
        `recipe '${nameRaw}' (reached from '${start}') is not in the just --dump recipe map — the dependency graph could not be resolved`,
      );
    }
    seen[nameRaw] = true;
    order.push(nameRaw);
    const deps = priorsOnly ? rec.deps.slice(0, rec.priors) : rec.deps;
    for (const dep of deps) stack.push(dep);
  }
  return order;
}

export function fullClosure(recipes, start) {
  return closureOver(recipes, start, false);
}

export function priorClosure(recipes, start) {
  return closureOver(recipes, start, true);
}

export function deriveRoster(recipes) {
  const roster = [];
  for (const name of Object.keys(recipes)) {
    const body = recipes[name].body;
    let hit = false;
    for (const marker of ROSTER_MARKERS) {
      if (body.indexOf(marker) !== -1) {
        hit = true;
        break;
      }
    }
    if (hit) roster.push(name);
  }
  roster.sort();
  return roster;
}

// ---------------------------------------------------------------------------
// C1 — `coverage` declares `wasm` as a PRIOR dependency
//
// NOT merely "is in `dependencies`". MEASURED BYPASS: `coverage: && wasm` (a
// SUBSEQUENT dependency) emits a `dependencies` array BYTE-IDENTICAL to the honest
// `coverage: wasm` — but the body runs FIRST, so vitest still dies on the unresolved
// import before wasm ever builds. Only `priors` tells them apart:
//   `coverage: wasm`     -> priors: 1
//   `coverage: && wasm`  -> priors: 0
// Hence: priors >= 1 AND `wasm` present in dependencies.slice(0, priors).
//
// The `wasm` body assertion is the second half: gutting `wasm:` to `echo skip` would
// otherwise keep everything green with no pkg ever built.
// ---------------------------------------------------------------------------
export function checkC1(recipes) {
  if (recipes === null || typeof recipes !== 'object') {
    return { ok: false, reason: 'C1: no recipe map was supplied (fail closed)' };
  }
  if (!Object.hasOwn(recipes, 'coverage')) {
    return {
      ok: false,
      reason:
        'C1: the just recipe map has no `coverage` recipe at all — a missing key is a FAILURE, never a silent pass (the nightly `coverage` job runs `just coverage`)',
    };
  }
  if (!Object.hasOwn(recipes, 'wasm')) {
    return {
      ok: false,
      reason:
        'C1: the just recipe map has no `wasm` recipe — nothing can build client-wasm/pkg, so no dependency on it could be satisfied',
    };
  }
  const cov = recipes.coverage;
  if (cov.deps.length === 0) {
    return {
      ok: false,
      reason:
        'C1: `coverage` declares NO dependencies. client/src/main.ts imports the gitignored ../../client-wasm/pkg/client_wasm.js, so vitest under `just coverage` fails to RESOLVE (measured: 36 failed | 2782 passed) before the coverage threshold is ever evaluated. Declare `coverage: wasm`, exactly as `e2e:` and `a11y-e2e:` already do.',
    };
  }
  if (cov.priors < 1) {
    return {
      ok: false,
      reason: `C1: \`coverage\` has ${cov.deps.length} dependency/ies [${cov.deps.join(', ')}] but priors=0 — every one of them is a SUBSEQUENT dependency (\`coverage: && wasm\`), which runs AFTER the recipe body. The dependencies array is byte-identical to the honest \`coverage: wasm\`, but vitest still dies on the unresolved wasm import first. Only \`priors\` distinguishes them.`,
    };
  }
  const priorDeps = cov.deps.slice(0, cov.priors);
  if (priorDeps.indexOf('wasm') === -1) {
    return {
      ok: false,
      reason: `C1: \`coverage\` prior dependencies are [${priorDeps.join(', ')}] — \`wasm\` is not among them (full dependency list: [${cov.deps.join(', ')}], priors=${cov.priors})`,
    };
  }
  // F1: an ARGUMENT on the prior edge re-targets a parameterized `wasm` recipe at a
  // no-op branch for this caller alone, leaving every other call site building.
  const wasmEdge = priorDeps.indexOf('wasm');
  if (cov.depArgCounts[wasmEdge] !== 0) {
    return {
      ok: false,
      reason: `C1: \`coverage\` passes ${cov.depArgCounts[wasmEdge]} argument(s) to its \`wasm\` prior dependency. A parameterized \`wasm\` can branch to a no-op for exactly this caller (\`coverage: (wasm "prebuilt")\`) while \`just wasm\`, \`e2e\` and \`a11y-e2e\` all keep building — the dump is otherwise byte-identical to the honest wiring. Only the unparameterized edge is admitted.`,
    };
  }
  const w = recipes.wasm;
  const wasmStructuralFault = c1WasmStructureFault(w);
  if (wasmStructuralFault !== null) {
    return { ok: false, reason: `C1: ${wasmStructuralFault}` };
  }
  // F3: a step-level `env:` on the gate step plus an env-guarded build skips the build
  // with every text criterion still green. The runtime assertion below is the backstop:
  // it checks the artifact itself, so any graph-level or env-level cheat fails LOUDLY on
  // the runner instead of silently running vitest against a missing pkg.
  if (cov.body.indexOf(COVERAGE_ARTIFACT_ASSERT) === -1) {
    return {
      ok: false,
      reason: `C1: the \`coverage\` recipe body no longer self-asserts the artifact with \`${COVERAGE_ARTIFACT_ASSERT}\`. That runtime check is the only clause no text oracle over the recipe graph can be fooled about — without it, an env-guarded or conditionally-branching \`wasm\` leaves this gate green while vitest runs against a missing pkg.`,
    };
  }
  return {
    ok: true,
    reason: `C1: \`coverage\` declares wasm as an unparameterized PRIOR dependency (priors=${cov.priors}, deps=[${cov.deps.join(', ')}]), \`wasm\` is exactly \`${WASM_BUILD_COMMAND}\`, and \`coverage\` self-asserts the artifact exists`,
  };
}

// ---------------------------------------------------------------------------
// C2 — totality, JOB-SCOPED and ORDERED
//
// The rule, stated exactly:
//   For every `just X` invocation at line index L in job J of ci.yml or nightly.yml:
//   if closure(X) intersects the client-loading roster, then EITHER `wasm` is
//   reachable as a PRIOR in closure(X), OR job J contains a non-comment line whose
//   TRIMMED form is exactly `- run: just wasm` at an index < L.
//
// WHY THE SECOND DISJUNCT IS NOT A LOOPHOLE. A closure-only rule would be WRONG and
// would RED a correct configuration: ci.yml does NOT run `just ci` — it runs each verb
// as its own step (`- run: just wasm` at ci.yml:76, then `- run: just client-typecheck`
// :78 and `- run: just client-test` :79). Those two recipes carry no `wasm` dependency
// and are CORRECT, because an earlier step in the SAME job already built the pkg. The
// ordering (`< L`) and the job scoping are both load-bearing: the same step moved below,
// or living in a different job, provisions nothing.
//
// `evaluateObligations` is the pure rule with NO floors, so fixtures can drive the rule
// itself; `checkC2` is the rule PLUS the anti-vacuity floors, and is what the ledger calls.
// ---------------------------------------------------------------------------
export function evaluateObligations(recipes, workflows) {
  try {
    const roster = deriveRoster(recipes);
    const rosterSet = {};
    for (const name of roster) rosterSet[name] = true;

    let checked = 0;
    const satisfied = [];
    for (const key of ['ci', 'nightly']) {
      const wf = workflows[key];
      if (wf === undefined || typeof wf.text !== 'string') {
        return {
          ok: false,
          reason: `C2: workflow input '${key}' is missing or has no \`text\` (fail closed)`,
          checked,
        };
      }
      const entryPoints = findJustEntryPoints(wf.text, recipes);
      const provisions = wasmProvisionLinesByJob(wf.text);
      for (const ep of entryPoints) {
        const closure = fullClosure(recipes, ep.recipe);
        let touchesClient = false;
        let via = '';
        for (const member of closure) {
          if (rosterSet[member] === true) {
            touchesClient = true;
            via = member;
            break;
          }
        }
        if (!touchesClient) continue;
        checked++;
        const priors = priorClosure(recipes, ep.recipe);
        if (priors.indexOf('wasm') !== -1) {
          satisfied.push(`${key}/${ep.job}:${ep.recipe}=dep`);
          continue;
        }
        const jobKey = ep.job === null ? '<none>' : ep.job;
        const lines = Object.hasOwn(provisions, jobKey) ? provisions[jobKey] : [];
        let earlier = -1;
        for (const idx of lines) {
          if (idx < ep.lineIndex) {
            earlier = idx;
            break;
          }
        }
        if (earlier === -1) {
          return {
            ok: false,
            reason: `C2: ${key} job '${jobKey}' invokes \`just ${ep.recipe}\` at line ${ep.lineIndex + 1}, whose dependency closure reaches the client-loading recipe '${via}' (it runs one of ${ROSTER_MARKERS.join(' / ')}), but \`wasm\` is NOT a prior in that closure (priors reachable: [${priors.join(', ')}]) AND job '${jobKey}' has no non-comment line reading exactly \`${WASM_PROVISION_STEP}\` before line ${ep.lineIndex + 1}${lines.length > 0 ? ` (it has one at line ${lines[0] + 1}, which is TOO LATE)` : ''}. Without a prebuilt client-wasm/pkg, main.ts's import fails to RESOLVE and the run reds for the wrong reason.`,
            checked,
          };
        }
        satisfied.push(`${key}/${jobKey}:${ep.recipe}=step@${earlier + 1}`);
      }
    }
    return {
      ok: true,
      reason: `C2: ${checked} client-loading obligation(s) all satisfied — ${satisfied.join(', ')}`,
      checked,
    };
  } catch (err) {
    return { ok: false, reason: `C2 failed closed: ${err.message}`, checked: 0 };
  }
}

export function checkC2(recipes, workflows) {
  let roster;
  try {
    roster = deriveRoster(recipes);
  } catch (err) {
    return {
      ok: false,
      reason: `C2 failed closed deriving the roster: ${err.message}`,
      checked: 0,
    };
  }
  for (const required of ROSTER_FLOOR) {
    if (roster.indexOf(required) === -1) {
      return {
        ok: false,
        reason: `C2 ANTI-VACUITY FLOOR: the vitest/typecheck matcher has rotted — '${required}' is no longer on the derived client-loading roster (derived: [${roster.join(', ')}]; markers: ${ROSTER_MARKERS.join(' / ')}). An empty or shrunken roster makes the totality loop pass over nothing.`,
        checked: 0,
      };
    }
  }
  const floors = [
    { key: 'nightly', names: NIGHTLY_ENTRY_FLOOR },
    { key: 'ci', names: CI_ENTRY_FLOOR },
  ];
  for (const floor of floors) {
    const wf = workflows[floor.key];
    if (wf === undefined || typeof wf.text !== 'string') {
      return {
        ok: false,
        reason: `C2: workflow input '${floor.key}' is missing or has no \`text\` (fail closed)`,
        checked: 0,
      };
    }
    let eps;
    try {
      eps = findJustEntryPoints(wf.text, recipes);
    } catch (err) {
      return {
        ok: false,
        reason: `C2 failed closed scanning ${floor.key}: ${err.message}`,
        checked: 0,
      };
    }
    const seen = {};
    for (const ep of eps) seen[ep.recipe] = true;
    for (const required of floor.names) {
      if (seen[required] !== true) {
        return {
          ok: false,
          reason: `C2 ANTI-VACUITY FLOOR: entry-point discovery rotted — no \`just ${required}\` invocation was found in ${floor.key}.yml (found: [${Object.keys(seen).sort().join(', ')}]). Zero or missing entry points make the totality loop vacuous.`,
          checked: 0,
        };
      }
    }
  }
  const res = evaluateObligations(recipes, workflows);
  if (!res.ok) return res;
  if (res.checked < MIN_OBLIGATIONS_CHECKED) {
    return {
      ok: false,
      reason: `C2 ANTI-VACUITY FLOOR: only ${res.checked} obligation(s) were actually evaluated, floor is ${MIN_OBLIGATIONS_CHECKED} — a totality rule that inspects almost nothing proves almost nothing.`,
      checked: res.checked,
    };
  }
  return res;
}

// ---------------------------------------------------------------------------
// C3 — the nightly `coverage` JOB BLOCK is actually provisioned
//
// A WHOLE-FILE SCAN IS VACUOUSLY GREEN ON MASTER TODAY: `jetli/wasm-pack-action`
// already appears at nightly.yml:265, inside the `a11y-e2e` job. So the block must be
// EXTRACTED, and it is extracted with the hardened `strictJobBlock`.
// ---------------------------------------------------------------------------

function usesRefOf(trimmedLine) {
  const kv = parseKeyLine(trimmedLine);
  if (kv === null || kv.key !== 'uses') return null;
  // ` # v0.4.0` version comments ride on every pinned action in this repo.
  const value = stripInlineComment(kv.value).trim();
  return value === '' ? null : value;
}

// ANCHORED under a 0-indent `jobs:` key, mirroring strictJobBlock. Counting job-key
// lines file-wide would report a decoy `  coverage:` parked inside a top-level block
// scalar as a "duplicate", which is the WRONG diagnosis (and would mask the real
// anchoring bug behind a plausible-sounding one).
function jobsAnchorIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (indentOf(line) !== 0) continue;
    const trimmed = line.trim();
    if (trimmed === 'jobs:' || trimmed.indexOf('jobs:') === 0) return i;
  }
  return -1;
}

function countJobKey(yamlText, jobName) {
  const lines = String(yamlText).split('\n');
  const anchor = jobsAnchorIndex(lines);
  if (anchor === -1) return 0;
  const target = `  ${jobName}:`;
  let count = 0;
  for (let i = anchor + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === target || line.indexOf(`${target} `) === 0) count++;
  }
  return count;
}

export function checkC3(workflows) {
  const wf = workflows === null || workflows === undefined ? undefined : workflows.nightly;
  if (wf === undefined || typeof wf.text !== 'string' || wf.text.trim() === '') {
    return { ok: false, reason: 'C3: no nightly workflow text was supplied (fail closed)' };
  }
  const yaml = wf.text;

  // Last-key-wins FIRST: GitHub Actions takes the LAST `coverage:` key, while every
  // block extractor returns the FIRST — so a clean first block plus a neutered second
  // is a real, executable bypass of everything below.
  const dupes = countJobKey(yaml, 'coverage');
  if (dupes > 1) {
    return {
      ok: false,
      reason: `C3: nightly.yml declares the \`coverage:\` job key ${dupes} times at 2-space indent. GitHub Actions is last-key-wins and strictJobBlock returns the FIRST block, so a clean first definition would mask a neutered second.`,
    };
  }

  const block = strictJobBlock(yaml, 'coverage');
  if (block === '' || block.trim() === '') {
    return {
      ok: false,
      reason:
        'C3: nightly.yml has no `coverage:` job block under `jobs:` — an empty or absent block fails closed, it never passes vacuously.',
    };
  }
  const blockLines = block.split('\n');

  let stepsIdx = -1;
  for (let i = 0; i < blockLines.length; i++) {
    if (isCommentLine(blockLines[i])) continue;
    const kv = parseKeyLine(blockLines[i].trim());
    if (kv !== null && kv.key === 'steps') {
      stepsIdx = i;
      break;
    }
  }
  if (stepsIdx === -1) {
    return { ok: false, reason: 'C3: the nightly `coverage:` job block declares no `steps:` key' };
  }

  let stepIndent = -1;
  for (let i = stepsIdx + 1; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (line.trim() === '' || isCommentLine(line)) continue;
    if (line.trim().indexOf('- ') === 0) {
      stepIndent = indentOf(line);
      break;
    }
  }
  if (stepIndent === -1) {
    return {
      ok: false,
      reason: 'C3: the nightly `coverage:` job declares `steps:` but has no steps',
    };
  }

  const stepStarts = [];
  for (let i = stepsIdx + 1; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (line.trim() === '' || isCommentLine(line)) continue;
    if (indentOf(line) === stepIndent && line.trim().indexOf('- ') === 0) stepStarts.push(i);
  }
  if (stepStarts.length === 0) {
    return { ok: false, reason: 'C3: the nightly `coverage:` job has no step items' };
  }
  const steps = [];
  for (let s = 0; s < stepStarts.length; s++) {
    const start = stepStarts[s];
    const end = s + 1 < stepStarts.length ? stepStarts[s + 1] : blockLines.length;
    steps.push({ start, end });
  }

  // The gate step. Exact trimmed match: `- run: just coverage || true` is not a gate.
  let gateIdx = -1;
  for (let i = 0; i < blockLines.length; i++) {
    if (isCommentLine(blockLines[i])) continue;
    if (blockLines[i].trim() === COVERAGE_GATE_STEP) {
      gateIdx = i;
      break;
    }
  }
  if (gateIdx === -1) {
    return {
      ok: false,
      reason: `C3: the nightly \`coverage:\` job has no non-comment line reading exactly \`${COVERAGE_GATE_STEP}\` — there is nothing for the provisioning steps to come before.`,
    };
  }

  // F9/F3: C3 previously asserted "provisioning happens before the gate" while never
  // checking that the gate itself is armed. A step-level `if:`/`continue-on-error:` is
  // caught by the sibling jobIsNotNeutered, but relying on that makes this criterion
  // depend on another eval staying wired; and a step-level `env:` (which no eval checked)
  // can pair with an env-guarded build to skip it entirely with everything green.
  let gateStep = null;
  for (const step of steps) {
    if (gateIdx >= step.start && gateIdx < step.end) {
      gateStep = step;
      break;
    }
  }
  if (gateStep !== null) {
    for (let i = gateStep.start; i < gateStep.end; i++) {
      if (isCommentLine(blockLines[i])) continue;
      const tr = stripInlineComment(blockLines[i]).trim();
      if (tr.indexOf('if:') === 0) {
        return {
          ok: false,
          reason: `C3: the nightly \`coverage:\` gate step carries \`${tr}\` — a conditional gate step is a gate that can decline to run.`,
        };
      }
      if (tr.indexOf('continue-on-error:') === 0 && tr !== 'continue-on-error: false') {
        return {
          ok: false,
          reason: `C3: the nightly \`coverage:\` gate step carries \`${tr}\` — only the literal \`false\` is admitted; a soft-failing coverage gate is a toothless one.`,
        };
      }
      if (tr.indexOf('env:') === 0) {
        return {
          ok: false,
          reason:
            'C3: the nightly `coverage:` gate step carries a step-level `env:` mapping. Measured bypass: `WASM_PKG_PREBUILT: 1` on this step plus an env-guarded `wasm` recipe skips the build with every other criterion still green. If a variable is genuinely needed here, gate it explicitly rather than removing this clause.',
        };
      }
    }
  }

  // F8: job-level keys that make the job never run. jobIsNotNeutered bans `if:`,
  // `continue-on-error:` and `defaults:` but not these — a `needs:` on a flaky sibling
  // silently SKIPS the coverage job on exactly the nights that sibling reds.
  for (const line of blockLines) {
    if (isCommentLine(line)) continue;
    if (indentOf(line) !== stepIndent - 2) continue;
    const tr = stripInlineComment(line).trim();
    if (tr.indexOf('needs:') === 0) {
      return {
        ok: false,
        reason: `C3: the nightly \`coverage:\` job declares \`${tr}\` — a job-level \`needs:\` makes the coverage gate SKIP entirely whenever the named job fails, which is silently indistinguishable from passing.`,
      };
    }
    if (tr.indexOf('strategy:') === 0) {
      return {
        ok: false,
        reason: `C3: the nightly \`coverage:\` job declares \`${tr}\` — a matrix strategy may expand to ZERO job instances, declaring the gate without ever running it.`,
      };
    }
  }

  const required = [
    {
      label: 'wasm-pack',
      ref: WASM_PACK_ACTION_REF,
      withLiteral: WASM_PACK_VERSION_LITERAL,
      why: 'without wasm-pack on the runner, `just wasm` dies with `wasm-pack: command not found` and the justfile dependency is unsatisfiable',
    },
    {
      label: 'rust-toolchain',
      ref: RUST_TOOLCHAIN_ACTION_REF,
      withLiteral: WASM_TARGET_LITERAL,
      why: 'this matches every sibling job that builds wasm and is a belt against rust-toolchain.toml losing its `targets` list (that file, not this input, is what normally supplies the target)',
    },
  ];

  const foundAt = {};
  for (const req of required) {
    let match = null;
    for (const step of steps) {
      const headLine = blockLines[step.start];
      if (isCommentLine(headLine)) continue;
      // EQUALITY, not indexOf: `…0d096b08…e9eefa-fork` must FAIL, and an indexOf on
      // the pinned SHA would happily accept it.
      if (usesRefOf(headLine.trim()) !== req.ref) continue;
      match = step;
      break;
    }
    if (match === null) {
      return {
        ok: false,
        reason: `C3: the nightly \`coverage:\` job block has no \`uses:\` step whose action reference is EXACTLY \`${req.ref}\` (a commented-out step, or a SHA with any suffix, does not count) — ${req.why}. NOTE: this action already appears elsewhere in nightly.yml (the a11y-e2e job), which is exactly why a whole-file scan would be vacuously green here.`,
      };
    }
    let hasLiteral = false;
    for (let i = match.start; i < match.end; i++) {
      if (isCommentLine(blockLines[i])) continue;
      // F7: only WHOLE-line comments were skipped here, so
      // `with: { version: 'v0.2.0' } # version: 'v0.15.0'` laundered a downgrade past
      // the pin. Strip the trailing comment before looking for the literal.
      if (stripInlineComment(blockLines[i]).indexOf(req.withLiteral) !== -1) {
        hasLiteral = true;
        break;
      }
    }
    if (!hasLiteral) {
      return {
        ok: false,
        reason: `C3: the nightly \`coverage:\` job's \`${req.ref}\` step does not carry \`${req.withLiteral}\` in its own line range (lines ${match.start + 1}-${match.end} of the coverage block) — ${req.why}.`,
      };
    }
    // Neuter check, scoped to this step's range only.
    for (let i = match.start; i < match.end; i++) {
      const line = blockLines[i];
      if (isCommentLine(line)) continue;
      const kv = parseKeyLine(line.trim());
      if (kv === null) continue;
      if (kv.key === 'if') {
        return {
          ok: false,
          reason: `C3: the nightly \`coverage:\` job's ${req.label} provisioning step carries a step-level \`if: ${kv.value}\` — a conditional provisioning step provisions conditionally, i.e. not at all on the nights it matters.`,
        };
      }
      if (kv.key === 'continue-on-error') {
        // VALUE allowlist, not a truthiness blacklist: `${{ !cancelled() }}` and
        // `${{ success() || true }}` are both unconditionally true in a real run and
        // both defeat a blacklist. Only the literal `false` (or no key) is admitted.
        if (kv.value !== 'false') {
          return {
            ok: false,
            reason: `C3: the nightly \`coverage:\` job's ${req.label} provisioning step carries \`continue-on-error: ${kv.value}\` — only the literal \`false\` (or no key at all) is admitted; a soft-failing provisioning step lets \`just coverage\` run against a missing pkg anyway.`,
          };
        }
      }
    }
    foundAt[req.label] = match.start;
  }

  for (const req of required) {
    if (foundAt[req.label] >= gateIdx) {
      return {
        ok: false,
        reason: `C3: the nightly \`coverage:\` job's ${req.label} step is at block line ${foundAt[req.label] + 1}, at or AFTER the \`${COVERAGE_GATE_STEP}\` step at block line ${gateIdx + 1}. GitHub Actions runs steps in order — provisioning after the gate provisions nothing.`,
      };
    }
  }

  return {
    ok: true,
    reason: `C3: the nightly \`coverage:\` job block provisions ${RUST_TOOLCHAIN_ACTION_REF} (${WASM_TARGET_LITERAL}) at block line ${foundAt['rust-toolchain'] + 1} and ${WASM_PACK_ACTION_REF} (${WASM_PACK_VERSION_LITERAL}) at block line ${foundAt['wasm-pack'] + 1}, both unneutered and both before \`${COVERAGE_GATE_STEP}\` at block line ${gateIdx + 1}`,
  };
}

// ===========================================================================
// PROOF OF TEETH — in-file constants only, the real files are NEVER mutated.
// ===========================================================================

// Every fixture mutation must actually apply. A first-occurrence `.replace()` that
// silently no-ops reads as "the gate accepted the cheat" — this has burned this repo
// before, so the no-op is a hard error, not a quiet pass.
// Deliberately indexOf/slice rather than String.replace: a replacement string
// containing `$&`, `$'` or a `${{ … }}` GitHub expression is REWRITTEN by
// String.replace's substitution grammar, which would silently produce a fixture
// other than the one written here.
function mut(base, from, to, label) {
  const at = base.indexOf(from);
  if (at === -1) {
    throw new Error(
      `fixture mutation '${label}' did NOT apply — the search text was not found, so this tooth would have re-tested the base fixture and reported a false bite`,
    );
  }
  const out = base.slice(0, at) + to + base.slice(at + from.length);
  if (out === base) {
    throw new Error(
      `fixture mutation '${label}' was a no-op (replacement equals the original text)`,
    );
  }
  return out;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ---- C1 fixtures: raw `just --dump` payload shapes -------------------------

const RAW_DUMP_GOOD = {
  recipes: {
    coverage: {
      name: 'coverage',
      priors: 1,
      dependencies: [{ recipe: 'wasm', arguments: [] }],
      body: [
        ['test -f client-wasm/pkg/client_wasm.js'],
        ['cd client && npm ci && npx vitest run --coverage --coverage.thresholds.lines=96'],
      ],
    },
    wasm: {
      name: 'wasm',
      priors: 0,
      dependencies: [],
      body: [['wasm-pack build client-wasm --target bundler']],
    },
  },
};

// ---- C2 fixtures -----------------------------------------------------------

const SYN_RECIPES = {
  lint: { name: 'lint', deps: [], priors: 0, body: 'cargo fmt --all --check' },
  typecheck: { name: 'typecheck', deps: [], priors: 0, body: 'cargo check --workspace' },
  test: {
    name: 'test',
    deps: [],
    priors: 0,
    // Deliberately shaped like the real `test:` recipe, which runs `node --test` and
    // must NOT false-positive onto the roster.
    body: '#!/usr/bin/env bash\ncargo nextest run --workspace\nnode --test ops/observability/validate.test.mjs',
  },
  eval: { name: 'eval', deps: [], priors: 0, body: 'node evals/run.mjs\njust perf-budget' },
  wasm: { name: 'wasm', deps: [], priors: 0, body: 'wasm-pack build client-wasm --target bundler' },
  'client-typecheck': {
    name: 'client-typecheck',
    deps: [],
    priors: 0,
    body: 'cd client && npm run typecheck',
  },
  'client-test': { name: 'client-test', deps: [], priors: 0, body: 'cd client && npm test' },
  'observability-validate': {
    name: 'observability-validate',
    deps: [],
    priors: 0,
    body: 'node ops/observability/validate.mjs --require-docker',
  },
  e2e: { name: 'e2e', deps: ['wasm'], priors: 1, body: 'cd client && npm run e2e' },
  'mutate-core': { name: 'mutate-core', deps: [], priors: 0, body: 'cargo mutants -p game-core' },
  'mutate-server': {
    name: 'mutate-server',
    deps: [],
    priors: 0,
    body: 'cargo mutants -p monster-realm-module --test-tool nextest',
  },
  coverage: {
    name: 'coverage',
    deps: ['wasm'],
    priors: 1,
    body: 'cd client && npx vitest run --coverage',
  },
  'smoke-republish': {
    name: 'smoke-republish',
    deps: [],
    priors: 0,
    body: 'bash scripts/smoke-republish.sh',
  },
  'a11y-e2e': {
    name: 'a11y-e2e',
    deps: ['wasm'],
    priors: 1,
    body: 'cd client && npx vitest run --reporter=json src/ui/overlayA11yWiring.test.ts',
  },
};

const SYN_CI = `name: CI
on:
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6 # v6
      - uses: extractions/setup-just@dd310ad5a97d8e7b41793f8ef055398d51ad4de6 # v2
      - run: just lint
      - run: just typecheck
      - run: just test
      - run: just eval
      - run: just wasm
      - run: just client-typecheck
      - run: just client-test
      - run: just observability-validate
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6 # v6
      - run: just e2e
`;

const SYN_NIGHTLY = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-server
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: extractions/setup-just@dd310ad5a97d8e7b41793f8ef055398d51ad4de6 # v2
      - run: just coverage
  smoke-republish:
    runs-on: ubuntu-latest
    steps:
      - run: just smoke-republish
  a11y-e2e:
    runs-on: ubuntu-latest
    steps:
      - run: just a11y-e2e
`;

const SYN_WF = {
  ci: { file: 'ci.yml', text: SYN_CI },
  nightly: { file: 'nightly.yml', text: SYN_NIGHTLY },
};

// Minimal, floor-free fixtures for the ORDERING half of the C2 rule.
const MINI_RECIPES = {
  wasm: { name: 'wasm', deps: [], priors: 0, body: 'wasm-pack build client-wasm --target bundler' },
  coverage: {
    name: 'coverage',
    deps: [],
    priors: 0,
    body: 'cd client && npx vitest run --coverage',
  },
  'client-test': { name: 'client-test', deps: [], priors: 0, body: 'cd client && npm test' },
};

const MINI_EMPTY_WF = `name: Empty
jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: echo nothing
`;

const MINI_NIGHTLY_COVERAGE = `name: Nightly
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6 # v6
      - run: just coverage
`;

const MINI_CI_ORDERED = `name: CI
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6 # v6
      - run: just wasm
      - run: just client-test
`;

// ---- C3 fixtures -----------------------------------------------------------

const C3_GOOD = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
jobs:
  a11y-e2e:
    runs-on: ubuntu-latest
    steps:
      # This job ALREADY carries wasm-pack on master. It is present in the fixture on
      # purpose: it is why a whole-file scan for the action ref is vacuously green.
      - uses: jetli/wasm-pack-action@0d096b08b4e5a7de8c28de67e11e945404e9eefa # v0.4.0
        with: { version: 'v0.15.0' }
      - run: just a11y-e2e

  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6 # v6
      - uses: dtolnay/rust-toolchain@stable # stable
        with: { targets: wasm32-unknown-unknown }
      - uses: Swatinem/rust-cache@v2 # v2
        with: { prefix-key: v1-coverage }
      - uses: jetli/wasm-pack-action@0d096b08b4e5a7de8c28de67e11e945404e9eefa # v0.4.0
        with: { version: 'v0.15.0' }
      - uses: actions/setup-node@v7 # v7
        with:
          node-version: '24.13.1'
          cache: npm
          cache-dependency-path: client/package-lock.json
      - uses: extractions/setup-just@dd310ad5a97d8e7b41793f8ef055398d51ad4de6 # v2
      - run: just coverage
`;

// The CURRENT (unprovisioned) master shape of the coverage job, for the "no wasm-pack
// anywhere in the block" tooth.
const C3_STEP_TOOLCHAIN = `      - uses: dtolnay/rust-toolchain@stable # stable
        with: { targets: wasm32-unknown-unknown }
`;
const C3_STEP_WASMPACK = `      - uses: jetli/wasm-pack-action@0d096b08b4e5a7de8c28de67e11e945404e9eefa # v0.4.0
        with: { version: 'v0.15.0' }
`;

// The coverage-block copy of the wasm-pack step (the SECOND occurrence in C3_GOOD).
function replaceCoverageWasmPack(base, replacement, label) {
  const first = base.indexOf(C3_STEP_WASMPACK);
  if (first === -1) throw new Error(`fixture '${label}': wasm-pack step shape not found at all`);
  const second = base.indexOf(C3_STEP_WASMPACK, first + 1);
  if (second === -1) {
    throw new Error(
      `fixture '${label}': expected TWO wasm-pack step occurrences (a11y-e2e + coverage) — a first-occurrence replace here would silently target the wrong job`,
    );
  }
  const out = base.slice(0, second) + replacement + base.slice(second + C3_STEP_WASMPACK.length);
  if (out === base) {
    throw new Error(`fixture mutation '${label}' did NOT apply`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// runTeeth
// ---------------------------------------------------------------------------

export function runTeeth() {
  const details = [];
  let failed = 0;

  function record(id, criterion, expectAccept, kills, fn) {
    let got;
    let err = null;
    try {
      got = fn();
    } catch (e) {
      err = e;
    }
    if (err !== null) {
      failed++;
      details.push({
        id,
        criterion,
        ok: false,
        kills,
        note: `tooth threw: ${err.message}`,
      });
      return;
    }
    const bit = got.ok === expectAccept;
    if (!bit) failed++;
    details.push({
      id,
      criterion,
      ok: bit,
      kills,
      note: bit
        ? `${expectAccept ? 'accepted' : 'rejected'} as expected`
        : `EXPECTED ${expectAccept ? 'ACCEPT' : 'REJECT'} but predicate returned ok=${got.ok}: ${got.reason}`,
    });
  }

  // ======================= C1 =======================

  record(
    'C1-1',
    'C1',
    true,
    'a predicate that never accepts anything (an always-red gate proves nothing)',
    () => checkC1(normalizeRecipes(clone(RAW_DUMP_GOOD), 'fixture')),
  );

  record('C1-2', 'C1', false, "today's master: `coverage:` with no dependency at all", () => {
    const d = clone(RAW_DUMP_GOOD);
    d.recipes.coverage.dependencies = [];
    d.recipes.coverage.priors = 0;
    return checkC1(normalizeRecipes(d, 'fixture'));
  });

  record(
    'C1-3',
    'C1',
    false,
    'THE MEASURED BYPASS: `coverage: && wasm` — a SUBSEQUENT dependency whose `dependencies` array is byte-identical to the honest form. Only `priors` tells them apart; an impl that checks `deps.includes("wasm")` accepts it and the body still runs first.',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      d.recipes.coverage.priors = 0; // dependencies array left byte-identical
      return checkC1(normalizeRecipes(d, 'fixture'));
    },
  );

  record(
    'C1-4',
    'C1',
    true,
    'an over-strict normalizer that only understands the {recipe, arguments} object form and rejects the bare-string form older `just` releases emit (version tolerance)',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      d.recipes.coverage.dependencies = ['wasm'];
      return checkC1(normalizeRecipes(d, 'fixture'));
    },
  );

  record(
    'C1-5',
    'C1',
    false,
    'gutting `wasm:` to `echo skip` — the dependency edge is intact, everything downstream stays green, and no pkg is ever built',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      d.recipes.wasm.body = [['echo skip']];
      return checkC1(normalizeRecipes(d, 'fixture'));
    },
  );

  // --- Teeth for the bypasses the red-team MEASURED green against the first
  // --- (containment-based) version of C1. Each was an executed, CI-clean cheat.

  record(
    'C1-5b',
    'C1',
    false,
    'RED-TEAM F1: `coverage: (wasm "prebuilt")` against a parameterized `wasm mode="build":`. Once dependency ARGUMENTS are discarded the dump is byte-identical to the honest wiring, and the recipe branches to a no-op for this caller alone while `just wasm`, `e2e` and `a11y-e2e` all still build. Measured 15/15 evals green.',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      d.recipes.coverage.dependencies = [{ recipe: 'wasm', arguments: ['prebuilt'] }];
      return checkC1(normalizeRecipes(d, 'fixture'));
    },
  );

  record(
    'C1-5c',
    'C1',
    false,
    'RED-TEAM F2: a just-conditional `wasm` body. `just --dump` emits BOTH branches as sibling literals, so the build command is PRESENT in the body text while the branch that executes is the other one. No text oracle over the dump can be sound against this; only rejecting non-literal fragments is.',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      d.recipes.wasm.body = [
        [{ if: true }, 'echo cached', 'wasm-pack build client-wasm --target bundler'],
      ];
      return checkC1(normalizeRecipes(d, 'fixture'));
    },
  );

  record(
    'C1-5d',
    'C1',
    false,
    'RED-TEAM F4: a one-character `-` ignore-failure prefix. `just` swallows the build failure, vitest runs against no pkg, and the dump text still contains the marker — the EXACT original incident shape, restored, as a diff that survives review.',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      d.recipes.wasm.body = [['-wasm-pack build client-wasm --target bundler']];
      return checkC1(normalizeRecipes(d, 'fixture'));
    },
  );

  record(
    'C1-5e',
    'C1',
    false,
    'RED-TEAM F5: a `#!/bin/true` shebang neuters the recipe while every body line survives verbatim in the dump (comment stripping deliberately preserves shebangs, which is what made this work).',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      d.recipes.wasm.shebang = true;
      d.recipes.wasm.body = [['#!/bin/true'], ['wasm-pack build client-wasm --target bundler']];
      return checkC1(normalizeRecipes(d, 'fixture'));
    },
  );

  record(
    'C1-5f',
    'C1',
    false,
    'RED-TEAM F6: `--out-dir pkg-dist` builds successfully but writes where main.ts does not import from. The marker is a command PREFIX, so containment accepts it; `--out-name` is the same hole.',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      d.recipes.wasm.body = [['wasm-pack build client-wasm --target bundler --out-dir pkg-dist']];
      return checkC1(normalizeRecipes(d, 'fixture'));
    },
  );

  record(
    'C1-5g',
    'C1',
    false,
    'RED-TEAM F1 (second half): a parameterized `wasm` is rejected even with an unparameterized edge — the parameter is the mechanism, so it is banned at the source.',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      d.recipes.wasm.parameters = [{ name: 'mode' }];
      return checkC1(normalizeRecipes(d, 'fixture'));
    },
  );

  record(
    'C1-5h',
    'C1',
    false,
    'RED-TEAM F3 backstop: dropping the `test -f client-wasm/pkg/client_wasm.js` self-assertion from the `coverage` recipe. That runtime check is the only clause immune to a forged recipe graph; removing it must RED.',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      d.recipes.coverage.body = [
        ['cd client && npm ci && npx vitest run --coverage --coverage.thresholds.lines=96'],
      ];
      return checkC1(normalizeRecipes(d, 'fixture'));
    },
  );

  record(
    'C1-6',
    'C1',
    false,
    'a missing `coverage` key read as "nothing to check" (silent pass)',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      delete d.recipes.coverage;
      return checkC1(normalizeRecipes(d, 'fixture'));
    },
  );

  record('C1-7', 'C1', false, 'a missing `wasm` key read as "nothing to check"', () => {
    const d = clone(RAW_DUMP_GOOD);
    delete d.recipes.wasm;
    d.recipes.coverage.dependencies = [];
    d.recipes.coverage.priors = 0;
    return checkC1(normalizeRecipes(d, 'fixture'));
  });

  record(
    'C1-8',
    'C1',
    false,
    'a normalizer that coerces garbage: a dependency entry of `42` must FAIL LOUDLY, never be silently dropped (a dropped dep is an invisible edge)',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      d.recipes.coverage.dependencies = [42];
      try {
        return checkC1(normalizeRecipes(d, 'fixture'));
      } catch (e) {
        return { ok: false, reason: `normalizer threw as required: ${e.message}` };
      }
    },
  );

  record(
    'C1-9',
    'C1',
    false,
    'a `just` version that emits no `priors` field: without it the `&&` bypass is undetectable, so the ingest must fail closed rather than assume 0 or assume all-prior',
    () => {
      const d = clone(RAW_DUMP_GOOD);
      delete d.recipes.coverage.priors;
      try {
        return checkC1(normalizeRecipes(d, 'fixture'));
      } catch (e) {
        return { ok: false, reason: `normalizer threw as required: ${e.message}` };
      }
    },
  );

  record('C1-10', 'C1', false, 'an empty `recipes` map read as a vacuous pass', () => {
    try {
      return checkC1(normalizeRecipes({ recipes: {} }, 'fixture'));
    } catch (e) {
      return { ok: false, reason: `normalizer threw as required: ${e.message}` };
    }
  });

  // ======================= C2 =======================

  record(
    'C2-1',
    'C2',
    true,
    'a C2 that can only reject — proves the FIXED configuration is actually accepted, floors and all',
    () => checkC2(clone(SYN_RECIPES), SYN_WF),
  );

  record(
    'C2-2',
    'C2',
    false,
    "today's master via the full floor-checked path: nightly `coverage` job, no justfile dep, no earlier wasm step",
    () => {
      const r = clone(SYN_RECIPES);
      r.coverage.deps = [];
      r.coverage.priors = 0;
      return checkC2(r, SYN_WF);
    },
  );

  record(
    'C2-3',
    'C2',
    false,
    'the ORDERING half in isolation: a nightly-shaped coverage job with neither a dep nor any wasm step',
    () =>
      evaluateObligations(clone(MINI_RECIPES), {
        ci: { text: MINI_EMPTY_WF },
        nightly: { text: MINI_NIGHTLY_COVERAGE },
      }),
  );

  record(
    'C2-4',
    'C2',
    true,
    'A CLOSURE-ONLY RULE. ci.yml does NOT run `just ci`; it runs each verb as its own step, and `client-test` legitimately carries no wasm dep because `- run: just wasm` ran earlier in the SAME job. Without this tooth the predicate would be WRONG, not strict.',
    () =>
      evaluateObligations(clone(MINI_RECIPES), {
        ci: { text: MINI_CI_ORDERED },
        nightly: { text: MINI_EMPTY_WF },
      }),
  );

  record(
    'C2-5',
    'C2',
    false,
    'an ORDER-BLIND rule: the same `- run: just wasm` step moved BELOW the consumer provisions nothing',
    () => {
      const moved = mut(
        MINI_CI_ORDERED,
        '      - run: just wasm\n      - run: just client-test\n',
        '      - run: just client-test\n      - run: just wasm\n',
        'C2-5 move wasm below',
      );
      return evaluateObligations(clone(MINI_RECIPES), {
        ci: { text: moved },
        nightly: { text: MINI_EMPTY_WF },
      });
    },
  );

  record(
    'C2-6',
    'C2',
    false,
    'a COMMENT-BLIND rule: `# - run: just wasm` is documentation, not provisioning',
    () => {
      const commented = mut(
        MINI_CI_ORDERED,
        '      - run: just wasm\n',
        '      # - run: just wasm\n',
        'C2-6 comment out wasm',
      );
      return evaluateObligations(clone(MINI_RECIPES), {
        ci: { text: commented },
        nightly: { text: MINI_EMPTY_WF },
      });
    },
  );

  record(
    'C2-7',
    'C2',
    false,
    'a SUBSTRING rule: `- run: just wasm || true` cannot fail, so it cannot guarantee a pkg — only an EXACT trimmed line counts',
    () => {
      const suffixed = mut(
        MINI_CI_ORDERED,
        '      - run: just wasm\n',
        '      - run: just wasm || true\n',
        'C2-7 suffix wasm step',
      );
      return evaluateObligations(clone(MINI_RECIPES), {
        ci: { text: suffixed },
        nightly: { text: MINI_EMPTY_WF },
      });
    },
  );

  record(
    'C2-8',
    'C2',
    false,
    'a JOB-BLIND rule: a `- run: just wasm` step in a DIFFERENT job runs on a different runner with a different filesystem',
    () => {
      const otherJob = mut(
        MINI_CI_ORDERED,
        '      - run: just wasm\n      - run: just client-test\n',
        '      - run: just client-test\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: just wasm\n',
        'C2-8 move wasm to another job',
      );
      return evaluateObligations(clone(MINI_RECIPES), {
        ci: { text: otherJob },
        nightly: { text: MINI_EMPTY_WF },
      });
    },
  );

  record(
    'C2-9',
    'C2',
    false,
    "ANTI-VACUITY: a rotted roster matcher. Blank `client-typecheck`'s body and the totality loop silently stops covering it — the floor is what notices.",
    () => {
      const r = clone(SYN_RECIPES);
      r['client-typecheck'].body = 'echo skip';
      return checkC2(r, SYN_WF);
    },
  );

  record(
    'C2-10',
    'C2',
    false,
    'ANTI-VACUITY: rotted entry-point discovery. Workflows with ZERO `just` invocations make the loop iterate over nothing and pass trivially.',
    () =>
      checkC2(clone(SYN_RECIPES), {
        ci: { text: MINI_EMPTY_WF },
        nightly: { text: MINI_EMPTY_WF },
      }),
  );

  record(
    'C2-11',
    'C2',
    false,
    'ANTI-VACUITY: a partially rotted nightly. Dropping the `just coverage` step from nightly.yml would make the coverage obligation disappear rather than fail.',
    () => {
      const gutted = mut(
        SYN_NIGHTLY,
        '      - run: just coverage\n',
        '      - run: echo coverage\n',
        'C2-11 drop the coverage entry point',
      );
      return checkC2(clone(SYN_RECIPES), {
        ci: { text: SYN_CI },
        nightly: { text: gutted },
      });
    },
  );

  record(
    'C2-12',
    'C2',
    false,
    'an unknown recipe name in the dependency graph read as "skip this edge" — an unresolvable closure means we do NOT know whether it reaches the roster',
    () => {
      const r = clone(MINI_RECIPES);
      r.coverage.deps = ['build-the-thing'];
      r.coverage.priors = 1;
      return evaluateObligations(r, {
        ci: { text: MINI_EMPTY_WF },
        nightly: { text: MINI_NIGHTLY_COVERAGE },
      });
    },
  );

  record(
    'C2-13',
    'C2',
    false,
    'a LINE-FORM entry-point matcher (`- run: just X`): here `just coverage` lives inside a `run: |` block, which such a matcher misses entirely — yielding ZERO obligations and a vacuous ACCEPT. It also kills a loose `indexOf("just")` tokenizer, since `extractions/setup-just@dd310ad…` is the only other `just`-shaped text present and names no recipe.',
    () => {
      const blockForm = mut(
        MINI_NIGHTLY_COVERAGE,
        '      - run: just coverage\n',
        '      - uses: extractions/setup-just@dd310ad5a97d8e7b41793f8ef055398d51ad4de6 # v2\n      - name: coverage\n        run: |\n          just coverage\n',
        'C2-13 move the invocation into a run: | block',
      );
      return evaluateObligations(clone(MINI_RECIPES), {
        ci: { text: MINI_EMPTY_WF },
        nightly: { text: blockForm },
      });
    },
  );

  // ======================= C3 =======================

  record('C3-1', 'C3', true, 'a C3 that can only reject (an always-red gate proves nothing)', () =>
    checkC3({ nightly: { text: C3_GOOD } }),
  );

  record(
    'C3-2b',
    'C3',
    false,
    "RED-TEAM F7: a version DOWNGRADE laundered through a trailing comment. Only whole-line comments were skipped, so `with: { version: 'v0.2.0' } # version: 'v0.15.0'` satisfied the pin while the runner installed a different wasm-pack. Measured 15/15 evals green.",
    () =>
      checkC3({
        nightly: {
          text: mut(
            C3_GOOD,
            "      - uses: jetli/wasm-pack-action@0d096b08b4e5a7de8c28de67e11e945404e9eefa # v0.4.0\n        with: { version: 'v0.15.0' }\n      - uses: actions/setup-node@v7",
            "      - uses: jetli/wasm-pack-action@0d096b08b4e5a7de8c28de67e11e945404e9eefa # v0.4.0\n        with: { version: 'v0.2.0' } # version: 'v0.15.0'\n      - uses: actions/setup-node@v7",
            'C3-2b trailing-comment version downgrade',
          ),
        },
      }),
  );

  record(
    'C3-2c',
    'C3',
    false,
    "RED-TEAM F3: a step-level `env:` on the gate step. Paired with an env-guarded `wasm` recipe it skips the build entirely; no eval in the repo looked at the gate step's env. Measured 15/15 evals green.",
    () =>
      checkC3({
        nightly: {
          text: mut(
            C3_GOOD,
            '      - run: just coverage\n',
            "      - run: just coverage\n        env:\n          WASM_PKG_PREBUILT: '1'\n",
            'C3-2c gate-step env',
          ),
        },
      }),
  );

  record(
    'C3-2d',
    'C3',
    false,
    'RED-TEAM F9: `if: false` on the GATE step itself. C3 asserted that provisioning precedes the gate while never checking the gate was armed; it was caught only by a SIBLING eval, so this criterion depended on that eval staying wired.',
    () =>
      checkC3({
        nightly: {
          text: mut(
            C3_GOOD,
            '      - run: just coverage\n',
            '      - run: just coverage\n        if: false\n',
            'C3-2d gate-step if:false',
          ),
        },
      }),
  );

  record(
    'C3-2e',
    'C3',
    false,
    'RED-TEAM F8: a job-level `needs:` on the coverage job. It SKIPS the gate on every night the named sibling reds — indistinguishable from passing. jobIsNotNeutered bans `if:`/`continue-on-error:`/`defaults:` but not `needs:`.',
    () =>
      checkC3({
        nightly: {
          text: mut(
            C3_GOOD,
            '  coverage:\n    runs-on: ubuntu-latest',
            '  coverage:\n    needs: [smoke-republish]\n    runs-on: ubuntu-latest',
            'C3-2e job-level needs',
          ),
        },
      }),
  );

  record(
    'C3-2f',
    'C3',
    false,
    'RED-TEAM F8 (matrix variant): a job-level `strategy:` may expand to ZERO job instances, declaring the gate without ever running it.',
    () =>
      checkC3({
        nightly: {
          text: mut(
            C3_GOOD,
            '  coverage:\n    runs-on: ubuntu-latest',
            '  coverage:\n    strategy: { matrix: { node: [] } }\n    runs-on: ubuntu-latest',
            'C3-2f job-level strategy',
          ),
        },
      }),
  );

  record(
    'C3-2',
    'C3',
    false,
    "THE VACUOUS WHOLE-FILE SCAN: delete the wasm-pack step from the COVERAGE job only. `jetli/wasm-pack-action` still appears in the file (a11y-e2e job) — an `indexOf` over the whole yaml stays green. This is today's master shape.",
    () => checkC3({ nightly: { text: replaceCoverageWasmPack(C3_GOOD, '', 'C3-2 delete') } }),
  );

  record(
    'C3-3',
    'C3',
    false,
    'a comment-blind block scan: the step commented out still reads as present to a raw substring search',
    () =>
      checkC3({
        nightly: {
          text: replaceCoverageWasmPack(
            C3_GOOD,
            `      # - uses: ${WASM_PACK_ACTION_REF} # v0.4.0\n      #   with: { version: 'v0.15.0' }\n`,
            'C3-3 comment out',
          ),
        },
      }),
  );

  record(
    'C3-4',
    'C3',
    false,
    'an `indexOf` on the pinned SHA: a `…e9eefa-fork` suffix points at a DIFFERENT repository and passes a containment test, but not an equality test',
    () =>
      checkC3({
        nightly: {
          text: replaceCoverageWasmPack(
            C3_GOOD,
            `      - uses: ${WASM_PACK_ACTION_REF}-fork # v0.4.0\n        with: { version: 'v0.15.0' }\n`,
            'C3-4 suffix the SHA',
          ),
        },
      }),
  );

  record(
    'C3-5',
    'C3',
    false,
    "an action-ref-only check: `version: 'v0.0.1'` installs a wasm-pack that cannot build this crate, while the pinned action ref is untouched",
    () =>
      checkC3({
        nightly: {
          text: replaceCoverageWasmPack(
            C3_GOOD,
            `      - uses: ${WASM_PACK_ACTION_REF} # v0.4.0\n        with: { version: 'v0.0.1' }\n`,
            'C3-5 wrong version',
          ),
        },
      }),
  );

  record(
    'C3-6',
    'C3',
    false,
    'a presence-only check: the wasm-pack step moved BELOW `- run: just coverage` provisions nothing (GitHub runs steps in order)',
    () => {
      // Take the step OUT of its place above the gate, then re-add it BELOW the gate.
      // Both halves are asserted to actually apply.
      const removed = replaceCoverageWasmPack(C3_GOOD, '', 'C3-6 lift the step out');
      const below = mut(
        removed,
        '      - run: just coverage\n',
        `      - run: just coverage\n${C3_STEP_WASMPACK}`,
        'C3-6 reinsert below the gate step',
      );
      return checkC3({ nightly: { text: below } });
    },
  );

  record(
    'C3-7',
    'C3',
    false,
    'a neuter-blind check: `if: false` on the provisioning step makes it a no-op while every presence assertion still holds',
    () =>
      checkC3({
        nightly: {
          text: replaceCoverageWasmPack(
            C3_GOOD,
            `      - uses: ${WASM_PACK_ACTION_REF} # v0.4.0\n        if: false\n        with: { version: 'v0.15.0' }\n`,
            'C3-7 if: false',
          ),
        },
      }),
  );

  record(
    'C3-8',
    'C3',
    false,
    'a truthiness BLACKLIST for continue-on-error: `${{ !cancelled() }}` is unconditionally true in a real run and defeats one. Only the literal `false` is admitted.',
    () =>
      checkC3({
        nightly: {
          text: replaceCoverageWasmPack(
            C3_GOOD,
            `      - uses: ${WASM_PACK_ACTION_REF} # v0.4.0\n        continue-on-error: \${{ !cancelled() }}\n        with: { version: 'v0.15.0' }\n`,
            'C3-8 soft-fail the step',
          ),
        },
      }),
  );

  record(
    'C3-9',
    'C3',
    false,
    'checking only wasm-pack: without `targets: wasm32-unknown-unknown` the toolchain cannot compile client-wasm, and wasm-pack fails on a missing target',
    () =>
      checkC3({
        nightly: {
          text: mut(
            C3_GOOD,
            '      - uses: dtolnay/rust-toolchain@stable # stable\n        with: { targets: wasm32-unknown-unknown }\n',
            '      - uses: dtolnay/rust-toolchain@stable # stable\n',
            'C3-9 drop targets',
          ),
        },
      }),
  );

  record(
    'C3-10',
    'C3',
    false,
    "dropping the rust toolchain entirely (today's master: the coverage job provisions only checkout/setup-node/setup-just)",
    () =>
      checkC3({
        nightly: {
          text: mut(C3_GOOD, C3_STEP_TOOLCHAIN, '', 'C3-10 drop rust-toolchain'),
        },
      }),
  );

  record(
    'C3-11',
    'C3',
    false,
    'LAST-KEY-WINS: a second `coverage:` job key. Every block extractor returns the FIRST block, GitHub Actions executes the LAST — a clean first + neutered second is a real, executable bypass.',
    () =>
      checkC3({
        nightly: {
          text: `${C3_GOOD}  coverage:\n    runs-on: ubuntu-latest\n    steps:\n      - run: just coverage\n`,
        },
      }),
  );

  record(
    'C3-12',
    'C3',
    false,
    'an absent `coverage:` job read as "nothing to check" (vacuous pass)',
    () =>
      checkC3({
        nightly: {
          text: `name: Nightly\njobs:\n  a11y-e2e:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${WASM_PACK_ACTION_REF} # v0.4.0\n        with: { version: 'v0.15.0' }\n      - run: just a11y-e2e\n`,
        },
      }),
  );

  record(
    'C3-13',
    'C3',
    false,
    'an unanchored/comment-terminated block extractor: a healthy decoy `  coverage:` parked ABOVE `jobs:` inside a block scalar would be read as THE job block',
    () =>
      checkC3({
        nightly: {
          text: `name: Nightly\nrun-name: |\n  coverage:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${WASM_PACK_ACTION_REF} # v0.4.0\n        with: { version: 'v0.15.0' }\n      - uses: dtolnay/rust-toolchain@stable # stable\n        with: { targets: wasm32-unknown-unknown }\n      - run: just coverage\njobs:\n  coverage:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6 # v6\n      - run: just coverage\n`,
        },
      }),
  );

  record(
    'C3-14',
    'C3',
    false,
    'a gate step suffixed so it cannot fail: without an exact `- run: just coverage` line there is nothing for provisioning to precede, so fail closed rather than skip the ordering check',
    () =>
      checkC3({
        nightly: {
          text: mut(
            C3_GOOD,
            '      - run: just coverage\n',
            '      - run: just coverage || true\n',
            'C3-14 suffix the gate step',
          ),
        },
      }),
  );

  return { total: details.length, failed, details };
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default async function nightlyCoverageWasmWiringEval() {
  const name =
    'nightly-coverage-wasm-wiring (C1 coverage:wasm prior dep, C2 job-scoped ordered totality, C3 nightly coverage job provisioning)';

  let teeth;
  try {
    teeth = runTeeth();
  } catch (err) {
    return { name, pass: false, detail: `proof-of-teeth harness threw — ${err && err.message}` };
  }
  const tally = `teeth=${teeth.total - teeth.failed}/${teeth.total}`;
  if (teeth.failed > 0) {
    const broken = teeth.details
      .filter((d) => !d.ok)
      .map((d) => `${d.id} [${d.criterion}] ${d.note}`)
      .join(' | ');
    return { name, pass: false, detail: `${tally}; PROOF-OF-TEETH FAILURES: ${broken}` };
  }

  let recipes;
  let workflows;
  try {
    recipes = loadRecipes();
  } catch (err) {
    return {
      name,
      pass: false,
      detail: `${tally}; FAILED CLOSED loading the just recipe graph — ${err && err.message}`,
    };
  }
  try {
    workflows = loadWorkflows();
  } catch (err) {
    return {
      name,
      pass: false,
      detail: `${tally}; FAILED CLOSED loading the workflows — ${err && err.message}`,
    };
  }

  const c1 = checkC1(recipes);
  const c2 = checkC2(recipes, workflows);
  const c3 = checkC3(workflows);

  const failures = [];
  if (!c1.ok) failures.push(c1.reason);
  if (!c2.ok) failures.push(c2.reason);
  if (!c3.ok) failures.push(c3.reason);

  if (failures.length > 0) {
    return { name, pass: false, detail: `${tally}; ${failures.join(' || ')}` };
  }
  return {
    name,
    pass: true,
    detail: `${tally}; ${c1.reason}; ${c2.reason} (checked=${c2.checked}); ${c3.reason}`,
  };
}
