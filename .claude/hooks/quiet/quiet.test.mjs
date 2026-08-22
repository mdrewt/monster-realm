// Gate for the noise-filter hook. Run: node --test .claude/hooks/quiet/quiet.test.mjs
//
// DOCTRINE: the hook and the wrapper are exercised as REAL PROCESSES through their
// actual entry points, not by importing their internals. `guard-bash.mjs` carries
// the same note for the same reason — a hook whose stdin wiring silently breaks
// still passes every unit test written against its rule table, while filtering
// nothing at all in production.
//
// The fixtures in fixtures/ are REAL captured output from this workspace's own
// tools (cited in quiet-profiles.mjs). The signal-preservation test below replays
// them and asserts that the exact lines an agent needs in order to DEBUG survive
// the filter. That test is the one that matters: a filter that saves tokens by
// eating the panic message is a regression, not an optimisation.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createFilter,
  isRewritableShape,
  normaliseLine,
  selectProfile,
  stripAnsi,
} from './quiet-lib.mjs';
import { PROFILES } from './quiet-profiles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'quiet-bash.mjs');
const RUNNER = join(HERE, 'quiet-run.mjs');
const fixture = (n) => readFileSync(join(HERE, 'fixtures', n), 'utf8');

const ESC = String.fromCharCode(27);

// Isolate the wrapper's log root: the real one is shared with live sessions, and
// quiet-run prunes across every session directory it finds there. lefthook runs
// `just test` pre-commit, so an un-isolated suite would delete other agents' logs.
const LOG_ROOT = mkdtempSync(join(tmpdir(), 'quiet-test-logs-'));
const WRAPPER_ENV = { ...process.env, CLAUDE_QUIET_LOG_ROOT: LOG_ROOT };

function runHook(toolInput, extra = {}) {
  const payload = JSON.stringify({
    session_id: 'test-session',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: toolInput,
    tool_use_id: 'toolu_test',
    ...extra,
  });
  const res = spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8' });
  assert.equal(res.status, 0, 'the hook must always exit 0 — it may never block a tool call');
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}

const rewrittenCommand = (toolInput) =>
  runHook(toolInput)?.hookSpecificOutput?.updatedInput?.command ?? null;

/** Replay a fixture through the profile the command selects. */
function replay(command, text, opts = {}) {
  const profile = selectProfile(PROFILES, command);
  assert.ok(profile, `no profile selected for: ${command}`);
  const f = createFilter(profile, {
    targeted: Boolean(profile.targeted?.(command)),
    capKeptAt: profile.capKeptAt ?? null,
    ...opts,
  });
  const shown = [];
  for (const line of text.split('\n')) {
    const out = f.push(line);
    if (out !== null) shown.push(out);
  }
  shown.push(...f.finish(opts.exitCode ?? 0));
  return { text: shown.join('\n'), lines: shown, state: f.state, profile };
}

// ---------------------------------------------------------------------------
// SIGNAL PRESERVATION — the test that matters most
// ---------------------------------------------------------------------------

const DEBUG_ANCHORS = [
  {
    what: 'a panicking Rust test under nextest',
    command: 'cargo nextest run --workspace',
    file: 'nextest-fail.txt',
    anchors: [
      'FAIL [',
      'panicked at src/lib.rs:7:28',
      'assertion `left == right` failed: math is broken',
      'left: 2',
      'right: 3',
      'tests::bad_two',
    ],
  },
  {
    what: 'a failing node:test assertion',
    command: 'node --test x.test.mjs',
    file: 'node-test-fail.txt',
    // `ℹ pass N` / `ℹ fail N` are not merely informative: monster-realm's `test:`
    // recipe PARSES those two lines and fails the gate on them. Dropping them
    // would break a gate, not just a display.
    anchors: ['AssertionError', 'x.test.mjs:5', 'ℹ fail 1', 'ℹ pass 2'],
  },
  {
    what: 'a failing vitest deep-equal',
    command: 'npx vitest run',
    file: 'vitest-fail.txt',
    anchors: ['AssertionError', 'Failed Tests', 'src/a.test.ts:5:62', 'fails deep equal'],
  },
  {
    what: 'clippy denying warnings',
    command: 'cargo clippy --workspace --all-targets --all-features -- -D warnings',
    file: 'clippy-fail.txt',
    anchors: [
      'error: value assigned to `s` is never read',
      '--> src/lib.rs:12:5',
      'unneeded `return` statement',
    ],
  },
];

