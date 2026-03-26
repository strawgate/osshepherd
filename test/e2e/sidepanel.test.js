const { test, expect } = require('./fixtures');

/**
 * Sidepanel e2e tests.
 *
 * These load sidepanel.html directly in a Chrome extension context and
 * exercise the signal-driven rendering (panelModeSignal, reviewSignal)
 * without needing a real CodeRabbit review.
 *
 * Each test creates and closes its own page to avoid tab accumulation
 * and stale `chrome.tabs.query({ active: true })` results.
 */

test('shows empty state on initial load (no session context)', async ({ context, extensionId }) => {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect(page.locator('.cr-empty-state')).toBeVisible({ timeout: 5000 });
  } finally {
    await page.close();
  }
});

test('switches to review mode when signals are set', async ({ context, extensionId }) => {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.waitForSelector('.cr-empty-state', { timeout: 5000 });

    await page.evaluate(() => {
      const record = ReviewStore.createRecord('testowner', 'testrepo', '42', 'review-1');
      record.status = 'reviewing';
      batch(() => {
        reviewSignal.value = record;
        panelModeSignal.value = { mode: 'review' };
      });
    });

    await expect(page.locator('.cr-pr-slug')).toContainText('testowner/testrepo#42');
    await expect(page.locator('.cr-status-badge')).toContainText('Reviewing');
  } finally {
    await page.close();
  }
});

test('updates reactively when review data changes', async ({ context, extensionId }) => {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.waitForSelector('.cr-empty-state', { timeout: 5000 });

    await page.evaluate(() => {
      const record = ReviewStore.createRecord('alice', 'proj', '7', 'rev-1');
      record.status = 'reviewing';
      batch(() => {
        reviewSignal.value = record;
        panelModeSignal.value = { mode: 'review' };
      });
    });
    await expect(page.locator('.cr-status-badge')).toContainText('Reviewing');

    // Simulate streaming: add a title
    await page.evaluate(() => {
      reviewSignal.value = { ...reviewSignal.value, prTitle: 'Fix the widget' };
    });
    await expect(page.locator('.cr-pr-title')).toContainText('Fix the widget');

    // Simulate streaming: add a comment
    await page.evaluate(() => {
      reviewSignal.value = {
        ...reviewSignal.value,
        comments: [{
          filename: 'src/main.js', startLine: 10, endLine: 10,
          severity: 'medium', comment: 'Consider null check here',
          codegenInstructions: null, type: 'assertive', fingerprint: 'fp1'
        }]
      };
    });
    await expect(page.locator('.cr-tab-badge').first()).toContainText('1');

    // Complete the review
    await page.evaluate(() => {
      reviewSignal.value = { ...reviewSignal.value, status: 'complete', completedAt: Date.now() };
    });
    await expect(page.locator('.cr-status-badge')).toContainText('Complete');
    await expect(page.locator('.cr-rerun-btn')).toBeVisible();
  } finally {
    await page.close();
  }
});

test('switches between PRs without corrupting the panel', async ({ context, extensionId }) => {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.waitForSelector('.cr-empty-state', { timeout: 5000 });

    // Show PR A
    await page.evaluate(() => {
      const record = ReviewStore.createRecord('alice', 'projA', '1', 'rev-a');
      record.status = 'complete';
      record.completedAt = Date.now();
      record.prTitle = 'PR A Title';
      record.comments = [{
        filename: 'a.js', startLine: 1, endLine: 1,
        severity: 'high', comment: 'Bug in A',
        codegenInstructions: null, type: 'assertive', fingerprint: 'fpA'
      }];
      batch(() => {
        reviewSignal.value = record;
        panelModeSignal.value = { mode: 'review' };
      });
    });
    await expect(page.locator('.cr-pr-slug')).toContainText('alice/projA#1');
    await expect(page.locator('.cr-pr-title')).toContainText('PR A Title');

    // Switch to PR B
    await page.evaluate(() => {
      const record = ReviewStore.createRecord('bob', 'projB', '2', 'rev-b');
      record.status = 'reviewing';
      record.prTitle = 'PR B Title';
      record.comments = [];
      batch(() => {
        reviewSignal.value = record;
        panelModeSignal.value = { mode: 'review' };
      });
    });
    await expect(page.locator('.cr-pr-slug')).toContainText('bob/projB#2');
    await expect(page.locator('.cr-pr-title')).toContainText('PR B Title');
    await expect(page.locator('.cr-status-badge')).toContainText('Reviewing');

    // Switch back to PR A
    await page.evaluate(() => {
      const record = ReviewStore.createRecord('alice', 'projA', '1', 'rev-a');
      record.status = 'complete';
      record.completedAt = Date.now();
      record.prTitle = 'PR A Title';
      record.comments = [{
        filename: 'a.js', startLine: 1, endLine: 1,
        severity: 'high', comment: 'Bug in A',
        codegenInstructions: null, type: 'assertive', fingerprint: 'fpA'
      }];
      batch(() => {
        reviewSignal.value = record;
        panelModeSignal.value = { mode: 'review' };
      });
    });
    await expect(page.locator('.cr-pr-slug')).toContainText('alice/projA#1');
    await expect(page.locator('.cr-status-badge')).toContainText('Complete');
    await expect(page.locator('.cr-rerun-btn')).toBeVisible();
  } finally {
    await page.close();
  }
});

