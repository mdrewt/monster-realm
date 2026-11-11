// ui/noticeModel.test.ts — ctl-13 RED gating tests: the pure notice model (CTL13.2, CTL13.3).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-13;
//   memory/projects/monster-realm-ctl-13-plan.md (REV 2 supersedes the earlier sections).
//
// RED REASON: client/src/ui/noticeModel.ts does not exist yet (module-not-found).
//
// CONTRACT:
//   pendingRequests(input) -> readonly RequestNotice[]
//     the incoming requests waiting on the viewer and the `incomingChallenge`. Oldest first by
//     createdAtMs, a tie goes to the smaller key string ('challenge-...' < 'session-...'), so the
//     order is deterministic under input permutation. NOT filtered by `dismissed`. `fromName` = the
//     opener's / challenger's player name, `#<hex8>` when the name is empty or the player unknown.
//   buildNotices(input) -> readonly Notice[]
//     TOP FIRST: `{ kind: 'error', key: 'error' }` when `errorPending`, then the oldest pending
//     request whose key is not in `dismissed`. At most one of each.
//   requestSheetLayout: a list of accept, decline, view (all enabled).
//   openRequestSheet(n) -> { notice: n, nav } with the cursor on 'accept'.
//   requestSheetStep(sheet, btn, live) -> { state: RequestSheet | null, run?: 'accept'|'decline'|'view' }
//   requestCommand(n, 'accept' | 'decline') -> the exact screen Command.
//
// ---------------------------------------------------------------------------------------------
// ts-3 NAMED INTENTIONAL CHANGE (M-trade-sessions ts-3.4, ts-3.5; plan §Notices):
//   `NoticeInput.offers` is replaced by `sessions` + `opened`: a trade request is an incoming,
//   untouched trade SESSION this client has not opened its editor on (key `session-<id>`, from the
//   opener), and legacy `trade_offer` rows raise nothing. The trade halves of CTL13-2-NOTICES and
//   CTL13-3-SHEET are re-expressed over sessions with the SAME assertions (oldest first, the tie
//   rule, names, dismissals, the error first, permutation-determinism); only the row source and the
//   `trade-` → `session-` key prefix change. `requestCommand` for a trade now answers
//   `openTradeEditor` (accept) / `cancelTradeSession` (decline) — was `respondTrade`. Challenge
//   cases are unchanged. One deliberate difference: pendingRequests now lists EVERY waiting trade
//   request (the collapse to one banner line is buildNotices' job), so the permutation reference
//   holds both incoming sessions where it held the one oldest offer.
// ---------------------------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import type { VButton } from '../input/buttons';
import type {
  StoreBattleChallenge,
  StorePlayer,
  StoreTradeOffer,
  StoreTradeSession,
  StoreTradeSessionOffer,
} from '../net/store';
import { CLOSE_KEY } from './actionSheetModel';
import type { NavInput } from './nav';
import {
  buildNotices,
  dismissKeys,
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

const NO_SIDE: StoreTradeSessionOffer = { monsterIds: [], items: [], currency: 0n, cards: [] };

function tradeSession(
  sessionId: bigint,
  opener: string,
  partner: string,
  createdAtMs = 1_000n,
  over: Partial<StoreTradeSession> = {},
): StoreTradeSession {
  return {
    sessionId,
    opener,
    partner,
    openerOffer: NO_SIDE,
    partnerOffer: NO_SIDE,
    openerConfirmed: false,
    partnerConfirmed: false,
    revision: 1n,
    createdAtMs,
    ...over,
  };
}

function offer(tradeId: bigint, initiator: string, counterparty: string): StoreTradeOffer {
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
    status: 'Pending',
    createdAtMs: 1n,
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
    sessions: [],
    opened: new Set<bigint>(),
    challenges: [],
    players: PLAYERS,
    identity: ME,
    errorPending: false,
    dismissed: new Set<string>(),
    ...over,
  };
}

