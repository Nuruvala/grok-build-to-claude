import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MAX_BUFFER_BYTES, execGrok } from '../../src/grok/exec.js';
import type { ExecOptions, ExecResult } from '../../src/grok/exec.js';

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));

const tmpDirs: string[] = [];

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-exec-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Isolated child env. PATH is the one inherited value — `/usr/bin/env node` on
 * the fixture shebang needs it. Everything else (XAI_API_KEY, GROK_*, the
 * operator's permission ceiling) stays out.
 */
function isolatedEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: '/tmp/grok-mcp-test-home',
    ...overrides,
  };
}

function execFake(
  script: Record<string, string> = {},
  options: Omit<Partial<ExecOptions>, 'binary' | 'env'> = {},
): Promise<ExecResult> {
  return execGrok({
    binary: FAKE_GROK,
    args: options.args ?? [],
    cwd: options.cwd,
    // Backstop, not a measurement. 200ms used to be the default and raced
    // node starting the fake, so any test that did not pass timeoutMs became
    // a spawn-timing test and failed under load. Tests that mean to kill on
    // the timer pass timeoutMs explicitly.
    timeoutMs: options.timeoutMs ?? 30_000,
    signal: options.signal,
    maxBufferBytes: options.maxBufferBytes,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    onSpawn: options.onSpawn,
    detached: options.detached,
    env: isolatedEnv(script),
  });
}

/**
 * Kill the child only after it has written. A short timeoutMs races
 * interpreter startup, so this uses abort-on-first-stdout: the same
 * `requestKill` path as a timeout, without measuring the machine.
 */
function execFakeKilledAfterWrite(
  script: Record<string, string>,
  options: Omit<Partial<ExecOptions>, 'binary' | 'env'> = {},
): Promise<ExecResult> {
  const controller = new AbortController();
  return execFake(script, {
    ...options,
    timeoutMs: options.timeoutMs ?? 30_000,
    signal: controller.signal,
    onStdout: (chunk) => {
      options.onStdout?.(chunk);
      controller.abort();
    },
  });
}

function isEsrch(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function assertDead(pid: number): void {
  assert.throws(
    () => {
      process.kill(pid, 0);
    },
    (error: unknown) => isEsrch(error),
  );
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    try {
      process.kill(pid, 0);
      await delay(20);
    } catch (error: unknown) {
      if (isEsrch(error)) return;
      throw error;
    }
  }
  assert.fail(`pid ${pid} still alive after ${timeoutMs}ms`);
}

describe('execGrok argv fidelity', () => {
  it('delivers argv to the child byte-for-byte, including quotes, a newline, $HOME, and a backtick', async () => {
    const argvFile = path.join(await makeTmp(), 'argv.json');
    const prompt = '"double" \'single\'\n$HOME `whoami` -dashed';
    const result = await execFake(
      { FAKE_GROK_ARGV_FILE: argvFile, FAKE_GROK_STDOUT: 'ok' },
      { args: ['-p', prompt, '--output-format', 'json'] },
    );

    assert.equal(result.outcome, 'exited');
    assert.equal(result.code, 0);
    const recorded: unknown = JSON.parse(await readFile(argvFile, 'utf8'));
    assert.deepEqual(recorded, ['-p', prompt, '--output-format', 'json']);
  });
});

describe('execGrok never rejects', () => {
  it('resolves spawn-failed with a non-null spawnError when the binary does not exist, rather than rejecting', async () => {
    const result = await execGrok({
      binary: '/no/such/grok-binary-7c3e91a2',
      args: ['-p', 'hello'],
      env: isolatedEnv(),
      timeoutMs: 200,
    });
    assert.equal(result.outcome, 'spawn-failed');
    assert.ok(result.spawnError instanceof Error);
    assert.equal(result.code, null);
    assert.equal(result.stdout, '');
  });

  it('returns partial stdout alongside a non-zero exit, rather than discarding the buffer', async () => {
    const result = await execFake({
      FAKE_GROK_STDOUT: 'partial-out',
      FAKE_GROK_STDERR: 'partial-err',
      FAKE_GROK_EXIT_CODE: '1',
    });
    assert.equal(result.outcome, 'exited');
    assert.equal(result.code, 1);
    assert.equal(result.stdout, 'partial-out');
    assert.equal(result.stderr, 'partial-err');
    assert.equal(result.spawnError, null);
  });
});

