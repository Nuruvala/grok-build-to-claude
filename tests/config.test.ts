import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULTS, loadConfig } from '../src/config.js';
import type { Env } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

/** Isolated env — never inherit the developer's real settings into a test. */
function env(overrides: Record<string, string> = {}): Env {
  return { HOME: '/home/tester', ...overrides };
}

describe('loadConfig defaults', () => {
  it('is read-only out of the box', () => {
    const config = loadConfig(env());
    assert.equal(config.permissionCeiling, 'read-only');
    assert.equal(config.defaultPermission, 'read-only');
  });

  it('applies the documented model and effort defaults', () => {
    const config = loadConfig(env());
    assert.equal(config.defaultModel, DEFAULTS.model);
    assert.equal(config.defaultEffort, DEFAULTS.effort);
  });

  it('defaults the binary to bare grok and the timeout to 30 minutes', () => {
    const config = loadConfig(env());
    assert.equal(config.grokBinary, 'grok');
    assert.equal(config.timeoutMs, 30 * 60 * 1000);
  });

  it('returns a frozen object', () => {
    const config = loadConfig(env());
    assert.ok(Object.isFrozen(config));
  });
});

describe('loadConfig permission levels', () => {
  it('accepts every documented level', () => {
    for (const level of ['read-only', 'write', 'full'] as const) {
      const config = loadConfig(env({ GROK_MCP_PERMISSION_CEILING: level }));
      assert.equal(config.permissionCeiling, level);
    }
  });

  it('is case insensitive', () => {
    const config = loadConfig(env({ GROK_MCP_PERMISSION_CEILING: 'FULL' }));
    assert.equal(config.permissionCeiling, 'full');
  });

  it('rejects an unknown level and names the valid ones', () => {
    assert.throws(
      () => loadConfig(env({ GROK_MCP_PERMISSION_CEILING: 'yolo' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /GROK_MCP_PERMISSION_CEILING/);
        assert.match(error.message, /read-only, write, full/);
        return true;
      },
    );
  });

  it('rejects a default above the ceiling instead of clamping it', () => {
    assert.throws(
      () =>
        loadConfig(
          env({
            GROK_MCP_PERMISSION_CEILING: 'read-only',
            GROK_MCP_DEFAULT_PERMISSION: 'full',
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /exceeds/);
        return true;
      },
    );
  });

  it('allows the unattended configuration', () => {
    const config = loadConfig(
      env({ GROK_MCP_PERMISSION_CEILING: 'full', GROK_MCP_DEFAULT_PERMISSION: 'full' }),
    );
    assert.equal(config.permissionCeiling, 'full');
    assert.equal(config.defaultPermission, 'full');
  });
});

describe('loadConfig reports every problem at once', () => {
  it('lists all failures in a single error', () => {
    assert.throws(
      () => loadConfig(env({ GROK_MCP_PERMISSION_CEILING: 'nope', GROK_MCP_TIMEOUT_MS: 'soon' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.problems.length, 2);
        return true;
      },
    );
  });
});

describe('loadConfig timeout', () => {
  it('accepts a positive integer', () => {
    assert.equal(loadConfig(env({ GROK_MCP_TIMEOUT_MS: '5000' })).timeoutMs, 5000);
  });

  for (const bad of ['0', '-1', '1.5', 'abc', 'Infinity']) {
    it(`rejects ${bad}`, () => {
      assert.throws(() => loadConfig(env({ GROK_MCP_TIMEOUT_MS: bad })), ConfigError);
    });
  }
});

describe('loadConfig model and effort opt-out', () => {
  it('passes an explicit model through', () => {
    assert.equal(loadConfig(env({ GROK_MCP_DEFAULT_MODEL: 'grok-4.5' })).defaultModel, 'grok-4.5');
  });

  for (const optOut of ['none', 'off', 'default', 'NONE']) {
    it(`treats "${optOut}" as defer-to-grok`, () => {
      const config = loadConfig(env({ GROK_MCP_DEFAULT_MODEL: optOut }));
      assert.equal(config.defaultModel, null);
    });
  }

  it('treats an empty string as unset, not as opt-out', () => {
    assert.equal(
      loadConfig(env({ GROK_MCP_DEFAULT_EFFORT: '   ' })).defaultEffort,
      DEFAULTS.effort,
    );
  });
});

describe('loadConfig state dir', () => {
  it('prefers an explicit GROK_MCP_STATE_DIR', () => {
    const config = loadConfig(env({ GROK_MCP_STATE_DIR: '/var/tmp/grok-runs' }));
    assert.equal(config.stateDir, '/var/tmp/grok-runs');
  });

  it('falls back to XDG_STATE_HOME', () => {
    const config = loadConfig(env({ XDG_STATE_HOME: '/home/tester/.state' }));
    assert.equal(config.stateDir, '/home/tester/.state/grok-mcp');
  });

  it('falls back to ~/.local/state', () => {
    assert.equal(loadConfig(env()).stateDir, '/home/tester/.local/state/grok-mcp');
  });

  it('falls back to the OS home when the environment carries no HOME', () => {
    // Deliberately not the env() helper: this exercises the os.homedir() path.
    const config = loadConfig({});
    assert.equal(config.stateDir, path.join(os.homedir(), '.local', 'state', 'grok-mcp'));
  });

  it('resolves a relative state dir to an absolute path', () => {
    const config = loadConfig(env({ GROK_MCP_STATE_DIR: 'runs' }));
    assert.ok(path.isAbsolute(config.stateDir));
  });
});

describe('loadConfig sessions dir', () => {
  it('defaults to $HOME/.grok/sessions', () => {
    assert.equal(loadConfig(env()).sessionsDir, '/home/tester/.grok/sessions');
  });

  it('prefers GROK_HOME over HOME', () => {
    const config = loadConfig(env({ GROK_HOME: '/opt/grok-home' }));
    assert.equal(config.sessionsDir, '/opt/grok-home/sessions');
  });

  it('falls back to the OS home when the environment carries no HOME', () => {
    const config = loadConfig({});
    assert.equal(config.sessionsDir, path.join(os.homedir(), '.grok', 'sessions'));
  });

  it('resolves a relative GROK_HOME to an absolute sessions dir', () => {
    const config = loadConfig(env({ GROK_HOME: 'rel-grok' }));
    assert.ok(path.isAbsolute(config.sessionsDir));
    assert.ok(config.sessionsDir.endsWith(`${path.sep}rel-grok${path.sep}sessions`));
  });
});

describe('loadConfig structuredContent', () => {
  it('is off unless asked for', () => {
    assert.equal(loadConfig(env()).structuredContentEnabled, false);
  });

  it('is on for truthy values', () => {
    assert.equal(
      loadConfig(env({ STRUCTURED_CONTENT_ENABLED: '1' })).structuredContentEnabled,
      true,
    );
  });

  for (const falsey of ['0', 'false', 'no', 'off']) {
    it(`stays off for "${falsey}"`, () => {
      const config = loadConfig(env({ STRUCTURED_CONTENT_ENABLED: falsey }));
      assert.equal(config.structuredContentEnabled, false);
    });
  }
});
