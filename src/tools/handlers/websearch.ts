/**
 * `websearch` — research a question with Grok Build's web search.
 *
 * There are no web-search CLI flags (`grok --help` has only `--disable-web-search`).
 * Result-count and depth are prompt shaping only. Permission is forced to
 * read-only: a search never needs to write. The run is always
 * `--output-format streaming-json` because the search count and the source
 * list exist only in the stream.
 */

import { z } from 'zod';

import { buildGrokArgs } from '../../grok/args.js';
import { withPromptDelivery } from '../../grok/prompt-file.js';
import type { GrokRunResult } from '../../grok/result.js';
import { summarize } from '../../jobs/record.js';
import { startBackgroundRun } from '../../jobs/spawn.js';
import { ARGV_PATH_MAX, ARGV_TOKEN_MAX } from '../../limits.js';
import { permissionFlags } from '../../permission.js';
import { defineTool } from '../../types.js';
import type { ToolContext, ToolResult } from '../../types.js';
import { createSearchActivityCollector, type SearchActivity } from '../../websearch/citations.js';
import { buildWebSearchPrompt } from '../../websearch/prompt.js';
import type { SearchDepth } from '../../websearch/prompt.js';
import { runGrok } from '../run.js';
import type { GrokRunMeta } from '../run.js';

/**
 * Tools a web search must not use. Plan mode looks like it already forbids
 * these, but in headless mode a permission *prompt* is fatal: the CLI records
 * `permission_cancelled` and exits 0, and the model never gets to recover.
 * An explicit `--deny` is recoverable — verified against grok 1.0.4 on
 * 2026-08-17: given `--disable-web-search` the model tried `curl`, the deny
 * rule refused it, and it recovered via X search and finished with
 * `end_turn`. Do not drop these because plan + read-only already appear to
 * cover them.
 */
const WEBSEARCH_DENY_RULES: readonly string[] = Object.freeze(['Bash(*)', 'Edit(*)', 'Write(*)']);

const WebSearchInput = z
  .strictObject({
    query: z
      .string()
      .min(1)
      .describe('The question to research. Passed as the body of a web-search-shaped prompt.'),
    numResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Prompt-level target for how many distinct sources to cite, not a backend limit. The CLI has no `--num-results` flag.',
      ),
    searchDepth: z
      .enum(['basic', 'full'])
      .optional()
      .describe(
        'Prompt-level search depth. `basic` (default) asks for one round; `full` asks for more than one, from different angles. The CLI has no `--search-depth` flag.',
      ),
    instructions: z
      .string()
      .optional()
      .describe('Extra researcher guidance, appended verbatim to the prompt.'),
    // Same `.min(1)` reasoning as the `grok`/`review` tools: the argv builder
    // drops an empty `--cwd`, so `""` would silently search from wherever the
    // server lives.
    cwd: z
      .string()
      .min(1)
      .max(ARGV_PATH_MAX)
      .optional()
      .describe(
        'Working directory for the run. Passed as `--cwd`. Defaults to the current working directory.',
      ),
    model: z
      .string()
      .max(ARGV_TOKEN_MAX)
      .optional()
      .describe(
        'Model id to pass as `--model`. Omit to use the server default. Unknown ids are rejected by the CLI, not by this server.',
      ),
    effort: z
      .string()
      .max(ARGV_TOKEN_MAX)
      .optional()
      .describe(
        'Reasoning effort passed as `--effort`. Omit to use the server default. Values are passed through; the CLI rejects what the model does not advertise.',
      ),
    maxTurns: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Maximum agentic turns. Passed as `--max-turns`. Headless only. No default — a cap is how a run gets cut off mid-research.',
      ),
    background: z
      .boolean()
      .optional()
      .describe(
        'Run detached and return a runId immediately instead of waiting. Poll with the `status` tool. ' +
          'The run survives a restart of this MCP server. `false` is not a request.',
      ),
  })
  .describe('Web-search-shaped Grok Build run.')
  .meta({ title: 'WebSearchInput' });

