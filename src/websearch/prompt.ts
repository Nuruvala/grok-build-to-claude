/**
 * Web-search prompt construction. Pure and deterministic: identical params
 * produce byte-identical output. Result-count and depth are prompt shaping
 * only — `grok --help` has no `--num-results` or `--search-depth` (verified
 * grok 1.0.4 on 2026-08-17).
 */

export type SearchDepth = 'basic' | 'full';

export interface WebSearchPromptParams {
  readonly query: string;
  readonly numResults?: number | undefined;
  readonly depth: SearchDepth;
  readonly instructions?: string | undefined;
}

const INTRO =
  'Answer the question below using web search. Search now rather than answering from what you already know — the answer must reflect current sources.';

const BASIC_DEPTH = 'One round of searching is enough. Answer directly and keep it short.';

const FULL_DEPTH =
  'Search more than once, from different angles. Prefer primary and official sources over aggregators and summaries, cross-check anything the sources disagree on, and say so explicitly when they conflict.';

const CITE =
  'Cite every factual claim with the URL it came from, as a markdown link. Do not cite a source you did not actually open or receive in a search result.';

/**
 * Matching the wording `review` uses for the same reason: a constrained prompt
 * is what stops the model hunting for a denied tool (see M3a). We do not tell
 * the model to avoid X search — we cannot enforce it and it is sometimes the
 * right source; the tool reports what actually ran instead.
 */
const TOOL_CONSTRAINT =
  'You have no shell and cannot edit files in this run: `run_terminal_command` and the edit tools are denied. Use your web search and page tools and answer without them.';

export function buildWebSearchPrompt(params: WebSearchPromptParams): string {
  const parts: string[] = [
    INTRO,
    `Question:\n${params.query}`,
    params.depth === 'basic' ? BASIC_DEPTH : FULL_DEPTH,
  ];

  if (params.numResults !== undefined) {
    parts.push(`Cite about ${params.numResults} distinct sources.`);
  }

  parts.push(CITE, TOOL_CONSTRAINT);

  if (present(params.instructions)) {
    parts.push('Additional instructions from the caller:', params.instructions);
  }

  return parts.join('\n\n');
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}
