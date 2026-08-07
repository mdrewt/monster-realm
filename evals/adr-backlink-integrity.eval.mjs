// adr-backlink-integrity.eval.mjs — 12r-f: bidirectional ADR back-link teeth.
//
// Gates the NEW corpus-level back-link check inside scripts/adr-digest.mjs:
//
//   FORWARD  for each ADR X and each id Y resolved from X's **Amends:**,
//            Y's **Amended-by:** must resolve X.
//   REVERSE  for each ADR Y and each id X resolved from Y's **Amended-by:**,
//            X's **Amends:** must resolve Y.
//   ERA      a pair is enforced only when BOTH endpoints are >= '0151'.
//   TOLERATE a violation whose pair key is in KNOWN_BACKLINK_GAPS is silent.
//   RATCHET  a baseline entry whose two endpoints are both present as files and
//            whose violation no longer holds is an ERROR (the set may only shrink).
//
// Exact message contract these teeth assert against (main() prefixes errors with
// "adr-digest ERROR: " and warnings with "adr-digest WARN: "):
//
//   forward:  `${X}: **Amends:** ADR-${Y} but ADR-${Y} has no reciprocal
//              **Amended-by:** ADR-${X} back-link (${X}->${Y})`
//   reverse:  `${Y}: **Amended-by:** ADR-${X} but ADR-${X} has no reciprocal
//              **Amends:** ADR-${Y} declaration (${Y}<-${X})`
//   obsolete: `KNOWN_BACKLINK_GAPS entry "${key}" is obsolete — the pair is now
//              reciprocal; delete the entry (the set may only shrink)`
//
// The obsolete template above is the only one the spec states, and it names the
// RECIPROCAL branch. A baseline entry is also obsolete when the amendment
// declaration itself disappears (TOOTH 17). Because no separate wording was
// specified for that branch, TOOTH 17 pins only the two parts common to both —
// the `KNOWN_BACKLINK_GAPS entry "<key>" is obsolete` opener and the actionable
// `delete the entry (the set may only shrink)` closer — and leaves the middle
// reason clause free. Pinning wording that was never handed over would be
// guessing at the contract rather than testing it.
//
// Teeth in this file (each fixture directory is copied wholesale into a tmpdir
// and scanned via --adr-dir, so nothing here reads the real docs/adr/ corpus):
//
//   TOOTH 0  red-proof self-check + ratchet scope guard (every fixture dir).
//   TOOTH 1  forward gap is reported                        (0910->0911).
//   TOOTH 2  reciprocal pair is silent — false-positive guard.
//   TOOTH 3  a back-link gap is an ERROR, not a downgraded WARN.
//   TOOTH 4  bare (un-prefixed) **Amends:** id resolves      (0914->0915).
//   TOOTH 5  bare ids on BOTH sides are silent — false-positive guard.
//   TOOTH 6  em-dash sentinel + prose id is still a gap      (0919->0918).
//   TOOTH 7  reverse-direction gap is reported               (0920<-0921).
//   TOOTH 8  ratchet: an obsolete KNOWN_BACKLINK_GAPS entry is an ERROR.
//   TOOTH 10 the tolerance set is PAIR-keyed, not source-keyed (0166->0955).
//   TOOTH 15 a fenced back-link in a doc with no level-two heading is not a back-link.
//   TOOTH 16a a pair with BOTH endpoints below the era is tolerated (0120->0121).
//   TOOTH 16b a MIXED-era pair (target below the era) is tolerated (0955->0120).
//   TOOTH 17 ratchet, second branch: the declaration is gone     (0169->0154).
//
// Every assertion is on the parenthesised PAIR KEY or on the literal "obsolete"
// substring — never on a bare non-zero exit code. A red-team pass proved that
// exit-code-only teeth go green for entirely unrelated reasons (an incomplete
// fixture header alone makes validateAdr exit 1).
//
// IMPORTANT: NO new RegExp(...) — the detect-non-literal-regexp Semgrep rule is
// part of `just ci` and has bitten this project 3×. String.includes()/indexOf()
// and literal /regex/ only.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'adr-digest.mjs');
const FIXTURES = join(__dirname, 'fixtures', 'adr-backlink');

// Every fixture directory owned by this eval. TOOTH 0 walks this list.
const FIXTURE_DIRS = [
  't1-forward-gap',
  't2-reciprocal-ok',
  't4-bare-ids',
  't5-bare-reciprocal',
  't6-em-dash-prose',
  't7-reverse-gap',
  't8-obsolete-baseline',
  't10-source-keyed-baseline',
  't15-no-h2-heading',
  't16a-below-era',
  't16b-mixed-era',
  't17-ratchet-declaration-gone',
];

