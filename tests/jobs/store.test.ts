import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { InvalidArgumentsError, InvalidRunIdError, JobStoreError } from '../../src/errors.js';
import { newRunId } from '../../src/jobs/record.js';
import {
  claimTerminal,
  createLogAppender,
  createRun,
  finalizeRun,
  INPUT_MAX_BYTES,
  listRunIds,
  listRuns,
  patchRun,
  readLateResult,
  readProgress,
  readRun,
  readRunInput,
  readWorkerPid,
  RECORD_MAX_BYTES,
  runDir,
  tailFile,
  writeLateResult,
  writeProgress,
  writeTerminal,
  writeWorkerPid,
} from '../../src/jobs/store.js';

const tmpDirs: string[] = [];

async function makeState(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-jobs-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fileMode(filePath: string): Promise<number> {
  const info = await stat(filePath);
  return info.mode & 0o777;
}

async function seed(
  stateDir: string,
  runId: string,
  extra: { summary?: string; tool?: string; input?: Record<string, unknown> } = {},
) {
  return createRun({
    stateDir,
    runId,
    tool: extra.tool ?? 'grok',
    summary: extra.summary ?? 'do a thing',
    cwd: '/tmp/work',
    input: extra.input ?? { prompt: 'hi' },
  });
}

describe('createRun / readRun', () => {
  it('round-trips a record and leaves input.json untouched', async () => {
    const stateDir = await makeState();
    const input = { prompt: 'hello', maxTurns: 4 };
    const created = await seed(stateDir, 'aaa00001-aaaaaaaa', { input });
    const read = await readRun(stateDir, created.runId);
    assert.ok(read);
    assert.equal(read.runId, created.runId);
    assert.equal(read.state, 'starting');
    assert.equal(read.tool, 'grok');
    assert.equal(read.cwd, '/tmp/work');
    assert.equal(read.summary, 'do a thing');
    assert.deepEqual(await readRunInput(stateDir, created.runId), input);
  });

  it('rejects an input larger than INPUT_MAX_BYTES at the call, before any directory is created', async () => {
    const stateDir = await makeState();
    const huge = { prompt: 'x'.repeat(INPUT_MAX_BYTES) };
    await assert.rejects(
      () =>
        createRun({
          stateDir,
          runId: 'aaa00009-7001a49e',
          tool: 'grok',
          summary: 'too big',
          cwd: '/tmp/work',
          input: huge,
        }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidArgumentsError);
        assert.match(error.message, /input\.json would be \d+ bytes/);
        assert.match(error.message, new RegExp(String(INPUT_MAX_BYTES)));
        return true;
      },
    );
    const listed = await listRuns(stateDir, 20);
    assert.equal(listed.records.length, 0);
    assert.equal(listed.scanned, 0);
  });
});

describe('patchRun', () => {
  it('returns null when a terminal.claim exists, even if the record is still non-terminal', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'aaa00010-c1a1d0ef');
    const claimed = await claimTerminal(stateDir, created.runId, 'stop');
    assert.equal(claimed.kind, 'claimed');
    const filePath = path.join(runDir(stateDir, created.runId), 'record.json');
    const before = await readFile(filePath);

    const patched = await patchRun(stateDir, created.runId, { state: 'running', workerPid: 1 });
    assert.equal(patched, null);
    const after = await readFile(filePath);
    assert.deepEqual(after, before);
    const read = await readRun(stateDir, created.runId);
    assert.equal(read?.state, 'starting');
  });

  it('returns null on a terminal record and leaves the file byte-identical', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'aaa00002-bbbbbbbb');
    const claimed = await claimTerminal(stateDir, created.runId, 'test');
    assert.equal(claimed.kind, 'claimed');
    const terminal = await writeTerminal(stateDir, created.runId, {
      state: 'completed',
      endedAt: '2026-08-17T12:00:00.000Z',
    });
    assert.ok(terminal);
    const filePath = path.join(runDir(stateDir, created.runId), 'record.json');
    const before = await readFile(filePath);

    const patched = await patchRun(stateDir, created.runId, { lastProgress: 'should not write' });
    assert.equal(patched, null);
    const after = await readFile(filePath);
    assert.deepEqual(after, before);
  });
});

