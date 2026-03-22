const { test, expect } = require('./fixtures');

test('service worker starts and has a valid extension ID', async ({ extensionId }) => {
  expect(extensionId).toBeTruthy();
  expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test('service worker responds to PING', async ({ context, extensionId }) => {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const response = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'PING' }, resolve);
      });
    });
    expect(response).toEqual({ success: true });
  } finally {
    await page.close();
  }
});
