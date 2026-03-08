/**
 * Scale Fixtures for MCP Conductor Benchmark Suite
 *
 * Realistic MCP response data at four usage scales.
 * Token formula matches src/metrics/metrics-collector.ts exactly.
 */

// ─── Token estimation constants (mirror MetricsCollector defaults) ──────────
/** Overhead tokens per tool call in passthrough mode (request + response round-trip) */
export const TOOL_CALL_OVERHEAD_TOKENS = 150;
/** Tokens consumed per KB of raw MCP response data in context */
export const TOKENS_PER_KB = 256;
/** Characters per token for TypeScript code (Claude tokenizer, code content) */
export const CODE_CHARS_PER_TOKEN = 3.5;
/** Characters per token for JSON content (structural overhead accounted for) */
export const JSON_CHARS_PER_TOKEN = 3.8;

// ─── Pricing constants (USD, March 2026) ────────────────────────────────────
export const PRICING = {
  /** Claude Haiku 4.5 – input tokens, $/million */
  haikuInput: 0.8,
  /** Claude Sonnet 4.6 – input tokens, $/million */
  sonnetInput: 3.0,
  /** Claude Opus 4.6 – input tokens, $/million */
  opusInput: 15.0,
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScenarioFixture {
  /** Unique identifier for this scenario */
  name: string;
  /** Human-readable description */
  description: string;
  /** Number of MCP tool calls made in passthrough mode */
  toolCalls: number;
  /** Total raw bytes of MCP response data that would appear in context (passthrough mode) */
  dataBytes: number;
  /** Approximate character count of the TypeScript code sent to the sandbox */
  codeChars: number;
  /**
   * Compact JSON string the sandbox returns after processing.
   * This is what execution mode places in context — dramatically smaller than raw responses.
   */
  resultJson: string;
  /** MCP servers exercised in this scenario */
  servers: string[];
}

export interface ScaleFixture {
  scale: 'small' | 'medium' | 'large' | 'enterprise';
  label: string;
  description: string;
  /** Typical tool call range for this scale */
  toolCallRange: [number, number];
  /** Typical data size range in KB for this scale */
  dataSizeKbRange: [number, number];
  scenarios: ScenarioFixture[];
}

export interface ScenarioMetrics {
  /** Tokens consumed when all raw MCP responses appear in context */
  passthroughTokens: number;
  /** Tokens consumed in execution mode (code + compact result only) */
  executionTokens: number;
  /** Absolute tokens saved */
  tokensSaved: number;
  /** Compression percentage (0–100) */
  compressionPct: number;
  /** USD saved per session at Sonnet pricing */
  sonnetSavingsUsd: number;
}

// ─── Token formula (matches MetricsCollector exactly) ────────────────────────

/**
 * Estimate passthrough-mode tokens.
 * Mirror of MetricsCollector.estimatePassthroughTokens().
 */
export function computePassthroughTokens(toolCalls: number, dataBytes: number): number {
  const overhead = toolCalls * TOOL_CALL_OVERHEAD_TOKENS;
  const dataTokens = (dataBytes / 1024) * TOKENS_PER_KB;
  return Math.ceil(overhead + dataTokens);
}

/**
 * Estimate execution-mode tokens (code + compact result).
 * Uses the same char/token ratios as MetricsCollector.estimateCodeTokens()
 * and MetricsCollector.estimateJsonTokens().
 */
export function computeExecutionTokens(codeChars: number, resultJson: string): number {
  const codeTokens = Math.ceil(codeChars / CODE_CHARS_PER_TOKEN);
  const resultTokens = Math.ceil(resultJson.length / JSON_CHARS_PER_TOKEN);
  return codeTokens + resultTokens;
}

/**
 * Compute compression percentage given passthrough and execution token counts.
 */
export function computeCompression(passthroughTokens: number, executionTokens: number): number {
  if (passthroughTokens === 0) return 0;
  return ((passthroughTokens - executionTokens) / passthroughTokens) * 100;
}

/**
 * Compute all metrics for a scenario fixture.
 */
export function computeScenarioMetrics(scenario: ScenarioFixture): ScenarioMetrics {
  const passthroughTokens = computePassthroughTokens(scenario.toolCalls, scenario.dataBytes);
  const executionTokens = computeExecutionTokens(scenario.codeChars, scenario.resultJson);
  const tokensSaved = Math.max(0, passthroughTokens - executionTokens);
  const compressionPct = computeCompression(passthroughTokens, executionTokens);
  const sonnetSavingsUsd = (tokensSaved / 1_000_000) * PRICING.sonnetInput;
  return { passthroughTokens, executionTokens, tokensSaved, compressionPct, sonnetSavingsUsd };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

export const SCALE_FIXTURES: ScaleFixture[] = [
  // ── SMALL ─────────────────────────────────────────────────────────────────
  {
    scale: 'small',
    label: 'Small (Solo Dev)',
    description: 'Solo developer, occasional MCP use. 1–5 tool calls, 5–15 KB total data.',
    toolCallRange: [1, 5],
    dataSizeKbRange: [5, 15],
    scenarios: [
      {
        name: 'github-issues-fetch',
        description: 'Fetch 5 open GitHub issues with labels and assignees via GitHub MCP',
        toolCalls: 1,
        // 5 GitHub issue objects × ~700 bytes each (id, title, body excerpt, labels, assignees, state, url)
        dataBytes: 3500,
        codeChars: 180,
        resultJson: JSON.stringify({
          total: 5,
          openCount: 4,
          closedCount: 1,
          issues: [
            { id: 1, title: 'Fix login timeout', label: 'bug', priority: 'high' },
            { id: 2, title: 'Add dark mode', label: 'feature', priority: 'medium' },
            { id: 3, title: 'Update API docs', label: 'docs', priority: 'low' },
          ],
          summary: '4 open issues — 1 critical bug needs immediate attention',
        }),
        servers: ['github'],
      },
      {
        name: 'filesystem-dir-listing',
        description: 'List and categorise 30 files in a TypeScript project root',
        toolCalls: 1,
        // 30 file entries × ~150 bytes each (name, size, mtime, type)
        dataBytes: 4500,
        codeChars: 150,
        resultJson: JSON.stringify({
          totalFiles: 30,
          directories: 8,
          files: 22,
          byType: { ts: 15, json: 4, md: 3 },
          largestFile: 'src/index.ts (8.2 KB)',
          summary: '22 source files across 8 directories',
        }),
        servers: ['filesystem'],
      },
      {
        name: 'brave-search-single',
        description: 'Single Brave web search — top 5 results for a technical query',
        toolCalls: 1,
        // 5 search result objects × ~500 bytes each (title, url, snippet, date)
        dataBytes: 2500,
        codeChars: 160,
        resultJson: JSON.stringify({
          query: 'MCP server best practices 2025',
          topResult: 'Model Context Protocol Documentation',
          topUrl: 'https://modelcontextprotocol.io/docs',
          resultCount: 5,
          summary: 'Top result is the official MCP docs site',
        }),
        servers: ['brave-search'],
      },
    ],
  },

  // ── MEDIUM ────────────────────────────────────────────────────────────────
  {
    scale: 'medium',
    label: 'Medium (Active Team)',
    description: 'Active dev team, daily use. 5–25 tool calls, 15–100 KB total data.',
    toolCallRange: [5, 25],
    dataSizeKbRange: [15, 100],
    scenarios: [
      {
        name: 'sprint-dashboard',
        description: 'Pull sprint dashboard: 25 issues + 8 open PRs + CI status in one execution',
        toolCalls: 3,
        // 25 issues (~500B each) + 8 PRs (~700B each) + CI payload (~2 KB) = ~18 KB
        dataBytes: 18_000,
        codeChars: 450,
        resultJson: JSON.stringify({
          sprint: 'Sprint 23',
          velocity: 34,
          burndown: { remaining: 21, completed: 13 },
          blockedIssues: 3,
          openPRs: 8,
          ciPassRate: '94%',
          topPriority: 'AUTH-445: Session timeout bug',
          recommendation: '3 blocked items need team attention today',
        }),
        servers: ['github'],
      },
      {
        name: 'codebase-scan',
        description: 'Scan 200-file codebase for TODO comments, complexity, and debt metrics',
        toolCalls: 8,
        // 200 file metadata records + content samples = ~42 KB
        dataBytes: 42_000,
        codeChars: 620,
        resultJson: JSON.stringify({
          filesScanned: 200,
          todosFound: 47,
          highComplexity: 12,
          avgFileSizeKb: 3.2,
          largestFiles: ['src/executor.ts', 'src/sandbox/runtime.ts'],
          debtScore: 'B (moderate)',
          criticalIssues: ['4 files exceed complexity threshold of 20'],
        }),
        servers: ['filesystem'],
      },
      {
        name: 'parallel-web-research',
        description: '3 parallel Brave searches for competitive analysis, results synthesised',
        toolCalls: 3,
        // 3 × 5 results × ~567 bytes per result = ~8.5 KB
        dataBytes: 8_500,
        codeChars: 380,
        resultJson: JSON.stringify({
          topic: 'MCP competitive landscape Q1 2026',
          sources: 3,
          keyFindings: [
            'LangChain adding native MCP support in v0.3',
            'OpenAI function calling overlaps ~40% of use cases',
            'MCP adoption up 3× in last quarter',
          ],
          sentiment: 'positive',
          actionItem: 'Differentiate on sandbox isolation and token savings',
        }),
        servers: ['brave-search'],
      },
    ],
  },

  // ── LARGE ─────────────────────────────────────────────────────────────────
  {
    scale: 'large',
    label: 'Large (Engineering Org)',
    description: 'Engineering org, automated workflows. 25–100 tool calls, 100–500 KB total data.',
    toolCallRange: [25, 100],
    dataSizeKbRange: [100, 500],
    scenarios: [
      {
        name: 'issue-triage-filetree',
        description: '100-issue triage with full file tree and circular-dependency check',
        toolCalls: 12,
        // 100 issues × ~768B + full file tree 500 entries × ~224B = ~188 KB → rounded
        dataBytes: 112_000,
        codeChars: 950,
        resultJson: JSON.stringify({
          issuesTriaged: 100,
          criticalBugs: 7,
          securityIssues: 2,
          featureRequests: 31,
          backlogHealth: 'B+',
          staleIssues: 23,
          suggestedPriorities: ['SEC-112', 'BUG-089', 'BUG-091'],
          fileTreeDepth: 6,
          orphanedModules: 4,
          circularDependencies: 1,
        }),
        servers: ['github', 'filesystem'],
      },
      {
        name: 'multi-repo-analysis',
        description: 'Cross-repo dependency analysis across 5 microservices with version conflict detection',
        toolCalls: 25,
        // 5 repos × (manifest + lockfile + 30-day history) = ~148 KB
        dataBytes: 148_000,
        codeChars: 1_200,
        resultJson: JSON.stringify({
          reposAnalysed: 5,
          sharedDependencies: 34,
          versionConflicts: 8,
          outdatedPackages: 67,
          securityAdvisories: 3,
          breakingChangesRisk: 'medium',
          recommendedUpgrades: ['zod@3.24', 'typescript@5.8', 'vitest@3.0'],
          estimatedUpgradeEffort: '2.5 developer-days',
        }),
        servers: ['github', 'filesystem'],
      },
      {
        name: 'parallel-search-github',
        description: '10 parallel web searches combined with 12 GitHub API calls for market intelligence',
        toolCalls: 22,
        // 10 searches × 5 results × ~420B + 12 API responses × ~3.5 KB = ~63 KB total
        dataBytes: 89_600,
        codeChars: 880,
        resultJson: JSON.stringify({
          queriesRun: 10,
          githubCallsRun: 12,
          topInsights: 5,
          marketSignals: [
            'Growing enterprise adoption of MCP',
            'Security concerns dominate discussion',
            'Python SDK most popular for server authoring',
          ],
          competitorMoves: 3,
          trend: 'MCP becoming standard for AI tool integration',
          actionableItems: 8,
        }),
        servers: ['brave-search', 'github'],
      },
    ],
  },

  // ── ENTERPRISE ────────────────────────────────────────────────────────────
  {
    scale: 'enterprise',
    label: 'Enterprise (CI/CD Automation)',
    description: 'CI/CD automation, high volume. 100+ tool calls, 500 KB–2 MB total data.',
    toolCallRange: [100, 500],
    dataSizeKbRange: [500, 2048],
    scenarios: [
      {
        name: 'backlog-scan-500',
        description: '500-issue backlog scan with full metadata, labels, cross-references, and forecasting',
        toolCalls: 52,
        // 500 issues × ~768 bytes each (full metadata) = ~384 KB
        dataBytes: 384_000,
        codeChars: 2_100,
        resultJson: JSON.stringify({
          issuesProcessed: 500,
          categorised: { bugs: 187, features: 203, chores: 110 },
          criticalPath: ['AUTH-445', 'PERF-201', 'SEC-118'],
          staleness: { over90Days: 143, over180Days: 67 },
          estimatedVelocity: '34 points/sprint',
          quarterlyForecast: 'Q2 delivery at 78% confidence',
          riskFactors: [
            '3 key engineers on leave in March',
            'External API dependency not yet GA',
          ],
        }),
        servers: ['github'],
      },
      {
        name: 'dependency-audit-monorepo',
        description: 'Full dependency audit: 8 packages, lockfile analysis, CVE scan, licence check',
        toolCalls: 64,
        // 8 lockfiles (~40 KB each) + CVE database queries + manifests = ~562 KB
        dataBytes: 562_000,
        codeChars: 2_800,
        resultJson: JSON.stringify({
          packagesAudited: 8,
          totalDependencies: 1_847,
          directDependencies: 124,
          vulnerabilities: { critical: 0, high: 3, medium: 12, low: 28 },
          outdatedPackages: 89,
          licenceIssues: 2,
          bundleSizeImpact: '+12 KB if all updates applied',
          recommendedActions: [
            'Patch CVE-2024-4889 in axios@1.6.x immediately',
            'Defer lodash update — breaking changes in v5',
          ],
          estimatedRemediationHours: 8,
        }),
        servers: ['filesystem', 'github'],
      },
      {
        name: 'daily-digest-5-repos',
        description: 'Automated daily digest across 5 repos: commits, PRs, builds, alerts, coverage',
        toolCalls: 85,
        // 5 repos × 1-day activity logs (~160 KB each) = ~800 KB
        dataBytes: 819_200,
        codeChars: 3_500,
        resultJson: JSON.stringify({
          reposMonitored: 5,
          commitsToday: 47,
          prsOpened: 12,
          prsMerged: 8,
          buildsRun: 156,
          buildSuccessRate: '96.2%',
          coverageTrend: '+0.3% vs yesterday',
          alertsTriggered: 2,
          topContributor: 'alex@example.dev (12 commits)',
          summary:
            '47 commits across 5 repos. 2 alerts need attention: staging deployment delay and test flakiness in repo-3.',
        }),
        servers: ['github', 'filesystem', 'brave-search'],
      },
    ],
  },
];
