/**
 * Process liveness for background-run records.
 *
 * `status` uses this only to decide what to display — it does not write.
 * The retention sweep uses the same judgement to delete a dead non-terminal
 * record that has aged out, which is the one path allowed to act on it.
 */

import { applyPatch, isTerminal, type RunRecord } from './record.js';

/**
 * A record still in `starting` with no workerPid may simply not have been
 * patched yet. Only treat a null-pid record as abandoned after this grace.
 */
export const STARTUP_GRACE_MS = 30_000;

/**
 * ESRCH: really gone. EPERM: alive but owned by another user — alive is the
 * safe reading, because declaring a live run dead is the worse error of the
 * two.
 *
 * Caveat: pids are recycled, so a long-dead run can look alive. That
 * direction is merely stale, and the next status call after the recycled
 * pid exits corrects it.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined;
    if (code === 'ESRCH') return false;
    return true;
  }
}

export function isOrphan(record: RunRecord, nowMs: number): boolean {
  if (isTerminal(record.state)) return false;
  if (record.workerPid !== null) {
    return !isProcessAlive(record.workerPid);
  }
  const created = Date.parse(record.createdAt);
  if (!Number.isFinite(created)) return false;
  return nowMs - created > STARTUP_GRACE_MS;
}

/** Derive an `abandoned` view of an orphan. Does not persist. */
export function displayRecord(record: RunRecord, nowMs: number, orphanError: string): RunRecord {
  if (!isOrphan(record, nowMs)) return record;
  return applyPatch(record, {
    state: 'abandoned',
    endedAt: record.endedAt ?? new Date(nowMs).toISOString(),
    error: orphanError,
  });
}
