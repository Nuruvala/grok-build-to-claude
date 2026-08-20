/**
 * `review` — code review of a git target.
 *
 * Collects the diff in-process so the model does not spend turns rediscovering
 * it. Permission is forced to read-only regardless of the configured ceiling:
 * this tool exposes no permission argument, so there is nothing to reject.
 */

import { z } from 'zod';

import { InvalidArgumentsError } from '../../errors.js';
import { buildGrokArgs } from '../../grok/args.js';
import { withPromptDelivery } from '../../grok/prompt-file.js';
import type { GrokRunResult } from '../../grok/result.js';
import { startBackgroundRun } from '../../jobs/spawn.js';
import { ARGV_PATH_MAX, ARGV_TOKEN_MAX } from '../../limits.js';
import { permissionFlags } from '../../permission.js';
import { truncateDiff } from '../../review/diff.js';
import type { TruncatedDiff } from '../../review/diff.js';
import { extractFindings } from '../../review/findings.js';
import type { ReviewFindings } from '../../review/findings.js';
import { collectDiff, collectRepoFacts } from '../../review/git.js';
import { buildReviewPrompt } from '../../review/prompt.js';
import { REVIEW_FINDINGS_SCHEMA } from '../../review/schema.js';
import {
  autoSelectTarget,
  describeInputTarget,
  describeTarget,
  isSafeGitRef,
  reviewTargetConflicts,
  selectReviewTarget,
} from '../../review/target.js';
import type { ReviewTarget } from '../../review/target.js';
import { defineTool } from '../../types.js';
import type { ToolContext, ToolResult } from '../../types.js';
import { assertUsableCwd, isUsableCwdShape } from '../cwd.js';
import { runGrok } from '../run.js';
import type { GrokRunMeta } from '../run.js';

/** Embedded-diff budget. Larger diffs get a truncation notice instead of a silent cut. */
const REVIEW_DIFF_BYTE_CAP = 256 * 1024;

/**
 * Tools a reviewer must not use. Plan mode looks like it already forbids
 * these, but in headless mode a permission *prompt* is fatal: the CLI records
 * `permission_cancelled` and exits 0, and the model never gets to recover.
 * An explicit `--deny` is recoverable — the model sees a policy refusal and
 * continues. Verified against grok 1.0.4 on 2026-08-17. Do not "simplify"
 * this away because plan + read-only sandbox already appear to cover it.
 */
const REVIEW_DENY_RULES: readonly string[] = Object.freeze(['Bash(*)', 'Edit(*)', 'Write(*)']);

/**
 * Ceiling on paths listed in `_meta.files`.
 *
 * `_meta` lands in the caller's context window. A wide branch diff can touch four figures of
 * files, and an uncapped list would cost more context than the review it describes.
 */
const META_FILE_CAP = 200;

const ReviewInput = z
  .strictObject({
    // Same `.min(1)` reasoning as the `grok` tool: the argv builder drops an empty
    // `--cwd`, so `""` would silently review whatever directory the server lives in.
    cwd: z
      .string()
      .min(1)
      .max(ARGV_PATH_MAX)
      .refine(isUsableCwdShape, { message: 'An absolute path is required.' })
      .optional()
      .describe('Absolute path. Repository to review. Defaults to the current working directory.'),
    base: z
      .string()
      .min(1)
      .max(ARGV_TOKEN_MAX)
      .refine(isSafeGitRef, {
        message: 'A ref may not start with "-" because git would read it as an option.',
      })
      .optional()
      .describe(
        'Review the merge-base diff against this ref. Mutually exclusive with commit and uncommitted.',
      ),
    commit: z
      .string()
      .min(1)
      .max(ARGV_TOKEN_MAX)
      .refine(isSafeGitRef, {
        message: 'A ref may not start with "-" because git would read it as an option.',
      })
      .optional()
      .describe('Review this commit. Mutually exclusive with base and uncommitted.'),
    uncommitted: z
      .boolean()
      .optional()
      .describe(
        'Review the working tree (staged, unstaged, and untracked). Mutually exclusive with base and commit. `false` is not a request.',
      ),
    instructions: z
      .string()
      .optional()
      .describe('Extra reviewer guidance, appended verbatim to the prompt.'),
    structured: z
      .boolean()
      .optional()
      .describe(
        'Return machine-readable findings via `--json-schema`. A run that stops before a final findings object fails the call with reviewIncomplete. Malformed model JSON after a normal stop degrades to raw text plus a parseError field rather than failing the call. `false` is not a request.',
      ),
    model: z
      .string()
      .max(ARGV_TOKEN_MAX)
      .optional()
      .describe(
        'Model id to pass as `--model`. Omit to use the server default. Unknown ids are rejected by the CLI, not by this server.',
      ),
    effort: z
      .string()
      .max(ARGV_TOKEN_MAX)
      .optional()
      .describe(
        'Reasoning effort passed as `--effort`. Omit to use the server default. Values are passed through; the CLI rejects what the model does not advertise.',
      ),
    maxTurns: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Maximum agentic turns. Passed as `--max-turns`. Headless only.'),
    background: z
      .boolean()
      .optional()
      .describe(
        'Run detached and return a runId immediately instead of waiting. Poll with the `status` tool. ' +
          'The run survives a restart of this MCP server. `false` is not a request.',
      ),
  })
  .describe('Code review of a git target.')
  .meta({ title: 'ReviewInput' });

