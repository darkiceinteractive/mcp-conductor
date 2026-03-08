/**
 * Workflow Fixtures for MCP Conductor Benchmark Suite
 *
 * Developer-centric scenarios that map to real daily tasks.
 * Each category provides two variants:
 *   quick — "I have 5 minutes"
 *   deep  — "thorough pass"
 *
 * All ScenarioFixture shapes are compatible with computeScenarioMetrics()
 * from scale-fixtures.ts so the existing token formula is reused unchanged.
 */

import {
  type ScenarioFixture,
  computePassthroughTokens,
  computeExecutionTokens,
  PRICING,
} from './scale-fixtures.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type WorkflowCategory =
  | 'morning-standup'
  | 'code-review'
  | 'bug-investigation'
  | 'dependency-check'
  | 'research-synthesis'
  | 'project-context-load'
  | 'release-prep';

export interface WorkflowFixture {
  category: WorkflowCategory;
  label: string;
  description: string;
  /** Tight time-budget variant (~5 min) */
  quick: ScenarioFixture;
  /** Thorough-pass variant */
  deep: ScenarioFixture;
}

export type SessionProfile = 'light-user' | 'power-user' | 'heavy-automation';

export interface ClaudeDesktopSessionFixture {
  profile: SessionProfile;
  label: string;
  description: string;
  /** Workflow categories executed during the session (order matters for totals) */
  workflowsRun: WorkflowCategory[];
  /**
   * Tokens from natural-language conversation turns (user + Claude messages).
   * This overhead is identical in passthrough and execution modes.
   */
  conversationTokens: number;
  /** Claude Desktop context window limit (200 K as of 2026) */
  contextWindowSize: number;
  /** Assumed daily session count used for monthly cost projections */
  sessionsPerDay: number;
}

export interface SessionTokens {
  conversationTokens: number;
  passthroughWorkflowTokens: number;
  executionWorkflowTokens: number;
  /** conversationTokens + passthroughWorkflowTokens */
  totalPassthroughTokens: number;
  /** conversationTokens + executionWorkflowTokens */
  totalExecutionTokens: number;
  /** Compression % on the workflow (tool-data) portion only */
  workflowCompressionPct: number;
}

// ─── Workflow Fixtures ────────────────────────────────────────────────────────

