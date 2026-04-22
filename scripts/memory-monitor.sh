#!/bin/bash
# Memory Monitor for MCP Conductor
# Logs RSS memory usage every 10 seconds for conductor, Deno, and child MCP servers.
# Usage: ./scripts/memory-monitor.sh [interval_seconds]

INTERVAL=${1:-10}

echo "timestamp,conductor_rss_mb,deno_rss_mb,children_rss_mb,total_rss_mb,conductor_pids,deno_pids,child_pids"

while true; do
    TS=$(date +%H:%M:%S)

    # Conductor process RSS
    COND_PIDS=$(pgrep -f "mcp-conductor" 2>/dev/null | head -5)
    COND_COUNT=$(echo "$COND_PIDS" | grep -c . 2>/dev/null || echo 0)
    COND_RSS=0
    if [ -n "$COND_PIDS" ]; then
        COND_RSS=$(ps -o rss= -p $(echo "$COND_PIDS" | tr '\n' ',') 2>/dev/null | awk '{sum+=$1}END{printf "%.1f", sum/1024}')
    fi

    # Deno process RSS
    DENO_PIDS=$(pgrep -f "deno run" 2>/dev/null | head -20)
    DENO_COUNT=$(echo "$DENO_PIDS" | grep -c . 2>/dev/null || echo 0)
    DENO_RSS=0
    if [ -n "$DENO_PIDS" ]; then
        DENO_RSS=$(ps -o rss= -p $(echo "$DENO_PIDS" | tr '\n' ',') 2>/dev/null | awk '{sum+=$1}END{printf "%.1f", sum/1024}')
    fi

    # Child MCP server processes RSS
    CHILD_PIDS=$(pgrep -f "server-filesystem|server-memory|context7|sequential-thinking|taskmaster|playwright|serena|brave-search|clickup" 2>/dev/null | head -30)
    CHILD_COUNT=$(echo "$CHILD_PIDS" | grep -c . 2>/dev/null || echo 0)
    CHILD_RSS=0
    if [ -n "$CHILD_PIDS" ]; then
        CHILD_RSS=$(ps -o rss= -p $(echo "$CHILD_PIDS" | tr '\n' ',') 2>/dev/null | awk '{sum+=$1}END{printf "%.1f", sum/1024}')
    fi

    # Total
    TOTAL=$(echo "$COND_RSS + $DENO_RSS + $CHILD_RSS" | bc 2>/dev/null || echo "0")

    echo "$TS,${COND_RSS:-0},${DENO_RSS:-0},${CHILD_RSS:-0},${TOTAL:-0},${COND_COUNT},${DENO_COUNT},${CHILD_COUNT}"

    sleep "$INTERVAL"
done
