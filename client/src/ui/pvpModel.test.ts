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

  // RT-PVP-01: terminal-outgoing auto-show invariant.
  //
  // pvpView.refresh treats vm.outgoing !== null as "hasActive" and calls this.show().
  // If the model returns a non-null outgoing with a terminal status (Declined /
  // Accepted / Cancelled), the overlay auto-shows with an EMPTY outgoing section and
  // the challengeable player list visible — a phantom pop-up that the user cannot
  // explain.  The fix MUST be in the model: only return outgoing when status is
  // 'Pending' (matching pvpView.#renderOutgoing's own filter).
  it('RT-PVP-01: outgoing with Declined status must not be returned by the model (phantom-show guard)', () => {
    const c = makeChallenge(3n, ME, OTHER_A, 'Declined');
    const vm = buildPvpChallengeViewModel([c], ME, PLAYERS);
    // A Declined challenge is terminal; the model must treat it as absent so the view
    // cannot auto-show based on a non-null outgoing field.
    expect(vm.outgoing).toBeNull();
  });

  it('RT-PVP-01: outgoing with Cancelled status must not be returned by the model', () => {
    const c = makeChallenge(3n, ME, OTHER_A, 'Cancelled');
    const vm = buildPvpChallengeViewModel([c], ME, PLAYERS);
    expect(vm.outgoing).toBeNull();
  });

  it('RT-PVP-01: outgoing with Accepted status must not be returned by the model', () => {
    const c = makeChallenge(3n, ME, OTHER_A, 'Accepted');
    const vm = buildPvpChallengeViewModel([c], ME, PLAYERS);
    expect(vm.outgoing).toBeNull();
  });

  // RT-PVP-01: also verify the counterpart — Pending outgoing IS returned.
  it('RT-PVP-01: outgoing with Pending status is returned (baseline)', () => {
    const c = makeChallenge(3n, ME, OTHER_A, 'Pending');
    const vm = buildPvpChallengeViewModel([c], ME, PLAYERS);
    expect(vm.outgoing).not.toBeNull();
    expect(vm.outgoing?.status).toBe('Pending');
  });
});
