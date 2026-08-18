/**
 * Incremental parsing of grok `--output-format streaming-json` NDJSON.
 *
 * Pure: no I/O, no clock. Never throws. Unknown event types and malformed lines become typed
 * values rather than exceptions — the CLI type list is not closed (verified grok 1.0.0 on
 * 2026-08-16), and a killed run's last line is usually truncated JSON.
 */

import { readGrokResultFields } from './result.js';
import { firstLocation, firstPathLike } from './tool-target.js';
import type { GrokRunResult, GrokUsage } from './result.js';

export type GrokStreamEvent =
  | { readonly type: 'text'; readonly data: string }
  | { readonly type: 'thought'; readonly data: string }
  | {
      readonly type: 'tool_call';
      readonly toolCallId: string | null;
      readonly toolName: string | null;
      readonly title: string | null;
      readonly kind: string | null;
      readonly status: string | null;
      readonly rawInput: Readonly<Record<string, unknown>> | null;
      readonly locations: readonly string[];
    }
  | {
      readonly type: 'tool_call_update';
      readonly toolCallId: string | null;
      readonly status: string | null;
      readonly rawOutput: Readonly<Record<string, unknown>> | null;
      readonly locations: readonly string[];
    }
  | { readonly type: 'usage'; readonly usage: GrokUsage | null }
  | { readonly type: 'end'; readonly result: GrokRunResult }
  | { readonly type: 'error'; readonly message: string }
  /** A recognised JSON object whose `type` we do not model. Carries the tag for logging. */
  | { readonly type: 'other'; readonly name: string }
  /** A line that was not valid JSON. Never throws; the raw line is preserved for diagnostics. */
  | { readonly type: 'unparseable'; readonly line: string };

/**
 * A tool call the CLI reported as failed, named the way the progress log names it.
 *
 * Collected because a failure is invisible in the run's result text. The grok CLI ends a whole
 * run with `stopReason: "cancelled"` when a tool call is refused (verified grok 1.0.4 on
 * 2026-08-18, a `write` outside the `workspace` sandbox), and the result text then holds only
 * whatever narration preceded the refusal. A caller reading that text sees a short answer and
 * an exit code of 0. A failed call on its own is not fatal and is common, so the run reporter
 * names these only when the run was also cut off.
 */
export interface ToolFailure {
  /** The tool's display label, the same one the progress log uses. */
  readonly label: string;
  /** Where the call pointed, when the event said: a path, a URL, or null. */
  readonly target: string | null;
  /** The status the CLI reported, verbatim. */
  readonly status: string;
}

export type StreamOutcome =
  | { readonly kind: 'result'; readonly result: GrokRunResult }
  /** The stream stopped before `end`. `result` holds whatever was recovered. */
  | { readonly kind: 'partial'; readonly result: GrokRunResult; readonly reason: string }
  | { readonly kind: 'cli-error'; readonly message: string }
  | { readonly kind: 'unparseable'; readonly reason: string };

export interface NdjsonReader {
  /** Feed a decoded chunk. Returns the complete lines it produced, in order. */
  readonly push: (chunk: string) => readonly string[];
  /** Return any trailing partial line. Call once, when the stream ends. */
  readonly flush: () => readonly string[];
}

export interface StreamCollector {
  readonly accept: (event: GrokStreamEvent) => void;
  /** Fold everything accepted so far. Callable at any point; does not consume state. */
  readonly outcome: () => StreamOutcome;
  /** Tool calls the CLI reported as failed, in the order they failed. */
  readonly toolFailures: () => readonly ToolFailure[];
}

/** Interpret one NDJSON line. Total: never throws, for any input including ''. */
export function interpretStreamLine(line: string): GrokStreamEvent {
  if (line.trim() === '') {
    return freezeEvent({ type: 'other', name: 'blank' });
  }

  const parsed = tryParseJson(line);
  if (parsed === undefined || !isRecord(parsed)) {
    return freezeEvent({ type: 'unparseable', line });
  }

  const tag = parsed['type'];
  if (typeof tag !== 'string') {
    return freezeEvent({ type: 'other', name: '(untyped)' });
  }

  switch (tag) {
    case 'text':
    case 'thought':
      return freezeEvent({ type: tag, data: stringOrEmpty(parsed['data']) });
    case 'tool_call':
      return freezeEvent({
        type: 'tool_call',
        toolCallId: stringField(parsed, 'toolCallId'),
        toolName: stringField(parsed, 'toolName'),
        title: stringField(parsed, 'title'),
        kind: stringField(parsed, 'kind'),
        status: stringField(parsed, 'status'),
        rawInput: parseRawRecord(parsed['rawInput']),
        locations: flattenLocations(parsed['locations']),
      });
    case 'tool_call_update':
      return freezeEvent({
        type: 'tool_call_update',
        toolCallId: stringField(parsed, 'toolCallId'),
        status: stringField(parsed, 'status'),
        rawOutput: parseRawRecord(parsed['rawOutput']),
        locations: flattenLocations(parsed['locations']),
      });
    case 'usage':
      return freezeEvent({ type: 'usage', usage: readGrokResultFields(parsed).usage });
    case 'end':
      // `end` has no `text` field (verified grok 1.0.0). Force empty even if a future CLI
      // adds one — the collector fills text from the accumulated deltas, matching the json path.
      return freezeEvent({
        type: 'end',
        result: Object.freeze({ ...readGrokResultFields(parsed), text: '' }),
      });
    case 'error': {
      const message = parsed['message'];
      return freezeEvent({
        type: 'error',
        message: typeof message === 'string' ? message : '',
      });
    }
    default:
      // Type list is non-exhaustive; plan, available_commands, and future tags all land here.
      // Throwing would make a CLI upgrade crash a run.
      return freezeEvent({ type: 'other', name: tag });
  }
}

