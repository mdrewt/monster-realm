# 0181 — String-literal-aware source scanners: one Rust scanner, one TypeScript scanner, and why they cannot be the same function

**Status:** Accepted
**Date:** 2026-08-09
**Slice:** 13r-c (post-gate thirteenth-review residuals — `specs/monster-realm-v2/M-postgate-thirteenth-review-residuals.spec.md` §13r-c)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, security-authz, tooling-docs
**Decision:** Rust scanning in `evals/` moves to one string-literal-aware `evals/rust-scan.mjs` that lexes comments and strings in a single pass and preserves offsets by blanking literal payloads; TypeScript uses a separate literal-PRESERVING scanner.

> **Carries out** ADR-0179 §9 (the `evals/rust-scan.mjs` consolidation it named as
> the indicated follow-up) and ADR-0180 residual #2 (port the string-aware scanner
> file-wide in `main.wiring.test.ts`). The `**Amends:**` field is left empty
> deliberately: the digest gate requires a reciprocal `**Amended-by:**` line in
> ADR-0179 and ADR-0180, and those files are outside slice 13r-c's declared
> `touches:` set. Whoever owns them next should add the back-links.

## Context

Several security and privacy evals scan `server-module/src/*.rs` as text. Their
comment strippers were regex pairs of the shape

```js
src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
```

which have no notion of string literals. A perfectly ordinary Rust constant —

```rust
const ISSUER: &str = "https://auth.example/";
```

— truncates at the scheme slashes. The line keeps its opening quote and loses
its closing one. Any subsequent string-stripping pass then pairs that orphan
quote with the next quote it finds, inverting string/code polarity and blanking
real code from the scan. Every ban clause downstream then passes on code it can
no longer see.

**This is a false-GREEN on a security gate**: the gate reports PASS precisely
because it went blind. It fails silently and in the unsafe direction.

The hazard is not hypothetical in this repo:

- `server-module/src/accounts.rs:33-48` carries a `concat!("https:/", "/auth…")`
  workaround and a 16-line comment explaining that a real issuer URL would trip
  the evals. The OIDC issuer URL (ADR-0179 OQ1, now answered) is due to land.
- `evals/trade-escrow-guards.eval.mjs` (TR-11) historically went red from this
  exact class.
- Measured this slice: `client/src/main.wiring.test.ts`'s `stripLineComments`
  turns `client/src/net/connectionConfig.ts:12`
  `const DEV_URI = 'ws://127.0.0.1:3000';` into `const DEV_URI = 'ws:` — and that
  file is inside the corpus the offenders loop at `main.wiring.test.ts:6637`
  scans today.

A correct quote-first walker already existed in-tree, duplicated verbatim in
`evals/account-privacy.eval.mjs` and `evals/guest-claim-integrity.eval.mjs`
(~450 lines each). ADR-0179 §9 flagged the duplication and noted the two
`splitArgs` copies had already diverged — confirmed: guest-claim's tracks
generic-angle depth, account-privacy's did not.

## Decision

**D1 — One Rust scanner, `evals/rust-scan.mjs`.** Comments and string literals
are lexed in the SAME pass, so a slash-slash inside a literal is data and can
never open a comment. It handles raw / byte / C-string forms (`r#"…"#`,
`br…`, `cr…`) and nested block comments.

**D2 — `stripRustSource` is length- and offset-preserving.** It blanks literal
payloads to spaces while keeping both quote characters and every newline.
Callers rely on reading the RAW source at offsets discovered in the STRIPPED
text (`parseStrConsts` does exactly this). A "cleanup" that deletes instead of
blanking would silently misalign every such call site, so `assertStripperSound`
enforces length preservation, idempotence, and an anchor-count floor
mechanically.

**D3 — `independentAnchorCount` stays naive, quote-blind, and private.** It is
the desync detector for the real stripper; a shared implementation could not
detect its own desync. A stripper desync GREENS every ban clause it blinds, so
it is caught here or not at all.

