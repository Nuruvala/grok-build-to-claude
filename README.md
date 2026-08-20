# grok-build-mcp-server

[![npm](https://img.shields.io/npm/v/grok-build-mcp-server?style=flat-square)](https://www.npmjs.com/package/grok-build-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.Nuruvala%2Fgrok--build--mcp--server-6E56CF?style=flat-square)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Nuruvala/grok-build-mcp-server)
[![CI](https://img.shields.io/github/actions/workflow/status/Nuruvala/grok-build-to-claude/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Nuruvala/grok-build-to-claude/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/grok-build-mcp-server?style=flat-square)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=grok-build&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22grok-build-mcp-server%22%5D%7D)
[![Install in Cursor](https://img.shields.io/badge/Cursor-Install_server-1c1c1c?style=flat-square)](https://cursor.com/install-mcp?name=grok-build&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImdyb2stYnVpbGQtbWNwLXNlcnZlciJdfQ%3D%3D)

An [MCP](https://modelcontextprotocol.io) stdio server that exposes the [Grok Build](https://x.ai)
CLI (`grok`) as tools you can call from Claude Code, Cursor, VS Code, or any other MCP client.

```
Claude Code  ──stdio/MCP──▶  grok-build-mcp-server  ──spawn──▶  grok CLI  ──▶  xAI API
```

It is a thin process wrapper. It does not reimplement agent logic and does not talk to the xAI API
directly — all the intelligence stays in the `grok` CLI. What this server adds is faithful argument
construction, robust process supervision, and clean MCP-shaped output.

> **Status: 0.2.2.** The tool surface is complete. The server runs real headless Grok agents in the
> foreground or detached in the background, streams progress while they run, stops a run on request,
> reviews git diffs, researches questions on the web, lists the sessions those runs created, and
> reports session, usage, and cost. See [CHANGELOG.md](CHANGELOG.md) for what shipped and
> [ROADMAP.md](ROADMAP.md) for what was considered and rejected.

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

If `grok` is not on your `PATH`, set `GROK_BINARY` to its full path when you register the server.

## Install

### Claude Code

```bash
claude mcp add grok-build -s user -- npx -y grok-build-mcp-server
```

`-s user` registers the server for your whole account rather than for the directory you happen to be
in. Without it the scope is that one project, which is rarely what you want for a general coding
assistant, and the symptom is a server that is missing the next time you start Claude Code somewhere
else.

Then, in Claude Code:

```
> use the grok-build check tool
```

`check` reports the resolved binary, the CLI version, whether you are authenticated, and the active
permission ceiling. If it is happy, the rest will work.

### Any other MCP client

The server speaks MCP over stdio and takes no arguments of its own:

```json
{
  "mcpServers": {
    "grok-build": {
      "command": "npx",
      "args": ["-y", "grok-build-mcp-server"]
    }
  }
}
```

VS Code and Cursor accept the install badges at the top of this page, which carry exactly that
configuration.

Clients that install from the [MCP Registry](https://registry.modelcontextprotocol.io) know this
server as `io.github.Nuruvala/grok-build-mcp-server`. The registry entry is published from the same
tag as the npm release and points at the same package.

### If `npx` cannot find the server

`npx` resolves a bare package name against the _local_ project first. If your MCP client's working
directory is a checkout of this repository — or of anything else whose `package.json` is named
`grok-build-mcp-server` — `npx -y grok-build-mcp-server` runs the local entry point, does not find
one, and fails with `command not found`. Install it somewhere of its own and register that path:

```bash
npm install --prefix ~/.local/share/grok-build-mcp grok-build-mcp-server
claude mcp add grok-build -s user -- ~/.local/share/grok-build-mcp/node_modules/.bin/grok-build-mcp-server
```

## Permissions

Grok runs launched through this server are **read-only by default**: `--permission-mode plan` with
`--sandbox read-only`. Nothing can modify your files until you say so.

Permission is a **ceiling**, set once when you register the server, rather than a prompt on every
call. Three levels:

| Level                 | `--permission-mode` | `--sandbox` | What it allows                     |
| --------------------- | ------------------- | ----------- | ---------------------------------- |
| `read-only` (default) | `plan`              | `read-only` | Reading and reasoning. No edits    |
| `write`               | `auto`              | `workspace` | Edits inside the working directory |
| `full`                | `bypassPermissions` | `off`       | Unattended full approval           |

The sandbox is not advisory, and a refusal is not a warning. Under `write` the run **cannot write
outside `cwd`**, and a refused tool call ends the **whole run**: the CLI reports
`stopReason: cancelled`, exits 0, and returns only whatever the model had said before the refusal.
The server names the refused call and its path in that case, so a refused tool is not mistaken for a
model that gave up. The server can see which call failed, not why the CLI refused it. If a run must
write somewhere else, say a report outside the repository, either point it at a path inside `cwd` or
use `full`.

`write` uses `--permission-mode auto` rather than `acceptEdits`, which is measured rather than
inherited from the flag's name. Headless grok has no human to accept an edit, so under
`acceptEdits`, `dontAsk` and `default` every file mutation is refused and the run dies, on both
sandbox profiles. `auto` and `bypassPermissions` both work; `auto` is the narrower one, and it still
refuses a write outside the workspace, so `full` remains a real step up rather than a synonym.

To let Grok make edits:

```bash
claude mcp add grok-build -s user \
  -e GROK_MCP_PERMISSION_CEILING=write \
  -e GROK_MCP_DEFAULT_PERMISSION=write \
  -- npx -y grok-build-mcp-server
```

Use `full` only if you already run your MCP client with full approval and want the delegated Grok
run to be equally unattended. It grants the spawned `grok` process the same authority you have.

A call that requests more than the ceiling is **rejected, not silently downgraded** — a clamped run
would report success while changing nothing, which is worse than a clear error.

## Environment variables

| Variable                       | Default                    | Purpose                                                          |
| ------------------------------ | -------------------------- | ---------------------------------------------------------------- |
| `GROK_BINARY`                  | `grok`                     | Path to the `grok` executable                                    |
| `GROK_MCP_PERMISSION_CEILING`  | `read-only`                | Highest level any call may request                               |
| `GROK_MCP_DEFAULT_PERMISSION`  | `read-only`                | Level used when a call requests none                             |
| `GROK_MCP_DEFAULT_MODEL`       | `grok-4.6`                 | Model when a call omits one. `none` defers to the CLI            |
| `GROK_MCP_DEFAULT_EFFORT`      | `high`                     | Reasoning effort when a call omits one. `none` defers to the CLI |
| `GROK_MCP_TIMEOUT_MS`          | `1800000`                  | Wall clock for a single run                                      |
| `GROK_MCP_STATE_DIR`           | `$XDG_STATE_HOME/grok-mcp` | Background job records                                           |
| `GROK_MCP_MAX_CONCURRENT_RUNS` | `4`                        | Background runs alive at once. `off` for no cap                  |
| `GROK_MCP_LOG_LEVEL`           | `info`                     | `debug`, `info`, `warn`, `error`. Logs go to stderr              |
| `STRUCTURED_CONTENT_ENABLED`   | off                        | Also emit `structuredContent` alongside `_meta`                  |

Grok's own variables (`XAI_API_KEY`, `GROK_HOME`, `GROK_DISABLE_AUTOUPDATER`) pass through to the
child process untouched.

## Tools

| Tool        | Read-only  | Purpose                                                                                         |
| ----------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `grok`      | by ceiling | Run a headless Grok agent. Prompt, session resume/continue/fork, model, effort, tool allow/deny |
| `review`    | always     | Review a git diff: working tree, a merge-base diff against a ref, or a single commit            |
| `websearch` | always     | Research a question on the web, and report which searches and sources it actually used          |
| `status`    | always     | Poll a background run, or list recent ones                                                      |
| `stop`      | no         | Terminate a background run's process tree                                                       |
| `sessions`  | always     | List, search, and look up the Grok sessions on this machine                                     |
| `check`     | yes        | Server version, resolved binary, `grok version`, auth, permission ceiling, run defaults         |
| `help`      | yes        | `grok --help` passthrough                                                                       |

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

### `websearch`

```
> websearch: what changed in the latest Bun release?
> search the web for how Postgres handles advisory lock contention, in depth
```

`numResults` (1–50) and `searchDepth` (`basic` or `full`) shape the prompt — the `grok` CLI has no
flags for either, and neither parameter pretends otherwise. They do work: the same question asked at
`basic` made one search across two pages, and at `full` made six searches across three, for two and
a half times the cost.

**The result tells you what was actually looked up**, not just what the model wrote:

```
[1 web search, 9 sources]
```

with `_meta` carrying `webSearches`, `webToolCalls`, `searchQueries`, `sources`, `sourceCount`,
`pagesOpened`, and `searchPerformed`. That matters more than it sounds. Grok can research through
web search or through X, and when the web is unavailable it will quietly do the second — answering
confidently, citing `x.com`, exiting successfully. The prose gives you no way to tell. So a run that
searched X and not the web says so in its first line and reports `xSearches` separately, and a run
where nothing came back at all is an error rather than a confident-looking answer from the model's
own memory:

```
No search ran. The answer below is the model's own prior knowledge, not current sources.
```

`searchPerformed` means sources came back — not that a search was attempted. A search that started
and never returned, or returned an empty result set, is reported as what it was.

Like `review`, `websearch` is **always read-only** and takes no `permission`, `write`, or `yolo`
argument. It never passes `--disable-web-search`.

### Background runs, `status`, and `stop`

A long agent run does not have to occupy your client. Pass `background: true` to `grok`, `review`,
or `websearch` and the call returns a `runId` immediately, while a detached worker process runs the
job to completion:

```
> have grok refactor the parser in the background
> status
> status the run from a minute ago and wait 30s for it
> stop that run
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

`stop` ends a run early. It signals the worker's whole process group — the worker and the `grok`
process it spawned — with SIGTERM, then SIGKILL if that is not enough. Stopping an already-finished
run is not an error, and neither is stopping one that finished a moment before your call landed.

**A stop that could not kill the process tree is reported as a failure, not as a stopped run.** If
there is nothing to signal, or the kill is refused, or the tree survives SIGKILL, the run is left
reading `running` and the call returns an error naming the pid. A `cancelled` record sitting next to
a live process would be the tidier answer and the useless one.

A run you stop mid-flight has usually already produced something worth keeping, and both the partial
result and the session id are preserved:

```
Stopped run msxji60o-8f5e27c4 (grok, ran 20s).
Signalled SIGTERM to process group 1703005; the tree exited.

The run was cancelled mid-flight, but it recorded a session before it ended:
  grok -r 01a010e2-478c-73d2-bce9-23552245c64d
```

Grok only reports a session id when a run reaches its end, which a stopped one never does — so that
id is read back from the CLI's own session store rather than reconstructed. `_meta.sessionIdSource`
tells you which you have. If two runs in the same directory could both match, you get the candidate
ids and no resume command: resuming the wrong session continues somebody else's work.

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

- [docs/api-reference.md](docs/api-reference.md) — every tool's parameters, result text, `_meta`
  keys, and the exact conditions under which each is set.
- [docs/security.md](docs/security.md) — what registering this server authorises, what each
  permission level actually grants, and what leaves your machine.
- [docs/engineering.md](docs/engineering.md) — how code is written here: architecture, functional
  TypeScript rules, error and effect discipline, testing and coverage policy, commit workflow.
- [CLAUDE.md](CLAUDE.md) — project background and the verified `grok` CLI behaviour this server
  depends on.
- [ROADMAP.md](ROADMAP.md) — milestones, acceptance criteria, and the ideas that were measured and
  rejected.

### Releasing

Bump `version` in `package.json`, move the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md)
under the new version heading, commit, then:

```bash
git tag -a v0.2.0 -m v0.2.0 && git push origin v0.2.0
```

[.github/workflows/release.yml](.github/workflows/release.yml) runs the full gate, refuses to
publish if the tag and `package.json` disagree, installs the packed tarball into a scratch directory
and drives a real `initialize` against the installed binary, then publishes **that same file** and
cuts a GitHub release.

There is no publish credential to manage. Authentication is
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers): the workflow exchanges a
short-lived OIDC token, and npm generates the provenance attestation on its own. The trust is
registered against this repository and this workflow's **filename**, so renaming `release.yml`
breaks publishing — and npm does not check the configuration until a publish is attempted, where the
symptom is `ENEEDAUTH` rather than anything that names the cause.

## License

MIT — see [LICENSE](LICENSE).
