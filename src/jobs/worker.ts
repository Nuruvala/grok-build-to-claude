/**
 * The job body for a background run. Callable in-process so tests exercise
 * the real thing instead of only through a spawned child.
 *
 * A worker must never exit leaving a record that says `running` — that is the
 * "run that hangs forever" failure in a new costume.
 */

import path from 'node:path';

import type { Config } from '../config.js';
import { toErrorText } from '../errors.js';
import { log } from '../log.js';
import { invokeTool } from '../tools/registry.js';
import type { ProgressUpdate, RunSink, ToolContext, ToolResult } from '../types.js';
import { isOrphan } from './liveness.js';
import { isTerminal, timestampFromRunId, type RunState, type StoredResult } from './record.js';
import {
  createLogAppender,
  finalizeRun,
  INPUT_MAX_BYTES,
  listRunIds,
  LOG_MAX_BYTES,
  patchRun,
  readRun,
  readRunInput,
  removeRunDir,
  runDir,
  writeLateResult,
  writeProgress,
} from './store.js';

/** Immediate for the log (cheap append); a rename per token delta is waste. */
export const RECORD_PROGRESS_FLUSH_MS = 500;
/** Newest terminal runs kept on disk. */
export const MAX_RETAINED_RUNS = 200;
/** Terminal runs older than this are deleted even if they fit under the count cap. */
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Bound how much one finished job will delete, so a sweep cannot stall the next call. */
export const SWEEP_DELETE_CAP = 50;

export interface RunJobOptions {
  readonly stateDir: string;
  readonly runId: string;
  readonly config: Config;
  readonly signal: AbortSignal;
  /**
   * Test-only. Invoked the moment the tool settles, before progress is drained
   * and before the terminal write. The callback receives the same flush the
   * timer would have fired; that flush now writes `progress.json`, not the
   * record, which is why a late timer can no longer lose a terminal write.
   */
  readonly afterTool?: ((flush: () => void) => void | Promise<void>) | undefined;
}

export async function runJob(options: RunJobOptions): Promise<RunState> {
  try {
    return await executeJob(options);
  } finally {
    try {
      await sweepRetainedRuns({ stateDir: options.stateDir });
    } catch (error: unknown) {
      log.debug('retention sweep failed', error);
    }
  }
}

async function executeJob(options: RunJobOptions): Promise<RunState> {
  const { stateDir, runId } = options;
  try {
    return await runExecute(options);
  } catch (error: unknown) {
    return await markFailedOrKeepTerminal(stateDir, runId, error);
  }
}

