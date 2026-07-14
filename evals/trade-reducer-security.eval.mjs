// trade-reducer-security eval (M15c, ADR-0108):
// Verifies security invariants for the four trading reducers and the disconnect
// cleanup hook.  Every criterion is tested with a proof-of-teeth bad fixture
// (must flag) and a good fixture (must pass) before the real source is checked.
//
// Criteria:
//   TR-19 MONSTER_CARD_NO_GENES  — MonsterCard struct has no iv_/ev_/nature_ fields
//   TR-18 DISCONNECT_HOOK        — on_disconnect calls cancel_trades_on_disconnect
//   PROPOSE_VALIDATE             — propose_trade delegates to validate_proposal
//   PROPOSE_COUNTERPARTY_JOIN    — propose_trade gates on counterparty being joined
//   RESPOND_ROLE                 — respond_trade checks offer.counterparty != me
//   RESPOND_STATUS               — respond_trade checks Pending status
//   CONFIRM_ROLE                 — confirm_trade checks offer.initiator != me
//   CONFIRM_REREAD               — confirm_trade calls build_swap_plan (live re-read)
//   CONFIRM_DELETE               — confirm_trade deletes the trade_offer row
//   CANCEL_PARTY_CHECK           — cancel_trade accepts BOTH initiator and counterparty
//   TRADE_OFFER_PUBLIC           — trade_offer table is public in schema.rs
//
// No new RegExp() — all patterns are literal regex literals.
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------

function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Extract a named function's body (between outer braces), or null if missing.
 * Searches for both `pub fn <name>(` and `fn <name>(`.
 */
function extractFunctionBody(rawSrc, fnName) {
  const src = stripRustComments(rawSrc);
  let idx = src.indexOf(`pub fn ${fnName}(`);
  if (idx === -1) idx = src.indexOf(`fn ${fnName}(`);
  if (idx === -1) return null;
  let i = idx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;
  let depth = 1;
  const start = i + 1;
  i++;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

// ---------------------------------------------------------------------------
// Criterion: MONSTER_CARD_NO_GENES (TR-19)
// The MonsterCard struct in game-core must NOT contain iv_*/ev_*/nature_* fields.
// bad fixture: a struct containing an iv_ field → must flag.
// good fixture: a struct with only the 6 public fields → must not flag.
// ---------------------------------------------------------------------------
function hasGeneField(structSrc) {
  const code = stripRustComments(structSrc);
  return /\biv_/.test(code) || /\bev_/.test(code) || /\bnature_kind\b/.test(code);
}

function countMonsterCardFields(src) {
  const code = stripRustComments(src);
  // Find MonsterCard struct body.
  const idx = code.indexOf('struct MonsterCard');
  if (idx === -1) return -1;
  const braceOpen = code.indexOf('{', idx);
  if (braceOpen === -1) return -1;
  let depth = 1;
  let i = braceOpen + 1;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }
  const body = code.slice(braceOpen + 1, i - 1);
  // Count `pub <fieldname>:` lines.
  const fields = body.match(/\bpub\s+\w+\s*:/g);
  return fields ? fields.length : 0;
}

// ---------------------------------------------------------------------------
// Criterion: DISCONNECT_HOOK (TR-18)
// lib.rs on_disconnect body must call cancel_trades_on_disconnect.
// bad fixture: body without that call → must flag.
// good fixture: body with call → must not flag.
// ---------------------------------------------------------------------------
function hasDisconnectHook(onDisconnectBody) {
  return /cancel_trades_on_disconnect/.test(onDisconnectBody);
}

// ---------------------------------------------------------------------------
// Criterion: PROPOSE_VALIDATE
// propose_trade body must call validate_proposal (game-core pure rules).
// bad fixture: body without the call → must flag.
// good fixture: body with call → must not flag.
// ---------------------------------------------------------------------------
function hasValidateProposal(body) {
  return /validate_proposal/.test(body);
}

