/**
 * Tailscale Peer Discovery for MCP Conductor Daemon.
 *
 * Provides helpers to resolve a daemon's address on the Tailscale mesh by
 * hostname. The implementation queries the local Tailscale CLI (`tailscale
 * status --json`) which must already be authenticated. No additional Tailscale
 * API token is required — this works entirely through the local socket that
 * the Tailscale daemon exposes.
 *
 * Cross-daemon mesh locking is deferred to v3.1; this module's v3.0 role is:
 *  1. Resolve a Tailscale hostname → IP so DaemonClient can connect via TCP.
 *  2. Detect whether Tailscale is available at all (graceful fallback to Unix
 *     socket when Tailscale is absent).
 *
 * @module daemon/discovery
 */

import { execFile } from 'node:child_process';
import { logger } from '../utils/logger.js';

export interface TailscalePeer {
  hostname: string;
  tailscaleIp: string;
  online: boolean;
}

export interface TailscaleStatus {
  available: boolean;
  selfHostname?: string;
  selfIp?: string;
  peers: TailscalePeer[];
}

interface RawTailscaleStatus {
  Self?: {
    HostName?: string;
    TailscaleIPs?: string[];
    Online?: boolean;
  };
  Peer?: Record<string, {
    HostName?: string;
    TailscaleIPs?: string[];
    Online?: boolean;
  }>;
}

/**
 * Runs the Tailscale CLI and returns its JSON output.
 * Extracted so tests can override via `vi.spyOn(discovery, '_runCli')`.
 */
async function runTailscaleCli(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['status', '--json'], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Resolves daemon addresses on the Tailscale mesh by querying the local
 * Tailscale CLI.
 */
export class TailscaleDiscovery {
  private readonly tailscaleBin: string;
  private readonly cacheTtlMs: number;
  private cache: { expiresAt: number; status: TailscaleStatus } | null = null;

  /**
   * Internal CLI runner — override in tests via `vi.spyOn(instance, '_runCli')`.
   */
  _runCli: (bin: string) => Promise<string>;

  constructor(options: { tailscaleBin?: string; cacheTtlMs?: number } = {}) {
    this.tailscaleBin = options.tailscaleBin ?? 'tailscale';
    this.cacheTtlMs = options.cacheTtlMs ?? 10_000;
    this._runCli = runTailscaleCli;
  }

  async status(): Promise<TailscaleStatus> {
    if (this.cache && Date.now() < this.cache.expiresAt) {
      return this.cache.status;
    }

    const result = await this.queryTailscaleCli();
    this.cache = { expiresAt: Date.now() + this.cacheTtlMs, status: result };
    return result;
  }

  async resolve(hostname: string): Promise<string | null> {
    const st = await this.status();
    if (!st.available) return null;

    if (st.selfHostname?.toLowerCase() === hostname.toLowerCase()) {
      return st.selfIp ?? null;
    }

    const peer = st.peers.find(
      (p) => p.hostname.toLowerCase() === hostname.toLowerCase(),
    );
    return peer?.tailscaleIp ?? null;
  }

  async isAvailable(): Promise<boolean> {
    const st = await this.status();
    return st.available;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  private async queryTailscaleCli(): Promise<TailscaleStatus> {
    try {
      const stdout = await this._runCli(this.tailscaleBin);
      const raw = JSON.parse(stdout) as RawTailscaleStatus;
      const self = raw.Self;
      const peers: TailscalePeer[] = [];

      for (const peer of Object.values(raw.Peer ?? {})) {
        const ip = peer.TailscaleIPs?.[0];
        if (!ip || !peer.HostName) continue;
        peers.push({
          hostname: peer.HostName,
          tailscaleIp: ip,
          online: peer.Online ?? false,
        });
      }

      return {
        available: true,
        selfHostname: self?.HostName,
        selfIp: self?.TailscaleIPs?.[0],
        peers,
      };
    } catch (err) {
      logger.debug('TailscaleDiscovery: Tailscale CLI unavailable', { error: String(err) });
      return { available: false, peers: [] };
    }
  }
}
