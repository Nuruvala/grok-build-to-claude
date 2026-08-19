# Dogfooding log

Issues found by using this server for real work, rather than by testing it. The rule agreed with
the maintainer: **severe issues are fixed, tagged and released immediately; minor ones are logged
here and fixed in one batch when a handful have accumulated.**

The work driving this is the `stele` repository, where the server dispatches design reviews and
implementation slices to Grok Build and the results are verified at source.

## Fixed

| # | Issue | Severity | Fixed in |
|---|---|---|---|
| 1 | README documented `-s user` for `claude mcp add`, which is not the flag | minor | 0.2.3 |
| 4 | A refused tool call ended the whole run with `stopReason: cancelled` and no indication of which call caused it | severe | 0.2.3 |
| 5 | `permission: "write"` could not write at all | severe | 0.2.4 |

## Open

| # | Issue | Severity | Notes |
|---|---|---|---|
| 2 | The progress stream repeats identical reasoning fragments | minor | See #9, which is the same symptom at a much worse amplitude |
| 3 | `status` exposes no progress fraction to poll | minor | A caller cannot distinguish "thinking hard" from "stuck" |
| 6 | The cut-off note attributes every refusal to a sandbox or a write outside `cwd` | minor | Accurate for the case that produced it; too narrow in general |
| 7 | Two spawn-timing tests flake under load | minor | |
| 8 | A long run's output is lost when the model writes to a path outside `cwd` | minor | Recovery from `~/.local/state/grok-mcp/runs/<runId>/stdout.log` works and is manual |
| 9 | A run can loop asserting `(file written)` in its reasoning without ever calling a write tool | **medium** | Detail below |

### 9. Phantom writes, and why the caller cannot see them

Observed on run `mt0g24dy-f624eba1`, a 16m49s design review. From roughly minute 3 the progress
stream repeated a near-identical fragment about twelve times:

```
#104 thinking: md> (file written) ARRANGEMENT REFUTED: 1,3,4,5,6,7 ...
#106 thinking: md> (file written) ARRANGEMENT REFUTED: 1,3,4,5,6,7 ...
#108 thinking: md> (file written) ARRANGEMENT REFUTED: 1,3,4,5,6,7 ...
```

No file existed on disk. The model was emitting what it believed was a tool call as reasoning
text, in a malformed form, and never invoking the tool. It recovered on its own after several
minutes, went on to do genuinely good work, and did eventually write the file, but it asserted
"I have written the full report" at least three more times before that was true.

The loop itself is model behaviour and is not this server's to fix. What is this server's is that
**a caller polling `status` cannot tell a phantom write from a real one.** The progress stream
shows reasoning; it does not show that zero write tools have been called. The fix is on the
`status` side: surface a per-run tool-call tally, or at least a count of successful writes and the
paths touched, so a caller can see that a run claiming to have produced a file has invoked nothing
that could produce one.

That would also subsume #3 in the case that matters most, since a run whose tool-call count has
not moved in several minutes is the signal a caller actually wants when deciding whether to wait
or to stop a run.

Workaround in use: check the filesystem rather than the model's claim, which is the same rule the
driving project applies to every delegate claim.
