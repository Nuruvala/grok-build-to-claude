import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { InvalidArgumentsError, PermissionDeniedError } from '../../src/errors.js';
import { buildGrokArgs } from '../../src/grok/args.js';
import { permissionFlags } from '../../src/permission.js';
import { grokTool } from '../../src/tools/handlers/grok.js';
import { helpTool } from '../../src/tools/handlers/help.js';
import { invokeTool } from '../../src/tools/registry.js';
import type { ProgressUpdate, ToolContext, ToolResult } from '../../src/types.js';

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

const REPORTED_SESSION = '7c3e91a2-4b18-6fa0-9d21-e8bb0c4d2a71';
const PASSED_SESSION = '11111111-2222-3333-4444-555555555555';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-tool-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
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
  signal?: AbortSignal,
  extras: CtxExtras = {},
): ToolContext {
  return {
    config: isolatedConfig({ GROK_BINARY: binary, ...overrides }),
    signal: signal ?? new AbortController().signal,
    reportProgress:
      extras.reportProgress ??
      (() => {
        /* protocol tests cover progress separately */
      }),
    progressRequested: extras.progressRequested ?? false,
  };
}

async function runGrok(
  input: Record<string, unknown>,
  script: Record<string, string> = {},
  env: Record<string, string> = {},
  signal?: AbortSignal,
  extras: CtxExtras = {},
): Promise<{ result: ToolResult; argvFile: string }> {
  const { binary, argvFile } = await installFake({
    FAKE_GROK_STDOUT: SUCCESS_JSON,
    ...script,
  });
  const result = await grokTool.handler(input, ctxFor(binary, env, signal, extras));
  return { result, argvFile };
}

async function runStreaming(
  streamFile: string,
  script: Record<string, string> = {},
  extras: CtxExtras = {},
): Promise<{ result: ToolResult; argvFile: string; emissions: ProgressUpdate[] }> {
  const emissions: ProgressUpdate[] = [];
  const { result, argvFile } = await runGrok(
    { prompt: 'hi' },
    {
      FAKE_GROK_STDOUT: '',
      FAKE_GROK_STREAM_FILE: streamFile,
      ...script,
    },
    {},
    undefined,
    {
      progressRequested: true,
      reportProgress: (update) => {
        emissions.push(update);
      },
      ...extras,
    },
  );
  return { result, argvFile, emissions };
}

function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
}

async function readArgv(argvFile: string): Promise<unknown> {
  return JSON.parse(await readFile(argvFile, 'utf8')) as unknown;
}

