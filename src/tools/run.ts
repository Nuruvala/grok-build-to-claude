/**
 * Shared grok-run core. Handlers build argv and a `GrokRunRequest`; this module
 * owns spawn, stream progress, and the result/error envelope.
 *
 * Extracted from the `grok` handler so `review` (and later tools) share one
 * implementation of the reliability contract: a parsed result wins over a
 * non-zero exit, narration is flushed before `accept`, the debounce timer is
 * cleared in `finally`, and a partial stream never invents session metadata.
 */

import { execGrok } from '../grok/exec.js';
import type { ExecResult } from '../grok/exec.js';
import { createProgressMapper } from '../grok/progress.js';
import type { ProgressEmission } from '../grok/progress.js';
import { parseGrokJson } from '../grok/result.js';
import type { GrokRunResult, ParsedGrokOutput } from '../grok/result.js';
import { createNdjsonReader, createStreamCollector, interpretStreamLine } from '../grok/stream.js';
import type { StreamOutcome } from '../grok/stream.js';
import type { PermissionLevel } from '../permission.js';
import type { ProgressUpdate, ToolContext, ToolResult } from '../types.js';

const UNPARSEABLE_PREVIEW_CHARS = 4_000;

/**
 * Token-level `text`/`thought` deltas arrive far faster than a client can usefully render.
 * A trailing-edge debounce coalesces them; a polling interval would tick through a
 * twenty-minute tool call that is sitting still.
 */
const NARRATION_DEBOUNCE_MS = 100;

export type GrokRunMeta =
  | Readonly<Record<string, unknown>>
  | ((result: GrokRunResult) => Readonly<Record<string, unknown>>);

export interface GrokRunRequest {
  readonly args: readonly string[];
  readonly model: string | null;
  readonly permissionLevel: PermissionLevel;
  /** Extra keys merged into `content[0]._meta` on the success path. */
  readonly meta?: GrokRunMeta | undefined;
  /** Transform the model's text before it becomes the result body. Identity when omitted. */
  readonly formatText?: ((result: GrokRunResult) => string) | undefined;
  /** Decide the error flag from the parsed result. Defaults to a successful run being `isError: false`. */
  readonly isError?: ((result: GrokRunResult) => boolean) | undefined;
}

export async function runGrok(request: GrokRunRequest, ctx: ToolContext): Promise<ToolResult> {
  const stream = ctx.progressRequested ? startStreamSession(ctx.reportProgress) : undefined;

  let exec: ExecResult;
  try {
    exec = await execGrok({
      binary: ctx.config.grokBinary,
      args: request.args,
      timeoutMs: ctx.config.timeoutMs,
      signal: ctx.signal,
      ...(stream === undefined ? {} : { onStdout: stream.onStdout }),
    });
    stream?.drain();
  } finally {
    // A stray timer keeps the event loop alive after the run finishes. unref()
    // would hide the leak instead of fixing it.
    stream?.clearTimer();
  }

  if (exec.outcome === 'spawn-failed') {
    return errorResult(
      `Failed to start grok at "${ctx.config.grokBinary}".${spawnCause(exec)}\n\n` +
        'Install the grok CLI or set GROK_BINARY to its path.',
      exec,
    );
  }

  const outcome =
    stream === undefined ? parsedToStreamOutcome(parseGrokJson(exec.stdout)) : stream.outcome();

  if (exec.outcome === 'timeout') {
    return errorResult(
      `The grok run timed out after ${Math.round(exec.durationMs)} ms.\n\n` +
        'Set GROK_MCP_TIMEOUT_MS to a higher value if the run needs more time.\n' +
        buffered(exec, streamedStdout(stream, outcome, exec)),
      exec,
    );
  }

  if (exec.outcome === 'aborted') {
    return errorResult(
      `The grok run was cancelled by the client.\n${buffered(exec, streamedStdout(stream, outcome, exec))}`.trimEnd(),
      exec,
    );
  }

  // `--max-turns` exits 1 with a complete result on stdout (verified grok 1.0.0,
  // 2026-08-16). The parsed result wins over the exit code so we keep the
  // session id and the spend that produced it.
  if (outcome.kind === 'result') {
    return successResult(outcome.result, exec, request, ctx.config.structuredContentEnabled);
  }

  if (outcome.kind === 'cli-error') {
    const message = outcome.message === '' ? '(no message)' : outcome.message;
    return errorResult(`grok reported an error: ${message}\n${buffered(exec)}`.trimEnd(), exec);
  }

  if (outcome.kind === 'partial') {
    return {
      content: [
        {
          type: 'text',
          text:
            `${outcome.result.text}\n\n` +
            '[stream ended before its end event, so session id, usage, and cost are unavailable]',
          _meta: {
            outcome: exec.outcome,
            durationMs: exec.durationMs,
            exitCode: exec.code,
            // No sessionId, usage, or cost: the `end` event that would have carried them never
            // arrived. Everything here is something we knew before the run started, so
            // reporting it invents nothing.
            model: request.model,
            permissionLevel: request.permissionLevel,
          },
        },
      ],
      isError: true,
    };
  }

  if (exec.code !== 0) {
    return errorResult(`grok exited with code ${exec.code ?? 'unknown'}.\n${buffered(exec)}`, exec);
  }

  return errorResult(
    `grok returned output that is not valid JSON (${outcome.reason}).\n\n` + preview(exec.stdout),
    exec,
  );
}

