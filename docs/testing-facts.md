# Testing facts

Runtime facts that made earlier tests wrong. Read this before writing a test; add a fact when a
test fails for a reason this file would have prevented.

## Client (vitest + happy-dom)

- **Storage spies:** happy-dom copies each `Storage` method onto the instance, bound, the first
  time it is read. A spy on `Storage.prototype` installed after a storage object has touched that
  method is shadowed and records nothing. Spy on the instance (`vi.spyOn(localStorage, …)`) or
  inject a recording `Storage`.
- **Screen-reader text:** `#a11y-live` (`ui/liveRegion.ts`) coalesces in
  `COALESCE_WINDOW_MS` (500 ms) windows and keeps only the last message of a window. A line that
  goes through the status-notice queue waits at least one window there and one in the live
  region, so it lands about 1 s or more after the frame that produced it. Both windows advance
  only when the frame pump calls `flush`, on a clock that must not step backwards. Repeating the
  same text toggles a trailing U+00A0, so compare with that in mind. Drive the test's frame clock
  past the windows; never wait on real time.
- **Battle shell order:** the first render of a new battle id clears the battle's log and queued
  speech (`tactics/tacticsBattle.ts`, `render`). Render before you ingest events.
- **Dialogue resend guard:** `DIALOGUE_RESEND_MS` (`ui/screens/dialogueScreen.ts`) swallows a
  second A for 1 s after any issued command, sent or not; a new dialogue node lifts it (under
  reduced motion the new node re-arms it from its arrival). While the text is still revealing,
  A finishes the reveal instead of acting. This is intended, not a dropped input.

## Server (native test host, `server-module/src/native_host_tests.rs`)

- **One fixture per test:** a `Fixture` holds `FIXTURE_LOCK` for its whole lifetime, so calling
  `fixture()` again while the first is alive hangs the test. `fixture()` wipes rows, index
  registrations and write counts.
- **Write counts:** `Fixture::writes_to(table)` counts write calls on a table, including no-op
  deletes and identical updates, not changed rows. Rows seeded with `Handle::seed` are not
  counted. Call `reset_writes()` before the code under test.
- **No rollback:** a reducer that returns `Err` aborts its transaction in production, but the
  native host keeps the writes made before the `Err`. Assert a refusal leaves rows unchanged only
  when the refusal comes before the first write.
