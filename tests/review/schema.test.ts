import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REVIEW_FINDINGS_SCHEMA } from '../../src/review/schema.js';

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.ok(value !== null);
  assert.ok(!Array.isArray(value));
  return value as Record<string, unknown>;
}

describe('REVIEW_FINDINGS_SCHEMA', () => {
  it('parses as JSON and carries the contract the grok CLI depends on', () => {
    const schema = asRecord(JSON.parse(REVIEW_FINDINGS_SCHEMA));
    assert.equal(schema['type'], 'object');
    assert.equal(schema['$schema'], undefined);

    const required = schema['required'];
    assert.ok(Array.isArray(required));
    assert.ok(required.includes('status'));
    assert.ok(required.includes('findings'));

    const properties = asRecord(schema['properties']);
    assert.deepEqual(asRecord(properties['status'])['enum'], ['working', 'final']);

    const findings = asRecord(properties['findings']);
    const items = asRecord(findings['items']);
    assert.deepEqual(items['required'], ['severity', 'file', 'summary', 'rationale']);

    const itemProperties = asRecord(items['properties']);
    assert.deepEqual(asRecord(itemProperties['severity'])['enum'], [
      'critical',
      'high',
      'medium',
      'low',
      'info',
    ]);
  });
});
