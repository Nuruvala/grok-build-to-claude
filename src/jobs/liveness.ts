/**
 * Process liveness for background-run records.
 *
 * `status` uses this only to decide what to display — it does not write.
 * The retention sweep uses the same judgement to delete a dead non-terminal
 * record that has aged out, which is the one path allowed to act on it.
 */

import { processAlive } from './kill.js';
import { applyPatch, isTerminal, type RunRecord } from './record.js';

/**
 * A record still in `starting` with no workerPid may simply not have been
 * patched yet. Only treat a null-pid record as abandoned after this grace.
 */
export const STARTUP_GRACE_MS = 30_000;

export function isOrphan(record: RunRecord, nowMs: number): boolean {
  if (isTerminal(record.state)) return false;
  if (record.workerPid !== null) {
    return !processAlive(record.workerPid);
  }
  const created = Date.parse(record.createdAt);
  if (!Number.isFinite(created)) return false;
  return nowMs - created > STARTUP_GRACE_MS;
}

/** Live = not terminal and not an orphan. Both judgements already live here. */
export function countLiveRuns(records: readonly RunRecord[], nowMs: number): number {
  return records.filter((record) => !isTerminal(record.state) && !isOrphan(record, nowMs)).length;
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
