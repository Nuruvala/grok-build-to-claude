import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { InvalidArgumentsError } from '../../src/errors.js';
import { newRunId } from '../../src/jobs/record.js';
import {
  ARGV_LIST_ITEM_MAX,
  ARGV_LIST_MAX,
  ARGV_PATH_MAX,
  ARGV_RULES_MAX,
  ARGV_TOKEN_MAX,
} from '../../src/limits.js';
import { toolDescriptors } from '../../src/tools/definitions.js';
import { getTool, invokeTool } from '../../src/tools/registry.js';
import type { ToolContext } from '../../src/types.js';

function dummyCtx(): ToolContext {
  return {
    config: loadConfig({
      HOME: '/tmp/grok-mcp-test-home',
      GROK_BINARY: '/no/such/grok-binary-input-tests',
      GROK_MCP_LOG_LEVEL: 'error',
    }),
    signal: new AbortController().signal,
    reportProgress: () => {
      /* unused */
    },
    progressRequested: false,
  };
}

describe('unknown keys are rejected rather than stripped', () => {
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['check', {}],
    ['help', {}],
    ['grok', { prompt: 'hi' }],
    ['review', {}],
    ['sessions', {}],
    ['websearch', { query: 'what is the latest Node.js' }],
    ['status', {}],
    ['stop', { runId: newRunId(Date.now()) }],
  ];

  for (const [tool, base] of cases) {
    it(`rejects an unrecognised key on ${tool} and names the key`, async () => {
      await assert.rejects(
        () => invokeTool(tool, { ...base, unexpectedKey: true }, dummyCtx()),
        (error: unknown) => {
          assert.ok(error instanceof InvalidArgumentsError);
          assert.match(error.message, /unexpectedKey/);
          return true;
        },
      );
    });
  }

  it('rejects grok permision (a typo for permission) instead of silently running read-only', async () => {
    await assert.rejects(
      () => invokeTool('grok', { prompt: 'hi', permision: 'full' }, dummyCtx()),
      (error: unknown) => {
        assert.ok(error instanceof InvalidArgumentsError);
        assert.match(error.message, /permision/);
        assert.doesNotMatch(error.message, /permission ceiling/);
        return true;
      },
    );
  });
});

describe('tools/list JSON Schema forbids additional properties', () => {
  it('puts additionalProperties: false on every advertised input schema', () => {
    for (const tool of toolDescriptors()) {
      assert.equal(
        tool.inputSchema['additionalProperties'],
        false,
        `${tool.name} must advertise additionalProperties: false`,
      );
    }
  });
});