export const WORKFLOW_FIXTURES: WorkflowFixture[] = [
  // ── Morning Standup ──────────────────────────────────────────────────────
  {
    category: 'morning-standup',
    label: 'Morning Standup',
    description: 'Merged PRs, closed issues, overnight CI failures, new bugs since yesterday',
    quick: {
      name: 'morning-standup-quick',
      description: 'Quick standup: merged PRs + CI status (5-minute budget)',
      toolCalls: 5,
      dataBytes: 15_360, // 15 KB — PR list + CI summary + new-issue digest
      codeChars: 320,
      resultJson: JSON.stringify({
        date: '2026-03-03',
        mergedPRs: 3,
        closedIssues: 7,
        ciFailed: 1,
        newBugs: 2,
        summary:
          '3 PRs merged overnight. 1 CI failure on auth service needs attention. 2 new bugs triaged.',
      }),
      servers: ['github'],
    },
    deep: {
      name: 'morning-standup-deep',
      description:
        'Full standup: merged PRs + closed issues + CI failures + new bugs + overnight alerts',
      toolCalls: 8,
      dataBytes: 30_720, // 30 KB
      codeChars: 480,
      resultJson: JSON.stringify({
        date: '2026-03-03',
        mergedPRs: 5,
        closedIssues: 12,
        ciFailed: 2,
        newBugs: 4,
        alertsTriggered: 1,
        blockedIssues: 3,
        topPriority: 'AUTH-512: Session expiry regression from yesterday',
        summary:
          '5 PRs merged. 2 CI failures require attention. Priority: AUTH-512 regressed in last deploy.',
      }),
      servers: ['github'],
    },
  },

  // ── Code Review ───────────────────────────────────────────────────────────
  {
    category: 'code-review',
    label: 'Code Review',
    description: 'PR diff, linked issue, affected test files, style guide for an informed review',
    quick: {
      name: 'code-review-quick',
      description: 'Quick PR review: diff + linked issue + CI status',
      toolCalls: 6,
      dataBytes: 35_840, // 35 KB — PR diff + issue body + CI log excerpt
      codeChars: 520,
      resultJson: JSON.stringify({
        pr: 'PR #847',
        author: 'sam@example.dev',
        linesChanged: 234,
        filesChanged: 8,
        linkedIssue: 'AUTH-489',
        ciStatus: 'passing',
        concerns: [
          'Missing error handling in token refresh',
          'No unit tests for the edge case',
        ],
        recommendation: 'Request changes: add error handling and 2 unit tests',
      }),
      servers: ['github', 'filesystem'],
    },
    deep: {
      name: 'code-review-deep',
      description: 'Full PR review: diff + issue + test files + style guide + related past PRs',
      toolCalls: 10,
      dataBytes: 66_560, // 65 KB
      codeChars: 680,
      resultJson: JSON.stringify({
        pr: 'PR #847',
        author: 'sam@example.dev',
        linesChanged: 234,
        filesChanged: 8,
        testCoverage: '72% (was 78%)',
        styleViolations: 3,
        securityFlags: 1,
        relatedPRs: ['PR #831', 'PR #809'],
        concerns: [
          'Coverage regression: 72% vs 78% baseline',
          'Missing error handling in token refresh',
          'Potential timing attack in token comparison',
        ],
        recommendation:
          'Request changes: fix timing attack (security), restore coverage, add error handling',
      }),
      servers: ['github', 'filesystem'],
    },
  },

  // ── Bug Investigation ─────────────────────────────────────────────────────
  {
    category: 'bug-investigation',
    label: 'Bug Investigation',
    description:
      'Bug issue, related commits, file blame, similar past issues for root-cause analysis',
    quick: {
      name: 'bug-investigation-quick',
      description: 'Quick bug triage: issue body + recent commits + file blame',
      toolCalls: 5,
      dataBytes: 25_600, // 25 KB
      codeChars: 430,
      resultJson: JSON.stringify({
        issueId: 'BUG-1023',
        title: 'User sessions expire prematurely on mobile',
        affectedFile: 'src/auth/session-manager.ts',
        likelyRootCause:
          'Clock skew in token validation — introduced in commit a4f2c91',
        commitIntroduced: 'a4f2c91 (2 days ago)',
        fix: 'Add 30s clock skew tolerance to session.isValid()',
        confidence: 'high',
      }),
      servers: ['github', 'filesystem'],
    },
    deep: {
      name: 'bug-investigation-deep',
      description:
        'Deep investigation: issue + commits + blame + 3 related past issues + stack traces',
      toolCalls: 8,
      dataBytes: 46_080, // 45 KB
      codeChars: 600,
      resultJson: JSON.stringify({
        issueId: 'BUG-1023',
        title: 'User sessions expire prematurely on mobile',
        affectedFiles: [
          'src/auth/session-manager.ts',
          'src/auth/token-validator.ts',
        ],
        rootCause:
          'Clock skew in token validation — mobile clients report UTC+0, server uses local TZ',
        commitIntroduced: 'a4f2c91 — "Refactor token validation" (2 days ago)',
        similarIssues: ['BUG-891 (fixed)', 'BUG-756 (fixed)', 'BUG-1001 (open)'],
        fix: 'Normalise to UTC in session.isValid(); add 30s tolerance for clock skew',
        testCasesRequired: 3,
        confidence: 'high',
      }),
      servers: ['github', 'filesystem'],
    },
  },

  // ── Dependency Check ──────────────────────────────────────────────────────
  {
    category: 'dependency-check',
    label: 'Dependency Check',
    description:
      'package.json audit, lockfile analysis, CVE scan, and outdated package report',
    quick: {
      name: 'dependency-check-quick',
      description: 'Quick dep audit: package.json + npm audit summary',
      toolCalls: 4,
      dataBytes: 18_432, // 18 KB — package.json + audit JSON
      codeChars: 380,
      resultJson: JSON.stringify({
        totalDeps: 47,
        directDeps: 18,
        vulnerabilities: { critical: 0, high: 1, medium: 3 },
        outdated: 6,
        criticalAction: 'Patch axios@1.6.x — CVE-2024-4889',
        estimatedEffort: '2h',
      }),
      servers: ['filesystem'],
    },
    deep: {
      name: 'dependency-check-deep',
      description:
        'Full dep audit: package.json + lockfile + CVE scan + outdated + licence check',
      toolCalls: 6,
      dataBytes: 35_840, // 35 KB — lockfile analysis is large
      codeChars: 500,
      resultJson: JSON.stringify({
        totalDeps: 47,
        directDeps: 18,
        transitiveDeps: 29,
        vulnerabilities: { critical: 0, high: 1, medium: 3, low: 8 },
        outdated: 6,
        licenceIssues: 1,
        recommendations: [
          'Patch axios@1.6.x — CVE-2024-4889 (high, SSRF)',
          'Upgrade eslint@8 to v9 (review breaking changes in peer deps)',
          'Replace deprecated node-uuid with crypto.randomUUID()',
        ],
        estimatedEffort: '4h',
      }),
      servers: ['filesystem'],
    },
  },

  // ── Research Synthesis ────────────────────────────────────────────────────
  {
    category: 'research-synthesis',
    label: 'Research Synthesis',
    description:
      'Parallel web searches on a technical topic, synthesised into key findings',
    quick: {
      name: 'research-synthesis-quick',
      description: '3 parallel Brave searches, key findings extracted',
      toolCalls: 3,
      dataBytes: 8_192, // 8 KB — 3 × 5 search results
      codeChars: 260,
      resultJson: JSON.stringify({
        topic: 'TypeScript 5.8 performance improvements',
        sourcesQueried: 3,
        keyFindings: [
          'Faster incremental builds via improved watch-mode caching',
          'New --noCheck flag cuts CI build times by up to 40%',
          'Decorator metadata API now stable',
        ],
        consensus: 'strong',
        actionItem:
          'Upgrade to TS 5.8 and enable --noCheck in CI for ~40% build-time reduction',
      }),
      servers: ['brave-search'],
    },
    deep: {
      name: 'research-synthesis-deep',
      description:
        '5 parallel searches with synthesis, credibility scoring, and action plan',
      toolCalls: 5,
      dataBytes: 12_288, // 12 KB — 5 × 5 search results
      codeChars: 350,
      resultJson: JSON.stringify({
        topic: 'TypeScript 5.8 performance improvements',
        sourcesQueried: 5,
        keyFindings: [
          'Faster incremental builds via improved watch-mode caching (~25% faster)',
          'New --noCheck flag cuts CI build times by up to 40%',
          'Decorator metadata API now stable — removes reflect-metadata dependency',
          'Narrowing improvements reduce false-positive type errors in complex unions',
        ],
        dissent: 'Some reports of slower initial cold builds in large monorepos',
        credibilityScore: 0.87,
        actionItem:
          'Upgrade to TS 5.8; benchmark cold-build times in monorepo before enabling --noCheck',
      }),
      servers: ['brave-search'],
    },
  },

  // ── Project Context Load ──────────────────────────────────────────────────
  {
    category: 'project-context-load',
    label: 'Project Context Load',
    description:
      'README, architecture docs, open issues, last-30-days commits for full project context',
    quick: {
      name: 'project-context-load-quick',
      description: 'Quick context load: README + open issues + recent commits (1 week)',
      toolCalls: 7,
      dataBytes: 40_960, // 40 KB — README + issue list + commit log
      codeChars: 560,
      resultJson: JSON.stringify({
        project: 'mcp-conductor',
        openIssues: 23,
        recentCommits: 18,
        activeContributors: 4,
        latestVersion: '2.3.1',
        currentSprint: 'Sprint 12 — context window optimisation',
        hotAreas: ['src/sandbox/', 'src/metrics/'],
      }),
      servers: ['github', 'filesystem'],
    },
    deep: {
      name: 'project-context-load-deep',
      description:
        'Full context: README + architecture docs + open issues + 30-day commits + PR history',
      toolCalls: 13,
      dataBytes: 76_800, // 75 KB
      codeChars: 780,
      resultJson: JSON.stringify({
        project: 'mcp-conductor',
        architectureDocs: 3,
        openIssues: 23,
        prsLast30Days: 14,
        commitsLast30Days: 67,
        activeContributors: 6,
        latestVersion: '2.3.1',
        currentSprint: 'Sprint 12 — context window optimisation',
        hotAreas: ['src/sandbox/', 'src/metrics/', 'src/routing/'],
        technicalDebt: 'moderate (B grade)',
        nextMilestone: 'v2.4.0 — enterprise multi-tenant support',
      }),
      servers: ['github', 'filesystem'],
    },
  },

  // ── Release Prep ──────────────────────────────────────────────────────────
  {
    category: 'release-prep',
    label: 'Release Prep',
    description:
      'CHANGELOG compilation, version diff, migration notes, release checklist generation',
    quick: {
      name: 'release-prep-quick',
      description: 'Quick release prep: CHANGELOG entries + version bump + checklist',
      toolCalls: 5,
      dataBytes: 25_600, // 25 KB — CHANGELOG + diff
      codeChars: 420,
      resultJson: JSON.stringify({
        version: '2.4.0',
        changelogEntries: 12,
        breakingChanges: 1,
        migrationRequired: true,
        checklistItems: 8,
        estimatedReleaseTime: '45 min',
      }),
      servers: ['github', 'filesystem'],
    },
    deep: {
      name: 'release-prep-deep',
      description:
        'Full release prep: CHANGELOG + version diff + migration notes + checklist + comms draft',
      toolCalls: 9,
      dataBytes: 51_200, // 50 KB
      codeChars: 640,
      resultJson: JSON.stringify({
        version: '2.4.0',
        changelogEntries: 12,
        breakingChanges: 1,
        migrationNote:
          'executionMode option renamed to mode in config; auto-migration script provided',
        checklistItems: 14,
        blogsRequired: 1,
        docsUpdated: 5,
        estimatedReleaseTime: '2h',
        communicationDraft: 'ready',
        rollbackPlan: 'documented',
      }),
      servers: ['github', 'filesystem'],
    },
  },
];

