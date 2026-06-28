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
    const needle = 'disallowed method `' + m + '`';
    if (clippyStderr.indexOf(needle) === -1) {
      missing.push(m);
    }
  }
  for (const t of requiredTypes) {
    // clippy emits: `error: use of a disallowed type `rand::rngs::OsRng``
    const needle = 'disallowed type `' + t + '`';
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
// `path = "<p>"` entry in the clippy.toml text.
//
// This is a static check that the ban DECLARATIONS exist in the config file —
// distinct from Part A which checks the RUNTIME rejection. Both are needed:
// a ban missing from the toml will not appear in runtime stderr (Part A would
// catch it too), but Part C fails fast without requiring a cargo run.
//
// Uses indexOf only.

export function clippyBansEverySink(clippyTomlText, requiredMethods, requiredTypes) {
  const missing = [];
  const allPaths = [...requiredMethods, ...requiredTypes];
  for (const p of allPaths) {
    // TOML entry looks like: path = "rand::random"  (with varying whitespace)
    // We check for the path string in double-quotes, which is unambiguous.
    const needle = 'path = "' + p + '"';
    if (clippyTomlText.indexOf(needle) === -1) {
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
// Algorithm (indexOf only):
//   1. Find the `[profile.release]` header.
//   2. Slice from that index to the next `[` header (or end of string).
//   3. Check that slice contains `overflow-checks = true`.
//   4. Repeat for `[profile.bench]`.
//
// Kills: a Cargo.toml that has the profile sections but lacks overflow-checks,
// or that is missing either section entirely.

export function profileFailsLoud(cargoTomlText) {
  const missing = [];

  for (const section of ['[profile.release]', '[profile.bench]']) {
    const sectionIdx = cargoTomlText.indexOf(section);
    if (sectionIdx === -1) {
      missing.push(section);
      continue;
    }
    // Slice from just after the section header to the next `[` (next section) or end.
    const afterHeader = cargoTomlText.slice(sectionIdx + section.length);
    const nextSection = afterHeader.indexOf('\n[');
    const body = nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
    if (body.indexOf('overflow-checks = true') === -1) {
      missing.push(section + ' overflow-checks = true');
    }
  }

  return { ok: missing.length === 0, missing };
}

// ============================================================================
// Required sink sets (spec-exact — do not modify)
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

// rejectMethods: the subset the fixture actually CALLS (excludes the two *::elapsed
// entries, which are banned in clippy.toml but not invoked in the fixture).
// clippyRejectsAllSinks for Part A uses this narrower set.
const rejectMethods = requiredMethods.filter(
  (m) => m !== 'std::time::SystemTime::elapsed' && m !== 'std::time::Instant::elapsed',
);

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
      // Build a clippy.toml text that has most bans but deliberately omits two.
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
      // Both omitted paths must appear in missing.
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
      // profile.release must appear in missing.
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

    // All in-file teeth passed — proceed to real cargo runs.

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
      failures.push('Part C: cannot read clippy.toml — ' + e.message);
      clippyTomlText = '';
    }
    try {
      cargoTomlText = readFileSync(cargoTomlPath, 'utf8');
    } catch (e) {
      failures.push('Part C: cannot read Cargo.toml — ' + e.message);
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

    // ========================================================================
    // STEP 3 — Part A: real clippy on the detached determinism-teeth fixture.
    // Expected to EXIT NON-ZERO (clippy found violations) — that is the PASS state.
    // If clippy exits 0 (no violations found), the gate did NOT bite → FAILURE.
    // ========================================================================

    {
      let clippyBit = false; // true when clippy exited non-zero (expected)
      let clippyStderr = '';

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
        // Non-zero exit is the expected (good) path — now check stderr content.
        clippyStderr =
          (typeof e.stderr === 'string' ? e.stderr : '') +
          (typeof e.stdout === 'string' ? e.stdout : '');

        // Guard: distinguish a real clippy rejection from a toolchain/manifest error.
        if (
          !clippyStderr ||
          clippyStderr.indexOf('error: could not find') !== -1 ||
          clippyStderr.indexOf('failed to load manifest') !== -1 ||
          clippyStderr.indexOf('no such command') !== -1
        ) {
          failures.push(
            'Part A [clippy-could-not-run]: clippy could not run on the determinism-teeth fixture — ' +
              'toolchain error or broken manifest. message: ' +
              (clippyStderr || e.message || '(empty)').slice(0, 400),
          );
        } else {
          // Clippy ran and rejected something — verify it rejected EVERY required sink.
          clippyBit = true;
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
    }
    try {
      execFileSync('cargo', ['test', '--release', '-p', 'release-overflow-teeth', '--quiet'], {
        encoding: 'utf8',
      });
      // Exit 0 → the should_panic test passed → release build aborted on overflow → GOOD.
      // Push nothing — this is the success path.
    } catch (e) {
      // Non-zero exit → should_panic test FAILED → overflow silently wrapped → MISSING profile.
      const out = (typeof e.stdout === 'string' ? e.stdout : '').trim();
      const err = (typeof e.stderr === 'string' ? e.stderr : '').trim();
      const tail = (out + '\n' + err).trim().slice(-600);

      // Distinguish a cargo/package error from a genuine test failure.
      if (
        err.indexOf('did not match') !== -1 ||
        err.indexOf('package ID specification') !== -1 ||
        err.indexOf('no such command') !== -1
      ) {
        failures.push(
          'Part B [cargo-error]: cargo could not run release-overflow-teeth — ' +
            'crate may not be in workspace members or cargo is not on PATH. ' +
            'detail: ' +
            tail,
        );
      } else {
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
      detail: 'unexpected error in determinism-fail-loud eval: ' + outerErr.message,
    };
  }
}
