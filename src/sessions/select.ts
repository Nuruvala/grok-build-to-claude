/**
 * Pure selection over session records: labels, recency order, query match,
 * and the resume command we advertise.
 *
 * No filesystem. A label our fallback invented is never reported as a title
 * Grok wrote — `source` exists so the caller can tell the two apart.
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
  if (iso === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareDesc(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function freezeLabel(label: SessionLabel): SessionLabel {
  return Object.freeze(label);
}
