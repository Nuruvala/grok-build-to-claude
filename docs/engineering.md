# Engineering guidelines

How this repo is written. These are rules, not suggestions — where a rule has an escape hatch, the
escape hatch is named explicitly and nowhere else counts.

The short version: **the product is reliability.** Every rule below exists because breaking it
produces a server that looks like it worked and did not. That specific failure — a run that reports
success while changing nothing, a session id that does not resume, a process that hangs forever — is
the thing this project exists to eliminate. See "Why this exists" in [CLAUDE.md](../CLAUDE.md).

---

## 1. Architecture: pure core, imperative shell

The codebase splits into two kinds of module, and the split is not negotiable.

**Core (pure).** Takes values, returns values. No I/O, no clock, no `process`, no randomness, no
throwing for control flow. `src/grok/args.ts`, `src/permission.ts`, `src/grok/result.ts`,
`src/grok/stream.ts` are core. Core is where the logic that silently breaks on a CLI upgrade lives,
so core is where the exhaustive tests go.

**Shell (effectful).** Spawns processes, reads files, writes to stderr, talks to the transport.
`src/grok/exec.ts`, `src/jobs/*`, `src/server.ts`, `src/index.ts` are shell. Shell should be thin
enough to read in one sitting and boring enough that its bugs are visible.

A function that both decides _and_ performs is the thing to split. `buildArgs(params) => string[]`
and `spawn(binary, argv)` are two functions on purpose; a `runGrok(params)` that computes argv
internally cannot be tested without a process.

Rules:

- Core modules import nothing from `node:child_process`, `node:fs`, or `node:os`, and never read
  `process.env`. Environment reaches core as a `Config` parameter.
- Shell modules contain no branching business logic. If a shell module grows an `if` that decides
  _what_ to do rather than _whether the thing worked_, that decision belongs in core.
- Effects are passed in, not reached for. Handlers receive a `ToolContext` (`config`, `signal`,
  `reportProgress`) rather than importing a singleton.

## 2. Functional TypeScript

"Functional" here means a concrete set of habits, not a paradigm badge. No `fp-ts`, no `Either`
monad, no point-free style. We are writing plain TypeScript that happens to be honest about data and
effects.

### Data

- **Immutable by default.** Interface fields are `readonly`. Array parameters are `readonly T[]`.
  Anything crossing a module boundary as long-lived state is `Object.freeze`d — `loadConfig` returns
  a frozen object, `GrokMcpError.details` freezes its copy.
- **Never mutate a parameter.** A function that takes `string[]` and pushes into it is banned. The
  one accepted exception is a local accumulator that never escapes the function that declared it:

  ```ts
  // Fine: `problems` is born and dies inside loadConfig.
  const problems: string[] = [];
  const ceiling = parseLevel(
    env,
    'GROK_MCP_PERMISSION_CEILING',
    DEFAULTS.permissionCeiling,
    problems,
  );
  ```

  This is a deliberate concession. Collecting _every_ config problem before throwing beats
  functional purity, because it means one restart teaches the operator about all of them.

- **`as const` for literal tables.** `DEFAULTS`, `PERMISSION_LEVELS`, flag maps. Derive types from
  the data, never declare them twice.
- **No shared mutable module state.** The only writable module-level value in `src/` is the cached
  log level in `src/log.ts`, which exists because logging must work before config parsing does, and
  is resettable via `refreshLogLevel()`. Anything else needs an argument in review.

### Functions

- `function` declarations at module top level; arrow functions for callbacks and returned closures.
  Hoisting makes a module readable top-down.
- **One job per function.** If the name needs "and", split it.
- **Return values, do not signal through parameters.** No out-params, no callback-for-result.
- **Total functions where practical.** A function that cannot handle some inputs should not accept
  them — narrow the parameter type instead of documenting a precondition.
- Prefer `map`/`filter`/`flatMap` over accumulator loops when building a value. Prefer a plain `for`
  loop when the body performs effects — chaining effects through `forEach` hides them.

### Types

