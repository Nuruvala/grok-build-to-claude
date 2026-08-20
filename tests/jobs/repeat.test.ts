import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  progressLines,
  REPEAT_MIN_LINES,
  REPEAT_WINDOW,
  repeatingProgressAdvisory,
} from '../../src/jobs/repeat.js';

function numbered(kind: 'thinking' | 'writing' | 'tool', bodies: readonly string[]): string[] {
  return bodies.map((body, index) => {
    const prefix = kind === 'tool' ? '' : `${kind}: `;
    return `#${String(index + 1)} ${prefix}${body}`;
  });
}

function repeat(body: string, count: number, kind: 'thinking' | 'writing' = 'thinking'): string[] {
  return numbered(
    kind,
    Array.from({ length: count }, () => body),
  );
}

describe('progressLines', () => {
  it('splits on newline and drops a trailing empty line, leaving a missing trailing newline intact', () => {
    assert.deepEqual(progressLines(''), []);
    assert.deepEqual(progressLines('#1 thinking: a\n#2 thinking: b\n'), [
      '#1 thinking: a',
      '#2 thinking: b',
    ]);
    assert.deepEqual(progressLines('#1 thinking: a\n#2 thinking: b'), [
      '#1 thinking: a',
      '#2 thinking: b',
    ]);
  });
});

describe('repeatingProgressAdvisory', () => {
  it('returns null on a short run, even when every line is identical', () => {
    const lines = repeat(
      '**house**: house with chimney (filled walls 2, roof).',
      REPEAT_MIN_LINES - 1,
    );
    assert.equal(repeatingProgressAdvisory(lines), null);
  });

  it('returns null on an empty list and on a window of only tool lines', () => {
    assert.equal(repeatingProgressAdvisory([]), null);
    const files = Array.from({ length: REPEAT_WINDOW }, (_, i) => `src/file-${String(i)}.ts`);
    assert.equal(
      repeatingProgressAdvisory(
        numbered(
          'tool',
          files.map((file) => `read_file ${file}`),
        ),
      ),
      null,
    );
  });

  it('does not fire on fifty read_file lines that differ only in path, because that is work not a loop', () => {
    const files = Array.from({ length: 50 }, (_, i) => `src/mod-${String(i).padStart(2, '0')}.ts`);
    const lines = numbered(
      'tool',
      files.map((file) => `read_file ${file}`),
    );
    assert.equal(repeatingProgressAdvisory(lines), null);
  });

  it('does not fire on mixed tool work with varied thinking in between', () => {
    const lines: string[] = [];
    for (let i = 0; i < REPEAT_WINDOW; i += 1) {
      if (i % 2 === 0) {
        lines.push(`#${String(i + 1)} read_file src/file-${String(i)}.ts`);
      } else {
        lines.push(`#${String(i + 1)} thinking: considering export ${String(i)} and its callers`);
      }
    }
    assert.equal(repeatingProgressAdvisory(lines), null);
  });

  it('does not fire on a healthy run whose thinking lines are distinct', () => {
    const thoughts = Array.from(
      { length: REPEAT_MIN_LINES },
      (_, i) => `step ${String(i)}: inspect module ${String(i)} then decide the next edit`,
    );
    assert.equal(repeatingProgressAdvisory(numbered('thinking', thoughts)), null);
  });

  it('fires when identical reasoning fragments fill the window', () => {
    const lines = repeat(
      'md> (file written) ARRANGEMENT REFUTED: 1,3,4,5,6,7 ...',
      REPEAT_MIN_LINES,
    );
    const advisory = repeatingProgressAdvisory(lines);
    assert.ok(advisory);
    assert.equal(advisory.uniqueNarration, 1);
    assert.equal(advisory.repeatingEvents, REPEAT_MIN_LINES);
    assert.equal(
      advisory.line,
      `progress has been repeating for ${String(REPEAT_MIN_LINES)} events; the run may be stuck`,
    );
  });

  it('fires on the observed looping plan, whose lines mutate slightly instead of matching exactly', () => {
    // Captured from the eleven-minute run in the dogfooding log. Exact equality
    // would miss `filled 2 walls` becoming `filled 2 2 walls`.
    const cycle = [
      '**house**: house with chimney (filled walls 2, roof, chimney, door).',
      '**store 2**: store 2 with sign (filled 2 walls, roof, sign 2, window paper).',
      '**store 2**: store 2 with sign (filled 2 2 walls, roof, sign 2, window paper).',
      '**cook**: pot with steam and food (filled pot, lid, steam, 2 2 food).',
    ];
    const bodies: string[] = [];
    while (bodies.length < REPEAT_WINDOW) {
      bodies.push(...cycle);
    }
    const lines = numbered('thinking', bodies.slice(0, REPEAT_WINDOW));
    const advisory = repeatingProgressAdvisory(lines);
    assert.ok(advisory);
    assert.ok(advisory.uniqueNarration <= 4);
    assert.equal(advisory.repeatingEvents, REPEAT_WINDOW);
    assert.match(advisory.line, /progress has been repeating for 24 events; the run may be stuck/);
  });

  it('looks only at the last window, so earlier variety does not hide a loop that started later', () => {
    const prefix = numbered(
      'thinking',
      Array.from({ length: 40 }, (_, i) => `unique preamble ${String(i)} about a different file`),
    );
    const loop = repeat('**house**: house with chimney (filled walls 2, roof).', REPEAT_WINDOW);
    const advisory = repeatingProgressAdvisory([...prefix, ...loop]);
    assert.ok(advisory);
    assert.equal(advisory.windowSize, REPEAT_WINDOW);
    assert.equal(advisory.uniqueNarration, 1);
  });

  it('treats writing: the same as thinking:, because a stuck run may be emitting either', () => {
    const lines = repeat(
      'ok I have written the full report to disk now',
      REPEAT_MIN_LINES,
      'writing',
    );
    const advisory = repeatingProgressAdvisory(lines);
    assert.ok(advisory);
    assert.equal(advisory.uniqueNarration, 1);
  });
});
