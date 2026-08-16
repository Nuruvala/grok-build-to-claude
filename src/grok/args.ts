/**
 * Pure argv construction for a headless `grok` run.
 *
 * The caller `spawn`s this array. Nothing here is quoted, escaped, or joined into a shell string —
 * the prompt reaches the child byte-for-byte, including quotes, newlines, `$VAR`, and backticks.
 *
 * Flag spellings verified against grok 1.0.0 (3cd0d0cbce) on 2026-08-16.
 */

import type { GrokPermissionFlags } from '../permission.js';

export type GrokOutputFormat = 'json' | 'streaming-json';

/** Mutually exclusive session intents. Modelled as a union so an invalid pair cannot be built. */
export type SessionSelector =
  | { readonly kind: 'new' }
  | { readonly kind: 'new-with-id'; readonly id: string }
  | {
      readonly kind: 'resume';
      readonly id?: string | undefined;
      readonly forkId?: string | undefined;
    }
  | { readonly kind: 'continue'; readonly forkId?: string | undefined };

export interface GrokRunParams {
  readonly prompt: string;
  readonly outputFormat: GrokOutputFormat;
  readonly permission: GrokPermissionFlags;
  readonly cwd?: string | undefined;
  /** null means "let the CLI choose" — emit no flag. */
  readonly model?: string | null | undefined;
  readonly effort?: string | null | undefined;
  readonly maxTurns?: number | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
  readonly allow?: readonly string[] | undefined;
  readonly deny?: readonly string[] | undefined;
  readonly rules?: string | undefined;
  readonly agent?: string | undefined;
  readonly jsonSchema?: string | undefined;
  readonly session?: SessionSelector | undefined;
  readonly disableWebSearch?: boolean | undefined;
}

/**
 * Build the argv for a headless `grok` run. Pure; the caller spawns it.
 *
 * Deterministic order, so tests can assert on the whole array:
 * `-p`, `--output-format`, `--cwd`, `--model`, `--effort`, `--permission-mode`, `--sandbox`,
 * `--always-approve`, `--max-turns`, `--tools`, `--disallowed-tools`, `--allow` (repeated),
 * `--deny` (repeated), `--rules`, `--agent`, `--json-schema`, session flags,
 * `--disable-web-search`.
 */
export function buildGrokArgs(params: GrokRunParams): readonly string[] {
  return Object.freeze([
    '-p',
    params.prompt,
    '--output-format',
    params.outputFormat,
    ...flag('--cwd', params.cwd),
    ...flag('--model', params.model),
    ...flag('--effort', params.effort),
    // Emitted unconditionally, unlike every other flag here. Omitting them would let the CLI fall
    // back to its own `default` permission mode and unsandboxed profile, which is more permissive
    // than anything we resolve to — a silent downgrade of the exact guarantee this module exists
    // to keep.
    '--permission-mode',
    params.permission.permissionMode,
    '--sandbox',
    params.permission.sandbox,
    ...bare('--always-approve', params.permission.alwaysApprove),
    ...(params.maxTurns === undefined ? [] : ['--max-turns', `${params.maxTurns}`]),
    ...csv('--tools', params.tools),
    ...csv('--disallowed-tools', params.disallowedTools),
    ...repeated('--allow', params.allow),
    ...repeated('--deny', params.deny),
    ...flag('--rules', params.rules),
    ...flag('--agent', params.agent),
    ...flag('--json-schema', params.jsonSchema),
    ...sessionArgs(params.session),
    ...bare('--disable-web-search', params.disableWebSearch),
  ]);
}

function present(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== '';
}

function flag(name: string, value: string | null | undefined): readonly string[] {
  return present(value) ? [name, value] : [];
}

function bare(name: string, enabled: boolean | undefined): readonly string[] {
  return enabled === true ? [name] : [];
}

function csv(name: string, values: readonly string[] | undefined): readonly string[] {
  return values !== undefined && values.length > 0 ? [name, values.join(',')] : [];
}

function repeated(name: string, values: readonly string[] | undefined): readonly string[] {
  return values?.flatMap((value) => [name, value]) ?? [];
}

function forkArgs(forkId: string | undefined): readonly string[] {
  return present(forkId) ? ['--fork-session', '--session-id', forkId] : [];
}

function sessionArgs(session: SessionSelector | undefined): readonly string[] {
  if (session === undefined) return [];

  switch (session.kind) {
    case 'new':
      return [];
    case 'new-with-id':
      return flag('--session-id', session.id);
    case 'resume':
      return [
        '--resume',
        ...(present(session.id) ? [session.id] : []),
        ...forkArgs(session.forkId),
      ];
    case 'continue':
      return ['--continue', ...forkArgs(session.forkId)];
    default: {
      const unreachable: never = session;
      throw new Error(`unhandled session selector: ${String(unreachable)}`);
    }
  }
}
