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
import { permissionFlags } from '../../permission.js';
import { truncateDiff } from '../../review/diff.js';
import type { TruncatedDiff } from '../../review/diff.js';
import { extractFindings } from '../../review/findings.js';
import { collectDiff, collectRepoFacts } from '../../review/git.js';
import { REVIEW_FINDINGS_SCHEMA, buildReviewPrompt } from '../../review/prompt.js';
import {
  autoSelectTarget,
  describeTarget,
  reviewTargetConflicts,
  selectReviewTarget,
} from '../../review/target.js';
import type { ReviewTarget } from '../../review/target.js';
import { defineTool } from '../../types.js';
import type { ToolContext, ToolResult } from '../../types.js';
import { runGrok } from '../run.js';
import type { GrokRunMeta } from '../run.js';

/** Embedded-diff budget. Larger diffs get a truncation notice instead of a silent cut. */
const REVIEW_DIFF_BYTE_CAP = 256 * 1024;

/**
 * Ceiling on paths listed in `_meta.files`.
 *
 * `_meta` lands in the caller's context window. A wide branch diff can touch four figures of
 * files, and an uncapped list would cost more context than the review it describes.
 */
const META_FILE_CAP = 200;

const ReviewInput = z
  .object({
    // Same `.min(1)` reasoning as the `grok` tool: the argv builder drops an empty
    // `--cwd`, so `""` would silently review whatever directory the server lives in.
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe('Repository to review. Defaults to the current working directory.'),
    base: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Review the merge-base diff against this ref. Mutually exclusive with commit and uncommitted.',
      ),
    commit: z
      .string()
      .min(1)
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
        'Return machine-readable findings via `--json-schema`. Malformed model JSON degrades to raw text plus a parseError field rather than failing the call. `false` is not a request.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Model id to pass as `--model`. Omit to use the server default. Unknown ids are rejected by the CLI, not by this server.',
      ),
    effort: z
      .string()
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
    const conflicts = reviewTargetConflicts(input);
    if (conflicts.length > 0) {
      throw new InvalidArgumentsError('review', conflicts);
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
            jsonSchema: structured ? REVIEW_FINDINGS_SCHEMA : undefined,
          }),
          model,
          permissionLevel: 'read-only',
          meta: structured ? structuredReviewMeta(baseMeta) : baseMeta,
          ...(structured ? { formatText: formatStructuredReviewText } : {}),
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

function structuredReviewMeta(base: Readonly<Record<string, unknown>>): GrokRunMeta {
  return (result) => {
    const extraction = extractFindings(result.structuredOutput, result.text);
    if (extraction.kind === 'structured') {
      return { ...base, findings: extraction.findings };
    }
    return { ...base, parseError: explainParseError(extraction.parseError, result) };
  };
}

/**
 * Why the structured findings could not be read.
 *
 * `--json-schema` constrains every assistant message, so a run that took several turns emits one
 * JSON object per turn and `text` is their concatenation — invalid JSON, through no fault of the
 * model. Only a run that reaches `end` carries `structuredOutput`. Reporting a bare
 * "invalid JSON" sends the reader looking for a malformed model response when what actually
 * happened is that the run stopped early, so name the stop reason and the fix.
 */
function explainParseError(parseError: string, result: GrokRunResult): string {
  if (result.stopReason === null || result.stopReason === 'end_turn') {
    return parseError;
  }
  return (
    `${parseError} (the run stopped with stopReason "${result.stopReason}", so it never produced ` +
    'structuredOutput; the text below is the per-turn output concatenated). ' +
    'Narrow the review target or raise maxTurns.'
  );
}

function formatStructuredReviewText(result: GrokRunResult): string {
  const extraction = extractFindings(result.structuredOutput, result.text);
  if (extraction.kind === 'structured') {
    return JSON.stringify(extraction.findings, null, 2);
  }
  return extraction.text;
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