// ---------------------------------------------------------------------------
// Criterion: PROPOSE_COUNTERPARTY_JOIN
// propose_trade must look up counterparty in ctx.db.player() to reject phantom DoS.
// The code uses multi-line chaining: `.player()` then `.identity()` then
// `.find(counterparty)` — these appear on separate lines in the source.
// We check for the final `.find(counterparty` call which uniquely identifies
// a player-table lookup keyed on the counterparty identity argument.
// bad fixture: body without the lookup → must flag.
// good fixture: body with lookup → must not flag.
// ---------------------------------------------------------------------------
function hasCounterpartyJoinCheck(body) {
  const code = stripRustComments(body);
  // The distinctive end of the join chain: .find(counterparty) — unambiguous
  // because the only time we .find(counterparty) in propose_trade is the join check.
  // Checking .find(counterparty) alone is sufficient; player() is also present in
  // the self-join lookup, so adding &&/player()/ would not add discriminatory power.
  return /\.find\s*\(\s*counterparty\s*\)/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: RESPOND_ROLE (TR-13/14)
// respond_trade body must guard on offer.counterparty != me.
// bad fixture: body without the check → must flag.
// good fixture: body with check → must not flag.
// ---------------------------------------------------------------------------
function hasRespondRoleCheck(body) {
  const code = stripRustComments(body);
  // Accept any comparison of offer.counterparty with me/ctx.sender.
  return (
    /offer\.counterparty\s*!=\s*me\b/.test(code) ||
    /me\s*!=\s*offer\.counterparty/.test(code) ||
    /offer\.counterparty\s*!=\s*ctx\.sender/.test(code)
  );
}

// ---------------------------------------------------------------------------
// Criterion: RESPOND_STATUS (TR-13/14)
// respond_trade body must check offer.status against TradeStatus::Pending.
// bad fixture: body without the status check → must flag.
// good fixture: body with check → must not flag.
// ---------------------------------------------------------------------------
function hasRespondStatusCheck(body) {
  const code = stripRustComments(body);
  return /TradeStatus::Pending/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: CONFIRM_ROLE (TR-15)
// confirm_trade body must guard on offer.initiator != me.
// bad fixture: body without the check → must flag.
// good fixture: body with check → must not flag.
// ---------------------------------------------------------------------------
function hasConfirmRoleCheck(body) {
  const code = stripRustComments(body);
  return (
    /offer\.initiator\s*!=\s*me\b/.test(code) ||
    /me\s*!=\s*offer\.initiator/.test(code) ||
    /offer\.initiator\s*!=\s*ctx\.sender/.test(code)
  );
}

// ---------------------------------------------------------------------------
// Criterion: CONFIRM_STATUS (TR-15)
// confirm_trade body must check offer.status == ConfirmedByCounterparty.
// bad fixture: body without the status check → must flag.
// good fixture: body with check → must not flag.
// ---------------------------------------------------------------------------
function hasConfirmStatusCheck(body) {
  const code = stripRustComments(body);
  return /TradeStatus::ConfirmedByCounterparty/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: CONFIRM_REREAD (TR-15)
// confirm_trade must call build_swap_plan (which validates live ownership).
// bad fixture: body without build_swap_plan → must flag.
// good fixture: body with build_swap_plan → must not flag.
// ---------------------------------------------------------------------------
function hasConfirmReread(body) {
  return /build_swap_plan/.test(body);
}

// ---------------------------------------------------------------------------
// Criterion: CONFIRM_DELETE (TR-16 / D5)
// confirm_trade must delete the trade_offer row at the end (terminal GC).
// The pattern is `trade_id().delete(trade_id)` or `.trade_id().delete(`.
// bad fixture: body without delete call → must flag.
// good fixture: body with delete call → must not flag.
// ---------------------------------------------------------------------------
function hasConfirmDelete(body) {
  const code = stripRustComments(body);
  return /trade_id\(\)\.delete\s*\(/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: CANCEL_PARTY_CHECK (TR-17)
// cancel_trade must check BOTH initiator and counterparty (either may cancel).
// The check should use `offer.initiator != me && offer.counterparty != me`.
// bad fixture: only checks initiator → must flag.
// good fixture: checks both with AND logic → must not flag.
// ---------------------------------------------------------------------------
function hasCancelPartyCheck(body) {
  const code = stripRustComments(body);
  // Require BOTH initiator and counterparty inequality checks to appear inside an `if`
  // condition (directly after the `if` keyword). `[^{]*?` prevents matching across a
  // block-open brace, so both must be in the SAME `if` condition — not split across
  // nested ifs or macro arguments where the expressions appear but no gate is present.
  const initiatorFirst =
    /if\s+(?:offer\.initiator\s*!=\s*me|me\s*!=\s*offer\.initiator)[^{]*?(?:offer\.counterparty\s*!=\s*me|me\s*!=\s*offer\.counterparty)/.test(
      code,
    );
  const counterpartyFirst =
    /if\s+(?:offer\.counterparty\s*!=\s*me|me\s*!=\s*offer\.counterparty)[^{]*?(?:offer\.initiator\s*!=\s*me|me\s*!=\s*offer\.initiator)/.test(
      code,
    );
  return initiatorFirst || counterpartyFirst;
}

// ---------------------------------------------------------------------------
// Criterion: TRADE_OFFER_PUBLIC
// The trade_offer table in schema.rs must have the `public` attribute.
// (Counter to player_wallet — this one SHOULD be public: both parties subscribe.)
// bad fixture: table without public → must flag.
// good fixture: table with public → must not flag.
// ---------------------------------------------------------------------------
function tradeOfferTableIsPublic(schemaSrc) {
  const code = stripRustComments(schemaSrc);
  const idx = code.indexOf('name = trade_offer');
  if (idx === -1) return null;
  // Find the enclosing attribute block.
  const attrStart = code.lastIndexOf('#[', idx);
  const attrEnd = code.indexOf(']', idx);
  if (attrStart === -1 || attrEnd === -1) return false;
  const attr = code.slice(attrStart, attrEnd + 1);
  return /\bpublic\b/.test(attr);
}

// ---------------------------------------------------------------------------
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'trade-reducer-security (M15c, ADR-0108: TR-19 no-genes, TR-18 disconnect, TR-13–17 role+status+reread+delete)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: each checker must flag its bad fixture and pass its good.
  // -------------------------------------------------------------------------

  // TR-19: MONSTER_CARD_NO_GENES
  const badGeneStruct =
    'pub struct MonsterCard { pub monster_id: u64, pub iv_hp: u8, pub ev_hp: u8, pub nature_kind: u8 }';
  if (!hasGeneField(badGeneStruct)) {
    return { name, pass: false, detail: 'TEETH FAILED: hasGeneField did not flag iv_hp fixture' };
  }
  const goodGeneStruct =
    'pub struct MonsterCard { pub monster_id: u64, pub species_id: u32, pub nickname: String, pub level: u8, pub current_hp: u16, pub stat_hp: u16 }';
  if (hasGeneField(goodGeneStruct)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasGeneField falsely flagged clean MonsterCard fixture',
    };
  }

  // TR-18: DISCONNECT_HOOK
  const badDisconnect = 'fn on_disconnect(ctx) { battle::cancel_battles_on_disconnect(ctx, me); }';
  if (hasDisconnectHook(badDisconnect)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasDisconnectHook should NOT pass fixture missing cancel_trades_on_disconnect',
    };
  }
  const goodDisconnect =
    'fn on_disconnect(ctx) { battle::cancel_battles_on_disconnect(ctx, me); trading::cancel_trades_on_disconnect(ctx, me); }';
  if (!hasDisconnectHook(goodDisconnect)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasDisconnectHook did not detect cancel_trades_on_disconnect',
    };
  }

  // PROPOSE_VALIDATE
  const badPropose =
    'fn propose_trade(ctx, counterparty) -> Result<(), String> { ctx.db.trade_offer().insert(offer); Ok(()) }';
  if (hasValidateProposal(badPropose)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasValidateProposal should NOT pass fixture without validate_proposal',
    };
  }
  const goodPropose =
    'fn propose_trade(ctx, counterparty) -> Result<(), String> { validate_proposal(false, false, me == counterparty, side_a, side_b)?; Ok(()) }';
  if (!hasValidateProposal(goodPropose)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasValidateProposal did not detect validate_proposal call',
    };
  }

  // PROPOSE_COUNTERPARTY_JOIN
  const badCPJoin =
    'fn propose_trade(ctx, counterparty) { let me = ctx.sender; validate_proposal(false, false, false, side_a, side_b)?; }';
  if (hasCounterpartyJoinCheck(badCPJoin)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasCounterpartyJoinCheck should NOT pass fixture without joined-player lookup',
    };
  }
  const goodCPJoin =
    'fn propose_trade(ctx, counterparty) { ctx.db.player().identity().find(counterparty).ok_or_else(|| "counterparty not joined")?; }';
  if (!hasCounterpartyJoinCheck(goodCPJoin)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasCounterpartyJoinCheck did not detect counterparty join guard',
    };
  }

  // RESPOND_ROLE
  const badRespond =
    'fn respond_trade(ctx, trade_id, accepted) { let offer = ctx.db.trade_offer().find(trade_id).unwrap(); ctx.db.trade_offer().delete(trade_id); Ok(()) }';
  if (hasRespondRoleCheck(badRespond)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasRespondRoleCheck should NOT pass fixture without counterparty check',
    };
  }
  const goodRespond =
    'fn respond_trade(ctx, trade_id, accepted) { let offer = ...; if offer.counterparty != me { return Err("not cp"); } Ok(()) }';
  if (!hasRespondRoleCheck(goodRespond)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasRespondRoleCheck did not detect offer.counterparty != me',
    };
  }

  // RESPOND_STATUS
  const badRespondStatus =
    'fn respond_trade(ctx, trade_id, accepted) { if offer.counterparty != me { return Err("not cp"); } Ok(()) }';
  if (hasRespondStatusCheck(badRespondStatus)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasRespondStatusCheck should NOT pass fixture without status check',
    };
  }
  const goodRespondStatus =
    'fn respond_trade(ctx, trade_id, accepted) { if offer.status != TradeStatus::Pending { return Err("not pending"); } Ok(()) }';
  if (!hasRespondStatusCheck(goodRespondStatus)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasRespondStatusCheck did not detect TradeStatus::Pending check',
    };
  }

  // CONFIRM_ROLE
  const badConfirmRole =
    'fn confirm_trade(ctx, trade_id) { let offer = ctx.db.trade_offer().find(trade_id).unwrap(); Ok(()) }';
  if (hasConfirmRoleCheck(badConfirmRole)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasConfirmRoleCheck should NOT pass fixture without initiator check',
    };
  }
  const goodConfirmRole =
    'fn confirm_trade(ctx, trade_id) { let me = ctx.sender; if offer.initiator != me { return Err("not initiator"); } Ok(()) }';
  if (!hasConfirmRoleCheck(goodConfirmRole)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasConfirmRoleCheck did not detect offer.initiator != me',
    };
  }

  // CONFIRM_STATUS
  const badConfirmStatus =
    'fn confirm_trade(ctx, trade_id) { if offer.initiator != me { return Err(""); } build_swap_plan(); Ok(()) }';
  if (hasConfirmStatusCheck(badConfirmStatus)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasConfirmStatusCheck should NOT pass fixture without ConfirmedByCounterparty check',
    };
  }
  const goodConfirmStatus =
    'fn confirm_trade(ctx, trade_id) { if offer.status != TradeStatus::ConfirmedByCounterparty { return Err("not confirmed"); } Ok(()) }';
  if (!hasConfirmStatusCheck(goodConfirmStatus)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasConfirmStatusCheck did not detect TradeStatus::ConfirmedByCounterparty',
    };
  }

  // CONFIRM_REREAD
  const badConfirmReread =
    'fn confirm_trade(ctx, trade_id) { if offer.initiator != me { return Err(""); } ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) }';
  if (hasConfirmReread(badConfirmReread)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasConfirmReread should NOT pass fixture without build_swap_plan',
    };
  }
  const goodConfirmReread =
    'fn confirm_trade(ctx, trade_id) { let plan = build_swap_plan(&i_live, &c_live, ...).map_err(|e| e.to_string())?; Ok(()) }';
  if (!hasConfirmReread(goodConfirmReread)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasConfirmReread did not detect build_swap_plan call',
    };
  }

  // CONFIRM_DELETE
  const badConfirmDelete =
    'fn confirm_trade(ctx, trade_id) { let plan = build_swap_plan(...); Ok(()) }';
  if (hasConfirmDelete(badConfirmDelete)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasConfirmDelete should NOT pass fixture without row deletion',
    };
  }
  const goodConfirmDelete =
    'fn confirm_trade(ctx, trade_id) { ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) }';
  if (!hasConfirmDelete(goodConfirmDelete)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasConfirmDelete did not detect trade_id().delete(',
    };
  }

  // CANCEL_PARTY_CHECK
  const badCancelParty =
    'fn cancel_trade(ctx, trade_id) { if offer.initiator != me { return Err("not initiator"); } ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) }';
  if (hasCancelPartyCheck(badCancelParty)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasCancelPartyCheck should NOT pass fixture that only checks initiator (not counterparty)',
    };
  }
  const goodCancelParty =
    'fn cancel_trade(ctx, trade_id) { if offer.initiator != me && offer.counterparty != me { return Err("not a party"); } ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) }';
  if (!hasCancelPartyCheck(goodCancelParty)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasCancelPartyCheck did not detect initiator+counterparty party check',
    };
  }
  // RT-SEC-01: hasCancelPartyCheck must NOT pass a fixture where both expressions appear
  // only inside a log/format macro and no real authorization guard is present.
  // A broken cancel_trade that logs both field comparisons without gating on them would
  // satisfy the three-condition regex (offer.initiator, offer.counterparty, sequential !=)
  // without actually enforcing the invariant.
  const logBypassCancelParty =
    'fn cancel_trade(ctx, trade_id) { log::warn!("{} {}", offer.initiator != me, offer.counterparty != me); ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) }';
  if (hasCancelPartyCheck(logBypassCancelParty)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (RT-SEC-01): hasCancelPartyCheck passed a fixture where both expressions appear only in a log macro — authorization guard is absent but checker returned true',
    };
  }

  // TRADE_OFFER_PUBLIC
  const badPublicSchema = '#[spacetimedb::table(name = trade_offer)] struct TradeOffer {}';
  if (tradeOfferTableIsPublic(badPublicSchema) !== false) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: tradeOfferTableIsPublic should return false for table without public',
    };
  }
  const goodPublicSchema = '#[spacetimedb::table(name = trade_offer, public)] struct TradeOffer {}';
  if (tradeOfferTableIsPublic(goodPublicSchema) !== true) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: tradeOfferTableIsPublic should return true for table with public',
    };
  }

  // -------------------------------------------------------------------------
  // Read actual source files
  // -------------------------------------------------------------------------
  let typesSrc, libSrc, tradingSrc, schemaSrc;
  try {
    typesSrc = readFileSync('game-core/src/trading/types.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'game-core/src/trading/types.rs not found' };
  }
  try {
    libSrc = readFileSync('server-module/src/lib.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/lib.rs not found' };
  }
  try {
    tradingSrc = readFileSync('server-module/src/trading.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/trading.rs not found' };
  }
  try {
    schemaSrc = readFileSync('server-module/src/schema.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/schema.rs not found' };
  }

  const failures = [];

  // TR-19: MonsterCard struct must have no gene fields.
  if (hasGeneField(typesSrc)) {
    failures.push(
      'MONSTER_CARD_NO_GENES (TR-19): MonsterCard struct contains iv_/ev_/nature_ field — violates ADR-0015 stakes',
    );
  }
  const fieldCount = countMonsterCardFields(typesSrc);
  if (fieldCount === -1) {
    failures.push(
      'MONSTER_CARD_NO_GENES (TR-19): MonsterCard struct not found in game-core/src/trading/types.rs',
    );
  } else if (fieldCount !== 6) {
    failures.push(
      `MONSTER_CARD_NO_GENES (TR-19): MonsterCard has ${fieldCount} fields, expected exactly 6 (monster_id, species_id, nickname, level, current_hp, stat_hp) — extra field may be a gene leak`,
    );
  }

  // TR-18: on_disconnect calls cancel_trades_on_disconnect.
  const onDisconnectBody = extractFunctionBody(libSrc, 'on_disconnect');
  if (!onDisconnectBody) {
    failures.push(
      'DISCONNECT_HOOK (TR-18): on_disconnect function not found in server-module/src/lib.rs',
    );
  } else if (!hasDisconnectHook(onDisconnectBody)) {
    failures.push(
      'DISCONNECT_HOOK (TR-18): on_disconnect does not call cancel_trades_on_disconnect — active offers survive player disconnect, violating TR-18 escrow release',
    );
  }

  // PROPOSE_VALIDATE: propose_trade delegates to validate_proposal.
  const proposeBody = extractFunctionBody(tradingSrc, 'propose_trade');
  if (!proposeBody) {
    failures.push(
      'PROPOSE_VALIDATE: propose_trade function not found in server-module/src/trading.rs',
    );
  } else {
    if (!hasValidateProposal(proposeBody)) {
      failures.push(
        'PROPOSE_VALIDATE: propose_trade does not call validate_proposal — game-core rule layer bypassed',
      );
    }
    if (!hasCounterpartyJoinCheck(proposeBody)) {
      failures.push(
        'PROPOSE_COUNTERPARTY_JOIN: propose_trade does not verify counterparty is a joined player — allows phantom-offer DoS locking any identity',
      );
    }
  }

  // RESPOND_ROLE + RESPOND_STATUS: respond_trade checks.
  const respondBody = extractFunctionBody(tradingSrc, 'respond_trade');
  if (!respondBody) {
    failures.push('RESPOND_ROLE: respond_trade function not found in server-module/src/trading.rs');
  } else {
    if (!hasRespondRoleCheck(respondBody)) {
      failures.push(
        'RESPOND_ROLE (TR-13/14): respond_trade does not check offer.counterparty != me — any caller can accept/reject any trade',
      );
    }
    if (!hasRespondStatusCheck(respondBody)) {
      failures.push(
        'RESPOND_STATUS (TR-13/14): respond_trade does not check TradeStatus::Pending — can accept an already-confirmed offer',
      );
    }
  }

  // CONFIRM_ROLE + CONFIRM_REREAD + CONFIRM_DELETE: confirm_trade checks.
  const confirmBody = extractFunctionBody(tradingSrc, 'confirm_trade');
  if (!confirmBody) {
    failures.push('CONFIRM_ROLE: confirm_trade function not found in server-module/src/trading.rs');
  } else {
    if (!hasConfirmRoleCheck(confirmBody)) {
      failures.push(
        'CONFIRM_ROLE (TR-15): confirm_trade does not check offer.initiator != me — any caller can finalize a trade',
      );
    }
    if (!hasConfirmStatusCheck(confirmBody)) {
      failures.push(
        'CONFIRM_STATUS (TR-15): confirm_trade does not check TradeStatus::ConfirmedByCounterparty — can finalize a Pending offer before counterparty accepts',
      );
    }
    if (!hasConfirmReread(confirmBody)) {
      failures.push(
        'CONFIRM_REREAD (TR-15): confirm_trade does not call build_swap_plan — live ownership not re-verified, dupe/theft vector if monster transferred between propose and confirm',
      );
    }
    if (!hasConfirmDelete(confirmBody)) {
      failures.push(
        'CONFIRM_DELETE (TR-16/D5): confirm_trade does not delete the trade_offer row — orphan escrow row permanently locks offered assets',
      );
    }
  }

  // CANCEL_PARTY_CHECK: cancel_trade checks both initiator and counterparty.
  const cancelBody = extractFunctionBody(tradingSrc, 'cancel_trade');
  if (!cancelBody) {
    failures.push(
      'CANCEL_PARTY_CHECK: cancel_trade function not found in server-module/src/trading.rs',
    );
  } else if (!hasCancelPartyCheck(cancelBody)) {
    failures.push(
      'CANCEL_PARTY_CHECK (TR-17): cancel_trade does not check BOTH initiator AND counterparty — only initiator or only counterparty can cancel, violating TR-17',
    );
  }

  // TRADE_OFFER_PUBLIC: trade_offer table must be public.
  const isPublic = tradeOfferTableIsPublic(schemaSrc);
  if (isPublic === null) {
    failures.push('TRADE_OFFER_PUBLIC: trade_offer table not found in server-module/src/schema.rs');
  } else if (!isPublic) {
    failures.push(
      'TRADE_OFFER_PUBLIC: trade_offer table is missing `public` — counterparty cannot subscribe to their own offer (ADR-0106)',
    );
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'all 12 trade-reducer-security criteria met (TR-19 no-genes, TR-18 disconnect, propose-validate, counterparty-join, respond role+status, confirm role+status+reread+delete, cancel party-check, trade_offer public)',
  };
}
