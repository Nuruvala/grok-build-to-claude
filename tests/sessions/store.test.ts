import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { SessionsStoreError } from '../../src/errors.js';
import {
  attachFirstPrompt,
  attachFirstPrompts,
  findSessionById,
  loadSessions,
  PROMPT_HEAD_BYTES,
  SESSION_SCAN_CAP,
  SUMMARY_MAX_BYTES,
} from '../../src/sessions/store.js';

interface SessionsStore {
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

function summaryFor(
  id: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    info: { id, cwd },
    session_summary: '',
    created_at: '2026-08-16T21:00:00.000000000Z',
    updated_at: extra['updated_at'] ?? '2026-08-16T21:50:00.978931614Z',
    num_messages: 2,
    current_model_id: 'grok-4.6',
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

describe('loadSessions', () => {
  it('enumerates a two-cwd store in full when no cwd filter is given', async () => {
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

      const loaded = await loadSessions({ sessionsDir: store.root });
      assert.equal(loaded.storeMissing, false);
      assert.equal(loaded.scanned, 2);
      assert.equal(loaded.skipped, 0);
      assert.equal(loaded.records.length, 2);
      const ids = new Set(loaded.records.map((row) => row.id));
      assert.deepEqual(ids, new Set(['sess-a', 'sess-b']));
    });
  });

  it('keeps only sessions that started in the filtered cwd', async () => {
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

      const loaded = await loadSessions({ sessionsDir: store.root, cwd: CWD_A });
      assert.equal(loaded.scanned, 1);
      assert.equal(loaded.records.length, 1);
      const only = loaded.records[0];
      assert.ok(only);
      assert.equal(only.id, 'sess-a');
      assert.equal(only.cwd, CWD_A);
    });
  });

  it('drops a session whose decoded directory matches the filter but whose summary names a different cwd', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-mismatch',
        cwd: CWD_A,
        summary: summaryFor('sess-mismatch', CWD_B),
      });

      const loaded = await loadSessions({ sessionsDir: store.root, cwd: CWD_A });
      assert.equal(loaded.scanned, 1);
      assert.equal(loaded.records.length, 0);
    });
  });

  it('does not count an unreadable summary under another cwd when scoped, because unreadable only describes returned records', async () => {
    await withSessionsStore(async (store) => {
      await store.add({ id: 'sess-a', cwd: CWD_A, summary: false });
      await store.add({
        id: 'sess-b',
        cwd: CWD_B,
        summary: summaryFor('sess-b', CWD_B),
      });

      const loaded = await loadSessions({ sessionsDir: store.root, cwd: CWD_B });
      assert.equal(loaded.unreadable, 0);
      assert.equal(loaded.records.length, 1);
      assert.equal(loaded.records[0]?.id, 'sess-b');
    });
  });

  it('keeps a directory name that is not valid percent-encoding rather than dropping it', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-raw',
        rawCwd: '%ZZ-not-encoding',
        summary: summaryFor('sess-raw', '%ZZ-not-encoding'),
      });

      const loaded = await loadSessions({ sessionsDir: store.root });
      assert.equal(loaded.records.length, 1);
      const raw = loaded.records[0];
      assert.ok(raw);
      assert.equal(raw.cwd, '%ZZ-not-encoding');
    });
  });

  it('counts a session directory with no summary.json as unreadable and still returns it', async () => {
    await withSessionsStore(async (store) => {
      await store.add({ id: 'sess-bare', cwd: CWD_A, summary: false });

      const loaded = await loadSessions({ sessionsDir: store.root });
      assert.equal(loaded.unreadable, 1);
      assert.equal(loaded.records.length, 1);
      const bare = loaded.records[0];
      assert.ok(bare);
      assert.equal(bare.id, 'sess-bare');
      assert.equal(bare.summaryAvailable, false);
      assert.equal(bare.cwd, CWD_A);
    });
  });

  it('counts malformed JSON in summary.json as unreadable and still returns the record', async () => {
    await withSessionsStore(async (store) => {
      await store.add({ id: 'sess-bad', cwd: CWD_A, summary: '{not json' });

      const loaded = await loadSessions({ sessionsDir: store.root });
      assert.equal(loaded.unreadable, 1);
      assert.equal(loaded.records.length, 1);
      const bad = loaded.records[0];
      assert.ok(bad);
      assert.equal(bad.id, 'sess-bad');
      assert.equal(bad.summaryAvailable, false);
    });
  });

  it('reports storeMissing when the store root does not exist', async () => {
    const loaded = await loadSessions({
      sessionsDir: path.join(os.tmpdir(), 'grok-mcp-no-such-store-7c3e91a2'),
    });
    assert.equal(loaded.storeMissing, true);
    assert.equal(loaded.records.length, 0);
    assert.equal(loaded.scanned, 0);
  });

  it('ignores session_search.sqlite and .lock files at both levels', async () => {
    await withSessionsStore(async (store) => {
      await store.write('session_search.sqlite', 'not a directory');
      await store.write('root.lock', '');
      await store.add({
        id: 'sess-a',
        cwd: CWD_A,
        summary: summaryFor('sess-a', CWD_A),
      });
      await store.write(`${encodeURIComponent(CWD_A)}/chat_history.jsonl.lock`, '');

      const loaded = await loadSessions({ sessionsDir: store.root });
      assert.equal(loaded.records.length, 1);
      assert.equal(loaded.records[0]?.id, 'sess-a');
    });
  });

  it('stops reading summaries at SESSION_SCAN_CAP and reports the rest as skipped', async () => {
    await withSessionsStore(async (store) => {
      for (let i = 0; i < SESSION_SCAN_CAP + 2; i += 1) {
        await store.add({
          id: `sess-${String(i).padStart(4, '0')}`,
          cwd: CWD_A,
          summary: false,
        });
      }

      const loaded = await loadSessions({ sessionsDir: store.root });
      assert.equal(loaded.scanned, SESSION_SCAN_CAP);
      assert.equal(loaded.skipped, 2);
      assert.equal(loaded.records.length, SESSION_SCAN_CAP);
    });
  });

  it('keeps the newest session directories when the store is past the scan cap, not the readdir-order first ones', async () => {
    await withSessionsStore(async (store) => {
      const cap = 3;
      const ids = ['sess-a', 'sess-b', 'sess-c', 'sess-d'];
      for (const id of ids) {
        await store.add({ id, cwd: CWD_A, summary: summaryFor(id, CWD_A) });
      }

      const cwdPath = path.join(store.root, encodeURIComponent(CWD_A));
      const listed = await readdir(cwdPath, { withFileTypes: true });
      const names = listed.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      assert.equal(names.length, 4);

      const epoch = Date.UTC(2026, 0, 1);
      for (let i = 0; i < names.length; i += 1) {
        const name = names[i];
        assert.ok(name);
        const mtime = new Date(epoch + i * 60_000);
        await utimes(path.join(cwdPath, name), mtime, mtime);
      }

      const oldestName = names[0];
      const newestName = names[names.length - 1];
      assert.ok(oldestName);
      assert.ok(newestName);

      const loaded = await loadSessions({ sessionsDir: store.root, scanCap: cap });
      const loadedIds = new Set(loaded.records.map((row) => row.id));
      assert.equal(loaded.scanned, cap);
      assert.equal(loaded.skipped, 1);
      assert.equal(loadedIds.has(newestName), true);
      assert.equal(loadedIds.has(oldestName), false);
    });
  });

  it('counts an oversized summary.json as unreadable and does not fail the call', async () => {
    await withSessionsStore(async (store) => {
      const padding = 'x'.repeat(SUMMARY_MAX_BYTES);
      await store.add({
        id: 'sess-huge',
        cwd: CWD_A,
        summary: {
          info: { id: 'sess-huge', cwd: CWD_A },
          session_summary: padding,
        },
      });

      const loaded = await loadSessions({ sessionsDir: store.root });
      assert.equal(loaded.unreadable, 1);
      assert.equal(loaded.records.length, 1);
      const huge = loaded.records[0];
      assert.ok(huge);
      assert.equal(huge.id, 'sess-huge');
      assert.equal(huge.summaryAvailable, false);
    });
  });

  it('increments unlistedDirs when a cwd directory cannot be listed', async () => {
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
        const loaded = await loadSessions({ sessionsDir: store.root });
        assert.equal(loaded.unlistedDirs, 1);
        assert.equal(loaded.records.length, 1);
        assert.equal(loaded.records[0]?.id, 'sess-a');
      } finally {
        await chmod(blocked, 0o700);
      }
    });
  });

  it('throws a typed error naming the directory when the store root is unreadable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-sessions-eacces-'));
    await chmod(dir, 0o000);
    try {
      await assert.rejects(
        () => loadSessions({ sessionsDir: dir }),
        (error: unknown) => {
          assert.ok(error instanceof SessionsStoreError);
          assert.match(error.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          assert.match(error.remedy ?? '', /GROK_HOME/);
          return true;
        },
      );
    } finally {
      await chmod(dir, 0o700);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('attachFirstPrompt', () => {
  it('fills firstPrompt from a bounded head read', async () => {
    await withSessionsStore(async (store) => {
      const dir = await store.add({
        id: 'sess-a',
        cwd: CWD_A,
        summary: summaryFor('sess-a', CWD_A),
        history: historyWithPrompt('remember the marker'),
      });
      const loaded = await loadSessions({ sessionsDir: store.root });
      const base = loaded.records[0];
      assert.ok(base);
      assert.equal(base.firstPrompt, null);
      assert.equal(base.dir, dir);

      const attached = await attachFirstPrompt(base);
      assert.equal(attached.firstPrompt, 'remember the marker');
    });
  });

  it('returns firstPrompt null when the prompt line starts past PROMPT_HEAD_BYTES', async () => {
    await withSessionsStore(async (store) => {
      const padding = `${'x'.repeat(PROMPT_HEAD_BYTES)}\n`;
      const promptLine = JSON.stringify({
        type: 'user',
        prompt_index: 0,
        content: [{ type: 'text', text: '<user_query>\nsecret after the cap\n</user_query>' }],
      });
      await store.add({
        id: 'sess-cap',
        cwd: CWD_A,
        summary: summaryFor('sess-cap', CWD_A),
        history: `${padding}${promptLine}\n`,
      });

      const loaded = await loadSessions({ sessionsDir: store.root });
      const base = loaded.records[0];
      assert.ok(base);
      const attached = await attachFirstPrompt(base);
      assert.equal(attached.firstPrompt, null);
    });
  });

  it('attaches prompts to a list in order and leaves a missing history as null', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-a',
        cwd: CWD_A,
        summary: summaryFor('sess-a', CWD_A),
        history: historyWithPrompt('first'),
      });
      await store.add({
        id: 'sess-b',
        cwd: CWD_A,
        summary: summaryFor('sess-b', CWD_A),
      });

      const loaded = await loadSessions({ sessionsDir: store.root });
      const attached = await attachFirstPrompts(loaded.records);
      const byId = new Map(attached.map((row) => [row.id, row.firstPrompt]));
      assert.equal(byId.get('sess-a'), 'first');
      assert.equal(byId.get('sess-b'), null);
    });
  });

  it('returns the record unchanged when the history file is missing', async () => {
    await withSessionsStore(async (store) => {
      await store.add({
        id: 'sess-a',
        cwd: CWD_A,
        summary: summaryFor('sess-a', CWD_A),
      });
      const loaded = await loadSessions({ sessionsDir: store.root });
      const base = loaded.records[0];
      assert.ok(base);
      const attached = await attachFirstPrompt(base);
      assert.equal(attached.firstPrompt, null);
      assert.equal(attached.id, base.id);
    });
  });
});

