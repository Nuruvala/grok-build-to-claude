/**
 * `status` — poll a background run, or list recent ones.
 *
 * A finished run replays the original tool result (same text, same `_meta`,
 * same `isError`). A run whose worker has vanished is reported as `abandoned`
 * rather than as still running — derived for display, never written. That
 * keeps `readOnlyHint: true` honest.
 */

import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { elapsedMs, formatRunDetail, formatRunHeader, formatRunLine } from '../../jobs/format.js';
import { displayRecord, STARTUP_GRACE_MS } from '../../jobs/liveness.js';
import { isCutOff, isTerminal, type RunRecord } from '../../jobs/record.js';
import { DEFAULT_TAIL_BYTES, listRuns, readRun, runDir, tailFile } from '../../jobs/store.js';
import { defineTool } from '../../types.js';
import type { ToolContext, ToolResult } from '../../types.js';

const DEFAULT_LIMIT = 20;
const POLL_INTERVAL_MS = 250;

const StatusInput = z
  .object({
    runId: z
      .string()
      .min(1)
      .optional()
      .describe('Id of a background run to inspect. Omit to list recent runs.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum rows to return in list mode. Default 20. Ignored when `runId` is set.'),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(120_000)
      .optional()
      .describe(
        'Block up to this many milliseconds for the run to finish. Default 0. Ignored in list mode. A timed-out wait is not an error.',
      ),
    tail: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024)
      .optional()
      .describe('Bytes of progress.log to include for a live run. Default 8192.'),
  })
  .describe('Poll a background Grok Build run.')
  .meta({ title: 'StatusInput' });

type StatusInput = z.output<typeof StatusInput>;

export const statusTool = defineTool({
  name: 'status',
  title: 'Poll a background run',
  description:
    'Poll a background `grok` or `review` run, or list recent ones. A finished run replays ' +
    'the original tool result — same text, same metadata, same error flag — so background is ' +
    'a transport, not a second implementation. A run whose worker process has vanished is ' +
    'reported as `abandoned` rather than as still running. Pass `runId` to inspect one run, ' +
    '`waitMs` to block until it finishes, and omit `runId` to list recent runs.',
  schema: StatusInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (input: StatusInput, ctx: ToolContext): Promise<ToolResult> => {
    if (input.runId === undefined) {
      return listMode(input.limit ?? DEFAULT_LIMIT, ctx);
    }
    return singleMode(input, ctx);
  },
});

async function listMode(limit: number, ctx: ToolContext): Promise<ToolResult> {
  const listed = await listRuns(ctx.config.stateDir, limit);
  const nowMs = Date.now();
  const records = listed.records.map((record) =>
    displayRecord(record, nowMs, orphanErrorText(ctx.config.stateDir, record.runId)),
  );

  if (records.length === 0 && listed.unreadable === 0 && !listed.truncated) {
    const text = 'No background runs recorded.\n\n' + `The store is at ${ctx.config.stateDir}.`;
    return statusResult({
      text,
      meta: {
        runs: [],
        count: 0,
        scanned: listed.scanned,
        unreadable: 0,
        truncated: false,
        stateDir: ctx.config.stateDir,
      },
      isError: false,
      ctx,
    });
  }

  const lines = [formatRunHeader(records.length, listed.scanned)];
  if (listed.unreadable > 0 || listed.truncated) {
    const bits: string[] = [];
    if (listed.unreadable > 0) {
      bits.push(
        `${listed.unreadable} ${listed.unreadable === 1 ? 'record was' : 'records were'} unreadable`,
      );
    }
    if (listed.truncated) {
      bits.push('listing stopped at the scan cap');
    }
    lines.push(`Partial listing from ${ctx.config.stateDir}: ${bits.join('; ')}.`);
  }
  lines.push('');
  for (const record of records) {
    lines.push(formatRunLine(record, nowMs));
  }

  return statusResult({
    text: lines.join('\n'),
    meta: {
      runs: records.map(runMeta),
      count: records.length,
      scanned: listed.scanned,
      unreadable: listed.unreadable,
      truncated: listed.truncated,
      stateDir: ctx.config.stateDir,
    },
    isError: false,
    ctx,
  });
}

async function singleMode(input: StatusInput, ctx: ToolContext): Promise<ToolResult> {
  const runId = input.runId;
  if (runId === undefined) {
    throw new Error('singleMode requires runId');
  }

  const waitMs = input.waitMs ?? 0;
  const tailBytes = input.tail ?? DEFAULT_TAIL_BYTES;
  let lastProgressCount = -1;

  const deadline = Date.now() + waitMs;
  let record = await loadForDisplay(ctx.config.stateDir, runId);

  if (record === null) {
    return statusResult({
      text:
        `No background run with id "${runId}" was found in ${ctx.config.stateDir}.\n\n` +
        'Call status with no arguments to list what is there.',
      meta: {
        runId,
        found: false,
        stateDir: ctx.config.stateDir,
      },
      isError: false,
      ctx,
    });
  }

  while (!isTerminal(record.state) && Date.now() < deadline && !ctx.signal.aborted) {
    if (record.progressCount > lastProgressCount && record.lastProgress !== null) {
      lastProgressCount = record.progressCount;
      ctx.reportProgress({
        progress: record.progressCount,
        message: record.lastProgress,
      });
    }
    try {
      await delay(POLL_INTERVAL_MS, undefined, { signal: ctx.signal });
    } catch {
      // AbortError from an abort-aware delay: the request was cancelled.
      break;
    }
    const next = await loadForDisplay(ctx.config.stateDir, runId);
    if (next === null) break;
    record = next;
  }

  if (isTerminal(record.state)) {
    return terminalResult(record, ctx);
  }

  return liveResult(record, ctx, tailBytes);
}

