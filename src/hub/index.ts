/**
 * MCP Hub — connection pool that spawns, manages, and routes calls to
 * backend MCP server processes (github, filesystem, brave-search, etc.).
 * @module hub
 */

export {
  MCPHub,
  type ServerConnection,
  type ServerStatus,
  type HubConfig,
  type HubEvents,
} from './mcp-hub.js';
