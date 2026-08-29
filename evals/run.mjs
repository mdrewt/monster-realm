#!/usr/bin/env node
// Minimal living eval harness. Runs every evals/*.eval.mjs whose default export
// is an async fn returning { name, pass, detail }. Fails the build on any miss.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.resolve('evals');
let files = [];
try {
  files = (await readdir(dir)).filter((f) => f.endsWith('.eval.mjs'));
} catch {}

if (files.length === 0) {
  console.error(
    'eval: zero eval files found in evals/ — expected 40+ evals/*.eval.mjs; ' +
      'empty can only mean a broken cwd or checkout (fail-open is a silent blind-spot).',
  );
  process.exit(1);
}

let failed = 0;
let completed = 0;
let inFlight = '(none — the run ended before the first eval was imported)';

// rb-5:exit-verdict BEGIN  (residual R-m22-s0-X4, ADR-0209)
// Every eval's module BODY runs in THIS process, so a module-scope process.exit()
// ends the run where it stands: the later evals never run and the terminal
// process.exit(failed ? 1 : 0) below never executes, so the FAIL lines already
// printed above it never become an exit code. MEASURED: 37 of 90 evals ran, 3
// FAILs were swallowed, the run exited 0 and `just ci` was green. The shape is a
// standalone-runner main guard widened to compare dirname or endsWith('run.mjs')
// — under this harness process.argv[1] is evals/run.mjs, a real SIBLING path.
// A second measured class does it from the other end: `process.exit = () => {}`
// at module scope neuters the terminal call, and node then exits naturally at 0.
//
// process.exit(code) assigns process.exitCode, EMITS 'exit', and only THEN reads
// the code back to really exit — so this handler can still raise a zero verdict.
//
// The statement order below is load-bearing and the obvious order is a fail-OPEN:
// commit the verdict BEFORE printing. A console.error that throws (a poisoned
// console, EPIPE from a truncating `| head`, EIO on a full disk) aborts this
// handler, and node then honours the code process.exit(0) already committed —
// measured exit 0 with the print first, exit 1 with the verdict first.
// Only ever RAISES a zero/undefined code: a genuine process.exit(3) still exits 3,
// because a gate that rewrote a real exit code would be destroying evidence.
// Teeth: evals/run-completeness.eval.mjs (it builds the pre-fix harness by
// splicing THIS region out of the live file, so the RED control is never a copy).
process.on('exit', () => {
  const incomplete = completed !== files.length;
  if ((incomplete || failed > 0) && !process.exitCode) process.exitCode = 1;
  if (incomplete) {
    try {
      console.error(
        `eval: INCOMPLETE RUN — ${completed} of ${files.length} discovered eval file(s) reported a ` +
          `result; the run ended while ${inFlight} was in flight. The remaining evals never ran, ` +
          'and any FAIL line printed above was never counted. Look for a module-scope ' +
          'process.exit() in that file — most often a standalone-runner main guard that matches ' +
          'a sibling path instead of this module.',
      );
    } catch {
      // A broken stderr must never undo the verdict committed above.
    }
  }
});
// rb-5:exit-verdict END

for (const f of files) {
  inFlight = f;
  // M10.5d: per-eval try/catch so one throwing eval does not abort the loop and
  // hide later results. A thrower records a synthetic pass:false and the loop
  // continues. The non-zero exit at the end still fires because failed > 0.
  let res;
  try {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    res = await mod.default();
  } catch (err) {
    console.error(`eval THREW: ${f} — ${err?.stack ?? err}`);
    res = { name: f, pass: false, detail: `threw: ${err?.message ?? String(err)}` };
  }
  const ok = res.pass ? 'PASS' : 'FAIL';
  console.log(`eval ${ok}: ${res.name}${res.detail ? ` — ${res.detail}` : ''}`);
  if (!res.pass) failed++;
  // AFTER the result line, deliberately: an eval that exits from inside default()
  // has not reported in, and must leave the count short.
  completed++;
}
// Kept alongside the exit-time verdict on purpose: this exits promptly, so a
// straggler handle left open by an eval cannot hang the suite. The handler above
// fires on this call too and can still correct the code.
process.exit(failed ? 1 : 0);
