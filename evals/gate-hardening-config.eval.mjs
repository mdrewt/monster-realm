// M10.5d — Gate hardening config — 4 EARS criteria eval
//
// Each criterion is a PURE predicate over file content. The proof-of-teeth
// section runs each predicate against a KNOWN-BAD fixture FIRST; if the
// predicate fails to reject its bad fixture the eval itself fails with a
// diagnostic. A KNOWN-GOOD fixture is also verified so the predicate cannot
// be trivially-false. Only after all teeth are proven do the real files get
// checked.
//
// IMPORTANT: NO new RegExp(...) anywhere — the remote Semgrep gate
// (detect-non-literal-regexp) has bitten this project 3x. Only literal regex
// literals and String methods (includes/indexOf/startsWith/split) are used.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Criterion A: client/vite.config.ts must contain `allowOnly: false`
//
// Wrong impl killed: the current vite.config.ts test block which has
// `include: ['src/**/*.test.ts']` but no `allowOnly` key at all.
// This allows `it.only()`/`describe.only()` to silently skip other tests
// in CI, creating false-green builds.
// ---------------------------------------------------------------------------
export function vitestHasAllowOnlyFalse(text) {
  return text.includes('allowOnly: false');
}

// ---------------------------------------------------------------------------
// Criterion B: client/playwright.config.ts must contain `forbidOnly`
//
// Wrong impl killed: the current playwright.config.ts which has no
// `forbidOnly` key. Without it, `test.only()` in e2e specs silently passes
// CI while skipping all other e2e tests.
// ---------------------------------------------------------------------------
export function playwrightHasForbidOnly(text) {
  return text.includes('forbidOnly');
}

// ---------------------------------------------------------------------------
// Criterion C: evals/run.mjs eval loop must wrap each invocation in try/catch
// AND emit a synthetic `pass: false` record for throwers, so one crashing eval
// does not abort the entire loop (which would yield a false-green: zero output
// for all subsequent evals).
//
// Wrong impl killed: the current run.mjs which has no try/catch in the loop —
// `await mod.default()` can throw and the process exits with an unhandled
// rejection, silently skipping all remaining evals.
// ---------------------------------------------------------------------------
export function runMjsHasEvalIsolation(text) {
  // Must contain BOTH a try block AND a catch block (per-eval isolation)
  // AND a synthetic pass: false record (so throwers are counted as failures).
  return text.includes('try') && text.includes('catch') && text.includes('pass: false');
}

// ---------------------------------------------------------------------------
// Criterion D: client/src/net/store.ts flushBatch must wrap each listener call
// in its own try/catch so one throwing listener cannot starve the others.
//
// Wrong impl killed: the current flushBatch with `for (const cb of [...this.#batchListeners]) cb()`
// — a throwing cb exits the for loop immediately, and all subsequent listeners
// are never called (starvation). The render loop has multiple listeners and the
// dialogue/quest/heal overlays would freeze silently.
//
// Strategy: confirm that `flushBatch` and `try` and `catch` all appear in the
// file AND that `try` appears AFTER `flushBatch` (so the try is inside the method,
// not somewhere unrelated before it).
// ---------------------------------------------------------------------------
export function storeTsFlushBatchHasIsolation(text) {
  if (!text.includes('flushBatch')) return false;
  if (!text.includes('try')) return false;
  if (!text.includes('catch')) return false;
  // Confirm the try appears after flushBatch (not some unrelated try before it)
  const flushBatchIdx = text.indexOf('flushBatch');
  const tryIdx = text.indexOf('try', flushBatchIdx);
  return tryIdx !== -1;
}

