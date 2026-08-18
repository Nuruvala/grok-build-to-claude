import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyPatch,
  isCutOff,
  isRunId,
  isRunState,
  isTerminal,
  mergeProgress,
  newRunId,
  parseRunProgress,
  parseRunRecord,
  RECORD_SCHEMA_VERSION,
  RUN_ID_PATTERN,
  RunIdSchema,
  SUMMARY_MAX_CHARS,
  summarize,
  timestampFromRunId,
  type RunRecord,
} from '../../src/jobs/record.js';

const ISO = '2026-08-17T12:00:00.000Z';

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    runId: 'mfk2p1x9-3ac71f0b',
    tool: 'grok',
    summary: 'do a thing',
    state: 'completed',
    cwd: '/tmp/a',
    createdAt: ISO,
    startedAt: ISO,
    endedAt: ISO,
    workerPid: 12,
    childPid: 34,
    argv: ['-p', 'hi'],
    progressCount: 3,
    lastProgress: '#3 done',
    lastProgressAt: ISO,
    sessionId: 'sess-1',
    stopReason: 'end_turn',
    result: { text: 'ok', meta: { sessionId: 'sess-1' }, isError: false },
    error: null,
    ...overrides,
  };
}

function parsed(overrides: Record<string, unknown> = {}): RunRecord {
  const record = parseRunRecord(valid(overrides), 'fallback');
  assert.ok(record);
  return record;
}

describe('parseRunRecord', () => {
  it('round-trips a valid record, including result and argv', () => {
    const source = valid();
    const record = parseRunRecord(source, 'fallback');
    assert.ok(record);
    assert.equal(record.runId, 'mfk2p1x9-3ac71f0b');
    assert.equal(record.tool, 'grok');
    assert.equal(record.state, 'completed');
    assert.equal(record.createdAt, ISO);
    assert.deepEqual(record.argv, ['-p', 'hi']);
    assert.ok(record.result);
    assert.equal(record.result.text, 'ok');
    assert.equal(record.result.isError, false);
    assert.equal(record.sessionId, 'sess-1');
    assert.equal(record.stopReason, 'end_turn');
    assert.equal(record.schemaVersion, RECORD_SCHEMA_VERSION);
  });

  it('returns null for a non-object, a missing runId, a missing state, a bad state string, and schemaVersion 2', () => {
    assert.equal(parseRunRecord(null, 'fallback'), null);
    assert.equal(parseRunRecord('nope', 'fallback'), null);
    assert.equal(parseRunRecord(valid({ runId: undefined }), 'fallback'), null);
    assert.equal(parseRunRecord({ state: 'starting', createdAt: ISO }, 'fallback'), null);
    assert.equal(parseRunRecord(valid({ state: undefined }), 'fallback'), null);
    assert.equal(parseRunRecord(valid({ state: 'flying' }), 'fallback'), null);
    assert.equal(parseRunRecord(valid({ schemaVersion: 2 }), 'fallback'), null);
  });

  it('turns wrong-typed optional fields into null (or 0 / empty), never a coercion', () => {
    const record = parsed({
      startedAt: 12,
      workerPid: '99',
      childPid: true,
      argv: ['-p', 1],
      progressCount: '3',
      lastProgress: { text: 'x' },
      sessionId: 0,
      stopReason: 1,
      error: false,
    });
    assert.equal(record.startedAt, null);
    assert.equal(record.workerPid, null);
    assert.equal(record.childPid, null);
    assert.equal(record.argv, null);
    assert.equal(record.progressCount, 0);
    assert.equal(record.lastProgress, null);
    assert.equal(record.sessionId, null);
    assert.equal(record.stopReason, null);
    assert.equal(record.error, null);
  });

  it('ignores unknown extra keys rather than rejecting the record', () => {
    const record = parseRunRecord(valid({ extra: 'noise', also: 1 }), 'fallback');
    assert.ok(record);
    assert.equal(record.runId, 'mfk2p1x9-3ac71f0b');
    assert.equal('extra' in record, false);
  });
});

describe('newRunId', () => {
  it('sorts two ids one millisecond apart in time order as plain strings', () => {
    const earlier = newRunId(1_700_000_000_000, () => 'aaaaaaaa');
    const later = newRunId(1_700_000_000_001, () => '00000000');
    assert.ok(earlier < later, `${earlier} should sort before ${later}`);
  });

  it('yields different ids for the same millisecond when the random source differs', () => {
    const left = newRunId(1_700_000_000_000, () => 'aaaaaaaa');
    const right = newRunId(1_700_000_000_000, () => 'bbbbbbbb');
    assert.notEqual(left, right);
  });

  it('keeps the stamp fixed-width across a decade of timestamps so lexicographic order does not break', () => {
    const start = Date.UTC(2026, 0, 1);
    const decadeLater = Date.UTC(2036, 0, 1);
    const first = newRunId(start, () => '00000000');
    const last = newRunId(decadeLater, () => '00000000');
    const stampWidth = first.split('-')[0]?.length;
    assert.equal(stampWidth, last.split('-')[0]?.length);
    assert.equal(stampWidth, 8);
    assert.ok(first < last);
  });
});

