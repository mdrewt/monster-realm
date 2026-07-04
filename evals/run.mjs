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
    'eval: zero eval files found in evals/ — expected 37+ evals/*.eval.mjs; ' +
      'empty can only mean a broken cwd or checkout (fail-open is a silent blind-spot).',
  );
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  // M10.5d: per-eval try/catch so one throwing eval does not abort the loop and
  // hide later results. A thrower records a synthetic pass:false and the loop
  // continues. The non-zero exit at the end still fires because failed > 0.
  let res;
  try {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    res = await mod.default();
  } catch (err) {
    console.error(`eval THREW: ${f} — ${err?.stack ?? err}`);
    res = { name: f, pass: false, detail: `threw: ${err?.message ?? err}` };
  }
  const ok = res.pass ? 'PASS' : 'FAIL';
  console.log(`eval ${ok}: ${res.name}${res.detail ? ` — ${res.detail}` : ''}`);
  if (!res.pass) failed++;
}
process.exit(failed ? 1 : 0);
