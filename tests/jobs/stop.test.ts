import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { processAlive } from '../../src/jobs/kill.js';
import { isTerminal, type RunRecord } from '../../src/jobs/record.js';
import {
  claimTerminal,
  createRun,
  patchRun,
  readLateResult,
  readProgress,
  readRun,
  runDir,
  writeLateResult,
  writeTerminal,
  writeWorkerPid,
} from '../../src/jobs/store.js';
import { runJob } from '../../src/jobs/worker.js';
import { grokTool } from '../../src/tools/handlers/grok.js';
import { statusTool } from '../../src/tools/handlers/status.js';
import { LATE_RESULT_WAIT_MS, stopTool } from '../../src/tools/handlers/stop.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

interface SessionsStore {
  readonly home: string;
  readonly root: string;
  add(spec: {
    readonly id: string;
    readonly cwd?: string;
    readonly rawCwd?: string;
    readonly summary?: object | string | false;
    readonly history?: string | readonly object[];
  }): Promise<string>;
  cleanup(): Promise<void>;
}

// prettier-ignore
// @ts-expect-error -- untyped JS fixture; aliases below are the types.
import { withSessionsStore as withSessionsStoreRaw } from '../fixtures/sessions-store.mjs';

const withSessionsStore = withSessionsStoreRaw as (
  fn: (store: SessionsStore) => Promise<void>,
) => Promise<void>;

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));
const STREAM_HAPPY = fileURLToPath(new URL('../fixtures/stream-happy.ndjson', import.meta.url));

const tmpDirs: string[] = [];
const trackedPids = new Set<number>();

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-stop-'));
  tmpDirs.push(dir);
  return dir;
}

function trackPid(pid: number | null | undefined): void {
  if (typeof pid === 'number' && pid > 0) trackedPids.add(pid);
}

