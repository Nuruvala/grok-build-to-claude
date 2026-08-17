import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { claimTerminal, createRun, writeTerminal } from '../../src/jobs/store.js';
import { statusTool } from '../../src/tools/handlers/status.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

const tmpDirs: string[] = [];

async function makeState(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-status-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function ctxFor(stateDir: string): ToolContext {
  return {
    config: loadConfig({
      HOME: '/tmp/grok-mcp-test-home',
      GROK_MCP_STATE_DIR: stateDir,
      GROK_MCP_LOG_LEVEL: 'error',
    }),
    signal: new AbortController().signal,
    reportProgress: () => {
      /* unused */
    },
    progressRequested: false,
  };
}

function metaOf(result: ToolResult): Record<string, unknown> {
  const [block] = result.content;
  assert.ok(block);
  assert.ok(block._meta);
  return block._meta;
}

function textOf(result: ToolResult): string {
  const [block] = result.content;
  assert.ok(block);
  return block.text;
}

async function seedTerminal(
  stateDir: string,
  runId: string,
  patch: Parameters<typeof writeTerminal>[2],
): Promise<void> {
  await createRun({
    stateDir,
    runId,
    tool: 'grok',
    summary: 'seed',
    cwd: '/tmp',
    input: { prompt: 'hi' },
  });
  const claim = await claimTerminal(stateDir, runId, 'test');
  assert.equal(claim.kind, 'claimed');
  const written = await writeTerminal(stateDir, runId, patch);
  assert.ok(written);
}

describe('status terminal isError', () => {
  it('reports isError true for a failed record with no stored result', async () => {
    const stateDir = await makeState();
    await seedTerminal(stateDir, 'mtest0001-aaaaaaaa', {
      state: 'failed',
      endedAt: '2026-08-17T12:00:00.000Z',
      error: 'fatal: not a git repository (or any of the parent directories): .git',
    });

    const result = await statusTool.handler({ runId: 'mtest0001-aaaaaaaa' }, ctxFor(stateDir));
    assert.equal(result.isError, true);
    assert.match(textOf(result), /This run failed/);
    assert.match(textOf(result), /not a git repository/);
    assert.equal(metaOf(result)['state'], 'failed');
    assert.equal(metaOf(result)['cutOff'], false);
  });

  it('reports isError true for an abandoned record', async () => {
    const stateDir = await makeState();
    await seedTerminal(stateDir, 'mtest0002-bbbbbbbb', {
      state: 'abandoned',
      endedAt: '2026-08-17T12:00:00.000Z',
      error: 'The worker process no longer exists.',
    });

    const result = await statusTool.handler({ runId: 'mtest0002-bbbbbbbb' }, ctxFor(stateDir));
    assert.equal(result.isError, true);
    assert.match(textOf(result), /This run was abandoned/);
    assert.equal(metaOf(result)['state'], 'abandoned');
  });

  it('reports isError false for a completed record with a successful stored result', async () => {
    const stateDir = await makeState();
    await seedTerminal(stateDir, 'mtest0003-cccccccc', {
      state: 'completed',
      endedAt: '2026-08-17T12:00:00.000Z',
      stopReason: 'end_turn',
      result: { text: 'ok', meta: { stopReason: 'end_turn' }, isError: false },
    });

    const result = await statusTool.handler({ runId: 'mtest0003-cccccccc' }, ctxFor(stateDir));
    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /ok/);
    assert.equal(metaOf(result)['cutOff'], false);
    assert.equal(metaOf(result)['stopReason'], 'end_turn');
  });

  it('reports isError true for a completed record whose stored result carried isError true', async () => {
    const stateDir = await makeState();
    await seedTerminal(stateDir, 'mtest0004-dddddddd', {
      state: 'completed',
      endedAt: '2026-08-17T12:00:00.000Z',
      stopReason: 'cancelled',
      result: {
        text: 'partial\n\n[the run stopped early — stopReason: cancelled]',
        meta: { stopReason: 'cancelled' },
        isError: true,
      },
    });

    const result = await statusTool.handler({ runId: 'mtest0004-dddddddd' }, ctxFor(stateDir));
    assert.equal(result.isError, true);
    assert.equal(metaOf(result)['cutOff'], true);
    assert.equal(metaOf(result)['stopReason'], 'cancelled');
    assert.match(textOf(result), /completed \(cut off: cancelled\)/);
  });

  it('reports isError false for a cancelled record — a user asked for that one', async () => {
    const stateDir = await makeState();
    await seedTerminal(stateDir, 'mtest0005-eeeeeeee', {
      state: 'cancelled',
      endedAt: '2026-08-17T12:00:00.000Z',
    });

    const result = await statusTool.handler({ runId: 'mtest0005-eeeeeeee' }, ctxFor(stateDir));
    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /This run was cancelled/);
  });
});
