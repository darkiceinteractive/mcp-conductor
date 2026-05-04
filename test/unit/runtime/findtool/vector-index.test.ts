import { describe, it, expect } from 'vitest';
import { VectorIndex } from '../../../../src/runtime/findtool/vector-index.js';

describe('VectorIndex', () => {
  const githubTools = [
    { tool: 'list_issues', description: 'List GitHub issues for a repository' },
    { tool: 'create_issue', description: 'Create a new GitHub issue' },
    { tool: 'get_pull_request', description: 'Get a GitHub pull request by number' },
    { tool: 'merge_pull_request', description: 'Merge a GitHub pull request' },
    { tool: 'list_commits', description: 'List commits in a repository' },
  ];

  const slackTools = [
    { tool: 'send_message', description: 'Send a message to a Slack channel' },
    { tool: 'list_channels', description: 'List available Slack channels' },
  ];

  it('upserts tools and tracks size', () => {
    const idx = new VectorIndex();
    idx.upsertServer('github', githubTools);
    expect(idx.size).toBe(5);
    idx.upsertServer('slack', slackTools);
    expect(idx.size).toBe(7);
  });

  it('removes server entries', () => {
    const idx = new VectorIndex();
    idx.upsertServer('github', githubTools);
    idx.upsertServer('slack', slackTools);
    idx.removeServer('slack');
    expect(idx.size).toBe(5);
  });

  it('clears all entries', () => {
    const idx = new VectorIndex();
    idx.upsertServer('github', githubTools);
    idx.clear();
    expect(idx.size).toBe(0);
  });

  it('rebuild replaces all entries', () => {
    const idx = new VectorIndex();
    idx.upsertServer('github', githubTools);
    idx.rebuild([{ server: 'slack', tool: 'send_message', description: 'Send a message' }]);
    expect(idx.size).toBe(1);
  });

  it('relevant tool ranks in top 3 for typical query', () => {
    const idx = new VectorIndex();
    idx.upsertServer('github', githubTools);
    const results = idx.search('list github issues', 3);
    expect(results).toHaveLength(3);
    const toolNames = results.map(r => r.tool);
    expect(toolNames).toContain('list_issues');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('serverFilter restricts results', () => {
    const idx = new VectorIndex();
    idx.upsertServer('github', githubTools);
    idx.upsertServer('slack', slackTools);
    const results = idx.search('list messages channels', 5, ['slack']);
    expect(results.every(r => r.server === 'slack')).toBe(true);
  });

  it('returns empty array when index is empty', () => {
    const idx = new VectorIndex();
    expect(idx.search('anything')).toEqual([]);
  });

  it('results include server, tool, description, score fields', () => {
    const idx = new VectorIndex();
    idx.upsertServer('github', githubTools);
    const results = idx.search('issues', 1);
    expect(results[0]).toHaveProperty('server');
    expect(results[0]).toHaveProperty('tool');
    expect(results[0]).toHaveProperty('description');
    expect(results[0]).toHaveProperty('score');
  });
});