async function argvExists(argvFile: string): Promise<boolean> {
  try {
    await access(argvFile);
    return true;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
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

describe('grok session conflicts are rejected before spawn', () => {
  const cases: readonly { name: string; input: Record<string, unknown> }[] = [
    {
      name: 'resume and continueSession',
      input: { prompt: 'go', resume: 'sess-1', continueSession: true },
    },
    {
      name: 'sessionId and resume',
      input: { prompt: 'go', sessionId: PASSED_SESSION, resume: 'sess-1' },
    },
    {
      name: 'sessionId and continueSession',
      input: { prompt: 'go', sessionId: PASSED_SESSION, continueSession: true },
    },
    {
      name: 'sessionId, resume, and continueSession',
      input: {
        prompt: 'go',
        sessionId: PASSED_SESSION,
        resume: 'sess-1',
        continueSession: true,
      },
    },
    {
      name: 'forkSession without resume or continueSession',
      input: { prompt: 'go', forkSession: 'fork-9' },
    },
    {
      name: 'sessionId and forkSession',
      input: { prompt: 'go', sessionId: PASSED_SESSION, forkSession: 'fork-9' },
    },
  ];

  for (const { name, input } of cases) {
    it(`rejects ${name} before any spawn, so the fixture argv file is never created`, async () => {
      const { binary, argvFile } = await installFake({ FAKE_GROK_STDOUT: SUCCESS_JSON });

      await assert.rejects(
        () => grokTool.handler(input, ctxFor(binary)),
        (error: unknown) => {
          assert.ok(error instanceof InvalidArgumentsError);
          assert.match(error.message, /Invalid arguments for "grok"/);
          return true;
        },
      );

      assert.equal(await argvExists(argvFile), false);
    });
  }
});

describe('grok argv', () => {
  it('hands the child the same argv that buildGrokArgs produces for the same input', async () => {
    const input = {
      prompt: 'do the thing',
      cwd: '/tmp/work',
      model: 'grok-4.6',
      effort: 'high',
      maxTurns: 4,
      tools: ['read', 'search'],
      disallowedTools: ['run_terminal_command'],
      allow: ['Read(src/**)', 'Write(src/**)'],
      deny: ['Bash(rm*)'],
      rules: 'be careful',
      agent: 'reviewer',
      resume: 'sess-1',
      forkSession: 'fork-9',
      disableWebSearch: true,
    };

    const { result, argvFile } = await runGrok(input);

    assert.notEqual(result.isError, true);
    const recorded = await readArgv(argvFile);
    const expected = buildGrokArgs({
      prompt: input.prompt,
      outputFormat: 'json',
      permission: permissionFlags('read-only'),
      cwd: input.cwd,
      model: input.model,
      effort: input.effort,
      maxTurns: input.maxTurns,
      tools: input.tools,
      disallowedTools: input.disallowedTools,
      allow: input.allow,
      deny: input.deny,
      rules: input.rules,
      agent: input.agent,
      session: { kind: 'resume', id: input.resume, forkId: input.forkSession },
      disableWebSearch: true,
    });
    assert.deepEqual(recorded, [...expected]);
  });

  it('emits --always-approve on a bare call when ceiling and default are both full, which is the unattended path', async () => {
    const { result, argvFile } = await runGrok(
      { prompt: 'unattended' },
      {},
      {
        GROK_MCP_PERMISSION_CEILING: 'full',
        GROK_MCP_DEFAULT_PERMISSION: 'full',
      },
    );

    assert.notEqual(result.isError, true);
    const recorded = await readArgv(argvFile);
    assert.ok(Array.isArray(recorded));
    assert.ok(recorded.includes('--always-approve'));
    assert.equal(metaOf(result)['permissionLevel'], 'full');
  });
});

describe('grok result metadata', () => {
  it("puts the CLI's sessionId on _meta, not a locally generated stand-in", async () => {
    const { result } = await runGrok({ prompt: 'hi', sessionId: PASSED_SESSION });

    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), 'hello from grok');
    assert.equal(metaOf(result)['sessionId'], REPORTED_SESSION);
    assert.notEqual(metaOf(result)['sessionId'], PASSED_SESSION);
    assert.equal(metaOf(result)['resumeCommand'], `grok -r ${REPORTED_SESSION}`);
  });

  it('reports sessionId as null when the CLI omitted one, rather than substituting the --session-id we passed', async () => {
    const { result } = await runGrok(
      { prompt: 'hi', sessionId: PASSED_SESSION },
      {
        FAKE_GROK_STDOUT: JSON.stringify({ text: 'ok', stopReason: 'end_turn' }),
      },
    );

    assert.notEqual(result.isError, true);
    assert.equal(metaOf(result)['sessionId'], null);
    assert.equal(metaOf(result)['resumeCommand'], undefined);
  });

  it('omits resumeCommand when the CLI reported an empty session id, so we do not imply a session that does not exist', async () => {
    const { result } = await runGrok(
      { prompt: 'hi' },
      {
        FAKE_GROK_STDOUT: JSON.stringify({ text: 'ok', stopReason: 'end_turn', sessionId: '' }),
      },
    );

    assert.notEqual(result.isError, true);
    assert.equal(metaOf(result)['sessionId'], '');
    assert.equal(metaOf(result)['resumeCommand'], undefined);
  });

  it('puts the model id we passed on _meta, not the modelUsage key the CLI reports', async () => {
    const { result } = await runGrok(
      { prompt: 'hi', model: 'grok-4.6' },
      {
        FAKE_GROK_STDOUT: JSON.stringify({
          text: 'ok',
          sessionId: REPORTED_SESSION,
          modelUsage: { 'grok-4.6-build': { input_tokens: 1 } },
        }),
      },
    );

    assert.equal(metaOf(result)['model'], 'grok-4.6');
    assert.notEqual(metaOf(result)['model'], 'grok-4.6-build');
  });

  it('omits structuredContent by default, because some clients mishandle it', async () => {
    const { result } = await runGrok({ prompt: 'hi' });

    assert.equal(result.structuredContent, undefined);
    assert.equal(metaOf(result)['total_cost_usd'], 0.001);
    assert.equal(metaOf(result)['stopReason'], 'end_turn');
    assert.equal(metaOf(result)['numTurns'], 1);
  });

  it('includes structuredContent when the config enables it, matching the _meta object', async () => {
    const { result } = await runGrok({ prompt: 'hi' }, {}, { STRUCTURED_CONTENT_ENABLED: '1' });

    assert.deepEqual(result.structuredContent, metaOf(result));
  });
});

