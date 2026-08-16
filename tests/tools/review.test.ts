import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { InvalidArgumentsError } from '../../src/errors.js';
import { REVIEW_FINDINGS_SCHEMA } from '../../src/review/prompt.js';
import { reviewTool } from '../../src/tools/handlers/review.js';
import { invokeTool } from '../../src/tools/registry.js';
import { runGrok } from '../../src/tools/run.js';
import type { ProgressUpdate, ToolContext, ToolResult } from '../../src/types.js';

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));

interface GitRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface GitRepo {
  readonly cwd: string;
  git(args: readonly string[]): Promise<GitRun>;
  write(relativePath: string, contents: string | Uint8Array): Promise<void>;
  commit(message: string): Promise<string>;
  cleanup(): Promise<void>;
}

// prettier-ignore
// @ts-expect-error -- untyped JS fixture; aliases below are the types.
import { createGitRepo as createGitRepoRaw, gitAvailable, withGitRepo as withGitRepoRaw } from '../fixtures/git-repo.mjs';

const createGitRepo = createGitRepoRaw as (options?: {
  readonly bare?: boolean;
}) => Promise<GitRepo>;
const withGitRepo = withGitRepoRaw as (fn: (repo: GitRepo) => Promise<void>) => Promise<void>;
const gitOnPath = gitAvailable as () => boolean;

const skipGit = gitOnPath()
  ? false
  : 'git is not on PATH; the review tool tests need a real git binary';

const REPORTED_SESSION = '7c3e91a2-4b18-6fa0-9d21-e8bb0c4d2a71';

const FINDINGS = {
  findings: [
    {
      severity: 'high',
      file: 'src/a.ts',
      summary: 'unchecked return',
      rationale: 'the error is dropped',
      line: 12,
    },
  ],
  verdict: 'needs work',
} as const;

const SUCCESS_JSON = JSON.stringify({
  text: 'looks fine',
  stopReason: 'end_turn',
  sessionId: REPORTED_SESSION,
  usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  num_turns: 1,
  total_cost_usd: 0.001,
});

const STRUCTURED_JSON = JSON.stringify({
  text: JSON.stringify(FINDINGS),
  structuredOutput: FINDINGS,
  stopReason: 'end_turn',
  sessionId: REPORTED_SESSION,
  usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  num_turns: 1,
  total_cost_usd: 0.001,
});

const tmpDirs: string[] = [];

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-review-'));
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
  extras: CtxExtras = {},
): ToolContext {
  return {
    config: isolatedConfig({ GROK_BINARY: binary, ...overrides }),
    signal: new AbortController().signal,
    reportProgress:
      extras.reportProgress ??
      (() => {
        /* protocol tests cover progress separately */
      }),
    progressRequested: extras.progressRequested ?? false,
  };
}

