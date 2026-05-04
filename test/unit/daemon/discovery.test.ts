/**
 * Unit tests for TailscaleDiscovery.
 *
 * We stub out the CLI runner via vi.spyOn so these tests don't require
 * Tailscale to be installed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TailscaleDiscovery } from '../../../src/daemon/discovery.js';

const MOCK_STATUS_JSON = JSON.stringify({
  Self: {
    HostName: 'my-machine',
    TailscaleIPs: ['100.64.0.1'],
    Online: true,
  },
  Peer: {
    'node-abc': {
      HostName: 'darkice-daemon',
      TailscaleIPs: ['100.64.0.2'],
      Online: true,
    },
    'node-def': {
      HostName: 'offline-peer',
      TailscaleIPs: ['100.64.0.3'],
      Online: false,
    },
  },
});

describe('TailscaleDiscovery', () => {
  let discovery: TailscaleDiscovery;

  beforeEach(() => {
    // cacheTtlMs=0 disables caching so each call re-invokes _runCli.
    discovery = new TailscaleDiscovery({ cacheTtlMs: 0 });
  });

  describe('status()', () => {
    it('returns available=true when CLI succeeds', async () => {
      vi.spyOn(discovery, '_runCli').mockResolvedValue(MOCK_STATUS_JSON);

      const st = await discovery.status();
      expect(st.available).toBe(true);
      expect(st.selfHostname).toBe('my-machine');
      expect(st.selfIp).toBe('100.64.0.1');
      expect(st.peers).toHaveLength(2);
    });

    it('returns available=false when CLI throws', async () => {
      vi.spyOn(discovery, '_runCli').mockRejectedValue(new Error('command not found'));

      const st = await discovery.status();
      expect(st.available).toBe(false);
      expect(st.peers).toHaveLength(0);
    });
  });

  describe('resolve()', () => {
    beforeEach(() => {
      vi.spyOn(discovery, '_runCli').mockResolvedValue(MOCK_STATUS_JSON);
    });

    it('finds daemon by hostname', async () => {
      const ip = await discovery.resolve('darkice-daemon');
      expect(ip).toBe('100.64.0.2');
    });

    it('resolves self hostname', async () => {
      const ip = await discovery.resolve('my-machine');
      expect(ip).toBe('100.64.0.1');
    });

    it('returns null for unknown hostname', async () => {
      const ip = await discovery.resolve('not-here');
      expect(ip).toBeNull();
    });

    it('is case-insensitive', async () => {
      const ip = await discovery.resolve('DARKICE-DAEMON');
      expect(ip).toBe('100.64.0.2');
    });
  });

  describe('isAvailable()', () => {
    it('returns true when Tailscale is running', async () => {
      vi.spyOn(discovery, '_runCli').mockResolvedValue(MOCK_STATUS_JSON);
      expect(await discovery.isAvailable()).toBe(true);
    });

    it('returns false when Tailscale is not installed', async () => {
      vi.spyOn(discovery, '_runCli').mockRejectedValue(new Error('tailscale: not found'));
      expect(await discovery.isAvailable()).toBe(false);
    });
  });
});
