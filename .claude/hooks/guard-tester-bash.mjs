#!/usr/bin/env node
// PreToolUse guard, SCOPED TO THE "tester" SUBAGENT ONLY (lp-tester-tools).
//
// WHY: tester.md's own doctrine (ownership is split to prevent reward-hacking: the
// specialist implements, the verifier runs) is why tester's frontmatter historically
// carried no Bash at all. A real lp-skills session hit the cost of that absolute
// rule: a tester thread needed to check its own edited file's *syntax* and, with
// zero Bash, substituted 32 manual full-file re-reads across an 87-turn run to
// approximate `bash -n <file>`.
//
// THE FIX IS NOT "give tester Bash" -- an agent's `tools:` frontmatter is bare tool
// names only (`Bash(cmd:*)` scoping exists solely in settings.json permission
// rules, confirmed against Claude Code's own docs), so granting the literal `Bash`
// name would hand tester an unscoped shell and undo the split in one line. Instead
// tester DOES get `Bash`, and THIS hook -- which fires for every Bash call from
// every subagent but only ACTS when the PreToolUse payload's `agent_type` is
// exactly "tester" -- enforces a narrow allowlist against `tool_input.command`.
// Every other agent_type (verifier, red-team, reviewer, the orchestrator, or
// none at all) is a hard no-op: this file must never become a second global
// guard, or it inherits guard-bash.mjs's "an over-firing guard gets switched off"
// lesson for a DIFFERENT reason -- silently restricting agents that are supposed
// to have full Bash.
//
// ALLOWLIST, NOT DENYLIST -- the inversion changes what "wrong" costs. guard-bash.mjs
// is a denylist: a false negative lets damage through, so its comments document
// widening the net repeatedly. Here a false negative BLOCKS a legitimate command
// tester needed -- the 32x-re-read problem again, just relocated. The fail-safe
// direction is therefore the OPPOSITE of guard-bash.mjs's: when in doubt, stay
// narrow and let tester fall back to Read. That is an accepted, deliberate cost.
//
// WHY NOT `--selftest`: the obvious next ask is "let tester run a tool's own
// `--selftest` for something it touched." REJECTED. For a loop-infra tool like
// guard-bash.mjs, `--selftest` IS the test suite -- its own header calls the
// fixtures "TDD RED PHASE (tester-authored)". Letting tester run it against an
// already-implemented tool is letting tester read its own PASS/RED verdict before
// handoff -- the exact reward-hacking channel the no-Bash rule exists to close,
// reopened under a flag name that sounds like a lint check. Only NON-EXECUTING
// static checks are allowlisted below.
//
// ANCHORING. Every pattern is anchored at BOTH ends (^...$) against the ENTIRE
// trimmed command, with the path argument bounded to a narrow character class
// ([\w./-]+) that cannot itself contain a metacharacter -- so `bash -n file.sh &&
// rm -rf /` fails the full-string match (there is trailing content after the path
// the pattern doesn't account for), with no separate "find a bad verb anywhere"
// scan needed the way guard-bash.mjs's denylist requires. No WRAP tolerance either
// -- tester has no legitimate reason to wrap its own syntax check in `sudo`/`time`/
// `env`; a wrapped form just falls to blocked.
//
// TWO DEFECTS CAUGHT AT DESIGN RED-TEAM, BOTH FIXED HERE (the review executed the
// proposed code against this real repo rather than just reasoning about it):
//   1. An earlier draft's metachar pre-check included `;` -- but the ONLY allowed
//      Python shape is a required literal that itself contains one
//      ("import ast,sys;ast.parse(...)"), so that draft made the Python case
//      UNCONDITIONALLY UNREACHABLE, silently reproducing the exact "tester can't
//      verify Python syntax" failure this hook exists to fix, on day one. Fixed:
//      `;` is not in METACHARS. This is safe (not a reopened injection route)
//      because the tight path character class + full-string anchoring already
//      excludes `;` structurally for every allowed shape -- verified directly: none
//      of `bash -n `/`sh -n `/`node --check `/`node -c `/the fixed python literal/
//      `[\w./-]+` can themselves contain a metacharacter, so the anchor alone
//      already rejects `bash -n file.sh; rm -rf /` (there's trailing content after
//      the matched path that the `$` anchor cannot absorb).
//   2. An earlier draft's PATH class ([\w./-]+) placed no constraint on absolute
//      paths or `..` traversal, and these "non-executing" checks were confirmed to
//      ECHO BACK the actual offending source line on a syntax error -- both
//      harness and monster-realm settings.json carry an explicit
//      Read(**/.env|.env.*|*.pem|*.key) deny list for exactly this reason, and the
//      new Bash allowlist had no equivalent, becoming a real content-disclosure
//      oracle against `.pem`/`.env`/`.key`/`.ssh` files anywhere the OS user can
//      read. Fixed: isSafePath() below requires a relative path, rejects any `..`
//      segment, and mirrors the Read tool's own deny extensions.
//
// KNOWN, UNCLOSED GAP (documented per guard-bash.mjs's own "a control you misread
// is worse than no control" culture, not silently assumed away): `node --check`/
// `-c` is NOT unconditionally non-executing -- `NODE_OPTIONS="--require X"` runs X
// before the syntax check. Verified directly (a written side-effect fired). Tester
// cannot set NODE_OPTIONS through this allowlist itself (no WRAP tolerance, no env
// passthrough), and nothing in this repo/environment sets it today -- but "nothing
// sets it today" is not "nothing ever will" in an unattended, long-running loop.
// `bash -n`/`BASH_ENV`, `sh -n`/`ENV` (dash), and `python3 -c`/`PYTHONSTARTUP` were
// all verified genuinely inert against the same class of attack.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PATH_RE = "([\\w./-]+)";
const ALLOW = [
  { re: new RegExp(`^bash -n ${PATH_RE}$`), pathGroup: 1 },
  { re: new RegExp(`^sh -n ${PATH_RE}$`), pathGroup: 1 },
  { re: new RegExp(`^node (?:--check|-c) ${PATH_RE}$`), pathGroup: 1 },
  // Byte-identical to mr-selfcheck's own python-syntax idiom (memory/projects/mr-selfcheck:19) --
  // not a new invention. Only THIS EXACT `-c` payload is allowed; `python3 -c` with any other
  // payload is arbitrary code execution and must never match.
  { re: new RegExp(`^python3 -c (["'])import ast,sys;ast\\.parse\\(open\\(sys\\.argv\\[1\\]\\)\\.read\\(\\)\\)\\1 ${PATH_RE}$`), pathGroup: 2 },
];

