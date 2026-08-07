// adr-backlink-integrity.eval.mjs — 12r-f: bidirectional ADR back-link teeth.
//
// Gates the NEW corpus-level back-link check inside scripts/adr-digest.mjs:
//
//   RESOLVE  a relation field is comma-split; each token is truncated at the
//            first "(", trimmed, skipped when it starts with "H-", stripped of a
//            leading "ADR-", and then contributes its LEADING exactly-4-digit
//            run provided the character after that run is a non-digit or the end
//            of the token; the id must be a FILE in the scanned directory; the
//            result is deduped. So `ADR-0118 §3/A3 (…)` resolves to `0118`.
//   FORWARD  for each ADR X and each id Y resolved from X's **Amends:**,
//            Y's **Amended-by:** must resolve X.
//   REVERSE  for each ADR Y and each id X resolved from Y's **Amended-by:**,
//            X's **Amends:** must resolve Y.
//   ERA      a pair is enforced only when BOTH endpoints are >= '0151'.
//   TOLERATE a violation whose pair key is in KNOWN_BACKLINK_GAPS is silent.
//   RATCHET  a baseline entry whose two endpoints are both present as files and
//            whose violation no longer holds is an ERROR (the set may only shrink).
//   SUMMARY  a single WARN summary is emitted ONLY when N > 0 || M > 0, where N
//            is the number of violations found THIS RUN that a
//            KNOWN_BACKLINK_GAPS entry suppressed (NOT the size of the set) and
//            M is the number of below-era one-directional gaps found this run.
//            Below-era pairs are NEVER named individually — they are only
//            counted into M (TOOTH 16a/16b/16c depend on that).
//
// Exact message contract these teeth assert against (main() prefixes errors with
// "adr-digest ERROR: " and warnings with "adr-digest WARN: "):
//
//   forward:  `${X}: **Amends:** ADR-${Y} but ADR-${Y} has no reciprocal
//              **Amended-by:** ADR-${X} back-link (${X}->${Y})`
//   reverse:  `${Y}: **Amended-by:** ADR-${X} but ADR-${X} has no reciprocal
//              **Amends:** ADR-${Y} declaration (${Y}<-${X})`
//   obsolete: `KNOWN_BACKLINK_GAPS entry "${key}" is obsolete — ${reason};
//              delete the entry (the set may only shrink)`
//              where ${reason} is exactly one of the two specified clauses:
//                `the pair is now reciprocal`        (TOOTH 8, entry 0168->0166)
//                `the amendment declaration is gone` (TOOTH 8, entry 0172->0157;
//                                                     TOOTH 17, entry 0169->0154)
//
// Both back-link messages contain the word `reciprocal` and every obsolete
// message contains the word `obsolete`. TOOTH 0 uses exactly that as an
// ALLOWLIST: an `adr-digest ERROR:` line carrying neither word is, by
// definition, some OTHER rule firing on a fixture — which would green a tooth
// for a reason that has nothing to do with back-links.
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
//   TOOTH 8  ratchet: TWO simultaneously-obsolete baseline entries are ERRORs,
//            one per reason clause      (0168->0166 and 0172->0157).
//   TOOTH 10 the tolerance set is PAIR-keyed, not SOURCE-keyed (0166->0955).
//   TOOTH 15 a fenced back-link in a doc with no level-two heading is not a back-link.
//   TOOTH 16a a pair with BOTH endpoints below the era is tolerated (0120->0121).
//   TOOTH 16b a MIXED-era pair (target below the era) is tolerated (0955->0120).
//   TOOTH 16c the fourth quadrant: below-era SOURCE, in-era target (0120->0956).
//   TOOTH 17 ratchet, second branch: the declaration is gone     (0169->0154).
//   TOOTH 18 the tolerance set is PAIR-keyed, not TARGET-keyed   (0956->0156).
//   TOOTH 19 the §-annotated + multi-reference form resolves (0940->0941, 0940->0944).
//   TOOTH 20 relations resolve against SCANNED FILES, not allIds (0942, 0943).
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
  't16c-below-era-source',
  't17-ratchet-declaration-gone',
  't18-target-keyed-baseline',
  't19-section-annotated',
  't20-harness-ref',
];

