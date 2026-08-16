/**
 * The permission ceiling model.
 *
 * Three ordered levels. The operator sets a ceiling once, at registration; individual calls select
 * a level at or below it. A call above the ceiling is rejected, never clamped — see
 * {@link PermissionDeniedError} for why.
 */

import { PermissionDeniedError } from './errors.js';

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

/** What a tool call asked for, before the ceiling is applied. */
export interface PermissionRequest {
  /** Explicit level from the caller, or undefined when the call asked for nothing. */
  readonly requested: PermissionLevel | undefined;
  /** Server default, applied when `requested` is undefined. */
  readonly defaultLevel: PermissionLevel;
  /** Operator-set maximum. */
  readonly ceiling: PermissionLevel;
}

export interface ResolvedPermission {
  readonly level: PermissionLevel;
  readonly flags: GrokPermissionFlags;
  /** True when the level came from `defaultLevel` rather than an explicit request. */
  readonly fromDefault: boolean;
}

/**
 * Resolve a request against the ceiling.
 *
 * @throws {PermissionDeniedError} when an EXPLICIT request exceeds the ceiling. Never clamps.
 */
export function resolvePermission(request: PermissionRequest): ResolvedPermission {
  // A call that asked for nothing must not throw: config already guarantees default ≤ ceiling,
  // and rejecting here would break the unattended path (ceiling=full, default=full, no args).
  if (request.requested === undefined) {
    return {
      level: request.defaultLevel,
      flags: permissionFlags(request.defaultLevel),
      fromDefault: true,
    };
  }

  if (!isWithinCeiling(request.requested, request.ceiling)) {
    throw new PermissionDeniedError(request.requested, request.ceiling);
  }

  return {
    level: request.requested,
    flags: permissionFlags(request.requested),
    fromDefault: false,
  };
}

/**
 * Map the tool-argument shorthands to a level. `permission` wins over the booleans.
 * Returns undefined when the caller expressed no preference.
 * `yolo: true` means `full`; `write: true` means `write`. `false` is not a request for a lower
 * level — it is the absence of a request, because a JSON schema default of false is
 * indistinguishable from an omitted field.
 */
export function requestedPermissionLevel(input: {
  readonly permission?: PermissionLevel | undefined;
  readonly write?: boolean | undefined;
  readonly yolo?: boolean | undefined;
}): PermissionLevel | undefined {
  if (input.permission !== undefined) {
    return input.permission;
  }
  if (input.yolo === true) {
    return 'full';
  }
  if (input.write === true) {
    return 'write';
  }
  return undefined;
}
