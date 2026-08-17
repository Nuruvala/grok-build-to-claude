/**
 * On-disk store for background runs. Imperative shell: the only jobs module
 * that touches the filesystem.
 *
 * One directory per run so two concurrent runs cannot collide by construction.
 * `record.json` is read-modify-written; that is only safe because ownership is
 * exclusive at every moment:
 *
 * - the MCP server writes the record once, at creation, and never again;
 * - the worker owns every non-terminal update (pid, running, progress, argv);
 * - the terminal transition goes through `finalizeRun`, which claims, writes,
 *   and releases the claim if the write does not land.
 */

import { mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { InvalidArgumentsError, JobStoreError } from '../errors.js';
import { log } from '../log.js';
import {
  applyPatch,
  isTerminal,
  parseRunRecord,
  RECORD_SCHEMA_VERSION,
  summarize,
  type RunPatch,
  type RunRecord,
  type RunState,
} from './record.js';

/** Directory under `$GROK_MCP_STATE_DIR` that holds one folder per run. */
export const RUNS_SUBDIR = 'runs';
/** Bounded read, same reasoning as sessions/store.ts: a huge file must not fill memory. */
export const RECORD_MAX_BYTES = 256 * 1024;
/** Prompts can be hundreds of kilobytes; this is the cap on the once-written input file. */
export const INPUT_MAX_BYTES = 8 * 1024 * 1024;
/** Per log file; a run that exceeds it gets a marker and stops appending. */
export const LOG_MAX_BYTES = 32 * 1024 * 1024;
/** Directories examined by one list call, so a huge store cannot stall the request. */
export const LIST_SCAN_CAP = 500;
/** Default number of bytes `status` tails from a progress log. */
export const DEFAULT_TAIL_BYTES = 8 * 1024;

const RECORD_FILE = 'record.json';
const INPUT_FILE = 'input.json';
const CLAIM_FILE = 'terminal.claim';
const LOST_CLAIM_RETRIES = 5;
const LOST_CLAIM_WAIT_MS = 20;

/** Name uniquifier for atomic tmp files — not business state. */
let tmpSerial = 0;

export function runsRoot(stateDir: string): string {
  return path.join(stateDir, RUNS_SUBDIR);
}

export function runDir(stateDir: string, runId: string): string {
  return path.join(runsRoot(stateDir), runId);
}

export interface CreateRunOptions {
  readonly stateDir: string;
  readonly runId: string;
  readonly tool: string;
  readonly summary: string;
  readonly cwd: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export async function createRun(options: CreateRunOptions): Promise<RunRecord> {
  // Same serialization writeJsonAtomic uses, so the cap matches what we write
  // and what readRunInput will refuse to load.
  const serializedInput = `${JSON.stringify(options.input, null, 2)}\n`;
  const inputBytes = Buffer.byteLength(serializedInput);
  if (inputBytes > INPUT_MAX_BYTES) {
    throw new InvalidArgumentsError(options.tool, [
      `input.json would be ${inputBytes} bytes, which exceeds the ${INPUT_MAX_BYTES}-byte cap. ` +
        'Shorten the prompt; a background run that cannot be read back is refused at the call.',
    ]);
  }

  const dir = runDir(options.stateDir, options.runId);
  await mkdirp(dir);

  const createdAt = new Date().toISOString();
  const record = applyPatch(
    {
      schemaVersion: RECORD_SCHEMA_VERSION,
      runId: options.runId,
      tool: options.tool,
      summary: summarize(options.summary),
      state: 'starting',
      cwd: options.cwd,
      createdAt,
      startedAt: null,
      endedAt: null,
      workerPid: null,
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
    {},
  );

  await writeJsonAtomic(path.join(dir, RECORD_FILE), record);
  await writeTextAtomic(path.join(dir, INPUT_FILE), serializedInput);
  return record;
}

export async function readRun(stateDir: string, runId: string): Promise<RunRecord | null> {
  const filePath = path.join(runDir(stateDir, runId), RECORD_FILE);
  const raw = await readBounded(filePath, RECORD_MAX_BYTES);
  if (raw === null) return null;
  if (raw.truncated) {
    // A file this large is not a record we wrote. Refuse it rather than
    // parsing a truncated prefix that might accidentally look valid.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text) as unknown;
  } catch {
    return null;
  }
  return parseRunRecord(parsed, runId);
}

export async function readRunInput(
  stateDir: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const filePath = path.join(runDir(stateDir, runId), INPUT_FILE);
  const raw = await readBounded(filePath, INPUT_MAX_BYTES);
  if (raw === null || raw.truncated) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

export interface ListedRuns {
  readonly records: readonly RunRecord[];
  readonly scanned: number;
  readonly unreadable: number;
  readonly truncated: boolean;
}

export interface ListRunsOptions {
  /**
   * Override of LIST_SCAN_CAP. Tests pass a lowered value so a fixture does
   * not have to contain 501 directories; production never sets this.
   */
  readonly scanCap?: number | undefined;
}

export async function listRuns(
  stateDir: string,
  limit: number,
  options: ListRunsOptions = {},
): Promise<ListedRuns> {
  const root = runsRoot(stateDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return freezeListed({ records: [], scanned: 0, unreadable: 0, truncated: false });
    }
    throw new JobStoreError(stateDir, { cause: error, code: errorCode(error) });
  }

  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));

  const scanCap = options.scanCap ?? LIST_SCAN_CAP;
  const truncated = names.length > scanCap;
  const toRead = names.slice(0, scanCap);

  const records: RunRecord[] = [];
  let unreadable = 0;
  for (const name of toRead) {
    const record = await readRun(stateDir, name);
    if (record === null) {
      unreadable += 1;
      continue;
    }
    records.push(record);
  }

  return freezeListed({
    records: records.slice(0, limit),
    scanned: toRead.length,
    unreadable,
    truncated,
  });
}

/**
 * Non-terminal update. Refuses (returns null) once the record is terminal.
 * Worker-only — the server writes the record once, at creation, and never again.
 */
export async function patchRun(
  stateDir: string,
  runId: string,
  patch: RunPatch,
): Promise<RunRecord | null> {
  const current = await readRun(stateDir, runId);
  if (current === null) return null;
  if (isTerminal(current.state)) return null;
  const next = applyPatch(current, patch);
  if (isTerminal(next.state)) return null;
  await writeJsonAtomic(path.join(runDir(stateDir, runId), RECORD_FILE), next);
  return next;
}

export type ClaimOutcome =
  { readonly kind: 'claimed' } | { readonly kind: 'lost'; readonly record: RunRecord | null };

export async function claimTerminal(
  stateDir: string,
  runId: string,
  claimant: string,
): Promise<ClaimOutcome> {
  const claimPath = path.join(runDir(stateDir, runId), CLAIM_FILE);
  try {
    const handle = await open(claimPath, 'wx');
    try {
      await handle.writeFile(
        `${JSON.stringify({ claimant, at: new Date().toISOString() })}\n`,
        'utf8',
      );
    } finally {
      await handle.close();
    }
    return { kind: 'claimed' };
  } catch (error: unknown) {
    if (errorCode(error) !== 'EEXIST') {
      throw error;
    }
    let record = await readRun(stateDir, runId);
    for (
      let attempt = 0;
      attempt < LOST_CLAIM_RETRIES && record !== null && !isTerminal(record.state);
      attempt += 1
    ) {
      await delay(LOST_CLAIM_WAIT_MS);
      record = await readRun(stateDir, runId);
    }
    return { kind: 'lost', record };
  }
}

/** Only legal after a `claimed` outcome. Writes the terminal record. */
export async function writeTerminal(
  stateDir: string,
  runId: string,
  patch: RunPatch & { readonly state: RunState },
): Promise<RunRecord | null> {
  const current = await readRun(stateDir, runId);
  if (current === null) return null;
  const next = applyPatch(current, patch);
  await writeJsonAtomic(path.join(runDir(stateDir, runId), RECORD_FILE), next);
  return next;
}

export type FinalizeOutcome =
  | { readonly kind: 'finalized'; readonly record: RunRecord }
  | { readonly kind: 'lost'; readonly record: RunRecord | null };

/**
 * Claim the terminal transition and write it as one operation. Production
 * callers go through this; `claimTerminal` / `writeTerminal` stay exported
 * for tests that exercise the race directly.
 *
 * A claim is a promise to write a terminal state, and a claimant that cannot
 * keep it must give the promise back — otherwise the next process to try
 * (the worker's error path, `status`, M5b's `stop`) loses forever.
 */
export async function finalizeRun(
  stateDir: string,
  runId: string,
  claimant: string,
  patch: RunPatch & { readonly state: RunState },
): Promise<FinalizeOutcome> {
  const claim = await claimTerminal(stateDir, runId, claimant);
  if (claim.kind === 'lost') {
    return { kind: 'lost', record: claim.record };
  }

  try {
    const record = await writeTerminal(stateDir, runId, patch);
    if (record === null) {
      throw new Error(`record ${runId} disappeared after a successful terminal claim`);
    }
    return { kind: 'finalized', record };
  } catch (error: unknown) {
    await releaseClaim(stateDir, runId);
    throw error;
  }
}

async function releaseClaim(stateDir: string, runId: string): Promise<void> {
  try {
    await unlink(path.join(runDir(stateDir, runId), CLAIM_FILE));
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      log.debug('failed to release terminal claim', { runId, error: errorCode(error) });
    }
  }
}

