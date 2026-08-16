/**
 * Typed errors, and the single place that turns one into text an MCP client will show.
 *
 * Every error surfaced to a caller must say what went wrong *and* what to change. A message that
 * only reports failure makes the model retry the same call.
 */

export type ErrorKind =
  | 'config'
  | 'invalid-arguments'
  | 'unknown-tool'
  | 'permission-denied'
  | 'binary-not-found'
  | 'grok-failed'
  | 'git-failed'
  | 'sessions-store'
  | 'timeout'
  | 'internal';

export class GrokMcpError extends Error {
  readonly kind: ErrorKind;
  /** Concrete next step for the caller. Rendered on its own line after the message. */
  readonly remedy: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    kind: ErrorKind,
    message: string,
    options: { remedy?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GrokMcpError';
    this.kind = kind;
    this.remedy = options.remedy;
    this.details = options.details ? Object.freeze({ ...options.details }) : undefined;
  }
}

/** Bad server configuration. Thrown at startup so the process dies before serving anything. */
export class ConfigError extends GrokMcpError {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super('config', `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`, {
      remedy: 'Fix the environment variables above and restart the MCP server.',
    });
    this.name = 'ConfigError';
    this.problems = Object.freeze([...problems]);
  }
}

export class UnknownToolError extends GrokMcpError {
  constructor(requested: string, available: readonly string[]) {
    super('unknown-tool', `No tool named "${requested}".`, {
      remedy: `Available tools: ${available.join(', ')}.`,
      details: { requested, available },
    });
    this.name = 'UnknownToolError';
  }
}

export class InvalidArgumentsError extends GrokMcpError {
  constructor(tool: string, issues: readonly string[]) {
    super(
      'invalid-arguments',
      `Invalid arguments for "${tool}":\n${issues.map((i) => `  - ${i}`).join('\n')}`,
      { details: { tool, issues } },
    );
    this.name = 'InvalidArgumentsError';
  }
}

/**
 * A call asked for a permission level above the configured ceiling.
 *
 * Deliberately an error rather than a silent downgrade: a clamped run reports success and changes
 * nothing, which is worse than failing.
 */
export class PermissionDeniedError extends GrokMcpError {
  constructor(requested: string, ceiling: string) {
    super(
      'permission-denied',
      `This call requested permission level "${requested}", but the server ceiling is "${ceiling}".`,
      {
        remedy:
          `Re-register the server with GROK_MCP_PERMISSION_CEILING=${requested} to allow it. ` +
          'The request was rejected rather than downgraded, because a silently downgraded run ' +
          'reports success without making the changes you asked for.',
        details: { requested, ceiling },
      },
    );
    this.name = 'PermissionDeniedError';
  }
}

/**
 * A git invocation that had to fail — missing binary, not a repo, or a ref that
 * does not resolve. Expected non-zero exits (no HEAD, no upstream, `diff --no-index`)
 * are not this error; those are detection, not failure.
 */
export class GitError extends GrokMcpError {
  constructor(
    message: string,
    options: {
      remedy?: string;
      stderr?: string;
      cwd?: string;
      argv?: readonly string[];
      cause?: unknown;
    } = {},
  ) {
    const stderr = options.stderr?.trim();
    const details: Record<string, unknown> = {};
    if (stderr !== undefined && stderr !== '') details['stderr'] = stderr;
    if (options.cwd !== undefined) details['cwd'] = options.cwd;
    if (options.argv !== undefined) details['argv'] = [...options.argv];

    const body = stderr !== undefined && stderr !== '' ? `${message}\n\n${stderr}` : message;
    super('git-failed', body, {
      remedy: options.remedy ?? 'Check that git is installed and that cwd is a git working tree.',
      ...(Object.keys(details).length > 0 ? { details } : {}),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'GitError';
  }
}

/**
 * The session store root could not be read. ENOENT is not this error — that is
 * "no sessions yet". Anything else (EACCES, ENOTDIR) is, and the remedy names
 * the directory so the caller can fix the path rather than retry the same call.
 */
export class SessionsStoreError extends GrokMcpError {
  constructor(sessionsDir: string, options: { cause?: unknown; code?: string | undefined } = {}) {
    const details: Record<string, unknown> = { sessionsDir };
    if (options.code !== undefined) details['code'] = options.code;

    super('sessions-store', `Could not read the Grok session store at ${sessionsDir}.`, {
      remedy:
        `Check that ${sessionsDir} is a readable directory, or set GROK_HOME to the directory ` +
        'that contains the sessions/ folder.',
      details,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'SessionsStoreError';
  }
}

/** Render any thrown value as the text body of an `isError: true` tool result. */
export function toErrorText(error: unknown): string {
  if (error instanceof GrokMcpError) {
    return error.remedy ? `${error.message}\n\n${error.remedy}` : error.message;
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

export function errorKind(error: unknown): ErrorKind {
  return error instanceof GrokMcpError ? error.kind : 'internal';
}
