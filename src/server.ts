/**
 * MCP server wiring: capabilities, request handlers, progress plumbing, and the error envelope.
 */

/*
 * We use the low-level `Server` rather than `McpServer`. The SDK marks `Server` deprecated in
 * favour of the high-level API, but documents it as the path for "advanced use cases" and exposes
 * it as `McpServer.server` — so it is not going away.
 *
 * We need what only the low-level API gives: dispatch through our own registry, an error envelope
 * that turns an unknown tool into readable `isError` text listing the real tool names instead of a
 * bare JSON-RPC error, and direct control over `_meta` on content blocks.
 */
/* eslint-disable @typescript-eslint/no-deprecated */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Config } from './config.js';
import { errorKind, isCallerFault, toErrorText } from './errors.js';
import { promptDirMaxAgeMs, sweepStalePromptDirs } from './grok/prompt-file.js';
import { log } from './log.js';
import { toolDescriptors } from './tools/definitions.js';
import { invokeTool, toolNames } from './tools/registry.js';
import type { ProgressUpdate, ToolContext, ToolResult } from './types.js';
import { SERVER_NAME, VERSION } from './version.js';

export function createServer(config: Config): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {}, logging: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return { tools: toolDescriptors() };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      const started = Date.now();

      const progressToken = extra._meta?.progressToken;
      const context: ToolContext = {
        config,
        signal: extra.signal,
        reportProgress: makeProgressReporter(extra, progressToken),
        progressRequested: progressToken !== undefined,
      };

      try {
        const result = await invokeTool(name, args, context);
        log.debug(`tool ${name} ok in ${Date.now() - started}ms`);
        return result;
      } catch (error) {
        const kind = errorKind(error);
        const detail = isCallerFault(kind)
          ? (error instanceof Error ? error.message : toErrorText(error)).replace(/\n/g, '; ')
          : error;
        log.warn(`tool ${name} failed (${kind}) after ${Date.now() - started}ms`, detail);

        // Errors come back as a normal result with isError, not a thrown JSON-RPC error. Clients
        // hand the text to the model, which can then correct the call instead of stalling.
        const failure: ToolResult = {
          content: [{ type: 'text', text: toErrorText(error), _meta: { errorKind: kind } }],
          isError: true,
        };
        return failure;
      }
    },
  );

  return server;
}

type NotificationSender = (notification: {
  method: 'notifications/progress';
  params: Record<string, unknown>;
}) => Promise<void>;

interface ProgressCapableExtra {
  _meta?: { progressToken?: string | number | undefined } | undefined;
  sendNotification: NotificationSender;
}

/**
 * Build a progress callback for one request.
 *
 * Returns a no-op when the client sent no `progressToken`, so handlers never have to branch. A
 * failed notification is logged and swallowed — losing a progress update must not fail the run
 * that produced it.
 */
function makeProgressReporter(
  extra: ProgressCapableExtra,
  progressToken: string | number | undefined,
): (update: ProgressUpdate) => void {
  if (progressToken === undefined) {
    return () => {
      /* client did not ask for progress */
    };
  }

  return (update: ProgressUpdate) => {
    const params: Record<string, unknown> = {
      progressToken,
      progress: update.progress,
    };
    if (update.total !== undefined) params['total'] = update.total;
    if (update.message !== undefined) params['message'] = update.message;

    void extra
      .sendNotification({ method: 'notifications/progress', params })
      .catch((error: unknown) => {
        log.debug('progress notification failed', error);
      });
  };
}

export async function startServer(config: Config): Promise<Server> {
  const server = createServer(config);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  void sweepStalePromptDirs({ maxAgeMs: promptDirMaxAgeMs(config.timeoutMs) }).catch(
    (error: unknown) => {
      log.debug('prompt-directory sweep failed', error);
    },
  );

  log.info(
    `${SERVER_NAME} v${VERSION} ready on stdio ` +
      `(binary=${config.grokBinary}, ceiling=${config.permissionCeiling}, ` +
      `tools=${toolNames().join(',')})`,
  );

  return server;
}
