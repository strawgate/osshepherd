#!/usr/bin/env bash
# Wrapper that discovers the CDP WebSocket URL and launches Playwright MCP.
# Requires Chrome to already be running with --remote-debugging-port=9222.
# Used as the MCP server command in .mcp.json — no dynamic config needed.

set -euo pipefail

PORT="${CDP_PORT:-9222}"

WS_URL=$(curl -sf "http://127.0.0.1:${PORT}/json/version" | python3 -c "import sys,json; print(json.load(sys.stdin)['webSocketDebuggerUrl'])" 2>/dev/null || true)

if [ -z "$WS_URL" ]; then
  echo "Chrome is not running with --remote-debugging-port=${PORT}." >&2
  echo "Start it first: ./scripts/launch-chrome-debug.sh" >&2
  exit 1
fi

exec npx @playwright/mcp@latest --cdp-endpoint "$WS_URL" "$@"
