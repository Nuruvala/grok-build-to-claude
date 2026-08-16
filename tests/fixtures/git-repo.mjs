/**
 * Throwaway git repos for review-collector tests.
 *
 * Isolated from the developer's global gitconfig: hooks, commit signing, and
 * `init.defaultBranch` must not change the outcome. Every repo is created under
 * os.tmpdir() and removed afterwards. Callers must never point this at the
 * project working tree.
 */

import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const CONFIG_ARGS = [
  '-c',
  'user.email=review-fixture@example.test',
  '-c',
  'user.name=Review Fixture',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'advice.detachedHead=false',
];

const live = new Set();

/**
 * @returns {NodeJS.ProcessEnv}
 */
/**
 * @param {unknown} chunk
 * @returns {Buffer}
 */
function asBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.alloc(0);
}

function isolatedEnv() {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Review Fixture',
    GIT_AUTHOR_EMAIL: 'review-fixture@example.test',
    GIT_COMMITTER_NAME: 'Review Fixture',
    GIT_COMMITTER_EMAIL: 'review-fixture@example.test',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete env.GIT_PREFIX;
  return env;
}

/**
 * True when `git --version` works. The probe runs in os.tmpdir() with an
 * isolated env so it cannot touch the project repo.
 *
 * @returns {boolean}
 */
export function gitAvailable() {
  const result = spawnSync('git', ['--version'], {
    cwd: os.tmpdir(),
    env: isolatedEnv(),
    encoding: 'utf8',
    timeout: 10_000,
  });
  return result.error === undefined && result.status === 0;
}

/**
 * @param {string} cwd
 * @param {readonly string[]} args
 * @returns {Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>}
 */
function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...CONFIG_ARGS, ...args], {
      cwd,
      env: isolatedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(asBuffer(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(asBuffer(chunk));
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

/**
 * @param {string} cwd
 */
function makeRepo(cwd) {
  return {
    cwd,
    /**
     * @param {readonly string[]} args
     */
    git(args) {
      return runGit(cwd, args);
    },
    /**
     * @param {string} relativePath
     * @param {string | Uint8Array} contents
     */
    async write(relativePath, contents) {
      const absolute = path.join(cwd, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents);
    },
    /**
     * @param {string} message
     * @returns {Promise<string>}
     */
    async commit(message) {
      const added = await runGit(cwd, ['add', '-A']);
      if (added.code !== 0) {
        throw new Error(`git add failed: ${added.stderr}`);
      }
      const committed = await runGit(cwd, ['commit', '-m', message]);
      if (committed.code !== 0) {
        throw new Error(`git commit failed: ${committed.stderr}`);
      }
      const sha = await runGit(cwd, ['rev-parse', 'HEAD']);
      if (sha.code !== 0) {
        throw new Error(`git rev-parse HEAD failed: ${sha.stderr}`);
      }
      return sha.stdout.trim();
    },
    async cleanup() {
      live.delete(cwd);
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

/**
 * @param {{ readonly bare?: boolean }} [options]
 */
export async function createGitRepo(options = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-git-'));
  live.add(cwd);
  const initArgs = options.bare
    ? ['init', '--bare', '--initial-branch=main']
    : ['init', '--initial-branch=main'];
  const init = await runGit(cwd, initArgs);
  if (init.code !== 0) {
    live.delete(cwd);
    await rm(cwd, { recursive: true, force: true });
    throw new Error(`git init failed: ${init.stderr}`);
  }
  return makeRepo(cwd);
}

/**
 * @param {(repo: ReturnType<typeof makeRepo>) => Promise<void>} fn
 */
export async function withGitRepo(fn) {
  const repo = await createGitRepo();
  try {
    await fn(repo);
  } finally {
    await repo.cleanup();
  }
}
