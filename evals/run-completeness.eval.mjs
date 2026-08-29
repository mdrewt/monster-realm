// run-completeness.eval.mjs — the evals/run.mjs mid-loop truncation + swallowed-verdict guard
// (rb-5; residual R-m22-s0-X4; ADR-0209).
//
// WHAT THIS FREEZES. `evals/run.mjs` globs `evals/*.eval.mjs`, `await import()`s each into ONE
// process, and calls its default export. TWO measured false-green classes let a genuinely broken
// suite still exit 0:
//   (a) a module-scope `process.exit(N)` inside ANY discovered eval ends the run mid-loop — the
//       remaining evals never run, the terminal `process.exit(failed ? 1 : 0)` never executes, and
//       already-printed FAIL lines are swallowed (measured: 37/90 evals ran, 3 FAILs swallowed,
//       exit 0);
//   (b) `process.exit = () => {}` at module scope neuters run.mjs's own terminal call — node then
//       exits naturally with `process.exitCode === undefined`, i.e. 0, swallowing a genuine FAIL.
// The fix under gate lands a `process.on('exit', ...)` verdict handler between two sentinel lines,
// `// rb-5:exit-verdict BEGIN` / `// rb-5:exit-verdict END`, plus a `completed`/`inFlight` pair
// declared alongside the existing `let failed = 0;`. This file freezes the OBSERVABLE behaviour of
// that handler against 20 child-process fixtures, never its source text.
//
// WHY EACH TOOTH BITES (every corpus is spawned against the LIVE run.mjs read off disk at
// `import.meta.url` — never an embedded copy, which would stay green after the fix was reverted):
//   [RC/live] RC1-RC6 — the mid-loop `process.exit()` class, every discovery position (first,
//     middle, last), both `default()`-throwing and module-scope shapes, and a deferred exit.
//     RC2 has NO genuine FAIL anywhere in its corpus: it is the mutant-killer for the
//     `completed !== files.length` clause specifically — delete that clause and keep only
//     `failed > 0`, and RC1 still passes (there IS a genuine FAIL in its corpus) while RC2 reds.
//     RC5 pins `completed++` landing AFTER the print (after `mod.default()` resolves), not after
//     the `import()` — an EXIT_INNER file that imports cleanly but exits inside `default()` must
//     NOT be counted complete.
//   [RC/neutered-exit] RC7/RC8 — the neutered-`process.exit` class. RC7 is the `failed > 0`
//     clause's killer (a completed-but-failing run with a no-op `process.exit` must still exit
//     non-zero via the `exit` event); RC8 proves the same clause does not INVENT a failure when
//     there isn't one.
//   [RC/controls] RC9-RC13 — the guard must not red a clean run, an ordinary FAIL, a THROWN eval
//     (M10.5d regression control), or the frozen zero-eval guard (RC13 proves that signature is
//     TEXTUALLY DISTINCT from "INCOMPLETE RUN", so an accidentally-empty fixture dir can never be
//     misread as this guard biting). RC12 pins the `!process.exitCode` non-clobber clause: a
//     handler that sets `process.exitCode = 1` unconditionally overwrites a real `process.exit(3)`
//     and reds here.
//   [RC/fail-open] RC14/RC15 — the print-vs-set ORDERING inside the exit handler. A poisoned
//     `console.error` throws when the handler tries to log; if the verdict is computed AFTER that
//     throw, the already-committed `process.exit(0)` code survives untouched (fail-OPEN, an
//     unequivocally wrong exit 0 in RC14's case). Measured both ways on the fix's own shape: print-
//     then-set observed exit 0, set-then-print observed exit 1. RC15 is the mirror control: a
//     poisoned logger must not turn a real exit 5 into a false 1 either.
//   [RC/prefix-red] RC-M0..RC-M4 — the ADR-0010 differential, computed by SPLICING the sentinel
//     region out of the SAME live text (indexOf/slice — no `String.replace`, a `$'`-shaped
//     replacement pattern has duplicated a file's tail in this repo before), never a hand-authored
//     "pre-fix" snapshot. RC-M0 validates the splice actually removed something (single sentinel
//     pair, BEGIN before END, output strictly shorter, no leftover `process.on('exit'`) and FAILS
//     LOUD — never vacuously — if it did not; RC-M1..RC-M4 then prove the spliced ("mutant")
//     harness reproduces the OLD buggy exit codes on RC9/RC10's and RC1/RC2/RC7's own corpora. If
//     RC-M0's validation fails (as it necessarily does before the fix lands: the sentinels do not
//     exist yet), RC-M1..RC-M4 are recorded as gated failures rather than run against nonsense text.
//   [RC/diagnostic] folded into RC1 and RC4 (not separate tooth ids) — the INCOMPLETE message must
//     name the completed count, the discovered count, AND the truncating file, with DIFFERENT
//     numbers in each fixture (RC1: "1 of 3", RC4: "1 of 2") so a hard-coded string cannot satisfy
//     both.
//
// MEASURED VACUITY SHAPES THIS FILE REFUSES TO REPEAT:
//   * Exit code alone is vacuous — an unrelated bad `import` in a fixture also exits 1 through the
//     PRE-EXISTING per-eval try/catch, never touching the completeness path at all. Every tooth
//     pairs an exact status assertion (never `!== 0`: a spawn failure gives `status: null`, a
//     SIGKILL gives `signal: 'SIGKILL'`) with a marker assertion on the correct STREAM.
//   * `stdout.includes('INCOMPLETE RUN')` alone is vacuous — a normal FAILing eval whose `detail`
//     merely contains that text would satisfy it. The guard's own message is stderr-only; teeth
//     assert the stream explicitly.
//   * Child stdio is captured to SEPARATE FILES in the tmp root, never `stdio: 'pipe'`. Measured on
//     this machine: a child that `process.exit()`s with a loaded stdout PIPE loses buffered stdout
//     in 4 of 20 runs — a tooth asserting "the FAIL line was printed before the truncation" would be
//     intermittently wrong for reasons unrelated to the gate. File writes are synchronous on POSIX.
//
// NO MAIN GUARD, DELIBERATELY. A file whose subject IS "module-scope exits truncate the harness"
// must not contain one itself (precedent + full rationale: `evals/a11y-static-shell.eval.mjs:58`,
// `evals/nightly-coverage-wasm-wiring.eval.mjs:32`). `run.mjs` discovers this module by readdir and
// calls the default export; there is no module-scope side effect here beyond two path constants.
//
// NO `new RegExp` ANYWHERE (Semgrep `detect-non-literal-regexp` is remote-only in this repo and has
// bitten it three times) — literal regexes and `String.indexOf`/`slice` only. NO `String.replace`
// for the sentinel splice, for the same reason cited above.
//
// RC6 SCHEDULING — measured, not assumed. A first attempt used plain synchronous-OK trailing
// fixtures on the theory that each `await import()` yields to the event loop long enough for the
// deferred `setTimeout(..., 0)` exit to interleave. Measured directly (40 runs against a correct
// reference implementation): that shape truncated in 0 of 40 runs — every trailing `await import()`
// in this tiny, fs-cache-warm corpus resolves within the SAME event-loop turn, so the for-loop
// never yields to the timers phase until after it has already finished and called the terminal
// `process.exit(failed ? 1 : 0)` itself, by which point the deferred exit is moot. The trailing
// fixtures below instead `await new Promise(r => setTimeout(r, 1))` before resolving, which FORCES
// the for-loop to yield to the timers phase once per trailing fixture; that gives the earlier-armed
// 0ms deferred exit a turn to fire first. Measured 40 of 40 truncations with this shape. No other
// fixture in this file is timing-sensitive.
//
// RUNTIME BUDGET. 20 child `node evals/run.mjs` spawns total (15 for RC1-RC15, 0 for RC-M0's pure
// text validation, 2+1+1+1 for RC-M1..RC-M4). A child run over a 2-8 file corpus on this class of
// machine was reported at ~20ms; even a generous 200ms/child budgets under 4s against a suite whose
// wall clock is tens of seconds.

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_MJS_PATH = fileURLToPath(new URL('./run.mjs', import.meta.url));
const SENTINEL_BEGIN = '// rb-5:exit-verdict BEGIN';
const SENTINEL_END = '// rb-5:exit-verdict END';

