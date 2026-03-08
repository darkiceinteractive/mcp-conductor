/**
 * Claude Desktop Context-Window Benchmark Suite
 *
 * Quantifies the context-window benefit unique to Claude Desktop users:
 *  - How many workflow executions fit before the 200 K context window fills
 *  - Session longevity improvements in execution mode vs passthrough
 *  - Monthly API cost savings at Sonnet pricing
 *
 * Numbers are derived deterministically from the workflow fixtures; no external
 * services are called.
 */

import { describe, it, expect } from 'vitest';
import {
  CLAUDE_DESKTOP_SESSIONS,
  WORKFLOW_FIXTURES,
  computeSessionTokens,
  computeMonthlySavingsUsd,
  getWorkflowFixture,
} from '../fixtures/workflow-fixtures.js';
import { computeScenarioMetrics } from '../fixtures/scale-fixtures.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * How many times can a session's workflow-only token budget fit inside a
 * context window before it fills?  Uses workflow tokens only (conversation
 * overhead is excluded so we measure the tool-data capacity cleanly).
 */
function sessionsBeforeContextFull(workflowTokens: number, contextWindow: number): number {
  if (workflowTokens <= 0) return Infinity;
  return Math.floor(contextWindow / workflowTokens);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Claude Desktop Context-Window Benchmark', () => {
  // ── Per-profile assertions ────────────────────────────────────────────────

  for (const session of CLAUDE_DESKTOP_SESSIONS) {
    describe(session.label, () => {
      it('workflow compression exceeds 95%', () => {
        const { workflowCompressionPct } = computeSessionTokens(session);
        expect(
          workflowCompressionPct,
          `${session.profile}: workflow compression ${workflowCompressionPct.toFixed(1)}% should exceed 95%`
        ).toBeGreaterThan(95);
      });

      it('execution mode total context fits within 200K window', () => {
        const { totalExecutionTokens } = computeSessionTokens(session);
        expect(
          totalExecutionTokens,
          `${session.profile}: totalExecution ${totalExecutionTokens} should fit in ${session.contextWindowSize}`
        ).toBeLessThan(session.contextWindowSize);
      });

      it('workflow execution tokens are < 5% of the context window', () => {
        const { executionWorkflowTokens } = computeSessionTokens(session);
        const pct = (executionWorkflowTokens / session.contextWindowSize) * 100;
        expect(
          pct,
          `${session.profile}: workflow execution tokens ${executionWorkflowTokens} = ${pct.toFixed(2)}% of context (should be < 5%)`
        ).toBeLessThan(5);
      });

      it('execution mode provides ≥ 10× more workflow-data capacity than passthrough', () => {
        const { passthroughWorkflowTokens, executionWorkflowTokens } =
          computeSessionTokens(session);

        const passCount = sessionsBeforeContextFull(
          passthroughWorkflowTokens,
          session.contextWindowSize
        );
        const execCount = sessionsBeforeContextFull(
          executionWorkflowTokens,
          session.contextWindowSize
        );

        // Guard against divide-by-zero when passthrough overflows the window
        if (passCount === 0) {
          // passthrough already overflows — execution must still fit
          expect(execCount).toBeGreaterThan(0);
        } else {
          const ratio = execCount / passCount;
          expect(
            ratio,
            `${session.profile}: execution fits ${execCount}× vs passthrough ${passCount}× — ratio ${ratio.toFixed(1)} should be ≥ 10`
          ).toBeGreaterThanOrEqual(10);
        }
      });
    });
  }

  // ── Cross-profile assertions ───────────────────────────────────────────────

  it('execution mode provides ≥ 20× more context-window capacity than passthrough (power-user)', () => {
    const powerUser = CLAUDE_DESKTOP_SESSIONS.find((s) => s.profile === 'power-user')!;
    const { passthroughWorkflowTokens, executionWorkflowTokens } =
      computeSessionTokens(powerUser);

    const ratio = passthroughWorkflowTokens / executionWorkflowTokens;
    expect(
      ratio,
      `power-user passthrough/execution ratio ${ratio.toFixed(1)}× should be ≥ 20`
    ).toBeGreaterThanOrEqual(20);
  });

  it('light-user session workflow tokens consume < 1% of context window in execution mode', () => {
    const lightUser = CLAUDE_DESKTOP_SESSIONS.find((s) => s.profile === 'light-user')!;
    const { executionWorkflowTokens } = computeSessionTokens(lightUser);
    const pct = (executionWorkflowTokens / lightUser.contextWindowSize) * 100;
    expect(pct).toBeLessThan(1);
  });

  it('power-user session does not exhaust 200K context even at 8 deep workflows', () => {
    const powerUser = CLAUDE_DESKTOP_SESSIONS.find((s) => s.profile === 'power-user')!;
    expect(powerUser.workflowsRun).toHaveLength(8);
    const { totalExecutionTokens } = computeSessionTokens(powerUser);
    expect(totalExecutionTokens).toBeLessThan(powerUser.contextWindowSize);
  });

  it('heavy-automation passthrough context overflows 200K (shows the problem)', () => {
    const heavy = CLAUDE_DESKTOP_SESSIONS.find((s) => s.profile === 'heavy-automation')!;
    const { totalPassthroughTokens } = computeSessionTokens(heavy);
    expect(totalPassthroughTokens).toBeGreaterThan(heavy.contextWindowSize);
  });

  it('heavy-automation execution context stays within 200K (execution mode is sustainable)', () => {
    const heavy = CLAUDE_DESKTOP_SESSIONS.find((s) => s.profile === 'heavy-automation')!;
    const { totalExecutionTokens } = computeSessionTokens(heavy);
    expect(totalExecutionTokens).toBeLessThan(heavy.contextWindowSize);
  });

  it('monthly savings at power-user rate exceed $40/month at Sonnet pricing', () => {
    const powerUser = CLAUDE_DESKTOP_SESSIONS.find((s) => s.profile === 'power-user')!;
    const savings = computeMonthlySavingsUsd(powerUser);
    expect(
      savings,
      `power-user monthly savings $${savings.toFixed(2)} should exceed $40`
    ).toBeGreaterThan(40);
  });

  it('monthly savings at light-user rate are positive', () => {
    const lightUser = CLAUDE_DESKTOP_SESSIONS.find((s) => s.profile === 'light-user')!;
    const savings = computeMonthlySavingsUsd(lightUser);
    expect(savings).toBeGreaterThan(0);
  });

  it('heavy-automation saves more per month than power-user (more sessions)', () => {
    const powerUser = CLAUDE_DESKTOP_SESSIONS.find((s) => s.profile === 'power-user')!;
    const heavy = CLAUDE_DESKTOP_SESSIONS.find((s) => s.profile === 'heavy-automation')!;
    const powerSavings = computeMonthlySavingsUsd(powerUser);
    const heavySavings = computeMonthlySavingsUsd(heavy);
    expect(heavySavings).toBeGreaterThan(powerSavings);
  });

  it('sessions-before-context-full is ≥ 5× higher in execution mode (light-user)', () => {
    const lightUser = CLAUDE_DESKTOP_SESSIONS.find((s) => s.profile === 'light-user')!;
    const { passthroughWorkflowTokens, executionWorkflowTokens } =
      computeSessionTokens(lightUser);

    const passCount = sessionsBeforeContextFull(
      passthroughWorkflowTokens,
      lightUser.contextWindowSize
    );
    const execCount = sessionsBeforeContextFull(
      executionWorkflowTokens,
      lightUser.contextWindowSize
    );

    expect(passCount).toBeGreaterThan(0);
    expect(execCount).toBeGreaterThan(0);

    const ratio = execCount / passCount;
    expect(
      ratio,
      `light-user: execution fits ${execCount}× vs passthrough ${passCount}× — ratio ${ratio.toFixed(1)} should be ≥ 5`
    ).toBeGreaterThanOrEqual(5);
  });

  it('all session profiles achieve consistent workflow compression (within 2% of each other)', () => {
    const compressions = CLAUDE_DESKTOP_SESSIONS.map(
      (s) => computeSessionTokens(s).workflowCompressionPct
    );
    const min = Math.min(...compressions);
    const max = Math.max(...compressions);
    expect(
      max - min,
      `Compression spread ${(max - min).toFixed(1)}% should be within 2% across profiles`
    ).toBeLessThanOrEqual(2);
  });

  it('each individual workflow deep scenario achieves ≥ 90% compression', () => {
    // research-synthesis uses only 12 KB / 5 calls — smallest fixture, ~93.5% compression.
    // All other deep scenarios exceed 95%. Floor is 90% to accommodate low-data workflows.
    for (const wf of WORKFLOW_FIXTURES) {
      const { compressionPct } = computeScenarioMetrics(wf.deep);
      expect(
        compressionPct,
        `${wf.category} deep: ${compressionPct.toFixed(1)}% should be ≥ 90%`
      ).toBeGreaterThanOrEqual(90);
    }
  });

  it('produces a complete session stats summary (smoke-test)', () => {
    const stats = CLAUDE_DESKTOP_SESSIONS.map((session) => {
      const tokens = computeSessionTokens(session);
      const monthlySavings = computeMonthlySavingsUsd(session);
      const passCount = sessionsBeforeContextFull(
        tokens.passthroughWorkflowTokens,
        session.contextWindowSize
      );
      const execCount = sessionsBeforeContextFull(
        tokens.executionWorkflowTokens,
        session.contextWindowSize
      );
      return {
        profile: session.profile,
        workflows: session.workflowsRun.length,
        passthroughWorkflowTokens: tokens.passthroughWorkflowTokens,
        executionWorkflowTokens: tokens.executionWorkflowTokens,
        workflowCompressionPct: parseFloat(tokens.workflowCompressionPct.toFixed(1)),
        sessionsPassthrough: passCount,
        sessionsExecution: execCount,
        monthlySavingsUsd: parseFloat(monthlySavings.toFixed(2)),
      };
    });

    expect(stats).toHaveLength(3);
    // Each profile must have positive token counts and positive savings
    for (const s of stats) {
      expect(s.passthroughWorkflowTokens).toBeGreaterThan(0);
      expect(s.executionWorkflowTokens).toBeGreaterThan(0);
      expect(s.monthlySavingsUsd).toBeGreaterThan(0);
    }
  });
});
