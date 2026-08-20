import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  elapsedMs,
  formatElapsed,
  formatRunDetail,
  formatRunHeader,
  formatRunLine,
  formatTimestamp,
  formatToolCallLine,
} from '../../src/jobs/format.js';
import { RECORD_SCHEMA_VERSION, type RunRecord } from '../../src/jobs/record.js';

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    runId: 'mfk2p1x9-3ac71f0b',
    tool: 'grok',
    summary: 'do a thing',
    state: 'running',
    cwd: '/tmp/a',
    createdAt: '2026-08-17T12:00:00.000Z',
    startedAt: '2026-08-17T12:00:01.000Z',
    endedAt: null,
    workerPid: 12,
    childPid: 34,
    argv: ['-p', 'hi'],
    progressCount: 1,
    lastProgress: '#1 list_dir .',
    lastProgressAt: '2026-08-17T12:00:10.000Z',
    sessionId: null,
    stopReason: null,
    result: null,
    error: null,
    ...overrides,
  };
}

describe('formatElapsed', () => {
  it('renders the documented boundaries: 0, 999 ms, 60 s, 3599 s, 3600 s', () => {
    assert.equal(formatElapsed(0), '0s');
    assert.equal(formatElapsed(999), '0s');
    assert.equal(formatElapsed(45_000), '45s');
    assert.equal(formatElapsed(60_000), '1m 00s');
    assert.equal(formatElapsed(192_000), '3m 12s');
    assert.equal(formatElapsed(3_599_000), '59m 59s');
    assert.equal(formatElapsed(3_600_000), '1h 00m');
    assert.equal(formatElapsed(3_840_000), '1h 04m');
  });
});

describe('formatTimestamp', () => {
  it('renders UTC at minute precision without using the host locale', () => {
    assert.equal(formatTimestamp('2026-08-16T21:50:00.978931614Z'), '2026-08-16 21:50');
    assert.equal(formatTimestamp(null), '(unknown)');
    assert.equal(formatTimestamp('not-a-date'), '(unknown)');
  });
});

describe('formatRunLine / formatRunHeader / formatRunDetail', () => {
  const now = Date.parse('2026-08-17T12:01:00.000Z');

  it('joins runId, state, tool, elapsed, and summary with two spaces', () => {
    const line = formatRunLine(record(), now);
    assert.equal(line, 'mfk2p1x9-3ac71f0b  running  grok  1m 00s  do a thing');
  });

  it('puts showing N of M in the list header', () => {
    assert.equal(formatRunHeader(3, 10), 'Background runs: showing 3 of 10');
  });

  it('includes pids and last progress on a live detail, and omits last progress once terminal', () => {
    const live = formatRunDetail(record(), now);
    assert.match(live, /run mfk2p1x9-3ac71f0b {2}running {2}grok {2}1m 00s/);
    assert.match(live, /workerPid:\s+12/);
    assert.match(live, /childPid:\s+34/);
    assert.match(live, /last:\s+#1 list_dir \. {2}\(50s ago\)/);

    const done = formatRunDetail(
      record({
        state: 'completed',
        endedAt: '2026-08-17T12:00:45.000Z',
      }),
      now,
    );
    assert.doesNotMatch(done, /last:/);
    assert.equal(elapsedMs(record({ endedAt: '2026-08-17T12:00:45.000Z' }), now), 45_000);
  });

  it('renders a tool-call tally on a live detail and omits it when the sidecar predates the field', () => {
    const live = formatRunDetail(
      record(),
      now,
      {
        progressCount: 3,
        lastProgress: '#3 thinking: (file written)',
        lastProgressAt: '2026-08-17T12:00:10.000Z',
        toolCalls: {
          total: 3,
          byLabel: { read_file: 2, grep: 1 },
          lastCallAt: '2026-08-17T12:00:08.000Z',
        },
      },
    );
    assert.match(live, /tools:\s+3 {2}grep 1, read_file 2 {2}\(last 52s ago\)/);

    const none = formatRunDetail(
      record(),
      now,
      {
        progressCount: 12,
        lastProgress: '#12 thinking: (file written)',
        lastProgressAt: '2026-08-17T12:00:10.000Z',
        toolCalls: { total: 0, byLabel: {}, lastCallAt: null },
      },
    );
    assert.match(none, /tools:\s+0$/m);
    assert.doesNotMatch(none, /last 52s ago/);

    const oldSidecar = formatRunDetail(record(), now, {
      progressCount: 1,
      lastProgress: '#1 list_dir .',
      lastProgressAt: '2026-08-17T12:00:10.000Z',
    });
    assert.doesNotMatch(oldSidecar, /tools:/);
  });

  it('renders a completed-but-cut-off run as completed (cut off: cancelled)', () => {
    const cut = record({
      state: 'completed',
      stopReason: 'cancelled',
      endedAt: '2026-08-17T12:00:45.000Z',
    });
    assert.equal(
      formatRunLine(cut, now),
      'mfk2p1x9-3ac71f0b  completed (cut off: cancelled)  grok  45s  do a thing',
    );
    assert.match(formatRunDetail(cut, now), /completed \(cut off: cancelled\)/);
  });
});

describe('formatToolCallLine', () => {
  const now = Date.parse('2026-08-17T12:01:00.000Z');

  it('returns null for a missing tally, 0 for an empty one, and a sorted breakdown when tools ran', () => {
    assert.equal(formatToolCallLine(undefined, now), null);
    assert.equal(
      formatToolCallLine({ total: 0, byLabel: {}, lastCallAt: null }, now),
      '0',
    );
    assert.equal(
      formatToolCallLine(
        {
          total: 3,
          byLabel: { read_file: 2, grep: 1 },
          lastCallAt: '2026-08-17T12:00:08.000Z',
        },
        now,
      ),
      '3  grep 1, read_file 2  (last 52s ago)',
    );
  });
});
