/**
 * stderr-only logging.
 *
 * stdout is the MCP protocol channel — a single stray write there corrupts the session for the
 * client. Every diagnostic in this server goes through here.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveThreshold(): number {
  const raw = process.env['GROK_MCP_LOG_LEVEL']?.trim().toLowerCase();
  if (raw && raw in LEVEL_RANK) {
    return LEVEL_RANK[raw as LogLevel];
  }
  return LEVEL_RANK.info;
}

let threshold = resolveThreshold();

/** Re-read `GROK_MCP_LOG_LEVEL`. Exists so tests can flip the level without reloading the module. */
export function refreshLogLevel(): void {
  threshold = resolveThreshold();
}

function emit(level: LogLevel, message: string, detail?: unknown): void {
  if (LEVEL_RANK[level] < threshold) return;

  let line = `[grok-build-mcp] ${level}: ${message}`;
  if (detail !== undefined) {
    line += ` ${formatDetail(detail)}`;
  }
  process.stderr.write(`${line}\n`);
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return detail.stack ?? `${detail.name}: ${detail.message}`;
  }
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export const log = {
  debug: (message: string, detail?: unknown) => {
    emit('debug', message, detail);
  },
  info: (message: string, detail?: unknown) => {
    emit('info', message, detail);
  },
  warn: (message: string, detail?: unknown) => {
    emit('warn', message, detail);
  },
  error: (message: string, detail?: unknown) => {
    emit('error', message, detail);
  },
};
