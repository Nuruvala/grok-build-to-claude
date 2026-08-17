# Security policy

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/Nuruvala/grok-build-to-claude/security/advisories/new).
Anything that is not exploitable can be a public issue instead.

This is a single-maintainer project; there is no response-time commitment. Only the latest published
version is supported.

## What this server is responsible for

[docs/security.md](docs/security.md) is the full account: the permission ceiling and why it is
granted at registration rather than per call, what each level actually authorises, where the CLI's
sandbox stops, why the read-only tools also carry `--deny` rules, what leaves your machine, and what
lands on disk.

Two boundaries worth knowing before you file:

- **`GROK_MCP_PERMISSION_CEILING=full` is a grant, not a bug.** It maps to `--sandbox off` with
  `bypassPermissions`, so the spawned `grok` runs shell commands and writes anywhere you can,
  unattended. Behaviour within that grant is the configuration working.
- **The `grok` CLI's own sandbox, auth, and tool behaviour belong to xAI.** This server selects
  flags; the CLI enforces them. A sandbox escape in `grok` is theirs to fix — though tell us too, so
  the docs stop implying a guarantee that does not hold.