type ReviewInput = z.output<typeof ReviewInput>;

export const reviewTool = defineTool({
  name: 'review',
  title: 'Review a git diff',
  description:
    'Review a git diff with Grok Build. Targets the working tree (`uncommitted`), a merge-base ' +
    'diff against `base`, or a single `commit`. When none is specified, auto-detects: the ' +
    'upstream diff if the branch is ahead, otherwise the working tree. Always runs read-only ' +
    '(`--permission-mode plan --sandbox read-only`) regardless of GROK_MCP_PERMISSION_CEILING — ' +
    'this tool has no permission, write, or yolo argument, because a review that edits the ' +
    'code it is reviewing is never wanted. Set `structured: true` for machine-readable findings.',
  schema: ReviewInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (input: ReviewInput, ctx: ToolContext): Promise<ToolResult> => {
    await assertUsableCwd(input.cwd, 'review');

    const conflicts = reviewTargetConflicts(input);
    if (conflicts.length > 0) {
      throw new InvalidArgumentsError('review', conflicts);
    }

    if (input.background === true) {
      return startBackgroundRun(
        {
          tool: 'review',
          input: { ...input },
          summary: `review ${describeInputTarget(input)}`,
          cwd: input.cwd ?? process.cwd(),
        },
        ctx,
      );
    }

    const repoDir = input.cwd ?? process.cwd();
    const { target, excluded } = await resolveReviewTarget(input, repoDir);
    const collection = await collectDiff(repoDir, target);
    const targetDescription = describeTarget(target);

    if (collection.diff.trim() === '') {
      return emptyDiffResult(target.kind, targetDescription, collection.files, excluded);
    }

    const truncated = truncateDiff(collection.diff, REVIEW_DIFF_BYTE_CAP);
    const structured = input.structured === true;
    const prompt = buildReviewPrompt({
      targetDescription,
      diff: truncated.text,
      truncationNotice: truncationNotice(truncated),
      instructions: input.instructions,
      structured,
      context: collection.context,
    });

    const model = input.model ?? ctx.config.defaultModel;
    const effort = input.effort ?? ctx.config.defaultEffort;

    const baseMeta = reviewBaseMeta(
      target.kind,
      targetDescription,
      collection.files,
      truncated,
      excluded,
    );

    // An embedded diff routinely outgrows what a single argv element can hold, so the prompt may
    // travel as a file. The delivery is scoped: the temp file lives exactly as long as the run.
    return withPromptDelivery(prompt, (delivery) =>
      runGrok(
        {
          args: buildGrokArgs({
            ...delivery,
            outputFormat: ctx.progressRequested ? 'streaming-json' : 'json',
            permission: permissionFlags('read-only'),
            cwd: input.cwd,
            model,
            effort,
            maxTurns: input.maxTurns,
            deny: REVIEW_DENY_RULES,
            jsonSchema: structured ? REVIEW_FINDINGS_SCHEMA : undefined,
          }),
          model,
          permissionLevel: 'read-only',
          meta: structured
            ? structuredReviewMeta(baseMeta, input.maxTurns)
            : proseReviewMeta(baseMeta, input.maxTurns),
          formatText: structured
            ? (result) => formatStructuredReviewText(result, input.maxTurns)
            : (result) => formatProseReviewText(result, input.maxTurns),
          isError: structured
            ? (result) => structuredReviewIsError(result, input.maxTurns)
            : (result) => isCutOff(result.stopReason),
        },
        ctx,
      ),
    );
  },
});

async function resolveReviewTarget(
  input: ReviewInput,
  repoDir: string,
): Promise<{ readonly target: ReviewTarget; readonly excluded: string | null }> {
  const explicit = selectReviewTarget(input);
  if (explicit !== null) {
    return { target: explicit, excluded: null };
  }

  const facts = await collectRepoFacts(repoDir);
  const selected = autoSelectTarget(facts);
  return { target: selected.target, excluded: selected.excluded };
}

