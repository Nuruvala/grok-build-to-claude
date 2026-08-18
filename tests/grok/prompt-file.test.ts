import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { buildGrokArgs } from '../../src/grok/args.js';
import type { PromptDelivery } from '../../src/grok/args.js';
import {
  INLINE_PROMPT_MAX_BYTES,
  PROMPT_DIR_PREFIX,
  promptDirMaxAgeMs,
  shouldSweepPromptDir,
  sweepStalePromptDirs,
  withPromptDelivery,
} from '../../src/grok/prompt-file.js';
import { permissionFlags } from '../../src/permission.js';

/**
 * Linux MAX_ARG_STRLEN: 32 pages. A single argv element above this makes `spawn` fail with
 * E2BIG before the child ever runs, which is what a `review` of a real diff produced.
 */
const MAX_ARG_STRLEN = 32 * 4096;

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('withPromptDelivery', () => {
  it('keeps a small prompt inline, so the common case stays inspectable in argv', async () => {
    const captured = await withPromptDelivery('review this', (delivery) =>
      Promise.resolve(delivery),
    );
    assert.deepEqual(captured, { prompt: 'review this' });
  });

  it('keeps a prompt exactly at the threshold inline', async () => {
    const prompt = 'x'.repeat(INLINE_PROMPT_MAX_BYTES);
    const captured = await withPromptDelivery(prompt, (delivery) => Promise.resolve(delivery));
    assert.strictEqual(captured.promptFile, undefined);
    assert.strictEqual(captured.prompt, prompt);
  });

  it('writes an oversized prompt to a file and hands back its path', async () => {
    const prompt = 'y'.repeat(INLINE_PROMPT_MAX_BYTES + 1);
    let seen: PromptDelivery | undefined;
    let path: string | undefined;

    await withPromptDelivery(prompt, async (delivery) => {
      seen = delivery;
      path = delivery.promptFile;
      assert.ok(path, 'an oversized prompt must be delivered as a file');
      assert.strictEqual(await readFile(path, 'utf8'), prompt);
    });

    assert.strictEqual(seen?.prompt, undefined, 'the inline prompt must not also be set');
    assert.ok(path);
    assert.strictEqual(await exists(path), false, 'the temp file must not outlive the run');
  });

  it('measures the threshold in bytes, not characters', async () => {
    // Half the threshold in characters, but every one is 3 bytes of UTF-8 — so it is over.
    const prompt = '日'.repeat(INLINE_PROMPT_MAX_BYTES / 2);
    assert.ok(prompt.length < INLINE_PROMPT_MAX_BYTES);
    assert.ok(Buffer.byteLength(prompt) > INLINE_PROMPT_MAX_BYTES);

    const captured = await withPromptDelivery(prompt, (delivery) => Promise.resolve(delivery));
    assert.ok(captured.promptFile, 'a byte-oversized prompt must go to a file');
  });

  it('removes the temp file even when the run throws', async () => {
    const prompt = 'z'.repeat(INLINE_PROMPT_MAX_BYTES + 1);
    let path: string | undefined;

    await assert.rejects(
      withPromptDelivery(prompt, (delivery) => {
        path = delivery.promptFile;
        return Promise.reject(new Error('run failed'));
      }),
      /run failed/,
    );

    assert.ok(path);
    assert.strictEqual(await exists(path), false);
  });

  it('produces argv whose every element fits the kernel per-argument limit', async () => {
    // The regression this whole module exists for: a 158 KiB prompt built from this repo's own
    // working tree made `spawn` fail with E2BIG, reported as "Failed to start grok".
    const prompt = 'a'.repeat(158 * 1024);
    assert.ok(prompt.length > MAX_ARG_STRLEN, 'the fixture must actually exceed the limit');

    await withPromptDelivery(prompt, (delivery) => {
      const argv = buildGrokArgs({
        ...delivery,
        outputFormat: 'json',
        permission: permissionFlags('read-only'),
      });
      const oversized = argv.filter((arg) => Buffer.byteLength(arg) > MAX_ARG_STRLEN);
      assert.deepEqual(oversized, [], 'no argv element may exceed MAX_ARG_STRLEN');
      assert.ok(argv.includes('--prompt-file'));
      assert.ok(!argv.includes('-p'));
      return Promise.resolve();
    });
  });
});

describe('buildGrokArgs prompt delivery', () => {
  it('emits -p for an inline prompt', () => {
    const argv = buildGrokArgs({
      prompt: 'hello',
      outputFormat: 'json',
      permission: permissionFlags('read-only'),
    });
    assert.deepEqual(argv.slice(0, 2), ['-p', 'hello']);
  });

  it('emits --prompt-file instead, in the same leading position', () => {
    const argv = buildGrokArgs({
      promptFile: '/tmp/grok-mcp-prompt-x/prompt.txt',
      outputFormat: 'json',
      permission: permissionFlags('read-only'),
    });
    assert.deepEqual(argv.slice(0, 2), ['--prompt-file', '/tmp/grok-mcp-prompt-x/prompt.txt']);
    assert.ok(!argv.includes('-p'));
  });
});

