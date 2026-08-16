import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { InvalidArgumentsError } from '../../src/errors.js';
import { PROMPT_SCAN_CAP } from '../../src/sessions/store.js';
import { sessionsTool } from '../../src/tools/handlers/sessions.js';
import { invokeTool } from '../../src/tools/registry.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

interface SessionsStore {
  readonly home: string;
  readonly root: string;
  add(spec: {
    readonly id: string;
    readonly cwd?: string;
    readonly rawCwd?: string;
    readonly summary?: object | string | false;
    readonly history?: string | readonly object[];
  }): Promise<string>;
  write(relativePath: string, contents: string | Uint8Array): Promise<void>;
  cleanup(): Promise<void>;
}

// prettier-ignore
// @ts-expect-error -- untyped JS fixture; aliases below are the types.
import { withSessionsStore as withSessionsStoreRaw } from '../fixtures/sessions-store.mjs';

const withSessionsStore = withSessionsStoreRaw as (
  fn: (store: SessionsStore) => Promise<void>,
) => Promise<void>;

const CWD_A = '/tmp/alpha';
const CWD_B = '/tmp/beta';

function isolatedConfig(grokHome: string, extra: Record<string, string> = {}): Config {
  return loadConfig({
    HOME: '/tmp/grok-mcp-test-home',
    GROK_HOME: grokHome,
    ...extra,
  });
}

function ctxFor(
  store: Pick<SessionsStore, 'home'> | string,
  extra: Record<string, string> = {},
): ToolContext {
  const grokHome = typeof store === 'string' ? store : store.home;
  return {
    config: isolatedConfig(grokHome, extra),
    signal: new AbortController().signal,
    reportProgress: () => {
      /* unused */
    },
    progressRequested: false,
  };
}

function textOf(result: ToolResult): string {
  const [block] = result.content;
  assert.ok(block);
  return block.text;
}

function metaOf(result: ToolResult): Record<string, unknown> {
  const [block] = result.content;
  assert.ok(block);
  assert.ok(block._meta);
  return block._meta;
}

function summaryFor(
  id: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    info: { id, cwd },
    generated_title: extra['generated_title'] ?? `Title ${id}`,
    session_summary: extra['session_summary'] ?? '',
    created_at: '2026-08-16T21:00:00.000000000Z',
    updated_at: extra['updated_at'] ?? '2026-08-16T21:50:00.978931614Z',
    num_messages: extra['num_messages'] ?? 2,
    current_model_id: 'grok-4.6',
    agent_name: 'grok-build-plan',
    sandbox_profile: 'read-only',
    reasoning_effort: 'high',
    ...extra,
  };
}

function historyWithPrompt(text: string): readonly object[] {
  return [
    { type: 'system', content: [] },
    {
      type: 'user',
      prompt_index: 0,
      content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }],
    },
  ];
}

