/**
 * `grok` — synchronous headless run.
 *
 * Uses `--output-format json` unless the client asked for progress, in which case it switches to
 * `streaming-json` and forwards per-event notifications. Permission is resolved against the
 * operator ceiling before any spawn. Session flag conflicts are rejected here too: spending a
 * process to learn a rule we already know is waste, and the CLI's error for a typo'd combination
 * is worse than ours.
 */

import { z } from 'zod';

import { InvalidArgumentsError } from '../../errors.js';
import { buildGrokArgs } from '../../grok/args.js';
import type { SessionSelector } from '../../grok/args.js';
import { execGrok } from '../../grok/exec.js';
import type { ExecResult } from '../../grok/exec.js';
import { createProgressMapper } from '../../grok/progress.js';
import type { ProgressEmission } from '../../grok/progress.js';
import { parseGrokJson } from '../../grok/result.js';
import type { GrokRunResult, ParsedGrokOutput } from '../../grok/result.js';
import {
  createNdjsonReader,
  createStreamCollector,
  interpretStreamLine,
} from '../../grok/stream.js';
import type { StreamOutcome } from '../../grok/stream.js';
import { requestedPermissionLevel, resolvePermission } from '../../permission.js';
import type { PermissionLevel } from '../../permission.js';
import { defineTool } from '../../types.js';
import type { ProgressUpdate, ToolContext, ToolResult } from '../../types.js';

const UNPARSEABLE_PREVIEW_CHARS = 4_000;

/**
 * Token-level `text`/`thought` deltas arrive far faster than a client can usefully render.
 * A trailing-edge debounce coalesces them; a polling interval would tick through a
 * twenty-minute tool call that is sitting still.
 */
const NARRATION_DEBOUNCE_MS = 100;

const PermissionLevelSchema = z.enum(['read-only', 'write', 'full']);

const GrokInput = z
  .object({
    prompt: z
      .string()
      .min(1)
      .describe('The task for Grok to perform. Passed verbatim as `grok -p`.'),
    // The session-identifying strings below, and cwd, carry `.min(1)` for a specific reason: the
    // argv builder omits a flag whose value is empty, so an empty string here would not fail —
    // it would quietly run somewhere else. `resume: ""` becomes "resume the most recent session",
    // `forkSession: ""` becomes "continue in place instead of forking", and `cwd: ""` becomes
    // "run wherever the server happens to live". Rejecting beats guessing.
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe('Working directory for the run. Passed as `--cwd`. Use the narrowest useful path.'),
    model: z
      .string()
      .optional()
      .describe(
        'Model id to pass as `--model`. Omit to use the server default. Unknown ids are rejected by the CLI, not by this server.',
      ),
    effort: z
      .string()
      .optional()
      .describe(
        'Reasoning effort passed as `--effort`. Omit to use the server default. Values are passed through; the CLI rejects what the model does not advertise.',
      ),
    permission: PermissionLevelSchema.optional().describe(
      'Permission level for this run: `read-only`, `write`, or `full`. Must be at or below GROK_MCP_PERMISSION_CEILING. Omit to use the server default.',
    ),
    write: z
      .boolean()
      .optional()
      .describe(
        'Shorthand for `permission: "write"`. Ignored when `permission` is set. `false` is not a request.',
      ),
    yolo: z
      .boolean()
      .optional()
      .describe(
        'Shorthand for `permission: "full"`. Ignored when `permission` is set. `false` is not a request.',
      ),
    maxTurns: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Maximum agentic turns. Passed as `--max-turns`. Headless only.'),
    tools: z
      .array(z.string())
      .optional()
      .describe(
        'Internal tool ids to allow, passed as a single comma-joined `--tools`. Shell is `run_terminal_command`, not `bash`.',
      ),
    disallowedTools: z
      .array(z.string())
      .optional()
      .describe('Internal tool ids to block, passed as `--disallowed-tools`.'),
    allow: z
      .array(z.string())
      .optional()
      .describe(
        'Repeatable allow rules in `ToolPrefix(glob)` form, e.g. `Bash(npm*)`, `Write(src/**)`.',
      ),
    deny: z
      .array(z.string())
      .optional()
      .describe('Repeatable deny rules in `ToolPrefix(glob)` form, e.g. `Read(.env)`.'),
    rules: z.string().optional().describe('Extra system-prompt text, passed as `--rules`.'),
    agent: z.string().optional().describe('Named subagent to run, passed as `--agent`.'),
    resume: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Resume an existing session by id or title (`--resume`). Mutually exclusive with `continueSession`. Combine with `forkSession` to fork rather than continue in place.',
      ),
    continueSession: z
      .boolean()
      .optional()
      .describe(
        'Continue the most recent session for `cwd` (`--continue`). Mutually exclusive with `resume`. `false` is not a request.',
      ),
    forkSession: z
      .string()
      .min(1)
      .optional()
      .describe(
        'UUID for a forked session. Requires `resume` or `continueSession`. Passed as `--fork-session --session-id`.',
      ),
    sessionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Create a NEW session with this UUID (`--session-id`). Cannot be combined with `resume` or `continueSession`; use `forkSession` to name a fork.',
      ),
    disableWebSearch: z
      .boolean()
      .optional()
      .describe('Pass `--disable-web-search`. `false` is not a request.'),
  })
  .describe('Headless Grok Build run.')
  .meta({ title: 'GrokInput' });