// ---------------------------------------------------------------------------
// Fixture body generators (the exact glossary the slice brief specifies).
// ---------------------------------------------------------------------------

function OK(id) {
  return `export default async () => ({ name: 'ok-${id}', pass: true, detail: '' });\n`;
}

function FAIL(id) {
  return `export default async () => ({ name: 'fail-${id}', pass: false, detail: 'fixture-fail-${id}' });\n`;
}

function EXIT_MODULE(code) {
  return (
    `process.exit(${code});\n` +
    "export default async () => ({ name: 'unreachable', pass: true, detail: '' }); // unreachable\n"
  );
}

function EXIT_INNER() {
  return (
    'export default async () => {\n' +
    '  process.exit(0);\n' +
    "  return { name: 'unreachable-exit-inner', pass: true, detail: '' };\n" +
    '};\n'
  );
}

function EXIT_LATER() {
  return (
    'setTimeout(() => {\n' +
    '  process.exit(0);\n' +
    '}, 0);\n' +
    "export default async () => ({ name: 'ok-exit-later', pass: true, detail: '' });\n"
  );
}

function YIELD_OK(id) {
  return (
    'export default async () => {\n' +
    '  await new Promise((resolve) => {\n' +
    '    setTimeout(resolve, 1);\n' +
    '  });\n' +
    `  return { name: 'ok-${id}', pass: true, detail: '' };\n` +
    '};\n'
  );
}

