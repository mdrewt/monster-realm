# 0209 — The eval harness carries its own completeness guard: a premature exit can no longer end the run at zero

**Status:** Accepted
**Date:** 2026-08-28
**Slice:** rb-5 (residual R-m22-s0-X4)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, tooling-docs
**Decision:** `evals/run.mjs` counts the evals that reported a result and asserts that count against the discovered file count from a `process.on('exit')` handler, raising a zero exit to 1; the same handler raises a zero exit when any eval failed, so the run's verdict no longer rides on the final `process.exit` call alone.

---

## Context and problem statement

`evals/run.mjs` is the whole JavaScript gate tier: `just ci` runs `just eval`, which runs
`node evals/run.mjs`, which globs `evals/*.eval.mjs`, `await import()`s each module into ONE
shared process, calls its default export, prints `eval PASS:` / `eval FAIL:`, counts the
failures, and ends with `process.exit(failed ? 1 : 0)`. 94 eval files ride on that one line.

Every eval's module BODY therefore executes inside the harness process. An eval that calls
`process.exit()` at module scope ends the run where it stands: the remaining evals never
execute, and — the part that makes it dangerous rather than merely noisy — the final
`process.exit(failed ? 1 : 0)` never runs, so the FAIL lines *already printed above it* are
never converted into an exit code. The run exits 0 and CI is green.

This is not hypothetical. Thirteen evals ship a standalone-runner block guarded by
`path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)` whose body ends in
`process.exit(result.pass ? 0 : 1)`. Under the harness `process.argv[1]` is
`<repo>/evals/run.mjs` — a real sibling file in the same directory — so a guard widened to
compare `path.dirname(...)`, or to `endsWith('run.mjs')`, fires at import time. Slice m22-s0
measured exactly that: **37 of 90 evals ran, 3 already-printed `eval FAIL:` lines were
swallowed, `node evals/run.mjs` exited 0, and `just ci` was green** (residual R-m22-s0-X4).
`ARCHITECTURE.md` has recorded the hazard since M22 s0; nothing enforced it.

The harness's only vacuity floor was `files.length === 0`. Nothing asserted that every
*discovered* eval actually produced a result. A gate whose failure mode is "runs less of
itself and reports success" is worse than no gate, because it is indistinguishable from a
green one in the log.

Triage for this slice measured a **second, distinct class** of the same root cause: an eval
whose module body does `process.exit = () => {}` neuters run.mjs's own final call, node then
exits naturally with `process.exitCode === undefined`, and a run with a genuine `eval FAIL:`
exits 0. Both classes are the same defect stated once: *the verdict rode entirely on one
`process.exit` call that any co-resident module could pre-empt or remove.*

## Considered alternatives

- **A — Run each eval in a child process.** Structurally immune: a child that exits early
  cannot take the parent with it. REJECTED. It is a behaviour change, not a fix: several
  gates deliberately depend on the shared realm (`evals/rekey-contract-surface.eval.mjs`
  freezes `REKEY_MANIFEST` precisely *because* "every eval shares ONE module instance under
  `run.mjs`", and rb-3's FG72c performs the suite's one real `Object.prototype` write to
  prove a co-resident eval cannot pollute the G6 manifest — see ADR-0208). Forking per eval
  would silently retire those properties, turn a 39-line harness into a process pool, and
  multiply a ~49 s suite by 94 module-load costs. Wrong slice, and not obviously desirable.

- **B — Monkey-patch `process.exit` in run.mjs before importing anything.** Deterministic
  and not subject to handler ordering. REJECTED: it changes what `process.exit` MEANS for
  every eval in the tree (an eval that legitimately exits would be silently redirected), it
  is itself trivially re-patched by a later import, and it buys nothing against the accidental
  case — which is the whole threat model, since evals are first-party code.

- **C — Assert completeness after the loop.** REJECTED as a non-fix: the code after the loop
  is exactly the code a premature exit skips.

