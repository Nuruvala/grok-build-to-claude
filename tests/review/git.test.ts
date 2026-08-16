import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { GitError } from '../../src/errors.js';
import { collectDiff, collectRepoFacts } from '../../src/review/git.js';

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

const skip = gitOnPath()
  ? false
  : 'git is not on PATH; the review collector tests need a real git binary';

describe('collectRepoFacts repo shapes', { skip }, () => {
  it('reports an empty repo with no commits as having no HEAD, no upstream, and a clean tree', async () => {
    await withGitRepo(async (repo) => {
      const facts = await collectRepoFacts(repo.cwd);
      assert.equal(facts.hasCommits, false);
      assert.equal(facts.upstreamRef, null);
      assert.equal(facts.commitsAheadOfUpstream, 0);
      assert.equal(facts.isDirty, false);
    });
  });

  it('treats detached HEAD as no upstream rather than a broken repo', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('a.txt', 'a\n');
      await repo.commit('init');
      const checkout = await repo.git(['checkout', '--detach', 'HEAD']);
      assert.equal(checkout.code, 0, checkout.stderr);

      const facts = await collectRepoFacts(repo.cwd);
      assert.equal(facts.hasCommits, true);
      assert.equal(facts.upstreamRef, null);
      assert.equal(facts.commitsAheadOfUpstream, 0);
      assert.equal(facts.isDirty, false);
    });
  });

  it('reports a branch with no upstream as null rather than inventing origin/main', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('a.txt', 'a\n');
      await repo.commit('init');

      const facts = await collectRepoFacts(repo.cwd);
      assert.equal(facts.hasCommits, true);
      assert.equal(facts.upstreamRef, null);
      assert.equal(facts.commitsAheadOfUpstream, 0);
      assert.equal(facts.isDirty, false);
    });
  });

  it('collects facts from a repo that contains a submodule without treating the submodule as a failure', async () => {
    const parent = await createGitRepo();
    const child = await createGitRepo();
    try {
      await child.write('lib.js', 'export {}\n');
      await child.commit('init child');
      await parent.write('README.md', 'parent\n');
      await parent.commit('init parent');
      const added = await parent.git([
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        child.cwd,
        'vendor/child',
      ]);
      assert.equal(added.code, 0, added.stderr);
      await parent.commit('add submodule');

      const facts = await collectRepoFacts(parent.cwd);
      assert.equal(facts.hasCommits, true);
      assert.equal(facts.upstreamRef, null);
      assert.equal(facts.isDirty, false);
    } finally {
      await parent.cleanup();
      await child.cleanup();
    }
  });

  it('counts commits ahead of a configured upstream', async () => {
    const remote = await createGitRepo({ bare: true });
    const repo = await createGitRepo();
    try {
      await repo.write('a.txt', 'a\n');
      await repo.commit('init');
      const addRemote = await repo.git(['remote', 'add', 'origin', remote.cwd]);
      assert.equal(addRemote.code, 0, addRemote.stderr);
      const pushed = await repo.git(['push', '-u', 'origin', 'main']);
      assert.equal(pushed.code, 0, pushed.stderr);

      const atUpstream = await collectRepoFacts(repo.cwd);
      assert.equal(atUpstream.upstreamRef, 'origin/main');
      assert.equal(atUpstream.commitsAheadOfUpstream, 0);

      await repo.write('b.txt', 'b\n');
      await repo.commit('ahead');
      const ahead = await collectRepoFacts(repo.cwd);
      assert.equal(ahead.upstreamRef, 'origin/main');
      assert.equal(ahead.commitsAheadOfUpstream, 1);
    } finally {
      await repo.cleanup();
      await remote.cleanup();
    }
  });

  it('marks a tree dirty when an untracked file is present, including in a repo with no commits', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('loose.txt', 'x\n');
      const facts = await collectRepoFacts(repo.cwd);
      assert.equal(facts.hasCommits, false);
      assert.equal(facts.isDirty, true);
    });
  });
});

