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
import {
  createNdjsonReader,
  createStreamCollector,
  emptyResult,
  interpretStreamLine,
} from '../grok/stream.js';
import type { GrokStreamEvent, StreamOutcome } from '../grok/stream.js';
import { log } from '../log.js';
import type { PermissionLevel } from '../permission.js';
import { resumeCommand } from '../sessions/select.js';
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
  /**
   * Extra keys merged into `content[0]._meta` on every path. Handler keys go
   * first so the run's own keys win; `sessionId` / `resumeCommand` are stripped
   * from this object on any non-success path.
   */
  readonly meta?: GrokRunMeta | undefined;
  /** Transform the model's text before it becomes the result body. Identity when omitted. */
  readonly formatText?: ((result: GrokRunResult) => string) | undefined;
  /** Decide the error flag from the parsed result. Defaults to a successful run being `isError: false`. */
  readonly isError?: ((result: GrokRunResult) => boolean) | undefined;
  /**
   * Receives every parsed stream event, in order, as it arrives. Only called on the streaming
   * path — a handler that wants events must build argv with `--output-format streaming-json`.
   * Exists so a tool can harvest data the result object does not carry: `end` has no record of
   * which searches ran, so `websearch` counts them here or not at all.
   */
  readonly observer?: ((event: GrokStreamEvent) => void) | undefined;
}

/**
 * Which parser the child's output needs, read off the argv we are about to spawn.
 *
 * The two used to be decided separately — the handler chose the format from
 * `progressRequested`, and this module chose the parser from the same flag — so a handler that
 * emitted one format while the parser expected the other was a silent unparseable run. Reading
 * the flag we are actually passing makes that combination unrepresentable.
 *
 * Last `--output-format`, not first: `buildGrokArgs` emits exactly one, but a caller that
 * appended an override should get the one that wins.
 */
export function streamingOutput(args: readonly string[]): boolean {
  let format: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--output-format') continue;
    format = args[index + 1];
    index += 1;
  }
  return format === 'streaming-json';
}

