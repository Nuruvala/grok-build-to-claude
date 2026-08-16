import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import { REVIEW_FINDINGS_SCHEMA, buildReviewPrompt } from '../../src/review/prompt.js';
import type { ReviewPromptParams } from '../../src/review/prompt.js';

function params(overrides: Partial<ReviewPromptParams> = {}): ReviewPromptParams {
  return {
    targetDescription: 'working tree (staged, unstaged, and untracked)',
    diff: 'diff --git a/a.ts b/a.ts\n+ok\n',
    truncationNotice: null,
    structured: false,
    ...overrides,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.ok(value !== null);
  assert.ok(!Array.isArray(value));
  return value as Record<string, unknown>;
}

describe('REVIEW_FINDINGS_SCHEMA', () => {
  it('parses as JSON and declares the required findings object plus an optional verdict', () => {
    const schema = asRecord(JSON.parse(REVIEW_FINDINGS_SCHEMA));
    assert.equal(schema['type'], 'object');
    assert.deepEqual(schema['required'], ['findings']);

    const properties = asRecord(schema['properties']);
    assert.ok('findings' in properties);
    assert.ok('verdict' in properties);
    assert.equal(asRecord(properties['verdict'])['type'], 'string');

    const findings = asRecord(properties['findings']);
    assert.equal(findings['type'], 'array');
    const items = asRecord(findings['items']);
    assert.deepEqual(items['required'], ['severity', 'file', 'summary', 'rationale']);

    const itemProperties = asRecord(items['properties']);
    assert.deepEqual(asRecord(itemProperties['severity'])['enum'], [
      'critical',
      'high',
      'medium',
      'low',
      'info',
    ]);
    assert.equal(asRecord(itemProperties['file'])['type'], 'string');
    assert.equal(asRecord(itemProperties['summary'])['type'], 'string');
    assert.equal(asRecord(itemProperties['rationale'])['type'], 'string');
    assert.equal(asRecord(itemProperties['line'])['type'], 'integer');
    const itemRequired = items['required'];
    assert.ok(Array.isArray(itemRequired));
    assert.ok(!itemRequired.includes('line'));
    const schemaRequired = schema['required'];
    assert.ok(Array.isArray(schemaRequired));
    assert.ok(!schemaRequired.includes('verdict'));
  });
});

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

  it('instructs the model to answer with JSON matching the schema and nothing else when structured is true', () => {
    const prompt = buildReviewPrompt(params({ structured: true }));
    assert.match(prompt, /JSON object matching the following schema/);
    assert.match(prompt, /nothing else/);
    assert.ok(prompt.includes(REVIEW_FINDINGS_SCHEMA));
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
