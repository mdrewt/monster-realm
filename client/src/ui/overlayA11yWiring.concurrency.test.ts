// ui/overlayA11yWiring.concurrency.test.ts — TDD-RED proof-of-teeth for slice rb-37 (residual
// R-rb18-CONCURRENT). Ledger: memory/projects/gates/rb-37.gates.md, criteria RB37-G1..G5.
//
// THE CRITERION. `overlayA11yWiring.test.ts` must be safe under
// `vitest run --sequence.concurrent`: MEASURED at origin/master@318eb70, `76 failed | 40 passed
// (116)`. The (not-yet-shipped) fix is `describe(` -> `describe.sequential(` at that file's line
// 492 — its SINGLE top-level describe, so all 116 tests inherit the annotation — plus a rationale
// comment carrying the marker `RB37-SEQUENTIAL-RATIONALE`. Neither exists yet: this file is RED.
//
// ADR-0224: the proof-of-teeth must be an ORDINARY TS test, never a new `evals/*.eval.mjs`.
//
// FOUR ARMS, PLUS AN AFTERALL COVERAGE FLOOR.
//   RB37-FLAG-CONTROL-NEGATIVE / RB37-FLAG-CONTROL-POSITIVE — prove `--sequence.concurrent` is
//     actually LIVE in this vitest install, and that the spawn+flag plumbing this file shares with
//     the target arm actually works, BEFORE that plumbing is trusted to judge the real file. Without
//     these, the target arm degrades to "the file passes vitest", which `just client-test` already
//     proves for free, and would keep reporting PASS the day the flag is renamed or typo'd.
//   RB37-CONCURRENT-SAFE — the real oracle: the target file, spawned WITH the flag.
//   RB37-RATIONALE-DURABLE — static: the annotation and its rationale are both durably present.
//
// THE MEASUREMENT THAT DECIDES THE DESIGN (red-team, rb-37 planning). A bypass wraps every it()
// body in try{}catch{} and never touches line 492: the target file's own three `afterAll` coverage
// floors (`checked`/`repeatChecked`/`reopenChecked` === 16) then fail as SUITE-level errors that
// `numFailedTests` cannot see — the JSON report reads `numTotalTests=116 numFailedTests=0
// numPassedTests=116`, green by every counter, while `success` is FALSE and the child exits 1.
// RB37-CONCURRENT-SAFE therefore asserts the child's EXIT STATUS and `report.success` FIRST, before
// any counter — counters alone would have shipped green over a fully-blinded spec file.
//
// SPAWN PRECEDENT: `overlayRegistry.test.ts:1126-1157` (`writeA11yProbe`/`compileA11yProbe`,
// ADR-0205 D6) spawns `tsc` the same way — explicit binary path (existsSync-checked precedent at
// `:1163-1175`), a CONTROL probe asserted before the real one, `mkdtempSync`/`rmSync` around every
// generated fixture, and the spawnSync-blocks-the-event-loop caveat recorded at `:1150-1154`.
//
// Module scope, BEFORE anything else: this file must never re-enter itself inside a spawned child
// (all three spawns below name their spec explicitly, but a THROW is the fail-closed backstop —
// never a `.skip`, which would report `numPendingTests > 0` and red `just a11y-e2e` half 2 for an
// unrelated reason).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// Biome merges same-specifier imports — ONE statement. Direction `.test.ts` -> `evals/*.eval.mjs`
// is already blessed in-repo at `client/src/indexShell.test.ts:89,94`.
import {
  stripTsComments,
  stripTsCommentsAndStrings,
} from '../../../evals/overlay-a11y-manifest.eval.mjs';

if (process.env.MR_RB37_CHILD === '1') {
  throw new Error(
    'overlayA11yWiring.concurrency.test.ts must never be collected inside a child it spawns — ' +
      'every spawn below names its spec(s) explicitly, and this throw is the fail-closed backstop.',
  );
}

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.join(UI_DIR, '..', '..');
// Explicit binary path, never `npx`, never PATH — precedent `overlayRegistry.test.ts:1119`.
const VITEST_BIN = path.join(UI_DIR, '..', '..', 'node_modules', '.bin', 'vitest');
const TARGET_SPEC_PATH = path.join(UI_DIR, 'overlayA11yWiring.test.ts');
const TARGET_SPEC_RELATIVE = path.join('src', 'ui', 'overlayA11yWiring.test.ts');

