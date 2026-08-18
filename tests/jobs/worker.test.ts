import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { newRunId } from '../../src/jobs/record.js';
import {
  claimTerminal,
  createRun,
  patchRun,
  readRun,
  writeTerminal,
} from '../../src/jobs/store.js';
import { runJob, sweepRetainedRuns } from '../../src/jobs/worker.js';
import { grokTool } from '../../src/tools/handlers/grok.js';
import type { ToolContext } from '../../src/types.js';

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));
const STREAM_HAPPY = fileURLToPath(new URL('../fixtures/stream-happy.ndjson', import.meta.url));

const tmpDirs: string[] = [];

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-worker-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function installFake(script: Record<string, string> = {}): Promise<{
  binary: string;
  argvFile: string;
}> {
  const dir = await makeTmp();
  const argvFile = path.join(dir, 'argv.json');
  const binary = path.join(dir, 'grok');
  const env = { FAKE_GROK_ARGV_FILE: argvFile, ...script };
  const assignments = Object.entries(env)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join('\n');
  const source = `#!/usr/bin/env node
${assignments}
await import(${JSON.stringify(pathToFileURL(FAKE_GROK).href)});
`;
  await writeFile(binary, source, { encoding: 'utf8' });
  await chmod(binary, 0o755);
  return { binary, argvFile };
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
    GROK_MCP_TIMEOUT_MS: '5000',
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
    progressRequested: true,
  };
}

async function seedRun(
  stateDir: string,
  input: Record<string, unknown>,
  tool = 'grok',
): Promise<string> {
  const created = await createRun({
    stateDir,
    runId: newRunId(Date.now()),
    tool,
    summary: 'test run',
    cwd: process.cwd(),
    input,
  });
  return created.runId;
}

describe('runJob happy path', () => {
  it('ends completed with the same text a foreground grok call produces, and records argv, childPid, progress, and sessionId', async () => {
    const stateDir = await makeTmp();
    const { binary } = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
    });
    const config = isolatedConfig(stateDir, binary);
    const input = { prompt: 'hi' };

    const foreground = await grokTool.handler(input, ctxFor(config));
    const runId = await seedRun(stateDir, input);
    const state = await runJob({
      stateDir,
      runId,
      config,
      signal: new AbortController().signal,
    });

    assert.equal(state, 'completed');
    const record = await readRun(stateDir, runId);
    assert.ok(record);
    assert.equal(record.state, 'completed');
    assert.ok(record.result);
    assert.equal(record.result.text, foreground.content[0]?.text);
    assert.ok(record.argv !== null && record.argv.length > 0);
    assert.ok(typeof record.childPid === 'number' && record.childPid > 0);
    assert.equal(record.sessionId, '00000000-0000-7000-8000-000000000001');

    const progress = await readFile(path.join(stateDir, 'runs', runId, 'progress.log'), 'utf8');
    assert.ok(progress.length > 0);
  });

  it('keeps the completed result intact when a progress flush fires at the instant the tool resolves', async () => {
    const stateDir = await makeTmp();
    const { binary } = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
    });
    const config = isolatedConfig(stateDir, binary);
    const runId = await seedRun(stateDir, { prompt: 'hi' });
    let flushFired = false;

    const state = await runJob({
      stateDir,
      runId,
      config,
      signal: new AbortController().signal,
      afterTool: (flush) => {
        flushFired = true;
        flush();
      },
    });

    assert.equal(flushFired, true);
    assert.equal(state, 'completed');
    const record = await readRun(stateDir, runId);
    assert.ok(record);
    assert.equal(record.state, 'completed');
    assert.ok(record.result);
    assert.match(record.result.text, /Here you go/);
    assert.equal(record.sessionId, '00000000-0000-7000-8000-000000000001');
  });
});

