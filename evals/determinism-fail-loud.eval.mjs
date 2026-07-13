// determinism-fail-loud.eval.mjs — M8.8a "Determinism fail-loud (config + teeth)"
//
// Gates three orthogonal acceptance criteria from M8.8a (ADR-0055):
//
//   Part A — Clippy rejects EVERY entropy/clock sink in the detached fixture crate
//            (evals/determinism-teeth). Uses CLIPPY_CONF_DIR=<workspace root> so the
//            workspace clippy.toml applies to the detached crate.
//
//   Part B — Release build aborts on integer overflow: the workspace-member fixture
//            (evals/release-overflow-teeth) has a #[should_panic] test that exercises a
//            deliberate u8 overflow. Without [profile.release] overflow-checks=true it
//            silently wraps and the should_panic test FAILS; with it the build panics and
//            the test PASSES.
//
//   Part C — Static structural check: clippy.toml contains a ban entry for every required
//            method/type path; workspace Cargo.toml contains [profile.release] and
//            [profile.bench] sections both with overflow-checks = true.
//
// Implementation notes:
//   - NO `new RegExp(...)` / dynamic-string RegExp anywhere (Semgrep ReDoS gate).
//     All pattern matching uses String.indexOf() or literal /regex/.
//   - Pure helper functions are exported so this file's in-file teeth can exercise them
//     independently of any cargo run.
//   - In-file TEETH run FIRST and short-circuit with pass:false if any predicate is broken
//     (a broken predicate cannot gate anything).
//   - The default export never throws — all errors are caught and converted to pass:false.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ============================================================================
// Pure helper: stripTomlComments
// ============================================================================
//
// Removes FULL-LINE TOML comments only — drops every line whose first
// non-whitespace character is `#`. Does NOT strip inline `#` after a value
// (a reason = "...#..." string could legitimately contain `#`).
//
// Uses a literal /regex/ (not new RegExp) — safe under the Semgrep ReDoS gate.
//
// Kills: a clippyBansEverySink / profileFailsLoud that false-GREENs when a
// required ban or profile key is commented out at the line level.

export function stripTomlComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

// ============================================================================
// Pure helper: clippyRejectsAllSinks
// ============================================================================
//
// Returns { ok: boolean, missing: string[] }.
// ok is true iff:
//   - for every method path M in requiredMethods, stderr contains the substring
//     `disallowed method `M`` (backtick-quoted, exactly as clippy emits it)
//   - for every type path T in requiredTypes, stderr contains the substring
//     `disallowed type `T``
//
// Kills: a clippy.toml that is missing one or more bans — the missing path will
// not appear in stderr and this function returns ok:false with missing named.
//
// Uses indexOf only — no new RegExp.

export function clippyRejectsAllSinks(clippyStderr, requiredMethods, requiredTypes) {
  const missing = [];
  for (const m of requiredMethods) {
    // clippy emits: `error: use of a disallowed method `rand::random``
    // The needle is the exact substring clippy writes to stderr.
    const needle = `disallowed method \`${m}\``;
    if (clippyStderr.indexOf(needle) === -1) {
      missing.push(m);
    }
  }
  for (const t of requiredTypes) {
    // clippy emits: `error: use of a disallowed type `rand::rngs::OsRng``
    const needle = `disallowed type \`${t}\``;
    if (clippyStderr.indexOf(needle) === -1) {
      missing.push(t);
    }
  }
  return { ok: missing.length === 0, missing };
}

// ============================================================================
// Pure helper: clippyBansEverySink
// ============================================================================
//
// Returns { ok: boolean, missing: string[] }.
// ok is true iff every required path (method or type) appears as a
// `path = "<p>"` entry in the clippy.toml text (after stripping full-line
// comments so a commented-out ban is NOT counted as present).
//
// Uses indexOf only (after stripTomlComments).

