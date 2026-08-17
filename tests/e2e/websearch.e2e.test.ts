/**
 * Opt-in end-to-end test against the real grok CLI.
 *
 * Skipped unless GROK_MCP_E2E=1, so a normal `npm test` run neither spawns
 * grok nor spends money. The assertion is the milestone's acceptance
 * criterion: a cheap websearch call reports that a search actually ran and
 * came back with sources.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { websearchTool } from '../../src/tools/handlers/websearch.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

const skip =
  process.env['GROK_MCP_E2E'] === '1'
    ? false
    : 'set GROK_MCP_E2E=1 to run against the real grok CLI';

const E2E_TIMEOUT_MS = 180_000;

function ctxFor(): ToolContext {
  const env: Record<string, string> = {
    HOME: process.env['HOME'] ?? os.homedir(),
    GROK_MCP_PERMISSION_CEILING: 'read-only',
    GROK_MCP_DEFAULT_PERMISSION: 'read-only',
    GROK_MCP_DEFAULT_MODEL: 'grok-4.6',
    GROK_MCP_TIMEOUT_MS: String(E2E_TIMEOUT_MS),
  };
  const grokHome = process.env['GROK_HOME'];
  if (grokHome !== undefined && grokHome !== '') env['GROK_HOME'] = grokHome;
  const grokBinary = process.env['GROK_BINARY'];
  if (grokBinary !== undefined && grokBinary !== '') env['GROK_BINARY'] = grokBinary;

  return {
    config: loadConfig(env),
    signal: new AbortController().signal,
    reportProgress: () => {
      /* unused */
    },
    progressRequested: false,
  };
}

function textOf(result: ToolResult): string {
  const [block] = result.content;
  assert.ok(block);
  return block.text;
}

function metaOf(result: ToolResult): Record<string, unknown> {
  const [block] = result.content;
  assert.ok(block);
  assert.ok(block._meta);
  return block._meta;
}

describe('websearch e2e against the real grok CLI', { skip }, () => {
  it(
    'a basic search for a stable current fact reports searchPerformed and a non-empty source list',
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const cwd = await mkdtemp(`${os.tmpdir()}/grok-mcp-e2e-websearch-`);
      const ctx = ctxFor();

      try {
        const result = await websearchTool.handler(
          {
            query: 'What is the latest LTS version of Node.js? Answer with the version number.',
            searchDepth: 'basic',
            effort: 'low',
            cwd,
          },
          ctx,
        );

        const meta = metaOf(result);
        assert.notEqual(result.isError, true, textOf(result));
        assert.equal(meta['searchPerformed'], true, textOf(result));
        const sources = meta['sources'];
        assert.ok(Array.isArray(sources), 'sources must be an array');
        assert.ok(sources.length > 0, `expected at least one source; got ${JSON.stringify(meta)}`);
        assert.ok(
          sources.every((entry): entry is string => typeof entry === 'string' && entry !== ''),
          'every source must be a non-empty url string',
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
});
