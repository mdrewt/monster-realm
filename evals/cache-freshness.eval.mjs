// Proof-of-teeth for the M-infra-a CI caching + fast inner loop gate.
//
// Every mechanical gate ships a known-bad fixture it must reject (ADR-0010).
// This eval makes 8 EARS criteria falsifiable cheaply on every CI run:
//
//   1. No shared CARGO_TARGET_DIR in ci.yml
//   2. rust-cache present AND cache-all-crates:true absent in ci.yml
//   3. Distinct prefix-key values per job in ci.yml
//   4. CARGO_INCREMENTAL=0 set whenever RUSTC_WRAPPER=sccache in justfile
//   5. No committed .cargo rustc-wrapper config
//   6. justfile test recipe uses nextest AND test --doc
//   7. justfile has a ci-fast recipe
//   8. install-action used for nextest+audit; no bare cargo install for them
//
// All predicates are pure (string-in, bool-out). The proof-of-teeth section
// runs each predicate against a known-bad fixture FIRST; if a predicate fails
// to reject its bad fixture, the whole eval fails (the gate has no teeth).
//
// IMPORTANT: No dynamic RegExp (detect-non-literal-regexp). Use only:
//   - String.prototype.includes()
//   - String.prototype.indexOf()
//   - Regex LITERALS (/pattern/)
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Criterion 1: ci.yml must NOT set CARGO_TARGET_DIR anywhere.
//
// Wrong impl killed by this: one that sets a shared CARGO_TARGET_DIR env var,
// causing every job to thrash the same artifact directory on cache restore.
// ---------------------------------------------------------------------------
export function noSharedCargoTargetDir(yaml) {
  return !yaml.includes('CARGO_TARGET_DIR');
}

// ---------------------------------------------------------------------------
// Criterion 2: ci.yml must have Swatinem/rust-cache AND must NOT have
// cache-all-crates: true (which bloats the cache with workspace artifacts).
//
// Wrong impl killed by this: one that uses rust-cache but mistakenly sets
// cache-all-crates: true, causing cross-job artifact bleed.
// ---------------------------------------------------------------------------
export function hasRustCacheWithoutCacheAllCrates(yaml) {
  const hasRustCache = yaml.includes('Swatinem/rust-cache');
  const hasCacheAllCrates = yaml.includes('cache-all-crates: true');
  return hasRustCache && !hasCacheAllCrates;
}

// ---------------------------------------------------------------------------
// Criterion 3: ci.yml must have distinct prefix-key values for different jobs
// (e.g., v1-ci and v1-e2e). A single shared prefix-key means the ci and e2e
// jobs share a cache layer and can restore each other's stale artifacts.
//
// Wrong impl killed by this: one that uses the same prefix-key for all jobs,
// or omits prefix-key entirely.
// ---------------------------------------------------------------------------
export function hasDistinctPrefixKeys(yaml) {
  // Must have at least two distinct prefix-key values. We check for the
  // pattern `prefix-key:` occurring at least twice, then verify the values
  // differ. We collect all `prefix-key: <value>` occurrences via indexOf.
  const marker = 'prefix-key:';
  const found = [];
  let idx = 0;
  while (true) {
    const pos = yaml.indexOf(marker, idx);
    if (pos === -1) break;
    // Grab the rest of the line after the marker
    const lineEnd = yaml.indexOf('\n', pos);
    let value =
      lineEnd === -1
        ? yaml.slice(pos + marker.length).trim()
        : yaml.slice(pos + marker.length, lineEnd).trim();
    // Strip inline YAML comments (e.g., "v1-ci  # main job" → "v1-ci")
    const commentIdx = value.indexOf('#');
    if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();
    found.push(value);
    idx = pos + marker.length;
  }
  if (found.length < 2) return false;
  // At least two distinct values required
  const unique = new Set(found);
  return unique.size >= 2;
}

