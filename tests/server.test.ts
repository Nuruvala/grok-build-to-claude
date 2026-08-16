/**
 * Protocol tests. A real SDK client drives the real server over a real stdio pipe.
 *
 * Deliberately not InMemoryTransport: half the point is proving that nothing pollutes stdout. An
 * in-process transport cannot catch a stray `console.log`.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(REPO_ROOT, 'src', 'index.ts');

async function connect(extraEnv: Record<string, string> = {}): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', ENTRY],
    cwd: REPO_ROOT,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      // Keep test output readable; the server logs to stderr, which the transport inherits.
      GROK_MCP_LOG_LEVEL: 'error',
      ...extraEnv,
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'grok-build-mcp-tests', version: '0.0.0' });
  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

describe('MCP protocol', () => {
  let client: Client;
  let close: () => Promise<void>;

  before(async () => {
    ({ client, close } = await connect());
  });

  after(async () => {
    await close();
  });

  it('completes initialize and reports server identity', () => {
    const info = client.getServerVersion();
    assert.ok(info, 'server did not report identity');
    assert.equal(info.name, 'grok-build');
    assert.match(info.version, /^\d+\.\d+\.\d+/);
  });

  it('advertises the tools capability', () => {
    assert.ok(client.getServerCapabilities()?.tools);
  });

  it('lists check with a valid object input schema', async () => {
    const { tools } = await client.listTools();

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['check'],
    );

    const [check] = tools;
    assert.ok(check);
    assert.equal(check.inputSchema.type, 'object');
    assert.ok(check.description, 'check must advertise a description');

    const { annotations } = check;
    assert.ok(annotations, 'check must advertise annotations');
    assert.equal(annotations.readOnlyHint, true);
    assert.equal(annotations.destructiveHint, false);
  });

  it('calls check and returns the resolved configuration', async () => {
    const result = await client.callTool({ name: 'check', arguments: {} });

    assert.notEqual(result.isError, true);

    const content = result.content as { type: string; text: string }[];
    const [block] = content;
    assert.ok(block);
    assert.equal(block.type, 'text');
    assert.match(block.text, /grok-build v/);
    assert.match(block.text, /permission ceiling: read-only/);
  });

  it('returns metadata on the content block, not structuredContent by default', async () => {
    const result = await client.callTool({ name: 'check', arguments: {} });

    const content = result.content as { _meta?: Record<string, unknown> }[];
    const meta = content[0]?._meta;
    assert.ok(meta);
    assert.equal(meta['permissionCeiling'], 'read-only');
    assert.equal(result.structuredContent, undefined);
  });

  it('reports an unknown tool as isError with the available names', async () => {
    const result = await client.callTool({ name: 'nope', arguments: {} });

    assert.equal(result.isError, true);
    const content = result.content as { text: string }[];
    assert.match(content[0]?.text ?? '', /No tool named "nope"/);
    assert.match(content[0]?.text ?? '', /check/);
  });
});

describe('configuration reaches the running server', () => {
  it('reflects an unattended ceiling in check output', async () => {
    const { client, close } = await connect({
      GROK_MCP_PERMISSION_CEILING: 'full',
      GROK_MCP_DEFAULT_PERMISSION: 'full',
      GROK_BINARY: '/opt/grok/bin/grok',
      STRUCTURED_CONTENT_ENABLED: '1',
    });

    try {
      const result = await client.callTool({ name: 'check', arguments: {} });
      const content = result.content as { text: string }[];

      assert.match(content[0]?.text ?? '', /permission ceiling: full/);
      assert.match(content[0]?.text ?? '', /grok binary: +\/opt\/grok\/bin\/grok/);
      assert.deepEqual(
        (result.structuredContent as Record<string, unknown>)['permissionCeiling'],
        'full',
      );
    } finally {
      await close();
    }
  });
});
