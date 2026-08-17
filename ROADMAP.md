# Roadmap

Milestones for `grok-build-mcp-server`. Each milestone is independently shippable and ends in a
state where `npm test` passes and the server can be registered with `claude mcp add`.

Background and verified CLI facts live in [CLAUDE.md](CLAUDE.md).

---

## M0 — Scaffold

Get a valid, empty-but-running MCP server into the repo.

**Deliverables**

- `package.json` — ESM, Node >= 22, bin `grok-build-mcp-server`, deps limited to
  `@modelcontextprotocol/sdk` and `zod`.
- `tsconfig.json` (strict, `NodeNext`), `eslint.config.js`, `.prettierrc`, `.gitignore`,
  `.editorconfig`.
- Test setup: `node --test` with `tsx` as the loader. `npm test` runs
  `node --import tsx --test tests/**/*.test.ts`; coverage via `--experimental-test-coverage`.
- `src/index.ts` + `src/server.ts`: stdio transport, `tools/list` returning `check` only,
  `tools/call` dispatching through a handler registry, error envelope that returns `isError: true`
  with readable text instead of throwing.
- `src/config.ts`: env parsing with defaults, exported as a frozen object. Parses and validates
  `GROK_MCP_PERMISSION_CEILING` / `GROK_MCP_DEFAULT_PERMISSION` at startup — an unknown level, or a
  default above the ceiling, fails fast on stderr rather than degrading at call time.
- `LICENSE` — MIT, "Copyright (c) 2026 Jorge Montero Varela". README skeleton, NOTICE if any
  third-party text is carried.
- `.github/workflows/ci.yml`: typecheck + lint + format + build + test on Node 22/24/26, Linux and
  macOS. Node 20 reached end of life on 2026-04-30, so the floor is 22.

**Acceptance**

- `npm run build && node dist/index.js` speaks MCP over stdio; an SDK client completes `initialize`
  and `tools/list`.
- Nothing is ever written to stdout outside the transport.

**Status: complete.** 38 tests passing. `check` is live; protocol tests drive the built server over
a real stdio pipe with the SDK client, and CI asserts stdout purity against the real process.

---

## M1 — Core execution: `check`, `grok`, `help`

The load-bearing milestone. Everything later is a variation on this path.

**Deliverables**

- `src/grok/binary.ts` — resolve `GROK_BINARY` or `grok` on PATH; `grok version` probe with
  `--version` fallback; auth probe via `grok models` (exit 0 = logged in), classifying `ENOENT`,
  non-zero exit, and success distinctly.
- `src/grok/exec.ts` — `spawn(binary, argv)`, never `shell: true` on POSIX; stdin closed
  immediately; 10 MB caps per stream with a truncation marker; `GROK_MCP_TIMEOUT_MS` wall clock
  enforced with SIGTERM then SIGKILL against the process group.
- `src/grok/args.ts` — pure argv builder. Handles prompt, `--cwd`, `--model`, `--effort`,
  `--permission-mode`, `--sandbox`, `--max-turns`, `--tools`, `--disallowed-tools`, repeatable
  `--allow`/`--deny`, `--rules`, `--agent`, and the mutually exclusive session flags (`-r` / `-c` /
  `-s`).
- `src/grok/result.ts` — parse `--output-format json` into
  `{ text, sessionId, stopReason, requestId, usage, totalCostUsd, modelUsage }`; recognize the
  `{"type":"error"}` shape and surface `message` as the tool error.
- Tools: `check`, `help`, and `grok` (synchronous, `--output-format json`).
- `src/permission.ts` — the ceiling model from CLAUDE.md rules 1 and 2. Resolves (requested level,
  default, ceiling) to a concrete `--permission-mode` / `--sandbox` pair, or to a typed rejection
  naming the env var. `check` reports the active ceiling and default.
- `tests/fixtures/fake-grok.mjs` — scriptable fake binary that records argv and replays canned
  stdout/exit codes.

**Acceptance**

- `grok` tool returns the model's text, with `sessionId`, `model`, `usage`, and `total_cost_usd` on
  `content[0]._meta`.
