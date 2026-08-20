/**
 * Render background-run records as text a model (or a human) can scan.
 *
 * Pure: these take records and strings, never touch fs. Timestamps are UTC
 * at minute precision via `getUTC*`, never a locale format — a host-locale
 * stamp would make the same run look different in two places.
 */

import path from 'node:path';

import {
  isCutOff,
  isTerminal,
  type RunProgress,
  type RunRecord,
  type ToolCallTally,
} from './record.js';

/** `completed (cut off: cancelled)` so a fragment is not listed as a clean finish. */
export function formatRunState(record: RunRecord): string {
  if (isCutOff(record) && record.stopReason !== null) {
    return `completed (cut off: ${record.stopReason})`;
  }
  return record.state;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${pad2(seconds)}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${pad2(minutes)}m`;
}

export function formatRunHeader(shown: number, matched: number): string {
  return `Background runs: showing ${shown} of ${matched}`;
}

export function formatRunLine(record: RunRecord, nowMs: number): string {
  const elapsed = formatElapsed(elapsedMs(record, nowMs));
  return [record.runId, formatRunState(record), record.tool, elapsed, record.summary].join('  ');
}

export function formatRunDetail(
  record: RunRecord,
  nowMs: number,
  progress?: RunProgress | null,
  storePath?: string | null,
): string {
  const elapsed = formatElapsed(elapsedMs(record, nowMs));
  const lines = [
    `run ${record.runId}  ${formatRunState(record)}  ${record.tool}  ${elapsed}`,
    `  cwd:          ${record.cwd}`,
    `  created:      ${formatTimestamp(record.createdAt)}`,
    `  started:      ${formatTimestamp(record.startedAt)}`,
    `  workerPid:    ${formatPid(record.workerPid)}`,
    `  childPid:     ${formatPid(record.childPid)}`,
  ];
  if (storePath !== undefined && storePath !== null && storePath !== '') {
    lines.push(`  store:        ${storePath}`);
    if (needsRecoverablePointer(record)) {
      // Named so a caller who lost the model's write does not have to know
      // that background runs keep stdout.log. The file is already there;
      // this is a pointer, not a second read of it.
      lines.push(`  recoverable:  ${path.join(storePath, 'stdout.log')}`);
    }
  }
  if (!isTerminal(record.state)) {
    lines.push(`  last:         ${formatLastProgress(record, nowMs)}`);
    const toolsLine = formatToolCallLine(progress?.toolCalls, nowMs);
    if (toolsLine !== null) {
      lines.push(`  tools:        ${toolsLine}`);
    }
  }
  if (record.error !== null && record.error !== '') {
    lines.push(`  error:        ${record.error}`);
  }
  return lines.join('\n');
}

/**
 * Point at stdout.log when the stored result is missing, a fragment, or a
 * cancellation. A clean `end_turn` completion already has the answer in the
 * body; naming the log there is noise.
 */
function needsRecoverablePointer(record: RunRecord): boolean {
  if (!isTerminal(record.state)) return false;
  if (record.state !== 'completed') return true;
  return isCutOff(record) || record.result === null;
}

/** `"2026-08-16 21:50"` (UTC) or `"(unknown)"`. */
export function formatTimestamp(iso: string | null): string {
  if (iso === null) return '(unknown)';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '(unknown)';
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  const hour = pad2(date.getUTCHours());
  const minute = pad2(date.getUTCMinutes());
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function elapsedMs(record: RunRecord, nowMs: number): number {
  const start = Date.parse(record.createdAt);
  if (!Number.isFinite(start)) return 0;
  const end =
    record.endedAt !== null && Number.isFinite(Date.parse(record.endedAt))
      ? Date.parse(record.endedAt)
      : nowMs;
  return Math.max(0, end - start);
}

function formatLastProgress(record: RunRecord, nowMs: number): string {
  if (record.lastProgress === null || record.lastProgress === '') return '(none)';
  if (record.lastProgressAt === null) return record.lastProgress;
  const at = Date.parse(record.lastProgressAt);
  if (!Number.isFinite(at)) return record.lastProgress;
  return `${record.lastProgress}  (${formatElapsed(Math.max(0, nowMs - at))} ago)`;
}

/**
 * One line for a live run. `null` when the sidecar predates the tally, so a
 * missing count is not rendered as zero tools.
 */
export function formatToolCallLine(tally: ToolCallTally | undefined, nowMs: number): string | null {
  if (tally === undefined) return null;
  if (tally.total === 0) return '0';
  const labels = Object.keys(tally.byLabel).sort();
  const parts: string[] = [];
  for (const label of labels) {
    const count = tally.byLabel[label];
    if (count === undefined || count === 0) continue;
    parts.push(`${label} ${count}`);
  }
  const breakdown = parts.length > 0 ? `  ${parts.join(', ')}` : '';
  return `${tally.total}${breakdown}${formatLastToolCallAgo(tally.lastCallAt, nowMs)}`;
}

function formatLastToolCallAgo(iso: string | null, nowMs: number): string {
  if (iso === null) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  return `  (last ${formatElapsed(Math.max(0, nowMs - at))} ago)`;
}

function formatPid(pid: number | null): string {
  return pid === null ? '(none)' : String(pid);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