function NEUTER() {
  return (
    'process.exit = () => {};\n' +
    "export default async () => ({ name: 'ok-neuter', pass: true, detail: '' });\n"
  );
}

function THROWER() {
  return "export default async () => {\n  throw new Error('x');\n};\n";
}

function POISON(code) {
  return (
    'console.error = () => {\n' +
    "  throw new Error('poisoned');\n" +
    '};\n' +
    `process.exit(${code});\n`
  );
}

// ---------------------------------------------------------------------------
// Harness plumbing.
// ---------------------------------------------------------------------------

function countOccurrences(text, needle) {
  let count = 0;
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return count;
}

// Splices the sentinel-delimited exit-verdict region OUT of `text` using indexOf/slice only
// (never String.replace). Returns { ok:false, reason } on any structural anomaly — the caller
// must fail loud rather than silently proceed on a no-op splice.
function spliceSentinelRegion(text) {
  const beginCount = countOccurrences(text, SENTINEL_BEGIN);
  const endCount = countOccurrences(text, SENTINEL_END);
  if (beginCount !== 1) {
    return { ok: false, reason: `BEGIN sentinel occurs ${beginCount} time(s), expected exactly 1` };
  }
  if (endCount !== 1) {
    return { ok: false, reason: `END sentinel occurs ${endCount} time(s), expected exactly 1` };
  }
  const beginIdx = text.indexOf(SENTINEL_BEGIN);
  const endIdx = text.indexOf(SENTINEL_END);
  if (!(beginIdx < endIdx)) {
    return { ok: false, reason: 'BEGIN sentinel does not precede END sentinel' };
  }
  const before = text.slice(0, beginIdx);
  const after = text.slice(endIdx + SENTINEL_END.length);
  const spliced = before + after;
  if (!(spliced.length < text.length)) {
    return { ok: false, reason: 'spliced text is not strictly shorter than the original' };
  }
  if (spliced.indexOf("process.on('exit'") !== -1) {
    return { ok: false, reason: "spliced text still contains process.on('exit' after removal" };
  }
  return { ok: true, spliced };
}

function writeFixture(root, id, harnessText, files) {
  const fixtureDir = path.join(root, id);
  const evalsDir = path.join(fixtureDir, 'evals');
  mkdirSync(evalsDir, { recursive: true });
  writeFileSync(path.join(evalsDir, 'run.mjs'), harnessText, 'utf8');
  for (const [name, content] of files) {
    writeFileSync(path.join(evalsDir, name), content, 'utf8');
  }
  return fixtureDir;
}

