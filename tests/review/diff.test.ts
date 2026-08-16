import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import { truncateDiff } from '../../src/review/diff.js';

function fileSection(path: string, body: string): string {
  return `diff --git a/${path} b/${path}\n${body}`;
}

describe('truncateDiff no truncation', () => {
  it('returns the original text when the diff is under the cap', () => {
    const diff = fileSection('a.ts', '+ok\n');
    const result = truncateDiff(diff, Buffer.byteLength(diff) + 16);
    assert.equal(result.text, diff);
    assert.equal(result.truncated, false);
    assert.equal(result.omittedBytes, 0);
    assert.deepEqual([...result.omittedFiles], []);
  });

  it('returns the original text when the diff fits the cap exactly', () => {
    const diff = fileSection('a.ts', '+ok\n');
    const result = truncateDiff(diff, Buffer.byteLength(diff));
    assert.equal(result.text, diff);
    assert.equal(result.truncated, false);
    assert.equal(result.omittedBytes, 0);
    assert.deepEqual([...result.omittedFiles], []);
  });

  it('returns an empty untruncated result for an empty diff', () => {
    const result = truncateDiff('', 64);
    assert.equal(result.text, '');
    assert.equal(result.truncated, false);
    assert.equal(result.omittedBytes, 0);
    assert.deepEqual([...result.omittedFiles], []);
  });

  it('keeps a diff with no git headers as a single section when it fits', () => {
    const diff = 'not a git diff, just text\n';
    const result = truncateDiff(diff, 1024);
    assert.equal(result.text, diff);
    assert.equal(result.truncated, false);
  });
});

describe('truncateDiff file-boundary cuts', () => {
  it('keeps whole file sections and drops the rest at a file boundary', () => {
    const first = fileSection('a.ts', '+aaa\n');
    const second = fileSection('b.ts', '+bbb\n');
    const result = truncateDiff(first + second, Buffer.byteLength(first));
    assert.equal(result.text, first);
    assert.equal(result.truncated, true);
    assert.equal(result.omittedBytes, Buffer.byteLength(second));
    assert.deepEqual([...result.omittedFiles], ['b.ts']);
  });

  it('drops every remaining file once one no longer fits, rather than skipping a large file to keep a later small one', () => {
    const first = fileSection('a.ts', '+a\n');
    const second = fileSection('b.ts', '+bbbbbbbb\n');
    const third = fileSection('c.ts', '+c\n');
    const result = truncateDiff(first + second + third, Buffer.byteLength(first) + 4);
    assert.equal(result.text, first);
    assert.equal(result.truncated, true);
    assert.deepEqual([...result.omittedFiles], ['b.ts', 'c.ts']);
    assert.equal(result.omittedBytes, Buffer.byteLength(second + third));
  });

  it('keeps the first two files when they fit and omits only the third', () => {
    const first = fileSection('a.ts', '+a\n');
    const second = fileSection('b.ts', '+b\n');
    const third = fileSection('c.ts', '+c\n');
    const cap = Buffer.byteLength(first + second);
    const result = truncateDiff(first + second + third, cap);
    assert.equal(result.text, first + second);
    assert.deepEqual([...result.omittedFiles], ['c.ts']);
  });

  it('keeps a preamble attached as its own section when it still fits with the first file', () => {
    const preamble = 'warning: leftover conflict files\n';
    const file = fileSection('a.ts', '+a\n');
    const result = truncateDiff(preamble + file, Buffer.byteLength(preamble + file));
    assert.equal(result.text, preamble + file);
    assert.equal(result.truncated, false);
  });

  it('uses the new path from a rename header so the notice names the current file', () => {
    const first = fileSection('kept.ts', '+k\n');
    const renamed = 'diff --git a/old.ts b/new.ts\n+renamed\n';
    const result = truncateDiff(first + renamed, Buffer.byteLength(first));
    assert.deepEqual([...result.omittedFiles], ['new.ts']);
  });

  it('falls back to the raw header line when a header does not parse', () => {
    const first = fileSection('kept.ts', '+k\n');
    const weird = 'diff --git no-paths-here\n+x\n';
    const result = truncateDiff(first + weird, Buffer.byteLength(first));
    assert.deepEqual([...result.omittedFiles], ['diff --git no-paths-here']);
  });

  it('strips a trailing CR from a CRLF header before parsing the path', () => {
    const first = fileSection('kept.ts', '+k\n');
    const crlf = 'diff --git a/win.ts b/win.ts\r\n+x\r\n';
    const result = truncateDiff(first + crlf, Buffer.byteLength(first));
    assert.deepEqual([...result.omittedFiles], ['win.ts']);
  });

  it('parses a header that is the entire remaining section, with no trailing newline', () => {
    const first = fileSection('kept.ts', '+k\n');
    const last = 'diff --git a/end.ts b/end.ts';
    const result = truncateDiff(first + last, Buffer.byteLength(first));
    assert.deepEqual([...result.omittedFiles], ['end.ts']);
  });
});

