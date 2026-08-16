import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import { buildReviewPrompt } from '../../src/review/prompt.js';
import type { ReviewPromptParams } from '../../src/review/prompt.js';
import { REVIEW_FINDINGS_SCHEMA } from '../../src/review/schema.js';

function params(overrides: Partial<ReviewPromptParams> = {}): ReviewPromptParams {
  return {
    targetDescription: 'working tree (staged, unstaged, and untracked)',
    diff: 'diff --git a/a.ts b/a.ts\n+ok\n',
    truncationNotice: null,
    structured: false,
    ...overrides,
  };
}

describe('buildReviewPrompt', () => {
  it('is deterministic: identical params produce byte-identical output', () => {
    const input = params({
      instructions: 'Focus on auth.',
      truncationNotice: 'Diff truncated; 2 files omitted.',
      structured: true,
    });
    const first = buildReviewPrompt(input);
    const second = buildReviewPrompt(input);
    assert.equal(first, second);
    assert.equal(Buffer.byteLength(first), Buffer.byteLength(second));
  });

  it('states the target, then embeds the already-truncated diff in a fenced block', () => {
    const prompt = buildReviewPrompt(
      params({
        targetDescription: 'diff against origin/main',
        diff: 'diff --git a/x.ts b/x.ts\n+hello\n',
      }),
    );
    assert.match(prompt, /diff against origin\/main/);
    const fence = prompt.indexOf('```diff');
    const targetAt = prompt.indexOf('diff against origin/main');
    const close = prompt.indexOf('```', fence + 1);
    assert.ok(targetAt !== -1 && fence !== -1 && close !== -1);
    assert.ok(targetAt < fence, 'target must come before the diff fence');
    assert.match(prompt.slice(fence, close), /\+hello/);
  });

  it('asks for prose grouped by severity when structured is false', () => {
    const prompt = buildReviewPrompt(params({ structured: false }));
    assert.match(prompt, /grouped by severity/);
    assert.ok(!prompt.includes(REVIEW_FINDINGS_SCHEMA));
  });

  it('states the working/final status contract when structured is true', () => {
    const prompt = buildReviewPrompt(params({ structured: true }));
    assert.match(
      prompt,
      /Every message you emit must be a single JSON object matching the schema below/,
    );
    assert.match(prompt, /nothing else/);
    assert.match(prompt, /Do not wrap it in a markdown fence/);
    assert.match(prompt, /\{"status":"working","findings":\[\]\}/);
    assert.match(prompt, /Never describe your own progress as a finding/);
    assert.match(prompt, /"status":"final"/);
    assert.match(prompt, /exactly once/);
    assert.ok(prompt.includes(REVIEW_FINDINGS_SCHEMA));
  });

  it('does not mention the working/final status contract in prose mode', () => {
    const prompt = buildReviewPrompt(params({ structured: false }));
    assert.match(prompt, /grouped by severity/);
    assert.doesNotMatch(prompt, /"status":"working"/);
    assert.doesNotMatch(prompt, /"status":"final"/);
    assert.ok(!prompt.includes(REVIEW_FINDINGS_SCHEMA));
  });

  it('renders a context block immediately before the diff fence when context is present', () => {
    const context = 'main\n[only the first 100 untracked files were included]';
    const prompt = buildReviewPrompt(params({ context }));
    assert.match(prompt, /Context for this target:/);
    assert.ok(prompt.includes(context));
    const contextAt = prompt.indexOf('Context for this target:');
    const fenceAt = prompt.indexOf('```diff');
    assert.ok(contextAt !== -1 && fenceAt !== -1);
    assert.ok(contextAt < fenceAt, 'context must precede the diff fence');
  });

  it('omits the context block when context is absent, empty, or whitespace-only', () => {
    const heading = 'Context for this target:';
    assert.ok(!buildReviewPrompt(params()).includes(heading));
    assert.ok(!buildReviewPrompt(params({ context: '' })).includes(heading));
    assert.ok(!buildReviewPrompt(params({ context: '   \n\t  ' })).includes(heading));
    assert.ok(!buildReviewPrompt(params({ context: undefined })).includes(heading));
  });

  it('appends caller instructions verbatim under a clear heading when they are present', () => {
    const instructions = 'Ignore style nits.\nFocus on races.';
    const prompt = buildReviewPrompt(params({ instructions }));
    assert.match(prompt, /Additional instructions from the caller:/);
    const heading = prompt.indexOf('Additional instructions from the caller:');
    assert.ok(heading !== -1);
    assert.equal(prompt.includes(instructions, heading), true);
  });

  it('does not invent an instructions heading when the caller passed nothing or an empty string', () => {
    assert.ok(!buildReviewPrompt(params()).includes('Additional instructions from the caller:'));
    assert.ok(
      !buildReviewPrompt(params({ instructions: '' })).includes(
        'Additional instructions from the caller:',
      ),
    );
    assert.ok(
      !buildReviewPrompt(params({ instructions: undefined })).includes(
        'Additional instructions from the caller:',
      ),
    );
  });

  it('appends the truncation notice when present, after the instructions', () => {
    const instructions = 'Keep it short.';
    const truncationNotice = 'Diff truncated after src/big.ts; 3 files (12000 bytes) omitted.';
    const prompt = buildReviewPrompt(params({ instructions, truncationNotice }));
    const noticeAt = prompt.indexOf(truncationNotice);
    const instructionsAt = prompt.indexOf(instructions);
    assert.ok(noticeAt !== -1);
    assert.ok(instructionsAt !== -1);
    assert.ok(instructionsAt < noticeAt, 'instructions must precede the truncation notice');
  });

  it('omits the truncation notice when it is null', () => {
    const prompt = buildReviewPrompt(params({ truncationNotice: null }));
    assert.ok(!prompt.toLowerCase().includes('truncated'));
  });

  it('tells the model not to rediscover the diff, because we already collected it', () => {
    const prompt = buildReviewPrompt(params());
    assert.match(prompt, /do not rediscover/i);
  });

  it('tells the reviewer it has no shell, before the mode-specific instructions, in both modes', () => {
    const sentence =
      'You have no shell and no ability to edit files in this run: `run_terminal_command` and the edit tools are denied. Review the diff above, reading files for context if you need them, and answer without them.';

    for (const structured of [false, true]) {
      const prompt = buildReviewPrompt(params({ structured }));
      const sentenceAt = prompt.indexOf(sentence);
      const fenceClose = prompt.indexOf('\n```', prompt.indexOf('```diff'));
      assert.ok(
        sentenceAt !== -1,
        `expected the no-shell sentence in structured=${String(structured)}`,
      );
      assert.ok(fenceClose !== -1);
      assert.ok(
        sentenceAt > fenceClose,
        'the sentence refers to the diff above, so it follows the fence',
      );

      const modeAt = structured
        ? prompt.indexOf('Every message you emit must be a single JSON object')
        : prompt.indexOf('grouped by severity');
      assert.ok(modeAt !== -1);
      assert.ok(sentenceAt < modeAt, 'the shared sentence must precede mode-specific instructions');
    }
  });
});

