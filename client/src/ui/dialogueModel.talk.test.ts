// ui/dialogueModel.talk.test.ts — TOMBSTONE (uxd2 / plan I6).
//
// ┌──────────────────────────────────────────────────────────────────────────────┐
// │ THIS FILE IS SCHEDULED FOR DELETION. Delete it as part of uxd2 increment I6.  │
// │ `docs/specs/uxd2-plan.md` I6 records the deletion; the tester's environment    │
// │ had no file-removal tool, so the 8 cases were PORTED first and the body was    │
// │ replaced with the single retirement gate below.                               │
// └──────────────────────────────────────────────────────────────────────────────┘
//
// WHAT USED TO LIVE HERE: the 8 M13.5c gating cases for
// `nearestTalkableNpcId` / `CLIENT_TALK_RANGE` (dialogueModel.ts:22-57).
// WHERE THEY LIVE NOW: `client/src/ui/interactModel.test.ts`, Block A ("ported"),
// adapted so a dialogue-only fixture returns a `{kind:'dialogue'}` descriptor rather
// than a bare `bigint`. Every original assertion survived the port; four new cases
// (A4b Manhattan-vs-Chebyshev, plus Blocks B-F) were added around them.
//
// The retirement gate below is DUPLICATED as `G1` in interactModel.test.ts on purpose:
// that copy is the one that survives this file's deletion. Nothing is lost by deleting
// this file; nothing is lost by forgetting to.
//
// RED TODAY: dialogueModel.ts still declares both symbols (dialogueModel.ts:22 and :39).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('uxd2 I6 retirement: nearestTalkableNpcId is superseded by nearestInteractable', () => {
  it('BITES: dialogueModel.ts no longer declares nearestTalkableNpcId / CLIENT_TALK_RANGE', () => {
    // WRONG IMPL KILLED: an impl that ADDS interactModel.ts but leaves the old, narrower
    // resolver in place. Two same-purpose resolvers with different rules is the ADR-0054
    // silent-drift class: a future range change lands in one and not the other, and the
    // client's KeyT target stops matching the on-world prompt.
    const modelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dialogueModel.ts');
    const src = readFileSync(modelPath, 'utf8');
    expect(
      src.includes('nearestTalkableNpcId'),
      'dialogueModel.ts must NOT declare nearestTalkableNpcId — nearestInteractable replaces it (uxd2 plan I6)',
    ).toBe(false);
    expect(
      src.includes('CLIENT_TALK_RANGE'),
      'dialogueModel.ts must NOT declare CLIENT_TALK_RANGE — CLIENT_INTERACT_RANGE replaces it (uxd2 plan I6)',
    ).toBe(false);
  });
});