describe('shouldSweepPromptDir', () => {
  const now = 1_000_000;
  const maxAgeMs = 1_000;

  const cases: readonly {
    readonly label: string;
    readonly entry: {
      readonly name: string;
      readonly isDirectory: boolean;
      readonly mtimeMs: number;
    };
    readonly expected: boolean;
  }[] = [
    {
      label: 'old matching directory',
      entry: { name: `${PROMPT_DIR_PREFIX}old`, isDirectory: true, mtimeMs: now - maxAgeMs - 1 },
      expected: true,
    },
    {
      label: 'exactly maxAgeMs is not stale',
      entry: { name: `${PROMPT_DIR_PREFIX}edge`, isDirectory: true, mtimeMs: now - maxAgeMs },
      expected: false,
    },
    {
      label: 'fresh matching directory',
      entry: { name: `${PROMPT_DIR_PREFIX}fresh`, isDirectory: true, mtimeMs: now - 10 },
      expected: false,
    },
    {
      label: 'matching file',
      entry: { name: `${PROMPT_DIR_PREFIX}file`, isDirectory: false, mtimeMs: now - maxAgeMs - 1 },
      expected: false,
    },
    {
      label: 'non-matching directory',
      entry: { name: 'other-tmp-old', isDirectory: true, mtimeMs: now - maxAgeMs - 1 },
      expected: false,
    },
  ];

  for (const { label, entry, expected } of cases) {
    it(`${label} → ${expected}`, () => {
      assert.equal(shouldSweepPromptDir({ ...entry, now, maxAgeMs }), expected);
    });
  }
});

describe('promptDirMaxAgeMs', () => {
  it('is at least 24 hours so a default-timeout run cannot lose its prompt', () => {
    assert.equal(promptDirMaxAgeMs(1_000), 24 * 60 * 60 * 1000);
  });

  it('doubles a timeout that already exceeds 24 hours', () => {
    const day = 24 * 60 * 60 * 1000;
    assert.equal(promptDirMaxAgeMs(day), 2 * day);
  });
});

describe('sweepStalePromptDirs', () => {
  const tmpDirs: string[] = [];

  async function makeTmp(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-sweep-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('removes an old matching directory and keeps a fresh one', async () => {
    const tmpDir = await makeTmp();
    const now = Date.now();
    const maxAgeMs = 60_000;
    const oldDir = path.join(tmpDir, `${PROMPT_DIR_PREFIX}old`);
    const freshDir = path.join(tmpDir, `${PROMPT_DIR_PREFIX}fresh`);
    await mkdir(oldDir);
    await mkdir(freshDir);
    await writeFile(path.join(oldDir, 'prompt.txt'), 'old');
    await writeFile(path.join(freshDir, 'prompt.txt'), 'fresh');
    await utimes(oldDir, new Date(now - maxAgeMs - 5_000), new Date(now - maxAgeMs - 5_000));

    const removed = await sweepStalePromptDirs({ tmpDir, now, maxAgeMs });
    assert.equal(removed, 1);
    assert.equal(await exists(oldDir), false);
    assert.equal(await exists(freshDir), true);
  });

  it('leaves a non-matching directory and a matching file untouched', async () => {
    const tmpDir = await makeTmp();
    const now = Date.now();
    const maxAgeMs = 60_000;
    const otherDir = path.join(tmpDir, 'not-ours');
    const matchingFile = path.join(tmpDir, `${PROMPT_DIR_PREFIX}file`);
    await mkdir(otherDir);
    await writeFile(matchingFile, 'not a directory');
    await utimes(otherDir, new Date(now - maxAgeMs - 5_000), new Date(now - maxAgeMs - 5_000));
    await utimes(matchingFile, new Date(now - maxAgeMs - 5_000), new Date(now - maxAgeMs - 5_000));

    const removed = await sweepStalePromptDirs({ tmpDir, now, maxAgeMs });
    assert.equal(removed, 0);
    assert.equal(await exists(otherDir), true);
    assert.equal(await exists(matchingFile), true);
  });

  it('returns 0 when the temp directory is missing', async () => {
    const missing = path.join(os.tmpdir(), 'grok-mcp-sweep-missing-7c3e91a2');
    const removed = await sweepStalePromptDirs({
      tmpDir: missing,
      now: Date.now(),
      maxAgeMs: 1_000,
    });
    assert.equal(removed, 0);
  });

  it('honours deleteCap so a pathological temp directory cannot stall startup', async () => {
    const tmpDir = await makeTmp();
    const now = Date.now();
    const maxAgeMs = 60_000;
    const stamp = new Date(now - maxAgeMs - 5_000);
    for (const name of ['a', 'b', 'c']) {
      const dir = path.join(tmpDir, `${PROMPT_DIR_PREFIX}${name}`);
      await mkdir(dir);
      await utimes(dir, stamp, stamp);
    }

    const removed = await sweepStalePromptDirs({ tmpDir, now, maxAgeMs, deleteCap: 2 });
    assert.equal(removed, 2);
    let remaining = 0;
    for (const name of ['a', 'b', 'c']) {
      if (await exists(path.join(tmpDir, `${PROMPT_DIR_PREFIX}${name}`))) remaining += 1;
    }
    assert.equal(remaining, 1);
  });
});
