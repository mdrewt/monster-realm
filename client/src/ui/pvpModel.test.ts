// pvpModel.test.ts — unit tests for buildPvpChallengeViewModel (m16b, ADR-0110).
import { describe, expect, it } from 'vitest';
import type { StoreBattleChallenge, StorePlayer } from '../net/store';
import { buildPvpChallengeViewModel } from './pvpModel';

const ME = 'aabbcc';
const OTHER_A = '111111';
const OTHER_B = '222222';

function makePlayer(identity: string, name: string, online = true): StorePlayer {
  return { identity, entityId: 1n, name, online, lastInputSeq: 0n };
}

function makeChallenge(
  challengeId: bigint,
  challenger: string,
  target: string,
  status: string,
): StoreBattleChallenge {
  return { challengeId, challenger, target, challengerPartyIds: [], status, createdAtMs: 0n };
}

const PLAYERS: StorePlayer[] = [
  makePlayer(ME, 'Me'),
  makePlayer(OTHER_A, 'Alice'),
  makePlayer(OTHER_B, 'Bob'),
];

describe('buildPvpChallengeViewModel', () => {
  it('returns null incoming and outgoing when no challenges', () => {
    const vm = buildPvpChallengeViewModel([], ME, PLAYERS);
    expect(vm.incoming).toBeNull();
    expect(vm.outgoing).toBeNull();
    expect(vm.challengeablePlayers.map((p) => p.identity)).toContain(OTHER_A);
    expect(vm.challengeablePlayers.map((p) => p.identity)).toContain(OTHER_B);
    // self never appears in challengeable list
    expect(vm.challengeablePlayers.map((p) => p.identity)).not.toContain(ME);
  });

  it('surfaces incoming challenge targeting this player', () => {
    const c = makeChallenge(1n, OTHER_A, ME, 'Pending');
    const vm = buildPvpChallengeViewModel([c], ME, PLAYERS);
    expect(vm.incoming).not.toBeNull();
    expect(vm.incoming?.challengeId).toBe(1n);
    expect(vm.incoming?.challengerName).toBe('Alice');
  });

  it('does not surface incoming challenge targeting a different player', () => {
    const c = makeChallenge(1n, ME, OTHER_A, 'Pending');
    const vm = buildPvpChallengeViewModel([c], ME, PLAYERS);
    expect(vm.incoming).toBeNull();
  });

  it('surfaces the most-recent outgoing challenge by highest challengeId', () => {
    const c1 = makeChallenge(1n, ME, OTHER_A, 'Pending');
    const c2 = makeChallenge(5n, ME, OTHER_B, 'Pending');
    const vm = buildPvpChallengeViewModel([c1, c2], ME, PLAYERS);
    expect(vm.outgoing?.challengeId).toBe(5n);
    expect(vm.outgoing?.targetName).toBe('Bob');
  });

  it('excludes players already in a Pending challenge from challengeable list', () => {
    const c = makeChallenge(1n, OTHER_A, OTHER_B, 'Pending');
    const vm = buildPvpChallengeViewModel([c], ME, PLAYERS);
    expect(vm.challengeablePlayers.map((p) => p.identity)).not.toContain(OTHER_A);
    expect(vm.challengeablePlayers.map((p) => p.identity)).not.toContain(OTHER_B);
  });

  it('excludes offline players from challengeable list', () => {
    const players: StorePlayer[] = [
      makePlayer(ME, 'Me'),
      makePlayer(OTHER_A, 'Alice', false), // offline
      makePlayer(OTHER_B, 'Bob'),
    ];
    const vm = buildPvpChallengeViewModel([], ME, players);
    expect(vm.challengeablePlayers.map((p) => p.identity)).not.toContain(OTHER_A);
    expect(vm.challengeablePlayers.map((p) => p.identity)).toContain(OTHER_B);
  });

  it('falls back to truncated identity hex when name is not in player list', () => {
    const c = makeChallenge(1n, 'deadbeef1234', ME, 'Pending');
    const vm = buildPvpChallengeViewModel([c], ME, PLAYERS);
    // No player row for 'deadbeef1234' → name falls back to first 8 chars
    expect(vm.incoming?.challengerName).toBe('deadbeef');
  });
});
