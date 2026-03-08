/**
 * HTTP bridge — localhost-only HTTP server that the Deno sandbox uses to
 * make MCP tool calls back to the hub. Provides endpoints for tool
 * invocation, progress updates, and streaming.
 * @module bridge
 */

export * from './http-server.js';
