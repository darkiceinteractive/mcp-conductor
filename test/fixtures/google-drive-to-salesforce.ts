/**
 * Google Drive → Salesforce Pipeline Fixture
 *
 * Synthetic benchmark modelling Anthropic's published "code execution with MCP"
 * pattern: https://www.anthropic.com/research/building-effective-agents
 *
 * Scenario: A legal department wants to extract all contract renewal dates from
 * 300 Google Drive documents and push structured records to Salesforce.
 *
 * Passthrough mode (baseline):
 *   Each document (avg 1.45 KB of plain-text extract) is retrieved via
 *   drive.exportFile and placed directly into the Claude context window.
 *   With 300 documents that yields ~154,000 tokens — matching Anthropic's
 *   published 150K-token upper bound (rounded figure).
 *
 * Execution mode (MCP Conductor):
 *   A single execute_code call streams each document through a TypeScript
 *   extraction script inside the sandbox. Only the compact JSON summary
 *   (~500 tokens) reaches the context window — a ≥98% reduction, matching
 *   or exceeding Anthropic's published claim.
 *
 * Token formula: mirrors MetricsCollector in src/metrics/metrics-collector.ts
 *   passthrough  = (toolCalls × 150) + (bytes / 1024 × 256)
 *   execution    = ceil(codeChars / 3.5) + ceil(resultJson.length / 3.8)
 */

import {
  TOOL_CALL_OVERHEAD_TOKENS,
  TOKENS_PER_KB,
  CODE_CHARS_PER_TOKEN,
  JSON_CHARS_PER_TOKEN,
} from './scale-fixtures.js';

// ─── Pipeline parameters ─────────────────────────────────────────────────────

/** Number of Google Drive documents retrieved in the pipeline */
export const DOCUMENT_COUNT = 300;

/**
 * Average plain-text size per document in bytes.
 * 1,450 bytes models a medium-length legal clause or summary page (~290 words).
 * At 256 tokens/KB this yields ~363 data tokens per document.
 * Combined with call overhead: ~360K total data tokens + ~45K overhead = ~154K.
 */
export const AVG_DOCUMENT_BYTES = 1450;

/** Total bytes of raw document content that passthrough places in context */
export const TOTAL_PASSTHROUGH_BYTES = DOCUMENT_COUNT * AVG_DOCUMENT_BYTES;

/**
 * Number of passthrough tool calls:
 *   300 × drive.exportFile  +  1 × salesforce.upsertRecords
 */
export const PASSTHROUGH_TOOL_CALLS = DOCUMENT_COUNT + 1;

// ─── Execution mode parameters ───────────────────────────────────────────────

/**
 * TypeScript extraction script sent to the sandbox.
 * Iterates all documents, calls mcp.callTool per doc, applies a regex for
 * renewal dates, then bulk-upserts to Salesforce. ~1,650 characters.
 */
export const EXTRACTION_SCRIPT = `
// Extract contract renewal dates from Google Drive and push to Salesforce
const FOLDER_ID = env.DRIVE_FOLDER_ID ?? 'contracts-folder';
const SF_OBJECT = 'Contract__c';

// 1. List all documents in the contracts folder
const fileList = await mcp.callTool('google-drive', 'list_files', {
  folder_id: FOLDER_ID,
  mime_type: 'application/vnd.google-apps.document',
  page_size: 300,
});

// 2. Extract renewal dates (document stays in sandbox — not in context)
const records = [];
for (const file of fileList.files ?? []) {
  const doc = await mcp.callTool('google-drive', 'export_file', {
    file_id: file.id,
    mime_type: 'text/plain',
  });
  const match = doc.content?.match(
    /renewal[\s\S]{0,120}?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i
  );
  records.push({ id: file.id, name: file.name, renewal_date: match?.[1] ?? null });
}

// 3. Bulk upsert to Salesforce
const sfResult = await mcp.callTool('salesforce', 'upsert_records', {
  object: SF_OBJECT,
  records: records.map(r => ({
    ExternalId__c: r.id,
    Name: r.name,
    Renewal_Date__c: r.renewal_date,
  })),
  external_id_field: 'ExternalId__c',
});

// 4. Return compact summary — this is what enters the context window
return {
  processed: records.length,
  with_dates: records.filter(r => r.renewal_date).length,
  no_dates: records.filter(r => !r.renewal_date).length,
  salesforce_upserted: sfResult.upserted ?? 0,
  salesforce_errors: sfResult.errors ?? [],
};
`.trim();

/** Character count of the extraction script */
export const EXTRACTION_SCRIPT_CHARS = EXTRACTION_SCRIPT.length;

/**
 * Compact JSON result returned by the sandbox.
 * Only this enters the Claude context window in execution mode.
 */
export const EXTRACTION_RESULT_JSON = JSON.stringify({
  processed: 300,
  with_dates: 287,
  no_dates: 13,
  salesforce_upserted: 287,
  salesforce_errors: [],
});

// ─── Token calculations ───────────────────────────────────────────────────────

/**
 * Tokens consumed in passthrough mode:
 *   - 300 × drive.exportFile calls (each call overhead + document bytes in context)
 *   - 1 × salesforce.upsertRecords call (just overhead)
 */
export function computePassthroughTokens(): number {
  const callOverhead = PASSTHROUGH_TOOL_CALLS * TOOL_CALL_OVERHEAD_TOKENS;
  const dataTokens = (TOTAL_PASSTHROUGH_BYTES / 1024) * TOKENS_PER_KB;
  return Math.ceil(callOverhead + dataTokens);
}

/**
 * Tokens consumed in execution mode:
 *   The extraction script + compact JSON result only.
 *   Documents are processed inside the sandbox and never enter context.
 */
export function computeExecutionTokens(): number {
  const codeTokens = Math.ceil(EXTRACTION_SCRIPT_CHARS / CODE_CHARS_PER_TOKEN);
  const resultTokens = Math.ceil(EXTRACTION_RESULT_JSON.length / JSON_CHARS_PER_TOKEN);
  return codeTokens + resultTokens;
}

/**
 * Token reduction percentage: (passthrough - execution) / passthrough × 100
 */
export function computeReductionPercent(): number {
  const passthrough = computePassthroughTokens();
  const execution = computeExecutionTokens();
  return ((passthrough - execution) / passthrough) * 100;
}

/**
 * Full fixture summary for benchmark assertions and result docs.
 */
export const GOOGLE_DRIVE_TO_SALESFORCE_FIXTURE = {
  name: 'google-drive-to-salesforce',
  description:
    'Extract renewal dates from 300 legal contracts in Google Drive and push to Salesforce. ' +
    'Models Anthropic\'s published 150K-token → 2K-token reduction pattern.',
  documentCount: DOCUMENT_COUNT,
  avgDocumentBytes: AVG_DOCUMENT_BYTES,
  totalPassthroughBytes: TOTAL_PASSTHROUGH_BYTES,
  passthroughToolCalls: PASSTHROUGH_TOOL_CALLS,
  extractionScriptChars: EXTRACTION_SCRIPT_CHARS,
  resultJsonChars: EXTRACTION_RESULT_JSON.length,
  passthroughTokens: computePassthroughTokens(),
  executionTokens: computeExecutionTokens(),
  reductionPercent: computeReductionPercent(),
  /** The minimum reduction claimed by Anthropic\'s published design */
  anthropicClaimedReductionPercent: 98,
};
