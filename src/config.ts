/**
 * Environment parsing. Single source of truth for every tunable.
 *
 * Validation happens once, at startup, and a bad value kills the process before it serves a single
 * request. Deferring a config error to call time turns a one-line startup message into a confusing
 * mid-workflow tool failure.
 */

import os from 'node:os';
import path from 'node:path';

import { ConfigError } from './errors.js';
import { PERMISSION_LEVELS, isPermissionLevel, isWithinCeiling } from './permission.js';
import type { PermissionLevel } from './permission.js';

export const DEFAULTS = {
  grokBinary: 'grok',
  model: 'grok-4.6',
  effort: 'high',
  timeoutMs: 30 * 60 * 1000,
  permissionCeiling: 'read-only',
  defaultPermission: 'read-only',
} as const;

export interface Config {
  /** Executable to spawn. `GROK_BINARY`, else `grok` resolved from PATH. */
  readonly grokBinary: string;
  /** Model passed when a call omits one. `null` means "let the CLI choose". */
  readonly defaultModel: string | null;
  /** Reasoning effort passed when a call omits one. `null` means "let the CLI choose". */
  readonly defaultEffort: string | null;
  /** Wall clock for a single run, in milliseconds. */
  readonly timeoutMs: number;
  /** Highest permission level any call may request. */
  readonly permissionCeiling: PermissionLevel;
  /** Level applied when a call requests none. Always at or below the ceiling. */
  readonly defaultPermission: PermissionLevel;
  /** Directory for background job records. */
  readonly stateDir: string;
  /** Some clients mishandle `structuredContent`, so it is opt-in. */
  readonly structuredContentEnabled: boolean;
}

export type Env = Readonly<Partial<Record<string, string>>>;

function trimmed(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function parseBoolean(env: Env, key: string): boolean {
  const value = trimmed(env, key)?.toLowerCase();
  if (value === undefined) return false;
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off';
}

/**
 * `null` means the caller explicitly opted out ("none" / "off"), which is distinct from "unset".
 * Lets an operator suppress our `grok-4.6` / `high` defaults and let the CLI pick.
 */
function parseOptOutString(env: Env, key: string, fallback: string): string | null {
  const value = trimmed(env, key);
  if (value === undefined) return fallback;
  const lowered = value.toLowerCase();
  if (lowered === 'none' || lowered === 'off' || lowered === 'default') return null;
  return value;
}

function parsePositiveInt(env: Env, key: string, fallback: number, problems: string[]): number {
  const value = trimmed(env, key);
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    problems.push(`${key} must be a positive integer number of milliseconds (got "${value}").`);
    return fallback;
  }
  return parsed;
}

function parseLevel(
  env: Env,
  key: string,
  fallback: PermissionLevel,
  problems: string[],
): PermissionLevel {
  const value = trimmed(env, key);
  if (value === undefined) return fallback;

  const lowered = value.toLowerCase();
  if (!isPermissionLevel(lowered)) {
    problems.push(`${key} must be one of ${PERMISSION_LEVELS.join(', ')} (got "${value}").`);
    return fallback;
  }
  return lowered;
}

function defaultStateDir(env: Env): string {
  const explicit = trimmed(env, 'GROK_MCP_STATE_DIR');
  if (explicit) return path.resolve(explicit);

  const xdgState = trimmed(env, 'XDG_STATE_HOME');
  if (xdgState) return path.join(path.resolve(xdgState), 'grok-mcp');

  const home = trimmed(env, 'HOME') ?? os.homedir();
  if (home) return path.join(home, '.local', 'state', 'grok-mcp');

  return path.join(os.tmpdir(), 'grok-mcp');
}

/**
 * Build a validated config.
 *
 * @throws {ConfigError} listing every problem found, not just the first — one restart should be
 * enough to learn about all of them.
 */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const permissionCeiling = parseLevel(
    env,
    'GROK_MCP_PERMISSION_CEILING',
    DEFAULTS.permissionCeiling,
    problems,
  );
  const defaultPermission = parseLevel(
    env,
    'GROK_MCP_DEFAULT_PERMISSION',
    DEFAULTS.defaultPermission,
    problems,
  );

  if (!isWithinCeiling(defaultPermission, permissionCeiling)) {
    problems.push(
      `GROK_MCP_DEFAULT_PERMISSION="${defaultPermission}" exceeds ` +
        `GROK_MCP_PERMISSION_CEILING="${permissionCeiling}". ` +
        'Raise the ceiling or lower the default; every call would otherwise be rejected.',
    );
  }

  const config: Config = {
    grokBinary: trimmed(env, 'GROK_BINARY') ?? DEFAULTS.grokBinary,
    defaultModel: parseOptOutString(env, 'GROK_MCP_DEFAULT_MODEL', DEFAULTS.model),
    defaultEffort: parseOptOutString(env, 'GROK_MCP_DEFAULT_EFFORT', DEFAULTS.effort),
    timeoutMs: parsePositiveInt(env, 'GROK_MCP_TIMEOUT_MS', DEFAULTS.timeoutMs, problems),
    permissionCeiling,
    defaultPermission,
    stateDir: defaultStateDir(env),
    structuredContentEnabled: parseBoolean(env, 'STRUCTURED_CONTENT_ENABLED'),
  };

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return Object.freeze(config);
}
