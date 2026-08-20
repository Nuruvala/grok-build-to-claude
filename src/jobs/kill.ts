/**
 * Terminate a background run's process tree.
 *
 * The worker is a process-group leader (spawned `detached`) and it spawns grok
 * with `detached: false`, so grok is in the worker's group. One group signal
 * is the whole tree. SIGTERM first so a well-behaved worker can close its log
 * appenders and let `execGrok` reap its child; SIGKILL only if that fails.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export const STOP_GRACE_MS = 3000;
const DEFAULT_POLL_MS = 100;

export interface KillOutcome {
  readonly signalsSent: readonly string[];
  readonly alive: boolean;
  readonly reason: 'gone' | 'terminated' | 'killed' | 'survived' | 'no-pid' | 'not-permitted';
}

/** Linux `/proc/<pid>/stat` fields this module actually uses. */
export interface ProcPidStat {
  readonly state: string;
  readonly pgrp: number;
}

/**
 * Whether a process group still has anyone who can run.
 *
 * `unreadable` is "we looked and found nobody", which is not the same as
 * "everyone we found is a zombie". Declaring a live run dead is the worse
 * error, so the caller treats unreadable as alive unless a later `kill(-pid, 0)`
 * says the group is gone.
 */
export type GroupVerdict = 'live' | 'zombies-only' | 'unreadable';

/**
 * Parse `/proc/<pid>/stat`. Field 2 is the executable name in parentheses and
 * may itself contain spaces and parentheses, so the split is on the last `)`,
 * not on whitespace. Field 3 is the state character; field 5 is the pgid.
 */
export function parseProcPidStat(contents: string): ProcPidStat | null {
  const close = contents.lastIndexOf(')');
  if (close === -1) return null;
  const rest = contents.slice(close + 1).trim();
  if (rest === '') return null;
  const fields = rest.split(/\s+/);
  const stateToken = fields[0];
  const pgrpToken = fields[2];
  if (stateToken === undefined || stateToken === '') return null;
  if (pgrpToken === undefined) return null;
  const pgrp = Number.parseInt(pgrpToken, 10);
  if (!Number.isInteger(pgrp)) return null;
  return Object.freeze({ state: stateToken.charAt(0), pgrp });
}

/**
 * Fold already-parsed `/proc/<pid>/stat` rows for one process group. Pure so
 * the zombie/live/empty cases do not need a real process table.
 */
export function groupVerdictFromMembers(
  pgid: number,
  members: readonly ProcPidStat[],
): GroupVerdict {
  let sawMember = false;
  for (const member of members) {
    if (member.pgrp !== pgid) continue;
    sawMember = true;
    if (member.state !== 'Z') return 'live';
  }
  return sawMember ? 'zombies-only' : 'unreadable';
}

/**
 * ESRCH: really gone. EPERM: alive but owned by another user, so alive is the
 * safe reading, because declaring a live run dead is the worse error of the
 * two. A zombie owned by another user is still a zombie: `kill(pid, 0)`
 * succeeds against one, so Linux liveness also reads `/proc/<pid>/stat` and
 * treats state `Z` as dead.
 *
 * Caveat: pids are recycled, so a long-dead run can look alive. That
 * direction is merely stale, and the next status call after the recycled
 * pid exits corrects it.
 *
 * Non-Linux platforms have no `/proc`. We keep today's `kill(pid, 0)`
 * behaviour there rather than shelling out to `ps` on the hot path.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error: unknown) {
    if (errorCode(error) === 'ESRCH') return false;
    // EPERM and anything else: the pid exists. Fall through so a zombie we
    // can still see in /proc is not reported as a live run we cannot stop.
  }
  if (process.platform === 'linux' && linuxPidIsZombie(pid)) return false;
  return true;
}

/**
 * Whether anyone remains in the process group. `process.kill(-pid, 0)`
 * raises ESRCH only when the group is empty, so a dead leader with a live
 * grandchild still reads as alive. That is the question `stop` must ask:
 * signalling `-pid` is wasted if we then poll the leader and call the tree
 * dead while grok keeps spending.
 *
 * A group of nothing but zombies is empty for this purpose: a zombie cannot
 * be signalled and never goes away on its own, which is how `stop` used to
 * report `survived` for a tree that had already died.
 *
 * Windows has no POSIX process groups; fall back to the single-pid check
 * and the same grandchild caveat `sendSignal` already carries. Other
 * non-Linux platforms have no `/proc`, so a successful `kill(-pid, 0)` still
 * counts as alive, the same as today.
 */
export function processGroupAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    return processAlive(pid);
  }
  if (!processGroupExists(pid)) return false;
  if (process.platform !== 'linux') return true;
  const verdict = linuxGroupVerdict(pid);
  if (verdict === 'live') return true;
  if (verdict === 'zombies-only') return false;
  // Found no members. The group existed a moment ago: if it is gone now the
  // tree exited during the scan; if it is still signalable we could not see
  // its members (hidepid, a tight race) and alive is the safe reading.
  return processGroupExists(pid);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== 'ESRCH';
  }
}

function linuxPidIsZombie(pid: number): boolean {
  const stat = readProcPidStat(pid);
  return stat !== null && stat.state === 'Z';
}

function linuxGroupVerdict(pgid: number): GroupVerdict {
  return groupVerdictFromMembers(pgid, readProcPidStats());
}

function readProcPidStats(): readonly ProcPidStat[] {
  const stats: ProcPidStat[] = [];
  for (const pid of listProcPids()) {
    const stat = readProcPidStat(pid);
    if (stat !== null) stats.push(stat);
  }
  return stats;
}

function listProcPids(): readonly number[] {
  try {
    const names = readdirSync('/proc');
    const pids: number[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number.parseInt(name, 10);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

function readProcPidStat(pid: number): ProcPidStat | null {
  try {
    return parseProcPidStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
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
