/**
 * ToolRegistry — authoritative catalog of backend MCP tools.
 *
 * Responsibilities:
 * - Populate the catalog from all connected backends (`refresh()`)
 * - Validate tool call arguments before they hit the backend (`validateInput()`)
 * - Generate TypeScript declarations for sandbox preload (`generateTypes()`,
 *   `writeTypesToDir()`)
 * - Persist and restore the catalog across restarts (`saveSnapshot()`,
 *   `loadSnapshot()`)
 * - Emit change events on hot-reload (`watch()`)
 * - Allow out-of-band annotation of conductor-extension metadata (`annotate()`)
 *
 * @module registry/registry
 */

import { logger } from '../utils/index.js';
import { RegistryEmitter } from './events.js';
import { validateToolInput } from './validator.js';
import {
  saveSnapshot as persistSnapshot,
  loadSnapshot as restoreSnapshot,
} from './snapshot.js';
import {
  generateServerTypes,
  generateIndexTypes,
  writeTypesToDir as writeTypeFiles,
} from './typegen.js';
import type {
  ToolDefinition,
  ValidationResult,
  BackendBridge,
  RegistryOptions,
  JsonSchema,
} from './index.js';
import type { RegistryEvent } from './events.js';

export class ToolRegistry {
  private catalog: Map<string, ToolDefinition> = new Map();
  private emitter = new RegistryEmitter();
  private options: Required<RegistryOptions>;

  /** Stable catalog key: `<server>/<name>` */
  private static key(server: string, name: string): string {
    return `${server}/${name}`;
  }

