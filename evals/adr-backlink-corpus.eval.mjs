// adr-backlink-corpus.eval.mjs — 12r-f: corpus-level teeth for the bidirectional
// Amends/Amended-by back-link check inside scripts/adr-digest.mjs.
//
// SCOPE OF THIS FILE: the teeth that keep the gate honest ABOUT THE REAL CORPUS.
// A sibling eval (evals/adr-backlink-integrity.eval.mjs) owns the synthetic
// fixture teeth. That split is deliberate: the red-team proved a fixture-ONLY
// suite goes 100% GREEN for an implementation containing
//   if (checkMode) return issues;            // "only enforce when generating"
//   if (adrs.length > 100) return issues;    // "only enforce on small corpora"
// Both of those bypasses are invisible to a 1–3 file tmpdir fixture. Everything
// below runs against the REAL docs/adr/ corpus (170+ ADRs) in BOTH modes.
//
// The contract under test (implemented by someone else, in scripts/adr-digest.mjs):
//   Rule       X declares `Amends: Y`  ⟹  Y must declare `Amended-by: X` (and reverse).
//   Era        enforced only when BOTH endpoints are >= BACKLINK_ERA_MIN ('0151').
//   Tolerance  KNOWN_BACKLINK_GAPS — a frozen Set of EXACTLY 5 pre-existing keys.
//   Warn       "<N> pre-existing Amends/Amended-by back-link gap(s) tolerated
//               (KNOWN_BACKLINK_GAPS in scripts/adr-digest.mjs); <M> more below
//               the ADR-0151 enforcement era"   — via the `warnings` array, so it
//               renders with the standard "adr-digest WARN: " prefix.
//   Errors     forward: `${X}: **Amends:** ADR-${Y} but ADR-${Y} has no reciprocal
//                        **Amended-by:** ADR-${X} back-link (${X}->${Y})`
//              reverse: `${Y}: **Amended-by:** ADR-${X} but ADR-${X} has no reciprocal
//                        **Amends:** ADR-${Y} declaration (${Y}<-${X})`
//
// Teeth in this file:
//   T9  — real corpus passes --check AND reports the tolerated count as literal 5.
//   T11 — the six spec pairs are never present as literals in scripts/adr-digest.mjs.
//   T12 — NEGATIVE CONTROL: strip the four back-links this slice added from a copy
//         of the REAL corpus; both plain and --check runs must fail with all six keys.
//   T13 — POSITIVE: the four back-links (and their forward Amends legs) really do
//         exist in the committed docs/adr/ files.
//   T14 — the KNOWN_BACKLINK_GAPS baseline may not GROW (exact set equality).
//
// IMPORTANT: NO new RegExp(...) anywhere — scripts/adr-digest.mjs:10-11; the
// Semgrep detect-non-literal-regexp rule is part of `just ci` and has bitten this
// project 3×. Only literal /regex/, String.includes/indexOf/startsWith, charCodeAt.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'adr-digest.mjs');
const REAL_ADR_DIR = join(ROOT, 'docs', 'adr');

// The four ADRs this slice repaired. The **Amended-by:** lines are ALREADY
// committed in the worktree; T13 proves that, T12 proves the gate would have
// caught their absence.
const REPAIRED_FILES = [
  '0151-help-affordance-hint.md',
  '0162-overlay-registry-two-level-main-menu.md',
  '0163-overlay-probe-substrate-and-click-front-door.md',
  '0174-essence-graph-schema-and-type-freeze.md',
];

// The six back-link pairs this slice repaired, in the `(X->Y)` suffix form the
// forward error message ends with.
const SPEC_PAIR_KEYS = [
  '0163->0151',
  '0163->0162',
  '0164->0162',
  '0164->0163',
  '0175->0174',
  '0176->0174',
];

// The frozen pre-existing baseline. EXACTLY these 5 — no more, no fewer.
// Deliberately duplicated here, in a different directory from the source of
// truth, so that GROWING the baseline requires two visible edits in two files
// and cannot be slipped past review inside a single scripts/ diff.
const FROZEN_BASELINE = ['0166->0156', '0168->0166', '0169->0154', '0172->0157', '0177->0173'];

