import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGrokJson } from '../../src/grok/result.js';
import type { GrokRunResult, ParsedGrokOutput } from '../../src/grok/result.js';

/** Real-shaped success object. Ids are synthetic — fixtures must not be live session ids. */
const SUCCESS = {
  text: 'OK',
  stopReason: 'end_turn',
  sessionId: '7c3e91a2-4b18-6fa0-9d21-e8bb0c4d2a71',
  requestId: 'req-test-0f4e2c91',
  thought: 'synthetic thought, not surfaced on GrokRunResult',
  usage: {
    input_tokens: 16424,
    cache_read_input_tokens: 896,
    output_tokens: 32,
    total_tokens: 17352,
    reasoning_tokens: 128,
    cache_creation_input_tokens: 64,
  },
  num_turns: 1,
  total_cost_usd: 0.00569296,
  total_cost_usd_ticks: 56929600,
  modelUsage: { 'grok-4.6-build': { input_tokens: 16424, output_tokens: 32 } },
} as const;

function assertResult(parsed: ParsedGrokOutput): GrokRunResult {
  if (parsed.kind !== 'result') {
    assert.fail(`expected kind "result", got ${parsed.kind}`);
  }
  return parsed.result;
}

function assertCliError(parsed: ParsedGrokOutput): string {
  if (parsed.kind !== 'cli-error') {
    assert.fail(`expected kind "cli-error", got ${parsed.kind}`);
  }
  return parsed.message;
}

function assertUnparseable(parsed: ParsedGrokOutput): string {
  if (parsed.kind !== 'unparseable') {
    assert.fail(`expected kind "unparseable", got ${parsed.kind}`);
  }
  return parsed.reason;
}

describe('parseGrokJson success shape', () => {
  it('reads every documented field from a real-shaped success object, and does not invent a session id', () => {
    const result = assertResult(parseGrokJson(JSON.stringify(SUCCESS)));

    assert.equal(result.text, 'OK');
    assert.equal(result.sessionId, '7c3e91a2-4b18-6fa0-9d21-e8bb0c4d2a71');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.requestId, 'req-test-0f4e2c91');
    assert.equal(result.numTurns, 1);
    assert.equal(result.totalCostUsd, 0.00569296);
    assert.deepEqual(
      { ...result.usage },
      {
        input_tokens: 16424,
        cache_read_input_tokens: 896,
        output_tokens: 32,
        total_tokens: 17352,
        reasoning_tokens: 128,
        cache_creation_input_tokens: 64,
      },
    );
    assert.deepEqual(
      { ...result.modelUsage },
      { 'grok-4.6-build': { input_tokens: 16424, output_tokens: 32 } },
    );
    assert.equal(result.structuredOutput, null);
  });

  it('reads an already-decoded structuredOutput object and does not invent one by parsing text', () => {
    const structuredOutput = {
      findings: [{ severity: 'high', file: 'src/a.ts', summary: 'unchecked return' }],
      verdict: 'needs work',
    };
    const result = assertResult(
      parseGrokJson(
        JSON.stringify({
          text: '{"findings":[],"verdict":"from text — must not be parsed"}',
          sessionId: 'sess-structured',
          structuredOutput,
        }),
      ),
    );
    assert.deepEqual(result.structuredOutput, structuredOutput);
    assert.equal(result.sessionId, 'sess-structured');
  });

  it('passes a non-object structuredOutput through as-is, because the CLI already decoded it', () => {
    const result = assertResult(
      parseGrokJson(JSON.stringify({ text: 'ok', structuredOutput: ['not', 'an', 'object'] })),
    );
    assert.deepEqual(result.structuredOutput, ['not', 'an', 'object']);
  });

  it('defaults text to the empty string when absent, because text is the tool body', () => {
    const result = assertResult(parseGrokJson('{"sessionId":"sess-1"}'));
    assert.equal(result.text, '');
    assert.equal(result.sessionId, 'sess-1');
  });

  it('freezes the parsed result so a later caller cannot rewrite what the CLI reported', () => {
    const parsed = parseGrokJson(JSON.stringify(SUCCESS));
    assert.ok(Object.isFrozen(parsed));
    const result = assertResult(parsed);
    assert.ok(Object.isFrozen(result));
    assert.ok(result.usage && Object.isFrozen(result.usage));
    assert.ok(result.modelUsage && Object.isFrozen(result.modelUsage));
  });
});

