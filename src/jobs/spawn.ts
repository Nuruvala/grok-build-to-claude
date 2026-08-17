/**
 * Launch a detached background worker for a grok/review call.
 *
 * The MCP server writes the run record, spawns the worker, and forgets about
 * it. The worker is its own process group so the server can exit.
 */

import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { InvalidArgumentsError, toErrorText } from '../errors.js';
import { log } from '../log.js';
import type { ToolContext, ToolResult } from '../types.js';
import { newRunId } from './record.js';
import { createRun, finalizeRun, RUN_FILE_MODE, runDir, writeWorkerPid } from './store.js';

/** Pure: which interpreter arguments and runner path to use, given the module's own filename. */
export function resolveRunnerLaunch(moduleFileName: string): {
  readonly runnerPath: string;
  readonly nodeArgs: readonly string[];
} {
  // Running from src/ under tsx means the sibling runner is a .ts file that bare node cannot load,
  // so the worker needs the loader too. Deciding from our own extension is deterministic;
  // forwarding process.execArgv is not — under `node --test` it carries thirty internal flags
  // including --test itself, which would make the worker try to run as a test process.
  const ext = path.extname(moduleFileName);
  const nodeArgs = ext === '.ts' ? ['--import', 'tsx'] : [];
  return {
    runnerPath: path.join(path.dirname(moduleFileName), `runner${ext}`),
    nodeArgs,
  };
}

export interface StartBackgroundRunOptions {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly cwd: string;
}

export async function startBackgroundRun(
  options: StartBackgroundRunOptions,
  ctx: ToolContext,
): Promise<ToolResult> {
  const runId = newRunId(Date.now());
  const input = withoutBackground(options.input);
  const createdAt = new Date().toISOString();
  let record:
    | {
        readonly runId: string;
        readonly tool: string;
        readonly cwd: string;
        readonly createdAt: string;
        readonly summary: string;
      }
    | undefined;

  try {
    record = await createRun({
      stateDir: ctx.config.stateDir,
      runId,
      tool: options.tool,
      summary: options.summary,
      cwd: options.cwd,
      input,
    });

    const { runnerPath, nodeArgs } = resolveRunnerLaunch(fileURLToPath(import.meta.url));
    const logPath = path.join(runDir(ctx.config.stateDir, runId), 'worker.log');

    // Owner-only, same as everything else in the run directory: this is the worker's
    // stdout and stderr, and a crash puts prompt fragments in it.
    const logHandle = await open(logPath, 'a', RUN_FILE_MODE);
    try {
      const child = spawn(
        process.execPath,
        [...nodeArgs, runnerPath, '--run-id', runId, '--state-dir', ctx.config.stateDir],
        {
          // The server's own cwd, always — never the run's target directory.
          // Both handlers default a missing cwd argument to process.cwd(), so
          // the worker must inherit the same one or a review with no cwd
          // would review whichever directory the worker happened to start in.
          cwd: process.cwd(),
          env: workerEnv(ctx),
          stdio: ['ignore', logHandle.fd, logHandle.fd],
          // Survival, not kill semantics: unref() alone does not outlive the
          // parent on Windows. Killing the worker there reaps it but may miss
          // a grandchild, the same caveat exec.ts already carries.
          detached: true,
        },
      );

      const spawnError = await new Promise<Error | null>((resolve) => {
        const onError = (error: Error) => {
          child.off('spawn', onSpawn);
          resolve(error);
        };
        const onSpawn = () => {
          child.off('error', onError);
          resolve(null);
        };
        child.once('error', onError);
        child.once('spawn', onSpawn);
      });

      if (spawnError !== null) {
        return await failSpawn(ctx, record, spawnError);
      }

      const rawPid = child.pid;
      const workerPid = typeof rawPid === 'number' && rawPid > 0 ? rawPid : null;
      // Sidecar lands before startedResult returns a runId, so a caller
      // cannot ask stop about this run before the pid is findable.
      if (workerPid !== null) {
        try {
          await writeWorkerPid(ctx.config.stateDir, runId, workerPid);
        } catch (error: unknown) {
          log.warn(`failed to persist worker pid for ${runId}`, error);
        }
      }
      child.unref();
      return startedResult(record, workerPid, ctx.config.structuredContentEnabled);
    } finally {
      await logHandle.close();
    }
  } catch (error: unknown) {
    if (error instanceof InvalidArgumentsError && record === undefined) {
      throw error;
    }
    return await failSpawn(
      ctx,
      record ?? {
        runId,
        tool: options.tool,
        cwd: options.cwd,
        createdAt,
        summary: options.summary,
      },
      error,
    );
  }
}