describe('execGrok buffer cap', () => {
  it('truncates a stream that exceeds a small cap, sets stdoutTruncated, and appends the marker once', async () => {
    const cap = 32;
    const result = await execFake(
      { FAKE_GROK_STDOUT_BYTES: '1000' },
      { maxBufferBytes: cap, timeoutMs: 2000 },
    );
    const marker = `\n[output truncated at ${cap} bytes by grok-build-mcp-server]\n`;
    assert.equal(result.outcome, 'exited');
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stdout, `${'a'.repeat(cap)}${marker}`);
    assert.ok(Buffer.byteLength(result.stdout) < 1000);
  });

  it('caps a 50 MB stream at the 10 MB default with a truncation marker, so memory stays bounded', async () => {
    const result = await execFake(
      { FAKE_GROK_STDOUT_BYTES: String(50 * 1024 * 1024) },
      { timeoutMs: 30_000 },
    );
    const marker = `\n[output truncated at ${DEFAULT_MAX_BUFFER_BYTES} bytes by grok-build-mcp-server]\n`;
    assert.equal(result.outcome, 'exited');
    assert.equal(result.code, 0);
    assert.equal(result.stdoutTruncated, true);
    assert.ok(result.stdout.endsWith(marker));
    assert.equal(
      Buffer.byteLength(result.stdout),
      DEFAULT_MAX_BUFFER_BYTES + Buffer.byteLength(marker),
    );
  });

  it('truncates stderr independently of stdout, because each stream has its own cap', async () => {
    const cap = 16;
    const result = await execFake({ FAKE_GROK_STDERR: 'b'.repeat(200) }, { maxBufferBytes: cap });
    const marker = `\n[output truncated at ${cap} bytes by grok-build-mcp-server]\n`;
    assert.equal(result.stderrTruncated, true);
    assert.equal(result.stderr, `${'b'.repeat(cap)}${marker}`);
    assert.equal(result.stdoutTruncated, false);
  });
});

describe('execGrok timeout and kill', () => {
  it('kills a fake that never exits at timeoutMs and still returns the bytes it had written', async () => {
    const result = await execFakeKilledAfterWrite({
      FAKE_GROK_STDOUT: 'so far',
      FAKE_GROK_SLEEP_MS: '60000',
    });
    assert.ok(result.outcome === 'aborted' || result.outcome === 'timeout');
    assert.equal(result.stdout, 'so far');
    assert.equal(result.spawnError, null);
  });

  it(
    'kills a fake that ignores SIGTERM via SIGKILL escalation, rather than hanging until the wall clock',
    { skip: process.platform === 'win32', timeout: 20_000 },
    async () => {
      const result = await execFake(
        {
          FAKE_GROK_IGNORE_SIGTERM: '1',
          FAKE_GROK_STDOUT: 'still here',
          FAKE_GROK_SLEEP_MS: '60000',
        },
        { timeoutMs: 200 },
      );
      assert.equal(result.outcome, 'timeout');
      // Do not assert stdout. 200ms races node starting the fake, so under load
      // the kill landed before the write and the test failed while the
      // escalation itself had worked. Bytes-on-kill are covered by the
      // handshake test above.
    },
  );

  it(
    'leaves no surviving grandchild after a timeout kill, because the kill targets the process group',
    { skip: process.platform === 'win32', timeout: 10_000 },
    async () => {
      // Abort after the pid is written, not a 200ms timer: under load the timer
      // fired before the fake spawned the grandchild, so the test failed while
      // group-kill itself was fine. Abort and timeout share requestKill.
      const controller = new AbortController();
      const result = await execFake(
        {
          FAKE_GROK_SPAWN_CHILD: '1',
          FAKE_GROK_SLEEP_MS: '60000',
        },
        {
          timeoutMs: 30_000,
          signal: controller.signal,
          onStderr: (chunk) => {
            if (chunk.includes('grandchildPid')) controller.abort();
          },
        },
      );
      assert.ok(result.outcome === 'timeout' || result.outcome === 'aborted');
      const match = /\{"grandchildPid":(\d+)\}/.exec(result.stderr);
      assert.ok(match, `expected grandchild pid on stderr, got ${JSON.stringify(result.stderr)}`);
      const grandchildPid = Number(match[1]);
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
      await waitUntilDead(grandchildPid, 2000);
      assertDead(grandchildPid);
    },
  );
});