async function runExecute(options: RunJobOptions): Promise<RunState> {
  const { stateDir, runId, config, signal } = options;
  const record = await readRun(stateDir, runId);
  const input = await readRunInput(stateDir, runId);

  if (record === null) {
    log.error(`background worker has nothing to run for ${runId}: missing record`);
    return 'failed';
  }

  if (isTerminal(record.state)) {
    return record.state;
  }

  if (input === null) {
    const outcome = await finalizeRun(stateDir, runId, 'worker', {
      state: 'failed',
      endedAt: new Date().toISOString(),
      error:
        `The input file for ${runId} could not be read (missing, unparseable, or larger than ` +
        `${INPUT_MAX_BYTES} bytes).`,
    });
    if (outcome.kind === 'lost') {
      return outcome.record?.state ?? 'failed';
    }
    return outcome.record.state;
  }

  const startedAt = new Date().toISOString();
  const patched = await patchRun(stateDir, runId, {
    state: 'running',
    startedAt,
    workerPid: process.pid,
  });
  if (patched === null) {
    // A claim is a promise that a terminal write is coming. Invoking the
    // tool after that promise exists spends the run into a record nobody
    // will keep.
    log.info(`running patch refused for ${runId}; exiting without invoking the tool`);
    const current = await readRun(stateDir, runId);
    return current?.state ?? 'cancelled';
  }

  const dir = runDir(stateDir, runId);
  const progressLog = createLogAppender(path.join(dir, 'progress.log'), LOG_MAX_BYTES);
  const stdoutLog = createLogAppender(path.join(dir, 'stdout.log'), LOG_MAX_BYTES);
  const stderrLog = createLogAppender(path.join(dir, 'stderr.log'), LOG_MAX_BYTES);

  let progressCount = 0;
  let lastProgress: string | null = null;
  let lastProgressAt: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let writeChain = Promise.resolve();

  function enqueuePatch(patch: Parameters<typeof patchRun>[2]): void {
    writeChain = writeChain
      .then(() => patchRun(stateDir, runId, patch))
      .then(() => undefined)
      .catch((error: unknown) => {
        log.debug('worker record patch failed', error);
      });
  }

  function enqueueProgress(): void {
    const snapshot = { progressCount, lastProgress, lastProgressAt };
    writeChain = writeChain
      .then(() => writeProgress(stateDir, runId, snapshot))
      .then(() => undefined)
      .catch((error: unknown) => {
        log.debug('worker progress write failed', error);
      });
  }

  function flushProgress(): void {
    flushTimer = undefined;
    enqueueProgress();
  }

  function reportProgress(update: ProgressUpdate): void {
    const line = `#${update.progress} ${update.message ?? ''}`;
    progressLog.write(`${line}\n`);
    progressCount += 1;
    lastProgress = line;
    lastProgressAt = new Date().toISOString();
    flushTimer ??= setTimeout(flushProgress, RECORD_PROGRESS_FLUSH_MS);
  }

  const runSink: RunSink = {
    started: (info) => {
      enqueuePatch({
        argv: [...info.argv],
        childPid: info.childPid,
      });
    },
    stdout: (chunk) => {
      stdoutLog.write(chunk);
    },
    stderr: (chunk) => {
      stderrLog.write(chunk);
    },
  };

  const ctx: ToolContext = {
    config,
    signal,
    progressRequested: true,
    reportProgress,
    runSink,
  };

  let toolResult: ToolResult | undefined;
  let toolError: unknown;

  try {
    if (input['background'] === true) {
      throw new Error(
        `Background worker invoked ${record.tool} with background: true. ` +
          'The parent must strip this field so a worker cannot spawn another worker.',
      );
    }

    toolResult = await invokeTool(record.tool, input, ctx);
    if (options.afterTool !== undefined) {
      await options.afterTool(flushProgress);
    }
  } catch (error: unknown) {
    toolError = error;
  } finally {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      enqueueProgress();
    }
    await writeChain;
    await progressLog.close();
    await stdoutLog.close();
    await stderrLog.close();
  }

  // At this point this process has no outstanding write to `record.json`.
  if (toolError !== undefined) {
    return await finishWithError(stateDir, runId, toolError);
  }
  if (toolResult === undefined) {
    return await finishWithError(stateDir, runId, new Error('tool produced no result'));
  }
  return await finishWithResult(stateDir, runId, toolResult);
}

async function finishWithResult(
  stateDir: string,
  runId: string,
  result: ToolResult,
): Promise<RunState> {
  const block = result.content[0];
  const meta = block?._meta ?? {};
  const sessionId = nonEmptyString(meta['sessionId']);
  const stopReason = nonEmptyString(meta['stopReason']);
  const stored: StoredResult = {
    text: block?.text ?? '',
    meta,
    // Replays the tool: a cut-off grok stays isError: false because the
    // foreground does. The state label describes the run, so a listing does
    // not call a fragment a clean finish.
    isError: result.isError === true,
  };
  const state: RunState = stored.isError ? 'failed' : 'completed';
  const outcome = await finalizeRun(stateDir, runId, 'worker', {
    state,
    endedAt: new Date().toISOString(),
    result: stored,
    sessionId,
    stopReason,
  });
  if (outcome.kind === 'lost') {
    // A run cancelled at turn nine has already been paid for, and it may
    // carry a sessionId that resumes everything it did. Throwing that away
    // to keep the record tidy would be the same class of loss as the plugin
    // reporting a session id that never existed — the opposite direction,
    // same disrespect for what the run actually produced.
    try {
      await writeLateResult(stateDir, runId, stored);
    } catch (error: unknown) {
      log.debug('failed to preserve late result after a lost terminal claim', error);
    }
    log.info(`lost terminal claim for ${runId}; another process ended this run`);
    return outcome.record?.state ?? 'cancelled';
  }
  return outcome.record.state;
}

