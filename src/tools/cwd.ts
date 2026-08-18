/**
 * Caller-supplied working directory.
 *
 * A relative cwd is resolved against the server's own working directory, which
 * is whatever the MCP client happened to launch it from. The caller does not
 * control that, cannot predict it, and a silent resolve produces a run against
 * the wrong tree that still reports success. So a supplied cwd must be
 * absolute, and must name an existing directory, before we pass it to spawn.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { InvalidArgumentsError } from '../errors.js';

/** Pure. A caller-supplied cwd must be absolute — see the module header for why. */
export function isUsableCwdShape(value: string): boolean {
  return path.isAbsolute(value);
}

/** Imperative. Throws when `cwd` is not an existing directory. `undefined` is not an error. */
export async function assertUsableCwd(cwd: string | undefined, tool: string): Promise<void> {
  if (cwd === undefined) return;

  // The `stat` sits alone in the try so its catch cannot also swallow the
  // not-a-directory throw below and re-report it as a filesystem failure.
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(cwd)).isDirectory();
  } catch (error: unknown) {
    throw new InvalidArgumentsError(tool, [describeStatFailure(cwd, errorCode(error))]);
  }

  if (!isDirectory) {
    throw new InvalidArgumentsError(tool, [`cwd "${cwd}" is not a directory.`]);
  }
}

/**
 * ENOENT and ENOTDIR are the two a caller can act on and get distinct wording;
 * anything else (EACCES, ELOOP) names its code rather than guessing at a cause.
 */
function describeStatFailure(cwd: string, code: string | undefined): string {
  if (code === 'ENOENT') return `cwd "${cwd}" does not exist.`;
  if (code === 'ENOTDIR') return `cwd "${cwd}" is not a directory.`;
  return `cwd "${cwd}" could not be read (${code ?? 'unknown error'}).`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}
