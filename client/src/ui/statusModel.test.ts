// ui/statusModel.test.ts — M13.5b ADR-0085 status message pure view model.
//
// API CONTRACT (pinned):
//   reduceErrorMessage(err: unknown, where: string): string
//     - TOTAL: never returns an empty string.
//     - err.name === 'SenderError' with non-empty message  → `${where}: ${message}`
//     - err.name === 'SenderError' with empty/missing msg  → `${where}: rejected`
//     - err.name === 'InternalError'                       → `${where}: server error`
//       (err.message MUST NOT appear in the output — no detail leak)
//     - anything else (plain Error, string, null, undefined, object)
//                                                          → `${where}: unexpected error`
//       (no String(err) leak, no "[object Object]")
//
//   subscriptionErrorMessage(ctx: unknown): string
//     - TOTAL. If ctx is an object whose `event` property has a non-empty string
//       `message` → return that message; else return 'subscription error'.
//       Examples:
//         { event: new Error('boom') }    → 'boom'
//         {}                              → 'subscription error'
//         undefined                       → 'subscription error'
//         { event: {} }                   → 'subscription error'
//         { event: { message: '' } }      → 'subscription error'
//
//   qf-6 (QF6.1 / QF6.2 / QF6.4; memory/projects/monster-realm-qf-6-plan.md "Design"):
//   conversationEndReason(err: unknown): 'walkedAway' | 'leftZone' | 'npcGone' | undefined
//     - a SenderError (name EQUALITY) whose message EXACTLY equals one of the four npc.rs
//       advance_dialogue refusals; anything else (another class, a near miss, the formatted
//       `advance: …` line, a non-object, a hostile getter) → undefined. TOTAL.
//   questAckSnapshot({ ready, identity, quests, wallet, conversationOpen }) → snapshot | undefined
//     - undefined unless ready and (no wallet, read as balance 0n, or a bigint balance).
//   questCompletionAck(prev, now) → { name, reward } | undefined
//     - a completion is "a row of prev missing from now while my conversation row is present";
//       name = the missing rows' questIds, sorted, ', '-joined; reward = the balance gain, or null.
//   STATUS_NOTICE_INITIAL / statusNoticeStep(state, event, windowMs) → { state, speak }
//     - a status notice is spoken only a full window after it was queued AND after the last
//       announced transition; a transition that clobbers a just-spoken notice re-queues it.
//
// Pure: no SDK imports, no DOM, no timers. Node-only.
// Block-body arrows for fast-check (never expression-body).

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  conversationEndReason,
  type QuestAckSnapshot,
  questAckSnapshot,
  questCompletionAck,
  reduceErrorMessage,
  STATUS_NOTICE_INITIAL,
  type StatusNoticeEvent,
  type StatusNoticeState,
  statusNoticeStep,
  subscriptionErrorMessage,
} from './statusModel';

// ================================================================================
// 1. reduceErrorMessage — SenderError pass-through
// ================================================================================

describe('reduceErrorMessage: SenderError with message passes through', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('SenderError with non-empty message → "${where}: ${message}"', () => {
    // Kills: an impl that emits a generic message for SenderError,
    // suppressing the user-visible server reason.
    const err = { name: 'SenderError', message: 'not enough currency' };
    const result = reduceErrorMessage(err, 'buy');
    expect(result).toBe('buy: not enough currency');
  });

  it('SenderError duck-typed (not instanceof) — plain object with name+message works', () => {
    // Kills: an impl using `instanceof` (cross-realm/bundling unsafe — ADR-0085 C9).
    // A plain object {name:'SenderError', message:'...'} must match.
    const err = Object.create(null) as Record<string, unknown>;
    err.name = 'SenderError';
    err.message = 'already joined';
    expect(reduceErrorMessage(err, 'join')).toBe('join: already joined');
  });

  it('SenderError with different where values — where prefix is correct', () => {
    // Kills: an impl that hardcodes the where prefix.
    const err = { name: 'SenderError', message: 'location not found' };
    expect(reduceErrorMessage(err, 'heal')).toBe('heal: location not found');
    expect(reduceErrorMessage(err, 'train')).toBe('train: location not found');
  });
});

// ================================================================================
// 2. reduceErrorMessage — SenderError with empty/missing message → fallback
// ================================================================================

