import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProgressMapper } from '../../src/grok/progress.js';
import type { GrokRunResult } from '../../src/grok/result.js';
import type { GrokStreamEvent } from '../../src/grok/stream.js';

const EMPTY_RESULT: GrokRunResult = {
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
};

function toolCall(
  overrides: Partial<Extract<GrokStreamEvent, { type: 'tool_call' }>> = {},
): GrokStreamEvent {
  return {
    type: 'tool_call',
    toolCallId: null,
    toolName: null,
    title: null,
    kind: null,
    status: null,
    rawInput: null,
    locations: [],
    ...overrides,
  };
}

describe('createProgressMapper tool_call', () => {
  it('emits 12 distinct messages for 12 tool_call events, because progress must track work, not two lifecycle phases', () => {
    const mapper = createProgressMapper();
    const calls: readonly GrokStreamEvent[] = [
      toolCall({ title: 'list_dir', locations: ['.'] }),
      toolCall({ title: 'read_file', locations: ['src/main.rs'] }),
      toolCall({ title: 'read_file', locations: ['src/lib.rs'] }),
      toolCall({ title: 'grep', locations: ['src'] }),
      toolCall({ toolName: 'run_terminal_command', rawInput: { command: 'npm test' } }),
      toolCall({ title: 'read_file', locations: ['package.json'] }),
      toolCall({ title: 'read_file', locations: ['tsconfig.json'] }),
      toolCall({ title: 'grep', locations: ['tests'] }),
      toolCall({ title: 'read_file', locations: ['docs/engineering.md'] }),
      toolCall({ title: 'list_dir', locations: ['src/grok'] }),
      toolCall({ title: 'read_file', locations: ['src/grok/args.ts'] }),
      toolCall({ title: 'read_file', locations: ['src/grok/result.ts'] }),
    ];

    const emissions = calls.map((event) => mapper.accept(event));
    const messages = emissions.map((emission) => {
      assert.ok(emission, 'tool_call must emit immediately');
      return emission.message;
    });

    assert.equal(new Set(messages).size, 12);
    assert.deepEqual(
      emissions.map((emission) => emission?.progress),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
  });

  it('uses title, then toolName, then tool as the label, so a nameless call is still a line', () => {
    const mapper = createProgressMapper();
    assert.equal(
      mapper.accept(toolCall({ title: 'list_dir', locations: ['.'] }))?.message,
      'list_dir .',
    );
    assert.equal(
      mapper.accept(toolCall({ toolName: 'read_file', locations: ['src/main.rs'] }))?.message,
      'read_file src/main.rs',
    );
    assert.equal(mapper.accept(toolCall())?.message, 'tool');
  });

  it('prefers locations[0] over a path-like rawInput value, and falls back to rawInput when locations are empty', () => {
    const mapper = createProgressMapper();
    assert.equal(
      mapper.accept(
        toolCall({
          title: 'read_file',
          locations: ['src/preferred.ts'],
          rawInput: { target_file: 'src/ignored.ts' },
        }),
      )?.message,
      'read_file src/preferred.ts',
    );
    assert.equal(
      mapper.accept(
        toolCall({
          title: 'read_file',
          locations: [],
          rawInput: { target_file: 'src/from-input.ts' },
        }),
      )?.message,
      'read_file src/from-input.ts',
    );
  });

  it('skips a whitespace or non-path rawInput string and takes the first value that looks like a file', () => {
    const mapper = createProgressMapper();
    assert.equal(
      mapper.accept(
        toolCall({
          title: 'write',
          rawInput: { note: 'do the thing', n: 1, path: 'src/a.ts' },
        }),
      )?.message,
      'write src/a.ts',
    );
  });

  it('omits the target when there is no location and no path-like rawInput, rather than guessing', () => {
    const mapper = createProgressMapper();
    assert.equal(
      mapper.accept(toolCall({ title: 'list_dir', rawInput: { query: 'just words' } }))?.message,
      'list_dir',
    );
    assert.equal(mapper.accept(toolCall({ title: 'list_dir', rawInput: {} }))?.message, 'list_dir');
  });

  it('treats an empty locations[0] as absent so a blank path does not hide a usable rawInput target', () => {
    const mapper = createProgressMapper();
    assert.equal(
      mapper.accept(
        toolCall({
          title: 'read_file',
          locations: [''],
          rawInput: { target_file: 'src/main.rs' },
        }),
      )?.message,
      'read_file src/main.rs',
    );
  });

  it('ignores an empty title in favour of toolName, because an empty label is not a name', () => {
    const mapper = createProgressMapper();
    assert.equal(
      mapper.accept(toolCall({ title: '', toolName: 'grep', locations: ['src'] }))?.message,
      'grep src',
    );
  });
});

describe('createProgressMapper tool_call_update', () => {
  it('emits nothing for a null or empty status, because mid-flight updates would double every tool line', () => {
    const mapper = createProgressMapper();
    assert.equal(
      mapper.accept({
        type: 'tool_call_update',
        toolCallId: 'call-1',
        status: null,
        locations: ['.'],
      }),
      null,
    );
    assert.equal(
      mapper.accept({
        type: 'tool_call_update',
        toolCallId: 'call-1',
        status: '',
        locations: [],
      }),
      null,
    );
  });

  it('emits the earlier tool_call label with the terminal status, not the raw toolCallId', () => {
    const mapper = createProgressMapper();
    mapper.accept(
      toolCall({
        toolCallId: 'call-033456f4-0',
        title: 'list_dir',
        locations: ['.'],
      }),
    );
    const emission = mapper.accept({
      type: 'tool_call_update',
      toolCallId: 'call-033456f4-0',
      status: 'completed',
      locations: [],
    });
    assert.ok(emission);
    assert.equal(emission.message, 'list_dir — completed');
    assert.ok(!emission.message.includes('call-033456f4-0'));
  });

  it('falls back to the toolCallId when no label was recorded, and to tool when there is no id either', () => {
    const mapper = createProgressMapper();
    assert.equal(
      mapper.accept({
        type: 'tool_call_update',
        toolCallId: 'call-orphan',
        status: 'completed',
        locations: [],
      })?.message,
      'call-orphan — completed',
    );
    assert.equal(
      mapper.accept({
        type: 'tool_call_update',
        toolCallId: null,
        status: 'failed',
        locations: [],
      })?.message,
      'tool — failed',
    );
    assert.equal(
      mapper.accept({
        type: 'tool_call_update',
        toolCallId: '',
        status: 'failed',
        locations: [],
      })?.message,
      'tool — failed',
    );
  });
});

describe('createProgressMapper text and thought flush', () => {
  it('emits nothing from accept for 500 text deltas, and exactly one message from a following flush', () => {
    const mapper = createProgressMapper();
    for (let index = 0; index < 500; index += 1) {
      assert.equal(mapper.accept({ type: 'text', data: 'x' }), null);
    }
    const emission = mapper.flush();
    assert.ok(emission);
    assert.equal(emission.progress, 1);
    assert.equal(mapper.flush(), null);
  });

  it('collapses newlines, truncates to the 120-character tail, and prefixes an ellipsis when truncated', () => {
    const mapper = createProgressMapper();
    mapper.accept({ type: 'text', data: `${'alpha '.repeat(10)}\n\n${'b'.repeat(130)}` });
    const emission = mapper.flush();
    assert.ok(emission);
    assert.match(emission.message, /^writing: …/);
    const tail = emission.message.slice('writing: '.length);
    assert.ok(tail.startsWith('…'));
    assert.ok(!tail.includes('\n'));
    assert.equal(tail.length, 1 + 120);
    assert.equal(tail.slice(1), 'b'.repeat(120));
  });

  it('returns null from flush when both buffers are empty, so a timer can poll during a long tool call', () => {
    assert.equal(createProgressMapper().flush(), null);
  });

  it('prefers pending text over pending thought and clears both so a later flush does not replay the thought', () => {
    const mapper = createProgressMapper();
    mapper.accept({ type: 'thought', data: 'secret reasoning' });
    mapper.accept({ type: 'text', data: 'visible reply' });
    const emission = mapper.flush();
    assert.ok(emission);
    assert.equal(emission.message, 'writing: visible reply');
    assert.ok(!emission.message.includes('secret'));
    assert.equal(mapper.flush(), null);
  });

  it('emits a thinking line when only thought accumulated', () => {
    const mapper = createProgressMapper();
    mapper.accept({ type: 'thought', data: 'considering\nthe options' });
    assert.equal(mapper.flush()?.message, 'thinking: considering the options');
  });

  it('does not mark truncation when the collapsed tail fits in 120 characters', () => {
    const mapper = createProgressMapper();
    mapper.accept({ type: 'text', data: 'short' });
    assert.equal(mapper.flush()?.message, 'writing: short');
  });

  it('increments progress across accept and flush alike, and never resets', () => {
    const mapper = createProgressMapper();
    assert.equal(mapper.accept(toolCall({ title: 'list_dir', locations: ['.'] }))?.progress, 1);
    mapper.accept({ type: 'text', data: 'hi' });
    assert.equal(mapper.flush()?.progress, 2);
    assert.equal(mapper.accept({ type: 'error', message: 'nope' })?.progress, 3);
  });
});

describe('createProgressMapper other events', () => {
  it('emits a final line naming the stop reason and turn count when both are available', () => {
    const mapper = createProgressMapper();
    assert.equal(
      mapper.accept({
        type: 'end',
        result: { ...EMPTY_RESULT, stopReason: 'end_turn', numTurns: 2 },
      })?.message,
      'finished: end_turn (2 turns)',
    );
  });

  it('names only the stop reason, only the turn count, or neither, rather than inventing missing fields', () => {
    const mapper = createProgressMapper();
    assert.equal(
      mapper.accept({
        type: 'end',
        result: { ...EMPTY_RESULT, stopReason: 'end_turn' },
      })?.message,
      'finished: end_turn',
    );
    assert.equal(
      mapper.accept({ type: 'end', result: { ...EMPTY_RESULT, numTurns: 3 } })?.message,
      'finished: 3 turns',
    );
    assert.equal(mapper.accept({ type: 'end', result: EMPTY_RESULT })?.message, 'finished');
  });

  it('emits the error message, including an empty one, so a failed run is still a progress line', () => {
    const mapper = createProgressMapper();
    assert.equal(
      mapper.accept({ type: 'error', message: 'unknown model id' })?.message,
      'unknown model id',
    );
    assert.equal(mapper.accept({ type: 'error', message: '' })?.message, '');
  });

  it('emits nothing for usage and available_commands, because those events are noise', () => {
    const mapper = createProgressMapper();
    assert.equal(mapper.accept({ type: 'usage', usage: { input_tokens: 1 } }), null);
    assert.equal(mapper.accept({ type: 'other', name: 'available_commands' }), null);
    assert.equal(mapper.accept({ type: 'unparseable', line: '{' }), null);
  });

  it('ignores an unmodelled event without throwing, because a missing progress line is cosmetic where an exception in a stdout handler is fatal', () => {
    const mapper = createProgressMapper();
    const event = { type: 'brand-new' } as unknown as GrokStreamEvent;

    assert.doesNotThrow(() => {
      assert.equal(mapper.accept(event), null);
    });
    // The counter is untouched, so the next real event is still the first emission.
    assert.equal(mapper.accept(toolCall({ title: 'list_dir', locations: ['.'] }))?.progress, 1);
  });
});
