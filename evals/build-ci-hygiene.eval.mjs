// M8.5d — Build/CI/toolchain hygiene — 6 EARS criteria eval
//
// Each criterion is a PURE predicate over file content. The proof-of-teeth
// section runs each predicate against a KNOWN-BAD fixture FIRST; if the
// predicate fails to reject its bad fixture the eval itself fails with a
// diagnostic. A KNOWN-GOOD fixture is also verified so the predicate cannot
// be trivially-false. Only after all teeth are proven do the real files get
// checked.
//
// IMPORTANT: NO new RegExp(...) anywhere — the remote Semgrep gate
// (detect-non-literal-regexp) has bitten this project 3x. Only literal regex
// literals (e.g. /[0-9a-f]{40}/) and String methods (includes/indexOf/
// startsWith/split) are used.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Criterion (i): justfile lint: recipe body must contain ALL of:
//   • "cargo fmt"
//   • "--check"        (so it's a check-mode invocation, not a reformat)
//   • "biome check"
//
// Wrong impl killed: a lint body with only `cargo clippy` (current state);
// one with `cargo fmt` but `--check` absent (reformat-in-CI foot-gun);
// one with fmt+check but missing biome.
// ---------------------------------------------------------------------------
export function extractRecipeBody(text, recipeName) {
  // Search for the recipe header: either "\n<name>:" or "\n<name> " (parameterised)
  const exactMarker = `\n${recipeName}:`;
  const paramMarker = `\n${recipeName} `;
  const exactIdx = text.indexOf(exactMarker);
  const paramIdx = text.indexOf(paramMarker);

  let headerIdx = -1;
  if (exactIdx !== -1 && paramIdx !== -1) headerIdx = Math.min(exactIdx, paramIdx);
  else if (exactIdx !== -1) headerIdx = exactIdx;
  else if (paramIdx !== -1) headerIdx = paramIdx;

  // Also handle recipe at very start of file
  if (headerIdx === -1) {
    if (text.startsWith(`${recipeName}:`) || text.startsWith(`${recipeName} `)) {
      headerIdx = 0;
    } else {
      return '';
    }
  }

  const afterHeader = text.indexOf('\n', headerIdx === 0 ? 0 : headerIdx + 1);
  if (afterHeader === -1) return '';

  let body = '';
  let pos = afterHeader + 1;
  while (pos < text.length) {
    const lineEnd = text.indexOf('\n', pos);
    const line = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd);
    if (line.length > 0 && (line[0] === ' ' || line[0] === '\t')) {
      // Strip comment lines
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('#')) {
        body += `${line}\n`;
      }
      pos = lineEnd === -1 ? text.length : lineEnd + 1;
    } else if (line.length === 0) {
      pos = lineEnd === -1 ? text.length : lineEnd + 1;
    } else {
      break;
    }
  }
  return body;
}

export function lintRecipeIsComplete(justfile) {
  const body = extractRecipeBody(justfile, 'lint');
  if (!body) return false;
  return body.includes('cargo fmt') && body.includes('--check') && body.includes('biome check');
}

