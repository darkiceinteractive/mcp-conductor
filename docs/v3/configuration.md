# MCP Conductor v3 Configuration Reference

All configuration lives in `~/.mcp-conductor.json`.

## Top-level Structure

```json
{
  "servers": { ... },
  "reliability": { ... },
  "cache": { ... },
  "runtime": { ... },
  "skills": { ... },
  "findTool": { ... },
  "daemon": { ... },
  "observability": { ... }
}
```

## `servers`

```json
{
  "servers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": { "API_KEY": "..." },
      "routing": "execute_code",
      "redact": {
        "response": ["email", "phone"]
      }
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | required | Server executable |
| `args` | string[] | `[]` | Command arguments |
| `env` | object | `{}` | Environment variables |
| `routing` | `"execute_code"` \| `"passthrough"` | `"execute_code"` | Tool routing mode |
| `redact.response` | string[] | `[]` | PII matchers applied to responses |

### Built-in PII Matchers
`email`, `phone`, `credit_card`, `ssn`, `ip_address`, `date_of_birth`

## `reliability`

```json
{
  "reliability": {
    "timeoutMs": 10000,
    "retries": 3,
    "retryDelayMs": 100,
    "retryMaxDelayMs": 5000,
    "circuitBreakerThreshold": 0.5,
    "circuitBreakerWindowMs": 60000,
    "circuitBreakerMinCalls": 10,
    "halfOpenProbeIntervalMs": 30000
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `timeoutMs` | 10000 | Per-call timeout in ms |
| `retries` | 3 | Retry attempts after initial failure |
| `retryDelayMs` | 100 | Initial retry delay (exponential backoff) |
| `retryMaxDelayMs` | 5000 | Maximum retry delay ceiling |
| `circuitBreakerThreshold` | 0.5 | Failure rate to open circuit (0–1) |
| `circuitBreakerWindowMs` | 60000 | Rolling window for circuit breaker |
| `circuitBreakerMinCalls` | 10 | Minimum calls before circuit can open |
| `halfOpenProbeIntervalMs` | 30000 | Time before circuit moves to HALF_OPEN |

## `cache`

```json
{
  "cache": {
    "maxItems": 1000,
    "ttlMs": 300000,
    "diskPath": "~/.mcp-conductor-cache",
    "diskEnabled": false
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `maxItems` | 1000 | LRU cache maximum entries |
| `ttlMs` | 300000 | Cache TTL in ms (5 minutes) |
| `diskPath` | `~/.mcp-conductor-cache` | CBOR disk cache directory |
| `diskEnabled` | false | Enable persistent disk cache |

## `runtime`

```json
{
  "runtime": {
    "maxConcurrent": 8,
    "sandboxPoolSize": 2,
    "connectionPoolSize": 2
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `maxConcurrent` | 8 | Max concurrent executions |
| `sandboxPoolSize` | 2 | Pre-warmed sandbox processes |
| `connectionPoolSize` | 2 | Ready connections per MCP server |

## `skills`

```json
{
  "skills": {
    "enabled": true,
    "directory": "~/.mcp-conductor/skills",
    "defaultTimeout": 30000
  }
}
```

## `findTool`

```json
{
  "findTool": {
    "enabled": true,
    "fuzzyThreshold": 0.6
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | true | Enable `mcp.findTool()` in sandbox |
| `fuzzyThreshold` | 0.6 | Similarity threshold (0–1) |

## `daemon`

```json
{
  "daemon": {
    "enabled": false,
    "kvPath": "~/.mcp-conductor-kv.json",
    "lockTimeoutMs": 5000
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | false | Enable daemon mode |
| `kvPath` | `~/.mcp-conductor-kv.json` | Shared KV store path |
| `lockTimeoutMs` | 5000 | Distributed lock timeout |

## `observability`

```json
{
  "observability": {
    "enabled": true,
    "costPredictor": true,
    "hotPath": true,
    "anomalyDetector": true,
    "replay": {
      "enabled": false,
      "directory": "~/.mcp-conductor-replays"
    }
  }
}
```