async function loadForDisplay(stateDir: string, runId: string): Promise<RunRecord | null> {
  const record = await readRun(stateDir, runId);
  if (record === null) return null;
  return displayRecord(record, Date.now(), orphanErrorText(stateDir, runId));
}

function orphanErrorText(stateDir: string, runId: string): string {
  const dir = runDir(stateDir, runId);
  return (
    'The worker process no longer exists. The machine or the MCP server probably restarted ' +
    `mid-run. Inspect ${path.join(dir, 'worker.log')}, ${path.join(dir, 'stdout.log')}, ` +
    `and ${path.join(dir, 'stderr.log')}.`
  );
}

function terminalResult(record: RunRecord, ctx: ToolContext): ToolResult {
  const stored = record.result;
  const header = formatRunDetail(record, Date.now());
  const body =
    stored === null ? `${resultlessLead(record)}\n\n${header}` : `${header}\n\n${stored.text}`;
  const storedMeta = stored?.meta ?? {};
  const meta = Object.freeze({
    ...storedMeta,
    ...runMeta(record),
    found: true,
  });
  return statusResult({
    text: body,
    meta,
    isError: terminalIsError(record),
    ctx,
  });
}

/**
 * True when the stored result said so, or when the run ended `failed` /
 * `abandoned`. `cancelled` stays false — a user asked for that one, and M5b
 * will say so explicitly.
 */
function terminalIsError(record: RunRecord): boolean {
  if (record.result?.isError === true) return true;
  return record.state === 'failed' || record.state === 'abandoned';
}

function resultlessLead(record: RunRecord): string {
  switch (record.state) {
    case 'failed':
      return record.error !== null && record.error !== ''
        ? `This run failed. ${record.error}`
        : 'This run failed.';
    case 'abandoned':
      return record.error !== null && record.error !== ''
        ? `This run was abandoned. ${record.error}`
        : 'This run was abandoned.';
    case 'cancelled':
      return record.error !== null && record.error !== ''
        ? `This run was cancelled. ${record.error}`
        : 'This run was cancelled.';
    case 'completed':
      return 'This run completed with no stored result.';
    case 'starting':
    case 'running':
      return `This run is ${record.state}.`;
    default: {
      const unreachable: never = record.state;
      throw new Error(`unhandled run state: ${String(unreachable)}`);
    }
  }
}

async function liveResult(
  record: RunRecord,
  ctx: ToolContext,
  tailBytes: number,
): Promise<ToolResult> {
  const header = formatRunDetail(record, Date.now());
  const progressPath = path.join(runDir(ctx.config.stateDir, record.runId), 'progress.log');
  let tail = '';
  let tailTruncated = false;
  if (tailBytes > 0) {
    const tailed = await tailFile(progressPath, tailBytes);
    tail = tailed.text;
    tailTruncated = tailed.truncated;
  }
  const parts = [header];
  if (tail !== '') {
    parts.push('', tail.endsWith('\n') ? tail.slice(0, -1) : tail);
  }
  return statusResult({
    text: parts.join('\n'),
    meta: {
      ...runMeta(record),
      found: true,
      tailTruncated,
    },
    isError: false,
    ctx,
  });
}

function runMeta(record: RunRecord): Record<string, unknown> {
  return {
    runId: record.runId,
    state: record.state,
    tool: record.tool,
    cwd: record.cwd,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    workerPid: record.workerPid,
    childPid: record.childPid,
    progressCount: record.progressCount,
    lastProgress: record.lastProgress,
    sessionId: record.sessionId,
    stopReason: record.stopReason,
    cutOff: isCutOff(record),
    summary: record.summary,
    elapsedMs: elapsedMs(record, Date.now()),
  };
}

function statusResult(payload: {
  readonly text: string;
  readonly meta: Record<string, unknown>;
  readonly isError: boolean;
  readonly ctx: ToolContext;
}): ToolResult {
  const meta = Object.freeze(payload.meta);
  const result: ToolResult = {
    content: [{ type: 'text', text: payload.text, _meta: meta }],
    isError: payload.isError,
  };
  if (payload.ctx.config.structuredContentEnabled) {
    result.structuredContent = meta;
  }
  return result;
}

export { STARTUP_GRACE_MS, POLL_INTERVAL_MS };
