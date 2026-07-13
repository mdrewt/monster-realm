#!/usr/bin/env node
// scripts/adr-digest.mjs — generate docs/adr/DIGEST.md from the ADR corpus.
//
// Usage:
//   node scripts/adr-digest.mjs                         # regenerate DIGEST.md in place
//   node scripts/adr-digest.mjs --check                 # exit 1 if DIGEST is stale or violated
//   node scripts/adr-digest.mjs --adr-dir <path>        # override input ADR directory (testing)
//   node scripts/adr-digest.mjs --out <path>            # override output DIGEST path (testing)
//
// NO new RegExp() — all patterns use literal /regex/ or String methods.
// (detect-non-literal-regexp Semgrep rule has bitten this project 3×.)
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Subsystem vocabulary (infra-d-2, ADR-0104 §D2)
// ---------------------------------------------------------------------------
const SUBSYSTEM_VOCAB = new Set([
  'battle',
  'evolution-fusion',
  'movement-netcode',
  'content',
  'schema-persistence',
  'client-ui',
  'ci-gates',
  'tooling-docs',
  'security-authz',
  'economy-quests',
]);

// ---------------------------------------------------------------------------
// Legacy tolerance — all project ADRs authored before the canonical header
// standard (M-infra-d). Missing canonical fields are warnings, not errors.
// The backfill slice removes entries here until the set is empty.
// ---------------------------------------------------------------------------
const LEGACY_TOLERANCE = new Set([
  '0001',
  '0035',
  '0036',
  '0037',
  '0038',
  '0039',
  '0040',
  '0041',
  '0042',
  '0043',
  '0044',
  '0045',
  '0046',
  '0047',
  '0048',
  '0049',
  '0050',
  '0051',
  '0052',
  '0053',
  '0054',
  '0055',
  '0056',
  '0057',
  '0058',
  '0059',
  '0060',
  '0061',
  '0062',
  '0063',
  '0064',
  '0065',
  '0066',
  '0067',
  '0068',
  '0069',
  '0070',
  '0071',
  '0072',
  '0073',
  '0074',
  '0075',
  '0076',
  '0077',
  '0078',
  '0079',
  '0080',
  '0081',
  '0082',
  '0083',
  '0084',
  '0085',
  '0086',
  '0087',
  '0088',
  '0089',
  '0090',
  '0091',
  '0092',
  '0093',
  '0094',
  '0095',
  '0096',
  '0097',
  '0098',
  '0099',
  '0100',
  '0101',
  '0103',
]);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const checkMode = args.includes('--check');

function argValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const adrDirOverride = argValue('--adr-dir');
const outOverride = argValue('--out');

const ADR_DIR = adrDirOverride ? resolve(adrDirOverride) : join(PROJECT_ROOT, 'docs', 'adr');
const DIGEST_PATH = outOverride ? resolve(outOverride) : join(ADR_DIR, 'DIGEST.md');
const CORPUS_PATH = join(PROJECT_ROOT, 'docs', 'adr', 'design-corpus.json');

// ---------------------------------------------------------------------------
// Header field extraction helpers (NO new RegExp)
// ---------------------------------------------------------------------------

/** Extract a bold-field value: **FieldName:** <value> */
function extractBoldField(content, fieldName) {
  const needle = `**${fieldName}:**`;
  const idx = content.indexOf(needle);
  if (idx === -1) return null;
  const lineEnd = content.indexOf('\n', idx);
  const raw = content.slice(idx + needle.length, lineEnd === -1 ? content.length : lineEnd).trim();
  return raw || null;
}

/** Extract a list-field value: - FieldName: <value> */
function extractListField(content, fieldName) {
  const needle = `- ${fieldName}:`;
  const idx = content.indexOf(needle);
  if (idx === -1) return null;
  const lineEnd = content.indexOf('\n', idx);
  const raw = content.slice(idx + needle.length, lineEnd === -1 ? content.length : lineEnd).trim();
  return raw || null;
}