for (const c of DEBUG_ANCHORS) {
  test(`signal preserved: ${c.what}`, () => {
    const { text } = replay(c.command, fixture(c.file), { exitCode: 1 });
    for (const anchor of c.anchors) {
      assert.ok(text.includes(anchor), `filter ate a debugging anchor: ${JSON.stringify(anchor)}`);
    }
  });
}

test('a failing run is barely filtered at all', () => {
  // The whole design intent in one assertion: green sweeps collapse ~99%, failures
  // stay essentially intact, because the failure body matches no rule and
  // unmatched lines are kept.
  const raw = fixture('nextest-fail.txt');
  const { text } = replay('cargo nextest run --workspace', raw, { exitCode: 1 });
  assert.ok(
    text.length > raw.length * 0.6,
    `failure output should survive mostly intact, kept ${text.length}/${raw.length}`,
  );
});

// ---------------------------------------------------------------------------
// NOISE REMOVAL — the savings actually materialise
// ---------------------------------------------------------------------------

test('a green nextest sweep collapses to the scope line and the verdict', () => {
  const { text, lines } = replay('cargo nextest run --workspace', fixture('nextest-green.txt'));
  assert.ok(text.includes('Summary ['), 'the verdict must survive');
  assert.ok(text.includes('Starting'), 'the test count must survive');
  assert.equal(
    lines.filter((l) => /\bPASS \[/.test(l)).length,
    0,
    'no per-test PASS line survives a sweep',
  );
});

test('a green eval run is replaced by a SYNTHESISED summary', () => {
  // evals/run.mjs prints one line per eval and NO summary of its own (read it:
  // evals/run.mjs:36-39). Withholding the pass lines without synthesising a
  // summary would leave a green run showing literally nothing.
  const { text } = replay('node evals/run.mjs', fixture('evals-green.txt'));
  assert.match(text, /evals: \d+ passed/);
  assert.ok(!text.includes('eval PASS:'), 'individual eval PASS lines are withheld on a sweep');
});

test('biome keeps every diagnostic location and drops only the rendering', () => {
  const { text } = replay('npx biome check .', fixture('biome-green.txt'));
  assert.match(text, /biome\.json:16:13/, 'file:line:col of each diagnostic must survive');
  assert.ok(!text.includes('│'), 'code frames and fix diffs are dropped');
});

test('node:test withholds pass lines but never the parsed counts', () => {
  const { text } = replay(
    'node --test ops/observability/validate.test.mjs',
    fixture('node-test-green.txt'),
  );
  assert.match(text, /[ℹi]\s+pass\s+\d+/);
  assert.ok(!/^\s*[✔√]\s/m.test(text), 'per-test pass lines are withheld');
});

test('a green vitest run is not made worse', () => {
  // The corpus counterexample: 2,463 tests in 271 bytes. A filter that added
  // ceremony here would be a net loss on the most-run test command in the repo.
  const raw = fixture('vitest-green.txt');
  const { text } = replay('npx vitest run', raw);
  assert.ok(text.length <= raw.length, 'filtering must never grow the output');
  assert.match(text, /Tests\s+2463 passed/);
});

// ---------------------------------------------------------------------------
// TARGETED vs SWEEP — the operator's rule
// ---------------------------------------------------------------------------

test('a targeted run keeps its passing lines; the same sweep withholds them', () => {
  const raw = fixture('nextest-green.txt');
  const sweep = replay('cargo nextest run --workspace', raw);
  const targeted = replay('cargo nextest run -p game-core', raw);
  assert.equal(targeted.state.targeted, true);
  assert.equal(sweep.state.targeted, false);
  assert.ok(
    targeted.lines.filter((l) => /\bPASS \[/.test(l)).length > 0,
    'a run scoped to what was just worked on must show that its tests passed',
  );
});

test('scope detection', () => {
  const scopeOf = (cmd) => {
    const p = selectProfile(PROFILES, cmd);
    return p ? Boolean(p.targeted?.(cmd)) : null;
  };
  assert.equal(scopeOf('cargo nextest run --workspace'), false);
  assert.equal(scopeOf('cargo nextest run -p game-core'), true);
  assert.equal(scopeOf('cargo nextest run -p game-core --workspace'), false, '--workspace wins');
  assert.equal(scopeOf('node evals/run.mjs'), false);
  assert.equal(scopeOf('node evals/conversation-privacy.eval.mjs'), true);
  assert.equal(scopeOf('cd client && npx vitest run src/ui/foo.test.ts'), true);
  assert.equal(scopeOf('cd client && npx vitest run'), false);
});

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

test('stripAnsi removes CSI colour and OSC hyperlink sequences', () => {
  assert.equal(stripAnsi(`${ESC}[32mPASS${ESC}[0m ok`), 'PASS ok');
  assert.equal(stripAnsi(`${ESC}]8;;https://x${ESC}\\link${ESC}]8;;${ESC}\\`), 'link');
});

test('a carriage-return progress redraw collapses to its final frame', () => {
  // npm, cargo and wasm-pack all redraw a spinner on one physical line. Treating
  // each frame as a line would MULTIPLY output rather than shrink it.
  assert.equal(normaliseLine('10%\r50%\r100% done'), '100% done');
});

// ---------------------------------------------------------------------------
// command shape — the fail-open boundary
// ---------------------------------------------------------------------------

test('rewritable shapes: one simple command, optionally cd- or env-prefixed', () => {
  for (const cmd of [
    'cargo nextest run --workspace',
    'cd client && npx vitest run',
    'RUST_LOG=debug cargo test',
    "cargo nextest run -E 'test(foo)'",
    'just ci',
  ]) {
    assert.equal(isRewritableShape(cmd), true, `expected rewritable: ${cmd}`);
  }
});

test('anything the hook cannot read literally is left completely alone', () => {
  for (const cmd of [
    'cargo test 2>&1 | tail -50', // the agent is ALREADY filtering; do not second-guess it
    'npm ci && npm test', // two commands: which profile would even apply?
    'echo $(date)',
    'cargo test `echo x`',
    'cargo test > out.txt',
    'cargo test; ls',
    'cargo test\nls',
    "cargo nextest run -E 'test(foo", // unbalanced quote
  ]) {
    assert.equal(isRewritableShape(cmd), false, `expected NOT rewritable: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// the hook process
// ---------------------------------------------------------------------------

test('a recognised noisy command becomes a single quiet-run invocation', () => {
  const cmd = rewrittenCommand({ command: 'cargo nextest run --workspace' });
  assert.ok(cmd, 'expected a rewrite');
  assert.match(cmd, /^node "[^"]*quiet-run\.mjs" --profile=\S+ --sid=\S+ --b64=[A-Za-z0-9_-]+$/);
  // Load-bearing: the REWRITTEN command is re-parsed by the permission layer, and
  // anything it reads as "multiple operations" is rejected outright (measured
  // against Claude Code 2.1.240 with a live probe).
  assert.doesNotMatch(cmd, /[;&|<>`$()]/, 'the rewrite must contain no shell operator');
});

test('the original command survives the round trip byte-for-byte', () => {
  const original = "cd client && npx vitest run src/foo.test.ts -t 'name with spaces'";
  const cmd = rewrittenCommand({ command: original });
  const b64 = cmd.match(/--b64=([A-Za-z0-9_-]+)$/)[1];
  assert.equal(Buffer.from(b64, 'base64url').toString('utf8'), original);
});

test('tool_input fields other than command are preserved', () => {
  const updated = runHook({
    command: 'cargo nextest run --workspace',
    description: 'Run the suite',
    run_in_background: true,
    timeout: 600000,
  }).hookSpecificOutput.updatedInput;
  assert.equal(updated.run_in_background, true);
  assert.equal(updated.timeout, 600000);
  assert.match(updated.description, /noise-filtered/);
});

test('NOFILTER=1 declines the rewrite', () => {
  assert.equal(rewrittenCommand({ command: 'NOFILTER=1 cargo nextest run --workspace' }), null);
});

test('an already-wrapped command is never wrapped twice', () => {
  // The hook is wired at BOTH user and project level on purpose; double-wrapping
  // would make the wrapper try to run itself.
  const once = rewrittenCommand({ command: 'cargo nextest run --workspace' });
  assert.equal(rewrittenCommand({ command: once }), null);
});

test('ordinary commands are never touched', () => {
  for (const cmd of [
    'ls -la',
    'cat README.md',
    'git commit -m x',
    'git status',
    'echo hi',
    'cargo metadata --format-version 1',
  ]) {
    assert.equal(rewrittenCommand({ command: cmd }), null, `must not rewrite: ${cmd}`);
  }
});

test('non-Bash tools and malformed input never block a tool call', () => {
  const inputs = [
    JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } }),
    '',
    'not json',
    '{}',
    '{"tool_name":"Bash"}',
    '{"tool_name":"Bash","tool_input":{}}',
  ];
  for (const input of inputs) {
    const res = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
    assert.equal(res.status, 0, `hook must exit 0 on: ${input}`);
    assert.equal(res.stdout.trim(), '', `hook must stay silent on: ${input}`);
  }
});