test('sign-in panel renders and has working button', async ({ context, extensionId }) => {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.waitForSelector('.cr-empty-state', { timeout: 5000 });

    await page.evaluate(() => {
      panelModeSignal.value = { mode: 'signin', ctx: { owner: 'org', repo: 'repo', prNumber: '99' } };
    });

    await expect(page.locator('.cr-signin-card')).toBeVisible();
    await expect(page.locator('.cr-signin-desc strong')).toContainText('org/repo#99');
    await expect(page.locator('.cr-signin-btn')).toBeVisible();
    await expect(page.locator('.cr-signin-btn')).toContainText('Sign in with CodeRabbit');
  } finally {
    await page.close();
  }
});

test('storage listener pipeline: session context write triggers review display', async ({ context, extensionId }) => {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.waitForSelector('.cr-empty-state', { timeout: 5000 });

    await page.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tab.id;

      // Clear any storage left from prior tests in this worker
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();

      await chrome.storage.local.set({ accessToken: 'fake-test-token' });

      const record = ReviewStore.createRecord('storagetest', 'repo', '55', 'rev-st');
      record.status = 'reviewing';
      record.prTitle = 'Storage Pipeline Title';
      await chrome.storage.local.set({ [record.key]: record });

      await chrome.storage.session.set({
        [`sidepanel:context:${tabId}`]: {
          owner: 'storagetest', repo: 'repo', prNumber: '55', tabId
        }
      });
    });

    await expect(page.locator('.cr-pr-slug')).toContainText('storagetest/repo#55', { timeout: 5000 });
    await expect(page.locator('.cr-pr-title')).toContainText('Storage Pipeline Title');
    await expect(page.locator('.cr-status-badge')).toContainText('Reviewing');
  } finally {
    await page.close();
  }
});

test('storage listener pipeline: review updates stream to sidebar reactively', async ({ context, extensionId }) => {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.waitForSelector('.cr-empty-state', { timeout: 5000 });

    await page.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tab.id;

      // Clear any storage left from prior tests in this worker
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();

      await chrome.storage.local.set({ accessToken: 'fake-test-token' });

      const record = ReviewStore.createRecord('streamtest', 'proj', '10', 'rev-stream');
      record.status = 'reviewing';
      await chrome.storage.local.set({ [record.key]: record });

      await chrome.storage.session.set({
        [`sidepanel:context:${tabId}`]: {
          owner: 'streamtest', repo: 'proj', prNumber: '10', tabId
        }
      });
    });

    await expect(page.locator('.cr-pr-slug')).toContainText('streamtest/proj#10', { timeout: 5000 });

    // Simulate streaming: add title
    await page.evaluate(async () => {
      const key = ReviewStore.storageKey('streamtest', 'proj', '10');
      const result = await chrome.storage.local.get(key);
      const record = result[key];
      record.prTitle = 'Streamed Title';
      await chrome.storage.local.set({ [key]: record });
    });

    await expect(page.locator('.cr-pr-title')).toContainText('Streamed Title');

    // Add a comment
    await page.evaluate(async () => {
      const key = ReviewStore.storageKey('streamtest', 'proj', '10');
      const result = await chrome.storage.local.get(key);
      const record = result[key];
      record.comments = [{
        filename: 'main.go', startLine: 5, endLine: 5,
        severity: 'high', comment: 'Potential nil deref',
        codegenInstructions: null, type: 'assertive', fingerprint: 'fp-stream'
      }];
      await chrome.storage.local.set({ [key]: record });
    });

    await expect(page.locator('.cr-tab-badge').first()).toContainText('1');

    // Complete the review
    await page.evaluate(async () => {
      const key = ReviewStore.storageKey('streamtest', 'proj', '10');
      const result = await chrome.storage.local.get(key);
      const record = result[key];
      record.status = 'complete';
      record.completedAt = Date.now();
      await chrome.storage.local.set({ [key]: record });
    });

    await expect(page.locator('.cr-status-badge')).toContainText('Complete');
    await expect(page.locator('.cr-rerun-btn')).toBeVisible();
  } finally {
    await page.close();
  }
});

test('panel does not go blank after rapid mode switches', async ({ context, extensionId }) => {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.waitForSelector('.cr-empty-state', { timeout: 5000 });

    await page.evaluate(() => {
      for (let i = 0; i < 10; i++) {
        const record = ReviewStore.createRecord('owner', 'repo', String(i), `rev-${i}`);
        record.status = 'reviewing';
        record.prTitle = `PR ${i}`;
        batch(() => {
          reviewSignal.value = record;
          panelModeSignal.value = { mode: 'review' };
        });
      }
    });

    await expect(page.locator('.cr-pr-slug')).toContainText('owner/repo#9');
    await expect(page.locator('.cr-pr-title')).toContainText('PR 9');
    await expect(page.locator('.cr-header')).toBeVisible();
    await expect(page.locator('.cr-tabs')).toBeVisible();
  } finally {
    await page.close();
  }
});
