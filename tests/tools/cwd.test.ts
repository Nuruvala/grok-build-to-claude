import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { InvalidArgumentsError } from '../../src/errors.js';
import { assertUsableCwd, isUsableCwdShape } from '../../src/tools/cwd.js';

const tmpDirs: string[] = [];

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-cwd-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('isUsableCwdShape', () => {
  const cases: readonly { readonly value: string; readonly expected: boolean }[] = [
    { value: '/tmp', expected: true },
    { value: '/home/nuru/repos/x', expected: true },
    { value: '/', expected: true },
    { value: 'tmp', expected: false },
    { value: 'relative/path', expected: false },
    { value: '.', expected: false },
    { value: '~/x', expected: false },
    { value: '', expected: false },
  ];

  for (const { value, expected } of cases) {
    it(`${JSON.stringify(value)} → ${expected}`, () => {
      assert.equal(isUsableCwdShape(value), expected);
    });
  }
});

describe('assertUsableCwd', () => {
  it('returns immediately when cwd is omitted', async () => {
    await assertUsableCwd(undefined, 'grok');
  });

  it('accepts an existing directory', async () => {
    const dir = await makeTmp();
    await assertUsableCwd(dir, 'grok');
  });

  it('rejects a nonexistent path as missing, not as a non-directory', async () => {
    const missing = path.join(os.tmpdir(), 'grok-mcp-cwd-missing-7c3e91a2');
    await assert.rejects(
      () => assertUsableCwd(missing, 'grok'),
      (error: unknown) => {
        assert.ok(error instanceof InvalidArgumentsError);
        assert.match(error.message, /does not exist/);
        assert.doesNotMatch(error.message, /not a directory/);
        return true;
      },
    );
  });

  it('rejects a path that is a file as not a directory, not as missing', async () => {
    const dir = await makeTmp();
    const filePath = path.join(dir, 'hostname');
    await writeFile(filePath, 'box\n');
    await assert.rejects(
      () => assertUsableCwd(filePath, 'review'),
      (error: unknown) => {
        assert.ok(error instanceof InvalidArgumentsError);
        assert.match(error.message, /not a directory/);
        assert.doesNotMatch(error.message, /does not exist/);
        return true;
      },
    );
  });
});
