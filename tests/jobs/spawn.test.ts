import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { TooManyRunsError } from '../../src/errors.js';
import { STARTUP_GRACE_MS } from '../../src/jobs/liveness.js';
import { newRunId } from '../../src/jobs/record.js';
import { startBackgroundRun } from '../../src/jobs/spawn.js';
import { createRun, listRuns, runDir } from '../../src/jobs/store.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));

const tmpDirs: string[] = [];
const trackedPids = new Set<number>();

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-spawn-'));
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
      /* store may already be gone or unreadable */
    }
  }
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function installFake(): Promise<string> {
  const dir = await makeTmp();
  const binary = path.join(dir, 'grok');
  const source = `#!/usr/bin/env node
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
    GROK_MCP_TIMEOUT_MS: '5000',
    GROK_MCP_LOG_LEVEL: 'error',
    ...extra,
  });
}

function ctxFor(config: Config): ToolContext {
  return {
    config,
    signal: new AbortController().signal,
    reportProgress: () => {
      /* unused */
    },
    progressRequested: false,
  };
}

async function seedStarting(stateDir: string, createdAt?: string): Promise<string> {
  const created = await createRun({
    stateDir,
    runId: newRunId(Date.now()),
    tool: 'grok',
    summary: 'seed',
    cwd: '/tmp',
    input: { prompt: 'seed' },
  });
  if (createdAt !== undefined) {
    const filePath = path.join(runDir(stateDir, created.runId), 'record.json');
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    raw['createdAt'] = createdAt;
    await writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`);
  }
  return created.runId;
}

async function markCompleted(stateDir: string, runId: string): Promise<void> {
  const filePath = path.join(runDir(stateDir, runId), 'record.json');
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  raw['state'] = 'completed';
  raw['endedAt'] = new Date().toISOString();
  await writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`);
}

function start(config: Config): Promise<ToolResult> {
  return startBackgroundRun(
    { tool: 'grok', input: { prompt: 'hi' }, summary: 'hi', cwd: process.cwd() },
    ctxFor(config),
  );
}

function trackStarted(result: ToolResult): void {
  const meta = result.content[0]?._meta;
  const pid = meta?.['workerPid'];
  trackPid(typeof pid === 'number' ? pid : null);
}

describe('startBackgroundRun concurrent-run cap', () => {
  it('starts a run when the live count is below the cap', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const config = isolatedConfig(stateDir, binary, { GROK_MCP_MAX_CONCURRENT_RUNS: '4' });

    const result = await start(config);
    trackStarted(result);
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0]?._meta?.['state'], 'starting');
  });

  it('throws TooManyRunsError when the live count is already at the cap', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const config = isolatedConfig(stateDir, binary, { GROK_MCP_MAX_CONCURRENT_RUNS: '1' });
    await seedStarting(stateDir);

    await assert.rejects(
      () => start(config),
      (error: unknown) => {
        assert.ok(error instanceof TooManyRunsError);
        assert.match(error.message, /1 already live/);
        assert.match(error.message, /cap is 1/);
        assert.ok(error.details);
        assert.equal(error.details['live'], 1);
        assert.equal(error.details['cap'], 1);
        return true;
      },
    );
  });

  it('never throws TooManyRunsError when the cap is null', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const config = isolatedConfig(stateDir, binary, { GROK_MCP_MAX_CONCURRENT_RUNS: 'unlimited' });
    await seedStarting(stateDir);
    await seedStarting(stateDir);
    await seedStarting(stateDir);
    await seedStarting(stateDir);
    await seedStarting(stateDir);

    const result = await start(config);
    trackStarted(result);
    assert.notEqual(result.isError, true);
  });

  it('does not count terminal or orphaned records toward the cap', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    const config = isolatedConfig(stateDir, binary, { GROK_MCP_MAX_CONCURRENT_RUNS: '1' });

    const finished = await seedStarting(stateDir);
    await markCompleted(stateDir, finished);

    await seedStarting(stateDir, new Date(Date.now() - STARTUP_GRACE_MS - 1).toISOString());

    const result = await start(config);
    trackStarted(result);
    assert.notEqual(result.isError, true);
  });

  it('proceeds rather than failing closed when the store cannot be read', async () => {
    const stateDir = await makeTmp();
    const binary = await installFake();
    await writeFile(path.join(stateDir, 'runs'), 'not a directory');
    const config = isolatedConfig(stateDir, binary, { GROK_MCP_MAX_CONCURRENT_RUNS: '1' });

    const result = await start(config);
    trackStarted(result);
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /Failed to start/);
  });
});
