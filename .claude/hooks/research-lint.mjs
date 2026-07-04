#!/usr/bin/env node
// research-lint.mjs — validate research-library docs against the knowledge contract.
// Contract: standards/knowledge-format.md (SSOT). Vendored copy; no cross-repo imports.
// Zero-dep. Complements research-index.mjs (index sync + duplicate slugs); this
// checks per-doc frontmatter completeness, field values, and the one-line abstract.
//
//   node research-lint.mjs <researchDir>
//
// Required frontmatter per the contract (superset — no prior field dropped):
//   type, title, slug, domain, tags, status, updated, confidence, sources, abstract
//
// Exit: 0 ok (warnings allowed) · 1 one or more FAILs · 2 bad usage.
//
// No new RegExp() — all patterns are literal (detect-non-literal-regexp safe).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The only type accepted for research docs per the knowledge contract.
const RESEARCH_TYPE = 'Research Note';

const REQUIRED = [
  'type',
  'title',
  'slug',
  'domain',
  'tags',
  'status',
  'updated',
  'confidence',
  'sources',
  'abstract',
];

const STATUS_VALUES = new Set(['draft', 'active', 'stale', 'superseded']);
const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);
const ABSTRACT_MAX = 120;

// ---------------------------------------------------------------------------
// Frontmatter parsing (no new RegExp — split on first ':')
// ---------------------------------------------------------------------------

function parseFm(txt) {
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
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-file lint
// ---------------------------------------------------------------------------

function lintFile(dir, file) {
  const fails = [];
  const warns = [];

  const txt = readFileSync(join(dir, file), 'utf8');
  const fm = parseFm(txt);
  if (!fm) {
    fails.push('no YAML frontmatter block (must start with ---)');
    return { fails, warns };
  }

  // Required keys present and non-empty
  for (const k of REQUIRED) {
    if (fm[k] === undefined || fm[k] === '') {
      fails.push(`missing required frontmatter key: ${k}`);
    }
  }

  // `type` must be `Research Note`
  if (fm.type !== undefined && fm.type !== '' && fm.type !== RESEARCH_TYPE) {
    fails.push(`type '${fm.type}' is not valid for research docs — must be '${RESEARCH_TYPE}'`);
  }

  // `slug` must match filename (sans .md)
  const expectedSlug = file.replace(/\.md$/, '');
  if (fm.slug !== undefined && fm.slug !== '' && fm.slug !== expectedSlug) {
    fails.push(`slug '${fm.slug}' does not match filename '${expectedSlug}'`);
  }

  // `status` must be a known value
  if (fm.status !== undefined && fm.status !== '' && !STATUS_VALUES.has(fm.status)) {
    fails.push(`status '${fm.status}' not one of draft/active/stale/superseded`);
  }

  // `confidence` must be a known value
  if (fm.confidence !== undefined && fm.confidence !== '' && !CONFIDENCE_VALUES.has(fm.confidence)) {
    fails.push(`confidence '${fm.confidence}' not one of low/medium/high`);
  }

  // `sources` should be a numeric count
  if (fm.sources !== undefined && fm.sources !== '') {
    if (!/^\d+$/.test(fm.sources)) {
      warns.push(`sources should be a count (integer), got '${fm.sources}'`);
    }
  }

  // `abstract` single-line and ≤ 120 chars
  if (fm.abstract !== undefined && fm.abstract !== '') {
    if (fm.abstract.indexOf('\n') !== -1) {
      fails.push('abstract must be a single line');
    }
    if (fm.abstract.length > ABSTRACT_MAX) {
      warns.push(`abstract is ${fm.abstract.length} chars (> ${ABSTRACT_MAX}; index truncates)`);
    }
  }

  return { fails, warns };
}

// ---------------------------------------------------------------------------
// Bundle lint
// ---------------------------------------------------------------------------

export function lint(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
    .sort();

  let failCount = 0;
  let warnCount = 0;

  for (const f of files) {
    const { fails, warns } = lintFile(dir, f);
    for (const x of fails) {
      console.error(`FAIL ${f}: ${x}`);
      failCount++;
    }
    for (const x of warns) {
      console.warn(`WARN ${f}: ${x}`);
      warnCount++;
    }
  }

  console.log(`research-lint: ${files.length} doc(s) · ${failCount} FAIL · ${warnCount} WARN`);
  return failCount === 0;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir || !existsSync(dir)) {
    console.error('usage: research-lint <researchDir>');
    process.exit(2);
  }
  process.exit(lint(dir) ? 0 : 1);
}
