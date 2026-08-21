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
// none at all) is a hard no-op.
//
// SEE ALSO guard-tester-write.mjs -- Bash restriction alone is not the whole
// control. tester's PRE-EXISTING Write/Edit tools are unscoped by Claude Code
// (no path-scoping mechanism exists for those tools either), so a Bash-only guard
// is one Edit call away from being disabled by the very agent it constrains --
// tester could simply Edit this file's ALLOW array, or edit settings.json to
// remove the hook registration entirely, then use the top-level `permissions.
// allow` list's pre-existing `Bash(npm:*)`/`Bash(cargo:*)`/`Bash(pytest:*)` grants
// to run the real test suite. guard-tester-write.mjs closes that by blocking
// tester from writing anywhere under `.claude/` at all -- caught at a SECOND,
// independent post-implementation review pass (this repo's own process: ship,
// then have a fresh adversarial read try to break the actual shipped code, not
// just the design).
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
// ANCHORING. Every command pattern is anchored at BOTH ends (^...$) against the
// ENTIRE trimmed command, with the path argument bounded to a narrow character
// class ([\w./-]+) that cannot itself contain a metacharacter -- so `bash -n
// file.sh && rm -rf /` fails the full-string match (there is trailing content
// after the path the pattern doesn't account for). No WRAP tolerance -- tester
// has no legitimate reason to wrap its own syntax check in `sudo`/`time`/`env`;
// a wrapped form just falls to blocked.
//
// PATH SAFETY, TWO LAYERS (the second layer added at post-implementation review
// after real content disclosure was proven -- see below):
//   Layer 1 (string shape): relative only, no `..` traversal, no path segment
//     starting with `.` (blocks .npmrc/.netrc/.git-credentials/.pgpass/.env* and
//     any hidden directory in one rule, rather than enumerating extensions).
//   Layer 2 (filesystem reality): resolve the REAL path (following symlinks),
//     require it to still be a regular file *inside* the project root, and
//     require it to match a recognised extension for its shape (.sh/.bash for
//     bash & sh; .js/.mjs/.cjs/.ts/.tsx for node; .py for python) OR -- bash/sh
//     only, since this repo's own tools (mr-record, mr-spawn, ...) are
//     conventionally extensionless -- start with a `#!` shebang.
//
// TWO DEFECTS CAUGHT AT DESIGN RED-TEAM (fixed before first ship, both regression-
// tested below):
//   1. An earlier draft's metachar pre-check included `;` -- but the ONLY allowed
//      Python shape is a required literal that itself contains one
//      ("import ast,sys;ast.parse(...)"), making the Python case UNCONDITIONALLY
//      UNREACHABLE. Fixed: `;` is not in METACHARS (safe -- the tight path
//      character class + full-string anchoring already excludes injection
//      structurally for every allowed shape).
//   2a. An earlier draft's path check (Layer 1 only, `.env`/`.pem`/`.key` suffix
//      denylist) was proven, by actually running the shipped hook, to still
//      ALLOW and DISCLOSE THE CONTENT of `.npmrc`, `id_rsa`, `.git-credentials`,
//      and any other secret-bearing file whose name doesn't end in one of three
//      guessed extensions -- a suffix denylist can never enumerate an unbounded
//      naming space. Fixed by Layer 1's "no dotfile segment" rule (closes the
//      dotfile-convention half) plus Layer 2's extension/shebang allowlist
//      (closes extensionless secret files like a bare `id_rsa`).
//   2b. The same review proved a SEPARATE structural gap: the path-shape check
//      alone says nothing about what a path actually RESOLVES to. A relative,
//      safe-LOOKING, correctly-extensioned name (`foo.sh`) can be a symlink to
//      anywhere the OS user can read (proved with a real repo artifact,
//      node_modules/.bin/biome, an ordinary npm bin-symlink whose *target* got
//      echoed on a syntax failure) -- and a relative name resolving to a FIFO
//      makes `bash -n`/`sh -n` hang indefinitely on open() (proved directly,
//      required SIGKILL). Fixed by Layer 2's realpath-then-statSync(isFile())
//      check: statSync never blocks on a FIFO/device/socket (blocking is an
//      open()-time behavior, not a stat()-time one), so an indefinite hang is
//      structurally impossible here, and a symlink whose real target either
//      leaves the project root or isn't a regular file is rejected before the
//      actual Bash tool call is ever permitted to run.
//
// KNOWN, UNCLOSED GAP (documented per guard-bash.mjs's own "a control you misread
// is worse than no control" culture, not silently assumed away): `node --check`/
// `-c` is NOT unconditionally non-executing -- `NODE_OPTIONS="--require X"` runs X
// before the syntax check. Verified directly (a written side-effect fired). Tester
// cannot set NODE_OPTIONS through this allowlist itself (no WRAP tolerance, no env
// passthrough), and nothing in this repo/environment sets it today -- but "nothing
// sets it today" is not "nothing ever will" in an unattended, long-running loop.
// `bash -n`/`BASH_ENV`, `sh -n`/`ENV` (dash), and `python3 -c`/`PYTHONSTARTUP` were
// all verified genuinely inert against the same class of attack. Also: a bare `-`
// path argument (meaning "read the script from stdin" to bash/sh/node) is rejected
// explicitly by Layer 2's realpath check (no file is ever literally named `-`) --
// called out here because relying on that implicitly would be fragile; the reject
// is now also explicit in isSafePath for clarity.
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  realpathSync, statSync, openSync, readSync, closeSync,
  mkdirSync, writeFileSync, symlinkSync, rmSync,
} from "node:fs";
import path from "node:path";