function withoutBackground(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { background: _background, ...rest } = input;
  return rest;
}

/**
 * The worker re-parses config from its environment. Overlay the server's
 * already-resolved values so a test (or a caller that constructed Config
 * without mutating process.env) cannot launch a worker that talks to a
 * different binary or store.
 */
function workerEnv(ctx: ToolContext): NodeJS.ProcessEnv {
  const { config } = ctx;
  return {
    ...process.env,
    GROK_BINARY: config.grokBinary,
    GROK_MCP_STATE_DIR: config.stateDir,
    GROK_MCP_TIMEOUT_MS: String(config.timeoutMs),
    GROK_MCP_PERMISSION_CEILING: config.permissionCeiling,
    GROK_MCP_DEFAULT_PERMISSION: config.defaultPermission,
    GROK_MCP_DEFAULT_MODEL: config.defaultModel ?? 'none',
    GROK_MCP_DEFAULT_EFFORT: config.defaultEffort ?? 'none',
    STRUCTURED_CONTENT_ENABLED: config.structuredContentEnabled ? '1' : '0',
  };
}

async function failSpawn(
  ctx: ToolContext,
  record: {
    readonly runId: string;
    readonly tool: string;
    readonly cwd: string;
    readonly createdAt: string;
    readonly summary: string;
  },
  error: unknown,
): Promise<ToolResult> {
  const reason = toErrorText(error);
  log.warn(`failed to spawn background worker for ${record.runId}`, error);
  try {
    await finalizeRun(ctx.config.stateDir, record.runId, 'server', {
      state: 'failed',
      endedAt: new Date().toISOString(),
      error: reason,
    });
  } catch (finalizeError: unknown) {
    log.debug('failed to terminalise a spawn failure', finalizeError);
  }
  return {
    content: [
      {
        type: 'text',
        text:
          `Failed to start background ${record.tool} run ${record.runId}.\n\n${reason}\n\n` +
          'The run will never execute. Check GROK_MCP_STATE_DIR and that node can spawn.',
        _meta: {
          runId: record.runId,
          state: 'failed',
          tool: record.tool,
          cwd: record.cwd,
          workerPid: null,
          createdAt: record.createdAt,
          summary: record.summary,
        },
      },
    ],
    isError: true,
  };
}

function startedResult(
  record: {
    readonly runId: string;
    readonly tool: string;
    readonly cwd: string;
    readonly createdAt: string;
    readonly summary: string;
  },
  workerPid: number | null,
  structuredContentEnabled: boolean,
): ToolResult {
  const meta = Object.freeze({
    runId: record.runId,
    state: 'starting' as const,
    tool: record.tool,
    cwd: record.cwd,
    workerPid,
    createdAt: record.createdAt,
    summary: record.summary,
  });

  const text = [
    `Started ${record.tool} run ${record.runId} in the background.`,
    '',
    `  status  { "runId": "${record.runId}" }             poll it`,
    `  status  { "runId": "${record.runId}", "waitMs": 30000 }   wait for it`,
    '',
    'Progress is recorded while it runs; the run continues if this MCP server restarts.',
  ].join('\n');

  const result: ToolResult = {
    content: [{ type: 'text', text, _meta: meta }],
    isError: false,
  };
  if (structuredContentEnabled) {
    result.structuredContent = meta;
  }
  return result;
}
