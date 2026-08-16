#!/usr/bin/env node
/**
 * Scriptable stand-in for the `grok` CLI. Driven entirely by FAKE_GROK_* environment
 * variables so a test can script stdout, stderr, exit code, sleep, and process-tree
 * behaviour without writing files (except the optional argv dump).
 *
 * Writes to fds 1/2 via fs write helpers so this fixture is not itself a
 * console.log / process.stdout.write source — those are banned in this repo
 * because stdout is the MCP transport in the real server.
 */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFileSync, write as writeCallback, writeFileSync, writeSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

// Install first so a SIGTERM during setup cannot sneak through before the handler exists.
if (process.env['FAKE_GROK_IGNORE_SIGTERM']) {
  process.on('SIGTERM', () => {
    // Swallow. exec.ts must escalate to SIGKILL to reap us.
  });
}

// Record argv before any sleep so a killed run still leaves evidence.
const argvFile = process.env['FAKE_GROK_ARGV_FILE'];
if (argvFile) {
  writeFileSync(argvFile, JSON.stringify(process.argv.slice(2)));
}

if (process.env['FAKE_GROK_SPAWN_CHILD']) {
  // Stay in *this* process group. `detached: true` would call setsid() and put the
  // grandchild in a new group, which process.kill(-pid) would miss — defeating the
  // test this flag exists for. We do not wait on the child, so it would outlive a
  // non-group kill of this process.
  const grandchild = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 3600000)'], {
    stdio: 'ignore',
  });
  if (grandchild.pid !== undefined) {
    writeSync(2, `{"grandchildPid":${grandchild.pid}}\n`);
  }
}

if (process.env['FAKE_GROK_LEAK_STDIO']) {
  // The opposite of FAKE_GROK_SPAWN_CHILD: `detached` puts the grandchild in its own group so a
  // group kill misses it, and `inherit` hands it our stdout/stderr so those pipes never reach EOF.
  // The parent's `close` event therefore never fires and exec.ts must fall back to its `exit`
  // drain backstop. The test is responsible for reaping the pid we report here.
  const leaked = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 30000)'], {
    detached: true,
    stdio: 'inherit',
  });
  leaked.unref();
  if (leaked.pid !== undefined) {
    writeSync(2, `{"leakedPid":${leaked.pid}}\n`);
  }
}

const cannedStdout = process.env['FAKE_GROK_STDOUT'];
if (cannedStdout) {
  writeSync(1, cannedStdout);
}

const cannedStderr = process.env['FAKE_GROK_STDERR'];
if (cannedStderr) {
  writeSync(2, cannedStderr);
}

// Must match the literal in tests/grok/exec.test.ts. Split after the first byte
// of `é` (C3 A9) so a per-chunk UTF-8 decode would inject U+FFFD.
if (process.env['FAKE_GROK_SPLIT_UTF8']) {
  const bytes = Buffer.from('ok café — 日本語 ✓', 'utf8');
  const eAcute = bytes.indexOf(0xc3);
  const at = eAcute === -1 ? 1 : eAcute + 1;
  writeSync(1, bytes.subarray(0, at));
  await delay(30);
  writeSync(1, bytes.subarray(at));
}

const streamFile = process.env['FAKE_GROK_STREAM_FILE'];
if (streamFile) {
  await writeStreamFile(streamFile);
}

const stdoutBytes = Number(process.env['FAKE_GROK_STDOUT_BYTES']);
if (Number.isFinite(stdoutBytes) && stdoutBytes > 0) {
  await writeFill(1, stdoutBytes);
}

const sleepMs = Number(process.env['FAKE_GROK_SLEEP_MS']);
if (Number.isFinite(sleepMs) && sleepMs > 0) {
  await delay(sleepMs);
}

const exitRaw = process.env['FAKE_GROK_EXIT_CODE'];
const exitCode = exitRaw === undefined || exitRaw === '' ? 0 : Number.parseInt(exitRaw, 10);
process.exit(Number.isInteger(exitCode) ? exitCode : 0);

/**
 * Stream `byteCount` filler bytes in fixed-size chunks. Building one giant string
 * would let the fixture itself be what runs out of memory — the opposite of what
 * the buffer-cap test is measuring.
 *
 * writeSync on a non-blocking pipe throws EAGAIN once the kernel buffer fills,
 * so this path uses async write() and retries after yielding — that lets the
 * parent drain the pipe.
 *
 * @param {number} fd
 * @param {number} byteCount
 */
async function writeFill(fd, byteCount) {
  const chunkSize = 64 * 1024;
  const chunk = Buffer.alloc(Math.min(chunkSize, byteCount), 0x61);
  let remaining = byteCount;
  while (remaining > 0) {
    const size = Math.min(chunk.length, remaining);
    const slice = size === chunk.length ? chunk : chunk.subarray(0, size);
    try {
      remaining -= await writeFd(fd, slice);
    } catch (error) {
      if (isAgain(error)) {
        await delay(1);
        continue;
      }
      throw error;
    }
  }
}

/**
 * @param {number} fd
 * @param {Buffer} buffer
 * @returns {Promise<number>}
 */
function writeFd(fd, buffer) {
  return new Promise((resolve, reject) => {
    writeCallback(fd, buffer, (error, written) => {
      if (error) reject(error);
      else resolve(typeof written === 'number' ? written : buffer.length);
    });
  });
}

function isAgain(error) {
  const message = error instanceof Error ? error.message : '';
  return message.startsWith('EAGAIN') || message.startsWith('EWOULDBLOCK');
}

/**
 * Write an NDJSON transcript line by line. Optional delay and mid-line split
 * exercise the parent's decoder and NDJSON reader across real chunk boundaries.
 *
 * @param {string} filePath
 */
async function writeStreamFile(filePath) {
  const contents = readFileSync(filePath);
  const delayMs = Number(process.env['FAKE_GROK_STREAM_DELAY_MS']);
  const split = Boolean(process.env['FAKE_GROK_STREAM_SPLIT']);
  const lines = splitBufferLines(contents);
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0 && Number.isFinite(delayMs) && delayMs > 0) {
      await delay(delayMs);
    }
    const line = lines[i];
    if (line === undefined) continue;
    if (split && line.length >= 2) {
      const at = Math.floor(line.length / 2);
      writeSync(1, line.subarray(0, at));
      writeSync(1, line.subarray(at));
    } else {
      writeSync(1, line);
    }
  }
}

/**
 * @param {Buffer} buf
 * @returns {Buffer[]}
 */
function splitBufferLines(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < buf.length) {
    lines.push(buf.subarray(start));
  }
  return lines;
}
