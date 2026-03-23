const { test, expect } = require('./fixtures');

test('renders without errors', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator('h1')).toContainText('OSShepherd for CodeRabbit Settings');
});

test('shows login button when signed out', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator('#loginBtn')).toBeVisible();
  await expect(page.locator('#loginBtn')).toContainText('Sign in');
});

test('shows "Not signed in" auth status initially', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator('#authStatus')).toContainText('Not signed in');
});

test('debug info panel loads', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const debugInfo = page.locator('#debugInfo');
  await expect(debugInfo).toBeVisible();
  await expect(debugInfo).not.toBeEmpty();
});
