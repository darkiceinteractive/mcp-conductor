/**
 * Catalog disk cache for lazy initialization.
 *
 * Persists server catalog metadata (tool counts, summaries, tool details) to disk
 * so startup can build instructions without connecting backends. Cache is keyed by
 * a SHA-256 hash of the config servers JSON, so config changes invalidate the cache.
 *
 * @module cache/catalog-cache
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/index.js';

export interface CachedServerCatalog {
  name: string;
  toolCount: number;
  summary: string;
  topTools: string[];
  status: 'connected' | 'failed' | 'connecting';
  tools: Array<{
    name: string;
    description: string;
    schema?: Record<string, unknown>;
  }>;
}

export interface CatalogCacheFile {
  version: number;
  timestamp: number;
  configHash: string;
  servers: CachedServerCatalog[];
}

const CACHE_VERSION = 1;
const CACHE_DIR = join(process.env.HOME || process.env.USERPROFILE || '~', '.cache', 'mcp-conductor');

/**
 * Generate a stable hash for the config servers object.
 * Used to invalidate cache when config changes.
 */
export function getConfigHash(configServersJson: string): string {
  return createHash('sha256')
    .update(configServersJson)
    .digest('hex')
    .substring(0, 12);
}

/**
 * Get the cache file path for a given config hash.
 */
export function getCacheFilePath(configHash: string): string {
  return join(CACHE_DIR, `catalog-${configHash}.json`);
}

/**
 * Try to read and validate a cached catalog.
 * Returns null if cache doesn't exist, is invalid, or has expired.
 */
export async function readCatalogCache(configServersJson: string): Promise<CatalogCacheFile | null> {
  try {
    const configHash = getConfigHash(configServersJson);
    const cachePath = getCacheFilePath(configHash);

    // Try to read the file
    let data: string;
    try {
      data = await fs.readFile(cachePath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist — cache miss
        return null;
      }
      throw err;
    }

    const cache = JSON.parse(data) as CatalogCacheFile;

    // Validate cache structure
    if (cache.version !== CACHE_VERSION) {
      logger.debug('Catalog cache version mismatch, invalidating');
      return null;
    }

    if (cache.configHash !== configHash) {
      logger.debug('Catalog cache config hash mismatch, invalidating');
      return null;
    }

    // Check if cache is reasonably fresh (24 hours)
    const cacheAgeMs = Date.now() - cache.timestamp;
    const maxCacheAgeMs = 24 * 60 * 60 * 1000;
    if (cacheAgeMs > maxCacheAgeMs) {
      logger.debug('Catalog cache expired, invalidating');
      return null;
    }

    logger.debug('Catalog cache hit', { configHash, ageMs: cacheAgeMs });
    return cache;
  } catch (err: unknown) {
    logger.debug('Error reading catalog cache', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Write a catalog to the cache file.
 * Creates parent directories if needed.
 */
export async function writeCatalogCache(
  configServersJson: string,
  servers: CachedServerCatalog[]
): Promise<void> {
  try {
    const configHash = getConfigHash(configServersJson);
    const cachePath = getCacheFilePath(configHash);

    // Ensure cache directory exists
    await fs.mkdir(dirname(cachePath), { recursive: true });

    const cache: CatalogCacheFile = {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      configHash,
      servers,
    };

    await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
    logger.debug('Wrote catalog cache', { configHash, serverCount: servers.length });
  } catch (err: unknown) {
    logger.debug('Error writing catalog cache', { error: err instanceof Error ? err.message : String(err) });
    // Silently fail — cache writes are not critical
  }
}

/**
 * Clear all stale catalog caches (older than 24 hours).
 * Can be called periodically to clean up old cache files.
 */
export async function clearStaleCatalogCache(): Promise<void> {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const maxCacheAgeMs = 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const file of files) {
      if (!file.startsWith('catalog-') || !file.endsWith('.json')) {
        continue;
      }

      const cachePath = join(CACHE_DIR, file);
      try {
        const stat = await fs.stat(cachePath);
        if (now - stat.mtime.getTime() > maxCacheAgeMs) {
          await fs.unlink(cachePath);
          logger.debug('Cleared stale catalog cache', { file });
        }
      } catch (err: unknown) {
        logger.debug('Error checking/clearing cache file', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err: unknown) {
    logger.debug('Error clearing stale caches', { error: err instanceof Error ? err.message : String(err) });
  }
}
