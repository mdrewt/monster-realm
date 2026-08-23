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
// THE FIX: this hook blocks (exit 2) any Write/Edit/MultiEdit whose target
// resolves inside `.claude/`, for `agent_type === "tester"` only. Every other agent
// (verifier, red-team, reviewer, the orchestrator, or none at all) is a hard no-op
// -- this must never become a general `.claude/`-protection control, only tester's.
//
// THE WORKTREE CARVE-OUT (2026-08-23, operator-reported; same finding as 16r-c).
// The first version blocked ALL of `.claude/`, on the reasoning that "tester has no
// legitimate reason to write there". That reasoning was wrong about one path, and
// it was the path that matters: **every slice's work happens in a git worktree at
// `<repo>/.claude/worktrees/<slice>`** (mr-spawn:864-865, build-loop step "Per-
// milestone procedure"). Blocking it does not stop tester writing tests -- it makes
// tester stage every test file through /tmp and have another agent copy it in, on
// EVERY slice. A guard that everyone routes around is worse than no guard: it costs
// real tokens per slice and it trains the loop to treat the restriction as an
// obstacle rather than a rule.
//
// So `.claude/worktrees/<slice>/**` is ALLOWED -- with one exception that is the
// whole reason this is not simply "allow worktrees". A worktree is a FULL CHECKOUT
// of the repo, so it contains its own `.claude/hooks/` and `.claude/settings.json`.
// Editing those does not disarm the RUNNING session (hooks load from
// CLAUDE_PROJECT_DIR, not from the worktree) -- but the worktree is what becomes the
// PR, so a disarmed guard committed there reaches `master` and disarms every FUTURE
// session. That is the same exploit on a delay. Hence: allow the worktree, keep
// protecting the worktree's own `.claude/`.
//
// A file that doesn't exist YET (Write creating something new) is checked against
// its LOGICAL resolved path, since there's nothing to resolve a symlink through.
// A file that already exists is checked against its REAL path (following
// symlinks), so a symlink planted elsewhere that resolves into `.claude/` is
// caught the same way guard-tester-bash.mjs's own path checks are.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PROJECT_ROOT = (() => {
  try {
    return realpathSync(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  } catch {
    return process.cwd();
  }
})();

const DOT_CLAUDE = ".claude";
const WORKTREES_PREFIX = DOT_CLAUDE + path.sep + "worktrees" + path.sep;

function underDotClaude(rel) {
  return rel === DOT_CLAUDE || rel.startsWith(DOT_CLAUDE + path.sep);
}

// Resolve symlinks as far as the path actually exists, then re-attach the missing tail.
// realpathSync() throws on a non-existent LEAF, and the old code fell back to the purely
// logical path in that case. Under a blanket `.claude/` block that was harmless -- every
// logical `.claude/...` path was blocked anyway. With a subtree now allowed it would be an
// escape: a Write to a not-yet-existing file beneath an existing symlinked directory would be
// judged on the logical path while landing somewhere else entirely.
function resolveDeepest(target) {
  let head = target;
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return target; // hit the root without resolving anything
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

function targetIsProtected(filePath) {
  if (!filePath) return false;
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);
  const rel = path.relative(PROJECT_ROOT, resolveDeepest(resolved));

  if (!underDotClaude(rel)) return false;            // the ordinary case: tester's own test files
  if (!rel.startsWith(WORKTREES_PREFIX)) return true; // .claude/hooks, .claude/settings.json, ...

  const afterWorktrees = rel.slice(WORKTREES_PREFIX.length);
  const cut = afterWorktrees.indexOf(path.sep);
  if (cut < 0) return true;  // `.claude/worktrees/<name>` itself -- not a file inside a worktree

  // Inside a slice worktree. Judge the path RELATIVE TO THE WORKTREE ROOT, so the worktree's
  // own `.claude/` stays protected while the rest of the checkout is writable.
  return underDotClaude(afterWorktrees.slice(cut + 1));
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
      "tester-guard: blocked. tester may not write to .claude/ control surfaces -- that is " +
      "exactly the path that would let it disable its own Bash allowlist " +
      "(guard-tester-bash.mjs) or the hook registration that enforces it (settings.json). " +
      "Writing INSIDE a slice worktree (.claude/worktrees/<slice>/...) IS allowed -- that is " +
      "where your test files belong -- except for the worktree's own .claude/, which would " +
      "reach master through the PR."
    );
    process.exit(2);
  });
}

