/**
 * Registry entries to the wire shape `tools/list` returns.
 *
 * `inputSchema` is generated from each tool's zod schema. There is no parallel hand-written JSON
 * Schema to fall out of sync with validation.
 */

import { z } from 'zod';

import type { AnyToolDefinition, ToolAnnotations } from '../types.js';
import { listTools } from './registry.js';

export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

export function toDescriptor(tool: AnyToolDefinition): McpToolDescriptor {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchemaFor(tool),
    annotations: { title: tool.title, ...tool.annotations },
  };
}

export function toolDescriptors(): McpToolDescriptor[] {
  return listTools().map(toDescriptor);
}

function inputSchemaFor(tool: AnyToolDefinition): Record<string, unknown> {
  const generated = z.toJSONSchema(tool.schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  // `$schema` is noise on an embedded subschema and some clients choke on it.
  const { $schema: _discarded, ...schema } = generated;

  // MCP requires an object schema even when a tool takes no arguments.
  if (schema['type'] !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  return schema;
}
