import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGrokJson } from '../../src/grok/result.js';
import type { GrokRunResult, ParsedGrokOutput } from '../../src/grok/result.js';
import {
  createNdjsonReader,
  createStreamCollector,
  interpretStreamLine,
} from '../../src/grok/stream.js';
import type { GrokStreamEvent, StreamOutcome } from '../../src/grok/stream.js';

/** Synthetic ids only — fixtures must not be live session ids. */
const END_METADATA = {
  stopReason: 'end_turn',
  sessionId: '3b91c07e-6d24-8ae1-b5f0-19c4a7e62d08',
  requestId: 'req-stream-test-41ab',
  usage: {
    input_tokens: 18344,
    cache_read_input_tokens: 28928,
    cache_creation_input_tokens: 0,
    output_tokens: 212,
    reasoning_tokens: 80,
    total_tokens: 47484,
  },
  num_turns: 2,
  total_cost_usd: 0.00891208,
  total_cost_usd_ticks: 89120800,
  modelUsage: {
    'grok-4.6-build': { inputTokens: 18344, outputTokens: 212 },
  },
} as const;

const TRANSCRIPT = [
  '{"type":"text","data":"I\'ll"}',
  '{"type":"thought","data":"The user wants"}',
  '',
  '{"type":"tool_call","toolCallId":"call-1","title":"list_dir"}',
  '{"type":"end","sessionId":"sess-end"}',
].join('\n');

function collectLines(source: string, chunkSize: number): readonly string[] {
  const reader = createNdjsonReader();
  const lines: string[] = [];
  if (chunkSize <= 0) {
    lines.push(...reader.push(source));
  } else {
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      lines.push(...reader.push(source.slice(offset, offset + chunkSize)));
    }
  }
  lines.push(...reader.flush());
  return lines;
}

function assertResultOutcome(outcome: StreamOutcome): GrokRunResult {
  if (outcome.kind !== 'result') {
    assert.fail(`expected kind "result", got ${outcome.kind}`);
  }
  return outcome.result;
}

function assertPartialOutcome(outcome: StreamOutcome): Extract<StreamOutcome, { kind: 'partial' }> {
  if (outcome.kind !== 'partial') {
    assert.fail(`expected kind "partial", got ${outcome.kind}`);
  }
  return outcome;
}

function assertParsedResult(parsed: ParsedGrokOutput): GrokRunResult {
  if (parsed.kind !== 'result') {
    assert.fail(`expected kind "result", got ${parsed.kind}`);
  }
  return parsed.result;
}

function asUsage(event: GrokStreamEvent): Extract<GrokStreamEvent, { type: 'usage' }> {
  if (event.type !== 'usage') {
    assert.fail(`expected type "usage", got "${event.type}"`);
  }
  return event;
}

function asEnd(event: GrokStreamEvent): Extract<GrokStreamEvent, { type: 'end' }> {
  if (event.type !== 'end') {
    assert.fail(`expected type "end", got "${event.type}"`);
  }
  return event;
}

function asToolCall(event: GrokStreamEvent): Extract<GrokStreamEvent, { type: 'tool_call' }> {
  if (event.type !== 'tool_call') {
    assert.fail(`expected type "tool_call", got "${event.type}"`);
  }
  return event;
}