function killPid(pid: number): void {
  if (pid === process.pid || pid === process.ppid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* group may not exist */
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

afterEach(async () => {
  for (const pid of trackedPids) {
    killPid(pid);
  }
  trackedPids.clear();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function installFake(script: Record<string, string> = {}): Promise<string> {
  const dir = await makeTmp();
  const binary = path.join(dir, 'grok');
  const assignments = Object.entries(script)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join('\n');
  const source = `#!/usr/bin/env node
${assignments}
await import(${JSON.stringify(pathToFileURL(FAKE_GROK).href)});
`;
  await writeFile(binary, source, { encoding: 'utf8' });
  await chmod(binary, 0o755);
  return binary;
}

function isolatedConfig(
  stateDir: string,
  binary: string,
  extra: Record<string, string> = {},
): Config {
  return loadConfig({
    HOME: '/tmp/grok-mcp-test-home',
    GROK_BINARY: binary,
    GROK_MCP_STATE_DIR: stateDir,
    GROK_MCP_TIMEOUT_MS: '15000',
    GROK_MCP_LOG_LEVEL: 'error',
    ...extra,
  });
}

function ctxFor(config: Config, signal?: AbortSignal): ToolContext {
  return {
    config,
    signal: signal ?? new AbortController().signal,
    reportProgress: () => {
      /* unused */
    },
    progressRequested: false,
  };
}

function textOf(result: ToolResult): string {
  const [block] = result.content;
  assert.ok(block);
  return block.text;
}

function metaOf(result: ToolResult): Record<string, unknown> {
  const [block] = result.content;
  assert.ok(block);
  assert.ok(block._meta);
  return block._meta;
}

async function seedRun(
  stateDir: string,
  runId: string,
  extra: { summary?: string; input?: Record<string, unknown> } = {},
): Promise<RunRecord> {
  return createRun({
    stateDir,
    runId,
    tool: 'grok',
    summary: extra.summary ?? 'seed',
    cwd: '/tmp',
    input: extra.input ?? { prompt: 'hi' },
  });
}

async function seedTerminal(
  stateDir: string,
  runId: string,
  patch: Parameters<typeof writeTerminal>[2],
): Promise<void> {
  await seedRun(stateDir, runId);
  const claim = await claimTerminal(stateDir, runId, 'test');
  assert.equal(claim.kind, 'claimed');
  const written = await writeTerminal(stateDir, runId, patch);
  assert.ok(written);
}

async function waitForTerminal(
  stateDir: string,
  runId: string,
  timeoutMs: number,
): Promise<RunRecord> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const record = await readRun(stateDir, runId);
    if (record !== null && isTerminal(record.state)) return record;
    if (record?.workerPid !== null && record?.workerPid !== undefined) {
      trackPid(record.workerPid);
    }
    await delay(30);
  }
  const last = await readRun(stateDir, runId);
  assert.fail(
    `run ${runId} did not terminate within ${timeoutMs}ms (last state=${last?.state ?? 'missing'})`,
  );
}

async function claimPresent(stateDir: string, runId: string): Promise<boolean> {
  try {
    await access(path.join(runDir(stateDir, runId), 'terminal.claim'));
    return true;
  } catch {
    return false;
  }
}

describe('stop unknown and already-terminal', () => {
  it('reports found: false and isError: false for an unknown id', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const result = await stopTool.handler(
      { runId: 'no-such-run' },
      ctxFor(isolatedConfig(stateDir, binary)),
    );
    assert.notEqual(result.isError, true);
    assert.equal(metaOf(result)['found'], false);
    assert.equal(metaOf(result)['stateDir'], stateDir);
    assert.match(textOf(result), /no-such-run/);
  });

  it('sends no signals when the record is already terminal, even if its pid is alive', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    const sleeperPid = sleeper.pid;
    assert.ok(typeof sleeperPid === 'number');
    trackPid(sleeperPid);
    await seedTerminal(stateDir, 'stp00001-alreadyx', {
      state: 'completed',
      endedAt: '2026-08-17T12:00:00.000Z',
      workerPid: sleeperPid,
      sessionId: '01a00c8d-970c-7531-8a12-31dac582c22b',
    });

    const result = await stopTool.handler(
      { runId: 'stp00001-alreadyx' },
      ctxFor(isolatedConfig(stateDir, binary)),
    );
    assert.notEqual(result.isError, true);
    assert.equal(metaOf(result)['state'], 'completed');
    assert.deepEqual(metaOf(result)['signalsSent'], []);
    assert.equal(metaOf(result)['sessionId'], '01a00c8d-970c-7531-8a12-31dac582c22b');
    assert.equal(processAlive(sleeperPid), true);
    sleeper.kill('SIGKILL');
  });

  it('reports a still-running lost claim as another process finalizing, not as a completed stop', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const created = await seedRun(stateDir, 'stp00002-lostclm');
    await patchRun(stateDir, created.runId, { state: 'running', workerPid: process.pid });
    const claim = await claimTerminal(stateDir, created.runId, 'worker');
    assert.equal(claim.kind, 'claimed');

    const result = await stopTool.handler(
      { runId: created.runId },
      ctxFor(isolatedConfig(stateDir, binary)),
    );
    assert.notEqual(result.isError, true);
    assert.deepEqual(metaOf(result)['signalsSent'], []);
    assert.equal(metaOf(result)['claimedByOther'], true);
    assert.equal(metaOf(result)['state'], 'running');
    assert.match(textOf(result), /still running/);
    assert.match(textOf(result), /another process holds the terminal claim/);
    assert.doesNotMatch(textOf(result), /completed before the stop landed/);
    assert.equal(processAlive(process.pid), true);
    const record = await readRun(stateDir, created.runId);
    assert.equal(record?.state, 'running');
  });

  it('surfaces a previous kill failure on an already-terminal record without re-signalling its pid', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    const sleeperPid = sleeper.pid;
    assert.ok(typeof sleeperPid === 'number');
    trackPid(sleeperPid);
    await seedTerminal(stateDir, 'stp00012-prevkill', {
      state: 'cancelled',
      endedAt: '2026-08-17T12:00:00.000Z',
      workerPid: sleeperPid,
      error: 'Signalled SIGTERM then SIGKILL to process group 1; process 1 is still running.',
    });

    const result = await stopTool.handler(
      { runId: 'stp00012-prevkill' },
      ctxFor(isolatedConfig(stateDir, binary)),
    );
    assert.notEqual(result.isError, true);
    assert.equal(metaOf(result)['state'], 'cancelled');
    assert.deepEqual(metaOf(result)['signalsSent'], []);
    assert.equal(
      metaOf(result)['error'],
      'Signalled SIGTERM then SIGKILL to process group 1; process 1 is still running.',
    );
    assert.match(textOf(result), /already cancelled/);
    assert.match(textOf(result), /still running/);
    assert.equal(processAlive(sleeperPid), true);
    sleeper.kill('SIGKILL');
  });
});

