//! Netcode-determinism check for the eval: runs the replay + seeded link twice
//! and reports (as JSON) that both are deterministic and that loss actually drops
//! some-but-not-all messages. Pure function of seeds — no wall clock.

use sim_harness::{replay, Link, Msg};

fn main() {
    let replay_deterministic = replay(500, 0xABCD) == replay(500, 0xABCD);

    let link = Link {
        base_latency: 50,
        jitter: 20,
        loss_pct: 25,
    };
    let msgs: Vec<Msg> = (0..300)
        .map(|id| Msg {
            id,
            send_ms: id * 16,
        })
        .collect();
    let a = link.transport(&msgs, 0xBEEF);
    let b = link.transport(&msgs, 0xBEEF);
    let link_deterministic = a == b;

    println!(
        "{{\"replay_deterministic\":{replay_deterministic},\"link_deterministic\":{link_deterministic},\"delivered\":{},\"sent\":{}}}",
        a.len(),
        msgs.len()
    );
}
