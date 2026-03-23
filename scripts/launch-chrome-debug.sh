#!/usr/bin/env bash
# Launch Playwright's bundled Chromium with the OSShepherd extension + CDP.
# Playwright MCP connects via the CDP endpoint.
#
# NOTE: Uses Playwright's Chromium, NOT system Chrome.
# Chrome 146+ has a bug where --load-extension is silently ignored.
#
# Usage: ./scripts/launch-chrome-debug.sh

set -euo pipefail

PORT="9222"
EXT_DIR="$(cd "$(dirname "$0")/../src" && pwd)"
USER_DATA_DIR="/tmp/osshepherd-debug-profile"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME_PID=""

# Find Playwright's bundled Chromium
# Pick the newest Playwright Chromium install (sorted by modification time)
CHROMIUM="$(find "$HOME/Library/Caches/ms-playwright" -name "Google Chrome for Testing" -path "*/MacOS/*" -print0 2>/dev/null | xargs -0 ls -1t 2>/dev/null | head -1)"
if [ -z "$CHROMIUM" ]; then
  CHROMIUM="$(find "$HOME/.cache/ms-playwright" -name "chrome" -path "*/chrome-linux/*" -print0 2>/dev/null | xargs -0 ls -1t 2>/dev/null | head -1)"
fi
if [ -z "$CHROMIUM" ]; then
  echo "Playwright Chromium not found. Run: npx playwright install chromium" >&2
  exit 1
fi

echo "Launching Chromium with OSShepherd extension..."
echo "  Chromium: $CHROMIUM"
echo "  Extension: $EXT_DIR"
echo "  CDP port: $PORT"
echo ""

# Ensure Chrome is killed on exit (Ctrl+C, errors, etc.)
cleanup() { [ -n "${CHROME_PID}" ] && kill "$CHROME_PID" 2>/dev/null; }
trap cleanup EXIT INT TERM

# Launch Chromium — src/ is clean (no node_modules), so --load-extension works directly
"$CHROMIUM" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --disable-extensions-except="$EXT_DIR" \
  --load-extension="$EXT_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "https://github.com" &
CHROME_PID=$!

# Wait for CDP — fetch once, parse with python3 or jq
WS_URL=""
for i in $(seq 1 30); do
  CDP_JSON=$(curl -sf "http://127.0.0.1:${PORT}/json/version" 2>/dev/null || true)
  if [ -n "$CDP_JSON" ]; then
    WS_URL=$(echo "$CDP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['webSocketDebuggerUrl'])" 2>/dev/null \
          || echo "$CDP_JSON" | jq -r '.webSocketDebuggerUrl' 2>/dev/null \
          || true)
    [ -n "$WS_URL" ] && break
  fi
  sleep 0.5
done

if [ -z "$WS_URL" ]; then
  echo "ERROR: CDP did not start." >&2
  exit 1
fi

# Write .mcp.json
cat > "$PROJECT_ROOT/.mcp.json" <<MCPEOF
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--cdp-endpoint", "$WS_URL"]
    }
  }
}
MCPEOF

echo "CDP ready: $WS_URL"
echo ".mcp.json updated — restart Claude Code to connect."
echo ""
echo "Press Ctrl+C to stop."
wait $CHROME_PID
