# Changelog

All notable changes to `grok-build-mcp-server` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by pushing a `vX.Y.Z` tag matching `package.json`; see
[.github/workflows/release.yml](.github/workflows/release.yml). At tag time the `Unreleased` section
becomes the version heading and a fresh empty `Unreleased` takes its place.

## Unreleased

### Security

- `runId` is validated as a path segment before it is joined onto the state directory. `status` and
  `stop` accept only the shape `newRunId` issues (`<base36 ms>-<8 hex>`); `runDir` refuses anything
  else, and directory listings skip names that are not run ids. Previously `path.join` normalised a
  `runId` containing `..`, so a call could read a `record.json` — or, via `status` `tail`, a
  `worker.log` — from any directory on the machine and return it to the model.

### Added

- `GROK_MCP_MAX_CONCURRENT_RUNS` (default `4`) bounds how many background runs may be alive at once.
  A `background: true` call arriving at the cap fails with the new `too-many-runs` error kind, which
  names the live count and points at `status` and `stop`. `off`, `none`, and `unlimited` disable it.
  The cap is a spend and resource guard rather than a mutex: the count is a multi-step read, so two
  calls in the same tick can both pass it, and an unreadable store proceeds rather than failing
  closed.
- Prompt directories left behind by a killed run are swept. A prompt over 64 KiB is written to a
  `mkdtemp` directory whose cleanup lives in a `finally`, which SIGKILL does not run. The server now
  removes `grok-mcp-prompt-*` directories older than `max(24h, 2 × GROK_MCP_TIMEOUT_MS)` at startup
  and after each background worker, never touching a name outside that prefix or a directory outside
  the OS temp directory.

### Changed

- `cwd` must be an absolute path to an existing directory on `grok`, `review`, and `websearch`. A
  relative path used to resolve against the server's own working directory — whatever the MCP client
  launched it from, which the caller neither controls nor can predict — and a nonexistent path or a
  file reached `spawn` unchecked. All three are now `invalid-arguments` before anything is spawned.
- `review`'s `base` and `commit` reject a ref starting with `-`. Nothing escaped before, because
  `git merge-base` and `git rev-parse --verify` refuse option-shaped arguments, but the property is
  now stated by this server rather than borrowed from git's parser.
- Releases publish over [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC)
  instead of a stored `NPM_TOKEN`. Nothing holds a publish credential any more, and npm generates
  the provenance attestation without being asked. 0.1.0 was published with a token because a trusted
  publisher can only be attached to a package that already exists.
- Tool input schemas are strict. An unrecognised key is `invalid-arguments` rather than silently
  stripped, so a typo like `permision` for `permission` fails instead of quietly running at the
  default permission level and reporting success.
- Fields that become individual argv elements are length-capped (`src/limits.ts`). Prompt-shaped
  text is not capped: it is delivered through `--prompt-file` above a threshold.

### Fixed

- Caller-fault rejections no longer print a stack trace to stderr. An invalid argument, an unknown
  tool, a permission request above the ceiling, and a refused background start are all routine and
  correctable by changing the call; their stacks named absolute paths and told an operator nothing.
  Every other error keeps its stack, which is the case where one helps.
- A spawn that fails with `E2BIG` now names the flag whose value was longest and what the platform
  actually limits — Linux caps a single argument at 128 KiB (`MAX_ARG_STRLEN`), macOS counts every
  argument and the environment against one `ARG_MAX` — instead of telling the caller to install a
  CLI that is already installed.
- `help` no longer tells a timed-out caller to set `GROK_MCP_TIMEOUT_MS`. The help timeout is a
  `Math.min` against 15 seconds, so raising that variable cannot move the deadline.
- V8 coverage is kept out of the processes the test suite deliberately kills. A killed child left a
  truncated coverage fragment, which failed the whole run on the coverage step with every test
  passing.

## [0.1.0] — 2026-08-18

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