describe('reduceErrorMessage: SenderError with empty/missing message → fallback', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('SenderError with empty string message → "${where}: rejected"', () => {
    // Kills: an impl that emits "${where}: " (empty suffix) — the no-empty contract.
    const err = { name: 'SenderError', message: '' };
    expect(reduceErrorMessage(err, 'sell')).toBe('sell: rejected');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('SenderError with missing message property → "${where}: rejected"', () => {
    // Kills: an impl that crashes on missing message or returns "${where}: undefined".
    const err = { name: 'SenderError' };
    expect(reduceErrorMessage(err, 'dismiss')).toBe('dismiss: rejected');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('SenderError with undefined message → "${where}: rejected"', () => {
    // Kills: an impl that coerces undefined to "undefined" and returns "${where}: undefined".
    const err = { name: 'SenderError', message: undefined };
    expect(reduceErrorMessage(err as unknown, 'care')).toBe('care: rejected');
  });
});

// ================================================================================
// 3. reduceErrorMessage — InternalError: generic message, NO detail leak
// ================================================================================

describe('reduceErrorMessage: InternalError → generic (no detail leak)', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('InternalError → "${where}: server error" regardless of message content', () => {
    // Kills: an impl that includes err.message (leaking internal detail to the UI).
    const err = { name: 'InternalError', message: 'internal server exception at line 42' };
    const result = reduceErrorMessage(err, 'evolve');
    expect(result).toBe('evolve: server error');
  });

  it('InternalError message MUST NOT appear in the output', () => {
    // Kills: any impl that leaks the internal message, even partially.
    // Uses a distinctive marker to prove no leakage.
    const secretDetail = 'INTERNAL_SECRET_xyz_9876';
    const err = { name: 'InternalError', message: secretDetail };
    const result = reduceErrorMessage(err, 'fuse');
    expect(result).not.toContain(secretDetail);
    expect(result).toBe('fuse: server error');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('InternalError with empty message → still "${where}: server error"', () => {
    // Kills: an impl that checks for non-empty message before applying generic.
    const err = { name: 'InternalError', message: '' };
    expect(reduceErrorMessage(err, 'recruit')).toBe('recruit: server error');
  });
});

// ================================================================================
// 4. reduceErrorMessage — unknown / anything else → generic, no leakage
// ================================================================================

describe('reduceErrorMessage: unknown errors → generic, no leakage', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('plain Error (name="Error") → "${where}: unexpected error"', () => {
    // Kills: an impl that falls through to String(err) and returns
    // "${where}: Error: something" (leaks the error message class).
    const err = new Error('something bad');
    expect(reduceErrorMessage(err, 'advance')).toBe('advance: unexpected error');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('plain string → "${where}: unexpected error" (no string leakage)', () => {
    // Kills: an impl that detects typeof err === 'string' and passes it through.
    expect(reduceErrorMessage('some raw string error', 'talk')).toBe('talk: unexpected error');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('null → "${where}: unexpected error" (no crash)', () => {
    // Kills: an impl that does err.name without a null check.
    expect(reduceErrorMessage(null, 'buy')).toBe('buy: unexpected error');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('undefined → "${where}: unexpected error" (no crash)', () => {
    // Kills: an impl that crashes on undefined input.
    expect(reduceErrorMessage(undefined, 'sell')).toBe('sell: unexpected error');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('plain object {} → "${where}: unexpected error" (no "[object Object]" leakage)', () => {
    // Kills: an impl using String(err) which would produce "[object Object]".
    expect(reduceErrorMessage({}, 'heal')).toBe('heal: unexpected error');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test description documents literal format
  it('number → "${where}: unexpected error"', () => {
    // Kills: an impl that coerces numbers with String().
    expect(reduceErrorMessage(42, 'train')).toBe('train: unexpected error');
  });

  it('Error with name="OtherError" (not SenderError or InternalError) → generic', () => {
    // Kills: an impl that matches on the Error class hierarchy rather than .name equality.
    const err = { name: 'OtherError', message: 'some other error' };
    expect(reduceErrorMessage(err, 'evolve')).toBe('evolve: unexpected error');
  });

  // ─── review additions: pin EXACT name equality, not substring ─────
  // A `name.includes('SenderError')` classifier survived every earlier test in this
  // file; these two kill it. The C9 contract is equality — a superstring name must
  // fall to the unknown branch, never pass its raw message through (no-leak).
  it('name "WrappedSenderError" (superstring) → generic — kills an includes()/endsWith classifier', () => {
    const err = { name: 'WrappedSenderError', message: 'raw server reason must not surface' };
    expect(reduceErrorMessage(err, 'buy')).toBe('buy: unexpected error');
  });

  it('name "MyInternalError" (superstring) → "unexpected error", NOT "server error"', () => {
    // An includes() classifier would route this to the internal branch; equality
    // routes it to unknown. Either way no detail leaks — the branch itself is pinned.
    const err = { name: 'MyInternalError', message: 'detail' };
    expect(reduceErrorMessage(err, 'sell')).toBe('sell: unexpected error');
  });

  // ─── review additions (RT-05): totality under hostile accessors ───────────────
  // reduceErrorMessage runs inside promise .catch handlers: a throw would escape as
  // an unhandled rejection and the user would see NO feedback. TOTAL means total.
  it('RT-05: throwing `name` getter → generic, does not throw', () => {
    const err = {};
    Object.defineProperty(err, 'name', {
      get() {
        throw new Error('hostile name getter');
      },
    });
    expect(reduceErrorMessage(err, 'buy')).toBe('buy: unexpected error');
  });

  it('RT-05: SenderError with throwing `message` getter → generic, does not throw', () => {
    const err = { name: 'SenderError' };
    Object.defineProperty(err, 'message', {
      get() {
        throw new Error('hostile message getter');
      },
    });
    expect(reduceErrorMessage(err, 'sell')).toBe('sell: unexpected error');
  });
});

// ================================================================================
// 5. reduceErrorMessage — TOTAL: never returns empty string (property test)
// ================================================================================

describe('reduceErrorMessage: TOTAL — never empty string', () => {
  it('T6: never returns empty string for any unknown err and non-empty where', () => {
    // Kills: any impl that returns '' under any codepath.
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.string(),
          fc.integer(),
          fc.record({ name: fc.string(), message: fc.string() }),
          fc.constant({}),
          fc.constant(new Error('test')),
        ),
        fc.string({ minLength: 1 }),
        (err, where) => {
          const result = reduceErrorMessage(err, where);
          expect(result.length).toBeGreaterThan(0); // never empty
          expect(result.startsWith(`${where}: `)).toBe(true); // always prefixed with where
        },
      ),
    );
  });

  it('T6: InternalError message never leaks into output (fast-check)', () => {
    // Kills: any impl that includes internal detail in the InternalError branch.
    // fc.pre guards against the unsatisfiable case where secretMessage is a substring
    // of the fixed output template `${where}: server error` (e.g. a single space or 'e')
    // — no correct impl can satisfy not.toContain for those, so we discard them.
    // Excluded seeds: -2095410398, 74725497, 426400510 all produce such substrings.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1 }),
        (secretMessage, where) => {
          fc.pre(!`${where}: server error`.includes(secretMessage));
          const err = { name: 'InternalError', message: secretMessage };
          const result = reduceErrorMessage(err, where);
          expect(result).not.toContain(secretMessage);
          expect(result).toBe(`${where}: server error`);
        },
      ),
    );
  });

  it('T6: no "[object Object]" in output for any plain-object input', () => {
    // Kills: any impl using String(err) which would produce "[object Object]"
    // for plain objects without a useful toString.
    fc.assert(
      fc.property(fc.record({ key: fc.string() }), fc.string({ minLength: 1 }), (obj, where) => {
        const result = reduceErrorMessage(obj as unknown, where);
        expect(result).not.toContain('[object Object]');
      }),
    );
  });
});

// ================================================================================
// 6. subscriptionErrorMessage — T7
// ================================================================================

describe('subscriptionErrorMessage: T7 — event.message extraction with fallback', () => {
  it('{event: Error with message "boom"} → "boom"', () => {
    // Kills: an impl that ignores the event.message and always returns the fallback.
    const ctx = { event: new Error('boom') };
    expect(subscriptionErrorMessage(ctx)).toBe('boom');
  });

  it('{event: { message: "sub failed" }} → "sub failed"', () => {
    // Kills: an impl that requires event to be an Error instance (instanceof check).
    const ctx = { event: { message: 'sub failed' } };
    expect(subscriptionErrorMessage(ctx)).toBe('sub failed');
  });

  it('{} → "subscription error" (fallback)', () => {
    // Kills: an impl that crashes on missing event property.
    expect(subscriptionErrorMessage({})).toBe('subscription error');
  });

  it('undefined → "subscription error" (fallback)', () => {
    // Kills: an impl that crashes on undefined input.
    expect(subscriptionErrorMessage(undefined)).toBe('subscription error');
  });

  it('{event: {}} → "subscription error" (fallback — message missing)', () => {
    // Kills: an impl that returns "{}" or "undefined" when message is absent.
    expect(subscriptionErrorMessage({ event: {} })).toBe('subscription error');
  });

  it('{event: {message: ""}} → "subscription error" (empty message is a fallback)', () => {
    // Kills: an impl that treats empty string as a valid non-fallback message.
    // The contract says "non-empty string message" is required for pass-through.
    expect(subscriptionErrorMessage({ event: { message: '' } })).toBe('subscription error');
  });

  it('null → "subscription error" (no crash)', () => {
    // Kills: an impl that does ctx.event without a null guard.
    expect(subscriptionErrorMessage(null)).toBe('subscription error');
  });

  it('{event: null} → "subscription error" (event is null, not an object)', () => {
    // Kills: an impl that crashes on null event.
    expect(subscriptionErrorMessage({ event: null })).toBe('subscription error');
  });

  it('{event: {message: "   "}} → passes through (non-empty whitespace is a valid message)', () => {
    // The spec says "non-empty string" — whitespace-only is technically non-empty.
    // This documents the boundary: only truly empty ("") triggers the fallback.
    // Kills: an impl that trims/normalizes the message before the emptiness check.
    // UX boundary: the consumer (main.ts reportError) sets textContent; a whitespace
    // message renders blank — documented boundary, contract is literal non-empty string.
    expect(subscriptionErrorMessage({ event: { message: '   ' } })).toBe('   ');
  });

  it('RT-05 (review addition): throwing `event` getter → fallback, does not throw', () => {
    // Runs inside the SDK's onError callback — totality under hostile accessors.
    const ctx = {};
    Object.defineProperty(ctx, 'event', {
      get() {
        throw new Error('hostile event getter');
      },
    });
    expect(subscriptionErrorMessage(ctx)).toBe('subscription error');
  });
});

// ================================================================================
// 7. conversationEndReason — the advance_dialogue refusals that end a conversation (qf-6)
// ================================================================================

/** A reducer rejection as the SDK hands it over: an Error whose `name` is its class. */
const senderError = (message: string): Error =>
  Object.assign(new Error(message), { name: 'SenderError' });
const internalError = (message: string): Error =>
  Object.assign(new Error(message), { name: 'InternalError' });

/** The four npc.rs `advance_dialogue` refusals that end a conversation, with their reasons. */
const REFUSALS = [
  ['walked too far away', 'walkedAway'],
  ['no longer in same zone', 'leftZone'],
  ['npc not found', 'npcGone'],
  ['npc character not found', 'npcGone'],
] as const;
const REFUSAL_MESSAGES: readonly string[] = REFUSALS.map(([message]) => message);

describe('conversationEndReason: the advance refusals that end a conversation (qf-6)', () => {
  it('maps each of the four refusal messages to its reason, however the SenderError is built QF6.2', () => {
    // Kills: two reasons swapped (the player is told the wrong cause), the npc-character branch
    // dropped (that refusal would leave the dialogue wedged open), and an `instanceof` class check
    // (the SDK class may be duplicated across chunks, so a plain or prototype-less object with the
    // right `name` must map too, exactly as reduceErrorMessage classifies it).
    for (const [message, reason] of REFUSALS) {
      expect(conversationEndReason(senderError(message)), message).toBe(reason);
      expect(conversationEndReason({ name: 'SenderError', message }), `${message}, plain`).toBe(
        reason,
      );
      const bare = Object.create(null) as Record<string, unknown>;
      bare.name = 'SenderError';
      bare.message = message;
      expect(conversationEndReason(bare), `${message}, no prototype`).toBe(reason);
    }
  });

  it('ends no conversation for any other advance refusal, a near-miss spelling or the formatted status line QF6.2', () => {
    // Kills: a mapping that dismisses on every refusal (the battle, deletion-gate, no-conversation,
    // join, character, tree, node and choice refusals keep today's report and the overlay), and an
    // includes / startsWith / endsWith / trimming / case-folding match (each near miss would end a
    // conversation the server never refused for distance, zone or a missing NPC).
    const others = [
      'cannot advance dialogue during an ongoing battle',
      'account deletion requested; new trades, battles and challenges are unavailable',
      'no active conversation',
      'not joined',
      'character not found',
      'dialogue tree not found',
      'node not found',
      'InvalidChoice',
      'ChoiceUnavailable',
      'walked too far away!',
      ' walked too far away',
      'walked too far away ',
      'Walked too far away',
      'WALKED TOO FAR AWAY',
      'walked too far',
      'too far away',
      'no longer in the same zone',
      'npc not found.',
      'NPC not found',
      'npc character not found!',
      'advance: walked too far away',
      'advance: no longer in same zone',
      'advance: npc not found',
      '',
    ];
    for (const message of others) {
      expect(conversationEndReason(senderError(message)), JSON.stringify(message)).toBeUndefined();
    }
  });

  it('ends no conversation for a refusal message carried by anything but a SenderError QF6.2', () => {
    // Kills: a mapping that reads the message without the class (an InternalError's detail, or a
    // plain client-side Error with the same words, would dismiss a conversation the server never
    // refused), and a substring or case-folded class check.
    for (const message of REFUSAL_MESSAGES) {
      expect(conversationEndReason(internalError(message)), `InternalError ${message}`).toBe(
        undefined,
      );
      expect(conversationEndReason(new Error(message)), `Error ${message}`).toBeUndefined();
      expect(
        conversationEndReason({ name: 'WrappedSenderError', message }),
        `wrapped ${message}`,
      ).toBeUndefined();
      expect(
        conversationEndReason({ name: 'senderError', message }),
        `lower-case ${message}`,
      ).toBeUndefined();
      expect(conversationEndReason({ message }), `no name ${message}`).toBeUndefined();
      expect(conversationEndReason(message), `a bare string ${message}`).toBeUndefined();
    }
    for (const value of [null, undefined, 0, 42, true, [], {}, { name: 'SenderError' }]) {
      expect(conversationEndReason(value), String(value)).toBeUndefined();
    }
  });

  it('is total: a throwing name or message getter ends no conversation and never throws QF6.2', () => {
    // Kills: an unguarded property read. This runs inside the advance's rejection handler, where a
    // throw escapes as an unhandled rejection and the player is told nothing at all.
    const hostileName = {};
    Object.defineProperty(hostileName, 'name', {
      get() {
        throw new Error('hostile name getter');
      },
    });
    const hostileMessage = { name: 'SenderError' };
    Object.defineProperty(hostileMessage, 'message', {
      get() {
        throw new Error('hostile message getter');
      },
    });
    const hostileProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile proxy');
        },
      },
    );
    for (const err of [hostileName, hostileMessage, hostileProxy]) {
      expect(() => conversationEndReason(err)).not.toThrow();
      expect(conversationEndReason(err)).toBeUndefined();
    }
  });

  it('ends no conversation for any SenderError message but the four refusals (fast-check) QF6.2', () => {
    // Kills: any loosened comparison (a prefix, suffix, substring, trim or case-fold match) and
    // any extra message mapped to a reason.
    const nearMiss = fc
      .tuple(fc.constantFrom(...REFUSAL_MESSAGES), fc.string({ minLength: 1 }), fc.boolean())
      .map(([message, extra, before]) => (before ? `${extra}${message}` : `${message}${extra}`));
    fc.assert(
      fc.property(fc.oneof(fc.string(), nearMiss), (message) => {
        fc.pre(!REFUSAL_MESSAGES.includes(message));
        expect(conversationEndReason(senderError(message))).toBeUndefined();
      }),
    );
  });

  it('ends no conversation for a refusal message under any class name but SenderError (fast-check) QF6.2', () => {
    // Kills: a class check looser than name equality.
    fc.assert(
      fc.property(fc.string(), fc.constantFrom(...REFUSAL_MESSAGES), (name, message) => {
        fc.pre(name !== 'SenderError');
        expect(conversationEndReason({ name, message })).toBeUndefined();
      }),
    );
  });
});

// ================================================================================
// 8. questAckSnapshot / questCompletionAck — acknowledging a completed quest (qf-6)
// ================================================================================

const ME = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

interface QuestRow {
  readonly pqId: bigint;
  readonly questId: string;
}

const QUEST_001: QuestRow = { pqId: 1n, questId: 'quest_001' };
const QUEST_002: QuestRow = { pqId: 2n, questId: 'quest_002' };

/** A READY snapshot: my `quests`, my wallet (`undefined`: no wallet row yet) and whether my
 *  conversation row is present. */
function snap(
  quests: readonly QuestRow[],
  balance: bigint | undefined,
  conversationOpen: boolean,
  identity: string = ME,
): QuestAckSnapshot | undefined {
  return questAckSnapshot({
    ready: true,
    identity,
    quests,
    wallet: balance === undefined ? undefined : { balance },
    conversationOpen,
  });
}

describe('questCompletionAck: a completing talk acknowledges the quest and its reward (qf-6)', () => {
  it('a completion that creates the wallet acknowledges the whole new balance as the reward QF6.4', () => {
    // Kills: an absent wallet read as "no snapshot" (a new player's first reward, which inserts the
    // wallet row, would never be acknowledged) or as "no change" (acknowledged without its gold).
    const before = snap([QUEST_001], undefined, false);
    expect(before, 'a ready snapshot with no wallet row exists').toBeDefined();
    expect(before?.balance, 'an absent wallet is 0 gold, the server meaning').toBe(0n);
    expect(questCompletionAck(before, snap([], 50n, true))).toEqual({
      name: 'quest_001',
      reward: 50n,
    });
  });

  it('the reward is the balance gain across the completing batch, and null when there is none QF6.4', () => {
    // Kills: the new balance reported as the reward (80, not 50), the old one, a sign error, a zero
    // gain reported as "0 gold", and a balance spent in the same batch reported as a negative.
    const ack = (was: bigint, is: bigint) =>
      questCompletionAck(snap([QUEST_001], was, false), snap([], is, true));
    expect(ack(30n, 80n)).toEqual({ name: 'quest_001', reward: 50n });
    expect(ack(0n, 7n)).toEqual({ name: 'quest_001', reward: 7n });
    expect(ack(30n, 31n)).toEqual({ name: 'quest_001', reward: 1n });
    expect(ack(30n, 30n)).toEqual({ name: 'quest_001', reward: null });
    expect(ack(80n, 30n)).toEqual({ name: 'quest_001', reward: null });
  });

  it('the reward equals the gain whenever it is positive and is null otherwise (fast-check) QF6.4', () => {
    // Kills: a Number() round trip (gold past 2^53), a clamp, an off-by-one boundary at zero.
    const gold = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }), gold, (was, is) => {
        const ack = questCompletionAck(snap([QUEST_001], was, false), snap([], is, true));
        expect(ack?.name).toBe('quest_001');
        expect(ack?.reward).toBe(is - was > 0n ? is - was : null);
      }),
    );
  });

  it('acknowledges nothing before the store is hydrated, or over a wallet balance that is not a bigint QF6.4', () => {
    // Kills: a snapshot taken before hydration (a reconnect's half-applied store would be read as a
    // completion), and a balance coerced with Number() or BigInt() (a malformed row is no reward).
    const input = {
      identity: ME,
      quests: [QUEST_001],
      wallet: { balance: 30n },
      conversationOpen: false,
    };
    expect(questAckSnapshot({ ...input, ready: false }), 'not ready').toBeUndefined();
    expect(questAckSnapshot({ ...input, ready: true }), 'ready').toBeDefined();
    for (const balance of [30, '30', null, undefined, 30.5, Number.NaN, {}, [30n]]) {
      expect(
        questAckSnapshot({ ...input, ready: true, wallet: { balance } }),
        `balance ${String(balance)}`,
      ).toBeUndefined();
    }
    const now = snap([], 80n, true);
    expect(questCompletionAck(undefined, now), 'no baseline yet').toBeUndefined();
    expect(questCompletionAck(snap([QUEST_001], 30n, false), undefined), 'not ready now').toBe(
      undefined,
    );
    expect(questCompletionAck(undefined, undefined)).toBeUndefined();
  });

  it('acknowledges nothing for an identity change, a step advance, a started quest, a wallet-only gain or the deletion cascade QF6.4', () => {
    // Kills: an acknowledgement across a reconnect that minted a new identity; one keyed on a row's
    // object identity instead of its pqId value (the step advance hands over a fresh row object
    // with the same pqId; it keeps the questId too, so it cannot tell pqId keying from questId
    // keying: the re-keyed-row test below does); one that fires on any quest-set change or on any
    // balance gain (a trade payout, a sale); and one that ignores the conversation row (account
    // deletion removes the quest AND the conversation rows together, which is no completion).
    // Each negative is one field from the positive.
    const prev = snap([QUEST_001], 30n, false);
    expect(questCompletionAck(prev, snap([], 80n, true)), 'positive control').toEqual({
      name: 'quest_001',
      reward: 50n,
    });
    expect(questCompletionAck(prev, snap([], 80n, true, OTHER)), 'another identity now').toBe(
      undefined,
    );
    expect(
      questCompletionAck(snap([QUEST_001], 30n, false, OTHER), snap([], 80n, true)),
      'another identity before',
    ).toBeUndefined();
    expect(
      questCompletionAck(prev, snap([{ pqId: 1n, questId: 'quest_001' }], 80n, true)),
      'the same row at a new step',
    ).toBeUndefined();
    expect(
      questCompletionAck(snap([], 30n, false), snap([QUEST_002], 80n, true)),
      'a quest started',
    ).toBeUndefined();
    expect(
      questCompletionAck(prev, snap([QUEST_001, QUEST_002], 80n, true)),
      'a second quest started',
    ).toBeUndefined();
    expect(questCompletionAck(prev, snap([QUEST_001], 80n, true)), 'only the wallet moved').toBe(
      undefined,
    );
    expect(
      questCompletionAck(snap([QUEST_001], 30n, true), snap([], 30n, false)),
      'the deletion cascade: the quest and my conversation leave together',
    ).toBeUndefined();
    expect(
      questCompletionAck(prev, snap([], 80n, false)),
      'the row left with no conversation open',
    ).toBeUndefined();
    // The caller passes only MY rows, so another player's quest leaving is an unchanged set here.
    expect(
      questCompletionAck(snap([], 30n, false), snap([], 80n, true)),
      "another player's row left",
    ).toBeUndefined();
  });

  it('matches rows by pqId: the same quest id on a new row, while the old row left, is a completion QF6.4', () => {
    // Kills: rows keyed by questId instead of pqId (the old row's quest id is still present, on the
    // new row, so a questId-keyed diff sees nothing leave and the completion goes unacknowledged).
    expect(
      questCompletionAck(
        snap([{ pqId: 1n, questId: 'q' }], 30n, false),
        snap([{ pqId: 2n, questId: 'q' }], 80n, true),
      ),
    ).toEqual({ name: 'q', reward: 50n });
  });

  it('names every quest that completed in the batch, sorted, and never one still active QF6.4', () => {
    // Kills: only the first completion named, names joined in pqId or row order, and a still-active
    // quest named beside the completed ones.
    const prev = snap(
      [
        { pqId: 1n, questId: 'quest_b' },
        { pqId: 2n, questId: 'quest_a' },
        { pqId: 3n, questId: 'quest_c' },
      ],
      10n,
      false,
    );
    const now = snap([{ pqId: 3n, questId: 'quest_c' }], 60n, true);
    expect(questCompletionAck(prev, now)).toEqual({ name: 'quest_a, quest_b', reward: 50n });
  });

  it('names exactly the rows that left, sorted, only while my conversation is open, and never a non-positive reward (fast-check) QF6.4', () => {
    // Kills: a still-present row named, a missing one left out, an unsorted join, an
    // acknowledgement with no conversation row, one that needs the conversation to be NEW (a
    // re-talk while it is already open still completes), and a zero or negative reward.
    const id = fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/);
    const rows = fc
      .uniqueArray(fc.record({ pqId: fc.bigInt({ min: 0n, max: 999n }), questId: id }), {
        selector: (r) => r.pqId,
        maxLength: 6,
      })
      .map((rs) => rs.filter((r, i) => rs.findIndex((o) => o.questId === r.questId) === i));
    const gold = fc.bigInt({ min: 0n, max: 1_000_000n });
    fc.assert(
      fc.property(
        rows,
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        fc.array(id, { maxLength: 3 }),
        fc.tuple(gold, gold),
        fc.tuple(fc.boolean(), fc.boolean()),
        (before, keep, started, [was, is], [wasOpen, open]) => {
          const kept = before.filter((_, i) => keep[i] === true);
          // Upper-case ids never collide with the generated lower-case ones.
          const added = started.map((q, i) => ({ pqId: 1_000n + BigInt(i), questId: `N${q}` }));
          const ack = questCompletionAck(
            snap(before, was, wasOpen),
            snap([...kept, ...added], is, open),
          );
          const left = before
            .filter((r) => !kept.includes(r))
            .map((r) => r.questId)
            .sort();
          if (!open || left.length === 0) {
            expect(ack).toBeUndefined();
            return;
          }
          expect(ack?.name).toBe(left.join(', '));
          const named = ack?.name.split(', ') ?? [];
          for (const r of kept) expect(named).not.toContain(r.questId);
          expect(ack?.reward === null || (ack?.reward ?? 0n) > 0n).toBe(true);
          expect(ack?.reward).toBe(is - was > 0n ? is - was : null);
        },
      ),
    );
  });
});

