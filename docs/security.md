# Security

This server spawns the `grok` CLI as you, with your environment and your credentials. The spawned
process talks to the xAI API, reads your working directory, and — at the permission level you grant
— writes files and runs shell commands. Everything below is about the bounds on that process.

## The permission ceiling

Permission is a ceiling set once when you register the server, not a prompt on every call. Three
levels:

| Level                 | `--permission-mode`                          | `--sandbox` | What it allows                     |
| --------------------- | -------------------------------------------- | ----------- | ---------------------------------- |
| `read-only` (default) | `plan`                                       | `read-only` | Reading and reasoning. No edits    |
| `write`               | `acceptEdits`                                | `workspace` | Edits inside the working directory |
| `full`                | `bypassPermissions` (via `--always-approve`) | `off`       | Unattended full approval           |

Two environment variables control it:

- `GROK_MCP_PERMISSION_CEILING` — the highest level any call may request. Default `read-only`.
- `GROK_MCP_DEFAULT_PERMISSION` — the level a call gets when it asks for nothing. Default
  `read-only`. Must be at or below the ceiling; a default above the ceiling kills the process at
  startup.

Two design decisions, and why:

The grant is made once at registration, not per call. A per-call prompt in an MCP server has nobody
to prompt — the run is headless — and a workflow that stops mid-way to ask is the failure this
server was built to avoid.

A call above the ceiling is rejected, naming the requested level, the active ceiling, and the env
var to change (`GROK_MCP_PERMISSION_CEILING`). It is never silently downgraded, because a clamped
run reports success and changed nothing.

The server cannot detect the caller's own approval level. Claude Code exports `CLAUDECODE`,
`CLAUDE_CODE_ENTRYPOINT`, and session ids, and nothing describing permission mode. The operator's
env config is the only honest signal, and the server does not infer a grant from those variables.

## What each level authorises

### `read-only`

`--permission-mode plan` with `--sandbox read-only`. The spawned `grok` can read the working
directory and reason about it. It cannot edit files. This is the default, and an unconfigured
install stays here.

`review` and `websearch` are pinned at this level regardless of the ceiling. They take no
`permission`, `write`, or `yolo` argument.

### `write`

`--permission-mode acceptEdits` with `--sandbox workspace`. The spawned `grok` can edit files inside
the working directory you point it at. Writes outside that directory are scoped by the CLI's
workspace sandbox.

Register it only if you want delegated Grok runs to change the tree:

```bash
claude mcp add grok-build \
  -e GROK_MCP_PERMISSION_CEILING=write \
  -e GROK_MCP_DEFAULT_PERMISSION=write \
  -- npx -y grok-build-mcp-server
```

### `full`

`--always-approve` (`--permission-mode bypassPermissions`) with `--sandbox off`. The spawned `grok`
runs shell commands, writes anywhere your user can write, and reaches the network, unattended,
driven by model output. That is the grant, stated plainly.

It is the right setting for an operator who already runs their MCP client with full approval and
wants the delegated Grok run to be equally unattended. It is not a sandbox, and there is no
confirmation step behind it.

```bash
claude mcp add grok-build \
  -e GROK_MCP_PERMISSION_CEILING=full \
  -e GROK_MCP_DEFAULT_PERMISSION=full \
  -- npx -y grok-build-mcp-server
```

## Sandbox limits

`--sandbox read-only` blocks child-process network on Linux via seccomp and is a **no-op on macOS**.
It is not a network guarantee: Grok's own web and X tools are server-side and still run under
read-only. `workspace` scopes writes to the working directory.

The sandbox is the CLI's, not ours. This server selects it; the CLI enforces it; the guarantees are
whatever that version of `grok` provides.

## Why the read-only tools also carry deny rules

In headless mode a tool request that would need a human to approve does not get refused; it
**cancels the entire run**, and the CLI still exits 0. Plan mode, and even
`--permission-mode dontAsk`, look like they deny the tool and do not — they cancel at turn 1 with no
answer.

An explicit `--deny` rule is recoverable where a permission prompt is fatal: the model is told no,
says so, and finishes. Measured against grok 1.0.4 (see [CLAUDE.md](../CLAUDE.md) for the table):