- Table-driven argv tests cover every flag and every mutually exclusive combination.
- Killing a run mid-flight leaves no orphaned `grok` process (verified with a sleeping fake).
- A prompt containing quotes, newlines, `$VAR`, and backticks reaches the child verbatim.
- Ceiling matrix: all nine (requested × ceiling) combinations resolve as specified, and the three
  over-ceiling cases reject with the env var named. No case silently clamps.
- With ceiling and default both `full`, a bare `grok` call with no permission argument emits
  `--always-approve` and never rejects — the unattended path is exercised in CI, not assumed.

**Reliability acceptance** (from CLAUDE.md "Why this exists" — each maps to a named plugin failure)

- A fake that emits 50 MB is capped at 10 MB per stream with a truncation marker, and the process
  stays under a bounded RSS.
- A fake that never exits is killed at `GROK_MCP_TIMEOUT_MS` and returns the output buffered so far,
  not an empty error.
- A fake that writes partial output then exits non-zero returns that partial output alongside the
  error message.
- A fake that emits `{"type":"error"}` surfaces `message` as the tool error, with no attempt to
  parse a result out of it.
- The returned `sessionId` is always the one the CLI reported. No test passes with a locally
  generated UUID.

**Status: complete.** 300 tests passing. `check`, `grok`, and `help` are live. `grok/args.ts` and
`permission.ts` sit at 100% line, branch, and function coverage; the suite as a whole is 95.8% /
87.5% / 91.6% against floors of 90 / 85 / 80.

Verified end to end against grok 1.0.0 (3cd0d0cbce) on 2026-08-16: a prompt through the built server
returned text, `usage` including `reasoning_tokens`, and `total_cost_usd`, and the reported session
id was present in `grok sessions list` — the plugin failure where a run reports an id that does not
resume.

---

## M2 — Progress streaming

Stop MCP clients from timing out on multi-minute agent runs.

**Deliverables**

- `src/grok/stream.ts` — incremental NDJSON reader for `--output-format streaming-json`. Must handle
  chunk boundaries mid-line, blank lines, and unknown `type` values without throwing.
- Event-to-progress mapping: `tool_call` → `Read src/main.rs`-style one-liners, `thought` →
  truncated reasoning, `text` → response text, `end` → final metadata. Debounce to ~100 ms.
- The `grok` handler switches to streaming when the request carried a `progressToken`, and
  reconstructs the same result object from the terminal `end` event that the `json` path produces.

**Acceptance**

- A five-minute fake run streams progress and does not trip the client timeout.
- Streaming and non-streaming paths produce byte-identical result metadata for the same fake
  transcript.
- A truncated / mid-line-killed stream still yields a usable partial result rather than a parse
  crash.
- Progress tracks real work, not lifecycle: a fake transcript containing 12 `tool_call` events
  produces 12 distinct progress messages. Two phase strings for a ten-minute run is the failure
  being fixed.

**Status: complete.** 372 tests. `stream.ts` and `progress.ts` at 100% line, branch, and function
coverage.

Every acceptance criterion is met, and the slow-run one is met by a pair of tests rather than one:
the same fixture succeeds with `resetTimeoutOnProgress: true` and fails without it, so the test
cannot pass vacuously on a run that merely finished quickly. A few seconds of fixture proves the
same mechanism as five minutes.

Verified end to end against grok 1.0.0, not only against fixtures: a real run produced eleven
distinct progress lines — `list_dir .`, `read_file README.md`, `read_file — completed`, interleaved
reasoning and response tails — and the reported session id was present in `grok sessions list`.

Three things the fixtures could not have caught, all found by running the real binary:

- **`finished` arrived before the model's last words.** Pending narration was flushed after the
  stream drained, so the terminal line jumped the queue. Narration is now flushed before any
  discrete event — and before `accept`, not after, since `accept` numbers its emission when called
  and a later flush would carry the higher number.
- **`--max-turns` exits 1 with a complete result.** The handler treated the exit code as the
  authority and returned an error with a raw stdout dump, discarding a resumable session id and the
  spend that bought it. A parsed result now wins over the exit code.
- **Chunked stdout was decoded per chunk**, corrupting any multi-byte character split across a
  boundary. Harmless while nothing consumed `onStdout`; not harmless once a JSON parser does.

---

## M3 — `review`

**Deliverables**