export function clippyBansEverySink(clippyTomlText, requiredMethods, requiredTypes) {
  // Strip full-line comments first so `# { path = "rand::rng", ... }` is invisible.
  const stripped = stripTomlComments(clippyTomlText);
  const missing = [];
  const allPaths = [...requiredMethods, ...requiredTypes];
  for (const p of allPaths) {
    // TOML entry looks like: path = "rand::random"  (with varying whitespace)
    // We check for the path string in double-quotes, which is unambiguous.
    const needle = `path = "${p}"`;
    if (stripped.indexOf(needle) === -1) {
      missing.push(p);
    }
  }
  return { ok: missing.length === 0, missing };
}

// ============================================================================
// Pure helper: profileFailsLoud
// ============================================================================
//
// Returns { ok: boolean, missing: string[] }.
// ok is true iff the workspace Cargo.toml text contains:
//   - a [profile.release] section with `overflow-checks = true`
//   - a [profile.bench]   section with `overflow-checks = true`
//
// Algorithm (indexOf only, applied to comment-stripped text):
//   1. Strip full-line TOML comments so a commented-out key is invisible.
//   2. Find the `[profile.release]` header.
//   3. Slice from that index to the next `[` header (or end of string).
//   4. Check that slice contains `overflow-checks = true`.
//   5. Repeat for `[profile.bench]`.
//
// Kills (FIX 2): a Cargo.toml where `overflow-checks = true` is commented out
// under a real [profile.release] header — the stripped text won't contain the
// key and the section is correctly flagged missing.
// Kills: a Cargo.toml that has the profile sections but lacks overflow-checks,
// or that is missing either section entirely.

export function profileFailsLoud(cargoTomlText) {
  // Strip full-line comments first so `# overflow-checks = true` is invisible.
  const stripped = stripTomlComments(cargoTomlText);
  const missing = [];

  for (const section of ['[profile.release]', '[profile.bench]']) {
    const sectionIdx = stripped.indexOf(section);
    if (sectionIdx === -1) {
      missing.push(section);
      continue;
    }
    // Slice from just after the section header to the next `[` (next section) or end.
    const afterHeader = stripped.slice(sectionIdx + section.length);
    const nextSection = afterHeader.indexOf('\n[');
    const body = nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
    if (body.indexOf('overflow-checks = true') === -1) {
      missing.push(`${section} overflow-checks = true`);
    }
  }

  return { ok: missing.length === 0, missing };
}

// ============================================================================
// Required sink sets (spec-exact — do not modify contents)
// ============================================================================

const requiredMethods = [
  'std::time::SystemTime::now',
  'std::time::Instant::now',
  'std::time::SystemTime::elapsed',
  'std::time::Instant::elapsed',
  'rand::thread_rng',
  'rand::random',
  'rand::rng',
  'getrandom::getrandom',
  'getrandom::fill',
  'chrono::Utc::now',
  'chrono::Local::now',
];

const requiredTypes = ['rand::rngs::OsRng', 'rand::rngs::ThreadRng'];

// FIX 1b: rejectMethods = requiredMethods — ALL 11 method bans are live-proven
// by the fixture (evals/determinism-teeth/src/lib.rs). The fixture now calls
// SystemTime::UNIX_EPOCH.elapsed() and Instant::now().elapsed() so both
// *::elapsed bans are exercised at runtime. No exclusions.
const rejectMethods = requiredMethods;

// ============================================================================
// Default export — eval entry point
// ============================================================================