// The ONLY fixture directories in which the ratchet is allowed to fire. Every
// other directory is missing at least one endpoint of every baseline entry.
//
// COLLISION AUDIT. The five KNOWN_BACKLINK_GAPS entries are 0166->0156,
// 0168->0166, 0169->0154, 0172->0157 and 0177->0173. An entry can produce an
// obsolete line only when BOTH of its endpoints are present as files.
//
//   t8-obsolete-baseline         contains {0166, 0168, 0157, 0172}.
//     0166->0156 — 0156 absent          => skipped.
//     0168->0166 — both present         => CANDIDATE (reciprocal branch).
//     0169->0154 — neither present      => skipped.
//     0172->0157 — both present         => CANDIDATE (declaration-gone branch).
//     0177->0173 — neither present      => skipped.
//     => exactly 2 candidates, one per reason clause. TOOTH 8 asserts exactly 2
//        obsolete lines and names both keys, so a ratchet loop that breaks after
//        the first hit, or that only ever inspects a slice of the set, is dead.
//   t17-ratchet-declaration-gone contains {0169, 0154}.
//     0166->0156, 0168->0166, 0172->0157 and 0177->0173 have NEITHER endpoint.
//     Only 0169->0154 has both. => exactly 1 candidate.
//
// The two directories therefore fire on DIFFERENT entries and neither tooth's
// exact-count assertion can be accidentally satisfied by a stray other entry.
//
// Every other fixture directory is audited beside its own tooth. The ones that
// reuse real-range ids at all are:
//   t10  {0166, 0955} — 0166 is a baseline SOURCE; its partner 0156 is absent.
//   t18  {0956, 0156} — 0156 is a baseline TARGET; its partner 0166 is absent.
//   t16a {0120, 0121}, t16b {0955, 0120}, t16c {0120, 0956} — 0120 and 0121 are
//        endpoints of no baseline entry at all.
// In none of them does any entry have both endpoints, so the ratchet must stay
// silent there and TOOTH 0's scope guard says so.
const RATCHET_DIRS = ['t8-obsolete-baseline', 't17-ratchet-declaration-gone'];

// ---------------------------------------------------------------------------
// Helper: run scripts/adr-digest.mjs with the given args; return { code, stderr, stdout }.
// spawnSync captures the exit code as data rather than throwing, so each tooth
// can inspect the code independently.
// ---------------------------------------------------------------------------
function runDigest(args) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
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

/**
 * The full contracted ratchet message for one baseline entry.
 * `reason` is one of the two specified clauses:
 *   'the pair is now reciprocal' | 'the amendment declaration is gone'
 *
 * TOOTH 8 and TOOTH 17 each check the bare pair key BEFORE checking this full
 * message. That key check has no independent bite — it is strictly subsumed by
 * the full-message check — and is kept only because "the ratchet fired on some
 * other entry" is a far more useful failure line than a 200-character substring
 * diff. Do not count it as a separate assertion.
 */
function obsoleteMessage(key, reason) {
  return (
    `KNOWN_BACKLINK_GAPS entry "${key}" is obsolete — ${reason}; ` +
    'delete the entry (the set may only shrink)'
  );
}