describe('runJob failure paths', () => {
  it('ends failed with the result preserved when the fake grok exits non-zero', async () => {
    const stateDir = await makeTmp();
    const { binary } = await installFake({
      FAKE_GROK_STDOUT: 'partial-out',
      FAKE_GROK_STDERR: 'partial-err',
      FAKE_GROK_EXIT_CODE: '1',
    });
    const config = isolatedConfig(stateDir, binary);
    const runId = await seedRun(stateDir, { prompt: 'hi' });
    const state = await runJob({
      stateDir,
      runId,
      config,
      signal: new AbortController().signal,
    });

    assert.equal(state, 'failed');
    const record = await readRun(stateDir, runId);
    assert.ok(record);
    assert.equal(record.state, 'failed');
    assert.ok(record.result);
    assert.equal(record.result.isError, true);
    assert.match(record.result.text, /partial-out/);
  });

  it('exits without invoking the tool when its running patch is refused because a claim exists', async () => {
    const stateDir = await makeTmp();
    const { binary, argvFile } = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
    });
    const config = isolatedConfig(stateDir, binary);
    const runId = await seedRun(stateDir, { prompt: 'hi' });
    const claim = await claimTerminal(stateDir, runId, 'stop');
    assert.equal(claim.kind, 'claimed');

    const state = await runJob({
      stateDir,
      runId,
      config,
      signal: new AbortController().signal,
    });

    assert.equal(state, 'starting');
    const record = await readRun(stateDir, runId);
    assert.ok(record);
    assert.equal(record.state, 'starting');
    assert.equal(record.workerPid, null);
    await assert.rejects(
      () => readFile(argvFile),
      (error: unknown) => {
        return (
          typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
        );
      },
    );
  });

  it('returns without writing when the record is already terminal', async () => {
    const stateDir = await makeTmp();
    const { binary } = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
    });
    const config = isolatedConfig(stateDir, binary);
    const runId = await seedRun(stateDir, { prompt: 'hi' });
    const claim = await claimTerminal(stateDir, runId, 'test');
    assert.equal(claim.kind, 'claimed');
    await writeTerminal(stateDir, runId, {
      state: 'completed',
      endedAt: '2026-08-17T12:00:00.000Z',
    });
    const filePath = path.join(stateDir, 'runs', runId, 'record.json');
    const before = await readFile(filePath);

    const state = await runJob({
      stateDir,
      runId,
      config,
      signal: new AbortController().signal,
    });
    assert.equal(state, 'completed');
    const after = await readFile(filePath);
    assert.deepEqual(after, before);
  });

  it('reaches failed with error set when the tool throws', async () => {
    const stateDir = await makeTmp();
    const { binary } = await installFake();
    const config = isolatedConfig(stateDir, binary);
    const runId = await seedRun(stateDir, { prompt: 'hi', permission: 'full' });
    const state = await runJob({
      stateDir,
      runId,
      config,
      signal: new AbortController().signal,
    });

    assert.equal(state, 'failed');
    const record = await readRun(stateDir, runId);
    assert.ok(record);
    assert.equal(record.state, 'failed');
    assert.ok(record.error);
    assert.match(record.error, /GROK_MCP_PERMISSION_CEILING/);
  });

  it('leaves a terminal record, never running, when the controller is aborted mid-run', async () => {
    const stateDir = await makeTmp();
    const { binary } = await installFake({
      FAKE_GROK_STDOUT: 'started',
      FAKE_GROK_SLEEP_MS: '10000',
    });
    const config = isolatedConfig(stateDir, binary, { GROK_MCP_TIMEOUT_MS: '15000' });
    const runId = await seedRun(stateDir, { prompt: 'hi' });
    const controller = new AbortController();
    const job = runJob({ stateDir, runId, config, signal: controller.signal });
    controller.abort();
    const state = await job;

    assert.notEqual(state, 'running');
    const record = await readRun(stateDir, runId);
    assert.ok(record);
    assert.notEqual(record.state, 'running');
    assert.ok(['failed', 'cancelled', 'completed', 'abandoned'].includes(record.state));
  });

  it('writes a failed record when input.json is missing, rather than exiting without a terminal state', async () => {
    const stateDir = await makeTmp();
    const { binary } = await installFake();
    const config = isolatedConfig(stateDir, binary);
    const runId = await seedRun(stateDir, { prompt: 'hi' });
    await rm(path.join(stateDir, 'runs', runId, 'input.json'));

    const state = await runJob({
      stateDir,
      runId,
      config,
      signal: new AbortController().signal,
    });

    assert.equal(state, 'failed');
    const record = await readRun(stateDir, runId);
    assert.ok(record);
    assert.equal(record.state, 'failed');
    assert.ok(record.error);
    assert.match(record.error, /input file/);
  });

  it('stores a cut-off grok run as completed with stopReason cancelled, keeping the foreground isError', async () => {
    const stateDir = await makeTmp();
    const { binary } = await installFake({
      FAKE_GROK_STDOUT:
        '{"type":"text","data":"I\'ll start"}\n' +
        '{"type":"end","stopReason":"cancelled","sessionId":"00000000-0000-7000-8000-000000000001"}\n',
    });
    const config = isolatedConfig(stateDir, binary);
    const runId = await seedRun(stateDir, { prompt: 'hi' });
    const state = await runJob({
      stateDir,
      runId,
      config,
      signal: new AbortController().signal,
    });

    assert.equal(state, 'completed');
    const record = await readRun(stateDir, runId);
    assert.ok(record);
    assert.equal(record.state, 'completed');
    assert.equal(record.stopReason, 'cancelled');
    assert.ok(record.result);
    assert.equal(record.result.isError, false);
    assert.match(record.result.text, /stopped early/);
  });
});

