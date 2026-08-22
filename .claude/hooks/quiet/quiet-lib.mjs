// quiet-lib.mjs — shared matching + filtering engine for the noise-filter hook.
//
// SSOT for three consumers:
//   quiet-bash.mjs  (PreToolUse hook) — decides whether to rewrite a command
//   quiet-run.mjs   (the wrapper)     — re-derives the profile, filters the output
//   quiet-lib.test.mjs                — the gate
//
// Node 18 compatible on purpose: some cron paths resolve `node` to /usr/bin/node
// v18 (see hooks/usage-logger's header for the history behind that lesson).

// ---------------------------------------------------------------------------
// ANSI / control-character normalisation
// ---------------------------------------------------------------------------

// CSI sequences (colour, cursor moves) and OSC strings (the hyperlinks cargo and
// vitest emit), terminated by BEL or ST. Regex literals only — `new RegExp` is
// banned in this workspace's eval corpus (ADR-0064) and the ban is a good one.
//
// The ESC bytes below are flagged by biome's noControlCharactersInRegex, which is a
// good rule and wrong here: matching the control character IS the purpose. Suppressed
// rather than worked around, because `templates/_base/biome.json` lints `**` and a
// scaffolded project must pass its own `just ci` out of the box.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
const ANSI_CSI = /\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC/BEL is the point
const ANSI_OSC = /\][^]*(?:|\\)/g;

export function stripAnsi(s) {
  return s.replace(ANSI_OSC, '').replace(ANSI_CSI, '');
}

/**
 * Normalise one raw line for both the log and the filter: drop ANSI, collapse a
 * carriage-return progress redraw to its FINAL frame, and trim the line ending.
 *
 * The CR collapse is load-bearing, not cosmetic: npm, cargo and wasm-pack all
 * redraw a spinner by rewriting one physical line, so treating each frame as a
 * line would MULTIPLY the output this hook exists to shrink.
 */
