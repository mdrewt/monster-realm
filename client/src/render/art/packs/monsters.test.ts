// render/art/packs/monsters.test.ts — wap-3 WAP3.1: Tidecrag (id 30) and Cindershade (id 31) ship
// real sheets and normal maps, and the spritesheet-format eval no longer exempts them.
//
// Measures the generated PNGs (decoded) and calls the grandfathered eval's exported function; it
// never reads hand-authored text (Constraint 7b).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM eval with no declaration file (client has no allowJs)
import { missingSpriteFiles } from '../../../../../evals/monster-spritesheet-format.eval.mjs';
import { decodePng } from '../../../../test-util/pngDecode';
import { ART_REGISTRY } from '../registry';

const ASSETS = join(import.meta.dirname, '..', '..', '..', '..', 'public', 'assets');
const GENERATOR = 'client/art-src/generate_monsters.py';

const NEW_SPECIES = [
  { id: 30, name: 'Tidecrag' },
  { id: 31, name: 'Cindershade' },
] as const;

describe('WAP3.1 the two item-evolution forms ship real sheets', () => {
  for (const { name } of NEW_SPECIES) {
    const id = name.toLowerCase();

    it(`WAP3.1 ${name} has a sprite row and a normal row from generate_monsters.py, 96x128 sheet of 32x32 frames`, () => {
      // WRONG IMPL KILLED: a missing row (the species stays unregistered, the board draws a
      // placeholder box); only the albedo row; the wrong generator path; a wrong sheet/frame size.
      const sprite = ART_REGISTRY.filter((r) => r.key === `monsters/${id}`);
      const normal = ART_REGISTRY.filter((r) => r.key === `monsters/${id}_normal`);
      expect(sprite, `${name} sprite row count`).toHaveLength(1);
      expect(normal, `${name} normal row count`).toHaveLength(1);
      expect(sprite[0].kind).toBe('sprite');
      expect(normal[0].kind).toBe('normal');
      for (const row of [sprite[0], normal[0]]) {
        expect(row.source, `${row.key} source`).toBe(GENERATOR);
        expect(row.sheet, `${row.key} sheet`).toEqual({ w: 96, h: 128 });
        expect(row.frame, `${row.key} frame`).toEqual({ w: 32, h: 32 });
      }
      expect(sprite[0].file).toBe(`monster-${id}.png`);
      expect(normal[0].file).toBe(`monster-${id}-normal.png`);
    });

    it(`WAP3.1 ${name} sprite and normal PNGs decode at 96x128 and the down-idle frame is not blank`, () => {
      // WRONG IMPL KILLED: a missing file; a wrong-size sheet; a fully transparent sheet (an
      // invisible monster that every structural check passes); a normal map left blank.
      for (const key of [id, `${id}-normal`]) {
        const png = decodePng(new Uint8Array(readFileSync(join(ASSETS, `monster-${key}.png`))));
        expect([png.width, png.height], `${key} size`).toEqual([96, 128]);
        let opaque = 0;
        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 32; x++) {
            if (png.rgba[(y * png.width + x) * 4 + 3] > 0) opaque++;
          }
        }
        expect(opaque, `${key} down-idle frame has drawn pixels`).toBeGreaterThan(0);
      }
    });
  }

  it('WAP3.1 the format eval exempts nobody: with no files, ids 30 and 31 each report four missing files', () => {
    // WRONG IMPL KILLED: NO_SHEET_YET left in place (the two ids report 0 missing and ship
    // without art unnoticed); an exemption that drops only the normal pair (2 missing).
    const missing: string[] = missingSpriteFiles([...NEW_SPECIES], new Set<string>());
    for (const { id, name } of NEW_SPECIES) {
      const mine = missing.filter((m) => m.startsWith(`species ${id} (${name}):`));
      expect(mine, `${name} missing files with an empty directory`).toHaveLength(4);
    }
  });

  it('WAP3.1 with the real assets directory listing nothing is missing for ids 30 and 31', () => {
    // WRONG IMPL KILLED: the eval un-exempted but the sheets/json/normal files not generated (or
    // named differently from the eval's slug rule).
    const files = new Set<string>(readdirSync(ASSETS));
    const missing: string[] = missingSpriteFiles([...NEW_SPECIES], files);
    expect(missing).toEqual([]);
  });
});
