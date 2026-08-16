import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PermissionDeniedError } from '../src/errors.js';
import {
  PERMISSION_LEVELS,
  isPermissionLevel,
  isWithinCeiling,
  permissionFlags,
  permissionRank,
  requestedPermissionLevel,
  resolvePermission,
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

describe('resolvePermission', () => {
  // Full 3×3 requested × ceiling matrix. Six resolve; three must throw rather than clamp —
  // a clamped run reports success and changes nothing.
  for (const requested of PERMISSION_LEVELS) {
    for (const ceiling of PERMISSION_LEVELS) {
      const allowed = isWithinCeiling(requested, ceiling);

      if (allowed) {
        it(`honours an explicit ${requested} request under ceiling ${ceiling}`, () => {
          const resolved = resolvePermission({
            requested,
            defaultLevel: 'read-only',
            ceiling,
          });
          assert.equal(resolved.level, requested);
          assert.equal(resolved.fromDefault, false);
          assert.deepEqual({ ...resolved.flags }, permissionFlags(requested));
        });
      } else {
        it(`rejects an explicit ${requested} request under ceiling ${ceiling} instead of clamping`, () => {
          assert.throws(
            () =>
              resolvePermission({
                requested,
                defaultLevel: 'read-only',
                ceiling,
              }),
            PermissionDeniedError,
          );
        });
      }
    }
  }

  it('denies exactly three of the nine explicit combinations', () => {
    const denied = PERMISSION_LEVELS.flatMap((requested) =>
      PERMISSION_LEVELS.filter((ceiling) => {
        try {
          resolvePermission({ requested, defaultLevel: 'read-only', ceiling });
          return false;
        } catch {
          return true;
        }
      }),
    );
    assert.equal(denied.length, 3);
  });

  it('names both levels and GROK_MCP_PERMISSION_CEILING so the operator knows what to change', () => {
    assert.throws(
      () =>
        resolvePermission({
          requested: 'full',
          defaultLevel: 'read-only',
          ceiling: 'read-only',
        }),
      (error: unknown) => {
        assert.ok(error instanceof PermissionDeniedError);
        assert.match(error.message, /"full"/);
        assert.match(error.message, /"read-only"/);
        assert.ok(error.remedy);
        assert.match(error.remedy, /GROK_MCP_PERMISSION_CEILING/);
        return true;
      },
    );
  });

  // Config already guarantees default ≤ ceiling. These are the six valid pairs; none may throw.
  const defaultMatrix: readonly (readonly [PermissionLevel, PermissionLevel])[] = [
    ['read-only', 'read-only'],
    ['read-only', 'write'],
    ['read-only', 'full'],
    ['write', 'write'],
    ['write', 'full'],
    ['full', 'full'],
  ];

  for (const [defaultLevel, ceiling] of defaultMatrix) {
    it(`uses default ${defaultLevel} under ceiling ${ceiling} when the call asked for nothing`, () => {
      const resolved = resolvePermission({
        requested: undefined,
        defaultLevel,
        ceiling,
      });
      assert.equal(resolved.level, defaultLevel);
      assert.equal(resolved.fromDefault, true);
      assert.deepEqual({ ...resolved.flags }, permissionFlags(defaultLevel));
    });
  }

  it('emits --always-approve on the unattended path, where ceiling and default are both full', () => {
    const resolved = resolvePermission({
      requested: undefined,
      defaultLevel: 'full',
      ceiling: 'full',
    });
    assert.equal(resolved.level, 'full');
    assert.equal(resolved.fromDefault, true);
    assert.equal(resolved.flags.alwaysApprove, true);
  });
});

describe('requestedPermissionLevel', () => {
  it('returns undefined when the caller expressed no preference, including false booleans, because a JSON schema default of false is indistinguishable from an omitted field', () => {
    assert.equal(requestedPermissionLevel({}), undefined);
    assert.equal(requestedPermissionLevel({ write: false }), undefined);
    assert.equal(requestedPermissionLevel({ yolo: false }), undefined);
    assert.equal(requestedPermissionLevel({ write: false, yolo: false }), undefined);
  });

  it('maps write: true to write', () => {
    assert.equal(requestedPermissionLevel({ write: true }), 'write');
  });

  it('maps yolo: true to full', () => {
    assert.equal(requestedPermissionLevel({ yolo: true }), 'full');
  });

  it('lets yolo beat write when both are true, because yolo is the higher level', () => {
    assert.equal(requestedPermissionLevel({ write: true, yolo: true }), 'full');
  });

  it('lets an explicit permission beat the boolean shorthands, because the named level is the request', () => {
    assert.equal(
      requestedPermissionLevel({ permission: 'read-only', write: true, yolo: true }),
      'read-only',
    );
    assert.equal(
      requestedPermissionLevel({ permission: 'write', write: true, yolo: true }),
      'write',
    );
    assert.equal(
      requestedPermissionLevel({ permission: 'full', write: false, yolo: false }),
      'full',
    );
  });

  // Every combination of the three inputs. `permission` wins; else `yolo`; else `write`; else none.
  const permissions = [undefined, ...PERMISSION_LEVELS] as const;
  const booleans = [undefined, true, false] as const;

  for (const permission of permissions) {
    for (const write of booleans) {
      for (const yolo of booleans) {
        const expected =
          permission ?? (yolo === true ? 'full' : write === true ? 'write' : undefined);
        const label = `permission=${String(permission)} write=${String(write)} yolo=${String(yolo)}`;

        it(`resolves ${label} to ${String(expected)}`, () => {
          assert.equal(requestedPermissionLevel({ permission, write, yolo }), expected);
        });
      }
    }
  }
});