function reviewBaseMeta(
  kind: ReviewTarget['kind'],
  targetDescription: string,
  files: readonly string[],
  truncated: TruncatedDiff,
  excluded: string | null,
): Readonly<Record<string, unknown>> {
  const meta: Record<string, unknown> = {
    target: kind,
    targetDescription,
    ...fileMeta(files),
    diffTruncated: truncated.truncated,
  };
  if (excluded !== null) {
    meta['excluded'] = excluded;
  }
  return Object.freeze(meta);
}

/**
 * `files`, capped, plus the honest total. Reporting a trimmed list as if it were the whole thing
 * would understate the size of what was reviewed.
 */
function fileMeta(files: readonly string[]): Readonly<Record<string, unknown>> {
  if (files.length <= META_FILE_CAP) {
    return { files, fileCount: files.length };
  }
  return {
    files: files.slice(0, META_FILE_CAP),
    fileCount: files.length,
    filesTruncated: true,
  };
}

/**
 * The handler, unlike findings.ts, knows `stopReason`, so it can tell "still
 * working / cut off" from "finished but unreadable".
 *
 * `--json-schema` constrains every assistant message (verified grok 1.0.4,
 * 2026-08-16). A cut-off run therefore ends on a `working` object, or on
 * concatenated per-turn JSON that does not parse as one value. Neither is a
 * review.
 */
type StructuredReviewClass =
  | { readonly kind: 'final'; readonly findings: ReviewFindings }
  | { readonly kind: 'incomplete'; readonly explanation: string }
  | { readonly kind: 'malformed'; readonly parseError: string; readonly explanation: string };

function classifyStructuredReview(
  result: GrokRunResult,
  maxTurns: number | undefined,
): StructuredReviewClass {
  const extraction = extractFindings(result.structuredOutput, result.text);
  switch (extraction.kind) {
    case 'final':
      return { kind: 'final', findings: extraction.findings };
    case 'working':
      return {
        kind: 'incomplete',
        explanation: incompleteReviewExplanation(result, maxTurns, STRUCTURED_CUT_OFF_CLAUSE),
      };
    case 'invalid':
      if (isCutOff(result.stopReason)) {
        return {
          kind: 'incomplete',
          explanation: incompleteReviewExplanation(result, maxTurns, STRUCTURED_CUT_OFF_CLAUSE),
        };
      }
      return {
        kind: 'malformed',
        parseError: extraction.parseError,
        explanation: malformedReviewExplanation(extraction.parseError),
      };
    default: {
      const unreachable: never = extraction;
      throw new Error(`unhandled findings extraction: ${String(unreachable)}`);
    }
  }
}

function structuredReviewMeta(
  base: Readonly<Record<string, unknown>>,
  maxTurns: number | undefined,
): GrokRunMeta {
  return (result) => {
    const classified = classifyStructuredReview(result, maxTurns);
    switch (classified.kind) {
      case 'final':
        return { ...base, findings: classified.findings, findingsComplete: true };
      case 'incomplete':
        return {
          ...base,
          findingsComplete: false,
          reviewIncomplete: classified.explanation,
          ...structuredOutputErrorMeta(result),
        };
      case 'malformed':
        return {
          ...base,
          findingsComplete: false,
          parseError: classified.parseError,
          ...structuredOutputErrorMeta(result),
        };
      default: {
        const unreachable: never = classified;
        throw new Error(`unhandled structured review class: ${String(unreachable)}`);
      }
    }
  };
}

function formatStructuredReviewText(result: GrokRunResult, maxTurns: number | undefined): string {
  const classified = classifyStructuredReview(result, maxTurns);
  switch (classified.kind) {
    case 'final':
      return JSON.stringify(classified.findings, null, 2);
    case 'incomplete':
    case 'malformed':
      return `${classified.explanation}\n\n${result.text}`;
    default: {
      const unreachable: never = classified;
      throw new Error(`unhandled structured review class: ${String(unreachable)}`);
    }
  }
}

function structuredReviewIsError(result: GrokRunResult, maxTurns: number | undefined): boolean {
  return classifyStructuredReview(result, maxTurns).kind === 'incomplete';
}

/**
 * Cut-off clause for structured mode. Kept as a named constant so the
 * explanation stays byte-identical to the wording the structured tests pin.
 */
const STRUCTURED_CUT_OFF_CLAUSE =
  'before emitting its final findings, so nothing below is a completed review.';

/**
 * Cut-off clause for prose mode. Same shared prefix/suffix as structured, but
 * no mention of findings objects — those were never requested.
 */