describe('grok error paths preserve buffered output', () => {
  it('names --allow on E2BIG instead of telling the caller to install the CLI', async () => {
    const { result } = await runGrok({ prompt: 'hi', allow: ['B'.repeat(200_000)] });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /--allow/);
    assert.match(textOf(result), /too long for the operating system/);
    assert.match(textOf(result), /128 KiB on Linux/);
    assert.doesNotMatch(textOf(result), /Install the grok CLI/);
    assert.equal(metaOf(result)['outcome'], 'spawn-failed');
    assert.equal(metaOf(result)['sessionId'], undefined);
  });

  it('returns isError on spawn-failed and names GROK_BINARY, without inventing a session', async () => {
    const result = await grokTool.handler(
      { prompt: 'hi' },
      ctxFor('/no/such/grok-binary-7c3e91a2'),
    );

    assert.equal(result.isError, true);
    assert.match(textOf(result), /\/no\/such\/grok-binary-7c3e91a2/);
    assert.match(textOf(result), /GROK_BINARY/);
  });

  it('returns isError on timeout, names GROK_MCP_TIMEOUT_MS, and includes the partial output', async () => {
    const { result } = await runGrok(
      { prompt: 'hi' },
      { FAKE_GROK_STDOUT: 'so far', FAKE_GROK_SLEEP_MS: '10000' },
      { GROK_MCP_TIMEOUT_MS: '150' },
    );

    assert.equal(result.isError, true);
    assert.match(textOf(result), /timed out/);
    assert.match(textOf(result), /GROK_MCP_TIMEOUT_MS/);
    assert.match(textOf(result), /so far/);
  });

  it('returns isError on abort and says the client cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, argvFile } = await runGrok({ prompt: 'hi' }, {}, {}, controller.signal);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /cancelled/);
    assert.equal(await argvExists(argvFile), false);
  });

  it('returns isError on a non-zero exit and includes both stdout and stderr', async () => {
    const { result } = await runGrok(
      { prompt: 'hi' },
      {
        FAKE_GROK_STDOUT: 'partial-out',
        FAKE_GROK_STDERR: 'partial-err',
        FAKE_GROK_EXIT_CODE: '1',
      },
    );

    assert.equal(result.isError, true);
    assert.match(textOf(result), /exited with code 1/);
    assert.match(textOf(result), /partial-out/);
    assert.match(textOf(result), /partial-err/);
  });

  it('surfaces the CLI message for {"type":"error"} and does not parse a result out of it', async () => {
    const { result } = await runGrok(
      { prompt: 'hi' },
      {
        FAKE_GROK_STDOUT: JSON.stringify({
          type: 'error',
          message: 'model not found',
          text: 'ignore me',
          sessionId: 'should-not-surface',
        }),
        FAKE_GROK_EXIT_CODE: '1',
      },
    );

    assert.equal(result.isError, true);
    assert.match(textOf(result), /grok reported an error: model not found/);
    assert.notEqual(result.isError, false);
    assert.equal(result.content[0]?._meta?.['sessionId'], undefined);
  });

  it('returns isError for unparseable stdout and includes a truncated preview of the raw output', async () => {
    const blob = `this is not json ${'x'.repeat(5000)}`;
    const { result } = await runGrok({ prompt: 'hi' }, { FAKE_GROK_STDOUT: blob });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not valid JSON/);
    assert.match(textOf(result), /this is not json/);
    assert.match(textOf(result), /\[truncated\]/);
    assert.ok(textOf(result).length < blob.length);
  });
});

