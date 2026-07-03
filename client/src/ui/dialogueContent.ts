// ui/dialogueContent.ts — static client-side dialogue bundle (M12d, ADR-0071).
// Mirrors game-core/content/dialogue_trees/000-core.ron.
// No imports from SpacetimeDB. No fetch. No dynamic RegExp construction.

export interface ClientDialogueNode {
  text: string;
  choices: Array<{ text: string; nextNodeId: string | null }>;
}

export interface ClientDialogueTree {
  nodes: ReadonlyMap<string, ClientDialogueNode>;
}

export const DIALOGUE_TREES: ReadonlyMap<string, ClientDialogueTree> = new Map([
  [
    'elder_oak_talk',
    {
      nodes: new Map([
        [
          'greeting',
          {
            text: 'The ancient oak spirit greets you.',
            choices: [{ text: 'I seek a quest.', nextNodeId: null }],
          },
        ],
      ]),
    },
  ],
]);
