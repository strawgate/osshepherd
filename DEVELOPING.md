# Developing OSShepherd

OSShepherd is a Chrome extension that brings CodeRabbit™ AI code reviews directly into the GitHub PR interface.

## Architecture

### Content Script (content.js)

Lightweight (~240 lines). Injects the FAB button on GitHub PR pages and communicates with the background service worker. Does NOT render the sidebar — that's the sidePanel's job.

### Chrome SidePanel (sidepanel.html)

The review sidebar runs in Chrome's native sidePanel API. Benefits:

- Persists across GitHub SPA navigations (no Turbo Drive issues)
- Native Chrome resize handle and visibility controls
- Full Chrome API access (storage, tabs, runtime)

**Files:**

- `sidepanel.html` — entry point, loads scripts
- `sidebar.js` — Preact components (Sidebar, CommentsPanel, etc.)
- `sidepanel-mount.js` — bootstrap: reads PR context from `chrome.storage.session`, loads review from ReviewStore, mounts Preact app, watches `storage.onChanged` for streaming updates
- `sidepanel.css` — styles with dark/light mode via CSS custom properties

### Service Worker (background.js)

Orchestrates reviews, OAuth, offscreen document management, DNR header rules, and badge updates. Handles `OPEN_SIDEPANEL` messages from the content script by storing PR context in `chrome.storage.session` then calling `chrome.sidePanel.open()`.

### WebSocket Bridge (offscreen.js)

Standard service workers suffer from a Chromium bug where WebSockets are killed. We spawn an offscreen document (`offscreen.html`) to hold a persistent DOM-based WebSocket connection. A keepalive port prevents the service worker from sleeping during reviews.

### DNR (Declarative Net Request)

Cloud Armor / WAF blocks WebSocket upgrades with `Origin: chrome-extension://...`. DNR rules in `rules.json` strip the Origin header from requests to `ide.coderabbit.ai`. Dynamic rules in `background.js` inject auth headers for the WebSocket upgrade.

### tRPC Streaming

CodeRabbit uses a custom tRPC protocol over WebSockets with a three-phase handshake:

1. **Subscribe** to events (via `clientId`)
2. **Mutate** to start the review (batched in the same WebSocket frame)
3. **Stream** — events flow back through the subscription ID

### UI Framework

Preact + HTM (tagged template literals) with Signals for reactive state. No build step — the vendor bundle (`vendor/preact-htm.js`) is a one-time esbuild output.

## Quick Setup

```bash
npm install
```

1. Load the extension: `chrome://extensions` → Developer mode → Load unpacked
2. Sign in: extension icon → Settings → Sign in with CodeRabbit
3. Navigate to any GitHub PR → click the FAB button

## Commands

```bash
npm test          # Unit tests (Node.js test runner)
npm run test:e2e  # Playwright E2E tests
npm run lint      # ESLint
npm run lint:md   # markdownlint
make zip          # Package for Chrome Web Store (runtime files only)
```

## Testing the WebSocket Flow

To test the protocol without loading the extension:

1. Create a `.env` file (see `.env.example`)
2. Run `node test/scripts/test-review-flow.js https://github.com/owner/repo/pull/123`

## Key Constraints

- **Offscreen document** — WebSocket logic MUST stay in `offscreen.js` (service workers can't hold WebSockets)
- **No `chrome.storage` in offscreen** — only `chrome.runtime` is available. All storage operations go through `background.js`
- **No `window` in service worker** — use `globalThis` instead
- **DNR rules** — header removal is in `rules.json` (static) + `background.js` (dynamic per-review auth headers)
