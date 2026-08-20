import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  groupVerdictFromMembers,
  parseProcPidStat,
  processAlive,
  processGroupAlive,
  terminateRun,
} from '../../src/jobs/kill.js';
import { isOrphan } from '../../src/jobs/liveness.js';
import { parseRunRecord, RECORD_SCHEMA_VERSION } from '../../src/jobs/record.js';

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

function assertDead(pid: number): void {
  // A zombie is dead for liveness even though kill(pid, 0) still succeeds.
  // Requiring ESRCH here is the old check, and it is what made stop report
  // `survived` for a tree that had already exited.
  assert.equal(processAlive(pid), false);
}

async function waitForReadyFile(filePath: string, pid: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!existsSync(filePath)) {
    assert.equal(processAlive(pid), true, 'child died before announcing ready');
    assert.ok(Date.now() - started < timeoutMs, `ready file never appeared at ${filePath}`);
    await delay(20);
  }
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
      const readyFile = path.join(await makeTmp(), 'ready');
      const child = spawn(process.execPath, [FAKE_GROK], {
        detached: true,
        stdio: 'ignore',
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: '/tmp/grok-mcp-test-home',
          FAKE_GROK_IGNORE_SIGTERM: '1',
          FAKE_GROK_SLEEP_MS: '60000',
          FAKE_GROK_READY_FILE: readyFile,
        },
      });
      const pid = await waitForSpawn(child);
      // The handler is installed at module evaluation. Signalling during
      // node startup hits the default SIGTERM disposition and looks like
      // a clean terminate — the opposite of what this test is measuring.
      // The fixture writes FAKE_GROK_READY_FILE after that handler is in;
      // waiting for the file replaces a 200 ms guess that lost under load.
      await waitForReadyFile(readyFile, pid, 10_000);
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

describe('parseProcPidStat', () => {
  it('reads state and pgid after the last closing paren, so a comm with spaces or parentheses still parses', () => {
    const cases: readonly {
      readonly label: string;
      readonly contents: string;
      readonly state: string;
      readonly pgrp: number;
    }[] = [
      {
        label: 'ordinary comm',
        contents: '1234 (bash) S 1 1234 1234 0 0 0 0 0 0 0 0',
        state: 'S',
        pgrp: 1234,
      },
      {
        label: 'comm with spaces',
        contents: '99 (my process) R 1 42 7 0',
        state: 'R',
        pgrp: 42,
      },
      {
        label: 'comm with nested parentheses',
        contents: '2535242 (grok (1.0.4) linu) Z 1460 2535205 0 0',
        state: 'Z',
        pgrp: 2535205,
      },
      {
        label: 'the observed zombie, truncated to the fields we read',
        contents: '2535242 (grok-1.0.4-linu) Z 1460 2535205 2535205 0 0 0 0 0 0 0',
        state: 'Z',
        pgrp: 2535205,
      },
    ];
    for (const { label, contents, state, pgrp } of cases) {
      assert.deepEqual(parseProcPidStat(contents), { state, pgrp }, label);
    }
  });

  it('returns null for a line that is missing the comm close, the state, or the pgid', () => {
    assert.equal(parseProcPidStat(''), null);
    assert.equal(parseProcPidStat('1234 bash S 1 1234'), null);
    assert.equal(parseProcPidStat('1234 (bash)'), null);
    assert.equal(parseProcPidStat('1234 (bash) Z 1'), null);
    assert.equal(parseProcPidStat('1234 (bash) Z 1 not-a-pgid'), null);
  });

  it(
    'parses this process from /proc/self/stat as a non-zombie',
    { skip: process.platform !== 'linux' },
    () => {
      const parsed = parseProcPidStat(readFileSync('/proc/self/stat', 'utf8'));
      assert.ok(parsed);
      assert.notEqual(parsed.state, 'Z');
      assert.equal(typeof parsed.pgrp, 'number');
    },
  );
});

