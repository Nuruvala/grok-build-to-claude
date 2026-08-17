import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { processAlive, processGroupAlive, terminateRun } from '../../src/jobs/kill.js';

const FAKE_GROK = fileURLToPath(new URL('../fixtures/fake-grok.mjs', import.meta.url));

const tmpDirs: string[] = [];
const trackedPids = new Set<number>();

function trackPid(pid: number | null | undefined): void {
  if (typeof pid === 'number' && pid > 0) trackedPids.add(pid);
}

function killPid(pid: number): void {
  if (pid === process.pid || pid === process.ppid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* group may not exist */
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grok-mcp-kill-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const pid of trackedPids) {
    killPid(pid);
  }
  trackedPids.clear();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function isEsrch(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function assertDead(pid: number): void {
  assert.equal(processAlive(pid), false);
  assert.throws(
    () => {
      process.kill(pid, 0);
    },
    (error: unknown) => isEsrch(error),
  );
}

async function waitForSpawn(child: ReturnType<typeof spawn>): Promise<number> {
  const pid = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    child.once('error', onError);
    if (child.pid !== undefined) {
      child.off('error', onError);
      resolve(child.pid);
      return;
    }
    child.once('spawn', () => {
      child.off('error', onError);
      if (child.pid === undefined) {
        reject(new Error('spawned without a pid'));
        return;
      }
      resolve(child.pid);
    });
  });
  trackPid(pid);
  return pid;
}

describe('terminateRun', () => {
  it('returns no-pid without signalling or claiming the tree is dead when the worker pid is null', async () => {
    const outcome = await terminateRun(null);
    assert.deepEqual(outcome, { signalsSent: [], alive: true, reason: 'no-pid' });
  });

  it('refuses a pid of zero rather than signalling its own process group', async () => {
    // POSIX reads kill(-0, sig) as "signal my own process group", so a
    // corrupt record must not reach sendSignal. This test process is its own
    // witness: if the guard regressed, the run would take itself down.
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      const outcome = await terminateRun(pid);
      assert.deepEqual(outcome, { signalsSent: [], alive: true, reason: 'no-pid' }, `pid ${pid}`);
    }
  });

  it('reports gone for a pid that has already exited', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = await waitForSpawn(child);
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => {
        resolve();
      });
    });
    const outcome = await terminateRun(pid, { graceMs: 200, pollMs: 20 });
    assert.equal(outcome.reason, 'gone');
    assert.equal(outcome.alive, false);
    assert.deepEqual(outcome.signalsSent, []);
  });

  it(
    'kills a detached child and the grandchild it spawned in the same group with SIGTERM only',
    { skip: process.platform === 'win32', timeout: 15_000 },
    async () => {
      const script = `
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3600000)'], { stdio: 'ignore' });
writeSync(1, String(grandchild.pid ?? ''));
setTimeout(() => {}, 3600000);
`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pid = await waitForSpawn(child);
      const stdoutStream = child.stdout;
      assert.ok(stdoutStream);
      let stdout = '';
      stdoutStream.setEncoding('utf8');
      stdoutStream.on('data', (chunk: string) => {
        stdout += chunk;
      });
      const started = Date.now();
      while (stdout.trim() === '' && Date.now() - started < 3000) {
        await delay(20);
      }
      const grandchildPid = Number.parseInt(stdout.trim(), 10);
      assert.ok(
        Number.isInteger(grandchildPid) && grandchildPid > 0,
        `stdout=${JSON.stringify(stdout)}`,
      );
      trackPid(grandchildPid);

      const outcome = await terminateRun(pid, { graceMs: 1000, pollMs: 20 });
      assert.deepEqual(outcome.signalsSent, ['SIGTERM']);
      assert.equal(outcome.reason, 'terminated');
      assert.equal(outcome.alive, false);
      assertDead(pid);
      assertDead(grandchildPid);
    },
  );

  it(
    'escalates to SIGKILL when the child ignores SIGTERM',
    { skip: process.platform === 'win32', timeout: 15_000 },
    async () => {
      await makeTmp();
      const child = spawn(process.execPath, [FAKE_GROK], {
        detached: true,
        stdio: 'ignore',
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: '/tmp/grok-mcp-test-home',
          FAKE_GROK_IGNORE_SIGTERM: '1',
          FAKE_GROK_SLEEP_MS: '60000',
        },
      });
      const pid = await waitForSpawn(child);
      // The handler is installed at module evaluation. Signalling during
      // node startup hits the default SIGTERM disposition and looks like
      // a clean terminate — the opposite of what this test is measuring.
      const readyAt = Date.now() + 200;
      while (Date.now() < readyAt) {
        assert.equal(processAlive(pid), true, 'child died before the ignore handler could install');
        await delay(20);
      }
      const outcome = await terminateRun(pid, { graceMs: 250, pollMs: 20 });
      assert.deepEqual(outcome.signalsSent, ['SIGTERM', 'SIGKILL']);
      assert.equal(outcome.reason, 'killed');
      assert.equal(outcome.alive, false);
      assertDead(pid);
    },
  );
});