// The ONLY fixture directories in which the ratchet is allowed to fire. Every
// other directory is missing at least one endpoint of every baseline entry.
//
// COLLISION AUDIT (why "exactly 1 obsolete line" is a sound assertion in both):
// the five KNOWN_BACKLINK_GAPS entries are 0166->0156, 0168->0166, 0169->0154,
// 0172->0157 and 0177->0173.
//   t8-obsolete-baseline        contains {0168, 0166}. 0166->0156 is missing
//     0156; 0169->0154, 0172->0157 and 0177->0173 have NEITHER endpoint. Only
//     0168->0166 has both endpoints present. => exactly 1 candidate.
//   t17-ratchet-declaration-gone contains {0169, 0154}. 0166->0156, 0168->0166,
//     0172->0157 and 0177->0173 have NEITHER endpoint present. Only 0169->0154
//     has both. => exactly 1 candidate.
// The two directories therefore fire on DIFFERENT entries and neither tooth's
// "exactly 1" assertion can be accidentally satisfied by a stray other entry.
const RATCHET_DIRS = ['t8-obsolete-baseline', 't17-ratchet-declaration-gone'];

// Substrings that mean "some OTHER, pre-existing validateAdr rule fired".
// If one of these shows up for a fixture, that fixture's tooth would go green
// for a reason that has nothing to do with back-links. See TOOTH 0.
const FOREIGN_ERROR_MARKERS = [
  'missing **',
  'unknown subsystem',
  'unknown Status',
  '**Subsystems:** must have',
  'exceeds 240 chars',
  'dangling',
  'ADR directory not found',
  'failed to parse design-corpus',
];

