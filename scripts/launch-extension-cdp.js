#!/usr/bin/env node
/**
 * Launch Chromium with the OSShepherd extension via Playwright's launchPersistentContext().
 *
 * Usage:  node scripts/launch-extension-cdp.js
 *
 * NOTE: Uses Playwright's bundled Chromium, NOT system Chrome.
 * Chrome 146+ has a bug where --load-extension is silently ignored.
 */

const { chromium } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '../src');
const USER_DATA_DIR = path.join(os.tmpdir(), 'osshepherd-debug-profile');

if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
  console.error(`Error: Extension not found at ${EXTENSION_PATH}`);
  process.exit(1);
}

(async () => {
  console.log('Launching Chromium with extension from src/...');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // Graceful shutdown on Ctrl+C (idempotent — safe to call multiple times)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    await context.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  let sw = context.serviceWorkers()[0];
  if (!sw) {
    console.log('Waiting for extension service worker...');
    sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  }
  const extensionId = new URL(sw.url()).hostname;
  console.log(`Extension loaded! ID: ${extensionId}`);

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://github.com');

  // Keep browser open for manual inspection
  console.log('Browser running. Press Ctrl+C to stop.');
  await new Promise(() => {});
})().catch(e => { console.error(e); process.exit(1); });