const SEQUENCE_CONCURRENT_FLAG = '--sequence.concurrent';

// Incremented as the LAST statement of every it() body below. An increment placed above a
// surviving assertion would let this floor read 4 while the oracle it stands for never actually
// ran — so it must be provably the tail of each arm, not merely present somewhere in it.
let armsRun = 0;

interface VitestJsonAssertionResult {
  readonly status: string;
  readonly title: string;
}

interface VitestJsonTestResult {
  readonly name: string;
  readonly assertionResults: readonly VitestJsonAssertionResult[];
}

interface VitestJsonReport {
  readonly success: boolean;
  readonly numTotalTests: number;
  readonly numFailedTests: number;
  readonly numPassedTests: number;
  readonly numPendingTests: number;
  readonly numTodoTests: number;
  readonly testResults: readonly VitestJsonTestResult[];
}

interface RunVitestOptions {
  readonly spawnTimeoutMs: number;
}

interface RunVitestOutcome {
  readonly result: ReturnType<typeof spawnSync>;
  readonly report: VitestJsonReport;
}

/**
 * The child's environment: every `VITEST*` key and `NODE_V8_COVERAGE` stripped (a parent worker's
 * own vitest env leaking into the child is a real hazard for a spawn-inside-a-test harness), plus
 * `MR_RB37_CHILD` (the module-scope throw guard above) and `FORCE_COLOR: '0'` (keeps `--reporter
 * json` stdout ANSI-free, though the report itself is read from `--outputFile`).
 *
 * The vitest shim is `#!/usr/bin/env node`, and this harness's default PATH resolves `node` to
 * v18 — putting the pinned 24.13.1 bin FIRST on PATH is what makes the child actually run at all.
 */
function buildChildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST')) delete env[key];
  }
  delete env.NODE_V8_COVERAGE;
  env.MR_RB37_CHILD = '1';
  env.FORCE_COLOR = '0';
  const nodeBinDir = path.join(
    process.env.HOME ?? homedir(),
    '.asdf',
    'installs',
    'nodejs',
    '24.13.1',
    'bin',
  );
  env.PATH = `${nodeBinDir}:${env.PATH ?? ''}`;
  return env;
}

/**
 * ONE spawn helper for all three spawning arms, so a typo'd flag or a broken spawn reds a CONTROL
 * arm FIRST — that is the only mechanism that transfers the control's verdict onto the target arm.
 *
 * `spawnSync` BLOCKS the event loop where vitest's OWN timer lives (MEASURED at
 * `overlayRegistry.test.ts:1150-1154`: a 4s sleep inside a 2s it() reports the timeout only after
 * the call returns), so the it()'s timeout does NOT bound a hung child — `opts.spawnTimeoutMs` is
 * the only real bound, and every caller sets its own it() timeout ABOVE it so a hang surfaces as a
 * clean assertion rather than a confusing vitest-level test timeout.
 */
