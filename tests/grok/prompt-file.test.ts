import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { buildGrokArgs } from '../../src/grok/args.js';
import type { PromptDelivery } from '../../src/grok/args.js';
import { INLINE_PROMPT_MAX_BYTES, withPromptDelivery } from '../../src/grok/prompt-file.js';
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
