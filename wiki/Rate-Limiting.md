# Rate Limiting

MCP Conductor includes per-server rate limiting using a token bucket algorithm. This prevents overwhelming external APIs (like Brave Search) with too many concurrent requests.

## Configuration

Add a `rateLimit` block to any server in `~/.mcp-conductor.json`:

```json
{
  "servers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
      "env": { "BRAVE_API_KEY": "your-key" },
      "rateLimit": {
        "requestsPerSecond": 20,
        "burstSize": 20,
        "onLimitExceeded": "queue",
        "maxQueueTimeMs": 30000
      }
    }
  }
}
```

## Options

| Option | Type | Description |
|--------|------|-------------|
| `requestsPerSecond` | number | Sustained request rate (tokens refilled per second) |
| `burstSize` | number | Maximum burst capacity above the sustained rate |
| `onLimitExceeded` | string | `"queue"` to buffer requests, `"reject"` to fail immediately |
| `maxQueueTimeMs` | number | Maximum time a request waits in queue before rejection |

## Token Bucket Algorithm

The rate limiter uses a token bucket:

1. The bucket starts full with `burstSize` tokens
2. Each request consumes one token
3. Tokens are refilled at `requestsPerSecond` rate
4. If no tokens are available:
   - `"queue"` mode: request waits until a token is available (up to `maxQueueTimeMs`)
   - `"reject"` mode: request fails immediately with a rate limit error

## Behaviour Inside the Sandbox

When sandbox code uses `mcp.batch()` with many parallel calls to a rate-limited server, the rate limiter automatically queues excess calls:

```typescript
// 50 parallel searches — rate limiter queues excess
const results = await mcp.batch(
  queries.map(q => () => brave.call('brave_web_search', { q, count: 5 }))
);
```

The batch completes successfully; calls are just spread over time. Claude sees no errors.

## Detection from Sandbox Code

If a request is rejected (in `"reject"` mode), the sandbox receives an error that can be caught:

```typescript
try {
  const result = await brave.call('brave_web_search', { q: 'query' });
} catch (err) {
  if (err.message.includes('rate limit')) {
    // Wait and retry, or reduce batch size
  }
}
```

## Recommendations

| Server Type | Suggested Config |
|-------------|-----------------|
| Brave Search (free tier) | `requestsPerSecond: 1, burstSize: 5, onLimitExceeded: "queue"` |
| Brave Search (paid) | `requestsPerSecond: 20, burstSize: 20, onLimitExceeded: "queue"` |
| GitHub API | Usually not needed (high rate limits with PAT) |
| Filesystem | Not needed (local, no rate limits) |

## No Config = No Limiting

Servers without a `rateLimit` block have no rate limiting applied. All requests are passed through immediately.
