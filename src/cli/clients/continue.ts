/**
 * MCPClientAdapter for Continue.dev.
 *
 * Continue.dev stores its global configuration at `~/.continue/config.yaml`
 * (YAML) and optionally accepts project-local drop-in files under
 * `.continue/mcpServers/*.yaml` (also YAML, one file per server) or, in
 * older releases, `.continue/config.json` (JSON).
 *
 * This adapter handles:
 * - YAML parse/serialize for the primary global config
 * - JSON fallback for any path whose extension is `.json`
 * - Round-trip preservation of all non-`mcpServers` top-level keys
 *   (models, slashCommands, tabAutocompleteModel, contextProviders, etc.)
 * - Timestamped `.bak.YYYYMMDDHHMMSS` backup before every write
 *
 * YAML edge cases:
 * - **Comment preservation**: the `yaml` package (v2) does not preserve
 *   comments on stringify by default.  Comments are silently dropped during a
 *   round-trip.  This is a known limitation of virtually all YAML serialisers
 *   and is documented here so users are not surprised.
 * - **Anchors / aliases**: the `yaml` package fully supports YAML anchors on
 *   parse.  On stringify it emits plain scalar values (anchors are not
 *   re-emitted), which is the safest behaviour for a config-mutation tool.
 * - **Multi-document streams**: Continue uses single-document YAML files.
 *   Only the first document is parsed; additional documents (if any) are
 *   ignored.
 *
 * @module cli/clients/continue
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { writeBackup } from '../../utils/backup.js';
import type {
  MCPClientAdapter,
  NormalisedClientConfig,
  NormalisedServerEntry,
  SerializeOptions,
} from './adapter.js';
import type { MCPClientId } from './registry.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Raw shape of a single MCP server entry as Continue stores it.
 * Structurally identical to the Anthropic/Claude Desktop schema.
 */
interface ContinueServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Loose type for a parsed Continue config document (YAML or JSON).
 * Only `mcpServers` is touched; all other keys are preserved opaquely via
 * `NormalisedClientConfig.raw`.
 */
interface ContinueConfigDoc {
  mcpServers?: Record<string, ContinueServerEntry>;
  [key: string]: unknown;
}

/**
 * Parse a file as YAML or JSON depending on its extension.
 *
 * - `.json`  → `JSON.parse`
 * - anything else → `yaml.parse` (handles `.yaml` and `.yml`)
 *
 * Returns `null` on parse error or when the file does not exist.
 */
function parseFile(path: string): ContinueConfigDoc | null {
  if (!existsSync(path)) {
    return null;
  }

  const raw = readFileSync(path, 'utf8');

  try {
    if (path.endsWith('.json')) {
      return JSON.parse(raw) as ContinueConfigDoc;
    }
    // yaml.parse returns the first document and handles all YAML 1.2 features.
    const doc = parseYaml(raw) as ContinueConfigDoc | null;
    return doc ?? null;
  } catch {
    return null;
  }
}

/**
 * Serialise `doc` back to the format implied by `path`'s extension.
 */
function serialiseDoc(path: string, doc: ContinueConfigDoc): string {
  if (path.endsWith('.json')) {
    return JSON.stringify(doc, null, 2) + '\n';
  }
  // lineWidth: 0 disables line-wrapping so long command/args strings are not
  // broken mid-token.
  return stringifyYaml(doc, { lineWidth: 0 });
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

class ContinueAdapter implements MCPClientAdapter {
  readonly client: MCPClientId = 'continue';

  // -------------------------------------------------------------------------
  // parse()
  // -------------------------------------------------------------------------

  parse(path: string): NormalisedClientConfig | null {
    const doc = parseFile(path);
    if (doc === null) {
      return null;
    }

    const rawServers = doc.mcpServers;
    if (!rawServers || typeof rawServers !== 'object' || Object.keys(rawServers).length === 0) {
      // File exists but has no MCP server definitions — callers may skip it.
      return null;
    }

    // Normalise each server entry into the common shape.
    const servers: Record<string, NormalisedServerEntry> = {};
    for (const [name, entry] of Object.entries(rawServers)) {
      if (!entry || typeof entry.command !== 'string') {
        continue; // skip malformed entries
      }
      const normalised: NormalisedServerEntry = { command: entry.command };
      if (Array.isArray(entry.args)) {
        normalised.args = entry.args;
      }
      if (entry.env && typeof entry.env === 'object') {
        normalised.env = entry.env;
      }
      servers[name] = normalised;
    }

    return { servers, raw: doc };
  }

  // -------------------------------------------------------------------------
  // serialize()
  // -------------------------------------------------------------------------

  serialize(
    path: string,
    config: NormalisedClientConfig,
    options: SerializeOptions,
  ): void {
    // 1. Back up the current file before mutating it (skip if file is new).
    if (existsSync(path)) {
      writeBackup(path);
    }

    // 2. Build the updated mcpServers map.
    let updatedServers: Record<string, NormalisedServerEntry>;

    if (options.keepOnlyConductor) {
      // Migration mode: keep only the conductor entry.
      updatedServers = { 'mcp-conductor': options.conductorEntry };
    } else {
      // Merge mode: start from the existing normalised servers, then ensure
      // the conductor entry is present / updated.
      updatedServers = {
        ...config.servers,
        'mcp-conductor': options.conductorEntry,
      };
    }

    // 3. Reconstruct the full document, preserving all non-mcpServers keys
    //    from `config.raw` (models, slashCommands, contextProviders, etc.).
    const baseDoc = (config.raw as ContinueConfigDoc) ?? {};
    const updatedDoc: ContinueConfigDoc = {
      ...baseDoc,
      mcpServers: updatedServers,
    };

    // 4. Write the serialised output to disk.
    writeFileSync(path, serialiseDoc(path, updatedDoc), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Exported singleton
// ---------------------------------------------------------------------------

/**
 * Continue.dev MCPClientAdapter instance.
 *
 * Registered in `src/cli/clients/index.ts`:
 * ```ts
 * import { CONTINUE_ADAPTER } from './continue.js';
 * ADAPTERS.set('continue', CONTINUE_ADAPTER);
 * ```
 */
export const CONTINUE_ADAPTER: MCPClientAdapter = new ContinueAdapter();