describe('claimTerminal', () => {
  it('gives exactly one claimed outcome when two calls race, both concurrently and sequentially', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'aaa00003-cccccccc');

    const [first, second] = await Promise.all([
      claimTerminal(stateDir, created.runId, 'a'),
      claimTerminal(stateDir, created.runId, 'b'),
    ]);
    const kinds = [first.kind, second.kind].sort();
    assert.deepEqual(kinds, ['claimed', 'lost']);

    const sequential = await seed(stateDir, 'aaa00004-dddddddd');
    const once = await claimTerminal(stateDir, sequential.runId, 'first');
    const twice = await claimTerminal(stateDir, sequential.runId, 'second');
    assert.equal(once.kind, 'claimed');
    assert.equal(twice.kind, 'lost');
  });

  it('makes writeTerminal visible to a subsequent readRun', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'aaa00005-eeeeeeee');
    const claim = await claimTerminal(stateDir, created.runId, 'worker');
    assert.equal(claim.kind, 'claimed');
    await writeTerminal(stateDir, created.runId, {
      state: 'failed',
      error: 'boom',
      endedAt: '2026-08-17T12:00:00.000Z',
    });
    const read = await readRun(stateDir, created.runId);
    assert.ok(read);
    assert.equal(read.state, 'failed');
    assert.equal(read.error, 'boom');
  });
});

describe('finalizeRun', () => {
  it('writes a terminal record on a successful claim', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'aaa00006-f1ba10c0');
    const outcome = await finalizeRun(stateDir, created.runId, 'worker', {
      state: 'completed',
      endedAt: '2026-08-17T12:00:00.000Z',
    });
    if (outcome.kind === 'lost') {
      assert.fail('expected finalized');
      return;
    }
    assert.equal(outcome.record.state, 'completed');
    const read = await readRun(stateDir, created.runId);
    assert.equal(read?.state, 'completed');
  });

  it('returns lost when the claim is already taken', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'aaa00007-f1ba1057');
    const first = await finalizeRun(stateDir, created.runId, 'worker', {
      state: 'completed',
      endedAt: '2026-08-17T12:00:00.000Z',
    });
    assert.equal(first.kind, 'finalized');
    const second = await finalizeRun(stateDir, created.runId, 'status', {
      state: 'abandoned',
      endedAt: '2026-08-17T12:00:01.000Z',
    });
    assert.equal(second.kind, 'lost');
    const read = await readRun(stateDir, created.runId);
    assert.equal(read?.state, 'completed');
  });

  it('releases the claim when the terminal write cannot land, so the next claimant can recover', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'aaa00008-ae1ea5e0');
    await rm(path.join(runDir(stateDir, created.runId), 'record.json'));

    await assert.rejects(() =>
      finalizeRun(stateDir, created.runId, 'worker', {
        state: 'failed',
        endedAt: '2026-08-17T12:00:00.000Z',
        error: 'gone',
      }),
    );

    const claim = await claimTerminal(stateDir, created.runId, 'retry');
    assert.equal(claim.kind, 'claimed');
  });
});

describe('runDir', () => {
  it('throws InvalidRunIdError for a traversing id instead of joining it onto the state directory', () => {
    assert.throws(
      () => runDir('/tmp/x/state', '../../../../etc'),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRunIdError);
        assert.equal(error.kind, 'invalid-arguments');
        assert.equal(error.details?.['runId'], '../../../../etc');
        return true;
      },
    );
  });
});

