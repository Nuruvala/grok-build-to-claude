/**
 * `help` — passthrough of `grok --help`.
 *
 * A short command; the timeout is capped so a hung binary cannot hold the
 * request for the full run wall clock.
 */

import { z } from 'zod';

import { execGrok } from '../../grok/exec.js';
import { defineTool } from '../../types.js';
import type { ToolContext, ToolResult } from '../../types.js';

/** Same bound as the version/auth probes — help is not a 30-minute job. */
const HELP_TIMEOUT_CAP_MS = 15_000;

const HelpInput = z.strictObject({}).describe('No arguments.').meta({ title: 'HelpInput' });

export const helpTool = defineTool({
  name: 'help',
  title: 'Grok CLI help',
  description: 'Show the grok CLI help text. Runs `grok --help` and returns its stdout.',
  schema: HelpInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (_input: z.output<typeof HelpInput>, ctx: ToolContext): Promise<ToolResult> => {
    const exec = await execGrok({
      binary: ctx.config.grokBinary,
      args: ['--help'],
      timeoutMs: Math.min(ctx.config.timeoutMs, HELP_TIMEOUT_CAP_MS),
      signal: ctx.signal,
    });

    if (exec.outcome === 'spawn-failed') {
      return errorResult(
        `Failed to start grok at "${ctx.config.grokBinary}".\n\n` +
          'Install the grok CLI or set GROK_BINARY to its path.',
      );
    }

    if (exec.outcome === 'timeout') {
      return errorResult(
        `grok --help timed out after ${Math.round(exec.durationMs)} ms.\n\n` +
          // Deliberately not "raise GROK_MCP_TIMEOUT_MS": the cap is a Math.min, so
          // raising that variable cannot move this deadline. Naming a setting that
          // will not help is the same failure as blaming a turn budget nobody set.
          `The cap is ${String(HELP_TIMEOUT_CAP_MS)} ms and GROK_MCP_TIMEOUT_MS cannot raise it. ` +
          'A binary that cannot print its own help in that time is the problem — check ' +
          'GROK_BINARY and try running grok --help yourself.\n' +
          buffered(exec.stdout, exec.stderr),
      );
    }

    if (exec.outcome === 'aborted') {
      return errorResult('The help request was cancelled by the client.');
    }

    if (exec.code !== 0) {
      return errorResult(
        `grok --help exited with code ${exec.code ?? 'unknown'}.\n` +
          buffered(exec.stdout, exec.stderr),
      );
    }

    return { content: [{ type: 'text', text: exec.stdout }] };
  },
});

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function buffered(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout !== '') parts.push('', 'stdout:', stdout);
  if (stderr !== '') parts.push('', 'stderr:', stderr);
  return parts.join('\n');
}
