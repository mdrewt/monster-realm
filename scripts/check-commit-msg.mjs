#!/usr/bin/env node
// Portable Conventional-Commits check (no deps) for the lefthook commit-msg hook.
// Cross-platform: replaces a `grep` one-liner that did not run on Windows (no
// POSIX grep on PATH), mirroring why guard-bash.sh became guard-bash.mjs.
// Usage: node scripts/check-commit-msg.mjs <path-to-commit-msg-file>  (lefthook passes {1})
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('check-commit-msg: no commit-message file passed.');
  process.exit(1);
}

let first = '';
try {
  // First line that is neither blank nor a comment (git strips '#' lines anyway).
  first =
    readFileSync(file, 'utf8')
      .split('\n')
      .find((l) => l.trim() !== '' && !l.startsWith('#')) ?? '';
} catch {
  console.error(`check-commit-msg: cannot read ${file}.`);
  process.exit(1);
}

// Auto-generated commits (merge/revert/fixup/squash) are exempt, as Conventional
// Commits tooling (commitlint, git-cliff) treats them.
if (/^(Merge |Revert "|fixup! |squash! )/.test(first)) process.exit(0);

// type(scope)!: summary — types match standards/git.md + cliff.toml.
const RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+\))?!?: .+/;
if (RE.test(first)) process.exit(0);

console.error(`Use Conventional Commits: <type>(<scope>): <summary>\n  got: ${first}`);
process.exit(1);
