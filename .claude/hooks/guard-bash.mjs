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
  const danger = [
    /\brm\s+-\w*r\w*f\w*/i, // rm -rf, -Rf, -rfv ...
    /\brm\s+-\w*f\w*r\w*/i, // rm -fr ...
    /\brm\s+-\w*r\w*\s+-\w*f/i, // rm -r -f
    /\brm\s+(-\w+\s+)*--recursive/i, // rm --recursive ...
    /\brm\s+-\w*r\w*\s+.*(\/|~|\*)/i, // rm -r <root/home/glob>
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
    /(^|[;&|(]\s*)rm\s+[^\n;&|]*\.native-supervisor-disabled/i,
    /(^|[;&|(]\s*)mv\s+[^\n;&|]*\.native-supervisor-disabled/i,
    /(^|[;&|(]\s*)mr-supervisor-enable\b/i,
    /\bdrop\s+database\b/i,
    /\btruncate\s+table\b/i,
  ];
  if (danger.some((re) => re.test(cmd))) {
    console.error("guard: blocked a potentially destructive command. Get explicit human approval.");
    process.exit(2); // 2 = block in Claude Code PreToolUse
  }
  process.exit(0);
});