describe('stop during boot', () => {
  it(
    'kills a live worker from the pid sidecar when the record is still starting and has no workerPid',
    { skip: process.platform === 'win32', timeout: 15_000 },
    async () => {
      const stateDir = await makeTmp();
      const binary = await installFake();
      const created = await seedRun(stateDir, 'stp00010-bootpid');
      const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        detached: true,
        stdio: 'ignore',
      });
      const workerPid = worker.pid;
      assert.ok(typeof workerPid === 'number');
      trackPid(workerPid);
      await new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('spawn', () => {
          resolve();
        });
      });
      await writeWorkerPid(stateDir, created.runId, workerPid);
      const before = await readRun(stateDir, created.runId);
      assert.ok(before);
      assert.equal(before.state, 'starting');
      assert.equal(before.workerPid, null);

      const result = await stopTool.handler(
        { runId: created.runId },
        ctxFor(isolatedConfig(stateDir, binary)),
      );
      assert.notEqual(result.isError, true);
      assert.deepEqual(metaOf(result)['signalsSent'], ['SIGTERM']);
      assert.equal(metaOf(result)['workerPid'], workerPid);
      assert.equal(metaOf(result)['state'], 'cancelled');
      assert.equal(processAlive(workerPid), false);
      const record = await readRun(stateDir, created.runId);
      assert.equal(record?.state, 'cancelled');
    },
  );
});

describe('stop that cannot kill', () => {
  it('does not write a terminal record, releases the claim, and returns isError so a later claimant can finish', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const created = await seedRun(stateDir, 'stp00011-nokillx');

    const result = await stopTool.handler(
      { runId: created.runId },
      ctxFor(isolatedConfig(stateDir, binary)),
    );
    assert.equal(result.isError, true);
    assert.equal(metaOf(result)['killReason'], 'no-pid');
    assert.equal(metaOf(result)['state'], 'starting');
    assert.deepEqual(metaOf(result)['signalsSent'], []);
    assert.match(textOf(result), /Could not stop/);

    const record = await readRun(stateDir, created.runId);
    assert.ok(record);
    assert.equal(record.state, 'starting');
    assert.equal(await claimPresent(stateDir, created.runId), false);

    const later = await claimTerminal(stateDir, created.runId, 'worker');
    assert.equal(later.kind, 'claimed');
  });
});

describe('late-result wait', () => {
  it('does not sit out the full late-result window when the worker is already gone', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const created = await seedRun(stateDir, 'stp00013-fastgone');
    await patchRun(stateDir, created.runId, { state: 'running', workerPid: 999_999 });

    const began = Date.now();
    const result = await stopTool.handler(
      { runId: created.runId },
      ctxFor(isolatedConfig(stateDir, binary)),
    );
    const elapsed = Date.now() - began;
    assert.notEqual(result.isError, true);
    assert.equal(metaOf(result)['killReason'], 'gone');
    assert.ok(
      elapsed < LATE_RESULT_WAIT_MS,
      `paid the full late-result wait (${elapsed}ms >= ${LATE_RESULT_WAIT_MS}ms) for a dead worker`,
    );
  });
});