async function runReview(
  input: Record<string, unknown>,
  script: Record<string, string> = {},
  env: Record<string, string> = {},
  extras: CtxExtras = {},
): Promise<{ result: ToolResult; argvFile: string }> {
  const { binary, argvFile } = await installFake({
    FAKE_GROK_STDOUT: SUCCESS_JSON,
    ...script,
  });
  const result = await reviewTool.handler(input, ctxFor(binary, env, extras));
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

function recordedArgv(argv: unknown): string[] {
  assert.ok(Array.isArray(argv));
  const entries: unknown[] = argv;
  assert.ok(entries.every((entry): entry is string => typeof entry === 'string'));
  return entries;
}

function promptFromArgv(argv: unknown): string {
  const recorded = recordedArgv(argv);
  const at = recorded.indexOf('-p');
  assert.ok(at >= 0, 'expected -p in argv');
  const prompt = recorded[at + 1];
  assert.ok(typeof prompt === 'string');
  return prompt;
}

function flagValue(argv: unknown, flag: string): string | undefined {
  const recorded = recordedArgv(argv);
  const at = recorded.indexOf(flag);
  if (at < 0) return undefined;
  return recorded[at + 1];
}

describe('review target conflicts are rejected before spawn', () => {
  const cases: readonly { name: string; input: Record<string, unknown> }[] = [
    { name: 'base and commit', input: { base: 'main', commit: 'abc1234' } },
    { name: 'base and uncommitted', input: { base: 'main', uncommitted: true } },
    { name: 'commit and uncommitted', input: { commit: 'abc1234', uncommitted: true } },
    {
      name: 'base, commit, and uncommitted',
      input: { base: 'main', commit: 'abc1234', uncommitted: true },
    },
  ];

  for (const { name, input } of cases) {
    it(`rejects ${name} before any spawn, so the fixture argv file is never created`, async () => {
      const { binary, argvFile } = await installFake({ FAKE_GROK_STDOUT: SUCCESS_JSON });

      await assert.rejects(
        () => reviewTool.handler(input, ctxFor(binary)),
        (error: unknown) => {
          assert.ok(error instanceof InvalidArgumentsError);
          assert.match(error.message, /Invalid arguments for "review"/);
          return true;
        },
      );

      assert.equal(await argvExists(argvFile), false);
    });
  }
});

describe('review schema validation', () => {
  const emptyStringCases: readonly (readonly [field: string, why: string])[] = [
    ['cwd', 'an empty cwd would silently review wherever the server lives'],
    ['base', 'an empty base would be dropped by the argv builder and silently auto-detect'],
    ['commit', 'an empty commit would be dropped and silently auto-detect'],
  ];

  for (const [field, why] of emptyStringCases) {
    it(`rejects an empty ${field}, because ${why}`, async () => {
      await assert.rejects(
        () => invokeTool('review', { [field]: '' }, ctxFor('/no/such-grok-binary-7c3e91a2')),
        (error: unknown) => {
          assert.ok(error instanceof InvalidArgumentsError);
          assert.match(error.message, new RegExp(field));
          return true;
        },
      );
    });
  }
});

describe('review explicit targets embed the matching diff', { skip: skipGit }, () => {
  it('embeds the working-tree change when uncommitted is requested', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('tracked.txt', 'committed\n');
      await repo.commit('init');
      await repo.write('dirty.txt', 'UNCOMMITTED_MARKER_xyz\n');

      const { result, argvFile } = await runReview({ cwd: repo.cwd, uncommitted: true });

      assert.notEqual(result.isError, true);
      const prompt = promptFromArgv(await readArgv(argvFile));
      assert.match(prompt, /UNCOMMITTED_MARKER_xyz/);
      assert.match(prompt, /dirty\.txt/);
      assert.equal(metaOf(result)['target'], 'uncommitted');
      assert.match(String(metaOf(result)['targetDescription']), /working tree/);
    });
  });

  it('embeds the named commit when commit is requested', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('readme.txt', 'base\n');
      await repo.commit('init');
      await repo.write('feature.ts', 'COMMIT_MARKER_xyz\n');
      const sha = await repo.commit('add feature');

      const { result, argvFile } = await runReview({ cwd: repo.cwd, commit: sha });

      assert.notEqual(result.isError, true);
      const prompt = promptFromArgv(await readArgv(argvFile));
      assert.match(prompt, /COMMIT_MARKER_xyz/);
      assert.match(prompt, /feature\.ts/);
      assert.equal(metaOf(result)['target'], 'commit');
      assert.match(String(metaOf(result)['targetDescription']), new RegExp(sha));
    });
  });

  it('embeds the merge-base diff when base is requested, not later commits on the base', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('shared.txt', 'shared\n');
      await repo.commit('A: initial');
      const branched = await repo.git(['checkout', '-b', 'feature']);
      assert.equal(branched.code, 0, branched.stderr);
      await repo.write('feature.txt', 'BASE_MARKER_xyz\n');
      await repo.commit('C: feature work');
      const back = await repo.git(['checkout', 'main']);
      assert.equal(back.code, 0, back.stderr);
      await repo.write('later-on-main.txt', 'LATER_MAIN_MARKER\n');
      await repo.commit('D: later main');
      const ontoFeature = await repo.git(['checkout', 'feature']);
      assert.equal(ontoFeature.code, 0, ontoFeature.stderr);

      const { result, argvFile } = await runReview({ cwd: repo.cwd, base: 'main' });

      assert.notEqual(result.isError, true);
      const prompt = promptFromArgv(await readArgv(argvFile));
      assert.match(prompt, /BASE_MARKER_xyz/);
      assert.match(prompt, /feature\.txt/);
      assert.doesNotMatch(prompt, /LATER_MAIN_MARKER/);
      assert.equal(metaOf(result)['target'], 'base');
    });
  });
});

describe('review auto-detection', { skip: skipGit }, () => {
  it('chooses the working tree when the branch is not ahead of an upstream', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('tracked.txt', 'committed\n');
      await repo.commit('init');
      await repo.write('dirty.txt', 'AUTO_UNCOMMITTED_MARKER\n');

      const { result, argvFile } = await runReview({ cwd: repo.cwd });

      assert.notEqual(result.isError, true);
      const prompt = promptFromArgv(await readArgv(argvFile));
      assert.match(prompt, /AUTO_UNCOMMITTED_MARKER/);
      assert.equal(metaOf(result)['target'], 'uncommitted');
      assert.equal(metaOf(result)['excluded'], undefined);
    });
  });

  it('chooses the base diff when the branch is ahead of its upstream', async () => {
    const remote = await createGitRepo({ bare: true });
    const repo = await createGitRepo();
    try {
      await repo.write('a.txt', 'a\n');
      await repo.commit('init');
      const addRemote = await repo.git(['remote', 'add', 'origin', remote.cwd]);
      assert.equal(addRemote.code, 0, addRemote.stderr);
      const pushed = await repo.git(['push', '-u', 'origin', 'main']);
      assert.equal(pushed.code, 0, pushed.stderr);
      await repo.write('ahead.txt', 'AHEAD_MARKER_xyz\n');
      await repo.commit('ahead');

      const { result, argvFile } = await runReview({ cwd: repo.cwd });

      assert.notEqual(result.isError, true);
      const prompt = promptFromArgv(await readArgv(argvFile));
      assert.match(prompt, /AHEAD_MARKER_xyz/);
      assert.equal(metaOf(result)['target'], 'base');
      assert.match(String(metaOf(result)['targetDescription']), /origin\/main/);
    } finally {
      await repo.cleanup();
      await remote.cleanup();
    }
  });
});