// ---------------------------------------------------------------------------
// Criterion (ii): every `uses:` line in a GitHub Actions workflow YAML must
// have a ref pinned to a 40-hex-char commit SHA. Lines that are pure YAML
// comments (trimmed line starts with '#') are skipped. The ref is the part
// after the LAST '@' and before optional whitespace / '#' comment.
//
// Wrong impl killed by ALL these bad shapes (not just one):
//   uses: actions/checkout@v4
//   uses: anchore/sbom-action@v0
//   uses: gitleaks/gitleaks-action@v2
//   uses: dtolnay/rust-toolchain@stable
//   uses: jetli/wasm-pack-action@v0.4.0
// Good: uses: actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3 # v4
// ---------------------------------------------------------------------------
export function allUsesAreSHAPinned(yaml) {
  const lines = yaml.split('\n');
  for (const rawLine of lines) {
    const trimmed = rawLine.trimStart();
    // Skip pure comment lines
    if (trimmed.startsWith('#')) continue;
    // Only inspect lines that contain `uses:`
    if (!trimmed.includes('uses:')) continue;
    // Find the value after `uses:` (handles both `uses: foo` and `- uses: foo`)
    const usesColonIdx = trimmed.indexOf('uses:');
    if (usesColonIdx === -1) continue;
    const afterColon = trimmed.slice(usesColonIdx + 5).trim();
    // Strip inline comment from the value token (stop at ' #' or '\t#')
    const hashIdx = afterColon.indexOf(' #');
    const value = hashIdx !== -1 ? afterColon.slice(0, hashIdx).trim() : afterColon.trim();
    // The ref is everything after the LAST '@'
    const atIdx = value.lastIndexOf('@');
    if (atIdx === -1) return false;
    const ref = value.slice(atIdx + 1);
    // Must be exactly 40 lowercase hex chars
    if (!/^[0-9a-f]{40}$/.test(ref)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Criterion (iii): client/package.json must declare:
//   "engines": { "node": ">=24.13.1 <25" }   (exact string match)
//
// Wrong impl killed: no engines key; engines.node set to a different range.
// ---------------------------------------------------------------------------
export function clientPackageHasEnginesNode(pkgJson) {
  let parsed;
  try {
    parsed = JSON.parse(pkgJson);
  } catch {
    return false;
  }
  if (!parsed.engines || typeof parsed.engines !== 'object') return false;
  return parsed.engines.node === '>=24.13.1 <25';
}

// ---------------------------------------------------------------------------
// Criterion (iv): two-file log workspace dep.
//   A) root Cargo.toml [workspace.dependencies] section contains a `log` entry
//   B) server-module/Cargo.toml contains `log.workspace = true` (allow
//      whitespace variants like `log = { workspace = true }`)
//
// Wrong impl killed: server-module with `log = "0.4"` (current state);
// log absent from root workspace deps.
// ---------------------------------------------------------------------------
export function rootCargoHasLogWorkspaceDep(rootCargoToml) {
  // Find the [workspace.dependencies] section and look for a log entry within it.
  // We scan lines after the section header until the next section header ([...]).
  const lines = rootCargoToml.split('\n');
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[workspace.dependencies]') {
      inSection = true;
      continue;
    }
    if (inSection) {
      // A new section header ends the current section
      if (trimmed.startsWith('[')) {
        inSection = false;
        continue;
      }
      // Match a log key: `log` or `log =` or `log=` (handles `log = "0.4"` and
      // `log = { version = "0.4" }` and just `log = "0.4"`)
      // Use startsWith to avoid matching `log-` crates. Split on '=' and check key.
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        if (key === 'log') return true;
      }
    }
  }
  return false;
}

export function serverModuleUsesLogWorkspace(serverCargoToml) {
  // Accept: `log.workspace = true`  or  `log = { workspace = true }`
  // Reject: `log = "0.4"` (direct version pin — current bad state)
  return (
    serverCargoToml.includes('log.workspace = true') ||
    serverCargoToml.includes('log = { workspace = true }') ||
    serverCargoToml.includes('log={ workspace = true }')
  );
}

// ---------------------------------------------------------------------------
// Criterion (v): .devcontainer/devcontainer.json must declare:
//   • a Rust toolchain (a devcontainer feature whose key includes "rust")
//   • Node version "24.13.1" (exact string present in the JSON)
//   • wasm-pack "0.15.0" (exact string present in the JSON)
//
// Wrong impl killed: current file — no rust feature, floating node `{}`,
// no wasm-pack.
// ---------------------------------------------------------------------------
export function devcontainerHasPins(devcontainerJson) {
  let parsed;
  try {
    parsed = JSON.parse(devcontainerJson);
  } catch {
    return false;
  }
  // Check for a Rust feature: any feature key that contains "rust"
  const features = parsed.features || {};
  const hasRust = Object.keys(features).some((k) => k.includes('rust'));
  if (!hasRust) return false;
  // Check for exact node version string and wasm-pack version anywhere in the raw JSON
  // (they may appear in feature values, postCreateCommand, etc.)
  const raw = devcontainerJson;
  const hasNode = raw.includes('24.13.1');
  const hasWasmPack = raw.includes('0.15.0');
  return hasNode && hasWasmPack;
}

// ---------------------------------------------------------------------------
// Criterion (vi): biome.json files.includes must contain an exclusion for
// client/src/module_bindings (the exact pattern "!client/src/module_bindings").
//
// Wrong impl killed: includes without the exclusion (current state —
// includes only ["**", "!**/*.json", "!**/*.jsonc"]).
// ---------------------------------------------------------------------------
export function biomeExcludesModuleBindings(biomeJson) {
  let parsed;
  try {
    parsed = JSON.parse(biomeJson);
  } catch {
    return false;
  }
  const includes = parsed.files?.includes ?? [];
  return includes.some((entry) => entry.includes('!client/src/module_bindings'));
}

