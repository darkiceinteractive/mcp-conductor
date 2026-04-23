import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../src/utils/redact.js';

/**
 * Phase 1.6 — secret redaction for log output. These patterns are the
 * baseline set; add coverage here when adding a new pattern to redact.ts.
 */

describe('redactSecrets', () => {
  it('redacts GitHub personal access tokens (ghp_)', () => {
    const input = 'error: token ghp_1234567890ABCDEFabcdefghij1234567890 expired';
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(out).not.toContain('ghp_1234567890');
  });

  it('redacts GitHub OAuth / server-side / refresh / user tokens', () => {
    const variants = ['gho_', 'ghs_', 'ghr_', 'ghu_'];
    for (const prefix of variants) {
      const token = `${prefix}${'A'.repeat(36)}`;
      const out = redactSecrets(`header: ${token}`);
      expect(out).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(out).not.toContain(token);
    }
  });

  it('redacts Anthropic API keys (sk-ant-)', () => {
    const key = 'sk-ant-api03-' + 'x'.repeat(40);
    const out = redactSecrets(`Authorization: Bearer ${key}`);
    expect(out).toContain('[REDACTED_ANTHROPIC_KEY]');
    expect(out).not.toContain('sk-ant-api03');
  });

  it('redacts OpenAI keys (sk-proj-, sk-svcacct-, sk-)', () => {
    const keys = [
      'sk-proj-' + 'a'.repeat(40),
      'sk-svcacct-' + 'b'.repeat(40),
      'sk-' + 'c'.repeat(40),
    ];
    for (const key of keys) {
      const out = redactSecrets(`token=${key}`);
      expect(out).toContain('[REDACTED_');
      expect(out).not.toContain(key);
    }
  });

  it('redacts Brave Search keys (BSA)', () => {
    const key = 'BSA' + 'x'.repeat(30);
    const out = redactSecrets(`X-Subscription-Token: ${key}`);
    expect(out).toContain('[REDACTED_BRAVE_KEY]');
    expect(out).not.toContain(key);
  });

  it('redacts AWS access key IDs (AKIA...)', () => {
    const out = redactSecrets('aws key: AKIAIOSFODNN7EXAMPLE ok');
    expect(out).toContain('[REDACTED_AWS_ACCESS_KEY]');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts Google API keys (AIza...)', () => {
    const key = 'AIza' + 'A'.repeat(35);
    const out = redactSecrets(`key=${key}`);
    expect(out).toContain('[REDACTED_GOOGLE_API_KEY]');
    expect(out).not.toContain(key);
  });

  it('redacts Slack tokens (xoxb-, xoxp-)', () => {
    // Construct at runtime so GitHub push-protection's static scanner
    // doesn't flag the string literal as a leaked Slack secret.
    const fake = ['xo', 'xb', '-', '0'.repeat(12), '-', 'A'.repeat(24)].join('');
    const out = redactSecrets(fake);
    expect(out).toContain('[REDACTED_SLACK_TOKEN]');
  });

  it('is idempotent: redacted output passed through again is unchanged', () => {
    const input = 'token ghp_' + 'A'.repeat(36);
    const once = redactSecrets(input);
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });

  it('redacts multiple secrets in the same line', () => {
    const input = `gh=ghp_${'A'.repeat(36)} anth=sk-ant-${'B'.repeat(40)}`;
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(out).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('leaves non-secret content untouched', () => {
    const input = 'normal log message with no secrets, just words and numbers 12345';
    expect(redactSecrets(input)).toBe(input);
  });

  it('handles empty / falsy input safely', () => {
    expect(redactSecrets('')).toBe('');
  });
});
