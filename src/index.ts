#!/usr/bin/env node
/**
 * MCP Conductor — Main Entry Point
 *
 * @packageDocumentation
 *
 * MCP Conductor is a Model Context Protocol server that orchestrates code
 * execution across multiple MCP backend servers through a sandboxed Deno
 * runtime. Instead of Claude making direct tool calls (whose raw JSON
 * responses inflate the context window), Claude writes TypeScript that
 * runs inside an isolated Deno subprocess. Only the compact result is
 * returned, achieving 88–99% token savings.
 *
 * Architecture:
 * - {@link MCPExecutorServer} — MCP protocol server exposing tools to Claude
 * - {@link ../hub} — Connection pool managing backend MCP server processes
 * - {@link ../bridge} — HTTP bridge between Deno sandbox and the hub
 * - {@link ../runtime} — Deno subprocess executor with sandbox permissions
 * - {@link ../metrics} — Token savings estimation and session statistics
 * - {@link ../modes} — Execution/passthrough/hybrid mode switching
 * - {@link ../streaming} — SSE-based progress and log streaming
 * - {@link ../skills} — YAML-defined reusable code templates
 * - {@link ../watcher} — Hot-reload file watcher for config changes
 */

import { MCPExecutorServer } from './server/index.js';
import { loadConfig } from './config/index.js';
import { logger } from './utils/index.js';
import { BUILD_STRING } from './version.js';

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Load configuration
  const config = loadConfig();

  logger.info(`Starting MCP Conductor ${BUILD_STRING}`, {
    mode: config.execution.mode,
    bridgePort: config.bridge.port,
    timeout: config.execution.defaultTimeoutMs,
  });

  // Create and start server
  const server = new MCPExecutorServer(config);

  // Handle shutdown gracefully
  const shutdown = async () => {
    logger.info('Shutting down...');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.start();
  } catch (error) {
    logger.error('Failed to start server', { error: String(error) });
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