// Appended to the failure messages of the RATCHET teeth (8 and 17). Both are
// pinned to SPECIFIC real KNOWN_BACKLINK_GAPS entries, so there are two very
// different reasons they can go red and the CI-log reader must not be sent
// chasing the wrong one. Living in a source comment is not good enough: the
// person reading the failure only ever sees this string.
const RATCHET_REPIN_NOTE =
  'IF THIS FAILED BECAUSE THE BASELINE LEGITIMATELY SHRANK — i.e. a later slice repaired that ' +
  'real back-link and correctly deleted the entry from KNOWN_BACKLINK_GAPS — then there is NO ' +
  'implementation bug here and "the baseline can only grow" is the wrong diagnosis. The fix is ' +
  'to RE-PIN: point this tooth, its fixture directory (the fixture ids ARE the baseline key) ' +
  'and the collision audit beside RATCHET_DIRS at a surviving entry. If the baseline ever ' +
  'shrinks below TWO entries whose both endpoints can be pinned, retire one of TOOTH 8 / ' +
  'TOOTH 17 outright rather than weakening either.';

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
  // This is expressed as an ALLOWLIST, not a denylist. A hard-coded list of
  // foreign-error substrings is unsound twice over: it missed the existing
  // "Status is Superseded but missing a real **Superseded-by:** pointer" rule
  // (a fixture set to Status: Superseded with an em-dash pointer produced a
  // foreign error while this eval stayed fully PASS), and by construction it
  // misses every validateAdr rule added after today. The invariant is stated
  // directly instead: every back-link message contains `reciprocal` and every
  // ratchet message contains `obsolete`, so an "adr-digest ERROR:" line
  // containing neither word is foreign, whatever it says.
  //
  // Second half: the ratchet may fire ONLY in the RATCHET_DIRS. Every other
  // fixture directory is deliberately missing at least one endpoint of every
  // KNOWN_BACKLINK_GAPS entry, so an "obsolete" line anywhere else means the
  // implementation skipped the "both endpoints present as files" guard — which
  // would also let an unrelated ratchet error green TOOTH 10 and TOOTH 18 (both
  // of which reuse a real baselined id on ONE side only), and would fire
  // spuriously in t16a/t16b/t16c (whose ids 0120/0121/0955/0956 are baseline
  // endpoints of nothing at all).
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
      const errorLines = r.combined.split('\n').filter((l) => l.startsWith('adr-digest ERROR:'));
      const foreign = errorLines.filter(
        (l) => l.indexOf('reciprocal') === -1 && l.indexOf('obsolete') === -1,
      );
      if (foreign.length > 0) {
        failing.push(
          `TOOTH 0 (red-proof self-check): fixture directory "${fixtureDir}" produced ` +
            `${foreign.length} NON-back-link error line(s) — an "adr-digest ERROR:" that ` +
            'mentions neither "reciprocal" (the two back-link messages) nor "obsolete" (the ' +
            'ratchet message). The tooth that uses this fixture would go green for a ' +
            'pre-existing reason (a malformed canonical header, a dangling reference, a ' +
            'Superseded status with no pointer, or any validateAdr rule added since). Fix the ' +
            `fixture.\n  first foreign line: ${foreign[0].slice(0, 300)}`,
        );
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
    // Narrowed to BACK-LINK-related warnings. A blanket "no adr-digest WARN: at
    // all" ban would be over-constrained: the WARN summary is contractually
    // emitted whenever N > 0 || M > 0, and a future, unrelated advisory rule
    // must not be able to red this tooth. In t1-forward-gap N = M = 0 (the one
    // violation is in-era and un-baselined), so no summary is due here anyway —
    // what this ban is really for is a back-link gap re-routed to console.warn.
    const backlinkWarns = r.stderr
      .split('\n')
      .filter((l) => l.startsWith('adr-digest WARN:'))
      .filter((l) => l.indexOf('reciprocal') !== -1 || l.indexOf(key) !== -1);
    if (backlinkWarns.length > 0) {
      failing.push(
        'TOOTH 3 (error not warn): stderr contains a back-link-related "adr-digest WARN:" line ' +
          `for a directory of fully canonical fixture ADRs whose only issue is the ${key} gap. ` +
          'A back-link issue has been classified as tolerated/advisory rather than fatal, so CI ' +
          `stays green while the corpus stays broken. line: ${backlinkWarns[0].slice(0, 300)}`,
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
  // TOOTH 8 — RATCHET: TWO simultaneously-obsolete baseline entries, one per
  // reason clause, both reported in the SAME run.
  //
  // The fixture directory makes two REAL baseline entries dead at once:
  //   0168->0166  the gap is CLOSED (0168 **Amends:** ADR-0166 and 0166
  //               **Amended-by:** ADR-0168) => reason "the pair is now reciprocal".
  //   0172->0157  the DECLARATION is gone (0172 **Amends:** —, with 0157 present
  //               as a file) => reason "the amendment declaration is gone".
  //
  // Kills FOUR mutations:
  //   (a) a baseline that never shrinks — a tolerance set that is only ever a
  //       suppression list, so a fixed back-link leaves a permanent hole through
  //       which a FUTURE regression on the same pair would pass unnoticed.
  //   (b) `for (const key of [...KNOWN_BACKLINK_GAPS].slice(0, 3))` and every
  //       other partial iteration of the set. Before this directory carried two
  //       obsolete entries, a ratchet that inspected a slice of the baseline
  //       passed the whole file: 0168->0166 and 0169->0154 both sit in the head
  //       of the set, so 0172->0157 and 0177->0173 had ZERO ratchet coverage.
  //   (c) `... break;` after the first obsolete entry — with two due in one
  //       directory, an early break yields 1 line and the exact-count assertion
  //       bites. (An "at least 1" assertion would not.)
  //   (d) a single hard-coded reason clause. Both clauses are pinned HERE, in
  //       one directory, one run — so an implementation cannot satisfy the two
  //       by drifting between directories.
  //
  // TWO-WAY PIN: pinned to baseline entries "0168->0166" and "0172->0157". If a
  // future slice repairs either real back-link and deletes its entry, RE-PIN
  // (see RATCHET_REPIN_NOTE, which is also appended to the failure messages so
  // the CI-log reader sees it). The reciprocal note lives beside
  // KNOWN_BACKLINK_GAPS in scripts/adr-digest.mjs; keep both halves in sync.
  //
  // (The fixture files deliberately reuse the real ids 0168/0166/0172/0157 —
  // the ratchet is keyed on those literal strings, so no >=0900 stand-in can
  // trigger it.)
  //
  // COLLISION: see the audit beside RATCHET_DIRS. Exactly two of the five
  // baseline entries have both endpoints present here; 0156, 0169, 0154, 0177
  // and 0173 are all absent, so no third entry can fire.
  // =========================================================================
  withFixtureDir('t8-obsolete-baseline', (r) => {
    const branches = [
      { key: '0168->0166', reason: 'the pair is now reciprocal' },
      { key: '0172->0157', reason: 'the amendment declaration is gone' },
    ];
    const obsoleteLines = linesContaining(r.combined, 'obsolete');
    if (obsoleteLines.length === 0) {
      failing.push(
        'TOOTH 8 (ratchet): expected TWO "obsolete" diagnostics — for baseline entries ' +
          '"0168->0166" (the pair is reciprocal in this directory) and "0172->0157" (the ' +
          'declaration is gone) — but no output line contains "obsolete" at all ' +
          `(exit ${r.code}). Either the ratchet does not exist, or the baseline can only ` +
          `grow.\n  ${RATCHET_REPIN_NOTE}\n  output: ${excerpt(r.combined)}`,
      );
    } else {
      if (obsoleteLines.length !== 2) {
        failing.push(
          'TOOTH 8 (ratchet): expected exactly 2 "obsolete" lines for this directory but got ' +
            `${obsoleteLines.length}. Exactly two baseline entries have BOTH endpoints present ` +
            'as files here (0168->0166 and 0172->0157); the other three must be skipped, not ' +
            'reported. One line means the ratchet loop breaks after its first hit or only ' +
            'inspects part of the set; three or more means the both-endpoints-present guard ' +
            `is missing.\n  ${RATCHET_REPIN_NOTE}\n  output: ${excerpt(r.combined)}`,
        );
      }
      for (const { key, reason } of branches) {
        const expected = obsoleteMessage(key, reason);
        if (r.combined.indexOf(key) === -1) {
          failing.push(
            'TOOTH 8 (ratchet): an "obsolete" diagnostic was emitted but nothing names the pair ' +
              `key "${key}" — that entry's recorded violation no longer holds (${reason}), so ` +
              'it is dead debt too. Either the ratchet stopped early, or the message gives no ' +
              `actionable handle on which entry to delete.\n  ${RATCHET_REPIN_NOTE}\n` +
              `  output: ${excerpt(r.combined)}`,
          );
        } else if (r.combined.indexOf(expected) === -1) {
          failing.push(
            `TOOTH 8 (ratchet): the obsolete diagnostic for "${key}" does not match the ` +
              'contract. Each branch has its own specified reason clause and they must not be ' +
              `interchanged.\n  expected substring: ${expected}\n  output: ${excerpt(r.combined)}`,
          );
        }
      }
    }
    if (r.code === 0) {
      failing.push(
        'TOOTH 8 (ratchet): the generator exited 0 with two obsolete baseline entries in play — ' +
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
  // TOOTH 18 — the tolerance set is PAIR-keyed, not TARGET-keyed.
  //
  // The exact MIRROR of TOOTH 10, and it needs its own fixture: TOOTH 10 kills
  // only the SOURCE-keyed cheat. The target-keyed one is a one-liner
  //
  //   const BL_TARGETS = new Set([...KNOWN_BACKLINK_GAPS].map((k) => k.slice(6)));
  //   if (BL_TARGETS.has(v.b)) { tolerated++; continue; }
  //
  // that greens the real corpus and, before this tooth existed, passed every
  // other tooth in this file and in the sibling corpus eval. It permanently
  // exempts every present AND FUTURE amendment of 0154, 0156, 0157, 0166 and
  // 0173 — the five baselined targets — which are exactly the ADRs most likely
  // to be amended again.
  //
  // Fixture: 0956 (an ordinary >= 0900 id) declares **Amends:** ADR-0156 and
  // 0156 answers with an em-dash. Both endpoints are in-era; the pair
  // "0956->0156" is NOT in the baseline, so it must be reported.
  //
  // COLLISION: the directory contains only {0956, 0156}. 0166 is deliberately
  // ABSENT — with it present, baseline entry 0166->0156 would have both
  // endpoints as files, the ratchet's precondition would be met, and a stray
  // "obsolete" error could green this tooth for an unrelated reason. As built,
  // no baseline entry has both endpoints here (0166->0156 lacks 0166;
  // 0168->0166, 0169->0154, 0172->0157 and 0177->0173 have neither), so the
  // ratchet must stay silent — TOOTH 0's scope guard enforces that.
  //
  // The assertion is on the SPECIFIC key "(0956->0156)" for the same reason as
  // in TOOTH 10: a bare non-zero exit would be satisfied by any other error.
  // =========================================================================
  withFixtureDir('t18-target-keyed-baseline', (r) => {
    const key = '(0956->0156)';
    if (r.combined.indexOf(key) === -1) {
      failing.push(
        `TOOTH 18 (pair-keyed tolerance, target mirror): expected the SPECIFIC pair key "${key}" ` +
          `but the output does not contain it (exit ${r.code}). 0156 is the TARGET side of the ` +
          'baseline entry "0166->0156", but this is a different, un-baselined pair. A ' +
          'target-keyed tolerance test — BL_TARGETS.has(v.b), where BL_TARGETS is the set of ' +
          'baseline targets — exempts it, and with it every future amendment of 0154/0156/0157/' +
          `0166/0173. The tolerance must be keyed on the PAIR. output: ${excerpt(r.combined)}`,
      );
    }
    if (r.code === 0) {
      failing.push(
        'TOOTH 18 (pair-keyed tolerance, target mirror): the generator exited 0 — an ' +
          'un-baselined gap whose TARGET happens to appear in the baseline was swallowed by the ' +
          'tolerance set.',
      );
    }
  });

  // =========================================================================
  // TOOTH 19 — the §-ANNOTATED reference form, and multi-reference ordering.
  //
  // This is the corpus's DOMINANT annotated shape: 0105, 0109, 0111-0117, 0119,
  // 0123, 0127, 0136, 0137, 0147 and 0149 all write their relations as
  // `ADR-NNNN §X (gloss)`. Under a STRICT resolver ("after stripping ADR-, the
  // token must be exactly four digits") every one of those references resolves
  // to nothing and the pair is SILENTLY UNENFORCED — the gate would look green
  // on the corpus while covering only its plainest references.
  //
  // The contracted resolver is laxer: comma-split, truncate each token at the
  // first "(", trim, skip H-*, strip a leading "ADR-", then take the LEADING
  // exactly-4-digit run provided the next character is a non-digit or the end of
  // the token. (Verified against the real corpus: strict vs lax changes nothing
  // there — in-era gaps stay at the 5 baselined, below-era stays at 44 — so the
  // laxness is free extra bite, not a loosening.)
  //
  // Fixture 0940 carries
  //   **Amends:** ADR-0941 §D2 (widens the guard, per the weekly review), ADR-0944 §B1
  // and neither 0941 nor 0944 answers, so BOTH pairs are gaps.
  //
  // Kills TWO mutations:
  //   (a) the strict four-digits-only resolver — "0941 §D2" resolves to nothing
  //       and (0940->0941) never appears.
  //   (b) truncate-the-whole-value-at-"(" BEFORE the comma split. That keeps
  //       only "ADR-0941 §D2 " and drops ADR-0944 entirely, because the comma
  //       separating the two references sits INSIDE the parenthetical gloss.
  //       Asserting both keys is what pins the split-then-truncate ordering;
  //       asserting only (0940->0941) would not.
  // =========================================================================
  withFixtureDir('t19-section-annotated', (r) => {
    const first = '(0940->0941)';
    const second = '(0940->0944)';
    if (r.combined.indexOf(first) === -1) {
      failing.push(
        `TOOTH 19 (§-annotated reference): expected the pair key "${first}" but the output does ` +
          `not contain it (exit ${r.code}). 0940 declares "**Amends:** ADR-0941 §D2 (widens the ` +
          'guard, per the weekly review), ADR-0944 §B1" — the corpus\'s dominant annotated ' +
          'house form. A resolver that demands the token be exactly four digits after stripping ' +
          '"ADR-" sees no relation, so every §-annotated pair in the real corpus (0105, 0109, ' +
          '0111-0117, 0119, 0123, 0127, 0136, 0137, 0147, 0149) goes silently unenforced. ' +
          `output: ${excerpt(r.combined)}`,
      );
    }
    if (r.combined.indexOf(second) === -1) {
      failing.push(
        `TOOTH 19 (multi-reference ordering): expected the pair key "${second}" but the output ` +
          `does not contain it (exit ${r.code}). ADR-0944 is the SECOND element of 0940's comma ` +
          'list and it sits after a parenthetical gloss that itself contains a comma. An ' +
          'implementation that truncates the whole field value at the first "(" BEFORE ' +
          'comma-splitting never reaches it and the gap disappears. The contract is ' +
          `comma-split FIRST, then truncate each token. output: ${excerpt(r.combined)}`,
      );
    }
    if (r.code === 0) {
      failing.push(
        'TOOTH 19 (§-annotated reference): the generator exited 0 on a directory with two ' +
          'unanswered in-era amendments — section-annotated references are not participating ' +
          'in the back-link check at all.',
      );
    }
  });

  // =========================================================================
  // TOOTH 20 — relations resolve against the SCANNED FILE ids, not `allIds`.
  //
  // scripts/adr-digest.mjs:502-508 builds `allIds` for the dangling-reference
  // check out of THREE sources: the scanned ADR files, the synthetic harness ids
  // 0002-0034, and every H-NNNN entry of design-corpus.json. The last two have
  // no files. Reusing `allIds` as the back-link resolver's membership test
  // invents pairs whose target cannot be opened or repaired — on the real corpus
  // it turns 0177's "**Amends:** ADR-0006" into a permanently unfixable
  // violation, because there is no 0006 file to add an **Amended-by:** to.
  //
  // The directory holds two halves; both must be silent and the run must exit 0.
  //   half A  0942 **Amends:** ADR-0020 — a valid allIds member with no file.
  //           Honest scope: because every allIds-only id (0002-0034) sorts BELOW
  //           BACKLINK_ERA_MIN, the era clause already tolerates this pair even
  //           under an allIds-based resolver, so half A does NOT by itself
  //           separate the two resolvers. What it does bite is an implementation
  //           that resolves the id and then dereferences the absent target record
  //           (`byId.get('0020').amendedBy`) before the era test — a crash, i.e.
  //           a non-zero exit and a stack trace.
  //   half B  0943 **Amends:** 0958 — the half with teeth. 0958 is IN-ERA, so
  //           the era clause cannot save it, and it has no file anywhere. The
  //           ONLY rule that can keep the gate quiet is "the resolved id must be
  //           a file in the scanned directory". Drop that clause and the
  //           generator reports (0943->0958).
  //           The BARE form is deliberate: extractAllAdrIds (scripts/
  //           adr-digest.mjs:282) only recognises "ADR-NNNN"/"H-NNNN", so the
  //           pre-existing dangling-reference check does not fire on "0958" and
  //           this directory stays free of foreign diagnostics (TOOTH 0) — while
  //           the back-link resolver, which DOES read bare ids (TOOTH 4), still
  //           reaches the file-existence clause.
  //
  // The id checks are on stderr only: stdout carries the tmpdir path, whose
  // random suffix must not be allowed to decide the assertion (see TOOTH 2).
  // =========================================================================
  withFixtureDir('t20-harness-ref', (r) => {
    if (r.code !== 0) {
      failing.push(
        'TOOTH 20 (resolve against scanned files, not allIds): 0942 references the harness id ' +
          'ADR-0020 and 0943 references the bare id 0958; neither has a file in the scanned ' +
          `directory, so neither is a relation at all and the run must exit 0 — it exited ` +
          `${r.code}. Either the resolver is keyed on allIds (which contains the synthetic ` +
          'harness ids 0002-0034 and every H-NNNN entry) instead of the scanned file ids, or it ' +
          'has no file-existence clause, or it dereferences an absent target record. ' +
          `output: ${excerpt(r.combined)}`,
      );
    }
    if (r.stderr.indexOf('0958') !== -1) {
      failing.push(
        'TOOTH 20 (resolve against scanned files, not allIds): the generator named 0958 in its ' +
          'diagnostics. 0943 declares "**Amends:** 0958", 0958 is in-era so the era clause ' +
          'cannot excuse it, and there is no 0958 file — the resolver is emitting a violation ' +
          'against an id nobody can ever repair. A resolved id must be a file in the scanned ' +
          `directory. stderr: ${excerpt(r.stderr)}`,
      );
    }
    if (r.stderr.indexOf('0020') !== -1) {
      failing.push(
        'TOOTH 20 (resolve against scanned files, not allIds): the generator named 0020 in its ' +
          'diagnostics. ADR-0020 is a synthetic harness id seeded into allIds for the ' +
          'dangling-reference check only; it has no file, so it must never become a back-link ' +
          'endpoint. On the real corpus this shape is 0177 **Amends:** ADR-0006. ' +
          `stderr: ${excerpt(r.stderr)}`,
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
  // TWO-WAY PIN ON THE THRESHOLD VALUE: this tooth pins the threshold from
  // below — lowering it past 0120 makes this tooth red. The sibling eval's
  // TOOTH 12 pins it from above: raising it above '0151' exempts the real pair
  // 0163->0151 and TOOTH 12 goes red. Stated accurately, the two files pin
  // BACKLINK_ERA_MIN to the SET {'0150', '0151'} — not uniquely to '0151'.
  // '0150' is observationally identical because no real pair has 0150 as an
  // endpoint (nobody amends 0150), so no fixture and no corpus fact can tell
  // the two apart. Anything below '0150' or above '0151' is killed.
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
  // Does NOT kill the mirror-image mutation (`target >= ERA` only). An earlier
  // revision of this comment claimed it did; that claim was FALSE and has been
  // deleted. This pair's TARGET is 0120, which is below the era, so a
  // target-only test exempts this pair EXACTLY as the both-endpoints rule does
  // — the two are indistinguishable here. TOOTH 16c exists for that mutation.
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
  // TOOTH 16c — ERA THRESHOLD, the FOURTH QUADRANT: below-era SOURCE, in-era
  // TARGET.
  //
  // 0120 **Amends:** ADR-0956 and 0956 answers with an em-dash. The source is
  // below BACKLINK_ERA_MIN; the target is above it. The both-endpoints rule
  // tolerates the pair, so the run must exit 0 and name neither id.
  //
  // The four quadrants and which tooth owns each:
  //   (in-era,  in-era ) -> ENFORCED   TOOTH 1
  //   (in-era,  below  ) -> tolerated  TOOTH 16b
  //   (below,   below  ) -> tolerated  TOOTH 16a
  //   (below,   in-era ) -> tolerated  TOOTH 16c   <- this one
  //
  // Kills: a TARGET-ONLY era test (`if (v.b < BACKLINK_ERA_MIN) continue;`).
  // Before this tooth existed that mutation passed every tooth in this file and
  // in the sibling corpus eval. No other fixture separates it from the
  // both-endpoints rule: 16a's and 16b's targets are BOTH below the era, so a
  // target-only test exempts them identically. It also kills an OR'd era test
  // (`v.a >= ERA || v.b >= ERA`), which reports this pair.
  //
  // Why it matters beyond the mutation: the real corpus ALREADY has six ADRs of
  // exactly this shape — 0037, 0068, 0075, 0085, 0090 and 0148 carry Amended-by
  // pointers into the in-era range. All six are reciprocal today, so no eval
  // would notice a target-only era test now; the first one that stops being
  // reciprocal would red CI on a pre-0151 file that is out of this slice's
  // scope, i.e. an unfixable failure.
  //
  // COLLISION: the directory holds {0120, 0956}. Neither is an endpoint of any
  // KNOWN_BACKLINK_GAPS entry (0166->0156, 0168->0166, 0169->0154, 0172->0157,
  // 0177->0173), so the ratchet must stay silent — TOOTH 0's scope guard
  // enforces that. 0120 is a deliberate real-range id: no id >= 0900 can sort
  // below the era.
  //
  // NOTE ON THE WARN SUMMARY: this run has M = 1 (one below-era one-directional
  // gap), so the contracted summary line IS emitted. That is fine — it is a
  // WARN, the exit code stays 0, and the contract forbids naming below-era
  // pairs individually. The id assertion below is precisely what holds that.
  // =========================================================================
  withFixtureDir('t16c-below-era-source', (r) => {
    if (r.code !== 0) {
      failing.push(
        'TOOTH 16c (below-era source, in-era target): 0120 **Amends:** ADR-0956 with no ' +
          'reciprocal back-link. The TARGET is in-era but the SOURCE (0120) is below ' +
          "BACKLINK_ERA_MIN = '0151', and the rule enforces a pair only when BOTH endpoints " +
          `are in-era — so this must exit 0, but the generator exited ${r.code}. The era test ` +
          'is being applied to the target id alone (or OR-ed instead of AND-ed), which would ' +
          'demand edits to pre-0151 ADRs — the real corpus already has six of this shape ' +
          `(0037, 0068, 0075, 0085, 0090, 0148). output: ${excerpt(r.combined)}`,
      );
    }
    // stderr only — see the note in TOOTH 2.
    if (r.stderr.indexOf('0120') !== -1 || r.stderr.indexOf('0956') !== -1) {
      failing.push(
        'TOOTH 16c (below-era source, in-era target): the generator named 0120/0956 in its ' +
          'diagnostics although the pair straddles the era threshold and must be tolerated. ' +
          'Below-era pairs are only ever COUNTED into the WARN summary, never named ' +
          `individually. stderr: ${excerpt(r.stderr)}`,
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
  // entry — see RATCHET_REPIN_NOTE, which is appended to the failure messages
  // below so the CI-log reader sees it rather than only this comment. The
  // reciprocal note lives beside KNOWN_BACKLINK_GAPS in scripts/adr-digest.mjs;
  // keep both halves in sync. (TOOTH 8 is pinned to "0168->0166" and
  // "0172->0157" — different entries, deliberately.)
  //
  // COLLISION: this directory contains only 0169 and 0154, and "0169->0154" is
  // the sole baseline entry with both endpoints present here (0166->0156,
  // 0168->0166, 0172->0157 and 0177->0173 have neither). So exactly one
  // obsolete line may fire, and the "exactly 1" assertion below cannot be
  // satisfied by a different entry. See the audit at RATCHET_DIRS.
  //
  // The reason clause IS pinned, to the contracted `the amendment declaration
  // is gone`. (An earlier revision left it free because only the reciprocal
  // branch's wording had been handed over; the contract now specifies both, so
  // the whole message is fair game — and pinning it kills an implementation
  // that emits the reciprocal wording for BOTH branches, which would tell the
  // reader to look for a reciprocity that does not exist.) TOOTH 8 pins the two
  // clauses against each other in a single directory; this tooth pins this one
  // again in isolation.
  // =========================================================================
  withFixtureDir('t17-ratchet-declaration-gone', (r) => {
    const key = '0169->0154';
    const expected = obsoleteMessage(key, 'the amendment declaration is gone');
    const obsoleteLines = linesContaining(r.combined, 'obsolete');
    if (obsoleteLines.length === 0) {
      failing.push(
        'TOOTH 17 (ratchet, declaration gone): expected an "obsolete" diagnostic for the ' +
          `baseline entry "${key}". In this directory 0169 declares **Amends:** — (the ` +
          'amendment is gone) while 0154 is still present, so the recorded violation cannot ' +
          `hold and the entry is dead debt — but no output line contains "obsolete" ` +
          `(exit ${r.code}). The ratchet only asks whether the pair became reciprocal, so an ` +
          `entry survives forever once its declaration is removed.\n  ${RATCHET_REPIN_NOTE}\n` +
          `  output: ${excerpt(r.combined)}`,
      );
    } else {
      if (r.combined.indexOf(key) === -1) {
        failing.push(
          'TOOTH 17 (ratchet, declaration gone): an "obsolete" diagnostic was emitted but it ' +
            `does not name the pair key "${key}" — the ratchet fired on some other entry, or ` +
            `the message gives no actionable handle on which entry to delete.\n` +
            `  ${RATCHET_REPIN_NOTE}\n  output: ${excerpt(r.combined)}`,
        );
      }
      if (obsoleteLines.length !== 1) {
        failing.push(
          'TOOTH 17 (ratchet, declaration gone): expected exactly 1 "obsolete" line for this ' +
            `directory but got ${obsoleteLines.length}. Only "${key}" has BOTH endpoints ` +
            'present as files here; the other four baseline entries have neither endpoint ' +
            `present and must be skipped, not reported.\n  ${RATCHET_REPIN_NOTE}\n` +
            `  output: ${excerpt(r.combined)}`,
        );
      }
      if (r.combined.indexOf(expected) === -1) {
        failing.push(
          'TOOTH 17 (ratchet, declaration gone): the obsolete diagnostic does not match the ' +
            'contract. This branch has its own specified reason clause — "the amendment ' +
            'declaration is gone" — and emitting the reciprocal branch\'s wording here would ' +
            'send the reader looking for a reciprocity that does not exist.\n' +
            `  expected substring: ${expected}\n  output: ${excerpt(r.combined)}`,
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
    detail:
      '18/18 teeth bite correctly (T0, T1–T8, T10, T15, T16a, T16b, T16c, T17, T18, T19, T20)',
  };
}
