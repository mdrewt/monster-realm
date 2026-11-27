import { describe, expect, test } from 'vitest';
import type { Profile } from '../config.ts';
import {
  type AppOwnership,
  entitled,
  type OwnershipCheck,
  parseSteamId,
  STEAM_SUBJECT_PREFIX,
  type SteamEntitlement,
  type SteamId,
  steamEntitlementSource,
  steamIdOfSubject,
  steamSubject,
} from './ownership.ts';

const PLAYER_DIGITS = '76561198000000001';
const OTHER_DIGITS = '76561198000000002';
const PLAYER = parseSteamId(PLAYER_DIGITS)!;
const OTHER = parseSteamId(OTHER_DIGITS)!;
const DEV_PROFILES: readonly Profile[] = ['local-dev', 'hosted-dev'];
const ALL_PROFILES: readonly Profile[] = ['local-dev', 'hosted-dev', 'production'];

// Digits of other scripts, built from code points.
const FULL_WIDTH_DIGITS = Array.from(PLAYER_DIGITS, (digit) =>
  String.fromCharCode(0xff10 + Number(digit)),
).join('');
const ARABIC_INDIC_DIGITS = Array.from(PLAYER_DIGITS, (digit) =>
  String.fromCharCode(0x0660 + Number(digit)),
).join('');

function owner(holder: string): AppOwnership {
  return { ownsapp: true, permanent: true, sitelicense: false, ownersteamid: holder };
}

/** A value of the wrong run-time type, as a JSON answer or a JS caller could hand in. */
function loose(value: Record<string, unknown>): AppOwnership {
  return value as unknown as AppOwnership;
}

interface Fakes {
  readonly calls: { denied: SteamId[]; devFlag: SteamId[]; check: SteamId[] };
  readonly denied: (steamId: SteamId) => Promise<boolean>;
  readonly devFlag: (steamId: SteamId) => Promise<boolean>;
  readonly checkAppOwnership: (steamId: SteamId) => Promise<OwnershipCheck>;
}

/** Fakes for the decision's three effects. An `Error` value makes that effect reject with it. */
function fakes(answers: {
  readonly denied: boolean | Error;
  readonly flag: boolean | Error;
  readonly check: OwnershipCheck | Error;
}): Fakes {
  const calls = { denied: [] as SteamId[], devFlag: [] as SteamId[], check: [] as SteamId[] };
  return {
    calls,
    async denied(steamId) {
      calls.denied.push(steamId);
      if (answers.denied instanceof Error) throw answers.denied;
      return answers.denied;
    },
    async devFlag(steamId) {
      calls.devFlag.push(steamId);
      if (answers.flag instanceof Error) throw answers.flag;
      return answers.flag;
    },
    async checkAppOwnership(steamId) {
      calls.check.push(steamId);
      if (answers.check instanceof Error) throw answers.check;
      return answers.check;
    },
  };
}

function decide(profile: Profile, f: Fakes, steamId: SteamId = PLAYER): Promise<SteamEntitlement> {
  return steamEntitlementSource({
    profile,
    denied: f.denied,
    devFlag: f.devFlag,
    checkAppOwnership: f.checkAppOwnership,
  })(steamId);
}

