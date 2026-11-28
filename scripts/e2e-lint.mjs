#!/usr/bin/env node
// `just lint`'s e2e flake ratchet. Two patterns make Playwright suites flaky:
//   wait  a fixed delay (`.waitForTimeout(`, a bare `sleep(` or `setTimeout(` call) standing in
//         for a condition the test could wait on (`expect.poll`, `toBeVisible`, a locator);
//   port  a hard-coded host:port literal, which collides when two suites or shards share a box.
// Lines that already have them are counted per file in scripts/e2e-lint.baseline.json. A file
// that has MORE than its baseline fails. A line is exempt when it, or the line above it, carries
// `e2e-lint-ok: <reason>` (a delay that IS the behaviour under test, e.g. "nothing happens for
// N steps"). Comment-only lines are not counted. `test.setTimeout(` and `socket.setTimeout(` set
// a timeout, not a delay, and are not counted.
//
//   node scripts/e2e-lint.mjs [--root DIR]                   check (exit 1 on any finding)
//   node scripts/e2e-lint.mjs [--root DIR] --write-baseline  lower the baseline to today's counts
//
// The ratchet only turns one way: a file BELOW its baseline also fails, so the allowance a
// removed wait leaves behind cannot be spent by a new one; `--write-baseline` then records the
// lower count, and refuses to raise any count.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const RULES = {
  wait: /\.waitForTimeout\(|(?<![\w.$])(?:sleep|setTimeout)\(/,
  port: /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b/,
};
const DEFINITION = /\bfunction\s+(?:sleep|setTimeout)\s*\(/;
const EXEMPT = /e2e-lint-ok:\s*\S/;
const COMMENT_ONLY = /^\s*(?:\/\/|\/\*|\*)/;
const E2E_DIR = join('client', 'e2e');
const BASELINE = join('scripts', 'e2e-lint.baseline.json');

function args(argv) {
  const out = { root: process.cwd(), write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') out.root = argv[++i];
    else if (argv[i] === '--write-baseline') out.write = true;
    else {
      console.error(`e2e-lint: unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  return out;
}

function tsFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

/** Every counted hit, as { rule, file, line, text }. */
export function scan(root) {
  const hits = [];
  for (const abs of tsFiles(join(root, E2E_DIR))) {
    const file = relative(root, abs).split('\\').join('/');
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      if (COMMENT_ONLY.test(text)) return;
      if (EXEMPT.test(text) || (i > 0 && EXEMPT.test(lines[i - 1]))) return;
      for (const [rule, re] of Object.entries(RULES)) {
        if (rule === 'wait' && DEFINITION.test(text)) continue;
        if (re.test(text)) hits.push({ rule, file, line: i + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

function counts(hits) {
  const c = { wait: {}, port: {} };
  for (const h of hits) c[h.rule][h.file] = (c[h.rule][h.file] ?? 0) + 1;
  return c;
}

const total = (hits, rule) => hits.filter((h) => h.rule === rule).length;

function main() {
  const { root, write } = args(process.argv.slice(2));
  const hits = scan(root);
  const now = counts(hits);
  const path = join(root, BASELINE);
  const base = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;

  if (write) {
    if (base) {
      const rises = [];
      for (const rule of Object.keys(RULES))
        for (const [file, n] of Object.entries(now[rule]))
          if (n > (base[rule]?.[file] ?? 0))
            rises.push(`${rule} ${file}: ${base[rule]?.[file] ?? 0} -> ${n}`);
      if (rises.length) {
        console.error(
          'e2e-lint: --write-baseline never raises a count; fix or exempt these first:',
        );
        for (const r of rises) console.error(`  ${r}`);
        process.exit(1);
      }
    }
    const sorted = {};
    for (const rule of Object.keys(RULES))
      sorted[rule] = Object.fromEntries(
        Object.entries(now[rule]).sort(([a], [b]) => a.localeCompare(b)),
      );
    writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(
      `E2E-LINT-BASELINE-WRITTEN wait=${total(hits, 'wait')} port=${total(hits, 'port')}`,
    );
    return;
  }

  if (!base) {
    console.error(`e2e-lint: no baseline at ${BASELINE}; run with --write-baseline`);
    process.exit(1);
  }
  const problems = [];
  for (const rule of Object.keys(RULES)) {
    const files = new Set([...Object.keys(now[rule]), ...Object.keys(base[rule] ?? {})]);
    for (const file of [...files].sort()) {
      const n = now[rule][file] ?? 0;
      const allowed = base[rule]?.[file] ?? 0;
      if (n > allowed) {
        const what =
          rule === 'wait'
            ? 'a fixed delay: wait on a condition instead (expect.poll, a locator assertion)'
            : 'a hard-coded host:port: take it from the environment or the Playwright config';
        problems.push(
          `${file}: ${n} ${rule} line(s), baseline ${allowed} -- ${what}, or mark a delay that IS the behaviour under test with \`// e2e-lint-ok: <reason>\`:`,
        );
        for (const h of hits.filter((x) => x.rule === rule && x.file === file))
          problems.push(`    ${h.file}:${h.line}  ${h.text.slice(0, 120)}`);
      } else if (n < allowed) {
        problems.push(
          `${file}: ${n} ${rule} line(s), baseline ${allowed} -- RATCHET: run \`node scripts/e2e-lint.mjs --write-baseline\` to lower it`,
        );
      }
    }
  }
  if (problems.length) {
    console.error('E2E-LINT-FAIL');
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(`E2E-LINT-OK wait=${total(hits, 'wait')} port=${total(hits, 'port')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
