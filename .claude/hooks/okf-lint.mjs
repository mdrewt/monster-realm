#!/usr/bin/env node
// okf-lint.mjs — OKF knowledge bundle conformance lint.
// Contract: standards/knowledge-format.md (the SSOT for format rules).
//
// Rules enforced per concept file (*.md, index.md excluded):
//   1. required frontmatter: type, title, slug, updated, tags, abstract
//   2. slug == file path relative to bundle root (sans .md)
//   3. type ∈ registered vocabulary
//   4. abstract single-line ≤ 120 chars
//   5. every bundle-relative markdown link resolves
//
// Unknown frontmatter keys are tolerated (forward-compat, per OKF spec §2).
// Exit: 0 ok · 1 FAIL · 2 bad usage.
//
// No new RegExp() — all patterns are literal (detect-non-literal-regexp safe).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Registered type vocabulary (extend here + update lint — one-line change per type).
// See standards/knowledge-format.md §vocabulary.
export const VOCAB = new Set([
  'Research Note',
  'SpacetimeDB Table',
  'SpacetimeDB Reducer',
  'Schema Overview',
  'Module',
  'ADR Digest',
  'Runbook',
  'Metric',
]);

const REQUIRED_KEYS = ['type', 'title', 'slug', 'updated', 'tags', 'abstract'];
const ABSTRACT_MAX = 120;

// ---------------------------------------------------------------------------
// Frontmatter parsing (no new RegExp — key split on first ':')
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns a flat key→string map, or null if no --- block found.
 * Strips single/double quote wrapping from values (handles quoted scalars).
 * Unknown keys are passed through (forward-compat).
 *
 * @param {string} txt Raw markdown content.
 * @returns {Record<string,string>|null}
 */
export function parseFrontmatter(txt) {
  if (!txt.startsWith('---')) return null;
  const rest = txt.slice(3);
  const eol = rest.indexOf('\n');
  if (eol === -1) return null;
  const body = rest.slice(eol + 1);
  const end = body.indexOf('\n---');
  if (end === -1) return null;
  const block = body.slice(0, end);
  const out = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const raw = line.slice(colon + 1).trim();
    out[key] = raw.replace(/^["']|["']$/g, '');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Link extraction (literal regex — no dynamic RegExp construction)
// ---------------------------------------------------------------------------

/**
 * Extract bundle-relative markdown link targets from content.
 * Skips http://, https://, mailto:, and #anchor links.
 *
 * @param {string} txt Markdown content.
 * @returns {string[]}
 */
export function extractBundleLinks(txt) {
  const links = [];
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const url = m[2].trim();
    if (url.startsWith('http://')) continue;
    if (url.startsWith('https://')) continue;
    if (url.startsWith('#')) continue;
    if (url.startsWith('mailto:')) continue;
    links.push(url);
  }
  return links;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/**
 * Recursively collect *.md concept files (skip index.md) under a directory.
 * Sorted for deterministic ordering.
 *
 * @param {string} dir Absolute path to search.
 * @returns {string[]} Absolute file paths.
 */
export function collectConcepts(dir) {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectConcepts(full));
    } else if (entry.endsWith('.md') && entry !== 'index.md') {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Per-file lint
// ---------------------------------------------------------------------------

/**
 * Lint one concept file against the OKF contract.
 *
 * @param {string} filePath Absolute path to the concept file.
 * @param {string} bundleRoot Absolute bundle root (slug anchor).
 * @returns {{ fails: string[], warns: string[] }}
 */
export function lintFile(filePath, bundleRoot) {
  const fails = [];
  const warns = [];

  let txt;
  try {
    txt = readFileSync(filePath, 'utf8');
  } catch (e) {
    fails.push(`cannot read file: ${e.message}`);
    return { fails, warns };
  }

  const fm = parseFrontmatter(txt);
  if (!fm) {
    fails.push('no YAML frontmatter block (must start with ---)');
    return { fails, warns };
  }

  // Rule 1 — required keys present and non-empty
  for (const k of REQUIRED_KEYS) {
    if (fm[k] === undefined || fm[k] === '') {
      fails.push(`missing required frontmatter key: ${k}`);
    }
  }

  // Rule 2 — slug == path relative to bundle root (sans .md)
  const relPath = relative(bundleRoot, filePath).replace(/\\/g, '/');
  const expectedSlug = relPath.endsWith('.md') ? relPath.slice(0, -3) : relPath;
  if (fm.slug !== undefined && fm.slug !== '' && fm.slug !== expectedSlug) {
    fails.push(`slug '${fm.slug}' must equal path-derived '${expectedSlug}'`);
  }

  // Rule 3 — type ∈ registered vocabulary
  if (fm.type !== undefined && fm.type !== '' && !VOCAB.has(fm.type)) {
    fails.push(`type '${fm.type}' not in registered vocabulary`);
  }

  // Rule 4 — abstract single-line and ≤ 120 chars
  if (fm.abstract !== undefined && fm.abstract !== '') {
    if (fm.abstract.indexOf('\n') !== -1) {
      fails.push('abstract must be a single line');
    }
    if (fm.abstract.length > ABSTRACT_MAX) {
      warns.push(`abstract is ${fm.abstract.length} chars (> ${ABSTRACT_MAX}; index truncates)`);
    }
  }

  // Rule 5 — bundle-relative links resolve to existing files
  const links = extractBundleLinks(txt);
  for (const link of links) {
    const abs = resolve(dirname(filePath), link);
    if (!existsSync(abs)) {
      fails.push(`dangling bundle-relative link '${link}' (resolved: ${abs})`);
    }
  }

  return { fails, warns };
}

// ---------------------------------------------------------------------------
// Bundle lint
// ---------------------------------------------------------------------------

/**
 * Lint all concept files in a bundle.
 *
 * @param {string} bundleDir Path to the bundle root directory.
 * @returns {number} Total FAIL count (0 = clean).
 */
export function lint(bundleDir) {
  const root = resolve(bundleDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`okf-lint: not a directory: ${root}`);
    return 1;
  }

  const files = collectConcepts(root);
  let failCount = 0;
  let warnCount = 0;

  for (const f of files) {
    const rel = relative(root, f);
    const { fails, warns } = lintFile(f, root);
    for (const msg of fails) {
      console.error(`FAIL ${rel}: ${msg}`);
      failCount++;
    }
    for (const msg of warns) {
      console.warn(`WARN ${rel}: ${msg}`);
      warnCount++;
    }
  }

  console.log(`okf-lint: ${files.length} concept(s) · ${failCount} FAIL · ${warnCount} WARN`);
  return failCount;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('usage: okf-lint <bundleDir>');
    process.exit(2);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`okf-lint: not a directory: ${dir}`);
    process.exit(2);
  }
  process.exit(lint(dir) > 0 ? 1 : 0);
}
