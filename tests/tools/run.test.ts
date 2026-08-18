import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../../src/config.js';
import type { GrokStreamEvent } from '../../src/grok/stream.js';
import { longestArgvElement, runGrok, streamingOutput } from '../../src/tools/run.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));

const REPORTED_SESSION = '7c3e91a2-4b18-6fa0-9d21-e8bb0c4d2a71';

const SUCCESS_JSON = JSON.stringify({
  text: 'hello from grok',
  stopReason: 'end_turn',
  sessionId: REPORTED_SESSION,
  usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  num_turns: 1,
  total_cost_usd: 0.001,
});

const tmpDirs: string[] = [];

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-run-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function installFake(script: Record<string, string> = {}): Promise<string> {
  const dir = await makeTmp();
  const binary = path.join(dir, 'grok');
  const env = { ...script };
  const assignments = Object.entries(env)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join('\n');
  const source = `#!/usr/bin/env node
${assignments}
await import(${JSON.stringify(pathToFileURL(FAKE_GROK).href)});
`;
  await writeFile(binary, source, { encoding: 'utf8' });
  await chmod(binary, 0o755);
  return binary;
}

function ctxFor(binary: string, progressRequested = false): ToolContext {
  return {
    config: loadConfig({
      HOME: '/tmp/grok-mcp-test-home',
      GROK_BINARY: binary,
      GROK_MCP_TIMEOUT_MS: '2000',
    }),
    signal: new AbortController().signal,
    reportProgress: () => {
      /* unused */
    },
    progressRequested,
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

describe('longestArgvElement', () => {
  it('reports the longest element and the preceding flag when that element starts with -', () => {
    assert.deepEqual(longestArgvElement(['-p', 'hi', '--allow', 'B'.repeat(40), '--cwd', '/tmp']), {
      flag: '--allow',
      bytes: 40,
    });
  });

  it('reports flag null when the longest element has no preceding flag', () => {
    assert.deepEqual(longestArgvElement(['just-a-value']), { flag: null, bytes: 12 });
    assert.deepEqual(longestArgvElement([]), { flag: null, bytes: 0 });
  });

  it('counts multi-byte characters as bytes, not code units', () => {
    // U+00E9 is two UTF-8 bytes; ten of them are 20 bytes, not 10.
    assert.deepEqual(longestArgvElement(['--rules', 'é'.repeat(10)]), {
      flag: '--rules',
      bytes: 20,
    });
  });
});

describe('streamingOutput', () => {
  it('is false when --output-format is absent or not streaming-json', () => {
    assert.equal(streamingOutput(['-p', 'hi']), false);
    assert.equal(streamingOutput(['-p', 'hi', '--output-format', 'json']), false);
    assert.equal(streamingOutput(['-p', 'hi', '--output-format']), false);
  });

  it('picks the last --output-format, so an appended override wins', () => {
    assert.equal(streamingOutput(['--output-format', 'streaming-json']), true);
    assert.equal(
      streamingOutput(['--output-format', 'json', '--output-format', 'streaming-json']),
      true,
    );
    assert.equal(
      streamingOutput(['--output-format', 'streaming-json', '--output-format', 'json']),
      false,
    );
  });
});

describe('runGrok observer', () => {
  it('sees every parsed stream event in order when argv asks for streaming-json', async () => {
    const dir = await makeTmp();
    const streamFile = path.join(dir, 'observer.ndjson');
    await writeFile(
      streamFile,
      [
        '{"type":"text","data":"Hello"}',
        '{"type":"thought","data":"thinking"}',
        JSON.stringify({
          type: 'end',
          stopReason: 'end_turn',
          sessionId: REPORTED_SESSION,
          num_turns: 1,
          total_cost_usd: 0.001,
        }),
        '',
      ].join('\n'),
    );
    const binary = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: streamFile,
    });

    const seen: string[] = [];
    const result = await runGrok(
      {
        args: ['-p', 'hi', '--output-format', 'streaming-json'],
        model: 'grok-4.6',
        permissionLevel: 'read-only',
        observer: (event: GrokStreamEvent) => {
          seen.push(event.type);
        },
      },
      ctxFor(binary, false),
    );

    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), 'Hello');
    assert.deepEqual(seen, ['text', 'thought', 'end']);
  });

  it('does not fail the run when the observer throws', async () => {
    const dir = await makeTmp();
    const streamFile = path.join(dir, 'throwing.ndjson');
    await writeFile(
      streamFile,
      [
        '{"type":"text","data":"kept"}',
        JSON.stringify({
          type: 'end',
          stopReason: 'end_turn',
          sessionId: REPORTED_SESSION,
          num_turns: 1,
        }),
        '',
      ].join('\n'),
    );
    const binary = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: streamFile,
    });

    const result = await runGrok(
      {
        args: ['-p', 'hi', '--output-format', 'streaming-json'],
        model: 'grok-4.6',
        permissionLevel: 'read-only',
        observer: () => {
          throw new Error('observer exploded');
        },
      },
      ctxFor(binary),
    );

    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), 'kept');
  });

  it('does not call the observer on the json path, even when progressRequested is true', async () => {
    const binary = await installFake({ FAKE_GROK_STDOUT: SUCCESS_JSON });
    const seen: string[] = [];
    const result = await runGrok(
      {
        args: ['-p', 'hi', '--output-format', 'json'],
        model: 'grok-4.6',
        permissionLevel: 'read-only',
        observer: (event) => {
          seen.push(event.type);
        },
      },
      ctxFor(binary, true),
    );

    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), 'hello from grok');
    assert.deepEqual(seen, []);
  });
});

describe('runGrok non-success meta', () => {
  it('merges handler meta on a partial stream but never carries sessionId or resumeCommand, even when the handler invents them', async () => {
    const dir = await makeTmp();
    const streamFile = path.join(dir, 'partial.ndjson');
    await writeFile(
      streamFile,
      [
        '{"type":"tool_call","title":"Web search:","rawInput":{"variant":"WebSearch"}}',
        '{"type":"text","data":"still going"}',
        '',
      ].join('\n'),
    );
    const binary = await installFake({
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: streamFile,
    });

    const result = await runGrok(
      {
        args: ['-p', 'hi', '--output-format', 'streaming-json'],
        model: 'grok-4.6',
        permissionLevel: 'read-only',
        meta: () => ({
          sessionId: 'invented-session',
          resumeCommand: 'grok -r invented-session',
          harvested: true,
        }),
      },
      ctxFor(binary),
    );

    assert.equal(result.isError, true);
    const meta = metaOf(result);
    assert.equal(meta['harvested'], true);
    assert.equal(meta['sessionId'], undefined);
    assert.equal(meta['resumeCommand'], undefined);
    assert.doesNotMatch(textOf(result), /not valid JSON/);
  });

  it('strips a handler-invented sessionId from an errorResult path too, so the guard is not partial-only', async () => {
    const binary = await installFake({ FAKE_GROK_STDOUT: 'this is not json' });
    const result = await runGrok(
      {
        args: ['-p', 'hi', '--output-format', 'json'],
        model: 'grok-4.6',
        permissionLevel: 'read-only',
        meta: () => ({
          sessionId: 'invented-session',
          resumeCommand: 'grok -r invented-session',
          harvested: true,
        }),
      },
      ctxFor(binary),
    );

    assert.equal(result.isError, true);
    const meta = metaOf(result);
    assert.equal(meta['harvested'], true);
    assert.equal(meta['sessionId'], undefined);
    assert.equal(meta['resumeCommand'], undefined);
  });
});
