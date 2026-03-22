const { test, expect } = require('./fixtures');

test('renders the header', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('.header-title')).toContainText('OSShepherd Reviews');
});

test('shows settings button', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#optionsBtn')).toBeVisible();
});

test('shows empty state when no reviews exist', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#reviewsList')).toBeVisible();
  await expect(page.locator('.empty-icon')).toBeVisible({ timeout: 5000 });
});
