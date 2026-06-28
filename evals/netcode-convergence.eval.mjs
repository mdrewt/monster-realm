// netcode-convergence.eval.mjs — M8.8d convergence gate (ADR-0013).
//
// The headline netcode property: under latency/jitter/loss/reorder, the
// authoritative final state is delivery-order-invariant (SeqCanonical policy).
// The naive Arrival policy is order-DEPENDENT under reorder — that divergence is
// the proof-of-teeth (the convergence property is only meaningful if Arrival
// provably fails where SeqCanonical converges).
//
// This eval shells out to: cargo run -q -p sim-harness --bin netcode_converge
// which emits one JSON line:
//   { "seeds_tested": <int>, "seq_canonical_converges": <bool>,
//     "reorder_occurred": <bool>, "loss_occurred": <bool>,
//     "naive_diverges_on_teeth": <bool> }
//
// Contract: default export async () => { name, pass, detail }
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Pure predicate (exported for import by gate-teeth or other evals).
// Returns true iff ALL four convergence criteria are met:
//   1. SeqCanonical gives order-invariant final state across tested seeds
//   2. Reorder actually occurred (jitter:0 regression caught if false)
//   3. Loss actually dropped some intents (loss_pct ignored caught if false)
//   4. Arrival policy diverges on the known-bad reorder fixture (vacuity guard)
// ---------------------------------------------------------------------------
export function convergencePasses(r) {
  return (
    r.seq_canonical_converges === true &&
    r.reorder_occurred === true &&
    r.loss_occurred === true &&
    r.naive_diverges_on_teeth === true
  );
}

export default async function () {
  const name =
    'netcode-convergence (M8.8d: SeqCanonical order-invariant, Arrival diverges, reorder+loss occur)';

  // -------------------------------------------------------------------------
  // Inline proof-of-teeth: predicate MUST reject each of these known-bad reports.
  // These run with NO bin — if any known-bad report passes the predicate, the
  // eval returns RED immediately (the predicate has no teeth).
  // -------------------------------------------------------------------------

  // Tooth A: seq_canonical_converges:false must be rejected.
  // Kills: a convergencePasses that ignores seq_canonical_converges.
  if (
    convergencePasses({
      seeds_tested: 6,
      seq_canonical_converges: false,
      reorder_occurred: true,
      loss_occurred: true,
      naive_diverges_on_teeth: true,
    })
  ) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth A: predicate failed to reject {seq_canonical_converges:false} — ' +
        'a convergencePasses that ignores seq_canonical_converges would wrongly pass a ' +
        'broken driver that does not sort by seq',
    };
  }

  // Tooth B: reorder_occurred:false must be rejected.
  // Kills: a convergencePasses that ignores reorder_occurred, which would let a
  // jitter:0 regression (no actual reorder) pass without notice.
  if (
    convergencePasses({
      seeds_tested: 6,
      seq_canonical_converges: true,
      reorder_occurred: false,
      loss_occurred: true,
      naive_diverges_on_teeth: true,
    })
  ) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth B: predicate failed to reject {reorder_occurred:false} — ' +
        'a convergencePasses that ignores reorder_occurred would silently pass a ' +
        'jitter:0 regression where reorder never actually occurs (vacuous convergence)',
    };
  }

  // Tooth C: naive_diverges_on_teeth:false must be rejected.
  // Kills: a convergencePasses that skips the Arrival-diverges check — without
  // this, the convergence property is vacuous (a policy that always converges
  // trivially satisfies the property even if it is the wrong policy).
  if (
    convergencePasses({
      seeds_tested: 6,
      seq_canonical_converges: true,
      reorder_occurred: true,
      loss_occurred: true,
      naive_diverges_on_teeth: false,
    })
  ) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth C: predicate failed to reject {naive_diverges_on_teeth:false} — ' +
        'a convergencePasses that ignores naive_diverges_on_teeth would accept a driver ' +
        'where Arrival does not diverge (e.g., Arrival secretly re-sorts by seq), ' +
        'making the convergence property vacuous',
    };
  }

  // Tooth D: loss_occurred:false must be rejected.
  // Kills: a convergencePasses that ignores loss_occurred, letting a deliver()
  // that silently ignores loss_pct pass the gate.
  if (
    convergencePasses({
      seeds_tested: 6,
      seq_canonical_converges: true,
      reorder_occurred: true,
      loss_occurred: false,
      naive_diverges_on_teeth: true,
    })
  ) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth D: predicate failed to reject {loss_occurred:false} — ' +
        'a convergencePasses that ignores loss_occurred would pass a driver that ' +
        'delivers every intent regardless of loss_pct (loss simulation broken)',
    };
  }

  // -------------------------------------------------------------------------
  // Shell the bin (not yet implemented — this is the RED state until it lands).
  // Handle bin-missing / exec errors by returning pass:false with the error.
  // -------------------------------------------------------------------------
  let report;
  try {
    const out = execSync('cargo run -q -p sim-harness --bin netcode_converge', {
      encoding: 'utf8',
    });
    report = JSON.parse(out.trim());
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `netcode_converge bin failed (expected RED until M8.8d driver is implemented): ${e.message}`,
    };
  }

  const ok = convergencePasses(report);
  return {
    name,
    pass: ok,
    detail: ok
      ? `convergence verified across ${report.seeds_tested} seeds — ` +
        `SeqCanonical converges, reorder occurred, loss occurred, Arrival diverges on teeth`
      : `convergence check FAILED: ${JSON.stringify(report)}`,
  };
}
