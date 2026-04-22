import { describe, it, expect, afterEach } from 'vitest';
import { minimalChildEnv } from '../../src/utils/env.js';

/**
 * Both the Deno executor and the MCP hub use `minimalChildEnv()` when spawning
 * child processes. We verify the unit-level guarantees here; real subprocess
 * isolation is covered by the executor's integration test
 * `should not leak environment variables to Deno subprocess`.
 */
describe('minimalChildEnv (child process env isolation)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore any env vars we set in a test
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('always includes PATH and HOME', () => {
    const env = minimalChildEnv();
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
  });

  it('does not leak unrelated process.env variables', () => {
    process.env.LEAKY_SECRET_TOKEN = 'ghp_shouldneverappear';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret-do-not-leak';
    process.env.USER = 'test-user-should-not-leak';

    const env = minimalChildEnv();

    expect(env.LEAKY_SECRET_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.USER).toBeUndefined();
    expect(env.SHELL).toBeUndefined();
  });

  it('merges additional env vars from the `extra` argument', () => {
    const env = minimalChildEnv({
      DENO_DIR: '/tmp/deno-cache',
      NO_COLOR: '1',
      GITHUB_TOKEN: 'ghp_explicitly_opted_in',
    });

    expect(env.DENO_DIR).toBe('/tmp/deno-cache');
    expect(env.NO_COLOR).toBe('1');
    expect(env.GITHUB_TOKEN).toBe('ghp_explicitly_opted_in');
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
  });

  it('drops undefined values so callers can pass process.env.FOO unconditionally', () => {
    delete process.env.SOME_UNDEFINED_VAR;

    const env = minimalChildEnv({
      DENO_DIR: process.env.SOME_UNDEFINED_VAR,
      KEPT: 'visible',
    });

    expect(env.DENO_DIR).toBeUndefined();
    expect(env.KEPT).toBe('visible');
  });

  it('drops empty strings from the extra map', () => {
    const env = minimalChildEnv({ EMPTY: '', KEPT: 'visible' });
    expect(env.EMPTY).toBeUndefined();
    expect(env.KEPT).toBe('visible');
  });

  it('falls back to empty string when PATH or HOME are missing from the parent', () => {
    delete process.env.PATH;
    delete process.env.HOME;

    const env = minimalChildEnv();
    expect(env.PATH).toBe('');
    expect(env.HOME).toBe('');
  });
});