type WebSearchInput = z.output<typeof WebSearchInput>;

const SEARCH_CUT_OFF_CLAUSE =
  'before producing a completed search, so nothing below is a finished result.';

export const websearchTool = defineTool({
  name: 'websearch',
  title: 'Search the web with Grok Build',
  description:
    "Research a question with Grok Build's web search. `numResults` and `searchDepth` shape " +
    'the prompt only — the CLI has no flags for either. Always runs read-only ' +
    '(`--permission-mode plan --sandbox read-only`) regardless of GROK_MCP_PERMISSION_CEILING — ' +
    'this tool has no permission, write, or yolo argument, because a search never needs to write. ' +
    'Never passes `--disable-web-search`.',
  schema: WebSearchInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (input: WebSearchInput, ctx: ToolContext): Promise<ToolResult> => {
    if (input.background === true) {
      return startBackgroundRun(
        {
          tool: 'websearch',
          input: { ...input },
          summary: summarize(input.query),
          cwd: input.cwd ?? process.cwd(),
        },
        ctx,
      );
    }

    const depth: SearchDepth = input.searchDepth ?? 'basic';
    const prompt = buildWebSearchPrompt({
      query: input.query,
      numResults: input.numResults,
      depth,
      instructions: input.instructions,
    });

    const model = input.model ?? ctx.config.defaultModel;
    const effort = input.effort ?? ctx.config.defaultEffort;
    const collector = createSearchActivityCollector();

    // A large query-plus-instructions prompt can still blow the per-argument
    // limit, so delivery is scoped the same way as grok/review.
    return withPromptDelivery(prompt, (delivery) =>
      runGrok(
        {
          args: buildGrokArgs({
            ...delivery,
            // Always streaming-json: the search count and the source list
            // exist only in the stream. A json run would make "no search
            // ran" undetectable.
            outputFormat: 'streaming-json',
            permission: permissionFlags('read-only'),
            cwd: input.cwd,
            model,
            effort,
            maxTurns: input.maxTurns,
            deny: WEBSEARCH_DENY_RULES,
          }),
          model,
          permissionLevel: 'read-only',
          observer: collector.accept,
          meta: searchMeta(collector, depth, input.numResults, input.maxTurns),
          formatText: (result) => formatSearchText(result, collector.activity(), input.maxTurns),
          isError: (result) => searchIsError(result, collector.activity()),
        },
        ctx,
      ),
    );
  },
});

function searchMeta(
  collector: { readonly activity: () => SearchActivity },
  depth: SearchDepth,
  numResults: number | undefined,
  maxTurns: number | undefined,
): GrokRunMeta {
  return (result) => {
    const activity = collector.activity();
    const meta: Record<string, unknown> = {
      webToolCalls: activity.webToolCalls,
      webSearches: activity.searches.length,
      searchQueries: activity.searches.map((search) => search.query),
      sources: activity.sources,
      sourceCount: activity.sourceCount,
      pagesOpened: activity.pages,
      searchPerformed: isSearchPerformed(activity),
      depth,
    };
    // Omitted-when-empty: an `xSearches: 0` key on every result trains a
    // reader to skip the field, and the one run where it is non-zero is the
    // run they need to notice.
    if (activity.xCalls > 0) meta['xSearches'] = activity.xCalls;
    if (activity.xQueries.length > 0) meta['xQueries'] = activity.xQueries;
    if (activity.sourcesTruncated) meta['sourcesTruncated'] = true;
    if (activity.unknownActions.length > 0) {
      meta['unknownSearchActions'] = activity.unknownActions;
    }
    if (numResults !== undefined) meta['numResults'] = numResults;
    // Present only when the run was cut off, matching review's
    // `reviewIncomplete`. `searchPerformed` alone would let a caller keying
    // on it treat a fragment as a finished search.
    if (isCutOff(result.stopReason)) {
      meta['searchIncomplete'] = incompleteSearchExplanation(result, maxTurns);
    }
    return Object.freeze(meta);
  };
}

