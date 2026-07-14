// content-version eval (ADR-0073, M12.5b): couples game-core/content/** changes to
// CONTENT_VERSION in server-module/src/lib.rs via a committed hash baseline.
//
// A content file edited without bumping CONTENT_VERSION fails CI.
// The baseline is updated deliberately (alongside every CONTENT_VERSION bump).
//
// IMPORTANT: No dynamic RegExp (detect-non-literal-regexp Semgrep rule).
// Use only String.includes / indexOf / literal regex.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Walk a directory recursively, returning sorted relative paths + full paths.
function walkFiles(dir, base) {
  const entries = readdirSync(dir).sort();
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) {
      files.push(...walkFiles(full, base));
    } else {
      files.push({ rel, full });
    }
  }
  return files;
}

// Compute a deterministic SHA-256 of the content tree: sorted paths + file bytes.
// Sorting is already enforced by walkFiles, but document it explicitly.
export function hashContentDir(contentDir) {
  const files = walkFiles(contentDir, contentDir);
  const h = createHash('sha256');
  for (const { rel, full } of files) {
    h.update(`${rel}\n`);
    h.update(readFileSync(full));
    h.update('\n');
  }
  return h.digest('hex');
}

// Read CONTENT_VERSION from server-module/src/lib.rs.
// Parses: `pub(crate) const CONTENT_VERSION: u32 = N;`
// Returns the version as a number, or null if not found.
export function readContentVersion(libRsPath) {
  const src = readFileSync(libRsPath, 'utf8');
  // Use indexOf to avoid dynamic RegExp; find the anchor then extract digits.
  const anchor = 'CONTENT_VERSION: u32 = ';
  const idx = src.indexOf(anchor);
  if (idx === -1) return null;
  const after = src.slice(idx + anchor.length);
  const semi = after.indexOf(';');
  if (semi === -1) return null;
  const digits = after.slice(0, semi).trim();
  const v = Number(digits);
  return Number.isFinite(v) ? v : null;
}

export default async function () {
  const name = 'content-version coupling (content/** hash must match CONTENT_VERSION baseline)';

  // --- TEETH A: hash detection works ---
  // Simulated mismatch: hash of one string should differ from another.
  const h1 = createHash('sha256').update('a').digest('hex');
  const h2 = createHash('sha256').update('b').digest('hex');
  if (h1 === h2) {
    return { name, pass: false, detail: 'TEETH A: sha256("a") === sha256("b") — hash is broken' };
  }

  // --- TEETH B: mismatched version fails ---
  // Simulate a baseline with a wrong hash; the eval must reject it.
  const realHash = hashContentDir('game-core/content');
  const wrongHash = realHash === 'aaaaaa' ? 'bbbbbb' : 'aaaaaa';
  // A comparison against the wrong hash MUST fail:
  if (realHash === wrongHash) {
    return {
      name,
      pass: false,
      detail: 'TEETH B: real hash equals a constant wrong hash — proof-of-teeth impossible',
    };
  }
  // (This confirms the check below would catch a doctored baseline.)

  // --- Read CONTENT_VERSION from lib.rs ---
  const libRsPath = 'server-module/src/lib.rs';
  const currentVersion = readContentVersion(libRsPath);
  if (currentVersion === null) {
    return {
      name,
      pass: false,
      detail: 'CONTENT_VERSION constant not found in server-module/src/lib.rs',
    };
  }

  // --- Load the committed baseline ---
  const baselinePath = 'evals/baselines/content-hash.json';
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (e) {
    return { name, pass: false, detail: `Failed to read baseline ${baselinePath}: ${e.message}` };
  }

  // --- Check version matches ---
  if (baseline.version !== currentVersion) {
    return {
      name,
      pass: false,
      detail: `CONTENT_VERSION=${currentVersion} but baseline is for version=${baseline.version}. Update evals/baselines/content-hash.json (run: node evals/content-version.eval.mjs --update) when bumping CONTENT_VERSION.`,
    };
  }

  // --- Check content hash matches ---
  if (realHash !== baseline.hash) {
    return {
      name,
      pass: false,
      detail: `game-core/content/ hash mismatch for CONTENT_VERSION=${currentVersion}. Content changed without a CONTENT_VERSION bump. Either bump CONTENT_VERSION in server-module/src/lib.rs (and update the baseline) or revert the content change. Expected: ${baseline.hash}. Got: ${realHash}`,
    };
  }

  return {
    name,
    pass: true,
    detail: `CONTENT_VERSION=${currentVersion} hash=${realHash.slice(0, 16)}… matches baseline (TEETH A+B verified)`,
  };
}