// Mirrors settings.json's Read(**/.env|.env.*|*.pem|*.key) deny list -- see defect #2 above.
const DENY_EXT = /\.(env(\.[\w.-]+)?|pem|key)$/i;

function isSafePath(p) {
  if (!p || p.startsWith("/")) return false;              // relative only, never absolute
  if (p.split("/").includes("..")) return false;          // no traversal, any depth
  if (DENY_EXT.test(p)) return false;
  return true;
}

// Deliberately excludes ';' -- see defect #1 above.
const METACHARS = /[&|`\n<>$]/;

function isAllowedForTester(cmd) {
  const trimmed = (cmd ?? "").trim();
  if (METACHARS.test(trimmed)) return false;
  for (const { re, pathGroup } of ALLOW) {
    const m = re.exec(trimmed);
    if (m && isSafePath(m[pathGroup])) return true;
  }
  return false;
}

if (process.argv[2] === "--selftest") {
  process.exit(runSelftest());
} else {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let payload = {};
    try {
      payload = JSON.parse(raw) ?? {};
    } catch {
      process.exit(0); // not a Bash call / no input -- no-op
    }
    // THE SCOPE GATE. Exact-string match only -- "Tester"/"tester2"/absent all fall
    // through to no-op. This is the ONLY line that makes this hook agent-scoped
    // rather than a second global guard.
    if (payload.agent_type !== "tester") process.exit(0);

    const cmd = payload?.tool_input?.command ?? "";
    if (isAllowedForTester(cmd)) process.exit(0);

    console.error(
      "tester-guard: blocked. tester may only run static, non-executing checks -- " +
      "`bash -n <file>`, `sh -n <file>`, `node --check <file>`, or the exact " +
      "`python3 -c \"import ast,sys;ast.parse(open(sys.argv[1]).read())\" <file>` " +
      "AST-parse check, on a RELATIVE path with no .env/.pem/.key target -- never a " +
      "build, test-suite, or --selftest invocation (that is the verifier's job). " +
      "Re-read the file instead, or hand off to the verifier."
    );
    process.exit(2);
  });
}

// ==========================================================================================
// SELFTEST -- mirrors guard-bash.mjs's pattern: spawn the REAL process per fixture via
// spawnSync, assert exit codes only, never the regex array directly, so broken stdin/
// agent_type wiring fails exactly as it would in production.
// ==========================================================================================
function runFixture(agentType, cmd) {
  const input = { tool_name: "Bash", tool_input: { command: cmd } };
  if (agentType !== undefined) input.agent_type = agentType;
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 10_000,
  });
  return r.status;
}

