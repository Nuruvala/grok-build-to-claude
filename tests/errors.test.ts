import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isCallerFault, type ErrorKind } from '../src/errors.js';

describe('isCallerFault', () => {
  const expected: Record<ErrorKind, boolean> = {
    config: false,
    'invalid-arguments': true,
    'unknown-tool': true,
    'permission-denied': true,
    'too-many-runs': true,
    'binary-not-found': false,
    'grok-failed': false,
    'git-failed': false,
    'sessions-store': false,
    'job-store': false,
    timeout: false,
    internal: false,
  };

  for (const [kind, callerFault] of Object.entries(expected) as readonly (readonly [
    ErrorKind,
    boolean,
  ])[]) {
    it(`${kind} → ${callerFault}`, () => {
      assert.equal(isCallerFault(kind), callerFault);
    });
  }
});
