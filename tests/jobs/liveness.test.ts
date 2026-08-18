import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countLiveRuns, STARTUP_GRACE_MS } from '../../src/jobs/liveness.js';
import { parseRunRecord, RECORD_SCHEMA_VERSION, type RunRecord } from '../../src/jobs/record.js';

const ISO = '2026-08-17T12:00:00.000Z';
const NOW = Date.parse(ISO);

function record(overrides: Record<string, unknown> = {}): RunRecord {
  const parsed = parseRunRecord(
    {
      schemaVersion: RECORD_SCHEMA_VERSION,
      runId: 'mfk2p1x9-3ac71f0b',
      tool: 'grok',
      summary: 'do a thing',
      state: 'starting',
      cwd: '/tmp/a',
      createdAt: ISO,
      startedAt: null,
      endedAt: null,
      workerPid: null,
      childPid: null,
      argv: null,
      progressCount: 0,
      lastProgress: null,
      lastProgressAt: null,
      sessionId: null,
      stopReason: null,
      result: null,
      error: null,
      ...overrides,
    },
    'fallback',
  );
  assert.ok(parsed);
  return parsed;
}

describe('countLiveRuns', () => {
  const cases: readonly {
    readonly label: string;
    readonly records: readonly RunRecord[];
    readonly expected: number;
  }[] = [
    { label: 'empty list', records: [], expected: 0 },
    { label: 'completed is terminal', records: [record({ state: 'completed' })], expected: 0 },
    { label: 'failed is terminal', records: [record({ state: 'failed' })], expected: 0 },
    { label: 'cancelled is terminal', records: [record({ state: 'cancelled' })], expected: 0 },
    { label: 'abandoned is terminal', records: [record({ state: 'abandoned' })], expected: 0 },
    {
      label: 'starting inside STARTUP_GRACE_MS counts',
      records: [record({ state: 'starting', createdAt: ISO, workerPid: null })],
      expected: 1,
    },
    {
      label: 'starting past STARTUP_GRACE_MS with no pid is an orphan',
      records: [
        record({
          state: 'starting',
          createdAt: new Date(NOW - STARTUP_GRACE_MS - 1).toISOString(),
          workerPid: null,
        }),
      ],
      expected: 0,
    },
    {
      label: 'mix of live, terminal, and orphan',
      records: [
        record({ state: 'starting', runId: 'mfk2p1x9-11111111' }),
        record({ state: 'running', runId: 'mfk2p1x9-22222222', startedAt: ISO }),
        record({ state: 'completed', runId: 'mfk2p1x9-33333333' }),
        record({
          state: 'starting',
          runId: 'mfk2p1x9-44444444',
          createdAt: new Date(NOW - STARTUP_GRACE_MS - 1).toISOString(),
        }),
      ],
      expected: 2,
    },
  ];

  for (const { label, records, expected } of cases) {
    it(`${label} → ${expected}`, () => {
      assert.equal(countLiveRuns(records, NOW), expected);
    });
  }
});
