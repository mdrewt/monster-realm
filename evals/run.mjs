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
  console.log('eval: no evals defined yet (add evals/*.eval.mjs). Passing.');
  process.exit(0);
}

let failed = 0;
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(dir, f)).href);
  const res = await mod.default();
  const ok = res.pass ? 'PASS' : 'FAIL';
  console.log(`eval ${ok}: ${res.name}${res.detail ? ` — ${res.detail}` : ''}`);
  if (!res.pass) failed++;
}
process.exit(failed ? 1 : 0);
