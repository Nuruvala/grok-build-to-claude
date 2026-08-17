import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  autoSelectTarget,
  describeInputTarget,
  describeTarget,
  reviewTargetConflicts,
  selectReviewTarget,
} from '../../src/review/target.js';
import type { RepoFacts, ReviewTarget } from '../../src/review/target.js';

describe('reviewTargetConflicts', () => {
  it('reports no conflicts when nothing is requested, including uncommitted: false, because false is not a request', () => {
    assert.deepEqual(reviewTargetConflicts({}), []);
    assert.deepEqual(reviewTargetConflicts({ uncommitted: false }), []);
    assert.deepEqual(reviewTargetConflicts({ uncommitted: undefined }), []);
    assert.deepEqual(reviewTargetConflicts({ base: undefined, commit: undefined }), []);
  });

  it('reports no conflicts when exactly one target is requested', () => {
    assert.deepEqual(reviewTargetConflicts({ base: 'origin/main' }), []);
    assert.deepEqual(reviewTargetConflicts({ commit: 'abc1234' }), []);
    assert.deepEqual(reviewTargetConflicts({ uncommitted: true }), []);
  });

  it('treats an empty-string base or commit as not a request, so it cannot conflict', () => {
    assert.deepEqual(reviewTargetConflicts({ base: '', commit: 'abc1234' }), []);
    assert.deepEqual(reviewTargetConflicts({ base: 'main', commit: '' }), []);
    assert.deepEqual(reviewTargetConflicts({ base: '', uncommitted: true }), []);
    assert.deepEqual(reviewTargetConflicts({ commit: '', uncommitted: true }), []);
  });

  const pairs: readonly {
    label: string;
    input: { base?: string; commit?: string; uncommitted?: boolean };
    names: readonly string[];
  }[] = [
    {
      label: 'base and commit',
      input: { base: 'origin/main', commit: 'abc1234' },
      names: ['base', 'commit'],
    },
    {
      label: 'base and uncommitted',
      input: { base: 'origin/main', uncommitted: true },
      names: ['base', 'uncommitted'],
    },
    {
      label: 'commit and uncommitted',
      input: { commit: 'abc1234', uncommitted: true },
      names: ['commit', 'uncommitted'],
    },
  ];

  for (const { label, input, names } of pairs) {
    it(`rejects ${label}, because a review cannot have two targets`, () => {
      const issues = reviewTargetConflicts(input);
      assert.equal(issues.length, 1);
      const [issue] = issues;
      assert.ok(issue, 'expected a conflict message');
      for (const name of names) {
        assert.match(issue, new RegExp(name));
      }
      assert.match(issue, /Pass one of base, commit, or uncommitted/);
    });
  }

  it('reports every pairwise conflict when all three are set at once', () => {
    const issues = reviewTargetConflicts({
      base: 'origin/main',
      commit: 'abc1234',
      uncommitted: true,
    });
    assert.equal(issues.length, 3);
    assert.ok(issues.some((issue) => issue.includes('base') && issue.includes('commit')));
    assert.ok(issues.some((issue) => issue.includes('base') && issue.includes('uncommitted')));
    assert.ok(issues.some((issue) => issue.includes('commit') && issue.includes('uncommitted')));
  });

  it('does not treat uncommitted: false as a partner for a conflict', () => {
    assert.deepEqual(reviewTargetConflicts({ base: 'main', uncommitted: false }), []);
    assert.deepEqual(reviewTargetConflicts({ commit: 'abc', uncommitted: false }), []);
  });
});

describe('selectReviewTarget', () => {
  it('returns null when nothing explicit was requested, so auto-detect runs downstream', () => {
    assert.equal(selectReviewTarget({}), null);
    assert.equal(selectReviewTarget({ base: undefined, commit: undefined }), null);
  });

  it('returns null for uncommitted: false, because a JSON-schema false is not a request', () => {
    assert.equal(selectReviewTarget({ uncommitted: false }), null);
  });

  it('returns null for an empty-string base or commit, because an empty value is not a request', () => {
    assert.equal(selectReviewTarget({ base: '' }), null);
    assert.equal(selectReviewTarget({ commit: '' }), null);
  });

  it('selects the working tree when uncommitted is true', () => {
    assert.deepEqual(selectReviewTarget({ uncommitted: true }), { kind: 'uncommitted' });
  });

  it('selects a base ref when only base is set', () => {
    assert.deepEqual(selectReviewTarget({ base: 'origin/main' }), {
      kind: 'base',
      ref: 'origin/main',
    });
  });

  it('selects a commit when only commit is set', () => {
    assert.deepEqual(selectReviewTarget({ commit: 'abc1234' }), {
      kind: 'commit',
      sha: 'abc1234',
    });
  });

  it('still selects base when uncommitted is false, because false does not cancel a real request', () => {
    assert.deepEqual(selectReviewTarget({ base: 'main', uncommitted: false }), {
      kind: 'base',
      ref: 'main',
    });
  });

  it('still selects commit when uncommitted is false', () => {
    assert.deepEqual(selectReviewTarget({ commit: 'deadbeef', uncommitted: false }), {
      kind: 'commit',
      sha: 'deadbeef',
    });
  });

  it('freezes the selected target so a later caller cannot rewrite it', () => {
    const target = selectReviewTarget({ uncommitted: true });
    assert.ok(target);
    assert.ok(Object.isFrozen(target));
  });
});

