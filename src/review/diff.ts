/**
 * Byte-capped truncation of a unified diff. Pure: no git, no fs.
 *
 * Measured in UTF-8 bytes, never string length — a diff of non-ASCII source otherwise
 * sails past a byte cap. Cuts at a file boundary so the model never sees a half-file
 * unless even the first file will not fit.
 */

import { Buffer } from 'node:buffer';

export interface TruncatedDiff {
  readonly text: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
  /** Paths dropped whole, for the notice. Empty when nothing was dropped. */
  readonly omittedFiles: readonly string[];
}

export function truncateDiff(diff: string, maxBytes: number): TruncatedDiff {
  const totalBytes = Buffer.byteLength(diff);
  const sections = splitSections(diff);

  if (maxBytes <= 0) {
    return freezeTruncated({
      text: '',
      truncated: totalBytes > 0,
      omittedBytes: totalBytes,
      omittedFiles: pathsOf(sections),
    });
  }

  const kept: string[] = [];
  let used = 0;
  let next = 0;

  for (const section of sections) {
    const size = Buffer.byteLength(section);
    if (used + size <= maxBytes) {
      kept.push(section);
      used += size;
      next += 1;
      continue;
    }

    // Even the first section overshoots. Hard-cut it at a UTF-8 character boundary. The
    // sections after it are dropped whole and must still be named: a lockfile bigger than the
    // whole budget would otherwise omit every source file behind a bare byte count, which reads
    // as "one big file was trimmed" rather than "the code you wanted reviewed is not here".
    if (kept.length === 0) {
      const text = sliceToUtf8Budget(section, maxBytes);
      return freezeTruncated({
        text,
        truncated: true,
        omittedBytes: totalBytes - Buffer.byteLength(text),
        omittedFiles: pathsOf(sections.slice(1)),
      });
    }

    const text = kept.join('');
    return freezeTruncated({
      text,
      truncated: true,
      omittedBytes: totalBytes - Buffer.byteLength(text),
      omittedFiles: pathsOf(sections.slice(next)),
    });
  }

  return freezeTruncated({
    text: diff,
    truncated: false,
    omittedBytes: 0,
    omittedFiles: [],
  });
}

/**
 * Split on lines that begin with `diff --git `. A preamble before the first header
 * is its own section so it still consumes budget; a diff with no headers is one section.
 * The lookahead keeps each header attached to its body. Empty parts (split's
 * leading '' when the string starts with a header) are dropped.
 */
function splitSections(diff: string): readonly string[] {
  return diff.split(/(?=^diff --git )/m).filter((part) => part !== '');
}

function pathsOf(sections: readonly string[]): readonly string[] {
  const paths: string[] = [];
  for (const section of sections) {
    const path = sectionPath(section);
    if (path !== null) paths.push(path);
  }
  return paths;
}

/**
 * `diff --git a/X b/Y` → Y (the new path). An unparseable header is kept raw so the
 * notice still names *something* rather than silently dropping the file from the list.
 */
function sectionPath(section: string): string | null {
  if (!section.startsWith('diff --git ')) return null;
  const newline = section.indexOf('\n');
  const rawHeader = newline === -1 ? section : section.slice(0, newline);
  const header = rawHeader.endsWith('\r') ? rawHeader.slice(0, -1) : rawHeader;
  const parsed = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  const newPath = parsed?.[2];
  return typeof newPath === 'string' ? newPath : header;
}

/** Keep whole code points so a multi-byte character on the cap is never split. */
function sliceToUtf8Budget(text: string, maxBytes: number): string {
  let used = 0;
  let end = 0;
  for (const unit of text) {
    const size = Buffer.byteLength(unit);
    if (used + size > maxBytes) break;
    used += size;
    end += unit.length;
  }
  return text.slice(0, end);
}

function freezeTruncated(result: TruncatedDiff): TruncatedDiff {
  return Object.freeze({
    text: result.text,
    truncated: result.truncated,
    omittedBytes: result.omittedBytes,
    omittedFiles: Object.freeze([...result.omittedFiles]),
  });
}
