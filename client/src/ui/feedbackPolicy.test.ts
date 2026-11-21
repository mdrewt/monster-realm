/**
 * feedbackPolicy.test.ts: the four-channel policy table (uif-4: UIF4.1, UIF4.6).
 *
 * The expectations below are the channel table of
 * specs/monster-realm-v2/M-ui-foundation-wireframes.md (### Channel table), typed here row by
 * row. Nothing is derived from the module under test, so a policy that drifts from the table
 * (a kind moved to another channel, a kind dropped, a kind invented) fails by name.
 *
 * Named discrepancy: the brief and plan say "63 kinds"; the table has 64 rows
 * (16 hint + 37 toast + 10 modal + 1 blocking). The table is the contract, so the roster below
 * is the table, and no test pins a bare count.
 *
 * uif-16b (named intentional change, WF1-A10): the `privacy-busy` toast retires (Profile is one
 * dialog, so the privacy surface can never be "busy behind" the account one): 64 -> 63 rows
 * (16 hint + 36 toast + 10 modal + 1 blocking), 23 -> 22 action-required rows.
 *
 * ts-6b-12 (named intentional change): four toast kinds no code produces retire: 63 -> 59 rows
 * (16 hint + 32 toast + 10 modal + 1 blocking).
 *
 * ts-6b-13 (named intentional change): the `heal-unavailable` toast kind retires with the
 * location-less heal path (the healParty command always carries its locationId): 59 -> 58 rows
 * (16 hint + 31 toast + 10 modal + 1 blocking).
 *
 * The table has 59 rows (17 hint + 31 toast + 10 modal + 1 blocking), 23 of them action-required;
 * `protocol-mismatch` is the one hint of rank 4.
 */
import { describe, expect, it } from 'vitest';
import {
  type Channel,
  channelOf,
  FEEDBACK_POLICY,
  hintRank,
  type MessageKind,
  outranks,
  type PolicyRow,
} from './feedbackPolicy';

/** The table's Channel column, every row, literally. */
const EXPECTED_CHANNEL: Record<MessageKind, Channel> = {
  'y-description': 'hint',
  'disabled-reason-menu': 'hint',
  'disabled-reason-row': 'hint',
  'capture-prompt': 'hint',
  'controls-refused': 'hint',
  'claim-veto': 'hint',
  'walkup-chip': 'hint',
  'walkup-choose': 'hint',
  'trade-request': 'hint',
  'challenge-request': 'hint',
  'deletion-countdown': 'hint',
  'privacy-notice': 'hint',
  'world-disconnect': 'hint',
  'connect-failure': 'hint',
  'content-stale': 'hint',
  'download-blocked': 'hint',
  // The protocol mismatch line.
  'protocol-mismatch': 'hint',
  'care-success': 'toast',
  'care-rejected': 'toast',
  'monsters-move-ok': 'toast',
  'feed-ok': 'toast',
  'feed-rejected': 'toast',
  'bag-feed-blocked': 'toast',
  'party-full': 'toast',
  'party-move-rejected': 'toast',
  'nickname-rejected': 'toast',
  'evolve-rejected': 'toast',
  'heal-rejected': 'toast',
  'shop-buy-ok': 'toast',
  'shop-sell-ok': 'toast',
  'shop-rejected': 'toast',
  // ts-6b-12 (named intentional change): the four toast kinds nothing produces retire with the
  // offer/wizard path: 'trade-answered', 'trade-settled', 'trade-offer-sent' and
  // 'trade-propose-rejected'. Was: all four listed as toast.
  'trade-cancelled': 'toast',
  'trade-rejected': 'toast',
  'rename-saved': 'toast',
  'rename-rejected': 'toast',
  'controls-saved': 'toast',
  'controls-cancelled': 'toast',
  'controls-save-failed': 'toast',
  'pvp-rejected': 'toast',
  'link-down-send': 'toast',
  'link-down-view': 'toast',
  // uif-16b (named intentional change, WF1-A10): 'privacy-busy': 'toast' retired.
  'zone-cue': 'toast',
  'dialogue-ended': 'toast',
  'quest-complete': 'toast',
  'world-send-rejected': 'toast',
  'battle-refused': 'toast',
  'queue-too-late': 'toast',
  'battle-command-rejected': 'toast',
  'evolution-reveal': 'modal',
  'evolve-confirm': 'modal',
  'decline-confirm': 'modal',
  'trade-final-confirm': 'modal',
  'trade-send-confirm': 'modal',
  'challenge-confirm': 'modal',
  'buy-sell-confirm': 'modal',
  'heal-confirm': 'modal',
  'controls-reset-confirm': 'modal',
  'deletion-phase-confirm': 'modal',
  'npc-dialogue': 'blocking',
};