**D4 — TypeScript gets a SEPARATE, literal-PRESERVING scanner.** This is the
non-obvious call and the reason this ADR exists. `stripRustSource` must never
be pointed at TypeScript. The client privacy evals ban strings such as
`FROM player_wallet` whose needles live INSIDE SQL string literals; blanking the
payload makes the ban pass vacuously.

Measured: applying `stripRustSource` to a TypeScript subscription call blanks
the ban needle when the SQL literal is **double-quoted**. It survives today only
because the repo's biome style emits single quotes, which the Rust lexer reads
as a char literal and leaves alone. That is luck, not a guarantee — a formatter
setting or one hand-written double-quoted query would silently disarm the ban.
Hence two scanners, and a module-header prohibition in `rust-scan.mjs`.

**D5 — `splitArgs` unification takes the stricter, angle-aware body.** The
looser copy mis-splits a generic argument list (`foo(Vec<A, B>, c)` → three
args). Adopting the angle-aware body was measured to change no current result in
either consuming eval.

**D6 — `main.wiring.test.ts` gets one scanner, not two.** The correct
string-aware TS scanner introduced for the m20c teeth is promoted to the file's
single scanner and `stripLineComments` delegates to it, so all pre-existing
teeth are fixed in place without editing their call sites. The retired
`stripBlockComments` bail-and-drop behaviour had been cited in several comments
as an anti-vacuity *property*; those comments are corrected rather than left
asserting a defeated property.

**D7 — `evals/rust-scan.mjs` is deliberately NOT named `*.eval.mjs`.**
`evals/run.mjs` discovers `evals/*.eval.mjs` and would import it and call a
non-existent default export, synthesising a failure for every CI run.

## Consequences

- Three security gates (`currency-integrity`, `ranking-security`,
  `conversation-privacy`/`wallet-privacy`) can no longer be blinded by a `://`
  in a Rust literal, and `main.wiring.test.ts` can no longer be blinded by a
  comment opener inside any `client/src` string literal.
- ~900 duplicated scanner lines collapse to one 516-line module.
- Each fixed gate carries a proof-of-teeth fixture — a `https://` literal
  followed by a genuine violation LATER in the same file — that was observed RED
  before the fix.

**D8 — the TypeScript scanners lex regex literals, by a SOUND rule.** Found by
red-team as a BLOCKER and reproduced: a regex literal whose **closing** slash
abuts a `*` —

```js
const RE = /ab/*
conn.subscribe(['SELECT * FROM player_wallet']);
const noop = 1 */ 2;
```

— formed a `/` `*` pair the scanner read as a real block-comment opener and
swallowed every line to the next `*/`. That erased a genuine, compiling
subscription carrying a **banned** private-table query, and
`checkNoPrivateWalletSubscription` returned **PASS** on a live ADR-0015 leak.
The newline-count anti-truncation guard could not catch it either: block mode
re-emits every newline it steps over, so line structure stays intact while the
code between the markers is gone.

Both TS scanners now consume a regex literal (tracking `[...]` classes and
backslash escapes) **before** the comment arms, but only where a binary `/` is
*impossible* — immediately after `= ( , [ { : ; ! ? & | + - * % < > ^ ~ }` or at
start of source. After those tokens there is no left operand, so a `/` cannot be
division and must open a regex. That makes the rule **sound rather than
heuristic**, which is why it is safe to apply to a scanner that gates security
checks.

**Deliberately conservative residual:** a regex in *keyword* position
(`return /x/`, `typeof`, `case`) is not recognised, because telling that from
division needs real token history. Under-detection is safe — it simply preserves
the previous behaviour — whereas over-detection would swallow real code. The
`${…}` interpolation limit likewise remains, and is self-announcing (it yields a
*shorter* `code` string, which reds a tooth rather than passing one).

Teeth `[13r-c/T3c]` and `★ W-CMT-STRIP-REGEX-PHANTOM-BLOCK` pin the closure; both
were verified to bite by reverting only the fix.

