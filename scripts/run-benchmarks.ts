#!/usr/bin/env tsx
/**
 * MCP Conductor Scale Benchmark Runner
 *
 * Runs the token-savings benchmark suite at all four usage scales and writes:
 *   docs/benchmarks/results-YYYY-MM-DD.json   — raw numbers
 *   docs/benchmarks/results-YYYY-MM-DD.md     — formatted markdown report
 *
 * Usage:
 *   npm run benchmark:scale
 *   # or directly:
 *   npx tsx scripts/run-benchmarks.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCALE_FIXTURES,
  computeScenarioMetrics,
  PRICING,
  type ScaleFixture,
  type ScenarioFixture,
  type ScenarioMetrics,
} from '../test/fixtures/scale-fixtures.ts';
import {
  WORKFLOW_FIXTURES,
  CLAUDE_DESKTOP_SESSIONS,
  computeSessionTokens,
  computeMonthlySavingsUsd,
  type WorkflowFixture,
  type ClaudeDesktopSessionFixture,
  type SessionTokens,
} from '../test/fixtures/workflow-fixtures.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'docs', 'benchmarks');

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkflowVariantResult {
  name: string;
  description: string;
  toolCalls: number;
  dataKb: number;
  passthroughTokens: number;
  executionTokens: number;
  tokensSaved: number;
  compressionPct: number;
  sonnetSavingsUsd: number;
}

interface WorkflowResult {
  category: string;
  label: string;
  quick: WorkflowVariantResult;
  deep: WorkflowVariantResult;
  avgCompressionPct: number;
  deepSonnetSavingsUsd: number;
}

interface SessionResult {
  profile: string;
  label: string;
  workflows: number;
  conversationTokens: number;
  passthroughWorkflowTokens: number;
  executionWorkflowTokens: number;
  totalPassthroughTokens: number;
  totalExecutionTokens: number;
  workflowCompressionPct: number;
  sessionsBeforeContextFullPassthrough: number;
  sessionsBeforeContextFullExecution: number;
  monthlySavingsUsd: number;
}

interface ScenarioResult {
  name: string;
  description: string;
  toolCalls: number;
  dataKb: number;
  passthroughTokens: number;
  executionTokens: number;
  tokensSaved: number;
  compressionPct: number;
  haikuSavingsUsd: number;
  sonnetSavingsUsd: number;
  opusSavingsUsd: number;
}

interface ScaleResult {
  scale: string;
  label: string;
  description: string;
  toolCallRange: [number, number];
  dataSizeKbRange: [number, number];
  scenarios: ScenarioResult[];
  summary: {
    avgCompressionPct: number;
    avgTokensSaved: number;
    totalTokensSaved: number;
    avgSonnetSavingsUsd: number;
  };
}

interface BenchmarkReport {
  generatedAt: string;
  methodology: string;
  formula: {
    passthroughTokens: string;
    executionTokens: string;
    compressionPct: string;
  };
  pricing: typeof PRICING;
  scales: ScaleResult[];
  overall: {
    avgCompressionPct: number;
    peakCompressionPct: number;
    minCompressionPct: number;
  };
}

// ─── Computation ──────────────────────────────────────────────────────────────

function sessionsBeforeContextFull(workflowTokens: number, contextWindow: number): number {
  if (workflowTokens <= 0) return Infinity;
  return Math.floor(contextWindow / workflowTokens);
}

function buildWorkflowVariantResult(scenario: ScenarioFixture): WorkflowVariantResult {
  const metrics: ScenarioMetrics = computeScenarioMetrics(scenario);
  return {
    name: scenario.name,
    description: scenario.description,
    toolCalls: scenario.toolCalls,
    dataKb: Math.round(scenario.dataBytes / 1024),
    passthroughTokens: metrics.passthroughTokens,
    executionTokens: metrics.executionTokens,
    tokensSaved: metrics.tokensSaved,
    compressionPct: parseFloat(metrics.compressionPct.toFixed(2)),
    sonnetSavingsUsd: parseFloat(metrics.sonnetSavingsUsd.toFixed(5)),
  };
}

function buildWorkflowResult(wf: WorkflowFixture): WorkflowResult {
  const quick = buildWorkflowVariantResult(wf.quick);
  const deep = buildWorkflowVariantResult(wf.deep);
  return {
    category: wf.category,
    label: wf.label,
    quick,
    deep,
    avgCompressionPct: parseFloat(((quick.compressionPct + deep.compressionPct) / 2).toFixed(2)),
    deepSonnetSavingsUsd: deep.sonnetSavingsUsd,
  };
}

function buildSessionResult(session: ClaudeDesktopSessionFixture): SessionResult {
  const tokens: SessionTokens = computeSessionTokens(session);
  const monthlySavingsUsd = computeMonthlySavingsUsd(session);
  return {
    profile: session.profile,
    label: session.label,
    workflows: session.workflowsRun.length,
    conversationTokens: tokens.conversationTokens,
    passthroughWorkflowTokens: tokens.passthroughWorkflowTokens,
    executionWorkflowTokens: tokens.executionWorkflowTokens,
    totalPassthroughTokens: tokens.totalPassthroughTokens,
    totalExecutionTokens: tokens.totalExecutionTokens,
    workflowCompressionPct: parseFloat(tokens.workflowCompressionPct.toFixed(2)),
    sessionsBeforeContextFullPassthrough: sessionsBeforeContextFull(
      tokens.passthroughWorkflowTokens,
      session.contextWindowSize
    ),
    sessionsBeforeContextFullExecution: sessionsBeforeContextFull(
      tokens.executionWorkflowTokens,
      session.contextWindowSize
    ),
    monthlySavingsUsd: parseFloat(monthlySavingsUsd.toFixed(2)),
  };
}

function buildScenarioResult(scenario: ScenarioFixture): ScenarioResult {
  const metrics: ScenarioMetrics = computeScenarioMetrics(scenario);
  return {
    name: scenario.name,
    description: scenario.description,
    toolCalls: scenario.toolCalls,
    dataKb: Math.round(scenario.dataBytes / 1024),
    passthroughTokens: metrics.passthroughTokens,
    executionTokens: metrics.executionTokens,
    tokensSaved: metrics.tokensSaved,
    compressionPct: parseFloat(metrics.compressionPct.toFixed(2)),
    haikuSavingsUsd: parseFloat(((metrics.tokensSaved / 1_000_000) * PRICING.haikuInput).toFixed(5)),
    sonnetSavingsUsd: parseFloat(metrics.sonnetSavingsUsd.toFixed(5)),
    opusSavingsUsd: parseFloat(((metrics.tokensSaved / 1_000_000) * PRICING.opusInput).toFixed(4)),
  };
}

function buildScaleResult(sf: ScaleFixture): ScaleResult {
  const scenarios = sf.scenarios.map(buildScenarioResult);
  const n = scenarios.length;
  const avgCompressionPct = parseFloat(
    (scenarios.reduce((s, r) => s + r.compressionPct, 0) / n).toFixed(2)
  );
  const totalTokensSaved = scenarios.reduce((s, r) => s + r.tokensSaved, 0);
  return {
    scale: sf.scale,
    label: sf.label,
    description: sf.description,
    toolCallRange: sf.toolCallRange,
    dataSizeKbRange: sf.dataSizeKbRange,
    scenarios,
    summary: {
      avgCompressionPct,
      avgTokensSaved: Math.round(totalTokensSaved / n),
      totalTokensSaved,
      avgSonnetSavingsUsd: parseFloat(
        (scenarios.reduce((s, r) => s + r.sonnetSavingsUsd, 0) / n).toFixed(4)
      ),
    },
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function pad(s: string | number, w: number, right = false): string {
  const str = String(s);
  return right ? str.padEnd(w) : str.padStart(w);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function printSummaryTable(scales: ScaleResult[]): void {
  const col = [22, 7, 8, 14, 13, 17];
  const header = [
    pad('Scale', col[0]!, true),
    pad('Calls', col[1]!),
    pad('Data', col[2]!),
    pad('Compression', col[3]!),
    pad('Tokens Saved', col[4]!),
    pad('Sonnet $/session', col[5]!),
  ].join('  ');
  const sep = col.map((w) => '─'.repeat(w)).join('  ');

  console.log('\n' + sep);
  console.log(header);
  console.log(sep);

  for (const scale of scales) {
    const { toolCallRange, dataSizeKbRange, summary } = scale;
    const calls = `${toolCallRange[0]}–${toolCallRange[1]}`;
    const data = `${dataSizeKbRange[0]}–${dataSizeKbRange[1]} KB`;
    console.log(
      [
        pad(scale.label, col[0]!, true),
        pad(calls, col[1]!),
        pad(data, col[2]!),
        pad(`${summary.avgCompressionPct.toFixed(1)}%`, col[3]!),
        pad(fmtTokens(summary.avgTokensSaved), col[4]!),
        pad(`$${summary.avgSonnetSavingsUsd.toFixed(3)}`, col[5]!),
      ].join('  ')
    );
  }
  console.log(sep + '\n');
}

// ─── Console tables ───────────────────────────────────────────────────────────

function printWorkflowTable(workflows: WorkflowResult[]): void {
  const col = [22, 8, 8, 16, 18, 16];
  const header = [
    pad('Workflow', col[0]!, true),
    pad('Quick', col[1]!),
    pad('Deep', col[2]!),
    pad('Avg Compression', col[3]!),
    pad('Tokens Saved (deep)', col[4]!),
    pad('Sonnet/session', col[5]!),
  ].join('  ');
  const sep = col.map((w) => '─'.repeat(w)).join('  ');

  console.log('\n' + sep);
  console.log(header);
  console.log(sep);

  for (const wf of workflows) {
    console.log(
      [
        pad(wf.label, col[0]!, true),
        pad(`${wf.quick.compressionPct.toFixed(1)}%`, col[1]!),
        pad(`${wf.deep.compressionPct.toFixed(1)}%`, col[2]!),
        pad(`${wf.avgCompressionPct.toFixed(1)}%`, col[3]!),
        pad(`~${fmtTokens(wf.deep.tokensSaved)}`, col[4]!),
        pad(`$${wf.deepSonnetSavingsUsd.toFixed(3)}`, col[5]!),
      ].join('  ')
    );
  }
  console.log(sep + '\n');
}

function printSessionTable(sessions: SessionResult[]): void {
  const col = [28, 13, 11, 13, 15, 16];
  const header = [
    pad('Session Profile', col[0]!, true),
    pad('Passthrough', col[1]!),
    pad('Execution', col[2]!),
    pad('Compression', col[3]!),
    pad('Sessions/200K', col[4]!),
    pad('Monthly Saving', col[5]!),
  ].join('  ');
  const sep = col.map((w) => '─'.repeat(w)).join('  ');

  console.log('\n' + sep);
  console.log(header);
  console.log(sep);

  for (const s of sessions) {
    const passCount =
      s.sessionsBeforeContextFullPassthrough === Infinity
        ? '∞'
        : String(s.sessionsBeforeContextFullPassthrough);
    const execCount =
      s.sessionsBeforeContextFullExecution === Infinity
        ? '∞'
        : String(s.sessionsBeforeContextFullExecution);
    console.log(
      [
        pad(s.label, col[0]!, true),
        pad(`~${fmtTokens(s.passthroughWorkflowTokens)}`, col[1]!),
        pad(`~${fmtTokens(s.executionWorkflowTokens)}`, col[2]!),
        pad(`${s.workflowCompressionPct.toFixed(1)}%`, col[3]!),
        pad(`${passCount}  →  ${execCount}`, col[4]!),
        pad(`~$${s.monthlySavingsUsd.toFixed(0)}/month`, col[5]!),
      ].join('  ')
    );
  }
  console.log(sep + '\n');
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

function buildWorkflowMarkdown(workflows: WorkflowResult[]): string {
  const lines: string[] = [];

  lines.push(`## Section 2 — Workflow Benchmarks\n`);
  lines.push(`_Compression across 7 developer workflow categories (quick + deep variants)._\n`);
  lines.push(
    `| Workflow | Quick | Deep | Avg Compression | Tokens Saved (deep) | Sonnet/session |`
  );
  lines.push(`|----------|-------|------|-----------------|--------------------:|---------------|`);
  for (const wf of workflows) {
    lines.push(
      `| ${wf.label} ` +
        `| ${wf.quick.compressionPct.toFixed(1)}% ` +
        `| ${wf.deep.compressionPct.toFixed(1)}% ` +
        `| **${wf.avgCompressionPct.toFixed(1)}%** ` +
        `| ~${fmtTokens(wf.deep.tokensSaved)} ` +
        `| $${wf.deepSonnetSavingsUsd.toFixed(3)} |`
    );
  }

  const allCompressions = workflows.flatMap((wf) => [
    wf.quick.compressionPct,
    wf.deep.compressionPct,
  ]);
  const overallAvg = allCompressions.reduce((a, b) => a + b, 0) / allCompressions.length;
  lines.push(
    `\n**Overall workflow average:** ${overallAvg.toFixed(1)}% compression across all 14 scenarios\n`
  );

  return lines.join('\n');
}

function buildSessionMarkdown(sessions: SessionResult[]): string {
  const lines: string[] = [];

  lines.push(`## Section 3 — Claude Desktop Context Window\n`);
  lines.push(
    `_Context-window usage and monthly savings across three daily-use profiles._  \n` +
      `_"Sessions/200K" = how many sessions worth of workflow data fit before the 200K context fills._\n`
  );
  lines.push(
    `| Session Profile | Passthrough | Execution | Compression | Sessions/200K | Monthly Saving |`
  );
  lines.push(
    `|-----------------|------------|-----------|-------------|:-------------:|----------------|`
  );
  for (const s of sessions) {
    const passCount =
      s.sessionsBeforeContextFullPassthrough === Infinity
        ? '∞'
        : String(s.sessionsBeforeContextFullPassthrough);
    const execCount =
      s.sessionsBeforeContextFullExecution === Infinity
        ? '∞'
        : String(s.sessionsBeforeContextFullExecution);
    lines.push(
      `| ${s.label} ` +
        `| ~${fmtTokens(s.passthroughWorkflowTokens)} ` +
        `| ~${fmtTokens(s.executionWorkflowTokens)} ` +
        `| **${s.workflowCompressionPct.toFixed(1)}%** ` +
        `| ${passCount}  →  ${execCount} ` +
        `| ~$${s.monthlySavingsUsd.toFixed(0)}/month |`
    );
  }
  lines.push('');

  return lines.join('\n');
}

function buildMarkdown(report: BenchmarkReport): string {
  const date = report.generatedAt.split('T')[0];
  const lines: string[] = [];

  lines.push(`# MCP Conductor Scale Benchmark Results`);
  lines.push(`\n**Generated:** ${report.generatedAt}  `);
  lines.push(`**Methodology:** See [docs/benchmarks/methodology.md](methodology.md)\n`);

  lines.push(`## Summary\n`);
  lines.push(
    `| Scale | Tool Calls | Data | Avg Compression | Avg Tokens Saved | Sonnet $/session |`
  );
  lines.push(`|-------|-----------|------|-----------------|-----------------|-----------------|`);
  for (const scale of report.scales) {
    const { toolCallRange, dataSizeKbRange, summary } = scale;
    lines.push(
      `| ${scale.label} | ${toolCallRange[0]}–${toolCallRange[1]} ` +
        `| ${dataSizeKbRange[0]}–${dataSizeKbRange[1]} KB ` +
        `| **${summary.avgCompressionPct.toFixed(1)}%** ` +
        `| ~${fmtTokens(summary.avgTokensSaved)} ` +
        `| ~\$${summary.avgSonnetSavingsUsd.toFixed(3)} |`
    );
  }

  lines.push(`\n**Overall:** avg ${report.overall.avgCompressionPct.toFixed(1)}% compression, ` +
    `range ${report.overall.minCompressionPct.toFixed(1)}%–${report.overall.peakCompressionPct.toFixed(1)}%\n`);

  lines.push(`## Scenario Detail\n`);
  for (const scale of report.scales) {
    lines.push(`### ${scale.label}\n`);
    lines.push(`_${scale.description}_\n`);
    lines.push(
      `| Scenario | Tool Calls | Data | Passthrough | Execution | Saved | Compression | Sonnet/session |`
    );
    lines.push(
      `|----------|-----------|------|------------|-----------|-------|-------------|---------------|`
    );
    for (const s of scale.scenarios) {
      lines.push(
        `| ${s.name} | ${s.toolCalls} | ${s.dataKb} KB ` +
          `| ${fmtTokens(s.passthroughTokens)} | ${fmtTokens(s.executionTokens)} ` +
          `| ${fmtTokens(s.tokensSaved)} | **${s.compressionPct.toFixed(1)}%** ` +
          `| $${s.sonnetSavingsUsd.toFixed(3)} |`
      );
    }
    lines.push('');
  }

  lines.push(`## Formula\n`);
  lines.push(`\`\`\`\n${report.formula.passthroughTokens}\n${report.formula.executionTokens}\n${report.formula.compressionPct}\n\`\`\`\n`);

  lines.push(`## Pricing Used\n`);
  lines.push(`| Model | Input $/M tokens |`);
  lines.push(`|-------|-----------------|`);
  lines.push(`| Claude Haiku 4.5 | $${PRICING.haikuInput.toFixed(2)} |`);
  lines.push(`| Claude Sonnet 4.6 | $${PRICING.sonnetInput.toFixed(2)} |`);
  lines.push(`| Claude Opus 4.6 | $${PRICING.opusInput.toFixed(2)} |`);

  return lines.join('\n');
}

function buildCombinedMarkdown(
  scaleMd: string,
  workflowMd: string,
  sessionMd: string
): string {
  return [scaleMd, workflowMd, sessionMd].join('\n\n---\n\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  // ── Section 1: Scale Benchmark ──────────────────────────────────────────
  console.log('MCP Conductor Benchmark Suite');
  console.log('==============================');
  console.log('\n## Section 1 — Scale Benchmark\n');

  const scales = SCALE_FIXTURES.map(buildScaleResult);

  const allScaleCompressions = scales.flatMap((s) => s.scenarios.map((sc) => sc.compressionPct));
  const overall = {
    avgCompressionPct: parseFloat(
      (allScaleCompressions.reduce((a, b) => a + b, 0) / allScaleCompressions.length).toFixed(2)
    ),
    peakCompressionPct: parseFloat(Math.max(...allScaleCompressions).toFixed(2)),
    minCompressionPct: parseFloat(Math.min(...allScaleCompressions).toFixed(2)),
  };

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    methodology:
      'Deterministic token-savings simulation using MetricsCollector formula. See docs/benchmarks/methodology.md.',
    formula: {
      passthroughTokens: 'passthroughTokens = (toolCalls × 150) + (dataBytes / 1024 × 256)',
      executionTokens: 'executionTokens   = ceil(codeChars / 3.5) + ceil(resultJson.length / 3.8)',
      compressionPct:
        'compressionPct    = (passthroughTokens − executionTokens) / passthroughTokens × 100',
    },
    pricing: PRICING,
    scales,
    overall,
  };

  printSummaryTable(scales);
  console.log(
    `Scale overall: avg ${overall.avgCompressionPct}% compression  |  range ${overall.minCompressionPct}%–${overall.peakCompressionPct}%`
  );

  // ── Section 2: Workflow Benchmark ───────────────────────────────────────
  console.log('\n## Section 2 — Workflow Benchmarks\n');

  const workflows = WORKFLOW_FIXTURES.map(buildWorkflowResult);
  printWorkflowTable(workflows);

  const allWorkflowCompressions = workflows.flatMap((wf) => [
    wf.quick.compressionPct,
    wf.deep.compressionPct,
  ]);
  const workflowOverallAvg =
    allWorkflowCompressions.reduce((a, b) => a + b, 0) / allWorkflowCompressions.length;
  console.log(`Workflow overall: avg ${workflowOverallAvg.toFixed(1)}% compression across all 14 scenarios`);

  // ── Section 3: Claude Desktop Context Window ────────────────────────────
  console.log('\n## Section 3 — Claude Desktop Context Window\n');

  const sessions = CLAUDE_DESKTOP_SESSIONS.map(buildSessionResult);
  printSessionTable(sessions);

  // ── Write output files ──────────────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });
  const datePart = new Date().toISOString().split('T')[0];

  const scaleMd = buildMarkdown(report);
  const workflowMd = buildWorkflowMarkdown(workflows);
  const sessionMd = buildSessionMarkdown(sessions);

  const combinedMd = buildCombinedMarkdown(scaleMd, workflowMd, sessionMd);
  const combinedJson = JSON.stringify(
    {
      ...report,
      workflows,
      sessions,
    },
    null,
    2
  );

  const mdPath = join(OUT_DIR, `workflow-results-${datePart}.md`);
  const jsonPath = join(OUT_DIR, `workflow-results-${datePart}.json`);

  writeFileSync(mdPath, combinedMd);
  writeFileSync(jsonPath, combinedJson);

  console.log(`\nResults written to:`);
  console.log(`  ${mdPath}`);
  console.log(`  ${jsonPath}`);
}

main();
