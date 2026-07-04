#!/usr/bin/env node
// okf-export.mjs — generate the docs/knowledge/ OKF bundle from server-module source.
//
// Reuses the exported parseTableSchemas() from the schema-snapshot eval (SSOT: one
// parser for both the drift gate and the knowledge bundle — they cannot disagree).
//
// Usage:
//   node scripts/okf-export.mjs <outDir>           # write/refresh bundle
//   node scripts/okf-export.mjs <outDir> --check   # exit 1 if committed bundle drifted
//
// No new RegExp() — all patterns are literal (detect-non-literal-regexp safe).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// Import the existing schema parser (SSOT — one parser feeds both eval + bundle).
// Guard the path so a rename of the eval gives a clear diagnostic, not a cryptic
// dynamic-import error.
const EVAL_PATH = join(PROJECT_ROOT, 'evals', 'battle-schema-snapshot.eval.mjs');
if (!existsSync(EVAL_PATH)) {
  console.error(
    `okf-export: SSOT eval not found: ${EVAL_PATH}\n` +
      'The schema parser is imported from the schema-snapshot eval (ADR-0057 SSOT rule).\n' +
      'If the eval was renamed, update the import path in scripts/okf-export.mjs.',
  );
  process.exit(2);
}
const { parseTableSchemas } = await import(EVAL_PATH);

const SERVER_SRC = join(PROJECT_ROOT, 'server-module', 'src');
const BUNDLE_SOURCE_TAG = 'scripts/okf-export.mjs';

// ---------------------------------------------------------------------------
// Privacy ADR cross-references (sourced from schema.rs doc comments + ADRs)
// ---------------------------------------------------------------------------

const PRIVATE_ADRS = {
  monster: 'ADR-0015/0040 — hidden genes (IVs/EVs/nature) must never reach non-owner clients.',
  encounter: 'ADR-0040 — spawn weights/level bands are server-only truth; no public projection.',
  battle_wild: 'ADR-0045 — RNG individuality seed must never reach any client; no projection.',
  player_dialogue_state: 'ADR-0015/0069 — dialogue flags gate content branches; must-never-leak.',
  heal_cooldown: 'ADR-0015/0069 — heal timing is private; must-never-leak.',
  movement_tick_schedule: 'Server-only scheduled table for per-zone movement tick; no projection.',
};

// Public projection relationships: private → public projection table name.
const PUBLIC_PROJECTION = {
  monster: 'monster_pub',
};

// ---------------------------------------------------------------------------
// File utilities
// ---------------------------------------------------------------------------

/** Collect all .rs files under dir recursively (sorted for determinism). */
function collectRsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collectRsFiles(full));
    else if (entry.endsWith('.rs')) files.push(full);
  }
  return files;
}

/** Concatenate all .rs files (sorted) — matches battle-schema-snapshot readServerModuleSources. */
function readAllSources(dir) {
  return collectRsFiles(dir)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

/** Get the git date (YYYY-MM-DD) of the last commit touching a file.
 * Falls back to a fixed sentinel (not wall-clock time) so the bundle stays
 * deterministic even when git is unavailable (e.g. a stripped container).
 */
function gitDate(filePath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cd', '--date=short', '--', filePath], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return out || '1970-01-01';
  } catch {
    return '1970-01-01';
  }
}

/** Relative path from SERVER_SRC for display in resource links. */
function relSrc(filePath) {
  return `server-module/src/${relative(SERVER_SRC, filePath).replace(/\\/g, '/')}`;
}

// ---------------------------------------------------------------------------
// Per-file metadata extraction
// ---------------------------------------------------------------------------

/**
 * Parse table metadata from a single .rs file:
 *   { [tableName]: { visibility, docComment, lineNumber, file } }
 *
 * All regex patterns are literals (no new RegExp).
 */
function parseTableMetadata(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const meta = {};
  const tableAttrRe = /#\[spacetimedb::table\(name\s*=\s*(\w+)([^)]*)\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('#[spacetimedb::table(') === -1) continue;
    const m = tableAttrRe.exec(line);
    if (!m) continue;
    const name = m[1];
    const attrRest = m[2] || '';
    const visibility =
      attrRest.indexOf('public') !== -1 ||
      line.indexOf(', public)') !== -1 ||
      line.indexOf(`(name = ${name}, public`) !== -1
        ? 'public'
        : 'private';

    // Gather doc comment lines above this line (skip #[...] and blank lines).
    const docLines = [];
    let j = i - 1;
    while (j >= 0) {
      const prev = lines[j].trim();
      if (prev.startsWith('///')) {
        docLines.unshift(prev.slice(3).trim());
        j--;
      } else if (prev.startsWith('#[') || prev === '' || prev.startsWith('//!')) {
        j--;
      } else {
        break;
      }
    }

    meta[name] = {
      visibility,
      docComment: docLines.join(' ').replace(/\s+/g, ' ').trim(),
      lineNumber: i + 1,
      file: filePath,
    };
  }
  return meta;
}

