// net/serverClock.test.ts — ts-6b-7.2: the server-time estimate the Still-there countdown and the PvP
// clock ring read instead of the raw device clock. Pure and node-only: no wall clock is read, every
// "local now" is an argument. SOURCE OF TRUTH: the ts-6b-7 contract (ServerClock: observe / now /
// observeWindows / forgetWindows).
import { describe, expect, it } from 'vitest';
import { stillThereSeconds } from '../ui/battlePolicy';
import { type ClockWindowRow, ServerClock } from './serverClock';

/** An arbitrary server epoch instant (ms). */
const SERVER = 1_700_000_000_000;
const row = (clockId: bigint, windowOpenMs: bigint | null): ClockWindowRow => ({
  clockId,
  windowOpenMs,
});

describe('ts-6b-7: ServerClock', () => {
  it('a client clock 60 s behind still counts the last minute of a window', () => {
    // WRONG IMPL KILLED: reading the raw device clock (50 s left by server time shows null); an
    // offset with the wrong sign (the countdown starts 120 s late); observing the FIRST sighting's
    // stale windowOpenMs; never observing the live transition; an estimate frozen at the observation
    // instant (it must tick with local time); a countdown that outlives the server deadline.
    const clock = new ServerClock();
    const behind = 60_000;
    const local = (serverMs: number): number => serverMs - behind;
    const deadline = BigInt(SERVER + 50_000);

    // First sighting (a snapshot row whose window opened long ago): remembered, nothing observed.
    clock.observeWindows([row(1n, BigInt(SERVER - 400_000))], local(SERVER - 1_000));
    expect(
      clock.now(local(SERVER)),
      'a first sighting leaves the estimate on the device clock',
    ).toBe(local(SERVER));
    // The live transition: the window opened "now" by the server's clock, seen at the device's.
    clock.observeWindows([row(1n, BigInt(SERVER))], local(SERVER));

    expect(clock.now(local(SERVER)), 'the estimate is the server instant').toBe(SERVER);
    expect(
      stillThereSeconds(deadline, local(SERVER)),
      'the raw device clock sees 110 s left: no countdown',
    ).toBeNull();
    expect(stillThereSeconds(deadline, clock.now(local(SERVER))), '50 s left by server time').toBe(
      50,
    );
    expect(
      stillThereSeconds(deadline, clock.now(local(SERVER + 10_000))),
      'ticks down with local time',
    ).toBe(40);
    expect(stillThereSeconds(deadline, clock.now(local(SERVER + 49_001))), 'the last second').toBe(
      1,
    );
    expect(
      stillThereSeconds(deadline, clock.now(local(SERVER + 50_000))),
      'null at the server deadline',
    ).toBeNull();
    expect(
      stillThereSeconds(deadline, clock.now(local(SERVER + 80_000))),
      'null past the server deadline',
    ).toBeNull();
  });

  it('now() is the device clock exactly before any observation', () => {
    // WRONG IMPL KILLED: an initial offset other than 0 (NaN, a guessed skew); now() ignoring its
    // argument.
    const clock = new ServerClock();
    expect(clock.now(12_345)).toBe(12_345);
    expect(clock.now(0)).toBe(0);
  });

  it('observe sets offset = serverMs - localNowMs and the latest call wins', () => {
    // WRONG IMPL KILLED: keeping the first sample; averaging or taking the min / max of samples (a
    // device clock step would never recover); the offset sign flipped.
    const clock = new ServerClock();
    clock.observe(10_000, 4_000);
    expect(clock.now(4_000)).toBe(10_000);
    expect(clock.now(9_000), 'local time still ticks').toBe(15_000);
    clock.observe(50_000, 49_000);
    expect(clock.now(49_000), 'the latest observation replaced the offset').toBe(50_000);
    expect(clock.now(50_000)).toBe(51_000);
    clock.observe(80_000, 90_000);
    expect(clock.now(90_000), 'a server BEHIND the device works too').toBe(80_000);
  });

  it('a non-finite argument is ignored and leaves the offset unchanged', () => {
    // WRONG IMPL KILLED: an offset poisoned to NaN / Infinity (every countdown goes null forever);
    // a non-finite sample replacing a good one.
    const clock = new ServerClock();
    clock.observe(Number.NaN, 5);
    clock.observe(5, Number.NaN);
    clock.observe(Number.POSITIVE_INFINITY, 5);
    clock.observe(5, Number.NEGATIVE_INFINITY);
    expect(clock.now(1_000), 'before any good sample: device clock').toBe(1_000);
    clock.observe(7_000, 1_000);
    clock.observe(Number.NaN, 2_000);
    clock.observe(9_000, Number.POSITIVE_INFINITY);
    expect(clock.now(2_000), 'the good offset (6000) survives').toBe(8_000);
  });

  it('a first sighting observes nothing and a change on a known id observes the new window', () => {
    // WRONG IMPL KILLED: observing every row on every batch (a snapshot's stale row skews the
    // estimate); never observing a change; observing with the wrong local instant.
    const clock = new ServerClock();
    clock.observeWindows([row(1n, 111n), row(2n, 222n)], 5_000);
    expect(clock.now(5_000), 'two first sightings: nothing observed').toBe(5_000);
    clock.observeWindows([row(1n, 111n), row(2n, 9_999n)], 6_000);
    expect(clock.now(6_000), 'row 2 changed: offset = 9999 - 6000').toBe(9_999);
    expect(clock.now(7_000)).toBe(10_999);
  });

  it('an unchanged re-delivery does not re-observe, so a later local time cannot drag the offset', () => {
    // WRONG IMPL KILLED: observing a row on every batch it is present in (the estimate would freeze
    // at the latest batch's local time and drift by the whole elapsed window).
    const clock = new ServerClock();
    clock.observeWindows([row(1n, 1_000n)], 100);
    clock.observeWindows([row(1n, 20_000n)], 10_000);
    expect(clock.now(10_000)).toBe(20_000);
    clock.observeWindows([row(1n, 20_000n)], 50_000);
    expect(clock.now(50_000), 'offset stays 10000 (not re-derived at 50000)').toBe(60_000);
    clock.observeWindows([], 60_000);
    clock.observeWindows([row(1n, 20_000n)], 70_000);
    expect(clock.now(70_000), 'an empty batch and a repeat change nothing').toBe(80_000);
  });

  it('a device clock step recovers at the next window: the latest observation wins', () => {
    // WRONG IMPL KILLED: a clock that keeps the first window's offset after the device clock was
    // corrected (the countdown stays 60 s off for the whole session).
    const clock = new ServerClock();
    clock.observeWindows([row(1n, 0n)], 0);
    clock.observeWindows([row(1n, BigInt(SERVER))], SERVER - 60_000);
    expect(clock.now(SERVER - 60_000)).toBe(SERVER);
    // The device clock is stepped right; the next window opens.
    clock.observeWindows([row(1n, BigInt(SERVER + 300_000))], SERVER + 300_000);
    expect(clock.now(SERVER + 300_000), 'offset back to 0').toBe(SERVER + 300_000);
  });

  it('null to a value counts as a new window, a value to null observes nothing', () => {
    // WRONG IMPL KILLED: forgetting a null (a null -> value change would read as first); observing
    // on a change to null; not remembering the null so the next real window is missed.
    const clock = new ServerClock();
    clock.observeWindows([row(1n, null)], 1_000);
    clock.observeWindows([row(1n, 8_000n)], 2_000);
    expect(clock.now(2_000), 'null -> value: observed').toBe(8_000);
    clock.observeWindows([row(1n, null)], 3_000);
    expect(clock.now(3_000), 'value -> null: nothing observed (offset kept: 6000)').toBe(9_000);
    clock.observeWindows([row(1n, 40_000n)], 4_000);
    expect(clock.now(4_000), 'null -> value later IS a new window').toBe(40_000);
  });

  it('forgetWindows makes the next sighting of each id first again but keeps the offset', () => {
    // WRONG IMPL KILLED: forgetWindows that never forgets (a reconnect snapshot row skews the
    // estimate); one that resets the offset to 0 (the countdown jumps back to the device clock).
    const clock = new ServerClock();
    clock.observeWindows([row(1n, 0n)], 0);
    clock.observeWindows([row(1n, 5_000n)], 1_000);
    expect(clock.now(1_000)).toBe(5_000);
    clock.forgetWindows();
    expect(clock.now(1_000), 'the offset (4000) is kept').toBe(5_000);
    clock.observeWindows([row(1n, 900_000n)], 2_000);
    expect(clock.now(2_000), 'a changed row after a forget is a FIRST sighting').toBe(6_000);
    clock.observeWindows([row(1n, 30_000n)], 3_000);
    expect(clock.now(3_000), 'and the change after that is live again').toBe(30_000);
  });

  it('clock ids past 2^53 stay distinct', () => {
    // WRONG IMPL KILLED: keying the memory on Number(clockId) (two ids past 2^53 collapse, so the
    // second reads as a changed window on a first batch); a Number-compared windowOpenMs.
    const a = 2n ** 53n;
    const b = a + 1n;
    const clock = new ServerClock();
    clock.observeWindows([row(a, 100n), row(b, 200n)], 1_000);
    expect(clock.now(1_000), 'two distinct first sightings: nothing observed').toBe(1_000);
    clock.observeWindows([row(a, 100n), row(b, 5_000n)], 2_000);
    expect(clock.now(2_000), 'only b changed').toBe(5_000);
  });
});
