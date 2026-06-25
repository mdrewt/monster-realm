// No-logic-in-wrapper eval (ADR-0003 / ADR-0036): the `client-wasm` boundary must
// MARSHAL only — deserialize JS, delegate to `game-core`, serialize back. If a
// movement *rule* (a `match` on a `Direction` variant, a walkability check, a
// `.step`, a tile/action variant decision) ever lives in the wrapper, the rule has
// two homes and prediction can silently desync from authority. v1 left this to
// discipline; here it is mechanical. The wrapper may *name* game-core types and
// *call* `game_core::apply_move` (delegation) — it may not re-decide the rule.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Strip Rust comments so prose that *mentions* the rule (this file's own doc
// comments describe what is banned) never trips the scanner — only real code does.
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Pure predicate (teeth-tested below): does the wrapper *code* re-implement a
// movement rule rather than delegate it? Detects deciding on the domain enums or
// calling the map/step primitives — none of which a marshal->delegate->marshal
// wrapper needs.
export function hasMovementLogic(src) {
  const code = stripRustComments(src);
  const ruleSignals = [
    /Direction::(North|South|East|West)/, // matching/constructing a facing variant
    /MoveInput::(Step|Jump)/, //            deciding on the intent variant
    /TileKind::/, //                        deciding on a tile kind
    /ActionState::(Idle|Walking|Jumping)/, // setting an action (the rule's job)
    /\.is_walkable\s*\(/, //                a walkability check
    /\.step\s*\(/, //                       a tile step
    /\.in_bounds\s*\(/, //                  a bounds check
  ];
  return ruleSignals.some((re) => re.test(code));
}

export default async function () {
  const name = 'no-logic-in-wrapper (client-wasm marshals, never re-decides the rule)';

  // Proof-of-teeth: a wrapper that pattern-matches a Direction (a rule) MUST be
  // flagged; if the predicate misses it the gate is meaningless.
  const badFixture = `
    pub fn apply_move(state: JsValue, input: JsValue, now: f64) -> Result<JsValue, JsValue> {
        let dir: Direction = from_value(input)?;
        let next = match dir { Direction::North => up(state), _ => state }; // a RULE leaked in
        Ok(to_value(&next)?)
    }`;
  if (!hasMovementLogic(badFixture)) {
    return { name, pass: false, detail: 'proof-of-teeth: predicate failed to flag a rule-bearing wrapper' };
  }
  // And a faithful marshaling wrapper must NOT be flagged (no false positive).
  const goodFixture = `
    pub fn apply_move(state: JsValue, input: JsValue, now: f64) -> Result<JsValue, JsValue> {
        let state: CharacterState = from_value(state)?;
        let input: MoveInput = from_value(input)?;
        let next = game_core::apply_move(&state, input, &game_core::zone_0(), Millis(now as i64));
        Ok(to_value(&next)?)
    }`;
  if (hasMovementLogic(goodFixture)) {
    return { name, pass: false, detail: 'proof-of-teeth: predicate false-flagged a pure marshaling wrapper' };
  }

  // Real check: the actual wrapper source carries no rule.
  const libPath = path.resolve('client-wasm/src/lib.rs');
  let src;
  try {
    src = readFileSync(libPath, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${libPath}: ${e.message}` };
  }
  const leaked = hasMovementLogic(src);
  return {
    name,
    pass: !leaked,
    detail: leaked
      ? 'RULE LEAK: client-wasm/src/lib.rs re-implements a movement rule (must only marshal+delegate)'
      : 'clean — wrapper marshals + delegates, no rule (teeth verified)',
  };
}
