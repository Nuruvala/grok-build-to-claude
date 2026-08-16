/**
 * Collect repo facts and review diffs by running git.
 *
 * Imperative shell: every function here talks to a process. Target selection
 * lives in target.ts. Never `shell: true` — paths can contain anything, and
 * several of these commands are *expected* to fail (no HEAD, no upstream,
 * `diff --no-index` exits 1). Non-zero is a value; only a missing git or a
 * directory that is not a repo is an exception.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { GitError } from '../errors.js';
import type { RepoFacts, ReviewTarget } from './target.js';

/** Well-known SHA-1 of the empty tree. Fallback when `hash-object` cannot produce one. */
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SIGKILL_GRACE_MS = 1000;
const FORCE_RESOLVE_GRACE_MS = 2000;
const BASE_LOG_LINE_CAP = 50;

/**
 * Ceiling on untracked files embedded in one review.
 *
 * Each one costs its own sequential `git diff --no-index` spawn, and the byte cap discards most
 * of the result anyway, so an unbounded list stalls a review to buy nothing.
 */
const UNTRACKED_FILE_CAP = 100;

/**
 * Inherited GIT_DIR / GIT_WORK_TREE would make `cwd` a lie and could point git
 * at the process's own repo. Strip them so the directory argument is the source
 * of truth.
 */
const STRIPPED_GIT_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
]);

export interface DiffCollection {
  readonly diff: string;
  readonly files: readonly string[];
  /** Short human-readable header describing what is being reviewed. */
  readonly context: string;
}

interface GitInvocation {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the wall clock killed this invocation, so its output is a fragment. */
  readonly timedOut: boolean;
}

interface UntrackedFiles {
  readonly files: readonly string[];
  /** True when the cap trimmed the list, so the caller can say so rather than under-report. */
  readonly capped: boolean;
}

export async function collectRepoFacts(cwd: string): Promise<RepoFacts> {
  await assertWorkTree(cwd);

  const head = await runGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  const hasCommits = head.code === 0;

  // Non-zero covers "no upstream configured" and detached HEAD — both are
  // absence of an upstream, not a broken repo.
  const upstream = await runGit(cwd, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  const trimmedUpstream = upstream.stdout.trim();
  const upstreamRef = upstream.code === 0 && trimmedUpstream !== '' ? trimmedUpstream : null;

  let commitsAheadOfUpstream = 0;
  if (upstreamRef !== null) {
    const count = await runGit(cwd, ['rev-list', '--count', `${upstreamRef}..HEAD`]);
    if (count.code === 0) {
      const parsed = Number.parseInt(count.stdout.trim(), 10);
      commitsAheadOfUpstream = Number.isFinite(parsed) ? parsed : 0;
    }
  }

  const status = await runGit(cwd, ['status', '--porcelain']);
  if (status.code !== 0) {
    throw new GitError('git status failed.', {
      stderr: status.stderr,
      cwd,
      argv: ['status', '--porcelain'],
    });
  }

  return Object.freeze({
    hasCommits,
    upstreamRef,
    commitsAheadOfUpstream,
    isDirty: status.stdout.trim() !== '',
  });
}

export async function collectDiff(cwd: string, target: ReviewTarget): Promise<DiffCollection> {
  await assertWorkTree(cwd);

  switch (target.kind) {
    case 'uncommitted':
      return collectUncommitted(cwd);
    case 'base':
      return collectBase(cwd, target.ref);
    case 'commit':
      return collectCommit(cwd, target.sha);
    default: {
      const unreachable: never = target;
      throw new Error(`unhandled review target: ${String(unreachable)}`);
    }
  }
}

async function collectUncommitted(cwd: string): Promise<DiffCollection> {
  const head = await runGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  // Empty repo: HEAD does not resolve. Diff against the empty tree so staged
  // files still show up; untracked files are appended separately.
  const treeish = head.code === 0 ? 'HEAD' : await emptyTreeOid(cwd);

  const diffRun = await runDiff(cwd, [treeish]);
  const nameRun = await runDiff(cwd, ['--name-only', treeish]);

  const untracked = await listUntracked(cwd);
  const untrackedDiffs: string[] = [];
  const untrackedFiles: string[] = [];
  for (const relative of untracked.files) {
    const fileDiff = await runGit(cwd, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-index',
      '--',
      '/dev/null',
      relative,
    ]);
    // `--no-index` exits 1 whenever the files differ, which here is always.
    if (isBinaryDiff(fileDiff.stdout, fileDiff.stderr)) continue;
    const body = fileDiff.stdout;
    if (body.trim() === '') continue;
    untrackedDiffs.push(body.endsWith('\n') ? body : `${body}\n`);
    untrackedFiles.push(relative);
  }

  const files = unique([...parseNameOnly(nameRun), ...untrackedFiles]);
  const branch = await currentBranchName(cwd);
  return freezeCollection({
    diff: joinDiffs(diffRun, untrackedDiffs),
    files,
    context: untracked.capped
      ? `${branch}\n[only the first ${UNTRACKED_FILE_CAP} untracked files were included]`
      : branch,
  });
}

