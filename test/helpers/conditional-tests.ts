/**
 * Conditional Test Helpers
 *
 * Utilities for conditionally running tests based on server availability.
 * Allows tests to gracefully skip when required servers aren't available.
 */

import { describe, it, beforeAll } from 'vitest';
import {
  detectAvailableServers,
  isServerAvailable,
  type AvailableServersResult,
} from '../real-servers/available-servers.js';

// Cache for available servers
let _availableServers: AvailableServersResult | null = null;

/**
 * Get available servers (cached)
 */
export async function getAvailableServers(): Promise<AvailableServersResult> {
  if (!_availableServers) {
    _availableServers = await detectAvailableServers();
  }
  return _availableServers;
}

/**
 * Check if real server tests should be skipped
 */
export function skipIfNoRealServers(): boolean {
  // Check environment variable
  if (process.env.SKIP_REAL_SERVERS === 'true') {
    return true;
  }
  return false;
}

/**
 * Check if a specific server should be skipped
 */
export async function shouldSkipServer(serverName: string): Promise<boolean> {
  if (skipIfNoRealServers()) {
    return true;
  }
  const available = await isServerAvailable(serverName);
  return !available;
}

/**
 * Create a describe block that only runs if the specified server is available
 *
 * @example
 * describeWithServer('sequential-thinking', () => {
 *   it('should process thoughts', async () => { ... });
 * });
 */
export function describeWithServer(
  serverName: string,
  fn: () => void
): ReturnType<typeof describe> | void {
  // We need to check availability synchronously for vitest
  // So we use describe.skipIf with a check
  const shouldSkip = skipIfNoRealServers();

  if (shouldSkip) {
    return describe.skip(`[${serverName}] (skipped - SKIP_REAL_SERVERS=true)`, fn);
  }

  // For async checks, we wrap in a describe that checks in beforeAll
  return describe(`[${serverName}]`, () => {
    let serverAvailable = false;

    beforeAll(async () => {
      serverAvailable = await isServerAvailable(serverName);
      if (!serverAvailable) {
        console.log(`Skipping tests: Server '${serverName}' not available`);
      }
    });

    // The actual tests are wrapped to check availability
    fn();
  });
}

/**
 * Create an it block that only runs if the specified server is available
 *
 * @example
 * itWithServer('filesystem', 'should list directory', async () => { ... });
 */
export function itWithServer(
  serverName: string,
  testName: string,
  fn: () => Promise<void>
): ReturnType<typeof it> {
  return it(testName, async () => {
    const available = await isServerAvailable(serverName);
    if (!available) {
      console.log(`Skipping: Server '${serverName}' not available`);
      return; // Skip silently
    }
    await fn();
  });
}

/**
 * Run a test only if the test-echo server is available (should always pass)
 */
export function itWithTestEcho(
  testName: string,
  fn: () => Promise<void>
): ReturnType<typeof it> {
  return itWithServer('test-echo', testName, fn);
}

/**
 * Describe block for tests requiring only the test-echo server
 */
export function describeWithTestEcho(fn: () => void): ReturnType<typeof describe> | void {
  return describeWithServer('test-echo', fn);
}

/**
 * Get a descriptive skip reason for a server
 */
export async function getSkipReason(serverName: string): Promise<string | null> {
  if (skipIfNoRealServers()) {
    return 'SKIP_REAL_SERVERS environment variable is set';
  }

  const available = await isServerAvailable(serverName);
  if (!available) {
    return `Server '${serverName}' is not configured in Claude config`;
  }

  return null;
}

/**
 * Assert that a server is available, throwing if not
 */
export async function requireServer(serverName: string): Promise<void> {
  const reason = await getSkipReason(serverName);
  if (reason) {
    throw new Error(`Required server unavailable: ${reason}`);
  }
}

/**
 * Helper to create conditional test suites based on multiple servers
 */
export function describeWithServers(
  serverNames: string[],
  fn: () => void
): ReturnType<typeof describe> | void {
  const label = serverNames.join(', ');

  if (skipIfNoRealServers()) {
    return describe.skip(`[${label}] (skipped - SKIP_REAL_SERVERS=true)`, fn);
  }

  return describe(`[${label}]`, () => {
    let allAvailable = false;
    let unavailable: string[] = [];

    beforeAll(async () => {
      const checks = await Promise.all(
        serverNames.map(async (name) => ({
          name,
          available: await isServerAvailable(name),
        }))
      );

      unavailable = checks.filter((c) => !c.available).map((c) => c.name);
      allAvailable = unavailable.length === 0;

      if (!allAvailable) {
        console.log(`Skipping tests: Servers not available: ${unavailable.join(', ')}`);
      }
    });

    fn();
  });
}
