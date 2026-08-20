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
import {
  isCutOff,
  isTerminal,
  mergeProgress,
  RunIdSchema,
  type RunProgress,
  type RunRecord,
  type StoredResult,
} from '../../jobs/record.js';
import {
  DEFAULT_TAIL_BYTES,
  listRuns,
  readLateResult,
  readProgress,
  readRun,
  runDir,
  tailFile,
} from '../../jobs/store.js';
import {
  resolveCancelledSession,
  sessionResolutionLines,
  sessionResolutionMeta,
  type CancelledSession,
} from '../../sessions/recover.js';
import { resumeCommand } from '../../sessions/select.js';
import { defineTool } from '../../types.js';
import type { ToolContext, ToolResult } from '../../types.js';

const DEFAULT_LIMIT = 20;
const POLL_INTERVAL_MS = 250;

const StatusInput = z
  .strictObject({
    runId: RunIdSchema.optional().describe(
      'Id of a background run to inspect. Omit to list recent runs.',
    ),
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
    'Poll a background `grok`, `review`, or `websearch` run, or list recent ones. A finished run replays ' +
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
  const records = await Promise.all(
    listed.records.map(async (record) => {
      const progress = await readProgress(ctx.config.stateDir, record.runId);
      return {
        record: displayRecord(
          mergeProgress(record, progress),
          nowMs,
          orphanErrorText(ctx.config.stateDir, record.runId),
        ),
        progress,
      };
    }),
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
  for (const displayed of records) {
    lines.push(formatRunLine(displayed.record, nowMs));
  }

  return statusResult({
    text: lines.join('\n'),
    meta: {
      runs: records.map((displayed) => runMeta(displayed.record, displayed.progress)),
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
  let displayed = await loadForDisplay(ctx.config.stateDir, runId);

  if (displayed === null) {
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

  while (!isTerminal(displayed.record.state) && Date.now() < deadline && !ctx.signal.aborted) {
    if (
      displayed.record.progressCount > lastProgressCount &&
      displayed.record.lastProgress !== null
    ) {
      lastProgressCount = displayed.record.progressCount;
      ctx.reportProgress({
        progress: displayed.record.progressCount,
        message: displayed.record.lastProgress,
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
    displayed = next;
  }

  if (isTerminal(displayed.record.state)) {
    return await terminalResult(displayed.record, ctx);
  }

  return liveResult(displayed.record, displayed.progress, ctx, tailBytes);
}

async function loadForDisplay(
  stateDir: string,
  runId: string,
): Promise<{ record: RunRecord; progress: RunProgress | null } | null> {
  const record = await readRun(stateDir, runId);
  if (record === null) return null;
  const progress = await readProgress(stateDir, runId);
  return {
    record: displayRecord(
      mergeProgress(record, progress),
      Date.now(),
      orphanErrorText(stateDir, runId),
    ),
    progress,
  };
}

function orphanErrorText(stateDir: string, runId: string): string {
  const dir = runDir(stateDir, runId);
  return (
    'The worker process no longer exists. The machine or the MCP server probably restarted ' +
    `mid-run. Inspect ${path.join(dir, 'worker.log')}, ${path.join(dir, 'stdout.log')}, ` +
    `and ${path.join(dir, 'stderr.log')}.`
  );
}

async function terminalResult(record: RunRecord, ctx: ToolContext): Promise<ToolResult> {
  const stored = record.result;
  const header = formatRunDetail(record, Date.now());
  const late =
    record.state === 'cancelled' ? await readLateResult(ctx.config.stateDir, record.runId) : null;

  const knownSession =
    record.sessionId ??
    sessionIdFromMeta(stored?.meta ?? {}) ??
    sessionIdFromMeta(late?.meta ?? {});
  // Same helper as stop: an hour later the user looks here, not at the
  // transcript of the stop. A confirmed end-event id still wins.
  const resolved: CancelledSession =
    record.state === 'cancelled'
      ? await resolveCancelledSession({
          knownSessionId: knownSession,
          sessionsDir: ctx.config.sessionsDir,
          cwd: record.cwd,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
        })
      : { kind: 'none' };

  const body = formatTerminalBody(record, header, stored, late, resolved);
  const storedMeta = stored?.meta ?? {};
  const meta: Record<string, unknown> = {
    ...storedMeta,
    ...runMeta(record),
    ...sessionResolutionMeta(resolved),
    found: true,
  };
  if (late !== null) {
    // A cancelled run must never render as a completed one. lateResult is
    // extra evidence under the cancellation, not a replacement for it.
    meta['lateResult'] = lateResultMeta(late);
    const lateSession = sessionIdFromMeta(late.meta);
    if (lateSession !== null && (meta['sessionId'] === undefined || meta['sessionId'] === null)) {
      meta['sessionId'] = lateSession;
      if (meta['sessionIdSource'] === undefined) {
        meta['sessionIdSource'] = 'result';
      }
    }
  }
  return statusResult({
    text: body,
    meta: Object.freeze(meta),
    isError: terminalIsError(record),
    ctx,
  });
}

function formatTerminalBody(
  record: RunRecord,
  header: string,
  stored: StoredResult | null,
  late: StoredResult | null,
  resolved: CancelledSession,
): string {
  if (record.state === 'cancelled') {
    // A cancelled run must never render as a completed one, and it must
    // not silently discard what it produced either. Stored result and late
    // sidecar are evidence under the cancellation header, never in place
    // of it.
    const parts = [resultlessLead(record), '', header];
    appendCancelledEvidence(parts, stored);
    appendCancelledEvidence(parts, late);
    const evidenceHasSession =
      sessionIdFromMeta(stored?.meta ?? {}) !== null ||
      sessionIdFromMeta(late?.meta ?? {}) !== null;
    const extra = sessionResolutionLines(resolved, !evidenceHasSession);
    if (extra.length > 0) {
      parts.push('', ...extra);
    }
    return parts.join('\n');
  }
  if (stored === null) {
    return `${resultlessLead(record)}\n\n${header}`;
  }
  return `${header}\n\n${stored.text}`;
}

function appendCancelledEvidence(parts: string[], produced: StoredResult | null): void {
  if (produced === null) return;
  parts.push('', 'The run also produced a result before it died:');
  const sessionId = sessionIdFromMeta(produced.meta);
  if (sessionId !== null) {
    parts.push(`  ${resumeCommand(sessionId)}`);
  }
  if (produced.text !== '') {
    parts.push('', produced.text);
  }
}

function lateResultMeta(late: StoredResult): Record<string, unknown> {
  const sessionId = sessionIdFromMeta(late.meta);
  return {
    ...late.meta,
    ...(sessionId !== null ? { sessionId } : {}),
    isError: late.isError,
  };
}

function sessionIdFromMeta(meta: Readonly<Record<string, unknown>>): string | null {
  const value = meta['sessionId'];
  return typeof value === 'string' && value !== '' ? value : null;
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
  progress: RunProgress | null,
  ctx: ToolContext,
  tailBytes: number,
): Promise<ToolResult> {
  const header = formatRunDetail(record, Date.now(), progress);
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
      ...runMeta(record, progress),
      found: true,
      tailTruncated,
    },
    isError: false,
    ctx,
  });
}

function runMeta(record: RunRecord, progress?: RunProgress | null): Record<string, unknown> {
  const meta: Record<string, unknown> = {
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
  if (progress?.toolCalls !== undefined) {
    meta['toolCalls'] = progress.toolCalls.total;
    meta['toolCallsByLabel'] = progress.toolCalls.byLabel;
    meta['lastToolCallAt'] = progress.toolCalls.lastCallAt;
  }
  return meta;
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