describe('listRuns', () => {
  it('ignores a directory whose name is not a runId, so a foreign folder is neither listed nor counted', async () => {
    const stateDir = await makeState();
    const real = await seed(stateDir, newRunId(Date.now()));
    await mkdir(path.join(stateDir, 'runs', 'not-a-run-id'));

    const listed = await listRuns(stateDir, 20);
    assert.deepEqual(
      listed.records.map((row) => row.runId),
      [real.runId],
    );
    assert.equal(listed.scanned, 1);
    assert.equal(listed.unreadable, 0);

    const ids = await listRunIds(stateDir);
    assert.deepEqual(ids, [real.runId]);
  });

  it('counts a non-json record and one over RECORD_MAX_BYTES as unreadable without failing', async () => {
    const stateDir = await makeState();
    await seed(stateDir, 'bbb00001-900d900d');
    await seed(stateDir, 'bbb00002-b07f50b0');
    await writeFile(path.join(runDir(stateDir, 'bbb00002-b07f50b0'), 'record.json'), 'not json');
    await seed(stateDir, 'bbb00003-7001a49e');
    await writeFile(
      path.join(runDir(stateDir, 'bbb00003-7001a49e'), 'record.json'),
      `${'x'.repeat(RECORD_MAX_BYTES + 8)}\n`,
    );

    const listed = await listRuns(stateDir, 20);
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0]?.runId, 'bbb00001-900d900d');
    assert.equal(listed.unreadable, 2);
  });

  it('returns newest first by id ordering alone, honours limit, and sets truncated past a lowered scan cap', async () => {
    const stateDir = await makeState();
    await seed(stateDir, 'ccc00001-01de5700');
    await seed(stateDir, 'ccc00002-d1dd1e00');
    await seed(stateDir, 'ccc00003-beee5700');
    await seed(stateDir, 'ccc00004-beeae000');

    const limited = await listRuns(stateDir, 2);
    assert.deepEqual(
      limited.records.map((row) => row.runId),
      ['ccc00004-beeae000', 'ccc00003-beee5700'],
    );

    const capped = await listRuns(stateDir, 20, { scanCap: 2 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.scanned, 2);
    assert.equal(capped.records.length, 2);
    assert.deepEqual(
      capped.records.map((row) => row.runId),
      ['ccc00004-beeae000', 'ccc00003-beee5700'],
    );
  });

  it('returns an empty list without throwing when the runs root does not exist', async () => {
    const listed = await listRuns(path.join(os.tmpdir(), 'grok-mcp-no-such-state-7c3e91a2'), 20);
    assert.deepEqual(listed.records, []);
    assert.equal(listed.scanned, 0);
    assert.equal(listed.truncated, false);
  });

  it(
    'throws JobStoreError when the runs root is unreadable',
    { skip: process.getuid?.() === 0 },
    async () => {
      const stateDir = await makeState();
      const root = path.join(stateDir, 'runs');
      await seed(stateDir, 'ddd00001-b10c0ed0');
      await chmod(root, 0o000);
      try {
        await assert.rejects(
          () => listRuns(stateDir, 20),
          (error: unknown) => {
            assert.ok(error instanceof JobStoreError);
            assert.match(error.remedy ?? '', /GROK_MCP_STATE_DIR/);
            return true;
          },
        );
      } finally {
        await chmod(root, 0o700);
      }
    },
  );
});

describe('progress.json', () => {
  it('round-trips a sidecar without touching record.json progress fields', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'prg00001-51deca00');
    await writeProgress(stateDir, created.runId, {
      progressCount: 4,
      lastProgress: '#4 list_dir .',
      lastProgressAt: '2026-08-17T12:00:10.000Z',
    });
    const progress = await readProgress(stateDir, created.runId);
    // Before the deepEqual: `assert.deepEqual` is an `asserts actual is T`
    // signature, so it narrows `progress` to the literal shape below and a
    // later read of `toolCalls` stops typechecking.
    assert.ok(progress);
    assert.equal(progress.toolCalls, undefined);
    assert.deepEqual(progress, {
      progressCount: 4,
      lastProgress: '#4 list_dir .',
      lastProgressAt: '2026-08-17T12:00:10.000Z',
    });
    const record = await readRun(stateDir, created.runId);
    assert.ok(record);
    assert.equal(record.progressCount, 0);
    assert.equal(record.lastProgress, null);
  });

  it('round-trips a tool-call tally and still reads a sidecar that omits it', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'prg00003-51deca00');
    await writeProgress(stateDir, created.runId, {
      progressCount: 4,
      lastProgress: '#4 grep src',
      lastProgressAt: '2026-08-17T12:00:10.000Z',
      toolCalls: {
        total: 3,
        byLabel: { read_file: 2, grep: 1 },
        lastCallAt: '2026-08-17T12:00:08.000Z',
      },
    });
    const progress = await readProgress(stateDir, created.runId);
    assert.deepEqual(progress?.toolCalls, {
      total: 3,
      byLabel: { read_file: 2, grep: 1 },
      lastCallAt: '2026-08-17T12:00:08.000Z',
    });
  });

  it('returns null when the sidecar is missing or unparseable', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'prg00002-d1551b90');
    assert.equal(await readProgress(stateDir, created.runId), null);
    await writeFile(path.join(runDir(stateDir, created.runId), 'progress.json'), 'not json');
    assert.equal(await readProgress(stateDir, created.runId), null);
  });
});

describe('worker.pid', () => {
  it('round-trips a pid and returns null when the sidecar is missing or unparseable', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'pid00001-51deca00');
    assert.equal(await readWorkerPid(stateDir, created.runId), null);
    await writeWorkerPid(stateDir, created.runId, 4242);
    assert.equal(await readWorkerPid(stateDir, created.runId), 4242);
    await writeFile(path.join(runDir(stateDir, created.runId), 'worker.pid'), 'not-a-pid\n');
    assert.equal(await readWorkerPid(stateDir, created.runId), null);
  });
});