describe('processAlive', () => {
  it('is true for this process and false for a pid that has exited', async () => {
    assert.equal(processAlive(process.pid), true);
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = await waitForSpawn(child);
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => {
        resolve();
      });
    });
    assert.equal(processAlive(pid), false);
  });
});

describe('processGroupAlive', () => {
  it('is true for a detached child and false after that child exits', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = await waitForSpawn(child);
    assert.equal(processGroupAlive(pid), true);
    child.kill('SIGKILL');
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => {
        resolve();
      });
    });
    assert.equal(processGroupAlive(pid), false);
  });

  it(
    'stays true after the leader exits while a grandchild remains, and terminateRun reaps the leftover',
    { skip: process.platform === 'win32', timeout: 15_000 },
    async () => {
      // The grandchild announces itself only once its SIGTERM handler is
      // installed, and the leader does not publish its pid until then. A
      // fixed delay here is a race against Node's startup: lose it and the
      // first SIGTERM kills the grandchild outright, so terminateRun never
      // escalates and the assertion below fails perhaps one run in ten.
      const script = `
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(`
process.on('SIGTERM', () => {});
process.stdout.write('ready');
setTimeout(() => {}, 3600000);
`)}], { stdio: ['ignore', 'pipe', 'ignore'] });
grandchild.stdout.once('data', () => {
  writeSync(1, String(grandchild.pid ?? ''));
  setTimeout(() => process.exit(0), 10);
});
`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pid = await waitForSpawn(child);
      // Subscribe before reading the pid, not after: the leader exits as soon
      // as it has published one, and `once('exit')` attached after the fact
      // never fires.
      const leaderExited = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => {
          resolve();
        });
      });
      const stdoutStream = child.stdout;
      assert.ok(stdoutStream);
      let stdout = '';
      stdoutStream.setEncoding('utf8');
      stdoutStream.on('data', (chunk: string) => {
        stdout += chunk;
      });
      const started = Date.now();
      while (stdout.trim() === '' && Date.now() - started < 3000) {
        await delay(20);
      }
      const grandchildPid = Number.parseInt(stdout.trim(), 10);
      assert.ok(
        Number.isInteger(grandchildPid) && grandchildPid > 0,
        `stdout=${JSON.stringify(stdout)}`,
      );
      trackPid(grandchildPid);

      await leaderExited;
      assert.equal(processAlive(pid), false);
      assert.equal(processGroupAlive(pid), true);
      assert.equal(processAlive(grandchildPid), true);

      const outcome = await terminateRun(pid, { graceMs: 250, pollMs: 20 });
      assert.deepEqual(outcome.signalsSent, ['SIGTERM', 'SIGKILL']);
      assert.equal(outcome.reason, 'killed');
      assert.equal(outcome.alive, false);
      assertDead(grandchildPid);
    },
  );
});
