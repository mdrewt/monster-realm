// Scratch probe (never merged): per-character font resolution + metrics + pixel hash in the
// Playwright chromium the e2e job uses. Usage: node zz-probe.mjs <out.json>
import fs from 'node:fs';
import { chromium } from 'playwright';

const out = process.argv[2];
const chars = JSON.parse(fs.readFileSync(new URL('./zz-probe-chars.json', import.meta.url), 'utf8'));
const families = ['monospace', 'sans-serif', 'serif', 'system-ui', 'Arial', 'ui-monospace'];
const weights = ['400', '700'];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>');
const cdp = await page.context().newCDPSession(page);
await cdp.send('DOM.enable');
await cdp.send('CSS.enable');

const result = { version: browser.version(), cells: {}, controls: {} };
const cp = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

for (const fam of families) {
  for (const weight of weights) {
    await page.evaluate(
      ({ chars, fam, weight }) => {
        document.body.innerHTML = '';
        for (const [i, c] of chars.entries()) {
          const s = document.createElement('span');
          s.id = `c${i}`;
          s.textContent = c;
          s.style.font = `${weight} 16px ${fam}`;
          s.style.display = 'inline-block';
          s.style.whiteSpace = 'pre';
          document.body.appendChild(s);
        }
      },
      { chars, fam, weight },
    );
    const boxes = await page.evaluate(() =>
      [...document.body.children].map((s) => {
        const r = s.getBoundingClientRect();
        return `${r.width}x${r.height}`;
      }),
    );
    const canvas = await page.evaluate(
      ({ chars, fam, weight }) => {
        const cv = document.createElement('canvas');
        cv.width = 64;
        cv.height = 40;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        const res = [];
        for (const c of chars) {
          ctx.clearRect(0, 0, 64, 40);
          ctx.font = `${weight} 16px ${fam}`;
          ctx.fillStyle = '#000';
          ctx.fillText(c, 6, 26);
          const d = ctx.getImageData(0, 0, 64, 40).data;
          let h = 2166136261;
          for (let k = 0; k < d.length; k++) h = Math.imul(h ^ d[k], 16777619) >>> 0;
          res.push(`${h.toString(16)}:${ctx.measureText(c).width}`);
        }
        return res;
      },
      { chars, fam, weight },
    );
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    for (const [i, c] of chars.entries()) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#c${i}` });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      result.cells[`${fam}|${weight}|${cp(c)}`] = {
        font: fonts.map((f) => f.familyName).join('+') || '(none)',
        box: boxes[i],
        canvas: canvas[i],
      };
    }
  }
}

// UA-default fonts of form controls (no author font).
await page.setContent(
  '<!doctype html><html><body><button id="b">Button gy</button><input id="i" value="Input gy"><select id="s"><option>Select gy</option></select><textarea id="t">Text gy</textarea><p id="p">Body gy</p></body></html>',
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
  const key = `${k.split('|').slice(0, 2).join('|')} -> ${v.font}`;
  tally[key] = (tally[key] ?? 0) + 1;
}
console.log(`PROBE ${out}: chromium ${result.version}, ${Object.keys(result.cells).length} cells`);
for (const [k, n] of Object.entries(tally).sort()) console.log(`  ${k}: ${n}`);
console.log(`  controls: ${JSON.stringify(result.controls)}`);
