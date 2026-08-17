import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  labelFor,
  matchesQuery,
  resumeCommand,
  SESSION_WINDOW_SLACK_MS,
  sessionsStartedDuring,
  sortByRecency,
} from '../../src/sessions/select.js';
import type { SessionRecord } from '../../src/sessions/select.js';

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-1',
    cwd: '/tmp/a',
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
    dir: '/tmp/store/a/sess-1',
    summaryAvailable: true,
    firstPrompt: null,
    ...overrides,
  };
}

describe('sortByRecency', () => {
  it('orders by updatedAt descending and puts a null updatedAt last', () => {
    const newest = record({ id: 'new', updatedAt: '2026-08-16T22:00:00Z' });
    const older = record({ id: 'old', updatedAt: '2026-08-16T21:00:00Z' });
    const missing = record({ id: 'missing', updatedAt: null });
    const unparseable = record({ id: 'bad', updatedAt: 'not-a-date' });

    const sorted = sortByRecency([missing, older, unparseable, newest]);
    assert.deepEqual(
      sorted.map((row) => row.id),
      ['new', 'old', 'bad', 'missing'],
    );
  });

  it('breaks ties on createdAt then id so the order is total', () => {
    const shared = '2026-08-16T21:00:00Z';
    const a = record({ id: 'a', updatedAt: shared, createdAt: '2026-08-16T10:00:00Z' });
    const b = record({ id: 'b', updatedAt: shared, createdAt: '2026-08-16T12:00:00Z' });
    const c = record({ id: 'c', updatedAt: shared, createdAt: '2026-08-16T12:00:00Z' });

    const sorted = sortByRecency([a, c, b]);
    assert.deepEqual(
      sorted.map((row) => row.id),
      ['b', 'c', 'a'],
    );
  });
});

describe('labelFor', () => {
  it('uses the title when one exists, then the first prompt, then (untitled)', () => {
    assert.deepEqual(labelFor(record({ title: 'From Grok' })), {
      text: 'From Grok',
      source: 'title',
    });
    assert.deepEqual(labelFor(record({ firstPrompt: 'the prompt' })), {
      text: 'the prompt',
      source: 'prompt',
    });
    assert.deepEqual(labelFor(record()), { text: '(untitled)', source: 'none' });
  });

  it('collapses whitespace and truncates to 120 characters with a trailing ellipsis', () => {
    const long = `hello\n${'x'.repeat(200)}`;
    const labelled = labelFor(record({ title: long }));
    assert.equal(labelled.source, 'title');
    assert.equal(labelled.text.length, 121);
    assert.ok(labelled.text.endsWith('…'));
    assert.equal(labelled.text.slice(0, 6), 'hello ');
  });
});

describe('matchesQuery', () => {
  const target = record({
    id: '01a00a41-8f57-7de2-bb03-caccc61a1f0e',
    title: 'Login Form Crash',
    firstPrompt: 'The submit button throws on empty email',
  });

  it('matches a case-insensitive substring of the title', () => {
    assert.equal(matchesQuery(target, 'login form'), true);
    assert.equal(matchesQuery(target, 'LOGIN'), true);
  });

  it('matches a case-insensitive substring of the first prompt', () => {
    assert.equal(matchesQuery(target, 'SUBMIT BUTTON'), true);
  });

  it('matches a case-insensitive substring of the id', () => {
    assert.equal(matchesQuery(target, '01A00A41'), true);
  });

  it('rejects a string that appears in none of the three fields', () => {
    assert.equal(matchesQuery(target, 'unrelated'), false);
  });

  it('treats an empty or whitespace query as matching everything', () => {
    assert.equal(matchesQuery(target, ''), true);
    assert.equal(matchesQuery(target, '   '), true);
  });
});

describe('resumeCommand', () => {
  it('returns grok -r <id> with no --cwd, because resume works from any directory', () => {
    assert.equal(
      resumeCommand('01a00a41-8f57-7de2-bb03-caccc61a1f0e'),
      'grok -r 01a00a41-8f57-7de2-bb03-caccc61a1f0e',
    );
  });
});

describe('sessionsStartedDuring', () => {
  const window = {
    startedAt: '2026-08-17T12:00:00.000Z',
    endedAt: '2026-08-17T12:00:20.000Z',
  };

  function shiftIso(iso: string, deltaMs: number): string {
    return new Date(Date.parse(iso) + deltaMs).toISOString();
  }

  const cases: readonly {
    readonly name: string;
    readonly records: readonly SessionRecord[];
    readonly window: { readonly startedAt: string; readonly endedAt: string };
    readonly expected: readonly string[];
  }[] = [
    {
      name: 'keeps a session created inside the window',
      records: [record({ id: 'in', createdAt: '2026-08-17T12:00:10.000Z' })],
      window,
      expected: ['in'],
    },
    {
      name: 'keeps a session created at the exact lower bound, because startedAt is stamped before spawn',
      records: [record({ id: 'start', createdAt: window.startedAt })],
      window,
      expected: ['start'],
    },
    {
      name: 'drops a session created before the window',
      records: [record({ id: 'early', createdAt: '2026-08-17T11:59:59.999Z' })],
      window,
      expected: [],
    },
    {
      name: 'keeps a session created at endedAt plus slack, because summary.json lags the create',
      records: [
        record({ id: 'slack', createdAt: shiftIso(window.endedAt, SESSION_WINDOW_SLACK_MS) }),
      ],
      window,
      expected: ['slack'],
    },
    {
      name: 'drops a session created after the window plus slack',
      records: [
        record({ id: 'late', createdAt: shiftIso(window.endedAt, SESSION_WINDOW_SLACK_MS + 1) }),
      ],
      window,
      expected: [],
    },
    {
      name: 'drops a session whose createdAt is unparseable — absent evidence is not evidence',
      records: [record({ id: 'bad', createdAt: 'not-a-date' })],
      window,
      expected: [],
    },
    {
      name: 'returns an empty list for an empty input',
      records: [],
      window,
      expected: [],
    },
    {
      name: 'returns an empty list when the window bounds themselves do not parse',
      records: [record({ id: 'in', createdAt: '2026-08-17T12:00:10.000Z' })],
      window: { startedAt: 'not-a-date', endedAt: window.endedAt },
      expected: [],
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const matched = sessionsStartedDuring(testCase.records, testCase.window);
      assert.deepEqual(
        matched.map((row) => row.id),
        [...testCase.expected],
      );
    });
  }
});