/** Normalize raw status string to Accepted | Superseded | Deprecated | <raw> */
function normalizeStatus(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith('accepted')) return 'Accepted';
  if (lower.startsWith('superseded')) return 'Superseded';
  if (lower.startsWith('deprecated')) return 'Deprecated';
  return raw;
}

/** Extract the document title (first # heading). */
function extractTitle(content) {
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.startsWith('# ')) {
      return line.slice(2).trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse a single ADR file
// ---------------------------------------------------------------------------
function parseAdr(id, filePath) {
  const content = readFileSync(filePath, 'utf8');
  const title = extractTitle(content);

  // Try bold-field format first, fall back to list-style
  const rawStatus = extractBoldField(content, 'Status') || extractListField(content, 'Status');
  const status = normalizeStatus(rawStatus);
  const date = extractBoldField(content, 'Date') || extractListField(content, 'Date');
  const slice = extractBoldField(content, 'Slice') || extractListField(content, 'Slice');
  const supersedes =
    extractBoldField(content, 'Supersedes') || extractListField(content, 'Supersedes');
  const amends = extractBoldField(content, 'Amends') || extractListField(content, 'Amends');
  const subsystems =
    extractBoldField(content, 'Subsystems') || extractListField(content, 'Subsystems');
  const decision = extractBoldField(content, 'Decision') || extractListField(content, 'Decision');
  const supersededBy =
    extractBoldField(content, 'Superseded-by') || extractListField(content, 'Superseded-by');
  const amendedBy =
    extractBoldField(content, 'Amended-by') || extractListField(content, 'Amended-by');

  return {
    id,
    filePath,
    title,
    status,
    date,
    slice,
    supersedes: supersedes || null,
    amends: amends || null,
    subsystems: subsystems || null,
    decision: decision || null,
    supersededBy: supersededBy || null,
    amendedBy: amendedBy || null,
  };
}

// ---------------------------------------------------------------------------
// Collect ADR numeric IDs from a directory
// ---------------------------------------------------------------------------
function collectAdrIds(dir) {
  if (!existsSync(dir)) {
    console.error(`adr-digest: ADR directory not found: ${dir}`);
    process.exit(2);
  }
  return readdirSync(dir)
    .filter((f) => /^[0-9]{4}.*\.md$/.test(f) && f !== 'README.md' && f !== 'template.md')
    .sort()
    .map((f) => ({ id: f.slice(0, 4), file: join(dir, f) }));
}

// ---------------------------------------------------------------------------
// Validate a parsed ADR header
// Returns array of { level: 'error'|'warn', message } objects
// ---------------------------------------------------------------------------
function validateAdr(adr, allIds) {
  const issues = [];
  const isLegacy = LEGACY_TOLERANCE.has(adr.id);

  // Status is always required (even for legacy — it's in both old and new formats)
  if (!adr.status) {
    issues.push({
      level: isLegacy ? 'warn' : 'error',
      message: `${adr.id}: missing **Status:** field`,
    });
  } else if (!['Accepted', 'Superseded', 'Deprecated'].includes(adr.status)) {
    issues.push({
      level: isLegacy ? 'warn' : 'error',
      message: `${adr.id}: unknown Status "${adr.status}"`,
    });
  }

  // Superseded-by must be present if Status = Superseded
  if (adr.status === 'Superseded' && !adr.supersededBy) {
    issues.push({
      level: isLegacy ? 'warn' : 'error',
      message: `${adr.id}: Status is Superseded but missing **Superseded-by:** field`,
    });
  }

  if (!isLegacy) {
    // Strict checks for canonical ADRs
    if (!adr.date) {
      issues.push({ level: 'error', message: `${adr.id}: missing **Date:** field` });
    }
    if (!adr.slice) {
      issues.push({ level: 'error', message: `${adr.id}: missing **Slice:** field` });
    }
    if (adr.supersedes === null) {
      issues.push({
        level: 'error',
        message: `${adr.id}: missing **Supersedes:** field (use — if none)`,
      });
    }
    if (adr.amends === null) {
      issues.push({
        level: 'error',
        message: `${adr.id}: missing **Amends:** field (use — if none)`,
      });
    }
    if (!adr.subsystems) {
      issues.push({ level: 'error', message: `${adr.id}: missing **Subsystems:** field` });
    } else {
      const parts = adr.subsystems
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length < 1 || parts.length > 3) {
        issues.push({
          level: 'error',
          message: `${adr.id}: **Subsystems:** must have 1–3 values (got ${parts.length})`,
        });
      }
      for (const sub of parts) {
        if (!SUBSYSTEM_VOCAB.has(sub)) {
          issues.push({
            level: 'error',
            message: `${adr.id}: unknown subsystem "${sub}" (not in vocabulary)`,
          });
        }
      }
    }
    if (!adr.decision) {
      issues.push({ level: 'error', message: `${adr.id}: missing **Decision:** field` });
    } else if (adr.decision.length > 240) {
      issues.push({
        level: 'error',
        message: `${adr.id}: **Decision:** exceeds 240 chars (${adr.decision.length})`,
      });
    }
  }

  // Dangling reference checks (all ADRs)
  // Legacy ADRs get warnings; canonical ADRs get errors.
  // Multi-ref fields (e.g. "ADR-0017 (desc), ADR-0023") are fully scanned.
  const refLevel = isLegacy ? 'warn' : 'error';

  function checkRefs(fieldValue, fieldName) {
    if (!fieldValue || fieldValue === '—' || fieldValue.toLowerCase() === 'none') return;
    for (const ref of extractAllAdrIds(fieldValue)) {
      if (!allIds.has(ref)) {
        issues.push({
          level: refLevel,
          message: `${adr.id}: dangling ${fieldName} reference "${fieldValue}" (ADR-${ref} not found)`,
        });
      }
    }
  }

  checkRefs(adr.supersededBy, 'Superseded-by');
  checkRefs(adr.amendedBy, 'Amended-by');
  checkRefs(adr.supersedes, 'Supersedes');
  checkRefs(adr.amends, 'Amends');

  return issues;
}

