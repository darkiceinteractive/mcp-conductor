/**
 * routing command: heuristic per-tool routing recommendation.
 * @module cli/commands/routing
 */

import { loadConductorConfig, saveConductorConfig, getDefaultConductorConfigPath } from '../../config/index.js';

export interface RoutingRecommendation {
  serverName: string;
  recommendation: 'passthrough' | 'execute_code';
  reason: string;
}

export interface RoutingResult {
  recommendations: RoutingRecommendation[];
  applied: boolean;
  configPath?: string;
}

/**
 * Heuristic: servers whose names or typical tool shapes suggest small payloads
 * should be marked passthrough. This is the X1 heuristic adapted for the CLI.
 *
 * Rule: if the server name matches known lightweight patterns (search, calendar,
 * weather, echo, ping) → passthrough. Otherwise → execute_code.
 *
 * A more sophisticated version would sample live tool responses — this is the
 * static heuristic that can be applied without connecting.
 */
export function recommendRouting(serverName: string): RoutingRecommendation {
  const lower = serverName.toLowerCase();
  const passthroughPatterns = [
    /search/, /calendar/, /weather/, /echo/, /ping/, /todo/, /remind/,
    /notes?$/, /contacts?$/, /email$/, /mail$/, /slack$/, /discord$/,
  ];

  const isPassthrough = passthroughPatterns.some((p) => p.test(lower));

  return {
    serverName,
    recommendation: isPassthrough ? 'passthrough' : 'execute_code',
    reason: isPassthrough
      ? 'Name matches lightweight-payload pattern (responses typically <1KB)'
      : 'Name does not match passthrough patterns; execute_code is safer default',
  };
}

/**
 * Generate routing recommendations for one or all configured servers.
 * Optionally write the recommendations back to the conductor config.
 */
export function getRoutingRecommendations(options: {
  serverName?: string;
  apply?: boolean;
}): RoutingResult {
  const config = loadConductorConfig();
  if (!config) {
    return { recommendations: [], applied: false };
  }

  const serverNames = options.serverName
    ? [options.serverName]
    : Object.keys(config.servers);

  const recommendations = serverNames
    .filter((n) => config.servers[n] !== undefined)
    .map(recommendRouting);

  if (options.apply && recommendations.length > 0) {
    // Store routing hint in server env as __routing (lightweight annotation).
    for (const rec of recommendations) {
      const server = config.servers[rec.serverName];
      if (server) {
        server.env = { ...(server.env ?? {}), __routing: rec.recommendation };
      }
    }
    const configPath = getDefaultConductorConfigPath();
    saveConductorConfig(config, configPath);
    return { recommendations, applied: true, configPath };
  }

  return { recommendations, applied: false };
}