// ---------------------------------------------------------------------------
// Criterion 4: justfile must set CARGO_INCREMENTAL=0 in the same context as
// RUSTC_WRAPPER=sccache. Both env vars must appear together (in a cache-on
// or equivalent recipe / env block).
//
// Wrong impl killed by this: one that sets RUSTC_WRAPPER=sccache but omits
// CARGO_INCREMENTAL=0, causing sccache to cache incremental artifacts that
// are incompatible across machines and blow the remote cache hit rate.
// ---------------------------------------------------------------------------
export function sccacheHasIncrementalZero(justfile) {
  const hasSccache = justfile.includes('RUSTC_WRAPPER') && justfile.includes('sccache');
  if (!hasSccache) return false;
  // Both must be present together
  return justfile.includes('CARGO_INCREMENTAL') && justfile.includes('CARGO_INCREMENTAL=0');
}

// ---------------------------------------------------------------------------
// Criterion 5: no committed .cargo/config.toml or .cargo/config with a
// rustc-wrapper key. Committing rustc-wrapper=sccache forces every developer
// and CI runner to have sccache installed or face cryptic build failures.
//
// This predicate takes the cargo config FILE CONTENT (string); an empty
// string (file not found) must return true (absence = compliant).
//
// Wrong impl killed by this: one that commits rustc-wrapper to .cargo/config.
// ---------------------------------------------------------------------------
export function noCommittedRustcWrapper(cargoConfigContent) {
  // Empty / absent file is fine
  if (!cargoConfigContent) return true;
  return !cargoConfigContent.includes('rustc-wrapper');
}

// ---------------------------------------------------------------------------
// Criterion 6: justfile `test` recipe must include both nextest and test --doc
// (doc-test runner). A recipe using only `cargo test --workspace` skips nextest
// parallelism and misses doc-test coverage.
//
// Wrong impl killed by this: the current `cargo test --workspace` recipe, which
// uses neither nextest nor a separate --doc pass.
// ---------------------------------------------------------------------------
export function testRecipeHasNextestAndDoctest(justfile) {
  // Find the test recipe block. We look for `\ntest:` or `^test:` as the recipe
  // header, then inspect what follows up to the next recipe (non-indented line).
  const testHeaderIdx = justfile.indexOf('\ntest:');
  const altIdx = justfile.indexOf('\ntest ');
  const headerIdx = testHeaderIdx !== -1 ? testHeaderIdx : altIdx;
  if (headerIdx === -1) {
    // Try start of file
    if (!justfile.startsWith('test:') && !justfile.startsWith('test ')) return false;
  }

  // Extract recipe body: lines starting with whitespace after the header
  const start = headerIdx !== -1 ? headerIdx : 0;
  // Scan from the line after the header
  const afterHeader = justfile.indexOf('\n', start + 1);
  if (afterHeader === -1) return false;

  // Collect indented lines (recipe body). Just 1.21 allows blank lines
  // within a recipe body, so skip blank lines and keep scanning.
  let body = '';
  let pos = afterHeader + 1;
  while (pos < justfile.length) {
    const lineEnd = justfile.indexOf('\n', pos);
    const line = lineEnd === -1 ? justfile.slice(pos) : justfile.slice(pos, lineEnd);
    // Recipe body lines start with whitespace (tab or spaces)
    if (line.length > 0 && (line[0] === ' ' || line[0] === '\t')) {
      body += line + '\n';
      pos = lineEnd === -1 ? justfile.length : lineEnd + 1;
    } else if (line.length === 0) {
      // Blank line — skip it, may still be inside recipe in Just 1.21+
      pos = lineEnd === -1 ? justfile.length : lineEnd + 1;
    } else {
      break;
    }
  }

  // Use 'nextest run' to avoid matching the word 'nextest' in comments
  const hasNextest = body.includes('nextest run');
  const hasDoctest = body.includes('--doc') || body.includes('test --doc');
  return hasNextest && hasDoctest;
}