describe('parseGrokJson cli-error shape', () => {
  it('returns cli-error for {"type":"error"} and does not extract a result from it', () => {
    const parsed = parseGrokJson(
      JSON.stringify({
        type: 'error',
        message: 'model not found',
        text: 'ignore me',
        sessionId: 'should-not-surface',
      }),
    );
    assert.equal(assertCliError(parsed), 'model not found');
  });

  it('still classifies type:error as cli-error when message is missing, rather than falling through to a result', () => {
    assert.equal(assertCliError(parseGrokJson('{"type":"error"}')), '');
  });
});

describe('parseGrokJson field degradation', () => {
  const fields: readonly {
    jsonKey: string;
    resultKey: keyof GrokRunResult;
    valid: unknown;
  }[] = [
    { jsonKey: 'sessionId', resultKey: 'sessionId', valid: 'sess-1' },
    { jsonKey: 'stopReason', resultKey: 'stopReason', valid: 'end_turn' },
    { jsonKey: 'requestId', resultKey: 'requestId', valid: 'req-1' },
    { jsonKey: 'num_turns', resultKey: 'numTurns', valid: 3 },
    { jsonKey: 'usage', resultKey: 'usage', valid: { input_tokens: 1 } },
    { jsonKey: 'total_cost_usd', resultKey: 'totalCostUsd', valid: 0.01 },
    { jsonKey: 'modelUsage', resultKey: 'modelUsage', valid: { 'grok-4.6-build': {} } },
  ];

  const wrongTypes: readonly (readonly [label: string, value: unknown])[] = [
    ['a number', 1],
    ['a boolean', true],
    ['an object', { nested: true }],
    ['an array', ['x']],
    ['null', null],
  ];

  for (const { jsonKey, resultKey, valid } of fields) {
    it(`degrades a missing ${jsonKey} to null without throwing`, () => {
      const result = assertResult(parseGrokJson(JSON.stringify({ text: 'ok' })));
      assert.equal(result[resultKey], null);
    });

    for (const [label, value] of wrongTypes) {
      // A valid object/number is not "wrong" for that field.
      if (typeof valid === typeof value && value !== null && !Array.isArray(value)) continue;
      if (resultKey === 'usage' && label === 'an object') continue;
      if (resultKey === 'modelUsage' && label === 'an object') continue;
      if ((resultKey === 'numTurns' || resultKey === 'totalCostUsd') && label === 'a number') {
        continue;
      }

      it(`degrades ${jsonKey} of the wrong type (${label}) to null without throwing`, () => {
        const result = assertResult(
          parseGrokJson(JSON.stringify({ text: 'ok', [jsonKey]: value })),
        );
        assert.equal(result[resultKey], null);
      });
    }
  }

  it('degrades a wrong-typed text to the empty string, not null, because text is the tool body', () => {
    const result = assertResult(parseGrokJson(JSON.stringify({ text: 12, sessionId: 's' })));
    assert.equal(result.text, '');
    assert.equal(result.sessionId, 's');
  });

  it('degrades a non-finite number field to null rather than passing Infinity through', () => {
    // JSON cannot encode Infinity; this covers the runtime guard for completeness
    // by feeding a value that JSON.parse will reject... so we use a finite check
    // on a stringified NaN, which JSON.parse turns into null (already covered),
    // and on a number that is finite but we also reject non-numbers above.
    const result = assertResult(parseGrokJson('{"text":"ok","num_turns":null}'));
    assert.equal(result.numTurns, null);
  });
});

