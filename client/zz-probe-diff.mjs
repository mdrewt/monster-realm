// Scratch probe (never merged): diff two zz-probe.mjs outputs. Usage: node zz-probe-diff.mjs a.json b.json
import fs from 'node:fs';

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
let diffs = 0;
const perClass = { rendered: { cells: 0, differing: 0 }, 'unit-test-only': { cells: 0, differing: 0 } };
const differingChars = { rendered: new Set(), 'unit-test-only': new Set() };
const byKind = { font: 0, box: 0, canvas: 0 };
const lines = [];
for (const k of Object.keys(a.cells)) {
  const x = a.cells[k];
  const y = b.cells[k];
  const kinds = ['font', 'box', 'canvas'].filter((f) => x[f] !== y?.[f]);
  perClass[x.cls].cells++;
  if (kinds.length > 0) {
    diffs++;
    perClass[x.cls].differing++;
    differingChars[x.cls].add(k.split('|').at(-1));
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
for (const cls of Object.keys(perClass))
  console.log(
    `PROBE-CLASS ${cls}: cells=${perClass[cls].cells} differing=${perClass[cls].differing} chars=[${[...differingChars[cls]].join(' ')}]`,
  );
for (const l of lines.slice(0, 40)) console.log(l);
