#!/usr/bin/env bash
# build.sh <proto-letter|today> [out-name] — build the load module (feature load_test_zones) of a
# prototype worktree into the slice worktree's shared target dir and copy the wasm to mods/.
set -euo pipefail
SB=$(cat /tmp/lpw26-sandbox-path)
WT=/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/.claude/worktrees/lpw-26
export PATH="$HOME/.asdf/installs/nodejs/24.22.3/bin:$HOME/.asdf/shims:$HOME/.cargo/bin:$PATH"
which=$1
out=${2:-$which}
if [ "$which" = today ]; then src=$WT; else src=$SB/proto-$which; fi
cd "$src"
cargo build -p monster-realm-module --release --target wasm32-unknown-unknown \
  --features load_test_zones --target-dir "$WT/target/load-host" >"$SB/build-$out.log" 2>&1 || {
  grep -E '^(error|warning: unused)' -A 12 "$SB/build-$out.log" | head -80
  echo "BUILD FAILED ($out)"
  exit 1
}
cp "$WT/target/load-host/wasm32-unknown-unknown/release/monster_realm_module.wasm" "$SB/mods/$out.wasm"
grep -E '^warning' -A 6 "$SB/build-$out.log" | head -30 || true
echo "built $out: $(stat -c %s "$SB/mods/$out.wasm") bytes, $(git -C "$src" rev-parse --short HEAD) + $(git -C "$src" status --short | wc -l) dirty"
