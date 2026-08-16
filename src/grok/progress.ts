/**
 * Map streaming-json events to human-readable progress lines.
 *
 * Pure: the caller owns the clock and decides when to flush token deltas. Progress tracks what
 * the agent is doing (tools, narration), not lifecycle phases — two phase strings for a
 * ten-minute run is the failure this module exists to not reproduce.
 */

import type { GrokRunResult } from './result.js';
import type { GrokStreamEvent } from './stream.js';

export interface ProgressEmission {
  /** Monotonic, starting at 1. */
  readonly progress: number;
  readonly message: string;
}

export interface ProgressMapper {
  /** Fold an event. Returns a message to emit now, or null when there is nothing to say yet. */
  readonly accept: (event: GrokStreamEvent) => ProgressEmission | null;
  /**
   * Emit accumulated `text`/`thought` narration, if any arrived since the last flush.
   * The caller calls this on a timer to debounce a token-by-token delta stream down to a
   * readable rate. Returns null when nothing new accumulated.
   */
  readonly flush: () => ProgressEmission | null;
}

const TAIL_LIMIT = 120;

export function createProgressMapper(): ProgressMapper {
  let progress = 0;
  let textBuffer = '';
  let thoughtBuffer = '';
  const labels = new Map<string, string>();

  function emit(message: string): ProgressEmission {
    progress += 1;
    return Object.freeze({ progress, message });
  }

  return {
    accept: (event: GrokStreamEvent): ProgressEmission | null => {
      switch (event.type) {
        case 'tool_call': {
          const label = nonempty(event.title) ?? nonempty(event.toolName) ?? 'tool';
          if (event.toolCallId !== null) {
            labels.set(event.toolCallId, label);
          }
          const target = firstLocation(event.locations) ?? firstPathLike(event.rawInput);
          return emit(target === undefined ? label : `${label} ${target}`);
        }
        case 'tool_call_update': {
          // Mid-flight updates carry `status: null` and would otherwise double every tool line.
          if (event.status === null || event.status === '') return null;
          const recorded = event.toolCallId === null ? undefined : labels.get(event.toolCallId);
          const label = recorded ?? nonempty(event.toolCallId) ?? 'tool';
          return emit(`${label} — ${event.status}`);
        }
        case 'text':
          textBuffer += event.data;
          return null;
        case 'thought':
          thoughtBuffer += event.data;
          return null;
        case 'end':
          return emit(formatEnd(event.result));
        case 'error':
          return emit(event.message);
        case 'usage':
        case 'other':
        case 'unparseable':
          return null;
        default:
          // See the matching arm in stream.ts: compile-time exhaustiveness, no runtime throw.
          // This runs inside a `stdout` data handler, and a missing progress line is cosmetic
          // where an uncaught exception is fatal.
          ((_exhaustive: never) => undefined)(event);
          return null;
      }
    },
    flush: (): ProgressEmission | null => {
      if (textBuffer === '' && thoughtBuffer === '') return null;
      // Prefer the response over the reasoning that produced it. Clear both so a later
      // flush does not re-emit the discarded thought after the text has already been shown.
      const preferText = textBuffer !== '';
      const raw = preferText ? textBuffer : thoughtBuffer;
      textBuffer = '';
      thoughtBuffer = '';
      const prefix = preferText ? 'writing: ' : 'thinking: ';
      return emit(`${prefix}${formatTail(raw)}`);
    },
  };
}

function formatEnd(result: GrokRunResult): string {
  const reason = result.stopReason;
  const turns = result.numTurns;
  if (reason !== null && turns !== null) {
    return `finished: ${reason} (${turns} turns)`;
  }
  if (reason !== null) {
    return `finished: ${reason}`;
  }
  if (turns !== null) {
    return `finished: ${turns} turns`;
  }
  return 'finished';
}

function formatTail(buffer: string): string {
  const collapsed = buffer.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TAIL_LIMIT) return collapsed;
  return `…${collapsed.slice(-TAIL_LIMIT)}`;
}

function firstLocation(locations: readonly string[]): string | undefined {
  const path = locations[0];
  return path !== undefined && path !== '' ? path : undefined;
}

function firstPathLike(rawInput: Readonly<Record<string, unknown>> | null): string | undefined {
  if (rawInput === null) return undefined;
  for (const value of Object.values(rawInput)) {
    if (typeof value === 'string' && looksLikePath(value)) return value;
  }
  return undefined;
}

function looksLikePath(value: string): boolean {
  return (value.includes('/') || value.includes('.')) && !/\s/.test(value);
}

function nonempty(value: string | null): string | undefined {
  return value !== null && value !== '' ? value : undefined;
}
