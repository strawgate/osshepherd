<p align="center">
  <img src="src/icons/logo.png" alt="OSShepherd logo — AI code review companion for GitHub PRs" width="160">
</p>

<h1 align="center">OSShepherd for CodeRabbit™</h1>

<p align="center">
  <strong>One-click AI code reviews on any GitHub PR — right in your browser.</strong><br>
  Trigger <a href="https://coderabbit.ai">CodeRabbit</a> reviews, triage findings by severity, and jump straight to the code.
</p>

<p align="center">
  <em>OSShepherd is an independent, community-built project.<br>It is not developed, endorsed, or supported by the CodeRabbit team.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20">
  <img src="https://img.shields.io/badge/license-ISC-lightgrey" alt="ISC License">
</p>

---

## Features

- **One-click review** — click the 🐑 button on any GitHub PR to trigger a CodeRabbit AI review
- **Severity-first triage** — findings sorted critical → trivial, with clickable filter chips
- **Click-to-navigate** — click any finding to jump to the exact file and line in the Files tab
- **AI fix prompts** — 🤖 button on each finding copies an AI-ready prompt to fix that specific issue
- **File summaries** — per-file analysis grouped by review effort (high → low)
- **Review config** — see the review profile, plan, and files analyzed in a compact grid
- **Progress tracker** — live stage indicator during reviews (Setup → Summarize → Review → Done)
- **Stale detection** — "outdated" badge when new commits land after a review
- **Multi-PR dashboard** — popup groups reviews by repo with severity badges for quick triage
- **Dark + light mode** — follows system preference
- **Works offline** — completed reviews are cached in `chrome.storage.local`

## Getting Started

### Install from source

```bash
git clone https://github.com/strawgate/chromerabbit.git
cd chromerabbit
npm install
```

1. Open `chrome://extensions` and enable **Developer mode**
2. Click **Load unpacked** and select the `src/` folder
3. Click the extension icon → **Settings** → **Sign in with CodeRabbit™**
4. Navigate to any GitHub PR and click the 🐑 button

### Build for distribution

```bash
make zip          # produces osshepherd.zip (~92KB)
```

## Development

```bash
npm test          # unit tests (Node.js test runner)
npm run test:e2e  # Playwright E2E tests
npm run lint      # ESLint
npm run lint:md   # markdownlint
```

See [DEVELOPING.md](DEVELOPING.md) for architecture details.

## Disclaimer

OSShepherd is an independent, community-built extension. It is **not** developed, endorsed, or supported by the [CodeRabbit](https://coderabbit.ai) team. "CodeRabbit" is a trademark of CodeRabbit, Inc. This project uses the public CodeRabbit API and requires a CodeRabbit account.

## License

ISC
