# Testing facts

Runtime facts that made earlier tests wrong. Read this before writing a test; add a fact when a
test fails for a reason this file would have prevented.

## Client (vitest + happy-dom)

- **Storage spies:** happy-dom binds `getItem` / `setItem` / `removeItem` to each storage
  instance, so a spy on `Storage.prototype` records nothing. Spy on the instance
  (`localStorage`) or inject a recording `Storage`.
- **Screen-reader text:** `#a11y-live` coalesces in 500 ms windows and keeps only the last
  message of a window. A line that goes through the status-notice queue waits one window there
  and one in the live region, so it lands about 1 s after the frame that produced it. Drive the
  test's frame clock past both windows; never wait on real time.
- **Booted shell order:** a shown battle shell's first render starts a new battle and clears its
  log and queued speech. Feed events after that first render, as `main.ts` does.
- **Dialogue resend guard:** `DIALOGUE_RESEND_MS` (`ui/screens/dialogueScreen.ts`) swallows a
  second A for 1 s after any issued command, sent or not. That is intended, not a dropped input.

## Server (native test host, `server-module/src/native_host_tests.rs`)

- **One fixture per test:** a `Fixture` holds `FIXTURE_LOCK` for its whole lifetime, so calling
  `fixture()` again while the first is alive hangs the test.
- **Write counts are observable:** `Fixture::writes_to(table)` counts the inserts, updates and
  deletes on a table, so "one write per debited stack" can be tested.
- **No rollback:** a reducer that returns `Err` aborts its transaction in production, but the
  native host keeps the writes made before the `Err`. Assert a refusal leaves rows unchanged only
  when the refusal comes before the first write.
