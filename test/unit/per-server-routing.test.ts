/**
 * Tests for applyPerServerRouting().
 *
 * Per-server routing config in ~/.mcp-conductor.json overrides any prior
 * per-tool routing annotation (built-in table or user-set). 'auto' or
 * absent leaves prior routing untouched.
 */

import { describe, it, expect, vi } from 'vitest';
import { applyPerServerRouting } from '../../src/registry/built-in-recommendations.js';

type Tool = { server: string; name: string; routing?: 'passthrough' | 'execute_code' };
type ServerCfg = { routing?: 'passthrough' | 'execute_code' | 'auto' };

describe('applyPerServerRouting', () => {
  it('forces every tool of a server to passthrough when routing="passthrough"', () => {
    const tools: Tool[] = [
      { server: 'github', name: 'get_me', routing: 'passthrough' }, // already passthrough
      { server: 'github', name: 'create_repo', routing: 'execute_code' }, // flip
      { server: 'github', name: 'delete_repo' }, // unset → flip
      { server: 'filesystem', name: 'read_file', routing: 'passthrough' }, // untouched
    ];
    const servers: Record<string, ServerCfg> = {
      github: { routing: 'passthrough' },
      filesystem: { routing: 'auto' },
    };

    const annotate = vi.fn();
    const count = applyPerServerRouting(tools, servers, annotate);

    // github/get_me already passthrough → skipped (no-op write avoided).
    // github/create_repo flipped, github/delete_repo set, filesystem/read_file
    // untouched ('auto' is no-op).
    expect(count).toBe(2);
    expect(annotate).toHaveBeenCalledWith('github', 'create_repo', { routing: 'passthrough' });
    expect(annotate).toHaveBeenCalledWith('github', 'delete_repo', { routing: 'passthrough' });
    expect(annotate).not.toHaveBeenCalledWith('filesystem', 'read_file', expect.anything());
  });

  it('forces every tool of a server to execute_code when routing="execute_code"', () => {
    const tools: Tool[] = [
      { server: 'risky', name: 'wipe_all' }, // unset → flip
      { server: 'risky', name: 'list_things', routing: 'passthrough' }, // flip
      { server: 'risky', name: 'log_event', routing: 'execute_code' }, // already → skip
    ];
    const servers: Record<string, ServerCfg> = {
      risky: { routing: 'execute_code' },
    };

    const annotate = vi.fn();
    const count = applyPerServerRouting(tools, servers, annotate);

    expect(count).toBe(2);
    expect(annotate).toHaveBeenCalledWith('risky', 'wipe_all', { routing: 'execute_code' });
    expect(annotate).toHaveBeenCalledWith('risky', 'list_things', { routing: 'execute_code' });
  });

  it('routing="auto" is a no-op (preserves prior annotations)', () => {
    const tools: Tool[] = [
      { server: 'github', name: 'get_me', routing: 'passthrough' },
      { server: 'github', name: 'create_repo', routing: 'execute_code' },
    ];
    const servers: Record<string, ServerCfg> = {
      github: { routing: 'auto' },
    };

    const annotate = vi.fn();
    const count = applyPerServerRouting(tools, servers, annotate);

    expect(count).toBe(0);
    expect(annotate).not.toHaveBeenCalled();
  });

  it('omitting routing on a server config is also a no-op', () => {
    const tools: Tool[] = [
      { server: 'filesystem', name: 'read_file', routing: 'passthrough' },
    ];
    const servers: Record<string, ServerCfg> = {
      filesystem: {}, // routing field absent
    };

    const annotate = vi.fn();
    const count = applyPerServerRouting(tools, servers, annotate);

    expect(count).toBe(0);
    expect(annotate).not.toHaveBeenCalled();
  });

  it('skips tools whose server is not in the conductor config', () => {
    const tools: Tool[] = [
      { server: 'unknown-server', name: 'do_thing' },
    ];
    const servers: Record<string, ServerCfg> = {
      github: { routing: 'passthrough' },
    };

    const annotate = vi.fn();
    const count = applyPerServerRouting(tools, servers, annotate);

    expect(count).toBe(0);
    expect(annotate).not.toHaveBeenCalled();
  });

  it('per-server override beats whatever was set previously', () => {
    // Simulate a tool that BUILT_IN_ROUTING already marked passthrough.
    // User then forces the whole server to execute_code via config.
    const tools: Tool[] = [
      { server: 'github', name: 'get_me', routing: 'passthrough' },
    ];
    const servers: Record<string, ServerCfg> = {
      github: { routing: 'execute_code' },
    };

    const annotate = vi.fn();
    const count = applyPerServerRouting(tools, servers, annotate);

    expect(count).toBe(1);
    expect(annotate).toHaveBeenCalledWith('github', 'get_me', { routing: 'execute_code' });
  });
});