type GrokInput = z.output<typeof GrokInput>;

export const grokTool = defineTool({
  name: 'grok',
  title: 'Run Grok Build',
  description:
    'Run a headless Grok Build agent (`grok -p`). Returns the model text plus session, usage, ' +
    'and cost metadata. Permission is capped by GROK_MCP_PERMISSION_CEILING; requests above it ' +
    'are rejected rather than silently downgraded.',
  schema: GrokInput,
  annotations: {
    // The ceiling may permit writes, so this is not a read-only tool even when the default is.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (input: GrokInput, ctx: ToolContext): Promise<ToolResult> => {
    const conflicts = sessionConflicts(input);
    if (conflicts.length > 0) {
      throw new InvalidArgumentsError('grok', conflicts);
    }

    const session = sessionSelector(input);
    const requested = requestedPermissionLevel({
      permission: input.permission,
      write: input.write,
      yolo: input.yolo,
    });
    const permission = resolvePermission({
      requested,
      defaultLevel: ctx.config.defaultPermission,
      ceiling: ctx.config.permissionCeiling,
    });

    const model = input.model ?? ctx.config.defaultModel;
    const effort = input.effort ?? ctx.config.defaultEffort;

    const args = buildGrokArgs({
      prompt: input.prompt,
      outputFormat: ctx.progressRequested ? 'streaming-json' : 'json',
      permission: permission.flags,
      cwd: input.cwd,
      model,
      effort,
      maxTurns: input.maxTurns,
      tools: input.tools,
      disallowedTools: input.disallowedTools,
      allow: input.allow,
      deny: input.deny,
      rules: input.rules,
      agent: input.agent,
      session,
      disableWebSearch: input.disableWebSearch,
    });

    const stream = ctx.progressRequested ? startStreamSession(ctx.reportProgress) : undefined;

    let exec: ExecResult;
    try {
      exec = await execGrok({
        binary: ctx.config.grokBinary,
        args,
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
        `Failed to start grok at "${ctx.config.grokBinary}".\n\n` +
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
      return successResult(
        outcome.result,
        exec,
        model,
        permission.level,
        ctx.config.structuredContentEnabled,
      );
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
              model,
              permissionLevel: permission.level,
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
      );
    }

    return errorResult(
      `grok returned output that is not valid JSON (${outcome.reason}).\n\n` + preview(exec.stdout),
      exec,
    );
  },
});

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
  model: string | null,
  permissionLevel: PermissionLevel,
  structuredContentEnabled: boolean,
): ToolResult {
  const meta = Object.freeze({
    // Exactly the id the CLI reported. Never a locally generated stand-in,
    // and never the `--session-id` we may have passed for a new session.
    sessionId: result.sessionId,
    // The id we passed as `--model`, not the `modelUsage` key (`grok-4.6` vs `grok-4.6-build`).
    model,
    usage: result.usage,
    total_cost_usd: result.totalCostUsd,
    stopReason: result.stopReason,
    numTurns: result.numTurns,
    permissionLevel,
    durationMs: exec.durationMs,
    exitCode: exec.code,
  });

  const toolResult: ToolResult = {
    content: [
      {
        type: 'text',
        text: formatResultText(result.text, exec.code, result.stopReason),
        _meta: meta,
      },
    ],
  };

  if (structuredContentEnabled) {
    toolResult.structuredContent = meta;
  }

  return toolResult;
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

function sessionConflicts(input: GrokInput): string[] {
  const issues: string[] = [];
  const resuming = input.resume !== undefined;
  const continuing = input.continueSession === true;
  const creating = input.sessionId !== undefined;
  const forking = input.forkSession !== undefined;

  if (resuming && continuing) {
    issues.push(
      'resume and continueSession are mutually exclusive. Pass one or the other, not both.',
    );
  }

  if (creating && (resuming || continuing)) {
    issues.push(
      'sessionId creates a new session and cannot be combined with resume or continueSession. ' +
        'To fork an existing session, pass forkSession together with resume or continueSession.',
    );
  }

  if (forking && !resuming && !continuing) {
    issues.push(
      'forkSession requires resume or continueSession. ' +
        'To create a new session with a chosen UUID, pass sessionId alone.',
    );
  }

  return issues;
}

function sessionSelector(input: GrokInput): SessionSelector {
  if (input.resume !== undefined) {
    return { kind: 'resume', id: input.resume, forkId: input.forkSession };
  }
  if (input.continueSession === true) {
    return { kind: 'continue', forkId: input.forkSession };
  }
  if (input.sessionId !== undefined) {
    return { kind: 'new-with-id', id: input.sessionId };
  }
  return { kind: 'new' };
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
