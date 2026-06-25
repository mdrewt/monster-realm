// Bindings-drift eval (ADR-0009, closes v1 G3): committed client bindings must
// equal a fresh `spacetime generate`. Stale bindings shipping green was a v1
// blind spot. Needs the spacetime CLI — in cloud CI it runs against a
// containerized instance; locally it runs if the CLI is present, else skips
// (the CLI-less default-CI path stays green).
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p));
  }
  return out.sort();
}

// Pure: relative paths that differ (missing on a side, or different contents).
export function diffDirs(a, b) {
  const all = new Set([...listFiles(a), ...listFiles(b)]);
  const drift = [];
  for (const f of all) {
    const pa = path.join(a, f);
    const pb = path.join(b, f);
    if (!existsSync(pa) || !existsSync(pb)) {
      drift.push(f);
      continue;
    }
    if (readFileSync(pa, 'utf8') !== readFileSync(pb, 'utf8')) drift.push(f);
  }
  return drift;
}

function hasCli() {
  try {
    execSync('spacetime --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export default async function () {
  const name = 'bindings-drift (committed bindings == fresh generate)';

  // Proof-of-teeth: diffDirs must detect non-identical trees.
  const t1 = mkdtempSync(path.join(os.tmpdir(), 'mr-teeth-a-'));
  const t2 = mkdtempSync(path.join(os.tmpdir(), 'mr-teeth-b-'));
  writeFileSync(path.join(t1, 'x.ts'), 'A');
  writeFileSync(path.join(t2, 'x.ts'), 'B');
  if (diffDirs(t1, t2).length === 0) {
    return { name, pass: false, detail: 'proof-of-teeth: diffDirs failed to detect a difference' };
  }

  if (!hasCli()) {
    return { name, pass: true, detail: 'skipped: no spacetime CLI (gated in CI via containerized spacetime)' };
  }
  const committed = 'client/src/module_bindings';
  if (!existsSync(committed)) {
    return { name, pass: false, detail: 'no committed bindings to compare' };
  }
  const fresh = mkdtempSync(path.join(os.tmpdir(), 'mr-bindings-'));
  try {
    execSync(`spacetime generate --lang typescript --module-path server-module --out-dir ${fresh}`, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    return { name, pass: false, detail: `generate failed: ${String(e.stderr || e.message).slice(0, 200)}` };
  }
  const drift = diffDirs(committed, fresh);
  return {
    name,
    pass: drift.length === 0,
    detail: drift.length
      ? `DRIFT in: ${drift.slice(0, 5).join(', ')} — run spacetime generate + commit`
      : 'committed bindings match a fresh generate (teeth verified)',
  };
}
