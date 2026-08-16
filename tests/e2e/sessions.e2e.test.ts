/**
 * Opt-in end-to-end test against the real grok CLI.
 *
 * Skipped unless GROK_MCP_E2E=1, so a normal `npm test` run neither spawns
 * grok nor spends money. The two assertions are the milestone's acceptance
 * criteria: a resume id shares context, and a reported id is findable in the
 * store immediately — the bundled plugin's "session id that does not resume"
 * bug, inverted.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { grokTool } from '../../src/tools/handlers/grok.js';
import { sessionsTool } from '../../src/tools/handlers/sessions.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

const skip =
  process.env['GROK_MCP_E2E'] === '1'
    ? false
    : 'set GROK_MCP_E2E=1 to run against the real grok CLI';

const MARKER = 'M4MARKER-QUETZAL';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionIdOf(value: unknown): string {
  assert.ok(isRecord(value));
  const id = value['id'];
  assert.ok(typeof id === 'string');
  return id;
}

describe('sessions e2e against the real grok CLI', { skip }, () => {
  it(
    'a reported session id resumes with shared context and is findable in the store immediately',
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const cwd = await mkdtemp(`${os.tmpdir()}/grok-mcp-e2e-sessions-`);
      const ctx = ctxFor();

      try {
        const first = await grokTool.handler(
          {
            prompt: `Remember this marker word exactly and reply with only the word OK: ${MARKER}`,
            cwd,
            model: 'grok-4.6',
          },
          ctx,
        );

        assert.notEqual(first.isError, true, textOf(first));
        const sessionId = metaOf(first)['sessionId'];
        assert.ok(
          typeof sessionId === 'string' && sessionId !== '',
          'the first call must report a non-empty session id',
        );
        assert.equal(metaOf(first)['resumeCommand'], `grok -r ${sessionId}`);

        const second = await grokTool.handler(
          {
            prompt: 'What was the marker word I asked you to remember? Reply with only that word.',
            cwd,
            resume: sessionId,
            model: 'grok-4.6',
          },
          ctx,
        );

        const secondText = textOf(second);
        assert.notEqual(second.isError, true, secondText);
        assert.match(
          secondText,
          new RegExp(MARKER, 'i'),
          `second call must recall the marker; got: ${secondText}`,
        );

        const byId = await sessionsTool.handler({ id: sessionId }, ctx);
        assert.equal(byId.isError, false);
        assert.equal(
          metaOf(byId)['found'],
          true,
          `reported session id ${sessionId} was not in ${ctx.config.sessionsDir}`,
        );

        const listed = await sessionsTool.handler({ cwd }, ctx);
        assert.equal(listed.isError, false);
        const rows = metaOf(listed)['sessions'];
        assert.ok(Array.isArray(rows));
        const ids = rows.map(sessionIdOf);
        assert.ok(
          ids.includes(sessionId),
          `cwd-scoped list from ${cwd} did not include ${sessionId}: ${ids.join(', ')}`,
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
});
