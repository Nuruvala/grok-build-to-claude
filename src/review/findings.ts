/**
 * Extract structured review findings from a grok result.
 *
 * Pure. Never throws. Precedence is the whole point: the CLI's already-decoded
 * `structuredOutput` wins; `text` is only parsed as a whole JSON value; a
 * ```json fence is never stripped and braces are never sliced. A
 * whitespace-separated sequence of several JSON values is also never decoded —
 * those objects are the model's working narration (`status: "working"`), and
 * taking the last one would surface fabricated findings. That scraping is
 * the plugin bug this module exists to not reproduce.
 */

import type { ZodError } from 'zod';

import { ReviewFindingsSchema } from './schema.js';
import type { ReviewFindings } from './schema.js';

export type { ReviewFindings };

export type FindingsExtraction =
  | { readonly kind: 'final'; readonly findings: ReviewFindings }
  | { readonly kind: 'working' }
  | { readonly kind: 'invalid'; readonly text: string; readonly parseError: string };

export function extractFindings(structuredOutput: unknown, text: string): FindingsExtraction {
  if (structuredOutput !== null && structuredOutput !== undefined) {
    return classifyParsed(structuredOutput, text);
  }

  const trimmed = text.trim();
  if (trimmed === '') {
    return freezeExtraction({ kind: 'invalid', text, parseError: 'empty text' });
  }

  const parsed = tryParseJson(trimmed);
  if (parsed === undefined) {
    return freezeExtraction({ kind: 'invalid', text, parseError: 'invalid JSON' });
  }

  return classifyParsed(parsed, text);
}

function classifyParsed(value: unknown, text: string): FindingsExtraction {
  const parsed = ReviewFindingsSchema.safeParse(value);
  if (!parsed.success) {
    return freezeExtraction({
      kind: 'invalid',
      text,
      parseError: formatValidationError(parsed.error),
    });
  }

  switch (parsed.data.status) {
    case 'final':
      return freezeExtraction({ kind: 'final', findings: freezeFindings(parsed.data) });
    case 'working':
      return freezeExtraction({ kind: 'working' });
    default: {
      const unreachable: never = parsed.data.status;
      throw new Error(`unhandled findings status: ${String(unreachable)}`);
    }
  }
}

function tryParseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function formatValidationError(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'invalid findings';
  const location = issue.path.length > 0 ? issue.path.join('.') : '';
  const prefix = location === '' ? '' : `${location}: `;
  return `${prefix}${issue.message}`;
}

function freezeFindings(findings: ReviewFindings): ReviewFindings {
  Object.freeze(findings.findings);
  return Object.freeze(findings);
}

function freezeExtraction(extraction: FindingsExtraction): FindingsExtraction {
  return Object.freeze(extraction);
}
