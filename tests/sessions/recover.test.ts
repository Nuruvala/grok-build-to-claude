import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  resolveCancelledSession,
  sessionResolutionLines,
  sessionResolutionMeta,
} from '../../src/sessions/recover.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const WINDOW = {
  startedAt: '2026-08-17T12:00:00.000Z',
  endedAt: '2026-08-17T12:00:20.000Z',
} as const;

describe('resolveCancelledSession', () => {
  it('returns the known id as result without reading the store', async () => {
    const resolved = await resolveCancelledSession({
      knownSessionId: 'from-end',
      sessionsDir: '/no/such/store',
      cwd: '/tmp',
      ...WINDOW,
    });
    assert.deepEqual(resolved, { kind: 'result', sessionId: 'from-end' });
  });

  it('returns none when the run has no startedAt — no window, no guess', async () => {
    const resolved = await resolveCancelledSession({
      knownSessionId: null,
      sessionsDir: '/no/such/store',
      cwd: '/tmp',
      startedAt: null,
      endedAt: WINDOW.endedAt,
    });
    assert.deepEqual(resolved, { kind: 'none' });
  });

  it('returns none and does not throw when the store is unreadable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-recover-'));
    tmpDirs.push(dir);
    const sessionsFile = path.join(dir, 'sessions');
    await writeFile(sessionsFile, 'not a directory');

    const resolved = await resolveCancelledSession({
      knownSessionId: null,
      sessionsDir: sessionsFile,
      cwd: '/tmp',
      ...WINDOW,
    });
    assert.deepEqual(resolved, { kind: 'none' });
  });
});

describe('sessionResolutionLines and meta', () => {
  it('announces a store id with sessionIdSource store', () => {
    const resolved = { kind: 'store' as const, sessionId: 'sess-1' };
    assert.deepEqual(sessionResolutionLines(resolved, true), ['Resume with:', '  grok -r sess-1']);
    assert.deepEqual(sessionResolutionMeta(resolved), {
      sessionId: 'sess-1',
      sessionIdSource: 'store',
    });
  });

  it('omits the resume lines when the caller already announced the id', () => {
    const resolved = { kind: 'result' as const, sessionId: 'sess-1' };
    assert.deepEqual(sessionResolutionLines(resolved, false), []);
    assert.deepEqual(sessionResolutionMeta(resolved), {
      sessionId: 'sess-1',
      sessionIdSource: 'result',
    });
  });

  it('lists every candidate and sets sessionCandidates, never a sessionId', () => {
    const resolved = {
      kind: 'ambiguous' as const,
      candidates: Object.freeze(['a', 'b']),
    };
    const lines = sessionResolutionLines(resolved, true);
    assert.match(lines[0] ?? '', /could not be identified uniquely/);
    assert.ok(lines.includes('  a'));
    assert.ok(lines.includes('  b'));
    assert.deepEqual(sessionResolutionMeta(resolved), { sessionCandidates: ['a', 'b'] });
    assert.equal('sessionId' in sessionResolutionMeta(resolved), false);
  });

  it('adds nothing for none', () => {
    assert.deepEqual(sessionResolutionLines({ kind: 'none' }, true), []);
    assert.deepEqual(sessionResolutionMeta({ kind: 'none' }), {});
  });
});