describe('autoSelectTarget', () => {
  const clean: RepoFacts = {
    hasCommits: true,
    upstreamRef: 'origin/main',
    commitsAheadOfUpstream: 0,
    isDirty: false,
  };

  it('selects the working tree when the repo has no commits yet, even if other facts look like a branch', () => {
    const selected = autoSelectTarget({
      hasCommits: false,
      upstreamRef: 'origin/main',
      commitsAheadOfUpstream: 3,
      isDirty: true,
    });
    assert.deepEqual(selected.target, { kind: 'uncommitted' });
    assert.equal(selected.excluded, null);
    assert.match(selected.reason, /no commits/);
  });

  it('selects the upstream base when the branch is ahead and the tree is clean', () => {
    const selected = autoSelectTarget({
      ...clean,
      commitsAheadOfUpstream: 2,
    });
    assert.deepEqual(selected.target, { kind: 'base', ref: 'origin/main' });
    assert.equal(selected.excluded, null);
    assert.match(selected.reason, /ahead of origin\/main/);
  });

  it('selects the upstream base when the branch is ahead AND dirty, and names the excluded working tree so the review does not silently merge the two', () => {
    const selected = autoSelectTarget({
      ...clean,
      commitsAheadOfUpstream: 1,
      isDirty: true,
    });
    assert.deepEqual(selected.target, { kind: 'base', ref: 'origin/main' });
    assert.ok(selected.excluded);
    assert.match(selected.excluded, /[Uu]ncommitted/);
    assert.match(selected.excluded, /uncommitted: true/);
    assert.match(selected.reason, /ahead of origin\/main/);
  });

  it('selects the working tree when no upstream is configured', () => {
    const selected = autoSelectTarget({
      hasCommits: true,
      upstreamRef: null,
      commitsAheadOfUpstream: 4,
      isDirty: false,
    });
    assert.deepEqual(selected.target, { kind: 'uncommitted' });
    assert.equal(selected.excluded, null);
    assert.match(selected.reason, /[Nn]o upstream/);
  });

  it('selects the working tree when the branch is up to date with its upstream', () => {
    const selected = autoSelectTarget(clean);
    assert.deepEqual(selected.target, { kind: 'uncommitted' });
    assert.equal(selected.excluded, null);
    assert.match(selected.reason, /up to date with origin\/main/);
  });

  it('treats a negative ahead-count as not-ahead, so a diverged-behind fact still reviews the working tree', () => {
    const selected = autoSelectTarget({
      ...clean,
      commitsAheadOfUpstream: -1,
    });
    assert.deepEqual(selected.target, { kind: 'uncommitted' });
    assert.match(selected.reason, /up to date with origin\/main/);
  });

  it('still reports up-to-date (not excluded) when the tree is dirty but the branch is not ahead', () => {
    const selected = autoSelectTarget({ ...clean, isDirty: true });
    assert.deepEqual(selected.target, { kind: 'uncommitted' });
    assert.equal(selected.excluded, null);
    assert.match(selected.reason, /up to date with origin\/main/);
  });

  it('freezes the selection so a later caller cannot rewrite the reason or the target', () => {
    const selected = autoSelectTarget(clean);
    assert.ok(Object.isFrozen(selected));
    assert.ok(Object.isFrozen(selected.target));
  });
});

describe('describeTarget', () => {
  const cases: readonly { target: ReviewTarget; label: string }[] = [
    {
      target: { kind: 'uncommitted' },
      label: 'working tree (staged, unstaged, and untracked)',
    },
    {
      target: { kind: 'base', ref: 'origin/main' },
      label: 'diff against origin/main',
    },
    {
      target: { kind: 'commit', sha: 'abc1234' },
      label: 'commit abc1234',
    },
  ];

  for (const { target, label } of cases) {
    it(`labels ${target.kind} as "${label}"`, () => {
      assert.equal(describeTarget(target), label);
    });
  }

  it('fails closed on an unhandled kind so a new variant cannot silently produce an empty label', () => {
    const target = { kind: 'stash' } as unknown as ReviewTarget;
    assert.throws(() => describeTarget(target), /unhandled review target/);
  });
});

describe('describeInputTarget', () => {
  it('labels the input before the real target is resolved, so a background review has a short name', () => {
    assert.equal(describeInputTarget({ uncommitted: true }), 'uncommitted');
    assert.equal(describeInputTarget({ base: 'origin/main' }), 'base origin/main');
    assert.equal(describeInputTarget({ commit: 'abc1234' }), 'commit abc1234');
    assert.equal(describeInputTarget({}), 'auto target');
    assert.equal(describeInputTarget({ uncommitted: false }), 'auto target');
  });
});