export function normaliseLine(line) {
  const flat = stripAnsi(line).replace(/\r+$/, '');
  const idx = flat.lastIndexOf('\r');
  return idx === -1 ? flat : flat.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// Command shape helpers
// ---------------------------------------------------------------------------

/**
 * Peel leading environment assignments (`FOO=1 BAR=2 cargo test`), returning the
 * effective command and the names peeled. Deliberately not a shell parser: any
 * shape it cannot account for must make the caller fail open, never guess.
 */
/** Every environment name assigned anywhere the hook can see it: at the start of the
 *  command, and after a `cd <dir> &&` prefix. The escape hatch used to be checked
 *  only at the start, so `cd client && NOFILTER=1 npm test` was silently filtered
 *  anyway — an escape hatch that does not escape is worse than none. */
export function allEnvNames(command) {
  const outer = peelEnv(command);
  const inner = peelEnv(splitCdPrefix(outer.command).command);
  return [...outer.env, ...inner.env];
}

export function peelEnv(command) {
  const env = [];
  let rest = command.trim();
  for (;;) {
    const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/);
    if (!m) break;
    env.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return { env, command: rest };
}

/** Replace every quoted span with a placeholder so operator detection cannot
 *  trip over an operator character that is merely part of an argument —
 *  `cargo nextest run -E 'test(foo)'` is one simple command, parentheses and all. */
function blankQuoted(s) {
  return s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");
}

// Shell metacharacters that make a command more than one simple command. `$` is
// included because command substitution and expansion both change what actually
// runs, and this hook must only ever wrap commands it can read literally.
const OPERATORS = /[;&|<>`$(){}\n]/;

export function splitCdPrefix(command) {
  const m = command.match(/^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*([\s\S]+)$/);
  if (!m) return { cd: null, command };
  return { cd: m[1].replace(/^["']|["']$/g, ''), command: m[2].trim() };
}

/**
 * The single command shape this hook will ever rewrite: one simple command, after
 * an optional `cd <dir> &&` prefix (how every AGENTS.md here tells agents to reach
 * `client/`) and any environment assignments.
 */
// Long-lived / interactive forms. Wrapping a watcher would hand the agent a process
// that never prints its banner, and wrapping a TTY-dependent form (`--ui`,
// `--headed`) changes what the tool does. Deliberately enumerated, NOT a blanket
// short-flag ban: `-i` and `-w` are ordinary flags elsewhere (`grep -i` is
// case-insensitive, not interactive) and banning them would silently drop coverage.
const LONG_LIVED =
  /(?:^|\s)(?:--watch|--watchAll|--ui|--headed|--follow|--serve|--interactive)(?:\b|=)|^(?:cargo\s+watch|vite|spacetime\s+logs|npm\s+run\s+dev)\b/;

export function isRewritableShape(command) {
  const { command: noEnv } = peelEnv(command);
  const { command: body } = splitCdPrefix(noEnv);
  const { command: bodyNoEnv } = peelEnv(body);
  if (!bodyNoEnv) return false;
  if (LONG_LIVED.test(bodyNoEnv)) return false;
  const probe = blankQuoted(bodyNoEnv);
  // An unbalanced quote means blankQuoted left something unaccounted for.
  if ((probe.match(/"/g)?.length ?? 0) % 2 !== 0) return false;
  if ((probe.match(/'/g)?.length ?? 0) % 2 !== 0) return false;
  return !OPERATORS.test(probe);
}

/** The effective command body used for profile matching (env + `cd` peeled). */
export function commandBody(command) {
  const { command: noEnv } = peelEnv(command);
  const { command: body } = splitCdPrefix(noEnv);
  return peelEnv(body).command;
}

// ---------------------------------------------------------------------------
// Profile registry
// ---------------------------------------------------------------------------
//
// A profile is:
//   name       stable id; appears in the banner and in the rewritten command
//   match      (argv0, body, argv) => boolean
//   targeted   (body) => boolean  — true when the command names a specific package,
//                                   file or test filter. The operator's rule: a run
//                                   scoped to what was just worked on has passing
//                                   lines that are SIGNAL; a full sweep's are not.
//   rules      ordered, first match wins: { id, action: 'keep'|'drop'|'defer', re }
//   (there is deliberately no "always keep the last N lines" guard — see below)
//   summarise  (state, exitCode) => string[]   optional synthesised lines
//
// The rule tables live in quiet-profiles.mjs so this engine holds no tool trivia.

export function selectProfile(profiles, command) {
  if (!isRewritableShape(command)) return null;
  const body = commandBody(command);
  const argv = body.split(/\s+/);
  const argv0 = (argv[0] || '').split('/').pop();
  for (const p of profiles) {
    try {
      if (p.match(argv0, body, argv)) return p;
    } catch {
      /* a broken profile must not take the whole hook down */
    }
  }
  return null;
}

// A `path.ext:line` reference — the thing an agent needs in order to go and look.
// Extensions are enumerated rather than left open so that ordinary prose with a
// colon-number (`Duration 2.62s`, `finished in 0.00s`) does not qualify.
const SOURCE_LOCATION =
  /[\w./~-]+\.(?:rs|ts|tsx|js|jsx|mjs|cjs|py|toml|json|ron|wgsl|glsl|md|yml|yaml|sh|mjs)\b[:(]\d+/;

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

const DEFAULT_OPTS = {
  // A deferred block at or below this many lines is replayed verbatim rather than
  // reduced to a count. It closes the case where a sweep-shaped command turns out
  // to produce very little output — summarising six lines into "withheld 6 lines"
  // is pure loss.
  replayDeferredUpTo: 60,
  // Ceiling on RETAINED deferred lines so a pathological run cannot exhaust
  // memory. Counting continues past it; retention does not.
  deferRetainCap: 5000,
  // A line ceiling alone is not a memory bound — 5000 lines of a pathological
  // single-line payload is unbounded. Retention stops at whichever comes first.
  deferRetainBytes: 2 * 1024 * 1024,
  targeted: false,
  // Positional ceiling, used only by the `search` profile. Past it, further KEEPs
  // become deferred and are counted. Null = no ceiling (every other profile).
  capKeptAt: null,
};

export function createFilter(profile, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const replayLimit = o.replayDeferredUpTo;
  const state = {
    total: 0,
    kept: 0,
    dropped: 0,
    deferred: 0,
    replayed: 0,
    byRule: new Map(),
    deferredLines: [],
    profile: profile.name,
    targeted: o.targeted,
  };
  // NO TAIL GUARD. An earlier build always re-emitted the last N withheld lines, on
  // the theory that every tool states its verdict there. Measured: on a short run it
  // RESURRECTED the very lines the drop rules had just removed (both `Compiling`
  // lines of a 3-line fixture came back). The role it was meant to play is already
  // covered, and covered better, by two things: unmatched lines are kept (so an
  // unrecognised verdict line survives by default), and every profile carries an
  // explicit keep rule for its summary line, asserted per profile by the test suite.
  let deferredBytes = 0;
  let lastEmittedBlank = false;

  function bump(id) {
    state.byRule.set(id, (state.byRule.get(id) ?? 0) + 1);
  }

  return {
    state,

    /** @returns {string|null} the line to emit now, or null to withhold it */
    push(rawLine) {
      const line = normaliseLine(rawLine);
      state.total += 1;

      let action = null;
      let ruleId = '_unmatched';
      for (const rule of profile.rules) {
        if (!rule.re.test(line)) continue;
        ruleId = rule.id;
        action = rule.action;
        break;
      }

      // Consecutive blank lines are padding in every format captured here and cost
      // a token each. One blank is kept as a separator; a run of them is not.
      //
      // NOT applied to a capped profile. `search` documents that it removes nothing
      // and only caps, and grep's own -A/-B/-C context output uses blank lines and
      // `--` as record separators — collapsing them there would silently edit the
      // result the agent asked for.
      if (action === null && o.capKeptAt === null && line.trim() === '' && lastEmittedBlank) {
        bump('_blank-run');
        state.dropped += 1;
        return null;
      }

      // Unmatched lines are KEPT. Fail-open is the entire safety posture: a tool
      // that changes its output format, or a stack no profile anticipated,
      // degrades to "not filtered" rather than to "silently eaten".
      if (action === null) action = 'keep';

      // SOURCE-LOCATION GUARD (research invariant I4). A rule may not DROP or DEFER a
      // line that tells an agent where to look. Two real loss modes motivated it,
      // both naming a file and line in a shape no failure-keyword rule anticipates:
      //   `note: test did not panic as expected at src/lib.rs:35:8`   (#[should_panic])
      //   `---- src/lib.rs - name (line 4) stdout ----`               (doctests)
      // Fail-open already keeps both today, but only as an emergent property of the
      // rule tables. This makes it a guarantee.
      //
      // It sits AFTER rule resolution and BEFORE the positional cap on purpose: the
      // cap bounds VOLUME rather than removing signal, and grep output is nothing but
      // file:line references — letting the guard override the cap would exempt the
      // one profile the cap exists for.
      if (action !== 'keep' && SOURCE_LOCATION.test(line)) {
        ruleId = '_source-location';
        action = 'keep';
      }

      // Positional cap (grep/rg sweeps): past the ceiling a keep becomes a defer,
      // so the agent gets the head of the result plus an honest count of the rest
      // instead of Claude Code's blind 30 000-character middle-truncation.
      if (action === 'keep' && o.capKeptAt !== null && state.kept >= o.capKeptAt) action = 'defer';

      // A TARGETED run promotes withheld routine lines back to keeps — the
      // operator's rule: a run scoped to what was just worked on has passing lines
      // that confirm the fix.
      //
      // Verbose (a re-run after a failure) deliberately does NOT do this. Measured
      // during the runtime shakeout: promoting on verbose restored all 200 passing
      // lines of a 201-test fixture, i.e. re-running a red 1590-test suite would
      // hand back the entire pass wall — the exact noise this hook exists to remove.
      // Verbose instead loosens the replay threshold and failure-context caps below.
      if (
        action === 'defer' &&
        o.targeted &&
        !(o.capKeptAt !== null && state.kept >= o.capKeptAt)
      ) {
        action = 'keep';
      }

      bump(ruleId);

      let emitted;
      if (action === 'keep') {
        state.kept += 1;
        emitted = true;
      } else if (action === 'drop') {
        state.dropped += 1;
        emitted = false;
      } else {
        state.deferred += 1;
        if (
          state.deferredLines.length < o.deferRetainCap &&
          deferredBytes + line.length <= o.deferRetainBytes
        ) {
          deferredBytes += line.length;
          state.deferredLines.push(line);
        }
        emitted = false;
      }

      if (emitted) lastEmittedBlank = line.trim() === '';
      return emitted ? line : null;
    },

    /** @returns {string[]} synthesised trailing lines, in emission order */
    finish(exitCode) {
      const out = [];

      if (state.deferred > 0) {
        const retainedAll = state.deferredLines.length === state.deferred;
        // Replay only on a GREEN run. finish() emits at the end of the stream, so on
        // a failure the replayed pass lines would land AFTER the failure verdict and
        // read as if they had happened last — actively misleading at exactly the
        // moment the agent is trying to work out what broke. On a red run the count
        // is enough; the lines themselves are in the raw log.
        if (retainedAll && state.deferred <= replayLimit && exitCode === 0) {
          state.replayed = state.deferredLines.length;
          out.push(...state.deferredLines);
        } else if (!profile.suppressDeferNotice) {
          // Profiles whose own summariser already accounts for what was withheld
          // opt out — two notices saying the same thing in different words is
          // itself noise, and "routine line(s)" is actively wrong for a capped
          // search result.
          out.push(
            `[quiet-run] withheld ${state.deferred} routine line(s) — full text in the raw log`,
          );
        }
      }

      if (profile.summarise) {
        try {
          out.push(...profile.summarise(state, exitCode));
        } catch {
          /* a broken summariser must not lose the output above it */
        }
      }
      return out;
    },
  };
}
