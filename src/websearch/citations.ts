/**
 * Pure fold of streaming-json events into the search activity a result object
 * does not carry. `end` has no record of which searches ran, and `usage` has
 * no web-search counter (verified grok 1.0.4 on 2026-08-17), so the stream is
 * the only place a search count exists.
 *
 * Counts come from `tool_call`, detail from `tool_call_update`. The two are
 * independent readings of the same run and are not joined on `toolCallId`: a
 * run can legitimately report `webToolCalls: 2` with one search and one page, and
 * a truncated stream loses the head, not the tail — so a detail whose
 * `tool_call` was never seen is still kept.
 *
 * Never throws, for any event including `unparseable`.
 */

import type { GrokStreamEvent } from '../grok/stream.js';

/** Ceiling on the flat source list that lands in `_meta`. Per-search lists are not capped. */
export const SOURCE_CAP = 50;

export interface SearchQuery {
  readonly query: string;
  /** Deduped, first-seen order. Empty for a search that returned none. */
  readonly sources: readonly string[];
}

export interface SearchActivity {
  /**
   * `tool_call` events with `rawInput.variant === 'WebSearch'`. Calls started —
   * searches and page opens. A measured run made 9 of these that decomposed
   * into 6 searches and 3 page opens, so this is not a search count.
   */
  readonly webToolCalls: number;
  /** Completed `action.type === 'search'` results, in order. */
  readonly searches: readonly SearchQuery[];
  /** `action.type === 'open_page'` urls, deduped, first-seen order. */
  readonly pages: readonly string[];
  /** Every url from every search plus every opened page. Deduped, capped. */
  readonly sources: readonly string[];
  readonly sourceCount: number;
  readonly sourcesTruncated: boolean;
  /** `tool_call` events with `rawInput.variant === 'XSearch'`. */
  readonly xCalls: number;
  /** Queries recovered from the JSON string in an X update's `rawOutput.input`. */
  readonly xQueries: readonly string[];
  /** `action.type` values we do not model. Deduped. Reported, never thrown on. */
  readonly unknownActions: readonly string[];
}

export interface SearchActivityCollector {
  readonly accept: (event: GrokStreamEvent) => void;
  /** Fold what has been accepted so far. Callable at any point; does not consume state. */
  readonly activity: () => SearchActivity;
}

export function createSearchActivityCollector(): SearchActivityCollector {
  let webToolCalls = 0;
  let xCalls = 0;
  const searches: SearchQuery[] = [];
  const pages: string[] = [];
  const pageSeen = new Set<string>();
  const xQueries: string[] = [];
  const unknownActions: string[] = [];
  const unknownSeen = new Set<string>();
  const sources: string[] = [];
  const sourceSeen = new Set<string>();

  function rememberSource(url: string): void {
    if (sourceSeen.has(url)) return;
    sourceSeen.add(url);
    sources.push(url);
  }

  function acceptToolCall(rawInput: Readonly<Record<string, unknown>> | null): void {
    if (rawInput === null) return;
    const variant = rawInput['variant'];
    if (variant === 'WebSearch') {
      webToolCalls += 1;
      return;
    }
    if (variant === 'XSearch') {
      xCalls += 1;
    }
  }

  function acceptUpdate(rawOutput: Readonly<Record<string, unknown>> | null): void {
    // Incomplete mid-flight updates carry `rawOutput: null`. Requiring a record
    // is the filter for "this call returned something"; do not also test status.
    if (rawOutput === null) return;
    acceptWebAction(rawOutput['action']);
    acceptXInput(rawOutput);
  }

  function acceptWebAction(actionValue: unknown): void {
    if (!isRecord(actionValue)) return;
    const actionType = actionValue['type'];
    if (actionType === 'search') {
      searches.push(readSearch(actionValue));
      return;
    }
    if (actionType === 'open_page') {
      const url = actionValue['url'];
      if (typeof url === 'string' && url !== '' && !pageSeen.has(url)) {
        pageSeen.add(url);
        pages.push(url);
        rememberSource(url);
      }
      return;
    }
    // `action.type` is not a closed set. Record the tag and keep going.
    if (typeof actionType === 'string' && !unknownSeen.has(actionType)) {
      unknownSeen.add(actionType);
      unknownActions.push(actionType);
    }
  }

  function acceptXInput(rawOutput: Readonly<Record<string, unknown>>): void {
    const name = rawOutput['name'];
    const input = rawOutput['input'];
    if (typeof name !== 'string' || typeof input !== 'string') return;
    const query = parseXQuery(input);
    if (query !== undefined) xQueries.push(query);
  }

  function readSearch(action: Record<string, unknown>): SearchQuery {
    const rawQuery = action['query'];
    const query = typeof rawQuery === 'string' ? rawQuery : '';
    const urls: string[] = [];
    const seen = new Set<string>();
    const rawSources = action['sources'];
    if (Array.isArray(rawSources)) {
      for (const entry of rawSources) {
        if (!isRecord(entry)) continue;
        const url = entry['url'];
        if (typeof url !== 'string' || url === '' || seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
        rememberSource(url);
      }
    }
    return Object.freeze({ query, sources: Object.freeze(urls) });
  }

  return {
    accept: (event: GrokStreamEvent): void => {
      switch (event.type) {
        case 'tool_call':
          acceptToolCall(event.rawInput);
          return;
        case 'tool_call_update':
          acceptUpdate(event.rawOutput);
          return;
        case 'text':
        case 'thought':
        case 'usage':
        case 'end':
        case 'error':
        case 'other':
        case 'unparseable':
          return;
        default:
          // Compile-time exhaustiveness only. Same stdout-handler rule as
          // `createStreamCollector`: a throw here is uncaught and leaves the
          // run's promise forever unresolved.
          ((_exhaustive: never) => undefined)(event);
          return;
      }
    },
    activity: (): SearchActivity =>
      Object.freeze({
        webToolCalls,
        searches: Object.freeze(searches.slice()),
        pages: Object.freeze(pages.slice()),
        sources: Object.freeze(sources.slice(0, SOURCE_CAP)),
        sourceCount: sources.length,
        sourcesTruncated: sources.length > SOURCE_CAP,
        xCalls,
        xQueries: Object.freeze(xQueries.slice()),
        unknownActions: Object.freeze(unknownActions.slice()),
      }),
  };
}

/**
 * `rawOutput.input` is a JSON string, not an object (verified grok 1.0.4).
 * A parse failure, a non-object, or a missing query contributes nothing —
 * the `tool_call` count already recorded that the search happened.
 */
function parseXQuery(input: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const query = parsed['query'];
  return typeof query === 'string' && query !== '' ? query : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
