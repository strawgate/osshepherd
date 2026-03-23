# Developing OSShepherd

OSShepherd is a Chrome extension that brings CodeRabbit™ AI code reviews directly into the GitHub PR interface.

## Project Structure

```text
src/                         Extension source (load this in chrome://extensions)
  manifest.json              Extension manifest
  background.js              Service worker — reviews, OAuth, storage, badge updates
  offscreen.html/js          Offscreen document — holds the WebSocket connection
  content.js / content.css   Content script — FAB button injection, toast notifications
  sidepanel.html             Chrome sidePanel — loads the review sidebar UI
  sidebar.js                 Preact components for the review sidebar
  sidepanel-mount.js         SidePanel bootstrap — loads PR context, mounts Preact
  sidepanel.css              Sidebar styles (dark + light mode)
  popup.html / popup.js      Extension popup — multi-PR triage dashboard
  options.html / options.js  Settings page — sign in, cache management
  rules.json                 Declarative Net Request rules (Origin header stripping)
  vendor/preact-htm.js       Bundled Preact + HTM + Signals (no build step needed)
  utils/
    trpc-client.js           WebSocket client for CodeRabbit's tRPC API
    review-store.js           ReviewRecord reducer + chrome.storage.local persistence
    markdown.js              GFM-subset renderer (code blocks, diff highlighting)
    diff-parser.js           Unified diff → file array parser
    utils.js                 UUID generation, relative time formatting
test/                        Tests (unit + E2E)
scripts/                     Dev tooling (browser launch, dry-run)
```

## Architecture

### Content Script (`src/content.js`)

Lightweight content script. Injects the FAB button on GitHub PR pages and communicates with the background service worker. Does NOT render the sidebar — that's the sidePanel's job. Listens for GitHub's `turbo:load` event to survive SPA navigations.

### Chrome SidePanel (`src/sidepanel.html`)

The review sidebar runs in Chrome's native sidePanel API. Benefits:

- Persists across GitHub SPA navigations (no Turbo Drive issues)
- Native Chrome resize handle and visibility controls
- Full Chrome API access (storage, tabs, runtime)

### Service Worker (`src/background.js`)

Orchestrates reviews, OAuth, offscreen document management, DNR header rules, and badge updates. Handles `OPEN_SIDEPANEL` messages from the content script. Auto-opens the options page when review is attempted without auth.

### WebSocket Bridge (`src/offscreen.js`)

Service workers can't hold WebSocket connections reliably. The offscreen document holds a persistent DOM-based WebSocket connection. A keepalive port prevents the service worker from sleeping during reviews.

### tRPC Streaming

CodeRabbit uses a custom tRPC protocol over WebSockets:

1. **Subscribe** to events (via `clientId`)
2. **Mutate** to start the review (batched in the same WebSocket frame)
3. **Stream** — events flow back through the subscription ID

### UI Framework

Preact + HTM (tagged template literals) with Signals for reactive state. No build step — the vendor bundle (`src/vendor/preact-htm.js`) is a one-time esbuild output (~23KB).

## Quick Setup

```bash
npm install
```

1. Load the extension: `chrome://extensions` → Developer mode → Load unpacked → select `src/`
2. Sign in: extension icon → Settings → Sign in with CodeRabbit™
3. Navigate to any GitHub PR → click the 🐑 button to start a CodeRabbit™ review

## Commands

```bash
npm test          # Unit tests (Node.js test runner)
npm run test:e2e  # Playwright E2E tests
npm run lint      # ESLint
npm run lint:md   # markdownlint
make zip          # Package for Chrome Web Store (builds from src/)
```

## Debug Browser

Two scripts for launching a browser with the extension loaded for manual testing:

**`launch-chrome-debug.sh`** — Launches Playwright's Chromium with a CDP (Chrome DevTools Protocol) endpoint exposed. Writes `.mcp.json` so Playwright MCP can connect for Claude Code integration. Use this when you want Claude Code to interact with the browser.

```bash
./scripts/launch-chrome-debug.sh
```

**`launch-extension-cdp.js`** — Uses Playwright's `launchPersistentContext()` API to launch Chromium with the extension. Simpler, no CDP exposure. Use this for quick manual testing.

```bash
node scripts/launch-extension-cdp.js
```

## Key Constraints

- **Offscreen document** — WebSocket logic MUST stay in `src/offscreen.js` (service workers can't hold WebSockets)
- **No `chrome.storage` in offscreen** — only `chrome.runtime` is available. All storage operations go through `src/background.js`
- **No `window` in service worker** — use `globalThis` instead
- **DNR rules** — header removal is in `src/rules.json` (static) + `src/background.js` (dynamic per-review auth headers)
- **Fingerprint dedup** — CodeRabbit reuses fingerprints across files. Dedup key is `fingerprint:filename:startLine`, not fingerprint alone
