# API reference

Parameter and response shapes for every tool `grok-build-mcp-server` exposes. Input schemas are
generated from zod — the live `tools/list` payload is authoritative. Ask your MCP client for that
list, or inspect the server after `initialize`; do not treat this file as a second schema.

Verified CLI behaviour that the shapes below depend on lives in [CLAUDE.md](../CLAUDE.md).
Permission levels, the ceiling, and what `full` grants live in [security.md](security.md). The full
environment-variable table is in [README.md](../README.md).

## Conventions

### The result envelope

Every tool returns MCP `content` with a single `text` block. `_meta` lives on that block
(`content[0]._meta`), not on the result root. `structuredContent` is emitted alongside `_meta` only
when `STRUCTURED_CONTENT_ENABLED` is truthy — some clients mishandle `structuredContent`, so it is
opt-in.

`isError: true` means the call completed and returned a result that is not a usable answer. That is
distinct from a protocol error: the server turns thrown failures into the same envelope (see
[Errors](#errors)) so a client can hand the text to the model instead of stalling.

`grok`, `review`, and `websearch` share one run core. After the handler formats the body, a parsed
result may still gain a suffix:

- non-zero exit: `[grok exited with code N]` or `[grok exited with code N (stopReason: …)]`
- exit 0 with a `stopReason` other than `end_turn`: `[the run stopped early — stopReason: …]`

A permission-cancelled headless run does the second of those and still exits 0. The suffix is how a
fragment is labelled; whether `isError` also flips is per tool.

When the client sends a `progressToken`, `grok` and `review` switch to
`--output-format streaming-json` and forward `notifications/progress`. `websearch` always uses
`streaming-json`, because the search count and the source list exist only in the stream.

Three environment variables change a run at call time. Everything else is in the
[README table](../README.md#environment-variables).

| Variable                  | Default    | Effect at call time                                   |
| ------------------------- | ---------- | ----------------------------------------------------- |
| `GROK_MCP_DEFAULT_MODEL`  | `grok-4.6` | `--model` when the call omits one                     |
| `GROK_MCP_DEFAULT_EFFORT` | `high`     | `--effort` when the call omits one                    |
| `GROK_MCP_TIMEOUT_MS`     | `1800000`  | Wall-clock kill for one run, then SIGTERM and SIGKILL |

`none`, `off`, and `default` (any case) all mean "omit the flag and let the CLI decide" for the two
default-value variables. There is no spelling that passes the literal string `default` as a model or
effort id.

Every tool schema is strict. An unrecognised key is `invalid-arguments`, not stripped. That is how a
typo (`permision` for `permission`) used to become a silent read-only run. MCP clients put `_meta`
on `params`, not inside `arguments`, so a well-formed call is not rejected for progress metadata.

Fields that become individual argv elements are length-capped in `src/limits.ts` so a call cannot
routinely hit Linux `MAX_ARG_STRLEN` (128 KiB per element). Prompt-shaped text (`grok.prompt`,
`review.instructions`, `websearch.query`, `websearch.instructions`) is not capped: it is folded into
the prompt and delivered through `--prompt-file` above a threshold.

### Shared `_meta` (grok, review, websearch)

On a successful parse, `src/tools/run.ts` writes these keys. Handler keys are merged first so the
run's own keys win; a handler cannot shadow `sessionId` with a value the CLI did not report.

| Key               | Type                               | When                              | Meaning                                                                                                                                       |
| ----------------- | ---------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`       | `string \| null`                   | always                            | The id the CLI reported. Never a locally generated stand-in, and never the `--session-id` we may have passed to create a session              |
| `resumeCommand`   | `string`                           | `sessionId` is a non-empty string | `grok -r <id>`. Omitted (not `null`) when there is no confirmed id                                                                            |
| `model`           | `string \| null`                   | always                            | The id passed as `--model`, not the key in `modelUsage` (`grok-4.6` vs `grok-4.6-build`). Do not round-trip the reported key back into a call |
| `usage`           | `object \| null`                   | always                            | Token counts from the result. Members are conditional on effort and model — read what is present; assume no fixed shape                       |
| `total_cost_usd`  | `number \| null`                   | always                            | Spend reported on the result object / `end` event                                                                                             |
| `stopReason`      | `string \| null`                   | always                            | CLI stop reason. `null` means the field was omitted, not that the run aborted                                                                 |
| `numTurns`        | `number \| null`                   | always                            | `num_turns` from the result                                                                                                                   |
| `permissionLevel` | `"read-only" \| "write" \| "full"` | always                            | Level this run actually used                                                                                                                  |
| `durationMs`      | `number`                           | always                            | Wall time of the child process                                                                                                                |
| `exitCode`        | `number \| null`                   | always                            | Child exit code. `0` is not sufficient for "finished" — a cancelled run exits 0                                                               |

A parsed result wins over a non-zero exit, so a `--max-turns` cap still returns the session and the
spend that produced it.

Error and partial paths carry the handler's own `_meta` too (`review` target keys, `websearch`
activity counts). `nonSuccessHandlerMeta` strips `sessionId` and `resumeCommand` from that object
before the merge, so no failed or truncated run can report a session Grok never confirmed. Those
paths then add:

| Key               | Type             | When              | Meaning                                                              |
| ----------------- | ---------------- | ----------------- | -------------------------------------------------------------------- |
| `outcome`         | `string`         | error and partial | `exited`, `timeout`, `aborted`, or `spawn-failed`                    |
| `durationMs`      | `number`         | error and partial | Wall time of the child                                               |
| `exitCode`        | `number \| null` | partial only      | Present on a stream that ended before `end`. The error path omits it |
| `model`           | `string \| null` | partial only      | The id we passed. Known before the run; reporting it invents nothing |
| `permissionLevel` | `string`         | partial only      | Same as success                                                      |

A partial stream's text is recovered model output when any arrived, otherwise a bounded preview of
the raw buffer, then:

`[stream ended before its end event, so session id, usage, and cost are unavailable]`

### Errors

Thrown failures become a normal tool result with `isError: true`. The text is the error message,
then a blank line and the remedy when one exists. `_meta` is `{ errorKind }`. Argument validation
names every problem at once rather than the first, so one corrected call is enough.

| `errorKind`         | When                                                                                                                             | What to do                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `config`            | Bad environment at process start. The server never serves                                                                        | Fix the named variables and restart                                                                       |
| `invalid-arguments` | Schema failure (unknown key, over-length argv field, malformed `runId`), or a mutually exclusive combination the handler rejects | Read every `- ` line; fix them together                                                                   |
| `unknown-tool`      | `tools/call` named something this server does not register                                                                       | Use a name from the remedy list                                                                           |
| `permission-denied` | `grok` asked for a level above `GROK_MCP_PERMISSION_CEILING`. Never clamped                                                      | Re-register with `GROK_MCP_PERMISSION_CEILING` set to the requested level. See [security.md](security.md) |
| `git-failed`        | `review` could not run git: missing binary, not a repo, or a ref that does not resolve                                           | Install git, pass a real working tree as `cwd`, or name a ref that exists                                 |
| `sessions-store`    | The session store root is unreadable (`EACCES`, `ENOTDIR`, …). Missing is not this error                                         | Check the named directory, or set `GROK_HOME` to the directory that contains `sessions/`                  |
| `job-store`         | The background-run store root is unreadable. Missing is not this error                                                           | Check the named directory, or set `GROK_MCP_STATE_DIR` to a writable path                                 |
| `binary-not-found`  | In the taxonomy; not currently thrown. A missing binary is a run envelope with `outcome: "spawn-failed"`                         | Install the CLI or set `GROK_BINARY`                                                                      |
| `grok-failed`       | In the taxonomy; not currently thrown. CLI `{type:"error"}` is a run envelope                                                    | Read the body; it quotes the CLI message                                                                  |
| `timeout`           | In the taxonomy; not currently thrown. A wall-clock kill is a run envelope with `outcome: "timeout"`                             | Raise `GROK_MCP_TIMEOUT_MS`                                                                               |
| `internal`          | Anything thrown that is not a `GrokMcpError`                                                                                     | Treat as a server bug; the text is the exception message                                                  |

### Background runs

`grok`, `review`, and `websearch` accept `background: true`. `false` is not a request. Validation
still happens before a `runId` is issued — schema errors, mutually exclusive flags, and a
`permission` above the ceiling fail in the foreground. The call then returns immediately with
`runId` instead of a model result. The run belongs to the machine, not to this server: it survives
an MCP server restart. Poll with [`status`](#status); terminate with [`stop`](#stop).

Spawn-path `_meta`:

| Key         | Type             | When         | Meaning                                                                                                                                      |
| ----------- | ---------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`     | `string`         | always       | Id to pass to `status` / `stop`. Shape is `<base36 ms>-<8 hex>` (e.g. `msyi8cve-c89e63a4`); anything else is `invalid-arguments`, not a miss |
| `state`     | `"starting"`     | success      | The worker has been spawned                                                                                                                  |
| `state`     | `"failed"`       | spawn failed | The worker never started                                                                                                                     |
| `tool`      | `string`         | always       | `grok`, `review`, or `websearch`                                                                                                             |
| `cwd`       | `string`         | always       | Working directory recorded for the run                                                                                                       |
| `workerPid` | `number \| null` | always       | Worker pid, or `null` if it could not be read                                                                                                |
| `createdAt` | `string`         | always       | ISO timestamp of the record                                                                                                                  |
| `summary`   | `string`         | always       | Short label from the prompt / target                                                                                                         |

The body on success is `Started <tool> run <runId> in the background.` plus example `status` calls.
A spawn failure is `isError: true` and says the run will never execute.

## grok

Headless Grok Build agent (`grok -p`). Use this for a general run: a prompt, optional session resume
or fork, model and effort, and tool allow/deny. Permission is capped by
`GROK_MCP_PERMISSION_CEILING`; a request above it is rejected rather than silently downgraded.

### Parameters

| Parameter          | Type                               | Default                       | Description                                                                                                                                                         |
| ------------------ | ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`           | `string`                           | —                             | The task for Grok to perform. Passed verbatim as `grok -p`                                                                                                          |
| `cwd`              | `string` (≤4096)                   | none                          | Working directory for the run. Passed as `--cwd`. Use the narrowest useful path. Capped because it is one argv element                                              |
| `model`            | `string` (≤256)                    | `GROK_MCP_DEFAULT_MODEL`      | Model id to pass as `--model`. Omit to use the server default. Unknown ids are rejected by the CLI, not by this server                                              |
| `effort`           | `string` (≤256)                    | `GROK_MCP_DEFAULT_EFFORT`     | Reasoning effort passed as `--effort`. Omit to use the server default. Values are passed through; the CLI rejects what the model does not advertise                 |
| `permission`       | `"read-only" \| "write" \| "full"` | `GROK_MCP_DEFAULT_PERMISSION` | Permission level for this run. Must be at or below `GROK_MCP_PERMISSION_CEILING`. Omit to use the server default. See [security.md](security.md)                    |
| `write`            | `boolean`                          | none                          | Shorthand for `permission: "write"`. Ignored when `permission` is set. `false` is not a request                                                                     |
| `yolo`             | `boolean`                          | none                          | Shorthand for `permission: "full"`. Ignored when `permission` is set. `false` is not a request                                                                      |
| `maxTurns`         | `number (int, ≥1)`                 | none                          | Maximum agentic turns. Passed as `--max-turns`. Headless only                                                                                                       |
| `tools`            | `string[]` (≤100 × ≤512)           | none                          | Internal tool ids to allow, passed as a single comma-joined `--tools`. Shell is `run_terminal_command`, not `bash`                                                  |
| `disallowedTools`  | `string[]` (≤100 × ≤512)           | none                          | Internal tool ids to block, passed as `--disallowed-tools`                                                                                                          |
| `allow`            | `string[]` (≤100 × ≤512)           | none                          | Repeatable allow rules in `ToolPrefix(glob)` form, e.g. `Bash(npm*)`, `Write(src/**)`                                                                               |
| `deny`             | `string[]` (≤100 × ≤512)           | none                          | Repeatable deny rules in `ToolPrefix(glob)` form, e.g. `Read(.env)`                                                                                                 |
| `rules`            | `string` (≤8192)                   | none                          | Extra system-prompt text, passed as `--rules`. Longer system-prompt text belongs in the prompt                                                                      |
| `agent`            | `string` (≤256)                    | none                          | Named subagent to run, passed as `--agent`                                                                                                                          |
| `resume`           | `string` (≤256)                    | none                          | Resume an existing session by id or title (`--resume`). Mutually exclusive with `continueSession`. Combine with `forkSession` to fork rather than continue in place |
| `continueSession`  | `boolean`                          | none                          | Continue the most recent session for `cwd` (`--continue`). Mutually exclusive with `resume`. `false` is not a request                                               |
| `forkSession`      | `string` (≤256)                    | none                          | UUID for a forked session. Requires `resume` or `continueSession`. Passed as `--fork-session --session-id`                                                          |
| `sessionId`        | `string` (≤256)                    | none                          | Create a new session with this UUID (`--session-id`). Cannot be combined with `resume` or `continueSession`; use `forkSession` to name a fork                       |
| `disableWebSearch` | `boolean`                          | none                          | Pass `--disable-web-search`. `false` is not a request                                                                                                               |
| `background`       | `boolean`                          | none                          | Run detached and return a `runId` immediately instead of waiting. Poll with `status`. The run survives a restart of this MCP server. `false` is not a request       |

Empty strings on `cwd`, `resume`, `forkSession`, and `sessionId` are rejected (`minLength: 1`). An
empty value would otherwise drop the flag and quietly run somewhere else.

### Mutually exclusive combinations

Rejected before spawn, as `invalid-arguments`, with every conflict listed:

- `resume` and `continueSession`:
  `resume and continueSession are mutually exclusive. Pass one or the other, not both.`
- `sessionId` with `resume` or `continueSession`:
  `sessionId creates a new session and cannot be combined with resume or continueSession. To fork an existing session, pass forkSession together with resume or continueSession.`
- `forkSession` without `resume` or `continueSession`:
  `forkSession requires resume or continueSession. To create a new session with a chosen UUID, pass sessionId alone.`

### Result

`content[0].text` is the model text, plus the envelope suffix when the run exited non-zero or
stopped early. Failure paths that never produced a parsed result are a diagnostic body: spawn
failure (a missing binary names `GROK_BINARY`; `E2BIG` names the longest flag and the 128 KiB Linux
per-argument limit, and does not tell you to install the CLI), timeout (`GROK_MCP_TIMEOUT_MS`),
client abort, a quoted CLI `{type:"error"}` message, a partial stream, or unparseable JSON with a
4000-character preview.

A background call returns the spawn text in [Background runs](#background-runs), not model text.

### _meta

The shared keys above. `grok` adds none on the foreground path.

### isError

`true` when there is no parsed result (spawn failure, timeout, abort, CLI error, partial stream,
unparseable JSON) or when a background worker could not be started. A parsed result is
`isError: false` even if `stopReason` is not `end_turn` or the process exited non-zero — those are
marked in the text suffix. `review` and `websearch` treat a cut-off as an error; `grok` does not.

Example arguments:

```json
{
  "prompt": "Summarise src/grok/args.ts in one paragraph.",
  "cwd": "/home/nuru/repos/grok-build-to-claude",
  "maxTurns": 8
}
```

## review

Code review of a git target. Use this when the thing to review is a diff: the working tree, a
merge-base against a ref, or a single commit. The diff is collected in-process and embedded in the
prompt. When no target is specified, the tool auto-detects: the upstream diff if the branch is
ahead, otherwise the working tree.

### Parameters

| Parameter      | Type               | Default                   | Description                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`          | `string` (≤4096)   | process cwd               | Repository to review. Defaults to the current working directory. Capped because it is one `--cwd` argv element                                                                                                                                                                               |
| `base`         | `string` (≤256)    | none                      | Review the merge-base diff against this ref. Mutually exclusive with `commit` and `uncommitted`. Capped because it is one argv element                                                                                                                                                       |
| `commit`       | `string` (≤256)    | none                      | Review this commit. Mutually exclusive with `base` and `uncommitted`. Capped because it is one argv element                                                                                                                                                                                  |
| `uncommitted`  | `boolean`          | none                      | Review the working tree (staged, unstaged, and untracked). Mutually exclusive with `base` and `commit`. `false` is not a request                                                                                                                                                             |
| `instructions` | `string`           | none                      | Extra reviewer guidance, appended verbatim to the prompt                                                                                                                                                                                                                                     |
| `structured`   | `boolean`          | none                      | Return machine-readable findings via `--json-schema`. A run that stops before a final findings object fails the call with `reviewIncomplete`. Malformed model JSON after a normal stop degrades to raw text plus a `parseError` field rather than failing the call. `false` is not a request |
| `model`        | `string` (≤256)    | `GROK_MCP_DEFAULT_MODEL`  | Model id to pass as `--model`. Omit to use the server default. Unknown ids are rejected by the CLI, not by this server                                                                                                                                                                       |
| `effort`       | `string` (≤256)    | `GROK_MCP_DEFAULT_EFFORT` | Reasoning effort passed as `--effort`. Omit to use the server default. Values are passed through; the CLI rejects what the model does not advertise                                                                                                                                          |
| `maxTurns`     | `number (int, ≥1)` | none                      | Maximum agentic turns. Passed as `--max-turns`. Headless only                                                                                                                                                                                                                                |
| `background`   | `boolean`          | none                      | Run detached and return a `runId` immediately instead of waiting. Poll with `status`. The run survives a restart of this MCP server. `false` is not a request                                                                                                                                |

Empty strings on `cwd`, `base`, and `commit` are rejected (`minLength: 1`), for the same reason as
`grok`: an empty value drops the flag and silently reviews something else.

### Mutually exclusive combinations

Any two of `base`, `commit`, and `uncommitted: true` are rejected as `invalid-arguments`:

- `base and commit are mutually exclusive. Pass one of base, commit, or uncommitted, not both.`
- `base and uncommitted are mutually exclusive. Pass one of base, commit, or uncommitted, not both.`
- `commit and uncommitted are mutually exclusive. Pass one of base, commit, or uncommitted, not both.`

### Result

An empty target returns `Nothing to review: <targetDescription> has no changes.` and does not spawn
grok.

A completed prose review is the model text. A completed structured review is the findings object as
indented JSON (`status: "final"`, `findings[]` of `{ severity, file, summary, rationale, line? }`,
optional `verdict`).

Leading lines when the review is not finished:

- Cut-off (prose or structured), `maxTurns` set:
  `The run stopped with stopReason "<reason>" after N turns (maxTurns M) before … so nothing below is a completed/finished review.`
  Then: `Raise maxTurns above M or narrow the review target.`
- Cut-off, no `maxTurns`: the same stop-reason lead, then
  `No maxTurns limit was set, so the turn budget was not the cause. Narrow the review target and retry.`
- Structured run that finished (`end_turn`) without a final findings object:
  `The run finished normally … but the model never emitted its final findings object… Retry the review; raising maxTurns will not help.`
- Structured run that finished with unreadable JSON:
  `The model produced output we cannot validate (<parseError>). The text below is the raw response.`

The CLI's own `structuredOutputError` is quoted in the incomplete leads when present. Model text
follows the lead. The envelope suffix from [The result envelope](#the-result-envelope) may still be
appended.

Git failures (`not a repo`, unknown ref, missing `git`) are the thrown-error envelope with
`errorKind: "git-failed"`.

### _meta

Plus the shared keys above, except on the empty-diff path (no spawn, so no run keys).

| Key                     | Type                                  | When                                        | Meaning                                                                                              |
| ----------------------- | ------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `target`                | `"uncommitted" \| "base" \| "commit"` | always                                      | Resolved target kind                                                                                 |
| `targetDescription`     | `string`                              | always                                      | Human label (`working tree (staged, unstaged, and untracked)`, `diff against <ref>`, `commit <sha>`) |
| `files`                 | `string[]`                            | always                                      | Paths in the diff, capped at 200                                                                     |
| `fileCount`             | `number`                              | always                                      | Uncapped path count                                                                                  |
| `filesTruncated`        | `true`                                | more than 200 paths                         | The `files` array is a prefix                                                                        |
| `diffTruncated`         | `boolean`                             | always                                      | The embedded diff hit the 256 KiB budget                                                             |
| `excluded`              | `string`                              | auto-select left something out              | Why (typically uncommitted changes on an ahead-of-upstream branch)                                   |
| `findings`              | `object`                              | `structured: true` and a final object       | Validated findings                                                                                   |
| `findingsComplete`      | `boolean`                             | `structured: true`                          | `true` only for a final object. Absent in prose mode                                                 |
| `reviewIncomplete`      | `string`                              | see below                                   | The incomplete-lead text                                                                             |
| `parseError`            | `string`                              | structured, finished, unreadable JSON       | Why validation failed                                                                                |
| `structuredOutputError` | `string`                              | structured, not final, and the CLI reported | The CLI's own reason that `structuredOutput` is missing                                              |

`reviewIncomplete` is not "structured without a final object". It is present on a prose cut-off, and
in structured mode when the model emitted a `working` object, or when its output would not validate
**and** the run was cut off. Structured output that fails to validate after a normal `end_turn` is
the `malformed` path: `parseError` and `findingsComplete: false`, with no `reviewIncomplete`. A
client keying on `reviewIncomplete` alone to mean "no findings" will miss that case; key on
`findingsComplete`.

### isError

- Structured: the classification is `incomplete` (cut-off, still `working`, or finished with no
  final object). Malformed JSON after a normal stop is `isError: false`.
- Prose: `stopReason` is present and is not `end_turn`.
- Empty diff: `false`.
- `GitError`: `true`, via the thrown-error envelope.

### Notes

Pinned read-only (`--permission-mode plan --sandbox read-only`) regardless of
`GROK_MCP_PERMISSION_CEILING`. There is no `permission`, `write`, or `yolo` argument — a review that
edits the code it is reviewing is never wanted.

The run also passes `--deny 'Bash(*)' 'Edit(*)' 'Write(*)'`. Plan mode looks equivalent and is not:
an unapprovable tool request in headless mode cancels the whole run while the CLI still exits 0. An
explicit deny is recoverable; the model is told no and finishes. See
[CLAUDE.md](../CLAUDE.md#an-unapprovable-tool-request-kills-the-run).

Working tree (uncommitted):

```json
{
  "cwd": "/home/nuru/repos/grok-build-to-claude",
  "uncommitted": true,
  "structured": true
}
```

Merge-base against a ref:

```json
{
  "cwd": "/home/nuru/repos/grok-build-to-claude",
  "base": "origin/main",
  "instructions": "Focus on error handling and permission checks."
}
```

## websearch

Research a question with Grok Build's web search. Use this when the answer depends on current
sources, and you need to see which searches and URLs the run actually used.

### Parameters

| Parameter      | Type                 | Default                   | Description                                                                                                                                                   |
| -------------- | -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`        | `string`             | —                         | The question to research. Passed as the body of a web-search-shaped prompt                                                                                    |
| `numResults`   | `number (int, 1–50)` | none                      | Prompt-level target for how many distinct sources to cite, not a backend limit. The CLI has no `--num-results` flag                                           |
| `searchDepth`  | `"basic" \| "full"`  | `basic`                   | Prompt-level search depth. `basic` asks for one round; `full` asks for more than one, from different angles. The CLI has no `--search-depth` flag             |
| `instructions` | `string`             | none                      | Extra researcher guidance, appended verbatim to the prompt                                                                                                    |
| `cwd`          | `string` (≤4096)     | process cwd               | Working directory for the run. Passed as `--cwd`. Defaults to the current working directory. Capped because it is one argv element                            |
| `model`        | `string` (≤256)      | `GROK_MCP_DEFAULT_MODEL`  | Model id to pass as `--model`. Omit to use the server default. Unknown ids are rejected by the CLI, not by this server                                        |
| `effort`       | `string` (≤256)      | `GROK_MCP_DEFAULT_EFFORT` | Reasoning effort passed as `--effort`. Omit to use the server default. Values are passed through; the CLI rejects what the model does not advertise           |
| `maxTurns`     | `number (int, ≥1)`   | none                      | Maximum agentic turns. Passed as `--max-turns`. Headless only. No default — a cap is how a run gets cut off mid-research                                      |
| `background`   | `boolean`            | none                      | Run detached and return a `runId` immediately instead of waiting. Poll with `status`. The run survives a restart of this MCP server. `false` is not a request |

### Result

A completed search that returned sources is the model text, then a one-line summary such as
`[1 web search, 9 sources]`. Pages and X searches are appended to that line when they happened. The
model already cites sources in prose; the line is a count, not a second list.

Leading lines, each exclusive of the others:

- Cut-off:
  `The run stopped with stopReason "<reason>" … before producing a completed search, so nothing below is a finished result.`
  Then either `Raise maxTurns above N or narrow the question.` or
  `No maxTurns limit was set, so the turn budget was not the cause. Narrow the question and retry.`
- No web tool call, no X call, no sources:
  `No search ran. The answer below is the model's own prior knowledge, not current sources.`
- Web tool calls ran but no sources came back, and no X search:
  `<N> web tool call(s) returned no sources. The answer below is the model's own prior knowledge, not current sources.`
- No web sources, but at least one X search:
  `No web search returned results; this answer comes from <N> X search(es), not from web pages.`

### _meta

Plus the shared keys above.

| Key                    | Type                | When                                          | Meaning                                                                                                   |
| ---------------------- | ------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `webToolCalls`         | `number`            | always                                        | `WebSearch` tool calls started (searches and page opens). A call is not a result                          |
| `webSearches`          | `number`            | always                                        | Completed `action.type === "search"` results                                                              |
| `searchQueries`        | `string[]`          | always                                        | Those search queries, in order                                                                            |
| `sources`              | `string[]`          | always                                        | Deduped URLs from searches and page opens, capped at 50                                                   |
| `sourceCount`          | `number`            | always                                        | Uncapped URL count                                                                                        |
| `pagesOpened`          | `string[]`          | always                                        | Deduped `open_page` URLs                                                                                  |
| `searchPerformed`      | `boolean`           | always                                        | `true` only when `sourceCount > 0`. A started search that never returned, or returned no URLs, is `false` |
| `depth`                | `"basic" \| "full"` | always                                        | Depth actually used                                                                                       |
| `xSearches`            | `number`            | at least one X tool call                      | X search calls. Omitted when zero so a non-zero value is visible                                          |
| `xQueries`             | `string[]`          | at least one recovered X query                | Queries parsed from X updates                                                                             |
| `sourcesTruncated`     | `true`              | more than 50 unique URLs                      | The `sources` array is a prefix                                                                           |
| `unknownSearchActions` | `string[]`          | an `action.type` we do not model              | Reported, never thrown on                                                                                 |
| `numResults`           | `number`            | the caller set `numResults`                   | The prompt-level target, not a count of what came back                                                    |
| `searchIncomplete`     | `string`            | `stopReason` is present and is not `end_turn` | The cut-off lead text                                                                                     |

### isError

`true` when the run was cut off, or when no sources came back and no X search ran. An X-only answer
is `isError: false` with the X lead line — the body is an answer, just not from the web.

### Notes

Pinned read-only, same as `review`, and takes no permission argument. Also passes
`--deny 'Bash(*)' 'Edit(*)' 'Write(*)'` for the same reason: a permission prompt cancels the run.
Never passes `--disable-web-search`.

`numResults` and `searchDepth` shape the prompt. The CLI has no flags for either. `--max-turns` is
almost never why a search comes back short — searches finish inside one turn. See
[CLAUDE.md](../CLAUDE.md#web-search).

```json
{
  "query": "What changed in the latest stable Node.js release?",
  "numResults": 5,
  "searchDepth": "basic"
}
```

## sessions

List and search Grok Build sessions from the local store (`$GROK_HOME/sessions`). Use this to find
an id worth passing to `grok`'s `resume`, or to `grok -r <id>` from any directory.

### Parameters

| Parameter | Type                  | Default | Description                                                                                                                                       |
| --------- | --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`   | `string`              | none    | Case-insensitive substring over title, first prompt, and id. Search is local-only: it does not consult `grok sessions search` or any remote index |
| `cwd`     | `string`              | none    | Keep only sessions that started in this directory. Resume still works from anywhere (`grok -r <id>`)                                              |
| `id`      | `string`              | none    | Exact session id lookup. Ignores `query`, `cwd`, and `limit`. Falls back to a case-insensitive match                                              |
| `limit`   | `number (int, 1–100)` | `20`    | Maximum rows to return. Ignored when `id` is set                                                                                                  |

Empty strings on `query`, `cwd`, and `id` are rejected (`minLength: 1`).

### Result

`id` lookup of a hit is a labelled detail block (title, first prompt, cwd, timestamps, model, git
facts, path) ending with a resume line.

`id` lookup of a miss:

`No session with id "<id>" was found in <sessionsDir>.`

then `Call sessions with no arguments to list what is there.`

An empty store (or a missing store) with no filters:

`No Grok sessions exist yet.`

then `A grok tool call creates one. The store is at <sessionsDir>.`

A list is a header
`Sessions[ that started in <cwd>][ matching "<query>"]: showing N of M (limit L, scanned S)`, an
optional `Partial listing from <sessionsDir>: …` line when rows were skipped, unreadable, or
first-prompt matching did not cover every record, then one row per session, then a resume hint:
`grok -r <id>` from any directory, or `resume: "<id>"` on the grok tool.

A fresh headless session has no title yet. Rows fall back to the first prompt; `titleSource` says
which you are looking at.

### _meta

| Key                     | Type             | When                                                        | Meaning                                                 |
| ----------------------- | ---------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| `sessions`              | `object[]`       | always                                                      | One object per returned row (see below)                 |
| `count`                 | `number`         | always                                                      | `sessions.length`                                       |
| `matched`               | `number`         | always                                                      | Hits before `limit`. For `id`, `1` or `0`               |
| `limit`                 | `number`         | always                                                      | Limit applied (still present on `id` lookup)            |
| `scope`                 | `string \| null` | always                                                      | Resolved `cwd` filter, or `null`                        |
| `query`                 | `string \| null` | always                                                      | The search string, or `null`                            |
| `scanned`               | `number`         | always                                                      | Session directories examined                            |
| `skipped`               | `number`         | always                                                      | Directories not read (scan cap)                         |
| `unreadable`            | `number`         | always                                                      | Missing or unreadable `summary.json`                    |
| `unlistedDirs`          | `number`         | always                                                      | Project directories whose children could not be listed  |
| `storeMissing`          | `boolean`        | always                                                      | The store root does not exist                           |
| `sessionsDir`           | `string`         | always                                                      | Absolute store path                                     |
| `found`                 | `boolean`        | `id` was set                                                | Whether the lookup hit                                  |
| `promptSearchTruncated` | `true`           | `query` set and more records than the prompt-scan cap (200) | First-prompt matching did not cover every loaded record |
| `promptSearchScanned`   | `number`         | `promptSearchTruncated`                                     | How many histories were opened                          |

Each `sessions[]` entry:

| Key              | Type                            | When   | Meaning                                           |
| ---------------- | ------------------------------- | ------ | ------------------------------------------------- |
| `id`             | `string`                        | always | Session id                                        |
| `cwd`            | `string`                        | always | Directory the session started in                  |
| `title`          | `string \| null`                | always | Generated title, if any                           |
| `titleSource`    | `"title" \| "prompt" \| "none"` | always | Where `label` came from                           |
| `label`          | `string`                        | always | Display label                                     |
| `firstPrompt`    | `string \| null`                | always | First real user prompt, when the history was read |
| `createdAt`      | `string \| null`                | always | ISO timestamp                                     |
| `updatedAt`      | `string \| null`                | always | ISO timestamp                                     |
| `numMessages`    | `number \| null`                | always | Message count                                     |
| `model`          | `string \| null`                | always | `current_model_id`                                |
| `agent`          | `string \| null`                | always | Agent name                                        |
| `sandboxProfile` | `string \| null`                | always | Sandbox profile                                   |
| `effort`         | `string \| null`                | always | Reasoning effort                                  |
| `gitBranch`      | `string \| null`                | always | Head branch when recorded                         |
| `headCommit`     | `string \| null`                | always | Head commit when recorded                         |
| `gitRemotes`     | `string[]`                      | always | Remotes when recorded                             |
| `path`           | `string`                        | always | Absolute session directory                        |
| `resumeCommand`  | `string`                        | always | `grok -r <id>`                                    |

### isError

Never. A miss is a successful answer. An unreadable store is the thrown-error envelope
(`sessions-store`).

### Notes

Search is local-only. `grok sessions search` also consults a remote index; this tool does not, so a
session that exists only server-side will not appear.

List recent sessions in a repo:

```json
{
  "cwd": "/home/nuru/repos/grok-build-to-claude",
  "limit": 10
}
```

Look up one id:

```json
{
  "id": "01a00a41-8f57-7de2-bb03-caccc61a1f0e"
}
```

## status

Poll a background `grok`, `review`, or `websearch` run, or list recent ones. Use this after
`background: true`. A finished run replays the original tool result — same stored text, same
metadata, same error flag — so background is a transport, not a second implementation.

### Parameters

| Parameter | Type                             | Default | Description                                                                                                                                              |
| --------- | -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`   | `string` (`<base36 ms>-<8 hex>`) | none    | Id of a background run to inspect. Omit to list recent runs. A value that is not this shape is `invalid-arguments`, not a miss — the store is not opened |
| `limit`   | `number (int, 1–100)`            | `20`    | Maximum rows to return in list mode. Ignored when `runId` is set                                                                                         |
| `waitMs`  | `number (int, 0–120000)`         | `0`     | Block up to this many milliseconds for the run to finish. Ignored in list mode. A timed-out wait is not an error                                         |
| `tail`    | `number (int, 0–65536)`          | `8192`  | Bytes of `progress.log` to include for a live run                                                                                                        |

### Result

List, empty store:

`No background runs recorded.`

then `The store is at <stateDir>.`

List, otherwise: `Background runs: showing N of M`, an optional `Partial listing from <stateDir>: …`
line, then one row per run (`<runId>  <state>  <tool>  <elapsed>  <summary>`). A completed fragment
is labelled `completed (cut off: <stopReason>)`, not as a clean finish.

Single run, unknown id (a well-formed id the store does not have):

`No background run with id "<runId>" was found in <stateDir>.`

then `Call status with no arguments to list what is there.`

Live run: a detail header (`run <id>  <state>  <tool>  <elapsed>`, cwd, timestamps, pids, last
progress) and the tailed `progress.log`.

Finished run, `completed` / `failed` / `abandoned` with a stored result: the same header, then the
stored tool text. That is the synchronous result, preceded by the header.

Finished with no stored result, leading line by state:

- `This run failed.` / `This run failed. <error>`
- `This run was abandoned.` / `This run was abandoned. <error>`
- `This run was cancelled.` / `This run was cancelled. <error>`
- `This run completed with no stored result.`

A `cancelled` run never renders as completed. Stored result and late sidecar appear under the
cancellation header as `The run also produced a result before it died:`, plus a resume line when a
session id is known. If two sessions in the same directory could both match:
`The run's session could not be identified uniquely. Candidates:` and the ids — no resume command.

A vanished worker is reported as `abandoned`, not as still running. That state is derived for
display, never written.

### _meta

List mode:

| Key          | Type       | When   | Meaning                                                                                                                                       |
| ------------ | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs`       | `object[]` | always | One object per row (`runId`, `state`, `tool`, `cwd`, timestamps, pids, progress, `sessionId`, `stopReason`, `cutOff`, `summary`, `elapsedMs`) |
| `count`      | `number`   | always | Rows returned                                                                                                                                 |
| `scanned`    | `number`   | always | Records examined                                                                                                                              |
| `unreadable` | `number`   | always | Unreadable records                                                                                                                            |
| `truncated`  | `boolean`  | always | Listing stopped at the scan cap                                                                                                               |
| `stateDir`   | `string`   | always | Absolute store path                                                                                                                           |

Single run, unknown id: `runId`, `found: false`, `stateDir`.

Single run, found — plus the stored result's `_meta` on a terminal replay:

| Key                 | Type                  | When                                            | Meaning                                                                   |
| ------------------- | --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `runId`             | `string`              | always                                          | The run                                                                   |
| `state`             | `string`              | always                                          | `starting`, `running`, `completed`, `failed`, `cancelled`, or `abandoned` |
| `tool`              | `string`              | always                                          | Originating tool                                                          |
| `cwd`               | `string`              | always                                          | Recorded working directory                                                |
| `createdAt`         | `string`              | always                                          | ISO timestamp                                                             |
| `startedAt`         | `string \| null`      | always                                          | When the worker marked the run running                                    |
| `endedAt`           | `string \| null`      | always                                          | When it became terminal                                                   |
| `workerPid`         | `number \| null`      | always                                          | Worker pid                                                                |
| `childPid`          | `number \| null`      | always                                          | grok child pid                                                            |
| `progressCount`     | `number`              | always                                          | Progress events seen                                                      |
| `lastProgress`      | `string \| null`      | always                                          | Last progress message                                                     |
| `sessionId`         | `string \| null`      | always                                          | Confirmed or recovered id; `null` if none                                 |
| `stopReason`        | `string \| null`      | always                                          | From the record                                                           |
| `cutOff`            | `boolean`             | always                                          | `completed` with a `stopReason` other than `end_turn`                     |
| `summary`           | `string`              | always                                          | Short label                                                               |
| `elapsedMs`         | `number`              | always                                          | Created → ended, or created → now if still live                           |
| `found`             | `true`                | found                                           | Distinguishes from the miss object                                        |
| `tailTruncated`     | `boolean`             | live run                                        | The `progress.log` tail was clipped                                       |
| `sessionIdSource`   | `"result" \| "store"` | a recovered id on `cancelled`                   | Whether the id came from a result object or from `~/.grok/sessions`       |
| `sessionCandidates` | `string[]`            | `cancelled` and more than one store hit         | Ambiguous recovery; no `resumeCommand`                                    |
| `lateResult`        | `object`              | `cancelled` and the worker wrote a late sidecar | That result's `_meta` plus `isError`                                      |

### isError

`true` when the stored result had `isError: true`, or when `state` is `failed` or `abandoned`.
`cancelled` is `false` — the caller asked for that. A miss and a live run are `false`. A timed-out
`waitMs` is `false`.

### Notes

`status` on a finished run returns what the synchronous call would have returned: same stored text,
same metadata keys, same `isError`, with a one-run header in front.

```json
{
  "runId": "mfk2p1x9-3ac71f0b",
  "waitMs": 30000
}
```

## stop

Terminate a background `grok`, `review`, or `websearch` run: the worker and the grok process it
spawned. Stopping an already-finished run is not an error.

### Parameters

| Parameter | Type                             | Default | Description                                                                                                                                   |
| --------- | -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`   | `string` (`<base36 ms>-<8 hex>`) | —       | The `runId` returned by a background `grok`, `review`, or `websearch` call. A value that is not this shape is `invalid-arguments`, not a miss |

### Result

Unknown id: same miss text as `status`.

Already terminal: `Run <id> was already <state> (ran <elapsed>, ended <time>).`

Lost the terminal claim because another process is finalizing a still-non-terminal record:
`Run <id> is still <state>; another process holds the terminal claim and is finalizing it. No signals were sent…`

Lost the claim because the run completed first:
`Run <id> completed before the stop landed (<state>, ran <elapsed>).`

Successful stop:

```
Stopped run <id> (<tool>, ran <elapsed>).
Signalled SIGTERM to process group <pid>; the tree exited.
```

(or `SIGTERM then SIGKILL`, or `The worker process was already gone.`)

Could not kill:

```
Could not stop run <id> (<tool>, ran <elapsed>).
<why>
The record is still <state>. Retry stop once the pid is findable, or reap the process by hand.
```

`<why>` is one of: no worker pid recorded; not permitted; SIGTERM then SIGKILL and the pid is still
running.

A cancelled mid-flight run may still have a session. When one id is known:
`The run was cancelled mid-flight, but it recorded a session before it ended:` and `grok -r <id>`.
Grok only reports a session id on `end`, which a stopped run never reaches — the id is read back
from the CLI's own store. `_meta.sessionIdSource` says which you have. Ambiguous candidates are
listed without a resume command.

### _meta

| Key                 | Type                  | When                                          | Meaning                                                                                |
| ------------------- | --------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `runId`             | `string`              | always                                        | The run                                                                                |
| `found`             | `boolean`             | always                                        | Whether the record existed                                                             |
| `stateDir`          | `string`              | miss                                          | Store path                                                                             |
| `state`             | `string`              | found                                         | Recorded state after the call                                                          |
| `tool`              | `string`              | found                                         | Originating tool                                                                       |
| `endedAt`           | `string \| null`      | found                                         | Terminal timestamp                                                                     |
| `signalsSent`       | `string[]`            | found                                         | Signals this call sent. Empty when nothing was signalled                               |
| `workerPid`         | `number \| null`      | found                                         | Pid that was (or would have been) signalled                                            |
| `killReason`        | `string`              | this call signalled, or failed to             | `gone`, `terminated`, `killed`, `no-pid`, `not-permitted`, `survived`                  |
| `alive`             | `boolean`             | this call signalled, or failed to             | Whether the worker still looks alive                                                   |
| `claimedByOther`    | `true`                | lost claim, record still non-terminal         | Another process holds the terminal claim                                               |
| `error`             | `string`              | already terminal and the record has an error  | Previous failure text (the tree may still be up). The recorded pid is not re-signalled |
| `sessionId`         | `string`              | a single id was resolved                      | Confirmed or recovered                                                                 |
| `sessionIdSource`   | `"result" \| "store"` | `sessionId` present                           | Where it came from                                                                     |
| `sessionCandidates` | `string[]`            | more than one store hit                       | Ambiguous; no resume command                                                           |
| `lateResult`        | `object`              | a late sidecar was read for a `cancelled` run | That result's `_meta` plus `isError`                                                   |

### isError

`true` only when the process tree could not be stopped (`no-pid`, `not-permitted`, `survived`). A
miss, an already-finished run, and a successful signal are `false`.

### Notes

A stop that could not kill the process tree is reported as a failure, not as a stopped run. The
record stays non-terminal so a retry is honest. A `cancelled` record next to a live process is the
failure mode this tool exists to avoid.

```json
{
  "runId": "mfk2p1x9-3ac71f0b"
}
```

## check

Readiness probe. Call this first when a grok tool behaves unexpectedly: server version, resolved
binary, permission ceiling, `grok version`, `grok models`, and run defaults.

### Parameters

This tool takes no arguments. An extra key is `invalid-arguments`.

### Result

A fixed block of labelled lines:

- `<server> v<version>`
- `grok binary`, `permission ceiling`, `default permission`, `default model`, `default effort`,
  `run timeout`, `state dir`, `sessions dir`, `structuredContent`
- `ok`, `grok version`, `authenticated`, `models`

`ok` is `true` only when both probes succeed. A missing or unauthenticated binary is `ok: false` in
this body, not a thrown error — a readiness probe that fails to report is useless.

When the ceiling is `read-only`, two extra lines tell you how to raise it
(`GROK_MCP_PERMISSION_CEILING=write` or `=full`).

### _meta

| Key                 | Type             | When   | Meaning                                                    |
| ------------------- | ---------------- | ------ | ---------------------------------------------------------- |
| `server`            | `string`         | always | MCP server name                                            |
| `version`           | `string`         | always | Package version                                            |
| `grokBinary`        | `string`         | always | Resolved executable                                        |
| `permissionCeiling` | `string`         | always | Active ceiling                                             |
| `defaultPermission` | `string`         | always | Level used when a call asks for none                       |
| `defaultModel`      | `string \| null` | always | Default `--model`, or `null` to let the CLI choose         |
| `defaultEffort`     | `string \| null` | always | Default `--effort`, or `null` to let the CLI choose        |
| `timeoutMs`         | `number`         | always | `GROK_MCP_TIMEOUT_MS`                                      |
| `stateDir`          | `string`         | always | Background-run store                                       |
| `sessionsDir`       | `string`         | always | `$GROK_HOME/sessions`                                      |
| `ok`                | `boolean`        | always | Both probes succeeded                                      |
| `grokVersion`       | `string \| null` | always | First line of `grok version`, or `null`                    |
| `authenticated`     | `boolean`        | always | `grok models` exited 0                                     |
| `models`            | `string[]`       | always | Ids parsed from `grok models`. Empty if none were reported |
| `versionProblem`    | `string \| null` | always | Why the version probe failed, or `null`                    |
| `authProblem`       | `string \| null` | always | Why the auth probe failed, or `null`                       |

### isError

Never. A failed probe is `ok: false` plus `versionProblem` / `authProblem`.

```json
{}
```

## help

`grok --help` passthrough. Use this to read the installed CLI's own flag list.

### Parameters

This tool takes no arguments. An extra key is `invalid-arguments`.

### Result

On success, the CLI's stdout. The request is capped at 15 seconds so a hung binary cannot hold the
full run wall clock. The cap is a minimum against `GROK_MCP_TIMEOUT_MS`, so a smaller timeout lowers
it and a larger one does not raise it.

Failure bodies: spawn failure (install the CLI or set `GROK_BINARY`); timeout, which names the cap
and says `GROK_MCP_TIMEOUT_MS` cannot raise it; client abort; non-zero exit with stdout and stderr
attached.

### _meta

None. This tool writes no `_meta`.

### isError

`true` on spawn failure, timeout, abort, or a non-zero exit. `false` when `grok --help` exits 0.

```json
{}
```
