#!/usr/bin/env node
// Runs every evals/*.eval.mjs (default export: async () => ({ name, pass, detail })).
// Exits non-zero if any eval fails, throws, or the run ends before every eval reports.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.resolve('evals');
const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.eval.mjs'));
if (files.length === 0) {
  console.error('eval: zero evals/*.eval.mjs found — broken cwd or checkout');
  process.exit(1);
}

let failed = 0;
let completed = 0;
let inFlight = '(none)';

// Evals run in this process, so an eval calling process.exit() (or stubbing it out) would end the
// run early and exit 0. Raise a zero/unset code to 1 on an incomplete or failing run — before
// printing, so a throwing stderr cannot undo it — and never lower a real non-zero code.
process.on('exit', () => {
  const incomplete = completed !== files.length;
  if ((incomplete || failed > 0) && !process.exitCode) process.exitCode = 1;
  if (incomplete) {
    try {
      console.error(
        `eval: INCOMPLETE RUN — ${completed} of ${files.length} reported; ended during ${inFlight}`,
      );
    } catch {}
  }
});

for (const f of files) {
  inFlight = f;
  let res;
  try {
    res = await (await import(pathToFileURL(path.join(dir, f)).href)).default();
  } catch (err) {
    console.error(`eval THREW: ${f} — ${err?.stack ?? err}`);
    res = { name: f, pass: false, detail: `threw: ${err?.message ?? String(err)}` };
  }
  console.log(
    `eval ${res.pass ? 'PASS' : 'FAIL'}: ${res.name}${res.detail ? ` — ${res.detail}` : ''}`,
  );
  if (!res.pass) failed++;
  completed++; // after the result line: an eval that exits inside default() leaves the count short
}
process.exit(failed ? 1 : 0);
