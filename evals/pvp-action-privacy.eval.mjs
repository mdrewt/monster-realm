// pvp-action-privacy eval (M16c, ADR-0109):
// Verifies the must-never-leak invariant for `battle_action` at BOTH the server
// schema boundary and the client subscription boundary.  A leaked pending pick
// is a competitively decisive exploit (opponent adapts their choice, ADR-0015).
//
// Cross-language criteria (two layers):
//
//   SCHEMA_PRIVATE  — schema.rs `battle_action` table declaration has NO `public`
//                     keyword (server-side enforcement).
//   CLIENT_NO_SELECT — connection.ts must NOT subscribe to `battle_action` via a
//                      SELECT query — specifically `FROM battle_action` must be absent.
//   CLIENT_NO_LISTENER — connection.ts must NOT register an onInsert/onUpdate/onDelete
//                        listener on `db.battle_action` (any `battle_action` table hook).
//   CLIENT_HAS_WARNING — connection.ts must contain the explicit MUST NEVER warning
//                        comment, proving the developer consciously excluded it.
//
// Proof-of-teeth: each checker has a bad fixture (must flag) and a good fixture
// (must not flag) before the real source is read.
//
// No new RegExp() — all patterns use literal regex literals or String.indexOf().
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------

function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------------------
// Criterion: SCHEMA_PRIVATE
// The `battle_action` table declaration in schema.rs must NOT have `public`.
// bad fixture: `#[spacetimedb::table(name = battle_action, public)]` → must flag.
// good fixture: `#[spacetimedb::table(name = battle_action)]` → must not flag.
// ---------------------------------------------------------------------------

function battleActionIsPublic(schemaSrc) {
  const src = stripRustComments(schemaSrc);
  const idx = src.indexOf('name = battle_action');
  if (idx === -1) return null; // not found
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  const lineEnd = src.indexOf('\n', idx);
  const decl = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
  return /\bpublic\b/.test(decl);
}

// ---------------------------------------------------------------------------
// Criterion: CLIENT_NO_SELECT
// connection.ts must not contain a SELECT query that subscribes to battle_action.
// bad fixture: contains `FROM battle_action` → must flag.
// good fixture: does not → must not flag.
// ---------------------------------------------------------------------------

function clientSubscribesToBattleAction(connSrc) {
  return connSrc.indexOf('FROM battle_action') !== -1;
}

// ---------------------------------------------------------------------------
// Criterion: CLIENT_NO_LISTENER
// connection.ts must not register table event listeners on db.battle_action.
// bad fixture: contains `db.battle_action.onInsert` → must flag.
// good fixture: no such reference → must not flag.
// ---------------------------------------------------------------------------

function clientListensToBattleAction(connSrc) {
  return connSrc.indexOf('db.battle_action') !== -1;
}

// ---------------------------------------------------------------------------
// Criterion: CLIENT_HAS_WARNING
// connection.ts must contain a warning comment documenting that battle_action is
// PRIVATE and must never be subscribed.  This proves intentional non-subscription,
// not accidental omission.
// bad fixture: no such comment → must flag.
// good fixture: comment present → must not flag.
// ---------------------------------------------------------------------------

function clientHasPrivacyWarning(connSrc) {
  // Check for the deliberate exclusion comment. Accept either the exact phrase
  // "MUST NEVER be subscribed" or "battle_action is PRIVATE".
  return (
    connSrc.indexOf('MUST NEVER be subscribed') !== -1 ||
    connSrc.indexOf('battle_action is PRIVATE') !== -1
  );
}