// ==========================================================================================
// SELFTEST -- same discipline as guard-tester-bash.mjs: spawn the REAL process per fixture.
// ==========================================================================================
function runFixture(agentType, toolName, filePath, root) {
  const input = { tool_name: toolName, tool_input: { file_path: filePath } };
  if (agentType !== undefined) input.agent_type = agentType;
  const cwd = root || PROJECT_ROOT;
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 10_000, cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  return r.status;
}

function runSelftest() {
  let bad = 0;
  const results = [];
  function check(name, agentType, toolName, filePath, expectBlocked, root) {
    const status = runFixture(agentType, toolName, filePath, root);
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
  // The worktree's OWN .claude/ stays protected: it is not the live session's hook source,
  // but it IS what the PR merges, so a disarmed guard committed there reaches master.
  check("tester: worktree's own .claude/hooks (delayed self-disarm)", "tester", "Write",
    ".claude/worktrees/16r-x/.claude/hooks/guard-tester-write.mjs", true);
  check("tester: worktree's own .claude/settings.json", "tester", "Edit",
    ".claude/worktrees/16r-x/.claude/settings.json", true);
  check("tester: .claude/worktrees itself is not a worktree", "tester", "Write",
    ".claude/worktrees/loose-file.md", true);
  check("tester: traversal out of a worktree back into .claude/hooks", "tester", "Write",
    ".claude/worktrees/16r-x/../../hooks/evil.mjs", true);

  // THE CARVE-OUT -- every slice's work happens here, and blocking it cost a /tmp staging
  // round-trip on every slice (operator-reported 2026-08-23; same finding as 16r-c).
  check("tester: a test file inside a slice worktree", "tester", "Write",
    ".claude/worktrees/16r-x/client/src/foo.test.ts", false);
  check("tester: a Rust sibling test file inside a worktree", "tester", "Write",
    ".claude/worktrees/16r-x/server-module/src/battle_tests.rs", false);
  check("tester: an eval inside a worktree", "tester", "Write",
    ".claude/worktrees/16r-x/evals/thing.eval.mjs", false);
  check("tester: a file at the worktree ROOT (not a control surface)", "tester", "Write",
    ".claude/worktrees/16r-x/settings.json", false);

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

  // SYMLINK ESCAPE. realpathSync() throws on a non-existent LEAF, so a Write CREATING a new file
  // under an existing symlinked directory would otherwise be judged on its logical path -- which
  // looks like a harmless worktree path while landing in .claude/hooks. Only reachable because the
  // worktree carve-out allows a subtree; under the old blanket block it could not matter. Needs a
  // REAL symlink on disk, so it builds a throwaway project root rather than asserting from theory.
  const sandbox = path.join(tmpdir(), `tester-write-guard-${process.pid}`);
  try {
    mkdirSync(path.join(sandbox, ".claude", "hooks"), { recursive: true });
    mkdirSync(path.join(sandbox, ".claude", "worktrees"), { recursive: true });
    symlinkSync(path.join("..", "hooks"), path.join(sandbox, ".claude", "worktrees", "evil"));
    check("tester: symlinked 'worktree' resolving into .claude/hooks", "tester", "Write",
      ".claude/worktrees/evil/newly-created.mjs", true, sandbox);
    // control: a REAL directory at the same depth must stay allowed, so the rule above is not
    // just "block everything in the sandbox"
    mkdirSync(path.join(sandbox, ".claude", "worktrees", "real-slice", "src"), { recursive: true });
    check("tester: real worktree in the same sandbox stays allowed", "tester", "Write",
      ".claude/worktrees/real-slice/src/a.test.ts", false, sandbox);
  } catch (e) {
    console.log(`TESTER-WRITE-GUARD-SELFTEST-FAIL symlink-sandbox setup: ${e.message}`);
    bad = 1;
  } finally {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  for (const [name, ok, status, expectBlocked] of results) {
    if (!ok) console.log(`TESTER-WRITE-GUARD-SELFTEST-FAIL ${name} (exit=${status}, expected ${expectBlocked ? "blocked(2)" : "allowed(0)"})`);
  }
  if (!bad) console.log(`TESTER-WRITE-GUARD-SELFTEST-OK ${results.length} fixtures`);
  return bad;
}
