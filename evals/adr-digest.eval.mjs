// adr-digest.eval.mjs — M-infra-d: ADR digest generator teeth (ADR-0104).
//
// Tests the CLI contract of scripts/adr-digest.mjs against acceptance criteria
// infra-d-6 (drift gate) and infra-d-7 (proof-of-teeth for each violation type).
//
// EARS criteria covered:
//   TOOTH 1 (infra-d-7 false-positive guard): clean fixture passes all checks.
//   TOOTH 2 (infra-d-7): missing **Status:** on non-legacy ADR → fails with Status message.
//   TOOTH 3 (infra-d-7): unknown subsystem on non-legacy ADR → fails with subsystem message.
//   TOOTH 4 (infra-d-7): decision >240 chars on non-legacy ADR → fails with 240 message.
//   TOOTH 5 (infra-d-7): dangling **Superseded-by:** reference → fails with dangling message.
//   TOOTH 6 (infra-d-7): stale DIGEST.md detected by --check → fails with stale/drift message.
//   TOOTH 7 (infra-d-6): real project corpus is never stale or invalid → passes.
//   TOOTH 8 (red-team): **Status:** inside a code block must NOT satisfy header validation.
//   TOOTH 9 (red-team): dangling H- reference in **Supersedes:** must fail (H- blind spot).
//   TOOTH 10 (red-team): Status=Superseded + **Superseded-by:** — must fail (em-dash bypass).
//
// IMPORTANT: NO new RegExp(...) — detect-non-literal-regexp Semgrep rule bites.
// Only String.includes() / indexOf() and literal /regex/ patterns used here.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'adr-digest.mjs');
const FIXTURES = join(__dirname, 'fixtures', 'adr-digest');

// ---------------------------------------------------------------------------
// Helper: run scripts/adr-digest.mjs with the given args; return { code, stderr, stdout }.
// spawnSync captures exit code as data rather than throwing, so each tooth can
// inspect the code independently.
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
// Helper: create a temp dir, copy ONE fixture file into it, return the dir path.
// Caller is responsible for rmSync cleanup in a finally block.
// ---------------------------------------------------------------------------
function makeTmpWithFixture(fixtureName) {
  const dir = mkdtempSync(join(tmpdir(), 'adr-digest-'));
  const content = readFileSync(join(FIXTURES, fixtureName), 'utf8');
  writeFileSync(join(dir, fixtureName), content);
  return dir;
}

