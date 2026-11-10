// render/characterView.test.ts — WAP5.2: the walk phase is a pure function of the
// fractional slide-clock position, and CharacterView swaps its texture when the
// (action, facing, phase) key changes — not merely (action, facing).
//
// Teeth (each names the wrong impl it kills):
// - walkPhase table: a phase from wall-clock / a counter / ceil-instead-of-floor.
// - axis-agnostic: a phase read from tileX only (misses N/S walks).
// - four-phase walk 3.0 -> 4.0: a key still on action:facing only (<4 calls).
// - repeat update, same key: a provider call on every frame (texture churn).
// - Idle at a fractional position: a phase leak into non-walking actions.
// - facing / action change with unchanged phase: a swap keyed on phase alone.
//
// Oracles are literals; the provider is a recording fake returning distinct real
// pixi Textures so `sprite.texture` identity proves which call's result was applied.

import { Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import type { WasmAction, WasmDirection } from '../convert/convert';
import { type AssetProvider, CharacterView, WALK_PHASES, walkPhase } from './characterView';

interface Call {
  readonly action: WasmAction;
  readonly facing: WasmDirection;
  readonly phase: number | undefined;
  readonly result: Texture;
}

function recordingAssets(): { assets: AssetProvider; calls: Call[] } {
  const calls: Call[] = [];
  const assets: AssetProvider = {
    texture(action, facing, phase) {
      const result = new Texture();
      calls.push({ action, facing, phase, result });
      return result;
    },
  };
  return { assets, calls };
}

describe('walkPhase', () => {
  it('WAP5.2 WALK_PHASES is 4', () => {
    expect(WALK_PHASES).toBe(4);
  });

  it('WAP5.2 phase table over x-axis slide positions', () => {
    expect(walkPhase(3, 5)).toBe(0);
    expect(walkPhase(3.25, 5)).toBe(1);
    expect(walkPhase(3.5, 5)).toBe(2);
    expect(walkPhase(3.75, 5)).toBe(3);
    expect(walkPhase(3.99, 5)).toBe(3);
  });

  it('WAP5.2 phase is axis-agnostic (y-axis slide gives the same phases)', () => {
    expect(walkPhase(7, 2)).toBe(0);
    expect(walkPhase(7, 2.25)).toBe(1);
    expect(walkPhase(7, 2.6)).toBe(2);
    expect(walkPhase(7, 2.9)).toBe(3);
  });

  it('WAP5.2 phase depends only on the fractional part, not the tile', () => {
    expect(walkPhase(40.5, 9)).toBe(walkPhase(3.5, 5));
    expect(walkPhase(0.75, 0)).toBe(3);
  });

  it('WAP5.2 phase is an integer in [0,4) across a dense sweep', () => {
    for (let i = 0; i <= 200; i++) {
      const p = walkPhase(1 + i / 200, 2);
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(4);
    }
  });
});

describe('CharacterView phase-keyed swap', () => {
  it('WAP5.2 walking x from 3.0 to 4.0 calls the provider with phases 0,1,2,3 once each', () => {
    const { assets, calls } = recordingAssets();
    const view = new CharacterView(assets);
    for (let i = 0; i < 32; i++) view.update(3 + i / 32, 5, 'Walking', 'East');
    expect(calls.map((c) => c.phase)).toEqual([0, 1, 2, 3]);
    expect(calls.every((c) => c.action === 'Walking' && c.facing === 'East')).toBe(true);
  });

  it('WAP5.2 walking along y also yields four phase swaps', () => {
    const { assets, calls } = recordingAssets();
    const view = new CharacterView(assets);
    for (let i = 0; i < 32; i++) view.update(2, 8 + i / 32, 'Walking', 'South');
    expect(calls.map((c) => c.phase)).toEqual([0, 1, 2, 3]);
  });

  it('WAP5.2 the sprite shows the texture returned for the latest key', () => {
    const { assets, calls } = recordingAssets();
    const view = new CharacterView(assets);
    view.update(3, 5, 'Walking', 'East');
    expect(view.sprite.texture).toBe(calls[0]?.result);
    view.update(3.5, 5, 'Walking', 'East');
    expect(calls).toHaveLength(2);
    expect(view.sprite.texture).toBe(calls[1]?.result);
    expect(calls[0]?.result).not.toBe(calls[1]?.result);
  });

  it('WAP5.2 a repeat update with the same key makes no provider call', () => {
    const { assets, calls } = recordingAssets();
    const view = new CharacterView(assets);
    view.update(3.1, 5, 'Walking', 'East');
    view.update(3.15, 5, 'Walking', 'East');
    view.update(3.2, 5, 'Walking', 'East');
    expect(calls).toHaveLength(1);
    const kept = view.sprite.texture;
    view.update(3.2, 5, 'Walking', 'East');
    expect(view.sprite.texture).toBe(kept);
    expect(calls).toHaveLength(1);
  });

  it('WAP5.2 Idle at a fractional position passes phase 0 and does not churn', () => {
    const { assets, calls } = recordingAssets();
    const view = new CharacterView(assets);
    view.update(3.4, 5, 'Idle', 'North');
    view.update(3.9, 5.7, 'Idle', 'North');
    view.update(3.0, 5, 'Idle', 'North');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.phase).toBe(0);
  });

  it('WAP5.2 Jumping at a fractional position passes phase 0', () => {
    const { assets, calls } = recordingAssets();
    const view = new CharacterView(assets);
    view.update(3.6, 5, 'Jumping', 'West');
    view.update(3.8, 5, 'Jumping', 'West');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.phase).toBe(0);
  });

  it('WAP5.2 a facing change with unchanged phase still swaps', () => {
    const { assets, calls } = recordingAssets();
    const view = new CharacterView(assets);
    view.update(3, 5, 'Walking', 'East');
    view.update(3, 5, 'Walking', 'West');
    expect(calls.map((c) => c.facing)).toEqual(['East', 'West']);
    expect(calls.map((c) => c.phase)).toEqual([0, 0]);
    expect(view.sprite.texture).toBe(calls[1]?.result);
  });

  it('WAP5.2 an action change with unchanged phase still swaps', () => {
    const { assets, calls } = recordingAssets();
    const view = new CharacterView(assets);
    view.update(3, 5, 'Idle', 'South');
    view.update(3, 5, 'Walking', 'South');
    view.update(3, 5, 'Jumping', 'South');
    expect(calls.map((c) => c.action)).toEqual(['Idle', 'Walking', 'Jumping']);
    expect(calls.map((c) => c.phase)).toEqual([0, 0, 0]);
  });

  it('WAP5.2 returning to a previous key after a change swaps again', () => {
    const { assets, calls } = recordingAssets();
    const view = new CharacterView(assets);
    view.update(3, 5, 'Walking', 'East');
    view.update(3.5, 5, 'Walking', 'East');
    view.update(3, 5, 'Walking', 'East');
    expect(calls.map((c) => c.phase)).toEqual([0, 2, 0]);
  });

  it('places the sprite at the fractional tile centre', () => {
    const { assets } = recordingAssets();
    const view = new CharacterView(assets);
    view.update(3, 5, 'Idle', 'South');
    const x0 = view.sprite.x;
    view.update(4, 5, 'Idle', 'South');
    expect(view.sprite.x).toBeGreaterThan(x0);
  });
});