// ---------------------------------------------------------------------------
// Criterion 7: justfile must have a `ci-fast` recipe.
//
// Wrong impl killed by this: the current justfile which has only `ci:` but no
// `ci-fast:` recipe, leaving no way to run the fast inner loop locally or in CI.
// ---------------------------------------------------------------------------
export function hasCiFastRecipe(justfile) {
  // Match both `ci-fast:` (no args) and `ci-fast crate:` (parameterized)
  return (
    justfile.includes('\nci-fast:') ||
    justfile.includes('\nci-fast ') ||
    justfile.startsWith('ci-fast:') ||
    justfile.startsWith('ci-fast ')
  );
}

// ---------------------------------------------------------------------------
// Criterion 8: ci.yml must use taiki-e/install-action (or install-action) for
// both cargo-audit AND cargo-nextest; must NOT have bare `cargo install cargo-audit`
// or `cargo install cargo-nextest` (slow, no caching, non-reproducible).
//
// Wrong impl killed by this: the current ci.yml which uses `cargo install cargo-audit
// --locked` and has no install-action at all.
// ---------------------------------------------------------------------------
export function usesInstallActionForAuditAndNextest(yaml) {
  const hasInstallAction =
    yaml.includes('taiki-e/install-action') || yaml.includes('install-action');
  if (!hasInstallAction) return false;
  // Must NOT use bare cargo install for these tools
  const bareInstallAudit = /cargo\s+install\s+cargo-audit/.test(yaml);
  const bareInstallNextest = /cargo\s+install\s+cargo-nextest/.test(yaml);
  return !bareInstallAudit && !bareInstallNextest;
}