/**
 * The reason the spawn failed, when the OS gave one.
 *
 * Without it every failure reads as "grok is not installed", and the advice that follows sends
 * the caller to fix something that was never broken. E2BIG (an argument past the kernel's
 * per-argument limit) and EACCES both hid behind that message until a real run hit one.
 */
function spawnCause(exec: ExecResult): string {
  const error = exec.spawnError;
  if (error === null) return '';
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
  return code === null ? ` ${error.message}` : ` ${code}: ${error.message}`;
}

interface StreamSession {
  readonly onStdout: (chunk: string) => void;
  readonly drain: () => void;
  readonly outcome: () => StreamOutcome;
  readonly clearTimer: () => void;
}

function startStreamSession(reportProgress: (update: ProgressUpdate) => void): StreamSession {
  const reader = createNdjsonReader();
  const collector = createStreamCollector();
  const mapper = createProgressMapper();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function emit(emission: ProgressEmission | null): void {
    if (emission === null) return;
    reportProgress({ progress: emission.progress, message: emission.message });
  }

  function cancelDebounce(): void {
    if (debounceTimer === undefined) return;
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }

  function handleLine(line: string): void {
    const event = interpretStreamLine(line);
    collector.accept(event);

    const narration = event.type === 'text' || event.type === 'thought';
    if (!narration) {
      // Narration buffered before this event happened before it, so flush it first. Ordering is
      // the whole point: a real run ended with `finished: end_turn` arriving ahead of the model's
      // last words, because the pending tail was only flushed after the stream drained. Flushing
      // before `accept` also keeps the progress counter monotonic — `accept` numbers its emission
      // as soon as it is called, so a flush afterwards would carry the higher number and arrive
      // second.
      cancelDebounce();
      emit(mapper.flush());
    }

    emit(mapper.accept(event));

    if (narration && debounceTimer === undefined) {
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        emit(mapper.flush());
      }, NARRATION_DEBOUNCE_MS);
    }
  }

  return {
    onStdout: (chunk) => {
      for (const line of reader.push(chunk)) {
        handleLine(line);
      }
    },
    drain: () => {
      for (const line of reader.flush()) {
        handleLine(line);
      }
      emit(mapper.flush());
    },
    outcome: () => collector.outcome(),
    clearTimer: cancelDebounce,
  };
}

