/**
 * Process entry for a detached background worker.
 *
 * Thin: parse argv, load config, honour SIGTERM/SIGINT, run the job, exit.
 * Never writes to stdout — stderr only, via `log`. No MCP transport.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.js';
import { toErrorText } from '../errors.js';
import { log } from '../log.js';
import { finalizeRun } from './store.js';
import { runJob } from './worker.js';

export function parseRunnerArgv(
  argv: readonly string[],
): { readonly runId: string; readonly stateDir: string } | null {
  const runId = flagValue(argv, '--run-id');
  const stateDir = flagValue(argv, '--state-dir');
  if (runId === undefined || runId === '' || stateDir === undefined || stateDir === '') {
    return null;
  }
  return { runId, stateDir };
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

async function markFailed(stateDir: string, runId: string, error: unknown): Promise<void> {
  try {
    await finalizeRun(stateDir, runId, 'runner', {
      state: 'failed',
      endedAt: new Date().toISOString(),
      error: toErrorText(error),
    });
  } catch (claimError: unknown) {
    log.debug('failed to record unexpected worker death', claimError);
  }
}

async function main(): Promise<number> {
  const parsed = parseRunnerArgv(process.argv.slice(2));
  if (parsed === null) {
    log.error('runner requires --run-id and --state-dir');
    return 1;
  }

  const { runId, stateDir } = parsed;

  process.on('uncaughtException', (error: unknown) => {
    log.error('uncaught exception in background worker', error);
    void markFailed(stateDir, runId, error).finally(() => {
      process.exit(1);
    });
  });
  process.on('unhandledRejection', (error: unknown) => {
    log.error('unhandled rejection in background worker', error);
    void markFailed(stateDir, runId, error).finally(() => {
      process.exit(1);
    });
  });

  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    log.info(`runner received ${signal}`);
    controller.abort();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const config = loadConfig(process.env);
  const state = await runJob({ stateDir, runId, config, signal: controller.signal });
  return state === 'completed' ? 0 : 1;
}

/**
 * Node resolves the entry's real path, so a symlink in `process.argv[1]`
 * would otherwise make this look like a library import and exit 0 having
 * done nothing. Spawn always passes an absolute resolved path today; this
 * keeps the check honest if that ever changes.
 */
export function isMainModule(
  entryPath: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (entryPath === undefined) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(entryPath) === realpathSync(modulePath);
  } catch {
    return path.resolve(entryPath) === modulePath;
  }
}

if (isMainModule()) {
  const parsed = parseRunnerArgv(process.argv.slice(2));
  void main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      log.error('background worker failed', error);
      const fail =
        parsed === null ? Promise.resolve() : markFailed(parsed.stateDir, parsed.runId, error);
      void fail.finally(() => {
        process.exit(1);
      });
    });
}