// ---------------------------------------------------------------------------
// Default export: proof-of-teeth then real file checks
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'build-ci-hygiene (M8.5d — 6 EARS criteria: lint, SHA-pins, engines, log-workspace, devcontainer, biome-excludes)';

  // =========================================================================
  // PROOF-OF-TEETH — bad fixtures first, then good fixtures
  // =========================================================================

  // --- (i) lintRecipeIsComplete ---

  // Bad: clippy only (current justfile state)
  const badLintClippyOnly =
    'lint:\n    cargo clippy --workspace --all-targets --all-features -- -D warnings\n';
  if (lintRecipeIsComplete(badLintClippyOnly)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (i)-a: lintRecipeIsComplete failed to reject a lint body with only cargo clippy (current state)',
    };
  }

  // Bad: has cargo fmt but no --check (reformat-in-CI foot-gun)
  const badLintFmtNoCheck =
    'lint:\n    cargo fmt --all\n    cargo clippy --workspace -- -D warnings\n    biome check .\n';
  if (lintRecipeIsComplete(badLintFmtNoCheck)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (i)-b: lintRecipeIsComplete failed to reject a lint body with cargo fmt but without --check',
    };
  }

  // Bad: has fmt --check but no biome check
  const badLintNoReplaceBiome =
    'lint:\n    cargo fmt --all --check\n    cargo clippy --workspace -- -D warnings\n';
  if (lintRecipeIsComplete(badLintNoReplaceBiome)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (i)-c: lintRecipeIsComplete failed to reject a lint body missing biome check',
    };
  }

  // Guard against comment-bypass: `# biome check` inside a comment must not satisfy the requirement
  const badLintCommentBypass =
    'lint:\n    cargo fmt --all --check\n    cargo clippy --workspace -- -D warnings\n    # biome check .\n';
  if (lintRecipeIsComplete(badLintCommentBypass)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (i)-d: lintRecipeIsComplete accepted a commented-out biome check line — comment-stripping must exclude comment lines',
    };
  }

  // Good: all three present
  const goodLint =
    'lint:\n    cargo fmt --all --check\n    cargo clippy --workspace --all-targets --all-features -- -D warnings\n    client/node_modules/.bin/biome check .\n';
  if (!lintRecipeIsComplete(goodLint)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (i)-good: lintRecipeIsComplete wrongly rejected a lint body containing cargo fmt --check and biome check',
    };
  }

  // --- (ii) allUsesAreSHAPinned ---

  // Bad: each of the five real unpin shapes that exist in the current tree
  const badUsesV4 = 'steps:\n  - uses: actions/checkout@v4\n    with: { fetch-depth: 0 }\n';
  if (allUsesAreSHAPinned(badUsesV4)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (ii)-a: allUsesAreSHAPinned failed to reject uses: actions/checkout@v4',
    };
  }

  const badUsesV0 = 'steps:\n  - uses: anchore/sbom-action@v0\n';
  if (allUsesAreSHAPinned(badUsesV0)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (ii)-b: allUsesAreSHAPinned failed to reject uses: anchore/sbom-action@v0',
    };
  }

  const badUsesGitleaks = 'steps:\n  - uses: gitleaks/gitleaks-action@v2\n';
  if (allUsesAreSHAPinned(badUsesGitleaks)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (ii)-c: allUsesAreSHAPinned failed to reject uses: gitleaks/gitleaks-action@v2',
    };
  }

  const badUsesStable = 'steps:\n  - uses: dtolnay/rust-toolchain@stable\n';
  if (allUsesAreSHAPinned(badUsesStable)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (ii)-d: allUsesAreSHAPinned failed to reject uses: dtolnay/rust-toolchain@stable',
    };
  }

  const badUsesVersionTag = 'steps:\n  - uses: jetli/wasm-pack-action@v0.4.0\n';
  if (allUsesAreSHAPinned(badUsesVersionTag)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (ii)-e: allUsesAreSHAPinned failed to reject uses: jetli/wasm-pack-action@v0.4.0',
    };
  }

  // Bad: 39-hex (one short of a valid SHA) must be rejected
  const badUses39Hex =
    'steps:\n  - uses: actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b # v4\n';
  if (allUsesAreSHAPinned(badUses39Hex)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (ii)-f: allUsesAreSHAPinned failed to reject a 39-char hex ref (one short of a valid SHA)',
    };
  }

  // Good: two properly SHA-pinned uses lines (one with trailing comment)
  const goodUsesYaml = [
    'steps:',
    '  - uses: actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3 # v4',
    '    with: { fetch-depth: 0 }',
    '  - uses: dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8 # stable',
    '    with: { components: clippy }',
  ].join('\n');
  if (!allUsesAreSHAPinned(goodUsesYaml)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (ii)-good: allUsesAreSHAPinned wrongly rejected properly SHA-pinned uses lines',
    };
  }

  // Good: comment lines containing un-pinned refs must be ignored
  const goodUsesWithComment = [
    '# NOTE: action major versions are pinned here (e.g. @v4) to match ci.yml style',
    'steps:',
    '  - uses: actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3 # v4',
  ].join('\n');
  if (!allUsesAreSHAPinned(goodUsesWithComment)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (ii)-good-comment: allUsesAreSHAPinned wrongly rejected a file where the only non-SHA ref was in a pure comment line',
    };
  }

  // --- (iii) clientPackageHasEnginesNode ---

  // Bad: no engines key at all (current state)
  const badPkgNoEngines = JSON.stringify({
    name: 'monster-realm-client',
    private: true,
    dependencies: {},
  });
  if (clientPackageHasEnginesNode(badPkgNoEngines)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (iii)-a: clientPackageHasEnginesNode failed to reject a package.json with no engines key',
    };
  }

  // Bad: wrong node range
  const badPkgWrongRange = JSON.stringify({
    name: 'monster-realm-client',
    engines: { node: '>=18' },
  });
  if (clientPackageHasEnginesNode(badPkgWrongRange)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (iii)-b: clientPackageHasEnginesNode failed to reject engines.node ">=18" (wrong range)',
    };
  }

  // Bad: close-but-wrong — >=24 (missing patch)
  const badPkgCloseRange = JSON.stringify({
    name: 'monster-realm-client',
    engines: { node: '>=24 <25' },
  });
  if (clientPackageHasEnginesNode(badPkgCloseRange)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (iii)-c: clientPackageHasEnginesNode failed to reject engines.node ">=24 <25" (missing .13.1 patch)',
    };
  }

  // Good: exact required string
  const goodPkg = JSON.stringify({
    name: 'monster-realm-client',
    engines: { node: '>=24.13.1 <25' },
  });
  if (!clientPackageHasEnginesNode(goodPkg)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (iii)-good: clientPackageHasEnginesNode wrongly rejected the exact required engines.node string',
    };
  }

  // --- (iv) log workspace dep (two files) ---

  // Bad root: no log in workspace.dependencies (current state — only wasm-bindgen etc.)
  const badRootCargoNoLog = [
    '[workspace]',
    'resolver = "2"',
    'members = ["game-core", "server-module"]',
    '',
    '[workspace.dependencies]',
    'wasm-bindgen = "0.2"',
    'serde = { version = "1", features = ["derive"] }',
  ].join('\n');
  if (rootCargoHasLogWorkspaceDep(badRootCargoNoLog)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (iv)-a: rootCargoHasLogWorkspaceDep failed to reject a root Cargo.toml with no log in [workspace.dependencies]',
    };
  }

  // Bad root: log-like name (log-mio) must not match — only exact key "log"
  const badRootCargoLogMio = [
    '[workspace.dependencies]',
    'log-mio = "0.1"',
    'wasm-bindgen = "0.2"',
  ].join('\n');
  if (rootCargoHasLogWorkspaceDep(badRootCargoLogMio)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (iv)-b: rootCargoHasLogWorkspaceDep failed to reject a workspace that has log-mio but not log',
    };
  }

  // Good root: log present in workspace.dependencies
  const goodRootCargo = [
    '[workspace.dependencies]',
    'wasm-bindgen = "0.2"',
    'log = "0.4"',
    'serde = { version = "1", features = ["derive"] }',
  ].join('\n');
  if (!rootCargoHasLogWorkspaceDep(goodRootCargo)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (iv)-root-good: rootCargoHasLogWorkspaceDep wrongly rejected a workspace with log in [workspace.dependencies]',
    };
  }

  // Bad server-module: direct version pin (current state)
  const badServerLogDirect = '[dependencies]\nspacetimedb = { workspace = true }\nlog = "0.4"\n';
  if (serverModuleUsesLogWorkspace(badServerLogDirect)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (iv)-c: serverModuleUsesLogWorkspace failed to reject log = "0.4" (direct pin — current state)',
    };
  }

  // Good server-module: dotted key form
  const goodServerLogDot =
    '[dependencies]\nspacetimedb = { workspace = true }\nlog.workspace = true\n';
  if (!serverModuleUsesLogWorkspace(goodServerLogDot)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (iv)-good-dot: serverModuleUsesLogWorkspace wrongly rejected log.workspace = true',
    };
  }

  // Good server-module: inline table form
  const goodServerLogInline =
    '[dependencies]\nspacetimedb = { workspace = true }\nlog = { workspace = true }\n';
  if (!serverModuleUsesLogWorkspace(goodServerLogInline)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (iv)-good-inline: serverModuleUsesLogWorkspace wrongly rejected log = { workspace = true }',
    };
  }

  // --- (v) devcontainerHasPins ---

  // Bad: current file — no rust feature, floating node {}, no wasm-pack
  const badDevcontainerCurrent = JSON.stringify({
    name: 'monster-realm',
    image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
    features: {
      'ghcr.io/devcontainers/features/node:1': {},
      'ghcr.io/guiyomh/features/just:0': {},
      'ghcr.io/devcontainers/features/docker-in-docker:2': {},
    },
    postCreateCommand: 'just setup',
  });
  if (devcontainerHasPins(badDevcontainerCurrent)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (v)-a: devcontainerHasPins failed to reject the current devcontainer.json (no rust, floating node, no wasm-pack)',
    };
  }

  // Bad: has rust but no node version pin
  const badDevcontainerNoNodePin = JSON.stringify({
    features: {
      'ghcr.io/devcontainers/features/rust:1': {},
      'ghcr.io/devcontainers/features/node:1': {},
    },
    postCreateCommand: 'just setup',
  });
  if (devcontainerHasPins(badDevcontainerNoNodePin)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (v)-b: devcontainerHasPins failed to reject a devcontainer with rust but no 24.13.1 node pin',
    };
  }

  // Bad: has rust + node pin but no wasm-pack version
  const badDevcontainerNoWasmPack = JSON.stringify({
    features: {
      'ghcr.io/devcontainers/features/rust:1': { version: 'latest' },
      'ghcr.io/devcontainers/features/node:1': { version: '24.13.1' },
    },
    postCreateCommand: 'just setup',
  });
  if (devcontainerHasPins(badDevcontainerNoWasmPack)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (v)-c: devcontainerHasPins failed to reject a devcontainer missing wasm-pack 0.15.0',
    };
  }

  // Good: rust feature + node 24.13.1 + wasm-pack 0.15.0
  const goodDevcontainer = JSON.stringify({
    features: {
      'ghcr.io/devcontainers/features/rust:1': { version: 'latest' },
      'ghcr.io/devcontainers/features/node:1': { version: '24.13.1' },
    },
    postCreateCommand:
      'rustup target add wasm32-unknown-unknown && cargo install wasm-pack --version 0.15.0 && just setup',
  });
  if (!devcontainerHasPins(goodDevcontainer)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (v)-good: devcontainerHasPins wrongly rejected a devcontainer with rust feature + node 24.13.1 + wasm-pack 0.15.0',
    };
  }

  // --- (vi) biomeExcludesModuleBindings ---

  // Bad: current state — includes without the module_bindings exclusion
  const badBiomeNoExclude = JSON.stringify({
    $schema: 'https://biomejs.dev/schemas/2.5.1/schema.json',
    files: { includes: ['**', '!**/*.json', '!**/*.jsonc'] },
  });
  if (biomeExcludesModuleBindings(badBiomeNoExclude)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (vi)-a: biomeExcludesModuleBindings failed to reject the current biome.json (no !client/src/module_bindings exclusion)',
    };
  }

  // Bad: has an exclusion for a different path but not module_bindings
  const badBiomeWrongExclude = JSON.stringify({
    files: { includes: ['**', '!client/dist/**', '!.claude/**'] },
  });
  if (biomeExcludesModuleBindings(badBiomeWrongExclude)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (vi)-b: biomeExcludesModuleBindings failed to reject biome.json that excludes client/dist but not module_bindings',
    };
  }

  // Good: includes the required exclusion pattern
  const goodBiome = JSON.stringify({
    $schema: 'https://biomejs.dev/schemas/2.5.1/schema.json',
    files: {
      includes: [
        '**',
        '!**/*.json',
        '!**/*.jsonc',
        '!client/src/module_bindings/**',
        '!.claude/**',
        '!client/dist/**',
      ],
    },
  });
  if (!biomeExcludesModuleBindings(goodBiome)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (vi)-good: biomeExcludesModuleBindings wrongly rejected biome.json with !client/src/module_bindings/** in includes',
    };
  }

  // =========================================================================
  // REAL FILE CHECKS
  // =========================================================================
  const root = path.resolve('.');

  const justfilePath = path.join(root, 'justfile');
  const ciYmlPath = path.join(root, '.github/workflows/ci.yml');
  const nightlyYmlPath = path.join(root, '.github/workflows/nightly.yml');
  const clientPkgPath = path.join(root, 'client/package.json');
  const rootCargoPath = path.join(root, 'Cargo.toml');
  const serverCargoPath = path.join(root, 'server-module/Cargo.toml');
  const devcontainerPath = path.join(root, '.devcontainer/devcontainer.json');
  const biomePath = path.join(root, 'biome.json');

  let justfile, ciYml, nightlyYml, clientPkg, rootCargo, serverCargo, devcontainer, biomeJson;

  try {
    justfile = readFileSync(justfilePath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read justfile' };
  }

  try {
    ciYml = readFileSync(ciYmlPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read .github/workflows/ci.yml' };
  }

  try {
    nightlyYml = readFileSync(nightlyYmlPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read .github/workflows/nightly.yml' };
  }

  try {
    clientPkg = readFileSync(clientPkgPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read client/package.json' };
  }

  try {
    rootCargo = readFileSync(rootCargoPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read root Cargo.toml' };
  }

  try {
    serverCargo = readFileSync(serverCargoPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read server-module/Cargo.toml' };
  }

  try {
    devcontainer = readFileSync(devcontainerPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read .devcontainer/devcontainer.json' };
  }

  try {
    biomeJson = readFileSync(biomePath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read biome.json' };
  }

  // Criterion (i)
  if (!lintRecipeIsComplete(justfile)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (i) FAIL: justfile lint: recipe body must contain cargo fmt, --check, and biome check — currently has only cargo clippy',
    };
  }

  // Criterion (ii) — both workflow files
  if (!allUsesAreSHAPinned(ciYml)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (ii) FAIL: .github/workflows/ci.yml has uses: lines not pinned to a 40-hex SHA (e.g. @v4, @v2, @stable, @v0, @v0.4.0)',
    };
  }
  if (!allUsesAreSHAPinned(nightlyYml)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (ii) FAIL: .github/workflows/nightly.yml has uses: lines not pinned to a 40-hex SHA',
    };
  }

  // Criterion (iii)
  if (!clientPackageHasEnginesNode(clientPkg)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (iii) FAIL: client/package.json must declare engines.node === ">=24.13.1 <25" — currently absent',
    };
  }

  // Criterion (iv) — two files
  if (!rootCargoHasLogWorkspaceDep(rootCargo)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (iv) FAIL: root Cargo.toml [workspace.dependencies] must contain a log entry — currently absent',
    };
  }
  if (!serverModuleUsesLogWorkspace(serverCargo)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (iv) FAIL: server-module/Cargo.toml must use log.workspace = true — currently has log = "0.4" (direct pin)',
    };
  }

  // Criterion (v)
  if (!devcontainerHasPins(devcontainer)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (v) FAIL: .devcontainer/devcontainer.json must declare a Rust feature, node 24.13.1, and wasm-pack 0.15.0 — current file missing all three',
    };
  }

  // Criterion (vi)
  if (!biomeExcludesModuleBindings(biomeJson)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (vi) FAIL: biome.json files.includes must contain !client/src/module_bindings exclusion — currently absent',
    };
  }

  return {
    name,
    pass: true,
    detail:
      'all 6 criteria met: lint recipe complete (fmt+check+biome), all uses: SHA-pinned (ci+nightly), client engines.node pinned, log promoted to workspace dep + server-module uses workspace, devcontainer pins rust+node+wasm-pack, biome excludes module_bindings',
  };
}