describe('collectDiff uncommitted', { skip }, () => {
  it('includes an untracked file in the uncommitted diff, because git diff HEAD does not', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('tracked.txt', 'committed\n');
      await repo.commit('init');
      await repo.write('untracked.txt', 'hello from untracked\n');

      const collection = await collectDiff(repo.cwd, { kind: 'uncommitted' });
      assert.match(collection.diff, /untracked\.txt/);
      assert.match(collection.diff, /hello from untracked/);
      assert.ok(collection.files.includes('untracked.txt'));
      assert.equal(collection.context, 'main');
    });
  });

  it('skips an untracked binary file so its bytes are never embedded in the diff', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('note.txt', 'visible text\n');
      await repo.write('secret.bin', Buffer.from([0x00, 0x01, 0xff, 0x00, 0x10, 0x20]));

      const collection = await collectDiff(repo.cwd, { kind: 'uncommitted' });
      assert.match(collection.diff, /note\.txt/);
      assert.match(collection.diff, /visible text/);
      assert.ok(!collection.diff.includes('secret.bin'), collection.diff);
      assert.ok(!collection.diff.includes('\0'));
      assert.ok(!collection.files.includes('secret.bin'));
      assert.ok(collection.files.includes('note.txt'));
    });
  });

  it('falls back to the empty tree in a repo with no commits so untracked files are still reviewable', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('first.txt', 'only file\n');
      const collection = await collectDiff(repo.cwd, { kind: 'uncommitted' });
      assert.match(collection.diff, /first\.txt/);
      assert.match(collection.diff, /only file/);
      assert.ok(collection.files.includes('first.txt'));
      assert.equal(collection.context, 'main');
    });
  });

  it('does not dump a nested git repo into the uncommitted diff when a submodule is present', async () => {
    const parent = await createGitRepo();
    const child = await createGitRepo();
    try {
      await child.write('lib.js', 'export const SECRET = "submodule-body";\n');
      await child.commit('init child');
      await parent.write('README.md', 'parent\n');
      await parent.commit('init parent');
      const added = await parent.git([
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        child.cwd,
        'vendor/child',
      ]);
      assert.equal(added.code, 0, added.stderr);
      await parent.commit('add submodule');
      await parent.write('extra.txt', 'parent-only change\n');

      const collection = await collectDiff(parent.cwd, { kind: 'uncommitted' });
      assert.match(collection.diff, /extra\.txt/);
      assert.ok(!collection.diff.includes('submodule-body'), collection.diff);
    } finally {
      await parent.cleanup();
      await child.cleanup();
    }
  });
});

describe('collectDiff commit', { skip }, () => {
  it('reviews a root commit by sha by diffing against the empty tree, because there is no parent', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('root.txt', 'first bytes\n');
      const sha = await repo.commit('initial root commit');

      const collection = await collectDiff(repo.cwd, { kind: 'commit', sha });
      assert.match(collection.diff, /root\.txt/);
      assert.match(collection.diff, /first bytes/);
      assert.ok(collection.files.includes('root.txt'));
      assert.match(collection.context, /initial root commit/);
    });
  });
});

describe('collectDiff base', { skip }, () => {
  it('uses a merge-base diff so commits added to the base after branching are excluded', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('shared.txt', 'shared\n');
      await repo.commit('A: initial');
      const branched = await repo.git(['checkout', '-b', 'feature']);
      assert.equal(branched.code, 0, branched.stderr);
      await repo.write('feature.txt', 'only on feature\n');
      await repo.commit('C: feature work');
      const back = await repo.git(['checkout', 'main']);
      assert.equal(back.code, 0, back.stderr);
      await repo.write('later-on-main.txt', 'landed on main after the branch\n');
      await repo.commit('D: later main');
      const ontoFeature = await repo.git(['checkout', 'feature']);
      assert.equal(ontoFeature.code, 0, ontoFeature.stderr);

      const collection = await collectDiff(repo.cwd, { kind: 'base', ref: 'main' });
      assert.match(collection.diff, /feature\.txt/);
      assert.match(collection.diff, /only on feature/);
      assert.ok(collection.files.includes('feature.txt'));
      assert.ok(
        !collection.diff.includes('later-on-main'),
        `merge-base diff must not include later base commits:\n${collection.diff}`,
      );
      assert.ok(!collection.files.includes('later-on-main.txt'));
      assert.match(collection.context, /C: feature work/);
      assert.doesNotMatch(collection.context, /D: later main/);
    });
  });
});

