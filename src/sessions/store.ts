/**
 * Read the on-disk Grok session store.
 *
 * Imperative shell: the only module in `sessions/` that touches the
 * filesystem. It does not spawn `grok sessions list` — that command has no
 * `--json` flag and is scoped to the current directory. Per-file failures are
 * counted, never fatal: one corrupt session must not hide the rest.
 */

import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { SessionsStoreError } from '../errors.js';
import { log } from '../log.js';
import { extractFirstPrompt } from './prompt.js';
import { type SessionRecord } from './select.js';
import { parseSessionSummary, type SessionSummary } from './summary.js';

/** Caps summary.json reads per call so a huge store cannot stall the request. */
export const SESSION_SCAN_CAP = 2000;
/** Caps history reads when a query is given, so search cannot open every file. */
export const PROMPT_SCAN_CAP = 200;
/** Caps the history head we keep in memory; files here reach hundreds of KB. */
export const PROMPT_HEAD_BYTES = 128 * 1024;
/**
 * Caps a single summary.json read. A huge or corrupt file must not fill memory;
 * the truncated bytes then fail JSON.parse and count as unreadable.
 */
export const SUMMARY_MAX_BYTES = 256 * 1024;

const HISTORY_FILE = 'chat_history.jsonl';
const SUMMARY_FILE = 'summary.json';

export interface LoadSessionsOptions {
  readonly sessionsDir: string;
  /** Absolute path. Keeps only sessions that started in this directory. */
  readonly cwd?: string | undefined;
  /**
   * Override of SESSION_SCAN_CAP. Tests pass a lowered value so a fixture does
   * not have to contain 2001 directories; production never sets this.
   */
  readonly scanCap?: number | undefined;
}

export interface LoadedSessions {
  readonly records: readonly SessionRecord[];
  readonly scanned: number;
  /** Session directories beyond SESSION_SCAN_CAP that were never read. */
  readonly skipped: number;
  /** Directories whose summary.json was missing or unreadable. Still present in `records`. */
  readonly unreadable: number;
  /**
   * Encoded-cwd directories whose children could not be listed. Separate from
   * `unreadable`: those rows are still in `records`, and these are not.
   */
  readonly unlistedDirs: number;
  /** The store directory does not exist — no grok run has happened yet. */
  readonly storeMissing: boolean;
}

export async function loadSessions(options: LoadSessionsOptions): Promise<LoadedSessions> {
  const listed = await listSessionDirs(options);
  if (listed.storeMissing) {
    return freezeLoaded({
      records: [],
      scanned: 0,
      skipped: 0,
      unreadable: 0,
      unlistedDirs: 0,
      storeMissing: true,
    });
  }

  const cap = options.scanCap ?? SESSION_SCAN_CAP;
  const toRead = await selectDirsToRead(listed.dirs, cap);
  const skipped = listed.dirs.length - toRead.length;

  const records: SessionRecord[] = [];
  let unreadable = 0;

  for (const entry of toRead) {
    const loaded = await loadOne(entry);
    if (options.cwd !== undefined && !samePath(loaded.record.cwd, options.cwd)) {
      // Decoded directory name matched the filter; info.cwd is authoritative
      // and does not. Drop it rather than report a session as belonging here.
      // Count unreadable only among records that survive: the field's doc
      // says those rows are still present in `records`.
      continue;
    }
    if (!loaded.summaryAvailable) unreadable += 1;
    records.push(loaded.record);
  }

  return freezeLoaded({
    records,
    scanned: toRead.length,
    skipped,
    unreadable,
    unlistedDirs: listed.unlistedDirs,
    storeMissing: false,
  });
}

/**
 * Direct lookup by id. No scan cap: the id is a directory name, so this reads
 * one summary. ENOENT on the store root is a miss (`null`), not a throw; any
 * other root failure is still a SessionsStoreError.
 */
export async function findSessionById(
  sessionsDir: string,
  id: string,
): Promise<SessionRecord | null> {
  let rootEntries: Dirent[];
  try {
    rootEntries = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new SessionsStoreError(sessionsDir, {
      cause: error,
      code: errorCode(error),
    });
  }

  const lowered = id.toLowerCase();
  let insensitive: SessionDir | undefined;
  for (const cwdEntry of rootEntries) {
    if (!cwdEntry.isDirectory()) continue;
    const cwdPath = path.join(sessionsDir, cwdEntry.name);
    const fallbackCwd = decodeDirName(cwdEntry.name);
    let children: Dirent[];
    try {
      children = await readdir(cwdPath, { withFileTypes: true });
    } catch (error: unknown) {
      log.debug('session cwd directory could not be listed', {
        path: cwdPath,
        error: errorCode(error),
      });
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const entry: SessionDir = {
        dir: path.join(cwdPath, child.name),
        id: child.name,
        fallbackCwd,
      };
      if (child.name === id) {
        const loaded = await loadOne(entry);
        return loaded.record;
      }
      if (insensitive === undefined && child.name.toLowerCase() === lowered) {
        insensitive = entry;
      }
    }
  }

  if (insensitive === undefined) return null;
  const loaded = await loadOne(insensitive);
  return loaded.record;
}

/** Bounded head read of one session's chat_history.jsonl. Returns the record with firstPrompt filled. */
export async function attachFirstPrompt(record: SessionRecord): Promise<SessionRecord> {
  const historyPath = path.join(record.dir, HISTORY_FILE);
  try {
    const headText = await readHead(historyPath, PROMPT_HEAD_BYTES);
    return freezeRecord({
      ...record,
      firstPrompt: extractFirstPrompt(headText),
    });
  } catch (error: unknown) {
    // Missing history, EACCES, or a truncated read: the list still works
    // without a prompt fallback. Throwing here would hide every other row.
    log.debug('session history head read failed', { path: historyPath, error: errorCode(error) });
    return record;
  }
}

