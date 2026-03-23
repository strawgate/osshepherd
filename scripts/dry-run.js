#!/usr/bin/env node
/**
 * Dry run: launches Chromium with the OSShepherd extension, navigates through the
 * full review flow, takes screenshots at each step, and reports findings.
 *
 * Usage:  node scripts/dry-run.js [PR_URL]
 */

const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXTENSION_PATH = path.resolve(__dirname, '../src');
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');
const PR_URL = process.argv[2] || 'https://github.com/strawgate/chromerabbit/pull/2';

// Preflight: ensure extension source exists
if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
  console.error(`Error: Extension not found at ${EXTENSION_PATH}`);
  console.error('Expected src/manifest.json — are you running from the project root?');
  process.exit(1);
}

async function screenshot(page, name) {
  const filepath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: filepath, fullPage: false });
  console.log(`  📸 ${name}.png`);
}

(async () => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  console.log('Launching Chromium with extension from src/...');
  const context = await chromium.launchPersistentContext(path.join(os.tmpdir(), 'osshepherd-dry-run'), {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
    viewport: { width: 1280, height: 900 },
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) {
    console.log('Waiting for extension service worker...');
    sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  }
  const extensionId = new URL(sw.url()).hostname;
  console.log(`Extension loaded! ID: ${extensionId}\n`);

  const page = context.pages()[0] || await context.newPage();

  console.log('Step 1: Options page');
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.waitForLoadState('domcontentloaded');
  await screenshot(page, '01-options');

  console.log('\nStep 2: Popup');
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.header-title').waitFor({ timeout: 3000 })
    .catch(err => console.warn('Popup header wait timed out:', err.message));
  await screenshot(page, '02-popup');

  console.log('\nStep 3: PR page');
  await page.goto(PR_URL, { waitUntil: 'domcontentloaded' });
  const fab = page.locator('.coderabbit-fab');
  await fab.waitFor({ state: 'visible', timeout: 5000 })
    .catch(err => console.warn('FAB wait timed out:', err.message));
  await screenshot(page, '03-pr-page');

  const fabVisible = await fab.isVisible().catch(() => false);
  console.log(`  FAB visible: ${fabVisible ? '✅' : '❌'}`);

  console.log('\nScreenshots saved to screenshots/');
  // Keep browser open indefinitely for manual inspection
  console.log('Browser open for inspection. Ctrl+C to close.');
  await new Promise(() => {});
})().catch(e => { console.error(e); process.exit(1); });
