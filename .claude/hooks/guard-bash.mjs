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
  const danger = [
    /(^\s*|[;&|(\n]\s*)rm\s+-\w*r\w*f\w*/i, // rm -rf, -Rf, -rfv ...
    /(^\s*|[;&|(\n]\s*)rm\s+-\w*f\w*r\w*/i, // rm -fr ...
    /(^\s*|[;&|(\n]\s*)rm\s+-\w*r\w*\s+-\w*f/i, // rm -r -f
    /(^\s*|[;&|(\n]\s*)rm\s+(-\w+\s+)*--recursive/i, // rm --recursive ...
    /(^\s*|[;&|(\n]\s*)rm\s+-\w*r\w*\s+.*(\/|~|\*)/i, // rm -r <root/home/glob>
    /(^\s*|[;&|(\n]\s*)(xargs|parallel)\s+(-\S+\s+)*rm\b/i, // find … | xargs rm -rf
    /\bfind\b[^\n;&|]*-exec\s+rm\b/i, // find … -exec rm -rf {} \;
    /git\s+push\s+(--force|-f)\b/i,
    /git\s+reset\s+--hard\s+origin/i,
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
    /(^\s*|[;&|(\n]\s*)rm\s+[^\n;&|]*\.native-supervisor-disabled/i,
    /(^\s*|[;&|(\n]\s*)mv\s+[^\n;&|]*\.native-supervisor-disabled/i,
    /(^\s*|[;&|(\n]\s*)mr-supervisor-enable\b/i,
    /\bdrop\s+database\b/i,
    /\btruncate\s+table\b/i,
  ];
  if (danger.some((re) => re.test(cmd))) {
    console.error("guard: blocked a potentially destructive command. Get explicit human approval.");
    process.exit(2); // 2 = block in Claude Code PreToolUse
  }
  process.exit(0);
});
