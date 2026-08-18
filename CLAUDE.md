# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Overview

This repo builds **`grok-build-mcp-server`** — an MCP (Model Context Protocol) stdio server that
exposes the [Grok Build](https://x.ai) CLI (`grok`) as tools callable from Claude Code, Cursor, VS
Code, and any other MCP client.

```
Claude Code  ──stdio/MCP──▶  grok-build-mcp-server  ──spawn──▶  grok CLI  ──▶  xAI API
```

The server is a **thin, well-typed process wrapper**. It does not reimplement agent logic, does not
maintain its own conversation state beyond a job registry, and does not talk to the xAI API
directly. All intelligence lives in the `grok` CLI; our job is faithful argument construction,
robust process supervision, and clean MCP-shaped output.

The repo is intended to be **published publicly** and released to npm.

## Why this exists

Driving out of a real workflow gap: when Codex usage runs out and work shifts to Grok Build via the
bundled `/grok-build:*` plugin commands, the handoff is unreliable — responses, run monitoring, and
session handling are all hit-and-miss. The plugin is prior art, not a target to match. **Reliability
is the product.** Every failure mode below is a specific thing this server must not reproduce.

| Failure mode in the plugin                                                                                                                                           | Where                                    | What we do instead                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Parses model output by scraping prose — tries `JSON.parse`, then a ` ```json ` fence, then slicing between the first `{` and last `}`                                | `lib/grok.mjs` `parseStructuredOutput()` | `--output-format json`; the result object is read from a documented field, never recovered from prose                       |
| Defaults to `--output-format plain`, so structured fields must be reconstructed                                                                                      | `lib/grok.mjs` `buildHeadlessArgs()`     | `json` or `streaming-json` always; `plain` is not an internal code path                                                     |
| Invents its own `crypto.randomUUID()` session id, passes it as `--session-id`, and reports it as the run's session — including on paths where Grok never recorded it | `lib/grok.mjs` `runHeadlessAgent()`      | Report the `sessionId` Grok returns. Reconcile against `grok sessions` — the CLI's own session store is the source of truth |
| Unbounded output accumulation (`stdout += chunk`) with no cap                                                                                                        | `lib/grok.mjs` `runHeadlessAgent()`      | 10 MB cap per stream with an explicit truncation marker                                                                     |
| No wall-clock timeout and no kill path in the headless runner                                                                                                        | `lib/grok.mjs` `runHeadlessAgent()`      | `GROK_MCP_TIMEOUT_MS`, SIGTERM then SIGKILL against the process group                                                       |
| `child.on("error")` rejects and discards everything buffered so far                                                                                                  | `lib/grok.mjs` `runHeadlessAgent()`      | Partial output is always returned alongside the error                                                                       |
| Progress is two coarse phase strings — `starting`, then `finalizing`. Blind for the entire run                                                                       | `lib/grok.mjs` `emitProgress()` calls    | Parse `streaming-json` and forward per-event `notifications/progress`                                                       |
| Calls `grok import`, a subcommand that does not exist in 1.0.0                                                                                                       | `lib/grok.mjs` `runImport()`             | Not built. See "Known drift" below                                                                                          |

The stated success condition: a long Grok run started from Claude Code is observable while it runs,
survives an MCP server restart, reports a session id that actually resumes, and never hangs forever.

## Reference implementations

Two prior-art implementations are installed on this machine. Read them for shape, **never copy code
from them** — this repo ships its own implementation under its own license.

| What                                           | Path                                                                | Why it matters                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `codex-mcp-server` v1.4.10 (ISC)               | `~/.npm/_npx/746dc9d72b19c68b/node_modules/codex-mcp-server/dist/`  | The MCP-server pattern we are mirroring: tool definitions, handler registry, spawn wrapper, progress notifications |
| `grok-build` Claude plugin v0.2.0 (Apache-2.0) | `~/.claude/plugins/marketplaces/xai-grok-build/plugins/grok-build/` | Prior art for driving `grok` from Claude Code: job control, PID tracking, review prompts, write-policy layering    |
| Grok CLI user guide                            | `~/.grok/docs/user-guide/`                                          | Authoritative CLI docs. `14-headless-mode.md` and `18-sandbox.md` are the two that matter most                     |

The plugin is reachable in-session as `/grok-build:<command>` (`check`, `review`, `critique`,
`delegate`, `runs`, `show`, `stop`). Use `/grok-build:check` to confirm the local CLI is healthy
before debugging our own server.

## Verified Grok CLI facts

Verified against **grok 1.0.0 (3cd0d0cbce) [stable]** and re-verified against **grok 1.0.4
(d846eb93d9) [stable]**, both on 2026-08-16. Everything below held across that upgrade except where
a line says otherwise. Re-verify after any CLI upgrade; the CLI moves fast and the plugin above has
already drifted from it.

### Headless invocation

```bash
grok -p "<prompt>" --output-format json --cwd <dir> --permission-mode plan --sandbox read-only
```

- `-p` / `--single` triggers headless mode. `--prompt-file` and `--prompt-json` also do.
- Headless mode **does not read piped stdin** into the prompt. Pass content via the prompt string or
  `--prompt-file`.
- `--output-format`: `plain` (default), `json`, `streaming-json`, `streaming-messages-json`.
- `json` prints a single object on **stdout** and exits 0. stderr stays clean (update notices go to
  stderr, never stdout). Confirmed live:

```json
{
  "text": "OK",
  "stopReason": "end_turn",
  "sessionId": "01a00a41-8f57-7de2-bb03-caccc61a1f0e",
  "requestId": "...",
  "thought": "...",
  "usage": {
    "input_tokens": 16424,
    "cache_read_input_tokens": 896,
    "output_tokens": 32,
    "total_tokens": 17352
  },
  "num_turns": 1,
  "total_cost_usd": 0.00569296,
  "total_cost_usd_ticks": 56929600,
  "modelUsage": { "grok-4.6-build": { "...": 0 } }
}
```

- On failure the CLI emits `{"type":"error","message":"..."}` and exits non-zero.
- Exit codes: `0` success, `1` error, `130` SIGINT, `143` SIGTERM.
- **A non-zero exit does not mean there is no result.** `--max-turns N` that hits its cap exits `1`
  with `Error: max turns reached` on stderr, while stdout carries a complete result —
  `stopReason: "cancelled"`, a real `sessionId`, real `usage`, real `total_cost_usd`. Parse stdout
  first and let a successful parse win over the exit code, or you discard a resumable session and
  the spend that produced it.

#### `streaming-json`

NDJSON, one `type`-tagged object per line. Captured live from a two-turn run on 2026-08-16: `text`
×112, `thought` ×74, `available_commands` ×4, `usage` ×2, `tool_call_update` ×2, `tool_call` ×1,
`end` ×1. stderr was empty. The type list is **not** closed — a `--max-turns` run emitted
`max_turns_reached`, which appears in no documentation. Switch on `type` and route the unrecognised
to a catch-all; never throw on an unknown tag.

```jsonc
{"type":"text","data":"I'll"}                       // a DELTA, not the whole message
{"type":"thought","data":"The user wants"}          // also a delta
{"type":"tool_call","toolCallId":"call-…-0","title":"list_dir","kind":"list","status":"pending",
 "toolName":"list_dir","rawInput":{"target_directory":"."},"content":[],"locations":[]}
{"type":"tool_call_update","toolCallId":"call-…-0","status":null,"locations":[{"path":"."}],…}
{"type":"usage","usage":{…},"signature":"…"}        // PER-TURN, and has no total_tokens
{"type":"end","stopReason":"end_turn","sessionId":"…","usage":{…},"num_turns":2,
 "total_cost_usd":0.00891208,"modelUsage":{…}}
```

Four things that are easy to get wrong:

- **`end` has no `text` field.** The `json` object has one; the `end` event does not. Response text
  exists only as the concatenation of `text` deltas, in order.
- **A failing run ends with `error` and no `end`.** Verified with a bad `--model`. Any code that
  waits for `end` before reporting will wait forever.
- **`usage` events are per-turn and lack `total_tokens`.** Only `end.usage` is the aggregate. Do not
  sum the per-turn events.
- **`tool_call` arrives with `locations: []`**; the path shows up in a later `tool_call_update`,
  whose `status` is `null` mid-flight and a terminal string at the end.

In 1.0.4 the `end` event also carries `requestId`, which 1.0.0 emitted only on the `json` object.
Read it as optional — it is not worth a version check.

#### `--json-schema`

`--json-schema '<schema>'` constrains the model to produce JSON matching the schema. Verified live
on 1.0.4; the flag is absent from the 1.0.0 notes above only because it was never probed then.

Three facts, all verified with a two-field schema on 2026-08-16:

- **The result gains a `structuredOutput` field holding the parsed object.** Not a string — an
  already-decoded value, sitting alongside `text` (which carries the same JSON as a string). Read
  `structuredOutput`; parsing `text` is the scraping this repo exists to avoid.
- **`structuredOutput` appears on the streaming `end` event too**, not only on the `json` object.
  Structured output and progress streaming are therefore not mutually exclusive, and the
  json/streaming metadata identity from M2 survives.
- **The schema constrains every assistant message, not just the last one.** A multi-turn run emits
  one JSON object per turn, so the concatenated `text` deltas are not valid JSON. Only a run that
  reaches `end` carries `structuredOutput`. Treat `structuredOutput` as the sole source and a
  non-`end_turn` stop reason as the explanation when it is missing — do not try to recover the last
  object out of the concatenation.
- **"Implies `--output-format json`" in `--help` is not the whole truth.** An explicit
  `--output-format streaming-json` wins over the implication: the run streamed 78 NDJSON lines and
  still produced `structuredOutput` on `end`. Only an _unset_ output format is forced to `json`.

Four more, measured on 2026-08-16 while building the `review` tool's structured mode. These are the
ones that decide whether structured output is safe to ship:

- **Constrained by a findings-shaped schema, the model narrates its own progress as findings.** It
  has no other channel: every message must satisfy the schema, so "I am reading X" comes out shaped
  like a defect report. A `--max-turns 4` review produced four entries of `severity: "info"`,
  `file: <whatever it was reading>`,
  `summary: "Reading the review support modules the new handler calls…"`, all under
  `verdict: "placeholder"`. Nothing in the object marks it as narration. **Give the schema a
  required `status: "working" | "final"` discriminator and tell the model how to use it.** The same
  cut-off run then emitted only `{"status":"working","findings":[]}` — zero fabricated findings —
  and an uncompleted run became detectable instead of merely unlucky. Without a discriminator there
  is no way to tell a real finding from the model thinking out loud, which is why "recover the last
  object from the concatenation" is not just inelegant but unsafe.
- **The `end` event carries `structuredOutputError` when `structuredOutput` is missing**, and omits
  it otherwise. Observed value: `"model did not produce structured output"`. Read it instead of
  inferring a cause from the stop reason.
- **`stopReason: "cancelled"` does not imply a turn cap.** Captured with no `--max-turns` flag at
  all, empty stderr, and no `max_turns_reached` event. Only blame the turn budget when the caller
  actually set one — otherwise the advice sends them to spend more money on the same failure. The
  most common cause turned out to be something else entirely: see "An unapprovable tool request
  kills the run" below.
- **Completion is stochastic and tracks target size.** The same commit, same flags, same schema
  reached `end_turn` at 9, 15, and 17 turns and cancelled at 6, 8, and 11 across six runs. A larger
  target failed more often. Structured output is best-effort; the degradation path is not a corner
  case to be tidied up later, it is a path that runs regularly.

### Models and effort

`grok models` on this account lists exactly two: `grok-4.6` (default) and `grok-4.5`. Our defaults
are **`--model grok-4.6 --effort high`**, verified accepted together on 2026-08-16 (exit 0, clean
stderr).

Two things to know:

- **The id you pass is not the id you get back.** `--model grok-4.6` is accepted, but the response's
  `modelUsage` is keyed `grok-4.6-build`. Do not round-trip the reported key back into `--model`,
  and do not validate a caller's model string against the reported key.
- **`usage` fields are conditional.** With `--effort high` the response gains `reasoning_tokens` and
  `cache_creation_input_tokens`; a default-effort run omits them. Treat every `usage` member as
  optional — read what is present, never assume a fixed shape.

Do not hard-code the model list. It is account- and version-dependent; pass the caller's string
through and let the CLI reject unknown ids.

### Sessions

- Every `grok -p` starts a **fresh** session unless told otherwise.
- `-r <id|title>` resumes; `-c` continues the most recent session for the cwd.
- `-s <uuid>` creates a **new** session with a caller-chosen UUID. It does **not** resume, and it
  errors if the UUID already exists. With `-r`/`-c` it requires `--fork-session`.
- Sessions are enumerable via `grok sessions list|search`. **Prefer the CLI's own store over an
  in-memory map** — this is the main correctness win over `codex-mcp-server`, whose sessions die
  with the server process.
- **The store is a directory tree, not a SQLite database.** Verified on 2026-08-16:

  ```
  ~/.grok/sessions/<percent-encoded-cwd>/<session-uuid>/
      summary.json          chat_history.jsonl    events.jsonl
      prompt_context.json   system_prompt.txt     updates.jsonl    …
  ~/.grok/sessions/session_search.sqlite     # search index only, not the record of truth
  ```

  The cwd segment is percent-encoded, so `/home/nuru/repos/x` becomes `%2Fhome%2Fnuru%2Frepos%2Fx`.
  `summary.json` is the useful one and is already structured: `info.id`, `info.cwd`,
  `session_summary`, `created_at`, `updated_at`, `num_messages`, `current_model_id`, `git_root_dir`,
  `git_remotes`, `head_commit`.

- **`grok sessions list` has no `--json` flag.** It prints a fixed-width text table. Read
  `summary.json` rather than scraping that table — the table is presentation and will change.

Five more, measured across the 119 sessions in this machine's store while building the `sessions`
tool on 2026-08-17:

- **`summary.json` exists the moment a headless run exits**, so a session id a call reports is
  findable immediately. But a fresh headless session has `session_summary: ""` and **no
  `generated_title`** — titles are filled in later, if ever. The sessions this server creates are
  therefore exactly the ones with no title, and a lister that only reads title fields shows its own
  work as blank rows.
- **Field presence is not uniform.** Always present: `info.id`, `info.cwd`, `session_summary`,
  `created_at`, `updated_at`, `num_messages`, `current_model_id`, `agent_name`, `sandbox_profile`,
  `reasoning_effort`. Often absent: `generated_title` (99/117), `head_branch` / `head_commit` /
  `git_remotes` / `git_root_dir` (92/117 — absent outside a repo), `request_id` (112/117). Parse
  every field as optional.
- **The first real user prompt is recoverable from `chat_history.jsonl`**, which is the only label a
  fresh session has. It is NDJSON; the system prompt and synthetic user messages (environment
  preamble, `<system-reminder>` blocks carrying `synthetic_reason`) come first. The prompt is the
  first `{"type":"user"}` line that also carries a **`prompt_index`** key — 110 of 118 histories.
  Fallback for the rest: the first user line whose text contains `<user_query>`. Text lives in
  `content[]` blocks of type `text`.
- **The `<user_query>` wrapper is not always closed.** When grok offloads a large prompt it stores a
  ~20 KB head plus a pointer to `prompts/prompt_0.txt`, so the stored message has an opening tag and
  no closing one. Strip the two tags independently or the tag ends up in the label.
- **`grok -r <id>` resumes from any directory**, and the session stays recorded under the cwd it
  started in — no directory is created for the resuming cwd. Verified by resuming a `/tmp/a` session
  from `/tmp/b`: correct recall, exit 0, and on stderr
  `Session <id> found locally (originally in /tmp/a)`. So `grok -r <id>` is honest advice with no
  `--cwd`, and a record's cwd is where the session _started_, not everywhere it has run.

- **A killed run still leaves a resumable session**, and the store is the only place to find it.
  Measured on 2026-08-17 by SIGTERMing a real headless run at 20 seconds: `summary.json` existed
  with `created_at` **0.283s after the run started**, and the id resumed cleanly afterwards —
  `grok -r <id>` returned the same `sessionId` and `end_turn`. No `end` event ever carried that id,
  because the run never reached one. So a run that dies mid-flight has a session worth reporting,
  and reading it back from `~/.grok/sessions` is the only way to report it without inventing one.

  The lower bound of a search window can be exact — the session is always created after the run
  starts — but `created_at` is stamped at session creation, not at flush, so it can never fall after
  the moment the process was killed. The real failure is `summary.json` not being readable yet for a
  run killed in its first moments; that degrades to finding nothing, which is the honest answer.

### An unapprovable tool request kills the run

The single most expensive headless behaviour found so far, verified on 1.0.4 on 2026-08-17. When the
model asks for a tool that cannot be approved without a human, the CLI does not refuse the tool — it
**cancels the entire run**, and still exits 0:

```
permission_requested   tool_name=run_terminal_command
permission_resolved    tool_name=run_terminal_command  decision=cancelled  wait_ms=0
turn_ended             outcome=cancelled  cancellation_category=permission_cancelled
```

The model's tool result reads `"User cancelled the execution for tool run_terminal_command"` — there
is no user. Across this machine's store, 18 runs died this way: 15 on `run_terminal_command`, 2 on
`search_replace`, 1 on `use_tool`. `--permission-mode dontAsk` behaves identically (cancelled at
turn 1), despite the docs describing it as denying rather than prompting.

**An explicit `--deny` rule is recoverable where a permission prompt is fatal.** Same prompt, same
`--permission-mode plan --sandbox read-only`:

| Flags                                                                          | Outcome                                                                                  |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| none                                                                           | `stopReason: "cancelled"`, turn 1, no answer                                             |
| `--deny 'Bash(*)'`                                                             | `stopReason: "end_turn"` — _"Could not run it (denied by permission policy); FALLBACK."_ |
| `--deny 'Bash(*)' --deny 'Edit(*)' --deny 'Write(*)'` (edit + shell asked for) | `end_turn` in 3 turns, file unchanged, both refusals reported and the answer finished    |

So a read-only agent should be given deny rules for what it must not do, not merely a permission
mode that will refuse it. Plan mode alone looks equivalent and is not.

Two consequences for our own code, both now implemented: `review` passes one `--deny` per rule, and
**no path may report a cut-off run as a finished result**. Exit code 0 with a non-`end_turn` stop
reason is a fragment, and this is how a review that did nothing came back looking successful.

### Prompt offloading is not limited to `--prompt-file`

A large **inline `-p`** prompt is offloaded too. Measured over the same 119 sessions: 95 stored the
prompt inline (largest 11,185 chars), 22 were offloaded, and every offloaded one stored a ~20,056
char head plus a pointer the agent must `read_file`. The threshold sits somewhere between those two
figures; it was not worth spending runs to pin down exactly.

The practical point is that `INLINE_PROMPT_MAX_BYTES` (64 KiB) protects against **E2BIG, not
offloading**. A 40 KB prompt we pass inline is still split, still costs turns to read back, and the
model may report the prompt as truncated. Budget turns accordingly for any tool that embeds a diff.

### Safety flags

| Flag                             | Values                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `--permission-mode`              | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`                   |
| `--sandbox`                      | `off` (default), `workspace`, `devbox`, `read-only`, `strict`                              |
| `--always-approve`               | alias `--yolo`, equivalent to `--permission-mode bypassPermissions`                        |
| `--allow` / `--deny`             | one `ToolPrefix(glob)` rule per flag, repeat the flag: `--deny 'Bash(*)' --deny 'Edit(*)'` |
| `--tools` / `--disallowed-tools` | comma-separated internal tool ids (shell is `run_terminal_command`, not `bash`)            |
| `--max-turns <N>`                | headless only                                                                              |

`--sandbox read-only` blocks child-process network on Linux (seccomp); it is a no-op on macOS. Do
not describe it as a network guarantee in cross-platform docs.

Three traps in the tool-list flags, all verified on 1.0.4 on 2026-08-16:

- **`--tools ''` is a no-op, not "no tools".** An empty list is ignored, and the run keeps its full
  toolset — verified by asking a run with `--tools ''` to read a file, which it did. There is no
  spelling that removes every tool.
- **`--tools <id>` really does restrict**, but `search_tool` and `use_tool` survive it. A run given
  `--tools todo_write` reported exactly `search_tool`, `use_tool`, and `todo_write`.
- **Unknown ids are accepted in silence.** `--disallowed-tools not_a_real_tool` exits 0 and blocks
  nothing. A typo'd id disables nothing and reports nothing, so a deny list cannot be trusted
  without a positive test.

Taking away a tool the task needs does not make the model answer from what it already has — it makes
it hunt. Asked to read a file with no file-reading tool, a run spent three turns looking for one and
then cancelled. Constrain the prompt, not the toolset, when the goal is fewer turns.

**The two `disallowed` spellings are different flags.** `--disallowedTools` is a compat _alias for
`--deny`_ and takes one `ToolPrefix(glob)` rule; `--disallowed-tools` takes a comma-separated list
of built-in tool ids. `--allowedTools` aliases `--allow` the same way. A hyphen decides which of two
unrelated flags you get, and neither errors on the other's argument shape — verified in
`grok --help` on 1.0.4. We emit `--disallowed-tools` and `--allow`/`--deny`.

### Web search

Measured on 1.0.4 on 2026-08-17. `grok --help` has exactly one web-related flag —
`--disable-web-search` ("Disable web search and web fetch tools"). There is no result-count flag, no
depth flag, and no way to force a search. **Result count and depth are prompt shaping, not
configuration.**

This account's web and X tool ids, from a run asked to enumerate its own tools: `web_search`,
`web_fetch`, `open_page`, `open_page_with_find`, `x_user_search`, `x_semantic_search`,
`x_keyword_search`, `x_thread_fetch`.

- **A web search is a server-side tool call, and the `tool_call` event carries no query.** It
  arrives as `rawInput: {"variant":"WebSearch","backend":true}`, with `title: "Web search:"` and
  nothing after the colon. The query and the URLs land on the matching `tool_call_update`, under
  `rawOutput.action`:

  ```jsonc
  {"action":{"type":"search","query":"latest stable Node.js release version",
             "sources":[{"type":"url","url":"https://nodejs.org/en"}, …]}}
  {"action":{"type":"open_page","url":"https://nodejs.org/en/about/previous-releases"}}
  ```

  `action.type` is not a closed set — route the unrecognised to a catch-all, as with event tags.
  `sources` length is backend-controlled and varied between 5 and 10 on identical flags. A
  mid-flight update carries `rawOutput: null`, so requiring a record is the natural "this call
  returned something" filter.

- **One web tool call is not one search.** A single run made 9 `WebSearch` calls that decomposed
  into 6 searches and 3 page opens. Report the two separately or a caller reads three times the
  research that happened.

- **X search is a different shape and carries no sources at all.** `rawInput.variant` is
  `"XSearch"`, and the update's `rawOutput` has no `action` — it is
  `{call_id, input, name: "x_keyword_search", id}`, where **`input` is a JSON string**, not an
  object. The query is recoverable; the posts it found are not.

- **`usage` has no web-search counter.** No `server_tool_use`, no `web_search_requests`. A run with
  two searches reported only the ordinary token fields, and `total_tokens` (47377) exceeded
  `input + output` (28305) — server-side tool tokens are inside the total but never itemised. The
  stream is the only place a search count exists, which is why a tool that reports one must run
  `streaming-json` whether or not a client asked for progress.

- **`--disable-web-search` does not stop the model researching.** Given the flag and a question
  needing current facts, it fell through to `x_keyword_search` / `x_semantic_search`, answered
  confidently, and cited `https://x.com/nodejs/status/…`. Exit 0, `end_turn`, no warning anywhere.
  So "no web results" is undetectable from the answer and detectable only by counting what the
  stream did. The same run first tried `curl` through `run_terminal_command`, took our `--deny`
  refusal, said _"Bash is blocked here, so I'm checking recent official announcements instead"_, and
  finished — another instance of a deny rule being recoverable where a permission prompt is fatal.

- **A search run finishes inside one turn.** A 1-query run and a 6-query run both reported
  `num_turns: 1`, because the searches happen within a turn rather than across turns. `--max-turns`
  is therefore almost never why a search run comes back short, and advising a caller to raise it
  sends them to spend money on the wrong thing.

- **Depth is worth what it costs, and it costs.** Same question, same flags, prompt-shaped two ways:
  one round of searching gave 1 query, 2 pages, a 10-URL pool and
  $0.028; "search more than once,
  from different angles" gave 6 queries, 3 pages, a 26-URL pool and $0.069.
  Asking for "about 3 distinct sources" produced 4. Prompt shaping moves these numbers reliably; it
  does not pin them.

### Known drift and gotchas

- **`grok import` does not exist in 1.0.0 or 1.0.4.** The bundled plugin's `/grok-build:import` and
  its `runImport()` helper call it anyway. Do not build a Claude→Grok transcript transfer on that
  subcommand. If we want transfer, read the Claude `.jsonl` transcript ourselves and feed it via
  `--prompt-file`.
- `--effort` accepts `none|minimal|low|medium|high|xhigh|max` per the docs, plus per-model menu ids.
  The plugin restricts to `low|medium|high`. Validate loosely (pass through) and let the CLI reject
  what a model does not advertise, rather than hard-coding a stale enum.
- `--yolo` is documented but only `--always-approve` appears in `grok --help`. Emit
  `--always-approve`.
- An unrecognized subcommand is silently swallowed as the positional `[PROMPT]` argument. A typo'd
  subcommand will not error the way you expect — always check that a subcommand exists before wiring
  it.
- `--cwd` nested inside a monorepo makes Grok discover the whole repo as project root and start
  slowly. Pass the narrowest useful directory.
- **A single argv element is capped at 128 KiB on Linux** (MAX_ARG_STRLEN, 32 pages), independently
  of the far larger total ARG_MAX. `-p` with an embedded diff blows through it and `spawn` fails
  with E2BIG before grok runs. Use `--prompt-file` above ~64 KiB; verified on 1.0.4 that a 186 KiB
  file is read in full, with its last line intact.
- **A large `--prompt-file` is "offloaded", not inlined.** grok writes it to
  `~/.grok/sessions/<cwd>/<id>/prompts/prompt_0.txt` and the agent reads it back with `read_file`,
  across several turns. The content all arrives, but it costs turns — so a `--max-turns` that looks
  generous for the task can still cut the run off mid-read.

## Design rules

1. **Permission is a ceiling set by the operator, not a per-call veto.** Three levels, ordered:

   | Level       | `--permission-mode`                          | `--sandbox` |
   | ----------- | -------------------------------------------- | ----------- |
   | `read-only` | `plan`                                       | `read-only` |
   | `write`     | `acceptEdits`                                | `workspace` |
   | `full`      | `bypassPermissions` (via `--always-approve`) | `off`       |

   `GROK_MCP_PERMISSION_CEILING` caps what any call may request; `GROK_MCP_DEFAULT_PERMISSION` sets
   what a call gets when it asks for nothing. Both default to `read-only`, so an unconfigured
   install is safe. Tool arguments (`permission: "write" | "full"`, or the shorthands `write: true`
   / `yolo: true`) select a level at or below the ceiling.

   The point of the ceiling is that **it is granted once, at registration, and then never interrupts
   again**. An operator who already runs Claude Code with full approval registers with
   `-e GROK_MCP_PERMISSION_CEILING=full -e GROK_MCP_DEFAULT_PERMISSION=full` and every downstream
   Grok run is unattended. Nothing prompts, nothing rejects mid-workflow. That is the intended
   configuration for this machine's use case.

2. **Never silently clamp; reject and name the fix.** A call requesting above the ceiling fails with
   a message stating the requested level, the active ceiling, and the exact env var to change.
   Downgrading a `full` request to `read-only` behind the caller's back produces a run that looks
   successful and changed nothing — the worst outcome. `check` reports the active ceiling and
   default so a caller can see the policy before spending tokens on a doomed run.

   The server cannot detect the caller's own approval level — Claude Code exports `CLAUDECODE`,
   `CLAUDE_CODE_ENTRYPOINT`, and session ids, but nothing describing permission mode. Do not
   fabricate inheritance from those variables; the operator's env config is the only honest signal.

3. **Never build a shell string.** Always `spawn(binary, argv)` with an array. No `shell: true` on
   POSIX. Prompts contain user text, newlines, quotes, and `$`.
4. **Structured output over scraping.** Use `--output-format json` / `streaming-json`. If a value is
   not in the JSON, treat it as unavailable rather than regexing stderr.
5. **Every long-running tool reports progress.** Parse `streaming-json` and forward
   `notifications/progress` when the client supplied a `progressToken`. This is what keeps MCP
   clients from timing out mid-run.
6. **Bounded buffers and bounded time.** Cap accumulated stdout/stderr (10 MB) and enforce a wall
   clock (`GROK_MCP_TIMEOUT_MS`, default 30 min) with SIGTERM then SIGKILL of the whole process
   group.
7. **Surface spend.** Return `sessionId`, `model`, `usage`, and `total_cost_usd` in
   `content[0]._meta`, and in `structuredContent` only when `STRUCTURED_CONTENT_ENABLED` is truthy
   (some clients mishandle `structuredContent`).
8. **No code copied from the reference implementations.** Shape and naming may rhyme; the
   implementation is ours.
9. **A run must always terminate and always report.** No path may hang, discard buffered output on
   error, or return a session id Grok did not confirm. This is the reliability contract from "Why
   this exists" — treat a violation as a bug even when the happy path passes.

## Tool surface

| Tool        | Read-only   | Purpose                                                                                                                                      |
| ----------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `grok`      | default yes | Headless run. Prompt, session resume/continue, model, effort, sandbox, permission mode, cwd, tool allow/deny, max turns, optional background |
| `review`    | yes         | Code review of working tree / `--base <ref>` / `--commit <sha>`, plan mode + read-only sandbox, optional `--json-schema` structured findings |
| `websearch` | yes         | Web research with prompt-shaped count and depth, reporting the searches and sources the run actually used                                    |
| `sessions`  | yes         | List and search real Grok sessions from `~/.grok/sessions`                                                                                   |
| `status`    | yes         | Poll a background run                                                                                                                        |
| `stop`      | no          | Terminate a background run's process tree                                                                                                    |
| `check`     | yes         | Readiness probe: binary resolution, `grok version`, auth via `grok models`                                                                   |
| `help`      | yes         | `grok --help` passthrough                                                                                                                    |

MCP server name as registered by consumers: `grok-build`. npm package: `grok-build-mcp-server`.

## Repo layout (target)

```
src/
  index.ts             # shebang entry, starts server
  server.ts            # MCP Server wiring, progress plumbing, error envelope
  config.ts            # env var parsing + defaults, single source of truth
  errors.ts            # typed errors -> MCP error text
  types.ts             # zod schemas, tool name constants
  grok/
    binary.ts          # resolve GROK_BINARY, version + auth probes
    args.ts            # validated params -> grok argv (pure, heavily tested)
    exec.ts            # spawn, buffer caps, timeout, process-group kill
    stream.ts          # streaming-json NDJSON -> typed events
    result.ts          # json output -> { text, sessionId, usage, cost }
  tools/
    definitions.ts     # MCP tool schemas + annotations
    handlers/          # one file per tool
  jobs/
    store.ts           # on-disk run records (survive server restart)
    runner.ts          # detached background worker
tests/
  fixtures/fake-grok.mjs   # scriptable fake binary on PATH
docs/
  api-reference.md
  security.md
```

`grok/args.ts` is pure and is where most test value lives — argv construction is the part that
silently breaks on CLI upgrades.

## Commands

```bash
npm install
npm run build        # tsc -> dist/
npm run dev          # tsx src/index.ts
npm test             # node --test against dist/ (or tsx loader)
npm run lint
npm run format
```

Manual end-to-end check against a real CLI:

```bash
npm run build
node dist/index.js < /dev/null          # should print a startup line on stderr, then wait

# Safe default registration
claude mcp add grok-build -- node "$(pwd)/dist/index.js"

# Unattended registration, for an operator who already runs Claude Code with full approval
claude mcp add grok-build \
  -e GROK_MCP_PERMISSION_CEILING=full \
  -e GROK_MCP_DEFAULT_PERMISSION=full \
  -- node "$(pwd)/dist/index.js"
```

## Testing conventions

Full policy — layers, fakes-not-mocks, determinism, coverage floors — is in
[docs/engineering.md](docs/engineering.md#5-testing). Project-specific points:

- Unit tests never invoke the real `grok`. Tests put a scriptable fake `grok` on `PATH` (see the
  plugin's `tests/fake-grok-fixture.mjs` for the idea) and assert on the argv it received.
- `grok/args.ts` gets exhaustive table-driven coverage: every flag, every default, every mutually
  exclusive combination (`-r` vs `-c` vs `-s`, review target selection), and the full
  requested-level × ceiling matrix — nine cases, three of which must reject rather than clamp.
- One opt-in integration test guarded by `GROK_MCP_E2E=1` that runs a real trivial prompt.
- MCP protocol tests drive the server over stdio with a real client from the SDK — `initialize`,
  `tools/list`, `tools/call`.

## Conventions

**[docs/engineering.md](docs/engineering.md) is authoritative** for how code is written here — pure
core / imperative shell, the functional TypeScript rules, error and effect discipline, testing and
coverage policy, dependency policy, and commit workflow. Read it before writing code. What follows
is the short list of the constraints that bind most often.

- TypeScript, ESM (`"type": "module"`), Node >= 22. Node 20 reached end of life on 2026-04-30.
- TypeScript pinned to 5.9.x. TypeScript 7 is current, but `typescript-eslint` 8 peers
  `typescript <6.1.0`, so adopting 7 means dropping type-aware linting. Revisit when the lint
  toolchain catches up.
- Zod schemas are the single definition of tool inputs; JSON Schema for `tools/list` is derived from
  them, never hand-maintained in parallel.
- Nothing but the MCP SDK and zod as runtime dependencies. Use Node stdlib for process, fs, path.
- Never write to stdout outside the MCP transport. Diagnostics go to stderr — stdout is the protocol
  channel and one stray `console.log` corrupts the session. Enforced by lint and by a CI step.
- No classes except errors. Pure decision logic, effects at the edges, `unknown` at every boundary.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`). Work lands directly on `main` —
  single-maintainer repo, so the guard is a green suite before every commit, not a branch.

## Environment variables

| Variable                       | Purpose                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `GROK_BINARY`                  | Override the `grok` executable path                                                         |
| `GROK_MCP_DEFAULT_MODEL`       | Default model when a call omits one (default `grok-4.6`)                                    |
| `GROK_MCP_DEFAULT_EFFORT`      | Default reasoning effort when a call omits one (default `high`)                             |
| `GROK_MCP_TIMEOUT_MS`          | Wall-clock kill for a single run (default 1800000)                                          |
| `GROK_MCP_PERMISSION_CEILING`  | Highest level any call may request: `read-only` (default), `write`, `full`                  |
| `GROK_MCP_DEFAULT_PERMISSION`  | Level used when a call specifies none. Must be at or below the ceiling. Default `read-only` |
| `GROK_MCP_STATE_DIR`           | Background job records (default `$XDG_STATE_HOME/grok-mcp` or `$TMPDIR/grok-mcp`)           |
| `GROK_MCP_MAX_CONCURRENT_RUNS` | Background runs alive at once (default 4). `off`/`none`/`unlimited` for no cap              |
| `STRUCTURED_CONTENT_ENABLED`   | Emit `structuredContent` alongside `_meta`                                                  |

Grok's own variables (`XAI_API_KEY`, `GROK_HOME`, `GROK_DISABLE_AUTOUPDATER`) pass through to the
child process untouched.

## Current state

M1–M7 are complete. The whole tool surface ships — `check`, `help`, `grok`, `review`, `websearch`,
`sessions`, `status`, and `stop`, with progress streaming, structured review findings, session
listing backed by the CLI's own on-disk store, and background runs that survive a restart of this
server — and so does the release: [docs/api-reference.md](docs/api-reference.md),
[docs/security.md](docs/security.md), `CHANGELOG.md`, issue and PR templates, and a tag-triggered
npm publish workflow with provenance. Licensed MIT. See [ROADMAP.md](ROADMAP.md) for milestones and
acceptance criteria.

What is left is the release itself, and it is not something this repo can do on its own: an
`NPM_TOKEN` repository secret, an `npm login` for the first publish, making the GitHub repo public,
and pushing a `v0.1.0` tag. The workflow refuses to publish if the tag and `package.json` disagree.

Four constraints a future change must respect. The first two are the background-run design; the
third is what `websearch` added; the fourth is what M7 found:

- **`record.json` is read-modify-written, so it may only ever have one writer at a time.** M5b made
  that structural rather than conventional: progress, the worker pid, and a result that lost the
  terminal claim each live in their own single-writer sidecar, and `record.json` is touched only at
  creation, at the worker's transition to `running`, and at the terminal write. Anything that adds a
  second writer to it reopens the whole class — a generation counter does not help, because a CAS on
  a filesystem is a read-check-rename with a window of its own.
- **No path may report a run as stopped while its process tree is alive.** `stop` claims the
  terminal transition, then signals, then writes — in that order — and only `gone`, `terminated`,
  and `killed` may write `cancelled`. Every other outcome releases the claim and leaves the record
  non-terminal. A `cancelled` record next to a live process is the failure mode this tool exists to
  avoid, not an acceptable approximation of one.
- **A field that names an activity must count the activity, not the attempt.** `websearch` reports
  `searchPerformed` only when sources came back, and separates `webToolCalls` (started) from
  `webSearches` (returned) because a call is not a result. The reason is measured: with web search
  unavailable the model answers from X, confidently and with citations, exiting 0 — so `_meta` is
  the only channel that can tell a caller where an answer came from, and every key in it has to mean
  exactly what its name says. The same rule made handler meta reach the error and partial envelopes,
  with `sessionId` and `resumeCommand` stripped so no non-success path can gain a session Grok never
  confirmed.
- **Anything this server writes that can hold a prompt is owner-only.** A background-run record
  carries the tool's full arguments, which for `review` is the entire diff; `worker.log` carries the
  worker's stdout and stderr; an over-64 KiB prompt is written to a `mkdtemp` directory before it
  reaches `--prompt-file`. All of them are `0700` directories with `0600` files, matching what
  `~/.grok/sessions` already does. A new write path that defaults its mode is a regression, and
  `mode` is a floor rather than a grant — umask still applies, and it is ignored on Windows.
