/**
 * Dictionary compression module for MCP Conductor.
 *
 * Provides token-space dictionary compression of outbound tool results.
 * Default: OFF. Enable via config `dictCompression: true` or env DICT_COMPRESS=1.
 *
 * See src/compression/dict-map.ts for the encoder/decoder API.
 * See src/compression/miner.ts for the map miner.
 *
 * ## Finding (research-dictionary-compression.md, 2026-06-11)
 * Empirical testing on 7 real sessions found that no code style reaches 1 BPE
 * token (minimum is 2). The dominant corpus "savings" are a stop-hook injection
 * artefact (~70%), with genuine phrase/path savings ~$1–4/month. This feature
 * is preserved as a skeleton for future experimentation.
 *
 * @module compression
 */

export {
  generateCode,
  splitByCodeFences,
  encode,
  decode,
  formatMapLegend,
  serializeDictMap,
  parseDictMap,
} from './dict-map.js';

export type {
  DictEntry,
  DictMap,
  EncodeResult,
  DecodeResult,
} from './dict-map.js';

export {
  approxTokens,
  approxEntryOverhead,
  computeNetSavings,
  mineDict,
  minePaths,
  mineSessionPhrases,
  findSessionFiles,
  runMinerCLI,
  CODE_TOKEN_COST,
} from './miner.js';

export type {
  MinerOptions,
  MineDictCLIArgs,
} from './miner.js';

// ---------------------------------------------------------------------------
// DictCompressionConfig — config type (used by MCPExecutorConfig)
// ---------------------------------------------------------------------------

/**
 * Configuration for dictionary compression in MCP Conductor.
 *
 * Set in `~/.mcp-conductor.json` under `dictCompression`, or via
 * the environment variable `DICT_COMPRESS=1`.
 *
 * Default: disabled.
 */
export interface DictCompressionConfig {
  /**
   * Enable dictionary compression of outbound tool results.
   * Default: false.
   */
  enabled: boolean;
  /**
   * Path to the `.dict-map.json` file.
   * If omitted, conductor looks for `.dict-map.json` in the working directory.
   */
  mapPath?: string;
  /**
   * Maximum number of entries to use from the map.
   * Higher values mean more aggressive compression but a larger system-prompt legend.
   * Default: 50 (empirically validated sweet spot).
   */
  topK?: number;
}

/**
 * Default configuration for dict compression.
 * Disabled by default — must be explicitly enabled.
 */
export const DEFAULT_DICT_COMPRESSION_CONFIG: DictCompressionConfig = {
  enabled: false,
  topK: 50,
};
