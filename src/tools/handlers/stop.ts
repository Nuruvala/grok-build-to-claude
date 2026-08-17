/**
 * `stop` — terminate a background run's process tree.
 *
 * Claim the terminal transition before sending any signal. Killing first
 * would shoot a worker that had already produced a result between finishing
 * and claiming, and the record would be a coin flip. Claiming first makes
 * the outcome a single atomic decision; the cost — a run that genuinely
 * completed in the microseconds after the claim is recorded as `cancelled` —
 * is exactly the case the late-result sidecar preserves the result for.
 */

import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { elapsedMs, formatElapsed, formatTimestamp } from '../../jobs/format.js';
import { processAlive, terminateRun, type KillOutcome } from '../../jobs/kill.js';
import { isTerminal, type RunRecord, type StoredResult } from '../../jobs/record.js';
import {
  claimTerminal,
  readLateResult,
  readRun,
  readWorkerPid,
  releaseClaim,
  writeTerminal,
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

export const LATE_RESULT_WAIT_MS = 1500;
const LATE_RESULT_POLL_MS = 100;

const StopInput = z.object({
  runId: z
    .string()
    .min(1)
    .describe('The runId returned by a background `grok`, `review`, or `websearch` call.'),
});

type StopInput = z.output<typeof StopInput>;

export const stopTool = defineTool({
  name: 'stop',
  title: 'Stop a background run',
  description:
    'Terminate a background `grok`, `review`, or `websearch` run: the worker and the grok process it ' +
    'spawned. Stopping an already-finished run is not an error. A run cancelled mid-flight ' +
    'may still have produced a resumable session id, which the result reports.',
  schema: StopInput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (input: StopInput, ctx: ToolContext): Promise<ToolResult> => {
    const { runId } = input;
    const { stateDir } = ctx.config;

    const record = await readRun(stateDir, runId);
    if (record === null) {
      return stopResult({
        text:
          `No background run with id "${runId}" was found in ${stateDir}.\n\n` +
          'Call status with no arguments to list what is there.',
        meta: { runId, found: false, stateDir },
        ctx,
      });
    }

    if (isTerminal(record.state)) {
      return await alreadyDoneResult(record, ctx, 'already-terminal');
    }

    const claim = await claimTerminal(stateDir, runId, 'stop');
    if (claim.kind === 'lost') {
      // Killing after a natural completion would only hit a recycled pid.
      // A still-running record here means another claimant is mid-finalize
      // — signalling it would destroy the result it is writing.
      const current = claim.record ?? (await readRun(stateDir, runId));
      if (current === null) {
        return stopResult({
          text:
            `No background run with id "${runId}" was found in ${stateDir}.\n\n` +
            'Call status with no arguments to list what is there.',
          meta: { runId, found: false, stateDir },
          ctx,
        });
      }
      return await alreadyDoneResult(current, ctx, 'lost-claim');
    }

    const workerPid = record.workerPid ?? (await readWorkerPid(stateDir, runId));
    const kill = await terminateRun(workerPid);

    if (kill.reason === 'no-pid' || kill.reason === 'not-permitted' || kill.reason === 'survived') {
      // An un-stoppable run that still reads `running` is honest and
      // retryable; a `cancelled` record next to a live process is neither.
      await releaseClaim(stateDir, runId);
      return unstoppableResult(record, kill, workerPid, ctx);
    }

    const endedAt = new Date().toISOString();
    const error = describeKill(kill, workerPid);

    let written: RunRecord | null;
    try {
      written = await writeTerminal(stateDir, runId, {
        state: 'cancelled',
        endedAt,
        error,
      });
    } catch (writeError: unknown) {
      await releaseClaim(stateDir, runId);
      throw writeError;
    }

    const cancelled = written ?? {
      ...record,
      state: 'cancelled' as const,
      endedAt,
      error,
    };

    const late = await waitForLateResult(stateDir, runId, ctx.signal, workerPid);
    // After the late-result wait, not before. That wait already gives
    // grok time to finish writing summary.json, and it costs nothing extra.
    return await cancelledResult(cancelled, kill, late, workerPid, ctx);
  },
});

async function waitForLateResult(
  stateDir: string,
  runId: string,
  signal: AbortSignal,
  workerPid: number | null,
): Promise<StoredResult | null> {
  const deadline = Date.now() + LATE_RESULT_WAIT_MS;
  while (!signal.aborted) {
    const late = await readLateResult(stateDir, runId);
    if (late !== null) return late;
    // Only the worker writes late-result.json, so once the worker is gone
    // nobody will ever write it. Keep the full wait when there is no pid
    // to check. The final read is not paranoia: without it, a worker that
    // wrote the sidecar in the instant before dying is indistinguishable
    // from one that never wrote it, and the result this file exists to
    // preserve would be dropped.
    if (workerPid !== null && !processAlive(workerPid)) {
      return await readLateResult(stateDir, runId);
    }
    if (Date.now() >= deadline) return null;
    try {
      await delay(LATE_RESULT_POLL_MS, undefined, { signal });
    } catch {
      return null;
    }
  }
  return null;
}

async function alreadyDoneResult(
  record: RunRecord,
  ctx: ToolContext,
  why: 'already-terminal' | 'lost-claim',
): Promise<ToolResult> {
  const elapsed = formatElapsed(elapsedMs(record, Date.now()));
  const ended = formatTimestamp(record.endedAt);

  if (why === 'lost-claim' && !isTerminal(record.state)) {
    const text =
      `Run ${record.runId} is still ${record.state}; another process holds the terminal ` +
      'claim and is finalizing it. No signals were sent, because killing another claimant ' +
      'mid-finalize would destroy the result it is in the middle of writing.';
    return stopResult({
      text,
      meta: {
        runId: record.runId,
        state: record.state,
        tool: record.tool,
        endedAt: record.endedAt,
        signalsSent: [],
        workerPid: record.workerPid,
        found: true,
        claimedByOther: true,
      },
      ctx,
    });
  }

  const lead =
    why === 'lost-claim'
      ? `Run ${record.runId} completed before the stop landed (${record.state}, ran ${elapsed}).`
      : `Run ${record.runId} was already ${record.state} (ran ${elapsed}, ended ${ended}).`;

  const late = await readLateResult(ctx.config.stateDir, record.runId);
  const knownSession =
    record.sessionId ??
    sessionIdFromMeta(record.result?.meta ?? null) ??
    sessionIdFromMeta(late?.meta ?? null);
  const resolved = await resolveSessionFor(record, knownSession, ctx);

  const lines = [lead];
  // Surface a previous kill failure so the caller learns the tree may
  // still be up. Do not re-signal the recorded pid — pids are recycled,
  // and killing a stranger is worse than reporting an honest unknown.
  if (why === 'already-terminal' && record.error !== null && record.error !== '') {
    lines.push('', record.error);
  }
  const sessionId = sessionIdOf(resolved);
  if (late !== null && record.state === 'cancelled') {
    appendLateResult(lines, late, sessionId);
  }
  const extra = sessionResolutionLines(resolved, late === null || record.state !== 'cancelled');
  if (extra.length > 0) {
    lines.push('', ...extra);
  }

  const meta: Record<string, unknown> = {
    runId: record.runId,
    state: record.state,
    tool: record.tool,
    endedAt: record.endedAt,
    signalsSent: [],
    workerPid: record.workerPid,
    found: true,
    ...sessionResolutionMeta(resolved),
  };
  if (late !== null && record.state === 'cancelled') {
    meta['lateResult'] = lateMeta(late);
  }
  if (why === 'already-terminal' && record.error !== null && record.error !== '') {
    meta['error'] = record.error;
  }

  return stopResult({
    text: lines.join('\n'),
    meta,
    ctx,
  });
}

async function cancelledResult(
  record: RunRecord,
  kill: KillOutcome,
  late: StoredResult | null,
  workerPid: number | null,
  ctx: ToolContext,
): Promise<ToolResult> {
  const elapsed = formatElapsed(elapsedMs(record, Date.now()));
  const lines = [
    `Stopped run ${record.runId} (${record.tool}, ran ${elapsed}).`,
    describeKill(kill, workerPid),
  ];

  const knownSession = sessionIdFromMeta(late?.meta ?? null) ?? record.sessionId;
  const resolved = await resolveSessionFor(record, knownSession, ctx);
  const sessionId = sessionIdOf(resolved);
  if (late !== null) {
    appendLateResult(lines, late, sessionId);
  }
  const extra = sessionResolutionLines(resolved, late === null);
  if (extra.length > 0) {
    lines.push('', ...extra);
  }

  const meta: Record<string, unknown> = {
    runId: record.runId,
    state: record.state,
    tool: record.tool,
    endedAt: record.endedAt,
    signalsSent: [...kill.signalsSent],
    killReason: kill.reason,
    workerPid,
    found: true,
    alive: kill.alive,
    ...sessionResolutionMeta(resolved),
  };
  if (late !== null) {
    meta['lateResult'] = lateMeta(late);
  }

  return stopResult({ text: lines.join('\n'), meta, ctx });
}

async function resolveSessionFor(
  record: RunRecord,
  knownSessionId: string | null,
  ctx: ToolContext,
): Promise<CancelledSession> {
  if (record.state !== 'cancelled' && knownSessionId !== null) {
    return { kind: 'result', sessionId: knownSessionId };
  }
  if (record.state !== 'cancelled') {
    return { kind: 'none' };
  }
  return await resolveCancelledSession({
    knownSessionId,
    sessionsDir: ctx.config.sessionsDir,
    cwd: record.cwd,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  });
}

function sessionIdOf(resolved: CancelledSession): string | null {
  return resolved.kind === 'result' || resolved.kind === 'store' ? resolved.sessionId : null;
}

function unstoppableResult(
  record: RunRecord,
  kill: KillOutcome,
  workerPid: number | null,
  ctx: ToolContext,
): ToolResult {
  const elapsed = formatElapsed(elapsedMs(record, Date.now()));
  const text = [
    `Could not stop run ${record.runId} (${record.tool}, ran ${elapsed}).`,
    describeKill(kill, workerPid),
    `The record is still ${record.state}. Retry stop once the pid is findable, or reap the process by hand.`,
  ].join('\n');

  return stopResult({
    text,
    meta: {
      runId: record.runId,
      state: record.state,
      tool: record.tool,
      endedAt: record.endedAt,
      signalsSent: [...kill.signalsSent],
      killReason: kill.reason,
      workerPid,
      found: true,
      alive: kill.alive,
    },
    ctx,
    isError: true,
  });
}

function appendLateResult(lines: string[], late: StoredResult, sessionId: string | null): void {
  if (sessionId !== null) {
    lines.push(
      '',
      'The run was cancelled mid-flight, but it recorded a session before it ended:',
      `  ${resumeCommand(sessionId)}`,
    );
  } else {
    lines.push('', 'The run was cancelled mid-flight, but it still produced a result.');
  }
  const spend = formatSpend(late.meta);
  if (spend.length > 0) {
    lines.push(...spend);
  }
}

function lateMeta(late: StoredResult): Record<string, unknown> {
  const sessionId = sessionIdFromMeta(late.meta);
  return {
    ...late.meta,
    ...(sessionId !== null ? { sessionId } : {}),
    isError: late.isError,
  };
}

function formatSpend(meta: Readonly<Record<string, unknown>>): string[] {
  const lines: string[] = [];
  const usage = meta['usage'];
  if (usage !== undefined) {
    lines.push(`  usage: ${JSON.stringify(usage)}`);
  }
  const cost = meta['total_cost_usd'];
  if (typeof cost === 'number') {
    lines.push(`  total_cost_usd: ${cost}`);
  }
  return lines;
}

function describeKill(kill: KillOutcome, workerPid: number | null): string {
  const target =
    workerPid === null
      ? 'no recorded worker pid'
      : process.platform === 'win32'
        ? `process ${workerPid}`
        : `process group ${workerPid}`;

  switch (kill.reason) {
    case 'no-pid':
      return 'No worker pid was recorded, so no process was signalled.';
    case 'gone':
      return 'The worker process was already gone.';
    case 'terminated':
      return `Signalled SIGTERM to ${target}; the tree exited.`;
    case 'killed':
      return `Signalled SIGTERM then SIGKILL to ${target}; the tree exited.`;
    case 'survived':
      return `Signalled SIGTERM then SIGKILL to ${target}; process ${workerPid} is still running.`;
    case 'not-permitted':
      return `Could not signal ${target}: not permitted. The process is still running.`;
    default: {
      const unreachable: never = kill.reason;
      throw new Error(`unhandled kill reason: ${String(unreachable)}`);
    }
  }
}

function sessionIdFromMeta(meta: Readonly<Record<string, unknown>> | null): string | null {
  if (meta === null) return null;
  const value = meta['sessionId'];
  return typeof value === 'string' && value !== '' ? value : null;
}

function stopResult(payload: {
  readonly text: string;
  readonly meta: Record<string, unknown>;
  readonly ctx: ToolContext;
  readonly isError?: boolean | undefined;
}): ToolResult {
  const meta = Object.freeze(payload.meta);
  const result: ToolResult = {
    content: [{ type: 'text', text: payload.text, _meta: meta }],
    isError: payload.isError === true,
  };
  if (payload.ctx.config.structuredContentEnabled) {
    result.structuredContent = meta;
  }
  return result;
}