export async function attachFirstPrompts(
  records: readonly SessionRecord[],
): Promise<readonly SessionRecord[]> {
  const out: SessionRecord[] = [];
  for (const record of records) {
    out.push(await attachFirstPrompt(record));
  }
  return Object.freeze(out);
}

interface SessionDir {
  readonly dir: string;
  readonly id: string;
  readonly fallbackCwd: string;
}

interface ListedSessions {
  readonly dirs: readonly SessionDir[];
  readonly storeMissing: boolean;
  readonly unlistedDirs: number;
}

async function listSessionDirs(options: LoadSessionsOptions): Promise<ListedSessions> {
  let rootEntries: Dirent[];
  try {
    rootEntries = await readdir(options.sessionsDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return { dirs: [], storeMissing: true, unlistedDirs: 0 };
    }
    throw new SessionsStoreError(options.sessionsDir, {
      cause: error,
      code: errorCode(error),
    });
  }

  const dirs: SessionDir[] = [];
  let unlistedDirs = 0;
  for (const cwdEntry of rootEntries) {
    if (!cwdEntry.isDirectory()) continue;
    const fallbackCwd = decodeDirName(cwdEntry.name);
    if (options.cwd !== undefined && !samePath(fallbackCwd, options.cwd)) {
      continue;
    }

    const cwdPath = path.join(options.sessionsDir, cwdEntry.name);
    let children: Dirent[];
    try {
      children = await readdir(cwdPath, { withFileTypes: true });
    } catch (error: unknown) {
      log.debug('session cwd directory could not be listed', {
        path: cwdPath,
        error: errorCode(error),
      });
      unlistedDirs += 1;
      continue;
    }

    for (const child of children) {
      if (!child.isDirectory()) continue;
      dirs.push({
        dir: path.join(cwdPath, child.name),
        id: child.name,
        fallbackCwd,
      });
    }
  }

  return { dirs, storeMissing: false, unlistedDirs };
}

async function loadOne(
  entry: SessionDir,
): Promise<{ readonly record: SessionRecord; readonly summaryAvailable: boolean }> {
  const summaryPath = path.join(entry.dir, SUMMARY_FILE);
  try {
    // A file larger than SUMMARY_MAX_BYTES is truncated here, so JSON.parse
    // fails and the directory is counted unreadable. That is the correct
    // outcome, not an accident.
    const raw = await readHead(summaryPath, SUMMARY_MAX_BYTES);
    const parsed: unknown = JSON.parse(raw);
    return {
      record: toRecord(parseSessionSummary(parsed, entry.id, entry.fallbackCwd), entry.dir, true),
      summaryAvailable: true,
    };
  } catch (error: unknown) {
    log.debug('session summary unreadable', { path: summaryPath, error: errorCode(error) });
    return {
      record: toRecord(
        parseSessionSummary(undefined, entry.id, entry.fallbackCwd),
        entry.dir,
        false,
      ),
      summaryAvailable: false,
    };
  }
}

/**
 * When the store is over the cap, keep the newest SESSION_SCAN_CAP directories
 * by mtime. mtime is a proxy for updated_at that costs one stat instead of one
 * file read. The authoritative order is still sortByRecency over what was read.
 * Below the cap this is a no-op — no extra syscalls on the normal path.
 */
async function selectDirsToRead(
  dirs: readonly SessionDir[],
  cap: number,
): Promise<readonly SessionDir[]> {
  if (dirs.length <= cap) return dirs;

  const ranked: { readonly entry: SessionDir; readonly mtimeMs: number }[] = [];
  for (const entry of dirs) {
    ranked.push({ entry, mtimeMs: await dirMtimeMs(entry.dir) });
  }
  ranked.sort((left, right) => {
    if (left.mtimeMs === right.mtimeMs) return 0;
    return left.mtimeMs < right.mtimeMs ? 1 : -1;
  });
  return ranked.slice(0, cap).map((row) => row.entry);
}

async function dirMtimeMs(dir: string): Promise<number> {
  try {
    const info = await stat(dir);
    return info.mtimeMs;
  } catch (error: unknown) {
    log.debug('session directory stat failed', { path: dir, error: errorCode(error) });
    return Number.NEGATIVE_INFINITY;
  }
}

async function readHead(filePath: string, maxBytes: number): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read({ buffer, position: 0 });
    return buffer.subarray(0, bytesRead).toString('utf8');
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

function toRecord(summary: SessionSummary, dir: string, summaryAvailable: boolean): SessionRecord {
  return freezeRecord({
    ...summary,
    dir,
    summaryAvailable,
    firstPrompt: null,
  });
}

function freezeRecord(record: SessionRecord): SessionRecord {
  return Object.freeze({
    ...record,
    gitRemotes: Object.freeze([...record.gitRemotes]),
  });
}

function freezeLoaded(loaded: LoadedSessions): LoadedSessions {
  return Object.freeze({
    ...loaded,
    records: Object.freeze([...loaded.records]),
  });
}

/**
 * Decode a percent-encoded cwd segment. A name that fails to decode is kept
 * verbatim rather than dropped — encodeURIComponent is an observation about
 * this store, not a contract we enforce by throwing names away.
 */
function decodeDirName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function samePath(left: string, right: string): boolean {
  return canonicalizePath(left) === canonicalizePath(right);
}

/**
 * Resolve, then drop a single trailing separator. No case-folding: Linux
 * paths are case-sensitive, and folding `/tmp/Foo` onto `/tmp/foo` would
 * mix two stores.
 */
function canonicalizePath(value: string): string {
  const resolved = path.resolve(value);
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    return resolved.slice(0, -1);
  }
  return resolved;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}