// ---------------------------------------------------------------------------
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'pvp-action-privacy (M16c, ADR-0109/ADR-0015: battle_action private in schema + never subscribed in client)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: bad fixtures must flag; good fixtures must not flag
  // -------------------------------------------------------------------------

  // SCHEMA_PRIVATE teeth
  const badSchema =
    '#[spacetimedb::table(name = battle_action, public)] pub struct BattleAction {}';
  if (battleActionIsPublic(badSchema) !== true) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: battleActionIsPublic should return true for bad fixture with `public`',
    };
  }
  const goodSchema = '#[spacetimedb::table(name = battle_action)] pub struct BattleAction {}';
  if (battleActionIsPublic(goodSchema) !== false) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: battleActionIsPublic should return false for good fixture without `public`',
    };
  }

  // CLIENT_NO_SELECT teeth
  const badSelect =
    "conn.subscribe(['SELECT * FROM battle_action', 'SELECT * FROM battle_challenge'])";
  if (!clientSubscribesToBattleAction(badSelect)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: clientSubscribesToBattleAction should detect `FROM battle_action` in bad fixture',
    };
  }
  const goodSelect = "conn.subscribe(['SELECT * FROM battle_challenge'])";
  if (clientSubscribesToBattleAction(goodSelect)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: clientSubscribesToBattleAction should NOT flag good fixture without battle_action',
    };
  }

  // CLIENT_NO_LISTENER teeth
  const badListener = 'conn.db.battle_action.onInsert((_ctx, row) => store.upsert(row));';
  if (!clientListensToBattleAction(badListener)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: clientListensToBattleAction should detect `db.battle_action` in bad fixture',
    };
  }
  const goodListener = 'conn.db.battle_challenge.onInsert((_ctx, row) => store.upsert(row));';
  if (clientListensToBattleAction(goodListener)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: clientListensToBattleAction should NOT flag good fixture without battle_action',
    };
  }

  // CLIENT_HAS_WARNING teeth
  const badWarning = '// subscribe to battle_challenge for incoming PvP challenges';
  if (clientHasPrivacyWarning(badWarning)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: clientHasPrivacyWarning should NOT pass fixture without the MUST NEVER warning',
    };
  }
  const goodWarning =
    '// battle_action is PRIVATE (ADR-0015 must-never-leak) and MUST NEVER be subscribed here.';
  if (!clientHasPrivacyWarning(goodWarning)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: clientHasPrivacyWarning should detect the warning comment in good fixture',
    };
  }

  // -------------------------------------------------------------------------
  // Read actual source files
  // -------------------------------------------------------------------------
  let schemaSrc, connSrc;
  try {
    schemaSrc = readFileSync('server-module/src/schema.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/schema.rs not found' };
  }
  try {
    connSrc = readFileSync('client/src/net/connection.ts', 'utf8');
  } catch {
    return { name, pass: false, detail: 'client/src/net/connection.ts not found' };
  }

  const failures = [];

  // SCHEMA_PRIVATE: battle_action must NOT be public.
  const publicResult = battleActionIsPublic(schemaSrc);
  if (publicResult === null) {
    failures.push(
      'SCHEMA_PRIVATE: `name = battle_action` declaration not found in schema.rs — ' +
        'BattleAction table must be declared there (ADR-0056)',
    );
  } else if (publicResult === true) {
    failures.push(
      'SCHEMA_PRIVATE (ADR-0015/ADR-0109): `battle_action` table in schema.rs has `public` ' +
        'keyword — this is a must-never-leak table; removing `public` is required to prevent ' +
        'clients from subscribing to pending picks (a competitively decisive exploit)',
    );
  }

  // CLIENT_NO_SELECT: no FROM battle_action query in connection.ts.
  if (clientSubscribesToBattleAction(connSrc)) {
    failures.push(
      'CLIENT_NO_SELECT (ADR-0015/ADR-0109): connection.ts contains `FROM battle_action` — ' +
        'the client is subscribing to the private battle_action table, leaking pending picks ' +
        'to each player before the turn resolves (must-never-leak violation)',
    );
  }

  // CLIENT_NO_LISTENER: no db.battle_action table listener in connection.ts.
  if (clientListensToBattleAction(connSrc)) {
    failures.push(
      'CLIENT_NO_LISTENER (ADR-0015/ADR-0109): connection.ts registers a listener on ' +
        '`db.battle_action` — the client is handling rows from the private battle_action table ' +
        "This leaks the opponent's pending pick (must-never-leak violation)",
    );
  }

  // CLIENT_HAS_WARNING: explicit exclusion comment must be present.
  if (!clientHasPrivacyWarning(connSrc)) {
    failures.push(
      'CLIENT_HAS_WARNING: connection.ts does not contain the `MUST NEVER be subscribed` or ' +
        '`battle_action is PRIVATE` warning comment — the intentional non-subscription is not ' +
        'documented; a future copy-paste of the battle_challenge subscription block could ' +
        'accidentally include battle_action',
    );
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'all 4 battle_action privacy criteria met: schema PRIVATE, client no SELECT, ' +
      'client no listener, client has MUST NEVER warning (ADR-0015, ADR-0109)',
  };
}
