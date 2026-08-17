import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import { buildWebSearchPrompt } from '../../src/websearch/prompt.js';
import type { WebSearchPromptParams } from '../../src/websearch/prompt.js';

function params(overrides: Partial<WebSearchPromptParams> = {}): WebSearchPromptParams {
  return {
    query: 'What is the latest LTS Node.js?',
    depth: 'basic',
    ...overrides,
  };
}

const INTRO =
  'Answer the question below using web search. Search now rather than answering from what you already know — the answer must reflect current sources.';

const BASIC = 'One round of searching is enough. Answer directly and keep it short.';

const FULL =
  'Search more than once, from different angles. Prefer primary and official sources over aggregators and summaries, cross-check anything the sources disagree on, and say so explicitly when they conflict.';

const CITE =
  'Cite every factual claim with the URL it came from, as a markdown link. Do not cite a source you did not actually open or receive in a search result.';

const CONSTRAINT =
  'You have no shell and cannot edit files in this run: `run_terminal_command` and the edit tools are denied. Use your web search and page tools and answer without them.';

describe('buildWebSearchPrompt', () => {
  it('is deterministic: identical params produce byte-identical output', () => {
    const input = params({
      numResults: 8,
      depth: 'full',
      instructions: 'Prefer nodejs.org.',
    });
    const first = buildWebSearchPrompt(input);
    const second = buildWebSearchPrompt(input);
    assert.equal(first, second);
    assert.equal(Buffer.byteLength(first), Buffer.byteLength(second));
  });

  it('joins sections with blank lines in the specified order for basic depth without numResults', () => {
    const prompt = buildWebSearchPrompt(params());
    assert.equal(
      prompt,
      [INTRO, 'Question:\nWhat is the latest LTS Node.js?', BASIC, CITE, CONSTRAINT].join('\n\n'),
    );
  });

  it('uses the full-depth clause when depth is full', () => {
    const prompt = buildWebSearchPrompt(params({ depth: 'full' }));
    assert.ok(prompt.includes(FULL));
    assert.ok(!prompt.includes(BASIC));
    const introAt = prompt.indexOf(INTRO);
    const questionAt = prompt.indexOf('Question:\n');
    const depthAt = prompt.indexOf(FULL);
    const citeAt = prompt.indexOf(CITE);
    assert.ok(introAt < questionAt && questionAt < depthAt && depthAt < citeAt);
  });

  it('inserts the numResults clause only when set, between depth and the cite rule', () => {
    const withCount = buildWebSearchPrompt(params({ numResults: 12 }));
    assert.ok(withCount.includes('Cite about 12 distinct sources.'));
    const depthAt = withCount.indexOf(BASIC);
    const countAt = withCount.indexOf('Cite about 12 distinct sources.');
    const citeAt = withCount.indexOf(CITE);
    assert.ok(depthAt < countAt && countAt < citeAt);

    const without = buildWebSearchPrompt(params());
    assert.ok(!without.includes('Cite about'));
  });

  it('appends caller instructions in the same two-part shape review uses, and omits the block when they are absent', () => {
    const withInstructions = buildWebSearchPrompt(
      params({ instructions: 'Prefer primary sources from nodejs.org.' }),
    );
    assert.ok(
      withInstructions.endsWith(
        'Additional instructions from the caller:\n\nPrefer primary sources from nodejs.org.',
      ),
    );

    const without = buildWebSearchPrompt(params());
    assert.ok(!without.includes('Additional instructions from the caller:'));
  });

  it('does not tell the model to avoid X search', () => {
    const prompt = buildWebSearchPrompt(params({ depth: 'full', instructions: 'Be thorough.' }));
    assert.doesNotMatch(prompt, /\bX search\b/i);
    assert.doesNotMatch(prompt, /\bx\.com\b/i);
  });
});