// ---------------------------------------------------------------------------
// Helper: run scripts/adr-digest.mjs with the given args; return { code, stderr, stdout }.
// spawnSync captures the exit code as data rather than throwing, so each tooth
// can inspect the code independently.
// ---------------------------------------------------------------------------
function runDigest(args) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return {
    code: result.status !== null ? result.status : 1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

// ---------------------------------------------------------------------------
// Helper: copy a WHOLE fixture directory into a fresh tmpdir, run the digest
// generator over it with --adr-dir/--out, and hand the result to `fn`. The
// tmpdir is always removed in a finally block.
//
// Copying the whole directory (rather than a single file, as adr-digest.eval.mjs
// does) is what makes corpus-level, cross-ADR checks testable at all: back-link
// integrity is a property of a PAIR of files, not of one file.
// ---------------------------------------------------------------------------
function withFixtureDir(fixtureDirName, fn) {
  const src = join(FIXTURES, fixtureDirName);
  const dir = mkdtempSync(join(tmpdir(), 'adr-backlink-'));
  try {
    const files = existsSync(src) ? readdirSync(src).filter((f) => f.endsWith('.md')) : [];
    for (const f of files) {
      writeFileSync(join(dir, f), readFileSync(join(src, f), 'utf8'));
    }
    const r = runDigest(['--adr-dir', dir, '--out', join(dir, 'DIGEST.md')]);
    return fn({
      code: r.code,
      stderr: r.stderr,
      stdout: r.stdout,
      combined: r.stderr + r.stdout,
      fixtureFileCount: files.length,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Return every line of `text` that contains `needle`. */
function linesContaining(text, needle) {
  return text.split('\n').filter((line) => line.indexOf(needle) !== -1);
}

/** Short, quotable slice of process output for failure messages. */
function excerpt(text) {
  return text.trim().slice(0, 500) || '(no output)';
}

// ---------------------------------------------------------------------------
// Default export — eval entry point.
// ---------------------------------------------------------------------------
export default async function () {
  const name = 'adr-backlink-integrity (12r-f: bidirectional ADR back-link gate)';

  const failing = [];

  // =========================================================================
  // TOOTH 0 — RED-PROOF SELF-CHECK (+ ratchet scope guard).
  //
  // Makes every other tooth in this file honest. Guards the red-team's
  // fixture-authoring false green: an incomplete canonical header would make
  // validateAdr error and the tooth would pass for a pre-existing reason
  // (missing **Date:**, unknown subsystem, a dangling ADR-NNNN reference to a
  // file that is not in the tmpdir, ...) rather than because the back-link
  // check bit. So: for every fixture directory, the ONLY errors the generator
  // may produce are back-link errors.
  //
  // Second half: the ratchet may fire ONLY in the RATCHET_DIRS. Every other
  // fixture directory is deliberately missing at least one endpoint of every
  // KNOWN_BACKLINK_GAPS entry, so an "obsolete" line anywhere else means the
  // implementation skipped the "both endpoints present as files" guard — which
  // would also let an unrelated ratchet error green TOOTH 10, and would fire
  // spuriously in t16a/t16b (whose ids 0120/0121/0955 are baseline endpoints of
  // nothing at all).
  //
  // Kills: fixtures that fail for the wrong reason; a ratchet with no
  // both-endpoints-present guard.
  // =========================================================================
  for (const fixtureDir of FIXTURE_DIRS) {
    withFixtureDir(fixtureDir, (r) => {
      if (r.fixtureFileCount < 2) {
        failing.push(
          `TOOTH 0 (red-proof self-check): fixture directory "${fixtureDir}" contains ` +
            `${r.fixtureFileCount} .md file(s) — a back-link tooth needs at least 2 (a source ` +
            'and a target). The fixture is missing or was not copied.',
        );
        return;
      }
      for (const marker of FOREIGN_ERROR_MARKERS) {
        if (r.combined.indexOf(marker) !== -1) {
          failing.push(
            `TOOTH 0 (red-proof self-check): fixture directory "${fixtureDir}" produced a ` +
              `NON-back-link diagnostic containing "${marker}". The tooth that uses this ` +
              'fixture would go green for a pre-existing reason (a malformed canonical header ' +
              'or a dangling reference), not because the back-link check bit. Fix the fixture. ' +
              `output: ${excerpt(r.combined)}`,
          );
        }
      }
      if (!RATCHET_DIRS.includes(fixtureDir) && r.combined.indexOf('obsolete') !== -1) {
        failing.push(
          `TOOTH 0 (ratchet scope guard): fixture directory "${fixtureDir}" produced an ` +
            '"obsolete" ratchet diagnostic, but no KNOWN_BACKLINK_GAPS entry has BOTH ' +
            `endpoints present as files in that directory (only ${RATCHET_DIRS.join(' and ')} ` +
            'do). The ratchet is firing without the both-endpoints-present guard, which would ' +
            `green other teeth for the wrong reason. output: ${excerpt(r.combined)}`,
        );
      }
    });
  }

  // =========================================================================
  // TOOTH 1 — a forward back-link gap must be reported with its pair key.
  //
  // 0910 declares **Amends:** ADR-0911; 0911's **Amended-by:** is an em-dash.
  //
  // Kills: no forward check at all (today's scripts/adr-digest.mjs) — and any
  // implementation whose message omits the (X->Y) pair key, which is the only
  // machine-checkable handle a downstream gate has on WHICH pair broke.
  // =========================================================================
  withFixtureDir('t1-forward-gap', (r) => {
    const key = '(0910->0911)';
    const expected =
      '0910: **Amends:** ADR-0911 but ADR-0911 has no reciprocal ' +
      '**Amended-by:** ADR-0910 back-link (0910->0911)';
    if (r.combined.indexOf(key) === -1) {
      failing.push(
        `TOOTH 1 (forward gap): expected the output to name the pair key "${key}" but it did ` +
          `not (exit ${r.code}). 0910 declares **Amends:** ADR-0911 while 0911 carries no ` +
          'reciprocal **Amended-by:** — the forward back-link check has no bite. ' +
          `output: ${excerpt(r.combined)}`,
      );
    } else if (r.combined.indexOf(expected) === -1) {
      failing.push(
        `TOOTH 1 (forward gap): pair key "${key}" is present but the message does not match ` +
          `the contract.\n  expected substring: ${expected}\n  output: ${excerpt(r.combined)}`,
      );
    }
    if (r.code === 0) {
      failing.push(
        'TOOTH 1 (forward gap): the generator exited 0 on a directory containing a one-sided ' +
          'amendment — a back-link gap must be fatal, not advisory.',
      );
    }
  });

  // =========================================================================
  // TOOTH 2 — FALSE-POSITIVE GUARD: a fully reciprocal pair must be silent.
  //
  // 0912 **Amends:** ADR-0913; 0913 **Amended-by:** ADR-0912 (with a trailing
  // parenthetical gloss, the real corpus shape).
  //
  // Kills: the always-red cheat — "error on every **Amends:**" — which would
  // make TOOTH 1/4/6/7/15 pass without any reciprocity logic existing. Also
  // kills a resolveRelationIds that does not truncate a token at the first "(",
  // since that would resolve 0913's Amended-by to nothing and false-RED here.
  // =========================================================================
  withFixtureDir('t2-reciprocal-ok', (r) => {
    if (r.code !== 0) {
      failing.push(
        'TOOTH 2 (false-positive guard): a fully reciprocal pair (0912 **Amends:** ADR-0913, ' +
          '0913 **Amended-by:** ADR-0912 (…)) must exit 0, but the generator exited ' +
          `${r.code}. Either the check errors on every **Amends:** regardless of reciprocity, ` +
          'or resolveRelationIds fails to truncate the token at the first "(". ' +
          `output: ${excerpt(r.combined)}`,
      );
    }
    // stderr only: stdout carries the tmpdir path, whose random suffix must not
    // be allowed to decide this assertion.
    if (r.stderr.indexOf('0912') !== -1 || r.stderr.indexOf('0913') !== -1) {
      failing.push(
        'TOOTH 2 (false-positive guard): the generator mentioned 0912/0913 in its diagnostics ' +
          'even though the pair is reciprocal — a reciprocal pair must produce no back-link ' +
          `diagnostic at all. stderr: ${excerpt(r.stderr)}`,
      );
    }
  });

  // =========================================================================
  // TOOTH 3 — a back-link gap is an ERROR, never a downgraded WARN.
  //
  // Reuses t1-forward-gap. main() prefixes fatal issues with "adr-digest ERROR: "
  // (console.error + exit 1) and non-fatal ones with "adr-digest WARN: "
  // (console.warn, exit 0). Both go to stderr, so the exit code alone cannot
  // distinguish them; this tooth pins the PREFIX ON THE LINE that carries the
  // pair key.
  //
  // Kills: shipping the new check with level:'warn' — a gate that prints a
  // complaint and then passes CI, which is indistinguishable from no gate.
  // =========================================================================
  withFixtureDir('t1-forward-gap', (r) => {
    const key = '(0910->0911)';
    const keyLines = linesContaining(r.stderr, key);
    if (keyLines.length === 0) {
      failing.push(
        `TOOTH 3 (error not warn): expected stderr to carry a line naming "${key}" but found ` +
          `none (exit ${r.code}). stderr: ${excerpt(r.stderr)}`,
      );
    } else {
      const errorLines = keyLines.filter((l) => l.startsWith('adr-digest ERROR:'));
      const warnLines = keyLines.filter((l) => l.startsWith('adr-digest WARN:'));
      if (warnLines.length > 0) {
        failing.push(
          `TOOTH 3 (error not warn): the line naming "${key}" is prefixed "adr-digest WARN:" ` +
            '— the back-link gap has been downgraded to a non-fatal warning, so CI stays green ' +
            `while the corpus stays broken. line: ${warnLines[0].slice(0, 300)}`,
        );
      }
      if (errorLines.length === 0) {
        failing.push(
          `TOOTH 3 (error not warn): no stderr line naming "${key}" starts with the literal ` +
            '"adr-digest ERROR:" — the diagnostic is not being emitted through the fatal error ' +
            `channel in main(). stderr: ${excerpt(r.stderr)}`,
        );
      }
    }
    if (r.stderr.indexOf('adr-digest WARN:') !== -1) {
      failing.push(
        'TOOTH 3 (error not warn): stderr contains an "adr-digest WARN:" line for a directory ' +
          'of fully canonical fixture ADRs (LEGACY_TOLERANCE is empty). Any warning here means ' +
          'a back-link issue was classified as tolerated rather than fatal. ' +
          `stderr: ${excerpt(r.stderr)}`,
      );
    }
  });

  // =========================================================================
  // TOOTH 4 — a BARE, un-prefixed **Amends:** id must resolve.
  //
  // 0914 declares "**Amends:** 0915" with no ADR- prefix; 0915 does not answer.
  //
  // Kills: reusing extractAllAdrIds (scripts/adr-digest.mjs:282) for relation
  // resolution. It only recognises "ADR-NNNN"/"H-NNNN", so every bare-form
  // declaration in the real corpus — 0163's "**Amends:** 0151, 0162" among them
  // — would be invisible and its gaps unreportable.
  // =========================================================================
  withFixtureDir('t4-bare-ids', (r) => {
    const key = '(0914->0915)';
    if (r.combined.indexOf(key) === -1) {
      failing.push(
        `TOOTH 4 (bare id resolution): expected the pair key "${key}" but the output does not ` +
          `contain it (exit ${r.code}). 0914 declares "**Amends:** 0915" in the BARE form; a ` +
          'resolver that requires the ADR- prefix (i.e. extractAllAdrIds reused verbatim) sees ' +
          `no relation at all and the gap is silently invisible. output: ${excerpt(r.combined)}`,
      );
    }
    if (r.code === 0) {
      failing.push(
        'TOOTH 4 (bare id resolution): the generator exited 0 on a one-sided bare-form ' +
          'amendment — bare **Amends:** ids are not participating in the back-link check.',
      );
    }
  });

  // =========================================================================
  // TOOTH 5 — FALSE-POSITIVE GUARD: bare ids on BOTH sides are reciprocal.
  //
  // 0916 "**Amends:** 0917"; 0917 "**Amended-by:** 0916" — both bare.
  //
  // Kills: half-normalisation — normalising the **Amends:** side (to satisfy
  // TOOTH 4) while still demanding an ADR- prefix on the **Amended-by:** side.
  // That mutation reports genuinely reciprocal real pairs (0148/0158, 0162) as
  // broken, and a gate that cries wolf on the committed corpus gets deleted.
  // =========================================================================
  withFixtureDir('t5-bare-reciprocal', (r) => {
    if (r.code !== 0) {
      failing.push(
        'TOOTH 5 (bare reciprocal, false-positive guard): 0916 "**Amends:** 0917" and 0917 ' +
          '"**Amended-by:** 0916" are reciprocal in the bare form and must exit 0, but the ' +
          `generator exited ${r.code}. Id normalisation is applied to only one of the two ` +
          `relation fields. output: ${excerpt(r.combined)}`,
      );
    }
    // stderr only — see the note in TOOTH 2.
    if (r.stderr.indexOf('0916') !== -1 || r.stderr.indexOf('0917') !== -1) {
      failing.push(
        'TOOTH 5 (bare reciprocal, false-positive guard): the generator produced a diagnostic ' +
          `naming 0916/0917 although the pair is reciprocal. stderr: ${excerpt(r.stderr)}`,
      );
    }
  });

  // =========================================================================
  // TOOTH 6 — em-dash sentinel + a prose id is still a gap.
  //
  // 0919 **Amends:** ADR-0918; 0918 carries
  //   **Amended-by:** — (none yet; 0919 deferred the back-link)
  // which is the real corpus shape at docs/adr/0139-*.md:7.
  //
  // Kills TWO mutations at once:
  //   (a) detecting "no relation" by `value === '—'`. The value here is NOT
  //       exactly '—', so an equality test classifies this as a real back-link.
  //   (b) scraping every 4-digit run out of the field value. "0919" appears in
  //       the parenthetical prose, so a scraper concludes the back-link exists.
  // Both mutations make the gap vanish; the correct rule is "no relation ==
  // EMPTY RESOLVED LIST", with each token truncated at the first "(".
  // =========================================================================
  withFixtureDir('t6-em-dash-prose', (r) => {
    const key = '(0919->0918)';
    if (r.combined.indexOf(key) === -1) {
      failing.push(
        `TOOTH 6 (em-dash sentinel + prose id): expected the pair key "${key}" but the output ` +
          `does not contain it (exit ${r.code}). 0918's **Amended-by:** is ` +
          '"— (none yet; 0919 deferred the back-link)": either the em-dash sentinel was ' +
          'accepted as a back-link, or the id embedded in the parenthetical prose was ' +
          `mis-scraped as satisfying it. output: ${excerpt(r.combined)}`,
      );
    }
    if (r.code === 0) {
      failing.push(
        'TOOTH 6 (em-dash sentinel + prose id): the generator exited 0 — a deferred back-link ' +
          'documented in prose is still a missing back-link.',
      );
    }
  });

  // =========================================================================
  // TOOTH 7 — the REVERSE direction must be checked too.
  //
  // 0920 declares **Amended-by:** ADR-0921; 0921 declares no **Amends:** at all.
  // Nothing in 0920's **Amends:** field points anywhere, so a forward-only walk
  // never visits this pair.
  //
  // Kills: a forward-only implementation. The real corpus has exactly this
  // shape at 0075/0090, and a forward-only gate declares that corpus clean.
  // =========================================================================
  withFixtureDir('t7-reverse-gap', (r) => {
    const key = '(0920<-0921)';
    const expected =
      '0920: **Amended-by:** ADR-0921 but ADR-0921 has no reciprocal ' +
      '**Amends:** ADR-0920 declaration (0920<-0921)';
    if (r.combined.indexOf(key) === -1) {
      failing.push(
        `TOOTH 7 (reverse gap): expected the pair key "${key}" but the output does not contain ` +
          `it (exit ${r.code}). 0920 claims **Amended-by:** ADR-0921 while 0921 declares no ` +
          '**Amends:** — a forward-only implementation never walks outward from **Amended-by:** ' +
          `and reports nothing. output: ${excerpt(r.combined)}`,
      );
    } else if (r.combined.indexOf(expected) === -1) {
      failing.push(
        `TOOTH 7 (reverse gap): pair key "${key}" is present but the message does not match ` +
          `the contract.\n  expected substring: ${expected}\n  output: ${excerpt(r.combined)}`,
      );
    }
    if (r.code === 0) {
      failing.push(
        'TOOTH 7 (reverse gap): the generator exited 0 on an unreciprocated **Amended-by:** ' +
          'declaration — the reverse direction is not enforced.',
      );
    }
  });

  // =========================================================================
  // TOOTH 8 — RATCHET: an obsolete KNOWN_BACKLINK_GAPS entry is an ERROR.
  //
  // The fixture directory reproduces the REAL baseline pair 0168->0166 with the
  // gap CLOSED (0168 **Amends:** ADR-0166, 0166 **Amended-by:** ADR-0168). The
  // tolerance entry no longer describes reality and must be deleted; the gate
  // says so instead of quietly carrying dead debt forever.
  //
  // Kills: a baseline that never shrinks — a tolerance set that is only ever a
  // suppression list, so a fixed back-link leaves a permanent hole through
  // which a FUTURE regression on the same pair would pass unnoticed.
  //
  // TWO-WAY PIN: this tooth is pinned to baseline entry "0168->0166". If a
  // future slice fixes that real back-link and deletes the entry from
  // KNOWN_BACKLINK_GAPS, this tooth must be RE-PINNED to another surviving
  // entry. The reciprocal note lives beside KNOWN_BACKLINK_GAPS in
  // scripts/adr-digest.mjs; keep both halves in sync.
  //
  // (The fixture files deliberately reuse the real ids 0168/0166 — the ratchet
  // is keyed on that literal string, so no >=0900 stand-in can trigger it.)
  // =========================================================================
  withFixtureDir('t8-obsolete-baseline', (r) => {
    const key = '0168->0166';
    const expected =
      `KNOWN_BACKLINK_GAPS entry "${key}" is obsolete — the pair is now reciprocal; ` +
      'delete the entry (the set may only shrink)';
    const obsoleteLines = linesContaining(r.combined, 'obsolete');
    if (obsoleteLines.length === 0) {
      failing.push(
        'TOOTH 8 (ratchet): expected an "obsolete" diagnostic for the baseline entry ' +
          `"${key}" — in this directory the pair is reciprocal, so the tolerance entry is dead ` +
          `debt — but no output line contains "obsolete" (exit ${r.code}). The baseline can ` +
          `only grow. output: ${excerpt(r.combined)}`,
      );
    } else {
      if (r.combined.indexOf(key) === -1) {
        failing.push(
          `TOOTH 8 (ratchet): an "obsolete" diagnostic was emitted but it does not name the ` +
            `pair key "${key}" — the ratchet fired on some other entry, or the message gives no ` +
            `actionable handle on which entry to delete. output: ${excerpt(r.combined)}`,
        );
      }
      if (obsoleteLines.length !== 1) {
        failing.push(
          `TOOTH 8 (ratchet): expected exactly 1 "obsolete" line for this directory but got ` +
            `${obsoleteLines.length}. Only "${key}" has BOTH endpoints present as files here; ` +
            'the other four baseline entries must be skipped, not reported. ' +
            `output: ${excerpt(r.combined)}`,
        );
      }
      if (r.combined.indexOf(expected) === -1) {
        failing.push(
          'TOOTH 8 (ratchet): the obsolete diagnostic does not match the contract.\n' +
            `  expected substring: ${expected}\n  output: ${excerpt(r.combined)}`,
        );
      }
    }
    if (r.code === 0) {
      failing.push(
        'TOOTH 8 (ratchet): the generator exited 0 with an obsolete baseline entry in play — ' +
          'the ratchet must be fatal, otherwise the tolerance set is never pruned.',
      );
    }
  });

  // =========================================================================
  // TOOTH 10 — the tolerance set is PAIR-keyed, not SOURCE-keyed.
  //
  // 0166 is the source side of the real baseline entry "0166->0156". Here it
  // declares a BRAND-NEW amendment (**Amends:** ADR-0955) that no baseline entry
  // covers, and 0955 does not answer. 0156 is deliberately absent from the
  // directory, so no baseline entry has both endpoints present and the ratchet
  // must stay silent (TOOTH 0 enforces that separately).
  //
  // Kills: a tolerance test written as KNOWN_BACKLINK_GAPS.has(adr.id) (or any
  // source-only membership test). That blanket-exempts every present and future
  // declaration made by a baselined source id — including 0174 and 0176, this
  // slice's own ADRs — turning five tolerated pairs into an open-ended amnesty.
  //
  // The assertion is on the SPECIFIC key "(0166->0955)": a loose "exit non-zero"
  // or "output mentions 0166" test would be satisfied by an unrelated ratchet
  // error and green this tooth for the wrong reason.
  // =========================================================================
  withFixtureDir('t10-source-keyed-baseline', (r) => {
    const key = '(0166->0955)';
    if (r.combined.indexOf(key) === -1) {
      failing.push(
        `TOOTH 10 (pair-keyed tolerance): expected the SPECIFIC pair key "${key}" but the ` +
          `output does not contain it (exit ${r.code}). 0166 is the source side of the ` +
          'baseline entry "0166->0156", but this amendment is a different, un-baselined pair. ' +
          'A source-keyed tolerance test (KNOWN_BACKLINK_GAPS.has(adr.id)) exempts it and every ' +
          `other future declaration by a baselined source. output: ${excerpt(r.combined)}`,
      );
    }
    if (r.code === 0) {
      failing.push(
        'TOOTH 10 (pair-keyed tolerance): the generator exited 0 — an un-baselined gap declared ' +
          'by a baselined source id was swallowed by the tolerance set.',
      );
    }
  });

  // =========================================================================
  // TOOTH 15 — a fenced back-link in a doc with NO level-two heading is not a
  // back-link.
  //
  // 0930 **Amends:** ADR-0931. 0931 uses only level-three subheads, so
  // headerPreamble (scripts/adr-digest.mjs:65, which splits on a newline
  // followed by a level-two heading marker) treats the ENTIRE document as the
  // header block — and 0931's only "**Amended-by:** ADR-0930" sits inside a
  // fenced code block as illustrative template text.
  //
  // Kills: resolving the back-link off headerPreamble as it stands today. Under
  // that hole the fenced line reads as a genuine header field, the pair looks
  // reciprocal, and the gate reports nothing. This is the same bypass shape that
  // TOOTH 8 of evals/adr-digest.eval.mjs guards for **Status:**; the back-link
  // check must not reintroduce it.
  // =========================================================================
  withFixtureDir('t15-no-h2-heading', (r) => {
    const key = '(0930->0931)';
    if (r.combined.indexOf(key) === -1) {
      failing.push(
        `TOOTH 15 (fenced back-link bypass): expected the pair key "${key}" but the output does ` +
          `not contain it (exit ${r.code}). 0931 has no level-two heading, so headerPreamble ` +
          'returns the whole document and the "**Amended-by:** ADR-0930" inside its fenced code ' +
          'block is being read as a real header field — a body-embedded, purely illustrative ' +
          `line is satisfying the reciprocity requirement. output: ${excerpt(r.combined)}`,
      );
    }
    if (r.code === 0) {
      failing.push(
        'TOOTH 15 (fenced back-link bypass): the generator exited 0 — a code-fenced ' +
          '**Amended-by:** line counted as a back-link.',
      );
    }
  });

  // =========================================================================
  // TOOTH 16a — ERA THRESHOLD, tolerate side: a pair with BOTH endpoints below
  // BACKLINK_ERA_MIN = '0151' must be silent.
  //
  // 0120 **Amends:** ADR-0121; 0121 answers with an em-dash. In every respect
  // except era this is TOOTH 1's fixture, so the ONLY thing that can keep the
  // generator quiet here is the era clause.
  //
  // Kills: an implementation with NO era clause at all. Every other fixture id
  // in this file is >= '0151', so before this tooth existed an era-less
  // implementation passed the whole file. It was caught only indirectly, by the
  // sibling evals/adr-backlink-corpus.eval.mjs going red on the real corpus's
  // 47 out-of-era gaps — a corpus-wide failure that gives no local diagnostic
  // and would push someone toward ~37 out-of-scope ADR edits to "fix" it.
  //
  // TWO-WAY PIN ON THE THRESHOLD VALUE: this tooth pins '0151' from below —
  // lowering the threshold past 0120 makes it red. The sibling eval's TOOTH 12
  // pins it from above: raising the threshold above '0151' exempts the real
  // pair 0163->0151 and TOOTH 12 goes red. Together the two files pin
  // BACKLINK_ERA_MIN to exactly '0151'.
  //
  // Ids 0120/0121 are deliberate: both sort below '0151' (ids are 4-char
  // zero-padded, so string compare == numeric compare) and NEITHER is an
  // endpoint of any baseline entry — the five baselined pairs are 0166->0156,
  // 0168->0166, 0169->0154, 0172->0157 and 0177->0173 — so nothing collides and
  // the ratchet stays quiet.
  // =========================================================================
  withFixtureDir('t16a-below-era', (r) => {
    if (r.code !== 0) {
      failing.push(
        'TOOTH 16a (era threshold, tolerate): 0120 **Amends:** ADR-0121 with no reciprocal ' +
          "back-link, but BOTH endpoints sort below BACKLINK_ERA_MIN = '0151', so the pair " +
          `must be tolerated and the generator must exit 0 — it exited ${r.code}. The era ` +
          'clause is missing (or its threshold has been lowered past 0120), which makes the ' +
          'real corpus red on 47 pre-existing out-of-era gaps. ' +
          `output: ${excerpt(r.combined)}`,
      );
    }
    // stderr only: stdout carries the tmpdir path, whose random suffix must not
    // be allowed to decide this assertion (see TOOTH 2).
    if (r.stderr.indexOf('0120') !== -1 || r.stderr.indexOf('0121') !== -1) {
      failing.push(
        'TOOTH 16a (era threshold, tolerate): the generator named 0120/0121 in its diagnostics ' +
          'even though both endpoints are below the era threshold — a below-era pair must ' +
          `produce no back-link diagnostic at all. stderr: ${excerpt(r.stderr)}`,
      );
    }
  });

  // =========================================================================
  // TOOTH 16b — ERA THRESHOLD, both-endpoints rule: a MIXED pair must also be
  // tolerated.
  //
  // 0955 **Amends:** ADR-0120 with no reciprocal back-link. The SOURCE is
  // in-era ('0955' >= '0151'); the TARGET is not ('0120' < '0151'). The
  // specified rule enforces a pair only when BOTH endpoints are >= the
  // threshold, so this pair is tolerated.
  //
  // Kills: a SOURCE-ONLY era test (`source >= ERA`) written in place of the
  // both-endpoints test. TOOTH 16a cannot catch that mutation — under a
  // source-only test 0120->0121 is still exempt, because its source is also
  // below the era. This is the exact measurement error that nearly sank the
  // design: a source-only threshold demands back-links on ~25 pre-0151 ADRs
  // that are all outside this slice's `touches:`, so the gate cannot go green
  // without out-of-scope edits.
  //
  // The mirror-image mutation (`target >= ERA` only) is caught here too: 0120
  // is the target, so a target-only test exempts this pair but a source-only
  // one reports it; only the AND of the two is silent here AND red on the real
  // corpus's in-era gaps (sibling eval TOOTH 9).
  //
  // 0955 is an ordinary >= 0900 fixture id; 0120 is a real-range id because no
  // id >= 0900 can sort below the era. Neither is a baseline endpoint, so the
  // ratchet stays quiet (TOOTH 0 enforces that).
  // =========================================================================
  withFixtureDir('t16b-mixed-era', (r) => {
    if (r.code !== 0) {
      failing.push(
        'TOOTH 16b (mixed-era pair, both-endpoints rule): 0955 **Amends:** ADR-0120 with no ' +
          'reciprocal back-link. The source is in-era but the target (0120) is below ' +
          "BACKLINK_ERA_MIN = '0151', and the rule enforces a pair only when BOTH endpoints " +
          `are in-era — so this must exit 0, but the generator exited ${r.code}. The era test ` +
          'is being applied to the source id alone, which would demand back-links on ~25 ' +
          `pre-0151 ADRs outside this slice's scope. output: ${excerpt(r.combined)}`,
      );
    }
    // stderr only — see the note in TOOTH 2.
    if (r.stderr.indexOf('0955') !== -1 || r.stderr.indexOf('0120') !== -1) {
      failing.push(
        'TOOTH 16b (mixed-era pair, both-endpoints rule): the generator named 0955/0120 in its ' +
          'diagnostics although the pair straddles the era threshold and must be tolerated. ' +
          `stderr: ${excerpt(r.stderr)}`,
      );
    }
  });

  // =========================================================================
  // TOOTH 17 — RATCHET, SECOND BRANCH: the DECLARATION is gone.
  //
  // A baseline entry is obsolete when its violation no longer holds. TOOTH 8
  // covers only one way for that to happen (the pair became reciprocal). The
  // other — and by far the more common one in practice — is that the amendment
  // declaration itself was removed when an ADR was rewritten.
  //
  // The fixture reproduces the REAL baseline pair 0169->0154 with the
  // declaration DELETED: 0169 carries **Amends:** — (it amends nothing at all)
  // and 0154 is present as a file with **Amended-by:** —. Both endpoints are
  // present, so the ratchet's precondition is met; the violation 0169->0154 no
  // longer holds because there is no declaration to violate. The pair is NOT
  // reciprocal — so a ratchet implemented as "is this pair reciprocal now?"
  // sees nothing and keeps the entry alive.
  //
  // Kills: exactly that reciprocity-only ratchet. Under it the tolerance set
  // stops shrinking for the most common real reason, and each stale entry is a
  // permanent hole through which a FUTURE regression on the same pair passes
  // unnoticed. The correct rule is "the recorded violation is not among the
  // violations found this run".
  //
  // TWO-WAY PIN: this tooth is pinned to baseline entry "0169->0154". If a
  // future slice fixes that real back-link and deletes the entry from
  // KNOWN_BACKLINK_GAPS, this tooth must be RE-PINNED to another surviving
  // entry. The reciprocal note lives beside KNOWN_BACKLINK_GAPS in
  // scripts/adr-digest.mjs; keep both halves in sync. (TOOTH 8 is pinned to
  // "0168->0166" — a different entry, deliberately.)
  //
  // COLLISION: this directory contains only 0169 and 0154, and "0169->0154" is
  // the sole baseline entry with both endpoints present here (0166->0156,
  // 0168->0166, 0172->0157 and 0177->0173 have neither). So exactly one
  // obsolete line may fire, and the "exactly 1" assertion below cannot be
  // satisfied by a different entry. See the audit at RATCHET_DIRS.
  //
  // The message assertion pins the opener and the actionable closer, not the
  // middle reason clause: the spec states one obsolete template and it names
  // the reciprocal branch, so a distinct reason phrase for this branch is a
  // legitimate implementation choice. See the contract note at the top.
  // =========================================================================
  withFixtureDir('t17-ratchet-declaration-gone', (r) => {
    const key = '0169->0154';
    const opener = `KNOWN_BACKLINK_GAPS entry "${key}" is obsolete`;
    const closer = 'delete the entry (the set may only shrink)';
    const obsoleteLines = linesContaining(r.combined, 'obsolete');
    if (obsoleteLines.length === 0) {
      failing.push(
        'TOOTH 17 (ratchet, declaration gone): expected an "obsolete" diagnostic for the ' +
          `baseline entry "${key}". In this directory 0169 declares **Amends:** — (the ` +
          'amendment is gone) while 0154 is still present, so the recorded violation cannot ' +
          `hold and the entry is dead debt — but no output line contains "obsolete" ` +
          `(exit ${r.code}). The ratchet only asks whether the pair became reciprocal, so an ` +
          'entry survives forever once its declaration is removed. ' +
          `output: ${excerpt(r.combined)}`,
      );
    } else {
      if (r.combined.indexOf(key) === -1) {
        failing.push(
          'TOOTH 17 (ratchet, declaration gone): an "obsolete" diagnostic was emitted but it ' +
            `does not name the pair key "${key}" — the ratchet fired on some other entry, or ` +
            'the message gives no actionable handle on which entry to delete. ' +
            `output: ${excerpt(r.combined)}`,
        );
      }
      if (obsoleteLines.length !== 1) {
        failing.push(
          'TOOTH 17 (ratchet, declaration gone): expected exactly 1 "obsolete" line for this ' +
            `directory but got ${obsoleteLines.length}. Only "${key}" has BOTH endpoints ` +
            'present as files here; the other four baseline entries have neither endpoint ' +
            `present and must be skipped, not reported. output: ${excerpt(r.combined)}`,
        );
      }
      if (r.combined.indexOf(opener) === -1) {
        failing.push(
          'TOOTH 17 (ratchet, declaration gone): the obsolete diagnostic does not match the ' +
            `contract opener.\n  expected substring: ${opener}\n  output: ${excerpt(r.combined)}`,
        );
      }
      if (r.combined.indexOf(closer) === -1) {
        failing.push(
          'TOOTH 17 (ratchet, declaration gone): the obsolete diagnostic omits the actionable ' +
            `closer, so it does not tell the reader what to do.\n  expected substring: ${closer}` +
            `\n  output: ${excerpt(r.combined)}`,
        );
      }
    }
    if (r.code === 0) {
      failing.push(
        'TOOTH 17 (ratchet, declaration gone): the generator exited 0 with a baseline entry ' +
          'whose amendment declaration no longer exists — the ratchet must be fatal, otherwise ' +
          'the tolerance set is never pruned when an ADR is rewritten.',
      );
    }
  });

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
    detail: '14/14 teeth bite correctly (T0, T1–T8, T10, T15, T16a, T16b, T17)',
  };
}
