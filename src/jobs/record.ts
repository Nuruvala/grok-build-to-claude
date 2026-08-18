/**
 * Pure shapes and transforms for a background-run record.
 *
 * No fs, no child_process. Everything here is a function of its arguments.
 * Parsing follows the sessions/summary.ts rule: wrong type becomes null,
 * never a coercion.
 */

import { randomBytes } from 'node:crypto';

import { z } from 'zod';

export const RUN_STATES = [
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
  'abandoned',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RECORD_SCHEMA_VERSION = 1;
export const SUMMARY_MAX_CHARS = 160;

const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'abandoned',
]);

export interface StoredResult {
  readonly text: string;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

export interface RunRecord {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly tool: string;
  readonly summary: string;
  readonly state: RunState;
  readonly cwd: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly workerPid: number | null;
  readonly childPid: number | null;
  readonly argv: readonly string[] | null;
  readonly progressCount: number;
  readonly lastProgress: string | null;
  readonly lastProgressAt: string | null;
  readonly sessionId: string | null;
  readonly stopReason: string | null;
  readonly result: StoredResult | null;
  readonly error: string | null;
}

export type RunPatch = {
  readonly [K in keyof Omit<RunRecord, 'runId' | 'createdAt' | 'schemaVersion' | 'tool'>]?:
    RunRecord[K] | undefined;
};

/**
 * Sidecar written only by the worker. Kept off `record.json` so a `stop` from
 * the server cannot lose a terminal write to a progress rename.
 */
export interface RunProgress {
  readonly progressCount: number;
  readonly lastProgress: string | null;
  readonly lastProgressAt: string | null;
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isRunState(value: unknown): value is RunState {
  return typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value);
}

/**
 * A completed record whose CLI stop reason is not `end_turn` is a fragment,
 * not a clean finish. Failed/abandoned/cancelled have their own labels.
 */
export function isCutOff(record: Pick<RunRecord, 'state' | 'stopReason'>): boolean {
  return (
    record.state === 'completed' && record.stopReason !== null && record.stopReason !== 'end_turn'
  );
}

/**
 * Inverse of the time prefix in `newRunId`. Used by the retention sweep to
 * age-filter directory names without opening every `record.json`.
 */
export function timestampFromRunId(runId: string): number | null {
  const stamp = runId.split('-')[0];
  if (stamp === undefined || stamp === '') return null;
  const ms = Number.parseInt(stamp, 36);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * `<base36 ms>-<8 hex>`. Time-prefixed so a plain lexicographic sort of the
 * directory names is a recency sort: listing recent runs then costs one
 * `readdir` and no `stat`. The stamp is padded to 8 characters so the
 * ordering does not break at a digit boundary.
 *
 * The upper bound is slack for future timestamps, not a guess at a limit;
 * base36 milliseconds are 8 characters until the year 5000.
 */
export const RUN_ID_PATTERN = /^[0-9a-z]{8,16}-[0-9a-f]{8}$/;

export const RunIdSchema = z
  .string()
  .regex(RUN_ID_PATTERN)
  .describe(
    'Background-run id (`<base36 ms>-<8 hex>`), from a background grok, review, or websearch result.',
  );

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

export function newRunId(now: number, random?: () => string): string {
  const stamp = Math.trunc(now).toString(36).padStart(8, '0');
  const suffix = (random ?? defaultRandom)().slice(0, 8);
  return `${stamp}-${suffix}`;
}

function defaultRandom(): string {
  return randomBytes(4).toString('hex');
}

/**
 * The `unknown` boundary. Returns `null` when the value is not an object, when
 * `runId`/`state`/`createdAt` are missing or the wrong type, or when
 * `schemaVersion` is a number greater than `RECORD_SCHEMA_VERSION` (a record
 * written by a newer build: refuse to guess at it).
 *
 * `fallbackRunId` is the directory name the caller already knows. Schema v1
 * does not substitute it for a missing `runId` — a job record that does not
 * identify itself is corrupt, not a session-style incomplete summary.
 */
export function parseRunRecord(value: unknown, fallbackRunId: string): RunRecord | null {
  if (!isRecord(value)) return null;

  const runId = stringField(value, 'runId');
  if (runId === null) return null;
  // Touch the directory name so a renamed folder cannot silently re-identify
  // a record: the file is the authority, and a missing id already returned.
  void fallbackRunId;

  const stateValue = value['state'];
  if (!isRunState(stateValue)) return null;

  const createdAt = stringField(value, 'createdAt');
  if (createdAt === null) return null;

  const schemaVersion = numberField(value, 'schemaVersion');
  if (schemaVersion !== null && schemaVersion > RECORD_SCHEMA_VERSION) return null;

  return freezeRecord({
    schemaVersion: schemaVersion ?? RECORD_SCHEMA_VERSION,
    runId,
    tool: stringField(value, 'tool') ?? '',
    summary: stringField(value, 'summary') ?? '',
    state: stateValue,
    cwd: stringField(value, 'cwd') ?? '',
    createdAt,
    startedAt: stringField(value, 'startedAt'),
    endedAt: stringField(value, 'endedAt'),
    workerPid: numberField(value, 'workerPid'),
    childPid: numberField(value, 'childPid'),
    argv: stringList(value['argv']),
    progressCount: numberField(value, 'progressCount') ?? 0,
    lastProgress: stringField(value, 'lastProgress'),
    lastProgressAt: stringField(value, 'lastProgressAt'),
    sessionId: stringField(value, 'sessionId'),
    stopReason: stringField(value, 'stopReason'),
    result: parseStoredResult(value['result']),
    error: stringField(value, 'error'),
  });
}

/** First non-empty line, collapsed whitespace, cut to SUMMARY_MAX_CHARS with a trailing `…`. */
export function summarize(text: string): string {
  const lines = text.split(/\r?\n/);
  let first = '';
  for (const line of lines) {
    if (line.trim() !== '') {
      first = line;
      break;
    }
  }
  const collapsed = first.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= SUMMARY_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

/** Overlay a progress sidecar onto a record for display. Does not persist. */
export function mergeProgress(record: RunRecord, progress: RunProgress | null): RunRecord {
  if (progress === null) return record;
  return applyPatch(record, {
    progressCount: progress.progressCount,
    lastProgress: progress.lastProgress,
    lastProgressAt: progress.lastProgressAt,
  });
}

export function parseRunProgress(value: unknown): RunProgress | null {
  if (!isRecord(value)) return null;
  const progressCount = numberField(value, 'progressCount');
  // An absent sidecar is already null and leaves the record alone. A
  // present-but-broken one must be null too — defaulting a missing count
  // to 0 would overlay a fake zero onto display through mergeProgress.
  if (progressCount === null) return null;
  return Object.freeze({
    progressCount,
    lastProgress: stringField(value, 'lastProgress'),
    lastProgressAt: stringField(value, 'lastProgressAt'),
  });
}

/** Pure merge. `undefined` values are ignored so omission never blanks a field. */
export function applyPatch(record: RunRecord, patch: RunPatch): RunRecord {
  const next: RunRecord = {
    schemaVersion: record.schemaVersion,
    runId: record.runId,
    tool: record.tool,
    summary: patch.summary ?? record.summary,
    state: patch.state ?? record.state,
    cwd: patch.cwd ?? record.cwd,
    createdAt: record.createdAt,
    startedAt: pick(patch.startedAt, record.startedAt),
    endedAt: pick(patch.endedAt, record.endedAt),
    workerPid: pick(patch.workerPid, record.workerPid),
    childPid: pick(patch.childPid, record.childPid),
    argv: pick(patch.argv, record.argv),
    progressCount: patch.progressCount ?? record.progressCount,
    lastProgress: pick(patch.lastProgress, record.lastProgress),
    lastProgressAt: pick(patch.lastProgressAt, record.lastProgressAt),
    sessionId: pick(patch.sessionId, record.sessionId),
    stopReason: pick(patch.stopReason, record.stopReason),
    result: pick(patch.result, record.result),
    error: pick(patch.error, record.error),
  };
  return freezeRecord(next);
}

function pick<T>(patchValue: T | undefined, current: T): T {
  if (patchValue === undefined) return current;
  return patchValue;
}

export function parseStoredResult(value: unknown): StoredResult | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const metaValue = value['meta'];
  return Object.freeze({
    text: typeof value['text'] === 'string' ? value['text'] : '',
    meta: isRecord(metaValue) ? Object.freeze({ ...metaValue }) : Object.freeze({}),
    isError: typeof value['isError'] === 'boolean' ? value['isError'] : false,
  });
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  if (!value.every((entry): entry is string => typeof entry === 'string')) return null;
  return Object.freeze([...value]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeRecord(record: RunRecord): RunRecord {
  return Object.freeze({
    ...record,
    argv: record.argv === null ? null : Object.freeze([...record.argv]),
    result:
      record.result === null
        ? null
        : Object.freeze({
            text: record.result.text,
            meta: Object.freeze({ ...record.result.meta }),
            isError: record.result.isError,
          }),
  });
}
