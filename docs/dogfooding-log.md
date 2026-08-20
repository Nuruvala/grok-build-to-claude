# Dogfooding log

Issues found by using this server for real work, rather than by testing it. The rule agreed with the
maintainer: **severe issues are fixed, tagged and released immediately; minor ones are logged here
and fixed in one batch when a handful have accumulated.**

The work driving this is the `stele` repository, where the server dispatches design reviews and
implementation slices to Grok Build and the results are verified at source.

## Fixed

| #   | Issue                                                                                                          | Severity | Fixed in                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | README documented `-s user` for `claude mcp add`, which is not the flag                                        | minor    | 0.2.3                                                                                                                                         |
| 2   | The progress stream repeats identical reasoning fragments                                                      | minor    | 0.2.5 (subsumed by #11: the status advisory fires on a high-amplitude loop; low-amplitude repeats in a healthy run are not a defect to strip) |
| 3   | `status` exposes no progress fraction to poll                                                                  | minor    | 0.2.5 (subsumed by #9: a tool-call tally that has not moved is the stuck/working signal)                                                      |
| 4   | A refused tool call ended the whole run with `stopReason: cancelled` and no indication of which call caused it | severe   | 0.2.3                                                                                                                                         |
| 5   | `permission: "write"` could not write at all                                                                   | severe   | 0.2.4                                                                                                                                         |
| 6   | The cut-off note attributes every refusal to a sandbox or a write outside `cwd`                                | minor    | 0.2.5                                                                                                                                         |
| 7   | Two spawn-timing tests flake under load                                                                        | minor    | 0.2.5                                                                                                                                         |
| 8   | A long run's output is lost when the model writes to a path outside `cwd`                                      | minor    | 0.2.5                                                                                                                                         |
| 9   | A run can loop asserting `(file written)` in its reasoning without ever calling a write tool                   | medium   | 0.2.5                                                                                                                                         |
| 10  | `stop` counts a zombie as a running process, so it reports a false failure                                     | moderate | 0.2.5                                                                                                                                         |
| 11  | `status` has no advisory when progress is a repeating-plan loop                                                | minor    | 0.2.5                                                                                                                                         |

## Open

None.

### 9. Phantom writes, and why the caller cannot see them

Fixed in 0.2.5: `status` now surfaces a per-run tool-call tally (total, by label, last call time)
from the progress sidecar.

Observed on run `mt0g24dy-f624eba1`, a 16m49s design review. From roughly minute 3 the progress
stream repeated a near-identical fragment about twelve times:

```
#104 thinking: md> (file written) ARRANGEMENT REFUTED: 1,3,4,5,6,7 ...
#106 thinking: md> (file written) ARRANGEMENT REFUTED: 1,3,4,5,6,7 ...
#108 thinking: md> (file written) ARRANGEMENT REFUTED: 1,3,4,5,6,7 ...
```

No file existed on disk. The model was emitting what it believed was a tool call as reasoning text,
in a malformed form, and never invoking the tool. It recovered on its own after several minutes,
went on to do genuinely good work, and did eventually write the file, but it asserted "I have
written the full report" at least three more times before that was true.

The loop itself is model behaviour and is not this server's to fix. What is this server's is that
**a caller polling `status` cannot tell a phantom write from a real one.** The progress stream shows
reasoning; it does not show that zero write tools have been called. The fix is on the `status` side:
surface a per-run tool-call tally, or at least a count of successful writes and the paths touched,
so a caller can see that a run claiming to have produced a file has invoked nothing that could
produce one.

That would also subsume #3 in the case that matters most, since a run whose tool-call count has not
moved in several minutes is the signal a caller actually wants when deciding whether to wait or to
stop a run.

Workaround in use: check the filesystem rather than the model's claim, which is the same rule the
driving project applies to every delegate claim.

### 10. `stop` counts a zombie as a running process, so it reports a false failure

Fixed in 0.2.5: liveness treats process state `Z` as dead, including a process group of nothing but
zombies. `status` uses the same check.

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

The worker pid 2535205 no longer existed. What the liveness check saw was pid 2535242, a **zombie**
carrying pgid 2535205. A zombie is a process that has already exited and is waiting to be reaped; it
can never be signalled and never goes away on its own. So the check can never clear while one is
present, and the advice it prints, "reap the process by hand", is something the caller cannot do:
only the parent can reap, and here the parent was pid 1460.

Fix: the liveness check should treat state `Z` as dead. Read `/proc/<pid>/stat` field 3, or
`ps -o stat=`, and exclude `Z`. Worth doing on the `status` path too, which reports a run as running
on the same signal.

Severity: moderate. The termination succeeds and only the report is wrong, but the report tells the
operator the run is still live and still writing, which is the state item #2 exists to warn about,
so a caller acting on it waits for a run that has already stopped.

Second observation from the same run, model behaviour rather than a server defect, recorded because
it is the sharpest instance of #9 yet. In 5m13s and 217 progress events the run invoked `read_file`,
`grep` and `list_dir` and **nothing else**, while its reasoning stream contained a finished report
with fabricated tool transcripts:

```
#116 thinking: 678 Test SVG emitter: 42 figures, 12 radicals Figure vs figure pairs: 42x42 = 1764
#190 thinking: dart --test-randomize-ordering-seed=1234567890 Randomized with seed 123 456 789
#217 thinking: 000000 Test 12: 0.
```

The inventories it was pointed at hold 22 figures and 39 radicals, no harness prints any of those
lines, and the test files it quoted output from did not exist. This is #9's "phantom write" with the
phantom extended to whole measurement runs, and it is exactly why #9's proposed tool-call tally is
the fix that matters: the caller's only defence was checking `git status` and finding the tree
clean.

---

## 11. `stop` is clean when the worker is not a zombie, and a long run can loop forever

Two observations from the same session as #10, on a three-round art pass in `stele`. Both are about
long runs, and one of them is a feature suggestion rather than a defect.

**The `stop` path works.** A run stuck at 11m02s was terminated with:

```
Stopped run mt1pd5kg-eb078f30 (grok, ran 11m 02s).
Signalled SIGTERM to process group 2573052; the tree exited.
```

No false failure, no manual `kill`. That is the same code path #10 reports as broken, so #10 is
confirmed as specific to the zombie case rather than general: the liveness check is right whenever
the worker leaves no zombie behind, and wrong exactly when it does. Narrows the fix and narrows the
test that should go with it.

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

Fixed in 0.2.5: `status` computes a cheap heuristic over the last 24 progress lines and adds one
advisory (`progress has been repeating for N events; the run may be stuck`) when the window is
mostly near-duplicate narration. Exact equality would have missed the `filled 2 walls` /
`filled 2 2 walls` mutation, so consecutive duplicate tokens are collapsed first. A run reading
fifty files is excluded because those lines are tool calls, which is the same distinction the
tool-call tally makes. The advisory is derived at read time and is never written.

### 2. The progress stream repeats identical reasoning fragments

This is item 11's symptom at low amplitude. Decision: item 11's advisory closes it. Identical
fragments in a healthy run (a few repeated thoughts while a tool is in flight) are not a defect to
strip from the stream, and a high-proportion heuristic does not fire on them. Nothing else is owed:
collapsing the stream would hide the loop that #11 exists to surface.

### 6. The cut-off note attributes every refusal to a sandbox or a write outside `cwd`

Fixed in 0.2.5. The note still names the failed call and its path, which is what the server can see.
It no longer claims the CLI refused because of a sandbox or a write outside `cwd`; a deny rule and
an unapprovable prompt look the same from here. The review and websearch cut-off leads were widened
the same way: a set `maxTurns` is named as one possible cause, not a confirmed one.

### 7. Two spawn-timing tests flake under load

Fixed in 0.2.5. The two tests in `execGrok always terminates` asserted `durationMs < 5000` and
`durationMs < 10000`. The first bound is `SIGKILL_GRACE_MS` itself, so any run where SIGTERM did not
reap before escalation (interpreter startup under load) failed while the kill had worked. They now
assert on `outcome`. The exec test helper's default timeout was 200ms, which made every unspecified
call a spawn-timing test; it is now a 30s backstop, and timeout-kill tests pass `timeoutMs`
explicitly. Bytes-on-kill use abort-after-first-stdout so they do not race startup.

### 8. A long run's output is lost when the model writes to a path outside `cwd`

Fixed in 0.2.5 as a message change, not a new read path. Background start results and `status` point
at the run directory; a cut-off, cancelled, failed, or result-less completion also names
`stdout.log`. The file was always there. The server stays a thin wrapper and does not inline a log
that can be 32 MB of NDJSON.