describe('grok permission ceiling', () => {
  it('rejects an over-ceiling background request synchronously, so a doomed run never gets a runId', async () => {
    const { binary, argvFile } = await installFake();
    await assert.rejects(
      () =>
        grokTool.handler({ prompt: 'hi', permission: 'full', background: true }, ctxFor(binary)),
      (error: unknown) => {
        assert.ok(error instanceof PermissionDeniedError);
        assert.match(error.message, /full/);
        assert.match(error.remedy ?? '', /GROK_MCP_PERMISSION_CEILING/);
        return true;
      },
    );
    assert.equal(await argvExists(argvFile), false);
  });

  it('rejects an over-ceiling request with a message naming GROK_MCP_PERMISSION_CEILING, and does not spawn', async () => {
    const { binary, argvFile } = await installFake({ FAKE_GROK_STDOUT: SUCCESS_JSON });

    await assert.rejects(
      () => grokTool.handler({ prompt: 'hi', permission: 'full' }, ctxFor(binary)),
      (error: unknown) => {
        assert.ok(error instanceof PermissionDeniedError);
        assert.match(error.message, /full/);
        assert.match(error.remedy ?? '', /GROK_MCP_PERMISSION_CEILING/);
        return true;
      },
    );

    assert.equal(await argvExists(argvFile), false);
  });
});

describe('help', () => {
  it('returns grok --help stdout as the text body', async () => {
    const { binary, argvFile } = await installFake({
      FAKE_GROK_STDOUT: 'Usage: grok [options]\n',
    });

    const result = await helpTool.handler({}, ctxFor(binary));

    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), 'Usage: grok [options]\n');
    assert.deepEqual(await readArgv(argvFile), ['--help']);
  });

  it('returns isError with stderr when grok --help exits non-zero', async () => {
    const { binary } = await installFake({
      FAKE_GROK_STDERR: 'help broken',
      FAKE_GROK_EXIT_CODE: '1',
    });

    const result = await helpTool.handler({}, ctxFor(binary));

    assert.equal(result.isError, true);
    assert.match(textOf(result), /exited with code 1/);
    assert.match(textOf(result), /help broken/);
  });

  it('returns isError naming GROK_BINARY when the binary is missing', async () => {
    const result = await helpTool.handler({}, ctxFor('/no/such/grok-binary-7c3e91a2'));

    assert.equal(result.isError, true);
    assert.match(textOf(result), /GROK_BINARY/);
  });
});

describe('grok tool schema validation', () => {
  // These go through invokeTool rather than the handler directly, because the handler receives
  // already-validated input — the point here is that the schema itself rejects the value.
  const emptyStringCases: readonly (readonly [field: string, why: string])[] = [
    ['cwd', 'an empty cwd would silently run wherever the server lives'],
    ['resume', 'an empty resume id would silently become "resume the most recent session"'],
    ['forkSession', 'an empty fork id would silently continue in place instead of forking'],
    ['sessionId', 'an empty session id would silently create an unnamed session'],
  ];

  for (const [field, why] of emptyStringCases) {
    it(`rejects an empty ${field}, because ${why}`, async () => {
      const input: Record<string, unknown> = { prompt: 'hi', [field]: '' };
      if (field === 'forkSession') input['resume'] = 'sess-1';

      await assert.rejects(
        () => invokeTool('grok', input, ctxFor('/no/such/grok-binary-7c3e91a2')),
        (error: unknown) => {
          assert.ok(error instanceof InvalidArgumentsError);
          assert.match(error.message, new RegExp(field));
          return true;
        },
      );
    });
  }

  it('still accepts the same fields when they carry a real value', async () => {
    const { binary, argvFile } = await installFake({ FAKE_GROK_STDOUT: SUCCESS_JSON });
    const result = await invokeTool(
      'grok',
      { prompt: 'hi', cwd: '/tmp', resume: 'sess-1', forkSession: PASSED_SESSION },
      ctxFor(binary),
    );

    assert.notEqual(result.isError, true);
    const argv = (await readArgv(argvFile)) as string[];
    assert.ok(argv.includes('--cwd'));
    assert.ok(argv.includes('--fork-session'));
  });
});

