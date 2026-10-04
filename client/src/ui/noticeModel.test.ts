// ui/noticeModel.test.ts — ctl-13 RED gating tests: the pure notice model (CTL13.2, CTL13.3).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-13;
//   memory/projects/monster-realm-ctl-13-plan.md (REV 2 supersedes the earlier sections).
//
// RED REASON: client/src/ui/noticeModel.ts does not exist yet (module-not-found).
//
// CONTRACT:
//   pendingRequests(input) -> readonly RequestNotice[]
//     the incoming requests waiting on the viewer: the OLDEST trade offer with
//     `counterparty === identity && status === 'Pending'` (never `shownTradeOffer`, whose
//     oldest-involving pick can hide an incoming offer behind an outgoing one) and the
//     `incomingChallenge`. Oldest first by createdAtMs, a tie goes to the smaller key string
//     ('challenge-...' < 'trade-...'), so the order is deterministic under input permutation.
//     NOT filtered by `dismissed`. `fromName` = the proposer's / challenger's player name,
//     `#<hex8>` when the name is empty or the player unknown.
//   buildNotices(input) -> readonly Notice[]
//     TOP FIRST: `{ kind: 'error', key: 'error' }` when `errorPending`, then the oldest pending
//     request whose key is not in `dismissed`. At most one of each.
//   requestSheetLayout: a list of accept, decline, view (all enabled).
//   openRequestSheet(n) -> { notice: n, nav } with the cursor on 'accept'.
//   requestSheetStep(sheet, btn, live) -> { state: RequestSheet | null, run?: 'accept'|'decline'|'view' }
//   requestCommand(n, 'accept' | 'decline') -> the exact screen Command.

import { describe, expect, it } from 'vitest';
import type { VButton } from '../input/buttons';
import type { StoreBattleChallenge, StorePlayer, StoreTradeOffer } from '../net/store';
import type { NavInput } from './nav';
import {
  buildNotices,
  type Notice,
  type NoticeInput,
  openRequestSheet,
  pendingRequests,
  type RequestNotice,
  requestCommand,
  requestSheetLayout,
  requestSheetStep,
} from './noticeModel';

const ME = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const CAROL = 'cc'.repeat(32);
const DAN = 'dd'.repeat(32);
const STRANGER = 'ee'.repeat(32);

function offer(
  tradeId: bigint,
  initiator: string,
  counterparty: string,
  status: StoreTradeOffer['status'] = 'Pending',
  createdAtMs = 1_000n,
): StoreTradeOffer {
  return {
    tradeId,
    initiator,
    counterparty,
    initiatorMonsterIds: [],
    initiatorItems: [],
    initiatorCurrency: 0n,
    counterpartyMonsterIds: [],
    counterpartyItems: [],
    counterpartyCurrency: 0n,
    initiatorCards: [],
    counterpartyCards: [],
    status,
    createdAtMs,
  };
}

function challenge(
  challengeId: bigint,
  challenger: string,
  target: string,
  status = 'Pending',
  createdAtMs = 2_000n,
): StoreBattleChallenge {
  return { challengeId, challenger, target, challengerPartyIds: [], status, createdAtMs };
}

function player(identity: string, name: string, entityId = 1n): StorePlayer {
  return { identity, entityId, name, online: true, lastInputSeq: 0n };
}

const PLAYERS: readonly StorePlayer[] = [
  player(ME, 'Me', 1n),
  player(BOB, 'Bob', 2n),
  player(CAROL, '', 3n), // an empty name reads `#<hex8>`
  // DAN and STRANGER have no player row at all.
];

function input(over: Partial<NoticeInput> = {}): NoticeInput {
  return {
    offers: [],
    challenges: [],
    players: PLAYERS,
    identity: ME,
    errorPending: false,
    dismissed: new Set<string>(),
    ...over,
  };
}