async function collectBase(cwd: string, ref: string): Promise<DiffCollection> {
  // Merge-base, not `git diff <ref>..HEAD`. Two-dot against the ref includes
  // commits that landed on the base after we branched — those are not ours.
  const merge = await runGit(cwd, ['merge-base', ref, 'HEAD']);
  const mergeBase = merge.stdout.trim();
  if (merge.code !== 0 || mergeBase === '') {
    throw new GitError(`Could not find a merge-base between "${ref}" and HEAD.`, {
      stderr: merge.stderr,
      cwd,
      argv: ['merge-base', ref, 'HEAD'],
      remedy: `Check that "${ref}" exists in this repository (git rev-parse ${ref}).`,
    });
  }

  const range = `${mergeBase}..HEAD`;
  const log = await runGit(cwd, ['log', '--oneline', range]);
  const context = log.stdout
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .slice(0, BASE_LOG_LINE_CAP)
    .join('\n');

  return freezeCollection({
    diff: await runDiff(cwd, [range]),
    files: parseNameOnly(await runDiff(cwd, ['--name-only', range])),
    context,
  });
}

async function collectCommit(cwd: string, sha: string): Promise<DiffCollection> {
  const resolved = await runGit(cwd, ['rev-parse', '--verify', sha]);
  if (resolved.code !== 0) {
    throw new GitError(`Commit "${sha}" was not found.`, {
      stderr: resolved.stderr,
      cwd,
      argv: ['rev-parse', '--verify', sha],
      remedy: `Pass a commit that exists in this repository (git rev-parse ${sha}).`,
    });
  }

  const parent = await runGit(cwd, ['rev-parse', '--verify', `${sha}^`]);
  // Root commit: `<sha>^` does not resolve. Diff against the empty tree.
  const from = parent.code === 0 ? parent.stdout.trim() : await emptyTreeOid(cwd);
  const range = `${from}..${sha}`;

  const log = await runGit(cwd, ['log', '-1', '--format=%s%n%ad', sha]);

  return freezeCollection({
    diff: await runDiff(cwd, [range]),
    files: parseNameOnly(await runDiff(cwd, ['--name-only', range])),
    context: log.stdout.trim(),
  });
}

async function assertWorkTree(cwd: string): Promise<void> {
  const result = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (result.code === 0 && result.stdout.trim() === 'true') return;
  throw new GitError(`Not a git working tree: ${cwd}`, {
    stderr: result.stderr,
    cwd,
    argv: ['rev-parse', '--is-inside-work-tree'],
    remedy:
      'Pass cwd pointing at a git working tree (the directory that contains .git, or a subdirectory of one).',
  });
}

/**
 * `git diff` exits 1 when the trees differ. That is the normal case for a
 * review, not a failure — only an exit other than 0/1 with empty stdout is.
 */
async function runDiff(cwd: string, args: readonly string[]): Promise<string> {
  const argv = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', ...args];
  const result = await runGit(cwd, argv);

  // A killed git still resolves through `close`, carrying whatever bytes it managed to write.
  // Returning that would hand the model a diff cut off mid-hunk and call it the change under
  // review — findings against code that was never shown, and silence about code that was cut.
  if (result.timedOut) {
    throw new GitError(`git diff timed out after ${GIT_TIMEOUT_MS}ms.`, {
      stderr: result.stderr,
      cwd,
      argv,
      remedy: 'Review a narrower target, or pass a cwd closer to the code you want reviewed.',
    });
  }

  if (result.code !== 0 && result.code !== 1 && result.stdout === '') {
    throw new GitError('git diff failed.', {
      stderr: result.stderr,
      cwd,
      argv,
    });
  }
  return result.stdout;
}

async function emptyTreeOid(cwd: string): Promise<string> {
  // `-w` is deliberately omitted: we only need the id, not an object written.
  const hashed = await runGit(cwd, ['hash-object', '-t', 'tree', '/dev/null']);
  const oid = hashed.stdout.trim();
  return hashed.code === 0 && oid !== '' ? oid : EMPTY_TREE_SHA1;
}

async function currentBranchName(cwd: string): Promise<string> {
  const current = await runGit(cwd, ['branch', '--show-current']);
  const name = current.stdout.trim();
  if (name !== '') return name;
  const abbrev = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const fallback = abbrev.stdout.trim();
  return fallback !== '' ? fallback : 'HEAD';
}

/**
 * List untracked files, gitignore honoured, one path per record.
 *
 * `git status --porcelain` is the wrong source here: it collapses an untracked directory into a
 * single `?? pkg/` record, so a caller has to walk the tree itself — and a hand-rolled walk knows
 * nothing about `.gitignore`, so an unignored `pkg/` after `npm install` yields `node_modules`
 * before it yields `src`. `ls-files --others --exclude-standard` expands the directory, applies
 * the ignore rules, and skips submodule contents, all in git's own terms.
 *
 * `-z` on top of that disables C-quoting, which would otherwise render a non-ASCII name as
 * `"caf\303\251.txt"` — a path that then fails to stat and vanishes from the review in silence.
 */