/** Extract ALL numeric ADR ids from a reference string like "ADR-0017 (desc), ADR-0023". */
function extractAllAdrIds(ref) {
  if (!ref) return [];
  const ids = [];
  let idx = 0;
  while (idx < ref.length) {
    const adrIdx = ref.indexOf('ADR-', idx);
    if (adrIdx === -1) break;
    const start = adrIdx + 4;
    let end = start;
    while (end < ref.length && ref[end] >= '0' && ref[end] <= '9') end++;
    if (end > start) ids.push(ref.slice(start, end));
    idx = end;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Parse subsystems into an array
// ---------------------------------------------------------------------------
function parseSubsystems(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Render a status badge with supersession pointer
// ---------------------------------------------------------------------------
function renderStatus(adr) {
  if (adr.status === 'Superseded') {
    const ptr = adr.supersededBy ? ` → ${adr.supersededBy}` : '';
    return `Superseded${ptr}`;
  }
  if (adr.status === 'Deprecated') return 'Deprecated';
  return adr.status || 'PENDING';
}

// ---------------------------------------------------------------------------
// Escape markdown table cell content
// ---------------------------------------------------------------------------
function escCell(s) {
  if (!s) return '';
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Generate DIGEST.md content
// ---------------------------------------------------------------------------
function generateDigest(adrs, designCorpus) {
  const lines = [];

  lines.push(
    '<!-- DO-NOT-EDIT: generated by scripts/adr-digest.mjs — run `just adr-digest` to refresh -->',
  );
  lines.push('# ADR Digest');
  lines.push('');
  lines.push(
    '_Agent entry point: scan this file first; open the full ADR only on a hit. ' +
      'Legacy entries (pre-M-infra-d backfill) show `PENDING` for unset fields._',
  );
  lines.push('');

  const projectCount = adrs.length;
  const hCount = designCorpus.entries.length;
  lines.push(
    `Generated from ${projectCount} project ADRs (\`docs/adr/\`) and ${hCount} harness design entries (\`docs/adr/design-corpus.json\`).`,
  );
  lines.push('');

  // ── Numeric master list ──────────────────────────────────────────────────
  lines.push('## Project ADRs — numeric master list');
  lines.push('');
  lines.push('| ID | Title | Status | Subsystems | Slice | Decision |');
  lines.push('|----|-------|--------|------------|-------|----------|');

  for (const adr of adrs) {
    const isDead = adr.status === 'Superseded' || adr.status === 'Deprecated';
    const idLink = `[${adr.id}](./${filenameBase(adr.filePath)})`;
    const titleStr = escCell(cleanTitle(adr.title));
    const statusStr = renderStatus(adr);
    const subsStr = escCell(adr.subsystems || 'PENDING');
    const sliceStr = escCell(adr.slice || 'PENDING');
    const decStr = escCell(adr.decision || 'PENDING');

    if (isDead) {
      lines.push(
        `| ~~${idLink}~~ | ~~${titleStr}~~ | ~~${statusStr}~~ | ~~${subsStr}~~ | ~~${sliceStr}~~ | ~~${decStr}~~ |`,
      );
    } else {
      lines.push(
        `| ${idLink} | ${titleStr} | ${statusStr} | ${subsStr} | ${sliceStr} | ${decStr} |`,
      );
    }
  }
  lines.push('');

  // ── Harness design corpus ────────────────────────────────────────────────
  lines.push('## Harness design corpus (H- namespace)');
  lines.push('');
  lines.push('_Frozen snapshot 2026-07. Project CI never reads the harness repo._');
  lines.push('');
  lines.push(
    '_Collision note: H-0055 = project ADR 0056; H-0056 = project ADR 0057; H-0057 = project ADR 0080. See `docs/adr/README.md`._',
  );
  lines.push('');
  lines.push('| H-ID | Project alias | Title | Status | Decision |');
  lines.push('|------|---------------|-------|--------|----------|');

  for (const entry of designCorpus.entries) {
    const alias = entry.project_alias || '—';
    lines.push(
      `| ${entry.id} | ${alias} | ${escCell(entry.title)} | ${entry.status} | ${escCell(entry.decision)} |`,
    );
  }
  lines.push('');

  // ── Grouped by subsystem ─────────────────────────────────────────────────
  lines.push('## By subsystem');
  lines.push('');

  const bySubsystem = new Map();
  for (const sub of SUBSYSTEM_VOCAB) {
    bySubsystem.set(sub, []);
  }
  // H- entries by subsystem — skip (harness corpus doesn't have subsystem tags)

  for (const adr of adrs) {
    const subs = parseSubsystems(adr.subsystems);
    if (subs.length === 0) {
      // legacy: no subsystem
      if (!bySubsystem.has('(untagged)')) bySubsystem.set('(untagged)', []);
      bySubsystem.get('(untagged)').push(adr);
    } else {
      for (const sub of subs) {
        if (!bySubsystem.has(sub)) bySubsystem.set(sub, []);
        bySubsystem.get(sub).push(adr);
      }
    }
  }

  for (const [sub, entries] of bySubsystem) {
    if (entries.length === 0) continue;
    lines.push(`### ${sub}`);
    lines.push('');
    for (const adr of entries) {
      const isDead = adr.status === 'Superseded' || adr.status === 'Deprecated';
      const idLink = `[${adr.id}](./${filenameBase(adr.filePath)})`;
      const statusStr = renderStatus(adr);
      const titleStr = cleanTitle(adr.title);
      const sliceStr = adr.slice || 'PENDING';
      const line = `- ${idLink} — ${sliceStr} — ${titleStr} (${statusStr})`;
      lines.push(isDead ? `- ~~${idLink} — ${sliceStr} — ${titleStr} (${statusStr})~~` : line);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Return the basename of an ADR file path for use in markdown links. */
function filenameBase(filePath) {
  return filePath.split('/').pop() ?? '';
}

/** Strip common ADR ID prefixes from a title for cleaner digest display. */
function cleanTitle(title) {
  if (!title) return '—';
  // Strip "ADR-NNNN — ", "ADR-NNNN: ", "NNNN. " prefixes
  let t = title;
  if (t.startsWith('ADR-')) {
    const dashIdx = t.indexOf(' — ');
    const colonIdx = t.indexOf(': ');
    if (dashIdx !== -1 && (colonIdx === -1 || dashIdx < colonIdx)) {
      t = t.slice(dashIdx + 3);
    } else if (colonIdx !== -1) {
      t = t.slice(colonIdx + 2);
    }
  } else if (/^[0-9]{4}\. /.test(t)) {
    t = t.slice(6);
  }
  return t.trim() || title;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  // Load design corpus early (needed to build the full valid-ID set)
  let designCorpus = { _banner: '', entries: [], collision_map: {} };
  if (existsSync(CORPUS_PATH)) {
    try {
      designCorpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
    } catch (err) {
      console.error(`adr-digest: failed to parse design-corpus.json: ${err.message}`);
      process.exit(2);
    }
  }

  // Load project ADRs
  const adrEntries = collectAdrIds(ADR_DIR);

  // Build the full set of valid ADR IDs for dangling-reference checks:
  // - project ADR IDs (from this repo's docs/adr/)
  // - harness design ADR numeric IDs (0002-0034) — live in the harness corpus
  // - harness collision aliases (H-0055 → 0055 range)
  // This allows legacy ADRs that reference "ADR-0017" (a harness design ADR) to resolve.
  const allIds = new Set(adrEntries.map((e) => e.id));
  for (let n = 2; n <= 34; n++) {
    allIds.add(String(n).padStart(4, '0'));
  }
  const adrs = adrEntries.map(({ id, file }) => parseAdr(id, file));

  // Validate all ADRs; collect errors
  const errors = [];
  const warnings = [];
  for (const adr of adrs) {
    const issues = validateAdr(adr, allIds);
    for (const issue of issues) {
      if (issue.level === 'error') {
        errors.push(issue.message);
      } else {
        warnings.push(issue.message);
      }
    }
  }

  // Emit warnings (non-fatal)
  for (const w of warnings) {
    console.warn(`adr-digest WARN: ${w}`);
  }

  // Emit errors
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`adr-digest ERROR: ${e}`);
    }
    process.exit(1);
  }

  // Generate digest content
  const generated = generateDigest(adrs, designCorpus);

  if (checkMode) {
    // Compare with committed DIGEST.md
    if (!existsSync(DIGEST_PATH)) {
      console.error(
        `adr-digest: DIGEST.md not found at ${DIGEST_PATH} — run \`just adr-digest\` first`,
      );
      process.exit(1);
    }
    const committed = readFileSync(DIGEST_PATH, 'utf8');
    if (committed !== generated) {
      console.error(
        `adr-digest: DIGEST.md is stale — committed digest differs from regenerated output.\n` +
          `Run \`just adr-digest\` to refresh, then commit the updated DIGEST.md.`,
      );
      process.exit(1);
    }
    console.log('adr-digest: DIGEST.md is up-to-date (no drift).');
  } else {
    writeFileSync(DIGEST_PATH, generated, 'utf8');
    console.log(
      `adr-digest: wrote ${DIGEST_PATH} (${adrs.length} project ADRs, ${designCorpus.entries.length} H- entries)`,
    );
  }
}

main();