describe('isRunId', () => {
  const rejected: readonly (readonly [string, string])[] = [
    ['../../../../etc', 'parent-directory traversal'],
    ['../..', 'parent segments only'],
    ['.', 'the current-directory segment'],
    ['..', 'the parent-directory segment'],
    ['/etc/passwd', 'an absolute path'],
    ['a/b', 'an embedded slash'],
    ['a\0b', 'a null byte'],
    ['', 'the empty string'],
    ['x'.repeat(5000), 'a 5000-character string'],
  ];

  for (const [value, why] of rejected) {
    it(`rejects ${why}, so it cannot be joined onto the state directory`, () => {
      assert.equal(isRunId(value), false);
      assert.equal(RUN_ID_PATTERN.test(value), false);
      assert.equal(RunIdSchema.safeParse(value).success, false);
    });
  }

  it('accepts two ids issued by newRunId, which is the only shape this server writes', () => {
    const first = newRunId(Date.now());
    const second = newRunId(Date.now() + 1);
    assert.equal(isRunId(first), true);
    assert.equal(isRunId(second), true);
    assert.equal(RunIdSchema.safeParse(first).success, true);
    assert.equal(RunIdSchema.safeParse(second).success, true);
  });
});

describe('summarize', () => {
  it('takes the first non-empty line, collapses whitespace, and cuts over-length with a trailing ellipsis', () => {
    assert.equal(summarize('\n\n  hello   world  \nsecond'), 'hello world');
    assert.equal(summarize('one\ntwo'), 'one');
    assert.equal(summarize(''), '');
    assert.equal(summarize('   \n  \n'), '');

    const long = 'x'.repeat(SUMMARY_MAX_CHARS + 20);
    const cut = summarize(long);
    assert.equal(cut.length, SUMMARY_MAX_CHARS);
    assert.ok(cut.endsWith('…'));
    assert.equal(cut.slice(0, SUMMARY_MAX_CHARS - 1), 'x'.repeat(SUMMARY_MAX_CHARS - 1));
  });
});

describe('applyPatch', () => {
  it('ignores undefined values and does not mutate its input', () => {
    const record = parsed();
    const frozenArgv = record.argv;
    const patched = applyPatch(record, {
      state: 'failed',
      error: 'boom',
      lastProgress: undefined,
    });
    assert.equal(record.state, 'completed');
    assert.equal(record.error, null);
    assert.equal(patched.state, 'failed');
    assert.equal(patched.error, 'boom');
    assert.equal(patched.lastProgress, record.lastProgress);
    assert.equal(record.argv, frozenArgv);
  });
});

describe('isTerminal / isRunState', () => {
  it('treats completed, failed, cancelled, and abandoned as terminal', () => {
    assert.equal(isTerminal('starting'), false);
    assert.equal(isTerminal('running'), false);
    assert.equal(isTerminal('completed'), true);
    assert.equal(isTerminal('failed'), true);
    assert.equal(isTerminal('cancelled'), true);
    assert.equal(isTerminal('abandoned'), true);
    assert.equal(isRunState('running'), true);
    assert.equal(isRunState('nope'), false);
  });

  it('treats a completed record with a non-end_turn stopReason as cut off', () => {
    assert.equal(isCutOff(parsed({ stopReason: 'cancelled' })), true);
    assert.equal(isCutOff(parsed({ stopReason: 'end_turn' })), false);
    assert.equal(isCutOff(parsed({ stopReason: null })), false);
    assert.equal(isCutOff(parsed({ state: 'failed', stopReason: 'cancelled' })), false);
  });
});

describe('mergeProgress', () => {
  it('overlays sidecar fields and leaves an old record untouched when the sidecar is missing', () => {
    const record = parsed({ progressCount: 3, lastProgress: '#3 done' });
    assert.equal(mergeProgress(record, null).progressCount, 3);
    const merged = mergeProgress(record, {
      progressCount: 7,
      lastProgress: '#7 live',
      lastProgressAt: ISO,
    });
    assert.equal(merged.progressCount, 7);
    assert.equal(merged.lastProgress, '#7 live');
    assert.equal(record.progressCount, 3);
  });
});

describe('parseRunProgress', () => {
  it('returns null for a non-object and for a sidecar that is missing progressCount', () => {
    assert.equal(parseRunProgress(null), null);
    assert.equal(parseRunProgress('nope'), null);
    assert.equal(parseRunProgress({ lastProgress: '#1' }), null);
    const parsedProgress = parseRunProgress({
      progressCount: 1,
      lastProgress: '#1',
      lastProgressAt: ISO,
    });
    assert.ok(parsedProgress);
    assert.equal(parsedProgress.progressCount, 1);
    assert.equal(parsedProgress.lastProgress, '#1');
  });
});

describe('timestampFromRunId', () => {
  it('inverts the time prefix of newRunId', () => {
    const now = 1_700_000_000_000;
    const id = newRunId(now, () => 'aaaaaaaa');
    assert.equal(timestampFromRunId(id), now);
    assert.equal(timestampFromRunId(''), null);
  });
});
