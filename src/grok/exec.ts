/**
 * Imperative shell around `child_process.spawn` for a headless grok run.
 *
 * Never rejects: every path — spawn failure, timeout, abort, non-zero exit —
 * resolves with whatever output was buffered. Rejecting and discarding the
 * buffer is the plugin's `child.on("error")` bug.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { log } from '../log.js';

export const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** SIGTERM first, then SIGKILL. Long enough that a well-behaved child can flush; short enough that a stuck one does not hang the caller. */
const SIGKILL_GRACE_MS = 5000;

/**
 * `close` fires only once the stdio pipes reach EOF, which anything still holding an inherited
 * descriptor keeps open — a grandchild that escaped the process group, most often. Both backstops
 * below exist so that cannot strand the caller: a run must always terminate and always report.
 */
const STDIO_DRAIN_GRACE_MS = 2000;
const FORCE_RESOLVE_GRACE_MS = 2000;

export type ExecOutcome = 'exited' | 'timeout' | 'aborted' | 'spawn-failed';

export interface ExecOptions {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly maxBufferBytes?: number | undefined;
  /** Called with each decoded stdout chunk. Used by streaming callers in M2. */
  readonly onStdout?: ((chunk: string) => void) | undefined;
  readonly onStderr?: ((chunk: string) => void) | undefined;
  /**
   * Fires synchronously right after `spawn()` returns with a defined `pid` — the
   * same place `childPid` is captured, so a timeout in that gap still has a
   * process to signal. Background workers use this to record the grok pid.
   */
  readonly onSpawn?: ((pid: number) => void) | undefined;
  /**
   * Default: true on POSIX, as today. A background worker passes `false` so the
   * grok process stays inside the worker's process group; the worker is itself
   * a group leader, and `kill(-workerPid)` then reaps the whole tree.
   */
  readonly detached?: boolean | undefined;
}

export interface ExecResult {
  readonly outcome: ExecOutcome;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  /** Set only when `outcome` is 'spawn-failed'. */
  readonly spawnError: Error | null;
}

