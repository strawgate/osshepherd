<p align="center">
  <img src="icons/logo.png" alt="ChromeRabbit" width="200">
</p>

<h1 align="center">ChromeRabbit</h1>

<p align="center">
  <strong>AI-powered code reviews for GitHub PRs — right in your browser.</strong><br>
  Trigger <a href="https://coderabbit.ai">CodeRabbit</a> reviews, triage findings by severity, and jump straight to the code.
</p>

<p align="center">
  <em>ChromeRabbit is an independent, community-built project.<br>It is not developed, endorsed, or supported by the CodeRabbit team.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20">
  <img src="https://img.shields.io/badge/license-ISC-lightgrey" alt="ISC License">
</p>

---

## Features

- **One-click review** — trigger a CodeRabbit AI review from any GitHub PR page
- **Severity-first triage** — findings sorted critical-to-low, auto-switches to the Comments tab
- **Click-to-navigate** — click any comment to jump to the exact file and line in the Files tab
- **Progress tracker** — Domino's-style stage indicator (Setup → Summarize → Review → Done)
- **Stale detection** — shows "outdated" badge when new commits land after a review
- **Re-run reviews** — one click to clear cache and start fresh
- **Multi-PR dashboard** — popup groups reviews by repo with severity badges for quick triage
- **Markdown rendering** — code blocks with diff highlighting, collapsible suggestions, inline formatting
- **Works offline** — completed reviews are cached in `chrome.storage.local`

## Getting Started

### Install from source

```bash
git clone https://github.com/strawgate/chromerabbit.git
cd chromerabbit
npm install
```

1. Open `chrome://extensions` and enable **Developer mode**
2. Click **Load unpacked** and select this project folder
3. Click the extension icon → **Settings** → **Sign in with CodeRabbit**
4. Navigate to any GitHub PR and click the **Review with CodeRabbit** button

### Build for distribution

```bash
make zip          # produces chromerabbit.zip (runtime files only)
```

## Development

```bash
npm test          # unit tests (Node.js test runner)
npm run test:e2e  # Playwright E2E tests
npm run lint      # ESLint
npm run lint:md   # markdownlint
```

### Project structure

```text
background.js            Service worker — reviews, OAuth, storage, badge updates
offscreen.js             Offscreen document — holds the WebSocket connection
content.js               Content script — FAB button injection, toast notifications
sidepanel.html           Chrome sidePanel — loads the review sidebar UI
sidebar.js               Preact components for the review sidebar
sidepanel-mount.js       SidePanel bootstrap — loads PR context, mounts Preact
sidepanel.css            Sidebar styles (dark + light mode)
popup.js / popup.html    Extension popup — multi-PR triage dashboard
options.js / options.html  Settings page — sign in, cache management
vendor/preact-htm.js     Bundled Preact + HTM + Signals (no build step needed)
utils/
  trpc-client.js         WebSocket client for CodeRabbit's tRPC API
  review-store.js        ReviewRecord reducer + chrome.storage.local persistence
  markdown.js            GFM-subset renderer (code blocks, diff highlighting)
  diff-parser.js         Unified diff → file array parser
  utils.js               UUID generation, relative time formatting
```

### CI

GitHub Actions runs on every push and PR:

- ESLint + markdownlint
- Unit tests (Node.js test runner, ~100 tests)
- Playwright E2E tests (extension loading, FAB injection, popup, options)
- Extension zip build with content verification

Tagged releases (`v1.0.0`) auto-upload to the Chrome Web Store via the release workflow.

### Architecture

The sidebar UI runs in Chrome's native **sidePanel** API (not Shadow DOM). This means:

- The panel persists across GitHub page navigations within a tab
- Chrome provides the native resize handle and panel visibility controls
- The content script is lightweight (~240 lines) — just the FAB button and toasts
- Streaming updates flow via `chrome.storage.onChanged` (ReviewStore saves trigger sidePanel re-renders)

## Troubleshooting

- **Empty sidebar?** Sign in via the extension Settings page first.
- **Connection error?** Check that WebSockets to `ide.coderabbit.ai` aren't blocked by a proxy or firewall.
- **403 on WebSocket?** The `Origin` header may be leaking — check `rules.json` and the DNR setup in `background.js`.

## Disclaimer

ChromeRabbit is an independent, community-built extension. It is **not** developed, endorsed, or supported by the [CodeRabbit](https://coderabbit.ai) team. "CodeRabbit" is a trademark of its respective owner. This project uses the public CodeRabbit API and requires a CodeRabbit account.

## License

ISC