- no deny rule → `stopReason: "cancelled"`, turn 1, no answer
- `--deny 'Bash(*)'` → `end_turn`, the model reports the refusal and continues
- `--deny 'Bash(*)' 'Edit(*)' 'Write(*)'` → `end_turn` after both refusals, file unchanged

So `review` and `websearch` pass `--deny 'Bash(*)' 'Edit(*)' 'Write(*)'` in addition to plan mode.
Plan mode alone looks equivalent to a deny rule and is not.

## Untrusted input

The model reads content you did not write: a diff under review, files in the working directory, web
pages and X posts during a `websearch`. That content can try to steer the agent.

Two consequences, both already true in the code:

- `review` and `websearch` are pinned read-only and take no `permission`, `write`, or `yolo`
  argument, so no amount of steering turns them into a writer.
- At `write` or `full`, a `grok` run acts on model output. That is the grant, working as configured;
  the mitigation is the ceiling, the working directory you point it at, and version control.

This server does not filter, scan, or redact prompts, and it does not inspect what the model decided
to do.

## Command construction

The server never builds a shell string. Every invocation is `spawn(binary, argv)` with an array and
no `shell: true`, so prompt text — quotes, `$`, newlines, backticks — cannot become shell syntax on
the way to the CLI.

The one real constraint this leaves: a single argv element is capped at 128 KiB on Linux
(`MAX_ARG_STRLEN`), which is why large prompts go through `--prompt-file`.

At `full`, the CLI itself runs shell commands on the model's behalf. Argv discipline protects the
boundary we own, not the one we granted.

## What leaves your machine

The prompt, and for `review` the entire diff, are sent to the xAI API by the `grok` CLI. File
contents the agent chooses to read go with it. `websearch` sends queries to a search backend. Anyone
reviewing a private repo through this server should know their code leaves the machine.

## What lands on disk

Four places, none of them encrypted:

- `GROK_MCP_STATE_DIR` (default `$XDG_STATE_HOME/grok-mcp`, then `$HOME/.local/state/grok-mcp`, then
  a `grok-mcp` directory under the system temp directory if neither variable is set): one directory
  per background run, holding the tool's full arguments — the prompt, or for `review` the entire
  diff — plus the result and the progress log. Created `0700` with `0600` files as of this version.
  A directory created by an earlier version keeps its old mode; tighten it once with
  `chmod -R go-rwx` on the state directory.

  A retention sweep runs after each worker finishes: it deletes terminal records older than 14 days,
  terminal records past the newest 200 directories of any state, and non-terminal records that are
  both orphaned and older than 14 days. Because the 200 counts directories rather than finished
  runs, a busy machine can drop a recent completed record. That is a disk-space bound, not a privacy
  guarantee, and it is not a secure erase.

- A prompt over 64 KiB is delivered by file rather than argv, and this server writes that file: a
  `mkdtemp` directory under the system temp directory (`grok-mcp-prompt-*`, mode `0700`) holding
  `prompt.txt` at `0600`. It is deleted when the run ends, on both the success and failure paths.
  This is how a large `review` diff actually reaches the CLI. The retention sweep does not touch it,
  because it is gone before the sweep would look.
- `$GROK_HOME/sessions` (default `~/.grok/sessions`): the CLI's own store, containing the full chat
  history of every run. Not ours to manage — this server reads it and never writes it, and the
  retention sweep does not touch it.
- Offloaded prompts: a large prompt is written by the CLI to
  `~/.grok/sessions/<cwd>/<id>/prompts/prompt_0.txt`.

## Credentials

The server never reads, stores, or logs `XAI_API_KEY`. `execGrok` does not construct a child
environment: it omits `env` unless a caller supplies one, and the grok-run path never does, so the
child inherits this process's environment untouched — including Grok's own variables (`XAI_API_KEY`,
`GROK_HOME`, `GROK_DISABLE_AUTOUPDATER`).

## Reporting a problem

Privately via
[GitHub Security Advisories](https://github.com/Nuruvala/grok-build-to-claude/security/advisories/new)
on `Nuruvala/grok-build-to-claude`. Anything that is not sensitive can be a public GitHub issue
instead.
