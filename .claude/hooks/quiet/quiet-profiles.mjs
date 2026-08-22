// quiet-profiles.mjs — what counts as noise, per tool.
//
// EVERY rule below was written against REAL captured output from this workspace,
// not from memory of what these tools print. The captures are cited per group.
// Adding a rule without a capture to justify it is how a filter starts eating
// signal, so: capture first, then write the regex, then add a test.
//
// Rule actions:
//   keep   emit immediately, in stream order
//   drop   never emit (pure ceremony: progress, timing, separators)
//   defer  withhold, count, and summarise at the end — used for "routine success"
//          lines, which are noise on a full sweep but SIGNAL on a targeted run
//          (a targeted run promotes every defer to keep; see quiet-lib.mjs)
//
// Anything matching no rule is KEPT. Every profile relies on that: the rules
// enumerate what is safe to remove, never what is allowed through.

// ---------------------------------------------------------------------------
// Shared rule groups
// ---------------------------------------------------------------------------

// cargo's build chatter. Measured: a cold `cargo clippy` run is ~150 of these
// before the first real diagnostic (scratchpad/cargo-clippy-fail.txt), and a
// green `just ci` carries 228 `Compiling` + 99 `Checking` lines
// (/tmp/16ra_ci.log). On a green build they carry no information; on a red one
// the error block that follows is matched by nothing and therefore kept whole.
const CARGO_PROGRESS = [
  // `Adding` / `Removing` / `Updating` / `Locking` are deliberately NOT in this
  // list: they report a dependency-graph CHANGE, which this workspace treats as a
  // decision requiring an ADR — not as build progress.
  {
    id: 'cargo/compiling',
    action: 'drop',
    re: /^\s{2,}(?:Compiling|Checking|Downloading|Downloaded|Installing|Fresh|Packaging|Verifying|Compressing|Uploading)\s/,
  },
  { id: 'cargo/finished', action: 'drop', re: /^\s{2,}Finished\s[`'"]?\w/ },
  { id: 'cargo/blocking', action: 'drop', re: /^\s{2,}Blocking waiting for file lock/ },
  // `Running unittests src/lib.rs (target/debug/deps/foo-abc123)` is the ONLY
  // per-binary attribution libtest emits. DEFER, not drop: on a workspace sweep a
  // crate whose tests all compiled out would otherwise vanish without trace, and
  // the count is what makes its absence visible.
  {
    id: 'cargo/running-bin',
    action: 'defer',
    re: /^\s{2,}Running\s+(?:unittests\s+)?\S+\s+\(target\//,
  },
  { id: 'cargo/doctests-hdr', action: 'drop', re: /^\s{2,}Doc-tests\s/ },
];

// libtest (`cargo test`, and the captured stdout nextest shows inside a failure
// block — hence the leading \s* on each: inside nextest they arrive indented).
// Captured: scratchpad/fail2/nx.err, scratchpad/cargo-test-cold-fail.txt.
const LIBTEST = [
  { id: 'libtest/fail', action: 'keep', re: /^\s*test\s+\S+\s\.\.\.\s+FAILED/ },
  { id: 'libtest/ok', action: 'defer', re: /^\s*test\s+\S+\s\.\.\.\s+ok$/ },
  { id: 'libtest/ignored', action: 'defer', re: /^\s*test\s+\S+\s\.\.\.\s+ignored/ },
  // The five identical `running 0 tests` / `test result: ok. 0 passed` blocks a
  // workspace doctest run emits (measured: 31 lines, 781 B, all ceremony).
  // `0 filtered out` is the load-bearing part of this pattern, not decoration.
  // `cargo test some_typo` exits 0 and prints
  //   `test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out`
  // — the ONLY line telling the agent its filter matched nothing. Dropping that
  // shape made a typo indistinguishable from a green run. Only the genuinely empty
  // ceremony (`0 filtered out`, as emitted five times by a workspace doctest run)
  // is withheld, and even then as a DEFER so the count survives.
  { id: 'libtest/running-0', action: 'defer', re: /^\s*running 0 tests$/ },
  {
    id: 'libtest/result-0',
    action: 'defer',
    re: /^\s*test result: ok\. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out/,
  },
  { id: 'libtest/running-n', action: 'defer', re: /^\s*running \d+ tests?$/ },
  { id: 'libtest/result-ok', action: 'keep', re: /^\s*test result: ok\./ },
  { id: 'libtest/result-bad', action: 'keep', re: /^\s*test result: FAILED/ },
];

// cargo-nextest. Captured green: scratchpad/raw/nextest_workspace.log — 1,952
// lines, 227,917 B, of which 1,942 are PASS lines (99.5% of the bytes).
// Captured red: scratchpad/fail2/nx.err.
const NEXTEST = [
  // Every non-PASS verdict is kept: FAIL, SLOW, TIMEOUT, LEAK, TRY n FAIL, SIGSEGV…
  { id: 'nextest/pass', action: 'defer', re: /^\s+PASS\s+\[\s*[\d.]+s\]\s/ },
  { id: 'nextest/skip', action: 'defer', re: /^\s+SKIP\s+\[\s*[\d.]+s\]\s/ },
  // LEAK sits at the SAME indent as PASS and the run still exits 0, so a
  // pass-shaped drop rule could hide it entirely. It is kept explicitly rather
  // than left to fail-open, because "the rule that would have hidden it does not
  // happen to match" is not a property worth depending on.
  {
    id: 'nextest/leak',
    action: 'keep',
    re: /^\s+(?:LEAK|TIMEOUT|SLOW|TRY \d+ FAIL|SIGSEGV|ABORT)\b/,
  },
  { id: 'nextest/start', action: 'keep', re: /^\s+Starting\s+\d+\s+tests?\s+across/ },
  { id: 'nextest/summary', action: 'keep', re: /^\s+Summary\s+\[/ },
  { id: 'nextest/cancel', action: 'keep', re: /^\s+Cancelling due to/ },
  // `Nextest run ID <uuid> with nextest profile: default` — the uuid is fresh
  // every run and is never actionable.
  { id: 'nextest/runid', action: 'drop', re: /^\s*Nextest run ID\s/ },
  { id: 'nextest/rule', action: 'drop', re: /^\s*─{4,}\s*$/ },
];

// Node's built-in runner. Captured: scratchpad/nodetest.out (62 ✔ lines = 91% of
// 7,572 B) and scratchpad/fail2/nt.out for the failure shape.
// `ℹ pass N` / `ℹ fail N` are KEPT — monster-realm's `test:` recipe parses exactly
// those two lines to decide the gate, and Node 24's default reporter spells them
// with `ℹ`, not TAP's `#`.
const NODE_TEST = [
  { id: 'nodetest/pass', action: 'defer', re: /^\s*[✔√]\s.*\(\d[\d.]*ms\)\s*$/ },
  // Three runners, three cross glyphs, byte-verified by the capture pass:
  // node:test ✖ U+2716, vitest × U+00D7, playwright ✘ U+2718.
  { id: 'nodetest/fail', action: 'keep', re: /^\s*[✖✗×✘]\s/ },
  { id: 'nodetest/counts', action: 'keep', re: /^[ℹi]\s+(?:tests|pass|fail)\s+\d+$/ },
  { id: 'nodetest/zero-counts', action: 'drop', re: /^[ℹi]\s+(?:cancelled|skipped|todo)\s+0$/ },
  { id: 'nodetest/noise-counts', action: 'drop', re: /^[ℹi]\s+(?:suites|duration_ms)\s/ },
  { id: 'nodetest/tap-ok', action: 'defer', re: /^ok \d+ - / },
  { id: 'nodetest/tap-notok', action: 'keep', re: /^not ok \d+ - / },
];

// vitest. Captured green: scratchpad/raw/vitest_run.log — 2,463 tests in 9 lines
// / 271 B, because the non-TTY reporter prints nothing per passing file. This is
// the COUNTEREXAMPLE in the corpus: vitest on green needs almost no filtering,
// and the profile is deliberately thin so it cannot make that case worse.
// Captured red: scratchpad/fail2/vt.out — the assertion diff and code frame match
// no rule and so survive whole, which is the point.
const VITEST = [
  { id: 'vitest/file-pass', action: 'defer', re: /^\s*[✓√]\s+\S+\.(?:test|spec)\.[jt]sx?\s/ },
  { id: 'vitest/file-fail', action: 'keep', re: /^\s*❯\s+\S+\.(?:test|spec)\.[jt]sx?\s/ },
  { id: 'vitest/case-fail', action: 'keep', re: /^\s*[×✗]\s/ },
  { id: 'vitest/totals', action: 'keep', re: /^\s*(?:Test Files|Tests|Errors)\s+\d/ },
  { id: 'vitest/banner', action: 'drop', re: /^\s*RUN\s+v[\d.]+\s/ },
  { id: 'vitest/startat', action: 'drop', re: /^\s*Start at\s+\d/ },
  { id: 'vitest/duration', action: 'drop', re: /^\s*Duration\s+[\d.]+m?s/ },
];

// biome. Captured: scratchpad/raw/biome_check.log — 365 lines / 18,566 B at
// EXIT 0, i.e. this fires on every green `just ci`.
//
// The judgement here is deliberately NOT "drop the diagnostics". Each diagnostic's
// HEADER line carries file:line:col plus the rule name — everything an agent needs
// to find and fix it, and enough to notice a NEW warning it just introduced. What
// gets withheld is the rendered code frame, the fix diff and the prose restatement
// of the rule, which together are ~95% of the bytes and are all recoverable from
// the file itself.
const BIOME = [
  { id: 'biome/diag-header', action: 'keep', re: /^\S+:\d+:\d+\s+\S+\s+.*━━━/ },
  {
    id: 'biome/totals',
    action: 'keep',
    re: /^(?:Checked|Found|Diagnostics not shown|The number of diagnostics)/,
  },
  // Two shapes, both measured in raw/biome_check.log: the plain code frame
  // (`  > 16 │ …`, `     │ ^^^^`) and the suggested-fix DIFF, which carries two
  // line numbers per row (`    2732 2732 │ …`). The first version of this rule
  // matched only the former and left ~70% of the fix diffs in place.
  { id: 'biome/codeframe', action: 'drop', re: /^\s*(?:>?\s*\d+(?:\s+\d+)?\s*│|\s+│)/ },
  // Biome's own prose markers only (`  i `, `  ! `). `✖` and `⚠` were removed: this
  // rule is unioned into the `just` composite, where those glyphs belong to other
  // tools' failure and warning lines.
  { id: 'biome/prose', action: 'drop', re: /^\s{2,}[i!]\s/ },
  { id: 'biome/fixcmd', action: 'drop', re: /^\s*\$\s+biome\s/ },
  { id: 'biome/blank', action: 'drop', re: /^\s*$/ },
];

// monster-realm's eval harness (evals/run.mjs). Captured: scratchpad/raw/evals_run.log
// — 87 lines / 53,621 B, mean line length 611 chars, ALL of them `eval PASS:` with a
// long trailing detail string.
//
// Read evals/run.mjs:36-39: it prints one line per eval and NO summary line at all.
// The exit code is the only verdict it emits. So this profile must SYNTHESISE the
// summary — withholding the pass lines without one would leave a green run with
// literally nothing to show.
const MR_EVALS = [
  { id: 'evals/pass', action: 'defer', re: /^eval PASS:/ },
  { id: 'evals/fail', action: 'keep', re: /^eval FAIL:/ },
  { id: 'evals/threw', action: 'keep', re: /^eval THREW:/ },
];

function summariseEvals(state) {
  const passed = state.byRule.get('evals/pass') ?? 0;
  const failed = state.byRule.get('evals/fail') ?? 0;
  const threw = state.byRule.get('evals/threw') ?? 0;
  if (passed + failed + threw === 0) return [];
  const parts = [`${passed} passed`];
  if (failed) parts.push(`${failed} FAILED`);
  if (threw) parts.push(`${threw} THREW`);
  return [`[quiet-run] evals: ${parts.join(', ')} (run.mjs prints no summary of its own)`];
}

// criterion, via `just perf-budget`. Captured: scratchpad/bench.out + bench.err —
// 53 lines for 7 benchmarks, of which the warmup/collect/analyse chatter and the
// outlier breakdown are ceremony. The `time:` line and any budget breach are the
// result and are kept.
const CRITERION = [
  {
    id: 'criterion/phase',
    action: 'drop',
    re: /^Benchmarking\s.*:\s(?:Warming up|Collecting|Analyzing|Complete)/,
  },
  { id: 'criterion/start', action: 'drop', re: /^Benchmarking\s\S+\s*$/ },
  {
    id: 'criterion/outlier-detail',
    action: 'drop',
    re: /^\s+\d+\s+\(\d[\d.]*%\)\s+(?:high|low)\s+(?:mild|severe)/,
  },
  { id: 'criterion/outliers', action: 'defer', re: /^Found \d+ outliers among \d+ measurements/ },
  { id: 'criterion/change', action: 'keep', re: /^\s*(?:change|time|thrpt):\s/ },
];

// npm. Deprecation warnings are deferred rather than dropped: they are real, but
// they are about transitive dependencies an agent working a feature slice cannot
// act on, and they repeat identically on every install.
const NPM = [
  { id: 'npm/deprecated', action: 'defer', re: /^npm\s+(?:warn|WARN)\s+deprecated\s/ },
  { id: 'npm/notice', action: 'drop', re: /^npm\s+(?:notice|info)\s/ },
  {
    id: 'npm/funding',
    action: 'drop',
    re: /^\s*(?:\d+\s+packages are looking for funding|run `npm fund` for details)/,
  },
  { id: 'npm/audit-clean', action: 'keep', re: /^found \d+ vulnerabilities/ },
  { id: 'npm/added', action: 'keep', re: /^(?:added|removed|changed|up to date)/ },
  { id: 'npm/progress', action: 'drop', re: /^[⠁-⣿]\s/ },
];

// ---------------------------------------------------------------------------
// Command-shape helpers
// ---------------------------------------------------------------------------

const hasWord = (body, re) => re.test(body);

// `cargo --config` can set arbitrary build configuration, including runners that
// execute code. Such a command must reach the permission layer as the `cargo` call
// it is, never as a wrapper invocation, so no cargo profile claims it.
const cargoSafe = (body) => !/\s--config[\s=]/.test(body);

/** A cargo invocation is a SWEEP when it explicitly spans the workspace. */
const cargoTargeted = (body) => {
  if (/\s--(?:workspace|all)\b/.test(body)) return false;
  return /\s-p\s|\s--package[\s=]|\s--test\s|\s--bin\s|\s--lib\b|\s-E\s|\s--exact\b|\s--filter/.test(
    body,
  );
};

/** vitest/node --test are targeted when the command names a file or a -t pattern. */
const nodeTargeted = (body) =>
  /\s-t\s|\s--testNamePattern[\s=]|\s--test-name-pattern[\s=]|\s\S*\.(?:test|spec)\.[jt]sx?\b|\ssrc\/\S+/.test(
    body,
  );

// ---------------------------------------------------------------------------
// Profiles (ordered; first match wins)
// ---------------------------------------------------------------------------

export const PROFILES = [
  {
    name: 'cargo-test',
    // Narrow on purpose. `cargo metadata`, `cargo tree`, `cargo pkgid` and friends
    // emit machine-readable output that an agent asked for verbatim; matching
    // argv0 alone would filter JSON, which would be a data-corruption bug rather
    // than a noise-reduction feature.
    match: (argv0, body, argv) =>
      argv0 === 'cargo' &&
      /^(?:nextest|test|miri)$/.test(argv[1] ?? '') &&
      cargoSafe(body) &&
      !hasWord(body, /\s--message-format[\s=]/),
    targeted: cargoTargeted,
    rules: [...NEXTEST, ...LIBTEST, ...CARGO_PROGRESS],
  },
  {
    name: 'cargo-build',
    match: (argv0, body, argv) =>
      argv0 === 'cargo' &&
      /^(?:build|check|clippy|fmt|bench|doc|rustc)$/.test(argv[1] ?? '') &&
      cargoSafe(body) &&
      !hasWord(body, /\s--message-format[\s=]/),
    targeted: cargoTargeted,
    rules: [...CARGO_PROGRESS, ...CRITERION],
  },
  {
    name: 'cargo-mutants',
    match: (argv0, _body, argv) => argv0 === 'cargo' && argv[1] === 'mutants',
    targeted: () => false,
    rules: [
      { id: 'mutants/caught', action: 'defer', re: /^\d+\/\d+ mutants tested.*caught/ },
      { id: 'mutants/ok', action: 'defer', re: /^ok\s/ },
      { id: 'mutants/missed', action: 'keep', re: /^(?:MISSED|TIMEOUT|missed|timeout)\s/ },
      {
        id: 'mutants/summary',
        action: 'keep',
        re: /mutants tested.*(?:missed|succeeded|unviable)/,
      },
      ...CARGO_PROGRESS,
    ],
  },
  {
    name: 'vitest',
    match: (argv0, body, argv) =>
      /^(?:vitest)$/.test(argv0) ||
      (/^(?:npx|pnpm|yarn|bunx)$/.test(argv0) && argv.includes('vitest')) ||
      (/^npm$/.test(argv0) && /\b(?:test|run test)\b/.test(body)),
    targeted: nodeTargeted,
    rules: VITEST,
  },
  {
    name: 'node-test',
    match: (argv0, body) => argv0 === 'node' && /\s--test\b/.test(body),
    targeted: nodeTargeted,
    rules: NODE_TEST,
  },
  {
    name: 'mr-evals',
    match: (argv0, body) => argv0 === 'node' && /\bevals\/(?:run\.mjs|\S+\.eval\.mjs)/.test(body),
    // A single named eval is the targeted re-check an agent runs after editing one
    // gate (155 such invocations in the mined corpus).
    targeted: (body) => /\bevals\/\S+\.eval\.mjs/.test(body),
    rules: MR_EVALS,
    suppressDeferNotice: true,
    summarise: summariseEvals,
  },
  {
    name: 'biome',
    match: (argv0, _body, argv) =>
      argv0 === 'biome' ||
      (/^(?:npx|pnpm|yarn|bunx)$/.test(argv0) && argv.some((a) => a.includes('biome'))),
    targeted: () => false,
    rules: BIOME,
  },
  {
    name: 'npm-install',
    // ONLY the argument-free restore forms. `npm install <pkg>` ADDS a dependency —
    // a decision this workspace requires an ADR for, and a laundering vector: rewritten,
    // it would reach the permission layer as a `node …` call covered by Bash(node:*)
    // rather than as the npm call the operator's allowlist actually reasoned about.
    match: (argv0, _body, argv) =>
      /^(?:npm|pnpm|yarn|bun)$/.test(argv0) &&
      /^(?:install|ci|i)$/.test(argv[1] ?? '') &&
      argv.slice(2).every((a) => a.startsWith('-')),
    targeted: () => false,
    rules: NPM,
  },
  {
    name: 'wasm-pack',
    match: (argv0) => argv0 === 'wasm-pack',
    targeted: () => false,
    rules: [
      { id: 'wasm/info', action: 'drop', re: /^\[INFO\]:\s/ },
      // Braille spinner frames ONLY. The first version of this rule also matched
      // `:`, `-`, `|`, `/` and `\` — which made it match ANY line starting with
      // punctuation, including `---- src/lib.rs - name (line 4) stdout ----` (a
      // failing doctest's only anchor) and `--- a/file` diff headers. Caught by the
      // source-location test, not by review.
      { id: 'wasm/progress', action: 'drop', re: /^\s*[⠁-⣿]+\s/ },
      ...CARGO_PROGRESS,
    ],
  },
  {
    // The largest single family in the mined corpus: 13,868+ runs, 27.5M result
    // characters, 29.7% of ALL Bash output an agent has ever read here. It is also
    // the RISKIEST to touch, because unlike a test runner's pass wall, every line
    // is content the agent explicitly asked for.
    //
    // So this profile removes no MATCH CONTENT. It only caps: the first CAP matches stream
    // through untouched, and anything past that is counted and reported. That is
    // strictly better than the status quo, which is Claude Code truncating the
    // result at 30 000 characters mid-line with no indication of how much was lost.
    //
    // `cat` / `head` / `tail` / `sed -n` are DELIBERATELY not covered, despite
    // being an even bigger share (32.3%): those name one file and one range, so
    // every byte was individually asked for. Capping them would be lying about
    // file contents rather than trimming tool ceremony.
    name: 'search',
    match: (argv0, body) =>
      /^(?:grep|rg|ag|ack)$/.test(argv0) &&
      // Counting/listing/quiet modes are already small; leave them entirely alone.
      !/\s-(?:[a-zA-Z]*[clq])\b|\s--(?:count|files-with-matches|files-without-match|quiet)\b/.test(
        body,
      ),
    targeted: () => false,
    capKeptAt: 400,
    // No carriage-return collapse here. That collapse exists for progress bars, and a
    // grep hit on a file containing a CR is content, not ceremony — without this the
    // profile silently truncated `data.txt:3: before<CR>after` to `after`.
    preserveContent: true,
    suppressDeferNotice: true,
    rules: [],
    summarise: (state) => {
      // `replayed` matters: a deferred block small enough to be replayed verbatim was
      // in fact shown in full, so advising the agent to narrow its pattern would be
      // both wrong and annoying.
      const hidden = state.deferred - state.replayed;
      if (hidden <= 0) return [];
      return [
        `[quiet-run] search: showed the first ${state.kept} matches; ${hidden} more are in the raw log. ` +
          'Narrow the pattern, add a path filter, or use the Grep tool for the rest.',
      ];
    },
  },
  {
    name: 'just',
    // `just` is a COMPOSITE: one `just ci` measured 313,415 B / ~2,610 lines across
    // cargo, node --test, biome, the eval harness and criterion. Its rule list is
    // the union of theirs. The groups are specific enough (each anchors on its own
    // tool's line shape) that cross-firing is not a practical risk — and the test
    // suite pins one real line per group against this profile to keep it that way.
    match: (argv0) => argv0 === 'just',
    targeted: (body) => /^just\s+(?:ci-fast|client-test)\b/.test(body) || cargoTargeted(body),
    rules: [
      // just echoes each recipe line it runs; that is the only structure a reader
      // has for locating which step failed, so it is kept.
      ...NEXTEST,
      ...LIBTEST,
      ...NODE_TEST,
      ...VITEST,
      ...BIOME,
      ...MR_EVALS,
      ...CRITERION,
      ...NPM,
      ...CARGO_PROGRESS,
    ],
    summarise: summariseEvals,
  },
];
