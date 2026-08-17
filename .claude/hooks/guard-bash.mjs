#!/usr/bin/env node
// PreToolUse guard (cross-platform; Node is a prerequisite). Blocks clearly
// destructive shell commands as defense-in-depth behind the permission deny-list.
// Reads the hook payload JSON on stdin; exit 2 blocks the tool call.
// Replaces the old bash-only guard-bash.sh (which would not run on Windows).
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = JSON.parse(raw)?.tool_input?.command ?? "";
  } catch {
    /* not a Bash call / no input */
  }
  // Defense-in-depth: catch common flag spellings (-rf, -fr, -r -f, --recursive
  // / --force), not only the literal "rm -rf" the deny-list matches.
  // ANCHORED AT COMMAND POSITION (lp-11a), matching the harness copy. `\brm\s+-rf` matched those
  // characters ANYWHERE, including inside a quoted argument, so `grep -n 'rm -rf' notes.md` was
  // refused: reading about the command was as forbidden as running it. Anchoring alone would lose
  // indirection, so `xargs`/`find -exec` are restored explicitly below.
  //
  // NOTE ON DRIFT: this copy is the slim one — the harness copy at
  // ../../../.claude/hooks/guard-bash.mjs carries the `--selftest` fixture suite (58 of them) that
  // pins every rule here in BOTH directions. These two files have drifted before (this copy still
  // had lp-09's pre-widening kill-switch anchors, fixed below), so change them together.
  // Command position TOLERATES WRAPPERS, one shared definition. A naive anchor stops the guard
  // blocking prose but also stops it seeing `sudo rm -rf /` — the verb is no longer at index 0, so
  // the rule just misses. Measured: 14 of 15 destructive shapes went through, `sudo rm <kill
  // switch>` among them. Each wrapper may carry up to 4 of its own arguments (`sudo -u nobody`,
  // `nice -n 5`, `env FOO=1`) and wrappers may nest (`time sudo …`); the bound keeps the clause
  // from swallowing a pipeline to find a verb far away. The harness copy pins all of this with 77
  // --selftest fixtures in both directions.
  const AT = "(?:^|[;&|(\\n])\\s*";
  const WRAP =
    "(?:(?:env|sudo|doas|command|nohup|time|exec|nice|setsid|stdbuf|timeout)\\s+(?:[^\\s;&|]+\\s+){0,4})*";
  const at = (rest) => new RegExp(AT + WRAP + rest, "i");
  const danger = [
    at("rm\\s+-\\w*r\\w*f\\w*"), // rm -rf, -Rf, -rfv ...
    at("rm\\s+-\\w*f\\w*r\\w*"), // rm -fr ...
    at("rm\\s+-\\w*r\\w*\\s+-\\w*f"), // rm -r -f
    at("rm\\s+(?:-\\w+\\s+)*--recursive"), // rm --recursive ...
    at("rm\\s+-\\w*r\\w*\\s+.*(?:\\/|~|\\*)"), // rm -r <root/home/glob>
    // xargs/parallel stay OUT of WRAP: they must also block `xargs rm` when the filename is
    // upstream and no -rf appears at all.
    at("(?:xargs|parallel)\\s+(?:-\\S+\\s+)*rm\\b"), // find … | xargs rm
    /\bfind\b[^\n;&|]*-exec\s+rm\b/i, // find … -exec rm {} \;
    at("git\\s+push\\s+(?:--force|-f)\\b"),
    at("git\\s+reset\\s+--hard\\s+origin"),
    // lp-09: the supervisor kill switch. The tick only ever READS this flag — every clear came from
    // an LLM session running `rm`, which is why provenance had to be enforced somewhere the model
    // cannot route around. `mr-hold clear` is the sanctioned path and checks provenance; it does not
    // name the file, so it is unaffected. `mr-supervisor-enable` is the OPERATOR's clear and is
    // blocked here on purpose — the operator runs it in their own terminal, not through a session.
    //
    // These are anchored at COMMAND POSITION (start, or after ; && || | & or a subshell paren), not
    // as bare substrings. The first version matched anywhere and blocked merely *writing about* the
    // kill switch — it blocked this slice's own documentation and test scripts. An over-firing guard
    // is worse than a narrow one: it gets switched off, which is how decorative gates are born. This
    // is defense-in-depth behind `mr-hold`'s provenance check, not a sandbox.
    // Anchor WIDENED to parity with the harness copy (lp-09 found this by execution, lp-11a
    // carried it across): `(^|…)` without `\s*` and without `\n` required the verb at literal
    // index 0 — these regexes carry no `m` flag — so an ordinary two-line Bash call, or a single
    // leading space, matched nothing at all. Widening can only ever block MORE, which is the
    // fail-safe direction for a kill switch.
    at("rm\\s+[^\\n;&|]*\\.native-supervisor-disabled"),
    at("mv\\s+[^\\n;&|]*\\.native-supervisor-disabled"),
    at("mr-supervisor-enable\\b"),
    // Symmetric with enable: mr-supervisor-disable routes through `mr-hold set --by operator`,
    // which nothing restricts by caller, so a session running it creates a PERMANENT operator hold
    // that also carries provenance and therefore never trips the tick's unattributed escalation.
    // Sessions self-pause with `mr-hold set --by supervisor` (self-clearable), which stays allowed.
    at("mr-supervisor-disable\\b"),
    /\bdrop\s+database\b/i,
    /\btruncate\s+table\b/i,
  ];
  if (danger.some((re) => re.test(cmd))) {
    console.error("guard: blocked a potentially destructive command. Get explicit human approval.");
    process.exit(2); // 2 = block in Claude Code PreToolUse
  }
  process.exit(0);
});
