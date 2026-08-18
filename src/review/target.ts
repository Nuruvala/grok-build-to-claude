/**
 * Review-target selection. Pure: decides which target a review will use; does not run git.
 *
 * Actually collecting the diff is the shell's job. This module only names the target, reports
 * mutually exclusive requests, and auto-detects from facts the shell already gathered.
 */

export type ReviewTarget =
  | { readonly kind: 'uncommitted' }
  | { readonly kind: 'base'; readonly ref: string }
  | { readonly kind: 'commit'; readonly sha: string };

export interface ReviewTargetInput {
  readonly base?: string | undefined;
  readonly commit?: string | undefined;
  readonly uncommitted?: boolean | undefined;
}

export interface RepoFacts {
  readonly hasCommits: boolean;
  readonly upstreamRef: string | null;
  readonly commitsAheadOfUpstream: number;
  readonly isDirty: boolean;
}

export interface AutoSelection {
  readonly target: ReviewTarget;
  /** Non-null when the selection deliberately left something out. */
  readonly excluded: string | null;
  /** Why this target was chosen. Goes into _meta and into the user-visible text. */
  readonly reason: string;
}

/**
 * One human-readable message per conflict. Any two of the three requests set at once is a
 * conflict — a review cannot have two targets, and the caller has to pick.
 */
export function reviewTargetConflicts(input: ReviewTargetInput): string[] {
  const issues: string[] = [];
  const hasBase = requestedString(input.base);
  const hasCommit = requestedString(input.commit);
  const hasUncommitted = input.uncommitted === true;

  if (hasBase && hasCommit) {
    issues.push(
      'base and commit are mutually exclusive. Pass one of base, commit, or uncommitted, not both.',
    );
  }
  if (hasBase && hasUncommitted) {
    issues.push(
      'base and uncommitted are mutually exclusive. Pass one of base, commit, or uncommitted, not both.',
    );
  }
  if (hasCommit && hasUncommitted) {
    issues.push(
      'commit and uncommitted are mutually exclusive. Pass one of base, commit, or uncommitted, not both.',
    );
  }
  return issues;
}

/**
 * The explicit target, or null when nothing was requested (auto-detect downstream).
 * `uncommitted: false` is not a request — a JSON-schema false is indistinguishable from an
 * omitted field, same as `write`/`yolo` in permission.ts.
 */
export function selectReviewTarget(input: ReviewTargetInput): ReviewTarget | null {
  if (input.uncommitted === true) {
    return freezeTarget({ kind: 'uncommitted' });
  }
  if (requestedString(input.base)) {
    return freezeTarget({ kind: 'base', ref: input.base });
  }
  if (requestedString(input.commit)) {
    return freezeTarget({ kind: 'commit', sha: input.commit });
  }
  return null;
}

/**
 * Choose a target from repo facts when the caller did not name one.
 *
 * Ahead-of-upstream wins over a dirty tree on purpose: silently merging the two would
 * misreport what was actually reviewed. The dirty tree is named in `excluded` instead.
 */
export function autoSelectTarget(facts: RepoFacts): AutoSelection {
  if (!facts.hasCommits) {
    return freezeSelection({
      target: freezeTarget({ kind: 'uncommitted' }),
      excluded: null,
      reason: 'The repository has no commits yet, so the review target is the working tree.',
    });
  }

  if (facts.upstreamRef !== null && facts.commitsAheadOfUpstream > 0) {
    const excluded = facts.isDirty
      ? 'Uncommitted changes were not included. Pass uncommitted: true to review the working tree instead.'
      : null;
    return freezeSelection({
      target: freezeTarget({ kind: 'base', ref: facts.upstreamRef }),
      excluded,
      reason: `This branch is ahead of ${facts.upstreamRef}, so the review target is the diff against that upstream.`,
    });
  }

  const reason =
    facts.upstreamRef === null
      ? 'No upstream is configured, so the review target is the working tree.'
      : `The branch is up to date with ${facts.upstreamRef}, so the review target is the working tree.`;

  return freezeSelection({
    target: freezeTarget({ kind: 'uncommitted' }),
    excluded: null,
    reason,
  });
}

/** Pure. False for a ref git would read as an option. */
export function isSafeGitRef(value: string): boolean {
  return !value.startsWith('-');
}

export function describeTarget(target: ReviewTarget): string {
  switch (target.kind) {
    case 'uncommitted':
      return 'working tree (staged, unstaged, and untracked)';
    case 'base':
      return `diff against ${target.ref}`;
    case 'commit':
      return `commit ${target.sha}`;
    default: {
      const unreachable: never = target;
      throw new Error(`unhandled review target: ${String(unreachable)}`);
    }
  }
}

/**
 * A short label from the *input*, used before the real target is resolved
 * (a background review has not run git yet). Distinct from `describeTarget`,
 * which names a resolved `ReviewTarget`.
 */
export function describeInputTarget(input: ReviewTargetInput): string {
  if (input.uncommitted === true) return 'uncommitted';
  if (requestedString(input.base)) return `base ${input.base}`;
  if (requestedString(input.commit)) return `commit ${input.commit}`;
  return 'auto target';
}

function requestedString(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

function freezeTarget(target: ReviewTarget): ReviewTarget {
  return Object.freeze(target);
}

function freezeSelection(selection: AutoSelection): AutoSelection {
  return Object.freeze(selection);
}
