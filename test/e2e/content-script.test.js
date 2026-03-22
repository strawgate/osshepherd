const { test, expect } = require('./fixtures');

test('injects the CodeRabbit FAB on a GitHub PR page', async ({ context }) => {
  const page = await context.newPage();

  await page.route('https://github.com/test-owner/test-repo/pull/1', (route) => {
    route.fulfill({
      contentType: 'text/html',
      body: `<!DOCTYPE html>
<html><head><title>Test PR #1</title></head>
<body>
  <div id="repo-content-pjax-container">
    <div class="repository-content">Mock PR page</div>
  </div>
</body></html>`,
    });
  });

  await page.route('https://github.com/**', (route) => {
    if (route.request().resourceType() === 'document') {
      route.fallback();
    } else {
      route.fulfill({ body: '', contentType: 'text/plain' });
    }
  });

  await page.goto('https://github.com/test-owner/test-repo/pull/1', { waitUntil: 'domcontentloaded' });

  const fab = page.locator('.coderabbit-fab');
  await expect(fab).toBeVisible({ timeout: 5000 });
  await expect(fab).toContainText('Review with OSShepherd');
});

test('does NOT inject on non-PR GitHub pages', async ({ context }) => {
  const page = await context.newPage();

  await page.route('https://github.com/test-owner/test-repo', (route) => {
    route.fulfill({
      contentType: 'text/html',
      body: '<!DOCTYPE html><html><head><title>Repo</title></head><body>Repo page</body></html>',
    });
  });
  await page.route('https://github.com/**', (route) => {
    route.fulfill({ body: '', contentType: 'text/plain' });
  });

  await page.goto('https://github.com/test-owner/test-repo', { waitUntil: 'domcontentloaded' });
  const fab = page.locator('.coderabbit-fab');
  await expect(fab).toHaveCount(0);
});