describe('argv-element length caps', () => {
  const token = 't'.repeat(ARGV_TOKEN_MAX);
  const tokenOver = 't'.repeat(ARGV_TOKEN_MAX + 1);
  // Absolute: cwd refine rejects a relative string before the length check
  // would accept it. `/` plus (MAX-1) p's is still ARGV_PATH_MAX characters.
  const pathAt = `/${'p'.repeat(ARGV_PATH_MAX - 1)}`;
  const pathOver = `/${'p'.repeat(ARGV_PATH_MAX)}`;
  const rulesAt = 'r'.repeat(ARGV_RULES_MAX);
  const rulesOver = 'r'.repeat(ARGV_RULES_MAX + 1);
  const itemAt = 'i'.repeat(ARGV_LIST_ITEM_MAX);
  const itemOver = 'i'.repeat(ARGV_LIST_ITEM_MAX + 1);
  const listAt = Array.from({ length: ARGV_LIST_MAX }, () => 'Bash(x)');
  const listOver = [...listAt, 'Bash(y)'];

  const cases: readonly {
    readonly tool: string;
    readonly field: string;
    readonly base: Record<string, unknown>;
    readonly atLimit: unknown;
    readonly overLimit: unknown;
  }[] = [
    { tool: 'grok', field: 'cwd', base: { prompt: 'hi' }, atLimit: pathAt, overLimit: pathOver },
    { tool: 'grok', field: 'model', base: { prompt: 'hi' }, atLimit: token, overLimit: tokenOver },
    { tool: 'grok', field: 'effort', base: { prompt: 'hi' }, atLimit: token, overLimit: tokenOver },
    { tool: 'grok', field: 'agent', base: { prompt: 'hi' }, atLimit: token, overLimit: tokenOver },
    { tool: 'grok', field: 'resume', base: { prompt: 'hi' }, atLimit: token, overLimit: tokenOver },
    {
      tool: 'grok',
      field: 'sessionId',
      base: { prompt: 'hi' },
      atLimit: token,
      overLimit: tokenOver,
    },
    {
      tool: 'grok',
      field: 'forkSession',
      base: { prompt: 'hi', resume: 'sess' },
      atLimit: token,
      overLimit: tokenOver,
    },
    {
      tool: 'grok',
      field: 'rules',
      base: { prompt: 'hi' },
      atLimit: rulesAt,
      overLimit: rulesOver,
    },
    { tool: 'grok', field: 'tools', base: { prompt: 'hi' }, atLimit: listAt, overLimit: listOver },
    {
      tool: 'grok',
      field: 'disallowedTools',
      base: { prompt: 'hi' },
      atLimit: listAt,
      overLimit: listOver,
    },
    { tool: 'grok', field: 'allow', base: { prompt: 'hi' }, atLimit: listAt, overLimit: listOver },
    { tool: 'grok', field: 'deny', base: { prompt: 'hi' }, atLimit: listAt, overLimit: listOver },
    { tool: 'review', field: 'cwd', base: {}, atLimit: pathAt, overLimit: pathOver },
    { tool: 'review', field: 'model', base: {}, atLimit: token, overLimit: tokenOver },
    { tool: 'review', field: 'effort', base: {}, atLimit: token, overLimit: tokenOver },
    { tool: 'review', field: 'base', base: {}, atLimit: token, overLimit: tokenOver },
    { tool: 'review', field: 'commit', base: {}, atLimit: token, overLimit: tokenOver },
    { tool: 'websearch', field: 'cwd', base: { query: 'q' }, atLimit: pathAt, overLimit: pathOver },
    {
      tool: 'websearch',
      field: 'model',
      base: { query: 'q' },
      atLimit: token,
      overLimit: tokenOver,
    },
    {
      tool: 'websearch',
      field: 'effort',
      base: { query: 'q' },
      atLimit: token,
      overLimit: tokenOver,
    },
  ];

  for (const { tool, field, base, atLimit, overLimit } of cases) {
    it(`rejects ${tool}.${field} over the cap and accepts a value at the cap`, () => {
      const schema = getTool(tool).schema;
      const accepted = schema.safeParse({ ...base, [field]: atLimit });
      assert.equal(accepted.success, true, `${tool}.${field} at the cap must parse`);
      const rejected = schema.safeParse({ ...base, [field]: overLimit });
      if (rejected.success) {
        assert.fail(`${tool}.${field} over the cap must fail`);
      }
      const paths = rejected.error.issues.map((issue) => issue.path.join('.')).join('\n');
      assert.match(paths, new RegExp(field));
    });
  }

  const itemCases: readonly (readonly [string, string])[] = [
    ['tools', 'tools'],
    ['disallowedTools', 'disallowedTools'],
    ['allow', 'allow'],
    ['deny', 'deny'],
  ];

  for (const [field] of itemCases) {
    it(`rejects a ${field} item longer than ${String(ARGV_LIST_ITEM_MAX)} and accepts one at the cap`, () => {
      const schema = getTool('grok').schema;
      const accepted = schema.safeParse({ prompt: 'hi', [field]: [itemAt] });
      assert.equal(accepted.success, true);
      const rejected = schema.safeParse({ prompt: 'hi', [field]: [itemOver] });
      assert.equal(rejected.success, false);
    });
  }
});
