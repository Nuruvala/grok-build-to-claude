import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { isMainModule, parseRunnerArgv } from '../../src/jobs/runner.js';
import { resolveRunnerLaunch } from '../../src/jobs/spawn.js';
import { isTerminal, type RunRecord } from '../../src/jobs/record.js';
import { createRun, listRuns, patchRun, readRun, runDir } from '../../src/jobs/store.js';
import { grokTool } from '../../src/tools/handlers/grok.js';
import { statusTool } from '../../src/tools/handlers/status.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));
const STREAM_HAPPY = fileURLToPath(new URL('../fixtures/stream-happy.ndjson', import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const tmpDirs: string[] = [];
const trackedPids = new Set<number>();

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-bg-'));
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

  for (const dir of tmpDirs) {
    try {
      const listed = await listRuns(dir, 100);
      for (const record of listed.records) {
        if (record.workerPid !== null) killPid(record.workerPid);
      }
    } catch {
      /* store may already be gone */
    }
  }
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function installFake(script: Record<string, string> = {}): Promise<string> {
  const dir = await makeTmp();
  const binary = path.join(dir, 'grok');
  const env = { ...script };
  const assignments = Object.entries(env)
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
    await delay(40);
  }
  const last = await readRun(stateDir, runId);
  assert.fail(
    `run ${runId} did not terminate within ${timeoutMs}ms (last state=${last?.state ?? 'missing'})`,
  );
}

describe('parseRunnerArgv', () => {
  it('reads --run-id and --state-dir and rejects a missing pair', () => {
    assert.deepEqual(parseRunnerArgv(['--run-id', 'abc', '--state-dir', '/tmp/s']), {
      runId: 'abc',
      stateDir: '/tmp/s',
    });
    assert.equal(parseRunnerArgv(['--run-id', 'abc']), null);
    assert.equal(parseRunnerArgv([]), null);
  });

  it('rejects a flag-shaped value so --run-id --state-dir /x is not a run id of --state-dir', () => {
    assert.equal(parseRunnerArgv(['--run-id', '--state-dir', '/x']), null);
    assert.equal(parseRunnerArgv(['--state-dir', '--run-id', 'abc']), null);
  });
});

describe('isMainModule', () => {
  it('treats an entry reached through a symlink as the main module', async () => {
    const dir = await makeTmp();
    const runnerUrl = new URL('../../src/jobs/runner.ts', import.meta.url);
    const realRunner = fileURLToPath(runnerUrl);
    const linkDir = path.join(dir, 'linked-jobs');
    await symlink(path.dirname(realRunner), linkDir);
    const linkedEntry = path.join(linkDir, path.basename(realRunner));
    assert.equal(isMainModule(linkedEntry, runnerUrl.href), true);
    assert.equal(isMainModule(path.join(dir, 'other.ts'), runnerUrl.href), false);
  });
});

describe('resolveRunnerLaunch', () => {
  it("picks ['--import','tsx'] for a .ts module and [] for a .js one", () => {
    const fromTs = resolveRunnerLaunch('/tmp/src/jobs/spawn.ts');
    assert.deepEqual(fromTs.nodeArgs, ['--import', 'tsx']);
    assert.equal(fromTs.runnerPath, '/tmp/src/jobs/runner.ts');

    const fromJs = resolveRunnerLaunch('/tmp/dist/jobs/spawn.js');
    assert.deepEqual(fromJs.nodeArgs, []);
    assert.equal(fromJs.runnerPath, '/tmp/dist/jobs/runner.js');
  });
});

describe('background grok', () => {
  it('returns a runId and status reaches completed with the same text a synchronous call returns', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
    });
    const config = isolatedConfig(stateDir, binary);

    const sync = await grokTool.handler(
      { prompt: 'hi' },
      {
        ...ctxFor(config),
        progressRequested: true,
      },
    );
    assert.notEqual(sync.isError, true);

    const started = await grokTool.handler({ prompt: 'hi', background: true }, ctxFor(config));
    assert.notEqual(started.isError, true);
    const runId = metaOf(started)['runId'];
    assert.equal(typeof runId, 'string');
    trackPid(metaOf(started)['workerPid'] as number | null);

    const record = await waitForTerminal(stateDir, String(runId), 15_000);
    assert.equal(record.state, 'completed');
    assert.ok(record.result);
    assert.equal(record.result.text, sync.content[0]?.text);

    const polled = await statusTool.handler({ runId: String(runId) }, ctxFor(config));
    assert.notEqual(polled.isError, true);
    assert.match(textOf(polled), new RegExp(sync.content[0]?.text ?? 'NOPE'));
    assert.equal(metaOf(polled)['state'], 'completed');
  });
});