describe('sessions tool list', () => {
  it('returns a list body and a _meta shape with one object per row', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-a',
        cwd: CWD_A,
        summary: summaryFor('sess-a', CWD_A, { generated_title: 'Alpha session' }),
        history: historyWithPrompt('do the alpha thing'),
      });

      const result = await sessionsTool.handler({}, ctxFor(store));
      assert.notEqual(result.isError, true);
      assert.match(textOf(result), /sess-a/);
      assert.match(textOf(result), /Alpha session/);
      assert.match(textOf(result), /grok -r <id>/);

      const meta = metaOf(result);
      assert.equal(meta['count'], 1);
      assert.equal(meta['matched'], 1);
      assert.equal(meta['limit'], 20);
      assert.equal(meta['scope'], null);
      assert.equal(meta['query'], null);
      assert.equal(meta['storeMissing'], false);
      assert.equal(meta['sessionsDir'], store.root);
      assert.equal(meta['found'], undefined);

      const sessions = meta['sessions'];
      assert.ok(Array.isArray(sessions));
      assert.equal(sessions.length, 1);
      const row = sessions[0] as Record<string, unknown>;
      assert.equal(row['id'], 'sess-a');
      assert.equal(row['cwd'], CWD_A);
      assert.equal(row['title'], 'Alpha session');
      assert.equal(row['titleSource'], 'title');
      assert.equal(row['resumeCommand'], 'grok -r sess-a');
      assert.equal(row['path'], `${store.root}/${encodeURIComponent(CWD_A)}/sess-a`);
    });
  });

  it('scopes the list to sessions that started in cwd', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-a',
        cwd: CWD_A,
        summary: summaryFor('sess-a', CWD_A),
      });
      await store.add({
        id: 'sess-b',
        cwd: CWD_B,
        summary: summaryFor('sess-b', CWD_B),
      });

      const result = await sessionsTool.handler({ cwd: CWD_A }, ctxFor(store));
      const meta = metaOf(result);
      assert.equal(meta['scope'], CWD_A);
      assert.equal(meta['count'], 1);
      const sessions = meta['sessions'] as { id: string }[];
      assert.deepEqual(
        sessions.map((row) => row.id),
        ['sess-a'],
      );
      assert.doesNotMatch(textOf(result), /sess-b/);
    });
  });

  it('filters by query over title and first prompt', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-hit',
        cwd: CWD_A,
        summary: summaryFor('sess-hit', CWD_A, { generated_title: 'Login crash' }),
        history: historyWithPrompt('the submit button throws'),
      });
      await store.add({
        id: 'sess-miss',
        cwd: CWD_A,
        summary: summaryFor('sess-miss', CWD_A, { generated_title: 'Unrelated' }),
        history: historyWithPrompt('something else'),
      });

      const result = await sessionsTool.handler({ query: 'submit button' }, ctxFor(store));
      const meta = metaOf(result);
      assert.equal(meta['query'], 'submit button');
      assert.equal(meta['count'], 1);
      const sessions = meta['sessions'] as { id: string }[];
      assert.deepEqual(
        sessions.map((row) => row.id),
        ['sess-hit'],
      );
    });
  });

  it('matches title and id past the prompt-scan window and reports that first-prompt search was truncated', async () => {
    await withSessionsStore(async (store) => {
      for (let i = 0; i < PROMPT_SCAN_CAP; i += 1) {
        await store.add({
          id: `sess-${String(i).padStart(3, '0')}`,
          cwd: CWD_A,
          summary: summaryFor(`sess-${String(i).padStart(3, '0')}`, CWD_A, {
            generated_title: 'Unrelated',
            updated_at: new Date(Date.UTC(2026, 7, 16, 12, 0, i + 1)).toISOString(),
          }),
        });
      }
      await store.add({
        id: 'sess-oldest-title',
        cwd: CWD_A,
        summary: summaryFor('sess-oldest-title', CWD_A, {
          generated_title: 'Login crash',
          updated_at: '2026-08-16T00:00:00.000Z',
        }),
      });

      const byTitle = await sessionsTool.handler({ query: 'login' }, ctxFor(store));
      const titleMeta = metaOf(byTitle);
      assert.equal(titleMeta['matched'], 1);
      assert.equal(titleMeta['promptSearchTruncated'], true);
      assert.equal(titleMeta['promptSearchScanned'], PROMPT_SCAN_CAP);
      assert.equal((titleMeta['sessions'] as { id: string }[])[0]?.id, 'sess-oldest-title');
      assert.match(
        textOf(byTitle),
        /first-prompt matching covered only the 200 most recent sessions/,
      );
    });

    await withSessionsStore(async (store) => {
      for (let i = 0; i < PROMPT_SCAN_CAP; i += 1) {
        await store.add({
          id: `sess-${String(i).padStart(3, '0')}`,
          cwd: CWD_A,
          summary: summaryFor(`sess-${String(i).padStart(3, '0')}`, CWD_A, {
            generated_title: 'Unrelated',
            updated_at: new Date(Date.UTC(2026, 7, 16, 12, 0, i + 1)).toISOString(),
          }),
        });
      }
      await store.add({
        id: 'sess-login-old',
        cwd: CWD_A,
        summary: summaryFor('sess-login-old', CWD_A, {
          generated_title: 'Unrelated',
          updated_at: '2026-08-16T00:00:00.000Z',
        }),
      });

      const byId = await sessionsTool.handler({ query: 'login' }, ctxFor(store));
      const idMeta = metaOf(byId);
      assert.equal(idMeta['matched'], 1);
      assert.equal(idMeta['promptSearchTruncated'], true);
      assert.equal(idMeta['promptSearchScanned'], PROMPT_SCAN_CAP);
      assert.equal((idMeta['sessions'] as { id: string }[])[0]?.id, 'sess-login-old');
    });
  });

  it('puts label and firstPrompt on _meta.sessions[0] when the summary has no title', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-fresh',
        cwd: CWD_A,
        summary: summaryFor('sess-fresh', CWD_A, {
          generated_title: '',
          session_summary: '',
        }),
        history: historyWithPrompt('remember the marker'),
      });

      const result = await sessionsTool.handler({}, ctxFor(store));
      const sessions = metaOf(result)['sessions'];
      assert.ok(Array.isArray(sessions));
      const row = sessions[0] as Record<string, unknown>;
      assert.equal(row['title'], null);
      assert.equal(row['titleSource'], 'prompt');
      assert.equal(row['label'], 'remember the marker');
      assert.equal(row['firstPrompt'], 'remember the marker');
    });
  });

  it('increments unlistedDirs when a cwd directory cannot be listed and says so in the partial line', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-a',
        cwd: CWD_A,
        summary: summaryFor('sess-a', CWD_A),
      });
      await store.add({
        id: 'sess-b',
        cwd: CWD_B,
        summary: summaryFor('sess-b', CWD_B),
      });

      const blocked = path.join(store.root, encodeURIComponent(CWD_B));
      await chmod(blocked, 0o000);
      try {
        const result = await sessionsTool.handler({}, ctxFor(store));
        assert.equal(result.isError, false);
        assert.equal(metaOf(result)['unlistedDirs'], 1);
        assert.equal(metaOf(result)['count'], 1);
        assert.match(textOf(result), /1 project directory could not be listed/);
      } finally {
        await chmod(blocked, 0o700);
      }
    });
  });

  it('honours limit and reports matched as the pre-limit count', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-1',
        cwd: CWD_A,
        summary: summaryFor('sess-1', CWD_A, { updated_at: '2026-08-16T21:03:00Z' }),
      });
      await store.add({
        id: 'sess-2',
        cwd: CWD_A,
        summary: summaryFor('sess-2', CWD_A, { updated_at: '2026-08-16T21:02:00Z' }),
      });
      await store.add({
        id: 'sess-3',
        cwd: CWD_A,
        summary: summaryFor('sess-3', CWD_A, { updated_at: '2026-08-16T21:01:00Z' }),
      });

      const result = await sessionsTool.handler({ limit: 1 }, ctxFor(store));
      const meta = metaOf(result);
      assert.equal(meta['count'], 1);
      assert.equal(meta['matched'], 3);
      assert.equal(meta['limit'], 1);
      const sessions = meta['sessions'] as { id: string }[];
      assert.equal(sessions[0]?.id, 'sess-1');
    });
  });
});

