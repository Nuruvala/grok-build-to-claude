/**
 * Parse a Grok session `summary.json` into a stable record.
 *
 * Pure: never throws, never returns null, never touches the filesystem. A
 * missing or unreadable summary still yields a record from the path fallbacks —
 * the directory name is the id we already know. Wrong types become null (or
 * `[]` for remotes), never coercions: a `num_messages` of `"12"` is not a
 * number, and inventing one would look like a real count.
 */

export interface SessionSummary {
  readonly id: string;
  readonly cwd: string;
  /** `generated_title`, else `session_summary`. Trimmed; `""` becomes null. */
  readonly title: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly numMessages: number | null;
  readonly model: string | null;
  readonly agent: string | null;
  readonly sandboxProfile: string | null;
  readonly effort: string | null;
  readonly gitBranch: string | null;
  readonly headCommit: string | null;
  readonly gitRemotes: readonly string[];
}

/**
 * @param value parsed JSON of summary.json, or undefined when it could not be read
 * @param fallbackId directory name — used when `info.id` is missing or not a string
 * @param fallbackCwd decoded parent directory name — used when `info.cwd` is missing or not a string
 */
export function parseSessionSummary(
  value: unknown,
  fallbackId: string,
  fallbackCwd: string,
): SessionSummary {
  if (!isRecord(value)) {
    return freezeSummary({
      id: fallbackId,
      cwd: fallbackCwd,
      title: null,
      createdAt: null,
      updatedAt: null,
      numMessages: null,
      model: null,
      agent: null,
      sandboxProfile: null,
      effort: null,
      gitBranch: null,
      headCommit: null,
      gitRemotes: [],
    });
  }

  const info = isRecord(value['info']) ? value['info'] : undefined;
  const id = stringField(info, 'id') ?? fallbackId;
  const cwd = stringField(info, 'cwd') ?? fallbackCwd;

  return freezeSummary({
    id,
    cwd,
    title: readTitle(value),
    createdAt: stringField(value, 'created_at'),
    updatedAt: stringField(value, 'updated_at'),
    numMessages: numberField(value, 'num_messages'),
    model: stringField(value, 'current_model_id'),
    agent: stringField(value, 'agent_name'),
    sandboxProfile: stringField(value, 'sandbox_profile'),
    effort: stringField(value, 'reasoning_effort'),
    gitBranch: stringField(value, 'head_branch'),
    headCommit: stringField(value, 'head_commit'),
    gitRemotes: stringList(value['git_remotes']),
  });
}

/**
 * `generated_title` wins when it is a non-empty string. An empty generated
 * title is treated as absent so a real `session_summary` is not hidden behind
 * a blank that the CLI has not filled in yet.
 */
function readTitle(record: Record<string, unknown>): string | null {
  const generated = trimmedString(record['generated_title']);
  if (generated !== null) return generated;
  return trimmedString(record['session_summary']);
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | null {
  if (record === undefined) return null;
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeSummary(summary: SessionSummary): SessionSummary {
  return Object.freeze({
    ...summary,
    gitRemotes: Object.freeze([...summary.gitRemotes]),
  });
}