function formatSearchText(
  result: GrokRunResult,
  activity: SearchActivity,
  maxTurns: number | undefined,
): string {
  if (isCutOff(result.stopReason)) {
    return `${incompleteSearchExplanation(result, maxTurns)}\n\n${result.text}`;
  }

  const searchPerformed = isSearchPerformed(activity);
  if (!searchPerformed && activity.xCalls === 0 && activity.webToolCalls === 0) {
    return (
      "No search ran. The answer below is the model's own prior knowledge, not current sources.\n\n" +
      result.text
    );
  }
  if (!searchPerformed && activity.xCalls === 0) {
    return (
      `${countLabel(activity.webToolCalls, 'web tool call', 'web tool calls')} returned no sources. ` +
      "The answer below is the model's own prior knowledge, not current sources.\n\n" +
      result.text
    );
  }
  if (!searchPerformed && activity.xCalls > 0) {
    const noun = activity.xCalls === 1 ? 'X search' : 'X searches';
    return (
      `No web search returned results; this answer comes from ${activity.xCalls} ${noun}, not from web pages.\n\n` +
      result.text
    );
  }

  return `${result.text}\n\n[${activitySummary(activity)}]`;
}

function searchIsError(result: GrokRunResult, activity: SearchActivity): boolean {
  if (isCutOff(result.stopReason)) return true;
  return !isSearchPerformed(activity) && activity.xCalls === 0;
}

/**
 * The caller received material from the web. Deliberately not a call count:
 * a started search that never came back, or that came back with no URLs, is
 * the same class of lie as reporting a cut-off review as a finished one.
 * Pages feed `sources`, so a page open still counts.
 */
function isSearchPerformed(activity: SearchActivity): boolean {
  return activity.sourceCount > 0;
}

/**
 * `null` is a normal finish: the CLI omitted the field, it did not abort.
 * Anything other than `end_turn` (max-turns, cancel, timeout) is a cut-off.
 */
function isCutOff(stopReason: string | null): boolean {
  return stopReason !== null && stopReason !== 'end_turn';
}

/**
 * Cut-off diagnosis. Same shape as review's prose-mode branch, including the
 * "No maxTurns limit was set, so the turn budget was not the cause" clause
 * when `maxTurns` is undefined — `cancelled` does not imply a turn cap
 * (verified grok 1.0.4). Kept here; do not export review's private helper.
 */
function incompleteSearchExplanation(result: GrokRunResult, maxTurns: number | undefined): string {
  const stopReason = result.stopReason ?? 'unknown';
  const turns = result.numTurns === null ? '' : ` after ${String(result.numTurns)} turns`;
  if (maxTurns !== undefined) {
    return (
      `The run stopped with stopReason "${stopReason}"${turns} (maxTurns ${String(maxTurns)}) ` +
      `${SEARCH_CUT_OFF_CLAUSE} ` +
      `Raise maxTurns above ${String(maxTurns)} or narrow the question.`
    );
  }
  return (
    `The run stopped with stopReason "${stopReason}"${turns} ${SEARCH_CUT_OFF_CLAUSE} ` +
    'No maxTurns limit was set, so the turn budget was not the cause. ' +
    'Narrow the question and retry.'
  );
}

/**
 * One line, not a source list — the model already cites its sources in prose,
 * and duplicating them wastes the caller's context.
 */
function activitySummary(activity: SearchActivity): string {
  const parts: string[] = [
    countLabel(activity.searches.length, 'web search', 'web searches'),
    countLabel(activity.sourceCount, 'source', 'sources'),
  ];
  if (activity.pages.length > 0) {
    parts.push(countLabel(activity.pages.length, 'page', 'pages'));
  }
  if (activity.xCalls > 0) {
    parts.push(countLabel(activity.xCalls, 'X search', 'X searches'));
  }
  return parts.join(', ');
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