// Runs `node evals/run.mjs` in `cwd`, capturing stdout/stderr to SEPARATE files under `root`
// (never stdio:'pipe' — see the header note on the measured 4/20 buffered-pipe loss).
function runHarness(cwd, root, tag) {
  const outPath = path.join(root, `${tag}.stdout.txt`);
  const errPath = path.join(root, `${tag}.stderr.txt`);
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, ['evals/run.mjs'], {
      cwd,
      stdio: ['ignore', outFd, errFd],
      timeout: 20000,
      killSignal: 'SIGKILL',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(outPath, 'utf8');
  const stderr = readFileSync(errPath, 'utf8');
  return { error: res.error, signal: res.signal, status: res.status, stdout, stderr };
}

// The ONLY status comparator used anywhere below — never a bare `res.status !== 0`. A spawn
// failure gives status:null (res.error set); a SIGKILL gives signal:'SIGKILL'. Both must be ruled
// out explicitly before the exact status number is trusted.
function expectStatus(res, expected) {
  if (res.error != null) return `spawn error: ${res.error}`;
  if (res.signal !== null) return `killed by signal ${res.signal}`;
  if (res.status !== expected) return `expected status ${expected}, got ${res.status}`;
  return null;
}

function run(root, id, harnessText, files) {
  const dir = writeFixture(root, id, harnessText, files);
  return runHarness(dir, root, id);
}

// ---------------------------------------------------------------------------
// [RC/live] — the mid-loop process.exit() class, run against the LIVE harness.
// ---------------------------------------------------------------------------

function tRC1(root, liveText) {
  const res = run(root, 'RC1', liveText, [
    ['01-fail.eval.mjs', FAIL('a')],
    ['02-exit.eval.mjs', EXIT_MODULE(0)],
    ['03-fail.eval.mjs', FAIL('b')],
  ]);
  const statusErr = expectStatus(res, 1);
  if (statusErr) return { ok: false, note: `RC1: ${statusErr}` };
  if (res.stderr.indexOf('INCOMPLETE RUN') === -1) {
    return {
      ok: false,
      note: `RC1: stderr missing "INCOMPLETE RUN" — got: ${res.stderr.slice(0, 300)}`,
    };
  }
  // [RC/diagnostic]: completed count, discovered count, truncator name.
  if (res.stderr.indexOf('1 of 3') === -1) {
    return { ok: false, note: `RC1: stderr missing "1 of 3" — got: ${res.stderr.slice(0, 300)}` };
  }
  if (res.stderr.indexOf('02-exit.eval.mjs') === -1) {
    return { ok: false, note: 'RC1: stderr does not name the truncating file 02-exit.eval.mjs' };
  }
  if (res.stdout.indexOf('eval FAIL:') === -1) {
    return {
      ok: false,
      note: 'RC1: stdout missing the first (completed) file\'s "eval FAIL:" line',
    };
  }
  return { ok: true, note: 'RC1: ok' };
}

function tRC2(root, liveText) {
  // No genuine FAIL anywhere in this corpus — the mutant-killer for the completeness clause
  // specifically. Deleting that clause and keeping only `failed > 0` still lets RC1 pass.
  const res = run(root, 'RC2', liveText, [
    ['01-ok.eval.mjs', OK('a')],
    ['02-ok.eval.mjs', OK('b')],
    ['03-exit.eval.mjs', EXIT_MODULE(0)],
  ]);
  const statusErr = expectStatus(res, 1);
  if (statusErr) return { ok: false, note: `RC2: ${statusErr}` };
  if (res.stderr.indexOf('INCOMPLETE RUN') === -1) {
    return {
      ok: false,
      note: `RC2: stderr missing "INCOMPLETE RUN" — got: ${res.stderr.slice(0, 300)}`,
    };
  }
  if (res.stderr.indexOf('2 of 3') === -1) {
    return { ok: false, note: `RC2: stderr missing "2 of 3" — got: ${res.stderr.slice(0, 300)}` };
  }
  return { ok: true, note: 'RC2: ok' };
}

function tRC3(root, liveText) {
  const res = run(root, 'RC3', liveText, [
    ['01-exit.eval.mjs', EXIT_MODULE(0)],
    ['02-ok.eval.mjs', OK('a')],
  ]);
  const statusErr = expectStatus(res, 1);
  if (statusErr) return { ok: false, note: `RC3: ${statusErr}` };
  if (res.stderr.indexOf('INCOMPLETE RUN') === -1 || res.stderr.indexOf('0 of 2') === -1) {
    return {
      ok: false,
      note: `RC3: stderr missing INCOMPLETE/"0 of 2" — got: ${res.stderr.slice(0, 300)}`,
    };
  }
  if (res.stderr.indexOf('01-exit.eval.mjs') === -1) {
    return { ok: false, note: 'RC3: stderr does not name the truncating file 01-exit.eval.mjs' };
  }
  return { ok: true, note: 'RC3: ok' };
}

function tRC4(root, liveText) {
  const res = run(root, 'RC4', liveText, [
    ['01-ok.eval.mjs', OK('a')],
    ['02-exit.eval.mjs', EXIT_MODULE(0)],
  ]);
  const statusErr = expectStatus(res, 1);
  if (statusErr) return { ok: false, note: `RC4: ${statusErr}` };
  if (res.stderr.indexOf('INCOMPLETE RUN') === -1) {
    return {
      ok: false,
      note: `RC4: stderr missing "INCOMPLETE RUN" — got: ${res.stderr.slice(0, 300)}`,
    };
  }
  // [RC/diagnostic]: a DIFFERENT "N of M" than RC1's, so a hard-coded string cannot satisfy both.
  if (res.stderr.indexOf('1 of 2') === -1) {
    return { ok: false, note: `RC4: stderr missing "1 of 2" — got: ${res.stderr.slice(0, 300)}` };
  }
  if (res.stderr.indexOf('02-exit.eval.mjs') === -1) {
    return { ok: false, note: 'RC4: stderr does not name the truncating file 02-exit.eval.mjs' };
  }
  return { ok: true, note: 'RC4: ok' };
}

function tRC5(root, liveText) {
  // Pins `completed++` landing AFTER the print (after mod.default() resolves), not after import().
  const res = run(root, 'RC5', liveText, [
    ['01-ok.eval.mjs', OK('a')],
    ['02-exitinner.eval.mjs', EXIT_INNER()],
    ['03-ok.eval.mjs', OK('b')],
  ]);
  const statusErr = expectStatus(res, 1);
  if (statusErr) return { ok: false, note: `RC5: ${statusErr}` };
  if (res.stderr.indexOf('INCOMPLETE RUN') === -1) {
    return {
      ok: false,
      note: `RC5: stderr missing "INCOMPLETE RUN" — got: ${res.stderr.slice(0, 300)}`,
    };
  }
  if (res.stderr.indexOf('1 of 3') === -1) {
    return {
      ok: false,
      note: `RC5: stderr missing "1 of 3" (completed++ placed before the print?) — got: ${res.stderr.slice(0, 300)}`,
    };
  }
  return { ok: true, note: 'RC5: ok' };
}

function tRC6(root, liveText) {
  // The trailing fixtures MUST yield to a real macrotask (a setTimeout(...,1) await), not just
  // resolve through microtasks. MEASURED on the reference implementation, 40/40 runs each: with
  // plain synchronous-OK trailing fixtures the deferred `setTimeout(..., 0)` exit truncates in
  // 0 of 40 runs (every `await import()` in this tiny, fs-cache-warm corpus resolves within the
  // SAME event-loop turn, so the for-loop never yields to the timers phase until after it has
  // already finished and called the terminal `process.exit(failed ? 1 : 0)` itself — the deferred
  // exit fires too late to matter). With trailing fixtures that `await new Promise(r =>
  // setTimeout(r, 1))` before resolving, the for-loop is FORCED to yield to the timers phase once
  // per trailing fixture, which gives the earlier-armed 0ms deferred exit a turn to run first —
  // truncation was observed in 40 of 40 runs with this shape.
  const files = [
    ['01-ok.eval.mjs', OK('a')],
    ['02-exitlater.eval.mjs', EXIT_LATER()],
    ['03-ok.eval.mjs', YIELD_OK('b')],
    ['04-ok.eval.mjs', YIELD_OK('c')],
    ['05-ok.eval.mjs', YIELD_OK('d')],
    ['06-ok.eval.mjs', YIELD_OK('e')],
    ['07-ok.eval.mjs', YIELD_OK('f')],
    ['08-ok.eval.mjs', YIELD_OK('g')],
  ];
  const res = run(root, 'RC6', liveText, files);
  const statusErr = expectStatus(res, 1);
  if (statusErr) return { ok: false, note: `RC6: ${statusErr}` };
  if (res.stderr.indexOf('INCOMPLETE RUN') === -1) {
    return {
      ok: false,
      note: `RC6: stderr missing "INCOMPLETE RUN" — got: ${res.stderr.slice(0, 300)}`,
    };
  }
  const m = res.stderr.match(/(\d+) of (\d+) discovered/);
  if (!m) {
    return { ok: false, note: 'RC6: could not parse "N of M discovered" out of stderr' };
  }
  const [, completedStr, totalStr] = m;
  const completed = Number(completedStr);
  const total = Number(totalStr);
  if (total !== files.length) {
    return { ok: false, note: `RC6: discovered count ${total} !== corpus size ${files.length}` };
  }
  if (!(completed < total)) {
    return { ok: false, note: `RC6: completed (${completed}) not less than total (${total})` };
  }
  return { ok: true, note: 'RC6: ok' };
}

// ---------------------------------------------------------------------------
// [RC/neutered-exit].
// ---------------------------------------------------------------------------

function tRC7(root, liveText) {
  const res = run(root, 'RC7', liveText, [
    ['01-neuter.eval.mjs', NEUTER()],
    ['02-fail.eval.mjs', FAIL('a')],
    ['03-ok.eval.mjs', OK('a')],
  ]);
  const statusErr = expectStatus(res, 1);
  if (statusErr) return { ok: false, note: `RC7: ${statusErr}` };
  if (res.stdout.indexOf('eval FAIL:') === -1) {
    return { ok: false, note: 'RC7: stdout missing "eval FAIL:"' };
  }
  if (res.stderr.indexOf('INCOMPLETE RUN') !== -1) {
    return {
      ok: false,
      note: 'RC7: stderr unexpectedly contains "INCOMPLETE RUN" — the run DID complete',
    };
  }
  return { ok: true, note: 'RC7: ok' };
}

function tRC8(root, liveText) {
  const res = run(root, 'RC8', liveText, [
    ['01-neuter.eval.mjs', NEUTER()],
    ['02-ok.eval.mjs', OK('a')],
    ['03-ok.eval.mjs', OK('b')],
  ]);
  const statusErr = expectStatus(res, 0);
  if (statusErr) return { ok: false, note: `RC8: ${statusErr}` };
  if (res.stderr.indexOf('INCOMPLETE RUN') !== -1) {
    return { ok: false, note: 'RC8: stderr unexpectedly contains "INCOMPLETE RUN"' };
  }
  return { ok: true, note: 'RC8: ok' };
}

// ---------------------------------------------------------------------------
// [RC/controls] — the guard must not red a clean or ordinarily-failing run.
// ---------------------------------------------------------------------------

function tRC9(root, liveText) {
  const res = run(root, 'RC9', liveText, [
    ['01-ok.eval.mjs', OK('a')],
    ['02-ok.eval.mjs', OK('b')],
    ['03-ok.eval.mjs', OK('c')],
  ]);
  const statusErr = expectStatus(res, 0);
  if (statusErr) return { ok: false, note: `RC9: ${statusErr}` };
  if (res.stderr.indexOf('INCOMPLETE RUN') !== -1) {
    return { ok: false, note: 'RC9: stderr unexpectedly contains "INCOMPLETE RUN"' };
  }
  return { ok: true, note: 'RC9: ok' };
}

function tRC10(root, liveText) {
  const res = run(root, 'RC10', liveText, [
    ['01-ok.eval.mjs', OK('a')],
    ['02-ok.eval.mjs', OK('b')],
    ['03-fail.eval.mjs', FAIL('a')],
  ]);
  const statusErr = expectStatus(res, 1);
  if (statusErr) return { ok: false, note: `RC10: ${statusErr}` };
  if (res.stdout.indexOf('eval FAIL:') === -1) {
    return { ok: false, note: 'RC10: stdout missing "eval FAIL:"' };
  }
  if (res.stderr.indexOf('INCOMPLETE RUN') !== -1) {
    return { ok: false, note: 'RC10: stderr unexpectedly contains "INCOMPLETE RUN"' };
  }
  return { ok: true, note: 'RC10: ok' };
}

function tRC11(root, liveText) {
  // M10.5d regression control: a thrower must not abort the loop nor read as truncation.
  const res = run(root, 'RC11', liveText, [
    ['01-thrower.eval.mjs', THROWER()],
    ['02-ok.eval.mjs', OK('a')],
  ]);
  const statusErr = expectStatus(res, 1);
  if (statusErr) return { ok: false, note: `RC11: ${statusErr}` };
  if (res.stderr.indexOf('eval THREW:') === -1) {
    return {
      ok: false,
      note: `RC11: stderr missing "eval THREW:" — got: ${res.stderr.slice(0, 300)}`,
    };
  }
  if (res.stdout.indexOf('eval FAIL:') === -1) {
    return { ok: false, note: 'RC11: stdout missing the synthetic "eval FAIL:" line' };
  }
  if (res.stdout.indexOf('ok-a') === -1) {
    return { ok: false, note: "RC11: stdout missing the second (completed) file's result" };
  }
  if (res.stderr.indexOf('INCOMPLETE RUN') !== -1) {
    return { ok: false, note: 'RC11: stderr unexpectedly contains "INCOMPLETE RUN"' };
  }
  return { ok: true, note: 'RC11: ok' };
}

function tRC12(root, liveText) {
  // Pins the `!process.exitCode` non-clobber clause: a handler that sets exitCode=1
  // unconditionally would overwrite the real process.exit(3) and red here.
  const res = run(root, 'RC12', liveText, [
    ['01-ok.eval.mjs', OK('a')],
    ['02-exit.eval.mjs', EXIT_MODULE(3)],
  ]);
  const statusErr = expectStatus(res, 3);
  if (statusErr) return { ok: false, note: `RC12: ${statusErr}` };
  if (res.stderr.indexOf('INCOMPLETE RUN') === -1) {
    return {
      ok: false,
      note: `RC12: stderr missing "INCOMPLETE RUN" — got: ${res.stderr.slice(0, 300)}`,
    };
  }
  if (res.stderr.indexOf('1 of 2') === -1) {
    return { ok: false, note: `RC12: stderr missing "1 of 2" — got: ${res.stderr.slice(0, 300)}` };
  }
  return { ok: true, note: 'RC12: ok' };
}

function tRC13(root, liveText) {
  // Empty evals/ (run.mjs only) — proves the FROZEN zero-eval guard's signature is textually
  // distinct from "INCOMPLETE RUN", so an accidentally-empty fixture dir can never be misread as
  // this guard biting.
  const res = run(root, 'RC13', liveText, []);
  const statusErr = expectStatus(res, 1);
  if (statusErr) return { ok: false, note: `RC13: ${statusErr}` };
  if (res.stderr.indexOf('zero eval files found') === -1) {
    return {
      ok: false,
      note: `RC13: stderr missing "zero eval files found" — got: ${res.stderr.slice(0, 300)}`,
    };
  }
  if (res.stderr.indexOf('INCOMPLETE RUN') !== -1) {
    return { ok: false, note: 'RC13: stderr unexpectedly contains "INCOMPLETE RUN"' };
  }
  return { ok: true, note: 'RC13: ok' };
}

// ---------------------------------------------------------------------------
// [RC/fail-open] — print-vs-set ordering inside the exit handler.
// ---------------------------------------------------------------------------

function tRC14(root, liveText) {
  const res = run(root, 'RC14', liveText, [
    ['01-poison.eval.mjs', POISON(0)],
    ['02-fail.eval.mjs', FAIL('a')],
  ]);
  const statusErr = expectStatus(res, 1);
  if (statusErr) {
    return {
      ok: false,
      note: `RC14: ${statusErr} — a poisoned logger committed AFTER setting the verdict must not fail open`,
    };
  }
  return { ok: true, note: 'RC14: ok' };
}

function tRC15(root, liveText) {
  const res = run(root, 'RC15', liveText, [
    ['01-poison.eval.mjs', POISON(5)],
    ['02-ok.eval.mjs', OK('a')],
  ]);
  const statusErr = expectStatus(res, 5);
  if (statusErr) {
    return {
      ok: false,
      note: `RC15: ${statusErr} — a poisoned logger must not turn a real code into 1`,
    };
  }
  return { ok: true, note: 'RC15: ok' };
}

// ---------------------------------------------------------------------------
// [RC/prefix-red] — the ADR-0010 differential.
// ---------------------------------------------------------------------------

function tRCM0(liveText) {
  const splice = spliceSentinelRegion(liveText);
  if (!splice.ok) {
    return { ok: false, note: `RC-M0: splice validation failed — ${splice.reason}`, spliced: null };
  }
  return { ok: true, note: 'RC-M0: ok', spliced: splice.spliced };
}

function tRCM1(root, splicedText) {
  const resA = run(root, 'RCM1a', splicedText, [
    ['01-ok.eval.mjs', OK('a')],
    ['02-ok.eval.mjs', OK('b')],
    ['03-ok.eval.mjs', OK('c')],
  ]);
  const errA = expectStatus(resA, 0);
  if (errA) return { ok: false, note: `RC-M1: (all-OK corpus, mutant) ${errA}` };

  const resB = run(root, 'RCM1b', splicedText, [
    ['01-ok.eval.mjs', OK('a')],
    ['02-ok.eval.mjs', OK('b')],
    ['03-fail.eval.mjs', FAIL('a')],
  ]);
  const errB = expectStatus(resB, 1);
  if (errB) return { ok: false, note: `RC-M1: (OK+OK+FAIL corpus, mutant) ${errB}` };
  return { ok: true, note: 'RC-M1: ok' };
}

function tRCM2(root, splicedText) {
  // RC1's corpus against the mutant — must reproduce the swallowed-FAIL class: status 0.
  const res = run(root, 'RCM2', splicedText, [
    ['01-fail.eval.mjs', FAIL('a')],
    ['02-exit.eval.mjs', EXIT_MODULE(0)],
    ['03-fail.eval.mjs', FAIL('b')],
  ]);
  const err = expectStatus(res, 0);
  if (err) return { ok: false, note: `RC-M2: ${err}` };
  return { ok: true, note: 'RC-M2: ok' };
}

function tRCM3(root, splicedText) {
  // RC7's corpus against the mutant — must reproduce the neutered-exit class: status 0.
  const res = run(root, 'RCM3', splicedText, [
    ['01-neuter.eval.mjs', NEUTER()],
    ['02-fail.eval.mjs', FAIL('a')],
    ['03-ok.eval.mjs', OK('a')],
  ]);
  const err = expectStatus(res, 0);
  if (err) return { ok: false, note: `RC-M3: ${err}` };
  return { ok: true, note: 'RC-M3: ok' };
}

function tRCM4(root, splicedText) {
  // RC2's corpus against the mutant — the no-genuine-FAIL truncation must also read as status 0.
  const res = run(root, 'RCM4', splicedText, [
    ['01-ok.eval.mjs', OK('a')],
    ['02-ok.eval.mjs', OK('b')],
    ['03-exit.eval.mjs', EXIT_MODULE(0)],
  ]);
  const err = expectStatus(res, 0);
  if (err) return { ok: false, note: `RC-M4: ${err}` };
  return { ok: true, note: 'RC-M4: ok' };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

function safe(id, fn) {
  try {
    const r = fn();
    return { id, ok: r.ok, note: r.note };
  } catch (err) {
    return { id, ok: false, note: `${id}: threw — ${err?.stack ?? err}` };
  }
}

export default async function () {
  const NAME =
    'run-completeness (rb-5 — evals/run.mjs mid-loop truncation + swallowed-verdict guard; ' +
    'residual R-m22-s0-X4, ADR-0209)';

  const teeth = [];
  let root = null;

  try {
    root = mkdtempSync(path.join(tmpdir(), 'rb5-run-completeness-'));

    // Cleanup safety: the fixture root must live under os.tmpdir() and must NOT be under the
    // repo root, asserted BEFORE anything is written into it.
    const sysTmp = tmpdir();
    if (root.indexOf(sysTmp) !== 0) {
      throw new Error(`fixture root ${root} does not start with os.tmpdir() (${sysTmp})`);
    }
    const repoRoot = path.resolve(path.dirname(RUN_MJS_PATH), '..');
    if (root.indexOf(repoRoot) === 0) {
      throw new Error(`fixture root ${root} is under the repo root ${repoRoot} — refusing to run`);
    }

    const liveText = readFileSync(RUN_MJS_PATH, 'utf8');

    // [RC/live]
    teeth.push(safe('RC1', () => tRC1(root, liveText)));
    teeth.push(safe('RC2', () => tRC2(root, liveText)));
    teeth.push(safe('RC3', () => tRC3(root, liveText)));
    teeth.push(safe('RC4', () => tRC4(root, liveText)));
    teeth.push(safe('RC5', () => tRC5(root, liveText)));
    teeth.push(safe('RC6', () => tRC6(root, liveText)));

    // [RC/neutered-exit]
    teeth.push(safe('RC7', () => tRC7(root, liveText)));
    teeth.push(safe('RC8', () => tRC8(root, liveText)));

    // [RC/controls]
    teeth.push(safe('RC9', () => tRC9(root, liveText)));
    teeth.push(safe('RC10', () => tRC10(root, liveText)));
    teeth.push(safe('RC11', () => tRC11(root, liveText)));
    teeth.push(safe('RC12', () => tRC12(root, liveText)));
    teeth.push(safe('RC13', () => tRC13(root, liveText)));

    // [RC/fail-open]
    teeth.push(safe('RC14', () => tRC14(root, liveText)));
    teeth.push(safe('RC15', () => tRC15(root, liveText)));

    // [RC/prefix-red]
    let splicedText = null;
    try {
      const m0result = tRCM0(liveText);
      teeth.push({ id: 'RC-M0', ok: m0result.ok, note: m0result.note });
      splicedText = m0result.ok ? m0result.spliced : null;
    } catch (err) {
      teeth.push({ id: 'RC-M0', ok: false, note: `RC-M0: threw — ${err?.stack ?? err}` });
    }
    if (splicedText != null) {
      teeth.push(safe('RC-M1', () => tRCM1(root, splicedText)));
      teeth.push(safe('RC-M2', () => tRCM2(root, splicedText)));
      teeth.push(safe('RC-M3', () => tRCM3(root, splicedText)));
      teeth.push(safe('RC-M4', () => tRCM4(root, splicedText)));
    } else {
      teeth.push({ id: 'RC-M1', ok: false, note: 'RC-M1: gated — RC-M0 prerequisite failed' });
      teeth.push({ id: 'RC-M2', ok: false, note: 'RC-M2: gated — RC-M0 prerequisite failed' });
      teeth.push({ id: 'RC-M3', ok: false, note: 'RC-M3: gated — RC-M0 prerequisite failed' });
      teeth.push({ id: 'RC-M4', ok: false, note: 'RC-M4: gated — RC-M0 prerequisite failed' });
    }
  } catch (err) {
    teeth.push({ id: 'RC-SETUP', ok: false, note: `RC-SETUP: ${err?.stack ?? err}` });
  } finally {
    if (root != null) {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const allOk = teeth.length > 0 && teeth.every((t) => t.ok);
  let detail;
  if (allOk) {
    detail =
      '[RC/live] [RC/neutered-exit] [RC/controls] [RC/fail-open] [RC/prefix-red] [RC/diagnostic] ' +
      `(${teeth.length} teeth verified)`;
  } else {
    const failing = teeth.filter((t) => !t.ok).map((t) => t.note);
    detail = `FAILED: ${failing.join(' | ')}`;
  }

  return { name: NAME, pass: allOk, detail };
}
