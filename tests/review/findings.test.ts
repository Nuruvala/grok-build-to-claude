import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractFindings } from '../../src/review/findings.js';
import type { FindingsExtraction } from '../../src/review/findings.js';

function assertStructured(extraction: FindingsExtraction): unknown {
  if (extraction.kind !== 'structured') {
    assert.fail(`expected kind "structured", got ${extraction.kind}`);
  }
  return extraction.findings;
}

function assertUnstructured(extraction: FindingsExtraction): {
  text: string;
  parseError: string;
} {
  if (extraction.kind !== 'unstructured') {
    assert.fail(`expected kind "unstructured", got ${extraction.kind}`);
  }
  return { text: extraction.text, parseError: extraction.parseError };
}

const FINDINGS = {
  findings: [
    {
      severity: 'high',
      file: 'src/a.ts',
      summary: 'unchecked return',
      rationale: 'the error is dropped',
      line: 12,
    },
  ],
  verdict: 'needs work',
} as const;

describe('extractFindings structuredOutput wins', () => {
  it('returns the already-decoded structuredOutput object and does not parse text, because the CLI already decoded it', () => {
    const extraction = extractFindings(FINDINGS, 'this is not json and must be ignored');
    assert.equal(assertStructured(extraction), FINDINGS);
  });

  it('still prefers structuredOutput when text is also valid JSON, so we never second-guess the CLI', () => {
    const fromText = { findings: [], verdict: 'from text' };
    const extraction = extractFindings(FINDINGS, JSON.stringify(fromText));
    assert.equal(assertStructured(extraction), FINDINGS);
  });

  it('treats an empty object as structured, because a non-null object is enough — we do not re-validate the schema', () => {
    const empty = {};
    assert.equal(assertStructured(extractFindings(empty, '')), empty);
  });

  it('freezes the wrapper so a later caller cannot rewrite the kind', () => {
    const extraction = extractFindings(FINDINGS, '');
    assert.ok(Object.isFrozen(extraction));
  });
});

describe('extractFindings falls through to whole-text JSON', () => {
  it('parses text as JSON when structuredOutput is absent', () => {
    const parsed = assertStructured(extractFindings(undefined, JSON.stringify(FINDINGS)));
    assert.deepEqual(parsed, FINDINGS);
  });

  it('parses text when structuredOutput is null, a primitive, or an array, because those are not objects', () => {
    const json = JSON.stringify(FINDINGS);
    for (const structuredOutput of [null, 'nope', 1, true, ['not', 'an', 'object']]) {
      const parsed = assertStructured(extractFindings(structuredOutput, json));
      assert.deepEqual(parsed, FINDINGS);
    }
  });

  it('trims surrounding whitespace before parsing, without treating that as fence-stripping', () => {
    const parsed = assertStructured(extractFindings(null, `  \n${JSON.stringify(FINDINGS)}\n  `));
    assert.deepEqual(parsed, FINDINGS);
  });
});

describe('extractFindings unstructured failures', () => {
  it('names empty text when there is nothing to parse', () => {
    const { text, parseError } = assertUnstructured(extractFindings(undefined, ''));
    assert.equal(text, '');
    assert.match(parseError, /empty text/);
  });

  it('names empty text when the body is only whitespace', () => {
    const { text, parseError } = assertUnstructured(extractFindings(null, '  \n\t  '));
    assert.equal(text, '  \n\t  ');
    assert.match(parseError, /empty text/);
  });

  it('names invalid JSON when the text does not parse, and keeps the original text', () => {
    const raw = 'not json at all';
    const { text, parseError } = assertUnstructured(extractFindings(undefined, raw));
    assert.equal(text, raw);
    assert.match(parseError, /invalid JSON/);
  });

  it('does not slice between the first { and the last } to recover a nested object — that is the plugin scrape', () => {
    const raw = 'Here is the review: {"findings":[],"verdict":"ok"} thanks';
    const { parseError } = assertUnstructured(extractFindings(null, raw));
    assert.match(parseError, /invalid JSON/);
  });

  const nonObjects: readonly { label: string; json: string }[] = [
    { label: 'null', json: 'null' },
    { label: 'an array', json: '[]' },
    { label: 'a string', json: '"hi"' },
    { label: 'a number', json: '3' },
    { label: 'a boolean', json: 'true' },
  ];

  for (const { label, json } of nonObjects) {
    it(`names a JSON value that is not an object when text parses as ${label}`, () => {
      const { text, parseError } = assertUnstructured(extractFindings(undefined, json));
      assert.equal(text, json);
      assert.match(parseError, /not an object/);
    });
  }
});

describe('extractFindings does not scrape markdown fences', () => {
  it('does not strip a ```json fence to recover a structured result — that is the plugin bug', () => {
    const inner = JSON.stringify(FINDINGS);
    const fenced = `\`\`\`json\n${inner}\n\`\`\``;
    const { text, parseError } = assertUnstructured(extractFindings(null, fenced));
    assert.equal(text, fenced);
    assert.match(parseError, /invalid JSON/);
  });

  it('does not strip a bare ``` fence either', () => {
    const fenced = `\`\`\`\n${JSON.stringify(FINDINGS)}\n\`\`\``;
    const { parseError } = assertUnstructured(extractFindings(undefined, fenced));
    assert.match(parseError, /invalid JSON/);
  });
});
