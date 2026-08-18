/**
 * `sessions` — list and inspect Grok sessions from the local on-disk store.
 *
 * Reads `$GROK_HOME/sessions`. Does not spawn `grok sessions list` (no `--json`,
 * cwd-scoped table) and does not consult the remote search index. An id lookup
 * that answers "no" is a successful answer, not a tool failure.
 */

import path from 'node:path';

import { z } from 'zod';

import { formatSessionDetail, formatSessionList } from '../../sessions/format.js';
import {
  labelFor,
  matchesQuery,
  resumeCommand,
  sortByRecency,
  type SessionRecord,
} from '../../sessions/select.js';
import {
  attachFirstPrompt,
  attachFirstPrompts,
  findSessionById,
  loadSessions,
  PROMPT_SCAN_CAP,
  type LoadedSessions,
} from '../../sessions/store.js';
import { defineTool } from '../../types.js';
import type { ToolContext, ToolResult } from '../../types.js';

const DEFAULT_LIMIT = 20;

const SessionsInput = z
  .strictObject({
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Case-insensitive substring over title, first prompt, and id. Search is local-only: it does not consult `grok sessions search` or any remote index.',
      ),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Keep only sessions that *started* in this directory. Resume still works from anywhere (`grok -r <id>`).',
      ),
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Exact session id lookup. Ignores query, cwd, and limit. Falls back to a case-insensitive match.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum rows to return. Default 20. Ignored when `id` is set.'),
  })
  .describe('List or inspect local Grok Build sessions.')
  .meta({ title: 'SessionsInput' });

type SessionsInput = z.output<typeof SessionsInput>;

export const sessionsTool = defineTool({
  name: 'sessions',
  title: 'List Grok sessions',
  description:
    'List and search Grok Build sessions from the local store ($GROK_HOME/sessions). ' +
    'Search is local-only: it does not consult `grok sessions search` or any remote index. ' +
    'Pass `id` for a single session, `query` for a case-insensitive substring over title, ' +
    'first prompt, and id, and `cwd` to keep only sessions that started in that directory. ' +
    "A reported id resumes from any directory with `grok -r <id>` or the grok tool's `resume` argument.",
  schema: SessionsInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (input: SessionsInput, ctx: ToolContext): Promise<ToolResult> => {
    const sessionsDir = ctx.config.sessionsDir;
    const limit = input.limit ?? DEFAULT_LIMIT;

    if (input.id !== undefined) {
      return lookupById(input.id, ctx, limit);
    }

    const cwd = input.cwd === undefined ? undefined : path.resolve(input.cwd);
    const loaded = await loadSessions({
      sessionsDir,
      ...(cwd === undefined ? {} : { cwd }),
    });

    if (
      loaded.storeMissing ||
      (loaded.records.length === 0 && input.query === undefined && input.cwd === undefined)
    ) {
      return toolResult({
        text:
          'No Grok sessions exist yet.\n\n' +
          `A grok tool call creates one. The store is at ${sessionsDir}.`,
        rows: [],
        matched: 0,
        loaded,
        scope: cwd ?? null,
        query: input.query ?? null,
        limit,
        ctx,
      });
    }

    const sorted = sortByRecency(loaded.records);
    const selected = await selectRows(sorted, input.query, limit);
    const context = {
      scope: cwd ?? null,
      query: input.query ?? null,
      matched: selected.matched,
      limit,
      scanned: loaded.scanned,
      skipped: loaded.skipped,
      unreadable: loaded.unreadable,
      unlistedDirs: loaded.unlistedDirs,
      promptSearchTruncated: selected.promptSearchTruncated,
      promptSearchScanned: selected.promptSearchScanned,
      sessionsDir,
    };

    return toolResult({
      text: formatSessionList(selected.rows, context),
      rows: selected.rows,
      matched: selected.matched,
      loaded,
      scope: context.scope,
      query: context.query,
      limit,
      ctx,
      promptSearchTruncated: selected.promptSearchTruncated,
      promptSearchScanned: selected.promptSearchScanned,
    });
  },
});

