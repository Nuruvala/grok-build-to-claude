/**
 * The permission ceiling model.
 *
 * Three ordered levels. The operator sets a ceiling once, at registration; individual calls select
 * a level at or below it. A call above the ceiling is rejected, never clamped — see
 * {@link PermissionDeniedError} for why.
 *
 * Resolving a *request* against the ceiling lands in M1 alongside the `grok` tool. This module
 * defines the levels themselves, which config validation already needs.
 */

export const PERMISSION_LEVELS = ['read-only', 'write', 'full'] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

/** Ordering. Higher is more permissive. Only meaningful for comparison. */
const RANK: Record<PermissionLevel, number> = {
  'read-only': 0,
  write: 1,
  full: 2,
};

export interface GrokPermissionFlags {
  readonly permissionMode: string;
  readonly sandbox: string;
  /** `full` uses `--always-approve`; `--yolo` is documented but absent from `grok --help`. */
  readonly alwaysApprove: boolean;
}

/**
 * Level to `grok` flags.
 *
 * Verified against grok 1.0.0. `--permission-mode` accepts
 * `default|acceptEdits|auto|dontAsk|bypassPermissions|plan`; `--sandbox` accepts
 * `off|workspace|devbox|read-only|strict`.
 */
const FLAGS: Record<PermissionLevel, GrokPermissionFlags> = {
  'read-only': { permissionMode: 'plan', sandbox: 'read-only', alwaysApprove: false },
  write: { permissionMode: 'acceptEdits', sandbox: 'workspace', alwaysApprove: false },
  full: { permissionMode: 'bypassPermissions', sandbox: 'off', alwaysApprove: true },
};

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === 'string' && (PERMISSION_LEVELS as readonly string[]).includes(value);
}

export function permissionRank(level: PermissionLevel): number {
  return RANK[level];
}

/** True when `requested` is allowed under `ceiling`. */
export function isWithinCeiling(requested: PermissionLevel, ceiling: PermissionLevel): boolean {
  return RANK[requested] <= RANK[ceiling];
}

export function permissionFlags(level: PermissionLevel): GrokPermissionFlags {
  return FLAGS[level];
}