describe('exactly one terminal state under a race', () => {
  it('gives exactly one claimed outcome when stop and the worker claim concurrently, and the record matches the claimant', async () => {
    const stateDir = await makeTmp();
    const created = await seedRun(stateDir, 'stp00003-claimrx');

    const [stopClaim, workerClaim] = await Promise.all([
      claimTerminal(stateDir, created.runId, 'stop'),
      claimTerminal(stateDir, created.runId, 'worker'),
    ]);
    const kinds = [stopClaim.kind, workerClaim.kind].sort();
    assert.deepEqual(kinds, ['claimed', 'lost']);

    if (stopClaim.kind === 'claimed') {
      const written = await writeTerminal(stateDir, created.runId, {
        state: 'cancelled',
        endedAt: '2026-08-17T12:00:00.000Z',
      });
      assert.equal(written?.state, 'cancelled');
    }
    if (workerClaim.kind === 'claimed') {
      const written = await writeTerminal(stateDir, created.runId, {
        state: 'completed',
        endedAt: '2026-08-17T12:00:00.000Z',
      });
      assert.equal(written?.state, 'completed');
    }

    const record = await readRun(stateDir, created.runId);
    assert.ok(record);
    assert.ok(isTerminal(record.state));
    if (stopClaim.kind === 'claimed') {
      assert.equal(record.state, 'cancelled');
    } else {
      assert.equal(record.state, 'completed');
    }
  });

  it(
    'resolves a live stop against a slow fake to exactly one terminal state',
    { skip: process.platform === 'win32', timeout: 20_000 },
    async () => {
      const stateDir = await makeTmp();
      const binary = await installFake({
        FAKE_GROK_STDOUT: '',
        FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
        FAKE_GROK_SLEEP_MS: '8000',
      });
      const config = isolatedConfig(stateDir, binary);
      const started = await grokTool.handler({ prompt: 'hi', background: true }, ctxFor(config));
      const runId = String(metaOf(started)['runId']);
      trackPid(metaOf(started)['workerPid'] as number | null);

      const result = await stopTool.handler({ runId }, ctxFor(config));
      assert.notEqual(result.isError, true);
      const record = await waitForTerminal(stateDir, runId, 10_000);
      assert.ok(isTerminal(record.state));
      assert.ok(record.state === 'cancelled' || record.state === 'completed');
      assert.equal(await claimPresent(stateDir, runId), true);
    },
  );
});

describe('late-result preservation', () => {
  it('writes late-result.json when the worker loses the claim, and both stop and status surface it without reporting completed', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
    });
    const config = isolatedConfig(stateDir, binary);
    const created = await createRun({
      stateDir,
      runId: 'stp00004-latexxx',
      tool: 'grok',
      summary: 'late',
      cwd: process.cwd(),
      input: { prompt: 'hi' },
    });

    const state = await runJob({
      stateDir,
      runId: created.runId,
      config,
      signal: new AbortController().signal,
      afterTool: async () => {
        const claim = await claimTerminal(stateDir, created.runId, 'stop');
        assert.equal(claim.kind, 'claimed');
        const written = await writeTerminal(stateDir, created.runId, {
          state: 'cancelled',
          endedAt: new Date().toISOString(),
          error: 'stopped by test',
        });
        assert.ok(written);
      },
    });

    assert.equal(state, 'cancelled');
    const late = await readLateResult(stateDir, created.runId);
    assert.ok(late);
    assert.match(late.text, /Here you go/);
    assert.equal(late.meta['sessionId'], '00000000-0000-7000-8000-000000000001');

    const record = await readRun(stateDir, created.runId);
    assert.ok(record);
    assert.equal(record.state, 'cancelled');
    assert.equal(record.result, null);

    const status = await statusTool.handler({ runId: created.runId }, ctxFor(config));
    assert.notEqual(status.isError, true);
    assert.equal(metaOf(status)['state'], 'cancelled');
    assert.match(textOf(status), /This run was cancelled/);
    assert.match(textOf(status), /also produced a result before it died/);
    assert.match(textOf(status), /Here you go/);
    assert.doesNotMatch(textOf(status), /completed/);
    assert.ok(metaOf(status)['lateResult']);

    const stopped = await stopTool.handler({ runId: created.runId }, ctxFor(config));
    assert.notEqual(stopped.isError, true);
    assert.equal(metaOf(stopped)['state'], 'cancelled');
    assert.deepEqual(metaOf(stopped)['signalsSent'], []);
    assert.match(textOf(stopped), /already cancelled/);
    assert.match(textOf(stopped), /00000000-0000-7000-8000-000000000001/);
  });

  it(
    'surfaces a late result produced while the worker is dying from stop',
    { skip: process.platform === 'win32', timeout: 20_000 },
    async () => {
      const stateDir = await makeTmp();
      const binary = await installFake({
        FAKE_GROK_STDOUT:
          '{"type":"text","data":"partial-ok"}\n' +
          '{"type":"end","stopReason":"end_turn","sessionId":"01a00c8d-970c-7531-8a12-31dac582c22b","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.001}\n',
        FAKE_GROK_SLEEP_MS: '15000',
      });
      const config = isolatedConfig(stateDir, binary);
      const started = await grokTool.handler({ prompt: 'hi', background: true }, ctxFor(config));
      const runId = String(metaOf(started)['runId']);
      trackPid(metaOf(started)['workerPid'] as number | null);

      const startedAt = Date.now();
      while (Date.now() - startedAt < 3000) {
        const live = await readRun(stateDir, runId);
        if (live?.state === 'running' && live.childPid !== null) break;
        await delay(20);
      }
      // The fake writes its transcript before sleeping, but "the worker has
      // consumed it" is not something a fixed sleep can assert — a 50 ms wait
      // passed on Linux and lost the `end` event on a slow macOS runner, so the
      // late result arrived with no session id. Wait for the progress line the
      // `end` event produces instead, which is the actual precondition.
      const consumedBy = Date.now() + 10_000;
      while (Date.now() < consumedBy) {
        const progress = await readProgress(stateDir, runId);
        if (progress !== null && (progress.lastProgress ?? '').includes('finished')) break;
        await delay(20);
      }

      const result = await stopTool.handler({ runId }, ctxFor(config));
      assert.notEqual(result.isError, true);
      assert.equal(metaOf(result)['state'], 'cancelled');
      assert.notEqual(metaOf(result)['state'], 'completed');
      const late = metaOf(result)['lateResult'];
      assert.ok(late !== undefined, `expected a late result, body=\n${textOf(result)}`);
      assert.match(textOf(result), /cancelled mid-flight/);
      assert.match(textOf(result), /01a00c8d-970c-7531-8a12-31dac582c22b/);

      const record = await waitForTerminal(stateDir, runId, 10_000);
      assert.equal(record.state, 'cancelled');
    },
  );
});

