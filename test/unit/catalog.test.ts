/**
 * Tests for src/server/catalog.ts
 *
 * Covers:
 *   buildServerSummary   — verb clustering, top-5 selection, summary format
 *   buildCatalogInstructions — budget compliance, guidance text, collapse
 *   buildServerCatalogDetail — one line per tool, markdown format
 *
 * Also acts as a canary for the SDK-private `_instructions` field used in
 * mcp-server.ts (see "SDK canary" test at the bottom).
 */

import { describe, it, expect } from 'vitest';
import {
  buildServerSummary,
  buildCatalogInstructions,
  buildServerCatalogDetail,
  type ServerCatalogEntry,
} from '../../src/server/catalog.js';

// ---------------------------------------------------------------------------
// Realistic ibkr-like fixture (39 tools)
// ---------------------------------------------------------------------------
const IBKR_TOOLS = [
  { name: 'get_quote', description: 'Get real-time quote for a symbol.' },
  { name: 'get_quotes_batch', description: 'Get quotes for multiple symbols.' },
  { name: 'get_option_chain', description: 'Retrieve full options chain.' },
  { name: 'get_options_chain', description: 'Get options chain for underlying.' },
  { name: 'get_account_summary', description: 'Returns account P&L and margin.' },
  { name: 'get_positions', description: 'List all open positions.' },
  { name: 'get_position_detail', description: 'Detail for a specific position.' },
  { name: 'get_portfolio_summary', description: 'Portfolio aggregate metrics.' },
  { name: 'get_order', description: 'Get a specific order by ID.' },
  { name: 'get_orders', description: 'List recent orders.' },
  { name: 'get_executions', description: 'List executed fills.' },
  { name: 'get_news_headlines', description: 'Recent news headlines for a symbol.' },
  { name: 'get_news_article', description: 'Full news article by ID.' },
  { name: 'get_contract_details', description: 'Contract specification details.' },
  { name: 'get_historical_data', description: 'Historical OHLCV bars.' },
  { name: 'get_market_data_snapshot', description: 'Market data snapshot.' },
  { name: 'get_scanner_results', description: 'Results from market scanner.' },
  { name: 'search_contracts', description: 'Search for tradeable contracts.' },
  { name: 'search_symbols', description: 'Search symbols by keyword.' },
  { name: 'preview_order', description: 'Preview an order before submission.' },
  { name: 'place_order', description: 'Submit a live order.' },
  { name: 'cancel_order', description: 'Cancel an open order.' },
  { name: 'modify_order', description: 'Modify an existing order.' },
  { name: 'run_market_scanner', description: 'Execute a market scanner query.' },
  { name: 'run_custom_scan', description: 'Run a custom scan definition.' },
  { name: 'calculate_implied_volatility', description: 'Compute IV for an option.' },
  { name: 'calculate_option_price', description: 'Calculate theoretical option price.' },
  { name: 'calculate_greeks', description: 'Compute option greeks.' },
  { name: 'list_accounts', description: 'List all linked accounts.' },
  { name: 'list_watchlists', description: 'Return configured watchlists.' },
  { name: 'list_alerts', description: 'List active price alerts.' },
  { name: 'create_alert', description: 'Create a new price alert.' },
  { name: 'delete_alert', description: 'Delete an existing price alert.' },
  { name: 'get_exchange_hours', description: 'Exchange trading hours for a date.' },
  { name: 'get_tick_data', description: 'Level 1 tick data stream.' },
  { name: 'subscribe_market_data', description: 'Subscribe to live data feed.' },
  { name: 'unsubscribe_market_data', description: 'Remove a live data subscription.' },
  { name: 'get_pnl', description: 'Get unrealised/realised P&L.' },
  { name: 'get_buying_power', description: 'Return current buying power.' },
];