async function listUntracked(cwd: string): Promise<UntrackedFiles> {
  const listed = await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (listed.code !== 0) {
    throw new GitError('git ls-files failed.', {
      stderr: listed.stderr,
      cwd,
      argv: ['ls-files', '--others', '--exclude-standard', '-z'],
    });
  }

  const all = listed.stdout.split('\0').filter((record) => record !== '');
  return Object.freeze({
    files: Object.freeze(all.slice(0, UNTRACKED_FILE_CAP)),
    capped: all.length > UNTRACKED_FILE_CAP,
  });
}

/**
 * Both markers are anchored to the start of a line. An unanchored `includes` would classify a
 * perfectly readable source file as binary the moment its own text mentioned the phrase — and
 * a file about diffing is exactly the kind that does.
 */
const BINARY_MARKER = /^(?:Binary files |GIT binary patch)/m;

function isBinaryDiff(stdout: string, stderr: string): boolean {
  return BINARY_MARKER.test(stdout) || BINARY_MARKER.test(stderr);
}

function parseNameOnly(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line !== '') files.push(line);
  }
  return files;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function joinDiffs(head: string, extras: readonly string[]): string {
  const parts: string[] = [];
  if (head !== '') parts.push(head.endsWith('\n') ? head : `${head}\n`);
  for (const extra of extras) {
    if (extra !== '') parts.push(extra.endsWith('\n') ? extra : `${extra}\n`);
  }
  return parts.join('');
}

function freezeCollection(collection: DiffCollection): DiffCollection {
  return Object.freeze({
    diff: collection.diff,
    files: Object.freeze([...collection.files]),
    context: collection.context,
  });
}

function runGit(cwd: string, args: readonly string[]): Promise<GitInvocation> {
  return new Promise((resolve, reject) => {
    const argv = [...args];
    let child: ChildProcess;
    try {
      child = spawn('git', argv, {
        cwd,
        env: gitChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: unknown) {
      reject(gitSpawnError(error, cwd, argv));
      return;
    }

    const stdoutBuf = createCappedBuffer(GIT_MAX_BUFFER_BYTES);
    const stderrBuf = createCappedBuffer(GIT_MAX_BUFFER_BYTES);
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    function cleanup(): void {
      for (const timer of [timeoutTimer, killTimer, forceTimer]) {
        if (timer !== undefined) clearTimeout(timer);
      }
      timeoutTimer = undefined;
      killTimer = undefined;
      forceTimer = undefined;
    }

    function succeed(code: number | null): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(
        Object.freeze({
          code,
          stdout: stdoutBuf.toString(),
          stderr: stderrBuf.toString(),
          timedOut,
        }),
      );
    }

    function fail(error: GitError): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    child.stdout?.on('data', (chunk: unknown) => {
      stdoutBuf.push(asBuffer(chunk));
    });
    child.stderr?.on('data', (chunk: unknown) => {
      stderrBuf.push(asBuffer(chunk));
    });

    child.on('error', (error: Error) => {
      fail(gitSpawnError(error, cwd, argv));
    });

    child.on('close', (code) => {
      succeed(code);
    });

    timeoutTimer = setTimeout(() => {
      // Recorded before the kill, because the kill makes `close` fire and settle the promise
      // with whatever bytes arrived. Without this flag that fragment is indistinguishable from
      // a complete result, and a truncated diff would be reviewed as if it were the whole change.
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone. close will settle us.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Same: ESRCH is fine.
        }
        forceTimer = setTimeout(() => {
          fail(
            new GitError(`git timed out after ${GIT_TIMEOUT_MS}ms.`, {
              cwd,
              argv,
              remedy: 'Retry, or pass a narrower cwd so git has less to scan.',
            }),
          );
        }, FORCE_RESOLVE_GRACE_MS);
      }, SIGKILL_GRACE_MS);
    }, GIT_TIMEOUT_MS);
  });
}

function gitChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_GIT_VARS.has(key)) continue;
    env[key] = value;
  }
  env['GIT_TERMINAL_PROMPT'] = '0';
  return env;
}

function gitSpawnError(error: unknown, cwd: string, argv: readonly string[]): GitError {
  if (errorCode(error) === 'ENOENT') {
    return new GitError('git was not found on PATH.', {
      remedy: 'Install git and ensure it is on PATH.',
      cwd,
      argv,
      cause: error,
    });
  }
  return new GitError('Failed to start git.', {
    cwd,
    argv,
    cause: error,
  });
}

function createCappedBuffer(maxBytes: number): {
  push: (chunk: Buffer) => void;
  toString: () => string;
} {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  function push(chunk: Buffer): void {
    if (truncated) return;
    const remaining = maxBytes - size;
    if (chunk.byteLength <= remaining) {
      chunks.push(chunk);
      size += chunk.byteLength;
      return;
    }
    if (remaining > 0) {
      chunks.push(chunk.subarray(0, remaining));
      size += remaining;
    }
    truncated = true;
    chunks.push(
      Buffer.from(`\n[output truncated at ${maxBytes} bytes by grok-build-mcp-server]\n`),
    );
  }

  return {
    push,
    toString: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.alloc(0);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}
