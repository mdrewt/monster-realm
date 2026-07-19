// verify-build-hooks.mjs — pt-a2 (ADR-0129, EARS pt-a2-4)
//
// Scans the emitted `client/dist/**/*.js` production bundle and fails loud
// (non-zero exit) if any DEV debug-hook `window`-binding survives into the
// honest build. It matches the BINDING form (`.__game=`/`.__mrTrade=`/
// `.__mrPvp=`, plus the `defineProperty(window,"__x"` escape), NOT a bare
// substring: an unminified build legitimately retains dead object literals
// (`{challengePvp,proposeTrade}`) not attached to `window` (ADR-0128 §D3), and
// the ungated prod build stamp `window.__mrBuild=` must NOT be flagged.
//
// It fails loud when `client/dist` is absent or contains zero `.js` files —
// scanning nothing must never read as green (§K B-2/F3).
//
// Functional-core / imperative-shell: `findDevHooks` is exported and unit-gated
// by evals/playtest-verify.eval.mjs; the file I/O runs only in the main-guarded
// driver at the bottom.
//
// NO `new RegExp(...)` anywhere (Semgrep detect-non-literal-regexp): literal
// patterns + String methods only.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The canonical DEV-hook fingerprint set (§K F4 + ADR-0128 §D3). The window-
// binding assignment form (leading `.` also catches `w.`/`globalThis.`/`self.`
// receivers) plus the defineProperty escape. NO bracket `["__game"]` forms (vite
// emits no sourcemaps by default so they aren't reachable); NO bare `__game`
// substring; and NOT `.__mrBuild=` (the ungated prod stamp is not a dev hook).
export const DEV_HOOK_FINGERPRINTS = [
  '.__game=',
  '.__game =',
  '.__mrTrade=',
  '.__mrTrade =',
  '.__mrPvp=',
  '.__mrPvp =',
  'defineProperty(window,"__game"',
  "defineProperty(window,'__game'",
  'defineProperty(window,"__mrTrade"',
  "defineProperty(window,'__mrTrade'",
  'defineProperty(window,"__mrPvp"',
  "defineProperty(window,'__mrPvp'",
];

// findDevHooks(bundleText, fingerprints) -> string[]
//
// Returns the fingerprints present in the bundle (exact substring match). The
// fingerprint set carries BOTH the no-space (`.__mrPvp=`) and single-space
// (`.__mrPvp =`) binding forms — the only shapes a real minified/pretty vite
// build emits — so no whitespace normalization is needed. (Normalizing would
// collapse a newline between `.__mrPvp` and `=` and risk matching a split that
// no bundler emits — a false-positive vector we deliberately avoid.)
export function findDevHooks(bundleText, fingerprints) {
  return fingerprints.filter((fp) => bundleText.includes(fp));
}

// ---------------------------------------------------------------------------
// Driver helper: recursively collect *.js files under a directory.
// ---------------------------------------------------------------------------
function collectJsFiles(dir) {
  const found = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Main-guarded driver (live FS I/O). Not run on import.
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Optional explicit dir override (argv[2]) for local checks; default dist.
  const distDir = process.argv[2] || path.join('client', 'dist');

  if (!existsSync(distDir)) {
    console.error(
      `verify-build-hooks: "${distDir}" does not exist — run \`just playtest-up\` / vite build first`,
    );
    process.exit(1);
  }

  const jsFiles = collectJsFiles(distDir);
  if (jsFiles.length === 0) {
    console.error(
      `verify-build-hooks: no .js files found under "${distDir}" — run \`just playtest-up\` / vite build first`,
    );
    process.exit(1);
  }

  let concat = '';
  const perFile = new Map();
  for (const file of jsFiles) {
    const text = readFileSync(file, 'utf8');
    concat += `\n${text}`;
    perFile.set(file, text);
  }

  const offenders = findDevHooks(concat, DEV_HOOK_FINGERPRINTS);
  if (offenders.length > 0) {
    // Attribute each offender to a file for a clear diagnostic.
    for (const fp of offenders) {
      for (const [file, text] of perFile) {
        if (findDevHooks(text, [fp]).length > 0) {
          console.error(`verify-build-hooks: FAIL — DEV hook "${fp}" present in ${file}`);
          break;
        }
      }
    }
    console.error(
      `verify-build-hooks: ${offenders.length} DEV hook fingerprint(s) leaked into the production build — the honest build must strip __game/__mrTrade/__mrPvp.`,
    );
    process.exit(1);
  }

  console.log(
    `verify-build-hooks: OK — scanned ${jsFiles.length} .js file(s) under "${distDir}"; no DEV hooks (__game/__mrTrade/__mrPvp) present.`,
  );
  process.exit(0);
}
