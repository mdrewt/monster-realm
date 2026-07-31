// ui/dialogueModel.test.ts — M12d red-phase tests for buildDialogueViewModel.
// SOURCE OF TRUTH: docs/m12d-plan.md + docs/adr/0071-m12d-client-dialogue-quest-heal-ui.md
//
// Tests are INTENTIONALLY RED until dialogueModel.ts is implemented.
// Do NOT edit these tests to match a buggy implementation — correct from the spec.
//
// Contract: buildDialogueViewModel(conv, npcs, content) -> DialogueViewModel | null
//   - Returns null when no active conversation (conv undefined)
//   - Returns null when NPC not found in npcs map
//   - Returns correct npcName, nodeText, choices when all data present
//   - Returns "..." when nodeId or treeId not in bundle (graceful degradation — NO throw)
//   - TOTAL: never throws on any input combination
//
// Pattern follows evolutionModel.test.ts: pure function, no DOM, no SDK.
// All inputs are plain objects; deterministic; node-only.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DIALOGUE_TREES } from './dialogueContent';
import { buildDialogueViewModel } from './dialogueModel';

// ---------------------------------------------------------------------------
// Local type definitions (mirrors of what store.ts + dialogueContent.ts will export).
// Defined here so tests start red for the right reason (missing impl, not bad imports).
// ---------------------------------------------------------------------------

interface StorePlayerConversation {
  ownerIdentity: string;
  npcEntityId: bigint;
  currentNodeId: string;
}

interface StoreNpcRow {
  entityId: bigint;
  npcId: string;
  zoneId: number;
  homeX: number;
  homeY: number;
  wanderRadius: number;
  dialogueTreeId: string;
}

interface ClientDialogueNode {
  text: string;
  choices: readonly { text: string }[];
}