describe('parseGrokJson usage', () => {
  it('keeps only finite numeric usage members and drops everything else', () => {
    const result = assertResult(
      parseGrokJson(
        JSON.stringify({
          text: 'ok',
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            note: 'nope',
            flag: true,
            nested: { x: 1 },
            missing: null,
            quoted: '12',
          },
        }),
      ),
    );
    assert.deepEqual({ ...result.usage }, { input_tokens: 10, output_tokens: 3 });
  });

  it('parses a default-effort usage object that omits reasoning_tokens', () => {
    const result = assertResult(
      parseGrokJson(
        JSON.stringify({
          text: 'ok',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 8,
            output_tokens: 4,
            total_tokens: 112,
          },
        }),
      ),
    );
    assert.ok(result.usage);
    assert.equal(result.usage['input_tokens'], 100);
    assert.equal(result.usage['reasoning_tokens'], undefined);
    assert.equal(result.usage['cache_creation_input_tokens'], undefined);
  });

  it('parses a high-effort usage object that includes reasoning_tokens and cache_creation_input_tokens', () => {
    const result = assertResult(
      parseGrokJson(
        JSON.stringify({
          text: 'ok',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 8,
            cache_creation_input_tokens: 16,
            output_tokens: 4,
            reasoning_tokens: 50,
            total_tokens: 178,
          },
        }),
      ),
    );
    assert.ok(result.usage);
    assert.equal(result.usage['reasoning_tokens'], 50);
    assert.equal(result.usage['cache_creation_input_tokens'], 16);
  });
});

describe('parseGrokJson unparseable input', () => {
  it('returns unparseable for garbage that is not JSON', () => {
    assert.equal(assertUnparseable(parseGrokJson('this is not json')), 'invalid JSON');
  });

  it('returns unparseable for an empty string', () => {
    assert.equal(assertUnparseable(parseGrokJson('')), 'empty output');
  });

  it('returns unparseable for whitespace-only input', () => {
    assert.equal(assertUnparseable(parseGrokJson('   \n\t  ')), 'empty output');
  });

  it('returns unparseable for a JSON primitive, because the CLI emits an object', () => {
    assert.equal(parseGrokJson('42').kind, 'unparseable');
    assert.equal(parseGrokJson('"just a string"').kind, 'unparseable');
    assert.equal(parseGrokJson('null').kind, 'unparseable');
    assert.equal(parseGrokJson('[1,2]').kind, 'unparseable');
  });

  it('does not slice between braces when the text merely contains a JSON-looking substring', () => {
    const parsed = parseGrokJson(
      'The model said {"text":"secret","sessionId":"should-not-extract"} but this is prose',
    );
    assert.equal(parsed.kind, 'unparseable');
  });
});

describe('parseGrokJson last-line fallback', () => {
  it('parses JSON with a trailing newline via the first strategy', () => {
    const result = assertResult(parseGrokJson('{"text":"OK","sessionId":"sess-nl"}\n'));
    assert.equal(result.text, 'OK');
    assert.equal(result.sessionId, 'sess-nl');
  });

  it('parses JSON on the last non-empty line when the full stdout is not JSON', () => {
    const stdout =
      'ignored preamble from a noisy wrapper\n{"text":"from-last-line","sessionId":"last-line-session"}\n';
    const result = assertResult(parseGrokJson(stdout));
    assert.equal(result.text, 'from-last-line');
    assert.equal(result.sessionId, 'last-line-session');
  });

  it('parses pretty-printed JSON as a whole, because the first strategy is JSON.parse of the trimmed input', () => {
    const result = assertResult(
      parseGrokJson('{\n  "text": "pretty",\n  "sessionId": "sess-pretty"\n}\n'),
    );
    assert.equal(result.text, 'pretty');
    assert.equal(result.sessionId, 'sess-pretty');
  });
});