/** The request a Pending offer from `from` to the viewer makes. */
const tradeNotice = (id: bigint, fromName: string, createdAtMs: bigint): RequestNotice => ({
  kind: 'request',
  key: `trade-${id}`,
  request: 'trade',
  id,
  fromName,
  createdAtMs,
});

const challengeNotice = (id: bigint, fromName: string, createdAtMs: bigint): RequestNotice => ({
  kind: 'request',
  key: `challenge-${id}`,
  request: 'challenge',
  id,
  fromName,
  createdAtMs,
});

/** Every ordering of `items` (n! of them; the fixtures keep n <= 3). */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

const nav = (button: VButton, repeat = false): NavInput => ({ button, repeat });

describe('noticeModel: pendingRequests and buildNotices (ctl-13, CTL13.2)', () => {
  it('CTL13-2-NOTICES: only an incoming Pending trade and an incoming Pending challenge are requests; they list oldest first (a tie: challenge before trade), carry the sender`s name or `#<hex8>`, are NOT filtered by dismissals, and buildNotices puts the error first then the oldest undismissed request, identically under every input permutation', () => {
    // WRONG IMPL KILLED: a request list that counts an outgoing offer or challenge, an offer that
    // awaits the viewer's own final Confirm (ConfirmedByCounterparty), a non-Pending challenge or
    // an offer between two others; an incoming trade hidden behind an OLDER outgoing one (the
    // shownTradeOffer pick); newest-first or id-ordered notices; a tie broken by input order; a
    // name read from the wrong side (the viewer's own) or a blank name shown; a `dismissed` filter
    // inside pendingRequests (the Y sheet would stop reaching a dismissed banner's request); a
    // buildNotices with the error last, more than one request, or a dismissed request still on
    // top; and an order that changes when the input arrays are permuted.

    // --- nothing waiting -------------------------------------------------------------------
    expect(pendingRequests(input()), 'no rows: no request').toEqual([]);
    expect(buildNotices(input()), 'no rows, no error: no notice').toEqual([]);
    const NOT_REQUESTS = input({
      offers: [
        offer(1n, ME, BOB), // outgoing
        offer(2n, BOB, ME, 'ConfirmedByCounterparty'), // the viewer already answered it
        offer(3n, BOB, CAROL), // between two others
      ],
      challenges: [
        challenge(4n, ME, BOB), // outgoing
        challenge(5n, BOB, ME, 'Declined'), // not Pending
        challenge(6n, BOB, CAROL), // aimed at someone else
        challenge(7n, BOB, ME, 'Cancelled'),
      ],
    });
    expect(pendingRequests(NOT_REQUESTS), 'none of these waits on the viewer').toEqual([]);
    expect(buildNotices(NOT_REQUESTS)).toEqual([]);

    // --- one of each -----------------------------------------------------------------------
    const tradeRow = offer(11n, BOB, ME, 'Pending', 1_000n);
    const challengeRow = challenge(21n, CAROL, ME, 'Pending', 2_000n);
    const both = input({ offers: [tradeRow], challenges: [challengeRow] });
    expect(pendingRequests(both), 'oldest first; names from the sender`s player row').toEqual([
      tradeNotice(11n, 'Bob', 1_000n),
      challengeNotice(21n, `#${CAROL.slice(0, 8)}`, 2_000n),
    ]);
    expect(
      challengeNotice(21n, `#${CAROL.slice(0, 8)}`, 2_000n).fromName,
      'fixture: Carol`s empty name reads #cccccccc',
    ).toBe('#cccccccc');
    expect(buildNotices(both), 'at most one request: the oldest').toEqual([
      tradeNotice(11n, 'Bob', 1_000n),
    ]);

    // The challenge older than the trade comes first.
    const challengeFirst = input({
      offers: [offer(11n, BOB, ME, 'Pending', 3_000n)],
      challenges: [challenge(21n, BOB, ME, 'Pending', 2_000n)],
    });
    expect(pendingRequests(challengeFirst).map((n) => n.key)).toEqual(['challenge-21', 'trade-11']);
    expect(buildNotices(challengeFirst).map((n) => n.key)).toEqual(['challenge-21']);

    // A unknown sender (no player row) reads `#<hex8>` too.
    const unknown = input({ challenges: [challenge(22n, STRANGER, ME)] });
    expect(pendingRequests(unknown)[0]?.fromName).toBe(`#${STRANGER.slice(0, 8)}`);

    // --- a tie goes to the smaller key string ('challenge-...' < 'trade-...') ---------------
    const tie = input({
      offers: [offer(11n, BOB, ME, 'Pending', 5_000n)],
      challenges: [challenge(21n, BOB, ME, 'Pending', 5_000n)],
    });
    expect(
      pendingRequests(tie).map((n) => n.key),
      'a createdAtMs tie',
    ).toEqual(['challenge-21', 'trade-11']);
    expect(buildNotices(tie).map((n) => n.key)).toEqual(['challenge-21']);

    // --- an incoming offer behind an OLDER outgoing one is still a request ------------------
    const hidden = input({
      offers: [offer(5n, ME, CAROL, 'Pending', 500n), offer(11n, BOB, ME, 'Pending', 1_000n)],
    });
    expect(
      pendingRequests(hidden).map((n) => n.key),
      'the outgoing offer (lower id, older) does not hide the incoming one',
    ).toEqual(['trade-11']);

    // --- dismissals: buildNotices skips them, pendingRequests does not ----------------------
    const dismissedTrade = input({
      offers: [tradeRow],
      challenges: [challengeRow],
      dismissed: new Set(['trade-11']),
    });
    expect(
      buildNotices(dismissedTrade).map((n) => n.key),
      'the dismissed trade gives way to the next request',
    ).toEqual(['challenge-21']);
    expect(
      pendingRequests(dismissedTrade).map((n) => n.key),
      'pendingRequests is NOT dismiss-filtered (Y still reaches the dismissed one)',
    ).toEqual(['trade-11', 'challenge-21']);
    const allDismissed = input({
      offers: [tradeRow],
      challenges: [challengeRow],
      dismissed: new Set(['trade-11', 'challenge-21']),
    });
    expect(buildNotices(allDismissed), 'everything dismissed: no banner').toEqual([]);
    expect(pendingRequests(allDismissed)).toHaveLength(2);
    // A dismissed key that no longer exists dismisses nothing else.
    expect(
      buildNotices(input({ offers: [tradeRow], dismissed: new Set(['trade-99']) })).map(
        (n) => n.key,
      ),
    ).toEqual(['trade-11']);

    // --- the error is first, then at most one request --------------------------------------
    const withError: Notice[] = [...buildNotices(input({ ...both, errorPending: true }))];
    expect(withError, 'error first, then the oldest request: at most two notices').toEqual([
      { kind: 'error', key: 'error' },
      tradeNotice(11n, 'Bob', 1_000n),
    ]);
    expect(buildNotices(input({ errorPending: true })), 'an error alone').toEqual([
      { kind: 'error', key: 'error' },
    ]);
    expect(
      buildNotices(input({ ...dismissedTrade, errorPending: true })).map((n) => n.key),
      'the error does not displace the next request',
    ).toEqual(['error', 'challenge-21']);

    // --- deterministic under permutation of every input array -------------------------------
    const crowd = {
      offers: [
        offer(5n, ME, CAROL, 'Pending', 500n),
        offer(11n, BOB, ME, 'Pending', 3_000n),
        offer(12n, DAN, ME, 'Pending', 3_500n),
      ],
      challenges: [
        challenge(21n, BOB, ME, 'Pending', 3_000n),
        challenge(22n, DAN, ME, 'Pending', 3_200n),
        challenge(23n, ME, CAROL, 'Pending', 100n),
      ],
      players: [player(ME, 'Me', 1n), player(BOB, 'Bob', 2n), player(DAN, 'Dan', 4n)],
    };
    const reference = pendingRequests(input({ ...crowd }));
    expect(
      reference.map((n) => n.key),
      'ANTI-VACUITY: the crowd yields one trade and one challenge, oldest first, tie to challenge',
    ).toEqual(['challenge-21', 'trade-11']);
    let permuted = 0;
    for (const offers of permutations(crowd.offers)) {
      for (const challenges of permutations(crowd.challenges)) {
        for (const players of permutations(crowd.players)) {
          const i = input({ offers, challenges, players, errorPending: true });
          expect(pendingRequests(i), 'pendingRequests, permuted').toEqual(reference);
          expect(
            buildNotices(i).map((n) => n.key),
            'buildNotices, permuted',
          ).toEqual(['error', 'challenge-21']);
          permuted += 1;
        }
      }
    }
    expect(permuted, 'ANTI-VACUITY: 3! x 3! x 3! orderings').toBe(216);
  });
});

