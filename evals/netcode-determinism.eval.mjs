// Netcode-determinism eval: the headless sim-harness replay and the seeded link
// (latency/loss/reorder) must be a pure function of their seed — identical seed
// => identical result — and loss must actually drop some-but-not-all messages.
// This is the substrate M1+ netcode tests (simulated latency/loss) build on.
import { execSync } from 'node:child_process';

// Pure predicate (teeth-tested below).
export function isDeterministic(r) {
  return (
    r.replay_deterministic === true &&
    r.link_deterministic === true &&
    r.delivered > 0 &&
    r.delivered < r.sent
  );
}

export default async function () {
  const name = 'netcode-determinism (sim-harness replay + seeded link)';

  // Proof-of-teeth: predicate MUST reject a non-deterministic report.
  if (isDeterministic({ replay_deterministic: false, link_deterministic: true, delivered: 1, sent: 2 })) {
    return { name, pass: false, detail: 'proof-of-teeth: predicate failed to reject non-determinism' };
  }

  let report;
  try {
    const out = execSync('cargo run -q -p sim-harness --bin netcode_check', { encoding: 'utf8' });
    report = JSON.parse(out.trim());
  } catch (e) {
    return { name, pass: false, detail: `netcode_check bin failed: ${e.message}` };
  }

  const ok = isDeterministic(report);
  return {
    name,
    pass: ok,
    detail: ok
      ? `replay + link deterministic; ${report.delivered}/${report.sent} delivered under loss (teeth verified)`
      : `report: ${JSON.stringify(report)}`,
  };
}
