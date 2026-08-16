/**
 * `check` — readiness probe.
 *
 * M0 reports server identity and the resolved configuration, which is what a caller needs to know
 * before spending tokens on a run that the permission ceiling would reject anyway. Binary
 * resolution and the `grok version` / `grok models` probes arrive with `src/grok/binary.ts` in M1.
 */

import { z } from 'zod';

import { defineTool } from '../../types.js';
import type { ToolContext, ToolResult } from '../../types.js';
import { SERVER_NAME, VERSION } from '../../version.js';

const CheckInput = z.object({}).describe('No arguments.').meta({ title: 'CheckInput' });

export const checkTool = defineTool({
  name: 'check',
  title: 'Check Grok Build readiness',
  description:
    'Report grok-build-mcp-server status: version, resolved grok binary, permission ceiling, ' +
    'and run defaults. Call this first when a grok tool behaves unexpectedly.',
  schema: CheckInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: (_input: z.output<typeof CheckInput>, ctx: ToolContext): Promise<ToolResult> => {
    const { config } = ctx;

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
      `structuredContent:  ${config.structuredContentEnabled ? 'enabled' : 'disabled'}`,
      '',
      'CLI probes (grok version, grok models) land in M1; this reports server config only.',
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
    };

    const result: ToolResult = {
      content: [{ type: 'text', text: lines.join('\n'), _meta: meta }],
    };

    if (config.structuredContentEnabled) {
      result.structuredContent = meta;
    }

    return Promise.resolve(result);
  },
});
