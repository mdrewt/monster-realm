// Unit tests for the release-module checker (just playtest-verify-release): a broken parser or
// matcher would let the dev_reducers-only reducers ship in a published module.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FORBIDDEN_REDUCERS,
  findForbiddenReducers,
  parseReducerNames,
} from './verify-release-reducers.mjs';

test('the forbidden set is exactly the two dev_reducers-gated reducers', () => {
  assert.deepEqual([...FORBIDDEN_REDUCERS].sort(), ['grant_bait', 'start_wild_battle']);
});

test('parseReducerNames fails loud on empty, malformed, reducer-less and zero-reducer output', () => {
  for (const bad of ['', 'not json{', '{"tables":[]}', '{"reducers":[]}']) {
    assert.throws(() => parseReducerNames(bad), `expected a throw for ${JSON.stringify(bad)}`);
  }
});

test('parseReducerNames reads the 2.6.0 flat describe shape', () => {
  const out =
    '{"typespace":{},"tables":[],"reducers":[{"name":"join_game","params":{"elements":[]},"lifecycle":{"none":[]}},{"name":"sync_content","params":{"elements":[]},"lifecycle":{"none":[]}}],"types":[],"misc_exports":[],"row_level_security":[]}';
  const names = parseReducerNames(out);
  assert.ok(names.includes('join_game') && names.includes('sync_content'), JSON.stringify(names));
});

test('parseReducerNames reads the 2.8.1 V10 sections shape (source_name)', () => {
  const out =
    '{"sections":[{"Typespace":{"types":[]}},{"Tables":[]},{"Reducers":[{"source_name":"join_game","params":{"elements":[]},"visibility":{"Public":[]}},{"source_name":"sync_content","params":{"elements":[]},"visibility":{"Public":[]}}]}]}';
  const names = parseReducerNames(out);
  assert.ok(names.includes('join_game') && names.includes('sync_content'), JSON.stringify(names));
});

test('findForbiddenReducers flags each forbidden reducer by exact name only', () => {
  assert.deepEqual(
    findForbiddenReducers(['join_game', 'sync_content', 'buy'], FORBIDDEN_REDUCERS),
    [],
  );
  assert.ok(
    findForbiddenReducers(['join_game', 'start_wild_battle'], FORBIDDEN_REDUCERS).includes(
      'start_wild_battle',
    ),
  );
  assert.ok(
    findForbiddenReducers(['grant_bait', 'buy'], FORBIDDEN_REDUCERS).includes('grant_bait'),
  );
  assert.deepEqual(
    findForbiddenReducers(
      ['sync_content', 'grant_item_helper_log', 'grant_bait_v2'],
      FORBIDDEN_REDUCERS,
    ),
    [],
  );
});
