// netcode-convergence.eval.mjs — M8.8d / M14.5f convergence gate (ADR-0013).
//
// The headline netcode property: under latency/jitter/loss/reorder, the
// authoritative final state is delivery-order-invariant (SeqCanonical policy).
// The naive Arrival policy is order-DEPENDENT under reorder — that divergence is
// the proof-of-teeth (the convergence property is only meaningful if Arrival
// provably fails where SeqCanonical converges).
//
// M14.5f extensions: 128-seed randomized convergence, warp-scenario under link,
// and battle-lock mid-stream freeze check.
//
// This eval shells out to: cargo run -q -p sim-harness --bin netcode_converge
// which emits one JSON line:
//   { "seeds_tested": <int>, "seq_canonical_converges": <bool>,
//     "reorder_occurred": <bool>, "loss_occurred": <bool>,
//     "naive_diverges_on_teeth": <bool>, "randomized_seeds_tested": 128,
//     "randomized_converges": <bool>, "warp_convergence": <bool>,
//     "battle_lock_convergence": <bool> }
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
    r.naive_diverges_on_teeth === true &&
    r.randomized_converges === true &&
    r.warp_convergence === true &&
    r.battle_lock_convergence === true
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
      randomized_converges: true,
      warp_convergence: true,
      battle_lock_convergence: true,
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
      randomized_converges: true,
      warp_convergence: true,
      battle_lock_convergence: true,
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
      randomized_converges: true,
      warp_convergence: true,
      battle_lock_convergence: true,
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
      randomized_converges: true,
      warp_convergence: true,
      battle_lock_convergence: true,
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

  // Tooth E: randomized_converges:false must be rejected.
  // Kills: a convergencePasses that ignores randomized_converges, letting a driver
  // that skips the 128-seed randomized sweep pass the gate.
  if (
    convergencePasses({
      seeds_tested: 16,
      seq_canonical_converges: true,
      reorder_occurred: true,
      loss_occurred: true,
      naive_diverges_on_teeth: true,
      randomized_converges: false,
      warp_convergence: true,
      battle_lock_convergence: true,
    })
  ) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth E: predicate failed to reject {randomized_converges:false} — ' +
        'a convergencePasses that ignores randomized_converges would accept a driver ' +
        'that skips the 128-seed randomized convergence sweep (M14.5f)',
    };
  }

  // Tooth F: warp_convergence:false must be rejected.
  // Kills: a convergencePasses that ignores warp_convergence, letting a driver
  // that skips the warp-scenario-under-link check pass the gate.
  if (
    convergencePasses({
      seeds_tested: 16,
      seq_canonical_converges: true,
      reorder_occurred: true,
      loss_occurred: true,
      naive_diverges_on_teeth: true,
      randomized_converges: true,
      warp_convergence: false,
      battle_lock_convergence: true,
    })
  ) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth F: predicate failed to reject {warp_convergence:false} — ' +
        'a convergencePasses that ignores warp_convergence would accept a driver ' +
        'that skips the warp-scenario convergence under link (M14.5f / 12.5f-1)',
    };
  }

  // Tooth G: battle_lock_convergence:false must be rejected.
  // Kills: a convergencePasses that ignores battle_lock_convergence, letting a driver
  // that skips the battle-lock mid-stream freeze check pass the gate.
  if (
    convergencePasses({
      seeds_tested: 16,
      seq_canonical_converges: true,
      reorder_occurred: true,
      loss_occurred: true,
      naive_diverges_on_teeth: true,
      randomized_converges: true,
      warp_convergence: true,
      battle_lock_convergence: false,
    })
  ) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth G: predicate failed to reject {battle_lock_convergence:false} — ' +
        'a convergencePasses that ignores battle_lock_convergence would accept a driver ' +
        'where the battle-lock freeze is not verified (M14.5f BL-A/BL-B)',
    };
  }

  // -------------------------------------------------------------------------
  // Shell the bin (not yet implemented — this is the RED state until it lands).
  // Handle bin-missing / exec errors by returning pass:false with the error.
  // -------------------------------------------------------------------------
  let report;
  try {
    // timeout: 120000 ms guards against a stalled/regressed bin hanging `just ci`
    // forever (Finding 3). The catch block below returns pass:false on timeout.
    const out = execSync('cargo run -q -p sim-harness --bin netcode_converge', {
      encoding: 'utf8',
      timeout: 120000,
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
      ? `convergence verified across ${report.seeds_tested} seeds + ` +
        `${report.randomized_seeds_tested ?? 0} randomized seeds — ` +
        `SeqCanonical converges, reorder occurred, loss occurred, Arrival diverges on teeth, ` +
        `randomized convergence holds, warp-scenario converges under link, battle-lock freeze verified`
      : `convergence check FAILED: ${JSON.stringify(report)}`,
  };
}
