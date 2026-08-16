/**
 * Shared shapes for tools.
 *
 * A tool is defined once, as a zod schema plus a handler typed against that schema's output. The
 * JSON Schema advertised in `tools/list` is derived from the same zod object — never hand-written
 * alongside it, which is how the two drift.
 */

import type { z } from 'zod';

import type { Config } from './config.js';

export interface TextContentBlock {
  type: 'text';
  text: string;
  _meta?: Record<string, unknown>;
}

export type ContentBlock = TextContentBlock;

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** MCP results are open for extension; the SDK's result type requires this. */
  [key: string]: unknown;
}

export interface ProgressUpdate {
  /** Monotonic. Clients render this against `total` when both are present. */
  progress: number;
  total?: number;
  message?: string;
}

export interface ToolContext {
  readonly config: Config;
  /** Aborted when the client cancels the request or the transport closes. */
  readonly signal: AbortSignal;
  /**
   * Forward a `notifications/progress` to the client. A no-op when the request carried no
   * `progressToken`, so handlers can call it unconditionally.
   */
  readonly reportProgress: (update: ProgressUpdate) => void;
}

/**
 * MCP tool annotations. Hints only — clients use them to decide what needs confirmation, so they
 * must describe the tool honestly.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<Schema extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: Schema;
  readonly annotations: ToolAnnotations;
  readonly handler: (input: z.output<Schema>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Widened form for storage in the registry, where the schema type varies per entry. */
export type AnyToolDefinition = ToolDefinition;

export function defineTool<Schema extends z.ZodType>(
  definition: ToolDefinition<Schema>,
): AnyToolDefinition {
  return definition;
}