describe('sessions tool id lookup', () => {
  it('returns a detail block and found: true for an exact id hit', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-a',
        cwd: CWD_A,
        summary: summaryFor('sess-a', CWD_A, { generated_title: 'Look me up' }),
        history: historyWithPrompt('the real prompt'),
      });

      const result = await sessionsTool.handler({ id: 'sess-a' }, ctxFor(store));
      assert.equal(result.isError, false);
      assert.match(textOf(result), /Session sess-a/);
      assert.match(textOf(result), /Look me up/);
      assert.match(textOf(result), /the real prompt/);
      assert.match(textOf(result), /grok -r sess-a/);
      assert.equal(metaOf(result)['found'], true);
      assert.equal(metaOf(result)['count'], 1);
      assert.equal(metaOf(result)['scanned'], 1);
      assert.equal(metaOf(result)['skipped'], 0);
    });
  });

  it('finds an id case-insensitively when the exact match misses', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'Sess-Mixed',
        cwd: CWD_A,
        summary: summaryFor('Sess-Mixed', CWD_A),
      });

      const result = await sessionsTool.handler({ id: 'sess-mixed' }, ctxFor(store));
      assert.equal(metaOf(result)['found'], true);
      assert.equal((metaOf(result)['sessions'] as { id: string }[])[0]?.id, 'Sess-Mixed');
    });
  });

  it('returns isError false and found false when the id is not in the store', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-a',
        cwd: CWD_A,
        summary: summaryFor('sess-a', CWD_A),
      });

      const result = await sessionsTool.handler({ id: 'no-such-session' }, ctxFor(store));
      assert.equal(result.isError, false);
      assert.equal(metaOf(result)['found'], false);
      assert.equal(metaOf(result)['scanned'], 0);
      assert.equal(metaOf(result)['skipped'], 0);
      assert.match(textOf(result), /no-such-session/);
      assert.match(textOf(result), new RegExp(store.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(textOf(result), /no arguments/);
    });
  });

  it('ignores query, cwd, and limit when id is set, because the id is global', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-b',
        cwd: CWD_B,
        summary: summaryFor('sess-b', CWD_B, { generated_title: 'Other repo' }),
      });

      const result = await sessionsTool.handler(
        { id: 'sess-b', cwd: CWD_A, query: 'nope', limit: 1 },
        ctxFor(store),
      );
      assert.equal(metaOf(result)['found'], true);
      assert.equal(metaOf(result)['scope'], null);
      assert.equal(metaOf(result)['query'], null);
    });
  });
});

