import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractFindings } from '../../src/review/findings.js';
import type { FindingsExtraction, ReviewFindings } from '../../src/review/findings.js';

function assertFinal(extraction: FindingsExtraction): ReviewFindings {
  if (extraction.kind !== 'final') {
    assert.fail(`expected kind "final", got ${extraction.kind}`);
  }
  return extraction.findings;
}

function assertWorking(extraction: FindingsExtraction): void {
  if (extraction.kind !== 'working') {
    assert.fail(`expected kind "working", got ${extraction.kind}`);
  }
}

function assertInvalid(extraction: FindingsExtraction): {
  text: string;
  parseError: string;
} {
  if (extraction.kind !== 'invalid') {
    assert.fail(`expected kind "invalid", got ${extraction.kind}`);
  }
  return { text: extraction.text, parseError: extraction.parseError };
}

const FINDING = {
  severity: 'high',
  file: 'src/a.ts',
  summary: 'unchecked return',
  rationale: 'the error is dropped',
  line: 12,
} as const;

const FINAL: ReviewFindings = {
  status: 'final',
  findings: [FINDING],
  verdict: 'needs work',
};

const WORKING = {
  status: 'working',
  findings: [] as const,
} as const;

describe('extractFindings structuredOutput wins', () => {
  it('returns a final extraction from structuredOutput and does not parse text, because the CLI already decoded it', () => {
    const extraction = extractFindings(FINAL, 'this is not json and must be ignored');
    assert.deepEqual(assertFinal(extraction), FINAL);
  });

  it('still prefers structuredOutput when text is also valid JSON, so we never second-guess the CLI', () => {
    const fromText = { status: 'final', findings: [], verdict: 'from text' };
    const extraction = extractFindings(FINAL, JSON.stringify(fromText));
    assert.deepEqual(assertFinal(extraction), FINAL);
  });

  it('classifies a valid working structuredOutput as working, discarding any findings it carried', () => {
    const fabricated = {
      status: 'working',
      findings: [FINDING],
      verdict: 'placeholder',
    };
    const extraction = extractFindings(fabricated, JSON.stringify(FINAL));
    assertWorking(extraction);
    assert.equal('findings' in extraction, false);
  });

  it('treats a present structuredOutput of the wrong shape as invalid, and does not fall through to text', () => {
    const empty = {};
    const { text, parseError } = assertInvalid(extractFindings(empty, JSON.stringify(FINAL)));
    assert.equal(text, JSON.stringify(FINAL));
    assert.match(parseError, /status/);
  });

  it('treats a non-null structuredOutput that fails validation as invalid even when text is valid JSON', () => {
    for (const structuredOutput of ['nope', 1, true, ['not', 'an', 'object']]) {
      const extraction = extractFindings(structuredOutput, JSON.stringify(FINAL));
      assertInvalid(extraction);
    }
  });

  it('freezes the wrapper so a later caller cannot rewrite the kind', () => {
    const extraction = extractFindings(FINAL, '');
    assert.ok(Object.isFrozen(extraction));
    assert.ok(Object.isFrozen(assertFinal(extraction)));
  });
});

describe('extractFindings falls through to whole-text JSON', () => {
  it('parses text as final when structuredOutput is absent', () => {
    const parsed = assertFinal(extractFindings(undefined, JSON.stringify(FINAL)));
    assert.deepEqual(parsed, FINAL);
  });

  it('parses text as working when structuredOutput is absent and status is working', () => {
    assertWorking(extractFindings(undefined, JSON.stringify(WORKING)));
  });

  it('parses text when structuredOutput is null, because null means the CLI did not supply one', () => {
    const parsed = assertFinal(extractFindings(null, JSON.stringify(FINAL)));
    assert.deepEqual(parsed, FINAL);
  });

  it('trims surrounding whitespace before parsing, without treating that as fence-stripping', () => {
    const parsed = assertFinal(extractFindings(null, `  \n${JSON.stringify(FINAL)}\n  `));
    assert.deepEqual(parsed, FINAL);
  });
});

describe('extractFindings invalid failures', () => {
  it('names empty text when there is nothing to parse', () => {
    const { text, parseError } = assertInvalid(extractFindings(undefined, ''));
    assert.equal(text, '');
    assert.equal(parseError, 'empty text');
  });

  it('names empty text when the body is only whitespace', () => {
    const { text, parseError } = assertInvalid(extractFindings(null, '  \n\t  '));
    assert.equal(text, '  \n\t  ');
    assert.equal(parseError, 'empty text');
  });

  it('names invalid JSON when the text does not parse, and keeps the original text', () => {
    const raw = 'not json at all';
    const { text, parseError } = assertInvalid(extractFindings(undefined, raw));
    assert.equal(text, raw);
    assert.equal(parseError, 'invalid JSON');
  });

  it('does not slice between the first { and the last } to recover a nested object — that is the plugin scrape', () => {
    const raw = 'Here is the review: {"status":"final","findings":[],"verdict":"ok"} thanks';
    const { parseError } = assertInvalid(extractFindings(null, raw));
    assert.equal(parseError, 'invalid JSON');
  });

  it('classifies valid JSON that fails schema validation as invalid, not as final', () => {
    const raw = JSON.stringify({ status: 'final' });
    const { text, parseError } = assertInvalid(extractFindings(undefined, raw));
    assert.equal(text, raw);
    assert.notEqual(parseError, 'invalid JSON');
    assert.notEqual(parseError, 'empty text');
    assert.match(parseError, /findings/);
  });

  it('classifies valid JSON that is an array rather than an object as invalid', () => {
    const raw = JSON.stringify([FINAL]);
    const { text, parseError } = assertInvalid(extractFindings(undefined, raw));
    assert.equal(text, raw);
    assert.notEqual(parseError, 'invalid JSON');
    assert.notEqual(parseError, 'empty text');
  });
});

describe('extractFindings does not scrape markdown fences', () => {
  it('does not strip a ```json fence to recover a structured result — that is the plugin bug', () => {
    const inner = JSON.stringify(FINAL);
    const fenced = `\`\`\`json\n${inner}\n\`\`\``;
    const { text, parseError } = assertInvalid(extractFindings(null, fenced));
    assert.equal(text, fenced);
    assert.equal(parseError, 'invalid JSON');
  });

  it('does not strip a bare ``` fence either', () => {
    const fenced = `\`\`\`\n${JSON.stringify(FINAL)}\n\`\`\``;
    const { parseError } = assertInvalid(extractFindings(undefined, fenced));
    assert.equal(parseError, 'invalid JSON');
  });
});

describe('extractFindings does not decode a sequence of JSON values', () => {
  it('classifies two concatenated schema-valid objects as invalid, never final — taking the last one would surface working-turn narration as findings', () => {
    const working = JSON.stringify(WORKING);
    const final = JSON.stringify(FINAL);
    const concatenated = `${working}${final}`;
    const extraction = extractFindings(undefined, concatenated);
    const { text, parseError } = assertInvalid(extraction);
    assert.equal(extraction.kind, 'invalid');
    assert.notEqual(extraction.kind, 'final');
    assert.equal(text, concatenated);
    assert.equal(parseError, 'invalid JSON');
  });
});