test('CLAUDE_QUIET_BASH=0 is a global off switch', () => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'cargo nextest run --workspace' },
    }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_QUIET_BASH: '0' },
  });
  assert.equal(res.stdout.trim(), '');
});

// ---------------------------------------------------------------------------
// the wrapper process
// ---------------------------------------------------------------------------

test('the wrapper refuses any command matching no profile (anti-laundering)', () => {
  // Rewriting means a `cargo` call reaches the permission layer as a `node` call.
  // Without this refusal, anything hand-crafted into --b64 would inherit the
  // wrapper's allow rule — a permission-laundering hole.
  const b64 = Buffer.from('cat /etc/passwd', 'utf8').toString('base64url');
  const res = spawnSync(process.execPath, [RUNNER, `--sid=t`, `--b64=${b64}`], {
    encoding: 'utf8',
    env: WRAPPER_ENV,
  });
  assert.equal(res.status, 78);
  assert.match(res.stderr, /matches no filter profile/);
});

test('the wrapper propagates the child exit code and filters real output', () => {
  const b64 = Buffer.from('just --unknown-flag-xyz', 'utf8').toString('base64url');
  const res = spawnSync(process.execPath, [RUNNER, '--sid=t', `--b64=${b64}`], {
    encoding: 'utf8',
    env: WRAPPER_ENV,
  });
  assert.notEqual(res.status, 0, 'a failing command must not come back as success');
  assert.match(res.stdout, /\[quiet-run/, 'the banner must name the filter');
});

// ---------------------------------------------------------------------------
// engine invariants
// ---------------------------------------------------------------------------

test('unmatched lines are always kept (fail open)', () => {
  const { text } = replay(
    'cargo nextest run --workspace',
    'some totally unrecognised tool output\nand another line',
  );
  assert.ok(text.includes('some totally unrecognised tool output'));
  assert.ok(text.includes('and another line'));
});

test('verbose does NOT resurrect the pass wall', () => {
  // Measured regression: an earlier build promoted deferred lines on verbose, so
  // re-running a red 1,590-test suite handed back every passing test name — the
  // exact noise the hook exists to remove.
  const { lines } = replay('cargo nextest run --workspace', fixture('nextest-green.txt'), {
    verbose: true,
  });
  assert.equal(lines.filter((l) => /\bPASS \[/.test(l)).length, 0);
});

test('a small withheld block is replayed verbatim rather than summarised away', () => {
  const raw = ['        PASS [   0.001s] (1/2) pkg a', '        PASS [   0.001s] (2/2) pkg b'].join(
    '\n',
  );
  const { text } = replay('cargo nextest run --workspace', raw);
  assert.ok(
    text.includes('pkg a') && text.includes('pkg b'),
    'two withheld lines cost nothing to show in full',
  );
});

test('the search profile only caps — it removes no content', () => {
  const p = PROFILES.find((x) => x.name === 'search');
  assert.deepEqual(p.rules, [], 'search must carry no drop/defer rules');
  const raw = Array.from({ length: 500 }, (_, i) => `f.ts:${i}: match`).join('\n');
  const { lines, state } = replay('grep -rn foo .', raw);
  assert.equal(state.kept, p.capKeptAt);
  assert.ok(lines.join('\n').includes('more are in the raw log'));
});

test('grep in counting/listing mode is left alone entirely', () => {
  for (const cmd of ['grep -c foo x', 'grep -l foo .', 'grep -rq foo .', 'grep --count foo x']) {
    assert.equal(selectProfile(PROFILES, cmd), null, `must not claim: ${cmd}`);
  }
});

test('every registered profile is well formed', () => {
  const seen = new Set();
  for (const p of PROFILES) {
    assert.equal(typeof p.name, 'string');
    assert.ok(!seen.has(p.name), `duplicate profile name: ${p.name}`);
    seen.add(p.name);
    assert.equal(typeof p.match, 'function');
    assert.ok(Array.isArray(p.rules));
    for (const r of p.rules) {
      assert.ok(
        ['keep', 'drop', 'defer'].includes(r.action),
        `${p.name}/${r.id}: bad action ${r.action}`,
      );
      assert.ok(r.re instanceof RegExp, `${p.name}/${r.id}: rule must carry a regex literal`);
      // A /g regex is stateful across .test() calls and would match every other
      // line — a silent, intermittent filter bug.
      assert.equal(r.re.global, false, `${p.name}/${r.id}: rule regex must not be /g`);
    }
  }
});

test('the `just` composite inherits every tool group it can encounter', () => {
  // `just ci` was measured at 313,415 B across cargo, node:test, biome, the eval
  // harness and criterion. If a group is ever dropped from the union, the biggest
  // single command in the workspace silently stops being filtered.
  const just = PROFILES.find((p) => p.name === 'just');
  const ids = just.rules.map((r) => r.id.split('/')[0]);
  for (const group of [
    'nextest',
    'libtest',
    'nodetest',
    'vitest',
    'biome',
    'evals',
    'criterion',
    'cargo',
  ]) {
    assert.ok(ids.includes(group), `just composite is missing the ${group} rule group`);
  }
});

// ---------------------------------------------------------------------------
// research invariants I4 and §1.2-3 (added after the capture pass)
// ---------------------------------------------------------------------------

test('no rule may drop a line that names a source location', () => {
  // Both of these are REAL loss modes found by the capture pass: a #[should_panic]
  // failure reports its location only in a `note:` line, and a failing doctest
  // anchors on a `---- path (line N) stdout ----` header. Neither carries a
  // failure keyword, so neither is protected by any keep rule.
  const lines = [
    'note: test did not panic as expected at src/lib.rs:35:8',
    '---- src/lib.rs - name (line 4) stdout ----',
    'src/ui/foo.ts:12:5 something went wrong',
  ];
  for (const profile of PROFILES) {
    const f = createFilter(profile, { capKeptAt: profile.capKeptAt ?? null });
    for (const line of lines) {
      assert.equal(f.push(line), line, `${profile.name} dropped a source location: ${line}`);
    }
  }
});

test('the source-location guard does not exempt the search cap', () => {
  // grep output is nothing BUT file:line references. If the guard overrode the
  // positional cap, the one profile the cap exists for would be exempt from it.
  const p = PROFILES.find((x) => x.name === 'search');
  const f = createFilter(p, { capKeptAt: p.capKeptAt });
  for (let i = 0; i < 500; i++) f.push(`src/a.ts:${i}: match`);
  assert.equal(f.state.kept, p.capKeptAt);
});

test('watch and interactive commands are never wrapped', () => {
  // Wrapping a watcher hands the agent a process that never prints its banner;
  // wrapping a TTY-dependent form changes what the tool does.
  for (const cmd of [
    'npx vitest --watch',
    'npx vitest run --ui',
    'npx playwright test --headed',
    'cargo watch -x test',
    'npm run dev',
    'spacetime logs monster-realm',
  ]) {
    assert.equal(isRewritableShape(cmd), false, `must not wrap: ${cmd}`);
  }
  // ...but an ordinary short flag that merely looks interactive is still wrapped.
  assert.equal(
    isRewritableShape('grep -i foo src'),
    true,
    '-i is case-insensitive, not interactive',
  );
});

// ---------------------------------------------------------------------------
// regressions found by the adversarial review pass
// ---------------------------------------------------------------------------

test('a test filter that matched nothing is never mistaken for a green run', () => {
  // `cargo test some_typo` EXITS 0. The only line distinguishing it from success is
  // the `N filtered out` tally. An earlier build dropped that whole line shape, which
  // made a typo indistinguishable from a passing run — a false green.
  const { text } = replay(
    'cargo test nonexistent_filter_typo',
    [
      '   Compiling cp v0.1.0 (/x)',
      '     Running unittests src/lib.rs (target/debug/deps/cp-abc)',
      'running 0 tests',
      'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s',
    ].join('\n'),
  );
  assert.match(
    text,
    /2 filtered out/,
    'the agent must be able to see that its filter matched nothing',
  );
});

test('withheld routine lines are NOT replayed after a failure verdict', () => {
  // finish() emits at the end of the stream, so replaying passes on a red run puts
  // them AFTER the failure — reading as though they happened last, at exactly the
  // moment the agent is working out what broke.
  const raw = [
    '        PASS [   0.001s] (1/2) pkg a',
    '        PASS [   0.001s] (2/2) pkg b',
    'error: test run failed',
  ].join('\n');
  const green = replay('cargo nextest run --workspace', raw, { exitCode: 0 });
  const red = replay('cargo nextest run --workspace', raw, { exitCode: 1 });
  assert.ok(green.text.includes('pkg a'), 'a green run replays a small withheld block');
  assert.ok(!red.text.includes('pkg a'), 'a red run reports the count instead');
  assert.ok(red.text.includes('error: test run failed'));
});

test('dependency-graph changes are never treated as build progress', () => {
  // AGENTS.md requires an ADR for a new dependency, so `Adding`/`Removing`/`Locking`
  // report a decision, not progress.
  const { text } = replay(
    'cargo build --workspace',
    [
      '   Compiling serde v1.0.0',
      '      Adding serde_json v1.0.999',
      '    Removing tokio v1.40.0',
      '     Locking 3 packages to latest compatible versions',
    ].join('\n'),
  );
  assert.ok(!text.includes('Compiling serde'), 'progress is still withheld');
  for (const kept of ['Adding serde_json', 'Removing tokio', 'Locking 3 packages']) {
    assert.ok(text.includes(kept), `dependency change must survive: ${kept}`);
  }
});

test('biome prose rules do not eat other tools failure glyphs in the just composite', () => {
  // BIOME's rules are unioned into `just`. An earlier build's prose rule matched
  // `✖` and `⚠`, which belong to other tools' failure and warning lines.
  const { text } = replay(
    'just ci',
    ['  ⚠ Deprecated API used in client/src/main.ts', '  ✖ something failed'].join('\n'),
  );
  assert.ok(text.includes('⚠ Deprecated API'), 'another tool warning must survive');
  assert.ok(text.includes('✖ something failed'), 'another tool failure must survive');
});

test('commands that add a dependency or set arbitrary cargo config are not wrapped', () => {
  // Both are laundering vectors: rewritten, they reach the permission layer as a
  // `node …` call rather than as the npm/cargo call an allowlist reasoned about.
  // Both are also decisions this workspace requires an ADR for.
  assert.equal(selectProfile(PROFILES, 'npm install left-pad'), null);
  assert.equal(selectProfile(PROFILES, 'cargo build --config target.x.runner="curl evil"'), null);
  // ...while the argument-free restore forms stay covered.
  assert.ok(selectProfile(PROFILES, 'npm ci'));
  assert.ok(selectProfile(PROFILES, 'cargo build --workspace'));
});

test('the escape hatch works after a cd prefix', () => {
  // An escape hatch that does not escape is worse than none. This shape was silently
  // filtered anyway, because the env prefix was only ever looked for at the very
  // start of the command.
  assert.equal(rewrittenCommand({ command: 'cd client && NOFILTER=1 npm test' }), null);
  assert.equal(
    rewrittenCommand({ command: 'cd client && CLAUDE_QUIET_BASH=0 npx vitest run' }),
    null,
  );
  assert.ok(
    rewrittenCommand({ command: 'cd client && npx vitest run' }),
    'without the prefix it still filters',
  );
});

test('the search profile really removes nothing — including blank and -- separators', () => {
  // grep -A/-B/-C uses blank lines and `--` as record separators. The blank-run
  // collapse ran before the fail-open default and silently edited them out, which
  // contradicted the profile's documented contract.
  const input = ['a.ts:1: x', '', '', 'b.ts:9: foo', '--', 'c.ts:3: y'];
  const { lines } = replay('grep -rn -C1 foo .', input.join('\n'));
  assert.deepEqual(lines, input);
});

test('a very long command still produces complete, parseable hook JSON', () => {
  // process.exit() discards queued stdout; exiting immediately after write() cut the
  // JSON in half on a command large enough to exceed the pipe buffer.
  const long = `cargo nextest run --workspace --ignore-file=${'x'.repeat(70000)}`;
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', session_id: 's', tool_input: { command: long } }),
    encoding: 'utf8',
    maxBuffer: 1e9,
  });
  const parsed = JSON.parse(res.stdout);
  assert.equal(
    Buffer.from(
      parsed.hookSpecificOutput.updatedInput.command.match(/--b64=([A-Za-z0-9_-]+)$/)[1],
      'base64url',
    ).toString('utf8'),
    long,
  );
});