describe('noticeModel: the request action sheet (ctl-13, CTL13.3)', () => {
  const REQ = tradeNotice(11n, 'Bob', 1_000n);
  const OTHER = tradeNotice(12n, 'Dan', 1_100n);
  const CHAL = challengeNotice(21n, 'Bob', 2_000n);

  it('CTL13-3-SHEET: the sheet is Accept / Decline / View with the cursor on Accept; the D-pad moves it; A runs the row under the cursor only while that request is still live, otherwise it closes with nothing run; B and Start close; a held B, Start or A does nothing; and requestCommand is the exact Command', () => {
    // WRONG IMPL KILLED: a layout in another order or with a disabled row; a cursor that does not
    // start on Accept (Y then Enter would decline or only look); a closed sheet that runs; an A
    // that acts on a request that was withdrawn (nothing live) or REPLACED by a different one
    // with another id (a stale id sent: the spec's "never act on a stale request"); a sheet that
    // closes on a repeat B / Start or runs on a held A; a D-pad that does not move or does not
    // clamp on a held edge; any other button that moves or closes it; and a command with the
    // wrong reducer, the wrong id or the opposite `accepted`.
    expect(requestSheetLayout.kind).toBe('list');
    const rows = requestSheetLayout.kind === 'list' ? requestSheetLayout.items : [];
    expect(
      rows.map((r) => [r.key, r.enabled]),
      'Accept, Decline, View, all enabled',
    ).toEqual([
      ['accept', true],
      ['decline', true],
      ['view', true],
    ]);

    const sheet = openRequestSheet(REQ);
    expect(sheet.notice, 'the sheet is about this request').toEqual(REQ);
    expect(sheet.nav.item, 'opens on Accept').toBe('accept');
    expect(sheet.nav.tab).toBeNull();

    // --- the D-pad moves the cursor (nav.ts list rule: fresh wraps, a held edge clamps) -------
    const down1 = requestSheetStep(sheet, nav('Down'), [REQ]);
    expect(down1.run, 'moving runs nothing').toBeUndefined();
    expect(down1.state?.nav.item).toBe('decline');
    expect(down1.state?.notice, 'the sheet keeps its request').toEqual(REQ);
    const down2 = requestSheetStep(down1.state as NonNullable<typeof down1.state>, nav('Down'), [
      REQ,
    ]);
    expect(down2.state?.nav.item).toBe('view');
    const wrapped = requestSheetStep(down2.state as NonNullable<typeof down2.state>, nav('Down'), [
      REQ,
    ]);
    expect(wrapped.state?.nav.item, 'a fresh Down wraps').toBe('accept');
    const clamped = requestSheetStep(
      down2.state as NonNullable<typeof down2.state>,
      nav('Down', true),
      [REQ],
    );
    expect(clamped.state?.nav.item, 'a held Down clamps at the end').toBe('view');
    const up = requestSheetStep(sheet, nav('Up'), [REQ]);
    expect(up.state?.nav.item, 'Up from Accept wraps to View').toBe('view');

    // --- A runs the row under the cursor ---------------------------------------------------
    const accept = requestSheetStep(sheet, nav('A'), [REQ]);
    expect(accept, 'A on Accept: closes and runs accept').toEqual({ state: null, run: 'accept' });
    const decline = requestSheetStep(down1.state as NonNullable<typeof down1.state>, nav('A'), [
      REQ,
    ]);
    expect(decline, 'A on Decline').toEqual({ state: null, run: 'decline' });
    const view = requestSheetStep(down2.state as NonNullable<typeof down2.state>, nav('A'), [REQ]);
    expect(view, 'A on View').toEqual({ state: null, run: 'view' });
    expect(
      requestSheetStep(sheet, nav('A'), [OTHER, REQ]).run,
      'the request among several live ones still runs',
    ).toBe('accept');

    // --- a request that is no longer live: close, run nothing -------------------------------
    for (const [label, live] of [
      ['withdrawn: nothing is live', []],
      ['replaced by a different request with another id', [OTHER]],
      ['replaced by a challenge', [CHAL]],
    ] as const) {
      const stale = requestSheetStep(sheet, nav('A'), live);
      expect(stale.run, `${label}: nothing runs`).toBeUndefined();
      expect(stale.state, `${label}: the sheet closes`).toBeNull();
      const staleDecline = requestSheetStep(
        down1.state as NonNullable<typeof down1.state>,
        nav('A'),
        live,
      );
      expect(staleDecline.run, `${label}: Decline runs nothing either`).toBeUndefined();
      expect(staleDecline.state).toBeNull();
      const staleView = requestSheetStep(
        down2.state as NonNullable<typeof down2.state>,
        nav('A'),
        live,
      );
      expect(staleView.run, `${label}: View runs nothing either`).toBeUndefined();
      expect(staleView.state).toBeNull();
    }

    // --- B and Start close; a held B / Start / A do nothing ----------------------------------
    for (const button of ['B', 'Start'] as const) {
      const closed = requestSheetStep(sheet, nav(button), [REQ]);
      expect(closed, `${button} closes and runs nothing`).toEqual({ state: null });
      const held = requestSheetStep(sheet, nav(button, true), [REQ]);
      expect(held.state, `a held ${button} leaves the sheet as it was`).toEqual(sheet);
      expect(held.run).toBeUndefined();
    }
    const heldA = requestSheetStep(sheet, nav('A', true), [REQ]);
    expect(heldA.run, 'a held A does not run').toBeUndefined();
    expect(heldA.state, 'and does not close').toEqual(sheet);

    // --- every other button leaves the sheet as it was ---------------------------------------
    for (const button of ['X', 'Y', 'LB', 'RB', 'Select', 'Left', 'Right'] as const) {
      const r = requestSheetStep(sheet, nav(button), [REQ]);
      expect(r.state, `${button} changes nothing`).toEqual(sheet);
      expect(r.run, `${button} runs nothing`).toBeUndefined();
    }

    // --- requestCommand: the exact Commands -------------------------------------------------
    expect(requestCommand(REQ, 'accept')).toEqual({
      kind: 'respondTrade',
      tradeId: 11n,
      accepted: true,
    });
    expect(requestCommand(REQ, 'decline')).toEqual({
      kind: 'respondTrade',
      tradeId: 11n,
      accepted: false,
    });
    expect(requestCommand(CHAL, 'accept')).toEqual({ kind: 'acceptChallenge', challengeId: 21n });
    expect(requestCommand(CHAL, 'decline')).toEqual({ kind: 'declineChallenge', challengeId: 21n });
    expect(requestCommand(OTHER, 'accept'), 'the id is the request`s own').toEqual({
      kind: 'respondTrade',
      tradeId: 12n,
      accepted: true,
    });
  });
});
