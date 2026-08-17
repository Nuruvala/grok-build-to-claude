import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { InvalidArgumentsError } from '../../src/errors.js';
import { websearchTool } from '../../src/tools/handlers/websearch.js';
import { invokeTool } from '../../src/tools/registry.js';
import type { ProgressUpdate, ToolContext, ToolResult } from '../../src/types.js';

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));

const REPORTED_SESSION = '7c3e91a2-4b18-6fa0-9d21-e8bb0c4d2a71';

const WEBSEARCH_DENY_RULES = ['Bash(*)', 'Edit(*)', 'Write(*)'] as const;

const SOURCE_A = 'https://nodejs.org/en/about/previous-releases';
const SOURCE_B = 'https://nodejs.org/en';
const SOURCE_C = 'https://github.com/nodejs/node/releases';

const tmpDirs: string[] = [];
const trackedPids = new Set<number>();

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-websearch-'));
  tmpDirs.push(dir);
  return dir;
}

function trackPid(pid: number | null | undefined): void {
  if (typeof pid === 'number' && pid > 0) trackedPids.add(pid);
}

function killPid(pid: number): void {
  if (pid === process.pid || pid === process.ppid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* group may not exist */
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

afterEach(async () => {
  for (const pid of trackedPids) {
    killPid(pid);
  }
  trackedPids.clear();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function installFake(script: Record<string, string> = {}): Promise<{
  binary: string;
  argvFile: string;
}> {
  const dir = await makeTmp();
  const argvFile = path.join(dir, 'argv.json');
  const binary = path.join(dir, 'grok');
  const env = { FAKE_GROK_ARGV_FILE: argvFile, ...script };
  const assignments = Object.entries(env)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join('\n');
  const source = `#!/usr/bin/env node
${assignments}
await import(${JSON.stringify(pathToFileURL(FAKE_GROK).href)});
`;
  await writeFile(binary, source, { encoding: 'utf8' });
  await chmod(binary, 0o755);
  return { binary, argvFile };
}

function isolatedConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    HOME: '/tmp/grok-mcp-test-home',
    GROK_MCP_TIMEOUT_MS: '2000',
    ...overrides,
  });
}

interface CtxExtras {
  readonly progressRequested?: boolean;
  readonly reportProgress?: (update: ProgressUpdate) => void;
}

function ctxFor(
  binary: string,
  overrides: Record<string, string> = {},
  extras: CtxExtras = {},
): ToolContext {
  return {
    config: isolatedConfig({ GROK_BINARY: binary, ...overrides }),
    signal: new AbortController().signal,
    reportProgress:
      extras.reportProgress ??
      (() => {
        /* unused */
      }),
    progressRequested: extras.progressRequested ?? false,
  };
}

async function writeStream(lines: readonly string[]): Promise<string> {
  const dir = await makeTmp();
  const file = path.join(dir, 'stream.ndjson');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

function endEvent(stopReason: string, extras: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'end',
    stopReason,
    sessionId: REPORTED_SESSION,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    num_turns: extras['num_turns'] ?? 2,
    total_cost_usd: 0.001,
    ...extras,
  });
}

function webCall(id: string): string {
  return JSON.stringify({
    type: 'tool_call',
    toolCallId: id,
    title: 'Web search:',
    kind: 'search',
    status: 'in_progress',
    toolName: 'Web search:',
    rawInput: { variant: 'WebSearch', backend: true },
    content: [],
    locations: [],
  });
}

function webSearch(id: string, query: string, sources: readonly string[]): string {
  return JSON.stringify({
    type: 'tool_call_update',
    toolCallId: id,
    status: 'completed',
    content: [],
    rawOutput: {
      action: {
        type: 'search',
        query,
        sources: sources.map((url) => ({ type: 'url', url })),
      },
      id,
      status: 'completed',
    },
    locations: [],
  });
}