export function execGrok(options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const stdoutBuf = createCappedBuffer(maxBufferBytes);
    const stderrBuf = createCappedBuffer(maxBufferBytes);
    // Incremental decoders so a multi-byte character split across two `data`
    // events is not handed to onStdout as U+FFFD. The capped buffer still takes
    // raw Buffers — its cap is a byte cap and must stay byte-exact.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    let settled = false;
    let spawned = false;
    let outcome: ExecOutcome = 'exited';
    let spawnError: Error | null = null;
    let childPid: number | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;
    // Captured for terminate(): a non-detached child is not a process-group
    // leader, so `kill(-pid)` would target a group that does not exist.
    const detached = options.detached ?? process.platform !== 'win32';

    function cleanup(): void {
      for (const timer of [timeoutTimer, killTimer, drainTimer, forceTimer]) {
        if (timer !== undefined) clearTimeout(timer);
      }
      timeoutTimer = undefined;
      killTimer = undefined;
      drainTimer = undefined;
      forceTimer = undefined;
      options.signal?.removeEventListener('abort', onAbort);
    }

    function finish(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      settled = true;
      // Flush here rather than on `end` so a killed child whose pipes never
      // reach EOF still yields a trailing partial character instead of dropping it.
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail !== '') options.onStdout?.(stdoutTail);
      const stderrTail = stderrDecoder.end();
      if (stderrTail !== '') options.onStderr?.(stderrTail);
      cleanup();
      resolve(
        Object.freeze({
          outcome,
          code,
          signal,
          stdout: stdoutBuf.toString(),
          stderr: stderrBuf.toString(),
          stdoutTruncated: stdoutBuf.truncated,
          stderrTruncated: stderrBuf.truncated,
          durationMs: performance.now() - started,
          spawnError,
        }),
      );
    }

    function requestKill(reason: 'timeout' | 'aborted'): void {
      if (settled) return;
      if (outcome === 'timeout' || outcome === 'aborted') return;
      outcome = reason;
      terminate(child, childPid, 'SIGTERM', detached);
      killTimer = setTimeout(() => {
        terminate(child, childPid, 'SIGKILL', detached);
        // SIGKILL cannot be caught, so a child that still has not closed is not the thing keeping
        // us waiting — something outside our process group is holding the pipes. Report what was
        // buffered rather than waiting on an EOF that may never come.
        forceTimer = setTimeout(() => {
          finish(null, null);
        }, FORCE_RESOLVE_GRACE_MS);
      }, SIGKILL_GRACE_MS);
    }

    function onAbort(): void {
      requestKill('aborted');
    }

    // An already-aborted signal must not spawn at all.
    if (options.signal?.aborted === true) {
      outcome = 'aborted';
      finish(null, null);
      return;
    }

    try {
      child = spawn(options.binary, [...options.args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        // Headless grok does not read piped stdin; an open stdin can hang the child.
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX: child leads its own process group so we can kill the whole tree.
        // Windows process-group semantics differ — see terminate().
        detached,
      });
    } catch (error: unknown) {
      outcome = 'spawn-failed';
      spawnError = asError(error);
      finish(null, null);
      return;
    }

    // Read synchronously: `pid` is set the moment the fork succeeds, whereas the `spawn` event is
    // a tick away. A timeout or abort firing in that gap would otherwise find `childPid`
    // undefined, signal nothing, and leave us waiting on a child nobody asked to stop.
    childPid = child.pid;
    if (childPid !== undefined) {
      options.onSpawn?.(childPid);
    }

    child.once('spawn', () => {
      spawned = true;
      childPid = child.pid ?? childPid;
    });

    child.on('error', (error: Error) => {
      if (spawned) {
        // Kill/stdio errors after a successful spawn must not discard the buffer.
        log.debug('child process error after spawn', error);
        return;
      }
      outcome = 'spawn-failed';
      spawnError = error;
      finish(null, null);
    });

    child.stdout?.on('data', (chunk: unknown) => {
      const data = asBuffer(chunk);
      options.onStdout?.(stdoutDecoder.write(data));
      stdoutBuf.push(data);
    });

    child.stderr?.on('data', (chunk: unknown) => {
      const data = asBuffer(chunk);
      options.onStderr?.(stderrDecoder.write(data));
      stderrBuf.push(data);
    });

    child.on('close', (code, signal) => {
      finish(code, signal);
    });

    child.on('exit', (code, signal) => {
      // The process is gone; only the pipes are outstanding. Give them a moment to drain so a
      // normal run still reports its full output, then report regardless.
      drainTimer ??= setTimeout(() => {
        finish(code, signal);
      }, STDIO_DRAIN_GRACE_MS);
    });

    timeoutTimer = setTimeout(() => {
      requestKill('timeout');
    }, options.timeoutMs);

    // Re-check after spawn: the signal may have flipped in the gap. The type
    // system treats `aborted` as unchanged after the early return; the flag is
    // not frozen at that snapshot.
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', onAbort);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- race with spawn()
      if (options.signal.aborted) {
        onAbort();
      }
    }
  });
}

function terminate(
  child: ChildProcess | undefined,
  pid: number | undefined,
  signal: NodeJS.Signals,
  detached: boolean,
): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32' || !detached) {
      // Windows has no POSIX process-group kill. A non-detached child is not a
      // group leader either — `kill(-pid)` fails ESRCH and silently kills nothing.
      // child.kill() is the fallback; grandchildren started independently of
      // the job object may survive.
      child?.kill(signal);
      return;
    }
    process.kill(-pid, signal);
  } catch (error: unknown) {
    // ESRCH: the group already exited (natural exit racing with kill). Any other
    // failure is still not actionable — we never reject — but it is unexpected.
    if (errorCode(error) !== 'ESRCH') {
      log.debug(`failed to send ${signal} to process group ${pid}`, error);
    }
  }
}

function createCappedBuffer(maxBytes: number): {
  push: (chunk: Buffer) => void;
  toString: () => string;
  readonly truncated: boolean;
} {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  function push(chunk: Buffer): void {
    if (truncated) return;
    const remaining = maxBytes - size;
    if (chunk.byteLength <= remaining) {
      chunks.push(chunk);
      size += chunk.byteLength;
      return;
    }
    if (remaining > 0) {
      chunks.push(chunk.subarray(0, remaining));
      size += remaining;
    }
    truncated = true;
    chunks.push(
      Buffer.from(`\n[output truncated at ${maxBytes} bytes by grok-build-mcp-server]\n`),
    );
  }

  return {
    push,
    toString: () => Buffer.concat(chunks).toString('utf8'),
    get truncated() {
      return truncated;
    },
  };
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.alloc(0);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('spawn failed');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}
