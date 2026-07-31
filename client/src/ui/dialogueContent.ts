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
  // uxd2 (ADR-0161 D4): the shopkeeper greeting mirror — one inert node with a
  // single conversation-ending Leave choice, matching the RON tree exactly.
  // The Shop affordance is derived from the server NpcInteraction enum in the
  // dialogue view model, NEVER from this content, so the tree stays a plain
  // greeting; drift against the RON is gated by dialogue-client-integrity C6.
  [
    'shopkeeper_greeting',
    {
      nodes: new Map([
        [
          'greeting',
          {
            text: 'Hello, customer!',
            choices: [{ text: 'Leave', nextNodeId: null }],
          },
        ],
      ]),
    },
  ],
]);