- Git target selection: `uncommitted` (working tree, staged + unstaged + untracked), `base <ref>`
  (merge-base diff), `commit <sha>`. Auto-detect when unspecified: branch diff if the branch has
  commits off `base`, otherwise working tree.
- Diff collection in-process (`git diff`, `git status --porcelain`, `git log`), with a size cap and
  explicit truncation notice, embedded into the review prompt so the model does not have to burn
  turns rediscovering the target.
- Forced `read-only` regardless of the configured ceiling — a review that edits the code it is
  reviewing is never wanted. Requesting a higher level on this tool rejects.
- Optional `structured: true` → `--json-schema` with a findings schema (`severity`, `file`, `line`,
  `summary`, `rationale`), parsed and returned as JSON.
- `annotations: { readOnlyHint: true, destructiveHint: false }` on the tool definition.

**Acceptance**

- Each target mode produces the right diff on a scratch fixture repo (empty repo, detached HEAD, no
  upstream, submodule present).
- `structured: true` returns parsed findings; malformed model JSON degrades to raw text plus a
  `parseError` field rather than failing the call.

**Status: complete.** 506 tests. `review` is live alongside `check`, `grok`, and `help`, built on a
shared run core (`src/tools/run.ts`) extracted from the `grok` handler, which is now argv
construction plus one call.

`--json-schema` turned out to be better than planned: the CLI returns an already-decoded
`structuredOutput` field, on the streaming `end` event as well as the `json` object, so structured
findings and progress streaming compose instead of excluding each other and no text is ever scraped.

Verified end to end against grok 1.0.4 by reviewing this repo's own working tree: 322 progress
notifications, 33 files, `structuredOutput` parsed into four findings, session id present in
`grok sessions list`, `--permission-mode plan --sandbox read-only` in the argv despite a `full`
ceiling.

Four bugs the fixtures could not have caught, all found by running the real binary:

- **A single argv element cannot exceed 128 KiB on Linux (MAX_ARG_STRLEN).** A review of this repo's
  working tree built a 158 KiB prompt, and `spawn` failed with E2BIG before grok started — reported
  as "Failed to start grok", which sends the reader to fix an install that was never broken. Prompts
  over 64 KiB now travel as `--prompt-file`, and the spawn error carries its errno.
- **Untracked directories were expanded without consulting `.gitignore`.** `git status --porcelain`
  collapses an untracked tree into one `?? pkg/` record; walking that record by hand embedded
  `node_modules` and spent the untracked-file cap on dependencies. Replaced with
  `git ls-files --others --exclude-standard -z`, which expands, applies ignore rules, skips
  submodules, and drops the C-quoting that had been silently losing non-ASCII filenames.
- **A timed-out `git diff` resolved as a successful partial.** The kill makes `close` fire with
  whatever bytes arrived, indistinguishable from a complete diff — a review of a fragment, presented
  as a review of the change.
- **The hard-cut truncation path reported `omittedFiles: []`** even though every file behind the
  oversized one was dropped too, so a large lockfile could push the entire source out of a review
  behind a bare byte count.

The first two of those were found by `review` reviewing its own diff.

### M3a — structured review, closed

The multi-turn `--json-schema` behaviour left open above is resolved. **524 tests.** The fix is not
the one predicted there: constraining the reviewer's tools was verified and rejected, because a run
stripped of the tool it needs hunts for it rather than answering from what it has — three wasted
turns and a cancel.

What the verification pass actually found was worse than the reported symptom. Forced to satisfy a
findings-shaped schema on every message, the model narrates its own progress _as findings_. A
cut-off review produced four entries of `severity: "info"` reading
`"Reading the review support modules the new handler calls…"` under `verdict: "placeholder"` —
fabricated defects, structurally identical to real ones. The open item described a review that
returns prose instead of findings; the real risk was a review that returns invented findings and
looks complete.

- **`status: "working" | "final"` is now required by the schema**, and the prompt tells the model to
  emit `{"status":"working","findings":[]}` while it reads and `"final"` exactly once at the end.
  Re-running the same cut-off scenario produced only working placeholders — zero fabricated findings
  — and an unfinished review became detectable rather than merely unlucky.