export default async function () {
  const name =
    'determinism-fail-loud (clippy bans every entropy/clock sink + release overflow-checks fail loud)';

  // Wrap everything so we never throw out of the export.
  try {
    const failures = [];

    // ========================================================================
    // STEP 1 — In-file TEETH: verify each pure predicate bites on known-bad input.
    // If any tooth fails, the predicate is broken and cannot gate anything.
    // Return immediately so the failure message names the broken tooth.
    // ========================================================================

    // --- Tooth A: clippyRejectsAllSinks with empty stderr must return ok:false ---
    // Kills: an impl that returns ok:true when stderr is empty (predicate is inverted).
    {
      const result = clippyRejectsAllSinks('', [...requiredMethods], [...requiredTypes]);
      if (result.ok !== false) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH A FAILED: clippyRejectsAllSinks("", allMethods, allTypes).ok was NOT false — ' +
            'empty stderr contains no rejection messages; the predicate must return ok:false when stderr is empty. ' +
            'Kills: an inverted or always-true predicate that never bites.',
        };
      }
      // Also verify that all required paths appear in missing.
      const expectedMissingCount = requiredMethods.length + requiredTypes.length;
      if (result.missing.length !== expectedMissingCount) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH A FAILED: clippyRejectsAllSinks("", allMethods, allTypes).missing has ' +
            result.missing.length +
            ' entries, expected ' +
            expectedMissingCount +
            ' (one per required path). ' +
            'The predicate must report every missing path when stderr is empty.',
        };
      }
    }

    // --- Tooth B: clippyBansEverySink with doctored clippy.toml missing OsRng + Utc::now ---
    // Feed a string that has every ban EXCEPT rand::rngs::OsRng and chrono::Utc::now.
    // Assert both are in missing. Kills: a predicate that ignores missing entries.
    {
      const doctoredToml =
        'disallowed-methods = [\n' +
        '  { path = "std::time::SystemTime::now", reason = "x" },\n' +
        '  { path = "std::time::Instant::now", reason = "x" },\n' +
        '  { path = "std::time::SystemTime::elapsed", reason = "x" },\n' +
        '  { path = "std::time::Instant::elapsed", reason = "x" },\n' +
        '  { path = "rand::thread_rng", reason = "x" },\n' +
        '  { path = "rand::random", reason = "x" },\n' +
        '  { path = "rand::rng", reason = "x" },\n' +
        '  { path = "getrandom::getrandom", reason = "x" },\n' +
        '  { path = "getrandom::fill", reason = "x" },\n' +
        // chrono::Utc::now deliberately OMITTED
        '  { path = "chrono::Local::now", reason = "x" },\n' +
        ']\n' +
        'disallowed-types = [\n' +
        // rand::rngs::OsRng deliberately OMITTED
        '  { path = "rand::rngs::ThreadRng", reason = "x" },\n' +
        ']\n';

      const result = clippyBansEverySink(doctoredToml, requiredMethods, requiredTypes);
      if (result.ok !== false) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH B FAILED: clippyBansEverySink(doctoredToml, ...).ok was NOT false — ' +
            'the doctored clippy.toml is missing rand::rngs::OsRng and chrono::Utc::now; ' +
            'the predicate must return ok:false when any required ban is absent. ' +
            'Kills: a predicate that returns ok:true even with missing bans.',
        };
      }
      const missingOsRng = result.missing.indexOf('rand::rngs::OsRng') !== -1;
      const missingUtcNow = result.missing.indexOf('chrono::Utc::now') !== -1;
      if (!missingOsRng || !missingUtcNow) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH B FAILED: clippyBansEverySink(doctoredToml, ...).missing did not include ' +
            'both omitted paths. missing=' +
            JSON.stringify(result.missing) +
            '. Expected rand::rngs::OsRng and chrono::Utc::now both listed. ' +
            'Kills: a predicate that silently skips some paths.',
        };
      }
    }

    // --- Tooth B2 (FIX 2): commented-out ban line must be reported missing ---
    // A ban present only as `# { path = "rand::rng", ... }` (full-line comment)
    // must NOT count as present. Kills: clippyBansEverySink that scans raw text
    // and false-GREENs commented-out entries.
    {
      const commentedBanToml =
        'disallowed-methods = [\n' +
        '  { path = "std::time::SystemTime::now", reason = "x" },\n' +
        '  { path = "std::time::Instant::now", reason = "x" },\n' +
        '  { path = "std::time::SystemTime::elapsed", reason = "x" },\n' +
        '  { path = "std::time::Instant::elapsed", reason = "x" },\n' +
        '  { path = "rand::thread_rng", reason = "x" },\n' +
        '  { path = "rand::random", reason = "x" },\n' +
        // rand::rng is commented out — must be reported missing
        '  # { path = "rand::rng", reason = "x" },\n' +
        '  { path = "getrandom::getrandom", reason = "x" },\n' +
        '  { path = "getrandom::fill", reason = "x" },\n' +
        '  { path = "chrono::Utc::now", reason = "x" },\n' +
        '  { path = "chrono::Local::now", reason = "x" },\n' +
        ']\n' +
        'disallowed-types = [\n' +
        '  { path = "rand::rngs::OsRng", reason = "x" },\n' +
        '  { path = "rand::rngs::ThreadRng", reason = "x" },\n' +
        ']\n';

      const result = clippyBansEverySink(commentedBanToml, requiredMethods, requiredTypes);
      if (result.ok !== false) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH B2 FAILED: clippyBansEverySink(commentedBanToml, ...).ok was NOT false — ' +
            'rand::rng is present only as a commented-out line ' +
            '(# { path = "rand::rng", ... }) but the predicate treated it as present. ' +
            'stripTomlComments must be applied before scanning so full-line comments are invisible. ' +
            'Kills: a predicate that false-GREENs commented-out bans.',
        };
      }
      if (result.missing.indexOf('rand::rng') === -1) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH B2 FAILED: clippyBansEverySink(commentedBanToml, ...).missing does not ' +
            'include rand::rng. missing=' +
            JSON.stringify(result.missing) +
            '. ' +
            'The commented-out ban must appear in missing.',
        };
      }
    }

    // --- Tooth C: profileFailsLoud with no [profile.release] section must report it missing ---
    // Kills: a predicate that returns ok:true when the section is absent.
    {
      const noProfileToml =
        '[workspace]\n' +
        'members = ["game-core"]\n' +
        '\n' +
        '[workspace.package]\n' +
        'version = "0.1.0"\n';

      const result = profileFailsLoud(noProfileToml);
      if (result.ok !== false) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH C FAILED: profileFailsLoud(tomlWithNoProfileSection).ok was NOT false — ' +
            'a Cargo.toml with no [profile.release] section must return ok:false. ' +
            'Kills: a predicate that returns ok:true when the section is absent.',
        };
      }
      const missingRelease = result.missing.some((m) => m.indexOf('profile.release') !== -1);
      if (!missingRelease) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH C FAILED: profileFailsLoud(noProfileToml).missing does not include ' +
            '"profile.release". missing=' +
            JSON.stringify(result.missing) +
            '. ' +
            'The predicate must report the missing section by name.',
        };
      }
    }

    // --- Tooth C2 (FIX 4): section present but overflow-checks key absent ---
    // A [profile.release] with other keys but no overflow-checks = true must
    // yield ok:false with a missing entry mentioning overflow-checks.
    // Kills: a predicate that only checks for the section header, not the key.
    {
      const sectionNoKeyToml = '[profile.release]\ndebug = false\n';

      const result = profileFailsLoud(sectionNoKeyToml);
      if (result.ok !== false) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH C2 FAILED: profileFailsLoud("[profile.release]\\ndebug = false\\n").ok was NOT false — ' +
            'the section exists but overflow-checks = true is absent; the predicate must return ok:false. ' +
            'Kills: a predicate that passes when the section header is present but the key is missing.',
        };
      }
      const mentionsOverflow = result.missing.some((m) => m.indexOf('overflow-checks') !== -1);
      if (!mentionsOverflow) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH C2 FAILED: profileFailsLoud(sectionNoKeyToml).missing does not mention ' +
            '"overflow-checks". missing=' +
            JSON.stringify(result.missing) +
            '. ' +
            'The missing entry must name the absent key so the implementer knows what to add.',
        };
      }
    }

    // --- Tooth C3 (FIX 2): commented-out overflow-checks must be reported missing ---
    // A [profile.release] section where `overflow-checks = true` is commented out
    // must yield ok:false. Kills: profileFailsLoud that scans raw text and
    // false-GREENs a commented-out key (the sole oracle for [profile.bench]).
    {
      const commentedOverflowToml =
        '[profile.release]\n' +
        'debug = false\n' +
        '# overflow-checks = true\n' +
        '\n' +
        '[profile.bench]\n' +
        'overflow-checks = true\n';

      const result = profileFailsLoud(commentedOverflowToml);
      if (result.ok !== false) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH C3 FAILED: profileFailsLoud(commentedOverflowToml).ok was NOT false — ' +
            '[profile.release] has `# overflow-checks = true` (commented out) but the predicate ' +
            'treated it as present. stripTomlComments must be applied so commented-out keys are invisible. ' +
            'Kills: a profileFailsLoud that false-GREENs a commented-out overflow-checks key ' +
            '(critical: [profile.bench] has no live cargo test — Part C is its sole oracle).',
        };
      }
      const mentionsRelease = result.missing.some(
        (m) => m.indexOf('profile.release') !== -1 && m.indexOf('overflow-checks') !== -1,
      );
      if (!mentionsRelease) {
        return {
          name,
          pass: false,
          detail:
            'IN-FILE TOOTH C3 FAILED: profileFailsLoud(commentedOverflowToml).missing does not ' +
            'include an entry for [profile.release] overflow-checks. missing=' +
            JSON.stringify(result.missing),
        };
      }
    }

    // All in-file teeth passed — proceed to real checks.

    // ========================================================================
    // STEP 2 — Part C: static structural checks (cheap, fail-fast)
    // Read real clippy.toml and Cargo.toml; assert bans + profiles are present.
    // ========================================================================

    const root = path.resolve('.');
    const clippyTomlPath = path.join(root, 'clippy.toml');
    const cargoTomlPath = path.join(root, 'Cargo.toml');

    let clippyTomlText, cargoTomlText;
    try {
      clippyTomlText = readFileSync(clippyTomlPath, 'utf8');
    } catch (e) {
      failures.push(`Part C: cannot read clippy.toml — ${e.message}`);
      clippyTomlText = '';
    }
    try {
      cargoTomlText = readFileSync(cargoTomlPath, 'utf8');
    } catch (e) {
      failures.push(`Part C: cannot read Cargo.toml — ${e.message}`);
      cargoTomlText = '';
    }

    if (clippyTomlText) {
      const bansResult = clippyBansEverySink(clippyTomlText, requiredMethods, requiredTypes);
      if (!bansResult.ok) {
        failures.push(
          'Part C [clippy-bans-missing]: workspace clippy.toml is missing ban entries for: ' +
            bansResult.missing.join(', ') +
            ' — add disallowed-methods/disallowed-types entries for each (M8.8a)',
        );
      }
    }

    if (cargoTomlText) {
      const profileResult = profileFailsLoud(cargoTomlText);
      if (!profileResult.ok) {
        failures.push(
          'Part C [profile-missing]: workspace Cargo.toml is missing: ' +
            profileResult.missing.join(', ') +
            ' — add [profile.release] and [profile.bench] sections both with overflow-checks = true (M8.8a)',
        );
      }
    }
    try {
      // We expect this to THROW (non-zero exit) because the fixture is impure.
      execFileSync(
        'cargo',
        [
          'clippy',
          '--manifest-path',
          'evals/determinism-teeth/Cargo.toml',
          '--quiet',
          '--',
          '-D',
          'warnings',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, CLIPPY_CONF_DIR: root },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      // If we reach here, clippy exited 0 — the gate did NOT bite.
      failures.push(
        'Part A [gate-did-not-bite]: clippy exited 0 on the determinism-teeth fixture — ' +
          'no disallowed-method/type errors were raised. ' +
          'The clippy.toml bans are either missing or not being picked up via CLIPPY_CONF_DIR. ' +
          'Expected: clippy should exit non-zero rejecting every banned sink.',
      );
    } catch (e) {
      // Non-zero exit — read stderr+stdout for diagnostics.
      const clippyStderr =
        (typeof e.stderr === 'string' ? e.stderr : '') +
        (typeof e.stdout === 'string' ? e.stdout : '');

      // Distinguish a real gate-bite from an env/toolchain/fixture-compile error.
      // The RELIABLE discriminator is whether clippy actually emitted disallowed
      // diagnostics — NOT a substring list. clippy treats disallowed-method/type
      // lints as errors and then prints "error: could not compile ... due to N
      // previous errors" on EVERY successful gate-bite, so matching "could not
      // compile"/"error[E" would misclassify the success case as an env error.
      // If any `disallowed method`/`disallowed type` diagnostic is present, the
      // gate bit (verify completeness); a non-zero exit with NONE present is an
      // env/toolchain/fixture-compile problem (the fix is the environment).
      const gateBit =
        clippyStderr.indexOf('disallowed method `') !== -1 ||
        clippyStderr.indexOf('disallowed type `') !== -1;

      if (!gateBit) {
        failures.push(
          'Part A [clippy-could-not-run]: clippy exited non-zero but emitted NO ' +
            'disallowed-method/type diagnostics — env/toolchain/fixture-compile problem ' +
            '(not a missing-ban failure). message: ' +
            (clippyStderr || e.message || '(empty)').slice(0, 400),
        );
      } else {
        // Clippy ran and rejected something — verify it rejected EVERY required sink.
        // FIX 1b: rejectMethods === requiredMethods (all 11, including both *::elapsed).
        const rejectResult = clippyRejectsAllSinks(clippyStderr, rejectMethods, requiredTypes);
        if (!rejectResult.ok) {
          failures.push(
            'Part A [missing-rejections]: clippy rejected some sinks but NOT all required ones. ' +
              'Missing rejections: ' +
              rejectResult.missing.join(', ') +
              '. ' +
              'Add the missing bans to workspace clippy.toml (M8.8a). ' +
              'Kills: a clippy.toml that bans some sinks but not others.',
          );
        }
      }
    }
    try {
      execFileSync('cargo', ['test', '--release', '-p', 'release-overflow-teeth', '--quiet'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Exit 0 → the should_panic test passed → release build aborted on overflow → GOOD.
      // Push nothing — this is the success path.
    } catch (e) {
      const out = (typeof e.stdout === 'string' ? e.stdout : '').trim();
      const err = (typeof e.stderr === 'string' ? e.stderr : '').trim();
      const combined = `${out}\n${err}`;
      const tail = combined.trim().slice(-600);

      // Positive discriminator (mirrors Part A): did the #[should_panic] test
      // actually RUN? If cargo got far enough to run it ("test result:" / "did not
      // panic"), the non-zero exit means the overflow WRAPPED instead of panicking
      // → the release profile's overflow-checks is missing/ineffective. Otherwise
      // the crate could not build/run (env/compile/PATH) — a different fix. A real
      // test failure does NOT print "could not compile", so gating on test-ran is
      // robust where a substring list is not.
      const testRan =
        combined.indexOf('test result:') !== -1 || combined.indexOf('did not panic') !== -1;

      if (!testRan) {
        failures.push(
          'Part B [cannot-run]: release-overflow-teeth could not build/run (env/compile error, ' +
            'not a missing profile) — crate may not be in workspace members, cargo is not on PATH, ' +
            'or the crate failed to compile. detail: ' +
            tail,
        );
      } else {
        // Genuine test failure: the should_panic test ran but did not panic →
        // overflow silently wrapped → [profile.release] overflow-checks = true is missing.
        failures.push(
          'Part B [overflow-checks-missing]: release-overflow-teeth did not pass in release — ' +
            '`[profile.release] overflow-checks = true` is missing or ineffective. ' +
            'Without it, u8::MAX + 1 wraps silently and the #[should_panic] test FAILS. ' +
            'Add overflow-checks = true to both [profile.release] and [profile.bench] in ' +
            'the workspace Cargo.toml (M8.8a). detail: ' +
            tail,
        );
      }
    }

    // ========================================================================
    // Result
    // ========================================================================

    const pass = failures.length === 0;
    return {
      name,
      pass,
      detail: pass
        ? 'all determinism sinks rejected by clippy; release build aborts on overflow; profiles + bans present (teeth verified)'
        : failures.join(' | '),
    };
  } catch (outerErr) {
    // Safety net: the default export must never throw.
    return {
      name,
      pass: false,
      detail: `unexpected error in determinism-fail-loud eval: ${outerErr.message}`,
    };
  }
}