// ================================================================================
// 9. statusNoticeStep — status notices the live region's coalescer cannot swallow (qf-6)
// ================================================================================

/** The live region's coalescing window (ui/liveRegion.ts COALESCE_WINDOW_MS), as main.ts passes it. */
const WINDOW_MS = 500;
const queue = (text: string, nowMs: number): StatusNoticeEvent => ({ kind: 'queue', text, nowMs });
const quiet = (nowMs: number): StatusNoticeEvent => ({
  kind: 'frame',
  nowMs,
  transitionAnnounced: false,
});
const transition = (nowMs: number): StatusNoticeEvent => ({
  kind: 'frame',
  nowMs,
  transitionAnnounced: true,
});

/** What each event speaks (null: nothing), folding from `from` with `windowMs`. */
function spoken(
  events: readonly StatusNoticeEvent[],
  windowMs: number = WINDOW_MS,
  from: StatusNoticeState = STATUS_NOTICE_INITIAL,
): (string | null)[] {
  let state = from;
  return events.map((event) => {
    const step = statusNoticeStep(state, event, windowMs);
    state = step.state;
    return step.speak;
  });
}

/** A random history step: a delay, then a quiet frame, a transition frame or a queued notice. */
const historyStep = fc.tuple(
  fc.integer({ min: 0, max: 400 }),
  fc.constantFrom('quiet', 'transition', 'A', 'B', 'C'),
);
const eventFor = (kind: string, nowMs: number): StatusNoticeEvent => {
  if (kind === 'quiet') return quiet(nowMs);
  if (kind === 'transition') return transition(nowMs);
  return queue(kind, nowMs);
};

