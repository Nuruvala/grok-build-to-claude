/**
 * Parse the stdout of a `--output-format json` grok run.
 *
 * Pure: no child_process, no fs, no process.env. Never throws. The only parse
 * strategies are JSON.parse of the trimmed input, then JSON.parse of the last
 * non-empty line. Slicing between braces or stripping a ```json fence is the
 * plugin bug this module exists to not reproduce.
 */

/** Usage is conditional per effort level — every member is optional. Read what is present. */
export type GrokUsage = Readonly<Record<string, number>>;

export interface GrokRunResult {
  readonly text: string;
  /** Exactly what the CLI reported. Never a locally generated value. */
  readonly sessionId: string | null;
  readonly stopReason: string | null;
  readonly requestId: string | null;
  readonly numTurns: number | null;
  readonly usage: GrokUsage | null;
  readonly totalCostUsd: number | null;
  readonly modelUsage: Readonly<Record<string, unknown>> | null;
  /** Present only when the run passed `--json-schema`. Already decoded by the CLI, never a string to re-parse. */
  readonly structuredOutput: unknown;
}

export type ParsedGrokOutput =
  | { readonly kind: 'result'; readonly result: GrokRunResult }
  | { readonly kind: 'cli-error'; readonly message: string }
  | { readonly kind: 'unparseable'; readonly reason: string };

/** Parse the stdout of a `--output-format json` run. Never throws. */
export function parseGrokJson(stdout: string): ParsedGrokOutput {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return freezeParsed({ kind: 'unparseable', reason: 'empty output' });
  }

  const first = tryParseJson(trimmed);
  if (first !== undefined) {
    return interpret(first);
  }

  const lastLine = lastNonEmptyLine(stdout);
  if (lastLine !== undefined && lastLine !== trimmed) {
    const second = tryParseJson(lastLine);
    if (second !== undefined) {
      return interpret(second);
    }
  }

  return freezeParsed({ kind: 'unparseable', reason: 'invalid JSON' });
}

/**
 * Read the metadata fields shared by the `json` result object and the streaming `end` event.
 * Returns null for a non-object or a `{type:"error"}` record. `text` is taken from the record when
 * present and is otherwise the empty string — the streaming `end` event has no `text` field, and
 * its caller supplies the accumulated deltas.
 */
export function parseGrokResultObject(value: unknown): GrokRunResult | null {
  if (!isRecord(value)) return null;
  // The CLI's failure shape. Do not try to extract a result from it — a
  // `{type:"error"}` that also happens to carry `text` / `sessionId` is still an error.
  if (value['type'] === 'error') return null;
  return readGrokResultFields(value);
}

/**
 * Field reader for a record already known not to be a `{type:"error"}` envelope.
 * The streaming path uses this so it does not re-test a condition the line interpreter
 * has already narrowed.
 */
export function readGrokResultFields(record: Record<string, unknown>): GrokRunResult {
  const textValue = record['text'];
  return Object.freeze({
    text: typeof textValue === 'string' ? textValue : '',
    sessionId: stringField(record, 'sessionId'),
    stopReason: stringField(record, 'stopReason'),
    requestId: stringField(record, 'requestId'),
    numTurns: numberField(record, 'num_turns'),
    usage: parseUsage(record['usage']),
    totalCostUsd: numberField(record, 'total_cost_usd'),
    modelUsage: parseModelUsage(record['modelUsage']),
    // Already-decoded by the CLI (verified grok 1.0.4, 2026-08-16). Pass through
    // as-is; parsing `text` to recover this is the scrape this field exists to avoid.
    structuredOutput: record['structuredOutput'] ?? null,
  });
}

function interpret(value: unknown): ParsedGrokOutput {
  const result = parseGrokResultObject(value);
  if (result !== null) {
    return freezeParsed({ kind: 'result', result });
  }

  if (isRecord(value) && value['type'] === 'error') {
    const message = value['message'];
    return freezeParsed({
      kind: 'cli-error',
      message: typeof message === 'string' ? message : '',
    });
  }

  return freezeParsed({ kind: 'unparseable', reason: 'expected a JSON object' });
}

function parseUsage(value: unknown): GrokUsage | null {
  if (!isRecord(value)) return null;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]),
      ),
    ),
  );
}

function parseModelUsage(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value)) return null;
  return Object.freeze({ ...value });
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function tryParseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function lastNonEmptyLine(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeParsed(parsed: ParsedGrokOutput): ParsedGrokOutput {
  return Object.freeze(parsed);
}