- **No classes, with exactly one exception: errors.** `GrokMcpError` and its subclasses are classes
  because `instanceof` narrowing and `Error` subclassing are how the ecosystem does typed failure,
  and because `cause` chaining is built in. Everything else is a function over plain data. No
  services, no managers, no `this`, no inheritance hierarchies.
- **Discriminated unions over boolean flags.** `{ ok: true, value } | { ok: false, error }` beats
  `{ ok: boolean, value?, error? }`, which is representable-but-invalid in four states.
- **Exhaustiveness is checked, not assumed.** Switching over a union ends with a `never` arm:

  ```ts
  default: {
    const unreachable: never = event;
    throw new Error(`unhandled event: ${String(unreachable)}`);
  }
  ```

  Except where the source is external. The `grok` CLI's `streaming-json` `type` list is documented
  as non-exhaustive, so that switch tolerates unknown values by design — and says so in a comment.

- **`unknown` at every boundary, narrowed immediately.** Tool arguments, JSON from the CLI, caught
  errors. `useUnknownInCatchVariables` is on.
- **`any` is banned.** Not discouraged — banned. `typescript-eslint`'s `strictTypeChecked` enforces
  it. If a dependency's types force your hand, narrow at one chokepoint with a type predicate and
  leave a comment naming the dependency.
- **Type assertions (`as`) require a runtime check on the line above, or `as const`.** No
  `as unknown as T`. No non-null `!` in `src/` (allowed in `tests/`, where a failed assumption is a
  test failure and that is the point).
- **Types are derived, never duplicated.** zod schemas are the single definition of tool input;
  static types come from `z.output<typeof Schema>` and the advertised JSON Schema comes from
  `z.toJSONSchema()`. A hand-written JSON Schema next to a zod schema is two sources of truth that
  will disagree within a month.
- **`satisfies` when you want inference plus a constraint**, annotation when you want the wider
  type.

### Compiler settings are part of the design

`tsconfig.json` enables the strict family plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, and `verbatimModuleSyntax`.
These are load-bearing and are not to be relaxed to make code compile:

- `noUncheckedIndexedAccess` is why `arr[0]` is `T | undefined`. That is correct, and the check you
  are tempted to skip is the bug.
- `exactOptionalPropertyTypes` distinguishes "absent" from "present and `undefined`". It is why
  `ProgressCapableExtra` writes `progressToken?: string | number | undefined` explicitly — the SDK
  means both.

