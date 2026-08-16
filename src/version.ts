/**
 * Package version, read from package.json at startup.
 *
 * `src/version.ts` and `dist/version.js` are both one directory below the package root, so the
 * relative path resolves the same under `tsx` and under the built output.
 */

import { readFileSync } from 'node:fs';

export const SERVER_NAME = 'grok-build';

export const VERSION: string = readVersion();

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const { version } = parsed;
      if (typeof version === 'string') return version;
    }
  } catch {
    // Falls through. A missing version must never stop the server from starting.
  }
  return '0.0.0-unknown';
}
