/**
 * Short-lived probes of the grok binary: version and authentication.
 *
 * Total: every failure becomes `ok: false`. A missing binary and a failed login are
 * different problems with different fixes; neither throws.
 */

import { execGrok } from './exec.js';
import type { ExecResult } from './exec.js';

/** Probes must never inherit the 30-minute run timeout. */
const PROBE_TIMEOUT_CAP_MS = 15_000;

export interface VersionProbe {
  readonly ok: boolean;
  /** Raw first line of output, e.g. "grok 1.0.0 (3cd0d0cbce) [stable]". null when unavailable. */
  readonly version: string | null;
  /** Present when ok is false. Says what failed and what to do. */
  readonly problem: string | null;
}

export interface AuthProbe {
  readonly ok: boolean;
  /** Model ids the account advertises, as reported. Empty when unavailable. */
  readonly models: readonly string[];
  readonly problem: string | null;
}

export async function probeVersion(
  binary: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<VersionProbe> {
  try {
    return await runVersionProbe(binary, cappedTimeoutMs(timeoutMs), signal);
  } catch (error: unknown) {
    return failVersion(unexpectedProblem('grok version', error));
  }
}

export async function probeAuth(
  binary: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AuthProbe> {
  try {
    return await runAuthProbe(binary, cappedTimeoutMs(timeoutMs), signal);
  } catch (error: unknown) {
    return failAuth(unexpectedProblem('grok models', error));
  }
}

async function runVersionProbe(
  binary: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<VersionProbe> {
  const first = await execProbe(binary, ['version'], timeoutMs, signal);

  if (first.outcome === 'spawn-failed') {
    // A missing binary will not become present on retry; spending another spawn hides the cause.
    return failVersion(missingBinaryProblem(binary));
  }

  if (isSuccess(first)) {
    return okVersion(firstLine(first.stdout));
  }

  if (!isNonZeroExit(first)) {
    return failVersion(execProblem('grok version', first));
  }

  const fallback = await execProbe(binary, ['--version'], timeoutMs, signal);

  if (fallback.outcome === 'spawn-failed') {
    return failVersion(missingBinaryProblem(binary));
  }

  if (isSuccess(fallback)) {
    return okVersion(firstLine(fallback.stdout));
  }

  return failVersion(
    `${execProblem('grok version', first)} Retry with --version also failed. ` +
      'Install the grok CLI or set GROK_BINARY to its path.',
  );
}

async function runAuthProbe(
  binary: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<AuthProbe> {
  const result = await execProbe(binary, ['models'], timeoutMs, signal);

  if (result.outcome === 'spawn-failed') {
    return failAuth(missingBinaryProblem(binary));
  }

  if (!isSuccess(result)) {
    return failAuth(
      `${execProblem('grok models', result)} Run \`grok login\` and verify with \`grok models\`.`,
    );
  }

  // Exit 0 is the authority. Unparseable or empty stdout still means authenticated.
  return Object.freeze({
    ok: true,
    models: Object.freeze(parseModels(result.stdout)),
    problem: null,
  });
}

function execProbe(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ExecResult> {
  return execGrok({ binary, args, timeoutMs, signal });
}

function cappedTimeoutMs(timeoutMs: number): number {
  return Math.min(timeoutMs, PROBE_TIMEOUT_CAP_MS);
}

function isSuccess(result: ExecResult): boolean {
  return result.outcome === 'exited' && result.code === 0;
}

function isNonZeroExit(result: ExecResult): boolean {
  return result.outcome === 'exited' && result.code !== null && result.code !== 0;
}

function firstLine(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return null;
}

/** `  * grok-4.6 (default)` — marker, id, then an optional parenthetical annotation. */
const BULLET_LINE = /^[-*\u2022]\s+(\S+)(?:\s+\([^)]*\))?\s*$/;

/**
 * Pull model ids out of `grok models`.
 *
 * Verified against grok 1.0.0 on 2026-08-16, which prints a login line, a default-model line, an
 * `Available models:` header, and then one bullet per id:
 *
 * ```
 * You are logged in with grok.com.
 *
 * Default model: grok-4.6
 *
 * Available models:
 *   * grok-4.6 (default)
 *   - grok-4.5
 * ```
 *
 * Only the bullets are ids, so only bullets are collected. The earlier keep-everything-that-is-not-
 * obviously-a-header approach reported "You are logged in with grok.com." as a model id. Reading no
 * ids at all is the honest outcome if the format changes: `probeAuth` still reports ok, because the
 * exit code is the authority and this text is not a contract.
 */
function parseModels(stdout: string): string[] {
  const models: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const id = BULLET_LINE.exec(raw.trim())?.[1];
    if (id !== undefined) models.push(id);
  }
  return models;
}

function missingBinaryProblem(binary: string): string {
  return `Could not execute "${binary}". ` + 'Install the grok CLI or set GROK_BINARY to its path.';
}

function execProblem(command: string, result: ExecResult): string {
  switch (result.outcome) {
    case 'timeout':
      return `${command} timed out after ${Math.round(result.durationMs)} ms.`;
    case 'aborted':
      return `${command} was cancelled.`;
    case 'spawn-failed':
      return missingBinaryProblem('grok');
    case 'exited':
      return `${command} exited with code ${result.code ?? 'unknown'}.`;
    default: {
      const unreachable: never = result.outcome;
      return `${command} failed (${String(unreachable)}).`;
    }
  }
}

function unexpectedProblem(command: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${command} failed unexpectedly: ${message}. Install the grok CLI or set GROK_BINARY to its path.`;
}

function okVersion(version: string | null): VersionProbe {
  return Object.freeze({ ok: true, version, problem: null });
}

function failVersion(problem: string): VersionProbe {
  return Object.freeze({ ok: false, version: null, problem });
}

function failAuth(problem: string): AuthProbe {
  return Object.freeze({ ok: false, models: Object.freeze([]), problem });
}
