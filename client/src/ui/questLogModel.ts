// ui/questLogModel.ts — pure quest log view model.
// TOTAL: never throws. Server deletes row on quest completion — no completed field.
import type { StorePlayerQuest } from '../net/store';

export interface QuestEntryViewModel {
  questId: string;
  stepIndex: number;
  displayName: string; // equals questId verbatim — no bundle metadata yet
}

export interface QuestLogViewModel {
  active: ReadonlyArray<QuestEntryViewModel>;
  // NO completed field — server deletes row on completion
}

export function buildQuestLogViewModel(quests: readonly StorePlayerQuest[]): QuestLogViewModel {
  return {
    active: quests.map((q) => ({
      questId: q.questId,
      stepIndex: q.stepIndex,
      displayName: q.questId,
    })),
  };
}