const PROSE_CUT_OFF_CLAUSE =
  'before producing a completed review, so nothing below is a finished review.';

function proseReviewMeta(
  base: Readonly<Record<string, unknown>>,
  maxTurns: number | undefined,
): GrokRunMeta {
  return (result) => {
    if (!isCutOff(result.stopReason)) return base;
    return {
      ...base,
      // `findingsComplete` is a structured-mode key. Inventing it here would
      // claim a findings object was requested.
      reviewIncomplete: incompleteReviewExplanation(result, maxTurns, PROSE_CUT_OFF_CLAUSE),
    };
  };
}

function formatProseReviewText(result: GrokRunResult, maxTurns: number | undefined): string {
  if (!isCutOff(result.stopReason)) return result.text;
  return `${incompleteReviewExplanation(result, maxTurns, PROSE_CUT_OFF_CLAUSE)}\n\n${result.text}`;
}

/** Surface the CLI's own reason so a caller does not have to parse our prose. */
function structuredOutputErrorMeta(result: GrokRunResult): Readonly<Record<string, unknown>> {
  return result.structuredOutputError === null
    ? {}
    : { structuredOutputError: result.structuredOutputError };
}

/**
 * `null` is a normal finish: the CLI omitted the field, it did not abort.
 * Anything other than `end_turn` (max-turns, cancel, timeout) is a cut-off.
 */
function isCutOff(stopReason: string | null): boolean {
  return stopReason !== null && stopReason !== 'end_turn';
}

/**
 * Shared cut-off / incomplete diagnosis. `cutOffClause` is the mode-specific
 * middle so prose mode does not talk about findings objects. The finished-
 * normally branch is structured-only (a prose `end_turn` is a completed
 * review) and keeps its previous wording byte-identical.
 */
function incompleteReviewExplanation(
  result: GrokRunResult,
  maxTurns: number | undefined,
  cutOffClause: string,
): string {
  const stopReason = result.stopReason ?? 'unknown';
  const turns = result.numTurns === null ? '' : ` after ${String(result.numTurns)} turns`;
  const cliReported = structuredOutputErrorSentence(result.structuredOutputError);
  if (isCutOff(result.stopReason)) {
    if (maxTurns !== undefined) {
      return (
        `The run stopped with stopReason "${stopReason}"${turns} (maxTurns ${String(maxTurns)}) ` +
        `${cutOffClause}${cliReported} ` +
        `A set maxTurns is one possible cause, not a confirmed one (cancelled does not imply a turn cap). ` +
        `Raise maxTurns above ${String(maxTurns)} only if the run was still working; otherwise inspect the run record.`
      );
    }
    return (
      `The run stopped with stopReason "${stopReason}"${turns} ${cutOffClause}` +
      `${cliReported} ` +
      'No maxTurns limit was set, so the turn budget was not the cause. ' +
      'The stop reason alone does not say whether a tool call was refused or the model stopped short. ' +
      'Retry, or inspect the run record.'
    );
  }
  return (
    `The run finished normally (stopReason "${stopReason}"${turns}) but the model never emitted ` +
    `its final findings object, so nothing below is a completed review.${cliReported} Retry the review; ` +
    'raising maxTurns will not help.'
  );
}

function structuredOutputErrorSentence(error: string | null): string {
  if (error === null) return '';
  return ` The CLI reported: ${JSON.stringify(error)}.`;
}

function malformedReviewExplanation(parseError: string): string {
  return (
    `The model produced output we cannot validate (${parseError}). ` +
    'The text below is the raw response.'
  );
}

function truncationNotice(truncated: TruncatedDiff): string | null {
  if (!truncated.truncated) return null;
  const omitted = truncated.omittedFiles;
  const fileBit =
    omitted.length === 0
      ? ''
      : omitted.length === 1
        ? ` Omitted file: ${omitted[0]}.`
        : ` Omitted files: ${omitted.join(', ')}.`;
  return `The diff was truncated; ${truncated.omittedBytes} bytes were omitted.${fileBit}`;
}

function emptyDiffResult(
  kind: ReviewTarget['kind'],
  targetDescription: string,
  files: readonly string[],
  excluded: string | null,
): ToolResult {
  const meta: Record<string, unknown> = {
    target: kind,
    targetDescription,
    ...fileMeta(files),
    diffTruncated: false,
  };
  if (excluded !== null) {
    meta['excluded'] = excluded;
  }

  return {
    content: [
      {
        type: 'text',
        text: `Nothing to review: ${targetDescription} has no changes.`,
        _meta: Object.freeze(meta),
      },
    ],
    isError: false,
  };
}
