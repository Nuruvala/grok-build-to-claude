# Changelog

All notable changes to `grok-build-mcp-server` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by pushing a `vX.Y.Z` tag matching `package.json`; see
[.github/workflows/release.yml](.github/workflows/release.yml). At tag time the `Unreleased` section
becomes the version heading and a fresh empty `Unreleased` takes its place.

## Unreleased

## [0.2.3] — 2026-08-18

Found by dogfooding. A `write` to a path outside `cwd` under `permission: "write"` is refused by the
sandbox, and the grok CLI answers a refused tool call by ending the entire run:
`stopReason: "cancelled"`, exit code 0, and a result holding only whatever narration preceded the
refusal. The server reported that as a completed run with `isError: false`. A thirteen-minute review
run was lost this way, and nothing in the result said which tool had failed or where it had pointed.

### Fixed

- A cut-off run now names the tool calls that failed and where they pointed, so a sandbox refusal is
  distinguishable from a model that stopped on its own. The note appears only when the run was also
  cut off: a failed tool call by itself is ordinary, and runs recover from one and finish. The
  information was already in the progress log and in the run record; it was the result, the one
  thing a caller always reads, that did not have it.
- The `permission` and `cwd` tool-parameter descriptions state the sandbox each level implies and
  what a refusal costs. The README's permission table already said `write` means "edits inside the
  working directory"; nothing said that writing elsewhere ends the run, and the schema a model reads
  at call time said neither.

### Added

- `-s user` in the README's `claude mcp add` lines, with the reason. Without it the server is
  registered for one directory, and the symptom is a server that is missing the next time Claude
  Code starts somewhere else.

## [0.2.2] — 2026-08-18

Fixes the registry name 0.2.1 shipped. The namespace `mcp-publisher login github-oidc` grants
preserves the GitHub login's case — `io.github.Nuruvala`, not `io.github.nuruvala` — and the
registry compares it exactly, answering the mismatch with a 403 at publish time. Because the
`mcpName` that proves ownership travels in the npm tarball, 0.2.1 cannot be corrected in place; the
name has to be right in a release before a registry entry can claim it.

### Fixed

- The registry name is `io.github.Nuruvala/grok-build-mcp-server`. The release workflow now checks
  the namespace against `github.repository_owner` before anything is published, so the case is
  caught by a guard rather than by a 403 after npm has already accepted the version.
- A failed registry publish no longer withholds the GitHub release. The two were chained, so 0.2.1
  published to npm and then had no release page; the tag is a fact about this repository and does
  not depend on a third-party service accepting an entry.

## [0.2.1] — 2026-08-18

No runtime change. The server behaves exactly as 0.2.0 did; the published tarball differs only by
the `mcpName` field in `package.json`, which the MCP Registry reads to verify that whoever claims
`io.github.Nuruvala/grok-build-mcp-server` also owns the npm package. Because that check reads the
tarball rather than the repository, 0.2.0 can never be registered — the field has to ship in a
release before the registry entry can name it. This is that release.

### Added

- An [MCP Registry](https://registry.modelcontextprotocol.io) entry. `server.json` declares the
  server as `io.github.Nuruvala/grok-build-mcp-server`, and the release workflow publishes it after
  npm on every `vX.Y.Z` tag. Ownership is verified by the `mcpName` field now in `package.json`,
  which the registry reads out of the published tarball — so the entry can only name a version whose
  tarball carries it.

### Changed

- The release workflow now refuses a tag unless the tag, `package.json`, and `server.json` all agree
  on the version, the npm identifier, and the registry name. `tests/server-json.test.ts` checks the
  same invariants on every run, so the drift surfaces locally rather than at publish time.

## [0.2.0] — 2026-08-18

Two changes reject calls that 0.1.0 accepted: tool input schemas are strict, and `cwd` must be an
absolute path. Both fail with `invalid-arguments` naming the offending key, and both replace a
silent misbehaviour — a typo'd key ran at the wrong permission level and reported success, a
relative `cwd` ran against whatever directory the MCP client happened to launch this server from.

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
