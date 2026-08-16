import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatSessionDetail,
  formatSessionList,
  formatTimestamp,
} from '../../src/sessions/format.js';
import type { ListContext } from '../../src/sessions/format.js';
import type { SessionRecord } from '../../src/sessions/select.js';

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-1',
    cwd: '/tmp/a',
    title: 'A title',
    createdAt: '2026-08-16T21:40:00.000000000Z',
    updatedAt: '2026-08-16T21:50:00.978931614Z',
    numMessages: 4,
    model: 'grok-4.6',
    agent: 'grok-build-plan',
    sandboxProfile: 'read-only',
    effort: 'high',
    gitBranch: 'main',
    headCommit: 'abc123',
    gitRemotes: ['origin'],
    dir: '/store/%2Ftmp%2Fa/sess-1',
    summaryAvailable: true,
    firstPrompt: 'the first prompt',
    ...overrides,
  };
}

const BASE_CONTEXT: ListContext = {
  scope: '/tmp/a',
  query: null,
  matched: 1,
  limit: 20,
  scanned: 1,
  skipped: 0,
  unreadable: 0,
  unlistedDirs: 0,
  promptSearchTruncated: false,
  promptSearchScanned: 0,
  sessionsDir: '/store',
};

describe('formatTimestamp', () => {
  it('renders RFC 3339 UTC at minute precision without using the host locale', () => {
    assert.equal(formatTimestamp('2026-08-16T21:50:00.978931614Z'), '2026-08-16 21:50');
  });

  it('returns (unknown) for null or unparseable input', () => {
    assert.equal(formatTimestamp(null), '(unknown)');
    assert.equal(formatTimestamp('not-a-date'), '(unknown)');
  });
});

describe('formatSessionList', () => {
  it('omits the cwd column when the call is already scoped to that directory', () => {
    const text = formatSessionList([record()], BASE_CONTEXT);
    assert.match(text, /sess-1 {2}2026-08-16 21:50 {2}4 {2}grok-4\.6 {2}A title/);
    assert.doesNotMatch(text, /sess-1.*\/tmp\/a {2}A title/);
    assert.match(text, /started in \/tmp\/a/);
    assert.match(text, /grok -r <id>/);
    assert.match(text, /resume: "<id>"/);
  });

  it('includes the originating cwd as its own column when listing the whole store', () => {
    const text = formatSessionList([record()], { ...BASE_CONTEXT, scope: null });
    assert.match(text, /sess-1 {2}2026-08-16 21:50 {2}4 {2}grok-4\.6 {2}\/tmp\/a {2}A title/);
  });

  it('names skipped and unreadable counts in the header so a partial list is not silent', () => {
    const text = formatSessionList([record()], {
      ...BASE_CONTEXT,
      skipped: 3,
      unreadable: 1,
    });
    assert.match(text, /Partial listing from \/store/);
    assert.match(text, /3 session directories were not read/);
    assert.match(text, /1 summary was missing or unreadable/);
  });

  it('uses singular wording when exactly one directory or summary is partial', () => {
    const text = formatSessionList([], {
      ...BASE_CONTEXT,
      matched: 0,
      skipped: 1,
      unreadable: 2,
      query: 'needle',
    });
    assert.match(text, /1 session directory was not read/);
    assert.match(text, /2 summaries were missing or unreadable/);
    assert.match(text, /No sessions matched "needle"/);
  });

  it('names unlisted project directories and a truncated prompt search in the partial line', () => {
    const text = formatSessionList([], {
      ...BASE_CONTEXT,
      matched: 0,
      unlistedDirs: 1,
      promptSearchTruncated: true,
      promptSearchScanned: 200,
      query: 'login',
    });
    assert.match(text, /1 project directory could not be listed/);
    assert.match(text, /first-prompt matching covered only the 200 most recent sessions/);
  });

  it('says no sessions started in the scoped directory when the filtered list is empty', () => {
    const text = formatSessionList([], { ...BASE_CONTEXT, matched: 0 });
    assert.match(text, /No sessions started in \/tmp\/a/);
  });
});

describe('formatSessionDetail', () => {
  it('includes the id, timestamps, and the literal resume command', () => {
    const text = formatSessionDetail(record());
    assert.match(text, /Session sess-1/);
    assert.match(text, /2026-08-16 21:50/);
    assert.match(text, /grok -r sess-1/);
    assert.match(text, /resume: "sess-1"/);
    assert.match(text, /the first prompt/);
  });
});