interface ClientDialogueTree {
  rootNodeId: string;
  nodes: ReadonlyMap<string, ClientDialogueNode>;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeConv(
  npcEntityId: bigint,
  currentNodeId = 'greeting',
  ownerIdentity = 'player-hex',
): StorePlayerConversation {
  return { ownerIdentity, npcEntityId, currentNodeId };
}

function makeNpc(entityId: bigint, overrides: Partial<StoreNpcRow> = {}): StoreNpcRow {
  return {
    entityId,
    npcId: `npc-${entityId}`,
    zoneId: 0,
    homeX: 5,
    homeY: 5,
    wanderRadius: 2,
    dialogueTreeId: 'elder_oak_talk',
    ...overrides,
  };
}

function makeTree(
  rootNodeId: string,
  nodes: ReadonlyMap<string, ClientDialogueNode>,
): ClientDialogueTree {
  return { rootNodeId, nodes };
}

function makeNode(text: string, choices: readonly { text: string }[] = []): ClientDialogueNode {
  return { text, choices };
}

// ---------------------------------------------------------------------------
// Criterion 1 — Returns null when conv is undefined
// ---------------------------------------------------------------------------

describe('buildDialogueViewModel criterion 1: returns null when conv is undefined', () => {
  it('BITES: conv=undefined → null (no conversation active)', () => {
    // Kills: an impl that throws when conv is undefined or returns a default VM.
    // Server SSOT: no server row = no conversation = null from model.
    const npcs = new Map<bigint, StoreNpcRow>([[1n, makeNpc(1n)]]);
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('greeting', new Map([['greeting', makeNode('Hello')]]))],
    ]);
    const result = buildDialogueViewModel(undefined, npcs, content);
    expect(result).toBeNull();
  });

  it('BITES: conv=undefined with empty maps → null (no throw)', () => {
    // Kills: an impl that throws when all maps are empty and conv is undefined.
    expect(() => {
      const result = buildDialogueViewModel(undefined, new Map(), new Map());
      expect(result).toBeNull();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — Returns null when NPC not found in npcs map
// ---------------------------------------------------------------------------

describe('buildDialogueViewModel criterion 2: returns null when NPC not found', () => {
  it('BITES: conv references npcEntityId=99n but npcs map is empty → null', () => {
    // Kills: an impl that throws on missing NPC lookup or returns a partial VM.
    // The conversation row exists but the NPC row hasn't arrived yet (timing race).
    const conv = makeConv(99n);
    const result = buildDialogueViewModel(conv, new Map(), new Map());
    expect(result).toBeNull();
  });

  it('BITES: conv references npcEntityId=2n but only npcEntityId=1n is in npcs → null', () => {
    // Kills: an impl that returns the first NPC in the map regardless of entityId match.
    const conv = makeConv(2n);
    const npcs = new Map<bigint, StoreNpcRow>([[1n, makeNpc(1n)]]);
    const result = buildDialogueViewModel(conv, npcs, new Map());
    expect(result).toBeNull();
  });

  it('BITES: does NOT throw when NPC is missing (graceful null, not exception)', () => {
    // A throw here would starve sibling batch listeners (one-way flow rule).
    expect(() => {
      buildDialogueViewModel(makeConv(42n), new Map(), new Map());
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — Returns correct npcName from NPC's npcId
// ---------------------------------------------------------------------------

describe('buildDialogueViewModel criterion 3: npcName resolved from npcId', () => {
  it('BITES: npcId="elder_oak" → npcName="elder_oak" in the VM', () => {
    // Kills: an impl that uses entityId instead of npcId for the display name,
    // or that uses dialogueTreeId as the name.
    const conv = makeConv(1n, 'greeting');
    const npc = makeNpc(1n, { npcId: 'elder_oak', dialogueTreeId: 'elder_oak_talk' });
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('greeting', new Map([['greeting', makeNode('Hello')]]))],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.npcName).toBe('elder_oak');
  });

  it('BITES: npcId is passed through verbatim (no transformation, no truncation)', () => {
    // Kills: an impl that transforms the npcId (e.g. capitalizes or splits on underscores).
    const conv = makeConv(5n);
    const npc = makeNpc(5n, { npcId: 'weird_npc_name_with_numbers_42' });
    const npcs = new Map<bigint, StoreNpcRow>([[5n, npc]]);
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('n1', new Map([['n1', makeNode('Hi')]]))],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.npcName).toBe('weird_npc_name_with_numbers_42');
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — Returns correct nodeText when node is in the content bundle
// ---------------------------------------------------------------------------

describe('buildDialogueViewModel criterion 4: nodeText from content bundle', () => {
  it('BITES: currentNodeId="greeting" present in bundle → nodeText="The ancient oak spirit greets you."', () => {
    // Kills: an impl that ignores the bundle and returns the nodeId as text,
    // or that always returns "...".
    const conv = makeConv(1n, 'greeting');
    const npc = makeNpc(1n, { dialogueTreeId: 'elder_oak_talk' });
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const greetingNode = makeNode('The ancient oak spirit greets you.', [
      { text: 'I seek a quest.' },
    ]);
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('greeting', new Map([['greeting', greetingNode]]))],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.nodeText).toBe('The ancient oak spirit greets you.');
  });

  it('BITES: content bundle uses the dialogueTreeId from the NPC row as lookup key (not npcId)', () => {
    // Kills: an impl that looks up content by npcId instead of dialogueTreeId.
    // NPC npcId="village_elder" but dialogueTreeId="intro_tree" — must look up "intro_tree".
    const conv = makeConv(7n, 'start');
    const npc = makeNpc(7n, { npcId: 'village_elder', dialogueTreeId: 'intro_tree' });
    const npcs = new Map<bigint, StoreNpcRow>([[7n, npc]]);
    const content = new Map<string, ClientDialogueTree>([
      ['intro_tree', makeTree('start', new Map([['start', makeNode('Welcome, traveller.')]]))],
      [
        'village_elder',
        makeTree('x', new Map([['x', makeNode('WRONG — this is indexed by npcId')]])),
      ],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.nodeText).toBe('Welcome, traveller.');
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — Returns "..." when nodeId NOT in bundle (graceful degradation)
// ---------------------------------------------------------------------------

describe('buildDialogueViewModel criterion 5: "..." when node not in bundle', () => {
  it('BITES: nodeId="unknown_node" not in tree nodes → nodeText="..."', () => {
    // This is the ADR-0071 graceful degradation contract: a bundle/server mismatch
    // shows "..." rather than throwing or showing a raw id.
    // Kills: an impl that throws on Map.get() returning undefined for nodeId.
    const conv = makeConv(1n, 'unknown_node');
    const npc = makeNpc(1n, { dialogueTreeId: 'elder_oak_talk' });
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('greeting', new Map([['greeting', makeNode('Hello')]]))],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.nodeText).toBe('...');
  });

  it('BITES: "..." node returns empty choices array (no crash from partial bundle)', () => {
    // Kills: an impl that tries to read choices from a missing node and throws.
    const conv = makeConv(1n, 'missing_node');
    const npc = makeNpc(1n, { dialogueTreeId: 'elder_oak_talk' });
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('greeting', new Map([['greeting', makeNode('Hello')]]))],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.nodeText).toBe('...');
    expect(Array.isArray(result!.choices)).toBe(true);
    expect(result!.choices).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5b — choices[n].idx equals n (numeric value assertion)
// ---------------------------------------------------------------------------
// WHY THIS BLOCK EXISTS: criteria 7 and 10 already test idx, but they were
// added AFTER criterion 5. This block is placed directly after criterion 5 so
// the "missing choices" and "wrong idx" failure modes are co-located and an
// impl returning `idx: 42` for every choice is killed at criterion 5b level.

describe('buildDialogueViewModel criterion 5b: choices idx matches array position', () => {
  it('BITES: single choice → choices[0].idx === 0 (not 1, not 42, not undefined)', () => {
    // Kills: an impl that returns idx: 1 (1-based), idx: 42 (hardcoded), or omits idx.
    // choice.idx is passed directly to advance_dialogue as choiceIndex on the server;
    // a wrong value silently routes to the wrong dialogue branch.
    const conv = makeConv(1n, 'node');
    const npc = makeNpc(1n);
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const content = new Map<string, ClientDialogueTree>([
      [
        'elder_oak_talk',
        makeTree('node', new Map([['node', makeNode('Hello', [{ text: 'OK' }])]])),
      ],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.choices[0]!.idx).toBe(0);
  });

  it('BITES: two choices → choices[0].idx===0, choices[1].idx===1 (0-based, not 1-based)', () => {
    // Kills: an impl that uses 1-based indexing (idx=1 for first, idx=2 for second).
    // The server rejects choiceIndex that is out of bounds for the node's choices array.
    const conv = makeConv(1n, 'node');
    const npc = makeNpc(1n);
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const content = new Map<string, ClientDialogueTree>([
      [
        'elder_oak_talk',
        makeTree(
          'node',
          new Map([['node', makeNode('Hello', [{ text: 'First' }, { text: 'Second' }])]]),
        ),
      ],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.choices[0]!.idx).toBe(0);
    expect(result!.choices[1]!.idx).toBe(1);
  });

  it('BITES: choices[n].idx equals n (0-based array position, not derived from choice content)', () => {
    // Kills: an impl that computes idx from choice text content, hash, or any other
    // source rather than the raw array position.
    // Three choices: verify each idx matches its position (0, 1, 2).
    const conv = makeConv(1n, 'node');
    const npc = makeNpc(1n);
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const choices = [{ text: 'Alpha' }, { text: 'Beta' }, { text: 'Gamma' }];
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('node', new Map([['node', makeNode('Text', choices)]]))],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.choices).toHaveLength(3);
    expect(result!.choices[0]!.idx).toBe(0);
    expect(result!.choices[1]!.idx).toBe(1);
    expect(result!.choices[2]!.idx).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Criterion 6 — Returns "..." when tree not in bundle (no NPC tree found)
// ---------------------------------------------------------------------------

describe('buildDialogueViewModel criterion 6: "..." when tree not in bundle', () => {
  it('BITES: dialogueTreeId="nonexistent_tree" not in content map → nodeText="..."', () => {
    // Kills: an impl that throws when content.get(dialogueTreeId) returns undefined.
    const conv = makeConv(1n, 'greeting');
    const npc = makeNpc(1n, { dialogueTreeId: 'nonexistent_tree' });
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('greeting', new Map([['greeting', makeNode('Hello')]]))],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.nodeText).toBe('...');
  });

  it('BITES: empty content map → nodeText="..." with no throw', () => {
    // Kills: an impl that assumes content is always populated.
    const conv = makeConv(1n, 'greeting');
    const npc = makeNpc(1n, { dialogueTreeId: 'elder_oak_talk' });
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    expect(() => {
      const result = buildDialogueViewModel(conv, npcs, new Map());
      expect(result).not.toBeNull();
      expect(result!.nodeText).toBe('...');
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Criterion 7 — Returns choices with correct text and idx
// ---------------------------------------------------------------------------

describe('buildDialogueViewModel criterion 7: choices array with correct text and idx', () => {
  it('BITES: one choice → choices has one entry with text and idx=0', () => {
    // Kills: an impl that drops choices or uses 1-based indexing.
    // Choice index 0 is what advance_dialogue sends to the server.
    const conv = makeConv(1n, 'greeting');
    const npc = makeNpc(1n, { dialogueTreeId: 'elder_oak_talk' });
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const greetingNode = makeNode('Hello', [{ text: 'I seek a quest.' }]);
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('greeting', new Map([['greeting', greetingNode]]))],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.choices).toHaveLength(1);
    expect(result!.choices[0]!.text).toBe('I seek a quest.');
    expect(result!.choices[0]!.idx).toBe(0);
  });

  it('BITES: two choices → idx=0 for first, idx=1 for second (advance_dialogue sends this)', () => {
    // Critical: the server validates choice_idx sent by the client. A 1-based
    // or swapped idx would cause the server to reject or execute the wrong branch.
    // Kills: an impl that uses 1-based index or reverses choice order.
    const conv = makeConv(1n, 'greeting');
    const npc = makeNpc(1n, { dialogueTreeId: 'elder_oak_talk' });
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const greetingNode = makeNode('Hello', [{ text: 'First choice' }, { text: 'Second choice' }]);
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('greeting', new Map([['greeting', greetingNode]]))],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.choices).toHaveLength(2);
    expect(result!.choices[0]!.text).toBe('First choice');
    expect(result!.choices[0]!.idx).toBe(0);
    expect(result!.choices[1]!.text).toBe('Second choice');
    expect(result!.choices[1]!.idx).toBe(1);
  });

  it('BITES: three choices → idx values are 0, 1, 2 in order (not reversed, not shuffled)', () => {
    // Kills: an impl that reverses, sorts, or shuffles choices.
    const conv = makeConv(1n, 'greeting');
    const npc = makeNpc(1n);
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const choices = [{ text: 'Option A' }, { text: 'Option B' }, { text: 'Option C' }];
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('greeting', new Map([['greeting', makeNode('Hello', choices)]]))],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.choices).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(result!.choices[i]!.idx).toBe(i);
      expect(result!.choices[i]!.text).toBe(choices[i]!.text);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 8 — Empty choices array when node has no choices
// ---------------------------------------------------------------------------

describe('buildDialogueViewModel criterion 8: empty choices when node has no choices', () => {
  it('BITES: node with zero choices → choices=[] (not null, not undefined)', () => {
    // Kills: an impl that returns null instead of [] or that omits the choices field.
    const conv = makeConv(1n, 'terminal');
    const npc = makeNpc(1n);
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const terminalNode = makeNode('Farewell, traveller.', []);
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('terminal', new Map([['terminal', terminalNode]]))],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(Array.isArray(result!.choices)).toBe(true);
    expect(result!.choices).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 9 — TOTAL: never throws on any input combination
// ---------------------------------------------------------------------------

describe('buildDialogueViewModel criterion 9: total function — never throws', () => {
  it('BITES: all-empty inputs with conv defined → no throw', () => {
    // A throw here would starve batch listeners (store.flushBatch has NO isolation).
    expect(() => {
      buildDialogueViewModel(makeConv(1n), new Map(), new Map());
    }).not.toThrow();
  });

  it('BITES: npcEntityId=0n (bigint zero treated as falsy in some impls) → no throw', () => {
    // Kills: an impl that guards `if (!npcEntityId)` and crashes or skips the lookup.
    const conv = makeConv(0n);
    const npc = makeNpc(0n);
    const npcs = new Map<bigint, StoreNpcRow>([[0n, npc]]);
    const content = new Map<string, ClientDialogueTree>([
      ['elder_oak_talk', makeTree('g', new Map([['g', makeNode('Hi')]]))],
    ]);
    expect(() => {
      buildDialogueViewModel(conv, npcs, content);
    }).not.toThrow();
  });

  it('BITES: currentNodeId="" (empty string) → no throw, returns "..." or node from bundle', () => {
    // Kills: an impl that throws on empty nodeId.
    const conv = makeConv(1n, '');
    const npc = makeNpc(1n);
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    expect(() => {
      buildDialogueViewModel(conv, npcs, new Map());
    }).not.toThrow();
  });

  it('BITES: conv=undefined + empty maps → null, no throw', () => {
    expect(() => {
      const r = buildDialogueViewModel(undefined, new Map(), new Map());
      expect(r).toBeNull();
    }).not.toThrow();
  });

  it('BITES fast-check: never throws for any structurally valid input', () => {
    // Property: no combination of valid-typed inputs should crash the pure model.
    // Kills: any impl with uncaught Map.get() access or missing null-check.
    fc.assert(
      fc.property(
        fc.option(
          fc.record({
            ownerIdentity: fc.string({ maxLength: 20 }),
            npcEntityId: fc.bigInt({ min: 0n, max: 999n }),
            currentNodeId: fc.string({ maxLength: 20 }),
          }),
        ),
        (conv) => {
          expect(() => {
            buildDialogueViewModel(conv ?? undefined, new Map(), new Map());
          }).not.toThrow();
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 10 — Choice indices match bundle array index (0-based)
// ---------------------------------------------------------------------------

describe('buildDialogueViewModel criterion 10: idx is array index (0-based)', () => {
  it('BITES fast-check: for N choices, idx[i] === i for all i', () => {
    // Property: the idx field must be the zero-based array index regardless of choice count.
    // Kills: any impl that uses 1-based, reverse, or non-sequential idx values.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 }), (choiceCount) => {
        const choices = Array.from({ length: choiceCount }, (_, i) => ({ text: `Option ${i}` }));
        const conv = makeConv(1n, 'node');
        const npc = makeNpc(1n);
        const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
        const content = new Map<string, ClientDialogueTree>([
          ['elder_oak_talk', makeTree('node', new Map([['node', makeNode('Text', choices)]]))],
        ]);
        const result = buildDialogueViewModel(conv, npcs, content);
        if (result === null) {
          // should not be null with valid NPC — fail to surface the bug
          expect(result).not.toBeNull();
          return;
        }
        expect(result.choices).toHaveLength(choiceCount);
        for (let i = 0; i < choiceCount; i++) {
          expect(result.choices[i]!.idx).toBe(i);
        }
      }),
    );
  });

  it('BITES: DialogueViewModel has all required fields (shape contract)', () => {
    // Kills: an impl that omits npcName, nodeText, choices, or canDismiss.
    const conv = makeConv(1n, 'greeting');
    const npc = makeNpc(1n, { npcId: 'elder_oak', dialogueTreeId: 'elder_oak_talk' });
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const content = new Map<string, ClientDialogueTree>([
      [
        'elder_oak_talk',
        makeTree(
          'greeting',
          new Map([
            ['greeting', makeNode('The ancient oak greets you.', [{ text: 'Tell me more.' }])],
          ]),
        ),
      ],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('npcName');
    expect(result).toHaveProperty('nodeText');
    expect(result).toHaveProperty('choices');
    expect(result).toHaveProperty('canDismiss');
    // Spot-check values
    expect(result!.npcName).toBe('elder_oak');
    expect(result!.nodeText).toBe('The ancient oak greets you.');
    expect(Array.isArray(result!.choices)).toBe(true);
    expect(typeof result!.canDismiss).toBe('boolean');
  });

  it('BITES: canDismiss is true when conversation is present', () => {
    // The dismissPending guard lives in main.ts, not in the pure model.
    // buildDialogueViewModel is a pure function of its inputs; when a conversation
    // is present (conv !== undefined, NPC found), canDismiss must always be true.
    // Kills: an impl that hard-codes canDismiss: false, omits the field, or
    // ties canDismiss to state that the pure model does not receive.
    const conv = makeConv(1n, 'greeting');
    const npc = makeNpc(1n, { npcId: 'elder_oak', dialogueTreeId: 'elder_oak_talk' });
    const npcs = new Map<bigint, StoreNpcRow>([[1n, npc]]);
    const content = new Map<string, ClientDialogueTree>([
      [
        'elder_oak_talk',
        makeTree('greeting', new Map([['greeting', makeNode('Hello', [{ text: 'Goodbye.' }])]])),
      ],
    ]);
    const result = buildDialogueViewModel(conv, npcs, content);
    expect(result).not.toBeNull();
    expect(result!.canDismiss).toBe(true);
  });
});

// =============================================================================
// M12d gating: dialogueContent.ts bundle text must match 000-core.ron
//
// FINDING: game-core/content/dialogue_trees/000-core.ron node "greeting" has
//   text: "The ancient oak spirit greets you."
// but dialogueContent.ts bundles:
//   text: 'Welcome, traveler. The forest has been restless of late.'
// The C6 eval cross-ref checks node IDs and choice *counts* but NOT the actual
// text. This mismatch is invisible to every passing test and eval because:
//   - The eval only verifies node id presence and choice count.
//   - dialogueModel.test.ts Criterion 4 uses inline makeNode() test data, not
//     the real DIALOGUE_TREES import — it never reads dialogueContent.ts.
//   - No test imports both the real DIALOGUE_TREES constant and the RON text.
//
// A player talking to the Elder Oak NPC will see the wrong greeting. The
// DIALOGUE_TREES constant used in production is imported from dialogueContent.ts;
// build the model against it and assert the canonical RON text is rendered.
// =============================================================================

describe('M12d gating: dialogueContent.ts bundle text matches 000-core.ron (RT-DLG-01)', () => {
  it('GATING: elder_oak_talk/greeting node text matches the RON source exactly', () => {
    // The RON source (000-core.ron) text for node "greeting" is:
    //   "The ancient oak spirit greets you."
    // dialogueContent.ts currently bundles:
    //   "Welcome, traveler. The forest has been restless of late."
    // A player will see the wrong text in production. This test locks the
    // canonical text so bundle drift is caught by CI.
    const conv: StorePlayerConversation = {
      ownerIdentity: 'player-hex',
      npcEntityId: 1n,
      currentNodeId: 'greeting',
    };
    const npc: StoreNpcRow = {
      entityId: 1n,
      npcId: 'elder_oak',
      zoneId: 0,
      homeX: 5,
      homeY: 5,
      wanderRadius: 2,
      dialogueTreeId: 'elder_oak_talk',
    };
    const npcs = new Map([[1n, npc]]);
    const result = buildDialogueViewModel(conv, npcs, DIALOGUE_TREES);
    expect(result).not.toBeNull();
    // Canonical text from 000-core.ron — fix dialogueContent.ts to match.
    expect(result!.nodeText).toBe('The ancient oak spirit greets you.');
  });

  it('GATING: elder_oak_talk has exactly 1 choice with text "I seek a quest." (matches RON)', () => {
    // The C6 eval already checks choice count (1) but not the choice text.
    // This pins the exact text so a bundle editor cannot swap choice text silently.
    const conv: StorePlayerConversation = {
      ownerIdentity: 'player-hex',
      npcEntityId: 1n,
      currentNodeId: 'greeting',
    };
    const npc: StoreNpcRow = {
      entityId: 1n,
      npcId: 'elder_oak',
      zoneId: 0,
      homeX: 5,
      homeY: 5,
      wanderRadius: 2,
      dialogueTreeId: 'elder_oak_talk',
    };
    const npcs = new Map([[1n, npc]]);
    const result = buildDialogueViewModel(conv, npcs, DIALOGUE_TREES);
    expect(result).not.toBeNull();
    expect(result!.choices).toHaveLength(1);
    expect(result!.choices[0]!.text).toBe('I seek a quest.');
    expect(result!.choices[0]!.idx).toBe(0);
  });
});

// =============================================================================
// uxd2 (ADR-0161 D4) — GREET-THEN-SHOP: DialogueViewModel gains `shopAction`.
// APPENDED BLOCK — nothing above this line is modified.
//
// SOURCE OF TRUTH: docs/specs/uxd2-plan.md AC-2 + docs/adr/0161-*.md §D4.
//
// CONTRACT:
//   DialogueViewModel += readonly shopAction: { readonly shopId: number } | null
//   Derived in buildDialogueViewModel from `npcs.get(conv.npcEntityId).interaction`:
//     { kind:'shop', shopId }      -> { shopId }
//     { kind:'dialogue' }          -> null
//     { kind:'heal', locationId }  -> null
//   The derivation is from the SERVER ENUM, never from choice text (un-pinnable string
//   coupling) and never from a second content source (would drift from the enum SSOT).
//   BOTH '...'-fallback arms (missing tree / missing node) also carry shopAction — the
//   npc row IS present in those arms, so the Shop affordance must survive a content gap
//   (a shopkeeper whose greeting tree failed to bundle must still be shoppable).
//   The missing-NPC arm still returns a null VM (no shopAction to speak of).
//
// RED TODAY: buildDialogueViewModel returns no `shopAction` key at all, so every
// `toEqual`/`toBe` below reads `undefined`. The failures are assertion failures on the
// missing field, not import errors.
//
// FIXTURE NOTE: these cases build their NPC rows against the REAL `StoreNpcRow`
// (imported below) rather than the file-local mirror at the top, so the `interaction`
// discriminants are pinned to the shipped type. The local mirror + its makeNpc factory
// are deliberately left untouched.
// =============================================================================

import type { StoreNpcRow as RealStoreNpcRow } from '../net/store';

type Uxd2Interaction = RealStoreNpcRow['interaction'];

function shopNpc(
  entityId: bigint,
  interaction: Uxd2Interaction,
  dialogueTreeId = 'elder_oak_talk',
): RealStoreNpcRow {
  return {
    entityId,
    npcId: `npc-${entityId}`,
    zoneId: 1,
    homeX: 8,
    homeY: 1,
    wanderRadius: 0,
    dialogueTreeId,
    interaction,
  };
}

const UXD2_CONV = { ownerIdentity: 'player-hex', npcEntityId: 42n, currentNodeId: 'greeting' };

describe('uxd2 AC-2: buildDialogueViewModel derives shopAction from npc.interaction', () => {
  it('★ BITES: a Shop NPC yields shopAction = { shopId } taken from the enum payload', () => {
    // WRONG IMPL KILLED: a VM that never exposes the Shop affordance — greet-then-shop would
    // be unreachable, because the ONLY path from the greeting to the shop overlay is this
    // field (main.ts renders [data-shop-id] from it).
    const npcs = new Map([[42n, shopNpc(42n, { kind: 'shop', shopId: 7 })]]);
    const vm = buildDialogueViewModel(UXD2_CONV, npcs, DIALOGUE_TREES);
    expect(vm).not.toBeNull();
    expect(vm!.shopAction).toEqual({ shopId: 7 });
  });

  it('★ BITES: shopId 0 is preserved (falsy-0 trap — `??`, never `||`)', () => {
    // WRONG IMPL KILLED: `shopAction: npc.interaction.shopId ? { shopId } : null` or
    // `shopId || 1`. Shop id 0 is representable (u32); a truthiness derivation would make a
    // shop-0 NPC silently un-shoppable (AC-16 payload-read discipline, rowConvert.ts:277).
    const npcs = new Map([[42n, shopNpc(42n, { kind: 'shop', shopId: 0 })]]);
    const vm = buildDialogueViewModel(UXD2_CONV, npcs, DIALOGUE_TREES);
    expect(vm!.shopAction).toEqual({ shopId: 0 });
  });

  it('BITES: a Dialogue NPC yields shopAction = null (exactly null, not undefined)', () => {
    // WRONG IMPL KILLED (1): an impl that always emits a shopAction — every villager would
    //   render a Shop button opening the first shop.
    // WRONG IMPL KILLED (2): an impl that omits the key entirely on this arm — the view's
    //   `if (vm.shopAction)` would still work, but the VM shape would be non-total and the
    //   `toBeNull` contract (the one dialogueView renders against) unpinned.
    const npcs = new Map([[42n, shopNpc(42n, { kind: 'dialogue' })]]);
    const vm = buildDialogueViewModel(UXD2_CONV, npcs, DIALOGUE_TREES);
    expect(vm!.shopAction).toBeNull();
  });

  it('BITES: a Heal NPC yields shopAction = null (heal is not a shop)', () => {
    // WRONG IMPL KILLED: an impl that treats every non-dialogue variant as "has a payload,
    // therefore a shop" — a Heal NPC would render a Shop button bound to its locationId as a
    // shopId, opening an unrelated shop (or 'no-shop').
    const npcs = new Map([[42n, shopNpc(42n, { kind: 'heal', locationId: 3 })]]);
    const vm = buildDialogueViewModel(UXD2_CONV, npcs, DIALOGUE_TREES);
    expect(vm!.shopAction).toBeNull();
  });

  it('★ BITES: the MISSING-TREE "..." fallback arm still carries shopAction', () => {
    // ADR-0161 D4: the Shop affordance is derived from the ENUM, not from content, so a
    // content gap must not remove it. The npc row IS present in this arm.
    // WRONG IMPL KILLED: an impl that computes shopAction only on the happy path and returns
    // the pre-existing `{ npcName, nodeText:'...', choices:[], canDismiss:true }` literal
    // unchanged in the two fallback arms — a shopkeeper whose tree failed to bundle would
    // show "..." with no way out but Escape, and the e2e's greet-then-shop chain would die
    // on exactly the day dialogueContent.ts drifts.
    const npcs = new Map([[42n, shopNpc(42n, { kind: 'shop', shopId: 1 }, 'nonexistent_tree')]]);
    const vm = buildDialogueViewModel(UXD2_CONV, npcs, DIALOGUE_TREES);
    expect(vm).not.toBeNull();
    expect(vm!.nodeText).toBe('...'); // proves we really are in the fallback arm
    expect(vm!.shopAction).toEqual({ shopId: 1 });
  });

  it('★ BITES: the MISSING-NODE "..." fallback arm still carries shopAction', () => {
    // Second fallback arm (tree found, currentNodeId absent — e.g. a server node id the
    // client bundle does not know). Same rationale, separate code path.
    // WRONG IMPL KILLED: an impl that patched only ONE of the two fallback returns.
    const npcs = new Map([[42n, shopNpc(42n, { kind: 'shop', shopId: 1 })]]);
    const conv = { ...UXD2_CONV, currentNodeId: 'no_such_node' };
    const vm = buildDialogueViewModel(conv, npcs, DIALOGUE_TREES);
    expect(vm).not.toBeNull();
    expect(vm!.nodeText).toBe('...'); // proves we really are in the fallback arm
    expect(vm!.shopAction).toEqual({ shopId: 1 });
  });

  it('BITES: the missing-NPC arm still returns null (no fabricated shopAction VM)', () => {
    // WRONG IMPL KILLED: an impl that, while adding shopAction, "helpfully" starts returning a
    // partial VM when the npc row has not arrived yet — the overlay would flash an empty
    // dialogue with a Shop button bound to nothing during the reconnect hydration gap.
    const vm = buildDialogueViewModel(UXD2_CONV, new Map(), DIALOGUE_TREES);
    expect(vm).toBeNull();
  });

  it('BITES: shopAction is derived from the ENUM, not from choice text (anti-coupling)', () => {
    // WRONG IMPL KILLED: an impl that string-matches a choice like "Shop" / "Browse wares" to
    // decide the affordance. The fixture's ONLY choice text is "I seek a quest." and the NPC
    // is a Shop NPC — a text-matching impl returns null here. The inverse (a dialogue NPC with
    // shop-sounding choice text) is covered by the Dialogue-NPC case above, whose seeded tree
    // choice text is unrelated to shopping.
    const npcs = new Map([[42n, shopNpc(42n, { kind: 'shop', shopId: 5 })]]);
    const vm = buildDialogueViewModel(UXD2_CONV, npcs, DIALOGUE_TREES);
    expect(vm!.choices.map((c) => c.text)).toEqual(['I seek a quest.']);
    expect(vm!.shopAction).toEqual({ shopId: 5 });
  });
});