- **The concatenation is never mined.** `findings.ts` reads `structuredOutput`, or parses `text` as
  one whole JSON value, and nothing else. Decoding a whitespace-separated sequence and taking the
  last object is now explicitly forbidden in the module doc, with the reason: those objects are
  narration.
- **Findings are validated with zod before they reach `_meta`**, and the JSON Schema string handed
  to `--json-schema` is derived from that zod schema via `z.toJSONSchema` rather than hand-kept
  beside it — the same rule the tool inputs already follow.
- **`structuredOutputError` is plumbed through and reported.** The CLI states its own reason
  (`"model did not produce structured output"`); we no longer infer one.
- **A cut-off review is `isError: true`**, with the diagnosis ahead of the raw text. Malformed model
  output stays `isError: false` and degrades to prose, as documented. "No review happened" and "a
  review happened but will not parse" are different answers and now read differently.
- **`maxTurns` is only blamed when the caller set it.** `stopReason: "cancelled"` arrives with no
  `--max-turns` flag and an empty stderr, so the old advice to raise it was wrong in the case it
  fired most.

Also fixed here: `collectDiff` built a `context` string — branch, commit subject, base-range log,
and the `[only the first 100 untracked files were included]` cap notice — that the handler never
passed to the prompt. A working tree with more than 100 untracked files was reviewed as if it were
complete.

Two of these were found by `review` reviewing its own diff: the `working`-after-`end_turn`
misdiagnosis (which told the caller to raise a limit that was never the cause) and the duplicated
schema.

**Left open, deliberately.** Structured completion is stochastic and tracks target size: the same
commit under the same flags reached `end_turn` at 9, 15, and 17 turns and cancelled at 6, 8, and 11
across six runs. The degradation path is therefore a regular path, not a corner case. Making large
structured reviews reliable — chunking the diff, or retrying a cancelled run once — is real work and
has not been attempted.

**Recorded, not fixed** — four findings `review` raised against M3's own `git.ts`, none of them
regressions from this change:

- `git diff --name-only` C-quotes non-ASCII paths while `git ls-files -z` does not, so `_meta.files`
  can mix quoted and unquoted names for the same review.
- The untracked cap counts files, not bytes, so a hundred large untracked files still blow past any
  sensible review budget.
- `git` is spawned in the server's own process group and killed by child pid, so a grandchild
  survives the timeout kill.
- A buffer-capped `git` fragment is reported to the model with a truncation marker but not to the
  caller. Investigated and **downgraded**: the git cap is 10 MB against a 256 KB review cap, so
  anything reaching it is truncated again by `truncateDiff` and `diffTruncated: true` is reported
  either way. Worth tidying, not a shippable bug.

---

## M4 — Sessions ✅

Shipped 2026-08-17. `sessions` lists, searches, and looks up real Grok sessions by reading
`$GROK_HOME/sessions` directly; every run that reports a session id now also reports the command
that resumes it.

**Deliverables**

- `sessions` tool backed by `grok sessions list|search` — real, persistent sessions, not an
  in-process map.
- Resume ergonomics on the `grok` tool: `resume: "<id>"`, `continue: true`, and `fork: true`
  (`--fork-session`). Enforce the CLI's real constraints: `-s` is create-only and requires a fresh
  UUID; with `-r`/`-c` it is only valid alongside `--fork-session`.
- Return `resumeCommand: "grok -r <id>"` in metadata so a human can pick the thread up in a
  terminal.

**Acceptance**

- Two sequential `grok` calls sharing a `resume` id demonstrably share context (integration test
  behind `GROK_MCP_E2E=1`).
- Invalid session combinations are rejected by us with an actionable message before the CLI is
  spawned.
- A session id returned by a `grok` call is findable via the `sessions` tool immediately afterward.
  A reported id that does not exist in `~/.grok/sessions` is a test failure — this is the plugin's
  "session id that does not resume" bug.

**Delivered.** All three acceptance criteria pass against grok 1.0.4, the first two in
`tests/e2e/sessions.e2e.test.ts` (`GROK_MCP_E2E=1`, skipped in a normal run): a marker word given to
one call is recalled by the next through `resume`, and the reported id is found both by `id` lookup
and in a `cwd`-scoped list. The session-conflict matrix was already enforced in M1 and needed no
work.

