/**
 * Terminate a background run's process tree.
 *
 * The worker is a process-group leader (spawned `detached`) and it spawns grok
 * with `detached: false`, so grok is in the worker's group. One group signal
 * is the whole tree. SIGTERM first so a well-behaved worker can close its log
 * appenders and let `execGrok` reap its child; SIGKILL only if that fails.
 */

import { setTimeout as delay } from 'node:timers/promises';

export const STOP_GRACE_MS = 3000;
const DEFAULT_POLL_MS = 100;

export interface KillOutcome {
  readonly signalsSent: readonly string[];
  readonly alive: boolean;
  readonly reason: 'gone' | 'terminated' | 'killed' | 'survived' | 'no-pid' | 'not-permitted';
}

/**
 * ESRCH: really gone. EPERM: alive but owned by another user — alive is the
 * safe reading, because declaring a live run dead is the worse error of the
 * two.
 *
 * Caveat: pids are recycled, so a long-dead run can look alive. That
 * direction is merely stale, and the next status call after the recycled
 * pid exits corrects it.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== 'ESRCH';
  }
}

/**
 * Whether anyone remains in the process group. `process.kill(-pid, 0)`
 * raises ESRCH only when the group is empty, so a dead leader with a live
 * grandchild still reads as alive. That is the question `stop` must ask:
 * signalling `-pid` is wasted if we then poll the leader and call the tree
 * dead while grok keeps spending.
 *
 * Windows has no POSIX process groups; fall back to the single-pid check
 * and the same grandchild caveat `sendSignal` already carries.
 */
export function processGroupAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    return processAlive(pid);
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== 'ESRCH';
  }
}

export async function terminateRun(
  workerPid: number | null,
  options?: {
    readonly graceMs?: number;
    readonly pollMs?: number;
  },
): Promise<KillOutcome> {
  // A pid of 0 or below is `no-pid`, not a target. POSIX reads `kill(-0, sig)`
  // as "signal my own process group", so a corrupt `workerPid: 0` in a record
  // would make stop kill this server and everything it spawned. The writers
  // all guard against it; this is the last line, because the consequence is
  // not proportionate to the odds.
  if (workerPid === null || !Number.isInteger(workerPid) || workerPid <= 0) {
    // We did not look. Treating unknown as dead is how a live tree gets
    // recorded as cancelled.
    return freezeOutcome({ signalsSent: [], alive: true, reason: 'no-pid' });
  }

  const graceMs = options?.graceMs ?? STOP_GRACE_MS;
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;

  const first = sendSignal(workerPid, 'SIGTERM');
  if (first === 'esrch') {
    return freezeOutcome({ signalsSent: [], alive: false, reason: 'gone' });
  }
  if (first === 'eperm') {
    return freezeOutcome({ signalsSent: ['SIGTERM'], alive: true, reason: 'not-permitted' });
  }

  if (await waitUntilGone(workerPid, graceMs, pollMs)) {
    return freezeOutcome({ signalsSent: ['SIGTERM'], alive: false, reason: 'terminated' });
  }

  const second = sendSignal(workerPid, 'SIGKILL');
  if (second === 'eperm') {
    return freezeOutcome({
      signalsSent: ['SIGTERM', 'SIGKILL'],
      alive: true,
      reason: 'not-permitted',
    });
  }

  // One more poll, not another grace window: SIGKILL is not something a
  // well-behaved process needs time to honour.
  await delay(pollMs);
  if (!processGroupAlive(workerPid)) {
    return freezeOutcome({ signalsSent: ['SIGTERM', 'SIGKILL'], alive: false, reason: 'killed' });
  }
  return freezeOutcome({ signalsSent: ['SIGTERM', 'SIGKILL'], alive: true, reason: 'survived' });
}

type SignalSend = 'sent' | 'esrch' | 'eperm';

function sendSignal(pid: number, signal: NodeJS.Signals): SignalSend {
  try {
    if (process.platform === 'win32') {
      // Windows has no POSIX process-group kill. A non-detached child is not a
      // group leader either — `kill(-pid)` fails ESRCH and silently kills nothing.
      // process.kill(pid) is the fallback; grandchildren started independently of
      // the job object may survive.
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
    return 'sent';
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ESRCH') return 'esrch';
    if (code === 'EPERM') return 'eperm';
    throw error;
  }
}

async function waitUntilGone(pid: number, graceMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (processGroupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    const remaining = deadline - Date.now();
    await delay(Math.min(pollMs, Math.max(0, remaining)));
  }
  return true;
}

function freezeOutcome(outcome: KillOutcome): KillOutcome {
  return Object.freeze({
    ...outcome,
    signalsSent: Object.freeze([...outcome.signalsSent]),
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}
