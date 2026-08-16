import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PERMISSION_LEVELS,
  isPermissionLevel,
  isWithinCeiling,
  permissionFlags,
  permissionRank,
} from '../src/permission.js';
import type { PermissionLevel } from '../src/permission.js';

describe('permission levels', () => {
  it('are exactly the three documented levels, in ascending order', () => {
    assert.deepEqual([...PERMISSION_LEVELS], ['read-only', 'write', 'full']);
  });

  it('rank strictly increases with permissiveness', () => {
    assert.ok(permissionRank('read-only') < permissionRank('write'));
    assert.ok(permissionRank('write') < permissionRank('full'));
  });
});

describe('isPermissionLevel', () => {
  for (const level of PERMISSION_LEVELS) {
    it(`accepts "${level}"`, () => {
      assert.equal(isPermissionLevel(level), true);
    });
  }

  // Non-strings reach this predicate from JSON tool arguments, so they must not throw.
  const rejected: readonly (readonly [label: string, value: unknown])[] = [
    ['empty string', ''],
    ['wrong case', 'READ-ONLY'],
    ['missing hyphen', 'readonly'],
    ['a grok flag value, not a level', 'plan'],
    ['an alias we do not accept', 'yolo'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 3],
    ['an object', {}],
    ['an array', []],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      assert.equal(isPermissionLevel(value), false);
    });
  }
});

describe('isWithinCeiling', () => {
  // The full matrix from CLAUDE.md rule 1. The three `false` cells are the ones that must reject
  // rather than clamp — a clamped run reports success and changes nothing.
  const matrix: Record<PermissionLevel, Record<PermissionLevel, boolean>> = {
    'read-only': { 'read-only': true, write: true, full: true },
    write: { 'read-only': false, write: true, full: true },
    full: { 'read-only': false, write: false, full: true },
  };

  for (const requested of PERMISSION_LEVELS) {
    for (const ceiling of PERMISSION_LEVELS) {
      const expected = matrix[requested][ceiling];
      it(`${requested} under ceiling ${ceiling} is ${expected ? 'allowed' : 'denied'}`, () => {
        assert.equal(isWithinCeiling(requested, ceiling), expected);
      });
    }
  }

  it('denies exactly three of the nine combinations', () => {
    const denied = PERMISSION_LEVELS.flatMap((requested) =>
      PERMISSION_LEVELS.filter((ceiling) => !isWithinCeiling(requested, ceiling)),
    );
    assert.equal(denied.length, 3);
  });
});

describe('permissionFlags', () => {
  // Mirrors the table in CLAUDE.md. If the CLI renames a mode, this table is what has to change,
  // and this test is what catches the rest of the codebase assuming the old name.
  const expected: Record<
    PermissionLevel,
    { permissionMode: string; sandbox: string; alwaysApprove: boolean }
  > = {
    'read-only': { permissionMode: 'plan', sandbox: 'read-only', alwaysApprove: false },
    write: { permissionMode: 'acceptEdits', sandbox: 'workspace', alwaysApprove: false },
    full: { permissionMode: 'bypassPermissions', sandbox: 'off', alwaysApprove: true },
  };

  for (const level of PERMISSION_LEVELS) {
    it(`maps ${level} to the documented grok flags`, () => {
      assert.deepEqual({ ...permissionFlags(level) }, expected[level]);
    });
  }

  it('grants --always-approve only at full', () => {
    const approving = PERMISSION_LEVELS.filter((level) => permissionFlags(level).alwaysApprove);
    assert.deepEqual(approving, ['full']);
  });

  it('never sandboxes a full run and always sandboxes the others', () => {
    assert.equal(permissionFlags('full').sandbox, 'off');
    assert.notEqual(permissionFlags('write').sandbox, 'off');
    assert.notEqual(permissionFlags('read-only').sandbox, 'off');
  });
});