function runVitest(
  extraArgs: readonly string[],
  specs: readonly string[],
  opts: RunVitestOptions,
): RunVitestOutcome {
  expect(
    existsSync(VITEST_BIN),
    `vitest binary must exist at ${VITEST_BIN} — client/node_modules must be installed (just ` +
      'client-setup). A missing binary is an ANTI-VACUITY failure: every arm below would ' +
      'otherwise never actually spawn vitest and every assertion downstream would be vacuous.',
  ).toBe(true);

  const outDir = mkdtempSync(path.join(tmpdir(), 'rb37-out-'));
  const outFile = path.join(outDir, 'report.json');
  try {
    const result = spawnSync(
      VITEST_BIN,
      [
        'run',
        '--no-file-parallelism',
        ...extraArgs,
        '--reporter=json',
        `--outputFile=${outFile}`,
        ...specs,
      ],
      {
        cwd: CLIENT_ROOT,
        encoding: 'utf8',
        env: buildChildEnv(),
        timeout: opts.spawnTimeoutMs,
      },
    );

    // Separated from the exit-status assertions the callers make below, so a spawn TIMEOUT (or a
    // spawn that never started at all) reads as exactly that, and not as a confusing "the tests
    // failed" — those two failure modes must never be mistaken for one another.
    expect(result.error, `vitest child spawn errored: ${String(result.error)}`).toBeUndefined();
    expect(
      result.signal,
      `vitest child was killed by signal ${String(result.signal)} — most likely the ` +
        `${opts.spawnTimeoutMs}ms spawnSync timeout, the only real bound on a hung child.`,
    ).toBeNull();

    expect(
      existsSync(outFile),
      `no JSON report was written at ${outFile} — a timeout-killed child writes NOTHING ` +
        '(measured), and a bare readFileSync on a missing file throws ENOENT, which reads like ' +
        'a parse bug rather than the timeout it actually is.',
    ).toBe(true);

    const report = JSON.parse(readFileSync(outFile, 'utf8')) as VitestJsonReport;
    return { result, report };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * GENERATED, never committed (this repo's `writeA11yProbe`/`compileA11yProbe` idiom at
 * `overlayRegistry.test.ts:1126-1157`, ADR-0205 D6). Both files are PLAIN OBJECTS / bare globals —
 * no `import { defineConfig }`, no `import { it, expect } from 'vitest'` — so nothing has to
 * resolve a module graph from a temp directory (MEASURED WORKING SPIKE in this worktree).
 *
 * `maxConcurrency: 4` is NOT decoration: red-team measured that `--maxConcurrency=1` silently
 * neutralises `--sequence.concurrent` for a 2-test fixture, so it is pinned in the generated
 * config rather than left to whatever vitest's own default happens to be.
 */
function writeControlFixture(): { readonly dir: string; readonly configPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'rb37-ctl-'));
  const configPath = path.join(dir, 'vitest.control.config.ts');
  const specPath = path.join(dir, 'rendezvous.control.test.ts');

  writeFileSync(
    configPath,
    `// GENERATED by overlayA11yWiring.concurrency.test.ts. The sequential arm of the paired
// rendezvous.control.test.ts is SUPPOSED to report exactly one failure -- do not "fix" it.
export default {
  root: ${JSON.stringify(dir)},
  test: {
    include: ['*.control.test.ts'],
    environment: 'node',
    globals: true,
    allowOnly: false,
    maxConcurrency: 4,
  },
};
`,
    'utf8',
  );

  writeFileSync(
    specPath,
    `// GENERATED by overlayA11yWiring.concurrency.test.ts. Under the DEFAULT (sequential) order
// RB37-CTRL-A is SUPPOSED to fail -- it sets its own flag and times out waiting for a peer that
// has not started yet. Do not "fix" it; that one failure is the whole point of this fixture.
let aArrived = false;
let bArrived = false;

async function waitForPeer(readFlag) {
  const deadline = Date.now() + 1200;
  while (!readFlag() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return readFlag();
}

it('RB37-CTRL-A', async () => {
  aArrived = true;
  const sawPeer = await waitForPeer(() => bArrived);
  expect(sawPeer, 'RB37-CTRL-A never observed RB37-CTRL-B arrive').toBe(true);
});

it('RB37-CTRL-B', async () => {
  bArrived = true;
  const sawPeer = await waitForPeer(() => aArrived);
  expect(sawPeer, 'RB37-CTRL-B never observed RB37-CTRL-A arrive').toBe(true);
});
`,
    'utf8',
  );

  return { dir, configPath };
}