function parsedToStreamOutcome(parsed: ParsedGrokOutput): StreamOutcome {
  switch (parsed.kind) {
    case 'result':
      return { kind: 'result', result: parsed.result };
    case 'cli-error':
      return { kind: 'cli-error', message: parsed.message };
    case 'unparseable':
      return { kind: 'unparseable', reason: parsed.reason };
    default: {
      const unreachable: never = parsed;
      throw new Error(`unhandled parse kind: ${String(unreachable)}`);
    }
  }
}

/**
 * What to show as "stdout" in a timeout or abort message.
 *
 * On the streaming path the raw buffer is hundreds of NDJSON lines — unreadable, and it buries the
 * output it contains — so the recovered text is shown instead. When nothing was recovered there is
 * still a run to diagnose, and stderr is empty on a streaming run, so fall back to a bounded
 * preview of the raw buffer rather than reporting a failure with no evidence at all.
 */
function streamedStdout(
  stream: StreamSession | undefined,
  outcome: StreamOutcome,
  exec: ExecResult,
): string | undefined {
  if (stream === undefined) return undefined;
  if (outcome.kind === 'result' || outcome.kind === 'partial') {
    if (outcome.result.text !== '') return outcome.result.text;
  }
  return preview(exec.stdout);
}

function successResult(
  result: GrokRunResult,
  exec: ExecResult,
  request: GrokRunRequest,
  structuredContentEnabled: boolean,
): ToolResult {
  const body = request.formatText === undefined ? result.text : request.formatText(result);
  const meta = Object.freeze({
    // Handler keys go first so the run's own keys win the merge. Spreading last would let a
    // handler shadow `sessionId` with something the CLI never reported — the exact failure
    // CLAUDE.md rule 9 forbids, and one no caller could detect from the outside.
    ...resolveMeta(request.meta, result),
    // Exactly the id the CLI reported. Never a locally generated stand-in,
    // and never the `--session-id` we may have passed for a new session.
    sessionId: result.sessionId,
    // The id we passed as `--model`, not the `modelUsage` key (`grok-4.6` vs `grok-4.6-build`).
    model: request.model,
    usage: result.usage,
    total_cost_usd: result.totalCostUsd,
    stopReason: result.stopReason,
    numTurns: result.numTurns,
    permissionLevel: request.permissionLevel,
    durationMs: exec.durationMs,
    exitCode: exec.code,
  });

  const toolResult: ToolResult = {
    content: [
      {
        type: 'text',
        text: formatResultText(body, exec.code, result.stopReason),
        _meta: meta,
      },
    ],
    isError: request.isError === undefined ? false : request.isError(result),
  };

  if (structuredContentEnabled) {
    toolResult.structuredContent = meta;
  }

  return toolResult;
}

function resolveMeta(
  meta: GrokRunMeta | undefined,
  result: GrokRunResult,
): Readonly<Record<string, unknown>> {
  if (meta === undefined) return {};
  if (typeof meta === 'function') return meta(result);
  return meta;
}

function formatResultText(
  text: string,
  exitCode: number | null,
  stopReason: string | null,
): string {
  if (exitCode === 0 || exitCode === null) return text;
  const reasonBit = stopReason === null ? '' : ` (stopReason: ${stopReason})`;
  return `${text}\n\n[grok exited with code ${exitCode}${reasonBit}]`;
}

function errorResult(text: string, exec: ExecResult): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text,
        _meta: {
          outcome: exec.outcome,
          durationMs: exec.durationMs,
        },
      },
    ],
    isError: true,
  };
}

function buffered(exec: ExecResult, stdoutOverride?: string): string {
  const stdout = stdoutOverride ?? exec.stdout;
  const parts: string[] = [];
  if (stdout !== '') parts.push('', 'stdout:', stdout);
  if (exec.stderr !== '') parts.push('', 'stderr:', exec.stderr);
  return parts.join('\n');
}

function preview(stdout: string): string {
  if (stdout.length <= UNPARSEABLE_PREVIEW_CHARS) return stdout;
  return `${stdout.slice(0, UNPARSEABLE_PREVIEW_CHARS)}\n[truncated]`;
}
