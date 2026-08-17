import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { claimTerminal, createRun, writeLateResult, writeTerminal } from '../../src/jobs/store.js';
import { statusTool } from '../../src/tools/handlers/status.js';
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

const tmpDirs: string[] = [];

async function makeState(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-status-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function ctxFor(stateDir: string, extra: Record<string, string> = {}): ToolContext {
  return {
    config: loadConfig({
      HOME: '/tmp/grok-mcp-test-home',
      GROK_MCP_STATE_DIR: stateDir,
      GROK_MCP_LOG_LEVEL: 'error',
      ...extra,
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

  it('shows a late result under the cancellation header and never as a completed run', async () => {
    const stateDir = await makeState();
    await seedTerminal(stateDir, 'mtest0006-latexxxx', {
      state: 'cancelled',
      endedAt: '2026-08-17T12:00:00.000Z',
      error: 'Signalled SIGTERM to process group 1; the tree exited.',
    });
    await writeLateResult(stateDir, 'mtest0006-latexxxx', {
      text: 'paid-for fragment',
      meta: {
        sessionId: '01a00c8d-970c-7531-8a12-31dac582c22b',
        usage: { input_tokens: 9 },
        total_cost_usd: 0.02,
      },
      isError: false,
    });

    const result = await statusTool.handler({ runId: 'mtest0006-latexxxx' }, ctxFor(stateDir));
    assert.notEqual(result.isError, true);
    assert.equal(metaOf(result)['state'], 'cancelled');
    assert.match(textOf(result), /This run was cancelled/);
    assert.match(textOf(result), /also produced a result before it died/);
    assert.match(textOf(result), /paid-for fragment/);
    assert.doesNotMatch(textOf(result), /^completed/m);
    const late = metaOf(result)['lateResult'];
    assert.ok(late !== undefined && typeof late === 'object' && late !== null);
    assert.equal(
      (late as Record<string, unknown>)['sessionId'],
      '01a00c8d-970c-7531-8a12-31dac582c22b',
    );
  });

  it('renders a stored result under the cancellation header and never as a completed run', async () => {
    const stateDir = await makeState();
    await seedTerminal(stateDir, 'mtest0007-storedxx', {
      state: 'cancelled',
      endedAt: '2026-08-17T12:00:00.000Z',
      error: 'Signalled SIGTERM to process group 1; the tree exited.',
      result: {
        text: 'PARTIAL ANSWER WORTH KEEPING',
        meta: { sessionId: 'abc' },
        isError: false,
      },
    });

    const result = await statusTool.handler({ runId: 'mtest0007-storedxx' }, ctxFor(stateDir));
    assert.notEqual(result.isError, true);
    assert.equal(metaOf(result)['state'], 'cancelled');
    assert.match(textOf(result), /This run was cancelled/);
    assert.match(textOf(result), /also produced a result before it died/);
    assert.match(textOf(result), /PARTIAL ANSWER WORTH KEEPING/);
    assert.doesNotMatch(textOf(result), /^completed/m);
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

describe('status recovers a cancelled run session from the store', () => {
  it('reports a single store match with a resume command and sessionIdSource store', async () => {
    await withSessionsStore(async (store) => {
      const stateDir = await makeState();
      const sessionId = '01a010d3-9ab8-7d60-909d-f00f2c13067a';
      await store.add({
        id: sessionId,
        cwd: '/tmp',
        summary: sessionSummary(sessionId, '/tmp', '2026-08-17T12:00:10.000Z'),
      });
      await seedTerminal(stateDir, 'mtest0010-onestore', {
        state: 'cancelled',
        startedAt: '2026-08-17T12:00:00.000Z',
        endedAt: '2026-08-17T12:00:20.000Z',
      });

      const result = await statusTool.handler(
        { runId: 'mtest0010-onestore' },
        ctxFor(stateDir, { GROK_HOME: store.home }),
      );
      assert.notEqual(result.isError, true);
      assert.equal(metaOf(result)['sessionId'], sessionId);
      assert.equal(metaOf(result)['sessionIdSource'], 'store');
      assert.match(textOf(result), /Resume with:/);
      assert.match(textOf(result), new RegExp(`grok -r ${sessionId}`));
    });
  });

  it('reports neither id and sets sessionCandidates when two store matches share the window', async () => {
    await withSessionsStore(async (store) => {
      const stateDir = await makeState();
      const first = '01a010aa-1111-7000-8000-000000000001';
      const second = '01a010bb-2222-7000-8000-000000000002';
      await store.add({
        id: first,
        cwd: '/tmp',
        summary: sessionSummary(first, '/tmp', '2026-08-17T12:00:08.000Z'),
      });
      await store.add({
        id: second,
        cwd: '/tmp',
        summary: sessionSummary(second, '/tmp', '2026-08-17T12:00:12.000Z'),
      });
      await seedTerminal(stateDir, 'mtest0011-twostore', {
        state: 'cancelled',
        startedAt: '2026-08-17T12:00:00.000Z',
        endedAt: '2026-08-17T12:00:20.000Z',
      });

      const result = await statusTool.handler(
        { runId: 'mtest0011-twostore' },
        ctxFor(stateDir, { GROK_HOME: store.home }),
      );
      assert.notEqual(result.isError, true);
      assert.equal(metaOf(result)['sessionId'], null);
      assert.deepEqual(metaOf(result)['sessionCandidates'], [first, second]);
      assert.match(textOf(result), /could not be identified uniquely/);
      assert.doesNotMatch(textOf(result), /Resume with:/);
    });
  });

  it('adds nothing to the body when the store has zero matches', async () => {
    await withSessionsStore(async (store) => {
      const stateDir = await makeState();
      const outsider = '01a010cc-3333-7000-8000-000000000003';
      await store.add({
        id: outsider,
        cwd: '/tmp',
        summary: sessionSummary(outsider, '/tmp', '2026-08-17T11:00:00.000Z'),
      });
      await seedTerminal(stateDir, 'mtest0012-zerostor', {
        state: 'cancelled',
        startedAt: '2026-08-17T12:00:00.000Z',
        endedAt: '2026-08-17T12:00:20.000Z',
      });

      const result = await statusTool.handler(
        { runId: 'mtest0012-zerostor' },
        ctxFor(stateDir, { GROK_HOME: store.home }),
      );
      assert.notEqual(result.isError, true);
      assert.equal(metaOf(result)['sessionId'], null);
      assert.equal(metaOf(result)['sessionCandidates'], undefined);
      assert.doesNotMatch(textOf(result), /Resume with:/);
      assert.doesNotMatch(textOf(result), /could not be identified uniquely/);
      assert.doesNotMatch(textOf(result), new RegExp(outsider));
    });
  });

  it('lets a session id from a real end event win over the store, with sessionIdSource result', async () => {
    await withSessionsStore(async (store) => {
      const stateDir = await makeState();
      const fromEnd = '01a00c8d-970c-7531-8a12-31dac582c22b';
      const fromStore = '01a010d3-9ab8-7d60-909d-f00f2c13067a';
      await store.add({
        id: fromStore,
        cwd: '/tmp',
        summary: sessionSummary(fromStore, '/tmp', '2026-08-17T12:00:10.000Z'),
      });
      await seedTerminal(stateDir, 'mtest0013-endwins', {
        state: 'cancelled',
        startedAt: '2026-08-17T12:00:00.000Z',
        endedAt: '2026-08-17T12:00:20.000Z',
      });
      await writeLateResult(stateDir, 'mtest0013-endwins', {
        text: 'paid-for fragment',
        meta: { sessionId: fromEnd },
        isError: false,
      });

      const result = await statusTool.handler(
        { runId: 'mtest0013-endwins' },
        ctxFor(stateDir, { GROK_HOME: store.home }),
      );
      assert.notEqual(result.isError, true);
      assert.equal(metaOf(result)['sessionId'], fromEnd);
      assert.equal(metaOf(result)['sessionIdSource'], 'result');
      assert.match(textOf(result), new RegExp(fromEnd));
      assert.doesNotMatch(textOf(result), new RegExp(fromStore));
    });
  });
});