describe('execGrok abort', () => {
  it('never spawns when the signal is already aborted, so argv is never recorded', async () => {
    const argvFile = path.join(await makeTmp(), 'argv.json');
    const controller = new AbortController();
    controller.abort();

    const result = await execFake(
      { FAKE_GROK_ARGV_FILE: argvFile, FAKE_GROK_STDOUT: 'should-not-run' },
      { signal: controller.signal, args: ['-p', 'nope'] },
    );

    assert.equal(result.outcome, 'aborted');
    assert.equal(result.stdout, '');
    assert.equal(result.spawnError, null);
    await assert.rejects(() => access(argvFile), { code: 'ENOENT' });
  });

  it('resolves aborted when the signal fires mid-run, after the child has started writing', async () => {
    const controller = new AbortController();
    const result = await execFake(
      { FAKE_GROK_STDOUT: 'started', FAKE_GROK_SLEEP_MS: '10000' },
      {
        timeoutMs: 5000,
        signal: controller.signal,
        onStdout: () => {
          controller.abort();
        },
      },
    );
    assert.equal(result.outcome, 'aborted');
    assert.equal(result.stdout, 'started');
  });
});

describe('execGrok always terminates', () => {
  it(
    'kills the child when the signal aborts before the spawn event, rather than waiting out the run',
    { skip: process.platform === 'win32', timeout: 20_000 },
    async () => {
      // `child.pid` is set the moment the fork succeeds, but the `spawn` event is a tick later.
      // Aborting inside that gap used to find no pid to signal, so nothing was killed and the
      // call sat until the child finished on its own — ten seconds here.
      const controller = new AbortController();
      const promise = execFake(
        { FAKE_GROK_SLEEP_MS: '10000' },
        { timeoutMs: 30_000, signal: controller.signal },
      );
      controller.abort();

      const result = await promise;
      assert.equal(result.outcome, 'aborted');
      // Do not assert durationMs. SIGKILL_GRACE_MS is 5000, so a bound of
      // `< 5000` fails whenever SIGTERM does not reap before escalation, which
      // is a scheduling race under load, not a missed kill. Outcome `aborted`
      // already means we did not wait out the 10s sleep (that path is `exited`).
    },
  );

  it(
    'reports when a leaked grandchild holds the stdio pipes open, because close would never fire',
    { skip: process.platform === 'win32', timeout: 20_000 },
    async () => {
      // The fixture exits immediately, but a detached grandchild inherited its stdout and stderr,
      // so the pipes never reach EOF and `close` never arrives. Only the `exit` drain backstop
      // gets us out of this.
      const result = await execFake({ FAKE_GROK_LEAK_STDIO: '1' }, { timeoutMs: 30_000 });

      assert.equal(result.outcome, 'exited');
      // Do not assert durationMs. The drain backstop is 2s after `exit`; a
      // wall-clock bound measures the machine. If the backstop never fires,
      // this test's 20s timeout fails before timeoutMs (30s) can, so outcome
      // `exited` is the property.

      const match = /\{"leakedPid":(\d+)\}/.exec(result.stderr);
      assert.ok(match, `expected the leaked pid on stderr, got ${JSON.stringify(result.stderr)}`);
      const leakedPid = Number(match[1]);
      try {
        process.kill(leakedPid, 'SIGKILL');
      } catch (error: unknown) {
        if (!isEsrch(error)) throw error;
      }
    },
  );
});

