#!/usr/bin/env node
/**
 * Entry point.
 *
 * Nothing here may write to stdout — it is the MCP transport channel.
 */

import { ConfigError } from './errors.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { startServer } from './server.js';
import { SERVER_NAME, VERSION } from './version.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stderr.write(`${SERVER_NAME} ${VERSION}\n`);
    return;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(usage());
    return;
  }

  const config = loadConfig();
  const server = await startServer(config);

  const shutdown = (signal: NodeJS.Signals) => {
    log.info(`received ${signal}, shutting down`);
    void server.close().finally(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function usage(): string {
  return [
    `${SERVER_NAME} ${VERSION} — MCP stdio server for the Grok Build CLI`,
    '',
    'This is an MCP server. It speaks JSON-RPC over stdio and is meant to be launched by an',
    'MCP client, not run interactively.',
    '',
    '  claude mcp add grok-build -- npx -y grok-build-mcp-server',
    '',
    'Environment:',
    '  GROK_BINARY                   grok executable (default: grok on PATH)',
    '  GROK_MCP_PERMISSION_CEILING   read-only | write | full (default: read-only)',
    '  GROK_MCP_DEFAULT_PERMISSION   read-only | write | full (default: read-only)',
    '  GROK_MCP_DEFAULT_MODEL        default model (default: grok-4.6, "none" to defer to grok)',
    '  GROK_MCP_DEFAULT_EFFORT       default effort (default: high, "none" to defer to grok)',
    '  GROK_MCP_TIMEOUT_MS           per-run wall clock (default: 1800000)',
    '  GROK_MCP_STATE_DIR            background job records',
    '  GROK_MCP_LOG_LEVEL            debug | info | warn | error (default: info)',
    '  STRUCTURED_CONTENT_ENABLED    also emit structuredContent',
    '',
  ].join('\n');
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n\n${error.remedy ?? ''}\n`);
  } else {
    log.error('fatal', error);
  }
  process.exit(1);
});
