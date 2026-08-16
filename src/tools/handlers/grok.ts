/**
 * `grok` — synchronous headless run (`--output-format json`).
 *
 * Permission is resolved against the operator ceiling before any spawn. Session
 * flag conflicts are rejected here too: spending a process to learn a rule we
 * already know is waste, and the CLI's error for a typo'd combination is worse
 * than ours.
 */

import { z } from 'zod';

import { InvalidArgumentsError } from '../../errors.js';
import { buildGrokArgs } from '../../grok/args.js';
import type { SessionSelector } from '../../grok/args.js';
import { execGrok } from '../../grok/exec.js';
import type { ExecResult } from '../../grok/exec.js';
import { parseGrokJson } from '../../grok/result.js';
import { requestedPermissionLevel, resolvePermission } from '../../permission.js';
import { defineTool } from '../../types.js';
import type { ToolContext, ToolResult } from '../../types.js';

const UNPARSEABLE_PREVIEW_CHARS = 4_000;

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
      outputFormat: 'json',
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

    const exec = await execGrok({
      binary: ctx.config.grokBinary,
      args,
      timeoutMs: ctx.config.timeoutMs,
      signal: ctx.signal,
    });

    if (exec.outcome === 'spawn-failed') {
      return errorResult(
        `Failed to start grok at "${ctx.config.grokBinary}".\n\n` +
          'Install the grok CLI or set GROK_BINARY to its path.',
        exec,
      );
    }

    if (exec.outcome === 'timeout') {
      return errorResult(
        `The grok run timed out after ${Math.round(exec.durationMs)} ms.\n\n` +
          'Set GROK_MCP_TIMEOUT_MS to a higher value if the run needs more time.\n' +
          buffered(exec),
        exec,
      );
    }

    if (exec.outcome === 'aborted') {
      return errorResult(
        `The grok run was cancelled by the client.\n${buffered(exec)}`.trimEnd(),
        exec,
      );
    }

    const parsed = parseGrokJson(exec.stdout);

    if (parsed.kind === 'cli-error') {
      const message = parsed.message === '' ? '(no message)' : parsed.message;
      return errorResult(`grok reported an error: ${message}\n${buffered(exec)}`.trimEnd(), exec);
    }

    if (exec.code !== 0) {
      return errorResult(
        `grok exited with code ${exec.code ?? 'unknown'}.\n${buffered(exec)}`,
        exec,
      );
    }

    if (parsed.kind === 'unparseable') {
      return errorResult(
        `grok returned output that is not valid JSON (${parsed.reason}).\n\n` +
          preview(exec.stdout),
        exec,
      );
    }

    const meta = Object.freeze({
      // Exactly the id the CLI reported. Never a locally generated stand-in,
      // and never the `--session-id` we may have passed for a new session.
      sessionId: parsed.result.sessionId,
      // The id we passed as `--model`, not the `modelUsage` key (`grok-4.6` vs `grok-4.6-build`).
      model,
      usage: parsed.result.usage,
      total_cost_usd: parsed.result.totalCostUsd,
      stopReason: parsed.result.stopReason,
      numTurns: parsed.result.numTurns,
      permissionLevel: permission.level,
      durationMs: exec.durationMs,
    });

    const result: ToolResult = {
      content: [{ type: 'text', text: parsed.result.text, _meta: meta }],
    };

    if (ctx.config.structuredContentEnabled) {
      result.structuredContent = meta;
    }

    return result;
  },
});

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

function buffered(exec: ExecResult): string {
  const parts: string[] = [];
  if (exec.stdout !== '') parts.push('', 'stdout:', exec.stdout);
  if (exec.stderr !== '') parts.push('', 'stderr:', exec.stderr);
  return parts.join('\n');
}

function preview(stdout: string): string {
  if (stdout.length <= UNPARSEABLE_PREVIEW_CHARS) return stdout;
  return `${stdout.slice(0, UNPARSEABLE_PREVIEW_CHARS)}\n[truncated]`;
}
