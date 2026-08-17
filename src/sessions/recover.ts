/**
 * Recover the session a cancelled run actually created.
 *
 * grok reports `sessionId` only on the `end` event, and a SIGTERM'd run
 * never reaches one. The session is still on disk the whole time. Reading
 * it from the CLI's own store is the opposite of inventing a UUID — the
 * store is the source of truth. Two concurrent runs in the same directory
 * must not collapse to a confident wrong answer: resuming the wrong
 * session continues somebody else's work.
 */

import { log } from '../log.js';
import { resumeCommand, sessionsStartedDuring, type SessionRecord } from './select.js';
import { loadSessions } from './store.js';

export type CancelledSession =
  | { readonly kind: 'result'; readonly sessionId: string }
  | { readonly kind: 'store'; readonly sessionId: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly kind: 'none' };

export async function resolveCancelledSession(options: {
  readonly knownSessionId: string | null;
  readonly sessionsDir: string;
  readonly cwd: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}): Promise<CancelledSession> {
  if (options.knownSessionId !== null && options.knownSessionId !== '') {
    return { kind: 'result', sessionId: options.knownSessionId };
  }
  if (options.startedAt === null || options.endedAt === null) {
    return { kind: 'none' };
  }

  let matches: readonly SessionRecord[];
  try {
    const loaded = await loadSessions({
      sessionsDir: options.sessionsDir,
      cwd: options.cwd,
    });
    matches = sessionsStartedDuring(loaded.records, {
      startedAt: options.startedAt,
      endedAt: options.endedAt,
    });
  } catch (error: unknown) {
    // The run is already dead. A store we cannot read is not a reason to
    // fail stop — or status of a cancelled run. Report what we have.
    log.warn('session store unreadable while recovering a cancelled run', error);
    return { kind: 'none' };
  }
  if (matches.length === 0) return { kind: 'none' };
  const only = matches[0];
  if (matches.length === 1 && only !== undefined) {
    return { kind: 'store', sessionId: only.id };
  }

  // Never pick the newest. Two runs in the same directory at the same
  // time is exactly when a confident wrong answer costs the most.
  const candidates = Object.freeze(
    [...matches]
      .map((row) => row.id)
      .sort((left, right) => {
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
      }),
  );
  return { kind: 'ambiguous', candidates };
}

/**
 * Body lines for a resolved session. Resume is omitted when the caller
 * already printed one (a late-result block that carried the id).
 */
export function sessionResolutionLines(
  resolved: CancelledSession,
  announceResume: boolean,
): readonly string[] {
  switch (resolved.kind) {
    case 'result':
    case 'store':
      if (!announceResume) return [];
      return Object.freeze(['Resume with:', `  ${resumeCommand(resolved.sessionId)}`]);
    case 'ambiguous':
      return Object.freeze([
        "The run's session could not be identified uniquely. Candidates:",
        ...resolved.candidates.map((id) => `  ${id}`),
      ]);
    case 'none':
      return [];
    default: {
      const unreachable: never = resolved;
      throw new Error(`unhandled session resolution: ${String(unreachable)}`);
    }
  }
}

export function sessionResolutionMeta(
  resolved: CancelledSession,
): Readonly<Record<string, unknown>> {
  switch (resolved.kind) {
    case 'result':
    case 'store':
      return Object.freeze({
        sessionId: resolved.sessionId,
        sessionIdSource: resolved.kind,
      });
    case 'ambiguous':
      return Object.freeze({ sessionCandidates: resolved.candidates });
    case 'none':
      return Object.freeze({});
    default: {
      const unreachable: never = resolved;
      throw new Error(`unhandled session resolution: ${String(unreachable)}`);
    }
  }
}