describe('collectRepoFacts / collectDiff errors', { skip }, () => {
  it('throws GitError carrying stderr when the directory is not a repo, rather than a raw rejection', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-not-git-'));
    try {
      await assert.rejects(
        () => collectRepoFacts(dir),
        (error: unknown) => {
          assert.ok(error instanceof GitError);
          assert.equal(error.kind, 'git-failed');
          assert.match(error.message, /not a git working tree/i);
          assert.match(error.message, /fatal:/i);
          return true;
        },
      );
      await assert.rejects(
        () => collectDiff(dir, { kind: 'uncommitted' }),
        (error: unknown) => error instanceof GitError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws GitError when a base ref does not resolve, naming the ref so the caller can fix it', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('a.txt', 'a\n');
      await repo.commit('init');
      await assert.rejects(
        () => collectDiff(repo.cwd, { kind: 'base', ref: 'does-not-exist' }),
        (error: unknown) => {
          assert.ok(error instanceof GitError);
          assert.match(error.message, /does-not-exist/);
          assert.match(error.remedy ?? '', /does-not-exist/);
          return true;
        },
      );
    });
  });
});

describe('collectDiff untracked-file edge cases', { skip }, () => {
  it('includes an untracked file whose name is not ASCII', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('seed.txt', 'seed\n');
      await repo.commit('seed');
      await repo.write('café.txt', 'accented name\n');

      const collection = await collectDiff(repo.cwd, { kind: 'uncommitted' });

      // git C-quotes non-ASCII paths in plain `--porcelain` output ("caf\303\251.txt").
      // A half-decoded name fails to stat and the file disappears from the review in
      // silence, which is why the collector asks for `-z`.
      assert.ok(
        collection.files.includes('café.txt'),
        `café.txt missing from ${JSON.stringify(collection.files)}`,
      );
      assert.ok(collection.diff.includes('accented name'));
    });
  });

  it('keeps a text file that merely mentions the binary marker', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('seed.txt', 'seed\n');
      await repo.commit('seed');
      // An unanchored substring test would classify this readable source as binary and drop
      // it. A file about diffing is exactly the kind that talks about binary files.
      await repo.write('notes.md', 'When Binary files differ git says so.\n');

      const collection = await collectDiff(repo.cwd, { kind: 'uncommitted' });

      assert.ok(collection.files.includes('notes.md'));
      assert.ok(collection.diff.includes('When Binary files differ'));
    });
  });

  it('skips an untracked binary file', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('seed.txt', 'seed\n');
      await repo.commit('seed');
      await repo.write('blob.bin', new Uint8Array([0, 1, 2, 0, 255, 0]));

      const collection = await collectDiff(repo.cwd, { kind: 'uncommitted' });

      assert.ok(!collection.files.includes('blob.bin'));
    });
  });

  it('caps how many untracked files it will expand, so one unignored directory cannot stall a review', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('seed.txt', 'seed\n');
      await repo.commit('seed');
      // git reports this whole tree as a single `?? generated/` record, so the cap has to
      // apply during expansion — every expanded file costs its own sequential git spawn.
      for (let i = 0; i < 130; i += 1) {
        await repo.write(`generated/file-${i}.txt`, `content ${i}\n`);
      }

      const collection = await collectDiff(repo.cwd, { kind: 'uncommitted' });

      const untracked = collection.files.filter((file) => file.startsWith('generated/'));
      assert.strictEqual(untracked.length, 100, 'expansion must stop at the cap');
      assert.match(collection.context, /only the first 100 untracked files/);
    });
  });
});

describe('collectDiff honours gitignore inside an untracked directory', { skip }, () => {
  it('excludes ignored files nested under an untracked directory', async () => {
    await withGitRepo(async (repo) => {
      await repo.write('.gitignore', 'node_modules/\n*.log\n');
      await repo.commit('ignore rules');
      // git collapses this whole tree into a single `?? pkg/` status record. A hand-rolled walk
      // over that record knows nothing about .gitignore, so it embeds the vendor tree — and the
      // untracked cap then spends itself on dependencies instead of the source under review.
      await repo.write('pkg/src/a.js', 'export const a = 1;\n');
      await repo.write('pkg/node_modules/dep/index.js', 'module.exports = 0;\n');
      await repo.write('pkg/debug.log', 'noise\n');

      const collection = await collectDiff(repo.cwd, { kind: 'uncommitted' });

      assert.ok(collection.files.includes('pkg/src/a.js'), 'source must be reviewed');
      assert.ok(
        !collection.files.some((file) => file.includes('node_modules')),
        `ignored vendor files leaked in: ${JSON.stringify(collection.files)}`,
      );
      assert.ok(!collection.files.includes('pkg/debug.log'), 'ignored log leaked in');
      assert.ok(!collection.diff.includes('module.exports = 0;'));
    });
  });
});