/**
 * Parse reducer metadata from a single .rs file:
 *   [{ name, sig, docComment, lineNumber, file }]
 *
 * Captures multi-line signatures by scanning from `pub fn` until the first `{`.
 * All regex patterns are literals.
 */
function parseReducerMetadata(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const reducers = [];
  const pubFnRe = /^pub fn (\w+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    // Match #[spacetimedb::reducer] AND lifecycle variants like reducer(init),
    // reducer(client_disconnected) — exact equality would miss those.
    if (!lines[i].trim().startsWith('#[spacetimedb::reducer')) continue;

    // Gather doc comment above this attribute (skip #[...] and blank lines).
    const docLines = [];
    let j = i - 1;
    while (j >= 0) {
      const prev = lines[j].trim();
      if (prev.startsWith('///')) {
        docLines.unshift(prev.slice(3).trim());
        j--;
      } else if (prev.startsWith('#[') || prev === '' || prev.startsWith('//!')) {
        j--;
      } else {
        break;
      }
    }

    // Find the `pub fn` line (may be i+1 or after other attributes).
    let k = i + 1;
    while (k < lines.length && !pubFnRe.test(lines[k].trim())) k++;
    if (k >= lines.length) continue;

    const fnLine = k;
    const nameM = pubFnRe.exec(lines[k].trim());
    if (!nameM) continue;
    const name = nameM[1];

    // Collect the full signature up to the first `{` (handles multi-line).
    const sigLines = [];
    let l = k;
    while (l < lines.length) {
      const sl = lines[l];
      sigLines.push(sl);
      if (sl.indexOf('{') !== -1) break;
      l++;
    }
    // Strip the trailing ` {` from the signature.
    const rawSig = sigLines
      .join('\n')
      .replace(/\s*\{[\s\S]*$/, '')
      .trim();

    reducers.push({
      name,
      sig: rawSig,
      docComment: docLines.join(' ').replace(/\s+/g, ' ').trim(),
      lineNumber: fnLine + 1,
      file: filePath,
    });
  }
  return reducers;
}

// ---------------------------------------------------------------------------
// Concept content generators
// ---------------------------------------------------------------------------

/** Truncate abstract to ≤ 120 chars, appending … if needed. */
function mkAbstract(text, max = 120) {
  if (!text) return '';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Double-quote a YAML scalar value. */
const q = (s) => `"${String(s).replace(/"/g, "'")}"`;

/**
 * Generate a SpacetimeDB Table concept file.
 */
function tableConceptContent(name, schema, meta, date) {
  const { pk, columns } = schema;
  const { visibility, docComment, lineNumber, file } = meta;
  const abstract_ = mkAbstract(docComment || `SpacetimeDB ${visibility} table ${name}.`);
  const projection = PUBLIC_PROJECTION[name];
  const privNote = PRIVATE_ADRS[name];
  const tags = ['schema', 'spacetimedb', visibility];

  const fm = `---
type: SpacetimeDB Table
title: ${name}
slug: tables/${name}
updated: ${date}
tags: [${tags.join(', ')}]
abstract: ${q(abstract_)}
resource: ${relSrc(file)}#L${lineNumber}
source: ${BUNDLE_SOURCE_TAG}@${relSrc(file)}
visibility: ${visibility}
---`;

  // Column table
  const colRows = Object.entries(columns)
    .map(([col, type]) => `| \`${col}\` | \`${type}\` | ${col === pk ? 'yes' : '—'} |`)
    .join('\n');
  const colTable = `## Columns\n\n| Column | Type | PK |\n|--------|------|----|
${colRows}`;

  // Privacy section for private tables (two newlines = blank line before heading, per CommonMark)
  const privSection = !privNote
    ? ''
    : `\n\n## Privacy\n\nPrivate table — ${privNote}${
        projection ? `\n\nPublic projection: [${projection}](${projection}.md).` : ''
      }`;

  return `${fm}\n\n${colTable}${privSection}\n`;
}

/**
 * Generate a SpacetimeDB Reducer concept file.
 */
function reducerConceptContent(r, date) {
  const { name, sig, docComment, lineNumber, file } = r;
  const abstract_ = mkAbstract(docComment || `SpacetimeDB reducer ${name}.`);
  const module = basename(file, '.rs');
  const tags = ['reducer', 'spacetimedb', module];

  const fm = `---
type: SpacetimeDB Reducer
title: ${name}
slug: reducers/${name}
updated: ${date}
tags: [${tags.join(', ')}]
abstract: ${q(abstract_)}
resource: ${relSrc(file)}#L${lineNumber}
source: ${BUNDLE_SOURCE_TAG}@${relSrc(file)}
---`;

  const sigBlock = `## Signature\n\n\`\`\`rust\n${sig}\n\`\`\``;

  return `${fm}\n\n${sigBlock}\n`;
}

/**
 * Generate the Schema Overview concept file.
 */
function schemaOverviewContent(_tableNames, publicTables, privateTables, reducerNames, date) {
  const pubCount = publicTables.length;
  const privCount = privateTables.length;
  const totalTables = pubCount + privCount;
  const abstract_ = mkAbstract(
    `${totalTables}-table SpacetimeDB schema for Monster Realm: public/private split (ADR-0040). ${reducerNames.length} reducers.`,
  );

  const fm = `---
type: Schema Overview
title: Monster Realm Schema Overview
slug: schema-overview
updated: ${date}
tags: [schema, spacetimedb, overview]
abstract: ${q(abstract_)}
source: ${BUNDLE_SOURCE_TAG}@server-module/src/
---`;

  const pubRows = publicTables.map((n) => `- [${n}](tables/${n}.md)`).join('\n');
  const privRows = privateTables
    .map((n) => {
      const proj = PUBLIC_PROJECTION[n];
      return `- [${n}](tables/${n}.md)${proj ? ` → public projection: [${proj}](tables/${proj}.md)` : ''}`;
    })
    .join('\n');
  const redRows = reducerNames.map((n) => `- [${n}](reducers/${n}.md)`).join('\n');

  return `${fm}

## Tables

### Public (${pubCount})

${pubRows}

### Private (${privCount})

${privRows}

## Reducers (${reducerNames.length})

${redRows}
`;
}

/**
 * Generate an index.md for a bundle directory (or subdirectory).
 * @param {string} title Human-readable section title.
 * @param {Array<{slug: string, type: string, title: string, abstract: string}>} entries
 */
function buildIndex(title, entries) {
  const BEGIN = '<!-- BEGIN:auto (generated by okf-export.mjs — do not edit by hand) -->';
  const END = '<!-- END:auto -->';
  const head = '| slug | type | title | abstract |\n|------|------|-------|---------|';
  const rows = entries
    .map((e) => `| ${e.slug} | ${e.type} | ${e.title} | ${e.abstract.slice(0, 80)} |`)
    .join('\n');
  return `# ${title}\n\n> Generated by \`scripts/okf-export.mjs\`. Do not edit by hand — edits fail the drift gate.\n\n${BEGIN}\n${head}\n${rows}\n${END}\n`;
}

// ---------------------------------------------------------------------------
// Main export logic
// ---------------------------------------------------------------------------

async function exportBundle(outDir, checkMode) {
  const out = resolve(outDir);

  // 1. Parse all .rs files for metadata
  const rsFiles = collectRsFiles(SERVER_SRC);
  const allTableMeta = {};
  const allReducers = [];

  for (const f of rsFiles) {
    Object.assign(allTableMeta, parseTableMetadata(f));
    allReducers.push(...parseReducerMetadata(f));
  }

  // 2. Parse schema (reuse eval's SSOT parser — columns + PKs)
  const rawSrc = readAllSources(SERVER_SRC);
  const schemas = parseTableSchemas(rawSrc);

  // 3. Sort table names deterministically
  const tableNames = Object.keys(schemas).sort();
  // Fail-secure default: a table not found in per-file metadata defaults to
  // 'private' (missing metadata should never silently promote a private table public).
  const publicTables = tableNames.filter(
    (n) => (allTableMeta[n]?.visibility ?? 'private') === 'public',
  );
  const privateTables = tableNames.filter(
    (n) => (allTableMeta[n]?.visibility ?? 'private') === 'private',
  );

  // 4. Sort reducers deterministically by name
  allReducers.sort((a, b) => a.name.localeCompare(b.name));

  // 5. Determine date (git date of schema.rs — stable per-commit)
  const schemaFile = join(SERVER_SRC, 'schema.rs');
  const date = gitDate(schemaFile);

  // 6. Generate all concept content (in memory — used for both write and check).
  // Keys are ALWAYS forward-slash paths (portable; drift check normalises relative()
  // to '/' too — M-1 fix ensures symmetry on Windows).
  const generated = new Map(); // posix relative path → content
  const p = (s) => s.replace(/\\/g, '/'); // normalise to forward slashes

  for (const name of tableNames) {
    const schema = schemas[name];
    const meta = allTableMeta[name] ?? {
      // Fail-secure: default private when metadata is missing (M-2 fix).
      visibility: 'private',
      docComment: '',
      lineNumber: 1,
      file: schemaFile,
    };
    generated.set(p(join('tables', `${name}.md`)), tableConceptContent(name, schema, meta, date));
  }

  for (const r of allReducers) {
    generated.set(p(join('reducers', `${r.name}.md`)), reducerConceptContent(r, date));
  }

  generated.set(
    'schema-overview.md',
    schemaOverviewContent(
      tableNames,
      publicTables,
      privateTables,
      allReducers.map((r) => r.name),
      date,
    ),
  );

  // Sub-indices (keys normalised to forward slashes via p())
  generated.set(
    p(join('tables', 'index.md')),
    buildIndex(
      'Tables',
      tableNames.map((n) => ({
        slug: `tables/${n}`,
        type: 'SpacetimeDB Table',
        title: n,
        abstract: mkAbstract(allTableMeta[n]?.docComment || `SpacetimeDB table ${n}.`),
      })),
    ),
  );
  generated.set(
    p(join('reducers', 'index.md')),
    buildIndex(
      'Reducers',
      allReducers.map((r) => ({
        slug: `reducers/${r.name}`,
        type: 'SpacetimeDB Reducer',
        title: r.name,
        abstract: mkAbstract(r.docComment || `SpacetimeDB reducer ${r.name}.`),
      })),
    ),
  );

  // Root index
  const allEntries = [
    {
      slug: 'schema-overview',
      type: 'Schema Overview',
      title: 'Schema Overview',
      abstract: mkAbstract(
        `${tableNames.length}-table SpacetimeDB schema for Monster Realm. ${allReducers.length} reducers.`,
      ),
    },
    ...tableNames.map((n) => ({
      slug: `tables/${n}`,
      type: 'SpacetimeDB Table',
      title: n,
      abstract: mkAbstract(allTableMeta[n]?.docComment || `SpacetimeDB table ${n}.`),
    })),
    ...allReducers.map((r) => ({
      slug: `reducers/${r.name}`,
      type: 'SpacetimeDB Reducer',
      title: r.name,
      abstract: mkAbstract(r.docComment || `SpacetimeDB reducer ${r.name}.`),
    })),
  ];
  generated.set('index.md', buildIndex('Monster Realm Knowledge Bundle', allEntries));

  // 7. Write or compare
  if (checkMode) {
    return runDriftCheck(out, generated);
  } else {
    writeBundle(out, generated);
    console.log(
      `okf-export: wrote ${generated.size} files to ${out} (${tableNames.length} tables, ${allReducers.length} reducers)`,
    );
    return 0;
  }
}

function writeBundle(outDir, generated) {
  mkdirSync(join(outDir, 'tables'), { recursive: true });
  mkdirSync(join(outDir, 'reducers'), { recursive: true });
  for (const [relPath, content] of generated) {
    writeFileSync(join(outDir, relPath), content);
  }
}

function runDriftCheck(outDir, generated) {
  let drifted = 0;

  // Check each generated file against the committed version
  for (const [relPath, expected] of generated) {
    const full = join(outDir, relPath);
    if (!existsSync(full)) {
      console.error(`DRIFT missing: ${relPath} (not in committed bundle)`);
      drifted++;
    } else {
      const actual = readFileSync(full, 'utf8');
      if (actual !== expected) {
        console.error(`DRIFT stale: ${relPath} (committed bundle differs from regenerated)`);
        drifted++;
      }
    }
  }

  // Check for extra files in the committed bundle not in the generated set
  const committedFiles = collectBundleFiles(outDir);
  for (const f of committedFiles) {
    const rel = relative(outDir, f).replace(/\\/g, '/');
    if (!generated.has(rel)) {
      console.error(`DRIFT extra: ${rel} (in committed bundle, not in generated set)`);
      drifted++;
    }
  }

  if (drifted === 0) {
    console.log('okf-export: bundle in sync (no drift)');
  } else {
    console.error(`okf-export: ${drifted} drift(s) detected — run 'just knowledge' to regenerate`);
  }
  return drifted > 0 ? 1 : 0;
}

/** Collect all *.md files under a dir recursively (including index.md). */
function collectBundleFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collectBundleFiles(full));
    else if (entry.endsWith('.md')) files.push(full);
  }
  return files;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--'));
const checkMode = args.includes('--check');

if (!outDir) {
  console.error('usage: okf-export <outDir> [--check]');
  process.exit(2);
}

const exitCode = await exportBundle(outDir, checkMode);
process.exit(exitCode);
