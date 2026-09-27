#!/bin/bash
# Phase 0 public-surface snapshot -> docs/debloat/baseline/
set -u
export PATH="$HOME/.asdf/shims:$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
REPO=/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm
S=/tmp/claude-1000/-home-mdrewt-projects-ai-apps-claude-harness-projects-monster-realm/630b145b-dfc3-49ab-9f9a-acd7ca971061/scratchpad
B="$REPO/docs/debloat/baseline"
cd "$REPO" || exit 1
mkdir -p "$B/evals-baselines" "$B/rosters"

echo "== 1. eval baselines =="
cp evals/baselines/*.json "$B/evals-baselines/"

echo "== 2. wasm surface =="
cp client-wasm/pkg/client_wasm.d.ts "$B/client_wasm.d.ts"

echo "== 3. server surface (distilled from okf bundle) =="
{
  echo "# Server public surface — Phase 0 snapshot"
  echo
  echo "Distilled from the generated okf-export bundle (docs/knowledge/, generated $(grep -m1 '^updated:' docs/knowledge/schema-overview.md | cut -d' ' -f2)); exact column shapes are pinned by evals-baselines/table-schemas.json and spacetime-types.json."
  echo
  echo "## Tables ($(ls docs/knowledge/tables/*.md | wc -l))"
  echo
  for f in docs/knowledge/tables/*.md; do
    t=$(grep -m1 '^title:' "$f" | sed 's/^title: //')
    v=$(grep -m1 '^visibility:' "$f" | sed 's/^visibility: //')
    [ -z "$v" ] && v=$(grep -m1 'public' <(grep -m1 '^tags:' "$f") >/dev/null && echo public || echo unknown)
    echo "- \`$t\` — $v"
  done
  echo
  echo "## Reducer signatures ($(ls docs/knowledge/reducers/*.md | wc -l))"
  for f in docs/knowledge/reducers/*.md; do
    echo
    awk '/^## Signature/{found=1} found && /^```rust/{inblock=1; print; next} inblock{print; if(/^```$/) exit}' "$f"
  done
} > "$B/server-surface.md"

echo "== 4. rosters =="
cargo nextest list > "$B/rosters/nextest-list.txt" 2> "$S/nextest-list.stderr"
( cd client && npx vitest list > "$B/rosters/vitest-list.txt" 2> "$S/vitest-list.stderr" )
( cd client && npx playwright test --list > "$B/rosters/playwright-list.txt" 2> "$S/playwright-list.stderr" )
ls evals/*.eval.mjs | sort > "$B/rosters/eval-files.txt"

echo "== 5. bindings hash =="
( cd client/src/module_bindings && find . -type f | sort | xargs sha256sum ) > "$B/module-bindings.sha256"
sha256sum "$B/module-bindings.sha256" | cut -d' ' -f1 > "$B/module-bindings.aggregate.sha256"

echo "== 6. LOC by category =="
git ls-files -z | node -e '
const chunks=[]; process.stdin.on("data",c=>chunks.push(c)).on("end",()=>{
const fs=require("fs");
const files=Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean);
const cats={};
function cat(f){
  if(f.startsWith("client/src/module_bindings/")) return "generated-bindings";
  if(f.startsWith("evals/")) return "evals";
  if(/^server-module\/src\/.*_tests\.rs$/.test(f)) return "server-tests";
  if(f.startsWith("server-module/tests/")) return "server-tests";
  if(f.startsWith("client/e2e/")||/\.test\.(ts|mjs|js)$/.test(f)&&f.startsWith("client/")) return "client-tests";
  if(f.startsWith("game-core/src/")||f.startsWith("game-core/proptest-regressions/")) return "production";
  if(f.startsWith("server-module/src/")) return "production";
  if(f.startsWith("client-wasm/src/")) return "production";
  if(f.startsWith("sim-harness/src/")) return "production";
  if(f.startsWith("client/src/")) return "production";
  if(f.startsWith("game-core/tests/")||f.startsWith("client-wasm/tests/")) return "server-tests";
  if(f.endsWith(".md")) return "docs-md";
  if(f.startsWith("scripts/")||f.startsWith("ops/")||f.startsWith(".github/")||["justfile","lefthook.yml"].includes(f)) return "scripts-ops-ci";
  if(f.startsWith("content/")||f.endsWith(".ron")) return "content";
  return "other";
}
for(const f of files){
  let lines=0;
  try{const buf=fs.readFileSync(f); if(buf.includes(0)) lines=0; else lines=buf.length? buf.toString("utf8").split("\n").length-1+(buf[buf.length-1]===10?0:1):0;}catch(e){continue;}
  const c=cat(f);
  cats[c]=cats[c]||{files:0,lines:0}; cats[c].files++; cats[c].lines+=lines;
}
let tf=0,tl=0;
const rows=Object.entries(cats).sort((a,b)=>b[1].lines-a[1].lines);
console.log("| category | files | lines |");
console.log("|---|---:|---:|");
for(const [k,v] of rows){ tf+=v.files; tl+=v.lines; console.log(`| ${k} | ${v.files} | ${v.lines} |`);}
console.log(`| **total tracked** | **${tf}** | **${tl}** |`);
});' > "$B/loc-by-category.md"

echo "== 7. counts summary =="
{
  echo "nextest tests: $(grep -cE '^\s{4}\S' "$B/rosters/nextest-list.txt" 2>/dev/null || echo n/a) (see roster)"
  echo "vitest lines: $(wc -l < "$B/rosters/vitest-list.txt")"
  echo "playwright listed lines: $(wc -l < "$B/rosters/playwright-list.txt")"
  echo "eval files: $(wc -l < "$B/rosters/eval-files.txt")"
} > "$B/rosters/counts.txt"
cat "$B/rosters/counts.txt"
echo "SNAPSHOT-DONE"