describe('createNdjsonReader chunk boundaries', () => {
  it('produces identical lines for chunk sizes 1, 3, 7, 64, and the whole transcript, because a boundary mid-line is the normal case', () => {
    const whole = collectLines(TRANSCRIPT, TRANSCRIPT.length);
    for (const size of [1, 3, 7, 64, TRANSCRIPT.length]) {
      assert.deepEqual(
        [...collectLines(TRANSCRIPT, size)],
        [...whole],
        `chunk size ${size} disagreed with the whole-chunk read`,
      );
    }
  });

  it('strips a trailing CR so CRLF transcripts do not leave \\r on every line', () => {
    const reader = createNdjsonReader();
    const lines = reader.push('{"type":"text","data":"a"}\r\n{"type":"text","data":"b"}\r\n');
    assert.deepEqual([...lines], ['{"type":"text","data":"a"}', '{"type":"text","data":"b"}']);
    assert.deepEqual([...reader.flush()], []);
  });

  it('returns a trailing line with no terminator from flush, not from push, because the line is still open', () => {
    const reader = createNdjsonReader();
    assert.deepEqual([...reader.push('{"type":"te')], []);
    assert.deepEqual([...reader.push('xt","data":"hi"}')], []);
    assert.deepEqual([...reader.flush()], ['{"type":"text","data":"hi"}']);
  });

  it('returns [] from flush on an empty buffer, and again on a second flush, so the caller can poll the end', () => {
    const reader = createNdjsonReader();
    assert.deepEqual([...reader.flush()], []);
    assert.deepEqual([...reader.flush()], []);
    reader.push('complete\n');
    assert.deepEqual([...reader.flush()], []);
    assert.deepEqual([...reader.flush()], []);
  });

  it("returns blank lines as empty strings rather than dropping them, because classifying blanks is the interpreter's job", () => {
    const reader = createNdjsonReader();
    assert.deepEqual([...reader.push('\n\n')], ['', '']);
  });

  it('joins a line split across three chunks the same way as feeding it whole', () => {
    const line = '{"type":"text","data":"hi"}';
    const reader = createNdjsonReader();
    assert.deepEqual([...reader.push(line.slice(0, 8))], []);
    assert.deepEqual([...reader.push(line.slice(8, 20))], []);
    assert.deepEqual([...reader.push(`${line.slice(20)}\n`)], [line]);
  });

  it('treats a leftover CR-only buffer as empty on flush so a dangling CR is not a phantom line', () => {
    const reader = createNdjsonReader();
    assert.deepEqual([...reader.push('keep\n\r')], ['keep']);
    assert.deepEqual([...reader.flush()], []);
  });
});

describe('interpretStreamLine modelled types', () => {
  it('maps a text delta, because response text exists only as concatenated .data fields', () => {
    assert.deepEqual(interpretStreamLine('{"type":"text","data":"I\'ll"}'), {
      type: 'text',
      data: "I'll",
    });
  });

  it('maps a thought delta with the same shape as text', () => {
    assert.deepEqual(interpretStreamLine('{"type":"thought","data":"The user wants"}'), {
      type: 'thought',
      data: 'The user wants',
    });
  });

  it('maps a tool_call, including empty locations, because the path often arrives in a later update', () => {
    const event = interpretStreamLine(
      JSON.stringify({
        type: 'tool_call',
        toolCallId: 'call-033456f4-0',
        title: 'list_dir',
        kind: 'list',
        status: 'pending',
        toolName: 'list_dir',
        rawInput: { target_directory: '.' },
        content: [],
        locations: [],
      }),
    );
    assert.deepEqual(event, {
      type: 'tool_call',
      toolCallId: 'call-033456f4-0',
      toolName: 'list_dir',
      title: 'list_dir',
      kind: 'list',
      status: 'pending',
      rawInput: { target_directory: '.' },
      locations: [],
    });
  });

  it('maps a tool_call_update, flattening location paths and keeping a null status as null', () => {
    const event = interpretStreamLine(
      JSON.stringify({
        type: 'tool_call_update',
        toolCallId: 'call-033456f4-0',
        status: null,
        locations: [{ path: '.' }],
        content: [],
        rawOutput: { listing: [] },
      }),
    );
    assert.deepEqual(event, {
      type: 'tool_call_update',
      toolCallId: 'call-033456f4-0',
      status: null,
      locations: ['.'],
    });
  });

  it('maps a usage event through the shared result parser so per-turn usage matches the json path', () => {
    const event = interpretStreamLine(
      JSON.stringify({
        type: 'usage',
        usage: {
          input_tokens: 17462,
          output_tokens: 71,
          cache_read_input_tokens: 5760,
          cache_creation_input_tokens: 0,
          reasoning_tokens: 45,
        },
        signature: 'opaque',
      }),
    );
    assert.deepEqual(
      { ...asUsage(event).usage },
      {
        input_tokens: 17462,
        output_tokens: 71,
        cache_read_input_tokens: 5760,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 45,
      },
    );
  });

  it('maps an end event with empty text, because end has no text field and the collector supplies the deltas', () => {
    const event = interpretStreamLine(
      JSON.stringify({ type: 'end', ...END_METADATA, text: 'must-not-surface' }),
    );
    const result = asEnd(event).result;
    assert.equal(result.text, '');
    assert.equal(result.sessionId, END_METADATA.sessionId);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.requestId, END_METADATA.requestId);
    assert.equal(result.numTurns, 2);
    assert.equal(result.totalCostUsd, 0.00891208);
    assert.deepEqual({ ...result.usage }, { ...END_METADATA.usage });
    assert.deepEqual({ ...result.modelUsage }, { ...END_METADATA.modelUsage });
  });

  it('maps an error event to its message, including when the message key is missing', () => {
    assert.deepEqual(interpretStreamLine('{"type":"error","message":"unknown model id"}'), {
      type: 'error',
      message: 'unknown model id',
    });
    assert.deepEqual(interpretStreamLine('{"type":"error"}'), { type: 'error', message: '' });
  });
});