describe('groupVerdictFromMembers', () => {
  it('is live when any member of the group is not a zombie, zombies-only when every member is, and unreadable when none match', () => {
    const pgid = 2535205;
    assert.equal(groupVerdictFromMembers(pgid, []), 'unreadable');
    assert.equal(
      groupVerdictFromMembers(pgid, [{ state: 'S', pgrp: 1 }]),
      'unreadable',
    );
    assert.equal(
      groupVerdictFromMembers(pgid, [{ state: 'Z', pgrp: pgid }]),
      'zombies-only',
    );
    assert.equal(
      groupVerdictFromMembers(pgid, [
        { state: 'Z', pgrp: pgid },
        { state: 'Z', pgrp: pgid },
      ]),
      'zombies-only',
    );
    assert.equal(
      groupVerdictFromMembers(pgid, [
        { state: 'Z', pgrp: pgid },
        { state: 'S', pgrp: pgid },
      ]),
      'live',
    );
    assert.equal(
      groupVerdictFromMembers(pgid, [{ state: 'R', pgrp: pgid }]),
      'live',
    );
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

function python3Available(): boolean {
  const result = spawnSync('python3', ['-c', 'import os, ctypes'], { encoding: 'utf8' });
  return result.status === 0;
}

const linuxZombieSkip =
  process.platform !== 'linux'
    ? 'linux /proc only'
    : python3Available()
      ? false
      : 'python3 with ctypes is required to leave an unreaped child';

async function waitForStdoutLine(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<string> {
  const stdoutStream = child.stdout;
  assert.ok(stdoutStream);
  let stdout = '';
  stdoutStream.setEncoding('utf8');
  stdoutStream.on('data', (chunk: string) => {
    stdout += chunk;
  });
  const started = Date.now();
  while (!stdout.includes('\n') && Date.now() - started < timeoutMs) {
    await delay(20);
  }
  const line = stdout.split('\n')[0] ?? '';
  assert.ok(line !== '', `stdout=${JSON.stringify(stdout)}`);
  return line;
}

describe('zombie liveness', () => {
  it(
    'treats a zombie as dead even though kill(pid, 0) still succeeds',
    { skip: linuxZombieSkip, timeout: 10_000 },
    async () => {
      // Node reaps its own children, so a zombie has to be someone else's
      // child that the parent refuses to wait() for.
      const script = `
import os, pathlib, sys, time
child = os.fork()
if child == 0:
    os._exit(0)
for _ in range(50):
    try:
        text = pathlib.Path(f'/proc/{child}/stat').read_text()
        close = text.rfind(')')
        if close != -1 and text[close + 1:].split()[0] == 'Z':
            break
    except OSError:
        pass
    time.sleep(0.02)
sys.stdout.write(str(child) + '\\n')
sys.stdout.flush()
time.sleep(60)
`;
      const helper = spawn('python3', ['-c', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      const helperPid = await waitForSpawn(helper);
      const line = await waitForStdoutLine(helper, 3000);
      const zombiePid = Number.parseInt(line, 10);
      assert.ok(Number.isInteger(zombiePid) && zombiePid > 0, `line=${JSON.stringify(line)}`);
      trackPid(helperPid);

      // The defect: signal 0 succeeds, so the old check never cleared.
      assert.doesNotThrow(() => {
        process.kill(zombiePid, 0);
      });
      const parsed = parseProcPidStat(readFileSync(`/proc/${zombiePid}/stat`, 'utf8'));
      assert.ok(parsed);
      assert.equal(parsed.state, 'Z');
      assert.equal(processAlive(zombiePid), false);

      // status uses processAlive via isOrphan, so a zombie worker must not
      // keep the run looking live.
      const now = new Date().toISOString();
      const record = parseRunRecord(
        {
          schemaVersion: RECORD_SCHEMA_VERSION,
          runId: 'mfk2p1x9-3ac71f0b',
          tool: 'grok',
          summary: 'zombie worker',
          state: 'running',
          cwd: '/tmp',
          createdAt: now,
          startedAt: now,
          endedAt: null,
          workerPid: zombiePid,
          childPid: null,
          argv: null,
          progressCount: 0,
          lastProgress: null,
          lastProgressAt: null,
          sessionId: null,
          stopReason: null,
          result: null,
          error: null,
        },
        'fallback',
      );
      assert.ok(record);
      assert.equal(isOrphan(record, Date.now()), true);
    },
  );

  it(
    'treats a process group of only zombies as dead, so stop does not report survived',
    { skip: linuxZombieSkip, timeout: 15_000 },
    async () => {
      // Subreaper so the zombie is not reparented to init (which would reap
      // it) when the group leader exits. The helper stays alive and does not
      // wait(), which is the observed stop failure: worker gone, grandchild
      // a zombie still carrying the worker's pgid.
      const script = `
import ctypes, os, pathlib, sys, time
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    sys.stderr.write('prctl PR_SET_CHILD_SUBREAPER failed\\n')
    sys.exit(1)
r, w = os.pipe()
leader = os.fork()
if leader == 0:
    os.close(r)
    os.setpgid(0, 0)
    zombie = os.fork()
    if zombie == 0:
        os._exit(0)
    os.write(w, f'{os.getpid()} {zombie}\\n'.encode())
    os.close(w)
    os._exit(0)
os.close(w)
os.waitpid(leader, 0)
info = os.read(r, 64)
os.close(r)
leader_pid, zombie_pid = (int(part) for part in info.decode().split())
for _ in range(50):
    try:
        text = pathlib.Path(f'/proc/{zombie_pid}/stat').read_text()
        close = text.rfind(')')
        if close != -1 and text[close + 1:].split()[0] == 'Z':
            break
    except OSError:
        pass
    time.sleep(0.02)
sys.stdout.write(f'{leader_pid} {zombie_pid}\\n')
sys.stdout.flush()
time.sleep(60)
`;
      const helper = spawn('python3', ['-c', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      const helperPid = await waitForSpawn(helper);
      const line = await waitForStdoutLine(helper, 3000);
      const [leaderText, zombieText] = line.split(' ');
      const leaderPid = Number.parseInt(leaderText ?? '', 10);
      const zombiePid = Number.parseInt(zombieText ?? '', 10);
      assert.ok(Number.isInteger(leaderPid) && leaderPid > 0, `line=${JSON.stringify(line)}`);
      assert.ok(Number.isInteger(zombiePid) && zombiePid > 0, `line=${JSON.stringify(line)}`);
      trackPid(helperPid);

      assert.equal(processAlive(leaderPid), false);
      assert.doesNotThrow(() => {
        process.kill(-leaderPid, 0);
      });
      const parsed = parseProcPidStat(readFileSync(`/proc/${zombiePid}/stat`, 'utf8'));
      assert.ok(parsed);
      assert.equal(parsed.state, 'Z');
      assert.equal(parsed.pgrp, leaderPid);
      assert.equal(processAlive(zombiePid), false);
      assert.equal(processGroupAlive(leaderPid), false);

      const outcome = await terminateRun(leaderPid, { graceMs: 250, pollMs: 20 });
      assert.notEqual(outcome.reason, 'survived');
      assert.equal(outcome.alive, false);
    },
  );
});