const TABLE_KINDS = Object.keys(EXPECTED_CHANNEL) as MessageKind[];
const kindsOf = (channel: Channel): MessageKind[] =>
  TABLE_KINDS.filter((k) => EXPECTED_CHANNEL[k] === channel);

/** The table's "Player must act = yes" rows, literally (8 hint, 4 toast, 10 modal,
 *  1 blocking).
 *  uif-16b (named intentional change, WF1-A10): 5 -> 4 toast, 'privacy-busy' retired. */
const ACTION_REQUIRED: readonly MessageKind[] = [
  'capture-prompt',
  'controls-refused',
  'claim-veto',
  'trade-request',
  'challenge-request',
  'content-stale',
  'download-blocked',
  'protocol-mismatch',
  'party-full',
  'link-down-send',
  'link-down-view',
  'battle-command-rejected',
  'evolution-reveal',
  'evolve-confirm',
  'decline-confirm',
  'trade-final-confirm',
  'trade-send-confirm',
  'challenge-confirm',
  'buy-sell-confirm',
  'heal-confirm',
  'controls-reset-confirm',
  'deletion-phase-confirm',
  'npc-dialogue',
];

const rows = (): Array<[MessageKind, PolicyRow]> =>
  (Object.entries(FEEDBACK_POLICY) as Array<[MessageKind, PolicyRow]>).slice();

