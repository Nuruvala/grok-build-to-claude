/**
 * Deliver a prompt to the child without hitting the argv size limit.
 *
 * Linux caps a *single* argv element at MAX_ARG_STRLEN — 32 pages, 128 KiB — independently of
 * the much larger total ARG_MAX. A `review` embedding a real diff sails past that: this repo's
 * own working tree produced a 158 KiB prompt, and `spawn` failed with E2BIG before grok ever
 * started. Over the threshold the prompt goes to a file and travels as `--prompt-file`, which
 * has no such ceiling (verified on grok 1.0.4 with a 186 KiB file whose final line came back
 * intact, so the CLI reads all of it rather than truncating).
 *
 * Imperative shell: this module writes and deletes a file. The argv decision itself is pure and
 * lives in args.ts.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';

import type { PromptDelivery } from './args.js';

/**
 * Inline budget, deliberately half of Linux's 128 KiB per-argument limit.
 *
 * The headroom is not padding for its own sake: the limit applies per argument but the kernel
 * also bounds the whole block, `--json-schema` and a long `--rules` ride along in the same argv,
 * and macOS accounts for its 1 MiB total differently again. Guessing tightly here buys nothing —
 * the file path is not a worse way to send a prompt, only a less inspectable one.
 */
export const INLINE_PROMPT_MAX_BYTES = 64 * 1024;

/**
 * Run `fn` with a delivery for `prompt`, cleaning up any temp file afterwards.
 *
 * The file lands in a `mkdtemp` directory, which is created 0700, because the prompt carries the
 * caller's source diff and a world-readable /tmp file would leak it to every other user on the
 * box. Removal is in a `finally` so a thrown handler does not leave it behind.
 */
export async function withPromptDelivery<T>(
  prompt: string,
  fn: (delivery: PromptDelivery) => Promise<T>,
): Promise<T> {
  if (Buffer.byteLength(prompt) <= INLINE_PROMPT_MAX_BYTES) {
    return fn({ prompt });
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-prompt-'));
  try {
    const file = path.join(dir, 'prompt.txt');
    await writeFile(file, prompt, { encoding: 'utf8', mode: 0o600 });
    return await fn({ promptFile: file });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // A leftover temp file is untidy; failing the run over it would be worse. The directory
      // is 0700 under the OS temp dir, so the usual cleaners will get it.
    });
  }
}
