/**
 * Keeps V8 coverage out of the processes this suite deliberately kills.
 *
 * Several tests SIGKILL a detached worker or a fake `grok` child. Those are
 * Node processes, they inherit `NODE_V8_COVERAGE` from the test runner, and a
 * process killed before it exits writes a truncated fragment. The coverage
 * merge then fails the whole run with `Could not report code coverage.
 * SyntaxError: Unexpected end of JSON input` — while every test passed.
 * Observed on macOS / Node 22, at a frequency that scales with how many
 * children a run spawns.
 *
 * V8 reads `NODE_V8_COVERAGE` once at startup, so deleting it here keeps this
 * process's own coverage intact and only stops children from inheriting it.
 * Both halves are verified: a module exercised after this delete still reports
 * 100% lines, and a child spawned after it sees the variable as undefined.
 *
 * Loaded via `--import` in the npm test scripts, which the test runner passes
 * down to the child it spawns per test file.
 */

delete process.env['NODE_V8_COVERAGE'];