async function finishWithError(stateDir: string, runId: string, error: unknown): Promise<RunState> {
  const outcome = await finalizeRun(stateDir, runId, 'worker', {
    state: 'failed',
    endedAt: new Date().toISOString(),
    error: toErrorText(error),
  });
  if (outcome.kind === 'lost') {
    log.info(`lost terminal claim for ${runId} while handling a worker error`);
    return outcome.record?.state ?? 'failed';
  }
  return outcome.record.state;
}

async function markFailedOrKeepTerminal(
  stateDir: string,
  runId: string,
  error: unknown,
): Promise<RunState> {
  try {
    const current = await readRun(stateDir, runId);
    if (current !== null && isTerminal(current.state)) {
      return current.state;
    }
    const outcome = await finalizeRun(stateDir, runId, 'worker', {
      state: 'failed',
      endedAt: new Date().toISOString(),
      error: toErrorText(error),
    });
    if (outcome.kind === 'lost') {
      return outcome.record?.state ?? 'failed';
    }
    return outcome.record.state;
  } catch (finalizeError: unknown) {
    log.error('failed to terminalise run after worker error', finalizeError);
    return 'failed';
  }
}

export interface SweepOptions {
  readonly stateDir: string;
  readonly now?: number | undefined;
  readonly maxRetained?: number | undefined;
  readonly retentionMs?: number | undefined;
  readonly deleteCap?: number | undefined;
}

/**
 * Delete terminal run directories beyond the newest `maxRetained` or older
 * than `retentionMs`. Also deletes a non-terminal record whose worker is
 * gone *and* which is older than `retentionMs` — the same judgement `status`
 * makes, applied where a write (a delete) is expected. Unreadable
 * directories are skipped. Tests lower the caps so a fixture does not have
 * to contain 201 runs.
 */
export async function sweepRetainedRuns(options: SweepOptions): Promise<void> {
  const now = options.now ?? Date.now();
  const maxRetained = options.maxRetained ?? MAX_RETAINED_RUNS;
  const retentionMs = options.retentionMs ?? RETENTION_MS;
  const deleteCap = options.deleteCap ?? SWEEP_DELETE_CAP;

  const ids = await listRunIds(options.stateDir);
  let deleted = 0;

  for (let index = 0; index < ids.length; index += 1) {
    if (deleted >= deleteCap) return;
    const runId = ids[index];
    if (runId === undefined) continue;

    const stampMs = timestampFromRunId(runId);
    const ageFromName = stampMs === null ? Number.NaN : now - stampMs;
    const tooOldByName = Number.isFinite(ageFromName) && ageFromName > retentionMs;
    const pastCap = index >= maxRetained;
    if (!tooOldByName && !pastCap) continue;

    const record = await readRun(options.stateDir, runId);
    if (record === null) continue;

    const ageMs = now - Date.parse(record.createdAt);
    const tooOld = Number.isFinite(ageMs) && ageMs > retentionMs;

    if (!isTerminal(record.state)) {
      if (isOrphan(record, now) && tooOld) {
        await removeRunDir(options.stateDir, runId);
        deleted += 1;
      }
      continue;
    }

    if (tooOld || pastCap) {
      await removeRunDir(options.stateDir, runId);
      deleted += 1;
    }
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