### Residual — `independentAnchorCount` can false-RED on a multi-line Rust string

The desync detector is a quote-blind LINE scan, and it skips a line only if
*that* line carries a quote. Rust allows a raw newline inside an ordinary `"…"`
literal, so when a multi-line fixture string's **middle** lines contain
`#[spacetimedb::` — with no quote of their own — the naive scanner counts them as
real anchors while `stripRustSource` correctly blanks them as literal payload.
The result is a **false desync report against a stripper that is behaving
correctly** (`[STRIP/anchors]`), i.e. a false RED, not a false GREEN.

Measured: exactly two files in the tree trip it today —
`server-module/src/playtest_tests.rs` and `server-module/src/ranking_tests.rs`,
both of which embed Rust source as multi-line test fixtures. It is **dormant**
because every gate added by this slice filters `*_tests.rs` first, for the
separate phantom-anchor reason above. It would surface if that exclusion were
loosened, or if a NON-test `server-module/src/*.rs` adopted the same embed-source-
as-a-multi-line-string pattern.

Not fixed here: `independentAnchorCount` must stay naive and independent of the
real stripper (D3) — teaching it about multi-line strings is exactly the coupling
that would stop it detecting a desync. The right fix is to skip a line while a
multi-line literal is open, tracked as a follow-up rather than smuggled into a
landing slice.

### The soundness gate must match the ban surface, per eval

`assertStripperSound` has to cover **every file the ban clauses actually needle**,
not just the file the eval is named after. `currency-integrity`'s criteria 5/6
scan ~20 files beyond `economy.rs`/`schema.rs`, so gating only those two would
have left the widest ban surface in that eval unprotected — the exact false-GREEN
class this ADR closes. Gates are placed per eval over that eval's real scan set,
NON-TEST only (the desync detector is quote-blind by design, so a
`#[spacetimedb::` inside a `*_tests.rs` fixture STRING reads as real code to it —
measured 7 phantom anchors across 9 files).

### Residual — the class is wider than this slice (disclosed, not closed)

Measured across `evals/*.eval.mjs` at this slice's HEAD:

- **26** evals strip `//` comments with **no string pass at all**.
- **9** evals have a string pass that runs **after** the comment strip.

13r-c fixes three of them. **~24 + ~8 remain**, several named
`*-security.eval.mjs` / `*-privacy.eval.mjs`. Most are per-file scrubbers, so
their blast radius is bounded to the offending file; the dangerous shape is the
whole-crate-blob scanner (`trade-escrow-guards`), where one bad literal inverts
polarity across every later file. Migrating the remainder onto `rust-scan.mjs`
is the indicated follow-up.

### Deferred to 13r-c-2 (hidden dependency — measured)

Removing the `accounts.rs` `concat!()` workaround is **not** in this slice.
Probing it empirically (full eval suite, node 24.13.1) showed the bare literal
fails exactly one eval — `evals/trade-escrow-guards.eval.mjs` (TR-11) — which is
outside this slice's declared `touches:` set. That eval concatenates every
`server-module/src/*.rs` into one blob with `accounts.rs` sorted first, strips
comments before strings, and so inverts quote polarity for the whole crate. The
workaround therefore stays until `trade-escrow-guards` is migrated, and
`accounts.rs`'s hazard comment stays accurate in the meantime.

## Alternatives considered

- **One scanner for both languages** — rejected: the payload-blanking property
  that makes the Rust scanner offset-safe is exactly what makes it unsafe for
  TypeScript bans (D4).
- **Strip strings first, then comments** — rejected, and already measured and
  rejected once before by ADR-0169 D4: a naive string pre-pass desynchronises on
  unpaired apostrophes inside `//` comments. The single-pass state machine is
  structurally immune because its comment modes consume to their delimiter
  without any quote tracking.
- **Fix the three evals in place without extracting a module** — rejected: it
  would have produced a fifth and sixth copy of a walker that ADR-0179 §9
  already flagged as duplicated and diverged.