describe('rb-37 proof-of-teeth — overlayA11yWiring.test.ts under vitest --sequence.concurrent', () => {
  it('RB37-FLAG-CONTROL-NEGATIVE BITES: without the flag, a broken spawn/flag/harness reports the wrong control census, which would otherwise silently discredit the target arm', () => {
    const fixture = writeControlFixture();
    try {
      const { report } = runVitest(['--config', fixture.configPath], [], { spawnTimeoutMs: 60000 });

      expect(report.numTotalTests, 'the control fixture must run exactly its two its').toBe(2);
      // MEASURED (rb-37 planning spike, stable across 50 runs incl. single-core pinning and CPU
      // load): WITHOUT the flag the fixture is SEQUENTIAL, so RB37-CTRL-A completes (setting its
      // own flag) and times out waiting for RB37-CTRL-B, which has not started yet; RB37-CTRL-B
      // then runs and immediately observes A's already-set flag. total=2 failed=1 passed=1.
      expect(
        report.numFailedTests,
        'without the flag exactly one of the two rendezvous peers must time out — a different ' +
          'count means the spawn/flag/env plumbing this file shares with the real target arm is ' +
          'already broken, and RB37-CONCURRENT-SAFE would be trusting a broken harness.',
      ).toBe(1);
      expect(report.numPassedTests).toBe(1);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }

    armsRun += 1;
  }, 90000);

  it('RB37-FLAG-CONTROL-POSITIVE BITES: WITH the flag, the same fixture must fully pass — proves --sequence.concurrent is actually live in this vitest install, not merely accepted and ignored', () => {
    const fixture = writeControlFixture();
    try {
      const { result, report } = runVitest(
        ['--config', fixture.configPath, SEQUENCE_CONCURRENT_FLAG],
        [],
        { spawnTimeoutMs: 60000 },
      );

      // MEASURED: WITH the flag both rendezvous peers start together, each sees the other's flag
      // inside the 1200ms poll window, and both pass. total=2 failed=0.
      expect(report.numTotalTests, 'the control fixture must run exactly its two its').toBe(2);
      expect(
        report.numFailedTests,
        'WITH the flag both rendezvous peers must observe each other and pass — if this is not ' +
          'zero, `--sequence.concurrent` is not actually live in this vitest install (or a typo ' +
          'in SEQUENCE_CONCURRENT_FLAG broke it), and the target arm would be unfalsifiable.',
      ).toBe(0);
      expect(result.status, `vitest child exited ${result.status}; stderr:\n${result.stderr}`).toBe(
        0,
      );
      expect(report.success, `report.success was false; stderr:\n${result.stderr}`).toBe(true);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }

    armsRun += 1;
  }, 90000);

  it('RB37-CONCURRENT-SAFE BITES: overlayA11yWiring.test.ts must survive vitest run --sequence.concurrent wholly green — a racy shared-state describe() reds ~76/116 (MEASURED at origin/master@318eb70); only describe.sequential( at :492 fixes it, and a try/catch-every-it() bypass is caught by the exit-status + success clauses below, never the counters alone', () => {
    const { result, report } = runVitest([SEQUENCE_CONCURRENT_FLAG], [TARGET_SPEC_RELATIVE], {
      spawnTimeoutMs: 180000,
    });

    // BOTH load-bearing, asserted BEFORE any counter (see header measurement): a mutant that wraps
    // every it() body in try{}catch{} and never touches line 492 keeps every assertionResult
    // internally "passed" while the target file's own afterAll coverage floors fail as a
    // SUITE-level error — numFailedTests reads 0 either way, but the child still exits nonzero and
    // report.success is still false. Only these two clauses see that.
    expect(result.status, `vitest child exited ${result.status}; stderr:\n${result.stderr}`).toBe(
      0,
    );
    expect(report.success, `report.success was false; stderr:\n${result.stderr}`).toBe(true);

    expect(report.testResults.length, 'exactly one spec file must have run').toBe(1);
    expect(
      path.basename(report.testResults[0].name),
      'the one spec file that ran must be overlayA11yWiring.test.ts, not some other spec the ' +
        'child happened to pick up',
    ).toBe('overlayA11yWiring.test.ts');

    expect(report.numTotalTests, 'the file holds 116 tests').toBe(116);
    expect(report.numFailedTests).toBe(0);
    expect(report.numPendingTests, 'a .skip would hide a racy test behind a zero-failure count').toBe(
      0,
    );
    expect(report.numTodoTests).toBe(0);

    const assertions = report.testResults[0].assertionResults;
    expect(
      assertions.every((a) => a.status === 'passed'),
      'every individual assertionResult must be passed, not merely the aggregate counters',
    ).toBe(true);
    // `every(...)`, NOT a second hand-typed count: all 116 it() call sites in the target file carry
    // the S10-WIRE- prefix (red-team correction, rb-37 planning: an earlier draft's literal "112"
    // was wrong and would itself false-RED on correct code while inviting a "just bump the number"
    // fix instead of catching anything real).
    expect(
      assertions.every((a) => a.title.startsWith('S10-WIRE-')),
      'every title in the file must start with S10-WIRE- — a title that does not is either a ' +
        'foreign test the child picked up, or a padded trivial test standing in for a deleted one',
    ).toBe(true);

    armsRun += 1;
  }, 240000);

  it('RB37-RATIONALE-DURABLE BITES: describe.sequential( occurs EXACTLY ONCE (agreeing under two independent strippers, killing a decoy string literal) with an adjacent, content-bearing RB37-SEQUENTIAL-RATIONALE marker naming OPEN_OVERLAYS and the 76-failed measurement — a bare rename or a stubbed one-line comment both fail this', () => {
    const raw = readFileSync(TARGET_SPEC_PATH, 'utf8');

    const commentsStripped = stripTsComments(raw);
    const commentsAndStringsStripped = stripTsCommentsAndStrings(raw);

    // Anti-over-strip sanity, asserted BEFORE the real counts: a stripper that blanked the whole
    // file would make describe.sequential( read 0 for the WRONG reason, indistinguishable from a
    // genuinely missing annotation. `installSentinel` and `afterAll(` are known-present tokens far
    // from the describe line (target file :464 and :882, the coverage-floor afterAll) that any
    // correct stripper preserves.
    expect(commentsStripped).toContain('installSentinel');
    expect(commentsStripped).toContain('afterAll(');
    expect(commentsAndStringsStripped).toContain('installSentinel');
    expect(commentsAndStringsStripped).toContain('afterAll(');

    const countOccurrences = (text: string, needle: string): number =>
      text.split(needle).length - 1;

    const sequentialInComments = countOccurrences(commentsStripped, 'describe.sequential(');
    const sequentialInBoth = countOccurrences(commentsAndStringsStripped, 'describe.sequential(');

    expect(
      sequentialInComments,
      'describe.sequential( must occur EXACTLY ONCE once comments are stripped — the fix turns ' +
        'the file’s single bare describe( (line 492) into describe.sequential(.',
    ).toBe(1);
    expect(
      sequentialInBoth,
      'the comment-AND-string-stripped count must AGREE with the comment-only count — a decoy ' +
        'STRING LITERAL holding the byte-exact token would inflate the comment-only count but ' +
        'vanish once string bodies are dropped too, which is exactly what this divergence catches.',
    ).toBe(sequentialInComments);

    const markerCount = countOccurrences(raw, 'RB37-SEQUENTIAL-RATIONALE');
    expect(markerCount, 'RB37-SEQUENTIAL-RATIONALE must occur EXACTLY ONCE in the raw source').toBe(
      1,
    );

    const markerIndex = raw.indexOf('RB37-SEQUENTIAL-RATIONALE');
    const annotationIndex = raw.indexOf('describe.sequential(');
    expect(markerIndex, 'the marker must actually be present in the raw source').toBeGreaterThanOrEqual(
      0,
    );
    expect(
      annotationIndex,
      'the describe.sequential( annotation must actually be present in the raw source',
    ).toBeGreaterThanOrEqual(0);
    expect(
      markerIndex,
      'the rationale marker must sit BEFORE the describe.sequential( call it explains',
    ).toBeLessThan(annotationIndex);

    const gap = annotationIndex - markerIndex;
    expect(
      gap,
      `the marker sits ${gap} chars from the annotation it is supposed to explain — too far to ` +
        'plausibly be its rationale comment',
    ).toBeLessThan(6000);

    const between = raw.slice(markerIndex, annotationIndex);
    expect(
      between,
      'the rationale text between the marker and the annotation must name the shared module ' +
        'state (OPEN_OVERLAYS) that makes concurrent execution unsafe — a stub comment like ' +
        '"see PR" would fail this content floor',
    ).toContain('OPEN_OVERLAYS');
    expect(
      between,
      'the rationale text must also name the MEASUREMENT (76 failed) that justified the fix — ' +
        'without it the comment could name unrelated shared state and still satisfy the check above',
    ).toContain('76 failed');

    armsRun += 1;
  });

  afterAll(() => {
    expect(
      armsRun,
      'all four RB37 arms must have run to completion and incremented armsRun as the LAST ' +
        'statement of their body — a partial run here means some oracle above never actually ' +
        'executed, which a raw it()-count alone cannot distinguish from a genuine pass.',
    ).toBe(4);
  });
});