export function createLogAppender(
  filePath: string,
  maxBytes: number,
): {
  readonly write: (text: string) => void;
  readonly close: () => Promise<void>;
} {
  let handle: FileHandle | undefined;
  let bytes = 0;
  let truncated = false;
  let loggedFailure = false;

  let queue: Promise<void> = Promise.resolve().then(async () => {
    try {
      const info = await stat(filePath);
      bytes = info.size;
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        log.debug('log appender stat failed', { path: filePath, error: errorCode(error) });
      }
      bytes = 0;
    }
    handle = await open(filePath, 'a');
    if (bytes >= maxBytes) {
      truncated = true;
    }
  });

  queue = queue.catch((error: unknown) => {
    logFailure(error);
  });

  function logFailure(error: unknown): void {
    if (loggedFailure) return;
    loggedFailure = true;
    log.debug('log append failed', { path: filePath, error });
  }

  function write(text: string): void {
    queue = queue
      .then(async () => {
        if (handle === undefined || truncated) return;
        const payload = Buffer.from(text, 'utf8');
        if (bytes + payload.byteLength > maxBytes) {
          const marker = `[log truncated at ${maxBytes} bytes by grok-build-mcp-server]\n`;
          await handle.write(marker);
          bytes += Buffer.byteLength(marker);
          truncated = true;
          return;
        }
        await handle.write(payload);
        bytes += payload.byteLength;
      })
      .catch((error: unknown) => {
        logFailure(error);
      });
  }

  async function close(): Promise<void> {
    await queue;
    if (handle === undefined) return;
    const toClose = handle;
    handle = undefined;
    try {
      await toClose.close();
    } catch (error: unknown) {
      log.debug('log appender close failed', { path: filePath, error: errorCode(error) });
    }
  }

  return { write, close };
}