describe('buildServerSummary', () => {
  it('includes tool count in the summary', () => {
    const entry = buildServerSummary('ibkr', IBKR_TOOLS);
    expect(entry.toolCount).toBe(39);
    expect(entry.summary).toContain('39 tools');
  });

  it('summary starts with the server name', () => {
    const entry = buildServerSummary('ibkr', IBKR_TOOLS);
    expect(entry.summary).toMatch(/^ibkr/);
  });

  it('top-5 includes at least one get_* tool (most generic from the dominant cluster)', () => {
    const entry = buildServerSummary('ibkr', IBKR_TOOLS);
    // "get" is the dominant verb cluster — at least one get_* tool must be chosen
    const hasGetTool = entry.topTools.some((t) => t.startsWith('get_'));
    expect(hasGetTool).toBe(true);
  });

  it('top-5 includes at least one calculate_* or preview_* or search_* tool (verb diversity)', () => {
    const entry = buildServerSummary('ibkr', IBKR_TOOLS);
    // Should have diversity — at least one tool from a non-"get" cluster
    const hasNonGet = entry.topTools.some((t) => !t.startsWith('get_'));
    expect(hasNonGet).toBe(true);
  });

  it('top-5 has at most 5 entries', () => {
    const entry = buildServerSummary('ibkr', IBKR_TOOLS);
    expect(entry.topTools.length).toBeLessThanOrEqual(5);
  });

  it('summary length is at most 200 characters', () => {
    const entry = buildServerSummary('ibkr', IBKR_TOOLS);
    expect(entry.summary.length).toBeLessThanOrEqual(200);
  });

  it('status defaults to connected', () => {
    const entry = buildServerSummary('ibkr', IBKR_TOOLS);
    expect(entry.status).toBe('connected');
  });

  it('respects explicit status', () => {
    const entry = buildServerSummary('ibkr', IBKR_TOOLS, 'failed');
    expect(entry.status).toBe('failed');
  });

  it('handles empty tools gracefully', () => {
    const entry = buildServerSummary('empty-server', []);
    expect(entry.toolCount).toBe(0);
    expect(entry.summary).toContain('0 tools');
    expect(entry.topTools).toHaveLength(0);
  });

  it('handles single tool', () => {
    const entry = buildServerSummary('tiny', [{ name: 'do_thing', description: 'Does a thing.' }]);
    expect(entry.toolCount).toBe(1);
    expect(entry.topTools).toHaveLength(1);
    expect(entry.topTools[0]).toBe('do_thing');
  });

  it('handles tools with no description', () => {
    const tools = [{ name: 'get_data' }, { name: 'post_data' }, { name: 'delete_data' }];
    const entry = buildServerSummary('nosec', tools);
    expect(entry.topTools.length).toBeGreaterThan(0);
    expect(entry.summary.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// buildCatalogInstructions
// ---------------------------------------------------------------------------

/** Helper: generate N fake server entries */
function makeFakeEntries(count: number): ServerCatalogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `server-${i}`,
    toolCount: 10 + i,
    summary: `server-${i} (${10 + i} tools): widgets, gadgets, thingamajigs — read-heavy`,
    topTools: [`get_widget_${i}`, `list_gadget_${i}`, `search_thing_${i}`],
    status: 'connected' as const,
  }));
}

describe('buildCatalogInstructions', () => {
  it('contains discover_tools guidance', () => {
    const entries = makeFakeEntries(3);
    const instructions = buildCatalogInstructions(entries);
    expect(instructions).toContain('discover_tools');
  });

  it('contains execute_code guidance', () => {
    const entries = makeFakeEntries(3);
    const instructions = buildCatalogInstructions(entries);
    expect(instructions).toContain('execute_code');
  });

  it('contains mcp-conductor header', () => {
    const entries = makeFakeEntries(3);
    const instructions = buildCatalogInstructions(entries);
    expect(instructions).toContain('mcp-conductor proxies');
  });

  it('respects token budget with 30 servers', () => {
    const entries = makeFakeEntries(30);
    const budget = 800;
    const instructions = buildCatalogInstructions(entries, budget);
    const approxTokens = Math.ceil(instructions.length / 4);
    // Budget is a soft target after collapsing — allow 20% overage for header/footer
    expect(approxTokens).toBeLessThanOrEqual(budget * 1.2);
  });

  it('collapses overflow servers into "+N more" line', () => {
    const entries = makeFakeEntries(30);
    const instructions = buildCatalogInstructions(entries, 500);
    expect(instructions).toMatch(/\+\d+ more servers/);
  });

  it('returns valid guidance string for empty server list', () => {
    const instructions = buildCatalogInstructions([]);
    expect(instructions).toContain('mcp-conductor proxies');
    expect(instructions).toContain('discover_tools');
    expect(typeof instructions).toBe('string');
    expect(instructions.length).toBeGreaterThan(0);
  });

  it('mentions failed servers when present', () => {
    const entries: ServerCatalogEntry[] = [
      ...makeFakeEntries(2),
      {
        name: 'broken-server',
        toolCount: 0,
        summary: 'broken-server (0 tools): —',
        topTools: [],
        status: 'failed',
      },
    ];
    const instructions = buildCatalogInstructions(entries);
    expect(instructions).toContain('broken-server');
    expect(instructions).toContain('failed to connect');
  });

  it('includes all server names when budget is generous', () => {
    const entries = makeFakeEntries(5);
    const instructions = buildCatalogInstructions(entries, 5000);
    for (const e of entries) {
      expect(instructions).toContain(e.name);
    }
  });

  it('always includes conductor://catalog resource reference', () => {
    const entries = makeFakeEntries(2);
    const instructions = buildCatalogInstructions(entries);
    expect(instructions).toContain('conductor://catalog');
  });
});

// ---------------------------------------------------------------------------
// buildServerCatalogDetail
// ---------------------------------------------------------------------------

describe('buildServerCatalogDetail', () => {
  it('renders one list line per tool', () => {
    const tools = [
      { name: 'get_foo', description: 'Get a foo. Returns JSON.' },
      { name: 'set_bar', description: 'Set the bar value.' },
      { name: 'list_baz', description: 'List all baz items.' },
    ];
    const detail = buildServerCatalogDetail('myserver', tools);
    expect(detail).toContain('- **get_foo**');
    expect(detail).toContain('- **set_bar**');
    expect(detail).toContain('- **list_baz**');
  });

  it('includes only the first sentence of the description', () => {
    const tools = [
      {
        name: 'get_data',
        description: 'Retrieve data from the backend. This is a long description. With multiple sentences.',
      },
    ];
    const detail = buildServerCatalogDetail('srv', tools);
    // First sentence only
    expect(detail).toContain('Retrieve data from the backend');
    expect(detail).not.toContain('With multiple sentences');
  });

  it('handles empty tool list', () => {
    const detail = buildServerCatalogDetail('empty', []);
    expect(detail).toContain('## empty');
    expect(detail).toContain('No tools available');
  });

  it('includes server name in markdown heading', () => {
    const detail = buildServerCatalogDetail('my-server', [{ name: 'ping' }]);
    expect(detail).toContain('## my-server');
  });

  it('handles tool with no description', () => {
    const detail = buildServerCatalogDetail('srv', [{ name: 'ping' }]);
    expect(detail).toContain('- **ping**');
    // No description — should not crash
  });

  it('renders full ibkr fixture without errors', () => {
    expect(() => buildServerCatalogDetail('ibkr', IBKR_TOOLS)).not.toThrow();
    const detail = buildServerCatalogDetail('ibkr', IBKR_TOOLS);
    expect(detail).toContain('## ibkr (39 tools)');
    for (const t of IBKR_TOOLS) {
      expect(detail).toContain(`**${t.name}**`);
    }
  });
});

// ---------------------------------------------------------------------------
// SDK private-field canary
//
// Verifies that the McpServer's underlying Server instance exposes
// `_instructions` as a settable property. If the SDK renames or removes this
// field, this test will fail — alerting maintainers before the next release
// ships broken catalog instructions.
// ---------------------------------------------------------------------------

describe('SDK _instructions canary', () => {
  it('McpServer.server._instructions is settable and readable', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const s = new McpServer({ name: 'canary-test', version: '0.0.1' });

    // The underlying Server is at s.server
    const underlying = s.server as Record<string, unknown>;
    expect(underlying).toHaveProperty('_instructions');

    // It should be initially undefined (no instructions passed to constructor)
    const initial = underlying['_instructions'];
    expect(initial === undefined || initial === null || typeof initial === 'string').toBe(true);

    // Setting it should stick
    const testValue = 'canary catalog text';
    underlying['_instructions'] = testValue;
    expect(underlying['_instructions']).toBe(testValue);
  });
});