/** The request an untouched incoming session from `from` makes. */
const tradeNotice = (id: bigint, fromName: string, createdAtMs: bigint): RequestNotice => ({
  kind: 'request',
  key: `session-${id}`,
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
  it('CTL13-2-NOTICES: only an incoming untouched trade session and an incoming Pending challenge are requests; they list oldest first (a tie: challenge before trade), carry the sender`s name or `#<hex8>`, are NOT filtered by dismissals, and buildNotices puts the error first then the oldest undismissed request, identically under every input permutation', () => {
    // WRONG IMPL KILLED: a request list that counts an outgoing session or challenge, a session the
    // viewer already answered (edited or confirmed), a non-Pending challenge or a session between
    // two others; an incoming session hidden behind an OLDER outgoing one; newest-first or
    // id-ordered notices; a tie broken by input order; a name read from the wrong side (the
    // viewer's own) or a blank name shown; a `dismissed` filter inside pendingRequests (the Y sheet
    // would stop reaching a dismissed banner's request); a buildNotices with the error last, more
    // than one request, or a dismissed request still on top; and an order that changes when the
    // input arrays are permuted.

    // --- nothing waiting -------------------------------------------------------------------
    expect(pendingRequests(input()), 'no rows: no request').toEqual([]);
    expect(buildNotices(input()), 'no rows, no error: no notice').toEqual([]);
    const NOT_REQUESTS = input({
      sessions: [
        tradeSession(1n, ME, BOB), // outgoing
        tradeSession(2n, BOB, ME, 1_000n, { partnerConfirmed: true }), // the viewer answered it
        tradeSession(8n, BOB, ME, 1_000n, { partnerOffer: { ...NO_SIDE, currency: 1n } }), // edited
        tradeSession(3n, BOB, CAROL), // between two others
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
    const tradeRow = tradeSession(11n, BOB, ME, 1_000n);
    const challengeRow = challenge(21n, CAROL, ME, 'Pending', 2_000n);
    const both = input({ sessions: [tradeRow], challenges: [challengeRow] });
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
      sessions: [tradeSession(11n, BOB, ME, 3_000n)],
      challenges: [challenge(21n, BOB, ME, 'Pending', 2_000n)],
    });
    expect(pendingRequests(challengeFirst).map((n) => n.key)).toEqual([
      'challenge-21',
      'session-11',
    ]);
    expect(buildNotices(challengeFirst).map((n) => n.key)).toEqual(['challenge-21']);

    // A unknown sender (no player row) reads `#<hex8>` too.
    const unknown = input({ challenges: [challenge(22n, STRANGER, ME)] });
    expect(pendingRequests(unknown)[0]?.fromName).toBe(`#${STRANGER.slice(0, 8)}`);
    const unknownOpener = input({ sessions: [tradeSession(13n, STRANGER, ME)] });
    expect(pendingRequests(unknownOpener)[0]?.fromName).toBe(`#${STRANGER.slice(0, 8)}`);

    // --- a tie goes to the smaller key string ('challenge-...' < 'session-...') -------------
    const tie = input({
      sessions: [tradeSession(11n, BOB, ME, 5_000n)],
      challenges: [challenge(21n, BOB, ME, 'Pending', 5_000n)],
    });
    expect(
      pendingRequests(tie).map((n) => n.key),
      'a createdAtMs tie',
    ).toEqual(['challenge-21', 'session-11']);
    expect(buildNotices(tie).map((n) => n.key)).toEqual(['challenge-21']);

    // --- an incoming session behind an OLDER outgoing one is still a request ----------------
    const hidden = input({
      sessions: [tradeSession(5n, ME, CAROL, 500n), tradeSession(11n, BOB, ME, 1_000n)],
    });
    expect(
      pendingRequests(hidden).map((n) => n.key),
      'the outgoing session (lower id, older) does not hide the incoming one',
    ).toEqual(['session-11']);

    // --- dismissals: buildNotices skips them, pendingRequests does not ----------------------
    const dismissedTrade = input({
      sessions: [tradeRow],
      challenges: [challengeRow],
      dismissed: new Set(['session-11']),
    });
    expect(
      buildNotices(dismissedTrade).map((n) => n.key),
      'the dismissed trade gives way to the next request',
    ).toEqual(['challenge-21']);
    expect(
      pendingRequests(dismissedTrade).map((n) => n.key),
      'pendingRequests is NOT dismiss-filtered (Y still reaches the dismissed one)',
    ).toEqual(['session-11', 'challenge-21']);
    const allDismissed = input({
      sessions: [tradeRow],
      challenges: [challengeRow],
      dismissed: new Set(['session-11', 'challenge-21']),
    });
    expect(buildNotices(allDismissed), 'everything dismissed: no banner').toEqual([]);
    expect(pendingRequests(allDismissed)).toHaveLength(2);
    // A dismissed key that no longer exists dismisses nothing else.
    expect(
      buildNotices(input({ sessions: [tradeRow], dismissed: new Set(['session-99']) })).map(
        (n) => n.key,
      ),
    ).toEqual(['session-11']);

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
      sessions: [
        tradeSession(5n, ME, CAROL, 500n),
        tradeSession(11n, BOB, ME, 3_000n),
        tradeSession(12n, DAN, ME, 3_500n),
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
      'ANTI-VACUITY: both incoming sessions and the one challenge, oldest first, tie to challenge',
    ).toEqual(['challenge-21', 'session-11', 'session-12']);
    let permuted = 0;
    for (const sessions of permutations(crowd.sessions)) {
      for (const challenges of permutations(crowd.challenges)) {
        for (const players of permutations(crowd.players)) {
          const i = input({ sessions, challenges, players, errorPending: true });
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
    // wrong reducer, the wrong id or the opposite answer.
    // NAMED INTENTIONAL CHANGE — uif-12 (UIF12.2): the sheet ends with a Close row, so the last
    // row (the wrap target of Up from Accept, the clamp of a held Down) is `close`, not `view`.
    expect(requestSheetLayout.kind).toBe('list');
    const rows = requestSheetLayout.kind === 'list' ? requestSheetLayout.items : [];
    expect(
      rows.map((r) => [r.key, r.enabled]),
      'Accept, Decline, View, Close, all enabled',
    ).toEqual([
      ['accept', true],
      ['decline', true],
      ['view', true],
      ['close', true],
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
    const down3 = requestSheetStep(down2.state as NonNullable<typeof down2.state>, nav('Down'), [
      REQ,
    ]);
    expect(down3.state?.nav.item, 'Down from View: Close, the last row').toBe('close');
    const wrapped = requestSheetStep(down3.state as NonNullable<typeof down3.state>, nav('Down'), [
      REQ,
    ]);
    expect(wrapped.state?.nav.item, 'a fresh Down wraps').toBe('accept');
    const clamped = requestSheetStep(
      down3.state as NonNullable<typeof down3.state>,
      nav('Down', true),
      [REQ],
    );
    expect(clamped.state?.nav.item, 'a held Down clamps at the end, Close').toBe('close');
    const up = requestSheetStep(sheet, nav('Up'), [REQ]);
    expect(up.state?.nav.item, 'Up from Accept wraps to Close').toBe('close');

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

    // --- requestCommand: the exact Commands (ts-3: a trade request is a session) -------------
    expect(requestCommand(REQ, 'accept'), 'ts-3: accept opens the editor').toEqual({
      kind: 'openTradeEditor',
      sessionId: 11n,
    });
    expect(requestCommand(REQ, 'decline'), 'ts-3: decline cancels the session').toEqual({
      kind: 'cancelTradeSession',
      sessionId: 11n,
    });
    expect(requestCommand(CHAL, 'accept')).toEqual({ kind: 'acceptChallenge', challengeId: 21n });
    expect(requestCommand(CHAL, 'decline')).toEqual({ kind: 'declineChallenge', challengeId: 21n });
    expect(requestCommand(OTHER, 'accept'), 'the id is the request`s own').toEqual({
      kind: 'openTradeEditor',
      sessionId: 12n,
    });
  });

  it('UIF12.2 the request sheet ends with an enabled Close row (CLOSE_KEY); a fresh A on it returns exactly what B returns — { state: null }, no run — whether or not the request is still live; a held A on Close returns the same state object', () => {
    // WRONG IMPL KILLED: no Close row; a Close row that is not last or not keyed `close`; the
    // naive Close that falls through to the activate path (A on Close with the request live would
    // return `run: 'close'`, which the shell would try to answer, or would run the row before it,
    // View); a Close that checks `live` (B does not: the result must not depend on it); a Close
    // that leaves the sheet open; a held A that closes or moves.
    expect(CLOSE_KEY, 'the shared Close key').toBe('close');
    const keys =
      requestSheetLayout.kind === 'list' ? requestSheetLayout.items.map((r) => r.key) : [];
    expect(keys, 'Accept, Decline, View, then Close').toEqual([
      'accept',
      'decline',
      'view',
      CLOSE_KEY,
    ]);
    const sheet = openRequestSheet(REQ);
    expect(sheet.nav.item, 'the cursor still opens on Accept').toBe('accept');

    let s: NonNullable<ReturnType<typeof requestSheetStep>['state']> = sheet;
    for (let i = 0; i < 3; i++) {
      const r = requestSheetStep(s, nav('Down'), [REQ]);
      expect(r.run, `Down ${i + 1} runs nothing`).toBeUndefined();
      if (r.state === null) throw new Error(`Down ${i + 1} closed the sheet`);
      s = r.state;
    }
    expect(s.nav.item, 'fixture: three Downs reach Close').toBe(CLOSE_KEY);

    for (const [label, live] of [
      ['the request is live', [REQ]],
      ['the request is live among others', [OTHER, REQ]],
      ['nothing is live', []],
      ['replaced by a challenge', [CHAL]],
    ] as const) {
      const a = requestSheetStep(s, nav('A'), live);
      const b = requestSheetStep(s, nav('B'), live);
      expect(b, `${label}: B closes (the reference)`).toStrictEqual({ state: null });
      expect(a, `${label}: A on Close is B`).toStrictEqual(b);
      expect(a.run, `${label}: nothing runs`).toBeUndefined();
    }
    const held = requestSheetStep(s, nav('A', true), [REQ]);
    expect(held.run, 'a held A on Close runs nothing').toBeUndefined();
    expect(held.state, 'and leaves the sheet as it was').toBe(s);

    // Close reached by Up from Accept closes the same way.
    const up = requestSheetStep(sheet, nav('Up'), [REQ]);
    expect(up.state?.nav.item, 'fixture: Up wraps to Close').toBe(CLOSE_KEY);
    expect(
      requestSheetStep(up.state as NonNullable<typeof up.state>, nav('A'), [REQ]),
      'A on Close reached by Up',
    ).toStrictEqual({ state: null });
  });
});

// ==========================================================================================
// ts-3 (ts-3.4, ts-3.5): incoming trade sessions on the banner.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-trade-sessions.spec.md §ts-3 ("an incoming session this
//   client has not opened SHALL raise the non-modal banner (several collapsing into one line) and
//   never a frame") and memory/projects/monster-realm-ts-3-plan.md §Notices.
//
// RED REASON: NoticeInput has no `sessions` / `opened`, no session raises a request, buildNotices
//   never collapses, `dismissKeys` does not exist and requestCommand answers `respondTrade`.
// ==========================================================================================

describe('noticeModel: incoming trade sessions (ts-3)', () => {
  it('ts-3.5 an incoming untouched session NOT in `opened` is a pending request from its opener; once this client opened its editor it is not; the opener never gets one; legacy offers raise nothing', () => {
    // WRONG IMPL KILLED: the banner raised again for a session the player already opened (the
    // editor IS the answer: the banner would nag over it); the opener's own session raising a
    // request; a request named from the partner; the legacy `trade_offer` path still feeding the
    // banner (an implementation that keeps reading `offers`).
    const s = tradeSession(31n, BOB, ME, 1_000n);
    expect(pendingRequests(input({ sessions: [s] }))).toEqual([tradeNotice(31n, 'Bob', 1_000n)]);
    expect(
      pendingRequests(input({ sessions: [s], opened: new Set([31n]) })),
      'opened on this client: no request',
    ).toEqual([]);
    expect(
      pendingRequests(input({ sessions: [s], opened: new Set([32n]) })),
      'another id opened: still a request',
    ).toHaveLength(1);
    expect(pendingRequests(input({ sessions: [s], identity: BOB })), 'the opener').toEqual([]);
    const legacy = Object.assign(input(), { offers: [offer(11n, BOB, ME)] });
    expect(pendingRequests(legacy), 'a legacy offer raises nothing').toEqual([]);
    expect(buildNotices(legacy)).toEqual([]);
  });

  it('ts-3.5 two or more undismissed trade requests collapse into ONE notice carrying count and keys; one alone carries neither; a dismissed one is not counted; an older challenge comes first uncounted; dismissKeys answers the keys or the notice`s own key', () => {
    // WRONG IMPL KILLED: one banner per session (several notices stacked: the spec's collapse);
    // a count that includes dismissed sessions, or the challenge; keys missing (B would dismiss
    // only the top session and the banner would come straight back for the next); count set on a
    // single request (the line would read "1 trade requests"); a collapse that outranks an older
    // challenge; dismissKeys ignoring the collapsed keys.
    const a = tradeSession(41n, BOB, ME, 1_000n);
    const b = tradeSession(42n, CAROL, ME, 3_000n);
    const c = tradeSession(43n, DAN, ME, 4_000n);
    const one = buildNotices(input({ sessions: [a] }));
    expect(one).toEqual([tradeNotice(41n, 'Bob', 1_000n)]);
    expect('count' in (one[0] as Notice), 'one alone: no count').toBe(false);
    expect('keys' in (one[0] as Notice), 'one alone: no keys').toBe(false);
    expect(dismissKeys(one[0] as Notice)).toEqual(['session-41']);

    const many = buildNotices(
      input({ sessions: [c, a, b], challenges: [challenge(21n, BOB, ME, 'Pending', 2_000n)] }),
    );
    expect(many, 'one notice').toHaveLength(1);
    const top = many[0] as RequestNotice;
    expect(top).toMatchObject({ kind: 'request', key: 'session-41', request: 'trade', id: 41n });
    expect(top.count, 'all three undismissed trade requests').toBe(3);
    expect([...(top.keys ?? [])].sort()).toEqual(['session-41', 'session-42', 'session-43']);
    expect([...dismissKeys(top)].sort()).toEqual(['session-41', 'session-42', 'session-43']);

    const minusOne = buildNotices(
      input({ sessions: [c, a, b], dismissed: new Set(['session-41']) }),
    )[0] as RequestNotice;
    expect(minusOne.key, 'the oldest undismissed').toBe('session-42');
    expect(minusOne.count).toBe(2);
    expect([...(minusOne.keys ?? [])].sort()).toEqual(['session-42', 'session-43']);

    const chalFirst = buildNotices(
      input({ sessions: [a, b], challenges: [challenge(21n, BOB, ME, 'Pending', 500n)] }),
    );
    expect(
      chalFirst.map((n) => n.key),
      'the older challenge is the banner',
    ).toEqual(['challenge-21']);
    expect('count' in (chalFirst[0] as Notice)).toBe(false);
    expect(dismissKeys(chalFirst[0] as Notice)).toEqual(['challenge-21']);

    const withError = buildNotices(input({ sessions: [a, b], errorPending: true }));
    expect(withError.map((n) => n.key)).toEqual(['error', 'session-41']);
    expect(dismissKeys(withError[0] as Notice)).toEqual(['error']);
  });

  it('ts-3.4 requestCommand answers a trade request with openTradeEditor (accept) and cancelTradeSession (decline) for THAT session, and challenges as before', () => {
    // WRONG IMPL KILLED: the legacy respondTrade still sent (no such trade row exists: the server
    // would refuse it); the accept and decline swapped; the id of another session.
    const n = tradeNotice(9_007_199_254_740_993n, 'Bob', 1n);
    expect(requestCommand(n, 'accept')).toEqual({
      kind: 'openTradeEditor',
      sessionId: 9_007_199_254_740_993n,
    });
    expect(requestCommand(n, 'decline')).toEqual({
      kind: 'cancelTradeSession',
      sessionId: 9_007_199_254_740_993n,
    });
    const chal = challengeNotice(21n, 'Bob', 1n);
    expect(requestCommand(chal, 'accept')).toEqual({ kind: 'acceptChallenge', challengeId: 21n });
    expect(requestCommand(chal, 'decline')).toEqual({ kind: 'declineChallenge', challengeId: 21n });
  });
});
