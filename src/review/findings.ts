/**
 * Extract structured review findings from a grok result.
 *
 * Pure. Never throws. Precedence is the whole point: the CLI's already-decoded
 * `structuredOutput` wins; `text` is only parsed as a whole JSON value; a
 * ```json fence is never stripped and braces are never sliced. That scraping is
 * the plugin bug this module exists to not reproduce.
 */

export type FindingsExtraction =
  | { readonly kind: 'structured'; readonly findings: unknown }
  | { readonly kind: 'unstructured'; readonly text: string; readonly parseError: string };

export function extractFindings(structuredOutput: unknown, text: string): FindingsExtraction {
  if (isRecord(structuredOutput)) {
    return freezeExtraction({ kind: 'structured', findings: structuredOutput });
  }

  const trimmed = text.trim();
  if (trimmed === '') {
    return freezeExtraction({ kind: 'unstructured', text, parseError: 'empty text' });
  }

  const parsed = tryParseJson(trimmed);
  if (parsed === undefined) {
    return freezeExtraction({ kind: 'unstructured', text, parseError: 'invalid JSON' });
  }

  if (!isRecord(parsed)) {
    return freezeExtraction({
      kind: 'unstructured',
      text,
      parseError: 'JSON value is not an object',
    });
  }

  return freezeExtraction({ kind: 'structured', findings: parsed });
}

function tryParseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeExtraction(extraction: FindingsExtraction): FindingsExtraction {
  return Object.freeze(extraction);
}