describe('grok output format follows whether the client asked for progress', () => {
  it('passes --output-format json when progressRequested is false, so a silent client does not pay for a stream', async () => {
    const { result, argvFile } = await runGrok({ prompt: 'hi' });

    assert.notEqual(result.isError, true);
    const argv = (await readArgv(argvFile)) as string[];
    const formatAt = argv.indexOf('--output-format');
    assert.ok(formatAt >= 0);
    assert.equal(argv[formatAt + 1], 'json');
  });

  it('passes --output-format streaming-json when progressRequested is true', async () => {
    const { result, argvFile } = await runStreaming(fixturePath('stream-happy.ndjson'));

    assert.notEqual(result.isError, true);
    const argv = (await readArgv(argvFile)) as string[];
    const formatAt = argv.indexOf('--output-format');
    assert.ok(formatAt >= 0);
    assert.equal(argv[formatAt + 1], 'streaming-json');
  });
});

describe('grok metadata identity across output formats', () => {
  it('builds the same _meta from a json object and a streaming transcript of the same values', async () => {
    const shared = {
      text: 'Here you go',
      stopReason: 'end_turn',
      sessionId: '00000000-0000-7000-8000-000000000001',
      requestId: '00000000-0000-4000-8000-000000000002',
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 10,
        reasoning_tokens: 5,
        total_tokens: 115,
      },
      num_turns: 1,
      total_cost_usd: 0.001,
      modelUsage: { 'fake-model-build': { costUSD: 0.001 } },
    };

    const jsonStdout = JSON.stringify(shared);
    const streamDir = await makeTmp();
    const streamFile = path.join(streamDir, 'identity.ndjson');
    const { text: _text, ...endFields } = shared;
    await writeFile(
      streamFile,
      [
        '{"type":"text","data":"Here"}',
        '{"type":"text","data":" you go"}',
        JSON.stringify({ type: 'end', ...endFields }),
        '',
      ].join('\n'),
    );

    const jsonRun = await runGrok({ prompt: 'hi' }, { FAKE_GROK_STDOUT: jsonStdout });
    const streamRun = await runStreaming(streamFile);

    assert.notEqual(jsonRun.result.isError, true);
    assert.notEqual(streamRun.result.isError, true);
    assert.equal(textOf(jsonRun.result), shared.text);
    assert.equal(textOf(streamRun.result), shared.text);

    const jsonMeta = { ...metaOf(jsonRun.result) };
    const streamMeta = { ...metaOf(streamRun.result) };
    delete jsonMeta['durationMs'];
    delete streamMeta['durationMs'];
    assert.deepEqual(streamMeta, jsonMeta);
  });
});