// ---------------------------------------------------------------------------
// Default export: proof-of-teeth then real file checks
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'gate-hardening-config (M10.5d — allowOnly/forbidOnly/run.mjs-isolation/flushBatch-isolation)';

  // =========================================================================
  // PROOF-OF-TEETH — bad fixtures first, then good fixtures
  // =========================================================================

  // --- Tooth A: vitestHasAllowOnlyFalse ---

  // Bad: current vite.config.ts state — no allowOnly key at all
  const badViteNoAllowOnly = [
    'export default defineConfig({',
    '  test: {',
    '    include: ["src/**/*.test.ts"],',
    '    coverage: { include: ["src/**/*.ts"] },',
    '  },',
    '});',
  ].join('\n');
  if (vitestHasAllowOnlyFalse(badViteNoAllowOnly)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (A)-bad: vitestHasAllowOnlyFalse failed to reject a vite config without allowOnly key (current state)',
    };
  }

  // Bad: allowOnly key present but set to true (wrong value — would still allow only)
  const badViteAllowOnlyTrue = [
    'export default defineConfig({',
    '  test: {',
    '    include: ["src/**/*.test.ts"],',
    '    allowOnly: true,',
    '  },',
    '});',
  ].join('\n');
  if (vitestHasAllowOnlyFalse(badViteAllowOnlyTrue)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (A)-bad2: vitestHasAllowOnlyFalse failed to reject a vite config with allowOnly: true',
    };
  }

  // Good: allowOnly: false present
  const goodViteAllowOnly = [
    'export default defineConfig({',
    '  test: {',
    '    include: ["src/**/*.test.ts"],',
    '    allowOnly: false,',
    '    coverage: { include: ["src/**/*.ts"] },',
    '  },',
    '});',
  ].join('\n');
  if (!vitestHasAllowOnlyFalse(goodViteAllowOnly)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (A)-good: vitestHasAllowOnlyFalse wrongly rejected a vite config containing allowOnly: false',
    };
  }

  // --- Tooth B: playwrightHasForbidOnly ---

  // Bad: current playwright.config.ts — no forbidOnly at all
  const badPlaywrightNoForbidOnly = [
    'export default defineConfig({',
    '  testDir: "./e2e",',
    '  timeout: 45_000,',
    '  fullyParallel: false,',
    '  use: { baseURL: e2eBaseUrl, headless: true },',
    '});',
  ].join('\n');
  if (playwrightHasForbidOnly(badPlaywrightNoForbidOnly)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (B)-bad: playwrightHasForbidOnly failed to reject a playwright config without forbidOnly (current state)',
    };
  }

  // Good: forbidOnly: !!process.env.CI present
  const goodPlaywrightForbidOnly = [
    'export default defineConfig({',
    '  testDir: "./e2e",',
    '  forbidOnly: !!process.env.CI,',
    '  timeout: 45_000,',
    '  fullyParallel: false,',
    '  use: { baseURL: e2eBaseUrl, headless: true },',
    '});',
  ].join('\n');
  if (!playwrightHasForbidOnly(goodPlaywrightForbidOnly)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (B)-good: playwrightHasForbidOnly wrongly rejected a playwright config containing forbidOnly',
    };
  }

  // --- Tooth C: runMjsHasEvalIsolation ---

  // Bad: current run.mjs state — no try/catch in the loop at all
  const badRunMjsNoTryCatch = [
    'for (const f of files) {',
    '  const mod = await import(pathToFileURL(path.join(dir, f)).href);',
    '  const res = await mod.default();',
    '  const ok = res.pass ? "PASS" : "FAIL";',
    '  console.log(`eval ${ok}: ${res.name}`);',
    '  if (!res.pass) failed++;',
    '}',
  ].join('\n');
  if (runMjsHasEvalIsolation(badRunMjsNoTryCatch)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (C)-bad: runMjsHasEvalIsolation failed to reject a run.mjs loop without try/catch (current state)',
    };
  }

  // Bad: has try/catch but no synthetic pass: false (throwers would be silently ignored)
  const badRunMjsNoPaseFalse = [
    'for (const f of files) {',
    '  try {',
    '    const mod = await import(pathToFileURL(path.join(dir, f)).href);',
    '    const res = await mod.default();',
    '    const ok = res.pass ? "PASS" : "FAIL";',
    '    console.log(`eval ${ok}: ${res.name}`);',
    '    if (!res.pass) failed++;',
    '  } catch (err) {',
    '    console.error("eval threw:", err);',
    '  }',
    '}',
  ].join('\n');
  if (runMjsHasEvalIsolation(badRunMjsNoPaseFalse)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (C)-bad2: runMjsHasEvalIsolation failed to reject a run.mjs with try/catch but no synthetic pass: false record',
    };
  }

  // Good: try/catch AND pass: false
  const goodRunMjs = [
    'for (const f of files) {',
    '  let res;',
    '  try {',
    '    const mod = await import(pathToFileURL(path.join(dir, f)).href);',
    '    res = await mod.default();',
    '  } catch (err) {',
    '    console.error("eval threw:", f, err);',
    '    res = { name: f, pass: false, detail: String(err) };',
    '  }',
    '  const ok = res.pass ? "PASS" : "FAIL";',
    '  console.log(`eval ${ok}: ${res.name}`);',
    '  if (!res.pass) failed++;',
    '}',
  ].join('\n');
  if (!runMjsHasEvalIsolation(goodRunMjs)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (C)-good: runMjsHasEvalIsolation wrongly rejected a run.mjs with try/catch and pass: false',
    };
  }

  // --- Tooth D: storeTsFlushBatchHasIsolation ---

  // Bad: current store.ts state — flushBatch with bare for loop, no try/catch
  const badStoreTsNoTryCatch = [
    'flushBatch(): void {',
    '  if (!this.#dirty) return;',
    '  this.#dirty = false;',
    '  for (const cb of [...this.#batchListeners]) cb();',
    '}',
  ].join('\n');
  if (storeTsFlushBatchHasIsolation(badStoreTsNoTryCatch)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (D)-bad: storeTsFlushBatchHasIsolation failed to reject a flushBatch without try/catch (current state)',
    };
  }

  // Bad: has try/catch but in a different method before flushBatch (order check)
  const badStoreTsTryCatchBeforeFlushBatch = [
    'someOtherMethod(): void {',
    '  try {',
    '    doSomething();',
    '  } catch (e) {',
    '    console.error(e);',
    '  }',
    '}',
    'flushBatch(): void {',
    '  if (!this.#dirty) return;',
    '  this.#dirty = false;',
    '  for (const cb of [...this.#batchListeners]) cb();',
    '}',
  ].join('\n');
  // NOTE: this fixture has try BEFORE flushBatch, so indexOf('try', flushBatchIdx) returns -1
  // — the predicate correctly returns false for this shape.
  if (storeTsFlushBatchHasIsolation(badStoreTsTryCatchBeforeFlushBatch)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (D)-bad2: storeTsFlushBatchHasIsolation failed to reject a store where try/catch appears only BEFORE flushBatch (not inside it)',
    };
  }

  // Good: flushBatch with per-listener try/catch
  const goodStoreTsWithTryCatch = [
    'flushBatch(): void {',
    '  if (!this.#dirty) return;',
    '  this.#dirty = false;',
    '  for (const cb of [...this.#batchListeners]) {',
    '    try {',
    '      cb();',
    '    } catch (err) {',
    '      console.error("flushBatch listener threw:", err);',
    '    }',
    '  }',
    '}',
  ].join('\n');
  if (!storeTsFlushBatchHasIsolation(goodStoreTsWithTryCatch)) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth (D)-good: storeTsFlushBatchHasIsolation wrongly rejected a flushBatch with per-listener try/catch',
    };
  }

  // =========================================================================
  // REAL FILE CHECKS
  // =========================================================================
  const root = path.resolve('.');

  const viteConfigPath = path.join(root, 'client/vite.config.ts');
  const playwrightConfigPath = path.join(root, 'client/playwright.config.ts');
  const runMjsPath = path.join(root, 'evals/run.mjs');
  const storeTsPath = path.join(root, 'client/src/net/store.ts');

  let viteConfig, playwrightConfig, runMjs, storeTs;

  try {
    viteConfig = readFileSync(viteConfigPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read client/vite.config.ts' };
  }

  try {
    playwrightConfig = readFileSync(playwrightConfigPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read client/playwright.config.ts' };
  }

  try {
    runMjs = readFileSync(runMjsPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read evals/run.mjs' };
  }

  try {
    storeTs = readFileSync(storeTsPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read client/src/net/store.ts' };
  }

  // Criterion A
  if (!vitestHasAllowOnlyFalse(viteConfig)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (A) FAIL: client/vite.config.ts test block must contain allowOnly: false — currently absent (allows it.only/describe.only to silently skip tests in CI)',
    };
  }

  // Criterion B
  if (!playwrightHasForbidOnly(playwrightConfig)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (B) FAIL: client/playwright.config.ts must contain forbidOnly — currently absent (allows test.only to silently skip e2e tests in CI)',
    };
  }

  // Criterion C
  if (!runMjsHasEvalIsolation(runMjs)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (C) FAIL: evals/run.mjs eval loop must wrap each invocation in try/catch AND record a synthetic pass: false for throwers — currently bare await with no isolation',
    };
  }

  // Criterion D
  if (!storeTsFlushBatchHasIsolation(storeTs)) {
    return {
      name,
      pass: false,
      detail:
        'criterion (D) FAIL: client/src/net/store.ts flushBatch must wrap each listener call in try/catch so one throwing listener cannot starve siblings — currently bare cb() with no isolation',
    };
  }

  return {
    name,
    pass: true,
    detail:
      'all 4 criteria met: vitest allowOnly: false, playwright forbidOnly present, run.mjs per-eval try/catch + pass: false, flushBatch per-listener try/catch isolation',
  };
}
