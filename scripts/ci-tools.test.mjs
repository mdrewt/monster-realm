// SpacetimeDB versions move in lockstep (docs/DECISIONS.md, "SpacetimeDB versions move in
// lockstep"). These tests read what the tools produce: cargo's resolution of the workspace, npm's
// lockfile and the bindings `spacetime generate` writes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BINDINGS = 'client/src/module_bindings/index.ts';
const NPM_LOCK = 'client/package-lock.json';
const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';
// The two crates that build from the patched copies under vendor/.
const VENDORED = ['spacetimedb', 'spacetimedb-bindings-sys'];
const CARGO_METADATA = ['metadata', '--format-version', '1', '--locked', '--offline'];
const GENERATED_BY = 'generated using spacetimedb cli version';
const HEADER = /^\/\/ This was generated using spacetimedb cli version (\S+) \(commit (\S+)\)\.$/;
const CLI_VERSION = /^\s*cliVersion: "([^"]*)" as const,?$/;

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const listed = (title, items) => [title, ...items].join('\n  ');

// `cargo metadata` for the workspace, resolved from the lockfile as it stands with no network,
// run once and shared by both tests.
let cached;
function metadata() {
  if (cached === undefined) {
    const run = spawnSync('cargo', CARGO_METADATA, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    assert.equal(run.error, undefined, `cargo metadata could not run: ${run.error?.message}`);
    assert.equal(run.status, 0, `cargo metadata exited ${run.status}: ${run.stderr}`);
    cached = JSON.parse(run.stdout);
  }
  return cached;
}

// The packages cargo resolves under the name `spacetimedb` or `spacetimedb-*`.
const spacetimeCrates = (packages) =>
  packages.filter(({ name }) => name === 'spacetimedb' || name.startsWith('spacetimedb-'));

test('the SpacetimeDB crates, the npm SDK and the bindings resolve to one version (lpw-34.1)', () => {
  const { packages, workspace_root: workspaceRoot } = metadata();
  const crates = spacetimeCrates(packages);
  const version = crates.find(({ name }) => name === 'spacetimedb')?.version;
  const problems = [];
  const claims = crates.map((crate) => [`cargo metadata ${crate.name}`, crate.version]);
  for (const name of VENDORED) {
    const manifest = join(workspaceRoot, 'vendor', name, 'Cargo.toml');
    const found = crates.filter((crate) => crate.name === name);
    if (found.length !== 1 || found[0].source !== null || found[0].manifest_path !== manifest) {
      problems.push(`cargo metadata: expected one ${name}, built from ${manifest}`);
    }
  }
  for (const { name, version: crateVersion, source } of crates) {
    if (!VENDORED.includes(name) && source !== CRATES_IO) {
      problems.push(`cargo metadata: ${name} ${crateVersion} comes from ${source}`);
    }
  }

  const sdk = JSON.parse(read(NPM_LOCK)).packages?.['node_modules/spacetimedb'] ?? {};
  claims.push([`${NPM_LOCK} node_modules/spacetimedb`, sdk.version]);
  if (!sdk.resolved?.endsWith(`/spacetimedb-${version}.tgz`)) {
    problems.push(`${NPM_LOCK}: node_modules/spacetimedb resolves to ${sdk.resolved}`);
  }
  if (!sdk.integrity?.startsWith('sha512-')) {
    problems.push(`${NPM_LOCK}: node_modules/spacetimedb has integrity ${sdk.integrity}`);
  }

  const lines = read(BINDINGS).split('\n');
  const headers = lines.filter((line) => line.includes(GENERATED_BY));
  const header = headers.length === 1 ? HEADER.exec(headers[0]) : null;
  if (header === null || !/^[0-9a-f]{40}$/.test(header[2])) {
    problems.push(`${BINDINGS}: no single generated-by line: ${JSON.stringify(headers)}`);
  } else {
    claims.push([`${BINDINGS} generated-by line`, header[1]]);
  }
  const cliLines = lines.filter((line) => /\bcliVersion\b/.test(line));
  const cli = cliLines.length === 1 ? CLI_VERSION.exec(cliLines[0]) : null;
  if (cli === null) {
    problems.push(`${BINDINGS}: no single cliVersion line: ${JSON.stringify(cliLines)}`);
  } else {
    claims.push([`${BINDINGS} cliVersion`, cli[1]]);
  }

  for (const [source, claimed] of claims) {
    if (claimed !== version) {
      problems.push(`${source}: ${claimed}`);
    }
  }
  const report = listed(`the spacetimedb crate is ${version}; these disagree:`, problems);
  assert.deepEqual(problems, [], report);
});

test('the workspace builds the spacetimedb crate with its unstable feature (lpw-34.7)', () => {
  const { packages, resolve } = metadata();
  for (const name of VENDORED) {
    const ids = packages.filter((p) => p.name === name).map((p) => p.id);
    assert.equal(ids.length, 1, `cargo metadata: ${ids.length} ${name} packages, expected one`);
    const node = resolve?.nodes.find(({ id }) => id === ids[0]);
    const features = node?.features ?? [];
    assert.ok(
      features.some((feature) => feature === 'unstable'),
      `cargo metadata: ${name} resolves with features ${JSON.stringify(features)}`,
    );
  }
});
