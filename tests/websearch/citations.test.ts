import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { interpretStreamLine } from '../../src/grok/stream.js';
import type { GrokStreamEvent } from '../../src/grok/stream.js';
import {
  SOURCE_CAP,
  createSearchActivityCollector,
  type SearchActivity,
} from '../../src/websearch/citations.js';

/**
 * Captured live against grok 1.0.4 on 2026-08-17. The ids keep the ellipsis
 * from the notes: the fold must not care about id shape.
 */
const CAPTURED_WEB_SEARCH = {
  type: 'tool_call_update',
  toolCallId: 'ws_b032…-0',
  status: 'completed',
  content: [],
  rawOutput: {
    action: {
      type: 'search',
      query: 'latest stable Node.js release version',
      sources: [
        { type: 'url', url: 'https://nodejs.org/en/about/previous-releases' },
        { type: 'url', url: 'https://nodejs.org/en' },
      ],
    },
    id: 'ws_b032…-0',
    status: 'completed',
  },
  locations: [],
} as const;

const CAPTURED_OPEN_PAGE = {
  type: 'tool_call_update',
  toolCallId: 'ws_da4a…-0',
  status: 'completed',
  content: [],
  rawOutput: {
    action: {
      type: 'open_page',
      url: 'https://nodejs.org/en/about/previous-releases',
    },
    id: 'ws_da4a…-0',
    status: 'completed',
  },
  locations: [],
} as const;

const CAPTURED_X_UPDATE = {
  type: 'tool_call_update',
  toolCallId: 'ctc_9b76…-2',
  status: 'completed',
  content: [],
  rawOutput: {
    call_id: 'xs_call-…-2',
    input:
      '{"query":"Node.js (released OR release) (v24 OR v22 OR v26) (LTS OR Current)","limit":"10","mode":"Latest"}',
    name: 'x_keyword_search',
    id: 'ctc_9b76…-2',
  },
  locations: [],
} as const;

const EMPTY: SearchActivity = {
  webToolCalls: 0,
  searches: [],
  pages: [],
  sources: [],
  sourceCount: 0,
  sourcesTruncated: false,
  xCalls: 0,
  xQueries: [],
  unknownActions: [],
};

function fold(lines: readonly string[]): SearchActivity {
  const collector = createSearchActivityCollector();
  for (const line of lines) {
    collector.accept(interpretStreamLine(line));
  }
  return collector.activity();
}

function toolCall(variant: 'WebSearch' | 'XSearch', id: string): string {
  return JSON.stringify({
    type: 'tool_call',
    toolCallId: id,
    title: variant === 'WebSearch' ? 'Web search:' : 'X search:',
    kind: 'search',
    status: 'in_progress',
    toolName: variant === 'WebSearch' ? 'Web search:' : 'X search:',
    rawInput: { variant, backend: true },
    content: [],
    locations: [],
  });
}

describe('createSearchActivityCollector captured events', () => {
  it('folds the captured search-with-sources update into one SearchQuery, byte-for-byte', () => {
    const activity = fold([JSON.stringify(CAPTURED_WEB_SEARCH)]);
    assert.deepEqual(activity.searches, [
      {
        query: 'latest stable Node.js release version',
        sources: ['https://nodejs.org/en/about/previous-releases', 'https://nodejs.org/en'],
      },
    ]);
    assert.deepEqual(activity.sources, [
      'https://nodejs.org/en/about/previous-releases',
      'https://nodejs.org/en',
    ]);
    assert.equal(activity.sourceCount, 2);
    assert.equal(activity.sourcesTruncated, false);
    assert.equal(activity.webToolCalls, 0);
    assert.deepEqual(activity.pages, []);
  });

  it('folds the captured open_page update into pages, and into the flat source list', () => {
    const activity = fold([JSON.stringify(CAPTURED_OPEN_PAGE)]);
    assert.deepEqual(activity.pages, ['https://nodejs.org/en/about/previous-releases']);
    assert.deepEqual(activity.sources, ['https://nodejs.org/en/about/previous-releases']);
    assert.equal(activity.sourceCount, 1);
    assert.deepEqual(activity.searches, []);
  });

  it('recovers the query from the captured X update, including its JSON-string input', () => {
    const activity = fold([JSON.stringify(CAPTURED_X_UPDATE)]);
    assert.deepEqual(activity.xQueries, [
      'Node.js (released OR release) (v24 OR v22 OR v26) (LTS OR Current)',
    ]);
    assert.equal(activity.xCalls, 0);
    assert.deepEqual(activity.searches, []);
    assert.deepEqual(activity.sources, []);
  });
});