describe('review is always read-only', { skip: skipGit }, () => {
  it('emits --permission-mode plan and --sandbox read-only even when ceiling and default are both full', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('tracked.txt', 'committed\n');
      await repo.commit('init');
      await repo.write('dirty.txt', 'needs review\n');

      const { result, argvFile } = await runReview(
        { cwd: repo.cwd, uncommitted: true },
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
      assert.ok(!argv.includes('--always-approve'));
      assert.equal(metaOf(result)['permissionLevel'], 'read-only');
    });
  });
});

describe('review structured findings', { skip: skipGit }, () => {
  it('puts --json-schema in the argv and yields _meta.findings when the CLI emits structuredOutput', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('tracked.txt', 'committed\n');
      await repo.commit('init');
      await repo.write('dirty.txt', 'needs review\n');

      const { result, argvFile } = await runReview(
        { cwd: repo.cwd, uncommitted: true, structured: true },
        { FAKE_GROK_STDOUT: STRUCTURED_JSON },
      );

      assert.notEqual(result.isError, true);
      const argv = recordedArgv(await readArgv(argvFile));
      assert.equal(flagValue(argv, '--json-schema'), REVIEW_FINDINGS_SCHEMA);
      assert.equal(flagValue(argv, '--output-format'), 'json');
      assert.deepEqual(metaOf(result)['findings'], FINDINGS);
      assert.equal(textOf(result), JSON.stringify(FINDINGS, null, 2));
    });
  });

  it('keeps --output-format streaming-json when structured is set, because an explicit stream wins over the json-schema implication', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('tracked.txt', 'committed\n');
      await repo.commit('init');
      await repo.write('dirty.txt', 'needs review\n');

      const streamDir = await makeTmp();
      const streamFile = path.join(streamDir, 'structured.ndjson');
      await writeFile(
        streamFile,
        [
          JSON.stringify({ type: 'text', data: 'ignored when structuredOutput is present' }),
          JSON.stringify({
            type: 'end',
            stopReason: 'end_turn',
            sessionId: REPORTED_SESSION,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            num_turns: 1,
            total_cost_usd: 0.001,
            structuredOutput: FINDINGS,
          }),
          '',
        ].join('\n'),
      );

      const { result, argvFile } = await runReview(
        { cwd: repo.cwd, uncommitted: true, structured: true },
        {
          FAKE_GROK_STDOUT: '',
          FAKE_GROK_STREAM_FILE: streamFile,
        },
        {},
        { progressRequested: true },
      );

      assert.notEqual(result.isError, true);
      const argv = recordedArgv(await readArgv(argvFile));
      assert.equal(flagValue(argv, '--output-format'), 'streaming-json');
      assert.equal(flagValue(argv, '--json-schema'), REVIEW_FINDINGS_SCHEMA);
      assert.deepEqual(metaOf(result)['findings'], FINDINGS);
    });
  });

  it('yields _meta.parseError, isError false, and the raw text when structured output cannot be parsed', async () => {
    const raw = 'this is a prose review, not json';
    await withGitRepo(async (repo) => {
      await repo.write('tracked.txt', 'committed\n');
      await repo.commit('init');
      await repo.write('dirty.txt', 'needs review\n');

      const { result } = await runReview(
        { cwd: repo.cwd, uncommitted: true, structured: true },
        {
          FAKE_GROK_STDOUT: JSON.stringify({
            text: raw,
            stopReason: 'end_turn',
            sessionId: REPORTED_SESSION,
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            num_turns: 1,
            total_cost_usd: 0.001,
          }),
        },
      );

      assert.equal(result.isError, false);
      assert.equal(textOf(result), raw);
      assert.match(String(metaOf(result)['parseError']), /invalid JSON/);
      assert.equal(metaOf(result)['findings'], undefined);
    });
  });
});