/** How a promise settled, without letting a rejection end the test. */
async function settle<T>(
  promise: Promise<T>,
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function answered(ownership: AppOwnership): OwnershipCheck {
  return { kind: 'answered', ownership };
}

describe('the ownership rule', () => {
  const combinations = [true, false].flatMap((ownsapp) =>
    [true, false].flatMap((permanent) =>
      [true, false].flatMap((sitelicense) =>
        (['the player', 'another account'] as const).map(
          (holder) => [ownsapp, permanent, sitelicense, holder] as const,
        ),
      ),
    ),
  );

  test.each(
    combinations,
  )('ownsapp %s, permanent %s, sitelicense %s, held by %s: entitled only when owned, permanent, not a site licence and held by the player acs-8.1', (ownsapp, permanent, sitelicense, holder) => {
    const ownership: AppOwnership = {
      ownsapp,
      permanent,
      sitelicense,
      ownersteamid: holder === 'the player' ? PLAYER : OTHER,
    };
    const expected = ownsapp && permanent && !sitelicense && holder === 'the player';
    expect(entitled(ownership, PLAYER)).toBe(expected);
  });

  test('of the sixteen combinations exactly one is entitled: owned, permanent, not a site licence, held by the player acs-8.1', () => {
    expect(combinations).toHaveLength(16);
    const winners = combinations.filter(([ownsapp, permanent, sitelicense, holder]) =>
      entitled(
        { ownsapp, permanent, sitelicense, ownersteamid: holder === 'the player' ? PLAYER : OTHER },
        PLAYER,
      ),
    );
    expect(winners).toEqual([[true, true, false, 'the player']]);
  });

  test('the same licence held by the player is entitled for the player and not for another account acs-8.1', () => {
    expect(entitled(owner(PLAYER), PLAYER)).toBe(true);
    expect(entitled(owner(PLAYER), OTHER)).toBe(false);
    expect(entitled(owner(OTHER), OTHER)).toBe(true);
  });

  test.each([
    ['ownsapp 1', { ownsapp: 1 }],
    ['ownsapp "true"', { ownsapp: 'true' }],
    ['ownsapp an object', { ownsapp: {} }],
    ['ownsapp undefined', { ownsapp: undefined }],
    ['permanent 1', { permanent: 1 }],
    ['permanent "true"', { permanent: 'true' }],
    ['permanent undefined', { permanent: undefined }],
    ['sitelicense 0', { sitelicense: 0 }],
    ['sitelicense null', { sitelicense: null }],
    ['sitelicense undefined', { sitelicense: undefined }],
    ['sitelicense an empty string', { sitelicense: '' }],
    ['sitelicense "false"', { sitelicense: 'false' }],
  ])('a member that is not the boolean it should be never counts for the player: %s acs-8.1', (_name, defect) => {
    expect(entitled(loose({ ...owner(PLAYER), ...defect }), PLAYER)).toBe(false);
  });

  test('a member absent from the answer never counts for the player acs-8.1', () => {
    for (const member of ['ownsapp', 'permanent', 'sitelicense', 'ownersteamid']) {
      const partial = Object.fromEntries(
        Object.entries(owner(PLAYER)).filter(([name]) => name !== member),
      );
      expect(entitled(loose(partial), PLAYER), member).toBe(false);
    }
  });

  test.each([
    ['a leading zero', `0${PLAYER_DIGITS}`],
    ['a trailing space', `${PLAYER_DIGITS} `],
    ['a leading space', ` ${PLAYER_DIGITS}`],
    ['a trailing digit', `${PLAYER_DIGITS}0`],
    ['the last digit cut', PLAYER_DIGITS.slice(0, -1)],
    ['the subject form', `steam:${PLAYER_DIGITS}`],
    ['full-width digits', FULL_WIDTH_DIGITS],
  ])('an ownersteamid equal to the player id but for %s is another holder acs-8.1', (_name, holder) => {
    expect(entitled(owner(holder), PLAYER)).toBe(false);
  });

  test('an ownersteamid given as a number is not the player id acs-8.1', () => {
    expect(entitled(loose({ ...owner(PLAYER), ownersteamid: Number(PLAYER_DIGITS) }), PLAYER)).toBe(
      false,
    );
  });

  test.each([
    ['0', '0'],
    ['an empty string', ''],
    ['16 digits', PLAYER_DIGITS.slice(1)],
  ])('a steamId that is not 17 digits at run time (%s) is never entitled, even holding the licence itself acs-8.1', (_name, raw) => {
    const steamId = raw as unknown as SteamId;
    expect(entitled(owner(raw), steamId)).toBe(false);
  });
});

describe('SteamIDs and Steam subjects', () => {
  test('a string of exactly 17 ASCII digits is a SteamId, unchanged', () => {
    expect(parseSteamId(PLAYER_DIGITS)).toBe(PLAYER_DIGITS);
    expect(parseSteamId('00000000000000000')).toBe('00000000000000000');
  });

  test.each([
    ['16 digits', PLAYER_DIGITS.slice(1)],
    ['18 digits', `${PLAYER_DIGITS}0`],
    ['a trailing newline', `${PLAYER_DIGITS}\n`],
    ['a leading space', ` ${PLAYER_DIGITS}`],
    ['a trailing space', `${PLAYER_DIGITS} `],
    ['a sign', `+${PLAYER_DIGITS.slice(1)}`],
    ['a letter', `${PLAYER_DIGITS.slice(0, -1)}a`],
    ['full-width digits', FULL_WIDTH_DIGITS],
    ['Arabic-Indic digits', ARABIC_INDIC_DIGITS],
    ['the subject form', `steam:${PLAYER_DIGITS}`],
    ['an empty string', ''],
    ['a number', Number(PLAYER_DIGITS)],
    ['a bigint', BigInt(PLAYER_DIGITS)],
    ['null', null],
    ['undefined', undefined],
    ['an array holding the id', [PLAYER_DIGITS]],
    ['an object', { toString: () => PLAYER_DIGITS }],
  ])('%s is not a SteamId', (_name, value) => {
    expect(parseSteamId(value)).toBeUndefined();
  });

  test('the subject of a Steam player is steam: and the SteamID, and it reads back as that id', () => {
    expect(STEAM_SUBJECT_PREFIX).toBe('steam:');
    expect(steamSubject(PLAYER).startsWith(STEAM_SUBJECT_PREFIX)).toBe(true);
    expect(steamSubject(PLAYER)).toBe(`steam:${PLAYER_DIGITS}`);
    expect(steamIdOfSubject(steamSubject(PLAYER))).toBe(PLAYER);
    expect(steamIdOfSubject(steamSubject(OTHER))).toBe(OTHER);
  });

  test.each([
    ['a capitalised prefix', `Steam:${PLAYER_DIGITS}`],
    ['an upper-case prefix', `STEAM:${PLAYER_DIGITS}`],
    ['the prefix alone', 'steam:'],
    ['16 digits', `steam:${PLAYER_DIGITS.slice(1)}`],
    ['18 digits', `steam:${PLAYER_DIGITS}0`],
    ['a dev subject', 'dev:0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['the bare id', PLAYER_DIGITS],
    ['a trailing character', `steam:${PLAYER_DIGITS}x`],
    ['a trailing newline', `steam:${PLAYER_DIGITS}\n`],
    ['a trailing colon', `steam:${PLAYER_DIGITS}:`],
    ['a leading space', ` steam:${PLAYER_DIGITS}`],
    ['a space after the colon', `steam: ${PLAYER_DIGITS}`],
    ['full-width digits', `steam:${FULL_WIDTH_DIGITS}`],
  ])('%s is not the subject of a Steam player', (_name, sub) => {
    expect(steamIdOfSubject(sub)).toBeUndefined();
  });
});

describe('a denied SteamID', () => {
  const steamAnswers: ReadonlyArray<readonly [string, OwnershipCheck]> = [
    ['Steam says the player owns it', answered(owner(PLAYER))],
    ['Steam fails', { kind: 'failed', error: new Error('steam is down') }],
  ];
  const cases = ALL_PROFILES.flatMap((profile) =>
    steamAnswers.map(([name, check]) => [profile, name, check] as const),
  );

  test.each(
    cases,
  )('on %s is denied with its flag set entitled when %s, and neither the flag nor Steam is asked acs-8.4', async (profile, _name, check) => {
    const f = fakes({ denied: true, flag: true, check });
    expect(await decide(profile, f)).toStrictEqual({ entitled: false, reason: 'denied' });
    expect(f.calls.denied).toEqual([PLAYER]);
    expect(f.calls.devFlag).toEqual([]);
    expect(f.calls.check).toEqual([]);
  });

  test.each(
    ALL_PROFILES,
  )('on %s the deny-list is asked about the very id being decided acs-8.4', async (profile) => {
    const f = fakes({ denied: false, flag: true, check: answered(owner(OTHER)) });
    await decide(profile, f, OTHER);
    expect(f.calls.denied).toEqual([OTHER]);
  });
});

describe('the decision on a dev profile', () => {
  test.each(
    DEV_PROFILES,
  )('on %s a set flag entitles, and Steam is never asked even though it would say owned acs-8.6', async (profile) => {
    const f = fakes({ denied: false, flag: true, check: answered(owner(PLAYER)) });
    expect(await decide(profile, f)).toStrictEqual({ entitled: true });
    expect(f.calls.devFlag).toEqual([PLAYER]);
    expect(f.calls.check).toEqual([]);
  });

  test.each(
    DEV_PROFILES,
  )('on %s an unset flag is not-owned, and Steam is never asked even though it would say owned acs-8.6', async (profile) => {
    const f = fakes({ denied: false, flag: false, check: answered(owner(PLAYER)) });
    expect(await decide(profile, f)).toStrictEqual({ entitled: false, reason: 'not-owned' });
    expect(f.calls.devFlag).toEqual([PLAYER]);
    expect(f.calls.check).toEqual([]);
  });

  test.each(
    DEV_PROFILES,
  )('on %s a set flag entitles while Steam would fail, and Steam is never asked acs-8.6', async (profile) => {
    const f = fakes({
      denied: false,
      flag: true,
      check: { kind: 'failed', error: new Error('x') },
    });
    expect(await decide(profile, f)).toStrictEqual({ entitled: true });
    expect(f.calls.check).toEqual([]);
  });

  test.each(
    DEV_PROFILES,
  )('on %s the flag is read for the very id being decided acs-8.6', async (profile) => {
    const f = fakes({ denied: false, flag: true, check: answered(owner(OTHER)) });
    await decide(profile, f, OTHER);
    expect(f.calls.devFlag).toEqual([OTHER]);
  });
});

describe('the decision on production', () => {
  test('a Steam answer that the player holds the licence entitles, and the flag is never read acs-8.6', async () => {
    const f = fakes({ denied: false, flag: false, check: answered(owner(PLAYER)) });
    expect(await decide('production', f)).toStrictEqual({ entitled: true });
    expect(f.calls.check).toEqual([PLAYER]);
    expect(f.calls.devFlag).toEqual([]);
  });

  const defects: ReadonlyArray<readonly [string, AppOwnership]> = [
    ['not owned', { ...owner(PLAYER), ownsapp: false }],
    ['not permanent', { ...owner(PLAYER), permanent: false }],
    ['a site licence', { ...owner(PLAYER), sitelicense: true }],
    ['held by another account', owner(OTHER)],
  ];

  test.each(
    defects,
  )('a licence that is %s is not-owned even with the flag set entitled, and the flag is never read acs-8.6', async (_name, ownership) => {
    const f = fakes({ denied: false, flag: true, check: answered(ownership) });
    expect(await decide('production', f)).toStrictEqual({ entitled: false, reason: 'not-owned' });
    expect(f.calls.check).toEqual([PLAYER]);
    expect(f.calls.devFlag).toEqual([]);
  });

  test('Steam is asked about the very id being decided acs-8.6', async () => {
    const f = fakes({ denied: false, flag: false, check: answered(owner(OTHER)) });
    expect(await decide('production', f, OTHER)).toStrictEqual({ entitled: true });
    expect(f.calls.check).toEqual([OTHER]);
  });

  test('a failed check is unavailable and carries that very error acs-8.2', async () => {
    const error = new Error('steam answered 503');
    const f = fakes({ denied: false, flag: true, check: { kind: 'failed', error } });
    const result = await decide('production', f);
    expect(result).toStrictEqual({ entitled: false, reason: 'unavailable', error });
    if (result.entitled || result.reason !== 'unavailable') throw new Error('not unavailable');
    expect(result.error).toBe(error);
    expect(f.calls.devFlag).toEqual([]);
  });

  test.each([
    ['an unknown kind', { kind: 'weird', ownership: owner(PLAYER) }],
    ['a capitalised kind', { kind: 'Answered', ownership: owner(PLAYER) }],
    ['an undefined kind', { kind: undefined, ownership: owner(PLAYER) }],
    ['no kind', { ownership: owner(PLAYER) }],
  ])('a check result with %s carrying a perfect owner answer is not entitled: unavailable acs-8.2', async (_name, check) => {
    const f = fakes({ denied: false, flag: true, check: check as unknown as OwnershipCheck });
    const result = await decide('production', f);
    expect(result.entitled).toBe(false);
    expect(result.entitled === false && result.reason).toBe('unavailable');
    expect(f.calls.devFlag).toEqual([]);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
  ])('a check result of %s never resolves entitled acs-8.2', async (_name, check) => {
    const f = fakes({ denied: false, flag: true, check: check as unknown as OwnershipCheck });
    const outcome = await settle(decide('production', f));
    if (outcome.ok) expect(outcome.value.entitled).toBe(false);
    expect(f.calls.devFlag).toEqual([]);
  });
});

describe('a steamId that is not 17 digits at run time', () => {
  const notSteamIds: ReadonlyArray<readonly [string, string]> = [
    ['0', '0'],
    ['an empty string', ''],
    ['letters', 'abc'],
    ['16 digits', PLAYER_DIGITS.slice(1)],
    ['18 digits', `${PLAYER_DIGITS}0`],
  ];

  async function expectRefusedBeforeAnyEffect(profile: Profile, raw: string): Promise<void> {
    const f = fakes({ denied: false, flag: true, check: answered(owner(raw)) });
    const outcome = await settle(decide(profile, f, raw as unknown as SteamId));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(TypeError);
    expect(f.calls.denied).toEqual([]);
    expect(f.calls.devFlag).toEqual([]);
    expect(f.calls.check).toEqual([]);
  }

  test.each(
    DEV_PROFILES.flatMap((profile) =>
      notSteamIds.map(([name, raw]) => [profile, name, raw] as const),
    ),
  )('on %s a steamId of %s rejects with TypeError and the flag is never read acs-8.6', async (profile, _name, raw) => {
    await expectRefusedBeforeAnyEffect(profile, raw);
  });

  test.each(
    notSteamIds,
  )('on production a steamId of %s rejects with TypeError and Steam is never asked', async (_name, raw) => {
    await expectRefusedBeforeAnyEffect('production', raw);
  });
});

describe('an effect that rejects rejects the decision', () => {
  test.each(
    ALL_PROFILES,
  )('on %s a rejecting deny-list rejects the decision and never entitles acs-8.2', async (profile) => {
    const f = fakes({
      denied: new Error('store down'),
      flag: true,
      check: answered(owner(PLAYER)),
    });
    const outcome = await settle(decide(profile, f));
    expect(outcome.ok).toBe(false);
  });

  test.each(
    DEV_PROFILES,
  )('on %s a rejecting flag read rejects the decision acs-8.2', async (profile) => {
    const f = fakes({
      denied: false,
      flag: new Error('store down'),
      check: answered(owner(PLAYER)),
    });
    const outcome = await settle(decide(profile, f));
    expect(outcome.ok).toBe(false);
  });

  test('on production a rejecting ownership check rejects the decision acs-8.2', async () => {
    const f = fakes({ denied: false, flag: true, check: new Error('client bug') });
    const outcome = await settle(decide('production', f));
    expect(outcome.ok).toBe(false);
  });
});

describe('the profile', () => {
  test.each([
    ['undefined', undefined],
    ['production with a trailing space', 'production '],
    ['an unknown profile', 'staging'],
    ['a capitalised profile', 'Production'],
    ['an empty string', ''],
  ])('%s throws TypeError when the source is made, never falling into the dev branch acs-8.6', (_name, profile) => {
    const f = fakes({ denied: false, flag: true, check: answered(owner(PLAYER)) });
    expect(() =>
      steamEntitlementSource({
        profile: profile as unknown as Profile,
        denied: f.denied,
        devFlag: f.devFlag,
        checkAppOwnership: f.checkAppOwnership,
      }),
    ).toThrow(TypeError);
    expect(f.calls.denied).toEqual([]);
    expect(f.calls.devFlag).toEqual([]);
  });
});
