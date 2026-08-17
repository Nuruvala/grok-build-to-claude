<!--
docs/engineering.md is authoritative for how code is written here — pure core / imperative shell,
the functional TypeScript rules, error and effect discipline, testing and coverage policy. Read it
before a first contribution.
-->

## What this changes

<!-- One paragraph. What behaviour is different afterwards, and why. -->

## Why

<!-- The problem, not the patch. If it is a bug, what did it do wrong, and how did you find it. -->

## Verified `grok` CLI behaviour

<!--
Only if this change depends on something the CLI does. Name the version you checked against
(`grok version`) and how you checked. CLAUDE.md records what has been measured so far; if this
contradicts something in there, say so — the CLI moves and those notes go stale.

Delete this section if it does not apply.
-->

## Checklist

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm run build && npm test` all
      pass
- [ ] `npm run test:coverage` holds the floors (90 lines / 85 branches / 80 functions)
- [ ] Tests cover the new behaviour, and fail without the change
- [ ] No new runtime dependency (the MCP SDK and zod are the only two)
- [ ] Nothing writes to stdout outside the MCP transport
- [ ] Conventional Commit subject (`feat:`, `fix:`, `docs:`, `chore:`)
