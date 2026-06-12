/**
 * Unit tests for src/server/diag-mode.ts
 *
 * Covers:
 *   - setDiagMode / getDiagMode round-trip for all 3 modes
 *   - renderDiagTrailer returns '' when mode is 'off'
 *   - summary format structure (regex match, not byte-exact)
 *   - verbose mode includes present sections, omits absent ones
 *   - token formula edge cases: zero bytes, 1 child, many children
 *   - env hint fields appear/disappear based on process.env
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setDiagMode,
  getDiagMode,
  renderDiagTrailer,
  type DiagMode,
  type DiagPayload,
} from '../../src/server/diag-mode.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<DiagPayload> = {}): DiagPayload {
  return {
    callType: 'execute_code',
    toolName: 'execute_code',
    wallMs: 412,
    rawBytesIn: 1240,
    outBytesToModel: 180,
    scriptChars: 320,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mode state: set/get round-trip
// ---------------------------------------------------------------------------

describe('setDiagMode / getDiagMode', () => {
  afterEach(() => {
    // Reset to off after each test to avoid state bleed
    setDiagMode('off');
  });

  it('defaults to off before any mutation', () => {
    setDiagMode('off');
    expect(getDiagMode()).toBe('off');
  });

  it('round-trips summary', () => {
    const result = setDiagMode('summary');
    expect(result).toBe('summary');
    expect(getDiagMode()).toBe('summary');
  });

  it('round-trips verbose', () => {
    const result = setDiagMode('verbose');
    expect(result).toBe('verbose');
    expect(getDiagMode()).toBe('verbose');
  });

  it('round-trips off', () => {
    setDiagMode('verbose');
    const result = setDiagMode('off');
    expect(result).toBe('off');
    expect(getDiagMode()).toBe('off');
  });

  it('returns the mode that was set', () => {
    const modes: DiagMode[] = ['off', 'summary', 'verbose'];
    for (const m of modes) {
      expect(setDiagMode(m)).toBe(m);
    }
  });
});

// ---------------------------------------------------------------------------
// renderDiagTrailer — off mode
// ---------------------------------------------------------------------------

describe('renderDiagTrailer — off mode', () => {
  it('returns empty string when mode is off', () => {
    expect(renderDiagTrailer(makePayload(), 'off')).toBe('');
  });

  it('returns empty string regardless of payload when mode is off', () => {
    const payload = makePayload({ wallMs: 9999, rawBytesIn: 1_000_000, outBytesToModel: 500_000 });
    expect(renderDiagTrailer(payload, 'off')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// renderDiagTrailer — summary mode
// ---------------------------------------------------------------------------

describe('renderDiagTrailer — summary mode', () => {
  it('returns a non-empty single-line string', () => {
    const result = renderDiagTrailer(makePayload(), 'summary');
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain('\n');
  });

  it('starts with the diag marker', () => {
    const result = renderDiagTrailer(makePayload(), 'summary');
    expect(result).toMatch(/^─ \[diag\] /);
  });

  it('contains wall time in ms', () => {
    const result = renderDiagTrailer(makePayload({ wallMs: 412 }), 'summary');
    expect(result).toContain('wall=412ms');
  });

  it('contains raw→out byte counts', () => {
    const result = renderDiagTrailer(makePayload({ rawBytesIn: 1240, outBytesToModel: 180 }), 'summary');
    expect(result).toContain('raw=1240b');
    expect(result).toContain('out=180b');
  });

  it('contains est_passthrough token estimate', () => {
    const result = renderDiagTrailer(makePayload(), 'summary');
    expect(result).toMatch(/est_passthrough≈\d+t/);
  });

  it('contains est_execution token estimate', () => {
    const result = renderDiagTrailer(makePayload(), 'summary');
    expect(result).toMatch(/est_execution≈\d+t/);
  });

  it('contains savings percentage', () => {
    const result = renderDiagTrailer(makePayload(), 'summary');
    expect(result).toMatch(/savings≈\d+\.\d+%/);
  });

  it('does not include model/effort when env hints are absent', () => {
    // Ensure env hints are absent
    const savedModel = process.env['MCP_CONDUCTOR_CLIENT_MODEL'];
    const savedEffort = process.env['MCP_CONDUCTOR_CLIENT_EFFORT'];
    delete process.env['MCP_CONDUCTOR_CLIENT_MODEL'];
    delete process.env['MCP_CONDUCTOR_CLIENT_EFFORT'];

    try {
      const result = renderDiagTrailer(makePayload(), 'summary');
      expect(result).not.toContain('model=');
      expect(result).not.toContain('effort=');
    } finally {
      if (savedModel !== undefined) process.env['MCP_CONDUCTOR_CLIENT_MODEL'] = savedModel;
      if (savedEffort !== undefined) process.env['MCP_CONDUCTOR_CLIENT_EFFORT'] = savedEffort;
    }
  });

  it('appends model and effort when env hints are set', () => {
    const savedModel = process.env['MCP_CONDUCTOR_CLIENT_MODEL'];
    const savedEffort = process.env['MCP_CONDUCTOR_CLIENT_EFFORT'];
    process.env['MCP_CONDUCTOR_CLIENT_MODEL'] = 'opus-4.7';
    process.env['MCP_CONDUCTOR_CLIENT_EFFORT'] = 'medium';

    try {
      const result = renderDiagTrailer(makePayload(), 'summary');
      expect(result).toContain('model=opus-4.7');
      expect(result).toContain('effort=medium');
    } finally {
      if (savedModel !== undefined) {
        process.env['MCP_CONDUCTOR_CLIENT_MODEL'] = savedModel;
      } else {
        delete process.env['MCP_CONDUCTOR_CLIENT_MODEL'];
      }
      if (savedEffort !== undefined) {
        process.env['MCP_CONDUCTOR_CLIENT_EFFORT'] = savedEffort;
      } else {
        delete process.env['MCP_CONDUCTOR_CLIENT_EFFORT'];
      }
    }
  });

  it('appends only model when effort is absent', () => {
    const savedModel = process.env['MCP_CONDUCTOR_CLIENT_MODEL'];
    const savedEffort = process.env['MCP_CONDUCTOR_CLIENT_EFFORT'];
    process.env['MCP_CONDUCTOR_CLIENT_MODEL'] = 'sonnet-4.5';
    delete process.env['MCP_CONDUCTOR_CLIENT_EFFORT'];

    try {
      const result = renderDiagTrailer(makePayload(), 'summary');
      expect(result).toContain('model=sonnet-4.5');
      expect(result).not.toContain('effort=');
    } finally {
      if (savedModel !== undefined) {
        process.env['MCP_CONDUCTOR_CLIENT_MODEL'] = savedModel;
      } else {
        delete process.env['MCP_CONDUCTOR_CLIENT_MODEL'];
      }
      if (savedEffort !== undefined) process.env['MCP_CONDUCTOR_CLIENT_EFFORT'] = savedEffort;
    }
  });
});

// ---------------------------------------------------------------------------
// renderDiagTrailer — verbose mode
// ---------------------------------------------------------------------------

describe('renderDiagTrailer — verbose mode', () => {
  it('returns a multi-line string', () => {
    const result = renderDiagTrailer(makePayload(), 'verbose');
    expect(result).toContain('\n');
  });

  it('first line is the diag header with callType', () => {
    const result = renderDiagTrailer(makePayload({ callType: 'execute_code' }), 'verbose');
    const firstLine = result.split('\n')[0];
    expect(firstLine).toMatch(/^─ \[diag\] execute_code$/);
  });

  it('includes wall time line', () => {
    const result = renderDiagTrailer(makePayload({ wallMs: 999 }), 'verbose');
    expect(result).toContain('wall:');
    expect(result).toContain('999ms');
  });

  it('includes sandbox boot time when present', () => {
    const result = renderDiagTrailer(makePayload({ sandboxBootMs: 78 }), 'verbose');
    expect(result).toContain('sandbox 78ms');
  });

  it('omits sandbox boot time when absent', () => {
    const result = renderDiagTrailer(makePayload({ sandboxBootMs: undefined }), 'verbose');
    expect(result).not.toContain('sandbox');
  });

  it('includes trim time when present', () => {
    const result = renderDiagTrailer(makePayload({ resultTrimMs: 22 }), 'verbose');
    expect(result).toContain('trim 22ms');
  });

  it('omits trim time when absent', () => {
    const result = renderDiagTrailer(makePayload({ resultTrimMs: undefined }), 'verbose');
    expect(result).not.toContain('trim');
  });

  it('includes child calls section when calls present', () => {
    const payload = makePayload({
      childCalls: [
        { server: 'ibkr', tool: 'get_quote', wallMs: 145, rawBytes: 980 },
      ],
    });
    const result = renderDiagTrailer(payload, 'verbose');
    expect(result).toContain('child calls:');
    expect(result).toContain('ibkr.get_quote');
    expect(result).toContain('145ms');
    expect(result).toContain('980b');
  });

  it('omits child calls section when childCalls is absent', () => {
    const result = renderDiagTrailer(makePayload({ childCalls: undefined }), 'verbose');
    expect(result).not.toContain('child calls:');
  });

  it('omits child calls section when childCalls is empty', () => {
    const result = renderDiagTrailer(makePayload({ childCalls: [] }), 'verbose');
    expect(result).not.toContain('child calls:');
  });

  it('renders multiple child calls', () => {
    const payload = makePayload({
      childCalls: [
        { server: 'ibkr', tool: 'get_quote', wallMs: 145, rawBytes: 980 },
        { server: 'ibkr', tool: 'get_quote', wallMs: 167, rawBytes: 1020 },
      ],
    });
    const result = renderDiagTrailer(payload, 'verbose');
    const lines = result.split('\n');
    const childLines = lines.filter((l) => l.includes('ibkr.get_quote'));
    expect(childLines).toHaveLength(2);
  });

  it('includes bytes line', () => {
    const result = renderDiagTrailer(makePayload({ rawBytesIn: 2000, outBytesToModel: 180 }), 'verbose');
    expect(result).toContain('bytes:');
    expect(result).toContain('raw 2000');
    expect(result).toContain('out 180');
  });

  it('includes tokens est line', () => {
    const result = renderDiagTrailer(makePayload(), 'verbose');
    expect(result).toContain('tokens est:');
    expect(result).toMatch(/passthrough≈\d+/);
    expect(result).toMatch(/execute_code≈\d+/);
    expect(result).toMatch(/savings≈\d+\.\d+%/);
  });

  it('includes client section when env hints are set', () => {
    const savedModel = process.env['MCP_CONDUCTOR_CLIENT_MODEL'];
    const savedEffort = process.env['MCP_CONDUCTOR_CLIENT_EFFORT'];
    process.env['MCP_CONDUCTOR_CLIENT_MODEL'] = 'opus-4.7';
    process.env['MCP_CONDUCTOR_CLIENT_EFFORT'] = 'medium';

    try {
      const result = renderDiagTrailer(makePayload(), 'verbose');
      expect(result).toContain('client:');
      expect(result).toContain('model=opus-4.7');
      expect(result).toContain('effort=medium');
    } finally {
      if (savedModel !== undefined) {
        process.env['MCP_CONDUCTOR_CLIENT_MODEL'] = savedModel;
      } else {
        delete process.env['MCP_CONDUCTOR_CLIENT_MODEL'];
      }
      if (savedEffort !== undefined) {
        process.env['MCP_CONDUCTOR_CLIENT_EFFORT'] = savedEffort;
      } else {
        delete process.env['MCP_CONDUCTOR_CLIENT_EFFORT'];
      }
    }
  });

  it('omits client section when env hints are absent', () => {
    const savedModel = process.env['MCP_CONDUCTOR_CLIENT_MODEL'];
    const savedEffort = process.env['MCP_CONDUCTOR_CLIENT_EFFORT'];
    delete process.env['MCP_CONDUCTOR_CLIENT_MODEL'];
    delete process.env['MCP_CONDUCTOR_CLIENT_EFFORT'];

    try {
      const result = renderDiagTrailer(makePayload(), 'verbose');
      expect(result).not.toContain('client:');
    } finally {
      if (savedModel !== undefined) process.env['MCP_CONDUCTOR_CLIENT_MODEL'] = savedModel;
      if (savedEffort !== undefined) process.env['MCP_CONDUCTOR_CLIENT_EFFORT'] = savedEffort;
    }
  });

  it('uses passthrough callType in header', () => {
    const result = renderDiagTrailer(makePayload({ callType: 'passthrough' }), 'verbose');
    const firstLine = result.split('\n')[0];
    expect(firstLine).toContain('passthrough');
  });

  it('uses passthrough_tool callType in header', () => {
    const result = renderDiagTrailer(makePayload({ callType: 'passthrough_tool' }), 'verbose');
    const firstLine = result.split('\n')[0];
    expect(firstLine).toContain('passthrough_tool');
  });
});

// ---------------------------------------------------------------------------
// Token formula edge cases
// ---------------------------------------------------------------------------

describe('renderDiagTrailer — token formula edge cases', () => {
  it('handles zero rawBytesIn without NaN or Infinity', () => {
    // rawBytesIn=0, outBytesToModel=0, scriptChars=0
    // passthrough = ceil(0/1024*256) + 1*150 = 150
    // execution  = ceil(0/3.5) + ceil(0/3.8) = 0
    // savings    = clamp((1-0/150)*100, 0, 99.9) = 99.9%
    const payload = makePayload({ rawBytesIn: 0, outBytesToModel: 0, scriptChars: 0 });
    const result = renderDiagTrailer(payload, 'summary');
    expect(result).not.toContain('NaN');
    expect(result).not.toContain('Infinity');
    expect(result).toContain('est_passthrough≈150t');
    expect(result).toContain('est_execution≈0t');
    expect(result).toContain('savings≈99.9%');
  });

  it('handles zero outBytesToModel without NaN', () => {
    const payload = makePayload({ outBytesToModel: 0, scriptChars: 0 });
    const result = renderDiagTrailer(payload, 'summary');
    expect(result).not.toContain('NaN');
    expect(result).not.toContain('Infinity');
  });

  it('uses +1 call overhead (min 1) when no childCalls', () => {
    // rawBytesIn=1024, no children → passthrough = ceil(1024/1024*256) + 1*150 = 256+150 = 406
    const payload = makePayload({ rawBytesIn: 1024, outBytesToModel: 0, scriptChars: 0, childCalls: undefined });
    const result = renderDiagTrailer(payload, 'summary');
    expect(result).toContain('est_passthrough≈406t');
  });

  it('uses 1-child overhead for 1 child call', () => {
    // rawBytesIn=1024, 1 child → passthrough = ceil(1024/1024*256) + 1*150 = 256+150 = 406
    const payload = makePayload({
      rawBytesIn: 1024,
      outBytesToModel: 0,
      scriptChars: 0,
      childCalls: [{ server: 'srv', tool: 'get', wallMs: 10, rawBytes: 100 }],
    });
    const result = renderDiagTrailer(payload, 'summary');
    expect(result).toContain('est_passthrough≈406t');
  });

  it('scales passthrough overhead for many child calls', () => {
    // rawBytesIn=1024, 3 children → passthrough = ceil(1024/1024*256) + 3*150 = 256+450 = 706
    const childCalls = [
      { server: 'srv', tool: 'a', wallMs: 10, rawBytes: 100 },
      { server: 'srv', tool: 'b', wallMs: 10, rawBytes: 100 },
      { server: 'srv', tool: 'c', wallMs: 10, rawBytes: 100 },
    ];
    const payload = makePayload({ rawBytesIn: 1024, outBytesToModel: 0, scriptChars: 0, childCalls });
    const result = renderDiagTrailer(payload, 'summary');
    expect(result).toContain('est_passthrough≈706t');
  });

  it('clamps savings to 0 when execution tokens exceed passthrough tokens', () => {
    // Force execution > passthrough: tiny raw, huge script
    const payload = makePayload({ rawBytesIn: 1, outBytesToModel: 1, scriptChars: 999_999 });
    const result = renderDiagTrailer(payload, 'summary');
    expect(result).toContain('savings≈0.0%');
  });

  it('clamps savings to 99.9 maximum', () => {
    // Force near-zero execution tokens with huge passthrough: large raw, tiny out, no code
    const payload = makePayload({ rawBytesIn: 1_000_000, outBytesToModel: 1, scriptChars: 1 });
    const result = renderDiagTrailer(payload, 'summary');
    // savings should be high but capped at 99.9
    expect(result).toMatch(/savings≈\d+\.\d+%/);
    const match = result.match(/savings≈(\d+\.\d+)%/);
    expect(match).not.toBeNull();
    const pct = parseFloat(match![1]);
    expect(pct).toBeLessThanOrEqual(99.9);
    expect(pct).toBeGreaterThan(90);
  });

  it('omits scriptChars term when scriptChars is undefined (passthrough path)', () => {
    // passthrough path: no scriptChars → execution = ceil(out/3.8) + 150
    const payload = makePayload({ rawBytesIn: 1024, outBytesToModel: 380, scriptChars: undefined });
    const result = renderDiagTrailer(payload, 'summary');
    // execution tokens = ceil(380/3.8) + 150 = 100 + 150 = 250
    expect(result).toContain('est_execution≈250t');
  });
});
