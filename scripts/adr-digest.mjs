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
import { basename, dirname, join, resolve } from 'node:path';
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
// Legacy tolerance — all project ADRs have been backfilled with canonical
// headers in the m-infra-d2 slice. This set is intentionally empty; the
// gate is now zero-tolerance.
// ---------------------------------------------------------------------------
const LEGACY_TOLERANCE = new Set([]);

// ---------------------------------------------------------------------------
// Bidirectional Amends/Amended-by enforcement (12r-f)
//
// ADR-0104 D1 already states the invariant: "An ADR that only *amends* another
// stays `Accepted`; the amended ADR gains `**Amended-by:**`." Until 12r-f that
// was convention only — checkRefs below is a one-directional dangling-reference
// check, so a missing back-link passed green. validateBacklinks() mechanizes it.
//
// ERA SCOPE. A pair is enforced only when BOTH endpoints are >= this id. Below
// it the corpus predates mechanical enforcement and carries ~44 one-directional
// links whose repair is a semantic claim (did X really amend Y?), not a
// formatting fix — a separate slice. Both endpoints, not just the source: you
// can only demand a back-link from Y if Y is itself in the enforced era.
// 0151 is the oldest ADR 12r-f repairs, and is forced from above — one repaired
// pair targets 0151, so a higher cutoff would make the gate vacuous.
const BACKLINK_ERA_MIN = '0151';

// In-era gaps that predate the gate. Keys are `<source><arrow><target>`, arrow
// `->` for a missing Amended-by and `<-` for a missing Amends.
//
// THIS SET MAY ONLY SHRINK. Adding an entry to make CI green defeats the gate
// and is a decision, not a fix; the frozen duplicate in
// evals/adr-backlink-corpus.eval.mjs (T14) asserts set EQUALITY, so growth
// needs two visible edits in two directories. Removing an entry is free — the
// ratchet in validateBacklinks() errors on an entry whose gap is already gone,
// so the set cannot silently rot.
//
// PIN: evals/adr-backlink-integrity.eval.mjs TOOTH 8 is pinned to the entries
// 0168 -> 0166 (reciprocal branch) and 0172 -> 0157 (declaration-gone branch),
// and TOOTH 17 to 0169 -> 0154. If a slice repairs one of those back-links and
// deletes its entry, re-pin the tooth (and its fixture directory + the
// RATCHET_DIRS collision audit) to a surviving entry first — otherwise the
// ratchet loses its proof-of-teeth and the set can stop shrinking unnoticed.
const KNOWN_BACKLINK_GAPS = new Set([
  '0166->0156',
  '0168->0166',
  '0169->0154',
  '0172->0157',
  '0177->0173',
]);

for (const key of KNOWN_BACKLINK_GAPS) {
  if (!/^\d{4}(->|<-)\d{4}$/.test(key)) {
    console.error(
      `adr-digest: KNOWN_BACKLINK_GAPS contains a malformed key "${key}" — ` +
        "expected NNNN->NNNN or NNNN<-NNNN. A typo'd key is inert: it tolerates " +
        'nothing and the ratchet can never retire it.',
    );
    process.exit(2);
  }
}

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

/** Return the header preamble: everything before the first section heading. */
function headerPreamble(content) {
  const boundary = content.indexOf('\n## ');
  return boundary === -1 ? content : content.slice(0, boundary);
}

/** Extract a bold-field value: **FieldName:** <value> — header block only. */
function extractBoldField(content, fieldName) {
  const preamble = headerPreamble(content);
  const needle = `**${fieldName}:**`;
  const idx = preamble.indexOf(needle);
  if (idx === -1) return null;
  const lineEnd = preamble.indexOf('\n', idx);
  const raw = preamble
    .slice(idx + needle.length, lineEnd === -1 ? preamble.length : lineEnd)
    .trim();
  return raw || null;
}