describe('interpretStreamLine degradation', () => {
  it('flattens locations to the path strings and drops entries that have no string path', () => {
    const event = interpretStreamLine(
      JSON.stringify({
        type: 'tool_call',
        locations: [{ path: 'a' }, { nope: 1 }, { path: 'b' }, 'bare', null],
      }),
    );
    assert.deepEqual([...asToolCall(event).locations], ['a', 'b']);
  });

  it('treats an unknown type as other, carrying the tag, because the CLI type list is not closed', () => {
    assert.deepEqual(interpretStreamLine('{"type":"available_commands","commands":[]}'), {
      type: 'other',
      name: 'available_commands',
    });
    assert.deepEqual(interpretStreamLine('{"type":"plan","steps":[]}'), {
      type: 'other',
      name: 'plan',
    });
  });

  it('returns unparseable with the raw line preserved, and does not slice between braces', () => {
    const line = 'The model said {"type":"text","data":"secret"} but this is prose';
    assert.deepEqual(interpretStreamLine(line), { type: 'unparseable', line });
  });

  it('returns unparseable for valid JSON that is not an object, because every modelled event is an object', () => {
    assert.deepEqual(interpretStreamLine('42'), { type: 'unparseable', line: '42' });
    assert.deepEqual(interpretStreamLine('"just a string"'), {
      type: 'unparseable',
      line: '"just a string"',
    });
    assert.deepEqual(interpretStreamLine('null'), { type: 'unparseable', line: 'null' });
    assert.deepEqual(interpretStreamLine('[1,2]'), { type: 'unparseable', line: '[1,2]' });
  });

  it('coerces a non-string text data field to the empty string and still yields a text event', () => {
    assert.deepEqual(interpretStreamLine('{"type":"text","data":12}'), { type: 'text', data: '' });
    assert.deepEqual(interpretStreamLine('{"type":"thought","data":false}'), {
      type: 'thought',
      data: '',
    });
  });

  it('classifies a blank or whitespace-only line as other/blank rather than unparseable', () => {
    assert.deepEqual(interpretStreamLine(''), { type: 'other', name: 'blank' });
    assert.deepEqual(interpretStreamLine('   \t  '), { type: 'other', name: 'blank' });
  });

  it('classifies a missing or non-string type as other/(untyped), so a future shapeless object is still a value', () => {
    assert.deepEqual(interpretStreamLine('{"data":"x"}'), { type: 'other', name: '(untyped)' });
    assert.deepEqual(interpretStreamLine('{"type":1}'), { type: 'other', name: '(untyped)' });
  });

  it('degrades a non-object rawInput to null and a missing locations array to empty, without throwing', () => {
    const event = interpretStreamLine(
      JSON.stringify({ type: 'tool_call', rawInput: 'nope', locations: 'nope' }),
    );
    const toolCall = asToolCall(event);
    assert.equal(toolCall.rawInput, null);
    assert.deepEqual([...toolCall.locations], []);
    assert.equal(toolCall.toolCallId, null);
    assert.equal(toolCall.toolName, null);
    assert.equal(toolCall.title, null);
    assert.equal(toolCall.kind, null);
    assert.equal(toolCall.status, null);
  });

  it('degrades a missing usage object to null rather than inventing numbers', () => {
    const event = interpretStreamLine('{"type":"usage"}');
    assert.deepEqual(event, { type: 'usage', usage: null });
  });

  it('still maps an end event with no metadata to a result of all-null fields and empty text', () => {
    const event = interpretStreamLine('{"type":"end"}');
    assert.deepEqual(asEnd(event).result, {
      text: '',
      sessionId: null,
      stopReason: null,
      requestId: null,
      numTurns: null,
      usage: null,
      totalCostUsd: null,
      modelUsage: null,
    });
  });
});