// ---------------------------------------------------------------------------
// Helper: run scripts/adr-digest.mjs; return { code, stdout, stderr, combined }.
// spawnSync captures the exit code as data rather than throwing, so each tooth
// can inspect it independently.
// ---------------------------------------------------------------------------
function runDigest(args) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    code: result.status !== null ? result.status : 1,
    stdout,
    stderr,
    combined: stderr + stdout,
  };
}

// ---------------------------------------------------------------------------
// Header helpers — MIRROR scripts/adr-digest.mjs:65 (headerPreamble) and :71
// (extractBoldField). A field only counts when it lives in the header preamble
// (everything before the first "\n## "), never in the body: ADR-0104 ships a
// literal "**Amended-by:** ADR-NNNN" line inside its body template, and a
// full-document scan would read that as a real declaration.
// ---------------------------------------------------------------------------
function headerPreamble(content) {
  const boundary = content.indexOf('\n## ');
  return boundary === -1 ? content : content.slice(0, boundary);
}

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

function isDigitChar(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

/**
 * Does `fieldValue` reference ADR `id` (a bare 4-digit string)?
 * The corpus uses BOTH spellings — "**Amends:** 0151, 0162" and
 * "**Amends:** ADR-0060, ADR-0061" — so match the 4-digit token with
 * non-digit boundaries on both sides rather than requiring an "ADR-" prefix.
 * Boundary-checking is what stops "0151" matching inside "01510" or "20151".
 */
function resolvesId(fieldValue, id) {
  if (!fieldValue) return false;
  let idx = 0;
  for (;;) {
    const hit = fieldValue.indexOf(id, idx);
    if (hit === -1) return false;
    const before = hit > 0 ? fieldValue[hit - 1] : '';
    const after = hit + id.length < fieldValue.length ? fieldValue[hit + id.length] : '';
    if (!isDigitChar(before) && !isDigitChar(after)) return true;
    idx = hit + 1;
  }
}

/**
 * Drop every line whose trimStart() begins with "**Amended-by:**".
 * Plain string work only — split on '\n', compare prefixes. No new RegExp.
 * Returns { text, removed } so the caller can GUARD that the strip actually
 * did something (a silently-no-op strip would make T12 assert nothing).
 */
function stripAmendedByLines(text) {
  const lines = text.split('\n');
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    if (line.trimStart().startsWith('**Amended-by:**')) {
      removed++;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n'), removed };
}

/** Copy every top-level regular file out of docs/adr/ into `dest`. */
function copyRealCorpus(dest) {
  let copied = 0;
  for (const entry of readdirSync(REAL_ADR_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    copyFileSync(join(REAL_ADR_DIR, entry.name), join(dest, entry.name));
    copied++;
  }
  return copied;
}

/**
 * Extract every QUOTED string literal in `source` whose body has the pair-key
 * shape: exactly 4 digits, then '->' or '<-', then exactly 4 digits.
 * Anchored scan, no new RegExp: quote at i, 10-char body, same quote at i+11.
 */
function isPairKeyShape(s) {
  if (s.length !== 10) return false;
  for (let k = 0; k < 4; k++) if (!isDigitChar(s[k])) return false;
  for (let k = 6; k < 10; k++) if (!isDigitChar(s[k])) return false;
  const arrow = s[4] + s[5];
  return arrow === '->' || arrow === '<-';
}

function extractPairKeyLiterals(source) {
  const found = new Set();
  for (let i = 0; i + 11 < source.length; i++) {
    const q = source[i];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    if (source[i + 11] !== q) continue;
    const body = source.slice(i + 1, i + 11);
    if (isPairKeyShape(body)) found.add(body);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Default export — eval entry point. run.mjs expects { name, pass, detail }.
// ---------------------------------------------------------------------------
export default async function () {
  const name = 'adr-backlink-corpus (12r-f: bidirectional Amends/Amended-by — real-corpus teeth)';
  const failing = [];

  // =========================================================================
  // T12 — NEGATIVE CONTROL on the REAL corpus, in BOTH modes.
  //
  // Built first and treated as the load-bearing tooth of this slice.
  //
  // Procedure:
  //   1. Copy the entire real docs/adr/ into a tmpdir (CORPUS_PATH is resolved
  //      relative to PROJECT_ROOT — scripts/adr-digest.mjs:58 — not to
  //      --adr-dir, so design-corpus.json would resolve anyway; we copy it
  //      regardless so the tmpdir is a faithful replica).
  //   2. In the COPY ONLY, delete every "**Amended-by:**" line from the four
  //      ADRs this slice repaired — i.e. rewind the E2 deliverable.
  //   3. Run the script twice against the tmpdir: once plain, once --check.
  //   4. Both runs must exit non-0 AND name all six pair keys.
  //
  // Why each ingredient matters — all three, stated explicitly:
  //   * Running BOTH modes is what kills `if (checkMode) return issues;`. A
  //     gate that only fires while generating is dead in CI, which runs --check.
  //     A gate that only fires under --check is dead for `just adr-digest`.
  //   * Using the FULL real corpus (170+ ADRs, not a 4-file fixture) is what
  //     kills a corpus-size bypass such as `if (adrs.length > 100) return
  //     issues;` — a shape that passes every synthetic fixture tooth.
  //   * Requiring the SIX SPECIFIC pair keys is what kills an obfuscated or
  //     over-broad KNOWN_BACKLINK_GAPS that silently swallows exactly these
  //     violations to reach green; a generic "exit non-0" assertion would be
  //     satisfied by any unrelated error.
  // =========================================================================
  {
    const dir = mkdtempSync(join(tmpdir(), 'adr-backlink-corpus-'));
    try {
      const copied = copyRealCorpus(dir);
      let setupOk = true;

      if (copied < 100) {
        setupOk = false;
        failing.push(
          'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: copied only ' +
            `${copied} file(s) out of ${REAL_ADR_DIR} — expected 100+ (the real corpus). ` +
            'The tooth would be running against a stub corpus and could not prove the ' +
            'corpus-size bypass is absent. Refusing to pass vacuously.',
        );
      }

      let totalRemoved = 0;
      const perFileRemoved = [];
      for (const fileName of REPAIRED_FILES) {
        const path = join(dir, fileName);
        let original;
        try {
          original = readFileSync(path, 'utf8');
        } catch (err) {
          setupOk = false;
          failing.push(
            `T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: could not read ` +
              `the copied ${fileName} — ${err?.message ?? String(err)}. The strip step is a ` +
              'no-op and the tooth would assert nothing.',
          );
          continue;
        }
        const { text, removed } = stripAmendedByLines(original);
        writeFileSync(path, text, 'utf8');
        totalRemoved += removed;
        perFileRemoved.push(`${fileName}=${removed}`);
      }

      // GUARD: a silently-no-op strip would make T12 assert nothing at all —
      // the copy would still contain every back-link and the script would
      // (correctly) stay green, which we would then misread as "the gate has
      // no bite". Fail loudly instead of passing vacuously.
      if (totalRemoved < 4) {
        setupOk = false;
        failing.push(
          'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: the strip removed ' +
            `${totalRemoved} **Amended-by:** line(s), expected >= 4 (one per repaired ADR). ` +
            `Per-file removals: ${perFileRemoved.join(', ')}. Either the four ADRs no longer ` +
            'carry the back-links this slice added (then T13 is the tooth to read), or the ' +
            'line-prefix match drifted. NOT passing vacuously.',
        );
      }

      if (setupOk) {
        const out = join(dir, 'DIGEST.md');
        const runs = [
          { label: 'plain (generate)', result: runDigest(['--adr-dir', dir, '--out', out]) },
          { label: '--check', result: runDigest(['--adr-dir', dir, '--out', out, '--check']) },
        ];

        for (const { label, result } of runs) {
          if (result.code === 0) {
            failing.push(
              `T12 (negative control, ${label}): the real corpus with the four back-links ` +
                'STRIPPED exited 0 — the bidirectional back-link gate has NO BITE in this ' +
                'mode. This is exactly the shape the red-team found: a check guarded by ' +
                '`if (checkMode) return issues;` or `if (adrs.length > 100) return issues;` ' +
                'passes every synthetic fixture and dies here. Expected exit non-0 naming ' +
                `${SPEC_PAIR_KEYS.length} missing back-links. stdout: ` +
                `${result.stdout.slice(0, 400)} | stderr: ${result.stderr.slice(0, 400)}`,
            );
            continue;
          }

          const missing = [];
          for (const key of SPEC_PAIR_KEYS) {
            if (result.combined.indexOf(`(${key})`) === -1) missing.push(`(${key})`);
          }
          if (missing.length > 0) {
            failing.push(
              `T12 (negative control, ${label}): exited ${result.code}, but the output does ` +
                `not name ${missing.length}/${SPEC_PAIR_KEYS.length} of the expected pair ` +
                `keys: ${missing.join(', ')}. Either the gate is not reporting these ` +
                'violations at all (and the non-0 exit came from an unrelated error), or ' +
                'KNOWN_BACKLINK_GAPS has been widened to swallow them. Expected each as the ' +
                'trailing "(X->Y)" of the forward message. stderr: ' +
                `${result.stderr.slice(0, 800)} | stdout: ${result.stdout.slice(0, 400)}`,
            );
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // T13 — POSITIVE tooth: the four back-links actually exist in the real repo.
  //
  // This is the actual E2 deliverable of the slice, asserted directly against
  // the committed docs/adr/ files. Cheat-proof by construction: there is no
  // implementation detour — the bytes are either in the ADRs or they are not.
  //
  // It also pins the FORWARD legs (0163 Amends 0151+0162; 0175/0176 Amend
  // 0174), which kills the cheapest way to go green: deleting the `Amends:`
  // entry instead of adding the reciprocal `Amended-by:`.
  //
  // Header preamble only (mirrors headerPreamble at scripts/adr-digest.mjs:65)
  // — a body occurrence must never count.
  // =========================================================================
  {
    // [file, fieldName, [ids that MUST resolve]]
    const expectations = [
      ['0151-help-affordance-hint.md', 'Amended-by', ['0163']],
      ['0162-overlay-registry-two-level-main-menu.md', 'Amended-by', ['0163', '0164']],
      ['0163-overlay-probe-substrate-and-click-front-door.md', 'Amended-by', ['0164']],
      ['0174-essence-graph-schema-and-type-freeze.md', 'Amended-by', ['0175', '0176']],
      // Forward legs — the "go green by deleting the Amends entry" killers.
      ['0163-overlay-probe-substrate-and-click-front-door.md', 'Amends', ['0151', '0162']],
      [
        '0164-overlay-registry-write-substrate-and-canopen-migration.md',
        'Amends',
        ['0162', '0163'],
      ],
      ['0175-essence-graph-reducers.md', 'Amends', ['0174']],
      ['0176-essence-graph-content-authoring.md', 'Amends', ['0174']],
    ];

    for (const [fileName, fieldName, ids] of expectations) {
      let content;
      try {
        content = readFileSync(join(REAL_ADR_DIR, fileName), 'utf8');
      } catch (err) {
        failing.push(
          `T13 (real back-links exist): could not read docs/adr/${fileName} — ` +
            `${err?.message ?? String(err)}. The ADR the slice repaired is missing or renamed.`,
        );
        continue;
      }
      const value = extractBoldField(content, fieldName);
      if (value === null) {
        failing.push(
          `T13 (real back-links exist): docs/adr/${fileName} has no **${fieldName}:** line in ` +
            'its header preamble (everything before the first "\\n## "). Expected it to ' +
            `resolve ${ids.join(' and ')}. A body-only occurrence does not count — ` +
            'extractBoldField is header-scoped (scripts/adr-digest.mjs:65,71).',
        );
        continue;
      }
      for (const id of ids) {
        if (!resolvesId(value, id)) {
          failing.push(
            `T13 (real back-links exist): docs/adr/${fileName} header field **${fieldName}:** ` +
              `does not resolve ADR-${id}. Actual value: "${value}". Both the bare form ` +
              `("${id}") and the prefixed form ("ADR-${id}") are accepted, so this is a real ` +
              'missing reference, not a formatting quibble. If this fired on the **Amends:** ' +
              'row, someone deleted a forward leg to make the back-link gate go green.',
          );
        }
      }
    }
  }

  // =========================================================================
  // T9 — the real corpus passes, AND says how much it tolerated.
  //
  // No --adr-dir / --out overrides: the committed docs/adr/ and DIGEST.md.
  //
  // Two assertions, both necessary:
  //   (a) exit 0 — the slice must leave CI green.
  //   (b) the warn summary is present with the tolerated count as the EXACT
  //       literal 5 (not "> 0"). This kills a SILENT SWALLOW: a baseline that
  //       suppresses violations while printing nothing at all is
  //       indistinguishable from "no violations" to a bare exit-0 assertion.
  //
  // The count is pinned deliberately — if a future slice legitimately fixes one
  // of the 5 baselined gaps, this number and KNOWN_BACKLINK_GAPS must both
  // shrink, in the same commit. That is the anti-rot ratchet.
  //
  // The trailing below-era count <M> is NOT pinned (it moves with any pre-0151
  // ADR edit), but it must be a non-empty digit run — "; NaN more below…" or
  // "; undefined more below…" fails.
  // =========================================================================
  {
    const WARN_PREFIX =
      'adr-digest WARN: 5 pre-existing Amends/Amended-by back-link gap(s) tolerated ' +
      '(KNOWN_BACKLINK_GAPS in scripts/adr-digest.mjs); ';
    const WARN_SUFFIX = ' more below the ADR-0151 enforcement era';

    const r = runDigest(['--check']);

    if (r.code !== 0) {
      failing.push(
        'T9 (real corpus --check): expected exit 0 on the committed real corpus but got exit ' +
          `${r.code}. Either the new back-link check is flagging a pair that this slice was ` +
          'supposed to repair (see T13), KNOWN_BACKLINK_GAPS is missing one of the 5 ' +
          'pre-existing gaps, or docs/adr/DIGEST.md is stale. stderr: ' +
          `${r.stderr.slice(0, 800)}`,
      );
    }

    const prefixIdx = r.combined.indexOf(WARN_PREFIX);
    if (prefixIdx === -1) {
      failing.push(
        'T9 (tolerated-count summary): output does not contain the exact warn line prefix\n' +
          `  ${WARN_PREFIX}\n` +
          'Either the summary is not emitted at all (a SILENT SWALLOW — a baseline that ' +
          'suppresses violations with zero output is indistinguishable from "no violations"), ' +
          'it is not routed through the `warnings` array (so it lacks the standard ' +
          '"adr-digest WARN: " prefix), or the tolerated count is not the literal 5 ' +
          '(baseline rot: the frozen set is 0166->0156, 0168->0166, 0169->0154, 0172->0157, ' +
          '0177->0173 — exactly five). Actual output: ' +
          `${r.combined.slice(0, 1200)}`,
      );
    } else {
      const afterPrefix = prefixIdx + WARN_PREFIX.length;
      const suffixIdx = r.combined.indexOf(WARN_SUFFIX, afterPrefix);
      if (suffixIdx === -1) {
        failing.push(
          'T9 (tolerated-count summary): found the prefix but not the trailing\n' +
            `  "${WARN_SUFFIX}"\n` +
            'the summary line is truncated or reworded. Actual tail: ' +
            `${r.combined.slice(afterPrefix, afterPrefix + 300)}`,
        );
      } else {
        const between = r.combined.slice(afterPrefix, suffixIdx);
        let allDigits = between.length > 0;
        for (let k = 0; k < between.length; k++) {
          if (!isDigitChar(between[k])) allDigits = false;
        }
        if (!allDigits) {
          failing.push(
            'T9 (tolerated-count summary): the below-era count is not a plain digit run — ' +
              `got "${between}". Expected e.g. "…tolerated (…); 3 more below the ADR-0151 ` +
              'enforcement era". A NaN/undefined here means the below-era tally is never ' +
              'actually computed.',
          );
        }
      }
    }
  }

  // =========================================================================
  // T14 — the baseline may not GROW.
  //
  // The red-team showed a "shrink-only ratchet" (assert the baseline is a
  // subset of a known list) detects STALENESS but does not prevent someone
  // APPENDING an entry to reach green. So: exact SET EQUALITY, sorted, against
  // the frozen list — containment is not enough in either direction.
  //
  // This list is a deliberate SECOND COPY of the baseline, living in a
  // different directory (evals/ vs scripts/). Growing the tolerated set now
  // requires two visible edits in two files and cannot be slipped into a single
  // scripts/adr-digest.mjs diff.
  //
  // Extraction is a plain anchored scan for quoted literals of the pair-key
  // shape (4 digits, '->' or '<-', 4 digits) — no new RegExp.
  // =========================================================================
  let scriptSource = null;
  try {
    scriptSource = readFileSync(SCRIPT, 'utf8');
  } catch (err) {
    failing.push(
      `T14/T11: could not read ${SCRIPT} — ${err?.message ?? String(err)}. Both source-scan ` +
        'teeth are inert without it; failing rather than skipping.',
    );
  }

  if (scriptSource !== null) {
    const extracted = [...extractPairKeyLiterals(scriptSource)].sort();
    const expected = [...FROZEN_BASELINE].sort();
    if (extracted.join('|') !== expected.join('|')) {
      const unexpected = extracted.filter((k) => !expected.includes(k));
      const absent = expected.filter((k) => !extracted.includes(k));
      failing.push(
        'T14 (baseline may not grow): the set of pair-key string literals in ' +
          'scripts/adr-digest.mjs does not EQUAL the frozen baseline.\n' +
          `  expected (${expected.length}): ${expected.join(', ')}\n` +
          `  actual   (${extracted.length}): ${extracted.length ? extracted.join(', ') : '<none>'}\n` +
          (unexpected.length
            ? `  UNEXPECTED (baseline GREW — a new gap was tolerated instead of fixed): ${unexpected.join(', ')}\n`
            : '') +
          (absent.length
            ? `  ABSENT (KNOWN_BACKLINK_GAPS not implemented yet, or the baseline shrank without updating this eval): ${absent.join(', ')}\n`
            : '') +
          '  If a gap was legitimately repaired, shrink BOTH KNOWN_BACKLINK_GAPS and ' +
          'FROZEN_BASELINE in this file, in the same commit, and drop the T9 count to match.',
      );
    }

    // =======================================================================
    // T11 — the six spec pairs are never baselined.
    //
    // Cheap early warning: none of the six pairs this slice REPAIRED may appear
    // anywhere in scripts/adr-digest.mjs, in any form. The failure mode it
    // watches for is "close the slice by adding the six pairs to
    // KNOWN_BACKLINK_GAPS instead of adding the back-links to the ADRs".
    //
    // HONEST LIMITATION: this scans a *representation*, not behaviour. It is
    // defeatable by string construction (`'016' + '3->0151'`, a computed key,
    // a Set built from a loop). T12 is the behavioural backstop that cannot be
    // dodged that way — if the six pairs are tolerated by ANY mechanism, the
    // stripped-corpus run stays green and T12 fires. T11 just makes the obvious
    // version of the cheat fail fast and legibly.
    // =======================================================================
    const baselined = SPEC_PAIR_KEYS.filter((key) => scriptSource.indexOf(key) !== -1);
    if (baselined.length > 0) {
      failing.push(
        'T11 (spec pairs never baselined): scripts/adr-digest.mjs mentions ' +
          `${baselined.length} of the six pair keys this slice REPAIRED: ${baselined.join(', ')}. ` +
          'These pairs must be fixed in docs/adr/ (reciprocal **Amended-by:** lines — see T13), ' +
          'never tolerated in KNOWN_BACKLINK_GAPS. Their presence in the script means the gate ' +
          'was made green by widening the baseline instead of repairing the corpus.',
      );
    }
  }

  // =========================================================================
  // Final result.
  // =========================================================================
  if (failing.length > 0) {
    return {
      name,
      pass: false,
      detail: failing.join('\n\n'),
    };
  }

  return {
    name,
    pass: true,
    detail: '5/5 corpus-level teeth bite correctly (T9, T11, T12, T13, T14)',
  };
}
