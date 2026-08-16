# grok-build-mcp-server

An [MCP](https://modelcontextprotocol.io) stdio server that exposes the [Grok Build](https://x.ai)
CLI (`grok`) as tools you can call from Claude Code, Cursor, VS Code, or any other MCP client.

```
Claude Code  ──stdio/MCP──▶  grok-build-mcp-server  ──spawn──▶  grok CLI  ──▶  xAI API
```

It is a thin process wrapper. It does not reimplement agent logic and does not talk to the xAI API
directly — all the intelligence stays in the `grok` CLI. What this server adds is faithful argument
construction, robust process supervision, and clean MCP-shaped output.

> **Status: early.** M2 is complete: the server runs real headless Grok agents, streams progress
> while they run, and reports session, usage, and cost. The `review`, `websearch`, `sessions`,
> `status`, and `stop` tools are on the way — see [ROADMAP.md](ROADMAP.md).

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

| Tool    | Read-only  | Purpose                                                                                         |
| ------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `grok`  | by ceiling | Run a headless Grok agent. Prompt, session resume/continue/fork, model, effort, tool allow/deny |
| `check` | yes        | Server version, resolved binary, `grok version`, auth, permission ceiling, run defaults         |
| `help`  | yes        | `grok --help` passthrough                                                                       |

`review`, `websearch`, `sessions`, `status`, and `stop` are still on the roadmap.

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