  constructor(options: RegistryOptions) {
    this.options = {
      snapshotPath: '',
      typesDir: '',
      validateInputs: true,
      regenerateOnConnect: true,
      ...options,
    };

    // Wire hot-reload listeners: when a backend reconnects, re-fetch its
    // tools, diff against the current catalog, emit change events, and
    // optionally regenerate .d.ts files.
    const onConnect = async (serverName: string): Promise<void> => {
      logger.debug(`ToolRegistry: server reconnected — refreshing ${serverName}`);
      await this.refreshServer(serverName);

      if (this.options.regenerateOnConnect && this.options.typesDir) {
        try {
          await this.writeTypesToDir(this.options.typesDir);
        } catch (err) {
          logger.warn(`ToolRegistry: type regeneration failed for ${serverName}`, {
            error: String(err),
          });
        }
      }
    };

    const onDisconnect = (serverName: string): void => {
      this.emitter.emit('change', {
        type: 'server-disconnected',
        server: serverName,
        at: Date.now(),
      });
    };

    this.options.bridge.on('serverConnected', onConnect as (name: string) => void);
    this.options.bridge.on('serverDisconnected', onDisconnect);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Refresh
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Populate the catalog from all currently-connected backends.
   * Errors from individual backends are logged and skipped — the registry
   * always ends in a consistent state.
   * Returns the full catalog after refresh.
   */
  async refresh(): Promise<ToolDefinition[]> {
    const servers = this.options.bridge.listServers();

    await Promise.all(
      servers
        .filter((s) => s.status === 'connected')
        .map((s) => this.refreshServer(s.name))
    );

    return this.getAllTools();
  }

  /**
   * Refresh a single server's tools, diffing against the current catalog
   * and emitting per-tool change events.
   */
  private async refreshServer(serverName: string): Promise<void> {
    let rawTools: Array<{
      name: string;
      description?: string;
      inputSchema?: JsonSchema;
      outputSchema?: JsonSchema;
    }>;

    try {
      rawTools = this.options.bridge.getServerTools(serverName);
    } catch (err) {
      logger.warn(`ToolRegistry: failed to fetch tools for ${serverName}`, {
        error: String(err),
      });
      return;
    }

    const incoming = new Map<string, ToolDefinition>();

    for (const raw of rawTools) {
      const def: ToolDefinition = {
        server: serverName,
        name: raw.name,
        description: raw.description ?? '',
        inputSchema: raw.inputSchema ?? {},
        ...(raw.outputSchema ? { outputSchema: raw.outputSchema } : {}),
      };

      // Preserve existing conductor-extension metadata (annotations survive refresh)
      const existing = this.catalog.get(ToolRegistry.key(serverName, raw.name));
      if (existing) {
        def.cost = existing.cost;
        def.cacheable = existing.cacheable;
        def.cacheTtl = existing.cacheTtl;
        def.reliability = existing.reliability;
        def.routing = existing.routing;
        def.redact = existing.redact;
        def.examples = existing.examples;
      }

      incoming.set(ToolRegistry.key(serverName, raw.name), def);
    }

    // Keys currently in the catalog for this server
    const currentKeys = new Set(
      [...this.catalog.keys()].filter((k) => k.startsWith(`${serverName}/`))
    );

    // Detect removed tools
    for (const key of currentKeys) {
      if (!incoming.has(key)) {
        const before = this.catalog.get(key)!;
        this.catalog.delete(key);
        this.emit({ type: 'tool-removed', server: serverName, tool: before.name, before });
      }
    }

    // Detect added / updated tools
    for (const [key, def] of incoming) {
      const existing = this.catalog.get(key);
      if (!existing) {
        this.catalog.set(key, def);
        this.emit({ type: 'tool-added', server: serverName, tool: def.name, after: def });
      } else if (
        existing.description !== def.description ||
        JSON.stringify(existing.inputSchema) !== JSON.stringify(def.inputSchema)
      ) {
        this.catalog.set(key, def);
        this.emit({
          type: 'tool-updated',
          server: serverName,
          tool: def.name,
          before: existing,
          after: def,
        });
      } else {
        // No schema change — update in-place so any raw value changes land
        this.catalog.set(key, def);
      }
    }

    this.emit({ type: 'server-connected', server: serverName });
    logger.debug(`ToolRegistry: refreshed ${serverName}`, { toolCount: incoming.size });
  }

  private emit(event: Omit<RegistryEvent, 'at'>): void {
    this.emitter.emit('change', { ...event, at: Date.now() });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lookup
  // ─────────────────────────────────────────────────────────────────────────

  /** Look up a single tool. Returns null if not found. */
  getTool(server: string, name: string): ToolDefinition | null {
    return this.catalog.get(ToolRegistry.key(server, name)) ?? null;
  }

  /** All tools across all servers as a flat array. */
  getAllTools(): ToolDefinition[] {
    return [...this.catalog.values()];
  }

  /** Tools for a specific server. */
  getServerTools(server: string): ToolDefinition[] {
    return [...this.catalog.values()].filter((t) => t.server === server);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Validation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Validate input args against the tool's inputSchema.
   * Returns `{ valid: true }` for unknown tools (fail-open).
   * When `validateInputs: false`, always returns `{ valid: true }`.
   */
  validateInput(server: string, name: string, args: unknown): ValidationResult {
    if (!this.options.validateInputs) {
      return { valid: true };
    }
    return validateToolInput(this.getTool(server, name), args);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Type generation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Generate combined TypeScript declarations for all servers as a single string.
   * Use `writeTypesToDir()` for writing to disk.
   */
  async generateTypes(): Promise<string> {
    const sections: string[] = [];
    const names = this.uniqueServerNames();

    for (const serverName of names) {
      sections.push(await generateServerTypes(serverName, this.getServerTools(serverName)));
    }

    sections.push(generateIndexTypes(names));
    return sections.join('\n');
  }

  /**
   * Write generated .d.ts and .routing.json files to `dir`.
   * Creates `dir` if it does not exist.
   * Returns the list of written file paths.
   */
  async writeTypesToDir(dir: string): Promise<string[]> {
    const toolsByServer = new Map<string, ToolDefinition[]>();
    for (const name of this.uniqueServerNames()) {
      toolsByServer.set(name, this.getServerTools(name));
    }
    return writeTypeFiles(dir, toolsByServer);
  }

  private uniqueServerNames(): string[] {
    return [...new Set([...this.catalog.values()].map((t) => t.server))];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Watch
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to registry change events.
   * Returns an object with `unsubscribe()` for cleanup.
   */
  watch(callback: (event: RegistryEvent) => void): { unsubscribe: () => void } {
    this.emitter.on('change', callback);
    return { unsubscribe: () => this.emitter.off('change', callback) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Snapshot persistence
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Persist the current catalog to disk.
   * Uses `options.snapshotPath` when `path` is omitted.
   */
  async saveSnapshot(path?: string): Promise<void> {
    const target = path ?? this.options.snapshotPath;
    if (!target) throw new Error('ToolRegistry.saveSnapshot: no snapshotPath configured');
    await persistSnapshot(target, this.getAllTools());
    logger.debug(`ToolRegistry: snapshot saved to ${target}`);
  }

  /**
   * Load a previously saved snapshot from disk.
   * Falls back silently when the file is missing, malformed, or version-mismatched.
   */
  async loadSnapshot(path?: string): Promise<void> {
    const target = path ?? this.options.snapshotPath;
    if (!target) return;

    const catalog = await restoreSnapshot(target);
    if (catalog === null) {
      logger.debug(`ToolRegistry: no valid snapshot at ${target} — will refresh from backends`);
      return;
    }

    for (const def of catalog) {
      const key = ToolRegistry.key(def.server, def.name);
      if (!this.catalog.has(key)) {
        this.catalog.set(key, def);
      }
    }

    logger.debug(`ToolRegistry: loaded ${catalog.length} tools from snapshot at ${target}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Annotations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Update conductor-extension metadata for a tool.
   * Annotations persist across `refresh()` calls.
   * Calling `annotate()` for an unknown tool is a no-op (metadata will be
   * applied the next time the tool appears via refresh).
   */
  annotate(server: string, name: string, metadata: Partial<ToolDefinition>): void {
    const key = ToolRegistry.key(server, name);
    const existing = this.catalog.get(key);
    if (!existing) {
      logger.debug(`ToolRegistry.annotate: tool not yet in catalog — ${key}`);
      return;
    }

    const allowed: Array<keyof ToolDefinition> = [
      'cost',
      'cacheable',
      'cacheTtl',
      'reliability',
      'routing',
      'redact',
      'examples',
    ];

    for (const field of allowed) {
      if (field in metadata) {
        (existing as unknown as Record<string, unknown>)[field] = metadata[field];
      }
    }
  }
}