// ---------------------------------------------------------------------------
// Default export — eval entry point.
// ---------------------------------------------------------------------------
export default async function () {
  const name = 'adr-digest (M-infra-d: ADR digest generator CLI contract)';

  const failing = [];

  // =========================================================================
  // TOOTH 1 — false-positive guard: a clean, valid non-legacy ADR must PASS.
  //
  // Kills: any implementation that erroneously rejects well-formed ADRs.
  // =========================================================================
  {
    const dir = makeTmpWithFixture('0900-good.md');
    try {
      const out = join(dir, 'DIGEST.md');
      const r = runDigest(['--adr-dir', dir, '--out', out]);
      if (r.code !== 0) {
        failing.push(
          'TOOTH 1 (false-positive guard): clean fixture 0900-good.md should exit 0 but ' +
            `got exit ${r.code}. stderr: ${r.stderr.slice(0, 300)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // TOOTH 2 — missing **Status:** on a non-legacy ADR must fail.
  //
  // Kills: an implementation that silently accepts ADRs without a Status field.
  // =========================================================================
  {
    const dir = makeTmpWithFixture('0901-missing-status.md');
    try {
      const out = join(dir, 'DIGEST.md');
      const r = runDigest(['--adr-dir', dir, '--out', out]);
      const combined = r.stderr + r.stdout;
      if (r.code === 0) {
        failing.push(
          'TOOTH 2 (missing Status): expected exit non-0 for ADR missing **Status:** field ' +
            'but got exit 0 — validator has no bite for missing Status',
        );
      } else if (combined.indexOf('Status') === -1 && combined.indexOf('status') === -1) {
        failing.push(
          'TOOTH 2 (missing Status): exited non-0 but output contains neither "Status" ' +
            `nor "status" — message is not actionable. stderr: ${r.stderr.slice(0, 300)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // TOOTH 3 — unknown subsystem value on a non-legacy ADR must fail.
  //
  // Kills: an implementation that accepts arbitrary subsystem values without
  // checking against the controlled vocabulary.
  // =========================================================================
  {
    const dir = makeTmpWithFixture('0902-unknown-subsystem.md');
    try {
      const out = join(dir, 'DIGEST.md');
      const r = runDigest(['--adr-dir', dir, '--out', out]);
      const combined = r.stderr + r.stdout;
      if (r.code === 0) {
        failing.push(
          'TOOTH 3 (unknown subsystem): expected exit non-0 for ADR with unknown subsystem ' +
            '"not-a-real-subsystem" but got exit 0 — vocab check has no bite',
        );
      } else if (combined.indexOf('subsystem') === -1) {
        failing.push(
          'TOOTH 3 (unknown subsystem): exited non-0 but output does not contain "subsystem" ' +
            `— message is not actionable. stderr: ${r.stderr.slice(0, 300)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // TOOTH 4 — decision string longer than 240 chars must fail.
  //
  // Kills: an implementation that skips the 240-char length gate on Decision.
  // =========================================================================
  {
    const dir = makeTmpWithFixture('0903-long-decision.md');
    try {
      const out = join(dir, 'DIGEST.md');
      const r = runDigest(['--adr-dir', dir, '--out', out]);
      const combined = r.stderr + r.stdout;
      if (r.code === 0) {
        failing.push(
          'TOOTH 4 (decision >240 chars): expected exit non-0 for ADR with decision exceeding ' +
            '240 chars but got exit 0 — length gate has no bite',
        );
      } else if (combined.indexOf('240') === -1) {
        failing.push(
          'TOOTH 4 (decision >240 chars): exited non-0 but output does not contain "240" ' +
            `— message is not actionable. stderr: ${r.stderr.slice(0, 300)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // TOOTH 5 — dangling **Superseded-by:** reference must fail.
  //
  // The fixture references ADR-9999 which does not exist in the corpus.
  // Kills: an implementation that writes Superseded-by without checking the
  // referenced ADR actually exists in the directory.
  // =========================================================================
  {
    const dir = makeTmpWithFixture('0904-dangling-supersedes-by.md');
    try {
      const out = join(dir, 'DIGEST.md');
      const r = runDigest(['--adr-dir', dir, '--out', out]);
      const combined = r.stderr + r.stdout;
      if (r.code === 0) {
        failing.push(
          'TOOTH 5 (dangling Superseded-by): expected exit non-0 for ADR with Superseded-by ' +
            'pointing at non-existent ADR-9999 but got exit 0 — dangling reference check has no bite',
        );
      } else if (
        combined.indexOf('dangling') === -1 &&
        combined.indexOf('9999') === -1 &&
        combined.indexOf('Superseded-by') === -1
      ) {
        failing.push(
          'TOOTH 5 (dangling Superseded-by): exited non-0 but output contains none of ' +
            '"dangling", "9999", or "Superseded-by" — message is not actionable. ' +
            `stderr: ${r.stderr.slice(0, 300)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // TOOTH 6 — stale DIGEST.md detected by --check.
  //
  // Procedure:
  //   1. Generate a correct DIGEST.md from 0900-good.md to a temp dir.
  //   2. Overwrite DIGEST.md with wrong content.
  //   3. Run --check → must exit non-0 with stale/drift message.
  //
  // Kills: a --check implementation that does not actually diff the output
  // against the committed file, letting hand-edits slip through silently.
  // =========================================================================
  {
    const dir = makeTmpWithFixture('0900-good.md');
    try {
      const out = join(dir, 'DIGEST.md');

      // Step 1: generate correct digest.
      const genResult = runDigest(['--adr-dir', dir, '--out', out]);
      if (genResult.code !== 0) {
        failing.push(
          'TOOTH 6 (stale digest): generation step failed with exit ' +
            `${genResult.code} — cannot execute stale-digest tooth. ` +
            `stderr: ${genResult.stderr.slice(0, 300)}`,
        );
      } else {
        // Step 2: corrupt the DIGEST.md.
        writeFileSync(out, '<!-- STALE: hand-edited digest that does not match source -->\n');

        // Step 3: --check must detect the stale file.
        const checkResult = runDigest(['--adr-dir', dir, '--out', out, '--check']);
        const combined = checkResult.stderr + checkResult.stdout;
        if (checkResult.code === 0) {
          failing.push(
            'TOOTH 6 (stale digest): --check exited 0 on a deliberately corrupted DIGEST.md ' +
              '— drift gate has no bite; a hand-edit to the generated file would go undetected',
          );
        } else if (
          combined.indexOf('stale') === -1 &&
          combined.indexOf('drift') === -1 &&
          combined.indexOf('changed') === -1 &&
          combined.indexOf('DIGEST') === -1
        ) {
          failing.push(
            'TOOTH 6 (stale digest): --check exited non-0 but output contains none of ' +
              '"stale", "drift", "changed", or "DIGEST" — message is not actionable. ' +
              `stderr: ${checkResult.stderr.slice(0, 300)}`,
          );
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // TOOTH 7 (infra-d-6) — real project corpus passes --check cleanly.
  //
  // This tooth uses NO --adr-dir or --out overrides; it runs against the real
  // docs/adr/ directory and real docs/adr/DIGEST.md. The implementer must
  // author ADR-0104 and generate DIGEST.md as part of the m-infra-d deliverable.
  //
  // This tooth STARTS RED (scripts/adr-digest.mjs does not exist yet) and turns
  // green only when the implementer ships the generator + ADR-0104 + DIGEST.md.
  //
  // Kills: any implementation that exits non-0 on the committed real corpus,
  // meaning the digest is stale or a non-legacy ADR has a header violation.
  // =========================================================================
  {
    const r = runDigest(['--check']);
    if (r.code !== 0) {
      failing.push(
        'TOOTH 7 (real corpus --check): expected exit 0 on the committed real project ADR ' +
          'corpus but got exit ' +
          r.code +
          '. Either scripts/adr-digest.mjs is not yet implemented, ' +
          'docs/adr/DIGEST.md is missing or stale, or a non-legacy ADR (≥0104) has a ' +
          `header violation. stderr: ${r.stderr.slice(0, 400)}`,
      );
    }
  }

  // =========================================================================
  // TOOTH 8 — extractBoldField must not match **Status:** inside a code block
  // or body text; a canonical ADR with Status only in the body must FAIL.
  //
  // Invariant: field extraction is header-only — a body occurrence of
  // "**Status:** Accepted" (e.g. inside a template code block) must NOT satisfy
  // the Status validation requirement for a non-legacy ADR.
  //
  // Kills: any full-document substring scan that falsely accepts a body-embedded
  // Status field as proof that the header is present, letting a malformed ADR
  // sneak past the gate with no header Status field at all.
  // =========================================================================
  {
    const dir = makeTmpWithFixture('0905-status-in-body-block.md');
    try {
      const out = join(dir, 'DIGEST.md');
      const r = runDigest(['--adr-dir', dir, '--out', out]);
      const combined = r.stderr + r.stdout;
      if (r.code === 0) {
        failing.push(
          'TOOTH 8 (body-embedded Status bypass): expected exit non-0 for ADR whose ' +
            '**Status:** field appears only inside a code block in the body (not the header) ' +
            'but got exit 0 — extractBoldField scans the full document and a body occurrence ' +
            'falsely satisfies the Status requirement; a malformed ADR passes the gate',
        );
      } else if (combined.indexOf('Status') === -1 && combined.indexOf('status') === -1) {
        failing.push(
          'TOOTH 8 (body-embedded Status bypass): exited non-0 but output contains neither ' +
            '"Status" nor "status" — error message is not actionable. ' +
            `stderr: ${r.stderr.slice(0, 300)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // TOOTH 9 — dangling H- reference in **Supersedes:** must fail.
  //
  // Invariant: extractAllAdrIds only recognises "ADR-NNNN" patterns; it is blind
  // to "H-NNNN" references.  A canonical ADR that writes
  // "**Supersedes:** H-0099" (non-existent in design-corpus.json) must fail the
  // dangling-reference check.
  //
  // Kills: any implementation where extractAllAdrIds ignores H- prefixes, letting
  // a reference to a non-existent harness ADR pass silently without an error.
  // =========================================================================
  {
    const dir = makeTmpWithFixture('0906-h-ref-in-supersedes.md');
    try {
      const out = join(dir, 'DIGEST.md');
      const r = runDigest(['--adr-dir', dir, '--out', out]);
      const combined = r.stderr + r.stdout;
      if (r.code === 0) {
        failing.push(
          'TOOTH 9 (dangling H- reference): expected exit non-0 for ADR with ' +
            '**Supersedes:** H-0099 (non-existent harness ADR) but got exit 0 — ' +
            'extractAllAdrIds is blind to H- prefixes; dangling H- references are ' +
            'invisible to the gate and pass without error',
        );
      } else if (
        combined.indexOf('dangling') === -1 &&
        combined.indexOf('H-0099') === -1 &&
        combined.indexOf('0099') === -1
      ) {
        failing.push(
          'TOOTH 9 (dangling H- reference): exited non-0 but output contains none of ' +
            '"dangling", "H-0099", or "0099" — error message is not actionable. ' +
            `stderr: ${r.stderr.slice(0, 300)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // TOOTH 10 — Superseded ADR with Superseded-by set to em-dash must fail.
  //
  // Invariant: when Status=Superseded the **Superseded-by:** field must carry a
  // real ADR reference, not an em-dash sentinel (which means "none").  Writing
  // "**Superseded-by:** —" on a Superseded ADR produces a semantically broken
  // record: the ADR claims to be superseded but names no successor.
  //
  // Kills: any implementation where checkRefs short-circuits on em-dash before
  // the "Status=Superseded requires a real Superseded-by" constraint is enforced,
  // allowing the invalid combination to pass the gate silently.
  // =========================================================================
  {
    const dir = makeTmpWithFixture('0907-superseded-by-em-dash.md');
    try {
      const out = join(dir, 'DIGEST.md');
      const r = runDigest(['--adr-dir', dir, '--out', out]);
      const combined = r.stderr + r.stdout;
      if (r.code === 0) {
        failing.push(
          'TOOTH 10 (Superseded+em-dash Superseded-by bypass): expected exit non-0 for ' +
            'ADR with Status=Superseded and **Superseded-by:** — (em-dash) but got exit 0 ' +
            '— the gate accepts em-dash as a valid Superseded-by value, so a Superseded ADR ' +
            'can declare no successor and still pass; the "Superseded must have a pointer" ' +
            'invariant has no bite when the field is present but set to —',
        );
      } else if (
        combined.indexOf('Superseded') === -1 &&
        combined.indexOf('superseded') === -1 &&
        combined.indexOf('pointer') === -1
      ) {
        failing.push(
          'TOOTH 10 (Superseded+em-dash Superseded-by bypass): exited non-0 but output ' +
            'contains none of "Superseded", "superseded", or "pointer" — error message is ' +
            `not actionable. stderr: ${r.stderr.slice(0, 300)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
    detail: '10/10 teeth bite correctly',
  };
}
