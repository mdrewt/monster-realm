// Scratch probe (never merged): diff two zz-probe.mjs outputs. Usage: node zz-probe-diff.mjs a.json b.json
import fs from 'node:fs';

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
let diffs = 0;
const byKind = { font: 0, box: 0, canvas: 0 };
const lines = [];
for (const k of Object.keys(a.cells)) {
  const x = a.cells[k];
  const y = b.cells[k];
  const kinds = ['font', 'box', 'canvas'].filter((f) => x[f] !== y?.[f]);
  if (kinds.length > 0) {
    diffs++;
    for (const f of kinds) byKind[f]++;
    lines.push(`  ${k}: ${kinds.map((f) => `${f} ${x[f]} => ${y?.[f]}`).join('; ')}`);
  }
}
let controlDiffs = 0;
for (const k of Object.keys(a.controls)) {
  if (JSON.stringify(a.controls[k]) !== JSON.stringify(b.controls[k])) {
    controlDiffs++;
    lines.push(`  control ${k}: ${JSON.stringify(a.controls[k])} => ${JSON.stringify(b.controls[k])}`);
  }
}
console.log(
  `PROBE-DIFF ${process.argv[2]} vs ${process.argv[3]}: cells=${Object.keys(a.cells).length} differing=${diffs} (font=${byKind.font} box=${byKind.box} canvas=${byKind.canvas}) controls-differing=${controlDiffs}`,
);
for (const l of lines) console.log(l);