/** Extract a list-field value: - FieldName: <value> — header block only. */
function extractListField(content, fieldName) {
  const preamble = headerPreamble(content);
  const needle = `- ${fieldName}:`;
  const idx = preamble.indexOf(needle);
  if (idx === -1) return null;
  const lineEnd = preamble.indexOf('\n', idx);
  const raw = preamble
    .slice(idx + needle.length, lineEnd === -1 ? preamble.length : lineEnd)
    .trim();
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

  // Back-link resolution reads a FENCE-STRIPPED view so an illustrative
  // `**Amended-by:**` inside a code block cannot satisfy reciprocity. This is a
  // second, narrower view rather than a change to headerPreamble() on purpose:
  // headerPreamble feeds every other field and the generated DIGEST, and
  // widening it there would move DIGEST bytes and perturb evals/adr-digest.eval.mjs.
  // (On today's corpus the two views are identical — no ADR has a fence in its
  // preamble — so this is defence against a future ADR, not a live correction.)
  // headerPreamble FIRST, then strip: stripping first could delete the `## `
  // that bounds the preamble and widen the view into the body — reintroducing
  // the very bypass this view exists to close.
  const backlinkView = stripFencedBlocks(headerPreamble(content));
  const amendsBacklink = extractBacklinkField(backlinkView, 'Amends');
  const amendedByBacklink = extractBacklinkField(backlinkView, 'Amended-by');

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
    amendsBacklink: amendsBacklink || null,
    amendedByBacklink: amendedByBacklink || null,
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

  // Superseded-by must be present and non-em-dash if Status = Superseded
  if (adr.status === 'Superseded' && (!adr.supersededBy || adr.supersededBy === '—')) {
    issues.push({
      level: isLegacy ? 'warn' : 'error',
      message: `${adr.id}: Status is Superseded but missing a real **Superseded-by:** pointer (use an ADR or H- reference, not —)`,
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
        const label = ref.startsWith('H-') ? ref : `ADR-${ref}`;
        issues.push({
          level: refLevel,
          message: `${adr.id}: dangling ${fieldName} reference "${fieldValue}" (${label} not found)`,
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

/**
 * Extract ALL ADR/H- ids from a reference string.
 * Returns bare numeric strings for ADR-NNNN (e.g. "0017") and
 * H-prefixed strings for H-NNNN (e.g. "H-0099").
 */
function extractAllAdrIds(ref) {
  if (!ref) return [];
  const ids = [];
  let idx = 0;
  while (idx < ref.length) {
    const adrIdx = ref.indexOf('ADR-', idx);
    const hIdx = ref.indexOf('H-', idx);
    // Pick the earlier of the two prefixes
    let matchIdx, prefixLen, idPrefix;
    if (adrIdx !== -1 && (hIdx === -1 || adrIdx <= hIdx)) {
      matchIdx = adrIdx;
      prefixLen = 4;
      idPrefix = '';
    } else if (hIdx !== -1) {
      matchIdx = hIdx;
      prefixLen = 2;
      idPrefix = 'H-';
    } else {
      break;
    }
    const start = matchIdx + prefixLen;
    let end = start;
    while (end < ref.length && ref[end] >= '0' && ref[end] <= '9') end++;
    if (end > start) ids.push(idPrefix + ref.slice(start, end));
    idx = end;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Bidirectional back-link checking (12r-f)
// ---------------------------------------------------------------------------

/**
 * Drop every fenced block, backtick- and tilde-delimited. Used ONLY to build the
 * back-link header view — see the note in parseAdr(). An unterminated fence
 * swallows the rest of its input, which is the fail-closed direction: a field
 * whose position we cannot trust resolves to nothing rather than satisfying
 * reciprocity.
 */
function stripFencedBlocks(content) {
  let out = content;
  for (const marker of ['```', '~~~']) {
    const parts = out.split(marker);
    // Even indices are outside fences, odd indices inside.
    let kept = '';
    for (let i = 0; i < parts.length; i += 2) kept += parts[i];
    out = kept;
  }
  return out;
}

/**
 * Read a relation field out of the back-link header view.
 *
 * Deliberately stricter than extractBoldField(): the marker must start at
 * column 0. An indented `**Amended-by:**` is inside a markdown code block (the
 * one decoy shape fence-stripping cannot see), and the canonical header block
 * in ADR-0104 D1 is unindented, so this costs no legitimate ADR anything.
 *
 * Collects EVERY matching line plus its indented continuation lines, so both
 * natural multi-amender forms work — a repeated `**Amended-by:**` line, and a
 * comma-wrapped list. Two slices amending the same ADR is not hypothetical:
 * 12r-f itself produced it twice (0162, 0174).
 */
function extractBacklinkField(view, fieldName) {
  const needle = `**${fieldName}:**`;
  const collected = [];
  const lines = view.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(needle)) continue;
    collected.push(lines[i].slice(needle.length).trim());
    // Absorb indented continuation lines (no bold marker of their own).
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next.trim() === '' || !/^\s/.test(next) || next.indexOf('**') !== -1) break;
      collected.push(next.trim());
      i = j;
    }
  }
  if (collected.length === 0) return null;
  const joined = collected.join(', ').trim();
  return joined || null;
}

/**
 * Resolve the ADR ids named by a relation field (**Amends:** / **Amended-by:**).
 *
 * Deliberately NOT extractAllAdrIds(): that one is prefix-only (ADR-NNNN / H-NNNN)
 * and feeds the dangling-reference check, where widening it would newly drag
 * prose numbers into scope. Nine ADRs in the 0151-0164 era write bare ids
 * (`**Amends:** 0151, 0162`), so back-link resolution must accept both forms.
 *
 * Rules: split on commas; truncate each token at the first `(` so a parenthetical
 * aside cannot contribute ids; skip H- (the harness namespace aliases collide
 * with project numbers — H-0055 is project 0056); strip a leading `ADR-`; take
 * the leading 4-digit run only when the next character is a non-digit or the
 * token ends (so `ADR-0118 §3/A3` resolves and a 5-digit `01510` does not; a
 * date like `2026-07-20` passes that test and is dropped by the file filter
 * below instead); keep only
 * ids that are files in the scanned directory; dedup.
 *
 * "No relation" is an EMPTY result, never a string test against the em dash —
 * real values include `— (supersedes the literal wording of ...)`.
 */

/**
 * Split a relation field on its TOP-LEVEL commas only, so a comma inside a
 * parenthetical aside does not start a new token. Without this,
 * `— (deferred, 0984 lands next slice)` splits into `—` and `0984 lands next
 * slice)`, and the second fragment — having no `(` left to truncate at —
 * resolves 0984 and silently satisfies reciprocity for a back-link that was
 * explicitly deferred. Parenthesised commas are common in this corpus
 * (0118, 0137, 0139, 0147 ...), so this is a live shape, not a hypothetical.
 */
function splitTopLevelCommas(value) {
  const tokens = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = depth > 0 ? depth - 1 : 0;
    else if (ch === ',' && depth === 0) {
      tokens.push(value.slice(start, i));
      start = i + 1;
    }
  }
  tokens.push(value.slice(start));
  return tokens;
}
function resolveRelationIds(fieldValue, localIds) {
  if (!fieldValue) return [];
  const found = new Set();
  for (const rawToken of splitTopLevelCommas(fieldValue)) {
    const paren = rawToken.indexOf('(');
    let token = (paren === -1 ? rawToken : rawToken.slice(0, paren)).trim();
    if (token.startsWith('H-')) continue;
    if (token.startsWith('ADR-')) token = token.slice(4);
    if (token.length < 4) continue;
    let digits = 0;
    while (digits < 4 && token[digits] >= '0' && token[digits] <= '9') digits++;
    if (digits !== 4) continue;
    const next = token[4];
    if (next !== undefined && next >= '0' && next <= '9') continue;
    const id = token.slice(0, 4);
    if (localIds.has(id)) found.add(id);
  }
  return [...found];
}

/**
 * Corpus-level reciprocity check. validateAdr() is per-ADR and structurally
 * cannot do this — a back-link lives in a different file than the declaration.
 *
 * Enforced only inside the era window (both endpoints >= BACKLINK_ERA_MIN) and
 * outside KNOWN_BACKLINK_GAPS. Also ratchets: a baseline entry whose gap is no
 * longer present is an error, so the set can only shrink.
 */
function validateBacklinks(adrs, localIds) {
  const issues = [];

  const amends = new Map();
  const amendedBy = new Map();
  for (const adr of adrs) {
    amends.set(adr.id, resolveRelationIds(adr.amendsBacklink, localIds));
    amendedBy.set(adr.id, resolveRelationIds(adr.amendedByBacklink, localIds));
  }

  // Every reciprocity gap in the corpus, keyed, before era or tolerance filtering.
  // The ratchet compares against THIS set, not the surviving errors — comparing
  // against post-tolerance errors would mark every baselined entry obsolete.
  const gaps = [];
  for (const [x, targets] of amends) {
    for (const y of targets) {
      if (amendedBy.get(y)?.includes(x)) continue;
      gaps.push({
        key: `${x}->${y}`,
        a: x,
        b: y,
        message:
          `${x}: **Amends:** ADR-${y} but ADR-${y} has no reciprocal ` +
          `**Amended-by:** ADR-${x} back-link (${x}->${y})`,
      });
    }
  }
  for (const [y, sources] of amendedBy) {
    for (const x of sources) {
      if (amends.get(x)?.includes(y)) continue;
      gaps.push({
        key: `${y}<-${x}`,
        a: y,
        b: x,
        message:
          `${y}: **Amended-by:** ADR-${x} but ADR-${x} has no reciprocal ` +
          `**Amends:** ADR-${y} declaration (${y}<-${x})`,
      });
    }
  }

  const liveKeys = new Set(gaps.map((gap) => gap.key));
  let tolerated = 0;
  let belowEra = 0;
  for (const gap of gaps) {
    if (gap.a < BACKLINK_ERA_MIN || gap.b < BACKLINK_ERA_MIN) {
      // Counted, never itemised: naming ~44 pre-era pairs on every run is how a
      // gate becomes noise nobody reads.
      belowEra++;
      continue;
    }
    if (KNOWN_BACKLINK_GAPS.has(gap.key)) {
      tolerated++;
      continue;
    }
    issues.push({ level: 'error', message: gap.message });
  }

  // Ratchet. Scoped to entries whose BOTH endpoints exist as files, so a partial
  // corpus (a fixture directory, or an ADR still unwritten) cannot fire it.
  for (const key of KNOWN_BACKLINK_GAPS) {
    const arrow = key.indexOf('->') !== -1 ? '->' : '<-';
    const left = key.slice(0, 4);
    const right = key.slice(6);
    // slice(0,4)/slice(6) are safe: the startup validator pins the 4+2+4 shape.
    if (!localIds.has(left) || !localIds.has(right)) continue;
    if (liveKeys.has(key)) continue;
    const declared =
      arrow === '->' ? amends.get(left)?.includes(right) : amendedBy.get(left)?.includes(right);
    const reason = declared ? 'the pair is now reciprocal' : 'the amendment declaration is gone';
    issues.push({
      level: 'error',
      message:
        `KNOWN_BACKLINK_GAPS entry "${key}" is obsolete — ${reason}; ` +
        'delete the entry (the set may only shrink) — and in the SAME commit drop ' +
        'it from FROZEN_BASELINE and lower BASELINE_TOLERATED_COUNT in ' +
        'evals/adr-backlink-corpus.eval.mjs, or T9/T14 red next run',
    });
  }

  if (tolerated > 0 || belowEra > 0) {
    issues.push({
      level: 'warn',
      message:
        `${tolerated} pre-existing Amends/Amended-by back-link gap(s) tolerated ` +
        `(KNOWN_BACKLINK_GAPS in scripts/adr-digest.mjs); ${belowEra} more below ` +
        `the ADR-${BACKLINK_ERA_MIN} enforcement era`,
    });
  }

  return issues;
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
// Derived "next free project ADR number" (rb-43, ADR-0104 amendment)
//
// A MEASUREMENT of the corpus, not a reservation: max(collected id) + 1. Status
// is deliberately ignored -- a Superseded or Deprecated id is spent and is never
// reused, so it still moves the ceiling. Non-monotone by construction: reverting
// or renaming the top ADR moves it backwards onto a retired id.
// ---------------------------------------------------------------------------
const ADR_BAND_MIN = 1;
const ADR_BAND_MAX = 999;
const ADR_BAND_LABEL = '0001-0999';

/** Pure: { nextId, highestId } over collected id strings; empty corpus -> 0001. */
function deriveNextFree(ids) {
  let highest = null;
  for (const id of ids) {
    const value = Number(id);
    if (!Number.isInteger(value)) continue;
    if (highest === null || value > highest) highest = value;
  }
  if (highest === null) return { nextId: '0001', highestId: null };
  return {
    nextId: String(highest + 1).padStart(4, '0'),
    highestId: String(highest).padStart(4, '0'),
  };
}

/** Pure: the exact next-free line rendered into the generated digest payload. */
function renderNextFreeLine(ids) {
  const { nextId, highestId } = deriveNextFree(ids);
  const opening =
    highestId === null
      ? `Next free project ADR number: **\`${nextId}\`** — no project ADRs on disk.`
      : `Next free project ADR number: **\`${nextId}\`** — the highest id on disk (\`${highestId}\`) plus one. ` +
        'Gaps below it are never reused (`0002`–`0034` belong to the harness spec corpus).';
  return (
    `${opening} Regenerated by \`just adr-digest\` and drift-gated by \`just ci\`; it is a ` +
    'measurement, not a reservation — when a number is reserved for an in-flight slice the ' +
    'supervisor ledger is ahead of this line and is authoritative.'
  );
}

/**
 * Collected ids outside the project band. collectAdrIds deliberately keeps a
 * loose /^[0-9]{4}.*\.md$/ filter, so a date-named `2026-...md` or a five-digit
 * `10000-....md` dropped into docs/adr/ is collected and would poison the
 * derived number. EVERY collected id is checked, not just the maximum.
 */
function idsOutsideBand(entries) {
  const offenders = [];
  for (const entry of entries) {
    const value = Number(entry.id);
    if (!Number.isInteger(value) || value < ADR_BAND_MIN || value > ADR_BAND_MAX) {
      offenders.push(entry);
    }
  }
  return offenders;
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

  // The derived next-free number lives INSIDE the returned payload (which
  // `--check` byte-compares), immediately after the `Generated from` line.
  lines.push(renderNextFreeLine(adrs.map((adr) => adr.id)));
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
      const entry = `${idLink} — ${sliceStr} — ${titleStr} (${statusStr})`;
      lines.push(isDead ? `- ~~${entry}~~` : `- ${entry}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Return the basename of an ADR file path for use in markdown links. */
function filenameBase(filePath) {
  return basename(filePath);
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
  // - harness design ADR numeric IDs (0002-0034) — legacy refs use bare ADR-NNNN form
  // - H-prefixed IDs from design-corpus.json — canonical refs use H-NNNN form
  const allIds = new Set(adrEntries.map((e) => e.id));
  for (let n = 2; n <= 34; n++) {
    allIds.add(String(n).padStart(4, '0'));
  }
  for (const entry of designCorpus.entries) {
    allIds.add(entry.id); // "H-0002", "H-0003", ..., "H-0055", "H-0056", "H-0057"
  }
  const adrs = adrEntries.map(({ id, file }) => parseAdr(id, file));

  // Validate all ADRs; collect errors
  const errors = [];
  const warnings = [];

  // Band guard (rb-43): every COLLECTED id must sit inside the project band.
  // Pushed into `errors` so it fails loud BEFORE generateDigest() and before
  // either the --check compare or the writeFileSync -- a guard that clobbers the
  // target and only then exits 1 has already destroyed the file it rejected.
  for (const entry of idsOutsideBand(adrEntries)) {
    errors.push(
      `${entry.id}: collected from "${basename(entry.file)}", outside the project ADR band ` +
        `${ADR_BAND_LABEL} -- a non-ADR markdown file in this directory poisons the derived ` +
        'next-free number. Rename or move it.',
    );
  }
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

  // Corpus-level reciprocity (12r-f). Runs unconditionally — in --check AND in
  // generate mode — because a gate that only bites in one mode is half dead.
  // Resolves against the SCANNED FILE ids, not allIds: allIds also carries the
  // synthetic harness range 0002-0034 and the H- namespace, which have no file
  // and so could never gain a back-link.
  const localIds = new Set(adrEntries.map((e) => e.id));
  for (const issue of validateBacklinks(adrs, localIds)) {
    if (issue.level === 'error') {
      errors.push(issue.message);
    } else {
      warnings.push(issue.message);
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