export async function runGrok(request: GrokRunRequest, ctx: ToolContext): Promise<ToolResult> {
  const sink = ctx.runSink;
  // Progress emission stays gated the way it already is: `reportProgress` is a no-op when the
  // client sent no `progressToken`, so a non-progress streaming run emits nothing.
  const stream = streamingOutput(request.args)
    ? startStreamSession(ctx.reportProgress, request.observer)
    : undefined;

  const onStdout =
    sink === undefined && stream === undefined
      ? undefined
      : (chunk: string) => {
          sink?.stdout(chunk);
          stream?.onStdout(chunk);
        };
  const onStderr =
    sink === undefined
      ? undefined
      : (chunk: string) => {
          sink.stderr(chunk);
        };
  const onSpawn =
    sink === undefined
      ? undefined
      : (pid: number) => {
          sink.started({
            argv: request.args,
            childPid: pid,
            model: request.model,
            permissionLevel: request.permissionLevel,
          });
        };

  let exec: ExecResult;
  try {
    exec = await execGrok({
      binary: ctx.config.grokBinary,
      args: request.args,
      timeoutMs: ctx.config.timeoutMs,
      signal: ctx.signal,
      // A sink must see raw chunks even when the client did not ask for
      // streaming; compose the two listeners rather than forking the branch.
      ...(onStdout === undefined ? {} : { onStdout }),
      ...(onStderr === undefined ? {} : { onStderr }),
      ...(onSpawn === undefined ? {} : { onSpawn }),
      // Foreground (no sink) keeps today's default. A worker passes a sink and
      // must not make grok a group leader — see exec.ts `detached`.
      ...(sink === undefined ? {} : { detached: false }),
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
      request,
      emptyResult(),
    );
  }

  const outcome =
    stream === undefined ? parsedToStreamOutcome(parseGrokJson(exec.stdout)) : stream.outcome();

  // `--max-turns` exits 1 with a complete result on stdout (verified grok 1.0.0,
  // 2026-08-16). The parsed result wins over the exit code so we keep the
  // session id and the spend that produced it. `stop` is the same shape: it
  // SIGTERMs a worker whose grok child may already have written `end`.
  if (outcome.kind === 'result') {
    return successResult(outcome.result, exec, request, ctx.config.structuredContentEnabled);
  }

  if (exec.outcome === 'timeout') {
    return errorResult(
      `The grok run timed out after ${Math.round(exec.durationMs)} ms.\n\n` +
        'Set GROK_MCP_TIMEOUT_MS to a higher value if the run needs more time.\n' +
        buffered(exec, streamedStdout(stream, outcome, exec)),
      exec,
      request,
      resultForMeta(outcome),
    );
  }

  if (exec.outcome === 'aborted') {
    return errorResult(
      `The grok run was cancelled by the client.\n${buffered(exec, streamedStdout(stream, outcome, exec))}`.trimEnd(),
      exec,
      request,
      resultForMeta(outcome),
    );
  }

  if (outcome.kind === 'cli-error') {
    const message = outcome.message === '' ? '(no message)' : outcome.message;
    return errorResult(
      `grok reported an error: ${message}\n${buffered(exec)}`.trimEnd(),
      exec,
      request,
      emptyResult(),
    );
  }

  if (outcome.kind === 'partial') {
    // Recovered text when the model wrote some; the raw buffer when it did
    // not. A stream of only tool events (or one unparseable line) has empty
    // recovered text, and dropping the buffer would throw away the only
    // evidence the run produced — the M5b rule this branch exists to keep.
    const recovered = outcome.result.text;
    const body = recovered !== '' ? recovered : preview(exec.stdout);
    return {
      content: [
        {
          type: 'text',
          text:
            `${body}\n\n` +
            '[stream ended before its end event, so session id, usage, and cost are unavailable]',
          _meta: {
            // Handler keys first so the run's own keys win — same rule as
            // successResult. sessionId / resumeCommand are stripped: a
            // partial path must not gain a session Grok never confirmed.
            ...nonSuccessHandlerMeta(request.meta, outcome.result),
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
    return errorResult(
      `grok exited with code ${exec.code ?? 'unknown'}.\n${buffered(exec)}`,
      exec,
      request,
      emptyResult(),
    );
  }

  return errorResult(
    `grok returned output that is not valid JSON (${outcome.reason}).\n\n` + preview(exec.stdout),
    exec,
    request,
    emptyResult(),
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

function startStreamSession(
  reportProgress: (update: ProgressUpdate) => void,
  observer: ((event: GrokStreamEvent) => void) | undefined,
): StreamSession {
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

  function notifyObserver(event: GrokStreamEvent): void {
    if (observer === undefined) return;
    try {
      observer(event);
    } catch (error: unknown) {
      // Same reasoning as the `never` arm in `createStreamCollector`: this
      // runs inside a stdout data handler. An exception here is uncaught,
      // kills the process, and leaves the run's promise forever unresolved.
      // Dropping one observer event beats taking down the server.
      log.warn('stream observer threw; dropping this event and continuing', error);
    }
  }

  function handleLine(line: string): void {
    const event = interpretStreamLine(line);
    collector.accept(event);
    notifyObserver(event);

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
    // Only when the CLI confirmed an id. Omitting the key (not emitting null)
    // keeps the partial-stream path honest: no session we did not see.
    ...(nonEmptySessionId(result.sessionId)
      ? { resumeCommand: resumeCommand(result.sessionId) }
      : {}),
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

function nonEmptySessionId(sessionId: string | null): sessionId is string {
  return sessionId !== null && sessionId !== '';
}

function resolveMeta(
  meta: GrokRunMeta | undefined,
  result: GrokRunResult,
): Readonly<Record<string, unknown>> {
  if (meta === undefined) return {};
  if (typeof meta === 'function') return meta(result);
  return meta;
}

/**
 * Recovered result when the stream produced one, otherwise the empty shape
 * `emptyResult()` builds. Lets a meta function be called unconditionally on
 * every non-success path. `searchMeta` ignores the argument; review's prose
 * meta returns its base for a null stop reason.
 */
function resultForMeta(outcome: StreamOutcome): GrokRunResult {
  if (outcome.kind === 'result' || outcome.kind === 'partial') {
    return outcome.result;
  }
  return emptyResult();
}

/**
 * Handler meta for a path that is not a confirmed result. Strip `sessionId`
 * and `resumeCommand` before merging: no handler sets them today, and the
 * guard is what keeps that from becoming load-bearing. Reporting a session
 * Grok never confirmed is the plugin bug this repo exists to not reproduce.
 */
function nonSuccessHandlerMeta(
  meta: GrokRunMeta | undefined,
  result: GrokRunResult,
): Readonly<Record<string, unknown>> {
  const resolved = resolveMeta(meta, result);
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (key === 'sessionId' || key === 'resumeCommand') continue;
    stripped[key] = value;
  }
  return stripped;
}

function formatResultText(
  text: string,
  exitCode: number | null,
  stopReason: string | null,
): string {
  const failed = exitCode !== 0 && exitCode !== null;
  const cutOff = stopReason !== null && stopReason !== 'end_turn';
  if (!failed && !cutOff) return text;
  if (failed) {
    // One line carries both facts when a non-zero exit is also a cut-off.
    const reasonBit = stopReason === null ? '' : ` (stopReason: ${stopReason})`;
    return `${text}\n\n[grok exited with code ${exitCode}${reasonBit}]`;
  }
  // Exit 0 with a non-end_turn stopReason: a permission-cancelled run does
  // this. Without a note the caller sees bare narration and no fragment mark.
  return `${text}\n\n[the run stopped early — stopReason: ${stopReason}]`;
}

function errorResult(
  text: string,
  exec: ExecResult,
  request: GrokRunRequest,
  result: GrokRunResult,
): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text,
        _meta: {
          // Handler keys first so the run's own keys win — same rule as successResult.
          ...nonSuccessHandlerMeta(request.meta, result),
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