describe('review empty and truncated diffs', { skip: skipGit }, () => {
  it('returns early with isError false and no grok invocation when the target diff is empty', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('tracked.txt', 'committed\n');
      await repo.commit('init');

      const { binary, argvFile } = await installFake({ FAKE_GROK_STDOUT: SUCCESS_JSON });
      const result = await reviewTool.handler({ cwd: repo.cwd, uncommitted: true }, ctxFor(binary));

      assert.equal(result.isError, false);
      assert.match(textOf(result), /Nothing to review/);
      assert.match(textOf(result), /working tree/);
      assert.equal(await argvExists(argvFile), false);
      assert.equal(metaOf(result)['target'], 'uncommitted');
    });
  });

  it('puts a truncation notice naming omitted bytes and omitted files in the prompt when the diff exceeds the byte cap', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('tracked.txt', 'committed\n');
      await repo.commit('init');
      await repo.write('a-keep.txt', 'KEEP_ME_MARKER\n');
      await repo.write('z-drop.txt', `${'y'.repeat(300_000)}\n`);

      const { result, argvFile } = await runReview({ cwd: repo.cwd, uncommitted: true });

      assert.notEqual(result.isError, true);
      const prompt = promptFromArgv(await readArgv(argvFile));
      assert.match(prompt, /truncated/i);
      assert.match(prompt, /\d+ bytes were omitted/);
      assert.match(prompt, /z-drop\.txt/);
      assert.match(prompt, /KEEP_ME_MARKER/);
      assert.ok(!prompt.includes('y'.repeat(1000)), 'omitted file body must not fill the prompt');
      assert.equal(metaOf(result)['diffTruncated'], true);
    });
  });
});

describe('runGrok metadata is not overridable by a handler', () => {
  it('keeps the session id the CLI reported even when handler meta tries to replace it', async () => {
    const { binary } = await installFake({ FAKE_GROK_STDOUT: SUCCESS_JSON });

    const result = await runGrok(
      {
        args: ['-p', 'anything', '--output-format', 'json'],
        model: 'grok-4.6',
        permissionLevel: 'read-only',
        // A handler has no business setting these, but nothing stops it from trying, and a
        // fabricated session id is invisible to the caller — it looks exactly like a real one
        // until they try to resume it. The run's own keys have to win the merge.
        meta: {
          sessionId: 'fabricated-0000-0000-0000-000000000000',
          model: 'not-the-model-we-passed',
          permissionLevel: 'full',
          reviewSpecific: 'kept',
        },
      },
      ctxFor(binary),
    );

    const meta = metaOf(result);
    assert.strictEqual(meta['sessionId'], REPORTED_SESSION);
    assert.strictEqual(meta['model'], 'grok-4.6');
    assert.strictEqual(meta['permissionLevel'], 'read-only');
    assert.strictEqual(meta['reviewSpecific'], 'kept', 'non-colliding handler keys still merge');
  });
});

describe('review explains why structured findings are missing', { skip: skipGit }, () => {
  it('names the stop reason when the run ended early, because "invalid JSON" alone blames the model', async () => {
    // `--json-schema` constrains every assistant message, so a multi-turn run emits one JSON
    // object per turn and the concatenation is not valid JSON. Verified against grok 1.0.4:
    // a review that stopped at `cancelled` produced exactly this shape.
    const cancelled = JSON.stringify({
      text: '{ "findings": [] }{ "findings": [] }',
      stopReason: 'cancelled',
      sessionId: REPORTED_SESSION,
      num_turns: 7,
    });

    await withGitRepo(async (repo) => {
      await repo.write('a.txt', 'one\n');
      await repo.commit('seed');
      await repo.write('a.txt', 'two\n');

      const { result } = await runReview(
        { cwd: repo.cwd, uncommitted: true, structured: true },
        { FAKE_GROK_STDOUT: cancelled },
      );

      const parseError = metaOf(result)['parseError'];
      assert.ok(typeof parseError === 'string');
      assert.match(parseError, /stopReason "cancelled"/);
      assert.match(parseError, /maxTurns/);
      assert.strictEqual(result.isError, false, 'a degraded parse must not fail the call');
      assert.match(textOf(result), /findings/);
    });
  });

  it('leaves the parse error alone when the run completed normally', async () => {
    const finished = JSON.stringify({
      text: 'not json at all',
      stopReason: 'end_turn',
      sessionId: REPORTED_SESSION,
      num_turns: 1,
    });

    await withGitRepo(async (repo) => {
      await repo.write('a.txt', 'one\n');
      await repo.commit('seed');
      await repo.write('a.txt', 'two\n');

      const { result } = await runReview(
        { cwd: repo.cwd, uncommitted: true, structured: true },
        { FAKE_GROK_STDOUT: finished },
      );

      assert.strictEqual(metaOf(result)['parseError'], 'invalid JSON');
    });
  });
});