describe('late-result.json', () => {
  it('round-trips a stored result and returns null when the file is absent', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'lte00001-ae5e1700');
    assert.equal(await readLateResult(stateDir, created.runId), null);
    await writeLateResult(stateDir, created.runId, {
      text: 'partial',
      meta: { sessionId: 'sess-late', total_cost_usd: 0.01 },
      isError: false,
    });
    const late = await readLateResult(stateDir, created.runId);
    assert.ok(late);
    assert.equal(late.text, 'partial');
    assert.equal(late.meta['sessionId'], 'sess-late');
    assert.equal(late.isError, false);
  });
});

describe('private file modes', { skip: process.platform === 'win32' }, () => {
  it('creates a run directory as 0700 so other local users cannot read the prompt', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'mod00001-adb01a00');
    assert.equal(await fileMode(runDir(stateDir, created.runId)), 0o700);
  });

  it('writes record.json and input.json as 0600', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'mod00002-f50b0000');
    const dir = runDir(stateDir, created.runId);
    assert.equal(await fileMode(path.join(dir, 'record.json')), 0o600);
    assert.equal(await fileMode(path.join(dir, 'input.json')), 0o600);
  });

  it('writes the progress append sidecar as 0600 once written', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'mod00003-a00e0d00');
    const filePath = path.join(runDir(stateDir, created.runId), 'progress.log');
    const appender = createLogAppender(filePath, 1024);
    appender.write('step\n');
    await appender.close();
    assert.equal(await fileMode(filePath), 0o600);
  });

  it('writes the terminal claim file as 0600', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'mod00004-c1a1d000');
    const claimed = await claimTerminal(stateDir, created.runId, 'test');
    assert.equal(claimed.kind, 'claimed');
    assert.equal(
      await fileMode(path.join(runDir(stateDir, created.runId), 'terminal.claim')),
      0o600,
    );
  });
});

describe('atomic writes', () => {
  it('leaves no *.tmp file after a successful write', async () => {
    const stateDir = await makeState();
    const created = await seed(stateDir, 'eee00001-a70d1c70');
    await patchRun(stateDir, created.runId, { lastProgress: 'step' });
    const names = await readdir(runDir(stateDir, created.runId));
    assert.equal(
      names.some((name) => name.endsWith('.tmp')),
      false,
      `tmp file survived: ${names.join(', ')}`,
    );
  });
});

describe('createLogAppender', () => {
  it('preserves order under a burst of 500 writes and stops at maxBytes with the marker present exactly once', async () => {
    const stateDir = await makeState();
    const filePath = path.join(stateDir, 'burst.log');
    const maxBytes = 200;
    const appender = createLogAppender(filePath, maxBytes);
    for (let i = 0; i < 500; i += 1) {
      appender.write(`${String(i).padStart(3, '0')}\n`);
    }
    await appender.close();

    const text = await readFile(filePath, 'utf8');
    const marker = `[log truncated at ${maxBytes} bytes by grok-build-mcp-server]`;
    const markerHits = text.split(marker).length - 1;
    assert.equal(markerHits, 1);
    assert.ok(text.includes(marker));

    const lines = text
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('[log truncated'));
    for (let i = 1; i < lines.length; i += 1) {
      const prev = lines[i - 1];
      const curr = lines[i];
      assert.ok(prev !== undefined && curr !== undefined);
      assert.ok(prev < curr, `out of order: ${prev} then ${curr}`);
    }
    assert.ok(Buffer.byteLength(text) <= maxBytes + Buffer.byteLength(`${marker}\n`));
  });
});

describe('tailFile', () => {
  it('reads only the end of a file larger than the tail and sets truncated', async () => {
    const stateDir = await makeState();
    const filePath = path.join(stateDir, 'tail.log');
    await writeFile(filePath, 'line-one\nline-two\nline-three\n');
    const tailed = await tailFile(filePath, 14);
    assert.equal(tailed.truncated, true);
    assert.ok(!tailed.text.startsWith('line-one'));
    assert.match(tailed.text, /line-three\n$/);
    assert.doesNotMatch(tailed.text, /^[^\n]*[^\n]$/s);

    const whole = await tailFile(filePath, 100);
    assert.equal(whole.text, 'line-one\nline-two\nline-three\n');
    assert.equal(whole.truncated, false);
  });

  it('drops a mid-line prefix after a truncated read so a chopped UTF-8 sequence is not shown', async () => {
    const stateDir = await makeState();
    const filePath = path.join(stateDir, 'mid.log');
    await writeFile(filePath, 'AAAAAAAA\ncomplete-line\n');
    const tailed = await tailFile(filePath, 18);
    assert.equal(tailed.truncated, true);
    assert.equal(tailed.text.startsWith('A'), false);
    assert.match(tailed.text, /complete-line\n$/);
  });
});
