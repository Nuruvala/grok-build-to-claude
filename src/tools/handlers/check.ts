/**
 * `check` — readiness probe.
 *
 * Reports server identity, the resolved configuration, and live CLI probes
 * (`grok version`, `grok models`). A missing or unauthenticated binary is
 * reported as `ok: false` in the body, not as `isError` — a readiness probe
 * that fails to report is useless.
 */

import { z } from 'zod';

import { probeAuth, probeVersion } from '../../grok/binary.js';
import { defineTool } from '../../types.js';
import type { ToolContext, ToolResult } from '../../types.js';
import { SERVER_NAME, VERSION } from '../../version.js';

const CheckInput = z.strictObject({}).describe('No arguments.').meta({ title: 'CheckInput' });

export const checkTool = defineTool({
  name: 'check',
  title: 'Check Grok Build readiness',
  description:
    'Report grok-build-mcp-server status: version, resolved grok binary, permission ceiling, ' +
    'CLI readiness (`grok version`, `grok models`), and run defaults. Call this first when a ' +
    'grok tool behaves unexpectedly.',
  schema: CheckInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (_input: z.output<typeof CheckInput>, ctx: ToolContext): Promise<ToolResult> => {
    const { config } = ctx;

    // ctx.signal is forwarded so a cancelled check does not leave two grok processes running out
    // the probe cap. Both probes are total, so a cancellation surfaces as ok: false, not a throw.
    const [version, auth] = await Promise.all([
      probeVersion(config.grokBinary, config.timeoutMs, ctx.signal),
      probeAuth(config.grokBinary, config.timeoutMs, ctx.signal),
    ]);

    const ok = version.ok && auth.ok;
    const versionText = version.ok
      ? (version.version ?? '(unknown)')
      : `unavailable — ${version.problem ?? 'unknown error'}`;
    const authText = auth.ok ? 'yes' : `no — ${auth.problem ?? 'unknown error'}`;
    const modelsText = auth.models.length > 0 ? auth.models.join(', ') : '(none reported)';

    const lines = [
      `${SERVER_NAME} v${VERSION}`,
      '',
      `grok binary:        ${config.grokBinary}`,
      `permission ceiling: ${config.permissionCeiling}`,
      `default permission: ${config.defaultPermission}`,
      `default model:      ${config.defaultModel ?? '(let grok choose)'}`,
      `default effort:     ${config.defaultEffort ?? '(let grok choose)'}`,
      `run timeout:        ${config.timeoutMs} ms`,
      `state dir:          ${config.stateDir}`,
      `sessions dir:       ${config.sessionsDir}`,
      `structuredContent:  ${config.structuredContentEnabled ? 'enabled' : 'disabled'}`,
      '',
      `ok:                 ${ok}`,
      `grok version:       ${versionText}`,
      `authenticated:      ${authText}`,
      `models:             ${modelsText}`,
    ];

    if (config.permissionCeiling === 'read-only') {
      lines.push(
        '',
        'Ceiling is read-only, so no tool can modify files. To allow writes, re-register with',
        'GROK_MCP_PERMISSION_CEILING=write (or =full for unattended full approval).',
      );
    }

    const meta: Record<string, unknown> = {
      server: SERVER_NAME,
      version: VERSION,
      grokBinary: config.grokBinary,
      permissionCeiling: config.permissionCeiling,
      defaultPermission: config.defaultPermission,
      defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort,
      timeoutMs: config.timeoutMs,
      stateDir: config.stateDir,
      sessionsDir: config.sessionsDir,
      ok,
      grokVersion: version.version,
      authenticated: auth.ok,
      models: auth.models,
      versionProblem: version.problem,
      authProblem: auth.problem,
    };

    const result: ToolResult = {
      content: [{ type: 'text', text: lines.join('\n'), _meta: meta }],
    };

    if (config.structuredContentEnabled) {
      result.structuredContent = meta;
    }

    return result;
  },
});