describe('grok streaming progress tracks work, not lifecycle', () => {
  it('emits at least 12 distinct strictly-increasing progress lines for a 12-tool transcript', async () => {
    const { result, emissions } = await runStreaming(fixturePath('stream-tools-12.ndjson'));

    assert.notEqual(result.isError, true);
    assert.ok(
      emissions.length >= 12,
      `expected at least 12 emissions, got ${String(emissions.length)}`,
    );
    const messages = emissions.map((emission) => emission.message);
    assert.ok(
      new Set(messages).size >= 12,
      `expected at least 12 distinct messages, got ${JSON.stringify(messages)}`,
    );
    for (let i = 1; i < emissions.length; i += 1) {
      const previous = emissions[i - 1]?.progress;
      const current = emissions[i]?.progress;
      assert.ok(previous !== undefined && current !== undefined);
      assert.ok(
        current > previous,
        `progress not strictly increasing at ${String(i)}: ${String(previous)} -> ${String(current)}`,
      );
    }
  });

  it('emits pending narration before the finishing line, because a run must not report finished ahead of its own last words', async () => {
    const { result, emissions } = await runStreaming(fixturePath('stream-narration.ndjson'));

    assert.notEqual(result.isError, true);
    const messages = emissions.map((emission) => emission.message ?? '');
    const narrationAt = messages.findIndex((message) => message.startsWith('writing:'));
    const finishedAt = messages.findIndex((message) => message.startsWith('finished:'));

    assert.ok(narrationAt >= 0, `expected a writing: line, got ${JSON.stringify(messages)}`);
    assert.ok(finishedAt >= 0, `expected a finished: line, got ${JSON.stringify(messages)}`);
    assert.ok(
      narrationAt < finishedAt,
      `narration must precede the finishing line, got ${JSON.stringify(messages)}`,
    );

    // The counter has to agree with the delivery order, or a client that sorts by `progress`
    // re-inverts what the ordering fix just corrected.
    for (let i = 1; i < emissions.length; i += 1) {
      const previous = emissions[i - 1]?.progress;
      const current = emissions[i]?.progress;
      assert.ok(previous !== undefined && current !== undefined);
      assert.ok(current > previous, `progress not strictly increasing at ${String(i)}`);
    }
  });

  it('flushes debounced narration while the run is still in flight, not only at the end', async () => {
    const { result, emissions } = await runStreaming(fixturePath('stream-narration.ndjson'), {
      FAKE_GROK_STREAM_DELAY_MS: '150',
    });

    assert.notEqual(result.isError, true);
    const messages = emissions.map((emission) => emission.message ?? '');
    assert.ok(
      messages.some((message) => message.startsWith('writing:')),
      `expected a debounced writing: line, got ${JSON.stringify(messages)}`,
    );
  });
});

describe('grok streaming outcomes', () => {
  it('does not treat an abort with no end event as a success', async () => {
    const controller = new AbortController();
    const pending = runGrok(
      { prompt: 'hi' },
      {
        FAKE_GROK_STDOUT: '{"type":"text","data":"working"}\n',
        FAKE_GROK_SLEEP_MS: '10000',
      },
      {},
      controller.signal,
      { progressRequested: true },
    );
    const abortAt = Date.now() + 80;
    while (Date.now() < abortAt) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    controller.abort();
    const { result } = await pending;

    assert.equal(result.isError, true);
    assert.match(textOf(result), /cancelled|stream ended before its end event/);
    assert.equal(result.content[0]?._meta?.['sessionId'], undefined);
    assert.equal(result.content[0]?._meta?.['stopReason'], undefined);
  });

  it('reports a truncated stream as a partial error with recovered text and no fabricated session id', async () => {
    const { result } = await runStreaming(fixturePath('stream-truncated.ndjson'));

    assert.equal(result.isError, true);
    assert.match(textOf(result), /recovered so far/);
    assert.match(textOf(result), /stream ended before its end event/);
    assert.equal(metaOf(result)['sessionId'], undefined);
    assert.equal(metaOf(result)['resumeCommand'], undefined);
  });

  it('surfaces a stream whose only content is an error event as the CLI error path', async () => {
    const { result } = await runStreaming(fixturePath('stream-error.ndjson'));

    assert.equal(result.isError, true);
    assert.match(textOf(result), /grok reported an error: model not found/);
    assert.equal(metaOf(result)['sessionId'], undefined);
  });
});

