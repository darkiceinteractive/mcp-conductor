#!/usr/bin/env node
/**
 * Test Echo Server
 *
 * A minimal MCP server for testing that provides deterministic,
 * controllable responses for integration tests.
 *
 * Tools:
 * - echo: Echo back input message
 * - delay: Echo after specified delay (timeout testing)
 * - error: Throw an error (error handling testing)
 * - large_response: Return large data (data size testing)
 * - metadata: Return server metadata (health check)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

// Server state
const serverStartTime = new Date().toISOString();
let toolCallCount = 0;

// Create MCP server
const server = new McpServer({
  name: 'test-echo',
  version: '1.0.0',
});

// Tool: echo - Basic connectivity test
server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Echo back the input message',
    inputSchema: {
      message: z.string().describe('The message to echo back'),
    },
    outputSchema: {
      echoed: z.string(),
      timestamp: z.string(),
      callNumber: z.number(),
    },
  },
  async ({ message }) => {
    toolCallCount++;
    return {
      echoed: message,
      timestamp: new Date().toISOString(),
      callNumber: toolCallCount,
    };
  }
);

// Tool: delay - Timeout testing
server.registerTool(
  'delay',
  {
    title: 'Delay',
    description: 'Echo after specified delay (for timeout testing)',
    inputSchema: {
      message: z.string().describe('The message to echo back'),
      delayMs: z.number().describe('Delay in milliseconds before responding'),
    },
    outputSchema: {
      echoed: z.string(),
      delayed: z.number(),
      timestamp: z.string(),
    },
  },
  async ({ message, delayMs }) => {
    toolCallCount++;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      echoed: message,
      delayed: delayMs,
      timestamp: new Date().toISOString(),
    };
  }
);

// Tool: error - Error handling testing
server.registerTool(
  'error',
  {
    title: 'Error',
    description: 'Throw an error (for error handling testing)',
    inputSchema: {
      errorMessage: z.string().describe('The error message to throw'),
      errorType: z
        .enum(['Error', 'TypeError', 'RangeError'])
        .optional()
        .describe('Type of error to throw'),
    },
    outputSchema: {
      // This tool always throws, no output
    },
  },
  async ({ errorMessage, errorType }) => {
    toolCallCount++;
    const ErrorClass =
      errorType === 'TypeError'
        ? TypeError
        : errorType === 'RangeError'
          ? RangeError
          : Error;
    throw new ErrorClass(errorMessage);
  }
);

// Tool: large_response - Data size testing
server.registerTool(
  'large_response',
  {
    title: 'Large Response',
    description: 'Return large data (for data size testing)',
    inputSchema: {
      sizeKb: z.number().describe('Size of response in kilobytes'),
      pattern: z.string().optional().describe('Character pattern to repeat'),
    },
    outputSchema: {
      data: z.string(),
      actualSizeBytes: z.number(),
      requestedSizeKb: z.number(),
    },
  },
  async ({ sizeKb, pattern }) => {
    toolCallCount++;
    const char = pattern || 'x';
    const targetBytes = sizeKb * 1024;
    const data = char.repeat(Math.ceil(targetBytes / char.length)).slice(0, targetBytes);
    return {
      data,
      actualSizeBytes: data.length,
      requestedSizeKb: sizeKb,
    };
  }
);

// Tool: metadata - Health check and stats
server.registerTool(
  'metadata',
  {
    title: 'Metadata',
    description: 'Return server metadata and statistics',
    inputSchema: {},
    outputSchema: {
      serverName: z.string(),
      version: z.string(),
      startedAt: z.string(),
      toolCallCount: z.number(),
      uptime: z.number(),
      pid: z.number(),
    },
  },
  async () => {
    toolCallCount++;
    const startTime = new Date(serverStartTime).getTime();
    const uptime = Date.now() - startTime;
    return {
      serverName: 'test-echo',
      version: '1.0.0',
      startedAt: serverStartTime,
      toolCallCount,
      uptime,
      pid: process.pid,
    };
  }
);

// Tool: concat - Multi-param test
server.registerTool(
  'concat',
  {
    title: 'Concatenate',
    description: 'Concatenate multiple strings',
    inputSchema: {
      strings: z.array(z.string()).describe('Array of strings to concatenate'),
      separator: z.string().optional().describe('Separator between strings'),
    },
    outputSchema: {
      result: z.string(),
      inputCount: z.number(),
    },
  },
  async ({ strings, separator }) => {
    toolCallCount++;
    return {
      result: strings.join(separator ?? ''),
      inputCount: strings.length,
    };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with MCP protocol on stdout
  console.error(`[test-echo] Server started at ${serverStartTime}`);
  console.error(`[test-echo] PID: ${process.pid}`);

  // Handle shutdown
  process.on('SIGINT', () => {
    console.error('[test-echo] Received SIGINT, shutting down');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('[test-echo] Received SIGTERM, shutting down');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[test-echo] Fatal error:', error);
  process.exit(1);
});