**Deviation from the plan, deliberately.** The tool does not shell out to
`grok sessions list|search`. `list` has no `--json` flag and prints a fixed-width table scoped to
the current directory; scraping it is exactly the failure mode this repo exists to avoid. The store
is read directly instead — `summary.json` is already structured, and reading it is what makes cwd
scoping, id lookup, and the first-prompt fallback possible at all. **What that costs:**
`grok sessions search` also consults a remote index, so sessions that exist only server-side are
invisible to us. The tool's own description says so rather than implying completeness.

**A fresh session has no title, which drove the design.** Verified across 117 sessions: a headless
run leaves `session_summary: ""` and no `generated_title`, so the sessions this server creates are
precisely the ones a title-only lister shows as blank rows. Each row therefore falls back to the
first user prompt, read from a bounded 128 KiB head of `chat_history.jsonl`, and `titleSource`
reports which of the two the label came from — a fallback we invented is never presented as a title
Grok wrote.

**Found by reviewing the M4 diff with the repo's own `review` tool, and fixed:**

- `query` matched only within the 200-session first-prompt window, so a title or id hit on the 201st
  most recent session came back as "no matches". Title and id now match across every loaded record;
  the cap bounds history reads only, and a truncated prompt search says so.
- An `id` lookup went through the 2000-directory scan cap in readdir order, so on a large store the
  newest sessions — including one just created — could answer `found: false`. That is the plugin bug
  this milestone exists to invert. Lookup is now direct: the id is the directory name, so it reads
  one summary and no longer scans.
- The same cap could hide the newest sessions from a list. When the cap actually bites, directories
  are now `stat`-sorted by mtime first; below the cap nothing extra is paid.
- `_meta.sessions[]` reported `titleSource: "prompt"` while carrying neither the prompt nor the
  label, leaving a machine consumer unable to tell fresh sessions apart. Both are now included.
- `summary.json` was read unbounded while histories were capped. Now 256 KiB, and an oversized file
  degrades to `unreadable` rather than into memory.
- An encoded-cwd directory that could not be listed dropped a whole project's sessions with only a
  debug log. Counted as `unlistedDirs` and surfaced in the partial-listing line.

### The reliability bug M4 uncovered in shipped code

Dogfooding M4 through `review` produced two runs in a row that returned `isError: false` with a body
of pure narration — _"I'll start by reading the full review request…"_ — and no review. The event
log gave the mechanism, and it is the most valuable thing this milestone produced:

**In headless mode, a permission request that cannot be granted cancels the whole run, and the CLI
still exits 0.** 18 runs in this machine's store died that way; 15 of them reaching for
`run_terminal_command`. `--permission-mode dontAsk` behaves the same. An explicit `--deny` rule, by
contrast, is recoverable — the model is told no and finishes its answer. Full evidence is in
CLAUDE.md under "An unapprovable tool request kills the run".

Fixed in four places:

- `review` passes `--deny 'Bash(*)' 'Edit(*)' 'Write(*)'`, so a reviewer that reaches for a shell is
  refused instead of killed. This narrows what review may do; it does not widen it.
- The review prompt now states plainly that there is no shell and no edit tool in this run.
- A cut-off prose review is `isError: true` with the diagnosis leading the body, matching what
  structured mode already did. The default mode of the tool was the one without the check.
- `run.ts` marks any run whose stop reason is not `end_turn`, including on exit 0. Before, a
  cancelled run was indistinguishable from a finished one in the tool result.

With those in place the same review completed in 12 turns and found the six defects listed above.

**Left open, deliberately.** Search is local-only (above). The first-prompt fallback reads at most
the 200 most recent histories per query, and a truncated search reports itself rather than
pretending to be exhaustive. `sessions delete` is not exposed: M4 is a read-only milestone, and a
destructive session tool needs its own thinking about confirmation.

---

## M5 — Background runs: `status`, `stop`

Where this server surpasses `codex-mcp-server`, which is synchronous-only. Split in two: M5a is the
infrastructure and `status`, M5b is `stop`.

### M5a — background runs and `status` ✅

Shipped 2026-08-17. `grok` and `review` take `background: true` and return a `runId`; a detached
worker runs the job to completion and `status` polls it.

**Deliverables**