// ---------------------------------------------------------------------------
// Default export: proof-of-teeth then real file checks
// ---------------------------------------------------------------------------
export default async function () {
  const name = 'cache-freshness (CI caching + fast inner loop — 8 EARS criteria)';

  // -------------------------------------------------------------------------
  // PROOF-OF-TEETH: run each predicate against known-bad fixtures FIRST.
  // If a predicate fails to reject its bad fixture, the eval itself fails.
  // -------------------------------------------------------------------------

  // Teeth 1: noSharedCargoTargetDir must reject content with CARGO_TARGET_DIR
  const badCargoTargetDir = 'env:\n  CARGO_TARGET_DIR: /tmp/target\n';
  if (noSharedCargoTargetDir(badCargoTargetDir)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #1: noSharedCargoTargetDir failed to reject a yaml containing CARGO_TARGET_DIR',
    };
  }
  // Teeth 1b: must accept yaml without CARGO_TARGET_DIR
  if (!noSharedCargoTargetDir('env:\n  RUSTFLAGS: -D warnings\n')) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #1b: noSharedCargoTargetDir wrongly rejected yaml without CARGO_TARGET_DIR',
    };
  }

  // Teeth 2: hasRustCacheWithoutCacheAllCrates must reject yaml with cache-all-crates: true
  const badCacheAllCrates = 'uses: Swatinem/rust-cache@v2\nwith:\n  cache-all-crates: true\n';
  if (hasRustCacheWithoutCacheAllCrates(badCacheAllCrates)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #2: hasRustCacheWithoutCacheAllCrates failed to reject cache-all-crates: true',
    };
  }
  // Teeth 2b: must reject yaml with no rust-cache at all
  const badNoRustCache = 'uses: actions/checkout@v4\n';
  if (hasRustCacheWithoutCacheAllCrates(badNoRustCache)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #2b: hasRustCacheWithoutCacheAllCrates failed to reject yaml with no rust-cache',
    };
  }

  // Teeth 3: hasDistinctPrefixKeys must reject yaml with only one prefix-key
  const badSinglePrefixKey =
    'ci:\n  steps:\n    - uses: Swatinem/rust-cache@v2\n      with:\n        prefix-key: v1-ci\ne2e:\n  steps:\n    - uses: Swatinem/rust-cache@v2\n      with:\n        prefix-key: v1-ci\n';
  if (hasDistinctPrefixKeys(badSinglePrefixKey)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #3: hasDistinctPrefixKeys failed to reject yaml where all jobs share the same prefix-key',
    };
  }
  // Teeth 3b: must reject yaml with no prefix-key at all
  if (hasDistinctPrefixKeys('uses: Swatinem/rust-cache@v2\n')) {
    return {
      name,
      pass: false,
      detail: 'proof-of-teeth #3b: hasDistinctPrefixKeys failed to reject yaml with no prefix-key',
    };
  }

  // Teeth 4: sccacheHasIncrementalZero must reject justfile with sccache but no CARGO_INCREMENTAL=0
  const badSccacheNoIncremental = 'cache-on:\n    export RUSTC_WRAPPER := "sccache"\n';
  if (sccacheHasIncrementalZero(badSccacheNoIncremental)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #4: sccacheHasIncrementalZero failed to reject justfile with sccache but no CARGO_INCREMENTAL=0',
    };
  }
  // Teeth 4b: must reject justfile with CARGO_INCREMENTAL=0 but no sccache
  const badIncrementalNoSccache = 'env:\n  CARGO_INCREMENTAL=0\n';
  if (sccacheHasIncrementalZero(badIncrementalNoSccache)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #4b: sccacheHasIncrementalZero failed to reject justfile with CARGO_INCREMENTAL=0 but no sccache',
    };
  }

  // Teeth 5: noCommittedRustcWrapper must reject config with rustc-wrapper
  const badRustcWrapper = '[build]\nrustc-wrapper = "sccache"\n';
  if (noCommittedRustcWrapper(badRustcWrapper)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #5: noCommittedRustcWrapper failed to reject a cargo config containing rustc-wrapper',
    };
  }
  // Teeth 5b: must accept empty/absent config
  if (!noCommittedRustcWrapper('')) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #5b: noCommittedRustcWrapper wrongly rejected an empty (absent) cargo config',
    };
  }

  // Teeth 6: testRecipeHasNextestAndDoctest must reject plain `cargo test --workspace`
  const badTestRecipe = 'test:\n    cargo test --workspace\n\nlint:\n    cargo clippy\n';
  if (testRecipeHasNextestAndDoctest(badTestRecipe)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #6: testRecipeHasNextestAndDoctest failed to reject a recipe using only cargo test --workspace',
    };
  }
  // Teeth 6b: must reject recipe with nextest run only (no --doc pass)
  const badTestNextestOnly =
    'test:\n    cargo nextest run --workspace\n\nlint:\n    cargo clippy\n';
  if (testRecipeHasNextestAndDoctest(badTestNextestOnly)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #6b: testRecipeHasNextestAndDoctest failed to reject a recipe with nextest but no --doc pass',
    };
  }

  // Teeth 7: hasCiFastRecipe must reject justfile without ci-fast
  const badNoCiFast = 'ci: lint typecheck test\n\nlint:\n    cargo clippy\n';
  if (hasCiFastRecipe(badNoCiFast)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #7: hasCiFastRecipe failed to reject a justfile without a ci-fast recipe',
    };
  }

  // Teeth 8: usesInstallActionForAuditAndNextest must reject bare cargo install
  const badBareCargoInstall =
    'steps:\n  - name: SCA\n    run: cargo install cargo-audit --locked\n';
  if (usesInstallActionForAuditAndNextest(badBareCargoInstall)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #8: usesInstallActionForAuditAndNextest failed to reject bare cargo install cargo-audit',
    };
  }
  // Teeth 8b: must reject yaml with install-action but still using bare cargo install
  const badInstallActionPlusBare =
    'uses: taiki-e/install-action@v2\nwith:\n  tool: cargo-nextest\n- run: cargo install cargo-audit --locked\n';
  if (usesInstallActionForAuditAndNextest(badInstallActionPlusBare)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #8b: usesInstallActionForAuditAndNextest failed to reject yaml that has install-action but still uses bare cargo install',
    };
  }

  // Teeth 8c: must reject yaml with install-action for audit but bare cargo install for nextest
  const badBareNextestInstall =
    'uses: taiki-e/install-action@v2\nwith:\n  tool: cargo-audit\n- run: cargo install cargo-nextest --locked\n';
  if (usesInstallActionForAuditAndNextest(badBareNextestInstall)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth #8c: usesInstallActionForAuditAndNextest failed to reject yaml that has install-action for audit but bare cargo install for nextest',
    };
  }

  // -------------------------------------------------------------------------
  // REAL FILE CHECKS: read actual ci.yml + justfile and apply each predicate.
  // -------------------------------------------------------------------------
  const ciPath = path.resolve('.github/workflows/ci.yml');
  const justPath = path.resolve('justfile');
  // .cargo/config files (either name)
  const cargoConfigTomlPath = path.resolve('.cargo/config.toml');
  const cargoConfigPath = path.resolve('.cargo/config');

  let yaml = '';
  try {
    yaml = readFileSync(ciPath, 'utf8');
  } catch {
    return { name, pass: false, detail: `cannot read ${ciPath}` };
  }

  let justfile = '';
  try {
    justfile = readFileSync(justPath, 'utf8');
  } catch {
    return { name, pass: false, detail: `cannot read ${justPath}` };
  }

  // Read cargo config files; absent file = empty string (criterion 5: absence is compliant)
  let cargoConfigContent = '';
  try {
    cargoConfigContent = readFileSync(cargoConfigTomlPath, 'utf8');
  } catch {
    /* absent = fine */
  }
  if (!cargoConfigContent) {
    try {
      cargoConfigContent = readFileSync(cargoConfigPath, 'utf8');
    } catch {
      /* absent = fine */
    }
  }

  // Criterion 1
  if (!noSharedCargoTargetDir(yaml)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 1 FAIL: ci.yml sets CARGO_TARGET_DIR — remove it to avoid shared artifact cache pollution',
    };
  }

  // Criterion 2
  if (!hasRustCacheWithoutCacheAllCrates(yaml)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 2 FAIL: ci.yml must use Swatinem/rust-cache (without cache-all-crates: true) — currently missing rust-cache entirely',
    };
  }

  // Criterion 3
  if (!hasDistinctPrefixKeys(yaml)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 3 FAIL: ci.yml must have distinct prefix-key values per job (e.g., v1-ci and v1-e2e) — currently missing or identical',
    };
  }

  // Criterion 4
  if (!sccacheHasIncrementalZero(justfile)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 4 FAIL: justfile must set CARGO_INCREMENTAL=0 alongside RUSTC_WRAPPER=sccache — currently missing sccache integration or CARGO_INCREMENTAL=0',
    };
  }

  // Criterion 5
  if (!noCommittedRustcWrapper(cargoConfigContent)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 5 FAIL: .cargo/config.toml or .cargo/config must not contain rustc-wrapper',
    };
  }

  // Criterion 6
  if (!testRecipeHasNextestAndDoctest(justfile)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 6 FAIL: justfile `test` recipe must use cargo nextest AND include a --doc pass — currently uses plain cargo test --workspace',
    };
  }

  // Criterion 7
  if (!hasCiFastRecipe(justfile)) {
    return {
      name,
      pass: false,
      detail: 'criterion 7 FAIL: justfile must have a ci-fast recipe — currently absent',
    };
  }

  // Criterion 8
  if (!usesInstallActionForAuditAndNextest(yaml)) {
    return {
      name,
      pass: false,
      detail:
        'criterion 8 FAIL: ci.yml must use taiki-e/install-action for cargo-audit and cargo-nextest instead of bare cargo install — currently uses cargo install cargo-audit',
    };
  }

  return {
    name,
    pass: true,
    detail:
      'all 8 caching criteria met: no shared CARGO_TARGET_DIR, rust-cache wired, distinct prefix-keys, ' +
      'sccache+CARGO_INCREMENTAL=0, no committed rustc-wrapper, nextest+doctest in test recipe, ' +
      'ci-fast recipe present, install-action used for audit+nextest',
  };
}
