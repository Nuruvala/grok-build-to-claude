import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSessionSummary } from '../../src/sessions/summary.js';

const FALLBACK_ID = '01a00a41-8f57-7de2-bb03-caccc61a1f0e';
const FALLBACK_CWD = '/tmp/work';

const FULL = {
  info: { id: FALLBACK_ID, cwd: FALLBACK_CWD },
  session_summary: 'A useful summary',
  generated_title: 'Generated Title',
  created_at: '2026-08-16T21:50:00.978931614Z',
  updated_at: '2026-08-16T22:10:00.000000000Z',
  num_messages: 4,
  num_chat_messages: 7,
  current_model_id: 'grok-4.6',
  agent_name: 'grok-build-plan',
  sandbox_profile: 'read-only',
  reasoning_effort: 'high',
  head_branch: 'main',
  head_commit: '9b0503eabbbce541d3db79f68883365bc722d666',
  git_remotes: ['origin', 'upstream'],
};

describe('parseSessionSummary', () => {
  it('reads every documented field from a full object', () => {
    const parsed = parseSessionSummary(FULL, 'dir-id', '/decoded');

    assert.equal(parsed.id, FALLBACK_ID);
    assert.equal(parsed.cwd, FALLBACK_CWD);
    assert.equal(parsed.title, 'Generated Title');
    assert.equal(parsed.createdAt, FULL.created_at);
    assert.equal(parsed.updatedAt, FULL.updated_at);
    assert.equal(parsed.numMessages, 4);
    assert.equal(parsed.model, 'grok-4.6');
    assert.equal(parsed.agent, 'grok-build-plan');
    assert.equal(parsed.sandboxProfile, 'read-only');
    assert.equal(parsed.effort, 'high');
    assert.equal(parsed.gitBranch, 'main');
    assert.equal(parsed.headCommit, FULL.head_commit);
    assert.deepEqual(parsed.gitRemotes, ['origin', 'upstream']);
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.gitRemotes));
  });

  it('uses fallbacks and nulls when every optional field is missing', () => {
    const parsed = parseSessionSummary(
      { info: { id: 'from-info', cwd: '/from-info' } },
      'dir',
      '/fb',
    );

    assert.equal(parsed.id, 'from-info');
    assert.equal(parsed.cwd, '/from-info');
    assert.equal(parsed.title, null);
    assert.equal(parsed.createdAt, null);
    assert.equal(parsed.updatedAt, null);
    assert.equal(parsed.numMessages, null);
    assert.equal(parsed.model, null);
    assert.equal(parsed.agent, null);
    assert.equal(parsed.sandboxProfile, null);
    assert.equal(parsed.effort, null);
    assert.equal(parsed.gitBranch, null);
    assert.equal(parsed.headCommit, null);
    assert.deepEqual(parsed.gitRemotes, []);
  });

  it('prefers generated_title over session_summary', () => {
    const parsed = parseSessionSummary(
      { generated_title: 'Title', session_summary: 'Summary' },
      FALLBACK_ID,
      FALLBACK_CWD,
    );
    assert.equal(parsed.title, 'Title');
  });

  it('treats an empty session_summary as null rather than an empty title', () => {
    const parsed = parseSessionSummary({ session_summary: '' }, FALLBACK_ID, FALLBACK_CWD);
    assert.equal(parsed.title, null);
  });

  it('falls through to session_summary when generated_title is empty', () => {
    const parsed = parseSessionSummary(
      { generated_title: '   ', session_summary: 'Summary' },
      FALLBACK_ID,
      FALLBACK_CWD,
    );
    assert.equal(parsed.title, 'Summary');
  });

  it('does not coerce wrong types: a string num_messages is not a number', () => {
    const parsed = parseSessionSummary(
      {
        info: null,
        num_messages: '12',
        git_remotes: 'origin',
        current_model_id: 4,
      },
      FALLBACK_ID,
      FALLBACK_CWD,
    );

    assert.equal(parsed.id, FALLBACK_ID);
    assert.equal(parsed.cwd, FALLBACK_CWD);
    assert.equal(parsed.numMessages, null);
    assert.deepEqual(parsed.gitRemotes, []);
    assert.equal(parsed.model, null);
  });

  it('keeps only string remotes and drops the rest', () => {
    const parsed = parseSessionSummary(
      { git_remotes: ['origin', 1, null, 'upstream'] },
      FALLBACK_ID,
      FALLBACK_CWD,
    );
    assert.deepEqual(parsed.gitRemotes, ['origin', 'upstream']);
  });

  it('uses path fallbacks for a non-object input, including undefined', () => {
    for (const value of [undefined, null, 'nope', 12, []]) {
      const parsed = parseSessionSummary(value, FALLBACK_ID, FALLBACK_CWD);
      assert.equal(parsed.id, FALLBACK_ID);
      assert.equal(parsed.cwd, FALLBACK_CWD);
      assert.equal(parsed.title, null);
      assert.deepEqual(parsed.gitRemotes, []);
    }
  });

  it('uses fallbacks when the summary is absent rather than throwing', () => {
    const parsed = parseSessionSummary(undefined, FALLBACK_ID, FALLBACK_CWD);
    assert.equal(parsed.id, FALLBACK_ID);
    assert.equal(parsed.cwd, FALLBACK_CWD);
    assert.ok(Object.isFrozen(parsed));
  });
});
