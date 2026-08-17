/**
 * Pure selection over session records: labels, recency order, query match,
 * the resume command we advertise, and the time-window predicate used to
 * recover a session a stopped run created.
 *
 * No filesystem. A label our fallback invented is never reported as a title
 * Grok wrote — `source` exists so the caller can tell the two apart. The
 * same honesty applies to a recovered session id: this module only selects
 * among records the store already has, it never invents one.
 */

import type { SessionSummary } from './summary.js';

export interface SessionRecord extends SessionSummary {
  /** Absolute path of the session directory. */
  readonly dir: string;
  readonly summaryAvailable: boolean;
  /** Filled in only for records we actually read a history for. */
  readonly firstPrompt: string | null;
}

export type LabelSource = 'title' | 'prompt' | 'none';

export interface SessionLabel {
  readonly text: string;
  readonly source: LabelSource;
}

const LABEL_CHAR_CAP = 120;
const UNTITLED = '(untitled)';

export function labelFor(record: SessionRecord): SessionLabel {
  if (record.title !== null) {
    return freezeLabel({ text: formatLabelText(record.title), source: 'title' });
  }
  if (record.firstPrompt !== null) {
    return freezeLabel({ text: formatLabelText(record.firstPrompt), source: 'prompt' });
  }
  return freezeLabel({ text: UNTITLED, source: 'none' });
}

export function sortByRecency(records: readonly SessionRecord[]): readonly SessionRecord[] {
  return Object.freeze(
    [...records].sort((left, right) => {
      // Compare, do not subtract: -Infinity - -Infinity is NaN, and a NaN
      // compare function is not a total order — two missing timestamps would
      // not reliably fall through to createdAt then id.
      const updated = compareDesc(recencyMs(left.updatedAt), recencyMs(right.updatedAt));
      if (updated !== 0) return updated;
      const created = compareDesc(recencyMs(left.createdAt), recencyMs(right.createdAt));
      if (created !== 0) return created;
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    }),
  );
}

export function matchesQuery(record: SessionRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  if (record.id.toLowerCase().includes(needle)) return true;
  if (record.title?.toLowerCase().includes(needle) === true) return true;
  if (record.firstPrompt?.toLowerCase().includes(needle) === true) return true;
  return false;
}

export function resumeCommand(id: string): string {
  return `grok -r ${id}`;
}

/**
 * Extra milliseconds allowed after `endedAt`, against clock granularity
 * rather than against a slow flush. Measured on a real stopped run:
 * `created_at` landed 0.283s after `startedAt` and 19.9s before `endedAt`,
 * because grok stamps it when it creates the session and we stamp endedAt
 * once the tree is dead — so an ordinary session cannot fall outside the
 * window at the top end. The slack costs nothing and covers a timestamp
 * source that does not agree with ours to the millisecond.
 *
 * What it deliberately does not fix: a run stopped in its first moments may
 * have a session directory with no readable `summary.json` yet. That is
 * file existence, not time, and it degrades to reporting no session — which
 * is the honest answer rather than a guessed one.
 */
export const SESSION_WINDOW_SLACK_MS = 5_000;

/**
 * Sessions whose `createdAt` parses and falls inside `[startedAt, endedAt]`.
 *
 * The lower bound is exact: the worker stamps `startedAt` before it spawns
 * grok, so a session belonging to this run is always created after it.
 * Negative slack would pull in a previous run in the same cwd. The upper
 * bound carries {@link SESSION_WINDOW_SLACK_MS} for the flush gap above.
 * Unparseable `createdAt` never qualifies — absent evidence is not evidence.
 * An unparseable window bound yields nothing for the same reason.
 */
export function sessionsStartedDuring(
  records: readonly SessionRecord[],
  window: { readonly startedAt: string; readonly endedAt: string },
): readonly SessionRecord[] {
  const startMs = parseIsoMs(window.startedAt);
  const endMs = parseIsoMs(window.endedAt);
  if (startMs === null || endMs === null) {
    return Object.freeze([]);
  }
  const latest = endMs + SESSION_WINDOW_SLACK_MS;
  return Object.freeze(
    records.filter((record) => {
      const created = parseIsoMs(record.createdAt);
      if (created === null) return false;
      return created >= startMs && created <= latest;
    }),
  );
}

function formatLabelText(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= LABEL_CHAR_CAP) return collapsed;
  return `${collapsed.slice(0, LABEL_CHAR_CAP)}…`;
}

/**
 * Unparseable and missing timestamps sort last under a descending compare by
 * collapsing to -Infinity. Date.parse is the whole contract — we do not guess
 * at formats the CLI has not been seen to emit.
 */
function recencyMs(iso: string | null): number {
  return parseIsoMs(iso) ?? Number.NEGATIVE_INFINITY;
}

function parseIsoMs(iso: string | null): number | null {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareDesc(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function freezeLabel(label: SessionLabel): SessionLabel {
  return Object.freeze(label);
}
