/**
 * Where a tool call points, as a display string.
 *
 * Shared by the progress mapper, which names a tool call while it runs, and the
 * stream collector, which names one that failed. Both answer the same question
 * and answering it twice is how the two disagree.
 *
 * Pure: no I/O, no clock. Never throws.
 */

/** The first non-empty entry of a `locations` array, if any. */
export function firstLocation(locations: readonly string[]): string | undefined {
  const path = locations[0];
  return path !== undefined && path !== '' ? path : undefined;
}

/** The first string field of `rawInput` that looks like a path, if any. */
export function firstPathLike(
  rawInput: Readonly<Record<string, unknown>> | null,
): string | undefined {
  if (rawInput === null) return undefined;
  for (const value of Object.values(rawInput)) {
    if (typeof value === 'string' && looksLikePath(value)) return value;
  }
  return undefined;
}

function looksLikePath(value: string): boolean {
  return (value.includes('/') || value.includes('.')) && !/\s/.test(value);
}
