#!/usr/bin/env node
// PreToolUse guard, SCOPED TO THE "tester" SUBAGENT ONLY, for Write/Edit/MultiEdit.
// Companion to guard-tester-bash.mjs -- read that file's header first.
//
// WHY THIS FILE EXISTS (caught at a second, independent post-implementation review
// pass, after guard-tester-bash.mjs first shipped): tester's `tools:` frontmatter
// already carried unrestricted Write/Edit before this feature existed -- that was
// always inert because tester had nothing to execute. The moment guard-tester-
// bash.mjs granted tester Bash, unrestricted Write/Edit became a same-session
// bypass of the Bash restriction itself: tester could simply Edit
// .claude/hooks/guard-tester-bash.mjs's ALLOW array to always match, or Edit
// .claude/settings.json to delete the hook's registration entirely, then use the
// harness's own top-level `permissions.allow` list -- which already grants
// Bash(npm:*)/Bash(cargo:*)/Bash(pytest:*)/Bash(node:*) -- to run the real test
// suite. That is exactly the reward-hacking channel the whole Bash-restriction
// feature exists to close, reopened one Edit call away. A "mechanical" guard that
// the guarded agent can simply edit away is not mechanical.
//
// THE FIX: tester has no legitimate reason to ever write anywhere under `.claude/`
// -- its job is writing test files against the project's own source tree. So this
// hook blocks (exit 2) any Write/Edit/MultiEdit whose target resolves inside
// `.claude/`, for `agent_type === "tester"` only. Every other agent (verifier,
// red-team, reviewer, the orchestrator, or none at all) is a hard no-op -- this
// must never become a general `.claude/`-protection control, only tester's.
//
// A file that doesn't exist YET (Write creating something new) is checked against
// its LOGICAL resolved path, since there's nothing to resolve a symlink through.
// A file that already exists is checked against its REAL path (following
// symlinks), so a symlink planted elsewhere that resolves into `.claude/` is
// caught the same way guard-tester-bash.mjs's own path checks are.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import path from "node:path";

const PROJECT_ROOT = (() => {
  try {
    return realpathSync(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  } catch {
    return process.cwd();
  }
})();

function targetIsProtected(filePath) {
  if (!filePath) return false;
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);
  let real;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved; // doesn't exist yet (Write creating a new file) -- use the logical path
  }
  const rel = path.relative(PROJECT_ROOT, real);
  return rel === ".claude" || rel.startsWith(".claude" + path.sep);
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
      process.exit(0);
    }
    // THE SCOPE GATE -- identical discipline to guard-tester-bash.mjs's.
    if (payload.agent_type !== "tester") process.exit(0);

    const filePath = payload?.tool_input?.file_path ?? "";
    if (!targetIsProtected(filePath)) process.exit(0);

    console.error(
      "tester-guard: blocked. tester may not write anywhere under .claude/ -- that is " +
      "exactly the path that would let it disable its own Bash allowlist " +
      "(guard-tester-bash.mjs) or the hook registration that enforces it " +
      "(settings.json). Write your test files against the project's own source tree."
    );
    process.exit(2);
  });
}

// ==========================================================================================
// SELFTEST -- same discipline as guard-tester-bash.mjs: spawn the REAL process per fixture.
// ==========================================================================================
function runFixture(agentType, toolName, filePath) {
  const input = { tool_name: toolName, tool_input: { file_path: filePath } };
  if (agentType !== undefined) input.agent_type = agentType;
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 10_000, cwd: PROJECT_ROOT,
  });
  return r.status;
}

function runSelftest() {
  let bad = 0;
  const results = [];
  function check(name, agentType, toolName, filePath, expectBlocked) {
    const status = runFixture(agentType, toolName, filePath);
    const blocked = status === 2;
    const ok = blocked === expectBlocked;
    results.push([name, ok, status, expectBlocked]);
    if (!ok) bad = 1;
  }

  // tester: BLOCKED -- the exact self-tampering exploit this hook exists to close
  check("tester: Edit the Bash guard itself (relative path)", "tester", "Edit",
    ".claude/hooks/guard-tester-bash.mjs", true);
  check("tester: Edit the Bash guard itself (absolute path)", "tester", "Edit",
    path.join(PROJECT_ROOT, ".claude/hooks/guard-tester-bash.mjs"), true);
  check("tester: Edit settings.json (unregister the hook)", "tester", "Edit",
    ".claude/settings.json", true);
  check("tester: Write a NEW file under .claude/ (doesn't exist yet)", "tester", "Write",
    ".claude/hooks/not-yet-created.mjs", true);
  check("tester: MultiEdit under .claude/", "tester", "MultiEdit",
    ".claude/agents/tester.md", true);
  check("tester: Edit this guard file itself", "tester", "Edit",
    ".claude/hooks/guard-tester-write.mjs", true);
  check("tester: nested .claude subpath", "tester", "Write",
    ".claude/worktrees/anything/settings.json", true);

  // tester: ALLOWED -- its actual job
  check("tester: Write a real test file", "tester", "Write", "client/src/foo.test.ts", false);
  check("tester: Edit a source file under memory/projects/", "tester", "Edit",
    "memory/projects/mr-record", false);
  check("tester: a file merely NAMED claude-something, not under .claude/", "tester", "Write",
    "docs/claude-notes.md", false);

  // SCOPE PROOF -- same blocked targets, other agent_type, must be untouched (the specialist
  // and doc-keeper roles legitimately DO write under .claude/, e.g. authoring a new hook or
  // agent definition)
  check("specialist: Edit under .claude/ untouched by THIS hook", "specialist", "Edit",
    ".claude/hooks/guard-tester-bash.mjs", false);
  check("doc-keeper: Write under .claude/ untouched", "doc-keeper", "Write",
    ".claude/agents/new-role.md", false);
  check("no agent_type (top-level orchestrator): Write under .claude/ untouched", undefined, "Write",
    ".claude/settings.json", false);
  check("case-sensitivity: 'Tester' (capital T) is NOT scoped in", "Tester", "Edit",
    ".claude/settings.json", false);

  for (const [name, ok, status, expectBlocked] of results) {
    if (!ok) console.log(`TESTER-WRITE-GUARD-SELFTEST-FAIL ${name} (exit=${status}, expected ${expectBlocked ? "blocked(2)" : "allowed(0)"})`);
  }
  if (!bad) console.log(`TESTER-WRITE-GUARD-SELFTEST-OK ${results.length} fixtures`);
  return bad;
}