const PROJECT_ROOT = (() => {
  try {
    return realpathSync(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  } catch {
    return process.cwd();
  }
})();

const PATH_RE = "([\\w./-]+)";
const ALLOW = [
  { re: new RegExp(`^bash -n ${PATH_RE}$`), pathGroup: 1, shape: "shell" },
  { re: new RegExp(`^sh -n ${PATH_RE}$`), pathGroup: 1, shape: "shell" },
  { re: new RegExp(`^node (?:--check|-c) ${PATH_RE}$`), pathGroup: 1, shape: "node" },
  // Byte-identical to mr-selfcheck's own python-syntax idiom (memory/projects/mr-selfcheck:19) --
  // not a new invention. Only THIS EXACT `-c` payload is allowed; `python3 -c` with any other
  // payload is arbitrary code execution and must never match.
  { re: new RegExp(`^python3 -c (["'])import ast,sys;ast\\.parse\\(open\\(sys\\.argv\\[1\\]\\)\\.read\\(\\)\\)\\1 ${PATH_RE}$`), pathGroup: 2, shape: "python" },
];

const EXT_BY_SHAPE = {
  shell: new Set([".sh", ".bash"]),
  node: new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]),
  python: new Set([".py"]),
};

function extOf(p) {
  const base = path.basename(p);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // dot<=0 covers no-extension AND a dotfile-as-whole-name (".npmrc")
  return base.slice(dot).toLowerCase();
}

