/**
 * Throwaway Grok session stores for the sessions tool tests.
 *
 * Every store is created under os.tmpdir() and removed afterwards. Callers
 * must never point this at ~/.grok — that is the developer's real session
 * history, and a test that writes there is not a test.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const live = new Set();

/**
 * @typedef {object} SessionSpec
 * @property {string} id
 * @property {string} [cwd] encoded with encodeURIComponent as the parent directory
 * @property {string} [rawCwd] parent directory name used verbatim (invalid encoding)
 * @property {object | string | false} [summary] object/string written as summary.json; false omits the file
 * @property {string | readonly object[]} [history] chat_history.jsonl body or NDJSON objects
 */

/**
 * @param {string} home GROK_HOME — the directory that contains `sessions/`
 * @param {string} root the sessions/ directory itself
 */
function makeStore(home, root) {
  return {
    home,
    root,
    /**
     * @param {SessionSpec} spec
     * @returns {Promise<string>} absolute session directory
     */
    async add(spec) {
      const parentName = spec.rawCwd ?? encodeURIComponent(spec.cwd ?? '/tmp/work');
      const dir = path.join(root, parentName, spec.id);
      await mkdir(dir, { recursive: true });

      if (spec.summary !== false && spec.summary !== undefined) {
        const body = typeof spec.summary === 'string' ? spec.summary : JSON.stringify(spec.summary);
        await writeFile(path.join(dir, 'summary.json'), body);
      }

      if (spec.history !== undefined) {
        const body =
          typeof spec.history === 'string'
            ? spec.history
            : `${spec.history.map((line) => JSON.stringify(line)).join('\n')}\n`;
        await writeFile(path.join(dir, 'chat_history.jsonl'), body);
      }

      return dir;
    },
    /**
     * @param {string} relativePath
     * @param {string | Uint8Array} contents
     */
    async write(relativePath, contents) {
      const absolute = path.join(root, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents);
    },
    async cleanup() {
      live.delete(home);
      await rm(home, { recursive: true, force: true });
    },
  };
}

export async function createSessionsStore() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-sessions-'));
  const root = path.join(home, 'sessions');
  await mkdir(root);
  live.add(home);
  return makeStore(home, root);
}

/**
 * @param {(store: ReturnType<typeof makeStore>) => Promise<void>} fn
 */
export async function withSessionsStore(fn) {
  const store = await createSessionsStore();
  try {
    await fn(store);
  } finally {
    await store.cleanup();
  }
}