describe('progress stays off record.json under a live stop', () => {
  it(
    'never leaves a non-terminal record with a claim file across 100 interleaved stops',
    { skip: process.platform === 'win32', timeout: 180_000 },
    async () => {
      const stateDir = await makeTmp();
      const binary = await installFake({
        FAKE_GROK_STDOUT: '',
        FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
        FAKE_GROK_SLEEP_MS: '400',
      });
      const config = isolatedConfig(stateDir, binary);

      for (let i = 0; i < 100; i += 1) {
        const started = await grokTool.handler(
          { prompt: `race-${i}`, background: true },
          ctxFor(config),
        );
        const runId = String(metaOf(started)['runId']);
        trackPid(metaOf(started)['workerPid'] as number | null);

        const bootDeadline = Date.now() + 2000;
        while (Date.now() < bootDeadline) {
          const live = await readRun(stateDir, runId);
          if (live !== null && (isTerminal(live.state) || live.workerPid !== null)) break;
          await delay(10);
        }

        // Deterministic spread across the run, not Math.random: the same
        // interleaving has to be reproducible when this fails. The sidecar
        // makes the worker findable during boot; this spread is the
        // progress-flush window that used to lose the record.
        const delayMs = (i * 7) % 250;
        if (delayMs > 0) await delay(delayMs);

        const stopped = await stopTool.handler({ runId }, ctxFor(config));
        assert.notEqual(stopped.isError, true);

        const record = await waitForTerminal(stateDir, runId, 10_000);
        assert.ok(
          isTerminal(record.state),
          `iteration ${i}: expected terminal, got ${record.state}`,
        );
        assert.equal(
          await claimPresent(stateDir, runId),
          true,
          `iteration ${i}: terminal without a claim file`,
        );
        if (record.workerPid !== null) {
          // Give a dying worker a tick to exit after the terminal write.
          const until = Date.now() + 2000;
          while (processAlive(record.workerPid) && Date.now() < until) {
            await delay(20);
          }
        }
      }
    },
  );
});