// ─── Claude Desktop Session Fixtures ─────────────────────────────────────────

/**
 * Three session profiles representing different daily usage intensities.
 *
 * `conversationTokens` is the natural-language overhead shared by both modes.
 * Only the workflow (tool-data) portion differs: passthrough mode inflates context
 * with raw MCP responses, while execution mode replaces them with compact summaries.
 */
export const CLAUDE_DESKTOP_SESSIONS: ClaudeDesktopSessionFixture[] = [
  {
    profile: 'light-user',
    label: 'Light User (3 workflows)',
    description: 'Casual daily use: morning standup + one code review + one bug triage',
    workflowsRun: ['morning-standup', 'code-review', 'bug-investigation'],
    conversationTokens: 10_000, // ~500 tokens/turn × 20 turns
    contextWindowSize: 200_000,
    sessionsPerDay: 3,
  },
  {
    profile: 'power-user',
    label: 'Power User (8 workflows)',
    description:
      'Active developer: standup + 2 reviews + bug investigation + dep check + research + context load + release prep',
    workflowsRun: [
      'morning-standup',
      'code-review',
      'code-review',
      'bug-investigation',
      'dependency-check',
      'research-synthesis',
      'project-context-load',
      'release-prep',
    ],
    conversationTokens: 20_000, // ~500 tokens/turn × 40 turns
    contextWindowSize: 200_000,
    sessionsPerDay: 6,
  },
  {
    profile: 'heavy-automation',
    label: 'Heavy Automation (20 workflows)',
    description: 'CI/automation: all workflow types run multiple times in sequence',
    workflowsRun: [
      'morning-standup',
      'morning-standup',
      'code-review',
      'code-review',
      'code-review',
      'bug-investigation',
      'bug-investigation',
      'bug-investigation',
      'dependency-check',
      'dependency-check',
      'research-synthesis',
      'research-synthesis',
      'research-synthesis',
      'project-context-load',
      'project-context-load',
      'release-prep',
      'release-prep',
      'morning-standup',
      'code-review',
      'bug-investigation',
    ],
    conversationTokens: 30_000, // ~500 tokens/turn × 60 turns
    contextWindowSize: 200_000,
    sessionsPerDay: 12,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Look up a workflow fixture by category name. */
export function getWorkflowFixture(category: WorkflowCategory): WorkflowFixture {
  const fixture = WORKFLOW_FIXTURES.find((f) => f.category === category);
  if (!fixture) throw new Error(`Unknown workflow category: ${category}`);
  return fixture;
}

/**
 * Compute passthrough and execution token totals for a Claude Desktop session.
 *
 * Workflow compression is measured on the tool-data portion only. Conversation
 * tokens are identical in both modes and are returned separately so callers can
 * compute overall context usage for either mode independently.
 *
 * Sessions always use the `deep` variant (realistic thorough usage).
 */
export function computeSessionTokens(session: ClaudeDesktopSessionFixture): SessionTokens {
  let passthroughWorkflowTokens = 0;
  let executionWorkflowTokens = 0;

  for (const category of session.workflowsRun) {
    const { deep } = getWorkflowFixture(category);
    passthroughWorkflowTokens += computePassthroughTokens(deep.toolCalls, deep.dataBytes);
    executionWorkflowTokens += computeExecutionTokens(deep.codeChars, deep.resultJson);
  }

  const totalPassthroughTokens = session.conversationTokens + passthroughWorkflowTokens;
  const totalExecutionTokens = session.conversationTokens + executionWorkflowTokens;
  const workflowCompressionPct =
    passthroughWorkflowTokens > 0
      ? ((passthroughWorkflowTokens - executionWorkflowTokens) / passthroughWorkflowTokens) * 100
      : 0;

  return {
    conversationTokens: session.conversationTokens,
    passthroughWorkflowTokens,
    executionWorkflowTokens,
    totalPassthroughTokens,
    totalExecutionTokens,
    workflowCompressionPct,
  };
}

/**
 * Compute projected monthly USD savings at Sonnet pricing for a session profile.
 * Savings apply to the workflow (tool-data) portion only.
 */
export function computeMonthlySavingsUsd(session: ClaudeDesktopSessionFixture): number {
  const { passthroughWorkflowTokens, executionWorkflowTokens } = computeSessionTokens(session);
  const tokensSavedPerSession = Math.max(0, passthroughWorkflowTokens - executionWorkflowTokens);
  const monthlyTokensSaved = tokensSavedPerSession * session.sessionsPerDay * 30;
  return (monthlyTokensSaved / 1_000_000) * PRICING.sonnetInput;
}
