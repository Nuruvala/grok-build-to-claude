/**
 * Review prompt construction. Pure and deterministic: identical params produce
 * byte-identical output. The diff is embedded so the model does not burn turns
 * rediscovering it — that is the entire reason we collect it in-process.
 */

import { REVIEW_FINDINGS_SCHEMA } from './schema.js';

export interface ReviewPromptParams {
  readonly targetDescription: string;
  /** Already truncated. This module does not cap. */
  readonly diff: string;
  readonly truncationNotice: string | null;
  readonly instructions?: string | undefined;
  readonly structured: boolean;
  /** Repo-side header from collectDiff (branch, commit log, untracked-file cap). */
  readonly context?: string | undefined;
}

export function buildReviewPrompt(params: ReviewPromptParams): string {
  const fence = fenceFor(params.diff);
  const parts: string[] = [
    `You are reviewing: ${params.targetDescription}.`,
    'The diff to review is provided below. Review this exact content; do not rediscover it with git or other tools.',
  ];

  // Immediately before the fence so a cap notice is not buried after the diff.
  if (presentContext(params.context)) {
    parts.push(`Context for this target:\n${params.context}`);
  }

  parts.push(
    `${fence}diff\n${params.diff}\n${fence}`,
    params.structured ? structuredInstructions() : proseInstructions(),
  );

  if (present(params.instructions)) {
    parts.push('Additional instructions from the caller:', params.instructions);
  }

  if (params.truncationNotice !== null) {
    parts.push(params.truncationNotice);
  }

  return parts.join('\n\n');
}

function structuredInstructions(): string {
  return [
    'Every message you emit must be a single JSON object matching the schema below, and nothing else. Do not wrap it in a markdown fence.',
    'While you are still gathering context, emit exactly {"status":"working","findings":[]}. Never describe your own progress as a finding — a finding is a defect in the diff under review, never a note about what you are reading.',
    'Emit "status":"final" exactly once, as your last message, carrying the complete findings list and a verdict.',
    REVIEW_FINDINGS_SCHEMA,
  ].join('\n\n');
}

function proseInstructions(): string {
  return [
    'Write the review in prose, grouped by severity in this order: critical, high, medium, low, info.',
    'For each finding, name the file, the line when known, a short summary, and the rationale.',
    'If there are no findings, say so and give a brief verdict.',
  ].join(' ');
}

/**
 * A fence longer than the longest backtick run inside the diff, per the CommonMark rule.
 *
 * Not a hypothetical: a diff of this repo's own Markdown carries plenty of ``` lines, and a
 * fixed three-backtick fence would close the block partway through, leaving the rest of the
 * diff to read as prose the model may follow as instructions.
 */
function fenceFor(diff: string): string {
  let longest = 0;
  for (const run of diff.matchAll(/`+/g)) {
    const length = run[0].length;
    if (length > longest) longest = length;
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

function presentContext(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}