describe('worker writes progress.json, not record.json', () => {
  it('leaves record progress fields at their creation defaults after a completed run', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
    });
    const config = isolatedConfig(stateDir, binary);
    const created = await createRun({
      stateDir,
      runId: 'stp00005-progxxx',
      tool: 'grok',
      summary: 'progress sidecar',
      cwd: process.cwd(),
      input: { prompt: 'hi' },
    });

    const state = await runJob({
      stateDir,
      runId: created.runId,
      config,
      signal: new AbortController().signal,
    });
    assert.equal(state, 'completed');
    const record = await readRun(stateDir, created.runId);
    assert.ok(record);
    assert.equal(record.progressCount, 0);
    assert.equal(record.lastProgress, null);
    const progress = await readProgress(stateDir, created.runId);
    assert.ok(progress);
    assert.ok(progress.progressCount > 0);
  });
});

function sessionSummary(id: string, cwd: string, createdAt: string): Record<string, unknown> {
  return {
    info: { id, cwd },
    session_summary: '',
    created_at: createdAt,
    updated_at: createdAt,
    num_messages: 2,
    current_model_id: 'grok-4.6',
  };
}

describe('session recovery from the store', () => {
  it('reports a single store match with a resume command and sessionIdSource store', async () => {
    await withSessionsStore(async (store) => {
      const stateDir = await makeTmp();
      const binary = await installFake();
      const now = Date.now();
      const startedAt = new Date(now - 20_000).toISOString();
      const createdAt = new Date(now - 10_000).toISOString();
      const sessionId = '01a010d3-9ab8-7d60-909d-f00f2c13067a';
      await store.add({
        id: sessionId,
        cwd: '/tmp',
        summary: sessionSummary(sessionId, '/tmp', createdAt),
      });
      const created = await seedRun(stateDir, 'stp00020-onestore');
      await patchRun(stateDir, created.runId, {
        state: 'running',
        workerPid: 999_999,
        startedAt,
      });

      const result = await stopTool.handler(
        { runId: created.runId },
        ctxFor(isolatedConfig(stateDir, binary, { GROK_HOME: store.home })),
      );
      assert.notEqual(result.isError, true);
      assert.equal(metaOf(result)['sessionId'], sessionId);
      assert.equal(metaOf(result)['sessionIdSource'], 'store');
      assert.equal(metaOf(result)['sessionCandidates'], undefined);
      assert.match(textOf(result), /Resume with:/);
      assert.match(textOf(result), new RegExp(`grok -r ${sessionId}`));

      const again = await stopTool.handler(
        { runId: created.runId },
        ctxFor(isolatedConfig(stateDir, binary, { GROK_HOME: store.home })),
      );
      assert.equal(metaOf(again)['sessionId'], sessionId);
      assert.equal(metaOf(again)['sessionIdSource'], 'store');
      assert.match(textOf(again), new RegExp(`grok -r ${sessionId}`));
    });
  });

  it('reports neither id and sets sessionCandidates when two store matches share the window', async () => {
    await withSessionsStore(async (store) => {
      const stateDir = await makeTmp();
      const binary = await installFake();
      const now = Date.now();
      const startedAt = new Date(now - 20_000).toISOString();
      const first = '01a010aa-1111-7000-8000-000000000001';
      const second = '01a010bb-2222-7000-8000-000000000002';
      await store.add({
        id: first,
        cwd: '/tmp',
        summary: sessionSummary(first, '/tmp', new Date(now - 12_000).toISOString()),
      });
      await store.add({
        id: second,
        cwd: '/tmp',
        summary: sessionSummary(second, '/tmp', new Date(now - 8_000).toISOString()),
      });
      const created = await seedRun(stateDir, 'stp00021-twostore');
      await patchRun(stateDir, created.runId, {
        state: 'running',
        workerPid: 999_999,
        startedAt,
      });

      const result = await stopTool.handler(
        { runId: created.runId },
        ctxFor(isolatedConfig(stateDir, binary, { GROK_HOME: store.home })),
      );
      assert.notEqual(result.isError, true);
      assert.equal(metaOf(result)['sessionId'], undefined);
      assert.equal(metaOf(result)['sessionIdSource'], undefined);
      assert.deepEqual(metaOf(result)['sessionCandidates'], [first, second]);
      assert.match(textOf(result), /could not be identified uniquely/);
      assert.match(textOf(result), new RegExp(first));
      assert.match(textOf(result), new RegExp(second));
      assert.doesNotMatch(textOf(result), /Resume with:/);
    });
  });

  it('adds nothing to the body when the store has zero matches', async () => {
    await withSessionsStore(async (store) => {
      const stateDir = await makeTmp();
      const binary = await installFake();
      const now = Date.now();
      const startedAt = new Date(now - 20_000).toISOString();
      const outsider = '01a010cc-3333-7000-8000-000000000003';
      await store.add({
        id: outsider,
        cwd: '/tmp',
        summary: sessionSummary(outsider, '/tmp', new Date(now - 60_000).toISOString()),
      });
      const created = await seedRun(stateDir, 'stp00022-zerostor');
      await patchRun(stateDir, created.runId, {
        state: 'running',
        workerPid: 999_999,
        startedAt,
      });

      const result = await stopTool.handler(
        { runId: created.runId },
        ctxFor(isolatedConfig(stateDir, binary, { GROK_HOME: store.home })),
      );
      assert.notEqual(result.isError, true);
      assert.equal(metaOf(result)['sessionId'], undefined);
      assert.equal(metaOf(result)['sessionIdSource'], undefined);
      assert.equal(metaOf(result)['sessionCandidates'], undefined);
      assert.doesNotMatch(textOf(result), /Resume with:/);
      assert.doesNotMatch(textOf(result), /could not be identified uniquely/);
      assert.doesNotMatch(textOf(result), new RegExp(outsider));
    });
  });

  it('lets a session id from a real end event win over the store, with sessionIdSource result', async () => {
    await withSessionsStore(async (store) => {
      const stateDir = await makeTmp();
      const binary = await installFake();
      const now = Date.now();
      const startedAt = new Date(now - 20_000).toISOString();
      const fromEnd = '01a00c8d-970c-7531-8a12-31dac582c22b';
      const fromStore = '01a010d3-9ab8-7d60-909d-f00f2c13067a';
      await store.add({
        id: fromStore,
        cwd: '/tmp',
        summary: sessionSummary(fromStore, '/tmp', new Date(now - 10_000).toISOString()),
      });
      const created = await seedRun(stateDir, 'stp00023-endwins');
      await patchRun(stateDir, created.runId, {
        state: 'running',
        workerPid: 999_999,
        startedAt,
      });
      await writeLateResult(stateDir, created.runId, {
        text: 'partial-from-end',
        meta: { sessionId: fromEnd },
        isError: false,
      });

      const result = await stopTool.handler(
        { runId: created.runId },
        ctxFor(isolatedConfig(stateDir, binary, { GROK_HOME: store.home })),
      );
      assert.notEqual(result.isError, true);
      assert.equal(metaOf(result)['sessionId'], fromEnd);
      assert.equal(metaOf(result)['sessionIdSource'], 'result');
      assert.equal(metaOf(result)['sessionCandidates'], undefined);
      assert.match(textOf(result), new RegExp(fromEnd));
      assert.doesNotMatch(textOf(result), new RegExp(fromStore));
    });
  });

  it('still reports the stop when the session store is unreadable', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const grokHome = await makeTmp();
    await writeFile(path.join(grokHome, 'sessions'), 'not a directory');
    const created = await seedRun(stateDir, 'stp00024-badstore');
    await patchRun(stateDir, created.runId, {
      state: 'running',
      workerPid: 999_999,
      startedAt: new Date(Date.now() - 20_000).toISOString(),
    });

    const result = await stopTool.handler(
      { runId: created.runId },
      ctxFor(isolatedConfig(stateDir, binary, { GROK_HOME: grokHome })),
    );
    assert.notEqual(result.isError, true);
    assert.equal(metaOf(result)['state'], 'cancelled');
    assert.equal(metaOf(result)['sessionId'], undefined);
  });
});
