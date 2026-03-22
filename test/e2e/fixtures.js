/**
 * Custom Playwright fixture for Chrome extension testing.
 * Provides `context` and `extensionId` to all tests automatically.
 */

const playwright = require('@playwright/test');
const { chromium } = playwright;
const base = playwright.test;
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '../../src');

const test = base.extend({
  context: async ({ }, use) => {
    const headlessArg = process.env.HEADLESS === 'new' ? ['--headless=new'] : [];
    const ctx = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        ...headlessArg,
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    await use(ctx);
    await ctx.close();
  },

  extensionId: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    const id = new URL(sw.url()).hostname;
    await use(id);
  },
});

module.exports = { test, expect: playwright.expect };