describe('acceptance: run survives the launcher exiting', () => {
  it('completes after a short-lived node -e child exits immediately after the call resolves', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
    });
    const resultFile = path.join(stateDir, 'started.json');
    const grokUrl = pathToFileURL(path.join(REPO_ROOT, 'src/tools/handlers/grok.ts')).href;
    const configUrl = pathToFileURL(path.join(REPO_ROOT, 'src/config.ts')).href;

    const script = `
import { writeFile } from 'node:fs/promises';
import { loadConfig } from ${JSON.stringify(configUrl)};
import { grokTool } from ${JSON.stringify(grokUrl)};

const config = loadConfig(process.env);
const result = await grokTool.handler(
  { prompt: 'hi', background: true },
  {
    config,
    signal: new AbortController().signal,
    reportProgress: () => {},
    progressRequested: false,
  },
);
await writeFile(${JSON.stringify(resultFile)}, JSON.stringify(result.content[0]?._meta ?? {}));
`;

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: REPO_ROOT,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: '/tmp/grok-mcp-test-home',
          GROK_BINARY: binary,
          GROK_MCP_STATE_DIR: stateDir,
          GROK_MCP_TIMEOUT_MS: '15000',
          GROK_MCP_LOG_LEVEL: 'error',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );

    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', (error) => {
        reject(error);
      });
      child.once('exit', (code) => {
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, `launcher failed: ${Buffer.concat(stderrChunks).toString()}`);

    const started = JSON.parse(await readFile(resultFile, 'utf8')) as {
      runId?: string;
      workerPid?: number;
    };
    assert.equal(typeof started.runId, 'string');
    trackPid(started.workerPid);

    const record = await waitForTerminal(stateDir, started.runId ?? '', 15_000);
    assert.equal(record.state, 'completed');
    assert.ok(record.result);
    assert.match(record.result.text, /Here you go/);
  });
});

describe('acceptance: two concurrent background runs', () => {
  it('completes both with distinct records, distinct log files, and no field leakage', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
    });
    const config = isolatedConfig(stateDir, binary);

    const [first, second] = await Promise.all([
      grokTool.handler({ prompt: 'alpha-marker', background: true }, ctxFor(config)),
      grokTool.handler({ prompt: 'beta-marker', background: true }, ctxFor(config)),
    ]);
    const firstId = String(metaOf(first)['runId']);
    const secondId = String(metaOf(second)['runId']);
    assert.notEqual(firstId, secondId);
    trackPid(metaOf(first)['workerPid'] as number | null);
    trackPid(metaOf(second)['workerPid'] as number | null);

    const [firstRecord, secondRecord] = await Promise.all([
      waitForTerminal(stateDir, firstId, 15_000),
      waitForTerminal(stateDir, secondId, 15_000),
    ]);
    assert.equal(firstRecord.state, 'completed');
    assert.equal(secondRecord.state, 'completed');
    assert.notEqual(firstRecord.runId, secondRecord.runId);
    assert.notEqual(firstRecord.workerPid, secondRecord.workerPid);
    assert.notEqual(firstRecord.childPid, secondRecord.childPid);

    const firstProgress = path.join(runDir(stateDir, firstId), 'progress.log');
    const secondProgress = path.join(runDir(stateDir, secondId), 'progress.log');
    assert.notEqual(firstProgress, secondProgress);
    const firstText = await readFile(firstProgress, 'utf8');
    const secondText = await readFile(secondProgress, 'utf8');
    assert.ok(firstText.length > 0);
    assert.ok(secondText.length > 0);
    assert.ok(!JSON.stringify(firstRecord).includes(secondId));
    assert.ok(!JSON.stringify(secondRecord).includes(firstId));
  });
});

describe('status orphan and wait', () => {
  it('reports abandoned without writing when the worker pid is certainly free', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const config = isolatedConfig(stateDir, binary);

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

    const created = await createRun({
      stateDir,
      runId: 'orphan01-deadbeef',
      tool: 'grok',
      summary: 'ghost',
      cwd: '/tmp',
      input: { prompt: 'hi' },
    });
    await patchRun(stateDir, created.runId, { state: 'running', workerPid: deadPid });

    const result = await statusTool.handler({ runId: created.runId }, ctxFor(config));
    assert.equal(result.isError, true);
    assert.equal(metaOf(result)['state'], 'abandoned');
    assert.match(textOf(result), /no longer exists/);
    assert.match(textOf(result), /This run was abandoned/);

    const persisted = await readRun(stateDir, created.runId);
    assert.ok(persisted);
    assert.equal(persisted.state, 'running');

    const listed = await statusTool.handler({}, ctxFor(config));
    assert.match(textOf(listed), /abandoned/);
    const listedAgain = await readRun(stateDir, created.runId);
    assert.equal(listedAgain?.state, 'running');
  });

  it('returns as soon as the run finishes when waitMs is set', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: STREAM_HAPPY,
    });
    const config = isolatedConfig(stateDir, binary);
    const started = await grokTool.handler({ prompt: 'hi', background: true }, ctxFor(config));
    const runId = String(metaOf(started)['runId']);
    trackPid(metaOf(started)['workerPid'] as number | null);

    const result = await statusTool.handler({ runId, waitMs: 30_000 }, ctxFor(config));
    assert.notEqual(result.isError, true);
    assert.equal(metaOf(result)['state'], 'completed');
    assert.match(textOf(result), /Here you go/);
  });

  it('returns the non-terminal state without erroring when the wait deadline passes first', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const config = isolatedConfig(stateDir, binary);
    const created = await createRun({
      stateDir,
      runId: 'wait0001-stillrun',
      tool: 'grok',
      summary: 'waiting',
      cwd: '/tmp',
      input: { prompt: 'hi' },
    });
    await patchRun(stateDir, created.runId, { state: 'running', workerPid: process.pid });

    const result = await statusTool.handler({ runId: created.runId, waitMs: 200 }, ctxFor(config));
    assert.notEqual(result.isError, true);
    assert.equal(metaOf(result)['state'], 'running');
    assert.doesNotMatch(textOf(result), /Here you go/);
  });
});