describe('createStreamCollector folding', () => {
  it('concatenates 112 text deltas plus an end into a result whose text and metadata match the end event', () => {
    const deltas = Array.from({ length: 112 }, (_, index) => `w${String(index)} `);
    const collector = createStreamCollector();
    for (const data of deltas) {
      collector.accept(interpretStreamLine(JSON.stringify({ type: 'text', data })));
    }
    collector.accept(interpretStreamLine(JSON.stringify({ type: 'end', ...END_METADATA })));
    const result = assertResultOutcome(collector.outcome());
    assert.equal(result.text, deltas.join(''));
    assert.equal(result.sessionId, END_METADATA.sessionId);
    assert.equal(result.stopReason, END_METADATA.stopReason);
    assert.equal(result.requestId, END_METADATA.requestId);
    assert.equal(result.numTurns, END_METADATA.num_turns);
    assert.equal(result.totalCostUsd, END_METADATA.total_cost_usd);
    assert.deepEqual({ ...result.usage }, { ...END_METADATA.usage });
    assert.deepEqual({ ...result.modelUsage }, { ...END_METADATA.modelUsage });
  });

  it('produces a GrokRunResult deeply equal to parseGrokJson for the same metadata, so the two paths cannot drift', () => {
    const text = 'hello world';
    const record = { text, ...END_METADATA };
    const fromJson = assertParsedResult(parseGrokJson(JSON.stringify(record)));

    const collector = createStreamCollector();
    collector.accept(interpretStreamLine(JSON.stringify({ type: 'text', data: 'hello' })));
    collector.accept(interpretStreamLine(JSON.stringify({ type: 'text', data: ' world' })));
    collector.accept(interpretStreamLine(JSON.stringify({ type: 'end', ...END_METADATA })));
    const fromStream = assertResultOutcome(collector.outcome());

    assert.deepEqual(fromStream, fromJson);
  });

  it('classifies an error as cli-error even when an end follows and text accumulated, matching parseGrokJson', () => {
    const collector = createStreamCollector();
    collector.accept(interpretStreamLine('{"type":"text","data":"partial"}'));
    collector.accept(interpretStreamLine('{"type":"error","message":"unknown model id"}'));
    collector.accept(interpretStreamLine(JSON.stringify({ type: 'end', ...END_METADATA })));
    assert.deepEqual(collector.outcome(), {
      kind: 'cli-error',
      message: 'unknown model id',
    });
  });

  it('returns partial with the concatenated text and a null sessionId when the stream stops before end', () => {
    const collector = createStreamCollector();
    collector.accept(interpretStreamLine('{"type":"text","data":"hello "}'));
    collector.accept(interpretStreamLine('{"type":"text","data":"world"}'));
    const outcome = assertPartialOutcome(collector.outcome());
    assert.equal(outcome.result.text, 'hello world');
    assert.equal(outcome.result.sessionId, null);
    assert.equal(outcome.result.stopReason, null);
    assert.equal(outcome.result.requestId, null);
    assert.equal(outcome.result.numTurns, null);
    assert.equal(outcome.result.usage, null);
    assert.equal(outcome.result.totalCostUsd, null);
    assert.equal(outcome.result.modelUsage, null);
    assert.equal(outcome.reason, 'stream ended before the end event');
  });

  it('returns unparseable with a distinct reason when nothing was accepted, so an empty run is not confused with a silent one', () => {
    const outcome = createStreamCollector().outcome();
    assert.deepEqual(outcome, { kind: 'unparseable', reason: 'nothing was accepted' });
  });

  it('returns unparseable with a different reason when events arrived but none carried text or metadata', () => {
    const collector = createStreamCollector();
    collector.accept(interpretStreamLine('{"type":"thought","data":"hmm"}'));
    collector.accept(interpretStreamLine('{"type":"available_commands"}'));
    collector.accept(interpretStreamLine('not-json'));
    collector.accept(interpretStreamLine('{"type":"usage"}'));
    collector.accept(interpretStreamLine('{"type":"tool_call","title":"list_dir"}'));
    collector.accept(interpretStreamLine('{"type":"tool_call_update","status":"completed"}'));
    const outcome = collector.outcome();
    assert.deepEqual(outcome, {
      kind: 'unparseable',
      reason: 'events were accepted but none carried text or metadata',
    });
  });

  it("does not leak thought deltas into result.text, because the json path's text field is the response only", () => {
    const collector = createStreamCollector();
    collector.accept(interpretStreamLine('{"type":"thought","data":"secret reasoning"}'));
    collector.accept(interpretStreamLine('{"type":"text","data":"visible"}'));
    collector.accept(interpretStreamLine(JSON.stringify({ type: 'end', ...END_METADATA })));
    const result = assertResultOutcome(collector.outcome());
    assert.equal(result.text, 'visible');
    assert.ok(!result.text.includes('secret'));
  });

  it('lets the last end event win when more than one arrives, because the type list is open', () => {
    const collector = createStreamCollector();
    collector.accept(interpretStreamLine('{"type":"text","data":"ok"}'));
    collector.accept(interpretStreamLine('{"type":"end","sessionId":"first","stopReason":"a"}'));
    collector.accept(interpretStreamLine('{"type":"end","sessionId":"second","stopReason":"b"}'));
    const result = assertResultOutcome(collector.outcome());
    assert.equal(result.sessionId, 'second');
    assert.equal(result.stopReason, 'b');
    assert.equal(result.text, 'ok');
  });

  it('does not consume state when outcome is called, so a caller can poll mid-stream', () => {
    const collector = createStreamCollector();
    collector.accept(interpretStreamLine('{"type":"text","data":"ab"}'));
    const mid = collector.outcome();
    collector.accept(interpretStreamLine(JSON.stringify({ type: 'end', ...END_METADATA })));
    const done = collector.outcome();
    assert.equal(mid.kind, 'partial');
    assert.equal(assertResultOutcome(done).text, 'ab');
    assert.equal(assertResultOutcome(collector.outcome()).sessionId, END_METADATA.sessionId);
  });

  it('keeps the last error message when several error events arrive', () => {
    const collector = createStreamCollector();
    collector.accept(interpretStreamLine('{"type":"error","message":"first"}'));
    collector.accept(interpretStreamLine('{"type":"error","message":"second"}'));
    assert.deepEqual(collector.outcome(), { kind: 'cli-error', message: 'second' });
  });

  it('ignores an unmodelled event without throwing, because accept runs in a stdout data handler where an exception kills the server', () => {
    const collector = createStreamCollector();
    const event = { type: 'brand-new' } as unknown as GrokStreamEvent;

    collector.accept(interpretStreamLine('{"type":"text","data":"kept"}'));
    assert.doesNotThrow(() => {
      collector.accept(event);
    });
    collector.accept(interpretStreamLine(JSON.stringify({ type: 'end', ...END_METADATA })));

    // The unmodelled event is dropped, and everything around it still folds normally.
    assert.equal(assertResultOutcome(collector.outcome()).text, 'kept');
  });
});