test('no source file carries a NUL byte', () => {
  // A raw NUL makes the file binary to git and grep — no line-level diff and no
  // `git grep`, in a repo whose entire review workflow is diffs.
  for (const f of [
    'quiet-lib.mjs',
    'quiet-profiles.mjs',
    'quiet-run.mjs',
    'quiet-bash.mjs',
    'quiet.test.mjs',
  ]) {
    assert.ok(!readFileSync(join(HERE, f)).includes(0), `${f} contains a NUL byte`);
  }
});

test('the search profile preserves a carriage return inside match content', () => {
  // The CR collapse exists for progress bars. A grep hit on a file that CONTAINS a
  // carriage return is content, not ceremony — this silently truncated
  // `data.txt:3: before<CR>after` to `after` in the one profile that promises to
  // remove no match content.
  const line = `data.txt:3: before${String.fromCharCode(13)}after`;
  const { lines } = replay('grep -rn foo .', line);
  assert.deepEqual(lines, [line]);
});

test('progress-bar redraws still collapse everywhere else', () => {
  const { lines } = replay('npm ci', `10%${String.fromCharCode(13)}100% done`);
  assert.deepEqual(lines, ['100% done']);
});

test('the wrapper keeps no cross-run state', () => {
  // A "verbose on re-run after failure" mode was removed because every safe version
  // of it changed zero output bytes. Its bookkeeping outlived it: the wrapper kept
  // reading, pruning and rewriting a shared JSON file on every single command that
  // nothing ever read back. Dead I/O in the hot path of every filtered command.
  const src = readFileSync(join(HERE, 'quiet-run.mjs'), 'utf8');
  for (const gone of ['recent-failures', 'recordOutcome', 'readState', 'RERUN_WINDOW_MS']) {
    assert.ok(!src.includes(gone), `quiet-run.mjs still carries dead re-run state: ${gone}`);
  }
});

test('a command that prints nothing is left byte-identical', () => {
  // `cargo fmt --all --check` and `tsc --noEmit` are silent when clean, and both run
  // constantly. A banner there is pure cost with no signal behind it — the filter must
  // never turn a zero-byte result into a non-zero one. Uses grep-with-no-match as a
  // deterministic silent command that is guaranteed present and exits non-zero.
  const dir = mkdtempSync(join(tmpdir(), 'quiet-silent-'));
  const file = join(dir, 'haystack.txt');
  writeFileSync(file, 'alpha\nbeta\n');
  const b64 = Buffer.from(`grep -rn zzz-definitely-no-match ${file}`, 'utf8').toString('base64url');
  const res = spawnSync(process.execPath, [RUNNER, '--sid=t', `--b64=${b64}`], {
    encoding: 'utf8',
    env: WRAPPER_ENV,
  });
  assert.equal(res.status, 1, 'grep with no match exits 1, and that must pass through');
  assert.equal(
    res.stdout,
    '',
    `a silent command must stay silent, got: ${JSON.stringify(res.stdout)}`,
  );
});
