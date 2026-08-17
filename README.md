# grok-build-mcp-server

An [MCP](https://modelcontextprotocol.io) stdio server that exposes the [Grok Build](https://x.ai)
CLI (`grok`) as tools you can call from Claude Code, Cursor, VS Code, or any other MCP client.

```
Claude Code  ──stdio/MCP──▶  grok-build-mcp-server  ──spawn──▶  grok CLI  ──▶  xAI API
```

It is a thin process wrapper. It does not reimplement agent logic and does not talk to the xAI API
directly — all the intelligence stays in the `grok` CLI. What this server adds is faithful argument
construction, robust process supervision, and clean MCP-shaped output.

> **Status: early.** M5a is complete: the server runs real headless Grok agents in the foreground or
> detached in the background, streams progress while they run, reviews git diffs, lists the sessions
> those runs created, and reports session, usage, and cost. The `stop` and `websearch` tools are on
> the way — see [ROADMAP.md](ROADMAP.md).

## Progress

A long agent run is visible while it happens, rather than a silent wait ending in a wall of text.
When your client sends a `progressToken`, the server runs Grok with `--output-format streaming-json`
and forwards a notification per event:

```
#5  list_dir .
#6  read_file README.md
#7  read_file — completed
#8  thinking: the user asked me to list files, read README.md, then …
#10 writing: DONE
#11 finished: end_turn (2 turns)
```

Progress tracks what the agent is doing, not what phase it is in. Reasoning and response text are
coalesced so a token stream does not flood your client, while tool calls are reported as they
happen. Clients that support `resetTimeoutOnProgress` will not time out mid-run.

A client that sends no `progressToken` gets the cheaper non-streaming path and pays nothing for
this.

## Requirements

- [Grok Build CLI](https://x.ai) 1.0.0 or newer, authenticated (`grok models` should succeed)
- Node.js 22 or newer

## Install

```bash
claude mcp add grok-build -- npx -y grok-build-mcp-server
```

Then, in Claude Code:

```
> use the grok-build check tool
```

## Permissions

Grok runs launched through this server are **read-only by default**: `--permission-mode plan` with
`--sandbox read-only`. Nothing can modify your files until you say so.

Permission is a **ceiling**, set once when you register the server, rather than a prompt on every
call. Three levels:

| Level                 | `--permission-mode` | `--sandbox` | What it allows                     |
| --------------------- | ------------------- | ----------- | ---------------------------------- |
| `read-only` (default) | `plan`              | `read-only` | Reading and reasoning. No edits    |
| `write`               | `acceptEdits`       | `workspace` | Edits inside the working directory |
| `full`                | `bypassPermissions` | `off`       | Unattended full approval           |

To let Grok make edits:

```bash
claude mcp add grok-build \
  -e GROK_MCP_PERMISSION_CEILING=write \
  -e GROK_MCP_DEFAULT_PERMISSION=write \
  -- npx -y grok-build-mcp-server
```

Use `full` only if you already run your MCP client with full approval and want the delegated Grok
run to be equally unattended. It grants the spawned `grok` process the same authority you have.

A call that requests more than the ceiling is **rejected, not silently downgraded** — a clamped run
would report success while changing nothing, which is worse than a clear error.

## Environment variables

| Variable                      | Default                    | Purpose                                                          |
| ----------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `GROK_BINARY`                 | `grok`                     | Path to the `grok` executable                                    |
| `GROK_MCP_PERMISSION_CEILING` | `read-only`                | Highest level any call may request                               |
| `GROK_MCP_DEFAULT_PERMISSION` | `read-only`                | Level used when a call requests none                             |
| `GROK_MCP_DEFAULT_MODEL`      | `grok-4.6`                 | Model when a call omits one. `none` defers to the CLI            |
| `GROK_MCP_DEFAULT_EFFORT`     | `high`                     | Reasoning effort when a call omits one. `none` defers to the CLI |
| `GROK_MCP_TIMEOUT_MS`         | `1800000`                  | Wall clock for a single run                                      |
| `GROK_MCP_STATE_DIR`          | `$XDG_STATE_HOME/grok-mcp` | Background job records                                           |
| `GROK_MCP_LOG_LEVEL`          | `info`                     | `debug`, `info`, `warn`, `error`. Logs go to stderr              |
| `STRUCTURED_CONTENT_ENABLED`  | off                        | Also emit `structuredContent` alongside `_meta`                  |

Grok's own variables (`XAI_API_KEY`, `GROK_HOME`, `GROK_DISABLE_AUTOUPDATER`) pass through to the
child process untouched.

## Tools

| Tool       | Read-only  | Purpose                                                                                         |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `grok`     | by ceiling | Run a headless Grok agent. Prompt, session resume/continue/fork, model, effort, tool allow/deny |
| `review`   | always     | Review a git diff: working tree, a merge-base diff against a ref, or a single commit            |
| `status`   | always     | Poll a background run, or list recent ones                                                      |
| `sessions` | always     | List, search, and look up the Grok sessions on this machine                                     |
| `check`    | yes        | Server version, resolved binary, `grok version`, auth, permission ceiling, run defaults         |
| `help`     | yes        | `grok --help` passthrough                                                                       |

`stop` and `websearch` are still on the roadmap.

### `review`

The diff is collected in-process and embedded in the prompt, so the model does not spend turns
rediscovering what it is meant to review.

```
> review my working tree with grok-build
> review the diff against origin/main
```

Targets are `uncommitted`, `base: "<ref>"` (a merge-base diff, so commits that landed on the base
after you branched are not attributed to you), or `commit: "<sha>"`. With none given it
auto-detects: the upstream diff when your branch is ahead, otherwise the working tree — and it says
which it chose rather than guessing silently.

`review` is **always read-only**, whatever `GROK_MCP_PERMISSION_CEILING` allows. It takes no
`permission`, `write`, or `yolo` argument, because a review that edits the code under review is
never what was wanted.

Pass `structured: true` for machine-readable findings (`severity`, `file`, `line`, `summary`,
`rationale`) on `_meta.findings`, validated before you see them.

Two different things can go wrong, and they are reported differently rather than blurred together:

- **The run never finished** — it was cut off, or ended without producing its findings. There is no
  review, so the call is `isError: true` and `_meta.findingsComplete` is `false`. The body leads
  with why, quoting the CLI's own reason, and names the fix that fits the actual cause.
- **The run finished but its output will not validate.** The call still succeeds, returning the raw
  text plus a `_meta.parseError` — a degraded review beats a failed one.

What you will never get is a plausible-looking finding that the model made up. `--json-schema`
constrains every message the model emits, so while it is still reading it has no way to say "I am
working" except in the shape of a finding — and left unchecked it does exactly that. The schema
carries a required `status` field to keep that narration out of your results, and nothing is ever
salvaged from a partial response by pattern-matching.

Structured reviews of large targets do fail this way with some regularity. The failure is loud by
design.

A review that reaches for a shell is refused, not killed. In headless mode an unapprovable tool
request cancels the entire run while the CLI still exits 0, so `review` denies the shell and edit
tools outright — the model is told no and finishes its review instead of dying mid-sentence.

### Background runs and `status`

A long agent run does not have to occupy your client. Pass `background: true` to `grok` or `review`
and the call returns a `runId` immediately, while a detached worker process runs the job to
completion:

```
> have grok refactor the parser in the background
> status
> status the run from a minute ago and wait 30s for it
```

The run belongs to the machine, not to this server: it keeps going if your MCP client disconnects,
if the server restarts, or if you close your editor. Records live under `GROK_MCP_STATE_DIR`, one
directory per run.

**`status` on a finished run returns what the synchronous call would have returned** — same text,
same metadata, same error flag. Background is a transport for a tool call, not a second
implementation of one. While a run is live you get its state, elapsed time, both process ids, and
the tail of its progress log; `waitMs` blocks for up to two minutes and forwards progress
notifications as they arrive. A timed-out wait is not an error.

Two kinds of dishonesty are ruled out by construction. A run whose worker process no longer exists
is reported as `abandoned` rather than as still running — the machine rebooted, or something killed
it. And a run that finished early is labelled as such:

```
mfk2p1x9-3ac71f0b  completed (cut off: cancelled)  grok  4m 12s  refactor the parser
```

Validation still happens before you get a `runId`: a request above `GROK_MCP_PERMISSION_CEILING`, or
a contradictory pair of session flags, is rejected as a failed call rather than accepted and then
failed in a process nobody is watching.

There is no `stop` tool yet — a background run ends when it finishes or when it hits
`GROK_MCP_TIMEOUT_MS`.

### `sessions`

Every Grok run leaves a session on disk, and every session id this server reports can be resumed
later — from any directory, by you in a terminal or by another tool call.

```
> list my recent grok sessions
> what grok sessions did I run in this repo?
> find the grok session about the rate limiter
```

Sessions are read from `$GROK_HOME/sessions` (default `~/.grok/sessions`), which is the CLI's own
store, so they survive restarts of this server, of your MCP client, and of your machine. Pass `id`
for one session, `query` for a case-insensitive search over titles, first prompts, and ids, `cwd` to
scope to one project, and `limit` to bound the list.

A run that has just finished has no title yet — Grok fills those in later, if at all — so rows fall
back to the first prompt of the session, and `titleSource` tells you which you are looking at. Every
row carries `resumeCommand`, and so does every `grok` and `review` result:

```
grok -r 01a00c8d-970c-7531-8a12-31dac582c22b
```

Search is local-only. `grok sessions search` also consults a remote index; this tool does not, so a
session that exists only server-side will not appear.

## Development

```bash
npm install
npm run build          # tsc -> dist/
npm run dev            # tsx src/index.ts
npm test               # node --test via tsx
npm run test:coverage  # same, with enforced coverage floors
npm run lint
npm run typecheck
npm run format
```

- [docs/engineering.md](docs/engineering.md) — how code is written here: architecture, functional
  TypeScript rules, error and effect discipline, testing and coverage policy, commit workflow.
- [CLAUDE.md](CLAUDE.md) — project background and the verified `grok` CLI behaviour this server
  depends on.
- [ROADMAP.md](ROADMAP.md) — milestones and acceptance criteria.

## License

MIT — see [LICENSE](LICENSE).