// Bounded, non-blocking read of the first 2 bytes -- only ever called AFTER statSync has already
// confirmed the target is a regular file, so this can't hang on a FIFO/device.
function startsWithShebang(realPath) {
  let fd;
  try {
    fd = openSync(realPath, "r");
    const buf = Buffer.alloc(2);
    const n = readSync(fd, buf, 0, 2, 0);
    return n === 2 && buf.toString("utf8") === "#!";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

// Directory segments that are legitimately hidden-but-not-secret parts of THIS repo's own
// tooling (tester needs to be able to syntax-check e.g. .claude/hooks/*.mjs). Everything else
// dot-prefixed -- a directory segment OR the filename itself -- is treated as the
// secret-convention shape (.ssh/, .npmrc, .netrc, .git-credentials, .env*, .pgpass, ...) and
// rejected. The filename itself is NEVER allowed to be dot-prefixed, even inside an allowed dir
// (so .claude/.env would still be blocked).
const ALLOWED_DOT_DIRS = new Set([".claude"]);

function isSafePath(p, shape) {
  if (!p || p === "-") return false; // "-" means "read from stdin" to bash/sh/node
  if (p.startsWith("/")) return false; // relative only, never absolute
  const segs = p.split("/");
  if (segs.includes("..")) return false; // no traversal, any depth
  const dirSegs = segs.slice(0, -1);
  const base = segs[segs.length - 1];
  if (base.startsWith(".")) return false; // the file itself must never be a dotfile
  if (dirSegs.some((s) => s.startsWith(".") && !ALLOWED_DOT_DIRS.has(s))) return false;

  let real;
  try {
    real = realpathSync(path.join(PROJECT_ROOT, p));
  } catch {
    return false; // ENOENT/ELOOP/permission -- fail closed
  }
  const rel = path.relative(PROJECT_ROOT, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false; // symlink escaped the project root

  let st;
  try {
    st = statSync(real);
  } catch {
    return false;
  }
  if (!st.isFile()) return false; // rejects FIFO / directory / device / socket -- statSync never blocks on these

  const ext = extOf(real);
  if (EXT_BY_SHAPE[shape].has(ext)) return true;
  if (ext === "" && shape === "shell") {
    // Extensionless shell scripts are this repo's own convention (mr-record, mr-spawn,
    // mr-selfcheck, ...). Require an ACTUAL shebang, not merely an absent extension, so a bare
    // secret-shaped filename (id_rsa, credentials) can't ride the same allowance.
    return startsWithShebang(real);
  }
  return false;
}

// Deliberately excludes ';' -- see defect #1 above.
const METACHARS = /[&|`\n<>$]/;

function isAllowedForTester(cmd) {
  const trimmed = (cmd ?? "").trim();
  if (METACHARS.test(trimmed)) return false;
  for (const { re, pathGroup, shape } of ALLOW) {
    const m = re.exec(trimmed);
    if (m && isSafePath(m[pathGroup], shape)) return true;
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
      "AST-parse check, on a relative, non-traversing, non-dotfile path that resolves " +
      "(after following symlinks) to a regular file inside the project with a recognised " +
      "extension (or a shebang, for extensionless shell scripts) -- never a build, " +
      "test-suite, or --selftest invocation (that is the verifier's job). Re-read the " +
      "file instead, or hand off to the verifier."
    );
    process.exit(2);
  });
}

// ==========================================================================================
// SELFTEST -- mirrors guard-bash.mjs's pattern: spawn the REAL process per fixture via
// spawnSync, assert exit codes only, never the regex array directly, so broken stdin/
// agent_type wiring fails exactly as it would in production. Builds a small scratch
// directory of real fixture artifacts (files, a symlink, a FIFO where mkfifo is available)
// under the project root, and always removes it, even on failure.
// ==========================================================================================
function runFixture(agentType, cmd) {
  const input = { tool_name: "Bash", tool_input: { command: cmd } };
  if (agentType !== undefined) input.agent_type = agentType;
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 10_000, cwd: PROJECT_ROOT,
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

  const scratchRel = "tester-guard-selftest-scratch";
  const scratch = path.join(PROJECT_ROOT, scratchRel);

  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  let fifoAvailable = false;
  try {
    // tester: ALLOWED. Uses scratch-created fixtures, not real repo paths -- this hook is
    // vendored identically into both the harness and monster-realm repos (lp-09 precedent), and
    // a fixture pointing at a harness-only path (e.g. memory/projects/mr-spawn) would silently
    // fail its own selftest in the other repo. Caught at post-implementation review: the first
    // shipped version did exactly this and failed SELFCHECK-OK only in monster-realm.
    writeFileSync(path.join(scratch, "extensionless-tool"), "#!/bin/bash\necho ok\n");
    check("tester: bash -n on a relative extensionless shebang'd tool", "tester", `bash -n ${scratchRel}/extensionless-tool`, false);
    check("tester: sh -n", "tester", `sh -n ${scratchRel}/extensionless-tool`, false);
    check("tester: node --check", "tester", "node --check .claude/hooks/guard-tester-bash.mjs", false);
    check("tester: node -c", "tester", "node -c .claude/hooks/guard-tester-bash.mjs", false);

    writeFileSync(path.join(scratch, "ok.py"), "x = 1\n");
    check("tester: exact python ast.parse idiom on a real .py file (double-quoted)", "tester",
      `python3 -c "import ast,sys;ast.parse(open(sys.argv[1]).read())" ${scratchRel}/ok.py`, false);
    check("tester: exact python ast.parse idiom (single-quoted)", "tester",
      `python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read())' ${scratchRel}/ok.py`, false);

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

    // tester: BLOCKED -- path-shape rejections
    check("tester: absolute path", "tester", "bash -n /etc/passwd", true);
    check("tester: .. traversal", "tester", "bash -n ../../etc/passwd", true);
    check("tester: .env target (wrong extension for shell shape)", "tester", `node --check ${scratchRel}/config.env`, true);
    check("tester: bare '-' (stdin sentinel)", "tester", "bash -n -", true);

    // tester: BLOCKED -- REGRESSION for post-implementation review defect #2a (content
    // disclosure via secret-shaped filenames that never matched a suffix denylist)
    writeFileSync(path.join(scratch, ".npmrc"), "//registry.npmjs.org/:_authToken=SECRET\n");
    check("tester: .npmrc (dotfile secret, wrong shape)", "tester", `bash -n ${scratchRel}/.npmrc`, true);
    writeFileSync(path.join(scratch, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n");
    check("tester: id_rsa (extensionless, no shebang -> not a script)", "tester", `bash -n ${scratchRel}/id_rsa`, true);
    writeFileSync(path.join(scratch, "notes.txt"), "not code\n");
    check("tester: notes.txt (unrecognised extension)", "tester", `bash -n ${scratchRel}/notes.txt`, true);

    // tester: BLOCKED -- REGRESSION for post-implementation review defect #2b (a safe-looking,
    // correctly-extensioned relative path can be a symlink resolving outside the project root)
    const outside = path.join(PROJECT_ROOT, "..", "tester-guard-selftest-outside.txt");
    writeFileSync(outside, "outside-the-project-root\n");
    try {
      symlinkSync(outside, path.join(scratch, "looks-safe.sh"));
      check("tester: relative .sh path that's actually a symlink leaving the project root",
        "tester", `bash -n ${scratchRel}/looks-safe.sh`, true);
    } finally {
      rmSync(outside, { force: true });
    }

    // tester: BLOCKED -- REGRESSION for the FIFO-hang half of defect #2b. mkfifo isn't
    // guaranteed cross-platform (guard-bash.mjs's own header notes this codebase targets
    // cross-platform + Node); skip gracefully rather than fail the whole suite where it's
    // unavailable, but if it IS available this must return promptly (not hang) and be blocked.
    try {
      execFileSync("mkfifo", [path.join(scratch, "probe.sh")], { stdio: "ignore" });
      fifoAvailable = true;
    } catch {
      fifoAvailable = false;
    }
    if (fifoAvailable) {
      const t0 = Date.now();
      check("tester: relative .sh path that's actually a FIFO (must reject promptly, never hang)",
        "tester", `bash -n ${scratchRel}/probe.sh`, true);
      const elapsed = Date.now() - t0;
      if (elapsed > 5000) {
        bad = 1;
        console.log(`TESTER-GUARD-SELFTEST-FAIL FIFO check took ${elapsed}ms -- statSync should never block on a FIFO`);
      }
    }

    // SCOPE PROOF -- same blocked commands, other agent_type, must be untouched
    check("verifier: npm test untouched by THIS hook", "verifier", "npm test", false);
    check("verifier: mr-hold --selftest untouched", "verifier", "memory/projects/mr-hold --selftest", false);
    check("red-team: cargo build untouched", "red-team", "cargo build", false);
    check("reviewer: rm -rf untouched (guard-bash.mjs's job, not this one)", "reviewer", "rm -rf /tmp/x", false);
    check("no agent_type (top-level orchestrator): npm test untouched", undefined, "npm test", false);
    check("case-sensitivity: 'Tester' (capital T) is NOT scoped in", "Tester", "npm test", false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  for (const [name, ok, status, expectBlocked] of results) {
    if (!ok) console.log(`TESTER-GUARD-SELFTEST-FAIL ${name} (exit=${status}, expected ${expectBlocked ? "blocked(2)" : "allowed(0)"})`);
  }
  if (!bad) console.log(`TESTER-GUARD-SELFTEST-OK ${results.length} fixtures${fifoAvailable ? "" : " (mkfifo unavailable -- FIFO regression skipped)"}`);
  return bad;
}