describe('buildReviewPrompt fences a diff that contains backticks', () => {
  /** Everything after the fence that closes the diff block. */
  function tail(prompt: string, fence: string): string {
    const open = prompt.indexOf(`${fence}diff\n`);
    assert.notStrictEqual(open, -1, 'the opening fence must be present');
    const close = prompt.indexOf(`\n${fence}`, open + fence.length + 6);
    assert.notStrictEqual(close, -1, 'the closing fence must be present');
    return prompt.slice(close);
  }

  it('uses a plain three-backtick fence when the diff has none', () => {
    const prompt = buildReviewPrompt(params({ diff: '+const a = 1;' }));
    assert.ok(prompt.includes('```diff\n+const a = 1;\n```'));
  });

  it('grows the fence past the longest backtick run, so a diff of Markdown cannot break out', () => {
    // The case that motivated this: reviewing this repo's own docs, whose diffs are full of
    // fenced code blocks. A fixed ``` fence closes at the first one, and every later diff line
    // stops being quoted content and starts reading as prose the model may act on.
    const diff = ['+# Heading', '+', '+```bash', '+npm test', '+```'].join('\n');
    const prompt = buildReviewPrompt(params({ diff }));

    const fence = '````';
    assert.ok(prompt.includes(`${fence}diff\n${diff}\n${fence}`), 'diff must be fenced with ````');
    assert.ok(
      !tail(prompt, fence).includes('npm test'),
      'no diff content may survive past the closing fence',
    );
  });

  it('outgrows a diff that already contains the longer fence too', () => {
    const diff = '+````\n+not the end\n+````';
    const prompt = buildReviewPrompt(params({ diff }));
    assert.ok(prompt.includes('`````diff\n'));
    assert.ok(!tail(prompt, '`````').includes('not the end'));
  });
});
