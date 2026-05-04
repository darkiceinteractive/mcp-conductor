# MCP Conductor v3 Recipes

Practical `execute_code` examples showcasing v3 features.

## 1. Google Drive → Salesforce pipeline (Anthropic pattern)

Extract structured data from 300 documents with 99.72% token reduction:

```typescript
// execute_code
const files = await mcp.callTool('google-drive', 'list_files', {
  folder_id: env.DRIVE_FOLDER_ID,
  page_size: 300,
});

const records = [];
for (const file of files.files ?? []) {
  const doc = await mcp.callTool('google-drive', 'export_file', {
    file_id: file.id,
    mime_type: 'text/plain',
  });
  const match = doc.content?.match(/renewal.{0,120}?(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i);
  records.push({ id: file.id, name: file.name, renewal_date: match?.[1] ?? null });
}

return {
  processed: records.length,
  with_dates: records.filter(r => r.renewal_date).length,
};
// Result: 435 tokens in context vs 153,900 passthrough (99.72% reduction)
```

## 2. PII-safe customer data processing

Tokenise emails and phones before processing:

```typescript
// execute_code
const contacts = await mcp.callTool('crm', 'list_contacts', { limit: 100 });

const processed = [];
for (const contact of contacts.items) {
  const { tokenized, reverseMap } = await mcp.tokenize(
    JSON.stringify(contact),
    ['email', 'phone', 'credit_card']
  );

  const enriched = await mcp.callTool('enrichment', 'lookup', {
    data: JSON.parse(tokenized),
  });

  // Restore PII for the final record
  processed.push(JSON.parse(await mcp.detokenize(JSON.stringify(enriched), reverseMap)));
}

return { processed: processed.length };
```

## 3. Tool discovery + adaptive routing

Find the right tool at runtime:

```typescript
// execute_code
const tools = await mcp.findTool('send email notification', { limit: 3 });
const emailTool = tools[0]; // { server: 'gmail', tool: 'send_email', score: 0.94 }

if (!emailTool || emailTool.score < 0.7) {
  return { error: 'No suitable email tool found' };
}

await mcp.callTool(emailTool.server, emailTool.tool, {
  to: 'user@example.com',
  subject: 'Processing complete',
  body: 'Your batch job finished.',
});

return { sent: true, via: `${emailTool.server}/${emailTool.tool}` };
```

## 4. Budget-constrained summarisation

Process large data within a token budget:

```typescript
// execute_code
await mcp.budget(10_000); // max 10K tokens in output

const documents = await mcp.callTool('drive', 'list_files', { page_size: 50 });
const summaries = [];

for (const doc of documents.files ?? []) {
  const content = await mcp.callTool('drive', 'export_file', {
    file_id: doc.id,
    mime_type: 'text/plain',
  });

  // Summarise each doc to stay within budget
  const summary = await mcp.summarize(content.content ?? '', {
    maxTokens: 200,
    format: 'bullets',
  });

  summaries.push({ name: doc.name, summary });
}

return { summaries };
```

## 5. Multi-agent coordination (Daemon mode)

Coordinate multiple Claude instances via shared KV:

```typescript
// Instance 1: producer
await mcp.shared.set('batch:status', { phase: 'extracting', progress: 0 });
const release = await mcp.shared.lock('batch:lock');
try {
  // ... process documents
  await mcp.shared.set('batch:status', { phase: 'done', count: 287 });
} finally {
  release();
}
```

```typescript
// Instance 2: consumer — waits for producer
let status = await mcp.shared.get('batch:status');
while (status?.phase !== 'done') {
  await new Promise(r => setTimeout(r, 1000));
  status = await mcp.shared.get('batch:status');
}
return { message: `Batch done: ${status.count} records` };
```

## 6. Reliability-aware retry pattern

Handle transient failures gracefully:

```typescript
// execute_code
// The gateway handles retries automatically, but you can also implement
// application-level retry for business logic:
let attempts = 0;
let result;

while (attempts < 3) {
  try {
    result = await mcp.callTool('api', 'fetch_data', { id: env.RECORD_ID });
    break;
  } catch (err) {
    if (err.name === 'CircuitOpenError') {
      return { error: 'Service unavailable (circuit open)', retry_after_seconds: 30 };
    }
    if (err.name === 'MCPToolError' && err.code === 'not_found') {
      return { error: `Record ${env.RECORD_ID} not found` };
    }
    attempts++;
    if (attempts === 3) throw err;
    await new Promise(r => setTimeout(r, 1000 * attempts));
  }
}

return result;
```

## 7. Session replay for testing

Record a production session and replay with modifications:

Via MCP tools (outside execute_code):
```
// Record
record_session({ session_id: "test-001" })
// ... make calls
stop_recording({ session_id: "test-001" })

// Replay with a modified response at event 5
replay_session({
  recordingPath: "~/.mcp-conductor-replays/test-001.jsonl",
  modifications: [{ at: 5, op: "replace", with: { error: "timeout" } }]
})
```