describe('sessions tool empty store and structuredContent', () => {
  it('says no sessions exist yet, as a successful answer', async () => {
    await withSessionsStore(async (store) => {
      const result = await sessionsTool.handler({}, ctxFor(store));
      assert.equal(result.isError, false);
      assert.match(textOf(result), /No Grok sessions exist yet/);
      assert.match(textOf(result), /grok tool call creates one/);
      assert.equal(metaOf(result)['storeMissing'], false);
      assert.equal(metaOf(result)['count'], 0);
    });
  });

  it('uses the same empty-store message when the store root is missing', async () => {
    const missing = '/tmp/grok-mcp-no-such-sessions-7c3e91a2';
    const result = await sessionsTool.handler({}, ctxFor(missing));
    assert.equal(result.isError, false);
    assert.match(textOf(result), /No Grok sessions exist yet/);
    assert.equal(metaOf(result)['storeMissing'], true);
  });

  it('omits structuredContent unless it is enabled', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-a',
        cwd: CWD_A,
        summary: summaryFor('sess-a', CWD_A),
      });

      const off = await sessionsTool.handler({}, ctxFor(store));
      assert.equal(off.structuredContent, undefined);

      const on = await sessionsTool.handler({}, ctxFor(store, { STRUCTURED_CONTENT_ENABLED: '1' }));
      assert.deepEqual(on.structuredContent, metaOf(on));
    });
  });
});

describe('sessions tool schema', () => {
  it('rejects empty query, cwd, and id so they cannot silently mean "no filter"', async () => {
    for (const field of ['query', 'cwd', 'id'] as const) {
      await assert.rejects(
        () =>
          invokeTool(
            'sessions',
            { [field]: '' },
            ctxFor('/tmp/grok-mcp-no-such-sessions-7c3e91a2'),
          ),
        (error: unknown) => {
          assert.ok(error instanceof InvalidArgumentsError);
          assert.match(error.message, new RegExp(field));
          return true;
        },
      );
    }
  });
});