describe('createSearchActivityCollector degradation', () => {
  it('contributes nothing from a mid-flight update whose rawOutput is null', () => {
    const activity = fold([
      toolCall('WebSearch', 'ws-1'),
      JSON.stringify({
        type: 'tool_call_update',
        toolCallId: 'ws-1',
        status: null,
        rawOutput: null,
        locations: [],
      }),
    ]);
    assert.equal(activity.webToolCalls, 1);
    assert.deepEqual(activity.searches, []);
    assert.deepEqual(activity.pages, []);
    assert.deepEqual(activity.sources, []);
  });

  it('lands an unknown action.type in unknownActions and does not throw', () => {
    const collector = createSearchActivityCollector();
    assert.doesNotThrow(() => {
      collector.accept(
        interpretStreamLine(
          JSON.stringify({
            type: 'tool_call_update',
            toolCallId: 'ws-1',
            status: 'completed',
            rawOutput: { action: { type: 'browse_site', url: 'https://example.com' } },
            locations: [],
          }),
        ),
      );
    });
    const activity = collector.activity();
    assert.deepEqual(activity.unknownActions, ['browse_site']);
    assert.deepEqual(activity.searches, []);
    assert.deepEqual(activity.pages, []);
  });

  it('contributes nothing from a non-object action, because !isRecord is the only guard', () => {
    const malformed: readonly unknown[] = [null, 'search', [{ type: 'search', query: 'x' }]];
    for (const action of malformed) {
      const activity = fold([
        JSON.stringify({
          type: 'tool_call_update',
          toolCallId: 'ws-malformed',
          status: 'completed',
          rawOutput: { action },
          locations: [],
        }),
      ]);
      assert.deepEqual(
        activity,
        EMPTY,
        `action ${JSON.stringify(action)} should be ignored, not thrown on`,
      );
    }
  });

  it('counts an X tool_call whose update input is not valid JSON, and records no query', () => {
    const activity = fold([
      toolCall('XSearch', 'xs-1'),
      JSON.stringify({
        type: 'tool_call_update',
        toolCallId: 'xs-1',
        status: 'completed',
        rawOutput: { name: 'x_keyword_search', input: 'not-json{' },
        locations: [],
      }),
    ]);
    assert.equal(activity.xCalls, 1);
    assert.deepEqual(activity.xQueries, []);
  });

  it('counts an X tool_call whose update input parses to a non-object, and records no query', () => {
    const activity = fold([
      toolCall('XSearch', 'xs-1'),
      JSON.stringify({
        type: 'tool_call_update',
        toolCallId: 'xs-1',
        status: 'completed',
        rawOutput: { name: 'x_keyword_search', input: '["just","an","array"]' },
        locations: [],
      }),
    ]);
    assert.equal(activity.xCalls, 1);
    assert.deepEqual(activity.xQueries, []);
  });
});

describe('createSearchActivityCollector sources', () => {
  it('dedupes urls across two searches, preserving first-seen order', () => {
    const first = {
      type: 'tool_call_update',
      rawOutput: {
        action: {
          type: 'search',
          query: 'one',
          sources: [
            { type: 'url', url: 'https://a.example' },
            { type: 'url', url: 'https://b.example' },
          ],
        },
      },
    };
    const second = {
      type: 'tool_call_update',
      rawOutput: {
        action: {
          type: 'search',
          query: 'two',
          sources: [
            { type: 'url', url: 'https://b.example' },
            { type: 'url', url: 'https://c.example' },
          ],
        },
      },
    };
    const activity = fold([JSON.stringify(first), JSON.stringify(second)]);
    assert.deepEqual(activity.sources, [
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    assert.equal(activity.sourceCount, 3);
    assert.deepEqual(activity.searches[0]?.sources, ['https://a.example', 'https://b.example']);
    assert.deepEqual(activity.searches[1]?.sources, ['https://b.example', 'https://c.example']);
  });

  it('caps 60 distinct urls to 50 with sourceCount 60 and sourcesTruncated true, without capping the per-search list', () => {
    const urls = Array.from({ length: 60 }, (_, index) => ({
      type: 'url',
      url: `https://example.com/${String(index)}`,
    }));
    const activity = fold([
      JSON.stringify({
        type: 'tool_call_update',
        rawOutput: { action: { type: 'search', query: 'many', sources: urls } },
      }),
    ]);
    assert.equal(activity.sources.length, SOURCE_CAP);
    assert.equal(activity.sourceCount, 60);
    assert.equal(activity.sourcesTruncated, true);
    assert.equal(activity.searches[0]?.sources.length, 60);
    assert.equal(activity.sources[0], 'https://example.com/0');
    assert.equal(activity.sources[SOURCE_CAP - 1], 'https://example.com/49');
  });
});

describe('createSearchActivityCollector ignores noise', () => {
  it('folds an unparseable event, an other event, and an empty stream to an empty activity', () => {
    assert.deepEqual(fold(['not-json-at-all']), EMPTY);
    assert.deepEqual(fold(['{"type":"available_commands"}']), EMPTY);
    assert.deepEqual(fold([]), EMPTY);
  });

  it('does not consume state: activity() twice in a row returns the same thing', () => {
    const collector = createSearchActivityCollector();
    collector.accept(interpretStreamLine(JSON.stringify(CAPTURED_WEB_SEARCH)));
    const first = collector.activity();
    const second = collector.activity();
    assert.deepEqual(first, second);
    collector.accept(interpretStreamLine(JSON.stringify(CAPTURED_OPEN_PAGE)));
    const third = collector.activity();
    assert.deepEqual(first, second);
    assert.equal(third.searches.length, 1);
    assert.equal(third.pages.length, 1);
    assert.equal(first.pages.length, 0);
  });

  it('does not throw on an unmodelled event, matching the stdout-handler contract', () => {
    const collector = createSearchActivityCollector();
    const event = { type: 'brand-new' } as unknown as GrokStreamEvent;
    assert.doesNotThrow(() => {
      collector.accept(event);
    });
    assert.deepEqual(collector.activity(), EMPTY);
  });
});