Suppressions (`@ts-expect-error`, `eslint-disable`) need a comment on the same line or directly
above stating why, and must be as narrow as possible. The one file-level disable in the repo
(`src/server.ts`, for the SDK's deprecated low-level `Server`) carries a paragraph of justification.
That is the bar.

## 3. Failure

- **Every error names the fix.** `GrokMcpError` carries a `remedy` field, rendered on its own line
  after the message. An error that only reports failure makes the model retry the same call
  verbatim. `PermissionDeniedError` names the exact env var to change.
- **Reject, never silently clamp.** If a caller asks for more than policy allows, fail and say so.
  Downgrading behind their back produces a successful-looking run that did nothing.
- **Fail fast at startup, not at call time.** Bad configuration kills the process before it serves a
  request. A config error surfacing as a confusing tool failure twenty minutes into a session is a
  worse outcome than a one-line startup message.
- **Never discard buffered output on error.** A run that fails after producing 200 lines returns
  those 200 lines _and_ the error. This is a named defect in the prior-art plugin; reproducing it is
  a bug regardless of what the tests say.
- **Errors cross the tool boundary as `isError: true` results, not thrown JSON-RPC errors.** The
  text goes to the model, which can then correct itself. Thrown protocol errors just stall.
- **Never swallow silently.** `catch {}` with no log is banned. If continuing is correct, log at
  `debug` and say why in a comment — see the progress-notification catch in `src/server.ts`.
- **Errors are for the exceptional; unions are for the expected.** Malformed JSON from an external
  process is expected — return a union. A tool asked for a level above the ceiling is exceptional —
  throw a typed error and let the server envelope render it.

## 4. Effects and resources

- **stdout is the MCP transport.** Nothing else may write to it. Diagnostics go through `src/log.ts`
  to stderr. This is enforced three ways: lint rules on `console.log`/`console.info` and
  `process.stdout.write`, and a CI step that pipes a real `initialize` through `node dist/index.js`
  and JSON-parses every stdout line. A rule that only lives in a document is a rule that gets
  broken.
- **Never build a shell string.** Always `spawn(binary, argv)` with an array, never `shell: true` on
  POSIX. Prompts contain newlines, quotes, `$`, and backticks.
- **Everything is bounded.** Every accumulating buffer has a cap (10 MB per stream) with an explicit
  truncation marker. Every child process has a wall clock (`GROK_MCP_TIMEOUT_MS`) enforced with
  SIGTERM then SIGKILL against the **process group**, not just the direct child.
- **Every long operation reports progress**, when the client supplied a `progressToken`. Progress
  must track real work — per-event, from the stream — not lifecycle phases. Two phase strings for a
  ten-minute run is the failure being fixed.
- **Clean up on every path.** Timers cleared, listeners removed, children reaped, on success, on
  error, and on abort. Honour `ToolContext.signal`.

## 5. Testing

### What gets tested, and how

| Layer            | Method                                                    | Coverage expectation                        |
| ---------------- | --------------------------------------------------------- | ------------------------------------------- |
| Pure core        | Table-driven unit tests, no fixtures                      | Exhaustive — every branch, every flag combo |
| Process boundary | Scriptable fake `grok` on `PATH`, assert on recorded argv | Every spawn path and every failure mode     |
| MCP protocol     | Real SDK client over a real `StdioClientTransport`        | Every tool, happy path plus one error path  |
| Real CLI         | One opt-in integration test behind `GROK_MCP_E2E=1`       | Smoke only                                  |

Principles:

- **Never mock our own modules.** Fakes go at the process boundary — a fake `grok` binary on `PATH`
  that records argv and replays canned stdout and exit codes. Mocking an internal module tests the
  mock.
- **Protocol tests use a real pipe, not `InMemoryTransport`.** Half the point is proving that
  nothing pollutes stdout, and an in-memory transport cannot prove that.
- **Tests never inherit the developer's environment.** `tests/config.test.ts` builds an isolated env
  object rather than touching `process.env`. A test that passes because of your shell is not a test.
- **No network, ever**, outside the `GROK_MCP_E2E=1` test.
- **Test names state the behaviour and the reason**, not the function under test.
  `it('rejects a default above the ceiling instead of clamping it')` — reading the test list should
  teach someone the design.
- **Determinism is mandatory.** No `sleep`-based synchronisation, no assertions on wall-clock
  duration, no fixed ports, no ordering assumptions on concurrent work. A flaky test is deleted or
  fixed the day it flakes; there is no "re-run it" culture here.
- **Every bug fix ships with a regression test named after the failure.** The reliability acceptance
  criteria in [ROADMAP.md](../ROADMAP.md) are written this way on purpose — each one maps to a
  specific defect in the prior-art plugin, so a passing suite is evidence we did not rebuild it.
- **Assert on argv, not on prose.** For a wrapper, argv construction _is_ the behaviour.

### Coverage

Enforced by `npm run test:coverage`, which fails the run below threshold. CI runs it.

| Metric    | Floor |
| --------- | ----- |
| Lines     | 90%   |
| Branches  | 85%   |
| Functions | 80%   |

These are floors, not targets, and they **ratchet**: when the suite sits comfortably above a floor,
raise the floor. Never lower one to make a red build green — that inverts the entire point.

Coverage is a smoke detector, not a goal. 100% line coverage of code with no assertions is worth
nothing, and the aggregate deliberately sits below 100% because `src/index.ts` (process bootstrap,
signal handlers, `process.exit`) is awkward to cover and low-value to chase.

What is **not** negotiable is the pure core. `src/permission.ts` and `src/grok/args.ts` are held at
**100% of all three metrics** — they are pure, they are where correctness lives, and a missing
branch there is a permission or argv bug waiting to ship. `src/config.ts` is held at 100% line and
function coverage with every validation branch exercised; its one uncovered branch is the
`os.homedir()` fallback, which cannot be reached without stubbing a platform call, and stubbing the
platform to chase a number is worse than the gap.

## 6. Dependencies

Runtime dependencies are capped at `@modelcontextprotocol/sdk` and `zod`. That is the whole list and
it is a design constraint, not an accident — this server is a thin wrapper, and a thin wrapper that
drags a 200-package tree into every consumer's `npx` is not thin.

- Adding a runtime dependency requires a written justification in the commit body: what it does, why
  Node stdlib cannot, and its transitive count.
- Process, path, fs, URL, streams, and test all come from Node stdlib.
- Dev dependencies are cheaper but not free. Prefer what the platform ships.
- Version pins are deliberate. TypeScript is pinned to `~5.9.3` because `typescript-eslint@8` peers
  `typescript <6.1.0`, and losing type-aware linting is a worse trade than running one major behind.
  Revisit when the lint toolchain catches up.

## 7. Modules and naming

- One concern per file; the file name says the concern. No `utils.ts`, no `helpers.ts`, no
  `common.ts` — those are names for "I did not decide where this goes".
- No barrel files. Import from the module that defines the thing. The only `index.ts` is the
  executable entry point.
- Explicit `.js` extensions on relative imports (NodeNext), `import type` for type-only imports
  (`verbatimModuleSyntax`).
- Names are spelled out. `configuration` over `cfg`, `request` over `req`, `response` over `res`.
  Standard domain acronyms (`MCP`, `CLI`, `API`, `NDJSON`, `PID`) are fine.
- Functions are verbs (`loadConfig`, `buildArgs`, `resolveBinary`); predicates read as assertions
  (`isWithinCeiling`, `isPermissionLevel`).

## 8. Comments and documentation

- **Comments explain why, never what.** The code says what. If a comment restates the line below it,
  delete the comment; if the line needs one, the line is probably wrong.
- Every non-obvious decision gets a comment naming the alternative rejected and the reason. The
  low-level-`Server` block in `src/server.ts` is the model.
- Module-level doc comments state the module's job in one or two sentences.
- **Verified external facts carry a date.** The `grok` CLI moves fast. Everything in CLAUDE.md's
  "Verified Grok CLI facts" is stamped with the version and date it was checked against, and must be
  re-verified after a CLI upgrade. An undated claim about external behaviour is a claim about the
  past.
- Public-facing docs (README, `docs/`) describe what the software _does today_. Aspirations live in
  ROADMAP.md.

## 9. Workflow

- **Work lands on `main`.** This is a single-maintainer repo; branch-per-change would be ceremony
  with no reviewer on the other end. Revisit if collaborators arrive — the guard against mistakes
  here is a green suite before every commit, not a branch.
- **Never commit red.** `npm run typecheck && npm run lint && npm run format:check && npm test` must
  pass before every commit. CI is a backstop against platform differences, not the first time the
  suite runs.
- **[Conventional Commits](https://www.conventionalcommits.org).** `feat:`, `fix:`, `docs:`,
  `test:`, `refactor:`, `chore:`, `build:`, `ci:`. Subject in the imperative, under ~72 characters.
  The body explains _why_, and names anything a reader would otherwise have to reverse-engineer.
- **One logical change per commit.** A refactor and a behaviour change in the same commit cannot be
  reverted independently, and cannot be reviewed at all.
- No force-push to `main`. History is append-only once pushed.
- Never commit secrets, API keys, or transcripts of real sessions. Fixtures are synthetic.

## 10. Review checklist

Before committing, for anything non-trivial:

- [ ] Is the decision logic in a pure function that a test can call without a process?
- [ ] Does every new error say what to change, not just what broke?
- [ ] Is every new buffer capped and every new child process time-bounded and killed by group?
- [ ] Does the failure path return partial output rather than discarding it?
- [ ] Did any type get declared twice — a JSON Schema beside a zod schema, an interface beside an
      inferred type?
- [ ] Is there a new `any`, a new `as`, a new `!`, or a new suppression? Each needs a reason on the
      line.
- [ ] Does anything new write to stdout?
- [ ] Do the new tests fail if the behaviour regresses? (Break it on purpose and confirm.)
- [ ] Does a claim about `grok` CLI behaviour carry a version and date?