describe('findSessionById', () => {
  it('finds a directory that a capped scan would never read', async () => {
    await withSessionsStore(async (store) => {
      const cap = 3;
      const ids = ['sess-a', 'sess-b', 'sess-c', 'sess-hidden'];
      for (const id of ids) {
        await store.add({ id, cwd: CWD_A, summary: summaryFor(id, CWD_A) });
      }

      const hiddenDir = path.join(store.root, encodeURIComponent(CWD_A), 'sess-hidden');
      await utimes(hiddenDir, new Date('2020-01-01'), new Date('2020-01-01'));

      const loaded = await loadSessions({ sessionsDir: store.root, scanCap: cap });
      assert.equal(loaded.scanned, cap);
      assert.equal(
        loaded.records.some((row) => row.id === 'sess-hidden'),
        false,
      );

      const found = await findSessionById(store.root, 'sess-hidden');
      assert.ok(found);
      assert.equal(found.id, 'sess-hidden');
      assert.equal(found.cwd, CWD_A);
    });
  });

  it('returns null when the store root does not exist', async () => {
    const found = await findSessionById(
      path.join(os.tmpdir(), 'grok-mcp-no-such-store-7c3e91a2'),
      'sess-a',
    );
    assert.equal(found, null);
  });

  it('throws a typed error when the store root is unreadable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-sessions-id-eacces-'));
    await chmod(dir, 0o000);
    try {
      await assert.rejects(
        () => findSessionById(dir, 'sess-a'),
        (error: unknown) => {
          assert.ok(error instanceof SessionsStoreError);
          assert.match(error.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          return true;
        },
      );
    } finally {
      await chmod(dir, 0o700);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
