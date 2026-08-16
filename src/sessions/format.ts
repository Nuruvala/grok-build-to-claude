/**
 * Render session records as text a model (or a human) can scan.
 *
 * Pure: nothing here writes to stdout. Timestamps are UTC at minute precision,
 * derived from Date UTC getters so the output does not depend on the host
 * locale. A silently partial list is the kind of thing this repo does not ship,
 * so skipped and unreadable counts belong in the header.
 */

import { labelFor, resumeCommand, type SessionRecord } from './select.js';

export interface ListContext {
  readonly scope: string | null;
  readonly query: string | null;
  readonly matched: number;
  readonly limit: number;
  readonly scanned: number;
  readonly skipped: number;
  readonly unreadable: number;
  /** Encoded-cwd directories whose children could not be listed. */
  readonly unlistedDirs: number;
  /** True when a query was given and first-prompt matching did not cover every loaded record. */
  readonly promptSearchTruncated: boolean;
  /** How many histories were opened for first-prompt matching. 0 when no query. */
  readonly promptSearchScanned: number;
  readonly sessionsDir: string;
}

export function formatSessionList(rows: readonly SessionRecord[], context: ListContext): string {
  const lines: string[] = [headerLine(rows.length, context)];
  if (
    context.skipped > 0 ||
    context.unreadable > 0 ||
    context.unlistedDirs > 0 ||
    context.promptSearchTruncated
  ) {
    lines.push(partialLine(context));
  }
  lines.push('');

  if (rows.length === 0) {
    lines.push(emptyLine(context));
  } else {
    const includeCwd = context.scope === null;
    for (const row of rows) {
      lines.push(formatListRow(row, includeCwd));
    }
  }

  lines.push('', resumeHint());
  return lines.join('\n');
}

export function formatSessionDetail(record: SessionRecord): string {
  const label = labelFor(record);
  const remotes = record.gitRemotes.length === 0 ? '(none)' : record.gitRemotes.join(', ');
  return [
    `Session ${record.id}`,
    `  label:        ${label.text} (${label.source})`,
    `  title:        ${record.title ?? '(none)'}`,
    `  first prompt: ${record.firstPrompt ?? '(none)'}`,
    `  cwd:          ${record.cwd}`,
    `  created:      ${formatTimestamp(record.createdAt)}`,
    `  updated:      ${formatTimestamp(record.updatedAt)}`,
    `  messages:     ${record.numMessages === null ? '(unknown)' : String(record.numMessages)}`,
    `  model:        ${record.model ?? '(unknown)'}`,
    `  agent:        ${record.agent ?? '(unknown)'}`,
    `  sandbox:      ${record.sandboxProfile ?? '(unknown)'}`,
    `  effort:       ${record.effort ?? '(unknown)'}`,
    `  branch:       ${record.gitBranch ?? '(unknown)'}`,
    `  commit:       ${record.headCommit ?? '(unknown)'}`,
    `  remotes:      ${remotes}`,
    `  path:         ${record.dir}`,
    '',
    `Resume with \`${resumeCommand(record.id)}\` from any directory, or pass resume: "${record.id}" to the grok tool.`,
  ].join('\n');
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

function headerLine(shown: number, context: ListContext): string {
  const where = context.scope === null ? 'Sessions' : `Sessions that started in ${context.scope}`;
  const search = context.query === null ? '' : ` matching ${JSON.stringify(context.query)}`;
  return `${where}${search}: showing ${shown} of ${context.matched} (limit ${context.limit}, scanned ${context.scanned})`;
}

function partialLine(context: ListContext): string {
  const bits: string[] = [];
  if (context.skipped > 0) {
    bits.push(
      `${context.skipped} session ${context.skipped === 1 ? 'directory was' : 'directories were'} not read (scan cap)`,
    );
  }
  if (context.unreadable > 0) {
    bits.push(
      `${context.unreadable} ${context.unreadable === 1 ? 'summary was' : 'summaries were'} missing or unreadable`,
    );
  }
  if (context.unlistedDirs > 0) {
    bits.push(
      `${context.unlistedDirs} project ${context.unlistedDirs === 1 ? 'directory' : 'directories'} could not be listed`,
    );
  }
  if (context.promptSearchTruncated) {
    bits.push(
      `first-prompt matching covered only the ${context.promptSearchScanned} most recent sessions`,
    );
  }
  return `Partial listing from ${context.sessionsDir}: ${bits.join('; ')}.`;
}

function emptyLine(context: ListContext): string {
  if (context.query !== null) {
    return `No sessions matched ${JSON.stringify(context.query)}.`;
  }
  if (context.scope !== null) {
    return `No sessions started in ${context.scope}.`;
  }
  return 'No sessions found.';
}

function formatListRow(record: SessionRecord, includeCwd: boolean): string {
  const label = labelFor(record);
  const parts = [
    record.id,
    formatTimestamp(record.updatedAt),
    record.numMessages === null ? '?' : String(record.numMessages),
    record.model ?? '-',
  ];
  if (includeCwd) parts.push(record.cwd);
  parts.push(label.text);
  return parts.join('  ');
}

function resumeHint(): string {
  return 'Resume with `grok -r <id>` from any directory, or pass resume: "<id>" to the grok tool.';
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