export async function tailFile(
  filePath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    if (info.size <= maxBytes) {
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read({ buffer, position: 0 });
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: false };
    }
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read({ buffer, position: info.size - maxBytes });
    const decoded = buffer.subarray(0, bytesRead).toString('utf8');
    // A byte offset lands mid-character and almost always mid-line. Drop the
    // partial first line so the caller never sees U+FFFD or a chopped progress
    // row. The byte cap is unchanged — this is about what is shown.
    const newline = decoded.indexOf('\n');
    const text = newline === -1 ? '' : decoded.slice(newline + 1);
    return { text, truncated: true };
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return { text: '', truncated: false };
    }
    throw error;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error: unknown) {
        log.debug('file handle close failed', { path: filePath, error: errorCode(error) });
      }
    }
  }
}

export async function removeRunDir(stateDir: string, runId: string): Promise<void> {
  await rm(runDir(stateDir, runId), { recursive: true, force: true });
}

/**
 * Directory names only, newest first. The retention sweep uses this so it
 * can skip opening records that are still inside the keep window.
 */
export async function listRunIds(stateDir: string): Promise<readonly string[]> {
  const root = runsRoot(stateDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return [];
    throw new JobStoreError(stateDir, { cause: error, code: errorCode(error) });
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  tmpSerial += 1;
  const tmpPath = `${filePath}.${process.pid}.${tmpSerial}.tmp`;
  try {
    await writeFile(tmpPath, text, 'utf8');
    await rename(tmpPath, filePath);
  } catch (error: unknown) {
    try {
      await unlink(tmpPath);
    } catch (cleanupError: unknown) {
      if (errorCode(cleanupError) !== 'ENOENT') {
        log.debug('tmp file cleanup failed', { path: tmpPath, error: errorCode(cleanupError) });
      }
    }
    throw error;
  }
}

async function readBounded(
  filePath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean } | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    if (info.size > maxBytes) {
      return { text: '', truncated: true };
    }
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read({ buffer, position: 0 });
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: false };
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    log.debug('bounded read failed', { path: filePath, error: errorCode(error) });
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error: unknown) {
        log.debug('file handle close failed', { path: filePath, error: errorCode(error) });
      }
    }
  }
}

async function mkdirp(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

function freezeListed(listed: ListedRuns): ListedRuns {
  return Object.freeze({
    ...listed,
    records: Object.freeze([...listed.records]),
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

export { errorCode as storeErrorCode };
