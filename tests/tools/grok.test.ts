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
import type { ToolContext, ToolResult } from '../../src/types.js';

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));

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

function ctxFor(
  binary: string,
  overrides: Record<string, string> = {},
  signal?: AbortSignal,
): ToolContext {
  return {
    config: isolatedConfig({ GROK_BINARY: binary, ...overrides }),
    signal: signal ?? new AbortController().signal,
    reportProgress: () => {
      /* protocol tests cover progress separately */
    },
  };
}

async function runGrok(
  input: Record<string, unknown>,
  script: Record<string, string> = {},
  env: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<{ result: ToolResult; argvFile: string }> {
  const { binary, argvFile } = await installFake({
    FAKE_GROK_STDOUT: SUCCESS_JSON,
    ...script,
  });
  const result = await grokTool.handler(input, ctxFor(binary, env, signal));
  return { result, argvFile };
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
      disallowedTools: ['run_terminal_cmd'],
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