describe('truncateDiff oversized first section', () => {
  it('hard-cuts the first section when even that one file exceeds the cap, and still names the files dropped behind it', () => {
    const first = fileSection('big.ts', `${'x'.repeat(200)}\n`);
    const second = fileSection('small.ts', '+ok\n');
    const result = truncateDiff(first + second, 50);
    assert.equal(result.truncated, true);
    // small.ts was dropped whole and has to be named. Reporting only a byte count here reads as
    // "one big file was trimmed" when what actually happened is that an oversized lockfile
    // pushed every other file out of the review entirely.
    assert.deepEqual([...result.omittedFiles], ['small.ts']);
    assert.ok(Buffer.byteLength(result.text) <= 50);
    assert.ok(result.text.startsWith('diff --git a/big.ts'));
    assert.ok(!result.text.includes('small.ts'));
    assert.equal(
      result.omittedBytes,
      Buffer.byteLength(first + second) - Buffer.byteLength(result.text),
    );
  });

  it('hard-cuts a headerless blob the same way, because there is no file boundary to stop at', () => {
    const blob = 'x'.repeat(80);
    const result = truncateDiff(blob, 10);
    assert.equal(result.text, 'x'.repeat(10));
    assert.equal(result.truncated, true);
    assert.equal(result.omittedBytes, 70);
    assert.deepEqual([...result.omittedFiles], []);
  });
});

describe('truncateDiff multi-byte character boundaries', () => {
  // € is U+20AC, UTF-8 E2 82 AC — three bytes. Sitting it on the cap is the
  // case that a naive Buffer.subarray(0, maxBytes).toString() would corrupt.
  const euro = '€';

  it('does not split a multi-byte character that sits exactly on the cap, and never emits U+FFFD', () => {
    const prefix = 'xxxx';
    const suffix = 'yyyy';
    const section = `${prefix}${euro}${suffix}`;
    const capIntoEuro = Buffer.byteLength(prefix) + 1;
    const result = truncateDiff(section, capIntoEuro);

    assert.equal(result.text, prefix);
    assert.ok(!result.text.includes('\uFFFD'));
    assert.ok(!result.text.includes(euro));
    assert.ok(Buffer.byteLength(result.text) <= capIntoEuro);
    assert.equal(result.truncated, true);
  });

  it('keeps a multi-byte character that ends exactly on the cap', () => {
    const prefix = 'xxxx';
    const suffix = 'yyyy';
    const section = `${prefix}${euro}${suffix}`;
    const capAtEuroEnd = Buffer.byteLength(prefix + euro);
    const result = truncateDiff(section, capAtEuroEnd);

    assert.equal(result.text, prefix + euro);
    assert.ok(!result.text.includes('\uFFFD'));
    assert.equal(Buffer.byteLength(result.text), capAtEuroEnd);
  });

  it('returns empty text when the first character itself is larger than the cap', () => {
    const result = truncateDiff(euro, 1);
    assert.equal(result.text, '');
    assert.ok(!result.text.includes('\uFFFD'));
    assert.equal(result.truncated, true);
    assert.equal(result.omittedBytes, Buffer.byteLength(euro));
  });

  it('does not split a supplementary-plane code point (emoji) on the cap', () => {
    const emoji = '𝄞'; // U+1D11E, four UTF-8 bytes, one JS surrogate pair
    const section = `ab${emoji}cd`;
    const result = truncateDiff(section, Buffer.byteLength('ab') + 2);
    assert.equal(result.text, 'ab');
    assert.ok(!result.text.includes('\uFFFD'));
    assert.equal(result.text.length, 2);
  });
});

describe('truncateDiff maxBytes <= 0', () => {
  it('returns empty text and counts every byte as omitted when maxBytes is 0', () => {
    const first = fileSection('a.ts', '+a\n');
    const second = fileSection('b.ts', '+b\n');
    const diff = first + second;
    const result = truncateDiff(diff, 0);
    assert.equal(result.text, '');
    assert.equal(result.truncated, true);
    assert.equal(result.omittedBytes, Buffer.byteLength(diff));
    assert.deepEqual([...result.omittedFiles], ['a.ts', 'b.ts']);
  });

  it('treats a negative cap the same as zero', () => {
    const diff = fileSection('a.ts', '+a\n');
    const result = truncateDiff(diff, -8);
    assert.equal(result.text, '');
    assert.equal(result.truncated, true);
    assert.equal(result.omittedBytes, Buffer.byteLength(diff));
    assert.deepEqual([...result.omittedFiles], ['a.ts']);
  });

  it('returns an empty untruncated result when both the diff and the cap are empty', () => {
    const result = truncateDiff('', 0);
    assert.equal(result.text, '');
    assert.equal(result.truncated, false);
    assert.equal(result.omittedBytes, 0);
    assert.deepEqual([...result.omittedFiles], []);
  });

  it('omits a headerless blob by bytes only, because there is no path to name', () => {
    const result = truncateDiff('hello', 0);
    assert.equal(result.text, '');
    assert.equal(result.truncated, true);
    assert.equal(result.omittedBytes, Buffer.byteLength('hello'));
    assert.deepEqual([...result.omittedFiles], []);
  });
});

describe('truncateDiff immutability', () => {
  it('freezes the result and the omitted-files list so a later caller cannot rewrite the notice', () => {
    const result = truncateDiff(fileSection('a.ts', '+a\n'), 0);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.omittedFiles));
    assert.throws(() => {
      (result.omittedFiles as string[]).push('nope');
    }, TypeError);
  });
});