- **D — Count the printed `eval PASS:`/`eval FAIL:` lines from the justfile.** REJECTED:
  moves the invariant out of the file that owns it into a shell pipeline, and `just eval`'s
  body is only required to CONTAIN `node evals/run.mjs` — a wrapper is not enforced anywhere.

- **E — Chosen: an exit-time completeness assertion inside run.mjs.**

## Decision outcome

- **Chosen: E.** `run.mjs` keeps a `completed` counter incremented after each eval's result
  line is printed, and registers — immediately after the zero-eval guard, so `files` is
  populated — a `process.on('exit')` handler that fires on EVERY termination path:

  ```js
  process.on('exit', () => {
    const incomplete = completed !== files.length;
    if (incomplete) console.error('eval: INCOMPLETE RUN — <completed> of <files.length> …');
    if ((incomplete || failed > 0) && !process.exitCode) process.exitCode = 1;
  });
  ```

  This works because of a documented ordering in node's `process.exit(code)`: it assigns
  `process.exitCode`, EMITS `'exit'`, and only THEN reads `process.exitCode` back to really
  exit. A handler can therefore still raise a zero code. Measured on both node versions in
  play here — 24.13.1 (the pinned toolchain) and 18.19.1 (the `mr-gates` CHECK environment):
  a handler setting `exitCode = 7` after `process.exit(0)` yields observed exit 7.

- **Both clauses are measured, not speculative.** `incomplete` is R-m22-s0-X4. `failed > 0`
  is the neutered-`process.exit` class found in triage, and it is what makes the harness's
  verdict independent of its own final call surviving. It costs one term in an existing
  boolean and no new structure.

- **Neither clause clobbers a non-zero code.** A module-scope `process.exit(3)` still exits 3;
  the guard only ever raises 0 (or `undefined`) to 1. A gate that rewrote a real exit code
  would be destroying evidence.

- **Consequences.**
  - Positive: the two measured false-green classes are now loud, and the diagnostic names the
    cause (a module-scope exit / a widened main guard) so the next person does not re-derive it.
  - Positive: the fix is 12 lines in the file that owns the invariant, with no new dependency,
    no new module, and no change to how evals are written or discovered.
  - Negative / accepted: this is defence against ACCIDENTAL truncation, not against a hostile
    eval. Evals are first-party code in this repo. A module that calls `process.reallyExit()`,
    signals itself, or registers its own later `'exit'` handler resetting `process.exitCode`
    still wins; only alternative A closes those, at the cost above. Recorded here so the limit
    is a decision rather than an oversight.
  - Follow-up: `evals/ci-gate-wiring.eval.mjs:426 runMjsIsIntact()` and
    `evals/gate-hardening-config.eval.mjs:54 runMjsHasEvalIsolation()` both source-scan
    `run.mjs`; neither is in this slice's touches, so neither pins the new guard. The
    behavioural proof lives in `evals/run-completeness.eval.mjs` (below), which is stronger
    than a text pin — but adding the guard to `runMjsIsIntact`'s substring list is a cheap
    belt for a later slice that owns that file.

## Proof of teeth (ADR-0010)

`evals/run-completeness.eval.mjs` proves the behaviour, not the source text. Each tooth
copies the REAL `evals/run.mjs` into a `mkdtemp` `<tmp>/evals/`, writes fixture
`*.eval.mjs` files beside it, and spawns `node evals/run.mjs` with `cwd = <tmp>` — run.mjs
resolves `path.resolve('evals')` from the cwd, so the child is the shipped harness running a
controlled corpus. Nothing is ever written inside the worktree.

The teeth are stated in both polarities on purpose: a guard that reds everything is as
useless as one that reds nothing, so a clean corpus must still exit 0 and a genuinely failing
corpus must still exit 1. The suite additionally runs the PRE-FIX harness text against the
same fixtures and asserts it lets them through — the gate's own RED, executed every run, so
it can never decay into a check that passes because the fixtures stopped biting.