describe('execGrok settles once', () => {
  it('resolves exactly once when timeout and natural exit race, rather than hanging or rejecting', async () => {
    let resolutions = 0;
    // 400 ms, not 30: the child writes its stdout before sleeping, but at 30 ms the wall clock is
    // racing node's own interpreter startup, so the kill could land before the write and the
    // buffered output would be empty. The timeout-versus-exit race under test is unaffected by
    // moving both sides past startup; racing startup itself just made the test flaky.
    const promise = execFake(
      { FAKE_GROK_STDOUT: 'hi', FAKE_GROK_SLEEP_MS: '400' },
      { timeoutMs: 400 },
    );
    void promise.then(() => {
      resolutions += 1;
    });
    const result = await promise;
    await delay(50);
    assert.equal(resolutions, 1);
    assert.ok(result.outcome === 'timeout' || result.outcome === 'exited');
    assert.equal(result.stdout, 'hi');
  });
});

describe('execGrok UTF-8 decoding across chunk boundaries', () => {
  it('reassembles a multi-byte character split across two writes in onStdout, rather than handing the caller replacement characters', async () => {
    // Must match the literal in tests/fixtures/fake-grok.mjs under FAKE_GROK_SPLIT_UTF8.
    const original = 'ok café — 日本語 ✓';
    const chunks: string[] = [];
    const result = await execFake(
      { FAKE_GROK_SPLIT_UTF8: '1' },
      {
        timeoutMs: 2000,
        onStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    assert.equal(result.outcome, 'exited');
    const reassembled = chunks.join('');
    assert.equal(reassembled.includes('\uFFFD'), false);
    assert.equal(reassembled, original);
    // The final `stdout` field already concatenated Buffers correctly before this
    // fix. The callback path is what the JSON parser now consumes.
    assert.ok(
      chunks.length >= 2,
      `expected at least two onStdout callbacks so the split is observed, got ${String(chunks.length)}: ${JSON.stringify(chunks)}`,
    );
  });
});

describe('execGrok onSpawn and detached', () => {
  it('fires onSpawn synchronously with the child pid after spawn returns', async () => {
    const pids: number[] = [];
    const result = await execFake(
      { FAKE_GROK_STDOUT: 'ok' },
      {
        onSpawn: (pid) => {
          pids.push(pid);
        },
      },
    );
    assert.equal(result.outcome, 'exited');
    assert.equal(pids.length, 1);
    assert.ok(pids[0] !== undefined && pids[0] > 0);
  });

  it(
    'kills a non-detached child on timeout via child.kill, not process-group kill',
    { skip: process.platform === 'win32', timeout: 10_000 },
    async () => {
      const pids: number[] = [];
      const result = await execFake(
        { FAKE_GROK_SLEEP_MS: '10000' },
        {
          timeoutMs: 200,
          detached: false,
          onSpawn: (pid) => {
            pids.push(pid);
          },
        },
      );
      assert.equal(result.outcome, 'timeout');
      const pid = pids[0];
      assert.ok(pid !== undefined);
      await waitUntilDead(pid, 2000);
      assertDead(pid);
    },
  );
});

describe('execGrok stream callbacks', () => {
  it('forwards decoded stdout and stderr chunks so a streaming caller can observe the run', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await execFake(
      { FAKE_GROK_STDOUT: 'out-chunk', FAKE_GROK_STDERR: 'err-chunk' },
      {
        onStdout: (chunk) => {
          stdout.push(chunk);
        },
        onStderr: (chunk) => {
          stderr.push(chunk);
        },
      },
    );
    assert.equal(result.outcome, 'exited');
    assert.equal(stdout.join(''), 'out-chunk');
    assert.equal(stderr.join(''), 'err-chunk');
  });
});