/**
 * Split a byte stream into NDJSON lines across arbitrary chunk boundaries.
 * Stateful (it holds a partial-line buffer) but has no I/O and no clock.
 */
export function createNdjsonReader(): NdjsonReader {
  let buffer = '';

  return {
    push: (chunk: string): readonly string[] => {
      buffer += chunk;
      const lines: string[] = [];
      let newlineAt = buffer.indexOf('\n');
      while (newlineAt !== -1) {
        lines.push(stripTrailingCr(buffer.slice(0, newlineAt)));
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf('\n');
      }
      return Object.freeze(lines);
    },
    flush: (): readonly string[] => {
      if (buffer === '') return Object.freeze([]);
      const leftover = stripTrailingCr(buffer);
      buffer = '';
      return leftover === '' ? Object.freeze([]) : Object.freeze([leftover]);
    },
  };
}

export function createStreamCollector(): StreamCollector {
  let errorMessage: string | undefined;
  let lastEnd: GrokRunResult | undefined;
  const textParts: string[] = [];
  let accepted = 0;
  // Labels and targets arrive on `tool_call` and the verdict arrives later on
  // `tool_call_update`, which carries neither, so the pairing has to be kept.
  const toolLabels = new Map<string, string>();
  const toolTargets = new Map<string, string>();
  const failures: ToolFailure[] = [];

  return {
    accept: (event: GrokStreamEvent): void => {
      accepted += 1;
      switch (event.type) {
        case 'error':
          errorMessage = event.message;
          return;
        case 'end':
          lastEnd = event.result;
          return;
        case 'text':
          textParts.push(event.data);
          return;
        case 'tool_call': {
          if (event.toolCallId === null) return;
          const label = nonemptyOr(event.title, event.toolName) ?? 'tool';
          toolLabels.set(event.toolCallId, label);
          const target = firstLocation(event.locations) ?? firstPathLike(event.rawInput);
          if (target !== undefined) toolTargets.set(event.toolCallId, target);
          return;
        }
        case 'tool_call_update': {
          // `failed` is the only status the CLI has been observed to use for a refused or
          // errored call (grok 1.0.4): the others are null, `in_progress` and `completed`.
          // `error` is accepted too rather than assuming that list is closed.
          if (event.status !== 'failed' && event.status !== 'error') return;
          const id = event.toolCallId;
          const label = (id === null ? undefined : toolLabels.get(id)) ?? 'tool';
          const target =
            firstLocation(event.locations) ?? (id === null ? undefined : toolTargets.get(id));
          failures.push(Object.freeze({ label, target: target ?? null, status: event.status }));
          return;
        }
        case 'thought':
        case 'usage':
        case 'other':
        case 'unparseable':
          return;
        default:
          // Unreachable while `GrokStreamEvent` is the only source of events — the assignment
          // below is a compile error the moment a variant is added without an arm here, which is
          // the protection that matters. It deliberately does not throw at runtime: `accept` is
          // driven from a `stdout` data handler, where an exception is uncaught, kills the
          // process, and leaves the run's promise forever unresolved. Dropping one event beats
          // taking down the server.
          ((_exhaustive: never) => undefined)(event);
          return;
      }
    },
    outcome: (): StreamOutcome => {
      // Error wins even if an `end` also arrived — matching parseGrokJson, where a
      // `{type:"error"}` record is an error regardless of what else it carries.
      if (errorMessage !== undefined) {
        return freezeOutcome({ kind: 'cli-error', message: errorMessage });
      }

      const text = textParts.join('');
      if (lastEnd !== undefined) {
        return freezeOutcome({
          kind: 'result',
          result: Object.freeze({ ...lastEnd, text }),
        });
      }

      if (accepted === 0) {
        return freezeOutcome({ kind: 'unparseable', reason: 'nothing was accepted' });
      }

      return freezeOutcome({
        kind: 'partial',
        result: Object.freeze({ ...emptyResult(), text }),
        // Do not invent a session id. A partial run has no confirmed session — reporting
        // one Grok never recorded is the plugin bug this collector exists to not reproduce.
        // Same now that we have harvested tool events and still no `end`.
        reason: 'stream ended before the end event',
      });
    },
    toolFailures: (): readonly ToolFailure[] => Object.freeze([...failures]),
  };
}

function nonemptyOr(first: string | null, second: string | null): string | undefined {
  const label = first !== null && first !== '' ? first : second;
  if (label === null || label === '') return undefined;
  // The CLI's title for a backend search is literally `"Web search:"`; a trailing colon
  // reads as a dangling label with nothing after it.
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

/** Empty result used when a stream never produced an `end`. Session id stays null. */
export function emptyResult(): GrokRunResult {
  return Object.freeze({
    text: '',
    sessionId: null,
    stopReason: null,
    requestId: null,
    numTurns: null,
    usage: null,
    totalCostUsd: null,
    modelUsage: null,
    structuredOutput: null,
    structuredOutputError: null,
  });
}

function flattenLocations(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const paths: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const path = entry['path'];
    if (typeof path === 'string') paths.push(path);
  }
  return Object.freeze(paths);
}

/**
 * Shape-neutral parse for `rawInput` / `rawOutput`. A non-object — including
 * the observed mid-flight `null` — becomes `null`. Named for the shape, not
 * the field, so the two call sites cannot drift.
 */
function parseRawRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value)) return null;
  return Object.freeze({ ...value });
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
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

function freezeEvent<T extends GrokStreamEvent>(event: T): T {
  return Object.freeze(event);
}

function freezeOutcome(outcome: StreamOutcome): StreamOutcome {
  return Object.freeze(outcome);
}