describe('grok result text marks a cut-off even when the process exits 0', () => {
  it('leaves exit 0 with stopReason end_turn unmarked, because that run finished', async () => {
    const { result } = await runGrok(
      { prompt: 'hi' },
      { FAKE_GROK_STDOUT: JSON.stringify({ text: 'done', stopReason: 'end_turn' }) },
    );

    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), 'done');
    assert.doesNotMatch(textOf(result), /stopped early/);
    assert.doesNotMatch(textOf(result), /exited with code/);
  });

  it('appends a stopped-early note on exit 0 with stopReason cancelled, because a permission-cancelled run looks finished otherwise', async () => {
    const { result } = await runGrok(
      { prompt: 'hi' },
      {
        FAKE_GROK_STDOUT: JSON.stringify({
          text: "I'll start by reading",
          stopReason: 'cancelled',
          sessionId: REPORTED_SESSION,
        }),
      },
    );

    assert.notEqual(result.isError, true);
    assert.equal(
      textOf(result),
      "I'll start by reading\n\n[the run stopped early — stopReason: cancelled]",
    );
  });

  it('keeps the existing non-zero-exit note, including when stopReason is also present', async () => {
    const { result } = await runGrok(
      { prompt: 'hi' },
      {
        FAKE_GROK_STDOUT: JSON.stringify({
          text: 'partial',
          stopReason: 'cancelled',
          sessionId: REPORTED_SESSION,
        }),
        FAKE_GROK_EXIT_CODE: '1',
      },
    );

    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), 'partial\n\n[grok exited with code 1 (stopReason: cancelled)]');
    assert.doesNotMatch(textOf(result), /stopped early/);
  });

  it('keeps a non-zero-exit note without inventing a stopReason when the CLI omitted one', async () => {
    const { result } = await runGrok(
      { prompt: 'hi' },
      {
        FAKE_GROK_STDOUT: JSON.stringify({ text: 'partial', sessionId: REPORTED_SESSION }),
        FAKE_GROK_EXIT_CODE: '1',
      },
    );

    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), 'partial\n\n[grok exited with code 1]');
  });
});

describe('grok treats a complete result as success even when the process exits 1', () => {
  const maxTurnsJson = JSON.stringify({
    text: 'I got as far as listing the files',
    stopReason: 'cancelled',
    sessionId: '00000000-0000-7000-8000-000000000003',
    requestId: '00000000-0000-4000-8000-000000000004',
    usage: { input_tokens: 50, output_tokens: 8, total_tokens: 58 },
    num_turns: 1,
    total_cost_usd: 0.002,
  });

  it('keeps the parsed text, session id, and spend on the json path when --max-turns exits 1', async () => {
    const { result } = await runGrok(
      { prompt: 'hi' },
      { FAKE_GROK_STDOUT: maxTurnsJson, FAKE_GROK_EXIT_CODE: '1' },
    );

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /I got as far as listing the files/);
    assert.match(textOf(result), /exited with code 1/);
    assert.match(textOf(result), /stopReason: cancelled/);
    assert.equal(metaOf(result)['sessionId'], '00000000-0000-7000-8000-000000000003');
    assert.equal(metaOf(result)['exitCode'], 1);
    assert.equal(metaOf(result)['stopReason'], 'cancelled');
    assert.equal(metaOf(result)['total_cost_usd'], 0.002);
  });

  it('keeps the parsed text, session id, and spend on the streaming path when max_turns_reached is followed by end and exit 1', async () => {
    const { result } = await runStreaming(fixturePath('stream-max-turns.ndjson'), {
      FAKE_GROK_EXIT_CODE: '1',
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /I got as far as listing the files/);
    assert.match(textOf(result), /exited with code 1/);
    assert.match(textOf(result), /stopReason: cancelled/);
    assert.equal(metaOf(result)['sessionId'], '00000000-0000-7000-8000-000000000003');
    assert.equal(metaOf(result)['exitCode'], 1);
    assert.equal(metaOf(result)['stopReason'], 'cancelled');
    assert.equal(metaOf(result)['total_cost_usd'], 0.002);
  });
});

describe('grok streaming debounce timer does not leak', () => {
  it('clears the narration debounce timer when the run resolves, so a stray timeout cannot keep the process alive', async () => {
    const timeoutsBefore = activeTimeouts();
    const { result } = await runStreaming(fixturePath('stream-narration.ndjson'));

    assert.notEqual(result.isError, true);
    const timeoutsAfter = activeTimeouts();
    assert.equal(
      timeoutsAfter,
      timeoutsBefore,
      `debounce timer still pending after the handler resolved (${String(timeoutsBefore)} -> ${String(timeoutsAfter)})`,
    );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
});
