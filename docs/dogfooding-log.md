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

### 10. `stop` counts a zombie as a running process, so it reports a false failure

Observed on run `mt0r75xk-de9b06c1`. The run was making no progress and was stopped:

```
Could not stop run mt0r75xk-de9b06c1 (grok, ran 5m 13s).
Signalled SIGTERM then SIGKILL to process group 2535205; process 2535205 is still running.
The record is still running. Retry stop once the pid is findable, or reap the process by hand.
```

The signals had in fact worked. `ps` at that moment:

```
    PID    PPID    PGID STAT     ELAPSED COMMAND
2535242    1460 2535205 ZNl        05:26 grok-1.0.4-linu <defunct>
2535322 2535242 2535322 SNsl       05:26 node-MainThread
```

The worker pid 2535205 no longer existed. What the liveness check saw was pid 2535242, a
**zombie** carrying pgid 2535205. A zombie is a process that has already exited and is waiting to
be reaped; it can never be signalled and never goes away on its own. So the check can never clear
while one is present, and the advice it prints, "reap the process by hand", is something the
caller cannot do: only the parent can reap, and here the parent was pid 1460.

Fix: the liveness check should treat state `Z` as dead. Read `/proc/<pid>/stat` field 3, or
`ps -o stat=`, and exclude `Z`. Worth doing on the `status` path too, which reports a run as
running on the same signal.

Severity: moderate. The termination succeeds and only the report is wrong, but the report tells
the operator the run is still live and still writing, which is the state item #2 exists to warn
about, so a caller acting on it waits for a run that has already stopped.

Second observation from the same run, model behaviour rather than a server defect, recorded
because it is the sharpest instance of #9 yet. In 5m13s and 217 progress events the run invoked
`read_file`, `grep` and `list_dir` and **nothing else**, while its reasoning stream contained a
finished report with fabricated tool transcripts:

```
#116 thinking: 678 Test SVG emitter: 42 figures, 12 radicals Figure vs figure pairs: 42x42 = 1764
#190 thinking: dart --test-randomize-ordering-seed=1234567890 Randomized with seed 123 456 789
#217 thinking: 000000 Test 12: 0.
```

The inventories it was pointed at hold 22 figures and 39 radicals, no harness prints any of those
lines, and the test files it quoted output from did not exist. This is #9's "phantom write" with
the phantom extended to whole measurement runs, and it is exactly why #9's proposed tool-call
tally is the fix that matters: the caller's only defence was checking `git status` and finding the
tree clean.

---

## 11. `stop` is clean when the worker is not a zombie, and a long run can loop forever

Two observations from the same session as #10, on a three-round art pass in `stele`. Both are
about long runs, and one of them is a feature suggestion rather than a defect.

**The `stop` path works.** A run stuck at 11m02s was terminated with:

```
Stopped run mt1pd5kg-eb078f30 (grok, ran 11m 02s).
Signalled SIGTERM to process group 2573052; the tree exited.
```

No false failure, no manual `kill`. That is the same code path #10 reports as broken, so #10 is
confirmed as specific to the zombie case rather than general: the liveness check is right whenever
the worker leaves no zombie behind, and wrong exactly when it does. Narrows the fix and narrows
the test that should go with it.

**A long run can enter a degenerate repeating-plan loop, and the progress tail is what shows it.**
The stopped run spent eleven minutes never writing a file. Its progress stream repeated one plan
with accumulating garbage tokens:

```
#271 thinking: **house**: house with chimney (filled walls 2, roof, chimney, door).
#331 thinking: **store 2**: store 2 with sign (filled 2 walls, roof, sign 2, window paper).
#390 thinking: **store 2**: store 2 with sign (filled 2 2 walls, roof, sign 2, window paper).
#392 thinking: **cook**: pot with steam and food (filled pot, lid, steam, 2 2 food).
```

Model behaviour, not a server defect, and the server came out of it well: polling `status` with a
`tail` made the loop legible at about eight minutes, against a run that would otherwise have been
waited out. The same task split into two smaller runs completed.

Feature worth considering: `status` already has every progress line. A cheap heuristic over the
last N events, such as a high proportion of near-duplicate lines, could add one advisory line to
the status output ("progress has been repeating for N events; the run may be stuck"). It costs
nothing when the run is healthy and it turns an eleven-minute wait into a one-poll decision. This
is the same family as #9's tool-call tally: cheap signals computed from data the server already
holds, which let the caller distinguish a working run from a run that is only talking.

Severity: minor for the feature, and #10's severity is unchanged. Batch both.