describe('feedbackPolicy (uif-4)', () => {
  // ---------------------------------------------------------------- UIF4.1
  it('UIF4.1 FEEDBACK_POLICY has a row for exactly the table kinds', () => {
    // WRONG IMPL KILLED: a policy object that omits a kind or carries an extra one.
    expect(Object.keys(FEEDBACK_POLICY).sort()).toEqual([...TABLE_KINDS].sort());
  });

  it('UIF4.1 every kind sits on the channel the table gives it (full literal kind-to-channel map)', () => {
    // WRONG IMPL KILLED: any single kind moved to another channel (a toast kind on the hint line,
    // a modal downgraded to a toast), which a channel-membership check would pass.
    const actual: Record<string, string> = {};
    for (const [kind, row] of rows()) actual[kind] = row.channel;
    expect(actual).toEqual(EXPECTED_CHANNEL);
  });

  it('UIF4.1 channelOf agrees with the policy row for every kind', () => {
    // WRONG IMPL KILLED: a channelOf that reads a second table, or defaults everything to toast.
    const actual: Record<string, string> = {};
    for (const kind of TABLE_KINDS) actual[kind] = channelOf(kind);
    expect(actual).toEqual(EXPECTED_CHANNEL);
  });

  it('UIF4.1 the four channels hold 17 hint, 31 toast, 10 modal and 1 blocking kind', () => {
    // WRONG IMPL KILLED: a table typed to compile but with a channel emptied or bloated.
    expect(kindsOf('hint')).toHaveLength(17);
    expect(
      rows()
        .filter(([, r]) => r.channel === 'hint')
        .map(([k]) => k)
        .sort(),
    ).toEqual(kindsOf('hint').sort());
    // uif-16b (named intentional change, WF1-A10): 37 -> 36 toast kinds, 'privacy-busy' retired.
    expect(rows().filter(([, r]) => r.channel === 'toast')).toHaveLength(31);
    expect(rows().filter(([, r]) => r.channel === 'modal')).toHaveLength(10);
    expect(rows().filter(([, r]) => r.channel === 'blocking')).toHaveLength(1);
  });

  it('UIF4.1 a Record over MessageKind with a missing kind does not compile (exhaustiveness)', () => {
    // WRONG IMPL KILLED: a MessageKind widened to `string` (the type then accepts any partial
    // record). Checked by tsc: an unused directive is itself an error.
    const ROW: PolicyRow = { channel: 'hint', actionRequired: false, alsoCarriedBy: null };
    // @ts-expect-error uif-4 UIF4.1: a partial record must fail tsc, a missing kind is a type error.
    const partial: Record<MessageKind, PolicyRow> = { 'y-description': ROW };
    expect(Object.keys(partial)).toEqual(['y-description']);
  });

  it('UIF4.1 hintRank is 3 for every other action-required hint kind', () => {
    // WRONG IMPL KILLED: a rank table that forgets a "yes" hint row (a claim veto would lose to
    // a disabled reason on the strip).
    // 'protocol-mismatch' is the one action-required hint of rank 4 (its own test below), so it is not in this list.
    const rank3: MessageKind[] = [
      'capture-prompt',
      'controls-refused',
      'claim-veto',
      'trade-request',
      'challenge-request',
      'content-stale',
      'download-blocked',
    ];
    for (const kind of rank3) expect(hintRank(kind), kind).toBe(3);
  });

  it('UIF4.1 hintRank is 2 for the persistent states world-disconnect and connect-failure', () => {
    // WRONG IMPL KILLED: persistent state ranked with the disabled reasons or the action rows.
    expect(hintRank('world-disconnect')).toBe(2);
    expect(hintRank('connect-failure')).toBe(2);
  });

  it('UIF4.1 hintRank is 1 for the disabled reasons', () => {
    // WRONG IMPL KILLED: a disabled reason ranked level with a Y-description (it must outrank it).
    expect(hintRank('disabled-reason-menu')).toBe(1);
    expect(hintRank('disabled-reason-row')).toBe(1);
  });

  it('UIF4.1 hintRank is 0 for every other hint kind', () => {
    // WRONG IMPL KILLED: the lowest hints ranked above a disabled reason.
    const rank0: MessageKind[] = [
      'y-description',
      'walkup-chip',
      'walkup-choose',
      'deletion-countdown',
      'privacy-notice',
    ];
    for (const kind of rank0) expect(hintRank(kind), kind).toBe(0);
  });

  it('UIF4.1 hintRank is -1 for every kind that is not a hint (never on a strip)', () => {
    // WRONG IMPL KILLED: a toast or modal kind given a hint rank (it could take the strip).
    const nonHint = TABLE_KINDS.filter((k) => EXPECTED_CHANNEL[k] !== 'hint');
    // uif-16b (named intentional change, WF1-A10): 48 -> 47, 'privacy-busy' retired.
    // ts-6b-13 (named intentional change): 43 -> 42 (31 toast + 10 modal + 1 blocking), the
    // heal-unavailable kind retires.
    expect(nonHint).toHaveLength(42);
    for (const kind of nonHint) expect(hintRank(kind), kind).toBe(-1);
  });

  it('UIF4.1 outranks: a higher rank replaces, an equal rank replaces (newer wins), a lower rank does not', () => {
    // WRONG IMPL KILLED: strict `>` (a repeated disconnect text never refreshes), `<=` or an
    // inverted comparison (a Y-description clobbers a standing disconnect).
    expect(outranks('world-disconnect', 'y-description')).toBe(true);
    expect(outranks('content-stale', 'world-disconnect')).toBe(true);
    expect(outranks('disabled-reason-row', 'y-description')).toBe(true);
    expect(outranks('world-disconnect', 'world-disconnect')).toBe(true);
    expect(outranks('connect-failure', 'world-disconnect')).toBe(true);
    expect(outranks('y-description', 'y-description')).toBe(true);
    expect(outranks('y-description', 'world-disconnect')).toBe(false);
    expect(outranks('disabled-reason-menu', 'world-disconnect')).toBe(false);
    expect(outranks('world-disconnect', 'content-stale')).toBe(false);
    expect(outranks('y-description', 'disabled-reason-menu')).toBe(false);
  });

  // ---------------------------------------------------------------- UIF4.6
  it('UIF4.6 the action-required kinds are exactly the table "yes" rows', () => {
    // WRONG IMPL KILLED: a toast kind quietly marked actionRequired:false to dodge the rule, a
    // kind wrongly marked true, or a "yes" row dropped.
    const actual = rows()
      .filter(([, r]) => r.actionRequired === true)
      .map(([k]) => k)
      .sort();
    expect(actual).toEqual([...ACTION_REQUIRED].sort());
  });

  it('UIF4.6 every action-required toast kind names what also carries it', () => {
    // WRONG IMPL KILLED: a must-act toast with alsoCarriedBy null or an empty string (the message
    // would exist only on a timed channel).
    const toastYes = ACTION_REQUIRED.filter((k) => EXPECTED_CHANNEL[k] === 'toast');
    expect(toastYes.sort()).toEqual([
      'battle-command-rejected',
      'link-down-send',
      'link-down-view',
      'party-full',
      // uif-16b (named intentional change, WF1-A10): 'privacy-busy' retired.
    ]);
    for (const kind of toastYes) {
      const carried = FEEDBACK_POLICY[kind].alsoCarriedBy;
      expect(typeof carried, kind).toBe('string');
      expect((carried ?? '').trim().length, kind).toBeGreaterThan(0);
    }
  });

  it('UIF4.6 every row that does not need the player to act has alsoCarriedBy null', () => {
    // WRONG IMPL KILLED: a carrier invented for a purely informational row.
    for (const [kind, row] of rows()) {
      if (!ACTION_REQUIRED.includes(kind)) expect(row.alsoCarriedBy, kind).toBeNull();
    }
  });

  // ---------------------------------------------------------------- the protocol mismatch hint
  it('protocol-mismatch is a hint the player must act on, carried by the world hint line until reload [lpw-4.4]', () => {
    // WRONG IMPL KILLED: the mismatch routed to the toast (gone when its timer ends); a row
    // marked informational; the content-stale row's sibling "until overwritten" carrier (a later
    // hint would be allowed to take its place).
    expect(FEEDBACK_POLICY['protocol-mismatch']).toEqual({
      channel: 'hint',
      actionRequired: true,
      alsoCarriedBy: 'the world hint line until reload',
    });
    expect(channelOf('protocol-mismatch')).toBe('hint');
  });

  it('hintRank of protocol-mismatch is 4 and no other kind has it; it outranks every hint kind and no other kind outranks it [lpw-4.4]', () => {
    // WRONG IMPL KILLED: the mismatch left at rank 3 (a later download-blocked or content-stale
    // hint paints over it, and uncovering it says it a second time); rank 4 given to another
    // kind too; an outranks that ignores the rank.
    expect(hintRank('protocol-mismatch')).toBe(4);
    const others = TABLE_KINDS.filter((k) => k !== 'protocol-mismatch');
    expect(others).toHaveLength(TABLE_KINDS.length - 1);
    for (const kind of others) {
      expect(hintRank(kind), kind).not.toBe(4);
      expect(outranks(kind, 'protocol-mismatch'), `${kind} over protocol-mismatch`).toBe(false);
    }
    for (const kind of kindsOf('hint')) {
      expect(outranks('protocol-mismatch', kind), `protocol-mismatch over ${kind}`).toBe(true);
    }
    expect(outranks('download-blocked', 'protocol-mismatch')).toBe(false);
    expect(outranks('content-stale', 'protocol-mismatch')).toBe(false);
    expect(outranks('world-disconnect', 'protocol-mismatch')).toBe(false);
    expect(outranks('protocol-mismatch', 'download-blocked')).toBe(true);
    expect(outranks('protocol-mismatch', 'content-stale')).toBe(true);
    expect(outranks('protocol-mismatch', 'world-disconnect')).toBe(true);
  });
});