function xCall(id: string): string {
  return JSON.stringify({
    type: 'tool_call',
    toolCallId: id,
    title: 'X search:',
    kind: 'search',
    status: 'in_progress',
    toolName: 'X search:',
    rawInput: { variant: 'XSearch' },
    content: [],
    locations: [],
  });
}

function xUpdate(id: string, query: string): string {
  return JSON.stringify({
    type: 'tool_call_update',
    toolCallId: id,
    status: 'completed',
    content: [],
    rawOutput: {
      call_id: id,
      input: JSON.stringify({ query, limit: '10', mode: 'Latest' }),
      name: 'x_keyword_search',
      id,
    },
    locations: [],
  });
}

async function runWebsearch(
  input: Record<string, unknown>,
  script: Record<string, string> = {},
  env: Record<string, string> = {},
  extras: CtxExtras = {},
): Promise<{ result: ToolResult; argvFile: string }> {
  const streamFile =
    script['FAKE_GROK_STREAM_FILE'] === undefined
      ? await writeStream([
          webCall('ws-default'),
          webSearch('ws-default', 'latest Node.js LTS', [SOURCE_A]),
          '{"type":"text","data":"Node.js 22 is current LTS."}',
          endEvent('end_turn'),
        ])
      : undefined;
  const { binary, argvFile } = await installFake({
    FAKE_GROK_STDOUT: '',
    ...(streamFile === undefined ? {} : { FAKE_GROK_STREAM_FILE: streamFile }),
    ...script,
  });
  const result = await websearchTool.handler(input, ctxFor(binary, env, extras));
  return { result, argvFile };
}

