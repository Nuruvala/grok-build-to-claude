# Changelog

All notable changes to `grok-build-mcp-server` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by pushing a `vX.Y.Z` tag matching `package.json`; see
[.github/workflows/release.yml](.github/workflows/release.yml). At tag time the `Unreleased` heading
below becomes the version heading and a fresh empty `Unreleased` takes its place.

## Unreleased

Initial release. An MCP stdio server that exposes the [Grok Build](https://x.ai) CLI as tools for
Claude Code, Cursor, VS Code, and any other MCP client.

### Added

- **Eight tools**: `grok` (headless agent run), `review` (git diff review), `websearch` (web
  research), `sessions` (list and search the CLI's own session store), `status` and `stop`
  (background runs), `check` (readiness probe) and `help` (`grok --help` passthrough).
- **A permission ceiling set at registration**, not per call. `GROK_MCP_PERMISSION_CEILING` and
  `GROK_MCP_DEFAULT_PERMISSION` select `read-only` (default), `write`, or `full`. A call above the
  ceiling is rejected naming the fix, never silently downgraded.
- **Progress streaming**. When the client sends a `progressToken` the run uses
  `--output-format streaming-json` and forwards a notification per event — tool calls as they
  happen, reasoning and response text coalesced.
- **Background runs that outlive the server.** `background: true` on `grok`, `review`, or
  `websearch` returns a `runId` from a detached worker; records live under `GROK_MCP_STATE_DIR` and
  survive a restart of this server, the MCP client, or the machine.
- **Structured review findings** via `--json-schema`, with a `status` discriminator that keeps the
  model's own progress narration out of the results, and a cut-off run reported as an error rather
  than as a short review.
- **Search accounting on `websearch`**: `webSearches`, `webToolCalls`, `searchQueries`, `sources`,
  and `searchPerformed`, so an answer the model sourced from X — or from nothing — is
  distinguishable from one backed by web results.
- **Session ids that resume.** Every reported id is one the CLI confirmed, or one read back from
  `~/.grok/sessions`, with `sessionIdSource` saying which. Never a locally generated stand-in.
- **Bounded everything**: 10 MB per stream with an explicit truncation marker, a wall clock
  (`GROK_MCP_TIMEOUT_MS`, default 30 minutes) enforced with SIGTERM then SIGKILL of the process
  group, and partial output returned alongside any error rather than discarded.
- Documentation: [README.md](README.md), [docs/api-reference.md](docs/api-reference.md),
  [docs/security.md](docs/security.md), and [docs/engineering.md](docs/engineering.md).

### Security

- Background-run records are created `0700` with `0600` files. A record holds the tool's full
  arguments — the prompt, and for `review` the entire diff.