- `background: true` on `grok` and `review` returns a `runId` immediately.
- `src/jobs/store.ts` — atomic on-disk run records under `GROK_MCP_STATE_DIR`: id, state, argv, cwd,
  both PIDs (worker and `grok` child), start/end timestamps, output log path. Records survive an MCP
  server restart.
- `src/jobs/runner.ts` — detached worker that streams the run to a log file and writes the terminal
  record.
- `status` tool: poll one run or list recent runs; optional `waitMs` to block briefly.

**Acceptance**

- Restarting the MCP server mid-run leaves `status` still able to report.
- Two concurrent background runs in the same repo do not clobber each other's records.

**Delivered.** Both criteria pass, the first by launching a run from a node process that exits the
moment the call resolves and then polling from a different process. Verified end to end against grok
1.0.4: the launcher exited, the worker finished in 2s, `status` replayed the model's text, and the
session id it reported was found by the `sessions` tool immediately afterward.

**Background is a transport, not a second implementation.** The worker re-enters `invokeTool` with
the same validated input, so `status` on a finished run returns what the synchronous call would have
returned — same text, same `_meta`, same error flag. Everything a background run gains (progress
lines, a stored argv, a pid) comes from the same `runGrok` path the foreground uses, through a
`runSink` on `ToolContext` that a foreground call simply leaves undefined.

Validation stays synchronous: a session conflict or a request above the permission ceiling is
rejected as a failed call, never as a `runId` for a run that will die a second later.

**One record, one writer at a time.** `record.json` is read-modify-written, so the whole design
rests on exclusive ownership: the server writes it once at creation and never again, the worker owns
it while it runs, and the terminal transition belongs to whoever wins a single
`open(terminal.claim, 'wx')` — one syscall decides, with no lock to time out. Three mechanisms
enforce that rather than assuming it, and each of them exists because the first cut got it wrong:

- **`finalizeRun` claims, writes, and unlinks the claim if the write does not land.** A claim is a
  promise to write a terminal state; a claimant that cannot keep it has to give it back. Without
  this, a claim taken before a failed write left a run that _no process could ever terminalise_ —
  the worker's error path, `status`, and M5b's `stop` would all get `lost` and give up.
- **The worker drains every in-flight patch before it finalizes.** A progress flush that had already
  read the record could otherwise rename its version over the terminal one: the result gone, the
  state back to `running`, and the claim already spent. A forced interleaving lost the record in 9
  of 200 attempts before the fix and 0 of 25 after.
- **`status` derives an orphan's `abandoned` state for display and persists nothing.** That keeps
  its `readOnlyHint: true` honest, makes list-mode reconciliation free, and — the real reason —
  keeps a third writer off the record. Retention sweeps a dead non-terminal record once it ages out.

**Found by reviewing the M5a diff with the repo's own `review` tool, and fixed.** Beyond the three
above: a worker could exit without the record ever reaching a terminal state (a prompt over
`INPUT_MAX_BYTES` was written, handed back a `runId`, and then silently abandoned by a worker that
could not read it back); `createRun` now enforces that cap at the call. A `failed` or `abandoned`
run polled as `isError: false`, because the flag was read only from a stored result and those runs
have none — the foreground equivalent throws. And **a cut-off run was stored as `completed`**:
`review` passes an `isError` callback that catches a non-`end_turn` stop, `grok` deliberately does
not, so a permission-cancelled run was recorded as a clean finish with the only evidence a footnote
in the body. The replayed `isError` still matches the foreground exactly; the _state label_ now
reports `completed (cut off: cancelled)`. The flag replays the tool, the label describes the run.

**Left open, deliberately.** The store primitives remain last-writer-wins — `finalizeRun` and the
drain make the production paths safe, but the invariant is stated at the call site rather than
enforced by the file format. M5b has to close that properly, because `stop` finalizes from the
server process while the worker is still patching progress, and no drain on the worker's side can
see it coming. A generation counter checked at write time, or moving progress out of `record.json`
entirely, is the M5b design problem.

### M5b — `stop`

**Deliverables**

- `stop` tool: terminate the whole process tree, worker and child; claim the terminal state under a
  lock so a finishing worker cannot overwrite `cancelled` with `completed`.
