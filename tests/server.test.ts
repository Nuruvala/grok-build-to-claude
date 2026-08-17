/**
 * Protocol tests. A real SDK client drives the real server over a real stdio pipe.
 *
 * Deliberately not InMemoryTransport: half the point is proving that nothing pollutes stdout. An
 * in-process transport cannot catch a stray `console.log`.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(REPO_ROOT, 'src', 'index.ts');
const FAKE_GROK = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-grok.mjs');

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
      // Never inherit the developer's grok. The fake records argv and exits immediately.
      GROK_BINARY: FAKE_GROK,
      // One canned stdout serves both probes: probeVersion reads the first line, probeAuth reads
      // the bullets. The bullet layout mirrors the real `grok models` output — a bare id on its
      // own line is not something the CLI emits, and is no longer parsed as one.
      FAKE_GROK_STDOUT: 'grok 1.0.0 (fake) [test]\n\nAvailable models:\n  * grok-4.6 (default)\n',
      GROK_MCP_TIMEOUT_MS: '5000',
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

  it('lists check, grok, review, sessions, status, stop, and help with a description and a valid object input schema each', async () => {
    const { tools } = await client.listTools();

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['check', 'grok', 'review', 'sessions', 'status', 'stop', 'help'],
    );

    for (const tool of tools) {
      assert.ok(tool.description, `${tool.name} must advertise a description`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema must be an object`);
    }

    const check = tools[0];
    assert.ok(check);
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
    assert.match(block.text, /ok:\s+true/);
    assert.match(block.text, /grok version:\s+grok 1\.0\.0 \(fake\) \[test\]/);
    assert.match(block.text, /authenticated:\s+yes/);
    assert.match(block.text, /models:\s+grok-4\.6/);
    assert.match(block.text, /sessions dir:/);
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

  it('returns the zod issue list when grok is called without a prompt, rather than crashing', async () => {
    const result = await client.callTool({ name: 'grok', arguments: {} });

    assert.equal(result.isError, true);
    const content = result.content as { text: string }[];
    const text = content[0]?.text ?? '';
    assert.match(text, /Invalid arguments for "grok"/);
    assert.match(text, /prompt/);
  });

  it('advertises status with an object input schema and readOnlyHint true', async () => {
    const { tools } = await client.listTools();
    const status = tools.find((tool) => tool.name === 'status');
    assert.ok(status);
    assert.equal(status.inputSchema.type, 'object');
    assert.equal(status.annotations?.readOnlyHint, true);
  });

  it('advertises stop with destructiveHint true and treats a bogus id as a successful miss', async () => {
    const { tools } = await client.listTools();
    const stop = tools.find((tool) => tool.name === 'stop');
    assert.ok(stop);
    assert.equal(stop.inputSchema.type, 'object');
    const annotations = stop.annotations;
    assert.ok(annotations);
    assert.equal(annotations.destructiveHint, true);
    assert.equal(annotations.readOnlyHint, false);
    assert.equal(annotations.idempotentHint, true);

    const result = await client.callTool({ name: 'stop', arguments: { runId: 'nope-not-a-run' } });
    assert.notEqual(result.isError, true);
    const content = result.content as { text: string; _meta: Record<string, unknown> }[];
    const [block] = content;
    assert.ok(block);
    assert.equal(block._meta['found'], false);
    assert.match(block.text, /nope-not-a-run/);
  });

  it('calls help and returns the grok --help text from the fake', async () => {
    const result = await client.callTool({ name: 'help', arguments: {} });

    assert.notEqual(result.isError, true);
    const content = result.content as { text: string }[];
    assert.match(content[0]?.text ?? '', /grok 1\.0\.0 \(fake\) \[test\]/);
  });
});

describe('grok streaming progress over stdio', () => {
  const streamHappy = path.join(REPO_ROOT, 'tests', 'fixtures', 'stream-happy.ndjson');
  const streamSlow = path.join(REPO_ROOT, 'tests', 'fixtures', 'stream-slow.ndjson');

  it('delivers progress notifications to the SDK client through the real transport', async () => {
    const { client, close } = await connect({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: streamHappy,
      FAKE_GROK_STREAM_SPLIT: '1',
    });

    try {
      const seen: { progress: number; message?: string }[] = [];
      const result = await client.callTool(
        { name: 'grok', arguments: { prompt: 'go' } },
        undefined,
        {
          onprogress: (update) => {
            seen.push({
              progress: update.progress,
              ...(update.message === undefined ? {} : { message: update.message }),
            });
          },
        },
      );

      assert.notEqual(result.isError, true);
      assert.ok(seen.length > 0, 'expected at least one progress notification to reach the client');
      assert.ok(
        seen.some((entry) => entry.message !== undefined && entry.message !== ''),
        `expected a progress message, got ${JSON.stringify(seen)}`,
      );
    } finally {
      await close();
    }
  });

  it('keeps a slow run alive when the client resets its timeout on progress', async () => {
    const { client, close } = await connect({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: streamSlow,
      FAKE_GROK_STREAM_DELAY_MS: '400',
      GROK_MCP_TIMEOUT_MS: '15000',
    });

    try {
      const result = await client.callTool(
        { name: 'grok', arguments: { prompt: 'go' } },
        undefined,
        {
          onprogress: () => {
            /* reset is what we are proving; the callback itself can be empty */
          },
          // Three times the 400 ms gap between lines. The reset test fails only if a single gap
          // stretches past this, so the margin is deliberately wide — a 2x margin is what made an
          // earlier timing test in this repo flake.
          timeout: 1200,
          resetTimeoutOnProgress: true,
        },
      );
      assert.notEqual(result.isError, true);
    } finally {
      await close();
    }
  });

  it('times out the same slow run when the client does not reset on progress', async () => {
    const { client, close } = await connect({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: streamSlow,
      FAKE_GROK_STREAM_DELAY_MS: '400',
      GROK_MCP_TIMEOUT_MS: '15000',
    });

    try {
      await assert.rejects(
        () =>
          client.callTool({ name: 'grok', arguments: { prompt: 'go' } }, undefined, {
            onprogress: () => {
              /* still request progress so the handler takes the streaming path */
            },
            // Three times the 400 ms gap between lines. The reset test fails only if a single gap
            // stretches past this, so the margin is deliberately wide — a 2x margin is what made an
            // earlier timing test in this repo flake.
            timeout: 1200,
            resetTimeoutOnProgress: false,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /timed out/i);
          return true;
        },
      );
    } finally {
      await close();
    }
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
      assert.match(content[0]?.text ?? '', /ok:\s+false/);
      assert.deepEqual(
        (result.structuredContent as Record<string, unknown>)['permissionCeiling'],
        'full',
      );
    } finally {
      await close();
    }
  });
});

describe('status over stdio', () => {
  it('calls status with no arguments against an empty state dir and succeeds', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-status-empty-'));
    const { client, close } = await connect({ GROK_MCP_STATE_DIR: stateDir });
    try {
      const result = await client.callTool({ name: 'status', arguments: {} });
      assert.notEqual(result.isError, true);
      const content = result.content as { text: string }[];
      assert.match(content[0]?.text ?? '', /No background runs recorded/);
      assert.match(
        content[0]?.text ?? '',
        new RegExp(stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      await close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
