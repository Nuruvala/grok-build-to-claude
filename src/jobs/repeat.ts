/**
 * Cheap repeating-progress heuristic for `status`.
 *
 * Pure: a function of progress lines, no I/O, no clock. Status derives the
 * advisory at read time so `readOnlyHint: true` stays honest, and a healthy
 * run pays only the scan of the last window.
 *
 * A run reading fifty files emits fifty `read_file` lines that differ only in
 * path. Those are work, not a loop: they are tool-call lines, which is the
 * same distinction the tool-call tally makes, and this function treats a
 * tool-majority window as healthy. The case we fire on is narration
 * (`thinking:` / `writing:`) that keeps saying nearly the same thing, which
 * is what a degenerate repeating-plan loop looks like.
 */

export const REPEAT_WINDOW = 24;
/** Below this, a run has not said enough for repetition to mean anything. */
export const REPEAT_MIN_LINES = 20;
/** Fire when unique narration groups are at most this fraction of narration lines. */
const UNIQUE_RATIO_MAX = 0.4;
/** Narration must be at least this fraction of the window; otherwise it is tool work. */
const NARRATION_RATIO_MIN = 0.5;
const SUBSTRING_MIN_CHARS = 20;
const JACCARD_NEAR = 0.85;

export interface RepeatAdvisory {
  readonly repeatingEvents: number;
  readonly uniqueNarration: number;
  readonly windowSize: number;
  readonly line: string;
}

export function progressLines(text: string): readonly string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function repeatingProgressAdvisory(lines: readonly string[]): RepeatAdvisory | null {
  if (lines.length < REPEAT_MIN_LINES) return null;
  const window = lines.length > REPEAT_WINDOW ? lines.slice(-REPEAT_WINDOW) : [...lines];

  const narration: string[] = [];
  for (const line of window) {
    const body = stripIndex(line);
    if (isNarration(body)) narration.push(body);
  }
  if (narration.length / window.length < NARRATION_RATIO_MIN) return null;
  if (narration.length < Math.ceil(REPEAT_MIN_LINES * NARRATION_RATIO_MIN)) return null;

  const groups = groupNearDuplicates(narration.map(normalizeNarration));
  if (groups.length / narration.length > UNIQUE_RATIO_MAX) return null;

  const repeatingEvents = narration.length;
  return Object.freeze({
    repeatingEvents,
    uniqueNarration: groups.length,
    windowSize: window.length,
    line: `progress has been repeating for ${String(repeatingEvents)} events; the run may be stuck`,
  });
}

function stripIndex(line: string): string {
  return line.replace(/^#\d+\s+/, '');
}

function isNarration(body: string): boolean {
  return body.startsWith('thinking:') || body.startsWith('writing:');
}

/**
 * Collapse consecutive duplicate tokens so `filled 2 2 walls` matches
 * `filled 2 walls`. Exact equality would have missed the observed loop,
 * which mutated slightly each time rather than repeating byte-for-byte.
 */
function normalizeNarration(body: string): string {
  const stripped = body.replace(/^(?:thinking|writing):\s*/, '');
  const tokens = stripped.toLowerCase().replace(/\s+/g, ' ').trim().split(' ');
  const collapsed: string[] = [];
  for (const token of tokens) {
    if (token === '') continue;
    if (collapsed[collapsed.length - 1] !== token) collapsed.push(token);
  }
  return collapsed.join(' ');
}

function groupNearDuplicates(normalized: readonly string[]): readonly string[] {
  const representatives: string[] = [];
  for (const item of normalized) {
    const seen = representatives.some((rep) => nearDuplicate(rep, item));
    if (!seen) representatives.push(item);
  }
  return representatives;
}

function nearDuplicate(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= SUBSTRING_MIN_CHARS && longer.includes(shorter)) return true;
  return tokenJaccard(a, b) >= JACCARD_NEAR;
}

function tokenJaccard(a: string, b: string): number {
  const left = new Set(a.split(' '));
  const right = new Set(b.split(' '));
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