- Preserve a result that lost the terminal claim: a run cancelled at turn nine has been paid for and
  may carry a session id that resumes everything it did.
- Close the cross-process write race described above.

**Acceptance**

- Restarting the MCP server mid-run leaves `stop` still able to kill.
- Concurrent `stop` and natural completion resolve to exactly one terminal state.

---

## M6 — `websearch`

**Deliverables**

- Web-search-shaped prompt with `numResults` (1–50) and `searchDepth` (`basic` | `full`).
- Read-only defaults; never pass `--disable-web-search`.
- Surface `server_tool_use.web_search_requests` from the result usage when present.

**Acceptance**

- Returns cited results in an integration test; degrades with a clear message when the account has
  web search disabled.

---

## M7 — Public release

**Deliverables**

- `README.md`: architecture diagram, quick start
  (`claude mcp add grok-build -- npx -y grok-build-mcp-server`), tool table, one-click install
  badges for VS Code / Cursor, requirements (grok >= 1.0.0, Node >= 20), env var table.
- `docs/api-reference.md` — full parameter and response reference per tool.
- `docs/security.md` — the permission ceiling model, why the grant is registration-time rather than
  per-call, what `full` actually authorizes, sandbox caveats (Linux-only child-network blocking),
  and what an operator is trusting when they register this server.
- npm publish workflow on tag; provenance enabled.
- `CHANGELOG.md`, issue and PR templates.

**Acceptance**

- A clean machine can go from zero to a working tool call using only the README.
- `npx -y grok-build-mcp-server` works from the published tarball (`files` includes `dist` only).

---

## Deferred / evaluated and rejected

- **`grok import` transfer of Claude transcripts** — the subcommand does not exist in grok 1.0.0
  despite the bundled plugin calling it. If transcript transfer is wanted later, read the Claude
  `.jsonl` ourselves and pass it via `--prompt-file`.
- **`grok agent stdio` (ACP) as the transport** — a richer, bidirectional interface that would allow
  interactive tool approval instead of pre-committed permission modes. Far larger surface than `-p`.
  Revisit only if approval-in-the-loop becomes a requirement.
- **`--worktree` isolation** — attractive for safe write runs, but headless `-p` does not create a
  worktree from the flag. Would need `grok worktree` orchestration first.
- **Critique tool** (the plugin's `/grok-build:critique`) — a prompt variant of `review`. Fold in as
  a `mode: "critique"` parameter on `review` rather than a separate tool, if wanted.

---

## Open decisions

| Decision             | Recommendation                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~License~~          | **Resolved: MIT.**                                                                                                                                      |
| ~~npm package name~~ | **Resolved: `grok-build-mcp-server`.** Verified unclaimed on 2026-08-16 (E404). Unrelated `grok-mcp-server@0.2.4` already exists — do not use that name |
| ~~Default model~~    | **Resolved: `grok-4.6`, effort `high`.** Overridable via `GROK_MCP_DEFAULT_MODEL` / `GROK_MCP_DEFAULT_EFFORT`                                           |
| ~~Test runner~~      | **Resolved: `node --test` + `tsx`.** See below                                                                                                          |

### Why `node --test` over Jest

Jest's strengths are module auto-mocking, snapshots, and watch UX. This project uses none of them —
our test strategy is a **fake `grok` binary on `PATH`** plus table-driven assertions on a pure argv
builder. Nothing gets module-mocked, so Jest's main advantage does not apply.

Against that, the costs are real:

- **Dependency weight on a repo whose whole thesis is being thin.** CLAUDE.md limits runtime deps to
  the MCP SDK and zod. Jest adds a large dev tree; `node --test` adds nothing.
- **ESM + TypeScript friction.** Jest needs `ts-jest` or `babel-jest` plus
  `NODE_OPTIONS=--experimental-vm-modules` to run native ESM. This repo is `"type": "module"` with
  `NodeNext` resolution — exactly the configuration that combination handles worst.
- **Contributor onboarding on a public repo.** `git clone && npm i && npm test` with no transform
  layer to misconfigure.

`node:test` is stable from Node 20, which is already the floor, and ships subtests, concurrency,
watch, and coverage. If a richer runner is ever wanted, **vitest** is the one to reach for — native
ESM/TS, Jest-compatible API — not Jest.
