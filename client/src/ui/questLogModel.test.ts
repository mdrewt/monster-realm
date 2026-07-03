// ui/questLogModel.test.ts — M12d red-phase tests for buildQuestLogViewModel.
// SOURCE OF TRUTH: docs/m12d-plan.md + docs/adr/0071-m12d-client-dialogue-quest-heal-ui.md
//
// Tests are INTENTIONALLY RED until questLogModel.ts is implemented.
// Do NOT edit to match a buggy implementation — correct from the spec only.
//
// Contract: buildQuestLogViewModel(quests) -> QuestLogViewModel
//   - QuestLogViewModel { active: readonly QuestEntryViewModel[] }
//   - QuestEntryViewModel { questId, stepIndex, displayName }
//   - displayName === questId (no bundled metadata — ADR-0071 known limitation)
//   - Completed quests are NOT in the list (completion deletes the server row)
//   - TOTAL: never throws
//
// Pattern follows raisingModel.test.ts: pure function, no DOM, no SDK.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildQuestLogViewModel } from './questLogModel';

// ---------------------------------------------------------------------------
// Local type definition (mirrors what store.ts will export as StorePlayerQuest).
// Defined here so tests are red for missing impl, not bad imports.
// ---------------------------------------------------------------------------

interface StorePlayerQuest {
  pqId: bigint;
  ownerIdentity: string;
  questId: string;
  stepIndex: number;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeQuest(
  questId: string,
  stepIndex = 0,
  ownerIdentity = 'player-hex',
  pqId = 1n,
): StorePlayerQuest {
  return { pqId, ownerIdentity, questId, stepIndex };
}

// ---------------------------------------------------------------------------
// Criterion 1 — Empty array → active: []
// ---------------------------------------------------------------------------

describe('buildQuestLogViewModel criterion 1: empty input → active: []', () => {
  it('BITES: empty quests array → { active: [] }', () => {
    // Kills: an impl that throws on empty input or returns undefined.
    const vm = buildQuestLogViewModel([]);
    expect(vm).toHaveProperty('active');
    expect(Array.isArray(vm.active)).toBe(true);
    expect(vm.active).toHaveLength(0);
  });

  it('BITES: returned object has exactly active field (no completed section)', () => {
    // Quest completion DELETES the server row (ADR-0071). There is NO completed list.
    // Kills: an impl that adds a "completed" array field — that would violate the
    // spec which says the client has no visibility into completed quests.
    const vm = buildQuestLogViewModel([]);
    // active must exist
    expect(vm).toHaveProperty('active');
    // completed must NOT exist (the spec explicitly forbids it)
    expect(vm).not.toHaveProperty('completed');
    expect(vm).not.toHaveProperty('done');
    expect(vm).not.toHaveProperty('finished');
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — One active quest → appears in active with correct questId and stepIndex
// ---------------------------------------------------------------------------

describe('buildQuestLogViewModel criterion 2: one quest → appears in active', () => {
  it('BITES: one quest → active has one entry with correct questId', () => {
    // Kills: an impl that ignores questId or uses pqId as the id.
    const q = makeQuest('quest_001', 0);
    const vm = buildQuestLogViewModel([q]);
    expect(vm.active).toHaveLength(1);
    expect(vm.active[0]!.questId).toBe('quest_001');
  });

  it('BITES: stepIndex=0 is passed through verbatim', () => {
    // Kills: an impl that adds 1 to stepIndex for "human-readable" display.
    const q = makeQuest('quest_001', 0);
    const vm = buildQuestLogViewModel([q]);
    expect(vm.active[0]!.stepIndex).toBe(0);
    expect(typeof vm.active[0]!.stepIndex).toBe('number');
  });

  it('BITES: stepIndex=5 is passed through verbatim (mid-quest)', () => {
    // Kills: an impl that resets stepIndex to 0 or recomputes it.
    const q = makeQuest('quest_002', 5);
    const vm = buildQuestLogViewModel([q]);
    expect(vm.active[0]!.stepIndex).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — Multiple quests → all appear in active
// ---------------------------------------------------------------------------

describe('buildQuestLogViewModel criterion 3: multiple quests appear in active', () => {
  it('BITES: three quests → active has three entries', () => {
    // Kills: an impl that deduplicates or limits the active list.
    const quests = [
      makeQuest('quest_001', 0, 'player', 1n),
      makeQuest('quest_002', 2, 'player', 2n),
      makeQuest('quest_003', 1, 'player', 3n),
    ];
    const vm = buildQuestLogViewModel(quests);
    expect(vm.active).toHaveLength(3);
    const ids = vm.active.map((q) => q.questId);
    expect(ids).toContain('quest_001');
    expect(ids).toContain('quest_002');
    expect(ids).toContain('quest_003');
  });

  it('BITES: order of active matches input order (no sort by questId or stepIndex)', () => {
    // Kills: an impl that sorts by questId alphabetically or by stepIndex.
    const quests = [
      makeQuest('quest_zzz', 3, 'player', 1n),
      makeQuest('quest_aaa', 0, 'player', 2n),
      makeQuest('quest_mmm', 1, 'player', 3n),
    ];
    const vm = buildQuestLogViewModel(quests);
    expect(vm.active).toHaveLength(3);
    expect(vm.active[0]!.questId).toBe('quest_zzz');
    expect(vm.active[1]!.questId).toBe('quest_aaa');
    expect(vm.active[2]!.questId).toBe('quest_mmm');
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — displayName === questId (no bundled metadata)
// ---------------------------------------------------------------------------

describe('buildQuestLogViewModel criterion 4: displayName equals questId', () => {
  it('BITES: displayName is exactly questId (no capitalization, no substitution)', () => {
    // ADR-0071 known limitation: no bundled quest metadata, so displayName = questId verbatim.
    // Kills: an impl that formats the questId (e.g. splits on "_", capitalizes words).
    const q = makeQuest('quest_001', 0);
    const vm = buildQuestLogViewModel([q]);
    expect(vm.active[0]!.displayName).toBe('quest_001');
    expect(vm.active[0]!.displayName).toBe(vm.active[0]!.questId);
  });

  it('BITES: displayName is copied verbatim for an unusual questId', () => {
    // Kills: an impl that applies any transformation (trim, lowercase, etc.).
    const q = makeQuest('SOME_QUEST_WITH_CAPS_AND_1234', 0);
    const vm = buildQuestLogViewModel([q]);
    expect(vm.active[0]!.displayName).toBe('SOME_QUEST_WITH_CAPS_AND_1234');
  });

  it('BITES fast-check: displayName is always exactly questId', () => {
    // Property: for any questId string, displayName must equal questId.
    // Kills: any impl that transforms questId before storing in displayName.
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 50 }), (questId) => {
        const q = makeQuest(questId, 0);
        const vm = buildQuestLogViewModel([q]);
        expect(vm.active[0]!.displayName).toBe(questId);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — TOTAL: never throws on unusual inputs
// ---------------------------------------------------------------------------

describe('buildQuestLogViewModel criterion 5: total function — never throws', () => {
  it('BITES: stepIndex=0 does not throw (falsy number)', () => {
    // Kills: an impl that guards `if (!stepIndex)` and crashes or skips.
    expect(() => {
      buildQuestLogViewModel([makeQuest('q', 0)]);
    }).not.toThrow();
  });

  it('BITES: stepIndex matching u32::MAX (4294967295) does not throw', () => {
    // Kills: an impl that overflows or rejects large step indices.
    expect(() => {
      buildQuestLogViewModel([makeQuest('q', 4294967295)]);
    }).not.toThrow();
    const vm = buildQuestLogViewModel([makeQuest('q', 4294967295)]);
    expect(vm.active[0]!.stepIndex).toBe(4294967295);
  });

  it('BITES: empty questId string does not throw', () => {
    // Kills: an impl that validates questId is non-empty and throws.
    expect(() => {
      buildQuestLogViewModel([makeQuest('', 0)]);
    }).not.toThrow();
  });

  it('BITES: very large pqId (bigint > 2^53) does not throw', () => {
    // Kills: an impl that converts pqId to number and overflows.
    const largeId = 9007199254740993n;
    const q: StorePlayerQuest = {
      pqId: largeId,
      ownerIdentity: 'player',
      questId: 'q',
      stepIndex: 0,
    };
    expect(() => {
      buildQuestLogViewModel([q]);
    }).not.toThrow();
  });

  it('BITES: 100 quests does not throw (scale guard)', () => {
    // Kills: any impl with a hardcoded limit on active quests.
    const quests = Array.from({ length: 100 }, (_, i) =>
      makeQuest(`quest_${i}`, i % 10, 'player', BigInt(i + 1)),
    );
    expect(() => {
      buildQuestLogViewModel(quests);
    }).not.toThrow();
  });

  it('BITES fast-check: never throws for any valid quest array', () => {
    // Property: no structurally valid quest array should crash the pure model.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pqId: fc.bigInt({ min: 0n, max: 99999n }),
            ownerIdentity: fc.string({ maxLength: 20 }),
            questId: fc.string({ maxLength: 30 }),
            stepIndex: fc.integer({ min: 0, max: 4294967295 }),
          }),
          { maxLength: 30 },
        ),
        (quests) => {
          expect(() => {
            buildQuestLogViewModel(quests);
          }).not.toThrow();
        },
      ),
    );
  });

  it('BITES: QuestEntryViewModel has all required fields (shape contract)', () => {
    // Kills: an impl that omits questId, stepIndex, or displayName from the entry.
    const q = makeQuest('quest_001', 3);
    const vm = buildQuestLogViewModel([q]);
    expect(vm.active[0]).toHaveProperty('questId');
    expect(vm.active[0]).toHaveProperty('stepIndex');
    expect(vm.active[0]).toHaveProperty('displayName');
    // Spot-check values
    expect(vm.active[0]!.questId).toBe('quest_001');
    expect(vm.active[0]!.stepIndex).toBe(3);
    expect(vm.active[0]!.displayName).toBe('quest_001');
  });
});