async function lookupById(id: string, ctx: ToolContext, limit: number): Promise<ToolResult> {
  const found = await findSessionById(ctx.config.sessionsDir, id);
  if (found === null) {
    return toolResult({
      text:
        `No session with id "${id}" was found in ${ctx.config.sessionsDir}.\n\n` +
        'Call sessions with no arguments to list what is there.',
      rows: [],
      matched: 0,
      loaded: {
        scanned: 0,
        skipped: 0,
        unreadable: 0,
        unlistedDirs: 0,
        storeMissing: false,
      },
      scope: null,
      query: null,
      limit,
      ctx,
      found: false,
    });
  }

  const record = await attachFirstPrompt(found);
  return toolResult({
    text: formatSessionDetail(record),
    rows: [record],
    matched: 1,
    loaded: {
      scanned: 1,
      skipped: 0,
      unreadable: found.summaryAvailable ? 0 : 1,
      unlistedDirs: 0,
      storeMissing: false,
    },
    scope: null,
    query: null,
    limit,
    ctx,
    found: true,
  });
}

async function selectRows(
  sorted: readonly SessionRecord[],
  query: string | undefined,
  limit: number,
): Promise<{
  readonly rows: readonly SessionRecord[];
  readonly matched: number;
  readonly promptSearchTruncated: boolean;
  readonly promptSearchScanned: number;
}> {
  if (query === undefined) {
    const limited = sorted.slice(0, limit);
    return {
      rows: await attachFirstPrompts(limited),
      matched: sorted.length,
      promptSearchTruncated: false,
      promptSearchScanned: 0,
    };
  }

  // Title and id are already in memory — match them across every loaded
  // record. The cap exists to bound history opens, not matching, so only
  // the most recent PROMPT_SCAN_CAP records get a first-prompt read.
  const promptSearchTruncated = sorted.length > PROMPT_SCAN_CAP;
  const promptSearchScanned = Math.min(sorted.length, PROMPT_SCAN_CAP);
  const window = sorted.slice(0, PROMPT_SCAN_CAP);
  const withPrompts = await attachFirstPrompts(window);
  const byId = new Map(withPrompts.map((record) => [record.id, record]));

  const matched: SessionRecord[] = [];
  for (const record of sorted) {
    const candidate = byId.get(record.id) ?? record;
    if (matchesQuery(candidate, query)) matched.push(candidate);
  }
  return {
    rows: matched.slice(0, limit),
    matched: matched.length,
    promptSearchTruncated,
    promptSearchScanned,
  };
}

interface SessionToolPayload {
  readonly text: string;
  readonly rows: readonly SessionRecord[];
  readonly matched: number;
  readonly loaded: Pick<
    LoadedSessions,
    'scanned' | 'skipped' | 'unreadable' | 'unlistedDirs' | 'storeMissing'
  >;
  readonly scope: string | null;
  readonly query: string | null;
  readonly limit: number;
  readonly ctx: ToolContext;
  readonly found?: boolean | undefined;
  readonly promptSearchTruncated?: boolean | undefined;
  readonly promptSearchScanned?: number | undefined;
}

function toolResult(payload: SessionToolPayload): ToolResult {
  const meta: Record<string, unknown> = {
    sessions: payload.rows.map(sessionMeta),
    count: payload.rows.length,
    matched: payload.matched,
    limit: payload.limit,
    scope: payload.scope,
    query: payload.query,
    scanned: payload.loaded.scanned,
    skipped: payload.loaded.skipped,
    unreadable: payload.loaded.unreadable,
    unlistedDirs: payload.loaded.unlistedDirs,
    storeMissing: payload.loaded.storeMissing,
    sessionsDir: payload.ctx.config.sessionsDir,
  };
  if (payload.found !== undefined) {
    meta['found'] = payload.found;
  }
  if (payload.promptSearchTruncated === true) {
    meta['promptSearchTruncated'] = true;
    meta['promptSearchScanned'] = payload.promptSearchScanned;
  }

  const result: ToolResult = {
    content: [{ type: 'text', text: payload.text, _meta: Object.freeze(meta) }],
    isError: false,
  };
  if (payload.ctx.config.structuredContentEnabled) {
    result.structuredContent = Object.freeze({ ...meta });
  }
  return result;
}

function sessionMeta(record: SessionRecord): Readonly<Record<string, unknown>> {
  const label = labelFor(record);
  return Object.freeze({
    id: record.id,
    cwd: record.cwd,
    title: record.title,
    titleSource: label.source,
    label: label.text,
    firstPrompt: record.firstPrompt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    numMessages: record.numMessages,
    model: record.model,
    agent: record.agent,
    sandboxProfile: record.sandboxProfile,
    effort: record.effort,
    gitBranch: record.gitBranch,
    headCommit: record.headCommit,
    gitRemotes: record.gitRemotes,
    path: record.dir,
    resumeCommand: resumeCommand(record.id),
  });
}
