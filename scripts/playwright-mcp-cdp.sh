#!/usr/bin/env bash
# Wrapper that discovers the CDP WebSocket URL and launches Playwright MCP.
# Requires Chrome to already be running with --remote-debugging-port=9222.
# Used as the MCP server command in .mcp.json — no dynamic config needed.

set -euo pipefail

PORT="${CDP_PORT:-9222}"

# Fetch CDP version endpoint with a short timeout
CDP_JSON=$(curl -sf --connect-timeout 3 "http://127.0.0.1:${PORT}/json/version" 2>&1) || {
  echo "Failed to connect to Chrome on port ${PORT}." >&2
  echo "Start it first: ./scripts/launch-chrome-debug.sh" >&2
  exit 1
}

# Parse the WebSocket URL
WS_URL=$(echo "$CDP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['webSocketDebuggerUrl'])" 2>&1) || {
  # Fallback to jq
  WS_URL=$(echo "$CDP_JSON" | jq -r '.webSocketDebuggerUrl' 2>/dev/null) || {
    echo "Failed to parse webSocketDebuggerUrl from CDP response." >&2
    echo "Response was: ${CDP_JSON:0:200}" >&2
    exit 1
  }
}

if [ -z "$WS_URL" ] || [ "$WS_URL" = "null" ]; then
  echo "webSocketDebuggerUrl missing from CDP response." >&2
  exit 1
fi

exec npx @playwright/mcp@latest --cdp-endpoint "$WS_URL" "$@"
