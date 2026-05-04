import { describe, it, expect, beforeEach } from 'vitest';
import { findTool, seedIndex, resetFindTool, registerToolLoader, reindex } from '../../../../src/runtime/findtool/index.js';

describe('findTool', () => {
  beforeEach(() => { resetFindTool(); });

  const tools = [
    { server: 'github', tool: 'list_issues', description: 'List GitHub issues for a repository' },
    { server: 'github', tool: 'create_issue', description: 'Create a new GitHub issue' },
    { server: 'github', tool: 'get_pull_request', description: 'Get a pull request by number' },
    { server: 'github', tool: 'merge_pull_request', description: 'Merge a pull request' },
    { server: 'github', tool: 'list_commits', description: 'List commits in a repository' },
    { server: 'slack', tool: 'send_message', description: 'Send a message to a Slack channel' },
    { server: 'slack', tool: 'list_channels', description: 'List available Slack channels' },
  ];

  it('relevant tool returns in top 3 for typical query', async () => {
    seedIndex(tools);
    const results = await findTool('list github issues', { topK: 3 });
    expect(results).toHaveLength(3);
    const names = results.map(r => r.tool);
    expect(names).toContain('list_issues');
  });

  it('serverFilter restricts results', async () => {
    seedIndex(tools);
    const results = await findTool('send message channel', { topK: 5, serverFilter: ['slack'] });
    expect(results.every(r => r.server === 'slack')).toBe(true);
  });

  it('re-embeds on registry update via reindex', async () => {
    const dynamicTools = [...tools];
    registerToolLoader(async () => dynamicTools);
    await reindex();
    const before = await findTool('list issues', { topK: 3 });
    expect(before.map(r => r.tool)).toContain('list_issues');

    // Add a new tool and reindex
    dynamicTools.push({ server: 'jira', tool: 'list_jira_issues', description: 'List Jira project issues and tickets' });
    await reindex();
    const after = await findTool('list jira issues', { topK: 3 });
    expect(after.map(r => r.tool)).toContain('list_jira_issues');
  });

  it('returns results with required fields', async () => {
    seedIndex(tools);
    const results = await findTool('issues', { topK: 1 });
    expect(results[0]).toHaveProperty('server');
    expect(results[0]).toHaveProperty('tool');
    expect(results[0]).toHaveProperty('description');
    expect(results[0]).toHaveProperty('score');
  });

  it('topK defaults to 5', async () => {
    seedIndex(tools);
    const results = await findTool('anything');
    expect(results.length).toBeLessThanOrEqual(5);
  });
});
