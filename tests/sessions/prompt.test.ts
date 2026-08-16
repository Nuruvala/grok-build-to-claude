import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractFirstPrompt } from '../../src/sessions/prompt.js';

function line(value: unknown): string {
  return JSON.stringify(value);
}

function userLine(text: string, extra: Record<string, unknown> = {}): string {
  return line({
    type: 'user',
    content: [{ type: 'text', text }],
    ...extra,
  });
}

const SYSTEM = line({ type: 'system', content: [] });
const SYNTHETIC = userLine('<system-reminder>\nignore me\n</system-reminder>', {
  synthetic_reason: 'system_reminder',
});
const ENV = userLine('<user_info>\nOS Version: linux\n</user_info>');

describe('extractFirstPrompt', () => {
  it('finds the prompt_index line past system and synthetic user lines', () => {
    const head = [
      SYSTEM,
      ENV,
      SYNTHETIC,
      userLine('<user_query>\nFix the login form\n</user_query>', { prompt_index: 0 }),
    ].join('\n');

    assert.equal(extractFirstPrompt(head), 'Fix the login form');
  });

  it('falls back to the first user line whose text contains <user_query> when no prompt_index exists', () => {
    const head = [
      SYSTEM,
      SYNTHETIC,
      userLine('<user_query>\nAppstore version just released\n</user_query>'),
    ].join('\n');

    assert.equal(extractFirstPrompt(head), 'Appstore version just released');
  });

  it('strips a wrapping <user_query> pair and collapses whitespace', () => {
    const head = userLine('<user_query>\n  hello\n\tthere  \n</user_query>', { prompt_index: 0 });
    assert.equal(extractFirstPrompt(head), 'hello there');
  });

  it('strips a leading <user_query> when the close tag is absent, as an offloaded prompt is stored', () => {
    const head = userLine('<user_query> # padding # padding # padding …', { prompt_index: 0 });
    assert.equal(extractFirstPrompt(head), '# padding # padding # padding …');
  });

  it('strips a trailing </user_query> when the open tag is absent', () => {
    const head = userLine('hello world\n</user_query>', { prompt_index: 0 });
    assert.equal(extractFirstPrompt(head), 'hello world');
  });

  it('strips both tags when they wrap the prompt', () => {
    const head = userLine('<user_query>\nboth tags present\n</user_query>', { prompt_index: 0 });
    assert.equal(extractFirstPrompt(head), 'both tags present');
  });

  it('leaves a prompt with neither tag unchanged, aside from whitespace collapse', () => {
    const head = userLine('  no tags here  ', { prompt_index: 0 });
    assert.equal(extractFirstPrompt(head), 'no tags here');
  });

  it('leaves a <user_query> tag in the middle of the prompt alone', () => {
    const wrapped = userLine(
      '<user_query>\nhello <user_query> inner</user_query> world\n</user_query>',
      { prompt_index: 0 },
    );
    assert.equal(extractFirstPrompt(wrapped), 'hello <user_query> inner</user_query> world');

    const unwrapped = userLine('hello <user_query> world', { prompt_index: 0 });
    assert.equal(extractFirstPrompt(unwrapped), 'hello <user_query> world');
  });

  it('prefers a later prompt_index line over an earlier <user_query> fallback', () => {
    const head = [
      userLine('<user_query>\nnot this one\n</user_query>'),
      userLine('<user_query>\nthe real prompt\n</user_query>', { prompt_index: 0 }),
    ].join('\n');

    assert.equal(extractFirstPrompt(head), 'the real prompt');
  });

  it('ignores a truncated final line rather than throwing', () => {
    const head = [
      SYSTEM,
      userLine('<user_query>\ncomplete\n</user_query>', { prompt_index: 0 }),
      '{"type":"user","content":[{"type":"text","text":"cut off',
    ].join('\n');

    assert.equal(extractFirstPrompt(head), 'complete');
  });

  it('skips unparseable lines in the middle', () => {
    const head = [
      'not json at all',
      '{broken',
      userLine('<user_query>\nafter garbage\n</user_query>', { prompt_index: 0 }),
    ].join('\n');

    assert.equal(extractFirstPrompt(head), 'after garbage');
  });

  it('returns null when the history has no user line', () => {
    const head = [SYSTEM, line({ type: 'assistant', content: [] })].join('\n');
    assert.equal(extractFirstPrompt(head), null);
  });

  it('returns null for an empty head', () => {
    assert.equal(extractFirstPrompt(''), null);
  });

  it('caps the prompt at 4000 characters', () => {
    const long = 'a'.repeat(5000);
    const head = userLine(`<user_query>\n${long}\n</user_query>`, { prompt_index: 0 });
    const extracted = extractFirstPrompt(head);
    assert.ok(extracted !== null);
    assert.equal(extracted.length, 4000);
    assert.equal(extracted, 'a'.repeat(4000));
  });

  it('joins multiple text blocks in the same user message', () => {
    const head = line({
      type: 'user',
      prompt_index: 0,
      content: [
        { type: 'text', text: '<user_query>\nhello ' },
        { type: 'text', text: 'world\n</user_query>' },
      ],
    });
    assert.equal(extractFirstPrompt(head), 'hello world');
  });
});