function runSelftest() {
  let bad = 0;
  const results = [];
  function check(name, agentType, cmd, expectBlocked) {
    const status = runFixture(agentType, cmd);
    const blocked = status === 2;
    const ok = blocked === expectBlocked;
    results.push([name, ok, status, expectBlocked]);
    if (!ok) bad = 1;
  }

  // tester: ALLOWED
  check("tester: bash -n on a relative file", "tester", "bash -n memory/projects/mr-spawn", false);
  check("tester: sh -n", "tester", "sh -n memory/projects/mr-record", false);
  check("tester: node --check", "tester", "node --check .claude/hooks/guard-tester-bash.mjs", false);
  check("tester: node -c", "tester", "node -c .claude/hooks/guard-tester-bash.mjs", false);
  check("tester: exact python ast.parse idiom (double-quoted)", "tester",
    'python3 -c "import ast,sys;ast.parse(open(sys.argv[1]).read())" memory/projects/mr-audit', false);
  check("tester: exact python ast.parse idiom (single-quoted)", "tester",
    "python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read())' memory/projects/mr-audit", false);

  // tester: BLOCKED -- real test suite / build / implementation
  check("tester: npm test", "tester", "npm test", true);
  check("tester: npm run build", "tester", "npm run build", true);
  check("tester: cargo test", "tester", "cargo test", true);
  check("tester: vitest run", "tester", "vitest run", true);
  check("tester: cargo build", "tester", "cargo build", true);
  check("tester: spacetime publish", "tester", "spacetime publish", true);

  // tester: BLOCKED -- --selftest deliberately excluded (see header)
  check("tester: mr-hold --selftest (a gating fixture battery, not a lint check)",
    "tester", "memory/projects/mr-hold --selftest", true);
  check("tester: guard-bash.mjs --selftest", "tester", "node .claude/hooks/guard-bash.mjs --selftest", true);
  check("tester: this hook's own --selftest, via Bash", "tester",
    "node .claude/hooks/guard-tester-bash.mjs --selftest", true);

  // tester: BLOCKED -- metachar / compounding smuggling
  check("tester: chained bash -n then rm -rf", "tester", "bash -n file.sh && rm -rf /", true);
  check("tester: command substitution in path", "tester", "bash -n $(echo evil)", true);
  check("tester: semicolon smuggling (regression: must stay blocked even though ';' left METACHARS)",
    "tester", "bash -n file.sh; rm -rf /", true);
  check("tester: pipe smuggling", "tester", "bash -n file.sh | sh", true);
  check("tester: arbitrary python -c payload (not the exact idiom)", "tester",
    "python3 -c \"import os;os.system('rm -rf /')\"", true);
  check("tester: bash -n on two paths (only the first would be checked)", "tester", "bash -n a.sh b.sh", true);

  // tester: BLOCKED -- content-disclosure regression (design-review finding #2)
  check("tester: absolute path (content-disclosure oracle)", "tester", "bash -n /etc/passwd", true);
  check("tester: .. traversal", "tester", "bash -n ../../etc/passwd", true);
  check("tester: .env target", "tester", "node --check config.env", true);
  check("tester: .pem target", "tester", "bash -n secrets/id.pem", true);
  check("tester: .key target", "tester", "sh -n secrets/server.key", true);
  check("tester: .env.local target", "tester", "bash -n .env.local", true);

  // SCOPE PROOF -- same blocked commands, other agent_type, must be untouched
  check("verifier: npm test untouched by THIS hook", "verifier", "npm test", false);
  check("verifier: mr-hold --selftest untouched", "verifier", "memory/projects/mr-hold --selftest", false);
  check("red-team: cargo build untouched", "red-team", "cargo build", false);
  check("reviewer: rm -rf untouched (guard-bash.mjs's job, not this one)", "reviewer", "rm -rf /tmp/x", false);
  check("no agent_type (top-level orchestrator): npm test untouched", undefined, "npm test", false);
  check("case-sensitivity: 'Tester' (capital T) is NOT scoped in", "Tester", "npm test", false);

  for (const [name, ok, status, expectBlocked] of results) {
    if (!ok) console.log(`TESTER-GUARD-SELFTEST-FAIL ${name} (exit=${status}, expected ${expectBlocked ? "blocked(2)" : "allowed(0)"})`);
  }
  if (!bad) console.log(`TESTER-GUARD-SELFTEST-OK ${results.length} fixtures`);
  return bad;
}
