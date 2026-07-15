// trade-reducer-security eval (M15c, ADR-0108; evolved M16.5f, ADR-0117):
// Verifies security invariants for the four trading reducers and the disconnect
// cleanup hook.  Every criterion is tested with a proof-of-teeth bad fixture
// (must flag) and a good fixture (must pass) before the real source is checked.
//
// Criteria:
//   TR-19 MONSTER_CARD_NO_GENES  — MonsterCard struct has no iv_/ev_/nature_ fields
//   TR-18 DISCONNECT_HOOK        — on_disconnect calls cancel_trades_on_disconnect
//   PROPOSE_VALIDATE             — propose_trade delegates to validate_proposal
//   PROPOSE_COUNTERPARTY_JOIN    — propose_trade gates on counterparty being joined
//   RESPOND_AUTHORIZE            — respond_trade delegates to authorize_respond with ? propagation
//   CONFIRM_AUTHORIZE            — confirm_trade delegates to authorize_confirm with ? propagation
//   AUTHORIZE_RULES              — game-core authorize_respond/authorize_confirm contain status tokens
//   CONFIRM_REREAD               — confirm_trade calls build_swap_plan (live re-read)
//   CONFIRM_DELETE               — confirm_trade deletes the trade_offer row
//   CANCEL_PARTY_CHECK           — cancel_trade accepts BOTH initiator and counterparty
//   TRADE_OFFER_PUBLIC           — trade_offer table is public in schema.rs
//   REAPER_ARMED                 — propose_trade arms reaper AFTER offer insert
//   REAPER_SCHEDULER_GUARD       — trade_offer_reaper guards ctx.sender != ctx.identity()
//   REAPER_STALE_CHECK           — trade_offer_reaper calls is_offer_stale
//   REAPER_DELETES               — trade_offer_reaper deletes the offer row
//   REAPER_DISARM                — disarm_trade_reaper called at all four deletion sites
//
// No new RegExp() — all patterns are literal regex literals or indexOf checks.
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
// Criterion: RESPOND_AUTHORIZE (replaces RESPOND_ROLE + RESPOND_STATUS, m16.5f)
// respond_trade body must:
//   (i)  call authorize_respond
//   (ii) propagate the Result with `)?` within a 300-char window after the call
//   (iii) reference offer.counterparty in that same window (correct field)
//
// The inline `offer.counterparty != me` / `TradeStatus::Pending` checks disappear
// after the delegation refactor — we pin the delegation shape instead.
//
// bad-missing-call fixture:   no authorize_respond call → must flag.
// bad-dropped-result fixture: call present, no )? in window → must flag.
// bad-wrong-field fixture:    call references offer.initiator but not offer.counterparty → must flag.
// good-delegating fixture:    call + )? + offer.counterparty all in window → must pass.
// ---------------------------------------------------------------------------
function checkRespondAuthorize(body) {
  const code = stripRustComments(body);
  const callIdx = code.indexOf('authorize_respond');
  if (callIdx === -1) return { ok: false, reason: 'no authorize_respond call' };
  const window = code.slice(callIdx, callIdx + 300);
  if (window.indexOf(')?') === -1)
    return { ok: false, reason: 'Result not propagated (no )? in window)' };
  if (window.indexOf('offer.counterparty') === -1)
    return {
      ok: false,
      reason: 'offer.counterparty not referenced in window (wrong-field attack)',
    };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Criterion: CONFIRM_AUTHORIZE (replaces CONFIRM_ROLE + CONFIRM_STATUS, m16.5f)
// confirm_trade body must:
//   (i)  call authorize_confirm
//   (ii) propagate the Result with `)?` within a 300-char window
//   (iii) reference offer.initiator in that window (correct field)
//
// bad-missing-call fixture:   no authorize_confirm call → must flag.
// bad-dropped-result fixture: call present, no )? in window → must flag.
// bad-wrong-field fixture:    call references offer.counterparty but not offer.initiator → must flag.
// good-delegating fixture:    call + )? + offer.initiator all in window → must pass.
// ---------------------------------------------------------------------------
function checkConfirmAuthorize(body) {
  const code = stripRustComments(body);
  const callIdx = code.indexOf('authorize_confirm');
  if (callIdx === -1) return { ok: false, reason: 'no authorize_confirm call' };
  const window = code.slice(callIdx, callIdx + 300);
  if (window.indexOf(')?') === -1)
    return { ok: false, reason: 'Result not propagated (no )? in window)' };
  if (window.indexOf('offer.initiator') === -1)
    return { ok: false, reason: 'offer.initiator not referenced in window (wrong-field attack)' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Criterion: AUTHORIZE_RULES (m16.5f)
// game-core/src/trading/rules.rs must contain the status tokens inside each
// authorize_* function body, proving the logic moved there.
//
// authorize_respond body: TradeStatus::Pending AND NotCounterparty AND NotPending
// authorize_confirm body: TradeStatus::ConfirmedByCounterparty AND NotInitiator AND NotConfirmedByCounterparty
//
// bad fixture: authorize_respond body missing status check → must flag.
// good fixture: body with all tokens → must pass.
// ---------------------------------------------------------------------------
function checkAuthorizeRules(rulesSrc) {
  const respondBody = extractFunctionBody(rulesSrc, 'authorize_respond');
  if (!respondBody) return { ok: false, reason: 'authorize_respond not found in rules.rs' };
  if (respondBody.indexOf('TradeStatus::Pending') === -1)
    return { ok: false, reason: 'authorize_respond body missing TradeStatus::Pending' };
  if (respondBody.indexOf('NotCounterparty') === -1)
    return { ok: false, reason: 'authorize_respond body missing NotCounterparty' };
  if (respondBody.indexOf('NotPending') === -1)
    return { ok: false, reason: 'authorize_respond body missing NotPending' };

  const confirmBody = extractFunctionBody(rulesSrc, 'authorize_confirm');
  if (!confirmBody) return { ok: false, reason: 'authorize_confirm not found in rules.rs' };
  if (confirmBody.indexOf('TradeStatus::ConfirmedByCounterparty') === -1)
    return {
      ok: false,
      reason: 'authorize_confirm body missing TradeStatus::ConfirmedByCounterparty',
    };
  if (confirmBody.indexOf('NotInitiator') === -1)
    return { ok: false, reason: 'authorize_confirm body missing NotInitiator' };
  if (confirmBody.indexOf('NotConfirmedByCounterparty') === -1)
    return { ok: false, reason: 'authorize_confirm body missing NotConfirmedByCounterparty' };

  return { ok: true };
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
// Criterion: REAPER_ARMED (m16.5f)
// propose_trade body: index of trade_offer().insert( < index of schedule_trade_reaper(
// Both must exist; arm call must appear AFTER the offer insert so the auto_inc
// trade_id is available.
// ---------------------------------------------------------------------------
function checkReaperArmed(proposeBody) {
  const code = stripRustComments(proposeBody);
  const insertIdx = code.indexOf('trade_offer().insert(');
  if (insertIdx === -1)
    return { ok: false, reason: 'trade_offer().insert( not found in propose_trade' };
  const armIdx = code.indexOf('schedule_trade_reaper(');
  const armIdxAlt = code.indexOf('trade_offer_reaper_schedule().insert(');
  const arm = armIdx === -1 ? armIdxAlt : armIdxAlt === -1 ? armIdx : Math.min(armIdx, armIdxAlt);
  if (arm === -1)
    return {
      ok: false,
      reason: 'no reaper arm call found in propose_trade (schedule_trade_reaper or table insert)',
    };
  if (arm <= insertIdx)
    return {
      ok: false,
      reason: `reaper arm (offset ${arm}) appears before offer insert (offset ${insertIdx})`,
    };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Criterion: REAPER_SCHEDULER_GUARD (m16.5f)
// trade_offer_reaper body must contain ctx.sender != ctx.identity()
// (scheduler-only guard: rejects any non-scheduler caller).
// ---------------------------------------------------------------------------
function checkReaperSchedulerGuard(reaperBody) {
  if (!reaperBody) return { ok: false, reason: 'trade_offer_reaper function not found' };
  const code = stripRustComments(reaperBody);
  // Accept either ordering of the comparison.
  if (code.indexOf('ctx.sender != ctx.identity()') !== -1) return { ok: true };
  if (code.indexOf('ctx.identity() != ctx.sender') !== -1) return { ok: true };
  return {
    ok: false,
    reason: 'trade_offer_reaper body missing ctx.sender != ctx.identity() guard',
  };
}

// ---------------------------------------------------------------------------
// Criterion: REAPER_STALE_CHECK (m16.5f)
// trade_offer_reaper body must call is_offer_stale.
// ---------------------------------------------------------------------------
function checkReaperStaleCheck(reaperBody) {
  if (!reaperBody) return { ok: false, reason: 'trade_offer_reaper function not found' };
  if (reaperBody.indexOf('is_offer_stale') === -1)
    return { ok: false, reason: 'trade_offer_reaper body missing is_offer_stale call' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Criterion: REAPER_DELETES (m16.5f)
// trade_offer_reaper body must delete the offer row via trade_id().delete(.
// ---------------------------------------------------------------------------
function checkReaperDeletes(reaperBody) {
  if (!reaperBody) return { ok: false, reason: 'trade_offer_reaper function not found' };
  const code = stripRustComments(reaperBody);
  if (!/trade_id\(\)\.delete\s*\(/.test(code))
    return { ok: false, reason: 'trade_offer_reaper body missing trade_id().delete( call' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Criterion: REAPER_DISARM (m16.5f)
// disarm_trade_reaper( must appear in each of the four offer-deletion function
// bodies: respond_trade, cancel_trade, confirm_trade, cancel_trades_on_disconnect.
// ---------------------------------------------------------------------------
function checkReaperDisarm(tradingSrc) {
  const missing = [];
  for (const fn of [
    'respond_trade',
    'cancel_trade',
    'confirm_trade',
    'cancel_trades_on_disconnect',
  ]) {
    const body = extractFunctionBody(tradingSrc, fn);
    if (!body) {
      missing.push(`${fn} (function not found)`);
      continue;
    }
    if (body.indexOf('disarm_trade_reaper(') === -1) {
      missing.push(fn);
    }
  }
  if (missing.length > 0)
    return { ok: false, reason: `disarm_trade_reaper missing in: ${missing.join(', ')}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'trade-reducer-security (M15c ADR-0108 + M16.5f ADR-0117: TR-19 no-genes, TR-18 disconnect, propose, respond/confirm authorize delegation, authorize_rules, reread+delete, cancel, public, reaper)';

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

  // RESPOND_AUTHORIZE: bad-missing-call fixture
  const badRespondMissingCall =
    'fn respond_trade(ctx, trade_id, accepted) { let offer = ctx.db.trade_offer().find(trade_id).unwrap(); if !accepted { ctx.db.trade_offer().trade_id().delete(trade_id); return Ok(()); } Ok(()) }';
  {
    const r = checkRespondAuthorize(badRespondMissingCall);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (RESPOND_AUTHORIZE bad-missing-call): checkRespondAuthorize passed fixture with no authorize_respond call',
      };
    }
  }
  // RESPOND_AUTHORIZE: bad-dropped-result fixture (call present, no )? in the 300-char window)
  // Note: the fixture body is deliberately short so the window does NOT contain )?
  const badRespondDropped =
    'fn respond_trade(ctx, trade_id, accepted) { let _ = authorize_respond(offer.counterparty == me, offer.status.clone()); Ok(()) }';
  {
    const r = checkRespondAuthorize(badRespondDropped);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (RESPOND_AUTHORIZE bad-dropped-result): checkRespondAuthorize passed fixture where Result is dropped (let _ = authorize_respond(...))',
      };
    }
  }
  // RESPOND_AUTHORIZE: bad-wrong-field fixture (offer.initiator used, not offer.counterparty)
  const badRespondWrongField =
    'fn respond_trade(ctx, trade_id, accepted) { authorize_respond(&offer.status, offer.initiator == me)?; Ok(()) }';
  {
    const r = checkRespondAuthorize(badRespondWrongField);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (RESPOND_AUTHORIZE bad-wrong-field): checkRespondAuthorize passed fixture using offer.initiator instead of offer.counterparty',
      };
    }
  }
  // RESPOND_AUTHORIZE: good-delegating fixture
  const goodRespondAuthorize =
    'fn respond_trade(ctx, trade_id, accepted) { authorize_respond(&offer.status, offer.counterparty == me).map_err(|e| { let msg = e.to_string(); log_reject("respond_trade", me, &msg); msg })?; Ok(()) }';
  {
    const r = checkRespondAuthorize(goodRespondAuthorize);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (RESPOND_AUTHORIZE good-delegating): checkRespondAuthorize rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // CONFIRM_AUTHORIZE: bad-missing-call fixture
  const badConfirmMissingCall =
    'fn confirm_trade(ctx, trade_id) { let offer = ctx.db.trade_offer().trade_id().find(trade_id).unwrap(); let plan = build_swap_plan(...)?; Ok(()) }';
  {
    const r = checkConfirmAuthorize(badConfirmMissingCall);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CONFIRM_AUTHORIZE bad-missing-call): checkConfirmAuthorize passed fixture with no authorize_confirm call',
      };
    }
  }
  // CONFIRM_AUTHORIZE: bad-dropped-result fixture
  const badConfirmDropped =
    'fn confirm_trade(ctx, trade_id) { let _ = authorize_confirm(offer.initiator == me, offer.status.clone()); Ok(()) }';
  {
    const r = checkConfirmAuthorize(badConfirmDropped);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CONFIRM_AUTHORIZE bad-dropped-result): checkConfirmAuthorize passed fixture where Result is dropped',
      };
    }
  }
  // CONFIRM_AUTHORIZE: bad-wrong-field fixture
  const badConfirmWrongField =
    'fn confirm_trade(ctx, trade_id) { authorize_confirm(&offer.status, offer.counterparty == me)?; Ok(()) }';
  {
    const r = checkConfirmAuthorize(badConfirmWrongField);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CONFIRM_AUTHORIZE bad-wrong-field): checkConfirmAuthorize passed fixture using offer.counterparty instead of offer.initiator',
      };
    }
  }
  // CONFIRM_AUTHORIZE: good-delegating fixture
  const goodConfirmAuthorize =
    'fn confirm_trade(ctx, trade_id) { authorize_confirm(&offer.status, offer.initiator == me).map_err(|e| { let msg = e.to_string(); log_reject("confirm_trade", me, &msg); msg })?; Ok(()) }';
  {
    const r = checkConfirmAuthorize(goodConfirmAuthorize);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (CONFIRM_AUTHORIZE good-delegating): checkConfirmAuthorize rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // AUTHORIZE_RULES: bad fixture — authorize_respond body missing status check
  const badAuthorizeRulesSrc =
    'fn authorize_respond(status: &TradeStatus, is_counterparty: bool) -> Result<(), TradeError> { if !is_counterparty { return Err(TradeError::NotCounterparty); } Ok(()) }';
  {
    const r = checkAuthorizeRules(badAuthorizeRulesSrc);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (AUTHORIZE_RULES bad): checkAuthorizeRules passed fixture where authorize_respond body has no TradeStatus::Pending check',
      };
    }
  }
  // AUTHORIZE_RULES: good fixture
  const goodAuthorizeRulesSrc =
    'fn authorize_respond(status: &TradeStatus, is_counterparty: bool) -> Result<(), TradeError> { if !is_counterparty { return Err(TradeError::NotCounterparty); } if *status != TradeStatus::Pending { return Err(TradeError::NotPending); } Ok(()) } ' +
    'fn authorize_confirm(status: &TradeStatus, is_initiator: bool) -> Result<(), TradeError> { if !is_initiator { return Err(TradeError::NotInitiator); } if *status != TradeStatus::ConfirmedByCounterparty { return Err(TradeError::NotConfirmedByCounterparty); } Ok(()) }';
  {
    const r = checkAuthorizeRules(goodAuthorizeRulesSrc);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (AUTHORIZE_RULES good): checkAuthorizeRules rejected valid fixture: ${r.reason}`,
      };
    }
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

  // REAPER_ARMED: bad-missing-arm fixture
  const badReaperMissingArm =
    'fn propose_trade(ctx) { ctx.db.trade_offer().insert(offer); Ok(()) }';
  {
    const r = checkReaperArmed(badReaperMissingArm);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (REAPER_ARMED bad-missing-arm): checkReaperArmed passed fixture with no reaper arm call',
      };
    }
  }
  // REAPER_ARMED: bad-arm-before-insert fixture
  const badReaperArmFirst =
    'fn propose_trade(ctx) { schedule_trade_reaper(ctx, 0, 0); ctx.db.trade_offer().insert(offer); Ok(()) }';
  {
    const r = checkReaperArmed(badReaperArmFirst);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (REAPER_ARMED bad-arm-before-insert): checkReaperArmed passed fixture where arm call precedes offer insert',
      };
    }
  }
  // REAPER_ARMED: good fixture
  const goodReaperArmed =
    'fn propose_trade(ctx) { let inserted = ctx.db.trade_offer().insert(offer); schedule_trade_reaper(ctx, inserted.trade_id, inserted.created_at_ms); Ok(()) }';
  {
    const r = checkReaperArmed(goodReaperArmed);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (REAPER_ARMED good): checkReaperArmed rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // REAPER_SCHEDULER_GUARD: bad fixture
  const badReaperGuard =
    'fn trade_offer_reaper(ctx, args) { let offer = ctx.db.trade_offer().trade_id().find(args.trade_id); Ok(()) }';
  {
    const r = checkReaperSchedulerGuard(badReaperGuard);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (REAPER_SCHEDULER_GUARD bad): checkReaperSchedulerGuard passed fixture without ctx.sender != ctx.identity() guard',
      };
    }
  }
  // REAPER_SCHEDULER_GUARD: good fixture
  const goodReaperGuard =
    'fn trade_offer_reaper(ctx, args) { if ctx.sender != ctx.identity() { return Err("scheduler only".to_string()); } Ok(()) }';
  {
    const r = checkReaperSchedulerGuard(goodReaperGuard);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (REAPER_SCHEDULER_GUARD good): checkReaperSchedulerGuard rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // REAPER_STALE_CHECK: bad fixture
  const badReaperStale =
    'fn trade_offer_reaper(ctx, args) { if ctx.sender != ctx.identity() { return Err(""); } ctx.db.trade_offer().trade_id().delete(args.trade_id); Ok(()) }';
  {
    const r = checkReaperStaleCheck(badReaperStale);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (REAPER_STALE_CHECK bad): checkReaperStaleCheck passed fixture without is_offer_stale call',
      };
    }
  }
  // REAPER_STALE_CHECK: good fixture
  const goodReaperStale =
    'fn trade_offer_reaper(ctx, args) { if ctx.sender != ctx.identity() { return Err(""); } let offer = ctx.db.trade_offer().trade_id().find(args.trade_id); if !is_offer_stale(offer.created_at_ms, now_ms(ctx)) { return Ok(()); } ctx.db.trade_offer().trade_id().delete(args.trade_id); Ok(()) }';
  {
    const r = checkReaperStaleCheck(goodReaperStale);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (REAPER_STALE_CHECK good): checkReaperStaleCheck rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // REAPER_DELETES: bad fixture
  const badReaperDeletes =
    'fn trade_offer_reaper(ctx, args) { if ctx.sender != ctx.identity() { return Err(""); } if !is_offer_stale(offer.created_at_ms, now_ms(ctx)) { return Ok(()); } Ok(()) }';
  {
    const r = checkReaperDeletes(badReaperDeletes);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (REAPER_DELETES bad): checkReaperDeletes passed fixture without trade_id().delete( call',
      };
    }
  }
  // REAPER_DELETES: good fixture
  const goodReaperDeletes =
    'fn trade_offer_reaper(ctx, args) { if ctx.sender != ctx.identity() { return Err(""); } if !is_offer_stale(offer.created_at_ms, now_ms(ctx)) { return Ok(()); } ctx.db.trade_offer().trade_id().delete(args.trade_id); Ok(()) }';
  {
    const r = checkReaperDeletes(goodReaperDeletes);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (REAPER_DELETES good): checkReaperDeletes rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // REAPER_DISARM: bad fixture — cancel_trade body without disarm_trade_reaper
  const badReaperDisarmSrc =
    'fn respond_trade(ctx, trade_id, accepted) { disarm_trade_reaper(ctx, trade_id); ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) } ' +
    'fn confirm_trade(ctx, trade_id) { disarm_trade_reaper(ctx, trade_id); ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) } ' +
    'fn cancel_trade(ctx, trade_id) { ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) } ' +
    'fn cancel_trades_on_disconnect(ctx, player) { disarm_trade_reaper(ctx, 0); ctx.db.trade_offer().trade_id().delete(0); }';
  {
    const r = checkReaperDisarm(badReaperDisarmSrc);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (REAPER_DISARM bad): checkReaperDisarm passed fixture where cancel_trade is missing disarm_trade_reaper',
      };
    }
  }
  // REAPER_DISARM: good fixture — all four sites have disarm call
  const goodReaperDisarmSrc =
    'fn respond_trade(ctx, trade_id, accepted) { disarm_trade_reaper(ctx, trade_id); ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) } ' +
    'fn confirm_trade(ctx, trade_id) { disarm_trade_reaper(ctx, trade_id); ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) } ' +
    'fn cancel_trade(ctx, trade_id) { disarm_trade_reaper(ctx, trade_id); ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) } ' +
    'fn cancel_trades_on_disconnect(ctx, player) { disarm_trade_reaper(ctx, 0); ctx.db.trade_offer().trade_id().delete(0); }';
  {
    const r = checkReaperDisarm(goodReaperDisarmSrc);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (REAPER_DISARM good): checkReaperDisarm rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Read actual source files
  // -------------------------------------------------------------------------
  let typesSrc, libSrc, tradingSrc, schemaSrc, rulesSrc;
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
  try {
    rulesSrc = readFileSync('game-core/src/trading/rules.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'game-core/src/trading/rules.rs not found' };
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

  // PROPOSE_VALIDATE + PROPOSE_COUNTERPARTY_JOIN: propose_trade delegates.
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

  // RESPOND_AUTHORIZE: respond_trade delegates to authorize_respond with ? propagation.
  const respondBody = extractFunctionBody(tradingSrc, 'respond_trade');
  if (!respondBody) {
    failures.push(
      'RESPOND_AUTHORIZE: respond_trade function not found in server-module/src/trading.rs',
    );
  } else {
    const r = checkRespondAuthorize(respondBody);
    if (!r.ok) {
      failures.push(
        `RESPOND_AUTHORIZE (TR-13/14): respond_trade delegation check failed — ${r.reason}. ` +
          'Any caller can accept/reject any trade without a proper role+status guard.',
      );
    }
  }

  // CONFIRM_AUTHORIZE: confirm_trade delegates to authorize_confirm with ? propagation.
  const confirmBody = extractFunctionBody(tradingSrc, 'confirm_trade');
  if (!confirmBody) {
    failures.push(
      'CONFIRM_AUTHORIZE: confirm_trade function not found in server-module/src/trading.rs',
    );
  } else {
    const r = checkConfirmAuthorize(confirmBody);
    if (!r.ok) {
      failures.push(
        `CONFIRM_AUTHORIZE (TR-15): confirm_trade delegation check failed — ${r.reason}. ` +
          'Any caller can finalize any trade without a proper role+status guard.',
      );
    }

    // CONFIRM_REREAD and CONFIRM_DELETE share the confirm body.
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

  // AUTHORIZE_RULES: game-core rules.rs contains the full logic in authorize_* bodies.
  {
    const r = checkAuthorizeRules(rulesSrc);
    if (!r.ok) {
      failures.push(
        `AUTHORIZE_RULES: game-core/src/trading/rules.rs authorize_* logic incomplete — ${r.reason}`,
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

  // REAPER_ARMED: propose_trade arms reaper after offer insert.
  if (proposeBody) {
    const r = checkReaperArmed(proposeBody);
    if (!r.ok) {
      failures.push(
        `REAPER_ARMED: propose_trade reaper arm check failed — ${r.reason}. ` +
          'Stale offers never expire; a malicious player can lock counterparty into perpetual cannot-trade state.',
      );
    }
  }

  // REAPER_SCHEDULER_GUARD: trade_offer_reaper must be scheduler-only.
  const reaperBody = extractFunctionBody(tradingSrc, 'trade_offer_reaper');
  {
    const r = checkReaperSchedulerGuard(reaperBody);
    if (!r.ok) {
      failures.push(
        `REAPER_SCHEDULER_GUARD: ${r.reason}. ` +
          'Without this guard any external caller can trigger the reaper and delete live offers.',
      );
    }
  }

  // REAPER_STALE_CHECK: trade_offer_reaper must check is_offer_stale.
  {
    const r = checkReaperStaleCheck(reaperBody);
    if (!r.ok) {
      failures.push(
        `REAPER_STALE_CHECK: ${r.reason}. ` +
          'Without a staleness check the reaper unconditionally deletes offers even if they were just renewed.',
      );
    }
  }

  // REAPER_DELETES: trade_offer_reaper must delete the offer.
  {
    const r = checkReaperDeletes(reaperBody);
    if (!r.ok) {
      failures.push(
        `REAPER_DELETES: ${r.reason}. ` +
          'The reaper fires but does not actually remove the stale offer row.',
      );
    }
  }

  // REAPER_DISARM: all four deletion sites call disarm_trade_reaper.
  {
    const r = checkReaperDisarm(tradingSrc);
    if (!r.ok) {
      failures.push(
        `REAPER_DISARM: ${r.reason}. ` +
          'Orphaned reaper schedule rows fire after the offer is already deleted, wasting scheduler capacity or incorrectly targeting a recycled trade_id.',
      );
    }
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'all 16 trade-reducer-security criteria met (TR-19 no-genes, TR-18 disconnect, propose-validate, counterparty-join, respond/confirm authorize delegation, authorize_rules, confirm reread+delete, cancel party-check, trade_offer public, reaper armed+scheduler-guard+stale-check+deletes+disarm)',
  };
}