describe('statusNoticeStep: a status notice the live region speaks without losing it (qf-6)', () => {
  it('starts with nothing queued, spoken or announced, and frames over it speak nothing QF6.2', () => {
    // Kills: an initial state carrying a phantom notice or a transition stamp.
    expect(STATUS_NOTICE_INITIAL).toEqual({ queued: null, spoken: null, lastTransitionAtMs: null });
    expect(spoken([quiet(0), transition(10), quiet(5_000)])).toEqual([null, null, null]);
  });

  it('speaks a queued notice on the first quiet frame a full window after it was queued, exactly once QF6.2', () => {
    // Kills: speaking at queue time (the next overlay label replaces it inside the coalescing
    // window), an exclusive boundary, and speaking it again on the next frame.
    expect(
      spoken([
        queue('A', 1_000),
        quiet(1_000),
        quiet(1_499),
        quiet(1_500),
        quiet(1_501),
        quiet(9_000),
      ]),
    ).toEqual([null, null, null, 'A', null, null]);
  });

  it('holds a notice for the window it is given, not a fixed one QF6.2', () => {
    // Kills: a hard-coded 500 ms.
    expect(spoken([queue('A', 0), quiet(299), quiet(300)], 300)).toEqual([null, null, 'A']);
    expect(spoken([queue('A', 0), transition(100), quiet(399), quiet(400)], 300)).toEqual([
      null,
      null,
      null,
      'A',
    ]);
  });

  it('a transition frame speaks nothing, even with a notice due, and holds it a full window past the transition QF6.2', () => {
    // Kills: a hold measured from the queue alone (the notice would land inside the window the
    // overlay's open or close label just opened, and the coalescer keeps only one of the two), and
    // a notice spoken on the transition frame itself.
    expect(
      spoken([queue('A', 0), transition(600), quiet(1_099), quiet(1_100), quiet(1_200)]),
    ).toEqual([null, null, null, 'A', null]);
    expect(spoken([queue('A', 0), transition(400), quiet(500), quiet(899), quiet(900)])).toEqual([
      null,
      null,
      null,
      null,
      'A',
    ]);
  });

  it('a transition inside the window after a notice was spoken re-queues it, and it is spoken again a window later QF6.2', () => {
    // Kills: no re-queue (the ended line, spoken just before the dismiss closes the overlay, is
    // replaced in the coalescer by the world label and never heard), and a re-queue spoken without
    // the hold (straight back into the window the transition opened).
    expect(
      spoken([
        queue('A', 0),
        quiet(500),
        transition(700),
        quiet(1_199),
        quiet(1_200),
        quiet(1_300),
        quiet(5_000),
      ]),
    ).toEqual([null, 'A', null, null, 'A', null, null]);
    expect(
      spoken([queue('A', 0), quiet(500), transition(999), quiet(1_498), quiet(1_499)]),
    ).toEqual([null, 'A', null, null, 'A']);
  });

  it('a transition a full window or more after a notice was spoken re-queues nothing QF6.2', () => {
    // Kills: an inclusive clobber test (the notice spoken twice), and a re-queue on every
    // transition.
    expect(
      spoken([
        queue('A', 0),
        quiet(500),
        transition(1_000),
        quiet(1_500),
        quiet(3_000),
        transition(3_100),
        quiet(4_000),
      ]),
    ).toEqual([null, 'A', null, null, null, null, null]);
  });

  it('a newer notice replaces a queued one: only the newest is spoken, a full window after it was queued QF6.2', () => {
    // Kills: the first notice winning, both spoken in turn (two lines for one status), and the
    // newer notice inheriting the older one's queue time.
    expect(
      spoken([queue('A', 0), queue('B', 300), quiet(500), quiet(799), quiet(800), quiet(2_000)]),
    ).toEqual([null, null, null, null, 'B', null]);
  });

  it('a transition that clobbers a spoken notice re-queues it only when nothing newer is waiting: the newer notice wins QF6.2', () => {
    // Kills: a re-queue that overwrites a newer waiting notice (the stale line would be spoken
    // again and the newer one never).
    expect(
      spoken([
        queue('A', 0),
        quiet(500),
        queue('B', 600),
        transition(700),
        quiet(1_199),
        quiet(1_200),
        quiet(5_000),
      ]),
    ).toEqual([null, 'A', null, null, null, 'B', null]);
  });

  it('never speaks on a queue or a transition frame, never inside a window after a transition, and never repeats a notice nothing re-armed (fast-check) QF6.2', () => {
    // Kills: a notice spoken over a transition (one of the two is lost to the coalescer), a
    // spoken text that was never queued, and a notice repeated with no new queue and no
    // clobbering transition.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.array(historyStep, { maxLength: 40 }),
        (windowMs, history) => {
          let state = STATUS_NOTICE_INITIAL;
          let now = 0;
          let lastTransition: number | null = null;
          const queued = new Set<string>();
          const lastSpoken = new Map<string, number>();
          const rearmed = new Set<string>();
          for (const [dt, kind] of history) {
            now += dt;
            const event = eventFor(kind, now);
            const result = statusNoticeStep(state, event, windowMs);
            state = result.state;
            if (event.kind === 'queue') {
              expect(result.speak, 'a queue speaks nothing').toBeNull();
              queued.add(event.text);
              rearmed.add(event.text);
              continue;
            }
            if (event.transitionAnnounced) {
              expect(result.speak, 'a transition frame speaks nothing').toBeNull();
              lastTransition = now;
              for (const [text, at] of lastSpoken) if (now - at < windowMs) rearmed.add(text);
              continue;
            }
            if (result.speak === null) continue;
            expect(
              lastTransition === null || now - lastTransition >= windowMs,
              'spoken a full window after the last transition',
            ).toBe(true);
            expect(queued.has(result.speak), 'only a queued notice is spoken').toBe(true);
            expect(rearmed.has(result.speak), 'spoken again only after a queue or a clobber').toBe(
              true,
            );
            rearmed.delete(result.speak);
            lastSpoken.set(result.speak, now);
          }
        },
      ),
    );
  });

  it('a notice queued after any history is spoken by the first quiet frame a window later, then not again (fast-check) QF6.2', () => {
    // Kills: a notice lost to an earlier history (a stale queue time, a transition stamp that never
    // expires, a spoken slot that blocks the next notice) and one spoken twice.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.array(historyStep, { maxLength: 40 }),
        fc.integer({ min: 0, max: 2_000 }),
        (windowMs, history, late) => {
          let state = STATUS_NOTICE_INITIAL;
          let now = 0;
          for (const [dt, kind] of history) {
            now += dt;
            state = statusNoticeStep(state, eventFor(kind, now), windowMs).state;
          }
          state = statusNoticeStep(state, queue('the notice', now), windowMs).state;
          const due = statusNoticeStep(state, quiet(now + windowMs + late), windowMs);
          expect(due.speak).toBe('the notice');
          expect(
            statusNoticeStep(due.state, quiet(now + windowMs + late + 1), windowMs).speak,
          ).toBe(null);
        },
      ),
    );
  });
});