describe('retention sweep', () => {
  it('deletes only terminal directories, respects the cap, and survives an unreadable one', async () => {
    const stateDir = await makeTmp();
    const now = Date.parse('2026-08-17T12:00:00.000Z');

    const keepNew = await createRun({
      stateDir,
      runId: 'zzz00003-0ee0bee0',
      tool: 'grok',
      summary: 'keep',
      cwd: '/tmp',
      input: { prompt: 'a' },
    });
    const dropCap = await createRun({
      stateDir,
      runId: 'zzz00002-da0ca000',
      tool: 'grok',
      summary: 'drop cap',
      cwd: '/tmp',
      input: { prompt: 'b' },
    });
    const live = await createRun({
      stateDir,
      runId: 'zzz00001-111e0000',
      tool: 'grok',
      summary: 'live',
      cwd: '/tmp',
      input: { prompt: 'c' },
    });
    const unreadable = await createRun({
      stateDir,
      runId: 'zzz00000-0baeadab',
      tool: 'grok',
      summary: 'bad',
      cwd: '/tmp',
      input: { prompt: 'd' },
    });

    for (const id of [keepNew.runId, dropCap.runId]) {
      const claim = await claimTerminal(stateDir, id, 'test');
      assert.equal(claim.kind, 'claimed');
      await writeTerminal(stateDir, id, {
        state: 'completed',
        endedAt: '2026-08-17T12:00:00.000Z',
      });
    }

    await writeFile(path.join(stateDir, 'runs', unreadable.runId, 'record.json'), 'not json');

    await sweepRetainedRuns({
      stateDir,
      now,
      maxRetained: 1,
      retentionMs: 14 * 24 * 60 * 60 * 1000,
      deleteCap: 50,
    });

    assert.ok(await readRun(stateDir, keepNew.runId));
    assert.equal(await readRun(stateDir, dropCap.runId), null);
    assert.ok(await readRun(stateDir, live.runId));
    assert.equal(await readRun(stateDir, unreadable.runId), null);
    const stillThere = await readFile(
      path.join(stateDir, 'runs', unreadable.runId, 'record.json'),
      'utf8',
    );
    assert.equal(stillThere, 'not json');
  });

  it('deletes a non-terminal orphan older than retentionMs and keeps a recent one', async () => {
    const stateDir = await makeTmp();
    const now = Date.parse('2026-08-17T12:00:00.000Z');

    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = dead.pid;
    assert.ok(typeof deadPid === 'number');
    await new Promise<void>((resolve, reject) => {
      dead.once('error', (error) => {
        reject(error);
      });
      dead.once('exit', () => {
        resolve();
      });
    });

    const oldMs = Date.UTC(2026, 6, 1);
    const stale = await createRun({
      stateDir,
      runId: newRunId(oldMs, () => '57a1e0a0'),
      tool: 'grok',
      summary: 'stale orphan',
      cwd: '/tmp',
      input: { prompt: 'a' },
    });
    const recent = await createRun({
      stateDir,
      runId: newRunId(now, () => 'aece070a'),
      tool: 'grok',
      summary: 'recent orphan',
      cwd: '/tmp',
      input: { prompt: 'b' },
    });
    await patchRun(stateDir, stale.runId, { state: 'running', workerPid: deadPid });
    await patchRun(stateDir, recent.runId, { state: 'running', workerPid: deadPid });

    const stalePath = path.join(stateDir, 'runs', stale.runId, 'record.json');
    const raw = JSON.parse(await readFile(stalePath, 'utf8')) as Record<string, unknown>;
    raw['createdAt'] = new Date(oldMs).toISOString();
    await writeFile(stalePath, `${JSON.stringify(raw, null, 2)}\n`);

    await sweepRetainedRuns({
      stateDir,
      now,
      maxRetained: 200,
      retentionMs: 14 * 24 * 60 * 60 * 1000,
      deleteCap: 50,
    });

    assert.equal(await readRun(stateDir, stale.runId), null);
    const kept = await readRun(stateDir, recent.runId);
    assert.ok(kept);
    assert.equal(kept.state, 'running');
  });
});
