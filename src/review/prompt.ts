/**
 * Review prompt construction. Pure and deterministic: identical params produce
 * byte-identical output. The diff is embedded so the model does not burn turns
 * rediscovering it — that is the entire reason we collect it in-process.
 */

export interface ReviewPromptParams {
  readonly targetDescription: string;
  /** Already truncated. This module does not cap. */
  readonly diff: string;
  readonly truncationNotice: string | null;
  readonly instructions?: string | undefined;
  readonly structured: boolean;
}

/**
 * Serialized JSON Schema for `--json-schema`. Compact on purpose: this string is
 * both the CLI flag value and the copy embedded in a structured prompt.
 */
export const REVIEW_FINDINGS_SCHEMA: string = JSON.stringify({
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'summary', 'rationale'],
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low', 'info'],
          },
          file: { type: 'string' },
          summary: { type: 'string' },
          rationale: { type: 'string' },
          line: { type: 'integer' },
        },
      },
    },
    verdict: { type: 'string' },
  },
});

export function buildReviewPrompt(params: ReviewPromptParams): string {
  const fence = fenceFor(params.diff);
  const parts: string[] = [
    `You are reviewing: ${params.targetDescription}.`,
    'The diff to review is provided below. Review this exact content; do not rediscover it with git or other tools.',
    `${fence}diff\n${params.diff}\n${fence}`,
    params.structured ? structuredInstructions() : proseInstructions(),
  ];

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
    'Respond with a single JSON object matching the following schema, and nothing else.',
    'Do not wrap the JSON in a markdown fence.',
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
