/**
 * Tool registry. The one list `tools/list` advertises and `tools/call` dispatches against.
 *
 * Adding a tool means adding it here and nowhere else.
 */

import type { z } from 'zod';

import { InvalidArgumentsError, UnknownToolError } from '../errors.js';
import type { AnyToolDefinition, ToolContext, ToolResult } from '../types.js';
import { checkTool } from './handlers/check.js';
import { grokTool } from './handlers/grok.js';
import { helpTool } from './handlers/help.js';
import { reviewTool } from './handlers/review.js';
import { sessionsTool } from './handlers/sessions.js';

const TOOLS: readonly AnyToolDefinition[] = [
  checkTool,
  grokTool,
  reviewTool,
  sessionsTool,
  helpTool,
];

const BY_NAME = new Map<string, AnyToolDefinition>(TOOLS.map((tool) => [tool.name, tool]));

export function listTools(): readonly AnyToolDefinition[] {
  return TOOLS;
}

export function toolNames(): readonly string[] {
  return TOOLS.map((tool) => tool.name);
}

export function getTool(name: string): AnyToolDefinition {
  const tool = BY_NAME.get(name);
  if (!tool) {
    throw new UnknownToolError(name, toolNames());
  }
  return tool;
}

/**
 * Validate arguments against the tool's schema, then run it.
 *
 * Validation failures are reported with the full zod issue list rather than the first problem, so
 * a caller fixing a malformed call needs one round trip instead of several.
 */
export async function invokeTool(
  name: string,
  rawArguments: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = getTool(name);
  const parsed = tool.schema.safeParse(rawArguments ?? {});

  if (!parsed.success) {
    throw new InvalidArgumentsError(name, formatIssues(parsed.error));
  }

  return tool.handler(parsed.data, context);
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${location}: ${issue.message}`;
  });
}