async function readArgv(argvFile: string): Promise<unknown> {
  return JSON.parse(await readFile(argvFile, 'utf8')) as unknown;
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

function recordedArgv(argv: unknown): string[] {
  assert.ok(Array.isArray(argv));
  const entries: unknown[] = argv;
  assert.ok(entries.every((entry): entry is string => typeof entry === 'string'));
  return entries;
}

function flagValue(argv: unknown, flag: string): string | undefined {
  const recorded = recordedArgv(argv);
  const at = recorded.indexOf(flag);
  if (at < 0) return undefined;
  return recorded[at + 1];
}

function denyRules(argv: unknown): string[] {
  const recorded = recordedArgv(argv);
  const rules: string[] = [];
  for (let i = 0; i < recorded.length; i += 1) {
    if (recorded[i] !== '--deny') continue;
    const rule = recorded[i + 1];
    assert.ok(typeof rule === 'string');
    rules.push(rule);
  }
  return rules;
}

function lastOutputFormat(argv: unknown): string | undefined {
  const recorded = recordedArgv(argv);
  let format: string | undefined;
  for (let i = 0; i < recorded.length; i += 1) {
    if (recorded[i] !== '--output-format') continue;
    format = recorded[i + 1];
  }
  return format;
}

describe('websearch argv', () => {
  it('passes --output-format streaming-json even when the client did not ask for progress', async () => {
    const { result, argvFile } = await runWebsearch(
      { query: 'latest Node.js LTS' },
      {},
      {},
      { progressRequested: false },
    );
    assert.notEqual(result.isError, true);
    assert.equal(lastOutputFormat(await readArgv(argvFile)), 'streaming-json');
  });

  it('emits plan + read-only + the three deny rules, and never --always-approve', async () => {
    const { result, argvFile } = await runWebsearch(
      { query: 'latest Node.js LTS' },
      {},
      {
        GROK_MCP_PERMISSION_CEILING: 'full',
        GROK_MCP_DEFAULT_PERMISSION: 'full',
      },
    );
    assert.notEqual(result.isError, true);
    const argv = recordedArgv(await readArgv(argvFile));
    assert.equal(flagValue(argv, '--permission-mode'), 'plan');
    assert.equal(flagValue(argv, '--sandbox'), 'read-only');
    assert.deepEqual(denyRules(argv), [...WEBSEARCH_DENY_RULES]);
    assert.ok(!argv.includes('--always-approve'));
    assert.equal(metaOf(result)['permissionLevel'], 'read-only');
  });

  it('never passes --disable-web-search, at any input combination', async () => {
    const cases: readonly Record<string, unknown>[] = [
      { query: 'latest Node.js LTS' },
      { query: 'latest Node.js LTS', numResults: 8, searchDepth: 'full' },
      { query: 'latest Node.js LTS', instructions: 'Prefer nodejs.org.', maxTurns: 4 },
      { query: 'latest Node.js LTS', cwd: '/tmp', model: 'grok-4.5', effort: 'low' },
    ];
    for (const input of cases) {
      const { argvFile } = await runWebsearch(input);
      const argv = recordedArgv(await readArgv(argvFile));
      assert.ok(
        !argv.includes('--disable-web-search'),
        `--disable-web-search leaked for ${JSON.stringify(input)}`,
      );
    }
  });

  it('emits config defaults for --model and --effort, and the caller overrides win', async () => {
    const defaults = await runWebsearch({ query: 'latest Node.js LTS' });
    const defaultArgv = recordedArgv(await readArgv(defaults.argvFile));
    assert.equal(flagValue(defaultArgv, '--model'), 'grok-4.6');
    assert.equal(flagValue(defaultArgv, '--effort'), 'high');

    const overridden = await runWebsearch({
      query: 'latest Node.js LTS',
      model: 'grok-4.5',
      effort: 'low',
    });
    const overrideArgv = recordedArgv(await readArgv(overridden.argvFile));
    assert.equal(flagValue(overrideArgv, '--model'), 'grok-4.5');
    assert.equal(flagValue(overrideArgv, '--effort'), 'low');
  });
});

describe('websearch results from a scripted stream', () => {
  it('yields the expected _meta and the [2 web searches, N sources] line for two searches', async () => {
    const streamFile = await writeStream([
      webCall('ws-1'),
      webSearch('ws-1', 'latest Node.js LTS', [SOURCE_A, SOURCE_B]),
      webCall('ws-2'),
      webSearch('ws-2', 'Node.js current release', [SOURCE_B, SOURCE_C]),
      '{"type":"text","data":"Node.js 22 is the current LTS."}',
      endEvent('end_turn'),
    ]);

    const { result } = await runWebsearch(
      { query: 'latest Node.js LTS', numResults: 5 },
      { FAKE_GROK_STREAM_FILE: streamFile },
    );

    assert.equal(result.isError, false);
    const meta = metaOf(result);
    assert.equal(meta['webToolCalls'], 2);
    assert.equal(meta['webSearches'], 2);
    assert.deepEqual(meta['searchQueries'], ['latest Node.js LTS', 'Node.js current release']);
    assert.deepEqual(meta['sources'], [SOURCE_A, SOURCE_B, SOURCE_C]);
    assert.equal(meta['sourceCount'], 3);
    assert.deepEqual(meta['pagesOpened'], []);
    assert.equal(meta['searchPerformed'], true);
    assert.equal(meta['searchIncomplete'], undefined);
    assert.equal(meta['depth'], 'basic');
    assert.equal(meta['numResults'], 5);
    assert.equal(meta['xSearches'], undefined);
    assert.equal(meta['xQueries'], undefined);
    assert.equal(meta['sourcesTruncated'], undefined);
    assert.equal(meta['unknownSearchActions'], undefined);
    assert.match(textOf(result), /Node\.js 22 is the current LTS\./);
    assert.match(textOf(result), /\[2 web searches, 3 sources\]/);
  });

  it('yields isError true and the "No search ran" lead when the stream has no search events', async () => {
    const streamFile = await writeStream([
      '{"type":"text","data":"I already know this."}',
      endEvent('end_turn', { num_turns: 1 }),
    ]);

    const { result } = await runWebsearch(
      { query: 'latest Node.js LTS' },
      { FAKE_GROK_STREAM_FILE: streamFile },
    );

    assert.equal(result.isError, true);
    assert.equal(metaOf(result)['searchPerformed'], false);
    assert.equal(metaOf(result)['webToolCalls'], 0);
    assert.equal(metaOf(result)['webSearches'], 0);
    assert.equal(metaOf(result)['xSearches'], undefined);
    const body = textOf(result);
    assert.ok(
      body.startsWith(
        "No search ran. The answer below is the model's own prior knowledge, not current sources.",
      ),
    );
    assert.match(body, /I already know this\./);
  });

  it('yields isError false and the X lead line when only X events ran', async () => {
    const streamFile = await writeStream([
      xCall('xs-1'),
      xUpdate('xs-1', 'Node.js LTS'),
      xCall('xs-2'),
      xUpdate('xs-2', 'Node.js current'),
      '{"type":"text","data":"According to recent posts, Node 22."}',
      endEvent('end_turn'),
    ]);

    const { result } = await runWebsearch(
      { query: 'latest Node.js LTS' },
      { FAKE_GROK_STREAM_FILE: streamFile },
    );

    assert.equal(result.isError, false);
    assert.equal(metaOf(result)['searchPerformed'], false);
    assert.equal(metaOf(result)['xSearches'], 2);
    assert.deepEqual(metaOf(result)['xQueries'], ['Node.js LTS', 'Node.js current']);
    assert.ok(
      textOf(result).startsWith(
        'No web search returned results; this answer comes from 2 X searches, not from web pages.',
      ),
    );
    assert.match(textOf(result), /According to recent posts/);
  });

  it('yields the cut-off lead and isError true when the stream ends cancelled', async () => {
    const streamFile = await writeStream([
      webCall('ws-1'),
      webSearch('ws-1', 'latest Node.js LTS', [SOURCE_A]),
      '{"type":"text","data":"Still looking…"}',
      endEvent('cancelled', { num_turns: 3 }),
    ]);

    const { result } = await runWebsearch(
      { query: 'latest Node.js LTS' },
      { FAKE_GROK_STREAM_FILE: streamFile },
    );

    assert.equal(result.isError, true);
    const body = textOf(result);
    const split = body.indexOf('\n\n');
    assert.ok(split !== -1, 'the diagnosis must precede the raw text');
    const lead = body.slice(0, split);
    assert.match(lead, /stopReason "cancelled"/);
    assert.match(lead, /after 3 turns/);
    assert.match(lead, /turn budget was not the cause/);
    assert.doesNotMatch(lead, /Raise maxTurns/);
    assert.match(body, /Still looking/);
    const incomplete = metaOf(result)['searchIncomplete'];
    assert.ok(typeof incomplete === 'string');
    assert.equal(incomplete, lead);
  });

  it('advises raising maxTurns when a cut-off search actually received a cap', async () => {
    const streamFile = await writeStream([
      '{"type":"text","data":"Still looking…"}',
      endEvent('cancelled', { num_turns: 4 }),
    ]);

    const { result } = await runWebsearch(
      { query: 'latest Node.js LTS', maxTurns: 4 },
      { FAKE_GROK_STREAM_FILE: streamFile },
    );

    assert.equal(result.isError, true);
    const body = textOf(result);
    assert.match(body, /stopReason "cancelled"/);
    assert.match(body, /maxTurns 4/);
    assert.match(body, /Raise maxTurns above 4/);
    assert.doesNotMatch(body, /turn budget was not the cause/);
  });

  it('does not claim a search performed when a tool_call has no matching update', async () => {
    const streamFile = await writeStream([
      webCall('ws-orphan'),
      '{"type":"text","data":"I already know this."}',
      endEvent('end_turn', { num_turns: 1 }),
    ]);

    const { result } = await runWebsearch(
      { query: 'latest Node.js LTS' },
      { FAKE_GROK_STREAM_FILE: streamFile },
    );

    assert.equal(result.isError, true);
    const meta = metaOf(result);
    assert.equal(meta['webToolCalls'], 1);
    assert.equal(meta['webSearches'], 0);
    assert.equal(meta['searchPerformed'], false);
    const body = textOf(result);
    assert.ok(
      body.startsWith(
        "1 web tool call returned no sources. The answer below is the model's own prior knowledge, not current sources.",
      ),
    );
  });

  it('does not claim a search performed when a completed search returned no URLs', async () => {
    const streamFile = await writeStream([
      webCall('ws-empty'),
      webSearch('ws-empty', 'latest Node.js LTS', []),
      '{"type":"text","data":"I already know this."}',
      endEvent('end_turn', { num_turns: 1 }),
    ]);

    const { result } = await runWebsearch(
      { query: 'latest Node.js LTS' },
      { FAKE_GROK_STREAM_FILE: streamFile },
    );

    assert.equal(result.isError, true);
    const meta = metaOf(result);
    assert.equal(meta['webToolCalls'], 1);
    assert.equal(meta['webSearches'], 1);
    assert.equal(meta['searchPerformed'], false);
    const body = textOf(result);
    assert.ok(
      body.startsWith(
        "1 web tool call returned no sources. The answer below is the model's own prior knowledge, not current sources.",
      ),
    );
  });

  it('keeps harvested searches on a stream that never reached end, and does not call that output invalid JSON', async () => {
    const streamFile = await writeStream([
      webCall('ws-1'),
      webSearch('ws-1', 'latest Node.js LTS', [SOURCE_A, SOURCE_B]),
      webCall('ws-2'),
      webSearch('ws-2', 'Node.js current release', [SOURCE_C]),
    ]);

    const { result } = await runWebsearch(
      { query: 'latest Node.js LTS' },
      { FAKE_GROK_STREAM_FILE: streamFile },
    );

    assert.equal(result.isError, true);
    const meta = metaOf(result);
    assert.equal(meta['webToolCalls'], 2);
    assert.equal(meta['webSearches'], 2);
    assert.deepEqual(meta['searchQueries'], ['latest Node.js LTS', 'Node.js current release']);
    assert.deepEqual(meta['sources'], [SOURCE_A, SOURCE_B, SOURCE_C]);
    assert.equal(meta['sessionId'], undefined);
    assert.equal(meta['resumeCommand'], undefined);
    const body = textOf(result);
    assert.doesNotMatch(body, /not valid JSON/);
    assert.match(body, /stream ended before its end event/);
  });
});

describe('websearch background', () => {
  it('returns a runId without spawning grok', async () => {
    const stateDir = await makeTmp();
    // A path that cannot be exec'd: the handler must return a runId from
    // startBackgroundRun itself, not from a grok child this process spawned.
    const result = await websearchTool.handler(
      { query: 'latest Node.js LTS', background: true },
      ctxFor('/no/such-grok-binary-websearch-bg', { GROK_MCP_STATE_DIR: stateDir }),
    );

    assert.notEqual(result.isError, true);
    const meta = metaOf(result);
    assert.equal(typeof meta['runId'], 'string');
    assert.equal(meta['tool'], 'websearch');
    assert.match(String(meta['summary']), /latest Node\.js LTS/);
    trackPid(typeof meta['workerPid'] === 'number' ? meta['workerPid'] : null);
  });
});

describe('websearch schema validation', () => {
  it('rejects an empty query and an empty cwd before any spawn', async () => {
    await assert.rejects(
      () => invokeTool('websearch', { query: '' }, ctxFor('/no/such-grok-binary-websearch')),
      (error: unknown) => {
        assert.ok(error instanceof InvalidArgumentsError);
        assert.match(error.message, /query/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        invokeTool('websearch', { query: 'ok', cwd: '' }, ctxFor('/no/such-grok-binary-websearch')),
      (error: unknown) => {
        assert.ok(error instanceof InvalidArgumentsError);
        assert.match(error.message, /cwd/);
        return true;
      },
    );
  });
});
