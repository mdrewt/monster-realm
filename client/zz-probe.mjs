// Scratch probe (never merged): per-character font resolution + metrics + pixel hash in the
// Playwright chromium the e2e job uses. Usage: node zz-probe.mjs <out.json>
//
// A cell = lang x family x style x size x character.
//   font   — chromium's resolved platform font (CDP CSS.getPlatformFontsForNode), at 16px only
//   box    — the DOM box of an inline-block span holding the character
//   canvas — FNV-1a of the canvas fillText pixels + the measureText advance
import fs from 'node:fs';
import { chromium } from 'playwright';

const out = process.argv[2];
const repertoire = JSON.parse(fs.readFileSync(new URL('./zz-probe-chars.json', import.meta.url), 'utf8'));
const chars = [...repertoire.rendered, ...repertoire.unitOnly];
const unitOnly = new Set(repertoire.unitOnly);
const langs = ['en', 'fr'];
const families = ['monospace', 'sans-serif', 'serif', 'system-ui', 'Arial', 'ui-monospace'];
const styles = ['400', '600', '700', 'italic 400', 'italic 600', 'italic 700'];
const sizes = [9, 10.5, 12, 14, 16, 18, 20, 24, 28, 32];
const FONT_SIZE = 16;

const browser = await chromium.launch();
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('DOM.enable');
await cdp.send('CSS.enable');

const result = { version: browser.version(), cells: {}, controls: {} };
const cp = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

for (const lang of langs) {
  await page.setContent(`<!doctype html><html lang="${lang}"><body></body></html>`);
  for (const fam of families) {
    for (const style of styles) {
      for (const size of sizes) {
        const measured = await page.evaluate(
          ({ chars, fam, style, size }) => {
            document.body.innerHTML = '';
            for (const [i, c] of chars.entries()) {
              const s = document.createElement('span');
              s.id = `c${i}`;
              s.textContent = c;
              s.style.font = `${style} ${size}px ${fam}`;
              s.style.display = 'inline-block';
              s.style.whiteSpace = 'pre';
              document.body.appendChild(s);
            }
            const boxes = [...document.body.children].map((s) => {
              const r = s.getBoundingClientRect();
              return `${r.width}x${r.height}`;
            });
            const cv = document.createElement('canvas');
            cv.width = 96;
            cv.height = 64;
            document.body.appendChild(cv); // attached: canvas text inherits the document language
            const ctx = cv.getContext('2d', { willReadFrequently: true });
            const canvas = [];
            for (const c of chars) {
              ctx.clearRect(0, 0, 96, 64);
              ctx.font = `${style} ${size}px ${fam}`;
              ctx.fillStyle = '#000';
              ctx.fillText(c, 8, 44);
              const d = ctx.getImageData(0, 0, 96, 64).data;
              let h = 2166136261;
              for (let k = 0; k < d.length; k++) h = Math.imul(h ^ d[k], 16777619) >>> 0;
              canvas.push(`${h.toString(16)}:${ctx.measureText(c).width}`);
            }
            cv.remove();
            return { boxes, canvas };
          },
          { chars, fam, style, size },
        );
        let fonts = null;
        if (size === FONT_SIZE) {
          fonts = [];
          const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
          for (let i = 0; i < chars.length; i++) {
            const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#c${i}` });
            const r = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
            fonts.push(r.fonts.map((f) => f.familyName).join('+') || '(none)');
          }
        }
        for (const [i, c] of chars.entries()) {
          result.cells[`${lang}|${fam}|${style}|${size}|${cp(c)}`] = {
            cls: unitOnly.has(c) ? 'unit-test-only' : 'rendered',
            font: fonts === null ? '-' : fonts[i],
            box: measured.boxes[i],
            canvas: measured.canvas[i],
          };
        }
      }
    }
  }
}

// UA-default fonts of form controls (no author font).
await page.setContent(
  '<!doctype html><html lang="en"><body><button id="b">Button gy</button><input id="i" value="Input gy"><select id="s"><option>Select gy</option></select><textarea id="t">Text gy</textarea><p id="p">Body gy</p></body></html>',
);
{
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  for (const id of ['b', 'i', 's', 't', 'p']) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${id}` });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    const box = await page.evaluate((x) => {
      const r = document.getElementById(x).getBoundingClientRect();
      return `${r.width}x${r.height}`;
    }, id);
    result.controls[id] = { font: fonts.map((f) => f.familyName).join('+') || '(none)', box };
  }
}
await browser.close();

fs.writeFileSync(out, JSON.stringify(result));
const tally = {};
for (const [k, v] of Object.entries(result.cells)) {
  if (v.font === '-' || v.cls !== 'rendered') continue;
  tally[v.font] = (tally[v.font] ?? 0) + 1;
}
console.log(`PROBE ${out}: chromium ${result.version}, ${Object.keys(result.cells).length} cells`);
console.log(
  `PROBE-FONTS rendered cells at ${FONT_SIZE}px resolve to: ${Object.entries(tally)
    .sort()
    .map(([f, n]) => `${f}=${n}`)
    .join(', ')}`,
);
console.log(`  controls: ${JSON.stringify(result.controls)}`);
