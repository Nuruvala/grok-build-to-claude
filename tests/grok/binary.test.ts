import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { probeAuth, probeVersion } from '../../src/grok/binary.js';

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));

const tmpDirs: string[] = [];

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-binary-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Per-test grok stand-in. Writes a tiny launcher that injects FAKE_GROK_* into
 * the child and then runs the shared fixture — so this file never mutates
 * process.env and never inherits the developer's XAI_API_KEY / GROK_* vars.
 */
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

async function readArgv(argvFile: string): Promise<unknown> {
  return JSON.parse(await readFile(argvFile, 'utf8')) as unknown;
}

async function argvWriteCount(argvFile: string): Promise<number> {
  try {
    await access(argvFile);
    return 1;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

describe('probeVersion', () => {
  it('returns ok and the raw first line when the fake reports a version string', async () => {
    const { binary } = await installFake({
      FAKE_GROK_STDOUT: 'grok 1.0.0 (3cd0d0cbce) [stable]\n',
    });

    const probe = await probeVersion(binary, 2_000);

    assert.equal(probe.ok, true);
    assert.equal(probe.version, 'grok 1.0.0 (3cd0d0cbce) [stable]');
    assert.equal(probe.problem, null);
  });

  it('falls back to --version when version exits non-zero, and the fallback argv is what the fixture recorded', async () => {
    const { binary, argvFile } = await installFake({ FAKE_GROK_EXIT_CODE: '1' });

    const probe = await probeVersion(binary, 2_000);

    assert.equal(probe.ok, false);
    assert.ok(probe.problem);
    assert.deepEqual(await readArgv(argvFile), ['--version']);
  });

  it('succeeds on the --version fallback when version exits non-zero and --version prints a banner', async () => {
    const dir = await makeTmp();
    const argvFile = path.join(dir, 'argv.json');
    const binary = path.join(dir, 'grok');
    const source = `#!/usr/bin/env node
process.env.FAKE_GROK_ARGV_FILE = ${JSON.stringify(argvFile)};
if (process.argv[2] === 'version') {
  process.env.FAKE_GROK_EXIT_CODE = '1';
} else {
  process.env.FAKE_GROK_EXIT_CODE = '0';
  process.env.FAKE_GROK_STDOUT = 'grok 1.0.0 (fallback) [stable]\\n';
}
await import(${JSON.stringify(pathToFileURL(FAKE_GROK).href)});
`;
    await writeFile(binary, source, { encoding: 'utf8' });
    await chmod(binary, 0o755);

    const probe = await probeVersion(binary, 2_000);

    assert.equal(probe.ok, true);
    assert.equal(probe.version, 'grok 1.0.0 (fallback) [stable]');
    assert.deepEqual(await readArgv(argvFile), ['--version']);
  });

  it('returns ok: false naming GROK_BINARY on a missing binary, and does not retry', async () => {
    const argvFile = path.join(await makeTmp(), 'argv.json');
    const missing = '/no/such/grok-binary-7c3e91a2';

    const probe = await probeVersion(missing, 2_000);

    assert.equal(probe.ok, false);
    assert.equal(probe.version, null);
    assert.match(probe.problem ?? '', /GROK_BINARY/);
    assert.equal(await argvWriteCount(argvFile), 0);
  });

  it('does not retry a timeout, because a hung binary is not a missing --version flag', async () => {
    const { binary, argvFile } = await installFake({
      FAKE_GROK_STDOUT: 'partial',
      FAKE_GROK_SLEEP_MS: '10000',
    });

    const probe = await probeVersion(binary, 150);

    assert.equal(probe.ok, false);
    assert.match(probe.problem ?? '', /timed out/);
    assert.deepEqual(await readArgv(argvFile), ['version']);
  });

  it('caps a long caller timeout so a probe cannot inherit the 30-minute run wall clock', async () => {
    const { binary } = await installFake({
      FAKE_GROK_STDOUT: 'grok 1.0.0 (fake) [test]\n',
    });

    const probe = await probeVersion(binary, 30 * 60 * 1000);

    assert.equal(probe.ok, true);
    assert.equal(probe.version, 'grok 1.0.0 (fake) [test]');
  });
});

describe('probeAuth', () => {
  // Synthetic ids, but the real layout of grok 1.0.0: prose lines, a header, then bullets. The
  // prose is what an earlier parser reported as model ids.
  const MODELS_STDOUT = [
    'You are logged in with example.invalid.',
    '',
    'Default model: fake-model-2',
    '',
    'Available models:',
    '  * fake-model-2 (default)',
    '  - fake-model-1',
    '',
  ].join('\n');

  it('returns ok: true and only the bulleted model ids when grok models exits 0', async () => {
    const { binary } = await installFake({ FAKE_GROK_STDOUT: MODELS_STDOUT });

    const probe = await probeAuth(binary, 2_000);

    assert.equal(probe.ok, true);
    assert.deepEqual([...probe.models], ['fake-model-2', 'fake-model-1']);
    assert.equal(probe.problem, null);
  });

  it('keeps prose out of the model list, because the login line is not a model id', async () => {
    const { binary } = await installFake({ FAKE_GROK_STDOUT: MODELS_STDOUT });

    const probe = await probeAuth(binary, 2_000);

    for (const model of probe.models) {
      assert.doesNotMatch(model, /logged in|Default model|Available/);
      assert.doesNotMatch(model, /\s/);
    }
  });

  it('strips the (default) annotation so a reported id can be passed straight back as --model', async () => {
    const { binary } = await installFake({ FAKE_GROK_STDOUT: MODELS_STDOUT });

    const probe = await probeAuth(binary, 2_000);

    assert.ok(!probe.models.some((model) => model.includes('(')));
  });

  it('reports no models rather than guessing when the output format is unrecognised, because the exit code is the authority', async () => {
    const { binary } = await installFake({
      FAKE_GROK_STDOUT: 'models are now listed at https://example.invalid/models\n',
    });

    const probe = await probeAuth(binary, 2_000);

    assert.equal(probe.ok, true);
    assert.deepEqual([...probe.models], []);
    assert.equal(probe.problem, null);
  });

  it('returns ok: false with a problem naming grok login when grok models exits non-zero', async () => {
    const { binary } = await installFake({
      FAKE_GROK_STDERR: 'not logged in',
      FAKE_GROK_EXIT_CODE: '1',
    });

    const probe = await probeAuth(binary, 2_000);

    assert.equal(probe.ok, false);
    assert.deepEqual([...probe.models], []);
    assert.match(probe.problem ?? '', /grok login/);
  });

  it('still returns ok: true with an empty model list when stdout cannot be parsed, because the exit code is the authority', async () => {
    const { binary } = await installFake({
      FAKE_GROK_STDOUT: '   \n\t\n',
    });

    const probe = await probeAuth(binary, 2_000);

    assert.equal(probe.ok, true);
    assert.deepEqual([...probe.models], []);
    assert.equal(probe.problem, null);
  });

  it('returns ok: false naming GROK_BINARY when the binary is missing', async () => {
    const probe = await probeAuth('/no/such/grok-binary-7c3e91a2', 2_000);

    assert.equal(probe.ok, false);
    assert.match(probe.problem ?? '', /GROK_BINARY/);
    assert.deepEqual([...probe.models], []);
  });
});

describe('probe cancellation', () => {
  it('honours an aborted signal so a cancelled check does not leave probes running out the cap', async () => {
    const controller = new AbortController();
    controller.abort();
    const { binary } = await installFake({ FAKE_GROK_SLEEP_MS: '30000' });

    // Both probes are total, so cancellation surfaces as ok: false rather than a rejection.
    const [version, auth] = await Promise.all([
      probeVersion(binary, 30_000, controller.signal),
      probeAuth(binary, 30_000, controller.signal),
    ]);

    assert.equal(version.ok, false);
    assert.equal(auth.ok, false);
    assert.match(version.problem ?? '', /cancelled/);
    assert.match(auth.problem ?? '', /cancelled/);
  });
});
